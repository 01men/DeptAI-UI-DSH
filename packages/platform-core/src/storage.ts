/**
 * 存储抽象：业务插件只面对 Collection API，不感知物理存储。
 *
 * 双后端（ADR-0001，PLATFORM_STORAGE 切换，默认 json 保证向后兼容）：
 *   - json  ：JSON 集合 + 内存索引 + 防抖原子落盘（CollectionImpl，原实现）；
 *   - sqlite：集合整体驻 SQLite（SqliteCollectionImpl，storage-sqlite.ts）——
 *             写入即事务、uniqueOn 落引擎级唯一索引、常驻内存不随记录数增长。
 * 两种后端严格同一 Collection<T> 契约，插件代码零改动。
 */
import { copyFile, mkdir, readdir, readFile, rename, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { t } from '../../platform-i18n/src/index.ts'
import { SqliteCollectionBackend, SqliteCollectionImpl } from './storage-sqlite.ts'

export interface RecordBase {
  id: string
  createdAt: string
  updatedAt: string
}

export type ChangeKind = 'insert' | 'update' | 'remove' | 'replace'

export interface CollectionChange<T> {
  kind: ChangeKind
  record: T
}

export interface Collection<T extends RecordBase> {
  readonly name: string
  all(): T[]
  get(id: string): T | undefined
  find(pred: (record: T) => boolean): T[]
  findOne(pred: (record: T) => boolean): T | undefined
  insert(data: Omit<T, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): T
  update(id: string, patch: Partial<T>): T
  remove(id: string): boolean
  replaceAll(records: T[]): void
  count(): number
  onChange(cb: (change: CollectionChange<T>) => void): () => void
  /**
   * 声明业务唯一约束（模拟数据库部分唯一索引）。
   * 之后 insert/update 违反约束将直接抛错——「先查后插」被引擎级兜底取代，
   * 并发与竞态下不再可能产生重复数据（红线来自 auth-identity 模块设计）。
   */
  uniqueOn(label: string, keyOf: (record: T) => string): void
}

/**
 * sqlite 后端默认 JSON 豁免名单（ADR-0001 §五第 3 批「低频配置型集合」，与 ADR 同名可查）。
 *
 * 名单依据（grep 全仓 opsStorage.collection 注册点核对的真实集合名；代码内集合名用 `:`，
 * 数据文件名由 fileNameOf 转义为 `~`）：
 *   - resource:dependencies · update:state · platform:bootstrap —— 低频配置型；
 *   - market:*（前缀通配）—— market:developers / market:installs / market:submissions；
 *   - 各插件 migrations / snapshot 集合：agent:migrations · app:migrations · iam:migrations
 *     · iam:groupSnapshots（写一次的数据演化标记，无 DB 化收益）；
 *   - oidc-keys —— 平台级 OIDC 签名密钥文件（plugin-authn 直读 dataDir 下 oidc-keys.json，
 *     并非集合；restoreAll 按文件名扫描会命中该名，入名单使其留在 JSON 路径按平台级文件跳过，
 *     不在 sqlite meta 里留下伪集合记录）。
 *
 * 语义：PLATFORM_STORAGE_JSON_KEEP **未设置**时应用本名单；显式设置时完全覆盖默认
 *（含「显式给空串 = 一个都不豁免」，见 parseKeepEnv）。
 */
export const DEFAULT_JSON_KEEP: readonly string[] = [
  'resource:dependencies',
  'update:state',
  'oidc-keys',
  'market:*',
  'platform:bootstrap',
  'agent:migrations',
  'app:migrations',
  'iam:migrations',
  'mcp:migrations',
  'iam:groupSnapshots',
]

export interface CollectionOptions {
  /**
   * 持久化模式：
   *   - debounced（默认）：250ms 防抖合并落盘；
   *   - durable：每次变更立即落盘并 fsync（认证吊销等不容许崩溃丢失的集合）。
   */
  durability?: 'debounced' | 'durable'
}

export type StorageBackendKind = 'json' | 'sqlite'

export interface StorageConfig {
  /** 数据目录，默认 `<cwd>/data`。 */
  dataDir?: string
  /**
   * 集合存储后端（默认 json，向后兼容）：
   *   - json  ：JSON 文件落盘（防抖/durable 两档）；
   *   - sqlite：data/collections.db，WAL + synchronous=FULL，写入即事务，
   *             首启自动回填同名 JSON 集合文件（文件保留为回滚源）。
   * 未显式配置时读 PLATFORM_STORAGE 环境变量（独立宿主与 dsh 宿主两种形态通用）。
   */
  backend?: StorageBackendKind
}

class CollectionImpl<T extends RecordBase> implements Collection<T> {
  private records = new Map<string, T>()
  private listeners = new Set<(change: CollectionChange<T>) => void>()
  private uniques: Array<{ label: string; keyOf: (record: T) => string }> = []

  readonly name: string
  private readonly persist: (name: string) => void

  constructor(name: string, persist: (name: string) => void) {
    this.name = name
    this.persist = persist
  }

  uniqueOn(label: string, keyOf: (record: T) => string): void {
    if (this.uniques.some((unique) => unique.label === label)) return
    this.uniques.push({ label, keyOf })
  }

  /** 校验唯一约束：返回既有冲突记录（不含自身）。 */
  private conflictOf(record: T, selfId?: string): { label: string; existing: T } | undefined {
    for (const unique of this.uniques) {
      const key = unique.keyOf(record)
      if (key === '' || key === undefined) continue
      for (const other of this.records.values()) {
        if (selfId !== undefined && other.id === selfId) continue
        if (unique.keyOf(other) === key) return { label: unique.label, existing: other }
      }
    }
    return undefined
  }

  all(): T[] {
    return [...this.records.values()]
  }

  get(id: string): T | undefined {
    return this.records.get(id)
  }

  find(pred: (record: T) => boolean): T[] {
    return this.all().filter(pred)
  }

  findOne(pred: (record: T) => boolean): T | undefined {
    for (const record of this.records.values()) {
      if (pred(record)) return record
    }
    return undefined
  }

  insert(data: Omit<T, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): T {
    const now = new Date().toISOString()
    const record = { createdAt: now, updatedAt: now, ...data, updatedAt: now } as T
    if (this.records.has(record.id)) throw new Error(t('[storage] 集合 {name} 中已存在 id={id}', { name: this.name, id: record.id }))
    const conflict = this.conflictOf(record)
    if (conflict) throw new Error(t('[storage] 唯一约束冲突（{label}）：与既有记录 {id} 重复', { label: conflict.label, id: conflict.existing.id }))
    this.records.set(record.id, record)
    this.emit({ kind: 'insert', record })
    this.persist(this.name)
    return structuredClone(record)
  }

  update(id: string, patch: Partial<T>): T {
    const current = this.records.get(id)
    if (!current) throw new Error(t('[storage] 集合 {name} 中不存在 id={id}', { name: this.name, id }))
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() } as T
    const conflict = this.conflictOf(next, id)
    if (conflict) throw new Error(t('[storage] 唯一约束冲突（{label}）：与既有记录 {id} 重复', { label: conflict.label, id: conflict.existing.id }))
    this.records.set(id, next)
    this.emit({ kind: 'update', record: next })
    this.persist(this.name)
    return structuredClone(next)
  }

  remove(id: string): boolean {
    const existed = this.records.delete(id)
    if (existed) {
      this.emit({ kind: 'remove', record: { id } as T })
      this.persist(this.name)
    }
    return existed
  }

  replaceAll(records: T[]): void {
    this.records.clear()
    for (const record of records) this.records.set(record.id, record)
    this.persist(this.name)
    this.emit({ kind: 'replace', record: {} as T })
  }

  /** 恢复磁盘数据（仅启动期调用）。 */
  loadFrom(records: T[]): void {
    this.records.clear()
    for (const record of records) this.records.set(record.id, record)
  }

  count(): number {
    return this.records.size
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

export class StorageService extends Service {
  static readonly provide = 'opsStorage'

  private collections = new Map<string, Collection<RecordBase>>()
  private durableNames = new Set<string>()
  /** sqlite 后端承载的集合名（json 例外名单内的集合不在此列）。 */
  private sqliteNames = new Set<string>()
  private sqliteBackend?: SqliteCollectionBackend
  private readonly jsonKeep: string[]
  /** JSON 豁免名单是否来自显式环境变量（默认名单不触发「json 后端下无效」告警）。 */
  private readonly jsonKeepExplicit: boolean
  private dirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  /** 落盘串行链（并发 flushNow 排队执行，避免同名 tmp 竞争）。 */
  private flushChain: Promise<void> = Promise.resolve()
  private tmpSeq = 0
  /** 恢复期发现的损坏文件（坏 JSON 已备份为 *.corrupt，启动日志有痕）。 */
  readonly corruptFiles: string[] = []
  /** 数据目录（密钥等平台级文件的存放处）。 */
  readonly dataDirPath: string
  /** 集合存储后端（config.backend ?? PLATFORM_STORAGE 环境变量，默认 json）。 */
  readonly backend: StorageBackendKind

  constructor(ctx: Context, config: StorageConfig = {}) {
    super(ctx, 'opsStorage')
    this.dataDirPath = config.dataDir ?? join(process.cwd(), "data")
    this.backend = config.backend ?? parseBackendEnv(process.env.PLATFORM_STORAGE)
    // 豁免名单：环境变量未设置 → 内置默认名单（ADR-0001 §五第 3 批）；
    // 显式设置 → 完全覆盖默认（parseKeepEnv('') 返回 []，即「一个都不豁免」）。
    const keepEnv = process.env.PLATFORM_STORAGE_JSON_KEEP
    this.jsonKeep = keepEnv === undefined ? [...DEFAULT_JSON_KEEP] : parseKeepEnv(keepEnv)
    this.jsonKeepExplicit = keepEnv !== undefined
    if (this.jsonKeepExplicit && this.jsonKeep.length > 0 && this.backend !== 'sqlite') {
      console.warn('[storage] PLATFORM_STORAGE_JSON_KEEP 仅在 PLATFORM_STORAGE=sqlite 下生效，当前忽略')
    }
    ctx.effect(() => () => {
      if (this.flushTimer) clearTimeout(this.flushTimer)
      void this.flushNow()
      this.sqliteBackend?.close()
    })
    this.installSignalFlush()
  }

  /**
   * 信号落盘钩子（form B 数据安全）：form A 的 main.ts 自带 SIGTERM/SIGINT → flushNow，
   * 但挂载进 dsh 宿主后（loader 装配）没有等价钩子——防抖窗口内的写会在进程被
   * SIGTERM（launchd kickstart / pkill）时丢失，且 SQLite（即时写）与 JSON 集合
   * （防抖写）不同步会造成「半套数据」启动态。基础层自装一次（跨形态生效）；
   * 双注册无害（form A main.ts 的处理器并存：flushChain 串行 + exit 幂等）。
   */
  private installSignalFlush(): void {
    const proc = process as unknown as NodeJS.Process & Record<string, unknown>
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const guard = `__rqStorageFlushInstalled_${signal}`
      if (proc[guard] === true) continue
      proc[guard] = true
      process.on(signal, () => {
        void this.flushNow().finally(() => process.exit(0))
      })
    }
  }

  async start(): Promise<void> {
    await mkdir(this.dataDirPath, { recursive: true })
  }

  /** 该集合是否由 sqlite 后端承载（sqlite 后端下 JSON 例外名单内的集合仍走 JSON）。 */
  private usesSqlite(name: string): boolean {
    if (this.backend !== 'sqlite') return false
    return !this.jsonKeep.some((pattern) =>
      pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
    )
  }

  private ensureSqliteBackend(): SqliteCollectionBackend {
    if (!this.sqliteBackend) this.sqliteBackend = new SqliteCollectionBackend(this.dataDirPath)
    return this.sqliteBackend
  }

  collection<T extends RecordBase>(name: string, options: CollectionOptions = {}): Collection<T> {
    if (options.durability === 'durable') this.durableNames.add(name)
    const existing = this.collections.get(name)
    if (existing) return existing as unknown as Collection<T>
    if (this.usesSqlite(name)) {
      this.sqliteNames.add(name)
      const created = this.ensureSqliteBackend().collection<T>(name)
      this.collections.set(name, created as unknown as Collection<RecordBase>)
      return created
    }
    const created = new CollectionImpl<T>(name, (n) => this.onPersist(n))
    this.collections.set(name, created as unknown as Collection<RecordBase>)
    return created
  }

  private onPersist(name: string): void {
    if (this.durableNames.has(name)) {
      // 关键集合：跳过防抖窗口立即落盘（评审 S 系列：吊销返回 200 后崩溃不得丢失）
      this.dirty.add(name)
      void this.flushNow()
      return
    }
    this.markDirty(name)
  }

  /** 启动期从磁盘恢复指定集合（幂等）。坏 JSON 备份为 *.corrupt 后从空集合开始（不再静默清空）。 */
  async restore<T extends RecordBase>(name: string): Promise<Collection<T>> {
    await mkdir(this.dataDirPath, { recursive: true })
    if (this.usesSqlite(name)) return this.restoreSqlite<T>(name)
    const collection = this.collection<T>(name)
    const file = join(this.dataDirPath, `${fileNameOf(name)}.json`)
    let records: T[] = []
    try {
      const raw = await readFile(file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        // 平台级文件（如 oidc-keys.json 密钥对象）不是集合：静默跳过，不算损坏
        records = []
      } else {
        records = parsed as T[]
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        records = []
      } else {
        // 文件存在但损坏：保留现场（*.corrupt 备份），显式告警，绝不无痕当空集合
        await this.backupCorrupt(name, file, error)
        records = []
      }
    }
    ;(collection as unknown as CollectionImpl<T>).loadFrom(records)
    return collection
  }

  /**
   * sqlite 后端恢复：DB 为准，首启自动回填同名 JSON 集合文件（文件保留为回滚源）。
   * meta.backfilled_at=NULL 表示导入未完成（上次启动在导入事务提交前崩溃）——重试导入，
   * 导入与标记在 storage-sqlite 的同一事务内原子生效，不会出现「半套数据」。
   * 导入事务内回填后先行对账（条数 + 关键字段哈希，assertBackfillParity）：
   * 不一致即抛错并整体回滚，标记不会落在坏数据上。
   */
  private async restoreSqlite<T extends RecordBase>(name: string): Promise<Collection<T>> {
    const backend = this.ensureSqliteBackend()
    const collection = this.collection<T>(name)
    if (!backend.metaOf(name)) backend.markCreated(name)
    if (backend.metaOf(name)?.backfilled_at !== null) return collection
    const file = join(this.dataDirPath, `${fileNameOf(name)}.json`)
    let records: T[] = []
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (Array.isArray(parsed)) records = parsed as T[]
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') await this.backupCorrupt(name, file, error)
    }
    backend.backfill(name, records, (rows) => assertBackfillParity(name, records, rows))
    if (records.length > 0) {
      console.log(`[storage] 集合 ${name} 已回填 ${records.length} 条至 SQLite（${file} 保留为回滚源）`)
    }
    return collection
  }

  /** 损坏 JSON 留痕：备份为 *.corrupt-<ts>，登记 corruptFiles，显式告警（不阻断启动）。 */
  private async backupCorrupt(name: string, file: string, error: unknown): Promise<void> {
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      await copyFile(file, backup)
    } catch { /* 备份失败不阻断启动，下方仍有错误日志 */
    }
    console.error(`[storage] 集合 ${name} 文件损坏（${error instanceof Error ? error.message : String(error)}），已备份至 ${backup}，从空集合恢复`)
    this.corruptFiles.push(backup)
  }

  /** 扫描数据目录并恢复全部集合（业务插件加载前调用一次）。 */
  async restoreAll(): Promise<string[]> {
    await mkdir(this.dataDirPath, { recursive: true })
    const restored: string[] = []
    // sqlite 后端：DB meta 已登记的集合同样是恢复对象（其 JSON 回滚源文件可能已被清理）
    const names = new Set<string>(this.backend === 'sqlite' ? this.ensureSqliteBackend().names() : [])
    let files: string[] = []
    try {
      files = (await readdir(this.dataDirPath)).filter((file) => file.endsWith('.json'))
    } catch {
      files = []
    }
    for (const file of files) {
      names.add(decodeFileName(file.slice(0, -5)))
    }
    for (const name of names) {
      try {
        await this.restore(name)
        restored.push(name)
      } catch (error) {
        console.error(`[storage] 恢复集合 ${name} 失败`, error)
      }
    }
    return restored
  }

  /** 已恢复/创建的集合名列表（供平台信息展示）。 */
  names(): string[] {
    return [...this.collections.keys()]
  }

  private markDirty(name: string): void {
    this.dirty.add(name)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flushNow()
    }, 250)
  }

  /** 立即将脏集合落盘（原子写：tmp + fsync + rename；全程串行防并发写同名 tmp）。 */
  flushNow(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlush())
    return this.flushChain
  }

  private async doFlush(): Promise<void> {
    for (;;) {
      const names = [...this.dirty]
      this.dirty.clear()
      if (names.length === 0) return
      for (const name of names) {
        // sqlite 集合写入即事务提交（WAL + synchronous=FULL），无防抖窗口、无 JSON 落盘面
        if (this.sqliteNames.has(name)) continue
        const collection = this.collections.get(name)
        if (!collection) continue
        const file = join(this.dataDirPath, `${fileNameOf(name)}.json`)
        const tmp = `${file}.${process.pid}-${Date.now()}-${++this.tmpSeq}.tmp`
        try {
          await mkdir(dirname(file), { recursive: true })
          const handle = await open(tmp, 'w')
          try {
            await handle.writeFile(JSON.stringify(collection.all(), null, 2), 'utf8')
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(tmp, file)
        } catch (error) {
          // rename ENOENT（停机窗口目录/临时文件被外部回收的竞态）降噪：内存态未失，
          // 下次落盘自然恢复；debug 级留痕即可，不重试不告警（防关停期日志风暴）
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            console.debug(`[storage] 集合 ${name} 落盘 rename 竞态（ENOENT，内存态未失，下次落盘恢复）`)
          } else {
            console.error(`[storage] 集合 ${name} 落盘失败`, error)
          }
        }
      }
      // 落盘期间又有变更（durable 即时触发）：循环直至清空
    }
  }

  /**
   * 全量强持久化：把所有 JSON 集合写入并 fsync（HTTP 响应前调用，
   * 确保「返回 200 后进程被杀」不丢变更——评审崩溃恢复实验的修复点）。
   * sqlite 集合每次写入已事务提交，天然满足该保证，不在刷盘范围。
   */
  async flushDurable(): Promise<void> {
    for (const name of this.collections.keys()) {
      if (!this.sqliteNames.has(name)) this.dirty.add(name)
    }
    await this.flushNow()
  }
}


/** 集合名 → 文件名（Windows 保留字符转义）。 */
function fileNameOf(name: string): string {
  return name.replace(/[:*?"<>|]/g, '~')
}

/**
 * 回填对账（ADR-0001 缺口②）：JSON 源与 SQLite 落库逐条对账——条数一致 + 每条记录
 * 规范化序列化（键递归排序）SHA-256 哈希一致。不一致即抛错（响亮失败），错误消息
 * 含集合名与差异数；配合 backfill 单事务语义，抛错时导入与 meta 标记一并回滚，
 * 下次启动重试并再次失败——绝不带着静默不一致完成回填。
 */
function assertBackfillParity(name: string, source: RecordBase[], rows: Array<{ id: string; doc: string }>): void {
  if (rows.length !== source.length) {
    throw new Error(t('[storage] 集合 {name} 回填对账失败：条数不一致（JSON 源 {json} 条 / SQLite 落库 {sql} 条）', { name, json: source.length, sql: rows.length }))
  }
  const sourceHashes = new Map(source.map((record) => [record.id, recordHash(record)]))
  let diff = 0
  for (const row of rows) {
    const expected = sourceHashes.get(row.id)
    if (expected === undefined || expected !== recordHash(JSON.parse(row.doc) as RecordBase)) diff++
  }
  if (diff > 0) {
    throw new Error(t('[storage] 集合 {name} 回填对账失败：{count} 条记录关键字段哈希不一致', { name, count: diff }))
  }
}

/** 稳定序列化哈希：键递归排序后 JSON 序列化再 SHA-256（对账专用，与存储写入格式无关）。 */
function recordHash(record: RecordBase): string {
  return createHash('sha256').update(canonicalJson(record)).digest('hex')
}

/** 规范化 JSON：对象键逐层排序、剔除 undefined，保证同构数据序列化逐字节一致。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

function decodeFileName(name: string): string {
  return name.replace(/~/g, ':')
}

/** PLATFORM_STORAGE 环境变量 → 后端（默认 json；未知值告警回退，不静默吞）。 */
function parseBackendEnv(value: string | undefined): StorageBackendKind {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === '' || normalized === 'json') return 'json'
  if (normalized === 'sqlite' || normalized === 'sqlite3' || normalized === 'db') return 'sqlite'
  console.warn(`[storage] 未知 PLATFORM_STORAGE=${value}，回退 json（可选：json | sqlite）`)
  return 'json'
}

/**
 * PLATFORM_STORAGE_JSON_KEEP：sqlite 后端下仍保留 JSON 落盘的集合名（逗号分隔，`前缀*` 通配）。
 * 语义：未设置 → 用 DEFAULT_JSON_KEEP；显式设置 → 完全覆盖默认名单——
 * 空串解析为空数组，即「显式给空串 = 一个都不豁免，全部集合走 sqlite」。
 */
function parseKeepEnv(value: string | undefined): string[] {
  if (!value) return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}
