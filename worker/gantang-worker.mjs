import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { BridgeSession } from './bridge-client.mjs'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required setting: ${name}`)
  return value
}

const settings = {
  supabaseUrl: required('GANTANG_SUPABASE_URL'),
  serviceRoleKey: required('GANTANG_SUPABASE_SERVICE_ROLE_KEY'),
  threadId: required('GANTANG_CODEX_THREAD_ID'),
  codexCwd: required('GANTANG_CODEX_CWD'),
  bridgeEntry: required('GANTANG_BRIDGE_ENTRY'),
  pollMs: Number(process.env.GANTANG_POLL_MS ?? 2_000),
}

const supabase = createClient(settings.supabaseUrl, settings.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const log = (message) => {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`)
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const selectOrThrow = async (promise) => {
  const { data, error } = await promise
  if (error) throw error
  return data
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

const buildPrompt = (request, context) => {
  const contextBlock = request.attach_context
    ? JSON.stringify(context, null, 2).slice(0, 42_000)
    : JSON.stringify({ book: context.book, discussions: context.discussions }, null, 2).slice(0, 42_000)

  return [
    '这是来自小安“共读小屋”的一封信。请延续这个固定共读任务中的关系与语气，直接写出要回到网页讨论区的回复正文。',
    '你可以只读查询 Ombre Brain 来衔接关系与共同经历，但不要修改任何文件、数据库、schema、RLS、登录设置或外部状态。不要提及取信员、队列、JSON 或内部流程。',
    '',
    '小安这次写道：',
    request.content,
    '',
    '当前阅读资料：',
    contextBlock,
  ].join('\n')
}

const safeFailureCode = (error) => {
  const message = String(error?.message ?? error)
  if (message.includes('needs attention')) return 'codex_needs_attention'
  if (message.includes('timed out')) return 'codex_timeout'
  if (message.includes('ownership')) return 'invalid_request_scope'
  if (message.includes('Bridge')) return 'bridge_unavailable'
  return 'worker_error'
}

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
      source: 'local-codex-bridge',
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
  log(`Request ${request.id} stopped with ${errorCode}.`)
}

const processRequest = async (request) => {
  log(`Taking request ${request.id}.`)
  let bridge
  try {
    const context = await loadContext(request)
    bridge = new BridgeSession(settings.bridgeEntry)
    const reply = await bridge.runTurn({
      threadId: settings.threadId,
      cwd: settings.codexCwd,
      text: buildPrompt(request, context),
    })
    await finishRequest(request, reply)
    log(`Completed request ${request.id}.`)
  } catch (error) {
    await failRequest(request, error)
  } finally {
    await bridge?.close()
  }
}

let stopping = false
process.on('SIGINT', () => {
  stopping = true
})
process.on('SIGTERM', () => {
  stopping = true
})

log('Gantang mail carrier is ready.')
while (!stopping) {
  try {
    const request = await claimNextRequest()
    if (request) await processRequest(request)
    else await sleep(settings.pollMs)
  } catch {
    log('Mailbox check failed; trying again soon.')
    await sleep(Math.max(settings.pollMs, 5_000))
  }
}
log('Gantang mail carrier stopped.')

