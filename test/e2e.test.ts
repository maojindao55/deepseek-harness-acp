import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

describe('End-to-End ACP Server Process Test', () => {
  it('starts server, initializes, creates session and receives config options', async () => {
    const binPath = resolve(__dirname, '../src/bin.ts')
    const isWin = process.platform === 'win32'
    const child = spawn(isWin ? 'npx.cmd' : 'npx', ['tsx', binPath], {
      cwd: resolve(__dirname, '..'),
      env: {
        ...process.env,
        DSH_PERMISSION_MODE: 'danger-full-access',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin,
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

    const waitForMessage = (id: number, timeout = 8000) =>
      new Promise<any>((resolve, reject) => {
        const start = Date.now()
        const check = () => {
          const hit = messages.find((m) => m.id === id)
          if (hit) return resolve(hit)
          if (Date.now() - start > timeout) return reject(new Error(`Timeout waiting for message id=${id}`))
          setTimeout(check, 50)
        }
        check()
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

    const initRes = await waitForMessage(1)
    expect(initRes).toBeDefined()
    expect(initRes.result.protocolVersion).toBe(1)
    expect(initRes.result.agentCapabilities.sessionCapabilities.resume).toBe(true)
    expect(initRes.result.agentCapabilities.loadSession).toBe(true)

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

    const sessionRes = await waitForMessage(2)
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

    const configRes = await waitForMessage(3)
    expect(configRes).toBeDefined()
    const modelOpt = configRes.result.configOptions.find((o: any) => o.id === 'model')
    expect(modelOpt.currentValue).toBe('deepseek-v4-flash')

    // 4. Send session/resume with a specific sessionId
    const resumeSessionId = 'e2e-resumed-session-' + Date.now()
    const resumeMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/resume',
      params: {
        sessionId: resumeSessionId,
        cwd: process.cwd(),
      },
    }) + '\n'
    child.stdin.write(resumeMsg)
    await waitForMessage(4)

    // 5. Send session/list
    const listMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'session/list',
      params: {
        cwd: process.cwd(),
      },
    }) + '\n'
    child.stdin.write(listMsg)

    const listRes = await waitForMessage(5)
    expect(listRes).toBeDefined()
    expect(Array.isArray(listRes.result.sessions)).toBe(true)
    expect(listRes.result.sessions.some((s: any) => s.sessionId === resumeSessionId)).toBe(true)

    // 6. Send session/load with MCP servers
    const loadSessionId = 'e2e-loaded-session-' + Date.now()
    const mockServerScript = resolve(__dirname, 'fixtures/mock-mcp-server.ts')
    const loadMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 6,
      method: 'session/load',
      params: {
        sessionId: loadSessionId,
        cwd: process.cwd(),
        mcpServers: [
          {
            name: 'mock-load-server',
            command: 'npx',
            args: ['tsx', mockServerScript],
            prefix: 'mcp_load_',
          },
        ],
      },
    }) + '\n'
    child.stdin.write(loadMsg)

    const loadRes = await waitForMessage(6)
    expect(loadRes).toBeDefined()
    expect(loadRes.result.sessionId).toBe(loadSessionId)

    child.kill('SIGTERM')
  }, 20000)
})
