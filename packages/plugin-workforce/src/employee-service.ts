/**
 * 员工域服务（employee-service）—— 员工档案、技术 Agent 一对一运行绑定、停职/复岗/离岗联动。
 *
 * 职责（蓝本 §5/§8.1/§D.4，附录 A 决策 1）：
 *   - 员工↔Agent 一对一有效绑定：同 Agent 全平台仅一条 active 绑定（事务内校验 + 唯一域预检）；
 *   - employees.primaryAgentId 为冗余指针，由本服务在绑定事务内同步维护；
 *   - 停职/离岗联动：撤全部工作授权（permit）→ 释放执行租约（经 exec-hub 集成端口，
 *     结构化探测、不产生反向 import）→ 状态机流转 → 事件广播；
 *   - 订阅 agent.frozen：技术 Agent 被预算联动等冻结时，撤该 Agent 绑定员工的全部有效 permit。
 *
 * 失败语义诚实：联动链上「撤 permit」失败即中止停职（fail-closed）；
 * 「释放租约」经结构化探测，exec-hub 缺席时记录可观测事件（僵尸锁回收兜底），不冒充已释放。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId } from '../../platform-core/src/ids.ts'
import { WorkforceError } from './contract.ts'
import { t } from '../../platform-i18n/src/index.ts'
import type {
  BindingRecord,
  EmployeeRecord,
  EmployeeStatus,
  WorkCallerRef,
  WorkforceEmployees,
  WorkforcePermits,
} from './contract.ts'
import { employeeStatusTransition } from './domain.ts'
import type { WorkforceStoreService } from './repositories.ts'

function nowIso(): string {
  return new Date().toISOString()
}

/** exec-hub 员工工作路径的结构化探测形状（ExecHubWorkIntegration 子集；缺席＝联动能力缺失）。 */
interface ExecHubReleaseProbe {
  releaseForRun?(runId: string, reason: string): void
}

export class EmployeeService extends Service implements WorkforceEmployees {
  static readonly provide = 'workforceEmployees'

  constructor(ctx: Context) {
    super(ctx, 'workforceEmployees')

    // Agent 冻结联动（R10）：撤销该 agentId 绑定员工的全部有效 permit 并广播事件。
    // platformBus 未注入当前 fiber（独立单测形态）时防御跳过——联动缺失必须可观测，但不阻塞装配。
    try {
      ctx.platformBus.on('agent.frozen', (payload) => {
        this.handleAgentFrozen(payload)
      })
    } catch {
      /* 事件总线缺席：跳过订阅（服务在 index.ts 装配时依赖清单已含 platformBus） */
    }
  }

  // -- 内部取用 -----------------------------------------------------------

  private get store(): WorkforceStoreService {
    return this.ctx.workforceStore
  }

  private permits(): WorkforcePermits | undefined {
    return (this.ctx as unknown as { workforcePermits?: WorkforcePermits }).workforcePermits
  }

  private execHub(): ExecHubReleaseProbe | undefined {
    return (this.ctx as unknown as { execHub?: ExecHubReleaseProbe }).execHub
  }

  private emitEvent(name: string, payload: Record<string, unknown>): void {
    try {
      const bus = (this.ctx as unknown as { platformBus?: { emit(event: string, payload: unknown): unknown } }).platformBus
      bus?.emit(name, { ...payload, at: nowIso() })
    } catch {
      /* 事件总线缺席时跳过通知：状态事实已落库，联动方可经列表/审计补偿 */
    }
  }

  private actorOf(caller: WorkCallerRef | undefined): string {
    return caller?.userId ?? caller?.principalId ?? ''
  }

  // -- Agent 冻结联动 ------------------------------------------------------

  /** agent.frozen 处理：该 agentId 的 active 绑定员工 → 撤全部 permit + 发 workforce.permit.revoked。 */
  private handleAgentFrozen(payload: unknown): void {
    try {
      const p = (payload ?? {}) as { agentId?: string; reason?: string }
      if (!p.agentId) return
      const permits = this.permits()
      if (!permits) {
        this.emitEvent('workforce.permit.revoked', { agentId: p.agentId, revoked: 0, note: '工作授权服务未就绪，联动未执行' })
        return
      }
      const reason = t('技术 Agent 已冻结：{reason}', { reason: p.reason ?? t('原因未登记') })
      for (const binding of this.store.bindings.findWhere({ agentId: p.agentId, status: 'active' })) {
        const revoked = permits.revokeForEmployee(binding.employeeId, reason)
        this.emitEvent('workforce.permit.revoked', { agentId: p.agentId, employeeId: binding.employeeId, revoked, reason })
      }
    } catch (error) {
      // 监听器异常由总线死信机制兜底；此处不再抛出以免放大故障
      this.emitEvent('workforce.permit.revoked', { note: `Agent 冻结联动失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  // -- 员工档案 ------------------------------------------------------------

  create(input: {
    name: string
    displayName?: string
    orgId: string
    supervisorUserId: string
    agentId: string
    principalId?: string
    runtime?: string
  }): EmployeeRecord {
    const name = String(input.name ?? '').trim()
    const orgId = String(input.orgId ?? '').trim()
    const supervisorUserId = String(input.supervisorUserId ?? '').trim()
    const agentId = String(input.agentId ?? '').trim()
    if (name === '') throw new Error(t('创建数字员工必须登记员工名称'))
    if (orgId === '') throw new Error(t('创建数字员工必须登记主组织（orgId）'))
    if (supervisorUserId === '') throw new Error(t('创建数字员工必须登记真人主管（supervisorUserId）——主管是责任人，不自动成为代理用户'))
    if (agentId === '') throw new Error(t('创建数字员工必须绑定技术 Agent（agentId）'))

    const createdAt = nowIso()
    const employee: EmployeeRecord = {
      id: newId('emp'),
      name,
      displayName: String(input.displayName ?? '').trim() || name,
      orgId,
      supervisorUserId,
      status: 'active',
      primaryAgentId: agentId,
      createdAt,
      updatedAt: createdAt,
    }
    const binding: BindingRecord = {
      id: newId('bnd'),
      employeeId: employee.id,
      agentId,
      principalId: String(input.principalId ?? '').trim(),
      runtime: String(input.runtime ?? '').trim() || 'dsh',
      capabilityVersion: 1,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
    }

    // 同事务完成「唯一性域校验 + 员工建档 + 绑定建立」：一对一绑定是冻结决策（附录 A 决策 1）
    this.store.txn(() => {
      const conflict = this.store.bindings.findWhere({ agentId, status: 'active' })
      if (conflict.length > 0) {
        throw new WorkforceError('PRINCIPAL_BINDING_MISMATCH', t('该技术 Agent 已绑定其他数字员工'))
      }
      this.store.employees.insert(employee)
      this.store.bindings.insert(binding)
    })

    this.emitEvent('workforce.employee.changed', { employeeId: employee.id, name: employee.name, action: 'created', agentId, orgId })
    return employee
  }

  get(id: string): EmployeeRecord {
    const employee = this.store.employees.get(id)
    if (!employee) throw new Error(t('数字员工不存在：{id}', { id }))
    return employee
  }

  list(filter?: { orgId?: string; status?: EmployeeStatus }): EmployeeRecord[] {
    let rows = this.store.employees.all()
    if (filter?.orgId) rows = rows.filter((row) => row.orgId === filter.orgId)
    if (filter?.status) rows = rows.filter((row) => row.status === filter.status)
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  /**
   * 停职/复岗/离岗：状态机流转 + 联动。
   * 顺序纪律（fail-closed）：先收扰动面（撤 permit → 释放租约），后落状态——
   * 撤 permit 失败即中止停职（宁可员工保持在岗，不可留下「停职但 permit 横行」的窗口）；
   * 释放租约经 exec-hub 结构化探测，缺席/失败记录事件（僵尸锁回收兜底），不中止流程。
   */
  setStatus(caller: WorkCallerRef, id: string, status: EmployeeStatus, reason: string): EmployeeRecord {
    const employee = this.get(id)
    employeeStatusTransition(employee.status, status) // 非法流转在此抛中文错误
    const trimmedReason = String(reason ?? '').trim()
    if ((status === 'suspended' || status === 'offboarded') && trimmedReason === '') {
      throw new Error(t('停职/离岗必须登记原因（审计与解冻依据）'))
    }
    const actionLabel = status === 'suspended' ? t('停职') : status === 'offboarded' ? t('离岗') : t('复岗')

    // 1. 收集该员工当前持有 active permit 的 run（去重），并在撤销前经 activeForRun 复核归属
    //    （复核必须在撤销 permit 之前完成——撤销后 activeForRun 即为空）
    const activePermits = this.store.permits.findWhere({ employeeId: id, status: 'active' })
    const permits = this.permits()
    const runIds: string[] = []
    if (status === 'suspended' || status === 'offboarded') {
      for (const runId of new Set(activePermits.map((permit) => permit.runId).filter((item) => item !== ''))) {
        const active = permits?.activeForRun(runId)
        if (permits && (!active || active.employeeId !== id)) continue // activeForRun 复核不过：不释放该 run
        runIds.push(runId)
      }
    }

    // 2. 撤销全部工作授权（工作策略层先失效：新动作立即被拒，V07）
    if (permits && activePermits.length > 0) {
      permits.revokeForEmployee(id, t('员工{action}：{reason}', { action: actionLabel, reason: trimmedReason }))
    }

    // 3. 释放执行租约（exec-hub 集成端口，结构化探测——不产生反向 import）
    if (status === 'suspended' || status === 'offboarded') {
      const execHub = this.execHub()
      const releaseReason = t('员工{action}：{reason}', { action: actionLabel, reason: trimmedReason })
      for (const runId of runIds) {
        if (typeof execHub?.releaseForRun !== 'function') {
          this.emitEvent('workforce.employee.changed', {
            employeeId: id, action: 'lease_release_skipped', runId, note: '执行中枢租约释放端口未就绪，交由僵尸锁回收兜底',
          })
          continue
        }
        try {
          execHub.releaseForRun(runId, releaseReason)
        } catch (error) {
          this.emitEvent('workforce.employee.changed', {
            employeeId: id, action: 'lease_release_failed', runId,
            note: `租约释放失败（待僵尸锁回收）：${error instanceof Error ? error.message : String(error)}`,
          })
        }
      }
    }

    // 4. 状态机落库（复岗 reactivate 仅 suspended→active，转换表已约束）
    const updatedAt = nowIso()
    this.store.txn(() => {
      this.store.employees.update(id, { status, updatedAt })
    })

    this.emitEvent('workforce.employee.changed', {
      employeeId: id, action: 'status', from: employee.status, to: status, reason: trimmedReason,
      actor: this.actorOf(caller), revokedPermits: activePermits.length, releasedRuns: runIds,
    })
    return { ...employee, status, updatedAt }
  }

  // -- 运行绑定 ------------------------------------------------------------

  bindingsFor(employeeId: string): BindingRecord[] {
    return this.store.bindings
      .findWhere({ employeeId })
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  /**
   * 换绑（事务内保证同 Agent 全平台仅一条 active）：
   * 旧 active 绑定 → inactive；目标 Agent 若被其他员工占用 → 拒绝；
   * 同 Agent 重复换绑视为幂等更新（回填 principalId/runtime）。
   * 离岗（终态）员工不允许换绑；停职员工允许（为复岗做准备）。
   */
  bindAgent(caller: WorkCallerRef, employeeId: string, agentId: string, principalId?: string, runtime?: string): BindingRecord {
    const employee = this.get(employeeId)
    if (employee.status === 'offboarded') throw new Error(t('已离岗员工不接受换绑技术 Agent（如需重新任用请新建数字员工）'))
    const nextAgentId = String(agentId ?? '').trim()
    if (nextAgentId === '') throw new Error(t('换绑必须指定目标技术 Agent（agentId）'))

    const createdAt = nowIso()
    const updated = this.store.txn(() => {
      const occupied = this.store.bindings.findWhere({ agentId: nextAgentId, status: 'active' })
      const foreign = occupied.find((binding) => binding.employeeId !== employeeId)
      if (foreign) throw new WorkforceError('PRINCIPAL_BINDING_MISMATCH', t('该技术 Agent 已绑定其他数字员工'))

      const sameAgent = occupied.find((binding) => binding.employeeId === employeeId)
      if (sameAgent) {
        // 幂等：同 Agent 重复换绑，仅回填主体/运行时信息
        const patch: Partial<BindingRecord> = { updatedAt: createdAt }
        const trimmedPrincipal = String(principalId ?? '').trim()
        if (trimmedPrincipal !== '') patch.principalId = trimmedPrincipal
        const trimmedRuntime = String(runtime ?? '').trim()
        if (trimmedRuntime !== '') patch.runtime = trimmedRuntime
        this.store.bindings.update(sameAgent.id, patch)
        this.store.employees.update(employeeId, { primaryAgentId: nextAgentId, updatedAt: createdAt })
        return { ...sameAgent, ...patch } as BindingRecord
      }

      for (const binding of this.store.bindings.findWhere({ employeeId, status: 'active' })) {
        this.store.bindings.update(binding.id, { status: 'inactive', updatedAt: createdAt })
      }
      const created: BindingRecord = {
        id: newId('bnd'),
        employeeId,
        agentId: nextAgentId,
        principalId: String(principalId ?? '').trim(),
        runtime: String(runtime ?? '').trim() || 'dsh',
        capabilityVersion: 1,
        status: 'active',
        createdAt,
        updatedAt: createdAt,
      }
      this.store.bindings.insert(created)
      this.store.employees.update(employeeId, { primaryAgentId: nextAgentId, updatedAt: createdAt })
      return created
    })

    this.emitEvent('workforce.employee.changed', {
      employeeId: employeeId, action: 'rebind', agentId: nextAgentId, previousAgentId: employee.primaryAgentId, actor: this.actorOf(caller),
    })
    return updated
  }
}
