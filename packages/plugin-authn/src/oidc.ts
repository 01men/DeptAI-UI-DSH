/**
 * OIDC Provider（生态设计 v1.2 第 6 步，模式 B：平台作为外部应用的身份源）。
 *
 * 授权码模式（浏览器授权流）：
 *   GET  /oauth/authorize —— 校验 client/redirect_uri/scope/强制 PKCE(S256)，落授权请求，
 *                            302 平台授权页 /#/oauth/authorize?req=<id>（失败一律 302 平台错误页，
 *                            绝不携带外部 redirect_uri，防开放重定向）；
 *   POST /api/authn/oidc/authorize —— 登录用户在授权页确认（human-only）→ 签发一次性 code →
 *                            返回回跳地址（含 code/state/iss，RFC 9207 防 mix-up）；
 *   POST /oauth/token —— code 换 RS256 令牌对；client_secret_basic 与 client_secret_post 双认证，
 *                            form-encoded 与 JSON 双编码；refresh_token 轮转 grant；
 *   GET  /oauth/userinfo —— NormalizedProfile（org/角色/租户），冻结/离职即时 401；
 *   GET  /oauth/end_session —— RP 发起登出（id_token_hint 定位 client，回跳命中 postLogoutUris）；
 *   POST /oauth/revoke —— RFC 7009 令牌吊销（access jti 黑名单 / refresh 整链）。
 *
 * 密钥：RS256 数组化 JWKS（kid 匹配验签，签名恒用最新 key；旧 key 24h 宽限保留验签）。
 * CORS：纯前端（public + PKCE）客户端在浏览器跨域直调 /oauth/token、/oauth/userinfo、
 *      /oauth/revoke 与 discovery 端点——允许来源 = 已登记客户端 redirect_uri 的 origin
 *      ∪ OIDC_CORS_ORIGINS（逗号分隔），OPTIONS 预检统一 204（见 allowedCorsOrigins）。
 * 注意：/oauth/* 与 /.well-known/* 不受控制台 Bearer 中间件约束（协议公开端点）；
 *      /api/authn/oidc/auth-requests/:id 为公开查询（仅回显客户端名/scope，不泄露 redirect_uri）。
 */
import { createHash, generateKeyPairSync, randomUUID, sign as rsSign, verify as rsVerify, createPublicKey } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents, sha256Hex, newId, generateSecret, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'

/** OIDC 协议端点错误（RFC 6749 §5.2 状态码归位：invalid_grant 等 400、invalid_client 401）。 */
export class OidcEndpointError extends Error {
  status: number
  error: string
  headers: Record<string, string>
  constructor(status: number, error: string, description: string, headers: Record<string, string> = {}) {
    super(description)
    this.status = status
    this.error = error
    this.headers = headers
  }
}

export interface OidcClientRecord extends RecordBase {
  name: string
  clientId: string
  clientSecretHash: string
  redirectUris: string[]
  /** 关联资源（'app'=AI 应用 / 'agent'=Agent 本体；详情页 owner 自助签发时回填）。 */
  refType?: 'app' | 'agent'
  refId?: string
  /** 缺省 active（旧数据零迁移）。 */
  status?: 'active' | 'disabled'
  /** 授权页是否需要用户显式勾选同意。 */
  consentRequired?: boolean
  /** RP 发起登出的合法回跳地址白名单。 */
  postLogoutUris?: string[]
  description?: string
  /** confidential（持有 secret）/ public（纯前端 SPA，免 secret + 强制 PKCE + 不发 refresh）。 */
  clientType?: 'confidential' | 'public'
}

/** 浏览器授权流第一跳落库的授权请求（5 分钟、单次消费）。 */
export interface OidcAuthRequestRecord extends RecordBase {
  clientId: string
  redirectUri: string
  state: string
  scope: string
  nonce?: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
  expiresAt: string
  consumedAt?: string
  createdAt: string
}

export interface OidcCodeRecord extends RecordBase {
  clientId: string
  userId: string
  redirectUri: string
  state: string
  nonce?: string
  scope: string
  /** PKCE（S256）：换 token 必须携带匹配的 code_verifier（当前强制）。 */
  codeChallenge?: string
  codeChallengeMethod?: 'S256'
  expiresAt: string
  usedAt?: string
}

/** OIDC refresh token（轮转一次一换；重放整链吊销；库存仅哈希）。 */
export interface OidcRefreshRecord extends RecordBase {
  clientId: string
  userId: string
  scope: string
  tokenHash: string
  chainId: string
  rotatedAt?: string
  revokedAt?: string
  revokedReason?: string
  expiresAt: string
}

/** RFC 7009：无状态 access token（JWT）的 jti 吊销黑名单。 */
export interface OidcDeniedJtiRecord extends RecordBase {
  jti: string
  expiresAt: string
  reason: string
}

interface OidcKeyMaterial {
  privatePem: string
  publicPem: string
  kid: string
  createdAt: string
  /** 轮换退役时间：24h 宽限期内保留验签与 JWKS 公布。 */
  retiredAt?: string
}

/** 旧密钥的验签/JWKS 宽限期（与平台会话签名密钥轮换惯例对齐）。 */
const KEY_GRACE_MS = 24 * 3600_000
/** 授权码与授权请求 TTL（5 分钟）。 */
const AUTHREQ_TTL_MS = (Number(process.env.OIDC_AUTHREQ_TTL_SECONDS ?? 300) || 300) * 1000
const CODE_TTL_MS = (Number(process.env.OIDC_CODE_TTL_SECONDS ?? 300) || 300) * 1000
/** access token TTL（默认 2h，环境变量可调）。 */
const ACCESS_TTL_SECONDS = Number(process.env.OIDC_ACCESS_TTL_SECONDS ?? 7200) || 7200
/** refresh token TTL（默认 7d）。 */
const REFRESH_TTL_SECONDS = Number(process.env.OIDC_REFRESH_TTL_SECONDS ?? 604800) || 604800

export class OidcService extends Service {
  static readonly provide = 'oidc'
  /** authn：复用登录限流；resourceCore：OIDC 客户端关联应用名回显（resource-core 先于本服务就绪，无环）。 */
  static readonly inject = ['authn', 'resourceCore']

  private keys: OidcKeyMaterial[]
  private cleanupTimer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context) {
    super(ctx, 'oidc')
    if (!process.env.OIDC_ISSUER) {
      ctx.logger('oidc').info(
        '未配置 OIDC_ISSUER：issuer 按请求 Host/X-Forwarded-* 头派生（反代/公网域名部署开箱可用，#15）；' +
        '多域名或需要固定 issuer 锚点的部署请显式声明 OIDC_ISSUER（见 docs/app-sso-integration.md）',
      )
    }
    this.keys = this.loadOrCreateKeys()
    this.registerRoutes()
    this.cleanupExpired()
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 24 * 3600_000)
    this.cleanupTimer.unref?.() // OPT-P3-02
    ctx.effect(() => () => {
      if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    })
    // -- 生命周期联动（真实事件名，见 platform-core/src/bus.ts） --------------------------
    // 应用下线/归档 → 关联客户端禁用（refresh 链一并吊销）；上线/恢复 → 重新启用；改名 → 同步
    ctx.platformBus.on(PlatformEvents.AppOfflined, (payload) => {
      const { id } = payload as { id: string }
      for (const client of this.clientsForApp(id)) this.disableClient(client.id, t('应用下线联动'))
    })
    ctx.platformBus.on(PlatformEvents.AppArchived, (payload) => {
      const { id } = payload as { id: string }
      for (const client of this.clientsForApp(id)) this.disableClient(client.id, t('应用归档联动'))
    })
    ctx.platformBus.on(PlatformEvents.AppOnlined, (payload) => {
      const { id } = payload as { id: string }
      for (const client of this.clientsForApp(id)) this.enableClient(client.id)
    })
    ctx.platformBus.on(PlatformEvents.AppUpdated, (payload) => {
      const { id, name } = payload as { id: string; name: string }
      for (const client of this.clientsForApp(id)) this.updateClient(client.id, { name })
    })
    // Agent 下线 → 关联客户端禁用（refresh 链一并吊销）；上线/恢复 → 重新启用（OIDC-agent 关联）
    ctx.platformBus.on(PlatformEvents.AgentOfflined, (payload) => {
      const { id } = payload as { id: string }
      for (const client of this.clientsForAgent(id)) this.disableClient(client.id, t('Agent 下线联动'))
    })
    ctx.platformBus.on(PlatformEvents.AgentOnlined, (payload) => {
      const { id } = payload as { id: string }
      for (const client of this.clientsForAgent(id)) this.enableClient(client.id)
    })
    // 账号冻结/注销 → 该用户全部 OIDC refresh 链即时失效（无需等过期）
    ctx.platformBus.on(PlatformEvents.UserFrozen, (payload) => {
      const { userId, reason } = payload as { userId: string; reason: string }
      this.revokeUserRefreshChains(userId, t('账号冻结联动：{reason}', { reason }))
    })
  }

  /**
   * 签发方 issuer（#15，2026-10-29）：解析优先级——
   *   1. OIDC_ISSUER 显式声明（多域名/严格部署的固定锚点，最高优先）；
   *   2. 按请求派生：x-forwarded-host/host + x-forwarded-proto（反代场景，与 console requestOrigin
   *      同口径）+ externalBase 前缀——公网域名部署时 discovery/签发/校验自动对齐，远程 SSO 开箱可用；
   *   3. 回落 http://127.0.0.1:<port><base>（本机调试）。
   * 不传请求上下文时保持旧行为（env ?? 环回）——非请求面调用（测试/内部校验）零感知。
   *
   * 安全审查 P1-06（2026-10-31）：请求派生受外部头（x-forwarded-host/host）影响，公网上可被
   * 伪造头改写 discovery 元数据。收敛规则：
   *   - OIDC_ISSUER 已设 → 永远返回固定值，不再按请求派生（固定发行方）；
   *   - 未设时仅当派生 host 命中 OIDC_TRUSTED_HOSTS 白名单（逗号分隔精确匹配）才采信，
   *     否则回落环回（fail-closed）——公网部署必须二选一显式配置。
   */
  issuer(origin?: { headers: import('node:http').IncomingHttpHeaders }): string {
    if (process.env.OIDC_ISSUER) return process.env.OIDC_ISSUER
    const derived = this.deriveIssuerFromRequest(origin)
    return derived ?? `http://127.0.0.1:${this.ctx.httpServer.port}${this.ctx.httpServer.externalBase}`
  }

  /** 按请求头派生对外 issuer（host 缺失/不在可信白名单返回 undefined 走回落）。 */
  private deriveIssuerFromRequest(origin?: { headers: import('node:http').IncomingHttpHeaders }): string | undefined {
    if (!origin) return undefined
    const header = (name: string): string | undefined => {
      const value = origin.headers[name]
      return value === undefined ? undefined : String(Array.isArray(value) ? value[0] : value)
    }
    const host = header('x-forwarded-host') ?? header('host')
    if (!host) return undefined
    const trusted = new Set(String(process.env.OIDC_TRUSTED_HOSTS ?? '')
      .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))
    // 回环主机隐式可信（dsh-bridge 同源回跳等本机流程依赖）：伪造 Host: 127.x 只能把
    // 重定向指回攻击者自己的机器，无目标可伤；非回环主机必须显式登记白名单。
    // host 头可带端口（127.0.0.1:7300），经 URL 解析取裸主机名再比对。
    let hostname = ''
    try { hostname = new URL(`http://${host}`).hostname.toLowerCase() } catch { hostname = '' }
    const loopback = hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    if (!loopback && !trusted.has(hostname)) return undefined
    const proto = header('x-forwarded-proto') ?? 'http'
    return `${proto}://${host}${this.webBase()}`
  }

  /** JWT 校验可接受的 issuer 集合：OIDC_ISSUER 已设即仅固定值；未设时并入可信白名单派生值。 */
  private acceptedIssuers(origin?: { headers: import('node:http').IncomingHttpHeaders }): string[] {
    const staticIssuer = this.issuer()
    const derived = this.deriveIssuerFromRequest(origin)
    return derived !== undefined && derived !== staticIssuer ? [staticIssuer, derived] : [staticIssuer]
  }

  /** 平台 SPA 内部页面的对外前缀（独立形态 ''，dsh 挂载形态 '/rq'）。 */
  private webBase(): string {
    return this.ctx.httpServer?.externalBase ?? ''
  }

  clients(): Collection<OidcClientRecord> {
    const collection = this.ctx.opsStorage.collection<OidcClientRecord>('authn:oidcClients')
    collection.uniqueOn('oidc_client_id', (item) => item.clientId)
    return collection
  }

  codes(): Collection<OidcCodeRecord> {
    return this.ctx.opsStorage.collection<OidcCodeRecord>('authn:oidcCodes')
  }

  authRequests(): Collection<OidcAuthRequestRecord> {
    return this.ctx.opsStorage.collection<OidcAuthRequestRecord>('authn:oidcAuthRequests')
  }

  refreshTokens(): Collection<OidcRefreshRecord> {
    return this.ctx.opsStorage.collection<OidcRefreshRecord>('authn:oidcRefreshTokens')
  }

  deniedJtis(): Collection<OidcDeniedJtiRecord> {
    return this.ctx.opsStorage.collection<OidcDeniedJtiRecord>('authn:oidcDeniedJtis')
  }

  clientByClientId(clientId: string): OidcClientRecord | undefined {
    return this.clients().findOne((item) => item.clientId === clientId)
  }

  clientsForAgent(agentId: string): OidcClientRecord[] {
    return this.clients().find((item) => item.refType === 'agent' && item.refId === agentId)
  }

  clientsForApp(appId: string): OidcClientRecord[] {
    return this.clients().find((item) => item.refType === 'app' && item.refId === appId)
  }

  static isClientActive(client: OidcClientRecord): boolean {
    return (client.status ?? 'active') === 'active'
  }

  // -- 客户端生命周期 -------------------------------------------------------

  /** 对外脱敏（QA SEC-02）：clientSecretHash 为凭证哈希，客户端列表/详情响应一律不外发（对齐 principals 的脱敏口径）；内部校验仍走 clients()/clientByClientId() 原始记录。 */
  private publicClient<C extends OidcClientRecord>(client: C): Omit<C, 'clientSecretHash'> {
    const { clientSecretHash, ...safe } = client
    void clientSecretHash
    return safe
  }

  createClient(input: {
    name: string
    redirectUris: string[]
    description?: string
    consentRequired?: boolean
    postLogoutUris?: string[]
    clientType?: 'confidential' | 'public'
    refType?: 'app' | 'agent'
    refId?: string
  }): { client: Omit<OidcClientRecord, 'clientSecretHash'>; clientSecret: string } {
    const clientType = input.clientType ?? 'confidential'
    const clientId = 'oc-' + newId('id').slice(3)
    // public 客户端无 secret（强制 PKCE、不发 refresh）；confidential 一次性生成
    const clientSecret = clientType === 'public' ? '' : generateSecret('ocs')
    const client = this.clients().insert({
      id: newId('oc'),
      name: input.name,
      clientId,
      clientSecretHash: clientType === 'public' ? '' : sha256Hex(clientSecret),
      redirectUris: input.redirectUris,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.consentRequired !== undefined ? { consentRequired: input.consentRequired } : {}),
      ...(input.postLogoutUris !== undefined ? { postLogoutUris: input.postLogoutUris } : {}),
      clientType,
      ...(input.refType !== undefined ? { refType: input.refType } : {}),
      ...(input.refId !== undefined ? { refId: input.refId } : {}),
    })
    return { client: this.publicClient(client), clientSecret }
  }

  listClients(): Array<Omit<OidcClientRecord, 'clientSecretHash'> & { refAppName?: string; refAgentName?: string }> {
    return this.clients().all().map((client) => this.publicClient({
      ...client,
      ...(client.refType === 'app' && client.refId
        ? { refAppName: this.ctx.resourceCore?.get('app', client.refId)?.name ?? client.refId }
        : {}),
      ...(client.refType === 'agent' && client.refId
        ? { refAgentName: this.ctx.resourceCore?.get('agent', client.refId)?.name ?? client.refId }
        : {}),
    }))
  }

  updateClient(id: string, patch: { name?: string; redirectUris?: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[] }): Omit<OidcClientRecord, 'clientSecretHash'> {
    return this.publicClient(this.clients().update(id, patch))
  }

  /** 轮换 secret：旧值立即失效，新值仅本次返回。 */
  rotateSecret(id: string): { client: Omit<OidcClientRecord, 'clientSecretHash'>; clientSecret: string } {
    const client = this.clients().get(id)
    if (!client) throw new Error(t('OIDC 客户端不存在：{id}', { id }))
    if ((client.clientType ?? 'confidential') === 'public') throw new Error(t('public 客户端无 secret，无需轮换'))
    const clientSecret = generateSecret('ocs')
    const updated = this.clients().update(id, { clientSecretHash: sha256Hex(clientSecret) })
    return { client: this.publicClient(updated), clientSecret }
  }

  disableClient(id: string, reason: string): Omit<OidcClientRecord, 'clientSecretHash'> {
    const client = this.clients().get(id)
    if (!client) throw new Error(t('OIDC 客户端不存在：{id}', { id }))
    this.revokeClientRefreshChains(client.clientId, t('客户端禁用联动：{reason}', { reason }))
    return this.publicClient(this.clients().update(id, { status: 'disabled' }))
  }

  enableClient(id: string): Omit<OidcClientRecord, 'clientSecretHash'> {
    return this.publicClient(this.clients().update(id, { status: 'active' }))
  }

  // -- 浏览器授权流 ---------------------------------------------------------

  /** 允许对外签发的 scope 白名单（不得任意申请并原样进 JWT）。 */
  static readonly ALLOWED_SCOPES = ['openid', 'profile', 'email']

  /** 授权码格式校验（S256 应为 43-128 位 base64url）。 */
  private static assertPkceChallenge(challenge: string | undefined): void {
    if (challenge === undefined || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      throw new OidcEndpointError(302, 'invalid_request', t('缺少或非法的 code_challenge（本 Provider 强制 PKCE S256，43-128 位 base64url）'))
    }
  }

  /**
   * 发起授权（GET /oauth/authorize）：协议面校验 → 落授权请求 → 302 平台授权页。
   * 任一校验失败抛 OidcEndpointError（路由层统一 302 平台错误页，不携带外部 redirect_uri）。
   */
  beginAuthorization(input: {
    responseType?: string
    clientId?: string
    redirectUri?: string
    state?: string
    scope?: string
    nonce?: string
    codeChallenge?: string
    codeChallengeMethod?: string
  }): OidcAuthRequestRecord {
    if (input.responseType !== 'code') {
      throw new OidcEndpointError(302, 'unsupported_response_type', t('response_type 仅支持 code（收到：{received}）', { received: input.responseType ?? t('缺失') }))
    }
    if (!input.state) throw new OidcEndpointError(302, 'invalid_request', t('state 必填（CSRF 防护）'))
    const client = this.clientByClientId(String(input.clientId ?? ''))
    if (!client) throw new OidcEndpointError(302, 'unauthorized_client', t('OIDC 客户端不存在：{id}', { id: input.clientId ?? t('缺失') }))
    if (!OidcService.isClientActive(client)) throw new OidcEndpointError(302, 'unauthorized_client', t('OIDC 客户端已禁用，请联系管理员'))
    const redirectUri = input.redirectUri ?? client.redirectUris[0]
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      throw new OidcEndpointError(302, 'invalid_request', t('redirect_uri 未登记在客户端白名单'))
    }
    const scopes = (input.scope ?? 'openid profile').split(/\s+/).filter(Boolean)
    const offender = scopes.find((scope) => !OidcService.ALLOWED_SCOPES.includes(scope))
    if (offender) throw new OidcEndpointError(302, 'invalid_scope', t('scope 未获授权：{scope}（允许：{allowed}）', { scope: offender, allowed: OidcService.ALLOWED_SCOPES.join(' ') }))
    if (input.codeChallengeMethod !== undefined && input.codeChallengeMethod !== 'S256') {
      throw new OidcEndpointError(302, 'invalid_request', t('code_challenge_method 仅支持 S256'))
    }
    OidcService.assertPkceChallenge(input.codeChallenge)
    return this.authRequests().insert({
      id: randomUUID(),
      clientId: client.clientId,
      redirectUri,
      state: input.state,
      scope: scopes.join(' '),
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
      codeChallenge: input.codeChallenge!,
      codeChallengeMethod: 'S256' as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + AUTHREQ_TTL_MS).toISOString(),
    })
  }

  /** 授权页公开查询（不泄露 redirect_uri / secret 等内部字段）。 */
  authRequestInfo(reqId: string): { clientName: string; appRef?: { id: string; name: string }; scope: string; consentRequired: boolean } {
    const req = this.authRequests().get(reqId)
    if (!req || req.consumedAt || new Date(req.expiresAt).getTime() < Date.now()) {
      throw new Error(t('授权请求无效、已使用或已过期'))
    }
    const client = this.clientByClientId(req.clientId)
    if (!client || !OidcService.isClientActive(client)) throw new Error(t('OIDC 客户端不可用'))
    const appRef = client.refType === 'app' && client.refId
      ? (() => {
          const app = this.ctx.resourceCore?.get('app', client.refId!)
          return app ? { id: app.id, name: app.name } : undefined
        })()
      : undefined
    return {
      clientName: client.name,
      ...(appRef !== undefined ? { appRef } : {}),
      scope: req.scope,
      consentRequired: client.consentRequired === true,
    }
  }

  /**
   * 授权页确认（POST /api/authn/oidc/authorize，human-only）：
   * 校验授权请求 →（需要同意时必须显式 consent）→ 签发一次性 code → 返回回跳地址。
   * consent 显式为 false → access_denied 回跳 + denied 事件；缺省 → 400（未表达同意）。
   */
  completeAuthorization(input: { reqId: string; userId: string; consent?: boolean }, origin?: { headers: import('node:http').IncomingHttpHeaders }): { location: string } {
    const req = this.authRequests().get(input.reqId)
    if (!req) throw new Error(t('授权请求无效（reqId 错误或已被清理）'))
    if (req.consumedAt) throw new Error(t('授权请求已被使用（单次消费，防重放）'))
    if (new Date(req.expiresAt).getTime() < Date.now()) throw new Error(t('授权请求已过期，请从应用重新发起'))
    const client = this.clientByClientId(req.clientId)
    if (!client) throw new Error(t('授权请求指向的客户端不存在'))
    if (!OidcService.isClientActive(client)) throw new Error(t('OIDC 客户端已禁用，无法完成授权'))
    const user = this.ctx.iam.users().get(input.userId)
    if (!user) throw new Error(t('用户不存在'))
    if (user.status !== 'active') throw new Error(t('账号状态异常，无法授权'))
    if (client.consentRequired === true && input.consent !== true) {
      if (input.consent === undefined) throw new Error(t('该应用要求显式同意后才能授权'))
      // 显式拒绝：redirect_uri 已在白名单内，按 RFC 回跳 access_denied
      this.authRequests().update(req.id, { consumedAt: new Date().toISOString() })
      this.ctx.platformBus.emit(PlatformEvents.OidcAuthorizeDenied, {
        reqId: req.id, clientId: client.clientId, clientName: client.name, userId: user.id, userName: user.displayName,
      })
      return { location: withQuery(req.redirectUri, { error: 'access_denied', error_description: t('用户拒绝授权'), state: req.state }) }
    }
    const code = this.issueCode({ ...req, userId: user.id })
    this.authRequests().update(req.id, { consumedAt: new Date().toISOString() })
    this.ctx.platformBus.emit(PlatformEvents.OidcAuthorizeGranted, {
      reqId: req.id, clientId: client.clientId, clientName: client.name, userId: user.id, userName: user.displayName, scope: req.scope,
    })
    // iss 回跳参数（RFC 9207 防 mix-up）——#15：按请求面派生，与 discovery 一致
    return { location: withQuery(req.redirectUri, { code, state: req.state, iss: this.issuer(origin) }) }
  }

  private issueCode(req: { clientId: string; userId: string; redirectUri: string; state: string; scope: string; nonce?: string; codeChallenge: string }): string {
    const code = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
    this.codes().insert({
      id: code,
      clientId: req.clientId,
      userId: req.userId,
      redirectUri: req.redirectUri,
      state: req.state,
      ...(req.nonce !== undefined ? { nonce: req.nonce } : {}),
      scope: req.scope,
      codeChallenge: req.codeChallenge,
      codeChallengeMethod: 'S256' as const,
      expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    })
    return code
  }

  // -- 换牌 / 刷新 -----------------------------------------------------------

  /** 客户端认证：Basic 与 Post 双形态；public 客户端免 secret。失败计入暴力破解锁定。 */
  private authenticateClient(clientId: string | undefined, clientSecret: string | undefined): OidcClientRecord {
    const invalidClient = (description: string): OidcEndpointError =>
      new OidcEndpointError(401, 'invalid_client', description, { 'www-authenticate': 'Basic realm="dsh-ops-oidc"' })
    if (!clientId) throw invalidClient(t('缺少 client_id'))
    const client = this.clientByClientId(clientId)
    if (!client) throw invalidClient(t('client_id 不存在：{clientId}', { clientId }))
    if (!OidcService.isClientActive(client)) throw invalidClient(t('OIDC 客户端已禁用'))
    if ((client.clientType ?? 'confidential') === 'confidential') {
      if (!clientSecret) throw invalidClient(t('缺少 client_secret'))
      if (client.clientSecretHash !== sha256Hex(clientSecret)) {
        // client_secret 同样纳入失败锁定（不得暴力猜测机密）
        this.ctx.authn.recordLoginFailure(`oidc-token:${clientId}`)
        throw invalidClient(t('client_secret 错误'))
      }
    }
    this.ctx.authn.recordLoginSuccess(`oidc-token:${clientId}`)
    return client
  }

  /**
   * /oauth/token：authorization_code（PKCE 强制校验、code 单次消费）与 refresh_token（轮转 + 重放整链吊销）。
   */
  token(input: {
    grantType: string
    clientId?: string
    clientSecret?: string
    code?: string
    redirectUri?: string
    codeVerifier?: string
    refreshToken?: string
    scope?: string
  }, origin?: { headers: import('node:http').IncomingHttpHeaders }): { access_token: string; id_token: string; token_type: 'Bearer'; expires_in: number; scope: string; refresh_token?: string } {
    const client = this.authenticateClient(input.clientId, input.clientSecret)
    if (input.grantType === 'authorization_code') return this.authorizationCodeGrant(client, input, origin)
    if (input.grantType === 'refresh_token') return this.refreshGrant(client, input, origin)
    throw new OidcEndpointError(400, 'unsupported_grant_type', t('不支持的 grant_type：{grantType}', { grantType: input.grantType }))
  }

  private authorizationCodeGrant(client: OidcClientRecord, input: { code?: string; redirectUri?: string; codeVerifier?: string }, origin?: { headers: import('node:http').IncomingHttpHeaders }): ReturnType<OidcService['issueTokenSet']> {
    const bad = (description: string): OidcEndpointError => new OidcEndpointError(400, 'invalid_grant', description)
    if (!input.code) throw new OidcEndpointError(400, 'invalid_request', t('code 必填'))
    const record = this.codes().get(input.code)
    if (!record) throw bad(t('授权码无效'))
    if (record.usedAt) throw bad(t('授权码已被使用（单次消费，防重放）'))
    if (new Date(record.expiresAt).getTime() < Date.now()) throw bad(t('授权码已过期'))
    if (record.clientId !== client.clientId) throw bad(t('授权码与客户端不匹配'))
    if (input.redirectUri && input.redirectUri !== record.redirectUri) throw bad(t('redirect_uri 与授权时不一致'))
    // PKCE（S256）：BASE64URL(SHA256(code_verifier)) 必须与授权时登记的 challenge 一致
    if (!record.codeChallenge) throw bad(t('授权未登记 PKCE challenge'))
    if (!input.codeVerifier) throw bad(t('授权使用了 PKCE，token 请求必须携带 code_verifier'))
    const derived = createHash('sha256').update(input.codeVerifier).digest('base64url')
    if (derived !== record.codeChallenge) throw bad(t('PKCE 校验失败：code_verifier 不匹配'))
    this.codes().update(record.id, { usedAt: new Date().toISOString() })
    const user = this.ctx.iam.users().get(record.userId)
    if (!user || user.status !== 'active') throw bad(t('用户状态异常，无法签发令牌'))
    return this.issueTokenSet(client, { userId: record.userId, scope: record.scope, ...(record.nonce !== undefined ? { nonce: record.nonce } : {}) }, origin)
  }

  private refreshGrant(client: OidcClientRecord, input: { refreshToken?: string; scope?: string }, origin?: { headers: import('node:http').IncomingHttpHeaders }): ReturnType<OidcService['issueTokenSet']> {
    const bad = (description: string): OidcEndpointError => new OidcEndpointError(400, 'invalid_grant', description)
    if (!input.refreshToken) throw new OidcEndpointError(400, 'invalid_request', t('refresh_token 必填'))
    if ((client.clientType ?? 'confidential') === 'public') throw bad(t('public 客户端不签发 refresh token'))
    const hash = sha256Hex(input.refreshToken)
    const record = this.refreshTokens().findOne((item) => item.tokenHash === hash)
    if (!record || record.clientId !== client.clientId) throw bad(t('refresh token 无效'))
    if (record.revokedAt) throw bad(t('refresh token 已吊销：{reason}', { reason: record.revokedReason ?? '' }))
    if (new Date(record.expiresAt).getTime() < Date.now()) throw bad(t('refresh token 已过期，请重新授权'))
    if (record.rotatedAt) {
      this.revokeRefreshChain(record.chainId, t('refresh token 重放检测（原轮转于 {at}）', { at: record.rotatedAt }))
      throw bad(t('检测到 refresh token 重放：该授权链已整体吊销，请重新发起授权'))
    }
    // 安全必需：换发实时校验用户状态（冻结/离职即时失效，无需等过期）
    const user = this.ctx.iam.users().get(record.userId)
    if (!user || user.status !== 'active') throw bad(t('用户状态异常（冻结/离职联动失效）'))
    // scope 只允许收窄
    const granted = record.scope.split(/\s+/).filter(Boolean)
    const requested = input.scope !== undefined ? input.scope.split(/\s+/).filter(Boolean) : granted
    const widened = requested.find((scope) => !granted.includes(scope))
    if (widened) throw new OidcEndpointError(400, 'invalid_scope', t('refresh 只允许收窄 scope：{scopes} 未在原授权范围内', { scopes: widened }))
    const scope = requested.join(' ')
    this.refreshTokens().update(record.id, { rotatedAt: new Date().toISOString() })
    const tokenSet = this.issueTokenSet(client, { userId: record.userId, scope, chainId: record.chainId }, origin)
    return tokenSet
  }

  private issueTokenSet(client: OidcClientRecord, granted: { userId: string; scope: string; nonce?: string; chainId?: string }, origin?: { headers: import('node:http').IncomingHttpHeaders }): { access_token: string; id_token: string; token_type: 'Bearer'; expires_in: number; scope: string; refresh_token?: string } {
    const nowSec = Math.floor(Date.now() / 1000)
    const user = this.ctx.iam.users().get(granted.userId)
    const payload = {
      // #15：iss 按请求面派生（env 显式声明优先），与 discovery 对齐
      iss: this.issuer(origin),
      sub: granted.userId,
      aud: client.clientId,
      azp: client.clientId,
      iat: nowSec,
      exp: nowSec + ACCESS_TTL_SECONDS,
      jti: randomUUID(),
      scope: granted.scope,
      ...(granted.nonce !== undefined ? { nonce: granted.nonce } : {}),
      ...(user !== undefined ? { preferred_username: user.username, name: user.displayName } : {}),
    }
    // token 类型区分（收敛面：access/id 同构时代 userinfo 无法分辨，外发前必须打标）
    const access = this.signJwt({ ...payload, token_use: 'access' })
    const idToken = this.signJwt({ ...payload, token_use: 'id' })
    const result: { access_token: string; id_token: string; token_type: 'Bearer'; expires_in: number; scope: string; refresh_token?: string } = {
      access_token: access,
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      scope: granted.scope,
    }
    if ((client.clientType ?? 'confidential') === 'confidential') {
      // refresh 仅存哈希；otr_ 明文只出现这一次；同 chain 轮转（重放检测按链吊销）
      const refreshRaw = 'otr_' + randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
      this.refreshTokens().insert({
        id: newId('ort'),
        clientId: client.clientId,
        userId: granted.userId,
        scope: granted.scope,
        tokenHash: sha256Hex(refreshRaw),
        chainId: granted.chainId ?? newId('rchain'),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString(),
      })
      result.refresh_token = refreshRaw
    }
    return result
  }

  // -- 吊销面 ---------------------------------------------------------------

  revokeRefreshChain(chainId: string, reason: string): number {
    let count = 0
    for (const record of this.refreshTokens().find((item) => item.chainId === chainId && !item.revokedAt)) {
      this.refreshTokens().update(record.id, { revokedAt: new Date().toISOString(), revokedReason: reason })
      count++
    }
    return count
  }

  revokeUserRefreshChains(userId: string, reason: string): number {
    let count = 0
    for (const record of this.refreshTokens().find((item) => item.userId === userId && !item.revokedAt)) {
      this.refreshTokens().update(record.id, { revokedAt: new Date().toISOString(), revokedReason: reason })
      count++
    }
    return count
  }

  private revokeClientRefreshChains(clientId: string, reason: string): number {
    let count = 0
    for (const record of this.refreshTokens().find((item) => item.clientId === clientId && !item.revokedAt)) {
      this.refreshTokens().update(record.id, { revokedAt: new Date().toISOString(), revokedReason: reason })
      count++
    }
    return count
  }

  /** RFC 7009 /oauth/revoke：access（jti 黑名单）或 refresh（整链）；恒 200。 */
  revokeToken(input: { clientId?: string; clientSecret?: string; token?: string; tokenTypeHint?: string }, origin?: { headers: import('node:http').IncomingHttpHeaders }): void {
    const client = this.authenticateClient(input.clientId, input.clientSecret)
    if (!input.token) return
    if (input.token.startsWith('otr_') || input.tokenTypeHint === 'refresh_token') {
      const hash = sha256Hex(input.token)
      const record = this.refreshTokens().findOne((item) => item.tokenHash === hash)
      if (record && record.clientId === client.clientId) this.revokeRefreshChain(record.chainId, t('客户端主动吊销（RFC 7009）'))
      return
    }
    try {
      const claims = this.verifyJwt(input.token, { audience: undefined, ...(origin !== undefined ? { origin } : {}) })
      if (claims.aud !== client.clientId) return
      this.deniedJtis().insert({
        id: newId('odj'),
        jti: String(claims.jti ?? ''),
        expiresAt: new Date((typeof claims.exp === 'number' ? claims.exp : Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        reason: t('客户端主动吊销（RFC 7009）'),
      })
    } catch { /* 无法解析的 token：按 RFC 恒 200 静默 */ }
  }

  private isJtiDenied(jti: unknown): boolean {
    if (typeof jti !== 'string' || !jti) return false
    const record = this.deniedJtis().findOne((item) => item.jti === jti)
    return record !== undefined && new Date(record.expiresAt).getTime() > Date.now()
  }

  // -- RP 发起登出 -----------------------------------------------------------

  /**
   * GET /oauth/end_session：验签 id_token_hint 定位 client → 吊销该用户在该 client 下的
   * refresh 链 → 回跳地址命中 postLogoutUris → 302 平台登出页（页面清会话后带 state 跳回）。
   * 未携带 post_logout_redirect_uri 时（轻量 RP 只传 id_token_hint），若该 client 仅登记了
   * 一个登出回跳地址，按其登记意图回跳——仍受白名单约束，显式传参非法依旧拒绝（防开放重定向）。
   */
  endSession(input: { idTokenHint?: string; postLogoutRedirectUri?: string; state?: string }, origin?: { headers: import('node:http').IncomingHttpHeaders }): { location: string } {
    if (!input.idTokenHint) throw new OidcEndpointError(302, 'invalid_request', t('缺少 id_token_hint'))
    let claims: Record<string, unknown>
    try {
      claims = this.verifyJwt(input.idTokenHint, { audience: undefined, ...(origin !== undefined ? { origin } : {}) })
    } catch (error) {
      throw new OidcEndpointError(302, 'invalid_request', t('id_token_hint 验签失败：{message}', { message: error instanceof Error ? error.message : String(error) }))
    }
    const client = this.clientByClientId(String(claims.aud ?? ''))
    if (!client) throw new OidcEndpointError(302, 'invalid_request', t('id_token_hint 受众（aud）未命中已登记客户端'))
    // 登出即断静默续期：吊销该用户在该 client 下的全部 refresh 链
    const userId = String(claims.sub ?? '')
    for (const record of this.refreshTokens().find((item) => item.clientId === client.clientId && item.userId === userId && !item.revokedAt)) {
      this.refreshTokens().update(record.id, { revokedAt: new Date().toISOString(), revokedReason: t('RP 发起登出联动') })
    }
    // 平台 SPA 内部跳转：query 收敛在 hash 内（与控制台路由约定一致）
    const logoutParams = new URLSearchParams({
      ...(input.postLogoutRedirectUri !== undefined ? { post_logout_redirect_uri: input.postLogoutRedirectUri } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      client: client.name,
    })
    const logoutPage = `${this.webBase()}/#/oauth/logout?${logoutParams.toString()}`
    const whitelist = client.postLogoutUris ?? []
    if (input.postLogoutRedirectUri === undefined) {
      // RP 未传回跳参数：仅登记唯一登出地址时按登记意图回跳；未登记或多个候选则停留平台登出页
      if (whitelist.length === 1) {
        logoutParams.set('post_logout_redirect_uri', whitelist[0]!)
        return { location: `${this.webBase()}/#/oauth/logout?${logoutParams.toString()}` }
      }
      return { location: logoutPage }
    }
    if (!whitelist.includes(input.postLogoutRedirectUri)) {
      // 非法回跳：只回平台错误页，绝不开放重定向
      throw new OidcEndpointError(302, 'invalid_request', t('post_logout_redirect_uri 未登记在客户端登出白名单'))
    }
    return { location: logoutPage }
  }

  // -- userinfo ---------------------------------------------------------------

  /** userinfo：仅接受 access token（token_use 校验）+ aud 必须命中有效 client + 用户实时状态；origin 提供时 iss 同步接受请求面派生值（#15）。 */
  userinfo(accessToken: string, origin?: { headers: import('node:http').IncomingHttpHeaders }): Record<string, unknown> {
    const claims = this.verifyJwt(accessToken, { audience: undefined, ...(origin !== undefined ? { origin } : {}) })
    if (claims.token_use !== 'access') throw new Error(t('该端点仅接受 access token（id_token 不能直接调 userinfo）'))
    const client = this.clientByClientId(String(claims.aud ?? ''))
    if (!client || !OidcService.isClientActive(client)) throw new Error(t('token 受众（aud）不是有效客户端'))
    if (this.isJtiDenied(claims.jti)) throw new Error(t('token 已被吊销（RFC 7009）'))
    const user = this.ctx.iam.users().get(claims.sub ?? '')
    if (!user) throw new Error(t('用户不存在'))
    if (user.status !== 'active') throw new Error(t('用户状态异常（冻结/离职联动失效）'))
    const org = this.ctx.iam.orgs().get(user.orgId)
    const scopes = String(claims.scope ?? '').split(/\s+/)
    return {
      sub: user.id,
      preferred_username: user.username,
      name: user.displayName,
      // email claim 按 scope 裁剪（未申请 email scope 不外发）
      ...(scopes.includes('email') && user.email ? { email: user.email } : {}),
      org: org !== undefined ? { id: org.id, name: org.name, tenantId: org.tenantId ?? 't_default' } : null,
      roles: user.roleIds.map((roleId) => this.ctx.iam.roles().get(roleId)?.code).filter(Boolean),
      tenant: org?.tenantId ?? 't_default',
      scope: claims.scope,
    }
  }

  // -- JWT（RS256，数组化 JWKS） ----------------------------------------------

  signJwt(payload: Record<string, unknown>): string {
    const key = this.activeKey()
    const header = { alg: 'RS256', typ: 'JWT', kid: key.kid }
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const head = Buffer.from(JSON.stringify(header)).toString('base64url')
    const signature = rsSign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privatePem).toString('base64url')
    return `${head}.${body}.${signature}`
  }

  /** 签名恒用最新 key；验签按 header.kid 在数组（含宽限期内的退役 key）中匹配。 */
  private activeKey(): OidcKeyMaterial {
    const alive = this.keys.filter((key) => key.retiredAt === undefined || Date.now() - new Date(key.retiredAt).getTime() < KEY_GRACE_MS)
    const candidates = alive.filter((key) => key.retiredAt === undefined)
    return candidates[0] ?? alive[0]!
  }

  /**
   * JWT 校验：签名 + header.kid 匹配 JWKS 公布密钥 + iss 归属本 Provider + exp 有效；
   * options.audience 指定时校验受众（azp/aud 必须命中）；
   * options.origin 指定时 iss 同时接受请求面派生值（#15：公网域名签发的令牌在同域名校验通过）。
   */
  verifyJwt(token: string, options: { audience?: string; origin?: { headers: import('node:http').IncomingHttpHeaders } } = {}): Record<string, unknown> {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error(t('JWT 格式不合法'))
    let header: Record<string, unknown>
    try {
      header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>
    } catch {
      throw new Error(t('JWT 头部解析失败'))
    }
    const key = this.keys.find((item) => item.kid === header.kid)
    if (!key) throw new Error(t('JWT kid 与 JWKS 公布密钥不匹配'))
    if (key.retiredAt !== undefined && Date.now() - new Date(key.retiredAt).getTime() >= KEY_GRACE_MS) {
      throw new Error(t('JWT 签名密钥已过宽限期'))
    }
    const valid = rsVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key.publicPem, Buffer.from(parts[2]!, 'base64url'))
    if (!valid) throw new Error(t('JWT 签名校验失败（RS256）'))
    let claims: Record<string, unknown>
    try {
      claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    } catch {
      throw new Error(t('JWT 载荷解析失败'))
    }
    if (!this.acceptedIssuers(options.origin).includes(String(claims.iss ?? ''))) throw new Error(t('JWT 签发方（iss）校验失败'))
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new Error(t('JWT 已过期'))
    if (options.audience !== undefined) {
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
      if (!aud.includes(options.audience)) throw new Error(t('JWT 受众（aud）校验失败：期望 {expected}', { expected: options.audience }))
    }
    return claims
  }

  jwks(): { keys: Array<Record<string, unknown>> } {
    // 宽限期内的退役 key 保留公布（在途验签不掉线），过宽限即从 JWKS 撤下
    const published = this.keys.filter((key) => key.retiredAt === undefined || Date.now() - new Date(key.retiredAt).getTime() < KEY_GRACE_MS)
    return { keys: published.map((key) => {
      const jwk = createPublicKey(key.publicPem).export({ format: 'jwk' }) as { kty: string; n?: string; e?: string }
      return {
        kty: jwk.kty,
        use: 'sig',
        alg: 'RS256',
        kid: key.kid,
        n: jwk.n,
        e: jwk.e,
      }
    }) }
  }

  /** 管理端密钥轮换：新 key 立即承担签名，旧 key 进入 24h 验签宽限。 */
  rotateKeys(): { graceHours: number; kid: string } {
    const now = new Date().toISOString()
    this.keys = this.keys.map((key) => (key.retiredAt === undefined ? { ...key, retiredAt: now } : key))
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const material: OidcKeyMaterial = {
      privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      kid: createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 16),
      createdAt: now,
    }
    this.keys = [material, ...this.keys]
    this.saveKeys()
    return { graceHours: KEY_GRACE_MS / 3600_000, kid: material.kid }
  }

  discovery(origin?: { headers: import('node:http').IncomingHttpHeaders }): Record<string, unknown> {
    const issuer = this.issuer(origin)
    return {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      userinfo_endpoint: `${issuer}/oauth/userinfo`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      end_session_endpoint: `${issuer}/oauth/end_session`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: [...OidcService.ALLOWED_SCOPES],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      claims_supported: ['sub', 'name', 'preferred_username', 'iss', 'aud', 'exp', 'iat', 'jti', 'nonce', 'email'],
    }
  }

  /** 过期记录清理（对齐 M2 惯例：过期 7 天后物理删除，不无限累积）。 */
  private cleanupExpired(): number {
    const cutoff = Date.now() - 7 * 24 * 3600_000
    let removed = 0
    for (const record of this.authRequests().all()) {
      if (new Date(record.expiresAt).getTime() < cutoff && this.authRequests().remove(record.id)) removed++
    }
    for (const record of this.codes().all()) {
      if (new Date(record.expiresAt).getTime() < cutoff && this.codes().remove(record.id)) removed++
    }
    for (const record of this.refreshTokens().all()) {
      if (new Date(record.expiresAt).getTime() < cutoff && this.refreshTokens().remove(record.id)) removed++
    }
    for (const record of this.deniedJtis().all()) {
      if (new Date(record.expiresAt).getTime() < cutoff && this.deniedJtis().remove(record.id)) removed++
    }
    // 过宽限期的退役密钥从数组中清出（文件同步收敛）
    const before = this.keys.length
    this.keys = this.keys.filter((key) => key.retiredAt === undefined || Date.now() - new Date(key.retiredAt).getTime() < KEY_GRACE_MS)
    if (this.keys.length !== before) this.saveKeys()
    return removed
  }

  private loadOrCreateKeys(): OidcKeyMaterial[] {
    const file = join(this.ctx.opsStorage.dataDirPath, 'oidc-keys.json')
    const fresh = (): OidcKeyMaterial => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      return {
        privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        kid: createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 16),
        createdAt: new Date().toISOString(),
      }
    }
    try {
      if (existsSync(file)) {
        const stored = JSON.parse(readFileSync(file, 'utf8')) as unknown
        // 旧单 key 文件自动包装为数组（零停机迁移）
        const list = Array.isArray((stored as { keys?: unknown }).keys)
          ? (stored as { keys: OidcKeyMaterial[] }).keys
          : [stored as OidcKeyMaterial]
        const valid = list.filter((item) => item && item.privatePem && item.publicPem && item.kid)
        if (valid.length > 0) return valid
      }
      mkdirSync(this.ctx.opsStorage.dataDirPath, { recursive: true })
      const material = fresh()
      writeFileSync(file, JSON.stringify({ keys: [material] }, null, 2), { encoding: 'utf8', mode: 0o600 })
      return [material]
    } catch {
      // 目录不可写等异常：进程内密钥（重启后令牌失效，仅限异常场景）
      return [fresh()]
    }
  }

  private saveKeys(): void {
    try {
      const file = join(this.ctx.opsStorage.dataDirPath, 'oidc-keys.json')
      writeFileSync(file, JSON.stringify({ keys: this.keys }, null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      console.error('[oidc] 密钥文件落盘失败（仅影响轮换持久化）', error)
    }
  }

  // -- 协议端点 ---------------------------------------------------------------

  /**
   * CORS 允许来源：已登记客户端 redirect_uri 的 origin ∪ OIDC_CORS_ORIGINS（逗号分隔显式清单）。
   * 收敛在已登记来源内——未登记站点的页面拿不到放行头；code 本身绑定 redirect_uri，双重兜底。
   */
  private allowedCorsOrigins(): Set<string> {
    const origins = new Set<string>(
      String(process.env.OIDC_CORS_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    )
    for (const client of this.clients().all()) {
      for (const uri of client.redirectUris ?? []) {
        try { origins.add(new URL(uri).origin) } catch { /* 非法 redirect_uri 不参与 CORS 判定 */ }
      }
    }
    return origins
  }

  /** 按 Origin 头生成放行头；无 Origin（非浏览器调用）不发放，未登记来源仅回 vary。 */
  private corsHeaders(exchange: { headers: import('node:http').IncomingHttpHeaders }): Record<string, string> {
    const header = exchange.headers['origin']
    const origin = Array.isArray(header) ? header[0] : header
    if (!origin) return {}
    if (!this.allowedCorsOrigins().has(origin)) return { vary: 'Origin' }
    return { vary: 'Origin', 'access-control-allow-origin': origin }
  }

  /** 公开端点（非 /api/*：不受控制台 Bearer 中间件约束，属 OIDC 协议要求）。 */
  private registerRoutes(): void {
    const http = this.ctx.httpServer
    // OIDC 协议端点返回原始 JSON（标准客户端不识别平台的 {ok,data} 包裹）；成功/错误一律合并 CORS 放行头
    const raw = (exchange: { res: import('node:http').ServerResponse; headers: import('node:http').IncomingHttpHeaders }, status: number, payload: unknown, extra: Record<string, string> = {}): void => {
      exchange.res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...this.corsHeaders(exchange), ...extra })
      exchange.res.end(JSON.stringify(payload))
    }
    const redirect = (exchange: { res: import('node:http').ServerResponse }, location: string): void => {
      exchange.res.writeHead(302, { location })
      exchange.res.end()
    }
    const clientIp = (exchange: { raw: import('node:http').IncomingMessage }): string =>
      String(exchange.raw.socket?.remoteAddress ?? 'unknown')

    // -- CORS 预检：纯前端（public + PKCE）客户端跨域直调的端点，统一 204 应答 ------
    const preflight = (exchange: { res: import('node:http').ServerResponse; headers: import('node:http').IncomingHttpHeaders }): void => {
      exchange.res.writeHead(204, {
        ...this.corsHeaders(exchange),
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
      })
      exchange.res.end()
    }
    for (const pattern of ['/oauth/token', '/oauth/userinfo', '/oauth/revoke', '/.well-known/openid-configuration', '/.well-known/jwks.json']) {
      http.register('OPTIONS', pattern, preflight)
    }

    http.register('GET', '/.well-known/openid-configuration', (exchange) => {
      raw(exchange, 200, this.discovery(exchange))
    })

    http.register('GET', '/.well-known/jwks.json', (exchange) => {
      raw(exchange, 200, this.jwks())
    })

    // -- 浏览器授权流第一跳：校验 → 落授权请求 → 302 平台授权页 --------------------
    http.register('GET', '/oauth/authorize', (exchange) => {
      const q = exchange.query
      // 按来源 IP 基础限流（复用登录锁定骨架，收敛客户端探测面）
      const throttleKey = `oidc-authorize-ip:${clientIp(exchange)}`
      try {
        this.ctx.authn.assertNotLocked(throttleKey)
        const req = this.beginAuthorization({
          responseType: q.get('response_type') ?? undefined,
          clientId: q.get('client_id') ?? undefined,
          redirectUri: q.get('redirect_uri') ?? undefined,
          state: q.get('state') ?? undefined,
          scope: q.get('scope') ?? undefined,
          nonce: q.get('nonce') ?? undefined,
          codeChallenge: q.get('code_challenge') ?? undefined,
          codeChallengeMethod: q.get('code_challenge_method') ?? undefined,
        })
        redirect(exchange, `${this.webBase()}/#/oauth/authorize?req=${encodeURIComponent(req.id)}`)
      } catch (error) {
        const err = error instanceof OidcEndpointError
          ? error
          : new OidcEndpointError(302, 'access_denied', error instanceof Error ? error.message : String(error))
        // client_id / redirect_uri 探测形态计入失败（锁定暴力枚举）
        if (err.error === 'unauthorized_client' || err.message.includes('redirect_uri')) {
          try { this.ctx.authn.recordLoginFailure(throttleKey) } catch { /* 锁定信息写入失败不阻断错误回显 */ }
        }
        redirect(exchange, `${this.webBase()}/#/oauth/error?error=${encodeURIComponent(err.error)}&error_description=${encodeURIComponent(err.message)}`)
      }
    })

    // -- 授权页公开查询（仅客户端名/scope，不泄露 redirect_uri） --------------------
    http.register('GET', '/api/authn/oidc/auth-requests/:id', (exchange) => {
      try {
        raw(exchange, 200, this.authRequestInfo(exchange.params['id']!))
      } catch (error) {
        raw(exchange, 404, { error: 'invalid_request', error_description: error instanceof Error ? error.message : String(error) })
      }
    }, { access: 'public', selfValidated: true })

    // -- 授权页确认（Bearer；human-only，机器 principal 一律 403） ------------------
    http.register('POST', '/api/authn/oidc/authorize', async (exchange) => {
      const input = (exchange.body ?? {}) as { reqId?: string; consent?: boolean }
      const info = exchange.principal as { kind?: string; userId?: string } | undefined
      if (!info) {
        raw(exchange, 401, { error: 'invalid_request', error_description: t('缺少 Bearer 会话，请先登录平台') })
        return
      }
      if (info.kind !== 'human' || !info.userId) {
        raw(exchange, 403, { error: 'invalid_request', error_description: t('授权确认仅限登录用户（human），机器身份不可代替用户授权') })
        return
      }
      if (!input.reqId) {
        raw(exchange, 400, { error: 'invalid_request', error_description: t('reqId 必填') })
        return
      }
      try {
        const result = this.completeAuthorization({ reqId: input.reqId, userId: info.userId, ...(input.consent !== undefined ? { consent: input.consent } : {}) }, exchange)
        raw(exchange, 200, result)
      } catch (error) {
        raw(exchange, 400, { error: 'consent_required', error_description: error instanceof Error ? error.message : String(error) })
      }
    }, { access: 'authenticated' })

    // -- 换牌：client_secret_basic + client_secret_post；form-encoded 与 JSON 双编码 --
    http.register('POST', '/oauth/token', async (exchange) => {
      const bodyInput = (exchange.body ?? {}) as Record<string, string>
      // Basic 认证：Authorization: Basic base64(urlencode(client_id):urlencode(client_secret))
      const authHeader = String(exchange.headers['authorization'] ?? '')
      let basicId: string | undefined
      let basicSecret: string | undefined
      if (authHeader.startsWith('Basic ')) {
        try {
          const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8')
          const idx = decoded.indexOf(':')
          basicId = decodeURIComponent(decoded.slice(0, idx))
          basicSecret = decodeURIComponent(decoded.slice(idx + 1))
        } catch { /* 畸形 Basic 头按缺失处理 */ }
      }
      try {
        const result = this.token({
          grantType: bodyInput['grant_type'] ?? 'authorization_code',
          clientId: basicId ?? bodyInput['client_id'],
          clientSecret: basicSecret ?? bodyInput['client_secret'],
          ...(bodyInput['code'] !== undefined ? { code: bodyInput['code'] } : {}),
          ...(bodyInput['redirect_uri'] !== undefined ? { redirectUri: bodyInput['redirect_uri'] } : {}),
          ...(bodyInput['code_verifier'] !== undefined ? { codeVerifier: bodyInput['code_verifier'] } : {}),
          ...(bodyInput['refresh_token'] !== undefined ? { refreshToken: bodyInput['refresh_token'] } : {}),
          ...(bodyInput['scope'] !== undefined ? { scope: bodyInput['scope'] } : {}),
        }, exchange)
        raw(exchange, 200, result, { 'cache-control': 'no-store', pragma: 'no-cache' })
      } catch (error) {
        const err = error instanceof OidcEndpointError
          ? error
          : new OidcEndpointError(400, 'invalid_grant', error instanceof Error ? error.message : String(error))
        raw(exchange, err.status, { error: err.error, error_description: err.message }, err.headers)
      }
    })

    // -- userinfo（RFC 6750：401 带 WWW-Authenticate: Bearer） ----------------------
    http.register('GET', '/oauth/userinfo', (exchange) => {
      const header = String(exchange.headers['authorization'] ?? '')
      // 头部仅允许 ASCII：描述文案做百分号编码，原文保留在 JSON 响应体
      const headerSafe = (text: string): string => encodeURIComponent(text).replace(/"/g, '%22')
      const deny = (description: string): void => {
        raw(exchange, 401, { error: 'invalid_token', error_description: description }, { 'www-authenticate': `Bearer error="invalid_token", error_description="${headerSafe(description)}"` })
      }
      if (!header.startsWith('Bearer ')) {
        raw(exchange, 401, { error: 'invalid_token', error_description: t('缺少 Bearer access token') }, { 'www-authenticate': 'Bearer' })
        return
      }
      try {
        raw(exchange, 200, this.userinfo(header.slice(7), exchange))
      } catch (error) {
        deny(error instanceof Error ? error.message : String(error))
      }
    })

    // -- RP 发起登出（OIDC Front-Channel / RP-Initiated Logout 最小实现） ----------
    http.register('GET', '/oauth/end_session', (exchange) => {
      const q = exchange.query
      try {
        const result = this.endSession({
          idTokenHint: q.get('id_token_hint') ?? undefined,
          postLogoutRedirectUri: q.get('post_logout_redirect_uri') ?? undefined,
          state: q.get('state') ?? undefined,
        }, exchange)
        redirect(exchange, result.location)
      } catch (error) {
        const err = error instanceof OidcEndpointError
          ? error
          : new OidcEndpointError(302, 'invalid_request', error instanceof Error ? error.message : String(error))
        redirect(exchange, `${this.webBase()}/#/oauth/error?error=${encodeURIComponent(err.error)}&error_description=${encodeURIComponent(err.message)}`)
      }
    })

    // -- 令牌吊销（RFC 7009：恒 200，未知 token 静默成功） --------------------------
    http.register('POST', '/oauth/revoke', async (exchange) => {
      const bodyInput = (exchange.body ?? {}) as Record<string, string>
      const authHeader = String(exchange.headers['authorization'] ?? '')
      let basicId: string | undefined
      let basicSecret: string | undefined
      if (authHeader.startsWith('Basic ')) {
        try {
          const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8')
          const idx = decoded.indexOf(':')
          basicId = decodeURIComponent(decoded.slice(0, idx))
          basicSecret = decodeURIComponent(decoded.slice(idx + 1))
        } catch { /* 畸形 Basic 头按缺失处理 */ }
      }
      try {
        this.revokeToken({
          clientId: basicId ?? bodyInput['client_id'],
          clientSecret: basicSecret ?? bodyInput['client_secret'],
          token: bodyInput['token'],
          tokenTypeHint: bodyInput['token_type_hint'],
        }, exchange)
        raw(exchange, 200, {})
      } catch (error) {
        const err = error instanceof OidcEndpointError
          ? error
          : new OidcEndpointError(400, 'unsupported_token_type', error instanceof Error ? error.message : String(error))
        raw(exchange, err.status, { error: err.error, error_description: err.message }, err.headers)
      }
    })
  }
}

/** 拼接回跳地址（保留已有 query；RFC 9207 的 iss / error 均走此处；仅用于绝对地址）。 */
function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    oidc: OidcService
  }
}
