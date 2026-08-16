# DeepSeek Harness ACP Server (Standalone)

> Standalone Agent Client Protocol (ACP) Server powered by DeepSeek Harness with real-time token streaming, thought trace transparency, tool execution lifecycle updates, and cross-process session recovery.

[中文文档](README.zh.md)

---

## ✨ Features

- **⚡ Real-time Token Streaming**: Word-by-word streaming (`agent_message_chunk`) for ultra-low latency.
- **🧠 Thought Trace Streaming**: Live reasoning and thinking flow (`agent_thought_chunk`).
- **📊 Comprehensive Token & Performance Metrics**: Standard `usage` (input/output/cached/thought tokens) and detailed `_meta.metrics` (TTFT, tok/s, cache hit rate, turns, steps) in `session/prompt` response.
- **🛠️ Tool Lifecycle Updates**: Observable tool execution states (`tool_call` & `tool_call_update`).
- **🔄 Session Recovery & Listing**: Seamless multi-turn session resume (`session/load`, `session/resume`, `session/list`).
- **⚙️ Dynamic Configuration**: Real-time model switching (`deepseek-v4-pro` / `deepseek-v4-flash`).
- **📦 Zero-Config Startup**: Built-in default configuration — start immediately with only `DEEPSEEK_API_KEY`.

---

## 🚀 Quick Start

### 1. Global Installation (CLI)

```bash
# Install globally via npm (using full name or short alias)
npm install -g deepseek-harness-acp
# or
npm install -g dsh-acp

# Or run directly via npx without installation
npx dsh-acp
# or
npx deepseek-harness-acp
```

### 2. Environment Variables

Create a `.env` file or export environment variables:

```bash
export DEEPSEEK_API_KEY="sk-your-api-key"
# Optional overrides:
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
export DSH_PERMISSION_MODE="workspace-write" # workspace-write | danger-full-access
```

---

## 🔌 Integration with Third-Party Clients

### Zed Editor

Add the following to your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "assistant": {
    "version": "2",
    "custom_agents": [
      {
        "name": "DeepSeek Harness",
        "command": "deepseek-harness-acp",
        "env": {
          "DEEPSEEK_API_KEY": "sk-your-deepseek-api-key"
        }
      }
    ]
  }
}
```

### FreeBuddy

In FreeBuddy settings or custom agent configuration, specify:
- **Command**: `deepseek-harness-acp` (or `dsh-acp`)
- **Environment**: `DEEPSEEK_API_KEY=sk-...`

### Node.js / TypeScript SDK

```typescript
import { spawn } from 'node:child_process'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'

const proc = spawn('deepseek-harness-acp', [], {
  env: { ...process.env, DEEPSEEK_API_KEY: 'sk-your-api-key' },
  stdio: ['pipe', 'pipe', 'inherit'],
})

const stream = ndJsonStream(proc.stdin, proc.stdout)
const client = new ClientSideConnection(
  (agent) => ({
    sessionUpdate: async ({ update }) => {
      if (update.sessionUpdate === 'agent_message_chunk') {
        process.stdout.write(update.content.text)
      } else if (update.sessionUpdate === 'agent_thought_chunk') {
        process.stderr.write(update.content.text)
      }
    },
    requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
  }),
  stream,
)

await client.initialize({ protocolVersion: 1, clientCapabilities: {} })
const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] })

await client.prompt({
  sessionId,
  prompt: [{ type: 'text', text: 'Hello DeepSeek!' }],
})
```

---

## 📜 Supported ACP Methods

| Method / Notification | Description |
|---|---|
| `initialize` | Capability negotiation (`loadSession: true`, `sessionCapabilities.close/list/resume`) |
| `session/new` | Create a fresh session and return active `configOptions` |
| `session/load` | Restore an existing session and historical context from disk |
| `session/resume` | Resume an existing session from memory or persistence |
| `session/list` | List known sessions filtered by workspace `cwd` |
| `session/set_config_option` | Dynamically update active session configuration (e.g. model) |
| `session/prompt` | Send user message and await completion |
| `session/cancel` | Cancel in-flight prompt |
| `session/close` | Release session and clean up memory |
| `session/update` *(Stream)* | Delivers live text, thoughts, and tool lifecycle events |

---

## 📄 License

[MIT](LICENSE) © maojindao55
