/**
 * @dsh-ops/plugin-connector —— SaaS 连接器纳管（open-connector v1.4.0 融合，roadmap 第 9 步之二数据面）。
 *
 * 控制面/数据面分工：元冰可=治理控制面（RBAC + 连接器权限组 + 高危审批 + 计量计费 + 审计）；
 * open-connector sidecar=数据面网关 + 凭证保险库（AES-256-GCM，凭证永不回平台）。
 * 本插件只做映射与接线：不自研 provider 目录、不自研 OAuth、不自研密钥库。
 *
 * 三条红线：
 *   一、凭证零进平台——连接引用无凭证字段；API Key 表单代理直达 sidecar 过手不落盘；
 *       oct_ 运行时令牌值仅存进程内存（台账只记 ocTokenId/policySnapshotHash）；
 *   二、授权双出验证——平台权限组授权链与 oct_ 令牌策略镜像两层各自独立拒绝；
 *   三、actChain 全链路审计 + 计量对账——usage.record 为计费事实源，runs 按 runtimeTokenId 交叉校验。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents, newId, sha256Hex, scanSensitiveKeys, type Collection, type RecordBase, type ToolPrincipal } from '../../platform-core/src/index.ts'
import { OcClient, OC_VERSION_PIN, type OcConnectionSummary, type OcRunLog, type OcTokenPolicy } from './client.ts'
import { OcError } from './errors.ts'
import { heuristicRiskLevel, rankOf, type RiskLevel } from './risk.ts'
import { inOdd, normalizeOdd, type OddDeclaration } from './odd.ts'
import * as connectorTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface GatewayRecord extends RecordBase {
  baseUrl: string
  /** 维护性下线（connector.offline 审批语义）：为真时探活直接跳过，避免定时器自动复活。 */
  maintOffline?: boolean
  /** 管理面 Bearer：`env:VAR` 间接引用（生产强制）；测试可直填 stub 口令。 */
  adminToken: string
  status: 'unconfigured' | 'healthy' | 'unavailable'
  health: { lastProbeAt?: string; latencyMs?: number; consecutiveFails: number }
  /** 状态不可用原因（fail-closed 时写给运维看）。 */
  unavailableReason?: string
  versionPin: string
  /** 目录自动同步周期分钟数；0=手动触发。 */
  autoCatalogSyncMinutes: number
}

export interface CatalogActionRecord {
  id: string
  service: string
  name?: string
  description?: string
  riskLevel: RiskLevel
  requiredScopes: string[]
  providerPermissions: string[]
  inputSchema: Record<string, unknown>
}

export interface CatalogRecord extends RecordBase {
  providers: Array<Record<string, unknown>>
  actions: CatalogActionRecord[]
  skippedServices: Array<{ service: string; reason: string }>
  syncedAt?: string
}

/** 强制 `org:<orgId>:` 别名前缀的连接引用——无任何凭证字段（红线一）。 */
export interface ConnectionReferenceRecord extends RecordBase {
  provider: string
  alias: string
  authType: 'oauth' | 'api_key' | 'custom_credential' | 'no_auth'
  ocConnectionId?: string
  status: 'pending' | 'active' | 'error'
  ownerOrgId: string
  createdBy: string
  maskedProfile?: Record<string, string>
  bridge: boolean
  lastSyncedAt?: string
  requestId?: string
  approvalId?: string
  errorReason?: string
  /** 连接级维护下线（connector.offline）：非空时刷新不覆盖、授权链拒绝经由该连接的调用。 */
  offlinedAt?: string
  offlinedBy?: string
  /** 下线前的原状态（恢复时回滚参考；默认 active）。 */
  offlinedStatusFrom?: 'pending' | 'active' | 'error'
}

export interface ProviderPolicy {
  allowedActions: '*' | string[]
  riskCap: RiskLevel
  connections?: string[]
  constraints?: { readOnly?: boolean; denyParams?: string[] }
}

export interface ConnectorPermGroupRecord extends RecordBase {
  name: string
  description: string
  orgId: string
  policies: Record<string, ProviderPolicy>
  subjects: Array<{ type: 'user_group' | 'agent' | 'app'; id: string; name?: string }>
  rateLimitPerMin: number
  /** OPT-P2-01：运营设计域声明（provider 白名单/排除 action/目录新鲜度/时间窗），未声明=全域。 */
  odd?: OddDeclaration
  /** 已废止（M0-2 billing 下线，2026-09-09）：存量行的 legacy 字段，仅兼容保留、运行时不再读取。 */
  precheckCents?: number
}

export interface TokenLedgerRecord extends RecordBase {
  permGroupId: string
  ocTokenId: string
  policySnapshotHash: string
  createdAt: string
  lastSyncedAt: string
}

export interface InvokeCaller {
  type: 'user' | 'agent' | 'app'
  id: string
  name: string
  actChain?: Array<{ name: string; type: string }>
}

export type ConnectorInvokeStatus =
  | 'ok' | 'denied' | 'rate_limited' | 'quota_exceeded' | 'approval_required' | 'error' | 'dry_run'

export type InvokeOutcome =
  | { ok: true; status: 'ok'; runId: string; latencyMs: number; data: unknown; meta: Record<string, unknown>; metered: boolean }
  | { ok: true; status: 'dry_run'; preview: Record<string, unknown> }
  | { ok: false; status: 'denied' | 'rate_limited' | 'quota_exceeded' | 'error'; error: string; latencyMs: number; code?: string }
  | { ok: false; status: 'approval_required'; approvalId: string; actionId: string; message: string }

export interface ApprovalLike {
  id: string
  kind: string
  status: string
  payload: Record<string, unknown>
}

const RESOURCE_PATTERN = /^[a-z]+:[A-Za-z0-9._-]+$/
const HEALTH_INTERVAL_MS = 30_000
const PATROL_INTERVAL_MS = 10 * 60_000
const RECONCILE_INTERVAL_MS = 5 * 60_000
/** 绕行对账游标去重环形上限（配合 RUN_LIMIT 5000 轮转窗口）。 */
const PROCESSED_RUN_CAP = 4000

function nowIso(): string {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/**
 * 审批执行能力令牌（OPT-P1-02）：admin 高危续调的唯一合法凭证，取代原"仅内部审批执行器可置位"
 * 的普通布尔（纯约定式防护——任何拿到 ctx.connectorHub 的进程内插件都能自置真值跳过审批，
 * 等于可冒充审批执行器；审计核验 #9 升级项）。
 * 不可伪造三要素：128 位随机 token（不可猜）+ 一次性（消费即焚）+ 绑定校验（action+主体，30s TTL）。
 * 铸造收敛在类内执行器闭包经模块级金库（approvalCapabilityVault，闭包持有不导出），REST/工具面类型与运行时双重不可达；
 * 伪造/过期/错配一律按无令牌处理 → 走审批开单路径（fail-closed）。
 */
export interface ApprovalExecutionCapability {
  token: string
  actionId: string
  callerId: string
  expiresAt: number
}

/**
 * 能力令牌金库（OPT-P1-02）：模块级闭包持有台账——不导出、不挂类，进程内其他模块不可达
 * （比 #私有字段更稳：cordis traceable 代理会让 this 品牌检查失败，而模块边界与代理无感）。
 * 铸造只在类内 bindAdminActionExecutor 执行器闭包发生；消费一次性即焚 + 绑定校验（30s TTL）。
 */
const approvalCapabilityVault = (() => {
  const tokens = new Map<string, { actionId: string; callerId: string; expiresAt: number }>()
  return {
    mint(actionId: string, caller: InvokeCaller): ApprovalExecutionCapability {
      const token = crypto.randomUUID()
      const expiresAt = Date.now() + 30_000
      tokens.set(token, { actionId, callerId: caller.id, expiresAt })
      return { token, actionId, callerId: caller.id, expiresAt }
    },
    consume(capability: ApprovalExecutionCapability | undefined, actionId: string, caller: InvokeCaller): boolean {
      if (!capability || typeof capability.token !== 'string' || capability.token === '') return false
      const record = tokens.get(capability.token)
      if (!record) return false
      tokens.delete(capability.token)
      return record.actionId === actionId && record.callerId === caller.id && record.expiresAt > Date.now()
    },
  }
})()

export class ConnectorHubService extends Service {
  static readonly provide = 'connectorHub'

  private rateBuckets = new Map<string, number[]>()
  /** oct_ 令牌值内存缓存：permGroupId → token 值。永不落盘（红线一，journal 设计决策①）。 */
  private tokenValueCache = new Map<string, string>()
  private healthTimer: ReturnType<typeof setInterval> | undefined
  private patrolTimer: ReturnType<typeof setInterval> | undefined
  private reconcileTimer: ReturnType<typeof setInterval> | undefined
  /** unhealthy 事件节流状态：gatewayId → { 已发阈值, 已发原因 }（测试 DEF-02：防审计刷屏）。 */
  private unhealthyEmitState = new Map<string, { threshold: number; reason?: string }>()
  /** 镜像失败 fail-closed 组集合（OPT-P1-05）：镜像成功即移除；期间该组 invoke 全拒。 */
  private mirrorFailureGroups = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'connectorHub')
    ctx.effect(() => () => {
      for (const timer of [this.healthTimer, this.patrolTimer, this.reconcileTimer]) {
        if (timer) clearInterval(timer)
      }
    })
    // OPT-P3-02：全部构造期定时器 unref——保活语义不再隐式持有事件循环（dispose 仍显式清理）
    this.healthTimer = setInterval(() => void this.probeGateway(), HEALTH_INTERVAL_MS)
    this.healthTimer.unref?.()
    this.patrolTimer = setInterval(() => void this.runPatrols(), PATROL_INTERVAL_MS)
    this.patrolTimer.unref?.()
    this.reconcileTimer = setInterval(() => void this.reconcileRuns().catch(() => undefined), RECONCILE_INTERVAL_MS)
    this.reconcileTimer.unref?.()
  }

  // -- 工具层身份与组织收敛（REST 与工具路径共用同一套标准，架构审查 P0-1/P0-2） ---------

  /**
   * 组织可见范围：`*` 权限 → undefined（全部）；human → 归属组织；machine → 绑定 agent/app
   * 资源的归属组织；外部机器无归属 → null（fail-closed，任何组织的数据都不可见）。
   * 身份上下文缺失直接抛错，不降级。
   */
  orgScopeFor(principal?: ToolPrincipal): string | null | undefined {
    if (!principal) throw new Error('工具执行缺少身份上下文（fail-closed）')
    if (principal.permissions.includes('*')) return undefined
    if (principal.kind === 'human' && principal.userId) {
      const user = this.ctx.iam.users().get(principal.userId)
      if (!user) throw new Error(`账号不存在：${principal.userId}`)
      return user.orgId
    }
    return this.boundResourceOrg(principal.principalId) ?? null
  }

  /** 从执行上下文身份解析 InvokeCaller（与 REST /api/connector/execute 同规则），透传 actChain。 */
  callerFromPrincipal(principal?: ToolPrincipal): InvokeCaller {
    if (!principal) throw new Error('工具执行缺少身份上下文（fail-closed）')
    const act = principal.actChain?.length ? { actChain: principal.actChain } : {}
    if (principal.kind === 'human') return { type: 'user', id: principal.userId ?? principal.principalId, name: principal.name, ...act }
    const record = this.ctx.authn.principals().get(principal.principalId)
    if (record?.refType === 'agent' && record.refId) return { type: 'agent', id: record.refId, name: principal.name, ...act }
    if (record?.refType === 'app' && record.refId) return { type: 'app', id: record.refId, name: principal.name, ...act }
    return { type: 'app', id: principal.principalId, name: principal.name, ...act }
  }

  private boundResourceOrg(principalId: string): string | undefined {
    const record = this.ctx.authn.principals().get(principalId)
    if (!record?.refId || (record.refType !== 'agent' && record.refType !== 'app')) return undefined
    const resource = this.ctx.resourceCore.get(record.refType, record.refId) as { orgId?: string } | undefined
    return resource && typeof resource.orgId === 'string' ? resource.orgId : undefined
  }

  // -- 集合 -----------------------------------------------------------------

  gateways(): Collection<GatewayRecord> {
    const collection = this.ctx.opsStorage.collection<GatewayRecord>('connector:gateway')
    collection.uniqueOn('gateway_singleton', () => 'singleton')
    return collection
  }

  connections(): Collection<ConnectionReferenceRecord> {
    const collection = this.ctx.opsStorage.collection<ConnectionReferenceRecord>('connector:connections')
    collection.uniqueOn('alias_unique', (item) => item.alias)
    return collection
  }

  catalogs(): Collection<CatalogRecord> {
    const collection = this.ctx.opsStorage.collection<CatalogRecord>('connector:catalog')
    collection.uniqueOn('catalog_singleton', () => 'singleton')
    return collection
  }

  permGroups(): Collection<ConnectorPermGroupRecord> {
    return this.ctx.opsStorage.collection<ConnectorPermGroupRecord>('connector:permGroups')
  }

  tokens(): Collection<TokenLedgerRecord> {
    const collection = this.ctx.opsStorage.collection<TokenLedgerRecord>('connector:tokens')
    collection.uniqueOn('ledger_group_unique', (item) => item.permGroupId)
    return collection
  }

  runsState(): Collection<RecordBase & { key: string; cursor?: string; processedIds?: string[]; lastRunAt?: string }> {
    const collection = this.ctx.opsStorage.collection<RecordBase & { key: string; cursor?: string; processedIds?: string[]; lastRunAt?: string }>('connector:runs')
    collection.uniqueOn('runs_state_unique', (item) => item.key)
    return collection
  }

  // -- 网关配置与 fail-closed（#2） ------------------------------------------

  /** adminToken 解析：`env:VAR` 间接引用；envProbe 供只读预演探针覆盖（生产路径恒 undefined）。 */
  resolveAdminToken(record: GatewayRecord | undefined, envProbe?: Record<string, boolean | undefined>): string | undefined {
    const value = record?.adminToken ?? ''
    if (!value) return undefined
    if (!value.startsWith('env:')) return value
    const name = value.slice(4)
    if (envProbe && name in envProbe) return envProbe[name] ? process.env[name] : undefined
    return process.env[name]
  }

  gatewayStatus(envProbe?: Record<string, boolean | undefined>): { available: boolean; reason?: string; baseUrl?: string; envChecks?: Record<string, boolean>; status?: GatewayRecord['status']; latencyMs?: number; lastProbeAt?: string } {
    // envProbe：只读「预演探针」——控制台/自测在**不改动进程真实环境**的前提下评估
    // 强制 env 门禁各分支的 fail-closed 语义（P0 修正①），生产路径恒传 undefined。
    const envOf = (name: string): boolean =>
      envProbe && name in envProbe ? Boolean(envProbe[name]) : Boolean(process.env[name])
    const record = this.gateways().all()[0]
    const envChecks = {
      OOMOL_CONNECT_ENCRYPTION_KEY: envOf('OOMOL_CONNECT_ENCRYPTION_KEY'),
      OOMOL_CONNECT_ADMIN_TOKEN: envOf('OOMOL_CONNECT_ADMIN_TOKEN'),
    }
    if (!record || !record.baseUrl.trim()) {
      return { available: false, reason: 'connector:gateway 未配置（baseUrl/adminToken）', envChecks, status: 'unconfigured' }
    }
    const hasLiteralToken = this.resolveAdminToken(record, envProbe) !== undefined
    if (!hasLiteralToken && (!envChecks.OOMOL_CONNECT_ADMIN_TOKEN)) {
      return { available: false, reason: '管理口令未解析（adminToken 需为 env: 引用且 OOMOL_CONNECT_ADMIN_TOKEN 已设置）', envChecks, ...(record ? { status: record.status, lastProbeAt: record.health.lastProbeAt } : {}) }
    }
    if (!envChecks.OOMOL_CONNECT_ENCRYPTION_KEY) {
      return { available: false, reason: 'OOMOL_CONNECT_ENCRYPTION_KEY 未设置：sidecar 将凭证明文落盘，平台 fail-closed 拒绝一切 invoke', envChecks, ...(record ? { status: record.status, lastProbeAt: record.health.lastProbeAt } : {}) }
    }
    if (record.status === 'unconfigured') {
      return { available: false, reason: '网关尚未探活', envChecks, status: record.status }
    }
    if (record.status !== 'healthy') {
      return { available: false, reason: record.unavailableReason ?? '网关探活失败（fail-closed）', envChecks, status: record.status, lastProbeAt: record.health.lastProbeAt }
    }
    return {
      available: true,
      baseUrl: record.baseUrl,
      envChecks,
      status: record.status,
      ...(record.health.latencyMs !== undefined ? { latencyMs: record.health.latencyMs } : {}),
      ...(record.health.lastProbeAt !== undefined ? { lastProbeAt: record.health.lastProbeAt } : {}),
    }
  }

  /** 断言可用并返回客户端（对所有数据面动作的前置闸，不满足直接抛错拒绝）。 */
  requireClient(): { client: OcClient; record: GatewayRecord } {
    const status = this.gatewayStatus()
    if (!status.available || !status.baseUrl) {
      this.noteFailureSignal(status.reason ?? '网关不可用')
      throw new OcError('gateway_unavailable', status.reason ?? '连接器网关不可用（fail-closed）', undefined, 503)
    }
    const record = this.gateways().all()[0]!
    const client = new OcClient(status.baseUrl, this.resolveAdminToken(record)!, OC_DEFAULT_TIMEOUT)
    return { client, record }
  }

  async configureGateway(input: { baseUrl: string; adminToken?: string; autoCatalogSyncMinutes?: number }, actor: string): Promise<GatewayRecord> {
    const baseUrl = input.baseUrl.replace(/\/$/, '')
    if (!baseUrl) throw new Error('baseUrl 必填')
    const existing = this.gateways().all()[0]
    const next: Partial<GatewayRecord> = {
      baseUrl,
      ...(input.adminToken !== undefined ? { adminToken: input.adminToken } : {}),
      ...(input.autoCatalogSyncMinutes !== undefined ? { autoCatalogSyncMinutes: input.autoCatalogSyncMinutes } : {}),
      versionPin: OC_VERSION_PIN,
    }
    let record: GatewayRecord
    if (existing) {
      record = this.gateways().update(existing.id, next)
    } else {
      record = this.gateways().insert({
        id: newId('cgw'), baseUrl,
        adminToken: input.adminToken ?? 'env:OOMOL_CONNECT_ADMIN_TOKEN',
        status: 'unconfigured',
        health: { consecutiveFails: 0 },
        versionPin: OC_VERSION_PIN,
        autoCatalogSyncMinutes: input.autoCatalogSyncMinutes ?? 0,
        createdAt: nowIso(), updatedAt: nowIso(),
      })
    }
    void actor
    this.ctx.platformBus.emit(PlatformEvents.ConnectorGatewayChanged, { baseUrl: record.baseUrl, versionPin: record.versionPin })
    await this.probeGateway()
    return this.gateways().get(record.id)!
  }

  /** 探活：连续失败即整体 unavailable（invoke 拒绝）；恢复自动半闭合。 */
  async probeGateway(): Promise<{ ok: boolean; latencyMs: number; reason?: string }> {
    const record = this.gateways().all()[0]
    if (!record) return { ok: false, latencyMs: 0, reason: '未配置' }
    if (record.maintOffline) {
      // 维护下线态：探活直接跳过（定时器不复活），仅刷新时间戳
      this.gateways().update(record.id, { health: { ...record.health, lastProbeAt: nowIso() } })
      return { ok: false, latencyMs: 0, reason: record.unavailableReason ?? '审批下线（维护态，探活跳过）' }
    }
    // 强制 env 门禁先于网络探测（P0 修正①）：加密钥缺失或管理口令不可解析即 unavailable +
    // 告警计数——这两个是部署期硬问题；而「尚未探活」属于正常过渡态，必须继续真实探测。
    const encryptionMissing = process.env.OOMOL_CONNECT_ENCRYPTION_KEY === undefined
    const adminUnresolvable = this.resolveAdminToken(record) === undefined
    if (encryptionMissing || adminUnresolvable) {
      const fails = record.health.consecutiveFails + 1
      const rawReason = this.gatewayStatus().reason
      const reason = rawReason && /(OOMOL|管理口令)/.test(rawReason) ? rawReason : '强制配置缺失：无法安全访问连接器网关（fail-closed）'
      this.gateways().update(record.id, {
        status: 'unavailable', unavailableReason: reason,
        health: { lastProbeAt: nowIso(), consecutiveFails: fails },
      })
      this.emitUnhealthyThrottled(record, fails, reason)
      return { ok: false, latencyMs: 0, reason }
    }
    const started = Date.now()
    try {
      const client = new OcClient(record.baseUrl, this.resolveAdminToken(record) ?? 'probe-probe', 5_000)
      await client.health()
      const latencyMs = Date.now() - started
      const previous = record.status
      this.gateways().update(record.id, {
        status: 'healthy', unavailableReason: undefined,
        health: { lastProbeAt: nowIso(), latencyMs, consecutiveFails: 0 },
      })
      this.unhealthyEmitState.delete(record.id)
      if (previous !== 'healthy') {
        this.ctx.platformBus.emit(PlatformEvents.ConnectorGatewayChanged, { baseUrl: record.baseUrl, status: 'healthy', recoveredFrom: previous })
      }
      return { ok: true, latencyMs }
    } catch (error) {
      const fails = record.health.consecutiveFails + 1
      const reason = error instanceof Error ? error.message : String(error)
      const latencyMs = Date.now() - started
      this.gateways().update(record.id, {
        status: 'unavailable', unavailableReason: reason,
        health: { lastProbeAt: nowIso(), latencyMs, consecutiveFails: fails },
      })
      this.emitUnhealthyThrottled(record, fails, reason)
      return { ok: false, latencyMs, reason }
    }
  }

  /** 业务失败信号：不足三次不开告警（与 mcp 连续熔断同思路），但即时刷新探活口径。 */
  private noteFailureSignal(reason: string): void {
    const record = this.gateways().all()[0]
    if (!record) return
    const fails = record.health.consecutiveFails + 1
    this.gateways().update(record.id, {
      status: 'unavailable', unavailableReason: reason,
      health: { ...record.health, lastProbeAt: nowIso(), consecutiveFails: fails },
    })
    this.emitUnhealthyThrottled(record, fails, reason)
  }

  private noteSuccessSignal(): void {
    const record = this.gateways().all()[0]
    if (!record) return
    this.unhealthyEmitState.delete(record.id)
    if (record.health.consecutiveFails === 0 && record.status === 'healthy') return
    this.gateways().update(record.id, { status: 'healthy', unavailableReason: undefined, health: { ...record.health, consecutiveFails: 0 } })
  }

  /**
   * 网关不健康事件按递增阈值节流（3→10→30→100…），失败原因变化时立即补发一次；
   * 恢复健康即清零。测试 DEF-02：探活每 30s 一轮，原实现 fails≥3 后每轮都发事件，
   * 长故障（如部署 env 缺失未修复）一天可产生近 3000 条重复审计与工作台事件流刷屏。
   */
  private emitUnhealthyThrottled(record: GatewayRecord, fails: number, reason: string): void {
    const state = this.unhealthyEmitState.get(record.id)
    const thresholds = [3, 10, 30, 100, 300, 1000, 3000, 10000]
    const next = thresholds.find((t) => t > (state?.threshold ?? 0))
    const reasonChanged = state !== undefined && state.reason !== reason
    if (!reasonChanged && (next === undefined || fails < next)) return
    this.unhealthyEmitState.set(record.id, { threshold: next ?? state!.threshold, reason })
    this.ctx.platformBus.emit(PlatformEvents.ConnectorGatewayUnhealthy, {
      baseUrl: record.baseUrl, consecutiveFails: fails, reason, resourceType: 'connector_gateway', resourceId: record.id,
    })
  }

  /** connector.offline 执行器语义①：网关维护下线（fail-closed 立即生效，探活跳过防自动复活）。 */
  async offlineGateway(reason: string): Promise<GatewayRecord | undefined> {
    const record = this.gateways().all()[0]
    if (!record) return undefined
    const updated = this.gateways().update(record.id, {
      maintOffline: true,
      status: 'unavailable',
      unavailableReason: `审批下线：${reason}`,
    })
    this.ctx.platformBus.emit(PlatformEvents.ConnectorGatewayChanged, { baseUrl: updated.baseUrl, action: 'gateway_offline', reason })
    this.ctx.audit.record({
      type: 'change', actorType: 'system', actorId: 'connector-offline', actorName: '审批执行',
      action: 'connector.gateway.offline', resourceType: 'connector_gateway', resourceId: updated.id,
      resourceName: updated.baseUrl, result: 'ok', detail: reason,
    })
    return updated
  }

  /** 恢复上线：清除维护标记并立即真实探活。 */
  async onlineGateway(): Promise<{ ok: boolean; latencyMs: number; reason?: string }> {
    const record = this.gateways().all()[0]
    if (record && record.maintOffline) {
      this.gateways().update(record.id, { maintOffline: false, unavailableReason: undefined })
    }
    return await this.probeGateway()
  }

  /** connector.offline 执行器语义②：连接引用下线（平台侧拒绝经由它的调用；sidecar 凭证不受影响）。 */
  async offlineConnection(id: string, options: { actorName: string; reason: string }): Promise<ConnectionReferenceRecord> {
    const ref = this.connections().get(id)
    if (!ref) throw new Error(`连接引用不存在：${id}`)
    if (ref.status === 'offlined') return ref
    const updated = this.connections().update(id, {
      offlinedStatusFrom: ref.status,
      status: 'offlined',
      offlinedAt: nowIso(),
      offlinedBy: options.actorName,
      errorReason: `审批下线：${options.reason}`,
    } as Partial<ConnectionReferenceRecord>)
    this.ctx.platformBus.emit(PlatformEvents.ConnectorDisconnected, {
      connectionId: id, alias: ref.alias, provider: ref.provider, orgId: ref.ownerOrgId,
      actor: options.actorName, action: 'offline', reason: options.reason,
    })
    return updated
  }

  /** 连接恢复：清下线标记并回查 sidecar 状态（网关不可达时停留 pending 待下次轮询收敛）。 */
  async onlineConnection(id: string): Promise<ConnectionReferenceRecord> {
    const ref = this.connections().get(id)
    if (!ref) throw new Error(`连接引用不存在：${id}`)
    this.connections().update(id, {
      offlinedStatusFrom: undefined, offlinedAt: undefined, offlinedBy: undefined,
      errorReason: undefined, status: ref.offlinedStatusFrom === 'pending' ? 'pending' : 'active',
    } as Partial<ConnectionReferenceRecord>)
    try {
      return await this.confirmConnectionStatus({ connectionId: id }) ?? this.connections().get(id)!
    } catch {
      return this.connections().get(id)!
    }
  }

  // -- 目录同步（#3） ---------------------------------------------------------

  async catalog(): Promise<CatalogRecord | undefined> {
    return this.catalogs().all()[0]
  }

  /** 目录同步时点（OPT-P2-01 ODD 新鲜度判定用；同步集合读取）。 */
  private catalogSnapshotSyncedAt(): string | undefined {
    return this.catalogs().all()[0]?.syncedAt
  }

  requireAction(actionId: string): CatalogActionRecord {
    const entry = this.catalogs().all()[0]?.actions.find((item) => item.id === actionId)
    if (!entry) {
      throw new OcError('unknown_action', `action 不在纳管目录中：${actionId}（先执行目录同步）`, undefined, 404)
    }
    return entry
  }

  async syncCatalog(actor: string): Promise<{ providers: number; actions: number; added: string[]; removed: string[]; skippedServices: Array<{ service: string; reason: string }> }> {
    const { client } = this.requireClient()
    const [providers, actions] = await Promise.all([client.listProviders(), client.listActions()])
    const skipped: Array<{ service: string; reason: string }> = []
    const validServices = new Set<string>()
    const normalized: Array<Record<string, unknown>> = []
    for (const provider of providers) {
      const service = String((provider.service ?? provider.name ?? '') ).trim()
      if (!service) continue
      // usage resource 正则约束（P2 修正⑮）：provider 段必须满足 /^[a-z]+:[A-Za-z0-9._-]+$/
      if (!RESOURCE_PATTERN.test(`connector:${service}`)) {
        skipped.push({ service, reason: `service 标识不满足计量资源正则 ${RESOURCE_PATTERN.source}` })
        continue
      }
      validServices.add(service)
      normalized.push(provider)
    }
    const mapped: CatalogActionRecord[] = []
    for (const action of actions) {
      const service = String(action.service ?? '').trim()
      if (!service || !validServices.has(service)) continue
      const scopes = (Array.isArray(action.requiredScopes) ? action.requiredScopes : []).map(String)
      const perms = (Array.isArray(action.providerPermissions) ? action.providerPermissions : []).map(String)
      mapped.push({
        id: action.id,
        service,
        ...(action.name !== undefined ? { name: String(action.name) } : {}),
        ...(action.description !== undefined ? { description: String(action.description) } : {}),
        riskLevel: heuristicRiskLevel(action),
        requiredScopes: scopes,
        providerPermissions: perms,
        inputSchema: action.inputSchema && typeof action.inputSchema === 'object' ? action.inputSchema : { type: 'object', properties: {} },
      })
    }
    const previous = this.catalogs().all()[0]
    const previousIds = new Set(previous?.actions.map((item) => item.id) ?? [])
    const added = mapped.filter((item) => !previousIds.has(item.id)).map((item) => item.id)
    const newIds = new Set(mapped.map((item) => item.id))
    const removed = (previous?.actions ?? []).filter((item) => !newIds.has(item.id)).map((item) => item.id)
    // 目录变更联动（T-04）：显式清单命中下架 action 的权限组先落库裁剪，
    // 再统一镜像——快照哈希因此变化，PUT 四数组全发自然发生。
    let prunedGroups = 0
    if (removed.length > 0) {
      for (const group of this.permGroups().all()) {
        let touched = false
        const nextPolicies = Object.fromEntries(Object.entries(group.policies).map(([service, policy]) => {
          if (policy.allowedActions === '*') return [service, policy]
          const kept = policy.allowedActions.filter((entry) => !removed.includes(entry))
          if (kept.length === policy.allowedActions.length) return [service, policy]
          touched = true
          return [service, { ...policy, allowedActions: kept }]
        }))
        if (touched) {
          this.permGroups().update(group.id, { policies: nextPolicies as typeof group.policies })
          prunedGroups++
        }
      }
    }
    const createdRecord = previous
      ? this.catalogs().update(previous.id, { providers: normalized, actions: mapped, skippedServices: skipped, syncedAt: nowIso() })
      : this.catalogs().insert({ id: newId('cat'), providers: normalized, actions: mapped, skippedServices: skipped, syncedAt: nowIso(), createdAt: nowIso(), updatedAt: nowIso() })
    void createdRecord
    if (added.length > 0 || removed.length > 0) {
      this.ctx.platformBus.emit(PlatformEvents.ConnectorGatewaySynced, {
        kind: 'catalog', providers: normalized.length, actions: mapped.length, added, removed, actor, prunedGroups,
      })
      for (const group of this.permGroups().all()) {
        await this.mirrorTokenPolicySafe(group)
      }
    }
    return { providers: normalized.length, actions: mapped.length, added, removed, skippedServices: skipped }
  }

  // -- 连接管理（#4） ---------------------------------------------------------

  assertAliasPrefix(alias: string, orgId: string): string {
    const prefix = `org:${orgId}:`
    if (!alias.startsWith(prefix) || alias.length <= prefix.length) {
      throw new OcError('invalid_alias_prefix', `连接别名必须以 ${prefix} 开头（org 隔离三件套①）`, undefined, 400)
    }
    return alias
  }

  buildAlias(orgId: string, suffix: string): string {
    const clean = suffix.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '')
    if (!clean) throw new Error('连接别名后缀不能为空')
    return this.assertAliasPrefix(`org:${orgId}:${clean}`, orgId)
  }

  maskValue(value: unknown): string {
    const text = String(value ?? '')
    if (text.length > 8) return `${text.slice(0, 6)}…`
    return '****'
  }

  private summarize(sidecarSummary: OcConnectionSummary | undefined, ref: Partial<ConnectionReferenceRecord>): Partial<ConnectionReferenceRecord> {
    const masked: Record<string, string> = {}
    const profile = sidecarSummary?.profile
    if (profile && typeof profile === 'object') {
      for (const [key, value] of Object.entries(profile)) {
        masked[key] = typeof value === 'string' && /(secret|token|key|password)/i.test(key) ? this.maskValue(value) : String(value)
      }
    }
    return {
      ...(sidecarSummary?.id ? { ocConnectionId: sidecarSummary.id } : {}),
      ...(sidecarSummary?.authType ? { authType: normalizeAuthType(sidecarSummary.authType) } : {}),
      status: sidecarSummary?.configured ? 'active' : (ref.status ?? 'pending'),
      ...(Object.keys(masked).length > 0 ? { maskedProfile: masked } : {}),
      lastSyncedAt: nowIso(),
    }
  }

  /**
   * 连接创建统一入口：no_auth 直接登记；api_key/custom_credential 表单值过手直达 sidecar 不落盘；
   * OAuth 先审批后发起。requireApproval=true 或存在 provider 审批要求时进入两段式（journal 设计决策②）。
   */
  async createConnection(input: {
    orgId: string
    actor: { id: string; name: string }
    provider: string
    aliasSuffix: string
    authType: 'oauth' | 'api_key' | 'custom_credential' | 'no_auth'
    values?: Record<string, unknown>
    requestedScopes?: string[]
    requireApproval?: boolean
    approvalId?: string
  }): Promise<{ reference?: ConnectionReferenceRecord; approvalRequired?: boolean; approvalId?: string; authorizationUrl?: string; state?: string; guidance?: string }> {
    const alias = this.buildAlias(input.orgId, input.aliasSuffix)
    const approvalDecided = input.approvalId ? this.verifyConnectApproval(input.approvalId, input.provider, input.orgId, input.actor.id) : false
    if (input.authType === 'no_auth') {
      // no_auth 无凭证、不触碰 sidecar：纯本地虚拟登记（演示种子/网关未配置时也可建）
      const existingNoAuth = this.connections().findOne((item) => item.alias === alias)
      const reference = existingNoAuth
        ? this.connections().update(existingNoAuth.id, { status: 'active', provider: input.provider, ownerOrgId: input.orgId, errorReason: undefined, updatedAt: nowIso() })
        : this.connections().insert({
            id: newId('ocn'), provider: input.provider, alias, authType: 'no_auth',
            status: 'active', ownerOrgId: input.orgId, createdBy: input.actor.name,
            bridge: false, createdAt: nowIso(), updatedAt: nowIso(),
          })
      this.ctx.platformBus.emit(PlatformEvents.ConnectorConnected, { connectionId: reference.id, alias, provider: input.provider, orgId: input.orgId, authType: 'no_auth' })
      return { reference }
    }
    const { client } = this.requireClient()
    if (!RESOURCE_PATTERN.test(`connector:${input.provider}`)) {
      throw new OcError('invalid_service', `provider 标识不满足计量资源正则：${input.provider}`, undefined, 400)
    }
    const needsApproval = input.requireApproval === true
    if (needsApproval && !approvalDecided) {
      const approval = this.ctx.audit.createApproval({
        kind: 'connector.connect',
        // WP-10/L1（QA A-06）：L4 高危统一高风险——通过需二次确认 + 公司级终审标记
        riskLevel: 'high',
        title: `新建 SaaS 连接：${input.provider}`,
        payload: {
          // 审批负载禁止携带凭证字段（红线一）：只有 provider/org/alias 与发起人
          provider: input.provider, orgId: input.orgId, alias, authType: input.authType,
          requesterId: input.actor.id, requesterName: input.actor.name, stage: 'pre_submit',
        },
        requesterId: input.actor.id,
        requesterName: input.actor.name,
      })
      return { approvalRequired: true, approvalId: approval.id }
    }
    if (input.approvalId && !approvalDecided) {
      throw new OcError('approval_required', '该 provider 配置了连接审批：请先提交审批并通过后再携带 approvalId 创建连接', undefined, 403)
    }
    const existingRef = this.connections().findOne((item) => item.alias === alias)
    if (input.authType === 'oauth') {
      let authorization: Awaited<ReturnType<OcClient['createOAuthAuthorization']>>
      try {
        authorization = await client.createOAuthAuthorization({
          service: input.provider,
          connectionName: alias,
          ...(input.requestedScopes?.length ? { requestedScopes: input.requestedScopes } : {}),
        })
      } catch (error) {
        if (error instanceof OcError && error.code === 'oauth_client_config_required') {
          // P1 修正⑩：自备 App 成本透传给向导（企业需先在 provider 侧注册 client 并写入 sidecar）
          throw new OcError(
            'oauth_client_config_required',
            `${input.provider} 的 OAuth 需要「自备 App」：请先在企业侧注册 OAuth App，并把 client 配置写入连接器网关（PUT /api/oauth/configs/:service），再重试`,
            `向导提示：在 ${input.provider} 开发者后台创建 OAuth App；回调地址使用 OOMOL_CONNECT_ORIGIN 对应的 /oauth/callback；随后由管理员保存 client 配置。指南详见 docs/connector-integration.md`,
          )
        }
        throw error
      }
      const reference = existingRef
        ? this.connections().update(existingRef.id, {
            status: 'pending', provider: input.provider,
            ownerOrgId: input.orgId, requestId: authorization.state,
            errorReason: undefined, updatedAt: nowIso(),
            createdBy: input.actor.name,
          })
        : this.connections().insert({
            id: newId('ocn'), provider: input.provider, alias,
            authType: 'oauth', status: 'pending', ownerOrgId: input.orgId,
            createdBy: input.actor.name, bridge: false,
            requestId: authorization.state, createdAt: nowIso(), updatedAt: nowIso(),
          })
      return { reference, authorizationUrl: authorization.authorizationUrl, state: authorization.state }
    }
    // api_key / custom_credential：表单过手直达 sidecar（请求体即刻送出，不写任何集合、不打日志）
    const summary = await client.upsertConnection(input.provider, {
      authType: input.authType === 'custom_credential' ? 'custom_credential' : 'api_key',
      connectionName: alias,
      values: input.values ?? {},
    })
    const base = existingRef ?? {}
    const merged: Partial<ConnectionReferenceRecord> = {
      provider: input.provider, alias, ownerOrgId: input.orgId,
      authType: normalizeAuthType(summary.authType ?? input.authType),
      createdBy: input.actor.name, bridge: false, errorReason: undefined,
      ...this.summarize(summary, base),
      updatedAt: nowIso(),
    }
    const reference = existingRef
      ? this.connections().update(existingRef.id, merged)
      : this.connections().insert({
          id: newId('ocn'), createdAt: nowIso(), ...merged,
        } as ConnectionReferenceRecord)
    this.ctx.platformBus.emit(PlatformEvents.ConnectorConnected, {
      connectionId: reference.id, alias, provider: input.provider, orgId: input.orgId, authType: reference.authType,
    })
    return { reference }
  }

  /** 两段式审批的第二段：验证审批单已通过且主体/provider/org 匹配后才放行实际凭证提交。 */
  verifyConnectApproval(approvalId: string, provider: string, orgId: string, requesterId: string): boolean {
    const approval = this.ctx.audit.approvals().get(approvalId) as ApprovalLike | undefined
    if (!approval) throw new OcError('approval_invalid', `审批单不存在：${approvalId}`, undefined, 400)
    if (approval.kind !== 'connector.connect') throw new OcError('approval_invalid', `审批单类型不符：${approval.kind}`, undefined, 400)
    const payload = approval.payload as Record<string, unknown>
    if (String(payload.requesterId ?? '') !== String(requesterId)) {
      throw new OcError('approval_actor_mismatch', '审批单发起人与当前操作人不一致，拒绝以此单放行', undefined, 403)
    }
    if (String(payload.provider ?? '') !== provider || String(payload.orgId ?? '') !== orgId) {
      throw new OcError('approval_target_mismatch', '审批单的 provider/org 与本次创建不一致', undefined, 403)
    }
    if (!['approved', 'executed'].includes(approval.status)) {
      throw new OcError('approval_pending', `审批单未通过（${approval.status}）`, undefined, 403)
    }
    return true
  }

  /** OAuth 回调后状态确认：比对 sidecar 连接清单回填引用（供前端轮询与巡检复用）。 */
  async confirmConnectionStatus(filter: { requestId?: string; connectionId?: string }): Promise<ConnectionReferenceRecord | undefined> {
    const { client } = this.requireClient()
    const ref = filter.connectionId
      ? this.connections().get(filter.connectionId)
      : this.connections().findOne((item) => item.requestId === filter.requestId)
    if (!ref) return undefined
    if (ref.offlinedAt) return ref // 维护下线态：状态轮询不复活连接
    const summaries = await client.listConnections()
    const match = summaries.find((item) => item.connectionName === ref.alias && item.service === ref.provider)
    if (!match) {
      return this.connections().update(ref.id, { status: ref.status === 'active' ? 'active' : 'pending', lastSyncedAt: nowIso() })
    }
    const updated = this.connections().update(ref.id, {
      ...this.summarize(match, ref),
      updatedAt: nowIso(),
    } as Partial<ConnectionReferenceRecord>)
    if (updated.status === 'active' && ref.status !== 'active') {
      this.ctx.platformBus.emit(PlatformEvents.ConnectorConnected, {
        connectionId: updated.id, alias: updated.alias, provider: updated.provider, orgId: updated.ownerOrgId, authType: updated.authType,
      })
    }
    return updated
  }

  /** 删除连接：级联检查权限组引用；force 时解除引用并镜像更新受影响令牌（四数组全发）。 */
  async deleteConnection(id: string, options: { actor: string; force?: boolean }): Promise<{ deleted: boolean; releasedGroups: string[] }> {
    const { client } = this.requireClient()
    const ref = this.connections().get(id)
    if (!ref) throw new Error(`连接引用不存在：${id}`)
    const referencingGroups = this.permGroups().find((group) =>
      group.orgId === ref.ownerOrgId && Object.values(group.policies).some((policy) => (policy.connections ?? []).includes(ref.alias)))
    if (referencingGroups.length > 0 && !options.force) {
      throw new OcError('connection_in_use', `连接仍被 ${referencingGroups.map((group) => group.name).join('、')} 权限组引用，请先解绑或携带 force 解除`, undefined, 409)
    }
    if (ref.authType !== 'no_auth') {
      try {
        await client.deleteConnection(ref.provider, ref.alias)
      } catch (error) {
        if (!(error instanceof OcError && error.code === 'unknown_connection')) throw error
      }
    }
    this.connections().remove(id)
    for (const group of referencingGroups) {
      const nextPolicies = Object.fromEntries(Object.entries(group.policies).map(([service, policy]) => [
        service,
        { ...policy, connections: (policy.connections ?? []).filter((alias) => alias !== ref.alias) },
      ]))
      const updatedGroup = this.permGroups().update(group.id, { policies: nextPolicies })
      await this.mirrorTokenPolicySafe(updatedGroup)
    }
    if (referencingGroups.length === 0) {
      const affected = this.tokens().find((item) => item.permGroupId && this.permGroups().get(item.permGroupId)?.orgId === ref.ownerOrgId)
      for (const ledger of affected) {
        const group = this.permGroups().get(ledger.permGroupId)
        if (group) await this.mirrorTokenPolicySafe(group)
      }
    }
    this.ctx.platformBus.emit(PlatformEvents.ConnectorDisconnected, { connectionId: id, alias: ref.alias, provider: ref.provider, orgId: ref.ownerOrgId, actor: options.actor })
    return { deleted: true, releasedGroups: referencingGroups.map((group) => group.id) }
  }

  /** 全量同步连接引用侧状态（控制台列表页轮询入口）。 */
  async refreshConnections(orgId?: string): Promise<{ refreshed: number; sidecarTotal: number }> {
    const { client } = this.requireClient()
    const summaries = await client.listConnections()
    const scope = orgId ? this.connections().find((item) => item.ownerOrgId === orgId) : this.connections().all()
    for (const ref of scope) {
      if (ref.offlinedAt) continue // 维护下线态：刷新不覆盖（audit 口径保持下线原因）
      const match = summaries.find((item) => item.connectionName === ref.alias)
      if (!match) continue
      this.connections().update(ref.id, { ...this.summarize(match, ref), updatedAt: nowIso() } as Partial<ConnectionReferenceRecord>)
    }
    return { refreshed: scope.length, sidecarTotal: summaries.length }
  }

  // -- 权限组（#2.4 第一层） ---------------------------------------------------

  createPermGroup(input: {
    name: string
    description?: string
    orgId: string
    policies: Record<string, ProviderPolicy>
    subjects: ConnectorPermGroupRecord['subjects']
    rateLimitPerMin?: number
    odd?: OddDeclaration
  }): ConnectorPermGroupRecord {
    if (!input.name?.trim()) throw new Error('权限组名称不能为空')
    if (this.permGroups().findOne((group) => group.name === input.name)) throw new Error(`权限组已存在：${input.name}`)
    if (!this.ctx.iam.orgs().get(input.orgId)) throw new Error(`组织不存在：${input.orgId}`)
    this.validatePolicies(input.orgId, input.policies)
    const group = this.permGroups().insert({
      id: newId('cpg'), name: input.name,
      description: input.description ?? '', orgId: input.orgId,
      policies: this.normalizePolicies(input.policies),
      subjects: input.subjects,
      rateLimitPerMin: Math.max(1, input.rateLimitPerMin ?? 60),
      ...(input.odd !== undefined ? { odd: normalizeOdd(input.odd) } : {}),
      createdAt: nowIso(), updatedAt: nowIso(),
    })
    this.afterPermGroupChange(group)
    return group
  }

  updatePermGroup(id: string, patch: Partial<Pick<ConnectorPermGroupRecord, 'name' | 'description' | 'policies' | 'subjects' | 'rateLimitPerMin' | 'odd'>>): ConnectorPermGroupRecord {
    const group = this.requirePermGroup(id)
    if (patch.policies) this.validatePolicies(group.orgId, patch.policies)
    const normalizedPatch: Partial<ConnectorPermGroupRecord> = {
      ...patch,
      ...(patch.policies ? { policies: this.normalizePolicies(patch.policies) } : {}),
      ...(patch.odd !== undefined ? { odd: normalizeOdd(patch.odd) } : {}),
    }
    const updated = this.permGroups().update(id, normalizedPatch)
    this.afterPermGroupChange(updated)
    return updated
  }

  deletePermGroup(id: string): boolean {
    this.requirePermGroup(id)
    const removed = this.permGroups().remove(id)
    if (removed) this.deleteTokenForGroup(id).catch(() => undefined)
    this.ctx.platformBus.emit(PlatformEvents.ConnectorPermGroupChanged, { groupId: id, change: 'deleted' })
    return removed
  }

  /** 变更影响面预览（评审 2.2-3：N 个令牌 / M 个连接，对齐平台 dry-run 惯例）。 */
  permGroupImpact(id: string): { tokens: number; connections: number; subjects: number } {
    const group = this.requirePermGroup(id)
    const referencedAliases = new Set(Object.values(group.policies).flatMap((policy) => policy.connections ?? []))
    return {
      tokens: this.tokens().find((item) => item.permGroupId === id).length,
      connections: this.connections().find((item) => item.ownerOrgId === group.orgId && referencedAliases.has(item.alias)).length,
      subjects: group.subjects.length,
    }
  }

  private requirePermGroup(id: string): ConnectorPermGroupRecord {
    const group = this.permGroups().get(id)
    if (!group) throw new Error(`连接器权限组不存在：${id}`)
    return group
  }

  private validatePolicies(orgId: string, policies: Record<string, ProviderPolicy>): void {
    for (const [service, policy] of Object.entries(policies)) {
      if (!RESOURCE_PATTERN.test(`connector:${service}`)) {
        throw new Error(`provider 段不满足计量资源正则：${service}`)
      }
      if (policy.riskCap && !(policy.riskCap in { read: 1, write: 1, admin: 1 })) {
        throw new Error(`riskCap 非法：${String(policy.riskCap)}（read|write|admin）`)
      }
      for (const alias of policy.connections ?? []) {
        this.assertAliasPrefix(alias, orgId)
        if (!this.connections().findOne((item) => item.alias === alias && item.ownerOrgId === orgId)) {
          throw new Error(`引用的连接不存在或不在本组织：${alias}`)
        }
      }
    }
  }

  private normalizePolicies(policies: Record<string, ProviderPolicy>): Record<string, ProviderPolicy> {
    return Object.fromEntries(Object.entries(policies).map(([service, policy]) => [
      service,
      {
        // '*' 字符串通配 / 'service.*' 单串 pattern / 数组三形态归一（pattern 语义见计划书 §2.4）
        allowedActions: policy.allowedActions === '*'
          ? '*'
          : Array.isArray(policy.allowedActions)
            ? policy.allowedActions
            : (typeof policy.allowedActions === 'string' && policy.allowedActions.endsWith('.*') ? [policy.allowedActions] : ['*']),
        riskCap: policy.riskCap ?? 'read',
        ...(policy.connections?.length ? { connections: [...new Set(policy.connections)] } : {}),
        constraints: {
          ...(policy.constraints?.readOnly !== undefined ? { readOnly: policy.constraints.readOnly } : {}),
          ...(policy.constraints?.denyParams?.length ? { denyParams: policy.constraints.denyParams } : {}),
        },
      },
    ]))
  }

  private afterPermGroupChange(group: ConnectorPermGroupRecord): void {
    this.ctx.platformBus.emit(PlatformEvents.ConnectorPermGroupChanged, { groupId: group.id, name: group.name, change: 'upserted' })
    // OPT-P1-05：显式调度（错误经 handleMirrorFailure 全程可观测，不再静默吞）
    void this.mirrorTokenPolicySafe(group)
  }

  // -- 第二层：oct_ 令牌策略镜像（#7） -----------------------------------------

  private clientForMirror(): OcClient {
    return this.requireClient().client
  }

  /** 权限组快照（pattern 直传 + 该组可见连接稳定 ID 列表；org 边界天然绑定，三件套②）。 */
  policySnapshot(group: ConnectorPermGroupRecord): OcTokenPolicy & { snapshotHash: string } {
    const allowed: string[] = []
    let wildcard = false
    for (const policy of Object.values(group.policies)) {
      if (policy.allowedActions === '*') {
        wildcard = true
        continue
      }
      allowed.push(...policy.allowedActions)
    }
    const referencedAliases = [...new Set(Object.values(group.policies).flatMap((policy) => policy.connections ?? []))]
    const allowedConnections = referencedAliases.length === 0
      ? []
      : this.connections()
          .find((item) => item.ownerOrgId === group.orgId && referencedAliases.includes(item.alias))
          .map((item) => item.ocConnectionId)
          .filter((id): id is string => Boolean(id))
    // 通配短路：组内任一策略声明 '*' 即整体 ['*']（union 语义下不再混入显式条目）
    const sortedAllowed = wildcard ? ['*'] : [...new Set(allowed)].sort()
    const snapshot = {
      allowedActions: sortedAllowed,
      blockedActions: [] as string[],
      allowedProxies: [] as string[],
      allowedConnections: [...allowedConnections].sort(),
    }
    return { ...snapshot, snapshotHash: sha256Hex(JSON.stringify(snapshot)) }
  }

  /** 台账收敛：新建铸令 / 快照哈希变化才 PUT（四个数组全发）/ 删除场景走 DELETE。 */
  /**
   * 镜像安全封装（OPT-P1-05）：镜像成功即解除该组 fail-closed；
   * 失败显式处理（吊销旧令牌 + 告警事件 + 组级 fail-closed），杜绝 catch(() => undefined) 静默。
   */
  private async mirrorTokenPolicySafe(group: ConnectorPermGroupRecord): Promise<void> {
    try {
      await this.mirrorTokenPolicy(group)
      this.mirrorFailureGroups.delete(group.id)
    } catch (error) {
      await this.handleMirrorFailure(group, error)
    }
  }

  /**
   * 镜像失败处置（OPT-P1-05，审计核验 #10 升级项）：收紧权限后旧 oct_ 令牌短期仍有效会
   * 放大 TOCTOU 窗口——失败即吊销该组旧运行时令牌 + 发 connector.policy_mirror_failed 告警
   * + 该组 invoke fail-closed 直至镜像成功（巡检/下次变更自动尝试恢复）。
   */
  private async handleMirrorFailure(group: ConnectorPermGroupRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    this.mirrorFailureGroups.add(group.id)
    this.tokenValueCache.delete(group.id)
    await this.deleteTokenForGroup(group.id).catch(() => undefined)
    this.ctx.platformBus.emit(PlatformEvents.ConnectorPolicyMirrorFailed, {
      groupId: group.id, groupName: group.name, orgId: group.orgId, error: message, at: nowIso(),
    })
  }

  async mirrorTokenPolicy(group: ConnectorPermGroupRecord): Promise<{ tokenId: string; hash: string; changed: boolean }> {
    const client = this.clientForMirror()
    const snapshot = this.policySnapshot(group)
    const ledger = this.tokens().findOne((item) => item.permGroupId === group.id)
    if (!ledger) {
      const minted = await client.createRuntimeToken({
        name: `dsh-${group.id}`,
        allowedActions: snapshot.allowedActions,
        blockedActions: snapshot.blockedActions,
        allowedProxies: snapshot.allowedProxies,
        allowedConnections: snapshot.allowedConnections,
      })
      if (!minted.id) throw new OcError('runtime_token_invalid', 'open-connector 未返回运行时令牌 id', undefined, 502)
      // OPT-P1-05：并发镜像去重——铸币 await 期间他方镜像可能已建账本，按组 upsert 而非盲目 insert
      const concurrentLedger = this.tokens().findOne((item) => item.permGroupId === group.id)
      if (concurrentLedger) {
        this.tokens().update(concurrentLedger.id, { ocTokenId: minted.id, policySnapshotHash: snapshot.snapshotHash, lastSyncedAt: nowIso() })
      } else {
        this.tokens().insert({
          id: newId('ctk'), permGroupId: group.id, ocTokenId: minted.id,
          policySnapshotHash: snapshot.snapshotHash, createdAt: nowIso(), lastSyncedAt: nowIso(),
        })
      }
      if (minted.token) this.tokenValueCache.set(group.id, minted.token)
      return { tokenId: minted.id, hash: snapshot.snapshotHash, changed: true }
    }
    if (ledger.policySnapshotHash !== snapshot.snapshotHash) {
      // PUT 四数组全发——上游不会因此丢既有 allowedConnections（P1 修正⑤确认项）
      await client.updateRuntimeToken(ledger.ocTokenId, {
        allowedActions: snapshot.allowedActions,
        blockedActions: snapshot.blockedActions,
        allowedProxies: snapshot.allowedProxies,
        allowedConnections: snapshot.allowedConnections,
      })
      this.tokens().update(ledger.id, { policySnapshotHash: snapshot.snapshotHash, lastSyncedAt: nowIso() })
      return { tokenId: ledger.ocTokenId, hash: snapshot.snapshotHash, changed: true }
    }
    this.tokens().update(ledger.id, { lastSyncedAt: nowIso() })
    return { tokenId: ledger.ocTokenId, hash: snapshot.snapshotHash, changed: false }
  }

  async deleteTokenForGroup(groupId: string): Promise<void> {
    const ledger = this.tokens().findOne((item) => item.permGroupId === groupId)
    if (!ledger) return
    try {
      await this.clientForMirror().deleteRuntimeToken(ledger.ocTokenId)
    } catch { /* 上游已删即目标达成 */ }
    this.tokens().remove(ledger.id)
    this.tokenValueCache.delete(groupId)
  }

  /** 取令牌值：内存命中 → 否则重启后惰性重铸（重铸语义而非找回，journal 决策①）。 */
  private async obtainOctToken(group: ConnectorPermGroupRecord): Promise<string> {
    const cached = this.tokenValueCache.get(group.id)
    if (cached) return cached
    const client = this.clientForMirror()
    const ledger = this.tokens().findOne((item) => item.permGroupId === group.id)
    const snapshot = this.policySnapshot(group)
    const minted = await client.createRuntimeToken({
      name: `dsh-${group.id}`,
      allowedActions: snapshot.allowedActions,
      blockedActions: snapshot.blockedActions,
      allowedProxies: snapshot.allowedProxies,
      allowedConnections: snapshot.allowedConnections,
    })
    if (ledger) {
      // 进程内丢失（重启）：旧 token 立即销毁防滞留
      await client.deleteRuntimeToken(ledger.ocTokenId).catch(() => undefined)
      this.tokens().update(ledger.id, { ocTokenId: minted.id, policySnapshotHash: snapshot.snapshotHash, lastSyncedAt: nowIso() })
    } else {
      // OPT-P1-05：铸币 await 期间他方镜像可能已建账本，按组 upsert 而非盲目 insert
      const racedLedger = this.tokens().findOne((item) => item.permGroupId === group.id)
      if (racedLedger) {
        this.tokens().update(racedLedger.id, { ocTokenId: minted.id, policySnapshotHash: snapshot.snapshotHash, lastSyncedAt: nowIso() })
      } else {
        this.tokens().insert({
          id: newId('ctk'), permGroupId: group.id, ocTokenId: minted.id,
          policySnapshotHash: snapshot.snapshotHash, createdAt: nowIso(), lastSyncedAt: nowIso(),
        })
      }
    }
    if (!minted.token) throw new OcError('runtime_token_invalid', '运行时令牌未返回一次性 token 值', undefined, 502)
    this.tokenValueCache.set(group.id, minted.token)
    return minted.token
  }

  // -- 授权判定（第一层核心） ---------------------------------------------------

  /** 找出命中主体的候选组（user_group 经 iam.resolveGroupMembers 展开；agent/app 直接比 id）。 */
  candidateGroups(caller: InvokeCaller): ConnectorPermGroupRecord[] {
    return this.permGroups().all().filter((group) =>
      group.subjects.some((subject) => {
        if (subject.type === 'user_group' && caller.type === 'user') {
          return this.ctx.iam.resolveGroupMembers(subject.id).some((user) => user.id === caller.id)
        }
        return subject.type === caller.type && subject.id === caller.id
      }))
  }

  /** 计划书 §2.4：pattern 命中 + riskCap ≥ action.riskLevel + readOnly/denyParams 强制（补齐 mcp 侧缺口）。 */
  authorizeAgainst(group: ConnectorPermGroupRecord, action: CatalogActionRecord, input: Record<string, unknown>): { ok: true; policy: ProviderPolicy } | { ok: false; reason: string } {
    const policy = group.policies[action.service]
    if (!policy) return { ok: false, reason: `权限组 ${group.name} 未配置 provider ${action.service} 的策略` }
    // '*' 可为字符串通配或数组元素（schema 允许两形态），归一后统一 pattern 匹配
    const rawAllowed: unknown = policy.allowedActions
    const patterns = rawAllowed === '*' ? ['*'] : Array.isArray(rawAllowed) ? rawAllowed : undefined
    if (!patterns) {
      return { ok: false, reason: `权限组 ${group.name} 的 allowedActions 形态非法：${JSON.stringify(rawAllowed)?.slice(0, 80)}（应为 '*' 或字符串数组）` }
    }
    const patternHit = patterns.some((pattern) => pattern === '*' || pattern === action.id
      || (pattern.endsWith('.*') && action.service === pattern.slice(0, -2)))
    if (!patternHit) return { ok: false, reason: `action ${action.id} 不在权限组 ${group.name} 的允许模式内` }
    if (rankOf(policy.riskCap) < rankOf(action.riskLevel)) {
      return { ok: false, reason: `action 风险级 ${action.riskLevel} 超出权限组 ${group.name} 的 riskCap ${policy.riskCap}` }
    }
    if (policy.constraints?.readOnly && action.riskLevel !== 'read') {
      return { ok: false, reason: `权限组 ${group.name} 为只读模式，action ${action.id}（${action.riskLevel}）被拒绝` }
    }
    for (const deniedKey of policy.constraints?.denyParams ?? []) {
      if (hasInputKey(input, deniedKey)) {
        return { ok: false, reason: `参数 ${deniedKey} 在权限组 ${group.name} 的 denyParams 内，已拦截` }
      }
    }
    return { ok: true, policy }
  }

  /** 授权校验独立入口（tools/REST 共用；原"七步链第③⑤步合一"口径随 billing 下线废止，OPT-P0-02）。 */
  authorize(caller: InvokeCaller, actionId: string, input: Record<string, unknown>, groups?: ConnectorPermGroupRecord[]): { ok: true; group: ConnectorPermGroupRecord; policy: ProviderPolicy; action: CatalogActionRecord } | { ok: false; reason: string } {
    const action = (() => {
      try {
        return this.requireAction(actionId)
      } catch {
        return undefined
      }
    })()
    if (!action) return { ok: false, reason: `action 不在纳管目录中：${actionId}` }
    const candidates = groups ?? this.candidateGroups(caller)
    if (candidates.length === 0) return { ok: false, reason: `主体 ${caller.name} 未被任何连接器权限组授权` }
    for (const group of candidates) {
      const verdict = this.authorizeAgainst(group, action, input)
      if (verdict.ok) return { ok: true, group, policy: verdict.policy, action }
    }
    return { ok: false, reason: candidates
      .map((group) => this.authorizeAgainst(group, action, input))
      .filter((verdict): verdict is Exclude<typeof verdict, { ok: true }> => !verdict.ok)
      .map((verdict) => verdict.reason)[0] ?? `action ${actionId} 不在任何命中组的授权范围` }
  }

  // -- 审批执行能力令牌（OPT-P1-02） -------------------------------------------

  /**
   * admin 高危审批执行器注册（OPT-P1-02）：执行器闭包经本方法定义在类内，
   * 能力令牌铸造（approvalCapabilityVault.mint，模块闭包持有）仅在批准后的续调瞬间发生——
   * 外部插件即便持有 ctx.connectorHub 也无法铸造或猜测令牌；返回值沿用 registerExecutor 的注销函数。
   */
  bindAdminActionExecutor(audit: {
    registerExecutor: (kind: string, executor: (payload: Record<string, unknown>, approverId: string) => Promise<unknown>) => () => void
  }): () => void {
    return audit.registerExecutor('connector.action.admin', async (payload) => {
      const callerPayload = (payload['caller'] ?? {}) as { type?: InvokeCaller['type']; id?: string; name?: string; actChain?: InvokeCaller['actChain'] }
      const caller: InvokeCaller = {
        type: callerPayload.type ?? 'user',
        id: callerPayload.id ?? '',
        name: callerPayload.name ?? '',
        ...(callerPayload.actChain?.length ? { actChain: callerPayload.actChain } : {}),
      }
      const actionId = String(payload['actionId'])
      const result = await this.invokeAction(caller, {
        actionId,
        input: (payload['input'] ?? {}) as Record<string, unknown>,
        ...(typeof payload['alias'] === 'string' && payload['alias'] ? { alias: payload['alias'] } : {}),
        approvalCapability: approvalCapabilityVault.mint(actionId, caller),
      })
      if (!result.ok) throw new Error(result.status === 'approval_required' ? '递归审批异常：不应再次生成审批单' : result.error)
      return { runId: result.runId, status: result.status, latencyMs: result.latencyMs }
    })
  }

  // -- invoke 网关（#5，六步链） ------------------------------------------------

  async invokeAction(caller: InvokeCaller, params: {
    actionId: string
    input?: Record<string, unknown>
    alias?: string
    dryRun?: boolean
    /** 审批执行能力令牌（OPT-P1-02）：仅类内部执行器闭包可铸造；REST/工具面不可达，伪造即 fail-closed。 */
    approvalCapability?: ApprovalExecutionCapability
  }): Promise<InvokeOutcome> {
    const started = Date.now()
    const input = params.input ?? {}

    // ③ 第一层授权（subject 匹配 + policy 校验；orgId 由命中组决定——journal 决策③）
    const verdict = this.authorize(caller, params.actionId, input)
    if (!verdict.ok) {
      this.emitDeniedEvent(caller, params.actionId, verdict.reason, started)
      return { ok: false, status: 'denied', error: verdict.reason, latencyMs: Date.now() - started }
    }
    const { group, policy, action } = verdict
    const authorizedHash = this.policySnapshot(group).snapshotHash // OPT-P1-05：授权时刻快照基线
    // OPT-P2-01：ODD 域内判定——声明了 odd 的组，离域调用拒绝并留痕（connector.odd_exit 落审计）
    if (group.odd) {
      const catalogSyncedAt = this.catalogSnapshotSyncedAt()
      const oddVerdict = inOdd(group.odd, { id: action.id, service: action.service }, { now: new Date(), catalogSyncedAt })
      if (!oddVerdict.in) {
        this.ctx.platformBus.emit(PlatformEvents.ConnectorOddExit, {
          groupId: group.id, groupName: group.name, orgId: group.orgId, actionId: action.id,
          callerId: caller.id, reasons: oddVerdict.reasons, at: nowIso(),
        })
        this.emitDeniedEvent(caller, params.actionId, `ODD 离域：${oddVerdict.reasons.join('；')}`, started)
        return { ok: false, status: 'denied', error: `调用超出该权限组的运营设计域（ODD）：${oddVerdict.reasons.join('；')}`, latencyMs: Date.now() - started }
      }
    }
    // 组级 fail-closed（OPT-P1-05）：镜像失败期间旧授权面不可用，直至镜像成功
    if (this.mirrorFailureGroups.has(group.id)) {
      const reason = '该权限组 oct_ 令牌策略镜像失败，fail-closed 直至镜像成功（connector.policy_mirror_failed 已告警）'
      this.emitDeniedEvent(caller, params.actionId, reason, started)
      return { ok: false, status: 'denied', error: reason, latencyMs: Date.now() - started }
    }

    // dry-run：通过授权即可给出影响面预览（CLI 冒烟与 UI 预演共用）
    if (params.dryRun) {
      return {
        ok: true, status: 'dry_run',
        preview: {
          actionId: action.id, service: action.service, riskLevel: action.riskLevel,
          permGroup: group.name, orgId: group.orgId,
          connections: policy.connections ?? [],
          readOnlyConstraint: Boolean(policy.constraints?.readOnly),
          note: '授权链前五步全部通过，dry-run 不执行真实调用',
        },
      }
    }

    // ④ 高危审批门禁：admin 级必须走 connector.action.admin 审批，approve 后执行器持一次性
    // 能力令牌（OPT-P1-02）续调。无令牌/伪造/过期/错配 → 一律开单（fail-closed）。
    // 相同（action+组+主体+输入哈希）的 pending 单直接复用，不重复开单。
    if (action.riskLevel === 'admin' && !approvalCapabilityVault.consume(params.approvalCapability, action.id, caller)) {
      // OPT-P2-02：敏感命名入参不入审批存储——admin 审批以原文 input 执行，掩码会以 *** 下发数据面，
      // 故携带敏感键的调用直接拒绝（fail-closed），提示调整入参。
      const sensitivePaths = scanSensitiveKeys(input)
      if (sensitivePaths.length > 0) {
        const reason = `入参携带敏感命名参数（${sensitivePaths.join('、')}）：admin 审批通道禁止敏感值入审批存储，请调整入参后重试（OPT-P2-02）`
        this.emitDeniedEvent(caller, params.actionId, reason, started)
        return { ok: false, status: 'denied', error: reason, latencyMs: Date.now() - started }
      }
      const reused = this.dedupeAdminApproval(group, action, caller, input)
      if (reused) {
        return { ok: false, status: 'approval_required', approvalId: reused.id, actionId: action.id, message: `已有待审的高危调用单：${reused.id}（批准后自动完成调用）` }
      }
      const approval = this.ctx.audit.createApproval({
        kind: 'connector.action.admin',
        // WP-10/L1（QA A-06）：L4 高危统一高风险——通过需二次确认 + 公司级终审标记
        riskLevel: 'high',
        title: `高危调用：${action.service}/${action.id}`,
        payload: {
          // 操作数据（action 入参）可入审批负载；provider 凭证绝不入——两段式连接审批同理
          actionId: action.id, service: action.service,
          inputHash: sha256Hex(JSON.stringify(input)),
          input,
          permGroupId: group.id, permGroupName: group.name, orgId: group.orgId,
          ...(params.alias ? { alias: params.alias } : {}),
          caller: { type: caller.type, id: caller.id, name: caller.name, actChain: caller.actChain },
        },
        requesterId: caller.id,
        requesterName: caller.name,
      })
      return {
        ok: false, status: 'approval_required', approvalId: approval.id, actionId: action.id,
        message: `action ${action.id} 为 admin 风险级，已生成审批单，批准后自动完成调用`,
      }
    }

    // ⑤ 滑动窗口限流：key=<permGroupId>:<callerType>:<callerId>
    const bucketKey = `${group.id}:${caller.type}:${caller.id}`
    const minuteMark = Date.now()
    const bucket = (this.rateBuckets.get(bucketKey) ?? []).filter((mark) => minuteMark - mark < 60_000)
    if (bucket.length >= group.rateLimitPerMin) {
      this.rateBuckets.set(bucketKey, bucket)
      this.countErrors(`限流触发：${bucketKey}`)
      return { ok: false, status: 'rate_limited', error: `触发限流：${group.rateLimitPerMin} 次/分钟`, latencyMs: Date.now() - started }
    }
    bucket.push(minuteMark)
    this.rateBuckets.set(bucketKey, bucket)

    // 连接级下线闸：指定别名或策略唯一绑定连接处于维护下线态 → 平台侧直接拒绝
    const effectiveAlias = params.alias ?? (policy.connections?.length === 1 ? policy.connections[0]! : undefined)
    if (effectiveAlias) {
      const boundRef = this.connections().findOne((item) => item.alias === effectiveAlias && item.ownerOrgId === group.orgId)
      if (!boundRef) {
        this.emitDeniedEvent(caller, params.actionId, `连接不存在或不属于本组织：${effectiveAlias}`, started)
        return { ok: false, status: 'denied', error: `连接不存在或不属于本组织：${effectiveAlias}`, latencyMs: Date.now() - started }
      }
      if (boundRef.offlinedAt) {
        this.emitDeniedEvent(caller, params.actionId, `连接已下线：${effectiveAlias}（${boundRef.errorReason ?? ''}）`, started)
        return { ok: false, status: 'denied', error: `连接已下线：${effectiveAlias}`, latencyMs: Date.now() - started }
      }
    }

    // ⑦ 取/铸 oct_ 令牌 + 数据面执行（含 401/connection_not_allowed 自动恢复，P1 修正⑥）
    try {
      const octToken = await this.obtainOctToken(group)
      // 执行侧快照哈希校验（OPT-P1-05 轻量两阶段）：授权与执行间隔内权限组被收紧/策略漂移
      // → 拒绝按旧快照执行并发 connector.policy_snapshot_drifted；调用方重试即按新快照重走授权。
      const freshGroup = this.permGroups().get(group.id)
      const currentHash = freshGroup ? this.policySnapshot(freshGroup).snapshotHash : undefined
      const ledgerHash = this.tokens().findOne((item) => item.permGroupId === group.id)?.policySnapshotHash
      if (!freshGroup || currentHash !== authorizedHash || (ledgerHash !== undefined && ledgerHash !== currentHash)) {
        this.ctx.platformBus.emit(PlatformEvents.ConnectorPolicySnapshotDrifted, {
          groupId: group.id, groupName: group.name, actionId: action.id,
          authorizedHash, currentHash, ledgerHash, callerId: caller.id, at: nowIso(),
        })
        this.emitDeniedEvent(caller, params.actionId, `权限组策略在授权后变更（快照漂移 ${authorizedHash.slice(0, 8)}→${currentHash ? currentHash.slice(0, 8) : 'deleted'}），拒绝按旧快照执行`, started)
        return { ok: false, status: 'denied', error: '权限组策略在授权后发生变更（快照漂移），已拒绝执行：请重试以按最新策略重新授权', latencyMs: Date.now() - started }
      }
      const idempotencyKey = action.riskLevel === 'read' ? undefined : crypto.randomUUID()
      const chosenAlias = effectiveAlias
      const outcome = await this.executeWithRecovery(group, action, {
        input, alias: chosenAlias, idempotencyKey,
      }, octToken)

      // 数据面信封：统计平台审计补记边缘情形（meta.auditPersisted=false，P1 修正⑧）
      const auditPersisted = outcome.meta['auditPersisted'] !== false
      const runId = typeof outcome.meta['executionId'] === 'string' ? outcome.meta['executionId'] as string : newId('run')

      // 收尾：usage.record 为计费事实源（幂等键=connector:<runId>，trace_id=executionId）
      let metered = true
      try {
        this.ctx.usage.record({
          org: group.orgId,
          subject: `${caller.type}:${caller.id}`,
          principal: `org:${group.orgId}`,
          resource: `connector:${action.service}`,
          meters: [{ key: 'calls', value: 1, unit: '次' }],
          idempotency_key: `connector:${runId}`,
          trace_id: runId,
        })
      } catch (error) {
        metered = false
        this.ctx.logger('connector').warn('usage 计量登记失败', error)
      }
      if (!metered) {
        this.countErrors(`计量失败：connector:${action.service}`)
      }
      this.noteSuccessSignal()

      // 补记 + 低阈告警（T-28）
      if (!auditPersisted) {
        this.ctx.audit.record({
          type: 'invoke', actorType: caller.type === 'user' ? 'human' : 'machine',
          actorId: caller.id, actorName: caller.name,
          action: 'connector.invoke.recovered-audit', resourceType: 'connector_action',
          resourceId: runId, resourceName: `${action.service}/${action.id}`,
          result: 'ok',
          detail: `sidecar 报 auditPersisted=false，结果有效但上游审计未落库——平台补记本条（runId=${runId}）`,
          ...(caller.actChain?.length ? { actChain: caller.actChain } : {}),
        })
        this.countErrors(`auditPersisted=false 补记：${runId}`)
      }

      // invoke 审计事件（audit 插件订阅落 invoke 日志，透传 actChain + runId）
      const finalLatencyMs = Date.now() - started
      this.ctx.platformBus.emit(PlatformEvents.ConnectorInvoked, {
        ok: true, service: action.service, actionId: action.id, runId,
        serviceRisk: action.riskLevel, permGroupId: group.id,
        callerType: caller.type, callerId: caller.id, callerName: caller.name,
        latencyMs: finalLatencyMs, actChain: caller.actChain,
        auditPersisted, metered,
      })
      // 延迟告警口径：单次耗时直评（规则播种见 seedConnectorDemo 的 connector_latency 条目）
      this.ctx.audit.evaluateAlerts('connector_latency', {
        value: finalLatencyMs,
        resourceType: 'connector_action',
        resourceId: action.id,
        service: action.service,
        permGroupId: group.id,
      })

      return {
        ok: true, status: 'ok', runId, latencyMs: Date.now() - started,
        data: outcome.data, meta: outcome.meta, metered,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.noteBusinessFailure(message)
      this.emitDeniedEvent(caller, params.actionId, message, started, true)
      const code = error instanceof OcError ? error.code : 'execute_failed'
      return { ok: false, status: 'error', error: message, latencyMs: Date.now() - started, code }
    }
  }

  /** 复用同意图 pending 审批单，防止重复开单轰炸审批中心。 */
  private dedupeAdminApproval(group: ConnectorPermGroupRecord, action: CatalogActionRecord, caller: InvokeCaller, input: Record<string, unknown>): ApprovalLike | undefined {
    const inputHash = sha256Hex(JSON.stringify(input))
    return this.ctx.audit.approvals().find((item) =>
      item.kind === 'connector.action.admin' && item.status === 'pending'
      && (item as { requesterId?: string }).requesterId === caller.id
      && String((item.payload as Record<string, unknown>)['actionId'] ?? '') === action.id
      && String((item.payload as Record<string, unknown>)['permGroupId'] ?? '') === group.id
      && String((item.payload as Record<string, unknown>)['inputHash'] ?? '') === inputHash)[0]
  }

  /** 执行包装：401/connection_not_allowed → 按最新快照 PUT 更新令牌后重试一次（P1 修正⑥）。 */
  private async executeWithRecovery(
    group: ConnectorPermGroupRecord,
    action: CatalogActionRecord,
    options: { input: Record<string, unknown>; alias?: string; idempotencyKey?: string },
    octToken: string,
  ): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    const attempt = async (token: string) => {
      const { client } = this.requireClient()
      return await client.executeAction(action.id, options, token)
    }
    try {
      const outcome = await attempt(octToken)
      return { data: outcome.data, meta: outcome.meta }
    } catch (error) {
      const recoverable = error instanceof OcError && (error.code === 'connection_not_allowed' || error.code === 'unauthorized' || error.status === 401)
      if (!recoverable) throw error
      // 自动恢复：镜像最新快照（新连接合入 allowedConnections 等）后取最新令牌重试一次
      await this.mirrorTokenPolicySafe(group)
      if (this.mirrorFailureGroups.has(group.id)) throw error // 镜像仍失败：fail-closed，不携带旧授权面重试（OPT-P1-05）
      this.tokenValueCache.delete(group.id)
      const freshToken = await this.obtainOctToken(group)
      try {
        const retried = await attempt(freshToken)
        return { data: retried.data, meta: retried.meta }
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : String(retryError)
        this.countErrors(`自动恢复重试仍失败：${message}`)
        throw retryError
      }
    }
  }

  private emitDeniedEvent(caller: InvokeCaller, actionId: string, reason: string, startedAt: number, isError = false): void {
    this.ctx.platformBus.emit(PlatformEvents.ConnectorInvoked, {
      ok: false, actionId, service: actionId.split('.')[0] ?? '',
      callerType: caller.type, callerId: caller.id, callerName: caller.name,
      error: reason, latencyMs: Date.now() - startedAt, actChain: caller.actChain, failed: isError,
    })
  }

  /** 失败率计数 + 告警评估（evaluateAlerts 读 context.value）。 */
  private errorCounter = new Map<string, number[]>()

  private countErrors(label: string): void {
    const key = 'connector_error_rate'
    const times = (this.errorCounter.get(key) ?? []).filter((mark) => Date.now() - mark < 10 * 60_000)
    times.push(Date.now())
    this.errorCounter.set(key, times)
    this.ctx.audit.evaluateAlerts(key, {
      value: times.length, label,
      resourceType: 'connector_hub',
      resourceId: 'gateway',
    })
  }

  /** 真实调用失败计入延迟探活之外的失败率（metricsOnly，不开熔断）。 */
  private noteBusinessFailure(message: string): void {
    this.countErrors(message.slice(0, 120))
  }

  // -- 定时任务（#7 巡检 / #11 对账） -------------------------------------------

  /** 组织巡检 + 可选目录漂移自动同步（PATROL_INTERVAL）。 */
  async runPatrols(autoCatalog: boolean | undefined): Promise<{ violations: Array<Record<string, unknown>>; catalogDrift?: Record<string, unknown> }> {
    const violations: Array<Array<Record<string, unknown>>> = []
    const groupViolations: Array<Record<string, unknown>> = []
    void violations
    const status = this.gatewayStatus()
    if (!status.available) return { violations: groupViolations }
    const { client } = this.requireClient()
    const [remoteTokens, remoteConnections] = await Promise.all([client.listRuntimeTokens(), client.listConnections()])
    const remoteById = new Map(remoteTokens.filter((token) => token.id).map((token) => [token.id, token]))
    const connectionsById = new Map(remoteConnections.filter((item) => item.id).map((item) => [item.id, item]))
    for (const group of this.permGroups().all()) {
      const ledger = this.tokens().findOne((item) => item.permGroupId === group.id)
      if (!ledger) continue
      const token = remoteById.get(ledger.ocTokenId)
      if (!token) {
        groupViolations.push({ kind: 'token_missing_on_sidecar', groupId: group.id, name: group.name, ocTokenId: ledger.ocTokenId })
        continue
      }
      const bound = Array.isArray(token.policy && (token.policy as Record<string, unknown>)['allowedConnections'])
        ? ((token.policy as Record<string, unknown>)['allowedConnections'] as string[])
        : []
      for (const connectionId of bound) {
        const conn = connectionsById.get(connectionId)
        const belongsToOrg = conn
          ? this.connections().findOne((item) => item.ocConnectionId === connectionId && item.ownerOrgId === group.orgId) !== undefined
            || (conn.connectionName ?? '').startsWith(`org:${group.orgId}:`)
          : this.connections().findOne((item) => item.ocConnectionId === connectionId && item.ownerOrgId === group.orgId) !== undefined
        if (!belongsToOrg) {
          groupViolations.push({
            kind: 'token_binds_foreign_connection', groupId: group.id, name: group.name,
            ocTokenId: ledger.ocTokenId, connectionId,
            alias: conn?.connectionName ?? '',
            expectedPrefix: `org:${group.orgId}:`,
          })
        }
      }
    }
    if (groupViolations.length > 0) {
      this.ctx.platformBus.emit(PlatformEvents.ConnectorGatewaySynced, {
        kind: 'org_patrol', violations: groupViolations, at: nowIso(),
      })
      this.ctx.audit.fire({
        severity: 'warning',
        title: '[连接器 org 巡检] 令牌绑定越界',
        message: `发现 ${groupViolations.length} 处「令牌绑定连接 ∉ 组内 org」不一致：${JSON.stringify(groupViolations).slice(0, 220)}`,
        resourceType: 'connector_gateway',
      })
    }
    let catalogDrift: Record<string, unknown> | undefined
    const record = this.gateways().all()[0]
    const shouldSyncCatalog = autoCatalog ?? ((record?.autoCatalogSyncMinutes ?? 0) > 0)
    if (shouldSyncCatalog) {
      try {
        const syncResult = await this.syncCatalog('patrol')
        catalogDrift = { added: syncResult.added, removed: syncResult.removed, skippedServices: syncResult.skippedServices }
      } catch (error) {
        catalogDrift = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { violations: groupViolations, ...(catalogDrift !== undefined ? { catalogDrift } : {}) }
  }

  /**
   * runs 对账（#11，P1 修正⑦）：usage.record 为计费事实源；本任务按 runtimeTokenId 做
   * 总量交叉校验 + 盗用检测——有 run 无 meter 即绕行告警（critical，人工复核不自动处置）。
   * cursor 增量 + run id 去重（重叠窗口安全）；对账周期默认 5 分钟 ≪ RUN_LIMIT 轮转窗口。
   */
  async reconcileRuns(options: { maxPages?: number } = {}): Promise<{ checkedRuns: number; bypassRuns: string[]; knownTokens: number; matchedMeters: number; cursor?: string }> {
    const status = this.gatewayStatus()
    if (!status.available) return { checkedRuns: 0, bypassRuns: [], knownTokens: 0, matchedMeters: 0 }
    const { client } = this.requireClient()
    const stateCollection = this.runsState()
    let state = stateCollection.findOne((item) => item.key === 'reconcile')
    if (!state) {
      state = stateCollection.insert({ id: newId('crn'), key: 'reconcile', processedIds: [], createdAt: nowIso(), updatedAt: nowIso() })
    }
    const processed = new Set(state.processedIds ?? [])
    const ledgers = this.tokens().all()
    const managedTokenIds = new Set(ledgers.map((item) => item.ocTokenId))
    const bypassRuns: string[] = []
    let checked = 0
    let matched = 0
    let cursor = state.cursor
    const maxPages = options.maxPages ?? 10
    for (let page = 0; page < maxPages; page++) {
      const response = await client.listRuns({ limit: 200, ...(cursor ? { cursor } : {}) })
      for (const run of response.items) {
        if (!run.id || processed.has(run.id)) continue
        processed.add(run.id)
        if (run.runtimeTokenId && managedTokenIds.has(run.runtimeTokenId)) {
          checked++
          const meterCount = countUsageByTrace(this.ctx, run.id)
          if (meterCount > 0) matched++
          else bypassRuns.push(run.id)
        }
      }
      cursor = response.nextCursor
      if (!response.nextCursor || response.items.length === 0) break
    }
    const trimmed = [...processed].slice(-PROCESSED_RUN_CAP)
    stateCollection.update(state.id, { cursor, processedIds: trimmed, lastRunAt: nowIso(), updatedAt: nowIso() })
    if (bypassRuns.length > 0) {
      this.ctx.audit.fire({
        severity: 'critical',
        title: '[连接器对账] 绕行调用（有 run 无 meter）',
        message: `检测到 ${bypassRuns.length} 条经平台铸造令牌的 sidecar run 无对应 usage 计量：${bypassRuns.slice(0, 20).join(', ')}`,
        resourceType: 'connector_reconcile',
      })
    }
    return { checkedRuns: checked, bypassRuns, knownTokens: managedTokenIds.size, matchedMeters: matched, ...(cursor ? { cursor } : {}) }
  }

  /** runs 视图（控制台/CLI 只读展示；不做处置建议，人工复核）。 */
  async listRunsView(params: { limit?: number; service?: string; ok?: boolean } = {}): Promise<{ items: OcRunLog[]; knownTokens: number }> {
    if (!this.gatewayStatus().available) return { items: [], knownTokens: 0 }
    const { client } = this.requireClient()
    const page = await client.listRuns({ limit: Math.min(params.limit ?? 100, 500), ...(params.service ? { service: params.service } : {}), ...(params.ok !== undefined ? { ok: params.ok } : {}) })
    return { items: page.items, knownTokens: this.tokens().count() }
  }
}

// ---------------------------------------------------------------------------
// 模块级辅助
// ---------------------------------------------------------------------------

const OC_DEFAULT_TIMEOUT = 15_000

/** top-level 键与点路径通吃的 denyParams 拦截。 */
function hasInputKey(input: Record<string, unknown>, deniedKey: string): boolean {
  if (Object.hasOwn(input, deniedKey)) return true
  if (!deniedKey.includes('.')) return false
  let node: unknown = input
  for (const segment of deniedKey.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node as Record<string, unknown>, segment)) return false
    node = (node as Record<string, unknown>)[segment]
  }
  return true
}

function countUsageByTrace(ctx: Context, traceId: string): number {
  const rows = ctx.txnStore.sql<{ n: number }>('SELECT COUNT(*) AS n FROM usage_events WHERE trace_id = ?', [traceId])
  return Number(rows[0]?.n ?? 0)
}

function normalizeAuthType(value: string): ConnectionReferenceRecord['authType'] {
  if (value === 'oauth' || value === 'oauth2' || value === 'bearer_config') return 'oauth'
  if (value === 'custom_credential') return 'custom_credential'
  if (value === 'no_auth' || value === 'none') return 'no_auth'
  return 'api_key'
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    connectorHub: ConnectorHubService
  }
}

export const name = 'connector'
export const inject = ['opsStorage', 'platformBus', 'iam', 'audit', 'usage', 'txnStore', 'authn', 'resourceCore']

export function apply(ctx: Context) {
  // 与 plugin-mcp 相同的装配形态：构造即注册（provide='connectorHub'），
  // 审批执行器闭包直接持实例引用——避免执行器跨插件访问 ctx.connectorHub 的注入校验问题。
  const hub = new ConnectorHubService(ctx)
  // 部署后迁移前置：生产存量角色不会因 BuiltinRoles 只插不改而获得 connector.* 权限点，
  // 插件装配期执行一次性幂等迁移（iam 侧实现，先例 agent-scopes-usage-write-v1 思路）。
  try {
    ctx.iam.ensureConnectorPermissionsMigration()
  } catch (error) {
    ctx.logger('connector').warn('角色权限迁移暂缓（iam 未就绪时宿主会重新依赖解析）', error)
  }
  ctx.effect(() => ctx.audit.registerExecutor('connector.offline', async (payload) => {
    // 计划书 §2.7：连接/网关下线走 L4 审批，通过后 executor 落地
    const scope = String(payload['scope'] ?? 'gateway')
    const reason = String(payload['reason'] ?? '审批通过下线')
    if (scope === 'connection') {
      const ref = await hub.offlineConnection(String(payload['connectionId'] ?? ''), { actorName: 'approval-center', reason })
      return { scope, connectionId: ref.id, alias: ref.alias, status: ref.status }
    }
    const record = await hub.offlineGateway(reason)
    return { scope: 'gateway', status: record?.status, baseUrl: record?.baseUrl }
  }))
  ctx.effect(() => ctx.audit.registerExecutor('connector.connect', async (payload) => {
    // 两段式设计（journal 决策②）：凭证绝不入审批负载——通过即登记，实际创建由发起人携 approvalId 完成
    return { acknowledged: true, note: '审批通过：发起人现在可以提交实际连接凭证（POST /api/connector/connections/* 带 approvalId）', provider: payload['provider'] ?? '' }
  }))
  // admin 高危审批执行器（OPT-P1-02）：注册收敛进类内部 bindAdminActionExecutor，
  // 能力令牌铸造 #私有化——外部插件不可达（原布尔旁路参数已删除，全仓 grep 0 命中为验收口径）
  ctx.effect(() => hub.bindAdminActionExecutor(ctx.audit))
  ctx.plugin(connectorTools)
}
