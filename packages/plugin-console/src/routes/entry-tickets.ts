/**
 * 平台授权直达复合域路由：entry-ticket 签发/兑换（控制台打开交互界面/应用带平台身份）+ 应用访客埋点 beacon（PV/UV 免机器鉴权）+ Agent SSO 客户端（OIDC 关联/ssoManageGuard 工厂随迁）（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出，处理器逐字搬运（行为与迁出前一致）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type { ConsoleRouteDeps } from './deps.ts'
import { PlatformEvents } from '../../../platform-core/src/index.ts'
import type { HttpExchange } from '../../../platform-core/src/index.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import { isDemoMode } from '../demo-mode.ts'
import { DEMO_ENTRY_USERNAME, DEMO_SEED_PASSWORD } from '../seed.ts'
import type { ConsoleRouteDeps as _D } from './deps.ts'

export interface EntryTicketRouteDeps extends _D {
  /** SSO 管理守卫（app/agent 两侧共用，工厂留 index.ts；见 ssoManageGuard） */
  agentSsoGuard: (exchange: HttpExchange, op: 'create' | 'update' | 'rotate' | 'enable' | 'disable', input?: { redirectUris?: string[]; postLogoutUris?: string[] }) => boolean
}
export function registerEntryTicketRoutes(ctx: Context, deps: EntryTicketRouteDeps): void {
  const { http, guarded, body, changeLog, caller, agentSsoGuard } = deps
  // -- 平台授权直达（entry-ticket）：控制台「打开交互界面/打开应用」带平台身份访问 ---------
  /**
   * 签发 Agent 入场票据（human-only）：「使用即授权留痕」——仅 owner、绑定用户或管理员可直达，
   * 未授权用户被拒并指路绑定流程。票据一次性 + 短时（默认 120s），Agent 前端以
   * POST /api/authn/entry-tickets/redeem 兑换平台身份（详见 docs/agent-onboarding.md）。
   */
  guarded('POST', '/api/agents/:id/entry-ticket', 'agent.read', (exchange) => {
    const info = caller(exchange)
    if (info.kind !== 'human' || !info.userId) {
      exchange.fail(403, 'FORBIDDEN', t('平台授权直达仅限登录用户（human），机器身份不可签发入场票据'))
      return
    }
    const id = exchange.params['id']!
    const agent = ctx.resourceCore.get('agent', id)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id }))
    const isOwner = agent.ownerId === info.userId
    const isBound = ctx.agentRegistry.boundUsers(id).some((item) => item.userId === info.userId)
    const isAdmin = info.permissions.includes('*') || info.permissions.includes('agent.write')
    if (!isOwner && !isBound && !isAdmin) {
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info.userId, actorName: info.name, point: `agent.entry(owner:${id})`, path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', t('仅 Agent 负责人或绑定用户可直达「{name}」交互界面（使用即授权留痕），请联系负责人在「权限与绑定」中绑定', { name: agent.name }))
      return
    }
    const issued = ctx.entryTickets.issue({ refType: 'agent', refId: id, userId: info.userId, userName: info.name })
    changeLog(exchange, 'agent.entry.ticket.issue', 'agent', id, agent.name, t('一次性入场票据（{ttl}s）', { ttl: issued.ttlSeconds }))
    return issued
  })

  /** 签发应用入场票据（human-only）：登录用户即可领取（应用内业务权限由应用自身裁决）。 */
  guarded('POST', '/api/apps/:id/entry-ticket', 'app.read', (exchange) => {
    const info = caller(exchange)
    if (info.kind !== 'human' || !info.userId) {
      exchange.fail(403, 'FORBIDDEN', t('平台授权直达仅限登录用户（human），机器身份不可签发入场票据'))
      return
    }
    const id = exchange.params['id']!
    const app = ctx.resourceCore.get('app', id)
    if (!app) throw new Error(t('应用不存在：{id}', { id }))
    const issued = ctx.entryTickets.issue({ refType: 'app', refId: id, userId: info.userId, userName: info.name })
    changeLog(exchange, 'app.entry.ticket.issue', 'app', id, app.name, t('一次性入场票据（{ttl}s）', { ttl: issued.ttlSeconds }))
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
        resourceName: result.refId, result: 'ok', detail: t('平台授权直达票据兑换（身份已交付目标交互界面）'),
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
   * 签发侧授权语义已在领票端点定格，此处仅消费。
   *
   * 安全审查 P0-01（2026-10-31）：票据用途强隔离——仅 refType='self' 的自助票（签发人=领取人，
   * 消费面为平台自有面板/白名单回跳）可兑换控制台会话。app/agent 票的接收方是不可控第三方
   * 前端，若允许其兑换完整会话（含 refresh），恶意应用即可用票据接管签发人的平台身份
   * （高权限用户受影响时为管理权限接管）。此类票只能走 /api/authn/entry-tickets/redeem
   * 换取资源侧身份，永不建立平台会话。
   */
  http.register('POST', '/api/auth/entry-ticket-session', (exchange) => {
    const input = body<{ ticket?: string }>(exchange)
    const clientIp = String(exchange.raw.socket?.remoteAddress ?? 'unknown')
    try {
      const redeemed = ctx.entryTickets.redeem(String(input.ticket ?? ''), clientIp)
      if (redeemed.refType !== 'self' || redeemed.refId !== redeemed.identity.sub) {
        ctx.audit.record({
          type: 'auth', actorType: 'human', actorId: redeemed.identity.sub, actorName: redeemed.identity.name,
          action: `${redeemed.refType}.entry.ticket.session.denied`, resourceType: redeemed.refType, resourceId: redeemed.refId,
          resourceName: redeemed.refId, result: 'denied', detail: t('非自助票拒绝兑换控制台会话（票据用途隔离，P0-01）'),
        })
        throw new Error(t('该票据类型不可用于登录控制台（应用/Agent 票仅交付资源侧身份）'))
      }
      const user = ctx.iam.users().get(redeemed.identity.sub)
      if (!user || user.status !== 'active') throw new Error(t('签发用户状态异常（冻结/离职联动失效）'))
      const principal = ctx.authn.ensureHumanPrincipal(user.id, user.displayName)
      const session = ctx.authn.issueSessionPair(principal.id, { issuedBy: `entry-ticket:${redeemed.refType}:${redeemed.refId}` })
      ctx.iam.markLogin(user.id)
      ctx.audit.record({
        type: 'auth', actorType: 'human', actorId: user.id, actorName: user.displayName,
        action: `${redeemed.refType}.entry.ticket.session`, resourceType: redeemed.refType, resourceId: redeemed.refId,
        resourceName: redeemed.refId, result: 'ok', detail: t('入场票据兑换控制台会话（免登直达工作台）'),
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
    if (!info.userId) throw new Error(t('仅平台登录人类可自助签发入场票据'))
    const issued = ctx.entryTickets.issue(
      { refType: 'self', refId: info.userId, userId: info.userId, userName: info.name },
      { maxTtlSeconds: 120 },
    )
    changeLog(exchange, 'self.entry.ticket.issue', 'user', info.userId, info.name, t('自助入场票据（跨源自举回跳，{ttl}s，一次性）', { ttl: issued.ttlSeconds }))
    return issued
  })

  /**
   * 演示态一键入场（DEMO_MODE=1 专用公开端点，2026-11-01）：服务端登录种子演示账号 +
   * 签发一次性自助票——演示访客从控制台入口经 gate01.html 中转页免密直达 01门面板
   * （/gate01/panel/#entry_ticket= 兑换会话），不再向客户暴露「输入账号密码」一步。
   * 安全口径：能换到的只有演示种子身份的 ≤120s 一次性票，而该身份口令本就公开于仓库
   * （seed.ts DEMO_SEED_PASSWORD）——不新增任何生产鉴权面；非演示实例恒 404。
   */
  http.register('POST', '/api/panel/auth/demo-entry', (exchange) => {
    if (!isDemoMode()) {
      exchange.fail(404, 'NOT_FOUND', t('路由不存在：POST /api/panel/auth/demo-entry'))
      return
    }
    try {
      const result = ctx.authn.login(DEMO_ENTRY_USERNAME, DEMO_SEED_PASSWORD)
      const user = ctx.iam.users().get(result.userId)
      if (!user || user.status !== 'active') throw new Error(t('演示账号状态异常（缺失或未激活）'))
      const issued = ctx.entryTickets.issue(
        { refType: 'self', refId: user.id, userId: user.id, userName: user.displayName },
        { maxTtlSeconds: 120 },
      )
      ctx.audit.record({
        type: 'auth', actorType: 'human', actorId: user.id, actorName: user.displayName,
        action: 'demo.entry.ticket.issue', resourceType: 'user', resourceId: user.id,
        resourceName: user.username, result: 'ok', detail: t('演示态一键入场票据（{ttl}s，一次性）', { ttl: issued.ttlSeconds }),
      })
      exchange.ok({ ticket: issued.ticket, expiresInSeconds: issued.ttlSeconds, panel: '/gate01/panel/' })
    } catch (error) {
      exchange.fail(503, 'DEMO_ENTRY_FAILED', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'public', selfValidated: true })

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
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id: exchange.params['id'] }))
    return { id: agent.id, name: agent.name, ownerId: agent.ownerId }
  }


  guarded('POST', '/api/agents/:id/sso-client', 'agent.write', (exchange) => {
    const input = body<{ redirectUris: string[]; clientType?: 'confidential' | 'public'; consentRequired?: boolean; postLogoutUris?: string[]; description?: string }>(exchange)
    if (!agentSsoGuard(exchange, 'create', { redirectUris: input.redirectUris, postLogoutUris: input.postLogoutUris })) return
    const agent = ssoAgent(exchange)
    const created = ctx.agentRegistry.createSsoClient(agent.id, input)
    changeLog(exchange, 'agent.sso.create', 'oidc_client', created.client.id, created.client.name, t('Agent {name} 签发（{clientType}）', { name: agent.name, clientType: input.clientType ?? 'confidential' }))
    return {
      clientId: created.client.clientId,
      clientSecret: created.clientSecret,
      redirectUris: created.client.redirectUris,
      note: created.client.clientType === 'public' ? t('public 客户端无 secret（强制 PKCE、不发 refresh）') : t('clientSecret 仅此一次返回'),
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
    changeLog(exchange, 'agent.sso.rotate', 'oidc_client', rotated.client.id, rotated.client.name, t('旧 secret 立即失效'))
    return { clientId: rotated.client.clientId, clientSecret: rotated.clientSecret, note: t('新 clientSecret 仅此一次返回，旧值立即失效') }
  })

  for (const action of ['disable', 'enable'] as const) {
    guarded('POST', `/api/agents/:id/sso-client/${action}`, 'agent.write', (exchange) => {
      if (!agentSsoGuard(exchange, action)) return
      const agent = ssoAgent(exchange)
      const { reason } = body<{ reason?: string }>(exchange)
      const client = action === 'disable'
        ? ctx.agentRegistry.disableSsoClient(agent.id, reason ?? t('owner 手动禁用'))
        : ctx.agentRegistry.enableSsoClient(agent.id)
      changeLog(exchange, `agent.sso.${action}`, 'oidc_client', client.id, client.name, reason ?? '')
      return client
    })
  }

}
