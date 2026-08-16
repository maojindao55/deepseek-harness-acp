/**
 * Cordis Plugin for Model Context Protocol (MCP) integration.
 */

import z from '@deepseek-ai/schemastery'
import { mcpManager } from './manager.js'
import type { McpServerConfig } from './types.js'

export const name = 'mcp'
export const inject = ['tools']

export interface McpPluginConfig {
  /** Map of named MCP servers */
  servers?: Record<string, McpServerConfig>
}

export const Config: z<McpPluginConfig> = z.object({
  servers: z.dict(z.any()).default({}),
})


export function apply(ctx: any, config: any) {
  mcpManager.setToolsService(ctx.tools)

  if (config && config.servers && Object.keys(config.servers).length > 0) {
    mcpManager.loadServers(config.servers).catch((err) => {
      console.error('[MCP Plugin] Failed to load initial servers from config:', err)
    })
  }

  ctx.on('dispose', async () => {
    await mcpManager.closeAll()
  })
}
