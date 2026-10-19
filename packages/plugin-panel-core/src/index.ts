/**
 * @ybkk/plugin-panel-core —— 部门 Agent 工作台面板（review-dsh-agent-panel-v2 Phase 1/2）。
 *
 * 职责：
 *   - 静态托管面板 SPA（/panel，对外经 dsh-bridge 即 /gate01/panel/；宿主 web diff=0 铁律）
 *   - /api/panel/* REST（guarded + 权限点；自注册路由推入 httpServer.routeMatrix 共享登记处，
 *     保住 selftest 的 RBAC 100% 越权断言网——Phase 0 补欠账）
 *   - SSE /api/panel/stream（EventSource 无法带 Bearer → 端点公开 + 内部 ?token= 自校验 fail-closed；
 *     降级轮询 GET /api/panel/:dept/poll——钉钉 webview 30s 轮询兜底铁律）
 *   - 行业激活审批执行器（audit approvals：申请→审批→置 active+grantCapabilities；license 签发链路 Phase 4）
 *   - 模型目录面（GET/POST/DELETE /api/panel/models + :slug/test 连通性测试）：与 dsh 服务共用
 *     modelgw 唯一事实源；协作会话对话框经 messages 的 model 参数切换模型（panelAgentRuntime 优先取用）
 *   - panel_* 工具族（注册共享 tools 键，dsh 下即原生 ToolRuntime 可被模型调用）
 *   - 种子：基线=五部门骨架配置+内置行业激活；DEMO_SEED=1 追加演示会话/任务/知识/看板
 */
import { join, dirname } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../platform-core/src/index.ts'
import { PlatformEvents } from '../../platform-core/src/bus.ts'
import { newId } from '../../platform-core/src/ids.ts'
import { PanelService, TASK_LANES, type TaskLane, type DeptWidget, type DeptKpi, type DeptAgent } from './service.ts'
import { CardpackService, CARD_PLATFORMS, filterCards, type CardPlatform } from './cardpacks.ts'
export { CardpackService, CARD_PLATFORMS, filterCards } from './cardpacks.ts'
import { seedPanel, DEMO_ORG_ID } from './seed/seed.ts'
import { resolvePanelModelGateway } from './llm-bridge.ts'
import { DwsCli } from './dws.ts'
import { applyMfgModule } from './mfg/module.ts'

export const name = 'panel-core'
// plan-gate01 Phase 2 瘦身：硬依赖只保留数据面基座 5 键（platform-core / dsh 原生提供）。
// 其余 9 键（iam/authn/audit/usage/modelGateway/resourceCore/behavior/mcpRegistry/skillHub）
// 走 soft() 软读降级——cordis 的 inject 是加载前硬依赖（缺提供者=永久挂起，spike 定稿），
// 声明即要求提供者在场；01门装态无宿主面包，这些键必须能缺席。
// 注意：panel 服务不可自 inject（自依赖=永久挂起）——内部直接 new PanelService(ctx) 使用。
export const inject = [
  'httpServer', 'opsStorage', 'platformBus', 'tools', 'scenegraphs',
]

/** panel-core 装配配置。 */
export interface PanelConfig {
  /**
   * 演示鉴权开关（fail-closed，缺省 false=严格鉴权）：仅 cordis.patch.yml 的 01门 4-entry
   * 装配声明 true——放行只读动词（GET/HEAD/OPTIONS）以演示访客身份读内置演示数据，
   * 写动词一律 403；全量形态（cordis.yml / boot-all）永不声明，走 console 中间件严格鉴权。
   * 严禁运行时探测 authn 是否在场来放行——那会把「全量形态中间件未覆盖」误判为演示态（fail-open）。
   */
  demoAuth?: boolean
  /**
   * 着陆归一开关（缺省 false）：仅 01门 装态（cordis.patch.yml）声明 true——装配无 console，
   * 根路径没有控制台可落，SPA 兜底会把控制台缺失的壳页发给浏览器（相对资源 404 回落 HTML →
   * module MIME 错误白屏）。声明后 GET / 302 到 ${externalBase}/panel/；全量形态永不声明，
   * 根路径着陆归 console（行为不变）。
   */
  landingRedirect?: boolean
}

/** 演示访客身份（只读权限点：面板读 + 场景图谱读）。 */
const DEMO_PRINCIPAL = {
  kind: 'human' as const,
  principalId: 'demo-visitor',
  name: '演示访客',
  permissions: ['panel.read', 'scenegraph.read'],
  actChain: [],
}

/** 可选宿主服务软读（与 PanelService.soft 同规；模块级供路由面使用）。 */
const soft = (ctx: Context, key: string): any => ctx.reflect.get(key, false)

interface CallerInfo {
  kind: 'human' | 'machine'
  principalId: string
  userId?: string
  name: string
  permissions: string[]
  actChain: Array<{ name: string; type: string }>
}

const DEPT_RE = /^[a-z]{2,12}$/

export function apply(ctx: Context, config: PanelConfig = {}) {
  const demoAuth = config.demoAuth === true
  const http = ctx.httpServer
  ctx.plugin(PanelService)
  // 卡片包服务（双轨迁移自 platform-core 装配）：面板是看板/卡片包域唯一消费方与宿主（不可自 inject，同 PanelService 惯例）
  ctx.plugin(CardpackService)
  const cardpacks = new CardpackService(ctx)
  const panel = new PanelService(ctx)

  const caller = (exchange: HttpExchange): CallerInfo => exchange.principal as CallerInfo

  // 与 console 同款 requirePermission：缺权限 403 + audit.authz.denied 留痕（RBAC 探针的判定面）。
  // 三道前置（plan-gate01 Phase 2.2 + 2026-09-11 写通道打通）：
  //   1. Bearer 自校验——鉴权中间件住在 plugin-console（01门 4+2 entry 装态无 console），
  //      面板对自带 Bearer 的请求经 authn.verify 自行建立 principal（与 SSE ?token= 通道同规）；
  //      出示了令牌但校验失败 → 干净 401，绝不降级为演示访客（fail-closed）；
  //   2. 严格态 principal 兜底——无凭证且非演示态 → 401；
  //   3. demoAuth（缺省 false）演示放行——仅「无有效 principal」时介入：只读动词以演示身份
  //      渲染内置演示数据，写动词 403；已登录（有 principal）用户不受只读限制。该开关只由
  //      01门 patch 装配声明，全量形态永不声明。
  const requirePermission = (exchange: HttpExchange, point: string): boolean => {
    if (!exchange.principal) {
      const header = String(exchange.headers['authorization'] ?? '')
      if (header.startsWith('Bearer ')) {
        const authn = soft(ctx, 'authn')
        if (!authn) {
          exchange.fail(401, 'UNAUTHENTICATED', '认证中心未接入，无法校验所出示的令牌')
          return false
        }
        try {
          const verified = authn.verify(header.slice(7))
          exchange.principal = {
            kind: verified.principal.type,
            principalId: verified.principal.id,
            ...(verified.principal.type === 'human' && verified.principal.refId ? { userId: verified.principal.refId } : {}),
            ...(verified.principal.type === 'machine' ? { refType: verified.principal.refType, refId: verified.principal.refId } : {}),
            name: verified.principal.name,
            permissions: verified.scopes,
            actChain: verified.actChain,
          }
        } catch (error) {
          exchange.fail(401, 'TOKEN_INVALID', `令牌无效：${error instanceof Error ? error.message : String(error)}`)
          return false
        }
      }
    }
    if (demoAuth && !exchange.principal) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(exchange.method.toUpperCase())) {
        exchange.fail(403, 'DEMO_READONLY', '演示数据只读：连接宿主并登录后解锁写操作')
        return false
      }
      exchange.principal = DEMO_PRINCIPAL
    } else if (!exchange.principal) {
      exchange.fail(401, 'UNAUTHENTICATED', '未认证：请先登录（鉴权中间件未覆盖该请求）')
      return false
    }
    const info = caller(exchange)
    if (info.permissions.includes('*') || info.permissions.includes(point)) return true
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point,
      path: exchange.path,
    })
    exchange.fail(403, 'FORBIDDEN', `缺少权限点 ${point}，请联系管理员调整角色`, { permission: point })
    return false
  }

  /** 能力型可选服务缺席（演示态）的端点级诚实降级：503 DEGRADED（非 500、非静默空数据）。 */
  const degraded = (exchange: HttpExchange, capability: string): null => {
    exchange.fail(503, 'DEGRADED', `「${capability}」能力未接入（01门演示态）——连接宿主后可用`)
    return null
  }

  const guarded = (method: string, path: string, permission: string, handler: (exchange: HttpExchange) => unknown | Promise<unknown>): void => {
    // H5：声明经 http.register 自动汇入 routeMatrix 共享登记处（注册期缺声明即抛错）
    http.register(method, path, async (exchange) => {
      if (!requirePermission(exchange, permission)) return
      try {
        const result = await handler(exchange)
        if (!exchange.res.writableEnded) {
          // 演示态标记（plan-gate01 Phase 4）：仅「确以演示访客身份放行」的只读响应带 demo:true——
          // 已登录用户读到的是真实数据，不再误标（2026-09-11 写通道打通配套语义收紧）
          const isDemoPrincipal = caller(exchange)?.principalId === DEMO_PRINCIPAL.principalId
          const demoMarked = demoAuth && isDemoPrincipal && result !== null && typeof result === 'object' && !Array.isArray(result)
            ? { ...result, demo: true }
            : result
          exchange.ok(demoMarked)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        exchange.fail(400, 'BAD_REQUEST', message)
      }
    }, { access: 'guarded', permission })
  }

  const body = <T extends Record<string, any>>(exchange: HttpExchange): T => (exchange.body ?? {}) as T
  const changeLog = (exchange: HttpExchange, action: string, resourceType: string, resourceId: string, resourceName: string, detail = ''): void => {
    const info = caller(exchange)
    // 审计中心缺席（01门演示态）→ 空记录（null-object 降级）：操作本身照常执行
    soft(ctx, 'audit')?.record({
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

  /** 部门参数解析 + 归属校验（部门范围权限：绑定组织后仅组织子树/管理员/机器凭证可访问）。 */
  const deptOf = (exchange: HttpExchange) => {
    const dept = String(exchange.params.dept ?? '')
    if (!DEPT_RE.test(dept)) throw new Error(`部门标识非法：${dept}`)
    const config = panel.dept(dept)
    if (!panel.deptScopeAllowed(caller(exchange), config)) {
      exchange.fail(403, 'FORBIDDEN', `部门范围受限：${config.label} 已绑定组织治理，仅该组织子树成员可访问`, { permission: 'panel.read', deptScope: config.orgId })
      throw new Error('部门范围受限')
    }
    return config
  }

  const orgIdOf = (exchange: HttpExchange): string => {
    const info = caller(exchange)
    const iam = soft(ctx, 'iam')
    return (info.userId ? iam?.users().get(info.userId)?.orgId : undefined)
      ?? iam?.orgs().find((org) => org.parentId === null).at(0)?.id
      // 组织目录缺席（01门 装态）→ 演示组织主键（与 seed.ts 的内置激活登记同值，行业面可用）
      ?? DEMO_ORG_ID
  }

  // -- 部门与总览 -------------------------------------------------------------

  guarded('GET', '/api/panel/depts', 'panel.read', (exchange) => {
    const info = caller(exchange)
    return {
      depts: panel.deptConfigs().all().map((dept) => ({
        ...dept,
        allowed: panel.deptScopeAllowed(info, dept),
        org: panel.deptOrg(dept),
      })),
    }
  })

  // 组织树（配置抽屉的部门↔组织绑定选择器；最小字段，panel.config.write 管理面）
  guarded('GET', '/api/panel/orgs', 'panel.config.write', (exchange) => {
    const iam = soft(ctx, 'iam')
    if (!iam) return degraded(exchange, '组织目录')
    return { orgs: iam.orgs().all().map((org) => ({ id: org.id, name: org.name, parentId: org.parentId })) }
  })

  /** 部门↔组织绑定（账号组织打通的管理动作）：设置后部门范围权限即刻生效。 */
  guarded('PUT', '/api/panel/:dept/config', 'panel.config.write', (exchange) => {
    const iam = soft(ctx, 'iam')
    if (!iam) return degraded(exchange, '组织目录')
    const dept = panel.dept(String(exchange.params.dept ?? ''))
    const input = body<{ orgId?: string | null }>(exchange)
    if (input.orgId !== undefined && input.orgId !== null && input.orgId !== '') {
      if (!iam.orgs().get(input.orgId)) throw new Error(`组织不存在：${input.orgId}`)
      ctx.panel.deptConfigs().update(dept.id, { orgId: input.orgId })
    } else {
      ctx.panel.deptConfigs().update(dept.id, { orgId: undefined })
    }
    const updated = panel.dept(dept.id)
    changeLog(exchange, 'panel.dept.bind_org', 'panel_dept', dept.id, dept.label, updated.orgId ?? '（解除绑定）')
    return { dept: { ...updated, org: panel.deptOrg(updated) } }
  })

  guarded('GET', '/api/panel/:dept/overview', 'panel.read', (exchange) => {
    const dept = deptOf(exchange)
    const info = caller(exchange)
    const orgId = orgIdOf(exchange)
    const channels = panel.channels().find((item) => item.dept === dept.id).map((channel) => ({
      ...channel,
      unread: info.userId ? panel.unreadCount(info.userId, channel.id) : 0,
    }))
    return {
      dept,
      org: panel.deptOrg(dept),
      members: panel.deptMembers(dept),
      industry: panel.activeIndustry(orgId),
      channels,
      agents: dept.agents.map((agent) => panel.agentWithAsset(agent)),
      kpis: dept.kpis,
      widgets: panel.board(dept),
      pendingActivations: soft(ctx, 'audit')?.approvals().find((item) => item.kind === 'industry.activation' && item.status === 'pending')
        .map((item) => ({ id: item.id, code: String(item.payload.code ?? ''), orgId: String(item.payload.orgId ?? '') }))
        .filter((item) => !orgId || item.orgId === orgId) ?? [],
    }
  })

  guarded('GET', '/api/panel/:dept/board', 'panel.read', (exchange) => ({
    dept: deptOf(exchange).id,
    widgets: panel.board(deptOf(exchange)),
  }))

  // -- 配置抽屉（widget / KPI / Agent 阵容） ------------------------------------

  guarded('GET', '/api/panel/:dept/widgets', 'panel.read', (exchange) => ({ widgets: deptOf(exchange).widgets }))

  guarded('PUT', '/api/panel/:dept/widgets', 'panel.config.write', (exchange) => {
    const dept = deptOf(exchange)
    const widgets = body<{ widgets?: DeptWidget[] }>(exchange).widgets
    if (!Array.isArray(widgets)) throw new Error('body.widgets 必须是数组')
    for (const widget of widgets) {
      if (!widget.id || !widget.type || !widget.title) throw new Error('widget 必须包含 id/type/title')
      if (!['bars', 'funnel', 'alerts', 'todos', 'feeds'].includes(widget.type)) throw new Error(`widget.type 非法：${widget.type}`)
      if (!['manual', 'mock', 'connector', 'mcp'].includes(widget.source)) throw new Error(`widget.source 非法（来源徽标必填）：${widget.source}`)
    }
    ctx.panel.deptConfigs().update(dept.id, { widgets })
    changeLog(exchange, 'panel.widget.layout', 'panel_dept', dept.id, dept.label, `${widgets.length} 块 widget`)
    return { widgets }
  })

  guarded('GET', '/api/panel/:dept/kpis', 'panel.read', (exchange) => ({ kpis: deptOf(exchange).kpis }))

  guarded('PUT', '/api/panel/:dept/kpis', 'panel.config.write', (exchange) => {
    const dept = deptOf(exchange)
    const kpis = body<{ kpis?: DeptKpi[] }>(exchange).kpis
    if (!Array.isArray(kpis)) throw new Error('body.kpis 必须是数组')
    for (const kpi of kpis) {
      if (!kpi.label || kpi.value === undefined) throw new Error('kpi 必须包含 label/value')
      if (!['manual', 'mock', 'connector'].includes(kpi.source)) throw new Error(`kpi.source 非法（来源徽标必填）：${kpi.source}`)
    }
    ctx.panel.deptConfigs().update(dept.id, { kpis })
    changeLog(exchange, 'panel.kpi.layout', 'panel_dept', dept.id, dept.label, `${kpis.length} 个 KPI`)
    return { kpis }
  })

  guarded('PUT', '/api/panel/:dept/agents', 'panel.config.write', (exchange) => {
    const dept = deptOf(exchange)
    const agents = body<{ agents?: DeptAgent[] }>(exchange).agents
    if (!Array.isArray(agents) || agents.length === 0) throw new Error('body.agents 必须是非空数组')
    for (const agent of agents) {
      if (!agent.name || !agent.icon) throw new Error('agent 必须包含 name/icon')
      if (agent.agentRef && !/^agent:[A-Za-z0-9._-]+$/.test(agent.agentRef)) throw new Error(`agentRef 格式非法（agent:<idOrSlug>）：${agent.agentRef}`)
    }
    ctx.panel.deptConfigs().update(dept.id, { agents })
    changeLog(exchange, 'panel.agent.roster', 'panel_dept', dept.id, dept.label, `${agents.length} 个 Agent 阵容位`)
    return { agents }
  })

  // -- 模型目录（modelgw 事实源优先；01门 dsh 装态落 dsh 模型桥——目录随 dsh 配置只读同源） ------

  /** 模型网关解析：modelgw 在场优先，缺席时 dsh llm 在场即落桥（llm-bridge.ts），两者皆无 → undefined。 */
  const modelGateway = () => resolvePanelModelGateway(ctx)

  /** 目录读取（面板视角）：apiKey 脱敏回显（env: 引用原样展示，直填密钥打码），与 console 同口径。 */
  const maskedModel = (model: { apiKey: string } & Record<string, unknown>) => ({
    ...model,
    apiKey: model.apiKey.startsWith('env:') ? model.apiKey : '***',
  })

  guarded('GET', '/api/panel/models', 'panel.read', async (exchange) => {
    const resolved = modelGateway()
    if (!resolved) return degraded(exchange, '模型网关')
    if (resolved.kind === 'dsh') {
      // dsh 桥目录：惰性发现（provider 路由枚举是异步的），default 跟随 dsh 默认模型置顶
      const models = await resolved.gateway.ensureCatalog()
      return { models: models.map(maskedModel), source: 'dsh' }
    }
    return { models: resolved.gateway.models().all().map(maskedModel), source: 'modelgw' }
  })

  guarded('POST', '/api/panel/models', 'panel.config.write', (exchange) => {
    const resolved = modelGateway()
    if (!resolved) return degraded(exchange, '模型网关')
    if (resolved.kind === 'dsh') {
      exchange.fail(400, 'MODEL_READONLY', '模型目录由 dsh 配置托管（settings.yaml agent-default-model / llm 适配器）——01门面板只读，请在 dsh 侧增删改模型')
      return
    }
    const gateway = resolved.gateway
    const input = body<{ slug?: string; displayName?: string; provider?: string; endpoint?: string; apiKey?: string; listCentsPerKTokens?: number; costCentsPerKTokens?: number; status?: string; dataClassLimit?: string }>(exchange)
    const slug = input.slug?.trim() ?? ''
    if (!slug) throw new Error('模型 slug 必填（如 deepseek-chat）')
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(slug)) throw new Error(`slug 仅允许字母/数字/._-（2-64 位）：${slug}`)
    if (!input.endpoint?.trim()) throw new Error('endpoint 必填（OpenAI 兼容基址；未配置不可调用，绝不造假回复）')
    if (!Number.isFinite(input.listCentsPerKTokens) || (input.listCentsPerKTokens ?? -1) < 0) throw new Error('listCentsPerKTokens 必须是非负数（挂牌价，分/千 tokens）')
    const status = input.status === 'offline' ? 'offline' as const : 'online' as const
    // 数据分级上限（IAW 交接 1-1）：公开/内部/秘密，缺省 internal（存量登记兼容）
    const dataClassLimit = input.dataClassLimit === 'public' || input.dataClassLimit === 'internal' || input.dataClassLimit === 'secret'
      ? input.dataClassLimit as 'public' | 'internal' | 'secret'
      : 'internal' as const
    // 编辑时密钥留空 = 保持既有密钥（表单不回填密钥的约定），不得覆盖为默认引用
    const existing = gateway.models().findOne((item) => item.slug === slug)
    const model = gateway.upsertModel({
      slug,
      displayName: input.displayName?.trim() || slug,
      provider: input.provider?.trim() || 'external',
      endpoint: input.endpoint.trim(),
      apiKey: input.apiKey?.trim() || existing?.apiKey || 'env:MODEL_API_KEY',
      listCentsPerKTokens: input.listCentsPerKTokens!,
      costCentsPerKTokens: input.costCentsPerKTokens ?? Math.floor(input.listCentsPerKTokens! / 2),
      status,
      dataClassLimit,
    })
    changeLog(exchange, 'panel.model.upsert', 'model', model.id, model.slug, `${status === 'online' ? '上线' : '下线'}，分级上限=${dataClassLimit}`)
    return maskedModel(model)
  })

  /** 删除登记：从模型目录移除；计量与审计数据保留。 */
  guarded('DELETE', '/api/panel/models/:id', 'panel.config.write', (exchange) => {
    const resolved = modelGateway()
    if (!resolved) return degraded(exchange, '模型网关')
    if (resolved.kind === 'dsh') {
      exchange.fail(400, 'MODEL_READONLY', '模型目录由 dsh 配置托管——01门面板只读，请在 dsh 侧增删改模型')
      return
    }
    const gateway = resolved.gateway
    const id = exchange.params['id']!
    const model = gateway.models().get(id)
    if (!model) throw new Error(`模型不存在：${id}`)
    gateway.models().remove(id)
    changeLog(exchange, 'panel.model.delete', 'model', id, model.slug)
    return { deleted: true }
  })

  /** 连通性测试：真实走网关 invoke 全链（modelgw 计量 / dsh 桥真实出站），失败如实回传，不造假成功。 */
  guarded('POST', '/api/panel/models/:slug/test', 'panel.config.write', async (exchange) => {
    const resolved = modelGateway()
    if (!resolved) return degraded(exchange, '模型网关')
    const slug = String(exchange.params.slug ?? '')
    const info = caller(exchange)
    const orgId = orgIdOf(exchange)
    if (resolved.kind === 'modelgw' && !orgId) throw new Error('无法确定计费组织（orgId），无法执行真实调用测试')
    try {
      const result = await resolved.gateway.invoke({
        model: slug,
        messages: [{ role: 'user', content: '模型连通性测试，请直接回复：OK' }],
        ...(resolved.kind === 'modelgw' ? { orgId } : {}),
        subject: info.userId ? `user:${info.userId}` : `panel:${info.principalId}`,
        maxTokens: 16,
      })
      return { ok: true, model: result.model, content: result.content.slice(0, 80), outputTokens: result.outputTokens }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 高频误配提示：OpenAI 兼容基址漏了 /v1 路径时上游 404（如「404 page not found」）——可行动文案而非裸状态码
      const hint = /HTTP 404/.test(message)
        ? '（提示：HTTP 404 常因 endpoint 漏了 /v1 路径——OpenAI 兼容基址应形如 https://<host>/v1）'
        : ''
      return { ok: false, error: `${message}${hint}` }
    }
  })

  // -- 战略看板（双轨迁移：原 portal board 聚合 + console /api/platform/card-packs 卡片包下发） --
  // 读 panel.read；聚合面（漏斗/WAIC/ROI）与卡片包面（角色×平台×ref 存活）一套端点下发。
  // 卡片包服务本体仍在 platform-core（与主分支逐字节一致），本插件是唯一消费方。
  const refAlive = (ref: string): boolean => {
    const colon = ref.indexOf(':')
    const type = ref.slice(0, colon)
    const id = ref.slice(colon + 1)
    const matches = (item: { id?: string; slug?: string }): boolean => item.id === id || item.slug === id
    // 资产目录缺失（01门演示态）→ 视为存活（卡片全部展示，不因降级隐藏入口）
    if (!soft(ctx, 'resourceCore') && ['agent', 'app', 'nas'].includes(type)) return true
    if (!soft(ctx, 'mcpRegistry') && type === 'mcp') return true
    if (!soft(ctx, 'skillHub') && type === 'skill') return true
    if (!soft(ctx, 'iam') && type === 'kb') return true
    try {
      if (type === 'agent' || type === 'app' || type === 'nas') {
        return soft(ctx, 'resourceCore').list(type).some(matches)
      }
      if (type === 'mcp') return soft(ctx, 'mcpRegistry').services().all().some(matches)
      if (type === 'skill') return soft(ctx, 'skillHub').skills().all().some(matches)
      if (type === 'kb') return soft(ctx, 'iam').orgs().get(id) !== undefined
      return true
    } catch {
      return true
    }
  }

  guarded('GET', '/api/panel/board', 'panel.read', (exchange) => {
    const info = caller(exchange)
    // -- 卡片包面（原 console /api/platform/card-packs 语义） --
    const available = [...new Set(cardpacks.all().map((pack) => pack.platform))]
    const requested = exchange.query.get('platform') ?? process.env.RQ_PLATFORM
      ?? (available.includes('rd') ? 'rd' : available[0]) ?? 'strategy'
    if (!CARD_PLATFORMS.includes(requested as CardPlatform)) {
      exchange.fail(400, 'BAD_REQUEST', `platform 非法（应为 ${CARD_PLATFORMS.join('/')}）`)
      return
    }
    const platform = requested as CardPlatform
    const iam = soft(ctx, 'iam')
    const user = info.userId ? iam?.users().get(info.userId) : undefined
    const roles = user ? user.roleIds.map((roleId) => iam?.roles().get(roleId)?.code).filter((code): code is string => Boolean(code)) : []
    cardpacks.setRefAliveResolver(refAlive)
    const packs = cardpacks.forPlatform(platform)
    const { cards, droppedDeadRefs } = filterCards({ packs, roles, refAlive })
    if (droppedDeadRefs.length > 0) {
      ctx.platformBus.emit('audit.alert.fired', {
        id: newId('alt'), severity: 'warning', title: '卡片包含失效资产引用',
        message: `平台 ${platform} 卡片包中 ${droppedDeadRefs.length} 个 ref 已失效被过滤：${droppedDeadRefs.join('、')}（请修正 cardpacks 配置）`,
      })
    }

    // -- 聚合面（原 portal board 语义：漏斗=曝光/点击→调用→完成；WAIC=usage 周聚合） --
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
    const behaviorCount = (type: string): number => {
      return soft(ctx, 'behavior')?.query({ type, from: weekAgo }).total ?? 0
    }
    let usageCount = 0
    let chargeCents = 0
    let byDay: Array<{ day: string; count: number; charge_cents: number }> = []
    const usageAgg = soft(ctx, 'usage')
    if (usageAgg) {
      const totals = usageAgg.totals({ from: weekAgo })
      usageCount = totals.count
      chargeCents = totals.charge_cents
      byDay = usageAgg.breakdown(weekAgo).byDay
    }
    const completedCalls = soft(ctx, 'mcpRegistry')?.calls().all()
      .filter((call) => call.ok && call.at >= weekAgo).length ?? 0

    return {
      generatedAt: new Date().toISOString(),
      windowDays: 7,
      // 卡片包面（顶层平铺，控制台工作台卡片消费方零改动换端点即可用）
      platform, label: packs[0]?.label ?? '', roles, cards, totalPacks: packs.length, availablePlatforms: available, droppedDeadRefs,
      // 聚合面（战略看板）——资产目录缺席（演示态）→ 全 0（看板诚实降级为演示数据视图）
      assets: {
        appsOnline: soft(ctx, 'resourceCore')?.list('app').filter((item) => item.status === 'online').length ?? 0,
        agentsOnline: soft(ctx, 'resourceCore')?.list('agent').filter((item) => item.status === 'online').length ?? 0,
        skillsPublished: soft(ctx, 'skillHub')?.skills().all().filter((item) => item.status === 'published').length ?? 0,
        mcpServing: soft(ctx, 'mcpRegistry')?.services().all()
          .filter((service) => service.status === 'online' || service.status === 'gray').length ?? 0,
      },
      waic: { count: usageCount, chargeCents },
      byDay,
      funnel: {
        exposed: behaviorCount('card.exposed'),
        clicked: behaviorCount('card.clicked'),
        invoked: usageCount,
        completed: completedCalls,
      },
      // ROI 用工成本模型（WP-14）：估算口径声明随响应下发，看板侧必须展示「估算」字样。
      roi: {
        minutesPerCallEstimate: Number(process.env.ROI_MINUTES_PER_CALL ?? 3),
        laborCostCentsPerHour: Number(process.env.ROI_LABOR_COST_CENTS_PER_HOUR ?? 5000),
        callBase: completedCalls > 0 ? completedCalls : usageCount,
        estimatedHoursSaved: Math.round(((completedCalls > 0 ? completedCalls : usageCount) * Number(process.env.ROI_MINUTES_PER_CALL ?? 3) / 60) * 100) / 100,
        estimatedLaborCostCents: Math.round((completedCalls > 0 ? completedCalls : usageCount) * Number(process.env.ROI_MINUTES_PER_CALL ?? 3) / 60 * Number(process.env.ROI_LABOR_COST_CENTS_PER_HOUR ?? 5000)),
        platformChargeCents: chargeCents,
        note: '估算口径：替代工时 = 调用次数 × 单次替代分钟 ÷ 60；人力成本 = 替代工时 × 综合人力时薪。非实测值。',
      },
    }
  })
  // -- 频道与消息 ---------------------------------------------------------------

  guarded('GET', '/api/panel/:dept/channels', 'panel.read', (exchange) => {
    const dept = deptOf(exchange)
    const info = caller(exchange)
    return {
      channels: panel.channels().find((item) => item.dept === dept.id).map((channel) => ({
        ...channel,
        unread: info.userId ? panel.unreadCount(info.userId, channel.id) : 0,
      })),
    }
  })

  guarded('POST', '/api/panel/:dept/channels', 'panel.write', (exchange) => {
    const dept = deptOf(exchange)
    const input = body<{ name?: string; desc?: string }>(exchange)
    if (!input.name?.trim()) throw new Error('频道名必填')
    const info = caller(exchange)
    const channel = panel.channels().insert({
      id: newId('pchan'), dept: dept.id, name: input.name.trim(),
      ...(input.desc ? { desc: input.desc.trim() } : {}), createdBy: info.userId ?? info.principalId,
    })
    changeLog(exchange, 'panel.channel.create', 'panel_channel', channel.id, channel.name)
    return { channel }
  })

  guarded('GET', '/api/panel/:dept/messages', 'panel.read', (exchange) => {
    const dept = deptOf(exchange)
    const channelId = exchange.query.get('channelId') ?? ''
    const after = exchange.query.get('after') ?? ''
    // limit 防护（QA T-05）：非数字/负数/超大值一律收敛到 [1,200]，杜绝 NaN→全量回包
    const limitRaw = Number(exchange.query.get('limit') ?? 80)
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 80, 1), 200)
    let rows = panel.messages().find((m) => m.dept === dept.id && (channelId ? m.channelId === channelId : true))
    if (after) rows = rows.filter((m) => m.createdAt > after)
    return { messages: rows.slice(-limit) }
  })

  guarded('POST', '/api/panel/:dept/messages', 'panel.write', async (exchange) => {
    const dept = deptOf(exchange)
    const input = body<{ channelId?: string; text?: string; ddSync?: boolean; uniqueKey?: string; model?: string; streamAgent?: boolean }>(exchange)
    if (!input.text?.trim()) throw new Error('消息内容必填')
    // 长度上限（QA T-06）：消息正文收敛到 10k 字符，杜绝超大 payload 对落库/SSE/轮询的连锁冲击
    if (input.text.length > 10_000) throw new Error('消息内容过长（上限 10000 字符）')
    const channelId = input.channelId || panel.channels().find((item) => item.dept === dept.id).at(0)?.id
    if (!channelId) throw new Error('部门暂无频道，请先创建')
    // 对话框模型切换：显式指定 model 时必须是模型目录已登记的 slug（未指定则跟随 Agent 资产配置）
    const requestedModel = input.model?.trim() ?? ''
    if (requestedModel && !modelGateway()?.gateway.models().findOne((item) => item.slug === requestedModel)) {
      throw new Error(`模型未在目录登记：${requestedModel}（可在「🧠 模型」中登记）`)
    }
    const info = caller(exchange)
    const message = await panel.sendMessage({
      dept: dept.id, channelId, senderType: 'human', senderId: info.userId,
      senderName: info.name, text: input.text.trim(), ddSync: input.ddSync === true,
      ...(input.uniqueKey ? { uniqueKey: input.uniqueKey } : {}),
      ...(requestedModel ? { modelOverride: requestedModel } : {}),
      // streamAgent（2026-09-11 流式应答卡）：@数字同事 由前端流式端点驱动应答，跳过隐式派发防双跑；
      // 流式端点不可用时前端回落拉取，应答缺失可由用户重发触发（诚实降级，不假装有人在打字）
      ...(input.streamAgent === true ? { skipAgentDispatch: true } : {}),
    })
    return { message }
  })

  /**
   * Agent 流式应答（SSE-over-POST，2026-09-11 用户需求：@数字同事 → 增量卡片渲染）：
   * 逐事件转发 {type:start|delta|done|fallback|end}；完成后应答照常落库并广播
   * panel.message.created（其他端经既有 SSE 通道收到持久消息）。鉴权与部门范围校验
   * 与 REST 面同规（requirePermission + deptOf），权限失败仍是干净 403/401。
   */
  http.register('POST', '/api/panel/:dept/agent-stream', async (exchange) => {
    if (!requirePermission(exchange, 'panel.write')) return
    const res = exchange.res
    const sse = (payload: Record<string, unknown>) => {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch { /* 连接已断 */ }
    }
    try {
      const dept = deptOf(exchange)
      const input = body<{ messageId?: string; model?: string }>(exchange)
      const message = input.messageId ? panel.messages().get(input.messageId) : undefined
      if (!message || message.dept !== dept.id || message.senderType !== 'human') {
        exchange.fail(400, 'BAD_REQUEST', '消息不存在或不属于该部门')
        return
      }
      if (res.headersSent) return
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const mentioned = dept.agents.filter((agent) => message.text.includes(`@${agent.name}`))
      if (mentioned.length === 0) {
        sse({ type: 'end', note: '消息未点名任何数字同事' })
        res.end()
        return
      }
      const requestedModel = input.model?.trim() || undefined
      for (const agentCard of mentioned) {
        await panel.streamAgentReply(dept, agentCard, message, requestedModel, sse)
      }
      sse({ type: 'end' })
      res.end()
    } catch (error) {
      // 流已开则只能在流内报错；未开流走标准错误信封
      const message = error instanceof Error ? error.message : String(error)
      if (res.headersSent) {
        sse({ type: 'end', error: message })
        res.end()
      } else {
        exchange.fail(400, 'BAD_REQUEST', message)
      }
    }
  }, { access: 'guarded', permission: 'panel.write' })

  guarded('POST', '/api/panel/channels/:id/read', 'panel.read', (exchange) => {
    const info = caller(exchange)
    if (!info.userId) throw new Error('仅平台账号可推进已读游标')
    panel.markRead(info.userId, String(exchange.params.id))
    return { ok: true }
  })

  guarded('POST', '/api/panel/messages/:id/card-action', 'panel.write', async (exchange) => {
    const input = body<{ opId?: string; reason?: string }>(exchange)
    if (!input.opId) throw new Error('opId 必填')
    const info = caller(exchange)
    const result = await panel.cardAction({
      messageId: String(exchange.params.id), opId: input.opId,
      actorId: info.userId ?? info.principalId, actorName: info.name, ...(input.reason ? { reason: input.reason } : {}),
    })
    changeLog(exchange, 'panel.card.action', 'panel_message', result.message.id, result.message.card?.title ?? '', result.result)
    return result
  })

  // -- 技能直调（J1 契约 v1 消费面：对话框 @技能名/斜杠命令） ---------------------------------

  guarded('GET', '/api/panel/:dept/skills', 'panel.read', (exchange) => {
    deptOf(exchange)
    return { skills: panel.listInvokeableSkills(orgIdOf(exchange)) }
  })

  /**
   * 技能点名直调（/技能名 问题 的服务端）。诚实降级语义（J1 契约 v1）：可预判的失败
   * （技能不存在/未上架/不可见/网关失败）以 HTTP 200 + ok:false + reason 回包——
   * 降级是数据不是传输错误；鉴权/部门范围失败仍走 403/400。
   * 留痕：斜杠原文先落频道（skipAgentDispatch：同一条文本不重复触发 @Agent）；
   * 成功落技能应答（agent 型消息），失败落系统行——失败原因全频道可见、可回查，不静默。
   */
  guarded('POST', '/api/panel/:dept/skills/invoke', 'panel.write', async (exchange) => {
    const dept = deptOf(exchange)
    const input = body<{ skill?: string; message?: string; channelId?: string; model?: string; uniqueKey?: string }>(exchange)
    const skillName = input.skill?.trim() ?? ''
    const message = input.message?.trim() ?? ''
    if (!skillName) throw new Error('skill 必填（技能名或 slug）')
    if (!message) throw new Error('message 必填（要交给技能的输入/问题）')
    if (message.length > 10_000) throw new Error('消息内容过长（上限 10000 字符）')
    const channelId = input.channelId || panel.channels().find((item) => item.dept === dept.id).at(0)?.id
    if (!channelId) throw new Error('部门暂无频道，请先创建')
    const requestedModel = input.model?.trim() ?? ''
    if (requestedModel && !modelGateway()?.gateway.models().findOne((item) => item.slug === requestedModel)) {
      throw new Error(`模型未在目录登记：${requestedModel}（可在「🧠 模型」中登记）`)
    }
    const info = caller(exchange)
    const trace = await panel.sendMessage({
      dept: dept.id, channelId, senderType: 'human', senderId: info.userId,
      senderName: info.name, text: `/${skillName} ${message}`, ddSync: false,
      ...(requestedModel ? { modelOverride: requestedModel } : {}),
      ...(input.uniqueKey ? { uniqueKey: input.uniqueKey } : {}),
      skipAgentDispatch: true,
    })
    changeLog(exchange, 'panel.skill.invoke', 'panel_message', trace.id, skillName, message.slice(0, 200))
    const result = await panel.invokeSkill(skillName, message, {
      userId: info.userId, ...(requestedModel ? { modelOverride: requestedModel } : {}),
    })
    if (!result.ok) {
      await panel.sendMessage({
        dept: dept.id, channelId, senderType: 'system', senderName: '01门',
        text: `⚡ 技能「${skillName}」调用失败：${result.reason}`, ddSync: false,
      })
      return { ok: false as const, reason: result.reason, message: trace }
    }
    const reply = await panel.sendMessage({
      dept: dept.id, channelId, senderType: 'agent', senderName: `⚡ ${result.skill.name}`,
      senderIcon: '⚡', agentName: result.skill.name, text: result.reply,
      ddSync: false, ...(result.model ? { replyModel: result.model } : {}),
      ...(trace.sceneCode ? { sceneCode: trace.sceneCode } : {}),
    })
    return { ok: true as const, reply: result.reply, model: result.model, skill: result.skill, message: trace, replyMessage: reply }
  })

  // -- 任务看板 -----------------------------------------------------------------

  guarded('GET', '/api/panel/:dept/tasks', 'panel.read', (exchange) => ({
    tasks: panel.tasks().find((item) => item.dept === deptOf(exchange).id),
  }))

  guarded('POST', '/api/panel/:dept/tasks', 'panel.task.write', (exchange) => {
    const dept = deptOf(exchange)
    const input = body<{ title?: string; detail?: string; lane?: string; assigneeName?: string; assigneeType?: string; sceneCode?: string }>(exchange)
    if (!input.title?.trim()) throw new Error('任务标题必填')
    if (input.lane !== undefined && !TASK_LANES.includes(input.lane as TaskLane)) throw new Error(`非法泳道：${input.lane}`)
    const info = caller(exchange)
    const task = panel.createTask({
      dept: dept.id, title: input.title.trim(),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.lane ? { lane: input.lane as TaskLane } : {}),
      ...(input.assigneeType === 'agent' ? { assigneeType: 'agent' as const } : {}),
      ...(input.assigneeName ? { assigneeName: input.assigneeName } : {}),
      ...(input.sceneCode ? { sceneCode: input.sceneCode } : {}),
      createdBy: info.userId ?? info.principalId,
    })
    return { task }
  })

  guarded('POST', '/api/panel/tasks/:id/transition', 'panel.task.write', (exchange) => {
    const lane = body<{ lane?: string }>(exchange).lane
    if (!lane || !TASK_LANES.includes(lane as TaskLane)) throw new Error(`非法泳道：${lane}`)
    const info = caller(exchange)
    return { task: panel.transitionTask(String(exchange.params.id), lane as TaskLane, info.userId ?? info.principalId) }
  })

  // -- 部门知识 ------------------------------------------------------------------

  guarded('GET', '/api/panel/:dept/artifacts', 'panel.read', (exchange) => ({
    artifacts: panel.artifacts().find((item) => item.dept === deptOf(exchange).id).slice(-100).reverse(),
  }))

  guarded('POST', '/api/panel/:dept/artifacts', 'panel.write', (exchange) => {
    const dept = deptOf(exchange)
    const input = body<{ title?: string; content?: string; kind?: string; sceneCode?: string }>(exchange)
    if (!input.title?.trim() || !input.content?.trim()) throw new Error('标题与内容必填')
    const kind = (['report', 'order', 'quote', 'diagnosis', 'other'].includes(input.kind ?? '') ? input.kind : 'other') as 'report' | 'order' | 'quote' | 'diagnosis' | 'other'
    const info = caller(exchange)
    const artifact = panel.artifacts().insert({
      id: newId('part'), dept: dept.id, kind, title: input.title.trim(), content: input.content.trim(),
      ...(input.sceneCode ? { sceneCode: input.sceneCode } : {}), createdBy: info.userId ?? info.principalId,
    })
    changeLog(exchange, 'panel.artifact.create', 'panel_artifact', artifact.id, artifact.title)
    return { artifact }
  })

  // -- 场景图谱联动 ----------------------------------------------------------------

  guarded('POST', '/api/panel/:dept/scenes/:code/diagnose', 'panel.write', async (exchange) => {
    const info = caller(exchange)
    return panel.diagnose({
      dept: String(exchange.params.dept), sceneCode: String(exchange.params.code),
      actorId: info.userId ?? info.principalId, actorName: info.name,
    })
  })

  guarded('POST', '/api/panel/:dept/scenes/:code/sync-dingtalk', 'panel.write', (exchange) => {
    const dept = deptOf(exchange)
    const code = String(exchange.params.code)
    const { pack, sceneLabel } = panel.sceneContext(code)
    const info = caller(exchange)
    ctx.platformBus.emit(PlatformEvents.PanelCardAction, {
      dept: dept.id, opId: 'scene-sync', opLabel: '同步钉钉群', action: 'dd.push', ddPush: true,
      title: `🗺 ${pack.name}场景卡：${sceneLabel}`,
      text: `【${pack.name} · ${code}】${sceneLabel}\n痛点与四清单详见部门面板「场景图谱」页。`,
      actorId: info.userId ?? info.principalId, actorName: info.name, channelName: '',
    })
    changeLog(exchange, 'panel.scene.sync_dingtalk', 'panel_scene', code, sceneLabel)
    return { ok: true, note: '已请求钉钉桥接投递（未绑定群桥时投递失败会留痕告警）' }
  })

  // -- 行业三态 + 激活申请 + 图谱 -----------------------------------------------------

  guarded('GET', '/api/panel/industries', 'panel.read', (exchange) => {
    const orgId = orgIdOf(exchange)
    const pendingCodes = soft(ctx, 'audit')?.approvals()
      .find((item) => item.kind === 'industry.activation' && item.status === 'pending' && String(item.payload.orgId ?? '') === orgId)
      .map((item) => String(item.payload.code ?? '')) ?? []
    return { industries: panel.industryStates(orgId, pendingCodes) }
  })

  guarded('POST', '/api/panel/industries/:code/activate-requests', 'panel.write', (exchange) => {
    const audit = soft(ctx, 'audit')
    if (!audit) return degraded(exchange, '审批中心')
    const code = String(exchange.params.code ?? '').toUpperCase()
    const registry = panel.industryStates('', []).find((item) => item.code === code)
    if (!registry) throw new Error(`未登记行业：${code}`)
    const orgId = orgIdOf(exchange)
    if (!orgId) throw new Error('无法确定所属组织（组织账号缺失）')
    const existing = panel.activations().findOne((item) => item.orgId === orgId && item.code === code && item.status === 'active')
    if (existing) throw new Error(`行业 ${code} 对本组织已是激活态`)
    const info = caller(exchange)
    const approval = audit.createApproval({
      kind: 'industry.activation',
      // WP-10/L1（QA A-06）：L4 高危统一高风险——通过需二次确认 + 公司级终审标记
      riskLevel: 'high',
      title: `行业功能包授权激活：${registry.name}（${code}）`,
      payload: { code, orgId, requestedBy: info.name, sub: registry.sub, graphLoaded: registry.graphLoaded },
      requesterId: info.userId ?? info.principalId,
      requesterName: info.name,
      riskLevel: 'high',
    })
    changeLog(exchange, 'panel.industry.activate_request', 'panel_industry', code, registry.name, `审批单 ${approval.id}`)
    return { approval }
  })

  guarded('GET', '/api/panel/scenegraph', 'scenegraph.read', (exchange) => {
    const code = (exchange.query.get('industry') ?? '').toUpperCase()
    const pack = ctx.scenegraphs.get(code)
    if (!pack) throw new Error(`场景图谱未装载或未激活：${code}（已装载：${ctx.scenegraphs.all().map((item) => item.code).join('/') || '无'}）`)
    return { pack, problems: ctx.scenegraphs.loadProblems() }
  })

  guarded('POST', '/api/panel/scenegraphs/reload', 'panel.config.write', async (exchange) => {
    const result = await ctx.scenegraphs.reloadFromDir()
    changeLog(exchange, 'panel.scenegraph.reload', 'scenegraph', 'all', `${result.packs} 包`, `问题 ${result.problems.length} 项`)
    return result
  })

  // -- 降级轮询 + SSE（钉钉 webview 双通道铁律） --------------------------------------

  guarded('GET', '/api/panel/:dept/poll', 'panel.read', (exchange) => {
    const dept = deptOf(exchange)
    const info = caller(exchange)
    const since = exchange.query.get('since') ?? ''
    const messages = panel.messages().find((m) => m.dept === dept.id && (since ? m.createdAt > since : true)).slice(-50)
    return {
      at: new Date().toISOString(),
      messages,
      tasks: panel.tasks().find((item) => item.dept === dept.id),
      unread: info.userId
        ? panel.channels().find((item) => item.dept === dept.id).map((channel) => ({ channelId: channel.id, unread: panel.unreadCount(info.userId, channel.id) }))
        : [],
    }
  })

  // -- SSE stream ticket（交接清单 H4 / P2-O-5 架构性收敛） ---------------------------
  // EventSource 无法携带 Authorization 头，长效 access token 走 ?token= 会进代理/访问日志。
  // 改为 POST（Bearer + 权限点 + 部门范围校验）换取 ≤60s 一次性 ticket，GET 消费即焚：
  // URL 里只出现短时一次性凭证。?token= 旧通道保留（fail-closed 同规），供未升级消费方过渡。

  /** SSE 流票据：sha256(ticketRaw) → {principal, dept, 过期时刻}。消费即删；签发时顺手清扫过期。 */
  const streamTickets = new Map<string, { principal: CallerInfo; dept: string; expiresAt: number }>()
  const STREAM_TICKET_TTL_MS = 60_000

  const issueStreamTicket = (principal: CallerInfo, dept: string): string => {
    const now = Date.now()
    for (const [key, value] of streamTickets) if (value.expiresAt < now) streamTickets.delete(key)
    const raw = 'stk_' + randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
    streamTickets.set(createHash('sha256').update(raw).digest('hex'), { principal, dept, expiresAt: now + STREAM_TICKET_TTL_MS })
    return raw
  }

  guarded('POST', '/api/panel/stream-ticket', 'panel.read', (exchange) => {
    const dept = String(body<{ dept?: string }>(exchange).dept ?? '')
    if (!DEPT_RE.test(dept)) throw new Error(`部门标识非法：${dept}`)
    const deptConfig = panel.dept(dept)
    if (!panel.deptScopeAllowed(caller(exchange), deptConfig)) {
      exchange.fail(403, 'FORBIDDEN', `部门范围受限：${deptConfig.label} 已绑定组织治理，仅该组织子树成员可访问`, { permission: 'panel.read', deptScope: deptConfig.orgId })
      return
    }
    return { ticket: issueStreamTicket(caller(exchange), dept), expiresInSeconds: STREAM_TICKET_TTL_MS / 1000 }
  })

  // SSE：公开路径（console 白名单）+ ?ticket=（首选，消费即焚）或 ?token=（旧通道）自校验，fail-closed
  http.register('GET', '/api/panel/stream', (exchange) => {
    const fail = (status: number, message: string) => exchange.fail(status, 'STREAM_AUTH_FAILED', message)
    let dept = exchange.query.get('dept') ?? ''
    const ticketRaw = exchange.query.get('ticket') ?? ''
    if (!ticketRaw && !exchange.query.get('token')) return fail(401, '缺少 ticket/token 查询参数')
    if (ticketRaw) {
      // ticket 通道：签发时已完成鉴权 + 权限点 + 部门范围校验，这里只做一次性消费（兑换即焚）
      const key = createHash('sha256').update(ticketRaw).digest('hex')
      const entry = streamTickets.get(key)
      if (!entry || entry.expiresAt < Date.now()) {
        streamTickets.delete(key)
        return fail(401, 'ticket 无效或已过期，请重新获取')
      }
      streamTickets.delete(key)
      const queryDept = dept
      dept = entry.dept
      if (queryDept && queryDept !== dept) return fail(400, `dept 查询参数与 ticket 签发部门不一致：${queryDept} ≠ ${dept}`)
      exchange.principal = entry.principal
      if (!requirePermission(exchange, 'panel.read')) return
    } else {
      const token = exchange.query.get('token') ?? ''
      if (!token) return fail(401, '缺少 token 查询参数')
      if (!DEPT_RE.test(dept)) return fail(400, `部门标识非法：${dept}`)
      const authn = soft(ctx, 'authn')
      if (!authn) return fail(401, '认证中心未接入（01门演示态）——连接宿主后可订阅实时流')
      try {
        const verified = authn.verify(token)
        // principal 形状与 console 鉴权中间件同规（human → userId=refId）：deptScopeAllowed
        // 的组织子树判定依赖 userId，缺了它所有人类用户都会被误判为无组织归属。
        exchange.principal = {
          kind: verified.principal.type,
          principalId: verified.principal.id,
          ...(verified.principal.type === 'human' && verified.principal.refId ? { userId: verified.principal.refId } : {}),
          ...(verified.principal.type === 'machine' ? { refType: verified.principal.refType, refId: verified.principal.refId } : {}),
          name: verified.principal.name,
          permissions: verified.scopes,
          actChain: verified.actChain,
        }
      } catch (error) {
        return fail(401, `令牌无效：${error instanceof Error ? error.message : String(error)}`)
      }
      if (!requirePermission(exchange, 'panel.read')) return
    }
    // 部门范围校验（QA 2026-09-08 BUG-A-01/T-01，两通道同规）：stream 握手阶段执行与 REST 面
    // deptOf 同规的归属校验——本端点曾因 ?token= 自校验逃出 RBAC 断言网，组织受限用户实时收到
    // 受限部门消息；现握手即断，绝不先订阅。
    const deptConfig = (() => {
      try { return panel.dept(dept) } catch { return undefined }
    })()
    if (!deptConfig) return fail(404, `部门不存在：${dept}`)
    if (!panel.deptScopeAllowed(caller(exchange), deptConfig)) {
      exchange.fail(403, 'FORBIDDEN', `部门范围受限：${deptConfig.label} 已绑定组织治理，仅该组织子树成员可访问`, { permission: 'panel.read', deptScope: deptConfig.orgId })
      return
    }
    const res = exchange.res
    if (res.headersSent) return
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 5000\n\n')
    // 事件名进 data（EventSource.onmessage 只收默认事件；前端按 payload.name 分发）
    const unsubscribe = panel.subscribeStream(dept, (event) => {
      try {
        res.write(`data: ${JSON.stringify({ name: event.name, payload: event.payload })}\n\n`)
      } catch { /* 连接已断，cleanup 兜底 */ }
    })
    const heartbeat: ReturnType<typeof setInterval> = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* ignore */ }
    }, 25_000)
    exchange.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  }, { access: 'public', selfValidated: true })

  // -- 行业激活审批执行器（审批通过 → 置 active + grantCapabilities + 事件） ----------------

  // 审批中心缺席（01门演示态）→ 不注册执行器（幂等 no-op 注销函数）
  const offExecutor = soft(ctx, 'audit')?.registerExecutor('industry.activation', panel.buildActivationExecutor()) ?? (() => {})

  // 事件扇出（SSE 数据源）+ 桥接回执联动（ddSync 状态回写）
  panel.wireEventBus()
  const offDelivered = ctx.platformBus.on(PlatformEvents.DingtalkDelivered, (payload) => {
    const { messageId, ok, error } = (payload ?? {}) as { messageId?: string; ok?: boolean; error?: string }
    if (!messageId) return
    const message = panel.messages().get(messageId)
    if (!message) return
    // 投递成功：sent 终态；failed→sent 必须可达（QA BUG-A-02：失败重投成功后界面仍显示失败）
    if (ok) {
      if (message.ddSync !== 'sent') panel.messages().update(messageId, { ddSync: 'sent' })
      return
    }
    // 投递失败：仅 pending 置 failed（failed 已是终态，重复失败不抖动）；告警只在首次失败留痕
    if (message.ddSync !== 'pending') return
    panel.messages().update(messageId, { ddSync: 'failed' })
    if (error) {
      soft(ctx, 'audit')?.fire({ severity: 'warning', title: '钉钉桥接投递失败', message: `消息 ${messageId} 投递失败：${error}`, resourceType: 'panel_message', resourceId: messageId })
    }
  })

  ctx.effect(() => () => {
    offExecutor()
    offDelivered()
  })

  // -- 01门装态补环（2026-09-11 写通道/模型/钉钉三件套） -----------------------------------
  // dsh Loader 并发装载 patch entry（app-boot §mountRootInclude）——「apply 期软读兄弟服务」
  // 是竞态写法，本节全部改为顺序无关：
  //   a. 登录面无条件注册在 panel 自有命名空间（/api/panel/auth/*，不与 console 的 /api/auth/*
  //      冲突），authn 缺席时请求期诚实 503——console/authn 在场与否都行为正确；
  //   b. dws CLI 桥挂 /api/panel/ddws/*（同理不碰 /api/dingtalk/*）；ddSync 投递钩子在事件时
  //      再查 dingtalkBridge，桥在场即让位，杜绝双投；
  //   c. 基线管理员种子延迟重试（iam 发布即播种，orgs 非空幂等跳过；与 console seed 双跑安全）。

  /** 面板命名空间登录面：authn 在场即转发（响应形状与 console 逐字段一致，前端零特判）。 */
  const loginViaAuthn = () => {
    const authn = soft(ctx, 'authn')
    const iam = soft(ctx, 'iam')
    if (!authn || !iam) return undefined
    return {
      login: (username: string, password: string) => {
        const result = authn.login(username, password)
        const user = iam.users().get(result.userId)!
        return {
          token: result.token,
          refreshToken: result.refreshToken,
          expiresAt: result.record.expiresAt,
          user: {
            id: user.id, username: user.username, displayName: user.displayName,
            orgId: user.orgId, roleIds: user.roleIds,
            roles: user.roleIds.map((roleId: string) => iam.roles().get(roleId)?.name).filter(Boolean),
            permissions: iam.userPermissions(user.id),
          },
        }
      },
      refresh: (refreshToken: string) => authn.refreshSession(refreshToken),
    }
  }
  http.register('POST', '/api/panel/auth/login', (exchange) => {
    const backend = loginViaAuthn()
    if (!backend) {
      exchange.fail(503, 'AUTHN_UNAVAILABLE', '认证面未就绪（本机形态未装配认证中心）——请从宿主/控制台登录')
      return
    }
    const { username, password } = body<{ username?: string; password?: string }>(exchange)
    if (!username || !password) {
      exchange.fail(400, 'BAD_REQUEST', '用户名与密码必填')
      return
    }
    try {
      exchange.ok(backend.login(username, password))
    } catch (error) {
      exchange.fail(401, 'LOGIN_FAILED', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'public' })
  http.register('POST', '/api/panel/auth/refresh', (exchange) => {
    const backend = loginViaAuthn()
    if (!backend) {
      exchange.fail(503, 'AUTHN_UNAVAILABLE', '认证面未就绪（本机形态未装配认证中心）')
      return
    }
    const { refreshToken } = body<{ refreshToken?: string }>(exchange)
    if (!refreshToken) {
      exchange.fail(400, 'BAD_REQUEST', 'refreshToken 必填')
      return
    }
    try {
      const result = backend.refresh(refreshToken)
      exchange.ok({ token: result.token, refreshToken: result.refreshToken })
    } catch (error) {
      exchange.fail(401, 'REFRESH_FAILED', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'public' })

  const dingtalkBridgePresent = Boolean(soft(ctx, 'dingtalkBridge'))
  // -- 01门本地钉钉面（dws CLI）——无条件注册（2026-09-11 起不再以「桥缺席」为前提） --------------
  // 命名空间铁律不变：dws 面全部挂在 /api/panel/ddws/*（绝不碰 /api/dingtalk/*，那是
  // plugin-dingtalk-bridge 的路由面）。宿主桥在场时本面作为「本地直连钉钉」共存——用户可不经
  // 宿主平台（连接器/iam 扫码）直接用自家钉钉 dws；消息投递归属在事件时裁决（见下方钩子）。
  {
    const dws = new DwsCli(ctx)
    guarded('GET', '/api/panel/ddws/status', 'panel.read', async () => {
      const status = await dws.status()
      return {
        ...status,
        via: 'dws-cli',
        // 形状兼容（app.js renderTopRight 消费）：bound=false | {displayName,...}
        bound: status.bound && status.group ? { displayName: status.group, via: 'dws-cli' } : false,
        connector: { configured: status.installed, name: `dws CLI${status.version ? ` ${status.version}` : ''}`, mode: status.installed ? 'real' : 'mock' },
      }
    })
    guarded('POST', '/api/panel/ddws/install', 'panel.config.write', async () => dws.install())
    // 登录授权面（2026-09-11 用户需求：不与宿主平台绑定，面板本地代发起 dws 登录）：
    // POST 发起设备流登录（返回激活指令：授权链接+用户码，前端弹窗直出）；
    // GET 轮询会话状态（前端 3s 轮询，授权完成即 authenticated:true）；
    // DELETE 取消进行中的登录会话。授权态归 dws CLI 自身（本面板零凭证铁律不变）。
    guarded('POST', '/api/panel/ddws/login', 'panel.config.write', async () => dws.startLogin())
    guarded('GET', '/api/panel/ddws/login', 'panel.read', async () => dws.loginState())
    guarded('DELETE', '/api/panel/ddws/login', 'panel.config.write', () => {
      dws.cancelLogin()
      return { cancelled: true }
    })
    guarded('PUT', '/api/panel/ddws/bind', 'panel.config.write', (exchange) => {
      const group = body<{ group?: string }>(exchange).group?.trim() ?? ''
      const record = dws.bind(group, caller(exchange).userId ?? caller(exchange).principalId)
      return { bound: true, group: record.group }
    })
    guarded('DELETE', '/api/panel/ddws/bind', 'panel.config.write', () => {
      dws.unbind()
      return { bound: false }
    })
    guarded('POST', '/api/panel/ddws/test', 'panel.write', async (exchange) => {
      const text = body<{ text?: string }>(exchange).text?.trim() || '01门面板 dws 连通性测试'
      try {
        const sent = await dws.sendToGroup(text)
        return { ok: true, group: sent.group }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
    // 入向拉取（2026-09-11 用户需求「自动拉取最新消息」）：dws +chat-messages 读绑定群最新消息，
    // 按 messageId 幂等去重落当前频道（senderType=human + ddSync='origin' + uniqueKey 去重键）。
    // 拉取失败以 ok:false + error 回包（HTTP 200，降级是数据不是传输错误），前端可重试。
    guarded('POST', '/api/panel/ddws/pull', 'panel.write', async (exchange) => {
      const dept = deptOf(exchange)
      const input = body<{ channelId?: string; limit?: number }>(exchange)
      const channelId = input.channelId || panel.channels().find((item) => item.dept === dept.id).at(0)?.id
      if (!channelId) throw new Error('部门暂无频道，请先创建')
      const channel = panel.channels().get(channelId)
      if (!channel || channel.dept !== dept.id) throw new Error(`频道不存在或不属于该部门：${channelId}`)
      const info = caller(exchange)
      try {
        const incoming = await dws.pullLatestMessages(Math.floor(Number(input.limit) || 20))
        let inserted = 0
        for (const item of incoming) {
          const uniqueKey = `dws:${item.messageId}`
          if (panel.messages().findOne((m) => m.channelId === channelId && m.uniqueKey === uniqueKey)) continue
          await panel.sendMessage({
            dept: dept.id, channelId, senderType: 'human',
            senderId: info.userId, senderName: `${item.sender} · 钉钉`,
            text: item.text, ddSync: false, sceneCode: undefined,
            uniqueKey,
          })
          inserted += 1
        }
        return { ok: true, inserted, fetched: incoming.length, group: channel.name }
      } catch (error) {
        return { ok: false as const, inserted: 0, error: error instanceof Error ? error.message : String(error) }
      }
    })
    // 消息 ddSync 出向钩子（投递归属事件时裁决——装配序不可靠，apply 期探测不算数）：
    //   a. 宿主桥在场且有 channel 群桥 → 桥全权处理（本钩子让位：桥在 deliver 前自查，杜绝双投）；
    //   b. 否则本钩子负责：dws 已绑群 → dws 投递；未绑群 → 诚实失败回执（QA T-04「无群桥也要
    //      回执」语义由本钩子承接——钉钉桥无 channel 群桥时不再自行发 ok:false，见其 service.ts）。
    ctx.platformBus.on(PlatformEvents.PanelMessageCreated, (payload) => {
      const data = (payload ?? {}) as { messageId?: string; ddSync?: string; text?: string }
      if (!data.messageId || data.ddSync !== 'pending') return
      const bridgeSvc = soft(ctx, 'dingtalkBridge') as { bridgeChannels?: () => { find: (fn: (item: { purpose: string }) => boolean) => Array<{ purpose: string }> } } | undefined
      if (bridgeSvc?.bridgeChannels?.().find((item) => item.purpose === 'channel').length > 0) return
      void dws.sendToGroup(String(data.text ?? '')).then(
        (sent) => ctx.platformBus.emit(PlatformEvents.DingtalkDelivered, { messageId: data.messageId, ok: true, via: 'dws-cli', group: sent.group }),
        (error) => ctx.platformBus.emit(PlatformEvents.DingtalkDelivered, {
          messageId: data.messageId, ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    })
    ctx.logger('panel-core').info(`01门本地钉钉面已挂载：dws CLI 桥（/api/panel/ddws/*，宿主桥${dingtalkBridgePresent ? '在场共存' : '缺席独任'}；ddSync 投递按群桥归属裁决）`)
  }

  // 基线管理员种子（延迟重试）：iam 在场且组织目录为空（01门+authn 首启）→ 与 console seed
  // 同口径初始化。Loader 并发装载下 iam 可能晚于本插件发布，这里轮询等待直至可用（上限 30s）。
  // console 在场（全量形态）时由 console seed 负责；本种子幂等（orgs().count()>0 即跳过）。
  {
    let seedTries = 0
    const seedTimer = setInterval(() => {
      seedTries += 1
      const iamNow = soft(ctx, 'iam')
      if (!iamNow) {
        if (seedTries >= 60) {
          clearInterval(seedTimer)
          ctx.logger('panel-core').info('iam 未就绪，跳过 01门基线管理员种子（纯演示态）')
        }
        return
      }
      clearInterval(seedTimer)
      if (iamNow.orgs().count() > 0) return
      try {
        iamNow.ensureBuiltinRoles()
        const root = iamNow.createOrg({ name: process.env.ORG_NAME ?? '元冰可集团' })
        const roleSuper = iamNow.roles().findOne((role: { code: string }) => role.code === 'super_admin')!
        const { user, initialPassword } = iamNow.createUser({
          username: 'admin',
          displayName: '平台管理员',
          orgId: root.id,
          title: '平台管理员',
          roleIds: [roleSuper.id],
          password: process.env.ADMIN_PASSWORD,
        })
        iamNow.users().update(user.id, { status: 'active' })
        void user
        if (initialPassword) {
          const file = join(ctx.opsStorage.dataDirPath, 'admin-initial-password.txt')
          if (!existsSync(file)) {
            writeFileSync(file, `平台管理员 admin 的初始口令（仅生成一次；首次登录后请妥善保管并删除本文件）：\n${initialPassword}\n`, 'utf8')
          }
        }
        ctx.logger('panel-core').info('01门装态基线种子完成：内置角色 + 根组织 + 平台管理员 admin（初始口令见 data/admin-initial-password.txt）')
      } catch (error) {
        ctx.logger('panel-core').warn(`01门装态基线种子失败（不阻断装配）：${error instanceof Error ? error.message : String(error)}`)
      }
    }, 500)
    ctx.effect(() => () => clearInterval(seedTimer))
  }

  // -- 静态托管（/panel → 对外 /gate01/panel/） ----------------------------------------

  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
  if (existsSync(publicDir)) {
    // 01门装态着陆归一（config.landingRedirect，2026-09-11 用户实测 MIME 白屏修复）：装配无 console
    // 时根路径没有控制台可落——302 到面板，杜绝 SPA 兜底把「缺资源的壳页」发给浏览器。
    if (config.landingRedirect) {
      http.register('GET', '/', (exchange) => {
        exchange.res.writeHead(302, { location: `${http.externalBase}/panel/` }).end()
      })
    }
    // 目录形态归一：/panel（无尾斜杠）伺服 index.html 后相对资源 ./js/* 会解析到 /js/*（404→SPA 兜底→白屏），
    // 与 dsh-bridge 的 /gate01→/gate01/ 302 同语义；Location 带 externalBase（挂载形态 = /gate01/panel/）。
    // 注意路由按 split('/').filter(Boolean) 匹配，/panel 与 /panel/ 命中同一路由节点——
    // 带尾斜杠的请求必须原地伺服 index.html，不得 302（自指循环）。
    http.register('GET', '/panel', (exchange) => {
      if (exchange.path.endsWith('/')) {
        exchange.file(join(publicDir, 'index.html'))
        return
      }
      exchange.res.writeHead(302, { location: `${http.externalBase}/panel/` }).end()
    })
    http.serveStatic('/panel', publicDir, '/index.html')
  }

  // -- 种子（基线骨架 + DEMO_SEED=1 演示内容） ---------------------------------------

  // 演示内容播种：demoAuth 装态自动演示（决策 2），全量形态维持 DEMO_SEED=1 显式门控
  void seedPanel(ctx, panel, demoAuth)

  // -- panel_* 工具族（共享 tools 键，dsh 下即原生 ToolRuntime） ------------------------

  const renderJson = (args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]

  ctx.tools.register({
    name: 'panel_agents_list',
    description: '列出部门面板的 Agent 阵容（名称/职责/绑定资产），用于选择协作对象',
    permission: 'panel.read',
    parameters: { type: 'object', properties: { dept: { type: 'string', description: '部门标识（rd/mfg/sales/strategy/fin），缺省列出全部部门' } } },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args) {
      const dept = (args as { dept?: string }).dept
      const configs = dept ? [panel.dept(dept)] : panel.deptConfigs().all()
      return configs.map((config) => ({ dept: config.id, label: config.label, agents: config.agents }))
    },
  })

  ctx.tools.register({
    name: 'panel_msg_send',
    description: '向部门协作频道发消息（可选 --sync-dingtalk 语义：sync_dingtalk=true 时经钉钉桥接同步到群）',
    permission: 'panel.write',
    parameters: {
      type: 'object',
      properties: {
        dept: { type: 'string', description: '部门标识' },
        channel_id: { type: 'string', description: '频道 id，缺省取部门首个频道' },
        text: { type: 'string', description: '消息文本（支持 @Agent名 唤起）' },
        sync_dingtalk: { type: 'boolean', description: '是否同步到钉钉群（需已绑定群桥）' },
      },
      required: ['dept', 'text'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const input = args as { dept: string; channel_id?: string; text: string; sync_dingtalk?: boolean }
      const channelId = input.channel_id || panel.channels().find((item) => item.dept === input.dept).at(0)?.id
      if (!channelId) throw new Error(`部门 ${input.dept} 暂无频道`)
      const message = await panel.sendMessage({
        dept: input.dept, channelId, senderType: 'human',
        senderId: exec.principal?.userId, senderName: exec.principal?.name ?? '工具调用',
        text: input.text, ddSync: input.sync_dingtalk === true,
      })
      return { messageId: message.id, ddSync: message.ddSync }
    },
  })

  ctx.tools.register({
    name: 'panel_task_create',
    description: '在部门任务看板创建任务卡（泳道 todo/doing/review/done，缺省 todo）',
    permission: 'panel.task.write',
    parameters: {
      type: 'object',
      properties: {
        dept: { type: 'string', description: '部门标识' },
        title: { type: 'string', description: '任务标题' },
        detail: { type: 'string', description: '任务详情' },
        lane: { type: 'string', enum: ['todo', 'doing', 'review', 'done'], description: '目标泳道' },
        scene_code: { type: 'string', description: '关联场景图谱编号（如 QB01-A-2-5）' },
      },
      required: ['dept', 'title'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const input = args as { dept: string; title: string; detail?: string; lane?: TaskLane; scene_code?: string }
      const task = panel.createTask({
        dept: input.dept, title: input.title, ...(input.detail ? { detail: input.detail } : {}),
        ...(input.lane ? { lane: input.lane } : {}), ...(input.scene_code ? { sceneCode: input.scene_code } : {}),
        createdBy: exec.principal?.userId ?? exec.principal?.principalId ?? 'tool',
      })
      return { taskId: task.id, lane: task.lane }
    },
  })

  ctx.tools.register({
    name: 'panel_task_transition',
    description: '迁移部门任务到指定泳道（todo/doing/review/done）',
    permission: 'panel.task.write',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: '任务 id' }, lane: { type: 'string', enum: ['todo', 'doing', 'review', 'done'], description: '目标泳道' } },
      required: ['task_id', 'lane'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const input = args as { task_id: string; lane: TaskLane }
      const task = panel.transitionTask(input.task_id, input.lane, exec.principal?.userId ?? 'tool')
      return { taskId: task.id, lane: task.lane }
    },
  })

  ctx.tools.register({
    name: 'panel_scene_diag',
    description: '对行业场景图谱中的场景发起数字化诊断（生成诊断任务并进入协作会话）',
    permission: 'panel.write',
    parameters: {
      type: 'object',
      properties: { dept: { type: 'string', description: '部门标识' }, scene_code: { type: 'string', description: '场景编号（如 QB01-A-2-5）' } },
      required: ['dept', 'scene_code'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const input = args as { dept: string; scene_code: string }
      const result = await panel.diagnose({
        dept: input.dept, sceneCode: input.scene_code,
        actorId: exec.principal?.userId ?? 'tool', actorName: exec.principal?.name ?? '工具调用',
      })
      return { messageId: result.message.id, taskId: result.task.id }
    },
  })

  ctx.tools.register({
    name: 'panel_widget_data',
    description: '读取部门看板 widget 数据（含来源徽标与降级标记）',
    permission: 'panel.read',
    parameters: {
      type: 'object',
      properties: { dept: { type: 'string', description: '部门标识' }, widget_id: { type: 'string', description: 'widget id，缺省返回全部' } },
      required: ['dept'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args) {
      const input = args as { dept: string; widget_id?: string }
      const dept = panel.dept(input.dept)
      const widgets = panel.board(dept)
      return input.widget_id ? widgets.filter((widget) => widget.id === input.widget_id) : widgets
    },
  })

  // -- J1 契约 v1：dsh 标准对话点名调用面板 Agent 阵容与已上架 Skill（其他 Agent 协作的主通道） --
  ctx.tools.register({
    name: 'panel_agent_invoke',
    description: '点名调用部门面板的某个 Agent 提问并同步取回应答（dsh 标准对话协作主通道）：按部门名册全名匹配，'
      + '经面板 Agent 资产（agentRef/model/systemPrompt）+ 行业场景摘要组装上下文，单轮调用模型网关。'
      + '应答不落频道消息；如需留痕请配合 panel_msg_send。失败诚实返回 ok:false（不造假回复）。',
    permission: 'panel.write',
    parameters: {
      type: 'object',
      properties: {
        dept: { type: 'string', description: '部门标识（rd/mfg/sales/strategy/fin）' },
        agent: { type: 'string', description: 'Agent 名册全名（可用 panel_agents_list 查询，如「质量分析 Agent」）' },
        message: { type: 'string', description: '要问该 Agent 的问题/指令' },
        context_note: { type: 'string', description: '附加上下文说明（可选，拼入系统提示）' },
      },
      required: ['dept', 'agent', 'message'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const input = args as { dept: string; agent: string; message: string; context_note?: string }
      return await panel.askAgent(input.dept, input.agent, input.message, {
        userId: exec.principal?.userId,
        ...(input.context_note ? { contextNote: input.context_note } : {}),
      })
    },
  })

  ctx.tools.register({
    name: 'panel_skill_invoke',
    description: '点名调用技能平台上架的某个 Skill 并同步取回执行结果（面板对话框 /技能名 直调的同一服务原语）：'
      + '按技能名或 slug 全名匹配（须为已上架且对调用人组织开放的技能），取当前版本指令内容组装上下文，单轮调用模型网关。'
      + '失败诚实返回 ok:false + 原因（不存在/未上架/不可见/无内容/网关失败），不造假回复。',
    permission: 'panel.write',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '技能名或 slug（已上架 published 技能）' },
        message: { type: 'string', description: '要交给技能的输入/问题' },
        context_note: { type: 'string', description: '附加上下文说明（可选，拼入系统提示）' },
      },
      required: ['skill', 'message'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const input = args as { skill: string; message: string; context_note?: string }
      return await panel.invokeSkill(input.skill, input.message, {
        userId: exec.principal?.userId,
        ...(input.context_note ? { contextNote: input.context_note } : {}),
      })
    },
  })

  // -- M3 对话打通：战略看板聚合摘要（对话接地的轻量读法） --
  ctx.tools.register({
    name: 'panel_board_digest',
    description: '读取战略看板聚合摘要（近 7 天）：资产在线数、调用漏斗（曝光→点击→调用→完成）、计量与 ROI 估算、'
      + '指定平台卡片包标题清单。给对话/Agent 做看板接地的事实源（完整数据走 GET /api/panel/board）。',
    permission: 'panel.read',
    parameters: {
      type: 'object',
      properties: { platform: { type: 'string', description: `卡片包平台（${CARD_PLATFORMS.join('/')}），缺省 rd` } },
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const input = args as { platform?: string }
      const available = [...new Set(cardpacks.all().map((pack) => pack.platform))]
      const requested = input.platform ?? process.env.RQ_PLATFORM ?? (available.includes('rd') ? 'rd' : available[0]) ?? 'strategy'
      if (!CARD_PLATFORMS.includes(requested as CardPlatform)) {
        throw new Error(`platform 非法（应为 ${CARD_PLATFORMS.join('/')}）`)
      }
      const platform = requested as CardPlatform
      const info = exec.principal as { userId?: string } | undefined
      const iam = soft(ctx, 'iam')
      const user = info?.userId ? iam?.users().get(info.userId) : undefined
      const roles = user ? user.roleIds.map((roleId) => iam?.roles().get(roleId)?.code).filter((code): code is string => Boolean(code)) : []
      cardpacks.setRefAliveResolver(refAlive)
      const packs = cardpacks.forPlatform(platform)
      const { cards } = filterCards({ packs, roles, refAlive })

      const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
      const behaviorCount = (type: string): number => {
        return soft(ctx, 'behavior')?.query({ type, from: weekAgo }).total ?? 0
      }
      const usageTotals = soft(ctx, 'usage')?.totals({ from: weekAgo })
      const usageCount = usageTotals?.count ?? 0
      const chargeCents = usageTotals?.charge_cents ?? 0
      const completedCalls = soft(ctx, 'mcpRegistry')?.calls().all().filter((call) => call.ok && call.at >= weekAgo).length ?? 0
      const minutesPerCall = Number(process.env.ROI_MINUTES_PER_CALL ?? 3)
      const callBase = completedCalls > 0 ? completedCalls : usageCount
      return {
        generatedAt: new Date().toISOString(),
        windowDays: 7,
        platform,
        assets: {
          appsOnline: soft(ctx, 'resourceCore')?.list('app').filter((item) => item.status === 'online').length ?? 0,
          agentsOnline: soft(ctx, 'resourceCore')?.list('agent').filter((item) => item.status === 'online').length ?? 0,
          skillsPublished: soft(ctx, 'skillHub')?.skills().all().filter((item) => item.status === 'published').length ?? 0,
          mcpServing: soft(ctx, 'mcpRegistry')?.services().all().filter((service) => service.status === 'online' || service.status === 'gray').length ?? 0,
        },
        funnel: {
          exposed: behaviorCount('card.exposed'),
          clicked: behaviorCount('card.clicked'),
          invoked: usageCount,
          completed: completedCalls,
        },
        waic: { count: usageCount, chargeCents },
        roiEstimate: {
          callBase,
          estimatedHoursSaved: Math.round((callBase * minutesPerCall / 60) * 100) / 100,
          note: '估算口径（非实测）：替代工时 = 调用次数 × 单次替代分钟 ÷ 60',
        },
        cards: cards.map((card) => ({ id: card.id, title: card.title, badge: card.badge })),
      }
    },
  })

  // -- 制造工具箱（自「制造业 AI 工具集」并入，2026-10-19） --------------------------
  // 13 个确定性计算内核 + 3 个 AI 工具（Skill 放行制）+ 100 项选题清单。
  // 路由：/api/panel/mfg/*（读 panel.read / 执行 panel.write / 放行 panel.config.write）；
  // 工具：panel_mfg_*（共享 tools 键 → dsh 下即原生 ToolRuntime）。
  // 模型面经平台网关（modelgw / dsh llm 桥），面板零密钥；无网关时 AI 工具诚实 503。
  applyMfgModule(ctx, { guarded, changeLog, renderJson })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    panel: PanelService
  }
}
