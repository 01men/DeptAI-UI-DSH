/**
 * realtime.js 传输层自证（QA 2026-09-08 H2/BUG-U-02 根治配套测试）。
 *
 * 运行方式（realtime.js 零依赖纯 ESM，Node 直接加载）：
 *
 *     node packages/plugin-console/public/js/realtime.test.mjs
 *
 * 覆盖面：transport 决议、SSE 优先建立、open 超时/错误降级、轮询失败 onPollError
 * 连续计数与健康态台账、非 2xx 计失败、成功自愈清零、close 停摆。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decideTransport, createEventStream } from './realtime.js'

/** EventSource stub：可编程触发 open/message/error。 */
function esStub() {
  return {
    listeners: {},
    set onopen(fn) { this.listeners.open = fn },
    set onmessage(fn) { this.listeners.message = fn },
    set onerror(fn) { this.listeners.error = fn },
    open() { this.listeners.open?.() },
    message(data) { this.listeners.message?.({ data }) },
    error() { this.listeners.error?.() },
    close() { this.closed = true },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

test('decideTransport：四态决议', () => {
  assert.equal(decideTransport({ sseOpened: false, sseError: false, supportsEventSource: false }), 'polling')
  assert.equal(decideTransport({ sseOpened: false, sseError: true, supportsEventSource: true }), 'polling')
  assert.equal(decideTransport({ sseOpened: true, sseError: false, supportsEventSource: true }), 'sse')
  assert.equal(decideTransport({ sseOpened: false, sseError: false, supportsEventSource: true }), 'polling')
})

test('SSE 优先：open 后保持 sse，message 直达 onMessage', async () => {
  const es = esStub()
  const got = []
  const stream = createEventStream({
    url: 'http://x/stream', pollPath: 'http://x/poll',
    onMessage: (data) => got.push(data),
    EventSourceImpl: class { constructor() { return es } },
    fetchImpl: async () => { throw new Error('不应轮询') },
  })
  es.open()
  assert.equal(stream.health().transport, 'sse')
  es.message(JSON.stringify({ hello: 1 }))
  assert.deepEqual(got, [{ hello: 1 }])
  stream.close()
  assert.equal(stream.health().transport, 'closed')
})

test('SSE error 降级轮询；轮询失败逐次 onPollError 计数、成功自愈清零（H2 契约）', async () => {
  const es = esStub()
  const pollFailures = [401, 0, 0] // 首轮 401，其后成功
  const pollEvents = []
  let pollCalls = 0
  const reported = []
  let downgraded = null
  const stream = createEventStream({
    url: 'http://x/stream', pollPath: 'http://x/poll', pollIntervalMs: 5,
    onDowngrade: (reason) => { downgraded = reason },
    onPollError: (error, info) => reported.push({ message: error.message, ...info }),
    onMessage: (data) => pollEvents.push(data),
    EventSourceImpl: class { constructor() { return es } },
    fetchImpl: async () => {
      const status = pollFailures[Math.min(pollCalls, pollFailures.length - 1)]
      pollCalls++
      if (status !== 0) { const err = new Error('x'); err.status = status; throw err }
      return { ok: true, text: async () => JSON.stringify({ at: pollCalls }) }
    },
  })
  es.error() // SSE 失败 → 降级 + 立即首轮轮询
  assert.equal(downgraded, 'sse-error')
  await flush()
  assert.equal(stream.health().transport, 'polling')
  // 首轮 401 已计失败；等待第二轮成功
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(reported.length, 1, `实际回调：${JSON.stringify(reported)}`)
  assert.equal(reported[0].consecutiveFailures, 1)
  assert.equal(reported[0].status, 401)
  assert.ok(stream.health().consecutivePollFailures === 0, '成功后连续失败清零')
  assert.ok(stream.health().lastPollOkAt > 0)
  assert.ok(pollEvents.length >= 1 && typeof pollEvents.at(-1)?.at === 'number', '轮询成功消息到达')
  stream.close()
})

test('连续失败累进计数，health() 反映最近错误', async () => {
  let calls = 0
  const stream = createEventStream({
    url: 'http://x/stream', pollPath: 'http://x/poll', pollIntervalMs: 5,
    // SSE 构造即抛（等价极旧 webview 无 SSE）：直接降级轮询，绝不触网
    EventSourceImpl: class { constructor() { throw new Error('no-sse') } },
    fetchImpl: async () => { calls++; throw new Error(`boom-${calls}`) },
  })
  assert.equal(stream.health().downgraded, true)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.ok(stream.health().consecutivePollFailures >= 2, `至少两轮失败：${calls}`)
  assert.match(stream.health().lastPollErrorMessage, /boom-/)
  stream.close()
  const frozen = stream.health().consecutivePollFailures
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stream.health().consecutivePollFailures, frozen, 'close 后不再轮询')
})

test('eventNames：具名 SSE 事件按名订阅并附通道判别字段（A2A 任务流契约）', async () => {
  const es = esStub()
  es.named = {}
  es.addEventListener = (name, fn) => { es.named[name] = fn }
  const got = []
  const stream = createEventStream({
    url: 'http://x/stream', pollPath: 'http://x/poll',
    eventNames: ['task.snapshot', 'task.terminal'],
    onMessage: (data) => got.push(data),
    EventSourceImpl: class { constructor() { return es } },
    fetchImpl: async () => { throw new Error('不应轮询') },
  })
  es.open()
  // 具名事件必须走 addEventListener（onmessage 收不到）
  es.named['task.snapshot']({ data: JSON.stringify({ taskId: 'task_1', state: 'working', event: 'spoofed' }) })
  es.named['task.terminal']({ data: JSON.stringify({ taskId: 'task_1', state: 'completed' }) })
  // 未声明的事件不订阅（不会凭空扩面）
  assert.equal(es.named['task.progress'], undefined, '未声明的事件不应注册监听')
  assert.deepEqual(got, [
    // 载荷同名字段不得覆盖通道判别（event 最后写）
    { taskId: 'task_1', state: 'working', event: 'task.snapshot' },
    { taskId: 'task_1', state: 'completed', event: 'task.terminal' },
  ])
  stream.close()
})
