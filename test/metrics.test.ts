import { describe, it, expect } from 'vitest'
import {
  formatTokenCount,
  formatMetricsSummary,
  SessionMetricsTracker,
  MetricsCollector,
} from '../src/metrics.js'

describe('formatTokenCount', () => {
  it('formats counts under 1000 verbatim', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(426)).toBe('426')
    expect(formatTokenCount(999)).toBe('999')
  })

  it('formats counts 1000 and above as K', () => {
    expect(formatTokenCount(1000)).toBe('1K')
    expect(formatTokenCount(2400)).toBe('2.4K')
    expect(formatTokenCount(10500)).toBe('10.5K')
    expect(formatTokenCount(128000)).toBe('128K')
  })
})

describe('formatMetricsSummary', () => {
  it('formats summary matching harness test format', () => {
    const summary = formatMetricsSummary({
      turns: 4,
      steps: 4,
      llmDurationMs: 4900,
      avgTtftMs: 600,
      tokensPerSecond: 111,
      cacheHitRate: 0.43,
      totalInputTokens: 2400,
      outputTokens: 426,
    })

    expect(summary).toBe(
      '4 轮 · 4 步 | LLM 4.9s | 首 token 平均 0.6s · 111 tok/s | 缓存命中 43% | 输入 2.4K tok · 输出 426 tok'
    )
  })
})

describe('SessionMetricsTracker', () => {
  it('tracks multi-turn multi-step prompt events and calculates metrics correctly', () => {
    const tracker = new SessionMetricsTracker()
    tracker.startPromptTurn()

    // Turn 1, Step 1
    tracker.recordEvent({ type: 'turn/start', data: { turn: 1 } })
    tracker.recordEvent({ type: 'step/start', data: { turn: 1, step: 1 } })
    // TTFT chunk
    tracker.recordEvent({
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'reasoning-delta', text: 'thinking...', index: 0 },
      },
    })
    // Usage chunk
    tracker.recordEvent({
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: 'usage',
          usage: {
            inputTokens: 600,
            outputTokens: 100,
            cacheReadTokens: 400,
            cacheWriteTokens: 0,
            reasoningTokens: 50,
          },
        },
      },
    })
    tracker.recordEvent({ type: 'step/end', data: { turn: 1, step: 1 } })
    tracker.recordEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    // Turn 2, Step 1
    tracker.recordEvent({ type: 'turn/start', data: { turn: 2 } })
    tracker.recordEvent({ type: 'step/start', data: { turn: 2, step: 1 } })
    tracker.recordEvent({
      type: 'assistant/chunk',
      data: {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', text: 'result', index: 0 },
      },
    })
    tracker.recordEvent({
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: { role: 'assistant', content: [] },
        usage: {
          inputTokens: 768,
          outputTokens: 326,
          cacheReadTokens: 632,
          cacheWriteTokens: 0,
          reasoningTokens: 130,
        },
      },
    })
    tracker.recordEvent({ type: 'step/end', data: { turn: 2, step: 1 } })
    tracker.recordEvent({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })

    const { usage, metrics } = tracker.finishPromptTurn()

    // Uncached inputs = 600 + 768 = 1368
    // Cache read = 400 + 632 = 1032
    // Total input tokens = 1368 + 1032 = 2400
    // Total output tokens = 100 + 326 = 426
    // Cache hit rate = 1032 / 2400 = 0.43
    // Total thought tokens = 50 + 130 = 180
    expect(usage.inputTokens).toBe(2400)
    expect(usage.outputTokens).toBe(426)
    expect(usage.totalTokens).toBe(2826)
    expect(usage.cachedReadTokens).toBe(1032)
    expect(usage.thoughtTokens).toBe(180)

    expect(metrics.turns).toBe(2)
    expect(metrics.steps).toBe(2)
    expect(metrics.cacheHitRate).toBe(0.43)
    expect(metrics.uncachedInputTokens).toBe(1368)
    expect(metrics.cachedReadTokens).toBe(1032)
    expect(metrics.outputTokens).toBe(426)
    expect(metrics.thoughtTokens).toBe(180)
    expect(metrics.rawSummary).toContain('缓存命中 43%')
    expect(metrics.rawSummary).toContain('输入 2.4K tok · 输出 426 tok')
  })

  it('handles empty/zero usage safely without NaN', () => {
    const tracker = new SessionMetricsTracker()
    tracker.startPromptTurn()

    const { usage, metrics } = tracker.finishPromptTurn()

    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
    expect(usage.totalTokens).toBe(0)
    expect(metrics.cacheHitRate).toBe(0)
    expect(metrics.tokensPerSecond).toBe(0)
    expect(metrics.avgTtftMs).toBe(0)
    expect(metrics.rawSummary).toContain('缓存命中 0%')
    expect(metrics.rawSummary).toContain('输入 0 tok · 输出 0 tok')
  })
})

describe('MetricsCollector', () => {
  it('manages metrics across different sessions independently', () => {
    const collector = new MetricsCollector()

    collector.startPromptTurn('sess-1')
    collector.startPromptTurn('sess-2')

    collector.recordEvent('sess-1', {
      type: 'step/start',
      data: { turn: 1, step: 1 },
    })
    collector.recordEvent('sess-1', {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: 'usage',
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
        },
      },
    })
    collector.recordEvent('sess-1', {
      type: 'step/end',
      data: { turn: 1, step: 1 },
    })

    collector.recordEvent('sess-2', {
      type: 'step/start',
      data: { turn: 1, step: 1 },
    })
    collector.recordEvent('sess-2', {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: 'usage',
          usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 500 },
        },
      },
    })
    collector.recordEvent('sess-2', {
      type: 'step/end',
      data: { turn: 1, step: 1 },
    })

    const res1 = collector.finishPromptTurn('sess-1')
    const res2 = collector.finishPromptTurn('sess-2')

    expect(res1.usage.inputTokens).toBe(100)
    expect(res1.usage.outputTokens).toBe(50)
    expect(res1.metrics.cacheHitRate).toBe(0)

    expect(res2.usage.inputTokens).toBe(1000)
    expect(res2.usage.outputTokens).toBe(200)
    expect(res2.metrics.cacheHitRate).toBe(0.5)
  })
})
