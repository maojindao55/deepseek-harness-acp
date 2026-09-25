#!/usr/bin/env node
import { parseArgs, parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { boot, installFailLoud, loadEnv, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as Acp from '@deepseek-ai/dsh-acp'
import { createBridge } from './bridge.js'
import { DEFAULT_MODEL } from './models.js'

const name = 'deepseek-harness-acp'
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

function userEnvFile() {
  const configured = process.env.DSH_HOME?.trim()
  const home = configured
    ? resolve(configured === '~' ? homedir() : configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured)
    : resolve(homedir(), '.dsh')
  return resolve(home, '.env')
}

async function runSetup() {
  const file = userEnvFile()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let key = ''
  try {
    key = (await rl.question('DeepSeek API key (https://platform.deepseek.com/api_keys): ')).trim()
  } finally {
    rl.close()
  }
  if (!key) {
    console.error('No API key entered; nothing was written.')
    process.exitCode = 1
    return
  }
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  const kept = lines.filter((line) => line.trim() && !/^\s*DEEPSEEK_API_KEY\s*=/.test(line))
  kept.push(`DEEPSEEK_API_KEY=${key}`)
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, kept.join('\n') + '\n', { mode: 0o600 })
  console.log(`Saved DEEPSEEK_API_KEY to ${file}`)
}

const { values } = parseArgs({
  options: { config: { type: 'string', short: 'c' }, help: { type: 'boolean', short: 'h' },
    setup: { type: 'boolean' }, version: { type: 'boolean', short: 'v' } }, allowPositionals: true,
})
if (values.version || process.argv[2] === 'version') {
  console.log(version)
} else if (values.help) {
  console.log(`DeepSeek Harness ACP ${version}
Usage: dsh-acp [-c cordis.yml] [--setup]
Requires Node.js 24+. Harness: 0.1.6-alpha.2
Environment: DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL,
DEEPSEEK_PROTOCOL (messages | chat-completions), DSH_PERMISSION_MODE,
DSH_SESSIONS_ROOT (default: ./.sessions).
--setup prompts for DEEPSEEK_API_KEY and stores it in ~/.dsh/.env ($DSH_HOME respected).
A custom --config supplies the complete Harness core; this executable mounts ACP.`)
} else if (values.setup) {
  await runSetup()
} else {
  installFailLoud(name)
  const env = loadEnv(name)
  const userEnv = userEnvFile()
  if (existsSync(userEnv)) {
    for (const [key, value] of Object.entries(parseEnv(readFileSync(userEnv, 'utf8')))) {
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
  const custom = values.config ?? (existsSync(resolve('cordis.yml')) ? resolve('cordis.yml') : undefined)
  const config = custom ? resolve(custom) : fileURLToPath(new URL('../assets/cordis.default.yml', import.meta.url))
  const patches = custom ? [] : [
    ...loadOverlayPatches(name, fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'))),
    ...loadOverlayPatches(name, fileURLToPath(new URL('../assets/standalone.patch.yml', import.meta.url))),
  ]
  let bridge: ReturnType<typeof createBridge> | undefined
  const ctx = await boot(name, config, patches, (root) => {
    root.provide('launchEnvironment', env)
    root.plugin({
      name: 'standalone-acp',
      inject: [...Acp.inject, 'sessionQuery', 'attachments'],
      apply(acpCtx) {
        bridge = createBridge(acpCtx, version)
        Acp.apply(acpCtx, {
          provider: 'deepseek-official',
          model: DEFAULT_MODEL,
          stream: bridge.stream,
        })
      },
    })
  }, import.meta.url)
  let stopping: Promise<void> | undefined
  const shutdown = () => stopping ??= ctx.fiber.dispose().catch((error: unknown) => {
    console.error(error); process.exitCode = 1
  })
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  bridge?.closed.then(shutdown).catch((error) => { console.error(error); void shutdown() })
}

