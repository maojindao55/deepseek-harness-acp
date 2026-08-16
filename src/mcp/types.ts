/**
 * Types and interfaces for Model Context Protocol (MCP) support in DeepSeek Harness ACP.
 */

export type McpTransportType = 'stdio' | 'sse' | 'http'

export interface McpServerConfig {
  /** Identifier name for the MCP server */
  name?: string
  /** Transport mechanism: 'stdio' | 'sse' | 'http'. Defaults to 'stdio' if command is provided, or 'sse' if url is provided. */
  transport?: McpTransportType
  /** Executable command for stdio transport (e.g. 'node', 'npx', 'python', 'docker') */
  command?: string
  /** Arguments for the executable command */
  args?: string[]
  /** Environment variables to pass to the child process (object or array format) */
  env?: Record<string, string> | Array<{ name: string; value: string }>

  /** Working directory for the stdio process */
  cwd?: string
  /** Server URL for SSE / HTTP transport */
  url?: string
  /** HTTP headers for SSE / HTTP transport */
  headers?: Record<string, string>
  /** Whether this server is enabled (defaults to true) */
  enabled?: boolean
  /** Request timeout in milliseconds */
  timeoutMs?: number
  /** Tool name prefix to avoid naming collisions (e.g. 'mcp_' or 'github_') */
  prefix?: string
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig> | McpServerConfig[]
}

export interface McpToolCallResult {
  content?: Array<{
    type: string
    text?: string
    data?: string
    mimeType?: string
    resource?: any
    [key: string]: any
  }>
  isError?: boolean
  [key: string]: any
}
