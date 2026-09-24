#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { boot, installFailLoud, loadEnv, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as Acp from '@deepseek-ai/dsh-acp'
import { createBridge } from './bridge.js'
import { DEFAULT_MODEL } from './models.js'

const name = 'deepseek-harness-acp'
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const { values } = parseArgs({
  options: { config: { type: 'string', short: 'c' }, help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' } }, allowPositionals: true,
})
if (values.version || process.argv[2] === 'version') {
  console.log(version)
} else if (values.help) {
  console.log(`DeepSeek Harness ACP ${version}
Usage: dsh-acp [-c cordis.yml]
Requires Node.js 24+. Harness: 0.1.6-alpha.2
Environment: DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL,
DEEPSEEK_PROTOCOL (messages | chat-completions), DSH_PERMISSION_MODE,
DSH_SESSIONS_ROOT (default: ./.sessions).
A custom --config supplies the complete Harness core; this executable mounts ACP.`)
} else {
  installFailLoud(name)
  const env = loadEnv(name)
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

