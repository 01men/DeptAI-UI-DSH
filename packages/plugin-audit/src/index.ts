/**
 * @dsh-ops/plugin-audit —— 安全与审计（贯穿各模块，方案 §七）。
 *
 * - 四类审计日志：认证 / 授权 / 调用 / 变更，统一 schema、只追加。
 * - 告警规则引擎：阈值/异常模式声明式配置，事件驱动评估。
 * - 成本归集：按令牌链归集 Token 消耗，应用/组织维度穿透。
 * - 审批中心：全平台 L4 高危操作汇聚（Skill 上架、Agent 上线、下线/吊销/删除）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents, newId, sha256Hex, scanSensitiveKeys, maskSensitivePayload, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'
import * as auditTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export type AuditType = 'auth' | 'authz' | 'invoke' | 'change'

/**
 * 结论级证据锚点（IAW 交接 5-1，additive）：Agent 结论与数据事实的绑定单元。
 * kind 值域：dataset 数据集 / field 字段 / window 时间窗 / query 命中行 / doc 文档。
 */
export interface EvidenceAnchor {
  kind: 'dataset' | 'field' | 'window' | 'query' | 'doc'
  /** 引用标识：数据集编号 / 字段路径 / 查询 id 等（生产方契约）。 */
  id: string
  name?: string
  /** 时间窗锚点（window/query 类）：结论所依据的数据区间。 */
  timeWindow?: { from: string; to: string }
  /** 命中行数（query 类）。 */
  hitRows?: number
  /** 引用时点质量分 0-100（dataset/field 类，登记快照不回写）。 */
  qualityScore?: number
}

export interface AuditLogRecord extends RecordBase {
  type: AuditType
  actorType: 'human' | 'machine' | 'system'
  actorId: string
  actorName: string
  action: string
  resourceType: string
  resourceId: string
  resourceName: string
  result: 'ok' | 'denied' | 'error'
  detail: string
  actChain?: Array<{ name: string; type: string }>
  /** 场景维度（IAW 交接 5-2，additive）：面板任务/诊断等带场景编号的动作落此维度，供审计时间线反查。 */
  sceneCode?: string
  /** 证据锚点（IAW 交接 5-1，additive）：直接内联（invoke 类结论事件）或引用证据登记 id。 */
  evidence?: EvidenceAnchor[]
  evidenceIds?: string[]
  // -- 冷热分层与哈希链（W3-T5，契约 §14，additive） --
  /** 全链 trace id（可选）：MCP 网关调用等带 trace 的事件随记录落此维度，GET /api/audit/logs?traceId= 精确检索。 */
  traceId?: string
  /** 哈希链前驱（record() 单点计算）：链首记录为空串。 */
  prevHash?: string
  /** 本记录哈希：sha256(prevHash + canonicalJSON(本记录业务字段))——canonicalJSON 键序稳定，
   *  且排除 createdAt/updatedAt（insert 期注入，非业务事实）与 prevHash/hash 自身；校验口径见 record()。 */
  hash?: string
  /** 策略决策 id（W3-T5 契约 §11/§16，additive）：PDP 裁决 id（pd_ 前缀）——回答「为什么被允许」。
   *  与 mcp:calls 的热数据同源；热数据滚动清理后审计侧仍可回查决策依据。 */
  decisionId?: string
  /** 策略决策原因（结构化文本，additive）：deny 原因可检索（如 ORG_SCOPE_DENIED / RISK_UNREGISTERED）。 */
  decisionReasons?: string[]
}

/** 证据登记（IAW 交接 5-1）：锚点包独立落库发 id，会话消息/审计事件以 evidenceId 引用。 */
export interface EvidenceRecord extends RecordBase {
  sceneCode?: string
  /** 绑定的会话消息（dsh 消息 id）与频道（可选）。 */
  messageId?: string
  sessionId?: string
  /** 结论主体（user:<id> / agent:<id>）。 */
  subject?: string
  anchors: EvidenceAnchor[]
  note?: string
}

export interface AlertRuleRecord extends RecordBase {
  name: string
  /** mcp_error_rate | mcp_latency | token_burst | agent_anomaly | permission_denied */
  metric: string
  operator: 'gt'
  threshold: number
  windowMinutes: number
  severity: 'critical' | 'warning' | 'info'
  channels: string[]
  enabled: boolean
  description?: string
}

export interface AlertEventRecord extends RecordBase {
  ruleId?: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  message: string
  resourceType?: string
  resourceId?: string
  read: boolean
}

export interface CostRecord extends RecordBase {
  date: string
  appId?: string
  agentId?: string
  mcpServiceId?: string
  /** 连接器纳管资源归集维度（connector:<service> 的 service 段）。 */
  connectorService?: string
  llmTokens: number
  toolCalls: number
  costYuan: number
  /**
   * 计价覆盖率（#14 additive）：priced=费率在配的事件数；notPriced=因费率未配置/全零费率
   * 而零成本的事件数。下游不得把 0 成本读成「无消耗」——覆盖率是门禁判断「成本是否可归集」的依据。
   * 存量记录无此两字段（缺省按 0 计，不计入覆盖率分母）。
   */
  pricedEvents?: number
  notPricedEvents?: number
  /**
   * 存量未计数标记（#14 复核 additive）：覆盖率字段引入前已聚合的桶，既有 portion 的
   * priced/notPriced 不可知（事件级权威口径见 /api/usage/summary 的零费率快照识别）。
   * costReport 据此把行标为 coverage=legacy/mixed，门禁不再把「存量未知」误读成「在档 0」。
   */
  legacyUncounted?: boolean
}

export interface ApprovalRecord extends RecordBase {
  kind: string
  title: string
  payload: Record<string, unknown>
  requesterId: string
  requesterName: string
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed'
  approverId?: string
  approverName?: string
  opinion?: string
  createdAt: string
  decidedAt?: string
  execution?: { result: string; error?: string; at: string }
  /** 风险级（WP-10/L1）：high 级审批通过需二次确认（服务端强制），且默认落公司级终审标记。 */
  riskLevel?: 'high' | 'medium' | 'low'
  /** 公司级终审标记（WP-10/L1，additive）：终审人与时间在审计可追溯（action=approval.final_review）。 */
  finalReview?: { approverId: string; approverName: string; at: string }
  /** 组织归属（R11 多公司收口，2026-10-14）：审批单按组织子树过滤的数据源。
   *  agent.* 类单由 createApproval 从 payload.agentId 自动推导；存量单无此字段对非 `*` 不可见。 */
  orgId?: string
}

export type ApprovalExecutor = (payload: Record<string, unknown>, approverId: string) => Promise<unknown>

// ---------------------------------------------------------------------------
// 哈希链（W3-T5，契约 §14）：canonicalJSON（键序稳定序列化）
// ---------------------------------------------------------------------------

/**
 * canonicalJSON：递归键排序的稳定序列化（同一条记录任意时刻重算结果逐字节一致）。
 * 数组保序；exclude 键（如 hash 自身）在对象层剔除。
 */
export function canonicalJson(value: unknown, exclude: string[] = []): string {
  const skip = new Set(exclude)
  const walk = (input: unknown): string => {
    if (input === null) return 'null'
    if (input === undefined) return 'null'
    if (typeof input !== 'object') return JSON.stringify(input) ?? 'null'
    if (Array.isArray(input)) return `[${input.map(walk).join(',')}]`
    // 键序稳定 + 与 JSON.stringify 语义对齐：值为 undefined 的键直接跳过（JSON 落盘同样丢弃
    // 该键）。若渲染为 null，则「内存对象重算的哈希」与「落盘记录重算的哈希」分叉——
    // 哈希链对最关键的 MCP 调用记录将不可校验（W4 安全审计 P0-1 根因）。
    const keys = Object.keys(input as Record<string, unknown>)
      .filter((key) => !skip.has(key) && (input as Record<string, unknown>)[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${walk((input as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return walk(value)
}

/** 审计哈希链记录参与哈希的字段口径：业务字段全量，排除落库期注入的 createdAt/updatedAt 与链字段自身。 */
const AUDIT_HASH_EXCLUDE = ['createdAt', 'updatedAt', 'prevHash', 'hash']

/** 按记录重算哈希（校验面与写入面单点同源）：sha256(prevHash + canonicalJSON(业务字段))。 */
export function auditHashOf(record: { prevHash?: string; hash?: string; [key: string]: unknown }, prevHash: string): string {
  return sha256Hex(prevHash + canonicalJson(record, AUDIT_HASH_EXCLUDE))
}

// ---------------------------------------------------------------------------
// 审批负载卫生与独立规则源（OPT-P2-02，2026-09-12）
// ---------------------------------------------------------------------------

/**
 * 独立最小化规则源（OPT-P2-02）：审批执行约束独立于主授权判定。
 * ⚠ 共享故障域声明：同进程同权限同代码——本表不构成密码学级"独立保护"，
 *   只是把二次确认/敏感面口径从执行器实现抽出为可评审、可 diff 的静态工件
 *   （完整声明见 docs/shared-failure-domain-declaration.md）。
 */
export interface ApprovalKindRule {
  /** 高风险通过是否必须显式二次确认（缺省沿用 riskLevel==='high' 的既有口径）。 */
  requiresConfirmed?: boolean
  /** 敏感入参面：mask=掩码后入库；reject=直接拒绝开单（适用于执行需要原文的 kind）。 */
  sensitiveInputPolicy: 'mask' | 'reject'
}

const APPROVAL_KIND_RULES: Record<string, ApprovalKindRule> = {
  // 连接器 admin 续调需要原文 input 执行——敏感入参不能掩码（会以 *** 下发数据面），只能拒绝开单
  'connector.action.admin': { sensitiveInputPolicy: 'reject' },
  'connector.connect': { sensitiveInputPolicy: 'mask' },
  'connector.offline': { sensitiveInputPolicy: 'mask' },
}

export function approvalKindRule(kind: string): ApprovalKindRule {
  return { sensitiveInputPolicy: 'mask', ...APPROVAL_KIND_RULES[kind] }
}

/**
 * L4 高危审批缺省即 high（QA A-06）：连接器网关下线/建连/admin 续调、MCP 下线、NAS 分享、
 * 面板卡片动作与行业激活此前未标 riskLevel:'high'——一次 approve 即执行、无二次确认，
 * 与 WP-10「高危操作需显式二次确认」口径冲突。中央闸兜底：调用方未显式声明时按 high 落库。
 */
const HIGH_RISK_APPROVAL_KINDS = new Set([
  'connector.offline', 'connector.connect', 'connector.action.admin',
  'mcp.offline', 'nas.share', 'panel.card-action', 'industry.activation',
])

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class AuditService extends Service {
  static readonly provide = 'audit'

  private executors = new Map<string, ApprovalExecutor>()
  /** 补偿注册表（OPT-P2-02）：kind → 不可逆动作失败后的补偿编排。 */
  private compensations = new Map<string, (payload: Record<string, unknown>, error: Error) => Promise<unknown>>()
  private deniedCounter = new Map<string, number[]>()
  /** REL-11 读侧加固：已发过 warning 的脏成本资源（进程内去重，防告警风暴）。 */
  private warnedDirtyCostResources = new Set<string>()
  /** 哈希链链首（W3-T5 §14）：启动时取集合最后一条的 hash 续链（重启不破链）。 */
  private chainTip = ''
  private chainReady = false

  constructor(ctx: Context) {
    super(ctx, 'audit')

    // 事件驱动的审计埋点：各模块状态变更自动落审计日志
    const auditOf = (type: AuditType, action: string, result: AuditLogRecord['result'] = 'ok') =>
      (payload: unknown): void => {
        const p = payload as Record<string, any>
        this.record({
          type,
          actorType: p.actorType ?? 'system',
          actorId: p.actor ?? 'system',
          actorName: p.actorName ?? 'system',
          action,
          resourceType: p.type ?? action.split('.')[0],
          resourceId: p.id ?? p.jti ?? p.serviceId ?? '',
          resourceName: p.name ?? p.slug ?? p.title ?? '',
          result,
          detail: p.reason ?? p.note ?? JSON.stringify(payload).slice(0, 300),
        })
      }

    ctx.platformBus.on(PlatformEvents.TokenIssued, auditOf('auth', 'authn.token.issue'))
    ctx.platformBus.on(PlatformEvents.TokenRevoked, auditOf('auth', 'authn.token.revoke'))
    ctx.platformBus.on(PlatformEvents.UserFrozen, (payload) => {
      const p = payload as { userId: string; username: string; reason: string }
      this.record({
        type: 'change', actorType: 'system', actorId: 'iam-sync', actorName: 'IAM 联动',
        action: 'iam.user.freeze', resourceType: 'user', resourceId: p.userId, resourceName: p.username,
        result: 'ok', detail: p.reason,
      })
    })
    ctx.platformBus.on(PlatformEvents.McpDeployed, auditOf('change', 'mcp.service.deploy'))
    ctx.platformBus.on(PlatformEvents.McpOfflined, auditOf('change', 'mcp.service.offline'))
    // W1-T2（MCP 治理 §6）：Secret Broker 凭证读取留痕（payload 仅 serviceId/credentialRef 元数据，零明文）
    ctx.platformBus.on(PlatformEvents.McpSecretAccess, auditOf('change', 'mcp.credential.access'))
    // 应用外部凭证托管（issue #19）：取值逐次留痕（payload 仅 appId/key/result 元数据，零明文）
    ctx.platformBus.on(PlatformEvents.AppSecretAccess, auditOf('change', 'app.credential.access'))
    // 资产使用凭证（2026-10-31）：Agent 提报使用事实逐次留痕（使用凭证=资产经营侧的重要证据）
    ctx.platformBus.on(PlatformEvents.UsageAssetReported, auditOf('invoke', 'asset.usage.report'))
    ctx.platformBus.on(PlatformEvents.McpUnhealthy, (payload) => {
      const p = payload as { serviceId: string; name: string; consecutiveFails: number }
      this.record({
        type: 'invoke', actorType: 'system', actorId: 'health-probe', actorName: '健康探活',
        action: 'mcp.service.unhealthy', resourceType: 'mcp_service', resourceId: p.serviceId, resourceName: p.name,
        result: 'error', detail: `连续失败 ${p.consecutiveFails} 次，触发熔断`,
      })
      this.evaluateAlerts('mcp_unhealthy', p)
    })
    ctx.platformBus.on(PlatformEvents.McpInvoked, (payload) => {
      const p = payload as { ok: boolean; latencyMs: number; serviceId: string; name: string; callerName: string; errorRate?: number; traceId?: string; decisionId?: string; decisionReasons?: string[]; status?: string }
      // 结果分档（W4 安全审计 P0-4）：策略拒绝（denied）与上游故障（error）必须可区分——
      // 否则「为什么被允许/拒绝」在审计里退化为同一种失败。
      const result: 'ok' | 'denied' | 'error' = p.ok ? 'ok' : p.status === 'denied' ? 'denied' : 'error'
      this.record({
        type: 'invoke', actorType: p.callerType ?? 'machine', actorId: p.callerId ?? '', actorName: p.callerName ?? '',
        action: 'mcp.gateway.invoke', resourceType: 'mcp_service', resourceId: p.serviceId, resourceName: p.name,
        result,
        detail: `latency=${p.latencyMs}ms${p.ok ? '' : result === 'denied' ? ' 策略拒绝' : ' 调用失败'}`,
        actChain: p.actChain,
        // 全链 trace（W3-T5 §14，可选维度）：随 mcp.invoked payload v2 落审计，支持 ?traceId= 还原调用链
        ...(p.traceId ? { traceId: p.traceId } : {}),
        // 决策依据（W3-T5 §11/§16）：allow/deny 均可回查「为什么被允许/拒绝」
        ...(p.decisionId ? { decisionId: p.decisionId } : {}),
        ...(p.decisionReasons?.length ? { decisionReasons: p.decisionReasons } : {}),
      })
    })
    // 连接器纳管（open-connector 融合）：invoke 日志透传 actChain + runId（runId 无独立字段，进 resourceId）
    ctx.platformBus.on(PlatformEvents.ConnectorInvoked, (payload) => {
      const p = payload as {
        ok?: boolean; service?: string; actionId?: string; runId?: string
        callerType?: string; callerId?: string; callerName?: string
        latencyMs?: number; error?: string; actChain?: Array<{ name: string; type: string }>
        auditPersisted?: boolean
      }
      this.record({
        type: 'invoke', actorType: p.callerType === 'user' ? 'human' : 'machine', actorId: p.callerId ?? '', actorName: p.callerName ?? '',
        action: 'connector.invoke', resourceType: 'connector_action', resourceId: p.runId ?? '', resourceName: `${p.service ?? ''}/${p.actionId ?? ''}`,
        result: p.ok ? 'ok' : 'error',
        detail: `run=${p.runId ?? ''} latency=${p.latencyMs ?? 0}ms${p.ok ? '' : ` 调用失败：${p.error ?? ''}`}${p.auditPersisted === false ? '（sidecar 审计未落库，平台已补记）' : ''}`,
        ...(p.actChain?.length ? { actChain: p.actChain } : {}),
      })
    })
    ctx.platformBus.on(PlatformEvents.ConnectorGatewayChanged, auditOf('change', 'connector.gateway.changed'))
    ctx.platformBus.on(PlatformEvents.ConnectorGatewayUnhealthy, (payload) => {
      const p = payload as { baseUrl?: string; consecutiveFails?: number; reason?: string }
      this.record({
        type: 'invoke', actorType: 'system', actorId: 'connector-probe', actorName: '连接器探活',
        action: 'connector.gateway.unhealthy', resourceType: 'connector_gateway', resourceId: 'gateway', resourceName: p.baseUrl ?? '',
        result: 'error', detail: `连续失败 ${p.consecutiveFails ?? 0} 次（fail-closed）：${p.reason ?? ''}`,
      })
    })
    ctx.platformBus.on(PlatformEvents.ConnectorConnected, auditOf('change', 'connector.connected'))
    ctx.platformBus.on(PlatformEvents.ConnectorDisconnected, auditOf('change', 'connector.disconnected'))
    ctx.platformBus.on(PlatformEvents.ConnectorPermGroupChanged, auditOf('change', 'connector.permgroup.changed'))
    // QA E-03：镜像失败类事件此前只走总线半程（audit 无订阅、无告警）——补齐审计留痕 + 告警接线
    ctx.platformBus.on(PlatformEvents.ConnectorPolicyMirrorFailed, (payload) => {
      const p = payload as { groupId?: string; groupName?: string; reason?: string }
      this.record({
        type: 'invoke', actorType: 'system', actorId: 'connector-patrol', actorName: '连接器巡检',
        action: 'connector.policy_mirror_failed', resourceType: 'connector_permgroup',
        resourceId: String(p.groupId ?? ''), resourceName: String(p.groupName ?? ''),
        result: 'error', detail: `策略镜像失败（fail-closed，旧运行时令牌已吊销）：${p.reason ?? ''}`,
      })
      this.fire({
        severity: 'critical',
        title: t('[连接器] 权限组策略镜像失败'),
        message: t('权限组「{name}」策略镜像至网关失败，已 fail-closed 并吊销旧运行时令牌：{reason}', { name: p.groupName ?? p.groupId ?? '?', reason: p.reason ?? '' }),
        resourceType: 'connector_permgroup', ...(p.groupId !== undefined ? { resourceId: p.groupId } : {}),
      })
    })
    ctx.platformBus.on(PlatformEvents.ConnectorPolicySnapshotDrifted, (payload) => {
      const p = payload as { groupId?: string; groupName?: string; reason?: string }
      this.record({
        type: 'invoke', actorType: 'system', actorId: 'connector-patrol', actorName: '连接器巡检',
        action: 'connector.policy_snapshot_drifted', resourceType: 'connector_permgroup',
        resourceId: String(p.groupId ?? ''), resourceName: String(p.groupName ?? ''),
        result: 'error', detail: `策略快照漂移（拒绝按旧快照执行）：${p.reason ?? ''}`,
      })
      this.fire({
        severity: 'warning',
        title: t('[连接器] 权限组策略快照漂移'),
        message: t('权限组「{name}」调用时检出策略快照漂移，本次调用已拒绝（重试即按新快照走授权）：{reason}', { name: p.groupName ?? p.groupId ?? '?', reason: p.reason ?? '' }),
        resourceType: 'connector_permgroup', ...(p.groupId !== undefined ? { resourceId: p.groupId } : {}),
      })
    })
    ctx.platformBus.on(PlatformEvents.ConnectorGatewaySynced, (payload) => {
      const p = payload as { kind?: string; violations?: unknown[] }
      this.record({
        type: 'change', actorType: 'system', actorId: 'connector-patrol', actorName: '连接器巡检',
        action: 'connector.gateway.synced', resourceType: 'connector_gateway', resourceId: String(p.kind ?? ''), resourceName: '',
        result: (p.violations?.length ?? 0) > 0 ? 'error' : 'ok',
        detail: JSON.stringify(payload).slice(0, 300),
      })
    })
    ctx.platformBus.on(PlatformEvents.SkillPublished, auditOf('change', 'skill.publish'))
    ctx.platformBus.on(PlatformEvents.SkillDeprecated, auditOf('change', 'skill.deprecate'))
    ctx.platformBus.on(PlatformEvents.SkillInstalled, auditOf('change', 'skill.install'))
    ctx.platformBus.on(PlatformEvents.AgentRegistered, auditOf('change', 'agent.register'))
    ctx.platformBus.on(PlatformEvents.AgentOnlined, auditOf('change', 'agent.online'))
    ctx.platformBus.on(PlatformEvents.AgentOfflined, auditOf('change', 'agent.offline'))
    ctx.platformBus.on(PlatformEvents.AppOnlined, auditOf('change', 'app.online'))
    ctx.platformBus.on(PlatformEvents.AppOfflined, auditOf('change', 'app.offline'))
    ctx.platformBus.on(PlatformEvents.AppArchived, auditOf('change', 'app.archive'))
    ctx.platformBus.on(PlatformEvents.OidcAuthorizeGranted, (payload) => {
      const p = payload as { reqId: string; clientId: string; clientName: string; userId: string; userName: string; scope: string }
      this.record({
        type: 'auth', actorType: 'human', actorId: p.userId, actorName: p.userName,
        action: 'oidc.authorize.granted', resourceType: 'oidc_client', resourceId: p.clientId, resourceName: p.clientName,
        result: 'ok', detail: `授权通过（scope：${p.scope}，req：${p.reqId.slice(0, 8)}…）`,
      })
    })
    ctx.platformBus.on(PlatformEvents.OidcAuthorizeDenied, (payload) => {
      const p = payload as { reqId: string; clientId: string; clientName: string; userId: string; userName: string }
      this.record({
        type: 'auth', actorType: 'human', actorId: p.userId, actorName: p.userName,
        action: 'oidc.authorize.denied', resourceType: 'oidc_client', resourceId: p.clientId, resourceName: p.clientName,
        result: 'denied', detail: `用户拒绝授权（req：${p.reqId.slice(0, 8)}…）`,
      })
    })
    ctx.platformBus.on(PlatformEvents.UpdateAvailable, (payload) => {
      const p = payload as { currentVersion: string; latestVersion: string; behindBy: number }
      this.record({
        type: 'change', actorType: 'system', actorId: 'update-checker', actorName: '平台更新检查',
        action: 'platform.update.available', resourceType: 'platform', resourceId: 'self', resourceName: '平台升级',
        result: 'ok', detail: `上游新版本 ${p.currentVersion} → ${p.latestVersion}${p.behindBy > 0 ? `（落后 ${p.behindBy} 提交）` : ''}`,
      })
    })
    ctx.platformBus.on(PlatformEvents.UpdateApplied, (payload) => {
      const p = payload as { from: string; to: string; reason: string; actor: string }
      this.record({
        type: 'change', actorType: 'human', actorId: 'update-apply', actorName: p.actor,
        action: 'platform.update.applied', resourceType: 'platform', resourceId: 'self', resourceName: '平台升级',
        result: 'ok', detail: `${p.from} → ${p.to}，原因：${p.reason}`,
      })
    })
    ctx.platformBus.on(PlatformEvents.ApprovalCreated, auditOf('change', 'approval.create'))
    ctx.platformBus.on(PlatformEvents.ApprovalDecided, (payload) => {
      const p = payload as { approvalId: string; title: string; approved: boolean; approverName: string }
      this.record({
        type: 'authz', actorType: 'human', actorId: p.approverId ?? '', actorName: p.approverName ?? '',
        action: 'approval.decide', resourceType: 'approval', resourceId: p.approvalId, resourceName: p.title,
        result: 'ok', detail: p.approved ? t('审批通过') : t('审批驳回'),
      })
    })
    ctx.platformBus.on('audit.authz.denied', (payload) => {
      const p = payload as { actorId: string; actorName: string; point: string; path: string }
      this.record({
        type: 'authz', actorType: 'human', actorId: p.actorId, actorName: p.actorName,
        action: 'console.authz.denied', resourceType: 'api', resourceId: p.path, resourceName: p.path,
        result: 'denied', detail: t('缺少权限点 {point}', { point: p.point }),
      })
      const key = `denied:${p.actorId}`
      const now = Date.now()
      const times = (this.deniedCounter.get(key) ?? []).filter((t) => now - t < 10 * 60_000)
      times.push(now)
      this.deniedCounter.set(key, times)
      this.evaluateAlerts('permission_denied', { actorId: p.actorId, actorName: p.actorName, count: times.length, point: p.point })
    })
    ctx.platformBus.on(PlatformEvents.AlertFired, (payload) => {
      const p = payload as AlertEventRecord
      this.alerts().insert({
        id: p.id, ruleId: p.ruleId, severity: p.severity, title: p.title, message: p.message,
        ...(p.resourceType !== undefined ? { resourceType: p.resourceType } : {}),
        ...(p.resourceId !== undefined ? { resourceId: p.resourceId } : {}),
        read: false,
      })
    })

    // T2 收口（M2）：远程接入降级事件落审计——此前 connect.degraded 只到总线为止，
    // audit 无订阅，「以为在管远端其实在管本机」类语义漂移在审计链上不可见（降级必须显式留痕）。
    ctx.platformBus.on('connect.degraded', (payload) => {
      const p = payload as { reason?: string; tool?: string; detail?: string; at?: string }
      this.record({
        type: 'change', actorType: 'system', actorId: 'connect', actorName: '远程接入',
        action: 'connect.degraded', resourceType: 'connect', resourceId: p.tool ?? '-', resourceName: p.tool ?? '工具远程代理',
        result: 'error',
        detail: `reason=${p.reason ?? 'unknown'}${p.detail ? `；${p.detail}` : ''}`,
      })
    })

    // 计量管道消费（v1.2 第 2 步）：usage.recorded → 财务口径投影 + 真实成本归集。
    // 消费幂等由 usage 事件 idempotency_key 保障（at-least-once 投递 + 幂等消费）。
    ctx.usage.consume('audit', (event) => {
      ctx.usage.project('audit', event)
      const agentId = event.subject.startsWith('agent:') ? event.subject.slice(6) : undefined
      const appId = event.principal.startsWith('app:') ? event.principal.slice(4) : undefined
      const mcpServiceId = event.resource.startsWith('mcp:') ? event.resource.slice(4) : undefined
      const connectorService = event.resource.startsWith('connector:') ? event.resource.slice('connector:'.length) : undefined
      const tokens = event.meters
        .filter((meter) => meter.key === 'input_tokens' || meter.key === 'output_tokens' || meter.key === 'tokens')
        .reduce((sum, meter) => sum + meter.value, 0)
      // REL-11 读侧加固：存量脏事件（价格簿曾写入非数值费率）的 cost_cents 非有限时按 0 归集，
      // 防 NaN 污染成本台账；同一资源只发一次 warning 告警
      const rawCostCents = event.pricing.cost_cents
      const safeCostCents = Number.isFinite(rawCostCents) ? rawCostCents : 0
      if (!Number.isFinite(rawCostCents) && !this.warnedDirtyCostResources.has(event.resource)) {
        this.warnedDirtyCostResources.add(event.resource)
        this.fire({
          severity: 'warning', title: t('[计量] 脏事件成本按 0 归集（REL-11 加固）'),
          message: t('资源 {resource} 的事件 {id} pricing.cost_cents={value} 为非有限值，成本归集按 0 处理；请修正价格簿后按时间窗重放', { resource: event.resource, id: event.event_id, value: String(rawCostCents) }),
          resourceType: 'usage_event', resourceId: event.resource,
        })
      }
      // #14（2026-10-29）：未定价判定——零成本且（零费率快照 或 显式 cost_status='not_priced'）。
      // 费率在配但量小取整为 0 的事件仍算已定价（priced），不污染覆盖率。
      const notPricedEvent = safeCostCents === 0
        && ((event.pricing as { cost_status?: string }).cost_status === 'not_priced' || event.pricing.rate?.nonbillable === true)
      this.addCost({
        date: event.occurred_at.slice(0, 10),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(appId !== undefined ? { appId } : {}),
        ...(mcpServiceId !== undefined ? { mcpServiceId } : {}),
        ...(connectorService !== undefined ? { connectorService } : {}),
        llmTokens: event.resource.startsWith('model:') ? tokens : 0,
        toolCalls: event.resource.startsWith('mcp:') || connectorService !== undefined ? 1 : 0,
        // QA B-06：成本口径取 cost_cents（内部成本）——此前取 charge_cents（应收口径）充当成本，
        // 价格簿一旦调非零即以成本名义呈现应收金额（M0 禁止的结算语义残留）；charge 恒 0 仅快照兼容
        costYuan: Math.round(safeCostCents * 100) / 10_000,
        // #14：计价覆盖率——零成本且（零费率快照 or 显式 not_priced 标注）计为未定价，不与真零成本混读
        ...(notPricedEvent ? { pricedEvents: 0, notPricedEvents: 1 } : { pricedEvents: 1, notPricedEvents: 0 }),
      })
    })
  }

  // -- 集合 ---------------------------------------------------------------

  logs(): Collection<AuditLogRecord> {
    return this.ctx.opsStorage.collection<AuditLogRecord>('audit:logs')
  }

  alertRules(): Collection<AlertRuleRecord> {
    return this.ctx.opsStorage.collection<AlertRuleRecord>('audit:alertRules')
  }

  alerts(): Collection<AlertEventRecord> {
    return this.ctx.opsStorage.collection<AlertEventRecord>('audit:alerts')
  }

  costs(): Collection<CostRecord> {
    return this.ctx.opsStorage.collection<CostRecord>('audit:costs')
  }

  approvals(): Collection<ApprovalRecord> {
    return this.ctx.opsStorage.collection<ApprovalRecord>('audit:approvals')
  }

  evidence(): Collection<EvidenceRecord> {
    return this.ctx.opsStorage.collection<EvidenceRecord>('audit:evidence')
  }

  // -- 审计日志 -----------------------------------------------------------

  /**
   * 唯一写入点（append-only）：单点计算哈希链——hash = sha256(prevHash + canonicalJSON(业务字段))，
   * 链首 prevHash=''。启动续链：首次写入前取集合最后一条的 hash 作链首（重启/换进程不破链，
   * 集合无清理逻辑，天然全序）。校验口径：对存量记录 strip prevHash/hash 后重算并与 hash 比对
   * （auditHashOf 导出，W4 验收/外部分析共用同一实现）。
   */
  record(entry: Omit<AuditLogRecord, 'id' | 'createdAt' | 'updatedAt'>): AuditLogRecord {
    if (!this.chainReady) {
      const all = this.logs().all()
      this.chainTip = all.length > 0 ? String(all[all.length - 1]!.hash ?? '') : ''
      this.chainReady = true
    }
    const prevHash = this.chainTip
    const record = { id: newId('log'), ...entry }
    const hash = auditHashOf(record, prevHash)
    this.chainTip = hash
    return this.logs().insert({ ...record, prevHash, hash } as AuditLogRecord)
  }

  /** 当前链尾哈希（ndjson 导出附尾行 _chainTip；外部对账入口）。 */
  chainTipHash(): string {
    if (!this.chainReady) {
      const all = this.logs().all()
      return all.length > 0 ? String(all[all.length - 1]!.hash ?? '') : ''
    }
    return this.chainTip
  }

  /**
   * ndjson 流式导出（契约 §14，append-only 导出）：行序=时间序（createdAt 升序），
   * 每行一条完整审计记录（含 prevHash/hash 可校验），尾行 {"_chainTip": "<lastHash>"}。
   * 直接写响应（Content-Type application/x-ndjson），权限点同既有 audit.read。
   */
  exportNdjson(exchange: { res: { writeHead(status: number, headers: Record<string, string>): unknown; end(text?: string): unknown } }, filter: { since?: string; until?: string } = {}): void {
    const rows = this.logs().find((log) => {
      if (filter.since && log.createdAt < filter.since) return false
      if (filter.until && log.createdAt > filter.until) return false
      return true
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const lines = rows.map((row) => JSON.stringify(row))
    lines.push(JSON.stringify({ _chainTip: this.chainTipHash() }))
    exchange.res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
    exchange.res.end(`${lines.join('\n')}\n`)
  }

  // -- 证据锚点（IAW 交接 5-1） ---------------------------------------------

  /**
   * 证据登记：锚点包校验后落库发 id。校验为结构性校验（kind 值域 / id 必填 / 窗口与行数形态），
   * 不校验引用的数据集是否真实存在——那属于数据要素域（resource datasets）的对账职责。
   */
  recordEvidence(input: {
    anchors: EvidenceAnchor[]
    sceneCode?: string
    messageId?: string
    sessionId?: string
    subject?: string
    note?: string
  }): EvidenceRecord {
    if (!Array.isArray(input.anchors) || input.anchors.length === 0) throw new Error(t('证据锚点至少一项（anchors）'))
    if (input.anchors.length > 20) throw new Error(t('证据锚点过多（≤20）：结论级证据应引用事实，不是搬运数据'))
    for (const anchor of input.anchors) {
      if (!['dataset', 'field', 'window', 'query', 'doc'].includes(anchor.kind)) throw new Error(t('证据锚点 kind 非法：{kind}（dataset/field/window/query/doc）', { kind: anchor.kind }))
      if (!anchor.id?.trim()) throw new Error(t('证据锚点 id 必填（数据集编号/字段路径/查询 id 等）'))
      if (anchor.timeWindow && (!anchor.timeWindow.from || !anchor.timeWindow.to)) throw new Error(t('证据锚点 timeWindow 需要 from/to'))
      if (anchor.hitRows !== undefined && (!Number.isFinite(anchor.hitRows) || anchor.hitRows < 0)) throw new Error(t('证据锚点 hitRows 应为非负数'))
      if (anchor.qualityScore !== undefined && (!Number.isFinite(anchor.qualityScore) || anchor.qualityScore < 0 || anchor.qualityScore > 100)) throw new Error(t('证据锚点 qualityScore 应为 0-100'))
    }
    return this.evidence().insert({
      id: newId('evd'),
      anchors: input.anchors,
      ...(input.sceneCode ? { sceneCode: input.sceneCode } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.note ? { note: input.note } : {}),
    })
  }

  getEvidence(id: string): EvidenceRecord | undefined {
    return this.evidence().get(id)
  }

  // -- 场景时间线（IAW 交接 5-2） -------------------------------------------

  /**
   * 场景/任务维度审计时间线：带 sceneCode 维度的审计日志倒序时间线（面板概览「最近动态」
   * 与场景抽屉的数据源；无 sceneCode 维度的全量审计仍走 query()/logs）。
   * REL-10：证据登记（audit:evidence）同样带 sceneCode，但此前 timeline 只查 audit:logs——
   * 证据登记 200 后场景时间线查不到（断链，IAW 5-1→5-2）。现把命中 sceneCode 的证据记录以
   * entryType='evidence' 条目合并进时间线（按时间统一排序）；证据锚点引用 log id 时在对应
   * log 条目上计算式回填 evidenceIds（只改响应，不改持久化 schema）。既有字段只增不改。
   */
  timeline(filter: { sceneCode?: string; since?: string; limit?: number } = {}): { total: number; items: Array<{
    id: string; at: string
    /** 条目类型标记（REL-10，additive）：'log'=审计日志 / 'evidence'=证据锚点登记（IAW 5-1）。 */
    entryType: 'log' | 'evidence'
    /** 审计四类；evidence 条目无审计类型语义，缺省。 */
    type?: AuditType
    action: string; actorName: string
    resourceType: string; resourceId: string; resourceName: string
    result: AuditLogRecord['result']; detail: string; sceneCode?: string; evidenceIds: string[]
    /** evidence 条目专有（additive）：锚点包与登记备注。 */
    anchors?: EvidenceAnchor[]; note?: string
  }> } {
    const all = this.logs().find((log) => {
      if (filter.sceneCode && log.sceneCode !== filter.sceneCode) return false
      if (filter.since && log.createdAt < filter.since) return false
      return true
    })
    const evidences = this.evidence().find((evd) => {
      if (filter.sceneCode && evd.sceneCode !== filter.sceneCode) return false
      if (filter.since && evd.createdAt < filter.since) return false
      return true
    })
    // 锚点引用 log id 时计算式回填 evidenceIds（响应层合并去重，不落库）
    const anchorRefs = new Map<string, string[]>()
    if (evidences.length > 0) {
      const logIds = new Set(all.map((log) => log.id))
      for (const evd of evidences) {
        for (const anchor of evd.anchors) {
          if (anchor.id && logIds.has(anchor.id)) {
            const refs = anchorRefs.get(anchor.id) ?? []
            if (!refs.includes(evd.id)) refs.push(evd.id)
            anchorRefs.set(anchor.id, refs)
          }
        }
      }
    }
    const items = [
      ...all.map((log) => ({
        id: log.id, at: log.createdAt, entryType: 'log' as const,
        type: log.type, action: log.action, actorName: log.actorName,
        resourceType: log.resourceType, resourceId: log.resourceId, resourceName: log.resourceName,
        result: log.result, detail: log.detail,
        ...(log.sceneCode ? { sceneCode: log.sceneCode } : {}),
        evidenceIds: [...(log.evidenceIds ?? []), ...(anchorRefs.get(log.id) ?? [])],
      })),
      ...evidences.map((evd) => ({
        id: evd.id, at: evd.createdAt, entryType: 'evidence' as const,
        action: 'audit.evidence', actorName: evd.subject ?? '',
        resourceType: 'evidence', resourceId: evd.id,
        resourceName: evd.note?.slice(0, 50) || `证据锚点×${evd.anchors.length}`,
        result: 'ok' as const,
        detail: evd.note ?? evd.anchors.map((anchor) => `${anchor.kind}:${anchor.id}`).join(', ').slice(0, 300),
        ...(evd.sceneCode ? { sceneCode: evd.sceneCode } : {}),
        evidenceIds: [evd.id],
        anchors: evd.anchors, ...(evd.note ? { note: evd.note } : {}),
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, Math.min(filter.limit ?? 50, 200))
    return { total: all.length + evidences.length, items }
  }

  query(filter: {
    type?: AuditType
    actorId?: string
    resourceType?: string
    resourceId?: string
    result?: string
    q?: string
    since?: string
    sceneCode?: string
    /** 全链 trace 精确匹配（W3-T5 §14）：与 mcp.invoked 落审计的 traceId 维度对齐。 */
    traceId?: string
    limit?: number
  }): { total: number; items: AuditLogRecord[] } {
    const all = this.logs().find((log) => {
      if (filter.type && log.type !== filter.type) return false
      if (filter.actorId && log.actorId !== filter.actorId) return false
      if (filter.resourceType && log.resourceType !== filter.resourceType) return false
      if (filter.resourceId && log.resourceId !== filter.resourceId) return false
      if (filter.result && log.result !== filter.result) return false
      if (filter.since && log.createdAt < filter.since) return false
      if (filter.sceneCode && log.sceneCode !== filter.sceneCode) return false
      if (filter.traceId && log.traceId !== filter.traceId) return false
      if (filter.q && !`${log.action} ${log.actorName} ${log.resourceName} ${log.detail}`.toLowerCase().includes(filter.q.toLowerCase())) return false
      return true
    })
    const items = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const limit = filter.limit ?? 100
    return { total: all.length, items: items.slice(0, limit) }
  }

  summary(): Record<string, number> {
    const result: Record<string, number> = { auth: 0, authz: 0, invoke: 0, change: 0, denied: 0, error: 0 }
    for (const log of this.logs().all()) {
      result[log.type] = (result[log.type] ?? 0) + 1
      if (log.result === 'denied') result.denied!++
      if (log.result === 'error') result.error!++
    }
    return result
  }

  // -- 告警 ---------------------------------------------------------------

  createAlertRule(input: Omit<AlertRuleRecord, 'id' | 'createdAt' | 'updatedAt'>): AlertRuleRecord {
    // REL-12：创建入口入参校验收口——此前缺 name、非有限 threshold 也能 200 建档（无 name 规则
    // 告警不可读，非法阈值使「>阈值」比较语义失真）。非法即抛错（路由 guarded 统一映射 400 BAD_REQUEST）
    if (typeof input.name !== 'string' || input.name.trim() === '') throw new Error(t('告警规则 name 必填（非空字符串）'))
    if (typeof input.metric !== 'string' || input.metric.trim() === '') throw new Error(t('告警规则 metric 必填（非空字符串）'))
    if (!Number.isFinite(input.threshold)) throw new Error(t('告警规则 threshold 必须为有限数值，收到：{value}', { value: String(input.threshold) }))
    if (input.operator !== undefined && input.operator !== 'gt') throw new Error(t('告警规则 operator 非法：{value}（当前仅支持 gt）', { value: String(input.operator) }))
    return this.alertRules().insert({ id: newId('rule'), ...input })
  }

  /** 告警评估入口：各事件源调用，匹配规则则触发告警。 */
  evaluateAlerts(metric: string, context: Record<string, unknown>): void {
    for (const rule of this.alertRules().find((item) => item.enabled && item.metric === metric)) {
      const value = Number(context[metric === 'permission_denied' ? 'count' : metric === 'mcp_unhealthy' ? 'consecutiveFails' : 'value'] ?? 0)
      if (!(value > rule.threshold)) continue
      this.fire({
        ruleId: rule.id,
        severity: rule.severity,
        title: t('[{name}] 触发', { name: rule.name }),
        message: t('{metric} = {value}（阈值 {threshold}），上下文：{context}', { metric: rule.metric, value, threshold: rule.threshold, context: JSON.stringify(context).slice(0, 200) }),
        ...(context.resourceType !== undefined ? { resourceType: String(context.resourceType) } : {}),
        ...(context.resourceId !== undefined ? { resourceId: String(context.resourceId) } : {}),
      })
    }
  }

  /** 直接触发告警（无规则的系统级告警）。 */
  fire(input: Omit<AlertEventRecord, 'id' | 'createdAt' | 'updatedAt' | 'read'>): void {
    this.ctx.platformBus.emit(PlatformEvents.AlertFired, {
      id: newId('alt'), read: false, ...input,
    })
  }

  markAlertRead(id: string): void {
    this.alerts().update(id, { read: true })
  }

  /** 一键全部已读：把全部未读告警置为已读，返回本次处理的条数。 */
  markAllAlertsRead(): number {
    const unread = this.alerts().find((alert) => !alert.read)
    for (const alert of unread) this.alerts().update(alert.id, { read: true })
    return unread.length
  }

  // -- 成本 ---------------------------------------------------------------

  addCost(input: Omit<CostRecord, 'id' | 'createdAt' | 'updatedAt'>): void {
    const existing = this.costs().findOne((cost) =>
      cost.date === input.date
      && (cost.appId ?? '') === (input.appId ?? '')
      && (cost.agentId ?? '') === (input.agentId ?? '')
      && (cost.mcpServiceId ?? '') === (input.mcpServiceId ?? '')
      && (cost.connectorService ?? '') === (input.connectorService ?? ''))
    if (existing) {
      this.costs().update(existing.id, {
        llmTokens: existing.llmTokens + input.llmTokens,
        toolCalls: existing.toolCalls + input.toolCalls,
        costYuan: Math.round((existing.costYuan + input.costYuan) * 1000) / 1000,
        // #14：覆盖率增量合并（存量桶无字段按 0 起算，additive 不迁移）
        pricedEvents: (existing.pricedEvents ?? 0) + (input.pricedEvents ?? 0),
        notPricedEvents: (existing.notPricedEvents ?? 0) + (input.notPricedEvents ?? 0),
        // #14 复核：覆盖率字段引入前已聚合的桶被新事件合并——既有 portion 的覆盖率不可知，
        // 标记混合口径，costReport 的 coverage 据此报 mixed 而非谎报 live 100% 覆盖
        ...(existing.pricedEvents === undefined && existing.notPricedEvents === undefined ? { legacyUncounted: true } : {}),
      })
    } else {
      this.costs().insert({ id: newId('cost'), ...input })
    }
  }

  costReport(groupBy: 'app' | 'agent' | 'org' | 'date', from?: string, to?: string): Array<{ key: string; llmTokens: number; toolCalls: number; costYuan: number; priced: number; notPriced: number; coverage: 'live' | 'legacy' | 'mixed' }> {
    const buckets = new Map<string, { key: string; llmTokens: number; toolCalls: number; costYuan: number; priced: number; notPriced: number; liveRecords: number; legacyRecords: number }>()
    for (const cost of this.costs().all()) {
      if (from && cost.date < from) continue
      if (to && cost.date > to) continue
      let key = cost.date
      if (groupBy === 'app') key = cost.appId ? this.ctx.resourceCore?.collection('app').get(cost.appId)?.name ?? cost.appId : t('（未归集应用）')
      if (groupBy === 'agent') key = cost.agentId ? this.ctx.resourceCore?.collection('agent').get(cost.agentId)?.name ?? cost.agentId : t('（未归集 Agent）')
      if (groupBy === 'org') {
        const entity = cost.agentId ? this.ctx.resourceCore?.collection('agent').get(cost.agentId) : undefined
        key = entity ? this.ctx.iam?.orgs().get(entity.orgId)?.name ?? entity.orgId : t('（未归集组织）')
      }
      const bucket = buckets.get(key) ?? { key, llmTokens: 0, toolCalls: 0, costYuan: 0, priced: 0, notPriced: 0, liveRecords: 0, legacyRecords: 0 }
      bucket.llmTokens += cost.llmTokens
      bucket.toolCalls += cost.toolCalls
      bucket.costYuan += cost.costYuan
      // #14：覆盖率（存量记录无字段不计入分母——门禁按 priced+notPriced>0 判定归集可信度）
      bucket.priced += cost.pricedEvents ?? 0
      bucket.notPriced += cost.notPricedEvents ?? 0
      // #14 复核：coverage 让门禁区分「在档 0」与「存量未知」——legacy = 全部记录早于覆盖率
      // 字段（priced/notPriced 恒 0 属不可知而非真 0）；mixed = 部分存量未计数；live = 全量在档
      const hasCoverage = cost.pricedEvents !== undefined || cost.notPricedEvents !== undefined
      if (hasCoverage && !cost.legacyUncounted) bucket.liveRecords += 1
      else bucket.legacyRecords += 1
      buckets.set(key, bucket)
    }
    return [...buckets.values()].map((bucket) => ({
      key: bucket.key,
      llmTokens: bucket.llmTokens,
      toolCalls: bucket.toolCalls,
      costYuan: Math.round(bucket.costYuan * 1000) / 1000,
      priced: bucket.priced,
      notPriced: bucket.notPriced,
      coverage: bucket.liveRecords > 0 && bucket.legacyRecords === 0 ? 'live' as const : bucket.liveRecords === 0 ? 'legacy' as const : 'mixed' as const,
    }))
      .sort((a, b) => b.costYuan - a.costYuan)
  }

  // -- 审批中心 -----------------------------------------------------------

  /** 注册某类审批的执行器（审批通过后自动执行）。 */
  registerExecutor(kind: string, executor: ApprovalExecutor): () => void {
    this.executors.set(kind, executor)
    return () => this.executors.delete(kind)
  }

  /**
   * 注册补偿器（OPT-P2-02）：不可逆动作的执行器失败时按注册表编排补偿并回写审批单。
   * 补偿器收到（payload, 原错误）；返回值进入 execution.result 留痕。
   */
  registerCompensation(kind: string, compensation: (payload: Record<string, unknown>, error: Error) => Promise<unknown>): () => void {
    this.compensations.set(kind, compensation)
    return () => this.compensations.delete(kind)
  }

  createApproval(input: {
    kind: string
    title: string
    payload: Record<string, unknown>
    requesterId: string
    requesterName: string
    riskLevel?: 'high' | 'medium' | 'low'
    orgId?: string
  }): ApprovalRecord {
    // OPT-P2-02：入审批存储前的敏感面处置——reject 类 kind 直接拒绝开单；其余深度掩码后入库
    const rule = approvalKindRule(input.kind)
    const sensitivePaths = scanSensitiveKeys(input.payload)
    if (rule.sensitiveInputPolicy === 'reject' && sensitivePaths.length > 0) {
      throw new Error(t('审批拒绝：该类审批以原文入参执行，检出敏感命名入参（{paths}）。敏感值不得进入审批存储，请调整入参后重试（OPT-P2-02）', { paths: sensitivePaths.join('、') }))
    }
    const { masked, maskedKeys } = maskSensitivePayload(input.payload)
    const riskLevel = input.riskLevel ?? (HIGH_RISK_APPROVAL_KINDS.has(input.kind) ? 'high' as const : undefined)
    // R11：组织归属——显式传入优先；agent.* 类单未传时按平台稳定键读 Agent 的 orgId 兜底
    //（调用方 plugin-agent 零改动即带上归属；entity:agent 跨插件只读与 dashboard 同款惯例）
    let orgId = input.orgId
    if (!orgId && input.kind.startsWith('agent.') && input.payload['agentId']) {
      try {
        orgId = this.ctx.opsStorage.collection<{ orgId?: string }>('entity:agent').get(String(input.payload['agentId']))?.orgId
      } catch { /* 推导失败不阻塞开单（无归属单对非 `*` 不可见） */ }
    }
    const record = this.approvals().insert({
      id: newId('apr'),
      ...input,
      ...(orgId ? { orgId } : {}),
      ...(riskLevel !== undefined ? { riskLevel } : {}),
      ...(maskedKeys.length > 0 ? { payload: { ...(masked as Record<string, unknown>), maskedKeys } } : {}),
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    this.ctx.platformBus.emit(PlatformEvents.ApprovalCreated, {
      approvalId: record.id, kind: record.kind, title: record.title,
      requesterId: record.requesterId, requesterName: record.requesterName,
    })
    return record
  }

  /**
   * 审批决策（WP-10 增强）：高风险通过必须显式二次确认（服务端强制，confirmed=true）；
   * 高风险（或显式 finalReview）通过后落「公司级终审标记」并写入审计（action=approval.final_review，
   * L1 终审标记审计可追溯）。
   */
  async decideApproval(
    id: string,
    decision: 'approve' | 'reject',
    approverId: string,
    approverName: string,
    opinion?: string,
    options: { confirmed?: boolean; finalReview?: boolean } = {},
  ): Promise<ApprovalRecord> {
    // REL-01：decision 入参收口——只接受 approve/reject。此前其余值（如 "maybe"）会被
    // 当作 approve 落入执行器分支真实执行；服务层单点拦截（路由层 guarded 统一转 400）。
    if (decision !== 'approve' && decision !== 'reject') {
      throw new Error(t('非法的审批决策：{decision}（只允许 approve 或 reject）', { decision: String(decision) }))
    }
    const approval = this.approvals().get(id)
    if (!approval) throw new Error(t('审批单不存在：{id}', { id }))
    if (approval.status !== 'pending') throw new Error(t('审批单已处理（{status}）', { status: approval.status }))
    // 同人审批放开（原 QA A-05「提交人与审批人不得为同一账号」自审自批拦截已按业务决策取消，
    // 2026-09-15）——2026-10-14 R12 复议收窄：仅 agent.online（雇佣语义）恢复职责分离，
    // 提交人不得自行通过/驳回自己的 Agent 上线单；其余类型维持放开，权限点校验不变。
    if (approval.kind === 'agent.online' && approverId && approverId === approval.requesterId) {
      throw new Error(t('职责分离（R12 复议恢复，2026-10-14）：Agent 上线（雇佣语义）审批的提交人与审批人不得为同一账号'))
    }
    const isHighRisk = approval.riskLevel === 'high'
    if (decision === 'approve' && isHighRisk && options.confirmed !== true) {
      throw new Error(t('高风险审批通过需二次确认（confirmed=true），请在前端确认弹窗中复核后提交'))
    }
    if (decision === 'reject') {
      const updated = this.approvals().update(id, {
        status: 'rejected', approverId, approverName,
        ...(opinion !== undefined ? { opinion } : {}),
        decidedAt: new Date().toISOString(),
      })
      this.ctx.platformBus.emit(PlatformEvents.ApprovalDecided, {
        approvalId: id, title: approval.title, approved: false, approverId, approverName,
      })
      return updated
    }
    const executor = this.executors.get(approval.kind)
    let execution: ApprovalRecord['execution']
    if (executor) {
      try {
        const result = await executor(approval.payload, approverId)
        execution = { result: JSON.stringify(result ?? { ok: true }).slice(0, 500), at: new Date().toISOString() }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        execution = { result: t('执行失败'), error: err.message, at: new Date().toISOString() }
        // OPT-P2-02：executor 失败不再只有 approval.execution.error——按注册表编排补偿并回写
        const compensation = this.compensations.get(approval.kind)
        if (compensation) {
          try {
            const compResult = await compensation(approval.payload, err)
            execution = {
              result: t('执行失败，已完成补偿：{result}', { result: JSON.stringify(compResult ?? { ok: true }).slice(0, 200) }),
              error: err.message, at: new Date().toISOString(),
            }
          } catch (compError) {
            const compMessage = compError instanceof Error ? compError.message : String(compError)
            execution = { result: t('执行失败且补偿失败（需人工介入）'), error: t('{message}；补偿失败：{compensation}', { message: err.message, compensation: compMessage }), at: new Date().toISOString() }
          }
          this.record({
            type: 'change', actorType: 'machine', actorId: 'approval-engine', actorName: '审批引擎',
            action: 'approval.compensated', resourceType: 'approval', resourceId: id, resourceName: approval.title,
            result: 'ok', detail: `执行器失败已按注册表编排补偿（kind=${approval.kind}，审批单 ${id}）`,
          })
        }
      }
    } else {
      execution = { result: t('（无注册执行器，仅记录审批结果）'), at: new Date().toISOString() }
    }
    const status: ApprovalRecord['status'] = execution.error ? 'failed' : 'executed'
    const needsFinalReview = isHighRisk || options.finalReview === true
    const updated = this.approvals().update(id, {
      status, approverId, approverName,
      ...(opinion !== undefined ? { opinion } : {}),
      decidedAt: new Date().toISOString(),
      execution,
      ...(needsFinalReview ? { finalReview: { approverId, approverName, at: new Date().toISOString() } } : {}),
    })
    if (needsFinalReview) {
      // L1 公司级终审标记 → 审计留痕（可按 action=approval.final_review 检索追溯）
      this.record({
        type: 'change', actorType: 'human', actorId: approverId, actorName: approverName,
        action: 'approval.final_review', resourceType: 'approval', resourceId: id, resourceName: approval.title,
        result: 'ok', detail: `公司级终审标记（风险级 ${approval.riskLevel ?? 'medium'}），审批单 ${id} 终审通过`,
      })
    }
    this.ctx.platformBus.emit(PlatformEvents.ApprovalDecided, {
      approvalId: id, title: approval.title, approved: true, approverId, approverName,
    })
    return updated
  }

  /**
   * 删除审批单（清理驳回单）：仅「已驳回」终态可删——驳回单未执行任何动作，删除只为
   * 清理待办列表；pending/approved/executed/failed 单含执行事实，一律不可删（审计留痕不受影响）。
   */
  deleteApproval(id: string): void {
    const approval = this.approvals().get(id)
    if (!approval) throw new Error(t('审批单不存在：{id}', { id }))
    if (approval.status !== 'rejected') {
      throw new Error(t('仅已驳回的审批单可删除，当前状态：{status}', { status: approval.status }))
    }
    this.approvals().remove(id)
  }

  /**
   * 审批 SLA 报表（WP-10）：窗口内已决审批的「≤2 个工作日」达成率与分项。
   * 工作日口径：跳过周六/周日后按自然日差累计（法定节假日不做日历——v1 口径在响应中声明）。
   */
  slaReport(windowDays = 30): {
    windowDays: number
    total: number
    decided: number
    withinSla: number
    achievementRate: number
    breached: Array<{ id: string; kind: string; title: string; businessDays: number; decidedAt: string }>
    calendarNote: string
  } {
    const since = new Date(Date.now() - windowDays * 24 * 3600_000).toISOString()
    const decidedRecords = this.approvals().all()
      .filter((item) => item.decidedAt && item.decidedAt >= since)
    const businessDaysBetween = (fromIso: string, toIso: string): number => {
      let days = 0
      const cursor = new Date(fromIso)
      const end = new Date(toIso)
      while (cursor < end) {
        const day = cursor.getUTCDay()
        if (day !== 0 && day !== 6) days++
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      }
      return days
    }
    const breached: Array<{ id: string; kind: string; title: string; businessDays: number; decidedAt: string }> = []
    let withinSla = 0
    for (const item of decidedRecords) {
      const days = businessDaysBetween(item.createdAt, item.decidedAt!)
      if (days <= 2) withinSla++
      else breached.push({ id: item.id, kind: item.kind, title: item.title, businessDays: days, decidedAt: item.decidedAt! })
    }
    return {
      windowDays,
      total: this.approvals().all().filter((item) => item.createdAt >= since).length,
      decided: decidedRecords.length,
      withinSla,
      achievementRate: decidedRecords.length === 0 ? 1 : Math.round((withinSla / decidedRecords.length) * 1000) / 1000,
      breached: breached.sort((a, b) => b.businessDays - a.businessDays),
      calendarNote: t('工作日=跳过周六/周日（未扣法定节假日，v1 口径）'),
    }
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    audit: AuditService
  }
}

export const name = 'audit'
export const inject = ['opsStorage', 'platformBus', 'resourceCore', 'iam', 'usage']

export function apply(ctx: Context) {
  ctx.plugin(AuditService)
  ctx.plugin(auditTools)
}
