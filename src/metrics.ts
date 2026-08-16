export interface AcpUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  thoughtTokens?: number
}

export interface PromptMetrics {
  turns: number
  steps: number
  llmDurationMs: number
  avgTtftMs: number
  tokensPerSecond: number
  cacheHitRate: number
  uncachedInputTokens: number
  cachedReadTokens: number
  cachedWriteTokens: number
  outputTokens: number
  thoughtTokens: number
  totalTokens: number
  rawSummary: string
}

export interface StepUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export class SessionMetricsTracker {
  private currentStepStartTime: number = 0
  private currentStepHasFirstToken: boolean = false
  private stepDurations: number[] = []
  private ttftSamples: number[] = []
  private usageByStep: Map<string, StepUsage> = new Map()
  private seenTurns: Set<number> = new Set()
  private seenSteps: Set<string> = new Set()

  public startPromptTurn() {
    this.currentStepStartTime = 0
    this.currentStepHasFirstToken = false
    this.stepDurations = []
    this.ttftSamples = []
    this.usageByStep.clear()
    this.seenTurns.clear()
    this.seenSteps.clear()
  }

  public recordEvent(event: any) {
    if (!event || !event.type) return

    switch (event.type) {
      case 'turn/start':
        if (typeof event.data?.turn === 'number') {
          this.seenTurns.add(event.data.turn)
        }
        break

      case 'turn/end':
        if (typeof event.data?.turn === 'number') {
          this.seenTurns.add(event.data.turn)
        }
        break

      case 'step/start':
        if (typeof event.data?.turn === 'number' && typeof event.data?.step === 'number') {
          this.seenSteps.add(`${event.data.turn}:${event.data.step}`)
        }
        this.currentStepStartTime = Date.now()
        this.currentStepHasFirstToken = false
        break

      case 'assistant/chunk': {
        const chunk = event.data?.chunk
        if (!chunk) break

        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          if (!this.currentStepHasFirstToken && this.currentStepStartTime > 0) {
            this.currentStepHasFirstToken = true
            const ttft = Math.max(0, Date.now() - this.currentStepStartTime)
            this.ttftSamples.push(ttft)
          }
        } else if (chunk.type === 'usage' && chunk.usage) {
          this.recordUsage(event.data?.turn, event.data?.step, chunk.usage)
        }
        break
      }

      case 'assistant/message':
        if (event.data?.usage) {
          this.recordUsage(event.data?.turn, event.data?.step, event.data.usage)
        }
        break

      case 'step/end':
        if (this.currentStepStartTime > 0) {
          const duration = Math.max(0, Date.now() - this.currentStepStartTime)
          this.stepDurations.push(duration)
          this.currentStepStartTime = 0
        }
        break
    }
  }

  private recordUsage(turn: number | undefined, step: number | undefined, usage: any) {
    const key = `${turn ?? 0}:${step ?? 0}`
    const uncachedInputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    const cacheReadTokens = usage.cacheReadTokens ?? 0
    const cacheWriteTokens = usage.cacheWriteTokens ?? 0
    const reasoningTokens = usage.reasoningTokens ?? usage.thoughtTokens ?? 0

    this.usageByStep.set(key, {
      uncachedInputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
    })
  }

  public finishPromptTurn(): { usage: AcpUsage; metrics: PromptMetrics } {
    // If a step was still in flight when finished
    if (this.currentStepStartTime > 0) {
      const duration = Math.max(0, Date.now() - this.currentStepStartTime)
      this.stepDurations.push(duration)
      this.currentStepStartTime = 0
    }

    let uncachedInputTokens = 0
    let outputTokens = 0
    let cachedReadTokens = 0
    let cachedWriteTokens = 0
    let thoughtTokens = 0

    for (const stepUsage of this.usageByStep.values()) {
      uncachedInputTokens += stepUsage.uncachedInputTokens
      outputTokens += stepUsage.outputTokens
      cachedReadTokens += stepUsage.cacheReadTokens
      cachedWriteTokens += stepUsage.cacheWriteTokens
      thoughtTokens += stepUsage.reasoningTokens
    }

    const totalInputTokens = uncachedInputTokens + cachedReadTokens
    const totalTokens = totalInputTokens + outputTokens
    const cacheHitRate = totalInputTokens > 0 ? cachedReadTokens / totalInputTokens : 0
    const llmDurationMs = this.stepDurations.reduce((a, b) => a + b, 0)
    const avgTtftMs =
      this.ttftSamples.length > 0
        ? Math.round(this.ttftSamples.reduce((a, b) => a + b, 0) / this.ttftSamples.length)
        : 0
    const tokensPerSecond =
      llmDurationMs > 0 ? Math.round(outputTokens / (llmDurationMs / 1000)) : 0

    const turns = Math.max(this.seenTurns.size, 1)
    const steps = Math.max(this.seenSteps.size, 1)

    const rawSummary = formatMetricsSummary({
      turns,
      steps,
      llmDurationMs,
      avgTtftMs,
      tokensPerSecond,
      cacheHitRate,
      totalInputTokens,
      outputTokens,
    })

    const usage: AcpUsage = {
      inputTokens: totalInputTokens,
      outputTokens,
      totalTokens,
      cachedReadTokens,
      cachedWriteTokens,
      thoughtTokens,
    }

    const metrics: PromptMetrics = {
      turns,
      steps,
      llmDurationMs,
      avgTtftMs,
      tokensPerSecond,
      cacheHitRate: Number(cacheHitRate.toFixed(4)),
      uncachedInputTokens,
      cachedReadTokens,
      cachedWriteTokens,
      outputTokens,
      thoughtTokens,
      totalTokens,
      rawSummary,
    }

    return { usage, metrics }
  }
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = (n / 1000).toFixed(1)
    return k.endsWith('.0') ? `${(n / 1000).toFixed(0)}K` : `${k}K`
  }
  return `${n}`
}

export function formatMetricsSummary(params: {
  turns: number
  steps: number
  llmDurationMs: number
  avgTtftMs: number
  tokensPerSecond: number
  cacheHitRate: number
  totalInputTokens: number
  outputTokens: number
}): string {
  const turns = params.turns
  const steps = params.steps
  const llmSec = (params.llmDurationMs / 1000).toFixed(1)
  const ttftSec = (params.avgTtftMs / 1000).toFixed(1)
  const speed = params.tokensPerSecond
  const cachePercent = Math.round(params.cacheHitRate * 100)
  const inTok = formatTokenCount(params.totalInputTokens)
  const outTok = formatTokenCount(params.outputTokens)

  return `${turns} 轮 · ${steps} 步 | LLM ${llmSec}s | 首 token 平均 ${ttftSec}s · ${speed} tok/s | 缓存命中 ${cachePercent}% | 输入 ${inTok} tok · 输出 ${outTok} tok`
}

export class MetricsCollector {
  private trackers: Map<string, SessionMetricsTracker> = new Map()

  public getTracker(sessionId: string): SessionMetricsTracker {
    let tracker = this.trackers.get(sessionId)
    if (!tracker) {
      tracker = new SessionMetricsTracker()
      this.trackers.set(sessionId, tracker)
    }
    return tracker
  }

  public startPromptTurn(sessionId: string) {
    this.getTracker(sessionId).startPromptTurn()
  }

  public recordEvent(sessionId: string, event: any) {
    this.getTracker(sessionId).recordEvent(event)
  }

  public finishPromptTurn(sessionId: string) {
    return this.getTracker(sessionId).finishPromptTurn()
  }
}

export const metricsCollector = new MetricsCollector()
