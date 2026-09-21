import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sessionMcpServers, resolveCommand } from '../src/mcp/config.js'

describe('session MCP declarations', () => {
  it('merges workspace defaults and explicit overrides without retaining another workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-config-'))
    try {
      writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
        demo: { command: process.execPath, args: ['old'], env: { TEST: 'one' } },
        disabled: { enabled: false },
      } }))
      const result = sessionMcpServers(root, [{ name: 'demo', command: process.execPath, args: ['new'] }])
      expect(result).toEqual([{ name: 'demo', command: process.execPath, args: ['new'], env: [] }])
      expect(sessionMcpServers(tmpdir())).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('normalizes HTTP headers and rejects unsupported legacy transport explicitly', () => {
    expect(sessionMcpServers(tmpdir(), [{ name: 'remote', url: 'https://example.com/mcp', headers: { Test: 'value' } }]))
      .toEqual([{ type: 'http', name: 'remote', url: 'https://example.com/mcp', headers: [{ name: 'Test', value: 'value' }] }])
    expect(() => sessionMcpServers(tmpdir(), [{ name: 'old', transport: 'sse', url: 'https://example.com/sse' }])).toThrow('legacy SSE')
    expect(resolveCommand(process.execPath)).toBe(process.execPath)
    expect(() => resolveCommand('dsh-nonexistent-command-for-test')).toThrow('not found')
  })
})
