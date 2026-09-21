import { Readable, Writable } from 'node:stream'
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { MetricsCollector } from './metrics.js'
import { sessionMcpServers } from './mcp/config.js'

type Message = any // JSON-RPC boundary; the official SDK validates protocol payloads.
type Delivered = { text: string; reasoning: string }

/** Strip only the prefix actually delivered live, preserving non-streamed content. */
export function stripDelivered(text: string, delivered: string): [string, string] {
  let length = 0
  while (length < text.length && length < delivered.length && text[length] === delivered[length]) length++
  return [text.slice(length), delivered.slice(length)]
}

export function createBridge(ctx: Context, version: string, transport: Stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
)) {
  const writer = transport.writable.getWriter()
  const query = ctx.sessionQuery
  const attachments = ctx.get('attachments')
  const reader = transport.readable.getReader()
  const metrics = new MetricsCollector()
  const pending = new Map<string | number, Message>()
  const owned = new Set<string>()
  const busy = new Set<string>()
  const attempts = new Map<string, Delivered>()
  const committed = new Map<string, Delivered>()
  let output = Promise.resolve()
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
  const send = (message: Message) => {
    output = output.then(() => writer.write(message))
    return output
  }
  const notify = (sessionId: string, update: Message) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
  const key = (sessionId: string, id: string) => JSON.stringify([sessionId, id])

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = agent.session.id
    if (!owned.has(sessionId)) return
    if (frame.type === 'start') {
      attempts.set(sessionId, { text: '', reasoning: '' })
      metrics.recordEvent(sessionId, { type: 'step/start', data: { turn: frame.turn, step: frame.step } })
    } else if (frame.type === 'chunk') {
      const chunk = frame.chunk
      metrics.recordEvent(sessionId, { type: 'assistant/chunk', data: { chunk } })
      if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return
      const delivered = attempts.get(sessionId)
      if (!delivered) return
      const field = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      delivered[field] += chunk.text
      void notify(sessionId, {
        sessionUpdate: field === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
        content: { type: 'text', text: chunk.text },
      }).catch(() => {})
    } else {
      metrics.recordEvent(sessionId, { type: 'step/end' })
      attempts.delete(sessionId)
    }
  })
  ctx.on('session/event', (session, event) => {
    const sessionId = session.id
    if (!owned.has(sessionId)) return
    if (event.type === 'assistant/message') {
      const delivered = attempts.get(sessionId)
      if (delivered) committed.set(key(sessionId, event.data.message.id), { ...delivered })
    }
    // Live frames own request timing; durable messages own authoritative usage.
    if (event.type !== 'step/start' && event.type !== 'step/end') metrics.recordEvent(sessionId, event)
  })

  async function replay(sessionId: string) {
    const snapshot = await query.readSession(sessionId as SessionId)
    async function content(block: any) {
      if (block.type === 'text' || block.type === 'reasoning') return { type: 'text', text: block.text }
      if (block.type === 'image' && attachments) {
        const stored = await attachments.readImage(block.attachment)
        return { type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: stored.ref.mediaType }
      }
      return undefined
    }
    for (const event of snapshot.events) {
      if (event.type === 'tool/call') {
        let rawInput: unknown = event.data.arguments
        try { rawInput = JSON.parse(event.data.arguments) } catch {}
        await notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: event.data.callId,
          title: event.data.name, kind: 'other', status: 'in_progress', rawInput })
        continue
      }
      if (event.type === 'tool/result') {
        const result = event.data.message.content[0]
        const blocks = []
        for (const block of result.content) {
          const value = await content(block)
          if (value) blocks.push({ type: 'content', content: value })
        }
        await notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: result.toolCallId,
          status: result.isError ? 'failed' : 'completed', content: blocks })
        continue
      }
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
      if (event.surfaceOp !== 'append') continue
      const blocks = event.type === 'user/message' ? event.data.content : event.data.message.content
      for (const block of blocks) {
        const value = await content(block)
        if (!value) continue
        await notify(sessionId, {
          sessionUpdate: event.type === 'user/message' ? 'user_message_chunk'
            : block.type === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
          content: value,
        })
      }
    }
  }

  const stream: Stream = {
    readable: new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const message: Message = value
            try {
              if (message.method?.startsWith('session/')) {
                const params = message.params ?? {}
                if (['session/new', 'session/resume', 'session/load'].includes(message.method)) {
                  params.mcpServers = sessionMcpServers(params.cwd, params.mcpServers)
                }
                if (message.method === 'session/set_config_option') {
                  if (params.configId === 'effort') params.configId = 'reasoning_effort'
                  if (params.configId === 'model' && typeof params.value === 'string' && !params.value.startsWith('[')) {
                    params.value = JSON.stringify(['deepseek-official', params.value])
                  }
                }
                if (message.method === 'session/prompt' && busy.has(params.sessionId)) throw new Error('A prompt is already running in this session')
                if (message.method === 'session/prompt' && owned.has(params.sessionId)) {
                  busy.add(params.sessionId)
                  metrics.startPromptTurn(params.sessionId)
                }
                if (message.id !== undefined) pending.set(message.id, { method: message.method, sessionId: params.sessionId })
                if (message.method === 'session/load') message.method = 'session/resume'
              }
              controller.enqueue(message)
            } catch (error) {
              if (message.id !== undefined) await send({ jsonrpc: '2.0', id: message.id,
                error: { code: -32602, message: String(error) } })
            }
          }
          controller.close()
        } catch (error) { controller.error(error) }
        finally { resolveClosed() }
      },
    }),
    writable: new WritableStream({
      async write(value) {
        const message: Message = value
        // Each JSON-RPC direction owns its IDs; agent requests may reuse a client request ID.
        const request = message.method === undefined ? pending.get(message.id) : undefined
        if (request) {
          pending.delete(message.id)
          if (message.result && ['session/new', 'session/resume', 'session/load'].includes(request.method)) {
            const sessionId = message.result.sessionId ?? request.sessionId
            owned.add(sessionId)
            if (request.method === 'session/load') {
              try { await replay(sessionId) } catch (error) {
                // The resumed session remains usable; report replay failure instead of claiming a successful load.
                message.error = { code: -32603, message: `History replay failed: ${String(error)}` }
                delete message.result
              }
            }
          }
          if (request.method === 'session/prompt') {
            busy.delete(request.sessionId)
            if (message.result) {
              const result = metrics.finishPromptTurn(request.sessionId)
              message.result.usage ??= result.usage
              message.result._meta = { ...message.result._meta, metrics: result.metrics }
            }
            for (const id of committed.keys()) if (id.startsWith(JSON.stringify([request.sessionId]).slice(0, -1) + ',')) committed.delete(id)
          }
          if (request.method === 'session/close' && message.result) {
            owned.delete(request.sessionId)
            attempts.delete(request.sessionId)
            metrics.release(request.sessionId)
          }
        }
        if (message.result?.agentCapabilities) {
          message.result.agentInfo = { ...message.result.agentInfo, name: 'deepseek-harness-acp', version }
          message.result.agentCapabilities.loadSession = true
        }
        const update = message.params?.update
        if (message.method === 'session/update' && update?.messageId) {
          const delivered = committed.get(key(message.params.sessionId, update.messageId))
          const field = update.sessionUpdate === 'agent_message_chunk' ? 'text'
            : update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : undefined
          if (delivered && field && update.content?.type === 'text') {
            const [text, remaining] = stripDelivered(update.content.text, delivered[field])
            delivered[field] = remaining
            if (!text) return
            update.content = { ...update.content, text }
          }
        }
        await send(message)
      },
      async close() { await output; resolveClosed() },
      abort() { resolveClosed() },
    }),
  }
  return { stream, closed }
}
