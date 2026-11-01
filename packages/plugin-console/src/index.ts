/**
 * @dsh-ops/plugin-console —— 管理控制台接入插件。
 *
 * 职责：
 *   - REST API 网关：统一 Bearer 鉴权（authn）、权限点校验（RBAC）、审计埋点
 *   - 静态托管管理控制台 SPA（public/，飞书级交互）
 *   - 工具桥：POST /api/tools/execute 让 CLI/外部系统以同一套工具契约调用平台
 *   - 首次启动种子数据（演示环境）
 */
import { join, dirname, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, createReadStream, readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange, Collection, RecordBase, CallerInfo } from '../../platform-core/src/index.ts'
import { createRestGate, lookupsFromHost, resolveUnifiedPrincipal, toCallerInfo, type UnifiedAuthMethod } from '../../platform-core/src/index.ts'
import { createPluginContext, newId, platformVersionInfo, PlatformEvents } from '../../platform-core/src/index.ts'
import type { VerifiedPrincipal } from '../../plugin-authn/src/index.ts'
import { demoPrincipal, isDemoMode, DEMO_PRINCIPAL_ID, DEMO_PRINCIPAL_NAME, DEMO_READONLY_PERMISSIONS, READONLY_METHODS } from './demo-mode.ts'
import { PermissionCatalog, type UserManageActor } from '../../plugin-iam/src/index.ts'
import { ProviderAuthError } from '../../plugin-iam/src/providers.ts'
import { normalizeLocale, readCatalogDir, DEFAULT_LOCALE, t } from '../../platform-i18n/src/index.ts'
import { AppRegistryService } from '../../plugin-app/src/index.ts'
import { seedAll } from './seed.ts'
import { registerMarketRoutes } from './routes/market.ts'
import { registerFinOpsRoutes } from './routes/finops.ts'
import { registerPlatformRoutes } from './routes/platform.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerDashboardRoutes } from './routes/dashboard.ts'
import { registerIamRoutes } from './routes/iam.ts'
import { registerAuthnRoutes } from './routes/authn.ts'
import { registerMcpRoutes } from './routes/mcp.ts'
import { registerMcpDataplaneRoutes } from './routes/mcp-dataplane.ts'
import { registerSkillRoutes } from './routes/skills.ts'
import { registerNasRoutes } from './routes/nas.ts'
import { registerAgentRoutes } from './routes/agents.ts'
import { registerEntryTicketRoutes } from './routes/entry-tickets.ts'
import { registerAppRoutes } from './routes/apps.ts'
import { registerAuditRoutes } from './routes/audit.ts'
import { registerOpsRoutes } from './routes/ops.ts'
import { registerUsageRoutes } from './routes/usage.ts'
import { registerFleetRoutes } from './routes/fleet.ts'
import { registerBridgeRoutes } from './routes/bridge.ts'

export const name = 'console'
export const inject = [
  'httpServer', 'opsStorage', 'platformBus', 'tools',
  'iam', 'authn', 'oidc', 'entryTickets', 'audit', 'usage', 'market', 'modelGateway',
  'mcpRegistry', 'nasRegistry', 'nasAuthz', 'nasShareLinks', 'skillHub', 'resourceCore', 'agentRegistry', 'appRegistry', 'appCredentials', 'update',
  'connectorHub',
  // 数字员工窄端口登记器（platform-core 首位装配即提供；实现由 plugin-workforce 后补登记，port() 缺席=legacy）
  'workforcePolicy',
]

// 公开路径白名单（免鉴权）：导出供 selftest「rbac endpoint matrix」比对——清单变动即红
export const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/sso',
  '/api/auth/sso/authorize',
  '/api/auth/sso/callback',
  '/api/auth/sso/bind',
  '/api/auth/sso/register',
  '/api/auth/refresh',
  '/api/auth/client-credentials',
  '/api/auth/providers',
  '/api/health',
  '/api/market/developers/register',
  '/api/market/developers/login',
  // 接入码本身即凭证（一次性 + TTL + 按 IP 失败锁定），enroll 端点公开
  '/api/connect/enroll',
  // 平台授权直达：一次性短时票据回平台换取身份（票据本身即临时凭证）
  '/api/authn/entry-tickets/redeem',
  // 委托令牌交换（MCP 治理契约 §3）：公开路径 + 自带 Bearer 校验（调用者令牌即授权事实）
  '/api/authn/token/exchange',
  // 应用访客埋点 beacon（浏览器侧 PV/UV 上报）：1x1 GIF/JSON 免鉴权；响应恒定不泄露应用存在性
  '/api/apps/beacon',
  // 票据免登控制台：redeem 通过后直接建立控制台会话（门户/钉钉「打开即工作台」，零二次登录）
  '/api/auth/entry-ticket-session',
  // 部门面板 SSE（review-dsh-agent-panel-v2 F13）：EventSource 无法携带 Bearer 头，
  // 端点公开但内部强制 ?token= 自校验（authn.verify，失败 fail-closed 401），降级轮询端点仍走 guarded
  '/api/panel/stream',
  // 面板自持登录面（交接 F 清单 N 节，2026-09-11）：panel 命名空间登录/刷新转发同一 authn 后端，
  // 全量形态曾被本中间件拦截为 401——宿主已登录用户在面板本页登录被迫「先登出」。
  // 白名单不放行任何数据（鉴权由 authn login/refresh 自身承担，口令错误仍 401）；
  // main 侧 panel 自持登录面路由尚未合入——先行登记（无路由时请求照常 404），合入后即闭环。
  '/api/panel/auth/login',
  '/api/panel/auth/refresh',
  // 演示态一键入场（DEMO_MODE=1 专用，2026-11-01）：种子演示账号的 ≤120s 一次性自助票，
  // 供 gate01.html 中转页免密直达 01门面板；处理器内部 isDemoMode 否决，非演示实例恒 404。
  // 口令语义 = 仓库公开的演示种子口令（seed.ts），不新增任何生产鉴权面。
  '/api/panel/auth/demo-entry',
  // 首启 bootstrap 提示（M2）：登录页「初始口令待接管」横幅数据源；只回一个布尔（见 routes/platform.ts 泄露评估）
  '/api/platform/bootstrap',
  // 演示态标记（DEMO_MODE=1，公开只回一个布尔 + 访客名）：前端据此显示「演示模式·只读」横幅
  // 并隐藏写操作按钮。不泄露任何业务数据——主体信息与 demo-mode.ts 常量一致。
  '/api/platform/demo',
])

/** 动态路径的公开前缀（OIDC 授权页查询：仅回显客户端名/scope，不泄露 redirect_uri）。
 *  执行中枢 webhook 触发器：路径即凭证（未登记/停用路径一律 404，fail-closed，见 plugin-exec-hub）。 */
const PUBLIC_PATH_PREFIXES = ['/api/authn/oidc/auth-requests/', '/api/exec/webhook/']

/**
 * 受众绑定委托令牌的「身份自省」白名单（P1-07）：这些端点以令牌自身身份链为客体的
 * 只读回显（act 链展示 / 数据范围身份读回），委托身份语义的事实消费面；GET-only。
 * 扩编须过安全评审——任何写面/资源面进入本清单即架空受众边界。
 */
const AUD_TOKEN_INTROSPECTION_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/me',
  '/api/nas/authz/scope',
])

/** /docs 公开白名单（默认拒绝，导出供 selftest 比对——清单变动即红）：
 *  仅收录面向外部读者的接入指引（「本文档随服务发布，可直接访问」系列）。
 *  目录内其余文档（部署 runbook、契约、以及 docs/internal/ 下的内部过程物料
 *  qa-report/handoff/dev-plan/release-notes/重构基线等）
 *  一律 404，改走仓库私有分发；扩编须经评审改此清单，宁紧勿松。 */
export const PUBLIC_DOCS = new Set([
  'app-onboarding.md',
  'agent-onboarding.md',
  'app-sso-integration.md',
  'app-org-sync.md',
  'app-rbac-guide.md',
])

/** 从请求头推导对外基址（钉钉等真实 IdP 的 redirect_uri 需绝对 URL；反代场景优先 x-forwarded-*）。 */
function requestOrigin(exchange: HttpExchange): string | undefined {
  const header = (name: string): string | undefined => {
    const value = exchange.headers[name]
    if (value === undefined) return undefined
    return String(Array.isArray(value) ? value[0] : value)
  }
  const host = header('x-forwarded-host') ?? header('host')
  if (!host) return undefined
  const proto = header('x-forwarded-proto') ?? 'http'
  return `${proto}://${host}`
}

/** 服务记录对外回显时脱敏认证类请求头（存储保留原文，仅展示层掩码）。 */
function maskServiceHeaders<T extends { headers?: Record<string, string> }>(service: T): T {
  if (!service.headers) return service
  const masked: Record<string, string> = {}
  for (const [key, value] of Object.entries(service.headers)) {
    masked[key] = /authorization|token|secret|key/i.test(key)
      ? (value.length > 8 ? `${value.slice(0, 6)}…` : '****')
      : value
  }
  return { ...service, headers: masked }
}

/** NAS 资产回显时脱敏网关访问令牌（存储保留原文，仅展示层掩码）。 */
export function apply(ctx: Context) {
  const http = ctx.httpServer
  const demo = isDemoMode()

  // -- 鉴权中间件 ---------------------------------------------------------
  // 统一 Principal 装配（MCP 治理契约 §2）：verify → resolveUnifiedPrincipal →
  // exchange.principal = CallerInfo 兼容超集 + unified 字段（旧消费者零感知，新消费面读 unified）。
  // 本中间件是 principal 的唯一权威写入点；反查接线：principalOf=authn.principals、
  // orgOf=iam 用户 / resourceCore 资源归属 + iam 租户解析。
  const principalLookups = lookupsFromHost({
    principalsGet: (id) => ctx.authn.principals().get(id),
    iamUserGet: (id) => ctx.iam.users().get(id),
    resourceGet: (kind, id) => ctx.resourceCore.get(kind, id) as { orgId?: string } | undefined,
    tenantOfOrg: (orgId) => ctx.iam.tenantOfOrg(orgId),
  })
  const assemblePrincipal = async (verified: VerifiedPrincipal, overrides?: { authMethod?: UnifiedAuthMethod }): Promise<CallerInfo> => {
    const unified = await resolveUnifiedPrincipal(verified, principalLookups, overrides)
    return { ...toCallerInfo(unified), unified } as unknown as CallerInfo
  }

  // 中间件为 async：统一 Principal 组装经 lookups 反查（await）；返回 true=已拦截，undefined=放行
  http.use(async (exchange) => {
    // 取流自校验通道：?ticket=（一次性/10 分钟票据）与 ?sig=（签名分享链接，exp/sub/jti/sig 四参）——
    // 两者都是「URL 即凭证」，免 Bearer 头；真实性在 GET /fs/file 处理器内逐关验证（fail-closed）
    const nasFileStream = /^\/api\/nas\/[^/]+\/fs\/file$/.test(exchange.path)
    const ticketDownload = nasFileStream && Boolean(exchange.query.get('ticket'))
    const signedLinkDownload = nasFileStream && Boolean(exchange.query.get('sig'))
    if (!exchange.path.startsWith('/api/') || PUBLIC_PATHS.has(exchange.path) || PUBLIC_PATH_PREFIXES.some((prefix) => exchange.path.startsWith(prefix)) || ticketDownload || signedLinkDownload) return
    const header = String(exchange.headers['authorization'] ?? '')

    // 演示只读态（DEMO_MODE=1）：只读闸门作用于全部请求——无 Bearer 注入固定只读主体；
    // 带 Bearer 的真实登录会话同样受限（见下方 Bearer 分支的权限交集收敛）。
    // 安全审查 P0-03（2026-10-31）：旧版只拦「无 Bearer」，演示种子账号（公开仓库含固定
    // 演示口令）仍可真实登录取得可写会话——现在写方法 405 对登录态一视同仁，种子口令即使
    // 泄露也只能得到与匿名访客相同的只读视图。
    if (demo) {
      // 纵深防御：写方法入口即拒。覆盖「路由漏声明权限点」这类遗漏面（第一道闸是权限集无写点）。
      if (!READONLY_METHODS.has(exchange.method.toUpperCase())) {
        exchange.fail(405, 'DEMO_READONLY', t('演示模式为只读，不支持写操作。请自行部署后体验完整功能。'))
        return true
      }
      if (!header) {
        // 演示态同样经统一 Principal 组装（authMethod='demo'）：unified 面与真实令牌同构，
        // 权限集仍为白名单 .read 枚举，后续 requirePermission 照常生效。
        const demoVerified = {
          principal: { id: DEMO_PRINCIPAL_ID, type: 'human' as const, refType: 'user' as const, refId: DEMO_PRINCIPAL_ID, name: DEMO_PRINCIPAL_NAME },
          token: { jti: DEMO_PRINCIPAL_ID, issuedBy: 'demo' },
          scopes: [...DEMO_READONLY_PERMISSIONS],
          actChain: [],
        }
        exchange.principal = await assemblePrincipal(demoVerified)
        return
      }
    }

    if (!header.startsWith('Bearer ')) {
      exchange.fail(401, 'UNAUTHORIZED', t('缺少 Bearer 令牌，请先登录'))
      return true
    }
    try {
      const verified = ctx.authn.verify(header.slice(7))
      // P1-07（安全审查 2026-10-31）：服务专用委托令牌（aud=mcp:service:<slug>/plugin:<id>）
      // 只允许触达「身份自省」白名单端点（GET，令牌以自身身份链为客体的只读回显）——面板/
      // dsh 的委托身份展示依赖该语义；其余控制台 /api 面（写面/管理面/资源面）一律 403，
      // 防「服务 A 的委托令牌用于服务 B 或当作平台会话」。MCP 数据面 /mcp/* 自行按服务
      // slug 强校验精确受众（mcp-dataplane assembleCaller）。
      if (verified.token.audience !== undefined) {
        const audAllowed = exchange.method.toUpperCase() === 'GET'
          && AUD_TOKEN_INTROSPECTION_PATHS.has(exchange.path)
        if (!audAllowed) {
          exchange.fail(403, 'TOKEN_AUDIENCE_MISMATCH', t('该令牌绑定了专用受众（{aud}），不能用于控制台通用接口；请使用登录会话令牌，或经对应服务端点调用', { aud: verified.token.audience }))
          return true
        }
      }
      const principal = await assemblePrincipal(verified)
      if (demo) {
        // P0-03：演示态登录用户的权限与其自身权限取交集，收敛到只读白名单——
        // '*'（种子管理员等）先展开为白名单全集（通配不参与交集），任何写类权限点被剥除，
        // 写面另有上方 405 闸门兜底。console.login 保留：登录级 GET 语义照常（其写类路由
        // ——反馈/自助票/工具执行——全部非 GET，同样被 405 闸门拦截）。
        const allow = new Set([...DEMO_READONLY_PERMISSIONS, 'console.login'])
        const expanded = principal.permissions.includes('*') ? [...allow] : principal.permissions
        const readonlyPermissions = expanded.filter((point) => allow.has(point))
        ;(principal as { permissions: readonly string[] }).permissions = readonlyPermissions
        if (principal.unified) (principal.unified as { permissions?: readonly string[] }).permissions = readonlyPermissions
      }
      exchange.principal = principal
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'TOKEN_INVALID', message)
      return true
    }
  })

  // R5 收敛：caller/requirePermission/guarded/body/changeLog 统一引 platform-core 共享实现（单点修复、单点审计）
  const { caller, requirePermission, guarded, body, changeLog } = createRestGate(ctx)

  // -- 委托授权事实钩子（MCP 治理契约 §3，console 装配时注入；缺省 fail-closed 拒绝）----------
  // 白名单通道：iam 管理员('*')直通；agent 目标/调用者凭证须与 subject 存在绑定（agentRegistry）；
  // app 目标/凭证须 subject 为应用 owner（resourceCore，与 routes/apps.ts assertAppOwner 同口径）。
  ctx.authn.setDelegationGuard((input) => {
    const callerPrincipal = ctx.authn.principals().get(input.caller.principalId)
    const callerScopes = callerPrincipal
      ? (callerPrincipal.type === 'human' ? ctx.iam.userPermissions(callerPrincipal.refId ?? '') : ctx.authn.resolveMachineScopes(callerPrincipal))
      : []
    if (callerScopes.includes('*')) return true
    // 自委托（机器调用者为自己换牌：sub=自身、act 链为空）：不引入他人身份，
    // 授权面由 authn 侧 scopes 三方交集夹紧到调用者自身实时权限，不构成提权 → 放行。
    if (!input.userId) return input.caller.kind === 'machine'
    if (input.caller.kind === 'machine') {
      // 机器凭证：仅可代「绑定本 agent 的真人 / 本 app owner」换取委托令牌
      if (input.caller.refType === 'agent' && input.caller.refId) {
        return ctx.agentRegistry.boundUsers(input.caller.refId).some((binding) => binding.userId === input.userId)
      }
      if (input.caller.refType === 'app' && input.caller.refId) {
        return ctx.resourceCore.get('app', input.caller.refId)?.ownerId === input.userId
      }
      return false
    }
    // 人类调用者：subject 缺省为本人；代他人换取仅 '*' 管理员通道放行（上方已返回）
    if (callerPrincipal?.type === 'human' && callerPrincipal.refId !== input.userId) return false
    if (!input.targetPrincipalId) return false
    const target = ctx.authn.principals().get(input.targetPrincipalId)
    if (target?.refType === 'agent' && target.refId) {
      return ctx.agentRegistry.boundUsers(target.refId).some((binding) => binding.userId === input.userId)
    }
    if (target?.refType === 'app' && target.refId) {
      return ctx.resourceCore.get('app', target.refId)?.ownerId === input.userId
    }
    return false
  })

  /**
   * SSO 管理守卫工厂（app/agent 两侧路由共用，授权口径统一在 AppRegistryService.ssoManageDecision）：
   * human = 资源 owner 或持 authn.oidc.write；机器身份绑定本资源（凭证 refType/refId 或登记 owner）
   * 时可自助签发/管理，但本次生效的回调集必须全为环回（localhost / 127.0.0.0/8 / ::1 / 0.0.0.0，
   * APP_SSO_MACHINE_LOOPBACK=0 可整体关闭该例外）；disable 纯降险恒放行。
   * 返回 false 表示已回 403（并发 audit.authz.denied 事件）。
   */
  const ssoManageGuard = (refType: 'app' | 'agent') => {
    const resourceOf = (exchange: HttpExchange): { id: string; name: string; ownerId: string } => {
      const record = ctx.resourceCore.get(refType, exchange.params['id']!) as { id: string; name: string; ownerId: string } | undefined
      if (!record) throw new Error(refType === 'app' ? t('应用不存在：{id}', { id: exchange.params['id'] }) : t('Agent 不存在：{id}', { id: exchange.params['id'] }))
      return { id: record.id, name: record.name, ownerId: record.ownerId }
    }
    const existingClientOf = (id: string): { redirectUris?: string[]; postLogoutUris?: string[] } | undefined =>
      refType === 'app' ? ctx.oidc.clientsForApp(id)[0] : ctx.oidc.clientsForAgent(id)[0]
    return (exchange: HttpExchange, op: 'create' | 'update' | 'rotate' | 'enable' | 'disable', input?: { redirectUris?: string[]; postLogoutUris?: string[] }): boolean => {
      const resource = resourceOf(exchange)
      const info = caller(exchange)
      const existing = existingClientOf(resource.id)
      const decision = AppRegistryService.ssoManageDecision(resource, info, {
        redirectUris: input?.redirectUris ?? existing?.redirectUris ?? [],
        postLogoutUris: input?.postLogoutUris ?? existing?.postLogoutUris ?? [],
      }, op)
      if (decision.allowed) return true
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info.userId ?? info.principalId,
        actorName: info.name,
        point: `${refType}.sso(owner:${resource.id})`,
        path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', decision.reason)
      return false
    }
  }
  const agentSsoGuard = ssoManageGuard('agent')
  const appSsoGuard = ssoManageGuard('app')

  // -- 资源限定 scope 的服务存在性校验端口（W3-T5 契约 §12） ------------------
  // 机器凭证附加 scope 形如 mcp.service:<slug>.invoke / mcp.tool:<slug>:<tool>.invoke：
  // 端口接线后，签发期即拒「指向不存在服务」的错配 scope（此前只校验形态）。
  ctx.authn.setMcpServiceExistsCheck((slug: string) => {
    try {
      return ctx.mcpRegistry.services().all().some((service) => service.slug === slug)
    } catch {
      return true // 端口不可用时 fail-open：形态校验已在签发侧生效
    }
  })

  // -- 拓扑节点名称补全（skill 等非 resource-core 类型） ----------------------
  // W2 能力绑定补边 {app→mcp, kind:'capability'} 后，依赖图出现 type='mcp' 的裸节点
  // （resource-core 未注册该类型 → name=id / status=unknown），与 mcp_service 同源补全。
  // W4 交付审计：契约承诺「App → Agent → MCP 穿透」——agent→mcp 边由「权限组授予」派生
  // （授权事实在 MCP 权限组，非 resource-core 依赖边），故在装配层按权限组合成子节点。
  const MCP_STATUS_LABELS: Record<string, string> = {
    online: '在线', gray: '灰度发布', offline: '已下线', draft: '草稿', verifying: '验证中', unhealthy: '异常',
  }
  const agentCapabilityChildren = (agentId: string): any[] => {
    try {
      const children: any[] = []
      const seen = new Set<string>()
      for (const group of ctx.mcpRegistry.permGroups().all()) {
        const granted = (group.subjects ?? []).some((subject) => subject.type === 'agent' && subject.id === agentId)
        if (!granted) continue
        for (const serviceId of Object.keys(group.policies ?? {})) {
          if (seen.has(serviceId)) continue
          seen.add(serviceId)
          const service = ctx.mcpRegistry.services().get(serviceId)
          children.push({
            type: 'mcp',
            id: serviceId,
            name: service?.name ?? serviceId,
            status: service?.status ?? 'unknown',
            statusLabel: MCP_STATUS_LABELS[service?.status ?? ''] ?? t('外部节点'),
            children: [],
            edge: 'grant',
            grantName: group.name,
          })
        }
      }
      return children
    } catch {
      return []
    }
  }
  const enrichTopology = (node: any): any => ({
    ...node,
    name: node.type === 'skill'
      ? ctx.skillHub.skills().get(node.id)?.name ?? node.name
      : node.type === 'mcp_service' || node.type === 'mcp'
        ? ctx.mcpRegistry.services().get(node.id)?.name ?? node.name
        : node.name,
    status: node.type === 'skill'
      ? ctx.skillHub.skills().get(node.id)?.status ?? node.status
      : node.type === 'mcp'
        ? ctx.mcpRegistry.services().get(node.id)?.status ?? node.status
        : node.status,
    statusLabel: node.type === 'mcp'
      ? MCP_STATUS_LABELS[ctx.mcpRegistry.services().get(node.id)?.status ?? ''] ?? node.statusLabel
      : node.statusLabel,
    children: [
      ...node.children.map(enrichTopology),
      ...(node.type === 'agent' ? agentCapabilityChildren(node.id) : []),
    ],
  })


  registerAuthRoutes(ctx, { http, guarded, body, changeLog, caller, requestOrigin })
  registerDashboardRoutes(ctx, { http, guarded, body, changeLog, caller })

  registerIamRoutes(ctx, { http, guarded, body, changeLog, caller })

  registerAuthnRoutes(ctx, { http, guarded, body, changeLog, caller })

  registerMcpRoutes(ctx, { http, guarded, body, changeLog, caller, maskServiceHeaders })

  registerSkillRoutes(ctx, { http, guarded, body, changeLog, caller })
  registerNasRoutes(ctx, { http, guarded, body, changeLog, caller, requirePermission, requestOrigin })
  registerAgentRoutes(ctx, { http, guarded, body, changeLog, caller, requestOrigin, enrichTopology })
  registerEntryTicketRoutes(ctx, { http, guarded, body, changeLog, caller, agentSsoGuard })
  registerAppRoutes(ctx, { http, guarded, body, changeLog, caller, requestOrigin, enrichTopology, appSsoGuard })
  registerAuditRoutes(ctx, { http, guarded, body, changeLog, caller })
  registerOpsRoutes(ctx, { http, guarded, body, changeLog, caller })
  registerUsageRoutes(ctx, { http, guarded, body, changeLog, caller })

  // -- Fleet 六类资产统一台账（设计适配规格 5.2，2026-10-14） --------------------
  registerFleetRoutes(ctx, { http, guarded, body, changeLog, caller })
  registerBridgeRoutes(ctx, { http, guarded, body, changeLog, caller })

  // -- MCP 服务级数据面（W2-T3 契约 §7/§8）：POST /mcp/services/:slug（+/mcp/s/:id 别名），
  //    自管 Bearer 认证 + aud 强校验 + authorizedToolsFor 工具过滤，经 ctx.mcpRegistry.invoke 全链
  registerMcpDataplaneRoutes(ctx, { http })

  // -- 第三方插件市场（v1.2）：已迁移 routes/market.ts（OPT-P1-01 首段） ------
  registerMarketRoutes(ctx, { http, guarded, body, changeLog, caller })

  // -- FinOps CFO 视图（M2）：routes/finops.ts（新模式：新路由不再进 apply()） ------
  registerFinOpsRoutes(ctx, { guarded })

  // -- 平台级路由（M2 筑基）：routes/platform.ts（首启 bootstrap 状态） ------
  registerPlatformRoutes(ctx, { http })

  // -- 演示态标记（DEMO_MODE=1）--------------------------------------------
  // 只回模式开关 + 访客名 + 只读权限清单：前端据此显示「演示模式·只读」横幅并隐藏写操作。
  // 非演示态返回 { demo: false }，前端按正常登录态走——同一份前端代码兼容两种形态。
  http.register('GET', '/api/platform/demo', (exchange) => {
    exchange.ok({
      demo,
      ...(demo ? {
        principalId: DEMO_PRINCIPAL_ID,
        name: demoPrincipal().name,
        readonlyPermissions: [...DEMO_READONLY_PERMISSIONS],
      } : {}),
    })
  }, { access: 'public' })

  // -- 静态 SPA -----------------------------------------------------------
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
  if (existsSync(publicDir)) {
    http.serveStatic('/', publicDir, '/index.html')
  }

  // -- UI 全球化（2026-10-16）：/locales/:locale 词典合并端点 -----------------
  // 两层词典一次取齐（前端 i18n.js 单请求加载）：服务端文案（platform-i18n/locales，
  // 覆盖 API 错误消息/通知/审批文案——SPA 展示服务端错误时同样走前端词典翻译）
  // + 控制台 SPA 词典（public/locales/<locale>/*.json）。多文件按文件名序浅合并，
  // 多团队并行维护互不覆盖；企业定制走 I18N_EXTRA_DIR（platform-i18n 内核已并）。
  // 面板 SPA 词典层已随 2026-10-29 面板架构统一摘除（收编 DeptAI-UI-DSH 面板轨实现，
  // 其 IAW 工作台为零词典中文直出 SPA，不再提供 plugin-panel-core/public/locales 目录）。
  // 非 /api 路径：鉴权中间件天然放行（词典为静态文案，不含任何业务数据）。
  const packagesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  http.register('GET', '/locales/:locale', (exchange) => {
    const locale = normalizeLocale(exchange.params['locale']) ?? DEFAULT_LOCALE
    const merged: Record<string, string> = {
      ...readCatalogDir(join(packagesRoot, 'platform-i18n', 'locales', locale)),
      ...readCatalogDir(join(packagesRoot, 'plugin-console', 'public', 'locales', locale)),
    }
    exchange.res.setHeader('cache-control', 'no-cache')
    exchange.ok({ locale, count: Object.keys(merged).length, catalog: merged })
  })

  // -- /docs 文档发布（默认拒绝白名单，见 PUBLIC_DOCS）：仅白名单内文档随服务可直接访问 ----
  // 源码检出与 dsh plugin add 两种形态下本文件均位于 <root>/packages/plugin-console/src/，
  // docs 目录恒为 <root>/docs。本路由面为纯匿名静态服务（鉴权中间件只覆盖 /api/*），
  // 不存在按登录身份放行的上下文——白名单外一律 404（不用 403，避免存在性探测），
  // 内部文档改走仓库私有分发。白名单收在代码常量而非 docs/ 旁 manifest：manifest 本身就在
  // 伺服目录内，可读即反向泄露内部文档清单；常量则随代码评审走查、diff 可审计。
  const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs')
  if (existsSync(docsDir)) {
    // 拦截全部 /docs/* 子路径（先于路由与静态分发）：仅放行白名单内的单文件名。
    // 白名单键即文件名字面量（不含路径分隔符），故 %2F/.. 等任何越界或畸形编码形态
    // 都落不进集合，天然无穿越面（强度不低于原按段解码+拒绝越界段的目录伺服实现）。
    http.use((exchange) => {
      if (!exchange.path.startsWith('/docs/')) return
      let name = ''
      try {
        name = decodeURIComponent(exchange.path.slice('/docs/'.length))
      } catch { /* 畸形编码按白名单外处理 */ }
      if (!PUBLIC_DOCS.has(name)) {
        exchange.fail(404, 'NOT_FOUND', t('文档不存在'))
        return true
      }
      exchange.file(join(docsDir, name))
      return true
    })
    http.register('GET', '/docs', (exchange) => {
      const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)
      const files = readdirSync(docsDir).filter((name) => PUBLIC_DOCS.has(name)).sort()
      const items = files.map((name) => {
        const hint = name === 'app-onboarding.md' ? t('（AI 应用接入总览）')
          : name === 'agent-onboarding.md' ? t('（Agent 接入指引）')
          : name === 'app-sso-integration.md' ? t('（应用统一身份接入指南）')
          : name === 'app-org-sync.md' ? t('（应用组织架构同步指南）')
          : name === 'app-rbac-guide.md' ? t('（应用内权限（RBAC）构造指南）') : ''
        return `<li><a href="/docs/${encodeURIComponent(name)}">${escapeHtml(name)}</a>${hint}</li>`
      }).join('')
      exchange.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      exchange.res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t('元冰可 · 平台文档')}</title><style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#1f2328}h1{font-size:20px}li{margin:8px 0;font-size:14px}a{color:#2563eb}</style></head><body><h1>${t('元冰可 · 平台文档')}</h1><p>${t('以下对外文档随本服务发布，可直接打开阅读：')}</p><ul>${items}</ul></body></html>`)
    })
  }

  // -- 种子数据 -----------------------------------------------------------
  void seedAll(ctx)
}




/** 事件摘要用字段标签（按信息量排序，命中即拼入人话摘要；未列出的内部字段不外显）。 */
const EVENT_FIELD_LABELS: Array<[string, string]> = [
  ['title', '标题'], ['name', '名称'], ['displayName', '姓名'], ['reason', '原因'], ['message', '信息'],
  ['error', '错误'], ['actorName', '操作人'], ['username', '用户名'], ['userId', '账号'], ['version', '版本'],
  ['service', '服务'], ['actionId', '动作'], ['provider', '平台'], ['alias', '连接'], ['baseUrl', '网关地址'],
  ['status', '状态'], ['result', '结果'], ['kind', '类型'],
]
/** 摘要中常见英文枚举值的中文转译（测试 UI-03：事件流不留裸英文码）。 */
const EVENT_VALUE_LABELS: Record<string, string> = {
  created: '创建', updated: '更新', deleted: '删除', approved: '通过', rejected: '驳回',
  healthy: '健康', unavailable: '不可用', ok: '成功', failed: '失败', catalog: '目录',
}

/** 事件流人话摘要（测试 UI-03）：优先取业务字段拼「标签：值」句，绝不回退裸 JSON——原始 payload 走 detail 字段收进「详情」。
 *  标签/枚举值常量为中文数据（t() 的键），展示边界在拼接处按请求语言即时翻译。 */
function summarize(payload: unknown): string {
  if (payload === null || payload === undefined) return ''
  if (typeof payload !== 'object') return String(payload).slice(0, 120)
  const record = payload as Record<string, unknown>
  const bits: string[] = []
  for (const [key, label] of EVENT_FIELD_LABELS) {
    const value = record[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
    const text = String(value)
    bits.push(t('{label}：{value}', { label: t(label), value: EVENT_VALUE_LABELS[text] !== undefined ? t(EVENT_VALUE_LABELS[text]) : text.slice(0, 80) }))
    if (bits.length >= 3) break
  }
  return bits.join(t('；'))
}

/** 原始 payload 压缩串（仅用于「详情」折叠展示，防止误读也保留排查线索）。 */
function summarizeDetail(payload: unknown): string | undefined {
  if (payload === null || payload === undefined || typeof payload !== 'object') return undefined
  const json = JSON.stringify(payload)
  if (!json || json === '{}') return undefined
  return json.slice(0, 400)
}

