/**
 * @dsh-ops/plugin-console —— 管理控制台接入插件。
 *
 * 职责：
 *   - REST API 网关：统一 Bearer 鉴权（authn）、权限点校验（RBAC）、审计埋点
 *   - 静态托管管理控制台 SPA（public/，飞书级交互）
 *   - 工具桥：POST /api/tools/execute 让 CLI/外部系统以同一套工具契约调用平台
 *   - 首次启动种子数据（演示环境）
 */
import { join, dirname, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, createReadStream } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange, Collection, RecordBase } from '../../platform-core/src/index.ts'
import { createPluginContext, newId, platformVersionInfo, PlatformEvents } from '../../platform-core/src/index.ts'
import { nonbillableUsage } from '../../plugin-usage/src/index.ts'
import { PermissionCatalog, type UserManageActor } from '../../plugin-iam/src/index.ts'
import { ProviderAuthError } from '../../plugin-iam/src/providers.ts'
import { AppRegistryService } from '../../plugin-app/src/index.ts'
import { AgentRegistryService } from '../../plugin-agent/src/index.ts'
import { RulesVersionConflictError } from '../../plugin-nas/src/authz.ts'
import { ShareLinkError, SHARE_LINK_TTL_PRESETS } from '../../plugin-nas/src/share-link.ts'
import { seedAll } from './seed.ts'
import { registerMarketRoutes } from './routes/market.ts'
import { registerFinOpsRoutes } from './routes/finops.ts'
import { registerPlatformRoutes } from './routes/platform.ts'

export const name = 'console'
export const inject = [
  'httpServer', 'opsStorage', 'platformBus', 'tools',
  'iam', 'authn', 'oidc', 'entryTickets', 'audit', 'usage', 'market', 'modelGateway',
  'mcpRegistry', 'nasRegistry', 'nasAuthz', 'nasShareLinks', 'skillHub', 'resourceCore', 'agentRegistry', 'appRegistry', 'update',
  'connectorHub',
]

interface CallerInfo {
  kind: 'human' | 'machine'
  principalId: string
  userId?: string
  /** machine 专属：凭证关联资源（refType=agent 时 modelgw 等调用以 agent:<refId> 为计量主体）。 */
  refType?: string
  refId?: string
  name: string
  permissions: string[]
  actChain: Array<{ name: string; type: string }>
}

// 公开路径白名单（免鉴权）：导出供 selftest「rbac endpoint matrix」比对——清单变动即红
export const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/sso',
  '/api/auth/sso/authorize',
  '/api/auth/sso/callback',
  '/api/auth/sso/bind',
  '/api/auth/sso/register',
  '/api/auth/refresh',
  '/api/auth/client-credentials',
  '/api/auth/providers',
  '/api/health',
  '/api/market/developers/register',
  '/api/market/developers/login',
  // 接入码本身即凭证（一次性 + TTL + 按 IP 失败锁定），enroll 端点公开
  '/api/connect/enroll',
  // 平台授权直达：一次性短时票据回平台换取身份（票据本身即临时凭证）
  '/api/authn/entry-tickets/redeem',
  // 应用访客埋点 beacon（浏览器侧 PV/UV 上报）：1x1 GIF/JSON 免鉴权；响应恒定不泄露应用存在性
  '/api/apps/beacon',
  // 票据免登控制台：redeem 通过后直接建立控制台会话（门户/钉钉「打开即工作台」，零二次登录）
  '/api/auth/entry-ticket-session',
  // 部门面板 SSE（review-dsh-agent-panel-v2 F13）：EventSource 无法携带 Bearer 头，
  // 端点公开但内部强制 ?token= 自校验（authn.verify，失败 fail-closed 401），降级轮询端点仍走 guarded
  '/api/panel/stream',
  // 面板自持登录面（交接 F 清单 N 节，2026-09-11）：panel 命名空间登录/刷新转发同一 authn 后端，
  // 全量形态曾被本中间件拦截为 401——宿主已登录用户在面板本页登录被迫「先登出」。
  // 白名单不放行任何数据（鉴权由 authn login/refresh 自身承担，口令错误仍 401）；
  // main 侧 panel 自持登录面路由尚未合入——先行登记（无路由时请求照常 404），合入后即闭环。
  '/api/panel/auth/login',
  '/api/panel/auth/refresh',
  // 首启 bootstrap 提示（M2）：登录页「初始口令待接管」横幅数据源；只回一个布尔（见 routes/platform.ts 泄露评估）
  '/api/platform/bootstrap',
])

/** 动态路径的公开前缀（OIDC 授权页查询：仅回显客户端名/scope，不泄露 redirect_uri）。 */
const PUBLIC_PATH_PREFIXES = ['/api/authn/oidc/auth-requests/']

/** 从请求头推导对外基址（钉钉等真实 IdP 的 redirect_uri 需绝对 URL；反代场景优先 x-forwarded-*）。 */
function requestOrigin(exchange: HttpExchange): string | undefined {
  const header = (name: string): string | undefined => {
    const value = exchange.headers[name]
    if (value === undefined) return undefined
    return String(Array.isArray(value) ? value[0] : value)
  }
  const host = header('x-forwarded-host') ?? header('host')
  if (!host) return undefined
  const proto = header('x-forwarded-proto') ?? 'http'
  return `${proto}://${host}`
}

/** 服务记录对外回显时脱敏认证类请求头（存储保留原文，仅展示层掩码）。 */
function maskServiceHeaders<T extends { headers?: Record<string, string> }>(service: T): T {
  if (!service.headers) return service
  const masked: Record<string, string> = {}
  for (const [key, value] of Object.entries(service.headers)) {
    masked[key] = /authorization|token|secret|key/i.test(key)
      ? (value.length > 8 ? `${value.slice(0, 6)}…` : '****')
      : value
  }
  return { ...service, headers: masked }
}

/** NAS 资产回显时脱敏网关访问令牌（存储保留原文，仅展示层掩码）。 */
function maskNasEntity<T extends { attrs?: Record<string, unknown> }>(nas: T): T {
  if (!nas.attrs || nas.attrs['accessToken'] === undefined) return nas
  const token = String(nas.attrs['accessToken'])
  return { ...nas, attrs: { ...nas.attrs, accessToken: token.length > 8 ? `${token.slice(0, 6)}…` : '****' } }
}

interface NasImportEntry {
  name: string
  url: string
  token: string
  nasIp: string
  error?: string
}

/**
 * 解析面向 NAS 纳管的 mcpServers JSON（synology-filestation-mcp 形态）：
 * url + headers.Authorization（Bearer 令牌）+ headers["X-NAS-IP"]（设备路由）。
 * 与 plugin-mcp 的通用导入不同，此处要求认证头与设备路由头齐备（NAS 域契约）。
 */
function parseNasMcpServersConfig(raw: string | object): NasImportEntry[] {
  let config: unknown
  if (typeof raw === 'string') {
    try {
      config = JSON.parse(raw)
    } catch {
      throw new Error('配置不是合法 JSON，请粘贴完整的 mcpServers 配置文本')
    }
  } else {
    config = raw
  }
  const obj = config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : null
  if (!obj) throw new Error('配置须为 JSON 对象')
  const map = (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
    ? obj.mcpServers
    : obj) as Record<string, unknown>
  const entries = Object.entries(map).filter(([, value]) => value && typeof value === 'object')
  if (entries.length === 0) throw new Error('未识别出任何服务条目：需要 {"mcpServers": {"名称": {"url": "…", "headers": {"Authorization": "Bearer …", "X-NAS-IP": "…"}}}}')
  return entries.map(([name, server]) => {
    const record = server as Record<string, unknown>
    const headers = (record.headers && typeof record.headers === 'object' ? record.headers : {}) as Record<string, string>
    const authHeader = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1] ?? ''
    const nasIp = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-nas-ip')?.[1] ?? ''
    const url = typeof record.url === 'string' ? record.url.trim() : ''
    const base = { name, url, token: authHeader.replace(/^Bearer\s+/i, '').trim(), nasIp: String(nasIp).trim() }
    if (!url) return { ...base, error: '缺少 url 字段' }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ...base, error: `仅支持 http(s) 地址，收到 ${parsed.protocol}` }
    } catch {
      return { ...base, error: `url 不是合法地址：${url}` }
    }
    if (!base.token) return { ...base, error: '缺少 headers.Authorization（Bearer 网关令牌）' }
    if (!base.nasIp) return { ...base, error: '缺少 headers["X-NAS-IP"]（NAS 设备路由）' }
    return base
  })
}

export function apply(ctx: Context) {
  const http = ctx.httpServer

  // -- 鉴权中间件 ---------------------------------------------------------
  http.use((exchange) => {
    // 取流自校验通道：?ticket=（一次性/10 分钟票据）与 ?sig=（签名分享链接，exp/sub/jti/sig 四参）——
    // 两者都是「URL 即凭证」，免 Bearer 头；真实性在 GET /fs/file 处理器内逐关验证（fail-closed）
    const nasFileStream = /^\/api\/nas\/[^/]+\/fs\/file$/.test(exchange.path)
    const ticketDownload = nasFileStream && Boolean(exchange.query.get('ticket'))
    const signedLinkDownload = nasFileStream && Boolean(exchange.query.get('sig'))
    if (!exchange.path.startsWith('/api/') || PUBLIC_PATHS.has(exchange.path) || PUBLIC_PATH_PREFIXES.some((prefix) => exchange.path.startsWith(prefix)) || ticketDownload || signedLinkDownload) return
    const header = String(exchange.headers['authorization'] ?? '')
    if (!header.startsWith('Bearer ')) {
      exchange.fail(401, 'UNAUTHORIZED', '缺少 Bearer 令牌，请先登录')
      return true
    }
    try {
      const verified = ctx.authn.verify(header.slice(7))
      exchange.principal = {
        kind: verified.principal.type,
        principalId: verified.principal.id,
        ...(verified.principal.type === 'human' && verified.principal.refId ? { userId: verified.principal.refId } : {}),
        ...(verified.principal.type === 'machine' ? { refType: verified.principal.refType, refId: verified.principal.refId } : {}),
        name: verified.principal.name,
        permissions: verified.scopes,
        actChain: verified.actChain,
      } satisfies CallerInfo
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'TOKEN_INVALID', message)
      return true
    }
  })

  const caller = (exchange: HttpExchange): CallerInfo => exchange.principal as CallerInfo

  /** 账号管理操作者上下文（QA A-03）：传给 iam 服务层做组织归属校验（非平台管理员限本组织子树）。 */
  const manageActor = (exchange: HttpExchange): UserManageActor => {
    const info = caller(exchange)
    return { userId: info.userId, permissions: info.permissions }
  }

  const requirePermission = (exchange: HttpExchange, point: string): boolean => {
    const info = caller(exchange)
    if (info.permissions.includes('*') || info.permissions.includes(point)) return true
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point,
      path: exchange.path,
    })
    exchange.fail(403, 'FORBIDDEN', `缺少权限点 ${point}，请联系管理员调整角色`, { permission: point })
    return false
  }

  /** 注册一条受权限保护的路由（H5：声明经 register 自动汇入路由×权限矩阵，含共享登记处去重）。 */
  const guarded = (method: string, path: string, permission: string, handler: (exchange: HttpExchange) => unknown | Promise<unknown>): void => {
    http.register(method, path, async (exchange) => {
      if (!requirePermission(exchange, permission)) return
      try {
        const result = await handler(exchange)
        if (!exchange.res.writableEnded) exchange.ok(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        exchange.fail(400, 'BAD_REQUEST', message)
      }
    }, { access: 'guarded', permission })
  }

  const body = <T extends Record<string, any>>(exchange: HttpExchange): T => (exchange.body ?? {}) as T
  const changeLog = (exchange: HttpExchange, action: string, resourceType: string, resourceId: string, resourceName: string, detail = ''): void => {
    const info = caller(exchange)
    ctx.audit.record({
      type: 'change',
      actorType: info.kind === 'human' ? 'human' : 'machine',
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      action,
      resourceType,
      resourceId,
      resourceName,
      result: 'ok',
      detail,
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    })
  }

  // -- 健康 ---------------------------------------------------------------
  http.register('GET', '/api/health', (exchange) => {
    exchange.ok({ status: 'ok', time: new Date().toISOString() })
  }, { access: 'public' })

  // -- 三方登录可用性（公开：登录页按配置显隐三方登录入口） ----------------------
  http.register('GET', '/api/auth/providers', (exchange) => {
    const providers = ctx.iam.connectorConfigs().all()
      .filter((config) => config.enabled && config.loginEnabled)
      .map((config) => ({ provider: config.provider, corpId: config.corpId, configId: config.id, name: config.name }))
    exchange.ok({ providers })
  }, { access: 'public' })

  // -- 认证 ---------------------------------------------------------------
  http.register('POST', '/api/auth/login', async (exchange) => {
    const { username, password } = body<{ username: string; password: string }>(exchange)
    if (!username || !password) {
      exchange.fail(400, 'BAD_REQUEST', '用户名与密码必填')
      return
    }
    try {
      const result = ctx.authn.login(username, password)
      const user = ctx.iam.users().get(result.userId)!
      exchange.ok({
        token: result.token,
        refreshToken: result.refreshToken,
        expiresAt: result.record.expiresAt,
        user: {
          id: user.id, username: user.username, displayName: user.displayName,
          orgId: user.orgId, roleIds: user.roleIds,
          roles: user.roleIds.map((roleId) => ctx.iam.roles().get(roleId)?.name).filter(Boolean),
          permissions: ctx.iam.userPermissions(user.id),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'LOGIN_FAILED', message)
    }
  }, { access: 'public' })

  // -- 三方登录（IdentityProviderAdapter 链路） ------------------------------
  http.register('POST', '/api/auth/sso/authorize', async (exchange) => {
    const { provider, scene, configId } = body<{ provider: string; scene?: 'web_qr' | 'h5' | 'in_app'; configId?: string }>(exchange)
    try {
      exchange.ok(await ctx.authn.beginSso(provider ?? 'dingtalk', scene ?? 'web_qr', requestOrigin(exchange), { ...(configId ? { configId } : {}) }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(400, 'SSO_AUTHORIZE_FAILED', message)
    }
  }, { access: 'public' })

  http.register('POST', '/api/auth/sso', async (exchange) => {
    const { provider, code, state } = body<{ provider: string; code: string; state: string }>(exchange)
    if (!code || !state) {
      exchange.fail(400, 'BAD_REQUEST', 'code 与 state 必填（先调 /api/auth/sso/authorize 获取 state）')
      return
    }
    try {
      const result = await ctx.authn.completeSso(provider ?? 'dingtalk', code, state)
      if (result.kind === 'pending') {
        exchange.ok({ kind: 'pending', pendingTicket: result.pendingTicket, profileName: result.profileName })
        return
      }
      const user = ctx.iam.users().get(result.userId)!
      exchange.ok({
        kind: 'hit',
        token: result.session.token,
        refreshToken: result.session.refreshToken,
        expiresAt: result.session.access.expiresAt,
        user: {
          id: user.id, username: user.username, displayName: user.displayName,
          orgId: user.orgId, roleIds: user.roleIds,
          roles: user.roleIds.map((roleId) => ctx.iam.roles().get(roleId)?.name).filter(Boolean),
          permissions: ctx.iam.userPermissions(user.id),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'SSO_FAILED', message)
    }
  }, { access: 'public' })

  http.register('POST', '/api/auth/sso/bind', async (exchange) => {
    const { pendingTicket, username, password } = body<{ pendingTicket: string; username: string; password: string }>(exchange)
    try {
      const result = ctx.authn.ssoBindExisting(pendingTicket, username, password)
      const user = ctx.iam.users().get(result.userId)!
      exchange.ok({
        token: result.session.token,
        refreshToken: result.session.refreshToken,
        expiresAt: result.session.access.expiresAt,
        user: {
          id: user.id, username: user.username, displayName: user.displayName,
          orgId: user.orgId, roleIds: user.roleIds,
          roles: user.roleIds.map((roleId) => ctx.iam.roles().get(roleId)?.name).filter(Boolean),
          permissions: ctx.iam.userPermissions(user.id),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'SSO_BIND_FAILED', message)
    }
  }, { access: 'public' })

  // -- 扫码/自动识别绑定三方身份（不手工输入 unionId） -------------------------

  /**
   * 发起绑定授权（须登录）。缺省绑定当前登录账号本人；
   * 指定 targetUserId 为他人绑定（需 iam.user.write，扫码人即被绑定的钉钉身份）。
   */
  http.register('POST', '/api/auth/sso/bind/authorize', async (exchange) => {
    const { provider, targetUserId, configId } = body<{ provider?: string; targetUserId?: string; configId?: string }>(exchange)
    const info = caller(exchange)
    const userId = targetUserId ?? info.userId
    if (!userId) {
      exchange.fail(401, 'UNAUTHORIZED', '仅平台账号（人）可发起三方身份绑定')
      return
    }
    if (userId !== info.userId && !info.permissions.includes('*') && !info.permissions.includes('iam.user.write')) {
      exchange.fail(403, 'FORBIDDEN', '为其他账号发起绑定需要 iam.user.write 权限')
      return
    }
    if (!ctx.iam.users().get(userId)) {
      exchange.fail(400, 'BAD_REQUEST', `账号不存在：${userId}`)
      return
    }
    try {
      exchange.ok(await ctx.authn.beginSso(provider ?? 'dingtalk', 'web_qr', requestOrigin(exchange), { purpose: 'bind', userId, ...(configId ? { configId } : {}) }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(400, 'SSO_BIND_AUTHORIZE_FAILED', message)
    }
  }, { access: 'authenticated' })

  /**
   * 钉钉 OAuth 浏览器回跳（公开，无需会话）：按 state 用途分发——
   * bind：完成扫码绑定并渲染结果页；login：完成登录并写 localStorage 后进入控制台。
   * 同时挂在 /api/auth/sso（与钉钉后台已配置的重定向 URL 兼容）。
   */
  const handleSsoCallback = async (exchange: HttpExchange): Promise<void> => {
    const code = exchange.query.get('authCode') ?? exchange.query.get('code') ?? ''
    const state = exchange.query.get('state') ?? ''
    const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
    const webBase = ctx.httpServer?.externalBase ?? ''
    const render = (title: string, bodyHtml: string, script = ''): void => {
      exchange.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      exchange.res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2329}
.card{background:#fff;border-radius:16px;padding:40px 48px;box-shadow:0 8px 30px rgba(0,0,0,.06);text-align:center;max-width:420px}
.card h2{margin:0 0 12px;font-size:20px}.card p{margin:6px 0;color:#646a73;font-size:14px;line-height:1.7}
.card a{color:#3370ff;text-decoration:none}.ok{color:#34a853;font-size:44px}.bad{color:#f54a45;font-size:44px}</style>
</head><body><div class="card">${bodyHtml}</div>${script}</body></html>`)
    }
    if (!code || !state) {
      render('授权回调异常', `<div class="bad">✕</div><h2>回调参数缺失</h2><p>缺少 code/state，请从控制台重新发起授权。</p><p><a href="/">返回控制台</a></p>`)
      return
    }
    try {
      const peeked = ctx.authn.peekOAuthState(state)
      if (peeked.purpose === 'bind') {
        const result = await ctx.authn.completeSsoBind(code, state)
        ctx.audit.record({
          type: 'change', actorType: 'human', actorId: result.userId,
          actorName: ctx.iam.users().get(result.userId)?.displayName ?? result.userId,
          action: 'iam.user.bind', resourceType: 'user', resourceId: result.userId,
          resourceName: result.displayName, result: 'ok', detail: `${result.provider} 扫码授权绑定`,
        })
        render('绑定成功', `<div class="ok">✓</div><h2>钉钉身份绑定成功</h2><p>已绑定：<b>${escapeHtml(result.displayName)}</b></p><p>即将自动返回控制台…</p><p><a href="${webBase}/#/iam">立即返回</a></p>`,
          `<script>setTimeout(()=>{location.href=\`${webBase}/#/iam\`},2000)</script>`)
        return
      }
      const result = await ctx.authn.completeSso(peeked.provider, code, state)
      if (result.kind === 'pending') {
        // 未命中身份链接：回登录页走「绑定已有账号 / 注册新账号」分支
        render('首次登录', `<h2>首次使用该三方身份</h2><p>正在返回登录页完成绑定/注册…</p>`,
          `<script>localStorage.setItem('heng_ops_sso_pending', JSON.stringify({ pendingTicket: ${JSON.stringify(result.pendingTicket)}, profileName: ${JSON.stringify(result.profileName)} })); location.replace('${webBase}/#/login')</script>`)
        return
      }
      const user = ctx.iam.users().get(result.userId)!
      const sessionUser = {
        id: user.id, username: user.username, displayName: user.displayName,
        orgId: user.orgId, roleIds: user.roleIds,
        roles: user.roleIds.map((roleId) => ctx.iam.roles().get(roleId)?.name).filter(Boolean),
        permissions: ctx.iam.userPermissions(user.id),
      }
      // 登录成功落库后按暂存的 OIDC 授权请求（heng_ops_sso_oidc_req，与授权请求同为 5 分钟有效）回到
      // 授权页继续 consent——AI 应用发起的「先登录再授权」流才能闭环；无暂存则进控制台
      render('登录成功', `<div class="ok">✓</div><h2>欢迎回来，${escapeHtml(user.displayName)}</h2><p>正在继续…</p>`,
        `<script>localStorage.setItem('heng_ops_token', ${JSON.stringify(result.session.token)}); localStorage.setItem('heng_ops_refresh', ${JSON.stringify(result.session.refreshToken)}); localStorage.setItem('heng_ops_user', ${JSON.stringify(JSON.stringify(sessionUser))});
var resume=null;try{resume=JSON.parse(localStorage.getItem('heng_ops_sso_oidc_req')||'null')}catch(e){resume=null}
localStorage.removeItem('heng_ops_sso_oidc_req');
// 跨源自举回跳（交接清单 G1）：登录页在整页跳转钉钉授权前暂存的 next（仅回环/私网 http(s)，
// 白名单见 landing.js sanitizeCrossOriginNext，此处正则兜底）——扫码完成后签自助票回跳本机面板
var nx=null;try{nx=sessionStorage.getItem('heng_ops_next_cross')}catch(e){nx=null}
sessionStorage.removeItem('heng_ops_next_cross');
if(resume&&typeof resume.req==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(resume.req)&&Date.now()-(resume.ts||0)<300000){location.replace('${webBase}/#/oauth/authorize?req='+resume.req)}
else if(nx&&/^https?:\\/\\/(localhost|127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)/.test(nx)){
  fetch('${webBase}/api/auth/entry-tickets/self',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+localStorage.getItem('heng_ops_token')}})
    .then(function(r){return r.ok?r.json():null})
    .then(function(p){var t=p&&p.data&&p.data.ticket;location.replace(t?nx+'#entry_ticket='+encodeURIComponent(t):'${webBase}/#/dashboard')})
    .catch(function(){location.replace('${webBase}/#/dashboard')})
}else{location.replace('${webBase}/#/dashboard')}</script>`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[sso-callback] 三方授权失败：', message)
      // 自动兜底：应用新增权限点后，老用户历史授权快照不含新 scope（钉钉 403 AccessTokenPermissionDenied）。
      // 自动重发一次带 prompt=consent 的授权跳转刷新授权快照；一次性 cookie 防重试循环，再失败才展示错误页。
      const retried = (exchange.headers.cookie ?? '').split(';').some((item) => item.trim() === 'heng_ops_sso_consent_retry=1')
      if (!retried && error instanceof ProviderAuthError && error.code === 'PROVIDER_SCOPE_DENIED') {
        try {
          const record = ctx.authn.peekOAuthState(state)
          const retry = await ctx.authn.beginSso(record.provider, 'web_qr', requestOrigin(exchange), {
            purpose: record.purpose,
            ...(record.userId !== undefined ? { userId: record.userId } : {}),
            ...(record.configId !== undefined ? { configId: record.configId } : {}),
            promptConsent: true,
          })
          if (retry.authorizeUrl) {
            exchange.res.writeHead(302, {
              location: retry.authorizeUrl,
              'set-cookie': 'heng_ops_sso_consent_retry=1; Path=/api/auth; Max-Age=600; HttpOnly; SameSite=Lax',
            })
            exchange.res.end()
            return
          }
        } catch (retryError) {
          console.error('[sso-callback] 重授权发起失败：', retryError instanceof Error ? retryError.message : String(retryError))
        }
      }
      render('操作失败', `<div class="bad">✕</div><h2>三方授权失败</h2><p>${escapeHtml(message)}</p><p><a href="/">返回控制台</a></p>`)
    }
  }
  http.register('GET', '/api/auth/sso', handleSsoCallback, { access: 'public' })
  http.register('GET', '/api/auth/sso/callback', handleSsoCallback, { access: 'public' })

  http.register('POST', '/api/auth/sso/register', async (exchange) => {
    const { pendingTicket } = body<{ pendingTicket: string }>(exchange)
    try {
      const result = ctx.authn.ssoRegister(pendingTicket)
      const user = ctx.iam.users().get(result.userId)!
      exchange.ok({
        token: result.session.token,
        refreshToken: result.session.refreshToken,
        expiresAt: result.session.access.expiresAt,
        user: {
          id: user.id, username: user.username, displayName: user.displayName,
          orgId: user.orgId, roleIds: user.roleIds,
          roles: user.roleIds.map((roleId) => ctx.iam.roles().get(roleId)?.name).filter(Boolean),
          permissions: ctx.iam.userPermissions(user.id),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'SSO_REGISTER_FAILED', message)
    }
  }, { access: 'public' })

  http.register('POST', '/api/auth/refresh', async (exchange) => {
    const { refreshToken } = body<{ refreshToken: string }>(exchange)
    if (!refreshToken) {
      exchange.fail(400, 'BAD_REQUEST', 'refreshToken 必填')
      return
    }
    try {
      const result = ctx.authn.refreshSession(refreshToken)
      exchange.ok({ token: result.token, refreshToken: result.refreshToken })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'REFRESH_FAILED', message)
    }
  }, { access: 'public' })

  http.register('POST', '/api/auth/client-credentials', async (exchange) => {
    const { clientId, clientSecret } = body<{ clientId: string; clientSecret: string }>(exchange)
    try {
      const result = ctx.authn.clientCredentialsLogin(clientId, clientSecret)
      exchange.ok({ token: result.token, expiresAt: result.record.expiresAt, principal: { id: result.principal.id, name: result.principal.name, scopes: result.record.scopes } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'CC_FAILED', message)
    }
  }, { access: 'public' })

  http.register('GET', '/api/auth/me', (exchange) => {
    const info = caller(exchange)
    exchange.ok({
      kind: info.kind,
      principalId: info.principalId,
      ...(info.userId !== undefined ? { userId: info.userId } : {}),
      name: info.name,
      permissions: info.permissions,
      actChain: info.actChain,
    })
  }, { access: 'authenticated' })

  http.register('POST', '/api/auth/logout', async (exchange) => {
    const header = String(exchange.headers['authorization'] ?? '')
    const token = header.slice(7)
    const refreshToken = body<{ refreshToken?: string }>(exchange).refreshToken
    try {
      const verified = ctx.authn.verify(token)
      if (verified.token.sid) {
        ctx.authn.revokeSession(verified.token.sid, '用户主动登出')
      } else {
        ctx.authn.revokeToken(verified.token.jti, '用户主动登出')
      }
    } catch { /* 令牌已失效也允许登出 */ }
    if (refreshToken) {
      try { ctx.authn.refreshSession(refreshToken) } catch { /* 已失效 */ }
    }
    // 吊销强持久化后再响应：返回 200 后进程被杀，吊销状态不丢失（评审崩溃恢复实验）
    await ctx.opsStorage.flushDurable()
    exchange.ok()
  }, { access: 'authenticated' })

  // -- 总览（工作台）-------------------------------------------------------
  guarded('GET', '/api/overview', 'console.login', () => {
    const pendingApprovals = ctx.audit.approvals().find((item) => item.status === 'pending')
    const unreadAlerts = ctx.audit.alerts().find((item) => !item.read)
    const recentEvents = ctx.platformBus.recent(20).map((event) => ({
      name: event.name, at: event.at, payload: summarize(event.payload), detail: summarizeDetail(event.payload),
    }))
    const costTrend = ctx.audit.costReport('date').sort((a, b) => a.key.localeCompare(b.key)).slice(-14)
    return {
      iam: { users: ctx.iam.users().count(), orgs: ctx.iam.orgs().count(), pendingUsers: ctx.iam.users().find((user) => user.status === 'pending').length },
      mcp: ctx.mcpRegistry.metricsOverview(),
      agents: ctx.agentRegistry.overview(),
      apps: ctx.appRegistry.overview(),
      skills: {
        total: ctx.skillHub.skills().count(),
        published: ctx.skillHub.skills().find((item) => item.status === 'published').length,
        pendingApproval: ctx.skillHub.skills().find((item) => item.status === 'pending_approval').length,
      },
      approvals: { pending: pendingApprovals.length, items: pendingApprovals.slice(0, 5) },
      alerts: { unread: unreadAlerts.length, critical: unreadAlerts.filter((item) => item.severity === 'critical').length },
      audit: ctx.audit.summary(),
      recentEvents,
      costTrend,
      conflicts: ctx.iam.conflicts().find((item) => item.status === 'pending').length,
    }
  })

  // -- 通知中心（IAW 交接 8-1：跨会话持久化 + since 游标 + 已读游标） ----------------
  //
  // 面板/控制台的通知此前只存在于 SSE 内存动态与 bus 环形缓冲（300 条，重启即失），
  // 这里补持久层：任务/审批/告警三类平台事件统一落 console:notifications，
  // 消费端 GET /api/notifications?since= 拉增量、POST read-cursor 推已读游标（跨设备漫游）。

  interface NotificationRecord extends RecordBase {
    type: 'task' | 'approval' | 'alert' | 'system'
    title: string
    body?: string
    scope: { kind: 'global' } | { kind: 'org'; orgId: string } | { kind: 'user'; userId: string }
    at: string
  }

  const notifications = (): Collection<NotificationRecord> => {
    const collection = ctx.opsStorage.collection<NotificationRecord>('console:notifications')
    collection.uniqueOn('notif-dedup', (n) => `${n.type}:${n.title}:${n.at.slice(0, 13)}`)
    return collection
  }

  const notificationCursors = (): Collection<{ userId: string; at: string } & RecordBase> => {
    const collection = ctx.opsStorage.collection<{ userId: string; at: string } & RecordBase>('console:notificationCursors')
    collection.uniqueOn('user', (row) => row.userId)
    return collection
  }

  const orgContainsId = (rootId: string, orgId: string): boolean => {
    let current = ctx.iam.orgs().get(orgId)
    let guard = 0
    while (current && guard++ < 32) {
      if (current.id === rootId) return true
      current = current.parentId ? ctx.iam.orgs().get(current.parentId) : undefined
    }
    return false
  }

  const pushNotification = (input: { type: NotificationRecord['type']; title: string; body?: string; scope: NotificationRecord['scope'] }): void => {
    const at = new Date().toISOString()
    const collection = notifications()
    collection.insert({ id: newId('ntf'), at, ...input })
    // 保留窗 30 天 + 硬上限 2000 条（环形语义：最旧的先出）
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const all = collection.all().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const stale of all.filter((n) => n.at < cutoff)) collection.remove(stale.id)
    const overflow = collection.all().length - 2000
    if (overflow > 0) for (const item of collection.all().sort((a, b) => a.at.localeCompare(b.at)).slice(0, overflow)) collection.remove(item.id)
  }

  // 事件生产者：告警（全局）/ 审批（全局，审批中心治理面）/ 任务（部门绑定的组织子树）。
  // 面板 deptConfigs 集合按平台稳定键跨插件只读（dsh-bridge softRead 同款惯例），读不到降级全局范围。
  ctx.platformBus.on(PlatformEvents.AlertFired, (payload) => {
    const p = payload as { severity?: string; title?: string; message?: string }
    try {
      pushNotification({ type: 'alert', title: p.title ?? '平台告警', body: p.message ?? '', scope: { kind: 'global' } })
    } catch { /* 通知落库失败不阻塞事件链 */ }
  })
  ctx.platformBus.on(PlatformEvents.ApprovalCreated, (payload) => {
    const p = payload as { approvalId?: string; title?: string }
    try {
      pushNotification({ type: 'approval', title: `待审批：${p.title ?? p.approvalId ?? ''}`, body: '已在审批中心挂起，请及时处理', scope: { kind: 'global' } })
    } catch { /* 通知落库失败不阻塞事件链 */ }
  })
  ctx.platformBus.on(PlatformEvents.PanelTaskUpdated, (payload) => {
    const p = payload as { taskId?: string; dept?: string; lane?: string; title?: string }
    try {
      const deptOrgId = ctx.opsStorage.collection<{ orgId?: string }>('panel:deptConfigs').get(p.dept ?? '')?.orgId
      const laneLabel = ({ todo: '待办', doing: '进行中', review: '待审', done: '完成' } as Record<string, string>)[p.lane ?? ''] ?? p.lane ?? ''
      pushNotification({
        type: 'task', title: `任务流转：${p.title ?? p.taskId ?? ''}`, body: `泳道 → ${laneLabel}`,
        scope: deptOrgId ? { kind: 'org', orgId: deptOrgId } : { kind: 'global' },
      })
    } catch { /* 通知落库失败不阻塞事件链 */ }
  })

  guarded('GET', '/api/notifications', 'console.login', (exchange) => {
    const info = caller(exchange)
    if (!info.userId) return { items: [], unread: 0, readCursor: null, note: '机器主体无个人通知面（v1 口径）' }
    const since = exchange.query.get('since') ?? ''
    const limit = Math.min(Number(exchange.query.get('limit') ?? 50) || 50, 200)
    const user = ctx.iam.users().get(info.userId)
    const visible = (n: NotificationRecord): boolean =>
      n.scope.kind === 'global'
      || (n.scope.kind === 'user' && n.scope.userId === info.userId)
      || (n.scope.kind === 'org' && Boolean(user) && orgContainsId(n.scope.orgId, user!.orgId))
    const cursor = notificationCursors().findOne((row) => row.userId === info.userId)
    const all = notifications().all().filter((n) => visible(n))
    return {
      items: all.filter((n) => n.at > since).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit),
      unread: all.filter((n) => n.at > (cursor?.at ?? '')).length,
      readCursor: cursor?.at ?? null,
      now: new Date().toISOString(),
    }
  })

  guarded('POST', '/api/notifications/read-cursor', 'console.login', (exchange) => {
    const info = caller(exchange)
    if (!info.userId) return exchange.fail(403, 'FORBIDDEN', '机器主体无个人通知面（v1 口径）')
    const input = body<{ at?: string }>(exchange)
    const now = new Date().toISOString()
    const at = input.at && !Number.isNaN(Date.parse(input.at)) && input.at <= now ? input.at : now
    const collection = notificationCursors()
    const existing = collection.findOne((row) => row.userId === info.userId)
    if (existing) collection.update(existing.id, { at })
    else collection.insert({ id: newId('ncur'), userId: info.userId, at })
    return { readCursor: at, unread: 0 }
  })

  // -- 资产运营：统一台账 / 健康巡检 / 成本报表（企业 AI 资产运营管理） --------
  guarded('GET', '/api/assets/inventory', 'usage.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 30) || 30, 1), 90)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const usageByResource = new Map(ctx.usage.breakdown(fromIso).byResource.map((row) => [row.resource, row]))
    const orgName = (orgId: string) => ctx.iam.orgs().get(orgId)?.name ?? orgId
    const usageOf = (resource: string | undefined) => {
      if (!resource) return { calls: 0, costCents: 0 }
      const row = usageByResource.get(resource)
      return { calls: row?.count ?? 0, costCents: row?.cost_cents ?? 0 }
    }
    const items = [
      ...ctx.mcpRegistry.services().all().map((service) => ({
        type: 'mcp' as const,
        id: service.id,
        name: service.name,
        slug: service.slug,
        status: service.status,
        health: service.health.status,
        exec: service.exec,
        version: service.currentVersion,
        org: orgName(service.orgId),
        owner: service.owner,
        updatedAt: service.updatedAt,
        ...usageOf(`mcp:${service.slug}`),
      })),
      ...ctx.nasRegistry.list().map((nas) => ({
        type: 'nas' as const,
        id: nas.id,
        name: nas.name,
        slug: nas.slug,
        status: nas.status,
        health: ctx.nasRegistry.healthOf(nas.id).status,
        org: orgName(nas.orgId),
        owner: nas.ownerId,
        updatedAt: nas.updatedAt,
        calls: 0,
        costCents: 0,
      })),
      ...ctx.resourceCore.list('agent').map((agent) => ({
        type: 'agent' as const,
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        status: agent.status,
        health: agent.status === 'online' ? 'healthy' : 'unknown',
        org: orgName(agent.orgId),
        owner: agent.ownerId,
        updatedAt: agent.updatedAt,
        ...usageOf(undefined),
      })),
      ...ctx.resourceCore.list('app').map((app) => ({
        type: 'app' as const,
        id: app.id,
        name: app.name,
        slug: app.slug,
        status: app.status,
        health: app.status === 'online' ? 'healthy' : 'unknown',
        org: orgName(app.orgId),
        owner: app.ownerId,
        updatedAt: app.updatedAt,
        ...usageOf(`app:${app.slug}`),
      })),
      ...ctx.skillHub.skills().all().map((skill) => ({
        type: 'skill' as const,
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        status: skill.status,
        health: 'unknown',
        org: orgName(skill.orgId),
        owner: skill.authorName,
        updatedAt: skill.updatedAt,
        calls: skill.stats?.installs ?? 0,
        costCents: 0,
      })),
      ...ctx.modelGateway.models().all().map((model) => ({
        type: 'model' as const,
        id: model.id,
        name: model.displayName,
        slug: model.slug,
        status: model.status,
        health: model.status === 'online' ? (model.endpoint ? 'healthy' : 'down') : 'unknown',
        org: '平台自营',
        owner: model.provider,
        updatedAt: model.updatedAt,
        ...usageOf(`model:${model.slug}`),
      })),
    ]
    const type = exchange.query.get('type')
    const status = exchange.query.get('status')
    const q = exchange.query.get('q')
    const filtered = items.filter((item) => {
      if (type && item.type !== type) return false
      if (status && item.status !== status) return false
      if (q && !`${item.name}${item.slug}${item.org}${item.owner}`.toLowerCase().includes(q.toLowerCase())) return false
      return true
    }).sort((a, b) => b.costCents - a.costCents || a.name.localeCompare(b.name))
    const byType: Record<string, { total: number; inService: number }> = {}
    for (const item of items) {
      const bucket = byType[item.type] ?? { total: 0, inService: 0 }
      bucket.total++
      if (['online', 'gray', 'published'].includes(item.status)) bucket.inService++
      byType[item.type] = bucket
    }
    return {
      days,
      total: filtered.length,
      summary: {
        byType,
        unhealthy: items.filter((item) => item.health === 'down' || item.health === 'degraded').length,
        costCents30d: items.reduce((sum, item) => sum + item.costCents, 0),
      },
      items: filtered,
    }
  })

  guarded('POST', '/api/assets/healthcheck', 'mcp.service.read', async (exchange) => {
    const info = caller(exchange)
    const checked: Array<{ type: string; id: string; name: string; status: string; latencyMs: number }> = []
    for (const service of ctx.mcpRegistry.services().all()) {
      if (!['online', 'gray', 'unhealthy'].includes(service.status)) continue
      const result = await ctx.mcpRegistry.probeService(service.id)
      checked.push({ type: 'mcp', id: service.id, name: service.name, status: result.status, latencyMs: result.latencyMs })
    }
    for (const nas of ctx.nasRegistry.list()) {
      if (!['online'].includes(nas.status)) continue
      const result = await ctx.nasRegistry.probe(nas.id)
      checked.push({ type: 'nas', id: nas.id, name: nas.name, status: result.status, latencyMs: result.latencyMs })
    }
    for (const entity of [...ctx.resourceCore.list('agent'), ...ctx.resourceCore.list('app')]) {
      checked.push({ type: entity.type, id: entity.id, name: entity.name, status: entity.status, latencyMs: 0 })
    }
    for (const model of ctx.modelGateway.models().all()) {
      checked.push({ type: 'model', id: model.id, name: model.displayName, status: model.status, latencyMs: 0 })
    }
    const abnormal = checked.filter((item) => item.status === 'down' || item.status === 'degraded' || item.status === 'unhealthy' || item.status === 'offline')
    changeLog(exchange, 'assets.healthcheck', 'asset', 'batch', '健康巡检', `巡检 ${checked.length} 项，异常 ${abnormal.length} 项`)
    return {
      checkedAt: new Date().toISOString(),
      checked: checked.length,
      abnormal: abnormal.length,
      items: checked,
      abnormalItems: abnormal,
    }
  })

  // 资源/主体的展示名解析（成本报表与效益分析共用）
  const RESOURCE_KIND_LABELS: Record<string, string> = {
    mcp: 'MCP 服务', model: '模型路由', skill: 'Skill', nas: 'NAS 存储', app: 'AI 应用', agent: 'Agent',
  }
  const labelOfResource = (resource: string) => {
    const idx = resource.indexOf(':')
    const kind = idx >= 0 ? resource.slice(0, idx) : ''
    const key = idx >= 0 ? resource.slice(idx + 1) : resource
    const unnamed = `未命名${RESOURCE_KIND_LABELS[kind] ?? ''}资产`
    if (kind === 'mcp') return ctx.mcpRegistry.services().findOne((item) => item.slug === key)?.name ?? unnamed
    if (kind === 'model') return ctx.modelGateway.models().findOne((item) => item.slug === key)?.displayName ?? unnamed
    if (kind === 'skill') return ctx.skillHub.skills().get(key)?.name ?? unnamed
    if (kind === 'nas') return ctx.nasRegistry.get(key)?.name ?? unnamed
    if (kind === 'app') return ctx.resourceCore.list('app').find((item) => item.slug === key)?.name ?? unnamed
    // 资产已删除/未注册时不再以原始 ID 充当名称（消耗榜出现两遍 nas:nas_xxx 的可读性问题）
    return unnamed
  }
  const labelOfPrincipal = (principal: string) => {
    if (principal.startsWith('org:')) return ctx.iam.orgs().get(principal.slice(4))?.name ?? principal
    return principal
  }

  guarded('GET', '/api/assets/report', 'usage.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 30) || 30, 1), 90)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const { byResource, byPrincipal, byDay } = ctx.usage.breakdown(fromIso)
    return {
      days,
      totals: ctx.usage.totals({ from: fromIso }),
      topResources: byResource.slice(0, 20).map((row) => ({ ...row, label: labelOfResource(row.resource) })),
      byPrincipal: byPrincipal.map((row) => ({ ...row, label: labelOfPrincipal(row.principal) })),
      byDay,
    }
  })

  // -- 成本穿透（M0-3 用量透明口径）：内部采购成本参考 + 应用关联单位 DAU 成本 --------------
  // （零价快照下 charge_cents 恒 0，不再呈现收入/毛利等结算语义）
  guarded('GET', '/api/assets/benefit', 'usage.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 30) || 30, 1), 90)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const fromDay = fromIso.slice(0, 10)
    const appsBySlug = new Map(ctx.resourceCore.list('app').map((app) => [app.slug, app]))
    const rows = ctx.usage.breakdown(fromIso).byResource.map((row) => {
      const kind = row.resource.slice(0, row.resource.indexOf(':'))
      const key = row.resource.slice(row.resource.indexOf(':') + 1)
      const windowDau = kind === 'app' && appsBySlug.has(key)
        ? ctx.appRegistry.usage().find((item) => item.appId === appsBySlug.get(key)!.id && item.date >= fromDay)
          .reduce((sum, item) => sum + item.dau, 0)
        : null
      return {
        resource: row.resource,
        label: labelOfResource(row.resource),
        kind,
        count: row.count,
        cost_cents: row.cost_cents,
        window_dau: windowDau,
        cost_per_dau_cents: windowDau && windowDau > 0 ? Math.round(row.cost_cents / windowDau) : null,
      }
    }).sort((a, b) => b.cost_cents - a.cost_cents || b.count - a.count)
    return {
      days,
      totals: {
        count: rows.reduce((sum, row) => sum + row.count, 0),
        cost_cents: rows.reduce((sum, row) => sum + row.cost_cents, 0),
      },
      rows,
    }
  })

  // -- 技能热力图：skill × 日 使用矩阵（usage 事件为主，计量管道接入前的下载流水回填） ------
  guarded('GET', '/api/skills/usage-heatmap', 'skill.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 30) || 30, 7), 90)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const fromDay = fromIso.slice(0, 10)
    const counts = new Map<string, number>()
    const daysMetered = new Map<string, Set<string>>()
    for (const row of ctx.usage.matrix(fromIso, 'skill:')) {
      const skillId = row.resource.slice('skill:'.length)
      counts.set(`${skillId}|${row.day}`, (counts.get(`${skillId}|${row.day}`) ?? 0) + row.count)
      if (!daysMetered.has(skillId)) daysMetered.set(skillId, new Set())
      daysMetered.get(skillId)!.add(row.day)
    }
    // 回填：计量管道接入前的下载流水（同 skill 同日已有计量事件则不重复累计）
    for (const record of ctx.skillHub.downloads().all()) {
      const day = (record.createdAt ?? '').slice(0, 10)
      if (!day || day < fromDay) continue
      const skill = ctx.skillHub.skills().get(record.skillId)
      if (!skill || daysMetered.get(skill.id)?.has(day)) continue
      counts.set(`${skill.id}|${day}`, (counts.get(`${skill.id}|${day}`) ?? 0) + 1)
    }
    const axis: string[] = []
    for (let i = days - 1; i >= 0; i--) axis.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
    const bySkill = new Map<string, { slug: string; name: string; cells: Map<string, number>; total: number }>()
    for (const [key, count] of counts) {
      const separator = key.lastIndexOf('|')
      const skillId = key.slice(0, separator)
      const day = key.slice(separator + 1)
      let entry = bySkill.get(skillId)
      if (!entry) {
        const skill = ctx.skillHub.skills().get(skillId)
        entry = { slug: skill?.slug ?? skillId, name: skill?.name ?? skillId, cells: new Map(), total: 0 }
        bySkill.set(skillId, entry)
      }
      entry.cells.set(day, count)
      entry.total += count
    }
    const skills = [...bySkill.entries()].map(([skillId, entry]) => ({
      id: skillId,
      slug: entry.slug,
      name: entry.name,
      total: entry.total,
      cells: axis.map((day) => entry.cells.get(day) ?? 0),
    })).sort((a, b) => b.total - a.total).slice(0, 20)
    return { days: axis, skills, maxCell: Math.max(1, ...skills.flatMap((item) => item.cells)) }
  })

  // -- 下架分析：弃用/下线原因聚合（审计 change 日志 + 生命周期留痕 + Skill 落库原因） ------
  guarded('GET', '/api/assets/retire-reasons', 'usage.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 90) || 90, 1), 365)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const buckets = new Map<string, { reason: string; count: number; byType: Record<string, number>; latestAt: string; samples: Array<{ type: string; name: string; at: string }> }>()
    const bucketOf = (reason: string) => {
      const key = reason.trim() || '（未填写原因）'
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = { reason: key, count: 0, byType: {}, latestAt: '', samples: [] }
        buckets.set(key, bucket)
      }
      return bucket
    }
    const add = (reason: string, type: string, name: string, at: string) => {
      const bucket = bucketOf(reason)
      bucket.count++
      bucket.byType[type] = (bucket.byType[type] ?? 0) + 1
      if (at > bucket.latestAt) bucket.latestAt = at
      if (bucket.samples.length < 5) bucket.samples.push({ type, name, at })
    }
    // Skill 弃用原因以落库记录为准（P5 起持久化），无落库原因的历史弃用回退审计日志
    const skillReasonPersisted = new Set(
      ctx.skillHub.skills().all()
        .filter((skill) => skill.deprecatedAt && (skill.deprecatedAt ?? '') >= fromIso)
        .map((skill) => skill.id),
    )
    const RETIRE_ACTIONS = new Set(['skill.deprecate', 'mcp.service.offline', 'nas.offline', 'nas.archive'])
    for (const log of ctx.audit.logs().all()) {
      if (log.type !== 'change' || !RETIRE_ACTIONS.has(log.action)) continue
      if ((log.createdAt ?? '') < fromIso) continue
      if (log.action === 'skill.deprecate' && skillReasonPersisted.has(log.resourceId)) continue
      add(log.detail, log.resourceType, log.resourceName, log.createdAt)
    }
    for (const skill of ctx.skillHub.skills().all()) {
      if (!['deprecated', 'offline'].includes(skill.status)) continue
      if (!skill.deprecatedAt || skill.deprecatedAt < fromIso) continue
      add(skill.deprecatedReason ?? '', 'skill', skill.name, skill.deprecatedAt)
    }
    // Agent/应用下线经审批执行器落生命周期留痕（note 即下架原因），不经 change 日志
    for (const type of ['agent', 'app']) {
      for (const entity of ctx.resourceCore.list(type)) {
        for (const entry of entity.lifecycleHistory ?? []) {
          if (entry.action !== 'offline' || (entry.at ?? '') < fromIso) continue
          add(entry.note ?? '', type, entity.name, entry.at)
        }
      }
    }
    const reasons = [...buckets.values()].sort((a, b) => b.count - a.count)
    return { days, total: reasons.reduce((sum, bucket) => sum + bucket.count, 0), reasons }
  })

  // -- IAM ----------------------------------------------------------------
  guarded('GET', '/api/iam/orgs/tree', 'iam.org.read', () => ctx.iam.orgTree())

  guarded('GET', '/api/iam/orgs', 'iam.org.read', () => ctx.iam.orgs().all())

  guarded('POST', '/api/iam/orgs', 'iam.org.write', (exchange) => {
    const input = body<{ name: string; parentId?: string | null; order?: number }>(exchange)
    const org = ctx.iam.createOrg(input)
    changeLog(exchange, 'iam.org.create', 'org', org.id, org.name)
    return org
  })

  guarded('PATCH', '/api/iam/orgs/:id', 'iam.org.write', (exchange) => {
    const input = body<{ name?: string; parentId?: string | null; leaderUserIds?: string[] }>(exchange)
    if (input.name !== undefined) {
      const org = ctx.iam.renameOrg(exchange.params['id']!, input.name)
      changeLog(exchange, 'iam.org.rename', 'org', org.id, org.name)
    }
    if (input.parentId !== undefined) {
      ctx.iam.moveOrg(exchange.params['id']!, input.parentId)
      changeLog(exchange, 'iam.org.move', 'org', exchange.params['id']!, input.parentId)
    }
    if (Array.isArray(input.leaderUserIds)) {
      const org = ctx.iam.setOrgLeaders(exchange.params['id']!, input.leaderUserIds)
      changeLog(exchange, 'iam.org.leaders', 'org', org.id, org.name, `负责人：${input.leaderUserIds.join(',') || '（清空）'}`)
    }
    return ctx.iam.orgs().get(exchange.params['id']!)
  })

  guarded('DELETE', '/api/iam/orgs/:id', 'iam.org.write', (exchange) => {
    const input = body<{ cascade?: boolean }>(exchange)
    const result = ctx.iam.deleteOrg(exchange.params['id']!, { cascade: input.cascade === true })
    changeLog(exchange, 'iam.org.delete', 'org', exchange.params['id']!, '',
      input.cascade ? `级联一键删除：移除组织 ${result.removedOrgs} 个，账号上移 ${result.movedUsers} 人` : '')
    return result
  })

  guarded('GET', '/api/iam/users', 'iam.user.read', (exchange) => {
    const orgId = exchange.query.get('orgId') ?? undefined
    const status = exchange.query.get('status') ?? undefined
    const q = exchange.query.get('q') ?? undefined
    // 分页（测试 §9）：page/pageSize 可选，缺省返回全量保持旧客户端兼容
    const pageParam = Number(exchange.query.get('page') ?? 0)
    const sizeParam = Number(exchange.query.get('pageSize') ?? 0)
    const paginated = Number.isInteger(pageParam) && pageParam > 0 && Number.isInteger(sizeParam) && sizeParam > 0
    const page = paginated ? pageParam : 0
    const pageSize = paginated ? Math.min(500, sizeParam) : 0
    const orgScope = orgId ? new Set(ctx.iam.orgSubtreeIds(orgId)) : undefined
    const users = ctx.iam.users().find((user) => {
      if (status && user.status !== status) return false
      if (orgScope && !orgScope.has(user.orgId)) return false
      if (q && !`${user.displayName}${user.username}${user.email}`.toLowerCase().includes(q.toLowerCase())) return false
      return true
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const sliced = page > 0 && pageSize > 0 ? users.slice((page - 1) * pageSize, page * pageSize) : users
    return {
      total: users.length,
      ...(page > 0 && pageSize > 0 ? { page, pageSize } : {}),
      users: sliced.map((user) => decorateUser(ctx, user)),
    }
  })

  guarded('POST', '/api/iam/users', 'iam.user.write', (exchange) => {
    const input = body<{ username: string; displayName: string; orgId: string; title?: string; email?: string; phone?: string; roleIds?: string[]; password?: string }>(exchange)
    const actor = manageActor(exchange)
    const { user, initialPassword } = ctx.iam.createUser(input, actor)
    if (input.roleIds?.length) ctx.iam.assignRoles(user.id, input.roleIds, actor)
    ctx.iam.activateUser(user.id)
    changeLog(exchange, 'iam.user.create', 'user', user.id, user.displayName)
    return { ...decorateUser(ctx, ctx.iam.users().get(user.id)!), ...(initialPassword ? { initialPassword } : {}) }
  })

  guarded('POST', '/api/iam/users/:id/reset-password', 'iam.user.write', (exchange) => {
    const { password } = body<{ password?: string }>(exchange)
    const { user, initialPassword } = ctx.iam.resetPassword(exchange.params['id']!, password, manageActor(exchange))
    changeLog(exchange, 'iam.user.reset_password', 'user', user.id, user.displayName, password ? '设置为指定口令' : '重置为随机初始口令')
    return { id: user.id, username: user.username, initialPassword }
  })

  guarded('POST', '/api/iam/users/import', 'iam.user.write', (exchange) => {
    const { items } = body<{ items: Array<{ username: string; displayName: string; orgId: string; title?: string }> }>(exchange)
    const result = ctx.iam.importUsers(items ?? [])
    changeLog(exchange, 'iam.user.import', 'user', '', '', `新建 ${result.created.length}，跳过 ${result.skipped.length}`)
    return { created: result.created.map((user) => decorateUser(ctx, user)), skipped: result.skipped }
  })

  guarded('PATCH', '/api/iam/users/:id', 'iam.user.write', (exchange) => {
    const input = body<{ displayName?: string; email?: string; phone?: string; title?: string; orgId?: string; roleIds?: string[]; accountType?: 'internal' | 'external' | 'suspended-review'; primaryOrgId?: string }>(exchange)
    const actor = manageActor(exchange)
    const { roleIds, ...patch } = input
    const user = ctx.iam.updateUser(exchange.params['id']!, patch, actor)
    if (roleIds) ctx.iam.assignRoles(user.id, roleIds, actor)
    changeLog(exchange, 'iam.user.update', 'user', user.id, user.displayName)
    return decorateUser(ctx, ctx.iam.users().get(user.id)!)
  })

  for (const [action, permission] of [
    ['activate', 'iam.user.write'],
    ['freeze', 'iam.user.freeze'],
    ['unfreeze', 'iam.user.freeze'],
    ['deactivate', 'iam.user.freeze'],
  ] as const) {
    guarded('POST', `/api/iam/users/:id/${action}`, permission, (exchange) => {
      const { reason } = body<{ reason?: string }>(exchange)
      const id = exchange.params['id']!
      const actor = manageActor(exchange)
      const user = action === 'activate' ? ctx.iam.activateUser(id, actor)
        : action === 'freeze' ? ctx.iam.freezeUser(id, reason ?? '', actor)
          : action === 'unfreeze' ? ctx.iam.unfreezeUser(id, actor)
            : ctx.iam.deactivateUser(id, reason ?? '', actor)
      changeLog(exchange, `iam.user.${action}`, 'user', user.id, user.displayName, reason ?? '')
      return decorateUser(ctx, user)
    })
  }

  guarded('POST', '/api/iam/users/:id/bindings', 'iam.user.write', (exchange) => {
    const input = body<{ provider: 'dingtalk' | 'feishu' | 'wecom'; unionId: string; displayName?: string; verifyCode?: string }>(exchange)
    const user = ctx.iam.bindThirdParty(exchange.params['id']!, { ...input, displayName: input.displayName ?? input.unionId }, manageActor(exchange))
    changeLog(exchange, 'iam.user.bind', 'user', user.id, user.displayName, input.provider)
    return decorateUser(ctx, user)
  })

  guarded('DELETE', '/api/iam/users/:id/bindings/:provider', 'iam.user.write', (exchange) => {
    const { verifyCode } = body<{ verifyCode: string }>(exchange)
    const user = ctx.iam.unbindThirdParty(exchange.params['id']!, exchange.params['provider']! as 'dingtalk', verifyCode, manageActor(exchange))
    changeLog(exchange, 'iam.user.unbind', 'user', user.id, user.displayName, exchange.params['provider'])
    return decorateUser(ctx, user)
  })

  guarded('GET', '/api/iam/roles', 'iam.org.read', () => ({
    roles: ctx.iam.roles().all(),
    catalog: PermissionCatalog,
  }))

  guarded('GET', '/api/iam/permissions', 'iam.org.read', () => {
    return { catalog: PermissionCatalog }
  })

  guarded('POST', '/api/iam/roles', 'iam.role.write', (exchange) => {
    const input = body<{ code: string; name: string; description?: string; permissions: string[] }>(exchange)
    const role = ctx.iam.createRole(input)
    changeLog(exchange, 'iam.role.create', 'role', role.id, role.name)
    return role
  })

  guarded('PATCH', '/api/iam/roles/:id', 'iam.role.write', (exchange) => {
    const input = body<{ name?: string; description?: string; permissions?: string[] }>(exchange)
    const role = ctx.iam.updateRole(exchange.params['id']!, input)
    changeLog(exchange, 'iam.role.update', 'role', role.id, role.name)
    return role
  })

  // -- 场景级授权（IAW 交接 6-1：角色 × 场景 ABAC） ------------------------------
  // 策略治理走 iam.org.read/iam.scene.write；自检 checkScene 对 panel.read 持有者开放（面板选择器用）。
  guarded('GET', '/api/iam/scene-policies', 'iam.org.read', (exchange) => ({
    policies: ctx.iam.scenePolicies().all()
      .filter((policy) => (exchange.query.get('sceneCode') ? policy.sceneCode === exchange.query.get('sceneCode') : true)),
  }))

  guarded('PUT', '/api/iam/scene-policies', 'iam.scene.write', (exchange) => {
    const input = body<{ sceneCode: string; orgId?: string; entries: Array<{ principalType: 'role' | 'user'; principalId: string; actions: string[]; effect: 'allow' | 'deny' }>; note?: string; expectedVersion?: number }>(exchange)
    const policy = ctx.iam.upsertScenePolicy({
      sceneCode: input.sceneCode,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      entries: input.entries ?? [],
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    })
    changeLog(exchange, 'iam.scene_policy.upsert', 'scene_policy', policy.id, policy.sceneCode, `${policy.entries.length} 条，v${policy.version}`)
    return policy
  })

  guarded('DELETE', '/api/iam/scene-policies/:id', 'iam.scene.write', (exchange) => {
    const result = ctx.iam.deleteScenePolicy(exchange.params['id']!)
    changeLog(exchange, 'iam.scene_policy.delete', 'scene_policy', exchange.params['id']!, exchange.query.get('sceneCode') ?? '')
    return result
  })

  /**
   * 场景访问自检（iam.check(scene, action) 的 HTTP 面）：panel.read 持有者查自己的场景判定。
   * userId 参数仅 iam.user.read 持有者可代查（治理面排障）；其余主体强制自查。
   */
  guarded('POST', '/api/iam/scene-authz/check', 'panel.read', (exchange) => {
    const info = caller(exchange)
    const input = body<{ sceneCode: string; action: string; userId?: string }>(exchange)
    if (!input.sceneCode?.trim() || !input.action?.trim()) {
      exchange.fail(400, 'BAD_REQUEST', 'sceneCode 与 action 必填')
      return
    }
    let targetUserId = info.userId ?? ''
    if (input.userId && input.userId !== info.userId) {
      if (!info.permissions.includes('*') && !info.permissions.includes('iam.user.read')) {
        exchange.fail(403, 'FORBIDDEN', '代查他人场景判定需要 iam.user.read')
        return
      }
      targetUserId = input.userId
    }
    if (!targetUserId) {
      exchange.fail(403, 'FORBIDDEN', '机器主体请携带 userId 参数且调用方需持有 iam.user.read')
      return
    }
    const decision = ctx.iam.checkScene(targetUserId, input.sceneCode, input.action)
    changeLog(exchange, 'iam.scene_policy.check', 'scene_policy', input.sceneCode, input.action, `${decision.decision}（${targetUserId}）`)
    return { ...decision, checkedUser: targetUserId }
  })

  guarded('GET', '/api/iam/groups', 'iam.user.read', () => ({
    groups: ctx.iam.groups().all().map((group) => ({
      ...group,
      resolvedMembers: ctx.iam.resolveGroupMembers(group.id).map((user) => ({ id: user.id, displayName: user.displayName, title: user.title })),
    })),
  }))

  guarded('POST', '/api/iam/groups', 'iam.user.write', (exchange) => {
    const input = body<{ name: string; type: 'static' | 'dynamic'; rule?: { orgIds?: string[]; title?: string }; memberIds?: string[]; description?: string }>(exchange)
    const group = ctx.iam.createGroup(input)
    changeLog(exchange, 'iam.group.create', 'user_group', group.id, group.name)
    return group
  })

  guarded('PATCH', '/api/iam/groups/:id', 'iam.user.write', (exchange) => {
    const group = ctx.iam.updateGroup(exchange.params['id']!, body(exchange))
    changeLog(exchange, 'iam.group.update', 'user_group', group.id, group.name)
    return group
  })

  guarded('DELETE', '/api/iam/groups/:id', 'iam.user.write', (exchange) => {
    ctx.iam.deleteGroup(exchange.params['id']!)
    changeLog(exchange, 'iam.group.delete', 'user_group', exchange.params['id']!, '')
    return { deleted: true }
  })

  /** 动态用户组重算快照 + 漂移告警（dev-plan-nas-authz §2.2；连接器同步收尾亦自动执行）。 */
  guarded('POST', '/api/iam/groups/refresh-snapshots', 'iam.user.write', (exchange) => {
    const drifts = ctx.iam.refreshGroupSnapshots(caller(exchange).name)
    changeLog(exchange, 'iam.group.refresh_snapshots', 'user_group', '', '', `漂移 ${drifts.length} 组`)
    return { drifts }
  })

  // 三方连接器
  guarded('GET', '/api/iam/connectors', 'iam.org.read', () => ({
    providers: ctx.iam.connectorProviders(),
    configs: ctx.iam.connectorConfigs().all().map(({ secretActual, ...config }) => {
      void secretActual
      return config
    }),
  }))

  // 新增接入主体：同一 provider 可接入多家企业（多套 corpId/appKey/appSecret），各自独立配置/同步/登录
  guarded('POST', '/api/iam/connectors', 'iam.connector.write', (exchange) => {
    const input = body<{ provider: 'dingtalk' | 'feishu' | 'wecom'; name: string; corpId: string; appKey: string; appSecret?: string; enabled?: boolean; syncOrgRoot?: string; intervalMinutes?: number; callbackUrl?: string; loginEnabled?: boolean; conflictStrategy?: 'third_party_wins' | 'platform_wins' | 'manual'; mode?: 'real' | 'mock'; apiBase?: string; oapiBase?: string; targetOrgId?: string }>(exchange)
    if (!input.provider || !input.name || !input.corpId || !input.appKey) {
      exchange.fail(400, 'BAD_REQUEST', 'provider、name、corpId、appKey 必填')
      return
    }
    const config = ctx.iam.createConnectorConfig(input)
    changeLog(exchange, 'iam.connector.create', 'connector', config.id, config.name ?? config.provider)
    const { secretActual, ...safe } = config
    void secretActual
    return safe
  })

  // 参数语义 idOrProvider：先按配置 id / provider 解析已有配置（命中按 id 更新）；
  // 未命中且 param 为平台类型时维持旧行为（按 provider 第一条更新，无则新建）
  guarded('PUT', '/api/iam/connectors/:param', 'iam.connector.write', (exchange) => {
    const param = exchange.params['param']!
    const input = body<{ name?: string; corpId: string; appKey: string; appSecret?: string; enabled?: boolean; syncOrgRoot?: string; intervalMinutes?: number; callbackUrl?: string; loginEnabled?: boolean; conflictStrategy?: 'third_party_wins' | 'platform_wins' | 'manual'; mode?: 'real' | 'mock'; apiBase?: string; oapiBase?: string; targetOrgId?: string }>(exchange)
    const existing = ctx.iam.resolveConnectorConfig(param)
    if (!existing && !['dingtalk', 'feishu', 'wecom'].includes(param)) {
      exchange.fail(400, 'BAD_REQUEST', `连接器配置不存在：${param}`)
      return
    }
    const config = existing
      ? ctx.iam.upsertConnectorConfig({ id: existing.id, provider: existing.provider, ...input })
      : ctx.iam.upsertConnectorConfig({ provider: param as 'dingtalk', ...input })
    changeLog(exchange, 'iam.connector.update', 'connector', config.id, config.name ?? config.provider)
    const { secretActual, ...safe } = config
    void secretActual
    return safe
  })

  guarded('DELETE', '/api/iam/connectors/:id', 'iam.connector.write', (exchange) => {
    const config = ctx.iam.connectorConfigById(exchange.params['id']!)
    if (!config) {
      exchange.fail(400, 'BAD_REQUEST', `连接器配置不存在：${exchange.params['id']}`)
      return
    }
    ctx.iam.deleteConnectorConfig(config.id)
    changeLog(exchange, 'iam.connector.delete', 'connector', config.id, config.name ?? config.provider)
    return { deleted: true }
  })

  guarded('POST', '/api/iam/connectors/:param/test', 'iam.connector.write', async (exchange) => {
    return await ctx.iam.testConnector(exchange.params['param']!)
  })

  guarded('POST', '/api/iam/connectors/:param/sync', 'iam.connector.write', async (exchange) => {
    const info = caller(exchange)
    const param = exchange.params['param']!
    const result = await ctx.iam.syncConnector(param, info.userId ?? info.principalId)
    const config = ctx.iam.resolveConnectorConfig(param)
    changeLog(exchange, 'iam.connector.sync', 'connector', config?.id ?? param, config?.name ?? config?.provider ?? param, result.message)
    return result
  })

  // 连接器自动同步的手动触发口：立即巡检全部到期配置（定时器每分钟自动跑同一逻辑，
  // IAM_CONNECTOR_AUTO_SYNC=off 停用定时器后可改由外部调度调本端点）。
  guarded('POST', '/api/iam/connectors/auto-sync', 'iam.connector.write', async (exchange) => {
    const results = await ctx.iam.runDueAutoSyncs()
    changeLog(exchange, 'iam.connector.auto-sync', 'connector', 'auto-sync', '连接器到期巡检', `处理 ${results.length} 条（${results.filter((item) => item.ok).length} 成功）`)
    return { processed: results.length, results }
  })

  // 全员名册（组织数据通道）：接入应用（人事/绩效等）以机器凭证批量拉取在职账号与组织树。
  // 授权=iam.roster.read（应用注册凭证经「统一认证中心」追加 scope；org_admin 经 iam.* 通配自带）；
  // 批量 PII 出口，每次拉取记 invoke 审计（谁在何时拉了多少）。
  guarded('GET', '/api/iam/roster', 'iam.roster.read', (exchange) => {
    const info = caller(exchange)
    const roster = ctx.iam.roster()
    ctx.audit.record({
      type: 'invoke',
      actorType: info.kind === 'human' ? 'human' : 'machine',
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      action: 'iam.roster.pull',
      resourceType: 'roster',
      resourceId: 'roster',
      resourceName: '全员名册',
      result: 'ok',
      detail: `orgs=${roster.orgs.length} users=${roster.users.length}`,
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    })
    return roster
  })

  guarded('GET', '/api/iam/conflicts', 'iam.org.read', (exchange) => ({
    conflicts: ctx.iam.conflicts().find((item) => item.status === (exchange.query.get('status') ?? 'pending')),
  }))

  guarded('POST', '/api/iam/conflicts/:id/resolve', 'iam.user.write', (exchange) => {
    const { keep } = body<{ keep: 'third_party' | 'platform' }>(exchange)
    const info = caller(exchange)
    const conflict = ctx.iam.resolveConflict(exchange.params['id']!, keep, info.userId ?? info.principalId)
    changeLog(exchange, 'iam.conflict.resolve', 'sync_conflict', conflict.id, '', `保留 ${keep}`)
    return conflict
  })

  // -- Authn --------------------------------------------------------------
  guarded('GET', '/api/authn/principals', 'authn.principal.read', () => ({
    principals: ctx.authn.principals().all().map((principal) => {
      // 脱敏：clientSecretHash 为签名级凭证哈希，一律不外发
      const { clientSecretHash, ...safe } = principal
      void clientSecretHash
      // 机器主体补充角色明细与解析后的生效权限（前端展示用）
      const roleNames = (principal.roleIds ?? [])
        .map((roleId) => ctx.iam.roles().get(roleId)?.name)
        .filter((name): name is string => Boolean(name))
      return {
        ...safe,
        roleNames,
        resolvedScopes: principal.type === 'machine' ? ctx.authn.resolveMachineScopes(principal) : safe.scopes,
        activeTokens: ctx.authn.activeTokenCount(principal.id),
      }
    }),
  }))

  /** 机器凭证可绑定的已注册资源（签发弹窗下拉/搜索用：选择后自动回填 refType/refId）。 */
  guarded('GET', '/api/authn/bindable-resources', 'authn.principal.read', () => ({
    agents: ctx.resourceCore.list('agent').map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })),
    apps: ctx.resourceCore.list('app').map((app) => ({ id: app.id, name: app.name, status: app.status })),
  }))

  guarded('POST', '/api/authn/principals', 'authn.principal.write', (exchange) => {
    const input = body<{ name: string; refType?: 'agent' | 'app' | 'external'; refId?: string; roleIds?: string[]; scopes: string[] }>(exchange)
    const created = ctx.authn.createMachineCredential(input)
    const summary = [input.roleIds?.length ? `角色×${input.roleIds.length}` : '', input.scopes.length ? `权限点×${input.scopes.length}` : ''].filter(Boolean).join(' + ')
    changeLog(exchange, 'authn.principal.create', 'principal', created.principal.id, input.name, input.refId ? `绑定 ${input.refType}:${input.refId} · ${summary}` : summary)
    return { principalId: created.principal.id, clientId: created.clientId, clientSecret: created.clientSecret, note: '密钥仅此一次返回' }
  })

  guarded('POST', '/api/authn/principals/:id/disable', 'authn.principal.write', (exchange) => {
    const { reason } = body<{ reason?: string }>(exchange)
    const principal = ctx.authn.disablePrincipal(exchange.params['id']!, reason ?? '手动禁用')
    changeLog(exchange, 'authn.principal.disable', 'principal', principal.id, principal.name, reason ?? '')
    return principal
  })

  guarded('POST', '/api/authn/principals/:id/enable', 'authn.principal.write', (exchange) => {
    const principal = ctx.authn.enablePrincipal(exchange.params['id']!)
    changeLog(exchange, 'authn.principal.enable', 'principal', principal.id, principal.name)
    return principal
  })

  guarded('PATCH', '/api/authn/principals/:id', 'authn.principal.write', (exchange) => {
    const { roleIds, scopes } = body<{ roleIds?: string[]; scopes?: string[] }>(exchange)
    const hasRoles = Array.isArray(roleIds)
    const hasScopes = Array.isArray(scopes)
    if ((!hasRoles && !hasScopes) || (hasRoles && roleIds!.some((id) => typeof id !== 'string')) || (hasScopes && scopes!.some((scope) => typeof scope !== 'string'))) {
      exchange.fail(400, 'BAD_REQUEST', 'roleIds / scopes 至少提供一项（字符串数组）')
      return
    }
    const principal = ctx.authn.updateMachineScopes(exchange.params['id']!, {
      ...(hasRoles ? { roleIds } : {}),
      ...(hasScopes ? { scopes } : {}),
    })
    changeLog(exchange, 'authn.principal.scopes', 'principal', principal.id, principal.name, [principal.roleIds?.length ? `角色×${principal.roleIds.length}` : '', scopes?.length ? `权限点×${scopes.length}` : ''].filter(Boolean).join(' + '))
    const { clientSecretHash, ...safe } = principal
    void clientSecretHash
    return safe
  })

  guarded('POST', '/api/authn/principals/:id/rotate-secret', 'authn.principal.write', (exchange) => {
    const rotated = ctx.authn.rotateMachineCredential(exchange.params['id']!)
    changeLog(exchange, 'authn.principal.rotate', 'principal', rotated.principal.id, rotated.principal.name, '旧 secret 立即失效')
    return { clientId: rotated.principal.clientId, clientSecret: rotated.clientSecret, note: '新 clientSecret 仅此一次返回，旧值立即失效，存量令牌已全部吊销' }
  })

  guarded('GET', '/api/authn/tokens', 'authn.principal.read', (exchange) => {
    const principalId = exchange.query.get('principalId') ?? undefined
    const tokens = ctx.authn.tokens().find((token) => (principalId ? token.principalId === principalId : true))
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
    return {
      total: tokens.length,
      tokens: tokens.slice(0, 200).map((token) => {
        // 脱敏：refreshHash 为签名级敏感凭证哈希，sid/chainId 属会话内部标识，一律不外发
        const { refreshHash, sid, chainId, ...rest } = token
        void refreshHash; void sid; void chainId
        return {
          ...rest,
          principalName: ctx.authn.principals().get(token.principalId)?.name ?? '',
        }
      }),
    }
  })

  guarded('POST', '/api/authn/tokens', 'authn.token.issue', (exchange) => {
    const input = body<{ principalId: string; ttlHours?: number; reason?: string; audience?: string; scopes?: string[] }>(exchange)
    const principal = ctx.authn.principals().get(input.principalId)
    if (!principal) throw new Error(`身份不存在：${input.principalId}`)
    const { token, record } = ctx.authn.issueToken(input.principalId, {
      kind: 'access',
      ttlHours: input.ttlHours,
      scopes: input.scopes ?? principal.scopes,
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      issuedBy: `console:${caller(exchange).name}`,
    })
    changeLog(exchange, 'authn.token.issue', 'token', record.jti, record.jti, input.reason ?? '')
    return { token, jti: record.jti, expiresAt: record.expiresAt }
  })

  // 受众校验自检（令牌内省：验证 aud 收紧语义，供运维与联调使用）
  http.register('POST', '/api/authn/verify-audience', async (exchange) => {
    const info = caller(exchange)
    if (!info.permissions.includes('*') && !info.permissions.includes('authn.principal.read')) {
      exchange.fail(403, 'FORBIDDEN', '缺少权限点 authn.principal.read')
      return
    }
    const input = body<{ token: string; audience: string }>(exchange)
    if (!input.token || !input.audience) {
      exchange.fail(400, 'BAD_REQUEST', 'token 与 audience 必填')
      return
    }
    try {
      const verified = ctx.authn.verify(input.token, { audience: input.audience })
      exchange.ok({ valid: true, principalId: verified.principal.id, scopes: verified.scopes })
    } catch (error) {
      exchange.ok({ valid: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }, { access: 'guarded', permission: 'authn.principal.read' })

  guarded('DELETE', '/api/authn/tokens/:jti', 'authn.token.revoke', (exchange) => {
    const { reason } = body<{ reason?: string }>(exchange)
    const record = ctx.authn.revokeToken(exchange.params['jti']!, reason ?? '控制台吊销')
    changeLog(exchange, 'authn.token.revoke', 'token', record.jti, record.jti, reason ?? '')
    return record
  })

  guarded('POST', '/api/authn/rotate-secret', 'authn.token.revoke', (exchange) => {
    const result = ctx.authn.rotateSigningSecret()
    changeLog(exchange, 'authn.secret.rotate', 'platform', 'signing-secret', '', `签名密钥轮换（旧密钥 ${result.graceMs / 3600_000}h 宽限期内仍可验签）`)
    return { rotated: true, graceHours: result.graceMs / 3600_000 }
  })

  // OIDC 客户端管理（模式 B：外部应用以平台为 IdP；管理员全局兜底面）
  guarded('GET', '/api/authn/oidc/clients', 'authn.oidc.read', () => ({
    clients: ctx.oidc.listClients().map((client) => ({
      ...client,
      status: client.status ?? 'active',
      clientType: client.clientType ?? 'confidential',
      discovery: {
        issuer: ctx.oidc.issuer(),
        authorization_endpoint: `${ctx.oidc.issuer()}/oauth/authorize`,
        token_endpoint: `${ctx.oidc.issuer()}/oauth/token`,
        userinfo_endpoint: `${ctx.oidc.issuer()}/oauth/userinfo`,
      },
    })),
  }))

  guarded('POST', '/api/authn/oidc/clients', 'authn.oidc.write', (exchange) => {
    const input = body<{ name: string; redirectUris: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[]; clientType?: 'confidential' | 'public' }>(exchange)
    if (!input.name || !Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
      throw new Error('name 与 redirectUris（至少一个回调地址）必填')
    }
    AppRegistryService.assertRedirectUris(input.redirectUris)
    const created = ctx.oidc.createClient({
      name: input.name,
      redirectUris: input.redirectUris,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.consentRequired !== undefined ? { consentRequired: input.consentRequired } : {}),
      ...(input.postLogoutUris !== undefined ? { postLogoutUris: input.postLogoutUris } : {}),
      ...(input.clientType !== undefined ? { clientType: input.clientType } : {}),
    })
    changeLog(exchange, 'authn.oidc.client.create', 'oidc_client', created.client.id, created.client.name, input.clientType === 'public' ? 'public 客户端（免 secret）' : '')
    return { clientId: created.client.clientId, clientSecret: created.clientSecret, redirectUris: created.client.redirectUris, note: created.client.clientType === 'public' ? 'public 客户端无 secret（强制 PKCE）' : 'clientSecret 仅此一次返回' }
  })

  guarded('PATCH', '/api/authn/oidc/clients/:id', 'authn.oidc.write', (exchange) => {
    const input = body<{ name?: string; redirectUris?: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[] }>(exchange)
    const updated = ctx.oidc.updateClient(exchange.params['id']!, input)
    changeLog(exchange, 'authn.oidc.client.update', 'oidc_client', updated.id, updated.name)
    return updated
  })

  guarded('POST', '/api/authn/oidc/clients/:id/rotate', 'authn.oidc.write', (exchange) => {
    const rotated = ctx.oidc.rotateSecret(exchange.params['id']!)
    changeLog(exchange, 'authn.oidc.client.rotate', 'oidc_client', rotated.client.id, rotated.client.name, '旧 secret 立即失效')
    return { clientId: rotated.client.clientId, clientSecret: rotated.clientSecret, note: '新 clientSecret 仅此一次返回，旧值立即失效' }
  })

  for (const [action, label] of [['disable', '禁用'], ['enable', '启用']] as const) {
    guarded('POST', `/api/authn/oidc/clients/:id/${action}`, 'authn.oidc.write', (exchange) => {
      const { reason } = body<{ reason?: string }>(exchange)
      const client = action === 'disable'
        ? ctx.oidc.disableClient(exchange.params['id']!, reason ?? '控制台手动禁用')
        : ctx.oidc.enableClient(exchange.params['id']!)
      changeLog(exchange, `authn.oidc.client.${action}`, 'oidc_client', client.id, client.name, reason ?? '')
      return client
    })
  }

  /** JWKS 签名密钥轮换：新 key 立即签名，旧 key 24h 验签宽限（在途令牌不掉线）。 */
  guarded('POST', '/api/authn/oidc/keys/rotate', 'authn.oidc.write', (exchange) => {
    const result = ctx.oidc.rotateKeys()
    changeLog(exchange, 'authn.oidc.keys.rotate', 'platform', 'oidc-keys', '', `新 kid=${result.kid}，旧 key ${result.graceHours}h 宽限`)
    return { rotated: true, kid: result.kid, graceHours: result.graceHours }
  })

  guarded('GET', '/api/authn/oidc/discovery', 'authn.principal.read', () => ctx.oidc.discovery())

  // -- MCP ----------------------------------------------------------------
  guarded('GET', '/api/mcp/services', 'mcp.service.read', () => ({
    services: ctx.mcpRegistry.services().all().map(maskServiceHeaders),
    overview: ctx.mcpRegistry.metricsOverview(),
  }))

  guarded('POST', '/api/mcp/services', 'mcp.service.write', (exchange) => {
    const input = body<{ name: string; slug?: string; description?: string; icon?: string; endpoint?: string; transport?: 'stdio' | 'sse' | 'http'; mode?: 'hosted' | 'external'; orgId?: string; headers?: Record<string, string>; tools?: Array<{ name: string; description: string; riskLevel?: 'read' | 'write' | 'admin'; inputSchema?: Record<string, unknown> }> }>(exchange)
    // orgId 缺省回落根组织（与 /api/mcp/import 同口径）：外部推送方（机器凭证）无需 iam.org.read 即可注册
    const orgId = input.orgId ?? ctx.iam.orgs().findOne((org) => org.parentId === null)?.id
    const service = ctx.mcpRegistry.createService({
      ...input,
      ...(orgId ? { orgId } : {}),
      owner: caller(exchange).name,
      ...(input.tools ? { tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        riskLevel: tool.riskLevel ?? 'read',
        // 完整透传外部工具的 inputSchema（导入链路的关键信息），仅缺省时兜底空对象
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' && Object.keys(tool.inputSchema).length > 0
          ? tool.inputSchema
          : { type: 'object', properties: {}, additionalProperties: true },
      })) } : {}),
    })
    changeLog(exchange, 'mcp.service.create', 'mcp_service', service.id, service.name)
    return maskServiceHeaders(service)
  })

  /** mcpServers JSON 一键导入：解析 → 注册外部服务 → 自动发现工具 →（默认）验证上线。 */
  guarded('POST', '/api/mcp/import', 'mcp.service.write', async (exchange) => {
    const input = body<{ config: string | object; autoDeploy?: boolean }>(exchange)
    const rootOrg = ctx.iam.orgs().findOne((org) => org.parentId === null)
    if (!rootOrg) throw new Error('组织数据未初始化，无法导入')
    const result = await ctx.mcpRegistry.importServices({
      config: input.config,
      orgId: rootOrg.id,
      owner: caller(exchange).name,
      ...(input.autoDeploy !== undefined ? { autoDeploy: input.autoDeploy } : {}),
    })
    for (const item of result.results) {
      if (item.ok && item.serviceId) changeLog(exchange, 'mcp.service.import', 'mcp_service', item.serviceId, item.name, `tools=${item.tools ?? 0} reachable=${item.reachable}`)
    }
    return result
  })

  /** 外部服务工具同步：以远端 tools/list 为准刷新本地工具清单。 */
  guarded('POST', '/api/mcp/services/:id/sync-tools', 'mcp.service.write', async (exchange) => {
    const service = await ctx.mcpRegistry.syncTools(exchange.params['id']!)
    changeLog(exchange, 'mcp.service.syncTools', 'mcp_service', service.id, service.name, `tools=${service.tools.length}`)
    return maskServiceHeaders(service)
  })

  guarded('PATCH', '/api/mcp/services/:id', 'mcp.service.write', (exchange) => {
    const service = ctx.mcpRegistry.updateService(exchange.params['id']!, body(exchange))
    changeLog(exchange, 'mcp.service.update', 'mcp_service', service.id, service.name)
    return maskServiceHeaders(service)
  })

  guarded('POST', '/api/mcp/services/:id/verify', 'mcp.service.deploy', async (exchange) => {
    const service = await ctx.mcpRegistry.verifyService(exchange.params['id']!)
    changeLog(exchange, 'mcp.service.verify', 'mcp_service', service.id, service.name)
    return service
  })

  /**
   * MCP 服务公司级终审标记（WP-10/L1）：终审通过后，该服务全部调用记录附带水印
   * （watermark.finalReview），标记与水印在审计/调用台账双侧可追溯。
   */
  guarded('POST', '/api/mcp/services/:id/final-review', 'mcp.service.deploy', (exchange) => {
    const id = exchange.params['id']!
    const service = ctx.mcpRegistry.services().get(id)
    if (!service) throw new Error(`MCP 服务不存在：${id}`)
    const info = caller(exchange)
    const mark = { approverId: info.userId ?? info.principalId, approverName: info.name, at: new Date().toISOString() }
    const updated = ctx.mcpRegistry.services().update(id, { finalReview: mark })
    changeLog(exchange, 'mcp.final_review', 'mcp_service', id, service.name, '公司级终审标记：后续调用将附带水印')
    return { id, finalReview: updated.finalReview }
  })

  guarded('POST', '/api/mcp/services/:id/deploy', 'mcp.service.deploy', async (exchange) => {
    const input = body<{ grayPercent?: number; version?: string; changelog?: string; dryRun?: boolean }>(exchange)
    const id = exchange.params['id']!
    const impact = ctx.resourceCore.impact('mcp_service', id)
    if (input.dryRun) return { dryRun: true, impact }
    const service = await ctx.mcpRegistry.deployService(id, { ...input, actor: caller(exchange).name })
    changeLog(exchange, 'mcp.service.deploy', 'mcp_service', service.id, service.name, `v${service.currentVersion} gray=${service.grayPercent}%`)
    return service
  })

  guarded('POST', '/api/mcp/services/:id/rollback', 'mcp.service.deploy', async (exchange) => {
    const { targetVersion } = body<{ targetVersion: string }>(exchange)
    const service = await ctx.mcpRegistry.rollbackService(exchange.params['id']!, targetVersion, caller(exchange).name)
    changeLog(exchange, 'mcp.service.rollback', 'mcp_service', service.id, service.name, targetVersion)
    return service
  })

  guarded('POST', '/api/mcp/services/:id/offline', 'mcp.service.offline', (exchange) => {
    const { reason, viaApproval } = body<{ reason?: string; viaApproval?: boolean }>(exchange)
    if (!reason?.trim()) throw new Error('下线必须填写原因（护栏要求，下架分析依赖该口径）')
    const id = exchange.params['id']!
    if (viaApproval !== false) {
      const impact = ctx.resourceCore.impact('mcp_service', id)
      const approval = ctx.mcpRegistry.requestOfflineApproval(id, { id: caller(exchange).userId ?? caller(exchange).principalId, name: caller(exchange).name }, reason ?? '', impact.map((item) => `${item.name}（${item.type}）`))
      return { approval, note: '已创建 L4 审批单' }
    }
    const service = ctx.mcpRegistry.offlineService(id, caller(exchange).name, reason ?? '')
    changeLog(exchange, 'mcp.service.offline', 'mcp_service', service.id, service.name, reason ?? '')
    return service
  })

  /** 删除 MCP 服务：仅已下线可删；被权限组引用时拒绝；调用明细与审计数据保留。 */
  guarded('DELETE', '/api/mcp/services/:id', 'mcp.service.write', (exchange) => {
    const id = exchange.params['id']!
    const service = ctx.mcpRegistry.services().get(id)
    if (!service) throw new Error(`MCP 服务不存在：${id}`)
    if (service.status !== 'offline') throw new Error(`当前状态 ${service.status} 不可删除，请先下线服务`)
    const referencingGroups = ctx.mcpRegistry.permGroups().find((group) => Object.keys(group.policies).includes(id))
    if (referencingGroups.length > 0) {
      throw new Error(`该服务仍被权限组引用（${referencingGroups.map((group) => group.name).join('、')}），请先从权限组中移除`)
    }
    ctx.mcpRegistry.purgeService(id)
    changeLog(exchange, 'mcp.service.delete', 'mcp_service', id, service.name)
    return { deleted: true }
  })

  guarded('POST', '/api/mcp/services/:id/health', 'mcp.service.deploy', async (exchange) => {
    return await ctx.mcpRegistry.healthCheck(exchange.params['id']!)
  })

  guarded('GET', '/api/mcp/services/:id/metrics', 'mcp.service.read', (exchange) => {
    return ctx.mcpRegistry.serviceMetrics(exchange.params['id']!)
  })

  guarded('GET', '/api/mcp/calls', 'mcp.service.read', (exchange) => {
    return ctx.mcpRegistry.callLog({
      serviceId: exchange.query.get('serviceId') ?? undefined,
      callerId: exchange.query.get('callerId') ?? undefined,
      status: exchange.query.get('status') ?? undefined,
      limit: Number(exchange.query.get('limit') ?? 100),
    })
  })

  guarded('GET', '/api/mcp/perm-groups', 'mcp.service.read', () => ({ groups: ctx.mcpRegistry.permGroups().all() }))

  guarded('POST', '/api/mcp/perm-groups', 'mcp.permgroup.write', (exchange) => {
    const input = body<{ name: string; description?: string; policies: Record<string, { allowedTools: '*' | string[]; constraints?: { readOnly?: boolean } }>; subjects: Array<{ type: 'user_group' | 'agent' | 'app'; id: string; name?: string }> }>(exchange)
    const group = ctx.mcpRegistry.createPermGroup({
      name: input.name,
      description: input.description,
      policies: Object.fromEntries(Object.entries(input.policies).map(([serviceId, policy]) => [
        serviceId,
        { allowedTools: policy.allowedTools, constraints: policy.constraints ?? {} },
      ])),
      subjects: input.subjects,
    })
    changeLog(exchange, 'mcp.permgroup.create', 'mcp_perm_group', group.id, group.name)
    return group
  })

  guarded('PATCH', '/api/mcp/perm-groups/:id', 'mcp.permgroup.write', (exchange) => {
    const group = ctx.mcpRegistry.updatePermGroup(exchange.params['id']!, body(exchange))
    changeLog(exchange, 'mcp.permgroup.update', 'mcp_perm_group', group.id, group.name)
    return group
  })

  guarded('DELETE', '/api/mcp/perm-groups/:id', 'mcp.permgroup.write', (exchange) => {
    ctx.mcpRegistry.deletePermGroup(exchange.params['id']!)
    changeLog(exchange, 'mcp.permgroup.delete', 'mcp_perm_group', exchange.params['id']!, '')
    return { deleted: true }
  })

  guarded('POST', '/api/mcp/invoke', 'mcp.invoke', async (exchange) => {
    const input = body<{ serviceId: string; tool: string; args?: Record<string, unknown> }>(exchange)
    const info = caller(exchange)
    return await ctx.mcpRegistry.invoke({
      ...resolveMcpCaller(info),
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
      ...(info.actChain.length > 0 ? { onBehalfOf: info.actChain[0]!.name } : {}),
    }, input.serviceId, input.tool, input.args ?? {})
  })

  // -- 连接器纳管（open-connector 融合） ------------------------------------
  // 路由集中在 console（仓内铁律），业务逻辑全在 plugin-connector；OcError 的错误码/状态
  // 原样透传（oauth_client_config_required→向导指引、connection_not_allowed→403 等）。
  const runWithOcErrors = async (exchange: HttpExchange, handler: () => Promise<unknown> | unknown): Promise<unknown> => {
    try {
      return await handler()
    } catch (error) {
      const status = (error as { status?: unknown }).status
      const code = (error as { code?: unknown }).code
      const message = error instanceof Error ? error.message : String(error)
      const guidance = (error as { guidance?: unknown }).guidance
      if (typeof status === 'number' && typeof code === 'string' && typeof guidance !== 'undefined'
        || (typeof status === 'number' && typeof code === 'string' && (error as { name?: string }).name === 'OcError')) {
        exchange.fail(status, code.toUpperCase(), guidance ? `${message} ${String(guidance)}` : message)
        return undefined
      }
      throw error
    }
  }

  /**
   * 连接器域组织可见范围：超管可带 ?orgId= 查任意组织；普通用户锁定在自身归属组织；
   * 机器收敛到绑定资源的归属组织，外部机器无归属 → 无可见数据（fail-closed）。
   * 与工具路径共用 connectorHub.orgScopeFor，REST/工具一套标准（审查 P0-1）。
   */
  const restrictOrgScope = (exchange: HttpExchange): string | null | undefined => {
    const info = caller(exchange)
    const requested = exchange.query.get('orgId') ?? undefined
    if (info.permissions.includes('*')) return requested
    const scope = ctx.connectorHub.orgScopeFor(info)
    if (scope === undefined) return requested
    return scope
  }

  /** 连接引用对外回显：无凭证字段（结构保证），maskedProfile 已在服务侧脱敏。 */
  const maskReference = <T extends { maskedProfile?: Record<string, string> }>(ref: T): T => ref

  const requireBodyOrg = (orgId: string | undefined): string => {
    if (!orgId) throw new Error('orgId 必填（连接归属组织，org:<orgId>: 别名前缀由此而来）')
    return orgId
  }

  const resolveConnectorCaller = (info: CallerInfo): { type: 'user' | 'agent' | 'app'; id: string; name: string } => {
    if (info.kind === 'human') return { type: 'user', id: info.userId ?? info.principalId, name: info.name }
    const principal = ctx.authn.principals().get(info.principalId)
    if (principal?.refType === 'agent' && principal.refId) return { type: 'agent', id: principal.refId, name: info.name }
    if (principal?.refType === 'app' && principal.refId) return { type: 'app', id: principal.refId, name: info.name }
    return { type: 'app', id: info.principalId, name: info.name }
  }

  // -- 网关配置 -------------------------------------------------------------
  guarded('GET', '/api/connector/gateway', 'connector.gateway.write', (exchange) => {
    // ?assumeEnv=JSON：只读「预演探针」——评估强制 env 门禁各分支的 fail-closed 文案
    // （不改动进程真实环境；selftest T-02 依赖此确定性断言路径）。
    const assumeRaw = exchange.query.get('assumeEnv')
    if (assumeRaw) {
      try {
        const parsed = JSON.parse(assumeRaw) as Record<string, boolean>
        return ctx.connectorHub.gatewayStatus(parsed)
      } catch {
        throw new Error('assumeEnv 必须是 {"ENV_NAME": boolean} 形态的 JSON')
      }
    }
    return ctx.connectorHub.gatewayStatus()
  })

  /** org 巡检手动触发（T-21 确定性断言；定时器周期外的一致性复核入口）。 */
  guarded('POST', '/api/connector/patrol', 'connector.gateway.write', async (exchange) => {
    return await runWithOcErrors(exchange, () => ctx.connectorHub.runPatrols(exchange.query.get('catalog') === '1' ? true : undefined))
  })

  guarded('PUT', '/api/connector/gateway', 'connector.gateway.write', async (exchange) => {
    const input = body<{ baseUrl: string; adminToken?: string; autoCatalogSyncMinutes?: number }>(exchange)
    const record = await ctx.connectorHub.configureGateway(input, caller(exchange).name)
    changeLog(exchange, 'connector.gateway.configure', 'connector_gateway', record.id, record.baseUrl)
    return { ok: true, baseUrl: record.baseUrl, versionPin: record.versionPin, autoCatalogSyncMinutes: record.autoCatalogSyncMinutes }
  })

  guarded('POST', '/api/connector/gateway/health', 'connector.gateway.write', async (exchange) => {
    const result = await ctx.connectorHub.probeGateway()
    changeLog(exchange, 'connector.gateway.probe', 'connector_gateway', 'gateway', '', result.ok ? `healthy ${result.latencyMs}ms` : `${result.reason ?? ''}`)
    return result
  })

  // connector.offline：网关维护下线（默认 L4 审批；viaApproval=false 需管理员显式绕行并留痕）
  guarded('POST', '/api/connector/gateway/offline', 'connector.gateway.write', async (exchange) => {
    const input = body<{ reason?: string; viaApproval?: boolean }>(exchange)
    if (!input.reason?.trim()) throw new Error('下线必须填写原因（护栏要求，处置复盘依赖该口径）')
    const info = caller(exchange)
    if (input.viaApproval === false) {
      const record = await ctx.connectorHub.offlineGateway(input.reason)
      changeLog(exchange, 'connector.gateway.offline', 'connector_gateway', record?.id ?? 'gateway', input.reason, '直连模式（无审批）')
      return { offlined: true, mode: 'direct' }
    }
    const approval = ctx.audit.createApproval({
      kind: 'connector.offline',
      title: `连接器网关维护下线：${input.reason.slice(0, 40)}`,
      payload: { scope: 'gateway', reason: input.reason, requesterId: info.userId ?? info.principalId, requesterName: info.name },
      requesterId: info.userId ?? info.principalId,
      requesterName: info.name,
    })
    changeLog(exchange, 'connector.gateway.offline.request', 'approval_center', approval.id, input.reason, 'L4 审批单已创建')
    return { approvalRequired: true, approvalId: approval.id }
  })

  // 恢复上线：低风险运维动作（清除维护标记并立即探活），不设审批
  guarded('POST', '/api/connector/gateway/online', 'connector.gateway.write', async (exchange) => {
    const result = await ctx.connectorHub.onlineGateway()
    changeLog(exchange, 'connector.gateway.online', 'connector_gateway', 'gateway', '', result.ok ? `healthy ${result.latencyMs}ms` : (result.reason ?? ''))
    return { ...result, online: true }
  })

  // -- 目录 -----------------------------------------------------------------
  guarded('GET', '/api/connector/catalog', 'connector.catalog.read', (exchange) => {
    const q = (exchange.query.get('q') ?? '').toLowerCase()
    const service = exchange.query.get('service')
    const kind = exchange.query.get('kind')
    const limit = Math.min(Number(exchange.query.get('limit') ?? 100), 500)
    const catalog = ctx.connectorHub.catalogs().all()[0]
    if (!catalog) return { providers: [], actions: [], skippedServices: [] as Array<{ service: string; reason: string }> }
    const filterProvider = (provider: Record<string, unknown>): boolean =>
      (!service || String(provider['service']) === service)
      && (!q || JSON.stringify(provider).toLowerCase().includes(q))
    const filterAction = (action: { id: string; service: string; description?: string }): boolean =>
      (!service || action.service === service)
      && (!q || `${action.id} ${action.service} ${action.description ?? ''}`.toLowerCase().includes(q))
    return {
      ...(catalog.syncedAt ? { syncedAt: catalog.syncedAt } : {}),
      providers: kind === 'actions' ? [] : catalog.providers.filter(filterProvider).slice(0, limit),
      actions: kind === 'providers' ? [] : catalog.actions.filter(filterAction).slice(0, limit),
      skippedServices: catalog.skippedServices,
    }
  })

  guarded('GET', '/api/connector/catalog/actions/:id/guide', 'connector.catalog.read', async (exchange) => {
    const { client } = ctx.connectorHub['requireClient']()
    const text = await client.getActionGuide(exchange.params['id']!)
    return { actionId: exchange.params['id'], guide: text }
  })

  guarded('GET', '/api/connector/catalog/actions/:id', 'connector.catalog.read', (exchange) => {
    const action = ctx.connectorHub.requireAction(exchange.params['id']!)
    return { action }
  })

  guarded('POST', '/api/connector/catalog/sync', 'connector.gateway.write', async (exchange) => {
    const result = await runWithOcErrors(exchange, () => ctx.connectorHub.syncCatalog(caller(exchange).name))
    if (!result) return // 错误响应已由处理器写出（如网关 fail-closed 503）
    changeLog(exchange, 'connector.catalog.sync', 'connector_catalog', 'catalog', '', `providers/actions=${(result as { providers?: number }).providers ?? 0}/${(result as { actions?: number }).actions ?? 0}`)
    return result
  })

  // -- 连接 -----------------------------------------------------------------
  guarded('GET', '/api/connector/connections', 'connector.connection.read', (exchange) => {
    const restrictedOrg = restrictOrgScope(exchange)
    if (restrictedOrg === null) return { total: 0, connections: [] }
    const refs = ctx.connectorHub.connections().find((item) =>
      (restrictedOrg === undefined || item.ownerOrgId === restrictedOrg))
    return { total: refs.length, connections: refs.map(maskReference) }
  })

  guarded('POST', '/api/connector/connections/oauth', 'connector.connection.write', async (exchange) => {
    const input = body<{ provider: string; aliasSuffix: string; requestedScopes?: string[]; requireApproval?: boolean; approvalId?: string; actorName?: string }>(exchange)
    const info = caller(exchange)
    const result = await runWithOcErrors(exchange, () => ctx.connectorHub.createConnection({
      orgId: requireBodyOrg(input.orgId),
      actor: { id: info.userId ?? info.principalId, name: input.actorName ?? info.name },
      provider: input.provider,
      aliasSuffix: input.aliasSuffix,
      authType: 'oauth',
      ...(input.requestedScopes?.length ? { requestedScopes: input.requestedScopes } : {}),
      ...(input.requireApproval !== undefined ? { requireApproval: input.requireApproval } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    }))
    if ((result as { reference?: { id: string } }).reference) {
      changeLog(exchange, 'connector.connection.oauth.start', 'connector_connection', (result as { reference: { id: string } }).reference.id, input.provider, input.orgId)
    } else if ((result as { approvalRequired?: boolean }).approvalRequired) {
      changeLog(exchange, 'connector.connection.approval', 'approval_center', (result as { approvalId?: string }).approvalId ?? '', input.provider, '连接创建进入审批门禁')
    }
    return result
  })

  guarded('POST', '/api/connector/connections/api-key', 'connector.connection.write', async (exchange) => {
    // 表单值过手直达 sidecar，不落任何集合、不打日志（红线一）
    const input = body<{ provider: string; aliasSuffix: string; values: Record<string, unknown>; authType?: 'api_key' | 'custom_credential'; requireApproval?: boolean; approvalId?: string; actorName?: string }>(exchange)
    const info = caller(exchange)
    const result = await runWithOcErrors(exchange, () => ctx.connectorHub.createConnection({
      orgId: requireBodyOrg(input.orgId),
      actor: { id: info.userId ?? info.principalId, name: input.actorName ?? info.name },
      provider: input.provider,
      aliasSuffix: input.aliasSuffix,
      authType: input.authType ?? 'api_key',
      values: input.values,
      ...(input.requireApproval !== undefined ? { requireApproval: input.requireApproval } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    }))
    const ref = (result as { reference?: { id: string } }).reference
    if (ref) changeLog(exchange, 'connector.connection.create', 'connector_connection', ref.id, input.provider, `${input.authType ?? 'api_key'} 直达 sidecar`)
    else if ((result as { approvalRequired?: boolean }).approvalRequired) {
      changeLog(exchange, 'connector.connection.approval', 'approval_center', (result as { approvalId?: string }).approvalId ?? '', input.provider, '连接创建进入审批门禁')
    }
    return result
  })

  guarded('POST', '/api/connector/connections/no-auth', 'connector.connection.write', async (exchange) => {
    const input = body<{ provider: string; aliasSuffix: string; actorName?: string }>(exchange)
    const info = caller(exchange)
    const result = await runWithOcErrors(exchange, () => ctx.connectorHub.createConnection({
      orgId: requireBodyOrg(input.orgId),
      actor: { id: info.userId ?? info.principalId, name: input.actorName ?? info.name },
      provider: input.provider,
      aliasSuffix: input.aliasSuffix,
      authType: 'no_auth',
    }))
    const ref = (result as { reference?: { id: string } }).reference
    if (ref) changeLog(exchange, 'connector.connection.create', 'connector_connection', ref.id, input.provider, 'no_auth 虚拟连接登记')
    return result
  })

  guarded('GET', '/api/connector/connections/oauth/:requestId/status', 'connector.connection.write', async (exchange) => {
    return await runWithOcErrors(exchange, () => ctx.connectorHub.confirmConnectionStatus({ requestId: exchange.params['requestId'] }))
  })

  guarded('POST', '/api/connector/connections/refresh', 'connector.connection.read', async (exchange) => {
    const orgFilter = exchange.query.get('orgId') ?? undefined
    return await runWithOcErrors(exchange, () => ctx.connectorHub.refreshConnections(orgFilter))
  })

  guarded('POST', '/api/connector/connections/:id/offline', 'connector.connection.write', async (exchange) => {
    const input = body<{ reason?: string; viaApproval?: boolean }>(exchange)
    if (!input.reason?.trim()) throw new Error('下线必须填写原因（护栏要求）')
    const id = exchange.params['id']!
    const info = caller(exchange)
    if (input.viaApproval === false) {
      const ref = await runWithOcErrors(exchange, () => ctx.connectorHub.offlineConnection(id, { actorName: info.name, reason: input.reason! }))
      if (!ref) return
      changeLog(exchange, 'connector.connection.offline', 'connector_connection', id, ref.alias, input.reason)
      return { offlined: true, mode: 'direct', reference: maskReference(ref) }
    }
    const approval = ctx.audit.createApproval({
      kind: 'connector.offline',
      title: `下线连接：${id}`,
      payload: { scope: 'connection', connectionId: id, reason: input.reason, requesterId: info.userId ?? info.principalId, requesterName: info.name },
      requesterId: info.userId ?? info.principalId,
      requesterName: info.name,
    })
    changeLog(exchange, 'connector.connection.offline.request', 'approval_center', approval.id, id, input.reason)
    return { approvalRequired: true, approvalId: approval.id }
  })

  guarded('POST', '/api/connector/connections/:id/online', 'connector.connection.write', async (exchange) => {
    const restored = await runWithOcErrors(exchange, () => ctx.connectorHub.onlineConnection(exchange.params['id']!))
    if (!restored) return
    changeLog(exchange, 'connector.connection.online', 'connector_connection', restored.id, restored.alias, '')
    return { online: true, reference: maskReference(restored) }
  })

  guarded('DELETE', '/api/connector/connections/:id', 'connector.connection.write', async (exchange) => {
    const input = body<{ force?: boolean }>(exchange)
    const deleteOutcome = await runWithOcErrors(exchange, () => ctx.connectorHub.deleteConnection(exchange.params['id']!, {
      actor: caller(exchange).name, ...(input.force ? { force: true } : {}),
    }))
    if (!deleteOutcome) return // 错误响应已由处理器写出（如 connection_in_use 409）
    const result = deleteOutcome as Awaited<ReturnType<typeof ctx.connectorHub.deleteConnection>>
    changeLog(exchange, 'connector.connection.delete', 'connector_connection', exchange.params['id']!, '', `released=${result.releasedGroups.join(',') || 'none'}`)
    return result
  })

  // -- 执行网关 --------------------------------------------------------------
  guarded('POST', '/api/connector/execute', 'connector.invoke', async (exchange) => {
    const input = body<{ actionId: string; input?: Record<string, unknown>; connection?: string; dryRun?: boolean }>(exchange)
    const info = caller(exchange)
    const resolved = resolveConnectorCaller(info)
    return await runWithOcErrors(exchange, () => ctx.connectorHub.invokeAction({
      ...resolved,
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    }, {
      actionId: input.actionId,
      input: input.input ?? {},
      ...(input.connection ? { alias: input.connection } : {}),
      ...(input.dryRun ? { dryRun: true } : {}),
    }))
  })

  // -- 权限组 -----------------------------------------------------------------
  guarded('GET', '/api/connector/perm-groups', 'connector.connection.read', (exchange) => {
    const orgFilter = restrictOrgScope(exchange)
    if (orgFilter === null) return { total: 0, groups: [] }
    const groups = ctx.connectorHub.permGroups().find((group) => (orgFilter === undefined || group.orgId === orgFilter))
    return { total: groups.length, groups }
  })

  guarded('POST', '/api/connector/perm-groups', 'connector.permgroup.write', async (exchange) => {
    const input = body<{ name: string; description?: string; orgId: string; policies: Record<string, { allowedActions: '*' | string[]; riskCap?: 'read' | 'write' | 'admin'; connections?: string[]; constraints?: { readOnly?: boolean; denyParams?: string[] } }>; subjects: Array<{ type: 'user_group' | 'agent' | 'app'; id: string; name?: string }>; rateLimitPerMin?: number; odd?: Record<string, unknown> }>(exchange)
    const createdGroup = await runWithOcErrors(exchange, () => ctx.connectorHub.createPermGroup({
      name: input.name,
      description: input.description,
      orgId: input.orgId,
      policies: input.policies,
      subjects: input.subjects,
      rateLimitPerMin: input.rateLimitPerMin,
      ...(input.odd !== undefined ? { odd: input.odd } : {}),
      // precheckCents 入参已废止（M0-2 billing 下线，OPT-P0-02）：legacy 记录字段运行时不读，新写请求不再透传
    }))
    if (!createdGroup) return // 错误响应已由处理器写出（如 invalid_alias_prefix 400）
    const group = createdGroup as Awaited<ReturnType<typeof ctx.connectorHub.createPermGroup>>
    changeLog(exchange, 'connector.permgroup.create', 'connector_perm_group', group.id, group.name)
    return group
  })

  guarded('PATCH', '/api/connector/perm-groups/:id', 'connector.permgroup.write', async (exchange) => {
    const updated = await runWithOcErrors(exchange, () => ctx.connectorHub.updatePermGroup(exchange.params['id']!, body(exchange)))
    if (!updated) return // 错误响应已由处理器写出
    const group = updated as Awaited<ReturnType<typeof ctx.connectorHub.updatePermGroup>>
    changeLog(exchange, 'connector.permgroup.update', 'connector_perm_group', group.id, group.name)
    return group
  })

  guarded('DELETE', '/api/connector/perm-groups/:id', 'connector.permgroup.write', (exchange) => {
    const removed = ctx.connectorHub.deletePermGroup(exchange.params['id']!)
    changeLog(exchange, 'connector.permgroup.delete', 'connector_perm_group', exchange.params['id']!, '')
    return { deleted: removed }
  })

  guarded('POST', '/api/connector/perm-groups/:id/impact', 'connector.connection.read', (exchange) => {
    return ctx.connectorHub.permGroupImpact(exchange.params['id']!)
  })

  // -- 运行日志 / 对账 / 台账 ---------------------------------------------------
  guarded('GET', '/api/connector/runs', 'connector.runs.read', async (exchange) => {
    return await runWithOcErrors(exchange, () => ctx.connectorHub.listRunsView({
      ...(exchange.query.get('service') ? { service: exchange.query.get('service')! } : {}),
      ...(exchange.query.get('ok') !== null ? { ok: exchange.query.get('ok') === 'true' } : {}),
      limit: Number(exchange.query.get('limit') ?? 100),
    }))
  })

  guarded('POST', '/api/connector/reconcile', 'connector.runs.read', async (exchange) => {
    const outcome = await runWithOcErrors(exchange, () => ctx.connectorHub.reconcileRuns())
    if (!outcome) return // 错误响应已由处理器写出
    const result = outcome as Awaited<ReturnType<typeof ctx.connectorHub.reconcileRuns>>
    changeLog(exchange, 'connector.reconcile.runs', 'connector_reconcile', 'runs', '', `checked=${result.checkedRuns} bypass=${result.bypassRuns.length}`)
    return result
  })

  guarded('GET', '/api/connector/tokens', 'connector.permgroup.write', (exchange) => {
    // 台账只读：永不返回 token 值（值仅创建时返回一次且平台不落盘）
    const ledgers = ctx.connectorHub.tokens().all().map((item) => ({
      permGroupId: item.permGroupId,
      ocTokenId: item.ocTokenId,
      policySnapshotHash: item.policySnapshotHash.slice(0, 12),
      createdAt: item.createdAt,
      lastSyncedAt: item.lastSyncedAt,
    }))
    return { total: ledgers.length, tokens: ledgers }
  })

  // -- Skill 市场 ---------------------------------------------------------
  guarded('GET', '/api/skills', 'skill.read', (exchange) => {
    if (exchange.query.get('mine') === '1') {
      const info = caller(exchange)
      return { skills: ctx.skillHub.skills().find((skill) => skill.authorId === (info.userId ?? info.principalId)) }
    }
    if (exchange.query.get('pending') === '1') {
      return { skills: ctx.skillHub.skills().find((skill) => ['pending_approval', 'scanning', 'rejected'].includes(skill.status)) }
    }
    // 市场列表含在途项（待审批/扫描中，排最前带状态徽标）：审批人无需切页即可看到待办
    const skills = ctx.skillHub.search({
      q: exchange.query.get('q') ?? undefined,
      category: exchange.query.get('category') ?? undefined,
      tag: exchange.query.get('tag') ?? undefined,
      sort: (exchange.query.get('sort') ?? 'downloads') as 'downloads' | 'rating' | 'updated',
      includePending: true,
    })
    return { skills, categories: ctx.skillHub.categories() }
  })

  guarded('GET', '/api/skills/:id', 'skill.read', (exchange) => {
    return ctx.skillHub.detail(exchange.params['id']!)
  })

  guarded('POST', '/api/skills', 'skill.submit', (exchange) => {
    const input = body<{ name: string; category?: string; tags?: string[]; summary?: string; description?: string; content: string; version?: string; changelog?: string; visibility?: 'all' | 'orgs' | 'groups'; applicableModels?: string[]; deps?: string[]; packageBase64?: string }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const skill = ctx.skillHub.submit({
      ...input,
      authorId: info.userId ?? info.principalId,
      authorName: info.name,
      orgId: user?.orgId ?? 'org_unknown',
    })
    return { id: skill.id, status: skill.status, findings: skill.versions.at(-1)?.findings ?? [], hasPackage: Boolean(skill.versions.at(-1)?.packageBase64) }
  })

  guarded('POST', '/api/skills/:id/approve', 'skill.approve', (exchange) => {
    const input = body<{ version?: string; decision: 'approve' | 'reject'; level: 'domain' | 'security'; opinion: string }>(exchange)
    const info = caller(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const version = input.version ?? skill.currentVersion
    const result = input.decision === 'approve'
      ? ctx.skillHub.approve(skill.id, version, input.level, { id: info.userId ?? info.principalId, name: info.name }, input.opinion)
      : ctx.skillHub.reject(skill.id, version, { id: info.userId ?? info.principalId, name: info.name }, input.opinion)
    changeLog(exchange, `skill.approve.${input.decision}`, 'skill', skill.id, skill.name, `${input.level}: ${input.opinion}`)
    return result
  })

  guarded('POST', '/api/skills/:id/publish', 'skill.publish', async (exchange) => {
    const { version } = body<{ version?: string }>(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const info = caller(exchange)
    // 真实账号标识（非显示名）：显示名（中文名）非账号，无法透传身份头，也会污染审计归属
    const result = await ctx.skillHub.publish(skill.id, version ?? skill.currentVersion, { id: info.userId ?? info.principalId, name: info.name })
    changeLog(exchange, 'skill.publish', 'skill', skill.id, skill.name)
    return result
  })

  /** 编辑已上架 Skill 的市场信息：仅作者本人或持 skill.publish 的管理员。 */
  guarded('PATCH', '/api/skills/:id', 'skill.submit', (exchange) => {
    const input = body<{ name?: string; category?: string; tags?: string[]; summary?: string; description?: string; visibility?: 'all' | 'orgs' | 'groups'; targetOrgs?: string[]; applicableModels?: string[]; deps?: string[]; cover?: string; authorName?: string }>(exchange)
    const info = caller(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const asAdmin = info.permissions.includes('*') || info.permissions.includes('skill.publish')
    if (skill.authorId !== (info.userId ?? info.principalId) && !asAdmin) {
      exchange.fail(403, 'FORBIDDEN', '仅 Skill 作者或平台管理员可编辑该 Skill 信息')
      return
    }
    const result = ctx.skillHub.update(skill.id, input, { id: info.userId ?? info.principalId, name: info.name }, { asAdmin })
    changeLog(exchange, 'skill.update', 'skill', skill.id, result.name, `编辑字段：${Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined).join('、') || '无'}`)
    return result
  })

  /** 重新手动上传当前已发布版本的 skill.zip 资源包（原地替换，版本号不变）。 */
  guarded('PUT', '/api/skills/:id/package', 'skill.submit', async (exchange) => {
    const { packageBase64 } = body<{ packageBase64?: string }>(exchange)
    if (!packageBase64) throw new Error('packageBase64 必填')
    const info = caller(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const asAdmin = info.permissions.includes('*') || info.permissions.includes('skill.publish')
    if (skill.authorId !== (info.userId ?? info.principalId) && !asAdmin) {
      exchange.fail(403, 'FORBIDDEN', '仅 Skill 作者或平台管理员可更新该 Skill 资源包')
      return
    }
    const result = await ctx.skillHub.replacePackage(skill.id, packageBase64, { id: info.userId ?? info.principalId, name: info.name }, { asAdmin })
    const pkg = result.versions.find((item) => item.version === result.currentVersion)?.package
    changeLog(exchange, 'skill.package.replace', 'skill', skill.id, skill.name, `v${result.currentVersion} 资源包重传（${pkg?.storage === 'nas' ? 'NAS' : '平台本地'}${pkg?.sizeBytes !== undefined ? ` · ${pkg.sizeBytes}B` : ''}）`)
    return { skill: result, package: pkg }
  })

  guarded('POST', '/api/skills/:id/deprecate', 'skill.publish', (exchange) => {
    const { reason, force } = body<{ reason?: string; force?: boolean }>(exchange)
    if (!reason?.trim()) throw new Error('弃用必须填写原因（护栏要求，下架分析依赖该口径）')
    const result = ctx.skillHub.deprecate(exchange.params['id']!, caller(exchange).name, reason, force)
    changeLog(exchange, 'skill.deprecate', 'skill', result.skill.id, result.skill.name, reason)
    return result
  })

  /** 删除 Skill：已弃用/强制下架/审批驳回可删；被未归档 Agent 引用时拒绝；审计数据保留。 */
  guarded('DELETE', '/api/skills/:id', 'skill.publish', (exchange) => {
    const id = exchange.params['id']!
    const skill = ctx.skillHub.skills().get(id)
    if (!skill) throw new Error(`Skill 不存在：${id}`)
    if (!['deprecated', 'offline', 'rejected'].includes(skill.status)) {
      throw new Error(`当前状态 ${skill.status} 不可删除（仅已弃用/强制下架/审批驳回可删）`)
    }
    const referencing = ctx.resourceCore.dependencies().find((record) => record.kind === 'skill' && record.toId === id)
      .map((record) => ctx.resourceCore.get('agent', record.fromId))
      .filter((agent) => agent !== undefined && agent.status !== 'archived')
    if (referencing.length > 0) {
      throw new Error(`该 Skill 仍被 ${referencing.map((agent) => agent!.name).join('、')} 引用，请先卸载或归档相关 Agent`)
    }
    ctx.skillHub.purge(id)
    changeLog(exchange, 'skill.delete', 'skill', id, skill.name)
    return { deleted: true }
  })

  guarded('POST', '/api/skills/:id/install', 'skill.install', (exchange) => {
    const { agentId, version } = body<{ agentId: string; version?: string }>(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const result = ctx.skillHub.install(skill.id, version ?? skill.currentVersion, agentId, caller(exchange).name)
    changeLog(exchange, 'skill.install', 'skill', skill.id, skill.name, `→ ${agentId}`)
    return result
  })

  guarded('POST', '/api/skills/:id/uninstall', 'skill.install', (exchange) => {
    const { agentId } = body<{ agentId: string }>(exchange)
    ctx.skillHub.uninstall(exchange.params['id']!, agentId)
    return { uninstalled: true }
  })

  guarded('POST', '/api/skills/:id/rate', 'skill.read', (exchange) => {
    const { stars } = body<{ stars: number }>(exchange)
    const info = caller(exchange)
    return ctx.skillHub.rate(exchange.params['id']!, info.userId ?? info.principalId, stars)
  })

  guarded('POST', '/api/skills/:id/download', 'skill.read', (exchange) => {
    const { version } = body<{ version?: string }>(exchange)
    const info = caller(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    return ctx.skillHub.download(skill.id, version ?? skill.currentVersion, { id: info.userId ?? info.principalId, name: info.name })
  })

  /** skill.zip 包下载：与 NAS 上架产物同源（提交携带的原始包或 SKILL.md 现场打包）。 */
  guarded('GET', '/api/skills/:id/package', 'skill.read', (exchange) => {
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const pkg = ctx.skillHub.packageOf(skill.id, exchange.query.get('version') ?? skill.currentVersion)
    // 中文 slug 文件名：ASCII 回退 + RFC 5987 UTF-8 形式（非 Latin1 字符直接进头会损坏响应）
    exchange.res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': pkg.buffer.length,
      'content-disposition': `attachment; filename="${pkg.filename.replace(/[^\x20-\x7e"]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(pkg.filename)}`,
      'cache-control': 'no-cache',
    })
    exchange.res.end(pkg.buffer)
  })

  // -- Skill 包存储配置（local / NAS 后端） --------------------------------
  guarded('GET', '/api/skill-storage', 'skill.read', () => {
    const config = ctx.nasRegistry.getSkillStorage()
    return {
      config,
      nasOptions: ctx.nasRegistry.list({ status: 'online' }).map((nas) => ({ id: nas.id, name: nas.name, slug: nas.slug, rootPath: nas.attrs['rootPath'] })),
    }
  })

  guarded('PUT', '/api/skill-storage', 'skill.storage.write', (exchange) => {
    const input = body<{ mode?: 'local' | 'nas'; nasId?: string; basePath?: string }>(exchange)
    const config = ctx.nasRegistry.setSkillStorage(input, caller(exchange).name)
    changeLog(exchange, 'skill.storage.update', 'skill_storage', config.id, 'Skill 包存储', `${config.mode}${config.nasId ? ` → ${config.nasId}:${config.basePath}` : ''}`)
    return config
  })

  // -- NAS 存储（FS 文件存储类资产） ----------------------------------------
  guarded('GET', '/api/nas', 'nas.read', (exchange) => ({
    items: ctx.nasRegistry.list({
      status: exchange.query.get('status') ?? undefined,
      q: exchange.query.get('q') ?? undefined,
    }).map((nas) => ({
      ...maskNasEntity(nas),
      health: ctx.nasRegistry.healthOf(nas.id),
      gatewayToolCount: ctx.nasRegistry.toolsOf(nas.id).length,
      availableTransitions: ctx.resourceCore.availableTransitions('nas', nas.id),
    })),
    schema: ctx.resourceCore.typeSpec('nas')?.schema,
    lifecycle: ctx.resourceCore.typeSpec('nas')?.lifecycle,
  }))

  guarded('GET', '/api/nas/:id', 'nas.read', (exchange) => {
    const nas = ctx.nasRegistry.get(exchange.params['id']!)
    if (!nas) throw new Error(`NAS 资产不存在：${exchange.params['id']}`)
    return {
      ...maskNasEntity(nas),
      health: ctx.nasRegistry.healthOf(nas.id),
      gatewayTools: ctx.nasRegistry.toolsOf(nas.id),
      availableTransitions: ctx.resourceCore.availableTransitions('nas', nas.id),
      audit: ctx.audit.query({ resourceType: 'nas', resourceId: nas.id, limit: 30 }).items,
    }
  })

  guarded('POST', '/api/nas', 'nas.write', (exchange) => {
    const input = body<{ name: string; slug?: string; attrs?: Record<string, unknown> }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const nas = ctx.nasRegistry.register({
      ...input,
      ownerId: info.userId ?? info.principalId,
      orgId: user?.orgId ?? ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
    })
    changeLog(exchange, 'nas.create', 'nas', nas.id, nas.name)
    return maskNasEntity(nas)
  })

  guarded('PATCH', '/api/nas/:id', 'nas.write', (exchange) => {
    const input = body<{ name?: string; attrs?: Record<string, unknown> }>(exchange)
    // 接入属性表单回显的是脱敏令牌（**** / 前 6 位+…）：原样保存会打穿真实令牌导致网关 401，丢弃之
    const token = input.attrs?.['accessToken']
    if (typeof token === 'string' && (/^\*+$/.test(token) || token.includes('…'))) delete input.attrs!['accessToken']
    const nas = ctx.nasRegistry.update(exchange.params['id']!, input)
    changeLog(exchange, 'nas.update', 'nas', nas.id, nas.name)
    return maskNasEntity(nas)
  })

  /** 删除 NAS 资产：草稿（从未上线）或已归档可删；被 Skill 包存储后端引用时拒绝。 */
  guarded('DELETE', '/api/nas/:id', 'nas.write', (exchange) => {
    const id = exchange.params['id']!
    const nas = ctx.nasRegistry.get(id)
    if (!nas) throw new Error(`NAS 资产不存在：${id}`)
    const storage = ctx.nasRegistry.getSkillStorage()
    if (storage.mode === 'nas' && storage.nasId === id) {
      throw new Error('该 NAS 正作为 Skill 包存储后端，请先在「Skill 包存储」切换为 local 或其他 NAS')
    }
    ctx.resourceCore.remove('nas', id, { allowStates: ['draft', 'archived'] })
    ctx.nasRegistry.purge(id)
    changeLog(exchange, 'nas.delete', 'nas', id, nas.name)
    return { deleted: true }
  })

  guarded('POST', '/api/nas/:id/transition', 'nas.write', async (exchange) => {
    const { action, note } = body<{ action: string; note?: string }>(exchange)
    const info = caller(exchange)
    const id = exchange.params['id']!
    if (action === 'online') {
      const nas = await ctx.nasRegistry.online(id, info.name)
      changeLog(exchange, 'nas.online', 'nas', id, nas.name)
      return maskNasEntity(nas)
    }
    if (action === 'offline') {
      if (!note?.trim()) throw new Error('下线必须填写原因（护栏要求）')
      const nas = ctx.nasRegistry.offline(id, info.name, note)
      changeLog(exchange, 'nas.offline', 'nas', id, nas.name, note)
      return maskNasEntity(nas)
    }
    if (action === 'archive') {
      const nas = ctx.nasRegistry.archive(id, info.name)
      changeLog(exchange, 'nas.archive', 'nas', id, nas.name)
      return maskNasEntity(nas)
    }
    throw new Error(`未知操作：${action}`)
  })

  guarded('POST', '/api/nas/:id/health', 'nas.read', async (exchange) => {
    return await ctx.nasRegistry.probe(exchange.params['id']!)
  })

  guarded('POST', '/api/nas/:id/sync-tools', 'nas.write', async (exchange) => {
    const tools = await ctx.nasRegistry.discoverTools(exchange.params['id']!)
    return { tools: tools.map((tool) => tool.name), count: tools.length }
  })

  /**
   * mcpServers JSON 一键纳管 NAS（synology-filestation 形态）：
   * {"mcpServers":{"synology-filestation":{"url":"http://gw:3000/mcp","headers":{"Authorization":"Bearer …","X-NAS-IP":"192.168.0.196"}}}}
   * 解析 url + 认证头 + 设备路由头 → 创建资产 → 探活 → 上线 → 工具发现。
   */
  guarded('POST', '/api/nas/import', 'nas.write', async (exchange) => {
    const input = body<{ config: string | object; name?: string; description?: string }>(exchange)
    const info = caller(exchange)
    const entries = parseNasMcpServersConfig(input.config)
    const results: Array<{ name: string; ok: boolean; nasId?: string; reachable?: boolean; tools?: number; status?: string; error?: string }> = []
    for (const entry of entries) {
      if (entry.error) {
        results.push({ name: entry.name, ok: false, error: entry.error })
        continue
      }
      try {
        const nas = ctx.nasRegistry.register({
          name: input.name && entries.length === 1 ? input.name : entry.name,
          attrs: {
            description: input.description ?? `mcpServers JSON 导入（网关 ${entry.url}）`,
            gatewayUrl: entry.url,
            accessToken: entry.token,
            nasIp: entry.nasIp,
            rootPath: '/',
            dataClass: 'internal',
            tags: ['mcp-import'],
          },
          ownerId: info.userId ?? info.principalId,
          orgId: ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
        })
        let reachable = false
        let tools = 0
        try {
          const health = await ctx.nasRegistry.probe(nas.id)
          reachable = health.status !== 'down'
        } catch { reachable = false }
        if (reachable) {
          tools = (await ctx.nasRegistry.discoverTools(nas.id).catch(() => [])).length
        }
        let status = nas.status
        if (reachable) {
          const onlined = await ctx.nasRegistry.online(nas.id, info.name)
          status = onlined.status
        }
        changeLog(exchange, 'nas.import', 'nas', nas.id, nas.name, `reachable=${reachable}`)
        results.push({ name: entry.name, ok: true, nasId: nas.id, reachable, tools, status, ...(reachable ? {} : { error: '网关不可达：资产保留草稿，请检查地址/令牌/网络后重试上线' }) })
      } catch (error) {
        results.push({ name: entry.name, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { imported: results.filter((item) => item.ok).length, results }
  })

  guarded('GET', '/api/nas/:id/fs', 'nas.read', async (exchange) => {
    const id = exchange.params['id']!
    const path = exchange.query.get('path')
    const info = caller(exchange)
    const actor = { id: info.userId ?? info.principalId, name: info.name }
    return path === null || path === '' ? await ctx.nasRegistry.listShares(id, actor) : await ctx.nasRegistry.listFiles(id, path, actor)
  })

  guarded('GET', '/api/nas/:id/fs/info', 'nas.read', async (exchange) => {
    const path = exchange.query.get('path')
    if (!path) throw new Error('缺少 path 查询参数')
    const info = caller(exchange)
    return await ctx.nasRegistry.getInfo(exchange.params['id']!, path, { id: info.userId ?? info.principalId, name: info.name })
  })

  guarded('POST', '/api/nas/:id/fs/search', 'nas.read', async (exchange) => {
    const { pattern, path } = body<{ pattern: string; path?: string }>(exchange)
    if (!pattern) throw new Error('缺少 pattern')
    const info = caller(exchange)
    return await ctx.nasRegistry.search(exchange.params['id']!, pattern, path ?? '/', { id: info.userId ?? info.principalId, name: info.name })
  })

  guarded('POST', '/api/nas/:id/fs/mkdir', 'nas.write', async (exchange) => {
    const { path } = body<{ path: string }>(exchange)
    const info = caller(exchange)
    const result = await ctx.nasRegistry.mkdir(exchange.params['id']!, path, { id: info.userId ?? info.principalId, name: info.name })
    return result
  })

  guarded('POST', '/api/nas/:id/fs/rename', 'nas.write', async (exchange) => {
    const { path, newName } = body<{ path: string; newName: string }>(exchange)
    const info = caller(exchange)
    const result = await ctx.nasRegistry.rename(exchange.params['id']!, path, newName, { id: info.userId ?? info.principalId, name: info.name })
    // 所有权随重命名改写（含子树前缀）。
    try {
      const parent = path.split('/').filter(Boolean).slice(0, -1)
      if (info.userId) ctx.nasAuthz.rewriteOwnershipFor(exchange.params['id']!, path, `/${[...parent, newName].filter(Boolean).join('/')}`)
    } catch (error) {
      ctx.logger('console').warn('文件所有权改写失败（不影响重命名）', error)
    }
    return result
  })

  guarded('POST', '/api/nas/:id/fs/delete', 'nas.write', async (exchange) => {
    const { paths } = body<{ paths: string[] }>(exchange)
    const info = caller(exchange)
    const result = await ctx.nasRegistry.delete(exchange.params['id']!, Array.isArray(paths) ? paths : [paths], { id: info.userId ?? info.principalId, name: info.name })
    // 所有权随删除移除（含子树）。
    try {
      if (info.userId) ctx.nasAuthz.removeOwnershipFor(exchange.params['id']!, Array.isArray(paths) ? paths : [paths])
    } catch (error) {
      ctx.logger('console').warn('文件所有权移除失败（不影响删除）', error)
    }
    return result
  })

  guarded('POST', '/api/nas/:id/fs/upload', 'nas.write', async (exchange) => {
    const input = body<{ localFile?: string; contentBase64?: string; destPath: string }>(exchange)
    const info = caller(exchange)
    if (input.localFile && input.contentBase64) throw new Error('localFile 与 contentBase64 二选一')
    const buffer = input.contentBase64 !== undefined ? Buffer.from(input.contentBase64, 'base64') : undefined
    const result = await ctx.nasRegistry.uploadFile(exchange.params['id']!, {
      ...(buffer !== undefined ? { buffer } : { localFile: input.localFile }),
      destPath: input.destPath,
      actor: { id: info.userId ?? info.principalId, name: info.name },
    })
    // 文件所有权（2026-09-17 新增）：上传成功即登记上传者（上传者对自有文档默认全权）。
    try {
      if (info.userId) ctx.nasAuthz.recordOwnership({ nasId: exchange.params['id']!, path: input.destPath, userId: info.userId, source: 'upload' })
    } catch (error) {
      ctx.logger('console').warn('文件所有权登记失败（不影响上传）', error)
    }
    return result
  })

  guarded('POST', '/api/nas/:id/fs/download', 'nas.read', async (exchange) => {
    const { path } = body<{ path: string }>(exchange)
    const info = caller(exchange)
    return await ctx.nasRegistry.downloadFile(exchange.params['id']!, path, { id: info.userId ?? info.principalId, name: info.name })
  })

  /**
   * 下载票据：mode=once（默认，15 秒一次性）——浏览器 <a> 原生下载无需带 Bearer 头，大文件免内存 blob；
   * mode=link（10 分钟内可重复使用）——遗留通道（2026-09-21 起前端「复制下载链接」切换到
   * POST /fs/share-link 签名链接，档位可选；本端点行为不变，过渡期并存，自测断言不回归）。
   */
  const LINK_TICKET_TTL_SEC = 600
  const downloadTickets = new Map<string, { nasId: string; path: string; userId?: string; principalId: string; userName: string; expiresAt: number; once: boolean }>()
  guarded('POST', '/api/nas/:id/fs/download-ticket', 'nas.read', (exchange) => {
    const { path, mode } = body<{ path: string; mode?: 'once' | 'link' }>(exchange)
    if (!path) throw new Error('缺少 path')
    const info = caller(exchange)
    const once = mode !== 'link'
    const ttlSec = once ? 15 : LINK_TICKET_TTL_SEC
    const ticket = `nastk_${newId('t')}`
    downloadTickets.set(ticket, {
      nasId: exchange.params['id']!,
      path: String(path),
      ...(info.kind === 'human' && info.userId ? { userId: info.userId } : {}),
      principalId: info.principalId,
      userName: info.name,
      expiresAt: Date.now() + ttlSec * 1000,
      once,
    })
    // 清理过期票据
    for (const [key, value] of downloadTickets) if (value.expiresAt < Date.now()) downloadTickets.delete(key)
    changeLog(exchange, 'nas.fs.download_ticket', 'nas', exchange.params['id']!, '', `${path}（${once ? '一次性票据' : `分享链接票据，${LINK_TICKET_TTL_SEC / 60} 分钟有效`}）`)
    return { ticket, expiresInSec: ttlSec }
  })

  // -- NAS 签名分享链接（docs-20260921 设计清单：HMAC 长效/永久 + 权限复核 + 可吊销）----------
  // 档位 1h / 24h（默认）/ 7d / 30d / 永久；签名用独立长期密钥（不随令牌密钥轮换），
  // 重启不失效；取流三关 = 签名 → 吊销 → 权限复核（见 GET /fs/file 的 ?sig= 分支）。
  http.register('POST', '/api/nas/:id/fs/share-link', async (exchange) => {
    if (!requirePermission(exchange, 'nas.write')) return
    const input = body<{ path?: string; ttlSec?: number; permanent?: boolean; note?: string }>(exchange)
    if (!input.path) {
      exchange.fail(400, 'BAD_REQUEST', '缺少 path')
      return
    }
    const info = caller(exchange)
    try {
      const issued = ctx.nasShareLinks.issue({
        nasId: exchange.params['id']!,
        path: String(input.path),
        issuer: { principalId: info.principalId, ...(info.userId ? { userId: info.userId } : {}), userName: info.name },
        ...(input.ttlSec !== undefined ? { ttlSec: Number(input.ttlSec) } : {}),
        ...(input.permanent !== undefined ? { permanent: input.permanent === true } : {}),
        ...(input.note ? { note: String(input.note) } : {}),
        hasPermanentPermission: info.permissions.includes('*') || info.permissions.includes('nas.authz.write'),
      })
      const permanent = issued.record.expiresAt === null
      const query = `path=${encodeURIComponent(issued.record.path)}&exp=${issued.exp}&sub=${encodeURIComponent(issued.sub)}&jti=${encodeURIComponent(issued.record.id)}&sig=${encodeURIComponent(issued.sig)}`
      const url = `${requestOrigin(exchange) ?? ''}/api/nas/${exchange.params['id']}/fs/file?${query}`
      // 永久链接必须在审计 detail 写「永久」（决策 ②：显式可审，不留歧义）
      changeLog(exchange, 'nas.fs.share_link', 'nas', exchange.params['id']!, '', `${issued.record.path}（${issued.ttlLabel}）`)
      exchange.ok({
        url,
        jti: issued.record.id,
        expiresAt: issued.record.expiresAt,
        expiresInSec: issued.ttlSec,
        tier: issued.tier,
        ttlLabel: issued.ttlLabel,
        permanent,
      })
    } catch (error) {
      if (error instanceof ShareLinkError) {
        exchange.fail(error.httpStatus, error.code, error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.write' })

  guarded('GET', '/api/nas/:id/fs/share-links', 'nas.authz.read', (exchange) => {
    const userId = exchange.query.get('userId') ?? undefined
    const path = exchange.query.get('path') ?? undefined
    const includeRevoked = exchange.query.get('includeRevoked') === '1'
    return { items: ctx.nasShareLinks.list({ nasId: exchange.params['id']!, ...(userId ? { userId } : {}), ...(path ? { path } : {}), includeRevoked }) }
  })

  http.register('POST', '/api/nas/:id/fs/share-links/:jti/revoke', async (exchange) => {
    if (!requirePermission(exchange, 'nas.authz.write')) return
    const reason = String(body<{ reason?: string }>(exchange).reason ?? '')
    try {
      const result = ctx.nasShareLinks.revoke(exchange.params['jti']!, caller(exchange).name, reason)
      changeLog(exchange, 'nas.fs.share_link_revoke', 'nas', exchange.params['id']!, '',
        `${result.record.path}（${result.alreadyRevoked ? '已是吊销态，幂等返回' : `吊销人 ${caller(exchange).name}${reason ? `，事由：${reason}` : ''}`}）`)
      exchange.ok({ ...result.record, alreadyRevoked: result.alreadyRevoked })
    } catch (error) {
      if (error instanceof ShareLinkError) {
        exchange.fail(error.httpStatus, error.code, error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write' })

  http.register('POST', '/api/nas/:id/fs/share-links/revoke', async (exchange) => {
    if (!requirePermission(exchange, 'nas.authz.write')) return
    const input = body<{ userId?: string; path?: string; all?: boolean; reason?: string }>(exchange)
    try {
      const result = ctx.nasShareLinks.revokeBatch({
        nasId: exchange.params['id']!,
        ...(input.userId ? { userId: String(input.userId) } : {}),
        ...(input.path ? { path: String(input.path) } : {}),
        ...(input.all !== undefined ? { all: input.all === true } : {}),
      }, caller(exchange).name, String(input.reason ?? ''))
      const scope = input.all === true ? '全部链接' : input.userId ? `签发者 ${input.userId}` : `路径 ${input.path}`
      changeLog(exchange, 'nas.fs.share_link_revoke', 'nas', exchange.params['id']!, '', `批量吊销 ${scope}：${result.count} 条`)
      exchange.ok({ revoked: result.count })
    } catch (error) {
      if (error instanceof ShareLinkError) {
        exchange.fail(error.httpStatus, error.code, error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write' })

  guarded('GET', '/api/nas/authz/share-link-policy', 'nas.authz.read', () => {
    const rules = ctx.nasAuthz.getRules()
    return {
      ...ctx.nasShareLinks.policy(),
      version: rules.version,
      presets: SHARE_LINK_TTL_PRESETS,
      secret: ctx.nasShareLinks.secretStatus(),
    }
  })

  http.register('PUT', '/api/nas/authz/share-link-policy', async (exchange) => {
    if (!requirePermission(exchange, 'nas.authz.write')) return
    const input = body<{ maxTtlSec?: number; allowPermanent?: boolean; permanentPermission?: string; ifVersion?: number }>(exchange)
    try {
      const saved = ctx.nasShareLinks.updatePolicy({
        ...(input.maxTtlSec !== undefined ? { maxTtlSec: Number(input.maxTtlSec) } : {}),
        ...(input.allowPermanent !== undefined ? { allowPermanent: input.allowPermanent === true } : {}),
        ...(input.permanentPermission !== undefined ? { permanentPermission: String(input.permanentPermission) } : {}),
      }, input.ifVersion !== undefined ? Number(input.ifVersion) : undefined, caller(exchange).name)
      // 放权动作显式留痕（决策 ③：allowPermanent 的翻转属授权升级，必须可审）
      changeLog(exchange, 'nas.authz.share_link_policy', 'nas_authz_rules', 'singleton', 'NAS 分享链接档位策略',
        `maxTtlSec=${saved.maxTtlSec} allowPermanent=${saved.allowPermanent} permanentPermission=${saved.permanentPermission}`)
      exchange.ok(saved)
    } catch (error) {
      if (error instanceof RulesVersionConflictError) {
        exchange.fail(409, 'VERSION_CONFLICT', error.message, { currentVersion: error.currentVersion })
        return
      }
      if (error instanceof ShareLinkError) {
        exchange.fail(error.httpStatus, error.code, error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write' })

  http.register('POST', '/api/nas/authz/share-link-secret/rotate', async (exchange) => {
    if (!requirePermission(exchange, 'nas.authz.write')) return
    const note = String(body<{ note?: string }>(exchange).note ?? '')
    try {
      const result = ctx.nasShareLinks.rotateSecret(note || undefined)
      changeLog(exchange, 'nas.authz.share_link_secret_rotate', 'nas_authz_rules', 'singleton', 'NAS 分享链接签名密钥',
        `新密钥 ${result.keyId}；退役 ${result.retiredKeyId ?? '-'}（永久保留验签，已发链接不失效）`)
      exchange.ok(result)
    } catch (error) {
      if (error instanceof ShareLinkError) {
        exchange.fail(error.httpStatus, error.code, error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write' })

  /**
   * 流式文件下载（浏览器端真正拿到文件）：先调 downloadFile 让网关落盘到 staging，
   * 再以 attachment 头 + content-disposition 触发浏览器保存。
   * 鉴权三通道：Bearer 令牌 / 一次性票据 ?ticket= / 签名分享链接 ?sig=（exp/sub/jti/sig）。
   * query: path=/share/file, inline=1 表示预览（inline）而非下载（attachment）。
   */
  http.register('GET', '/api/nas/:id/fs/file', async (exchange) => {
    let info: CallerInfo | undefined
    const header = String(exchange.headers['authorization'] ?? '')
    if (header.startsWith('Bearer ')) {
      try {
        const verified = ctx.authn.verify(header.slice(7))
        info = {
          kind: verified.principal.type,
          principalId: verified.principal.id,
          ...(verified.principal.type === 'human' && verified.principal.refId ? { userId: verified.principal.refId } : {}),
          name: verified.principal.name,
          permissions: verified.scopes,
          actChain: verified.actChain,
        }
      } catch { /* 无效令牌走 401 */ }
      if (!info || (!info.permissions.includes('*') && !info.permissions.includes('nas.read'))) {
        ctx.platformBus.emit('audit.authz.denied', {
          actorId: info?.userId ?? info?.principalId ?? '-',
          actorName: info?.name ?? '-',
          point: 'nas.read',
          path: exchange.path,
        })
        exchange.fail(403, 'FORBIDDEN', '缺少权限点 nas.read')
        return
      }
    } else if (exchange.query.get('sig')) {
      // 签名分享链接（docs-20260921 设计清单 §2.2）：三关 fail-closed——
      // ① 签名关（独立长期密钥 + exp 过期判定，exp=0 为永久）；
      // ② 吊销关（jti 指向 nas:shareLinks 签发记录，已吊销/记录缺失即拒）；
      // ③ 权限复核关（以签发者身份实时 nasAuthz.check op='download'，票据只是「身份+文件」封装）。
      // 复核失败不消耗链接（可重复尝试），每次判定由 nasAuthz 自带留痕（deny 全量落痕）。
      const verdict = ctx.nasShareLinks.verifyStreamAccess({
        nasId: exchange.params['id']!,
        path: exchange.query.get('path') ?? '',
        exp: exchange.query.get('exp') ?? '',
        sub: exchange.query.get('sub') ?? '',
        jti: exchange.query.get('jti') ?? '',
        sig: String(exchange.query.get('sig')),
      })
      if (verdict.outcome === 'invalid') {
        exchange.fail(401, 'SHARE_LINK_INVALID', `下载链接无效：${verdict.reason}（请重新获取分享链接）`)
        return
      }
      if (verdict.outcome === 'forbidden') {
        exchange.fail(403, 'FORBIDDEN', `下载链接权限复核未通过：${verdict.reasons.join('；')}`)
        return
      }
      ctx.nasShareLinks.recordUse(verdict.record.id)
      info = {
        kind: 'human',
        principalId: verdict.record.principalId,
        userId: verdict.record.userId,
        name: verdict.record.userName,
        permissions: ['nas.read'],
        actChain: [],
      }
    } else {
      const ticketStr = exchange.query.get('ticket') ?? ''
      const ticket = downloadTickets.get(ticketStr)
      if (!ticket || ticket.expiresAt < Date.now()) {
        downloadTickets.delete(ticketStr)
        exchange.fail(401, 'TICKET_INVALID', '下载票据缺失/过期（请重新发起下载）')
        return
      }
      if (ticket.once) downloadTickets.delete(ticketStr) // 一次性票据即领即废；分享链接票据在 TTL 内可反复使用
      if (ticket.nasId !== exchange.params['id']!) {
        exchange.fail(403, 'FORBIDDEN', '下载票据与资产不匹配')
        return
      }
      if ((exchange.query.get('path') ?? '') !== ticket.path) {
        exchange.fail(403, 'FORBIDDEN', '下载票据与路径不匹配')
        return
      }
      info = {
        kind: 'human',
        principalId: ticket.principalId,
        ...(ticket.userId ? { userId: ticket.userId } : {}),
        name: ticket.userName,
        permissions: ['nas.read'],
        actChain: [],
      }
    }
    const id = exchange.params['id']!
    const filePath = exchange.query.get('path')
    const inline = exchange.query.get('inline') === '1'
    if (!filePath) {
      exchange.fail(400, 'BAD_REQUEST', '缺少 path 查询参数')
      return
    }
    let resolved: { localFile: string; bytes: number }
    try {
      // 先经网关 fs_download 落盘到平台 staging（幂等覆盖写），再基于网关回执的 saved_to 解析本地文件
      const downloaded = await ctx.nasRegistry.downloadFile(id, filePath, { id: info.userId ?? info.principalId, name: info.name })
      const fresh = await import('node:fs/promises').then((m) => m.stat(downloaded.localFile).catch(() => null))
      if (!fresh?.isFile()) throw new Error(`下载后仍无法读取落盘文件：${downloaded.localFile}`)
      resolved = { localFile: downloaded.localFile, bytes: fresh.size }
    } catch (error) {
      exchange.fail(502, 'DOWNLOAD_FAILED', error instanceof Error ? error.message : String(error))
      return
    }
    const filename = filePath.split('/').filter(Boolean).pop() || 'file'
    const ext = extname(filename).toLowerCase()
    const type = NAS_DOWNLOAD_MIME[ext] ?? 'application/octet-stream'
    const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`
    exchange.res.writeHead(200, {
      'content-type': type,
      'content-length': String(resolved.bytes),
      'content-disposition': disposition,
      'cache-control': 'no-cache',
    })
    createReadStream(resolved.localFile).pipe(exchange.res)
  }, { access: 'public', selfValidated: true })

  /** 批量上传（保留目录结构）：files = [{ relativePath, contentBase64 }]，destDir=目标目录。 */
  guarded('POST', '/api/nas/:id/fs/upload-many', 'nas.write', async (exchange) => {
    const input = body<{ files: Array<{ relativePath: string; contentBase64: string }>; destDir: string }>(exchange)
    if (!Array.isArray(input.files) || input.files.length === 0) throw new Error('files 不能为空')
    if (!input.destDir) throw new Error('缺少 destDir')
    const info = caller(exchange)
    const result = await ctx.nasRegistry.uploadMany(exchange.params['id']!, input.files.map((f) => ({
      relativePath: String(f.relativePath ?? '').replace(/^\/+/, ''),
      contentBase64: String(f.contentBase64 ?? ''),
    })), String(input.destDir).replace(/^\/+|\/+$/g, ''), { id: info.userId ?? info.principalId, name: info.name })
    changeLog(exchange, 'nas.fs.upload_many', 'nas', exchange.params['id']!, '', `成功 ${result.uploaded.length} / 失败 ${result.failed.length} → ${input.destDir}`)
    return result
  })

  // -- NAS 数据权限（plugin-nas/nasAuthz，dev-plan-nas-authz §2.3）------------------------
  // 判定/申请类端点的真实用户身份支持 X-On-Behalf-User 头（网关/hermes 透传），与 body.userId 等价；
  // 身份永不进模型工具参数（P0-2 教训）。
  const onBehalfUser = (exchange: HttpExchange): string | undefined => {
    const header = exchange.headers['x-on-behalf-user']
    const value = Array.isArray(header) ? header[0] : header
    return value && String(value).trim() !== '' ? String(value).trim() : undefined
  }

  guarded('POST', '/api/nas/authz/check', 'nas.authz.check', async (exchange) => {
    const input = body<{ nasId: string; userId?: string; paths: string[] | string; op: string; override?: boolean }>(exchange)
    if (!input.nasId) throw new Error('缺少 nasId')
    const userId = onBehalfUser(exchange) ?? input.userId
    if (!userId) throw new Error('缺少 userId（或 X-On-Behalf-User 头）')
    const info = caller(exchange)
    if (input.override === true) {
      // 破窗：仅持 nas.authz.write 的运维可强制 P 判定（强制留痕在 nasAuthz 内完成）
      if (!requirePermission(exchange, 'nas.authz.write')) return
    }
    return ctx.nasAuthz.check({
      nasId: String(input.nasId), userId: String(userId),
      paths: Array.isArray(input.paths) ? input.paths : [String(input.paths ?? '')],
      op: String(input.op) as never,
      ...(input.override !== undefined ? { override: input.override === true } : {}),
      caller: info.name,
    })
  })

  guarded('GET', '/api/nas/authz/scope', 'nas.authz.check', (exchange) => {
    const nasId = exchange.query.get('nasId')
    const userId = onBehalfUser(exchange) ?? exchange.query.get('userId') ?? ''
    if (!nasId || !userId) throw new Error('缺少 nasId 或 userId 查询参数')
    return ctx.nasAuthz.scopeOf(nasId, userId)
  })

  guarded('GET', '/api/nas/authz/rules', 'nas.authz.read', () => ctx.nasAuthz.getRules())

  http.register('PUT', '/api/nas/authz/rules', async (exchange) => {
    if (!requirePermission(exchange, 'nas.authz.write')) return
    const input = body<{ ifVersion: number; matrixOverrides?: Record<string, Record<string, boolean>>; exceptions?: unknown[]; cGroups?: string[]; externalReadPaths?: Array<{ nasId: string; path: string }>; observeOnly?: boolean; degradeAllToReadonly?: boolean }>(exchange)
    try {
      const saved = ctx.nasAuthz.updateRules({
        ...(input.matrixOverrides !== undefined ? { matrixOverrides: input.matrixOverrides as never } : {}),
        ...(input.exceptions !== undefined ? { exceptions: input.exceptions as never } : {}),
        ...(input.cGroups !== undefined ? { cGroups: input.cGroups } : {}),
        ...(input.externalReadPaths !== undefined ? { externalReadPaths: input.externalReadPaths } : {}),
        ...(input.observeOnly !== undefined ? { observeOnly: input.observeOnly } : {}),
        ...(input.degradeAllToReadonly !== undefined ? { degradeAllToReadonly: input.degradeAllToReadonly } : {}),
      }, Number(input.ifVersion), caller(exchange).name)
      changeLog(exchange, 'nas.authz.rules_update', 'nas_authz_rules', 'singleton', 'NAS 数据权限规则', `version → ${saved.version}`)
      exchange.ok(saved)
    } catch (error) {
      if (error instanceof RulesVersionConflictError) {
        exchange.fail(409, 'VERSION_CONFLICT', error.message, { currentVersion: error.currentVersion })
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write' })

  guarded('POST', '/api/nas/authz/rules/import', 'nas.authz.write', (exchange) => {
    const seed = body<Record<string, unknown>>(exchange)
    const result = ctx.nasAuthz.importRules(seed as never, caller(exchange).name)
    changeLog(exchange, 'nas.authz.rules_import', 'nas_authz_rules', 'singleton', 'NAS 数据权限规则',
      `${result.changed ? `version → ${result.version}` : '内容一致（幂等跳过）'}${result.unresolvedGroups.length > 0 ? `；未解析组：${result.unresolvedGroups.join(',')}` : ''}`)
    return result
  })

  guarded('GET', '/api/nas/authz/exceptions', 'nas.authz.read', () => ({ exceptions: ctx.nasAuthz.listExceptions() }))

  /**
   * 例外端点（双模式，dev-plan-nas-authz §2.3/§2.7）：
   * - status='pending'：share 申请入口（hermes/成员，需 nas.authz.check）→ 自动生成审批单，审批人沿组织链自动路由；
   * - effect='allow'/'deny'：运维直写资源级例外（需 nas.authz.write）。
   */
  http.register('POST', '/api/nas/authz/exceptions', async (exchange) => {
    const input = body<{ status?: string; nasId?: string; userId?: string; path?: string; reason?: string; effect?: 'allow' | 'deny'; ops?: string[]; expiresAt?: string; note?: string }>(exchange)
    if (input.status === 'pending') {
      if (!requirePermission(exchange, 'nas.authz.check')) return
      if (!input.nasId || !input.path) {
        exchange.fail(400, 'BAD_REQUEST', 'share 申请缺少 nasId/path')
        return
      }
      const userId = onBehalfUser(exchange) ?? input.userId
      if (!userId) {
        exchange.fail(400, 'BAD_REQUEST', '缺少 userId（或 X-On-Behalf-User 头）')
        return
      }
      try {
        const request = await ctx.nasAuthz.requestShareApproval({
          nasId: String(input.nasId), userId: String(userId), path: String(input.path),
          ...(input.reason !== undefined ? { reason: String(input.reason) } : {}),
        })
        changeLog(exchange, 'nas.authz.share_request', 'nas_authz_rules', request.approvalId, 'share 分享申请',
          `审批人路由：${request.escalated ? 'resource_admin 兜底' : request.approverSuggestion.orgName ?? ''}`)
        exchange.ok({ kind: 'approval', ...request })
      } catch (error) {
        exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (!requirePermission(exchange, 'nas.authz.write')) return
    if (!input.effect || !input.nasId || !input.path || !Array.isArray(input.ops)) {
      exchange.fail(400, 'BAD_REQUEST', '例外直写需要 effect/nasId/path/ops')
      return
    }
    try {
      const exception = ctx.nasAuthz.addException({
        effect: input.effect, nasId: String(input.nasId), path: String(input.path),
        ops: input.ops as never[],
        ...(input.userId ? { userIds: [String(input.userId)] } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        ...(input.note ? { note: input.note } : {}),
      }, caller(exchange).name)
      changeLog(exchange, 'nas.authz.exception_add', 'nas_authz_rules', exception.id, 'NAS 数据权限例外', `${input.effect} ${input.path} [${input.ops.join(',')}]`)
      exchange.ok(exception)
    } catch (error) {
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write,nas.authz.check' })

  /**
   * 文件所有权登记（2026-09-17 新增，上传者对自有文档默认全权）：
   * - POST /record：网关写类操作（fs_upload/fs_delete/fs_rename/fs_copy_move）成功后的登记/维护上报，
   *   供 hermes/直连 MCP 客户端的操作同步所有权（控制台链路由 nasRegistry 原生维护，双路上报幂等）；
   * - GET：排查/审计查询。
   */
  http.register('POST', '/api/nas/authz/ownership/record', async (exchange) => {
    if (!requirePermission(exchange, 'nas.ownership.write')) return
    const input = body<{ nasId: string; userId: string; tool: string; args?: { path?: string | string[]; folder_path?: string | string[]; dest_path?: string; local_file?: string; name?: string | string[]; dest_folder_path?: string; remove_src?: boolean } }>(exchange)
    if (!input.nasId || !input.userId || !input.tool) {
      exchange.fail(400, 'BAD_REQUEST', '缺少 nasId/userId/tool')
      return
    }
    const listOf = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [String(v)] : []).map(String).filter(Boolean)
    const joinPosix = (dir: string, name: string): string => `/${[...dir.split('/'), ...name.split('/')].filter(Boolean).join('/')}`
    try {
      const args = input.args ?? {}
      let result: unknown = { ignored: true, tool: input.tool }
      if (input.tool === 'fs_upload' && args.dest_path && args.local_file) {
        const filename = String(args.local_file).split('/').filter(Boolean).pop() ?? ''
        result = ctx.nasAuthz.recordOwnership({ nasId: String(input.nasId), path: joinPosix(String(args.dest_path), filename), userId: String(input.userId), source: 'gateway:upload' })
      } else if (input.tool === 'fs_delete') {
        result = { removed: ctx.nasAuthz.removeOwnershipFor(String(input.nasId), listOf(args.path)) }
      } else if (input.tool === 'fs_rename' && listOf(args.path).length > 0) {
        const paths = listOf(args.path)
        const names = listOf(args.name)
        result = { rewritten: paths.map((p, i) => ctx.nasAuthz.rewriteOwnershipFor(String(input.nasId), p, joinPosix(p.split('/').slice(0, -1).join('/'), names[i] ?? ''))).reduce((a, b) => a + b, 0) }
      } else if (input.tool === 'fs_copy_move' && args.dest_folder_path) {
        const moving = args.remove_src === true
        let touched = 0
        for (const p of listOf(args.path)) {
          const dest = joinPosix(String(args.dest_folder_path), p.split('/').filter(Boolean).pop() ?? '')
          if (moving) touched += ctx.nasAuthz.rewriteOwnershipFor(String(input.nasId), p, dest)
          else if (ctx.nasAuthz.recordOwnership({ nasId: String(input.nasId), path: dest, userId: String(input.userId), source: 'gateway:copy' })) touched++
        }
        result = { touched }
      }
      exchange.ok(result)
    } catch (error) {
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.ownership.write' })

  guarded('GET', '/api/nas/authz/ownership', 'nas.authz.read', (exchange) => {
    const nasId = exchange.query.get('nasId') ?? undefined
    const userId = exchange.query.get('userId') ?? undefined
    const path = exchange.query.get('path') ?? undefined
    return { items: ctx.nasAuthz.listOwnership({ ...(nasId ? { nasId } : {}), ...(userId ? { userId } : {}), ...(path ? { path } : {}) }) }
  })

  guarded('GET', '/api/nas/authz/decisions', 'nas.authz.read', (exchange) => {    const limit = Math.min(500, Number(exchange.query.get('limit') ?? 100))
    const decision = exchange.query.get('decision')
    const nasId = exchange.query.get('nasId')
    const userId = exchange.query.get('userId')
    const items = ctx.nasAuthz.decisions().find((record) => {
      if (decision && record.decision !== decision) return false
      if (nasId && record.nasId !== nasId) return false
      if (userId && record.userId !== userId) return false
      return true
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return { total: items.length, items: items.slice(0, limit) }
  })

  guarded('POST', '/api/nas/authz/reconcile', 'nas.authz.read', async (exchange) => {
    const report = await ctx.nasAuthz.dailyReconcile()
    changeLog(exchange, 'nas.authz.reconcile', 'nas_authz_rules', '', '组织目录对账', `${report.length} 台在线 NAS`)
    return { report }
  })

  guarded('POST', '/api/nas/authz/leader-vacancy-scan', 'nas.authz.read', (exchange) => {
    const vacant = ctx.nasAuthz.scanLeaderVacancy()
    changeLog(exchange, 'nas.authz.leader_vacancy_scan', 'nas_authz_rules', '', '负责人悬空扫描', `悬空 ${vacant.length} 个组织`)
    return { vacant }
  })

  // -- Agent --------------------------------------------------------------
  /** 机器身份读台账审计：接入提示词以「带机器令牌 GET /api/agents」为接入验证话术，此处让其成为事实。
   *  只记机器身份（人类控制台读操作高频，全量记录成噪音；机器读台账低频且带治理含义）。 */
  const machineAudit = (exchange: HttpExchange, resourceId: string, resourceName: string): void => {
    const info = caller(exchange)
    if (info.kind !== 'machine') return
    ctx.audit.record({
      type: 'auth', actorType: 'machine', actorId: info.principalId, actorName: info.name,
      action: 'agent.verify', resourceType: 'agent', resourceId, resourceName,
      result: 'ok', detail: '机器身份访问 Agent 台账（接入验证/资产探测留痕）',
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    })
  }

  guarded('GET', '/api/agents', 'agent.read', (exchange) => {
    machineAudit(exchange, '-', 'Agent 台账')
    return {
      agents: ctx.resourceCore.list('agent').map((agent) => ({
        ...agent,
        metrics: ctx.agentRegistry.metrics(agent.id),
        boundUserCount: ctx.agentRegistry.bindings().find((item) => item.agentId === agent.id).length,
        availableTransitions: ctx.resourceCore.availableTransitions('agent', agent.id),
      })),
      schema: ctx.resourceCore.typeSpec('agent')?.schema,
      lifecycle: ctx.resourceCore.typeSpec('agent')?.lifecycle,
    }
  })

  // -- 数据要素域（IAW 交接 2-1..2-4：数据集/质量分/血缘/指标字典） ----------------
  // 读面（panel.read）：面板场景抽屉/数据空间消费；写面（resource.dataset.write）：资源管理员治理。
  guarded('GET', '/api/resource/datasets', 'panel.read', (exchange) => ({
    datasets: ctx.resourceCore.listDatasets({
      ...(exchange.query.get('scene') ? { sceneCode: exchange.query.get('scene')! } : {}),
      ...(exchange.query.get('classification') ? { classification: exchange.query.get('classification')! } : {}),
      ...(exchange.query.get('org') ? { orgId: exchange.query.get('org')! } : {}),
      ...(exchange.query.get('q') ? { q: exchange.query.get('q')! } : {}),
    }),
  }))

  guarded('PUT', '/api/resource/datasets', 'resource.dataset.write', (exchange) => {
    const input = body<{ code: string; name: string; sourceSystem: string; classification: 'public' | 'internal' | 'secret'; refreshFrequency?: string; ownerOrgId?: string; sceneCodes?: string[]; note?: string }>(exchange)
    const dataset = ctx.resourceCore.upsertDataset(input)
    changeLog(exchange, 'resource.dataset.upsert', 'dataset', dataset.id, dataset.name, `${dataset.code} 分级=${dataset.classification} 场景=${dataset.sceneCodes.join(',') || '无'}`)
    return dataset
  })

  guarded('PUT', '/api/resource/datasets/:code/quality', 'resource.dataset.write', (exchange) => {
    const input = body<{ completeness: number; accuracy: number; timeliness: number; consistency: number; note?: string }>(exchange)
    const dataset = ctx.resourceCore.scoreDataset(exchange.params['code']!, input)
    changeLog(exchange, 'resource.dataset.score', 'dataset', dataset.id, dataset.name, `overall=${dataset.quality?.overall}`)
    return dataset
  })

  guarded('GET', '/api/resource/lineage', 'panel.read', (exchange) => {
    const dataset = exchange.query.get('dataset') ?? ''
    if (!dataset) {
      exchange.fail(400, 'BAD_REQUEST', 'dataset 参数必填（数据集编号）')
      return
    }
    return ctx.resourceCore.lineage(dataset)
  })

  guarded('PUT', '/api/resource/lineage', 'resource.dataset.write', (exchange) => {
    const input = body<{ derived: string; source: string; kind?: string }>(exchange)
    if (!input.derived?.trim() || !input.source?.trim()) {
      exchange.fail(400, 'BAD_REQUEST', 'derived 与 source（数据集编号）必填')
      return
    }
    const edge = ctx.resourceCore.addLineage(input.derived.trim(), input.source.trim(), input.kind ?? 'lineage')
    changeLog(exchange, 'resource.lineage.add', 'dataset_lineage', edge.id, `${input.source} → ${input.derived}`)
    return edge
  })

  guarded('GET', '/api/resource/metrics/:code/definitions', 'panel.read', (exchange) => ({
    code: exchange.params['code'],
    definitions: ctx.resourceCore.metricDefinitionsOf(exchange.params['code']!),
  }))

  guarded('PUT', '/api/resource/metrics/:code/definitions', 'resource.dataset.write', (exchange) => {
    const input = body<{ name: string; unit?: string; description?: string; payload?: Record<string, unknown> }>(exchange)
    const info = caller(exchange)
    const result = ctx.resourceCore.putMetricDefinition({
      code: exchange.params['code']!,
      name: input.name,
      ...(input.unit ? { unit: input.unit } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
      recordedBy: info.userId ?? info.principalId,
    })
    changeLog(exchange, 'resource.metric.define', 'metric_definition', result.definition.id, `${exchange.params['code']}：${input.name}`, result.conflict ? '口径冲突留账（待仲裁）' : '登记')
    return result
  })

  guarded('POST', '/api/resource/metrics/:code/arbitrate', 'resource.dataset.write', (exchange) => {
    const input = body<{ definitionId: string }>(exchange)
    if (!input.definitionId?.trim()) {
      exchange.fail(400, 'BAD_REQUEST', 'definitionId 必填（仲裁胜出的口径定义）')
      return
    }
    const info = caller(exchange)
    const result = ctx.resourceCore.arbitrateMetric(exchange.params['code']!, input.definitionId, info.userId ?? info.principalId)
    changeLog(exchange, 'resource.metric.arbitrate', 'metric_definition', input.definitionId, exchange.params['code'] ?? '', `取代 ${result.superseded} 条旧口径`)
    return result
  })

  // -- A2A 跨运行时调用（IAW 交接 7-1 最小闭环） ---------------------------------
  // 平台原生 Agent 的 A2A 端点：外部运行时（Hermes/OpenClaw/WorkBuddy）凭机器凭证点名调用；
  // 响应回显 autonomy/runtime 供调用方做 A0-A3 交互深度协商（v1：级别随响应透出，深度协商留 v2）。
  guarded('POST', '/api/agents/:id/a2a/invoke', 'agent.a2a.invoke', async (exchange) => {
    const input = body<{ message: string; dataClass?: string; contextNote?: string }>(exchange)
    if (!input.message?.trim()) {
      exchange.fail(400, 'BAD_REQUEST', 'message 必填（A2A 点名调用内容）')
      return
    }
    const ref = exchange.params['id']!
    const agent = ctx.resourceCore.get('agent', ref) ?? ctx.resourceCore.bySlug('agent', ref)
    if (!agent) {
      exchange.fail(404, 'NOT_FOUND', `Agent 不存在：${ref}`)
      return
    }
    if (agent.status !== 'online') {
      exchange.fail(400, 'BAD_REQUEST', `Agent 未上线（${agent.status}），A2A 仅对 online 开放`)
      return
    }
    const attrs = agent.attrs as Record<string, unknown>
    const model = String(attrs.model ?? '')
    if (!model) return { ok: false, reason: 'Agent 未配置模型（model 属性为空）' }
    const info = caller(exchange)
    const orgId = (info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined) ?? agent.orgId ?? ''
    const subject = info.refType === 'agent' && info.refId ? `agent:${info.refId}` : (info.userId ? `user:${info.userId}` : `a2a:${info.principalId}`)
    const dataClass = input.dataClass === 'public' || input.dataClass === 'internal' || input.dataClass === 'secret' ? input.dataClass : undefined
    const systemPrompt = String(attrs.systemPrompt ?? `你是企业数字同事「${agent.name}」。${String(attrs.description ?? '')}`)
    try {
      const result = await ctx.modelGateway.invoke({
        model,
        orgId,
        subject,
        ...(dataClass ? { dataClass } : {}),
        messages: [
          { role: 'system', content: input.contextNote ? `${systemPrompt}\n\n${input.contextNote}` : systemPrompt },
          { role: 'user', content: input.message },
        ],
      })
      try {
        ctx.usage.record(nonbillableUsage({
          org: orgId, subject, principal: orgId ? `org:${orgId}` : 'platform', resource: `agent:${agent.id}`,
          idempotency_key: `a2a:${agent.id}:${info.principalId}:${newId('a2a')}`,
        }))
      } catch { /* 计量面缺席不阻塞 A2A */ }
      ctx.audit.record({
        type: 'invoke', actorType: info.kind === 'human' ? 'human' : 'machine', actorId: subject, actorName: info.name,
        action: 'agent.a2a.invoke', resourceType: 'agent', resourceId: agent.id, resourceName: agent.name,
        result: 'ok', detail: `runtime=${String(attrs.runtime ?? 'dsh')} autonomy=${String(attrs.autonomy ?? 'A0')} model=${result.model}`,
      })
      ctx.platformBus.emit(PlatformEvents.AgentA2aInvoked, {
        agentId: agent.id, slug: agent.slug, from: subject, model: result.model,
        autonomy: String(attrs.autonomy ?? 'A0'), runtime: String(attrs.runtime ?? 'dsh'),
      })
      return {
        ok: true, reply: result.content, model: result.model,
        autonomy: String(attrs.autonomy ?? 'A0'), runtime: String(attrs.runtime ?? 'dsh'),
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      ctx.audit.record({
        type: 'invoke', actorType: info.kind === 'human' ? 'human' : 'machine', actorId: subject, actorName: info.name,
        action: 'agent.a2a.invoke', resourceType: 'agent', resourceId: agent.id, resourceName: agent.name,
        result: 'error', detail: `失败：${reason}`,
      })
      return { ok: false, reason, autonomy: String(attrs.autonomy ?? 'A0'), runtime: String(attrs.runtime ?? 'dsh') }
    }
  })

  /** Agent 详情页 SSO 配置块（不含 secret；含 discovery，供前端与 dsh 免登接入使用）。 */
  const agentSsoView = (agentId: string) => {
    const ssoClient = ctx.oidc.clientsForAgent(agentId)[0]
    if (!ssoClient) return null
    const { clientSecretHash: _hash, ...ssoSafe } = ssoClient
    void _hash
    return {
      ...ssoSafe,
      status: ssoSafe.status ?? 'active',
      clientType: ssoSafe.clientType ?? 'confidential',
      refAgentName: ctx.resourceCore.get('agent', ssoSafe.refId ?? '')?.name ?? undefined,
      discovery: {
        issuer: ctx.oidc.issuer(),
        authorization_endpoint: `${ctx.oidc.issuer()}/oauth/authorize`,
        token_endpoint: `${ctx.oidc.issuer()}/oauth/token`,
        userinfo_endpoint: `${ctx.oidc.issuer()}/oauth/userinfo`,
      },
    }
  }

  guarded('GET', '/api/agents/:id', 'agent.read', (exchange) => {
    const id = exchange.params['id']!
    const agent = ctx.resourceCore.get('agent', id)
    if (!agent) throw new Error(`Agent 不存在：${id}`)
    machineAudit(exchange, id, agent.name)
    const principal = ctx.agentRegistry.machinePrincipal(id)
    return {
      ...agent,
      metrics: ctx.agentRegistry.metrics(id),
      boundUsers: ctx.agentRegistry.boundUsers(id),
      availableTransitions: ctx.resourceCore.availableTransitions('agent', id),
      credential: principal ? { principalId: principal.id, clientId: principal.clientId, status: principal.status, activeTokens: ctx.authn.activeTokenCount(principal.id) } : null,
      topology: enrichTopology(ctx.resourceCore.topology('agent', id, 2)),
      impact: ctx.resourceCore.impact('agent', id),
      audit: ctx.audit.query({ resourceType: 'agent', resourceId: id, limit: 30 }).items,
      sso: agentSsoView(id),
      ssoEnforceMode: AgentRegistryService.ssoEnforceMode(),
    }
  })

  guarded('POST', '/api/agents', 'agent.write', (exchange) => {
    const input = body<{ name: string; slug?: string; attrs?: Record<string, unknown> }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const result = ctx.agentRegistry.register({
      ...input,
      ownerId: info.userId ?? info.principalId,
      ownerName: info.name,
      orgId: user?.orgId ?? ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
    })
    return { agent: result.agent, credential: result.credential ?? null }
  })

  guarded('PATCH', '/api/agents/:id', 'agent.write', (exchange) => {
    const input = body<{ name?: string; attrs?: Record<string, unknown> }>(exchange)
    const agent = ctx.resourceCore.update('agent', exchange.params['id']!, input)
    changeLog(exchange, 'agent.update', 'agent', agent.id, agent.name)
    return agent
  })

  // Agent 接入提示词（与 app 同构）：rotate=true 轮换机器凭证并随提示词返回完整凭证（旧值立即失效）。
  guarded('POST', '/api/agents/:id/onboarding-prompt', 'agent.write', (exchange) => {
    const { rotate } = body<{ rotate?: boolean }>(exchange)
    const id = exchange.params['id']!
    const result = ctx.agentRegistry.buildOnboardingPrompt(id, requestOrigin(exchange) ?? 'http://127.0.0.1:7300', { rotate: rotate === true })
    changeLog(exchange, 'agent.onboarding-prompt', 'agent', id, result.agentName, result.rotated ? '轮换机器凭证并生成接入提示词（旧 secret 立即失效）' : '生成接入提示词（未轮换，不含 secret）')
    return result
  })

  // 运营数据提报（Agent 接入义务，与 AI 应用 metrics-report 同级）：dau 同日取最大、会话数累加、用户哈希去重并集
  guarded('POST', '/api/agents/:id/metrics-report', 'agent.write', (exchange) => {
    const id = exchange.params['id']!
    const input = body<{ dau?: number; sessions?: number; userIds?: string[]; uniqueUsers?: number; date?: string }>(exchange)
    ctx.agentRegistry.reportUsage(id, input)
    const agent = ctx.resourceCore.get('agent', id)!
    changeLog(exchange, 'agent.metrics.report', 'agent', id, agent.name,
      `dau=${input.dau ?? '-'} sessions=${input.sessions ?? '-'} users=${input.userIds?.length ?? input.uniqueUsers ?? '-'} date=${input.date ?? '当日'}`)
    return ctx.agentRegistry.metrics(id)
  })

  guarded('POST', '/api/agents/:id/bindings', 'agent.write', (exchange) => {
    const { userId } = body<{ userId: string }>(exchange)
    const binding = ctx.agentRegistry.bindUser(exchange.params['id']!, userId, caller(exchange).name)
    changeLog(exchange, 'agent.bind_user', 'agent', binding.agentId, '', binding.userName)
    return binding
  })

  guarded('DELETE', '/api/agents/:id/bindings/:userId', 'agent.write', (exchange) => {
    ctx.agentRegistry.unbindUser(exchange.params['id']!, exchange.params['userId']!)
    return { unbound: true }
  })

  /** 删除 Agent：草稿（从未上线）或已归档可删；被未归档资源（如 AI 应用）引用时拒绝。 */
  guarded('DELETE', '/api/agents/:id', 'agent.write', (exchange) => {
    const id = exchange.params['id']!
    const agent = ctx.resourceCore.get('agent', id)
    if (!agent) throw new Error(`Agent 不存在：${id}`)
    const referencing = ctx.resourceCore.dependencies().find((record) => record.toType === 'agent' && record.toId === id)
      .map((record) => (ctx.resourceCore.typeSpec(record.fromType) ? ctx.resourceCore.get(record.fromType, record.fromId) : undefined))
      .filter((entity) => entity !== undefined && entity.status !== 'archived')
    if (referencing.length > 0) {
      throw new Error(`该 Agent 仍被 ${referencing.map((entity) => entity!.name).join('、')} 引用，请先解除引用或归档引用方`)
    }
    ctx.resourceCore.remove('agent', id, { allowStates: ['draft', 'archived'] })
    ctx.agentRegistry.purge(id)
    changeLog(exchange, 'agent.delete', 'agent', id, agent.name)
    return { deleted: true }
  })

  guarded('POST', '/api/agents/:id/transition', 'agent.approve', (exchange) => {
    const { action, note } = body<{ action: string; note?: string }>(exchange)
    const info = caller(exchange)
    const id = exchange.params['id']!
    if (action === 'online') {
      const approval = ctx.agentRegistry.requestOnline(id, { id: info.userId ?? info.principalId, name: info.name })
      return { approval, note: '上线为 L4 操作，已创建审批单' }
    }
    if (action === 'offline') {
      const approval = ctx.agentRegistry.requestOffline(id, { id: info.userId ?? info.principalId, name: info.name }, note ?? '')
      return { approval, note: '下线为 L4 操作，已创建审批单' }
    }
    if (action === 'submit_trial') return ctx.agentRegistry.trial(id, info.name, [])
    if (action === 'archive') return ctx.agentRegistry.archive(id, info.name)
    throw new Error(`未知操作：${action}`)
  })

  guarded('POST', '/api/agents/:id/obo-token', 'agent.write', (exchange) => {
    const info = caller(exchange)
    const header = String(exchange.headers['authorization'] ?? '').slice(7)
    const verified = ctx.authn.verify(header)
    if (verified.principal.type !== 'human') throw new Error('on-behalf-of 令牌必须由用户身份发起')
    // QA A-07：透传令牌是「以该用户身份行事」的高敏凭证——此前任意 agent.write 持有者
    // 可对他人 Agent 签发。收敛为：owner / 绑定用户 / 平台管理员（'*'）。
    const id = exchange.params['id']!
    const agent = ctx.resourceCore.get('agent', id)
    if (!agent) throw new Error(`Agent 不存在：${id}`)
    const isOwner = info.userId !== undefined && agent.ownerId === info.userId
    const isBound = ctx.agentRegistry.boundUsers(id).some((item) => item.userId === info.userId)
    if (!isOwner && !isBound && !info.permissions.includes('*')) {
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info.userId ?? info.principalId,
        actorName: info.name,
        point: `agent.obo(owner:${id})`,
        path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', `仅 Agent 负责人或绑定用户可代「${agent.name}」签发 on-behalf-of 令牌（QA A-07）`)
      return
    }
    const result = ctx.agentRegistry.issueOnBehalfOfToken(id, verified)
    changeLog(exchange, 'agent.obo_token', 'agent', id, '', `链路：${result.actChain.map((item) => (item as { name: string }).name).join(' → ')}`)
    return result
  })

  // -- 平台授权直达（entry-ticket）：控制台「打开交互界面/打开应用」带平台身份访问 ---------
  /**
   * 签发 Agent 入场票据（human-only）：「使用即授权留痕」——仅 owner、绑定用户或管理员可直达，
   * 未授权用户被拒并指路绑定流程。票据一次性 + 短时（默认 120s），Agent 前端以
   * POST /api/authn/entry-tickets/redeem 兑换平台身份（详见 docs/agent-onboarding.md）。
   */
  guarded('POST', '/api/agents/:id/entry-ticket', 'agent.read', (exchange) => {
    const info = caller(exchange)
    if (info.kind !== 'human' || !info.userId) {
      exchange.fail(403, 'FORBIDDEN', '平台授权直达仅限登录用户（human），机器身份不可签发入场票据')
      return
    }
    const id = exchange.params['id']!
    const agent = ctx.resourceCore.get('agent', id)
    if (!agent) throw new Error(`Agent 不存在：${id}`)
    const isOwner = agent.ownerId === info.userId
    const isBound = ctx.agentRegistry.boundUsers(id).some((item) => item.userId === info.userId)
    const isAdmin = info.permissions.includes('*') || info.permissions.includes('agent.write')
    if (!isOwner && !isBound && !isAdmin) {
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info.userId, actorName: info.name, point: `agent.entry(owner:${id})`, path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', `仅 Agent 负责人或绑定用户可直达「${agent.name}」交互界面（使用即授权留痕），请联系负责人在「权限与绑定」中绑定`)
      return
    }
    const issued = ctx.entryTickets.issue({ refType: 'agent', refId: id, userId: info.userId, userName: info.name })
    changeLog(exchange, 'agent.entry.ticket.issue', 'agent', id, agent.name, `一次性入场票据（${issued.ttlSeconds}s）`)
    return issued
  })

  /** 签发应用入场票据（human-only）：登录用户即可领取（应用内业务权限由应用自身裁决）。 */
  guarded('POST', '/api/apps/:id/entry-ticket', 'app.read', (exchange) => {
    const info = caller(exchange)
    if (info.kind !== 'human' || !info.userId) {
      exchange.fail(403, 'FORBIDDEN', '平台授权直达仅限登录用户（human），机器身份不可签发入场票据')
      return
    }
    const id = exchange.params['id']!
    const app = ctx.resourceCore.get('app', id)
    if (!app) throw new Error(`应用不存在：${id}`)
    const issued = ctx.entryTickets.issue({ refType: 'app', refId: id, userId: info.userId, userName: info.name })
    changeLog(exchange, 'app.entry.ticket.issue', 'app', id, app.name, `一次性入场票据（${issued.ttlSeconds}s）`)
    return issued
  })

  /**
   * 兑换入场票据（公开端点，票据本身即临时凭证）：一次性消费 → 实时校验用户状态 → 交付平台身份。
   * CORS：本端点的调用方是任意 entryUrl 的交互界面前端（来源不可枚举，票据即凭证），
   * 放行任意 Origin 的 POST + OPTIONS 预检；平台其余 /api 仍保持同源收紧。
   */
  const redeemCorsHeaders: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  }
  http.register('OPTIONS', '/api/authn/entry-tickets/redeem', (exchange) => {
    if (!exchange.res.writableEnded) {
      exchange.res.writeHead(204, redeemCorsHeaders)
      exchange.res.end()
    }
  }, { access: 'public' })
  http.register('POST', '/api/authn/entry-tickets/redeem', (exchange) => {
    const input = body<{ ticket?: string }>(exchange)
    const clientIp = String(exchange.raw.socket?.remoteAddress ?? 'unknown')
    for (const [key, value] of Object.entries(redeemCorsHeaders)) exchange.res.setHeader(key, value)
    try {
      const result = ctx.entryTickets.redeem(String(input.ticket ?? ''), clientIp)
      ctx.audit.record({
        type: 'auth', actorType: 'human', actorId: result.identity.sub, actorName: result.identity.name,
        action: `${result.refType}.entry.ticket.redeem`, resourceType: result.refType, resourceId: result.refId,
        resourceName: result.refId, result: 'ok', detail: '平台授权直达票据兑换（身份已交付目标交互界面）',
      })
      // 广播兑换事件（plugin-app 订阅 → 应用 DAU 自动折算；状态变更必发事件，跨插件联动不经直连）
      ctx.platformBus.emit(PlatformEvents.EntryTicketRedeemed, {
        refType: result.refType, refId: result.refId, userId: result.identity.sub, userName: result.identity.name,
      })
      exchange.ok(result)
    } catch (error) {
      exchange.fail(400, 'ENTRY_TICKET_INVALID', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'public', selfValidated: true })

  /**
   * 票据免登控制台（公开端点，与 redeem 同安全语义）：一次性票据兑换 → 直接建立控制台会话，
   * 门户/钉钉「打开即工作台」零二次登录。票据只进请求体与内存，不进常驻 URL、不进服务端日志；
   * 签发侧授权语义已在领票端点定格（agent：owner/绑定用户/管理员；app：登录用户），此处仅消费。
   */
  http.register('POST', '/api/auth/entry-ticket-session', (exchange) => {
    const input = body<{ ticket?: string }>(exchange)
    const clientIp = String(exchange.raw.socket?.remoteAddress ?? 'unknown')
    try {
      const redeemed = ctx.entryTickets.redeem(String(input.ticket ?? ''), clientIp)
      const user = ctx.iam.users().get(redeemed.identity.sub)
      if (!user || user.status !== 'active') throw new Error('签发用户状态异常（冻结/离职联动失效）')
      const principal = ctx.authn.ensureHumanPrincipal(user.id, user.displayName)
      const session = ctx.authn.issueSessionPair(principal.id, { issuedBy: `entry-ticket:${redeemed.refType}:${redeemed.refId}` })
      ctx.iam.markLogin(user.id)
      ctx.audit.record({
        type: 'auth', actorType: 'human', actorId: user.id, actorName: user.displayName,
        action: `${redeemed.refType}.entry.ticket.session`, resourceType: redeemed.refType, resourceId: redeemed.refId,
        resourceName: redeemed.refId, result: 'ok', detail: '入场票据兑换控制台会话（免登直达工作台）',
      })
      // 与 redeem 同源广播（plugin-app 订阅 → 应用 DAU 折算）：app 票据经免登通道兑换不丢到访计数
      ctx.platformBus.emit(PlatformEvents.EntryTicketRedeemed, {
        refType: redeemed.refType, refId: redeemed.refId, userId: user.id, userName: user.displayName,
      })
      exchange.ok({
        token: session.token,
        refreshToken: session.refreshToken,
        expiresAt: session.access.expiresAt,
        user: {
          id: user.id, username: user.username, displayName: user.displayName,
          orgId: user.orgId, roleIds: user.roleIds,
          roles: user.roleIds.map((roleId) => ctx.iam.roles().get(roleId)?.name).filter(Boolean),
          permissions: ctx.iam.userPermissions(user.id),
        },
      })
    } catch (error) {
      exchange.fail(400, 'ENTRY_TICKET_INVALID', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'public', selfValidated: true })

  /**
   * 自助入场票据（交接清单 G1）：已登录人类为自己签发一次性短时票据，供跨源自举回跳——
   * 远程 dsh 面板向导以 ?next=<本机面板地址> 打开宿主登录页，登录（含钉钉扫码）完成后回跳
   * next 并以 #entry_ticket= 片段携带票据，dsh 侧经既有公开兑换端点建立会话（零手工回导）。
   * TTL 硬上限 120s（覆盖 env 调高），一次性/防重放复用 EntryTicket 既有语义。
   */
  guarded('POST', '/api/auth/entry-tickets/self', 'console.login', (exchange) => {
    const info = caller(exchange)
    if (!info.userId) throw new Error('仅平台登录人类可自助签发入场票据')
    const issued = ctx.entryTickets.issue(
      { refType: 'self', refId: info.userId, userId: info.userId, userName: info.name },
      { maxTtlSeconds: 120 },
    )
    changeLog(exchange, 'self.entry.ticket.issue', 'user', info.userId, info.name, `自助入场票据（跨源自举回跳，${issued.ttlSeconds}s，一次性）`)
    return issued
  })

  // -- 应用访客埋点 beacon（公开端点：浏览器 PV/UV 上报，免机器鉴权） ----------------
  // 指标口径补全：应用页面在加载/路由切换时上报一次即可。GET 返回 1x1 GIF（<img>/fetch(no-cors) 均可跨域），
  // POST JSON 供 navigator.sendBeacon；匿名访客以 vid 去重（8-64 位 base64url，建议 localStorage 持久随机 ID），
  // 缺失时以 IP+UA 哈希兜底；响应不区分应用存在性（防探测），按 IP+应用做轻量限流（超限静默不计数）。
  const BEACON_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  const beaconCorsHeaders: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  }
  const beaconThrottle = new Map<string, number[]>()
  const clientIpOf = (exchange: HttpExchange): string => String(exchange.raw.socket?.remoteAddress ?? 'unknown')
  const beaconVidOf = (exchange: HttpExchange, raw: string | null | undefined): string => {
    const vid = String(raw ?? '').trim()
    if (/^[A-Za-z0-9_-]{8,64}$/.test(vid)) return vid
    return createHash('sha256').update(`${clientIpOf(exchange)}|${String(exchange.headers['user-agent'] ?? '')}`).digest('base64url').slice(0, 24)
  }
  const beaconHit = (appId: string, vid: string, uid: string | undefined, ip: string): void => {
    // 轻量限流：同 IP 同应用每分钟最多 60 次计数（正常浏览远低于此；超限响应照常但不计 PV）
    const now = Date.now()
    const key = `${ip}:${appId}`
    const window = (beaconThrottle.get(key) ?? []).filter((ts) => now - ts < 60_000)
    window.push(now)
    beaconThrottle.set(key, window)
    if (window.length > 60) {
      if (beaconThrottle.size > 4096) {
        for (const [staleKey, stamps] of beaconThrottle) if (stamps.every((ts) => now - ts >= 60_000)) beaconThrottle.delete(staleKey)
      }
      return
    }
    ctx.appRegistry.trackVisit(appId, { vid, ...(uid !== undefined && uid !== '' ? { userId: uid } : {}), pv: 1 })
  }
  // 须先于 GET /api/apps/:id 注册（路由先匹配先中，避免 beacon 被当作应用 ID）
  http.register('OPTIONS', '/api/apps/beacon', (exchange) => {
    if (!exchange.res.writableEnded) {
      exchange.res.writeHead(204, beaconCorsHeaders)
      exchange.res.end()
    }
  }, { access: 'public' })
  http.register('GET', '/api/apps/beacon', (exchange) => {
    try {
      beaconHit(String(exchange.query.get('app') ?? ''), beaconVidOf(exchange, exchange.query.get('vid')), exchange.query.get('uid') ?? undefined, clientIpOf(exchange))
    } catch { /* 指标采集永不影响调用方页面 */ }
    exchange.res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store, no-cache, must-revalidate, private', ...beaconCorsHeaders })
    exchange.res.end(BEACON_GIF)
  }, { access: 'public' })
  http.register('POST', '/api/apps/beacon', (exchange) => {
    const input = (exchange.body !== null && typeof exchange.body === 'object' ? exchange.body : {}) as { app?: string; vid?: string; uid?: string }
    try {
      beaconHit(String(input.app ?? ''), beaconVidOf(exchange, input.vid), input.uid ?? undefined, clientIpOf(exchange))
    } catch { /* 指标采集永不影响调用方页面 */ }
    for (const [key, value] of Object.entries(beaconCorsHeaders)) exchange.res.setHeader(key, value)
    exchange.ok({ reported: true })
  }, { access: 'public' })

  // -- Agent SSO 客户端（OIDC-agent 关联；owner 自助，对齐 app 侧） ----------------

  const ssoAgent = (exchange: HttpExchange): { id: string; name: string; ownerId: string } => {
    const agent = ctx.resourceCore.get('agent', exchange.params['id']!)
    if (!agent) throw new Error(`Agent 不存在：${exchange.params['id']}`)
    return { id: agent.id, name: agent.name, ownerId: agent.ownerId }
  }

  /**
   * SSO 管理守卫工厂（app/agent 两侧路由共用，授权口径统一在 AppRegistryService.ssoManageDecision）：
   * human = 资源 owner 或持 authn.oidc.write；机器身份绑定本资源（凭证 refType/refId 或登记 owner）
   * 时可自助签发/管理，但本次生效的回调集必须全为环回（localhost / 127.0.0.0/8 / ::1 / 0.0.0.0，
   * APP_SSO_MACHINE_LOOPBACK=0 可整体关闭该例外）；disable 纯降险恒放行。
   * 返回 false 表示已回 403（并发 audit.authz.denied 事件）。
   */
  const ssoManageGuard = (refType: 'app' | 'agent') => {
    const kindName = refType === 'app' ? '应用' : 'Agent'
    const resourceOf = (exchange: HttpExchange): { id: string; name: string; ownerId: string } => {
      const record = ctx.resourceCore.get(refType, exchange.params['id']!) as { id: string; name: string; ownerId: string } | undefined
      if (!record) throw new Error(`${kindName}不存在：${exchange.params['id']}`)
      return { id: record.id, name: record.name, ownerId: record.ownerId }
    }
    const existingClientOf = (id: string): { redirectUris?: string[]; postLogoutUris?: string[] } | undefined =>
      refType === 'app' ? ctx.oidc.clientsForApp(id)[0] : ctx.oidc.clientsForAgent(id)[0]
    return (exchange: HttpExchange, op: 'create' | 'update' | 'rotate' | 'enable' | 'disable', input?: { redirectUris?: string[]; postLogoutUris?: string[] }): boolean => {
      const resource = resourceOf(exchange)
      const info = caller(exchange)
      const existing = existingClientOf(resource.id)
      const decision = AppRegistryService.ssoManageDecision(resource, info, {
        redirectUris: input?.redirectUris ?? existing?.redirectUris ?? [],
        postLogoutUris: input?.postLogoutUris ?? existing?.postLogoutUris ?? [],
      }, op)
      if (decision.allowed) return true
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info.userId ?? info.principalId,
        actorName: info.name,
        point: `${refType}.sso(owner:${resource.id})`,
        path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', decision.reason)
      return false
    }
  }
  const agentSsoGuard = ssoManageGuard('agent')
  const appSsoGuard = ssoManageGuard('app')

  guarded('POST', '/api/agents/:id/sso-client', 'agent.write', (exchange) => {
    const input = body<{ redirectUris: string[]; clientType?: 'confidential' | 'public'; consentRequired?: boolean; postLogoutUris?: string[]; description?: string }>(exchange)
    if (!agentSsoGuard(exchange, 'create', { redirectUris: input.redirectUris, postLogoutUris: input.postLogoutUris })) return
    const agent = ssoAgent(exchange)
    const created = ctx.agentRegistry.createSsoClient(agent.id, input)
    changeLog(exchange, 'agent.sso.create', 'oidc_client', created.client.id, created.client.name, `Agent ${agent.name} 签发（${input.clientType ?? 'confidential'}）`)
    return {
      clientId: created.client.clientId,
      clientSecret: created.clientSecret,
      redirectUris: created.client.redirectUris,
      note: created.client.clientType === 'public' ? 'public 客户端无 secret（强制 PKCE、不发 refresh）' : 'clientSecret 仅此一次返回',
    }
  })

  guarded('PATCH', '/api/agents/:id/sso-client', 'agent.write', (exchange) => {
    const input = body<{ redirectUris?: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[] }>(exchange)
    if (!agentSsoGuard(exchange, 'update', { redirectUris: input.redirectUris, postLogoutUris: input.postLogoutUris })) return
    const agent = ssoAgent(exchange)
    const updated = ctx.agentRegistry.updateSsoClient(agent.id, input)
    changeLog(exchange, 'agent.sso.update', 'oidc_client', updated.id, updated.name)
    return updated
  })

  guarded('POST', '/api/agents/:id/sso-client/rotate', 'agent.write', (exchange) => {
    if (!agentSsoGuard(exchange, 'rotate')) return
    const agent = ssoAgent(exchange)
    const rotated = ctx.agentRegistry.rotateSsoSecret(agent.id)
    changeLog(exchange, 'agent.sso.rotate', 'oidc_client', rotated.client.id, rotated.client.name, '旧 secret 立即失效')
    return { clientId: rotated.client.clientId, clientSecret: rotated.clientSecret, note: '新 clientSecret 仅此一次返回，旧值立即失效' }
  })

  for (const action of ['disable', 'enable'] as const) {
    guarded('POST', `/api/agents/:id/sso-client/${action}`, 'agent.write', (exchange) => {
      if (!agentSsoGuard(exchange, action)) return
      const agent = ssoAgent(exchange)
      const { reason } = body<{ reason?: string }>(exchange)
      const client = action === 'disable'
        ? ctx.agentRegistry.disableSsoClient(agent.id, reason ?? 'owner 手动禁用')
        : ctx.agentRegistry.enableSsoClient(agent.id)
      changeLog(exchange, `agent.sso.${action}`, 'oidc_client', client.id, client.name, reason ?? '')
      return client
    })
  }

  // -- App ----------------------------------------------------------------
  guarded('GET', '/api/apps', 'app.read', () => ({
    apps: ctx.resourceCore.list('app').map((app) => ({
      ...app,
      metrics: ctx.appRegistry.metrics(app.id),
      availableTransitions: ctx.resourceCore.availableTransitions('app', app.id),
    })),
    schema: ctx.resourceCore.typeSpec('app')?.schema,
    lifecycle: ctx.resourceCore.typeSpec('app')?.lifecycle,
  }))

  // 开发者选择器数据源（注册表单下拉/搜索用）：挂在 app.write 下——能注册应用即可枚举
  // 在编用户的瘦字段（id/姓名/账号/部门/钉钉 unionId 绑定），不经 iam.user.read；须注册在 /api/apps/:id 之前（路由先匹配先中）
  guarded('GET', '/api/apps/developer-options', 'app.write', () => ({
    options: ctx.iam.users().find((user) => user.status === 'active')
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'))
      .map((user) => ({
        id: user.id,
        name: user.displayName,
        username: user.username,
        orgName: ctx.iam.orgs().get(user.orgId)?.name ?? '',
        // 钉钉身份绑定 unionId：供外部推送方把表格人员字段的 unionId 解析成平台账号（开发者字段落 developerId + 真实姓名）
        unionIds: (user.bindings ?? []).filter((b) => b.provider === 'dingtalk').map((b) => b.unionId),
      })),
  }))

  /** 开发者字段解析（attrs 原地修改）：developerId 须为在编平台用户，developerName 以 IAM displayName 为准；
   *  空串语义：POST 时不落字段，PATCH（allowClear）时显式清除开发者。 */
  const resolveDeveloperAttrs = (attrs: Record<string, unknown>, { allowClear = false } = {}): void => {
    const raw = attrs['developerId']
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id) {
      const user = ctx.iam.users().get(id)
      if (!user) throw new Error(`开发者不存在：${id}（developerId 须为平台用户 ID）`)
      if (user.status !== 'active') throw new Error(`开发者「${user.displayName}」非在编状态，不能登记为应用开发者`)
      attrs['developerId'] = user.id
      attrs['developerName'] = user.displayName
      return
    }
    if (raw === undefined) return
    if (allowClear) {
      attrs['developerId'] = ''
      attrs['developerName'] = ''
    } else {
      delete attrs['developerId']
    }
  }

  guarded('GET', '/api/apps/:id', 'app.read', (exchange) => {
    const id = exchange.params['id']!
    const app = ctx.resourceCore.get('app', id)
    if (!app) throw new Error(`应用不存在：${id}`)
    // SSO 配置块（不含 secret；供详情页「SSO 配置」tab 与门禁提示使用）
    const ssoClients = ctx.oidc.clientsForApp(id)
    const ssoClient = ssoClients[0]
    const { clientSecretHash, ...ssoSafe } = ssoClient ?? {}
    void clientSecretHash
    return {
      ...app,
      metrics: ctx.appRegistry.metrics(id),
      topology: enrichTopology(ctx.appRegistry.topology(id)),
      cost: ctx.appRegistry.costBreakdown(id),
      impact: ctx.resourceCore.impact('app', id),
      availableTransitions: ctx.resourceCore.availableTransitions('app', id),
      audit: ctx.audit.query({ resourceType: 'app', resourceId: id, limit: 30 }).items,
      sso: ssoClient
        ? {
          ...ssoSafe,
          status: ssoSafe.status ?? 'active',
          clientType: ssoSafe.clientType ?? 'confidential',
          refAppName: ctx.resourceCore.get('app', ssoSafe.refId ?? '')?.name ?? undefined,
          discovery: {
            issuer: ctx.oidc.issuer(),
            authorization_endpoint: `${ctx.oidc.issuer()}/oauth/authorize`,
            token_endpoint: `${ctx.oidc.issuer()}/oauth/token`,
            userinfo_endpoint: `${ctx.oidc.issuer()}/oauth/userinfo`,
          },
        }
        : null,
      ssoEnforceTypes: ((): string[] => {
        // 门禁形态提示（与 plugin-app 同源逻辑；动态 import 避免循环依赖）
        return String(process.env.APP_SSO_ENFORCE ?? 'web,h5').split(',').map((item) => item.trim()).filter(Boolean)
      })(),
    }
  })

  guarded('POST', '/api/apps', 'app.write', (exchange) => {
    const input = body<{ name: string; slug?: string; attrs?: Record<string, unknown>; agentIds?: string[] }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const attrs = { ...(input.attrs ?? {}) }
    resolveDeveloperAttrs(attrs)
    const result = ctx.appRegistry.register({
      ...input,
      attrs,
      ownerId: info.userId ?? info.principalId,
      ownerName: info.name,
      orgId: user?.orgId ?? ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
    })
    return { app: result.app, credential: result.credential ?? null }
  })

  /**
   * 应用写操作归属守卫（QA A-04）：PATCH/删除/指标上报/状态流转此前仅校验 app.write，
   * 任意 developer 可改写他人应用。平台管理员（'*'）、应用 owner、绑定本应用的机器主体
   * （refType=app 自助上报通道）之外一律 403 并落 audit.authz.denied。
   */
  const assertAppOwner = (exchange: HttpExchange, appId: string): boolean => {
    const info = caller(exchange)
    if (info.permissions.includes('*')) return true
    const app = ctx.resourceCore.get('app', appId)
    if (!app) throw new Error(`应用不存在：${appId}`)
    const isOwner = info.kind === 'human' && info.userId !== undefined && app.ownerId === info.userId
    const isBoundMachine = info.kind === 'machine' && info.refType === 'app' && info.refId === appId
    if (isOwner || isBoundMachine) return true
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point: `app.write(owner:${appId})`,
      path: exchange.path,
    })
    exchange.fail(403, 'FORBIDDEN', `仅平台管理员与应用负责人可变更「${app.name}」（owner 校验，QA A-04）`)
    return false
  }

  guarded('PATCH', '/api/apps/:id', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const input = body<{ name?: string; attrs?: Record<string, unknown> }>(exchange)
    const attrs = { ...(input.attrs ?? {}) }
    resolveDeveloperAttrs(attrs, { allowClear: true })
    const app = ctx.appRegistry.updateApp(exchange.params['id']!, { ...input, attrs })
    changeLog(exchange, 'app.update', 'app', app.id, app.name)
    return app
  })

  // 接入提示词（注册同款模板，平台侧生成）：rotate=true 轮换机器凭证 secret 并随提示词返回（旧值立即失效），
  // rotate=false 仅含 client_id（secret 丢失场景必须 rotate 才能拿到可用凭证）。控制台详情页按钮与外部推送方共用。
  guarded('POST', '/api/apps/:id/onboarding-prompt', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const { rotate } = body<{ rotate?: boolean }>(exchange)
    const id = exchange.params['id']!
    const result = ctx.appRegistry.buildOnboardingPrompt(id, requestOrigin(exchange) ?? 'http://127.0.0.1:7300', { rotate: rotate === true })
    changeLog(exchange, 'app.onboarding-prompt', 'app', id, result.appName, result.rotated ? '轮换机器凭证并生成接入提示词（旧 secret 立即失效）' : '生成接入提示词（未轮换，不含 secret）')
    return result
  })

  /** 删除应用：草稿（从未上线）或已归档可删；级联清除依赖边、禁用 SSO 客户端与机器凭证（记录保留）。 */
  guarded('DELETE', '/api/apps/:id', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const app = ctx.resourceCore.get('app', id)
    if (!app) throw new Error(`应用不存在：${id}`)
    ctx.resourceCore.remove('app', id, { allowStates: ['draft', 'archived'] })
    ctx.appRegistry.purge(id)
    changeLog(exchange, 'app.delete', 'app', id, app.name)
    return { deleted: true }
  })

  // 应用指标主动上报（接入方 → 宿主推送通道；同日 DAU/UV 取最大、会话/PV 累加，可指定 date 补录）
  guarded('POST', '/api/apps/:id/metrics-report', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const input = body<{ dau?: number; sessions?: number; avgDepth?: number; retention7?: number; pv?: number; uv?: number; date?: string }>(exchange)
    ctx.appRegistry.recordUsage(id, input)
    const app = ctx.resourceCore.get('app', id)!
    changeLog(exchange, 'app.metrics.report', 'app', id, app.name, `pv=${input.pv ?? '-'} uv=${input.uv ?? '-'} dau=${input.dau ?? '-'} sessions=${input.sessions ?? '-'} date=${input.date ?? '当日'}`)
    return ctx.appRegistry.metrics(id)
  })

  // 组织架构同步（应用自助复用平台组织模块）：绑定本应用的机器凭证/owner 拉平台组织树+在职成员，
  // 在应用内复刻平台组织架构功能；users[].id 即 SSO userinfo 的 sub。?ifNoneMatch=<version> 命中
  // 返回 {unchanged:true} 零载荷轮询。PII 最小化（无手机号/邮箱）；更全字段走 /api/iam/roster
  // （iam.roster.read，管理员追加）。批量组织数据出口，每次拉取记 invoke 审计（同 roster 口径）。
  guarded('GET', '/api/apps/:id/org-sync', 'app.read', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const ifNoneMatch = exchange.query.get('ifNoneMatch') ?? undefined
    const snapshot = ctx.appRegistry.orgSnapshot(id, { ...(ifNoneMatch ? { ifNoneMatch } : {}) })
    const info = caller(exchange)
    ctx.audit.record({
      type: 'invoke',
      actorType: info.kind === 'human' ? 'human' : 'machine',
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      action: 'app.org-sync.pull',
      resourceType: 'app',
      resourceId: id,
      resourceName: ctx.resourceCore.get('app', id)?.name ?? id,
      result: 'ok',
      detail: snapshot.unchanged
        ? `unchanged version=${snapshot.version}`
        : `orgs=${snapshot.orgs?.length ?? 0} users=${snapshot.users?.length ?? 0} version=${snapshot.version}`,
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    })
    return snapshot
  })

  guarded('POST', '/api/apps/:id/transition', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const { action, note } = body<{ action: string; note?: string }>(exchange)
    const info = caller(exchange)
    const id = exchange.params['id']!
    if (action === 'online') {
      const approval = ctx.appRegistry.requestOnline(id, { id: info.userId ?? info.principalId, name: info.name })
      return { approval, note: '发布为 L4 操作，已创建审批单' }
    }
    if (action === 'offline') {
      const approval = ctx.appRegistry.requestOffline(id, { id: info.userId ?? info.principalId, name: info.name }, note ?? '')
      return { approval, note: '下架为 L4 操作，已创建审批单' }
    }
    if (action === 'submit_trial') return ctx.resourceCore.transition('app', id, 'submit_trial', info.name).entity
    if (action === 'retrial') return ctx.resourceCore.transition('app', id, 'retrial', info.name).entity
    if (action === 'archive') return ctx.appRegistry.archive(id, info.name)
    throw new Error(`未知操作：${action}`)
  })

  // -- 应用 ↔ SSO 打通（owner 自助签发 + 机器环回自助，口径见 ssoManageGuard） ----
  const ssoApp = (exchange: HttpExchange): { id: string; name: string; ownerId: string } => {
    const app = ctx.resourceCore.get('app', exchange.params['id']!)
    if (!app) throw new Error(`应用不存在：${exchange.params['id']}`)
    return { id: app.id, name: app.name, ownerId: app.ownerId }
  }

  guarded('POST', '/api/apps/:id/sso-client', 'app.write', (exchange) => {
    const input = body<{ redirectUris: string[]; clientType?: 'confidential' | 'public'; consentRequired?: boolean; postLogoutUris?: string[]; description?: string }>(exchange)
    if (!appSsoGuard(exchange, 'create', { redirectUris: input.redirectUris, postLogoutUris: input.postLogoutUris })) return
    const app = ssoApp(exchange)
    const created = ctx.appRegistry.createSsoClient(app.id, input)
    changeLog(exchange, 'app.sso.create', 'oidc_client', created.client.id, created.client.name, `应用 ${app.name} 签发（${input.clientType ?? 'confidential'}）`)
    return {
      clientId: created.client.clientId,
      clientSecret: created.clientSecret,
      redirectUris: created.client.redirectUris,
      note: created.client.clientType === 'public' ? 'public 客户端无 secret（强制 PKCE、不发 refresh）' : 'clientSecret 仅此一次返回',
    }
  })

  guarded('PATCH', '/api/apps/:id/sso-client', 'app.write', (exchange) => {
    const input = body<{ redirectUris?: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[] }>(exchange)
    if (!appSsoGuard(exchange, 'update', { redirectUris: input.redirectUris, postLogoutUris: input.postLogoutUris })) return
    const app = ssoApp(exchange)
    const updated = ctx.appRegistry.updateSsoClient(app.id, input)
    changeLog(exchange, 'app.sso.update', 'oidc_client', updated.id, updated.name)
    return updated
  })

  guarded('POST', '/api/apps/:id/sso-client/rotate', 'app.write', (exchange) => {
    if (!appSsoGuard(exchange, 'rotate')) return
    const app = ssoApp(exchange)
    const rotated = ctx.appRegistry.rotateSsoSecret(app.id)
    changeLog(exchange, 'app.sso.rotate', 'oidc_client', rotated.client.id, rotated.client.name, '旧 secret 立即失效')
    return { clientId: rotated.client.clientId, clientSecret: rotated.clientSecret, note: '新 clientSecret 仅此一次返回，旧值立即失效' }
  })

  for (const action of ['disable', 'enable'] as const) {
    guarded('POST', `/api/apps/:id/sso-client/${action}`, 'app.write', (exchange) => {
      if (!appSsoGuard(exchange, action)) return
      const app = ssoApp(exchange)
      const { reason } = body<{ reason?: string }>(exchange)
      const client = action === 'disable'
        ? ctx.appRegistry.disableSsoClient(app.id, reason ?? `owner 手动禁用`)
        : ctx.appRegistry.enableSsoClient(app.id)
      changeLog(exchange, `app.sso.${action}`, 'oidc_client', client.id, client.name, reason ?? '')
      return client
    })
  }

  // -- Audit / 审批 / 告警 --------------------------------------------------
  guarded('GET', '/api/audit/logs', 'audit.read', (exchange) => {
    return ctx.audit.query({
      type: (exchange.query.get('type') ?? undefined) as never,
      actorId: exchange.query.get('actorId') ?? undefined,
      resourceType: exchange.query.get('resourceType') ?? undefined,
      resourceId: exchange.query.get('resourceId') ?? undefined,
      result: exchange.query.get('result') ?? undefined,
      q: exchange.query.get('q') ?? undefined,
      since: exchange.query.get('since') ?? undefined,
      limit: Number(exchange.query.get('limit') ?? 100),
    })
  })

  guarded('GET', '/api/audit/summary', 'audit.read', () => ctx.audit.summary())

  guarded('GET', '/api/audit/alert-rules', 'audit.read', () => ({ rules: ctx.audit.alertRules().all() }))

  guarded('POST', '/api/audit/alert-rules', 'audit.rule.write', (exchange) => {
    const input = body<{ name: string; metric: string; threshold: number; windowMinutes?: number; severity?: 'critical' | 'warning' | 'info'; channels?: string[]; enabled?: boolean; description?: string }>(exchange)
    const rule = ctx.audit.createAlertRule({
      name: input.name,
      metric: input.metric,
      operator: 'gt',
      threshold: input.threshold,
      windowMinutes: input.windowMinutes ?? 10,
      severity: input.severity ?? 'warning',
      channels: input.channels ?? ['dingtalk'],
      enabled: input.enabled ?? true,
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
    changeLog(exchange, 'audit.rule.create', 'alert_rule', rule.id, rule.name)
    return rule
  })

  guarded('PATCH', '/api/audit/alert-rules/:id', 'audit.rule.write', (exchange) => {
    const input = body<{ enabled?: boolean; threshold?: number; severity?: string; channels?: string[] }>(exchange)
    const rule = ctx.audit.alertRules().update(exchange.params['id']!, input as never)
    changeLog(exchange, 'audit.rule.update', 'alert_rule', rule.id, rule.name)
    return rule
  })

  guarded('GET', '/api/audit/alerts', 'audit.read', (exchange) => ({
    alerts: ctx.audit.alerts().find((item) => (exchange.query.get('unread') === '1' ? !item.read : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }))

  guarded('POST', '/api/audit/alerts/:id/read', 'audit.read', (exchange) => {
    ctx.audit.markAlertRead(exchange.params['id']!)
    return { read: true }
  })

  guarded('POST', '/api/audit/alerts/read-all', 'audit.read', (exchange) => {
    const read = ctx.audit.markAllAlertsRead()
    changeLog(exchange, 'audit.alert.readAll', 'alert', 'all', '', `一键全部已读（${read} 条）`)
    return { read, unread: 0 }
  })

  guarded('GET', '/api/audit/cost', 'audit.read', (exchange) => {
    // QA B-04：days 参数此前被静默丢弃（「近 14 天」实为全量聚合）——未显式给 from 时按 days 折算窗口起点
    const from = exchange.query.get('from') ?? undefined
    const to = exchange.query.get('to') ?? undefined
    const daysParam = Number(exchange.query.get('days') ?? 0)
    const days = Number.isInteger(daysParam) && daysParam > 0 ? Math.min(daysParam, 365) : 0
    const effectiveFrom = from ?? (days > 0
      ? new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
      : undefined)
    return {
      groupBy: exchange.query.get('groupBy') ?? 'app',
      ...(days > 0 && !from ? { days } : {}),
      rows: ctx.audit.costReport((exchange.query.get('groupBy') ?? 'app') as 'app' | 'agent' | 'org' | 'date', effectiveFrom, to),
    }
  })

  // -- 证据锚点与场景时间线（IAW 交接 5-1/5-2） ---------------------------------
  // 面板消费面：结论级证据登记/反查 + 场景维度审计时间线（panel.read/write；治理面全量审计仍走 audit.read）。
  guarded('POST', '/api/audit/evidence', 'panel.write', (exchange) => {
    const input = body<{ anchors: Array<{ kind: string; id: string; name?: string; timeWindow?: { from: string; to: string }; hitRows?: number; qualityScore?: number }>; sceneCode?: string; messageId?: string; sessionId?: string; subject?: string; note?: string }>(exchange)
    const record = ctx.audit.recordEvidence({
      anchors: input.anchors ?? [],
      ...(input.sceneCode ? { sceneCode: input.sceneCode } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.note ? { note: input.note } : {}),
    })
    changeLog(exchange, 'audit.evidence.record', 'evidence', record.id, input.anchors?.map((anchor) => anchor.id).join(',') ?? '', `${input.anchors?.length ?? 0} 个锚点${input.messageId ? `，绑定消息 ${input.messageId}` : ''}`)
    return record
  })

  guarded('GET', '/api/audit/evidence/:id', 'panel.read', (exchange) => {
    const record = ctx.audit.getEvidence(exchange.params['id']!)
    if (!record) {
      exchange.fail(404, 'NOT_FOUND', `证据登记不存在：${exchange.params['id']}`)
      return
    }
    return record
  })

  guarded('GET', '/api/audit/timeline', 'panel.read', (exchange) => {
    return ctx.audit.timeline({
      ...(exchange.query.get('sceneCode') ? { sceneCode: exchange.query.get('sceneCode')! } : {}),
      ...(exchange.query.get('since') ? { since: exchange.query.get('since')! } : {}),
      ...(exchange.query.get('limit') ? { limit: Number(exchange.query.get('limit')) } : {}),
    })
  })

  // -- 租户（多租户最小集，v1.2 第 2 步） ------------------------------------
  guarded('GET', '/api/iam/tenants', 'iam.org.read', () => ({
    tenants: ctx.iam.tenants().all(),
  }))

  guarded('POST', '/api/iam/tenants', 'iam.org.write', (exchange) => {
    const input = body<{ name: string; plan?: 'trial' | 'standard' | 'enterprise' }>(exchange)
    const tenant = ctx.iam.createTenant(input)
    changeLog(exchange, 'iam.tenant.create', 'tenant', tenant.id, tenant.name)
    return tenant
  })

  // -- 计量（usage 管道，v1.2 第 2 步） --------------------------------------
  guarded('GET', '/api/usage/events', 'usage.read', (exchange) => {
    return ctx.usage.query({
      ...(exchange.query.get('tenant_id') ? { tenant_id: exchange.query.get('tenant_id')! } : {}),
      ...(exchange.query.get('principal') ? { principal: exchange.query.get('principal')! } : {}),
      ...(exchange.query.get('resource') ? { resource: exchange.query.get('resource')! } : {}),
      ...(exchange.query.get('from') ? { from: exchange.query.get('from')! } : {}),
      ...(exchange.query.get('to') ? { to: exchange.query.get('to')! } : {}),
      ...(exchange.query.get('limit') ? { limit: Number(exchange.query.get('limit')) } : {}),
    })
  })

  guarded('GET', '/api/usage/totals', 'usage.read', (exchange) => {
    return ctx.usage.totals({
      ...(exchange.query.get('tenant_id') ? { tenant_id: exchange.query.get('tenant_id')! } : {}),
      ...(exchange.query.get('principal') ? { principal: exchange.query.get('principal')! } : {}),
      // REL-08：resource 过滤此前被路由静默丢弃（服务层 totals() 已支持）——?resource=<不存在键> 返回全库数字
      ...(exchange.query.get('resource') ? { resource: exchange.query.get('resource')! } : {}),
      ...(exchange.query.get('from') ? { from: exchange.query.get('from')! } : {}),
    })
  })

  guarded('POST', '/api/usage/record', 'usage.write', (exchange) => {
    const input = body<{ org: string; subject: string; principal: string; resource: string; meters: Array<{ key: string; value: number; unit: string }>; tenant_id?: string; trace_id?: string; idempotency_key?: string }>(exchange)
    const event = ctx.usage.record(input)
    changeLog(exchange, 'usage.record', 'usage_event', event.event_id, event.resource, `${event.meters.map((meter) => `${meter.key}=${meter.value}`).join(',')} charge=${event.pricing.charge_cents}分`)
    return event
  })

  // -- 全员工作台 / 效果回传（WP-04/A3 + WP-07/D1） ---------------------------------

  /** 资产引用 → 展示名（agent/app/nas 走资源注册表，mcp/skill 走各自注册表；id 或 slug 命中均可）。 */
  const usageAssetName = (resource: string): string => {
    const colon = resource.indexOf(':')
    const type = resource.slice(0, colon)
    const id = resource.slice(colon + 1)
    const matches = (item: { id?: string; slug?: string; name?: string }): boolean => item.id === id || item.slug === id
    try {
      if (type === 'agent' || type === 'app' || type === 'nas') return ctx.resourceCore.list(type).find(matches)?.name ?? id
      if (type === 'mcp') return ctx.mcpRegistry.services().all().find(matches)?.name ?? id
      if (type === 'skill') return ctx.skillHub.skills().all().find(matches)?.name ?? id
    } catch { /* 注册表缺失时回落裸标识 */ }
    return id
  }

  /**
   * 最近调用（WP-04/A3 全员工作台）：当前登录人自身的计量事件 ≤5，只读自见（不做跨人透视）。
   * 管理口径仍走 /api/usage/events（usage.read）。
   */
  guarded('GET', '/api/usage/recent', 'console.login', (exchange) => {
    const info = caller(exchange)
    if (!info.userId) return { items: [] }
    const limit = Math.min(Number(exchange.query.get('limit') ?? 5) || 5, 20)
    const subject = `user:${info.userId}`
    const items = ctx.usage.query({ limit: 200 }).items
      .filter((event) => event.subject === subject)
      .slice(0, limit)
      .map((event) => ({
        event_id: event.event_id,
        occurred_at: event.occurred_at,
        resource: event.resource,
        name: usageAssetName(event.resource),
        meters: event.meters,
        charge_cents: event.pricing.charge_cents,
        nonbillable: event.pricing.rate?.nonbillable === true,
      }))
    return { items }
  })

  /**
   * 反馈回传（WP-07/D1）：👍/👎 薄端点 —— 落零价快照 usage 事件（D2：charge=0 + nonbillable，
   * 不污染计量口径）。主体经 X-On-Behalf-User 归因（Agent 代用户回传），缺省取登录人；
   * 幂等键=主体+资源+消息+评分，同键重放不重复计数。
   */
  guarded('POST', '/api/usage/feedback', 'console.login', (exchange) => {
    const info = caller(exchange)
    const input = body<{ resource: string; messageId?: string; score: 'up' | 'down'; note?: string }>(exchange)
    if (!input.resource?.trim() || (input.score !== 'up' && input.score !== 'down')) {
      exchange.fail(400, 'BAD_REQUEST', 'resource 与 score（up/down）必填')
      return
    }
    const onBehalf = String(exchange.headers['x-on-behalf-user'] ?? '').trim()
    const subject = onBehalf ? `user:${onBehalf}` : (info.userId ? `user:${info.userId}` : '')
    if (!subject) {
      exchange.fail(403, 'FORBIDDEN', '机器主体回传反馈须携带 X-On-Behalf-User 归因到人')
      return
    }
    const orgId = (info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined) ?? ''
    const event = ctx.usage.record(nonbillableUsage({
      org: orgId,
      subject,
      principal: orgId ? `org:${orgId}` : 'platform',
      resource: input.resource,
      idempotency_key: `feedback:${subject}:${input.resource}:${input.messageId ?? 'anon'}:${input.score}`,
    }))
    changeLog(exchange, 'usage.feedback', 'usage_event', event.event_id, input.resource,
      `${input.score}${input.note ? `：${input.note}` : ''}（非计费零价快照，X-On-Behalf-User${onBehalf ? `=${onBehalf}` : '未用'}）`)
    return { event_id: event.event_id, charge_cents: event.pricing.charge_cents, nonbillable: event.pricing.rate?.nonbillable === true }
  })

  guarded('GET', '/api/usage/price-book', 'usage.admin', () => ({
    entries: ctx.usage.priceBook().all(),
  }))

  guarded('PUT', '/api/usage/price-book', 'usage.admin', (exchange) => {
    const input = body<{ pattern: string; meter_key: string; list_cents_per_unit: number; cost_cents_per_unit: number; units_per_step: number; tax_rate?: number; currency?: string; rate_version?: string }>(exchange)
    const entry = ctx.usage.upsertPrice({ tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08', ...input })
    changeLog(exchange, 'usage.price.upsert', 'price_entry', entry.id, entry.pattern)
    return entry
  })

  guarded('POST', '/api/usage/reconcile', 'usage.admin', (exchange) => {
    const since = exchange.query.get('from') ?? undefined
    const reconciliation = ctx.usage.reconcile(since)
    const drift = ctx.usage.capabilityDrift(since)
    changeLog(exchange, 'usage.reconcile', 'usage', 'reconcile', '', `mismatch=${reconciliation.mismatch} drift=${drift.drift.length}`)
    return { reconciliation, drift }
  })

  guarded('GET', '/api/usage/dead-letters', 'usage.admin', () => ({
    items: ctx.usage.deadLetters().all(),
  }))

  guarded('POST', '/api/usage/replay', 'usage.admin', (exchange) => {
    const { from } = body<{ from: string }>(exchange)
    return ctx.usage.replay(from)
  })

  guarded('POST', '/api/usage/dead-letters/retry', 'usage.admin', (exchange) => {
    const result = ctx.usage.retryDeadLetters()
    changeLog(exchange, 'usage.deadletter.retry', 'usage', 'dead-letters', '', `重投 ${result.retried} 条，剩余 ${result.remaining} 条`)
    return result
  })

  // -- 总线死信（QA C-03）：对齐 usage 死信面——运维不再翻 jsonl -------------------
  guarded('GET', '/api/bus/dead-letters', 'usage.admin', () => ({
    deadLetters: ctx.platformBus.deadLetters(),
  }))

  guarded('POST', '/api/bus/dead-letters/retry', 'usage.admin', (exchange) => {
    const result = ctx.platformBus.retryDeadLetters()
    changeLog(exchange, 'bus.deadletter.retry', 'bus', 'dead-letters', '', `尝试 ${result.attempted} 条，重投 ${result.redelivered} 条，保留 ${result.retained} 条`)
    return result
  })

  // 保留策略手动巡检（缺省按 USAGE_RETENTION_DAYS 配置的窗口；body.days 允许管理员临时以更短窗口清理，
  // 0=本次跳过）。日常清理由 usage 服务内建定时巡检承担，此端点是运维的手动对账口。
  guarded('POST', '/api/usage/retention/purge', 'usage.admin', (exchange) => {
    const input = body<{ days?: number }>(exchange)
    const days = typeof input.days === 'number' && Number.isFinite(input.days) && input.days >= 0 ? Math.floor(input.days) : undefined
    const result = ctx.usage.purgeExpired(days)
    changeLog(exchange, 'usage.retention.purge', 'usage', 'retention', '', `days=${days ?? 'default'} 事件=${result.purgedEvents} 水位=${result.purgedWatermarks} 死信=${result.purgedDeadLetters}`)
    return { ...result, retentionDays: ctx.usage.retentionDays }
  })

  guarded('PUT', '/api/usage/capability-grants', 'usage.admin', (exchange) => {
    const input = body<{ principal: string; capabilities: string[]; source?: string }>(exchange)
    return ctx.usage.grantCapabilities(input.principal, input.capabilities, input.source ?? 'console')
  })

  // -- 成本摘要与反馈聚合（IAW 交接 4-1/4-2，面板度量驾驶舱数据源） ----------------
  // 权限分层：panel.read 可查，但非 usage.read 主体强制收敛到自身组织（scope=self-org）。
  // 窗口边界为 UTC 日界（与 usage byDay/costReport 口径一致）。
  const usageWindowBounds = (window: string): { from: string; to: string } => {
    const now = new Date()
    const to = now.toISOString()
    if (window === 'month') return { from: `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`, to }
    return { from: `${now.toISOString().slice(0, 10)}T00:00:00.000Z`, to }
  }

  guarded('GET', '/api/usage/summary', 'panel.read', (exchange) => {
    const info = caller(exchange)
    const canCrossOrg = info.permissions.includes('*') || info.permissions.includes('usage.read')
    const window = exchange.query.get('window') === 'month' ? 'month' : 'today'
    const { from, to } = usageWindowBounds(window)
    let org = exchange.query.get('org') ?? undefined
    let subject = exchange.query.get('subject') ?? undefined
    if (!canCrossOrg) {
      const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
      org = user?.orgId ?? '__no_org__' // 组织解析失败 → 空聚合（fail-closed，不透穿全平台成本）
      subject = undefined
    }
    const summary = ctx.usage.summary({ from, to, ...(org ? { org } : {}), ...(subject ? { subject } : {}) })
    // 预算进度（1-4 联动）：modelgw 预算在位时随摘要返回，缺席=无预算配置
    let budget: unknown = null
    try {
      budget = (ctx.modelGateway as unknown as { budgetStatusFor?: (org: string) => unknown } | undefined)?.budgetStatusFor?.(org ?? '') ?? null
    } catch { /* 预算面缺席不阻塞摘要 */ }
    return { window, scope: canCrossOrg ? 'platform' : 'self-org', ...(org ? { org } : {}), ...(subject ? { subject } : {}), budget, ...summary }
  })

  guarded('GET', '/api/usage/feedback-stats', 'panel.read', (exchange) => {
    const info = caller(exchange)
    const canCrossOrg = info.permissions.includes('*') || info.permissions.includes('usage.read')
    const daysParam = Number(exchange.query.get('days') ?? 30)
    const days = exchange.query.get('days') === 'all' ? 0 : Math.min(Math.max(Number.isFinite(daysParam) ? daysParam : 30, 1), 365)
    const from = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined
    let org = exchange.query.get('org') ?? undefined
    if (!canCrossOrg) {
      const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
      org = user?.orgId ?? '__no_org__'
    }
    const stats = ctx.usage.feedbackStats({ ...(from ? { from } : {}), ...(org ? { org } : {}) })
    return { windowDays: days, scope: canCrossOrg ? 'platform' : 'self-org', ...(org ? { org } : {}), ...stats }
  })

  // -- 模型渠道治理（IAW 交接 1-2/1-3/1-4：渠道组/遥测/预算，modelgw 域面） --------
  guarded('GET', '/api/modelgw/channel-groups', 'panel.read', () => ({
    groups: ctx.modelGateway.channelGroups().all().map((group) => ({
      ...group,
      chain: [group.primary, group.backup1, group.backup2].filter(Boolean),
      stepTimeoutMs: group.stepTimeoutMs ?? 8000,
    })),
  }))

  guarded('PUT', '/api/modelgw/channel-groups', 'panel.config.write', (exchange) => {
    const input = body<{ slug: string; name: string; primary: string; backup1?: string; backup2?: string; manual?: boolean; stepTimeoutMs?: number; enabled?: boolean }>(exchange)
    if (!input.slug?.trim() || !input.primary?.trim() || !input.name?.trim()) {
      exchange.fail(400, 'BAD_REQUEST', 'slug/name/primary 必填')
      return
    }
    if (input.stepTimeoutMs !== undefined && (input.stepTimeoutMs < 500 || input.stepTimeoutMs > 60_000)) {
      exchange.fail(400, 'BAD_REQUEST', 'stepTimeoutMs 应在 500-60000ms 之间（PRD §4.1 口径 8000）')
      return
    }
    const group = ctx.modelGateway.upsertChannelGroup({
      slug: input.slug.trim(), name: input.name.trim(), primary: input.primary.trim(),
      ...(input.backup1 ? { backup1: input.backup1.trim() } : {}),
      ...(input.backup2 ? { backup2: input.backup2.trim() } : {}),
      ...(input.manual !== undefined ? { manual: input.manual } : {}),
      ...(input.stepTimeoutMs !== undefined ? { stepTimeoutMs: input.stepTimeoutMs } : {}),
      enabled: input.enabled ?? true,
    })
    changeLog(exchange, 'modelgw.channel_group.upsert', 'modelgw_channel_group', group.id, group.name)
    return group
  })

  /**
   * 降级链调用入口（IAW 交接 1-2）：按渠道组 主→备1→备2 逐级尝试，每步 stepTimeoutMs 超时；
   * 每次降级发 modelgw.degraded（面板 SSE 提示条消费）。全链失败且组配 manual=true →
   * 200 + ok:false + escalated:true（转人工），不造假回复。
   */
  guarded('POST', '/api/modelgw/channel-groups/:slug/invoke', 'panel.write', async (exchange) => {
    const input = body<{ messages?: Array<{ role: string; content: string }>; prompt?: string; dataClass?: string; maxTokens?: number }>(exchange)
    const messages = input.messages ?? (input.prompt ? [{ role: 'user', content: input.prompt }] : [])
    if (messages.length === 0) {
      exchange.fail(400, 'BAD_REQUEST', 'messages（或 prompt）必填')
      return
    }
    const info = caller(exchange)
    const orgId = (info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined)
      ?? ctx.iam.orgs().find((org) => org.parentId === null).at(0)?.id ?? ''
    const dataClass = input.dataClass === 'public' || input.dataClass === 'internal' || input.dataClass === 'secret' ? input.dataClass : undefined
    const result = await ctx.modelGateway.invokeWithFallback({
      group: exchange.params['slug']!,
      orgId,
      subject: info.userId ? `user:${info.userId}` : `machine:${info.principalId}`,
      messages,
      ...(dataClass ? { dataClass } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    })
    return result
  })

  guarded('GET', '/api/modelgw/:slug/telemetry', 'panel.read', (exchange) => {
    const slug = exchange.params['slug']!
    if (!ctx.modelGateway.models().findOne((item) => item.slug === slug)) {
      exchange.fail(404, 'NOT_FOUND', `模型不存在：${slug}`)
      return
    }
    const windowDays = Math.min(Math.max(Number(exchange.query.get('window')?.replace(/d$/, '') ?? 7) || 7, 1), 30)
    return ctx.modelGateway.telemetryFor(slug, windowDays)
  })

  guarded('GET', '/api/modelgw/budgets', 'panel.read', (exchange) => ({
    budgets: ctx.modelGateway.budgets().all()
      .filter((budget) => (exchange.query.get('org') ? (budget.orgId ?? '') === exchange.query.get('org') : true)),
  }))

  guarded('PUT', '/api/modelgw/budgets', 'panel.config.write', (exchange) => {
    const input = body<{ orgId?: string; modelSlug?: string; dailyLimitCents?: number; monthlyLimitCents?: number; warnRatio?: number; action?: 'warn' | 'block'; enabled?: boolean }>(exchange)
    for (const [key, value] of [['dailyLimitCents', input.dailyLimitCents], ['monthlyLimitCents', input.monthlyLimitCents]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        exchange.fail(400, 'BAD_REQUEST', `${key} 应为非负数（分）`)
        return
      }
    }
    const budget = ctx.modelGateway.upsertBudget({
      ...(input.orgId ? { orgId: input.orgId } : {}),
      ...(input.modelSlug ? { modelSlug: input.modelSlug } : {}),
      ...(input.dailyLimitCents !== undefined ? { dailyLimitCents: input.dailyLimitCents } : {}),
      ...(input.monthlyLimitCents !== undefined ? { monthlyLimitCents: input.monthlyLimitCents } : {}),
      warnRatio: input.warnRatio ?? 0.8,
      action: input.action ?? 'warn',
      enabled: input.enabled ?? true,
    })
    changeLog(exchange, 'modelgw.budget.upsert', 'modelgw_budget', budget.id, budget.orgId ?? '（平台级）')
    return budget
  })

  // -- 第三方插件市场（v1.2）：已迁移 routes/market.ts（OPT-P1-01 首段） ------
  registerMarketRoutes(ctx, { http, guarded, body, changeLog, caller })

  // -- FinOps CFO 视图（M2）：routes/finops.ts（新模式：新路由不再进 apply()） ------
  registerFinOpsRoutes(ctx, { guarded })

  // -- 平台级路由（M2 筑基）：routes/platform.ts（首启 bootstrap 状态） ------
  registerPlatformRoutes(ctx, { http })

  // -- 用量透明月度报表（M0-3；J4 契约：docs/contract-j4-usage-report.md） ----------------
  // 部门/Agent/Skill 三维 tokens 聚合 + 零价快照口径；format=csv 自助导出（Excel 友好 BOM）。
  guarded('GET', '/api/usage/report/monthly', 'usage.read', (exchange) => {
    const monthParam = exchange.query.get('month') ?? undefined
    const report = ctx.usage.monthlyReport(monthParam)
    if ((exchange.query.get('format') ?? '') !== 'csv') return report
    const esc = (value: string | number) => {
      const text = String(value)
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
    }
    const header = '维度,维度值,事件数,tokens,charge_cents(零价快照恒0),cost_cents(内部成本参考),nonbillable事件数'
    const lines = [header]
    const pushRows = (name: string, rows: Array<{ dimension: string; events: number; tokens: number; charge_cents: number; cost_cents: number; nonbillable_events: number }>) => {
      for (const row of rows) lines.push([name, esc(row.dimension), row.events, row.tokens, row.charge_cents, row.cost_cents, row.nonbillable_events].join(','))
    }
    pushRows('total', [report.totals])
    pushRows('org', report.byOrg)
    pushRows('agent', report.byAgent)
    pushRows('skill', report.bySkill)
    pushRows('model', report.byModel)
    // 直接写原始响应（guarded 包装器对返回值做 JSON 序列化，流式文件下载须绕开）
    exchange.res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="usage-report-${report.month}.csv"`,
    })
    exchange.res.end('\ufeff' + lines.join('\r\n') + '\r\n')
    return undefined
  })

  // -- 模型网关（M0-3：统一模型接入 + 用量透明计量） ---------------------------
  guarded('GET', '/api/modelgw/models', 'modelgw.read', () => ({
    models: ctx.modelGateway.models().all().map((item) => ({ ...item, apiKey: item.apiKey.startsWith('env:') ? item.apiKey : '***' })),
  }))

  guarded('POST', '/api/modelgw/models', 'modelgw.admin', (exchange) => {
    const input = body<{ slug: string; displayName?: string; provider?: string; endpoint: string; apiKey?: string; costCentsPerKTokens?: number; status?: 'online' | 'offline'; dataClassLimit?: 'public' | 'internal' | 'secret' }>(exchange)
    const model = ctx.modelGateway.upsertModel({
      slug: input.slug,
      displayName: input.displayName ?? input.slug,
      provider: input.provider ?? 'external',
      endpoint: input.endpoint,
      apiKey: input.apiKey ?? 'env:MODEL_API_KEY',
      costCentsPerKTokens: input.costCentsPerKTokens ?? 0,
      status: input.status ?? 'online',
      ...(input.dataClassLimit !== undefined ? { dataClassLimit: input.dataClassLimit } : {}),
    })
    changeLog(exchange, 'modelgw.model.upsert', 'model', model.id, model.slug, `分级上限=${model.dataClassLimit ?? 'internal'}`)
    return model
  })

  /** 删除模型：从模型目录移除登记；计量与审计数据保留。 */
  guarded('DELETE', '/api/modelgw/models/:id', 'modelgw.admin', (exchange) => {
    const id = exchange.params['id']!
    const model = ctx.modelGateway.models().get(id)
    if (!model) throw new Error(`模型不存在：${id}`)
    ctx.modelGateway.models().remove(id)
    changeLog(exchange, 'modelgw.delete', 'model', id, model.slug)
    return { deleted: true }
  })

  guarded('POST', '/api/modelgw/invoke', 'modelgw.invoke', async (exchange) => {
    const info = caller(exchange)
    const input = body<{ model: string; messages: Array<{ role: string; content: string }>; orgId?: string; maxTokens?: number; temperature?: number; dataClass?: 'public' | 'internal' | 'secret' }>(exchange)
    // 默认用量归口组织：调用者所属组织（人）或凭证组织（机器）
    const orgId = input.orgId
      ?? (info.kind === 'human' && info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined)
    if (!orgId) throw new Error('未指定用量归口组织（orgId），且调用者无可归属组织')
    // 计量主体：human=user:<id>；machine 凭证关联 Agent 时=agent:<refId>（usage.recorded 回灌 Agent 台账的依据），其余机器=app:<principalId>
    const subject = info.kind === 'human'
      ? `user:${info.userId ?? info.principalId}`
      : (info.refType === 'agent' && info.refId ? `agent:${info.refId}` : `app:${info.principalId}`)
    return await ctx.modelGateway.invoke({
      model: input.model,
      messages: input.messages,
      orgId,
      subject,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.dataClass !== undefined ? { dataClass: input.dataClass } : {}),
    })
  })

  guarded('GET', '/api/approvals', 'approval.read', () => ({
    approvals: ctx.audit.approvals().all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }))

  guarded('POST', '/api/approvals/:id/decide', 'approval.decide', async (exchange) => {
    const { decision, opinion, confirmed, finalReview } = body<{ decision: 'approve' | 'reject'; opinion?: string; confirmed?: boolean; finalReview?: boolean }>(exchange)
    const info = caller(exchange)
    const record = await ctx.audit.decideApproval(exchange.params['id']!, decision, info.userId ?? info.principalId, info.name, opinion, { confirmed, finalReview })
    return record
  })

  /** 删除审批单：仅「已驳回」单可删（Skill/Agent/应用等各资产驳回单统一走此口清理）；审计数据保留。 */
  guarded('DELETE', '/api/approvals/:id', 'approval.decide', (exchange) => {
    const id = exchange.params['id']!
    const record = ctx.audit.approvals().get(id)
    if (!record) throw new Error(`审批单不存在：${id}`)
    ctx.audit.deleteApproval(id)
    changeLog(exchange, 'approval.delete', 'approval', id, record.title, `清理驳回审批单（kind=${record.kind}）`)
    return { deleted: true }
  })

  /** 审批 SLA 看板（WP-10）：≤2 工作日达成率可查（L2 审批周期指标口径）。 */
  guarded('GET', '/api/approvals/sla', 'approval.read', (exchange) => {
    const windowDays = Number(exchange.query.get('windowDays') ?? 30) || 30
    return ctx.audit.slaReport(Math.min(Math.max(windowDays, 1), 365))
  })

  // -- 平台信息与工具桥 -----------------------------------------------------
  /** 路由×权限矩阵（WP-04/A1 + 交接清单 H5）：RBAC 断言网的服务端事实源。
   *  guarded=register 声明自动汇入的权限点保护端点；public=免鉴权白名单（selfValidated=处理器自带凭证
   *  校验，断言网对其实施匿名探针必须被拒）；authenticated=仅中间件 Bearer、无独立权限点；
   *  /api/* 缺声明在 register 期即抛错，undeclaredApi 恒空——自注册端点不再可能逃出断言网。 */
  guarded('GET', '/api/platform/route-matrix', 'audit.read', () => {
    const apiDeclared = http.declaredRoutes.filter((route) => route.path === '/api' || route.path.startsWith('/api/'))
    const publicEntries = apiDeclared.flatMap((route) => route.auth.access === 'public'
      ? [{ method: route.method, path: route.path, selfValidated: route.auth.selfValidated === true }]
      : [])
    const authenticated = apiDeclared.flatMap((route) => route.auth.access === 'authenticated' ? [{ method: route.method, path: route.path }] : [])
    return {
      guarded: http.routeMatrix.map((route) => ({ ...route })),
      public: publicEntries.map((route) => route.path),
      publicEntries,
      authenticated,
      counts: {
        declaredApi: apiDeclared.length,
        guarded: http.routeMatrix.length,
        public: publicEntries.length,
        authenticated: authenticated.length,
        undeclaredApi: apiDeclared.filter((route) => route.auth.access === 'outside-api').length,
      },
      note: 'guarded=权限点保护端点；public=免鉴权（selfValidated=自带凭证校验）；authenticated=仅 Bearer；变动须经评审',
    }
  })

  guarded('GET', '/api/platform/info', 'console.login', () => {
    const versionInfo = platformVersionInfo()
    const plugins = [
      'platform-core', 'resource-core', 'iam', 'authn', 'usage', 'audit', 'market', 'modelgw', 'mcp', 'nas', 'skillhub', 'agent', 'app', 'connect', 'update', 'console', 'panel-core', 'dingtalk-bridge',
    ]
    return {
      name: '元冰可|企业AI资源管理平台',
      version: versionInfo.version,
      installMode: versionInfo.installMode,
      runtime: 'standalone-cordis（dsh 插件兼容）',
      plugins,
      collections: ctx.opsStorage.names(),
      tools: ctx.tools.schemas(),
      resourceTypes: ctx.resourceCore.typesSpecs().map((spec) => ({ type: spec.type, label: spec.label, plugin: spec.plugin })),
      events: ctx.platformBus.recent(10),
    }
  })

  /**
   * MCP 网关调用方身份解析：权限组 subjects 以 agent/app 资源 ID 授权，
   * 机器令牌需经 principal 的 refType/refId 反查归属资源，否则 agent 主体永远命中不了。
   */
  const resolveMcpCaller = (info: CallerInfo): { type: 'user' | 'agent' | 'app'; id: string; name: string } => {
    if (info.kind === 'human') return { type: 'user', id: info.userId ?? info.principalId, name: info.name }
    const principal = ctx.authn.principals().get(info.principalId)
    if (principal?.refType === 'agent' && principal.refId) return { type: 'agent', id: principal.refId, name: info.name }
    if (principal?.refType === 'app' && principal.refId) return { type: 'app', id: principal.refId, name: info.name }
    return { type: 'app', id: info.principalId, name: info.name }
  }

  /**
   * 工具身份注入：服务端以令牌解析的调用者身份为准，禁止调用方自填身份参数。
   * connector_execute / mcp_invoke 的调用方身份已改为经 exec.principal 传递（schema 无 caller* 参数），
   * 不再走 args 注入；其余工具的 approver/requester/actor 仍由此处覆盖。
   */
  const injectToolIdentity = (name: string, inputArgs: Record<string, unknown>, info: CallerInfo): Record<string, unknown> => {
    const args = { ...inputArgs }
    const principalId = info.userId ?? info.principalId
    if (name === 'approval_decide' || name === 'skill_approve') {
      args.approverId = principalId
      args.approverName = info.name
    } else if (name === 'agent_offline' || name === 'mcp_offline' || name === 'iam_sync_run') {
      args.requesterId = principalId
      args.requesterName = info.name
      args.actor = info.name
    } else if (name === 'agent_bind_user' || name === 'skill_install' || name === 'skill_publish') {
      args.actor = info.name
    }
    // nas_fs_* 工具身份已改为经 exec.principal 传递（P0-2：身份不进工具参数，schema 无 actor* 参数）
    return args
  }

  guarded('GET', '/api/tools/schemas', 'console.login', () => ({
    tools: ctx.tools.schemas().map((tool) => ({ name: tool.name, description: tool.description, permission: tool.permission, parameters: tool.parameters })),
  }))

  guarded('POST', '/api/tools/execute', 'console.login', async (exchange) => {
    const input = body<{ name: string; args?: Record<string, unknown> }>(exchange)
    if (!input.name) throw new Error('工具名必填')
    const info = caller(exchange)
    // 工具级权限校验：以工具声明的最小权限点为准，缺省仅要求登录
    const definition = ctx.tools.schemas().find((tool) => tool.name === input.name)
    const required = definition?.permission
    if (required && !info.permissions.includes('*') && !info.permissions.includes(required)) {
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info.userId ?? info.principalId,
        actorName: info.name,
        point: required,
        path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', `缺少权限点 ${required}，请联系管理员调整角色`, { permission: required })
      return
    }
    const args = injectToolIdentity(input.name, input.args ?? {}, info)
    const result = await ctx.tools.execute({ name: input.name, arguments: args, principal: info })
    return result
  })

  // -- MCP Server 端点：平台即 MCP 服务（与 REST/CLI/dsh 插件同一套工具与权限体系） ------
  //
  // Streamable HTTP（JSON-RPC 2.0 over POST /mcp）：initialize（回 mcp-session-id，无状态
  // 服务端会话仅为客户端兼容）/ notifications/*（202）/ tools/list / tools/call / ping。
  // 每请求 Bearer 鉴权（人/机器令牌皆可），工具级权限点 + 身份注入与 REST 工具桥完全一致。
  // 不提供 GET SSE 长流（纯 JSON 响应形态合规）；外部 MCP 客户端接入示例：
  //   {"mcpServers":{"dsh-ops-platform":{"url":"http://<平台>:7300/mcp","headers":{"Authorization":"Bearer <平台令牌>"}}}}
  const mcpCallerFromToken = (exchange: HttpExchange): CallerInfo | undefined => {
    const header = String(exchange.headers['authorization'] ?? '')
    if (!header.startsWith('Bearer ')) {
      exchange.res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="dsh-ops-mcp"',
      })
      exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '缺少 Bearer 令牌：/mcp 与 REST 共用同一套平台令牌' } }))
      return undefined
    }
    try {
      const verified = ctx.authn.verify(header.slice(7))
      return {
        kind: verified.principal.type,
        principalId: verified.principal.id,
        ...(verified.principal.type === 'human' && verified.principal.refId ? { userId: verified.principal.refId } : {}),
        name: verified.principal.name,
        permissions: verified.scopes,
        actChain: verified.actChain,
      } satisfies CallerInfo
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.res.writeHead(401, { 'content-type': 'application/json' })
      exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: `令牌无效：${message}` } }))
      return undefined
    }
  }

  const mcpReply = (exchange: HttpExchange, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}): void => {
    exchange.res.writeHead(200, { 'content-type': 'application/json', ...extraHeaders })
    exchange.res.end(JSON.stringify(payload))
  }

  http.register('POST', '/mcp', async (exchange) => {
    const info = mcpCallerFromToken(exchange)
    if (!info) return
    const message = exchange.body
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      exchange.res.writeHead(400, { 'content-type': 'application/json' })
      exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '请求体必须是单个 JSON-RPC 2.0 消息（暂不支持批量）' } }))
      return
    }
    const id = (message as Record<string, unknown>).id
    // 通知类消息（无 id）：确认即止
    if (id === undefined || id === null) {
      exchange.res.writeHead(202)
      exchange.res.end()
      return
    }
    const method = String((message as Record<string, unknown>).method ?? '')
    const params = ((message as Record<string, unknown>).params ?? {}) as Record<string, unknown>
    const reply = (result: unknown, extraHeaders?: Record<string, string>) => mcpReply(exchange, { jsonrpc: '2.0', id, result }, extraHeaders)
    const replyError = (code: number, text: string) => mcpReply(exchange, { jsonrpc: '2.0', id, error: { code, message: text } })
    switch (method) {
      case 'initialize':
        return reply(
          {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'dsh-ops-platform', title: '元冰可|企业AI资源管理平台 · MCP 网关', version: platformVersionInfo().version },
            instructions: '元冰可|企业AI资源管理平台（IAM/MCP/Skill/Agent/应用/NAS/用量计量/审计）。工具权限与控制台账号一致：先用 nas_list / mcp_service_list / skill_search 等盘点资产，再按需调用写类工具。',
          },
          { 'mcp-session-id': `dshmcp-${Date.now().toString(36)}` },
        )
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: ctx.tools.schemas().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
            ...(tool.permission !== undefined ? { annotations: { 'x-permission': tool.permission } } : {}),
          })),
        })
      case 'tools/call': {
        const name = String(params.name ?? '')
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
        const definition = ctx.tools.schemas().find((tool) => tool.name === name)
        if (!definition) {
          return reply({ content: [{ type: 'text', text: `未知工具：${name}` }], isError: true })
        }
        if (definition.permission && !info.permissions.includes('*') && !info.permissions.includes(definition.permission)) {
          ctx.platformBus.emit('audit.authz.denied', {
            actorId: info.userId ?? info.principalId,
            actorName: info.name,
            point: definition.permission,
            path: '/mcp',
          })
          return reply({ content: [{ type: 'text', text: `缺少权限点 ${definition.permission}（调用方 ${info.name}），调用被拒绝` }], isError: true })
        }
        const result = await ctx.tools.execute({ name, arguments: injectToolIdentity(name, args, info), principal: info })
        return reply({
          content: result.content.length > 0 ? result.content : [{ type: 'text', text: JSON.stringify(result.value ?? null) }],
          isError: result.isError,
        })
      }
      default:
        return replyError(-32601, `方法不存在：${method}`)
    }
  })

  // Streamable HTTP：本端点为无会话纯 JSON 形态，GET（SSE 长流）不支持，DELETE（会话终止）恒成功
  http.register('GET', '/mcp', (exchange) => {
    exchange.res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: '本 MCP 端点为无会话纯 JSON 形态，不支持 GET SSE 长流' } }))
  })
  http.register('DELETE', '/mcp', (exchange) => {
    exchange.ok({})
  })

  // -- 静态 SPA -----------------------------------------------------------
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
  if (existsSync(publicDir)) {
    http.serveStatic('/', publicDir, '/index.html')
  }

  // -- /docs 静态发布：仓库/安装包内 docs 目录（应用接入指南等文档随服务可直接访问） ----
  // 源码检出与 dsh plugin add 两种形态下本文件均位于 <root>/packages/plugin-console/src/，
  // docs 目录恒为 <root>/docs。公开无鉴权（与控制台 SPA 同级；内容均为已公开的仓库文档）。
  const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs')
  if (existsSync(docsDir)) {
    http.serveStatic('/docs', docsDir)
    http.register('GET', '/docs', (exchange) => {
      const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)
      const files = readdirSync(docsDir).filter((name) => name.endsWith('.md')).sort()
      const items = files.map((name) => {
      const hint = name === 'app-sso-integration.md' ? '（应用统一身份接入指南）'
        : name === 'app-org-sync.md' ? '（应用组织架构同步指南）'
        : name === 'app-rbac-guide.md' ? '（应用内权限（RBAC）构造指南）' : ''
        return `<li><a href="/docs/${encodeURIComponent(name)}">${escapeHtml(name)}</a>${hint}</li>`
      }).join('')
      exchange.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      exchange.res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>元冰可 · 平台文档</title><style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#1f2328}h1{font-size:20px}li{margin:8px 0;font-size:14px}a{color:#2563eb}</style></head><body><h1>元冰可 · 平台文档</h1><p>以下文档随本服务发布，可直接打开阅读：</p><ul>${items}</ul></body></html>`)
    })
  }

  // -- 拓扑节点名称补全（skill 等非 resource-core 类型） ----------------------
  const enrichTopology = (node: any): any => ({
    ...node,
    name: node.type === 'skill'
      ? ctx.skillHub.skills().get(node.id)?.name ?? node.name
      : node.type === 'mcp_service'
        ? ctx.mcpRegistry.services().get(node.id)?.name ?? node.name
        : node.name,
    status: node.type === 'skill'
      ? ctx.skillHub.skills().get(node.id)?.status ?? node.status
      : node.status,
    children: node.children.map(enrichTopology),
  })
  // -- 种子数据 -----------------------------------------------------------
  void seedAll(ctx)
}

function decorateUser(ctx: Context, user: any) {
  const { passwordHash, passwordSalt, ...safe } = user
  void passwordHash
  void passwordSalt
  return {
    ...safe,
    orgName: ctx.iam.orgs().get(user.orgId)?.name ?? '',
    roles: user.roleIds.map((roleId: string) => ctx.iam.roles().get(roleId)).filter(Boolean),
  }
}

const NAS_DOWNLOAD_MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword',
  '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8',
}

/** 事件摘要用字段标签（按信息量排序，命中即拼入人话摘要；未列出的内部字段不外显）。 */
const EVENT_FIELD_LABELS: Array<[string, string]> = [
  ['title', '标题'], ['name', '名称'], ['displayName', '姓名'], ['reason', '原因'], ['message', '信息'],
  ['error', '错误'], ['actorName', '操作人'], ['username', '用户名'], ['userId', '账号'], ['version', '版本'],
  ['service', '服务'], ['actionId', '动作'], ['provider', '平台'], ['alias', '连接'], ['baseUrl', '网关地址'],
  ['status', '状态'], ['result', '结果'], ['kind', '类型'],
]
/** 摘要中常见英文枚举值的中文转译（测试 UI-03：事件流不留裸英文码）。 */
const EVENT_VALUE_LABELS: Record<string, string> = {
  created: '创建', updated: '更新', deleted: '删除', approved: '通过', rejected: '驳回',
  healthy: '健康', unavailable: '不可用', ok: '成功', failed: '失败', catalog: '目录',
}

/** 事件流人话摘要（测试 UI-03）：优先取业务字段拼「标签：值」句，绝不回退裸 JSON——原始 payload 走 detail 字段收进「详情」。 */
function summarize(payload: unknown): string {
  if (payload === null || payload === undefined) return ''
  if (typeof payload !== 'object') return String(payload).slice(0, 120)
  const record = payload as Record<string, unknown>
  const bits: string[] = []
  for (const [key, label] of EVENT_FIELD_LABELS) {
    const value = record[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
    const text = String(value)
    bits.push(`${label}：${EVENT_VALUE_LABELS[text] ?? text.slice(0, 80)}`)
    if (bits.length >= 3) break
  }
  return bits.join('；')
}

/** 原始 payload 压缩串（仅用于「详情」折叠展示，防止误读也保留排查线索）。 */
function summarizeDetail(payload: unknown): string | undefined {
  if (payload === null || payload === undefined || typeof payload !== 'object') return undefined
  const json = JSON.stringify(payload)
  if (!json || json === '{}') return undefined
  return json.slice(0, 400)
}
