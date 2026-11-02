/**
 * connector 插件对模型/CLI/工具桥暴露的工具（defineTool → ctx.tools 三端自动同契约）。
 * 权限点与 REST 对齐；身份与组织范围一律取自执行上下文 exec.principal（入口从令牌解析注入），
 * schema 不声明 caller 星号参数与 orgId——上下文缺失即 fail-closed，杜绝自填身份与跨 org 枚举。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'
import { t as translate } from '../../platform-i18n/src/index.ts'

export const name = 'connector-tools'
export const inject = ['tools', 'connectorHub']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'connector_catalog_search',
    description: '搜索连接器目录：providers 与 actions（含 riskLevel/requiredScopes/inputSchema）。',
    permission: 'connector.catalog.read',
    parameters: {
      keyword: { type: 'string', description: '按 provider/action 关键词过滤' },
      service: { type: 'string', description: '限定 provider（service id）' },
      kind: { type: 'string', enum: ['providers', 'actions'], description: '缺省两者都返回' },
      limit: { type: 'number', description: '返回条数上限，默认 50' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const catalog = await ctx.connectorHub.catalog()
      if (!catalog) return { error: translate('目录尚未同步：请先执行 connector gateway health + 目录同步') }
      const keyword = (args.keyword ?? '').toLowerCase()
      const limit = Math.min(Number(args.limit ?? 50), 200)
      const matchAction = (action: { id: string; service: string; description?: string }): boolean =>
        (!args.service || action.service === args.service)
        && (!keyword || `${action.id} ${action.service} ${action.description ?? ''}`.toLowerCase().includes(keyword))
      const providers = args.kind === 'actions' ? [] : catalog.providers
        .filter((provider) => String(provider['service'] ?? '').length > 0
          && (!args.service || String(provider['service']) === args.service)
          && (!keyword || JSON.stringify(provider).toLowerCase().includes(keyword)))
        .slice(0, limit)
      const actions = args.kind === 'providers' ? [] : catalog.actions.filter(matchAction).slice(0, limit)
      return { totalProviders: providers.length, totalActions: actions.length, skippedServices: catalog.skippedServices, providers, actions }
    },
  }))

  t.register(defineTool({
    name: 'connector_connection_list',
    description: '列出连接器连接引用（org 内；含脱敏 profile——平台永不回显凭证原文）。',
    permission: 'connector.connection.read',
    parameters: {
      provider: { type: 'string', description: '按 provider 过滤' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      // org 范围由服务端从执行上下文收敛（与 REST restrictOrgScope 同一逻辑），不接受入参
      const orgScope = ctx.connectorHub.orgScopeFor(exec.principal)
      if (orgScope === null) return { total: 0, connections: [], note: translate('当前身份无组织归属，连接可见范围为空（fail-closed）') }
      const refs = ctx.connectorHub.connections().find((item) =>
        (orgScope === undefined || item.ownerOrgId === orgScope) && (!args.provider || item.provider === args.provider))
      return {
        total: refs.length,
        connections: refs.map((item) => ({
          id: item.id, alias: item.alias, provider: item.provider, authType: item.authType,
          status: item.status, ownerOrgId: item.ownerOrgId, bridge: item.bridge,
          ocConnectionId: item.ocConnectionId,
          ...(item.maskedProfile ? { maskedProfile: item.maskedProfile } : {}),
          updatedAt: item.updatedAt,
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'connector_execute',
    description: '通过连接器网关调用 SaaS action：工作级准入（受管数字员工）+ 六步链（RBAC→权限组→审批→限流→oct_ 令牌→数据面）。admin 级 action 会返回审批单。',
    permission: 'connector.invoke',
    parameters: {
      actionId: { type: 'string', required: true, description: 'action ID（如 hackernews.get_top_stories）' },
      input: { type: 'object', description: 'action 入参' },
      connection: { type: 'string', description: '指定命名连接别名（org:<orgId>:<name>）' },
      dryRun: { type: 'boolean', description: 'true 时只做授权链预演不真实调用' },
      work: {
        type: 'object',
        description: '工作授权引用索引（§10.4：仅索引透传，授权事实由服务端回查）：permitId/runId/stepKey',
        properties: {
          permitId: { type: 'string', description: '工作授权 permit ID' },
          runId: { type: 'string', description: '执行 run ID' },
          stepKey: { type: 'string', description: '业务步骤键（同键同参重投复用稳定幂等键）' },
        },
      },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      // 调用方身份取自执行上下文（入口从令牌解析），缺失即 fail-closed，不再有共享身份兜底
      const work = (args.work ?? {}) as { permitId?: unknown; runId?: unknown; stepKey?: unknown }
      const workRef = {
        ...(typeof work.permitId === 'string' && work.permitId ? { permitId: work.permitId } : {}),
        ...(typeof work.runId === 'string' && work.runId ? { runId: work.runId } : {}),
        ...(typeof work.stepKey === 'string' && work.stepKey ? { stepKey: work.stepKey } : {}),
      }
      return await ctx.connectorHub.invokeAction(ctx.connectorHub.callerFromPrincipal(exec.principal), {
        actionId: args.actionId,
        input: args.input ?? {},
        ...(args.connection ? { alias: args.connection } : {}),
        ...(args.dryRun ? { dryRun: true } : {}),
        ...(Object.keys(workRef).length > 0 ? { workRef } : {}),
      })
    },
  }))

  t.register(defineTool({
    name: 'connector_perm_group_list',
    description: '列出连接器权限组（policies/subjects/rateLimitPerMin 与令牌台账状态）。',
    permission: 'connector.connection.read',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const orgScope = ctx.connectorHub.orgScopeFor(exec.principal)
      if (orgScope === null) return { total: 0, groups: [], note: translate('当前身份无组织归属，权限组可见范围为空（fail-closed）') }
      const groups = ctx.connectorHub.permGroups().find((group) => (orgScope === undefined || group.orgId === orgScope))
      return {
        total: groups.length,
        groups: groups.map((group) => ({
          id: group.id, name: group.name, orgId: group.orgId, description: group.description,
          policies: Object.fromEntries(Object.entries(group.policies).map(([service, policy]) => [
            service,
            {
              allowedActions: policy.allowedActions, riskCap: policy.riskCap,
              connections: policy.connections ?? [],
              readOnly: Boolean(policy.constraints?.readOnly),
              denyParams: policy.constraints?.denyParams ?? [],
            },
          ])),
          subjects: group.subjects, rateLimitPerMin: group.rateLimitPerMin,
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'connector_run_list',
    description: '查看连接器网关 run 日志（runs 对账视图：runtimeTokenId 维度，只读）。',
    permission: 'connector.runs.read',
    parameters: {
      service: { type: 'string', description: '按 provider 过滤' },
      ok: { type: 'boolean', description: '按成败过滤' },
      limit: { type: 'number', description: '条数上限默认 100' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return await ctx.connectorHub.listRunsView({
        ...(args.service ? { service: args.service } : {}),
        ...(typeof args.ok === 'boolean' ? { ok: args.ok } : {}),
        limit: Number(args.limit ?? 100),
      })
    },
  }))
}
