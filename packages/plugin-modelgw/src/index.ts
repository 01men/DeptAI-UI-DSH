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
import { newId, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import * as modelgwTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/** 数据分级（PRD §4.1/§7.2）：公开 < 内部 < 秘密；渠道按上限接纳数据。 */
export type DataClass = 'public' | 'internal' | 'secret'

export const DATA_CLASS_RANK: Record<DataClass, number> = { public: 0, internal: 1, secret: 2 }
export const DATA_CLASS_LABELS: Record<DataClass, string> = { public: '公开', internal: '内部', secret: '秘密' }

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
  modelSlug?: string
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
    return created
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
        reason: `渠道分级上限为「${DATA_CLASS_LABELS[limit]}」，低于本次数据「${DATA_CLASS_LABELS[dataClass]}」——涉密/内部数据不得路由到低分级渠道（PRD §7.2）`,
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
        `数据分级越界：本次会话数据为「${DATA_CLASS_LABELS[requestClass]}」，渠道 ${model.slug} 分级上限仅「${DATA_CLASS_LABELS[limit]}」——已按 PRD §7.2 锁死该路由`,
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
        throw new Error(`渠道组引用了未登记的模型：${slug}（请先在模型目录登记）`)
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
   * 内容安全拦截：外部内容安全网关未接入（诚实缺位），接入后在 invokeOnce 返回路径上挂钩。
   */
  async invokeWithFallback(input: Omit<ModelInvokeInput, 'model'> & { group: string }): Promise<ModelInvokeResult | { ok: false; escalated: true; reason: string; degradations: Array<{ from: string; reason: string; at: string }> }> {
    const group = this.channelGroups().findOne((item) => item.slug === input.group)
    if (!group) throw new Error(`渠道组不存在：${input.group}（请先登记主/备渠道组）`)
    if (!group.enabled) throw new Error(`渠道组已停用：${group.slug}`)
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
          group: group.slug, from: slug, to: chain[index + 1] ?? (group.manual ? 'manual:人工' : '（链尾）'),
          reason, step: index + 1, subject: input.subject, orgId: input.orgId,
        })
      }
      if (!model) {
        reject(`渠道组引用的模型未登记：${slug}`)
        continue
      }
      if (model.status !== 'online' || model.endpoint.trim() === '') {
        reject(`备用渠道不可调用（${model.status === 'online' ? '未配置 endpoint' : '已下线'}）：${slug}`)
        continue
      }
      try {
        // 分级路由（1-1）逐步校验：备用渠道分级低于请求数据分级时同样锁死
        this.assertDataClassAllowed(model, input.dataClass)
      } catch (error) {
        reject(error instanceof Error ? error.message : String(error))
        continue
      }
      try {
        const result = await this.invokeTracked(model, input, stepTimeoutMs, index > 0)
        if (degradations.length > 0) return { ...result, degradations }
        return result
      } catch (error) {
        reject(error instanceof Error ? error.message : String(error))
      }
    }
    if (group.manual) return { ok: false, escalated: true, reason: `渠道组 ${group.slug} 全链失败，已按配置转人工：${lastError}`, degradations }
    throw new Error(`渠道组 ${group.slug} 全链失败（无转人工配置）：${lastError}`)
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
      note: 'TTFT 需流式通道（当前网关为非流式单轮）诚实缺列；TPS 为 output_tokens/总时延 的代理口径；采纳率取 model:<slug> 资源的 👍/👎 聚合',
    }
  }

  // -- 预算与熔断（1-4） --------------------------------------------------------

  budgets(): Collection<BudgetRecord> {
    return this.ctx.opsStorage.collection<BudgetRecord>('modelgw:budgets')
  }

  upsertBudget(input: Omit<BudgetRecord, 'id' | 'createdAt' | 'updatedAt'>): BudgetRecord {
    if (input.dailyLimitCents === undefined && input.monthlyLimitCents === undefined) {
      throw new Error('预算至少配置 dailyLimitCents / monthlyLimitCents 之一')
    }
    const existing = this.budgets().findOne((item) =>
      (item.orgId ?? '') === (input.orgId ?? '') && (item.modelSlug ?? '') === (input.modelSlug ?? ''))
    if (existing) return this.budgets().update(existing.id, { ...input })
    return this.budgets().insert({ id: newId('mbgt'), ...input })
  }

  /** 预算命中的花费口径：org×模型过滤的 usage 成本聚合（内部成本参考口径 cost_cents）。 */
  private budgetUsedCents(budget: BudgetRecord, from: string, to: string): number {
    const summary = this.ctx.usage.summary({
      from, to,
      ...(budget.orgId ? { org: budget.orgId } : {}),
    })
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

  /** org 维度预算进度（面板 cost chip / usage summary 的 budget 字段数据源）；无预算=null。 */
  budgetStatusFor(orgId: string): { orgId: string; daily: BudgetWindowStatus | null; monthly: BudgetWindowStatus | null } | null {
    const budget = this.budgets().all()
      .filter((item) => item.enabled && !item.modelSlug && (item.orgId ?? '') === (orgId || ''))
      .sort((a, b) => (a.orgId ? 0 : 1) - (b.orgId ? 0 : 1))[0] // org 专属优先于平台级
    if (!budget) return null
    return { orgId: budget.orgId ?? '（平台级）', ...this.budgetStatus(budget) }
  }

  /** 调用前熔断 + 阈值告警（每预算每自然日最多一条 warning 事件）。 */
  private enforceBudget(input: ModelInvokeInput): void {
    const candidates = this.budgets().all().filter((item) => {
      if (!item.enabled) return false
      if (item.modelSlug && item.modelSlug !== input.model) return false
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
          throw new Error(`预算熔断（${scope}）：${window === status.daily ? '今日' : '本月'}成本 ${window.usedCents} 分已达上限 ${window.limitCents} 分（action=block）。请调整预算或等待窗口重置`)
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
    const model = this.models().findOne((item) => item.slug === input.model)
    if (!model) throw new Error(`模型不存在：${input.model}（请先在模型目录登记）`)
    if (model.status !== 'online') throw new Error(`模型已下线：${model.slug}`)
    if (!model.endpoint) throw new Error(`模型 ${model.slug} 未配置 endpoint，拒绝调用（不生成假 completion）`)
    // 分级路由（1-1）：越级直接拒绝（选择器锁死+原因）
    this.assertDataClassAllowed(model, input.dataClass)
    // 预算熔断（1-4）：block 动作在调用前生效
    try {
      this.enforceBudget(input)
    } catch (error) {
      this.recordTelemetry({ model: model.slug, ok: false, latencyMs: 0, outputTokens: 0, error: `预算熔断：${error instanceof Error ? error.message : String(error)}` })
      throw error
    }
    return this.invokeTracked(model, input, INVOKE_TIMEOUT_MS, false)
  }

  /** 带遥测的单渠道调用：时延/成败/降级标记滚动落库（7d 可用率与 TPS 代理的数据源）。 */
  private async invokeTracked(model: ModelRecord, input: ModelInvokeInput, timeoutMs: number, degraded: boolean): Promise<ModelInvokeResult> {
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
        const error = new Error(`模型上游 HTTP ${response.status}：${text}`) as ModelInvokeError
        error.status = response.status
        error.kind = 'http'
        throw error
      }
      payload = (await response.json()) as typeof payload
    } catch (error) {
      if (error instanceof Error && (error as ModelInvokeError).kind === 'http') throw error
      const message = error instanceof Error ? (error.name === 'AbortError' ? `模型调用超时（${timeoutMs}ms）` : error.message) : String(error)
      const wrapped = new Error(message) as ModelInvokeError
      wrapped.kind = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network'
      throw wrapped
    } finally {
      clearTimeout(timer)
    }
    const content = payload.choices?.[0]?.message?.content ?? ''
    const inputTokens = payload.usage?.prompt_tokens ?? 0
    const outputTokens = payload.usage?.completion_tokens ?? 0

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
      idempotency_key: `modelgw:${newId('mi')}`,
    })

    return {
      ok: true,
      content,
      model: model.slug,
      inputTokens,
      outputTokens,
      costCents: event.pricing.cost_cents,
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
export const inject = ['opsStorage', 'usage', 'platformBus']

export function apply(ctx: Context) {
  ctx.plugin(ModelGatewayService)
  ctx.plugin(modelgwTools)
}
