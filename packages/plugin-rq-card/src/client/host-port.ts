/**
 * 浏览器半宿主端口 adapter（EXEC-CHECKLIST W5：dsh 耦合面收窄）。
 *
 * 【单点收敛】dsh-client-runtime 三包（runtime / ui-conversation / locale）的
 * 类型依赖只允许出现在本文件；插件体（index.ts）只依赖 platform-core 声明的
 * HostClientPort 窄端口（type-only import，编译期擦除，不触 build.mjs 的
 * bundle 纯度门禁——platform-core 不进浏览器产物）。
 * dsh 升级 API 漂移时只改本文件 + 重跑契约测试
 * （npm run test:contracts 的 plugin-rq-card 段）。
 * @module @dsh-ops/plugin-rq-card/client/host-port
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only：拉入 ui-conversation 的 SlotMap merge（assistant-actions 条目形态）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only：拉入 locale 插件的 Context merge（ctx.locale 面）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { HostClientPort } from '../../../platform-core/src/host-bridge.ts'

/** index.ts / 插件体经此取用（dsh 类型不直接进插件体）。 */
export type { ClientContext, SessionId }

/** ctx.slots 的结构化最小视图（运行期形状差异在本文件内收窄，不出端口）。 */
interface SlotsView {
  specDynamic?: (name: string) => unknown
  inject: (slot: string, factory: () => unknown) => unknown
  register: (spec: unknown, component: unknown) => () => void
}

/** ctx.locale 的结构化最小视图。 */
interface LocaleView {
  register: (namespace: string, dictionaries: unknown) => unknown
}

/**
 * adapter：把 dsh 客户端根 context 收窄为 HostClientPort。
 *   - slots.specDynamic 按存在性收窄 + 安全探测（缺席/抛错/非对象一律折叠为
 *     undefined，调用方按「槽不可用」降级——spike §5 既有语义前移到端口边界，
 *     旧版宿主不提供该 API 也无需升级即可运行）；
 *   - 其余能力面（inject/register/locale.register/effect）直通转发。
 */
export function createClientHostPort(ctx: ClientContext): HostClientPort {
  const slots = ctx.slots as SlotsView
  const locale = ctx.locale as LocaleView
  const root = ctx as unknown as { effect: (action: () => void, name?: string) => unknown }
  const port: HostClientPort = {
    slots: {
      inject: (slot, factory) => slots.inject(slot, factory),
      register: (spec, component) => slots.register(spec, component),
    },
    locale: {
      register: (namespace, dictionaries) => locale.register(namespace, dictionaries),
    },
    effect: (action, name) => root.effect(action, name),
  }
  if (typeof slots.specDynamic === 'function') {
    const specDynamic = slots.specDynamic.bind(ctx.slots)
    port.slots.specDynamic = (name: string) => {
      try {
        const spec = specDynamic(name)
        return typeof spec === 'object' && spec !== null ? (spec as { kind?: string }) : undefined
      } catch {
        return undefined
      }
    }
  }
  return port
}
