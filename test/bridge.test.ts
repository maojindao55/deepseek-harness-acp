import { describe, it, expect } from 'vitest'
import { createBridge, stripDelivered } from '../src/bridge.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Stream } from '@agentclientprotocol/sdk'

describe('stream transport', () => {
  it('preserves unstreamed suffixes and images while removing delivered prefixes', () => {
    expect(stripDelivered('Hello world', 'Hello ')).toEqual(['world', ''])
    expect(stripDelivered('Hel', 'Hello ')).toEqual(['', 'lo '])
    expect(stripDelivered('new', '')).toEqual(['new', ''])
  })

  it('isolates sessions, suppresses committed duplicates and leaves cancellation dispatchable', async () => {
    const handlers = new Map<string, Function>()
    const ctx = {
      sessionQuery: {}, get: () => undefined,
      on: (name: string, callback: Function) => handlers.set(name, callback),
    } as unknown as Context
    let controller!: ReadableStreamDefaultController<any>
    const outgoing: any[] = []
    const transport: Stream = {
      readable: new ReadableStream({ start(c) { controller = c } }),
      writable: new WritableStream({ write(message) { outgoing.push(message) } }),
    }
    const bridge = createBridge(ctx, 'test', transport)
    const input = bridge.stream.readable.getReader()
    const output = bridge.stream.writable.getWriter()
    for (const [id, sessionId] of [[1, 'a'], [2, 'b']] as const) {
      controller.enqueue({ jsonrpc: '2.0', id, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } })
      await input.read()
      await output.write({ jsonrpc: '2.0', id, result: { sessionId } } as any)
    }
    controller.enqueue({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'a', prompt: [] } })
    await input.read()
    await output.write({ jsonrpc: '2.0', id: 3, method: 'session/request_permission', params: { sessionId: 'a' } } as any)
    controller.enqueue({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'a', prompt: [] } })
    // Reading the following cancellation also waits until the duplicate prompt was processed.
    controller.enqueue({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'a' } })
    expect((await input.read()).value).toMatchObject({ method: 'session/cancel' })
    expect(outgoing.find((m) => m.id === 4)).toMatchObject({ error: { code: -32602 } })
    await output.write({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } } as any)
    expect(outgoing.find((m) => m.id === 3 && m.result)).toMatchObject({ result: { _meta: { metrics: expect.any(Object) } } })
    const emit = (sessionId: string, frame: any) => handlers.get('agent/assistant-stream')!({ agent: { session: { id: sessionId } }, frame })
    emit('a', { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    emit('b', { type: 'start', attemptId: 'b1', revision: 1, turn: 1, step: 1 })
    emit('a', { type: 'chunk', chunk: { type: 'text-delta', text: 'Alpha' } })
    emit('b', { type: 'chunk', chunk: { type: 'text-delta', text: 'Beta' } })
    for (const [sessionId, text] of [['a', 'Alpha'], ['b', 'Beta']]) {
      handlers.get('session/event')!({ id: sessionId }, { type: 'assistant/message', data: { message: { id: 'same-message-id' } } })
      emit(sessionId, { type: 'end' })
      await output.write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk', messageId: 'same-message-id', content: { type: 'text', text },
      } } } as any)
    }
    controller.enqueue({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'a' } })
    expect((await input.read()).value).toMatchObject({ method: 'session/cancel' })
    expect(outgoing.filter((m) => m.method === 'session/update').map((m) => [m.params.sessionId, m.params.update.content.text]))
      .toEqual([['a', 'Alpha'], ['b', 'Beta']])
    controller.close()
    await bridge.closed
  })
})
