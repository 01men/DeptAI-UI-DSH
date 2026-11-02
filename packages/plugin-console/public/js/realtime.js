/**
 * 实时通道（WP-11）：SSE 优先、失败自动降级轮询（不恢复 WS）。
 *
 * 钉钉微应用 H5 场景（docs/dingtalk-webview-report.md）：钉钉 webview 对长连接
 * （SSE/WS）支持不稳，因此一律 SSE 优先，10s 内未 open 或中途 error 即降级为
 * 30s 轮询，降级一次性回调 onDowngrade(reason)，之后不再尝试恢复 SSE/WS。
 *
 * 轮询失败可观测（QA 2026-09-08 BUG-U-02 根治 / 交接清单 H2）：单轮轮询失败不再静默——
 * onPollError(error, { consecutiveFailures, status? }) 逐次回调，消费方据此降级徽标；
 * handle.health() 暴露传输层健康态（transport / 连续失败数 / 最近成功与失败时刻），
 * 轮询成功自动清零连续失败计数（自愈即恢复）。契约向后兼容：onPollError / health 均可选。
 *
 * 零依赖：本文件不 import 任何模块；fetch / EventSource 由调用方传入或从
 * globalThis 取（钉钉 webview 与 Node 测试环境通吃，便于脚本直测）。
 */

/**
 * 纯函数：给定 SSE 状态决定传输方式（'sse' | 'polling'）。
 * - 环境不支持 EventSource → 轮询；
 * - SSE 已出错 → 轮询；
 * - SSE 已成功 open → 保持 SSE；
 * - 其余（超时仍未 open）→ 轮询。
 */
export function decideTransport({ sseOpened, sseError, supportsEventSource }) {
  if (!supportsEventSource) return 'polling'
  if (sseError) return 'polling'
  return sseOpened ? 'sse' : 'polling'
}

/**
 * 动态文案翻译（零依赖纪律不变：不 import i18n.js——Node 测试环境直测本模块，
 * 经 window.rqI18n 取浏览器注入的 i18n 运行时，缺失时回退原文并自行插值）。
 */
function tr(text, params) {
  try {
    if (typeof window !== 'undefined' && window.rqI18n && typeof window.rqI18n.t === 'function') {
      return window.rqI18n.t(text, params)
    }
  } catch { /* 忽略 */ }
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}

/**
 * 建立事件流：优先 EventSource(url)，失败自动降级为轮询 pollPath。
 *
 * @param {object} options
 * @param {string} options.url              SSE 端点
 * @param {string} options.pollPath         降级轮询端点（fetch GET）
 * @param {number} [options.pollIntervalMs=30000] 轮询间隔
 * @param {number} [options.openTimeoutMs=10000]  SSE open 超时（超时未 open 即降级）
 * @param {(data: unknown) => void} [options.onMessage] 收到消息（SSE data 或轮询响应体，尽量 JSON.parse）
 * @param {(reason: string) => void} [options.onDowngrade] 降级回调（恰好一次）
 * @param {(error: Error, info: { consecutiveFailures: number, status?: number }) => void} [options.onPollError]
 *        轮询单轮失败回调（含网络异常与非 2xx 响应；consecutiveFailures 从 1 起计，成功即清零）
 * @param {string[]} [options.eventNames]   需要转发的 SSE 具名事件（服务端 `event: xxx`）。
 *        EventSource 的 onmessage 只收**无命名**事件；业务侧显式声明后，每个具名事件以
 *        `{ event: '<name>', ...解析后的 data }` 交给 onMessage，与轮询响应同通道消费。
 * @param {object} [options.headers]        轮询请求头（如鉴权 authorization）
 * @param {typeof fetch} [options.fetchImpl] 轮询用 fetch（缺省取 globalThis.fetch）
 * @param {typeof EventSource} [options.EventSourceImpl] SSE 实现（缺省取 globalThis.EventSource）
 * @returns {{ close: () => void, health: () => object }}
 */
export function createEventStream(options) {
  const {
    url,
    pollPath,
    pollIntervalMs = 30000,
    openTimeoutMs = 10000,
    onMessage,
    onDowngrade,
    onPollError,
    eventNames = [],
    headers,
    fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
    EventSourceImpl = globalThis.EventSource,
  } = options ?? {}

  let closed = false
  let downgraded = false
  let es = null
  let openTimer = null
  let pollTimer = null
  let pollInFlight = false // 仅一次在途：上一轮未完成不发起下一轮
  let sseOpened = false
  // 健康态台账（H2）：轮询失败可观测，成功即自愈清零
  let consecutivePollFailures = 0
  let lastPollOkAt = null
  let lastPollErrorAt = null
  let lastPollErrorMessage = null

  const health = () => ({
    transport: closed ? 'closed' : downgraded ? 'polling' : sseOpened ? 'sse' : 'connecting',
    downgraded,
    consecutivePollFailures,
    lastPollOkAt,
    lastPollErrorAt,
    lastPollErrorMessage,
  })

  const emitMessage = (data) => {
    if (closed || typeof onMessage !== 'function') return
    try { onMessage(data) } catch { /* 消费方异常不中断通道 */ }
  }

  /** 尽量解析为 JSON，失败原样返回文本（SSE data 与轮询响应体共用）。 */
  const parseMaybeJson = (text) => {
    try { return JSON.parse(text) } catch { return text }
  }

  const schedulePoll = (delay) => {
    if (closed) return
    pollTimer = setTimeout(runPoll, delay)
  }

  const runPoll = async () => {
    if (closed || pollInFlight || !fetchImpl) return
    pollInFlight = true
    try {
      const res = await fetchImpl(pollPath, { headers })
      // 非 2xx 同样计入失败（旧实现静默吞掉 401/5xx，徽标照常宣称实时——BUG-U-02 根因之一）
      if (!res.ok) {
        const err = new Error(tr('轮询响应异常：HTTP {status}', { status: res.status }))
        err.status = res.status
        throw err
      }
      const text = await res.text()
      consecutivePollFailures = 0
      lastPollOkAt = Date.now()
      if (!closed) emitMessage(parseMaybeJson(text))
    } catch (error) {
      consecutivePollFailures += 1
      lastPollErrorAt = Date.now()
      lastPollErrorMessage = error instanceof Error ? error.message : String(error)
      if (typeof onPollError === 'function') {
        try { onPollError(error instanceof Error ? error : new Error(String(error)), { consecutiveFailures: consecutivePollFailures, status: error?.status }) } catch { /* 消费方异常不中断通道 */ }
      }
    } finally {
      pollInFlight = false
      schedulePoll(pollIntervalMs)
    }
  }

  /** 降级：恰好一次；关停 SSE 与 open 超时器后立刻发起首轮轮询。 */
  const downgrade = (reason) => {
    if (downgraded || closed) return
    downgraded = true
    if (es) { try { es.close() } catch { /* 忽略 */ } es = null }
    if (openTimer) { clearTimeout(openTimer); openTimer = null }
    if (typeof onDowngrade === 'function') {
      try { onDowngrade(reason) } catch { /* 忽略 */ }
    }
    runPoll()
  }

  // 环境无 EventSource：直接降级（如 Node 测试环境 / 极旧 webview）
  if (!EventSourceImpl) {
    downgrade('unsupported')
    return {
      close: () => { closed = true; if (pollTimer) clearTimeout(pollTimer) },
      health,
    }
  }

  // SSE 优先：open 超时兜底 + error 即降级（不依赖 EventSource 的自动重连）
  try {
    es = new EventSourceImpl(url)
  } catch {
    downgrade('sse-init-failed')
    return {
      close: () => { closed = true; if (pollTimer) clearTimeout(pollTimer) },
      health,
    }
  }
  es.onopen = () => {
    if (openTimer) { clearTimeout(openTimer); openTimer = null }
    sseOpened = true
  }
  es.onmessage = (event) => {
    emitMessage(parseMaybeJson(event.data))
  }
  // 具名事件：EventSource 不会把它们送进 onmessage，需按名显式 addEventListener。
  // 每个事件统一包装为 { ...data, event: '<name>' }（event 最后写，避免载荷里的同名字段
  // 覆盖通道判别）；非对象载荷包成 { event, data }，轮询降级路径的消费方按同一形状分支。
  for (const eventName of eventNames) {
    if (typeof es.addEventListener !== 'function') break
    es.addEventListener(eventName, (event) => {
      const payload = parseMaybeJson(event?.data)
      emitMessage(payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...payload, event: eventName }
        : { event: eventName, data: payload })
    })
  }
  es.onerror = () => {
    downgrade('sse-error')
  }
  openTimer = setTimeout(() => downgrade('open-timeout'), openTimeoutMs)

  return {
    close() {
      closed = true
      if (es) { try { es.close() } catch { /* 忽略 */ } es = null }
      if (openTimer) { clearTimeout(openTimer); openTimer = null }
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
    },
    health,
  }
}
