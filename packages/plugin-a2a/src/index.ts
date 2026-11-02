/**
 * @dsh-ops/plugin-a2a —— A2A 协作平面（企业数字员工内网协作方案 §5/§6）。
 *
 * 在 contract-c3 冻结 v1（点名直调 + 级别透出）之上升版的完整协作闭环：
 *   - Agent Card 生成/签名/发布（源自授权集投影，声明不大于授权；JWS Ed25519 验签）；
 *   - 跨运行时发现（平台内目录，补 contract-c3 缺席项 2）；
 *   - JSON-RPC 方法面（message/send·stream、tasks/get·list·cancel，八态 Task 生命周期）；
 *   - Task 受理前治理检查五项（权限点/在线与 permit 覆盖/密级天花板/预算配额/审批规则）；
 *   - A0-A3 协商策略引擎（补缺席项 3；A3×A3 要约-还价，补缺席项 4 的多方仲裁由 flow-core 承载）；
 *   - 声明-授权一致性巡检（能力漂移治理）；协作履约视图与交付验收闭环。
 *
 * 纪律（协作方案 §11）：
 *   - 与 plugin-uhp 只走 ctx.platformBus（a2a.task.dispatch / a2a.task.progress / a2a.task.cancel），
 *     禁止直连对方插件数据；
 *   - 存量 Agent 缺省口径兼容（无 a2aProfile 字段时退化为 v1 点名调用行为）；
 *   - 中断态是治理信号：input_required 由调用方携 taskId 续答；auth_required 必经审批中心人工闭环，
 *     恢复执行用幂等键防重（a2a:<agentId>:<principal>:<taskId>:a<attempt>）；
 *   - 验收不轻信自报：Task completed ≠ 业务闭环，关键任务经交付验收（人工）后才算履约通过。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  newId,
  createRestGate,
  PlatformEvents,
  normalizeAssetCategory,
  type Collection,
  type HttpExchange,
  type RecordBase,
} from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'
import { PermissionCatalog } from '../../plugin-iam/src/index.ts'
import type { VerifiedPrincipal } from '../../plugin-authn/src/index.ts'
import { DATA_CLASS_RANK, type DataClass } from '../../plugin-modelgw/src/index.ts'
import { nonbillableUsage } from '../../plugin-usage/src/index.ts'
import { generateEd25519KeyPair } from '../../platform-core/src/signature.ts'
import { createPublicKey } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { signAgentCard, type AgentCardBody, type AgentCardSkill, type SignedAgentCard } from './card.ts'
import {
  NEGOTIATION_MAX_ROUNDS,
  negotiateMode,
  normalizeAutonomy,
  parseNegotiationDecision,
  type Autonomy,
  type NegotiationMode,
} from './negotiate.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export type A2aTaskState =
  | 'submitted' | 'working' | 'input_required' | 'auth_required'
  | 'completed' | 'failed' | 'canceled' | 'rejected'

export const A2A_TERMINAL_STATES: A2aTaskState[] = ['completed', 'failed', 'canceled', 'rejected']

export interface A2aArtifact {
  artifactId: string
  name: string
  mimeType: string
  kind: 'text' | 'file'
  content?: string
  sizeBytes: number
}

export interface A2aHistoryEntry {
  at: string
  from: 'caller' | 'target' | 'system'
  type: 'message' | 'status' | 'offer'
  text?: string
  state?: A2aTaskState
  note?: string
}

export interface A2aOffer {
  round: number
  from: 'caller' | 'target'
  proposal: unknown
  note?: string
  at: string
}

export interface A2aTaskRecord extends RecordBase {
  taskId: string
  contextId: string
  agentId: string
  agentSlug: string
  callerPrincipalId: string
  callerUserId?: string
  callerAgentId?: string
  callerSubject: string
  callerAutonomy: Autonomy
  targetAutonomy: Autonomy
  mode: NegotiationMode
  state: A2aTaskState
  stateReason: string
  message: string
  dataClass: DataClass
  negotiation?: { round: number; maxRounds: number; status: 'open' | 'accepted' | 'rejected' | 'expired'; offers: A2aOffer[] }
  artifacts: A2aArtifact[]
  history: A2aHistoryEntry[]
  responseId?: string
  attempts: number
  inputTokens?: number
  outputTokens?: number
  model?: string
  approvalId?: string
  acceptance?: { status: 'accepted' | 'rejected'; by: string; at: string; reason: string }
  /** OBO 身份链（Q-6）：人类经 OBO 令牌代表该员工发起协作时，真实发起人随链透传进审计。 */
  onBehalfUser?: string
  actChain?: Array<{ principalId: string; name: string; type: string }>
  startedAt?: string
  finishedAt?: string
}

/** 敏感操作审批规则（治理检查第 5 项；命中则 auth_required 挂审批工单而非直接拒绝）。 */
export interface A2aRuleRecord extends RecordBase {
  name: string
  /** 任务密级 ≥ 该级则命中（internal/secret）。 */
  matchDataClassAtLeast?: 'internal' | 'secret'
  /** 任务消息包含该关键词则命中。 */
  matchKeyword?: string
  enabled: boolean
  createdBy: string
}

/** 声明-授权一致性巡检报告（能力漂移治理）。 */
export interface A2aPatrolRecord extends RecordBase {
  at: string
  actor: string
  checkedAgents: number
  driftAgents: number
  findings: Array<{ agentId: string; agentName: string; findings: string[] }>
}

interface CardKeyRecord extends RecordBase {
  keyId: string
  publicKeyBase64: string
  algorithm: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class A2aCollabService extends Service {
  static readonly provide = 'a2aCollab'

  constructor(ctx: Context) {
    super(ctx, 'a2aCollab')
    // UHP 执行进度 → 八态状态机推进（只走事件总线纪律）
    ctx.platformBus.on('a2a.task.progress', (payload) => {
      try {
        this.onProgress(payload as UhpProgressLike)
      } catch (error) {
        this.ctx.logger('a2a').error('a2a.task.progress 处理异常', error)
      }
    })
    // 审批驳回联动：a2a.task.authorize 工单被驳 → 任务终态 rejected（中断态治理闭环）
    ctx.platformBus.on(PlatformEvents.ApprovalDecided, (payload) => {
      const p = payload as { approvalId: string; approved: boolean }
      if (p.approved) return
      const approval = this.ctx.audit.approvals().get(p.approvalId)
      const taskId = String((approval?.payload as Record<string, unknown> | undefined)?.['taskId'] ?? '')
      if (!approval || approval.kind !== 'a2a.task.authorize' || !taskId) return
      const task = this.tasks().get(taskId)
      if (!task || task.state !== 'auth_required') return
      this.transition(task.taskId, 'rejected', t('授权审批被驳回（{approver}）', { approver: String((payload as { approverName?: string }).approverName ?? '审批人') }))
    })
  }

  // -- 集合 -----------------------------------------------------------------

  tasks(): Collection<A2aTaskRecord> {
    return this.ctx.opsStorage.collection<A2aTaskRecord>('a2a:tasks', { durability: 'durable' })
  }

  rules(): Collection<A2aRuleRecord> {
    return this.ctx.opsStorage.collection<A2aRuleRecord>('a2a:rules', { durability: 'durable' })
  }

  patrols(): Collection<A2aPatrolRecord> {
    return this.ctx.opsStorage.collection<A2aPatrolRecord>('a2a:patrols', { durability: 'durable' })
  }

  private cardKeys(): Collection<CardKeyRecord> {
    return this.ctx.opsStorage.collection<CardKeyRecord>('a2a:cardKeys', { durability: 'durable' })
  }

  // -- 卡片签名密钥（私钥只落盘 dataDir 0600，集合只存公钥——对齐 authn/market 语义）---------

  private signingCache: { keyId: string; privateKeyPem: string; publicKeyBase64: string } | undefined

  signing(): { keyId: string; privateKeyPem: string; publicKeyBase64: string } {
    if (this.signingCache) return this.signingCache
    const keyFile = join(this.ctx.opsStorage.dataDirPath, 'a2a-card-signing-key.pem')
    let privateKeyPem: string
    try {
      privateKeyPem = readFileSync(keyFile, 'utf8')
    } catch {
      const generated = generateEd25519KeyPair()
      writeFileSync(keyFile, generated.privateKeyPem, { mode: 0o600 })
      privateKeyPem = generated.privateKeyPem
      this.ctx.logger('a2a').info('已生成 A2A Agent Card 签名密钥（Ed25519，私钥落盘 dataDir 0600）')
    }
    let entry = this.cardKeys().all()[0]
    if (!entry) {
      entry = this.cardKeys().insert({
        id: newId('key'),
        keyId: 'a2a-card-key-1',
        publicKeyBase64: createPublicKey(privateKeyPem).export({ format: 'der', type: 'spki' }).toString('base64'),
        algorithm: 'Ed25519',
        createdAt: new Date().toISOString(),
      })
    }
    this.signingCache = { keyId: entry.keyId, privateKeyPem, publicKeyBase64: entry.publicKeyBase64 }
    return this.signingCache
  }

  // -- Agent Card：授权集投影 + 签名（声明以授权为权威，不接受自由填写）----------------------

  /** 技能投影：已上架 Skill（agent.attrs.skills）+ MCP 权限组（subjects 命中该 Agent）。 */
  private projectSkills(agentId: string, attrs: Record<string, unknown>): AgentCardSkill[] {
    const skills: AgentCardSkill[] = []
    const slugs = Array.isArray(attrs['skills']) ? (attrs['skills'] as unknown[]).map(String) : []
    for (const slug of slugs) {
      const skill = this.ctx.skillHub.skills().find((item) => item.slug === slug && item.status === 'published')[0]
      if (!skill) continue // 未上架/已强制下架的 Skill 不投影（声明 ≤ 授权）
      skills.push({ id: `skill:${skill.slug}`, name: skill.name, description: skill.summary, tags: skill.tags.slice(0, 6) })
    }
    for (const group of this.ctx.mcpRegistry.permGroups().all()) {
      if (!group.subjects.some((subject) => subject.type === 'agent' && subject.id === agentId)) continue
      skills.push({ id: `mcp:${group.id}`, name: group.name, description: group.description || t('MCP 工具权限组'), tags: ['mcp'] })
    }
    return skills
  }

  /** 密级天花板（渠道口径 public/internal/secret；缺省 internal——D14 业务密级不做按名直译）。 */
  dataClassCeilingOf(attrs: Record<string, unknown>): DataClass {
    const raw = String(attrs['a2aDataClassCeiling'] ?? '').trim()
    return raw === 'public' || raw === 'secret' ? (raw as DataClass) : 'internal'
  }

  autonomyOf(attrs: Record<string, unknown>): Autonomy {
    return normalizeAutonomy(attrs['autonomy'])
  }

  /**
   * Agent Card 自描述（Q-31/Q-32/E-7）：补齐外部 Agent「只靠卡片协作」所需的全部契约面——
   * SSE 事件地址、所需权限点、A2A 协议版本与���法面、计量双主体口径。
   * 卡片是 A2A 生态扩展性的天花板：字段缺一项，每接一个外部厂商 Agent 就要多一次人工适配。
   */
  cardBodyFor(agent: { id: string; slug: string; name: string; attrs: Record<string, unknown> }): AgentCardBody {
    const attrs = agent.attrs
    const base = String(process.env.PLATFORM_PUBLIC_BASE ?? '').replace(/\/+$/, '')
    return {
      name: agent.name,
      description: String(attrs['description'] ?? ''),
      url: `${base}/api/agents/${agent.slug}/a2a`,
      version: '1.3.0',
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: this.projectSkills(agent.id, attrs),
      // Q-31：声明调用所需权限点（此前无 scopes，外部客户端只能猜）
      securitySchemes: {
        ybkMachineCredential: {
          type: 'http',
          scheme: 'bearer',
          description: t('机器凭证令牌（POST /api/auth/client-credentials 换取，有效期 2 小时）'),
          scopes: { 'agent.a2a.invoke': t('A2A 协作调用（派活/续答/取消/查询）') },
        },
      },
      // Q-31/Q-32/E-7：事件地址 + 计量双主体口径 + 协议版本与方��面
      eventsUrl: `${base}/v1/a2a/tasks/{taskId}/events`,
      extensions: [
        {
          uri: 'urn:ybk:ext:governance:v1',
          params: {
            autonomy: this.autonomyOf(attrs),
            runtime: String(attrs['runtime'] ?? 'dsh'),
            dataClassCeiling: this.dataClassCeilingOf(attrs),
            // 双主体口径（Q-32/E-7）：协作调用计量记在发起侧，模型用量记在本员工侧
            meteringSubject: `agent:${agent.id}`,
            callerMeteringSubject: 'agent:<callerAgentId>',
          },
        },
        {
          uri: 'urn:ybk:ext:protocol:v1',
          params: {
            protocol: 'a2a-jsonrpc',
            protocolVersion: '1.3.0',
            transport: 'json-rpc-2.0/http',
            methods: 'message/send,message/stream,tasks/get,tasks/list,tasks/cancel',
            streamingTransport: 'sse',
            sseAuth: 'query-token',
            wellKnown: `${base}/.well-known/agents/${agent.slug}/agent-card.json`,
            directory: `${base}/api/a2a/directory`,
            uhpDiscovery: `${base}/v1/uhp`,
            uhpVersion: '2026-08-11',
            envelope: 'jsonrpc',
          },
        },
      ],
    }
  }

  cardFor(agent: { id: string; slug: string; name: string; attrs: Record<string, unknown> }): SignedAgentCard {
    const { keyId, privateKeyPem } = this.signing()
    return signAgentCard(this.cardBodyFor(agent), privateKeyPem, keyId)
  }

  /** 平台级目录卡（含验签公钥——调用方先验签后采信）+ 协议面与目录入口（Q-31）。 */
  platformCard() {
    const { keyId, publicKeyBase64 } = this.signing()
    const base = String(process.env.PLATFORM_PUBLIC_BASE ?? '').replace(/\/+$/, '')
    const agents = this.ctx.resourceCore.list('agent').filter((item) => item.status === 'online')
    return {
      name: t('ybkkasi 企业数字员工协作目录'),
      version: '1.3.0',
      capabilities: { directory: true, streaming: true },
      signingKeys: [{ keyId, publicKeyBase64, algorithm: 'Ed25519' }],
      extensions: [{
        uri: 'urn:ybk:ext:protocol:v1',
        params: {
          protocol: 'a2a-jsonrpc',
          protocolVersion: '1.3.0',
          transport: 'json-rpc-2.0/http',
          methods: 'message/send,message/stream,tasks/get,tasks/list,tasks/cancel',
          streamingTransport: 'sse',
          sseAuth: 'query-token',
          directory: `${base}/api/a2a/directory`,
          uhpDiscovery: `${base}/v1/uhp`,
          uhpVersion: '2026-08-11',
          envelope: 'jsonrpc',
        },
      }],
      agents: agents.map((agent) => ({
        slug: agent.slug,
        name: agent.name,
        autonomy: this.autonomyOf(agent.attrs),
        runtime: String(agent.attrs['runtime'] ?? 'dsh'),
        cardUrl: `${base}/.well-known/agents/${agent.slug}/agent-card.json`,
      })),
    }
  }

  /** 目录检索（跨运行时发现）：在线员工 + 卡片治理扩展字段投影。 */
  /**
   * 目录检索（跨运行时发现）：在线员工 + 卡片治理扩展字段投影。
   * 组织隔离（Q-4）：按调用方可见组织子树收敛——与 /api/agents 的 R11 口径一致，
   * 下级组织持 a2a.directory.read 只能看到本组织子树的协作对象。
   */
  directory(filter: { skill?: string; q?: string; runtime?: string; autonomy?: string; dataClass?: string; category?: string }, caller?: CallerRefLike) {
    const orgScope = caller ? this.visibleOrgIds(caller) : null
    const entries = this.ctx.resourceCore.list('agent')
      .filter((agent) => agent.status === 'online')
      .filter((agent) => (orgScope === null || !caller ? true : this.canSeeOrg(caller, agent.id)))
      .map((agent) => {
        const card = this.cardBodyFor(agent)
        return {
          agentId: agent.id,
          slug: agent.slug,
          name: agent.name,
          description: card.description,
          avatar: String(agent.attrs['avatar'] ?? '🤖'),
          // 业务分类（各资产板块统一口径）：存量登记无该属性按「其他」归拢
          category: normalizeAssetCategory(agent.attrs['category']),
          url: card.url,
          skills: card.skills,
          autonomy: card.extensions[0]!.params.autonomy,
          runtime: card.extensions[0]!.params.runtime,
          dataClassCeiling: card.extensions[0]!.params.dataClassCeiling,
          meteringSubject: card.extensions[0]!.params.meteringSubject,
          updatedAt: agent.updatedAt,
        }
      })
    return entries
      .filter((entry) => (filter.category ? entry.category === filter.category : true))
      .filter((entry) => (filter.runtime ? entry.runtime === filter.runtime : true))
      .filter((entry) => (filter.autonomy ? entry.autonomy === filter.autonomy : true))
      .filter((entry) => {
        if (!filter.dataClass) return true
        const wanted = filter.dataClass === 'public' || filter.dataClass === 'secret' ? filter.dataClass : 'internal'
        return DATA_CLASS_RANK[wanted] <= (DATA_CLASS_RANK[entry.dataClassCeiling as DataClass] ?? 1)
      })
      .filter((entry) => {
        if (!filter.skill) return true
        const needle = filter.skill.toLowerCase()
        return entry.skills.some((skill) => skill.id.toLowerCase().includes(needle) || skill.name.toLowerCase().includes(needle) || skill.tags.some((tag) => tag.toLowerCase().includes(needle)))
      })
      .filter((entry) => {
        if (!filter.q) return true
        const needle = filter.q.toLowerCase()
        return entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle) || entry.slug.toLowerCase().includes(needle)
      })
  }

  // -- 治理检查五项（受理后、转译 UHP 前；任一不过即 rejected 并留痕）-------------------------

  private async governanceCheck(input: {
    agent: { id: string; name: string; slug: string; status: string; orgId: string; attrs: Record<string, unknown> }
    dataClass: DataClass
    message: string
    callerAutonomy: Autonomy
  }): Promise<{ ok: true; approvalRequired: boolean } | { ok: false; code: string; message: string }> {
    const { agent } = input
    // 1. 权限点：由 /api 路由 guarded('agent.a2a.invoke') 在 HTTP 边界强制（fail-closed），此处登记语义位。
    if (agent.status !== 'online') return { ok: false, code: 'TARGET_NOT_ONLINE', message: t('被调员工未上线（{status}），A2A 仅对 online 开放', { status: agent.status }) }
    // 2. 在线 + 非冻结 + workforce permit 覆盖
    //    受管员工（workforce 绑定 active + 员工在岗 + 任用生效）permit 覆盖成立；
    //    绑定存在但失效（离岗/任用撤销/绑定停用）→ 拒绝（Q-22/D-4）；
    //    从未纳管的 legacy Agent 按 v1 语义放行，不因未纳管而阻断。
    if (this.ctx.agentRegistry.isFrozen(agent.id)) return { ok: false, code: 'TARGET_FROZEN', message: t('被调员工已冻结（预算超限联动），暂不可承接协作任务') }
    // P2-01：workforceIdentity 已进 inject（此前缺失 → cordis Service 代理读未注入键即抛错，
    // 被 catch 吞掉按 legacy 放行，permit 覆盖实为空操作）。判定改用契约方法 inspectAgent——
    // 不触碰 resolver.store 内部结构（脆弱耦合），并区分「未纳管」与「已纳管但失效」。
    // 兜底口径：workforceIdentity 是声明依赖（inject + plugin.yaml），宿主缺提供者时本插件
// 整体 INACTIVE（cordis 语义），不会走到这里；判定**抛错**则 fail-closed 拒绝——
// 不允许把「治理判定失败」当成放行理由（P2-01 的根因正是异常被吞后按 legacy 放行）。
    const resolver = this.ctx.workforceIdentity
    let state: Awaited<ReturnType<typeof resolver.inspectAgent>>
    try {
      state = await resolver.inspectAgent(agent.id)
    } catch (error) {
      this.ctx.audit.fire({
        severity: 'warning',
        title: t('workforce permit 覆盖判定失败：{agent}', { agent: agent.slug }),
        message: error instanceof Error ? error.message : String(error),
        resourceType: 'agent',
        resourceId: agent.id,
      })
      return {
        ok: false,
        code: 'PERMIT_NOT_EFFECTIVE',
        message: t('无法确认被调员工的 permit 覆盖状态（判定异常），按 fail-closed 拒绝本次协作'),
      }
    }
    if (state.bound && !state.permitEffective) {
      const reason = state.reason === 'EMPLOYEE_NOT_ACTIVE'
        ? t('员工已离岗/停职（{employeeId}）', { employeeId: state.employeeId ?? '' })
        : t('任用未生效（{employeeId}）', { employeeId: state.employeeId ?? '' })
      return {
        ok: false,
        code: 'PERMIT_NOT_EFFECTIVE',
        message: t('被调员工已绑定数字员工身份但 permit 未生效：{reason}，请先恢复员工在岗与任用后重试', { reason }),
      }
    }
    // 3. 密级天花板（越级走渠道锁死拒绝口径，契约 c1 语义）
    const ceiling = this.dataClassCeilingOf(agent.attrs)
    if (DATA_CLASS_RANK[input.dataClass] > DATA_CLASS_RANK[ceiling]) {
      return { ok: false, code: 'DATA_CLASS_EXCEEDED', message: t('数据密级越级：任务密级 {requested} 高于该员工天花板 {ceiling}（拒绝并留痕）', { requested: input.dataClass, ceiling }) }
    }
    // 4. 预算与配额（modelgw 预算熔断口径）
    try {
      const statuses = this.ctx.modelGateway.budgetStatusForSubject(`agent:${agent.id}`, agent.orgId)
      for (const item of statuses) {
        const breached = (item.daily?.breached || item.monthly?.breached)
        if (breached && item.budget.action === 'block') {
          return { ok: false, code: 'BUDGET_EXCEEDED', message: t('被调员工预算熔断中（预算 {budget}），本次任务拒绝', { budget: item.budget.id }) }
        }
      }
    } catch { /* modelgw 预算面缺席：不阻断（模型调用侧仍有熔断兜底） */ }
    // 5. 敏感操作审批规则（命中 → auth_required 挂审批工单，而非直接拒绝）
    const approvalRequired = this.rules().all().some((rule) => {
      if (!rule.enabled) return false
      if (rule.matchDataClassAtLeast && DATA_CLASS_RANK[input.dataClass] >= DATA_CLASS_RANK[rule.matchDataClassAtLeast]) return true
      if (rule.matchKeyword && input.message.includes(rule.matchKeyword)) return true
      return false
    })
    return { ok: true, approvalRequired }
  }

  /**
   * 调用方自治级别判定：机器凭证绑定 Agent 时取其登记级别（contract-c3）；
   * 人类调用方映射 A1——协商矩阵下 A1 列语义恰好就是人类委派语义：
   * A0 目标 → 单轮问答、A1 目标 → 执行+人在环、A2 目标 → 执行事后报告、A3 目标 → 执行。
   */
  private callerAutonomyOf(caller: CallerRefLike, verified?: VerifiedPrincipal): Autonomy {
    if (caller.refType === 'agent' && caller.refId) {
      const agent = this.ctx.resourceCore.get('agent', caller.refId)
      if (agent) return this.autonomyOf(agent.attrs)
    }
    void verified
    return 'A1'
  }

  // -- 任务面 ---------------------------------------------------------------

  private resolveAgent(ref: string) {
    return this.ctx.resourceCore.get('agent', ref) ?? this.ctx.resourceCore.bySlug('agent', ref)
  }

  private callerRefOf(exchange: HttpExchange): CallerRefLike {
    const info = exchange.principal as CallerRefLike
    return info
  }

  private orgOf(caller: CallerRefLike, agent: { orgId: string }): string {
    return (caller.userId ? this.ctx.iam.users().get(caller.userId)?.orgId : undefined) ?? agent.orgId ?? ''
  }

  private subjectOf(caller: CallerRefLike): string {
    return caller.refType === 'agent' && caller.refId
      ? `agent:${caller.refId}`
      : caller.userId ? `user:${caller.userId}` : `a2a:${caller.principalId}`
  }

  private appendHistory(task: A2aTaskRecord, entry: A2aHistoryEntry): A2aTaskRecord {
    const history = [...task.history, entry].slice(-200)
    return this.tasks().update(task.id, { history })
  }

  private transition(taskId: string, state: A2aTaskState, reason: string): A2aTaskRecord {
    const task = this.tasks().findOne((item) => item.taskId === taskId)
    if (!task) throw new Error(t('A2A 任务不存在：{id}', { id: taskId }))
    if (task.state === state && A2A_TERMINAL_STATES.includes(state)) return task
    const patch: Partial<A2aTaskRecord> = { state, stateReason: reason }
    if (A2A_TERMINAL_STATES.includes(state)) patch.finishedAt = new Date().toISOString()
    if (state === 'working' && !task.startedAt) patch.startedAt = new Date().toISOString()
    const updated = this.tasks().update(task.id, patch)
    this.appendHistory(updated, { at: new Date().toISOString(), from: 'system', type: 'status', state, note: reason })
    this.ctx.platformBus.emit('a2a.task.changed', { taskId, state, reason, contextId: updated.contextId, agentId: updated.agentId })
    return updated
  }

  /**
   * message/send 主入口：创建或续答任务 → 治理检查五项 → 协商引擎 → 执行派发。
   * 返回任务快照（同步等待至终态或超时——长任务客户端经 tasks/get 或 SSE 续查）。
   */
  async sendMessage(input: {
    caller: CallerRefLike
    agentRef: string
    message: string
    dataClass?: string
    contextId?: string
    taskId?: string
    negotiation?: unknown
  }): Promise<A2aTaskRecord> {
    if (!input.message?.trim()) throw new Error(t('message 必填（A2A 协作任务内容）'))
    const agent = this.resolveAgent(input.agentRef)
    if (!agent) throw new NotFoundError(t('Agent 不存在：{ref}', { ref: input.agentRef }))
    const requested: DataClass = input.dataClass === 'public' || input.dataClass === 'secret' ? input.dataClass : 'internal'
    const caller = input.caller
    const callerAutonomy = this.callerAutonomyOf(caller)
    const targetAutonomy = this.autonomyOf(agent.attrs)

    // 续答路径：input_required 任务的协商续轮 / 补充输入
    if (input.taskId) {
      const task = this.tasks().findOne((item) => item.taskId === input.taskId)
      if (!task) throw new NotFoundError(t('A2A 任务不存在：{id}', { id: input.taskId }))
      if (task.callerPrincipalId !== caller.principalId && !caller.permissions.includes('*')) {
        throw new Error(t('仅任务发起方可续答该任务'))
      }
      if (task.state !== 'input_required') {
        throw new Error(t('任务当前状态为 {state}，仅 input_required 可续答', { state: task.state }))
      }
      this.appendHistory(task, { at: new Date().toISOString(), from: 'caller', type: 'message', text: input.message })
      if (task.negotiation?.status === 'open') return this.advanceNegotiation(task, input.message, caller)
      // 非协商中断：补充输入后重新派发执行
      return this.dispatchTask(task, input.message)
    }

    // 新任务路径
    const governance = await this.governanceCheck({
      agent, dataClass: requested, message: input.message, callerAutonomy,
    })
    if (!governance.ok) {
      const task = this.createTaskRecord({ caller, agent, message: input.message, dataClass: requested, callerAutonomy, targetAutonomy })
      this.transition(task.taskId, 'rejected', governance.message)
      this.auditTask(this.tasks().findOne((item) => item.taskId === task.taskId)!, 'a2a.task.rejected', 'denied', governance.message)
      throw new GovernanceError(governance.code, governance.message)
    }

    // 协商引擎：A0-A3 矩阵仅约束「数字员工互调」（矩阵的行/列都是员工自治级别）；
    // 人类/外部服务调用方不进矩阵——按目标级别直判：A0 目标=单轮问答，A1+ 目标=A1 列语义
    // （A1→人在环执行、A2/A3→执行事后报告），执行深度始终受治理检查五项约束。
    const isAgentCaller = Boolean(caller.refType === 'agent' && caller.refId && this.ctx.resourceCore.get('agent', caller.refId))
    const mode: NegotiationMode = isAgentCaller
      ? negotiateMode(callerAutonomy, targetAutonomy)
      : (targetAutonomy === 'A0' ? 'single_turn' : negotiateMode('A1', targetAutonomy))
    if (mode === 'rejected') {
      // Q-10：mode 记录真实判定（rejected），不再兜底成 single_turn——按 mode 统计的消费方
      // （履约视图/审计归类/控制台筛选）不应把「矩阵拒绝」误计为「单轮问答」
      const task = this.createTaskRecord({ caller, agent, message: input.message, dataClass: requested, callerAutonomy, targetAutonomy, mode: 'rejected' })
      const reason = t('协商矩阵拒绝：调用方 {caller} × 被调方 {target} 不允许执行类交互（A0 提示型员工不可被驱动执行）', { caller: callerAutonomy, target: targetAutonomy })
      this.transition(task.taskId, 'rejected', reason)
      this.auditTask(this.tasks().findOne((item) => item.taskId === task.taskId)!, 'a2a.task.rejected', 'denied', reason)
      throw new GovernanceError('NEGOTIATION_REJECTED', reason)
    }

    const task = this.createTaskRecord({
      caller, agent, message: input.message, dataClass: requested, callerAutonomy, targetAutonomy, mode,
      // Q-21：调用方可指定协作链 ID（metadata.contextId），同链多 Task 才能被计量归集
      ...(input.contextId ? { contextId: input.contextId } : {}),
    })
    this.auditTask(task, 'a2a.task.accepted', 'ok', t('治理检查五项通过，协商引擎判定 {mode}', { mode }))

    if (mode === 'single_turn') return this.runSingleTurn(this.tasks().findOne((item) => item.taskId === task.taskId)!)
    // 敏感操作审批规则命中（单轮问答不构成操作，豁免）：执行类/协商类任务一律先挂审批工单
    if (governance.approvalRequired) {
      return this.requestAuthorize(this.tasks().findOne((item) => item.taskId === task.taskId)!, t('命中敏感操作审批规则，人在环确认后恢复执行'))
    }
    if (mode === 'execute_confirm') return this.requestAuthorize(this.tasks().findOne((item) => item.taskId === task.taskId)!, t('协商矩阵要求人在环确认（{caller} × {target}）', { caller: callerAutonomy, target: targetAutonomy }))
    if (mode === 'negotiate') {
      const proposal = input.negotiation ?? { task: input.message }
      return this.startNegotiation(this.tasks().findOne((item) => item.taskId === task.taskId)!, proposal)
    }
    return this.dispatchTask(this.tasks().findOne((item) => item.taskId === task.taskId)!)
  }

  private createTaskRecord(input: {
    caller: CallerRefLike
    agent: { id: string; slug: string; name: string }
    message: string
    dataClass: DataClass
    callerAutonomy: Autonomy
    targetAutonomy: Autonomy
    mode?: NegotiationMode
    /** 调用方指定的协作链 ID（Q-21）；缺省由平台生成。 */
    contextId?: string
  }): A2aTaskRecord {
    const now = new Date().toISOString()
    return this.tasks().insert({
      id: newId('a2at'),
      taskId: newId('task'),
      // Q-21：调用方指定的协作链原样透传（计量按链归集的前提）；缺省仍由平台生成
      contextId: input.contextId?.trim() || newId('a2actx'),
      agentId: input.agent.id,
      agentSlug: input.agent.slug,
      callerPrincipalId: input.caller.principalId,
      ...(input.caller.userId ? { callerUserId: input.caller.userId } : {}),
      ...(input.caller.refType === 'agent' && input.caller.refId ? { callerAgentId: input.caller.refId } : {}),
      callerSubject: this.subjectOf(input.caller),
      callerAutonomy: input.callerAutonomy,
      targetAutonomy: input.targetAutonomy,
      mode: input.mode ?? 'single_turn',
      state: 'submitted',
      stateReason: t('任务受理（治理检查中）'),
      message: input.message,
      dataClass: input.dataClass,
      artifacts: [],
      history: [{ at: now, from: 'caller', type: 'message', text: input.message.slice(0, 2000) }],
      attempts: 0,
      // OBO 身份链（Q-6）：人类以代表身份发起时，act 链里的真实发起人随任务与审计留痕
      ...(input.caller.onBehalfOfUser ? { onBehalfUser: input.caller.onBehalfOfUser } : {}),
      ...(input.caller.oboActChain && input.caller.oboActChain.length > 0 ? { actChain: input.caller.oboActChain } : {}),
    })
  }

  /** 单轮问答（single_turn）：v1 平台代答语义，真实模型调用 + 零价快照计量（带协作链 contextId）。 */
  private async runSingleTurn(task: A2aTaskRecord): Promise<A2aTaskRecord> {
    const agent = this.resolveAgent(task.agentId)
    if (!agent) return this.transition(task.taskId, 'failed', t('Agent 资产不存在'))
    const model = String(agent.attrs['model'] ?? '')
    if (!model) {
      this.transition(task.taskId, 'failed', t('Agent 未配置模型（model 属性为空），诚实降级'))
      return this.tasks().findOne((item) => item.taskId === task.taskId)!
    }
    const systemPrompt = String(agent.attrs['systemPrompt'] ?? t('你是企业数字同事「{name}」。{description}', { name: agent.name, description: String(agent.attrs['description'] ?? '') }))
    this.transition(task.taskId, 'working', t('单轮问答执行中（平台代答）'))
    try {
      const org = (task.callerUserId ? this.ctx.iam.users().get(task.callerUserId)?.orgId : undefined) ?? agent.orgId ?? ''
      const result = await this.ctx.modelGateway.invoke({
        model,
        orgId: org,
        subject: task.callerSubject,
        dataClass: task.dataClass,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: task.message },
        ],
      })
      const updated = this.tasks().update(task.id, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: result.model,
        responseId: result.usageEventId,
      })
      this.completeTask(updated, result.content)
      this.emitInvoked(agent, result.model)
      return this.tasks().findOne((item) => item.taskId === task.taskId)!
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.transition(task.taskId, 'failed', reason)
      this.auditTask(this.tasks().findOne((item) => item.taskId === task.taskId)!, 'agent.a2a.invoke', 'error', reason)
      return this.tasks().findOne((item) => item.taskId === task.taskId)!
    }
  }

  /** 执行派发：转译 UHP 调用（幂等键对齐 Task；只走事件总线）。 */
  private dispatchTask(task: A2aTaskRecord, resumeMessage?: string): A2aTaskRecord {
    const agent = this.resolveAgent(task.agentId)
    if (!agent) return this.transition(task.taskId, 'failed', t('Agent 资产不存在'))
    const attempts = task.attempts + 1
    this.tasks().update(task.id, { attempts })
    if (resumeMessage) this.tasks().update(task.id, { message: resumeMessage })
    this.transition(task.taskId, 'working', t('UHP 执行中（第 {n} 次派发）', { n: attempts }))
    this.ctx.platformBus.emit('a2a.task.dispatch', {
      taskId: task.taskId,
      contextId: task.contextId,
      agentId: task.agentId,
      harnessRef: String(agent.attrs['uhpHarnessRef'] ?? '') || undefined,
      input: resumeMessage ?? task.message,
      dataClass: task.dataClass,
      // 幂等键对齐（协作方案 §7.2）：a2a:<agentId>:<principal>:<taskId>:a<attempt>
      idempotencyKey: this.dispatchKey(task, attempts),
      sessionPolicy: String(agent.attrs['uhpSessionPolicy'] ?? 'task-bound') === 'employee-bound' ? 'employee-bound' : 'task-bound',
      callerPrincipalId: task.callerPrincipalId,
      // OBO 身份链（Q-6）：平台内部透传真实发起人，UHP 侧据此记审计（不采信任何外部自述）
      ...(task.onBehalfUser ? { onBehalfUser: task.onBehalfUser } : {}),
      ...(task.actChain?.length ? { actChain: task.actChain } : {}),
    })
    this.emitInvoked(agent, String(agent.attrs['model'] ?? ''))
    return this.tasks().findOne((item) => item.taskId === task.taskId)!
  }

  /** A3×A3 协商：发起要约（round 1）。 */
  private async startNegotiation(task: A2aTaskRecord, proposal: unknown): Promise<A2aTaskRecord> {
    const negotiation = { round: 1, maxRounds: NEGOTIATION_MAX_ROUNDS, status: 'open' as const, offers: [{
      round: 1, from: 'caller' as const, proposal, at: new Date().toISOString(),
    }] }
    const withNegotiation = this.tasks().update(task.id, { negotiation })
    this.appendHistory(withNegotiation, { at: new Date().toISOString(), from: 'caller', type: 'offer', note: t('发起协商要约（第 1 轮）') })
    return this.evaluateNegotiation(this.tasks().findOne((item) => item.taskId === task.taskId)!)
  }

  /** 协商续轮：调用方对还价的回应。 */
  private async advanceNegotiation(task: A2aTaskRecord, message: string, _caller: CallerRefLike): Promise<A2aTaskRecord> {
    void _caller
    const negotiation = task.negotiation!
    if (negotiation.round >= negotiation.maxRounds) {
      this.tasks().update(task.id, { negotiation: { ...negotiation, status: 'expired' } })
      const reason = t('协商轮次超限（{max} 轮），任务拒绝', { max: negotiation.maxRounds })
      this.transition(task.taskId, 'rejected', reason)
      this.auditTask(this.tasks().findOne((item) => item.taskId === task.taskId)!, 'a2a.task.rejected', 'denied', reason)
      return this.tasks().findOne((item) => item.taskId === task.taskId)!
    }
    const offers = [...negotiation.offers, { round: negotiation.round + 1, from: 'caller' as const, proposal: message, at: new Date().toISOString() }]
    this.tasks().update(task.id, { negotiation: { ...negotiation, round: negotiation.round + 1, offers } })
    const updated = this.tasks().findOne((item) => item.taskId === task.taskId)!
    this.appendHistory(updated, { at: new Date().toISOString(), from: 'caller', type: 'offer', note: t('协商回应（第 {n} 轮）', { n: negotiation.round + 1 }) })
    return this.evaluateNegotiation(this.tasks().findOne((item) => item.taskId === task.taskId)!)
  }

  /** 被调方评估当前要约：accept → 转执行；counter → input_required 挂起等调用方回应。 */
  private async evaluateNegotiation(task: A2aTaskRecord): Promise<A2aTaskRecord> {
    const agent = this.resolveAgent(task.agentId)
    if (!agent) return this.transition(task.taskId, 'failed', t('Agent 资产不存在'))
    const model = String(agent.attrs['model'] ?? '')
    if (!model) return this.transition(task.taskId, 'failed', t('Agent 未配置模型（model 属性为空），协商无法评估'))
    const systemPrompt = String(agent.attrs['systemPrompt'] ?? t('你是企业数字同事「{name}」。{description}', { name: agent.name, description: String(agent.attrs['description'] ?? '') }))
    const negotiation = task.negotiation!
    const latestOffer = negotiation.offers.at(-1)!
    this.transition(task.taskId, 'working', t('被调方评估协商要约（第 {n} 轮）', { n: negotiation.round }))
    let raw = ''
    try {
      const result = await this.ctx.modelGateway.invoke({
        model,
        orgId: agent.orgId ?? '',
        subject: `agent:${agent.id}`,
        dataClass: task.dataClass,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: t(
            '收到另一数字员工的协作要约（JSON）：{proposal}\n任务背景消息：{message}\n请评估你能否承接该任务边界、时限与交付格式。只回复 JSON：能承接 → {"decision":"accept","note":"…"}；需修订 → {"decision":"counter","proposal":{…修订要约…},"note":"…"}',
            { proposal: JSON.stringify(latestOffer.proposal).slice(0, 3000), message: task.message.slice(0, 1000) },
          ) },
        ],
      })
      raw = result.content
      this.tasks().update(task.id, { inputTokens: (task.inputTokens ?? 0) + result.inputTokens, outputTokens: (task.outputTokens ?? 0) + result.outputTokens, model: result.model })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.transition(task.taskId, 'failed', t('协商评估失败：{reason}', { reason }))
      return this.tasks().findOne((item) => item.taskId === task.taskId)!
    }
    const decision = parseNegotiationDecision(raw)
    const current = this.tasks().findOne((item) => item.taskId === task.taskId)!
    if (decision.decision === 'accept') {
      this.tasks().update(current.id, { negotiation: { ...(current.negotiation ?? negotiation), status: 'accepted' } })
      this.appendHistory(this.tasks().get(current.id)!, { at: new Date().toISOString(), from: 'target', type: 'offer', note: t('被调方接受要约：{note}', { note: decision.note ?? '-' }) })
      const accepted = this.tasks().findOne((item) => item.taskId === task.taskId)!
      return this.dispatchTask(accepted)
    }
    const offers = [...(current.negotiation ?? negotiation).offers, { round: (current.negotiation ?? negotiation).round, from: 'target' as const, proposal: decision.proposal ?? null, note: decision.note, at: new Date().toISOString() }]
    this.tasks().update(current.id, { state: 'input_required', stateReason: t('被调方还价（第 {n} 轮），等待调用方回应', { n: (current.negotiation ?? negotiation).round }), negotiation: { ...(current.negotiation ?? negotiation), offers } })
    this.appendHistory(this.tasks().get(current.id)!, { at: new Date().toISOString(), from: 'target', type: 'offer', note: t('还价：{note}', { note: decision.note ?? '-' }) })
    this.ctx.platformBus.emit('a2a.task.changed', { taskId: task.taskId, state: 'input_required', reason: t('协商还价'), contextId: task.contextId, agentId: task.agentId })
    return this.tasks().findOne((item) => item.taskId === task.taskId)!
  }

  /** 人在环确认（execute_confirm / 审批规则命中）：auth_required + 审批中心工单。 */
  private requestAuthorize(task: A2aTaskRecord, reason: string): A2aTaskRecord {
    const approval = this.ctx.audit.createApproval({
      kind: 'a2a.task.authorize',
      riskLevel: 'medium',
      title: t('A2A 协作任务授权：{taskId}（{slug}）', { taskId: task.taskId, slug: task.agentSlug }),
      payload: {
        taskId: task.taskId,
        agentId: task.agentId,
        agentSlug: task.agentSlug,
        dataClass: task.dataClass,
        messagePreview: task.message.slice(0, 500),
        reason,
      },
      requesterId: task.callerUserId ?? task.callerPrincipalId,
      requesterName: task.callerSubject,
    })
    this.tasks().update(task.id, { approvalId: approval.id })
    this.transition(task.taskId, 'auth_required', reason)
    this.auditTask(this.tasks().findOne((item) => item.taskId === task.taskId)!, 'a2a.task.auth_required', 'ok', t('命中人在环确认，审批工单 {id}', { id: approval.id }))
    return this.tasks().findOne((item) => item.taskId === task.taskId)!
  }

  /**
   * UHP 进度 → 状态机。
   *
   * P0（Q-1）纵深防御：progress 必须携带本任务**平台派发时产生的** responseId 才可推进状态。
   * 协议面已禁止外部注入 taskId、UHP 侧也只对平台派发记录发 progress；此处再加一道配对校验——
   * 即使前两层被绕过，非本任务派发产生的 responseId 也不会推进任务。
   */
  private onProgress(payload: UhpProgressLike): void {
    if (!payload.taskId) return
    const task = this.tasks().findOne((item) => item.taskId === payload.taskId)
    if (!task) return
    if (payload.phase === 'started') {
      if (task.state !== 'working') this.transition(task.taskId, 'working', t('UHP 执行已启动'))
      if (payload.responseId) this.tasks().update(task.id, { responseId: payload.responseId })
      return
    }
    // 终态类 progress 校验来源：任务必须已登记过派发 responseId，且与本次 progress 的 responseId 一致
    const bound = task.responseId
    if (!bound || !payload.responseId || bound !== payload.responseId) {
      this.ctx.audit.record({
        type: 'authz', actorType: 'system', actorId: 'a2a-guard', actorName: t('A2A 来源校验'),
        action: 'a2a.task.progress_rejected', resourceType: 'agent', resourceId: task.agentId, resourceName: task.agentSlug,
        result: 'denied',
        detail: t('拒绝非本任务派发的执行进度（task={taskId} bound={bound} incoming={incoming} phase={phase}）——防任务劫持', {
          taskId: task.taskId, bound: bound ?? '-', incoming: payload.responseId ?? '-', phase: payload.phase,
        }),
      })
      return
    }
    if (payload.phase === 'completed') {
      const updated = this.tasks().update(task.id, {
        inputTokens: payload.inputTokens ?? task.inputTokens,
        outputTokens: payload.outputTokens ?? task.outputTokens,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.responseId ? { responseId: payload.responseId } : {}),
      })
      this.completeTask(updated, payload.text ?? '')
      return
    }
    if (payload.phase === 'failed') {
      this.transition(task.taskId, 'failed', payload.error ?? t('UHP 执行失败'))
      this.auditTask(this.tasks().findOne((item) => item.taskId === task.taskId)!, 'agent.a2a.invoke', 'error', payload.error ?? 'UHP failed')
      return
    }
    if (payload.phase === 'canceled') {
      if (!A2A_TERMINAL_STATES.includes(task.state)) this.transition(task.taskId, 'canceled', t('UHP 执行取消，结果不交付'))
    }
  }

  /** 任务完成收口：artifact 落账 + 零价快照计量（contextId 协作链归集）+ 审计。 */
  private completeTask(task: A2aTaskRecord, text: string): void {
    const artifact: A2aArtifact = {
      artifactId: newId('art'),
      name: 'reply.txt',
      mimeType: 'text/plain',
      kind: 'text',
      content: text,
      sizeBytes: Buffer.byteLength(text, 'utf8'),
    }
    this.tasks().update(task.id, { artifacts: [artifact] })
    this.transition(task.taskId, 'completed', t('任务完成（含交付物 {n} 项）', { n: 1 }))
    try {
      const agent = this.resolveAgent(task.agentId)
      const org = this.orgOf({ principalId: task.callerPrincipalId, userId: task.callerUserId } as CallerRefLike, agent ?? { orgId: '' })
      this.ctx.usage.record({
        ...nonbillableUsage({
          org,
          subject: task.callerSubject,
          principal: org ? `org:${org}` : 'platform',
          resource: `agent:${task.agentId}`,
          // Q-20：落账键与执行层派发键同形（含 attempt）——重派发时两层同步计数，
          // 不再出现「执行层计 2 次、协作链计量计 1 次」的口径裂口
          idempotency_key: this.dispatchKey(task, task.attempts),
        }),
        meters: [
          { key: 'calls', value: 1, unit: 'call' },
          { key: 'input_tokens', value: task.inputTokens ?? 0, unit: 'token' },
          { key: 'output_tokens', value: task.outputTokens ?? 0, unit: 'token' },
        ],
        // 协作链归集（C4）：同 contextId 多 Task 计量按链聚合
        contextId: task.contextId,
      })
    } catch (error) {
      // Q-20：计量失败不再静默吞没——落审计告警，使「任务完成但未入账」可被发现
      this.ctx.audit.fire({
        severity: 'warning',
        title: t('A2A 协作任务计量入账失败：{taskId}', { taskId: task.taskId }),
        message: error instanceof Error ? error.message : String(error),
        resourceType: 'agent',
        resourceId: task.agentId,
      })
    }
    this.auditTask(this.tasks().findOne((item) => item.taskId === task.taskId)!, 'agent.a2a.invoke', 'ok', t('UHP 任务完成：tokens {in}/{out}', { in: task.inputTokens ?? 0, out: task.outputTokens ?? 0 }))
  }

  /** 执行/计量共用的幂等键：a2a:<agentId>:<principal>:<taskId>:a<attempt>（两层同形，见 Q-20）。 */
  private dispatchKey(task: A2aTaskRecord, attempt: number): string {
    return `a2a:${task.agentId}:${task.callerPrincipalId}:${task.taskId}:a${Math.max(attempt, 1)}`
  }

  private emitInvoked(agent: { id: string; slug: string; attrs: Record<string, unknown> }, model: string): void {
    this.ctx.platformBus.emit(PlatformEvents.AgentA2aInvoked, {
      agentId: agent.id, slug: agent.slug, from: 'a2a-collab', model,
      autonomy: this.autonomyOf(agent.attrs), runtime: String(agent.attrs['runtime'] ?? 'dsh'),
    })
  }

  private auditTask(task: A2aTaskRecord, action: string, result: 'ok' | 'denied' | 'error', detail: string): void {
    this.ctx.audit.record({
      type: 'invoke',
      actorType: task.callerUserId ? 'human' : 'machine',
      actorId: task.onBehalfUser ?? task.callerSubject,
      actorName: task.onBehalfUser ?? task.callerSubject,
      action,
      resourceType: 'agent',
      resourceId: task.agentId,
      resourceName: task.agentSlug,
      result,
      detail: `task=${task.taskId} context=${task.contextId} state=${task.state} ${detail}`.trim(),
    })
  }

  // -- 查询 / 取消 / 验收 / 履约 / 巡检 ---------------------------------------

  /**
   * 任务视图（Q-5 正文脱敏）：治理读权限（a2a.directory.read）可见元数据，
   * 但任务正文（message / artifacts 内容 / 协商要约原文 / 历史流水）需
   * 发起方本人、验收员（a2a.task.accept）或平台管理员；否则标记 contentRedacted 并省略明文。
   */
  taskView(task: A2aTaskRecord, caller?: CallerRefLike) {
    const privileged = !caller
      || caller.permissions.includes('*')
      || task.callerPrincipalId === caller.principalId
      || caller.permissions.includes('a2a.task.accept')
    if (privileged) {
      return {
        taskId: task.taskId, contextId: task.contextId, agentId: task.agentId, agentSlug: task.agentSlug,
        callerSubject: task.callerSubject, callerAutonomy: task.callerAutonomy, targetAutonomy: task.targetAutonomy,
        mode: task.mode, state: task.state, stateReason: task.stateReason, message: task.message,
        dataClass: task.dataClass, negotiation: task.negotiation, artifacts: task.artifacts, history: task.history,
        responseId: task.responseId, attempts: task.attempts, inputTokens: task.inputTokens, outputTokens: task.outputTokens,
        model: task.model, approvalId: task.approvalId, acceptance: task.acceptance,
        ...(task.onBehalfUser ? { onBehalfUser: task.onBehalfUser } : {}),
        createdAt: task.createdAt, startedAt: task.startedAt, finishedAt: task.finishedAt,
      }
    }
    return {
      taskId: task.taskId, contextId: task.contextId, agentId: task.agentId, agentSlug: task.agentSlug,
      callerSubject: task.callerSubject, callerAutonomy: task.callerAutonomy, targetAutonomy: task.targetAutonomy,
      mode: task.mode, state: task.state, stateReason: task.stateReason, dataClass: task.dataClass,
      contentRedacted: true,
      redactionHint: t('正文已按权限脱敏（需任务发起方、验收员或平台管理员权限查看任务正文与交付物）'),
      // 协商与历史仅保留状态骨架，不含要约原文与流水文本
      negotiation: task.negotiation
        ? { round: task.negotiation.round, maxRounds: task.negotiation.maxRounds, status: task.negotiation.status, offers: [] }
        : undefined,
      artifacts: task.artifacts.map((artifact) => ({ ...artifact, content: undefined, redacted: true })),
      history: task.history.map((entry) => ({ ...entry, text: undefined })),
      responseId: task.responseId, attempts: task.attempts, inputTokens: task.inputTokens, outputTokens: task.outputTokens,
      model: task.model, approvalId: task.approvalId, acceptance: task.acceptance,
      ...(task.onBehalfUser ? { onBehalfUser: task.onBehalfUser } : {}),
      createdAt: task.createdAt, startedAt: task.startedAt, finishedAt: task.finishedAt,
    }
  }

  /**
   * 任务读取（治理视图）：发起方本人、`*` 或持 a2a.directory.read 者可见，但**正文按权限脱敏**（Q-5）。
   * 只读治理视图点不应等于「全平台任务明文正文读取权」——message/artifacts/协商原文/历史流水
   * 属业务正文，需发起方本人、验收员（a2a.task.accept）或平台管理员才可见。
   */
  getTask(caller: CallerRefLike, taskId: string): A2aTaskRecord {
    const task = this.tasks().findOne((item) => item.taskId === taskId)
    if (!task) throw new NotFoundError(t('A2A 任务不存在：{id}', { id: taskId }))
    // 归属优先于组织收敛（P1-01）：任务发起方本人永远可读自己的任务——外部集成凭证
    // （refType=external）没有组织归属，组织判定对其恒为 false；若先判组织，归属短路
    // 永远不可达，第三方「派活 → tasks/get/list/cancel/SSE」闭环断裂。
    // 组织隔离（Q-4）只约束**非发起方**的治理读，不改变「发起方本人可见」的既有语义。
    const isOwner = task.callerPrincipalId === caller.principalId
    if (!isOwner) {
      // 组织隔离（Q-4）：下级组织账号即便持治理读权限，也只能读本组织子树的资源
      if (!this.canSeeOrg(caller, task.agentId)) {
        throw new ForbiddenError(t('无权查看该任务（超出你的组织可见范围）'))
      }
      if (!caller.permissions.includes('*') && !caller.permissions.includes('a2a.directory.read')) {
        throw new ForbiddenError(t('无权查看该任务（仅发起方或治理视图持有者）'))
      }
    }
    return task
  }

  /**
   * 组织可见性（R11 同口径）：`*` 全量；人类按自身 orgId 的子树；机器按其绑定 Agent 的 orgId 子树；
   * 无归属=fail-closed 空集。跨组织协作任务（调用方与被调方不同组织）以被调方员工的组织为判定面。
   */
  private canSeeOrg(caller: CallerRefLike, targetAgentId: string): boolean {
    if (caller.permissions.includes('*')) return true
    let orgId = caller.userId ? this.ctx.iam.users().get(caller.userId)?.orgId : undefined
    if (!orgId && caller.kind === 'machine' && caller.refType === 'agent' && caller.refId) {
      orgId = this.ctx.resourceCore.collection('agent').get(caller.refId)?.orgId
    }
    if (!orgId) return false
    const targetOrg = this.ctx.resourceCore.collection('agent').get(targetAgentId)?.orgId
    if (!targetOrg) return true // 无组织归属的资源（存量数据）不因组织过滤而消失
    return this.ctx.iam.orgSubtreeIds(orgId).includes(targetOrg)
  }

  /** 可见组织集合（供列表类治理视图统一过滤）。 */
  private visibleOrgIds(caller: CallerRefLike): Set<string> | null {
    if (caller.permissions.includes('*')) return null
    let orgId = caller.userId ? this.ctx.iam.users().get(caller.userId)?.orgId : undefined
    if (!orgId && caller.kind === 'machine' && caller.refType === 'agent' && caller.refId) {
      orgId = this.ctx.resourceCore.collection('agent').get(caller.refId)?.orgId
    }
    if (!orgId) return new Set<string>() // fail-closed：无归属=空集
    return new Set(this.ctx.iam.orgSubtreeIds(orgId))
  }

  /** 任务写操作（取消/续答/验收回写）的严格所有权判定（Q-2）。 */
  private assertTaskOwner(task: A2aTaskRecord, caller: CallerRefLike, action: string): void {
    if (task.callerPrincipalId === caller.principalId || caller.permissions.includes('*')) return
    throw new ForbiddenError(t('仅任务发起方可{action}该任务（治理读权限不含写语义）', { action }))
  }

  listTasks(filter: { agentId?: string; contextId?: string; state?: string; callerPrincipalId?: string; limit?: number }, caller?: CallerRefLike): A2aTaskRecord[] {
    // 无 caller（平台内部治理调用）或 `*` → 不收敛；其余按「本人任务 ∪ 组织可见」过滤。
    const unrestricted = !caller || caller.permissions.includes('*')
    return this.tasks().all()
      .filter((task) => (filter.agentId ? task.agentId === filter.agentId : true))
      .filter((task) => (filter.contextId ? task.contextId === filter.contextId : true))
      .filter((task) => (filter.state ? task.state === filter.state : true))
      .filter((task) => (filter.callerPrincipalId ? task.callerPrincipalId === filter.callerPrincipalId : true))
      // 归属优先（P1-01）：发起方本人总能看到自己的任务；组织隔离（Q-4）只收敛非发起方的治理读。
      // 外部集成凭证（refType=external）无组织归属，若只按组织过滤，tasks/list 对其恒为空集。
      .filter((task) => {
        if (unrestricted) return true
        if (task.callerPrincipalId === caller.principalId) return true
        return this.canSeeOrg(caller, task.agentId)
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(filter.limit ?? 100, 500))
  }

  /** 取消（写操作）：严格所有权判定——治理读权限点不含跨主体写语义（Q-2）。 */
  cancelTask(caller: CallerRefLike, taskId: string, reason: string): A2aTaskRecord {
    const task = this.getTask(caller, taskId)
    this.assertTaskOwner(task, caller, '取消')
    if (A2A_TERMINAL_STATES.includes(task.state)) throw new Error(t('任务已终态（{state}），不可取消', { state: task.state }))
    this.transition(taskId, 'canceled', reason || t('调用方主动取消'))
    this.ctx.platformBus.emit('a2a.task.cancel', { taskId, reason })
    this.auditTask(this.tasks().findOne((item) => item.taskId === taskId)!, 'a2a.task.canceled', 'ok', reason)
    return this.tasks().findOne((item) => item.taskId === taskId)!
  }

  /**
   * 交付验收（人工）：Task completed ≠ 业务闭环，验收通过才归档（协作方案 §6.3 验收不轻信自报）。
   * 职责分离（Q-30）：发起人不可验收自己发起的任务——否则验收通过率可被自验收刷高。
   */
  acceptTask(actor: { userId: string; name: string }, taskId: string, decision: 'accepted' | 'rejected', reason: string): A2aTaskRecord {
    const task = this.tasks().findOne((item) => item.taskId === taskId)
    if (!task) throw new NotFoundError(t('A2A 任务不存在：{id}', { id: taskId }))
    if (task.state !== 'completed') throw new Error(t('仅 completed 任务可验收（当前 {state}）——不轻信自报，未完成不进验收', { state: task.state }))
    if (!reason.trim()) throw new Error(t('验收必须填写理由（护栏要求）'))
    if (task.callerUserId === actor.userId) {
      throw new ForbiddenError(t('职责分离：任务发起人不可验收自己发起的任务（请由其他验收人复核）'))
    }
    this.tasks().update(task.id, { acceptance: { status: decision, by: actor.userId, at: new Date().toISOString(), reason } })
    this.ctx.audit.record({
      type: 'change', actorType: 'human', actorId: actor.userId, actorName: actor.name,
      action: 'a2a.task.acceptance', resourceType: 'agent', resourceId: task.agentId, resourceName: task.agentSlug,
      result: 'ok', detail: `task=${taskId} decision=${decision} reason=${reason}`,
    })
    return this.tasks().findOne((item) => item.taskId === taskId)!
  }

  /** 协作履约视图（接收数/完成率/耗时/中断次数/验收通过率）。 */
  fulfillment(caller?: CallerRefLike) {
    const all = this.listTasks({}, caller)
    const byAgent = new Map<string, A2aTaskRecord[]>()
    for (const task of all) {
      const list = byAgent.get(task.agentId) ?? []
      list.push(task)
      byAgent.set(task.agentId, list)
    }
    const durations = (tasks: A2aTaskRecord[]) => tasks
      .filter((task) => task.startedAt && task.finishedAt)
      .map((task) => new Date(task.finishedAt!).getTime() - new Date(task.startedAt!).getTime())
      .sort((a, b) => a - b)
    const p95 = (values: number[]) => values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * 0.95) - 1))]!
    return [...byAgent.entries()].map(([agentId, tasks]) => {
      const completed = tasks.filter((task) => task.state === 'completed')
      const accepted = tasks.filter((task) => task.acceptance?.status === 'accepted')
      const agent = this.ctx.resourceCore.get('agent', agentId)
      const avg = durations(tasks)
      return {
        agentId,
        agentSlug: agent?.slug ?? tasks[0]?.agentSlug ?? agentId,
        agentName: agent?.name ?? tasks[0]?.agentSlug ?? agentId,
        received: tasks.length,
        completed: completed.length,
        failed: tasks.filter((task) => task.state === 'failed').length,
        canceled: tasks.filter((task) => task.state === 'canceled').length,
        rejected: tasks.filter((task) => task.state === 'rejected').length,
        interrupted: tasks.filter((task) => task.state === 'input_required' || task.state === 'auth_required').length,
        acceptanceAccepted: accepted.length,
        acceptanceRejected: tasks.filter((task) => task.acceptance?.status === 'rejected').length,
        completionRate: tasks.length === 0 ? 0 : Math.round((completed.length / tasks.length) * 1000) / 1000,
        acceptancePassRate: completed.length === 0 ? 0 : Math.round((accepted.length / completed.length) * 1000) / 1000,
        avgDurationMs: avg.length === 0 ? 0 : Math.round(avg.reduce((sum, value) => sum + value, 0) / avg.length),
        p95DurationMs: p95(avg),
        inputTokens: tasks.reduce((sum, task) => sum + (task.inputTokens ?? 0), 0),
        outputTokens: tasks.reduce((sum, task) => sum + (task.outputTokens ?? 0), 0),
      }
    }).sort((a, b) => b.received - a.received)
  }

  /** 声明-授权一致性巡检（能力漂移治理）：卡片声明 ∩ 授权集 vs harness 自报/注册表。 */
  runPatrol(actor: string): A2aPatrolRecord {
    const findings: A2aPatrolRecord['findings'] = []
    const online = this.ctx.resourceCore.list('agent').filter((item) => item.status === 'online')
    for (const agent of online) {
      const issues: string[] = []
      const attrs = agent.attrs
      // ① 技能声明漂移：attrs.skills 引用了非 published 的 Skill（下架/弃用未同步）
      const slugs = Array.isArray(attrs['skills']) ? (attrs['skills'] as unknown[]).map(String) : []
      for (const slug of slugs) {
        const skill = this.ctx.skillHub.skills().find((item) => item.slug === slug)[0]
        if (!skill || skill.status !== 'published') issues.push(t('声明漂移：引用的 Skill「{slug}」已不在架（发布状态 {status}），卡片不会投影（声明≤授权已兜底），请清理 attrs.skills', { slug, status: skill?.status ?? '不存在' }))
      }
      // ② MCP 权限组漂移：引用的权限组已删除
      for (const group of this.ctx.mcpRegistry.permGroups().all()) {
        void group
      }
      const groupSubjects = this.ctx.mcpRegistry.permGroups().all().filter((group) => group.subjects.some((subject) => subject.type === 'agent' && subject.id === agent.id))
      for (const permGroupId of Array.isArray(attrs['mcpPermGroupIds']) ? (attrs['mcpPermGroupIds'] as unknown[]).map(String) : []) {
        if (!this.ctx.mcpRegistry.permGroups().get(permGroupId)) issues.push(t('授权漂移：登记的 MCP 权限组 {id} 已不存在，请清理 mcpPermGroupIds', { id: permGroupId }))
      }
      // ③ harness 注册表漂移：uhpHarnessRef 指向缺失/停用/模型离线（uhpGateway 已进 inject——
      //    只读治理探测，任务协作状态流仍只走总线；纪律例外已在 contract-c3 v2 发布说明登记）
      const harnessRef = String(attrs['uhpHarnessRef'] ?? '').trim()
      if (harnessRef) {
        const harness = this.ctx.uhpGateway.harnesses().get(harnessRef)
        if (!harness) issues.push(t('harness 漂移：uhpHarnessRef 指向的 {id} 不存在，执行将诚实失败', { id: harnessRef }))
        else if (!harness.enabled) issues.push(t('harness 漂移：{id} 已停用', { id: harnessRef }))
        else {
          const model = this.ctx.modelGateway.models().find((item) => item.slug === harness.model)[0]
          if (!model || model.status !== 'online') issues.push(t('harness 漂移：{id} 绑定模型 {model} 不在线', { id: harnessRef, model: harness.model }))
        }
      }
      // ④ 天花板一致性：A2A 天花板不得高于 modelgw 渠道可达口径的机密级映射（D14 显式映射提示）
      if (attrs['a2aDataClassCeiling'] === 'secret' && String(attrs['dataClass'] ?? '') === 'secret') {
        issues.push(t('密级口径提示：A2A 天花板=secret 且业务密级=secret（绝密禁止 Agent 处理口径），执行面将按渠道锁死拒绝——请确认口径'))
      }
      if (issues.length > 0) {
        findings.push({ agentId: agent.id, agentName: agent.name, findings: issues })
        this.ctx.audit.fire({
          severity: 'warning',
          title: t('数字员工「{name}」声明-授权一致性巡检发现 {n} 项漂移', { name: agent.name, n: issues.length }),
          message: issues.join('；'),
          resourceType: 'agent',
          resourceId: agent.id,
        })
      }
      void groupSubjects
    }
    const report: A2aPatrolRecord = {
      id: newId('a2ap'),
      at: new Date().toISOString(),
      actor,
      checkedAgents: online.length,
      driftAgents: findings.length,
      findings,
    }
    this.patrols().insert(report)
    this.ctx.audit.record({
      type: 'change', actorType: 'system', actorId: 'a2a-patrol', actorName: 'A2A 一致性巡检',
      action: 'a2a.patrol.run', resourceType: 'platform', resourceId: 'a2a', resourceName: t('协作平面'),
      result: 'ok', detail: t('巡检 {checked} 名在线员工，{drift} 名存在漂移', { checked: online.length, drift: findings.length }),
    })
    return report
  }

  /** 恢复执行（审批通过执行器回调）：auth_required → submitted → 派发（幂等防重由 attempts 键保证）。 */
  resumeFromApproval(taskId: string): void {
    const task = this.tasks().findOne((item) => item.taskId === taskId)
    if (!task || task.state !== 'auth_required') return
    this.dispatchTask(task)
  }
}

// ---------------------------------------------------------------------------
// 内部类型与错误
// ---------------------------------------------------------------------------

interface CallerRefLike {
  kind: 'human' | 'machine'
  principalId: string
  userId?: string
  refType?: string
  refId?: string
  name: string
  permissions: string[]
  actChain?: Array<{ name: string; type: string }>
  /** OBO 真实发起人（Q-6）：人类经 OBO 令牌代表员工发起协作时，由令牌 act 链解析得到。 */
  onBehalfOfUser?: string
  /** OBO 完整身份链（透传给 UHP 执行面，审计可还原「谁代表谁」）。 */
  oboActChain?: Array<{ principalId: string; name: string; type: string }>
}

interface UhpProgressLike {
  taskId?: string
  responseId?: string
  phase: 'started' | 'delta' | 'completed' | 'failed' | 'canceled'
  text?: string
  error?: string
  inputTokens?: number
  outputTokens?: number
  model?: string
}

export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
export class GovernanceError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    a2aCollab: A2aCollabService
  }
}

export const name = 'a2a'
// uhpGateway：声明-授权一致性巡检对 harness 注册表的只读治理探测（cordis inject 强制显式声明；
// 仅读注册表，任务协作状态流仍只走 ctx.platformBus——纪律例外已在 contract-c3 v2 发布说明登记）。
// workforceIdentity：治理检查第 2 项 permit 覆盖的**唯一**判定来源（P2-01：此前漏声明导致
// Service 代理读未注入键抛错、异常被 catch 吞掉按 legacy 放行，治理第 2 项实为空操作）。
export const inject = ['opsStorage', 'platformBus', 'httpServer', 'resourceCore', 'authn', 'iam', 'audit', 'usage', 'modelGateway', 'skillHub', 'mcpRegistry', 'agentRegistry', 'uhpGateway', 'workforceIdentity']

export function apply(ctx: Context) {
  const collab = new A2aCollabService(ctx)
  const gate = createRestGate(ctx)
  // 命名约定：http 别名让 contract-lint 的路由字面量扫描器识别 http.register 声明面
  const http = ctx.httpServer

  // 启动期向 iam 的 PermissionCatalog 幂等补录 A2A 权限点（先例：plugin-agent exec.read/exec.write 补录）
  for (const entry of [
    { point: 'a2a.directory.read', label: '读取 A2A 协作目录与任务治理视图', group: 'A2A 协作' },
    { point: 'a2a.task.accept', label: 'A2A 协作任务交付验收', group: 'A2A 协作' },
    { point: 'a2a.admin', label: '管理 A2A 审批规则与一致性巡检', group: 'A2A 协作' },
  ]) {
    if (!PermissionCatalog.some((item) => item.point === entry.point)) PermissionCatalog.push(entry)
  }

  // -- Agent Card 发现（A2A 规范 well-known；裸体 JSON——外部通用解析器可直接消费，见 Q-31） ----
  const sendRawJson = (exchange: HttpExchange, payload: unknown): void => {
    if (exchange.res.headersSent) return
    exchange.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    exchange.res.end(JSON.stringify(payload))
  }
  const wellKnownCard = (exchange: HttpExchange, slug: string) => {
    const agent = collab.resolveAgent(slug)
    if (!agent || agent.status !== 'online') {
      exchange.fail(404, 'NOT_FOUND', t('数字员工不存在或未上线：{slug}', { slug }))
      return
    }
    // A2A 规范要求 well-known 返回裸卡片体（此前包在平台 {ok,data} 信封里，外部解析器无法直接消费）
    sendRawJson(exchange, collab.cardFor(agent))
  }
  http.register('GET', '/.well-known/agent-card.json', (exchange) => {
    sendRawJson(exchange, collab.platformCard())
  })
  http.register('GET', '/.well-known/agents/:slug/agent-card.json', (exchange) => {
    wellKnownCard(exchange, exchange.params['slug'] ?? '')
  })

  // -- 目录检索（跨运行时发现，权限点 a2a.directory.read） -----------------------------------
  gate.guarded('GET', '/api/a2a/directory', 'a2a.directory.read', (exchange) => {
    const caller = gate.caller(exchange)
    return {
      agents: collab.directory({
        skill: exchange.query.get('skill') ?? undefined,
        q: exchange.query.get('q') ?? undefined,
        runtime: exchange.query.get('runtime') ?? undefined,
        autonomy: exchange.query.get('autonomy') ?? undefined,
        dataClass: exchange.query.get('dataClass') ?? undefined,
        category: exchange.query.get('category') ?? undefined,
      }, caller),
    }
  })

  // -- A2A 主端点（JSON-RPC 2.0；复用 v1 权限点 agent.a2a.invoke） ---------------------------
  const jsonRpcError = (exchange: HttpExchange, id: unknown, code: number, message: string, data?: Record<string, unknown>) => {
    exchange.ok({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } })
  }
  gate.guarded('POST', '/api/agents/:slug/a2a', 'agent.a2a.invoke', async (exchange) => {
    const body = gate.body<{ jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }>(exchange)
    const id = body.id ?? null
    const method = String(body.method ?? '')
    const params = (body.params ?? {}) as {
      message?: string | { parts?: Array<{ kind?: string; text?: string }>; text?: string }
      metadata?: Record<string, unknown>
      taskId?: string
      contextId?: string
      state?: string
      limit?: number
      reason?: string
    }
    const caller = gate.caller(exchange)
    const extractText = (): string => {
      if (typeof params.message === 'string') return params.message
      if (typeof params.message?.text === 'string') return params.message.text
      const parts = params.message?.parts ?? []
      return parts.map((part) => part.text ?? '').filter(Boolean).join('\n')
    }
    const metadata = params.metadata ?? {}
    // OBO 身份链（Q-6）：令牌 act 链里含人类（OBO 令牌）时，真实发起人写入任务与审计——
    // 身份一律取自令牌解析结果，禁止从 metadata 自述（与 NAS X-On-Behalf-User 红线同纪律）。
    const obo = actChainOf(ctx, exchange)
    const effectiveCaller: CallerRefLike = obo ? { ...caller, onBehalfOfUser: obo.principalId, oboActChain: obo.actChain } : caller
    try {
      if (method === 'message/send' || method === 'message/stream') {
        const task = await collab.sendMessage({
          caller: effectiveCaller,
          agentRef: exchange.params['slug'] ?? '',
          message: extractText(),
          ...(typeof metadata['dataClass'] === 'string' ? { dataClass: metadata['dataClass'] } : {}),
          ...(typeof metadata['contextId'] === 'string' ? { contextId: metadata['contextId'] } : {}),
          ...(typeof metadata['taskId'] === 'string' ? { taskId: metadata['taskId'] } : {}),
          negotiation: metadata['negotiation'],
        })
        // Q-8 协议同构：message/send 与 message/stream 均返回 JSON-RPC 信封中的 Task；
        // 流式进度由专用 SSE 端点承载（/v1/a2a/tasks/:taskId/events，Agent Card 已声明）——
        // 同一端点不再返回裸 SSE，外部客户端无需为同一 URL 写两套解析分支。
        // 同步等待至终态或超时（长任务客户端经 tasks/get / SSE 续查）
        const settled = await waitForTerminal(collab, task.taskId, Number(process.env.A2A_SYNC_WAIT_MS ?? 12000))
        return { jsonrpc: '2.0', id, result: { task: collab.taskView(settled, caller) } }
      }
      if (method === 'tasks/get') {
        const task = collab.getTask(caller, String(params.taskId ?? ''))
        return { jsonrpc: '2.0', id, result: { task: collab.taskView(task, caller) } }
      }
      if (method === 'tasks/list') {
        const tasks = collab.listTasks({
          ...(typeof metadata['agentId'] === 'string' ? { agentId: metadata['agentId'] } : {}),
          ...(typeof params.contextId === 'string' ? { contextId: params.contextId } : {}),
          ...(typeof params.state === 'string' ? { state: params.state } : {}),
          callerPrincipalId: caller.permissions.includes('*') || caller.permissions.includes('a2a.directory.read') ? undefined : caller.principalId,
          limit: typeof params.limit === 'number' ? params.limit : 50,
        }, effectiveCaller)
        return { jsonrpc: '2.0', id, result: { tasks: tasks.map((task) => collab.taskView(task, caller)) } }
      }
      if (method === 'tasks/cancel') {
        const task = collab.cancelTask(caller, String(params.taskId ?? ''), String(params.reason ?? ''))
        return { jsonrpc: '2.0', id, result: { task: collab.taskView(task, caller) } }
      }
      jsonRpcError(exchange, id, -32601, t('未知 A2A 方法：{method}（支持 message/send·stream、tasks/get·list·cancel）', { method }))
    } catch (error) {
      if (error instanceof NotFoundError) return jsonRpcError(exchange, id, -32001, error.message)
      if (error instanceof GovernanceError) return jsonRpcError(exchange, id, -32002, error.message, { code: error.code })
      // 归属/写闸门拒绝用保留码 -32003（与参数错误 -32000 区分，便于客户端与审计分流）
      if (error instanceof ForbiddenError) return jsonRpcError(exchange, id, -32003, error.message, { code: 'FORBIDDEN' })
      return jsonRpcError(exchange, id, -32000, error instanceof Error ? error.message : String(error))
    }
  })

  // -- 任务流式事件（SSE；/v1 协议面自校验 ?token=，EventSource 无法带 Bearer） ----------------
  http.register('GET', '/v1/a2a/tasks/:taskId/events', (exchange) => {
    const token = exchange.query.get('token') ?? ''
    if (!token) {
      ctx.platformBus.emit('audit.authz.denied', { actorId: '(anon)', actorName: t('匿名请求'), point: 'a2a.task.events', path: exchange.path, detail: t('缺少 token 参数') })
      exchange.fail(401, 'UNAUTHORIZED', t('缺少 token 参数（SSE 端点自校验，fail-closed）'))
      return
    }
    let verified: VerifiedPrincipal
    try {
      verified = ctx.authn.verify(token)
    } catch (error) {
      // Q-28：令牌非法/过期映射 401（与 /api 域鉴权口径一致），不再混入 400 参数错误；拒绝路径留痕（Q-27）
      ctx.platformBus.emit('audit.authz.denied', { actorId: '(anon)', actorName: t('匿名请求'), point: 'a2a.task.events', path: exchange.path, detail: t('令牌校验失败') })
      exchange.fail(401, 'TOKEN_INVALID', error instanceof Error ? error.message : String(error))
      return
    }
    try {
      if (!verified.scopes.includes('agent.a2a.invoke') && !verified.scopes.includes('*') && !verified.scopes.includes('a2a.directory.read')) {
        ctx.platformBus.emit('audit.authz.denied', { actorId: verified.principal.id, actorName: verified.principal.name, point: 'a2a.task.events', path: exchange.path })
        exchange.fail(403, 'FORBIDDEN', t('缺少权限点 agent.a2a.invoke / a2a.directory.read'))
        return
      }
      const caller: CallerRefLike = {
        kind: verified.principal.type, principalId: verified.principal.id, name: verified.principal.name,
        permissions: verified.scopes,
        ...(verified.principal.refType ? { refType: verified.principal.refType } : {}),
        ...(verified.principal.refId ? { refId: verified.principal.refId } : {}),
      }
      const task = collab.getTask(caller, exchange.params['taskId'] ?? '')
      streamTaskEvents(exchange, ctx, collab, task.taskId, caller)
    } catch (error) {
      // Q-28：语义分流——不存在 404 / 无权 403 / 其余 400
      if (error instanceof NotFoundError) { exchange.fail(404, 'NOT_FOUND', error.message); return }
      if (error instanceof ForbiddenError) { exchange.fail(403, 'FORBIDDEN', error.message); return }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  })

  // -- 治理视图 REST（console 数据源；目录读权限即可读，验收单列权限点） ------------------------
  gate.guarded('GET', '/api/a2a/tasks', 'a2a.directory.read', (exchange) => {
    const caller = gate.caller(exchange)
    return {
      tasks: collab.listTasks({
        agentId: exchange.query.get('agentId') ?? undefined,
        contextId: exchange.query.get('contextId') ?? undefined,
        state: exchange.query.get('state') ?? undefined,
        limit: Number(exchange.query.get('limit') ?? 100) || 100,
      }, caller).map((task) => collab.taskView(task, caller)),
    }
  })
  gate.guarded('GET', '/api/a2a/tasks/:taskId', 'a2a.directory.read', (exchange) => {
    const caller = gate.caller(exchange)
    // Q-29：REST 详情与 RPC tasks/get 同一实现（getTask），消除两套归属口径
    try {
      return { task: collab.taskView(collab.getTask(caller, exchange.params['taskId'] ?? ''), caller) }
    } catch (error) {
      if (error instanceof NotFoundError) { exchange.fail(404, 'NOT_FOUND', error.message); return }
      if (error instanceof ForbiddenError) { exchange.fail(403, 'FORBIDDEN', error.message); return }
      throw error
    }
  })
  gate.guarded('POST', '/api/a2a/tasks/:taskId/acceptance', 'a2a.task.accept', (exchange) => {
    const input = gate.body<{ decision?: string; reason?: string }>(exchange)
    const info = gate.caller(exchange)
    if (info.kind !== 'human' || !info.userId) {
      exchange.fail(403, 'FORBIDDEN', t('交付验收仅限人类用户（验收不轻信自报，人在环收口）'))
      return
    }
    const decision = input.decision === 'rejected' ? 'rejected' : input.decision === 'accepted' ? 'accepted' : ''
    if (!decision) {
      exchange.fail(400, 'BAD_REQUEST', t('decision 必须为 accepted / rejected'))
      return
    }
    try {
      const task = collab.acceptTask({ userId: info.userId, name: info.name }, exchange.params['taskId'] ?? '', decision, String(input.reason ?? ''))
      return { task: collab.taskView(task, info) }
    } catch (error) {
      if (error instanceof ForbiddenError) { exchange.fail(403, 'FORBIDDEN', error.message); return }
      throw error
    }
  })
  gate.guarded('GET', '/api/a2a/fulfillment', 'a2a.directory.read', (exchange) => ({ fulfillment: collab.fulfillment(gate.caller(exchange)) }))

  // -- 审批规则与巡检（a2a.admin） ----------------------------------------------------------
  gate.guarded('GET', '/api/a2a/rules', 'a2a.directory.read', () => ({ rules: collab.rules().all() }))
  gate.guarded('POST', '/api/a2a/rules', 'a2a.admin', (exchange) => {
    const input = gate.body<{ name?: string; matchDataClassAtLeast?: string; matchKeyword?: string; enabled?: boolean }>(exchange)
    if (!input.name?.trim()) throw new Error(t('规则名称必填'))
    if (!input.matchDataClassAtLeast && !input.matchKeyword) throw new Error(t('至少配置一个匹配条件（matchDataClassAtLeast / matchKeyword）'))
    if (input.matchDataClassAtLeast && input.matchDataClassAtLeast !== 'internal' && input.matchDataClassAtLeast !== 'secret') {
      throw new Error(t('matchDataClassAtLeast 仅支持 internal / secret'))
    }
    const rule = collab.rules().insert({
      id: newId('a2ar'),
      name: input.name,
      ...(input.matchDataClassAtLeast ? { matchDataClassAtLeast: input.matchDataClassAtLeast as 'internal' | 'secret' } : {}),
      ...(input.matchKeyword ? { matchKeyword: input.matchKeyword } : {}),
      enabled: input.enabled ?? true,
      createdBy: gate.actorOf(exchange),
    })
    gate.changeLog(exchange, 'a2a.rule.create', 'a2a_rule', rule.id, rule.name)
    return { rule }
  })
  gate.guarded('DELETE', '/api/a2a/rules/:id', 'a2a.admin', (exchange) => {
    const removed = collab.rules().remove(exchange.params['id'] ?? '')
    if (!removed) {
      exchange.fail(404, 'NOT_FOUND', t('规则不存在：{id}', { id: exchange.params['id'] ?? '' }))
      return
    }
    gate.changeLog(exchange, 'a2a.rule.delete', 'a2a_rule', exchange.params['id'] ?? '', exchange.params['id'] ?? '')
    return { deleted: true }
  })
  gate.guarded('POST', '/api/a2a/patrol/run', 'a2a.admin', (exchange) => {
    const report = collab.runPatrol(gate.actorOf(exchange))
    return { report }
  })
  gate.guarded('GET', '/api/a2a/patrols', 'a2a.directory.read', (exchange) => ({
    patrols: collab.patrols().all().sort((a, b) => b.at.localeCompare(a.at)).slice(0, Math.min(Number(exchange.query.get('limit') ?? 20) || 20, 100)),
  }))

  // -- 审批执行器：a2a.task.authorize 通过 → 恢复执行（幂等防重） ------------------------------
  ctx.effect(() => ctx.audit.registerExecutor('a2a.task.authorize', async (payload) => {
    collab.resumeFromApproval(String(payload.taskId ?? ''))
    return { resumed: true }
  }))

  // -- 例行一致性巡检（能力漂移治理；A2A_PATROL_INTERVAL_MINUTES，默认 60，0=关闭） -------------
  const intervalMinutes = Number(process.env.A2A_PATROL_INTERVAL_MINUTES ?? 60)
  if (Number.isFinite(intervalMinutes) && intervalMinutes > 0) {
    const first = setTimeout(() => {
      try { collab.runPatrol('system-routine') } catch (error) { ctx.logger('a2a').warn('例行一致性巡检失败', error) }
    }, 60_000)
    first.unref?.()
    const timer = setInterval(() => {
      try { collab.runPatrol('system-routine') } catch (error) { ctx.logger('a2a').warn('例行一致性巡检失败', error) }
    }, intervalMinutes * 60_000)
    timer.unref?.()
    ctx.effect(() => () => {
      clearTimeout(first)
      clearInterval(timer)
    })
  }
}

// ---------------------------------------------------------------------------
// 共用工具（同步等待 + SSE 流）
// ---------------------------------------------------------------------------

/**
 * OBO 身份链解析（Q-6）：令牌 act 链中含 type=human 的条目即为「代表该人类行事」——
 * 返回真实发起人 principalId 与完整链，供任务记录/审计/dispatch 透传；非 OBO 令牌返回 undefined。
 * MCP 治理（契约 §2/§4，2026-10-22）：与 platform-core humanDelegatorOf 语义对齐——链首
 * （数组首位，issueOnBehalfOf 语义「父链+父主体」的发起人）human 条目即真实发起人；身份事实
 * 只取令牌解析结果（自校验 verify），禁止从请求参数/header 声明。对外行为不变。
 */
function actChainOf(ctx: Context, exchange: HttpExchange): { principalId: string; actChain: Array<{ principalId: string; name: string; type: string }> } | undefined {
  const header = String(exchange.headers['authorization'] ?? '')
  const token = header.startsWith('Bearer ') ? header.slice(7) : header
  if (!token) return undefined
  try {
    const verified = ctx.authn.verify(token)
    const human = verified.actChain.find((entry) => entry.type === 'human')
    if (!human) return undefined
    return {
      principalId: human.principalId,
      actChain: verified.actChain.map((entry) => ({ principalId: entry.principalId, name: entry.name, type: entry.type })),
    }
  } catch {
    return undefined // 令牌已由鉴权中间件校验过；此处仅取身份，不重复报错
  }
}

async function waitForTerminal(collab: A2aCollabService, taskId: string, timeoutMs: number) {
  const deadline = Date.now() + Math.max(timeoutMs, 0)
  for (;;) {
    const task = collab.tasks().findOne((item) => item.taskId === taskId)
    if (!task) throw new Error(t('A2A 任务不存在：{id}', { id: taskId }))
    if (A2A_TERMINAL_STATES.includes(task.state) || Date.now() >= deadline) return task
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** SSE：历史回放 + 订阅 a2a.task.changed / a2a.task.progress 至终态。 */
function streamTaskEvents(exchange: HttpExchange, ctx: Context, collab: A2aCollabService, taskId: string, caller?: CallerRefLike): undefined {
  const task = collab.tasks().findOne((item) => item.taskId === taskId)
  if (!task) {
    exchange.fail(404, 'NOT_FOUND', t('A2A 任务不存在：{id}', { id: taskId }))
    return
  }
  const res = exchange.res
  if (res.headersSent) return
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write('retry: 5000\n\n')
  const send = (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  send('task.snapshot', collab.taskView(collab.tasks().findOne((item) => item.taskId === taskId)!, caller))
  if (A2A_TERMINAL_STATES.includes(task.state)) {
    send('task.terminal', { taskId, state: task.state })
    res.end()
    return
  }
  const onProgress = ctx.platformBus.on('a2a.task.progress', (payload) => {
    const p = payload as { taskId?: string; phase: string; text?: string; error?: string }
    if (p.taskId !== taskId) return
    send('task.progress', p)
    if (p.phase === 'completed' || p.phase === 'failed' || p.phase === 'canceled') {
      const latest = collab.tasks().findOne((item) => item.taskId === taskId)
      if (latest) send('task.snapshot', collab.taskView(latest, caller))
      send('task.terminal', { taskId, state: latest?.state ?? p.phase })
      cleanup()
      res.end()
    }
  })
  const onChanged = ctx.platformBus.on('a2a.task.changed', (payload) => {
    const p = payload as { taskId?: string; state: string }
    if (p.taskId !== taskId) return
    const latest = collab.tasks().findOne((item) => item.taskId === taskId)
    if (latest) send('task.snapshot', collab.taskView(latest, caller))
    if (A2A_TERMINAL_STATES.includes(p.state as never) || p.state === 'input_required' || p.state === 'auth_required') {
      send('task.terminal', { taskId, state: p.state })
      cleanup()
      res.end()
    }
  })
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 15_000)
  heartbeat.unref?.()
  const cleanup = () => {
    clearInterval(heartbeat)
    onProgress()
    onChanged()
  }
  exchange.raw.on('close', cleanup)
}
