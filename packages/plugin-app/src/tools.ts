/**
 * app 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolPrincipal } from '../../platform-core/src/index.ts'
import { t as translate } from '../../platform-i18n/src/index.ts'

export const name = 'app-tools'
export const inject = ['tools', 'appRegistry', 'resourceCore', 'iam', 'audit']

export function apply(ctx: Context) {
  const t = ctx.tools

  /** 登记类工具的调用方投影（fail-closed）：owner 取令牌身份，禁止从 args 组装。 */
  const registrarOf = (principal?: ToolPrincipal): { id: string; name: string } => {
    if (!principal) throw new Error(translate('工具执行缺少身份上下文（fail-closed）'))
    return { id: principal.userId ?? principal.principalId, name: principal.name }
  }

  t.register(defineTool({
    name: 'app_list',
    description: '列出 AI 应用本体（类型/状态过滤）。',
    permission: 'app.read',
    parameters: {
      status: { type: 'string', enum: ['draft', 'trial', 'online', 'offline', 'archived'], description: '状态' },
      q: { type: 'string', description: '关键字' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const apps = ctx.resourceCore.list('app', args)
      return {
        total: apps.length,
        apps: apps.map((app) => ({
          id: app.id, name: app.name, status: app.status, appType: app.attrs['appType'],
          url: app.attrs['url'], owner: app.attrs['ownerName'],
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'app_offline',
    description: '下架 AI 应用（L4 高危：生成审批单，审批通过后自动执行；联动下线能力服务并禁用 SSO 客户端）。必须给出 reason。',
    permission: 'app.offline',
    parameters: {
      appId: { type: 'string', required: true, description: '应用 ID' },
      reason: { type: 'string', required: true, description: '下架原因' },
      requesterId: { type: 'string', required: true, description: '发起人用户 ID（桥接面由服务端注入）' },
      requesterName: { type: 'string', required: true, description: '发起人姓名（桥接面由服务端注入）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const approval = ctx.appRegistry.requestOffline(args.appId, { id: args.requesterId, name: args.requesterName }, args.reason)
      const impact = ctx.resourceCore.impact('app', args.appId)
      return {
        approvalId: approval.id, status: approval.status, impact,
        note: '审批通过后将：下架应用 → 联动下线能力服务 → 禁用 SSO 客户端 → 保留审计数据',
      }
    },
  }))

  t.register(defineTool({
    name: 'app_topology',
    description: '查看应用依赖拓扑：应用 → Agent → MCP/Skill 一图穿透（异常节点标注）。',
    permission: 'app.read',
    parameters: {
      appId: { type: 'string', required: true, description: '应用 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return { topology: ctx.appRegistry.topology(args.appId) }
    },
  }))

  t.register(defineTool({
    name: 'app_metrics',
    description: '应用层指标：DAU/MAU、会话数、会话深度、留存与近 14 天序列。',
    permission: 'app.read',
    parameters: {
      appId: { type: 'string', required: true, description: '应用 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return ctx.appRegistry.metrics(args.appId)
    },
  }))

  t.register(defineTool({
    name: 'app_metrics_report',
    description: '上报应用层产品指标（PV/UV/DAU/会话数/会话深度/7 日留存，可指定 date 补录历史）。外部 AI 应用接入后据此向宿主推送运行指标，宿主侧做全生命周期监测。',
    permission: 'app.write',
    parameters: {
      appId: { type: 'string', required: true, description: '应用 ID' },
      pv: { type: 'integer', description: '页面浏览量 PV（同日多次上报累加）' },
      uv: { type: 'integer', description: '日独立访客 UV（同日多次上报取最大值）' },
      dau: { type: 'integer', description: '日活跃用户数（同日多次上报取最大值）' },
      sessions: { type: 'integer', description: '会话数（同日多次上报累加）' },
      avgDepth: { type: 'number', description: '平均会话深度' },
      retention7: { type: 'number', description: '7 日留存（0-1 小数）' },
      date: { type: 'string', description: '指标日期 YYYY-MM-DD（默认今天；补录历史时指定）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const appId = String(args.appId)
      ctx.appRegistry.recordUsage(appId, {
        ...(args.pv !== undefined ? { pv: Number(args.pv) } : {}),
        ...(args.uv !== undefined ? { uv: Number(args.uv) } : {}),
        ...(args.dau !== undefined ? { dau: Number(args.dau) } : {}),
        ...(args.sessions !== undefined ? { sessions: Number(args.sessions) } : {}),
        ...(args.avgDepth !== undefined ? { avgDepth: Number(args.avgDepth) } : {}),
        ...(args.retention7 !== undefined ? { retention7: Number(args.retention7) } : {}),
        ...(args.date !== undefined && args.date !== '' ? { date: String(args.date) } : {}),
      })
      return { reported: true, metrics: ctx.appRegistry.metrics(appId) }
    },
  }))

  t.register(defineTool({
    name: 'app_cost_breakdown',
    description: '成本穿透：应用 → Agent → MCP/模型 的 Token/调用/成本归集。',
    permission: 'app.read',
    parameters: {
      appId: { type: 'string', required: true, description: '应用 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return { rows: ctx.appRegistry.costBreakdown(args.appId) }
    },
  }))

  t.register(defineTool({
    name: 'app_register',
    description: '登记 AI 应用进平台台账（draft 态，登记即入治理轨道），可编排已上线 Agent（agentIds 编排仅接受 online 态），默认签发机器凭证（client_secret 仅本次返回）。发布上线走审批流。',
    permission: 'app.write',
    parameters: {
      name: { type: 'string', required: true, description: '应用名称' },
      slug: { type: 'string', description: '标识（缺省由名称生成）' },
      attrs: { type: 'object', description: '扩展属性。必填：description（应用描述）、appType（web/h5/miniapp/desktop/api）、riskLevel（low/medium/high）；上线前还需 url 与 dataClass（public/internal/confidential/secret）；developerId 可指定平台用户为开发者' },
      agentIds: { type: 'array', items: { type: 'string' }, description: '编排的 Agent ID 清单（仅接受已上线 Agent）' },
      orgId: { type: 'string', description: '归属组织 ID（缺省首个组织）' },
      withCredential: { type: 'boolean', description: '是否签发机器凭证，缺省 true' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const registrar = registrarOf(exec.principal)
      const attrs = { ...(args.attrs && typeof args.attrs === 'object' ? args.attrs as Record<string, unknown> : {}) }
      // 与 REST POST /api/apps 同口径：developerId 须为在编平台用户（校验失败即拒绝登记）
      const developerId = typeof attrs['developerId'] === 'string' ? attrs['developerId'].trim() : ''
      if (developerId) {
        const developer = ctx.iam.users().get(developerId)
        if (!developer) throw new Error(translate('开发者不存在：{id}（developerId 须为平台用户 ID）', { id: developerId }))
        if (developer.status !== 'active') throw new Error(translate('开发者非在编状态，不能登记为应用开发者'))
        attrs['developerId'] = developer.id
        attrs['developerName'] = developer.displayName
      } else {
        delete attrs['developerId']
      }
      const orgId = (args.orgId && ctx.iam.orgs().get(String(args.orgId)))
        ? String(args.orgId)
        : (ctx.iam.orgs().all()[0]?.id ?? 'org_unknown')
      const agentIds = Array.isArray(args.agentIds) ? (args.agentIds as unknown[]).map(String) : undefined
      const result = ctx.appRegistry.register({
        name: args.name,
        ...(args.slug ? { slug: String(args.slug) } : {}),
        attrs,
        ownerId: registrar.id,
        ownerName: registrar.name,
        orgId,
        ...(agentIds ? { agentIds } : {}),
        ...(args.withCredential !== undefined ? { withCredential: args.withCredential === true } : {}),
      })
      ctx.audit.record({
        type: 'change',
        actorType: exec.principal?.kind === 'human' ? 'human' : 'machine',
        actorId: registrar.id,
        actorName: registrar.name,
        action: 'app.create',
        resourceType: 'app',
        resourceId: (result.app as { id: string }).id,
        resourceName: (result.app as { name: string }).name,
        result: 'ok',
        detail: 'app_register 工具登记（draft）',
        ...(exec.principal?.actChain?.length ? { actChain: exec.principal.actChain } : {}),
      })
      return {
        app: { id: (result.app as { id: string }).id, name: (result.app as { name: string }).name, slug: (result.app as { slug: string }).slug, status: (result.app as { status: string }).status, orgId },
        ...(result.credential ? { credential: result.credential, credentialNote: 'client_secret 仅本次返回，请立即妥善保管；丢失走 onboarding-prompt(rotate=true) 轮换' } : {}),
        nextStep: '上线走审批流（trial → online），经 approval_list / approval_decide 处理',
      }
    },
  }))
}
