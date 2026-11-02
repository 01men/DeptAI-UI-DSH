/**
 * mcp 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolPrincipal, type WorkRefIndex } from '../../platform-core/src/index.ts'
import { t as translate } from '../../platform-i18n/src/index.ts'

export const name = 'mcp-tools'
export const inject = ['tools', 'mcpRegistry', 'authn', 'iam', 'audit', 'resourceCore']

/**
 * work 参数白名单提取（施工蓝本 §10.4：技术参数透传与可信作用域）：
 * work 只允许携带 permitId/runId/stepKey 三个索引键（仅作索引，授权事实一律服务端回查）；
 * 其他任何键（包括 caller、employeeId 等身份字段）一律忽略——身份与授权不来自请求参数。
 * 导出供 console REST 面（routes/mcp.ts /api/mcp/invoke）复用：工具与 REST 两个入口一套白名单口径。
 */
export function workRefFromArgs(raw: unknown): WorkRefIndex | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const pick = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)
  const permitId = pick((raw as Record<string, unknown>).permitId)
  const runId = pick((raw as Record<string, unknown>).runId)
  const stepKey = pick((raw as Record<string, unknown>).stepKey)
  const ref: WorkRefIndex = {
    ...(permitId !== undefined ? { permitId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(stepKey !== undefined ? { stepKey } : {}),
  }
  return Object.keys(ref).length > 0 ? ref : undefined
}

export function apply(ctx: Context) {
  const t = ctx.tools

  /** 调用方身份取自执行上下文（入口从令牌解析），缺失即 fail-closed；schema 不声明 caller* 参数。 */
  const callerFromPrincipal = (principal?: ToolPrincipal): { type: 'user' | 'agent' | 'app'; id: string; name: string } => {
    if (!principal) throw new Error(translate('工具执行缺少身份上下文（fail-closed）'))
    if (principal.kind === 'human') return { type: 'user', id: principal.userId ?? principal.principalId, name: principal.name }
    const record = ctx.authn.principals().get(principal.principalId)
    if (record?.refType === 'agent' && record.refId) return { type: 'agent', id: record.refId, name: principal.name }
    if (record?.refType === 'app' && record.refId) return { type: 'app', id: record.refId, name: principal.name }
    return { type: 'app', id: principal.principalId, name: principal.name }
  }

  /** 登记/评审类工具的调用方投影（fail-closed）：owner/审批人取令牌身份，禁止从 args 组装。 */
  const registrarOf = (principal?: ToolPrincipal): { id: string; name: string } => {
    if (!principal) throw new Error(translate('工具执行缺少身份上下文（fail-closed）'))
    return { id: principal.userId ?? principal.principalId, name: principal.name }
  }

  /** 工具面等价 changeLog（与 REST changeLog 同一 audit.record 口径，单点事实源）：登记/评审动作必落审计。 */
  const auditChange = (principal: ToolPrincipal | undefined, actor: { id: string; name: string }, action: string, resourceType: string, resourceId: string, resourceName: string, detail: string): void => {
    ctx.audit.record({
      type: 'change',
      actorType: principal?.kind === 'human' ? 'human' : 'machine',
      actorId: actor.id,
      actorName: actor.name,
      action,
      resourceType,
      resourceId,
      resourceName,
      result: 'ok',
      detail,
      ...(principal?.actChain?.length ? { actChain: principal.actChain } : {}),
    })
  }

  t.register(defineTool({
    name: 'mcp_service_list',
    description: '列出 MCP 服务（含健康状态、版本、灰度比例）。',
    permission: 'mcp.service.read',
    parameters: {
      status: { type: 'string', enum: ['draft', 'verifying', 'online', 'gray', 'unhealthy', 'offline'], description: '状态过滤' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const services = ctx.mcpRegistry.services().find((item) => (args.status ? item.status === args.status : true))
      return {
        total: services.length,
        services: services.map((item) => ({
          id: item.id, name: item.name, slug: item.slug, status: item.status,
          version: item.currentVersion, grayPercent: item.grayPercent,
          health: item.health.status, tools: item.tools.map((tool) => tool.name),
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'mcp_deploy',
    description: '部署/更新 MCP 服务（L3：支持灰度比例；dryRun 返回影响面预览）。',
    permission: 'mcp.service.deploy',
    parameters: {
      serviceId: { type: 'string', required: true, description: '服务 ID' },
      grayPercent: { type: 'number', description: '灰度比例 0-100，缺省 100（全量）' },
      changelog: { type: 'string', description: '变更说明' },
      dryRun: { type: 'boolean', description: 'true 时仅返回影响面预览，不执行' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const service = ctx.mcpRegistry.services().get(args.serviceId)
      if (!service) throw new Error(translate('MCP 服务不存在：{id}', { id: String(args.serviceId) }))
      const impact = ctx.resourceCore.impact('mcp_service', args.serviceId)
      if (args.dryRun) {
        return { dryRun: true, service: service.name, dependents: impact, note: translate('dry-run 未执行任何变更') }
      }
      const updated = await ctx.mcpRegistry.deployService(args.serviceId, {
        grayPercent: args.grayPercent,
        changelog: args.changelog,
        actor: 'agent-tool',
      })
      return { id: updated.id, status: updated.status, version: updated.currentVersion, grayPercent: updated.grayPercent }
    },
  }))

  t.register(defineTool({
    name: 'mcp_offline',
    description: '下线 MCP 服务（L4 高危：创建审批单，审批通过后自动执行）。必须给出 reason。',
    permission: 'mcp.service.offline',
    parameters: {
      serviceId: { type: 'string', required: true, description: '服务 ID' },
      reason: { type: 'string', required: true, description: '下线原因' },
      requesterId: { type: 'string', required: true, description: '发起人用户 ID' },
      requesterName: { type: 'string', required: true, description: '发起人姓名' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const impact = ctx.resourceCore.impact('mcp_service', args.serviceId)
      const approval = ctx.mcpRegistry.requestOfflineApproval(args.serviceId, { id: args.requesterId, name: args.requesterName }, args.reason, impact.map((item) => `${item.name}（${item.type}）`))
      return {
        approvalId: approval.id, status: approval.status,
        impact: impact,
        note: translate('已生成 L4 审批单，审批通过后自动执行下线并吊销相关令牌'),
      }
    },
  }))

  t.register(defineTool({
    name: 'mcp_metrics',
    description: '查看 MCP 服务运营监控：调用量、成功率、P95 延迟、Token 消耗、按调用方/工具统计。',
    permission: 'mcp.service.read',
    parameters: {
      serviceId: { type: 'string', required: true, description: '服务 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const metrics = ctx.mcpRegistry.serviceMetrics(args.serviceId)
      const service = ctx.mcpRegistry.services().get(args.serviceId)
      return { service: service?.name, ...metrics, series: metrics.series.slice(-30) }
    },
  }))

  // 【兼容层（MCP 治理契约 §9，W2-T3）】行为不变：Agent 标准默认路径是服务级数据面
  // POST /mcp/services/:serviceSlug（委托令牌 aud=mcp:service:<slug>，见 plugin-console
  // routes/mcp-dataplane.ts）。本工具仅供存量 Agent 工具面调用方过渡使用。
  t.register(defineTool({
    name: 'mcp_invoke',
    description: '通过 MCP 网关调用工具（统一鉴权/限流/审计）。调用方身份由服务端从令牌解析。（兼容层：Agent 标准默认路径是 POST /mcp/services/<服务slug> 服务级数据面）',
    permission: 'mcp.invoke',
    parameters: {
      serviceId: { type: 'string', required: true, description: '服务 ID' },
      tool: { type: 'string', required: true, description: '工具名' },
      args: { type: 'object', description: '工具参数' },
      work: {
        type: 'object',
        description: '工作引用索引（可选，仅 permitId/runId/stepKey 三个键）：只作索引透传，授权事实一律由服务端回查；其他键一律忽略',
      },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      return await ctx.mcpRegistry.invoke(callerFromPrincipal(exec.principal), args.serviceId, args.tool, args.args ?? {}, workRefFromArgs(args.work))
    },
  }))

  t.register(defineTool({
    name: 'mcp_health_check',
    description: '对 MCP 服务执行一次健康探测（熔断状态下可用于恢复确认）。',
    permission: 'mcp.service.deploy',
    parameters: {
      serviceId: { type: 'string', required: true, description: '服务 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return await ctx.mcpRegistry.healthCheck(args.serviceId)
    },
  }))

  t.register(defineTool({
    name: 'mcp_service_register',
    description: '登记 MCP 服务进平台台账（draft 态，登记即入治理轨道）。工具清单建议申报风险等级（未申报记 unknown，写能力须先过风险登记）。后续：mcp_service_review(action=verify) → mcp_deploy 发布上线。敏感凭证禁止明文传入（走 PUT /api/mcp/services/:id/credential）。',
    permission: 'mcp.service.write',
    parameters: {
      name: { type: 'string', required: true, description: '服务名称' },
      slug: { type: 'string', description: '服务标识（缺省由名称生成；重复即报错）' },
      description: { type: 'string', description: '服务描述' },
      endpoint: { type: 'string', description: '远端服务地址（external 形态必填；hosted 缺省自动生成平台内地址）' },
      transport: { type: 'string', enum: ['http', 'sse'], description: '传输形态，缺省 http' },
      mode: { type: 'string', enum: ['hosted', 'external'], description: '托管形态，缺省 hosted' },
      orgId: { type: 'string', description: '归属组织 ID（缺省根组织）' },
      tools: {
        type: 'array',
        description: '工具清单申报 [{ name, description, riskLevel(read/write/admin/unknown), inputSchema }]',
        items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, riskLevel: { type: 'string' }, inputSchema: { type: 'object' } } },
      },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const registrar = registrarOf(exec.principal)
      const orgId = args.orgId ?? ctx.iam.orgs().findOne((org) => org.parentId === null)?.id
      if (!orgId) throw new Error(translate('组织数据未初始化，无法登记（缺少根组织）'))
      const tools = Array.isArray(args.tools) ? (args.tools as Array<Record<string, unknown>>).map((tool) => ({
        name: String(tool['name'] ?? ''),
        description: String(tool['description'] ?? ''),
        // 与 REST POST /api/mcp/services 同口径：风险缺省不隐式 read——未申报即 unknown
        riskLevel: (['read', 'write', 'admin'].includes(String(tool['riskLevel'])) ? tool['riskLevel'] : 'unknown') as 'read' | 'write' | 'admin' | 'unknown',
        ...(tool['inputSchema'] && typeof tool['inputSchema'] === 'object' && Object.keys(tool['inputSchema'] as object).length > 0
          ? { inputSchema: tool['inputSchema'] as Record<string, unknown> }
          : { inputSchema: { type: 'object', properties: {}, additionalProperties: true } }),
      })) : undefined
      const service = ctx.mcpRegistry.createService({
        name: args.name,
        ...(args.slug ? { slug: args.slug } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.endpoint ? { endpoint: args.endpoint } : {}),
        ...(args.transport ? { transport: args.transport } : {}),
        ...(args.mode ? { mode: args.mode } : {}),
        orgId,
        owner: registrar.name,
        ...(tools ? { tools } : {}),
      })
      auditChange(exec.principal, registrar, 'mcp.service.create', 'mcp_service', service.id, service.name, 'mcp_service_register 工具登记（draft）')
      return {
        id: service.id, name: service.name, slug: service.slug, status: service.status,
        tools: service.tools.map((tool) => tool.name),
        nextStep: 'mcp_service_review(serviceId, action=verify) → mcp_deploy(serviceId)',
      }
    },
  }))

  t.register(defineTool({
    name: 'mcp_service_review',
    description: 'MCP 服务评审动作：verify（测试验证，draft 起健康探测）/ final-review（公司级终审标记，后续调用附带水印）/ sync-tools（以远端 tools/list 刷新工具清单）。发布上线用 mcp_deploy。',
    permission: 'mcp.service.deploy',
    parameters: {
      serviceId: { type: 'string', required: true, description: '服务 ID' },
      action: { type: 'string', enum: ['verify', 'final-review', 'sync-tools'], required: true, description: '评审动作' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const reviewer = registrarOf(exec.principal)
      const service = ctx.mcpRegistry.services().get(args.serviceId)
      if (!service) throw new Error(translate('MCP 服务不存在：{id}', { id: String(args.serviceId) }))
      if (args.action === 'verify') {
        const updated = await ctx.mcpRegistry.verifyService(args.serviceId)
        auditChange(exec.principal, reviewer, 'mcp.service.verify', 'mcp_service', updated.id, updated.name, 'mcp_service_review 工具测试验证')
        return { id: updated.id, status: updated.status, health: updated.health }
      }
      if (args.action === 'final-review') {
        const mark = { approverId: reviewer.id, approverName: reviewer.name, at: new Date().toISOString() }
        const updated = ctx.mcpRegistry.services().update(args.serviceId, { finalReview: mark })
        auditChange(exec.principal, reviewer, 'mcp.final_review', 'mcp_service', updated.id, updated.name, 'mcp_service_review 工具公司级终审标记：后续调用附带水印')
        return { id: updated.id, finalReview: updated.finalReview }
      }
      const synced = await ctx.mcpRegistry.syncTools(args.serviceId)
      auditChange(exec.principal, reviewer, 'mcp.service.syncTools', 'mcp_service', synced.id, synced.name, `mcp_service_review 工具同步（tools=${synced.tools.length}）`)
      return { id: synced.id, tools: synced.tools.map((tool) => tool.name) }
    },
  }))
}
