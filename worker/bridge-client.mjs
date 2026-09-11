import { spawn } from 'node:child_process'
import path from 'node:path'

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export class BridgeSession {
  constructor(entryPath) {
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.stderr = ''
    this.child = spawn(process.execPath, [entryPath], {
      cwd: path.dirname(path.dirname(path.dirname(entryPath))),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4_000)
    })
  }

  onData(chunk) {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const key = `${typeof message.id}:${String(message.id)}`
      const waiter = this.pending.get(key)
      if (!waiter) continue
      clearTimeout(waiter.timer)
      this.pending.delete(key)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    }
  }

  request(method, params = {}, timeoutMs = 180_000) {
    const id = this.nextId++
    const key = `number:${id}`
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new Error(`Bridge timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(key, { resolve, reject, timer })
    })
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
    )
    return promise
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'all-about-book-worker', version: '1.0.0' },
    })
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )
  }

  async call(name, args) {
    const result = await this.request('tools/call', {
      name,
      arguments: args,
    })
    const text = result?.content?.[0]?.text
    if (typeof text !== 'string') {
      throw new Error(`${name} returned no text content`)
    }
    const parsed = JSON.parse(text)
    if (result.isError) throw new Error(`${name} failed`)
    return parsed
  }

  async runTurn({ threadId, cwd, text, timeoutMs = 300_000 }) {
    await this.initialize()
    const started = await this.call('codex_turn', {
      thread_id: threadId,
      cwd,
      sandbox: 'read-only',
      approval_policy: 'never',
      text,
    })
    let cursor = 0
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const observed = await this.call('codex_observe', {
        thread_id: started.thread_id,
        cursor,
        limit: 100,
        wait_ms: 10_000,
      })
      cursor = observed.next_cursor ?? cursor
      if (Array.isArray(observed.pending_requests) && observed.pending_requests.length) {
        throw new Error('Codex needs attention')
      }
      if (observed.terminal) {
        if (observed.terminal.status !== 'completed') {
          throw new Error('Codex turn did not complete')
        }
        const finalResult = String(observed.terminal.final_result ?? '').trim()
        if (!finalResult) throw new Error('Codex returned an empty reply')
        return finalResult
      }
      await delay(250)
    }
    throw new Error('Codex turn timed out')
  }

  async close() {
    if (this.child.exitCode !== null) return
    this.child.stdin.end()
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill()
        resolve()
      }, 5_000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
