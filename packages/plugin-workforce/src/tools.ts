/**
 * 运行时薄工具（workforce_claim / workforce_invoke / workforce_renew / workforce_submit）。
 *
 * 纪律（§10.3/D02）：身份一律取 exec.principal（入口从令牌解析后注入），禁止从 args
 * 读取身份；principal 缺失 fail-closed 返回中文错误。工具只是业务服务的薄封装，
 * REST / MCP / 宿主三端转同一服务，不复制实现（§13.1）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/tools-lite.ts'
import type { WorkCallerRef } from '../../platform-core/src/workforce-port.ts'
import type { ToolPrincipal, ToolRunContext } from '../../platform-core/src/tools-lite.ts'
import { WorkforceError } from './contract.ts'
import { t } from '../../platform-i18n/src/index.ts'
import type {
  ClaimOutcome,
  InvocationOutcome,
} from './contract.ts'

/** exec.principal → 可信 caller（缺 refType/refId 时照实缺省——组1 resolver 只认 refType='agent'）。 */
function callerRefOf(principal: ToolPrincipal | undefined): WorkCallerRef {
  if (!principal || !principal.principalId) {
    throw new WorkforceError('PRINCIPAL_BINDING_MISMATCH', t('缺少调用主体身份（fail-closed）：工具不允许从参数读取身份'))
  }
  return {
    kind: principal.kind,
    principalId: principal.principalId,
    ...(principal.userId ? { userId: principal.userId } : {}),
    ...(principal.refType !== undefined ? { refType: principal.refType } : {}),
    ...(principal.refId !== undefined ? { refId: principal.refId } : {}),
    ...(principal.name ? { name: principal.name } : {}),
  }
}

/** 服务拒绝 → 结构化失败负载（code 英文枚举 + message 中文，§13.3）。 */
function failureOf(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof WorkforceError) {
    return { ok: false, code: error.code, message: error.message }
  }
  return { ok: false, code: 'POLICY_INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) }
}

function structuredServices(ctx: Context): {
  admission: { claimWork: import('./contract.ts').WorkforceAdmission['claimWork']; renewWorkLease: import('./contract.ts').WorkforceAdmission['renewWorkLease'] }
  invocations: { invoke: import('./contract.ts').WorkforceInvocations['invoke'] }
  delivery: { submit: import('./contract.ts').WorkforceDelivery['submit'] }
} {
  const source = ctx as unknown as {
    workforceAdmission?: import('./contract.ts').WorkforceAdmission
    workforceInvocations?: import('./contract.ts').WorkforceInvocations
    workforceDelivery?: import('./contract.ts').WorkforceDelivery
  }
  if (!source.workforceAdmission || !source.workforceInvocations || !source.workforceDelivery) {
    throw new WorkforceError('WORKFORCE_NOT_READY', t('数字员工服务未就绪'), 503)
  }
  return {
    admission: source.workforceAdmission,
    invocations: source.workforceInvocations,
    delivery: source.workforceDelivery,
  }
}

export function registerWorkforceTools(ctx: Context): void {
  const tools = (ctx as unknown as {
    tools?: { register(definition: ReturnType<typeof defineTool>): unknown }
  }).tools
  if (!tools || typeof tools.register !== 'function') {
    throw new Error(t('tools 运行时未就绪，workforce 工具无法注册'))
  }

  tools.register(defineTool({
    name: 'workforce_claim',
    plugin: 'workforce',
    permission: 'workforce.invoke',
    description: '数字员工认领任务：幂等确认已分配租约并取得工作授权（permit）与能力清单。返回 runId/permitId/可用工具句柄；重复认领同任务返回既有授权（idempotent）。',
    parameters: {
      issueId: { type: 'string', required: true, description: '任务 ID（执行中枢 issue）' },
      agentKey: { type: 'string', description: '运行时别名（可选，兼容 exec_claim；主体归属仍以令牌反查为准）' },
      ttlMinutes: { type: 'number', description: 'permit/租约有效期（分钟，可选）' },
    },
    output: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        runId: { type: 'string' },
        permitId: { type: 'string' },
        leaseVersion: { type: 'number' },
        tools: { type: 'array', items: { type: 'string' } },
        idempotent: { type: 'boolean' },
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['ok'],
    },
    async execute(args, exec: ToolRunContext) {
      let caller: WorkCallerRef
      try {
        caller = callerRefOf(exec.principal)
      } catch (error) {
        return failureOf(error)
      }
      try {
        const outcome: ClaimOutcome = await structuredServices(ctx).admission.claimWork(caller, {
          issueId: String(args.issueId ?? ''),
          ...(typeof args.agentKey === 'string' && args.agentKey ? { agentKey: args.agentKey } : {}),
          ...(typeof args.ttlMinutes === 'number' && args.ttlMinutes > 0 ? { ttlMs: Math.round(args.ttlMinutes * 60_000) } : {}),
        })
        if (!outcome.ok) {
          return { ok: false, code: outcome.code, message: outcome.message, ...(outcome.holder ? { holder: outcome.holder } : {}) }
        }
        return {
          ok: true,
          runId: outcome.runId,
          permitId: outcome.permit.id,
          leaseVersion: outcome.lease.leaseVersion,
          tools: outcome.tools.map((tool) => tool.handle),
          idempotent: outcome.idempotent,
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }))

  tools.register(defineTool({
    name: 'workforce_invoke',
    plugin: 'workforce',
    permission: 'workforce.invoke',
    description: '数字员工受控资源调用：permit + 工具句柄 + 业务步骤键（stepKey）+ 参数。返回领域状态（completed/denied/approval_required/rate_limited/failed/outcome_unknown）——denied 停止该动作不换入口重试；outcome_unknown 先核验禁止自动重写。',
    parameters: {
      permitId: { type: 'string', required: true, description: '工作授权 permit（workforce_claim 返回）' },
      toolHandle: { type: 'string', required: true, description: '工具句柄（能力清单下发，形如 registry.action）' },
      stepKey: { type: 'string', required: true, description: '业务步骤键（同步骤同参数幂等；不同参数冲突拒绝）' },
      arguments: { type: 'object', description: '调用参数（须在句柄参数 schema 与业务范围约束内）' },
      traceId: { type: 'string', description: '工作 trace 引用（可选索引）' },
    },
    output: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['completed', 'denied', 'approval_required', 'rate_limited', 'failed', 'outcome_unknown', 'cancelled'] },
        invocationId: { type: 'string' },
        value: {},
        content: { type: 'string' },
        gatewayRef: { type: 'object' },
        code: { type: 'string' },
        message: { type: 'string' },
        approvalRef: { type: 'string' },
      },
      required: ['status', 'invocationId'],
    },
    async execute(args, exec: ToolRunContext) {
      let caller: WorkCallerRef
      try {
        caller = callerRefOf(exec.principal)
      } catch (error) {
        return failureOf(error)
      }
      try {
        const outcome: InvocationOutcome = await structuredServices(ctx).invocations.invoke(caller, {
          permitId: String(args.permitId ?? ''),
          toolHandle: String(args.toolHandle ?? ''),
          stepKey: String(args.stepKey ?? ''),
          arguments: args.arguments,
          ...(typeof args.traceId === 'string' && args.traceId ? { traceId: args.traceId } : {}),
        })
        // 按领域状态透传（中文 message），不以 HTTP/工具成功冒充业务成功
        return outcome
      } catch (error) {
        return failureOf(error)
      }
    },
  }))

  tools.register(defineTool({
    name: 'workforce_renew',
    plugin: 'workforce',
    permission: 'workforce.invoke',
    description: '数字员工续租/进度心跳：同主体、同 run、未撤销且未过期才能续。长时间执行请在租约到期前调用。',
    parameters: {
      permitId: { type: 'string', required: true, description: '工作授权 permit' },
      ttlMinutes: { type: 'number', description: '续租时长（分钟，可选）' },
    },
    output: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        lease: { type: 'object', additionalProperties: true },
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['ok'],
    },
    async execute(args, exec: ToolRunContext) {
      let caller: WorkCallerRef
      try {
        caller = callerRefOf(exec.principal)
      } catch (error) {
        return failureOf(error)
      }
      try {
        const result = await structuredServices(ctx).admission.renewWorkLease(
          caller,
          String(args.permitId ?? ''),
          typeof args.ttlMinutes === 'number' && args.ttlMinutes > 0 ? Math.round(args.ttlMinutes * 60_000) : undefined,
        )
        if (!result.ok) return { ok: false, code: result.code, message: result.message }
        return { ok: true, lease: result.lease }
      } catch (error) {
        return failureOf(error)
      }
    },
  }))

  tools.register(defineTool({
    name: 'workforce_submit',
    plugin: 'workforce',
    permission: 'workforce.invoke',
    description: '数字员工提交结构化交付：校验 run 归属与 artifact 证据归属，任务转待审 review，等待真人验收（模型输出「成功」不等于业务验收通过）。',
    parameters: {
      permitId: { type: 'string', required: true, description: '工作授权 permit' },
      summary: { type: 'string', required: true, description: '交付摘要' },
      artifactIds: { type: 'array', items: { type: 'string' }, required: true, description: '交付证据 artifact ID 列表（须属本 run）' },
    },
    output: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        deliverableId: { type: 'string' },
        version: { type: 'number' },
        status: { type: 'string' },
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['ok'],
    },
    async execute(args, exec: ToolRunContext) {
      let caller: WorkCallerRef
      try {
        caller = callerRefOf(exec.principal)
      } catch (error) {
        return failureOf(error)
      }
      try {
        const record = await structuredServices(ctx).delivery.submit(caller, {
          permitId: String(args.permitId ?? ''),
          summary: String(args.summary ?? ''),
          artifactIds: Array.isArray(args.artifactIds) ? args.artifactIds.filter((item): item is string => typeof item === 'string') : [],
        })
        return { ok: true, deliverableId: record.id, version: record.version, status: record.status }
      } catch (error) {
        return failureOf(error)
      }
    },
  }))
}
