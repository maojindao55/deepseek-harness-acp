import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  {
    name: 'mock-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'echo_message',
        description: 'Echoes back a message',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The text to echo' },
          },
          required: ['text'],
        },
      },
      {
        name: 'add_numbers',
        description: 'Adds two numbers together',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number', description: 'First number' },
            b: { type: 'number', description: 'Second number' },
          },
          required: ['a', 'b'],
        },
      },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'echo_message') {
    const text = String(request.params.arguments?.text || '')
    return {
      content: [{ type: 'text', text: `Echo: ${text}` }],
    }
  }

  if (request.params.name === 'add_numbers') {
    const a = Number(request.params.arguments?.a || 0)
    const b = Number(request.params.arguments?.b || 0)
    return {
      content: [{ type: 'text', text: `Result: ${a + b}` }],
    }
  }

  throw new Error(`Unknown tool: ${request.params.name}`)
})

const transport = new StdioServerTransport()
await server.connect(transport)
