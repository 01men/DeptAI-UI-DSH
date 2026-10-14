/**
 * @dsh-ops/plugin-usage —— usage 计量管道（生态设计 v1.2 第 2 步）。
 *
 * 全平台唯一的资源消耗计量入口：
 *   资源消耗方（MCP 网关 / 模型网关 / 插件运行时）
 *     → usage.record()（schema v1 校验 → SQLite 先写后发 → platformBus 广播）
 *     → 订阅方（audit 成本归集 / billing 扣费 / market 分成 / 对账引擎）
 *
 * schema 语义（定版 additive-only）：
 *   - usage.recorded schema_version=1：字段只增不改不删；新字段只能以可选形式随 minor 版本加入；
 *   - 消费端必须容忍未知新字段（前向兼容义务）；
 *   - 弃用字段走 platform.schema.deprecated 事件，历史数据不迁移不重算。
 * 投递语义（M8）：at-least-once + 消费端按 idempotency_key 幂等；先落库后分发（宕机不丢）；
 *   消费异常重试 3 次入死信集合并告警；支持按时间窗重放。
 *
 * schema 变更记录（action-plan-dsh-frontend WP-03 / 默认决议 D1、D2，2026-09-02）：
 *   - D1 resource 值域增补 `app:<id>`、`kb:<orgId>`（additive）：价格簿播种零费率 `app:*`/`kb:*`
 *     （meter_key=calls），是否计费由运营调价决定；
 *   - D2 非计费事件统一零价快照：零费率规则产出 charge_cents=0 且 rate.nonbillable=true；
 *     UsageRecordInput.nonbillable=true 为便捷构造入口（非计费反馈/知识事件），仅允许配零费率规则，
 *     防止「标了非计费却按计费规则入账」的口径漂移。
 *
 * 商业模式收敛（元冰可开发计划 M0，2026-09-09）：平台商业口径为「私有化年费 + 治理包」，
 * usage 管道定位为**用量透明计量与内部成本参考**——价格簿 list 侧统一零价快照（charge_cents=0，
 * 不对外呈现任何金额结算语义），cost 侧保留内部采购成本参考（成本穿透报表口径，见 docs/contract-j4-usage-report.md）。
 * monthlyReport() 提供 J4 契约的 tokens 三维聚合（部门 org / Agent / Skill）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import * as usageTools from './tools.ts'

// ---------------------------------------------------------------------------
// schema v1（定版）
// ---------------------------------------------------------------------------

export const USAGE_SCHEMA = 'usage.recorded'
export const USAGE_SCHEMA_VERSION = 1

/** 可扩展计量字典条目：替代固定 token 三件套，L3 自定义计量同结构接入。 */
export interface UsageMeter {
  key: string
  value: number
  unit: string
}

/** 价格快照（计费时点冻结，历史可复算）。 */
export interface UsagePricingSnapshot {
  currency: string
  /** 本事件应收（列表价口径，含税）。 */
  charge_cents: number
  /** 本事件平台成本（口径：L1 采购成本）。 */
  cost_cents: number
  /** 计价明细快照（费率 + 计量键），分账/审计复算依据。 */
  rate: { pattern: string; meter_key: string; list_cents_per_unit: number; cost_cents_per_unit: number; units_per_step: number; tax_rate: number; nonbillable?: boolean }
}

/** usage.recorded v1 事件（只追加，禁改版；扩展仅允许新增可选字段）。 */
export interface UsageEvent {
  schema: typeof USAGE_SCHEMA
  schema_version: number
  event_id: string
  idempotency_key: string
  trace_id?: string
  occurred_at: string
  tenant_id: string
  org: string
  /** 最终用户/Agent（on-behalf-of 终点）：user:<id> | agent:<id> */
  subject: string
  /** 计费责任主体：org:<id> | plugin:<id> | app:<id> | platform */
  principal: string
  /** 资源：model:<slug> | plugin:<id> | mcp:<slug> | skill:<id> | nas:<id> | app:<id> | kb:<orgId>（D1 additive） */
  resource: string
  meters: UsageMeter[]
  pricing: UsagePricingSnapshot
}

/** 计量事件登记入参（schema 校验后由 record() 补全派生字段）。 */
export interface UsageRecordInput {
  org: string
  subject: string
  principal: string
  resource: string
  meters: UsageMeter[]
  tenant_id?: string
  trace_id?: string
  /** 幂等键：调用方自带（推荐，如 <producer>:<业务单号>）；缺省按主体+资源+窗口+序号生成。 */
  idempotency_key?: string
  occurred_at?: string
  /**
   * 非计费便捷构造（D2 零价快照）：true 时要求该资源命中零费率价格簿规则，
   * 事件按 charge_cents=0 + rate.nonbillable=true 入账（反馈/知识等观测事件不污染计费口径）。
   */
  nonbillable?: boolean
}

/**
 * D2 零价快照便捷构造：非计费观测事件（反馈/知识包使用等）统一按零费率 calls 计量登记。
 * 返回值可直接交给 usage.record()；资源必须命中零费率价格簿规则（app: 与 kb: 前缀已默认播种），
 * 否则 record() 拒绝（nonbillable 标记防口径漂移）。
 */
export function nonbillableUsage(base: Omit<UsageRecordInput, 'meters' | 'nonbillable'> & { calls?: number }): UsageRecordInput {
  return { ...base, meters: [{ key: 'calls', value: base.calls ?? 1, unit: 'call' }], nonbillable: true }
}

/** 价格簿条目：resource 模式（精确 → 前缀匹配）→ 计量键与费率。 */
export interface PriceBookEntry extends RecordBase {
  pattern: string
  meter_key: string
  list_cents_per_unit: number
  cost_cents_per_unit: number
  units_per_step: number
  tax_rate: number
  currency: string
  /** 费率版本（分录快照引用，历史可复算）。 */
  rate_version: string
}

/** 能力授权登记（M5 运行时对账基线）：market 安装插件时写入。 */
export interface CapabilityGrantRecord extends RecordBase {
  principal: string
  capabilities: string[]
  source: string
}

/** 死信（消费 3 次失败的事件）。 */
export interface DeadLetterRecord extends RecordBase {
  event_id: string
  consumer: string
  error: string
  attempts: number
}

export type UsageConsumer = (event: UsageEvent) => void

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

const DEFAULT_TENANT = 't_default'
const WINDOW_MS = 60_000

export class UsageService extends Service {
  static readonly provide = 'usage'

  private consumers = new Map<string, { handler: UsageConsumer; attempts: Map<string, number> }>()
  private seq = 0
  /** REL-11 读侧加固：已发过 warning 的脏数据键（进程内去重，防告警风暴）。 */
  private warnedDirtyKeys = new Set<string>()
  /** 事件保留天数（USAGE_RETENTION_DAYS，默认 730=2 年；0=永久保留不清理）。 */
  readonly retentionDays: number
  private retentionTimer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context) {
    super(ctx, 'usage')
    ctx.txnStore.ensureTable('usage_events', {
      id: 'TEXT',
      idempotency_key: 'TEXT NOT NULL',
      schema_version: 'INTEGER NOT NULL',
      occurred_at: 'TEXT NOT NULL',
      tenant_id: 'TEXT NOT NULL',
      org: "TEXT NOT NULL DEFAULT ''",
      subject: "TEXT NOT NULL DEFAULT ''",
      principal: 'TEXT NOT NULL',
      resource: 'TEXT NOT NULL',
      meters_json: 'TEXT NOT NULL',
      pricing_json: 'TEXT NOT NULL',
      trace_id: "TEXT NOT NULL DEFAULT ''",
    }, { uniques: [['idempotency_key']], indexes: [['occurred_at'], ['principal'], ['tenant_id']] })
    // 消费水位（引擎级幂等）：同一消费方对同一事件只产生一次副作用——
    // replay()/死信重投不会造成 billing/audit 投影双计（评审实证缺陷的修复点）。
    ctx.txnStore.ensureTable('usage_consumptions', {
      consumer: 'TEXT NOT NULL',
      event_id: 'TEXT NOT NULL',
      at: 'TEXT NOT NULL',
    }, { primaryKey: ['consumer', 'event_id'] })
    const retention = Number(process.env.USAGE_RETENTION_DAYS ?? 730)
    this.retentionDays = Number.isFinite(retention) && retention > 0 ? Math.floor(retention) : 0
    if (this.retentionDays > 0) {
      ctx.logger('usage').info(`usage 事件保留策略：${this.retentionDays} 天（USAGE_RETENTION_DAYS，0=永久）`)
      // 启动 20s 后首跑 + 每 6h 巡检（对齐 iam 连接器自动同步的构造期定时器惯例）
      const first = setTimeout(() => void this.sweepRetention(), 20_000)
      ctx.effect(() => () => clearTimeout(first))
      this.retentionTimer = setInterval(() => void this.sweepRetention(), 6 * 3_600_000)
      this.retentionTimer.unref?.() // OPT-P3-02
      ctx.effect(() => {
        if (this.retentionTimer) clearInterval(this.retentionTimer)
      })
    }
    this.ensureDefaultPriceBook()
  }

  /**
   * 保留策略巡检：清理超出保留窗口的 usage_events，连带消费水位与对应死信。
   * 语义（发布说明 2026-09-11 登记）：事件被清理后，同幂等键重报将按新事件重新入账——
   * 保留窗口即删除契约；J4 月度报表窗口（近 13 个月）在默认 730 天窗口内不受影响。
   */
  purgeExpired(daysOverride?: number): { cutoff: string; purgedEvents: number; purgedWatermarks: number; purgedDeadLetters: number } {
    const days = daysOverride ?? this.retentionDays
    if (!(days > 0)) return { cutoff: '', purgedEvents: 0, purgedWatermarks: 0, purgedDeadLetters: 0 }
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
    // 死信先对表：事件已出窗的死信一并移除（保留它们只会让重投在事件缺失时才被动清理）
    let purgedDeadLetters = 0
    for (const letter of this.deadLetters().all()) {
      const row = this.ctx.txnStore.one<UsageRow>('usage_events', { id: letter.event_id })
      if (row && row.occurred_at < cutoff) {
        this.deadLetters().remove(letter.id)
        purgedDeadLetters++
      }
    }
    const purgedWatermarks = this.ctx.txnStore.run(
      'DELETE FROM usage_consumptions WHERE event_id IN (SELECT id FROM usage_events WHERE occurred_at < ?)',
      [cutoff],
    )
    const purgedEvents = this.ctx.txnStore.run('DELETE FROM usage_events WHERE occurred_at < ?', [cutoff])
    if (purgedEvents > 0) {
      this.ctx.logger('usage').info(`usage 保留清理：${purgedEvents} 事件 / ${purgedWatermarks} 消费水位 / ${purgedDeadLetters} 死信（cutoff=${cutoff}）`)
    }
    return { cutoff, purgedEvents, purgedWatermarks, purgedDeadLetters }
  }

  private async sweepRetention(): Promise<void> {
    try {
      this.purgeExpired()
    } catch (error) {
      this.ctx.logger('usage').warn('usage 保留巡检失败', error)
    }
  }

  // -- 登记与分发 -----------------------------------------------------------

  /** 全平台唯一计量入口：校验 → 计价 → 落库（幂等）→ 总线分发。 */
  record(input: UsageRecordInput): UsageEvent {
    this.validate(input)
    const tenant = input.tenant_id ?? this.resolveTenant(input.org)
    const price = this.priceOf(input.resource)
    // D2 非计费便捷构造：nonbillable 标记只允许配零费率规则（防「标了非计费却按计费规则入账」）
    if (input.nonbillable === true && !(price.list_cents_per_unit === 0 && price.cost_cents_per_unit === 0)) {
      throw new Error(`非计费事件只允许命中零费率价格簿规则：资源 ${input.resource} 命中 ${price.pattern}（非零费率），请去掉 nonbillable 或先调零费率`)
    }
    // 零费率规则产出的即非计费事件（统一零价快照口径）：charge_cents=0 + rate.nonbillable=true
    const nonbillable = input.nonbillable === true || (price.list_cents_per_unit === 0 && price.cost_cents_per_unit === 0)
    // 硬校验：事件必须携带价格簿计价键（宁可拒绝不可静默 0 计费——
    // 价格簿对调用方不可见（usage.admin），错误信息直接携带期望键供自纠）
    if (!input.meters.some((item) => item.key === price.meter_key)) {
      throw new Error(
        `计量键不匹配：资源 ${input.resource} 按价格簿 ${price.pattern} 以「${price.meter_key}」计价，` +
        `收到 [${input.meters.map((m) => m.key).join(', ')}]。请按 ${price.meter_key} 重报，不要编造计量键`,
      )
    }
    const meter = input.meters.find((item) => item.key === price.meter_key)!
    // REL-11 读侧加固：存量脏费率（非有限/负值/零步长）按 0 计价并发 warning（防永久投毒）；
    // 合法数值走原值，计价结果不变。快照记录实际采用的修正值（非有限值 JSON 序列化为 null 会继续污染对账）
    const listRate = Number.isFinite(price.list_cents_per_unit) && price.list_cents_per_unit >= 0
      ? price.list_cents_per_unit
      : this.warnDirtyData(`pricebook:${price.pattern}:list`, `价格簿 ${price.pattern} 的 list_cents_per_unit=${String(price.list_cents_per_unit)} 为非法数值，本次计价按 0 处理；请尽快修正价格簿（REL-11）`)
    const costRate = Number.isFinite(price.cost_cents_per_unit) && price.cost_cents_per_unit >= 0
      ? price.cost_cents_per_unit
      : this.warnDirtyData(`pricebook:${price.pattern}:cost`, `价格簿 ${price.pattern} 的 cost_cents_per_unit=${String(price.cost_cents_per_unit)} 为非法数值，本次计价按 0 处理；请尽快修正价格簿（REL-11）`)
    const step = Number.isFinite(price.units_per_step) && price.units_per_step > 0
      ? price.units_per_step
      : this.warnDirtyData(`pricebook:${price.pattern}:step`, `价格簿 ${price.pattern} 的 units_per_step=${String(price.units_per_step)} 为非法数值（须为正数），本次计价按 0 处理；请尽快修正价格簿（REL-11）`)
    const charge = step > 0 ? Math.round((meter.value / step) * listRate) : 0
    const cost = step > 0 ? Math.round((meter.value / step) * costRate) : 0
    const event: UsageEvent = {
      schema: USAGE_SCHEMA,
      schema_version: USAGE_SCHEMA_VERSION,
      event_id: newId('uevt'),
      idempotency_key: input.idempotency_key ?? this.autoIdempotencyKey(input),
      ...(input.trace_id !== undefined ? { trace_id: input.trace_id } : {}),
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      tenant_id: tenant,
      org: input.org,
      subject: input.subject,
      principal: input.principal,
      resource: input.resource,
      meters: input.meters,
      pricing: {
        currency: price.currency,
        charge_cents: charge,
        cost_cents: cost,
        rate: {
          pattern: price.pattern,
          meter_key: price.meter_key,
          // REL-11：记录实际采用的修正后费率（合法数值时与原值恒等）
          list_cents_per_unit: listRate,
          cost_cents_per_unit: costRate,
          units_per_step: step,
          tax_rate: price.tax_rate,
          ...(nonbillable ? { nonbillable: true } : {}),
        },
      },
    }
    const inserted = this.ctx.txnStore.insertOrIgnore('usage_events', usageRow(event))
    if (!inserted) {
      const existing = this.ctx.txnStore.one<UsageRow>('usage_events', { idempotency_key: event.idempotency_key })
      if (!existing) throw new Error(`幂等键异常：${event.idempotency_key} 已占用但记录缺失`)
      const sameContent = existing.org === event.org
        && existing.subject === event.subject
        && existing.principal === event.principal
        && existing.resource === event.resource
        && existing.meters_json === JSON.stringify(event.meters)
      if (!sameContent) {
        throw new Error(`幂等键冲突：${event.idempotency_key} 已绑定事件 ${existing.id}，同键不同内容被拒绝`)
      }
      // 幂等重放：返回既有事件（计价快照以首次登记为准，不随费率变动重算）
      return rowToEvent(existing)
    }
    this.dispatch(event)
    return event
  }

  /** 注册消费方（at-least-once；3 次失败入死信）。 */
  consume(consumerId: string, handler: UsageConsumer): () => void {
    this.consumers.set(consumerId, { handler, attempts: new Map() })
    return () => this.consumers.delete(consumerId)
  }

  /**
   * 分发：at-least-once 语义下的「效果恰好一次」——
   *   1. 先占消费水位（INSERT OR IGNORE）：已消费过的事件直接跳过（replay 幂等）；
   *   2. 处理器失败即释放水位，立即退避重试（真实执行，共 3 次）；
   *   3. 3 次均失败入死信（持久化）并告警，可经 retryDeadLetters() 人工重投。
   */
  private dispatch(event: UsageEvent): void {
    this.ctx.platformBus.emit(USAGE_SCHEMA, event)
    for (const [consumerId, entry] of this.consumers) {
      const claimed = this.ctx.txnStore.insertOrIgnore('usage_consumptions', {
        consumer: consumerId, event_id: event.event_id, at: new Date().toISOString(),
      })
      if (!claimed) continue // 已消费（replay/重投）：幂等跳过
      let delivered = false
      for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
        try {
          entry.handler(event)
          entry.attempts.delete(`${consumerId}:${event.event_id}`)
          delivered = true
        } catch (error) {
          // 立即重试（同步管道不阻塞事件循环）：瞬时失败最多 3 次真实执行
          if (attempt < 3) continue
          // 释放消费水位，允许人工重投时重新消费
          this.ctx.txnStore.run('DELETE FROM usage_consumptions WHERE consumer = ? AND event_id = ?', [consumerId, event.event_id])
          this.deadLetters().insert({
            id: newId('dlq'), event_id: event.event_id, consumer: consumerId,
            error: error instanceof Error ? error.message : String(error), attempts: attempt,
          })
          this.ctx.platformBus.emit('audit.alert.fired', {
            id: newId('alt'), severity: 'critical', title: 'usage 消费死信',
            message: `消费方 ${consumerId} 处理事件 ${event.event_id} 连续失败 ${attempt} 次（含即时重试），已入死信，可通过 usage_deadletter_retry 重投`,
          })
        }
      }
    }
  }

  /** 重放窗口内事件（消费水位保证幂等：重复重放不产生重复副作用）。 */
  replay(sinceIso: string): { replayed: number } {
    const rows = this.ctx.txnStore.sql<UsageRow>(
      'SELECT * FROM usage_events WHERE occurred_at >= ? ORDER BY occurred_at',
      [sinceIso],
    )
    for (const row of rows) this.dispatch(rowToEvent(row))
    return { replayed: rows.length }
  }

  /** 死信重投：逐条重新分发，成功即移出死信队列。返回 {retried, remaining}。 */
  retryDeadLetters(): { retried: number; remaining: number } {
    const letters = this.deadLetters().all()
    let retried = 0
    for (const letter of letters) {
      const row = this.ctx.txnStore.one<UsageRow>('usage_events', { id: letter.event_id })
      if (!row) {
        this.deadLetters().remove(letter.id) // 事件已不存在（清理/过期）：死信一并移除
        continue
      }
      const consumer = this.consumers.get(letter.consumer)
      if (!consumer) continue // 消费方未注册（插件未加载）：保留死信
      this.deadLetters().remove(letter.id)
      try {
        const claimed = this.ctx.txnStore.insertOrIgnore('usage_consumptions', {
          consumer: letter.consumer, event_id: letter.event_id, at: new Date().toISOString(),
        })
        if (!claimed) {
          retried++
          continue
        }
        consumer.handler(rowToEvent(row))
        retried++
      } catch (error) {
        this.deadLetters().insert({
          id: newId('dlq'), event_id: letter.event_id, consumer: letter.consumer,
          error: `重投仍失败：${error instanceof Error ? error.message : String(error)}`, attempts: letter.attempts + 1,
        })
      }
    }
    return { retried, remaining: this.deadLetters().count() }
  }

  // -- 查询 -----------------------------------------------------------------

  query(filter: { tenant_id?: string; principal?: string; resource?: string; from?: string; to?: string; limit?: number } = {}): { total: number; items: UsageEvent[] } {
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (filter.tenant_id) { conditions.push('tenant_id = ?'); params.push(filter.tenant_id) }
    if (filter.principal) { conditions.push('principal = ?'); params.push(filter.principal) }
    if (filter.resource) { conditions.push('resource = ?'); params.push(filter.resource) }
    if (filter.from) { conditions.push('occurred_at >= ?'); params.push(filter.from) }
    if (filter.to) { conditions.push('occurred_at <= ?'); params.push(filter.to) }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.ctx.txnStore.sql<UsageRow>(`SELECT * FROM usage_events${where} ORDER BY occurred_at DESC LIMIT ?`, [...params, Math.min(filter.limit ?? 100, 1000)])
    const total = Number((this.ctx.txnStore.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_events${where}`, params)[0] ?? { n: 0 }).n)
    return { total, items: rows.map(rowToEvent) }
  }

  totals(filter: { tenant_id?: string; principal?: string; resource?: string; from?: string; to?: string } = {}): { count: number; charge_cents: number; cost_cents: number } {
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (filter.tenant_id) { conditions.push('tenant_id = ?'); params.push(filter.tenant_id) }
    if (filter.principal) { conditions.push('principal = ?'); params.push(filter.principal) }
    // QA B-03：resource 过滤此前在 SQL 缺列被静默忽略（usage_query 工具返回全库数字）——补齐
    if (filter.resource) { conditions.push('resource = ?'); params.push(filter.resource) }
    if (filter.from) { conditions.push('occurred_at >= ?'); params.push(filter.from) }
    if (filter.to) { conditions.push('occurred_at <= ?'); params.push(filter.to) }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const row = this.ctx.txnStore.sql<{ n: number; charge: number; cost: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(json_extract(pricing_json, '$.charge_cents') AS INTEGER)), 0) AS charge, COALESCE(SUM(CAST(json_extract(pricing_json, '$.cost_cents') AS INTEGER)), 0) AS cost FROM usage_events${where}`,
      params,
    )[0] ?? { n: 0, charge: 0, cost: 0 }
    return { count: Number(row.n), charge_cents: Number(row.charge), cost_cents: Number(row.cost) }
  }

  /**
   * 运营分析聚合（资产运营页/成本穿透报表）：窗口内按资源 / 归口主体（组织）/ 日趋势分组。
   * 一次 SQL 各取一份聚合，供「谁在用什么资产、内部成本多少」的运营口径。
   * M0-3：金额口径为内部成本参考（cost_cents）；charge_cents 零价快照恒 0，仅为事件快照兼容字段。
   */
  breakdown(fromIso: string): {
    byResource: Array<{ resource: string; count: number; charge_cents: number; cost_cents: number }>
    byPrincipal: Array<{ principal: string; count: number; charge_cents: number; cost_cents: number }>
    byDay: Array<{ day: string; count: number; charge_cents: number; cost_cents: number }>
  } {
    const byResource = this.ctx.txnStore.sql<{ resource: string; count: number; charge_cents: number; cost_cents: number }>(
      "SELECT resource, COUNT(*) AS count, COALESCE(SUM(CAST(json_extract(pricing_json, '$.charge_cents') AS INTEGER)), 0) AS charge_cents, COALESCE(SUM(CAST(json_extract(pricing_json, '$.cost_cents') AS INTEGER)), 0) AS cost_cents FROM usage_events WHERE occurred_at >= ? GROUP BY resource ORDER BY cost_cents DESC, count DESC",
      [fromIso],
    ).map((row) => ({ resource: row.resource, count: Number(row.count), charge_cents: Number(row.charge_cents), cost_cents: Number(row.cost_cents) }))
    const byPrincipal = this.ctx.txnStore.sql<{ principal: string; count: number; charge_cents: number; cost_cents: number }>(
      "SELECT principal, COUNT(*) AS count, COALESCE(SUM(CAST(json_extract(pricing_json, '$.charge_cents') AS INTEGER)), 0) AS charge_cents, COALESCE(SUM(CAST(json_extract(pricing_json, '$.cost_cents') AS INTEGER)), 0) AS cost_cents FROM usage_events WHERE occurred_at >= ? GROUP BY principal ORDER BY cost_cents DESC, count DESC",
      [fromIso],
    ).map((row) => ({ principal: row.principal, count: Number(row.count), charge_cents: Number(row.charge_cents), cost_cents: Number(row.cost_cents) }))
    const byDay = this.ctx.txnStore.sql<{ day: string; count: number; charge_cents: number; cost_cents: number }>(
      "SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS count, COALESCE(SUM(CAST(json_extract(pricing_json, '$.charge_cents') AS INTEGER)), 0) AS charge_cents, COALESCE(SUM(CAST(json_extract(pricing_json, '$.cost_cents') AS INTEGER)), 0) AS cost_cents FROM usage_events WHERE occurred_at >= ? GROUP BY day ORDER BY day",
      [fromIso],
    ).map((row) => ({ day: row.day, count: Number(row.count), charge_cents: Number(row.charge_cents), cost_cents: Number(row.cost_cents) }))
    return { byResource, byPrincipal, byDay }
  }

  /**
   * 观测矩阵：窗口内指定前缀资源的 资源×日 使用次数（技能热力图等观测视图数据源）。
   * prefix 由调用方以代码字面量传入（如 'skill:'），不进 LIKE 通配符。
   */
  matrix(fromIso: string, prefix: string): Array<{ resource: string; day: string; count: number }> {
    return this.ctx.txnStore.sql<{ resource: string; day: string; count: number }>(
      "SELECT resource, substr(occurred_at, 1, 10) AS day, COUNT(*) AS count FROM usage_events WHERE occurred_at >= ? AND resource LIKE ? GROUP BY resource, day ORDER BY day",
      [fromIso, `${prefix}%`],
    ).map((row) => ({ resource: row.resource, day: String(row.day), count: Number(row.count) }))
  }

  /**
   * 成本/用量摘要（IAW 交接 4-1：面板侧成本查询的最小接口）。
   * 窗口 [from, to) 内按 org / subject 过滤的聚合：事件数、内部成本（cost_cents 口径，
   * charge_cents 零价快照恒 0）、tokens 三分（input/output/其他）与按资源分项。
   * 权限分层由 HTTP 层负责：usage.read 可查任意主体，panel.read 只读自身组织（scope 收敛在端点做）。
   */
  summary(filter: { from: string; to: string; org?: string; subject?: string }): UsageSummary {
    if (!filter.from || !filter.to) throw new Error('summary 需要 from/to 窗口')
    const conditions = ['e.occurred_at >= ?', 'e.occurred_at < ?']
    const params: Array<string | number> = [filter.from, filter.to]
    if (filter.org) { conditions.push('e.org = ?'); params.push(filter.org) }
    if (filter.subject) { conditions.push('e.subject = ?'); params.push(filter.subject) }
    const where = ` WHERE ${conditions.join(' AND ')}`
    const whereAnd = ` AND ${conditions.join(' AND ')}`
    // QA B-01：关联子查询必须包在聚合函数内——SQLite 对 GROUP BY 查询 SELECT 列表中的
    // 裸关联子查询只对组内某一行求值，tokens 因此只统计到每组任意一条事件（J4 报表小 176 倍）。
    // SUM((SELECT …)) 语义 = 逐行求子查询值再求和，与 json_each JOIN 口径一致且三维自洽。
    const tokensExpr = "COALESCE(SUM((SELECT SUM(CAST(json_extract(m.value, '$.value') AS INTEGER)) FROM json_each(e.meters_json) m WHERE json_extract(m.value, '$.key') LIKE '%tokens%')), 0)"
    const byResource = this.ctx.txnStore.sql<{ resource: string; events: number; tokens: number; cost_cents: number; charge_cents: number }>(
      `SELECT e.resource AS resource, COUNT(*) AS events, ${tokensExpr} AS tokens,` +
      " COALESCE(SUM(CAST(json_extract(e.pricing_json, '$.cost_cents') AS INTEGER)), 0) AS cost_cents," +
      " COALESCE(SUM(CAST(json_extract(e.pricing_json, '$.charge_cents') AS INTEGER)), 0) AS charge_cents" +
      ` FROM usage_events e${where} GROUP BY e.resource ORDER BY cost_cents DESC, events DESC`,
      params,
    ).map((row) => ({ resource: row.resource, events: Number(row.events), tokens: Number(row.tokens), cost_cents: Number(row.cost_cents), charge_cents: Number(row.charge_cents) }))
    const tokenSplit = (key: string): number => Number((this.ctx.txnStore.sql<{ n: number }>(
      "SELECT COALESCE(SUM(CAST(json_extract(m.value, '$.value') AS INTEGER)), 0) AS n FROM usage_events e, json_each(e.meters_json) m" +
      ` WHERE json_extract(m.value, '$.key') = ?${whereAnd}`,
      [key, ...params],
    )[0] ?? { n: 0 }).n)
    return {
      from: filter.from,
      to: filter.to,
      events: byResource.reduce((sum, row) => sum + row.events, 0),
      cost_cents: byResource.reduce((sum, row) => sum + row.cost_cents, 0),
      charge_cents: byResource.reduce((sum, row) => sum + row.charge_cents, 0),
      input_tokens: tokenSplit('input_tokens'),
      output_tokens: tokenSplit('output_tokens'),
      byResource,
    }
  }

  /**
   * 产出反馈聚合（IAW 交接 4-2：Agent 产出采纳率）。
   * 数据源：👍/👎 反馈落账的零价快照 usage 事件（幂等键前缀 feedback:，D2 口径）；
   * score 取幂等键末段（:up/:down），资源/主体取事件字段。adoptionRate = up/(up+down)，无反馈时为 null。
   */
  feedbackStats(filter: { from?: string; to?: string; org?: string } = {}): {
    from?: string; to?: string
    up: number; down: number; total: number; adoptionRate: number | null
    byResource: Array<{ resource: string; up: number; down: number; total: number; adoptionRate: number | null }>
    byDay: Array<{ day: string; up: number; down: number }>
  } {
    const conditions = ["idempotency_key LIKE 'feedback:%'"]
    const params: Array<string | number> = []
    if (filter.from) { conditions.push('occurred_at >= ?'); params.push(filter.from) }
    if (filter.to) { conditions.push('occurred_at < ?'); params.push(filter.to) }
    if (filter.org) { conditions.push('org = ?'); params.push(filter.org) }
    const rows = this.ctx.txnStore.sql<{ resource: string; subject: string; org: string; day: string; idempotency_key: string }>(
      `SELECT resource, subject, org, substr(occurred_at, 1, 10) AS day, idempotency_key FROM usage_events WHERE ${conditions.join(' AND ')}`,
      params,
    ).map((row) => ({ ...row, score: row.idempotency_key.slice(row.idempotency_key.lastIndexOf(':') + 1) }))
    const count = (score: string) => rows.filter((row) => row.score === score).length
    const rate = (up: number, total: number): number | null => (total === 0 ? null : Math.round((up / total) * 1000) / 1000)
    const resources = new Map<string, { up: number; down: number }>()
    const days = new Map<string, { up: number; down: number }>()
    for (const row of rows) {
      const bucket = resources.get(row.resource) ?? { up: 0, down: 0 }
      if (row.score === 'up') bucket.up++
      if (row.score === 'down') bucket.down++
      resources.set(row.resource, bucket)
      const day = days.get(row.day) ?? { up: 0, down: 0 }
      if (row.score === 'up') day.up++
      if (row.score === 'down') day.down++
      days.set(row.day, day)
    }
    const up = count('up')
    const down = count('down')
    return {
      ...(filter.from ? { from: filter.from } : {}),
      ...(filter.to ? { to: filter.to } : {}),
      up,
      down,
      total: rows.length,
      adoptionRate: rate(up, rows.length),
      byResource: [...resources.entries()].map(([resource, bucket]) => ({
        resource, up: bucket.up, down: bucket.down, total: bucket.up + bucket.down, adoptionRate: rate(bucket.up, bucket.up + bucket.down),
      })).sort((a, b) => b.total - a.total),
      byDay: [...days.entries()].map(([day, bucket]) => ({ day, ...bucket })).sort((a, b) => a.day.localeCompare(b.day)),
    }
  }

  /**
   * J4 月度用量报表聚合（M0-3：用量透明计量报表；契约口径见 docs/contract-j4-usage-report.md）。
   * tokens 三维聚合：部门（org 归口字段）/ Agent（subject=agent:*）/ Skill（resource=skill:*），
   * 附模型维度（byModel，additive）与全口径 totals；tokens 取计量键名含 "tokens" 的米值求和
   * （input_tokens/output_tokens/tokens 同口径累加）。nonbillable_events 为零价快照事件数（D2）。
   */
  monthlyReport(month?: string): MonthlyUsageReport {
    const period = month ?? new Date().toISOString().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('报表月份格式应为 YYYY-MM')
    const [from, to] = periodBoundsIso(period)
    // QA B-01：同 summary——子查询必须包进 SUM()，否则 GROUP BY 下每组只统计任意一行
    const tokensExpr = "COALESCE(SUM((SELECT SUM(CAST(json_extract(m.value, '$.value') AS INTEGER)) FROM json_each(e.meters_json) m WHERE json_extract(m.value, '$.key') LIKE '%tokens%')), 0)"
    const select = (dimension: string, extraWhere: string) =>
      this.ctx.txnStore.sql<ReportRow>(
        `SELECT ${dimension} AS dimension, COUNT(*) AS events, ${tokensExpr} AS tokens,` +
        " COALESCE(SUM(CAST(json_extract(e.pricing_json, '$.charge_cents') AS INTEGER)), 0) AS charge_cents," +
        " COALESCE(SUM(CAST(json_extract(e.pricing_json, '$.cost_cents') AS INTEGER)), 0) AS cost_cents," +
        " COALESCE(SUM(CASE WHEN json_extract(e.pricing_json, '$.rate.nonbillable') = 1 THEN 1 ELSE 0 END), 0) AS nonbillable_events" +
        ` FROM usage_events e WHERE e.occurred_at >= ? AND e.occurred_at < ?${extraWhere} GROUP BY ${dimension} ORDER BY tokens DESC, events DESC`,
        [from, to],
      ).map((row) => ({
        dimension: String(row.dimension),
        events: Number(row.events),
        tokens: Number(row.tokens),
        charge_cents: Number(row.charge_cents),
        cost_cents: Number(row.cost_cents),
        nonbillable_events: Number(row.nonbillable_events),
      }))
    const totalsRows = select("'ALL'", '')
    const totals = totalsRows[0] ?? { dimension: 'ALL', events: 0, tokens: 0, charge_cents: 0, cost_cents: 0, nonbillable_events: 0 }
    return {
      month: period,
      from,
      to,
      totals,
      byOrg: select('e.org', ''),
      byAgent: select('e.subject', " AND e.subject LIKE 'agent:%'"),
      bySkill: select('e.resource', " AND e.resource LIKE 'skill:%'"),
      byModel: select('e.resource', " AND e.resource LIKE 'model:%'"),
    }
  }

  // -- FinOps 成本穿透与空转检测（M2） ---------------------------------------

  /**
   * FinOps 成本穿透（CFO 视图 v1）：月度窗口内 org×model 交叉透视 + 上月环比 + Top 消耗主体。
   * 金额口径与 J4 一致：cost_cents 内部采购成本参考（charge_cents 零价快照恒 0，不参与穿透）。
   * matrix 取 Top 8 部门 × Top 8 模型（按成本降序），其余并入「其他」，防小样本淹没主结论。
   */
  costPenetration(month?: string): FinOpsCostPenetration {
    const period = month ?? new Date().toISOString().slice(0, 7)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('报表月份格式应为 YYYY-MM（月份 01-12）')
    const [from, to] = periodBoundsIso(period)
    const [prevFrom, prevTo] = month === undefined ? currentPrevMonthBoundsIso() : prevMonthBoundsIso(period)
    const tokensExpr = "COALESCE(SUM((SELECT SUM(CAST(json_extract(m.value, '$.value') AS INTEGER)) FROM json_each(e.meters_json) m WHERE json_extract(m.value, '$.key') LIKE '%tokens%')), 0)"
    const costExpr = "COALESCE(SUM(CAST(json_extract(e.pricing_json, '$.cost_cents') AS INTEGER)), 0)"

    const windowTotals = (lo: string, hi: string): { events: number; cost_cents: number; tokens: number } => {
      const row = this.ctx.txnStore.sql<{ events: number; cost_cents: number; tokens: number }>(
        `SELECT COUNT(*) AS events, ${costExpr} AS cost_cents, ${tokensExpr} AS tokens FROM usage_events e WHERE e.occurred_at >= ? AND e.occurred_at < ?`,
        [lo, hi],
      )[0] ?? { events: 0, cost_cents: 0, tokens: 0 }
      return { events: Number(row.events), cost_cents: Number(row.cost_cents), tokens: Number(row.tokens) }
    }
    const deltaPct = (cur: number, prev: number): number | null =>
      prev === 0 ? (cur === 0 ? 0 : null) : Math.round(((cur - prev) / prev) * 1000) / 10

    const orgRows = this.ctx.txnStore.sql<{ org: string; events: number; tokens: number; cost_cents: number }>(
      `SELECT e.org AS org, COUNT(*) AS events, ${tokensExpr} AS tokens, ${costExpr} AS cost_cents FROM usage_events e WHERE e.occurred_at >= ? AND e.occurred_at < ? GROUP BY e.org ORDER BY cost_cents DESC, events DESC`,
      [from, to],
    )
    const prevByOrg = new Map(this.ctx.txnStore.sql<{ org: string; cost_cents: number }>(
      `SELECT e.org AS org, ${costExpr} AS cost_cents FROM usage_events e WHERE e.occurred_at >= ? AND e.occurred_at < ? GROUP BY e.org`,
      [prevFrom, prevTo],
    ).map((row) => [row.org, Number(row.cost_cents)]))
    // 每部门的 Top 模型（成本占比）——一次 SQL 按 org×model 聚合后内存取 Top3
    const orgModelRows = this.ctx.txnStore.sql<{ org: string; resource: string; cost_cents: number }>(
      `SELECT e.org AS org, e.resource AS resource, ${costExpr} AS cost_cents FROM usage_events e WHERE e.occurred_at >= ? AND e.occurred_at < ? AND e.resource LIKE 'model:%' GROUP BY e.org, e.resource`,
      [from, to],
    )
    const modelsByOrg = new Map<string, Array<{ model: string; cost_cents: number }>>()
    for (const row of orgModelRows) {
      const list = modelsByOrg.get(row.org) ?? []
      list.push({ model: row.resource.slice('model:'.length), cost_cents: Number(row.cost_cents) })
      modelsByOrg.set(row.org, list)
    }

    const byOrg: FinOpsDimRow[] = orgRows.map((row) => {
      const cost = Number(row.cost_cents)
      const topModels = (modelsByOrg.get(row.org) ?? [])
        .sort((a, b) => b.cost_cents - a.cost_cents).slice(0, 3)
        .map((item) => ({ model: item.model, cost_cents: item.cost_cents, share: cost > 0 ? Math.round((item.cost_cents / cost) * 1000) / 10 : 0 }))
      return {
        dimension: row.org,
        events: Number(row.events),
        tokens: Number(row.tokens),
        cost_cents: cost,
        prev_cost_cents: prevByOrg.get(row.org) ?? 0,
        delta_pct: deltaPct(cost, prevByOrg.get(row.org) ?? 0),
        ...(topModels.length > 0 ? { topModels } : {}),
      }
    })

    const byModel: FinOpsDimRow[] = this.ctx.txnStore.sql<{ resource: string; events: number; tokens: number; cost_cents: number }>(
      `SELECT e.resource AS resource, COUNT(*) AS events, ${tokensExpr} AS tokens, ${costExpr} AS cost_cents FROM usage_events e WHERE e.occurred_at >= ? AND e.occurred_at < ? AND e.resource LIKE 'model:%' GROUP BY e.resource ORDER BY cost_cents DESC, events DESC`,
      [from, to],
    ).map((row) => {
      const cost = Number(row.cost_cents)
      const prev = Number((this.ctx.txnStore.sql<{ cost_cents: number }>(
        `SELECT ${costExpr} AS cost_cents FROM usage_events e WHERE e.occurred_at >= ? AND e.occurred_at < ? AND e.resource = ?`,
        [prevFrom, prevTo, row.resource],
      )[0] ?? { cost_cents: 0 }).cost_cents)
      return {
        dimension: row.resource.slice('model:'.length),
        events: Number(row.events),
        tokens: Number(row.tokens),
        cost_cents: cost,
        prev_cost_cents: prev,
        delta_pct: deltaPct(cost, prev),
      }
    })

    // org×model 交叉矩阵（Top8×Top8，行列各带「其他」兜底项；总计恒 = 全口径成本）
    const topOrgs = byOrg.slice(0, 8).map((row) => row.dimension)
    const topModels = byModel.slice(0, 8).map((row) => row.dimension)
    const orgIndex = new Map(topOrgs.map((org, i) => [org, i]))
    const modelIndex = new Map(topModels.map((model, i) => [model, i]))
    const R = topOrgs.length
    const C = topModels.length
    const byModelKey = new Map(byModel.map((row) => [row.dimension, row]))
    const cells: number[][] = Array.from({ length: R + 1 }, () => Array<number>(C + 1).fill(0))
    for (const row of orgModelRows) {
      const model = row.resource.slice('model:'.length)
      const i = orgIndex.get(row.org) ?? R
      const j = modelIndex.get(model) ?? C
      cells[i]![j]! += Number(row.cost_cents)
    }
    const totals = windowTotals(from, to)
    const prevTotals = windowTotals(prevFrom, prevTo)
    // 「其他」行/列 = 该部门/模型在 model 域的全量 − Top8 直角和（注意行口径必须同为 model 域，
    // 不能用 byOrg 全资源成本，否则矩阵混入非模型成本、总计失守）；角格保持第一步循环的原始累加
    // （org 与 model 双双超出 Top8 的成本天然落在 cells[R][C]），矩阵总计恒等于全口径 model 成本
    const orgModelTotal = new Map<string, number>()
    for (const row of orgModelRows) orgModelTotal.set(row.org, (orgModelTotal.get(row.org) ?? 0) + Number(row.cost_cents))
    for (let i = 0; i < R; i++) {
      cells[i]![C] = (orgModelTotal.get(topOrgs[i]!) ?? 0) - cells[i]!.slice(0, C).reduce((sum, v) => sum + v, 0)
    }
    for (let j = 0; j < C; j++) {
      const modelFull = byModelKey.get(topModels[j]!)?.cost_cents ?? 0
      cells[R]![j] = modelFull - Array.from({ length: R }, (_, i) => cells[i]![j]!).reduce((sum, v) => sum + v, 0)
    }

    const topSubjects = this.ctx.txnStore.sql<{ subject: string; org: string; events: number; cost_cents: number }>(
      `SELECT e.subject AS subject, e.org AS org, COUNT(*) AS events, ${costExpr} AS cost_cents FROM usage_events e WHERE e.occurred_at >= ? AND e.occurred_at < ? GROUP BY e.subject, e.org ORDER BY cost_cents DESC, events DESC LIMIT 10`,
      [from, to],
    ).map((row) => ({ subject: row.subject, org: row.org, events: Number(row.events), cost_cents: Number(row.cost_cents) }))

    return {
      month: period,
      from,
      to,
      prevFrom,
      prevTo,
      totals: { ...totals, prev_cost_cents: prevTotals.cost_cents, delta_pct: deltaPct(totals.cost_cents, prevTotals.cost_cents) },
      byOrg,
      byModel,
      matrix: { orgs: topOrgs, models: topModels, cells },
      topSubjects,
    }
  }

  /**
   * FinOps 空转检测 v1（近似口径）：「窗口内无后续动作调用的模型调用」。
   * 规划口径（M2）：空转 = 无业务结果回传的调用，先以「无后续动作」近似——
   *   模型调用发生后的 idleWindowMinutes 内，同一主体（subject）没有任何非模型资源动作
   *  （skill:/mcp:/nas:/app:/connector:/kb: 等），且其 trace_id 未关联任何动作事件 → 计为疑似空转。
   * 已知误报：纯对话（模型调用后直接答复用户、无工具调用）会计入——页面须标注「近似口径、需人工复核」，
   * 精确口径等 M4 证据引擎的 task_success/task_fail 结果回传（零费率计量键）落地后替换。
   */
  idleAnalysis(filter: { from?: string; to?: string; month?: string; idleWindowMinutes?: number } = {}): FinOpsIdleAnalysis {
    let from = filter.from ?? ''
    let to = filter.to ?? ''
    let month = filter.month
    if (!from || !to) {
      month = month ?? new Date().toISOString().slice(0, 7)
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('报表月份格式应为 YYYY-MM（月份 01-12）')
      ;[from, to] = periodBoundsIso(month)
    }
    const idleWindowMs = Math.min(Math.max(Number(filter.idleWindowMinutes ?? 30), 1), 24 * 60) * 60_000

    interface ModelEventRow { occurred_at: string; subject: string; org: string; resource: string; trace_id: string; meters_json: string; cost_cents: number }
    const costExpr = "COALESCE(CAST(json_extract(e.pricing_json, '$.cost_cents') AS INTEGER), 0)"
    const modelRows = this.ctx.txnStore.sql<ModelEventRow & { cost_cents: number }>(
      `SELECT e.occurred_at, e.subject, e.org, e.resource, e.trace_id, e.meters_json, ${costExpr} AS cost_cents FROM usage_events e WHERE e.occurred_at >= ? AND e.occurred_at < ? AND e.resource LIKE 'model:%' ORDER BY e.subject, e.occurred_at`,
      [from, to],
    ).map((row) => ({ ...row, cost_cents: Number(row.cost_cents) }))
    // 动作时间线（非模型事件）：按主体分组的升序时间戳 + trace 索引（trace 内有动作即视为有业务结果）
    const actionRows = this.ctx.txnStore.sql<{ subject: string; occurred_at: string; trace_id: string }>(
      "SELECT e.subject, e.occurred_at, e.trace_id FROM usage_events e WHERE e.occurred_at >= ? AND e.occurred_at < ? AND e.resource NOT LIKE 'model:%' ORDER BY e.subject, e.occurred_at",
      [from, to],
    )
    const actionsBySubject = new Map<string, number[]>()
    const tracesWithAction = new Set<string>()
    for (const row of actionRows) {
      const list = actionsBySubject.get(row.subject) ?? []
      list.push(new Date(row.occurred_at).getTime())
      actionsBySubject.set(row.subject, list)
      if (row.trace_id) tracesWithAction.add(row.trace_id)
    }
    for (const list of actionsBySubject.values()) list.sort((a, b) => a - b)

    const modelTotals = { events: modelRows.length, cost_cents: 0, tokens: 0 }
    const idle = { events: 0, cost_cents: 0, tokens: 0 }
    const byModel = new Map<string, { model: string; events: number; cost_cents: number; idle_events: number; idle_cost_cents: number }>()
    const byOrg = new Map<string, { org: string; events: number; cost_cents: number; idle_events: number; idle_cost_cents: number }>()
    const samples: FinOpsIdleAnalysis['samples'] = []
    const meterTokens = (metersJson: string): number => {
      try {
        const meters = JSON.parse(metersJson) as Array<{ key: string; value: number }>
        return meters.filter((m) => m.key.includes('tokens')).reduce((sum, m) => sum + (Number(m.value) || 0), 0)
      } catch { return 0 }
    }
    for (const row of modelRows) {
      const tokens = meterTokens(row.meters_json)
      modelTotals.cost_cents += row.cost_cents
      modelTotals.tokens += tokens
      const model = row.resource.slice('model:'.length)
      const modelBucket = byModel.get(model) ?? { model, events: 0, cost_cents: 0, idle_events: 0, idle_cost_cents: 0 }
      modelBucket.events++
      modelBucket.cost_cents += row.cost_cents
      const orgBucket = byOrg.get(row.org) ?? { org: row.org, events: 0, cost_cents: 0, idle_events: 0, idle_cost_cents: 0 }
      orgBucket.events++
      orgBucket.cost_cents += row.cost_cents

      const at = new Date(row.occurred_at).getTime()
      const timeline = actionsBySubject.get(row.subject) ?? []
      // 二分：主体在 [at, at+window] 内是否还有非模型动作（含边界：动作与调用同一时刻也算有后续）
      let followUp = false
      let lo = 0
      let hi = timeline.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (timeline[mid]! < at) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < timeline.length && timeline[i]! <= at + idleWindowMs; i++) { followUp = true; break }
      if (!followUp && row.trace_id && tracesWithAction.has(row.trace_id)) followUp = true
      if (followUp) {
        byModel.set(model, modelBucket)
        byOrg.set(row.org, orgBucket)
        continue
      }
      idle.events++
      idle.cost_cents += row.cost_cents
      idle.tokens += tokens
      modelBucket.idle_events++
      modelBucket.idle_cost_cents += row.cost_cents
      orgBucket.idle_events++
      orgBucket.idle_cost_cents += row.cost_cents
      byModel.set(model, modelBucket)
      byOrg.set(row.org, orgBucket)
      if (samples.length < 20) {
        samples.push({ occurred_at: row.occurred_at, subject: row.subject, org: row.org, resource: row.resource, cost_cents: row.cost_cents, tokens })
      }
    }
    const share = modelTotals.cost_cents > 0 ? Math.round((idle.cost_cents / modelTotals.cost_cents) * 1000) / 10 : 0
    const pick = <T extends { events: number }>(map: Map<string, T>): T[] => [...map.values()].sort((a, b) => b.idle_cost_cents - a.idle_cost_cents || b.events - a.events)
    return {
      ...(month !== undefined ? { month } : {}),
      from,
      to,
      idleWindowMinutes: Math.round(idleWindowMs / 60_000),
      totals: modelTotals,
      idle: { ...idle, share_pct: share },
      byModel: pick(byModel),
      byOrg: pick(byOrg),
      samples,
    }
  }

  // -- 价格簿 ---------------------------------------------------------------
  priceBook(): Collection<PriceBookEntry> {
    return this.ctx.opsStorage.collection<PriceBookEntry>('usage:priceBook')
  }

  upsertPrice(entry: Omit<PriceBookEntry, 'id' | 'createdAt' | 'updatedAt'>): PriceBookEntry {
    // REL-11：写入口数值校验——此前 {"list_cents_per_unit":"abc"} 也能 200 入簿，计价产出 NaN 快照、
    // 对账恒 mismatch 且每次发 critical 告警（存量脏数据永久投毒）。非法即抛错（guarded 统一映射 400）
    for (const [field, value, min] of [
      ['list_cents_per_unit', entry.list_cents_per_unit, 0],
      ['cost_cents_per_unit', entry.cost_cents_per_unit, 0],
      ['tax_rate', entry.tax_rate, 0],
      ['units_per_step', entry.units_per_step, 1], // 计价除数：0 会产出 Infinity，负数会产出负金额
    ] as Array<[string, number, number]>) {
      if (!Number.isFinite(value) || value < min) {
        throw new Error(`价格簿字段 ${field} 必须为有限数值且 ≥${min}，收到：${String(value)}`)
      }
    }
    const existing = this.priceBook().findOne((item) => item.pattern === entry.pattern)
    if (existing) return this.priceBook().update(existing.id, { ...entry })
    return this.priceBook().insert({ id: newId('rate'), ...entry })
  }

  private priceOf(resource: string): PriceBookEntry {
    const book = this.priceBook().all()
    const exact = book.find((item) => item.pattern === resource)
    if (exact) return exact
    const prefix = book.filter((item) => item.pattern.endsWith(':*')).sort((a, b) => b.pattern.length - a.pattern.length)
      .find((item) => resource.startsWith(item.pattern.slice(0, -1)))
    if (prefix) return prefix
    throw new Error(`资源 ${resource} 无计价规则：请先在价格簿登记（usage 价格簿）`)
  }

  private ensureDefaultPriceBook(): void {
    // 逐条幂等播种：存量部署升级时只补缺失的默认规则，不覆盖运营已改过的费率
    const defaults: Array<Omit<PriceBookEntry, 'id' | 'createdAt' | 'updatedAt'>> = [
      // M0-3（2026-09-09）：mcp:* 转为「零价快照 + 内部成本参考」——charge 恒 0（不对外结算），cost 保留采购成本口径
      { pattern: 'mcp:*', meter_key: 'tokens', list_cents_per_unit: 0, cost_cents_per_unit: 15, units_per_step: 1000, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.09-cost' },
      { pattern: 'platform:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08' },
      // 观测补齐：skill/nas 先零费率采集（价格簿有规则即可入管道），是否计费由运营调价决定
      { pattern: 'skill:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08' },
      { pattern: 'nas:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08' },
      // 连接器纳管（open-connector 融合）：同上零费率起步；record() 硬校验要求有规则方可入管道，
      // 运营按需把特定 connector:<provider> 调整为非零费率（dev-plan-connector §2.6）
      { pattern: 'connector:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08' },
      // D1（WP-03）：应用与知识包观测入管道——零费率起步，事件自动按非计费零价快照入账（D2）
      { pattern: 'app:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.09' },
      { pattern: 'kb:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.09' },
      // WP-07（feedback 回传）：宿主数字员工作为可观测资源——零费率起步，运营可调价
      { pattern: 'agent:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.09' },
      // 部门面板（review-dsh-agent-panel-v2 D1 裁决）：计量键格式 panel:<dept>.<行业code>（如 panel:mfg.qb01），
      // 双冒号/@ 形态过不了 record() 的 resource 硬校验；零费率起步，运营按行业包调价
      { pattern: 'panel:*', meter_key: 'calls', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1, tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.09' },
    ]
    for (const entry of defaults) {
      if (!this.priceBook().findOne((item) => item.pattern === entry.pattern)) this.upsertPrice(entry)
    }
    // 存量迁移（M0-3）：mcp:* 若仍是旧的转售默认价（list 30 分/千 tokens，未被运营改过），
    // 归零为「零价快照 + 成本参考」口径；运营已主动调价的条目不动。
    const legacyMcp = this.priceBook().findOne((item) => item.pattern === 'mcp:*')
    if (legacyMcp && legacyMcp.list_cents_per_unit === 30 && legacyMcp.cost_cents_per_unit === 15 && legacyMcp.rate_version === 'v2026.08') {
      this.priceBook().update(legacyMcp.id, { list_cents_per_unit: 0, rate_version: 'v2026.09-cost' })
    }
  }

  // -- 对账（三方口径比对） -----------------------------------------------

  /**
   * 对账：usage 口径（事件流水）vs 已登记消费方投影口径，全量比对。
   * 消费方通过 consume() 挂载时同步登记投影集合 usage:projection:<consumerId>。
   */
  reconcile(windowFromIso?: string): {
    usage: { count: number; charge_cents: number }
    projections: Array<{ consumer: string; count: number; charge_cents: number; mismatch: boolean }>
    mismatch: boolean
  } {
    const usageTotals = this.totals(windowFromIso ? { from: windowFromIso } : {})
    const projections: Array<{ consumer: string; count: number; charge_cents: number; mismatch: boolean }> = []
    for (const consumerId of this.consumers.keys()) {
      const rows = this.ctx.opsStorage.collection<ProjectionRow>(`usage:projection:${consumerId}`).all()
        .filter((row) => (windowFromIso ? row.window >= windowFromIso.slice(0, 10) : true))
      const count = rows.reduce((sum, row) => sum + row.count, 0)
      // REL-11 读侧加固：投影集合中的存量脏行（非有限 charge_cents）按 0 计入对账，不再恒 mismatch 反复告警
      const charge = rows.reduce((sum, row) => sum + (Number.isFinite(row.charge_cents) ? row.charge_cents
        : this.warnDirtyData(`projection-row:${consumerId}:${row.id}`, `usage 投影 ${consumerId} 窗口 ${row.window} 的 charge_cents 非有限（存量脏数据），对账按 0 计入（REL-11）`)), 0)
      projections.push({
        consumer: consumerId,
        count,
        charge_cents: charge,
        mismatch: count !== usageTotals.count || charge !== usageTotals.charge_cents,
      })
    }
    const mismatch = projections.some((item) => item.mismatch)
    if (mismatch) {
      this.ctx.platformBus.emit('audit.alert.fired', {
        id: newId('alt'), severity: 'critical', title: 'usage 对账不平',
        message: `usage 口径 count=${usageTotals.count} charge=${usageTotals.charge_cents} 分；消费方投影存在偏差：${JSON.stringify(projections)}`,
      })
    }
    return { usage: { count: usageTotals.count, charge_cents: usageTotals.charge_cents }, projections, mismatch }
  }

  /** 消费方投影累加（供 consume() 回调内部调用）。 */
  project(consumerId: string, event: UsageEvent): void {
    const collection = this.ctx.opsStorage.collection<ProjectionRow>(`usage:projection:${consumerId}`)
    const day = event.occurred_at.slice(0, 10)
    // REL-11 读侧加固：存量脏事件的 charge_cents 非有限时按 0 投影（防对账口径持续失真），按事件去重告警
    const rawCharge = event.pricing.charge_cents
    const charge = Number.isFinite(rawCharge) ? rawCharge
      : this.warnDirtyData(`projection:${event.event_id}`, `usage 事件 ${event.event_id} 的 pricing.charge_cents=${String(rawCharge)} 非有限（存量脏数据），本次投影按 0 计入（REL-11）`)
    const existing = collection.findOne((row) => row.window === day)
    if (existing) {
      collection.update(existing.id, { count: existing.count + 1, charge_cents: existing.charge_cents + charge })
    } else {
      collection.insert({ id: newId('prj'), window: day, count: 1, charge_cents: charge })
    }
  }

  // -- 运行时对账（M5：声明 vs 行为） --------------------------------------

  capabilityGrants(): Collection<CapabilityGrantRecord> {
    return this.ctx.opsStorage.collection<CapabilityGrantRecord>('usage:capabilityGrants')
  }

  grantCapabilities(principal: string, capabilities: string[], source: string): CapabilityGrantRecord {
    const existing = this.capabilityGrants().findOne((item) => item.principal === principal)
    if (existing) return this.capabilityGrants().update(existing.id, { capabilities, source })
    return this.capabilityGrants().insert({ id: newId('cap'), principal, capabilities, source })
  }

  /** 能力漂移检测：窗口内实际消耗的资源 vs 声明授权；未声明的实际消耗即告警。 */
  capabilityDrift(sinceIso?: string): { drift: Array<{ principal: string; consumed: string[]; granted: string[]; ungranted: string[] }> } {
    const { items } = this.query({ from: sinceIso, limit: 1000 })
    const consumedByPrincipal = new Map<string, Set<string>>()
    for (const event of items) {
      const set = consumedByPrincipal.get(event.principal) ?? new Set<string>()
      set.add(event.resource)
      consumedByPrincipal.set(event.principal, set)
    }
    const drift: Array<{ principal: string; consumed: string[]; granted: string[]; ungranted: string[] }> = []
    for (const [principal, consumedSet] of consumedByPrincipal) {
      const grant = this.capabilityGrants().findOne((item) => item.principal === principal)
      const granted = grant?.capabilities ?? []
      const ungranted = [...consumedSet].filter((resource) => !granted.some((cap) =>
        cap === '*' || cap === resource || (cap.endsWith(':*') && resource.startsWith(cap.slice(0, -1))),
      ))
      if (ungranted.length > 0) {
        drift.push({ principal, consumed: [...consumedSet], granted, ungranted })
        this.ctx.platformBus.emit('audit.alert.fired', {
          id: newId('alt'), severity: 'critical', title: 'usage 能力漂移',
          message: `主体 ${principal} 实际消耗了未声明授权的资源：${ungranted.join(', ')}（运行时对账 M5）`,
          resourceType: 'usage_capability', resourceId: principal,
        })
      }
    }
    return { drift }
  }

  deadLetters(): Collection<DeadLetterRecord> {
    return this.ctx.opsStorage.collection<DeadLetterRecord>('usage:deadLetters')
  }

  // -- 内部 -----------------------------------------------------------------

  /**
   * REL-11 读侧加固：脏数据（存量非有限费率/金额）warning 告警，恒返回 0 供计价/投影回落。
   * 同一 key（进程生命周期内）只告一次，防止每个事件重复触发告警风暴。
   */
  private warnDirtyData(key: string, message: string): 0 {
    if (!this.warnedDirtyKeys.has(key)) {
      this.warnedDirtyKeys.add(key)
      this.ctx.platformBus.emit('audit.alert.fired', {
        id: newId('alt'), severity: 'warning', title: 'usage 脏数据按 0 兜底（REL-11）',
        message,
      })
    }
    return 0
  }

  private validate(input: UsageRecordInput): void {
    if (!input.org?.trim()) throw new Error('usage 事件 org 必填')
    if (!input.subject?.trim()) throw new Error('usage 事件 subject 必填（user:<id> / agent:<id>）')
    if (!input.principal?.trim()) throw new Error('usage 事件 principal 必填（org:<id> / plugin:<id> / platform）')
    if (!input.resource?.trim() || !/^[a-z]+:[A-Za-z0-9._-]+$/.test(input.resource)) {
      throw new Error(`usage 事件 resource 格式非法：${input.resource}（应为 model:<slug> / mcp:<slug> / plugin:<id> / skill:<id> / nas:<id> / app:<id> / kb:<orgId>）`)
    }
    if (!Array.isArray(input.meters) || input.meters.length === 0) throw new Error('usage 事件 meters 至少一项')
    for (const meter of input.meters) {
      if (!meter.key || !/^[a-z][a-z0-9_.]*$/.test(meter.key)) throw new Error(`计量键非法：${meter.key}（^[a-z][a-z0-9_.]*$）`)
      if (!Number.isFinite(meter.value) || meter.value < 0) throw new Error(`计量值非法：${meter.key}=${meter.value}`)
    }
  }

  /** 租户解析：org → tenant（多租户最小集，v1.2 第 2 步）。 */
  private resolveTenant(orgId: string): string {
    if (!orgId || orgId === '') return DEFAULT_TENANT
    return this.ctx.iam.orgs().get(orgId)?.tenantId ?? DEFAULT_TENANT
  }

  private autoIdempotencyKey(input: UsageRecordInput): string {
    const window = new Date().toISOString().slice(0, 16)
    return `usage:${input.principal}:${input.resource}:${window}:${++this.seq}`
  }
}

interface ProjectionRow extends RecordBase {
  window: string
  count: number
  charge_cents: number
}

/** J4 月度报表行（维度值 + 事件数 + tokens 聚合 + 金额口径 + 零价快照事件数）。 */
export interface MonthlyUsageReportRow {
  dimension: string
  events: number
  tokens: number
  charge_cents: number
  cost_cents: number
  nonbillable_events: number
}

export interface MonthlyUsageReport {
  month: string
  from: string
  to: string
  totals: MonthlyUsageReportRow
  /** 部门维度（org 归口字段）。 */
  byOrg: MonthlyUsageReportRow[]
  /** Agent 维度（subject=agent:*）。 */
  byAgent: MonthlyUsageReportRow[]
  /** Skill 维度（resource=skill:*）。 */
  bySkill: MonthlyUsageReportRow[]
  /** 模型维度（resource=model:*，additive 便于成本穿透）。 */
  byModel: MonthlyUsageReportRow[]
}

/** 成本/用量摘要（IAW 交接 4-1）：窗口聚合 + tokens 三分 + 按资源分项。 */
export interface UsageSummary {
  from: string
  to: string
  events: number
  /** 内部成本参考（分）；charge_cents 为零价快照兼容字段（恒 0）。 */
  cost_cents: number
  charge_cents: number
  input_tokens: number
  output_tokens: number
  byResource: Array<{ resource: string; events: number; tokens: number; cost_cents: number; charge_cents: number }>
}

interface ReportRow {
  dimension: string
  events: number
  tokens: number
  charge_cents: number
  cost_cents: number
  nonbillable_events: number
}

/** FinOps 成本穿透行（部门/模型维度 + 上月环比 + 部门行的 Top 模型拆分）。 */
export interface FinOpsDimRow {
  dimension: string
  events: number
  tokens: number
  cost_cents: number
  prev_cost_cents: number
  /** 环比百分比：(本期−上期)/上期×100，保留 1 位小数；上期为 0 且本期非 0 时为 null（无可比基数）。 */
  delta_pct: number | null
  /** 部门行的 Top3 模型拆分（模型行无此字段）。 */
  topModels?: Array<{ model: string; cost_cents: number; share: number }>
}

/** FinOps 成本穿透（CFO 视图 v1）聚合结果。 */
export interface FinOpsCostPenetration {
  month: string
  from: string
  to: string
  prevFrom: string
  prevTo: string
  totals: { events: number; cost_cents: number; tokens: number; prev_cost_cents: number; delta_pct: number | null }
  byOrg: FinOpsDimRow[]
  byModel: FinOpsDimRow[]
  /** org×model 成本交叉矩阵（Top8×Top8 + 「其他」行列；cells[org][model]，单位分）。 */
  matrix: { orgs: string[]; models: string[]; cells: number[][] }
  topSubjects: Array<{ subject: string; org: string; events: number; cost_cents: number }>
}

/** FinOps 空转检测 v1（近似口径：「无后续动作的模型调用」）聚合结果。 */
export interface FinOpsIdleAnalysis {
  month?: string
  from: string
  to: string
  idleWindowMinutes: number
  /** 窗口内模型调用全口径（分母）。 */
  totals: { events: number; cost_cents: number; tokens: number }
  /** 疑似空转汇总（share_pct = 空转成本占模型调用总成本比例）。 */
  idle: { events: number; cost_cents: number; tokens: number; share_pct: number }
  byModel: Array<{ model: string; events: number; cost_cents: number; idle_events: number; idle_cost_cents: number }>
  byOrg: Array<{ org: string; events: number; cost_cents: number; idle_events: number; idle_cost_cents: number }>
  /** 最近空转样本（≤20 条，供人工复核近似口径误报）。 */
  samples: Array<{ occurred_at: string; subject: string; org: string; resource: string; cost_cents: number; tokens: number }>
}

/** 月度报表期间边界：[当月 1 日 00:00, 次月 1 日 00:00)。 */
function periodBoundsIso(period: string): [string, string] {
  const [year, month] = period.split('-').map(Number)
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`
  return [`${period}-01T00:00:00`, `${next}-01T00:00:00`]
}

/** 上一月期间边界（FinOps 环比分母窗口）。 */
function prevMonthBoundsIso(period: string): [string, string] {
  const [year, month] = period.split('-').map(Number)
  const prev = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
  return periodBoundsIso(prev)
}

/** 当前月与上一月的边界（month 未显式指定时的环比口径）。 */
function currentPrevMonthBoundsIso(): [string, string] {
  return prevMonthBoundsIso(new Date().toISOString().slice(0, 7))
}

interface UsageRow {
  id: string
  idempotency_key: string
  schema_version: number
  occurred_at: string
  tenant_id: string
  org: string
  subject: string
  principal: string
  resource: string
  meters_json: string
  pricing_json: string
  trace_id: string
}

function usageRow(event: UsageEvent): Record<string, string | number> {
  return {
    id: event.event_id,
    idempotency_key: event.idempotency_key,
    schema_version: event.schema_version,
    occurred_at: event.occurred_at,
    tenant_id: event.tenant_id,
    org: event.org,
    subject: event.subject,
    principal: event.principal,
    resource: event.resource,
    meters_json: JSON.stringify(event.meters),
    pricing_json: JSON.stringify(event.pricing),
    trace_id: event.trace_id ?? '',
  }
}

function rowToEvent(row: UsageRow): UsageEvent {
  return {
    schema: USAGE_SCHEMA,
    schema_version: row.schema_version,
    event_id: row.id,
    idempotency_key: row.idempotency_key,
    ...(row.trace_id !== '' ? { trace_id: row.trace_id } : {}),
    occurred_at: row.occurred_at,
    tenant_id: row.tenant_id,
    org: row.org,
    subject: row.subject,
    principal: row.principal,
    resource: row.resource,
    meters: JSON.parse(row.meters_json) as UsageMeter[],
    pricing: JSON.parse(row.pricing_json) as UsagePricingSnapshot,
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    usage: UsageService
  }
}

export const name = 'usage'
export const inject = ['opsStorage', 'platformBus', 'txnStore', 'iam']

export function apply(ctx: Context) {
  ctx.plugin(UsageService)
  ctx.plugin(usageTools)
}
