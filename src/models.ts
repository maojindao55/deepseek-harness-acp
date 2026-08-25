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
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', contextWindow: 1_000_000 },
]

export function formatModelDisplayName(id: string): string {
  return id
    .replace(/^deepseek/i, 'DeepSeek')
    .split('-')
    .map((s) => (s.toLowerCase() === 'deepseek' ? 'DeepSeek' : s.charAt(0).toUpperCase() + s.slice(1)))
    .join(' ')
}

export function getEffectiveSupportedModels(currentModel?: string, baseModels?: ModelOption[]): ModelOption[] {
  const models = [...(baseModels && baseModels.length > 0 ? baseModels : SUPPORTED_MODELS)]
  const envModel = process.env.DEEPSEEK_MODEL || process.env.DSH_MODEL || process.env.MODEL
  if (envModel && !models.some((m) => m.id === envModel)) {
    models.unshift({ id: envModel, name: formatModelDisplayName(envModel), contextWindow: 1_000_000 })
  }
  if (currentModel && !models.some((m) => m.id === currentModel)) {
    models.unshift({ id: currentModel, name: formatModelDisplayName(currentModel), contextWindow: 1_000_000 })
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

export function buildConfigOptions(sessionState: { model: string; effort: string }, customModels?: ModelOption[]) {
  const models = getEffectiveSupportedModels(sessionState.model, customModels)
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

export function inferToolName(rawArgs: any): string {
  let args = rawArgs
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = {}
    }
  }
  if (args && typeof args === 'object') {
    if ('command' in args) return 'bash'
    if ('path' in args && ('offset' in args || 'limit' in args)) return 'read'
    if ('path' in args && 'content' in args) return 'write'
    if ('path' in args && ('old_str' in args || 'new_str' in args || 'patch' in args)) return 'edit'
    if ('todos' in args) return 'todo'
  }
  return 'bash'
}

export function sanitizeMessagesHistory(messages: any[]): any[] {
  if (!Array.isArray(messages)) return messages
  return messages.map((msg: any) => {
    if (!Array.isArray(msg?.content)) return msg
    let contentChanged = false
    const newContent = msg.content.map((block: any) => {
      if (block && block.type === 'tool-call' && (!block.name || block.name === 'tool' || block.name === '')) {
        contentChanged = true
        return {
          ...block,
          name: inferToolName(block.arguments),
        }
      }
      return block
    })
    return contentChanged ? { ...msg, content: newContent } : msg
  })
}
