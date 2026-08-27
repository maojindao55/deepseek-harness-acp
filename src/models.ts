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
      if (/["']?(file_path|filePath|path|filename|file)["']?\s*:/i.test(trimmed)) {
        if (/["']?(old_string|new_string|old_str|new_str|patch|replace)["']?\s*:/i.test(trimmed)) return 'edit'
        if (/["']?content["']?\s*:/i.test(trimmed)) return 'write'
        return 'read'
      }
      if (/["']?todos["']?\s*:/i.test(trimmed)) return 'todo'
      return 'bash'
    }
  }
  if (args && typeof args === 'object') {
    if ('command' in args || 'cmd' in args || 'input' in args) return 'bash'
    if ('file_path' in args || 'filePath' in args || 'path' in args || 'filename' in args || 'file' in args) {
      if (
        'old_string' in args ||
        'new_string' in args ||
        'old_str' in args ||
        'new_str' in args ||
        'patch' in args ||
        'replace' in args ||
        'replace_all' in args
      ) {
        return 'edit'
      }
      if ('content' in args || 'text' in args) return 'write'
      return 'read'
    }
    if ('todos' in args) return 'todo'
  }
  return 'bash'
}

export function sanitizeMessagesHistory(messages: any[]): any[] {
  if (!Array.isArray(messages)) return messages
  const toolCallIds: string[] = []

  return messages.map((msg: any) => {
    if (!msg || !Array.isArray(msg.content)) return msg
    let contentChanged = false
    const newContent = msg.content.map((block: any) => {
      if (block && block.type === 'tool-call') {
        let currentName = typeof block.name === 'string' ? block.name.trim() : ''
        let rawArgs = block.arguments
        if (typeof rawArgs === 'string') {
          try {
            rawArgs = JSON.parse(rawArgs)
          } catch {
            rawArgs = rawArgs ? { input: rawArgs } : {}
          }
        }
        if (!rawArgs || typeof rawArgs !== 'object') {
          rawArgs = {}
        }

        let targetName = currentName
        if (!targetName || targetName === 'tool') {
          targetName = inferToolName(rawArgs)
        }

        let targetId = typeof block.id === 'string' ? block.id.trim() : ''
        if (!targetId) {
          targetId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        }
        toolCallIds.push(targetId)

        let updatedArgs = { ...rawArgs }
        if (targetName === 'bash' && (!updatedArgs.command || !String(updatedArgs.command).trim())) {
          updatedArgs.command = 'echo "No command specified"'
          if (!updatedArgs.description) updatedArgs.description = 'Fallback command'
        } else if (targetName === 'read' && !updatedArgs.file_path && !updatedArgs.path) {
          updatedArgs.file_path = '.'
        }

        const stringifiedArgs = JSON.stringify(updatedArgs) || '{}'

        if (block.name !== targetName || block.id !== targetId || block.arguments !== stringifiedArgs) {
          contentChanged = true
          return {
            ...block,
            id: targetId,
            name: targetName,
            arguments: stringifiedArgs,
          }
        }
      } else if (block && (block.type === 'tool-result' || block.type === 'tool')) {
        let callId = typeof block.callId === 'string' ? block.callId.trim() : (typeof block.id === 'string' ? block.id.trim() : '')
        if (!callId && toolCallIds.length > 0) {
          callId = toolCallIds[toolCallIds.length - 1]
          contentChanged = true
          return {
            ...block,
            callId,
            id: callId,
          }
        }
      }
      return block
    })
    return contentChanged ? { ...msg, content: newContent } : msg
  })
}
