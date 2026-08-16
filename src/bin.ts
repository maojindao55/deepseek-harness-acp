#!/usr/bin/env node
/**
 * Standalone executable entry for DeepSeek Harness ACP Server.
 * Supports zero-config startup by falling back to bundled default configuration.
 * Augments ACP protocol with dynamic model configuration and switching.
 */

import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { buildConfigOptions, DEFAULT_EFFORT, DEFAULT_MODEL, SessionState } from './models.js'
import { metricsCollector } from './metrics.js'

const NAME = 'deepseek-harness-acp'
const currentDir = dirname(fileURLToPath(import.meta.url))

// Read version from package.json
let version = '0.1.3'
try {
  const pkgPath = resolve(currentDir, '../package.json')
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.version) version = pkg.version
  }
} catch {}

if (process.argv.includes('--version') || process.argv.includes('-v') || process.argv.includes('version')) {
  process.stdout.write(`${version}\n`)
  process.exit(0)
}

installFailLoud(NAME)
const env = loadEnv(NAME)

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
  strict: false,
})

if (values.help) {
  console.log(`
DeepSeek Harness ACP Server (Standalone)

Usage:
  deepseek-harness-acp [options]
  dsh-acp [options]

Options:
  -c, --config <path>   Path to custom cordis.yml configuration file
  -h, --help            Show this help message
  -v, --version         Show version (${version})

Environment Variables:
  DEEPSEEK_API_KEY      DeepSeek API key (required)
  DEEPSEEK_BASE_URL     Optional API base URL override
  DSH_PERMISSION_MODE   Permission mode: workspace-write | danger-full-access
  DSH_SESSIONS_ROOT     Directory path for session persistence (default: ./.sessions)
`)
  process.exit(0)
}

// Session state management
const sessionStates = new Map<string, SessionState>()
let latestState: SessionState | undefined
const pendingPromptSessions = new Map<string | number, string>()

function getSessionState(sessionId?: string): SessionState {
  if (sessionId && sessionStates.has(sessionId)) {
    const s = sessionStates.get(sessionId)!
    latestState = s
    return s
  }
  if (sessionId) {
    const s: SessionState = {
      sessionId,
      cwd: process.cwd(),
      model: latestState?.model ?? DEFAULT_MODEL,
      effort: latestState?.effort ?? DEFAULT_EFFORT,
    }
    sessionStates.set(sessionId, s)
    latestState = s
    return s
  }
  if (latestState) return latestState
  const s: SessionState = {
    sessionId: 'default',
    cwd: process.cwd(),
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
  }
  latestState = s
  return s
}

const originalStdoutWrite = process.stdout.write.bind(process.stdout)

function handleSetConfigOption(msg: any) {
  const { id, params } = msg
  const sessionId = params?.sessionId
  const configId = params?.configId
  const value = params?.value

  if (sessionId) {
    const state = getSessionState(sessionId)
    if (configId === 'model' && typeof value === 'string') {
      state.model = value
    } else if (configId === 'effort' && typeof value === 'string') {
      state.effort = value
    }
    originalStdoutWrite(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          configOptions: buildConfigOptions(state),
        },
      }) + '\n'
    )
  } else {
    originalStdoutWrite(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: 'Missing sessionId in params',
        },
      }) + '\n'
    )
  }
}

function augmentPromptResult(parsed: any) {
  if (parsed?.result && parsed.result.stopReason) {
    const sessionId =
      (parsed.id !== undefined ? pendingPromptSessions.get(parsed.id) : undefined) ||
      latestState?.sessionId ||
      'default'
    if (parsed.id !== undefined) {
      pendingPromptSessions.delete(parsed.id)
    }
    const { usage, metrics } = metricsCollector.finishPromptTurn(sessionId)
    parsed.result.usage = usage
    parsed.result._meta = {
      ...(parsed.result._meta ?? {}),
      metrics,
    }
  }
}

let cordisCtx: any
const activeSessionHandles = new Map<string, any>()

function isResumedSession(sessionId: string): boolean {
  return activeSessionHandles.has(sessionId)
}

function createUserMessage(text: string) {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function acpPromptToText(prompt: any): string {
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) {
    return prompt
      .map((block: any) => {
        if (typeof block === 'string') return block
        if (block?.type === 'text') return block.text || ''
        if (block?.type === 'resource_link') return block.uri || block.name || ''
        return ''
      })
      .join('\n')
  }
  return ''
}

async function handleSessionResume(msg: any) {
  const { id, params } = msg
  const sessionId = params?.sessionId
  const cwd = params?.cwd || process.cwd()
  if (!sessionId) {
    originalStdoutWrite(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Missing sessionId in params' },
      }) + '\n'
    )
    return
  }

  const state = getSessionState(sessionId)
  state.cwd = cwd

  try {
    let agent = cordisCtx?.agents?.get?.(sessionId)
    if (!agent && cordisCtx?.agents) {
      try {
        const handle = await cordisCtx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: {
            provider: 'deepseek-official',
            model: state.model,
          },
        })
        agent = handle?.agent
        if (handle) activeSessionHandles.set(sessionId, handle)
      } catch {
        const handle = await cordisCtx.agents.create({
          sessionId,
          meta: { cwd },
          agentOptions: {
            provider: 'deepseek-official',
            model: state.model,
          },
        })
        agent = handle?.agent
        if (handle) activeSessionHandles.set(sessionId, handle)
      }
    }

    originalStdoutWrite(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId,
          configOptions: buildConfigOptions(state),
        },
      }) + '\n'
    )
  } catch (err: any) {
    originalStdoutWrite(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `Failed to resume session: ${err?.message || String(err)}`,
        },
      }) + '\n'
    )
  }
}

async function handleSessionPrompt(msg: any) {
  const { id, params } = msg
  const sessionId = params?.sessionId
  const agent = cordisCtx?.agents?.get?.(sessionId)

  if (!agent) {
    originalStdoutWrite(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `unknown session: ${sessionId}` },
      }) + '\n'
    )
    return
  }

  metricsCollector.startPromptTurn(sessionId)

  const text = acpPromptToText(params.prompt)
  const message = createUserMessage(text)

  try {
    agent.followup(message)
    await agent.whenIdle()

    const { usage, metrics } = metricsCollector.finishPromptTurn(sessionId)
    originalStdoutWrite(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          stopReason: 'end_turn',
          usage,
          _meta: { metrics },
        },
      }) + '\n'
    )
  } catch (err: any) {
    originalStdoutWrite(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `Prompt turn failed: ${err?.message || String(err)}`,
        },
      }) + '\n'
    )
  }
}

function handleIncomingStdinMessage(parsed: any): boolean {
  if (parsed && parsed.method === 'session/set_config_option') {
    handleSetConfigOption(parsed)
    return true
  }
  if (parsed && (parsed.method === 'session/resume' || parsed.method === 'session/load')) {
    handleSessionResume(parsed)
    return true
  }
  if (parsed && parsed.method === 'session/cancel' && parsed.params?.sessionId) {
    const agent = cordisCtx?.agents?.get?.(parsed.params.sessionId)
    if (agent) {
      agent.cancel({ kind: 'user' })
    }
  }
  if (parsed && parsed.method === 'session/prompt' && parsed.params?.sessionId) {
    const promptSessionId = parsed.params.sessionId
    if (isResumedSession(promptSessionId)) {
      handleSessionPrompt(parsed)
      return true
    }
    if (parsed.id !== undefined) {
      pendingPromptSessions.set(parsed.id, promptSessionId)
    }
    metricsCollector.startPromptTurn(promptSessionId)
  }
  return false
}

function wrapStdinWebStream(webStdin: any): any {
  const textDecoder = new TextDecoder()
  const textEncoder = new TextEncoder()
  let buffer = ''

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = webStdin.getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) {
            if (buffer.trim()) {
              try {
                const parsed = JSON.parse(buffer.trim())
                if (handleIncomingStdinMessage(parsed)) {
                  break
                }
              } catch {}
              controller.enqueue(textEncoder.encode(buffer))
            }
            break
          }
          if (!value) continue
          buffer += textDecoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
              const parsed = JSON.parse(trimmed)
              if (handleIncomingStdinMessage(parsed)) {
                continue
              }
            } catch {}
            controller.enqueue(textEncoder.encode(line + '\n'))
          }
        }
      } catch (err) {
        controller.error(err)
      } finally {
        reader.releaseLock()
        controller.close()
      }
    },
  })
}

function wrapStdoutWebStream(webStdout: any): any {
  const textDecoder = new TextDecoder()
  const textEncoder = new TextEncoder()
  let buffer = ''

  const writer = webStdout.getWriter()
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      buffer += textDecoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) {
          await writer.write(textEncoder.encode(line + '\n'))
          continue
        }
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed?.result?.agentCapabilities) {
            parsed.result.agentCapabilities = {
              ...parsed.result.agentCapabilities,
              sessionCapabilities: {
                resume: true,
                list: true,
              },
              loadSession: true,
            }
            await writer.write(textEncoder.encode(JSON.stringify(parsed) + '\n'))
            continue
          }
          if (parsed?.result?.sessionId) {
            const state = getSessionState(parsed.result.sessionId)
            parsed.result.configOptions = buildConfigOptions(state)
            await writer.write(textEncoder.encode(JSON.stringify(parsed) + '\n'))
            continue
          }
          if (parsed?.result?.stopReason) {
            augmentPromptResult(parsed)
            await writer.write(textEncoder.encode(JSON.stringify(parsed) + '\n'))
            continue
          }
          if (
            parsed?.method === 'session/update' &&
            parsed.params?.update?.sessionUpdate === 'agent_message_chunk'
          ) {
            // Suppress stock whole-message batch chunks to prevent duplicate text
            continue
          }
        } catch {}
        await writer.write(textEncoder.encode(line + '\n'))
      }
    },
    async close() {
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim())
          if (parsed?.result?.sessionId) {
            const state = getSessionState(parsed.result.sessionId)
            parsed.result.configOptions = buildConfigOptions(state)
            await writer.write(textEncoder.encode(JSON.stringify(parsed) + '\n'))
          } else if (parsed?.result?.stopReason) {
            augmentPromptResult(parsed)
            await writer.write(textEncoder.encode(JSON.stringify(parsed) + '\n'))
          } else if (
            parsed?.method === 'session/update' &&
            parsed.params?.update?.sessionUpdate === 'agent_message_chunk'
          ) {
            // Suppress stock whole-message batch chunks
          } else {
            await writer.write(textEncoder.encode(buffer))
          }
        } catch {
          await writer.write(textEncoder.encode(buffer))
        }
      }
      await writer.close()
    },
    async abort(reason) {
      await writer.abort(reason)
    },
  })
}

// Hook into Readable.toWeb and Writable.toWeb
const originalReadableToWeb = Readable.toWeb.bind(Readable)
const originalWritableToWeb = Writable.toWeb.bind(Writable)

Readable.toWeb = function (stream: any) {
  const webStream = originalReadableToWeb(stream)
  if (stream === process.stdin) {
    return wrapStdinWebStream(webStream)
  }
  return webStream
} as any

Writable.toWeb = function (stream: any) {
  const webStream = originalWritableToWeb(stream)
  if (stream === process.stdout) {
    return wrapStdoutWebStream(webStream)
  }
  return webStream
} as any

const bundledDefaultConfig = resolve(currentDir, '../assets/cordis.default.yml')

let configToLoad: string
if (typeof values.config === 'string') {
  configToLoad = resolveConfigPath(values.config, undefined)
} else if (existsSync(resolve(process.cwd(), 'cordis.yml'))) {
  configToLoad = resolve(process.cwd(), 'cordis.yml')
} else {
  configToLoad = bundledDefaultConfig
}

await boot(NAME, configToLoad, undefined, (ctx: any) => {
  cordisCtx = ctx
  ctx.provide('launchEnvironment', env)

  ctx.on('session/event', (session: any, event: any) => {
    const sessionId = session?.header?.id || session?.id || latestState?.sessionId
    if (sessionId) {
      metricsCollector.recordEvent(sessionId, event)
    }

    if (!sessionId) return

    // 1. Live stream text & reasoning chunks
    if (event.type === 'assistant/chunk') {
      const chunk = event.data?.chunk
      if (!chunk) return

      if (
        chunk.type === 'reasoning-delta' ||
        chunk.reasoning ||
        (chunk.type === 'thinking' && chunk.text)
      ) {
        const text = chunk.text || chunk.reasoning || chunk.content || ''
        if (text) {
          originalStdoutWrite(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId,
                update: {
                  sessionUpdate: 'agent_thought_chunk',
                  content: { type: 'text', text },
                },
              },
            }) + '\n'
          )
        }
      } else if (
        chunk.type === 'text-delta' ||
        chunk.text ||
        (chunk.type === 'content' && chunk.text)
      ) {
        const text = chunk.text || chunk.content || ''
        if (text) {
          originalStdoutWrite(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text },
                },
              },
            }) + '\n'
          )
        }
      }
    }

    // 2. Tool calls
    if (event.type === 'tool/call') {
      const callData = event.data
      const toolCallId = callData?.callId || callData?.id || `call_${Date.now()}`
      const toolName = callData?.name || callData?.tool || 'tool'
      const rawInput =
        typeof callData?.arguments === 'string'
          ? (() => {
              try {
                return JSON.parse(callData.arguments)
              } catch {
                return { input: callData.arguments }
              }
            })()
          : callData?.arguments || {}

      originalStdoutWrite(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: toolName,
              rawInput,
              status: 'in_progress',
            },
          },
        }) + '\n'
      )
    }

    // 3. Tool results
    if (event.type === 'tool/result') {
      const resultData = event.data
      const message = resultData?.message
      const toolCallId = message?.callId || resultData?.callId || resultData?.id
      const isError = Boolean(message?.isError || resultData?.error || resultData?.isError)

      let rawOutput: any = ''
      let outputText = ''
      if (Array.isArray(message?.content)) {
        outputText = message.content
          .map((b: any) => (b.type === 'text' ? b.text : JSON.stringify(b)))
          .join('\n')
        rawOutput = outputText
      } else if (resultData?.output !== undefined) {
        rawOutput = resultData.output
        outputText = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput)
      } else if (resultData?.error) {
        rawOutput = resultData.error
        outputText = String(resultData.error.message || resultData.error)
      }

      originalStdoutWrite(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: isError ? 'failed' : 'completed',
              rawOutput,
              content: [{ type: 'text', text: outputText }],
            },
          },
        }) + '\n'
      )
    }
  })

  ctx.on('system-prompt/assemble', async (assembly: any, context: any, next: any) => {
    const assembled = await (typeof next === 'function' ? next() : assembly)
    const sessionId = context?.agent?.session?.id || context?.agent?.id || context?.scope?.session?.id
    const state = getSessionState(sessionId)
    if (assembled && assembled.variables) {
      assembled.variables.model = state.model
      assembled.variables.provider = 'deepseek-official'
    }
    return assembled
  })

  ctx.on('agent/request', async (payload: any, next: any) => {
    const resolved = await (typeof next === 'function' ? next() : payload)
    const sessionId = payload?.agent?.session?.id || payload?.agent?.id
    const state = getSessionState(sessionId)
    return {
      ...resolved,
      model: state.model,
      ...(state.effort ? { reasoningEffort: state.effort } : {}),
    }
  })
})
