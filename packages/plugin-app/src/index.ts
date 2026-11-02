/**
 * @dsh-ops/plugin-app —— AI 应用本体管理（方案 §六）。
 *
 * 复用 resource-core 底座与生命周期，差异部分以扩展 schema 实现：
 * 应用形态/访问入口/发布渠道/Agent 编排拓扑（应用 → Agent → MCP/Skill 一图穿透）。
 * 应用层指标：DAU/MAU、会话深度、留存；成本链路：应用 → Agent → MCP/模型 穿透归集。
 *
 * W2-T4（MCP 治理契约 §10）：应用能力绑定——App ↔ MCP 服务挂载（app:capabilities）、
 * 上线能力门禁（CAPABILITY_GATE_FAILED）、下架/删除生命周期联动、resource-core
 * capability 依赖边（app→mcp），使拓扑 app→agent→mcp 可穿透。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import {
  PlatformEvents, newId,
  type Collection, type RecordBase, type ResourceTypeSpec, type TopologyNode,
} from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'
import { OidcService } from '../../plugin-authn/src/oidc.ts'
// W2-T4（契约 §10）：MCP 服务记录为 type-only 导入（零运行时耦合，供恢复/归档 additive
// 字段写入的类型断言）；sensitiveHeaderKeys 为纯函数助手（与 console maskServiceHeaders
// 同口径，/authorization|token|secret|key/i），共享契约明确允许跨包导入纯函数。
import type { McpServiceRecord } from '../../plugin-mcp/src/index.ts'
import { sensitiveHeaderKeys } from '../../plugin-mcp/src/secret-broker.ts'
import * as appTools from './tools.ts'
import { APP_TYPE_SPEC } from './schema.ts'
import { buildAppOnboardingPrompt, type AppOnboardingCredential } from './onboarding.ts'
import { AppCredentialService } from './credentials.ts'
// REST 层消费 404 映射（console routes/apps.ts）：随包单一出口转导
export { AppCredentialMissingError } from './credentials.ts'

export interface AppUsageRecord extends RecordBase {
  appId: string
  date: string
  dau: number
  sessions: number
  avgDepth: number
  retention7: number
  /** 页面浏览量（同日多次上报累加；接入方主动上报口径）。 */
  pv?: number
  /** 日独立访客（同日多次上报取最大，与 DAU 同语义的 UV 口径）。 */
  uv?: number
}

/**
 * 平台侧自动折算的当日访客底册（trackVisit 维护，与接入方主动上报的 usage 行分离）：
 * 同日 DAU/UV = 集合规模（只增不减），PV 每次到访 +1，汇入 usage 行时经 max/累加语义天然合并。
 */
export interface AppVisitRecord extends RecordBase {
  appId: string
  date: string
  /** 当日经平台身份到访的去重用户（entry-ticket 兑换 / OIDC 发码折算 DAU）。 */
  userIds: string[]
  /** 当日浏览器匿名访客标识（beacon 折算 UV；缺失时平台按 IP+UA 哈希兜底）。 */
  vids: string[]
}

/** SSO 管理授权的调用方快照（human 用户或机器凭证；与控制台 CallerInfo 对齐的最小面）。 */
export interface AppRegistryServiceSsoCaller {
  kind: 'human' | 'machine'
  /** machine 专属：凭证主体 ID（ownerId 以此登记时视为绑定）。 */
  principalId?: string
  /** machine 专属：凭证关联资源（refType='app'|'agent' 且 refId 命中即绑定）。 */
  refType?: string
  refId?: string
  /** human 专属：平台用户 ID（与资源 ownerId 比对）。 */
  userId?: string
  permissions: string[]
}

/**
 * 应用能力绑定记录（W2-T4，MCP 治理契约 §10，集合 app:capabilities）：
 * App ↔ MCP 服务挂载关系。required=true 的能力参与上线门禁与执行期复核；
 * exposure 钉死 gateway（服务级数据面 §7 的事实暴露形态；服务侧 exposureMode 才是暴露配置）。
 */
export interface AppCapabilityLink extends RecordBase {
  appId: string
  serviceId: string
  /** 参与上线门禁（true）/仅挂载展示（false）。 */
  required: boolean
  /** 暴露形态（契约 §10 钉死 gateway）。 */
  exposure: 'gateway'
  /** 绑定状态（解绑即删记录，现仅 active）。 */
  status: string
  boundAt: string
  boundBy: string
  /** W2-T4 下架联动留痕：联动置 offline 时记录的前置状态，应用重上线时按此恢复。 */
  offlineRestore?: { status: string; grayPercent: number; at: string }
}

/** 能力绑定归属冲突（服务 ownerEntity 已归属其他主体）：REST 层映射 409 OWNER_CONFLICT。 */
export class CapabilityOwnerConflictError extends Error {}

export class AppRegistryService extends Service {
  static readonly provide = 'appRegistry'

  constructor(ctx: Context) {
    super(ctx, 'appRegistry')
    ctx.resourceCore.registerType(APP_TYPE_SPEC)
  }

  usage(): Collection<AppUsageRecord> {
    return this.ctx.opsStorage.collection<AppUsageRecord>('app:usage')
  }

  visits(): Collection<AppVisitRecord> {
    return this.ctx.opsStorage.collection<AppVisitRecord>('app:visits')
  }

  register(input: {
    name: string
    slug?: string
    attrs?: Record<string, unknown>
    ownerId: string
    ownerName: string
    orgId: string
    agentIds?: string[]
    withCredential?: boolean
  }) {
    const agentIds = input.agentIds ?? (Array.isArray(input.attrs?.['agentIds']) ? input.attrs!['agentIds'] as string[] : [])
    for (const agentId of agentIds) {
      const agent = this.ctx.resourceCore.get('agent', agentId)
      if (!agent) throw new Error(t('编排的 Agent 不存在：{id}', { id: agentId }))
      if (agent.status !== 'online') throw new Error(t('Agent「{name}」未上线，不能被应用编排', { name: agent.name }))
    }
    const attrs = { ownerName: input.ownerName, ...(input.attrs ?? {}) }
    const app = this.ctx.resourceCore.create('app', { ...input, attrs })
    this.syncAgentDependencies(app.id, agentIds)
    let credential
    if (input.withCredential !== false) {
      credential = this.ctx.authn.createMachineCredential({
        name: `app:${(app as any).slug}`,
        refType: 'app',
        refId: app.id,
        // app.read/app.write：注册后凭自身凭证即可完成接入验证（读自身）与指标提报/资料更新
        //   （metrics-report、PATCH /api/apps/:id 均要求 app.write）；usage.write：直连消耗自推计量
        scopes: ['mcp.invoke', 'agent.read', 'skill.read', 'app.read', 'app.write', 'usage.write'],
      })
    }
    this.ctx.platformBus.emit(PlatformEvents.AppRegistered, { id: app.id, name: app.name, actor: input.ownerId, type: 'app', slug: app.slug })
    return { app, credential }
  }

  updateApp(appId: string, patch: { name?: string; attrs?: Record<string, unknown> }) {
    const updated = this.ctx.resourceCore.update('app', appId, patch)
    const agentIds = Array.isArray(updated.attrs['agentIds']) ? updated.attrs['agentIds'] as string[] : []
    this.syncAgentDependencies(appId, agentIds)
    this.ctx.platformBus.emit(PlatformEvents.AppUpdated, { id: appId, name: updated.name, actor: 'console' })
    return updated
  }

  /**
   * 生成接入提示词（注册同款模板，平台侧单一事实源）：
   * rotate=true 时轮换机器凭证 secret（旧值立即失效、存量令牌吊销）并随提示词返回；
   * rotate=false 仅含 client_id，secret 以占位符呈现（密钥丢失场景必须 rotate 才能拿到可用凭证）。
   */
  buildOnboardingPrompt(appId: string, origin: string, opts: { rotate?: boolean } = {}): {
    appName: string
    prompt: string
    credential: AppOnboardingCredential
    rotated: boolean
  } {
    const app = this.ctx.resourceCore.get('app', appId)
    if (!app) throw new Error(t('应用不存在：{id}', { id: appId }))
    const principal = this.ctx.authn.principals().findOne((item) => item.refType === 'app' && item.refId === appId)
    if (!principal) throw new Error(t('应用机器凭证不存在（可能已被禁用或删除），无法生成接入提示词'))
    let credential: AppOnboardingCredential
    let rotated = false
    if (opts.rotate) {
      const next = this.ctx.authn.rotateMachineCredential(principal.id)
      credential = { clientId: next.principal.clientId, clientSecret: next.clientSecret }
      rotated = true
    } else {
      credential = { clientId: principal.clientId }
    }
    return { appName: app.name, prompt: buildAppOnboardingPrompt(app, credential, origin), credential, rotated }
  }

  /** 应用 → Agent 依赖图维护（编排拓扑数据源）。 */
  private syncAgentDependencies(appId: string, agentIds: string[]): void {
    const existing = this.ctx.resourceCore.dependencies().find((record) => record.fromType === 'app' && record.fromId === appId && record.kind === 'agent')
    const keep = new Set(agentIds)
    for (const record of existing) {
      if (!keep.has(record.toId)) {
        this.ctx.resourceCore.removeDependency({ fromType: 'app', fromId: appId, toType: 'agent', toId: record.toId })
      } else {
        keep.delete(record.toId)
      }
    }
    for (const agentId of keep) {
      this.ctx.resourceCore.addDependency({ fromType: 'app', fromId: appId, toType: 'agent', toId: agentId, kind: 'agent' })
    }
  }

  /** 依赖拓扑可视化：应用 → Agent → MCP/Skill 一图穿透，异常节点可标注。 */
  topology(appId: string): TopologyNode {
    return this.ctx.resourceCore.topology('app', appId, 3)
  }

  // -- 能力绑定（W2-T4，MCP 治理契约 §10） ----------------------------------

  /** 应用能力绑定集合（App ↔ MCP 服务挂载关系，模式照 app:usage 等既有集合）。 */
  capabilities(): Collection<AppCapabilityLink> {
    return this.ctx.opsStorage.collection<AppCapabilityLink>('app:capabilities')
  }

  /** 本 app 全部能力绑定（按绑定时间稳定排序）。 */
  listCapabilities(appId: string): AppCapabilityLink[] {
    return this.capabilities().find((item) => item.appId === appId)
      .sort((a, b) => a.boundAt.localeCompare(b.boundAt) || a.id.localeCompare(b.id))
  }

  /**
   * 绑定能力服务：服务必须存在；绑定同步把服务 ownerEntity 回写为 {type:'app', id:appId}——
   * 仅当服务当前归属为 platform 占位（无 id，治理待办 unowned）或已是本 app 时允许回写，
   * 已归属其他主体一律抛 CapabilityOwnerConflictError（REST 层映射 409 OWNER_CONFLICT）。
   * 重复绑定幂等返回现态（不改 required 现值）；同步维护 resource-core 依赖边
   * {app→mcp, kind:'capability'}（契约 §10，拓扑 app→agent→mcp 可穿透）。
   */
  bindCapability(appId: string, input: { serviceId: string; required?: boolean; boundBy: string }): { link: AppCapabilityLink; created: boolean } {
    const app = this.ctx.resourceCore.get('app', appId)
    if (!app) throw new Error(t('应用不存在：{id}', { id: appId }))
    const service = this.ctx.mcpRegistry.services().get(input.serviceId)
    if (!service) throw new Error(t('MCP 服务不存在：{id}', { id: input.serviceId }))
    const existing = this.capabilities().findOne((item) => item.appId === appId && item.serviceId === input.serviceId)
    if (existing) return { link: existing, created: false } // 幂等：重复绑定返回现态
    // 归属回写闸门（fail-closed）：platform 占位（无 id）可认领；已被其他主体认领即冲突
    const owner = service.ownerEntity
    const claimable = !owner || (owner.type === 'platform' && !owner.id) || (owner.type === 'app' && owner.id === appId)
    if (!claimable) {
      throw new CapabilityOwnerConflictError(t('服务「{name}」已归属其他主体（ownerEntity={type}:{id}），不能重复绑定到本应用', { name: service.name, type: owner.type, id: owner.id ?? '-' }))
    }
    this.ctx.mcpRegistry.setOwnerEntity(input.serviceId, { type: 'app', id: appId })
    const link = this.capabilities().insert({
      id: newId('apc'),
      appId,
      serviceId: input.serviceId,
      required: input.required === true,
      exposure: 'gateway',
      status: 'active',
      boundAt: new Date().toISOString(),
      boundBy: input.boundBy,
    })
    this.ctx.resourceCore.addDependency({ fromType: 'app', fromId: appId, toType: 'mcp', toId: input.serviceId, kind: 'capability' })
    return { link, created: true }
  }

  /**
   * 解绑能力服务：删除绑定记录与 capability 依赖边；服务归属若已回写为本 app，
   * 联动还原为 {type:'platform'} 占位（回到治理待办 unowned；解绑联动由 REST 层 changeLog 注明）。
   */
  unbindCapability(appId: string, serviceId: string): { removed: boolean; ownerRestored: boolean } {
    const link = this.capabilities().findOne((item) => item.appId === appId && item.serviceId === serviceId)
    if (!link) return { removed: false, ownerRestored: false }
    this.capabilities().remove(link.id)
    this.ctx.resourceCore.removeDependency({ fromType: 'app', fromId: appId, toType: 'mcp', toId: serviceId })
    let ownerRestored = false
    const service = this.ctx.mcpRegistry.services().get(serviceId)
    if (service && service.ownerEntity.type === 'app' && service.ownerEntity.id === appId) {
      this.ctx.mcpRegistry.setOwnerEntity(serviceId, { type: 'platform' })
      ownerRestored = true
    }
    return { removed: true, ownerRestored }
  }

  /**
   * 上线能力门禁（W2-T4，契约 §10）：对本 app 全部 required 能力逐条校验，返回不满足原因
   * 清单（空数组=通过；文案面向管理员，列明服务名+原因）。逐项口径：
   *   ① 服务 status ∈ {online, gray}；② 已完成 verify（health 非 unknown 或有 lastProbeAt）；
   *   ③ 工具清单非空；④ 无未决高危风险（write/admin 且 pending 的风险登记——风险登记服务
   *   缺席（独立单测宿主，同插件 apply() 直连装配口径）时跳过该项）；
   *   ⑤ 已配置 credential 或无敏感头需求（sensitiveHeaderKeys 与 maskServiceHeaders 同判）。
   */
  capabilityGateFailures(appId: string): string[] {
    const failures: string[] = []
    const riskRegistry = this.ctx.mcpRegistry.riskRegistry()
    for (const link of this.listCapabilities(appId)) {
      if (!link.required) continue
      const service = this.ctx.mcpRegistry.services().get(link.serviceId)
      const label = service ? t('「{name}」', { name: service.name }) : t('「{id}」（已删除）', { id: link.serviceId })
      if (!service) {
        failures.push(t('{label}：能力服务不存在，请解绑后重新绑定', { label }))
        continue
      }
      if (!['online', 'gray'].includes(service.status)) {
        failures.push(t('{label}：服务未在线（当前 {status}），required 能力要求 online/gray', { label, status: service.status }))
      }
      if (service.health.status === 'unknown' && !service.health.lastProbeAt) {
        failures.push(t('{label}：尚未完成测试验证（verify），请先在 MCP 服务页执行验证', { label }))
      }
      if (service.tools.length === 0) {
        failures.push(t('{label}：工具清单为空，请先完成工具发现/登记', { label }))
      }
      // ④ 风险登记取用（W1/V11 同款结构化取用；独立单测宿主缺席=无生效登记口径可查，跳过）
      if (riskRegistry) {
        // findOne：集合 find 返回数组（空数组亦为真值），取单条须用 findOne
        const pendingHigh = riskRegistry.records().findOne((item) => item.serviceId === service.id
          && (item.status === 'pending_domain' || item.status === 'pending_security')
          && (item.risk === 'write' || item.risk === 'admin'))
        if (pendingHigh) {
          failures.push(t('{label}：工具 {tool} 存在未决高危风险登记（{stage}），请先完成两级审批', { label, tool: pendingHigh.toolName, stage: pendingHigh.status }))
        }
      }
      if (!service.credentialRef && sensitiveHeaderKeys(service.headers).length > 0) {
        failures.push(t('{label}：存在明文敏感认证头且未配置下游凭证，请经 PUT /api/mcp/services/:id/credential 走 Secret Broker 下发', { label }))
      }
    }
    return failures
  }

  // -- 生命周期（同 Agent：L4 审批） --------------------------------------

  requestOnline(appId: string, requester: { id: string; name: string }) {
    const app = this.ctx.resourceCore.get('app', appId)
    if (!app) throw new Error(t('应用不存在：{id}', { id: appId }))
    const errors = this.ctx.resourceCore.validateAttrs('app', app.attrs, 'online')
    if (errors.length > 0) throw new Error(t('上线条件不满足：{errors}', { errors: errors.join('；') }))
    // 上线门禁（点 1，早反馈）：门禁形态（默认 web,h5）必须有 active SSO 客户端
    const ssoClientId = this.checkSsoGate(app)
    // W2-T4 能力门禁（契约 §10，validateAttrs/SSO gate 之后）：required 能力逐条校验——
    // 在线 / 已验证 / 工具非空 / 无未决高危 / 凭证就绪；任一不满足即拒绝并列明服务名+原因
    const capabilityFailures = this.capabilityGateFailures(appId)
    if (capabilityFailures.length > 0) {
      throw new Error(t('CAPABILITY_GATE_FAILED：能力门禁未通过（{count} 项）——{reasons}', { count: capabilityFailures.length, reasons: capabilityFailures.join('；') }))
    }
    return this.ctx.audit.createApproval({
      kind: 'app.online',
      // WP-10/L1：L4 高危操作统一高风险——通过需二次确认，通过即落公司级终审标记
      riskLevel: 'high',
      title: t('AI 应用上线：{name}', { name: app.name }),
      payload: { appId, requesterId: requester.id, ...(ssoClientId !== undefined ? { ssoClientId } : {}) },
      requesterId: requester.id,
      requesterName: requester.name,
    })
  }

  /** SSO 门禁校验：返回 active 客户端 clientId（供审批单快照），违规抛错并指路。 */
  private checkSsoGate(app: { id: string; name: string; attrs: Record<string, unknown> }): string | undefined {
    const enforce = AppRegistryService.ssoEnforceTypes()
    if (enforce.length === 0) return this.activeSsoClient(app.id)?.clientId
    const appType = String(app.attrs['appType'] ?? '')
    if (!enforce.includes(appType)) return this.activeSsoClient(app.id)?.clientId
    const active = this.activeSsoClient(app.id)
    if (!active) {
      throw new Error(t('上线门禁：{appType} 形态应用上线前必须完成身份纳管——请在「AI 应用 → 应用详情 → SSO 配置」签发 OIDC 客户端（当前门禁形态：{enforce}）；回调地址为本机环回（127.0.0.1 / localhost / 0.0.0.0）时，应用可凭自身机器凭证直接调 POST /api/apps/:id/sso-client 自助签发', { appType, enforce: enforce.join('/') }))
    }
    return active.clientId
  }

  requestOffline(appId: string, requester: { id: string; name: string }, reason: string) {
    const app = this.ctx.resourceCore.get('app', appId)
    if (!app) throw new Error(t('应用不存在：{id}', { id: appId }))
    if (!reason?.trim()) throw new Error(t('下架必须填写原因（护栏要求）'))
    return this.ctx.audit.createApproval({
      kind: 'app.offline',
      // WP-10/L1：L4 高危操作统一高风险——通过需二次确认，通过即落公司级终审标记
      riskLevel: 'high',
      title: t('AI 应用下架：{name}', { name: app.name }),
      payload: { appId, reason },
      requesterId: requester.id,
      requesterName: requester.name,
    })
  }

  online(appId: string, actor: string) {
    const result = this.ctx.resourceCore.transition('app', appId, 'online', actor)
    this.ctx.platformBus.emit(PlatformEvents.AppOnlined, { id: appId, name: result.entity.name, actor, type: 'app', slug: result.entity.slug })
    return result.entity
  }

  offline(appId: string, actor: string, reason: string) {
    const result = this.ctx.resourceCore.transition('app', appId, 'offline', actor, reason)
    // W2-T4 下架联动（契约 §10）：能力服务随应用一起退出服务——app.offline 执行器与
    // requestOffline 完成路径均经本方法收口，联动实现单点化
    this.linkageOfflineCapabilityServices(appId)
    this.ctx.platformBus.emit(PlatformEvents.AppOfflined, { id: appId, name: result.entity.name, actor, reason, type: 'app', slug: result.entity.slug })
    return result.entity
  }

  /**
   * 下架联动（W2-T4，契约 §10）：本 app 全部能力对应服务（ownerEntity 已回写为本 app 的，
   * 含非 required）执行下线。系统联动走直下路径（直调 offlineService——审批语义仅适用于
   * 人工操作），actor 标记 app-offline-linkage；服务下线经 plugin-mcp 既有管道发 McpOfflined
   * 事件，changeLog/审计自动跟随。恢复前置状态记录在绑定记录 offlineRestore 供重上线恢复。
   * 单服务失败不阻断应用下架主流程（warn 留痕，可经治理摘要/能力视图发现）。
   */
  private linkageOfflineCapabilityServices(appId: string): void {
    const app = this.ctx.resourceCore.get('app', appId)
    for (const link of this.listCapabilities(appId)) {
      const service = this.ctx.mcpRegistry.services().get(link.serviceId)
      if (!service) continue
      const owner = service.ownerEntity
      if (!(owner.type === 'app' && owner.id === appId) || service.status === 'offline') continue
      try {
        this.ctx.mcpRegistry.offlineService(service.id, 'app-offline-linkage', t('应用「{name}」下架联动下线能力服务', { name: app?.name ?? appId }))
        this.capabilities().update(link.id, {
          offlineRestore: { status: service.status, grayPercent: service.grayPercent, at: new Date().toISOString() },
        })
      } catch (error) {
        this.ctx.logger('app').warn(t('能力服务联动下线失败：{service}（{serviceId}）', { service: service.name, serviceId: service.id }), error)
      }
    }
  }

  /**
   * 重上线恢复（W2-T4）：应用重新上线成功后，把曾联动下线的能力服务恢复到下线前状态。
   * plugin-mcp deployService 不接受 offline 起点（仅 draft/verifying/gray/online/unhealthy，
   * 见其状态白名单），故经 services() 公开 getter 直写恢复前置 status/grayPercent，
   * 并落 change 审计留痕；版本/versions 不动（恢复不是新版本发布，不发 McpDeployed 事件）。
   */
  restoreCapabilityServices(appId: string): void {
    for (const link of this.listCapabilities(appId)) {
      if (!link.offlineRestore) continue
      const restore = link.offlineRestore
      const service = this.ctx.mcpRegistry.services().get(link.serviceId)
      if (service && service.status === 'offline') {
        // W2-T4 重上线恢复：deployService 不收 offline 起点，直写回前置状态（类型收窄断言）
        this.ctx.mcpRegistry.services().update(link.serviceId, {
          status: restore.status as McpServiceRecord['status'],
          grayPercent: restore.grayPercent,
        })
        try {
          this.ctx.audit.record({
            type: 'change', actorType: 'system', actorId: 'app-online-linkage', actorName: '应用重上线联动',
            action: 'mcp.service.online-restore', resourceType: 'mcp_service', resourceId: link.serviceId,
            resourceName: service.name, result: 'ok',
            detail: t('应用重上线联动恢复能力服务：status={status} gray={gray}%', { status: restore.status, gray: restore.grayPercent }),
          })
        } catch { /* 最小宿主无审计服务时不阻断恢复 */ }
      }
      this.capabilities().update(link.id, { offlineRestore: undefined })
    }
  }

  /** 归档（终态）：下架后的应用彻底退出运营；关联 SSO 客户端经 app.archived 事件联动禁用。 */
  archive(appId: string, actor: string) {
    const result = this.ctx.resourceCore.transition('app', appId, 'archive', actor)
    this.ctx.platformBus.emit(PlatformEvents.AppArchived, { id: appId, name: result.entity.name, actor, type: 'app', slug: result.entity.slug })
    return result.entity
  }

  /** 删除后的关联清理：编排依赖边清除、SSO 客户端与机器凭证禁用；客户端记录与用量/审计数据保留。 */
  purge(appId: string): void {
    for (const record of this.ctx.resourceCore.dependencies().find((item) => item.fromType === 'app' && item.fromId === appId)) {
      this.ctx.resourceCore.dependencies().remove(record.id)
    }
    for (const client of this.ctx.oidc.clientsForApp(appId)) {
      if (OidcService.isClientActive(client)) this.ctx.oidc.disableClient(client.id, '应用删除联动')
    }
    const principal = this.ctx.authn.principals().findOne((item) => item.refType === 'app' && item.refId === appId)
    if (principal && principal.status === 'active') this.ctx.authn.disablePrincipal(principal.id, '应用删除联动')
    // 外部凭证托管（issue #19）联动清库：应用不存在则凭证无归属，整个密钥文件删除（删除即销毁）
    this.ctx.appCredentials.purge(appId)
    // W2-T4 归档联动（契约 §10）：能力服务保持 offline（不触碰状态、不复活），补 archivedBy
    // 标记（additive 字段，W3 拓扑/治理消费可读）；归属若为本 app 则还原 platform 占位
    // （防悬挂引用，同解绑语义）；绑定记录清除——capability 依赖边/凭证文件/OIDC/机器凭证
    // 联动均由上方既有逻辑覆盖，此处不重复。
    for (const link of this.listCapabilities(appId)) {
      const service = this.ctx.mcpRegistry.services().get(link.serviceId)
      if (service) {
        const owner = service.ownerEntity
        this.ctx.mcpRegistry.services().update(link.serviceId, {
          archivedBy: appId, // W2-T4 归档联动
          ...(owner.type === 'app' && owner.id === appId ? { ownerEntity: { type: 'platform' as const } } : {}),
        } as unknown as Partial<McpServiceRecord>)
      }
      this.capabilities().remove(link.id)
    }
  }

  // -- SSO 客户端（应用 ↔ 平台身份源打通；owner 自助签发） ----------------------

  /** 上线门禁覆盖的应用形态（APP_SSO_ENFORCE，默认 web,h5；空串可关闭门禁）。 */
  static ssoEnforceTypes(): string[] {
    return String(process.env.APP_SSO_ENFORCE ?? 'web,h5').split(',').map((item) => item.trim()).filter(Boolean)
  }

  /**
   * owner-based 授权（全库首例，非 permission-point 制）：
   * human 且 app.ownerId === userId，或持 authn.oidc.write（管理员兜底）；机器 principal 一律 403。
   */
  assertSsoManage(app: { id: string; name: string; ownerId: string }, caller: { kind: string; userId?: string; permissions: string[] }): void {
    if (caller.kind !== 'human' || !caller.userId) {
      throw new Error(t('SSO 客户端管理仅限用户身份（owner 校验），机器身份不可操作'))
    }
    const isOwner = app.ownerId === caller.userId
    const hasAdmin = caller.permissions.includes('*') || caller.permissions.includes('authn.oidc.write')
    if (!isOwner && !hasAdmin) {
      throw new Error(t('仅应用 owner 或持有 authn.oidc.write 的管理员可管理「{name}」的 SSO 客户端', { name: app.name }))
    }
  }

  /**
   * 回跳地址护栏：https 任意主机；http 仅限内网（环回 / RFC1918 私网 / 链路本地 / IPv6 ULA）。
   * 纯内网部署可用 APP_SSO_ALLOW_HTTP=1 放开全部 http 主机（公网明文回调仍建议 https）。
   * 公共静态：plugin-console 的管理端 OIDC 客户端路由复用同一份口径。
   */
  static assertRedirectUris(uris: string[]): void {
    if (!Array.isArray(uris) || uris.length === 0) throw new Error(t('redirectUris 必填（至少一个回调地址）'))
    const allowAnyHttp = String(process.env.APP_SSO_ALLOW_HTTP ?? '') === '1'
    for (const uri of uris) {
      let parsed: URL
      try { parsed = new URL(uri) } catch { throw new Error(t('回调地址非法：{uri}', { uri })) }
      if (parsed.protocol === 'https:') continue
      if (parsed.protocol === 'http:' && (allowAnyHttp || AppRegistryService.isIntranetHost(parsed.hostname))) continue
      throw new Error(t('回调地址必须为 https://，或 http:// 的内网地址（localhost / 127.0.0.1 / 0.0.0.0 / 10.x / 172.16-31.x / 192.168.x）（收到：{uri}）', { uri }))
    }
  }

  /** 内网主机判定：环回、RFC1918 私网、链路本地、IPv6 ULA。 */
  private static isIntranetHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
    if (host.includes(':')) return host.startsWith('f') || host.startsWith('fd') // fc00::/7 ULA
    const parts = host.split('.')
    if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false // 非点分 IPv4 一律按公网处理
    const [a, b] = parts.map(Number) as [number, number]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }

  /** 环回主机判定（本机回调）：localhost / *.localhost / 127.0.0.0/8 / ::1 / 0.0.0.0。 */
  static isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost')) return true
    if (host.startsWith('127.')) return true
    return false
  }

  /** 回调地址全集是否均为环回（空集不算——机器自助必须显式登记环回回调）。 */
  static isLoopbackOnlyCallback(uris: string[] | undefined): boolean {
    if (!Array.isArray(uris) || uris.length === 0) return false
    return uris.every((uri) => {
      try { return AppRegistryService.isLoopbackHost(new URL(uri).hostname) } catch { return false }
    })
  }

  /**
   * 机器身份环回自助开关（默认开，APP_SSO_MACHINE_LOOPBACK=0 关闭）：
   * 应用/Agent 的机器凭证（或登记 owner principal）可自行签发/管理回调地址全为环回的 SSO 客户端——
   * 本机回调不跨机，授权码 + 强制 PKCE 下第三者截码无利可图（RFC 8252 loopback 口径）；
   * 非环回回调（内网 IP / 公网域名）仍须 human owner 或管理员操作。
   */
  static machineSsoSelfServiceEnabled(): boolean {
    return String(process.env.APP_SSO_MACHINE_LOOPBACK ?? '1') !== '0'
  }

  /**
   * SSO 管理授权决策（app/agent 两侧控制台路由共用口径）：
   * - human：资源 owner（ownerId === userId）或持 authn.oidc.write（管理员兜底）→ 放行；
   * - machine：开关开启时，绑定本资源的凭证（refType/refId 命中或 ownerId === principalId）可放行——
   *   create/update 按本次生效回调集判定，rotate/enable 按现存回调集判定，disable（纯降险）恒放行；
   *   回调集必须全为环回（isLoopbackOnlyCallback），否则仅 human 可操作。
   */
  static ssoManageDecision(
    resource: { id: string; name: string; ownerId: string },
    caller: AppRegistryServiceSsoCaller,
    effective: { redirectUris: string[]; postLogoutUris: string[] },
    op: 'create' | 'update' | 'rotate' | 'enable' | 'disable',
  ): { allowed: true } | { allowed: false; reason: string } {
    if (caller.kind !== 'human') {
      if (!AppRegistryService.machineSsoSelfServiceEnabled()) {
        return { allowed: false, reason: t('SSO 客户端管理仅限用户身份（owner 校验），机器身份不可操作') }
      }
      const bound = (caller.refType !== undefined && caller.refId === resource.id)
        || resource.ownerId === caller.principalId
      if (!bound) {
        return { allowed: false, reason: t('机器身份仅可管理自身绑定资源的 SSO 客户端（「{name}」须为凭证 refType/refId 命中或登记 owner）', { name: resource.name }) }
      }
      if (op === 'disable') return { allowed: true } // 禁用纯降险，恒放行
      if (!AppRegistryService.isLoopbackOnlyCallback([...effective.redirectUris, ...effective.postLogoutUris])) {
        return { allowed: false, reason: t('机器身份自助仅限环回回调地址（http://127.0.0.1:PORT、http://localhost:PORT、0.0.0.0）；非环回回调请由应用 owner 或管理员在控制台操作') }
      }
      return { allowed: true }
    }
    const isOwner = Boolean(caller.userId) && resource.ownerId === caller.userId
    const hasAdmin = caller.permissions.includes('*') || caller.permissions.includes('authn.oidc.write')
    if (!isOwner && !hasAdmin) {
      return { allowed: false, reason: t('仅资源 owner 或持有 authn.oidc.write 的管理员可管理「{name}」的 SSO 客户端', { name: resource.name }) }
    }
    return { allowed: true }
  }

  /**
   * owner-based 授权（全库首例，非 permission-point 制）+ 机器环回自助例外（ssoManageDecision）。
   * 服务层兜底校验：控制台路由层已先行调用 ssoManageDecision 并 403，此处保持同口径防绕行。
   */
  static assertSsoManage(
    app: { id: string; name: string; ownerId: string },
    caller: AppRegistryServiceSsoCaller,
    effective?: { redirectUris: string[]; postLogoutUris: string[] },
    op: 'create' | 'update' | 'rotate' | 'enable' | 'disable' = 'update',
  ): void {
    const decision = AppRegistryService.ssoManageDecision(app, caller, effective ?? { redirectUris: [], postLogoutUris: [] }, op)
    if (!decision.allowed) throw new Error(decision.reason)
  }

  activeSsoClient(appId: string) {
    return this.ctx.oidc.clientsForApp(appId).find((client) => OidcService.isClientActive(client))
  }

  /** 签发应用关联 OIDC 客户端（name=应用名，回填 refType/refId）；secret 仅本次返回。 */
  createSsoClient(appId: string, input: {
    redirectUris: string[]
    clientType?: 'confidential' | 'public'
    consentRequired?: boolean
    postLogoutUris?: string[]
    description?: string
  }): { client: ReturnType<OidcService['clientsForApp']>[number]; clientSecret: string } {
    const app = this.ctx.resourceCore.get('app', appId)
    if (!app) throw new Error(t('应用不存在：{id}', { id: appId }))
    AppRegistryService.assertRedirectUris(input.redirectUris)
    const existing = this.ctx.oidc.clientsForApp(appId)
    if (existing.length > 0) throw new Error(t('该应用已签发 SSO 客户端（{clientId}），请直接管理或先禁用后重新签发', { clientId: existing[0]!.clientId }))
    const created = this.ctx.oidc.createClient({
      name: app.name,
      redirectUris: input.redirectUris,
      ...(input.clientType !== undefined ? { clientType: input.clientType } : {}),
      ...(input.consentRequired !== undefined ? { consentRequired: input.consentRequired } : {}),
      ...(input.postLogoutUris !== undefined ? { postLogoutUris: input.postLogoutUris } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      refType: 'app',
      refId: appId,
    })
    return created
  }

  updateSsoClient(appId: string, patch: { redirectUris?: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[] }) {
    this.requireSsoClient(appId)
    if (patch.redirectUris !== undefined) AppRegistryService.assertRedirectUris(patch.redirectUris)
    return this.ctx.oidc.updateClient(this.requireSsoClient(appId).id, patch)
  }

  rotateSsoSecret(appId: string) {
    return this.ctx.oidc.rotateSecret(this.requireSsoClient(appId).id)
  }

  disableSsoClient(appId: string, reason: string) {
    return this.ctx.oidc.disableClient(this.requireSsoClient(appId).id, reason)
  }

  enableSsoClient(appId: string) {
    return this.ctx.oidc.enableClient(this.requireSsoClient(appId).id)
  }

  private requireSsoClient(appId: string) {
    const clients = this.ctx.oidc.clientsForApp(appId)
    if (clients.length === 0) throw new Error(t('该应用尚未签发 SSO 客户端'))
    return clients[0]!
  }

  // -- 组织架构同步（应用自助复用平台组织模块） -----------------------------

  /**
   * 组织架构快照（REST /api/apps/:id/org-sync，应用自助通道）：
   * 接入应用凭自身绑定机器凭证（或 owner 身份）拉取平台组织树与在职成员，
   * 在应用内复刻/关联平台组织架构功能（组织树、部门成员、负责人识别）。
   * 关联键：users[].id 即 OIDC userinfo 的 sub，登录身份直接挂到部门/负责人。
   * PII 最小化：不含手机号/邮箱/角色/三方绑定（更全字段走 /api/iam/roster，
   * 须管理员追加 iam.roster.read）；已注销（deactivated）账号不出现。
   * version 为内容哈希（排序后稳定）：组织/成员任一变更即变，
   * 接入方以 ?ifNoneMatch= 轮询实现零载荷变更检测；快照即事实，变更后全量对齐覆盖本地副本。
   */
  orgSnapshot(appId: string, opts: { ifNoneMatch?: string } = {}): {
    unchanged: boolean
    version: string
    generatedAt?: string
    orgs?: Array<{ id: string; name: string; parentId: string | null; order: number; status: string; leaderUserIds: string[]; updatedAt: string }>
    users?: Array<{ id: string; username: string; displayName: string; title: string; jobNumber: string; orgId: string; orgName: string; primaryOrgId?: string; status: string; accountType?: string; updatedAt: string }>
  } {
    if (!this.ctx.resourceCore.get('app', appId)) throw new Error(t('应用不存在：{id}', { id: appId }))
    const orgNames = new Map(this.ctx.iam.orgs().all().map((org) => [org.id, org.name]))
    const orgs = this.ctx.iam.orgs().all()
      .map((org) => ({
        id: org.id,
        name: org.name,
        parentId: org.parentId,
        order: org.order,
        status: org.status,
        leaderUserIds: this.ctx.iam.leadersOf(org.id),
        updatedAt: org.updatedAt,
      }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id))
    const users = this.ctx.iam.users().all()
      .filter((user) => user.status !== 'deactivated')
      .map((user) => ({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        title: user.title,
        jobNumber: user.jobNumber ?? '',
        orgId: user.orgId,
        orgName: orgNames.get(user.orgId) ?? '',
        ...(user.primaryOrgId !== undefined ? { primaryOrgId: user.primaryOrgId } : {}),
        status: user.status,
        ...(user.accountType !== undefined ? { accountType: user.accountType } : {}),
        updatedAt: user.updatedAt,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN') || a.id.localeCompare(b.id))
    // 内容哈希（16 位足内网规模碰撞无虞）：含全部对外字段与 updatedAt，插入顺序不参与
    const version = createHash('sha256')
      .update(JSON.stringify({ orgs, users }))
      .digest('hex')
      .slice(0, 16)
    if (opts.ifNoneMatch && opts.ifNoneMatch === version) return { unchanged: true, version }
    return { unchanged: false, version, generatedAt: new Date().toISOString(), orgs, users }
  }

  // -- 应用层指标 ---------------------------------------------------------

  /**
   * 记录应用层指标（外部应用主动上报通道：REST /api/apps/:id/metrics-report、
   * 工具 app_metrics_report、CLI app report 均汇入此方法）。
   * 语义：同日 DAU/UV 取最大、会话数/PV 累加；可指定 date 补录历史（YYYY-MM-DD）。
   */
  recordUsage(appId: string, usage: { dau?: number; sessions?: number; avgDepth?: number; retention7?: number; pv?: number; uv?: number; date?: string }): void {
    if (!this.ctx.resourceCore.get('app', appId)) throw new Error(t('应用不存在：{id}', { id: appId }))
    const date = usage.date ?? new Date().toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(t('date 格式非法：{date}（应为 YYYY-MM-DD）', { date }))
    // REL-04：指标入参校验（对照 beacon 侧 trackVisit 的非负钳制口径）——负数 pv/uv/dau/sessions
    // 可刷减累计/取大口径，retention7 越界会污染留存口径，一律 400 拒收
    for (const [key, value] of [['pv', usage.pv], ['uv', usage.uv], ['dau', usage.dau], ['sessions', usage.sessions]] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new Error(t('{key} 必须是非负整数（收到：{value}）', { key, value }))
    }
    if (usage.retention7 !== undefined && (!Number.isFinite(usage.retention7) || usage.retention7 < 0 || usage.retention7 > 1)) {
      throw new Error(t('retention7 必须是 0..1 之间的数值（收到：{value}）', { value: usage.retention7 }))
    }
    const existing = this.usage().findOne((item) => item.appId === appId && item.date === date)
    if (existing) {
      this.usage().update(existing.id, {
        dau: Math.max(existing.dau, usage.dau ?? existing.dau),
        sessions: existing.sessions + (usage.sessions ?? 0),
        avgDepth: usage.avgDepth ?? existing.avgDepth,
        retention7: usage.retention7 ?? existing.retention7,
        pv: (existing.pv ?? 0) + (usage.pv ?? 0),
        uv: Math.max(existing.uv ?? 0, usage.uv ?? 0),
      })
    } else {
      this.usage().insert({
        id: newId('apu'),
        appId,
        date,
        dau: usage.dau ?? 0,
        sessions: usage.sessions ?? 0,
        avgDepth: usage.avgDepth ?? 0,
        retention7: usage.retention7 ?? 0,
        pv: usage.pv ?? 0,
        uv: usage.uv ?? 0,
      })
    }
  }

  /**
   * 平台侧自动折算访客指标（区别于接入方主动上报 recordUsage）：
   *   - entry-ticket 兑换 / OIDC 发码 → 平台身份访客（按 userId 去重，折算 DAU）；
   *   - 浏览器 beacon → 匿名访客（按 vid 去重，折算 UV）+ PV 逐次累加。
   * 同一日集合只增不减，DAU/UV 以集合规模经 recordUsage 的 max 语义汇入、PV 走累加；
   * 未知应用静默忽略（公开 beacon 端点不得向调用方泄露应用存在性）。
   */
  trackVisit(appId: string, visitor: { userId?: string; vid?: string; pv?: number }): void {
    if (!this.ctx.resourceCore.get('app', appId)) return
    const userId = visitor.userId === undefined ? undefined : String(visitor.userId).trim().slice(0, 128)
    const vid = visitor.vid === undefined ? undefined : String(visitor.vid).trim().slice(0, 128)
    const pv = Math.max(0, Math.min(10, Math.floor(Number(visitor.pv ?? 0)) || 0))
    if (!userId && !vid && pv === 0) return
    const date = new Date().toISOString().slice(0, 10)
    const record = this.visits().findOne((item) => item.appId === appId && item.date === date)
      ?? this.visits().insert({ id: newId('apv'), appId, date, userIds: [], vids: [] })
    // 单应用单日底册封顶（公开端点写入面，防异常膨胀；正常内网流量远达不到）
    const CAP = 10_000
    const userIds = record.userIds ?? []
    const vids = record.vids ?? []
    if (userId && !userIds.includes(userId) && userIds.length < CAP) userIds.push(userId)
    if (vid && !vids.includes(vid) && vids.length < CAP) vids.push(vid)
    this.visits().update(record.id, { userIds, vids })
    this.pruneVisits()
    this.recordUsage(appId, {
      ...(pv > 0 ? { pv } : {}),
      dau: userIds.length,
      uv: userIds.length + vids.length,
    })
  }

  /** 访客底册保留 31 天（仅服务当日折算与对账，久置无价值）。 */
  private pruneVisits(): void {
    const cutoff = new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10)
    for (const record of this.visits().find((item) => item.date < cutoff)) this.visits().remove(record.id)
  }

  metrics(appId: string): {
    dau: number
    mau: number
    pv: number
    uv: number
    sessions: number
    avgDepth: number
    retention7: number
    series: Array<{ date: string; dau: number; pv: number; uv: number; sessions: number }>
  } {
    const rows = this.usage().find((item) => item.appId === appId).sort((a, b) => a.date.localeCompare(b.date))
    const today = rows.at(-1)
    const last30 = rows.slice(-30)
    return {
      dau: today?.dau ?? 0,
      mau: last30.reduce((sum, row) => sum + row.dau, 0),
      pv: today?.pv ?? 0,
      uv: today?.uv ?? 0,
      sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
      avgDepth: Math.round((rows.reduce((sum, row) => sum + row.avgDepth, 0) / Math.max(1, rows.length)) * 10) / 10,
      retention7: today?.retention7 ?? 0,
      series: rows.slice(-14).map((row) => ({ date: row.date, dau: row.dau, pv: row.pv ?? 0, uv: row.uv ?? 0, sessions: row.sessions })),
    }
  }

  overview(): { total: number; online: number; trial: number } {
    const apps = this.ctx.resourceCore.list('app')
    return {
      total: apps.length,
      online: apps.filter((item) => item.status === 'online').length,
      trial: apps.filter((item) => item.status === 'trial').length,
    }
  }

  /** 成本穿透：应用 → Agent → MCP/模型。 */
  costBreakdown(appId: string): Array<{ agentName: string; llmTokens: number; toolCalls: number; costYuan: number }> {
    const rows: Array<{ agentName: string; llmTokens: number; toolCalls: number; costYuan: number }> = []
    const deps = this.ctx.resourceCore.dependencies().find((record) => record.fromType === 'app' && record.fromId === appId && record.kind === 'agent')
    for (const dep of deps) {
      const agent = this.ctx.resourceCore.get('agent', dep.toId)
      const costs = this.ctx.audit.costs().find((cost) => cost.agentId === dep.toId)
      rows.push({
        agentName: agent?.name ?? dep.toId,
        llmTokens: costs.reduce((sum, cost) => sum + cost.llmTokens, 0),
        toolCalls: costs.reduce((sum, cost) => sum + cost.toolCalls, 0),
        costYuan: Math.round(costs.reduce((sum, cost) => sum + cost.costYuan, 0) * 1000) / 1000,
      })
    }
    return rows.sort((a, b) => b.costYuan - a.costYuan)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    appRegistry: AppRegistryService
  }
}

export const name = 'app'
// W2-T4：mcpRegistry 直访注入——两个宿主装配序列中 plugin-mcp 均先于本插件装配
// （boot-all.ts mcp→app、cordis.yml ops-mcp→ops-app），check-boot-order [A] 机器可校验；
// 能力绑定/门禁/联动因此走直接 ctx 访问（fail-closed），无需 console 注入回调。
// appCredentials 为本插件自供服务（apply 内先于消费装配，purge 经 registry 联动）。
export const inject = ['opsStorage', 'platformBus', 'resourceCore', 'authn', 'oidc', 'audit', 'iam', 'mcpRegistry']

export function apply(ctx: Context) {
  const registry = new AppRegistryService(ctx)
  // 外部凭证托管（issue #19 方向 A 最小闭环）：AES-256-GCM 静态加密密钥文件，
  // 取值独立权限点 app.credential.fetch + 逐次审计；purge 经 registry 删除联动清库
  new AppCredentialService(ctx)
  ctx.plugin(appTools)
  // 平台侧自动折算（指标口径补全）：SSO 身份到访 → 应用 DAU，经事件总线解耦（不直连 authn/console）。
  // entry-ticket 兑换（console 发射）与 OIDC 发码（authn OidcService 发射）都代表用户已带平台身份进入应用。
  ctx.platformBus.on(PlatformEvents.EntryTicketRedeemed, (payload) => {
    const p = payload as { refType?: string; refId?: string; userId?: string }
    if (p.refType === 'app' && p.refId && p.userId) {
      try { registry.trackVisit(p.refId, { userId: p.userId }) } catch (error) { ctx.logger('app').warn('entry-ticket 兑换折算 DAU 失败', error) }
    }
  })
  ctx.platformBus.on(PlatformEvents.OidcAuthorizeGranted, (payload) => {
    const p = payload as { clientId?: string; userId?: string }
    const client = p.clientId !== undefined ? ctx.oidc.clientByClientId(p.clientId) : undefined
    if (client?.refType === 'app' && client.refId && p.userId) {
      try { registry.trackVisit(client.refId, { userId: p.userId }) } catch (error) { ctx.logger('app').warn('OIDC 发码折算 DAU 失败', error) }
    }
  })
  ctx.effect(() => ctx.audit.registerExecutor('app.online', async (payload) => {
    // 上线门禁（点 2，兜底）：审批挂单期间客户端可能被禁用——执行前复核，失效则执行失败留痕
    const appId = String(payload['appId'])
    const app = ctx.resourceCore.get('app', appId)
    if (app) {
      const enforce = AppRegistryService.ssoEnforceTypes()
      const appType = String(app.attrs['appType'] ?? '')
      if (enforce.includes(appType) && !registry.activeSsoClient(app.id)) {
        throw new Error(t('执行期复核失败：审批期间 SSO 客户端已失效（{appType} 形态门禁），请重新签发后再发起上线', { appType }))
      }
    }
    // W2-T4 执行期复核（契约 §10）：挂单期间 required 能力可能被下线/降级——
    // 逐条复核（在线/已验证/工具非空/无未决高危/凭证就绪），不满足则执行失败留痕
    const capabilityFailures = registry.capabilityGateFailures(appId)
    if (capabilityFailures.length > 0) {
      throw new Error(t('执行期复核失败：审批期间能力服务状态变化（CAPABILITY_GATE_FAILED）——{reasons}', { reasons: capabilityFailures.join('；') }))
    }
    const entity = registry.online(appId, 'approval-center')
    // W2-T4 重上线恢复：曾随应用下架联动下线的能力服务自动恢复前置状态
    registry.restoreCapabilityServices(appId)
    return entity
  }))
  ctx.effect(() => ctx.audit.registerExecutor('app.offline', async (payload) => {
    return registry.offline(String(payload['appId']), 'approval-center', String(payload['reason'] ?? '审批通过下架'))
  }))
  migrateAppCredentialScopes(ctx)
}

/** 一次性迁移：为存量应用机器凭证补 app.read/app.write/usage.write（接入验证与指标提报/资料更新能力对齐）。 */
function migrateAppCredentialScopes(ctx: Context): void {
  const markers = ctx.opsStorage.collection<{ id: string; doneAt: string }>('app:migrations')
  const MARK = 'app-scopes-self-serve-v1'
  if (markers.get(MARK)) return
  const ADDITIONS = ['app.read', 'app.write', 'usage.write']
  let patched = 0
  for (const principal of ctx.authn.principals().find(
    (item) => item.type === 'machine' && item.refType === 'app' && item.status === 'active' && ADDITIONS.some((scope) => !item.scopes.includes(scope)),
  )) {
    const merged = [...principal.scopes, ...ADDITIONS.filter((scope) => !principal.scopes.includes(scope))]
    ctx.authn.principals().update(principal.id, { scopes: merged })
    ctx.audit.record({
      type: 'change', actorType: 'system', actorId: 'app-migration', actorName: '凭证范围迁移',
      action: 'app.credential.scopes-backfill', resourceType: 'app',
      resourceId: principal.refId ?? '', resourceName: principal.name, result: 'ok',
      detail: `补入 ${ADDITIONS.filter((scope) => !principal.scopes.includes(scope)).join('/')}（应用自主接入与提报更新能力对齐）`,
    })
    patched++
  }
  markers.insert({ id: MARK, doneAt: new Date().toISOString() })
  if (patched > 0) ctx.logger('app').info(`存量应用凭证迁移完成：${patched} 条补入 ${ADDITIONS.join('/')}`)
}
