/**
 * OcClient —— open-connector v1.4.0 薄适配客户端（契约锁定隔离层）。
 *
 * 全仓唯一感知上游 HTTP 契约的位置；升级 sidecar 版本前先跑 selftest 契约锁定测试组（T-01）。
 * 契约面（计划书 §2.3 表逐条对应）：
 *   GET  /v1/health                        探活 {success,data:{ok,runtime}}
 *   GET  /v1/providers                     provider 目录
 *   GET  /v1/actions[?service=]            action 目录（含 requiredScopes/providerPermissions/inputSchema）
 *   GET  /v1/actions/:actionId             action 详情
 *   GET  /api/actions/:actionId/agent.md   连接向导指南（admin 接口，文本）
 *   PUT/DELETE /api/connections/:service    连接管理（GET /api/connections 列表）
 *   POST /api/oauth/authorizations         OAuth 发起 → {authorizationUrl, state}
 *   POST/GET/PUT/DELETE /api/runtime-tokens oct_ 运行时令牌（值仅创建时返回一次）
 *   POST /v1/actions/:actionId             数据面执行（Bearer oct_ + x-oo-connector-alias + Idempotency-Key）
 *   GET  /api/runs                         run 日志（cursor 分页 + runtimeTokenId 过滤）
 *
 * 统一信封：成功 { success:true, data, meta }；失败 { success:false, errorCode }。
 * 上游文档未载项（如实声明）：PUT connections 与 POST authorizations 的成功状态码未载——
 * 按默认 200 处理并断言信封 success:true。
 */
import { OcError, OcUnavailableError } from './errors.ts'
import { t } from '../../platform-i18n/src/index.ts'

export const OC_VERSION_PIN = 'v1.4.0'
const DEFAULT_TIMEOUT_MS = 15_000

/** ConnectionSummary 八字段（T-01 schema 断言依据）。 */
export interface OcConnectionSummary {
  id: string
  service: string
  connectionName: string
  authType?: string
  configured?: boolean
  virtual?: boolean
  default?: boolean
  profile?: Record<string, unknown>
}

export interface OcAuthorizationStart {
  authorizationUrl: string
  state: string
}

/** RuntimeTokenSummary：token 值仅在 createRuntimeToken 响应中出现一次。 */
export interface OcRuntimeTokenSummary {
  id: string
  name?: string
  token?: string
  policy?: OcTokenPolicy
  createdAt?: string
}

export type TokenPattern = '*' | string

/** 四数组策略：PUT 必须四个数组全发（不会丢既有 allowedConnections 限制）。 */
export interface OcTokenPolicy {
  allowedActions: TokenPattern[] | ['*']
  blockedActions: TokenPattern[]
  allowedProxies: TokenPattern[]
  allowedConnections: string[]
}

export interface OcRunLog {
  id: string
  service?: string
  actionId?: string
  ok?: boolean
  runtimeTokenId?: string
  caller?: string
  policy?: unknown
  startedAt?: string
  latencyMs?: number
  input?: unknown
  outputSummary?: unknown
  error?: string
}

export interface OcRunsPage {
  items: OcRunLog[]
  nextCursor?: string
}

export interface OcAction {
  id: string
  name?: string
  service?: string
  description?: string
  requiredScopes?: Array<unknown>
  providerPermissions?: Array<unknown>
  inputSchema?: Record<string, unknown>
  [key: string]: unknown
}

export interface OcProvider {
  service?: string
  name?: string
  description?: string
  auth?: Array<unknown>
  categories?: Array<unknown>
  [key: string]: unknown
}

export interface ExecuteOutcome {
  data: unknown
  meta: Record<string, unknown>
  raw: Record<string, unknown>
}

export class OcClient {
  private readonly baseUrl: string
  /** 管理面 Bearer（/api/*）；数据面 oct_ 由 executeAction 显式传入。 */
  private readonly adminToken: string
  private readonly timeoutMs: number

  constructor(baseUrl: string, adminToken: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl
    this.adminToken = adminToken
    this.timeoutMs = timeoutMs
  }

  // -- 公共请求基座 ---------------------------------------------------------

  private async request(path: string, init: { method?: string; body?: unknown; bearer?: string; timeoutMs?: number; acceptText?: boolean } = {}): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? this.timeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...((init.bearer ?? this.adminToken) ? { authorization: `Bearer ${init.bearer ?? this.adminToken}` } : {}),
          ...(init.acceptText ? { accept: 'text/plain' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      })
    } catch (error) {
      const message = error instanceof Error ? (error.name === 'AbortError' ? t('open-connector 响应超时（{timeout}ms）', { timeout: init.timeoutMs ?? this.timeoutMs }) : error.message) : String(error)
      throw new OcUnavailableError(t('连接器网关不可达：{reason}', { reason: message }))
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text().catch(() => '')
    if (init.acceptText && !text.startsWith('{')) {
      return { status: response.status, json: null, text }
    }
    let json: Record<string, unknown> | null = null
    if (text.trim().length > 0) {
      try {
        json = JSON.parse(text) as Record<string, unknown>
      } catch {
        throw new OcUnavailableError(t('open-connector 响应不是合法 JSON（HTTP {status}）：{body}', { status: response.status, body: text.slice(0, 120) }))
      }
    }
    return { status: response.status, json, text }
  }

  /** 信封解包：非 2xx 或 success:false 统一抛 OcError（错误码保留透传）。 */
  private async envelope(path: string, init: Parameters<OcClient['request']>[1] = {}): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    const { status, json, text } = await this.request(path, init)
    if (json === null) {
      throw new OcUnavailableError(t('open-connector 响应缺少 JSON 信封（HTTP {status}）：{path}', { status, path }))
    }
    if (json.success === false || status >= 400) {
      const code = String(json.errorCode ?? (json.error as Record<string, unknown> | undefined)?.code ?? `http_${status}`)
      throw new OcError(code, typeof json.message === 'string' ? json.message : t('{path} 失败：HTTP {status} {body}', { path, status, body: text.slice(0, 160) }), undefined, undefined)
    }
    return { data: json.data ?? null, meta: (json.meta && typeof json.meta === 'object' ? json.meta : {}) as Record<string, unknown> }
  }

  // -- 健康与目录 -----------------------------------------------------------

  async health(): Promise<{ ok: boolean; runtime?: string }> {
    const { json, status } = await this.request('/v1/health')
    if (status >= 400 || !json || json.success === false) {
      throw new OcUnavailableError(t('健康检查失败：HTTP {status}', { status }))
    }
    const data = (json.data && typeof json.data === 'object' ? json.data : {}) as Record<string, unknown>
    return { ok: data.ok === true, runtime: typeof data.runtime === 'string' ? data.runtime : undefined }
  }

  async listProviders(): Promise<OcProvider[]> {
    const { data } = await this.envelope('/v1/providers')
    return Array.isArray(data) ? data as OcProvider[] : []
  }

  async listActions(service?: string): Promise<OcAction[]> {
    const path = service ? `/v1/actions?service=${encodeURIComponent(service)}` : '/v1/actions'
    const { data } = await this.envelope(path)
    return Array.isArray(data) ? data as OcAction[] : []
  }

  async getAction(actionId: string): Promise<OcAction> {
    const { data } = await this.envelope(`/v1/actions/${encodeURIComponent(actionId)}`)
    return (data ?? {}) as OcAction
  }

  /** 连接向导指南代理展示（admin 接口返回 markdown 文本）。 */
  async getActionGuide(actionId: string): Promise<string> {
    const { text, status } = await this.request(`/api/actions/${encodeURIComponent(actionId)}/agent.md`, { acceptText: true })
    if (status >= 400) throw new OcError(`http_${status}`, t('agent.md 获取失败（HTTP {status}）', { status }))
    return text
  }

  // -- 连接管理 -------------------------------------------------------------

  async listConnections(): Promise<OcConnectionSummary[]> {
    const { data } = await this.envelope('/api/connections')
    return Array.isArray(data) ? data as OcConnectionSummary[] : []
  }

  /** 成功状态码上游未载——按默认 200 处理并断言信封 success:true（envelope 已断言）。 */
  async upsertConnection(service: string, body: { authType: string; connectionName?: string; values?: Record<string, unknown>; default?: boolean }): Promise<OcConnectionSummary> {
    const { data } = await this.envelope(`/api/connections/${encodeURIComponent(service)}`, { method: 'PUT', body })
    return (data ?? {}) as OcConnectionSummary
  }

  async deleteConnection(service: string, connectionName?: string): Promise<void> {
    await this.envelope(`/api/connections/${encodeURIComponent(service)}`, { method: 'DELETE', body: { ...(connectionName ? { connectionName } : {}) } })
  }

  // -- OAuth -----------------------------------------------------------------

  async createOAuthAuthorization(payload: {
    service: string
    connectionName?: string
    clientId?: string
    clientSecret?: string
    requestedScopes?: string[]
    extra?: Record<string, unknown>
    secretExtra?: Record<string, unknown>
  }): Promise<OcAuthorizationStart> {
    const { data } = await this.envelope('/api/oauth/authorizations', { method: 'POST', body: payload })
    return (data ?? {}) as OcAuthorizationStart
  }

  // -- oct_ 运行时令牌 -------------------------------------------------------

  /** token 值仅在本响应出现一次，调用方必须立刻接管（本平台选择内存缓存，不落盘）。 */
  async createRuntimeToken(policy: OcTokenPolicy & { name?: string }): Promise<OcRuntimeTokenSummary> {
    const { data } = await this.envelope('/api/runtime-tokens', { method: 'POST', body: policy })
    return (data ?? {}) as OcRuntimeTokenSummary
  }

  async listRuntimeTokens(): Promise<Array<OcRuntimeTokenSummary>> {
    const { data } = await this.envelope('/api/runtime-tokens')
    return Array.isArray(data) ? data as Array<OcRuntimeTokenSummary> : []
  }

  /** 策略更新：policy 必须四数组全发（调用方责任，见 mirrorTokenPolicy）。 */
  async updateRuntimeToken(id: string, policy: OcTokenPolicy): Promise<OcRuntimeTokenSummary> {
    const { data } = await this.envelope(`/api/runtime-tokens/${encodeURIComponent(id)}`, { method: 'PUT', body: policy })
    return (data ?? {}) as OcRuntimeTokenSummary
  }

  async deleteRuntimeToken(id: string): Promise<void> {
    await this.envelope(`/api/runtime-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  // -- 数据面执行与运行日志 ---------------------------------------------------

  /** 执行 action：oct_ 令牌 + x-oo-connector-alias 选命名连接；写类建议携带 Idempotency-Key。 */
  async executeAction(actionId: string, options: { input?: Record<string, unknown>; alias?: string; idempotencyKey?: string }, octToken: string): Promise<ExecuteOutcome> {
    const { status, json } = await this.requestRawWithHeaders(
      `/v1/actions/${encodeURIComponent(actionId)}`, 'POST',
      { input: options.input ?? {} }, octToken,
      {
        ...(options.alias ? { 'x-oo-connector-alias': options.alias } : {}),
        ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      },
    )
    if (json && (json.success === false || status >= 400)) {
      const code = String(json.errorCode ?? `http_${status}`)
      throw new OcError(code, typeof json.message === 'string' ? json.message : t('action {action} 执行失败（HTTP {status}）', { action: actionId, status }))
    }
    return {
      data: json?.data ?? null,
      meta: (json?.meta && typeof json.meta === 'object' ? json.meta : {}) as Record<string, unknown>,
      raw: (json ?? {}) as Record<string, unknown>,
    }
  }

  private async requestRawWithHeaders(path: string, method: string, body: unknown, bearer: string, extraHeaders: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text().catch(() => '')
      let json: Record<string, unknown> | null = null
      try {
        json = text.trim() ? JSON.parse(text) as Record<string, unknown> : null
      } catch {
        throw new OcUnavailableError(t('执行响应不是合法 JSON（HTTP {status}）：{body}', { status: response.status, body: text.slice(0, 120) }))
      }
      return { status: response.status, json, text }
    } catch (error) {
      if (error instanceof OcError || error instanceof OcUnavailableError) throw error
      const message = error instanceof Error ? (error.name === 'AbortError' ? t('执行超时（{timeout}ms）', { timeout: this.timeoutMs }) : error.message) : String(error)
      throw new OcUnavailableError(t('连接器网关不可达：{reason}', { reason: message }))
    } finally {
      clearTimeout(timer)
    }
  }

  // -- runs 对账 --------------------------------------------------------------

  /** cursor 分页：cursor 为 encodeURIComponent(JSON.stringify({startedAt,id}))。 */
  async listRuns(params: { limit?: number; cursor?: string; service?: string; actionId?: string; ok?: boolean } = {}): Promise<OcRunsPage> {
    const search = new URLSearchParams()
    if (params.limit !== undefined) search.set('limit', String(params.limit))
    if (params.cursor) search.set('cursor', params.cursor)
    if (params.service) search.set('service', params.service)
    if (params.actionId) search.set('actionId', params.actionId)
    if (params.ok !== undefined) search.set('ok', String(params.ok))
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    const { data } = await this.envelope(`/api/runs${suffix}`)
    const record = (data && typeof data === 'object' ? data : {}) as { items?: unknown; nextCursor?: unknown }
    return {
      items: Array.isArray(record.items) ? record.items as OcRunLog[] : [],
      ...(typeof record.nextCursor === 'string' && record.nextCursor ? { nextCursor: record.nextCursor } : {}),
    }
  }
}
