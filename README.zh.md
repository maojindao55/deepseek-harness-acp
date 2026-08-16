# DeepSeek Harness ACP 协议独立服务

> 基于 DeepSeek Harness 构建的轻量级独立 Agent Client Protocol (ACP) 服务端。支持实时 Token 打字机流、深度思考链流式输出、工具执行生命周期卡片、跨进程历史会话恢复与动态模型切换。

[English](README.md)

---

## ✨ 核心特性

- **⚡ 实时打字机 Token 流**：逐字返回（`agent_message_chunk`），极致响应体验。
- **🧠 思考链 / 深度思考流**：实时查看模型推理思考过程（`agent_thought_chunk`）。
- **📊 完整用量与性能指标**：`session/prompt` 响应返回标准 `usage`（输入/输出/Cache命中/思考Token）与 `_meta.metrics`（轮步数、TTFT首字延迟、tok/s生成速度、缓存命中率）。
- **🛠️ 工具执行生命周期**：完整的工具调用中与完成状态更新（`tool_call` & `tool_call_update`）。
- **🔄 跨进程会话恢复与列表**：支持多轮对话接续与历史会话读取（`session/load`、`session/resume`、`session/list`）。
- **⚙️ 动态配置项**：支持客户端动态切换模型（`deepseek-v4-pro` / `deepseek-v4-flash`）。
- **📦 零配置开箱即用**：内置默认沙箱与智能体配置，只需配置 `DEEPSEEK_API_KEY` 即可一行命令启动。

---

## 🚀 快速开始

### 1. 全局安装（CLI）

```bash
# 全局安装（支持全称或短别名）
npm install -g deepseek-harness-acp
# 或
npm install -g dsh-acp

# 或直接免安装秒级运行
npx dsh-acp
# 或
npx deepseek-harness-acp
```

### 2. 配置环境变量

创建 `.env` 文件或直接导出环境变量：

```bash
export DEEPSEEK_API_KEY="sk-your-api-key"
# 可选环境变量：
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
export DSH_PERMISSION_MODE="workspace-write" # workspace-write | danger-full-access
```

---

## 🔌 第三方客户端接入指南

### Zed 编辑器

在 Zed 配置文件（`~/.config/zed/settings.json`）中添加：

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

在 FreeBuddy 设置中指定：
- **执行命令**：`deepseek-harness-acp`（或 `dsh-acp`）
- **环境变量**：`DEEPSEEK_API_KEY=sk-...`

### Node.js / TypeScript 代码集成

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
        process.stdout.write(update.content.text) // 实时打字机输出
      } else if (update.sessionUpdate === 'agent_thought_chunk') {
        process.stderr.write(update.content.text) // 思考流
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
  prompt: [{ type: 'text', text: '你好，DeepSeek！' }],
})
```

---

## 📜 协议方法清单

| 方法 / 通知 | 说明 |
|---|---|
| `initialize` | 协议协商（公布 `loadSession: true`、`sessionCapabilities.close/list/resume`） |
| `session/new` | 创建新会话并返回初始可用配置项 |
| `session/load` | 跨进程加载历史会话并重构上下文 |
| `session/resume` | 恢复已有活跃或持久化会话 |
| `session/list` | 列出已知会话并支持按工作区 `cwd` 过滤 |
| `session/set_config_option` | 动态修改会话配置项（如切换模型） |
| `session/prompt` | 发送用户提问并等待 Agent 执行完毕 |
| `session/cancel` | 中途取消/打断正在处理的提问 |
| `session/close` | 主动释放会话资源 |
| `session/update` *(流式推送)* | 实时接收文本分片、思考链分片与工具执行状态 |

---

## 📄 开源许可

[MIT](LICENSE) © maojindao55
