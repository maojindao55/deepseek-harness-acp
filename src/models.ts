export interface ModelOption {
  id: string
  name: string
  contextWindow?: number
  description?: string
}

export const DEFAULT_MODEL = 'deepseek-v4-pro'
export const DEFAULT_EFFORT = 'max'

export const SUPPORTED_MODELS: ModelOption[] = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 128_000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 128_000 },
  { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)', contextWindow: 64_000 },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)', contextWindow: 64_000 },
]

export const SUPPORTED_EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]

export interface SessionState {
  sessionId: string
  cwd: string
  model: string
  effort: string
}

export function buildConfigOptions(sessionState: { model: string; effort: string }) {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: sessionState.model,
      options: SUPPORTED_MODELS.map((m) => ({ value: m.id, name: m.name })),
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
