import { supabase } from './supabaseClient'
import type { CodexRequest } from '../types/codex-request'

type CodexRequestRow = {
  id: string
  status: CodexRequest['status']
  response_message_id: string | null
  error_code: string | null
}

const ensureClient = () => {
  if (!supabase) {
    throw new Error('Supabase client is not configured.')
  }
  return supabase
}

const normalizeRequest = (row: CodexRequestRow): CodexRequest => ({
  id: row.id,
  status: row.status,
  responseMessageId: row.response_message_id ?? undefined,
  errorCode: row.error_code ?? undefined,
})

export const createCodexRequest = async (input: {
  userId: string
  bookId: string
  conversationId: string
  userMessageId?: string
  content: string
  attachContext: boolean
}): Promise<CodexRequest> => {
  const client = ensureClient()
  const id = crypto.randomUUID()
  const { data, error } = await client
    .from('codex_requests')
    .insert({
      id,
      user_id: input.userId,
      book_id: input.bookId,
      conversation_id: input.conversationId,
      user_message_id: input.userMessageId ?? null,
      content: input.content,
      attach_context: input.attachContext,
    })
    .select('id,status,response_message_id,error_code')
    .single()

  if (error) throw error
  return normalizeRequest(data as CodexRequestRow)
}

export const fetchCodexRequest = async (
  userId: string,
  requestId: string,
): Promise<CodexRequest> => {
  const client = ensureClient()
  const { data, error } = await client
    .from('codex_requests')
    .select('id,status,response_message_id,error_code')
    .eq('user_id', userId)
    .eq('id', requestId)
    .single()

  if (error) throw error
  return normalizeRequest(data as CodexRequestRow)
}

export const waitForCodexRequest = async (
  userId: string,
  requestId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<CodexRequest> => {
  const timeoutMs = options.timeoutMs ?? 120_000
  const intervalMs = options.intervalMs ?? 1_500
  const deadline = Date.now() + timeoutMs
  let latest = await fetchCodexRequest(userId, requestId)

  while (
    latest.status === 'queued' ||
    latest.status === 'processing'
  ) {
    if (Date.now() >= deadline) return latest
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs))
    latest = await fetchCodexRequest(userId, requestId)
  }

  return latest
}

