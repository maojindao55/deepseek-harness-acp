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
                if (parsed && parsed.method === 'session/set_config_option') {
                  handleSetConfigOption(parsed)
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
              if (parsed && parsed.method === 'session/set_config_option') {
                handleSetConfigOption(parsed)
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
          if (parsed?.result?.sessionId) {
            const state = getSessionState(parsed.result.sessionId)
            parsed.result.configOptions = buildConfigOptions(state)
            await writer.write(textEncoder.encode(JSON.stringify(parsed) + '\n'))
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
  ctx.provide('launchEnvironment', env)

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
