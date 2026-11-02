/**
 * 模型资源适配器（§4.1/D14：模型提供推理能力，不承担岗位身份）。
 *
 * 密级纪律（D14）：统一业务密级 ≠ ModelGateway 的旧协议枚举——
 *   1. topsecret 前置拒绝（assertAgentAllowedDataClass，绝不映射为可用渠道）；
 *   2. mapWorkDataClassToChannel 显式映射（confidential 映射缺失→拒绝，不静默回落 internal）；
 *   3. 传给网关的 dataClass 用映射值，越级由网关分级路由锁死（双层防线）。
 * subject 使用服务端确认的技术 Agent 归因（agent:<agentId>），预算按同一主体归口。
 */
import { assertAgentAllowedDataClass, mapWorkDataClassToChannel } from '../domain.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type {
  AdapterInvokeInput,
  AdapterInvokeResult,
  AdapterProbeResult,
  ResourceAdapter,
} from '../contract.ts'
import type { IdentityResolution, ResourceGrantSpec } from '../contract.ts'
import type { WorkDataClass } from '../../../platform-core/src/workforce-port.ts'

/** modelGateway 结构化探测面（真实签名见 plugin-modelgw/src/index.ts ModelGatewayService）。 */
interface ModelGatewayProbe {
  models?: () => { all(): Array<{ slug: string; status: string }> }
  channelGroups?: () => { all(): Array<{ slug: string; enabled: boolean }> }
  invoke?: (input: {
    model: string
    messages: Array<{ role: string; content: string }>
    orgId: string
    subject: string
    maxTokens?: number
    temperature?: number
    dataClass?: 'public' | 'internal' | 'secret'
  }) => Promise<{
    ok: true
    content: string
    model: string
    inputTokens: number
    outputTokens: number
    costCents: number
    /** 组4 additive 预留：usage.record 返回的事件 ID（当前网关未返回，探测缺省）。 */
    usageEventId?: string
  }>
}

export function createModelAdapter(ctx: {
  modelGateway?: ModelGatewayProbe
}): ResourceAdapter {
  const gateway = (): ModelGatewayProbe => ctx.modelGateway ?? {}

  return {
    kind: 'model',

    /** 目录探针：registryId 须在模型目录（或渠道组）中真实登记，不接受纯期望值。 */
    async probeGrant(spec: ResourceGrantSpec, _resolution: IdentityResolution): Promise<AdapterProbeResult> {
      const hub = gateway()
      if (typeof hub.models !== 'function') {
        return { ok: false, message: t('modelGateway 未提供模型目录查询能力') }
      }
      const inCatalog = hub.models().all().some((model) => model.slug === spec.registryId)
      if (inCatalog) return { ok: true, ref: 'model-catalog' }
      try {
        if (typeof hub.channelGroups === 'function'
          && hub.channelGroups().all().some((group) => group.slug === spec.registryId)) {
          return { ok: true, ref: 'model-channel-group' }
        }
      } catch {
        // 渠道组查询缺席 → 按目录判定
      }
      return { ok: false, message: t('模型 {modelId} 不在模型网关目录中（渠道组亦未登记）', { modelId: spec.registryId }) }
    },

    async invoke(input: AdapterInvokeInput): Promise<AdapterInvokeResult> {
      const hub = gateway()
      if (typeof hub.invoke !== 'function') {
        return { ok: false, message: t('modelGateway 未提供 invoke 能力'), gatewayRef: { outcome: 'denied' } }
      }
      const work = input.work
      // 密级前置防线（D14）：topsecret 禁止 Agent 直接处理——映射之前先拒绝
      try {
        assertAgentAllowedDataClass(work.dataClass as WorkDataClass)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error), gatewayRef: { outcome: 'denied' } }
      }
      // 显式映射旧协议密级；映射缺失（confidential 等无对应渠道级）→ 拒绝，不静默回落
      const channel = mapWorkDataClassToChannel(work.dataClass as WorkDataClass)
      if (!channel) {
        return { ok: false, message: t('密级映射缺失，拒绝调用'), gatewayRef: { outcome: 'denied', dataClass: work.dataClass } }
      }
      const messages = input.args['messages']
      if (!Array.isArray(messages) || messages.length === 0) {
        return { ok: false, message: t('模型调用参数缺少 messages 数组'), gatewayRef: { outcome: 'denied' } }
      }
      const maxTokens = typeof input.tool.constraints?.['maxTokens'] === 'number'
        ? input.tool.constraints['maxTokens'] as number
        : undefined
      try {
        const result = await hub.invoke({
          model: input.tool.registryId,
          messages: messages as Array<{ role: string; content: string }>,
          orgId: work.workOrgId,
          // 技术归因：服务端确认的 Agent 主体（预算/报表按同一主体归口，不随 subject 字符串漂移）
          subject: `agent:${work.agentId}`,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          dataClass: channel,
        })
        return {
          ok: true,
          value: {
            content: result.content,
            model: result.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costCents: result.costCents,
          },
          content: result.content,
          gatewayRef: {
            model: result.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            dataClass: channel,
            workRef: `${work.runId}/${input.invocationId}`,
          },
          // 组4 additive：网关回传 usage 事件 ID 时收集，否则诚实缺省
          ...(typeof result.usageEventId === 'string' && result.usageEventId
            ? { usageEventIds: [result.usageEventId] }
            : {}),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 预算熔断/分级越界＝策略拒绝（停止）；上游网络/HTTP 错误＝执行失败
        const policyDenied = /预算熔断|分级越界|数据分级越界|已下线|不存在/.test(message)
        return {
          ok: false,
          message,
          gatewayRef: { ...(policyDenied ? { outcome: 'denied' } : {}), dataClass: channel },
        }
      }
    },
  }
}
