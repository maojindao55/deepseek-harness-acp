import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'

function client(env: Record<string, string>) {
  const child = spawn(process.execPath, ['lib/bin.js'], {
    cwd: resolve(__dirname, '..'), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
  let buffer = '', errors = '', id = 0
  const messages: any[] = []
  child.stderr.on('data', (chunk) => { errors += chunk.toString() })
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    for (const line of lines) if (line.trim()) messages.push(JSON.parse(line))
  })
  async function wait(predicate: (message: any) => boolean, timeout = 30000): Promise<any> {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      const found = messages.find(predicate)
      if (found) return found
      if (child.exitCode !== null) throw new Error('ACP exited: ' + errors)
      await new Promise((r) => setTimeout(r, 15))
    }
    throw new Error('ACP timed out: ' + errors)
  }
  function request(method: string, params: any) {
    const requestId = ++id
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
    return wait((m) => m.id === requestId)
  }
  return { messages, request, wait, child, async close() {
    if (child.exitCode !== null) return
    const exited = once(child, 'exit')
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 10000)
    await exited
    clearTimeout(timer)
  } }
}

describe('Harness 0.1.6 ACP process', () => {
  it('streams once, switches models, cancels, closes, lists and restores across processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-acp-test-'))
    const clients: ReturnType<typeof client>[] = []
    const bodies: any[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      if (!body) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [] })); return }
      const parsed = JSON.parse(body); bodies.push(parsed)
      const slow = JSON.stringify(parsed.messages).includes('SLOW')
      const useTool = JSON.stringify(parsed.messages).includes('USE_TOOL')
        && !parsed.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (type: string, data: any) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n')
      emit('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: parsed.model, content: [],
        usage: { input_tokens: 10, output_tokens: 0 } } })
      emit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
      emit('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Thinking.' } })
      emit('content_block_stop', { index: 0 })
      if (useTool) {
        emit('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call_test', name: 'mcp__mock__echo_message', input: {} } })
        emit('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ text: 'MCP works' }) } })
        emit('content_block_stop', { index: 1 })
        emit('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
        emit('message_stop', {})
        res.end()
        return
      }
      emit('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
      emit('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Hello ' } })
      const timer = setTimeout(() => {
        emit('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'world.' } })
        emit('content_block_stop', { index: 1 })
        emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
        emit('message_stop', {})
        res.end()
      }, slow ? 15000 : 80)
      res.on('close', () => clearTimeout(timer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const env = {
      DSH_HOME: join(root, 'home'), DSH_SESSIONS_ROOT: join(root, 'sessions'),
      DEEPSEEK_API_KEY: 'test-not-a-real-key', DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + port,
      DEEPSEEK_PROTOCOL: 'messages', DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
    }
    try {
      const first = client(env); clients.push(first)
      const init = await first.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      expect(init.result.agentCapabilities.sessionCapabilities.close).toEqual({})
      expect(init.result.agentCapabilities.loadSession).toBe(true)
      const created = await first.request('session/new', { cwd: root, mcpServers: [] })
      expect(created.error).toBeUndefined()
      const sessionId = created.result.sessionId
      const config = await first.request('session/set_config_option', { sessionId, configId: 'effort', value: 'max' })
      expect(config.error).toBeUndefined()
      expect(config.result.configOptions.find((o: any) => o.id === 'reasoning_effort').currentValue).toBe('max')
      const switched = await first.request('session/set_config_option', { sessionId, configId: 'model', value: 'deepseek-flash' })
      expect(switched.error).toBeUndefined()
      const prompted = await first.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Say hello' }] })
      expect(prompted.error).toBeUndefined()
      expect(prompted.result.stopReason).toBe('end_turn')
      const updates = first.messages.filter((m) => m.method === 'session/update').map((m) => m.params.update)
      expect(updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('')).toBe('Hello world.')
      expect(updates.filter((u) => u.sessionUpdate === 'agent_thought_chunk').map((u) => u.content.text).join('')).toBe('Thinking.')
      expect(prompted.result.usage.outputTokens).toBeGreaterThan(0)
      expect(prompted.result._meta.metrics.steps).toBe(1)
      expect(bodies[0].model).toBe('deepseek-flash')
      const other = await first.request('session/new', { cwd: root, mcpServers: [{
        name: 'mock', command: process.execPath,
        args: ['--import', pathToFileURL(resolve(__dirname, '../node_modules/tsx/dist/loader.mjs')).href,
          resolve(__dirname, 'fixtures/mock-mcp-server.ts')], env: [],
      }] })
      expect(other.error).toBeUndefined()
      const otherId = other.result.sessionId
      const parallel = await Promise.all([
        first.request('session/prompt', { sessionId: otherId, prompt: [{ type: 'text', text: 'USE_TOOL' }] }),
        first.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Another hello' }] }),
      ])
      expect(parallel.every((r) => r.result?.stopReason === 'end_turn')).toBe(true)
      const toolUpdates = first.messages.filter((m) => m.params?.sessionId === otherId && m.params?.update?.toolCallId === 'call_test')
      expect(toolUpdates.map((m) => m.params.update.sessionUpdate)).toEqual(['tool_call', 'tool_call_update'])
      expect(toolUpdates[1].params.update.status).toBe('completed')
      const requestsWithTool = bodies.filter((b) => JSON.stringify(b.messages).includes('USE_TOOL'))
      expect(requestsWithTool[0].tools.some((t: any) => t.name === 'mcp__mock__echo_message')).toBe(true)
      expect(bodies.filter((b) => !JSON.stringify(b.messages).includes('USE_TOOL'))
        .every((b) => !b.tools.some((t: any) => t.name === 'mcp__mock__echo_message'))).toBe(true)
      await first.request('session/close', { sessionId: otherId })
      await first.request('session/close', { sessionId })
      await first.close()
      const second = client(env); clients.push(second)
      await second.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const listed = await second.request('session/list', { cwd: root })
      expect(listed.result.sessions.some((s: any) => s.sessionId === sessionId)).toBe(true)
      const invalid = await second.request('session/resume', { sessionId: 'missing', cwd: root, mcpServers: [] })
      expect(invalid.error).toBeDefined()
      const loaded = await second.request('session/load', { sessionId, cwd: root, mcpServers: [] })
      expect(loaded.error).toBeUndefined()
      expect(second.messages.some((m) => m.params?.update?.sessionUpdate === 'user_message_chunk')).toBe(true)
      const slowPrompt = second.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'SLOW' }] })
      await second.wait((m) => m.params?.update?.content?.text === 'Hello ')
      second.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }) + '\n')
      const cancelled = await slowPrompt
      expect(cancelled.result.stopReason).toBe('cancelled')
      await second.request('session/close', { sessionId })
    } finally {
      await Promise.all(clients.map((c) => c.close()))
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)
})
