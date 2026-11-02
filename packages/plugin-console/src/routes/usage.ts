/**
 * Usage 域路由：用量透明月度报表（J4 契约）+ 模型网关（统一模型接入/渠道调用/密钥托管/用量透明计量）（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出，处理器逐字搬运（行为与迁出前一致）。
 * 设计适配（2026-10-14，规格 5.5/5.4）新增：用量与成本日报 GET /api/usage/report、
 * 模型网关 30 天消耗 GET /api/modelgw/routes-usage——全部 usage 事件真实聚合。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConsoleRouteDeps } from './deps.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import { scopedOrgFilterOf } from './iam.ts'

export function registerUsageRoutes(ctx: Context, deps: ConsoleRouteDeps): void {
  const { http, guarded, body, changeLog, caller } = deps
  // -- 用量透明月度报表（M0-3；J4 契约：docs/contract-j4-usage-report.md） ----------------
  // 部门/Agent/Skill 三维 tokens 聚合 + 零价快照口径；format=csv 自助导出（Excel 友好 BOM）。
  guarded('GET', '/api/usage/report/monthly', 'usage.read', (exchange) => {
    const monthParam = exchange.query.get('month') ?? undefined
    const report = ctx.usage.monthlyReport(monthParam)
    if ((exchange.query.get('format') ?? '') !== 'csv') return report
    const esc = (value: string | number) => {
      const text = String(value)
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
    }
    const header = t('维度,维度值,事件数,tokens,charge_cents(零价快照恒0),cost_cents(内部成本参考),nonbillable事件数')
    const lines = [header]
    const pushRows = (name: string, rows: Array<{ dimension: string; events: number; tokens: number; charge_cents: number; cost_cents: number; nonbillable_events: number }>) => {
      for (const row of rows) lines.push([name, esc(row.dimension), row.events, row.tokens, row.charge_cents, row.cost_cents, row.nonbillable_events].join(','))
    }
    pushRows('total', [report.totals])
    pushRows('org', report.byOrg)
    pushRows('agent', report.byAgent)
    pushRows('skill', report.bySkill)
    pushRows('model', report.byModel)
    // 直接写原始响应（guarded 包装器对返回值做 JSON 序列化，流式文件下载须绕开）
    exchange.res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="usage-report-${report.month}.csv"`,
    })
    exchange.res.end('\ufeff' + lines.join('\r\n') + '\r\n')
    return undefined
  })

  // -- 协作链计量查询（C4 A2A/UHP 协作面 additive） ----------------------------
  // 按contextId 归集「一次跨员工协作的总成本」：?context=<id> 查单链明细；缺省返回窗口 Top 协作链。
  guarded('GET', '/api/usage/collaborations', 'usage.read', (exchange) => {
    const context = exchange.query.get('context') ?? ''
    if (context) return { contextId: context, events: ctx.usage.collaborationEvents(context) }
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 30) || 30, 1), 365)
    const from = new Date(Date.now() - days * 86_400_000).toISOString()
    return { from, top: ctx.usage.collaborationSummary(from, Math.min(Number(exchange.query.get('limit') ?? 20) || 20, 100)) }
  })

  // -- 用量与成本报表（设计适配规格 5.5，2026-10-14） --------------------------
  // 28 天（可调 1-90）用量报表：日序列 / 部门分摊（占比+环比）/ Top 资产 / 单位 DAU 成本。
  // 全部 usage 事件真实聚合（usageReport 只读方法）；dim 只影响 topAssets 排序与占比基数，
  // 两个维度的数值始终一并返回（前端 tokens/成本双维度切换零额外请求）。
  guarded('GET', '/api/usage/report', 'usage.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 28) || 28, 1), 90)
    const dim = exchange.query.get('dim') === 'cost' ? 'cost' : 'tokens'
    const now = new Date()
    const from = new Date(now.getTime() - days * 86_400_000).toISOString()
    const prevFrom = new Date(now.getTime() - 2 * days * 86_400_000).toISOString()
    const current = ctx.usage.usageReport(from)
    const previous = ctx.usage.usageReport(prevFrom, from)

    // 日序列补齐空日（无计量事件的日期给 0，图表不断轴）
    const axis: string[] = []
    for (let i = days - 1; i >= 0; i--) axis.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10))
    const dayMap = new Map(current.byDay.map((row) => [row.day, row]))
    const series = axis.map((date) => {
      const row = dayMap.get(date)
      return { date, tokens: row?.tokens ?? 0, cost: row?.cost_cents ?? 0, calls: row?.calls ?? 0 }
    })

    // 部门分摊：占比按 dim 选定的基数（tokens 或内部成本分）；环比 = (本期−上期)/上期
    const orgName = (orgId: string) => ctx.iam.orgs().get(orgId)?.name ?? orgId
    const prevByOrg = new Map(previous.byOrg.map((row) => [row.org, row]))
    const totalDim = dim === 'cost'
      ? current.byOrg.reduce((sum, row) => sum + row.cost_cents, 0)
      : current.byOrg.reduce((sum, row) => sum + row.tokens, 0)
    const byOrg = current.byOrg.map((row) => {
      const value = dim === 'cost' ? row.cost_cents : row.tokens
      const prevValue = dim === 'cost' ? (prevByOrg.get(row.org)?.cost_cents ?? 0) : (prevByOrg.get(row.org)?.tokens ?? 0)
      return {
        org: orgName(row.org),
        orgId: row.org,
        tokens: row.tokens,
        cost: row.cost_cents,
        calls: row.calls,
        share: totalDim > 0 ? Math.round((value / totalDim) * 1000) / 10 : 0,
        delta: prevValue === 0 ? (value === 0 ? 0 : null) : Math.round(((value - prevValue) / prevValue) * 1000) / 10,
      }
    })

    // Top 资产：资源键沿用 usage 计量 resource（mcp:<slug>/model:<slug>/app:<slug>/skill:<id>/nas:<id>/agent:<id>）
    const RESOURCE_KIND_LABELS: Record<string, string> = {
      mcp: t('MCP 服务'), model: t('模型路由'), skill: 'Skill', nas: t('NAS 存储'), app: t('AI 应用'), agent: 'Agent', kb: t('知识包'), panel: t('部门面板'), connector: t('连接器'),
    }
    const labelOfResource = (resource: string) => {
      const idx = resource.indexOf(':')
      const kind = idx >= 0 ? resource.slice(0, idx) : ''
      const key = idx >= 0 ? resource.slice(idx + 1) : resource
      const fallback = t('{label} {key}', { label: RESOURCE_KIND_LABELS[kind] ?? t('资产'), key })
      if (kind === 'mcp') return ctx.mcpRegistry.services().findOne((item) => item.slug === key)?.name ?? fallback
      if (kind === 'model') return ctx.modelGateway.models().findOne((item) => item.slug === key)?.displayName ?? fallback
      if (kind === 'skill') return ctx.skillHub.skills().get(key)?.name ?? fallback
      if (kind === 'nas') return ctx.nasRegistry.get(key)?.name ?? fallback
      if (kind === 'app') return ctx.resourceCore.list('app').find((item) => item.slug === key)?.name ?? fallback
      if (kind === 'agent') return ctx.resourceCore.list('agent').find((item) => item.id === key)?.name ?? fallback
      return fallback
    }
    const topAssets = current.byResource.slice(0, 10).map((row) => ({
      key: row.resource,
      name: labelOfResource(row.resource),
      cost: row.cost_cents,
      calls: row.calls,
      tokens: row.tokens,
    }))

    // 单位 DAU 成本：app/agent 域运营提报 DAU（appRegistry/agentRegistry usage 集合窗口求和）；
    // 拿不到 DAU 的资产不入列（诚实空态，规格 5.5 前端空数组语义）
    const fromDay = from.slice(0, 10)
    const costByResource = new Map(current.byResource.map((row) => [row.resource, row]))
    const unitDau: Array<{ key: string; name: string; costPerDau: number; dau: number }> = []
    for (const app of ctx.resourceCore.list('app')) {
      const dau = ctx.appRegistry.usage().find((row) => row.appId === app.id && row.date >= fromDay)
        .reduce((sum, row) => sum + (row.dau ?? 0), 0)
      if (dau <= 0) continue
      const cost = costByResource.get(`app:${app.slug}`)?.cost_cents ?? 0
      unitDau.push({ key: `app:${app.slug}`, name: app.name, costPerDau: dau > 0 ? Math.round((cost / dau) * 100) / 100 : 0, dau })
    }
    for (const agent of ctx.resourceCore.list('agent')) {
      const dau = ctx.agentRegistry.usage().find((row) => row.agentId === agent.id && row.date >= fromDay)
        .reduce((sum, row) => sum + (row.dau ?? 0), 0)
      if (dau <= 0) continue
      const cost = costByResource.get(`agent:${agent.id}`)?.cost_cents ?? 0
      unitDau.push({ key: `agent:${agent.id}`, name: agent.name, costPerDau: Math.round((cost / dau) * 100) / 100, dau })
    }

    return {
      days,
      dim,
      series,
      byOrg,
      topAssets,
      unitDau: unitDau.sort((a, b) => b.costPerDau - a.costPerDau),
    }
  })

  // -- 模型网关 30 天消耗（设计适配规格 5.4，2026-10-14） ------------------------
  // 独立端点而非并入 /api/modelgw/models 的理由：models 是治理 CRUD 面（登记/编辑/删除都在消费它），
  // 30d 消耗是 usage 事件的滚动聚合——两者变更节奏与消费方都不同；拆开可让网关页独立取数，
  // 也避免 models 列表在注册表单等场景无谓携带聚合开销。share=该路由 tokens 占模型域总量比例。
  guarded('GET', '/api/modelgw/routes-usage', 'modelgw.read', () => {
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const rows = ctx.usage.usageReport(from).byResource.filter((row) => row.resource.startsWith('model:'))
    const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0)
    const routes = rows.map((row) => ({
      model: row.resource.slice('model:'.length),
      tokens30d: row.tokens,
      share: totalTokens > 0 ? Math.round((row.tokens / totalTokens) * 1000) / 10 : 0,
      cost30d: row.cost_cents,
      calls30d: row.calls,
    }))
    // 已登记但窗口内零消耗的路由也列出（tokens30d=0：诚实呈现「登记未用」而非缺行）
    for (const model of ctx.modelGateway.models().all()) {
      if (routes.some((row) => row.model === model.slug)) continue
      routes.push({ model: model.slug, tokens30d: 0, share: 0, cost30d: 0, calls30d: 0 })
    }
    return {
      days: 30,
      totalTokens30d: totalTokens,
      totalCost30d: rows.reduce((sum, row) => sum + row.cost_cents, 0),
      routes: routes.sort((a, b) => b.tokens30d - a.tokens30d),
    }
  })

  // -- 模型网关（M0-3：统一模型接入 + 用量透明计量） ---------------------------
  guarded('GET', '/api/modelgw/models', 'modelgw.read', () => ({
    models: ctx.modelGateway.models().all().map((item) => ({ ...item, apiKey: item.apiKey.startsWith('env:') ? item.apiKey : '***' })),
  }))

  guarded('POST', '/api/modelgw/models', 'modelgw.admin', (exchange) => {
    const input = body<{ slug: string; displayName?: string; provider?: string; endpoint: string; apiKey?: string; costCentsPerKTokens?: number; inputCostCentsPerKTokens?: number; status?: 'online' | 'offline'; dataClassLimit?: 'public' | 'internal' | 'secret' }>(exchange)
    // #14：费率字段缺省时保留既有值（此前 `?? 0` 会把未勾选费率的保存静默清零价格簿，成本归集跟着归零）
    const existing = ctx.modelGateway.models().findOne((item) => item.slug === input.slug)
    const model = ctx.modelGateway.upsertModel({
      slug: input.slug,
      displayName: input.displayName ?? input.slug,
      provider: input.provider ?? 'external',
      endpoint: input.endpoint,
      apiKey: input.apiKey ?? 'env:MODEL_API_KEY',
      costCentsPerKTokens: input.costCentsPerKTokens ?? existing?.costCentsPerKTokens ?? 0,
      ...(input.inputCostCentsPerKTokens !== undefined
        ? { inputCostCentsPerKTokens: input.inputCostCentsPerKTokens }
        : (existing?.inputCostCentsPerKTokens !== undefined ? { inputCostCentsPerKTokens: existing.inputCostCentsPerKTokens } : {})),
      status: input.status ?? 'online',
      ...(input.dataClassLimit !== undefined ? { dataClassLimit: input.dataClassLimit } : {}),
    })
    changeLog(exchange, 'modelgw.model.upsert', 'model', model.id, model.slug, t('分级上限={limit}', { limit: model.dataClassLimit ?? 'internal' }))
    return model
  })

  /** 删除模型：从模型目录移除登记；计量与审计数据保留。 */
  guarded('DELETE', '/api/modelgw/models/:id', 'modelgw.admin', (exchange) => {
    const id = exchange.params['id']!
    const model = ctx.modelGateway.models().get(id)
    if (!model) throw new Error(t('模型不存在：{id}', { id }))
    ctx.modelGateway.models().remove(id)
    changeLog(exchange, 'modelgw.delete', 'model', id, model.slug)
    return { deleted: true }
  })

  guarded('POST', '/api/modelgw/invoke', 'modelgw.invoke', async (exchange) => {
    const info = caller(exchange)
    const input = body<{ model: string; messages: Array<{ role: string; content: string }>; orgId?: string; maxTokens?: number; temperature?: number; dataClass?: 'public' | 'internal' | 'secret' }>(exchange)
    // 默认用量归口组织：调用者所属组织（人）或凭证组织（机器）
    const orgId = input.orgId
      ?? (info.kind === 'human' && info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined)
    if (!orgId) throw new Error(t('未指定用量归口组织（orgId），且调用者无可归属组织'))
    // 计量主体：human=user:<id>；machine 凭证关联 Agent 时=agent:<refId>（usage.recorded 回灌 Agent 台账的依据），其余机器=app:<principalId>
    const subject = info.kind === 'human'
      ? `user:${info.userId ?? info.principalId}`
      : (info.refType === 'agent' && info.refId ? `agent:${info.refId}` : `app:${info.principalId}`)
    return await ctx.modelGateway.invoke({
      model: input.model,
      messages: input.messages,
      orgId,
      subject,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.dataClass !== undefined ? { dataClass: input.dataClass } : {}),
    })
  })

  // R11 多公司收口：审批清单按组织子树收敛（`*` 豁免；无归属存量单对非 `*` 不可见）
  guarded('GET', '/api/approvals', 'approval.read', (exchange) => {
    const orgFilter = scopedOrgFilterOf(ctx, caller, exchange)
    return {
      approvals: ctx.audit.approvals().all()
        .filter((item) => (orgFilter ? orgFilter(item.orgId) : true))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }
  })

  guarded('POST', '/api/approvals/:id/decide', 'approval.decide', async (exchange) => {
    const { decision, opinion, confirmed, finalReview } = body<{ decision: 'approve' | 'reject'; opinion?: string; confirmed?: boolean; finalReview?: boolean }>(exchange)
    const info = caller(exchange)
    const record = await ctx.audit.decideApproval(exchange.params['id']!, decision, info.userId ?? info.principalId, info.name, opinion, { confirmed, finalReview })
    return record
  })

  /** 删除审批单：仅「已驳回」单可删（Skill/Agent/应用等各资产驳回单统一走此口清理）；审计数据保留。 */
  guarded('DELETE', '/api/approvals/:id', 'approval.decide', (exchange) => {
    const id = exchange.params['id']!
    const record = ctx.audit.approvals().get(id)
    if (!record) throw new Error(t('审批单不存在：{id}', { id }))
    ctx.audit.deleteApproval(id)
    changeLog(exchange, 'approval.delete', 'approval', id, record.title, t('清理驳回审批单（kind={kind}）', { kind: record.kind }))
    return { deleted: true }
  })

  /** 审批 SLA 看板（WP-10）：≤2 工作日达成率可查（L2 审批周期指标口径）。 */
  guarded('GET', '/api/approvals/sla', 'approval.read', (exchange) => {
    const windowDays = Number(exchange.query.get('windowDays') ?? 30) || 30
    return ctx.audit.slaReport(Math.min(Math.max(windowDays, 1), 365))
  })

}
