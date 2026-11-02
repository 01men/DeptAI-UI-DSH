/**
 * 准入与认领服务（实施路径 §6.2/附录 A 决策 3：认领＝幂等确认已分配租约）。
 *
 * claimWork 是 REST /claims 与 exec_claim 兼容包装共用的统一入口：
 * 可信 caller 反查员工 → 任用生效 → 能力清单 → exec-hub 幂等认领（租约权威在
 * exec_run_leases）→ 签发 permit（同 run 幂等，不重复签）。
 * exec-hub 经结构化探测消费（ExecHubWorkIntegration，无反向 import）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {
  AppointmentRecord,
  ClaimInput,
  ClaimOutcome,
  EmployeeClaimResult,
  EmployeeLeaseResult,
  ExecHubWorkIntegration,
  ManifestRecord,
  PermitRecord,
  RunLeaseRecord,
  WorkforceAdmission,
  WorkforceCapabilities,
  WorkforceGrayConfig,
  WorkforceIdentityResolver,
  WorkforcePermits,
  WorkforceStore,
} from './contract.ts'
import { appointmentInEffect } from './domain.ts'
// WorkforceError 为值导入（领域错误类）：本文件全部拒绝路径（灰度关闭/服务未就绪/任用失效/所有权）共用。
// 此前遗漏该导入为潜伏缺陷——未触发拒绝路径时不暴露，灰度收口（W7）首次踩中并修复。
import { WorkforceError } from './contract.ts'
import { t } from '../../platform-i18n/src/index.ts'
import type { WorkCallerRef, WorkDenyCode, WorkExecutionContext } from '../../platform-core/src/workforce-port.ts'

/** exec-hub 员工工作集成结构化探针（组3 additive：ctx.execHub.claimForEmployee）。 */
interface ExecHubProbe {
  claimForEmployee?: ExecHubWorkIntegration['claimForEmployee']
  renewLease?: ExecHubWorkIntegration['renewLease']
  assertRunOwnership?: ExecHubWorkIntegration['assertRunOwnership']
  releaseForRun?: ExecHubWorkIntegration['releaseForRun']
}

function probeExecHub(ctx: Context): ExecHubProbe {
  const hub = (ctx as unknown as { execHub?: ExecHubProbe }).execHub
  return hub && typeof hub === 'object' ? hub : {}
}

export class AdmissionService extends Service implements WorkforceAdmission {
  static readonly provide = 'workforceAdmission'

  /** 灰度开关（W7 契约 D-② 组织级）：index.ts 装配传入全量 config，缺省 {}＝off 全开（向后兼容）。 */
  private readonly grayConfig: WorkforceGrayConfig

  constructor(ctx: Context, config: WorkforceGrayConfig = {}) {
    super(ctx, 'workforceAdmission')
    this.grayConfig = config
  }

  // -- 依赖 -------------------------------------------------------------

  private get store(): WorkforceStore {
    const store = (this.ctx as unknown as { workforceStore?: WorkforceStore }).workforceStore
    if (!store || typeof store.txn !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceStore 未就绪（迁移未完成）'), 503)
    }
    return store
  }

  private get identity(): WorkforceIdentityResolver {
    const resolver = (this.ctx as unknown as { workforceIdentity?: WorkforceIdentityResolver }).workforceIdentity
    if (!resolver || typeof resolver.resolveByCaller !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceIdentity 未就绪'), 503)
    }
    return resolver
  }

  private get permits(): WorkforcePermits {
    const permits = (this.ctx as unknown as { workforcePermits?: WorkforcePermits }).workforcePermits
    if (!permits || typeof permits.issue !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforcePermits 未就绪'), 503)
    }
    return permits
  }

  private get capabilities(): WorkforceCapabilities {
    const capabilities = (this.ctx as unknown as { workforceCapabilities?: WorkforceCapabilities }).workforceCapabilities
    if (!capabilities || typeof capabilities.buildForAppointment !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceCapabilities 未就绪'), 503)
    }
    return capabilities
  }

  private emit(event: string, payload: unknown): void {
    try {
      ;(this.ctx as unknown as { platformBus?: { emit(name: string, payload: unknown): unknown } })
        .platformBus?.emit(event, payload)
    } catch {
      // platformBus 未注入当前 fiber 时跳过
    }
  }

  /** 任用失效细分：未生效（准备中/撤销中）与已过期是两种「等待/停止」语义（§13.3）。 */
  private assertAppointmentEffective(appointment: AppointmentRecord): void {
    if (appointmentInEffect(appointment)) return
    const expired = appointment.effectiveUntil !== '' && appointment.effectiveUntil <= new Date().toISOString()
    throw new WorkforceError(
      expired ? 'APPOINTMENT_EXPIRED' : 'APPOINTMENT_NOT_EFFECTIVE',
      expired ? t('任用已过期，请先续任或申请新版本') : t('任用未生效（资源授权准备未完成），不能认领工作'),
    )
  }

  // -- 灰度开关（W7 契约 D-②，与 port.authorizeWorkAction 同口径） -----------------------

  /**
   * 灰度拒绝判定：allowlist 模式且 orgId 不在名单 → true。off 模式（默认）全组织开放，
   * 等价一期行为。查询面（拉取 work-items、状态查询）不拦——观测面保持开放。
   */
  private grayDenied(orgId: string): boolean {
    return (this.grayConfig.grayMode ?? 'off') === 'allowlist'
      && !(this.grayConfig.enabledOrgs ?? []).includes(orgId)
  }

  /**
   * 灰度关闭组织的显式拒绝（拒绝语义＝显式拒绝而非静默回落 legacy，V29 同口径：拒绝并可观测）：
   * emit workforce.gray.denied（surface:'admission'，payload 对齐 port 侧）后抛
   * WORKFORCE_DISABLED（403）。认领/续租是新工作路径入口，此处收口在确认/延长之前。
   */
  private assertGrayOpen(orgId: string, employeeId: string): void {
    if (!this.grayDenied(orgId)) return
    try {
      this.emit('workforce.gray.denied', {
        orgId,
        employeeId,
        surface: 'admission',
        at: new Date().toISOString(),
      })
    } catch {
      // 通知失败不影响拒绝本身（拒绝先于可观测，fail-closed）
    }
    throw new WorkforceError('WORKFORCE_DISABLED', t('数字员工域对组织 {orgId} 处于灰度关闭（仅白名单组织开放）', { orgId }), 403)
  }

  // -- 认领 -------------------------------------------------------------

  async claimWork(caller: WorkCallerRef, input: ClaimInput): Promise<ClaimOutcome> {
    // 1. 可信 caller 反查员工（防绕行：与请求是否携带 work 上下文无关，D.5）
    const resolution = await this.identity.resolveByCaller(caller)
    if (!resolution) {
      return { ok: false, code: 'EMPLOYEE_NOT_ACTIVE', message: t('非受管数字员工或绑定缺失') }
    }
    // 2. 灰度开关（W7 契约 D-②）：关闭组织在确认前显式拒绝——认领＝幂等确认已分配租约，
    //    灰度拒绝发生在确认之前（新工作路径入口收口，payload/语义与 port 侧对齐）
    this.assertGrayOpen(resolution.appointment.orgId, resolution.employee.id)
    // 3. 任用生效
    try {
      this.assertAppointmentEffective(resolution.appointment)
    } catch (error) {
      if (error instanceof WorkforceError) return { ok: false, code: error.code, message: error.message }
      throw error
    }
    // 4. 能力清单（active 复用，否则按生效授权构建——构建含 skill 版本锁定探针，失败即认领失败）
    let manifest: ManifestRecord
    try {
      manifest = this.capabilities.activeForAppointment(resolution.appointment.id)
        ?? this.capabilities.buildForAppointment(resolution.appointment.id)
    } catch (error) {
      return { ok: false, code: 'APPOINTMENT_NOT_EFFECTIVE', message: t('能力清单构建失败：{message}', { message: error instanceof Error ? error.message : String(error) }) }
    }
    // 5. exec-hub 集成（结构化探测；缺席＝工作路径不可用，不静默降级）
    const hub = probeExecHub(this.ctx)
    if (typeof hub.claimForEmployee !== 'function') {
      return { ok: false, code: 'WORKFORCE_NOT_READY', message: t('执行中枢未提供员工工作集成（execHub.claimForEmployee 缺席），工作路径暂不可用') }
    }
    const agentKey = input.agentKey?.trim() || resolution.binding.agentId || resolution.employee.primaryAgentId
    let claim: EmployeeClaimResult
    try {
      claim = await hub.claimForEmployee({
        issueId: input.issueId,
        employeeId: resolution.employee.id,
        agentKey,
        principalId: caller.principalId,
        ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      })
    } catch (error) {
      return { ok: false, code: 'WORKFORCE_NOT_READY', message: t('执行中枢认领异常（fail-closed）：{message}', { message: error instanceof Error ? error.message : String(error) }) }
    }
    if (!claim.ok) {
      return this.mapClaimFailure(claim)
    }
    // 6. permit 幂等：该 run 已有本员工 active 且未过期的 permit → 直接复用，不重复签发
    const existing = this.store.permits.findWhere({ runId: claim.runId }).find((permit) =>
      permit.status === 'active'
      && permit.employeeId === resolution.employee.id
      && permit.principalId === caller.principalId
      && (!permit.expiresAt || permit.expiresAt > new Date().toISOString()))
    if (existing) {
      return {
        ok: true,
        employeeId: resolution.employee.id,
        agentId: resolution.binding.agentId,
        issueId: claim.issueId,
        runId: claim.runId,
        lease: claim.lease,
        permit: existing,
        manifest: this.capabilities.get(existing.manifestId),
        tools: this.capabilities.toolsFor(existing.manifestId),
        idempotent: true,
      }
    }
    const permit = this.permits.issue({
      resolution,
      issueId: claim.issueId,
      runId: claim.runId,
      lease: claim.lease,
      manifestId: manifest.id,
      ttlMs: input.ttlMs ?? 0,
    })
    this.emit('workforce.claim.succeeded', {
      employeeId: resolution.employee.id,
      issueId: claim.issueId,
      runId: claim.runId,
      leaseId: claim.lease.id,
      leaseVersion: claim.lease.leaseVersion,
      permitId: permit.id,
      manifestId: manifest.id,
      idempotent: false,
    })
    return {
      ok: true,
      employeeId: resolution.employee.id,
      agentId: resolution.binding.agentId,
      issueId: claim.issueId,
      runId: claim.runId,
      lease: claim.lease,
      permit,
      manifest,
      tools: this.capabilities.toolsFor(manifest.id),
      idempotent: false,
    }
  }

  /** exec-hub 认领失败 → 统一拒绝码映射（错误要能指导「停止/申请/等待/核验/重试」，§13.3）。 */
  private mapClaimFailure(claim: Extract<EmployeeClaimResult, { ok: false }>): ClaimOutcome {
    switch (claim.code) {
      case 'LEASE_HELD_BY_OTHER':
        return { ok: false, code: 'RUN_NOT_OWNED', message: t('该任务已由其他执行持有（{holder}），停止认领，不要换入口重试', { holder: claim.holder ?? t('未知持有者') }), holder: claim.holder }
      case 'BUDGET_EXCEEDED':
        return { ok: false, code: 'BUDGET_EXCEEDED', message: claim.message }
      case 'APPROVAL_REQUIRED':
        return { ok: false, code: 'APPROVAL_REQUIRED', message: claim.message }
      case 'ISSUE_NOT_FOUND':
      case 'ISSUE_CLOSED':
        return { ok: false, code: 'RUN_NOT_OWNED', message: t('{message}（该任务当前不可认领，请停止重试）', { message: claim.message }) }
      case 'ADMISSION_DENIED':
        return { ok: false, code: 'APPOINTMENT_NOT_EFFECTIVE', message: claim.message }
      case 'EXEC_HUB_UNAVAILABLE':
        return { ok: false, code: 'WORKFORCE_NOT_READY', message: claim.message }
      default:
        return { ok: false, code: 'POLICY_INTERNAL_ERROR', message: claim.message }
    }
  }

  // -- 续租 -------------------------------------------------------------

  async renewWorkLease(caller: WorkCallerRef, permitId: string, ttlMs?: number): Promise<EmployeeLeaseResult> {
    // D3 修复：verifyPermit 返回 Promise，必须 await 取值——此前 permit.runId 为 undefined，
    // 续租全路径被 exec-hub「参数不足」守卫拒绝（恒 LEASE_STALE）
    const permit = await this.verifyPermit(caller, permitId, { requireRun: true })
    // 灰度收口（W7 契约 D-②，与认领/port 同口径）：关闭组织不得续租延长工作——
    // orgId 从 permit 绑定的任用回查（不依赖 identity 解析窗口，任用非生效时同样可判）
    const appointment = this.store.appointments.get(permit.appointmentId)
    if (appointment) this.assertGrayOpen(appointment.orgId, permit.employeeId)
    const hub = probeExecHub(this.ctx)
    if (typeof hub.renewLease !== 'function') {
      return { ok: false, code: 'EXEC_HUB_UNAVAILABLE', message: t('执行中枢未提供租约续期能力（execHub.renewLease 缺席）') }
    }
    return hub.renewLease({ runId: permit.runId, principalId: caller.principalId, ...(ttlMs !== undefined ? { ttlMs } : {}) })
  }

  // -- permit 校验与 run 所有权 ---------------------------------------------

  /**
   * 网关折叠身份归一（D1 配套，附录 A 决策 10）：资源网关 InvokeCaller 只有单一 id 位，
   * workCallerRefFromInvokeCaller 把机器主体折叠为 principalId=refId=技术身份 agentId，
   * 而 permit 绑定的主体是绑定 principalId（已验证机器凭证主体）。此类折叠 caller 已由
   * 网关按已验证凭证反查产出（refId 可信），主体一致性以绑定 principalId 归一后核验；
   * 归一不可得（无有效绑定/绑定未回填主体）保持原样 fail-closed。真人 caller 与双位身份
   * 的运行时 caller（principalId≠refId，如 exec.principal）不受影响——主体不匹配照旧抛错。
   */
  private normalizeCollapsedCaller(caller: WorkCallerRef): WorkCallerRef {
    if (caller.kind !== 'machine' || caller.refType !== 'agent' || !caller.refId) return caller
    if (caller.principalId !== caller.refId) return caller
    const binding = this.store.bindings.findWhere({ agentId: caller.refId, status: 'active' })[0]
    if (!binding?.principalId) return caller
    return { ...caller, principalId: binding.principalId }
  }

  verifyPermit(caller: WorkCallerRef, permitId: string, opts?: { requireRun?: boolean }): Promise<PermitRecord> {
    return Promise.resolve(this.permits.verify(permitId, this.normalizeCollapsedCaller(caller), opts))
  }

  /**
   * exec_complete/交付路径的 run 所有权断言（D07）：
   * 该 run 必须存在本主体签发且有效的 permit（主体一致性），
   * 再经 exec-hub assertRunOwnership 校验租约归属与新旧版本。
   */
  async assertRunOwnership(caller: WorkCallerRef, runId: string): Promise<WorkExecutionContext> {
    const permit = this.store.permits.findWhere({ runId }).find((candidate) =>
      candidate.status === 'active'
      && candidate.principalId === caller.principalId
      && (!candidate.expiresAt || candidate.expiresAt > new Date().toISOString()))
    if (!permit) {
      throw new WorkforceError('RUN_NOT_OWNED', t('该 run 不归属当前调用主体（无有效 permit 绑定）'))
    }
    const hub = probeExecHub(this.ctx)
    if (typeof hub.assertRunOwnership !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('执行中枢未提供 run 所有权校验能力（execHub.assertRunOwnership 缺席）'), 503)
    }
    const verdict = await hub.assertRunOwnership({ runId, principalId: caller.principalId })
    if (!verdict.ok) {
      throw new WorkforceError(
        verdict.code === 'LEASE_STALE' ? 'LEASE_STALE' : 'RUN_NOT_OWNED',
        verdict.message,
      )
    }
    return this.workContextOf(permit, verdict.lease)
  }

  /** permit + 租约 → 核验后可信执行上下文（§8.3：全部字段服务端回查，不信客户端同形 JSON）。 */
  private workContextOf(permit: PermitRecord, lease?: RunLeaseRecord): WorkExecutionContext {
    const appointment = this.store.appointments.get(permit.appointmentId)
    const employee = this.store.employees.get(permit.employeeId)
    return {
      employeeId: permit.employeeId,
      agentId: permit.agentId,
      principalId: permit.principalId,
      appointmentId: permit.appointmentId,
      appointmentVersion: permit.appointmentVersion,
      workOrgId: appointment?.orgId ?? employee?.orgId ?? '',
      dataClass: appointment?.dataClass ?? 'internal',
      issueId: permit.issueId,
      runId: permit.runId,
      leaseVersion: lease?.leaseVersion ?? permit.leaseVersion,
      permitId: permit.id,
      capabilityManifestId: permit.manifestId,
      policyVersion: permit.appointmentVersion,
    }
  }
}
