/**
 * Bridge 域路由：平台信息与工具桥（tools 代理执行/健康巡检/版本信息）+ MCP Server 端点（平台即 MCP 服务，与 REST/CLI/dsh 插件同一套工具与权限体系）（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出，处理器逐字搬运（行为与迁出前一致）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { t } from '../../../platform-i18n/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'
import { platformVersionInfo, lookupsFromHost, resolveUnifiedPrincipal, toCallerInfo, buildOpenApiDocument, PlatformEvents } from '../../../platform-core/src/index.ts'
import type { CallerInfo, HttpExchange } from '../../../platform-core/src/index.ts'
import { noteForwardedPrincipal } from '../../../plugin-connect/src/host.ts'
import { consolePermissionAllows } from './mcp-dataplane.ts'

export function registerBridgeRoutes(ctx: Context, deps: ConsoleRouteDeps): void {
  const { http, guarded, body, changeLog, caller } = deps
  // -- 平台信息与工具桥 -----------------------------------------------------
  /** 路由×权限矩阵（WP-04/A1 + 交接清单 H5）：RBAC 断言网的服务端事实源。
   *  guarded=register 声明自动汇入的权限点保护端点；public=免鉴权白名单（selfValidated=处理器自带凭证
   *  校验，断言网对其实施匿名探针必须被拒）；authenticated=仅中间件 Bearer、无独立权限点；
   *  /api/* 缺声明在 register 期即抛错，undeclaredApi 恒空——自注册端点不再可能逃出断言网。 */
  guarded('GET', '/api/platform/route-matrix', 'audit.read', () => {
    const apiDeclared = http.declaredRoutes.filter((route) => route.path === '/api' || route.path.startsWith('/api/'))
    const publicEntries = apiDeclared.flatMap((route) => route.auth.access === 'public'
      ? [{ method: route.method, path: route.path, selfValidated: route.auth.selfValidated === true }]
      : [])
    const authenticated = apiDeclared.flatMap((route) => route.auth.access === 'authenticated' ? [{ method: route.method, path: route.path }] : [])
    return {
      guarded: http.routeMatrix.map((route) => ({ ...route })),
      public: publicEntries.map((route) => route.path),
      publicEntries,
      authenticated,
      counts: {
        declaredApi: apiDeclared.length,
        guarded: http.routeMatrix.length,
        public: publicEntries.length,
        authenticated: authenticated.length,
        undeclaredApi: apiDeclared.filter((route) => route.auth.access === 'outside-api').length,
      },
      note: t('guarded=权限点保护端点；public=免鉴权（selfValidated=自带凭证校验）；authenticated=仅 Bearer；变动须经评审'),
    }
  })

  // OpenAPI 接口面发现（issue #6）：由 declaredRoutes 台账投影 3.0.3 文档（原始文档，不包信封——Swagger UI /
  // 代码生成器直接消费）。仅要求登录（authenticated）：接口面本身随包 manifest 与 /docs 公开，不是秘密；
  // 权限点标识是客户端理解「调用需要什么」的必要信息。与 route-matrix（audit.read，越权断言网口径）分层。
  http.register('GET', '/api/openapi.json', (exchange) => {
    const document = buildOpenApiDocument(http.declaredRoutes, {
      version: platformVersionInfo().version,
      externalBase: http.externalBase,
    })
    exchange.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    exchange.res.end(JSON.stringify(document))
  }, { access: 'authenticated' })

  // console.read（2026-10-17）：平台信息/插件清单为纯读面，被 console.login 蕴含（真实用户零感知），
  // 免登演示态据此可开「插件与工具」页。注意：DEMO_MODE=1 时本路由暴露实例全部只读视图，
  // 仅应在无敏感/演示种子数据的实例上开启（见 demo-mode.ts 诚实边界）。
  guarded('GET', '/api/platform/info', 'console.read', () => {
    const versionInfo = platformVersionInfo()
    // Q-18：插件清单取实际装配树（ctx.registry 的 fiber 名），不再维护写死清单——
    // 写死清单随新插件上线即漂移（加载屏 29 个 vs 此处 18 个），使同一产品出现两个插件数。
    // 过滤口径：顶层插件包名（排除插件内注册的 Service 类与 *-tools 工具子插件，二者非独立插件包）。
    const plugins: string[] = []
    try {
      for (const fiber of ctx.registry.values()) {
        const name = (fiber as { name?: string }).name
        if (!name || /Service$/.test(name) || /-tools$/.test(name)) continue
        if (!plugins.includes(name)) plugins.push(name)
      }
    } catch { /* registry 不可枚举时退化为空清单，不伪造数字 */ }
    return {
      name: '元冰可|企业AI资源管理平台',
      version: versionInfo.version,
      installMode: versionInfo.installMode,
      runtime: 'standalone-cordis（dsh 插件兼容）',
      plugins,
      pluginCount: plugins.length,
      collections: ctx.opsStorage.names(),
      tools: ctx.tools.schemas(),
      resourceTypes: ctx.resourceCore.typesSpecs().map((spec) => ({ type: spec.type, label: spec.label, plugin: spec.plugin })),
      events: ctx.platformBus.recent(10),
    }
  })


  /**
   * 工具身份注入：服务端以令牌解析的调用者身份为准，禁止调用方自填身份参数。
   * connector_execute / mcp_invoke 的调用方身份已改为经 exec.principal 传递（schema 无 caller* 参数），
   * 不再走 args 注入；其余工具的 approver/requester/actor 仍由此处覆盖。
   * iam 管理类工具（N1）：以 args 保留键 _actor 注入服务端可信操作者（id/name/orgId/platformAdmin），
   * 供 iam 服务层做 fail-closed 组织隔离；客户端传入的 _actor/actor 一律剥离后重注入。
   * /mcp tools/call 与 REST /api/tools/execute 两条链路都经此处，注入口径天然一致。
   */
  const iamManageTools = new Set(['iam_org_create', 'iam_org_update', 'iam_user_create', 'iam_user_reset_password', 'iam_user_freeze'])
  const injectToolIdentity = (name: string, inputArgs: Record<string, unknown>, info: CallerInfo): Record<string, unknown> => {
    const args = { ...inputArgs }
    const principalId = info.userId ?? info.principalId
    if (name === 'approval_decide' || name === 'skill_approve') {
      args.approverId = principalId
      args.approverName = info.name
    } else if (name === 'agent_offline' || name === 'app_offline' || name === 'mcp_offline' || name === 'iam_sync_run') {
      args.requesterId = principalId
      args.requesterName = info.name
      args.actor = info.name
    } else if (name === 'agent_bind_user' || name === 'skill_install' || name === 'skill_publish') {
      args.actor = info.name
    } else if (iamManageTools.has(name)) {
      delete args.actor
      delete args._actor
      // orgId 只对人类调用者解析（令牌 refId → 用户档案单次查询）；机器主体与无归属者缺省，
      // 由 iam 服务层按非平台管理员 fail-closed 拒绝（与 REST iam 路由 manageActor 同口径）
      const orgId = info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined
      args._actor = {
        id: principalId,
        name: info.name,
        ...(orgId ? { orgId } : {}),
        platformAdmin: info.permissions.includes('*'),
      }
    }
    // nas_fs_* 工具身份已改为经 exec.principal 传递（P0-2：身份不进工具参数，schema 无 actor* 参数）
    return args
  }

  /** 工具面调用留痕（2026-11-02）：/mcp 与 REST 工具桥共用——每次调用（成功/失败）emit
   *  ToolInvoked，audit 订阅逐次落 tool.invoke。actorId 取 userId ?? principalId：
   *  human PAT 调用即成员 userId，审计天然与成员关联。fail-open：留痕失败不阻断调用。 */
  const emitToolInvoked = (
    host: { platformBus: { emit: (name: string, payload: unknown) => unknown } },
    info: CallerInfo,
    toolName: string,
    result: { isError?: boolean; durationMs?: number; error?: { message?: string } },
    surface: string,
  ): void => {
    try {
      host.platformBus.emit(PlatformEvents.ToolInvoked, {
        actorType: info.kind,
        actorId: info.userId ?? info.principalId,
        actorName: info.name,
        actChain: info.actChain,
        name: toolName,
        isError: result.isError === true,
        durationMs: result.durationMs ?? 0,
        ...(result.error?.message ? { error: result.error.message } : {}),
        surface,
      })
    } catch (error) {
      host.platformBus.emit(PlatformEvents.BusListenerError, { event: PlatformEvents.ToolInvoked, listener: 'emitToolInvoked', attempt: 1, error: String(error) })
    }
  }

  // console.read（2026-10-17，同 /api/platform/info 口径：纯读目录，演示态可读）
  guarded('GET', '/api/tools/schemas', 'console.read', () => ({
    tools: ctx.tools.schemas().map((tool) => ({ name: tool.name, description: tool.description, permission: tool.permission, parameters: tool.parameters })),
  }))

  guarded('POST', '/api/tools/execute', 'console.login', async (exchange) => {
    const input = body<{ name: string; args?: Record<string, unknown> }>(exchange)
    if (!input.name) throw new Error(t('工具名必填'))
    const info = caller(exchange)
    // 工具级权限校验：以工具声明的最小权限点为准，缺省仅要求登录
    const definition = ctx.tools.schemas().find((tool) => tool.name === input.name)
    const required = definition?.permission
    if (required && !info.permissions.includes('*') && !info.permissions.includes(required)) {
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info.userId ?? info.principalId,
        actorName: info.name,
        point: required,
        path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', t('缺少权限点 {permission}，请联系管理员调整角色', { permission: required }), { permission: required })
      return
    }
    const args = injectToolIdentity(input.name, input.args ?? {}, info)
    // D13 观测（connect 转发路径）：接入客户端（plugin-connect client.forward）的转发体若携带
    // meta.principal 主体绑定信封，在此做「同一客户端凭证短窗口多主体」归因风险检测——
    // 仅 logger.warn 中文提示（不阻断、不参与鉴权）：鉴权仍以 exchange.principal（Bearer 令牌
    // 服务端验证结果）为唯一事实，信封字段只作日志/归因观测（§10.4：结构相同的参数不构成授权事实）。
    const forwardedPrincipalId = (input as { meta?: { principal?: { principalId?: string } } }).meta?.principal?.principalId
    if (typeof forwardedPrincipalId === 'string' && forwardedPrincipalId) {
      noteForwardedPrincipal(ctx.logger('connect'), info.principalId, forwardedPrincipalId)
    }
    const result = await ctx.tools.execute({ name: input.name, arguments: args, principal: info })
    emitToolInvoked(ctx, info, input.name, result, exchange.path)
    return result
  })

  // -- MCP Server 端点：平台即 MCP 服务（与 REST/CLI/dsh 插件同一套工具与权限体系） ------
  //
  // Streamable HTTP（JSON-RPC 2.0 over POST /mcp）：initialize（回 mcp-session-id，无状态
  // 服务端会话仅为客户端兼容）/ notifications/*（202）/ tools/list / tools/call / ping。
  // 每请求 Bearer 鉴权（人/机器令牌皆可），工具级权限点 + 身份注入与 REST 工具桥完全一致。
  // 不提供 GET SSE 长流（纯 JSON 响应形态合规）；外部 MCP 客户端接入示例：
  //   {"mcpServers":{"dsh-ops-platform":{"url":"http://<平台>:7300/mcp","headers":{"Authorization":"Bearer <平台令牌>"}}}}
  const mcpCallerFromToken = async (exchange: HttpExchange): Promise<CallerInfo | undefined> => {
    const header = String(exchange.headers['authorization'] ?? '')
    if (!header.startsWith('Bearer ')) {
      exchange.res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="dsh-ops-mcp"',
      })
      exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: t('缺少 Bearer 令牌：/mcp 与 REST 共用同一套平台令牌') } }))
      return undefined
    }
    try {
      const verified = ctx.authn.verify(header.slice(7))
      // MCP 治理收敛（契约 §2）：与 console 鉴权中间件同构——verify → resolveUnifiedPrincipal →
      // CallerInfo 兼容超集 + unified 字段。D01（V01/V02）machine 主体 refType/refId 照带、
      // human userId 照旧的行为经 toCallerInfo 投影保持；tools/list、tools/call 逻辑不在此处（W2-T3 负责）。
      const unified = await resolveUnifiedPrincipal(verified, lookupsFromHost({
        principalsGet: (id) => ctx.authn.principals().get(id),
        iamUserGet: (id) => ctx.iam.users().get(id),
        resourceGet: (kind, id) => ctx.resourceCore.get(kind, id) as { orgId?: string } | undefined,
        tenantOfOrg: (orgId) => ctx.iam.tenantOfOrg(orgId),
      }))
      return { ...toCallerInfo(unified), unified } as unknown as CallerInfo
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.res.writeHead(401, { 'content-type': 'application/json' })
      exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: t('令牌无效：{message}', { message }) } }))
      return undefined
    }
  }

  const mcpReply = (exchange: HttpExchange, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}): void => {
    exchange.res.writeHead(200, { 'content-type': 'application/json', ...extraHeaders })
    exchange.res.end(JSON.stringify(payload))
  }

  http.register('POST', '/mcp', async (exchange) => {
    const info = await mcpCallerFromToken(exchange)
    if (!info) return
    const message = exchange.body
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      exchange.res.writeHead(400, { 'content-type': 'application/json' })
      exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: t('请求体必须是单个 JSON-RPC 2.0 消息（暂不支持批量）') } }))
      return
    }
    const id = (message as Record<string, unknown>).id
    // 通知类消息（无 id）：确认即止
    if (id === undefined || id === null) {
      exchange.res.writeHead(202)
      exchange.res.end()
      return
    }
    const method = String((message as Record<string, unknown>).method ?? '')
    const params = ((message as Record<string, unknown>).params ?? {}) as Record<string, unknown>
    const reply = (result: unknown, extraHeaders?: Record<string, string>) => mcpReply(exchange, { jsonrpc: '2.0', id, result }, extraHeaders)
    const replyError = (code: number, text: string) => mcpReply(exchange, { jsonrpc: '2.0', id, error: { code, message: text } })
    switch (method) {
      case 'initialize':
        return reply(
          {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'dsh-ops-platform', title: '元冰可|企业AI资源管理平台 · MCP 网关', version: platformVersionInfo().version },
            instructions: '元冰可|企业AI资源管理平台（IAM/MCP/Skill/Agent/应用/NAS/用量计量/审计）。工具权限与控制台账号一致：先用 nas_list / mcp_service_list / skill_search 等盘点资产，再按需调用写类工具。',
          },
          { 'mcp-session-id': `dshmcp-${Date.now().toString(36)}` },
        )
      case 'ping':
        return reply({})
      case 'tools/list':
        // MCP 治理（契约 §8，W2-T3）：工具目录按调用方权限过滤——判定口径与 REST
        // requirePermission 单点同源（consolePermissionAllows 借 rest-gate 判定面，蕴含表
        // IMPLIED_POINTS 不抄第二份），工具 permission 缺省按 console.login 基线（与下方
        // tools/call 拒绝基线一致）。无权限工具的名称/schema/权限注解一概不返回。
        return reply({
          tools: ctx.tools.schemas()
            .filter((tool) => consolePermissionAllows(info, tool.permission ?? 'console.login'))
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters,
              ...(tool.permission !== undefined ? { annotations: { 'x-permission': tool.permission } } : {}),
            })),
        })
      case 'tools/call': {
        const name = String(params.name ?? '')
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
        const definition = ctx.tools.schemas().find((tool) => tool.name === name)
        if (!definition) {
          return reply({ content: [{ type: 'text', text: t('未知工具：{name}', { name }) }], isError: true })
        }
        // 权限基线与 REST 工具桥对齐（QA-20261014 生命周期测试新发现）：REST 面 /api/tools/execute
        // 有路由级 console.login 兜底，而 /mcp 此前对「未声明 permission 的工具」不做任何权限点校验，
        // 36 个存量工具（含 audit_logs / authn_token_list / iam_user_list 等敏感读面）对任意有效
        // 令牌（任意 scopes 的机器凭证）放行。现收敛：未声明 permission 的工具一律要求 console.login
        // 基线；存量工具的逐一 permission 声明（最小权限映射）另立台账跟进。
        const required = definition.permission ?? 'console.login'
        if (!info.permissions.includes('*') && !info.permissions.includes(required)) {
          ctx.platformBus.emit('audit.authz.denied', {
            actorId: info.userId ?? info.principalId,
            actorName: info.name,
            point: required,
            path: '/mcp',
          })
          return reply({ content: [{ type: 'text', text: t('缺少权限点 {permission}（调用方 {caller}），调用被拒绝', { permission: required, caller: info.name }) }], isError: true })
        }
        const result = await ctx.tools.execute({ name, arguments: injectToolIdentity(name, args, info), principal: info })
        emitToolInvoked(ctx, info, name, result, '/mcp')
        return reply({
          content: result.content.length > 0 ? result.content : [{ type: 'text', text: JSON.stringify(result.value ?? null) }],
          isError: result.isError,
        })
      }
      default:
        return replyError(-32601, t('方法不存在：{method}', { method }))
    }
  })

  // Streamable HTTP：本端点为无会话纯 JSON 形态，GET（SSE 长流）不支持，DELETE（会话终止）恒成功
  http.register('GET', '/mcp', (exchange) => {
    exchange.res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: t('本 MCP 端点为无会话纯 JSON 形态，不支持 GET SSE 长流') } }))
  })
  http.register('DELETE', '/mcp', (exchange) => {
    exchange.ok({})
  })

}
