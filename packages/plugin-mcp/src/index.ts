/**
 * @dsh-ops/plugin-mcp —— MCP 部署服务管理（方案 §三）。
 *
 * 管理面（本插件）：服务注册登记、部署流程、版本/灰度/回滚、健康探活、
 *                   权限组（Tool 粒度 + 参数级约束）、调用运营监控。
 * 数据面（MCP 网关）：invoke() 统一鉴权、限流熔断、指标埋点、审计上报。
 * 演示环境内置 mock 执行传输层：确定性模拟延迟/成功率/Token 消耗。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  PlatformEvents, newId, sha256Hex,
  gateManagedWork, WORK_DENY_CODE_LABELS,
  newTraceId, formatTraceparent,
  PolicyDecisionPoint, wrapPolicyDecision,
  normalizeAssetCategory,
  type Collection, type RecordBase,
  type PolicyDecision, type PolicyModule, type PolicyRequest,
  type UnifiedPrincipal,
  type WorkCallerRef, type WorkDenyCode, type WorkExecutionContext, type WorkRefIndex, type WorkforcePolicyRegistry,
} from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'
import * as mcpTools from './tools.ts'
import { McpToolRiskRegistry } from './risk-registry.ts'
import { SecretBroker, sensitiveHeaderKeys } from './secret-broker.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

// -- 治理字段（W1-T2，契约 §5，additive） ---------------------------------------------------

export type McpOwnerEntityType = 'platform' | 'app' | 'agent' | 'connector'

/** 服务归属实体：缺省 {type:'platform'}（平台占位=治理待办 unowned，待 W2-T4 能力绑定回写）。 */
export interface McpOwnerEntity {
  type: McpOwnerEntityType
  id?: string
}

export type McpExposureMode = 'gateway' | 'direct' | 'internal'
export type McpDataClass = 'public' | 'internal' | 'confidential'
export type McpEnvironment = 'dev' | 'staging' | 'prod'
export type McpVisibility = 'org' | 'tenant' | 'cross-org'

const OWNER_ENTITY_TYPES: readonly McpOwnerEntityType[] = ['platform', 'app', 'agent', 'connector']
const EXPOSURE_MODES: readonly McpExposureMode[] = ['gateway', 'direct', 'internal']
const DATA_CLASSES: readonly McpDataClass[] = ['public', 'internal', 'confidential']
const ENVIRONMENTS: readonly McpEnvironment[] = ['dev', 'staging', 'prod']
const VISIBILITIES: readonly McpVisibility[] = ['org', 'tenant', 'cross-org']

/** 治理字段可选入参（create/update 共用校验面）。 */
export interface McpGovernanceInput {
  ownerEntity?: McpOwnerEntity
  exposureMode?: McpExposureMode
  dataClass?: McpDataClass
  environment?: McpEnvironment
  visibility?: McpVisibility
}

/**
 * 治理字段校验与归一（契约 §5）：枚举非法值一律显式报错（不静默吞、不静默回默认），
 * ownerEntity.id 空白视为未指派（归一为仅 type）。
 */
export function normalizeGovernanceInput(input: McpGovernanceInput): McpGovernanceInput {
  const out: McpGovernanceInput = {}
  if (input.ownerEntity !== undefined) {
    const candidate = input.ownerEntity as McpOwnerEntity | undefined
    if (!candidate || typeof candidate !== 'object' || !OWNER_ENTITY_TYPES.includes(candidate.type)) {
      throw new Error(t('ownerEntity.type 须为 {values}，收到 {value}', { values: OWNER_ENTITY_TYPES.join('/'), value: String((candidate as McpOwnerEntity | undefined)?.type ?? candidate) }))
    }
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    out.ownerEntity = id ? { type: candidate.type, id } : { type: candidate.type }
  }
  if (input.exposureMode !== undefined) {
    if (!EXPOSURE_MODES.includes(input.exposureMode)) {
      throw new Error(t('exposureMode 须为 {values}，收到 {value}', { values: EXPOSURE_MODES.join('/'), value: String(input.exposureMode) }))
    }
    out.exposureMode = input.exposureMode
  }
  if (input.dataClass !== undefined) {
    if (!DATA_CLASSES.includes(input.dataClass)) {
      throw new Error(t('dataClass 须为 {values}，收到 {value}', { values: DATA_CLASSES.join('/'), value: String(input.dataClass) }))
    }
    out.dataClass = input.dataClass
  }
  if (input.environment !== undefined) {
    if (!ENVIRONMENTS.includes(input.environment)) {
      throw new Error(t('environment 须为 {values}，收到 {value}', { values: ENVIRONMENTS.join('/'), value: String(input.environment) }))
    }
    out.environment = input.environment
  }
  if (input.visibility !== undefined) {
    if (!VISIBILITIES.includes(input.visibility)) {
      throw new Error(t('visibility 须为 {values}，收到 {value}', { values: VISIBILITIES.join('/'), value: String(input.visibility) }))
    }
    out.visibility = input.visibility
  }
  return out
}

/**
 * 工具风险申报值。W 批次 W1（V11 根治）扩 'unknown'：远端 tools/list 同步的工具无法自证风险，
 * 一律落 'unknown'（不再隐式映射 read）——'unknown' 的裁决在闸门与工作策略端口（只读语境放行、
 * 写语境 RISK_UNREGISTERED 拒绝），写能力必须先经风险登记审批（risk-registry.ts）。
 */
export interface McpToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  riskLevel: 'read' | 'write' | 'admin' | 'unknown'
}

export interface McpVersion {
  version: string
  changelog: string
  publishedAt: string
  status: 'current' | 'previous' | 'rolled-back'
}

export interface McpServiceRecord extends RecordBase {
  name: string
  slug: string
  description: string
  icon: string
  /** 业务分类（各资产板块统一口径 ASSET_CATEGORIES；缺省「其他」，存量记录读侧回落）。 */
  category?: string
  endpoint: string
  transport: 'stdio' | 'sse' | 'http'
  mode: 'hosted' | 'external'
  /** 外部服务自定义请求头（如 Authorization），调用/探活/工具发现时透传。 */
  headers?: Record<string, string>
  orgId: string
  owner: string
  // -- 治理字段（W1-T2，契约 §5，additive；存量记录由 ensureGovernanceMigration 启动补默认值） --
  /** 归属实体：缺省 {type:'platform'}（平台占位，治理待办 unowned；指派走 REST owner-entity 端点）。 */
  ownerEntity: McpOwnerEntity
  /** 能力声明 ID（W2-T4 app 能力绑定消费，additive 预留）。 */
  capabilityId?: string
  /** 暴露形态：缺省 'gateway'（网关面）；direct/internal 必须显式设置。 */
  exposureMode: McpExposureMode
  /** 数据分级（W3-T5 PDP ABAC 消费）：缺省 'internal'。 */
  dataClass: McpDataClass
  /** 环境：缺省 'prod'。 */
  environment: McpEnvironment
  /** 可见范围（W3-T5 组织硬约束消费）：缺省 'org'。 */
  visibility: McpVisibility
  /** 下游凭证引用（local:/env: 形态，值本体在 SecretBroker 密钥文件/环境变量，绝不入业务集合）。 */
  credentialRef?: string
  /** 桥接来源标记（如 open-connector）：M0 数据面桥接的治理降级标识——仅服务级粒度，
   *  无 action 级授权/连接级绑定/令牌镜像（dev-plan-connector §2.11）。控制台打徽章。 */
  bridgeFrom?: string
  /** 公司级终审标记（WP-10/L1）：终审通过的服务，其调用记录附带水印（审计可追溯）。 */
  finalReview?: { approverId: string; approverName: string; at: string; approvalId?: string }
  status: 'draft' | 'verifying' | 'online' | 'gray' | 'unhealthy' | 'offline'
  grayPercent: number
  currentVersion: string
  versions: McpVersion[]
  tools: McpToolSpec[]
  health: {
    lastProbeAt?: string
    status: 'unknown' | 'healthy' | 'degraded' | 'down'
    latencyMs?: number
    consecutiveFails: number
    breakerOpen: boolean
  }
  /** 模拟稳定性 0-1（演示数据用）。 */
  stability: number
  rateLimitPerMin: number
  /** 执行层：real=真实 HTTP 传输；demo=确定性模拟（显式降级，SLO/计费不统计）。 */
  exec: 'real' | 'demo'
}

export interface ToolPolicy {
  allowedTools: '*' | string[]
  constraints: { readOnly?: boolean; denyParams?: string[] }
}

export interface McpPermGroupRecord extends RecordBase {
  name: string
  description: string
  /** serviceId → 工具策略。 */
  policies: Record<string, ToolPolicy>
  subjects: Array<{ type: 'user_group' | 'agent' | 'app'; id: string; name?: string }>
}

export interface McpCallRecord {
  id: string
  at: string
  serviceId: string
  serviceName: string
  tool: string
  callerType: 'user' | 'agent' | 'app'
  callerId: string
  callerName: string
  onBehalfOf?: string
  actChain?: Array<{ name: string; type: string }>
  version: string
  ok: boolean
  status: 'ok' | 'error' | 'denied' | 'rate_limited' | 'breaker_open'
  latencyMs: number
  tokens: number
  error?: string
  /** 该调用走真实传输还是演示模拟（SLO/计费报表只统计 real）。 */
  exec: 'real' | 'demo'
  /** 调用水印（WP-10/L1）：服务经公司级终审后，其全部调用附带水印，审计可追溯。 */
  watermark?: { finalReview: true; at: string }
  /** 领域拒绝码（数字员工工作级授权拒绝时登记，审计可区分拒绝层级）。 */
  code?: WorkDenyCode
  /** 工作关联（D11 additive）：受管数字员工调用时与 workforce 账本的可穿透引用。 */
  work?: McpCallWorkRef
  // -- 全链 trace 与决策表达（W3-T5，契约 §14/§11，additive） --
  /** 本次调用 trace id（32hex；入口无 trace 即生成，可跨下游转发/审计/计量关联还原调用链）。 */
  traceId?: string
  /** 参数摘要哈希（sha256(args JSON)）；与 workforce 闸门的 argsHash 同源同值。 */
  argsHash?: string
  /** 上游 HTTP 状态码（real 传输返回时回填；demo/拒绝路径无上游缺省）。 */
  upstreamStatus?: number
  /** PDP 决策 id（pd_ 前缀；主裁决经 PolicyDecisionPoint 时登记，审计/拒绝响应可回查）。 */
  decisionId?: string
  /** PDP 决策理由聚合（deny 优先下首个 deny 模块的理由即主因，与 error 文案同源）。 */
  decisionReasons?: string[]
}

/** 调用记录的工作关联字段（additive，JSON 集合无严格 schema；§11.3 增量关联）。 */
export interface McpCallWorkRef {
  /** workforce 受控调用账本的调用 ID（生产侧提供时回填）。 */
  invocationId?: string
  /** 本次放行依据的工作授权（permit）ID（服务端 gate 核验结果）。 */
  permitId?: string
  /** 业务 run ID。 */
  runId?: string
  /** 执行员工 ID（服务端反查结果）。 */
  employeeId?: string
}

export interface InvokeCaller {
  type: 'user' | 'agent' | 'app'
  id: string
  name: string
  onBehalfOf?: string
  actChain?: Array<{ name: string; type: string }>
  // -- 统一 Principal 事实附加（W3-T5，契约 §11/§12/§14，additive；缺省=PDP 对应模块 fail-open，
  //    既有调用方（工具面 mcp_invoke 等）零感知；REST/数据面入口从 exchange.principal.unified 投影） --
  /** 调用者组织归属（unified.orgId）：org-constraint 模块消费；缺失按同组织口径放行。 */
  orgId?: string
  /** 调用者租户（unified.tenantId）：visibility='tenant' 三态判定消费。 */
  tenantId?: string
  /** 委托链真实用户（unified.subjectUserId）：委托链 org 与目标服务 org 一致性校验消费。 */
  subjectUserId?: string
  /** 令牌 scopes（unified.scopes）：iam-permission 第一层（mcp.invoke / 资源限定 scope）消费。 */
  scopes?: string[]
  /** 调用链 trace id（入口从 X-Trace-Id / mcp-session-id 头或受管 invocation 取；缺省入口生成）。 */
  traceId?: string
  /** 跨组织审批引用（context.approvalId）：visibility='cross-org' 服务的有效审批单 id。 */
  approvalId?: string
  /**
   * 权限组可匹配的主体集合（additive，W4 安全审计 P0-3）：主体自身（type/id）+ 委托链上的
   * app/agent 演员（按资源 id）。缺省=仅主体自身（既有调用方零感知）。
   * 委托语义：User → App/Agent → MCP 时真正执行动作的是链上 actor，授予它的权限组须对其生效。
   */
  subjects?: Array<{ type: 'user' | 'agent' | 'app'; id: string }>
}

/**
 * 网关拒绝码（W3-T5 additive）：在 workforce 领域拒绝码之外，PDP 新增模块的领域码——
 * ORG_SCOPE_DENIED（组织/租户硬约束）、SCOPE_DENIED（iam-permission 第一层）、
 * SCENE_DENIED（场景 ABAC）。与既有 WorkDenyCode 同样经 InvokeResult.code / 拒绝响应
 * data.code 透出，审计可区分拒绝层级。
 */
export type McpDenyCode = WorkDenyCode | 'ORG_SCOPE_DENIED' | 'SCOPE_DENIED' | 'SCENE_DENIED'

export interface InvokeResult {
  ok: boolean
  status: McpCallRecord['status']
  latencyMs: number
  version: string
  result?: unknown
  error?: string
  /** 领域拒绝码（additive）：status='denied' 且为工作级授权拒绝时携带，指导停止/申请/等待/重试。 */
  code?: McpDenyCode
  // -- 决策表达与全链 trace（W3-T5，契约 §11/§14，additive） --
  /** PDP 决策 id：主裁决经 PolicyDecisionPoint 时随结果透出（拒绝响应 data.code 旁附加）。 */
  decisionId?: string
  /** PDP 决策理由聚合（与 error 同源，error 取首个 deny 理由）。 */
  decisionReasons?: string[]
  /** 本次调用 trace id（与调用记录/审计事件关联）。 */
  traceId?: string
}

/** mcpServers 配置的单个服务条目（解析结果）。 */
export interface McpConfigEntry {
  name: string
  url: string
  transport: 'http' | 'sse'
  headers?: Record<string, string>
  description?: string
  /** 条目不可导入的原因（如 stdio 形态、url 缺失）。 */
  error?: string
}

/** 单条导入结果。 */
export interface McpImportResult {
  name: string
  ok: boolean
  slug?: string
  serviceId?: string
  tools?: number
  reachable?: boolean
  status?: string
  /** 导入携带的明文敏感头已自动迁入 SecretBroker（服务记录零明文，W1 治理语义）。 */
  brokered?: boolean
  error?: string
}

/**
 * 解析 mcpServers JSON（Claude Desktop / Cursor / Cherry Studio 等工具通行的形态）。
 * 支持三种输入：标准 {"mcpServers": {...}} 包装、裸 {名称: {url, ...}} 映射、单个 {url, type} 对象。
 * http / streamableHttp / streamable-http 归一为 http；stdio/command 形态标记为不可导入。
 */
export function parseMcpServersConfig(raw: string | object): McpConfigEntry[] {
  let config: unknown
  if (typeof raw === 'string') {
    try {
      config = JSON.parse(raw)
    } catch {
      throw new Error(t('配置不是合法 JSON，请粘贴完整的 mcpServers 配置文本'))
    }
  } else {
    config = raw
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(t('配置须为 JSON 对象，形如 {"mcpServers": {"服务名": {"type": "streamableHttp", "url": "https://…"}}}'))
  }
  const obj = config as Record<string, unknown>
  let map: Record<string, unknown> | undefined
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    map = obj.mcpServers as Record<string, unknown>
  } else if (typeof obj.url === 'string') {
    const host = (() => { try { return new URL(obj.url).hostname } catch { return 'mcp' } })()
    map = { [host]: obj }
  } else {
    const values = Object.values(obj)
    if (values.length > 0 && values.every((value) => value && typeof value === 'object' && !Array.isArray(value)
      && (typeof (value as Record<string, unknown>).url === 'string' || typeof (value as Record<string, unknown>).command === 'string'))) {
      map = obj
    }
  }
  if (!map || Object.keys(map).length === 0) {
    throw new Error(t('未识别出任何服务条目：需要 {"mcpServers": {"服务名": {"type": "...", "url": "..."}}} 形态'))
  }
  return Object.entries(map).map(([name, server]) => normalizeServerEntry(name, server))
}

function normalizeServerEntry(name: string, server: unknown): McpConfigEntry {
  const record = (server && typeof server === 'object' ? server : {}) as Record<string, unknown>
  const type = String(record.type ?? '').toLowerCase()
  const url = typeof record.url === 'string' ? record.url.trim() : ''
  const headers = normalizeConfigHeaders(record.headers)
  const base = {
    name,
    url,
    transport: 'http' as const,
    ...(headers ? { headers } : {}),
    ...(typeof record.description === 'string' && record.description ? { description: record.description } : {}),
  }
  if (!url) {
    const localProcess = type === 'stdio' || type === 'command' || typeof record.command === 'string'
    return { ...base, error: localProcess
      ? t('stdio/command 形态需在本地拉起进程，平台仅支持 http(streamableHttp)/sse 远程地址接入')
      : t('缺少 url 字段') }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ...base, error: t('url 不是合法地址：{url}', { url }) }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ...base, error: t('仅支持 http(s) 地址，收到 {protocol}', { protocol: parsed.protocol }) }
  }
  return { ...base, transport: type === 'sse' ? 'sse' : 'http' }
}

function normalizeConfigHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = String(val)
  }
  return Object.keys(out).length ? out : undefined
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class McpService extends Service {
  static readonly provide = 'mcpRegistry'

  private probeTimer: ReturnType<typeof setInterval> | undefined
  private rateBuckets = new Map<string, number[]>()
  /** 远端 streamable HTTP 会话缓存：endpoint → { sessionId（'' 表示无状态服务）, 过期时间 }。 */
  private mcpSessions = new Map<string, { sessionId: string; expiresAt: number }>()
  /** 风险登记服务引用（同插件 apply() 直连装配；独立单测宿主缺席=无生效登记口径）。 */
  private riskRegistryRef: McpToolRiskRegistry | undefined
  /** Secret Broker 引用（W1-T2 §6；同插件 apply() 直连装配，独立单测宿主缺席=不注入凭证）。 */
  private secretBrokerRef: SecretBroker | undefined

  constructor(ctx: Context) {
    super(ctx, 'mcpRegistry')
    ctx.effect(() => () => {
      if (this.probeTimer) clearInterval(this.probeTimer)
    })
    // 健康探活：30s 一轮，连续失败 3 次熔断
    this.probeTimer = setInterval(() => {
      void this.probeAll()
    }, 30_000)
    this.probeTimer.unref?.() // OPT-P3-02
  }

  services(): Collection<McpServiceRecord> {
    return this.ctx.opsStorage.collection<McpServiceRecord>('mcp:services')
  }

  permGroups(): Collection<McpPermGroupRecord> {
    return this.ctx.opsStorage.collection<McpPermGroupRecord>('mcp:permGroups')
  }

  calls(): Collection<McpCallRecord> {
    return this.ctx.opsStorage.collection<McpCallRecord>('mcp:calls')
  }

  /**
   * 风险登记服务取用（W1/V11）。console 的 inject 清单未含 mcpToolRisks——cordis 严格注入下
   * 跨 fiber 访问未声明键会被拦（cannot get property without inject），故 REST 面统一经本方法
   * 结构化取用（同插件 apply() 直连，不新增 console 依赖声明）；网关 invoke() 亦走同一引用。
   */
  riskRegistry(): McpToolRiskRegistry | undefined {
    return this.riskRegistryRef
  }

  /** apply() 装配时直连风险登记服务（同插件内无循环依赖：登记服务反向只读 services() 集合）。 */
  attachRiskRegistry(registry: McpToolRiskRegistry): void {
    this.riskRegistryRef = registry
  }

  /**
   * Secret Broker 取用（W1-T2 §6）：与 riskRegistry() 同款结构化取用——console 的 inject 清单
   * 未含 secretBroker，cordis 严格注入下跨 fiber 直访 ctx.secretBroker 会被拦（without inject），
   * REST 面统一经本方法取用。
   */
  secretBroker(): SecretBroker | undefined {
    return this.secretBrokerRef
  }

  /** apply() 装配时直连 Secret Broker（网关 resolveCallHeaders 与 REST 凭证面共用同一实例）。 */
  attachSecretBroker(broker: SecretBroker): void {
    this.secretBrokerRef = broker
  }

  // -- 注册与部署 ---------------------------------------------------------

  createService(input: {
    name: string
    slug?: string
    description?: string
    icon?: string
    /** 业务分类（各资产板块统一口径）；非法/缺省值归一化为「其他」。 */
    category?: string
    endpoint?: string
    transport?: McpServiceRecord['transport']
    mode?: McpServiceRecord['mode']
    orgId: string
    owner: string
    tools?: McpToolSpec[]
    headers?: Record<string, string>
    stability?: number
    /** 显式声明 demo 才使用模拟执行层；缺省一律 real（生态设计 v1.2 第 0 步）。 */
    exec?: 'real' | 'demo'
    /** M0 数据面桥接来源标记（open-connector 等），控制台打「桥接过渡」徽章。 */
    bridgeFrom?: string
    /** 治理字段（契约 §5，可选入参；缺省值见下方 insert——存量记录由启动迁移兜底）。 */
    ownerEntity?: McpOwnerEntity
    capabilityId?: string
    exposureMode?: McpExposureMode
    dataClass?: McpDataClass
    environment?: McpEnvironment
    visibility?: McpVisibility
    /** 下游凭证引用（local:/env: 形态；值本体在 SecretBroker，绝不入本记录）。 */
    credentialRef?: string
  }): McpServiceRecord {
    if (!input.name?.trim()) throw new Error(t('服务名称不能为空'))
    const slug = input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (this.services().findOne((item) => item.slug === slug)) throw new Error(t('服务标识已存在：{slug}', { slug }))
    // 治理字段枚举校验（契约 §5）：非法值显式报错
    const governance = normalizeGovernanceInput(input)
    if (input.mode !== 'external' && !input.endpoint) input.endpoint = `mcp+${input.transport ?? 'http'}://platform-hosted/${slug}`
    const toolSpecs = input.tools?.length ? input.tools : defaultToolsFor(slug)
    return this.services().insert({
      id: newId('mcp'),
      name: input.name,
      slug,
      description: input.description ?? '',
      icon: input.icon ?? 'mcp',
      category: normalizeAssetCategory(input.category),
      endpoint: input.endpoint ?? '',
      transport: input.transport ?? 'http',
      mode: input.mode ?? 'hosted',
      ...(input.headers ? { headers: input.headers } : {}),
      orgId: input.orgId,
      owner: input.owner,
      // 契约 §5 缺省值在写入侧一次补齐（治理摘要/迁移均按字段存在性判定，不依赖读侧兜底）
      ownerEntity: governance.ownerEntity ?? { type: 'platform' },
      exposureMode: governance.exposureMode ?? 'gateway',
      dataClass: governance.dataClass ?? 'internal',
      environment: governance.environment ?? 'prod',
      visibility: governance.visibility ?? 'org',
      ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      status: 'draft',
      grayPercent: 0,
      currentVersion: '0.1.0',
      versions: [],
      tools: toolSpecs,
      health: { status: 'unknown', consecutiveFails: 0, breakerOpen: false },
      stability: input.stability ?? 0.97,
      rateLimitPerMin: 60,
      exec: input.exec ?? 'real',
      ...(input.bridgeFrom ? { bridgeFrom: input.bridgeFrom } : {}),
    })
  }

  /** 通用 PATCH 允许直改的字段（治理归属 ownerEntity 不在列——走专用归属指派端点做资源校验）。 */
  private static readonly UPDATABLE_KEYS = [
    'name', 'description', 'icon', 'endpoint', 'tools', 'headers', 'rateLimitPerMin', 'category',
  ] as const

  updateService(id: string, patch: Partial<Pick<McpServiceRecord,
    'name' | 'description' | 'icon' | 'endpoint' | 'tools' | 'headers' | 'rateLimitPerMin' | 'category'
    | 'capabilityId' | 'exposureMode' | 'dataClass' | 'environment' | 'visibility' | 'credentialRef'
  >>): McpServiceRecord {
    const service = this.requireService(id)
    if (service.status === 'online' && patch.tools) {
      throw new Error(t('在线服务修改 Tool Schema 需先灰度新版本（版本不可变原则）'))
    }
    // 治理字段枚举校验（契约 §5）；白名单收敛写入键——REST PATCH 透传 body 的历史行为下
    // 未知键会被盲写进记录，治理字段必须经校验路径（ownerEntity 走专用端点，防绕过资源校验）
    const governance = normalizeGovernanceInput(patch)
    const next: Record<string, unknown> = {}
    for (const key of McpService.UPDATABLE_KEYS) {
      if (patch[key] !== undefined) next[key] = patch[key]
    }
    if (next['category'] !== undefined) next['category'] = normalizeAssetCategory(next['category'])
    for (const [key, value] of Object.entries(governance)) next[key] = value
    if (patch.capabilityId !== undefined) next.capabilityId = patch.capabilityId
    if (patch.credentialRef !== undefined) next.credentialRef = patch.credentialRef
    return this.services().update(id, next as Partial<McpServiceRecord>)
  }

  // -- 治理：归属指派 / 治理待办 / 存量迁移（W1-T2，契约 §5） --------------------------------

  /**
   * 归属指派：仅做形态校验与落库；type=app/agent 的资源存在性校验在 REST 层经
   * resourceCore 完成（plugin-mcp 不依赖 resource-core，保持装配面最小）。
   */
  setOwnerEntity(id: string, ownerEntity: McpOwnerEntity): McpServiceRecord {
    const normalized = normalizeGovernanceInput({ ownerEntity })
    return this.services().update(id, { ownerEntity: normalized.ownerEntity! })
  }

  /** 治理待办摘要（只读，契约 §5）：unowned / 明文敏感头 / 非 gateway 暴露 三类 + 总量。 */
  governanceSummary(): {
    unowned: Array<{ serviceId: string; serviceName: string; reason: string }>
    plainHeaderServices: Array<{ serviceId: string; serviceName: string; keys: string[] }>
    nonGateway: Array<{ serviceId: string; serviceName: string; exposureMode: string }>
    totals: { services: number; unowned: number; plainHeader: number; nonGateway: number }
  } {
    const services = this.services().all()
    const unowned = services
      .filter((service) => !service.ownerEntity || service.ownerEntity.type === 'platform' || !service.ownerEntity.id)
      .map((service) => ({
        serviceId: service.id,
        serviceName: service.name,
        reason: !service.ownerEntity || service.ownerEntity.type === 'platform'
          ? t('归属未指派（platform 占位，待能力绑定/指派）')
          : t('ownerEntity.type={type} 缺少资源 id', { type: service.ownerEntity.type }),
      }))
    const plainHeaderServices = services
      .map((service) => ({ service, keys: sensitiveHeaderKeys(service.headers) }))
      .filter((item) => item.keys.length > 0)
      .map(({ service, keys }) => ({ serviceId: service.id, serviceName: service.name, keys }))
    const nonGateway = services
      .filter((service) => (service.exposureMode ?? 'gateway') !== 'gateway')
      .map((service) => ({ serviceId: service.id, serviceName: service.name, exposureMode: service.exposureMode ?? 'gateway' }))
    return {
      unowned,
      plainHeaderServices,
      nonGateway,
      totals: {
        services: services.length,
        unowned: unowned.length,
        plainHeader: plainHeaderServices.length,
        nonGateway: nonGateway.length,
      },
    }
  }

  /**
   * 启动幂等迁移（仿 iam ensureConnectorPermissionsMigration 模式）：给存量服务记录补
   * 治理字段默认值（缺则补、永不删改）；迁移标记入 mcp:migrations 集合供观测。
   * 每次启动可重跑：已补齐的记录零写入；marker 仅作观测、不拦截重跑。
   */
  ensureGovernanceMigration(): { applied: boolean; touched: string[] } {
    const collection = this.ctx.opsStorage.collection<RecordBase & { key: string; note?: string }>('mcp:migrations')
    const marker = collection.findOne((item) => item.key === 'mcp-governance-v1')
    const touched: string[] = []
    for (const service of this.services().all()) {
      const patch: Partial<McpServiceRecord> = {}
      if (!service.ownerEntity) patch.ownerEntity = { type: 'platform' }
      if (!service.exposureMode) patch.exposureMode = 'gateway'
      if (!service.dataClass) patch.dataClass = 'internal'
      if (!service.environment) patch.environment = 'prod'
      if (!service.visibility) patch.visibility = 'org'
      if (Object.keys(patch).length === 0) continue
      this.services().update(service.id, patch)
      touched.push(service.id)
    }
    if (!marker) {
      collection.insert({
        id: newId('mig'),
        key: 'mcp-governance-v1',
        ...(touched.length > 0 ? { note: t('存量服务补治理默认值 ×{count}', { count: touched.length }) } : {}),
      })
    }
    return { applied: marker === undefined || touched.length > 0, touched }
  }

  /**
   * 明文敏感头迁移（契约 §6）：扫描全部服务 headers 中敏感键（口径同 maskServiceHeaders）→
   * dryRun 迁移预检报告；否则逐服务把敏感键值迁入 SecretBroker（headerName 取键名）、
   * 从 service.headers 删除敏感键、回写 credentialRef。存量明文只在此显式动作下离场，
   * 启动迁移（ensureGovernanceMigration）绝不删存量 headers。
   */
  migratePlainHeaders(options: { dryRun?: boolean } = {}): {
    dryRun: boolean
    candidates: Array<{ serviceId: string; serviceName: string; keys: string[] }>
    migrated: number
  } {
    const candidates = this.services().all()
      .map((service) => ({ service, keys: sensitiveHeaderKeys(service.headers) }))
      .filter((item) => item.keys.length > 0)
      .map(({ service, keys }) => ({ serviceId: service.id, serviceName: service.name, keys }))
    if (options.dryRun) return { dryRun: true, candidates, migrated: 0 }
    const broker = this.secretBrokerRef
    if (!broker) throw new Error(t('Secret Broker 未装配，无法迁移明文凭证头'))
    for (const item of candidates) {
      const service = this.requireService(item.serviceId)
      for (const key of item.keys) {
        const value = service.headers?.[key]
        if (value) broker.put({ serviceId: service.id, headerName: key, secret: value })
      }
      const description = broker.describe(service.id)
      const remaining: Record<string, string> = { ...(service.headers ?? {}) }
      for (const key of item.keys) delete remaining[key]
      this.services().update(service.id, {
        headers: Object.keys(remaining).length > 0 ? remaining : undefined,
        ...(description?.credentialRef ? { credentialRef: description.credentialRef } : {}),
      })
    }
    return { dryRun: false, candidates, migrated: candidates.length }
  }

  /** 连接远端 MCP 服务拉取工具清单（initialize → tools/list）；导入与同步共用。 */
  async listRemoteTools(endpoint: string, headers?: Record<string, string>): Promise<McpToolSpec[]> {
    const sessionId = await this.ensureSession(endpoint, headers)
    const { payload } = await this.mcpRequest(endpoint, headers, {
      jsonrpc: '2.0',
      id: `dsh-list-${Date.now()}`,
      method: 'tools/list',
      params: {},
    }, REAL_TRANSPORT_TIMEOUT_MS, sessionId)
    if (payload?.error) throw new Error(t('tools/list 失败：{reason}', { reason: payload.error.message ?? t('未知错误') }))
    const tools = Array.isArray(payload?.result?.tools) ? payload.result.tools : []
    return tools
      .map((tool: { name?: unknown; description?: unknown; inputSchema?: unknown }) => ({
        name: String(tool.name ?? ''),
        description: String(tool.description ?? ''),
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
          ? tool.inputSchema as Record<string, unknown>
          : { type: 'object', properties: {} },
        // V11 根治核心：远端 tools/list 不再隐式映射 read——远端清单无法自证风险，
        // 一律 'unknown' 入账，写能力须经风险登记（mcpToolRisks）审批生效后放行。
        riskLevel: 'unknown' as const,
      }))
      .filter((tool: McpToolSpec) => tool.name)
  }

  /**
   * 外部服务工具同步：以远端 tools/list 为准刷新本地清单。
   * 绕过 updateService 的版本不可变校验——外部服务的工具清单是远端事实的镜像同步，
   * 不是平台侧的版本变更（版本流程仍约束托管服务）。
   */
  async syncTools(serviceId: string): Promise<McpServiceRecord> {
    const service = this.requireService(serviceId)
    if (service.mode !== 'external') throw new Error(t('仅外部注册服务支持工具同步'))
    if (service.exec !== 'real') throw new Error(t('演示传输层服务不支持工具同步'))
    // W1-T2 §6 注入点：透传前经 SecretBroker 组装凭证头（存量非敏感 headers 照旧）
    const tools = await this.listRemoteTools(service.endpoint, await this.resolveCallHeaders(service))
    if (!tools.length) throw new Error(t('远端服务未返回任何工具'))
    const updated = this.services().update(serviceId, { tools })
    this.noteBusinessSuccess(updated)
    return updated
  }

  /**
   * mcpServers JSON 一键导入（Claude Desktop / Cursor / Cherry Studio 等工具通行的配置形态）：
   * 解析 → 注册外部服务（exec=real）→ initialize+tools/list 自动发现工具 →（可选）验证并上线。
   * 单条目失败不阻断其余条目；远端不可达时保留草稿并回传原因。
   */
  async importServices(input: { config: string | object; orgId: string; owner: string; autoDeploy?: boolean }): Promise<{
    imported: number
    results: McpImportResult[]
  }> {
    const entries = parseMcpServersConfig(input.config)
    const results: McpImportResult[] = []
    for (const entry of entries) {
      if (entry.error) {
        results.push({ name: entry.name, ok: false, error: entry.error })
        continue
      }
      try {
        const entryHeaders = entry.headers ?? {}
        const bridgedFrom = Object.entries(entryHeaders)
          .find(([key]) => key.toLowerCase() === 'x-bridged-from')?.[1]
        // W1 治理（契约 §6，CTO 裁决 2026-10-22）：导入入口自动入保险箱——敏感键值不落
        // 业务集合，改经 SecretBroker 登记（服务记录只留非敏感头 + credentialRef）。
        // 与 create/PATCH 的 400 门禁不同：导入多为连接器桥接的机器流程，拒绝会断链，
        // 故采取「导入即迁移」语义；SecretBroker 未装配时回落存量明文行为（降级兼容）。
        const plainKeys = sensitiveHeaderKeys(entryHeaders)
        const keptHeaders = plainKeys.length > 0
          ? Object.fromEntries(Object.entries(entryHeaders).filter(([key]) => !plainKeys.includes(key)))
          : entryHeaders
        let brokered = false
        const service = this.createService({
          name: entry.name,
          endpoint: entry.url,
          transport: entry.transport,
          mode: 'external',
          exec: 'real',
          orgId: input.orgId,
          owner: input.owner,
          ...(Object.keys(keptHeaders).length > 0 ? { headers: keptHeaders } : {}),
          // M0 数据面桥接打标：连接器网关导入的 MCP 服务带治理降级徽章（§2.11）
          ...(bridgedFrom ? { bridgeFrom: String(bridgedFrom) } : {}),
          ...(entry.description ? { description: entry.description } : {}),
          tools: [],
        })
        if (plainKeys.length > 0 && this.secretBrokerRef) {
          for (const key of plainKeys) {
            this.secretBrokerRef.put({ serviceId: service.id, credentialRef: 'local:', headerName: key, secret: entryHeaders[key] })
          }
          this.services().update(service.id, { credentialRef: 'local:' })
          brokered = true
        }
        let tools: McpToolSpec[] = []
        let reachable = false
        let message = ''
        try {
          // W1-T2 §6 注入点：自动发现同样经 SecretBroker 组装凭证头（新服务此刻通常无登记，miss 回落）
          tools = await this.listRemoteTools(service.endpoint, await this.resolveCallHeaders(service))
          reachable = true
        } catch (error) {
          message = t('工具自动发现失败：{reason}', { reason: error instanceof Error ? error.message : String(error) })
        }
        this.services().update(service.id, {
          // 不可达时清空默认三件套，避免伪工具清单进入权限组
          ...(reachable ? { tools } : { tools: [] as McpToolSpec[] }),
          health: { lastProbeAt: now(), status: reachable ? 'healthy' : 'unknown', latencyMs: 0, consecutiveFails: 0, breakerOpen: false },
        })
        let status = service.status
        if (reachable && input.autoDeploy !== false) {
          try {
            await this.verifyService(service.id)
            const deployed = await this.deployService(service.id, { grayPercent: 100, changelog: 'mcpServers 配置导入自动发布', actor: input.owner })
            status = deployed.status
          } catch (error) {
            message = `${message ? `${message}；` : ''}${t('自动发布失败：{reason}', { reason: error instanceof Error ? error.message : String(error) })}`
          }
        }
        results.push({
          name: entry.name, ok: true, slug: service.slug, serviceId: service.id,
          tools: tools.length, reachable, status,
          ...(brokered ? { brokered: true } : {}),
          ...(message ? { error: message } : {}),
        })
      } catch (error) {
        results.push({ name: entry.name, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { imported: results.filter((item) => item.ok).length, results }
  }

  /** 测试环境验证：real 服务做真实 initialize 探测；demo 服务模拟探测。 */
  async verifyService(id: string): Promise<McpServiceRecord> {
    const service = this.requireService(id)
    if (service.status !== 'draft') throw new Error(t('仅草稿状态可执行测试验证'))
    this.services().update(id, { status: 'verifying' })
    const latency = service.exec === 'real' ? await this.realProbe(service) : 200
    if (latency < 0) {
      this.services().update(id, { status: 'draft' })
      throw new Error(t('测试验证失败：endpoint {endpoint} 不可达', { endpoint: service.endpoint }))
    }
    return this.services().update(id, { health: { lastProbeAt: now(), status: 'healthy', latencyMs: latency, consecutiveFails: 0, breakerOpen: false } })
  }

  /** 发布上线（可选灰度比例），记录版本。 */
  async deployService(id: string, options: { grayPercent?: number; version?: string; changelog?: string; actor: string }): Promise<McpServiceRecord> {
    const service = this.requireService(id)
    if (!['draft', 'verifying', 'gray', 'online', 'unhealthy'].includes(service.status)) {
      throw new Error(t('当前状态 {status} 不允许发布', { status: service.status }))
    }
    const version = options.version ?? bumpVersion(service.currentVersion)
    const gray = Math.min(100, Math.max(0, options.grayPercent ?? 100))
    await sleep(200)
    const updated = this.services().update(id, {
      status: gray >= 100 ? 'online' : 'gray',
      grayPercent: gray,
      currentVersion: version,
      versions: [
        ...service.versions.map((item) => ({ ...item, status: item.status === 'current' ? 'previous' : item.status })),
        { version, changelog: options.changelog ?? t('例行更新'), publishedAt: now(), status: 'current' },
      ],
      health: { ...service.health, status: 'healthy', consecutiveFails: 0, breakerOpen: false },
    })
    this.ctx.platformBus.emit(PlatformEvents.McpDeployed, {
      serviceId: id, name: updated.name, version, grayPercent: gray, actor: options.actor, type: 'mcp_service', slug: updated.slug,
    })
    return updated
  }

  async rollbackService(id: string, targetVersion: string, actor: string): Promise<McpServiceRecord> {
    const service = this.requireService(id)
    const target = service.versions.find((item) => item.version === targetVersion)
    if (!target) throw new Error(t('目标版本不存在：{version}', { version: targetVersion }))
    if (target.status === 'current') throw new Error(t('目标版本 {version} 即当前版本，无需回滚', { version: targetVersion }))
    if (target.status === 'rolled-back') throw new Error(t('目标版本 {version} 已被回滚过，不允许作为回滚目标（版本不可变原则）', { version: targetVersion }))
    const updated = this.services().update(id, {
      currentVersion: targetVersion,
      versions: service.versions.map((item) => ({
        ...item,
        status: item.version === targetVersion ? 'current' : item.status === 'current' ? 'rolled-back' : item.status,
      })),
    })
    this.ctx.platformBus.emit(PlatformEvents.McpDeployed, {
      serviceId: id, name: updated.name, version: targetVersion, rollback: true, actor, type: 'mcp_service', slug: updated.slug,
    })
    return updated
  }

  offlineService(id: string, actor: string, reason: string): McpServiceRecord {
    const service = this.requireService(id)
    if (service.status === 'offline') throw new Error(t('服务已是下线状态'))
    const updated = this.services().update(id, { status: 'offline', grayPercent: 0 })
    this.ctx.platformBus.emit(PlatformEvents.McpOfflined, { serviceId: id, name: updated.name, actor, reason, type: 'mcp_service', slug: updated.slug })
    return updated
  }

  /** L4 下线走审批：创建审批单，通过后自动执行。 */
  requestOfflineApproval(id: string, requester: { id: string; name: string }, reason: string, impactPreview: string[]) {
    return this.ctx.audit.createApproval({
      kind: 'mcp.offline',
      // WP-10/L1（QA A-06）：L4 高危统一高风险——通过需二次确认 + 公司级终审标记
      riskLevel: 'high',
      title: t('下线 MCP 服务：{name}', { name: this.requireService(id).name }),
      payload: { serviceId: id, reason, impactPreview },
      requesterId: requester.id,
      requesterName: requester.name,
    })
  }

  /** 删除后的关联清理：远端会话与限流缓存、Broker 密钥文件一并清除；调用明细与审计数据保留。 */
  purgeService(id: string): void {
    const service = this.requireService(id)
    this.mcpSessions.delete(service.endpoint)
    for (const key of [...this.rateBuckets.keys()]) {
      if (key.startsWith(`${id}:`)) this.rateBuckets.delete(key)
    }
    // W1-T2 §6：服务删除连带清除下游凭证文件（不落孤儿密钥）
    try {
      this.secretBrokerRef?.delete(id)
    } catch { /* 单测宿主无数据目录等场景不阻断删除主流程 */ }
    this.services().remove(id)
  }

  // -- 健康探活 -----------------------------------------------------------

  async probeService(id: string): Promise<{ status: string; latencyMs: number }> {
    const service = this.requireService(id)
    if (service.status === 'offline' || service.status === 'draft') {
      return { status: 'unknown', latencyMs: 0 }
    }
    // real：真实 HTTP 探测（POST initialize，测往返与延迟）；demo（含存量无标记）：确定性模拟
    let latency: number
    if (service.exec === 'real') {
      latency = await this.realProbe(service)
    } else {
      latency = probeLatency(service)
    }
    const ok = latency > 0
    const fails = ok ? 0 : service.health.consecutiveFails + 1
    const breakerOpen = fails >= 3
    const status = ok ? (latency > 800 ? 'degraded' : 'healthy') : 'down'
    const update: McpServiceRecord = this.services().update(id, {
      health: { lastProbeAt: now(), status, latencyMs: Math.max(0, latency), consecutiveFails: fails, breakerOpen },
      ...(breakerOpen && service.status !== 'unhealthy' ? { status: 'unhealthy' } : {}),
      ...(ok && service.status === 'unhealthy' ? { status: service.grayPercent >= 100 ? 'online' : 'gray' } : {}),
    })
    if (breakerOpen && service.status !== 'unhealthy') {
      this.ctx.platformBus.emit(PlatformEvents.McpUnhealthy, {
        serviceId: id, name: service.name, consecutiveFails: fails, latencyMs: latency,
      })
    }
    return { status: update.health.status, latencyMs: latency }
  }

  private async probeAll(): Promise<void> {
    for (const service of this.services().all()) {
      if (service.status === 'offline' || service.status === 'draft') continue
      try {
        await this.probeService(service.id)
      } catch (error) {
        this.ctx.logger('mcp').warn('探活失败', service.id, error)
      }
    }
  }

  /** 业务失败计入熔断：真实调用失败与探活失败共用连续失败计数（连续 3 次开熔断）。 */
  private noteBusinessFailure(service: McpServiceRecord, reason: string): void {
    const fails = service.health.consecutiveFails + 1
    const breakerOpen = fails >= 3
    this.services().update(service.id, {
      health: { ...service.health, lastProbeAt: now(), status: breakerOpen ? 'down' : 'degraded', consecutiveFails: fails, breakerOpen },
      ...(breakerOpen && service.status !== 'unhealthy' ? { status: 'unhealthy' } : {}),
    })
    if (breakerOpen && service.status !== 'unhealthy') {
      this.ctx.platformBus.emit(PlatformEvents.McpUnhealthy, {
        serviceId: service.id, name: service.name, consecutiveFails: fails, latencyMs: 0,
        reason: t('业务调用连续失败 {fails} 次：{reason}', { fails, reason }),
      })
    }
  }

  /** 业务成功即半闭合：清零失败计数、解除熔断（下次探活仍会复核）。 */
  private noteBusinessSuccess(service: McpServiceRecord): void {
    if (service.health.consecutiveFails === 0 && !service.health.breakerOpen) return
    this.services().update(service.id, {
      health: { ...service.health, status: 'healthy', consecutiveFails: 0, breakerOpen: false },
      ...(service.status === 'unhealthy' ? { status: service.grayPercent >= 100 ? 'online' : 'gray' } : {}),
    })
  }

  async healthCheck(id: string): Promise<{ status: string; latencyMs: number }> {
    return this.probeService(id)
  }

  /** 真实探活：MCP initialize 握手，返回延迟（ms）；失败返回 -1。 */
  private async realProbe(service: McpServiceRecord): Promise<number> {
    const started = Date.now()
    try {
      // W1-T2 §6 注入点：探活与调用同源凭证（SecretBroker 组装，存量 headers 照旧）；
      // W3-T5 §14：探活是周期性噪声源（长驻服务约 3千条/天/服务），访问留痕按窗口去重
      const { payload } = await this.mcpRequest(service.endpoint, await this.resolveCallHeaders(service, { dedupKey: 'probe' }), {
        jsonrpc: '2.0',
        id: `probe-${Date.now()}`,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-ops-probe', version: '1.0' } },
      }, REAL_PROBE_TIMEOUT_MS)
      if (payload?.error) return -1
      return Date.now() - started
    } catch {
      return -1
    }
  }

  /**
   * MCP streamable HTTP 请求基座：单 POST JSON-RPC，兼容两种响应形态——纯 JSON 与
   * SSE 流（text/event-stream，取首个 data 帧）；透传服务自定义头（如 Authorization），
   * 回传服务端下发的 Mcp-Session-Id 供有状态服务复用。
   */
  private async mcpRequest(endpoint: string, headers: Record<string, string> | undefined, message: Record<string, unknown>, timeoutMs: number, sessionId?: string): Promise<{ payload: any; sessionId?: string; status?: number }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...(headers ?? {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(t('MCP 服务 HTTP {status}：{body}', { status: response.status, body: (await response.text().catch(() => '')).slice(0, 200) }))
      }
      // 上游 HTTP 状态（W3-T5 §14 upstreamStatus 回填源；additive，既有调用方零感知）
      const status = response.status
      const sessionIdHeader = response.headers.get('mcp-session-id') ?? undefined
      const contentType = String(response.headers.get('content-type') ?? '')
      const text = await response.text()
      if (contentType.includes('text/event-stream')) {
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue
          const frame = line.slice(5).trim()
          if (!frame || frame === '[DONE]') continue
          try { return { payload: JSON.parse(frame), sessionId: sessionIdHeader, status } } catch { /* 跳过非 JSON 帧 */ }
        }
        throw new Error(t('MCP 服务 SSE 响应中未找到 JSON-RPC 帧'))
      }
      if (!text) return { payload: null, sessionId: sessionIdHeader, status } // 202 Accepted 等空体响应（通知类消息）
      try {
        return { payload: JSON.parse(text), sessionId: sessionIdHeader, status }
      } catch {
        throw new Error(t('MCP 服务响应不是合法 JSON：{body}', { body: text.slice(0, 200) }))
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 确立远端会话：initialize 握手并缓存 sessionId（无状态服务缓存 ''，避免每次重复握手）。 */
  private async ensureSession(endpoint: string, headers?: Record<string, string>): Promise<string | undefined> {
    const cached = this.mcpSessions.get(endpoint)
    if (cached && cached.expiresAt > Date.now()) return cached.sessionId || undefined
    const { payload, sessionId } = await this.mcpRequest(endpoint, headers, {
      jsonrpc: '2.0',
      id: `dsh-init-${Date.now()}`,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-ops-gateway', version: '1.0' } },
    }, REAL_PROBE_TIMEOUT_MS)
    if (payload?.error) throw new Error(t('initialize 失败：{reason}', { reason: payload.error.message ?? t('未知错误') }))
    const effective = sessionId ?? ''
    this.mcpSessions.set(endpoint, { sessionId: effective, expiresAt: Date.now() + MCP_SESSION_TTL_MS })
    if (effective) {
      // 有状态服务要求补发 initialized 通知；无状态服务忽略即可，失败不阻断。
      await this.mcpRequest(endpoint, headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, REAL_PROBE_TIMEOUT_MS, effective).catch(() => undefined)
    }
    return effective || undefined
  }

  // -- 权限组 -------------------------------------------------------------

  createPermGroup(input: {
    name: string
    description?: string
    policies: Record<string, ToolPolicy>
    subjects: McpPermGroupRecord['subjects']
  }): McpPermGroupRecord {
    if (!input.name?.trim()) throw new Error(t('权限组名称不能为空'))
    if (this.permGroups().findOne((group) => group.name === input.name)) throw new Error(t('权限组已存在：{name}', { name: input.name }))
    for (const serviceId of Object.keys(input.policies)) {
      this.requireService(serviceId)
    }
    return this.permGroups().insert({
      id: newId('mpg'),
      name: input.name,
      description: input.description ?? '',
      policies: input.policies,
      subjects: input.subjects,
    })
  }

  updatePermGroup(id: string, patch: Partial<Pick<McpPermGroupRecord, 'name' | 'description' | 'policies' | 'subjects'>>): McpPermGroupRecord {
    return this.permGroups().update(id, patch)
  }

  deletePermGroup(id: string): boolean {
    return this.permGroups().remove(id)
  }

  /** 授予主体访问：加入权限组。 */
  grantSubject(groupId: string, subject: McpPermGroupRecord['subjects'][number]): McpPermGroupRecord {
    const group = this.permGroups().get(groupId)
    if (!group) throw new Error(t('权限组不存在：{id}', { id: groupId }))
    if (group.subjects.some((item) => item.type === subject.type && item.id === subject.id)) return group
    return this.permGroups().update(groupId, { subjects: [...group.subjects, subject] })
  }

  // -- 资源限定 scope 模板 / 策略模拟（W3-T5，契约 §12/§14） ---------------------------------

  /**
   * scope 模板（契约 §12）：按权限组 policies 生成建议的资源限定 scope 集——
   *   - allowedTools='*'（服务全量）→ 建议服务级 `mcp.service:<slug>.invoke`；
   *   - allowedTools 白名单 → 逐工具 `mcp.tool:<slug>:<tool>.invoke`（readOnly 组不产出
   *     write/admin 工具的 scope，模板与裁决面同判）；服务不存在/工具不在清单的引用跳过。
   * dry 语义：只读推导，不落库不副作用；控制台（W3-T6）与「新增授权默认产出 scope 模板」消费。
   */
  scopeTemplate(groupId: string): {
    scopes: string[]
    byService: Array<{ serviceId: string; slug: string; scopes: string[] }>
  } {
    const group = this.permGroups().get(groupId)
    if (!group) throw new Error(t('权限组不存在：{id}', { id: groupId }))
    const byService: Array<{ serviceId: string; slug: string; scopes: string[] }> = []
    const all = new Set<string>()
    for (const [serviceId, policy] of Object.entries(group.policies)) {
      const service = this.services().get(serviceId)
      if (!service) continue
      const scopes: string[] = []
      if (policy.allowedTools === '*') {
        scopes.push(`mcp.service:${service.slug}.invoke`)
      } else {
        for (const toolName of policy.allowedTools) {
          const tool = service.tools.find((item) => item.name === toolName)
          if (!tool) continue
          // 只读约束组：写/admin 工具不产出 scope（模板=裁决面口径，避免模板越权误导）
          if (policy.constraints.readOnly && (tool.riskLevel === 'write' || tool.riskLevel === 'admin')) continue
          scopes.push(`mcp.tool:${service.slug}:${tool.name}.invoke`)
        }
      }
      if (scopes.length === 0) continue
      for (const scope of scopes) all.add(scope)
      byService.push({ serviceId, slug: service.slug, scopes })
    }
    return { scopes: [...all], byService }
  }

  /**
   * 策略模拟 / 影响分析（契约 §14）：body=完整权限组草稿，不落库——影响报告四维：
   *   - newServices：policies 覆盖的服务（服务不存在引用跳过）；
   *   - writeTools：覆盖服务中 allowedTools 命中的 riskLevel write/admin 工具；
   *   - confidential：覆盖服务中 dataClass=confidential 的服务；
   *   - crossOrg：服务 org 与 subjects 可达 org 已知且不一致（user_group 经成员展开、
   *     agent/app 经 resourceCore 归属；org 缺失不可判 → 不计）；
   *   - affectedSubjects：subjects 原样展开。
   */
  dryRunPermGroup(draft: {
    name?: string
    policies?: Record<string, ToolPolicy>
    subjects?: McpPermGroupRecord['subjects']
  }): {
    newServices: Array<{ serviceId: string; slug: string; name: string }>
    writeTools: Array<{ serviceId: string; slug: string; tool: string }>
    confidential: Array<{ serviceId: string; slug: string; dataClass: string }>
    crossOrg: boolean
    affectedSubjects: McpPermGroupRecord['subjects']
  } {
    const policies = draft.policies ?? {}
    const subjects = draft.subjects ?? []
    const newServices: Array<{ serviceId: string; slug: string; name: string }> = []
    const writeTools: Array<{ serviceId: string; slug: string; tool: string }> = []
    const confidential: Array<{ serviceId: string; slug: string; dataClass: string }> = []
    const serviceOrgs = new Set<string>()
    for (const [serviceId, policy] of Object.entries(policies)) {
      const service = this.services().get(serviceId)
      if (!service) continue
      newServices.push({ serviceId, slug: service.slug, name: service.name })
      if (service.orgId) serviceOrgs.add(service.orgId)
      if ((service.dataClass ?? 'internal') === 'confidential') {
        confidential.push({ serviceId, slug: service.slug, dataClass: service.dataClass })
      }
      for (const tool of service.tools) {
        if (tool.riskLevel !== 'write' && tool.riskLevel !== 'admin') continue
        const granted = policy.allowedTools === '*' || policy.allowedTools.includes(tool.name)
        if (granted) writeTools.push({ serviceId, slug: service.slug, tool: tool.name })
      }
    }
    // subjects 可达组织：任一（服务org × 主体org）已知且不同 → crossOrg
    let crossOrg = false
    for (const subject of subjects) {
      const orgs = this.subjectReachableOrgs(subject)
      if (orgs.size === 0) continue
      for (const serviceOrg of serviceOrgs) {
        if (!orgs.has(serviceOrg)) crossOrg = true
      }
    }
    return { newServices, writeTools, confidential, crossOrg, affectedSubjects: subjects }
  }

  /** 主体可达组织集合（dry-run crossOrg 判定）：user_group 经 iam 成员展开；agent/app 经 resourceCore 归属；不可解析=空集（不计）。 */
  private subjectReachableOrgs(subject: McpPermGroupRecord['subjects'][number]): Set<string> {
    const orgs = new Set<string>()
    try {
      if (subject.type === 'user_group') {
        for (const member of this.ctx.iam.resolveGroupMembers(subject.id)) {
          const orgId = (member as { orgId?: string }).orgId
            ?? (this.ctx.iam as { users?: () => { get: (id: string) => { orgId?: string } | undefined } }).users?.().get(member.id)?.orgId
          if (orgId) orgs.add(orgId)
        }
        return orgs
      }
      const core = (this.ctx as unknown as { resourceCore?: { get: (kind: string, id: string) => { orgId?: string } | undefined } }).resourceCore
      const orgId = core?.get(subject.type, subject.id)?.orgId
      if (orgId) orgs.add(orgId)
    } catch { /* 解析失败按空集（不可判不计） */ }
    return orgs
  }

  /**
   * 权限组主体匹配（W2-T3 契约 §8 抽取）：返回命中该 caller 的全部服务策略。
   * 主体三类：user_group（human 经 iam 用户组解析）/ agent / app；多组命中时由
   * decideTool 依 grants 顺序逐一裁决（与既有 authorize 行为一致，抽取非复制）。
   */
  private matchedPolicies(caller: InvokeCaller, serviceId: string): ToolPolicy[] {
    const grants: ToolPolicy[] = []
    // 可匹配主体集合：caller.subjects（主体 + 委托链 actor，additive）缺省时回落主体自身
    const subjectPool: Array<{ type: 'user' | 'agent' | 'app'; id: string }> = caller.subjects?.length
      ? caller.subjects
      : [{ type: caller.type, id: caller.id }]
    for (const group of this.permGroups().all()) {
      const policy = group.policies[serviceId]
      if (!policy) continue
      const hit = group.subjects.some((subject) => {
        if (subject.type === 'user_group') {
          // 用户组主体：任一 pool 内的真人命中组成员即算命中
          return subjectPool.some((candidate) => candidate.type === 'user'
            && this.ctx.iam.resolveGroupMembers(subject.id).some((user) => user.id === candidate.id))
        }
        return subjectPool.some((candidate) => subject.type === candidate.type && subject.id === candidate.id)
      })
      if (hit) grants.push(policy)
    }
    return grants
  }

  /**
   * 单工具裁决（W2-T3 契约 §8 抽取）：authorize() 与 authorizedToolsFor() 共用同一判定——
   * 按 grants 顺序取首个 allowedTools 命中的策略定裁决；只读语境拦截 write/admin。
   * W1/V11 只读约束口径（与工作策略端口同判）：unknown 按只读语境放行（未登记工具在
   * 只读语境下视为 read——写能力已被写语境拒绝面兜住，残余风险由重审清单 reviewList 收敛，
   * 不再「未知即拒」误伤只读消费）。
   */
  private decideTool(grants: ToolPolicy[], tool: McpToolSpec): { ok: true; readOnly: boolean } | { ok: false; reason: string } {
    for (const policy of grants) {
      const allowed = policy.allowedTools === '*' || policy.allowedTools.includes(tool.name)
      if (!allowed) continue
      if (policy.constraints.readOnly && (tool.riskLevel === 'write' || tool.riskLevel === 'admin')) {
        return { ok: false, reason: t('权限组约束为只读模式，工具 {tool}（{risk}）被拒绝', { tool: tool.name, risk: tool.riskLevel }) }
      }
      return { ok: true, readOnly: Boolean(policy.constraints.readOnly) }
    }
    return { ok: false, reason: t('工具 {tool} 不在授权列表中', { tool: tool.name }) }
  }

  /** 授权检查：返回可用的策略上下文或拒绝原因。 */
  authorize(caller: InvokeCaller, serviceId: string, toolName: string): { ok: true; readOnly: boolean } | { ok: false; reason: string } {
    const service = this.requireService(serviceId)
    const tool = service.tools.find((item) => item.name === toolName)
    if (!tool) return { ok: false, reason: t('服务 {service} 不存在工具 {tool}', { service: service.name, tool: toolName }) }
    const grants = this.matchedPolicies(caller, serviceId)
    if (grants.length === 0) {
      return { ok: false, reason: t('主体 {name} 未被任何 MCP 权限组授权访问 {service}', { name: caller.name, service: service.name }) }
    }
    return this.decideTool(grants, tool)
  }

  /**
   * 可调用工具集合（W2-T3 契约 §8 新导出）：当前身份在该服务可调用的工具名列表——
   * 权限组主体匹配 + allowedTools 交集 + readOnly 约束过滤 write/admin 工具，与 authorize()
   * 单工具判定完全同源（matchedPolicies/decideTool 共用，行为等价）。
   * 无权限组/无命中 → 空数组（服务级 tools/list 据此回空集，未授权工具一概不出现；
   * 高敏数据类的 ABAC 收敛在 W3-T5 PDP 落地，本集合按权限组 fail-closed 已满足
   * 「无授权不出现」验收口径）。服务级端点 tools/list 与 tools/call 一致性都以此为边界。
   */
  authorizedToolsFor(caller: InvokeCaller, service: McpServiceRecord): string[] {
    const grants = this.matchedPolicies(caller, service.id)
    if (grants.length === 0) return []
    return service.tools.filter((tool) => this.decideTool(grants, tool).ok).map((tool) => tool.name)
  }

  // -- 主裁决 PDP（W3-T5，契约 §11/§12/§13） ---------------------------------
  //
  // MCP invoke 主裁决收敛进 PolicyDecisionPoint：authorize() 的权限组判定迁入
  // mcp-permgroup 模块（matchedPolicies/decideTool 判定面原样共用，行为等价——
  // authorize()/authorizedToolsFor() 与模块读同一对私有方法，不存在第二份裁决逻辑），
  // 新增 iam-permission（资源限定 scope 第一层）/ scene（场景 ABAC）/ org-constraint
  // （组织租户硬约束）/ risk-gate（unknown 风险写语境拒绝）四个模块。模块序与既有
  // 闸门序一致：scope → 权限组 → 场景 → 组织 → 风险；首个 deny 模块的理由即主因
  // （既有领域拒绝文案不漂移），deny 码经 denyCodeOf 映射领域码。

  /** 网关 PDP 实例（懒构建；模块注册序即裁决序，见各模块注释）。 */
  private gatewayPdp: PolicyDecisionPoint | undefined

  private pdp(): PolicyDecisionPoint {
    if (this.gatewayPdp) return this.gatewayPdp
    const pdp = new PolicyDecisionPoint()
    pdp.register(this.iamPermissionModule())
    pdp.register(this.mcpPermGroupModule())
    pdp.register(this.sceneModule())
    pdp.register(this.orgConstraintModule())
    pdp.register(this.riskGateModule())
    this.gatewayPdp = pdp
    return pdp
  }

  /** 判定面主体投影：InvokeCaller → UnifiedPrincipal 最小形态（PDP 契约类型要求；scopes/组织等事实随 req.context 携带）。 */
  private subjectOf(caller: InvokeCaller): UnifiedPrincipal {
    const kind = caller.type === 'user' ? 'human' as const : caller.type === 'agent' ? 'agent' as const : 'app' as const
    return {
      principalId: caller.id,
      kind,
      ...(caller.type === 'user' ? { userId: caller.id } : caller.type === 'agent' ? { agentId: caller.id } : { appId: caller.id }),
      ...(caller.orgId !== undefined ? { orgId: caller.orgId } : {}),
      ...(caller.tenantId !== undefined ? { tenantId: caller.tenantId } : {}),
      ...(caller.subjectUserId !== undefined ? { subjectUserId: caller.subjectUserId } : {}),
      authMethod: 'client-credentials',
      tokenId: '',
      scopes: [...(caller.scopes ?? [])],
      actChain: (caller.actChain ?? []).map((entry, index) => ({ kind: entry.type === 'human' ? 'user' as const : 'platform-service' as const, id: `${caller.id}#${index}`, name: entry.name })),
      name: caller.name,
      permissions: [...(caller.scopes ?? [])],
    }
  }

  /**
   * 第一层 iam-permission（契约 §12）：unified.scopes 含 mcp.invoke（全局）或
   * mcp.service:<本服务>.invoke / mcp.tool:<本服务>:<本工具>.invoke 任一即过第一层；
   * '*' 平台主体直通。 scopes 未随调用携带（legacy 工具面调用方）fail-open——第一层
   * 不设防，第二层权限组照旧强制；scopes 已携带且声明了 MCP scope 面（任一 mcp. 前缀）
   * 却未覆盖本目标时 fail-closed（SCOPE_DENIED）——资源限定令牌被限定到别的服务/工具时
   * 显式拒绝，而非靠第二层文案含混放行。scope 放行不绕过权限组（第二层仍强制）。
   */
  private iamPermissionModule(): PolicyModule {
    return {
      id: 'iam-permission',
      decide: (req) => {
        const scopes = req.context.scopes as string[] | undefined
        if (!scopes || scopes.length === 0) {
          return { allow: true, reasons: ['令牌 scopes 未随调用携带（legacy 调用方），第一层不设防'], decisionId: newId('pd'), obligations: [] }
        }
        if (scopes.includes('*') || scopes.includes('mcp.invoke')) {
          return { allow: true, reasons: ['令牌 scopes 含 MCP 调用授权'], decisionId: newId('pd'), obligations: [] }
        }
        const serviceSlug = String(req.context.serviceSlug ?? '')
        const toolName = String(req.tool?.name ?? '')
        const serviceScope = `mcp.service:${serviceSlug}.invoke`
        const toolScope = `mcp.tool:${serviceSlug}:${toolName}.invoke`
        if (scopes.includes(serviceScope) || scopes.includes(toolScope)) {
          return { allow: true, reasons: [`令牌含资源限定 scope（${scopes.includes(serviceScope) ? serviceScope : toolScope}）`], decisionId: newId('pd'), obligations: [] }
        }
        // 声明了 MCP scope 面但未覆盖本目标：fail-closed（资源限定语义的正确拒绝面）
        const declaredMcp = scopes.filter((scope) => scope.startsWith('mcp.'))
        if (declaredMcp.length === 0) {
          return { allow: true, reasons: ['令牌未声明 MCP scope 面（legacy scopes），第一层不设防'], decisionId: newId('pd'), obligations: [] }
        }
        return this.denyDecision('SCOPE_DENIED', t('令牌 scopes 未授权调用本服务/工具：须含 mcp.invoke 或 mcp.service:{slug}.invoke / mcp.tool:{slug}:{tool}.invoke', { slug: serviceSlug, tool: toolName }))
      },
    }
  }

  /**
   * 第二层 mcp-permgroup（契约 §11：既有 authorize() 逻辑迁入，行为等价）：判定面
   * 与 authorize()/authorizedToolsFor() 完全同源（matchedPolicies 主体匹配 +
   * decideTool 单工具裁决），拒绝文案逐字保持既有领域文案；放行时产出 read-only
   * 义务（供审计展示，本波不新增执行语义）。
   */
  private mcpPermGroupModule(): PolicyModule {
    return {
      id: 'mcp-permgroup',
      decide: (req) => {
        const caller = req.context.caller as InvokeCaller
        const service = req.context.service as McpServiceRecord
        const toolName = String(req.tool?.name ?? '')
        // 工具存在性：与 authorize() 首查同文案（服务清单是裁决边界，未知工具不泄露）
        const tool = service.tools.find((item) => item.name === toolName)
        if (!tool) {
          return { allow: false, reasons: [t('服务 {service} 不存在工具 {tool}', { service: service.name, tool: toolName })], decisionId: newId('pd'), obligations: [] }
        }
        const grants = this.matchedPolicies(caller, service.id)
        if (grants.length === 0) {
          return { allow: false, reasons: [t('主体 {name} 未被任何 MCP 权限组授权访问 {service}', { name: caller.name, service: service.name })], decisionId: newId('pd'), obligations: [] }
        }
        const verdict = this.decideTool(grants, tool)
        if (!verdict.ok) {
          return { allow: false, reasons: [verdict.reason], decisionId: newId('pd'), obligations: [] }
        }
        return {
          allow: true,
          reasons: ['MCP 权限组授权命中'],
          decisionId: newId('pd'),
          // 只读约束转化为结构化义务（契约 §11 obligations；供审计展示）
          obligations: verdict.readOnly ? [{ type: 'read-only' }] : [],
        }
      },
    }
  }

  /**
   * 场景 ABAC 模块（契约 §11 scene-ABAC）：仅当调用上下文显式携带 sceneCode 且
   * ctx.iam.checkScene 可达时接入（deny 优先 fail-closed，与 iam 判定同源）；
   * 两者任一缺席即跳过（注释口径：独立单测宿主/legacy 调用方无场景语义，行为零漂移）。
   */
  private sceneModule(): PolicyModule {
    return {
      id: 'scene',
      decide: (req) => {
        const sceneCode = req.context.sceneCode as string | undefined
        const iam = this.ctx.iam as { checkScene?: (userId: string, sceneCode: string, action: string) => { decision: string; reason: string } } | undefined
        if (!sceneCode || typeof iam?.checkScene !== 'function') {
          return { allow: true, reasons: ['未指定场景码或 iam.checkScene 不可达，场景 ABAC 跳过'], decisionId: newId('pd'), obligations: [] }
        }
        const caller = req.context.caller as InvokeCaller
        const userId = caller.type === 'user' ? caller.id : caller.subjectUserId ?? caller.id
        const verdict = iam.checkScene(userId, sceneCode, String(req.action))
        if (verdict.decision === 'deny') {
          return this.denyDecision('SCENE_DENIED', verdict.reason)
        }
        return { allow: true, reasons: [`场景 ABAC ${verdict.decision}`], decisionId: newId('pd'), obligations: [] }
      },
    }
  }

  /** iam 租户解析窄端口（独立单测宿主无 iam 时缺省 undefined=视同同租户）。 */
  private tenantOfOrg(orgId: string): string | undefined {
    try {
      const iam = this.ctx.iam as { tenantOfOrg?: (orgId: string) => string } | undefined
      return typeof iam?.tenantOfOrg === 'function' ? iam.tenantOfOrg(orgId) : undefined
    } catch {
      return undefined
    }
  }

  /** 两侧租户是否已知且不同（任一未知视同同租户——缺省口径，行为等价关键）。 */
  private crossTenant(orgA: string, orgB: string): boolean {
    const tenantA = this.tenantOfOrg(orgA)
    const tenantB = this.tenantOfOrg(orgB)
    return tenantA !== undefined && tenantB !== undefined && tenantA !== tenantB
  }

  /** 资源归属实体（ownerEntity=app/agent 且有 id）的组织归属；resourceCore 缺席或解析失败返回 undefined（不判）。 */
  private ownerEntityOrg(service: McpServiceRecord): string | undefined {
    const entity = service.ownerEntity
    if (!entity || (entity.type !== 'app' && entity.type !== 'agent') || !entity.id) return undefined
    try {
      const core = (this.ctx as unknown as { resourceCore?: { get: (kind: string, id: string) => { orgId?: string } | undefined } }).resourceCore
      return core?.get(entity.type, entity.id)?.orgId
    } catch {
      return undefined
    }
  }

  /** 委托链真实用户的组织归属（human user 的 org 来自 iam；解析失败返回 undefined 不判）。 */
  private subjectUserOrg(userId: string): string | undefined {
    try {
      const iam = this.ctx.iam as { users?: () => { get: (id: string) => { orgId?: string } | undefined } } | undefined
      return iam?.users?.().get(userId)?.orgId
    } catch {
      return undefined
    }
  }

  /**
   * 有效审批引用核验（契约 §13）：context.approvalId 指向 plugin-audit 审批单，
   * status ∈ {approved, executed} 且未过期。ApprovalRecord 无过期字段——按
   * decidedAt + 24h 窗口计（注释口径，W4 验收按此对齐）；decidedAt 缺失（理论不可达：
   * approved/executed 必经 decide）视同已过期。审批查询经注入的 ctx.audit（plugin-mcp
   * 既有依赖，mcp.offline 审批执行器同源），缺席（独立单测宿主）= 无有效引用。
   */
  private validApprovalRef(approvalId: unknown): boolean {
    if (typeof approvalId !== 'string' || approvalId.trim() === '') return false
    try {
      const approval = this.ctx.audit?.approvals().get(approvalId)
      if (!approval) return false
      if (approval.status !== 'approved' && approval.status !== 'executed') return false
      if (!approval.decidedAt) return false
      // 无过期字段：decidedAt + 24h 有效窗（跨组织授权的时效口径）
      return Date.now() - Date.parse(approval.decidedAt) < 24 * 60 * 60_000
    } catch {
      return false
    }
  }

  /** 跨组织/租户拒绝的统一出口：领域码经 deny-code 义务随决策携带（供拒绝响应 data.code 映射）。 */
  private orgScopeDenied(reason: string): PolicyDecision {
    return { allow: false, reasons: [reason], decisionId: newId('pd'), obligations: [{ type: 'deny-code', code: 'ORG_SCOPE_DENIED' }] }
  }

  /** 通用 deny 决策构造：领域码（可选）经 deny-code 义务携带，reasons 即既有领域文案。 */
  private denyDecision(code: McpDenyCode | undefined, reason: string): PolicyDecision {
    return { allow: false, reasons: [reason], decisionId: newId('pd'), obligations: code ? [{ type: 'deny-code', code }] : [] }
  }

  /**
   * org-constraint 模块（契约 §13 组织与租户硬约束）：caller.org / service.org /
   * ownerEntity 资源 org 一致性。缺省口径（行为等价关键，契约 §13 落地裁决）：
   * orgId 缺失或两侧同 org 一律放行（存量演示/seed 数据全部在默认组织内，'org'
   * 严格模式不得打破既有断言）——硬拦面收敛在「跨租户」（tenantOfOrg 口径，真隔离
   * 边界）与 visibility 显式声明面：
   *   - 'org'（缺省）：跨租户 → ORG_SCOPE_DENIED；同租户跨组织须显式授权事实
   *     （'*' 平台主体，或权限组命中该服务——即「跨组织必须显式授权」的同租户表达）；
   *   - 'tenant'：同租户放行（跨组织同租户亦放行），跨租户 ORG_SCOPE_DENIED；
   *   - 'cross-org'：必须携带有效审批引用（validApprovalRef），否则 ORG_SCOPE_DENIED。
   * 委托链 subjectUserId 的 org 与目标服务 org 校验同理（同款三态复核）。
   */
  private orgConstraintModule(): PolicyModule {
    return {
      id: 'org-constraint',
      decide: (req) => {
        const caller = req.context.caller as InvokeCaller
        const service = req.context.service as McpServiceRecord
        const resourceOrg = service.orgId || this.ownerEntityOrg(service) || ''
        const visibility = service.visibility ?? 'org'
        const scopes = (req.context.scopes as string[] | undefined) ?? []

        const checkPair = (callerOrg: string | undefined, label: string): PolicyDecision | undefined => {
          // orgId 缺失（任一侧）→ 放行：缺省同组织口径，存量数据零漂移
          if (!callerOrg || !resourceOrg) return undefined
          if (callerOrg === resourceOrg) return undefined
          if (visibility === 'org') {
            // 同租户 + 显式授权事实（'*' 平台主体 / 权限组命中该服务）→ 显式授权放行；
            // 否则硬拦（无权限组命中时 mcp-permgroup 亦拒，主因仍为权限组文案——模块序在前）
            if (!this.crossTenant(callerOrg, resourceOrg)) {
              const explicit = scopes.includes('*') || this.matchedPolicies(caller, service.id).length > 0
              if (explicit) return undefined
              return this.orgScopeDenied(t('跨组织调用 {label} 未获显式授权（ORG_SCOPE_DENIED）', { label }))
            }
            return this.orgScopeDenied(t('{label} 与目标服务分属不同租户，跨组织调用被拒绝（ORG_SCOPE_DENIED）', { label }))
          }
          if (visibility === 'tenant') {
            if (this.crossTenant(callerOrg, resourceOrg)) {
              return this.orgScopeDenied(t('{label} 与目标服务分属不同租户（visibility=tenant），跨租户调用被拒绝（ORG_SCOPE_DENIED）', { label }))
            }
            return undefined
          }
          // cross-org：必须带有效审批引用
          if (!this.validApprovalRef(req.context.approvalId)) {
            return this.orgScopeDenied(t('跨组织服务（visibility=cross-org）调用必须携带有效审批引用（approved/executed 且 24h 窗内）'))
          }
          return undefined
        }

        const callerVerdict = checkPair(caller.orgId, '调用者组织')
        if (callerVerdict) return callerVerdict
        // 委托链真实用户 org 同理（subjectUserId 已知才复核）
        if (caller.subjectUserId) {
          const subjectVerdict = checkPair(this.subjectUserOrg(caller.subjectUserId), '委托链用户组织')
          if (subjectVerdict) return subjectVerdict
        }
        return { allow: true, reasons: [`组织约束通过（visibility=${visibility}）`], decisionId: newId('pd'), obligations: [] }
      },
    }
  }

  /**
   * risk-gate 模块（契约 §11：unknown 风险写语境拒绝，现语义迁入）：与既有拒绝路径
   * 逐字等价——legacy 链上 unknown 工具必须处于只读语境（权限组 readOnly 约束）才可
   * 放行，非只读语境 RISK_UNREGISTERED 拒绝；受管链在工作策略端口已裁决，跳过。
   * 只读语境复用 matchedPolicies/decideTool 判定面（与 authorize 的 auth.readOnly 同源）。
   */
  private riskGateModule(): PolicyModule {
    return {
      id: 'risk-gate',
      decide: (req) => {
        const gateMode = req.context.gateMode as string | undefined
        const gateRisk = req.context.gateRisk as string | undefined
        if (gateMode === 'managed') {
          return { allow: true, reasons: ['受管链风险已在工作策略端口裁决'], decisionId: newId('pd'), obligations: [] }
        }
        if (gateRisk !== 'unknown') {
          return { allow: true, reasons: [`工具风险已登记生效（${gateRisk ?? 'read'}）`], decisionId: newId('pd'), obligations: [] }
        }
        const caller = req.context.caller as InvokeCaller
        const service = req.context.service as McpServiceRecord
        const toolName = String(req.tool?.name ?? '')
        const tool = service.tools.find((item) => item.name === toolName)
        const grants = this.matchedPolicies(caller, service.id)
        const verdict = tool && grants.length > 0 ? this.decideTool(grants, tool) : undefined
        if (!verdict || !verdict.ok) {
          // 权限组层未放行：风险闸不叠加评估（与既有闸门序逐字一致——authorize 拒绝时
          // 不再评估 unknown 风险，主因/领域码保持权限组层的既有口径，零漂移）
          return { allow: true, reasons: ['权限组层未放行，风险闸跳过'], decisionId: newId('pd'), obligations: [] }
        }
        if (!verdict.readOnly) {
          return this.denyDecision('RISK_UNREGISTERED', t('工具 {tool} 风险未登记生效：{reason}', { tool: toolName, reason: WORK_DENY_CODE_LABELS.RISK_UNREGISTERED }))
        }
        return { allow: true, reasons: ['unknown 工具处于只读语境（权限组 readOnly 约束）'], decisionId: newId('pd'), obligations: [{ type: 'read-only' }] }
      },
    }
  }

  /** 首个 deny 模块 → 领域拒绝码（deny 模块经 deny-code 义务携带；义务按模块序聚合，首个即主因模块）。 */
  private static denyCodeOf(decision: PolicyDecision): McpDenyCode | undefined {
    const obligation = decision.obligations.find((item) => item.type === 'deny-code') as { code?: McpDenyCode } | undefined
    return obligation?.code
  }

  /**
   * 主裁决（W3-T5）：构建 PolicyRequest 并经 PDP 聚合裁决。
   * 事实一律服务端取证（caller/scopes/服务记录/闸门模式），context 仅作事实携带。
   */
  private async decideViaPdp(input: {
    caller: InvokeCaller
    service: McpServiceRecord
    toolName: string
    gateRisk: 'read' | 'write' | 'admin' | 'unknown'
    gateMode: string
    traceId: string
  }): Promise<PolicyDecision> {
    const { caller, service, toolName, gateRisk, gateMode, traceId } = input
    const request: PolicyRequest = {
      subject: this.subjectOf(caller),
      action: `mcp.invoke:${service.slug}:${toolName}`,
      resource: { type: 'mcp_service', id: service.id, orgId: service.orgId, dataClass: service.dataClass, slug: service.slug },
      tool: { name: toolName },
      context: {
        traceId,
        serviceSlug: service.slug,
        service,
        caller,
        scopes: caller.scopes,
        gateMode,
        gateRisk,
        ...(caller.approvalId !== undefined ? { approvalId: caller.approvalId } : {}),
      },
    }
    return await this.pdp().decide(request)
  }

  // -- 调用网关 -----------------------------------------------------------

  async invoke(caller: InvokeCaller, serviceId: string, toolName: string, args: Record<string, unknown> = {}, workRef?: WorkRefIndex): Promise<InvokeResult> {
    const service = this.services().get(serviceId)
    if (!service) throw new Error(t('MCP 服务不存在：{id}', { id: serviceId }))
    const started = Date.now()
    // 全链 trace（W3-T5 契约 §14）：入口无 trace 即生成（调用方可经 InvokeCaller.traceId 透传，
    // REST/数据面从 X-Trace-Id / mcp-session-id 头取）；参数摘要哈希与 workforce 闸门共用同源
    const traceId = caller.traceId ?? newTraceId()
    const argsHash = sha256Hex(JSON.stringify(args ?? {}))

    const fail = (status: McpCallRecord['status'], error: string, work?: McpCallWorkRef, decision?: PolicyDecision): InvokeResult => {
      this.recordCall(service, toolName, caller, {
        ok: false, status, latencyMs: Date.now() - started, version: service.currentVersion, error,
        traceId, argsHash,
        ...(gateRiskLevel !== undefined ? { riskLevel: gateRiskLevel } : {}),
        ...(decision ? { decisionId: decision.decisionId, decisionReasons: decision.reasons } : {}),
      }, work)
      return {
        ok: false, status, latencyMs: Date.now() - started, version: service.currentVersion, error,
        traceId,
        ...(decision ? { decisionId: decision.decisionId, decisionReasons: decision.reasons } : {}),
      }
    }
    // 闸门风险随调用记录/事件透出（先于 gateRisk 声明，调用时点恒已赋值）
    let gateRiskLevel: 'read' | 'write' | 'admin' | 'unknown' | undefined

    // -- 工作级授权闸门（施工蓝本 §9.5 / 附录 D.5：受管判定只按可信 caller 反查） ----------------
    // 插入点在真实传输（realTransport）之前、原有授权链之前；端口未就绪或非受管 caller →
    // legacy，原有授权链一步不少（两层授权取交集）。workRef 仅作索引透传（§10.4），
    // 授权事实（permit/租约/能力清单/参数范围）一律由 workforce 侧服务端回查。
    const callerRef = workCallerRefFromInvokeCaller(caller)
    const toolSpec = service.tools.find((item) => item.name === toolName)
    // W1/V11 根治：闸门风险一律取「可信风险登记生效值」（effectiveRisk）；
    // 无生效登记时——工具清单显式申报了具体风险（read/write/admin）→ 按申报值（存量显式声明面不回退）；
    // 未申报/申报 unknown → 'unknown'（不再隐式映射 read）。'unknown' 的裁决：
    //   受管链在工作策略端口（清单句柄仅授 read → 只读语境放行；句柄授写/admin → RISK_UNREGISTERED 拒绝）；
    //   legacy 链在本网关只读语境（见下方 PDP risk-gate 模块）。
    const registeredRisk = this.riskRegistryRef?.effectiveRisk(serviceId, toolName)
    const gateRisk: 'read' | 'write' | 'admin' | 'unknown' = registeredRisk
      ?? (toolSpec?.riskLevel && toolSpec.riskLevel !== 'unknown' ? toolSpec.riskLevel : 'unknown')
    gateRiskLevel = gateRisk
    const gate = await gateManagedWork(workforcePolicyOf(this.ctx), callerRef, {
      facts: { kind: 'mcp', registryId: serviceId, action: toolName, risk: gateRisk },
      ...(workRef ? { ref: workRef } : {}),
      // 参数摘要哈希（便宜可算）：用于 workforce 步骤冲突判定与审计（与调用记录 argsHash 同源）
      argsHash,
    })
    if (gate.mode === 'denied') {
      const message = t('数字员工调用被拒绝：{detail}', { detail: `${WORK_DENY_CODE_LABELS[gate.code]}${gate.message ? `（${gate.message}）` : ''}` })
      const latencyMs = Date.now() - started
      // 拒绝同样落调用记录（V07：拒绝是事实，按原 status='denied' 口径留存并附领域拒绝码；
      // 工作上下文仅在放行时由服务端核验产生，拒绝路径无可关联的 work 事实）
      this.recordCall(service, toolName, caller, {
        ok: false, status: 'denied', latencyMs, version: service.currentVersion, error: message, code: gate.code,
        traceId, argsHash, riskLevel: gateRisk,
      })
      return { ok: false, status: 'denied', latencyMs, version: service.currentVersion, error: message, code: gate.code }
    }
    // managed：把服务端核验后的工作上下文带入本次调用的记录关联（D11）
    const work: WorkExecutionContext | undefined = gate.mode === 'managed' ? gate.work : undefined
    const workRefForRecord: McpCallWorkRef | undefined = work
      ? {
          permitId: work.permitId,
          ...(work.runId ? { runId: work.runId } : {}),
          employeeId: work.employeeId,
        }
      : undefined

    if (service.status === 'offline') return fail('denied', t('服务已下线'), workRefForRecord)
    if (service.status === 'draft' || service.status === 'verifying') return fail('denied', t('服务尚未发布'), workRefForRecord)
    if (service.health.breakerOpen) return fail('breaker_open', t('熔断器开启：服务连续失败，暂拒绝调用'), workRefForRecord)

    // 限流：每服务每分钟令牌桶
    const key = `${serviceId}:${caller.type}:${caller.id}`
    const nowMs = Date.now()
    const bucket = (this.rateBuckets.get(key) ?? []).filter((t) => nowMs - t < 60_000)
    if (bucket.length >= service.rateLimitPerMin) {
      this.rateBuckets.set(key, bucket)
      return fail('rate_limited', t('触发限流：{limit} 次/分钟', { limit: service.rateLimitPerMin }), workRefForRecord)
    }
    bucket.push(nowMs)
    this.rateBuckets.set(key, bucket)

    // 资源级授权 + 组织硬约束 + 风险闸（W3-T5 契约 §11：主裁决迁 PDP）——
    // 模块序：iam-permission（资源限定 scope 第一层）→ mcp-permgroup（既有 authorize 判定面，
    // 文案/领域码逐字等价）→ scene（可选场景 ABAC）→ org-constraint（§13 三态）→
    // risk-gate（unknown 写语境拒绝）。deny 优先、reasons 聚合：首个 deny 模块的理由即
    // 主因（error 文案与既有完全一致），领域码取首个 deny 模块的 deny-code 义务。
    const decision = await this.decideViaPdp({
      caller, service, toolName, gateRisk,
      gateMode: gate.mode,
      traceId,
    })
    if (!decision.allow) {
      const reason = decision.reasons[0] ?? t('调用被策略拒绝（PDP）')
      const denyCode = McpService.denyCodeOf(decision)
      const latencyMs = Date.now() - started
      // 拒绝同样落调用记录（V07 口径：拒绝是事实，按 status='denied' 留存并附领域拒绝码与决策表达）
      this.recordCall(service, toolName, caller, {
        ok: false, status: 'denied', latencyMs, version: service.currentVersion, error: reason,
        ...(denyCode !== undefined ? { code: denyCode } : {}),
        traceId, argsHash, riskLevel: gateRisk,
        decisionId: decision.decisionId, decisionReasons: decision.reasons,
      }, workRefForRecord)
      return {
        ok: false, status: 'denied', latencyMs, version: service.currentVersion, error: reason,
        ...(denyCode !== undefined ? { code: denyCode } : {}),
        traceId, decisionId: decision.decisionId, decisionReasons: decision.reasons,
      }
    }
    // 放行：只读语境事实保留在 decision.obligations（{type:'read-only'}，供审计展示与后续语义消费）

    // 灰度路由：未命中灰度比例的调用走稳定版本
    const hash = Number.parseInt(sha256Hex(`${caller.id}:${serviceId}`).slice(0, 8), 16) % 100
    const version = service.grayPercent < 100 && hash >= service.grayPercent
      ? (service.versions.find((item) => item.status === 'previous')?.version ?? service.currentVersion)
      : service.currentVersion

    // 执行传输层：real = 真实 HTTP JSON-RPC；demo = 确定性模拟（显式降级，恒成功、结果可复现）。
    // 存量演示数据（无 exec 字段）按 demo 兜底——新建服务缺省一律 real。
    let tokens = 0
    let result: unknown
    let upstreamStatus: number | undefined
    if (service.exec !== 'real') {
      await sleep(simulateLatency(service, toolName))
      tokens = 200 + (Number.parseInt(sha256Hex(JSON.stringify(args)).slice(0, 6), 16) % 1800)
      result = mockToolResult(service, toolName, args)
    } else {
      // W3-T5 §14：下游转发带 traceparent 头（W3C Trace Context，version 00）
      const transportResult = await this.realTransport(service, toolName, args, traceId)
      if (!transportResult.ok) {
        // 业务失败计入熔断（评审修复：熔断不能只依赖 30s 探活，真实调用失败同样累计）
        this.noteBusinessFailure(service, transportResult.error ?? t('MCP 服务调用失败'))
        return fail('error', transportResult.error ?? t('MCP 服务调用失败'), workRefForRecord)
      }
      this.noteBusinessSuccess(service)
      result = transportResult.result
      tokens = transportResult.tokens
      upstreamStatus = transportResult.upstreamStatus
    }
    const latencyMs = Date.now() - started
    this.recordCall(service, toolName, caller, {
      ok: true, status: 'ok', latencyMs, version, tokens,
      traceId, argsHash, riskLevel: gateRisk,
      decisionId: decision.decisionId, decisionReasons: decision.reasons,
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    }, workRefForRecord)
    return { ok: true, status: 'ok', latencyMs, version, result, traceId, decisionId: decision.decisionId, decisionReasons: decision.reasons }
  }

  /**
   * 组装外呼请求头（W1-T2 §6 注入点，realTransport/探活/工具发现三处统一走它）：
   * 存量 service.headers 照旧透传；SecretBroker 登记了凭证的按 headerName 注入/覆盖
   * （同名时凭证胜出——明文迁移完成后 service.headers 已无敏感键，覆盖语义仅兼容过渡态）。
   * Broker 对 vault:/external: 等不支持形态抛 CREDENTIAL_BROKER_UNSUPPORTED，
   * 由调用链既有 try/catch 呈现为调用/探活失败（fail-closed，不静默裸奔）。
   */
  private async resolveCallHeaders(service: McpServiceRecord, options: { dedupKey?: string } = {}): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...(service.headers ?? {}) }
    const broker = this.secretBrokerRef
    if (broker) {
      // dedupKey（W3-T5 §14 探活审计聚合）：长驻服务探活周期性 resolve 的访问留痕按窗口去重
      // （同 key 10 分钟一次，窗口内计数随下一事件附带）；调用/工具发现等真实访问不留 key、照旧逐次留痕
      const entries = options.dedupKey ? broker.resolve(service.id, { dedupKey: options.dedupKey }) : broker.resolve(service.id)
      if (entries) {
        for (const entry of entries) headers[entry.headerName] = entry.secret
      }
    }
    return headers
  }

  /**
   * 真实执行传输层：MCP streamable HTTP 的 JSON-RPC tools/call。
   * 有状态服务先经 ensureSession 取会话头；会话失效（服务端报未初始化类错误）自动重握手一次。
   * 真实延迟/错误全量计量；token 消耗从响应 usage 字段读取（缺省 0，不伪造）。
   */
  private async realTransport(service: McpServiceRecord, toolName: string, args: Record<string, unknown>, traceId?: string): Promise<{ ok: true; result: unknown; tokens: number; upstreamStatus?: number } | { ok: false; error: string }> {
    // W1-T2 §6 注入点：外呼头统一经 SecretBroker 组装（存量非敏感 headers 照旧、凭证覆盖同名键）
    const headers = await this.resolveCallHeaders(service)
    // W3-T5 §14：下游 HTTP 转发带 traceparent 头（traceId 缺省不产头——探活/工具发现等旁路面无需）
    if (traceId) headers['traceparent'] = formatTraceparent(traceId)
    const call = (sessionId?: string) => this.mcpRequest(service.endpoint, headers, {
      jsonrpc: '2.0',
      id: `dsh-${Date.now()}`,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }, REAL_TRANSPORT_TIMEOUT_MS, sessionId)
    try {
      let sessionId: string | undefined
      try {
        sessionId = await this.ensureSession(service.endpoint, headers)
      } catch { /* 握手失败不阻断：部分服务允许无会话直接调用 */ }
      let { payload, status } = await call(sessionId)
      if (payload?.error && sessionId && /session|initialized/i.test(String(payload.error.message ?? ''))) {
        this.mcpSessions.delete(service.endpoint)
        sessionId = await this.ensureSession(service.endpoint, headers).catch(() => undefined)
        ;({ payload, status } = await call(sessionId))
      }
      if (payload?.error) {
        return { ok: false, error: t('MCP 服务返回错误：{reason}', { reason: payload.error.message ?? JSON.stringify(payload.error).slice(0, 200) }) }
      }
      const result = payload?.result
      if (result?.isError) {
        return { ok: false, error: t('MCP 工具执行返回错误（isError=true）') }
      }
      return { ok: true, result: result?.content ?? result ?? null, tokens: result?.usage?.totalTokens ?? 0, upstreamStatus: status }
    } catch (error) {
      const message = error instanceof Error ? (error.name === 'AbortError' ? t('MCP 服务调用超时（{timeout}ms）', { timeout: REAL_TRANSPORT_TIMEOUT_MS }) : error.message) : String(error)
      return { ok: false, error: message }
    }
  }

  private recordCall(service: McpServiceRecord, tool: string, caller: InvokeCaller, outcome: {
    ok: boolean
    status: McpCallRecord['status']
    latencyMs: number
    version: string
    error?: string
    tokens?: number
    /** 工作级授权拒绝的领域拒绝码（additive，审计区分拒绝层级）。 */
    code?: WorkDenyCode
    // -- 全链 trace 与决策表达（W3-T5，契约 §11/§14，additive） --
    traceId?: string
    argsHash?: string
    upstreamStatus?: number
    decisionId?: string
    decisionReasons?: string[]
    /** 闸门风险值（read/write/admin/unknown；mcp.invoked payload v2 riskLevel 源）。 */
    riskLevel?: 'read' | 'write' | 'admin' | 'unknown'
  }, work?: McpCallWorkRef): void {
    const record: McpCallRecord = {
      id: newId('call'),
      at: now(),
      serviceId: service.id,
      serviceName: service.name,
      tool,
      callerType: caller.type,
      callerId: caller.id,
      callerName: caller.name,
      ...(caller.onBehalfOf !== undefined ? { onBehalfOf: caller.onBehalfOf } : {}),
      ...(caller.actChain !== undefined ? { actChain: caller.actChain } : {}),
      version: outcome.version,
      ok: outcome.ok,
      status: outcome.status,
      ...(service.finalReview ? { watermark: { finalReview: true as const, at: service.finalReview.at } } : {}),
      latencyMs: outcome.latencyMs,
      tokens: outcome.tokens ?? 0,
      exec: service.exec,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(work ? { work } : {}),
      ...(outcome.traceId !== undefined ? { traceId: outcome.traceId } : {}),
      ...(outcome.argsHash !== undefined ? { argsHash: outcome.argsHash } : {}),
      ...(outcome.upstreamStatus !== undefined ? { upstreamStatus: outcome.upstreamStatus } : {}),
      ...(outcome.decisionId !== undefined ? { decisionId: outcome.decisionId } : {}),
      ...(outcome.decisionReasons !== undefined ? { decisionReasons: outcome.decisionReasons } : {}),
    }
    this.calls().insert(record)
    // 调用环上限 5000 条，防膨胀
    const all = this.calls().all()
    if (all.length > 5000) {
      for (const item of all.slice(0, all.length - 5000)) this.calls().remove(item.id)
    }
    // mcp.invoked payload v2（契约 §14，additive）：traceId/argsHash/decisionId/decisionReasons/
    // delegationChain（unified actChain 投影）/riskLevel/dataClass/upstreamStatus——审计订阅
    // 与既有消费者（Agent 指标归集等）对未知字段零感知
    this.ctx.platformBus.emit(PlatformEvents.McpInvoked, {
      serviceId: service.id, name: service.name, tool,
      callerType: caller.type, callerId: caller.id, callerName: caller.name,
      ok: outcome.ok, latencyMs: outcome.latencyMs, tokens: record.tokens,
      // 状态分档（W4 安全审计 P0-4，additive）：审计侧据此区分「策略拒绝」与「上游故障」
      status: record.status,
      actChain: caller.actChain,
      ...(record.traceId !== undefined ? { traceId: record.traceId } : {}),
      ...(record.argsHash !== undefined ? { argsHash: record.argsHash } : {}),
      ...(record.decisionId !== undefined ? { decisionId: record.decisionId } : {}),
      ...(record.decisionReasons !== undefined ? { decisionReasons: record.decisionReasons } : {}),
      ...(caller.actChain?.length ? { delegationChain: caller.actChain } : {}),
      ...(outcome.riskLevel !== undefined ? { riskLevel: outcome.riskLevel } : {}),
      dataClass: service.dataClass,
      ...(record.upstreamStatus !== undefined ? { upstreamStatus: record.upstreamStatus } : {}),
    })
    // 计量管道（v1.2 第 2 步）：real 传输调用进入 usage 事件（demo 演示流量不计费不计 SLO）
    if (service.exec === 'real') {
      try {
        this.ctx.usage.record({
          org: service.orgId,
          subject: `${caller.type}:${caller.id}`,
          principal: `org:${service.orgId}`,
          resource: `mcp:${service.slug}`,
          meters: [
            { key: 'calls', value: 1, unit: 'call' },
            ...(record.tokens > 0 ? [{ key: 'tokens', value: record.tokens, unit: 'token' }] : []),
          ],
          idempotency_key: `mcp:${record.id}`,
          // 全链 trace（W3-T5 §14）：trace_id 从「仅受管调用回填 invocationId」扩展为全部 real
          // 调用回填——受管调用仍优先 invocationId（workforce 账本可穿透），其余用本次 traceId
          trace_id: work?.invocationId ?? record.traceId ?? '',
        })
      } catch (error) {
        this.ctx.logger('mcp').warn('usage 计量登记失败', error)
      }
    }
  }

  // -- 监控指标 -----------------------------------------------------------

  metricsOverview(): {
    totalCalls: number
    successRate: number
    p95Latency: number
    tokens: number
    onlineServices: number
    unhealthyServices: number
  } {
    const calls = this.calls().all()
    const okCalls = calls.filter((call) => call.ok)
    const latencies = calls.map((call) => call.latencyMs).sort((a, b) => a - b)
    const services = this.services().all()
    return {
      totalCalls: calls.length,
      successRate: calls.length === 0 ? 1 : round3(okCalls.length / calls.length),
      p95Latency: latencies.length === 0 ? 0 : latencies[Math.floor(latencies.length * 0.95)]!,
      tokens: calls.reduce((sum, call) => sum + call.tokens, 0),
      onlineServices: services.filter((item) => ['online', 'gray'].includes(item.status)).length,
      unhealthyServices: services.filter((item) => item.status === 'unhealthy').length,
    }
  }

  serviceMetrics(serviceId: string): {
    calls: number
    okCalls: number
    successRate: number
    p95Latency: number
    tokens: number
    callers: Array<{ callerName: string; callerType: string; calls: number }>
    toolStats: Array<{ tool: string; calls: number; ok: number; avgLatency: number }>
    series: Array<{ minute: string; calls: number; errors: number; avgLatency: number }>
  } {
    const calls = this.calls().find((call) => call.serviceId === serviceId)
    const okCalls = calls.filter((call) => call.ok)
    const latencies = calls.map((call) => call.latencyMs).sort((a, b) => a - b)
    const byCaller = new Map<string, { callerName: string; callerType: string; calls: number }>()
    for (const call of calls) {
      const key = `${call.callerType}:${call.callerId}`
      const bucket = byCaller.get(key) ?? { callerName: call.callerName, callerType: call.callerType, calls: 0 }
      bucket.calls++
      byCaller.set(key, bucket)
    }
    const byTool = new Map<string, { tool: string; calls: number; ok: number; totalLatency: number }>()
    for (const call of calls) {
      const bucket = byTool.get(call.tool) ?? { tool: call.tool, calls: 0, ok: 0, totalLatency: 0 }
      bucket.calls++
      if (call.ok) bucket.ok++
      bucket.totalLatency += call.latencyMs
      byTool.set(call.tool, bucket)
    }
    // 近 60 分钟分钟级序列
    const series = new Map<string, { calls: number; errors: number; totalLatency: number }>()
    const nowMs = Date.now()
    for (let i = 59; i >= 0; i--) {
      const minute = new Date(nowMs - i * 60_000).toISOString().slice(0, 16)
      series.set(minute, { calls: 0, errors: 0, totalLatency: 0 })
    }
    for (const call of calls) {
      const minute = call.at.slice(0, 16)
      const bucket = series.get(minute)
      if (!bucket) continue
      bucket.calls++
      if (!call.ok) bucket.errors++
      bucket.totalLatency += call.latencyMs
    }
    return {
      calls: calls.length,
      okCalls: okCalls.length,
      successRate: calls.length === 0 ? 1 : round3(okCalls.length / calls.length),
      p95Latency: latencies.length === 0 ? 0 : latencies[Math.floor(latencies.length * 0.95)]!,
      tokens: calls.reduce((sum, call) => sum + call.tokens, 0),
      callers: [...byCaller.values()].sort((a, b) => b.calls - a.calls),
      toolStats: [...byTool.values()].map((bucket) => ({
        tool: bucket.tool, calls: bucket.calls, ok: bucket.ok,
        avgLatency: bucket.calls === 0 ? 0 : Math.round(bucket.totalLatency / bucket.calls),
      })).sort((a, b) => b.calls - a.calls),
      series: [...series.entries()].map(([minute, bucket]) => ({
        minute, calls: bucket.calls, errors: bucket.errors,
        avgLatency: bucket.calls === 0 ? 0 : Math.round(bucket.totalLatency / bucket.calls),
      })),
    }
  }

  callLog(filter: { serviceId?: string; callerId?: string; status?: string; limit?: number }): { total: number; items: McpCallRecord[] } {
    const all = this.calls().find((call) => {
      if (filter.serviceId && call.serviceId !== filter.serviceId) return false
      if (filter.callerId && call.callerId !== filter.callerId) return false
      if (filter.status && call.status !== filter.status) return false
      return true
    }).sort((a, b) => b.at.localeCompare(a.at))
    return { total: all.length, items: all.slice(0, filter.limit ?? 100) }
  }

  private requireService(id: string): McpServiceRecord {
    const service = this.services().get(id)
    if (!service) throw new Error(t('MCP 服务不存在：{id}', { id }))
    return service
  }
}

// ---------------------------------------------------------------------------
// 传输层辅助（real = 真实 HTTP；demo = 确定性伪随机，仅演示）
// ---------------------------------------------------------------------------

/** real 调用超时（ms）。 */
const REAL_TRANSPORT_TIMEOUT_MS = 10_000
/** real 探活超时（ms）。 */
const REAL_PROBE_TIMEOUT_MS = 5_000
/** 远端 MCP 会话缓存时长（ms）：到期或服务端报会话失效时重新握手。 */
const MCP_SESSION_TTL_MS = 5 * 60_000

function probeLatency(service: McpServiceRecord): number {
  // demo 探活确定性健康：失败/降级路径由 real 探活（真实 HTTP）呈现，不伪造波动。
  return 40 + (Number.parseInt(sha256Hex(service.id).slice(0, 4), 16) % 360)
}

function simulateLatency(service: McpServiceRecord, tool: string): number {
  return 30 + (Number.parseInt(sha256Hex(`${service.slug}:${tool}`).slice(0, 4), 16) % 220)
}

function mockToolResult(service: McpServiceRecord, tool: string, args: Record<string, unknown>): unknown {
  const digest = sha256Hex(`${service.slug}:${tool}:${JSON.stringify(args)}`).slice(0, 8)
  if (/search|query|find|list/i.test(tool)) {
    return {
      matched: Number.parseInt(digest.slice(0, 4), 16) % 20 + 1,
      items: Array.from({ length: 3 }, (_, index) => ({
        id: `${digest}-${index}`,
        title: t('{tool} 结果 #{n}', { tool, n: index + 1 }),
        score: round3(0.75 + ((Number.parseInt(digest.slice(index, index + 2), 16) % 25) / 100)),
      })),
    }
  }
  if (/write|create|update|send|exec/i.test(tool)) {
    return { acknowledged: true, affected: Number.parseInt(digest.slice(0, 2), 16) % 5 + 1, receipt: `rcpt-${digest}` }
  }
  return { status: 'success', tool, digest, echo: args }
}

function defaultToolsFor(slug: string): McpToolSpec[] {
  return [
    { name: `${slug}_search`, description: `检索 ${slug} 数据`, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, riskLevel: 'read' },
    { name: `${slug}_fetch`, description: `按 ID 获取 ${slug} 详情`, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, riskLevel: 'read' },
    { name: `${slug}_write`, description: `写入 ${slug} 数据`, inputSchema: { type: 'object', properties: { payload: { type: 'object' } } }, riskLevel: 'write' },
  ]
}

function bumpVersion(version: string): string {
  const parts = version.split('.').map(Number)
  parts[2] = (parts[2] ?? 0) + 1
  return parts.join('.')
}

function now(): string {
  return new Date().toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

// ---------------------------------------------------------------------------
// 工作级授权辅助（施工蓝本 §10.2 / D.5：网关只消费窄端口，不反向依赖 workforce）
// ---------------------------------------------------------------------------

/**
 * 窄端口运行时读取：platform-core 装配时注册 WorkforcePolicyRegistry（provide='workforcePolicy'）。
 * Context 类型增补由 workforce 侧统一持有；这里防御式读取——服务未装配（独立单测宿主）时
 * 返回 undefined，gateManagedWork 按端口未就绪走 legacy，保持现状。
 */
function workforcePolicyOf(ctx: Context): WorkforcePolicyRegistry | undefined {
  try {
    return (ctx as unknown as { workforcePolicy?: WorkforcePolicyRegistry }).workforcePolicy ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 已验证调用者 → WorkCallerRef（身份一律来自入口令牌解析结果，禁止来自请求参数）。
 * user → human（principalId=userId）；agent/app → machine（refType/refId 供 workforce
 * 反查数字员工技术绑定，对齐 authn principals 的 refType 语义）。
 */
function workCallerRefFromInvokeCaller(caller: InvokeCaller): WorkCallerRef {
  if (caller.type === 'user') {
    return { kind: 'human', principalId: caller.id, userId: caller.id, name: caller.name }
  }
  return {
    kind: 'machine',
    principalId: caller.id,
    refType: caller.type === 'agent' ? 'agent' : 'app',
    refId: caller.id,
    name: caller.name,
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpRegistry: McpService
    /** W 批次 W1（V11 根治）：MCP 工具可信风险登记（登记→两级审批→生效→重审→退场）。 */
    mcpToolRisks: McpToolRiskRegistry
    /** W1-T2（MCP 治理 §6）：下游凭证 Secret Broker（密钥文件 0600，业务集合零密钥）。 */
    secretBroker: SecretBroker
  }
}

// W1-T2（契约 §6）：SecretBroker 与敏感头口径助手对外导出（CLI/宿主/单测共用）
export {
  SecretBroker,
  SENSITIVE_HEADER_RE,
  sensitiveHeaderKeys,
  plainSensitiveHeaderViolation,
} from './secret-broker.ts'
export type {
  McpCredentialEntry,
  McpCredentialFile,
  McpCredentialDescription,
} from './secret-broker.ts'

export const name = 'mcp'
export const inject = ['opsStorage', 'platformBus', 'iam', 'audit', 'usage', 'workforcePolicy']

export function apply(ctx: Context) {
  const registry = new McpService(ctx)
  // W 批次 W1（V11 根治）：工具风险登记服务与网关同批装配并直连（invoke 闸门与 console REST 面
  // 经 mcpRegistry.riskRegistry() 取用；ctx.mcpToolRisks 键仍由 declare module 供宿主/根上下文使用）
  registry.attachRiskRegistry(new McpToolRiskRegistry(ctx))
  // W1-T2（契约 §6）：Secret Broker 与网关同批装配并直连（外呼注入点与 REST 凭证面共用同一实例；
  // ctx.secretBroker 键由 declare module 供宿主/根上下文使用）
  registry.attachSecretBroker(new SecretBroker(ctx))
  ctx.plugin(mcpTools)
  // L4 审批执行器：mcp.offline 审批通过后自动执行下线
  ctx.effect(() => ctx.audit.registerExecutor('mcp.offline', async (payload) => {
    const serviceId = String(payload.serviceId)
    const reason = String(payload.reason ?? t('审批通过下线'))
    return registry.offlineService(serviceId, 'approval-center', reason)
  }))
  // 契约 §5：存量服务治理字段幂等迁移（缺则补默认值；失败不阻断启动，下次启动重试）
  try {
    registry.ensureGovernanceMigration()
  } catch (error) {
    console.error('[mcp] 治理字段迁移失败（不阻断启动，下次启动重试）', error)
  }
}
