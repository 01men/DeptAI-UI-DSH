/**
 * MCP 资源适配器（§4.2/D.3：数字员工访问业务系统的受控工具出口）。
 *
 * probeGrant：结构化探测 mcpRegistry.authorize(caller, serviceId, toolName)（真实签名）
 * 对 grant 的每个 action 逐一探测——真实生效以网关权限组为准，不做 UI 勾选假设；
 * 权限组引用经 permGroups 结构化探测回填，拿不到则 ref='probe:authorize-only'。
 * invoke：调 mcpRegistry.invoke 走网关原有授权链（两层授权取交集，§9.5），并经第 5 形参
 * workRef 把工作引用（permit/run）透传给网关工作闸门与调用记录（D1 修复：组4 additive
 * 已落地；网关仍不回传调用 ID/usage 事件 ID——gatewayRef 诚实降级记录，不伪造证据）。
 */
import { sha256Hex } from '../../../platform-core/src/ids.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type {
  AdapterInvokeInput,
  AdapterInvokeResult,
  AdapterProbeResult,
  ResourceAdapter,
} from '../contract.ts'
import type { IdentityResolution, ResourceGrantSpec } from '../contract.ts'
import type { WorkExecutionContext, WorkRefIndex } from '../../../platform-core/src/workforce-port.ts'

/** mcpRegistry 结构化探测面（真实签名见 plugin-mcp/src/index.ts McpService）。 */
interface McpRegistryProbe {
  authorize?: (caller: { type: 'user' | 'agent' | 'app'; id: string; name: string }, serviceId: string, toolName: string) =>
    { ok: true; readOnly: boolean } | { ok: false; reason: string }
  invoke?: (caller: { type: 'user' | 'agent' | 'app'; id: string; name: string }, serviceId: string, toolName: string, args?: Record<string, unknown>, workRef?: WorkRefIndex) =>
    Promise<{ ok: boolean; status: 'ok' | 'error' | 'denied' | 'rate_limited' | 'breaker_open'; latencyMs: number; version: string; result?: unknown; error?: string }>
  permGroups?: () => { all(): Array<{ id: string; policies: Record<string, unknown>; subjects: Array<{ type: string; id: string }> }> }
}

export function createMcpAdapter(ctx: {
  mcpRegistry?: McpRegistryProbe
}): ResourceAdapter {
  const registry = (): McpRegistryProbe => ctx.mcpRegistry ?? {}

  /** 员工机器主体 → 网关 InvokeCaller（绑定 Agent 反查，不接受参数传入身份）。 */
  const gatewayCaller = (resolution: IdentityResolution): { type: 'agent'; id: string; name: string } => ({
    type: 'agent',
    id: resolution.binding.agentId || resolution.employee.primaryAgentId || resolution.employee.id,
    name: resolution.employee.displayName || resolution.employee.name,
  })

  return {
    kind: 'mcp',

    async probeGrant(spec: ResourceGrantSpec, resolution: IdentityResolution): Promise<AdapterProbeResult> {
      const hub = registry()
      if (typeof hub.authorize !== 'function') {
        return { ok: false, message: t('mcpRegistry 未提供 authorize 探测能力，无法核验 MCP 授权') }
      }
      const caller = gatewayCaller(resolution)
      for (const action of spec.actions) {
        const verdict = hub.authorize(caller, spec.registryId, action)
        if (!verdict.ok) {
          return { ok: false, message: t('MCP 授权探针未通过（{handle}）：{reason}', { handle: `${spec.registryId}.${action}`, reason: verdict.reason }) }
        }
      }
      // 权限组证据：结构化探测 permGroups；拿不到则诚实记录 authorize-only
      try {
        if (typeof hub.permGroups === 'function') {
          const agentId = caller.id
          const groupIds = hub.permGroups().all()
            .filter((group) => group.policies[spec.registryId]
              && group.subjects.some((subject) => subject.type === 'agent' && subject.id === agentId))
            .map((group) => group.id)
          if (groupIds.length > 0) return { ok: true, ref: `permgroup:${groupIds.join(',')}` }
        }
      } catch {
        // 权限组查询缺席 → 降级记录
      }
      return { ok: true, ref: 'probe:authorize-only' }
    },

    async invoke(input: AdapterInvokeInput): Promise<AdapterInvokeResult> {
      const hub = registry()
      if (typeof hub.invoke !== 'function') {
        return { ok: false, message: t('mcpRegistry 未提供 invoke 能力'), gatewayRef: { outcome: 'denied' } }
      }
      const work: WorkExecutionContext = input.work
      const caller = {
        type: 'agent' as const,
        id: work.agentId || work.principalId,
        name: t('数字员工:{id}', { id: work.employeeId }),
      }
      // 工作引用索引（§10.4 / D1 修复）：网关工作闸门按 permitId 核验工作级授权（V28），
      // 并把 permit/run/employee 关联进网关调用记录与 usage（D11）。仅作索引透传，
      // 授权事实（permit/租约/清单/参数范围）一律由网关侧服务端回查。stepKey 不在
      // WorkExecutionContext（账本层唯一约束承载步骤幂等），故不透传。
      const workRef: WorkRefIndex = {
        permitId: work.permitId,
        ...(work.runId ? { runId: work.runId } : {}),
        ...(work.issueId ? { issueId: work.issueId } : {}),
        ...(work.traceId ? { traceId: work.traceId } : {}),
      }
      const result = await hub.invoke(caller, input.tool.registryId, input.tool.action, input.args, workRef)
      if (result.ok) {
        // 网关暂未回传调用 ID/usage 事件 ID（组4 additive 前诚实缺省，不伪造）
        return {
          ok: true,
          value: result.result,
          gatewayRef: {
            note: 'mcp 网关暂未回传调用ID',
            status: result.status,
            version: result.version,
            latencyMs: result.latencyMs,
            workRef: `${work.runId}/${input.invocationId}`,
            argsHash: sha256Hex(JSON.stringify(input.args)).slice(0, 16),
          },
        }
      }
      return {
        ok: false,
        message: result.error ?? t('MCP 网关拒绝或调用失败'),
        // denied/breaker_open＝资源级拒绝（停止，不换入口重试）；error＝执行失败
        gatewayRef: {
          status: result.status,
          version: result.version,
          ...(result.status === 'denied' || result.status === 'breaker_open' ? { outcome: 'denied' } : {}),
        },
        ...(result.status === 'rate_limited' ? { rateLimited: true } : {}),
      }
    },
  }
}
