import { Service } from "@deepseek-ai/cordis";
import { newId } from "./ids.js";
import { t } from "../../platform-i18n/dist/index.js";
const BEHAVIOR_SCHEMA = "behavior.recorded";
const BEHAVIOR_SCHEMA_VERSION = 1;
const PAYLOAD_MAX_BYTES = 4096;
const DEFAULT_TENANT = "t_default";
function behaviorRow(event) {
  return {
    id: event.event_id,
    idempotency_key: event.idempotency_key,
    schema_version: event.schema_version,
    occurred_at: event.occurred_at,
    tenant_id: event.tenant_id,
    org: event.org ?? "",
    subject: event.subject,
    type: event.type,
    platform: event.platform ?? "",
    payload_json: JSON.stringify(event.payload ?? {}),
    trace_id: event.trace_id ?? ""
  };
}
function rowToEvent(row) {
  return {
    schema: BEHAVIOR_SCHEMA,
    schema_version: row.schema_version,
    event_id: row.id,
    idempotency_key: row.idempotency_key,
    occurred_at: row.occurred_at,
    tenant_id: row.tenant_id,
    ...row.org !== "" ? { org: row.org } : {},
    subject: row.subject,
    type: row.type,
    ...row.platform !== "" ? { platform: row.platform } : {},
    ...row.payload_json !== "{}" ? { payload: JSON.parse(row.payload_json) } : {},
    ...row.trace_id !== "" ? { trace_id: row.trace_id } : {}
  };
}
class BehaviorService extends Service {
  static provide = "behavior";
  static inject = ["txnStore", "platformBus", "httpServer"];
  consumers = /* @__PURE__ */ new Map();
  seq = 0;
  constructor(ctx) {
    super(ctx, "behavior");
    ctx.txnStore.ensureTable("behavior_events", {
      id: "TEXT",
      idempotency_key: "TEXT NOT NULL",
      schema_version: "INTEGER NOT NULL",
      occurred_at: "TEXT NOT NULL",
      tenant_id: "TEXT NOT NULL",
      org: "TEXT NOT NULL DEFAULT ''",
      subject: "TEXT NOT NULL",
      type: "TEXT NOT NULL",
      platform: "TEXT NOT NULL DEFAULT ''",
      payload_json: "TEXT NOT NULL",
      trace_id: "TEXT NOT NULL DEFAULT ''"
    }, { uniques: [["idempotency_key"]], indexes: [["occurred_at"], ["type"], ["subject"]] });
    ctx.txnStore.ensureTable("behavior_consumptions", {
      consumer: "TEXT NOT NULL",
      event_id: "TEXT NOT NULL",
      at: "TEXT NOT NULL"
    }, { primaryKey: ["consumer", "event_id"] });
    this.registerHttpEndpoints(ctx);
    ctx.effect(() => () => {
      this.consumers.clear();
    });
  }
  /** write-only 采集（公开路由挂 console 鉴权中间件之后；此处再校验主体，双层 fail-closed）。 */
  registerHttpEndpoints(ctx) {
    const http = ctx.httpServer;
    http.register("POST", "/api/behavior/events", (exchange) => {
      const principal = exchange.principal;
      if (!principal || !Array.isArray(principal.permissions)) {
        exchange.fail(401, "UNAUTHORIZED", t("\u7F3A\u5C11 Bearer \u4EE4\u724C\uFF0C\u8BF7\u5148\u767B\u5F55"));
        return;
      }
      const input = exchange.body ?? {};
      const subject = principal.userId ? `user:${principal.userId}` : `${principal.kind ?? "machine"}:${principal.principalId ?? "unknown"}`;
      try {
        const result = this.record({ ...input, subject });
        exchange.ok({ event: result.event, duplicated: result.duplicated });
      } catch (error) {
        exchange.fail(400, "BAD_REQUEST", error instanceof Error ? error.message : String(error));
      }
    }, { access: "authenticated" });
    http.register("GET", "/api/behavior/events", (exchange) => {
      const principal = exchange.principal;
      if (!principal || !Array.isArray(principal.permissions)) {
        exchange.fail(401, "UNAUTHORIZED", t("\u7F3A\u5C11 Bearer \u4EE4\u724C\uFF0C\u8BF7\u5148\u767B\u5F55"));
        return;
      }
      if (!principal.permissions.includes("*") && !principal.permissions.includes("audit.read")) {
        ctx.platformBus.emit("audit.authz.denied", {
          actorId: exchange.principal.userId,
          point: "audit.read",
          path: exchange.path
        });
        exchange.fail(403, "FORBIDDEN", t("\u7F3A\u5C11\u6743\u9650\u70B9 {point}\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u8C03\u6574\u89D2\u8272", { point: "audit.read" }), { permission: "audit.read" });
        return;
      }
      const query = exchange.query;
      exchange.ok(this.query({
        ...query.get("type") ? { type: query.get("type") } : {},
        ...query.get("subject") ? { subject: query.get("subject") } : {},
        ...query.get("from") ? { from: query.get("from") } : {},
        ...query.get("to") ? { to: query.get("to") } : {},
        ...query.get("limit") ? { limit: Number(query.get("limit")) } : {}
      }));
    }, { access: "guarded", permission: "audit.read" });
  }
  /** 全平台唯一行为事件入口：校验 → 落库（幂等）→ 总线分发。返回 duplicated 标识幂等重放。 */
  record(input) {
    this.validate(input);
    const event = {
      schema: BEHAVIOR_SCHEMA,
      schema_version: BEHAVIOR_SCHEMA_VERSION,
      event_id: newId("bevt"),
      idempotency_key: input.idempotency_key ?? `behavior:${input.subject}:${input.type}:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 16)}:${++this.seq}`,
      occurred_at: input.occurred_at ?? (/* @__PURE__ */ new Date()).toISOString(),
      tenant_id: DEFAULT_TENANT,
      ...input.org ? { org: input.org } : {},
      subject: input.subject,
      type: input.type,
      ...input.platform ? { platform: input.platform } : {},
      ...input.payload !== void 0 ? { payload: input.payload } : {},
      ...input.trace_id !== void 0 ? { trace_id: input.trace_id } : {}
    };
    const inserted = this.ctx.txnStore.insertOrIgnore("behavior_events", behaviorRow(event));
    if (!inserted) {
      const existing = this.ctx.txnStore.one("behavior_events", { idempotency_key: event.idempotency_key });
      if (!existing) throw new Error(t("\u5E42\u7B49\u952E\u5F02\u5E38\uFF1A{key} \u5DF2\u5360\u7528\u4F46\u8BB0\u5F55\u7F3A\u5931", { key: event.idempotency_key }));
      const sameContent = existing.subject === event.subject && existing.type === event.type && existing.payload_json === JSON.stringify(event.payload ?? {});
      if (!sameContent) {
        throw new Error(t("\u5E42\u7B49\u952E\u51B2\u7A81\uFF1A{key} \u5DF2\u7ED1\u5B9A\u4E8B\u4EF6 {id}\uFF0C\u540C\u952E\u4E0D\u540C\u5185\u5BB9\u88AB\u62D2\u7EDD", { key: event.idempotency_key, id: existing.id }));
      }
      return { event: rowToEvent(existing), duplicated: true };
    }
    this.dispatch(event);
    return { event, duplicated: false };
  }
  /** 注册消费方（at-least-once；3 次失败入死信）。 */
  consume(consumerId, handler) {
    this.consumers.set(consumerId, { handler, attempts: /* @__PURE__ */ new Map() });
    return () => this.consumers.delete(consumerId);
  }
  /**
   * 分发：先总线广播，再逐消费方按水位投递（insertOrIgnore 占位 → 3 次失败入死信并告警）。
   * 与 usage 同款「效果恰好一次」：重放/重投经水位幂等跳过。
   */
  dispatch(event) {
    this.ctx.platformBus.emit(BEHAVIOR_SCHEMA, event);
    for (const [consumerId, entry] of this.consumers) {
      const claimed = this.ctx.txnStore.insertOrIgnore("behavior_consumptions", {
        consumer: consumerId,
        event_id: event.event_id,
        at: (/* @__PURE__ */ new Date()).toISOString()
      });
      if (!claimed) continue;
      let delivered = false;
      for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
        try {
          entry.handler(event);
          entry.attempts.delete(`${consumerId}:${event.event_id}`);
          delivered = true;
        } catch (error) {
          if (attempt < 3) continue;
          this.ctx.txnStore.run("DELETE FROM behavior_consumptions WHERE consumer = ? AND event_id = ?", [consumerId, event.event_id]);
          this.deadLetters().insert({
            id: newId("bdl"),
            event_id: event.event_id,
            consumer: consumerId,
            error: error instanceof Error ? error.message : String(error),
            attempts: attempt
          });
          this.ctx.platformBus.emit("audit.alert.fired", {
            id: newId("alt"),
            severity: "critical",
            title: t("behavior \u6D88\u8D39\u6B7B\u4FE1"),
            message: t("\u6D88\u8D39\u65B9 {consumer} \u5904\u7406\u884C\u4E3A\u4E8B\u4EF6 {id} \u8FDE\u7EED\u5931\u8D25 {attempts} \u6B21\uFF0C\u5DF2\u5165\u6B7B\u4FE1\uFF0C\u53EF\u7ECF behavior \u91CD\u6295\u6062\u590D", { consumer: consumerId, id: event.event_id, attempts: attempt })
          });
        }
      }
    }
  }
  /** 重放窗口内事件（消费水位保证幂等）。 */
  replay(sinceIso) {
    const rows = this.ctx.txnStore.sql(
      "SELECT * FROM behavior_events WHERE occurred_at >= ? ORDER BY occurred_at",
      [sinceIso]
    );
    for (const row of rows) this.dispatch(rowToEvent(row));
    return { replayed: rows.length };
  }
  /** 死信重投：成功即移出死信队列。返回 {retried, remaining}。 */
  retryDeadLetters() {
    const letters = this.deadLetters().all();
    let retried = 0;
    for (const letter of letters) {
      const row = this.ctx.txnStore.one("behavior_events", { id: letter.event_id });
      if (!row) {
        this.deadLetters().remove(letter.id);
        continue;
      }
      const consumer = this.consumers.get(letter.consumer);
      if (!consumer) continue;
      this.deadLetters().remove(letter.id);
      try {
        const claimed = this.ctx.txnStore.insertOrIgnore("behavior_consumptions", {
          consumer: letter.consumer,
          event_id: letter.event_id,
          at: (/* @__PURE__ */ new Date()).toISOString()
        });
        if (!claimed) {
          retried++;
          continue;
        }
        consumer.handler(rowToEvent(row));
        retried++;
      } catch (error) {
        this.deadLetters().insert({
          id: newId("bdl"),
          event_id: letter.event_id,
          consumer: letter.consumer,
          error: t("\u91CD\u6295\u4ECD\u5931\u8D25\uFF1A{message}", { message: error instanceof Error ? error.message : String(error) }),
          attempts: letter.attempts + 1
        });
      }
    }
    return { retried, remaining: this.deadLetters().count() };
  }
  /** 只读查询（审计/看板订阅面，GET 端点 audit.read 门禁）。 */
  query(filter = {}) {
    const conditions = [];
    const params = [];
    if (filter.type) {
      conditions.push("type = ?");
      params.push(filter.type);
    }
    if (filter.subject) {
      conditions.push("subject = ?");
      params.push(filter.subject);
    }
    if (filter.from) {
      conditions.push("occurred_at >= ?");
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push("occurred_at <= ?");
      params.push(filter.to);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.ctx.txnStore.sql(`SELECT * FROM behavior_events${where} ORDER BY occurred_at DESC LIMIT ?`, [...params, Math.min(filter.limit ?? 100, 1e3)]);
    const total = Number((this.ctx.txnStore.sql(`SELECT COUNT(*) AS n FROM behavior_events${where}`, params)[0] ?? { n: 0 }).n);
    return { total, items: rows.map(rowToEvent) };
  }
  deadLetters() {
    return this.ctx.opsStorage.collection("behavior:deadLetters");
  }
  // -- 内部 -----------------------------------------------------------------
  validate(input) {
    if (!input.type?.trim() || !/^[a-z][a-z0-9_.]*$/.test(input.type)) {
      throw new Error(t("behavior \u4E8B\u4EF6 type \u975E\u6CD5\uFF1A{value}\uFF08\u5E94\u4E3A\u70B9\u5206\u5C0F\u5199\u952E\uFF0C\u5982 card.exposed / funnel.step\uFF09", { value: String(input.type) }));
    }
    if (!input.subject?.trim() || !/^[a-z][a-z0-9]*:[A-Za-z0-9._-]+$/.test(input.subject)) {
      throw new Error(t("behavior \u4E8B\u4EF6 subject \u975E\u6CD5\uFF1A{value}\uFF08\u5E94\u4E3A user:<id> / agent:<id> / machine:<principalId>\uFF09", { value: String(input.subject) }));
    }
    if (input.platform !== void 0 && !/^[a-z][a-z0-9_-]*$/.test(input.platform)) {
      throw new Error(t("behavior \u4E8B\u4EF6 platform \u975E\u6CD5\uFF1A{value}\uFF08\u5C0F\u5199\u6807\u8BC6\uFF0C\u5982 rd / quality / console / dingtalk\uFF09", { value: input.platform }));
    }
    if (input.payload !== void 0) {
      if (typeof input.payload !== "object" || Array.isArray(input.payload) || input.payload === null) {
        throw new Error(t("behavior \u4E8B\u4EF6 payload \u5FC5\u987B\u662F\u5BF9\u8C61"));
      }
      if (Buffer.byteLength(JSON.stringify(input.payload), "utf8") > PAYLOAD_MAX_BYTES) {
        throw new Error(t("behavior \u4E8B\u4EF6 payload \u8D85\u9650\uFF08>{max} \u5B57\u8282\uFF09\uFF0C\u8BF7\u7CBE\u7B80\u4E0A\u4E0B\u6587", { max: PAYLOAD_MAX_BYTES }));
      }
    }
    if (input.occurred_at !== void 0 && Number.isNaN(new Date(input.occurred_at).getTime())) {
      throw new Error(t("behavior \u4E8B\u4EF6 occurred_at \u975E\u6CD5\uFF1A{value}", { value: input.occurred_at }));
    }
  }
}
export {
  BEHAVIOR_SCHEMA,
  BEHAVIOR_SCHEMA_VERSION,
  BehaviorService
};
