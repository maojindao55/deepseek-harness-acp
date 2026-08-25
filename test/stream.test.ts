import { describe, it, expect } from 'vitest'
import { metricsCollector } from '../src/metrics.js'
import { inferToolName, sanitizeMessagesHistory } from '../src/models.js'
import { Readable, Writable } from 'node:stream'

describe('Stream and Prompt Result Augmentation logic', () => {
  it('augments prompt result with usage and _meta.metrics on response', () => {
    const sessionId = 'test-session-123'
    metricsCollector.startPromptTurn(sessionId)

    // Simulate agent events during prompt
    metricsCollector.recordEvent(sessionId, {
      type: 'turn/start',
      data: { turn: 1 },
    })
    metricsCollector.recordEvent(sessionId, {
      type: 'step/start',
      data: { turn: 1, step: 1 },
    })
    metricsCollector.recordEvent(sessionId, {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: 'usage',
          usage: {
            inputTokens: 1368,
            outputTokens: 426,
            cacheReadTokens: 1032,
            cacheWriteTokens: 0,
            reasoningTokens: 180,
          },
        },
      },
    })
    metricsCollector.recordEvent(sessionId, {
      type: 'step/end',
      data: { turn: 1, step: 1 },
    })
    metricsCollector.recordEvent(sessionId, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    })

    // Simulate what wrapStdoutWebStream does
    const outgoingResponse: any = {
      jsonrpc: '2.0',
      id: 42,
      result: {
        stopReason: 'end_turn',
      },
    }

    const { usage, metrics } = metricsCollector.finishPromptTurn(sessionId)
    outgoingResponse.result.usage = usage
    outgoingResponse.result._meta = {
      ...(outgoingResponse.result._meta ?? {}),
      metrics,
    }

    expect(outgoingResponse.result.stopReason).toBe('end_turn')
    expect(outgoingResponse.result.usage).toEqual({
      inputTokens: 2400,
      outputTokens: 426,
      totalTokens: 2826,
      cachedReadTokens: 1032,
      cachedWriteTokens: 0,
      thoughtTokens: 180,
    })
    expect(outgoingResponse.result._meta.metrics.cacheHitRate).toBe(0.43)
    expect(outgoingResponse.result._meta.metrics.rawSummary).toContain('缓存命中 43%')
    expect(outgoingResponse.result._meta.metrics.rawSummary).toContain('输入 2.4K tok · 输出 426 tok')
  })

  it('correctly tracks 4 turns 4 steps with speed and latency metrics', () => {
    const sessionId = 'test-session-4turns'
    metricsCollector.startPromptTurn(sessionId)

    for (let i = 1; i <= 4; i++) {
      metricsCollector.recordEvent(sessionId, { type: 'turn/start', data: { turn: i } })
      metricsCollector.recordEvent(sessionId, { type: 'step/start', data: { turn: i, step: i } })
      metricsCollector.recordEvent(sessionId, {
        type: 'assistant/chunk',
        data: {
          turn: i,
          step: i,
          chunk: { type: 'text-delta', text: `chunk ${i}`, index: 0 },
        },
      })
      metricsCollector.recordEvent(sessionId, {
        type: 'assistant/chunk',
        data: {
          turn: i,
          step: i,
          chunk: {
            type: 'usage',
            usage: {
              inputTokens: 342,
              outputTokens: 106,
              cacheReadTokens: 258,
              cacheWriteTokens: 0,
              reasoningTokens: 45,
            },
          },
        },
      })
      metricsCollector.recordEvent(sessionId, { type: 'step/end', data: { turn: i, step: i } })
      metricsCollector.recordEvent(sessionId, { type: 'turn/end', data: { turn: i, reason: { kind: 'completed' } } })
    }

    const { usage, metrics } = metricsCollector.finishPromptTurn(sessionId)

    expect(metrics.turns).toBe(4)
    expect(metrics.steps).toBe(4)
    expect(usage.inputTokens).toBe(2400) // (342 + 258) * 4 = 2400
    expect(usage.outputTokens).toBe(424) // 106 * 4 = 424
    expect(usage.cachedReadTokens).toBe(1032) // 258 * 4 = 1032
    expect(metrics.cacheHitRate).toBe(0.43)
    expect(metrics.rawSummary).toContain('4 轮 · 4 步')
    expect(metrics.rawSummary).toContain('缓存命中 43%')
  })

  it('formats tool/call and tool/result and live chunk updates properly', () => {
    const formattedUpdates: any[] = []
    const emitUpdate = (update: any) => formattedUpdates.push(update)

    // Reasoning chunk
    emitUpdate({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking process...' },
        },
      },
    })

    // Tool call
    emitUpdate({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_1',
          title: 'tool_fs_read_file',
          rawInput: { path: 'package.json' },
          status: 'in_progress',
        },
      },
    })

    // Tool result
    emitUpdate({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'completed',
          rawOutput: '{"name":"deepseek-harness-acp"}',
          content: [{ type: 'text', text: '{"name":"deepseek-harness-acp"}' }],
        },
      },
    })

    // Text chunk
    emitUpdate({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Here is the file content.' },
        },
      },
    })

    expect(formattedUpdates).toHaveLength(4)
    expect(formattedUpdates[0].params.update.sessionUpdate).toBe('agent_thought_chunk')
    expect(formattedUpdates[1].params.update.sessionUpdate).toBe('tool_call')
    expect(formattedUpdates[1].params.update.title).toBe('tool_fs_read_file')
    expect(formattedUpdates[2].params.update.sessionUpdate).toBe('tool_call_update')
    expect(formattedUpdates[2].params.update.status).toBe('completed')
    expect(formattedUpdates[3].params.update.sessionUpdate).toBe('agent_message_chunk')
  })

  it('infers tool names from arguments when name is empty or generic tool', () => {
    expect(inferToolName({ command: 'ls -la', description: 'List files' })).toBe('bash')
    expect(inferToolName('{"command":"git status"}')).toBe('bash')
    expect(inferToolName({ path: 'test.txt', offset: 1, limit: 10 })).toBe('read')
    expect(inferToolName({ path: 'test.txt', content: 'hello' })).toBe('write')
    expect(inferToolName({ path: 'test.txt', old_str: 'a', new_str: 'b' })).toBe('edit')
    expect(inferToolName({ todos: [] })).toBe('todo')
    expect(inferToolName({})).toBe('bash')
  })

  it('safely sanitizes message history with frozen tool-call objects without throwing', () => {
    const frozenBlock = Object.freeze({
      type: 'tool-call',
      name: '',
      arguments: { command: 'npm test' },
    })
    const frozenMsg = Object.freeze({
      role: 'assistant',
      content: [frozenBlock],
    })
    const messages = [frozenMsg]

    // Should not throw TypeError: Cannot assign to read only property
    const sanitized = sanitizeMessagesHistory(messages)
    expect(sanitized).toHaveLength(1)
    expect(sanitized[0].content[0].name).toBe('bash')
    expect(sanitized[0].content[0].type).toBe('tool-call')

    // Original frozen objects remain unchanged
    expect(frozenBlock.name).toBe('')
  })
})
