/**
 * @dsh-ops/plugin-modelgw —— 统一模型接入网关（用量透明计量版，元冰可开发计划 M0-3）。
 *
 * 平台统一代理外部模型厂商（OpenAI 兼容 chat/completions 形态）：
 *   真实 HTTP 转发 → usage 计量（input/output tokens 实测值，不伪造）→
 *   零价快照入账（charge_cents=0，不对外呈现任何金额结算语义）+ 内部采购成本参考（成本穿透报表口径）。
 *
 * 商业模式（M0 收敛）：私有化年费 + 治理包——网关不再做「转售/预检/扣费」，
 * 价格簿仅内部成本参考（cost_cents_per_unit），list 侧恒零价。
 *
 * 真实化红线（第 0 步原则）：模型未配置真实 endpoint 时调用直接报错，
 * 绝不生成假 completion 充数——演示环境请在目录中配置指向 stub 的 endpoint。
 *
 * 治理面（IAW 交接批次 2026-09-11，PRD M2/§7.2）：
 *   - 渠道分级路由（1-1）：模型登记 dataClassLimit（公开/内部/秘密），会话请求携带 dataClass
 *     时按「分级上限」过滤候选——涉密数据永远不会路由到公开级渠道，越级调用直接拒绝（锁死+原因）；
 *   - 降级链（1-2）：渠道组（主/备1/备2/人工）按步超时逐级降级，每次降级发 modelgw.degraded
 *     （面板 SSE 提示条 + 审计订阅）；内容安全拦截钩子留待外部内容安全网关接入（诚实缺位）；
 *   - 渠道遥测（1-3）：滚动调用遥测（7d 可用率/延迟/TPS 代理/采纳率）；TTFT 需流式通道，
 *     非流式单轮诚实缺列（ttft=null，口径随端点返回）；
 *   - 预算熔断（1-4）：org/平台级预算（日/月），warn 阈值告警（modelgw.budget.warning），
 *     block 动作在调用前熔断——预算进程内去重告警（每预算每自然日最多一条）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  newId,
  gateManagedWork, WORK_DATA_CLASS_ORDER, WORK_DENY_CODE_LABELS,
  type Collection, type RecordBase,
  type WorkCallerRef, type WorkDataClass, type WorkExecutionContext, type WorkforcePolicyRegistry,
} from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'
import * as modelgwTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/** 数据分级（PRD §4.1/§7.2）：公开 < 内部 < 秘密；渠道按上限接纳数据。 */
export type DataClass = 'public' | 'internal' | 'secret'

export const DATA_CLASS_RANK: Record<DataClass, number> = { public: 0, internal: 1, secret: 2 }
export const DATA_CLASS_LABELS: Record<DataClass, string> = { public: '公开', internal: '内部', secret: '秘密' }

/**
 * D14 统一业务密级 → 网关渠道分级的显式映射表（禁止同名枚举直接等同、禁止缺失隐式回落）：
 *   public      → public    （公开→公开，一一对应）
 *   internal    → internal  （内部→内部，一一对应）
 *   secret      → secret    （业务秘密级 ↔ 渠道秘密级，语义同级）
 *   confidential→ secret    （机密钳制到网关最高分级：机密数据仅允许最高分级渠道承载，
 *                          网关无更高分级可表达，绝不向 public/internal 渠道路由）
 *   topsecret   → 不进映射：受管调用在映射前直接拒绝（绝密禁止数字员工处理，验收 V14 模型侧）。
 */
const WORK_DATA_CLASS_TO_GATEWAY: Record<Exclude<WorkDataClass, 'topsecret'>, DataClass> = {
  public: 'public',
  internal: 'internal',
  secret: 'secret',
  confidential: 'secret',
}

export interface ModelRecord extends RecordBase {
  slug: string
  displayName: string
  provider: string
  /** OpenAI 兼容基址（如 https://api.deepseek.com/v1）；未配置则不可调用。 */
  endpoint: string
  /** API Key（仅存引用名，真实密钥经环境变量注入；测试可直填 stub key）。 */
  apiKey: string
  /** 内部采购成本参考（分/千 tokens）：仅用于成本穿透报表，不对外呈现金额结算。 */
  costCentsPerKTokens: number
  /**
   * 输入内部成本参考（分/千 tokens，#14 additive）：输入 token 与输出分开计价
   * （组合计价行入 usage 事件）；缺省视为未定价（输入侧成本按 0，事件标 not_priced 语义由 usage 判定）。
   */
  inputCostCentsPerKTokens?: number
  status: 'online' | 'offline'
  /** 数据分级上限（1-1，additive）：该渠道可承载的最高数据分级；缺省 internal（存量登记兼容）。 */
  dataClassLimit?: DataClass
}

export interface ModelInvokeInput {
  model: string
  messages: Array<{ role: string; content: string }>
  /** 用量归口组织（部门维度报表口径）。 */
  orgId: string
  /** 最终用户/Agent（on-behalf-of 终点）。 */
  subject: string
  tenantId?: string
  maxTokens?: number
  temperature?: number
  /** 本次会话请求的数据分级（1-1，缺省 internal）：高于渠道上限即拒绝（选择器锁死+原因）。 */
  dataClass?: DataClass
  /**
   * 可信调用者（D10 additive，结构对齐 WorkCallerRef）：由调用入口从已验证令牌/会话组装，
   * 禁止把请求体同形 JSON 当作可信身份（§10.4）。缺失时按非受管路径 legacy 直通（现状不变）。
   */
  caller?: WorkCallerRef
  /**
   * 工作引用索引（additive，§10.4）：仅 permitId/runId/stepKey/invocationId 四个索引键；
   * 授权事实（permit/任用/租约/预算）一律由 workforce 侧服务端回查，本字段不作授权依据。
   */
  work?: ModelWorkRef
}

/** 模型调用的工作引用索引（与 WorkRefIndex 的模型侧子集对齐）。 */
export interface ModelWorkRef {
  permitId?: string
  runId?: string
  stepKey?: string
  /** workforce 受控调用账本的调用 ID：透传 usage trace 关联（V23/V27，不改变历史幂等键口径）。 */
  invocationId?: string
}

export interface ModelInvokeResult {
  ok: true
  content: string
  model: string
  inputTokens: number
  outputTokens: number
  /** 内部成本参考（分，按实测 output tokens 折算；仅报表口径，不参与任何结算）。 */
  costCents: number
  /** 降级链流转记录（1-2，仅 invokeWithFallback 路径返回）。 */
  degradations?: Array<{ from: string; reason: string; at: string }>
  /** usage 事件 ID（D11 additive）：工作调用账本与消费事实的对账关联键（只关联不重复登记）。 */
  usageEventId?: string
}

export interface ModelInvokeError extends Error {
  /** 上游 HTTP 状态（5xx 判定降级用）；超时/网络错误无此字段。 */
  status?: number
  kind?: 'timeout' | 'http' | 'network'
}

/** 渠道组（1-2）：主/备1/备2/人工 的降级链声明；链尾 manual=true 表示最终转人工。 */
export interface ChannelGroupRecord extends RecordBase {
  slug: string
  name: string
  primary: string
  backup1?: string
  backup2?: string
  /** 链尾转人工（true）：全链失败时返回 escalated=true 而非裸错误，由面板插提示条。 */
  manual?: boolean
  /** 单步超时（毫秒，PRD §4.1 口径 8s）；缺省 8000。 */
  stepTimeoutMs?: number
  enabled: boolean
}

/** 调用遥测（1-3）：滚动窗口原始记录（默认保留 8 天，7d 查询窗）。 */
export interface TelemetryRecord extends RecordBase {
  model: string
  at: string
  ok: boolean
  latencyMs: number
  outputTokens: number
  /** 降级链路径调用标记（备用渠道命中）。 */
  degraded?: boolean
  error?: string
}

/** 预算（1-4）：org 级（缺省=平台级）日/月预算，warn 阈值 + block 熔断。 */
export interface BudgetRecord extends RecordBase {
  orgId?: string
  /**
   * 模型范围（R3，2026-10-14）：缺省=不限模型；'*'=命中任意模型（通配语义，
   * 花费取窗口总额不做 byResource 过滤）；其余字面量=仅该模型。
   */
  modelSlug?: string
  /**
   * 预算主体（R10 前置，2026-10-14）：形如 'agent:<id>' / 'app:<id>'，缺省=组织级预算。
   * 与 invoke 计量口径一致（usage.subject），主体预算的花费按 usage.summary(subject=) 聚合。
   */
  subject?: string
  /** 超额联动冻结（R10 前置）：超额熔断时联动冻结对应 Agent 并生成解冻审批（执行中枢消费）。 */
  freezeAgent?: boolean
  dailyLimitCents?: number
  monthlyLimitCents?: number
  /** 告警阈值比例（used/limit ≥ warnRatio 发 modelgw.budget.warning）；缺省 0.8。 */
  warnRatio: number
  action: 'warn' | 'block'
  enabled: boolean
}

export interface BudgetWindowStatus {
  limitCents: number
  usedCents: number
  ratio: number
  warn: boolean
  breached: boolean
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

const INVOKE_TIMEOUT_MS = 30_000
export const DEFAULT_STEP_TIMEOUT_MS = 8_000
const TELEMETRY_RETENTION_MS = 8 * 86_400_000

export class ModelGatewayService extends Service {
  static readonly provide = 'modelGateway'

  /** 预算告警进程内去重：budgetId → 最近告警的自然日（每预算每日最多一条 warning 事件）。 */
  private budgetWarnDay = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'modelGateway')
  }

  models(): Collection<ModelRecord> {
    const collection = this.ctx.opsStorage.collection<ModelRecord>('modelgw:models')
    collection.uniqueOn('model_slug', (item) => item.slug)
    return collection
  }

  upsertModel(input: Omit<ModelRecord, 'id' | 'createdAt' | 'updatedAt'>): ModelRecord {
    const existing = this.models().findOne((item) => item.slug === input.slug)
    if (existing) return this.models().update(existing.id, { ...input })
    const created = this.models().insert({ id: newId('mdl'), ...input })
    // 价格簿登记：model:<slug> 按 output_tokens 计量——list 恒零价（不对外结算），
    // cost 为内部采购成本参考（成本穿透报表口径）
    this.ctx.usage.upsertPrice({
      pattern: `model:${input.slug}`,
      meter_key: 'output_tokens',
      list_cents_per_unit: 0,
      cost_cents_per_unit: input.costCentsPerKTokens,
      units_per_step: 1000,
      tax_rate: 0.06,
      currency: 'CNY',
      rate_version: `model:${input.slug}:cost-v1`,
    })
    // #14：输入 token 费率独立登记（model:<slug>:input 只是费率载体，事件 resource 恒为
    // model:<slug> 命中主条目；invoke 时点经 priceOfResource 读取后以组合计价行入账）
    this.ctx.usage.upsertPrice({
      pattern: `model:${input.slug}:input`,
      meter_key: 'input_tokens',
      list_cents_per_unit: 0,
      cost_cents_per_unit: input.inputCostCentsPerKTokens ?? 0,
      units_per_step: 1000,
      tax_rate: 0.06,
      currency: 'CNY',
      rate_version: `model:${input.slug}:input-cost-v1`,
    })
    return created
  }

  /** 存量模型更新（不入 seed 的运营调价路径）：价格簿两条目同步刷新，费率与目录单一事实源。 */
  updateModelCost(slug: string, cost: { outputCostCentsPerKTokens: number; inputCostCentsPerKTokens?: number }): void {
    this.ctx.usage.upsertPrice({
      pattern: `model:${slug}`,
      meter_key: 'output_tokens',
      list_cents_per_unit: 0,
      cost_cents_per_unit: cost.outputCostCentsPerKTokens,
      units_per_step: 1000,
      tax_rate: 0.06,
      currency: 'CNY',
      rate_version: `model:${slug}:cost-v1`,
    })
    this.ctx.usage.upsertPrice({
      pattern: `model:${slug}:input`,
      meter_key: 'input_tokens',
      list_cents_per_unit: 0,
      cost_cents_per_unit: cost.inputCostCentsPerKTokens ?? 0,
      units_per_step: 1000,
      tax_rate: 0.06,
      currency: 'CNY',
      rate_version: `model:${slug}:input-cost-v1`,
    })
  }

  // -- 工作级授权与密级映射（D10/D14，additive） ---------------------------------

  /**
   * 窄端口运行时读取：platform-core 装配时注册 WorkforcePolicyRegistry（provide='workforcePolicy'）。
   * Context 类型增补由 workforce 侧统一持有；这里防御式读取——服务未装配时返回 undefined，
   * gateManagedWork 按端口未就绪走 legacy，非受管路径现状不变（V29：新工作路径不静默无策略放行）。
   */
  private workforcePolicy(): WorkforcePolicyRegistry | undefined {
    try {
      return (this.ctx as unknown as { workforcePolicy?: WorkforcePolicyRegistry }).workforcePolicy ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * 工作级授权闸门（受管数字员工模型调用）：入口在资源级校验之前执行；
   * caller 缺失或端口未就绪 → legacy（返回 null，原有链一步不少）；拒绝 → 中文错误 + 领域码（fail-closed）。
   * 判定只按可信 caller 反查，与是否携带 work 引用无关（D.5 防绕行）。
   * registryId：单渠道传模型 slug；降级链传渠道组 slug（实际执行渠道仍在链内逐个过分级/预算校验）。
   */
  private async gateManagedModelCall(
    caller: WorkCallerRef | undefined,
    registryId: string,
    ref?: ModelWorkRef,
  ): Promise<WorkExecutionContext | null> {
    const gate = await gateManagedWork(this.workforcePolicy(), caller, {
      facts: { kind: 'model', registryId, action: 'invoke', risk: 'read' },
      ...(ref && (ref.permitId || ref.runId || ref.stepKey) ? { ref: { permitId: ref.permitId, runId: ref.runId, stepKey: ref.stepKey } } : {}),
    })
    if (gate.mode === 'legacy') return null
    if (gate.mode === 'denied') {
      const label = t(WORK_DENY_CODE_LABELS[gate.code])
      const detail = gate.message ? t('（{message}）', { message: gate.message }) : ''
      const error = new Error(t('数字员工调用被拒绝：{message}', { message: label + detail })) as Error & { code?: string }
      error.code = gate.code
      throw error
    }
    return gate.work
  }

  /**
   * 受管调用的有效密级（D14）：max(请求 dataClass（缺省 internal）, 任用冻结密级上限)——
   * 受管时必须以 max 口径走，禁止把缺失隐式回落 internal 造成降级。
   * topsecret 在显式映射前直接拒绝（绝密禁止数字员工处理）；其余经显式映射表落到网关分级。
   */
  private effectiveManagedDataClass(requested: DataClass | undefined, workCeiling: WorkDataClass): DataClass {
    const base: WorkDataClass = requested ?? 'internal'
    const effective = WORK_DATA_CLASS_ORDER[base] >= WORK_DATA_CLASS_ORDER[workCeiling] ? base : workCeiling
    if (effective === 'topsecret') {
      throw new Error(t('绝密数据禁止数字员工处理'))
    }
    return WORK_DATA_CLASS_TO_GATEWAY[effective]
  }

  // -- 渠道分级路由（1-1） ---------------------------------------------------

  /**
   * 按数据分级过滤可用渠道：分级超过渠道上限的模型不出现（涉密场景选择器锁死公有云渠道）。
   * 返回带原因的结构，供前端直接渲染锁死原因。
   */
  resolveChannels(dataClass: DataClass, opts: { onlineOnly?: boolean } = {}): {
    dataClass: DataClass
    available: ModelRecord[]
    excluded: Array<{ slug: string; displayName: string; limit: DataClass; reason: string }>
  } {
    const rank = DATA_CLASS_RANK[dataClass] ?? DATA_CLASS_RANK.internal
    const available: ModelRecord[] = []
    const excluded: Array<{ slug: string; displayName: string; limit: DataClass; reason: string }> = []
    for (const model of this.models().all()) {
      const limit = model.dataClassLimit ?? 'internal'
      if (DATA_CLASS_RANK[limit] >= rank) {
        if (!opts.onlineOnly || (model.status === 'online' && model.endpoint.trim() !== '')) available.push(model)
        continue
      }
      excluded.push({
        slug: model.slug, displayName: model.displayName, limit,
        reason: t('渠道分级上限为「{limit}」，低于本次数据「{dataClass}」——涉密/内部数据不得路由到低分级渠道（PRD §7.2）', { limit: t(DATA_CLASS_LABELS[limit]), dataClass: t(DATA_CLASS_LABELS[dataClass]) }),
      })
    }
    return { dataClass, available, excluded }
  }

  /** 分级越界校验：目标渠道上限低于请求数据分级时直接拒绝（含原因文案，供选择器锁死提示）。 */
  private assertDataClassAllowed(model: ModelRecord, dataClass: DataClass | undefined): void {
    const requestClass = dataClass ?? 'internal'
    const limit = model.dataClassLimit ?? 'internal'
    if (DATA_CLASS_RANK[limit] < DATA_CLASS_RANK[requestClass]) {
      throw new Error(
        t('数据分级越界：本次会话数据为「{dataClass}」，渠道 {slug} 分级上限仅「{limit}」——已按 PRD §7.2 锁死该路由', { dataClass: t(DATA_CLASS_LABELS[requestClass]), slug: model.slug, limit: t(DATA_CLASS_LABELS[limit]) }),
      )
    }
  }

  // -- 渠道组与降级链（1-2） ---------------------------------------------------

  channelGroups(): Collection<ChannelGroupRecord> {
    const collection = this.ctx.opsStorage.collection<ChannelGroupRecord>('modelgw:channelGroups')
    collection.uniqueOn('group_slug', (item) => item.slug)
    return collection
  }

  upsertChannelGroup(input: Omit<ChannelGroupRecord, 'id' | 'createdAt' | 'updatedAt'>): ChannelGroupRecord {
    for (const slug of [input.primary, input.backup1, input.backup2]) {
      if (slug !== undefined && !this.models().findOne((item) => item.slug === slug)) {
        throw new Error(t('渠道组引用了未登记的模型：{slug}（请先在模型目录登记）', { slug }))
      }
    }
    const existing = this.channelGroups().findOne((item) => item.slug === input.slug)
    if (existing) return this.channelGroups().update(existing.id, { ...input })
    return this.channelGroups().insert({ id: newId('mgrp'), ...input })
  }

  /**
   * 降级链调用（1-2）：主 → 备1 → 备2 逐级降级，每步按 stepTimeoutMs（默认 8s）超时；
   * HTTP 5xx / 超时 / 网络错误触发降级，每次降级 emit modelgw.degraded（面板 SSE 提示条 + 审计）。
   * 链尾 manual=true：全链失败返回 escalated=true（转人工）而非裸错误。
   * 预算熔断（1-4 / BUG-2510-B1）：每次真实调用前复检（同单渠道路径口径），block 态 fail-closed
   * 直接抛「预算熔断」错误终止整链（不进降级、不调上游、不入账）。
   * 内容安全拦截：外部内容安全网关未接入（诚实缺位），接入后在 invokeOnce 返回路径上挂钩。
   */
  async invokeWithFallback(input: Omit<ModelInvokeInput, 'model'> & { group: string }): Promise<ModelInvokeResult | { ok: false; escalated: true; reason: string; degradations: Array<{ from: string; reason: string; at: string }> }> {
    // 工作级授权闸门（D10）：入口先过闸，渠道组 slug 作为 registryId；拒绝直接终止整链。
    // 受管时有效密级以 max(请求, 任用上限) 显式映射（D14）；非受管 legacy 路径 effectiveInput===input 现状不变。
    const work = await this.gateManagedModelCall(input.caller, input.group, input.work)
    const effectiveInput = work
      ? { ...input, dataClass: this.effectiveManagedDataClass(input.dataClass, work.dataClass) }
      : input
    const group = this.channelGroups().findOne((item) => item.slug === effectiveInput.group)
    if (!group) throw new Error(t('渠道组不存在：{slug}（请先登记主/备渠道组）', { slug: effectiveInput.group }))
    if (!group.enabled) throw new Error(t('渠道组已停用：{slug}', { slug: group.slug }))
    const chain = [group.primary, group.backup1, group.backup2].filter((slug): slug is string => Boolean(slug))
    const stepTimeoutMs = group.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
    const degradations: Array<{ from: string; reason: string; at: string }> = []
    let lastError = ''
    for (let index = 0; index < chain.length; index++) {
      const slug = chain[index]!
      const model = this.models().findOne((item) => item.slug === slug)
      const reject = (reason: string): void => {
        lastError = reason
        degradations.push({ from: slug, reason, at: new Date().toISOString() })
        this.recordTelemetry({ model: slug, ok: false, latencyMs: 0, outputTokens: 0, degraded: true, error: reason })
        this.ctx.platformBus.emit('modelgw.degraded', {
          group: group.slug, from: slug, to: chain[index + 1] ?? (group.manual ? t('manual:人工') : t('（链尾）')),
          reason, step: index + 1, subject: effectiveInput.subject, orgId: effectiveInput.orgId,
        })
      }
      if (!model) {
        reject(t('渠道组引用的模型未登记：{slug}', { slug }))
        continue
      }
      if (model.status !== 'online' || model.endpoint.trim() === '') {
        reject(t('备用渠道不可调用（{reason}）：{slug}', { reason: model.status === 'online' ? t('未配置 endpoint') : t('已下线'), slug }))
        continue
      }
      try {
        // 分级路由（1-1）逐步校验：备用渠道分级低于请求数据分级时同样锁死
        this.assertDataClassAllowed(model, effectiveInput.dataClass)
      } catch (error) {
        reject(error instanceof Error ? error.message : String(error))
        continue
      }
      // 预算熔断（1-4 / BUG-2510-B1）：每次真实调用前与单渠道路径（invoke）同口径复检——
      // 链内逐渠道计量入账会推进用量，降级前复检堵住 block 态经备用渠道继续调通上游；
      // 按当前渠道 slug 评估（对被调模型的命中语义与单渠道路径完全一致，R3 通配/R10 主体不受影响），
      // 熔断错误不进降级（reject）而直接终止整链——错误文案与信封和单渠道路径一致
      try {
        this.enforceBudget({ ...effectiveInput, model: slug })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.recordTelemetry({ model: slug, ok: false, latencyMs: 0, outputTokens: 0, degraded: index > 0, error: t('预算熔断：{message}', { message }) })
        throw error
      }
      try {
        const result = await this.invokeTracked(model, effectiveInput, stepTimeoutMs, index > 0)
        if (degradations.length > 0) return { ...result, degradations }
        return result
      } catch (error) {
        reject(error instanceof Error ? error.message : String(error))
      }
    }
    if (group.manual) return { ok: false, escalated: true, reason: t('渠道组 {slug} 全链失败，已按配置转人工：{message}', { slug: group.slug, message: lastError }), degradations }
    throw new Error(t('渠道组 {slug} 全链失败（无转人工配置）：{message}', { slug: group.slug, message: lastError }))
  }

  // -- 遥测（1-3） ------------------------------------------------------------

  telemetry(): Collection<TelemetryRecord> {
    return this.ctx.opsStorage.collection<TelemetryRecord>('modelgw:telemetry')
  }

  recordTelemetry(input: { model: string; ok: boolean; latencyMs: number; outputTokens: number; degraded?: boolean; error?: string }): void {
    const collection = this.telemetry()
    collection.insert({ id: newId('mtel'), at: new Date().toISOString(), ...input })
    // 滚动窗清理：只保留 8 天（7d 查询窗 + 1d 余量）
    const cutoff = new Date(Date.now() - TELEMETRY_RETENTION_MS).toISOString()
    for (const stale of collection.all().filter((row) => row.at < cutoff)) collection.remove(stale.id)
  }

  /**
   * 渠道遥测聚合（7d 窗口径）：可用率 / 延迟 p50 / TPS 代理（output tokens / 总时延）/
   * 采纳率（usage 反馈聚合，无反馈=null）。
   * TTFT 诚实缺列：非流式单轮无法测首 token 时延——ttftMs=null + 口径说明随响应返回，
   * 待网关流式通道上线后补真值。
   */
  telemetryFor(slug: string, windowDays = 7): {
    model: string
    windowDays: number
    invocations: number
    failures: number
    availability: number | null
    p50LatencyMs: number | null
    avgTps: number | null
    adoptionRate: number | null
    degradedInvocations: number
    ttftMs: null
    note: string
  } {
    const from = new Date(Date.now() - windowDays * 86_400_000).toISOString()
    const rows = this.telemetry().all().filter((row) => row.model === slug && row.at >= from)
    const okRows = rows.filter((row) => row.ok)
    const latencies = rows.filter((row) => row.latencyMs > 0).map((row) => row.latencyMs).sort((a, b) => a - b)
    const tpsValues = rows.filter((row) => row.ok && row.latencyMs > 100 && row.outputTokens > 0)
      .map((row) => (row.outputTokens / row.latencyMs) * 1000)
    const feedback = this.ctx.usage.feedbackStats({ from })
    const adoption = feedback.byResource.find((row) => row.resource === `model:${slug}`)
    const percentile = (values: number[], ratio: number): number | null =>
      values.length === 0 ? null : values[Math.min(values.length - 1, Math.floor(values.length * ratio))]!
    return {
      model: slug,
      windowDays,
      invocations: rows.length,
      failures: rows.length - okRows.length,
      availability: rows.length === 0 ? null : Math.round((okRows.length / rows.length) * 1000) / 1000,
      p50LatencyMs: percentile(latencies, 0.5),
      avgTps: tpsValues.length === 0 ? null : Math.round((tpsValues.reduce((sum, value) => sum + value, 0) / tpsValues.length) * 100) / 100,
      adoptionRate: adoption?.adoptionRate ?? null,
      degradedInvocations: rows.filter((row) => row.degraded === true).length,
      ttftMs: null,
      note: t('TTFT 需流式通道（当前网关为非流式单轮）诚实缺列；TPS 为 output_tokens/总时延 的代理口径；采纳率取 model:<slug> 资源的 👍/👎 聚合'),
    }
  }

  // -- 预算与熔断（1-4） --------------------------------------------------------

  budgets(): Collection<BudgetRecord> {
    return this.ctx.opsStorage.collection<BudgetRecord>('modelgw:budgets')
  }

  upsertBudget(input: Omit<BudgetRecord, 'id' | 'createdAt' | 'updatedAt'>): BudgetRecord {
    if (input.dailyLimitCents === undefined && input.monthlyLimitCents === undefined) {
      throw new Error(t('预算至少配置 dailyLimitCents / monthlyLimitCents 之一'))
    }
    // 主体格式校验（R10 前置）：subject 必须是 'agent:'/'app:' 前缀的计量主体，
    // 防止随手填自由文本造成「配了预算但永远匹配不到 usage」的静默失效
    if (input.subject !== undefined && !/^(agent|app):.+/.test(input.subject)) {
      throw new Error(t('预算主体格式非法：{subject}（须形如 agent:<id> 或 app:<id>，与 invoke 计量主体同口径）', { subject: input.subject }))
    }
    // 复合键（org × 模型 × 主体）：三者共同唯一——同一组织可同时挂组织级、按模型、按主体预算
    const existing = this.budgets().findOne((item) =>
      (item.orgId ?? '') === (input.orgId ?? '')
      && (item.modelSlug ?? '') === (input.modelSlug ?? '')
      && (item.subject ?? '') === (input.subject ?? ''))
    if (existing) return this.budgets().update(existing.id, { ...input })
    return this.budgets().insert({ id: newId('mbgt'), ...input })
  }

  /** 预算命中的花费口径：org×模型×主体过滤的 usage 成本聚合（内部成本参考口径 cost_cents）。 */
  private budgetUsedCents(budget: BudgetRecord, from: string, to: string): number {
    const summary = this.ctx.usage.summary({
      from, to,
      ...(budget.orgId ? { org: budget.orgId } : {}),
      ...(budget.subject ? { subject: budget.subject } : {}),
    })
    // '*' 通配（R3）：命中任意模型——取窗口总额，不做 byResource 过滤
    if (budget.modelSlug === '*') return summary.cost_cents
    if (budget.modelSlug) {
      const row = summary.byResource.find((item) => item.resource === `model:${budget.modelSlug}`)
      return row?.cost_cents ?? 0
    }
    return summary.cost_cents
  }

  /** 单预算的两窗状态（今日 / 本月，UTC 日界与 usage 报表口径一致）。 */
  budgetStatus(budget: BudgetRecord): { daily: BudgetWindowStatus | null; monthly: BudgetWindowStatus | null } {
    const now = new Date()
    const status = (limitCents: number | undefined, fromIso: string): BudgetWindowStatus | null => {
      if (limitCents === undefined) return null
      const usedCents = this.budgetUsedCents(budget, fromIso, now.toISOString())
      const ratio = limitCents <= 0 ? 1 : Math.round((usedCents / limitCents) * 1000) / 1000
      return { limitCents, usedCents, ratio, warn: ratio >= budget.warnRatio, breached: usedCents >= limitCents }
    }
    return {
      daily: status(budget.dailyLimitCents, `${now.toISOString().slice(0, 10)}T00:00:00.000Z`),
      monthly: status(budget.monthlyLimitCents, `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`),
    }
  }

  /**
   * org 维度预算进度（面板 cost chip / usage summary 的 budget 字段数据源）；无预算=null。
   * 只取「模型范围不限且无主体范围」的 org 级预算：模型范围不限 = 未声明 modelSlug，
   * 或 modelSlug='*'（R3 通配=命中任意模型，即全模型口径，视同 org 进度计入——
   * 此前 '*' 被 !modelSlug 一并排除，只配通配预算的组织在摘要里 budget 恒 null 与熔断面口径分裂）；
   * 字面量模型级预算是单模型口径、subject 预算是主体维度（R10）——两者不进 org 级进度。
   */
  budgetStatusFor(orgId: string): { orgId: string; daily: BudgetWindowStatus | null; monthly: BudgetWindowStatus | null } | null {
    const budget = this.budgets().all()
      .filter((item) => item.enabled && !item.subject && (!item.modelSlug || item.modelSlug === '*') && (item.orgId ?? '') === (orgId || ''))
      .sort((a, b) => (a.orgId ? 0 : 1) - (b.orgId ? 0 : 1))[0] // org 专属优先于平台级
    if (!budget) return null
    return { orgId: budget.orgId ?? t('（平台级）'), ...this.budgetStatus(budget) }
  }

  /**
   * 主体（Agent/应用）维度预算清单（R10 前置，执行中枢预算前置检查的契约方法）：
   * 过滤 enabled 且 subject 全等、预算无 orgId（平台级兜底）或 org 匹配的全部预算，
   * 逐条返回两窗状态（daily UTC 今日 / monthly 本月，与 budgetStatus 同一窗口口径）。
   */
  budgetStatusForSubject(subject: string, orgId?: string): Array<{ budget: BudgetRecord; daily: BudgetWindowStatus | null; monthly: BudgetWindowStatus | null }> {
    return this.budgets().all()
      .filter((item) => item.enabled
        && (item.subject ?? '') === subject
        && (!item.orgId || (orgId ?? '') === '' ? !item.orgId || (orgId ?? '') === '' : item.orgId === orgId))
      .map((budget) => ({ budget, ...this.budgetStatus(budget) }))
  }

  /** 删除预算（2026-10-14 删除面 R4）：预算治理此前只增不删，配错的预算只能停用滞留。 */
  removeBudget(id: string): void {
    const budget = this.budgets().get(id)
    if (!budget) throw new Error(t('预算不存在：{id}', { id }))
    this.budgets().remove(id)
    // 进程内告警去重状态一并清理，防止同 id 复用后当日告警被旧状态吞掉
    this.budgetWarnDay.delete(id)
  }

  /** 调用前熔断 + 阈值告警（每预算每自然日最多一条 warning 事件）。 */
  private enforceBudget(input: ModelInvokeInput): void {
    const candidates = this.budgets().all().filter((item) => {
      if (!item.enabled) return false
      // R3 通配：modelSlug='*' 命中任意模型；其余字面量精确匹配
      if (item.modelSlug && item.modelSlug !== '*' && item.modelSlug !== input.model) return false
      // R10 主体：subject 预算只对同主体（agent:<id>/app:<id>，与 usage 计量主体同口径）生效
      if (item.subject && item.subject !== (input.subject ?? '')) return false
      if (item.orgId && item.orgId !== input.orgId) return false
      return true
    })
    for (const budget of candidates) {
      const status = this.budgetStatus(budget)
      const day = new Date().toISOString().slice(0, 10)
      for (const window of [status.daily, status.monthly]) {
        if (!window) continue
        const scope = `${budget.orgId ?? 'platform'}${budget.modelSlug ? `/${budget.modelSlug}` : ''}`
        if (window.breached && budget.action === 'block') {
          throw new Error(t('预算熔断（{scope}）：{window}成本 {used} 分已达上限 {limit} 分（action=block）。请调整预算或等待窗口重置', {
            scope,
            window: window === status.daily ? t('今日') : t('本月'),
            used: window.usedCents,
            limit: window.limitCents,
          }))
        }
        if (window.warn && this.budgetWarnDay.get(budget.id) !== day) {
          this.budgetWarnDay.set(budget.id, day)
          this.ctx.platformBus.emit('modelgw.budget.warning', {
            budgetId: budget.id, orgId: budget.orgId ?? null, modelSlug: budget.modelSlug ?? null,
            window: window === status.daily ? 'daily' : 'monthly',
            limitCents: window.limitCents, usedCents: window.usedCents, ratio: window.ratio,
            action: budget.action, at: new Date().toISOString(),
          })
        }
      }
    }
  }

  // -- 调用 ---------------------------------------------------------------------

  async invoke(input: ModelInvokeInput): Promise<ModelInvokeResult> {
    // 工作级授权闸门（D10）：入口先过闸，再进资源级校验（渠道分级/预算/上游），两层授权取交集（§9.5）
    const work = await this.gateManagedModelCall(input.caller, input.model, input.work)
    // D14：受管时有效密级 = max(请求 dataClass 缺省 internal, 任用冻结上限)，经显式映射表落到网关分级
    // （topsecret 已在映射前拒绝）；非受管 legacy 路径 effectiveInput===input，现状不变
    const effectiveInput = work
      ? { ...input, dataClass: this.effectiveManagedDataClass(input.dataClass, work.dataClass) }
      : input
    const model = this.models().findOne((item) => item.slug === effectiveInput.model)
    if (!model) throw new Error(t('模型不存在：{slug}（请先在模型目录登记）', { slug: effectiveInput.model }))
    if (model.status !== 'online') throw new Error(t('模型已下线：{slug}', { slug: model.slug }))
    if (!model.endpoint) throw new Error(t('模型 {slug} 未配置 endpoint，拒绝调用（不生成假 completion）', { slug: model.slug }))
    // 分级路由（1-1）：越级直接拒绝（选择器锁死+原因）
    this.assertDataClassAllowed(model, effectiveInput.dataClass)
    // 预算熔断（1-4）：block 动作在调用前生效（受管调用预算不足自然失败 → workforce 侧落 BUDGET_EXCEEDED）
    try {
      this.enforceBudget(effectiveInput)
    } catch (error) {
      this.recordTelemetry({ model: model.slug, ok: false, latencyMs: 0, outputTokens: 0, error: t('预算熔断：{message}', { message: error instanceof Error ? error.message : String(error) }) })
      throw error
    }
    return this.invokeTracked(model, effectiveInput, INVOKE_TIMEOUT_MS, false)
  }

  /** 带遥测的单渠道调用：时延/成败/降级标记滚动落库（7d 可用率与 TPS 代理的数据源）。 */
  private async invokeTracked(model: ModelRecord, input: ModelInvokeInput, timeoutMs: number, degraded: boolean): Promise<ModelInvokeResult> {
    // #17（2026-10-29）：组织归属先于上游调用校验（fail-fast）——此前 orgId 空串会在模型已应答、
    // token 已消耗后的计量落账处抛「usage 事件 org 必填」（先花钱后报错，且该次成本未入账）
    if (!input.orgId?.trim()) {
      throw new Error(t('模型调用缺少组织归属（orgId 必填）：调用方须解析主体/部门/平台根组织后重试（#17 fail-fast）'))
    }
    const startedAt = Date.now()
    try {
      const result = await this.invokeOnce(model, input, timeoutMs)
      this.recordTelemetry({ model: model.slug, ok: true, latencyMs: Date.now() - startedAt, outputTokens: result.outputTokens, degraded })
      return result
    } catch (error) {
      this.recordTelemetry({
        model: model.slug, ok: false, latencyMs: Date.now() - startedAt, outputTokens: 0, degraded,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  private async invokeOnce(model: ModelRecord, input: ModelInvokeInput, timeoutMs: number): Promise<ModelInvokeResult> {
    const apiKey = model.apiKey.startsWith('env:') ? (process.env[model.apiKey.slice(4)] ?? '') : model.apiKey
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let payload: {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      const response = await fetch(`${model.endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          // QA B-02：以实际调用渠道为准——降级链入参为 Omit<…,'model'>，原写法转发体缺 model 字段，
          // 真实 OpenAI 兼容上游下备渠道全链 400
          model: model.slug,
          messages: input.messages,
          ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = (await response.text()).slice(0, 300)
        const error = new Error(t('模型上游 HTTP {status}：{text}', { status: response.status, text })) as ModelInvokeError
        error.status = response.status
        error.kind = 'http'
        throw error
      }
      payload = (await response.json()) as typeof payload
    } catch (error) {
      if (error instanceof Error && (error as ModelInvokeError).kind === 'http') throw error
      const message = error instanceof Error ? (error.name === 'AbortError' ? t('模型调用超时（{ms}ms）', { ms: timeoutMs }) : error.message) : String(error)
      const wrapped = new Error(message) as ModelInvokeError
      wrapped.kind = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network'
      throw wrapped
    } finally {
      clearTimeout(timer)
    }
    const content = payload.choices?.[0]?.message?.content ?? ''
    const inputTokens = payload.usage?.prompt_tokens ?? 0
    const outputTokens = payload.usage?.completion_tokens ?? 0

    // #14（2026-10-29）组合计价：input/output 分别按价格簿费率折算（调用时点读取，价格簿仍是
    // 唯一调价面；行明细原样进 usage 快照 rate.line_items，对账可复算）。费率未登记的行不入列
    //（usage 侧回落价格簿单米口径；主条目缺失时 record 照旧响亮拒绝）。
    const outputPrice = this.ctx.usage.priceOfResource(`model:${model.slug}`)
    const inputPrice = this.ctx.usage.priceOfResource(`model:${model.slug}:input`)
    const costLineItems = [
      ...(outputPrice && outputPrice.cost_cents_per_unit > 0 && outputTokens > 0
        ? [{ meter_key: 'output_tokens', value: outputTokens, cost_cents_per_unit: outputPrice.cost_cents_per_unit, units_per_step: outputPrice.units_per_step }]
        : []),
      ...(inputPrice && inputPrice.cost_cents_per_unit > 0 && inputTokens > 0
        ? [{ meter_key: 'input_tokens', value: inputTokens, cost_cents_per_unit: inputPrice.cost_cents_per_unit, units_per_step: inputPrice.units_per_step }]
        : []),
    ]

    // 计量：input/output tokens 实测值（先计量后返回）；零价快照入账（charge=0），
    // cost 按内部成本参考折算，供成本穿透报表
    const event = this.ctx.usage.record({
      org: input.orgId,
      subject: input.subject,
      principal: `org:${input.orgId}`,
      resource: `model:${model.slug}`,
      ...(input.tenantId !== undefined ? { tenant_id: input.tenantId } : {}),
      meters: [
        { key: 'input_tokens', value: inputTokens, unit: 'token' },
        { key: 'output_tokens', value: outputTokens, unit: 'token' },
      ],
      ...(costLineItems.length > 0 ? { costLineItems } : {}),
      idempotency_key: `modelgw:${newId('mi')}`,
      // 工作关联（D11/V23/V27 additive）：受管调用时把 workforce 调用 ID 作为统一 trace 附加——
      // 幂等键 modelgw:<mi> 与历史键 model:<slug> 照旧不改；usage 侧未识别的关联字段由组7增量承接
      ...(input.work?.invocationId ? { trace_id: input.work.invocationId } : {}),
    })

    return {
      ok: true,
      content,
      model: model.slug,
      inputTokens,
      outputTokens,
      costCents: event.pricing.cost_cents,
      // usage 事件回执（additive）：供工作调用账本对账关联（只关联，不重复登记消费）
      usageEventId: event.event_id,
    }
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelGateway: ModelGatewayService
  }
}

export const name = 'modelgw'
export const inject = ['opsStorage', 'usage', 'platformBus', 'workforcePolicy']

export function apply(ctx: Context) {
  ctx.plugin(ModelGatewayService)
  ctx.plugin(modelgwTools)
}
