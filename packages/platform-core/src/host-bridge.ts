/**
 * 宿主桥窄端口（EXEC-CHECKLIST W5：dsh 耦合面收窄，P2）。
 *
 * 【设计意图】本仓库真正触达 dsh 宿主 API 的只有两处：plugin-dsh-bridge
 * （服务端 ctx.webServer：挂载半 + 身份半）与 plugin-rq-card 浏览器半
 * （ctx.slots / ctx.locale：slot 注册 + 词典）。收窄方式与 workforce-port.ts
 * 同型：端口接口只声明两个插件实际消费的最小能力面，dsh 特有类型一律不进
 * 端口签名（结构化最小接口，运行期形状差异由各侧 adapter 收窄）。
 * 这样 dsh 升级带来的 API 漂移只需：改各侧 adapter + 重跑契约测试
 * （npm run test:contracts），业务代码与端口签名不动。
 *
 * 【能力面分级·dsh-bridge 侧】（源自 src/index.ts 全部调用点盘点：5 处
 * register + 1 处可选 tapIndex）
 *   必须：register(route)——exact/prefix 路由注册，handler 持有原生 req/res；
 *         缺失 = 宿主不是 web 形态，dsh-bridge apply 直接抛错（既有行为）。
 *   可选：tapIndex(transform)——dsh web UI HTML 改写（免登脚本注入）；
 *         缺席（旧版宿主、selftest 伪造 webServer 不带此能力）= 降级仅
 *         /auth/entry?entry_ticket= query 通道，记 warn 不抛错（既有行为）。
 *         adapter 按存在性收窄：宿主不因端口要求而被迫提供任何可选能力。
 *
 * 【能力面分级·rq-card client 侧】
 *   必须：slots.inject / slots.register / locale.register / effect——
 *         客户端插件 inject 声明 ['slots','locale']，宿主必然提供。
 *   可选：slots.specDynamic——槽存在性/形态探测；缺席或运行期抛错一律折叠为
 *         undefined，调用方按「槽不可用」降级（spike §5 既有语义前移到端口边界）。
 *
 * 【为什么客户端端口类型也放在这里、adapter 却留在客户端】浏览器半 bundle 有
 * 纯度门禁（plugin-rq-card/build.mjs 的 purityGate）：platform-core 不可进
 * 浏览器 bundle——因此客户端只 type-only import 本文件（编译期擦除，零体积
 * 影响），包装实现（adapter）收敛在
 * packages/plugin-rq-card/src/client/host-port.ts 单点。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

// ---------------------------------------------------------------------------
// 服务端面：dsh webServer 窄端口（plugin-dsh-bridge 消费）
// ---------------------------------------------------------------------------

/** 路由注册结构面（对齐 dsh webserver 契约 WebRoute：kind/path/handler）。 */
export interface HostWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void
}

/** dsh webServer 的最小结构面（不 import dsh 包，仅消费 register/tapIndex 契约）。 */
export interface HostWebServerLike {
  register(route: HostWebRoute): unknown
  tapIndex?: (transform: (html: string) => string) => unknown
}

/** 宿主 web 窄端口：dsh-bridge 业务代码只依赖本接口，不感知具体宿主实现。 */
export interface HostWebPort {
  /** 注册路由（必须能力；adapter 保证转发调用与返回值）。 */
  register(route: HostWebRoute): unknown
  /** dsh web UI HTML 改写（可选能力：宿主未提供时整个属性缺席）。 */
  tapIndex?(transform: (html: string) => string): unknown
}

/** adapter：把宿主 webServer 结构收窄为 HostWebPort（可选能力按存在性收窄）。 */
export function createHostWebPort(webServer: HostWebServerLike): HostWebPort {
  const port: HostWebPort = {
    register: (route) => webServer.register(route),
  }
  if (typeof webServer.tapIndex === 'function') {
    const tapIndex = webServer.tapIndex.bind(webServer)
    port.tapIndex = (transform) => tapIndex(transform)
  }
  return port
}

// ---------------------------------------------------------------------------
// 客户端面：浏览器半窄端口（plugin-rq-card 消费；本文件只声明契约，
// adapter 实现见 packages/plugin-rq-card/src/client/host-port.ts）
// ---------------------------------------------------------------------------

/** slot 条目登记的最小结构面（字段取自 rq-card 全部 register 调用点）。 */
export interface HostClientSlotSpec {
  name: string
  id: string
  /** keyed 槽专属：键位名（rq-card 逐工具登记 tool.call.toolview）。 */
  key?: string
  /** list 槽专属：排序（rq-feedback=20，排 dsh 自带 feedback=10 之后）。 */
  order?: number
  /** 词典座位名（条目 props.t 由该座位的词典驱动）。 */
  locale?: string
  /** 惰性注入回调：条目实际渲染时才调用，产出注入面对象。 */
  inject?: (arg: unknown) => unknown
}

export interface HostClientSlotsPort {
  /**
   * 槽探测（可选能力）：返回 { kind }（'keyed' | 'list'…）。
   * 宿主未提供、运行期抛错、返回非对象——一律 undefined（降级信号）。
   */
  specDynamic?(name: string): { kind?: string } | undefined
  /** 惰性注入：目标槽未声明时工厂永不执行（上游改槽名 = 卡片静默消失，不崩宿主）。 */
  inject(slot: string, factory: () => unknown): unknown
  /** 登记 slot 条目；返回注销函数。 */
  register(spec: HostClientSlotSpec, component: unknown): () => void
}

export interface HostClientLocalePort {
  /** 登记词典命名空间（rq-card 用 'rq-card' 座位 + zh/en/ja 三语）。 */
  register(namespace: string, dictionaries: unknown): unknown
}

/** 浏览器半宿主端口：rq-card 插件体的唯一宿主依赖面。 */
export interface HostClientPort {
  slots: HostClientSlotsPort
  locale: HostClientLocalePort
  /** 根 context 副作用登记（词典等随宿主 context 生命周期释放）。 */
  effect(action: () => void, name: string): unknown
}

// ---------------------------------------------------------------------------
// 登记器
// ---------------------------------------------------------------------------

/**
 * 宿主桥登记器（platform-core 持有；接线方式对齐 WorkforcePolicyRegistry）。
 * plugin-dsh-bridge 装配时把包装后的端口登记进来，其余服务/测试经 port() 取用。
 * 独立宿主（无 dsh webServer）端口保持空缺 = null，消费方自行降级。
 *
 * W5 边界注：platform-core 的 apply 不装配本登记器（保持既有装配面零变化），
 * 由 plugin-dsh-bridge 侧「探测或直挂」自举（对齐其 IdentityBindingService 的
 * 自提供规避法）——真实 cordis 树上挂在 ctx.hostBridge，轻量 ctx（selftest
 * 服务视图）登记静默跳过，端口本地直用，对外行为不变。
 */
export class HostBridgeRegistry extends Service {
  static readonly provide = 'hostBridge'

  private web: HostWebPort | null = null

  constructor(ctx: Context) {
    super(ctx, 'hostBridge')
  }

  registerWebPort(port: HostWebPort): void {
    this.web = port
    try {
      this.ctx.platformBus?.emit('hostBridge.port.ready', { at: new Date().toISOString() })
    } catch {
      // platformBus 未注入当前 fiber 时跳过通知（cordis 严格服务访问）
    }
  }

  /** 未登记返回 null：消费方据此降级（对齐 workforce port() 语义）。 */
  port(): HostWebPort | null {
    return this.web
  }

  isReady(): boolean {
    return this.web !== null
  }
}

// Cordis Context 类型增补：hostBridge 由 plugin-dsh-bridge 自举直挂提供
//（provide='hostBridge'），缺席形态（独立宿主/轻量 ctx）合法，故声明为可选——
// 消费方须经防御式软读访问，不得假设其在场。
declare module '@deepseek-ai/cordis' {
  interface Context {
    hostBridge?: HostBridgeRegistry
  }
}
