export type CodexRequestStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'needs_attention'

export type CodexRequest = {
  id: string
  status: CodexRequestStatus
  responseMessageId?: string
  errorCode?: string
}

