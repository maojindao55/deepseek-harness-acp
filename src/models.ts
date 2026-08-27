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
export const DEFAULT_EFFORT = 'high'

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
  { id: 'off', name: 'Off / None' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]

export function normalizeReasoningEffort(effort?: string): 'off' | 'low' | 'high' | undefined {
  if (!effort) return undefined
  const val = effort.trim().toLowerCase()
  if (val === 'off' || val === 'none' || val === 'disabled' || val === 'false') return 'off'
  if (val === 'low') return 'low'
  if (val === 'medium' || val === 'high' || val === 'max' || val === 'xhigh') return 'high'
  return 'high'
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
  if (!rawArgs) return 'bash'
  let args = rawArgs
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (!trimmed) return 'bash'
    try {
      args = JSON.parse(trimmed)
    } catch {
      if (/["']?command["']?\s*:/i.test(trimmed) || /["']?cmd["']?\s*:/i.test(trimmed)) return 'bash'
      if (/["']?path["']?\s*:/i.test(trimmed)) {
        if (/["']?(offset|limit|line)["']?\s*:/i.test(trimmed)) return 'read'
        if (/["']?(old_str|new_str|patch|replace)["']?\s*:/i.test(trimmed)) return 'edit'
        if (/["']?content["']?\s*:/i.test(trimmed)) return 'write'
        return 'read'
      }
      if (/["']?todos["']?\s*:/i.test(trimmed)) return 'todo'
      return 'bash'
    }
  }
  if (args && typeof args === 'object') {
    if ('command' in args || 'cmd' in args || 'input' in args) return 'bash'
    if ('path' in args) {
      if ('offset' in args || 'limit' in args || 'line' in args) return 'read'
      if ('old_str' in args || 'new_str' in args || 'patch' in args || 'replace' in args) return 'edit'
      if ('content' in args) return 'write'
      return 'read'
    }
    if ('todos' in args) return 'todo'
  }
  return 'bash'
}

export function sanitizeMessagesHistory(messages: any[]): any[] {
  if (!Array.isArray(messages)) return messages
  return messages.map((msg: any) => {
    if (!msg || !Array.isArray(msg.content)) return msg
    let contentChanged = false
    const newContent = msg.content.map((block: any) => {
      if (block && block.type === 'tool-call') {
        const currentName = typeof block.name === 'string' ? block.name.trim() : ''
        if (!currentName || currentName === 'tool') {
          contentChanged = true
          return {
            ...block,
            name: inferToolName(block.arguments),
          }
        }
      }
      return block
    })
    return contentChanged ? { ...msg, content: newContent } : msg
  })
}
