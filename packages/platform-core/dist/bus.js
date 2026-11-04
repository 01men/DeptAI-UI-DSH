import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
const PlatformEvents = {
  UserFrozen: "iam.user.frozen",
  UserActivated: "iam.user.activated",
  UserPasswordReset: "iam.user.password-reset",
  OrgChanged: "iam.org.changed",
  PermissionChanged: "iam.permission.changed",
  TokenIssued: "authn.token.issued",
  TokenRevoked: "authn.token.revoked",
  McpDeployed: "mcp.deployed",
  McpOfflined: "mcp.offlined",
  McpUnhealthy: "mcp.unhealthy",
  McpInvoked: "mcp.invoked",
  // W1-T2（MCP 治理 §6）：Secret Broker 凭证读取留痕（payload 仅 serviceId/credentialRef，绝不带值）
  McpSecretAccess: "mcp.secret.access",
  // 应用外部凭证托管（issue #19）：取值留痕（payload 仅 appId/key/result，绝不带值）
  AppSecretAccess: "app.secret.access",
  // 资产使用凭证（2026-10-31）：Agent 使用 skill/MCP 后主动提报的使用事实（逐次审计订阅落账）
  UsageAssetReported: "usage.asset.reported",
  // 平台工具面调用留痕（2026-11-02）：/mcp 与 /api/tools/execute 每次工具调用的事实（成功与失败，
  // payload 含调用者身份——human PAT 调用 actorId 即成员 userId，审计订阅落 tool.invoke）
  ToolInvoked: "tool.invoked",
  // 连接器纳管（open-connector 融合；前缀已在本文件预留清单）
  ConnectorOddExit: "connector.odd_exit",
  ConnectorPolicyMirrorFailed: "connector.policy_mirror_failed",
  ConnectorPolicySnapshotDrifted: "connector.policy_snapshot_drifted",
  ConnectorGatewayChanged: "connector.gateway.changed",
  ConnectorGatewaySynced: "connector.gateway.synced",
  ConnectorGatewayUnhealthy: "connector.gateway.unhealthy",
  ConnectorConnected: "connector.connected",
  ConnectorDisconnected: "connector.disconnected",
  ConnectorInvoked: "connector.invoked",
  ConnectorPermGroupChanged: "connector.permgroup.changed",
  NasRegistered: "nas.registered",
  NasOnlined: "nas.onlined",
  NasOfflined: "nas.offlined",
  SkillSubmitted: "skill.submitted",
  SkillPublished: "skill.published",
  SkillDeprecated: "skill.deprecated",
  SkillInstalled: "skill.installed",
  SkillUpdated: "skill.updated",
  SkillPackageReplaced: "skill.package_replaced",
  AgentRegistered: "agent.registered",
  AgentOnlined: "agent.onlined",
  AgentOfflined: "agent.offlined",
  AppRegistered: "app.registered",
  AppOnlined: "app.onlined",
  AppOfflined: "app.offlined",
  AppUpdated: "app.updated",
  AppArchived: "app.archived",
  OidcAuthorizeGranted: "oidc.authorize.granted",
  OidcAuthorizeDenied: "oidc.authorize.denied",
  EntryTicketRedeemed: "authn.entryticket.redeemed",
  ApprovalCreated: "approval.created",
  ApprovalDecided: "approval.decided",
  AlertFired: "audit.alert.fired",
  ConnectorSynced: "iam.connector.synced",
  PluginSubmitted: "market.plugin.submitted",
  PluginListed: "market.plugin.listed",
  PluginInstalledEvent: "market.plugin.installed",
  WalletChanged: "wallet.balance.changed",
  LedgerSettled: "billing.ledger.settled",
  ConnectCodeCreated: "connect.code.created",
  ConnectClientEnrolled: "connect.client.enrolled",
  ConnectClientDisabled: "connect.client.disabled",
  UpdateAvailable: "platform.update.available",
  UpdateApplied: "platform.update.applied",
  UpdateRolledBack: "platform.update.rolled_back",
  // 前端行为埋点（WP-03/D3）：独立于 usage 计量管道，audit/看板订阅
  BehaviorRecorded: "behavior.recorded",
  // 部门面板（plugin-panel-core）：消息/任务/行业激活 + 场景图谱热刷新（review-dsh-agent-panel-v2）
  PanelMessageCreated: "panel.message.created",
  PanelCardAction: "panel.card.action",
  PanelTaskUpdated: "panel.task.updated",
  PanelIndustryActivated: "panel.industry.activated",
  ScenegraphUpdated: "scenegraph.updated",
  // 钉钉桥接（plugin-dingtalk-bridge）：出向投递回执（面板据此更新 ddSync 状态）
  DingtalkDelivered: "dingtalk-bridge.delivered",
  // 模型网关治理（IAW 交接 1-2/1-4）：降级链流转与预算阈值告警（面板 SSE 可直接消费）
  ModelgwDegraded: "modelgw.degraded",
  ModelgwBudgetWarning: "modelgw.budget.warning",
  // 场景级授权（IAW 交接 6-1）：策略变更（组织内治理联动）
  IamScenePolicyChanged: "iam.scene_policy.changed",
  // 数据要素域（IAW 交接 2-1..2-4）：数据集/指标字典登记变更
  DatasetChanged: "resource.dataset.changed",
  MetricDefinitionChanged: "resource.metric.changed",
  // 事务流引擎（IAW 交接 3-1，宿主新域 flow）：TF 编排与步骤状态机（面板 SSE 可直接消费）
  FlowCreated: "flow.created",
  FlowStepUpdated: "flow.step.updated",
  FlowCompleted: "flow.completed",
  // TF 停滞告警（C-06）：running 态但 running 步=0——只告警不自动重跑，推进仍须显式调用
  FlowStalled: "flow.stalled",
  FlowTemplateChanged: "flow.template.changed",
  // Agent 域（IAW 交接 7-1）：A2A 跨运行时调用
  AgentA2aInvoked: "agent.a2a.invoked",
  // Agent 冻结联动（R10，2026-10-14）：预算超限冻结（plugin-agent 落 attrs 软态 + 解冻审批）
  AgentFrozen: "agent.frozen",
  AgentUnfrozen: "agent.unfrozen",
  // 执行中枢（ybkk-MATRIX 目标四，2026-10-14）：目标血缘 / 唤醒队列 / run 收尾 / 锁回收 / 心跳 / 例行
  ExecGoalChanged: "exec.goal.changed",
  ExecIssueChanged: "exec.issue.changed",
  ExecWakeEnqueued: "exec.wake.enqueued",
  ExecRunCompleted: "exec.run.completed",
  ExecLockReclaimed: "exec.lock.reclaimed",
  ExecHeartbeatRecorded: "exec.heartbeat.recorded",
  ExecRoutineChanged: "exec.routine.changed",
  // 总线自观察（OPT-P1-04）：监听器异常与死信——丢事件=丢证据，异常必须显式可查
  BusListenerError: "bus.listener_error",
  BusDeadLetter: "bus.dead_letter"
};
const PLATFORM_RESERVED_PREFIXES = [
  "iam.",
  "authn.",
  "oidc.",
  "mcp.",
  "nas.",
  "audit.",
  "skill.",
  "agent.",
  "app.",
  "usage.",
  "billing.",
  "model.",
  "market.",
  "developer.",
  "wallet.",
  "platform.",
  "approval.",
  "connector.",
  "console.",
  "connect.",
  "behavior.",
  // 部门面板 / 场景图谱 / 钉钉桥接（review-dsh-agent-panel-v2 Phase 0）
  "panel.",
  "scenegraph.",
  "dingtalk-bridge.",
  // 模型网关治理 / 事务流引擎 / 数据要素（IAW 交接批次 2026-09-11）
  "modelgw.",
  "flow.",
  "resource.",
  // 执行中枢（2026-10-14）
  "exec."
];
const RING_CAPACITY = 300;
const LISTENER_TIMEOUT_MS = 5e3;
const RETRY_BACKOFF_MS = [50, 200, 800];
const QUEUE_OVERFLOW_CAP = 1e4;
const FEEDBACK_EVENTS = /* @__PURE__ */ new Set([PlatformEvents.BusListenerError, PlatformEvents.BusDeadLetter]);
class PlatformBusService extends Service {
  static provide = "platformBus";
  listeners = /* @__PURE__ */ new Map();
  wildcard = /* @__PURE__ */ new Set();
  seq = 0;
  ring = [];
  // -- 管道状态（OPT-P1-04）：异步串行派发 + journal 持久化 + 死信 ----------------
  queue = [];
  draining = false;
  persistenceReady = false;
  journalFile;
  deadLetterFile;
  deadLetterStore = [];
  journalFailures = 0;
  constructor(ctx, options = {}) {
    super(ctx, "platformBus");
    this.preparePersistence(options.dataDir);
  }
  /**
   * 持久化准备（OPT-P1-04）：journal 追加文件 + 死信文件 + 重启回放。
   * 数据目录来源：显式 options.dataDir 优先；否则取 opsStorage.dataDirPath（精简宿主/单测无存储 → 纯内存运行）。
   * journal 装载最近 RING_CAPACITY 条进 ring（「重启后最近事件仍可回放」），并把 seq 续到历史最大值。
   */
  preparePersistence(explicitDataDir) {
    if (this.persistenceReady) return;
    this.persistenceReady = true;
    let dataDir = explicitDataDir;
    if (!dataDir) {
      try {
        dataDir = this.ctx.opsStorage?.dataDirPath;
      } catch {
        dataDir = void 0;
      }
    }
    if (!dataDir) return;
    this.journalFile = join(dataDir, "bus-journal.jsonl");
    this.deadLetterFile = join(dataDir, "bus-dead-letters.jsonl");
    try {
      const lines = readFileSync(this.journalFile, "utf8").split("\n").filter((line) => line.trim() !== "");
      for (const line of lines.slice(-RING_CAPACITY)) {
        try {
          const event = JSON.parse(line);
          this.ring.push(event);
          if (typeof event.id === "number" && event.id > this.seq) this.seq = event.id;
        } catch {
        }
      }
    } catch {
    }
    try {
      for (const line of readFileSync(this.deadLetterFile, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        try {
          this.deadLetterStore.push(JSON.parse(line));
        } catch {
        }
      }
    } catch {
    }
  }
  /** journal 追加（fail-open：落盘失败计数并 console 告警，不阻断派发、不递归发事件）。 */
  appendJournal(event) {
    if (!this.journalFile) return;
    try {
      appendFileSync(this.journalFile, `${JSON.stringify(event)}
`);
    } catch (error) {
      this.journalFailures++;
      if (this.journalFailures <= 3) console.error("[bus] journal \u8FFD\u52A0\u5931\u8D25\uFF08\u4E8B\u4EF6\u4ECD\u5728 ring/\u961F\u5217\uFF0C\u53EF\u56DE\u653E\u7A97\u53E3\u53D7\u635F\uFF09", error);
    }
  }
  appendDeadLetter(record) {
    this.deadLetterStore.push(record);
    if (!this.deadLetterFile) return;
    try {
      appendFileSync(this.deadLetterFile, `${JSON.stringify(record)}
`);
    } catch (error) {
      console.error("[bus] \u6B7B\u4FE1\u843D\u76D8\u5931\u8D25\uFF08\u5185\u5B58\u6B7B\u4FE1\u4ECD\u53EF\u672C\u8FDB\u7A0B\u5185\u91CD\u6295\uFF09", error);
    }
  }
  on(event, cb) {
    const set = this.listeners.get(event) ?? /* @__PURE__ */ new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return () => set.delete(cb);
  }
  onAny(cb) {
    this.wildcard.add(cb);
    return () => this.wildcard.delete(cb);
  }
  emit(name, payload, options = {}) {
    const source = options.source;
    if (source !== void 0 && source.startsWith("plugin:")) {
      if (!name.startsWith(`${source}:`)) {
        throw new Error(`[bus] \u63D2\u4EF6 ${source} \u4E0D\u5F97\u53D1\u5C04\u975E\u81EA\u6709\u547D\u540D\u7A7A\u95F4\u4E8B\u4EF6\uFF1A${name}\uFF08\u5141\u8BB8\u524D\u7F00 ${source}:\uFF09`);
      }
      if (PLATFORM_RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        throw new Error(`[bus] \u63D2\u4EF6 ${source} \u4E0D\u5F97\u53D1\u5C04\u5E73\u53F0\u4FDD\u7559\u547D\u540D\u7A7A\u95F4\u4E8B\u4EF6\uFF1A${name}`);
      }
    } else if (name.startsWith("plugin:")) {
      const pluginId = name.slice(0, name.indexOf(":", 8) === -1 ? name.length : name.indexOf(":", 8));
      throw new Error(`[bus] \u63D2\u4EF6\u547D\u540D\u7A7A\u95F4\u4E8B\u4EF6 ${name} \u5FC5\u987B\u643A\u5E26\u6765\u6E90\uFF08source: plugin:\u2026\uFF0C\u671F\u671B ${pluginId}\uFF09`);
    }
    const event = { id: ++this.seq, name, payload, at: (/* @__PURE__ */ new Date()).toISOString(), ...source !== void 0 ? { source } : {} };
    this.preparePersistence();
    this.ring.push(event);
    if (this.ring.length > RING_CAPACITY) this.ring.shift();
    this.appendJournal(event);
    this.queue.push(event);
    if (this.queue.length > QUEUE_OVERFLOW_CAP) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.enterDeadLetter(dropped, "*", "backpressure_overflow\uFF1A\u6D3E\u53D1\u961F\u5217\u8D8A\u9650\uFF08\u4E8B\u4EF6\u5DF2\u5165 journal \u53EF\u56DE\u653E\uFF09", 0);
      }
    }
    this.scheduleDrain();
    return event;
  }
  /** 最近事件（平台事件流展示用；重启后由 journal 回放装载，仍是最近 RING_CAPACITY 条）。 */
  recent(limit = 50) {
    return this.ring.slice(-limit).reverse();
  }
  /** 死信清单（OPT-P1-04）：含重启前遗留（持久化于 bus-dead-letters.jsonl）。 */
  deadLetters() {
    return [...this.deadLetterStore];
  }
  /**
   * 人工重投（OPT-P1-04）：按原事件名逐条重发（at-least-once）。
   * QA C-02 修正：不再「先清空再重发」——一条不可重投的事件（如丢失 source 的 plugin:
   * 事件，emit 校验即抛）不再连带丢弃其余死信；仅成功重发的移出，失败的原地保留。
   * ⚠ 口径与 usage 消费水位不同：总线无每监听器水位，重投会对已成功的监听器重复投递，
   * 消费方需自行幂等（审计/投影类消费方按事件 id 去重）。重投中再失败的监听器自然重新入死信。
   */
  retryDeadLetters() {
    const records = [...this.deadLetterStore];
    let redelivered = 0;
    const retained = [];
    for (const record of records) {
      try {
        this.emit(record.eventName, record.payload, record.source !== void 0 ? { source: record.source } : {});
        redelivered++;
      } catch (error) {
        retained.push({ ...record, error: `${record.error}\uFF1B\u91CD\u6295\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}` });
      }
    }
    this.deadLetterStore = retained;
    if (this.deadLetterFile) {
      try {
        writeFileSync(this.deadLetterFile, retained.map((record) => JSON.stringify(record)).join("\n") + (retained.length > 0 ? "\n" : ""), "utf8");
      } catch {
      }
    }
    return { attempted: records.length, redelivered, retained: retained.length };
  }
  /** 死信入账 + 告警事件（bus.dead_letter）。suppressAlert 时仅入账不回发事件（回授断路，QA C-01）。 */
  enterDeadLetter(event, listener, error, attempts, options = {}) {
    const record = {
      id: `bdl-${randomUUID()}`,
      eventName: event.name,
      payload: event.payload,
      listener,
      error,
      attempts,
      at: (/* @__PURE__ */ new Date()).toISOString(),
      ...event.source !== void 0 ? { source: event.source } : {}
    };
    this.appendDeadLetter(record);
    if (options.suppressAlert) return;
    this.emit(PlatformEvents.BusDeadLetter, record);
  }
  scheduleDrain() {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      void this.drain();
    });
  }
  async drain() {
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        if (!event) break;
        await this.deliver(event);
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) this.scheduleDrain();
    }
  }
  /**
   * 单事件派发（C-05）：事件间仍按队列 FIFO 串行（drain 逐事件等待 allSettled），
   * 同一事件的各监听器并发隔离——单监听器失败/挂起（至多 LISTENER_TIMEOUT_MS）不再拖慢
   * 同事件其他监听器；每监听器超时/异常按次计失败，指数退避重试 3 次后入死信（既有语义不变）。
   */
  async deliver(event) {
    const targets = [];
    for (const cb of this.listeners.get(event.name) ?? []) targets.push({ cb, label: event.name });
    for (const cb of this.wildcard) targets.push({ cb, label: "*" });
    await Promise.allSettled(targets.map(({ cb, label }) => this.deliverToOne(event, cb, label)));
  }
  /** 单监听器派发链：失败逐次落 bus.listener_error（回授断路见 FEEDBACK_EVENTS），重试耗尽入死信。 */
  async deliverToOne(event, cb, label) {
    for (let attempt = 1; attempt <= RETRY_BACKOFF_MS.length + 1; attempt++) {
      try {
        await withTimeout(Promise.resolve(cb(event.payload, event)), LISTENER_TIMEOUT_MS);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[bus] \u76D1\u542C\u5668\u5904\u7406 ${event.name}\uFF08${label}\uFF09\u7B2C ${attempt} \u6B21\u5931\u8D25`, error);
        if (FEEDBACK_EVENTS.has(event.name)) {
          this.enterDeadLetter(event, label, `\u53CD\u9988\u4E8B\u4EF6\u76D1\u542C\u5668\u5931\u8D25\uFF08\u4E0D\u56DE\u6388\uFF0CQA C-01\uFF09\uFF1A${message}`, attempt, { suppressAlert: true });
          return;
        }
        this.emit(PlatformEvents.BusListenerError, { event: event.name, listener: label, attempt, error: message, at: (/* @__PURE__ */ new Date()).toISOString() });
        if (attempt <= RETRY_BACKOFF_MS.length) {
          await sleep(RETRY_BACKOFF_MS[attempt - 1]);
        } else {
          this.enterDeadLetter(event, label, `3 \u6B21\u91CD\u8BD5\u5747\u5931\u8D25\uFF1A${message}`, attempt);
        }
      }
    }
  }
}
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`\u76D1\u542C\u5668\u8D85\u65F6\uFF08>${ms}ms\uFF09`)), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export {
  PlatformBusService,
  PlatformEvents
};
