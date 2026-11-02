/**
 * 任用域服务（appointment-service）—— 任用版本、资源授权期望、激活探针与撤销联动。
 *
 * 核心是 §D.4 状态机「准备中 → 生效 → 撤销中 → 已撤销/配置失败」的落地：
 *   - 任用只是一份「带版本的期望策略」，不等于真实权限：激活必须逐 grant 经适配器探针
 *     核验原资源网关中的授权已真实生效（MCP 权限组/Connector 策略/NAS 目录映射…）；
 *   - 全部探针通过 → 任用 effective 并同时装配能力清单（workforceCapabilities）；
 *     任一失败 → 该 grant failed、任用保持 preparing、整体不生效——绝不签发 permit；
 *   - 探针属只读核验（可能触达网关），一律在事务外执行；事务只写状态；
 *   - 撤销：先撤全部该任用 permit（工作策略层先失效），grant 与任用一期同步收敛 revoked
 *     （原资源网关侧的真实授权回收为运维项，见文件尾注）。
 *
 * 失败语义诚实：适配器缺席/探针异常/探针否决都落 failed + 中文 lastError，不以空实现冒充成功。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId } from '../../platform-core/src/ids.ts'
import { WORK_DATA_CLASS_ORDER, type WorkDataClass } from '../../platform-core/src/workforce-port.ts'
import { WorkforceError } from './contract.ts'
import { t } from '../../platform-i18n/src/index.ts'
import type {
  AdapterRegistry,
  AppointmentRecord,
  IdentityResolution,
  ResourceGrantRecord,
  ResourceGrantSpec,
  WorkCallerRef,
  WorkforceAppointments,
  WorkforceCapabilities,
  WorkforcePermits,
} from './contract.ts'
import { appointmentInEffect, appointmentStatusTransition, validateGrantSpec, validateWorkDataClass } from './domain.ts'
import type { WorkforceStoreService } from './repositories.ts'

function nowIso(): string {
  return new Date().toISOString()
}

function parseJsonArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** 授权记录 → 期望规格（探针入参；记录是存储形态，规格是契约形态）。 */
function grantSpecOf(row: ResourceGrantRecord): ResourceGrantSpec {
  return {
    kind: row.kind,
    registryId: row.registryId,
    actions: parseJsonArray(row.actionsJson),
    risk: row.risk,
    constraints: parseJsonObject(row.constraintsJson),
  }
}

/** 单个 grant 的探针裁决（事务外产出，事务内落库）。 */
interface GrantProbeOutcome {
  grantId: string
  status: 'effective' | 'failed'
  ref: string
  lastError: string
}

export class AppointmentService extends Service implements WorkforceAppointments {
  static readonly provide = 'workforceAppointments'

  constructor(ctx: Context) {
    super(ctx, 'workforceAppointments')
  }

  // -- 内部取用（同插件服务经 ctx 运行时解析；结构化探测保持独立单测可运行） ----------

  private get store(): WorkforceStoreService {
    return this.ctx.workforceStore
  }

  private adapters(): AdapterRegistry | undefined {
    return (this.ctx as unknown as { workforceAdapters?: AdapterRegistry }).workforceAdapters
  }

  private capabilities(): WorkforceCapabilities | undefined {
    return (this.ctx as unknown as { workforceCapabilities?: WorkforceCapabilities }).workforceCapabilities
  }

  private permits(): WorkforcePermits | undefined {
    return (this.ctx as unknown as { workforcePermits?: WorkforcePermits }).workforcePermits
  }

  private emitEvent(name: string, payload: Record<string, unknown>): void {
    try {
      const bus = (this.ctx as unknown as { platformBus?: { emit(event: string, payload: unknown): unknown } }).platformBus
      bus?.emit(name, { ...payload, at: nowIso() })
    } catch {
      /* 事件总线缺席时跳过通知：状态事实已落库 */
    }
  }

  private actorOf(caller: WorkCallerRef | undefined): string {
    return caller?.userId ?? caller?.principalId ?? ''
  }

  // -- 任用版本 ------------------------------------------------------------

  create(input: {
    employeeId: string
    position: string
    orgId: string
    dataClass: WorkDataClass
    effectiveFrom: string
    effectiveUntil?: string
    grants: ResourceGrantSpec[]
    approvedBy: string
    approvalRef?: string
  }): AppointmentRecord {
    const employeeId = String(input.employeeId ?? '').trim()
    const orgId = String(input.orgId ?? '').trim()
    if (employeeId === '') throw new Error(t('创建任用必须指定数字员工（employeeId）'))
    if (orgId === '') throw new Error(t('创建任用必须登记工作组织（orgId）——任务归属组织不可空'))

    const employee = this.store.employees.get(employeeId)
    if (!employee) throw new Error(t('数字员工不存在：{id}', { id: employeeId }))
    if (employee.status === 'offboarded') throw new Error(t('已离岗员工不接受新任用（如需重新任用请新建数字员工）'))

    // 密级在登记口即校验：绝密任用会在每次模型/资源调用前被拒，与其发放一份「必然失败」的任用，
    // 不如在此显式拒绝（D14：禁止 Agent 处理的密级必须在调用前拒绝）
    const dataClass = validateWorkDataClass(input.dataClass)
    if (dataClass === 'topsecret') {
      throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('任用密级不得为绝密（绝密数据禁止数字员工处理）'))
    }

    // 授权期望逐项校验并归一（kind/registryId/actions/risk；写动作必须显式列出）
    const grants = (Array.isArray(input.grants) ? input.grants : []).map((spec) => validateGrantSpec(spec))
    if (grants.length === 0) throw new Error(t('任用必须至少登记一项资源授权期望（grants）——空授权的任用不具备工作边界'))

    const effectiveFrom = String(input.effectiveFrom ?? '').trim() || nowIso()
    if (Number.isNaN(Date.parse(effectiveFrom))) throw new Error(t('任用生效时间不合法：{value}（须为 ISO 时间）', { value: String(input.effectiveFrom ?? '') }))
    const effectiveUntil = String(input.effectiveUntil ?? '').trim()
    if (effectiveUntil !== '') {
      if (Number.isNaN(Date.parse(effectiveUntil))) throw new Error(t('任用失效时间不合法：{value}（须为 ISO 时间，空串＝长期）', { value: effectiveUntil }))
      if (Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) throw new Error(t('任用失效时间必须晚于生效时间'))
    }

    const createdAt = nowIso()
    const appointmentId = newId('apt')
    const appointment: AppointmentRecord = {
      id: appointmentId,
      employeeId,
      version: 0, // 事务内分配（该员工 max+1）
      position: String(input.position ?? '').trim(),
      orgId,
      dataClass,
      effectiveFrom,
      effectiveUntil,
      grantsJson: JSON.stringify(grants),
      approvedBy: String(input.approvedBy ?? '').trim(),
      approvalRef: String(input.approvalRef ?? '').trim(),
      status: 'preparing',
      statusReason: '',
      createdAt,
      updatedAt: createdAt,
    }

    // 同事务完成「版本分配唯一性校验 + 任用落库 + grant 全量 preparing 落库」
    // 员工+版本唯一冲突 → 中文错误（路由层 400），不依赖 SQLite 原始报错
    this.store.txn(() => {
      const existing = this.store.appointments.findWhere({ employeeId })
      const maxVersion = existing.reduce((max, row) => Math.max(max, row.version), 0)
      appointment.version = maxVersion + 1
      const duplicated = existing.some((row) => row.version === appointment.version)
      if (duplicated) throw new Error(t('该员工任用版本 {version} 已存在，请重试（版本号由服务端分配）', { version: appointment.version }))
      this.store.appointments.insert(appointment)
      for (const spec of grants) {
        this.store.grants.insert({
          id: newId('grt'),
          appointmentId,
          kind: spec.kind,
          registryId: spec.registryId,
          actionsJson: JSON.stringify(spec.actions),
          risk: spec.risk,
          constraintsJson: JSON.stringify(spec.constraints ?? {}),
          ref: '',
          status: 'preparing',
          lastError: '',
          checkedAt: '',
          createdAt,
          updatedAt: createdAt,
        } satisfies ResourceGrantRecord)
      }
    })

    this.emitEvent('workforce.appointment.changed', {
      appointmentId, employeeId, version: appointment.version, status: 'preparing', action: 'created', orgId, dataClass,
    })
    return appointment
  }

  get(id: string): AppointmentRecord {
    const appointment = this.store.appointments.get(id)
    if (!appointment) throw new Error(t('任用不存在：{id}', { id }))
    return appointment
  }

  list(filter?: { employeeId?: string; status?: AppointmentStatus }): AppointmentRecord[] {
    let rows = this.store.appointments.all()
    if (filter?.employeeId) rows = rows.filter((row) => row.employeeId === filter.employeeId)
    if (filter?.status) rows = rows.filter((row) => row.status === filter.status)
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  /** 员工当前生效任用：status=effective 且未出有效期窗口的最新版本（过期版本不返回）。 */
  effectiveForEmployee(employeeId: string): AppointmentRecord | undefined {
    const rows = this.store.appointments
      .findWhere({ employeeId, status: 'effective' })
      .sort((a, b) => b.version - a.version)
    return rows.find((row) => appointmentInEffect(row))
  }

  // -- 激活（§D.4 状态机核心） ----------------------------------------------

  /**
   * 激活：逐 grant 探针核验真实授权。
   * 事务纪律：探针可能触达网关（网络语义），全部在事务外执行；事务只负责写状态。
   * 全部 effective → 装配能力清单 → 任用 effective；任一 failed → 任用保持 preparing（不签 permit）；
   * 能力清单装配失败同样保持 preparing（诚实缺位，可重试激活）。
   */
  async activate(caller: WorkCallerRef, id: string): Promise<AppointmentRecord> {
    const appt = this.get(id)
    if (appt.status === 'effective') throw new Error(t('任用已生效，不得重复激活'))
    if (appt.status === 'revoking' || appt.status === 'revoked') throw new Error(t('任用已进入撤销流程，不得激活（请开新版本）'))
    if (appt.status === 'failed') throw new Error(t('任用已判配置失败（终态），请修正授权范围后开新版本'))
    if (appt.status !== 'preparing') throw new Error(t('任用状态不允许激活：{status}', { status: appt.status }))

    const employee = this.store.employees.get(appt.employeeId)
    if (!employee || employee.status !== 'active') {
      throw new WorkforceError('EMPLOYEE_NOT_ACTIVE', t('员工不在岗（停职或已离岗），任用不得激活'))
    }
    if (!appointmentInEffect({ ...appt, status: 'effective' })) {
      throw new Error(t('任用有效期窗口未覆盖当前时间，请核对 effectiveFrom/effectiveUntil'))
    }

    const grants = this.store.grants.findWhere({ appointmentId: id })
    if (grants.length === 0) throw new Error(t('任用未登记任何资源授权，禁止激活（create 已强制，此处为防御校验）'))

    // 组装身份核验上下文（探针用它定位员工/绑定/任用版本）：任用激活由真人主管发起，
    // resolution 必须取员工域记录而非调用者身份——调用者是审批人，不是被执行的员工
    const binding = this.store.bindings.findWhere({ employeeId: appt.employeeId, status: 'active' })[0]
    const resolution: IdentityResolution = { employee, binding, appointment: appt }

    // 1. 事务外逐 grant 探针（适配器缺席 → failed('未登记适配器')；异常 → failed(异常消息)）
    const registry = this.adapters()
    const outcomes: GrantProbeOutcome[] = []
    for (const grant of grants) {
      outcomes.push(await this.probeGrantRow(grant, registry, resolution))
    }

    // 2. 事务落库 grant 状态（含 ref 回填——真实权限组/策略/目录映射引用，不是 UI 勾选项）
    const checkedAt = nowIso()
    this.store.txn(() => {
      for (const outcome of outcomes) {
        this.store.grants.update(outcome.grantId, {
          status: outcome.status,
          ref: outcome.ref,
          lastError: outcome.lastError,
          checkedAt,
          updatedAt: checkedAt,
        })
      }
    })

    const allEffective = outcomes.every((outcome) => outcome.status === 'effective')
    if (!allEffective) {
      const failedSummary = outcomes
        .filter((outcome) => outcome.status === 'failed')
        .map((outcome) => outcome.lastError)
        .join('；')
      const statusReason = t('资源授权核验未全部通过（{failed}）；任用整体不生效，不得签发工作授权', { failed: failedSummary })
      this.store.txn(() => {
        this.store.appointments.update(id, { status: 'preparing', statusReason, updatedAt: nowIso() })
      })
      const updated = this.get(id)
      this.emitEvent('workforce.appointment.changed', {
        appointmentId: id, employeeId: appt.employeeId, version: appt.version, status: 'preparing',
        action: 'activate_rejected', failedGrants: outcomes.filter((o) => o.status === 'failed').length,
      })
      return updated
    }

    // 3. 能力清单装配（同插件服务；装配自身管理事务，故在本事务之外调用）
    let manifestError = ''
    try {
      const capabilities = this.capabilities()
      if (!capabilities) manifestError = t('能力清单服务未就绪')
      else capabilities.buildForAppointment(id)
    } catch (error) {
      manifestError = error instanceof Error ? error.message : String(error)
    }

    // 4. 任用生效（清单装配失败则保持 preparing——不允许「任用生效但清单缺失」的假就绪）
    const statusReason = manifestError === ''
      ? t('资源授权探针全部通过，任用生效（能力清单已装配）')
      : t('能力清单装配失败：{message}；任用保持准备中，请重试激活', { message: manifestError })
    const finalStatus: AppointmentStatus = manifestError === '' ? 'effective' : 'preparing'
    this.store.txn(() => {
      this.store.appointments.update(id, { status: finalStatus, statusReason, updatedAt: nowIso() })
    })

    const updated = this.get(id)
    this.emitEvent('workforce.appointment.changed', {
      appointmentId: id, employeeId: appt.employeeId, version: appt.version, status: finalStatus,
      action: finalStatus === 'effective' ? 'activated' : 'activate_deferred', actor: this.actorOf(caller),
    })
    return updated
  }

  /** 单 grant 探针：只读核验真实配置，不自动扩权（§D.4 第 3 条）。 */
  private async probeGrantRow(
    grant: ResourceGrantRecord,
    registry: AdapterRegistry | undefined,
    resolution: IdentityResolution,
  ): Promise<GrantProbeOutcome> {
    const base: GrantProbeOutcome = { grantId: grant.id, status: 'failed', ref: '', lastError: '' }
    if (!registry) return { ...base, lastError: t('未登记适配器') }
    const adapter = registry.get(grant.kind)
    if (!adapter) return { ...base, lastError: t('未登记适配器') }
    if (!resolution.binding) return { ...base, lastError: t('员工未绑定技术 Agent，无法核验资源授权') }
    try {
      const probe: AdapterProbeResult = await adapter.probeGrant(grantSpecOf(grant), resolution)
      if (probe.ok) return { ...base, status: 'effective', ref: String(probe.ref ?? '') }
      return { ...base, lastError: String(probe.message ?? t('授权探针未通过')) }
    } catch (error) {
      return { ...base, lastError: t('授权探针执行异常：{message}', { message: error instanceof Error ? error.message : String(error) }) }
    }
  }

  // -- 撤销（§D.4 第 5 条） --------------------------------------------------

  /**
   * 撤销：先撤全部该任用 permit（工作策略层先失效、发 workforce.permit.revoked），
   * 再收敛 grant 与任用状态。
   *
   * 一期口径（诚实登记）：撤权语义本应「工作层拒新动作 → 异步收敛原资源网关与远端凭证」，
   * 一期将 grant 置 revoking→revoked、任用置 revoked 同步收敛；**原资源网关侧的真实授权回收**
   * （MCP 权限组摘除、Connector 策略解绑、NAS 目录映射清理）依赖各适配器补撤权通道，
   * 一期未实现的按运维项登记（见施工报告），不冒充「网关已回收」。
   *
   * revoking 是可续办中间态：permit 撤销部分失败时停留在 revoking，可重试本方法收敛。
   */
  async revoke(caller: WorkCallerRef, id: string, reason: string): Promise<AppointmentRecord> {
    const trimmedReason = String(reason ?? '').trim()
    if (trimmedReason === '') throw new Error(t('撤销任用必须登记原因'))
    const appt = this.get(id)

    if (appt.status === 'revoked') throw new Error(t('任用已撤销，请勿重复操作'))
    if (appt.status === 'failed') throw new Error(t('任用配置失败为终态，无须撤销（请开新版本）'))
    if (appt.status !== 'effective' && appt.status !== 'preparing' && appt.status !== 'revoking') {
      throw new Error(t('任用状态不允许撤销：{status}', { status: appt.status }))
    }

    // 未生效任用：无 permit 可撤，直接 preparing→revoked（状态机 preparing 分支已登记）
    if (appt.status === 'preparing') {
      appointmentStatusTransition(appt.status, 'revoked')
      const at = nowIso()
      this.store.txn(() => {
        for (const grant of this.store.grants.findWhere({ appointmentId: id })) {
          if (grant.status === 'revoked') continue
          this.store.grants.update(grant.id, {
            status: 'revoked', lastError: '', checkedAt: at, updatedAt: at,
          })
        }
        this.store.appointments.update(id, { status: 'revoked', statusReason: t('已撤销（未生效任用）：{reason}', { reason: trimmedReason }), updatedAt: at })
      })
      const updated = this.get(id)
      this.emitEvent('workforce.appointment.changed', {
        appointmentId: id, employeeId: appt.employeeId, version: appt.version, status: 'revoked',
        action: 'revoked', actor: this.actorOf(caller), reason: trimmedReason,
      })
      return updated
    }

    // 生效任用：effective → revoking（可续办）；续办时跳过重复流转
    if (appt.status === 'effective') {
      appointmentStatusTransition(appt.status, 'revoking')
      this.store.txn(() => {
        this.store.appointments.update(id, { status: 'revoking', statusReason: t('撤销中：{reason}', { reason: trimmedReason }), updatedAt: nowIso() })
      })
    }

    // 1. 撤全部该任用的 active permit（按 employeeId+appointmentVersion 定位，不误伤其他版本）
    const permits = this.permits()
    const activePermits = permits
      ? this.store.permits.findWhere({ employeeId: appt.employeeId, appointmentVersion: appt.version, status: 'active' })
      : []
    const revokeFailures: Array<{ permitId: string; error: string }> = []
    if (!permits) {
      revokeFailures.push({ permitId: '*', error: t('工作授权服务未就绪，无法撤销 permit') })
    }
    for (const permit of activePermits) {
      try {
        permits!.revoke(permit.id, t('任用 v{version} 撤销：{reason}', { version: appt.version, reason: trimmedReason }))
      } catch (error) {
        revokeFailures.push({ permitId: permit.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.emitEvent('workforce.permit.revoked', {
      appointmentId: id, employeeId: appt.employeeId, appointmentVersion: appt.version,
      revoked: activePermits.length - revokeFailures.length,
      failed: revokeFailures, reason: trimmedReason,
    })

    // 2. permit 有未撤干净 → 停在 revoking 等待重试（不恢复已撤销工作资格，也不假装已收敛）
    if (revokeFailures.length > 0) {
      const statusReason = t('撤销中：部分工作授权撤销失败待重试（{failures}）', {
        failures: revokeFailures.map((f) => `${f.permitId}: ${f.error}`).join('；'),
      })
      this.store.txn(() => {
        this.store.appointments.update(id, { status: 'revoking', statusReason, updatedAt: nowIso() })
      })
      return this.get(id)
    }

    // 3. grant 一期同步收敛 revoking→revoked（网关侧真实授权回收为运维项，见方法注释）
    const at = nowIso()
    this.store.txn(() => {
      for (const grant of this.store.grants.findWhere({ appointmentId: id })) {
        if (grant.status === 'revoked') continue
        this.store.grants.update(grant.id, { status: 'revoked', lastError: '', checkedAt: at, updatedAt: at })
      }
      this.store.appointments.update(id, { status: 'revoked', statusReason: t('已撤销：{reason}', { reason: trimmedReason }), updatedAt: at })
    })

    const updated = this.get(id)
    this.emitEvent('workforce.appointment.changed', {
      appointmentId: id, employeeId: appt.employeeId, version: appt.version, status: 'revoked',
      action: 'revoked', actor: this.actorOf(caller), reason: trimmedReason,
    })
    return updated
  }
}

/*
 * 运维项登记（施工报告同步条目）：
 * 1. 原资源网关侧授权回收通道：各资源适配器（mcp/connector/model/skill/nas/app）需提供
 *    撤权调用（如 MCP 权限组摘除主体），当前 probeGrant 只读核验、无撤权动作——
 *    任用撤销后网关侧配置由运维按 grant.ref 引用人工清理，一期不冒充已回收。
 * 2. 撤销失败滞留 revoking 的任用：需人工重试 revoke 或经审计排查 permit 服务异常；
 *    revoking 期间 effectiveForEmployee 已不返回该任用，新动作天然被拒（fail-closed）。
 */
