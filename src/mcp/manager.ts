/**
 * MCP Manager: orchestrates multiple MCP server connections, workspace discovery, and tool registration.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { McpClientConnection, type RegisteredToolInfo } from './client.js'
import type { McpConfigFile, McpServerConfig } from './types.js'

export class McpManager {
  private connections: Map<string, McpClientConnection> = new Map()
  private toolsService?: any
  private loadedWorkspacePaths: Set<string> = new Set()

  constructor(toolsService?: any) {
    this.toolsService = toolsService
  }

  setToolsService(toolsService: any) {
    this.toolsService = toolsService
  }

  get activeConnections(): ReadonlyMap<string, McpClientConnection> {
    return this.connections
  }

  /**
   * Add or update an MCP server configuration and connect.
   */
  async addServer(name: string, config: McpServerConfig): Promise<RegisteredToolInfo[]> {
    if (config.enabled === false) {
      await this.removeServer(name)
      return []
    }

    if (!config.name) {
      config.name = name
    }

    // Disconnect existing if present
    if (this.connections.has(name)) {
      await this.removeServer(name)
    }

    const connection = new McpClientConnection(name, config)
    this.connections.set(name, connection)

    try {
      await connection.connect()
      if (this.toolsService) {
        return await connection.registerTools(this.toolsService)
      }
      return []
    } catch (err: any) {
      console.error(`[MCP] Failed to connect server "${name}":`, err?.message || String(err))
      return []
    }
  }

  /**
   * Remove and disconnect an MCP server.
   */
  async removeServer(name: string): Promise<void> {
    const connection = this.connections.get(name)
    if (connection) {
      await connection.disconnect()
      this.connections.delete(name)
    }
  }

  /**
   * Load MCP servers from a configuration object.
   */
  async loadServers(config?: McpConfigFile | Record<string, McpServerConfig> | McpServerConfig[]): Promise<RegisteredToolInfo[]> {
    if (!config) return []

    const results: RegisteredToolInfo[] = []
    let serversMap: Record<string, McpServerConfig> = {}

    if (Array.isArray(config)) {
      for (const [index, server] of config.entries()) {
        const name = server.name || `mcp_server_${index + 1}`
        serversMap[name] = server
      }
    } else if (typeof config === 'object') {
      if ('mcpServers' in config && config.mcpServers) {
        if (Array.isArray(config.mcpServers)) {
          for (const [index, server] of config.mcpServers.entries()) {
            const name = server.name || `mcp_server_${index + 1}`
            serversMap[name] = server
          }
        } else if (typeof config.mcpServers === 'object') {
          serversMap = config.mcpServers as Record<string, McpServerConfig>
        }
      } else {
        serversMap = config as Record<string, McpServerConfig>
      }
    }

    for (const [name, serverConfig] of Object.entries(serversMap)) {
      if (serverConfig && typeof serverConfig === 'object') {
        const registered = await this.addServer(name, serverConfig)
        results.push(...registered)
      }
    }

    return results
  }

  /**
   * Automatically discover and load project-level MCP config from workspace directory.
   */
  async loadWorkspaceMcp(cwd: string): Promise<RegisteredToolInfo[]> {
    const normalizedCwd = resolve(cwd)
    if (this.loadedWorkspacePaths.has(normalizedCwd)) {
      return []
    }

    const candidateFiles = [
      join(normalizedCwd, '.mcp.json'),
      join(normalizedCwd, 'mcp.json'),
      join(normalizedCwd, '.cursor', 'mcp.json'),
      join(normalizedCwd, '.vscode', 'mcp.json'),
    ]

    for (const file of candidateFiles) {
      if (existsSync(file)) {
        try {
          const content = readFileSync(file, 'utf8')
          const parsed = JSON.parse(content)
          this.loadedWorkspacePaths.add(normalizedCwd)
          console.error(`[MCP] Loading workspace MCP configuration from ${file}`)
          return await this.loadServers(parsed)
        } catch (err: any) {
          console.error(`[MCP] Failed to parse ${file}:`, err?.message || String(err))
        }
      }
    }

    return []
  }

  /**
   * Handle MCP servers supplied via ACP session initialization / resume parameters.
   */
  async handleSessionMcp(params: { mcpServers?: any; cwd?: string }): Promise<void> {
    const cwd = params.cwd || process.cwd()

    // 1. Load from ACP session parameters if provided
    if (params.mcpServers) {
      await this.loadServers(params.mcpServers)
    }

    // 2. Discover workspace configuration
    if (cwd) {
      await this.loadWorkspaceMcp(cwd)
    }
  }

  /**
   * Disconnect and clean up all servers.
   */
  async closeAll(): Promise<void> {
    for (const connection of this.connections.values()) {
      try {
        await connection.disconnect()
      } catch {}
    }
    this.connections.clear()
    this.loadedWorkspacePaths.clear()
  }
}

export const mcpManager = new McpManager()
