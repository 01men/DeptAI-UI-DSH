/**
 * Connector 资源适配器（§4.3/D.3：外部 SaaS／企业连接器的独立出口）。
 *
 * invoke：结构化探测 connectorHub.invokeAction 真实签名并复用其完整六步链
 * （主体授权→ODD→审批→限流→快照校验→数据面），工作级准入已在 invocation 层完成。
 * 稳定幂等键：`wf:<runId>:<handle>:<argsHash>` sha256 截断——当前网关签名
 * 未暴露外部幂等键入参（executeWithRecovery 内部随机生成），先记入 gatewayRef
 * 作对账证据，待组4 additive 后透传（诚实降级，不伪造已生效）。
 */
import { sha256Hex } from '../../../platform-core/src/ids.ts'
import { canonicalJson } from '../domain.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type {
  AdapterInvokeInput,
  AdapterInvokeResult,
  AdapterProbeResult,
  ResourceAdapter,
} from '../contract.ts'
import type { IdentityResolution, ResourceGrantSpec } from '../contract.ts'
import type { WorkExecutionContext } from '../../../platform-core/src/workforce-port.ts'

/** connectorHub 结构化探测面（真实签名见 plugin-connector/src/index.ts ConnectorHubService）。 */
interface ConnectorHubProbe {
  invokeAction?: (caller: { type: 'user' | 'agent' | 'app'; id: string; name: string; actChain?: Array<{ name: string; type: string }> }, params: {
    actionId: string
    input?: Record<string, unknown>
    alias?: string
    dryRun?: boolean
  }) => Promise<
    | { ok: true; status: 'ok'; runId: string; latencyMs: number; data: unknown; meta: Record<string, unknown>; metered: boolean }
    | { ok: true; status: 'dry_run'; preview: Record<string, unknown> }
    | { ok: false; status: 'denied' | 'rate_limited' | 'quota_exceeded' | 'error'; error: string; latencyMs: number; code?: string }
    | { ok: false; status: 'approval_required'; approvalId: string; actionId: string; message: string }
  >
}

/** 稳定业务幂等键（§4.3/§11.5-3：跨请求复用同一业务步骤的同一写入）。 */
export function workforceIdempotencyKey(work: WorkExecutionContext, toolHandle: string, args: Record<string, unknown>): string {
  return sha256Hex(`wf:${work.runId}:${toolHandle}:${canonicalJson(args)}`).slice(0, 32)
}

export function createConnectorAdapter(ctx: {
  connectorHub?: ConnectorHubProbe
}): ResourceAdapter {
  const hub = (): ConnectorHubProbe => ctx.connectorHub ?? {}

  return {
    kind: 'connector',

    // 授权探针：connector 的真实授权在 invokeAction 六步链内逐步核验（快照/ODD/审批），
    // 平台侧提供 register-型管理面的动作目录核验——这里只核验注册表存在性（不预演网络）。
    async probeGrant(spec: ResourceGrantSpec, _resolution: IdentityResolution): Promise<AdapterProbeResult> {
      if (typeof hub().invokeAction !== 'function') {
        return { ok: false, message: t('connectorHub 未提供 invokeAction 能力，无法核验连接器授权') }
      }
      return { ok: true, ref: `connector:actions:${spec.actions.join('|')}` }
    },

    async invoke(input: AdapterInvokeInput): Promise<AdapterInvokeResult> {
      const probe = hub()
      if (typeof probe.invokeAction !== 'function') {
        return { ok: false, message: t('connectorHub 未提供 invokeAction 能力'), gatewayRef: { outcome: 'denied' } }
      }
      const work: WorkExecutionContext = input.work
      const caller = {
        type: 'agent' as const,
        id: work.agentId || work.principalId,
        name: t('数字员工:{id}', { id: work.employeeId }),
      }
      const alias = typeof input.tool.constraints?.['alias'] === 'string' ? input.tool.constraints['alias'] as string : undefined
      const idempotencyKey = workforceIdempotencyKey(work, input.tool.handle, input.args)
      try {
        const result = await probe.invokeAction(caller, {
          actionId: input.tool.action,
          input: input.args,
          ...(alias ? { alias } : {}),
        })
        if (result.ok) {
          if (result.status === 'dry_run') {
            return { ok: true, value: result.preview, gatewayRef: { dryRun: true, idempotencyKey } }
          }
          // 数据面 executionId 进 gatewayRef（D.3 最小证据）
          return {
            ok: true,
            value: result.data,
            gatewayRef: {
              executionId: result.runId,
              latencyMs: result.latencyMs,
              metered: result.metered,
              idempotencyKey,
              workRef: `${work.runId}/${input.invocationId}`,
            },
          }
        }
        if (result.status === 'approval_required') {
          return {
            ok: false,
            message: result.message,
            approvalRef: result.approvalId,
            gatewayRef: { outcome: 'approval_required', actionId: result.actionId, idempotencyKey },
          }
        }
        if (result.status === 'rate_limited') {
          return { ok: false, message: result.error, rateLimited: true, gatewayRef: { idempotencyKey } }
        }
        return {
          ok: false,
          message: result.error,
          gatewayRef: {
            status: result.status,
            idempotencyKey,
            ...(result.status === 'denied' ? { outcome: 'denied' } : {}),
            ...(result.code ? { code: result.code } : {}),
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 写动作超时/网络不确定 → 结果未知（§11.5-4：先核验，禁止自动重写）
        const uncertain = input.tool.risk !== 'read' && /超时|timeout|abort|ECONNRESET|ETIMEDOUT/i.test(message)
        return {
          ok: false,
          message,
          ...(uncertain ? { outcomeUnknown: true } : {}),
          gatewayRef: { idempotencyKey, ...(uncertain ? { outcome: 'unknown' } : {}) },
        }
      }
    },
  }
}
