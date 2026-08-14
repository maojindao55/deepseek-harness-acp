#!/usr/bin/env node
/**
 * Standalone executable entry for DeepSeek Harness ACP Server.
 * Supports zero-config startup by falling back to bundled default configuration.
 */

import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'deepseek-harness-acp'
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
  -v, --version         Show version

Environment Variables:
  DEEPSEEK_API_KEY      DeepSeek API key (required)
  DEEPSEEK_BASE_URL     Optional API base URL override
  DSH_PERMISSION_MODE   Permission mode: workspace-write | danger-full-access
  DSH_SESSIONS_ROOT     Directory path for session persistence (default: ./.sessions)
`)
  process.exit(0)
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const bundledDefaultConfig = resolve(currentDir, '../assets/cordis.default.yml')

let configToLoad: string
if (typeof values.config === 'string') {
  configToLoad = resolveConfigPath(values.config, undefined)
} else if (existsSync(resolve(process.cwd(), 'cordis.yml'))) {
  configToLoad = resolve(process.cwd(), 'cordis.yml')
} else {
  configToLoad = bundledDefaultConfig
}

await boot(NAME, configToLoad, undefined, (ctx) => {
  ctx.provide('launchEnvironment', env)
})
