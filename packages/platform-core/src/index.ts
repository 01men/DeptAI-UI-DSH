/**
 * @dsh-ops/platform-core —— 平台基础插件。
 *
 * 提供四个基础服务（一切皆插件：基础层同样是插件）：
 *   ctx.opsStorage      JSON 集合存储（原子落盘，可替换为 DB 实现）
 *   ctx.platformBus  平台事件总线（插件协作唯一胶水）
 *   ctx.tools        ToolRuntime-lite（独立宿主下提供；完整 dsh 下由真 ToolRuntime 提供）
 *   ctx.httpServer   HTTP 服务（控制台 REST API 与静态资源）
 */
import type { Context } from '@deepseek-ai/cordis'
import { StorageService } from './storage.ts'
import { PlatformBusService } from './bus.ts'
import { ToolRuntimeLite } from './tools-lite.ts'
import { HttpServerService } from './http.ts'
import { SqliteTxnService } from './sqlite.ts'
import { WorkforcePolicyRegistry } from './workforce-port.ts'
import { BehaviorService } from './behavior.ts'
import { ScenegraphService } from './scenegraph.ts'

export * from './storage.ts'
export * from './storage-sqlite.ts'
export * from './bus.ts'
export * from './tools-lite.ts'
export * from './http.ts'
// OpenAPI 接口面投影（issue #6）：由 declaredRoutes 台账生成 3.0.3 文档，/api/openapi.json 据此伺服
export * from './openapi.ts'
export * from './rest-gate.ts'
export * from './principal.ts'
// 策略决策点 + 全链 trace 基元（MCP 治理契约 §11/§14，W3-T5）
export * from './pdp.ts'
export * from './trace.ts'
export * from './ids.ts'
export * from './sensitive.ts'
export * from './sqlite.ts'
export * from './workforce-port.ts'
export * from './host-bridge.ts'
export * from './yaml.ts'
export * from './zip.ts'
export * from './plugin-ctx.ts'
export * from './version.ts'
export * from './behavior.ts'
export * from './scenegraph.ts'
export * from './signature.ts'
export * from './boot-probe.ts'
// 平台资产统一业务分类（Skill/Agent/应用/MCP/A2A 各板块共用口径）
export * from './taxonomy.ts'

export interface PlatformCoreConfig {
  dataDir?: string
  /** 独立宿主默认 true；挂载进完整 dsh 时设为 false，避免与真正 ToolRuntime 冲突。 */
  provideToolRuntime?: boolean
  http?: { port?: number; host?: string; externalBase?: string }
  /** 是否自动启动 HTTP 监听。 */
  startHttp?: boolean
}

export const name = 'platform-core'

export async function apply(ctx: Context, config: PlatformCoreConfig = {}) {
  const storage = new StorageService(ctx, { dataDir: config.dataDir })
  ctx.plugin(PlatformBusService)
  ctx.plugin(SqliteTxnService, { dataDir: config.dataDir })
  // 数字员工工作策略登记器（窄端口）：plugin-workforce ready 后登记实现，
  // 资源网关/exec-hub 经 ctx.workforcePolicy 消费（装配顺序无关，防循环依赖）
  ctx.plugin(WorkforcePolicyRegistry)
  if (config.provideToolRuntime !== false) {
    ctx.plugin(ToolRuntimeLite)
  }
  const http = new HttpServerService(ctx, config.http ?? {})
  // 集合恢复必须先于一切业务集合读取（form B 教训：boot-all 的 restoreAll 在 loader
  // 链路不存在，集合全空 → 演示种子重种撞幂等键 fatal）。apply 异步化，loader 会等待。
  await storage.start()
  await storage.restoreAll()
  // behavior 行为事件管道（WP-03/D6）：端点随基础层装配，鉴权依赖 console 中间件 + 本端点双层校验
  ctx.plugin(BehaviorService)
  // 行业场景图谱服务（review-dsh-agent-panel-v2 Phase 2）：内置资产通道装载 + scenegraph.updated 热刷新
  ctx.plugin(ScenegraphService)
  if (config.startHttp !== false) {
    void http.start().then(() => {
      ctx.logger('platform-core').info(`HTTP 服务已启动：http://${http.host}:${http.port}`)
    }, (error: unknown) => {
      ctx.logger('platform-core').error('HTTP 服务启动失败', error)
    })
  }
}
