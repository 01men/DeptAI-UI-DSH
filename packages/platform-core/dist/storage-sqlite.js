import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../platform-i18n/dist/index.js";
class SqliteCollectionBackend {
  db;
  file;
  collections = /* @__PURE__ */ new Map();
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "collections.db");
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS collection_docs (
      name TEXT NOT NULL,
      id TEXT NOT NULL,
      doc TEXT NOT NULL,
      PRIMARY KEY (name, id)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS collection_uniques (
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      key TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (name, label, key)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS collection_meta (
      name TEXT PRIMARY KEY,
      backfilled_at TEXT,
      created_at TEXT NOT NULL
    )`);
  }
  /** 事务：fn 内全部写入原子提交（BEGIN IMMEDIATE 立即取写锁，避免升级死锁）。 */
  txn(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  collection(name) {
    const existing = this.collections.get(name);
    if (existing) return existing;
    const created = new SqliteCollectionImpl(this, name);
    this.collections.set(name, created);
    return created;
  }
  /** 已登记集合名（meta 表，含回填过的与新建的）。 */
  names() {
    return this.db.prepare("SELECT name FROM collection_meta ORDER BY name").all().map((row) => row.name);
  }
  metaOf(name) {
    return this.db.prepare("SELECT backfilled_at FROM collection_meta WHERE name = ?").get(name);
  }
  markCreated(name) {
    this.db.prepare("INSERT OR IGNORE INTO collection_meta (name, backfilled_at, created_at) VALUES (?, NULL, ?)").run(name, (/* @__PURE__ */ new Date()).toISOString());
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
  backfill(name, records, verify) {
    this.txn(() => {
      const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM collection_docs WHERE name = ?").get(name).n);
      if (count === 0) {
        const ins = this.db.prepare("INSERT INTO collection_docs (name, id, doc) VALUES (?, ?, ?)");
        for (const record of records) ins.run(name, record.id, JSON.stringify(record));
      }
      if (verify) verify(this.db.prepare("SELECT id, doc FROM collection_docs WHERE name = ? ORDER BY id").all(name));
      this.db.prepare("UPDATE collection_meta SET backfilled_at = ? WHERE name = ?").run((/* @__PURE__ */ new Date()).toISOString(), name);
    });
  }
  close() {
    try {
      this.db.close();
    } catch {
    }
  }
}
class SqliteCollectionImpl {
  uniques = [];
  listeners = /* @__PURE__ */ new Set();
  backend;
  name;
  constructor(backend, name) {
    this.backend = backend;
    this.name = name;
    this.backend.markCreated(name);
  }
  get db() {
    return this.backend.db;
  }
  txn(fn) {
    return this.backend.txn(fn);
  }
  uniqueOn(label, keyOf) {
    if (this.uniques.some((unique) => unique.label === label)) return;
    this.uniques.push({ label, keyOf });
    const rows = this.db.prepare("SELECT id, doc FROM collection_docs WHERE name = ?").all(this.name);
    this.txn(() => {
      this.db.prepare("DELETE FROM collection_uniques WHERE name = ? AND label = ?").run(this.name, label);
      const ins = this.db.prepare("INSERT OR IGNORE INTO collection_uniques (name, label, key, id) VALUES (?, ?, ?, ?)");
      for (const row of rows) {
        const key = keyOf(JSON.parse(row.doc));
        if (key) ins.run(this.name, label, key, row.id);
      }
    });
  }
  /** 唯一约束执行（引擎级）：update 时先移除自身旧键再占新键，冲突即抛（事务回滚）。 */
  enforceUniques(record, selfId) {
    for (const unique of this.uniques) {
      const key = unique.keyOf(record);
      if (!key) continue;
      if (selfId !== void 0) {
        this.db.prepare("DELETE FROM collection_uniques WHERE name = ? AND label = ? AND id = ?").run(this.name, unique.label, selfId);
      }
      try {
        this.db.prepare("INSERT INTO collection_uniques (name, label, key, id) VALUES (?, ?, ?, ?)").run(this.name, unique.label, key, record.id);
      } catch {
        const other = this.db.prepare("SELECT id FROM collection_uniques WHERE name = ? AND label = ? AND key = ?").get(this.name, unique.label, key);
        throw new Error(t("[storage] \u552F\u4E00\u7EA6\u675F\u51B2\u7A81\uFF08{label}\uFF09\uFF1A\u4E0E\u65E2\u6709\u8BB0\u5F55 {id} \u91CD\u590D", { label: unique.label, id: other?.id ?? "?" }));
      }
    }
  }
  all() {
    const rows = this.db.prepare("SELECT doc FROM collection_docs WHERE name = ? ORDER BY rowid").all(this.name);
    return rows.map((row) => JSON.parse(row.doc));
  }
  get(id) {
    const row = this.db.prepare("SELECT doc FROM collection_docs WHERE name = ? AND id = ?").get(this.name, id);
    return row ? JSON.parse(row.doc) : void 0;
  }
  find(pred) {
    return this.all().filter(pred);
  }
  findOne(pred) {
    for (const record of this.all()) {
      if (pred(record)) return record;
    }
    return void 0;
  }
  insert(data) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const record = { createdAt: now, updatedAt: now, ...data, updatedAt: now };
    this.txn(() => {
      const exists = this.db.prepare("SELECT 1 FROM collection_docs WHERE name = ? AND id = ?").get(this.name, record.id);
      if (exists) throw new Error(t("[storage] \u96C6\u5408 {name} \u4E2D\u5DF2\u5B58\u5728 id={id}", { name: this.name, id: record.id }));
      this.enforceUniques(record);
      this.db.prepare("INSERT INTO collection_docs (name, id, doc) VALUES (?, ?, ?)").run(this.name, record.id, JSON.stringify(record));
    });
    this.emit({ kind: "insert", record });
    return structuredClone(record);
  }
  update(id, patch) {
    const current = this.get(id);
    if (!current) throw new Error(t("[storage] \u96C6\u5408 {name} \u4E2D\u4E0D\u5B58\u5728 id={id}", { name: this.name, id }));
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    this.txn(() => {
      this.enforceUniques(next, id);
      this.db.prepare("UPDATE collection_docs SET doc = ? WHERE name = ? AND id = ?").run(JSON.stringify(next), this.name, id);
    });
    this.emit({ kind: "update", record: next });
    return structuredClone(next);
  }
  remove(id) {
    let existed = false;
    this.txn(() => {
      const info = this.db.prepare("DELETE FROM collection_docs WHERE name = ? AND id = ?").run(this.name, id);
      existed = Number(info.changes) > 0;
      if (existed) this.db.prepare("DELETE FROM collection_uniques WHERE name = ? AND id = ?").run(this.name, id);
    });
    if (existed) this.emit({ kind: "remove", record: { id } });
    return existed;
  }
  replaceAll(records) {
    this.txn(() => {
      this.db.prepare("DELETE FROM collection_docs WHERE name = ?").run(this.name);
      this.db.prepare("DELETE FROM collection_uniques WHERE name = ?").run(this.name);
      const ins = this.db.prepare("INSERT INTO collection_docs (name, id, doc) VALUES (?, ?, ?)");
      const insKey = this.db.prepare("INSERT OR IGNORE INTO collection_uniques (name, label, key, id) VALUES (?, ?, ?, ?)");
      for (const record of records) {
        ins.run(this.name, record.id, JSON.stringify(record));
        for (const unique of this.uniques) {
          const key = unique.keyOf(record);
          if (key) insKey.run(this.name, unique.label, key, record.id);
        }
      }
    });
    this.emit({ kind: "replace", record: {} });
  }
  count() {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM collection_docs WHERE name = ?").get(this.name).n);
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
export {
  SqliteCollectionBackend,
  SqliteCollectionImpl
};
