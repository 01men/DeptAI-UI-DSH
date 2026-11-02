/** API 客户端：令牌管理 + 统一请求封装。 */

import { activeConnection, LOCAL_ID } from './connections.js'

/**
 * 部署前缀：独立形态（根路径部署）为 ''；dsh 宿主挂载形态下页面位于 /rq/ 之下，
 * 由文档地址自动推导（SPA 全程 hash 路由，document URL 恒为目录形态）。
 */
const MOUNT = new URL('.', document.baseURI).pathname.replace(/\/$/, '')

/**
 * 活动宿主连接（docs/frontend-host-switching.md）：默认本机（base = 部署前缀，同源）；
 * 配置过远程宿主并切换后，base 为远程完整地址（含其挂载前缀），API 全部改发远程——
 * BASE 在模块加载时定刻，切换连接后经整页刷新重新定刻。
 */
const CONNECTION = activeConnection(localStorage, MOUNT)

export const BASE = CONNECTION.base
export const CONNECTION_ID = CONNECTION.id
export const CONNECTION_NAME = CONNECTION.name
/** 是否连在本机宿主（本机独有语义——宿主 Cookie 直通、本机对话面入口——仅此态生效）。 */
export const IS_LOCAL_HOST = CONNECTION.id === LOCAL_ID

const TOKEN_NS = IS_LOCAL_HOST ? '' : `@${CONNECTION.id}`
const TOKEN_KEY = `heng_ops_token${TOKEN_NS}`
const REFRESH_KEY = `heng_ops_refresh${TOKEN_NS}`
const USER_KEY = `heng_ops_user${TOKEN_NS}`

/**
 * 免登演示会话（DEMO_MODE=1，2026-10-17）：内存态 profile，不落任何浏览器存储——
 * 真登录会话的存储键语义不受污染，刷新页面由 boot 链重新探测。
 * 服务端权威设计见 plugin-console/src/demo-mode.ts；此处只消费公开标记端点的回显。
 */
let demoProfile = null

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY) ?? '' },
  get refreshToken() { return localStorage.getItem(REFRESH_KEY) ?? '' },
  saveRefresh(token) { localStorage.setItem(REFRESH_KEY, token) },
  get user() {
    // 演示会话是合成身份：token 优先——一旦存在真令牌（含演示实例上真实登录），演示态即失效
    if (this.isDemo) return { displayName: demoProfile.name, roles: ['演示访客'], demo: true }
    try { return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') } catch { return null }
  },
  save(token, user) {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(REFRESH_KEY)
    localStorage.removeItem(USER_KEY)
  },
  /** 演示只读会话是否生效（真令牌存在时恒 false，登录后横幅与访客身份自动消失）。 */
  get isDemo() { return demoProfile !== null && !this.token },
  enterDemo(profile) { demoProfile = profile },
  exitDemo() { demoProfile = null },
  get permissions() {
    if (this.isDemo) return demoProfile.readonlyPermissions ?? []
    return this.user?.permissions ?? []
  },
  can(point) {
    // console.read 蕴含规则的镜像（权威判定面：platform-core rest-gate.ts IMPLIED_POINTS，
    // 两处须同步改）——真实用户持 console.login 即视为持控制台只读基线，导航不因改点消失
    if (point === 'console.read' && this.permissions.includes('console.login')) return true
    return this.permissions.includes('*') || this.permissions.includes(point)
  },
}

/**
 * 演示态探测（公开端点 /api/platform/demo，免鉴权）：远端宿主连接同样按 BASE 发。
 * 非演示态/异常一律 { demo:false }——演示能力缺失永不阻塞正常启动链。
 */
export async function demoStatus() {
  try {
    const response = await fetch(`${BASE}/api/platform/demo`)
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok === false) return { demo: false }
    return payload?.data ?? { demo: false }
  } catch {
    return { demo: false }
  }
}

export class ApiError extends Error {
  constructor(code, message, status, extra) {
    super(message)
    this.code = code
    this.status = status
    this.extra = extra
  }
}

let refreshing = null

/** access token 过期时静默续期（refresh 轮转链），失败才回落登录页。 */
async function tryRefresh() {
  if (!session.refreshToken) return false
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const response = await fetch(`${BASE}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok === false) return false
        localStorage.setItem(TOKEN_KEY, payload.data.token)
        localStorage.setItem(REFRESH_KEY, payload.data.refreshToken)
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

async function request(method, path, body, retried = false) {
  const headers = { 'content-type': 'application/json' }
  if (session.token) headers.authorization = `Bearer ${session.token}`
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await response.json() } catch { /* non-json */ }
  if (response.status === 401 && !retried && !PUBLIC_TOKEN_PATHS.has(path) && await tryRefresh()) {
    return request(method, path, body, true)
  }
  if (!response.ok || payload?.ok === false) {
    const err = payload?.error ?? {}
    if (response.status === 401 && !path.startsWith('/api/auth/') && !location.hash.startsWith('#/oauth')) {
      session.clear()
      if (!location.hash.startsWith('#/login')) {
        // 暂存被 401 打断的目的地：登录成功后回跳（登录页消费一次），不再落在工作台让人自己找路
        try { sessionStorage.setItem('heng_ops_next', location.pathname + location.hash) } catch { /* 忽略 */ }
        location.hash = '#/login'
      }
    }
    throw new ApiError(err.code ?? 'HTTP_' + response.status, err.message ?? `请求失败（${response.status}）`, response.status, err)
  }
  return payload?.data
}

const PUBLIC_TOKEN_PATHS = new Set(['/api/auth/login', '/api/auth/refresh', '/api/auth/sso', '/api/auth/sso/authorize', '/api/auth/sso/bind', '/api/auth/sso/register', '/api/auth/client-credentials', '/api/auth/entry-ticket-session'])

/**
 * 票据免登：一次性入场票据 → 控制台会话（门户/钉钉「打开即工作台」）。
 * 票据只进请求体与内存：调用方须先从 URL 取出并立即清除参数，不得常驻地址栏或写入 localStorage。
 */
export async function entryTicketSession(ticket) {
  const response = await fetch(`${BASE}/api/auth/entry-ticket-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
  })
  let payload = null
  try { payload = await response.json() } catch { /* non-json */ }
  if (!response.ok || payload?.ok === false) {
    const err = payload?.error ?? {}
    throw new ApiError(err.code ?? 'HTTP_' + response.status, err.message ?? `票据兑换失败（${response.status}）`, response.status, err)
  }
  const result = payload.data
  session.clear()
  session.save(result.token, result.user)
  if (result.refreshToken) session.saveRefresh(result.refreshToken)
  return result.user
}

/**
 * dsh-bridge 绑定自检（WP-04/A2）：cookie 面（rq_sid，非 Bearer 通道），不在 request() 内。
 * 独立形态（无宿主）404/异常 → 返回 null，由调用方静默处理。
 * 远程宿主连接态恒返回 null：本机宿主 Cookie 换来的是本机会话，与远程数据面无关。
 */
export async function bridgeStatus() {
  if (!IS_LOCAL_HOST) return null
  let response
  try {
    response = await fetch('/dsh-bridge/status', { headers: { accept: 'application/json' } })
  } catch {
    return null
  }
  if (!response.ok) return null
  const payload = await response.json().catch(() => null)
  return payload?.data ?? null
}

/**
 * 宿主 Cookie → 平台会话直通（控制台启动会话链第三级，与部门面板 boot 同款语义）：
 * rq_sid 已绑定宿主身份时免二次登录。路径必须根绝对（不带 BASE）——
 * /dsh-bridge/* 注册在 dsh webServer 根上，挂载形态不落 /rq 之内。
 * 独立形态（无宿主）404/HTML → null，静默跳过；远程宿主连接态同理（见 bridgeStatus）。
 */
export async function exchangeBridgeSession() {
  if (!IS_LOCAL_HOST) return null
  const status = await fetch('/dsh-bridge/status', { headers: { accept: 'application/json' } })
    .then((r) => r.json()).catch(() => null)
  if (!status?.data?.bound) return null
  const payload = await fetch('/dsh-bridge/session', { method: 'POST' })
    .then((r) => r.json()).catch(() => null)
  if (!payload?.ok) return null
  const result = payload.data
  session.save(result.token, result.user)
  if (result.refreshToken) session.saveRefresh(result.refreshToken)
  return result.user
}

/** Blob 下载（skill.zip 等二进制）：统一走 BASE 与 Bearer 头，页面不得自带裸 fetch。 */
export async function downloadBlob(path) {
  const headers = {}
  if (session.token) headers.authorization = `Bearer ${session.token}`
  const response = await fetch(`${BASE}${path}`, { headers })
  if (!response.ok) throw new ApiError('HTTP_' + response.status, `下载失败（${response.status}）`, response.status)
  return response.blob()
}

/**
 * 连接页测活（docs/frontend-host-switching.md）：探测任意宿主基址的 /api/health（公开端点）。
 * 探测目标可以是「尚未切换」的连接，不能走 request()（其 PATH 恒落在活动连接上），故在 api.js
 * 内单列（console 前端零裸 fetch 不变量的豁免边界即 api.js）。
 */
export async function probeHostBase(base) {
  const started = Date.now()
  let response
  try {
    response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) })
  } catch {
    return { ok: false, message: '不可达（地址错误，或目标宿主版本较早未放行跨域）' }
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok === false) return { ok: false, message: `HTTP ${response.status}` }
  return { ok: true, message: `${Date.now() - started}ms` }
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
  delete: (path, body) => request('DELETE', path, body),
  qs(params) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
    }
    const str = search.toString()
    return str ? `?${str}` : ''
  },
}
