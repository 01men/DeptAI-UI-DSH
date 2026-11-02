/**
 * 数字员工域权威存储（repositories）—— workforce_* 表全部落 SQLite txnStore（附录 A 决策 7）。
 *
 * 职责边界（§11.6）：
 *   - 本服务只做「表结构迁移 + 行级 CRUD + 事务委托」，不含任何业务策略（策略在 domain.ts / 各服务）；
 *   - 事务为 BEGIN IMMEDIATE 同步事务（node:sqlite）：事务内严禁网络/异步调用；
 *     所有写路径的唯一性域校验（如 employee+version、run+stepKey）由各服务在 store.txn 内完成预检，
 *     SQLite 唯一索引兜底（insert 冲突直接抛出，服务层负责翻译成中文领域错误）；
 *   - 表结构唯一事实源是 contract.ts 的 WORKFORCE_TABLES，本文件不重复声明列。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { SqlValue, SqliteTxnService } from '../../platform-core/src/sqlite.ts'
import { t } from '../../platform-i18n/src/index.ts'
import { WORKFORCE_TABLES } from './contract.ts'
import type {
  AppointmentRecord,
  ArtifactRecord,
  BindingRecord,
  DeliverableRecord,
  EmployeeRecord,
  InvocationRecord,
  ManifestRecord,
  OutboxRecord,
  PermitRecord,
  ResourceGrantRecord,
  TableStore,
  UsageLinkRecord,
  WorkforceStore,
  WorkforceTableSpec,
} from './contract.ts'

/** 契约接口键 → 表名（WORKFORCE_TABLES 的权威键）。 */
const TABLE_NAMES = {
  employees: 'workforce_employees',
  bindings: 'workforce_bindings',
  appointments: 'workforce_appointments',
  grants: 'workforce_resource_grants',
  manifests: 'workforce_manifests',
  permits: 'workforce_permits',
  invocations: 'workforce_invocations',
  usageLinks: 'workforce_usage_links',
  artifacts: 'workforce_artifacts',
  deliverables: 'workforce_deliverables',
  outbox: 'workforce_outbox',
} as const

type Row = Record<string, SqlValue>

/**
 * 基于 txnStore 的通用 TableStore 实现。
 *
 * jsonFields 口径（契约 WorkforceTableSpec.jsonFields）：
 *   - 标注字段写入时 JSON 序列化、读出时反序列化；值本身已是字符串则按「已序列化文本」原样落库；
 *   - 当前 WORKFORCE_TABLES 各表的 JSON 载荷（grantsJson/actionsJson/toolsJson/argsSummaryJson 等）
 *     均以 *Json TEXT 列承载、记录类型即声明为 string，故各表 jsonFields 现为空——
 *     机制保留给后续 additive 扩展字段，不改动既有列语义（§11.3 additive-only）；
 *   - findWhere 对 jsonFields 按存储文本等值匹配（不做结构化匹配）：查询方须传入与落库一致的
 *     序列化文本；未标注字段按原值等值匹配。
 */
class TxnTableStore<T extends { id: string }> implements TableStore<T> {
  private readonly svc: SqliteTxnService
  private readonly spec: WorkforceTableSpec

  constructor(svc: SqliteTxnService, spec: WorkforceTableSpec) {
    this.svc = svc
    this.spec = spec
  }

  /** 写入编码：jsonFields 序列化，其余原值（undefined 归 null）。 */
  private encodeField(field: string, value: unknown): SqlValue {
    if ((this.spec.jsonFields ?? []).includes(field)) {
      if (typeof value === 'string') return value
      return JSON.stringify(value ?? null)
    }
    return (value === undefined ? null : value) as SqlValue
  }

  private encodeRow(record: Record<string, unknown>): Row {
    const row: Row = {}
    for (const [key, value] of Object.entries(record)) row[key] = this.encodeField(key, value)
    return row
  }

  /** 读出解码：jsonFields 反序列化；坏 JSON 按原始文本保留（诚实呈现，不静默修复）。 */
  private decodeRow(row: Row): T {
    const jsonFields = this.spec.jsonFields ?? []
    if (jsonFields.length === 0) return row as T
    const out: Record<string, unknown> = { ...row }
    for (const field of jsonFields) {
      const raw = out[field]
      if (typeof raw !== 'string') continue
      try {
        out[field] = JSON.parse(raw)
      } catch {
        /* 存量文本非合法 JSON：保留原文，由上层显式报错 */
      }
    }
    return out as T
  }

  insert(row: T): void {
    // 唯一索引/主键冲突在此直接抛出；服务层应在 txn 内预检并翻译为中文领域错误
    this.svc.insert(this.spec.name, this.encodeRow(row as unknown as Record<string, unknown>))
  }

  get(id: string): T | undefined {
    const row = this.svc.one<Row>(this.spec.name, { id })
    return row ? this.decodeRow(row) : undefined
  }

  all(): T[] {
    return this.svc.all<Row>(this.spec.name).map((row) => this.decodeRow(row))
  }

  findWhere(where: Record<string, SqlValue>): T[] {
    const encoded: Row = {}
    for (const [key, value] of Object.entries(where)) encoded[key] = this.encodeField(key, value)
    return this.svc.all<Row>(this.spec.name, encoded).map((row) => this.decodeRow(row))
  }

  update(id: string, patch: Partial<T>): void {
    const encoded = this.encodeRow(patch as Record<string, unknown>)
    if (Object.keys(encoded).length === 0) return
    this.svc.updateByKey(this.spec.name, ['id'], [id], encoded)
  }

  delete(id: string): void {
    // 表名来自冻结契约（ensureTable 已按标识符白名单校验），此处仅拼接常量
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.spec.name)) throw new Error(t('非法表名：{name}', { name: this.spec.name }))
    this.svc.run(`DELETE FROM ${this.spec.name} WHERE id = ?`, [id])
  }

  count(): number {
    return this.svc.count(this.spec.name)
  }
}

export interface WorkforceStoreConfig {
  /** 预留：与 WorkforceConfig.dataDir 对齐（txnStore 已由 platform-core 按 dataDir 建库）。 */
  dataDir?: string
}

/**
 * WorkforceStoreService（provide 'workforceStore'）。
 *
 * 唯一性域校验约定（写路径纪律）：本服务不内置业务规则；服务层必须在 store.txn 内
 * 先查后写完成唯一性域校验并抛中文错误，例如：
 *   - employee+version 冲突 → `throw new Error('该员工已存在同名任用版本…')`（路由层 400）；
 *   - run+stepKey 不同参数命中唯一约束 → WorkforceError('STEP_ARGUMENT_CONFLICT')（仅限调用步骤）；
 *   - 同 Agent 二次 active 绑定 → WorkforceError('PRINCIPAL_BINDING_MISMATCH')。
 */
export class WorkforceStoreService extends Service implements WorkforceStore {
  static readonly provide = 'workforceStore'

  private readonly svc: SqliteTxnService

  readonly employees: TableStore<EmployeeRecord>
  readonly bindings: TableStore<BindingRecord>
  readonly appointments: TableStore<AppointmentRecord>
  readonly grants: TableStore<ResourceGrantRecord>
  readonly manifests: TableStore<ManifestRecord>
  readonly permits: TableStore<PermitRecord>
  readonly invocations: TableStore<InvocationRecord>
  readonly usageLinks: TableStore<UsageLinkRecord>
  readonly artifacts: TableStore<ArtifactRecord>
  readonly deliverables: TableStore<DeliverableRecord>
  readonly outbox: TableStore<OutboxRecord>

  constructor(ctx: Context, config: WorkforceStoreConfig = {}) {
    super(ctx, 'workforceStore')
    void config // txnStore 底座由 platform-core 以同一 dataDir 建库；此处仅对齐配置形状
    // txnStore 属基础层（platform-core），本插件依赖清单已声明；经结构化读取避免装配顺序耦合
    this.svc = (ctx as unknown as { txnStore: SqliteTxnService }).txnStore
    this.employees = new TxnTableStore<EmployeeRecord>(this.svc, WORKFORCE_TABLES[TABLE_NAMES.employees])
    this.bindings = new TxnTableStore<BindingRecord>(this.svc, WORKFORCE_TABLES[TABLE_NAMES.bindings])
    this.appointments = new TxnTableStore<AppointmentRecord>(this.svc, WORKFORCE_TABLES[TABLE_NAMES.appointments])
    this.grants = new TxnTableStore<ResourceGrantRecord>(this.svc, WORKFORCE_TABLES[TABLE_NAMES.grants])
    this.manifests = new TxnTableStore<ManifestRecord>(this.svc, WORKFORCE_TABLES[TABLE_NAMES.manifests])
    this.permits = new TxnTableStore<PermitRecord>(this.svc, WORKFORCE_TABLES[TABLE_NAMES.permits])
    this.invocations = new TxnTableStore<InvocationRecord>(this.svc, WORKFORCE_TABLES[TABLE_NAMES.invocations])
    this.usageLinks = new TxnTableStore<UsageLinkRecord>(this.svc, WORKFORCE_TABLES[TABLE_NAMES.usageLinks])
    this.artifacts = new TxnTableStore<ArtifactRecord>(this.svc, WORKFORCE_TABLES[TABLE_NAMES.artifacts])
    this.deliverables = new TxnTableStore<DeliverableRecord>(this.svc, WORKFORCE_TABLES[TABLE_NAMES.deliverables])
    this.outbox = new TxnTableStore<OutboxRecord>(this.svc, WORKFORCE_TABLES[TABLE_NAMES.outbox])
    // 装配即迁移（幂等建表）：后续服务可直接读写，不必显式调用 migrate
    this.migrate()
  }

  /** 迁移：遍历 WORKFORCE_TABLES 建齐表/唯一索引/普通索引（幂等；DDL 纳入同事务）。 */
  migrate(): void {
    this.txn(() => {
      for (const spec of Object.values(WORKFORCE_TABLES)) {
        this.svc.ensureTable(spec.name, spec.columns, { uniques: spec.uniques, indexes: spec.indexes })
      }
    })
  }

  /** BEGIN IMMEDIATE 同步事务（txnStore 包装）：短检查/预留/提交用；网络调用严禁入内。 */
  txn<T>(fn: () => T): T {
    return this.svc.txn(fn)
  }
}
