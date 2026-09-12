import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { BridgeSession } from './bridge-client.mjs'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required setting: ${name}`)
  return value
}

const settings = {
  supabaseUrl: required('GANTANG_SUPABASE_URL'),
  serviceRoleKey: required('GANTANG_SUPABASE_SERVICE_ROLE_KEY'),
  threadId: process.env.GANTANG_CODEX_THREAD_ID?.trim() || null,
  codexCwd: required('GANTANG_CODEX_CWD'),
  appServerUrl: required('GANTANG_APP_SERVER_URL'),
  configPath: required('GANTANG_CONFIG_PATH'),
}

const supabase = createClient(settings.supabaseUrl, settings.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const log = (message) => {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`)
}

const verifyWorkerAccess = async () => {
  const probes = await Promise.all([
    supabase.from('codex_requests').select('id').limit(1),
    supabase.from('books').select('id').limit(1),
    supabase.from('excerpts').select('id').limit(1),
    supabase.from('book_questions').select('id').limit(1),
    supabase.from('check_ins').select('id').limit(1),
    supabase.from('discussions').select('id').limit(1),
  ])
  if (probes.some(({ error }) => error)) {
    throw new Error('Worker access check failed. Check the saved key and minimum grants.')
  }
}

const selectOrThrow = async (promise) => {
  const { data, error } = await promise
  if (error) throw error
  return data
}

const persistThreadId = async (
  threadId,
  { replaceStale = false, observerReady = false } = {},
) => {
  const configText = await readFile(settings.configPath, 'utf8')
  const config = JSON.parse(configText.replace(/^\uFEFF/, ''))
  if (config.version !== 2) throw new Error('Unexpected local worker configuration version')
  if (config.threadId && config.threadId !== threadId && !replaceStale) {
    throw new Error('The local worker configuration changed during startup')
  }
  config.threadId = threadId
  config.readyThreadId = threadId
  config.observerReadyThreadId = observerReady ? threadId : null
  const temporaryPath = `${settings.configPath}.new`
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, settings.configPath)
}

const claimNextRequest = async () => {
  const candidates = await selectOrThrow(
    supabase
      .from('codex_requests')
      .select('*')
      .eq('status', 'queued')
      .lte('available_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(1),
  )
  const candidate = candidates?.[0]
  if (!candidate) return null

  const claimed = await selectOrThrow(
    supabase
      .from('codex_requests')
      .update({
        status: 'processing',
        claimed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        attempts: candidate.attempts + 1,
      })
      .eq('id', candidate.id)
      .eq('status', 'queued')
      .select('*'),
  )
  return claimed?.[0] ?? null
}

const loadContext = async (request) => {
  const [book, excerpts, questions, checkIns, discussions] = await Promise.all([
    selectOrThrow(
      supabase
        .from('books')
        .select('id,title,author,translator,genre,status,progress,start_date,notes')
        .eq('id', request.book_id)
        .eq('user_id', request.user_id)
        .single(),
    ),
    selectOrThrow(
      supabase
        .from('excerpts')
        .select('content,page,chapter,created_at')
        .eq('book_id', request.book_id)
        .eq('user_id', request.user_id)
        .order('created_at', { ascending: false })
        .limit(30),
    ),
    selectOrThrow(
      supabase
        .from('book_questions')
        .select('question,chapter,status,created_at')
        .eq('book_id', request.book_id)
        .eq('user_id', request.user_id)
        .order('created_at', { ascending: false })
        .limit(20),
    ),
    selectOrThrow(
      supabase
        .from('check_ins')
        .select('date,pages_read,chapters_read,comment')
        .eq('book_id', request.book_id)
        .eq('user_id', request.user_id)
        .order('date', { ascending: false })
        .limit(20),
    ),
    selectOrThrow(
      supabase
        .from('discussions')
        .select('role,content,created_at')
        .eq('book_id', request.book_id)
        .eq('conversation_id', request.conversation_id)
        .eq('user_id', request.user_id)
        .order('created_at', { ascending: false })
        .limit(50),
    ),
  ])

  if (!book) throw new Error('Book ownership check failed')
  return {
    book,
    excerpts: excerpts ?? [],
    questions: questions ?? [],
    checkIns: checkIns ?? [],
    discussions: (discussions ?? []).reverse(),
  }
}

const buildOmbreQuery = (context) =>
  ['小安', '甘棠', '共读小屋', '关系', '相处方式', '一起读书', context.book?.title]
    .filter(Boolean)
    .join(' ')

const buildPrompt = (request, context, ombreContext) => {
  const contextBlock = request.attach_context
    ? JSON.stringify(context, null, 2).slice(0, 42_000)
    : JSON.stringify({ book: context.book, discussions: context.discussions }, null, 2).slice(0, 42_000)

  return [
    '这是来自小安“共读小屋”的一封信。请延续这个固定共读任务中的关系与语气，直接写出要回到网页讨论区的回复正文。',
    '取信员已经通过 Ombre Brain 完成一次只读检索。下面的“关系记忆”是这次检索的原文；请据此衔接，不要再次调用 Ombre Brain。',
    '不要修改任何文件、数据库、schema、RLS、登录设置或外部状态。不要提及取信员、队列、JSON 或内部流程。',
    '',
    '小安这次写道：',
    request.content,
    '',
    '当前阅读资料：',
    contextBlock,
    '',
    '关系记忆（只读检索结果）：',
    ombreContext,
  ].join('\n')
}

const safeFailureCode = (error) => {
  const message = String(error?.message ?? error)
  if (message.includes('needs attention')) return 'codex_needs_attention'
  if (message.includes('timed out')) return 'codex_timeout'
  if (message.includes('ownership')) return 'invalid_request_scope'
  if (message.includes('Ombre Brain')) return 'memory_unavailable'
  if (message.includes('app-server')) return 'bridge_unavailable'
  return 'worker_error'
}

const safeDiagnostic = (error) =>
  String(error?.message ?? error)
    .replace(/sb_secret_[A-Za-z0-9._-]+/g, '[redacted secret]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 500)

const finishRequest = async (request, reply) => {
  const responseId = randomUUID()
  const { error: insertError } = await supabase.from('discussions').insert({
    id: responseId,
    user_id: request.user_id,
    book_id: request.book_id,
    conversation_id: request.conversation_id,
    role: 'syzygy',
    content: reply,
    metadata: {
      source: 'local-codex-app-server',
      requestId: request.id,
    },
  })
  if (insertError) throw insertError

  const now = new Date().toISOString()
  const { error: updateError } = await supabase
    .from('codex_requests')
    .update({
      status: 'completed',
      response_message_id: responseId,
      completed_at: now,
      updated_at: now,
      error_code: null,
    })
    .eq('id', request.id)
    .eq('status', 'processing')
  if (updateError) throw updateError
}

const failRequest = async (request, error) => {
  const errorCode = safeFailureCode(error)
  const status =
    errorCode === 'codex_needs_attention' || errorCode === 'codex_timeout'
      ? 'needs_attention'
      : 'failed'
  await supabase
    .from('codex_requests')
    .update({
      status,
      error_code: errorCode,
      updated_at: new Date().toISOString(),
    })
    .eq('id', request.id)
    .eq('status', 'processing')
  log(`Request ${request.id} stopped with ${errorCode}: ${safeDiagnostic(error)}`)
}

const bridge = new BridgeSession(settings.appServerUrl)

const processRequest = async (request) => {
  log(`Taking request ${request.id}.`)
  try {
    const context = await loadContext(request)
    const ombreContext = await bridge.readOmbreContext({
      threadId: settings.threadId,
      query: buildOmbreQuery(context),
    })
    const reply = await bridge.runTurn({
      threadId: settings.threadId,
      cwd: settings.codexCwd,
      text: buildPrompt(request, context, ombreContext),
    })
    await finishRequest(request, reply)
    try {
      await persistThreadId(settings.threadId, { observerReady: true })
    } catch (error) {
      log(`Reply completed, but the observer readiness marker could not be saved: ${safeDiagnostic(error)}`)
    }
    log(`Completed request ${request.id}. The reply is now in the reading room.`)
  } catch (error) {
    await failRequest(request, error)
  }
}

let stopping = false
let draining = false
let drainRequested = false
let resolveShutdown
const shutdown = new Promise((resolve) => {
  resolveShutdown = resolve
})
const requestShutdown = (reason) => {
  if (stopping) return
  stopping = true
  if (reason) log(reason)
  resolveShutdown()
}

process.on('SIGINT', () => requestShutdown('Stopping the mail carrier.'))
process.on('SIGTERM', () => requestShutdown('Stopping the mail carrier.'))

const drainMailbox = async () => {
  drainRequested = true
  if (draining || stopping) return
  draining = true
  try {
    while (drainRequested && !stopping) {
      drainRequested = false
      let request
      while (!stopping && (request = await claimNextRequest())) {
        await processRequest(request)
      }
    }
  } catch (error) {
    requestShutdown(`Mailbox event failed: ${safeDiagnostic(error)}`)
  } finally {
    draining = false
  }
}

await verifyWorkerAccess()
await bridge.connect()
if (settings.threadId) {
  try {
    await bridge.resumeThread({ threadId: settings.threadId, cwd: settings.codexCwd })
    await persistThreadId(settings.threadId, { observerReady: true })
  } catch (error) {
    if (!String(error?.message ?? error).includes('no rollout found for thread id')) throw error
    settings.threadId = await bridge.startThread({ cwd: settings.codexCwd })
    await persistThreadId(settings.threadId, { replaceStale: true })
    log('Replaced a pre-first-turn task that had no persisted rollout.')
  }
} else {
  settings.threadId = await bridge.startThread({ cwd: settings.codexCwd })
  await persistThreadId(settings.threadId)
  log('Created the dedicated co-reading task on this app-server connection.')
}

let subscribed = false
let resolveSubscription
let rejectSubscription
const subscriptionReady = new Promise((resolve, reject) => {
  resolveSubscription = resolve
  rejectSubscription = reject
})

const channel = supabase
  .channel('gantang-mailbox-inserts')
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'codex_requests' },
    () => void drainMailbox(),
  )
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      subscribed = true
      resolveSubscription()
      return
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      const error = new Error(`Supabase Realtime subscription stopped: ${status}`)
      if (!subscribed) rejectSubscription(error)
      else requestShutdown(error.message)
    }
  })

await subscriptionReady
log('Gantang mail carrier is ready. Waiting for new letters; no mailbox polling is running.')
await drainMailbox()
void bridge.closed.then((error) => {
  if (!stopping) requestShutdown(`Codex app-server stopped: ${safeDiagnostic(error)}`)
})

await shutdown
await supabase.removeChannel(channel)
await bridge.close()
log('Gantang mail carrier stopped.')
process.exit(0)
