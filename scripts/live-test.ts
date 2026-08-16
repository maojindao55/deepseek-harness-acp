import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const API_KEY = process.env.DEEPSEEK_API_KEY

if (!API_KEY) {
  console.error('Error: DEEPSEEK_API_KEY environment variable is required.')
  process.exit(1)
}

async function runLiveTest() {
  console.log('🚀 启动 deepseek-harness-acp 真实多轮在线端到端测试...\n')

  const child = spawn('npx', ['tsx', 'src/bin.ts'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: API_KEY,
      DSH_PERMISSION_MODE: 'danger-full-access',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  let buffer = ''
  let resolveAll: ((val: any) => void) | null = null
  const allPromise = new Promise((r) => (resolveAll = r))

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed)
        handleMessage(msg)
      } catch {}
    }
  })

  let sessionId = ''

  function handleMessage(msg: any) {
    if (msg.id === 1) {
      console.log('✅ [1. initialize 响应]')
      // Send session/new
      const newSessionMsg = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: process.cwd(), mcpServers: [] },
      }) + '\n'
      child.stdin.write(newSessionMsg)
    } else if (msg.id === 2) {
      sessionId = msg.result.sessionId
      console.log(`✅ [2. session/new 响应] sessionId: ${sessionId}`)

      // Turn 1
      console.log('\n💬 [Turn 1 提问]: "请用一句话介绍你自己"')
      const promptMsg1 = JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: '请用一句话介绍你自己' }],
        },
      }) + '\n'
      child.stdin.write(promptMsg1)
    } else if (msg.method === 'session/update') {
      const update = msg.params?.update
      if (update?.sessionUpdate === 'agent_message_chunk') {
        process.stdout.write(`\x1b[32m${update.content?.text || ''}\x1b[0m`)
      }
    } else if (msg.id === 3) {
      console.log('\n\n📊 [Turn 1 统计结果]:')
      console.log('   Raw Summary:', msg.result._meta.metrics.rawSummary)
      console.log('   Usage:', JSON.stringify(msg.result.usage))

      // Turn 2
      console.log('\n💬 [Turn 2 提问 (同会话接续)]: "好的，请写一个快速排序 Python 函数"')
      const promptMsg2 = JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: '好的，请写一个快速排序 Python 函数' }],
        },
      }) + '\n'
      child.stdin.write(promptMsg2)
    } else if (msg.id === 4) {
      console.log('\n\n📊 [Turn 2 统计结果]:')
      console.log('   Raw Summary:', msg.result._meta.metrics.rawSummary)
      console.log('   Usage:', JSON.stringify(msg.result.usage))
      console.log('\n✅ 多轮真实调用测试全部完成！')
      if (resolveAll) resolveAll(true)
    }
  }

  // Send initialize
  const initMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {} },
  }) + '\n'
  child.stdin.write(initMsg)

  await allPromise
  child.kill('SIGTERM')
}

runLiveTest().catch(console.error)
