/**
 * AI 应用资源适配器（§4.6：有统一登录，不代表有机器可调用 API）。
 *
 * 仅登记 entryUrl 的应用不能被当作函数调用；具备机器 API 的应用应经
 * MCP／Connector／专用适配器显式接入。一期诚实未支持——probeGrant/invoke
 * 一律返回 ok:false，不以空实现冒充成功，也不让运行时提交任意 URL
 * 由平台携带内部凭证代为请求。
 */
import type {
  AdapterInvokeInput,
  AdapterInvokeResult,
  AdapterProbeResult,
  ResourceAdapter,
} from '../contract.ts'
import type { IdentityResolution, ResourceGrantSpec } from '../contract.ts'
import { t } from '../../../platform-i18n/src/index.ts'

const UNSUPPORTED = 'AI 应用机器 API 适配一期未开放（具备机器 API 的应用请经 MCP/Connector 显式接入）'

export function createAppAdapter(_ctx: unknown): ResourceAdapter {
  return {
    kind: 'app',

    async probeGrant(_spec: ResourceGrantSpec, _resolution: IdentityResolution): Promise<AdapterProbeResult> {
      return { ok: false, message: t(UNSUPPORTED) }
    },

    async invoke(_input: AdapterInvokeInput): Promise<AdapterInvokeResult> {
      return { ok: false, message: t(UNSUPPORTED), gatewayRef: { outcome: 'denied' } }
    },
  }
}
