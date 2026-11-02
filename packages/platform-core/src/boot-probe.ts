/**
 * 启动健壮性探针（EXEC-CHECKLIST W2）。
 *
 * 根因：cordis 把服务实现键存于 ctx.root[symbols.isolate][name]（reflect.ts），
 * inject 解析只认同一个 root——注册与消费分属两个 Context 实例时，
 * fiber._checkImpl 读不到实现会静默 delete，fiber 永久 PENDING、零报错。
 * 本模块提供两道防线：双实例断言（装配前 fail-fast）与插件树体检（装配后拒绝带病启动）。
 *
 * 内部 API 已对照 @deepseek-ai/cordis 4.0.4 源码核验：
 *   - ctx.reflect._getImpl(name, strict)：strict 时要求提供方 fiber 处于 ACTIVE（reflect.ts）
 *   - ctx.registry.values() → runtime.fibers（DisposableList，可迭代）→ fiber.state/inject/name
 *   - FiberState 是 const enum，编译期内联、运行时不可导入，状态名按 fiber.ts 枚举序还原
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'

/** globalThis 上的 root 登记键：同一进程只应登记一个 root。 */
const ROOT_KEY = Symbol.for('ybkk.cordis.root')

/** fiber 生命周期状态名（cordis 4.0.4 fiber.ts 的 const enum 枚举序，运行时按数值还原）。 */
const FIBER_STATE: Record<number, string> = {
  0: 'PENDING',
  1: 'LOADING',
  2: 'ACTIVE',
  3: 'FAILED',
  4: 'DISPOSED',
  5: 'UNLOADING',
}

const STATE_ACTIVE = 2
const STATE_FAILED = 3

/** 断言当前进程只存在一个 root Context；发现第二个立即抛错（重复断言同一棵树幂等无副作用）。 */
export function assertSingleRoot(ctx: Context): void {
  const holder = globalThis as Record<symbol, unknown>
  const existing = holder[ROOT_KEY]
  if (existing && existing !== ctx.root) {
    throw new Error(
      '检测到双实例：进程内出现了第二个 root Context，服务注册与 inject 解析将分属两棵'
      + '隔离树，fiber 会静默卡死在 PENDING。修复方式：复用 vendor/cordis 单实例'
      + '（全部模块经同一 specifier 解析到同一份 cordis），或改用独立宿主进程形态，'
      + '禁止在同一进程创建第二个根上下文。',
    )
  }
  holder[ROOT_KEY] ??= ctx.root
}

/** 单个非 ACTIVE fiber 的诊断快照。 */
export interface StuckFiber {
  /** 插件名（fiber.name：就近具名祖先，缺省 'root'）。 */
  plugin: string
  /** 生命周期状态名（按数值还原）。 */
  state: string
  /** 已声明 inject 但当前作用域拿不到 ACTIVE 实现的服务键。 */
  waiting: string[]
  /** true = 拦启动（接线未就绪或真实故障）；false = 良性败者 fiber，仅记录不拦截。 */
  blocking: boolean
}

/** 插件树体检结果。 */
export interface TreeHealth {
  ok: boolean
  /** 必需服务中不可达（当前作用域无 ACTIVE 实现）的名字。 */
  unreachable: string[]
  /** 全部非 ACTIVE 状态的 fiber 快照（含良性败者，诊断视图完整）。 */
  stuck: StuckFiber[]
}

/**
 * FAILED fiber 的良性豁免：本插件声明 provide 的每个服务名都已被其他 ACTIVE fiber
 * 接管时，它是双注册习语的败者 husk，不再拦截启动。
 * 背景：panel-core/flow-core 的「类经 ctx.plugin 注册 + 同步 new」双注册下，同步 new
 * 先登记实现，类 fiber 异步装载时 provide 撞车失败留 FAILED husk（服务由胜者提供，
 * 功能完好；该错误此前被默认 logger 的纯缓冲 exporter 吞掉，从未可见）。
 * 反之，声明的服务无人接管 = 真实故障，必须拦。
 */
function failedButCovered(ctx: Context, fiber: Fiber): boolean {
  const declared = (fiber.runtime?.callback as { provide?: string | string[] } | undefined)?.provide
  const names = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
  if (names.length === 0) return false
  return names.every((name) => {
    const impl = ctx.reflect._getImpl(name, true)
    return !!impl && impl.fiber !== fiber
  })
}

/**
 * 装配完成后体检：必需服务全部可达，且没有任何拦启动的卡死 fiber。
 * 必须在全部 await ctx.plugin 之后调用——此刻所有 fiber 都应已 ACTIVE。
 */
export function probeTree(ctx: Context, required: string[]): TreeHealth {
  const unreachable = required.filter((name) => !ctx.reflect._getImpl(name, true))
  const stuck: StuckFiber[] = []
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.state === STATE_ACTIVE) continue
      const waiting = Object.keys(fiber.inject)
        .filter((name) => !fiber.ctx.reflect._getImpl(name, true))
      stuck.push({
        plugin: fiber.name,
        state: FIBER_STATE[fiber.state] ?? `UNKNOWN(${fiber.state})`,
        waiting,
        blocking: fiber.state === STATE_FAILED ? !failedButCovered(ctx, fiber) : true,
      })
    }
  }
  return { ok: unreachable.length === 0 && !stuck.some((item) => item.blocking), unreachable, stuck }
}

/** 把体检结果格式化为可直接抛出的多行文案。 */
export function formatTreeHealth(h: TreeHealth): string {
  const lines = ['插件树未健康，拒绝启动']
  if (h.unreachable.length > 0) {
    lines.push(`不可达服务（${h.unreachable.length}）：${h.unreachable.join('、')}`)
  }
  for (const item of h.stuck) {
    const waiting = item.waiting.length > 0 ? item.waiting.join('、') : '（无未满足的 inject，查插件自身启动错误）'
    const benign = item.blocking ? '' : '（良性败者：声明服务已由其他 fiber 接管，不拦启动）'
    lines.push(`卡死插件 ${item.plugin} · 状态 ${item.state}${benign} · 等待 inject：${waiting}`)
  }
  return lines.join('\n')
}
