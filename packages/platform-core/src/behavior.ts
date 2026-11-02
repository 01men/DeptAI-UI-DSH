/**
 * @dsh-ops/platform-core —— behavior 行为事件管道（action-plan-dsh-frontend WP-03 / 决议 D3、D6）。
 *
 * 前端行为埋点（卡片曝光/点击/推荐位/登记漏斗）与调用计量（usage）分流：
 *   - D3：行为事件独立 `behavior.recorded`，不混入 usage 计量管道（避免污染计费口径）；
 *   - D6：端点归属 platform-core（本文件），与 usage 同款「先写后发 + 幂等 + 死信 + 重放」语义；
 *   - write-only 采集端点 POST /api/behavior/events（iam 鉴权：未认证一律 401，
 *     认证主体即事件主体，杜绝伪造他人行为流）；只读查询 GET /api/behavior/events（audit.read，
 *     审计/看板订阅面）。audit 与后续看板经 ctx.behavior.consume() 或 platformBus 订阅。
 *
 * schema v1（additive-only，同 usage 纪律）：字段只增不改不删，消费端容忍未知新字段。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId } from './ids.ts'
import { t } from '../../platform-i18n/src/index.ts'
import type { Collection, RecordBase } from './storage.ts'

export const BEHAVIOR_SCHEMA = 'behavior.recorded'
export const BEHAVIOR_SCHEMA_VERSION = 1

/** behavior.recorded v1 事件（只追加，禁改版；扩展仅允许新增可选字段）。 */
export interface BehaviorEvent {
  schema: typeof BEHAVIOR_SCHEMA
  schema_version: number
  event_id: string
  idempotency_key: string
  occurred_at: string
  tenant_id: string
  /** 事件归属组织（可空：机器主体可能无组织上下文）。 */
  org?: string
  /** 事件主体：user:<id> | agent:<id> | app:<id> | machine:<principalId>。 */
  subject: string
  /** 事件类型（点分小写键）：card.exposed / card.clicked / funnel.step / recommend.impression … */
  type: string
  /** 来源平台/端（五平台差异化 + 三入口）：strategy | marketing | manufacturing | rd | quality | console | portal | dingtalk | dsh */
  platform?: string
  /** 业务上下文（自由对象，≤4KB）：卡片 ref、漏斗步骤、跳转目标等。 */
  payload?: Record<string, unknown>
  trace_id?: string
}

/** 行为事件登记入参（HTTP 采集面 subject 由认证主体强制派生，入参不含 subject）。 */
export interface BehaviorRecordInput {
  org?: string
  subject?: string
  type: string
  platform?: string
  payload?: Record<string, unknown>
  idempotency_key?: string
  occurred_at?: string
  trace_id?: string
}

/** 死信（消费 3 次失败的事件）。 */
export interface BehaviorDeadLetter extends RecordBase {
  event_id: string
  consumer: string
  error: string
  attempts: number
}

export type BehaviorConsumer = (event: BehaviorEvent) => void

const PAYLOAD_MAX_BYTES = 4096

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

const DEFAULT_TENANT = 't_default'

interface BehaviorRow {
  id: string
  idempotency_key: string
  schema_version: number
  occurred_at: string
  tenant_id: string
  org: string
  subject: string
  type: string
  platform: string
  payload_json: string
  trace_id: string
}

function behaviorRow(event: BehaviorEvent): Record<string, string | number> {
  return {
    id: event.event_id,
    idempotency_key: event.idempotency_key,
    schema_version: event.schema_version,
    occurred_at: event.occurred_at,
    tenant_id: event.tenant_id,
    org: event.org ?? '',
    subject: event.subject,
    type: event.type,
    platform: event.platform ?? '',
    payload_json: JSON.stringify(event.payload ?? {}),
    trace_id: event.trace_id ?? '',
  }
}

function rowToEvent(row: BehaviorRow): BehaviorEvent {
  return {
    schema: BEHAVIOR_SCHEMA,
    schema_version: row.schema_version,
    event_id: row.id,
    idempotency_key: row.idempotency_key,
    occurred_at: row.occurred_at,
    tenant_id: row.tenant_id,
    ...(row.org !== '' ? { org: row.org } : {}),
    subject: row.subject,
    type: row.type,
    ...(row.platform !== '' ? { platform: row.platform } : {}),
    ...(row.payload_json !== '{}' ? { payload: JSON.parse(row.payload_json) as Record<string, unknown> } : {}),
    ...(row.trace_id !== '' ? { trace_id: row.trace_id } : {}),
  }
}

export class BehaviorService extends Service {
  static readonly provide = 'behavior'
  static readonly inject = ['txnStore', 'platformBus', 'httpServer']

  private consumers = new Map<string, { handler: BehaviorConsumer; attempts: Map<string, number> }>()
  private seq = 0

  constructor(ctx: Context) {
    super(ctx, 'behavior')
    ctx.txnStore.ensureTable('behavior_events', {
      id: 'TEXT',
      idempotency_key: 'TEXT NOT NULL',
      schema_version: 'INTEGER NOT NULL',
      occurred_at: 'TEXT NOT NULL',
      tenant_id: 'TEXT NOT NULL',
      org: "TEXT NOT NULL DEFAULT ''",
      subject: 'TEXT NOT NULL',
      type: 'TEXT NOT NULL',
      platform: "TEXT NOT NULL DEFAULT ''",
      payload_json: 'TEXT NOT NULL',
      trace_id: "TEXT NOT NULL DEFAULT ''",
    }, { uniques: [['idempotency_key']], indexes: [['occurred_at'], ['type'], ['subject']] })
    // 消费水位（引擎级幂等）：同 usage 纪律——replay/重投不产生重复副作用
    ctx.txnStore.ensureTable('behavior_consumptions', {
      consumer: 'TEXT NOT NULL',
      event_id: 'TEXT NOT NULL',
      at: 'TEXT NOT NULL',
    }, { primaryKey: ['consumer', 'event_id'] })
    this.registerHttpEndpoints(ctx)
    ctx.effect(() => () => {
      this.consumers.clear()
    })
  }

  /** write-only 采集（公开路由挂 console 鉴权中间件之后；此处再校验主体，双层 fail-closed）。 */
  private registerHttpEndpoints(ctx: Context): void {
    const http = ctx.httpServer
    http.register('POST', '/api/behavior/events', (exchange) => {
      // console 鉴权中间件未挂载（异常装配）时 principal 恒空：拒绝服务而非放行
      const principal = exchange.principal as { permissions?: string[]; userId?: string; kind?: string; principalId?: string } | undefined
      if (!principal || !Array.isArray(principal.permissions)) {
        exchange.fail(401, 'UNAUTHORIZED', t('缺少 Bearer 令牌，请先登录'))
        return
      }
      const input = (exchange.body ?? {}) as BehaviorRecordInput
      // 事件主体强制取认证主体：埋点只描述「谁做了什么」，不接受请求体指认他人
      const subject = principal.userId ? `user:${principal.userId}` : `${principal.kind ?? 'machine'}:${principal.principalId ?? 'unknown'}`
      try {
        const result = this.record({ ...input, subject })
        exchange.ok({ event: result.event, duplicated: result.duplicated })
      } catch (error) {
        exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
      }
    }, { access: 'authenticated' })
    http.register('GET', '/api/behavior/events', (exchange) => {
      const principal = exchange.principal as { permissions?: string[] } | undefined
      if (!principal || !Array.isArray(principal.permissions)) {
        exchange.fail(401, 'UNAUTHORIZED', t('缺少 Bearer 令牌，请先登录'))
        return
      }
      if (!principal.permissions.includes('*') && !principal.permissions.includes('audit.read')) {
        ctx.platformBus.emit('audit.authz.denied', {
          actorId: (exchange.principal as { userId?: string }).userId,
          point: 'audit.read',
          path: exchange.path,
        })
        exchange.fail(403, 'FORBIDDEN', t('缺少权限点 {point}，请联系管理员调整角色', { point: 'audit.read' }), { permission: 'audit.read' })
        return
      }
      const query = exchange.query
      exchange.ok(this.query({
        ...(query.get('type') ? { type: query.get('type')! } : {}),
        ...(query.get('subject') ? { subject: query.get('subject')! } : {}),
        ...(query.get('from') ? { from: query.get('from')! } : {}),
        ...(query.get('to') ? { to: query.get('to')! } : {}),
        ...(query.get('limit') ? { limit: Number(query.get('limit')) } : {}),
      }))
    }, { access: 'guarded', permission: 'audit.read' })
  }

  /** 全平台唯一行为事件入口：校验 → 落库（幂等）→ 总线分发。返回 duplicated 标识幂等重放。 */
  record(input: BehaviorRecordInput): { event: BehaviorEvent; duplicated: boolean } {
    this.validate(input)
    const event: BehaviorEvent = {
      schema: BEHAVIOR_SCHEMA,
      schema_version: BEHAVIOR_SCHEMA_VERSION,
      event_id: newId('bevt'),
      idempotency_key: input.idempotency_key ?? `behavior:${input.subject}:${input.type}:${new Date().toISOString().slice(0, 16)}:${++this.seq}`,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      tenant_id: DEFAULT_TENANT,
      ...(input.org ? { org: input.org } : {}),
      subject: input.subject!,
      type: input.type,
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.trace_id !== undefined ? { trace_id: input.trace_id } : {}),
    }
    const inserted = this.ctx.txnStore.insertOrIgnore('behavior_events', behaviorRow(event))
    if (!inserted) {
      const existing = this.ctx.txnStore.one<BehaviorRow>('behavior_events', { idempotency_key: event.idempotency_key })
      if (!existing) throw new Error(t('幂等键异常：{key} 已占用但记录缺失', { key: event.idempotency_key }))
      const sameContent = existing.subject === event.subject && existing.type === event.type
        && existing.payload_json === JSON.stringify(event.payload ?? {})
      if (!sameContent) {
        throw new Error(t('幂等键冲突：{key} 已绑定事件 {id}，同键不同内容被拒绝', { key: event.idempotency_key, id: existing.id }))
      }
      return { event: rowToEvent(existing), duplicated: true }
    }
    this.dispatch(event)
    return { event, duplicated: false }
  }

  /** 注册消费方（at-least-once；3 次失败入死信）。 */
  consume(consumerId: string, handler: BehaviorConsumer): () => void {
    this.consumers.set(consumerId, { handler, attempts: new Map() })
    return () => this.consumers.delete(consumerId)
  }

  /**
   * 分发：先总线广播，再逐消费方按水位投递（insertOrIgnore 占位 → 3 次失败入死信并告警）。
   * 与 usage 同款「效果恰好一次」：重放/重投经水位幂等跳过。
   */
  private dispatch(event: BehaviorEvent): void {
    this.ctx.platformBus.emit(BEHAVIOR_SCHEMA, event)
    for (const [consumerId, entry] of this.consumers) {
      const claimed = this.ctx.txnStore.insertOrIgnore('behavior_consumptions', {
        consumer: consumerId, event_id: event.event_id, at: new Date().toISOString(),
      })
      if (!claimed) continue
      let delivered = false
      for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
        try {
          entry.handler(event)
          entry.attempts.delete(`${consumerId}:${event.event_id}`)
          delivered = true
        } catch (error) {
          if (attempt < 3) continue
          this.ctx.txnStore.run('DELETE FROM behavior_consumptions WHERE consumer = ? AND event_id = ?', [consumerId, event.event_id])
          this.deadLetters().insert({
            id: newId('bdl'), event_id: event.event_id, consumer: consumerId,
            error: error instanceof Error ? error.message : String(error), attempts: attempt,
          })
          this.ctx.platformBus.emit('audit.alert.fired', {
            id: newId('alt'), severity: 'critical', title: t('behavior 消费死信'),
            message: t('消费方 {consumer} 处理行为事件 {id} 连续失败 {attempts} 次，已入死信，可经 behavior 重投恢复', { consumer: consumerId, id: event.event_id, attempts: attempt }),
          })
        }
      }
    }
  }

  /** 重放窗口内事件（消费水位保证幂等）。 */
  replay(sinceIso: string): { replayed: number } {
    const rows = this.ctx.txnStore.sql<BehaviorRow>(
      'SELECT * FROM behavior_events WHERE occurred_at >= ? ORDER BY occurred_at',
      [sinceIso],
    )
    for (const row of rows) this.dispatch(rowToEvent(row))
    return { replayed: rows.length }
  }

  /** 死信重投：成功即移出死信队列。返回 {retried, remaining}。 */
  retryDeadLetters(): { retried: number; remaining: number } {
    const letters = this.deadLetters().all()
    let retried = 0
    for (const letter of letters) {
      const row = this.ctx.txnStore.one<BehaviorRow>('behavior_events', { id: letter.event_id })
      if (!row) {
        this.deadLetters().remove(letter.id)
        continue
      }
      const consumer = this.consumers.get(letter.consumer)
      if (!consumer) continue
      this.deadLetters().remove(letter.id)
      try {
        const claimed = this.ctx.txnStore.insertOrIgnore('behavior_consumptions', {
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
          id: newId('bdl'), event_id: letter.event_id, consumer: letter.consumer,
          error: t('重投仍失败：{message}', { message: error instanceof Error ? error.message : String(error) }), attempts: letter.attempts + 1,
        })
      }
    }
    return { retried, remaining: this.deadLetters().count() }
  }

  /** 只读查询（审计/看板订阅面，GET 端点 audit.read 门禁）。 */
  query(filter: { type?: string; subject?: string; from?: string; to?: string; limit?: number } = {}): { total: number; items: BehaviorEvent[] } {
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (filter.type) { conditions.push('type = ?'); params.push(filter.type) }
    if (filter.subject) { conditions.push('subject = ?'); params.push(filter.subject) }
    if (filter.from) { conditions.push('occurred_at >= ?'); params.push(filter.from) }
    if (filter.to) { conditions.push('occurred_at <= ?'); params.push(filter.to) }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.ctx.txnStore.sql<BehaviorRow>(`SELECT * FROM behavior_events${where} ORDER BY occurred_at DESC LIMIT ?`, [...params, Math.min(filter.limit ?? 100, 1000)])
    const total = Number((this.ctx.txnStore.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM behavior_events${where}`, params)[0] ?? { n: 0 }).n)
    return { total, items: rows.map(rowToEvent) }
  }

  deadLetters(): Collection<BehaviorDeadLetter> {
    return this.ctx.opsStorage.collection<BehaviorDeadLetter>('behavior:deadLetters')
  }

  // -- 内部 -----------------------------------------------------------------

  private validate(input: BehaviorRecordInput): void {
    if (!input.type?.trim() || !/^[a-z][a-z0-9_.]*$/.test(input.type)) {
      throw new Error(t('behavior 事件 type 非法：{value}（应为点分小写键，如 card.exposed / funnel.step）', { value: String(input.type) }))
    }
    if (!input.subject?.trim() || !/^[a-z][a-z0-9]*:[A-Za-z0-9._-]+$/.test(input.subject)) {
      throw new Error(t('behavior 事件 subject 非法：{value}（应为 user:<id> / agent:<id> / machine:<principalId>）', { value: String(input.subject) }))
    }
    if (input.platform !== undefined && !/^[a-z][a-z0-9_-]*$/.test(input.platform)) {
      throw new Error(t('behavior 事件 platform 非法：{value}（小写标识，如 rd / quality / console / dingtalk）', { value: input.platform }))
    }
    if (input.payload !== undefined) {
      if (typeof input.payload !== 'object' || Array.isArray(input.payload) || input.payload === null) {
        throw new Error(t('behavior 事件 payload 必须是对象'))
      }
      if (Buffer.byteLength(JSON.stringify(input.payload), 'utf8') > PAYLOAD_MAX_BYTES) {
        throw new Error(t('behavior 事件 payload 超限（>{max} 字节），请精简上下文', { max: PAYLOAD_MAX_BYTES }))
      }
    }
    if (input.occurred_at !== undefined && Number.isNaN(new Date(input.occurred_at).getTime())) {
      throw new Error(t('behavior 事件 occurred_at 非法：{value}', { value: input.occurred_at }))
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    behavior: BehaviorService
  }
}
