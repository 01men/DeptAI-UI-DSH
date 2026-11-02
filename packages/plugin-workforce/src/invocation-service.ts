/**
 * 受控调用账本服务（实施路径 §9.3/§9.4/§11.5/§11.6 的权威实现）。
 *
 * 调用状态机（§9.3）：reserved → completed / denied / approval_required /
 * rate_limited / failed / outcome_unknown / cancelled。HTTP 状态与领域状态分开保留，
 * 不以 HTTP 200 冒充业务成功。
 *
 * 步骤幂等（§11.5）：runId+stepKey 唯一约束；同步骤同参数已完成→回放原结果；
 * 执行中→返回当前状态；同步骤不同参数→STEP_ARGUMENT_CONFLICT（409）。
 * 网络调用一律在 txnStore 事务外（§9.4）：事务只做短检查/预留/提交。
 * usage 关联（§11.1）：只做 invocation↔usageEvent 映射，不复制消费流水、不双计。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {
  AdapterInvokeResult,
  AdapterRegistry,
  InvocationOutcome,
  InvocationRecord,
  InvocationRequest,
  InvocationStatus,
  ManifestRecord,
  ManifestToolHandle,
  PermitRecord,
  WorkforceIdentityResolver,
  WorkforceInvocations,
  WorkforceStore,
} from './contract.ts'
import { WorkforceError, STEP_KEY_PATTERN } from './contract.ts'
import { t } from '../../platform-i18n/src/index.ts'
import { argsHashOf, validateAgainstSchema } from './domain.ts'
import type { WorkCallerRef, WorkDenyCode, WorkExecutionContext } from '../../platform-core/src/workforce-port.ts'

/** 命中即视为「外部写请求已发出但结果不确定」（§11.5-4：先核验，禁止自动重写）。 */
const UNCERTAIN_TIMEOUT_PATTERN = /超时|timeout|abort|aborted|ECONNRESET|ETIMEDOUT/i

export class InvocationService extends Service implements WorkforceInvocations {
  static readonly provide = 'workforceInvocations'

  constructor(ctx: Context) {
    super(ctx, 'workforceInvocations')
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

  private get adapters(): AdapterRegistry {
    const registry = (this.ctx as unknown as { workforceAdapters?: AdapterRegistry }).workforceAdapters
    if (!registry || typeof registry.get !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceAdapters 未就绪'), 503)
    }
    return registry
  }

  private admission(): { verifyPermit: (caller: WorkCallerRef, permitId: string, opts?: { requireRun?: boolean }) => Promise<PermitRecord> } {
    const admission = (this.ctx as unknown as {
      workforceAdmission?: { verifyPermit?: WorkforceAdmission['verifyPermit'] }
    }).workforceAdmission
    if (!admission || typeof admission.verifyPermit !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceAdmission 未就绪'), 503)
    }
    return { verifyPermit: admission.verifyPermit.bind(admission) }
  }

  private capabilities(): { get: (manifestId: string) => ManifestRecord; resolveTool: (manifestId: string, handle: string) => ManifestToolHandle | undefined } {
    const capabilities = (this.ctx as unknown as {
      workforceCapabilities?: { get?: WorkforceCapabilities['get']; resolveTool?: WorkforceCapabilities['resolveTool'] }
    }).workforceCapabilities
    if (!capabilities || typeof capabilities.get !== 'function' || typeof capabilities.resolveTool !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceCapabilities 未就绪'), 503)
    }
    return { get: capabilities.get.bind(capabilities), resolveTool: capabilities.resolveTool.bind(capabilities) }
  }

  private emit(event: string, payload: unknown): void {
    try {
      ;(this.ctx as unknown as { platformBus?: { emit(name: string, payload: unknown): unknown } })
        .platformBus?.emit(event, payload)
    } catch {
      // platformBus 未注入当前 fiber 时跳过
    }
  }

  // -- 受控调用（§9.3/§9.4 权威实现） ---------------------------------------

  async invoke(caller: WorkCallerRef, request: InvocationRequest): Promise<InvocationOutcome> {
    const started = Date.now()
    // 1. permit 校验（存在/active/未过期/主体一致/run+租约绑定）
    const permit = await this.admission().verifyPermit(caller, request.permitId, { requireRun: true })
    const capabilities = this.capabilities()
    const manifest = capabilities.get(permit.manifestId)
    const tool = capabilities.resolveTool(permit.manifestId, request.toolHandle)
    if (!tool) {
      // 清单在而句柄不在＝未授予；清单本身缺失＝句柄无法解析
      throw new WorkforceError('TOOL_NOT_GRANTED', t('工具句柄 {handle} 未列入本任用能力清单（manifest v{version}）', { handle: request.toolHandle, version: manifest.version }))
    }
    // 2. stepKey 词法校验（§9.3：调用方提出的业务引用，不是可信身份）＋参数 schema＋业务范围
    if (!STEP_KEY_PATTERN.test(request.stepKey)) {
      throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('stepKey 非法：须为 1-96 位字母/数字/点/下划线/连字符，且以字母或数字开头'))
    }
    let args: Record<string, unknown>
    // validateAgainstSchema(值, schema) 返回「首条中文错误消息 | null」（非转换器）：
    // 先做 object 根检查，再校验；原实现把实参顺序与返回约定同时误用，invoke 恒拒（selftest 实证）
    const rawArgs = request.arguments ?? {}
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('参数必须为 JSON 对象（object 根）'))
    }
    const violation = validateAgainstSchema(rawArgs, tool.parameters ?? { type: 'object', properties: {} })
    if (violation) {
      throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('参数校验未通过：{violation}', { violation }))
    }
    args = rawArgs as Record<string, unknown>
    this.assertBusinessScope(tool, args)
    const argsHash = argsHashOf(args)

    // 3. 事务内预留（网络调用严禁入内，§9.4）：runId+stepKey 唯一约束承载步骤幂等
    const reserved = this.store.txn(() => {
      const prior = this.store.invocations.findWhere({ runId: permit.runId, stepKey: request.stepKey })[0]
      if (prior) {
        if (prior.argsHash !== argsHash) {
          throw new WorkforceError('STEP_ARGUMENT_CONFLICT', t('步骤 {stepKey} 已绑定不同参数（冲突拒绝，不能覆盖原动作）', { stepKey: request.stepKey }), 409)
        }
        return { replay: true as const, record: prior }
      }
      // TableStore.insert 为 void（落库副作用）——记录以本地变量返回，不得返回 insert() 结果
      const record: InvocationRecord = {
        id: `wfinv_${permit.runId}_${request.stepKey.replace(/[^A-Za-z0-9]/g, '')}_${Date.now().toString(36)}`,
        employeeId: permit.employeeId,
        appointmentId: permit.appointmentId,
        appointmentVersion: permit.appointmentVersion,
        runId: permit.runId,
        permitId: permit.id,
        stepKey: request.stepKey,
        kind: tool.kind,
        registryId: tool.registryId,
        action: tool.action,
        risk: tool.risk,
        argsHash,
        argsSummaryJson: JSON.stringify(this.summarizeArgs(args)),
        status: 'reserved',
        errorCode: '',
        message: '',
        gatewayRefJson: '{}',
        usageEventIdsJson: '[]',
        approvalRef: '',
        latencyMs: 0,
        createdAt: new Date().toISOString(),
        settledAt: '',
      }
      this.store.invocations.insert(record)
      return { replay: false as const, record }
    })

    if (reserved.replay) {
      return this.replayOutcome(reserved.record)
    }

    // 4. 事务外：任用/租约复核（§9.4 revalidate）→ 适配器缺席 denied → 网络调用
    const appointment = this.store.appointments.get(permit.appointmentId)
    if (!appointment || appointment.status !== 'effective') {
      return this.settle(reserved.record, 'denied', {
        code: 'APPOINTMENT_NOT_EFFECTIVE',
        message: t('任用已不在生效状态，停止本步骤调用'),
      }, started)
    }
    const adapter = this.adapters.get(tool.kind)
    if (!adapter) {
      return this.settle(reserved.record, 'denied', {
        code: 'TOOL_NOT_GRANTED',
        message: t('该资源类型（{kind}）未登记适配器，拒绝调用', { kind: tool.kind }),
      }, started)
    }

    const work = this.workContextOf(permit, appointment, request.traceId)
    let result: AdapterInvokeResult
    try {
      result = await adapter.invoke({ work, tool, args, invocationId: reserved.record.id })
    } catch (error) {
      result = { ok: false, message: t('适配器执行异常：{message}', { message: error instanceof Error ? error.message : String(error) }) }
    }

    // 5. settle：AdapterInvokeResult → InvocationOutcome（§9.3 状态语义）
    return this.settleFromAdapter(reserved.record, result, started)
  }

  /** 步骤回放（§11.5-1/2）：同 run 同步骤同参数的既有事实。 */
  private replayOutcome(record: InvocationRecord): InvocationOutcome {
    switch (record.status) {
      case 'completed':
        return {
          status: 'completed',
          invocationId: record.id,
          ...(record.gatewayRefJson !== '{}' ? { gatewayRef: this.parseJson(record.gatewayRefJson, {}) } : {}),
          // D2 修复：回放与原完成路径（settle）同源——workContextFromRecord 从记录关联的
          // permit/任用重建可信执行上下文；此前误引用作用域外标识符 tool，completed 步骤回放即抛错
          work: this.workContextFromRecord(record),
        }
      case 'outcome_unknown':
        return { status: 'outcome_unknown', invocationId: record.id, message: t('该步骤存在未决历史执行，请先核验，禁止自动重试写入') }
      case 'approval_required':
        return { status: 'approval_required', invocationId: record.id, message: record.message || t('该步骤等待业务审批'), ...(record.approvalRef ? { approvalRef: record.approvalRef } : {}) }
      case 'rate_limited':
        return { status: 'rate_limited', invocationId: record.id, message: record.message || t('命中流控，请按服务端重试策略退避') }
      case 'denied':
        return { status: 'denied', invocationId: record.id, code: (record.errorCode || 'TOOL_NOT_GRANTED') as WorkDenyCode, message: record.message || t('该步骤已被拒绝，停止重试') }
      case 'cancelled':
        return { status: 'denied', invocationId: record.id, code: 'APPOINTMENT_NOT_EFFECTIVE' as WorkDenyCode, message: t('该步骤所属任务或任用已撤销，停止后续调用') }
      case 'failed':
        return { status: 'failed', invocationId: record.id, message: record.message || t('该步骤此前确认失败') }
      case 'reserved':
      default:
        // 上次尝试中断（进程崩溃）：写入类风险按结果未知处理（§11.7：已发送未确认的写动作不重执行）
        if (record.risk !== 'read') {
          return { status: 'outcome_unknown', invocationId: record.id, message: t('该步骤存在中断残留的执行记录，请先核验外部结果') }
        }
        throw new WorkforceError('RATE_LIMITED', t('同一步骤的只读调用正在执行，请稍后重试'), 429)
    }
  }

  /** 业务范围约束（§9.2/§D.10：factoryIds/pathPrefixes/maxRows/allowedModels 基础项，服务端执行）。 */
  private assertBusinessScope(tool: ManifestToolHandle, args: Record<string, unknown>): void {
    const constraints = tool.constraints ?? {}
    const deny = (detail: string): never => {
      throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('参数超出任用边界：{detail}', { detail }))
    }
    // 工厂范围：声明 factoryIds 时 args.factoryId 必须命中
    const factoryIds = constraints['factoryIds']
    if (Array.isArray(factoryIds) && factoryIds.length > 0 && typeof args['factoryId'] === 'string') {
      if (!factoryIds.includes(args['factoryId'])) deny(t('factoryId {factoryId} 不在授权工厂范围内', { factoryId: String(args['factoryId']) }))
    }
    // 目录范围：声明 pathPrefixes 时 args.path 必须命中前缀（NAS 适配器再复核一次）
    const pathPrefixes = constraints['pathPrefixes']
    if (Array.isArray(pathPrefixes) && pathPrefixes.length > 0 && typeof args['path'] === 'string') {
      const path = String(args['path'])
      if (!pathPrefixes.some((prefix) => typeof prefix === 'string' && path.startsWith(prefix))) {
        deny(t('路径 {path} 超出授权目录范围', { path }))
      }
    }
    // 行数上限：服务端钳制（不信任客户端自觉）
    const maxRows = constraints['maxRows']
    if (typeof maxRows === 'number' && maxRows > 0) {
      for (const key of ['limit', 'maxRows', 'size']) {
        const value = args[key]
        if (typeof value === 'number' && value > maxRows) args[key] = maxRows
      }
    }
    // 模型白名单：声明 allowedModels 时 args.model 必须命中（缺省按句柄 registryId）
    const allowedModels = constraints['allowedModels']
    if (tool.kind === 'model' && Array.isArray(allowedModels) && allowedModels.length > 0 && typeof args['model'] === 'string') {
      if (!allowedModels.includes(args['model'])) deny(t('模型 {model} 不在授权模型范围内', { model: String(args['model']) }))
    }
  }

  /** 参数摘要（§11.4：规范参数摘要入审计，敏感值脱敏，不复制原始敏感内容）。 */
  private summarizeArgs(args: Record<string, unknown>, depth = 0): Record<string, unknown> {
    if (depth > 3) return { '…': '（摘要截断）' }
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined) continue
      if (/token|secret|password|apikey|authorization/i.test(key)) {
        out[key] = '***'
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = this.summarizeArgs(value as Record<string, unknown>, depth + 1)
      } else if (Array.isArray(value)) {
        out[key] = value.length > 8 ? `(${value.length} items)` : value
      } else if (typeof value === 'string' && value.length > 200) {
        out[key] = `${value.slice(0, 200)}…(${value.length} chars)`
      } else {
        out[key] = value
      }
    }
    return out
  }

  /** AdapterInvokeResult → InvocationOutcome + 落账 + 事件（§9.3 全状态语义）。 */
  private settleFromAdapter(record: InvocationRecord, result: AdapterInvokeResult, started: number): InvocationOutcome {
    const message = result.message ?? ''
    if (result.ok && !result.outcomeUnknown) {
      return this.settle(record, 'completed', {
        message: 'ok',
        gatewayRef: result.gatewayRef,
        usageEventIds: result.usageEventIds,
        value: result.value,
        content: result.content,
      }, started)
    }
    if (result.outcomeUnknown || (UNCERTAIN_TIMEOUT_PATTERN.test(message) && record.risk !== 'read')) {
      return this.settle(record, 'outcome_unknown', {
        message: message || t('外部结果不确定：请求可能已生效，请先查证核验，禁止自动重试写入'),
        gatewayRef: result.gatewayRef,
      }, started)
    }
    if (result.rateLimited) {
      return this.settle(record, 'rate_limited', { message: message || t('命中可重试流控，请按服务端重试策略退避'), gatewayRef: result.gatewayRef }, started)
    }
    if (result.approvalRef) {
      return this.settle(record, 'approval_required', { message: message || t('该动作需要业务审批，请展示审批单并等待'), approvalRef: result.approvalRef, gatewayRef: result.gatewayRef }, started)
    }
    // 资源级拒绝（网关原有授权链/熔断）→ denied（停止，不换入口重试）；其余为 failed
    const denied = result.gatewayRef?.['outcome'] === 'denied'
    return this.settle(record, denied ? 'denied' : 'failed', {
      code: denied ? 'TOOL_NOT_GRANTED' : undefined,
      message: message || (denied ? t('资源网关拒绝该调用') : t('执行失败')),
      gatewayRef: result.gatewayRef,
    }, started)
  }

  /** 落账（事务外单行 update）+ usage 关联 + 事件。 */
  private settle(
    record: InvocationRecord,
    status: Exclude<InvocationStatus, 'reserved'>,
    detail: {
      code?: string
      message: string
      gatewayRef?: Record<string, unknown>
      usageEventIds?: string[]
      approvalRef?: string
      value?: unknown
      content?: string
    },
    started: number,
  ): InvocationOutcome {
    const latencyMs = Date.now() - started
    this.store.invocations.update(record.id, {
      status,
      errorCode: detail.code ?? '',
      message: detail.message,
      gatewayRefJson: JSON.stringify(detail.gatewayRef ?? {}),
      usageEventIdsJson: JSON.stringify(detail.usageEventIds ?? []),
      approvalRef: detail.approvalRef ?? '',
      latencyMs,
      settledAt: new Date().toISOString(),
    })
    for (const usageEventId of detail.usageEventIds ?? []) {
      // usage 增量关联（§11.1/§11.3）：只做映射不复制流水；同对唯一约束保证幂等
      this.linkUsage(record.id, usageEventId, String(detail.gatewayRef?.['resource'] ?? ''))
    }
    this.emit('workforce.invocation.settled', {
      invocationId: record.id, runId: record.runId, employeeId: record.employeeId,
      stepKey: record.stepKey, kind: record.kind, registryId: record.registryId, action: record.action,
      status, latencyMs,
      ...(detail.code ? { errorCode: detail.code } : {}),
    })
    switch (status) {
      case 'completed':
        return {
          status: 'completed',
          invocationId: record.id,
          ...(detail.value !== undefined ? { value: detail.value } : {}),
          ...(detail.content !== undefined ? { content: detail.content } : {}),
          ...(detail.gatewayRef ? { gatewayRef: detail.gatewayRef } : {}),
          work: this.workContextFromRecord(record),
        }
      case 'denied':
        return { status: 'denied', invocationId: record.id, code: (detail.code ?? 'TOOL_NOT_GRANTED') as WorkDenyCode, message: detail.message }
      case 'approval_required':
        return { status: 'approval_required', invocationId: record.id, message: detail.message, ...(detail.approvalRef ? { approvalRef: detail.approvalRef } : {}) }
      case 'rate_limited':
        return { status: 'rate_limited', invocationId: record.id, message: detail.message }
      case 'outcome_unknown':
        return { status: 'outcome_unknown', invocationId: record.id, message: detail.message }
      case 'failed':
      case 'cancelled':
      default:
        return { status: 'failed', invocationId: record.id, message: detail.message, ...(detail.code ? { code: detail.code as WorkDenyCode } : {}) }
    }
  }

  // -- 归属与查询 ---------------------------------------------------------

  /** 归属判定：员工本人，或 human（入口已把守 workforce.read）且与工作组织同组织。 */
  private async assertReadable(caller: WorkCallerRef, workOrgId: string, subject: string): Promise<void> {
    const resolution = await this.identity.resolveByCaller(caller)
    if (resolution && resolution.employee.id === subject) return
    if (caller.kind === 'human') {
      const userOrg = this.humanOrgId(caller)
      if (userOrg !== null && userOrg === workOrgId) return
    }
    throw new WorkforceError('RUN_NOT_OWNED', t('无权查看该调用记录（仅本人或同组织 workforce.read 主体）'))
  }

  /** human 组织反查（结构化探测 iam；解析失败一律 fail-closed 拒绝）。 */
  private humanOrgId(caller: WorkCallerRef): string | null {
    if (!caller.userId) return null
    try {
      const iam = (this.ctx as unknown as { iam?: { users?: () => { get(id: string): { orgId?: string } | undefined } } }).iam
      const user = typeof iam?.users === 'function' ? iam.users().get(caller.userId) : undefined
      return typeof user?.orgId === 'string' ? user.orgId : null
    } catch {
      return null
    }
  }

  private workOrgOf(record: { appointmentId: string }): string {
    return this.store.appointments.get(record.appointmentId)?.orgId ?? ''
  }

  async get(caller: WorkCallerRef, invocationId: string): Promise<InvocationRecord> {
    const record = this.store.invocations.get(invocationId)
    if (!record) throw new WorkforceError('RUN_NOT_OWNED', t('调用记录不存在或无权访问'), 404)
    await this.assertReadable(caller, this.workOrgOf(record), record.employeeId)
    return record
  }

  async listByRun(caller: WorkCallerRef, runId: string): Promise<InvocationRecord[]> {
    const records = this.store.invocations.findWhere({ runId })
    if (records.length === 0) return []
    await this.assertReadable(caller, this.workOrgOf(records[0]!), records[0]!.employeeId)
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  linkUsage(invocationId: string, usageEventId: string, resource: string): void {
    const existing = this.store.usageLinks.findWhere({ invocationId, usageEventId })
    if (existing.length > 0) return
    this.store.usageLinks.insert({
      id: `wfusage_${invocationId}_${usageEventId}`.slice(0, 120),
      invocationId,
      usageEventId,
      resource,
      createdAt: new Date().toISOString(),
    })
  }

  /** outcome_unknown 核验回写（人工/对账后调用；仅允许从 outcome_unknown 迁移）。 */
  reconcile(id: string, status: 'completed' | 'failed', message: string, gatewayRef?: Record<string, unknown>): void {
    const record = this.store.invocations.get(id)
    if (!record) throw new WorkforceError('RUN_NOT_OWNED', t('调用记录不存在：{id}', { id }), 404)
    if (record.status !== 'outcome_unknown') {
      throw new WorkforceError('STEP_ARGUMENT_CONFLICT', t('仅 outcome_unknown 记录可核验回写（当前 {status}）', { status: record.status }))
    }
    this.store.invocations.update(id, {
      status,
      message,
      ...(gatewayRef ? { gatewayRefJson: JSON.stringify({ ...this.parseJson(record.gatewayRefJson, {}), ...gatewayRef }) } : {}),
      settledAt: new Date().toISOString(),
    })
    this.emit('workforce.invocation.settled', {
      invocationId: id, runId: record.runId, employeeId: record.employeeId,
      stepKey: record.stepKey, kind: record.kind, registryId: record.registryId, action: record.action,
      status, latencyMs: record.latencyMs, reconciled: true,
    })
  }

  // -- 内部 ---------------------------------------------------------------

  private workContextOf(permit: PermitRecord, appointment: { orgId: string; dataClass: WorkExecutionContext['dataClass'] }, traceId?: string): WorkExecutionContext {
    return {
      employeeId: permit.employeeId,
      agentId: permit.agentId,
      principalId: permit.principalId,
      appointmentId: permit.appointmentId,
      appointmentVersion: permit.appointmentVersion,
      workOrgId: appointment.orgId,
      dataClass: appointment.dataClass,
      issueId: permit.issueId,
      runId: permit.runId,
      leaseVersion: permit.leaseVersion,
      permitId: permit.id,
      capabilityManifestId: permit.manifestId,
      policyVersion: permit.appointmentVersion,
      ...(traceId ? { traceId } : {}),
    }
  }

  private workContextFromRecord(record: InvocationRecord): WorkExecutionContext {
    const appointment = this.store.appointments.get(record.appointmentId)
    const permit = this.store.permits.get(record.permitId)
    return {
      employeeId: record.employeeId,
      agentId: permit?.agentId ?? '',
      principalId: permit?.principalId ?? '',
      appointmentId: record.appointmentId,
      appointmentVersion: record.appointmentVersion,
      workOrgId: appointment?.orgId ?? '',
      dataClass: appointment?.dataClass ?? 'internal',
      issueId: permit?.issueId ?? '',
      runId: record.runId,
      leaseVersion: permit?.leaseVersion ?? 0,
      permitId: record.permitId,
      capabilityManifestId: permit?.manifestId ?? '',
      policyVersion: record.appointmentVersion,
    }
  }

  private parseJson<T>(text: string, fallback: T): T {
    try {
      return JSON.parse(text) as T
    } catch {
      return fallback
    }
  }
}
