/**
 * 平台事件总线：插件协作的唯一胶水。
 * 原则：状态变更必发事件；跨插件联动只许通过事件或扩展点，禁止直连对方数据。
 *
 * 事件源校验（生态设计 v1.2 第 3 步，S3/F3 消解）：
 *   - 平台命名空间事件（iam.* / authn.* / mcp.* …）只允许平台内部发射——
 *     携带 plugin: 来源的发射一律拒绝，杜绝第三方插件伪造平台事件；
 *   - 第三方插件事件必须收敛在 plugin:<id>: 前缀内，且 source 必须与插件身份一致；
 *   - 校验落点在本总线（独立自实现 pub/sub，不经 cordis 事件系统），
 *     配合轻量代理 ctx（plugin-ctx.ts）与 lint/静态扫描三层防线。
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

export interface PlatformEvent {
  id: number
  name: string
  payload: unknown
  at: string
  /** 事件来源：缺省=平台内部；plugin:<id>=第三方插件（强制与事件名前缀一致）。 */
  source?: string
}

export type BusListener = (payload: unknown, event: PlatformEvent) => void

/** 平台级事件名常量（与各插件 manifest/events.yaml 对应）。 */
export const PlatformEvents = {
  UserFrozen: 'iam.user.frozen',
  UserActivated: 'iam.user.activated',
  UserPasswordReset: 'iam.user.password-reset',
  OrgChanged: 'iam.org.changed',
  PermissionChanged: 'iam.permission.changed',
  TokenIssued: 'authn.token.issued',
  TokenRevoked: 'authn.token.revoked',
  McpDeployed: 'mcp.deployed',
  McpOfflined: 'mcp.offlined',
  McpUnhealthy: 'mcp.unhealthy',
  McpInvoked: 'mcp.invoked',
  // W1-T2（MCP 治理 §6）：Secret Broker 凭证读取留痕（payload 仅 serviceId/credentialRef，绝不带值）
  McpSecretAccess: 'mcp.secret.access',
  // 应用外部凭证托管（issue #19）：取值留痕（payload 仅 appId/key/result，绝不带值）
  AppSecretAccess: 'app.secret.access',
  // 资产使用凭证（2026-10-31）：Agent 使用 skill/MCP 后主动提报的使用事实（逐次审计订阅落账）
  UsageAssetReported: 'usage.asset.reported',
  // 连接器纳管（open-connector 融合；前缀已在本文件预留清单）
  ConnectorOddExit: 'connector.odd_exit',
  ConnectorPolicyMirrorFailed: 'connector.policy_mirror_failed',
  ConnectorPolicySnapshotDrifted: 'connector.policy_snapshot_drifted',
  ConnectorGatewayChanged: 'connector.gateway.changed',
  ConnectorGatewaySynced: 'connector.gateway.synced',
  ConnectorGatewayUnhealthy: 'connector.gateway.unhealthy',
  ConnectorConnected: 'connector.connected',
  ConnectorDisconnected: 'connector.disconnected',
  ConnectorInvoked: 'connector.invoked',
  ConnectorPermGroupChanged: 'connector.permgroup.changed',
  NasRegistered: 'nas.registered',
  NasOnlined: 'nas.onlined',
  NasOfflined: 'nas.offlined',
  SkillSubmitted: 'skill.submitted',
  SkillPublished: 'skill.published',
  SkillDeprecated: 'skill.deprecated',
  SkillInstalled: 'skill.installed',
  SkillUpdated: 'skill.updated',
  SkillPackageReplaced: 'skill.package_replaced',
  AgentRegistered: 'agent.registered',
  AgentOnlined: 'agent.onlined',
  AgentOfflined: 'agent.offlined',
  AppRegistered: 'app.registered',
  AppOnlined: 'app.onlined',
  AppOfflined: 'app.offlined',
  AppUpdated: 'app.updated',
  AppArchived: 'app.archived',
  OidcAuthorizeGranted: 'oidc.authorize.granted',
  OidcAuthorizeDenied: 'oidc.authorize.denied',
  EntryTicketRedeemed: 'authn.entryticket.redeemed',
  ApprovalCreated: 'approval.created',
  ApprovalDecided: 'approval.decided',
  AlertFired: 'audit.alert.fired',
  ConnectorSynced: 'iam.connector.synced',
  PluginSubmitted: 'market.plugin.submitted',
  PluginListed: 'market.plugin.listed',
  PluginInstalledEvent: 'market.plugin.installed',
  WalletChanged: 'wallet.balance.changed',
  LedgerSettled: 'billing.ledger.settled',
  ConnectCodeCreated: 'connect.code.created',
  ConnectClientEnrolled: 'connect.client.enrolled',
  ConnectClientDisabled: 'connect.client.disabled',
  UpdateAvailable: 'platform.update.available',
  UpdateApplied: 'platform.update.applied',
  UpdateRolledBack: 'platform.update.rolled_back',
  // 前端行为埋点（WP-03/D3）：独立于 usage 计量管道，audit/看板订阅
  BehaviorRecorded: 'behavior.recorded',
  // 部门面板（plugin-panel-core）：消息/任务/行业激活 + 场景图谱热刷新（review-dsh-agent-panel-v2）
  PanelMessageCreated: 'panel.message.created',
  PanelCardAction: 'panel.card.action',
  PanelTaskUpdated: 'panel.task.updated',
  PanelIndustryActivated: 'panel.industry.activated',
  ScenegraphUpdated: 'scenegraph.updated',
  // 钉钉桥接（plugin-dingtalk-bridge）：出向投递回执（面板据此更新 ddSync 状态）
  DingtalkDelivered: 'dingtalk-bridge.delivered',
  // 模型网关治理（IAW 交接 1-2/1-4）：降级链流转与预算阈值告警（面板 SSE 可直接消费）
  ModelgwDegraded: 'modelgw.degraded',
  ModelgwBudgetWarning: 'modelgw.budget.warning',
  // 场景级授权（IAW 交接 6-1）：策略变更（组织内治理联动）
  IamScenePolicyChanged: 'iam.scene_policy.changed',
  // 数据要素域（IAW 交接 2-1..2-4）：数据集/指标字典登记变更
  DatasetChanged: 'resource.dataset.changed',
  MetricDefinitionChanged: 'resource.metric.changed',
  // 事务流引擎（IAW 交接 3-1，宿主新域 flow）：TF 编排与步骤状态机（面板 SSE 可直接消费）
  FlowCreated: 'flow.created',
  FlowStepUpdated: 'flow.step.updated',
  FlowCompleted: 'flow.completed',
  // TF 停滞告警（C-06）：running 态但 running 步=0——只告警不自动重跑，推进仍须显式调用
  FlowStalled: 'flow.stalled',
  FlowTemplateChanged: 'flow.template.changed',
  // Agent 域（IAW 交接 7-1）：A2A 跨运行时调用
  AgentA2aInvoked: 'agent.a2a.invoked',
  // Agent 冻结联动（R10，2026-10-14）：预算超限冻结（plugin-agent 落 attrs 软态 + 解冻审批）
  AgentFrozen: 'agent.frozen',
  AgentUnfrozen: 'agent.unfrozen',
  // 执行中枢（ybkk-MATRIX 目标四，2026-10-14）：目标血缘 / 唤醒队列 / run 收尾 / 锁回收 / 心跳 / 例行
  ExecGoalChanged: 'exec.goal.changed',
  ExecIssueChanged: 'exec.issue.changed',
  ExecWakeEnqueued: 'exec.wake.enqueued',
  ExecRunCompleted: 'exec.run.completed',
  ExecLockReclaimed: 'exec.lock.reclaimed',
  ExecHeartbeatRecorded: 'exec.heartbeat.recorded',
  ExecRoutineChanged: 'exec.routine.changed',
  // 总线自观察（OPT-P1-04）：监听器异常与死信——丢事件=丢证据，异常必须显式可查
  BusListenerError: 'bus.listener_error',
  BusDeadLetter: 'bus.dead_letter',
} as const

/** 平台保留命名空间：第三方插件（source=plugin:*）禁止发射。 */
const PLATFORM_RESERVED_PREFIXES = [
  'iam.', 'authn.', 'oidc.', 'mcp.', 'nas.', 'audit.', 'skill.', 'agent.', 'app.',
  'usage.', 'billing.', 'model.', 'market.', 'developer.', 'wallet.',
  'platform.', 'approval.', 'connector.', 'console.', 'connect.', 'behavior.',
  // 部门面板 / 场景图谱 / 钉钉桥接（review-dsh-agent-panel-v2 Phase 0）
  'panel.', 'scenegraph.', 'dingtalk-bridge.',
  // 模型网关治理 / 事务流引擎 / 数据要素（IAW 交接批次 2026-09-11）
  'modelgw.', 'flow.', 'resource.',
  // 执行中枢（2026-10-14）
  'exec.',
]

// -- 总线管道参数（OPT-P1-04：对齐 usage 管道水准——持久化/重试/死信/异常落审计） --------
/** 内存 ring 容量（journal 已持久化全量，ring 仅为热缓存）。 */
const RING_CAPACITY = 300
/** 单监听器派发超时：超时按一次失败计，重试后仍超时入死信。 */
const LISTENER_TIMEOUT_MS = 5_000
/** 失败重试退避（指数）：3 次真实执行后入死信。 */
const RETRY_BACKOFF_MS = [50, 200, 800]
/** 派发队列越限水位：超出部分转入死信（reason=backpressure_overflow，journal 仍可回放，不丢证据）。 */
const QUEUE_OVERFLOW_CAP = 10_000
/**
 * 回授断路集（QA C-01）：bus.listener_error / bus.dead_letter 是总线自观察事件。
 * 这两类事件的监听器自身失败时**不得**再以事件形式回授（否则失败监听器订阅自身
 * 即形成自激放大循环，journal 净增永不停歇，热点期挤占真实事件派发）——
 * 异常仍逐次落死信（证据可查），仅切断事件回授路径。
 */
const FEEDBACK_EVENTS = new Set<string>([PlatformEvents.BusListenerError, PlatformEvents.BusDeadLetter])

interface BusDeadLetterRecord {
  id: string
  eventName: string
  payload: unknown
  listener: string
  error: string
  attempts: number
  at: string
  /** 事件来源：缺省=平台内部；plugin:<id>=第三方插件。plugin: 死信结构性重投依赖此字段（存量无该字段的记录按缺省处理，不报错）。 */
  source?: string
}

export class PlatformBusService extends Service {
  static readonly provide = 'platformBus'

  private listeners = new Map<string, Set<BusListener>>()
  private wildcard = new Set<BusListener>()
  private seq = 0
  private ring: PlatformEvent[] = []

  // -- 管道状态（OPT-P1-04）：异步串行派发 + journal 持久化 + 死信 ----------------
  private queue: PlatformEvent[] = []
  private draining = false
  private persistenceReady = false
  private journalFile: string | undefined
  private deadLetterFile: string | undefined
  private deadLetterStore: BusDeadLetterRecord[] = []
  private journalFailures = 0

  constructor(ctx: Context, options: { dataDir?: string } = {}) {
    super(ctx, 'platformBus')
    this.preparePersistence(options.dataDir)
  }

  /**
   * 持久化准备（OPT-P1-04）：journal 追加文件 + 死信文件 + 重启回放。
   * 数据目录来源：显式 options.dataDir 优先；否则取 opsStorage.dataDirPath（精简宿主/单测无存储 → 纯内存运行）。
   * journal 装载最近 RING_CAPACITY 条进 ring（「重启后最近事件仍可回放」），并把 seq 续到历史最大值。
   */
  private preparePersistence(explicitDataDir?: string): void {
    if (this.persistenceReady) return
    this.persistenceReady = true
    let dataDir = explicitDataDir
    if (!dataDir) {
      try {
        dataDir = (this.ctx as { opsStorage?: { dataDirPath?: string } }).opsStorage?.dataDirPath
      } catch {
        dataDir = undefined // cordis 严格代理：服务未提供即抛错（嵌入/单测形态）→ 纯内存
      }
    }
    if (!dataDir) return
    this.journalFile = join(dataDir, 'bus-journal.jsonl')
    this.deadLetterFile = join(dataDir, 'bus-dead-letters.jsonl')
    try {
      const lines = readFileSync(this.journalFile, 'utf8').split('\n').filter((line) => line.trim() !== '')
      for (const line of lines.slice(-RING_CAPACITY)) {
        try {
          const event = JSON.parse(line) as PlatformEvent
          this.ring.push(event)
          if (typeof event.id === 'number' && event.id > this.seq) this.seq = event.id
        } catch { /* 坏行跳过：journal 只追加，单行损坏不影响其余回放 */ }
      }
    } catch { /* 首次启动：尚无 journal */ }
    try {
      for (const line of readFileSync(this.deadLetterFile, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try { this.deadLetterStore.push(JSON.parse(line) as BusDeadLetterRecord) } catch { /* 坏行跳过 */ }
      }
    } catch { /* 首次启动：尚无死信 */ }
  }

  /** journal 追加（fail-open：落盘失败计数并 console 告警，不阻断派发、不递归发事件）。 */
  private appendJournal(event: PlatformEvent): void {
    if (!this.journalFile) return
    try {
      appendFileSync(this.journalFile, `${JSON.stringify(event)}\n`)
    } catch (error) {
      this.journalFailures++
      if (this.journalFailures <= 3) console.error('[bus] journal 追加失败（事件仍在 ring/队列，可回放窗口受损）', error)
    }
  }

  private appendDeadLetter(record: BusDeadLetterRecord): void {
    this.deadLetterStore.push(record)
    if (!this.deadLetterFile) return
    try {
      appendFileSync(this.deadLetterFile, `${JSON.stringify(record)}\n`)
    } catch (error) {
      console.error('[bus] 死信落盘失败（内存死信仍可本进程内重投）', error)
    }
  }

  on(event: string, cb: BusListener): () => void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(cb)
    this.listeners.set(event, set)
    return () => set.delete(cb)
  }

  onAny(cb: BusListener): () => void {
    this.wildcard.add(cb)
    return () => this.wildcard.delete(cb)
  }

  emit(name: string, payload: unknown, options: { source?: string } = {}): PlatformEvent {
    const source = options.source
    if (source !== undefined && source.startsWith('plugin:')) {
      // 第三方发射：事件必须收敛在该插件命名空间，且不得触碰平台保留命名空间
      if (!name.startsWith(`${source}:`)) {
        throw new Error(`[bus] 插件 ${source} 不得发射非自有命名空间事件：${name}（允许前缀 ${source}:）`)
      }
      if (PLATFORM_RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        throw new Error(`[bus] 插件 ${source} 不得发射平台保留命名空间事件：${name}`)
      }
    } else if (name.startsWith('plugin:')) {
      // plugin: 命名空间事件必须有对应插件来源
      const pluginId = name.slice(0, name.indexOf(':', 8) === -1 ? name.length : name.indexOf(':', 8))
      throw new Error(`[bus] 插件命名空间事件 ${name} 必须携带来源（source: plugin:…，期望 ${pluginId}）`)
    }
    const event: PlatformEvent = { id: ++this.seq, name, payload, at: new Date().toISOString(), ...(source !== undefined ? { source } : {}) }
    this.preparePersistence()
    this.ring.push(event)
    if (this.ring.length > RING_CAPACITY) this.ring.shift()
    this.appendJournal(event)
    // OPT-P1-04：派发改异步串行——emit 同步返回事件对象（校验/记账/持久化同步完成），
    // 监听器经队列由调度器串行消费（FIFO 保序），失败重试 → 死信 → 告警事件，见 deliver()。
    this.queue.push(event)
    if (this.queue.length > QUEUE_OVERFLOW_CAP) {
      const dropped = this.queue.shift()
      if (dropped) {
        this.enterDeadLetter(dropped, '*', 'backpressure_overflow：派发队列越限（事件已入 journal 可回放）', 0)
      }
    }
    this.scheduleDrain()
    return event
  }

  /** 最近事件（平台事件流展示用；重启后由 journal 回放装载，仍是最近 RING_CAPACITY 条）。 */
  recent(limit = 50): PlatformEvent[] {
    return this.ring.slice(-limit).reverse()
  }

  /** 死信清单（OPT-P1-04）：含重启前遗留（持久化于 bus-dead-letters.jsonl）。 */
  deadLetters(): BusDeadLetterRecord[] {
    return [...this.deadLetterStore]
  }

  /**
   * 人工重投（OPT-P1-04）：按原事件名逐条重发（at-least-once）。
   * QA C-02 修正：不再「先清空再重发」——一条不可重投的事件（如丢失 source 的 plugin:
   * 事件，emit 校验即抛）不再连带丢弃其余死信；仅成功重发的移出，失败的原地保留。
   * ⚠ 口径与 usage 消费水位不同：总线无每监听器水位，重投会对已成功的监听器重复投递，
   * 消费方需自行幂等（审计/投影类消费方按事件 id 去重）。重投中再失败的监听器自然重新入死信。
   */
  retryDeadLetters(): { attempted: number; redelivered: number; retained: number } {
    const records = [...this.deadLetterStore]
    let redelivered = 0
    const retained: BusDeadLetterRecord[] = []
    for (const record of records) {
      try {
        // 补记 source 的 plugin: 死信按原来源重发（结构性可重投）；存量无 source 记录按缺省来源重发（emit 校验不通过则原地保留）
        this.emit(record.eventName, record.payload, record.source !== undefined ? { source: record.source } : {})
        redelivered++
      } catch (error) {
        // 不可重投（源校验失败/参数非法）：保留死信并注明原因，等待人工处置
        retained.push({ ...record, error: `${record.error}；重投失败：${error instanceof Error ? error.message : String(error)}` })
      }
    }
    this.deadLetterStore = retained
    if (this.deadLetterFile) {
      try { writeFileSync(this.deadLetterFile, retained.map((record) => JSON.stringify(record)).join('\n') + (retained.length > 0 ? '\n' : ''), 'utf8') } catch { /* 落盘失败：内存已对齐，下次重投再试 */ }
    }
    return { attempted: records.length, redelivered, retained: retained.length }
  }

  /** 死信入账 + 告警事件（bus.dead_letter）。suppressAlert 时仅入账不回发事件（回授断路，QA C-01）。 */
  private enterDeadLetter(event: PlatformEvent, listener: string, error: string, attempts: number, options: { suppressAlert?: boolean } = {}): void {
    const record: BusDeadLetterRecord = {
      id: `bdl-${randomUUID()}`, eventName: event.name, payload: event.payload,
      listener, error, attempts, at: new Date().toISOString(),
      ...(event.source !== undefined ? { source: event.source } : {}),
    }
    this.appendDeadLetter(record)
    if (options.suppressAlert) return
    // 告警事件走完整管道（可被 audit 通配订阅落审计）；其自身失败由 deliver 的 console 兜底，不递归入死信
    this.emit(PlatformEvents.BusDeadLetter, record)
  }

  private scheduleDrain(): void {
    if (this.draining) return
    this.draining = true
    queueMicrotask(() => { void this.drain() })
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()
        if (!event) break
        await this.deliver(event)
      }
    } finally {
      this.draining = false
      if (this.queue.length > 0) this.scheduleDrain()
    }
  }

  /**
   * 单事件派发（C-05）：事件间仍按队列 FIFO 串行（drain 逐事件等待 allSettled），
   * 同一事件的各监听器并发隔离——单监听器失败/挂起（至多 LISTENER_TIMEOUT_MS）不再拖慢
   * 同事件其他监听器；每监听器超时/异常按次计失败，指数退避重试 3 次后入死信（既有语义不变）。
   */
  private async deliver(event: PlatformEvent): Promise<void> {
    const targets: Array<{ cb: BusListener; label: string }> = []
    for (const cb of this.listeners.get(event.name) ?? []) targets.push({ cb, label: event.name })
    for (const cb of this.wildcard) targets.push({ cb, label: '*' })
    await Promise.allSettled(targets.map(({ cb, label }) => this.deliverToOne(event, cb, label)))
  }

  /** 单监听器派发链：失败逐次落 bus.listener_error（回授断路见 FEEDBACK_EVENTS），重试耗尽入死信。 */
  private async deliverToOne(event: PlatformEvent, cb: BusListener, label: string): Promise<void> {
    for (let attempt = 1; attempt <= RETRY_BACKOFF_MS.length + 1; attempt++) {
      try {
        await withTimeout(Promise.resolve(cb(event.payload, event)), LISTENER_TIMEOUT_MS)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 监听器异常一律显式落事件（OPT-P1-04）：审计可查，不再 console.error 了事；
        // 回授断路（QA C-01）：反馈事件自身的监听器失败不再回授，直接入死信（否则自激循环）
        console.error(`[bus] 监听器处理 ${event.name}（${label}）第 ${attempt} 次失败`, error)
        if (FEEDBACK_EVENTS.has(event.name)) {
          this.enterDeadLetter(event, label, `反馈事件监听器失败（不回授，QA C-01）：${message}`, attempt, { suppressAlert: true })
          return
        }
        this.emit(PlatformEvents.BusListenerError, { event: event.name, listener: label, attempt, error: message, at: new Date().toISOString() })
        if (attempt <= RETRY_BACKOFF_MS.length) {
          await sleep(RETRY_BACKOFF_MS[attempt - 1])
        } else {
          this.enterDeadLetter(event, label, `3 次重试均失败：${message}`, attempt)
        }
      }
    }
  }
}

function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`监听器超时（>${ms}ms）`)), ms)
    promise.then(
      () => { clearTimeout(timer); resolve() },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
