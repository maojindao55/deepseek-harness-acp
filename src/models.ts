export interface ModelOption {
  id: string
  name: string
  contextWindow?: number
  description?: string
}

export const DEFAULT_MODEL =
  process.env.DEEPSEEK_MODEL ||
  process.env.DSH_MODEL ||
  process.env.MODEL ||
  'deepseek-v4-pro'
export const DEFAULT_EFFORT = 'max'

export const SUPPORTED_MODELS: ModelOption[] = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 128_000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 128_000 },
]

export function getEffectiveSupportedModels(currentModel?: string): ModelOption[] {
  const models = [...SUPPORTED_MODELS]
  const envModel = process.env.DEEPSEEK_MODEL || process.env.DSH_MODEL || process.env.MODEL
  if (envModel && !models.some((m) => m.id === envModel)) {
    models.unshift({ id: envModel, name: envModel, contextWindow: 128_000 })
  }
  if (currentModel && !models.some((m) => m.id === currentModel)) {
    models.unshift({ id: currentModel, name: currentModel, contextWindow: 128_000 })
  }
  return models
}

export const SUPPORTED_EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]

export function normalizeReasoningEffort(effort?: string): 'off' | 'high' | 'max' | undefined {
  if (!effort) return undefined
  const val = effort.trim().toLowerCase()
  if (val === 'off' || val === 'none' || val === 'disabled' || val === 'false') return 'off'
  if (val === 'max') return 'max'
  if (val === 'high') return 'high'
  if (val === 'medium') return 'high'
  if (val === 'low') return 'off'
  return undefined
}

export interface SessionState {
  sessionId: string
  cwd: string
  model: string
  effort: string
}

export function buildConfigOptions(sessionState: { model: string; effort: string }) {
  const models = getEffectiveSupportedModels(sessionState.model)
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: sessionState.model,
      options: models.map((m) => ({ value: m.id, name: m.name })),
    },
    {
      id: 'effort',
      name: 'Reasoning Effort',
      category: 'thought_level',
      type: 'select' as const,
      currentValue: sessionState.effort,
      options: SUPPORTED_EFFORTS.map((e) => ({ value: e.id, name: e.name })),
    },
  ]
}
