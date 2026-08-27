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

interface ToolCallFallback {
  id?: string
  name?: string
  arguments?: any
}

function parseToolCallArguments(rawArgs: any): Record<string, any> {
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim()
    if (!trimmed) return {}
    try {
      const parsed = JSON.parse(trimmed)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : { input: parsed }
    } catch {
      return { input: rawArgs }
    }
  }
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return rawArgs === undefined || rawArgs === null ? {} : { input: rawArgs }
  }
  return rawArgs
}

function hasToolCallArguments(rawArgs: any): boolean {
  if (typeof rawArgs === 'string') return rawArgs.trim().length > 0
  return rawArgs !== undefined && rawArgs !== null
}

/**
 * Return a valid, cloned tool-call block. DeepSeek may stream a tool call whose
 * final block has an empty name, id, or arguments even when earlier deltas were
 * usable. The fallback carries those accumulated delta values into the final
 * block so the assembler cannot overwrite the repaired data.
 */
export function sanitizeToolCallBlock(block: any, fallback: ToolCallFallback = {}): any {
  const blockName = typeof block?.name === 'string' ? block.name.trim() : ''
  const fallbackName = typeof fallback.name === 'string' ? fallback.name.trim() : ''
  const rawArgs = hasToolCallArguments(block?.arguments)
    ? block.arguments
    : fallback.arguments
  const parsedArgs = parseToolCallArguments(rawArgs)

  let name = blockName && blockName !== 'tool' ? blockName : fallbackName
  if (!name || name === 'tool') {
    name = inferToolName(parsedArgs)
  }

  const argumentsObject = { ...parsedArgs }
  if (name === 'bash' && (!argumentsObject.command || !String(argumentsObject.command).trim())) {
    argumentsObject.command = 'echo "No command specified"'
    if (!argumentsObject.description) argumentsObject.description = 'Fallback command'
  } else if (name === 'read' && !argumentsObject.file_path && !argumentsObject.path) {
    argumentsObject.file_path = '.'
  }

  const blockId = typeof block?.id === 'string' ? block.id.trim() : ''
  const fallbackId = typeof fallback.id === 'string' ? fallback.id.trim() : ''
  const id = blockId || fallbackId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  return {
    ...block,
    type: 'tool-call',
    id,
    name,
    arguments: JSON.stringify(argumentsObject) || '{}',
  }
}

/** Sanitize tool-call deltas and, critically, their authoritative block-end. */
export async function* sanitizeToolCallStream(innerStream: AsyncIterable<any>): AsyncGenerator<any> {
  const toolNamesByIndex = new Map<number, string>()
  const explicitToolNamesByIndex = new Map<number, string>()
  const toolArgsByIndex = new Map<number, string>()
  const toolIdsByIndex = new Map<number, string>()

  for await (const chunk of innerStream) {
    if (!chunk) continue

    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
      const index = chunk.index ?? 0
      toolNamesByIndex.delete(index)
      explicitToolNamesByIndex.delete(index)
      toolArgsByIndex.delete(index)
      toolIdsByIndex.delete(index)
      yield chunk
      continue
    }

    if (chunk.type === 'tool-call-delta') {
      const index = chunk.index ?? 0
      const incomingName = typeof chunk.name === 'string' ? chunk.name.trim() : ''
      const argumentsDelta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
      const accumulatedArgs = (toolArgsByIndex.get(index) || '') + argumentsDelta
      toolArgsByIndex.set(index, accumulatedArgs)

      if (incomingName && incomingName !== 'tool') {
        explicitToolNamesByIndex.set(index, incomingName)
      }
      const explicitName = explicitToolNamesByIndex.get(index) || ''
      const name = explicitName || inferToolName(accumulatedArgs)
      toolNamesByIndex.set(index, name)

      const incomingId = typeof chunk.id === 'string' ? chunk.id.trim() : ''
      const id = toolIdsByIndex.get(index) || incomingId || `call_${index}_${Date.now()}`
      toolIdsByIndex.set(index, id)

      yield {
        ...chunk,
        id,
        name,
      }
      continue
    }

    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      const index = chunk.index ?? 0
      const block = sanitizeToolCallBlock(chunk.block, {
        id: toolIdsByIndex.get(index),
        name: explicitToolNamesByIndex.get(index) || inferToolName(toolArgsByIndex.get(index)),
        arguments: toolArgsByIndex.get(index),
      })
      toolIdsByIndex.set(index, block.id)
      toolNamesByIndex.set(index, block.name)
      yield {
        ...chunk,
        block,
      }
      continue
    }

    yield chunk
  }
}

export function sanitizeMessagesHistory(messages: any[]): any[] {
  if (!Array.isArray(messages)) return messages
  const toolCallIds: string[] = []

  return messages.map((msg: any) => {
    if (!msg || !Array.isArray(msg.content)) return msg
    let contentChanged = false
    const newContent = msg.content.map((block: any) => {
      if (block && block.type === 'tool-call') {
        const sanitizedBlock = sanitizeToolCallBlock(block)
        toolCallIds.push(sanitizedBlock.id)
        if (
          block.name !== sanitizedBlock.name ||
          block.id !== sanitizedBlock.id ||
          block.arguments !== sanitizedBlock.arguments
        ) {
          contentChanged = true
          return sanitizedBlock
        }
      } else if (block && (block.type === 'tool-result' || block.type === 'tool')) {
        let callId =
          typeof block.toolCallId === 'string' && block.toolCallId.trim()
            ? block.toolCallId.trim()
            : typeof block.callId === 'string' && block.callId.trim()
              ? block.callId.trim()
              : typeof block.id === 'string'
                ? block.id.trim()
                : ''
        if (!callId && toolCallIds.length > 0) {
          callId = toolCallIds[toolCallIds.length - 1]
        }
        if (callId && block.toolCallId !== callId) {
          contentChanged = true
          return {
            ...block,
            toolCallId: callId,
          }
        }
      }
      return block
    })
    return contentChanged ? { ...msg, content: newContent } : msg
  })
}
