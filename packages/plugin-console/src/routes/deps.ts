/**
 * console 路由域共享依赖契约（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）。
 *
 * 自 routes/market.ts 上收：各路由域文件（routes/*.ts）统一以
 * register<域>Routes(ctx, deps) 注入 REST 网关五件套（http/guarded/body/changeLog/caller，
 * 实现均来自 platform-core createRestGate，index.ts 解构后传入）——
 * 各域文件按需以接口扩展声明本域用到的额外依赖（如 requirePermission/requestOrigin），
 * 此处只维护最大公共面。CallerInfo 统一引 platform-core 权威定义（principal 完整结构，
 * 唯一写入点是 plugin-console/src/index.ts 的鉴权中间件）。
 */
import type { CallerInfo, HttpExchange } from '../../../platform-core/src/index.ts'

export interface ConsoleRouteDeps {
  http: { register: (method: string, path: string, handler: (exchange: HttpExchange) => unknown | Promise<unknown>, options?: Record<string, unknown>) => void }
  guarded: (method: string, path: string, permission: string, handler: (exchange: HttpExchange) => unknown | Promise<unknown>) => void
  body: <T>(exchange: HttpExchange) => T
  changeLog: (exchange: HttpExchange, action: string, resourceType: string, resourceId: string, resourceName: string, detail?: string) => void
  caller: (exchange: HttpExchange) => CallerInfo
}
