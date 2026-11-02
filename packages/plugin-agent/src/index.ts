/**
 * @dsh-ops/plugin-agent —— Agent 本体管理（方案 §五）。
 *
 * 基于 resource-core 底座：属性表 schema + 生命周期状态机 + 依赖图全部复用，
 * 本插件只声明 Agent 差异 schema 与运营监测逻辑。
 * 注册即纳管：创建 Agent 颁发唯一 ID 与机器身份凭证（authn，含 usage.write，
 * Agent 可自推直连消耗的计量），上线走 L4 审批，下线联动吊销凭证、通知绑定用户、保留审计数据。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import {
  PlatformEvents, newId,
  type Collection, type RecordBase, type ResourceTypeSpec,
} from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'
import { AppRegistryService, type AppRegistryServiceSsoCaller } from '../../plugin-app/src/index.ts'
import { OidcService } from '../../plugin-authn/src/oidc.ts'
import { PermissionCatalog } from '../../plugin-iam/src/index.ts'
import * as agentTools from './tools.ts'
import { AGENT_TYPE_SPEC } from './schema.ts'
import { buildAgentOnboardingPrompt, type AgentOnboardingCredential } from './onboarding.ts'

// ---------------------------------------------------------------------------
// 数据模型（Agent 专属扩展记录）
// ---------------------------------------------------------------------------

export interface AgentBindingRecord extends RecordBase {
  agentId: string
  userId: string
  userName: string
  boundAt: string
  boundBy: string
}

export interface AgentUsageRecord extends RecordBase {
  agentId: string
  date: string
  sessions: number
  calls: number
  okCalls: number
  tokens: number
  totalLatencyMs: number
  /** 来源维度：usage.recorded 回灌归集的调用数（模型网关等，无延迟数据）；calls 含该部分。 */
  gwCalls?: number
  /** 日活跃用户数（提报语义：同日多次上报取最大；网关归集不产生该字段）。 */
  dau?: number
  /** 对话用户去重统计（提报侧传 userIds，平台侧即刻哈希脱敏，同日取并集；不落明文）。 */
  userHashes?: string[]
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class AgentRegistryService extends Service {
  static readonly provide = 'agentRegistry'

  private usageCounter = new Map<string, number[]>()

  constructor(ctx: Context) {
    super(ctx, 'agentRegistry')
    ctx.resourceCore.registerType(AGENT_TYPE_SPEC)

    // 调用监测：MCP 网关以 Agent 为主体调用时自动归集运行指标
    ctx.platformBus.on(PlatformEvents.McpInvoked, (payload) => {
      const p = payload as { callerType: string; callerId: string; ok: boolean; tokens: number; latencyMs: number }
      if (p.callerType !== 'agent') return
      this.recordUsage(p.callerId, { calls: 1, okCalls: p.ok ? 1 : 0, tokens: p.tokens, latencyMs: p.latencyMs }, 'mcp')
      // 行为监测：频次突增检测（10 分钟窗口超过 120 次）
      const nowMs = Date.now()
      const times = (this.usageCounter.get(p.callerId) ?? []).filter((t) => nowMs - t < 10 * 60_000)
      times.push(nowMs)
      this.usageCounter.set(p.callerId, times)
      if (times.length === 120) {
        const agent = ctx.resourceCore.collection('agent').get(p.callerId)
        ctx.audit.fire({
          severity: 'warning',
          title: t('Agent「{name}」调用频次突增', { name: agent?.name ?? p.callerId }),
          message: t('10 分钟内调用 {count} 次，超过异常阈值 120，请检查是否存在死循环或滥用。', { count: times.length }),
          resourceType: 'agent',
          resourceId: p.callerId,
        })
      }
    })

    // 调用统计口径补全：订阅 usage.recorded 回灌模型网关等非 MCP 调用（McpInvoked 只覆盖 MCP 网关）。
    // 防双计规则（三条，缺一即双计/脏计）：
    //   1. 只认 subject=agent:<id> 且 Agent 存在的事件——seed 历史数据与悬空主体不计；
    //   2. resource mcp:* 一律跳过——MCP 网关对同一调用双发 McpInvoked（上方监听已计），
    //      自推计量误报 mcp:* 时同样跳过（网关已计，宁缺勿重）；
    //   3. meters 含 downloads/installs 观测键跳过——Skill 下载/安装是生命周期事件而非调用。
    // 消费幂等：经 usage.consume 消费水位（INSERT OR IGNORE），replay/死信重投不会重复回灌；
    // 投影义务：所有消费方必须 project（usage.reconcile 全量比对，缺投影即「对账不平」告警）。
    ctx.usage.consume('agent-registry', (event) => {
      ctx.usage.project('agent-registry', event)
      if (!event.subject.startsWith('agent:')) return
      const agentId = event.subject.slice('agent:'.length)
      if (!ctx.resourceCore.collection('agent').get(agentId)) return
      if (event.resource.startsWith('mcp:')) return
      if (event.meters.some((meter) => meter.key === 'downloads' || meter.key === 'installs')) return
      // 网关仅在成功返回后计量：回灌事件按成功调用计；延迟无数据不摊薄均值（见 metrics）
      const tokens = event.meters
        .filter((meter) => meter.key === 'input_tokens' || meter.key === 'output_tokens' || meter.key === 'tokens')
        .reduce((sum, meter) => sum + meter.value, 0)
      this.recordUsage(agentId, { calls: 1, okCalls: 1, tokens, latencyMs: 0 }, 'gateway')
    })

    // Skill 弃用 → 通知引用 Agent 的负责人（存量引用告警）
    ctx.platformBus.on(PlatformEvents.SkillDeprecated, (payload) => {
      const p = payload as { skillId: string; name: string }
      for (const record of ctx.resourceCore.dependencies().find((item) => item.kind === 'skill' && item.toId === p.skillId)) {
        const agent = ctx.resourceCore.collection('agent').get(record.fromId)
        if (!agent) continue
        ctx.audit.fire({
          severity: 'info',
          title: t('Agent「{name}」引用的 Skill 已弃用', { name: agent.name }),
          message: t('Skill「{name}」已弃用，请尽快迁移至替代版本，避免下次构建失败。', { name: p.name }),
          resourceType: 'agent',
          resourceId: agent.id,
        })
      }
    })
  }

  bindings(): Collection<AgentBindingRecord> {
    return this.ctx.opsStorage.collection<AgentBindingRecord>('agent:bindings')
  }

  usage(): Collection<AgentUsageRecord> {
    return this.ctx.opsStorage.collection<AgentUsageRecord>('agent:usage')
  }

  // -- 模型目录单一事实源（issue #8） -------------------------------------
  // attrs.model 不再维护静态枚举：可选值 = 模型网关目录（modelgw:models）。
  // 登记 / PATCH（提供了 model 时）/ 上线门禁三处 fail-fast 校验「目录中存在」；
  // 渠道是否 online、endpoint 是否就绪属运行时事实，由 modelgw invoke 权威 enforce
  //（上线后再掉线的场景配置期门禁也拦不住）。

  /** 模型目录 slugs（modelgw 未装配时返回 null——校验跳过，维持 legacy 行为）。
   *  cordis 严格注入下直访 ctx.modelGateway 会被 get trap 硬抛「without inject」，
   *  须走 ctx.reflect.get 软读（同 exec_claim 的 dsh-bridge softRead 口径）。 */
  private modelCatalogSlugs(): string[] | null {
    try {
      const ctxAny = this.ctx as unknown as { reflect?: { get?: (key: string, optional?: boolean) => unknown } }
      const gateway = (typeof ctxAny.reflect?.get === 'function'
        ? ctxAny.reflect.get('modelGateway', true)
        : (this.ctx as unknown as Record<string, unknown>)['modelGateway']) as
        { models?: () => { all(): Array<{ slug: string }> } } | undefined
      const all = gateway?.models?.().all()
      if (!Array.isArray(all)) return null
      return all.map((item) => item.slug)
    } catch {
      return null
    }
  }

  /** 校验 attrs.model 在模型目录中存在（不校验 online 状态），不存在抛中文错误并列出可用 slugs。
   *  空目录放行（引导期豁免）：全新部署一个模型都没登记时，不得把 Agent 登记也锁死——
   *  目录一旦有登记（成为实际可选面），未登记 slug 一律拒绝。modelgw 缺席（异常装配）同样跳过。 */
  assertModelInCatalog(model: unknown): void {
    const slug = String(model ?? '').trim()
    if (!slug) return
    const slugs = this.modelCatalogSlugs()
    if (slugs === null || slugs.length === 0) return
    if (!slugs.includes(slug)) {
      throw new Error(t('底层模型「{slug}」不在模型目录：请先在模型网关登记（当前可用：{values}）', { slug, values: slugs.join(' / ') }))
    }
  }

  // -- 注册 -------------------------------------------------------------

  /**
   * R7 组织化：汇报线环校验（create/update 涉及 managerId 时调用，保证组织架构是有根森林）。
   * managerId 为空直接过（不参与汇报线）；指向自身抛错（「汇报线不得指向自己」）；
   * 指向不存在的 Agent 抛错；沿 managerId 向上回溯（步数上限 100），回到自身抛错（「汇报线成环」）。
   */
  assertOrgChartAcyclic(agentId: string, managerId: string | undefined): void {
    const manager = String(managerId ?? '').trim()
    if (!manager) return
    if (manager === agentId) throw new Error(t('汇报线不得指向自己'))
    const collection = this.ctx.resourceCore.collection('agent')
    let current = manager
    for (let steps = 0; steps < 100; steps++) {
      if (current === agentId) throw new Error(t('汇报线成环：沿汇报上级回溯会回到该 Agent，请修正 managerId'))
      const node = collection.get(current)
      if (!node) throw new Error(t('汇报上级 Agent 不存在：{id}', { id: current }))
      const next = String(node.attrs['managerId'] ?? '').trim()
      if (!next) return // 回溯到顶（链路上无环）
      current = next
    }
    // 步数上限兜底：不含自身的既有环数据或超深链路在此截断，同样拒绝
    throw new Error(t('汇报线成环（或层级超过 100 级）：请修正 managerId'))
  }

  register(input: {
    name: string
    slug?: string
    attrs?: Record<string, unknown>
    ownerId: string
    ownerName: string
    orgId: string
    withCredential?: boolean
  }): { agent: import('../../platform-core/src/index.ts').RecordBase & Record<string, unknown>; credential?: { principalId: string; clientId: string; clientSecret: string } } {
    const attrs = {
      ownerName: input.ownerName,
      ...(input.attrs ?? {}),
    }
    this.assertModelInCatalog(attrs['model'])
    const agent = this.ctx.resourceCore.create('agent', { ...input, attrs })
    // R7 组织化：managerId 环校验。id 由 create 内部生成、创建前无从自指，故创建后校验、
    // 失败即回滚（此刻尚未颁发凭证、未发注册事件，直接从集合移除即干净回滚）。
    if (String(attrs['managerId'] ?? '').trim()) {
      try {
        this.assertOrgChartAcyclic(agent.id, String(attrs['managerId']))
      } catch (error) {
        this.ctx.resourceCore.collection('agent').remove(agent.id)
        throw error
      }
    }
    let credential
    if (input.withCredential !== false) {
      // usage.write：Agent 绕过平台网关直连外部资源时须自推计量（POST /api/usage/record）
      credential = this.ctx.authn.createMachineCredential({
        name: `agent:${(agent as any).slug}`,
        refType: 'agent',
        refId: agent.id,
      // connector.invoke：连接器纳管（open-connector 融合）与 mcp.invoke 同级的独立调用权限点
      // agent.write：注册后凭自身凭证即可完成接入验证后的资料提报更新（PATCH /api/agents/:id）
      // modelgw.invoke：模型网关调用（LLM 是 Agent 的第一消耗品；计量经 usage.recorded 回灌本台账）
      // exec.read/exec.write：执行中枢 exec_* 工具（R10 心跳唤醒/待办拉取；目录条目由 apply() 启动期补录）
      // agent.a2a.invoke：A2A 协作调用（跨员工派活/续答/取消）。OBO 令牌 scope = 人类 ∩ 本凭证，
      //   此前凭证缺此点导致「人类无法以代表身份发起协作」（E-2/Q-6），故入默认凭证范围。
      scopes: ['mcp.invoke', 'skill.read', 'agent.read', 'agent.write', 'agent.a2a.invoke', 'usage.write', 'connector.invoke', 'modelgw.invoke', 'exec.read', 'exec.write'],
      })
    }
    this.ctx.platformBus.emit(PlatformEvents.AgentRegistered, {
      id: agent.id, name: agent.name, slug: agent.slug, actor: input.ownerId, type: 'agent',
    })
    return { agent, credential }
  }

  machinePrincipal(agentId: string) {
    return this.ctx.authn.principals().findOne((item) => item.refType === 'agent' && item.refId === agentId)
  }

  /**
   * 生成 Agent 接入提示词（注册同款模板，平台侧单一事实源，与 app 同构）：
   * rotate=true 轮换机器凭证 secret（旧值立即失效）并随提示词返回；rotate=false 仅含 client_id。
   */
  buildOnboardingPrompt(agentId: string, origin: string, opts: { rotate?: boolean } = {}): {
    agentName: string
    prompt: string
    credential: AgentOnboardingCredential
    rotated: boolean
  } {
    const agent = this.ctx.resourceCore.get('agent', agentId)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id: agentId }))
    const principal = this.machinePrincipal(agentId)
    if (!principal) throw new Error(t('Agent 机器凭证不存在（可能已被禁用或删除），无法生成接入提示词'))
    let credential: AgentOnboardingCredential
    let rotated = false
    if (opts.rotate) {
      const next = this.ctx.authn.rotateMachineCredential(principal.id)
      credential = { clientId: next.principal.clientId, clientSecret: next.clientSecret }
      rotated = true
    } else {
      credential = { clientId: principal.clientId }
    }
    return { agentName: agent.name, prompt: buildAgentOnboardingPrompt(agent, credential, origin), credential, rotated }
  }

  /** 用户绑定：记录"哪些用户可使用该 Agent"，使用即授权留痕。 */
  bindUser(agentId: string, userId: string, actor: string): AgentBindingRecord {
    const agent = this.ctx.resourceCore.get('agent', agentId)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id: agentId }))
    const user = this.ctx.iam.users().get(userId)
    if (!user) throw new Error(t('用户不存在：{id}', { id: userId }))
    if (this.bindings().findOne((item) => item.agentId === agentId && item.userId === userId)) {
      throw new Error(t('{name} 已绑定该 Agent', { name: user.displayName }))
    }
    return this.bindings().insert({
      id: newId('agb'),
      agentId,
      userId,
      userName: user.displayName,
      boundAt: new Date().toISOString(),
      boundBy: actor,
    })
  }

  unbindUser(agentId: string, userId: string): boolean {
    const binding = this.bindings().findOne((item) => item.agentId === agentId && item.userId === userId)
    if (!binding) return false
    return this.bindings().remove(binding.id)
  }

  boundUsers(agentId: string): AgentBindingRecord[] {
    return this.bindings().find((item) => item.agentId === agentId)
  }

  /** on-behalf-of：用户通过 Agent 行事时签发身份透传令牌。 */
  issueOnBehalfOfToken(agentId: string, verifiedUser: import('../../plugin-authn/src/index.ts').VerifiedPrincipal): { token: string; actChain: unknown[] } {
    const principal = this.machinePrincipal(agentId)
    if (!principal) throw new Error(t('该 Agent 尚未注册机器身份，请先在注册时勾选颁发凭证'))
    const { token, record } = this.ctx.authn.issueOnBehalfOf(verifiedUser, principal.id)
    return { token, actChain: record.actChain }
  }

  // -- SSO 客户端（Agent ↔ 平台身份源打通；owner 自助签发，dev-plan-agent-host-unification M2） --

  /**
   * 上线门禁模式（AGENT_SSO_ENFORCE）：
   *   '1'（默认）= 未纳管拒审——须有关联 OIDC 客户端、登记 entryUrl 免登通道，或声明 headless（纯后台，须已颁发机器凭证）；
   *   'oidc'    = 必须签发关联 OIDC 客户端（最严，headless 声明不适用）；
   *   '0'       = 关闭门禁（仅建议开发环境）。
   */
  static ssoEnforceMode(): '1' | 'oidc' | '0' {
    const raw = String(process.env.AGENT_SSO_ENFORCE ?? '1').trim().toLowerCase()
    if (raw === 'oidc') return 'oidc'
    if (raw === '0' || raw === '' || raw === 'false' || raw === 'off') return '0'
    return '1'
  }

  /**
   * owner-based 授权（对齐 app 侧）+ 机器环回自助例外：口径统一在 AppRegistryService.ssoManageDecision
   * （human = owner / authn.oidc.write；机器绑定本 Agent 时可自助，但回调集须全为环回）。
   * 控制台路由层已先行调用同口径守卫并 403，此处服务层兜底防绕行。
   */
  assertSsoManage(
    agent: { id: string; name: string; ownerId: string },
    caller: AppRegistryServiceSsoCaller,
    effective?: { redirectUris: string[]; postLogoutUris: string[] },
    op: 'create' | 'update' | 'rotate' | 'enable' | 'disable' = 'update',
  ): void {
    const decision = AppRegistryService.ssoManageDecision(agent, caller, effective ?? { redirectUris: [], postLogoutUris: [] }, op)
    if (!decision.allowed) throw new Error(decision.reason)
  }

  activeSsoClient(agentId: string) {
    return this.ctx.oidc.clientsForAgent(agentId).find((client) => OidcService.isClientActive(client))
  }

  /** 签发 Agent 关联 OIDC 客户端（name=Agent 名，回填 refType='agent'/refId）；secret 仅本次返回。 */
  createSsoClient(agentId: string, input: {
    redirectUris: string[]
    clientType?: 'confidential' | 'public'
    consentRequired?: boolean
    postLogoutUris?: string[]
    description?: string
  }): { client: ReturnType<OidcService['clientsForAgent']>[number]; clientSecret: string } {
    const agent = this.ctx.resourceCore.get('agent', agentId)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id: agentId }))
    AppRegistryService.assertRedirectUris(input.redirectUris)
    const existing = this.ctx.oidc.clientsForAgent(agentId)
    if (existing.length > 0) throw new Error(t('该 Agent 已签发 SSO 客户端（{clientId}），请直接管理或先禁用后重新签发', { clientId: existing[0]!.clientId }))
    const created = this.ctx.oidc.createClient({
      name: agent.name,
      redirectUris: input.redirectUris,
      ...(input.clientType !== undefined ? { clientType: input.clientType } : {}),
      ...(input.consentRequired !== undefined ? { consentRequired: input.consentRequired } : {}),
      ...(input.postLogoutUris !== undefined ? { postLogoutUris: input.postLogoutUris } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      refType: 'agent',
      refId: agentId,
    })
    return created
  }

  updateSsoClient(agentId: string, patch: { redirectUris?: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[] }) {
    if (patch.redirectUris !== undefined) AppRegistryService.assertRedirectUris(patch.redirectUris)
    return this.ctx.oidc.updateClient(this.requireSsoClient(agentId).id, patch)
  }

  rotateSsoSecret(agentId: string) {
    return this.ctx.oidc.rotateSecret(this.requireSsoClient(agentId).id)
  }

  disableSsoClient(agentId: string, reason: string) {
    return this.ctx.oidc.disableClient(this.requireSsoClient(agentId).id, reason)
  }

  enableSsoClient(agentId: string) {
    return this.ctx.oidc.enableClient(this.requireSsoClient(agentId).id)
  }

  private requireSsoClient(agentId: string) {
    const clients = this.ctx.oidc.clientsForAgent(agentId)
    if (clients.length === 0) throw new Error(t('该 Agent 尚未签发 SSO 客户端'))
    return clients[0]!
  }

  // -- 生命周期（L4 审批流）----------------------------------------------

  /**
   * SSO 门禁校验（上线前身份纳管）：返回 active 客户端 clientId（供审批单快照），违规抛错并指路。
   * 入口点（requestOnline 挂单时）+ 执行点（审批执行器）双重复核，对齐 app 侧门禁语义。
   */
  assertOnlineGate(agent: { id: string; name: string; attrs: Record<string, unknown> }): string | undefined {
    const mode = AgentRegistryService.ssoEnforceMode()
    if (mode === '0') return this.activeSsoClient(agent.id)?.clientId
    const active = this.activeSsoClient(agent.id)
    if (active) return active.clientId
    if (mode === 'oidc') {
      throw new Error(t('上线门禁：Agent 上线前必须完成身份纳管——请在「Agent 本体 → 详情 → SSO 配置」签发 OIDC 客户端（当前 AGENT_SSO_ENFORCE=oidc）'))
    }
    const entryUrl = String(agent.attrs['entryUrl'] ?? '').trim()
    if (entryUrl) return undefined
    // headless 第三纳管通道：Work Body 等纯后台执行体既无交互界面（no entryUrl 可登记）、
    // 也无需浏览器回调（no OIDC 授权码流程）——显式声明后凭已颁发的机器身份凭证放行。
    // 凭证即身份锚点：未颁发凭证的 headless 声明放行等于无主体上线，故一并拦截。
    if (agent.attrs['headless'] === true) {
      if (!this.machinePrincipal(agent.id)) {
        throw new Error(t('上线门禁：headless（无交互界面）声明要求 Agent 已颁发机器身份凭证（当前未颁发）——请先颁发凭证再重试'))
      }
      return undefined
    }
    throw new Error(t('上线门禁：Agent 上线前必须完成身份纳管——签发 OIDC 客户端、登记交互界面地址 entryUrl（免登通道），或声明无交互界面（headless，纯后台执行）后重试'))
  }

  requestOnline(agentId: string, requester: { id: string; name: string }) {
    const agent = this.ctx.resourceCore.get('agent', agentId)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id: agentId }))
    const errors = this.ctx.resourceCore.validateAttrs('agent', agent.attrs, 'online')
    if (errors.length > 0) throw new Error(t('上线条件不满足：{errors}', { errors: errors.join('；') }))
    // 上线门禁：底层模型必须是模型目录已登记的 slug（issue #8——「上线成功、派发才报模型不存在」在此拦截）
    this.assertModelInCatalog(agent.attrs['model'])
    const ssoClientId = this.assertOnlineGate(agent)
    return this.ctx.audit.createApproval({
      kind: 'agent.online',
      // WP-10/L1：L4 高危操作统一高风险——通过需二次确认，通过即落公司级终审标记
      riskLevel: 'high',
      title: t('Agent 上线：{name}', { name: agent.name }),
      payload: { agentId, requesterId: requester.id, ...(ssoClientId ? { ssoClientId } : {}) },
      requesterId: requester.id,
      requesterName: requester.name,
    })
  }

  requestOffline(agentId: string, requester: { id: string; name: string }, reason: string) {
    const agent = this.ctx.resourceCore.get('agent', agentId)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id: agentId }))
    if (!reason?.trim()) throw new Error(t('下线必须填写原因（护栏要求）'))
    // REL-02：开单前状态预检（与 requestOnline 的 validateAttrs 同风格的入口护栏，口径直接读生命周期状态机）：
    // 只有状态机允许流转到 offline 的状态（trial/online）才可开下线审批单，否则批准后执行器必然失败、
    // 凭证吊销联动也不生效（白挂 L4 单）。执行期 transition 复核保留（双保险不动）。
    const canOffline = this.ctx.resourceCore.availableTransitions('agent', agentId).some((item) => item.action === 'offline')
    if (!canOffline) {
      const stateLabel = this.ctx.resourceCore.stateLabel('agent', agent.status).label
      throw new Error(t('当前状态「{state}」不允许申请「下线」审批：仅试运行/已上线的 Agent 可开下线审批单（REL-02 预检）', { state: stateLabel }))
    }
    const impact = this.ctx.resourceCore.impact('agent', agentId)
    return this.ctx.audit.createApproval({
      kind: 'agent.offline',
      // WP-10/L1：L4 高危操作统一高风险——通过需二次确认，通过即落公司级终审标记
      riskLevel: 'high',
      title: t('Agent 下线：{name}', { name: agent.name }),
      payload: { agentId, reason, impact: impact.map((item) => `${item.name}（${item.type}）`) },
      requesterId: requester.id,
      requesterName: requester.name,
    })
  }

  online(agentId: string, actor: string) {
    const result = this.ctx.resourceCore.transition('agent', agentId, 'online', actor)
    this.ctx.platformBus.emit(PlatformEvents.AgentOnlined, { id: agentId, name: result.entity.name, actor, type: 'agent', slug: result.entity.slug })
    return result.entity
  }

  offline(agentId: string, actor: string, reason: string) {
    const result = this.ctx.resourceCore.transition('agent', agentId, 'offline', actor, reason)
    this.ctx.platformBus.emit(PlatformEvents.AgentOfflined, { id: agentId, name: result.entity.name, actor, reason, type: 'agent', slug: result.entity.slug })
    // 下线联动：吊销机器凭证（authn 事件监听执行）、通知绑定用户
    const principal = this.machinePrincipal(agentId)
    if (principal) this.ctx.authn.disablePrincipal(principal.id, 'Agent 下线联动')
    for (const binding of this.boundUsers(agentId)) {
      this.ctx.audit.fire({
        severity: 'info',
        title: t('你绑定的 Agent「{name}」已下线', { name: result.entity.name }),
        message: t('绑定关系保留，恢复上线后可继续使用。原因：{reason}', { reason }),
        resourceType: 'agent',
        resourceId: agentId,
      })
      void binding
    }
    return result.entity
  }

  archive(agentId: string, actor: string) {
    return this.ctx.resourceCore.transition('agent', agentId, 'archive', actor).entity
  }

  trial(agentId: string, actor: string, groups: string[]) {
    void groups
    return this.ctx.resourceCore.transition('agent', agentId, 'submit_trial', actor).entity
  }

  /** 删除后的关联清理：用户绑定、依赖边与机器凭证（禁用即吊销全部令牌）；用量记录与审计数据保留。 */
  purge(agentId: string): void {
    for (const binding of this.bindings().find((item) => item.agentId === agentId)) this.bindings().remove(binding.id)
    for (const record of this.ctx.resourceCore.dependencies().find((item) => item.fromId === agentId || item.toId === agentId)) {
      this.ctx.resourceCore.dependencies().remove(record.id)
    }
    const principal = this.machinePrincipal(agentId)
    if (principal && principal.status === 'active') this.ctx.authn.disablePrincipal(principal.id, 'Agent 删除联动')
  }

  // -- 冻结（R10：执行中枢预算联动）---------------------------------------

  /** 冻结态查询：attrs.frozenAt 非空即冻结（执行中枢调度入口与预算联动共用判据）。 */
  isFrozen(agentId: string): boolean {
    return Boolean(this.ctx.resourceCore.collection('agent').get(agentId)?.attrs['frozenAt'])
  }

  /**
   * 冻结 Agent（预算超限联动）：attrs 层软态——不动生命周期状态、不吊销凭证；
   * 设 frozenAt/frozenReason、落审计、广播 agent.frozen，并创建 agent.unfreeze 高危审批单
   * （人工解冻通道），返回审批单 id。幂等保护：已冻结抛错（重复冻结往往意味着联动重复触发，
   * 应显式失败而非静默覆盖既有冻结原因）。
   * 注意：frozenAt/frozenReason 不在 schema 字段表内（不给控制台表单编辑），故直写集合——
   * resourceCore.update 只合并 schema 字段，但以整 attrs 为基底，后续 PATCH 会保留这两个软态键。
   */
  freezeAgent(agentId: string, reason: string, actor?: string): string {
    const collection = this.ctx.resourceCore.collection('agent')
    const agent = collection.get(agentId)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id: agentId }))
    if (agent.attrs['frozenAt']) {
      const frozenReason = agent.attrs['frozenReason'] !== undefined ? String(agent.attrs['frozenReason']) : t('原因未登记')
      throw new Error(t('Agent「{name}」已冻结（{reason}），请走解冻审批单解冻', { name: agent.name, reason: frozenReason }))
    }
    collection.update(agentId, { attrs: { ...agent.attrs, frozenAt: new Date().toISOString(), frozenReason: reason } })
    this.ctx.audit.record({
      type: 'change', actorType: 'system', actorId: actor ?? 'exec-hub', actorName: '执行中枢（预算联动）',
      action: 'agent.frozen', resourceType: 'agent', resourceId: agentId, resourceName: agent.name,
      result: 'ok', detail: reason,
    })
    // 事件名平台侧会登记，直接字符串 emit（与 audit.authz.denied 同风格）
    this.ctx.platformBus.emit('agent.frozen', { agentId, reason, actor })
    const approval = this.ctx.audit.createApproval({
      kind: 'agent.unfreeze',
      title: t('Agent「{name}」预算超限冻结，申请解冻', { name: agent.name }),
      // 预算熔断属高危治理动作，解冻同样按 L4 高危口径（approve 需二次确认）
      riskLevel: 'high',
      payload: { agentId, reason },
      requesterId: actor ?? 'exec-hub',
      requesterName: t('执行中枢（预算联动，系统发起）'),
    })
    return approval.id
  }

  /** 解冻 Agent：清空 frozenAt/frozenReason，落审计并广播 agent.unfrozen。 */
  unfreezeAgent(agentId: string, by?: string): void {
    const collection = this.ctx.resourceCore.collection('agent')
    const agent = collection.get(agentId)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id: agentId }))
    const frozenReason = String(agent.attrs['frozenReason'] ?? '')
    const restAttrs: Record<string, unknown> = { ...agent.attrs }
    delete restAttrs['frozenAt']
    delete restAttrs['frozenReason']
    collection.update(agentId, { attrs: restAttrs })
    this.ctx.audit.record({
      type: 'change', actorType: 'system', actorId: by ?? 'approval-center', actorName: '解冻审批',
      action: 'agent.unfreeze', resourceType: 'agent', resourceId: agentId, resourceName: agent.name,
      result: 'ok', detail: frozenReason ? `解除预算超限冻结（冻结原因：${frozenReason}）` : '解除冻结',
    })
    this.ctx.platformBus.emit('agent.unfrozen', { agentId, by })
  }

  // -- 监测 -------------------------------------------------------------

  /** 归集/回灌入口：source=mcp（McpInvoked，带延迟）| gateway（usage.recorded 回灌，无延迟）。 */
  recordUsage(agentId: string, usage: { sessions?: number; calls: number; okCalls: number; tokens: number; latencyMs: number }, source: 'mcp' | 'gateway' = 'mcp'): void {
    const date = new Date().toISOString().slice(0, 10)
    const gwDelta = source === 'gateway' ? usage.calls : 0
    const existing = this.usage().findOne((item) => item.agentId === agentId && item.date === date)
    if (existing) {
      this.usage().update(existing.id, {
        sessions: existing.sessions + (usage.sessions ?? 0),
        calls: existing.calls + usage.calls,
        okCalls: existing.okCalls + usage.okCalls,
        tokens: existing.tokens + usage.tokens,
        totalLatencyMs: existing.totalLatencyMs + usage.latencyMs,
        gwCalls: (existing.gwCalls ?? 0) + gwDelta,
      })
    } else {
      this.usage().insert({
        id: newId('agu'),
        agentId,
        date,
        sessions: usage.sessions ?? 0,
        calls: usage.calls,
        okCalls: usage.okCalls,
        tokens: usage.tokens,
        totalLatencyMs: usage.latencyMs,
        gwCalls: gwDelta,
      })
    }
    if (usage.tokens > 0) {
      this.ctx.audit.addCost({
        date,
        agentId,
        llmTokens: usage.tokens,
        toolCalls: usage.calls,
        costYuan: Math.round(usage.tokens * 0.0000015 * 1000) / 1000,
      })
    }
  }

  /**
   * Agent 自主提报运营指标（REST /api/agents/:id/metrics-report、工具 agent_metrics_report 汇入）。
   * 接入义务（与 AI 应用 metrics-report 同级）：语义对齐——同日 dau 取最大、会话数累加、
   * 用户去重集取并集；userIds 平台侧即刻哈希脱敏后入库，不落明文；可指定 date 补录历史（YYYY-MM-DD）。
   */
  reportUsage(agentId: string, report: { dau?: number; sessions?: number; userIds?: string[]; uniqueUsers?: number; date?: string }): void {
    const agent = this.ctx.resourceCore.get('agent', agentId)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id: agentId }))
    const date = report.date ?? new Date().toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(t('date 格式非法：{date}（应为 YYYY-MM-DD）', { date }))
    for (const [key, value] of [['dau', report.dau], ['sessions', report.sessions], ['uniqueUsers', report.uniqueUsers]] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new Error(t('{key} 必须是非负整数（收到：{value}）', { key, value }))
    }
    const hashes = (report.userIds ?? []).map((id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 16))
    if (report.uniqueUsers !== undefined && hashes.length > report.uniqueUsers) {
      throw new Error(t('userIds 数量（{count}）不应大于 uniqueUsers（{unique}）', { count: hashes.length, unique: report.uniqueUsers }))
    }
    const existing = this.usage().findOne((item) => item.agentId === agentId && item.date === date)
    let mergedSessions: number
    if (existing) {
      const merged = new Set([...(existing.userHashes ?? []), ...hashes])
      mergedSessions = existing.sessions + (report.sessions ?? 0)
      this.usage().update(existing.id, {
        dau: Math.max(existing.dau ?? 0, report.dau ?? 0, merged.size),
        sessions: mergedSessions,
        ...(merged.size > 0 ? { userHashes: [...merged] } : {}),
      })
    } else {
      mergedSessions = report.sessions ?? 0
      this.usage().insert({
        id: newId('agu'),
        agentId,
        date,
        sessions: mergedSessions,
        calls: 0,
        okCalls: 0,
        tokens: 0,
        totalLatencyMs: 0,
        dau: Math.max(report.dau ?? 0, hashes.length),
        ...(hashes.length > 0 ? { userHashes: hashes } : {}),
      })
    }
    // R10 计量入账：合并落库后把当日 sessions 计入 usage 预算窗口（agent:<slug> 资源行）
    this.meterDailySessions(agent, date, mergedSessions)
  }

  /**
   * R10 计量入账（metrics-report 专用）：把「合并后当日 sessions」登记为 usage 事件，
   * 供 /api/usage/summary 的 byResource 出现 agent:<slug> 行、执行中枢预算联动据此熔断。
   * - 价格簿行为结论：无匹配规则时 priceOf 直接抛错（资源 X 无计价规则），且默认 agent:* 前缀
   *   规则的计价键是 calls（WP-07 反馈回传口径），与本处 sessions 不同——故首次入账前按
   *   「精确 pattern 优先于前缀」为该 Agent 播种一条零成本 sessions 规则（只补缺不覆盖，
   *   防冲掉运营对精确条目的调价），保证提报永不因价格缺失失败；
   * - 幂等：idempotency_key=agent-metrics:<agentId>:<date>，usage.record 走 insertOrIgnore，
   *   但同键不同内容会被拒绝——故先探同键事件，同日补报只计首次快照（跳过后续入账）；
   * - org 缺失（usage 事件 org 必填）跳过入账；其余意外失败只告警不阻塞提报主流程
   *   （计量面是观测属性，与 panel/skillhub 的「计量失败不阻塞」先例一致）。
   */
  private meterDailySessions(agent: { id: string; slug: string; orgId: string }, date: string, sessions: number): void {
    try {
      const idempotencyKey = `agent-metrics:${agent.id}:${date}`
      // 同日已入账（首次快照口径）：本地台账仍照常合并，usage 事件不重复计
      if (this.ctx.txnStore.one('usage_events', { idempotency_key: idempotencyKey })) return
      if (!agent.orgId) return // usage 事件 org 必填，缺 org 时放弃入账（不阻塞提报）
      const pattern = `agent:${agent.slug}`
      if (!this.ctx.usage.priceBook().findOne((item) => item.pattern === pattern)) {
        this.ctx.usage.upsertPrice({
          pattern, meter_key: 'sessions',
          list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1,
          tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.10',
        })
      }
      this.ctx.usage.record({
        org: agent.orgId,
        subject: `agent:${agent.id}`,
        principal: `org:${agent.orgId}`,
        resource: pattern,
        meters: [{ key: 'sessions', value: sessions, unit: '次' }],
        idempotency_key: idempotencyKey,
      })
    } catch (error) {
      this.ctx.logger('agent').warn('metrics-report 用量入账失败（不阻塞提报主流程）', error)
    }
  }

  metrics(agentId: string): {
    sessions: number
    calls: number
    successRate: number
    tokens: number
    avgLatencyMs: number
    lastActiveAt: string
    dau: number
    uniqueUsers: number
    gwCalls: number
    series: Array<{ date: string; calls: number; tokens: number; sessions: number; dau: number }>
  } {
    const rows = this.usage().find((item) => item.agentId === agentId).sort((a, b) => a.date.localeCompare(b.date))
    const today = rows.at(-1)
    const calls = rows.reduce((sum, row) => sum + row.calls, 0)
    const okCalls = rows.reduce((sum, row) => sum + row.okCalls, 0)
    const tokens = rows.reduce((sum, row) => sum + row.tokens, 0)
    const latency = rows.reduce((sum, row) => sum + row.totalLatencyMs, 0)
    const gwCalls = rows.reduce((sum, row) => sum + (row.gwCalls ?? 0), 0)
    // 均值分母只取带延迟数据的调用（MCP 网关口径）：网关回灌事件无延迟，摊薄会失真
    const latencyCalls = Math.max(calls - gwCalls, 0)
    return {
      sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
      calls,
      successRate: calls === 0 ? 1 : Math.round((okCalls / calls) * 1000) / 1000,
      tokens,
      avgLatencyMs: latencyCalls === 0 ? 0 : Math.round(latency / latencyCalls),
      lastActiveAt: rows.at(-1)?.updatedAt ?? '',
      // 运营口径（提报）：今日 DAU 与今日对话用户去重数
      dau: today?.dau ?? 0,
      uniqueUsers: today?.userHashes?.length ?? 0,
      gwCalls,
      series: rows.slice(-14).map((row) => ({ date: row.date, calls: row.calls, tokens: row.tokens, sessions: row.sessions, dau: row.dau ?? 0 })),
    }
  }

  overview(): { total: number; online: number; trial: number; draft: number; offline: number } {
    const agents = this.ctx.resourceCore.list('agent')
    return {
      total: agents.length,
      online: agents.filter((item) => item.status === 'online').length,
      trial: agents.filter((item) => item.status === 'trial').length,
      draft: agents.filter((item) => item.status === 'draft').length,
      offline: agents.filter((item) => ['offline', 'archived'].includes(item.status)).length,
    }
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRegistry: AgentRegistryService
  }
}

export const name = 'agent'
export const inject = ['opsStorage', 'platformBus', 'resourceCore', 'authn', 'oidc', 'iam', 'audit', 'usage', 'httpServer']

export function apply(ctx: Context) {
  const registry = new AgentRegistryService(ctx)
  ctx.plugin(agentTools)
  // REL-05 守卫：onboarding-prompt 的 rotate=true 会立即作废旧机器凭证 secret 并一次性明文返回新
  // secret——与同插件 obo-token（QA A-07）同口径收敛：仅 owner / 绑定用户 / 平台管理员（'*'）可轮换；
  // 另允许该 Agent 自身机器凭证自助轮换（与 ssoManage「机器绑定本 Agent 可自助」同哲学，既有接入
  // 流程依赖）。路由处理器在 console（非本插件所有权），故在本插件内以 httpServer 中间件在 HTTP
  // 边界单点拦截；rotate=false（仅取 client_id）不受影响，令牌校验失败交由 console 鉴权中间件统一 401。
  ctx.httpServer.use((exchange) => {
    if (exchange.method !== 'POST' || !/^\/api\/agents\/[^/]+\/onboarding-prompt$/.test(exchange.path)) return
    if ((exchange.body ?? {}).rotate !== true) return
    const agentId = exchange.path.split('/')[3]!
    const agent = ctx.resourceCore.get('agent', agentId)
    if (!agent) return // Agent 不存在由原路由处理器报错，此处不干预
    let verified: import('../../plugin-authn/src/index.ts').VerifiedPrincipal
    try {
      const header = String(exchange.headers['authorization'] ?? '')
      verified = ctx.authn.verify(header.startsWith('Bearer ') ? header.slice(7) : header)
    } catch {
      return
    }
    const userId = verified.principal.type === 'human' ? verified.principal.refId : undefined
    const isOwner = userId !== undefined && agent.ownerId === userId
    const isBound = userId !== undefined && registry.boundUsers(agentId).some((item) => item.userId === userId)
    const isAdmin = verified.scopes.includes('*')
    const isSelfMachine = verified.principal.type === 'machine'
      && verified.principal.refType === 'agent' && verified.principal.refId === agentId
    if (isOwner || isBound || isAdmin || isSelfMachine) return
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: userId ?? verified.principal.id,
      actorName: verified.principal.name,
      point: `agent.onboarding-rotate(owner:${agentId})`,
      path: exchange.path,
    })
    exchange.fail(403, 'FORBIDDEN', t('仅 Agent 负责人、绑定用户或平台管理员可轮换「{name}」的机器凭证 secret（对齐 obo-token 守卫口径，REL-05）', { name: agent.name }))
    return true
  })
  // R7 组织化环校验挂载点决策：console 的 PATCH /api/agents/:id 直接调 resourceCore.update('agent')
  // 绕过本插件服务层（resourceCore 对 update 不发平台事件，Collection.onChange 的监听器异常也
  // 只会被吞掉、无法让请求失败），故沿用上方 REL-05 的做法——在 HTTP 边界以中间件单点拦截：
  // 仅当本次 PATCH 的 attrs 含 managerId 时，按 update() 的合并语义（该字段以本次提交值为准）
  // 预演环校验，违规 400；其余 PATCH（不含 managerId）原样放行，不触碰既有行为。
  ctx.httpServer.use((exchange) => {
    if (exchange.method !== 'PATCH' || !/^\/api\/agents\/[^/]+$/.test(exchange.path)) return
    const patchAttrs = ((exchange.body ?? {}) as { attrs?: Record<string, unknown> }).attrs
    if (!patchAttrs || patchAttrs['managerId'] === undefined) return
    const agentId = exchange.path.split('/')[3]!
    if (!ctx.resourceCore.get('agent', agentId)) return // Agent 不存在由原路由处理器报错，此处不干预
    try {
      registry.assertOrgChartAcyclic(agentId, String(patchAttrs['managerId'] ?? ''))
    } catch (error) {
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
      return true
    }
  })
  // L4 审批执行器（闭包直持实例，避免插件注入自身服务的循环等待）
  ctx.effect(() => ctx.audit.registerExecutor('agent.online', async (payload) => {
    // 上线门禁执行期复核：审批挂单期间 SSO 客户端可能被禁用/entryUrl 可能被清——
    // 重跑完整门禁，失效则执行失败留痕（对齐 app 侧点 2 兜底语义）
    const agent = ctx.resourceCore.get('agent', String(payload.agentId))
    if (agent) registry.assertOnlineGate(agent)
    return registry.online(String(payload.agentId), 'approval-center')
  }))
  ctx.effect(() => ctx.audit.registerExecutor('agent.offline', async (payload) => {
    return registry.offline(String(payload.agentId), 'approval-center', String(payload.reason ?? '审批通过下线'))
  }))
  // R10：解冻审批执行器——agent.unfreeze 高危单通过后清冻结态（approve 即解冻，approverId 入审计）
  ctx.effect(() => ctx.audit.registerExecutor('agent.unfreeze', async (payload, approverId) => {
    registry.unfreezeAgent(String(payload.agentId ?? ''), approverId || 'approval-center')
    return { unfrozen: true }
  }))
  // R10：执行中枢权限点补录——默认机器凭证要带 exec.read/exec.write，而 plugin-authn 的
  // createMachineCredential 按权限目录白名单校验 scopes（防拼错），目录缺这两点会导致注册 Agent
  // 直接失败。本插件无权改 iam 文件，故启动期向 iam 的 PermissionCatalog（运行时 RBAC 注册权威，
  // 控制台角色编辑器同源读取）幂等补两条；iam 先于本插件加载，数组实例同一。
  for (const entry of [
    { point: 'exec.read', label: '读取执行中枢待办与心跳', group: '执行中枢' },
    { point: 'exec.write', label: '执行中枢待办领取与回写', group: '执行中枢' },
  ]) {
    if (!PermissionCatalog.some((item) => item.point === entry.point)) PermissionCatalog.push(entry)
  }
  migrateAgentCredentialScopes(ctx)
  migrateAgentCredentialConnectorInvoke(ctx)
  migrateAgentCredentialAgentWrite(ctx)
  migrateAgentCredentialModelgwInvoke(ctx)
  migrateAgentCredentialExecScopes(ctx)
  migrateAgentCredentialA2aInvoke(ctx)
}

/** 一次性迁移：为存量 Agent 机器凭证补 agent.a2a.invoke（OBO 协作调用面；先例 agent-scopes-exec-rw-v1）。 */
function migrateAgentCredentialA2aInvoke(ctx: Context): void {
  const markers = ctx.opsStorage.collection<{ id: string; doneAt: string }>('agent:migrations')
  const MARK = 'agent-scopes-a2a-invoke-v1'
  if (markers.get(MARK)) return
  let patched = 0
  for (const principal of ctx.authn.principals().find(
    (item) => item.type === 'machine' && item.refType === 'agent' && item.status === 'active' && !item.scopes.includes('agent.a2a.invoke'),
  )) {
    ctx.authn.principals().update(principal.id, { scopes: [...principal.scopes, 'agent.a2a.invoke'] })
    ctx.audit.record({
      type: 'change', actorType: 'system', actorId: 'agent-migration', actorName: '凭证范围迁移',
      action: 'agent.credential.a2a-invoke-backfill', resourceType: 'agent',
      resourceId: principal.refId ?? '', resourceName: principal.name, result: 'ok',
      detail: '补入 agent.a2a.invoke（OBO 令牌 scope=人类∩凭证；缺此点则人类无法代表员工发起 A2A 协作）',
    })
    patched++
  }
  markers.insert({ id: MARK, doneAt: new Date().toISOString() })
  if (patched > 0) ctx.logger('agent').info(`存量 Agent 凭证迁移完成：${patched} 条补入 agent.a2a.invoke`)
}

/** 一次性迁移：为存量 Agent 机器凭证补 connector.invoke（幂等标记，先例 agent-scopes-usage-write-v1）。 */
function migrateAgentCredentialConnectorInvoke(ctx: Context): void {
  const markers = ctx.opsStorage.collection<{ id: string; doneAt: string }>('agent:migrations')
  const MARK = 'agent-scopes-connector-invoke-v1'
  if (markers.get(MARK)) return
  let patched = 0
  for (const principal of ctx.authn.principals().find(
    (item) => item.type === 'machine' && item.refType === 'agent' && item.status === 'active' && !item.scopes.includes('connector.invoke'),
  )) {
    ctx.authn.principals().update(principal.id, { scopes: [...principal.scopes, 'connector.invoke'] })
    ctx.audit.record({
      type: 'change', actorType: 'system', actorId: 'agent-migration', actorName: '凭证范围迁移',
      action: 'agent.credential.connector-invoke-backfill', resourceType: 'agent',
      resourceId: principal.refId ?? '', resourceName: principal.name, result: 'ok',
      detail: '补入 connector.invoke（连接器纳管数据面对齐）',
    })
    patched++
  }
  markers.insert({ id: MARK, doneAt: new Date().toISOString() })
  if (patched > 0) ctx.logger('agent').info(`存量 Agent 凭证迁移完成：${patched} 条补入 connector.invoke`)
}

/** 一次性迁移：为存量 Agent 机器凭证补 usage.write（幂等标记，防止覆盖后续人工调整的 scopes）。 */
function migrateAgentCredentialScopes(ctx: Context): void {
  const markers = ctx.opsStorage.collection<{ id: string; doneAt: string }>('agent:migrations')
  const MARK = 'agent-scopes-usage-write-v1'
  if (markers.get(MARK)) return
  let patched = 0
  for (const principal of ctx.authn.principals().find(
    (item) => item.type === 'machine' && item.refType === 'agent' && item.status === 'active' && !item.scopes.includes('usage.write'),
  )) {
    ctx.authn.principals().update(principal.id, { scopes: [...principal.scopes, 'usage.write'] })
    ctx.audit.record({
      type: 'change', actorType: 'system', actorId: 'agent-migration', actorName: '凭证范围迁移',
      action: 'agent.credential.scopes-backfill', resourceType: 'agent',
      resourceId: principal.refId ?? '', resourceName: principal.name, result: 'ok',
      detail: '补入 usage.write（Agent 自推计量能力对齐）',
    })
    patched++
  }
  markers.insert({ id: MARK, doneAt: new Date().toISOString() })
  if (patched > 0) ctx.logger('agent').info(`存量 Agent 凭证迁移完成：${patched} 条补入 usage.write`)
}

/** 一次性迁移：为存量 Agent 机器凭证补 agent.write（注册后可凭自身凭证提报更新资料，先例 agent-scopes-usage-write-v1）。 */
function migrateAgentCredentialAgentWrite(ctx: Context): void {
  const markers = ctx.opsStorage.collection<{ id: string; doneAt: string }>('agent:migrations')
  const MARK = 'agent-scopes-agent-write-v1'
  if (markers.get(MARK)) return
  let patched = 0
  for (const principal of ctx.authn.principals().find(
    (item) => item.type === 'machine' && item.refType === 'agent' && item.status === 'active' && !item.scopes.includes('agent.write'),
  )) {
    ctx.authn.principals().update(principal.id, { scopes: [...principal.scopes, 'agent.write'] })
    ctx.audit.record({
      type: 'change', actorType: 'system', actorId: 'agent-migration', actorName: '凭证范围迁移',
      action: 'agent.credential.agent-write-backfill', resourceType: 'agent',
      resourceId: principal.refId ?? '', resourceName: principal.name, result: 'ok',
      detail: '补入 agent.write（注册后自主提报更新能力对齐）',
    })
    patched++
  }
  markers.insert({ id: MARK, doneAt: new Date().toISOString() })
  if (patched > 0) ctx.logger('agent').info(`存量 Agent 凭证迁移完成：${patched} 条补入 agent.write`)
}

/** 一次性迁移：为存量 Agent 机器凭证补 modelgw.invoke（先例 agent-scopes-connector-invoke-v1）。 */
function migrateAgentCredentialModelgwInvoke(ctx: Context): void {
  const markers = ctx.opsStorage.collection<{ id: string; doneAt: string }>('agent:migrations')
  const MARK = 'agent-scopes-modelgw-invoke-v1'
  if (markers.get(MARK)) return
  let patched = 0
  for (const principal of ctx.authn.principals().find(
    (item) => item.type === 'machine' && item.refType === 'agent' && item.status === 'active' && !item.scopes.includes('modelgw.invoke'),
  )) {
    ctx.authn.principals().update(principal.id, { scopes: [...principal.scopes, 'modelgw.invoke'] })
    ctx.audit.record({
      type: 'change', actorType: 'system', actorId: 'agent-migration', actorName: '凭证范围迁移',
      action: 'agent.credential.modelgw-invoke-backfill', resourceType: 'agent',
      resourceId: principal.refId ?? '', resourceName: principal.name, result: 'ok',
      detail: '补入 modelgw.invoke（模型网关调用 + usage.recorded 回灌口径补全）',
    })
    patched++
  }
  markers.insert({ id: MARK, doneAt: new Date().toISOString() })
  if (patched > 0) ctx.logger('agent').info(`存量 Agent 凭证迁移完成：${patched} 条补入 modelgw.invoke`)
}

/** 一次性迁移：为存量 Agent 机器凭证补 exec.read/exec.write（执行中枢 exec_* 工具所需，先例 agent-scopes-modelgw-invoke-v1）。 */
function migrateAgentCredentialExecScopes(ctx: Context): void {
  const markers = ctx.opsStorage.collection<{ id: string; doneAt: string }>('agent:migrations')
  const MARK = 'agent-scopes-exec-rw-v1'
  if (markers.get(MARK)) return
  let patched = 0
  for (const principal of ctx.authn.principals().find(
    (item) => item.type === 'machine' && item.refType === 'agent' && item.status === 'active'
      && !(item.scopes.includes('exec.read') && item.scopes.includes('exec.write')),
  )) {
    // 两点合并补齐（Set 去重：只缺其一时不会重复另一点）
    ctx.authn.principals().update(principal.id, { scopes: [...new Set([...principal.scopes, 'exec.read', 'exec.write'])] })
    ctx.audit.record({
      type: 'change', actorType: 'system', actorId: 'agent-migration', actorName: '凭证范围迁移',
      action: 'agent.credential.exec-rw-backfill', resourceType: 'agent',
      resourceId: principal.refId ?? '', resourceName: principal.name, result: 'ok',
      detail: '补入 exec.read/exec.write（执行中枢 exec_* 工具所需）',
    })
    patched++
  }
  markers.insert({ id: MARK, doneAt: new Date().toISOString() })
  if (patched > 0) ctx.logger('agent').info(`存量 Agent 凭证迁移完成：${patched} 条补入 exec.read/exec.write`)
}
