/**
 * 面板 API 客户端：与 console api.js 同一套令牌存储键（同源复用控制台会话），
 * BASE 由 boot.js 传入（/gate01/panel/ 挂载形态推导修正）。全部请求收口于此，
 * 页面代码零裸 fetch（RBAC 走查铁律同样适用于面板前端）。
 *
 * M2 远端连接（形态 C）：boot.js 探测到宿主连接为 remote 时调用 setRemoteProxy(true)——
 * 全部 /api/* 请求改经本机插件的远端代理（/rqcard/proxy/*）转发宿主，浏览器零跨域；
 * 令牌按连接隔离（setConnectionScope(hubBase)），本机/远端会话互不串台。
 */

export let BASE = ''

export function setBase(value) {
  BASE = value
}

/** 远端代理开关：true 时 /api/* 重写到 ${BASE}/rqcard/proxy/api/*。 */
let remoteProxy = false

export function setRemoteProxy(enabled) {
  remoteProxy = Boolean(enabled)
}

/** 连接作用域：远端连接时传 hubBase，令牌键按连接命名空间隔离（对齐 console connections.js 语义）。 */
let scope = ''

export function setConnectionScope(value) {
  scope = String(value ?? '')
}

const scopedKey = (baseKey) => (scope ? `${baseKey}@${scope}` : baseKey)

/** 请求路径重写：远端模式把 /api/* 指向本机插件的宿主代理。 */
const mapPath = (path) => (remoteProxy && path.startsWith('/api/')
  ? `${BASE}/rqcard/proxy${path}`
  : `${BASE}${path}`)

const session = {
  get token() { return localStorage.getItem(scopedKey('gate01_token')) ?? '' },
  get refreshToken() { return localStorage.getItem(scopedKey('gate01_refresh')) ?? '' },
  saveRefresh(token) { localStorage.setItem(scopedKey('gate01_refresh'), token) },
  get user() {
    try { return JSON.parse(localStorage.getItem(scopedKey('gate01_user')) ?? 'null') } catch { return null }
  },
  save(token, user) {
    localStorage.setItem(scopedKey('gate01_token'), token)
    localStorage.setItem(scopedKey('gate01_user'), JSON.stringify(user))
  },
  clear() {
    localStorage.removeItem(scopedKey('gate01_token'))
    localStorage.removeItem(scopedKey('gate01_refresh'))
    localStorage.removeItem(scopedKey('gate01_user'))
  },
  get permissions() { return this.user?.permissions ?? [] },
  can(point) { return this.permissions.includes('*') || this.permissions.includes(point) },
}

export { session }

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

let refreshing = null

/** 默认请求超时（QA BUG-U-03）：车间 WiFi 半死不活时请求必须可失败、可感知，不许永远挂起。
 *  个别慢端点（如模型连通性测试真实外呼）可用 timeoutMs 覆盖。 */
export const DEFAULT_TIMEOUT_MS = 20_000

async function tryRefresh() {
  if (!session.refreshToken) return false
  if (!refreshing) {
    refreshing = (async () => {
      try {
        // 刷新双通道：console 在场走 /api/auth/refresh（公开白名单）；404（console 缺席的
        // 01门装态）回落面板自持的 /api/panel/auth/refresh——401 是真实刷新失败，不回退。
        let response = await fetch(mapPath('/api/auth/refresh'), {
          method: 'POST',
          headers: proxyHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ refreshToken: session.refreshToken }),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        })
        if (response.status === 404) {
          response = await fetch(mapPath('/api/panel/auth/refresh'), {
            method: 'POST',
            headers: proxyHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ refreshToken: session.refreshToken }),
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
          })
        }
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok === false) return false
        localStorage.setItem(scopedKey('gate01_token'), payload.data.token)
        localStorage.setItem(scopedKey('gate01_refresh'), payload.data.refreshToken)
        return true
      } catch {
        return false
      } finally {
        setTimeout(() => { refreshing = null }, 50)
      }
    })()
  }
  return refreshing
}

/** 会话已不可恢复（刷新失败）：清场 + 广播（QA BUG-U-05）——此前只清 token 不广播，
 *  页面继续以死会话操作、每次只弹错误 toast，与整页刷新后看到的「会话已失效」引导两条路径。 */
function onSessionExpired() {
  session.clear()
  window.dispatchEvent(new CustomEvent('panel:session-expired'))
}

/** 网络层异常 → 中文可行动文案（QA BUG-U-04）：工人不该看到「Failed to fetch」原文。 */
function networkError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new ApiError('TIMEOUT', '请求超时：网络响应过慢，请检查网络后重试', 0)
  }
  return new ApiError('NETWORK', '网络连接失败：请检查网络后重试（持续失败请联系管理员）', 0)
}

/**
 * 代理形态附加头：远端模式请求经本机插件 /rqcard/proxy/* 转发，而 /rqcard/* 是免登
 * 命名空间、要求 x-rqcard-call: 1 向导头（drive-by CSRF 防线）——同源页面可携带自定义头，
 * 跨站网页发不出。漏带该头会让形态 C 的面板数据面整体 403（Bug3 修复）。
 */
const proxyHeaders = (headers) => (remoteProxy
  ? { ...headers, 'x-rqcard-call': '1' }
  : headers)

async function request(method, path, body, opts = {}, retried = false) {
  const headers = proxyHeaders({ 'content-type': 'application/json' })
  if (session.token) headers.authorization = `Bearer ${session.token}`
  let response
  try {
    response = await fetch(mapPath(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (error) {
    throw networkError(error)
  }
  let payload = null
  try { payload = await response.json() } catch { /* non-json */ }
  if (response.status === 401 && !retried) {
    if (await tryRefresh()) return request(method, path, body, opts, true)
    onSessionExpired()
  }
  if (!response.ok || payload?.ok === false) {
    const err = payload?.error ?? {}
    // 远端模式面板路由 404 = 宿主版本缺少该面板契约（docs/handoff-panel-remote-contract-to-main.md
    // H-1）：广播给壳层做诚实降级横幅（「宿主缺少 X」），错误对象照常抛出、视图内既有错误处理
    // 不变（issue #2，2026-10-29）。local 形态路由同进程必然在位，不广播。
    if (remoteProxy && response.status === 404 && path.startsWith('/api/panel/')) {
      try { window.dispatchEvent(new CustomEvent('panel:host-missing-route', { detail: { path } })) } catch { /* Node 自测环境无 window */ }
    }
    throw new ApiError(err.code ?? `HTTP_${response.status}`, err.message ?? `请求失败（${response.status}）`, response.status)
  }
  return payload?.data
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body = {}, opts) => request('POST', path, body, opts),
  put: (path, body = {}, opts) => request('PUT', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  delete: (path, body, opts) => request('DELETE', path, body, opts),
}
