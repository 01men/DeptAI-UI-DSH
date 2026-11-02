/**
 * audit 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'

export const name = 'audit-tools'
export const inject = ['tools', 'audit']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'audit_logs',
    description: '查询审计日志（认证/授权/调用/变更四类），支持按资源、操作人、时间回溯。',
    permission: 'audit.read',
    parameters: {
      type: { type: 'string', enum: ['auth', 'authz', 'invoke', 'change'], description: '日志类型' },
      resourceId: { type: 'string', description: '资源 ID 精确过滤' },
      since: { type: 'string', description: '起始时间 ISO 串' },
      limit: { type: 'number', description: '返回条数，默认 50' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return ctx.audit.query({ ...args, limit: args.limit ?? 50 })
    },
  }))

  t.register(defineTool({
    name: 'audit_alerts_list',
    description: '查看平台告警（含未读临界/警告），用于异常排查入口。',
    permission: 'audit.read',
    parameters: {
      unreadOnly: { type: 'boolean', description: '仅未读' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const alerts = ctx.audit.alerts().find((alert) => (args.unreadOnly ? !alert.read : true))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return { total: alerts.length, alerts: alerts.slice(0, 50) }
    },
  }))

  t.register(defineTool({
    name: 'audit_alerts_read_all',
    description: '告警中心一键全部已读（处理完毕后批量清理未读状态），返回本次标记条数。',
    permission: 'audit.read',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      return { read: ctx.audit.markAllAlertsRead() }
    },
  }))

  t.register(defineTool({
    name: 'approval_decide',
    description: '审批中心决策（approve/reject）。agent.online 类（雇佣语义）审批提交人与审批人不得为同一人（R12 职责分离），其余类型已放开同人审批。',
    permission: 'approval.decide',
    parameters: {
      approvalId: { type: 'string', required: true, description: '审批单 ID' },
      decision: { type: 'string', enum: ['approve', 'reject'], required: true },
      approverId: { type: 'string', required: true, description: '审批人用户 ID' },
      approverName: { type: 'string', required: true, description: '审批人姓名' },
      opinion: { type: 'string', description: '审批意见' },
      confirmed: { type: 'boolean', description: '高风险 L4 审批通过必须显式 true 二次确认；缺省 false 由服务端 fail-closed 拦截' },
      finalReview: { type: 'boolean', description: '可选，通过后附加公司级终审标记' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const record = await ctx.audit.decideApproval(args.approvalId, args.decision, args.approverId, args.approverName, args.opinion, {
        confirmed: args.confirmed === true,
        ...(args.finalReview !== undefined ? { finalReview: args.finalReview === true } : {}),
      })
      return { id: record.id, status: record.status, execution: record.execution }
    },
  }))

  t.register(defineTool({
    name: 'approval_list',
    description: '查询审批列表（待办/已决/已执行），自治治理闭环入口：先 approval_list 发现待办，再 approval_decide 决策。默认最新在前。',
    permission: 'approval.read',
    parameters: {
      status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'executed', 'failed', 'superseded'], description: '状态过滤（缺省全部）' },
      kind: { type: 'string', description: '审批类型精确过滤（如 agent.online / mcp.offline / skill.publish）' },
      q: { type: 'string', description: '标题关键字' },
      limit: { type: 'number', description: '返回条数，默认 50' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const items = ctx.audit.approvals().all()
        .filter((item) => (args.status ? item.status === args.status : true))
        .filter((item) => (args.kind ? item.kind === args.kind : true))
        .filter((item) => (args.q ? item.title.includes(args.q) : true))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return {
        total: items.length,
        pending: items.filter((item) => item.status === 'pending').length,
        approvals: items.slice(0, args.limit ?? 50).map((item) => ({
          id: item.id, kind: item.kind, title: item.title, status: item.status,
          riskLevel: item.riskLevel, requesterName: item.requesterName, createdAt: item.createdAt,
          ...(item.decidedAt ? { decidedAt: item.decidedAt, approverName: item.approverName } : {}),
          ...(item.opinion ? { opinion: item.opinion } : {}),
          ...(item.execution ? { execution: item.execution } : {}),
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'audit_cost_report',
    description: '成本穿透分析：按应用/Agent/组织/日期聚合 Token 消耗与成本。',
    permission: 'audit.read',
    parameters: {
      groupBy: { type: 'string', enum: ['app', 'agent', 'org', 'date'], required: true, description: '聚合维度' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return { groupBy: args.groupBy, rows: ctx.audit.costReport(args.groupBy, args.from, args.to) }
    },
  }))
}
