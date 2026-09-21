import { existsSync, readFileSync, accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'

function entries(value: unknown): Array<{ name: string; value: string }> {
  if (Array.isArray(value)) return value
  return Object.entries((value ?? {}) as Record<string, string>).map(([name, value]) => ({ name, value: String(value) }))
}

export function resolveCommand(command: string): string {
  if (isAbsolute(command)) return command
  if (command.includes('/') || command.includes('\\')) throw new Error('MCP command must be absolute or a command on PATH')
  const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, command + extension)
      try { accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return candidate } catch {}
    }
  }
  throw new Error(`MCP executable not found on PATH: ${command}`)
}

/** Workspace defaults are merged by name; explicit ACP declarations win. */
export function sessionMcpServers(cwd: string, supplied: any[] = []): McpServer[] {
  const servers = new Map<string, any>()
  for (const filename of ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json']) {
    const path = join(cwd, filename)
    if (!existsSync(path)) continue
    const config = JSON.parse(readFileSync(path, 'utf8'))
    const source = config.mcpServers ?? config.servers ?? {}
    for (const [name, value] of Object.entries(source)) servers.set(name, { ...(value as object), name })
  }
  for (const server of supplied) servers.set(server.name, server)
  return [...servers.values()].filter((s) => s.enabled !== false).map((server) => {
    const transport = server.type ?? server.transport ?? (server.url ? 'http' : 'stdio')
    if (transport === 'sse') throw new Error(`MCP "${server.name}": legacy SSE is unsupported by Harness 0.1.6; configure a Streamable HTTP endpoint`)
    if (transport === 'http' || transport === 'streamable-http') {
      return { type: 'http', name: server.name, url: server.url, headers: entries(server.headers) }
    }
    if (transport !== 'stdio' || typeof server.command !== 'string') throw new Error(`Invalid MCP configuration: ${server.name}`)
    return { name: server.name, command: resolveCommand(server.command), args: server.args ?? [], env: entries(server.env) }
  })
}
