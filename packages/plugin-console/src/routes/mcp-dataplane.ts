/**
 * MCP 服务级数据面端点（MCP 治理契约 §7/§8，W2-T3）。
 *
 * POST /mcp/services/:serviceSlug（+ POST /mcp/s/:serviceId 别名）：把单个已纳管 MCP 服务
 * 以标准 Streamable HTTP（JSON-RPC 2.0 over POST）形态对 Agent/App 直接开放——这是 Agent
 * 接入平台 MCP 资源的标准默认路径；/api/mcp/invoke 降级为兼容层（routes/mcp.ts）、
 * 平台运维面 /mcp（bridge.ts）行为语义均不变。
 *
 * 与 bridge.ts 的 /mcp 平台面同构：/mcp 是协议保留前缀（platform-core http.ts
 * RESERVED_PATH_PREFIXES 已含 /mcp，/mcp/services 天然被覆盖），不走 console 鉴权中间件，
 * 本文件自管认证。方法分派：initialize（回 mcp-session-id，与 bridge 同语义）/ ping /
 * tools/list（按 §8 authorizedToolsFor 过滤）/ tools/call（→ ctx.mcpRegistry.invoke，
 * 统一走既有熔断/限流/权限组/风险/审计/计量链）。
 *
 * 协议错误面全部 JSON-RPC error 对象：拒绝必带领域 code（error.data.code），不回传平台内部堆栈。
 */
import type { Context } from '@deepseek-ai/cordis'
import { t } from '../../../platform-i18n/src/index.ts'
import {
  lookupsFromHost, resolveUnifiedPrincipal, toCallerInfo, toInvokeCaller,
  permissionPointAllows, parseTraceparent, sha256Hex,
} from '../../../platform-core/src/index.ts'
import type { CallerInfo, HttpExchange, UnifiedPrincipal } from '../../../platform-core/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'
import type { InvokeCaller, InvokeResult, McpServiceRecord } from '../../../plugin-mcp/src/index.ts'
import type { VerifiedPrincipal } from '../../../plugin-authn/src/index.ts'

// ---------------------------------------------------------------------------
// 权限判定复用（契约 §8「不许再抄一份」）
// ---------------------------------------------------------------------------

// 平台 /mcp tools/list 过滤的判定口径与 REST requirePermission 单点同源：W3-T5 platform-core
// 解冻后已导出 IMPLIED_POINTS/共享判定函数（rest-gate permissionPointAllows），本文件自此直接
// 消费共享判定面（冻结期的桩 host 探针实现退役）；对外函数签名不变，bridge.ts 调用点零改动。
/** 工具权限点判定（蕴含表口径与 rest-gate requirePermission 同源）：/mcp 平台面 tools/list 过滤复用。 */
export function consolePermissionAllows(info: CallerInfo, point: string): boolean {
  return permissionPointAllows(info.permissions, point)
}

/**
 * 数据面调用链 trace 取源（W3-T5 契约 §14）：X-Trace-Id（须 32hex）→ traceparent 头（W3C 解析）
 * → mcp-session-id（sha256 折算 32hex，同会话同 trace 根）；均缺席返回空对象，由网关 invoke 入口生成。
 */
function traceIdFrom(exchange: HttpExchange): { traceId: string } | Record<string, never> {
  const header = (name: string): string => String(exchange.headers[name] ?? '').trim()
  const explicit = header('x-trace-id')
  if (/^[0-9a-f]{32}$/.test(explicit)) return { traceId: explicit }
  const parsed = parseTraceparent(header('traceparent'))
  if (parsed) return { traceId: parsed.traceId }
  const session = header('mcp-session-id')
  // sha256Hex 产出 64 位，而 trace-id 口径为 32 位非全零 hex（W3C/平台 trace.ts）：
  // 取前 32 位折算，同一会话恒定同一 trace 根，不带病透传。
  if (session) return { traceId: sha256Hex(`mcp-session:${session}`).slice(0, 32) }
  return {}
}

// ---------------------------------------------------------------------------
// JSON-RPC 信封与错误映射（契约 §7）
// ---------------------------------------------------------------------------

/** JSON-RPC 信封输出（bridge mcpReply 同构；extraHeaders 供 mcp-session-id 下发）。 */
function reply(exchange: HttpExchange, payload: Record<string, unknown>, status = 200, extraHeaders: Record<string, string> = {}): void {
  exchange.res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  exchange.res.end(JSON.stringify(payload))
}

/** JSON-RPC 错误输出：data 携带领域 code（契约：拒绝必须带领域码），message 面向调用者、无内部堆栈。
 *  decisionId（W3-T5 §11，additive）：PDP 主裁决决策 id 随拒绝透出，data.code 旁并列可回查。 */
function replyError(exchange: HttpExchange, id: unknown, code: number, message: string, domain?: string, decisionId?: string): void {
  reply(exchange, {
    jsonrpc: '2.0', id,
    error: { code, message, ...(domain !== undefined || decisionId !== undefined ? { data: { ...(domain !== undefined ? { code: domain } : {}), ...(decisionId !== undefined ? { decisionId } : {}) } } : {}) },
  })
}

/** 请求体里的 JSON-RPC id（缺省 null，与 bridge 对认证错误的处理一致）。 */
function requestIdOf(exchange: HttpExchange): unknown {
  const body = exchange.body as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const id = (body as Record<string, unknown>).id
  return id === undefined ? null : id
}

/**
 * invoke 结果 → JSON-RPC 错误映射（契约 §7）：
 * denied→-32003（带领域码）/ rate_limited→-32004 RATE_LIMITED / breaker_open→-32003 BREAKER_OPEN /
 * 其余（error 等）→-32000。denied 领域码取序：工作级授权拒绝码（invoke 原样透传）→
 * 不在可见集合的工具统一 TOOL_NOT_VISIBLE_OR_DENIED（契约 §8 一致性，不泄露工具存在性）→
 * 服务生命周期码（offline/draft/verifying）→ PERMISSION_DENIED。
 */
function mapInvokeDenial(result: InvokeResult, visible: boolean, serviceCode: string | undefined): { code: number; domain: string } {
  switch (result.status) {
    case 'denied':
      return {
        code: -32003,
        domain: result.code
          ?? (visible ? serviceCode ?? 'PERMISSION_DENIED' : 'TOOL_NOT_VISIBLE_OR_DENIED'),
      }
    case 'rate_limited':
      return { code: -32004, domain: 'RATE_LIMITED' }
    case 'breaker_open':
      return { code: -32003, domain: 'BREAKER_OPEN' }
    default:
      return { code: -32000, domain: 'MCP_CALL_FAILED' }
  }
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

export function registerMcpDataplaneRoutes(ctx: Context, deps: Pick<ConsoleRouteDeps, 'http'>): void {
  const { http } = deps

  /**
   * 认证第 1 步（401 先于服务解析：不向未认证方泄露服务存在性）：Bearer → authn.verify。
   * 与 bridge mcpCallerFromToken 同构；verify 失败一律 401 + JSON-RPC -32001。
   */
  const verifyBearer = (exchange: HttpExchange): VerifiedPrincipal | undefined => {
    const header = String(exchange.headers['authorization'] ?? '')
    if (!header.startsWith('Bearer ')) {
      reply(exchange, {
        jsonrpc: '2.0', id: requestIdOf(exchange),
        error: { code: -32001, message: t('缺少 Bearer 令牌：服务级端点须持平台令牌或 audience=mcp:service:<slug> 的委托令牌') },
      }, 401, { 'www-authenticate': 'Bearer realm="dsh-mcp-dataplane"' })
      return undefined
    }
    try {
      return ctx.authn.verify(header.slice(7))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      reply(exchange, {
        jsonrpc: '2.0', id: requestIdOf(exchange),
        error: { code: -32001, message: t('令牌无效：{message}', { message }) },
      }, 401)
      return undefined
    }
  }

  /**
   * 认证第 2 步（服务解析之后，按 canonical slug 做 aud 强校验，契约 §7）：
   * 令牌带 audience 且 ≠ mcp:service:<slug> → 403 AUDIENCE_MISMATCH（服务级委托令牌经
   * POST /api/authn/token/exchange 换取，长令牌不透传下游）；无 audience 的平台令牌放行——
   * 数据面真正闸门是 MCP 权限组（invoke 链裁决）。随后统一 Principal 组装（契约 §2）：
   * verify 结果 → resolveUnifiedPrincipal → CallerInfo 兼容超集 + unified，禁止从
   * 请求参数/header 声明身份。
   */
  const assembleCaller = async (exchange: HttpExchange, verified: VerifiedPrincipal, expectedAudience: string): Promise<{ info: CallerInfo; unified: UnifiedPrincipal } | undefined> => {
    const audience = verified.token.audience
    if (audience !== undefined && audience !== expectedAudience) {
      reply(exchange, {
        jsonrpc: '2.0', id: requestIdOf(exchange),
        error: {
          code: -32003,
          message: t('令牌受众不匹配：本端点要求 audience={expected}，实际 {actual}', { expected: expectedAudience, actual: audience }),
          data: { code: 'AUDIENCE_MISMATCH' },
        },
      }, 403)
      return undefined
    }
    // 与 console 鉴权中间件 / bridge 同构：verify → resolveUnifiedPrincipal（D01 machine
    // refType/refId 照带、human userId 照旧，经 toCallerInfo 投影保持）
    const unified = await resolveUnifiedPrincipal(verified, lookupsFromHost({
      principalsGet: (id) => ctx.authn.principals().get(id),
      iamUserGet: (id) => ctx.iam.users().get(id),
      resourceGet: (kind, id) => ctx.resourceCore.get(kind, id) as { orgId?: string } | undefined,
      tenantOfOrg: (orgId) => ctx.iam.tenantOfOrg(orgId),
    }))
    return { info: { ...toCallerInfo(unified), unified } as unknown as CallerInfo, unified }
  }

  /** 服务解析（契约 §7）：slug 优先、:id 别名兜底；服务不存在由处理器回 SERVICE_NOT_FOUND。 */
  const resolveService = (key: string): McpServiceRecord | undefined => {
    if (!key) return undefined
    const services = ctx.mcpRegistry.services()
    return services.findOne((item) => item.slug === key) ?? services.get(key)
  }

  // JSON-RPC 分派主处理器（/mcp/services/:slug 与 /mcp/s/:id 共用）。
  // 顺序（契约 §7）：Bearer 校验（401，先于服务解析——不向未认证方泄露服务存在性）
  // → 服务解析（-32000 SERVICE_NOT_FOUND）→ aud 强校验（403 AUDIENCE_MISMATCH）→ 方法分派。
  const handler = async (exchange: HttpExchange): Promise<void> => {
    const verified = verifyBearer(exchange)
    if (!verified) return
    const key = exchange.params['serviceSlug'] ?? exchange.params['serviceId'] ?? ''
    const service = resolveService(key)
    if (!service) {
      return replyError(exchange, requestIdOf(exchange), -32000, t('MCP 服务不存在：{key}', { key }), 'SERVICE_NOT_FOUND')
    }
    const caller = await assembleCaller(exchange, verified, `mcp:service:${service.slug}`)
    if (!caller) return
    const message = exchange.body
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return replyError(exchange, null, -32600, t('请求体必须是单个 JSON-RPC 2.0 消息（暂不支持批量）'))
    }
    const id = (message as Record<string, unknown>).id
    // 通知类消息（无 id）：确认即止（与 bridge 同语义）
    if (id === undefined || id === null) {
      exchange.res.writeHead(202)
      exchange.res.end()
      return
    }
    const method = String((message as Record<string, unknown>).method ?? '')
    const params = ((message as Record<string, unknown>).params ?? {}) as Record<string, unknown>
    // unified → InvokeCaller 投影（契约 §2）：toInvokeCaller 单点映射，与 /api/mcp/invoke 的
    // resolveMcpCaller（unified 路径）同口径；actChain/onBehalfOf 由映射统一给出。
    // W3-T5（契约 §11/§12/§13/§14）additive 事实附加：org/租户/委托链用户/scopes 供 PDP
    // org-constraint 与 iam-permission 第一层消费；traceId 从 X-Trace-Id（32hex）/traceparent/
    // mcp-session-id 头取（会话 id 经 sha256 折算 32hex，同会话同 trace 根；均缺席由网关入口生成）。
    const invokeCaller = {
      ...toInvokeCaller(caller.unified),
      ...(caller.unified.orgId !== undefined ? { orgId: caller.unified.orgId } : {}),
      ...(caller.unified.tenantId !== undefined ? { tenantId: caller.unified.tenantId } : {}),
      ...(caller.unified.subjectUserId !== undefined ? { subjectUserId: caller.unified.subjectUserId } : {}),
      scopes: [...caller.unified.scopes],
      ...traceIdFrom(exchange),
    } as InvokeCaller
    const resultReply = (result: unknown, extraHeaders?: Record<string, string>) =>
      reply(exchange, { jsonrpc: '2.0', id, result }, 200, extraHeaders)
    switch (method) {
      case 'initialize':
        return resultReply({
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: `mcp:${service.slug}`, title: service.name, version: service.currentVersion },
          instructions: t('服务级 MCP 数据面（{service}）：tools/list 仅列出当前身份经 MCP 权限组授权的工具；tools/call 统一走平台网关链（鉴权/限流/熔断/审计/计量）。', { service: service.name }),
        }, { 'mcp-session-id': `dshmcp-${service.slug}-${Date.now().toString(36)}` })
      case 'ping':
        return resultReply({})
      case 'tools/list': {
        // 契约 §8「列表即边界」：只返回 authorizedToolsFor 集合内的工具（完整
        // inputSchema/description 照常），集合为空回空数组；未授权工具的名称/schema/风险
        // 注解一概不出现。与 tools/call 的拒绝路径共用同一集合。
        const visible = ctx.mcpRegistry.authorizedToolsFor(invokeCaller, service)
        const allowed = new Set(visible)
        return resultReply({
          tools: service.tools
            .filter((tool) => allowed.has(tool.name))
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              annotations: { 'x-risk': tool.riskLevel },
            })),
        })
      }
      case 'tools/call': {
        const toolName = String(params.name ?? '')
        const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? params.arguments
          : {}) as Record<string, unknown>
        // 契约 §8 一致性：可见集合与 tools/list 同源（authorizedToolsFor）。不在列表中的工具
        // 调用仍交给 invoke 裁决并落账（拒绝是事实，mcp:calls 照记、审计照发），本端点只按
        // 结果映射 JSON-RPC 错误——未知/不可见工具不泄露存在性（统一 TOOL_NOT_VISIBLE_OR_DENIED）。
        const visible = new Set(ctx.mcpRegistry.authorizedToolsFor(invokeCaller, service))
        // 服务生命周期拒绝的领域码标注（契约 §7）：offline/draft/verifying 由 invoke 拒绝，
        // 这里仅把拒绝语义翻译成领域码（裁决与落账仍以 invoke 为准，不做预判拦截）。
        const serviceCode = service.status === 'offline'
          ? 'SERVICE_OFFLINE'
          : service.status === 'draft' || service.status === 'verifying' ? 'SERVICE_NOT_PUBLISHED' : undefined
        const result = await ctx.mcpRegistry.invoke(invokeCaller, service.id, toolName, args)
        if (!result.ok) {
          const mapped = mapInvokeDenial(result, visible.has(toolName), serviceCode)
          // W3-T5 §11（additive）：拒绝响应 data.code 旁并列 PDP 决策 id，可回查裁决依据
          return replyError(exchange, id, mapped.code, result.error ?? t('MCP 调用失败'), mapped.domain, result.decisionId)
        }
        // MCP content 形态包装（契约 §7）：结构化结果 JSON 序列化进 text 帧
        return resultReply({
          content: [{ type: 'text', text: JSON.stringify(result.result ?? null) }],
          isError: false,
        })
      }
      default:
        return replyError(exchange, id, -32601, t('方法不存在：{method}', { method }))
    }
  }

  http.register('POST', '/mcp/services/:serviceSlug', handler)
  // :id 别名（契约 §7）：按服务 ID 直达，鉴权/aud 语义与 slug 路径完全一致（aud 恒按 slug 校验）
  http.register('POST', '/mcp/s/:serviceId', handler)

  // Streamable HTTP：本端点为无会话纯 JSON 形态，GET（SSE 长流）不支持，DELETE（会话终止）恒成功
  // （与 bridge /mcp 同语义；端点为协议保留前缀，无处理器命中时兜底本就返回 404 JSON，不会落进 SPA）
  const methodGuard = (exchange: HttpExchange): void => {
    if (exchange.method === 'DELETE') {
      exchange.ok({})
      return
    }
    exchange.res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: t('本 MCP 端点为无会话纯 JSON 形态，不支持 GET SSE 长流') } }))
  }
  http.register('GET', '/mcp/services/:serviceSlug', methodGuard)
  http.register('DELETE', '/mcp/services/:serviceSlug', methodGuard)
  http.register('GET', '/mcp/s/:serviceId', methodGuard)
  http.register('DELETE', '/mcp/s/:serviceId', methodGuard)
}
