/**
 * 存储后端：SQLite 集合实现（ADR-0001 第一期）。
 *
 * 与 JSON 集合（storage.ts CollectionImpl）严格同一 Collection<T> 契约，业务插件零感知：
 *   - 文档存单表 collection_docs（name, id, doc JSON）；每次写入独立事务提交
 *     （WAL + synchronous=FULL——进程 kill -9 后已提交事务零丢失）。
 *   - uniqueOn → collection_uniques（name, label, key, id）真实唯一主键：
 *     「先查后插」竞态由引擎级约束兜底，而非应用层扫描
 *     （iam:identityLinks「一人一号」红线的执行点，见 ADR-0001 第 2 批验收）。
 *   - onChange 监听器在事务提交后同步触发（authn:tokens 吊销广播语义不变）。
 *   - 读路径按需解析文档，常驻内存不随记录数线性增长。
 *
 * 回填（backfill）：restore 时若该集合尚无 meta 且数据目录存在同名 JSON 文件，
 * 整表导入一次；JSON 文件保留不删，作为回滚源（导回 JSON 用 scripts/storage-export.mjs）。
 * meta.backfilled_at 为 NULL 表示「尚未完成导入」——进程在导入事务前崩溃时下次启动重试，
 * 导入与标记在同一事务内完成，不会出现「半套数据」。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../../platform-i18n/src/index.ts'
import type { Collection, CollectionChange, RecordBase } from './storage.ts'

export class SqliteCollectionBackend {
  readonly db: DatabaseSync
  readonly file: string
  private collections = new Map<string, SqliteCollectionImpl<RecordBase>>()

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'collections.db')
    this.db = new DatabaseSync(this.file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS collection_docs (
      name TEXT NOT NULL,
      id TEXT NOT NULL,
      doc TEXT NOT NULL,
      PRIMARY KEY (name, id)
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS collection_uniques (
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      key TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (name, label, key)
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS collection_meta (
      name TEXT PRIMARY KEY,
      backfilled_at TEXT,
      created_at TEXT NOT NULL
    )`)
  }

  /** 事务：fn 内全部写入原子提交（BEGIN IMMEDIATE 立即取写锁，避免升级死锁）。 */
  txn<R>(fn: () => R): R {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* 连接异常时回滚失败仅记录 */
      }
      throw error
    }
  }

  collection<T extends RecordBase>(name: string): Collection<T> {
    const existing = this.collections.get(name)
    if (existing) return existing as unknown as Collection<T>
    const created = new SqliteCollectionImpl<T>(this, name)
    this.collections.set(name, created as unknown as SqliteCollectionImpl<RecordBase>)
    return created
  }

  /** 已登记集合名（meta 表，含回填过的与新建的）。 */
  names(): string[] {
    return (this.db.prepare('SELECT name FROM collection_meta ORDER BY name').all() as Array<{ name: string }>).map((row) => row.name)
  }

  metaOf(name: string): { backfilled_at: string | null } | undefined {
    return this.db.prepare('SELECT backfilled_at FROM collection_meta WHERE name = ?').get(name) as { backfilled_at: string | null } | undefined
  }

  markCreated(name: string): void {
    this.db.prepare('INSERT OR IGNORE INTO collection_meta (name, backfilled_at, created_at) VALUES (?, NULL, ?)').run(name, new Date().toISOString())
  }

  /**
   * JSON → SQLite 回填：仅在集合当前为空时导入（幂等防重），导入完成与标记
   * backfilled_at 在同一事务内原子生效。集合非空（如导入事务已提交但标记读取前的
   * 极端窗口）同样补记标记，避免下次启动重复探测 JSON。
   *
   * 回填对账（ADR-0001 缺口②）：verify 回调插在导入之后、标记 backfilled_at 之前——
   * 条数与关键字段哈希对账失败即抛错，整个事务回滚（导入与标记一并撤销，meta 恢复
   * NULL），下次启动重试并再次响亮失败，杜绝「带病标记 + 静默不一致」。
   */
  backfill(name: string, records: RecordBase[], verify?: (rows: Array<{ id: string; doc: string }>) => void): void {
    this.txn(() => {
      const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM collection_docs WHERE name = ?').get(name) as { n: number }).n)
      if (count === 0) {
        const ins = this.db.prepare('INSERT INTO collection_docs (name, id, doc) VALUES (?, ?, ?)')
        for (const record of records) ins.run(name, record.id, JSON.stringify(record))
      }
      // 对账读的是同一事务内的未提交数据：失败即 ROLLBACK，崩溃安全语义不变
      if (verify) verify(this.db.prepare('SELECT id, doc FROM collection_docs WHERE name = ? ORDER BY id').all(name) as Array<{ id: string; doc: string }>)
      this.db.prepare('UPDATE collection_meta SET backfilled_at = ? WHERE name = ?').run(new Date().toISOString(), name)
    })
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* 已关闭 */
    }
  }
}

export class SqliteCollectionImpl<T extends RecordBase> implements Collection<T> {
  private uniques: Array<{ label: string; keyOf: (record: T) => string }> = []
  private listeners = new Set<(change: CollectionChange<T>) => void>()
  private readonly backend: SqliteCollectionBackend

  readonly name: string

  constructor(backend: SqliteCollectionBackend, name: string) {
    this.backend = backend
    this.name = name
    this.backend.markCreated(name)
  }

  private get db(): DatabaseSync {
    return this.backend.db
  }

  private txn<R>(fn: () => R): R {
    return this.backend.txn(fn)
  }

  uniqueOn(label: string, keyOf: (record: T) => string): void {
    if (this.uniques.some((unique) => unique.label === label)) return
    this.uniques.push({ label, keyOf })
    // 注册即对存量数据生效：全量重建该 label 的键，保证键表与当前 keyOf 实现一致。
    // 约束集合均为治理型小集合（用户/组织/身份连接等），重建成本毫秒级。
    const rows = this.db.prepare('SELECT id, doc FROM collection_docs WHERE name = ?').all(this.name) as Array<{ id: string; doc: string }>
    this.txn(() => {
      this.db.prepare('DELETE FROM collection_uniques WHERE name = ? AND label = ?').run(this.name, label)
      const ins = this.db.prepare('INSERT OR IGNORE INTO collection_uniques (name, label, key, id) VALUES (?, ?, ?, ?)')
      for (const row of rows) {
        const key = keyOf(JSON.parse(row.doc) as T)
        if (key) ins.run(this.name, label, key, row.id)
      }
    })
  }

  /** 唯一约束执行（引擎级）：update 时先移除自身旧键再占新键，冲突即抛（事务回滚）。 */
  private enforceUniques(record: T, selfId?: string): void {
    for (const unique of this.uniques) {
      const key = unique.keyOf(record)
      if (!key) continue
      if (selfId !== undefined) {
        this.db.prepare('DELETE FROM collection_uniques WHERE name = ? AND label = ? AND id = ?').run(this.name, unique.label, selfId)
      }
      try {
        this.db.prepare('INSERT INTO collection_uniques (name, label, key, id) VALUES (?, ?, ?, ?)').run(this.name, unique.label, key, record.id)
      } catch {
        const other = this.db.prepare('SELECT id FROM collection_uniques WHERE name = ? AND label = ? AND key = ?').get(this.name, unique.label, key) as { id: string } | undefined
        throw new Error(t('[storage] 唯一约束冲突（{label}）：与既有记录 {id} 重复', { label: unique.label, id: other?.id ?? '?' }))
      }
    }
  }

  all(): T[] {
    const rows = this.db.prepare('SELECT doc FROM collection_docs WHERE name = ? ORDER BY rowid').all(this.name) as Array<{ doc: string }>
    return rows.map((row) => JSON.parse(row.doc) as T)
  }

  get(id: string): T | undefined {
    const row = this.db.prepare('SELECT doc FROM collection_docs WHERE name = ? AND id = ?').get(this.name, id) as { doc: string } | undefined
    return row ? JSON.parse(row.doc) as T : undefined
  }

  find(pred: (record: T) => boolean): T[] {
    return this.all().filter(pred)
  }

  findOne(pred: (record: T) => boolean): T | undefined {
    for (const record of this.all()) {
      if (pred(record)) return record
    }
    return undefined
  }

  insert(data: Omit<T, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): T {
    const now = new Date().toISOString()
    const record = { createdAt: now, updatedAt: now, ...data, updatedAt: now } as T
    this.txn(() => {
      const exists = this.db.prepare('SELECT 1 FROM collection_docs WHERE name = ? AND id = ?').get(this.name, record.id)
      if (exists) throw new Error(t('[storage] 集合 {name} 中已存在 id={id}', { name: this.name, id: record.id }))
      this.enforceUniques(record)
      this.db.prepare('INSERT INTO collection_docs (name, id, doc) VALUES (?, ?, ?)').run(this.name, record.id, JSON.stringify(record))
    })
    this.emit({ kind: 'insert', record })
    return structuredClone(record)
  }

  update(id: string, patch: Partial<T>): T {
    const current = this.get(id)
    if (!current) throw new Error(t('[storage] 集合 {name} 中不存在 id={id}', { name: this.name, id }))
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() } as T
    this.txn(() => {
      this.enforceUniques(next, id)
      this.db.prepare('UPDATE collection_docs SET doc = ? WHERE name = ? AND id = ?').run(JSON.stringify(next), this.name, id)
    })
    this.emit({ kind: 'update', record: next })
    return structuredClone(next)
  }

  remove(id: string): boolean {
    let existed = false
    this.txn(() => {
      const info = this.db.prepare('DELETE FROM collection_docs WHERE name = ? AND id = ?').run(this.name, id)
      existed = Number(info.changes) > 0
      if (existed) this.db.prepare('DELETE FROM collection_uniques WHERE name = ? AND id = ?').run(this.name, id)
    })
    if (existed) this.emit({ kind: 'remove', record: { id } as T })
    return existed
  }

  replaceAll(records: T[]): void {
    this.txn(() => {
      this.db.prepare('DELETE FROM collection_docs WHERE name = ?').run(this.name)
      this.db.prepare('DELETE FROM collection_uniques WHERE name = ?').run(this.name)
      const ins = this.db.prepare('INSERT INTO collection_docs (name, id, doc) VALUES (?, ?, ?)')
      const insKey = this.db.prepare('INSERT OR IGNORE INTO collection_uniques (name, label, key, id) VALUES (?, ?, ?, ?)')
      for (const record of records) {
        ins.run(this.name, record.id, JSON.stringify(record))
        // 与 JSON 版对齐：replaceAll 不做唯一校验（宽松落键，OR IGNORE）
        for (const unique of this.uniques) {
          const key = unique.keyOf(record)
          if (key) insKey.run(this.name, unique.label, key, record.id)
        }
      }
    })
    this.emit({ kind: 'replace', record: {} as T })
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM collection_docs WHERE name = ?').get(this.name) as { n: number }).n)
  }

  onChange(cb: (change: CollectionChange<T>) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(change: CollectionChange<T>): void {
    for (const cb of this.listeners) {
      try {
        cb(change)
      } catch (error) {
        console.error(`[storage] ${this.name} 变更监听器异常`, error)
      }
    }
  }
}
