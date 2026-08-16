import { describe, it, expect, afterEach } from 'vitest'
import { resolve } from 'node:path'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { McpClientConnection } from '../src/mcp/client.js'
import { McpManager } from '../src/mcp/manager.js'

describe('MCP Subsystem Integration Test', () => {
  let ctx: Context
  let manager: McpManager
  const mockServerScript = resolve(__dirname, 'fixtures/mock-mcp-server.ts')

  afterEach(async () => {
    if (manager) {
      await manager.closeAll()
    }
  })

  it('connects to stdio MCP server, discovers tools, and executes tool call', async () => {
    ctx = new Context()
    ctx.provide('systemPrompt')
    ctx.systemPrompt = { tools: () => {}, section: () => {} }
    const toolsService = new ToolRuntime(ctx)


    expect(toolsService).toBeDefined()

    const connection = new McpClientConnection('mock-server', {
      command: 'npx',
      args: ['tsx', mockServerScript],
      prefix: 'mock_',
    })

    await connection.connect()
    expect(connection.status).toBe('connected')

    const registered = await connection.registerTools(toolsService)
    expect(registered).toHaveLength(2)
    expect(registered.map((r) => r.registeredName)).toEqual(['mock_echo_message', 'mock_add_numbers'])

    // Verify tools are in ToolRuntime registry
    const echoTool = toolsService.get('mock_echo_message')
    expect(echoTool).toBeDefined()
    expect(echoTool.description).toBe('Echoes back a message')

    // Execute tool
    const controller = new AbortController()
    const result: any = await echoTool.execute({ text: 'Hello DeepSeek MCP' }, { signal: controller.signal })
    expect(result).toBeDefined()
    expect(result.content).toEqual([{ type: 'text', text: 'Echo: Hello DeepSeek MCP' }])

    // Execute second tool
    const addTool = toolsService.get('mock_add_numbers')
    expect(addTool).toBeDefined()
    const addResult: any = await addTool.execute({ a: 15, b: 27 }, { signal: controller.signal })
    expect(addResult.content).toEqual([{ type: 'text', text: 'Result: 42' }])

    // Disconnect and verify tools are unregistered
    await connection.disconnect()
    expect(connection.status).toBe('disconnected')
    expect(toolsService.get('mock_echo_message')).toBeUndefined()
  })

  it('manages multiple servers and supports workspace config discovery', async () => {
    ctx = new Context()
    ctx.provide('systemPrompt')
    ctx.systemPrompt = { tools: () => {}, section: () => {} }
    const toolsService = new ToolRuntime(ctx)

    manager = new McpManager(toolsService)


    // 1. Create a temporary .mcp.json in a test folder
    const tempConfigPath = resolve(__dirname, '.mcp.json')
    writeFileSync(
      tempConfigPath,
      JSON.stringify({
        mcpServers: {
          calc: {
            command: 'npx',
            args: ['tsx', mockServerScript],
            prefix: 'calc_',
          },
        },
      }),
      'utf8'
    )

    try {
      // 2. Discover workspace configuration
      const tools = await manager.loadWorkspaceMcp(__dirname)
      expect(tools.length).toBeGreaterThan(0)
      expect(toolsService.get('calc_add_numbers')).toBeDefined()

      const controller = new AbortController()
      const res: any = await toolsService.get('calc_add_numbers').execute({ a: 100, b: 200 }, { signal: controller.signal })
      expect(res.content).toEqual([{ type: 'text', text: 'Result: 300' }])

      // 3. Clean up
      await manager.closeAll()
      expect(toolsService.get('calc_add_numbers')).toBeUndefined()
    } finally {
      if (existsSync(tempConfigPath)) {
        unlinkSync(tempConfigPath)
      }
    }
  })
})
