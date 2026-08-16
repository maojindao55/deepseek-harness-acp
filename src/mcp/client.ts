/**
 * MCP Client Connection Manager for DeepSeek Harness ACP.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpServerConfig, McpToolCallResult } from './types.js'
import { sanitizeMcpToolParameters } from './schema.js'

export interface RegisteredToolInfo {
  originalName: string
  registeredName: string
  serverName: string
  description: string
  dispose: () => void
}

export class McpClientConnection {
  readonly name: string
  readonly config: McpServerConfig
  private client?: Client
  private transport?: StdioClientTransport | SSEClientTransport
  private registeredTools: Map<string, RegisteredToolInfo> = new Map()
  private _status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  private lastError?: Error

  constructor(name: string, config: McpServerConfig) {
    this.name = name
    this.config = config
  }

  get status() {
    return this._status
  }

  get error() {
    return this.lastError
  }

  get tools(): ReadonlyMap<string, RegisteredToolInfo> {
    return this.registeredTools
  }

  async connect(): Promise<void> {
    if (this._status === 'connected' && this.client) {
      return
    }

    this._status = 'connecting'
    this.lastError = undefined

    try {
      this.client = new Client(
        {
          name: `deepseek-harness-acp:${this.name}`,
          version: '0.1.9',
        },
        {
          capabilities: {
            roots: {},
            sampling: {},
          },
        }
      )

      const transportType =
        this.config.transport ?? (this.config.url ? 'sse' : 'stdio')

      if (transportType === 'stdio') {
        const command = this.config.command
        if (!command) {
          throw new Error(`MCP Server "${this.name}" stdio transport requires a 'command'`)
        }

        let envObj: Record<string, string> = {}
        if (Array.isArray(this.config.env)) {
          for (const item of this.config.env as any[]) {
            if (item && item.name) {
              envObj[item.name] = String(item.value ?? '')
            }
          }
        } else if (this.config.env && typeof this.config.env === 'object') {
          envObj = this.config.env as Record<string, string>
        }

        const env = {
          ...process.env,
          ...envObj,
        }

        this.transport = new StdioClientTransport({
          command,
          args: this.config.args || [],
          env: env as Record<string, string>,
          cwd: this.config.cwd || process.cwd(),
          stderr: 'inherit',
        })

      } else if (transportType === 'sse' || transportType === 'http') {
        const urlStr = this.config.url
        if (!urlStr) {
          throw new Error(`MCP Server "${this.name}" sse transport requires a 'url'`)
        }
        const url = new URL(urlStr)
        this.transport = new SSEClientTransport(url, {
          eventSourceInit: this.config.headers ? ({ headers: this.config.headers } as any) : undefined,
          requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
        })
      } else {

        throw new Error(`Unsupported MCP transport "${transportType}" for server "${this.name}"`)
      }

      await this.client.connect(this.transport)
      this._status = 'connected'
    } catch (err: any) {
      this._status = 'error'
      this.lastError = err instanceof Error ? err : new Error(String(err))
      await this.disconnect()
      throw this.lastError
    }
  }

  /**
   * Discover and register all tools from this MCP server into DeepSeek Harness ToolRuntime.
   */
  async registerTools(toolsService: any): Promise<RegisteredToolInfo[]> {
    if (!this.client || this._status !== 'connected') {
      throw new Error(`MCP Server "${this.name}" is not connected`)
    }

    const { tools } = await this.client.listTools()
    const registered: RegisteredToolInfo[] = []

    for (const tool of tools) {
      const originalName = tool.name
      const prefix = this.config.prefix ?? ''
      const registeredName = prefix ? `${prefix}${originalName}` : originalName
      const description = tool.description || `Tool "${originalName}" provided by MCP server "${this.name}"`
      const parameters = sanitizeMcpToolParameters(tool.inputSchema)

      const serverName = this.name
      const client = this.client

      const toolDefinition = {
        name: registeredName,
        description,
        parameters,
        output: {
          schema: {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
          render(_args: any, value: any) {
            if (value && typeof value === 'object' && Array.isArray(value.content)) {
              return value.content.map((b: any) => {
                if (b.type === 'text') {
                  return { type: 'text', text: b.text || '' }
                }
                if (b.type === 'image') {
                  const mime = b.mimeType || 'image/png'
                  return { type: 'text', text: `[Screenshot / Image (${mime}) captured successfully]` }
                }
                if (b.type === 'resource') {
                  const uri = b.resource?.uri || b.resource?.name || 'resource'
                  const text = b.resource?.text || ''
                  return { type: 'text', text: `[Resource: ${uri}]\n${text}` }
                }
                return { type: 'text', text: typeof b === 'string' ? b : JSON.stringify(b) }
              })
            }
            return [
              {
                type: 'text',
                text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
              },
            ]
          },

          presentationMeta(_args: any, value: any) {
            return value
          },
        },
        timeoutMs: this.config.timeoutMs,
        presentCall(args: any) {
          return {
            card: 'generic',
            title: `${serverName}: ${originalName}`,
            kind: 'other',
            rawInput: args,
          }
        },
        async execute(args: any, exec: any) {
          try {
            const result: McpToolCallResult = await client.callTool(
              {
                name: originalName,
                arguments: typeof args === 'object' && args !== null ? args : {},
              },
              undefined,
              { signal: exec.signal }
            )

            if (result.isError) {
              const errMsg =
                result.content
                  ?.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
                  .join('\n') || `MCP tool "${originalName}" returned an error`
              throw new Error(errMsg)
            }

            return result
          } catch (err: any) {
            throw new Error(`MCP tool "${originalName}" execution failed: ${err?.message || String(err)}`)
          }
        },
      }

      const disposer = toolsService.register(toolDefinition)
      const toolInfo: RegisteredToolInfo = {
        originalName,
        registeredName,
        serverName: this.name,
        description,
        dispose: () => {
          try {
            disposer()
          } catch {}
          this.registeredTools.delete(registeredName)
        },
      }

      this.registeredTools.set(registeredName, toolInfo)
      registered.push(toolInfo)
    }

    return registered
  }

  async disconnect(): Promise<void> {
    for (const tool of this.registeredTools.values()) {
      try {
        tool.dispose()
      } catch {}
    }
    this.registeredTools.clear()

    if (this.transport) {
      try {
        await this.transport.close()
      } catch {}
      this.transport = undefined
    }

    if (this.client) {
      try {
        await this.client.close()
      } catch {}
      this.client = undefined
    }

    this._status = 'disconnected'
  }
}
