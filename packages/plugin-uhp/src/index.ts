/**
 * @dsh-ops/plugin-uhp —— UHP（Unified Harness Protocol）执行驱动层（企业数字员工内网协作方案 §7）。
 *
 * 定位：v1 的 `a2a/invoke` 是「平台拿员工登记的模型直接回一句话」，没有任务生命周期；
 * 数字员工要真正被驱动执行，需要一个统一的执行面。本插件实现 UHP Server 协议面：
 *
 *   平台（A2A / 编排）── UHP Client ──▶ plugin-uhp（Server）──▶ configured harness 执行体
 *
 * 诚实边界（v1 口径，不做假实现）：
 *   - 内置 harness（runtime=dsh）= 单步真实模型执行：经 modelgw 分级路由与预算熔断真实调用模型，
 *     会话续接（previous_response_id）真实多轮；不做虚构的「工具执行循环」——工具面继续走 MCP 网关
 *     （受管数字员工的工具执行由 workforce 受控调用承担，见协作方案 §3 分工）；
 *   - 请求级 `tools` / 动态挂 MCP server 一律接受但不生效并记入 metadata.ignored_fields
 *     （越权原语封堵，协作方案 §7.2）——员工工具面只能由 configured harness 白名单声明；
 *   - 未配置模型端点时诚实报错，绝不生成假 completion（延续 modelgw 诚实边界）。
 *
 * 与 plugin-a2a 的联动纪律：只走 ctx.platformBus（a2a.task.dispatch / a2a.task.progress /
 * a2a.task.cancel），禁止直连对方插件数据（协作方案 §11 铁律）。
 *
 * 幂等对齐（协作方案 §7.2）：UHP Idempotency-Key 与 A2A Task 对齐，编织进既有计量幂等键模式
 * `a2a:<agentId>:<principal>:<taskId>`——同键重放返回原事件，跨节点重试不重复执行不双计。
 */
import { readFileSync as readTextFile, writeFileSync as writeTextFile } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  newId,
  createRestGate,
  type HttpExchange,
  type Collection,
  type RecordBase,
} from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'
import { PermissionCatalog } from '../../plugin-iam/src/index.ts'
import type { VerifiedPrincipal } from '../../plugin-authn/src/index.ts'
import { DATA_CLASS_RANK, type DataClass } from '../../plugin-modelgw/src/index.ts'

// ---------------------------------------------------------------------------
// 协议常量
// ---------------------------------------------------------------------------

/** 锁定的 UHP 协议版本（协作方案 §7.2：平台锁定一个已验证版本，/v1/uhp 响应即协商依据）。 */
export const UHP_VERSION = '2026-08-11'
/** 一致性等级目标：Core（任务/会话/取消）；Extended 的文件输入输出 v1 不声明、不做假实现。 */
export const UHP_CONFORMANCE_CLASS = 'core'

export type UhpResponseStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'canceled'

/** P0（Q-1）：外部调用试图绑定 A2A 任务时的专属错误（协议面以 400 TASK_BINDING_FORBIDDEN 下发）。 */
export class UhpBindingError extends Error {}
/** 归属校验失败（403）。 */
export class ForbiddenError extends Error {}

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/** configured harness（协作方案 §7.2）：uhpHarnessRef 指向的注册项——模型渠道、提示词、工具白名单与预算。 */
export interface UhpHarnessRecord extends RecordBase {
  /** harness id（对外稳定标识，Agent attrs.uhpHarnessRef 引用）。 */
  id: string
  /** 绑定的 Agent 资产 id。 */
  agentId: string
  /** 模型 slug（模型渠道组走 modelgw 分级路由与预算熔断）。 */
  model: string
  /** 可选渠道组 slug（配置则走 invokeWithFallback 降级链）。 */
  channelGroup?: string
  /** MCP 权限组白名单（工具面授权投影声明；v1 内置 harness 不执行工具，见文件头诚实边界）。 */
  toolPermGroupIds: string[]
  /** 步数预算（v1 单步执行，此为上限声明与巡检展示口径）。 */
  stepBudget: number
  /** 单任务时间预算（毫秒）。 */
  timeBudgetMs: number
  /** 该 harness 可接收的最高数据密级（modelgw 渠道分级之外的 harness 侧天花板）。 */
  dataClassCeiling: DataClass
  enabled: boolean
  createdBy: string
}

/** UHP 执行记录（Responses 兼容子集的 response 对象 + ybk metadata 扩展）。 */
export interface UhpResponseRecord extends RecordBase {
  id: string
  harnessId: string
  agentId: string
  /** 会话 id：task-bound=<a2a taskId>；employee-bound=`emp:<agentId>:<principalId>`；直调=独立生成。 */
  sessionId: string
  sessionPolicy: 'task-bound' | 'employee-bound'
  previousResponseId?: string
  status: UhpResponseStatus
  /** 全量对话快照（会话续接的数据源）。 */
  messagesJson: string
  outputText: string
  inputTokens: number
  outputTokens: number
  model: string
  dataClass: DataClass
  error?: string
  canceledAt?: string
  /** A2A 任务关联（仅平台内部 dispatch 路径可写，见 dispatchedByPlatform）。 */
  taskId?: string
  contextId?: string
  idempotencyKey?: string
  /**
   * P0（Q-1）执行归属：本次执行的真实调用主体。
   * 外部直调 = 持有 uhp.invoke 的 principal；平台派发 = a2a 任务的 callerPrincipalId。
   * response 读/取消按此判定归属（Q-3），审计按此记录真实主体（审计栽赃修复面）。
   */
  callerPrincipalId: string
  callerName: string
  callerKind: 'machine' | 'human' | 'system'
  /** OBO 身份链（act 链 JSON）——审计按真实发起人留痕，不允许调用方自述（Q-6）。 */
  actChainJson: string
  /** OBO 代表用户（平台内部派发路径从任务透传；外部直调经校验后写入，伪造值不入账）。 */
  onBehalfUser?: string
  /**
   * P0（Q-1）是否由平台 A2A 派发路径产生：仅 true 的记录允许携带 taskId 并驱动
   * `a2a.task.progress` 回传状态机——外部直调永远为 false，从协议面无法伪造。
   */
  dispatchedByPlatform: boolean
  /** 扩展元数据：ybk_* 绑定 + ignored_fields（越权原语封堵留痕）。 */
  metadataJson: string
}

export interface UhpDispatchPayload {
  taskId?: string
  contextId?: string
  agentId: string
  harnessRef?: string
  input: string
  dataClass: DataClass
  idempotencyKey: string
  sessionPolicy?: 'task-bound' | 'employee-bound'
  callerPrincipalId: string
  /** OBO 身份链（平台内部透传，真实发起人；不采信任何请求体自述）。 */
  onBehalfUser?: string
  actChain?: Array<{ principalId: string; name: string; type: string }>
  negotiationNote?: string
}

export interface UhpProgressPayload {
  taskId?: string
  responseId: string
  phase: 'started' | 'delta' | 'completed' | 'failed' | 'canceled'
  text?: string
  error?: string
  inputTokens?: number
  outputTokens?: number
  model?: string
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class UhpGatewayService extends Service {
  static readonly provide = 'uhpGateway'

  /** 执行中任务的取消登记（taskId → responseId）。 */
  private inflight = new Map<string, string>()
  /** 取消标记（responseId → true）：模型调用返回后据此丢弃结果（协作取消语义）。 */
  private cancelRequested = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'uhpGateway')
    // A2A 派发联动（只走事件总线纪律）：收到派发事件后异步启动执行——
    // 监听器本身立即返回（总线监听器 5s 超时），长任务在独立 Promise 中推进。
    ctx.platformBus.on('a2a.task.dispatch', (payload) => {
      const p = payload as UhpDispatchPayload
      void this.executeForTask(p).catch((error) => {
        this.ctx.logger('uhp').error('UHP 执行派发处理异常', error)
      })
    })
    // 取消联动：A2A tasks/cancel → UHP cancel（协议面）+ 响应作废标记
    ctx.platformBus.on('a2a.task.cancel', (payload) => {
      const p = payload as { taskId: string; reason?: string }
      const responseId = this.inflight.get(p.taskId)
      if (responseId) {
        this.cancelRequested.add(responseId)
        this.responses().update(responseId, { status: 'canceled', canceledAt: new Date().toISOString() })
      } else {
        // 无在途执行：找最近一条该任务的 response 标记取消（诚实幂等：已终态不覆盖）
        const existing = [...this.responses().find((item) => item.taskId === p.taskId)].pop()
        if (existing && (existing.status === 'queued' || existing.status === 'in_progress')) {
          this.responses().update(existing.id, { status: 'canceled', canceledAt: new Date().toISOString() })
        }
      }
    })
  }

  // -- 集合 -----------------------------------------------------------------

  harnesses(): Collection<UhpHarnessRecord> {
    return this.ctx.opsStorage.collection<UhpHarnessRecord>('uhp:harnesses', { durability: 'durable' })
  }

  responses(): Collection<UhpResponseRecord> {
    return this.ctx.opsStorage.collection<UhpResponseRecord>('uhp:responses', { durability: 'durable' })
  }

  // -- harness 注册表 --------------------------------------------------------

  upsertHarness(input: {
    id?: string
    agentId: string
    model: string
    channelGroup?: string
    toolPermGroupIds?: string[]
    stepBudget?: number
    timeBudgetMs?: number
    dataClassCeiling?: DataClass
    enabled?: boolean
    createdBy: string
  }): UhpHarnessRecord {
    const agent = this.ctx.resourceCore.get('agent', input.agentId)
    if (!agent) throw new Error(t('Agent 不存在：{id}（harness 必须绑定真实 Agent 资产）', { id: input.agentId }))
    if (!input.model.trim()) throw new Error(t('model 必填（harness 执行的模型 slug）'))
    const ceiling = input.dataClassCeiling ?? 'internal'
    if (!(ceiling in DATA_CLASS_RANK)) throw new Error(t('dataClassCeiling 非法：{value}（public/internal/secret）', { value: ceiling }))
    const stepBudget = input.stepBudget ?? 8
    const timeBudgetMs = input.timeBudgetMs ?? 120_000
    if (!(stepBudget > 0) || stepBudget > 64) throw new Error(t('stepBudget 须在 1-64 之间'))
    if (!(timeBudgetMs >= 5_000) || timeBudgetMs > 600_000) throw new Error(t('timeBudgetMs 须在 5000-600000 毫秒之间'))
    const existing = input.id ? this.harnesses().get(input.id) : undefined
    if (existing) {
      return this.harnesses().update(existing.id, {
        agentId: input.agentId,
        model: input.model,
        ...(input.channelGroup !== undefined ? { channelGroup: input.channelGroup } : {}),
        toolPermGroupIds: input.toolPermGroupIds ?? existing.toolPermGroupIds,
        stepBudget,
        timeBudgetMs,
        dataClassCeiling: ceiling,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : { enabled: existing.enabled }),
      })
    }
    const id = input.id?.trim() || newId('uhp')
    if (this.harnesses().get(id)) throw new Error(t('harness id 已存在：{id}', { id }))
    return this.harnesses().insert({
      id,
      agentId: input.agentId,
      model: input.model,
      ...(input.channelGroup ? { channelGroup: input.channelGroup } : {}),
      toolPermGroupIds: input.toolPermGroupIds ?? [],
      stepBudget,
      timeBudgetMs,
      dataClassCeiling: ceiling,
      enabled: input.enabled ?? true,
      createdBy: input.createdBy,
    })
  }

  removeHarness(id: string): boolean {
    return this.harnesses().remove(id)
  }

  /** 能力发现（GET /v1/uhp）：configured harness 清单按 runtime 视角呈现。 */
  discovery(): {
    uhp_version: string
    conformance_class: string
    capabilities: { files_input: boolean; files_output: boolean; session_listing: boolean; session_sharing: boolean; harness_management: boolean }
    harnesses: Array<{ id: string; configured: string[] }>
  } {
    const onlineAgents = new Map(this.ctx.resourceCore.list('agent').filter((item) => item.status === 'online').map((item) => [item.id, item.slug]))
    const byHarnessId = new Map<string, string[]>()
    for (const harness of this.harnesses().all()) {
      if (!harness.enabled) continue
      const slug = onlineAgents.get(harness.agentId)
      if (!slug) continue
      byHarnessId.set(harness.id, [slug])
    }
    return {
      uhp_version: UHP_VERSION,
      conformance_class: UHP_CONFORMANCE_CLASS,
      capabilities: {
        files_input: false,
        files_output: false,
        session_listing: true,
        session_sharing: false,
        harness_management: false,
      },
      harnesses: [...byHarnessId.entries()].map(([id, configured]) => ({ id, configured })),
    }
  }

  // -- 任务面 ---------------------------------------------------------------

  /**
   * 创建并启动一次 UHP 执行（幂等）：同 Idempotency-Key 的既有终态记录原样重放，
   * 在途记录直接返回（不重复执行）。返回 response 记录。
   *
   * P0（Q-1）任务绑定收口：`taskId` 仅接受平台 A2A 派发路径（`dispatchedByPlatform: true`）传入，
   * 服务层 fail-closed 兜底——即便未来有人从协议面误传 taskId，也不会建立任务归属。
   */
  async createResponse(input: {
    harnessRef?: string
    agentId: string
    inputText: string
    dataClass?: DataClass
    previousResponseId?: string
    idempotencyKey?: string
    taskId?: string
    contextId?: string
    sessionPolicy?: 'task-bound' | 'employee-bound'
    callerPrincipalId: string
    callerName?: string
    callerKind?: 'machine' | 'human' | 'system'
    actChain?: Array<{ principalId: string; name: string; type: string }>
    dispatchedByPlatform?: boolean
    onBehalfUser?: string
    requestTools?: unknown
    requestFunctions?: unknown
    requestMcpServers?: unknown
    negotiationNote?: string
  }): Promise<UhpResponseRecord> {
    if (!input.inputText?.trim()) throw new Error(t('input 必填（UHP 任务输入不能为空）'))
    const dispatched = input.dispatchedByPlatform === true
    // P0（Q-1）：任务绑定只认平台派发路径——非派发调用携带 taskId 一律拒绝（fail-closed）
    if (input.taskId && !dispatched) {
      throw new UhpBindingError(t('外部调用不得绑定 A2A 任务：ybk_a2a_task_id 仅允许由平台内部派发通道注入'))
    }
    // 幂等：同键重放返回原记录（协作方案 §7.2——跨节点重试不会重复执行也不会双计）
    if (input.idempotencyKey) {
      const existing = this.responses().find((item) => item.idempotencyKey === input.idempotencyKey)
      const latest = existing.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      if (latest) return latest
    }
    const agent = this.ctx.resourceCore.get('agent', input.agentId)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id: input.agentId }))
    if (agent.status !== 'online') throw new Error(t('Agent 未上线（{status}），UHP 仅对 online 执行体开放', { status: agent.status }))
    const harness = this.resolveHarness(agent, input.harnessRef)
    const requested: DataClass = input.dataClass ?? 'internal'
    if (DATA_CLASS_RANK[requested] > DATA_CLASS_RANK[harness.dataClassCeiling]) {
      throw new Error(t('数据密级越级：请求 {requested} 高于 harness 天花板 {ceiling}（渠道锁死拒绝口径）', { requested, ceiling: harness.dataClassCeiling }))
    }
    // 越权原语封堵：请求级 tools/functions/mcp_servers 一律接受但不生效，留痕 ignored_fields（协作方案 §7.2）
    const ignoredFields: string[] = []
    if (input.requestTools !== undefined) ignoredFields.push('tools')
    if (input.requestFunctions !== undefined) ignoredFields.push('functions')
    if (input.requestMcpServers !== undefined) ignoredFields.push('mcp_servers')
    // 会话续接（Q-23）：继承上一响应的 sessionId（使 session_id 成为可靠归组键），
    // 并把上一轮 assistant 回答回填进上下文——否则被调方「不知道自己上一轮说了什么」
    let messages: Array<{ role: string; content: string }> = []
    let inheritedSessionId = ''
    if (input.previousResponseId) {
      const prev = this.responses().get(input.previousResponseId)
      if (!prev) throw new Error(t('previous_response_id 不存在：{id}', { id: input.previousResponseId }))
      if (prev.agentId !== agent.id) throw new Error(t('previous_response_id 属于其他执行体，拒绝跨 harness 会话续接'))
      // 归属校验（Q-3 纵深）：会话续接仅限记录属主或其组织内持 uhp.read 的治理视图
      this.assertResponseAccess(prev, input.callerPrincipalId, ['uhp.read'])
      inheritedSessionId = prev.sessionId
      messages = JSON.parse(prev.messagesJson) as Array<{ role: string; content: string }>
      if (prev.outputText) messages = [...messages, { role: 'assistant', content: prev.outputText }]
    }
    const sessionPolicy = input.sessionPolicy ?? 'task-bound'
    const sessionId = sessionPolicy === 'task-bound'
      ? (input.taskId ?? (inheritedSessionId || newId('uhpsess')))
      : `emp:${agent.id}:${input.callerPrincipalId}`
    const systemPrompt = this.systemPromptFor(agent)
    if (!messages.some((item) => item.role === 'system')) messages = [{ role: 'system', content: systemPrompt }, ...messages]
    messages = [...messages, { role: 'user', content: input.negotiationNote ? `${input.inputText}\n\n（协商附注：${input.negotiationNote}）` : input.inputText }]
    const record = this.responses().insert({
      id: newId('resp'),
      harnessId: harness.id,
      agentId: agent.id,
      sessionId,
      sessionPolicy,
      ...(input.previousResponseId ? { previousResponseId: input.previousResponseId } : {}),
      status: 'queued',
      messagesJson: JSON.stringify(messages),
      outputText: '',
      inputTokens: 0,
      outputTokens: 0,
      model: harness.model,
      dataClass: requested,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.contextId ? { contextId: input.contextId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      callerPrincipalId: input.callerPrincipalId,
      callerName: input.callerName ?? input.callerPrincipalId,
      callerKind: input.callerKind ?? (dispatched ? 'system' : 'machine'),
      actChainJson: JSON.stringify(input.actChain ?? []),
      ...(input.onBehalfUser ? { onBehalfUser: input.onBehalfUser } : {}),
      dispatchedByPlatform: dispatched,
      metadataJson: JSON.stringify({
        ybk_agent_id: agent.id,
        ...(input.taskId ? { ybk_a2a_task_id: input.taskId } : {}),
        ybk_data_class: requested,
        ...(input.onBehalfUser ? { ybk_on_behalf_user: input.onBehalfUser } : {}),
        ignored_fields: ignoredFields,
      }),
    })
    this.run(record.id).catch((error) => {
      this.ctx.logger('uhp').error(`UHP 执行异常（response=${record.id}）`, error)
    })
    return record
  }

  /**
   * 执行记录归属校验（Q-3）：属主本人、`*`，或持列出的治理读权限点者方可读/取消。
   * 同层外部集成之间不得互相读取输入输出内容或取消在途执行（DoS + 数据泄露防护）。
   */
  private assertResponseAccess(record: UhpResponseRecord, principalId: string, overridePoints: string[]): void {
    if (record.callerPrincipalId === principalId) return
    throw new ForbiddenError(t('无权访问该执行记录（仅属主或持治理读权限者可访问）'))
    void overridePoints // 治理读权限点在 HTTP 层校验（CallerInfo.scopes 可见），服务层只认归属
  }

  response(id: string): UhpResponseRecord | undefined {
    return this.responses().get(id)
  }

  /**
   * 取消：终态诚实拒绝；在途执行标记取消，模型返回后结果不交付。
   * 归属校验（Q-3）：非属主不得取消他人执行记录（同层凭证间互不干扰）。
   */
  cancelResponse(id: string, reason: string, callerPrincipalId: string): UhpResponseRecord {
    const record = this.responses().get(id)
    if (!record) throw new Error(t('response 不存在：{id}', { id }))
    this.assertResponseAccess(record, callerPrincipalId, [])
    if (['completed', 'failed', 'canceled'].includes(record.status)) {
      throw new Error(t('response 已终态（{status}），不可取消', { status: record.status }))
    }
    this.cancelRequested.add(id)
    return this.responses().update(id, { status: 'canceled', canceledAt: new Date().toISOString(), error: reason })
  }

  /** 解析 harness：显式引用 → 注册表；未注册 → 从 Agent attrs 投影的临时配置（不改协作面行为）。 */
  private resolveHarness(agent: { id: string; attrs: Record<string, unknown> }, harnessRef?: string): UhpHarnessRecord {
    const ref = String(harnessRef ?? agent.attrs['uhpHarnessRef'] ?? '').trim()
    if (ref) {
      const found = this.harnesses().get(ref)
      if (!found) throw new Error(t('uhpHarnessRef 指向的 harness 不存在：{id}（请先在 UHP 注册或清空该引用）', { id: ref }))
      if (!found.enabled) throw new Error(t('harness 已停用：{id}', { id: ref }))
      return found
    }
    const model = String(agent.attrs['model'] ?? '').trim()
    if (!model) throw new Error(t('Agent 未配置模型（model 属性为空），无法执行'))
    const ceilingRaw = String(agent.attrs['a2aDataClassCeiling'] ?? 'internal')
    const ceiling: DataClass = ceilingRaw in DATA_CLASS_RANK ? (ceilingRaw as DataClass) : 'internal'
    return {
      id: `adhoc:${agent.id}`,
      agentId: agent.id,
      model,
      toolPermGroupIds: [],
      stepBudget: 1,
      timeBudgetMs: 120_000,
      dataClassCeiling: ceiling,
      enabled: true,
      createdBy: 'system',
      createdAt: '',
      updatedAt: '',
    }
  }

  private systemPromptFor(agent: { name: string; attrs: Record<string, unknown> }): string {
    const custom = String(agent.attrs['systemPrompt'] ?? '').trim()
    if (custom) return custom
    return t('你是企业数字同事「{name}」。{description}', { name: agent.name, description: String(agent.attrs['description'] ?? '') })
  }

  /** A2A 派发入口：包装 createResponse（唯一允许绑定 taskId 的通道），终态经总线回传（a2a.task.progress）。 */
  private async executeForTask(payload: UhpDispatchPayload): Promise<void> {
    try {
      const record = await this.createResponse({
        agentId: payload.agentId,
        harnessRef: payload.harnessRef,
        inputText: payload.input,
        dataClass: payload.dataClass,
        idempotencyKey: payload.idempotencyKey,
        taskId: payload.taskId,
        contextId: payload.contextId,
        sessionPolicy: payload.sessionPolicy,
        callerPrincipalId: payload.callerPrincipalId,
        callerKind: 'system',
        callerName: payload.callerPrincipalId,
        ...(payload.actChain ? { actChain: payload.actChain } : {}),
        // P0（Q-1）：仅平台派发路径置 true——这是外部调用无法伪造的绑定凭据
        dispatchedByPlatform: true,
        onBehalfUser: payload.onBehalfUser,
        negotiationNote: payload.negotiationNote,
      })
      if (record.status === 'queued' || record.status === 'in_progress') {
        // 等待终态（run 里的 promise 不在这里 await——由 progress 事件驱动 A2A 侧状态机）
        await this.awaitTerminal(record.id, payload.taskId)
      } else {
        // 幂等重放：把既有终态原样回传（A2A 侧据此收敛状态）
        this.emitProgress(record, record.status === 'completed' ? 'completed' : record.status === 'canceled' ? 'canceled' : 'failed')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.ctx.platformBus.emit('a2a.task.progress', {
        taskId: payload.taskId,
        responseId: '',
        phase: 'failed',
        error: reason,
      } satisfies UhpProgressPayload)
    }
  }

  /** 等待单条 response 终态（轮询轻量实现——执行体同进程，300ms 粒度足够）。 */
  private async awaitTerminal(responseId: string, taskId?: string): Promise<void> {
    for (let i = 0; i < 4000; i++) {
      const record = this.responses().get(responseId)
      if (!record) return
      if (['completed', 'failed', 'canceled'].includes(record.status)) {
        this.emitProgress(record, record.status === 'completed' ? 'completed' : record.status === 'canceled' ? 'canceled' : 'failed')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    // 兜底超时：标记失败（时间预算守卫，不悬挂调用方）
    if (taskId) {
      this.responses().update(responseId, { status: 'failed', error: t('执行超时（时间预算耗尽）') })
      this.emitProgress(this.responses().get(responseId)!, 'failed')
    }
  }

  /**
   * 进度回传：所有执行记录都发 `uhp.response.progress`（SSE 订阅面，P2-03 闭合外部直调流），
   * 但只有「平台 A2A 派发」记录才额外发 `a2a.task.progress` 驱动 A2A 状态机（P0 Q-1 核心闸门）。
   * 外部直调（dispatchedByPlatform=false）永不发出 a2a.task.progress——
   * 从根上杜绝「外部凭证借执行结果把他人任务推到终态」的劫持路径。
   */
  private emitProgress(record: UhpResponseRecord | undefined, phase: UhpProgressPayload['phase']): void {
    if (!record) return
    if (record.taskId) this.inflight.delete(record.taskId)
    const payload = {
      taskId: record.taskId,
      responseId: record.id,
      phase,
      ...(phase === 'completed' ? { text: record.outputText } : {}),
      ...(record.error ? { error: record.error } : {}),
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      model: record.model,
    } satisfies UhpProgressPayload
    // 执行记录事件（与任务事件分离）：内部直调/外部直调/平台派发统一可订阅——
    // 它不驱动任何 A2A 状态，因此不扩大 P0 攻击面（a2a.task.progress 的闸门保持不变）。
    this.ctx.platformBus.emit('uhp.response.progress', payload)
    if (!record.dispatchedByPlatform) return
    this.ctx.platformBus.emit('a2a.task.progress', payload)
  }

  /** 真实执行体（内置 dsh harness）：单步真实模型调用（modelgw 分级路由 + 预算熔断）。 */
  private async run(responseId: string): Promise<void> {
    const record = this.responses().get(responseId)
    if (!record) return
    const harness = this.harnesses().get(record.harnessId)
    const agent = this.ctx.resourceCore.get('agent', record.agentId)
    if (!agent) {
      this.finish(record.id, 'failed', { error: t('Agent 资产不存在（可能已被删除）') })
      return
    }
    const model = harness?.model ?? String(agent.attrs['model'] ?? '')
    if (!model) {
      this.finish(record.id, 'failed', { error: t('Agent 未配置模型（model 属性为空），诚实拒绝执行') })
      return
    }
    this.inflight.set(record.taskId ?? record.id, record.id)
    this.responses().update(record.id, { status: 'in_progress' })
    this.emitProgress(this.responses().get(record.id)!, 'started')
    try {
      if (record.taskId) this.inflight.set(record.taskId, record.id)
      const messages = JSON.parse(record.messagesJson) as Array<{ role: string; content: string }>
      const result = await this.ctx.modelGateway.invoke({
        model,
        orgId: agent.orgId ?? '',
        subject: `agent:${agent.id}`,
        dataClass: record.dataClass,
        messages,
      })
      if (this.cancelRequested.has(record.id)) {
        // 协作取消语义：结果不交付、不回写输出（取消方已收到 canceled 终态）
        this.cancelRequested.delete(record.id)
        this.auditExecution(this.responses().get(record.id)!, agent, 'uhp.invoke.canceled_after_completion', 'ok',
          t('模型已返回但任务已取消，结果不交付（取消语义）'))
        this.emitProgress(this.responses().get(record.id), 'canceled')
        return
      }
      this.responses().update(record.id, {
        status: 'completed',
        outputText: result.content,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: result.model,
      })
      // Q-1 面③：审计记真实调用主体（外部直调=持证 principal；平台派发=任务发起方），
      // detail 带 responseId/taskId 使「谁执行了哪一次」可按 id 反查（Q-25）
      this.auditExecution(this.responses().get(record.id)!, agent, 'uhp.invoke', 'ok',
        `harness=${record.harnessId} model=${result.model} tokens=${result.inputTokens}/${result.outputTokens} response=${record.id}${record.taskId ? ` task=${record.taskId}` : ''}${record.contextId ? ` context=${record.contextId}` : ''}`)
      this.emitProgress(this.responses().get(record.id), 'completed')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (this.cancelRequested.has(record.id)) {
        this.cancelRequested.delete(record.id)
        this.emitProgress(this.responses().get(record.id), 'canceled')
        return
      }
      this.finish(record.id, 'failed', { error: reason })
    } finally {
      if (record.taskId) this.inflight.delete(record.taskId)
    }
  }

  private finish(id: string, status: UhpResponseStatus, patch: { error?: string }): void {
    const current = this.responses().get(id)
    if (!current || ['completed', 'failed', 'canceled'].includes(current.status)) return
    this.responses().update(id, { status, ...patch })
    const agent = this.ctx.resourceCore.get('agent', current.agentId)
    if (agent && status === 'failed') {
      this.auditExecution(current, agent, 'uhp.invoke', 'error', `response=${current.id} harness=${current.harnessId} ${patch.error ?? ''}`.trim())
    }
    this.emitProgress(this.responses().get(id), status === 'completed' ? 'completed' : status === 'canceled' ? 'canceled' : 'failed')
  }

  /**
   * 执行审计：主体取执行记录的真实调用方（Q-1 面③ 审计栽赃修复）。
   * 平台派发路径带回 A2A 任务的发起 principal + OBO 身份链，使「人类代员工发起」在审计可还原。
   */
  private auditExecution(
    record: UhpResponseRecord,
    agent: { id: string; name: string },
    action: string,
    result: 'ok' | 'error',
    detail: string,
  ): void {
    const actChain = JSON.parse(record.actChainJson || '[]') as Array<{ name: string; type: string }>
    this.ctx.audit.record({
      type: 'invoke',
      actorType: record.callerKind,
      actorId: record.callerPrincipalId,
      actorName: record.callerName,
      action,
      resourceType: 'agent',
      resourceId: agent.id,
      resourceName: agent.name,
      result,
      detail: `${detail}${record.onBehalfUser ? ` onBehalfOf=${record.onBehalfUser}` : ''}`,
      ...(actChain.length > 0 ? { actChain } : {}),
    })
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    uhpGateway: UhpGatewayService
  }
}

export const name = 'uhp'
// iam + agentRegistry：OBO 代表用户真实性校验（Q-6：声明代表某人时校验该用户存在且由令牌可代表）
export const inject = ['opsStorage', 'platformBus', 'httpServer', 'resourceCore', 'authn', 'iam', 'agentRegistry', 'audit', 'usage', 'modelGateway']

export function apply(ctx: Context) {
  const gateway = new UhpGatewayService(ctx)
  const gate = createRestGate(ctx)
  // 命名约定：http 别名让 contract-lint 的路由字面量扫描器识别 http.register 声明面
  const http = ctx.httpServer

  // 启动期向 iam 的 PermissionCatalog 幂等补录 UHP 权限点（先例：plugin-agent exec.read/exec.write 补录）
  for (const entry of [
    { point: 'uhp.read', label: '读取 UHP harness 注册表与执行记录', group: 'UHP 执行驱动' },
    { point: 'uhp.admin', label: '管理 UHP harness 配置', group: 'UHP 执行驱动' },
    { point: 'uhp.invoke', label: 'UHP 任务面调用（机器凭证执行面）', group: 'UHP 执行驱动' },
  ]) {
    if (!PermissionCatalog.some((item) => item.point === entry.point)) PermissionCatalog.push(entry)
  }

  // -- UHP 能力发现（规范要求免鉴权；/v1/* 不在 /api 鉴权域，天然匿名） --------------------
  // P2-02：发现面返回规范裸体（与 Agent Card well-known 同口径）——外部 UHP 客户端
  // 直接消费响应体，不再需要先剥平台 {ok,data} 信封。
  http.register('GET', '/v1/uhp', (exchange) => {
    if (exchange.res.headersSent) return
    exchange.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    exchange.res.end(JSON.stringify(gateway.discovery()))
  })

  // -- UHP 任务面（Responses 兼容子集；自校验 Bearer + uhp.invoke 权限，fail-closed） -------
  // 拒绝路径一律审计留痕（Q-27）：/v1 协议面不在控制台鉴权中间件覆盖范围，自校验需自带埋点。
  const denyAudit = (exchange: { path: string; headers: Record<string, unknown> }, verified: VerifiedPrincipal | undefined, point: string, detail: string): void => {
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: verified?.principal.id ?? '(anon)',
      actorName: verified?.principal.name ?? '匿名请求',
      point,
      path: exchange.path,
      detail,
    })
  }
  const verifyCaller = (exchange: HttpExchange): VerifiedPrincipal | undefined => {
    const header = String(exchange.headers['authorization'] ?? '')
    const token = header.startsWith('Bearer ') ? header.slice(7) : header
    if (!token) {
      denyAudit(exchange, undefined, 'uhp.invoke', t('缺少 Bearer 令牌'))
      exchange.fail(401, 'UNAUTHORIZED', t('缺少 Bearer 令牌（UHP 任务面要求机器凭证）'))
      return undefined
    }
    try {
      const verified = ctx.authn.verify(token)
      if (!verified.scopes.includes('uhp.invoke') && !verified.scopes.includes('*')) {
        denyAudit(exchange, verified, 'uhp.invoke', t('缺少权限点 uhp.invoke'))
        exchange.fail(403, 'FORBIDDEN', t('缺少权限点 uhp.invoke（UHP 任务面执行凭证）'))
        return undefined
      }
      return verified
    } catch (error) {
      denyAudit(exchange, undefined, 'uhp.invoke', t('令牌校验失败'))
      exchange.fail(401, 'TOKEN_INVALID', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  http.register('POST', '/v1/uhp/responses', async (exchange) => {
    const verified = verifyCaller(exchange)
    if (!verified) return
    const body = (exchange.body ?? {}) as {
      model?: string
      input?: string | Array<{ role: string; content: string }>
      stream?: boolean
      previous_response_id?: string
      idempotency?: string
      tools?: unknown
      functions?: unknown
      mcp_servers?: unknown
      metadata?: Record<string, unknown>
      task_id?: unknown
      taskId?: unknown
    }
    const metadata = body.metadata ?? {}
    // P0（Q-1）：外部调用携带任务绑定字段一律拒绝——该字段仅平台内部派发通道可注入。
    // 拒绝而非忽略：让攻击者的注入尝试成为可观测的审计事件，而不是静默生效。
    // P2-04：变体矩阵（metadata.ybk_a2a_task_id / 顶层 task_id / 顶层 taskId）统一同一拒绝口径
    // ——此前顶层变体被静默丢弃，注入尝试不可观测，与「拒绝而非忽略」声明不一致。
    const bindingProbes: Array<{ field: string; value: unknown }> = []
    if (metadata['ybk_a2a_task_id'] !== undefined) bindingProbes.push({ field: 'metadata.ybk_a2a_task_id', value: metadata['ybk_a2a_task_id'] })
    if (body.task_id !== undefined) bindingProbes.push({ field: 'task_id', value: body.task_id })
    if (body.taskId !== undefined) bindingProbes.push({ field: 'taskId', value: body.taskId })
    if (bindingProbes.length > 0) {
      const probe = bindingProbes[0]!
      const fields = bindingProbes.map((item) => item.field).join(', ')
      denyAudit(exchange, verified, 'a2a.task.dispatch', t('外部调用试图注入任务绑定字段（任务劫持探针）：{fields}', { fields }))
      ctx.audit.record({
        type: 'authz', actorType: verified.principal.type, actorId: verified.principal.id, actorName: verified.principal.name,
        action: 'uhp.invoke.task_binding_denied', resourceType: 'agent', resourceId: String(metadata['ybk_agent_id'] ?? ''),
        resourceName: t('UHP 任务面'), result: 'denied',
        detail: t('外部调用注入任务绑定字段被拒（{fields}；taskId={taskId}）——该字段仅允许平台派发通道注入', {
          fields, taskId: String(probe.value),
        }),
      })
      exchange.fail(400, 'TASK_BINDING_FORBIDDEN', t('外部调用不得绑定 A2A 任务：任务绑定字段（{fields}）仅允许由平台内部派发通道注入', { fields }))
      return
    }
    const inputText = typeof body.input === 'string'
      ? body.input
      : Array.isArray(body.input)
        ? body.input.filter((item) => item.role === 'user').map((item) => item.content).join('\n')
        : ''
    const idemHeader = exchange.headers['idempotency-key']
    const idempotencyKey = ((Array.isArray(idemHeader) ? idemHeader[0] : idemHeader) ?? body.idempotency) || undefined
    const ref = String(metadata['ybk_agent_id'] ?? String(body.model ?? '').replace(/^harness\//, '') ?? '').trim()
    if (!ref) {
      exchange.fail(400, 'BAD_REQUEST', t('缺少执行体：model 须为 harness/<id>（发现面公布的 harness id）或 metadata.ybk_agent_id 必填'))
      return
    }
    // 寻址（Q-7）：发现面公布的是 harness id，调用面必须能按 harness id 寻址——
    // 先按 Agent（id/slug）解析，未命中则回落 configured harness 注册表反查绑定员工。
    let agent = ctx.resourceCore.get('agent', ref) ?? ctx.resourceCore.bySlug('agent', ref)
    let harnessRef: string | undefined
    if (!agent) {
      const harness = gateway.harnesses().get(ref)
      if (harness?.enabled) {
        agent = ctx.resourceCore.get('agent', harness.agentId)
        harnessRef = harness.id
      }
    }
    if (!agent) {
      exchange.fail(404, 'NOT_FOUND', t('执行体不存在：{ref}（可传 agent id/slug 或 GET /v1/uhp 公布的 harness id）', { ref }))
      return
    }
    const dataClassRaw = String(metadata['ybk_data_class'] ?? 'internal')
    const dataClass: DataClass = dataClassRaw === 'public' || dataClassRaw === 'secret' ? dataClassRaw : 'internal'
    // OBO 校验（Q-6）：外部直调声称代表某人时，该 userId 必须真实存在且由令牌可代表——
    // OBO 链（act）里出现真实人类，或调用主体为 '*' / 绑定了该用户；否则不采信、不入账。
    let onBehalfUser: string | undefined
    if (typeof metadata['ybk_on_behalf_user'] === 'string' && metadata['ybk_on_behalf_user'].trim()) {
      const claimed = metadata['ybk_on_behalf_user'].trim()
      const actUser = verified.actChain.find((entry) => entry.type === 'human')
      const isPlatformAdmin = verified.scopes.includes('*')
      const binding = ctx.agentRegistry.boundUsers(agent.id).find((item) => item.userId === claimed)
      if (ctx.iam.users().get(claimed) && (actUser?.principalId === claimed || isPlatformAdmin || binding)) {
        onBehalfUser = claimed
      }
    }
    try {
      const record = await gateway.createResponse({
        agentId: agent.id,
        harnessRef,
        inputText,
        dataClass,
        ...(body.previous_response_id ? { previousResponseId: body.previous_response_id } : {}),
        idempotencyKey,
        ...(typeof metadata['ybk_context_id'] === 'string' ? { contextId: metadata['ybk_context_id'] } : {}),
        ...(metadata['ybk_session_policy'] === 'employee-bound' ? { sessionPolicy: 'employee-bound' as const } : {}),
        callerPrincipalId: verified.principal.id,
        callerName: verified.principal.name,
        callerKind: verified.principal.type === 'human' ? 'human' : 'machine',
        ...(verified.actChain.length > 0 ? { actChain: verified.actChain.map((e) => ({ principalId: '', name: e.name, type: e.type })) } : {}),
        ...(onBehalfUser ? { onBehalfUser } : {}),
        // 越权原语封堵：请求级 tools/functions/mcp_servers（顶层或 metadata 携带）一律接受不生效
        requestTools: body.tools !== undefined ? body.tools : metadata['tools'],
        ...(body.functions !== undefined || metadata['functions'] !== undefined ? { requestFunctions: body.functions ?? metadata['functions'] } : {}),
        ...(body.mcp_servers !== undefined || metadata['mcp_servers'] !== undefined ? { requestMcpServers: body.mcp_servers ?? metadata['mcp_servers'] } : {}),
      })
      if (body.stream === true) {
        // SSE 进度流：文本增量以完整输出单帧下发（内置 harness 单步执行，诚实粒度）
        const res = exchange.res
        if (res.headersSent) return
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(`retry: 5000\n\n`)
        let closed = false
        let unsubscribe = () => {}
        let heartbeat: ReturnType<typeof setInterval> | undefined
        const send = (event: string, data: unknown) => {
          if (closed || res.writableEnded) return
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        const closeStream = () => {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          unsubscribe()
          if (!res.writableEnded) res.end()
        }
        /** 终态收帧（幂等：SSE 只允许一个终止帧，避免竞态下重复 end）。 */
        const finishStream = (record: UhpResponseRecord) => {
          if (record.status === 'completed') {
            send('output_text.delta', { delta: record.outputText })
            send('response.completed', { id: record.id, output_text: record.outputText, usage: { input_tokens: record.inputTokens, output_tokens: record.outputTokens } })
          } else if (record.status === 'failed' || record.status === 'canceled') {
            send(`response.${record.status}`, { id: record.id, error: record.error ?? record.status })
          } else {
            return
          }
          closeStream()
        }
        send('response.created', { id: record.id, status: record.status })
        const initial = gateway.response(record.id)
        if (initial && ['completed', 'failed', 'canceled'].includes(initial.status)) {
          finishStream(initial)
          return
        }
        // P2-03：订阅执行记录事件（uhp.response.progress），不再订阅只对平台派发记录的
        // a2a.task.progress——外部直调（dispatchedByPlatform=false）此前永远收不到完成帧，
        // SSE 只下发 response.created 后悬挂到 15s 心跳。
        unsubscribe = ctx.platformBus.on('uhp.response.progress', (payload) => {
          const p = payload as UhpProgressPayload
          if (p.responseId !== record.id) return
          if (p.phase === 'completed') {
            send('output_text.delta', { delta: p.text ?? '' })
            send('response.completed', { id: record.id, output_text: p.text ?? '', usage: { input_tokens: p.inputTokens, output_tokens: p.outputTokens } })
            closeStream()
          } else if (p.phase === 'failed' || p.phase === 'canceled') {
            send(`response.${p.phase}`, { id: record.id, error: p.error ?? p.phase })
            closeStream()
          } else {
            send('response.in_progress', { id: record.id })
          }
        })
        // 订阅后再查一次终态：堵住「createResponse → 订阅」之间的完成竞态（否则永不闭合）
        const afterSubscribe = gateway.response(record.id)
        if (afterSubscribe && ['completed', 'failed', 'canceled'].includes(afterSubscribe.status)) {
          finishStream(afterSubscribe)
          return
        }
        heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
        heartbeat.unref?.()
        exchange.raw.on('close', closeStream)
        return
      }
      // 同步模式（stream≠true）：等待终态再返回（Responses API 同步语义；上限 60s 防悬挂）
      let settled = gateway.response(record.id) ?? record
      for (let i = 0; i < 300 && !['completed', 'failed', 'canceled'].includes(settled.status); i++) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        settled = gateway.response(record.id) ?? settled
      }
      exchange.ok(uhpView(settled))
    } catch (error) {
      if (error instanceof UhpBindingError) {
        exchange.fail(400, 'TASK_BINDING_FORBIDDEN', error.message)
        return
      }
      if (error instanceof ForbiddenError) {
        exchange.fail(403, 'FORBIDDEN', error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  })

  // 读/取消：属主本人或平台管理员（治理读权限 uhp.read 经 /api/uhp/responses 面查询，
  // 执行面 /v1 只认属主与 '*'——同层外部集成之间不得互读/互取消）
  http.register('GET', '/v1/uhp/responses/:id', (exchange) => {
    const verified = verifyCaller(exchange)
    if (!verified) return
    const record = gateway.response(exchange.params['id'] ?? '')
    if (!record) {
      exchange.fail(404, 'NOT_FOUND', t('response 不存在：{id}', { id: exchange.params['id'] ?? '' }))
      return
    }
    // 存在性不泄露：非属主一律按「不存在」回应（避免探测他人执行记录 id）
    if (record.callerPrincipalId !== verified.principal.id && !verified.scopes.includes('*')) {
      denyAudit(exchange, verified, 'uhp.response.read', t('越权读取他人执行记录'))
      exchange.fail(404, 'NOT_FOUND', t('response 不存在：{id}', { id: exchange.params['id'] ?? '' }))
      return
    }
    exchange.ok(uhpView(record))
  })

  http.register('POST', '/v1/uhp/responses/:id/cancel', (exchange) => {
    const verified = verifyCaller(exchange)
    if (!verified) return
    try {
      exchange.ok(uhpView(gateway.cancelResponse(exchange.params['id'] ?? '', t('调用方主动取消'), verified.principal.id)))
    } catch (error) {
      if (error instanceof ForbiddenError) {
        denyAudit(exchange, verified, 'uhp.response.cancel', t('越权取消他人执行记录'))
        exchange.fail(403, 'FORBIDDEN', error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  })

  // -- harness 注册表管理（/api 域，guarded，进 RBAC 越权探针矩阵） -------------------------
  // 组织隔离（Q-4）：与 /api/agents 的 R11 同口径——下级组织持 uhp.read 只见本组织子树
  const visibleOrgScope = (info: { kind: string; userId?: string; refType?: string; refId?: string; permissions: string[] }): Set<string> | null => {
    if (info.permissions.includes('*')) return null
    let orgId = info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined
    if (!orgId && info.kind === 'machine' && info.refType === 'agent' && info.refId) {
      orgId = ctx.resourceCore.collection('agent').get(info.refId)?.orgId
    }
    if (!orgId) return new Set<string>()
    return new Set(ctx.iam.orgSubtreeIds(orgId))
  }
  const orgVisible = (scope: Set<string> | null, agentId: string): boolean => {
    if (scope === null) return true
    const targetOrg = ctx.resourceCore.collection('agent').get(agentId)?.orgId
    if (!targetOrg) return true
    return scope.has(targetOrg)
  }

  gate.guarded('GET', '/api/uhp/harnesses', 'uhp.read', (exchange) => {
    const scope = visibleOrgScope(gate.caller(exchange))
    return {
      harnesses: gateway.harnesses().all()
        .filter((harness) => orgVisible(scope, harness.agentId))
        .map((harness) => ({
          ...harness,
          agentName: ctx.resourceCore.get('agent', harness.agentId)?.name ?? harness.agentId,
        })),
    }
  })
  gate.guarded('POST', '/api/uhp/harnesses', 'uhp.admin', (exchange) => {
    const input = gate.body<{
      id?: string; agentId: string; model: string; channelGroup?: string
      toolPermGroupIds?: string[]; stepBudget?: number; timeBudgetMs?: number; dataClassCeiling?: DataClass; enabled?: boolean
    }>(exchange)
    const record = gateway.upsertHarness({ ...input, createdBy: gate.actorOf(exchange) })
    gate.changeLog(exchange, 'uhp.harness.upsert', 'uhp_harness', record.id, record.id, `agent=${input.agentId} model=${input.model}`)
    return { harness: record }
  })
  gate.guarded('PATCH', '/api/uhp/harnesses/:id', 'uhp.admin', (exchange) => {
    const input = gate.body<Record<string, unknown>>(exchange)
    const existing = gateway.harnesses().get(exchange.params['id'] ?? '')
    if (!existing) {
      exchange.fail(404, 'NOT_FOUND', t('harness 不存在：{id}', { id: exchange.params['id'] ?? '' }))
      return
    }
    const record = gateway.upsertHarness({
      id: existing.id,
      agentId: String(input['agentId'] ?? existing.agentId),
      model: String(input['model'] ?? existing.model),
      channelGroup: input['channelGroup'] !== undefined ? String(input['channelGroup']) : existing.channelGroup,
      toolPermGroupIds: Array.isArray(input['toolPermGroupIds']) ? (input['toolPermGroupIds'] as string[]) : existing.toolPermGroupIds,
      stepBudget: input['stepBudget'] !== undefined ? Number(input['stepBudget']) : existing.stepBudget,
      timeBudgetMs: input['timeBudgetMs'] !== undefined ? Number(input['timeBudgetMs']) : existing.timeBudgetMs,
      dataClassCeiling: input['dataClassCeiling'] !== undefined ? (input['dataClassCeiling'] as DataClass) : existing.dataClassCeiling,
      enabled: input['enabled'] !== undefined ? Boolean(input['enabled']) : existing.enabled,
      createdBy: existing.createdBy,
    })
    gate.changeLog(exchange, 'uhp.harness.update', 'uhp_harness', record.id, record.id)
    return { harness: record }
  })
  gate.guarded('DELETE', '/api/uhp/harnesses/:id', 'uhp.admin', (exchange) => {
    const removed = gateway.removeHarness(exchange.params['id'] ?? '')
    if (!removed) {
      exchange.fail(404, 'NOT_FOUND', t('harness 不存在：{id}', { id: exchange.params['id'] ?? '' }))
      return
    }
    gate.changeLog(exchange, 'uhp.harness.delete', 'uhp_harness', exchange.params['id'] ?? '', exchange.params['id'] ?? '')
    return { deleted: true }
  })
  gate.guarded('GET', '/api/uhp/responses', 'uhp.read', (exchange) => {
    const taskId = exchange.query.get('taskId') ?? ''
    const agentId = exchange.query.get('agentId') ?? ''
    const limit = Math.min(Number(exchange.query.get('limit') ?? 50) || 50, 200)
    const scope = visibleOrgScope(gate.caller(exchange))
    const scoped = gateway.responses().all().filter((item) => orgVisible(scope, item.agentId))
    const items = scoped
      .filter((item) => (taskId ? item.taskId === taskId : true))
      .filter((item) => (agentId ? item.agentId === agentId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
    return { total: scoped.length, items: items.map(uhpView) }
  })
}

/** 对外视图：Responses 兼容子集字段名（ASCII 协议键，中文释义见协议键对照总表）。 */
function uhpView(record: UhpResponseRecord) {
  return {
    id: record.id,
    status: record.status,
    model: record.model,
    harness_id: record.harnessId,
    output_text: record.outputText,
    usage: { input_tokens: record.inputTokens, output_tokens: record.outputTokens },
    session_id: record.sessionId,
    ...(record.previousResponseId ? { previous_response_id: record.previousResponseId } : {}),
    ...(record.taskId ? { task_id: record.taskId } : {}),
    ...(record.error ? { error: record.error } : {}),
    metadata: JSON.parse(record.metadataJson || '{}') as Record<string, unknown>,
    created_at: record.createdAt,
  }
}
