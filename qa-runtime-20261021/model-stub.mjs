#!/usr/bin/env node
/**
 * QA 复测模型 stub（OpenAI 兼容 /v1/chat/completions）。
 * - 默认端口 7399（data-qa-20261021 中 deepseek-chat 的 endpoint）
 * - 行为开关：POST /__mode  { mode: 'chat'|'accept'|'counter'|'slow'|'error' }
 * - 统计：GET /__stats  → { calls, byMode, lastMessages }
 * 仅用于 QA，不进入产品路径。
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.STUB_PORT ?? 7399)
let mode = 'chat'
let calls = 0
const byMode = {}
const lastMessages = []

const server = createServer((req, res) => {
  const url = req.url ?? ''
  if (url === '/__mode' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { mode = String(JSON.parse(raw).mode ?? 'chat') } catch { /* keep */ }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, mode }))
    })
    return
  }
  if (url === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ calls, byMode, lastMessages: lastMessages.slice(-20) }))
    return
  }
  if (url === '/__reset' && req.method === 'POST') {
    calls = 0; for (const k of Object.keys(byMode)) delete byMode[k]; lastMessages.length = 0
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    return
  }
  if (!url.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
    return
  }
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    calls += 1
    byMode[mode] = (byMode[mode] ?? 0) + 1
    let messages = []
    try { messages = JSON.parse(raw).messages ?? [] } catch { /* ignore */ }
    const userText = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
    lastMessages.push(userText.slice(0, 300))
    const finish = (content, usage = { prompt_tokens: 62, completion_tokens: 48 }) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `chatcmpl-qa-${calls}`,
        object: 'chat.completion',
        model: 'qa-stub',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
      }))
    }
    if (userText.includes('收到另一数字员工的协作要约')) {
      if (mode === 'accept') return finish('{"decision":"accept","note":"边界清晰，可承接（QA stub）"}')
      if (mode === 'counter') return finish('{"decision":"counter","proposal":{"时限":"顺延一周"},"note":"排期冲突，建议顺延（QA stub）"}')
      return finish('{"decision":"accept","note":"默认接受（QA stub）"}')
    }
    if (userText.includes('慢任务标记')) {
      setTimeout(() => finish('慢任务完成（若任务已取消则不应交付）'), 2600)
      return
    }
    if (mode === 'error') {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"QA stub 故障注入"}}')
      return
    }
    finish(`QA stub 应答（mode=${mode}）：任务执行回路正常。`)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[qa-model-stub] listening on 127.0.0.1:${PORT}`)
})