/**
 * 数字员工身份解析（identity-resolver）—— 可信 caller → 员工/绑定/生效任用。
 *
 * 职责（契约 WorkforceIdentityResolver，蓝本 §5/D.5）：
 *   - 员工机器主体只从 agent 绑定反查：machine 且 refType=agent 且 refId 非空才反查；
 *     human 一律返回 null——员工域没有「人是员工」的通道；
 *   - 受管判定三要素缺一不可：员工在岗（active）＋ 一对一绑定有效 ＋ 存在生效任用
 *     （effective 且在有效期窗口内）；否则返回 null（非受管，旧路径继续原有授权链）；
 *   - 判定只依据已验证 caller 与服务端回查事实：请求参数携带的 employeeId/appointmentId
 *     等身份字段一律不参与判定（防绕行，附录 D.5）。
 *
 * 读路径无写副作用、无事务需求（纯反查），直接走 workforceStore 各表。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { ManagedEmployeeRef, WorkCallerRef } from '../../../platform-core/src/workforce-port.ts'
import { appointmentInEffect } from './domain.ts'
import type { WorkforceIdentityResolver } from './contract.ts'
import type { AppointmentRecord, BindingRecord, IdentityResolution, AgentBindingState } from './contract.ts'
import type { WorkforceStoreService } from './repositories.ts'

export class IdentityResolverService extends Service implements WorkforceIdentityResolver {
  static readonly provide = 'workforceIdentity'

  constructor(ctx: Context) {
    super(ctx, 'workforceIdentity')
  }

  // -- 内部取用 -----------------------------------------------------------

  private get store(): WorkforceStoreService {
    return this.ctx.workforceStore
  }

  /** 同 Agent 的 active 绑定（一对一纪律兜底：多条时取最早 createdAt 一条，不以最新为准）。 */
  private activeBindingByAgent(agentId: string): BindingRecord | undefined {
    return this.store.bindings
      .findWhere({ agentId, status: 'active' })
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))[0]
  }

  /** 当前生效任用：status=effective 且在有效期窗口内（appointmentInEffect fail-closed），按 version 降序取最新。 */
  private latestEffectiveAppointment(employeeId: string): AppointmentRecord | undefined {
    return this.store.appointments
      .findWhere({ employeeId })
      .filter((appt) => appointmentInEffect(appt))
      .sort((a, b) => b.version - a.version)[0]
  }

  /** 绑定 → 完整受管身份：员工在岗 + 存在生效任用才返回非 null，否则 null（诚实缺位）。 */
  private resolutionFor(binding: BindingRecord): IdentityResolution | null {
    const employee = this.store.employees.get(binding.employeeId)
    if (!employee || employee.status !== 'active') return null
    const appointment = this.latestEffectiveAppointment(binding.employeeId)
    if (!appointment) return null
    return { employee, binding, appointment }
  }

  // -- 契约实现 -----------------------------------------------------------

  async resolveByCaller(caller: WorkCallerRef): Promise<IdentityResolution | null> {
    // human 一律 null：员工域没有「人是员工」的通道（§5，注释即契约语义）
    if (caller.kind !== 'machine') return null
    if (caller.refType !== 'agent') return null
    const refId = typeof caller.refId === 'string' ? caller.refId.trim() : ''
    if (refId === '') return null
    const binding = this.activeBindingByAgent(refId)
    if (!binding) return null
    return this.resolutionFor(binding)
  }

  async describeAgent(agentId: string): Promise<ManagedEmployeeRef | null> {
    const id = String(agentId ?? '').trim()
    if (id === '') return null
    const binding = this.activeBindingByAgent(id)
    if (!binding) return null
    const resolution = this.resolutionFor(binding)
    if (!resolution) return null
    // 受管引用全部来自服务端回查事实（员工/绑定/任用），不回显任何请求自带字段
    return {
      employeeId: resolution.employee.id,
      agentId: binding.agentId,
      appointmentId: resolution.appointment.id,
      appointmentVersion: resolution.appointment.version,
      workOrgId: resolution.appointment.orgId,
      dataClass: resolution.appointment.dataClass,
    }
  }

  /**
   * 绑定态三段探测（协作面治理第 2 项，P2-01）：未纳管 / 已纳管但 permit 失效 / permit 生效。
   * describeAgent 的二分（null 或受管）无法区分前两种——协作面必须区分：
   * 「从未纳管」按 legacy 放行，「已纳管但离岗/无任用」必须 fail-closed 拒绝。
   */
  async inspectAgent(agentId: string): Promise<AgentBindingState> {
    const id = String(agentId ?? '').trim()
    if (id === '') return { agentId: id, bound: false, permitEffective: false }
    const binding = this.activeBindingByAgent(id)
    if (!binding) return { agentId: id, bound: false, permitEffective: false }
    const employee = this.store.employees.get(binding.employeeId)
    if (!employee || employee.status !== 'active') {
      return {
        agentId: id, bound: true, permitEffective: false,
        employeeId: binding.employeeId, bindingId: binding.id, reason: 'EMPLOYEE_NOT_ACTIVE',
      }
    }
    const appointment = this.latestEffectiveAppointment(binding.employeeId)
    if (!appointment) {
      return {
        agentId: id, bound: true, permitEffective: false,
        employeeId: binding.employeeId, bindingId: binding.id, reason: 'NO_EFFECTIVE_APPOINTMENT',
      }
    }
    return {
      agentId: id, bound: true, permitEffective: true,
      employeeId: binding.employeeId, bindingId: binding.id,
    }
  }
}
