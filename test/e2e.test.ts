import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

describe('End-to-End ACP Server Process Test', () => {
  it('starts server, initializes, creates session and receives config options', async () => {
    const binPath = resolve(__dirname, '../src/bin.ts')
    const child = spawn('npx', ['tsx', binPath], {
      cwd: resolve(__dirname, '..'),
      env: {
        ...process.env,
        DSH_PERMISSION_MODE: 'danger-full-access',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const messages: any[] = []

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean)
      for (const line of lines) {
        try {
          messages.push(JSON.parse(line))
        } catch {}
      }
    })

    // 1. Send initialize
    const initMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
      },
    }) + '\n'
    child.stdin.write(initMsg)

    // Wait for initialize response
    await new Promise((r) => setTimeout(r, 1500))

    const initRes = messages.find((m) => m.id === 1)
    expect(initRes).toBeDefined()
    expect(initRes.result.protocolVersion).toBe(1)

    // 2. Send session/new
    const newSessionMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: {
        cwd: process.cwd(),
        mcpServers: [],
      },
    }) + '\n'
    child.stdin.write(newSessionMsg)

    // Wait for newSession response
    await new Promise((r) => setTimeout(r, 1500))

    const sessionRes = messages.find((m) => m.id === 2)
    expect(sessionRes).toBeDefined()
    expect(sessionRes.result.sessionId).toBeDefined()
    // Verify configOptions are augmented by our server wrapper
    expect(sessionRes.result.configOptions).toBeDefined()
    expect(sessionRes.result.configOptions.length).toBeGreaterThan(0)

    // 3. Send session/set_config_option
    const setConfigMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/set_config_option',
      params: {
        sessionId: sessionRes.result.sessionId,
        configId: 'model',
        value: 'deepseek-v4-flash',
      },
    }) + '\n'
    child.stdin.write(setConfigMsg)

    await new Promise((r) => setTimeout(r, 1000))

    const configRes = messages.find((m) => m.id === 3)
    expect(configRes).toBeDefined()
    const modelOpt = configRes.result.configOptions.find((o: any) => o.id === 'model')
    expect(modelOpt.currentValue).toBe('deepseek-v4-flash')

    child.kill('SIGTERM')
  }, 15000)
})
