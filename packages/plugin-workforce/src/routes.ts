/**
 * REST 工作面（/api/workforce/*，路径与权限点以 manifest/api.yaml 为唯一事实源）。
 *
 * 统一约定：callerRef＝gate.caller(exchange)（console 鉴权中间件先行写入 principal）；
 * WorkforceError → exchange.fail(e.httpStatus, e.code, e.message)；
 * 管理类写操作走 gate.changeLog 留痕（受控调用/交付自身已是权威账本，不重复审计）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createRestGate, type RestGate } from '../../platform-core/src/rest-gate.ts'
import type { HttpExchange } from '../../platform-core/src/http.ts'
import type { WorkCallerRef, WorkDataClass } from '../../platform-core/src/workforce-port.ts'
import {
  WorkforceError,
  type EmployeeRecord,
  type EmployeeStatus,
  type ResourceGrantSpec,
  type WorkforceAdmission,
  type WorkforceAppointments,
  type WorkforceArtifacts,
  type WorkforceDelivery,
  type WorkforceEmployees,
  type WorkforceIdentityResolver,
  type WorkforceInvocations,
  type WorkforceStore,
} from './contract.ts'
import { t } from '../../platform-i18n/src/index.ts'
import type { MaintenanceRunResult } from './maintenance-service.ts'

interface WorkforceServices {
  store: WorkforceStore
  employees: WorkforceEmployees
  appointments: WorkforceAppointments
  identity: WorkforceIdentityResolver
  admission: WorkforceAdmission
  invocations: WorkforceInvocations
  artifacts: WorkforceArtifacts
  delivery: WorkforceDelivery
}

function services(ctx: Context): WorkforceServices {
  const source = ctx as unknown as Partial<WorkforceServices> & Record<string, unknown>
  const missing = (['workforceStore', 'workforceEmployees', 'workforceAppointments', 'workforceIdentity',
    'workforceAdmission', 'workforceInvocations', 'workforceArtifacts', 'workforceDelivery'] as const)
    .filter((key) => !source[key])
  if (missing.length > 0) {
    throw new WorkforceError('WORKFORCE_NOT_READY', t('数字员工服务未就绪：{missing}', { missing: missing.join('、') }), 503)
  }
  // 显式按接口字段名组包（ctx 不得原样强转返回：调用方按 store/employees/… 取用，
  // 而 ctx 上的服务键是 workforceStore/workforceEmployees/…——原样返回会让 svc.store
  // 变成对 ctx 的未知属性读取，被 cordis 判 without inject 抛 400）
  return {
    store: source.workforceStore,
    employees: source.workforceEmployees,
    appointments: source.workforceAppointments,
    identity: source.workforceIdentity,
    admission: source.workforceAdmission,
    invocations: source.workforceInvocations,
    artifacts: source.workforceArtifacts,
    delivery: source.workforceDelivery,
  } as WorkforceServices
}

/** gate.caller → 可信 caller（与 tools.ts 同规则；禁止从请求体读身份）。 */
function callerRefOf(gate: RestGate, exchange: HttpExchange): WorkCallerRef {
  const info = gate.caller(exchange)
  return {
    kind: info.kind,
    principalId: info.principalId,
    ...(info.userId ? { userId: info.userId } : {}),
    ...(info.refType !== undefined ? { refType: info.refType } : {}),
    ...(info.refId !== undefined ? { refId: info.refId } : {}),
    ...(info.name ? { name: info.name } : {}),
  }
}

/** 统一错误出口：领域错误按 httpStatus/code 透传，其余 400。 */
function failOf(exchange: HttpExchange, error: unknown): void {
  if (error instanceof WorkforceError) {
    exchange.fail(error.httpStatus, error.code, error.message)
    return
  }
  exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
}

function readBody(exchange: HttpExchange): Record<string, unknown> {
  const body = exchange.body
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
}

function publicEmployee(record: EmployeeRecord): Record<string, unknown> {
  return {
    id: record.id, name: record.name, displayName: record.displayName, orgId: record.orgId,
    supervisorUserId: record.supervisorUserId, status: record.status, primaryAgentId: record.primaryAgentId,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  }
}

function parseGrants(value: unknown): ResourceGrantSpec[] {
    if (!Array.isArray(value)) throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('grants 必须为数组'))
    return value.map((item) => {
      const grant = item as Record<string, unknown>
      const kind = grant['kind']
      if (kind !== 'mcp' && kind !== 'connector' && kind !== 'model' && kind !== 'skill' && kind !== 'nas' && kind !== 'app') {
        throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('非法授权类型：{kind}', { kind: String(kind) }))
      }
      const risk = grant['risk']
      if (risk !== 'read' && risk !== 'write' && risk !== 'admin') {
        throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('非法风险级：{risk}', { risk: String(risk) }))
      }
      const registryId = String(grant['registryId'] ?? '')
      if (!registryId) throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('授权缺少 registryId'))
      const actions = Array.isArray(grant['actions']) ? grant['actions'].map((action) => String(action)) : []
      if (actions.length === 0) throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('授权 {registryId} 缺少动作清单（未知风险工具不得默认开放）', { registryId }))
    return {
      kind, registryId, actions, risk,
      constraints: grant['constraints'] && typeof grant['constraints'] === 'object'
        ? grant['constraints'] as Record<string, unknown>
        : undefined,
    }
  })
}

export function registerWorkforceRoutes(ctx: Context): void {
  const gate = createRestGate(ctx as unknown as Parameters<typeof createRestGate>[0])

  // -- 总览 ---------------------------------------------------------------

  gate.guarded('GET', '/api/workforce/overview', 'workforce.read', () => {
    const svc = services(ctx)
    return {
      employees: svc.store.employees.count(),
      bindings: svc.store.bindings.count(),
      appointments: svc.store.appointments.count(),
      permits: svc.store.permits.findWhere({ status: 'active' }).length,
      invocations: svc.store.invocations.count(),
      deliverables: svc.store.deliverables.count(),
      artifacts: svc.store.artifacts.count(),
    }
  })

  // -- 员工 ---------------------------------------------------------------

  gate.guarded('GET', '/api/workforce/employees', 'workforce.read', (exchange) => {
    const svc = services(ctx)
    // 查询串取 exchange.query（HttpExchange 无 request 字段——W 批次修复存量缺陷，原 exchange.request.url 运行时必炸）
    const orgId = exchange.query.get('orgId') ?? undefined
    const status = exchange.query.get('status') ?? undefined
    const records = svc.employees.list({
      ...(orgId ? { orgId } : {}),
      ...(status ? { status: status as EmployeeStatus } : {}),
    })
    return records.map(publicEmployee)
  })

  gate.guarded('POST', '/api/workforce/employees', 'workforce.write', (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const record = svc.employees.create({
      name: String(body['name'] ?? ''),
      ...(body['displayName'] !== undefined ? { displayName: String(body['displayName']) } : {}),
      orgId: String(body['orgId'] ?? ''),
      supervisorUserId: String(body['supervisorUserId'] ?? ''),
      agentId: String(body['agentId'] ?? ''),
      ...(body['principalId'] !== undefined ? { principalId: String(body['principalId']) } : {}),
      ...(body['runtime'] !== undefined ? { runtime: String(body['runtime']) } : {}),
    })
    gate.changeLog(exchange, 'workforce.employee.create', 'employee', record.id, record.name)
    return publicEmployee(record)
  })

  gate.guarded('GET', '/api/workforce/employees/:id', 'workforce.read', (exchange) => {
    const svc = services(ctx)
    return {
      ...publicEmployee(svc.employees.get(exchange.params['id'] ?? '')),
      bindings: svc.employees.bindingsFor(exchange.params['id'] ?? ''),
    }
  })

  gate.guarded('POST', '/api/workforce/employees/:id/status', 'workforce.write', async (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const status = String(body['status'] ?? '')
    if (status !== 'active' && status !== 'suspended' && status !== 'offboarded') {
      throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('非法员工状态：{status}', { status }))
    }
    const record = await svc.employees.setStatus(callerRefOf(gate, exchange), exchange.params['id'] ?? '', status, String(body['reason'] ?? ''))
    gate.changeLog(exchange, 'workforce.employee.status', 'employee', record.id, record.name, `→ ${status}（${String(body['reason'] ?? '')}）`)
    return publicEmployee(record)
  })

  gate.guarded('POST', '/api/workforce/employees/:id/bindings', 'workforce.write', (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const binding = svc.employees.bindAgent(
      callerRefOf(gate, exchange),
      exchange.params['id'] ?? '',
      String(body['agentId'] ?? ''),
      ...(body['principalId'] !== undefined ? [String(body['principalId'])] as const : []),
      ...(body['runtime'] !== undefined ? [String(body['runtime'])] as const : []),
    )
    gate.changeLog(exchange, 'workforce.employee.bind', 'binding', binding.id, `${binding.employeeId} → ${binding.agentId}`)
    return binding
  })

  // -- 任用 ---------------------------------------------------------------

  gate.guarded('GET', '/api/workforce/appointments', 'workforce.read', (exchange) => {
    const svc = services(ctx)
    const employeeId = exchange.query.get('employeeId') ?? undefined
    const status = exchange.query.get('status') ?? undefined
    return svc.appointments.list({
      ...(employeeId ? { employeeId } : {}),
      ...(status ? { status: status as 'preparing' | 'effective' | 'revoking' | 'revoked' | 'failed' } : {}),
    })
  })

  gate.guarded('POST', '/api/workforce/appointments', 'workforce.write', (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const actor = gate.actorOf(exchange)
    const record = svc.appointments.create({
      employeeId: String(body['employeeId'] ?? ''),
      position: String(body['position'] ?? ''),
      orgId: String(body['orgId'] ?? ''),
      dataClass: String(body['dataClass'] ?? 'internal') as WorkDataClass,
      effectiveFrom: String(body['effectiveFrom'] ?? new Date().toISOString()),
      ...(body['effectiveUntil'] !== undefined ? { effectiveUntil: String(body['effectiveUntil']) } : {}),
      grants: parseGrants(body['grants']),
      approvedBy: String(body['approvedBy'] ?? actor),
      ...(body['approvalRef'] !== undefined ? { approvalRef: String(body['approvalRef']) } : {}),
    })
    gate.changeLog(exchange, 'workforce.appointment.create', 'appointment', record.id, `${record.employeeId} v${record.version}`)
    return record
  })

  gate.guarded('POST', '/api/workforce/appointments/:id/activate', 'workforce.write', async (exchange) => {
    const svc = services(ctx)
    const record = await svc.appointments.activate(callerRefOf(gate, exchange), exchange.params['id'] ?? '')
    gate.changeLog(exchange, 'workforce.appointment.activate', 'appointment', record.id, `→ ${record.status}`)
    return record
  })

  gate.guarded('POST', '/api/workforce/appointments/:id/revoke', 'workforce.write', async (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const record = await svc.appointments.revoke(callerRefOf(gate, exchange), exchange.params['id'] ?? '', String(body['reason'] ?? ''))
    gate.changeLog(exchange, 'workforce.appointment.revoke', 'appointment', record.id, `→ ${record.status}（${String(body['reason'] ?? '')}）`)
    return record
  })

  // -- 待办拉取（运行时按机器主体反查员工待办，不接受任意员工过滤，§13.1） ---------

  gate.guarded('GET', '/api/workforce/work-items', 'workforce.invoke', async (exchange) => {
    const svc = services(ctx)
    const caller = callerRefOf(gate, exchange)
    const resolution = await svc.identity.resolveByCaller(caller)
    if (!resolution) throw new WorkforceError('EMPLOYEE_NOT_ACTIVE', t('非受管数字员工或绑定缺失'))
    const agentId = resolution.binding.agentId
    const hub = (ctx as unknown as {
      execHub?: { issues?: () => { all(): Array<Record<string, unknown>> } }
    }).execHub
    if (!hub || typeof hub.issues !== 'function') {
      exchange.fail(503, 'EXEC_HUB_UNAVAILABLE', t('执行中枢未就绪，无法拉取待办'))
      return
    }
    const issues = hub.issues().all()
      .filter((issue) => issue['assigneeAgentId'] === agentId && (issue['status'] === 'todo' || issue['status'] === 'in_progress'))
      .map((issue) => ({
        id: issue['id'], title: issue['title'], status: issue['status'], priority: issue['priority'],
        dueAt: issue['dueAt'] ?? '', executionRunId: issue['executionRunId'] ?? '',
      }))
    return { employeeId: resolution.employee.id, agentId, items: issues }
  })

  // -- 认领与续租 -----------------------------------------------------------

  gate.guarded('POST', '/api/workforce/claims', 'workforce.invoke', async (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const outcome = await svc.admission.claimWork(callerRefOf(gate, exchange), {
      issueId: String(body['issueId'] ?? ''),
      ...(typeof body['agentKey'] === 'string' && body['agentKey'] ? { agentKey: body['agentKey'] } : {}),
      ...(typeof body['ttlMinutes'] === 'number' && body['ttlMinutes'] > 0 ? { ttlMs: Math.round(body['ttlMinutes'] * 60_000) } : {}),
    })
    if (!outcome.ok) {
      exchange.fail(outcome.code === 'WORKFORCE_NOT_READY' ? 503 : 403, outcome.code, outcome.message,
        outcome.holder ? { holder: outcome.holder } : undefined)
      return
    }
    gate.changeLog(exchange, 'workforce.claim', 'run', outcome.runId, `issue=${outcome.issueId} employee=${outcome.employeeId}`)
    return {
      ok: true,
      employeeId: outcome.employeeId,
      issueId: outcome.issueId,
      runId: outcome.runId,
      lease: outcome.lease,
      permit: outcome.permit,
      manifest: outcome.manifest,
      tools: outcome.tools.map((tool) => tool.handle),
      idempotent: outcome.idempotent,
    }
  })

  gate.guarded('POST', '/api/workforce/leases/:id/renew', 'workforce.invoke', async (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const result = await svc.admission.renewWorkLease(
      callerRefOf(gate, exchange),
      exchange.params['id'] ?? '',
      typeof body['ttlMinutes'] === 'number' && body['ttlMinutes'] > 0 ? Math.round(body['ttlMinutes'] * 60_000) : undefined,
    )
    if (!result.ok) {
      exchange.fail(result.code === 'EXEC_HUB_UNAVAILABLE' ? 503 : 403, result.code, result.message)
      return
    }
    return { ok: true, lease: result.lease }
  })

  // -- 受控调用账本 ---------------------------------------------------------

  gate.guarded('POST', '/api/workforce/invocations', 'workforce.invoke', async (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const outcome = await svc.invocations.invoke(callerRefOf(gate, exchange), {
      permitId: String(body['permitId'] ?? ''),
      toolHandle: String(body['toolHandle'] ?? ''),
      stepKey: String(body['stepKey'] ?? ''),
      arguments: body['arguments'],
      ...(typeof body['traceId'] === 'string' && body['traceId'] ? { traceId: body['traceId'] } : {}),
    })
    // 领域状态与 HTTP 状态分开保留（§9.3：不以 HTTP 200 冒充业务成功，也不以 4xx 丢失领域状态）
    return { ok: outcome.status === 'completed', ...outcome }
  })

  gate.guarded('GET', '/api/workforce/invocations/:id', 'workforce.invoke', async (exchange) => {
    const svc = services(ctx)
    return svc.invocations.get(callerRefOf(gate, exchange), exchange.params['id'] ?? '')
  })

  gate.guarded('GET', '/api/workforce/invocations', 'workforce.invoke', async (exchange) => {
    const svc = services(ctx)
    const runId = exchange.query.get('runId') ?? ''
    if (!runId) throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('缺少 runId 查询参数'))
    return svc.invocations.listByRun(callerRefOf(gate, exchange), runId)
  })

  // -- 受控 artifact ---------------------------------------------------------

  gate.guarded('POST', '/api/workforce/artifacts', 'workforce.invoke', async (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const record = await svc.artifacts.createUpload(callerRefOf(gate, exchange), {
      name: String(body['name'] ?? ''),
      contentType: String(body['contentType'] ?? 'application/octet-stream'),
      contentBase64: String(body['contentBase64'] ?? ''),
      ...(typeof body['runId'] === 'string' && body['runId'] ? { runId: body['runId'] } : {}),
    })
    return {
      id: record.id, name: record.name, sizeBytes: record.sizeBytes,
      sha256: record.sha256, runId: record.runId, createdAt: record.createdAt,
    }
  })

  gate.guarded('GET', '/api/workforce/artifacts/:id', 'workforce.invoke', async (exchange) => {
    const svc = services(ctx)
    return svc.artifacts.get(callerRefOf(gate, exchange), exchange.params['id'] ?? '')
  })

  // -- 交付 -----------------------------------------------------------------

  gate.guarded('POST', '/api/workforce/deliverables', 'workforce.invoke', async (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const record = await svc.delivery.submit(callerRefOf(gate, exchange), {
      permitId: String(body['permitId'] ?? ''),
      summary: String(body['summary'] ?? ''),
      artifactIds: Array.isArray(body['artifactIds']) ? body['artifactIds'].map((item) => String(item)) : [],
    })
    gate.changeLog(exchange, 'workforce.deliverable.submit', 'deliverable', record.id, `run=${record.runId} v${record.version}`)
    return record
  })

  gate.guarded('GET', '/api/workforce/deliverables', 'workforce.invoke', async (exchange) => {
    const svc = services(ctx)
    const runId = exchange.query.get('runId') ?? ''
    if (!runId) throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('缺少 runId 查询参数'))
    return svc.delivery.listByRun(callerRefOf(gate, exchange), runId)
  })

  // -- 验收（真人，workforce.accept） -----------------------------------------

  gate.guarded('POST', '/api/workforce/acceptances', 'workforce.accept', async (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const decision = String(body['decision'] ?? '')
    if (decision !== 'accepted' && decision !== 'rejected') {
      throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('非法验收决定：{decision}', { decision }))
    }
    const record = await svc.delivery.decide(callerRefOf(gate, exchange), {
      deliverableId: String(body['deliverableId'] ?? ''),
      decision,
      reason: String(body['reason'] ?? ''),
    })
    gate.changeLog(exchange, 'workforce.acceptance.decide', 'deliverable', record.id, `${decision}（${record.decisionReason}）`)
    return record
  })

  // -- 运维面（workforce.admin，W5 决策 D-③ three-in-one 最小集） ---------------------------
  // 本段是 workforce.admin 权限点的代码落点（此前仅清单/目录声明，contract-lint 报 perm_unused
  // 预留告警；此处 guarded 第三参字面量即销账依据——routeRe 只认字面量引用）。
  // 跨组织口径：admin 运维面直接读 store 表做穿透查询，不走 invocation-service 的 assertReadable
  // （org 隔离是员工工作面的口径）——权限点即边界。

  /** audit/invocations 查询的公共 limit 口径：默认 50，上限 500（穿透查询防全量拖库）。 */
  function readLimit(query: URLSearchParams): number {
    const raw = Number(query.get('limit') ?? 50)
    return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 500) : 50
  }

  gate.guarded('POST', '/api/workforce/admin/employees/status-batch', 'workforce.admin', async (exchange) => {
    const svc = services(ctx)
    const body = readBody(exchange)
    const rawIds = Array.isArray(body['employeeIds']) ? body['employeeIds'].map((item) => String(item).trim()) : []
    const employeeIds = [...new Set(rawIds.filter((item) => item !== ''))]
    if (employeeIds.length === 0) throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('employeeIds 必须为非空员工 ID 数组'))
    if (employeeIds.length > 200) throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('employeeIds 单批上限 200（逐员工撤权联动，防止超长批次）'))
    const status = String(body['status'] ?? '')
    if (status !== 'suspended' && status !== 'active') {
      throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('批量状态只允许 suspended（停职）/ active（复岗）：{status}', { status: status || t('（空）') }))
    }
    const reason = String(body['reason'] ?? '').trim()
    if (reason === '') throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('批量停职/复岗必须登记 reason（审计与解冻依据）'))
    const caller = callerRefOf(gate, exchange)
    const now = new Date().toISOString()
    const results: Array<{ employeeId: string; ok: boolean; error?: string; revokedPermits?: number; releasedRuns?: string[] }> = []
    // 逐员工独立事务（不整批回滚）：setStatus 内部「撤 permit→释放租约→状态落库」是单员工
    // 完整 fail-closed 闭环（employee-service.ts 一字不改）；部分失败如实呈现在 results，
    // 响应即实体现实况，运维按条补办。
    for (const employeeId of employeeIds) {
      const beforeActive = svc.store.permits.findWhere({ employeeId, status: 'active' })
      try {
        await svc.employees.setStatus(caller, employeeId, status, reason)
        const afterStatus = new Map(svc.store.permits.findWhere({ employeeId }).map((permit) => [permit.id, permit.status]))
        // releasedRuns：停职时取「撤前 active permit 的 run，且撤后该 run 已无有效 permit」；
        // 复岗不释放租约（恒空）。租约权威在 exec-hub（终态封存），此处为台账可观测投影。
        const releasedRuns = status === 'suspended'
          ? [...new Set(beforeActive.map((permit) => permit.runId).filter((runId) => runId !== ''))]
              .filter((runId) => !svc.store.permits.findWhere({ runId })
                .some((permit) => permit.status === 'active' && (!permit.expiresAt || permit.expiresAt > now)))
          : []
        results.push({
          employeeId,
          ok: true,
          revokedPermits: beforeActive.filter((permit) => afterStatus.get(permit.id) !== 'active').length,
          releasedRuns,
        })
      } catch (error) {
        results.push({ employeeId, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const succeeded = results.filter((item) => item.ok).length
    const failed = results.length - succeeded
    gate.changeLog(exchange, 'workforce.employee.status-batch', 'employee', employeeIds.slice(0, 5).join(','),
      '', `批量${status === 'suspended' ? '停职' : '复岗'}：${reason}；ids=${employeeIds.join(',')}；succeeded=${succeeded} failed=${failed}`)
    return { results, succeeded, failed }
  })

  gate.guarded('GET', '/api/workforce/admin/employees/:id/audit', 'workforce.admin', (exchange) => {
    const svc = services(ctx)
    const employeeId = exchange.params['id'] ?? ''
    const employee = svc.store.employees.get(employeeId)
    if (!employee) throw new Error(t('数字员工不存在：{id}', { id: employeeId }))
    // 跨组织穿透说明：本端点由 workforce.admin 把守，直接读 store 表按 employeeId/appointmentId
    // 串链（不走 assertReadable 的 org 隔离）——admin 运维面审计报表，权限点即边界。
    const limit = readLimit(exchange.query)
    const now = new Date().toISOString()
    const bindings = svc.store.bindings.findWhere({ employeeId })
    const appointments = svc.store.appointments.findWhere({ employeeId })
      .sort((a, b) => a.version - b.version)
      .map((appointment) => ({
        ...appointment,
        grants: svc.store.grants.findWhere({ appointmentId: appointment.id }),
        manifest: svc.store.manifests.findWhere({ appointmentId: appointment.id })
          .sort((a, b) => b.version - a.version)[0] ?? null,
      }))
    const permits = svc.store.permits.findWhere({ employeeId })
    const allInvocations = svc.store.invocations.findWhere({ employeeId })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const deliverables = svc.store.deliverables.findWhere({ employeeId })
    return {
      employee,
      bindings,
      appointments,
      permits,
      invocations: allInvocations.slice(0, limit),
      deliverables,
      summary: {
        // 有效=active 且未过 expiresAt；过期按 expiresAt<=now 事实计算（库里可能还没有
        // expired 落账行——落账收敛见 MaintenanceService.run）
        permitActive: permits.filter((permit) => permit.status === 'active' && (!permit.expiresAt || permit.expiresAt > now)).length,
        permitExpired: permits.filter((permit) => permit.expiresAt !== '' && permit.expiresAt <= now).length,
        invocationCount: allInvocations.length,
        invocationDenied: allInvocations.filter((item) => item.status === 'denied').length,
        deliverableAccepted: deliverables.filter((item) => item.status === 'accepted').length,
        deliverableRejected: deliverables.filter((item) => item.status === 'rejected').length,
      },
    }
  })

  gate.guarded('GET', '/api/workforce/admin/invocations', 'workforce.admin', (exchange) => {
    const svc = services(ctx)
    // 跨组织调用账本穿透查询（admin 运维面，权限点即边界；工作面 GET /invocations 只按 runId
    // 且过归属校验——本端点是运维对账口，createdAt 倒序）
    const query = exchange.query
    const employeeId = query.get('employeeId') ?? ''
    const runId = query.get('runId') ?? ''
    const status = query.get('status') ?? ''
    let rows = svc.store.invocations.all()
    if (employeeId) rows = rows.filter((row) => row.employeeId === employeeId)
    if (runId) rows = rows.filter((row) => row.runId === runId)
    if (status) rows = rows.filter((row) => row.status === status)
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, readLimit(query))
  })

  gate.guarded('POST', '/api/workforce/admin/maintenance/run', 'workforce.admin', (exchange) => {
    // 定时器跑 + admin 手动跑同一函数（POST /api/exec/tick、POST /api/usage/retention/purge 同款先例）
    const maintenance = (ctx as unknown as { workforceMaintenance?: { run(): MaintenanceRunResult } }).workforceMaintenance
    if (!maintenance || typeof maintenance.run !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('台账维护服务未就绪'), 503)
    }
    const result = maintenance.run()
    gate.changeLog(exchange, 'workforce.maintenance.run', 'maintenance', 'workforce-ledger', '台账巡检', JSON.stringify(result))
    return result
  })
}
