/**
 * 总览/工作台域路由（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出——工作台总览、通知中心（跨会话持久化 + bus 事件生产者）、
 * 资产运营（统一台账/健康巡检/成本报表/成本穿透/技能热力图/下架分析）。
 * 处理器与事件订阅逐字搬运（行为与迁出前一致）；事件流摘要助手（summarize/summarizeDetail）
 * 为本域专用，随迁至模块级。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Collection, RecordBase } from '../../../platform-core/src/index.ts'
import { newId, PlatformEvents } from '../../../platform-core/src/index.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'

export function registerDashboardRoutes(ctx: Context, deps: ConsoleRouteDeps): void {
  const { guarded, body, changeLog, caller } = deps
  // -- 总览（工作台）-------------------------------------------------------
  // console.read（控制台只读基线，被 console.login 蕴含——真实用户零感知）：
  // 纯聚合读接口用「登录会话」点声明语义不准，且免登演示态白名单不含登录级点（2026-10-17）
  guarded('GET', '/api/overview', 'console.read', () => {
    const pendingApprovals = ctx.audit.approvals().find((item) => item.status === 'pending')
    const unreadAlerts = ctx.audit.alerts().find((item) => !item.read)
    const recentEvents = ctx.platformBus.recent(20).map((event) => ({
      name: event.name, at: event.at, payload: summarize(event.payload), detail: summarizeDetail(event.payload),
    }))
    const costTrend = ctx.audit.costReport('date').sort((a, b) => a.key.localeCompare(b.key)).slice(-14)
    return {
      iam: { users: ctx.iam.users().count(), orgs: ctx.iam.orgs().count(), pendingUsers: ctx.iam.users().find((user) => user.status === 'pending').length },
      mcp: ctx.mcpRegistry.metricsOverview(),
      agents: ctx.agentRegistry.overview(),
      apps: ctx.appRegistry.overview(),
      skills: {
        total: ctx.skillHub.skills().count(),
        published: ctx.skillHub.skills().find((item) => item.status === 'published').length,
        pendingApproval: ctx.skillHub.skills().find((item) => item.status === 'pending_approval').length,
      },
      approvals: { pending: pendingApprovals.length, items: pendingApprovals.slice(0, 5) },
      alerts: { unread: unreadAlerts.length, critical: unreadAlerts.filter((item) => item.severity === 'critical').length },
      audit: ctx.audit.summary(),
      recentEvents,
      costTrend,
      conflicts: ctx.iam.conflicts().find((item) => item.status === 'pending').length,
    }
  })

  // -- 通知中心（IAW 交接 8-1：跨会话持久化 + since 游标 + 已读游标） ----------------
  //
  // 面板/控制台的通知此前只存在于 SSE 内存动态与 bus 环形缓冲（300 条，重启即失），
  // 这里补持久层：任务/审批/告警三类平台事件统一落 console:notifications，
  // 消费端 GET /api/notifications?since= 拉增量、POST read-cursor 推已读游标（跨设备漫游）。

  interface NotificationRecord extends RecordBase {
    type: 'task' | 'approval' | 'alert' | 'system'
    title: string
    body?: string
    scope: { kind: 'global' } | { kind: 'org'; orgId: string } | { kind: 'user'; userId: string }
    at: string
  }

  const notifications = (): Collection<NotificationRecord> => {
    const collection = ctx.opsStorage.collection<NotificationRecord>('console:notifications')
    collection.uniqueOn('notif-dedup', (n) => `${n.type}:${n.title}:${n.at.slice(0, 13)}`)
    return collection
  }

  const notificationCursors = (): Collection<{ userId: string; at: string } & RecordBase> => {
    const collection = ctx.opsStorage.collection<{ userId: string; at: string } & RecordBase>('console:notificationCursors')
    collection.uniqueOn('user', (row) => row.userId)
    return collection
  }

  const orgContainsId = (rootId: string, orgId: string): boolean => {
    let current = ctx.iam.orgs().get(orgId)
    let guard = 0
    while (current && guard++ < 32) {
      if (current.id === rootId) return true
      current = current.parentId ? ctx.iam.orgs().get(current.parentId) : undefined
    }
    return false
  }

  const pushNotification = (input: { type: NotificationRecord['type']; title: string; body?: string; scope: NotificationRecord['scope'] }): void => {
    const at = new Date().toISOString()
    const collection = notifications()
    collection.insert({ id: newId('ntf'), at, ...input })
    // 保留窗 30 天 + 硬上限 2000 条（环形语义：最旧的先出）
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const all = collection.all().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const stale of all.filter((n) => n.at < cutoff)) collection.remove(stale.id)
    const overflow = collection.all().length - 2000
    if (overflow > 0) for (const item of collection.all().sort((a, b) => a.at.localeCompare(b.at)).slice(0, overflow)) collection.remove(item.id)
  }

  // 事件生产者：告警（全局）/ 审批（全局，审批中心治理面）/ 任务（部门绑定的组织子树）。
  // 面板 deptConfigs 集合按平台稳定键跨插件只读（dsh-bridge softRead 同款惯例），读不到降级全局范围。
  ctx.platformBus.on(PlatformEvents.AlertFired, (payload) => {
    const p = payload as { severity?: string; title?: string; message?: string }
    try {
      pushNotification({ type: 'alert', title: p.title ?? t('平台告警'), body: p.message ?? '', scope: { kind: 'global' } })
    } catch { /* 通知落库失败不阻塞事件链 */ }
  })
  ctx.platformBus.on(PlatformEvents.ApprovalCreated, (payload) => {
    const p = payload as { approvalId?: string; title?: string }
    try {
      pushNotification({ type: 'approval', title: t('待审批：{title}', { title: p.title ?? p.approvalId ?? '' }), body: t('已在审批中心挂起，请及时处理'), scope: { kind: 'global' } })
    } catch { /* 通知落库失败不阻塞事件链 */ }
  })
  ctx.platformBus.on(PlatformEvents.PanelTaskUpdated, (payload) => {
    const p = payload as { taskId?: string; dept?: string; lane?: string; title?: string }
    try {
      const deptOrgId = ctx.opsStorage.collection<{ orgId?: string }>('panel:deptConfigs').get(p.dept ?? '')?.orgId
      const laneLabel = ({ todo: t('待办'), doing: t('进行中'), review: t('待审'), done: t('完成') } as Record<string, string>)[p.lane ?? ''] ?? p.lane ?? ''
      pushNotification({
        type: 'task', title: t('任务流转：{title}', { title: p.title ?? p.taskId ?? '' }), body: t('泳道 → {lane}', { lane: laneLabel }),
        scope: deptOrgId ? { kind: 'org', orgId: deptOrgId } : { kind: 'global' },
      })
    } catch { /* 通知落库失败不阻塞事件链 */ }
  })

  // 执行中枢（2026-10-14）：run 收尾通知负责人侧（任务面）、僵尸锁回收与 Agent 冻结走告警面。
  // org 作用域经 entity:agent / exec:issues 集合稳定键跨插件只读（与 deptConfigs 同款惯例）。
  ctx.platformBus.on(PlatformEvents.ExecRunCompleted, (payload) => {
    const p = payload as { runId?: string; agentId?: string; issueIds?: string[]; status?: string }
    try {
      const agent = p.agentId ? ctx.opsStorage.collection<{ name?: string; orgId?: string }>('entity:agent').get(p.agentId) : undefined
      pushNotification({
        type: 'task',
        title: t('执行 run {result}：{name}', { result: p.status === 'completed' ? t('完成') : p.status === 'timeout' ? t('超时回收') : t('失败'), name: agent?.name ?? p.agentId ?? p.runId ?? '' }),
        body: p.issueIds?.length ? t('关联任务 {n} 项（已释放执行锁）', { n: p.issueIds.length }) : t('例行唤醒收尾'),
        scope: agent?.orgId ? { kind: 'org', orgId: agent.orgId } : { kind: 'global' },
      })
    } catch { /* 通知落库失败不阻塞事件链 */ }
  })
  ctx.platformBus.on(PlatformEvents.ExecLockReclaimed, (payload) => {
    const p = payload as { issueId?: string; runId?: string; reason?: string }
    try {
      pushNotification({
        type: 'alert', title: t('执行锁僵尸回收：{issueId}', { issueId: p.issueId ?? '' }),
        body: t('run {runId} 已超时（{reason}），锁已强制释放，请核查执行方是否仍在运行', { runId: p.runId ?? '', reason: p.reason ?? 'force-release' }),
        scope: { kind: 'global' },
      })
    } catch { /* 通知落库失败不阻塞事件链 */ }
  })
  ctx.platformBus.on(PlatformEvents.AgentFrozen, (payload) => {
    const p = payload as { agentId?: string; reason?: string }
    try {
      const agent = p.agentId ? ctx.opsStorage.collection<{ name?: string; orgId?: string }>('entity:agent').get(p.agentId) : undefined
      pushNotification({
        type: 'alert', title: t('Agent 已冻结：{name}', { name: agent?.name ?? p.agentId ?? '' }),
        body: t('{reason}——已生成解冻审批单（L4），审批通过后自动解冻', { reason: p.reason ?? t('预算联动') }),
        scope: agent?.orgId ? { kind: 'org', orgId: agent.orgId } : { kind: 'global' },
      })
    } catch { /* 通知落库失败不阻塞事件链 */ }
  })

  // console.read（2026-10-17，同 /api/overview 口径：纯读，演示态可读）
  guarded('GET', '/api/notifications', 'console.read', (exchange) => {
    const info = caller(exchange)
    if (!info.userId) return { items: [], unread: 0, readCursor: null, note: t('机器主体无个人通知面（v1 口径）') }
    const since = exchange.query.get('since') ?? ''
    const limit = Math.min(Number(exchange.query.get('limit') ?? 50) || 50, 200)
    const user = ctx.iam.users().get(info.userId)
    const visible = (n: NotificationRecord): boolean =>
      n.scope.kind === 'global'
      || (n.scope.kind === 'user' && n.scope.userId === info.userId)
      || (n.scope.kind === 'org' && Boolean(user) && orgContainsId(n.scope.orgId, user!.orgId))
    const cursor = notificationCursors().findOne((row) => row.userId === info.userId)
    const all = notifications().all().filter((n) => visible(n))
    return {
      items: all.filter((n) => n.at > since).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit),
      unread: all.filter((n) => n.at > (cursor?.at ?? '')).length,
      readCursor: cursor?.at ?? null,
      now: new Date().toISOString(),
    }
  })

  guarded('POST', '/api/notifications/read-cursor', 'console.login', (exchange) => {
    const info = caller(exchange)
    if (!info.userId) return exchange.fail(403, 'FORBIDDEN', t('机器主体无个人通知面（v1 口径）'))
    const input = body<{ at?: string }>(exchange)
    const now = new Date().toISOString()
    const at = input.at && !Number.isNaN(Date.parse(input.at)) && input.at <= now ? input.at : now
    const collection = notificationCursors()
    const existing = collection.findOne((row) => row.userId === info.userId)
    if (existing) collection.update(existing.id, { at })
    else collection.insert({ id: newId('ncur'), userId: info.userId, at })
    return { readCursor: at, unread: 0 }
  })

  // -- 资产运营：统一台账 / 健康巡检 / 成本报表（企业 AI 资产运营管理） --------
  guarded('GET', '/api/assets/inventory', 'usage.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 30) || 30, 1), 90)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const usageByResource = new Map(ctx.usage.breakdown(fromIso).byResource.map((row) => [row.resource, row]))
    const orgName = (orgId: string) => ctx.iam.orgs().get(orgId)?.name ?? orgId
    const usageOf = (resource: string | undefined) => {
      if (!resource) return { calls: 0, costCents: 0 }
      const row = usageByResource.get(resource)
      return { calls: row?.count ?? 0, costCents: row?.cost_cents ?? 0 }
    }
    const items = [
      ...ctx.mcpRegistry.services().all().map((service) => ({
        type: 'mcp' as const,
        id: service.id,
        name: service.name,
        slug: service.slug,
        status: service.status,
        health: service.health.status,
        exec: service.exec,
        version: service.currentVersion,
        org: orgName(service.orgId),
        owner: service.owner,
        updatedAt: service.updatedAt,
        ...usageOf(`mcp:${service.slug}`),
      })),
      ...ctx.nasRegistry.list().map((nas) => ({
        type: 'nas' as const,
        id: nas.id,
        name: nas.name,
        slug: nas.slug,
        status: nas.status,
        health: ctx.nasRegistry.healthOf(nas.id).status,
        org: orgName(nas.orgId),
        owner: nas.ownerId,
        updatedAt: nas.updatedAt,
        calls: 0,
        costCents: 0,
      })),
      ...ctx.resourceCore.list('agent').map((agent) => ({
        type: 'agent' as const,
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        status: agent.status,
        health: agent.status === 'online' ? 'healthy' : 'unknown',
        org: orgName(agent.orgId),
        owner: agent.ownerId,
        updatedAt: agent.updatedAt,
        ...usageOf(undefined),
      })),
      ...ctx.resourceCore.list('app').map((app) => ({
        type: 'app' as const,
        id: app.id,
        name: app.name,
        slug: app.slug,
        status: app.status,
        health: app.status === 'online' ? 'healthy' : 'unknown',
        org: orgName(app.orgId),
        owner: app.ownerId,
        updatedAt: app.updatedAt,
        ...usageOf(`app:${app.slug}`),
      })),
      ...ctx.skillHub.skills().all().map((skill) => ({
        type: 'skill' as const,
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        status: skill.status,
        health: 'unknown',
        org: orgName(skill.orgId),
        owner: skill.authorName,
        updatedAt: skill.updatedAt,
        calls: skill.stats?.installs ?? 0,
        costCents: 0,
      })),
      ...ctx.modelGateway.models().all().map((model) => ({
        type: 'model' as const,
        id: model.id,
        name: model.displayName,
        slug: model.slug,
        status: model.status,
        health: model.status === 'online' ? (model.endpoint ? 'healthy' : 'down') : 'unknown',
        org: t('平台自营'),
        owner: model.provider,
        updatedAt: model.updatedAt,
        ...usageOf(`model:${model.slug}`),
      })),
    ]
    const type = exchange.query.get('type')
    const status = exchange.query.get('status')
    const q = exchange.query.get('q')
    const filtered = items.filter((item) => {
      if (type && item.type !== type) return false
      if (status && item.status !== status) return false
      if (q && !`${item.name}${item.slug}${item.org}${item.owner}`.toLowerCase().includes(q.toLowerCase())) return false
      return true
    }).sort((a, b) => b.costCents - a.costCents || a.name.localeCompare(b.name))
    const byType: Record<string, { total: number; inService: number }> = {}
    for (const item of items) {
      const bucket = byType[item.type] ?? { total: 0, inService: 0 }
      bucket.total++
      if (['online', 'gray', 'published'].includes(item.status)) bucket.inService++
      byType[item.type] = bucket
    }
    return {
      days,
      total: filtered.length,
      summary: {
        byType,
        unhealthy: items.filter((item) => item.health === 'down' || item.health === 'degraded').length,
        costCents30d: items.reduce((sum, item) => sum + item.costCents, 0),
      },
      items: filtered,
    }
  })

  guarded('POST', '/api/assets/healthcheck', 'mcp.service.read', async (exchange) => {
    const info = caller(exchange)
    const checked: Array<{ type: string; id: string; name: string; status: string; latencyMs: number }> = []
    for (const service of ctx.mcpRegistry.services().all()) {
      if (!['online', 'gray', 'unhealthy'].includes(service.status)) continue
      const result = await ctx.mcpRegistry.probeService(service.id)
      checked.push({ type: 'mcp', id: service.id, name: service.name, status: result.status, latencyMs: result.latencyMs })
    }
    for (const nas of ctx.nasRegistry.list()) {
      if (!['online'].includes(nas.status)) continue
      const result = await ctx.nasRegistry.probe(nas.id)
      checked.push({ type: 'nas', id: nas.id, name: nas.name, status: result.status, latencyMs: result.latencyMs })
    }
    for (const entity of [...ctx.resourceCore.list('agent'), ...ctx.resourceCore.list('app')]) {
      checked.push({ type: entity.type, id: entity.id, name: entity.name, status: entity.status, latencyMs: 0 })
    }
    for (const model of ctx.modelGateway.models().all()) {
      checked.push({ type: 'model', id: model.id, name: model.displayName, status: model.status, latencyMs: 0 })
    }
    const abnormal = checked.filter((item) => item.status === 'down' || item.status === 'degraded' || item.status === 'unhealthy' || item.status === 'offline')
    changeLog(exchange, 'assets.healthcheck', 'asset', 'batch', t('健康巡检'), t('巡检 {total} 项，异常 {abnormal} 项', { total: checked.length, abnormal: abnormal.length }))
    return {
      checkedAt: new Date().toISOString(),
      checked: checked.length,
      abnormal: abnormal.length,
      items: checked,
      abnormalItems: abnormal,
    }
  })

  // 资源/主体的展示名解析（成本报表与效益分析共用）
  // 资源/主体的展示名解析（成本报表与效益分析共用）；标签为中文数据（t() 的键），展示处按请求语言即时翻译
  const RESOURCE_KIND_LABELS: Record<string, string> = {
    mcp: 'MCP 服务', model: '模型路由', skill: 'Skill', nas: 'NAS 存储', app: 'AI 应用', agent: 'Agent',
  }
  const labelOfResource = (resource: string) => {
    const idx = resource.indexOf(':')
    const kind = idx >= 0 ? resource.slice(0, idx) : ''
    const key = idx >= 0 ? resource.slice(idx + 1) : resource
    const unnamed = t('未命名{kind}资产', { kind: RESOURCE_KIND_LABELS[kind] !== undefined ? t(RESOURCE_KIND_LABELS[kind]) : '' })
    if (kind === 'mcp') return ctx.mcpRegistry.services().findOne((item) => item.slug === key)?.name ?? unnamed
    if (kind === 'model') return ctx.modelGateway.models().findOne((item) => item.slug === key)?.displayName ?? unnamed
    if (kind === 'skill') return ctx.skillHub.skills().get(key)?.name ?? unnamed
    if (kind === 'nas') return ctx.nasRegistry.get(key)?.name ?? unnamed
    if (kind === 'app') return ctx.resourceCore.list('app').find((item) => item.slug === key)?.name ?? unnamed
    // 资产已删除/未注册时不再以原始 ID 充当名称（消耗榜出现两遍 nas:nas_xxx 的可读性问题）
    return unnamed
  }
  const labelOfPrincipal = (principal: string) => {
    if (principal.startsWith('org:')) return ctx.iam.orgs().get(principal.slice(4))?.name ?? principal
    return principal
  }

  guarded('GET', '/api/assets/report', 'usage.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 30) || 30, 1), 90)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const { byResource, byPrincipal, byDay } = ctx.usage.breakdown(fromIso)
    return {
      days,
      totals: ctx.usage.totals({ from: fromIso }),
      topResources: byResource.slice(0, 20).map((row) => ({ ...row, label: labelOfResource(row.resource) })),
      byPrincipal: byPrincipal.map((row) => ({ ...row, label: labelOfPrincipal(row.principal) })),
      byDay,
    }
  })

  // -- 成本穿透（M0-3 用量透明口径）：内部采购成本参考 + 应用关联单位 DAU 成本 --------------
  // （零价快照下 charge_cents 恒 0，不再呈现收入/毛利等结算语义）
  guarded('GET', '/api/assets/benefit', 'usage.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 30) || 30, 1), 90)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const fromDay = fromIso.slice(0, 10)
    const appsBySlug = new Map(ctx.resourceCore.list('app').map((app) => [app.slug, app]))
    const rows = ctx.usage.breakdown(fromIso).byResource.map((row) => {
      const kind = row.resource.slice(0, row.resource.indexOf(':'))
      const key = row.resource.slice(row.resource.indexOf(':') + 1)
      const windowDau = kind === 'app' && appsBySlug.has(key)
        ? ctx.appRegistry.usage().find((item) => item.appId === appsBySlug.get(key)!.id && item.date >= fromDay)
          .reduce((sum, item) => sum + item.dau, 0)
        : null
      return {
        resource: row.resource,
        label: labelOfResource(row.resource),
        kind,
        count: row.count,
        cost_cents: row.cost_cents,
        window_dau: windowDau,
        cost_per_dau_cents: windowDau && windowDau > 0 ? Math.round(row.cost_cents / windowDau) : null,
      }
    }).sort((a, b) => b.cost_cents - a.cost_cents || b.count - a.count)
    return {
      days,
      totals: {
        count: rows.reduce((sum, row) => sum + row.count, 0),
        cost_cents: rows.reduce((sum, row) => sum + row.cost_cents, 0),
      },
      rows,
    }
  })

  // -- 技能热力图：skill × 日 使用矩阵（usage 事件为主，计量管道接入前的下载流水回填） ------
  guarded('GET', '/api/skills/usage-heatmap', 'skill.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 30) || 30, 7), 90)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const fromDay = fromIso.slice(0, 10)
    const counts = new Map<string, number>()
    const daysMetered = new Map<string, Set<string>>()
    for (const row of ctx.usage.matrix(fromIso, 'skill:')) {
      const skillId = row.resource.slice('skill:'.length)
      counts.set(`${skillId}|${row.day}`, (counts.get(`${skillId}|${row.day}`) ?? 0) + row.count)
      if (!daysMetered.has(skillId)) daysMetered.set(skillId, new Set())
      daysMetered.get(skillId)!.add(row.day)
    }
    // 回填：计量管道接入前的下载流水（同 skill 同日已有计量事件则不重复累计）
    for (const record of ctx.skillHub.downloads().all()) {
      const day = (record.createdAt ?? '').slice(0, 10)
      if (!day || day < fromDay) continue
      const skill = ctx.skillHub.skills().get(record.skillId)
      if (!skill || daysMetered.get(skill.id)?.has(day)) continue
      counts.set(`${skill.id}|${day}`, (counts.get(`${skill.id}|${day}`) ?? 0) + 1)
    }
    const axis: string[] = []
    for (let i = days - 1; i >= 0; i--) axis.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
    const bySkill = new Map<string, { slug: string; name: string; cells: Map<string, number>; total: number }>()
    for (const [key, count] of counts) {
      const separator = key.lastIndexOf('|')
      const skillId = key.slice(0, separator)
      const day = key.slice(separator + 1)
      let entry = bySkill.get(skillId)
      if (!entry) {
        const skill = ctx.skillHub.skills().get(skillId)
        entry = { slug: skill?.slug ?? skillId, name: skill?.name ?? skillId, cells: new Map(), total: 0 }
        bySkill.set(skillId, entry)
      }
      entry.cells.set(day, count)
      entry.total += count
    }
    const skills = [...bySkill.entries()].map(([skillId, entry]) => ({
      id: skillId,
      slug: entry.slug,
      name: entry.name,
      total: entry.total,
      cells: axis.map((day) => entry.cells.get(day) ?? 0),
    })).sort((a, b) => b.total - a.total).slice(0, 20)
    return { days: axis, skills, maxCell: Math.max(1, ...skills.flatMap((item) => item.cells)) }
  })

  // -- 下架分析：弃用/下线原因聚合（审计 change 日志 + 生命周期留痕 + Skill 落库原因） ------
  guarded('GET', '/api/assets/retire-reasons', 'usage.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 90) || 90, 1), 365)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const buckets = new Map<string, { reason: string; count: number; byType: Record<string, number>; latestAt: string; samples: Array<{ type: string; name: string; at: string }> }>()
    const bucketOf = (reason: string) => {
      const key = reason.trim() || t('（未填写原因）')
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = { reason: key, count: 0, byType: {}, latestAt: '', samples: [] }
        buckets.set(key, bucket)
      }
      return bucket
    }
    const add = (reason: string, type: string, name: string, at: string) => {
      const bucket = bucketOf(reason)
      bucket.count++
      bucket.byType[type] = (bucket.byType[type] ?? 0) + 1
      if (at > bucket.latestAt) bucket.latestAt = at
      if (bucket.samples.length < 5) bucket.samples.push({ type, name, at })
    }
    // Skill 弃用原因以落库记录为准（P5 起持久化），无落库原因的历史弃用回退审计日志
    const skillReasonPersisted = new Set(
      ctx.skillHub.skills().all()
        .filter((skill) => skill.deprecatedAt && (skill.deprecatedAt ?? '') >= fromIso)
        .map((skill) => skill.id),
    )
    const RETIRE_ACTIONS = new Set(['skill.deprecate', 'mcp.service.offline', 'nas.offline', 'nas.archive'])
    for (const log of ctx.audit.logs().all()) {
      if (log.type !== 'change' || !RETIRE_ACTIONS.has(log.action)) continue
      if ((log.createdAt ?? '') < fromIso) continue
      if (log.action === 'skill.deprecate' && skillReasonPersisted.has(log.resourceId)) continue
      add(log.detail, log.resourceType, log.resourceName, log.createdAt)
    }
    for (const skill of ctx.skillHub.skills().all()) {
      if (!['deprecated', 'offline'].includes(skill.status)) continue
      if (!skill.deprecatedAt || skill.deprecatedAt < fromIso) continue
      add(skill.deprecatedReason ?? '', 'skill', skill.name, skill.deprecatedAt)
    }
    // Agent/应用下线经审批执行器落生命周期留痕（note 即下架原因），不经 change 日志
    for (const type of ['agent', 'app']) {
      for (const entity of ctx.resourceCore.list(type)) {
        for (const entry of entity.lifecycleHistory ?? []) {
          if (entry.action !== 'offline' || (entry.at ?? '') < fromIso) continue
          add(entry.note ?? '', type, entity.name, entry.at)
        }
      }
    }
    const reasons = [...buckets.values()].sort((a, b) => b.count - a.count)
    return { days, total: reasons.reduce((sum, bucket) => sum + bucket.count, 0), reasons }
  })
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
