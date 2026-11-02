/**
 * REST 鉴权门共享模块（R5 鉴权样板收敛，REFACTOR-2026-10-13，2026-10-13）。
 *
 * 此前 CallerInfo + requirePermission + guarded + body + changeLog 在
 * plugin-console / plugin-panel-core / plugin-flow-core / plugin-dingtalk-bridge
 * 四处近似重复（逐字同构的 guarded/body，字段窄化不一的 CallerInfo）——
 * 单点修复、单点审计收敛于此。principal 的构造仍在 console 鉴权中间件
 * （唯一权威写入点，见 plugin-console/src/index.ts），本模块只消费。
 *
 * 依赖方向：platform-core 不反向依赖业务插件——audit 经最小结构类型注入
 * （调用方 ctx 结构化满足即可）；flow-core 等未注入 audit 的插件不得调用
 * changeLog（构造时缺 audit 则 changeLog 快速失败，防静默丢审计）。
 */
import type { HttpExchange, HttpHandler, RouteAuthDecl } from './http.ts'
import type { WorkCallerRef } from './workforce-port.ts'
import { toWorkCallerRef, unifiedFromCaller } from './principal.ts'
import { t } from '../../platform-i18n/src/index.ts'

/** 调用方身份（console 鉴权中间件写入 exchange.principal 的完整结构） */
export interface CallerInfo {
  kind: 'human' | 'machine'
  principalId: string
  userId?: string
  /** machine 专属：凭证关联资源（refType=agent 时 modelgw 等调用以 agent:<refId> 为计量主体）。 */
  refType?: string
  refId?: string
  name: string
  permissions: string[]
  actChain: Array<{ name: string; type: string }>
}

/** 最小结构宿主：业务插件的 ctx 均结构化满足（不引入对具体服务的类型依赖） */
export interface RestGateHost {
  httpServer: { register(method: string, pattern: string, handler: HttpHandler, auth?: RouteAuthDecl): unknown }
  platformBus: { emit(event: string, payload: unknown): unknown }
  audit?: { record(entry: Record<string, unknown>): unknown }
}

export interface RestGate {
  /** 取调用方身份（principal 由 console 鉴权中间件先行写入） */
  caller(exchange: HttpExchange): CallerInfo
  /** 权限判定：缺权限 403 + audit.authz.denied 留痕（RBAC 探针的判定面） */
  requirePermission(exchange: HttpExchange, point: string): boolean
  /** 注册权限保护路由（H5：声明经 register 自动汇入路由×权限矩阵） */
  guarded(method: string, path: string, permission: string, handler: (exchange: HttpExchange) => unknown | Promise<unknown>): void
  /** 请求体解析（宽松转换） */
  body<T extends Record<string, any>>(exchange: HttpExchange): T
  /** 变更审计留痕（要求宿主注入 audit，缺审计时快速失败） */
  changeLog(exchange: HttpExchange, action: string, resourceType: string, resourceId: string, resourceName: string, detail?: string): void
  /** 审计主体 id（人类取 userId，机器取 principalId） */
  actorOf(exchange: HttpExchange): string
}

/**
 * 权限点蕴含表（2026-10-17 演示模式批次）：键为业务点，值为蕴含它的基线点——
 * 持有基线点即视为持有业务点。
 *
 *   console.read（控制台只读基线：工作台聚合/通知/平台信息/工具目录/最近调用）
 *     ← console.login（登录会话基线，所有可登录角色必持）
 *
 * 动机：这批纯读路由此前声明 console.login，「登录会话」语义与「可读工作台」
 * 并不精确对齐，且免登演示态（DEMO_MODE=1，见 plugin-console demo-mode.ts）
 * 的只读白名单不含登录级点，访客打不开工作台首屏。路由改声明 console.read 后，
 * 判定面补本蕴含规则，存量真实用户令牌（只签了 console.login，含升级前签发的旧令牌）
 * 无需重签即零感知通过——带 Bearer 的请求行为完全不变。
 * 前端 session.can()（plugin-console/public/js/api.js）有同款镜像规则，两处须同步改。
 */
const IMPLIED_POINTS: Record<string, string> = { 'console.read': 'console.login' }
// 蕴含表导出（W3-T5）：/mcp bridge tools/list 过滤等非 REST 面与 REST requirePermission
// 单点同源（此前 platform-core 冻结期只能借桩 host 探针间接取布尔，现可直接消费）
export { IMPLIED_POINTS }

/**
 * 权限点判定的共享纯函数（MCP 治理契约 §8/§11，W3-T5 导出）：与 requirePermission
 * 同一判定面（'*' 直通 / 点直持 / 蕴含表命中），供非 REST 面（如 /mcp bridge 的
 * tools/list 过滤探针）单点复用——蕴含表是本模块常量，导出后不再需要借
 * createRestGate 的桩 host 间接取布尔（platform-core 冻结期的过渡实现已可替换）。
 */
export function permissionPointAllows(permissions: string[], point: string): boolean {
  const impliedBy = IMPLIED_POINTS[point]
  return permissions.includes('*') || permissions.includes(point)
    || (impliedBy !== undefined && permissions.includes(impliedBy))
}

export function createRestGate(ctx: RestGateHost): RestGate {
  const caller = (exchange: HttpExchange): CallerInfo => exchange.principal as CallerInfo

  const requirePermission = (exchange: HttpExchange, point: string): boolean => {
    const info = caller(exchange)
    // 判定面单点收敛（W3-T5）：蕴含表与布尔判定在上方 permissionPointAllows，本处只补副作用
    if (permissionPointAllows(info.permissions, point)) return true
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point,
      path: exchange.path,
    })
    exchange.fail(403, 'FORBIDDEN', t('缺少权限点 {point}，请联系管理员调整角色', { point }), { permission: point })
    return false
  }

  const guarded = (method: string, path: string, permission: string, handler: (exchange: HttpExchange) => unknown | Promise<unknown>): void => {
    ctx.httpServer.register(method, path, async (exchange) => {
      if (!requirePermission(exchange, permission)) return
      try {
        const result = await handler(exchange)
        if (!exchange.res.writableEnded) exchange.ok(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        exchange.fail(400, 'BAD_REQUEST', message)
      }
    }, { access: 'guarded', permission })
  }

  const body = <T extends Record<string, any>>(exchange: HttpExchange): T => (exchange.body ?? {}) as T

  const changeLog = (exchange: HttpExchange, action: string, resourceType: string, resourceId: string, resourceName: string, detail = ''): void => {
    if (!ctx.audit) throw new Error(t('changeLog 需要宿主注入 audit 服务（本插件未注入，禁止静默丢弃审计）'))
    const info = caller(exchange)
    ctx.audit.record({
      type: 'change',
      actorType: info.kind === 'human' ? 'human' : 'machine',
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      action,
      resourceType,
      resourceId,
      resourceName,
      result: 'ok',
      detail,
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    })
  }

  const actorOf = (exchange: HttpExchange): string => {
    const info = caller(exchange)
    return info.userId ?? info.principalId
  }

  return { caller, requirePermission, guarded, body, changeLog, actorOf }
}

/**
 * 已验证主体 → 工作策略调用者引用（WorkCallerRef，D01 additive）。
 *
 * 供各路由把 console 鉴权中间件写入的 exchange.principal（CallerInfo）交给
 * workforce 窄端口（ctx.workforcePolicy / gateManagedWork / workforce.claimWork）：
 * 身份一律取自令牌解析结果，禁止从请求体/查询参数组装。字段一一映射，
 * 缺省字段不产出（保持 WorkCallerRef 可选项语义）。不改动既有 RestGate 行为。
 *
 * MCP 治理收敛（契约 §2）：映射实现单点迁至 principal.ts（toWorkCallerRef），
 * 本函数仅做 CallerInfo → 统一主体的形状对齐后委托，对外行为不变。
 */
export function workCallerOf(info: CallerInfo): WorkCallerRef {
  return toWorkCallerRef(unifiedFromCaller(info))
}
