import { copyFile, mkdir, readdir, readFile, rename, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { t } from "../../platform-i18n/dist/index.js";
import { SqliteCollectionBackend } from "./storage-sqlite.js";
const DEFAULT_JSON_KEEP = [
  "resource:dependencies",
  "update:state",
  "oidc-keys",
  "market:*",
  "platform:bootstrap",
  "agent:migrations",
  "app:migrations",
  "iam:migrations",
  "mcp:migrations",
  "iam:groupSnapshots"
];
class CollectionImpl {
  records = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  uniques = [];
  name;
  persist;
  constructor(name, persist) {
    this.name = name;
    this.persist = persist;
  }
  uniqueOn(label, keyOf) {
    if (this.uniques.some((unique) => unique.label === label)) return;
    this.uniques.push({ label, keyOf });
  }
  /** 校验唯一约束：返回既有冲突记录（不含自身）。 */
  conflictOf(record, selfId) {
    for (const unique of this.uniques) {
      const key = unique.keyOf(record);
      if (key === "" || key === void 0) continue;
      for (const other of this.records.values()) {
        if (selfId !== void 0 && other.id === selfId) continue;
        if (unique.keyOf(other) === key) return { label: unique.label, existing: other };
      }
    }
    return void 0;
  }
  all() {
    return [...this.records.values()];
  }
  get(id) {
    return this.records.get(id);
  }
  find(pred) {
    return this.all().filter(pred);
  }
  findOne(pred) {
    for (const record of this.records.values()) {
      if (pred(record)) return record;
    }
    return void 0;
  }
  insert(data) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const record = { createdAt: now, updatedAt: now, ...data, updatedAt: now };
    if (this.records.has(record.id)) throw new Error(t("[storage] \u96C6\u5408 {name} \u4E2D\u5DF2\u5B58\u5728 id={id}", { name: this.name, id: record.id }));
    const conflict = this.conflictOf(record);
    if (conflict) throw new Error(t("[storage] \u552F\u4E00\u7EA6\u675F\u51B2\u7A81\uFF08{label}\uFF09\uFF1A\u4E0E\u65E2\u6709\u8BB0\u5F55 {id} \u91CD\u590D", { label: conflict.label, id: conflict.existing.id }));
    this.records.set(record.id, record);
    this.emit({ kind: "insert", record });
    this.persist(this.name);
    return structuredClone(record);
  }
  update(id, patch) {
    const current = this.records.get(id);
    if (!current) throw new Error(t("[storage] \u96C6\u5408 {name} \u4E2D\u4E0D\u5B58\u5728 id={id}", { name: this.name, id }));
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    const conflict = this.conflictOf(next, id);
    if (conflict) throw new Error(t("[storage] \u552F\u4E00\u7EA6\u675F\u51B2\u7A81\uFF08{label}\uFF09\uFF1A\u4E0E\u65E2\u6709\u8BB0\u5F55 {id} \u91CD\u590D", { label: conflict.label, id: conflict.existing.id }));
    this.records.set(id, next);
    this.emit({ kind: "update", record: next });
    this.persist(this.name);
    return structuredClone(next);
  }
  remove(id) {
    const existed = this.records.delete(id);
    if (existed) {
      this.emit({ kind: "remove", record: { id } });
      this.persist(this.name);
    }
    return existed;
  }
  replaceAll(records) {
    this.records.clear();
    for (const record of records) this.records.set(record.id, record);
    this.persist(this.name);
    this.emit({ kind: "replace", record: {} });
  }
  /** 恢复磁盘数据（仅启动期调用）。 */
  loadFrom(records) {
    this.records.clear();
    for (const record of records) this.records.set(record.id, record);
  }
  count() {
    return this.records.size;
  }
  onChange(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(change) {
    for (const cb of this.listeners) {
      try {
        cb(change);
      } catch (error) {
        console.error(`[storage] ${this.name} \u53D8\u66F4\u76D1\u542C\u5668\u5F02\u5E38`, error);
      }
    }
  }
}
class StorageService extends Service {
  static provide = "opsStorage";
  collections = /* @__PURE__ */ new Map();
  durableNames = /* @__PURE__ */ new Set();
  /** sqlite 后端承载的集合名（json 例外名单内的集合不在此列）。 */
  sqliteNames = /* @__PURE__ */ new Set();
  sqliteBackend;
  jsonKeep;
  /** JSON 豁免名单是否来自显式环境变量（默认名单不触发「json 后端下无效」告警）。 */
  jsonKeepExplicit;
  dirty = /* @__PURE__ */ new Set();
  flushTimer;
  /** 落盘串行链（并发 flushNow 排队执行，避免同名 tmp 竞争）。 */
  flushChain = Promise.resolve();
  tmpSeq = 0;
  /** 恢复期发现的损坏文件（坏 JSON 已备份为 *.corrupt，启动日志有痕）。 */
  corruptFiles = [];
  /** 数据目录（密钥等平台级文件的存放处）。 */
  dataDirPath;
  /** 集合存储后端（config.backend ?? PLATFORM_STORAGE 环境变量，默认 json）。 */
  backend;
  constructor(ctx, config = {}) {
    super(ctx, "opsStorage");
    this.dataDirPath = config.dataDir ?? join(process.cwd(), "data");
    this.backend = config.backend ?? parseBackendEnv(process.env.PLATFORM_STORAGE);
    const keepEnv = process.env.PLATFORM_STORAGE_JSON_KEEP;
    this.jsonKeep = keepEnv === void 0 ? [...DEFAULT_JSON_KEEP] : parseKeepEnv(keepEnv);
    this.jsonKeepExplicit = keepEnv !== void 0;
    if (this.jsonKeepExplicit && this.jsonKeep.length > 0 && this.backend !== "sqlite") {
      console.warn("[storage] PLATFORM_STORAGE_JSON_KEEP \u4EC5\u5728 PLATFORM_STORAGE=sqlite \u4E0B\u751F\u6548\uFF0C\u5F53\u524D\u5FFD\u7565");
    }
    ctx.effect(() => () => {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      void this.flushNow();
      this.sqliteBackend?.close();
    });
    this.installSignalFlush();
  }
  /**
   * 信号落盘钩子（form B 数据安全）：form A 的 main.ts 自带 SIGTERM/SIGINT → flushNow，
   * 但挂载进 dsh 宿主后（loader 装配）没有等价钩子——防抖窗口内的写会在进程被
   * SIGTERM（launchd kickstart / pkill）时丢失，且 SQLite（即时写）与 JSON 集合
   * （防抖写）不同步会造成「半套数据」启动态。基础层自装一次（跨形态生效）；
   * 双注册无害（form A main.ts 的处理器并存：flushChain 串行 + exit 幂等）。
   */
  installSignalFlush() {
    const proc = process;
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const guard = `__rqStorageFlushInstalled_${signal}`;
      if (proc[guard] === true) continue;
      proc[guard] = true;
      process.on(signal, () => {
        void this.flushNow().finally(() => process.exit(0));
      });
    }
  }
  async start() {
    await mkdir(this.dataDirPath, { recursive: true });
  }
  /** 该集合是否由 sqlite 后端承载（sqlite 后端下 JSON 例外名单内的集合仍走 JSON）。 */
  usesSqlite(name) {
    if (this.backend !== "sqlite") return false;
    return !this.jsonKeep.some(
      (pattern) => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern
    );
  }
  ensureSqliteBackend() {
    if (!this.sqliteBackend) this.sqliteBackend = new SqliteCollectionBackend(this.dataDirPath);
    return this.sqliteBackend;
  }
  collection(name, options = {}) {
    if (options.durability === "durable") this.durableNames.add(name);
    const existing = this.collections.get(name);
    if (existing) return existing;
    if (this.usesSqlite(name)) {
      this.sqliteNames.add(name);
      const created2 = this.ensureSqliteBackend().collection(name);
      this.collections.set(name, created2);
      return created2;
    }
    const created = new CollectionImpl(name, (n) => this.onPersist(n));
    this.collections.set(name, created);
    return created;
  }
  onPersist(name) {
    if (this.durableNames.has(name)) {
      this.dirty.add(name);
      void this.flushNow();
      return;
    }
    this.markDirty(name);
  }
  /** 启动期从磁盘恢复指定集合（幂等）。坏 JSON 备份为 *.corrupt 后从空集合开始（不再静默清空）。 */
  async restore(name) {
    await mkdir(this.dataDirPath, { recursive: true });
    if (this.usesSqlite(name)) return this.restoreSqlite(name);
    const collection = this.collection(name);
    const file = join(this.dataDirPath, `${fileNameOf(name)}.json`);
    let records = [];
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        records = [];
      } else {
        records = parsed;
      }
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT") {
        records = [];
      } else {
        await this.backupCorrupt(name, file, error);
        records = [];
      }
    }
    ;
    collection.loadFrom(records);
    return collection;
  }
  /**
   * sqlite 后端恢复：DB 为准，首启自动回填同名 JSON 集合文件（文件保留为回滚源）。
   * meta.backfilled_at=NULL 表示导入未完成（上次启动在导入事务提交前崩溃）——重试导入，
   * 导入与标记在 storage-sqlite 的同一事务内原子生效，不会出现「半套数据」。
   * 导入事务内回填后先行对账（条数 + 关键字段哈希，assertBackfillParity）：
   * 不一致即抛错并整体回滚，标记不会落在坏数据上。
   */
  async restoreSqlite(name) {
    const backend = this.ensureSqliteBackend();
    const collection = this.collection(name);
    if (!backend.metaOf(name)) backend.markCreated(name);
    if (backend.metaOf(name)?.backfilled_at !== null) return collection;
    const file = join(this.dataDirPath, `${fileNameOf(name)}.json`);
    let records = [];
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(parsed)) records = parsed;
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT") await this.backupCorrupt(name, file, error);
    }
    backend.backfill(name, records, (rows) => assertBackfillParity(name, records, rows));
    if (records.length > 0) {
      console.log(`[storage] \u96C6\u5408 ${name} \u5DF2\u56DE\u586B ${records.length} \u6761\u81F3 SQLite\uFF08${file} \u4FDD\u7559\u4E3A\u56DE\u6EDA\u6E90\uFF09`);
    }
    return collection;
  }
  /** 损坏 JSON 留痕：备份为 *.corrupt-<ts>，登记 corruptFiles，显式告警（不阻断启动）。 */
  async backupCorrupt(name, file, error) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      await copyFile(file, backup);
    } catch {
    }
    console.error(`[storage] \u96C6\u5408 ${name} \u6587\u4EF6\u635F\u574F\uFF08${error instanceof Error ? error.message : String(error)}\uFF09\uFF0C\u5DF2\u5907\u4EFD\u81F3 ${backup}\uFF0C\u4ECE\u7A7A\u96C6\u5408\u6062\u590D`);
    this.corruptFiles.push(backup);
  }
  /** 扫描数据目录并恢复全部集合（业务插件加载前调用一次）。 */
  async restoreAll() {
    await mkdir(this.dataDirPath, { recursive: true });
    const restored = [];
    const names = new Set(this.backend === "sqlite" ? this.ensureSqliteBackend().names() : []);
    let files = [];
    try {
      files = (await readdir(this.dataDirPath)).filter((file) => file.endsWith(".json"));
    } catch {
      files = [];
    }
    for (const file of files) {
      names.add(decodeFileName(file.slice(0, -5)));
    }
    for (const name of names) {
      try {
        await this.restore(name);
        restored.push(name);
      } catch (error) {
        console.error(`[storage] \u6062\u590D\u96C6\u5408 ${name} \u5931\u8D25`, error);
      }
    }
    return restored;
  }
  /** 已恢复/创建的集合名列表（供平台信息展示）。 */
  names() {
    return [...this.collections.keys()];
  }
  markDirty(name) {
    this.dirty.add(name);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = void 0;
      void this.flushNow();
    }, 250);
  }
  /** 立即将脏集合落盘（原子写：tmp + fsync + rename；全程串行防并发写同名 tmp）。 */
  flushNow() {
    this.flushChain = this.flushChain.then(() => this.doFlush());
    return this.flushChain;
  }
  async doFlush() {
    for (; ; ) {
      const names = [...this.dirty];
      this.dirty.clear();
      if (names.length === 0) return;
      for (const name of names) {
        if (this.sqliteNames.has(name)) continue;
        const collection = this.collections.get(name);
        if (!collection) continue;
        const file = join(this.dataDirPath, `${fileNameOf(name)}.json`);
        const tmp = `${file}.${process.pid}-${Date.now()}-${++this.tmpSeq}.tmp`;
        try {
          await mkdir(dirname(file), { recursive: true });
          const handle = await open(tmp, "w");
          try {
            await handle.writeFile(JSON.stringify(collection.all(), null, 2), "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(tmp, file);
        } catch (error) {
          if (error.code === "ENOENT") {
            console.debug(`[storage] \u96C6\u5408 ${name} \u843D\u76D8 rename \u7ADE\u6001\uFF08ENOENT\uFF0C\u5185\u5B58\u6001\u672A\u5931\uFF0C\u4E0B\u6B21\u843D\u76D8\u6062\u590D\uFF09`);
          } else {
            console.error(`[storage] \u96C6\u5408 ${name} \u843D\u76D8\u5931\u8D25`, error);
          }
        }
      }
    }
  }
  /**
   * 全量强持久化：把所有 JSON 集合写入并 fsync（HTTP 响应前调用，
   * 确保「返回 200 后进程被杀」不丢变更——评审崩溃恢复实验的修复点）。
   * sqlite 集合每次写入已事务提交，天然满足该保证，不在刷盘范围。
   */
  async flushDurable() {
    for (const name of this.collections.keys()) {
      if (!this.sqliteNames.has(name)) this.dirty.add(name);
    }
    await this.flushNow();
  }
}
function fileNameOf(name) {
  return name.replace(/[:*?"<>|]/g, "~");
}
function assertBackfillParity(name, source, rows) {
  if (rows.length !== source.length) {
    throw new Error(t("[storage] \u96C6\u5408 {name} \u56DE\u586B\u5BF9\u8D26\u5931\u8D25\uFF1A\u6761\u6570\u4E0D\u4E00\u81F4\uFF08JSON \u6E90 {json} \u6761 / SQLite \u843D\u5E93 {sql} \u6761\uFF09", { name, json: source.length, sql: rows.length }));
  }
  const sourceHashes = new Map(source.map((record) => [record.id, recordHash(record)]));
  let diff = 0;
  for (const row of rows) {
    const expected = sourceHashes.get(row.id);
    if (expected === void 0 || expected !== recordHash(JSON.parse(row.doc))) diff++;
  }
  if (diff > 0) {
    throw new Error(t("[storage] \u96C6\u5408 {name} \u56DE\u586B\u5BF9\u8D26\u5931\u8D25\uFF1A{count} \u6761\u8BB0\u5F55\u5173\u952E\u5B57\u6BB5\u54C8\u5E0C\u4E0D\u4E00\u81F4", { name, count: diff }));
  }
}
function recordHash(record) {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value).filter(([, item]) => item !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
function decodeFileName(name) {
  return name.replace(/~/g, ":");
}
function parseBackendEnv(value) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "" || normalized === "json") return "json";
  if (normalized === "sqlite" || normalized === "sqlite3" || normalized === "db") return "sqlite";
  console.warn(`[storage] \u672A\u77E5 PLATFORM_STORAGE=${value}\uFF0C\u56DE\u9000 json\uFF08\u53EF\u9009\uFF1Ajson | sqlite\uFF09`);
  return "json";
}
function parseKeepEnv(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
export {
  DEFAULT_JSON_KEEP,
  StorageService
};
