/**
 * Fleet 资产台账路由（设计适配规格 5.2，2026-10-14）：
 * 六类资产（MCP/Agent/AI 应用/Skill/模型路由/NAS）统一台账聚合端点——
 * 每条资产输出统一 schema（type/key/name/org/owner/health/lifecycle/grayPercent/
 * calls30d/tokens30d/cost30d/dau/trend[14]/version/autonomy/desc），
 * 用量与成本来自 usage 事件真实聚合（usageReport/callsTrend），无数据给 0/空数组。
 *
 * 字段映射（哪来的就注释哪）：
 *   - health  ：MCP=healthcheck 探活状态（degraded→warning，down/熔断→critical，offline 态→offline）；
 *              NAS=healthOf 探活（同上映射）；Agent=冻结→critical，offline/archived→offline，其余默认 healthy；
 *              App/Skill=无探活通道，online/published 默认 healthy，offline 态→offline；模型=online+有 endpoint
 *              →healthy，online 无 endpoint→critical（不可调用），offline 态→offline。
 *   - lifecycle：draft/verifying/pending→draft；online/gray/trial/published/unhealthy→online；
 *              offline→offline；archived→archived；skill deprecated→deprecated。
 *   - key     ：与 usage 计量 resource 完全一致（mcp:<slug> / model:<slug> / app:<slug> /
 *              skill:<id> / nas:<id> / agent:<id>）——前端可直接拿 key 与用量报表 topAssets 对账。
 *   - calls30d/tokens30d/cost30d：usage.usageReport(近 30 天) 按资源聚合（cost=内部成本参考分）。
 *   - usageReports30d：资产使用凭证数（近 30 天，Agent 自主提报的使用事实，usage:assetReports
 *     按 assetKey 聚合）——与计量口径互补：计量=平台自动（计费管道），凭证=使用方自证（经营证据）。
 *   - trend[14]：usage.callsTrend(近 14 天) 按资源×日的调用数序列（无数据全 0）。
 *   - dau     ：app/agent 取运营提报（appRegistry/agentRegistry usage 集合最近一日 dau），无提报省略。
 */
import type { Context } from '@deepseek-ai/cordis'
import { t } from '../../../platform-i18n/src/index.ts'
import { AssetUsageError, prepareAssetUsageReport, type AssetUsageCheckCtx, type AssetUsageReportInput } from '../../../plugin-usage/src/asset-reports.ts'
import type { ConsoleRouteDeps } from './deps.ts'

/** 台账统一条目（规格 5.2 六类统一 schema）。 */
export interface FleetLedgerItem {
  id: string
  type: 'mcp' | 'agent' | 'app' | 'skill' | 'model' | 'nas'
  /** 与 usage 计量 resource 同键：台账行与用量报表可直接互查。 */
  key: string
  name: string
  org: string
  owner: string
  health: 'healthy' | 'warning' | 'critical' | 'offline'
  lifecycle: 'draft' | 'online' | 'offline' | 'archived' | 'deprecated'
  grayPercent?: number
  calls30d: number
  tokens30d: number
  cost30d: number
  /** 资产使用凭证数（近 30 天，Agent 自主提报的使用事实；与计量口径互补，2026-10-31）。 */
  usageReports30d: number
  dau?: number
  trend: number[]
  version?: string
  autonomy?: string
  desc: string
}

export function registerFleetRoutes(ctx: Context, deps: ConsoleRouteDeps): void {
  const { guarded, body, changeLog, caller } = deps

  guarded('GET', '/api/fleet/ledger', 'usage.read', (exchange) => {
    const typeFilter = exchange.query.get('type') ?? ''
    const search = (exchange.query.get('search') ?? '').trim().toLowerCase()

    // -- usage 聚合（真实计量事件；窗口 30 天，趋势 14 天） --------------------
    const now = new Date()
    const from30 = new Date(now.getTime() - 30 * 86_400_000).toISOString()
    const from14 = new Date(now.getTime() - 14 * 86_400_000).toISOString()
    const byResource = new Map(ctx.usage.usageReport(from30).byResource.map((row) => [row.resource, row]))
    const usageReportsByAsset = ctx.usage.assetUsageReportCounts(from30)
    const axis14: string[] = []
    for (let i = 13; i >= 0; i--) axis14.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10))
    const trendOfDay = new Map<string, Map<string, number>>()
    for (const row of ctx.usage.callsTrend(from14)) {
      const perDay = trendOfDay.get(row.resource) ?? new Map<string, number>()
      perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.calls)
      trendOfDay.set(row.resource, perDay)
    }
    const usageOf = (resource: string) => {
      const row = byResource.get(resource)
      const perDay = trendOfDay.get(resource)
      return {
        calls30d: row?.calls ?? 0,
        tokens30d: row?.tokens ?? 0,
        cost30d: row?.cost_cents ?? 0,
        usageReports30d: usageReportsByAsset.get(resource) ?? 0,
        trend: axis14.map((day) => perDay?.get(day) ?? 0),
      }
    }

    // -- 展示名解析 -----------------------------------------------------------
    const orgName = (orgId: string) => ctx.iam.orgs().get(orgId)?.name ?? orgId
    const userDisplayName = (userId: string) => {
      if (!userId) return ''
      return ctx.iam.users().get(userId)?.displayName ?? userId
    }
    /** app/agent 最近一日运营提报 DAU（无提报返回 undefined——前端空态，不造数）。 */
    const lastDau = (rows: Array<{ date: string; dau?: number }>): number | undefined => {
      const withDau = rows.filter((row) => row.dau !== undefined && row.dau !== null).sort((a, b) => b.date.localeCompare(a.date))
      const value = withDau[0]?.dau
      return typeof value === 'number' ? value : undefined
    }

    const items: FleetLedgerItem[] = []

    // -- MCP 服务（mcpRegistry：探活/熔断 + 灰度 + 版本） ------------------------
    for (const service of ctx.mcpRegistry.services().all()) {
      const health: FleetLedgerItem['health'] = service.status === 'offline'
        ? 'offline'
        : service.health.breakerOpen || service.health.status === 'down' ? 'critical'
          : service.health.status === 'degraded' ? 'warning'
            : 'healthy' // unknown/healthy：无探活数据默认 healthy
      items.push({
        id: service.id,
        type: 'mcp',
        key: `mcp:${service.slug}`,
        name: service.name,
        org: orgName(service.orgId),
        owner: service.owner,
        health,
        lifecycle: ['draft', 'verifying'].includes(service.status) ? 'draft'
          : service.status === 'offline' ? 'offline'
            : 'online', // online/gray/unhealthy 均为已部署在线态
        ...(service.grayPercent < 100 ? { grayPercent: service.grayPercent } : {}),
        ...usageOf(`mcp:${service.slug}`),
        version: service.currentVersion,
        desc: service.description,
      })
    }

    // -- Agent 本体（resourceCore + agentRegistry：冻结态→critical；自治级别 A0-A3） --
    for (const agent of ctx.resourceCore.list('agent')) {
      const frozen = Boolean((agent.attrs as Record<string, unknown>)['frozenAt'])
      const health: FleetLedgerItem['health'] = ['offline', 'archived'].includes(agent.status) ? 'offline'
        : frozen ? 'critical'
          : 'healthy' // Agent 无探活通道：运行态默认 healthy
      const autonomy = (agent.attrs as Record<string, unknown>)['autonomy']
      const agentDau = lastDau(ctx.agentRegistry.usage().find((row) => row.agentId === agent.id))
      items.push({
        id: agent.id,
        type: 'agent',
        key: `agent:${agent.id}`,
        name: agent.name,
        org: orgName(agent.orgId),
        owner: userDisplayName(agent.ownerId) || agent.ownerId,
        health,
        lifecycle: agent.status === 'draft' ? 'draft'
          : ['offline', 'archived'].includes(agent.status) ? (agent.status as 'offline' | 'archived')
            : 'online', // trial（试运行）按在线口径
        ...usageOf(`agent:${agent.id}`),
        ...(agentDau !== undefined ? { dau: agentDau } : {}),
        ...(typeof autonomy === 'string' ? { autonomy } : {}),
        desc: String((agent.attrs as Record<string, unknown>)['description'] ?? ''),
      })
    }

    // -- AI 应用（resourceCore + appRegistry：DAU 提报 + 发布版本） ----------------
    for (const app of ctx.resourceCore.list('app')) {
      const health: FleetLedgerItem['health'] = ['offline', 'archived'].includes(app.status) ? 'offline' : 'healthy'
      const publishVersion = (app.attrs as Record<string, unknown>)['publishVersion']
      const dau = lastDau(ctx.appRegistry.usage().find((row) => row.appId === app.id))
      items.push({
        id: app.id,
        type: 'app',
        key: `app:${app.slug}`,
        name: app.name,
        org: orgName(app.orgId),
        owner: userDisplayName(app.ownerId) || app.ownerId,
        health,
        lifecycle: app.status === 'draft' ? 'draft'
          : ['offline', 'archived'].includes(app.status) ? (app.status as 'offline' | 'archived')
            : 'online',
        ...usageOf(`app:${app.slug}`),
        ...(dau !== undefined ? { dau } : {}),
        ...(typeof publishVersion === 'string' ? { version: publishVersion } : {}),
        desc: String((app.attrs as Record<string, unknown>)['description'] ?? ''),
      })
    }

    // -- Skill（skillHub：市场状态 + 风险已由既有 /api/skills 承载；此处补统一台账面） --
    for (const skill of ctx.skillHub.skills().all()) {
      const health: FleetLedgerItem['health'] = ['offline', 'deprecated', 'rejected'].includes(skill.status) ? 'offline' : 'healthy'
      items.push({
        id: skill.id,
        type: 'skill',
        key: `skill:${skill.id}`, // skill 计量 resource 用 ID（slug 含非 ASCII，见 plugin-skillhub meterSkillUsage 注释）
        name: skill.name,
        org: orgName(skill.orgId),
        owner: skill.authorName,
        health,
        lifecycle: ['published'].includes(skill.status) ? 'online'
          : ['pending_approval', 'scanning', 'rejected'].includes(skill.status) ? 'draft'
            : skill.status === 'deprecated' ? 'deprecated'
              : skill.status === 'offline' ? 'offline'
                : 'online',
        ...usageOf(`skill:${skill.id}`),
        version: skill.currentVersion,
        desc: skill.summary,
      })
    }

    // -- 模型路由（modelGateway：offline/无 endpoint 诚实降级） -------------------
    for (const model of ctx.modelGateway.models().all()) {
      const health: FleetLedgerItem['health'] = model.status === 'offline' ? 'offline'
        : model.endpoint.trim() === '' ? 'critical' // online 但未配置 endpoint：登记了却不可调用
          : 'healthy'
      items.push({
        id: model.id,
        type: 'model',
        key: `model:${model.slug}`,
        name: model.displayName,
        org: t('平台自营'),
        owner: model.provider,
        health,
        lifecycle: model.status === 'offline' ? 'offline' : 'online',
        ...usageOf(`model:${model.slug}`),
        desc: t('提供方 {provider}{suffix}', { provider: model.provider, suffix: model.dataClassLimit ? t(' · 数据分级上限 {limit}', { limit: model.dataClassLimit }) : '' }),
      })
    }

    // -- NAS 存储（nasRegistry：网关探活状态） -----------------------------------
    for (const nas of ctx.nasRegistry.list()) {
      const probe = ctx.nasRegistry.healthOf(nas.id)
      const health: FleetLedgerItem['health'] = ['offline', 'archived'].includes(nas.status) ? 'offline'
        : probe.status === 'down' ? 'critical'
          : probe.status === 'degraded' ? 'warning'
            : 'healthy' // unknown（未探活草稿）默认 healthy
      items.push({
        id: nas.id,
        type: 'nas',
        key: `nas:${nas.id}`,
        name: nas.name,
        org: orgName(nas.orgId),
        owner: userDisplayName(nas.ownerId) || nas.ownerId,
        health,
        lifecycle: nas.status === 'draft' ? 'draft'
          : ['offline', 'archived'].includes(nas.status) ? (nas.status as 'offline' | 'archived')
            : 'online',
        ...usageOf(`nas:${nas.id}`),
        desc: String((nas.attrs as Record<string, unknown>)['description'] ?? ''),
      })
    }

    // -- 过滤（type 精确 + search 模糊：名称/资源键/组织/负责人）与排序 ------------
    const filtered = items.filter((item) => {
      if (typeFilter && item.type !== typeFilter) return false
      if (search && !`${item.name}${item.key}${item.org}${item.owner}`.toLowerCase().includes(search)) return false
      return true
    }).sort((a, b) => b.cost30d - a.cost30d || b.calls30d - a.calls30d || a.name.localeCompare(b.name))

    const byType: Record<string, { total: number; online: number; unhealthy: number }> = {}
    for (const item of items) {
      const bucket = byType[item.type] ?? { total: 0, online: 0, unhealthy: 0 }
      bucket.total++
      if (item.lifecycle === 'online' || item.lifecycle === 'deprecated') bucket.online++
      if (item.health === 'critical' || item.health === 'warning' || item.health === 'offline') bucket.unhealthy++
      byType[item.type] = bucket
    }
    return {
      total: filtered.length,
      summary: {
        byType,
        calls30d: filtered.reduce((sum, item) => sum + item.calls30d, 0),
        tokens30d: filtered.reduce((sum, item) => sum + item.tokens30d, 0),
        cost30d: filtered.reduce((sum, item) => sum + item.cost30d, 0),
      },
      trendAxis: axis14,
      items: filtered,
    }
  })

  // -- 资产使用凭证（2026-10-31）：Agent 使用 skill/MCP 后主动提报的使用事实 ----------------
  // 提报授权闭环与字段口径见 plugin-usage asset-reports.ts（REST 与 MCP 工具 asset_usage_report
  // 共用编排）；权限复用 usage.write（Agent 注册默认 scope 已含，存量免换证），查询 usage.read。
  guarded('POST', '/api/assets/usage-reports', 'usage.write', (exchange) => {
    const input = body<AssetUsageReportInput>(exchange)
    try {
      const prepared = prepareAssetUsageReport(ctx as unknown as AssetUsageCheckCtx, input, caller(exchange))
      const { report, deduped } = ctx.usage.submitAssetUsageReport(prepared)
      if (!deduped) changeLog(exchange, 'asset.usage.report', report.assetType, report.assetKey, report.assetName,
        `action=${report.action} outcome=${report.outcome} occurredAt=${report.occurredAt}${report.taskId ? ` taskId=${report.taskId}` : ''}`)
      return { report, deduped }
    } catch (error) {
      if (error instanceof AssetUsageError) {
        exchange.fail(error.status, error.code, error.message)
        return
      }
      throw error
    }
  })

  guarded('GET', '/api/assets/usage-reports', 'usage.read', (exchange) => {
    const query = exchange.query
    const rows = ctx.usage.assetUsageReports({
      ...(query.get('assetType') ? { assetType: query.get('assetType')! } : {}),
      ...(query.get('assetKey') ? { assetKey: query.get('assetKey')! } : {}),
      ...(query.get('agentId') ? { agentId: query.get('agentId')! } : {}),
      ...(query.get('from') ? { from: query.get('from')! } : {}),
      ...(query.get('to') ? { to: query.get('to')! } : {}),
      ...(query.get('limit') ? { limit: Number(query.get('limit')) } : {}),
    })
    return { total: rows.length, items: rows }
  })
}
