/**
 * agent 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolPrincipal } from '../../platform-core/src/index.ts'
import { t as translate } from '../../platform-i18n/src/index.ts'

export const name = 'agent-tools'
export const inject = ['tools', 'agentRegistry', 'resourceCore', 'iam', 'audit']

export function apply(ctx: Context) {
  const t = ctx.tools

  /** 登记/评审类工具的调用方投影（fail-closed）：owner 取令牌身份，禁止从 args 组装。 */
  const registrarOf = (principal?: ToolPrincipal): { id: string; name: string } => {
    if (!principal) throw new Error(translate('工具执行缺少身份上下文（fail-closed）'))
    return { id: principal.userId ?? principal.principalId, name: principal.name }
  }

  t.register(defineTool({
    name: 'agent_list',
    description: '列出 Agent 本体（支持状态/组织/关键字过滤，含健康与调用量）。',
    permission: 'agent.read',
    parameters: {
      status: { type: 'string', enum: ['draft', 'trial', 'online', 'offline', 'archived'], description: '状态' },
      q: { type: 'string', description: '名称/标识关键字' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const agents = ctx.resourceCore.list('agent', args)
      return {
        total: agents.length,
        agents: agents.map((agent) => {
          const metrics = ctx.agentRegistry.metrics(agent.id)
          return {
            id: agent.id, name: agent.name, slug: agent.slug, status: agent.status,
            model: agent.attrs['model'], owner: agent.attrs['ownerName'],
            calls: metrics.calls, successRate: metrics.successRate, tokens: metrics.tokens,
          }
        }),
      }
    },
  }))

  t.register(defineTool({
    name: 'agent_get',
    description: '查看 Agent 详情（属性、生命周期历史、绑定用户、监测指标、可用操作）。',
    permission: 'agent.read',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const agent = ctx.resourceCore.get('agent', args.agentId)
      if (!agent) throw new Error(translate('Agent 不存在：{id}', { id: args.agentId }))
      return {
        ...agent,
        metrics: ctx.agentRegistry.metrics(agent.id),
        boundUsers: ctx.agentRegistry.boundUsers(agent.id).map((item) => item.userName),
        availableTransitions: ctx.resourceCore.availableTransitions('agent', agent.id),
      }
    },
  }))

  t.register(defineTool({
    name: 'agent_offline',
    description: '下线 Agent（L4 高危：生成审批单，审批通过后自动执行；联动吊销机器凭证并通知绑定用户）。必须给出 reason。',
    permission: 'agent.offline',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent ID' },
      reason: { type: 'string', required: true, description: '下线原因' },
      requesterId: { type: 'string', required: true, description: '发起人用户 ID' },
      requesterName: { type: 'string', required: true, description: '发起人姓名' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const approval = ctx.agentRegistry.requestOffline(args.agentId, { id: args.requesterId, name: args.requesterName }, args.reason)
      const impact = ctx.resourceCore.impact('agent', args.agentId)
      return {
        approvalId: approval.id, status: approval.status, impact,
        note: '审批通过后将：下线 Agent → 吊销机器凭证 → 通知绑定用户 → 保留审计数据',
      }
    },
  }))

  t.register(defineTool({
    name: 'agent_metrics',
    description: '查看 Agent 运行监测：会话量、调用量、成功率、Token 消耗与成本、平均响应时长（近 14 天序列）。',
    permission: 'agent.read',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return ctx.agentRegistry.metrics(args.agentId)
    },
  }))

  t.register(defineTool({
    name: 'agent_metrics_report',
    description: '上报 Agent 运营指标（日活 DAU/对话会话数/对话用户去重统计，可指定 date 补录历史）。Agent 接入后的强制义务：每日定时向平台提报，与 AI 应用 metrics-report 同级；调用/成功率/Token 由平台网关自动归集，无须重复上报。',
    permission: 'agent.write',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent ID' },
      dau: { type: 'integer', description: '日活跃用户数（同日多次上报取最大值）' },
      sessions: { type: 'integer', description: '对话会话数（同日多次上报累加）' },
      uniqueUsers: { type: 'integer', description: '对话去重用户数（无法提供 ID 明细时只报数量；ID 明细走 REST userIds 字段）' },
      date: { type: 'string', description: '指标日期 YYYY-MM-DD（默认今天；补录历史时指定）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const agentId = String(args.agentId)
      ctx.agentRegistry.reportUsage(agentId, {
        ...(args.dau !== undefined ? { dau: Number(args.dau) } : {}),
        ...(args.sessions !== undefined ? { sessions: Number(args.sessions) } : {}),
        ...(args.uniqueUsers !== undefined ? { uniqueUsers: Number(args.uniqueUsers) } : {}),
        ...(args.date !== undefined && args.date !== '' ? { date: String(args.date) } : {}),
      })
      return { reported: true, metrics: ctx.agentRegistry.metrics(agentId) }
    },
  }))

  t.register(defineTool({
    name: 'agent_bind_user',
    description: '为 Agent 绑定用户（记录"哪些用户可使用该 Agent"，使用即授权留痕）。',
    permission: 'agent.write',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent ID' },
      userId: { type: 'string', required: true, description: '用户 ID' },
      actor: { type: 'string', description: '操作人' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const binding = ctx.agentRegistry.bindUser(args.agentId, args.userId, args.actor ?? 'agent-tool')
      return { agentId: binding.agentId, userId: binding.userId, boundAt: binding.boundAt }
    },
  }))

  t.register(defineTool({
    name: 'agent_register',
    description: '登记数字员工（Agent）进平台台账（draft 态，登记即入治理轨道），默认签发机器凭证（client_secret 仅本次返回）。上线走审批流：提交 agent.online 审批后经 approval_decide 通过（提交人与审批人不得为同一人）。',
    permission: 'agent.write',
    parameters: {
      name: { type: 'string', required: true, description: 'Agent 名称' },
      slug: { type: 'string', description: '标识（缺省由名称生成）' },
      attrs: { type: 'object', description: '扩展属性。必填：description（Agent 职责描述）、model（模型网关目录中已登记的 slug，model_list 可查；未登记的模型会被拒绝）、riskLevel（low/medium/high）；上线前还需 dataClass（public/internal/confidential/secret）' },
      orgId: { type: 'string', description: '归属组织 ID（缺省首个组织）' },
      withCredential: { type: 'boolean', description: '是否签发机器凭证，缺省 true' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const registrar = registrarOf(exec.principal)
      const orgId = (args.orgId && ctx.iam.orgs().get(String(args.orgId)))
        ? String(args.orgId)
        : (ctx.iam.orgs().all()[0]?.id ?? 'org_unknown')
      const result = ctx.agentRegistry.register({
        name: args.name,
        ...(args.slug ? { slug: String(args.slug) } : {}),
        ...(args.attrs && typeof args.attrs === 'object' ? { attrs: args.attrs as Record<string, unknown> } : {}),
        ownerId: registrar.id,
        ownerName: registrar.name,
        orgId,
        ...(args.withCredential !== undefined ? { withCredential: args.withCredential === true } : {}),
      })
      ctx.audit.record({
        type: 'change',
        actorType: exec.principal?.kind === 'human' ? 'human' : 'machine',
        actorId: registrar.id,
        actorName: registrar.name,
        action: 'agent.create',
        resourceType: 'agent',
        resourceId: (result.agent as { id: string }).id,
        resourceName: (result.agent as { name: string }).name,
        result: 'ok',
        detail: 'agent_register 工具登记（draft）',
        ...(exec.principal?.actChain?.length ? { actChain: exec.principal.actChain } : {}),
      })
      return {
        agent: { id: (result.agent as { id: string }).id, name: (result.agent as { name: string }).name, slug: (result.agent as { slug: string }).slug, status: (result.agent as { status: string }).status, orgId },
        ...(result.credential ? { credential: result.credential, credentialNote: 'client_secret 仅本次返回，请立即妥善保管；丢失走 onboarding-prompt(rotate=true) 轮换' } : {}),
        nextStep: '上线：agent_transition(agentId, action=online) 提交审批 → approval_list(kind=agent.online) → approval_decide（提交人与审批人须不同主体）',
      }
    },
  }))

  t.register(defineTool({
    name: 'agent_transition',
    description: 'Agent 生命周期流转：submit_trial（提交试运行）/ online（提交上线审批，L4）/ archive（归档）。online 与 agent_offline 一样生成审批单，经 approval_decide 通过后自动执行。',
    permission: 'agent.approve',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent ID' },
      action: { type: 'string', enum: ['submit_trial', 'online', 'archive'], required: true, description: '流转动作' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const registrar = registrarOf(exec.principal)
      const actor = { id: registrar.id, name: registrar.name }
      if (args.action === 'online') {
        const approval = ctx.agentRegistry.requestOnline(String(args.agentId), actor)
        return { approvalId: approval.id, status: approval.status, note: '上线为 L4 操作，已创建审批单；经 approval_decide 通过后自动执行（提交人与审批人不得为同一人）' }
      }
      if (args.action === 'submit_trial') return ctx.agentRegistry.trial(String(args.agentId), registrar.name, [])
      return ctx.agentRegistry.archive(String(args.agentId), registrar.name)
    },
  }))
}
