/**
 * @dsh-ops/plugin-dsh-bridge —— dsh 宿主桥：数据面挂载（M1）+ 平台身份绑定（M4）。
 *
 * 【挂载半】把元冰可数据面（platform-core httpServer 的全部路由/中间件/静态资源）
 * 以 URL 前缀方式挂进 dsh webServer（ctx.webServer，dsh web 进程内唯一监听器）：
 *   http://<host>:<port>/rq/*   →  剥离 /rq 前缀后交给 httpServer.dispatch
 *   http://<host>:<port>/rq     →  302 /rq/（目录形态归一，保证 SPA 相对引用可解析）
 *
 * 【身份半】dsh web 自身无认证层（fence 非 auth，见 deepseek-harness connection/README），
 * 且 /api 的 RPC 信封不向 handler 暴露 Cookie——平台身份绑定只能在自有路由上完成
 * （webServer.register 的 handler 拥有原生 req/res，可读 Cookie、可 Set-Cookie）：
 *   GET  /auth/entry?ticket=…   一次性入场票据兑换 → Set-Cookie rq_sid → 302 /
 *                               （控制台/门户「打开交互界面」的自然免登通道）
 *   POST /dsh-bridge/redeem     {ticket} 兑换（tapIndex 引导脚本承接 #entry_ticket fragment 时调用）
 *   GET  /dsh-bridge/status     读 Cookie 返回绑定身份（浏览器半插件显示登录态）
 *   POST /dsh-bridge/logout     清除绑定与 Cookie
 *   POST /dsh-bridge/bind-session {sessionId} 把 dsh 会话与绑定身份关联
 *                               （工具出站归因：exec.agent.session.id → X-On-Behalf-User）
 *
 * 绑定存储 IdentityBindingService（provide 'identityBinding'）：
 *   - byToken（rq_sid → 身份，24h TTL）：兑换时经 EntryTicketService.redeem 一次性消费、
 *     实时校验账号状态；读取时再校验账号 active（冻结/离职即时失效）。
 *   - bySession（sessionId → 身份）：由浏览器引导脚本显式绑定；未绑定时回落 `current`
 *     （最近一次绑定身份，单操作者局域网姿态）——多用户并发归因是已知限制（dev-plan §七）。
 *   - plugin-nas 出站注入：ctx.identityBinding 存在时按会话/回落解析真实用户 →
 *     X-On-Behalf-User（P0-2 红线：身份只走请求头）；独立形态无此服务，行为不变。
 *
 * 设计依据：docs/dev-plan-agent-host-unification.md §三/§五/§六。
 * dsh 侧挂载契约（deepseek-harness packages/host/webserver/src/index.ts:94-101）：
 *   WebRoute = { kind:'exact'|'prefix', path, handler(req,res) }，handler 拥有完整响应生命周期。
 * 硬约束：`/api` 前缀与全站 fallback 席位均已被 dsh 占用（重复注册 throw），
 * 元冰可数据面必须整体走独立前缀（/rq）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { HttpServerService } from '../../platform-core/src/index.ts'

/** dsh webServer 的最小结构类型（不依赖 dsh 包，仅消费 register 契约）。 */
interface DshWebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): unknown
}

export interface DshBridgeConfig {
  /** 元冰可数据面对外前缀（默认 /rq；须为以 / 开头的非根路径）。 */
  mountPath?: string
  /** 身份绑定 Cookie 名（默认 rq_sid）。 */
  cookieName?: string
  /** 绑定有效期（秒，默认 24h）。 */
  bindTtlSeconds?: number
  /**
   * Agent 关联 OIDC 客户端凭证文件（register-dsh-agent.mjs 产物，含 oidc.clientId/clientSecret）。
   * 缺省 <dataDir>/dsh-agent-credential.json；配置后启用 /auth/oidc/start 授权码登录通道。
   */
  oidcCredentialFile?: string
}

export const name = 'dsh-bridge'

/** webServer/httpServer 由 dsh web profile 与 platform-core 提供；entryTickets/oidc/authn/audit/iam 由 plugin-authn/iam/audit 装配。 */
// plan-gate01 Phase 3（2026-09-10）【受控漂移 · F 清单登记】：inject 收缩为 3 键硬依赖——
// entryTickets/oidc 由 plugin-authn 装配，iam/authn/audit 是宿主面包，01门 4-entry 装配
// （cordis.patch.yml）下均无提供者，声明即永久挂起（cordis 语义：声明+缺提供者=静默 INACTIVE，
// spike 定稿）。运行期访问本来就是防御式可选语义（entryTickets/oidc/iam 均为「形状断言 + 可选
// 读取」，缺席即诚实降级「仅挂载半生效」/ 503 AUTHN_UNAVAILABLE / audit?.record 可选调用），
// 与收缩后的声明面正好对齐；全量形态（cordis.yml 22 entry）服务全在，行为不变。
export const inject = ['webServer', 'httpServer', 'opsStorage']

/**
 * 可选服务软读（plan-gate01 Phase 3）：双形态兼容——
 *   - 真实 cordis ctx：ctx.reflect.get(key, false)（绕过 inject 检查；未声明键的属性
 *     访问会被 get trap 硬抛「without inject」，形状断言 `(ctx as {k?}).k` 防不了它）；
 *   - 服务视图对象（selftest 台架 / 轻量装配手工拼的 plain object）：无 reflect 面，
 *     直接属性读取（plain object 无 trap，缺席即 undefined）。
 * 两形态缺席一律 undefined = 桥接身份功能诚实降级。
 */
const softRead = (ctx: any, key: string): any => {
  try {
    if (typeof ctx?.reflect?.get === 'function') return ctx.reflect.get(key, false)
    return ctx?.[key]
  } catch {
    return undefined
  }
}
// 注：identityBinding 由本插件内部的 IdentityBindingService 直挂提供（不经 inject 声明，
// 避免「自提供自依赖」死锁）；iam/authn/audit 走防御式软访问（缺席 = 桥接身份功能诚实降级）。

const BIND_TOKEN_PREFIX = 'rbs_'
const DEFAULT_COOKIE = 'rq_sid'
const DEFAULT_TTL_SECONDS = 24 * 3600
const MAX_BINDINGS = 500

/** 宿主会话直通端点所需的最小服务面（form B 轻量 ctx 防御式读取）。 */
interface BridgeUserView {
  id: string
  username: string
  displayName: string
  orgId: string
  roleIds: string[]
  status?: string
}

interface BridgeSessionDeps {
  authn?: {
    ensureHumanPrincipal(userId: string, displayName: string): { id: string }
    issueSessionPair(principalId: string, options: { issuedBy: string }): { token: string; refreshToken: string; access: { expiresAt: string } }
  }
  iam?: {
    users(): { get(id: string): BridgeUserView | undefined }
    roles(): { get(id: string): { name?: string } | undefined }
    markLogin(id: string): void
    userPermissions(id: string): string[]
  }
  audit?: {
    record(entry: Record<string, unknown>): unknown
  }
}

const base64url = (input: Buffer): string => input.toString('base64url')
const originOf = (req: IncomingMessage): string => {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http')
  return `${proto}://${req.headers.host ?? 'localhost'}`
}

interface BindingRecord {
  token: string
  userId: string
  name: string
  roles: string[]
  orgId?: string
  issuedAt: number
}

/** 平台身份绑定存储（Cookie ↔ 身份、dsh 会话 ↔ 身份）。详见模块头注释。 */
export class IdentityBindingService extends Service {
  static readonly provide = 'identityBinding'

  private readonly byToken = new Map<string, BindingRecord>()
  private readonly bySession = new Map<string, string>()
  private current: BindingRecord | undefined
  private readonly ttlMs: number
  private readonly cookieName: string

  constructor(ctx: Context, config: { cookieName?: string; bindTtlSeconds?: number } = {}) {
    super(ctx, 'identityBinding')
    this.cookieName = config.cookieName ?? DEFAULT_COOKIE
    this.ttlMs = (config.bindTtlSeconds ?? DEFAULT_TTL_SECONDS) * 1000
  }

  /** 兑换票据并建立绑定：一次性消费 + 实时账号状态校验在 redeem 内完成。 */
  bindByTicket(redeem: (ticket: string) => { identity: { sub: string; name?: string; roles?: string[]; org?: { id?: string } } }, ticket: string): { token: string; identity: Record<string, unknown> } {
    const result = redeem(ticket)
    const token = BIND_TOKEN_PREFIX + randomBytes(24).toString('hex')
    const record: BindingRecord = {
      token,
      userId: result.identity.sub,
      name: result.identity.name ?? result.identity.sub,
      roles: result.identity.roles ?? [],
      orgId: result.identity.org?.id,
      issuedAt: Date.now(),
    }
    this.evictExpired()
    if (this.byToken.size >= MAX_BINDINGS) {
      const oldest = [...this.byToken.values()].sort((a, b) => a.issuedAt - b.issuedAt)[0]
      if (oldest) this.byToken.delete(oldest.token)
    }
    this.byToken.set(token, record)
    this.current = record
    return { token, identity: this.publicIdentity(record) }
  }

  /** 读 Cookie 解析绑定身份：过期/未知/账号非 active 一律视为未绑定。 */
  identityForCookie(cookieHeader: string | undefined): Record<string, unknown> | undefined {
    const token = this.readCookieToken(cookieHeader)
    if (!token) return undefined
    const record = this.byToken.get(token)
    if (!record || Date.now() - record.issuedAt > this.ttlMs) return undefined
    if (!this.isAccountActive(record.userId)) return undefined
    return this.publicIdentity(record)
  }

  /**
   * 绑定自检（WP-04/A2）：带可识别原因码的绑定态查询——
   * no_cookie（从未绑定/已注销）/ expired（绑定过期）/ account_inactive（账号冻结离职联动失效）。
   * 工作台横幅与重绑引导按 reason 出文案（errors.js「身份绑定已失效」族）。
   */
  bindingStatus(cookieHeader: string | undefined): { bound: boolean; reason?: 'no_cookie' | 'expired' | 'account_inactive'; identity?: Record<string, unknown> } {
    const token = this.readCookieToken(cookieHeader)
    if (!token) return { bound: false, reason: 'no_cookie' }
    const record = this.byToken.get(token)
    if (!record || Date.now() - record.issuedAt > this.ttlMs) return { bound: false, reason: 'expired' }
    if (!this.isAccountActive(record.userId)) return { bound: false, reason: 'account_inactive' }
    return { bound: true, identity: this.publicIdentity(record) }
  }

  /** 直接以平台身份建立绑定（OIDC 授权码通道：userinfo 换取后）。 */
  bindIdentity(identity: { sub: string; name?: string; roles?: string[]; org?: { id?: string } }): string {
    const token = BIND_TOKEN_PREFIX + randomBytes(24).toString('hex')
    const record: BindingRecord = {
      token,
      userId: identity.sub,
      name: identity.name ?? identity.sub,
      roles: identity.roles ?? [],
      orgId: identity.org?.id,
      issuedAt: Date.now(),
    }
    this.evictExpired()
    this.byToken.set(token, record)
    this.current = record
    return token
  }

  /** 绑定 dsh 会话（浏览器引导脚本调用；Cookie 定身份）。 */
  bindSession(sessionId: string, cookieHeader: string | undefined): boolean {
    const identity = this.identityForCookie(cookieHeader)
    if (!identity) return false
    this.evictExpired()
    if (this.bySession.size >= MAX_BINDINGS) {
      const oldest = this.bySession.keys().next().value
      if (oldest !== undefined) this.bySession.delete(oldest)
    }
    this.bySession.set(sessionId, String(identity.sub))
    return true
  }

  /** 工具出站归因解析：会话绑定优先，未绑定回落最近一次绑定（单操作者姿态）。 */
  identityForSession(sessionId?: string): { userId: string; name: string } | undefined {
    this.evictExpired()
    const boundId = sessionId ? this.bySession.get(sessionId) : undefined
    const record = (boundId && [...this.byToken.values()].find((item) => item.userId === boundId)) ?? this.current
    if (!record || Date.now() - record.issuedAt > this.ttlMs) return undefined
    if (!this.isAccountActive(record.userId)) return undefined
    return { userId: record.userId, name: record.name }
  }

  /** 注销：移除该 Cookie 的绑定（会话绑定随 TTL 自然过期）。 */
  revoke(cookieHeader: string | undefined): void {
    const token = this.readCookieToken(cookieHeader)
    if (token) this.byToken.delete(token)
  }

  get cookie(): string {
    return this.cookieName
  }

  private publicIdentity(record: BindingRecord): Record<string, unknown> {
    return { sub: record.userId, name: record.name, roles: record.roles, org: record.orgId ? { id: record.orgId } : undefined }
  }

  private readCookieToken(cookieHeader: string | undefined): string | undefined {
    if (!cookieHeader) return undefined
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=')
      if (name === this.cookieName) return decodeURIComponent(rest.join('='))
    }
    return undefined
  }

  private isAccountActive(userId: string): boolean {
    try {
      const iam = softRead(this.ctx, 'iam') as { users(): { get(id: string): { status?: string } | undefined } } | undefined
      const user = iam?.users().get(userId)
      if (!user) return false
      return user.status === undefined || user.status === 'active'
    } catch {
      // IAM 不可用（不应发生：同进程插件树）——fail-closed 视为未绑定
      return false
    }
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const [token, record] of this.byToken) {
      if (now - record.issuedAt > this.ttlMs) this.byToken.delete(token)
    }
  }
}


export function apply(ctx: Context, config: DshBridgeConfig = {}) {
  const mountPath = (config.mountPath ?? '/rq').replace(/\/+$/, '')
  // 直挂（Service 基类注册 ctx.identityBinding）：复用已存在实例（自测视图注入），否则新建。
  // dsh loader 的轻量 ctx 对「未在 inject 声明的服务」读取会抛错（form B 实测）：
  // 先探测再构造，探测失败（未预注入/被裁剪）一律走本地构造。
  let prebound: IdentityBindingService | undefined
  try {
    prebound = (ctx as unknown as { identityBinding?: IdentityBindingService }).identityBinding
  } catch {
    prebound = undefined
  }
  const bindingService = prebound ?? new IdentityBindingService(ctx, { cookieName: config.cookieName, bindTtlSeconds: config.bindTtlSeconds })
  if (!mountPath.startsWith('/') || mountPath === '/') {
    throw new Error(`dsh-bridge mountPath 非法：${JSON.stringify(config.mountPath)}（须为以 / 开头的非根路径）`)
  }
  const webServer = (ctx as unknown as { webServer?: DshWebServerLike }).webServer
  const httpServer = (ctx as unknown as { httpServer?: HttpServerService }).httpServer
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('dsh-bridge 需要 ctx.webServer（仅在完整 dsh web 宿主下装配本插件）')
  }
  if (!httpServer) {
    throw new Error('dsh-bridge 需要 ctx.httpServer（platform-core 必须先于本插件装配）')
  }

  // ---- 挂载半：元冰可数据面 → /rq 前缀 ----------------------------------------
  webServer.register({
    kind: 'prefix',
    path: mountPath,
    handler(req, res) {
      const url = req.url ?? '/'
      if (url === mountPath) {
        res.writeHead(302, { location: `${mountPath}/` }).end()
        return
      }
      const inner = url.startsWith(`${mountPath}/`) ? url.slice(mountPath.length) : url
      req.url = inner.startsWith('/') ? inner : `/${inner}`
      void httpServer.dispatch(req, res)
    },
  })
  ctx.logger('dsh-bridge').info(`元冰可数据面已挂载至 dsh webServer：${mountPath}/*（单进程单入口）`)

  // ---- 身份半：票据兑换 + 绑定 + 会话关联 ------------------------------------
  const binding = bindingService
  // EntryTicketService（provide 'entryTickets'）与 authn 平级，由 plugin-authn 装配。
  // N 节（交接 F 清单，2026-09-11）修复：请求期惰性解析——dsh Loader 并发装载 patch entry 时
  // authn 可能晚于本插件发布 entryTickets，apply 期软读是竞态写法（软读到 undefined 即整段
  // 早退，/dsh-bridge/* 身份面整体 404、宿主 Cookie 直通失效）。惰性解析后：注册面不再受
  // 装配时序影响；服务就绪前的兑换请求得到明确错误，就绪即通。
  const entryTicketsAt = () => (softRead(ctx, 'entryTickets') as unknown as {
    redeem(ticket: string, clientIp: string): { refType: string; refId: string; identity: { sub: string; name?: string; roles?: string[]; org?: { id?: string } } }
  } | undefined)
  if (!binding) {
    ctx.logger('dsh-bridge').warn('身份半未装配：缺少 identityBinding 服务（仅挂载半生效）')
    return
  }
  const redeemTicket = (ticket: string) => {
    const entryTickets = entryTicketsAt()
    if (!entryTickets) throw new Error('entryTickets 服务未就绪（装配进行中），请稍后重试')
    return entryTickets.redeem(ticket, 'dsh-bridge')
  }

  /** 同源收紧：带 Origin 的请求必须与 Host 同 authority（dsh fence 同语义，防跨站驱动绑定面）。 */
  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      const host = req.headers.host ?? ''
      return new URL(origin).host === host
    } catch {
      return false
    }
  }

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw) return {}
    try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
  }

  const cookieAttrs = (token: string, maxAge: number): string =>
    `${config.cookieName ?? DEFAULT_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`

  // 自然免登通道：控制台/门户「打开交互界面」以 ?entry_ticket= 跳转（query 版契约）
  webServer.register({
    kind: 'exact',
    path: '/auth/entry',
    handler(req, res) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const ticket = url.searchParams.get('entry_ticket') ?? url.searchParams.get('ticket') ?? ''
      if (!ticket) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('missing entry_ticket')
        return
      }
      try {
        const bound = binding.bindByTicket((t) => redeemTicket(t), ticket)
        res.writeHead(302, {
          'set-cookie': cookieAttrs(bound.token, (config.bindTtlSeconds ?? DEFAULT_TTL_SECONDS)),
          location: '/',
        }).end()
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`entry_ticket 无效或已过期：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  })

  // 浏览器半插件/引导脚本的同源绑定面（原生 req/res：可读 Cookie、可 Set-Cookie）
  webServer.register({
    kind: 'prefix',
    path: '/dsh-bridge',
    handler(req, res) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const endpoint = url.pathname.replace(/^\/dsh-bridge\/?/, '')
      if (!sameOrigin(req)) {
        res.writeHead(403).end('forbidden')
        return
      }
      const json = (status: number, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }).end(JSON.stringify(payload))
      }
      if (req.method === 'POST' && endpoint === 'redeem') {
        void readBody(req).then((body) => {
          const ticket = String(body['ticket'] ?? '')
          if (!ticket) { json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'missing ticket' } }); return }
          try {
            const bound = binding.bindByTicket((t) => redeemTicket(t), ticket)
            json(200, { ok: true, data: { identity: bound.identity } }, {
              'set-cookie': cookieAttrs(bound.token, (config.bindTtlSeconds ?? DEFAULT_TTL_SECONDS)),
            })
          } catch (error) {
            json(400, { ok: false, error: { code: 'INVALID_TICKET', message: error instanceof Error ? error.message : String(error) } })
          }
        })
        return
      }
      if (req.method === 'GET' && endpoint === 'status') {
        // WP-04/A2：带原因码的绑定自检（no_cookie/expired/account_inactive），供工作台横幅与重绑引导
        const status = binding.bindingStatus(req.headers.cookie)
        json(200, { ok: true, data: status })
        return
      }
      if (req.method === 'POST' && endpoint === 'logout') {
        binding.revoke(req.headers.cookie)
        json(200, { ok: true, data: { bound: false } }, { 'set-cookie': `${config.cookieName ?? DEFAULT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` })
        return
      }
      if (req.method === 'POST' && endpoint === 'bind-session') {
        void readBody(req).then((body) => {
          const sessionId = String(body['sessionId'] ?? '')
          if (!sessionId) { json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'missing sessionId' } }); return }
          const okFlag = binding.bindSession(sessionId, req.headers.cookie)
          json(okFlag ? 200 : 401, { ok: okFlag, data: { bound: okFlag } })
        })
        return
      }
      // 宿主 Cookie → 平台会话直通（部门面板/控制台 SPA 零二次登录，review-dsh-agent-panel-v2 宿主打通）：
      // rq_sid 绑定身份 → ensureHumanPrincipal + issueSessionPair——与票据免登端点同安全语义
      // （账号状态实时校验在 bindingStatus 内完成；同源收紧已在上方统一执行）
      if (req.method === 'POST' && endpoint === 'session') {
        void (async () => {
          const status = binding.bindingStatus(req.headers.cookie)
          if (!status.bound || !status.identity) {
            json(401, { ok: false, error: { code: 'NOT_BOUND', message: `宿主会话未绑定（${status.reason ?? 'unknown'}）——请从 dsh 宿主入口进入或使用入场票据` } })
            return
          }
          const deps = {
            get authn() { return softRead(ctx, 'authn') },
            get iam() { return softRead(ctx, 'iam') },
            get audit() { return softRead(ctx, 'audit') },
          } as unknown as BridgeSessionDeps
          if (!deps.authn || !deps.iam) {
            json(503, { ok: false, error: { code: 'AUTHN_UNAVAILABLE', message: 'authn 服务不可用（挂载形态装配不完整）' } })
            return
          }
          const user = deps.iam.users().get(String(status.identity.sub))
          if (!user || (user.status !== undefined && user.status !== 'active')) {
            json(401, { ok: false, error: { code: 'ACCOUNT_INACTIVE', message: '绑定账号已冻结或不存在（fail-closed）' } })
            return
          }
          const principal = deps.authn.ensureHumanPrincipal(user.id, user.displayName)
          const session = deps.authn.issueSessionPair(principal.id, { issuedBy: 'dsh-bridge:cookie' })
          try { deps.iam.markLogin(user.id) } catch { /* 登录标记非关键路径 */ }
          deps.audit?.record({
            type: 'auth', actorType: 'human', actorId: user.id, actorName: user.displayName,
            action: 'dsh_bridge.cookie.session', resourceType: 'dsh_bridge', resourceId: 'rq_sid',
            resourceName: '宿主会话', result: 'ok', detail: '宿主 Cookie 绑定身份兑换平台会话（免登直达元冰可数据面）',
          })
          json(200, {
            ok: true,
            data: {
              token: session.token,
              refreshToken: session.refreshToken,
              expiresAt: session.access.expiresAt,
              user: {
                id: user.id, username: user.username, displayName: user.displayName,
                orgId: user.orgId, roleIds: user.roleIds,
                roles: user.roleIds.map((roleId) => deps.iam?.roles().get(roleId)?.name).filter(Boolean),
                permissions: deps.iam.userPermissions(user.id),
              },
            },
          })
        })()
        return
      }
      json(404, { ok: false, error: { code: 'NOT_FOUND', message: `未知端点：${req.method} /dsh-bridge/${endpoint}` } })
    },
  })
  // ---- OIDC 授权码通道（/auth/oidc/start → 平台授权页 → /auth/oidc/callback） --------
  // 未带票据直开 dsh web 的用户：浏览器半插件（或手工）指向 /auth/oidc/start →
  // 服务端生成 PKCE 并 302 平台授权页（本地口令/钉钉扫码）→ 回跳换码 → userinfo → 绑定 Cookie。
  const oidc = softRead(ctx, 'oidc') as { issuer(): string } | undefined
  const dataDirPath = (ctx as unknown as { opsStorage?: { dataDirPath?: string } }).opsStorage?.dataDirPath
  const credFile = config.oidcCredentialFile ?? (dataDirPath ? join(dataDirPath, 'dsh-agent-credential.json') : undefined)
  const pendingOidc = new Map<string, { verifier: string; redirectUri: string; issuedAt: number }>()
  const OIDC_PENDING_TTL = 10 * 60_000

  if (oidc && credFile && existsSync(credFile)) {
    let oidcClient: { clientId: string; clientSecret?: string } | undefined
    try {
      const parsed = JSON.parse(readFileSync(credFile, 'utf8'))
      if (parsed?.oidc?.clientId) oidcClient = { clientId: parsed.oidc.clientId, clientSecret: parsed.oidc.clientSecret }
    } catch { /* 凭证文件缺失/损坏：OIDC 通道降级为不可用，entry-ticket 通道不受影响 */ }
    if (oidcClient) {
      webServer.register({
        kind: 'exact',
        path: '/auth/oidc/start',
        handler(req, res) {
          if (!sameOrigin(req)) { res.writeHead(403).end('forbidden'); return }
          const redirectUri = `${originOf(req)}/auth/oidc/callback`
          const verifier = base64url(randomBytes(32))
          const state = base64url(randomBytes(16))
          const challenge = base64url(createHash('sha256').update(verifier).digest())
          pendingOidc.set(state, { verifier, redirectUri, issuedAt: Date.now() })
          for (const [key, value] of pendingOidc) {
            if (Date.now() - value.issuedAt > OIDC_PENDING_TTL) pendingOidc.delete(key)
          }
          const authorize = new URL(`${oidc.issuer()}/oauth/authorize`)
          authorize.searchParams.set('response_type', 'code')
          authorize.searchParams.set('client_id', oidcClient!.clientId)
          authorize.searchParams.set('redirect_uri', redirectUri)
          authorize.searchParams.set('scope', 'openid profile')
          authorize.searchParams.set('state', state)
          authorize.searchParams.set('code_challenge', challenge)
          authorize.searchParams.set('code_challenge_method', 'S256')
          res.writeHead(302, { location: authorize.toString() }).end()
        },
      })
      webServer.register({
        kind: 'exact',
        path: '/auth/oidc/callback',
        handler(req, res) {
          void (async () => {
            const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
            const code = url.searchParams.get('code') ?? ''
            const state = url.searchParams.get('state') ?? ''
            const pending = pendingOidc.get(state)
            pendingOidc.delete(state)
            if (!code || !pending || Date.now() - pending.issuedAt > OIDC_PENDING_TTL) {
              res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('OIDC 回跳无效或已过期，请重新发起登录')
              return
            }
            try {
              const tokenRes = await fetch(`${oidc.issuer()}/oauth/token`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/x-www-form-urlencoded',
                  ...(oidcClient!.clientSecret
                    ? { authorization: `Basic ${Buffer.from(`${oidcClient!.clientId}:${oidcClient!.clientSecret}`).toString('base64')}` }
                    : {}),
                },
                body: new URLSearchParams({
                  grant_type: 'authorization_code', code,
                  redirect_uri: pending.redirectUri, code_verifier: pending.verifier,
                }).toString(),
              })
              const tokenPayload = await tokenRes.json().catch(() => null)
              const accessToken = tokenPayload?.access_token
              if (!tokenRes.ok || !accessToken) throw new Error(tokenPayload?.error_description ?? `token 端点失败（${tokenRes.status}）`)
              const userinfoRes = await fetch(`${oidc.issuer()}/oauth/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } })
              const userinfo = await userinfoRes.json().catch(() => null)
              if (!userinfoRes.ok || !userinfo?.sub) throw new Error('userinfo 换取失败')
              const identity = {
                sub: String(userinfo.sub),
                name: typeof userinfo.name === 'string' ? userinfo.name : undefined,
                roles: Array.isArray(userinfo.roles) ? userinfo.roles.map(String) : undefined,
                org: userinfo.org && typeof userinfo.org === 'object' ? { id: String((userinfo.org as { id?: unknown }).id ?? '') || undefined } : undefined,
              }
              const token = binding.bindIdentity(identity)
              res.writeHead(302, {
                'set-cookie': cookieAttrs(token, (config.bindTtlSeconds ?? DEFAULT_TTL_SECONDS)),
                location: '/',
              }).end()
            } catch (error) {
              res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`OIDC 登录失败：${error instanceof Error ? error.message : String(error)}`)
            }
          })()
        },
      })
      ctx.logger('dsh-bridge').info('OIDC 授权码通道已挂载：/auth/oidc/start → /auth/oidc/callback（PKCE S256）')
    } else {
      ctx.logger('dsh-bridge').info(`OIDC 凭证文件无 oidc 字段，授权码通道未启用：${credFile}`)
    }
  } else {
    ctx.logger('dsh-bridge').info(`OIDC 凭证文件不存在（${credFile ?? '未配置'}），授权码通道未启用——可先运行 register-dsh-agent.mjs`)
  }

  // ---- 免登引导脚本（tapIndex）：承接 #entry_ticket= fragment 既有契约 ----------------
  // fragment 不进服务端日志（优于 query）；同源 POST 天然通过 dsh 信任围栏。
  // 控制台 openAgentEntry 跳转 <entryUrl>#entry_ticket=<ticket> → 本脚本兑换 → 清 hash → 刷新。
  const tapIndex = (webServer as { tapIndex?: (transform: (html: string) => string) => () => void }).tapIndex
  if (typeof tapIndex === 'function') {
    tapIndex.call(webServer, (html: string) => {
      const script = `<script>(function(){try{var m=(location.hash||'').match(/[#&]entry_ticket=([^&]+)/);if(!m)return;` +
        `fetch('/dsh-bridge/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:decodeURIComponent(m[1])})})` +
        `.then(function(r){return r.json()}).then(function(j){` +
        `try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}` +
        `if(j&&j.ok)location.reload();}).catch(function(){});}catch(e){}})();</script>`
      const head = html.indexOf('<head>')
      if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
      return `${script}${html}`
    })
    ctx.logger('dsh-bridge').info('免登引导脚本已注入 dsh web UI（#entry_ticket fragment 兑换）')
  } else {
    ctx.logger('dsh-bridge').warn('webServer.tapIndex 不可用——#entry_ticket fragment 通道降级，仅 /auth/entry?entry_ticket= query 通道可用')
  }
}
