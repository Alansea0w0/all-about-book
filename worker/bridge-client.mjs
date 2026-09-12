const MAX_MESSAGE_BYTES = 1024 * 1024

const requireLoopbackWebSocketUrl = (value) => {
  const url = new URL(value)
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '::1' ||
    url.hostname.startsWith('127.')
  if (url.protocol !== 'ws:' || !loopback || url.username || url.password) {
    throw new Error('Codex app-server must use an unauthenticated loopback ws:// URL')
  }
  return url.toString()
}

const turnError = (turn) =>
  String(turn?.error?.message ?? `Codex turn ended with ${turn?.status ?? 'an unknown status'}`)

const firstMcpText = (result) => {
  if (typeof result?.structuredContent?.result === 'string') {
    return result.structuredContent.result.trim()
  }
  const text = (result?.content ?? [])
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n')
  return text
}

export class BridgeSession {
  constructor(appServerUrl) {
    this.appServerUrl = requireLoopbackWebSocketUrl(appServerUrl)
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.activeTurn = null
    this.socket = null
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
  }

  async connect(timeoutMs = 15_000) {
    if (this.socket) throw new Error('Codex app-server client is already connected')
    const socket = new WebSocket(this.appServerUrl)
    this.socket = socket
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)))
    socket.addEventListener('close', () => this.onClosed())
    socket.addEventListener('error', () => this.onClosed(new Error('Codex app-server connection failed')))

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex app-server connection timed out')), timeoutMs)
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('Codex app-server connection failed'))
        },
        { once: true },
      )
    })

    await this.request('initialize', {
      clientInfo: {
        name: 'all_about_book_mail_carrier',
        title: '共读甘棠取信员',
        version: '2.0.0',
      },
      capabilities: { experimentalApi: true },
    })
    this.notify('initialized')
  }

  onMessage(text) {
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
      this.onClosed(new Error('Codex app-server message exceeded the safety limit'))
      return
    }

    let message
    try {
      message = JSON.parse(text)
    } catch {
      this.onClosed(new Error('Codex app-server returned invalid JSON'))
      return
    }

    if ('id' in message && !message.method) {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      clearTimeout(waiter.timer)
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(String(message.error.message ?? 'Codex app-server error')))
      else waiter.resolve(message.result)
      return
    }

    if ('id' in message && message.method) {
      this.socket?.send(
        JSON.stringify({
          id: message.id,
          error: {
            code: -32000,
            message: 'The automated read-only mail carrier cannot approve interactive requests.',
          },
        }),
      )
      this.rejectActiveTurn(new Error('Codex needs attention'))
      return
    }

    if (!message.method) return
    this.notifications.push(message)
    if (this.notifications.length > 200) this.notifications.shift()
    this.handleNotification(message)
  }

  handleNotification(message) {
    const active = this.activeTurn
    if (!active) return
    const params = message.params ?? {}
    const notificationTurnId = params.turnId ?? params.turn?.id
    if (notificationTurnId !== active.turnId) return

    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      const text = String(params.item.text ?? '').trim()
      if (text) active.messages.push({ text, phase: params.item.phase ?? null })
      return
    }

    if (message.method !== 'turn/completed') return
    const turn = params.turn ?? {}
    if (turn.status !== 'completed') {
      this.rejectActiveTurn(new Error(turnError(turn)))
      return
    }

    for (const item of turn.items ?? []) {
      if (item?.type !== 'agentMessage') continue
      const text = String(item.text ?? '').trim()
      if (text) active.messages.push({ text, phase: item.phase ?? null })
    }
    const final = [...active.messages].reverse().find(({ phase }) => phase === 'final_answer')
      ?? active.messages.at(-1)
    if (!final?.text) {
      this.rejectActiveTurn(new Error('Codex returned an empty reply'))
      return
    }
    clearTimeout(active.timer)
    this.activeTurn = null
    active.resolve(final.text)
  }

  onClosed(error = new Error('Codex app-server connection closed')) {
    if (!this.socket) return
    this.socket = null
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
    this.rejectActiveTurn(error)
    this.resolveClosed(error)
  }

  rejectActiveTurn(error) {
    const active = this.activeTurn
    if (!active) return
    clearTimeout(active.timer)
    this.activeTurn = null
    active.reject(error)
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Codex app-server is not connected'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  notify(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server is not connected')
    }
    this.socket.send(JSON.stringify({ method, params }))
  }

  async startThread({ cwd }) {
    const result = await this.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: 'all_about_book_mail_carrier',
    }, 120_000)
    const threadId = result?.thread?.id
    if (typeof threadId !== 'string' || !threadId) {
      throw new Error('thread/start did not return a thread id')
    }
    return threadId
  }

  async resumeThread({ threadId, cwd }) {
    const result = await this.request('thread/resume', {
      threadId,
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    }, 120_000)
    if (result?.thread?.id !== threadId) {
      throw new Error('Codex app-server resumed an unexpected thread')
    }
  }

  async readOmbreContext({ threadId, query, timeoutMs = 30_000 }) {
    const result = await this.request('mcpServer/tool/call', {
      threadId,
      server: 'ombre_brain',
      tool: 'breath_search',
      arguments: {
        query: String(query).slice(0, 500),
        max_results: 3,
      },
    }, timeoutMs)
    const text = firstMcpText(result)
    if (result?.isError || !text) {
      throw new Error('Ombre Brain read-only retrieval failed')
    }
    return text.slice(0, 12_000)
  }

  async runTurn({ threadId, cwd, text, timeoutMs = 600_000 }) {
    if (this.activeTurn) throw new Error('Codex app-server already has an active mail turn')
    const result = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' } },
      personality: 'friendly',
    })
    const turnId = result?.turn?.id
    if (typeof turnId !== 'string' || !turnId) {
      throw new Error('turn/start did not return a turn id')
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeTurn = null
        void this.request('turn/interrupt', { threadId, turnId }).catch(() => {})
        reject(new Error('Codex turn timed out'))
      }, timeoutMs)
      this.activeTurn = { threadId, turnId, messages: [], resolve, reject, timer }
      for (const notification of this.notifications) this.handleNotification(notification)
    })
  }

  async close() {
    const socket = this.socket
    this.socket = null
    this.rejectActiveTurn(new Error('Codex app-server client closed'))
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000)
        socket.addEventListener('close', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
        socket.close(1000, 'mail carrier stopped')
      })
    }
    this.resolveClosed(null)
  }
}

export { requireLoopbackWebSocketUrl }
