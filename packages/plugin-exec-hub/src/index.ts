/**
 * @dsh-ops/plugin-exec-hub —— 执行中枢（ybkk-MATRIX 目标四「干活中枢」，R8/R9/R10 落地）。
 *
 * 机制移植自 Paperclip 执行编排（wake-queue），按平台形态裁剪：
 *   - 任务执行锁（E2）：issue 行上三字段（executionRunId / executionAgentKey / executionLockedAt）
 *     的 CAS 语义——「检查-置位」在同一同步段完成，Node 单线程 run-to-completion 保证原子性，
 *     决策（domain 纯函数）与 CAS 护栏分层（Paperclip 原设计）。释放是 run 级批量操作。
 *   - Agent 心跳唤醒（E3/R9）：exec:wakes 队列（幂等键去重）+ 30s 心跳循环：
 *     预算前置 → 权限校验 → 审批门禁（P0）→ 取锁/合并/延迟三态裁决 → 上下文装配 → 派发 run。
 *     状态枚举与 Paperclip 对齐（deferred_issue_execution 具名延迟态）。
 *   - 目标血缘（E4/R8）：exec:goals（支持父目标树）→ exec:projects → exec:issues，
 *     goalAncestry 写时物化，唤醒时上下文装配注入「为什么而干」。
 *   - 例行调度（E7）：interval / 5 段 cron / webhook 三源；webhook 端点公开但路径即凭证
 *     （未登记路径一律 404，不泄露存在性）。
 *   - 治理五联动（E6）：预算硬停（超限不唤醒 + 联动冻结 + L4 解冻审批）、权限校验
 *     （Agent 机器主体须持 exec.write）、审计留痕（唤醒/取锁/释放/回收全链 type=invoke/change）、
 *     数据密级注记（上下文包装载 dataClass 上限）、审批门禁（P0 任务执行前须 exec.issue.run 审批）。
 *
 * 治理红线：唤醒派发永不虚构执行——run 只登记「已派发 + 上下文包」，执行由 Agent 经
 * exec_claim / exec_complete 工具或外部运行时回执；无回执的 run 由僵尸锁回收闭环。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../platform-core/src/index.ts'
import { createRestGate, defineTool, PlatformEvents, newId, WORK_DENY_CODE_LABELS, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import type { AuditLogRecord } from '../../plugin-audit/src/index.ts'
import {
  buildIssueContextPack, blockersResolved, computeAgentHealth, cronIsValid, cronMatches,
  decideCompleteOwnership, decideLeaseClaim, decideReleaseRecovery, decideRunAdoption,
  decideWakeAdmission, issueCanTransition, materializeGoalAncestry,
  normalizeAgentKey, wakeIdempotencyKey,
  type AgentHealthLevel, type IssueStatus,
} from './domain.ts'
import { LeaseStoreService, type RunLeaseRecord } from './lease-store.ts'
import { t } from '../../platform-i18n/src/index.ts'
import { seedExecHub } from './seed.ts'

// ---------------------------------------------------------------------------
// 记录模型（exec:* 集合）
// ---------------------------------------------------------------------------

export type GoalStatus = 'active' | 'achieved' | 'dropped' | 'archived'

/** 目标（R8）：支持父目标树；metric 三件套使「可量化」成为建模约束而非口头承诺。 */
export interface GoalRecord extends RecordBase {
  orgId: string
  title: string
  description?: string
  metric?: string
  metricBaseline?: number
  metricTarget?: number
  metricUnit?: string
  ownerUserId?: string
  parentGoalId?: string
  periodStart?: string
  periodEnd?: string
  status: GoalStatus
}

export type ProjectStatus = 'active' | 'done' | 'archived'

/** 项目（E4）：目标与任务之间的中间层，挂代码仓与文档。 */
export interface ProjectRecord extends RecordBase {
  orgId: string
  goalId?: string
  name: string
  description?: string
  repos: string[]
  ownerUserId?: string
  status: ProjectStatus
}

export type IssuePriority = 'P0' | 'P1' | 'P2' | 'P3'

/**
 * 任务（E2/E4）：执行锁三字段与 Paperclip 对齐（executionAgentKey=归一化名称键，
 * executionLockedAt=僵尸锁回收依据）；goalAncestry 写时物化；checkoutRunId 预留双锁位。
 */
export interface IssueRecord extends RecordBase {
  orgId: string
  projectId?: string
  parentId?: string
  blockerIds: string[]
  title: string
  detail?: string
  assigneeAgentId?: string
  assigneeUserId?: string
  status: IssueStatus
  priority: IssuePriority
  dueAt?: string
  executionRunId?: string
  executionAgentKey?: string
  executionLockedAt?: string
  /** 预留：检出锁（双锁语义，Paperclip checkout_run_id），首版不启用。 */
  checkoutRunId?: string
  goalAncestry: string[]
  createdBy: string
}

export type WakeTrigger = 'assign' | 'comment' | 'dependency' | 'routine' | 'api' | 'webhook'
export type WakeStatus = 'pending' | 'deferred_issue_execution' | 'run' | 'failed' | 'cancelled' | 'done'

/** 唤醒请求（E3）：幂等键防重复投递（无它则重复唤醒白烧预算）。 */
export interface WakeRecord extends RecordBase {
  orgId: string
  issueId?: string
  agentId?: string
  trigger: WakeTrigger
  triggerDetail?: string
  payload?: Record<string, unknown>
  status: WakeStatus
  idempotencyKey?: string
  budgetCheckPassed?: boolean
  lineageSnapshot?: string[]
  runId?: string
  lastError?: string
  createdAt: string
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'timeout'

/** 执行 run：一次派发的登记（含上下文包），完成/超时/失败由 Agent 回执或僵尸回收闭环。 */
export interface RunRecord extends RecordBase {
  orgId: string
  agentId?: string
  issueIds: string[]
  trigger: WakeTrigger
  status: RunStatus
  contextPack?: string
  summary?: string
  startedAt: string
  finishedAt?: string
}

export type RoutineKind = 'interval' | 'cron' | 'webhook'

/** 例行规则（E7）：三源——间隔分钟 / 5 段 cron / webhook 路径。 */
export interface RoutineRecord extends RecordBase {
  orgId: string
  agentId: string
  name: string
  kind: RoutineKind
  intervalMinutes?: number
  cron?: string
  webhookPath?: string
  payload?: Record<string, unknown>
  enabled: boolean
  lastFiredAt?: string
  createdBy: string
}

export type HeartbeatOutcome = 'woken' | 'skipped_no_todo' | 'skipped_budget' | 'skipped_permission' | 'skipped_frozen' | 'skipped_inactive' | 'deferred'

/** 心跳留痕（R9）：Agent 健康度数据源，滚动保留 7 天。 */
export interface HeartbeatRecord extends RecordBase {
  agentId: string
  orgId: string
  at: string
  outcome: HeartbeatOutcome
  detail?: string
  issueCount?: number
}

export interface TickResult {
  processed: number
  woken: number
  deferred: number
  skipped: number
  failed: number
  reclaimed: number
  routineFired: number
  heartbeatDue: number
}

// ---------------------------------------------------------------------------
// 配置（env 可覆盖；selftest 用 TTL 压缩换确定性）
// ---------------------------------------------------------------------------

const TICK_MS = Number(process.env.EXEC_HUB_TICK_MS ?? 30_000)
const FIRST_TICK_MS = Number(process.env.EXEC_HUB_FIRST_TICK_MS ?? Math.min(TICK_MS, 15_000))

/** 定时器只在插件卸载时清理；Cordis effect 的返回值才是 disposer。 */
export function registerExecTimers(ctx: Pick<Context, 'effect'>, tick: () => void, metrics: () => void, tickMs = TICK_MS, firstMs = FIRST_TICK_MS): void {
  const tickTimer = setInterval(tick, tickMs)
  tickTimer.unref?.()
  const firstTick = setTimeout(tick, firstMs)
  firstTick.unref?.()
  const metricsTimer = setInterval(metrics, 3_600_000)
  metricsTimer.unref?.()
  ctx.effect(() => () => {
    clearInterval(tickTimer)
    clearTimeout(firstTick)
    clearInterval(metricsTimer)
  })
}
const BATCH_SIZE = Number(process.env.EXEC_HUB_BATCH ?? 50)
/** 僵尸锁阈值：Paperclip 建议约 2× 心跳周期，缺省 5 分钟。 */
const LOCK_TIMEOUT_MS = Number(process.env.EXEC_LOCK_TIMEOUT_MS ?? 300_000)
/** 执行租约缺省 TTL（附录 A 决策 3：exec_run_leases 权威；运行时应在到期前 renewLease 心跳）。 */
const DEFAULT_LEASE_TTL_MS = Number(process.env.EXEC_LEASE_TTL_MS ?? 15 * 60_000)
const HEARTBEAT_RETENTION_MS = 7 * 86_400_000
const METRICS_OVERDUE_MS = 24 * 3_600_000

// ---------------------------------------------------------------------------
// exec-hub 集成端口返回类型（结构镜像 plugin-workforce contract.ts 的
// EmployeeClaimResult / EmployeeLeaseResult，冻结契约 V1.0——防循环不 import，
// 结构逐字段对齐，Group 2 结构化消费）
// ---------------------------------------------------------------------------

/** 统一拒绝码（exec-hub 工作面口径；与 platform-core WorkDenyCode 同名子集）。 */
export type ExecHubWorkDenyCode =
  | 'ISSUE_NOT_FOUND' | 'ISSUE_CLOSED' | 'LEASE_HELD_BY_OTHER'
  | 'ADMISSION_DENIED' | 'BUDGET_EXCEEDED' | 'APPROVAL_REQUIRED'
  | 'RUN_NOT_OWNED' | 'LEASE_STALE' | 'EXEC_HUB_UNAVAILABLE' | 'POLICY_INTERNAL_ERROR'

/** 员工认领结果（镜像 contract.EmployeeClaimResult）。 */
export type EmployeeClaimResult =
  | { ok: true; issueId: string; runId: string; lease: RunLeaseRecord; created: boolean }
  | { ok: false; code: ExecHubWorkDenyCode; message: string; holder?: string }

/** 员工租约结果（镜像 contract.EmployeeLeaseResult）。 */
export type EmployeeLeaseResult =
  | { ok: true; lease: RunLeaseRecord }
  | { ok: false; code: Extract<ExecHubWorkDenyCode, 'LEASE_STALE' | 'RUN_NOT_OWNED' | 'EXEC_HUB_UNAVAILABLE'>; message: string }

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class ExecutionHubService extends Service {
  static readonly provide = 'execHub'

  /**
   * 执行租约权威存储（附录 A 决策 3：exec_run_leases 为唯一权威，issue 三字段为投影）。
   * txnStore 由 platform-core 首位装配（exec-hub 之前），构造期即可迁移建表。
   */
  readonly leaseStore: LeaseStoreService

  /** 纳管提报催办的日去重（进程内；重启重发一次可接受，告警不追求恰好一次）。 */
  private metricsReminderDayKeys = new Set<string>()
  private tickBusy = false

  constructor(ctx: Context) {
    super(ctx, 'execHub')

    // 权威租约存储：建表幂等（exec_run_leases；索引 issueId+status、runId）
    this.leaseStore = new LeaseStoreService(ctx.txnStore, { ttlMs: DEFAULT_LEASE_TTL_MS })
    this.leaseStore.migrate()

    // 审批通过（exec.issue.run）→ 重新入队被门禁挂起的唤醒
    ctx.platformBus.on(PlatformEvents.ApprovalDecided, (payload) => {
      try {
        const p = payload as { approvalId?: string }
        if (!p.approvalId) return
        const approval = this.ctx.opsStorage.collection<{ kind?: string; status?: string; payload?: Record<string, unknown>; orgId?: string }>('audit:approvals').get(p.approvalId)
        if (!approval || approval.kind !== 'exec.issue.run' || approval.status !== 'executed') return
        const issueId = String(approval.payload?.['issueId'] ?? '')
        if (!issueId) return
        this.enqueueWake({
          orgId: approval.orgId ?? '', issueId, trigger: 'api',
          triggerDetail: t('P0 审批通过放行'), idempotencyKey: wakeIdempotencyKey('p0-release', [issueId, approval.id]),
        })
      } catch { /* 审批联动失败不阻塞事件链 */ }
    })

    if (process.env.EXEC_HUB_OFF === 'off') return
    // 心跳循环（lint-timers：unref + effect 清理双保险）
    const tickTimer = setInterval(() => { void this.safeTick() }, TICK_MS)
    tickTimer.unref?.()
    const firstTick = setTimeout(() => { void this.safeTick() }, FIRST_TICK_MS)
    firstTick.unref?.()
    // 纳管提报催办巡检：每小时一轮（R9：metrics-report 超 24h 自动催办）
    const metricsTimer = setInterval(() => { void this.remindOverdueMetrics() }, 3_600_000)
    metricsTimer.unref?.()
    // cordis ctx.effect(fn)：fn 在注册时立即执行，返回值才是清理函数——单层箭头会把定时器当场清掉（issue #10）
    ctx.effect(() => () => {
      clearInterval(tickTimer)
      clearTimeout(firstTick)
      clearInterval(metricsTimer)
    })
  }

  private async safeTick(): Promise<void> {
    if (this.tickBusy) return
    this.tickBusy = true
    try {
      await this.tick()
    } catch (error) {
      this.ctx.logger('exec-hub').warn(`tick 异常：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.tickBusy = false
    }
  }

  // -- 集合 -----------------------------------------------------------------

  goals(): Collection<GoalRecord> {
    return this.ctx.opsStorage.collection<GoalRecord>('exec:goals')
  }

  projects(): Collection<ProjectRecord> {
    return this.ctx.opsStorage.collection<ProjectRecord>('exec:projects')
  }

  issues(): Collection<IssueRecord> {
    return this.ctx.opsStorage.collection<IssueRecord>('exec:issues')
  }

  wakes(): Collection<WakeRecord> {
    return this.ctx.opsStorage.collection<WakeRecord>('exec:wakes')
  }

  runs(): Collection<RunRecord> {
    return this.ctx.opsStorage.collection<RunRecord>('exec:runs')
  }

  routines(): Collection<RoutineRecord> {
    return this.ctx.opsStorage.collection<RoutineRecord>('exec:routines')
  }

  heartbeats(): Collection<HeartbeatRecord> {
    return this.ctx.opsStorage.collection<HeartbeatRecord>('exec:heartbeats')
  }

  // -- 组织血缘（#16，2026-10-29） ---------------------------------------------

  /**
   * 平台首个根组织（无父组织）；组织树未播种时为 undefined——缺省继承链的最后兜底与
   * 存量空 orgId 迁移（migrateEmptyExecOrgId）都以它为归属依据。
   */
  rootOrgId(): string | undefined {
    return this.ctx.iam.orgs().all().find((org) => !org.parentId)?.id
  }

  /**
   * 显式 orgId 入参校验（#16）：空串/空白一律拒绝（防「空串落库 → 组织血缘断链」），
   * 非空必须命中真实组织；undefined 表示未提供，交给继承链（principal → 血缘 → 根组织）。
   */
  private assertOrgInput(orgId: string | undefined): void {
    if (orgId === undefined) return
    if (!orgId.trim()) throw new Error(t('orgId 不接受空值：缺省请不传（自动继承组织血缘），显式指定请传非空组织 ID'))
    if (!this.ctx.iam.orgs().get(orgId)) throw new Error(t('组织不存在：{id}', { id: orgId }))
  }

  // -- 目标（R8） -------------------------------------------------------------

  /** 目标链（根→…→本目标）；无父即 [self]；成环/断链防御性截断。 */
  goalChain(goalId?: string): string[] {
    if (!goalId) return []
    const chain: string[] = []
    const seen = new Set<string>()
    let current = this.goals().get(goalId)
    while (current && !seen.has(current.id) && chain.length < 50) {
      seen.add(current.id)
      chain.unshift(current.id)
      current = current.parentGoalId ? this.goals().get(current.parentGoalId) : undefined
    }
    return chain
  }

  createGoal(input: Omit<GoalRecord, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: GoalStatus }): GoalRecord {
    if (!input.title?.trim()) throw new Error(t('目标标题必填'))
    this.assertOrgInput(input.orgId)
    if (input.parentGoalId) {
      const parent = this.goals().get(input.parentGoalId)
      if (!parent) throw new Error(t('父目标不存在：{id}', { id: input.parentGoalId }))
      if (input.parentGoalId === input.id) throw new Error(t('父目标不得指向自己'))
      if (this.goalChain(input.parentGoalId).includes(input.id ?? '')) throw new Error(t('目标父链成环'))
    }
    const record = this.goals().insert({
      id: newId('goal'),
      // #16：显式 orgId 已过校验；缺省回落平台根组织（REST 层先按 principal/血缘解析）
      orgId: input.orgId ?? this.rootOrgId() ?? '',
      title: input.title.trim(),
      ...(input.description ? { description: input.description } : {}),
      ...(input.metric ? { metric: input.metric } : {}),
      ...(input.metricBaseline !== undefined ? { metricBaseline: input.metricBaseline } : {}),
      ...(input.metricTarget !== undefined ? { metricTarget: input.metricTarget } : {}),
      ...(input.metricUnit ? { metricUnit: input.metricUnit } : {}),
      ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.parentGoalId ? { parentGoalId: input.parentGoalId } : {}),
      ...(input.periodStart ? { periodStart: input.periodStart } : {}),
      ...(input.periodEnd ? { periodEnd: input.periodEnd } : {}),
      status: input.status ?? 'active',
    })
    this.ctx.platformBus.emit(PlatformEvents.ExecGoalChanged, { goalId: record.id, action: 'created' })
    return record
  }

  updateGoal(id: string, patch: Partial<GoalRecord>): GoalRecord {
    const goal = this.goals().get(id)
    if (!goal) throw new Error(t('目标不存在：{id}', { id }))
    if (patch.parentGoalId) {
      if (patch.parentGoalId === id) throw new Error(t('父目标不得指向自己'))
      if (!this.goals().get(patch.parentGoalId)) throw new Error(t('父目标不存在：{id}', { id: patch.parentGoalId }))
      if (this.goalChain(patch.parentGoalId).includes(id)) throw new Error(t('目标父链成环'))
    }
    const updated = this.goals().update(id, {
      ...(patch.title !== undefined ? { title: patch.title.trim() || goal.title } : {}),
      ...(patch.parentGoalId !== undefined ? { parentGoalId: patch.parentGoalId || undefined } : {}),
      ...patch,
    })
    this.ctx.platformBus.emit(PlatformEvents.ExecGoalChanged, { goalId: id, action: 'updated' })
    return updated
  }

  deleteGoal(id: string): { deleted: true } {
    const goal = this.goals().get(id)
    if (!goal) throw new Error(t('目标不存在：{id}', { id }))
    if (this.goals().all().some((item) => item.parentGoalId === id)) throw new Error(t('目标下仍有子目标，先迁移或删除子目标'))
    if (this.projects().all().some((item) => item.goalId === id)) throw new Error(t('目标下仍有项目，先迁移或删除项目'))
    this.goals().remove(id)
    this.ctx.platformBus.emit(PlatformEvents.ExecGoalChanged, { goalId: id, action: 'deleted' })
    return { deleted: true }
  }

  // -- 项目（E4） ---------------------------------------------------------------

  createProject(input: Omit<ProjectRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'repos'> & { repos?: string[]; status?: ProjectStatus }): ProjectRecord {
    if (!input.name?.trim()) throw new Error(t('项目名称必填'))
    this.assertOrgInput(input.orgId)
    if (input.goalId && !this.goals().get(input.goalId)) throw new Error(t('关联目标不存在：{id}', { id: input.goalId }))
    const record = this.projects().insert({
      id: newId('proj'),
      // #16：缺省沿目标血缘继承，再回落平台根组织
      orgId: input.orgId ?? this.goals().get(input.goalId ?? '')?.orgId ?? this.rootOrgId() ?? '',
      ...(input.goalId ? { goalId: input.goalId } : {}),
      name: input.name.trim(),
      ...(input.description ? { description: input.description } : {}),
      repos: input.repos ?? [],
      ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
      status: input.status ?? 'active',
    })
    this.ctx.platformBus.emit(PlatformEvents.ExecGoalChanged, { projectId: record.id, action: 'project-created' })
    return record
  }

  updateProject(id: string, patch: Partial<ProjectRecord>): ProjectRecord {
    const project = this.projects().get(id)
    if (!project) throw new Error(t('项目不存在：{id}', { id }))
    if (patch.goalId && !this.goals().get(patch.goalId)) throw new Error(t('关联目标不存在：{id}', { id: patch.goalId }))
    const updated = this.projects().update(id, patch)
    // 项目改挂目标 → 重物化其下任务血缘
    if (patch.goalId !== undefined) {
      for (const issue of this.issues().all().filter((item) => item.projectId === id)) {
        this.rematerialize(issue.id)
      }
    }
    this.ctx.platformBus.emit(PlatformEvents.ExecGoalChanged, { projectId: id, action: 'project-updated' })
    return updated
  }

  deleteProject(id: string): { deleted: true } {
    const project = this.projects().get(id)
    if (!project) throw new Error(t('项目不存在：{id}', { id }))
    if (this.issues().all().some((item) => item.projectId === id)) throw new Error(t('项目下仍有任务，先迁移或删除任务'))
    this.projects().remove(id)
    this.ctx.platformBus.emit(PlatformEvents.ExecGoalChanged, { projectId: id, action: 'project-deleted' })
    return { deleted: true }
  }

  // -- 任务（E2/E4） -------------------------------------------------------------

  /** 血缘重物化：goalAncestry = goalChain(project.goalId) + [projectId]。 */
  private rematerialize(issueId: string): void {
    const issue = this.issues().get(issueId)
    if (!issue) return
    const project = issue.projectId ? this.projects().get(issue.projectId) : undefined
    const chain = this.goalChain(project?.goalId)
    const ancestry = materializeGoalAncestry(chain, issue.projectId)
    if (JSON.stringify(ancestry) !== JSON.stringify(issue.goalAncestry)) {
      this.issues().update(issueId, { goalAncestry: ancestry })
    }
  }

  createIssue(input: {
    orgId?: string; projectId?: string; parentId?: string; blockerIds?: string[]
    title: string; detail?: string; assigneeAgentId?: string; assigneeUserId?: string
    priority?: IssuePriority; dueAt?: string; createdBy: string
  }): IssueRecord {
    if (!input.title?.trim()) throw new Error(t('任务标题必填'))
    this.assertOrgInput(input.orgId)
    if (input.projectId && !this.projects().get(input.projectId)) throw new Error(t('项目不存在：{id}', { id: input.projectId }))
    if (input.parentId && !this.issues().get(input.parentId)) throw new Error(t('父任务不存在：{id}', { id: input.parentId }))
    for (const blockerId of input.blockerIds ?? []) {
      if (!this.issues().get(blockerId)) throw new Error(t('前置任务不存在：{id}', { id: blockerId }))
    }
    if (input.assigneeAgentId && !this.agentOf(input.assigneeAgentId)) throw new Error(t('负责人 Agent 不存在：{id}', { id: input.assigneeAgentId }))
    const project = input.projectId ? this.projects().get(input.projectId) : undefined
    // #16：继承链 principal（REST 层已解析进 input.orgId）→ 项目 → Agent → 平台根组织
    const orgId = input.orgId ?? project?.orgId ?? this.agentOf(input.assigneeAgentId ?? '')?.orgId ?? this.rootOrgId() ?? ''
    const record = this.issues().insert({
      id: newId('iss'),
      orgId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      blockerIds: input.blockerIds ?? [],
      title: input.title.trim(),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.assigneeAgentId ? { assigneeAgentId: input.assigneeAgentId } : {}),
      ...(input.assigneeUserId ? { assigneeUserId: input.assigneeUserId } : {}),
      status: 'todo',
      priority: input.priority ?? 'P2',
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      goalAncestry: materializeGoalAncestry(this.goalChain(project?.goalId), input.projectId),
      createdBy: input.createdBy,
    })
    this.ctx.platformBus.emit(PlatformEvents.ExecIssueChanged, { issueId: record.id, action: 'created', status: record.status })
    // 派发触发器：assigneeAgentId 由空变为非空（E7 触发源接线表）
    if (record.assigneeAgentId) {
      this.enqueueWake({
        orgId, issueId: record.id, agentId: record.assigneeAgentId, trigger: 'assign',
        idempotencyKey: wakeIdempotencyKey('assign', [record.id, record.assigneeAgentId, record.createdAt.slice(0, 13)]),
      })
    }
    return record
  }

  updateIssue(id: string, patch: Partial<IssueRecord>, actor: string): IssueRecord {
    const issue = this.issues().get(id)
    if (!issue) throw new Error(t('任务不存在：{id}', { id }))
    if (patch.projectId && !this.projects().get(patch.projectId)) throw new Error(t('项目不存在：{id}', { id: patch.projectId }))
    if (patch.assigneeAgentId && !this.agentOf(patch.assigneeAgentId)) throw new Error(t('负责人 Agent 不存在：{id}', { id: patch.assigneeAgentId }))
    for (const blockerId of patch.blockerIds ?? []) {
      if (!this.issues().get(blockerId)) throw new Error(t('前置任务不存在：{id}', { id: blockerId }))
      if (blockerId === id) throw new Error(t('前置任务不得指向自己'))
    }
    const updated = this.issues().update(id, { ...patch })
    this.rematerialize(id)
    // 换 Agent / 新挂 Agent → 派发唤醒（幂等键带时间桶，重复 PATCH 不重复唤醒）
    const newAssignee = updated.assigneeAgentId
    if (newAssignee && newAssignee !== issue.assigneeAgentId) {
      this.enqueueWake({
        orgId: updated.orgId, issueId: id, agentId: newAssignee, trigger: 'assign',
        triggerDetail: t('改派（{actor}）', { actor }),
        idempotencyKey: wakeIdempotencyKey('assign', [id, newAssignee, new Date().toISOString().slice(0, 13)]),
      })
    }
    this.ctx.platformBus.emit(PlatformEvents.ExecIssueChanged, { issueId: id, action: 'updated', status: updated.status })
    return this.issues().get(id) ?? updated
  }

  transitionIssue(id: string, to: IssueStatus, actor: string): IssueRecord {
    const issue = this.issues().get(id)
    if (!issue) throw new Error(t('任务不存在：{id}', { id }))
    if (!issueCanTransition(issue.status, to)) {
      throw new Error(t('任务状态 {from} 不允许流转到 {to}', { from: issue.status, to }))
    }
    if (to === 'done' && issue.executionRunId) {
      // 收尾语义：终态前先收 run（释放锁 + run 完结），不留悬挂锁
      this.completeRun(issue.executionRunId, { status: 'completed', summary: t('任务完成收尾（{actor}）', { actor }) })
    }
    if (to === 'cancelled' && issue.executionRunId) {
      this.completeRun(issue.executionRunId, { status: 'failed', summary: t('任务取消收尾（{actor}）', { actor }) })
    }
    const updated = this.issues().update(id, { status: to })
    this.ctx.platformBus.emit(PlatformEvents.ExecIssueChanged, { issueId: id, action: 'transition', status: to })
    // 依赖解除触发器：blocker 终态后，下游全解除者入队 dependency 唤醒（E7 触发源接线表）
    if (to === 'done' || to === 'cancelled') this.wakeUnblockedDependents(id)
    return updated
  }

  /** 扫描以 issueId 为前置的任务：其 blockers 全部终态 → 入队 dependency 唤醒。 */
  private wakeUnblockedDependents(issueId: string): void {
    for (const dependent of this.issues().all().filter((item) => item.blockerIds.includes(issueId))) {
      const statuses = dependent.blockerIds.map((bid) => this.issues().get(bid)?.status ?? 'todo')
      if (!blockersResolved(statuses as IssueStatus[])) continue
      if (!dependent.assigneeAgentId) continue
      this.enqueueWake({
        orgId: dependent.orgId, issueId: dependent.id, agentId: dependent.assigneeAgentId,
        trigger: 'dependency', triggerDetail: t('前置 {issueId} 已解除', { issueId }),
        idempotencyKey: wakeIdempotencyKey('dep', [dependent.id, issueId]),
      })
    }
  }

  deleteIssue(id: string): { deleted: true } {
    const issue = this.issues().get(id)
    if (!issue) throw new Error(t('任务不存在：{id}', { id }))
    if (issue.executionRunId) throw new Error(t('任务执行中（持有执行锁），先完成或取消'))
    if (this.issues().all().some((item) => item.parentId === id)) throw new Error(t('任务下仍有子任务'))
    this.issues().remove(id)
    this.ctx.platformBus.emit(PlatformEvents.ExecIssueChanged, { issueId: id, action: 'deleted' })
    return { deleted: true }
  }

  // -- 执行锁（E2：CAS 语义，检查-置位在同一同步段＝Node 原子） -------------------

  /**
   * 投影取锁（issue 三字段 CAS）。附录 A 决策 3 后本方法只维护投影，持有裁决以
   * exec_run_leases 为权威；两处护栏语义（D05/D06 幂等认领）：
   *   - 同 runId 重复获取＝ok（刷新 agentKey/心跳时间戳，不报冲突）；
   *   - 投影指向已终态/已消失的 run（租约权威口径下无人持有）→ 视为可夺回，直接覆盖。
   */
  acquireLock(issueId: string, runId: string, agentKey: string): { ok: true } | { ok: false; reason: 'no_issue' | 'locked_by_other'; holder?: string } {
    const issue = this.issues().get(issueId)
    if (!issue) return { ok: false, reason: 'no_issue' }
    if (issue.executionRunId === runId) {
      this.issues().update(issueId, { executionAgentKey: agentKey, executionLockedAt: new Date().toISOString() })
      return { ok: true }
    }
    if (issue.executionRunId) {
      const holder = this.runs().get(issue.executionRunId)
      if (holder && holder.status === 'running') return { ok: false, reason: 'locked_by_other', holder: issue.executionRunId }
    }
    this.issues().update(issueId, {
      executionRunId: runId,
      executionAgentKey: agentKey,
      executionLockedAt: new Date().toISOString(),
    })
    return { ok: true }
  }

  /** run 级批量释放（Paperclip 语义：按 executionRunId 释放全部持有 issue，防部分释放泄漏）。 */
  releaseLocks(runId: string): number {
    let released = 0
    for (const issue of this.issues().all().filter((item) => item.executionRunId === runId)) {
      this.issues().update(issue.id, { executionRunId: undefined, executionAgentKey: undefined, executionLockedAt: undefined })
      released += 1
      this.ctx.platformBus.emit(PlatformEvents.ExecIssueChanged, { issueId: issue.id, action: 'lock-released' })
    }
    return released
  }

  /**
   * 僵尸锁回收（Paperclip active-run-watchdog 思路）：锁龄超阈值时按
   * decideReleaseRecovery 裁决——run 消失/终态直接强释，run 仍 running 记 timeout 再强释。
   */
  reclaimZombieLocks(nowMs = Date.now()): number {
    let reclaimed = 0
    for (const issue of this.issues().all().filter((item) => item.executionRunId && item.executionLockedAt)) {
      const lockAge = nowMs - new Date(issue.executionLockedAt!).getTime()
      if (lockAge < LOCK_TIMEOUT_MS) continue
      const run = this.runs().get(issue.executionRunId!)
      const decision = decideReleaseRecovery({
        runMissing: !run,
        runSettled: Boolean(run && run.status !== 'running'),
        lockTimedOut: true,
      })
      if (decision.kind === 'keep') continue
      if (decision.kind === 'timeout-run' && run) {
        this.runs().update(run.id, { status: 'timeout', finishedAt: new Date().toISOString(), summary: t('执行锁超时（{seconds}s）自动回收', { seconds: Math.round(lockAge / 1000) }) })
      }
      const holderRun = issue.executionRunId!
      this.issues().update(issue.id, { executionRunId: undefined, executionAgentKey: undefined, executionLockedAt: undefined })
      // 租约与投影同步收口：僵尸投影对应的权威租约一并释放（防 TTL 内幽灵持有）
      this.releaseLeasesSafe(holderRun, `zombie-reclaim:${decision.kind}`)
      reclaimed += 1
      this.auditSafe({
        type: 'change', actorType: 'machine', actorId: 'exec-hub', actorName: '执行中枢',
        action: 'exec.lock.reclaimed', resourceType: 'issue', resourceId: issue.id, resourceName: issue.title,
        result: 'ok', detail: `run=${holderRun} 锁龄 ${Math.round(lockAge / 1000)}s（${decision.kind}）`,
      })
      this.ctx.platformBus.emit(PlatformEvents.ExecLockReclaimed, { issueId: issue.id, runId: holderRun, reason: decision.kind })
    }
    return reclaimed
  }

  // -- run ------------------------------------------------------------------

  private createRun(input: { orgId: string; agentId?: string; issueIds: string[]; trigger: WakeTrigger; contextPack?: string }): RunRecord {
    return this.runs().insert({
      id: newId('run'),
      orgId: input.orgId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      issueIds: input.issueIds,
      trigger: input.trigger,
      status: 'running',
      ...(input.contextPack ? { contextPack: input.contextPack } : {}),
      startedAt: new Date().toISOString(),
    })
  }

  /**
   * run 收尾：终态 + run 级释放锁与租约 + in_progress 任务交回审阅（review）。
   *
   * 兼容说明：任务去向现状为 review（「交付已提交、真人验收」，§6.5），既有调用方
   * （transitionIssue 收尾等）行为不变；仅 exec_complete 显式传
   * failedIssueDisposition='todo' 时，失败 run 的进行中任务转回待办（todo）等待重派
   * （直接更新，与 review 同款处理——todo 供调度重新唤醒，不占 review 验收队列）。
   */
  completeRun(runId: string, options: { status?: RunStatus; summary?: string; failedIssueDisposition?: 'review' | 'todo' } = {}): RunRecord {
    const run = this.runs().get(runId)
    if (!run) throw new Error(t('run 不存在：{id}', { id: runId }))
    if (run.status !== 'running') return run
    const updated = this.runs().update(runId, {
      status: options.status ?? 'completed',
      finishedAt: new Date().toISOString(),
      ...(options.summary ? { summary: options.summary } : {}),
    })
    this.releaseLocks(runId)
    // 租约随 run 终态释放（权威存储收口；投影已由 releaseLocks 清理）
    this.releaseLeasesSafe(runId, `run-${updated.status}`)
    const failedToTodo = updated.status !== 'completed' && options.failedIssueDisposition === 'todo'
    for (const issueId of run.issueIds) {
      const issue = this.issues().get(issueId)
      if (issue && issue.status === 'in_progress') this.issues().update(issueId, { status: failedToTodo ? 'todo' : 'review' })
    }
    this.auditSafe({
      type: 'invoke', actorType: 'machine', actorId: 'exec-hub', actorName: '执行中枢',
      action: 'exec.run.completed', resourceType: 'run', resourceId: runId,
      resourceName: run.agentId ?? '', result: 'ok',
      detail: `issues=${run.issueIds.length} status=${updated.status}${options.summary ? `（${options.summary}）` : ''}`,
    })
    this.ctx.platformBus.emit(PlatformEvents.ExecRunCompleted, {
      runId, agentId: run.agentId, issueIds: run.issueIds, status: updated.status,
    })
    return updated
  }

  // -- 员工工作集成端口（ExecHubWorkIntegration，附录 A 决策 3/§6.2） ----------------
  //
  // plugin-workforce 结构化消费（组2）：认领＝「幂等确认已分配租约」——
  // 统一准入（冻结/预算/权限/P0，与 processWake 同源函数不绕行）→ get-or-create run
  // （V05：调度预取锁的 run 直接被认领采用，不另造）→ exec_run_leases 原子取租约
  // （权威）→ issue 投影写齐（现状兼容）。本插件不 import plugin-workforce（§10.2）。

  /** 员工幂等认领：同员工+同任务重复认领返回既有 run/租约（created=false）。 */
  async claimForEmployee(input: { issueId: string; employeeId: string; agentKey: string; principalId: string; ttlMs?: number }): Promise<EmployeeClaimResult> {
    try {
      if (!input.issueId) return { ok: false, code: 'ISSUE_NOT_FOUND', message: t('任务 ID 必填') }
      if (!input.employeeId || !input.principalId) {
        return { ok: false, code: 'ADMISSION_DENIED', message: t('认领参数不足：employeeId 与 principalId 必填（fail-closed）') }
      }
      const issue = this.issues().get(input.issueId)
      if (!issue) return { ok: false, code: 'ISSUE_NOT_FOUND', message: t('任务不存在：{id}', { id: input.issueId }) }
      if (issue.status === 'done' || issue.status === 'cancelled') {
        return { ok: false, code: 'ISSUE_CLOSED', message: t('任务已{state}关闭，不可认领', { state: issue.status === 'done' ? t('完成') : t('取消') }) }
      }
      // agentKey 归一：优先入参，否则 employee:<id>
      const agentKey = input.agentKey?.trim() ? normalizeAgentKey(input.agentKey) : `employee:${input.employeeId}`
      // 统一准入照跑（冻结/预算/权限/P0——复用 processWake 同源函数，D06 不绕行）
      const admission = this.admitAgentForClaim(issue, agentKey)
      if (!admission.ok) return { ok: false, code: admission.code, message: admission.message }
      const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DEFAULT_LEASE_TTL_MS
      // 幂等裁决（domain 纯函数）先行：同持有者已有有效租约 → 续期并复用既有 run，不另造
      const existing = this.leaseStore.activeForIssue(issue.id)
      if (existing) {
        const decision = decideLeaseClaim({
          activeLeasePresent: true,
          activeLeaseExpired: false,
          existingEmployeeId: existing.employeeId,
          existingAgentKey: existing.agentKey,
          requestedEmployeeId: input.employeeId,
          requestedAgentKey: agentKey,
        })
        if (decision.kind === 'idempotent') {
          const renewed = this.leaseStore.renew({ leaseId: existing.id, ttlMs })
          const lease = renewed.ok ? renewed.lease : existing
          this.writeExecutionProjection(issue.id, lease.runId, agentKey)
          this.ensureIssueInProgress(issue)
          return { ok: true, issueId: issue.id, runId: lease.runId, lease, created: false }
        }
        if (decision.kind === 'held-by-other') {
          return { ok: false, code: 'LEASE_HELD_BY_OTHER', message: t('任务执行租约由 {holder} 持有，不可重复认领', { holder: decision.holder }), holder: decision.holder }
        }
      }
      // get-or-create run（V05/D05：唤醒预持锁的运行中 run 直接采用；脏投影才新建）
      const agentId = this.resolveAgentIdForIssue(issue, agentKey)
      const projectedRun = issue.executionRunId ? this.runs().get(issue.executionRunId) : undefined
      const adoption = decideRunAdoption({
        projectedRunIdPresent: Boolean(issue.executionRunId),
        projectedRunRunning: Boolean(projectedRun && projectedRun.status === 'running'),
      })
      let runId: string
      if (adoption.kind === 'adopt' && issue.executionRunId) {
        runId = issue.executionRunId
        if (projectedRun && !projectedRun.issueIds.includes(issue.id)) {
          this.runs().update(runId, { issueIds: [...projectedRun.issueIds, issue.id] })
        }
      } else {
        const agent = agentId ? this.agentOf(agentId) : undefined
        runId = this.createRun({
          orgId: issue.orgId, ...(agentId ? { agentId } : {}), issueIds: [issue.id], trigger: 'api',
          contextPack: this.buildIssueContext(issue, agent ?? {}),
        }).id
      }
      // 原子取租约（权威 CAS；竞争失败映射为他人持有）
      const acquired = this.leaseStore.acquire({ issueId: issue.id, runId, employeeId: input.employeeId, agentKey, principalId: input.principalId, ttlMs })
      if (!acquired.ok) {
        return { ok: false, code: 'LEASE_HELD_BY_OTHER', message: t('任务执行租约由 {holder} 持有，不可重复认领', { holder: acquired.holder }), holder: acquired.holder }
      }
      // 投影写齐（附录 A 决策 3：权威在 exec_run_leases，投影保持现状兼容）
      const cas = this.acquireLock(issue.id, runId, agentKey)
      if (!cas.ok && cas.reason === 'locked_by_other') {
        // 投影残留他人运行中 run（迁移期脏投影）：以租约权威为准覆盖投影
        this.writeExecutionProjection(issue.id, runId, agentKey)
      }
      this.ensureIssueInProgress(issue)
      this.ctx.platformBus.emit(PlatformEvents.ExecIssueChanged, { issueId: issue.id, action: 'claimed', status: 'in_progress', runId, employeeId: input.employeeId })
      this.auditSafe({
        type: 'invoke', actorType: 'machine', actorId: `employee:${input.employeeId}`, actorName: agentKey,
        action: 'exec.work.claimed', resourceType: 'issue', resourceId: issue.id, resourceName: issue.title,
        result: 'ok', detail: `run=${runId} lease=${acquired.lease.id} v${acquired.lease.leaseVersion}${acquired.created ? '' : '（幂等续期）'}`,
      })
      return { ok: true, issueId: issue.id, runId, lease: acquired.lease, created: acquired.created }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'EXEC_HUB_UNAVAILABLE', message: t('执行中枢认领失败：{message}', { message }) }
    }
  }

  /** 续租/进度心跳：同主体、active、未过期才能续（否则 LEASE_STALE）。 */
  async renewLease(input: { runId: string; principalId: string; ttlMs?: number }): Promise<EmployeeLeaseResult> {
    try {
      if (!input.runId || !input.principalId) {
        return { ok: false, code: 'LEASE_STALE', message: t('续租参数不足：runId 与 principalId 必填（fail-closed）') }
      }
      const renewed = this.leaseStore.renew({ runId: input.runId, principalId: input.principalId, ttlMs: input.ttlMs })
      if (!renewed.ok) return { ok: false, code: 'LEASE_STALE', message: renewed.message }
      return { ok: true, lease: renewed.lease }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'EXEC_HUB_UNAVAILABLE', message: t('执行中枢续租失败：{message}', { message }) }
    }
  }

  /** exec_complete 的主体/run 所有权校验（D07）：跨员工/旧租约拒绝（端口口径从严：无租约记录亦拒绝）。 */
  async assertRunOwnership(input: { runId: string; principalId: string }): Promise<{ ok: true; lease: RunLeaseRecord } | { ok: false; code: ExecHubWorkDenyCode; message: string }> {
    try {
      if (!input.runId || !input.principalId) {
        return { ok: false, code: 'RUN_NOT_OWNED', message: t('所有权校验参数不足：runId 与 principalId 必填（fail-closed）') }
      }
      const lease = this.leaseStore.latestForRun(input.runId)
      const decision = decideCompleteOwnership({
        hasLeaseRecord: Boolean(lease),
        status: lease?.status ?? 'released',
        expired: lease ? new Date(lease.expiresAt).getTime() <= Date.now() : true,
        callerPrincipalId: input.principalId,
        leasePrincipalId: lease?.principalId ?? '',
      })
      if (decision.kind === 'deny') return { ok: false, code: decision.code, message: decision.reason }
      if (!lease) return { ok: false, code: 'RUN_NOT_OWNED', message: t('该 run 无有效执行租约，不归属当前调用主体') }
      return { ok: true, lease }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'EXEC_HUB_UNAVAILABLE', message: t('执行中枢所有权校验失败：{message}', { message }) }
    }
  }

  /** 停职/撤销联动：按 run 释放权威租约并清理 issue 投影（不改变 run 业务状态）。 */
  releaseForRun(runId: string, reason: string): void {
    if (!runId) return
    const released = this.leaseStore.release(runId, reason || 'released')
    this.releaseLocks(runId)
    if (released > 0) {
      this.auditSafe({
        type: 'change', actorType: 'machine', actorId: 'exec-hub', actorName: '执行中枢',
        action: 'exec.work.lease_released', resourceType: 'run', resourceId: runId,
        result: 'ok', detail: `leases=${released} reason=${reason || 'released'}`,
      })
    }
  }

  /** 统一准入（D06）：冻结/预算/权限（Agent 可解析时）+ P0 审批门禁（任务级恒查）。复用 processWake 同源函数。 */
  private admitAgentForClaim(issue: IssueRecord, agentKey: string): { ok: true } | { ok: false; code: 'ADMISSION_DENIED' | 'BUDGET_EXCEEDED' | 'APPROVAL_REQUIRED'; message: string } {
    const agentId = this.resolveAgentIdForIssue(issue, agentKey)
    const agent = agentId ? this.agentOf(agentId) : undefined
    if (agent) {
      if (this.isAgentFrozen(agent.id)) {
        return { ok: false, code: 'ADMISSION_DENIED', message: t('Agent 已冻结（预算超限联动），待解冻审批：{name}', { name: agent.name }) }
      }
      const budgetGate = this.checkAgentBudget(agent.id, agent.orgId)
      if (budgetGate.blocked) return { ok: false, code: 'BUDGET_EXCEEDED', message: t('预算熔断：{reason}', { reason: budgetGate.reason ?? t('预算已超限') }) }
      const scopes = this.agentScopes(agent.id)
      if (scopes === null || !(scopes.includes('exec.write') || scopes.includes('*'))) {
        return { ok: false, code: 'ADMISSION_DENIED', message: t('Agent 机器主体无 exec.write 权限（身份未纳管或权限收敛）') }
      }
    }
    if (issue.priority === 'P0' && !this.p0ApprovalPassed(issue.id)) {
      return { ok: false, code: 'APPROVAL_REQUIRED', message: t('P0 任务需先通过 exec.issue.run 审批（已自动挂单，等待放行）') }
    }
    return { ok: true }
  }

  /** 冻结检查（复用点：processWake 与员工认领准入同源）。 */
  private isAgentFrozen(agentId: string): boolean {
    try {
      return Boolean(this.ctx.agentRegistry && typeof this.ctx.agentRegistry.isFrozen === 'function' && this.ctx.agentRegistry.isFrozen(agentId))
    } catch {
      return false
    }
  }

  /** 认领准入的 Agent 解析：优先任务负责人，其次按 agentKey 匹配（id 直等 / 归一化名称）。 */
  private resolveAgentIdForIssue(issue: IssueRecord, agentKey: string): string | undefined {
    if (issue.assigneeAgentId && this.agentOf(issue.assigneeAgentId)) return issue.assigneeAgentId
    const normalized = normalizeAgentKey(agentKey)
    if (normalized) {
      const byId = this.agentOf(normalized)
      if (byId) return byId.id
      const byName = this.ctx.resourceCore.list('agent').find((candidate) => normalizeAgentKey(candidate.name) === normalized)
      if (byName) return byName.id
    }
    return issue.assigneeAgentId || undefined
  }

  /** 投影写齐（附录 A 决策 3：权威在 exec_run_leases，三字段降级为投影）。 */
  private writeExecutionProjection(issueId: string, runId: string, agentKey: string): void {
    this.issues().update(issueId, {
      executionRunId: runId,
      executionAgentKey: agentKey,
      executionLockedAt: new Date().toISOString(),
    })
  }

  /** 工具侧投影写入口（exec_claim 幂等分支复用；公开薄包装）。 */
  writeClaimProjectionForTool(issueId: string, runId: string, agentKey: string): void {
    this.writeExecutionProjection(issueId, runId, agentKey)
  }

  /** 任务进行中推进（认领/唤醒共用：todo → in_progress）。 */
  private ensureIssueInProgress(issue: IssueRecord): void {
    if (issue.status === 'todo') this.issues().update(issue.id, { status: 'in_progress' })
  }

  /** 租约释放的安全包装（租约面异常不阻断 run 收尾主链路）。 */
  private releaseLeasesSafe(runId: string, reason: string): void {
    try {
      this.leaseStore.release(runId, reason)
    } catch (error) {
      this.ctx.logger('exec-hub').warn(`租约释放异常（run=${runId} reason=${reason}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // -- 唤醒队列（E3） -------------------------------------------------------------

  enqueueWake(input: {
    orgId: string; issueId?: string; agentId?: string; trigger: WakeTrigger
    triggerDetail?: string; payload?: Record<string, unknown>; idempotencyKey?: string
  }): WakeRecord {
    // 幂等键去重：pending / deferred_issue_execution 期间的重复投递直接返回既有单
    if (input.idempotencyKey) {
      const existing = this.wakes().findOne((item) =>
        item.idempotencyKey === input.idempotencyKey
        && (item.status === 'pending' || item.status === 'deferred_issue_execution'))
      if (existing) return existing
    }
    const issue = input.issueId ? this.issues().get(input.issueId) : undefined
    const record = this.wakes().insert({
      id: newId('wake'),
      orgId: input.orgId || issue?.orgId || '',
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      trigger: input.trigger,
      ...(input.triggerDetail ? { triggerDetail: input.triggerDetail } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
      status: 'pending',
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(issue?.goalAncestry ? { lineageSnapshot: issue.goalAncestry } : {}),
      createdAt: new Date().toISOString(),
    })
    this.ctx.platformBus.emit(PlatformEvents.ExecWakeEnqueued, {
      wakeId: record.id, trigger: record.trigger, issueId: record.issueId, agentId: record.agentId,
    })
    return record
  }

  // -- 心跳循环（E3/R9） ----------------------------------------------------------

  async tick(): Promise<TickResult> {
    const result: TickResult = { processed: 0, woken: 0, deferred: 0, skipped: 0, failed: 0, reclaimed: 0, routineFired: 0, heartbeatDue: 0 }
    // 1. 僵尸锁回收
    result.reclaimed = this.reclaimZombieLocks()
    // 2. 例行规则到期 → 入队 routine 唤醒
    result.routineFired = this.fireDueRoutines()
    // 3. 心跳到期（配置了 heartbeatIntervalMinutes 的运行态 Agent）→ 入队 routine 唤醒
    result.heartbeatDue = this.enqueueDueHeartbeats()
    // 4. 处理 pending + deferred 唤醒（先进先出，批量上限）
    const batch = this.wakes().all()
      .filter((item) => item.status === 'pending' || item.status === 'deferred_issue_execution')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, BATCH_SIZE)
    for (const wake of batch) {
      result.processed += 1
      const outcome = this.processWake(wake.id)
      if (outcome === 'woken') result.woken += 1
      else if (outcome === 'deferred') result.deferred += 1
      else if (outcome === 'failed') result.failed += 1
      else result.skipped += 1
    }
    // 5. 心跳留痕滚动保留 7 天
    const cutoff = new Date(Date.now() - HEARTBEAT_RETENTION_MS).toISOString()
    for (const stale of this.heartbeats().all().filter((item) => item.at < cutoff)) this.heartbeats().remove(stale.id)
    return result
  }

  /** 例行规则到期判定（interval 到点 / cron 分钟命中且距上次 ≥60s / webhook 由端点即时入队）。 */
  private fireDueRoutines(nowMs = Date.now()): number {
    let fired = 0
    const now = new Date()
    for (const routine of this.routines().all().filter((item) => item.enabled)) {
      if (!routine.agentId || !this.agentOf(routine.agentId)) continue
      let due = false
      if (routine.kind === 'interval' && (routine.intervalMinutes ?? 0) > 0) {
        const last = routine.lastFiredAt ? new Date(routine.lastFiredAt).getTime() : 0
        due = nowMs - last >= routine.intervalMinutes! * 60_000
      } else if (routine.kind === 'cron' && routine.cron && cronIsValid(routine.cron)) {
        const last = routine.lastFiredAt ? new Date(routine.lastFiredAt).getTime() : 0
        due = cronMatches(routine.cron, now) && nowMs - last >= 60_000
      }
      if (!due) continue
      this.routines().update(routine.id, { lastFiredAt: new Date().toISOString() })
      this.enqueueWake({
        orgId: routine.orgId, agentId: routine.agentId, trigger: 'routine',
        triggerDetail: t('{name}（{kind}）', { name: routine.name, kind: routine.kind }),
        ...(routine.payload ? { payload: routine.payload } : {}),
        idempotencyKey: wakeIdempotencyKey('routine', [routine.id, Math.floor(nowMs / 60_000)]),
      })
      fired += 1
    }
    return fired
  }

  /** 心跳到期（R9）：运行态 + 配置间隔 + 距上次唤醒 ≥ 间隔 → 入队心跳唤醒。 */
  private enqueueDueHeartbeats(nowMs = Date.now()): number {
    let due = 0
    for (const agent of this.listRunnableAgents()) {
      const interval = Number(agent.attrs['heartbeatIntervalMinutes'] ?? 0)
      if (!(interval > 0)) continue
      const lastHeartbeat = this.heartbeats().all()
        .filter((item) => item.agentId === agent.id)
        .sort((a, b) => b.at.localeCompare(a.at))[0]
      const lastMs = lastHeartbeat ? new Date(lastHeartbeat.at).getTime() : 0
      if (nowMs - lastMs < interval * 60_000) continue
      this.enqueueWake({
        orgId: agent.orgId ?? '', agentId: agent.id, trigger: 'routine',
        triggerDetail: `heartbeat:${interval}m`,
        idempotencyKey: wakeIdempotencyKey('hb', [agent.id, Math.floor(nowMs / (interval * 60_000))]),
      })
      due += 1
    }
    return due
  }

  private listRunnableAgents() {
    return this.ctx.resourceCore.list('agent').filter((agent) => agent.status === 'online' || agent.status === 'trial')
  }

  private agentOf(agentId: string) {
    return agentId ? this.ctx.resourceCore.collection('agent').get(agentId) : undefined
  }

  /**
   * 单条唤醒处理（治理五联动顺序：预算前置 → 冻结检查 → 权限校验 → 审批门禁 → 取锁/合并/延迟）。
   * 返回处理结果分类（供 tick 计数）；全程同步段内完成 CAS，无 await 穿插。
   */
  private processWake(wakeId: string): 'woken' | 'deferred' | 'failed' | 'skipped' {
    const wake = this.wakes().get(wakeId)
    if (!wake) return 'skipped'
    const issue = wake.issueId ? this.issues().get(wake.issueId) : undefined
    if (wake.issueId && !issue) {
      this.wakes().update(wakeId, { status: 'cancelled', lastError: t('任务已删除') })
      return 'skipped'
    }
    if (issue && (issue.status === 'done' || issue.status === 'cancelled')) {
      this.wakes().update(wakeId, { status: 'cancelled', lastError: t('任务已{state}', { state: issue.status === 'done' ? t('完成') : t('取消') }) })
      return 'skipped'
    }
    const agentId = wake.agentId ?? issue?.assigneeAgentId ?? ''
    const agent = this.agentOf(agentId)
    if (!agent) {
      this.wakes().update(wakeId, { status: 'failed', lastError: t('负责人 Agent 不存在或未指定') })
      return 'failed'
    }
    if (agent.status !== 'online' && agent.status !== 'trial') {
      this.recordHeartbeat(agent, 'skipped_inactive', `状态 ${agent.status}`)
      this.wakes().update(wakeId, { status: 'failed', lastError: t('Agent 非运行态（{status}）', { status: agent.status }) })
      return 'failed'
    }

    // 联动①：冻结检查（R10：预算超限冻结后不再唤醒，直至解冻审批执行；与员工认领准入同源 isAgentFrozen）
    if (this.isAgentFrozen(agentId)) {
      this.recordHeartbeat(agent, 'skipped_frozen', wake.trigger)
      this.wakes().update(wakeId, { status: 'failed', lastError: t('Agent 已冻结（预算超限联动），待解冻审批') })
      this.auditSafe({
        type: 'invoke', actorType: 'machine', actorId: 'exec-hub', actorName: '执行中枢',
        action: 'exec.wakeup.frozen_skipped', resourceType: 'agent', resourceId: agentId,
        resourceName: agent.name, result: 'denied', detail: `wake=${wakeId} trigger=${wake.trigger}`,
      })
      return 'failed'
    }

    // 联动②：预算前置（E6——平台独有增值：超限直接不唤醒，而非事后记账报警）
    const budgetGate = this.checkAgentBudget(agentId, agent.orgId)
    if (budgetGate.blocked) {
      this.wakes().update(wakeId, { status: 'failed', budgetCheckPassed: false, lastError: t('预算熔断：{reason}', { reason: budgetGate.reason ?? '' }) })
      this.recordHeartbeat(agent, 'skipped_budget', budgetGate.reason)
      this.auditSafe({
        type: 'invoke', actorType: 'machine', actorId: 'exec-hub', actorName: '执行中枢',
        action: 'exec.wakeup.budget_denied', resourceType: 'agent', resourceId: agentId,
        resourceName: agent.name, result: 'denied', detail: `wake=${wakeId} ${budgetGate.reason}`,
      })
      // 超额联动冻结（R10）：预算标记 freezeAgent 时冻结 Agent 并生成 L4 解冻审批（复用审批基建，天然带二次确认）
      if (budgetGate.freezeAgent && this.ctx.agentRegistry && typeof this.ctx.agentRegistry.freezeAgent === 'function' && !this.ctx.agentRegistry.isFrozen(agentId)) {
        try {
          this.ctx.agentRegistry.freezeAgent(agentId, t('执行中枢预算前置熔断：{reason}', { reason: budgetGate.reason ?? '' }), 'exec-hub')
        } catch (error) {
          this.ctx.logger('exec-hub').warn(`联动冻结失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return 'failed'
    }
    this.wakes().update(wakeId, { budgetCheckPassed: true })

    // 联动③：权限校验（#7 解耦：存活心跳只要求 exec.read——评价官/验收官等只读角色也参与心跳调度；
    // exec.write 在真正写路径（创建 run / 派发执行）上单独校验，见下方联动③b）
    const scopes = this.agentScopes(agentId)
    if (scopes === null || !(scopes.includes('exec.read') || scopes.includes('*'))) {
      this.wakes().update(wakeId, { status: 'failed', lastError: t('Agent 机器主体无 exec.read 权限（身份未纳管或权限收敛），存活监测无法成立') })
      this.recordHeartbeat(agent, 'skipped_permission', 'exec.read 缺失')
      this.auditSafe({
        type: 'authz', actorType: 'machine', actorId: `agent:${agentId}`, actorName: agent.name,
        action: 'exec.wakeup', resourceType: 'issue', resourceId: issue?.id ?? agentId,
        resourceName: issue?.title ?? agent.name, result: 'denied',
        detail: `机器主体缺少 exec.read（wake=${wakeId}）`,
      })
      this.ctx.platformBus.emit('audit.authz.denied', {
        actorId: agentId, actorName: agent.name, point: 'exec.read', path: `exec:wake:${wakeId}`,
      })
      return 'failed'
    }

    // Agent 级心跳唤醒（无 issue）：拉取待办 → 有则派发（上下文=待办清单），无则跳过
    if (!issue) {
      const todos = this.collectTodos(agent)
      if (todos.total === 0) {
        this.recordHeartbeat(agent, 'skipped_no_todo')
        this.wakes().update(wakeId, { status: 'done' })
        return 'skipped'
      }
      // 只读角色有待办：心跳成立（存活），但不派发——非错误收尾，不记 status=failed（#7）
      if (!(scopes.includes('exec.write') || scopes.includes('*'))) {
        this.recordHeartbeat(agent, 'skipped_permission', t('{n} 项待办未派发（只读主体，缺 exec.write）', { n: todos.total }))
        this.wakes().update(wakeId, { status: 'done' })
        return 'skipped'
      }
      const pack = this.buildAgentTodoPack(agent, todos)
      const run = this.createRun({ orgId: agent.orgId ?? '', agentId, issueIds: [], trigger: wake.trigger, contextPack: pack })
      this.wakes().update(wakeId, { status: 'run', runId: run.id })
      this.recordHeartbeat(agent, 'woken', `${todos.total} 项待办`, todos.total)
      this.auditSafe({
        type: 'invoke', actorType: 'machine', actorId: 'exec-hub', actorName: '执行中枢',
        action: 'exec.wakeup.dispatched', resourceType: 'agent', resourceId: agentId,
        resourceName: agent.name, result: 'ok', detail: `run=${run.id} trigger=${wake.trigger} 待办=${todos.total}`,
      })
      return 'woken'
    }

    // 联动③b：任务执行路径须 exec.write（#7：写权限与存活心跳解耦后，在真正写路径收口）
    if (!(scopes.includes('exec.write') || scopes.includes('*'))) {
      this.wakes().update(wakeId, { status: 'failed', lastError: t('Agent 机器主体无 exec.write 权限（身份未纳管或权限收敛）') })
      this.recordHeartbeat(agent, 'skipped_permission', 'exec.write 缺失')
      this.auditSafe({
        type: 'authz', actorType: 'machine', actorId: `agent:${agentId}`, actorName: agent.name,
        action: 'exec.wakeup', resourceType: 'issue', resourceId: issue.id,
        resourceName: issue.title, result: 'denied',
        detail: `机器主体缺少 exec.write（wake=${wakeId}）`,
      })
      this.ctx.platformBus.emit('audit.authz.denied', {
        actorId: agentId, actorName: agent.name, point: 'exec.write', path: `exec:wake:${wakeId}`,
      })
      return 'failed'
    }

    // 联动④：审批门禁（P0=高危任务：执行前须 exec.issue.run 审批 executed）
    if (issue.priority === 'P0' && !this.p0ApprovalPassed(issue.id)) {
      const deferred = this.wakes().update(wakeId, { status: 'deferred_issue_execution', lastError: t('P0 任务待审批放行') })
      this.recordHeartbeat(agent, 'deferred', `P0 审批 ${issue.id}`)
      return deferred ? 'deferred' : 'failed'
    }

    // 三态裁决（决策=domain 纯函数；CAS=下方护栏）
    const decision = decideWakeAdmission({
      isSameExecutionAgent: issue.executionAgentKey === normalizeAgentKey(agent.name),
      shouldDeferFollowupWake: false,
      shouldQueueFollowupForRunningWake: false,
      availableActiveExecutionRunPresent: Boolean(issue.executionRunId),
    })
    if (decision.kind === 'defer') {
      this.wakes().update(wakeId, { status: 'deferred_issue_execution', lastError: t('执行锁由 {runId} 持有', { runId: issue.executionRunId ?? '' }) })
      return 'deferred'
    }
    const agentKey = normalizeAgentKey(agent.name)
    let runId: string
    if (decision.kind === 'coalesce') {
      runId = issue.executionRunId!
    } else {
      const run = this.createRun({
        orgId: issue.orgId, agentId, issueIds: [issue.id], trigger: wake.trigger,
        contextPack: this.buildIssueContext(issue, agent),
      })
      runId = run.id
    }
    // CAS 护栏：并发下仅一方成功（决策层不依赖它，它只防重复取锁）
    const acquired = this.acquireLock(issue.id, runId, agentKey)
    if (!acquired.ok) {
      this.wakes().update(wakeId, { status: 'deferred_issue_execution', lastError: t('取锁竞争失败（{holder} 持有）', { holder: acquired.holder ?? '' }) })
      return 'deferred'
    }
    if (decision.kind === 'coalesce') {
      const run = this.runs().get(runId)
      if (run && !run.issueIds.includes(issue.id)) this.runs().update(runId, { issueIds: [...run.issueIds, issue.id] })
    }
    if (issue.status === 'todo') this.issues().update(issue.id, { status: 'in_progress' })
    this.wakes().update(wakeId, { status: 'run', runId })
    this.ctx.platformBus.emit(PlatformEvents.ExecIssueChanged, { issueId: issue.id, action: 'dispatched', status: 'in_progress', runId })
    this.auditSafe({
      type: 'invoke', actorType: 'machine', actorId: 'exec-hub', actorName: '执行中枢',
      action: 'exec.wakeup.dispatched', resourceType: 'issue', resourceId: issue.id,
      resourceName: issue.title, result: 'ok',
      detail: `run=${runId} trigger=${wake.trigger} 决策=${decision.kind} agent=${agent.name}`,
    })
    return 'woken'
  }

  /** Agent 机器主体有效 scopes（principal 缺席/禁用 = null，fail-closed）。 */
  private agentScopes(agentId: string): string[] | null {
    try {
      const principal = this.ctx.authn.principals().findOne((item) =>
        item.type === 'machine' && item.refType === 'agent' && item.refId === agentId && item.status !== 'disabled')
      if (!principal) return null
      return this.ctx.authn.resolveMachineScopes(principal)
    } catch {
      return null
    }
  }

  /**
   * 预算前置检查（E6 联动②）：读 modelgw Agent 主体预算（B 组契约方法
   * budgetStatusForSubject）。方法缺席（旧版 modelgw）放行——invoke 时点的
   * enforceBudget 仍是硬闸；方法存在但抛错则 fail-closed 拒绝派发。
   */
  private checkAgentBudget(agentId: string, orgId?: string): { blocked: boolean; reason?: string; freezeAgent?: boolean } {
    const modelGateway = this.ctx.modelGateway as unknown as {
      budgetStatusForSubject?: (subject: string, orgId?: string) => Array<{
        budget: { action?: string; freezeAgent?: boolean; subject?: string }
        daily: { breached?: boolean } | null
        monthly: { breached?: boolean } | null
      }>
    }
    if (typeof modelGateway?.budgetStatusForSubject !== 'function') return { blocked: false }
    let statuses: ReturnType<NonNullable<typeof modelGateway.budgetStatusForSubject>>
    try {
      statuses = modelGateway.budgetStatusForSubject(`agent:${agentId}`, orgId)
    } catch (error) {
      return { blocked: true, reason: t('预算检查失败（fail-closed）：{message}', { message: error instanceof Error ? error.message : String(error) }) }
    }
    for (const item of statuses ?? []) {
      const breached = item.daily?.breached || item.monthly?.breached
      if (breached && item.budget.action === 'block') {
        return {
          blocked: true, freezeAgent: item.budget.freezeAgent === true,
          reason: t('Agent 主体预算（{subject}）已超限，action=block', { subject: item.budget.subject ?? '' }),
        }
      }
    }
    return { blocked: false }
  }

  /** P0 审批门禁：无 executed 的 exec.issue.run 审批单时自动挂单（幂等：已有 pending/executed 即不再开）。 */
  private p0ApprovalPassed(issueId: string): boolean {
    const approvals = this.ctx.opsStorage.collection<{ kind?: string; status?: string; payload?: Record<string, unknown>; orgId?: string }>('audit:approvals')
    const related = approvals.all().filter((item) =>
      item.kind === 'exec.issue.run' && String(item.payload?.['issueId'] ?? '') === issueId)
    if (related.some((item) => item.status === 'executed')) return true
    if (related.some((item) => item.status === 'pending')) return false
    const issue = this.issues().get(issueId)
    try {
      this.ctx.audit.createApproval({
        kind: 'exec.issue.run',
        title: t('P0 任务执行审批：「{title}」', { title: issue?.title ?? issueId }),
        riskLevel: 'high',
        payload: { issueId, title: issue?.title ?? '' },
        ...(issue?.orgId ? { orgId: issue.orgId } : {}),
      })
    } catch { /* 审批面缺席时门禁保持拦截（fail-closed），下轮 tick 重试挂单 */ }
    return false
  }

  private recordHeartbeat(agent: { id: string; name: string; orgId?: string }, outcome: HeartbeatOutcome, detail?: string, issueCount?: number): void {
    try {
      this.heartbeats().insert({
        id: newId('hb'), agentId: agent.id, orgId: agent.orgId ?? '',
        at: new Date().toISOString(), outcome, ...(detail ? { detail } : {}),
        ...(issueCount !== undefined ? { issueCount } : {}),
      })
      this.ctx.platformBus.emit(PlatformEvents.ExecHeartbeatRecorded, { agentId: agent.id, outcome })
    } catch { /* 留痕失败不阻断调度 */ }
  }

  // -- 待办拉取与上下文装配（R9 + E4） --------------------------------------------

  /** Agent 待办三源：exec 任务（todo）+ 部门面板任务（todo/doing）+ 事务流 Agent 步骤（pending/running）。 */
  collectTodos(agent: { id: string; name: string }): { total: number; issues: number; panelTasks: number; flowSteps: number } {
    const issues = this.issues().all().filter((item) => item.assigneeAgentId === agent.id && item.status === 'todo').length
    let panelTasks = 0
    try {
      panelTasks = this.ctx.opsStorage.collection<{ assigneeType?: string; assigneeName?: string; lane?: string }>('panel:tasks')
        .all().filter((item) => item.assigneeType === 'agent' && item.assigneeName === agent.name
          && (item.lane === 'todo' || item.lane === 'doing')).length
    } catch { /* 面板集合缺席（独立形态）按 0 计 */ }
    let flowSteps = 0
    try {
      for (const flow of this.ctx.flow.flows().all().filter((item) => item.status === 'running')) {
        flowSteps += flow.steps.filter((step) => step.actorType === 'agent' && step.assignee === agent.name
          && (step.status === 'pending' || step.status === 'running')).length
      }
    } catch { /* 事务流服务缺席按 0 计 */ }
    return { total: issues + panelTasks + flowSteps, issues, panelTasks, flowSteps }
  }

  private buildIssueContext(issue: IssueRecord, agent: { attrs?: Record<string, unknown> }): string {
    const ancestry = issue.goalAncestry ?? []
    const titles: Record<string, string> = {}
    for (const id of ancestry) {
      const goal = this.goals().get(id)
      if (goal) {
        titles[id] = goal.metric
          ? `${goal.title}（指标：${goal.metricBaseline ?? '—'} → ${goal.metricTarget ?? '—'} ${goal.metricUnit ?? ''}）`.trim()
          : goal.title
        continue
      }
      const project = this.projects().get(id)
      if (project) titles[id] = project.name
    }
    const project = issue.projectId ? this.projects().get(issue.projectId) : undefined
    const blockers = (issue.blockerIds ?? [])
      .map((bid) => this.issues().get(bid)?.title ?? bid)
    return buildIssueContextPack({
      goalTitle: ancestry.length > 0 ? titles[ancestry[ancestry.length - (project ? 2 : 1)] ?? ''] ?? undefined : undefined,
      goalMetric: undefined,
      projectNames: project ? [project.name] : [],
      issueTitle: issue.title,
      blockerTitles: blockers,
      dataClass: typeof agent.attrs?.['dataClass'] === 'string' ? String(agent.attrs['dataClass']) : undefined,
      permissionNote: '你被授予执行权（exec.write）；执行前请通过 exec_claim 取锁，完成后 exec_complete 交回',
    })
  }

  private buildAgentTodoPack(agent: { id: string; name: string; attrs?: Record<string, unknown> }, todos: { total: number; issues: number; panelTasks: number; flowSteps: number }): string {
    const lines = [
      '【例行唤醒】',
      `你有 ${todos.total} 项待办：执行任务 ${todos.issues}、面板任务 ${todos.panelTasks}、事务流步骤 ${todos.flowSteps}。`,
      '请依次认领（exec_claim）并完成后交回（exec_complete）。',
      '',
      '【可用范围】',
      typeof agent.attrs?.['dataClass'] === 'string' ? `可访问数据密级上限：${String(agent.attrs['dataClass'])}` : '',
    ]
    return lines.filter((line) => line !== '').join('\n')
  }

  /** 任务血缘视图（E5：exec_lineage 工具与详情抽屉共用）。 */
  issueLineage(issueId: string): {
    issue?: IssueRecord
    goal?: GoalRecord
    project?: ProjectRecord
    ancestry: Array<{ id: string; kind: 'goal' | 'project'; title: string }>
    blockers: Array<{ id: string; title: string; status?: IssueStatus }>
  } {
    const issue = this.issues().get(issueId)
    if (!issue) throw new Error(t('任务不存在：{id}', { id: issueId }))
    const project = issue.projectId ? this.projects().get(issue.projectId) : undefined
    const goal = project?.goalId ? this.goals().get(project.goalId) : undefined
    const ancestry = (issue.goalAncestry ?? []).map((id) => {
      const g = this.goals().get(id)
      if (g) return { id, kind: 'goal' as const, title: g.title }
      const p = this.projects().get(id)
      return { id, kind: 'project' as const, title: p?.name ?? id }
    })
    const blockers = (issue.blockerIds ?? []).map((bid) => {
      const blocker = this.issues().get(bid)
      return { id: bid, title: blocker?.title ?? bid, status: blocker?.status }
    })
    return { issue, goal, project, ancestry, blockers }
  }

  // -- 健康度与总览（R9） -----------------------------------------------------------

  agentsHealth(): Array<{
    agentId: string; name: string; status: string; orgRole?: string; rank?: string
    frozen: boolean; lastHeartbeatAt?: string; lastMetricsReportAt?: string
    health: AgentHealthLevel
  }> {
    const nowMs = Date.now()
    return this.ctx.resourceCore.list('agent').map((agent) => {
      const lastHeartbeat = this.heartbeats().all()
        // 权限、预算、冻结等拒绝记录不证明有效心跳，不能将失败刷新为健康。
        .filter((item) => item.agentId === agent.id && (item.outcome === 'woken' || item.outcome === 'skipped_no_todo'))
        .sort((a, b) => b.at.localeCompare(a.at))[0]
      let lastMetrics: { updatedAt: string } | undefined
      try {
        lastMetrics = this.ctx.agentRegistry.usage().all()
          .filter((item) => item.agentId === agent.id)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      } catch { /* usage 集合缺席按无提报计 */ }
      const frozen = (() => {
        try {
          return Boolean(this.ctx.agentRegistry.isFrozen?.(agent.id))
        } catch {
          return false
        }
      })()
      return {
        agentId: agent.id,
        name: agent.name,
        status: agent.status,
        orgRole: typeof agent.attrs?.['orgRole'] === 'string' ? String(agent.attrs['orgRole']) : undefined,
        rank: typeof agent.attrs?.['rank'] === 'string' ? String(agent.attrs['rank']) : undefined,
        frozen,
        lastHeartbeatAt: lastHeartbeat?.at,
        lastMetricsReportAt: lastMetrics?.updatedAt,
        health: computeAgentHealth({
          agentStatus: agent.status,
          frozen,
          lastHeartbeatAt: lastHeartbeat ? new Date(lastHeartbeat.at).getTime() : null,
          lastMetricsReportAt: lastMetrics ? new Date(lastMetrics.updatedAt).getTime() : null,
          nowMs,
          heartbeatIntervalMinutes: Number(agent.attrs?.['heartbeatIntervalMinutes'] ?? 0) || undefined,
        }),
      }
    })
  }

  overview(): Record<string, unknown> {
    const issues = this.issues().all()
    const issuesByStatus: Record<string, number> = {}
    for (const issue of issues) issuesByStatus[issue.status] = (issuesByStatus[issue.status] ?? 0) + 1
    const nowIso = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString()
    return {
      goals: this.goals().all().length,
      projects: this.projects().all().length,
      issuesByStatus,
      pendingWakes: this.wakes().all().filter((item) => item.status === 'pending').length,
      deferredWakes: this.wakes().all().filter((item) => item.status === 'deferred_issue_execution').length,
      activeRuns: this.runs().all().filter((item) => item.status === 'running').length,
      lockedIssues: issues.filter((item) => item.executionRunId).length,
      zombieLocks: issues.filter((item) => item.executionRunId && item.executionLockedAt && item.executionLockedAt < nowIso).length,
      agentsHealth: this.agentsHealth(),
    }
  }

  /**
   * 工作台驾驶舱聚合（设计适配规格 5.1，2026-10-14，只读 additive）：
   * GET /api/exec/overview 在既有 overview() 字段之上增量并入本方法结果（旧字段不动）。
   *
   * 字段口径（全部真实数据派生，无硬编码话术）：
   *   - insight.text：由「目标达成度（achieved 占比 + 关联任务完成率）+ 未读告警分级 +
   *     今日调用/消耗」拼装的真实中文结论；目标与告警双缺时给出零数据口径说明。
   *   - insight.exceptions：未读告警（critical/warning）+ MCP 熔断态 + 模型预算 breach——
   *     {name, level, chain, owner}，owner 尽力解析到资产负责人，解析不到给空串。
   *   - kpis.assets：六类资产（mcp/agent/app/skill/model/nas）统一生命周期桶计数
   *     （online 含 gray/trial/published/deprecated 仍在册口径）。
   *   - kpis.callsToday/tokensToday/costToday：usage 今日窗口（UTC 日界）真实聚合。
   *   - kpis.risk：未读告警 critical/warning 计数（info 不计）。
   */
  cockpit(): { insight: { text: string; exceptions: Array<{ name: string; level: 'critical' | 'warning'; chain: string; owner: string }> }; kpis: { assets: { total: number; online: number; draft: number; deprecated: number }; callsToday: number; tokensToday: number; costToday: number; risk: { critical: number; warning: number } } } {
    // -- 今日用量（UTC 日界，与 modelgw budgetStatus 窗口口径一致） ----------------
    const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
    let callsToday = 0
    let tokensToday = 0
    let costToday = 0
    try {
      const summary = this.ctx.usage.summary({ from: todayStart, to: new Date().toISOString() })
      callsToday = summary.byResource.reduce((sum, row) => sum + row.events, 0)
      tokensToday = summary.input_tokens + summary.output_tokens
      costToday = summary.cost_cents
    } catch { /* usage 面缺席（独立宿主形态）按零值呈现，不阻塞总览 */ }

    // -- 六类资产统一计数（与 plugin-console /api/fleet/ledger 同一套生命周期映射） --
    const buckets = { total: 0, online: 0, draft: 0, deprecated: 0 }
    const countAsset = (status: string, deprecated = false): void => {
      buckets.total++
      if (deprecated || ['online', 'gray', 'trial', 'published', 'unhealthy'].includes(status)) buckets.online++
      else if (['draft', 'verifying', 'pending_approval', 'scanning'].includes(status)) buckets.draft++
      if (deprecated) buckets.deprecated++
    }
    const ownerNameOf = (userId: string): string => {
      try {
        return this.ctx.iam.users().get(userId)?.displayName ?? userId
      } catch {
        return userId
      }
    }
    const mcpServices = (() => {
      try { return this.ctx.mcpRegistry.services().all() } catch { return [] }
    })()
    const skills = (() => {
      try { return this.ctx.skillHub.skills().all() } catch { return [] }
    })()
    const apps = (() => {
      try { return this.ctx.resourceCore.list('app') } catch { return [] }
    })()
    const nasList = (() => {
      try { return this.ctx.nasRegistry.list() } catch { return [] }
    })()
    const models = (() => {
      try { return this.ctx.modelGateway.models().all() } catch { return [] }
    })()
    for (const service of mcpServices) countAsset(service.status)
    for (const agent of this.ctx.resourceCore.list('agent')) countAsset(agent.status)
    for (const app of apps) countAsset(app.status)
    for (const skill of skills) countAsset(skill.status, skill.status === 'deprecated')
    for (const model of models) countAsset(model.status)
    for (const nas of nasList) countAsset(nas.status)

    // -- 异常面：未读告警 + MCP 熔断 + 模型预算超限（真实状态，不虚构） ------------
    const exceptions: Array<{ name: string; level: 'critical' | 'warning'; chain: string; owner: string }> = []
    let critical = 0
    let warning = 0
    try {
      for (const alert of this.ctx.audit.alerts().find((item) => !item.read)) {
        if (alert.severity === 'critical') critical++
        else if (alert.severity === 'warning') warning++
        else continue
        if (exceptions.length >= 8) continue
        const owner = alert.resourceType === 'mcp_service' || alert.resourceType === 'mcp'
          ? mcpServices.find((item) => item.id === alert.resourceId)?.owner ?? ''
          : alert.resourceType === 'agent'
            ? ownerNameOf(this.ctx.resourceCore.collection('agent').get(alert.resourceId ?? '')?.ownerId ?? '')
            : ''
        exceptions.push({ name: alert.title, level: alert.severity as 'critical' | 'warning', chain: `${alert.ruleId ?? 'ad-hoc'}${alert.resourceType ? ` → ${alert.resourceType}:${alert.resourceId ?? ''}` : ''}`, owner })
      }
    } catch { /* 审计面缺席按无告警计 */ }
    for (const service of mcpServices) {
      if (!service.health.breakerOpen) continue
      critical++
      if (exceptions.length < 8) exceptions.push({ name: t('MCP 熔断：{name}', { name: service.name }), level: 'critical', chain: `mcp:${service.slug}`, owner: service.owner })
    }
    for (const model of models) {
      if (model.status === 'online' && model.endpoint.trim() === '') {
        warning++
        if (exceptions.length < 8) exceptions.push({ name: t('模型路由已上线但未配置 endpoint：{name}', { name: model.displayName }), level: 'warning', chain: `model:${model.slug}`, owner: model.provider })
      }
    }

    // -- 目标达成度（achieved 占比 + 关联任务完成率——真实派生） ------------------
    const goals = this.goals().all()
    const issues = this.issues().all()
    const activeGoals = goals.filter((goal) => goal.status === 'active')
    const achieved = goals.filter((goal) => goal.status === 'achieved').length
    const doneIssues = issues.filter((issue) => issue.status === 'done').length
    const goalCompletion = goals.length > 0 ? Math.round((achieved / goals.length) * 100) : null
    const issueCompletion = issues.length > 0 ? Math.round((doneIssues / issues.length) * 100) : null

    // -- 洞察文案：全部由上方真实数字拼装（禁止硬编码场景话术） -------------------
    const bits: string[] = []
    if (goals.length > 0) {
      bits.push(t('目标 {total} 项（进行中 {active}、已达成 {achieved}，达成率 {rate}%）', { total: goals.length, active: activeGoals.length, achieved, rate: goalCompletion }))
      if (issues.length > 0) bits.push(t('关联任务完成率 {rate}%（{done}/{total}）', { rate: issueCompletion, done: doneIssues, total: issues.length }))
    } else {
      bits.push(t('尚无登记目标——可在执行中枢创建季度目标并拆解行动项目'))
    }
    if (critical > 0) bits.push(t('存在 {count} 项严重告警需立即处理', { count: critical }))
    else if (warning > 0) bits.push(t('存在 {count} 项一般告警建议关注', { count: warning }))
    else bits.push(t('当前无未读告警'))
    bits.push(t('今日已计量调用 {calls} 次、tokens {tokens}、内部成本参考 {cost} 分', { calls: callsToday, tokens: tokensToday.toLocaleString('en-US'), cost: costToday }))

    return {
      insight: { text: bits.join('；') + '。', exceptions },
      kpis: { assets: buckets, callsToday, tokensToday, costToday, risk: { critical, warning } },
    }
  }

  /** 纳管提报催办（R9）：运行态 Agent 超 24h 未提报 → 告警催办（按日去重）。 */
  private async remindOverdueMetrics(): Promise<void> {
    const dayKey = new Date().toISOString().slice(0, 10)
    for (const agent of this.listRunnableAgents()) {
      const key = `${agent.id}:${dayKey}`
      if (this.metricsReminderDayKeys.has(key)) continue
      let last: { updatedAt: string } | undefined
      try {
        last = this.ctx.agentRegistry.usage().all()
          .filter((item) => item.agentId === agent.id)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      } catch { continue }
      const lastMs = last ? new Date(last.updatedAt).getTime() : 0
      if (lastMs !== 0 && Date.now() - lastMs < METRICS_OVERDUE_MS) continue
      this.metricsReminderDayKeys.add(key)
      this.ctx.audit?.fire?.({
        severity: 'warning',
        title: t('Agent「{name}」纳管指标超 24h 未提报', { name: agent.name }),
        message: t('执行中枢催办：请调用 POST /api/agents/:id/metrics-report 提报 dau/sessions，超期未报将影响健康度评估与预算窗口。'),
        resourceType: 'agent',
        resourceId: agent.id,
      })
    }
  }

  /** 审计留痕（audit 缺席静默降级——dsh-bridge softRead 同款防御）。 */
  private auditSafe(entry: Omit<AuditLogRecord, 'id' | 'createdAt' | 'updatedAt'>): void {
    try {
      this.ctx.audit?.record(entry)
    } catch { /* 审计面独立降级 */ }
  }
}

// ---------------------------------------------------------------------------
// REST + 工具 + 装配（/api/exec/*：guarded 自注册，鉴权依赖 console 中间件先行）
// ---------------------------------------------------------------------------

export function apply(ctx: Context) {
  const hub = new ExecutionHubService(ctx)
  const http = ctx.httpServer
  const { caller, guarded, body, actorOf } = createRestGate(ctx)

  const changeLog = (exchange: HttpExchange, action: string, resourceName: string, detail = ''): void => {
    const info = caller(exchange)
    try {
      ctx.audit?.record({
        type: 'change', actorType: info.kind === 'human' ? 'human' : 'machine',
        actorId: info.userId ?? info.principalId, actorName: info.name,
        action, resourceType: 'exec', resourceId: exchange.params['id'] ?? '', resourceName, result: 'ok', detail,
      })
    } catch { /* 审计面独立降级 */ }
  }

  // #16（2026-10-29）：exec 域组织血缘收口——显式空串 400；缺省继承调用主体组织
  //（console 鉴权中间件按用户/Agent 归属反查的 unified.orgId），再沿血缘（目标/项目/Agent）
  // 兜底，最终回落平台根组织；组织树未播种时保持 ''（与 seedExecHub 兜底一致，迁移函数幂等补齐）。
  const principalOrgId = (exchange: HttpExchange): string => {
    const unified = (exchange.principal as { unified?: { orgId?: string } } | undefined)?.unified
    return typeof unified?.orgId === 'string' ? unified.orgId : ''
  }
  const resolveOrgId = (exchange: HttpExchange, explicit: string | undefined, lineage: Array<string | undefined> = []): string => {
    if (explicit !== undefined) {
      const trimmed = explicit.trim()
      if (!trimmed) throw new Error(t('orgId 不接受空值：缺省请不传（自动继承组织血缘），显式指定请传非空组织 ID'))
      if (!ctx.iam.orgs().get(trimmed)) throw new Error(t('组织不存在：{id}', { id: trimmed }))
      return trimmed
    }
    return [principalOrgId(exchange), ...lineage].find((item) => item) ?? hub.rootOrgId() ?? ''
  }

  // -- 总览 / 健康（R9） ------------------------------------------------------
  // 设计适配（2026-10-14）：增量并入工作台驾驶舱聚合（insight/kpis）——既有字段原样保留，
  // 前端旧消费方（exec 页/tools）不受影响；cockpit() 为只读查询方法。
  guarded('GET', '/api/exec/overview', 'exec.read', () => ({ ...hub.overview(), ...hub.cockpit() }))

  // -- 目标（R8） ---------------------------------------------------------------
  guarded('GET', '/api/exec/goals', 'exec.read', (exchange) => {
    // #16：?orgId= 过滤（组织范围看板/成本归集的数据面）
    const orgId = exchange.query.get('orgId') ?? ''
    return { goals: hub.goals().all().filter((item) => !orgId || item.orgId === orgId) }
  })

  guarded('POST', '/api/exec/goals', 'exec.write', (exchange) => {
    const input = body<{ orgId?: string; title: string; description?: string; metric?: string; metricBaseline?: number; metricTarget?: number; metricUnit?: string; ownerUserId?: string; parentGoalId?: string; periodStart?: string; periodEnd?: string }>(exchange)
    const created = hub.createGoal({ ...input, orgId: resolveOrgId(exchange, input.orgId) })
    changeLog(exchange, 'exec.goal.create', created.title)
    return created
  })

  guarded('PATCH', '/api/exec/goals/:id', 'exec.write', (exchange) => {
    const input = body<{ title?: string; description?: string; metric?: string; metricBaseline?: number; metricTarget?: number; metricUnit?: string; ownerUserId?: string; parentGoalId?: string; periodStart?: string; periodEnd?: string; status?: GoalStatus }>(exchange)
    const updated = hub.updateGoal(exchange.params['id']!, input)
    changeLog(exchange, 'exec.goal.update', updated.title)
    return updated
  })

  guarded('DELETE', '/api/exec/goals/:id', 'exec.write', (exchange) => {
    const result = hub.deleteGoal(exchange.params['id']!)
    changeLog(exchange, 'exec.goal.delete', exchange.params['id'] ?? '')
    return result
  })

  // -- 项目（E4） -----------------------------------------------------------------
  guarded('GET', '/api/exec/projects', 'exec.read', (exchange) => {
    const issues = hub.issues().all()
    // #16：?orgId= 过滤
    const orgId = exchange.query.get('orgId') ?? ''
    return {
      projects: hub.projects().all()
        .filter((project) => !orgId || project.orgId === orgId)
        .map((project) => {
          const projectIssues = issues.filter((item) => item.projectId === project.id)
          return {
            ...project,
            issueProgress: { done: projectIssues.filter((item) => item.status === 'done').length, total: projectIssues.length },
          }
        }),
    }
  })

  guarded('POST', '/api/exec/projects', 'exec.write', (exchange) => {
    const input = body<{ orgId?: string; goalId?: string; name: string; description?: string; repos?: string[]; ownerUserId?: string }>(exchange)
    const goal = input.goalId ? hub.goals().get(input.goalId) : undefined
    const created = hub.createProject({ ...input, orgId: resolveOrgId(exchange, input.orgId, [goal?.orgId]) })
    changeLog(exchange, 'exec.project.create', created.name)
    return created
  })

  guarded('PATCH', '/api/exec/projects/:id', 'exec.write', (exchange) => {
    const input = body<{ goalId?: string; name?: string; description?: string; repos?: string[]; ownerUserId?: string; status?: ProjectStatus }>(exchange)
    const updated = hub.updateProject(exchange.params['id']!, input)
    changeLog(exchange, 'exec.project.update', updated.name)
    return updated
  })

  guarded('DELETE', '/api/exec/projects/:id', 'exec.write', (exchange) => {
    const result = hub.deleteProject(exchange.params['id']!)
    changeLog(exchange, 'exec.project.delete', exchange.params['id'] ?? '')
    return result
  })

  // -- 任务（E2/E4） ----------------------------------------------------------------
  guarded('GET', '/api/exec/issues', 'exec.read', (exchange) => {
    const status = exchange.query.get('status') ?? ''
    const agentId = exchange.query.get('agentId') ?? ''
    const projectId = exchange.query.get('projectId') ?? ''
    const orgId = exchange.query.get('orgId') ?? '' // #16：组织范围过滤
    const agents = ctx.resourceCore.list('agent')
    const projects = hub.projects().all()
    return {
      issues: hub.issues().all()
        .filter((item) => (!status || item.status === status)
          && (!agentId || item.assigneeAgentId === agentId)
          && (!projectId || item.projectId === projectId)
          && (!orgId || item.orgId === orgId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((item) => ({
          ...item,
          assigneeAgentName: agents.find((agent) => agent.id === item.assigneeAgentId)?.name,
          projectName: projects.find((project) => project.id === item.projectId)?.name,
        })),
    }
  })

  guarded('POST', '/api/exec/issues', 'exec.write', (exchange) => {
    const input = body<{ orgId?: string; projectId?: string; parentId?: string; blockerIds?: string[]; title: string; detail?: string; assigneeAgentId?: string; assigneeUserId?: string; priority?: IssuePriority; dueAt?: string }>(exchange)
    const project = input.projectId ? hub.projects().get(input.projectId) : undefined
    const assignee = input.assigneeAgentId ? ctx.resourceCore.collection('agent').get(input.assigneeAgentId) : undefined
    const created = hub.createIssue({
      ...input,
      orgId: resolveOrgId(exchange, input.orgId, [project?.orgId, assignee?.orgId]),
      createdBy: actorOf(exchange),
    })
    changeLog(exchange, 'exec.issue.create', created.title, `priority=${created.priority}${created.assigneeAgentId ? ' 已派发唤醒' : ''}`)
    return created
  })

  guarded('PATCH', '/api/exec/issues/:id', 'exec.write', (exchange) => {
    const input = body<{ title?: string; detail?: string; assigneeAgentId?: string; assigneeUserId?: string; projectId?: string; blockerIds?: string[]; priority?: IssuePriority; dueAt?: string }>(exchange)
    const updated = hub.updateIssue(exchange.params['id']!, input, actorOf(exchange))
    changeLog(exchange, 'exec.issue.update', updated.title)
    return updated
  })

  guarded('POST', '/api/exec/issues/:id/transition', 'exec.write', (exchange) => {
    const input = body<{ to: IssueStatus }>(exchange)
    const updated = hub.transitionIssue(exchange.params['id']!, input.to, actorOf(exchange))
    changeLog(exchange, 'exec.issue.transition', updated.title, `→ ${updated.status}`)
    return updated
  })

  guarded('DELETE', '/api/exec/issues/:id', 'exec.write', (exchange) => {
    const result = hub.deleteIssue(exchange.params['id']!)
    changeLog(exchange, 'exec.issue.delete', exchange.params['id'] ?? '')
    return result
  })

  guarded('POST', '/api/exec/issues/:id/wake', 'exec.write', (exchange) => {
    const input = body<{ reason?: string }>(exchange)
    const issue = hub.issues().get(exchange.params['id']!)
    if (!issue) { exchange.fail(404, 'NOT_FOUND', t('任务不存在：{id}', { id: exchange.params['id'] ?? '' })); return }
    if (!issue.assigneeAgentId) { exchange.fail(400, 'BAD_REQUEST', t('任务未指定负责人 Agent')); return }
    const wake = hub.enqueueWake({
      orgId: issue.orgId, issueId: issue.id, agentId: issue.assigneeAgentId, trigger: 'api',
      triggerDetail: input.reason ?? t('手动唤醒（{actor}）', { actor: actorOf(exchange) }),
      idempotencyKey: wakeIdempotencyKey('api', [issue.id, Date.now()]),
    })
    changeLog(exchange, 'exec.issue.wake', issue.title, wake.triggerDetail ?? '')
    return wake
  })

  guarded('GET', '/api/exec/lineage/:issueId', 'exec.read', (exchange) => hub.issueLineage(exchange.params['issueId']!))

  // -- 唤醒 / run ------------------------------------------------------------------
  guarded('GET', '/api/exec/wakes', 'exec.read', (exchange) => {
    const status = exchange.query.get('status') ?? ''
    const agents = ctx.resourceCore.list('agent')
    return {
      wakes: hub.wakes().all()
        .filter((item) => !status || item.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 200)
        .map((item) => ({
          ...item,
          agentName: agents.find((agent) => agent.id === item.agentId)?.name,
        })),
    }
  })

  guarded('GET', '/api/exec/runs', 'exec.read', (exchange) => {
    const status = exchange.query.get('status') ?? ''
    return { runs: hub.runs().all().filter((item) => !status || item.status === status).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 200) }
  })

  guarded('POST', '/api/exec/wakeup', 'exec.write', (exchange) => {
    const input = body<{ agentId?: string; issueId?: string; reason?: string }>(exchange)
    const wake = hub.enqueueWake({
      orgId: '', ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
      trigger: 'api', triggerDetail: input.reason ?? t('API 触发（{actor}）', { actor: actorOf(exchange) }),
      idempotencyKey: wakeIdempotencyKey('api', [input.issueId ?? input.agentId ?? '', Date.now()]),
    })
    changeLog(exchange, 'exec.wakeup', input.issueId ?? input.agentId ?? '', wake.triggerDetail ?? '')
    return wake
  })

  // -- 例行规则（E7） -----------------------------------------------------------------
  guarded('GET', '/api/exec/routines', 'exec.read', () => {
    const agents = ctx.resourceCore.list('agent')
    return {
      routines: hub.routines().all().map((item) => ({
        ...item,
        agentName: agents.find((agent) => agent.id === item.agentId)?.name,
      })),
    }
  })

  guarded('POST', '/api/exec/routines', 'exec.write', (exchange) => {
    const input = body<{ orgId?: string; agentId: string; name: string; kind: RoutineKind; intervalMinutes?: number; cron?: string; webhookPath?: string; payload?: Record<string, unknown>; enabled?: boolean }>(exchange)
    if (!input.name?.trim()) { exchange.fail(400, 'BAD_REQUEST', t('例行规则名称必填')); return }
    if (!input.agentId || !ctx.resourceCore.collection('agent').get(input.agentId)) { exchange.fail(400, 'BAD_REQUEST', t('负责人 Agent 不存在')); return }
    if (input.kind === 'interval' && !(Number(input.intervalMinutes) > 0)) { exchange.fail(400, 'BAD_REQUEST', t('interval 类型须提供正整数间隔分钟')); return }
    if (input.kind === 'cron') {
      if (!input.cron || !cronIsValid(input.cron)) { exchange.fail(400, 'BAD_REQUEST', t('cron 表达式非法（5 段：分 时 日 月 周，分钟粒度）')); return }
    }
    if (input.kind === 'webhook') {
      const path = (input.webhookPath ?? '').trim()
      if (!/^[a-z0-9-]{6,64}$/.test(path)) { exchange.fail(400, 'BAD_REQUEST', t('webhook 路径非法（小写字母/数字/-，6-64 位，路径即凭证请保持不可猜测）')); return }
      if (hub.routines().all().some((item) => item.webhookPath === path)) { exchange.fail(409, 'CONFLICT', t('webhook 路径已被占用')); return }
    }
    const created = hub.routines().insert({
      id: newId('rtn'),
      orgId: input.orgId ?? ctx.resourceCore.collection('agent').get(input.agentId)?.orgId ?? '',
      agentId: input.agentId,
      name: input.name.trim(),
      kind: input.kind,
      ...(input.kind === 'interval' ? { intervalMinutes: Number(input.intervalMinutes) } : {}),
      ...(input.kind === 'cron' ? { cron: input.cron!.trim() } : {}),
      ...(input.kind === 'webhook' ? { webhookPath: (input.webhookPath ?? '').trim() } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
      enabled: input.enabled ?? true,
      createdBy: actorOf(exchange),
    })
    changeLog(exchange, 'exec.routine.create', created.name, `${created.kind}`)
    ctx.platformBus.emit(PlatformEvents.ExecRoutineChanged, { routineId: created.id, action: 'created' })
    return created
  })

  guarded('PATCH', '/api/exec/routines/:id', 'exec.write', (exchange) => {
    const input = body<{ name?: string; intervalMinutes?: number; cron?: string; payload?: Record<string, unknown>; enabled?: boolean }>(exchange)
    if (input.cron !== undefined && input.cron !== '' && !cronIsValid(input.cron)) { exchange.fail(400, 'BAD_REQUEST', t('cron 表达式非法')); return }
    const updated = hub.routines().update(exchange.params['id']!, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.intervalMinutes !== undefined ? { intervalMinutes: Number(input.intervalMinutes) } : {}),
      ...(input.cron !== undefined && input.cron !== '' ? { cron: input.cron } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    })
    changeLog(exchange, 'exec.routine.update', updated.name)
    ctx.platformBus.emit(PlatformEvents.ExecRoutineChanged, { routineId: updated.id, action: 'updated' })
    return updated
  })

  guarded('DELETE', '/api/exec/routines/:id', 'exec.write', (exchange) => {
    hub.routines().remove(exchange.params['id']!)
    changeLog(exchange, 'exec.routine.delete', exchange.params['id'] ?? '')
    ctx.platformBus.emit(PlatformEvents.ExecRoutineChanged, { routineId: exchange.params['id'] ?? '', action: 'deleted' })
    return { deleted: true }
  })

  // -- 运维（手动 tick：测试与运维通道） ----------------------------------------------
  guarded('POST', '/api/exec/tick', 'exec.admin', async (exchange) => {
    const result = await hub.tick()
    changeLog(exchange, 'exec.tick', 'manual', `processed=${result.processed} woken=${result.woken} reclaimed=${result.reclaimed}`)
    return result
  })

  // -- Webhook 触发器（E7：路径即凭证——未登记/停用一律 404，不泄露存在性） ---------------
  http.register('POST', '/api/exec/webhook/:path', (exchange) => {
    const path = exchange.params['path'] ?? ''
    const routine = hub.routines().findOne((item) => item.kind === 'webhook' && item.webhookPath === path && item.enabled)
    if (!routine) {
      exchange.fail(404, 'NOT_FOUND', 'Not Found')
      return
    }
    const wake = hub.enqueueWake({
      orgId: routine.orgId, agentId: routine.agentId, trigger: 'webhook',
      triggerDetail: `webhook:${path}`,
      idempotencyKey: wakeIdempotencyKey('webhook', [routine.id, Date.now()]),
    })
    exchange.ok({ wakeId: wake.id, routine: routine.name })
  }, { access: 'public', selfValidated: true })

  // -- Agent 工具（E5：Agent 会话内直接调用，无需知晓执行中枢存在） --------------------
  const tools = ctx.tools
  if (tools) {
    tools.register(defineTool({
      name: 'exec_wakeup_status',
      description: '查看执行中枢唤醒队列状态（待唤醒/延迟中/活跃 run 数）。',
      permission: 'exec.read',
      parameters: {},
      output: { type: 'object', additionalProperties: true },
      async execute() {
        const overview = hub.overview() as { pendingWakes: number; deferredWakes: number; activeRuns: number; lockedIssues: number }
        return { pending: overview.pendingWakes, deferred: overview.deferredWakes, activeRuns: overview.activeRuns, lockedIssues: overview.lockedIssues }
      },
    }))

    tools.register(defineTool({
      name: 'exec_claim',
      description: '认领任务并取执行租约（幂等：同主体重复认领返回既有 run 不报错；他人持有则告知 locked_by_other；受管数字员工自动走统一准入与员工租约）。',
      permission: 'exec.write',
      parameters: { issueId: { type: 'string', required: true, description: '任务 ID' } },
      output: { type: 'object', additionalProperties: true },
      async execute(args, exec) {
        const issueId = String(args.issueId ?? '')
        // D05/D06 fail-closed：无调用主体不认领（身份不入工具参数，一律取 exec.principal）
        if (!exec.principal) throw new Error(t('缺少调用主体（exec.principal），拒绝认领（fail-closed）——请检查令牌与会话注入'))
        const issue = hub.issues().get(issueId)
        if (!issue) throw new Error(t('任务不存在：{id}', { id: issueId }))
        const principal = exec.principal
        // 受管数字员工路径（运行时结构化探测 workforce 服务，不进 inject——装配在 exec-hub 之后）。
        // 软读（同 dsh-bridge softRead 口径）：workforce 服务已由提供方声明进 ctx，cordis 严格注入下
        // `(ctx as any).workforceAdmission` 直访会被 get trap 硬抛「without inject」，必须走 reflect。
        const softRead = (key: string): unknown => {
          try {
            if (typeof (ctx as unknown as { reflect?: { get?: (k: string, optional?: boolean) => unknown } }).reflect?.get === 'function') {
              return (ctx as unknown as { reflect: { get: (k: string, optional?: boolean) => unknown } }).reflect.get(key, false)
            }
            return (ctx as unknown as Record<string, unknown>)[key]
          } catch {
            return undefined
          }
        }
        const admission = softRead('workforceAdmission') as { claimWork?: (caller: unknown, input: { issueId: string }) => Promise<unknown> } | undefined
        const identity = softRead('workforceIdentity') as { resolveByCaller?: (caller: unknown) => Promise<unknown> } | undefined
        const isManagedAgent = principal.kind === 'machine' && principal.refType === 'agent'
          && typeof admission?.claimWork === 'function' && typeof identity?.resolveByCaller === 'function'
        if (isManagedAgent) {
          // WorkCallerRef 形状（platform-core/workforce-port）：可信主体由令牌解析，禁止 args 传入
          const caller = {
            kind: 'machine' as const,
            principalId: principal.principalId,
            refType: principal.refType,
            refId: principal.refId,
            ...(principal.name ? { name: principal.name } : {}),
          }
          let resolution: unknown
          try {
            resolution = await identity.resolveByCaller!(caller)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { ok: false, code: 'POLICY_INTERNAL_ERROR', message: t('受管身份反查失败（fail-closed）：{message}', { message }) }
          }
          if (resolution) {
            // 命中受管员工 → 统一认领入口（准入/permit/能力清单/租约一次完成，不复制实现）
            const outcome = await admission.claimWork!(caller, { issueId }) as {
              ok: boolean
              employeeId?: string; agentId?: string; issueId?: string; runId?: string; idempotent?: boolean
              lease?: { id: string; leaseVersion: number; expiresAt: string }
              permit?: { id: string }; manifest?: { id: string }; tools?: Array<{ handle: string }>
              code?: string; message?: string; holder?: string
            }
            if (outcome.ok) {
              return {
                ok: true,
                issueId: outcome.issueId ?? issueId,
                runId: outcome.runId ?? '',
                employeeId: outcome.employeeId ?? '',
                ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
                leaseId: outcome.lease?.id ?? '',
                leaseVersion: outcome.lease?.leaseVersion ?? 0,
                expiresAt: outcome.lease?.expiresAt ?? '',
                ...(outcome.permit ? { permitId: outcome.permit.id } : {}),
                ...(outcome.manifest ? { manifestId: outcome.manifest.id } : {}),
                ...(outcome.tools ? { tools: outcome.tools.map((tool) => tool.handle) } : {}),
                idempotent: outcome.idempotent === true,
              }
            }
            const code = outcome.code ?? 'POLICY_INTERNAL_ERROR'
            const label = WORK_DENY_CODE_LABELS[code as keyof typeof WORK_DENY_CODE_LABELS]
            return {
              ok: false,
              code,
              message: outcome.message || (label ? t('{label}（code={code}）', { label: t(String(label)), code }) : t('认领被拒绝（code={code}）', { code })),
              ...(outcome.holder ? { holder: outcome.holder } : {}),
            }
          }
          // 非受管（resolveByCaller=null）→ 落回旧 exec_claim 语义（保持兼容）
        }
        // -- 旧语义（D05/D06 幂等修正版） -----------------------------------------
        // 机器主体只能认领指派给自己的任务（人类 exec.write 持有者不受此限）
        if (principal.kind === 'machine' && principal.refType === 'agent' && issue.assigneeAgentId !== principal.refId) {
          throw new Error(t('该任务未指派给你（no_permission）'))
        }
        const agent = issue.assigneeAgentId ? ctx.resourceCore.collection('agent').get(issue.assigneeAgentId) : undefined
        const agentKey = normalizeAgentKey(agent?.name ?? 'unknown')
        // 幂等①：权威租约已存在——同 agentKey（legacy 判同键）→ 返回既有 run；他人 → locked_by_other
        const active = hub.leaseStore.activeForIssue(issue.id)
        if (active) {
          const decision = decideLeaseClaim({
            activeLeasePresent: true,
            activeLeaseExpired: false,
            existingEmployeeId: active.employeeId,
            existingAgentKey: active.agentKey,
            requestedEmployeeId: '',
            requestedAgentKey: agentKey,
          })
          if (decision.kind === 'idempotent') {
            hub.leaseStore.renew({ leaseId: active.id })
            hub.writeClaimProjectionForTool(issue.id, active.runId, agentKey)
            return { ok: true, runId: active.runId, idempotent: true, leaseId: active.id, leaseVersion: active.leaseVersion }
          }
          return { ok: false, reason: 'locked_by_other', holder: active.runId }
        }
        // 幂等②：无租约但投影指向同主体的运行中 run（唤醒预取锁/旧认领）→ 采纳既有 run（V05）
        if (issue.executionRunId) {
          const existingRun = hub.runs().get(issue.executionRunId)
          if (existingRun && existingRun.status === 'running') {
            const sameSubject = principal.kind === 'machine' && principal.refType === 'agent'
              ? existingRun.agentId === principal.refId
              : existingRun.agentId === issue.assigneeAgentId
            if (sameSubject) {
              const adopted = hub.leaseStore.acquire({ issueId: issue.id, runId: existingRun.id, employeeId: '', agentKey, principalId: principal.principalId })
              if (adopted.ok) {
                hub.writeClaimProjectionForTool(issue.id, existingRun.id, agentKey)
                if (issue.status === 'todo') hub.issues().update(issue.id, { status: 'in_progress' })
                return { ok: true, runId: existingRun.id, idempotent: true, leaseId: adopted.lease.id, leaseVersion: adopted.lease.leaseVersion }
              }
              return { ok: false, reason: 'locked_by_other', holder: existingRun.id }
            }
            return { ok: false, reason: 'locked_by_other', holder: issue.executionRunId }
          }
          // run 缺失/已终态＝脏投影：继续新建（acquireLock 会覆盖残留投影）
        }
        const runId = newId('run')
        const acquired = hub.leaseStore.acquire({ issueId: issue.id, runId, employeeId: '', agentKey, principalId: principal.principalId })
        if (!acquired.ok) return { ok: false, reason: 'locked_by_other', holder: acquired.holder }
        const cas = hub.acquireLock(issue.id, runId, agentKey)
        if (!cas.ok) return { ok: false, reason: cas.reason, holder: cas.holder }
        hub.runs().insert({
          id: runId, orgId: issue.orgId,
          ...(issue.assigneeAgentId ? { agentId: issue.assigneeAgentId } : {}),
          issueIds: [issue.id], trigger: 'api', status: 'running',
          contextPack: agent ? hub.issueLineage(issue.id).ancestry.map((item) => item.title).join(' › ') : undefined,
          startedAt: new Date().toISOString(),
        })
        if (issue.status === 'todo') hub.issues().update(issue.id, { status: 'in_progress' })
        ctx.platformBus.emit(PlatformEvents.ExecIssueChanged, { issueId: issue.id, action: 'claimed', status: 'in_progress', runId })
        return { ok: true, runId, leaseId: acquired.lease.id, leaseVersion: acquired.lease.leaseVersion }
      },
    }))

    tools.register(defineTool({
      name: 'exec_complete',
      description: '交回产出并完结 run（run 级释放执行租约与锁；完成任务转待审 review，失败任务转回待办；需与认领主体一致）。',
      permission: 'exec.write',
      parameters: {
        runId: { type: 'string', description: 'run ID（exec_claim 返回）' },
        issueId: { type: 'string', description: '任务 ID（无 runId 时按其持有 run 收尾）' },
        summary: { type: 'string', description: '产出摘要' },
        status: { type: 'string', enum: ['completed', 'failed'], description: '缺省 completed；failed 时进行中任务转回待办' },
      },
      output: { type: 'object', additionalProperties: true },
      async execute(args, exec) {
        const principal = exec.principal
        const status = args.status === 'failed' ? 'failed' : 'completed'
        let runId = String(args.runId ?? '')
        if (!runId) {
          const issueId = String(args.issueId ?? '')
          const issue = issueId ? hub.issues().get(issueId) : undefined
          runId = issue?.executionRunId ?? ''
          if (!runId && !principal) {
            // 参数不足升级提示（D07 fail-closed，不静默放行）
            throw new Error(t('参数不足：既未提供 runId，也无法识别调用主体（exec.principal 缺失）——请携带 exec_claim 返回的 runId 重试；如身份异常请联系管理员升级人工处理'))
          }
          if (!runId) throw new Error(t('缺少 runId，或该任务未持有执行锁'))
        }
        // D07 主体/run 所有权校验：run 有租约记录时必须主体一致（旧租约拒绝 LEASE_STALE）
        const lease = hub.leaseStore.latestForRun(runId)
        const ownership = decideCompleteOwnership({
          hasLeaseRecord: Boolean(lease),
          status: lease?.status ?? 'released',
          expired: lease ? new Date(lease.expiresAt).getTime() <= Date.now() : true,
          callerPrincipalId: principal?.principalId ?? '',
          leasePrincipalId: lease?.principalId ?? '',
        })
        if (ownership.kind === 'deny') {
          throw new Error(t('{reason}（code={code}）', { reason: ownership.reason, code: ownership.code }))
        }
        const run = hub.completeRun(runId, {
          status,
          ...(args.summary ? { summary: String(args.summary) } : {}),
          ...(status === 'failed' ? { failedIssueDisposition: 'todo' as const } : {}),
        })
        return { ok: true, runId, status: run.status, releasedLock: true, ...(lease ? { leaseReleased: true } : {}) }
      },
    }))

    tools.register(defineTool({
      name: 'exec_lineage',
      description: '查看任务的目标血缘（目标 → 项目 → 任务 → 前置依赖），回答「为什么而干」。',
      permission: 'exec.read',
      parameters: { issueId: { type: 'string', required: true, description: '任务 ID' } },
      output: { type: 'object', additionalProperties: true },
      async execute(args) {
        const lineage = hub.issueLineage(String(args.issueId ?? ''))
        return {
          goal: lineage.goal ? { id: lineage.goal.id, title: lineage.goal.title, metric: lineage.goal.metric } : undefined,
          project: lineage.project ? { id: lineage.project.id, name: lineage.project.name } : undefined,
          ancestry: lineage.ancestry,
          blockers: lineage.blockers,
        }
      },
    }))
  }

  // -- 存量迁移（#16：空 orgId 归根组织，记审计，幂等） --------------------------------
  migrateEmptyExecOrgId(ctx, hub)

  // -- 演示种子（G3：DEMO_SEED 下制造业三部门示例；空库幂等） --------------------------
  seedExecHub(ctx, hub)
}

/**
 * #16（2026-10-29）存量迁移：Goal/Project/Issue 的空 orgId 记录归入平台根组织并留审计。
 * 幂等（只处理空串归属）；组织树未播种时跳过（下次启动补齐）——「空串 = 血缘断链」从此不可再入。
 */
function migrateEmptyExecOrgId(ctx: Context, hub: ExecutionHubService): void {
  const rootOrgId = hub.rootOrgId()
  if (!rootOrgId) return
  let migrated = 0
  const samples: string[] = []
  for (const [collection, kind] of [[hub.goals(), 'goal'], [hub.projects(), 'project'], [hub.issues(), 'issue']] as const) {
    for (const record of collection.all().filter((item) => !item.orgId)) {
      collection.update(record.id, { orgId: rootOrgId })
      migrated++
      if (samples.length < 5) samples.push(`${kind}:${record.id}`)
    }
  }
  if (migrated === 0) return
  try {
    ctx.audit?.record({
      type: 'change', actorType: 'system', actorId: 'exec-hub', actorName: t('执行中枢'),
      action: 'exec.orgid.migrate', resourceType: 'exec', resourceId: rootOrgId,
      resourceName: t('平台根组织'), result: 'ok',
      detail: t('存量空 orgId 归根组织（#16）：{count} 条，样例 {samples}', { count: migrated, samples: samples.join(', ') }),
    })
  } catch { /* 审计面独立降级 */ }
  ctx.logger('exec-hub').info(`存量 exec 记录空 orgId 已归根组织（#16）：${migrated} 条（${samples.join(', ')}${samples.length < migrated ? ' 等' : ''}）`)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    execHub: ExecutionHubService
  }
}

export const name = 'exec-hub'
export const inject = [
  'httpServer', 'opsStorage', 'platformBus', 'iam', 'authn', 'audit', 'tools',
  'modelGateway', 'resourceCore', 'agentRegistry', 'flow',
  // 设计适配（2026-10-14）cockpit() 驾驶舱聚合所需只读面（提供方均在 exec-hub 之前装配，
  // 见 boot-all.ts / cordis.yml 装配序列）：usage=今日计量聚合，其余为六类资产存量计数与异常面
  'usage', 'mcpRegistry', 'skillHub', 'nasRegistry',
  // 附录 A 决策 3（2026-10-15）：exec_run_leases 权威租约存储——txnStore 由 platform-core
  // 首位装配（boot-all.ts 第一插件），先于 exec-hub；workforce 侧服务一律运行时探测，不进本列表
  'txnStore',
]
