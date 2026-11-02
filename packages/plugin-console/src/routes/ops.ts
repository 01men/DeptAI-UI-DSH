/**
 * Ops 域路由：多租户最小集/计量管道/全员工作台与效果回传/总线死信重投/成本摘要与反馈聚合/模型渠道治理（渠道组/遥测/预算）（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出，处理器逐字搬运（行为与迁出前一致）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConsoleRouteDeps } from './deps.ts'
import type { HttpExchange } from '../../../platform-core/src/index.ts'
import { nonbillableUsage } from '../../../plugin-usage/src/index.ts'
import { t } from '../../../platform-i18n/src/index.ts'

export function registerOpsRoutes(ctx: Context, deps: ConsoleRouteDeps): void {
  const { http, guarded, body, changeLog, caller } = deps
  // -- 租户（多租户最小集，v1.2 第 2 步） ------------------------------------
  guarded('GET', '/api/iam/tenants', 'iam.org.read', () => ({
    tenants: ctx.iam.tenants().all(),
  }))

  guarded('POST', '/api/iam/tenants', 'iam.org.write', (exchange) => {
    const input = body<{ name: string; plan?: 'trial' | 'standard' | 'enterprise' }>(exchange)
    const tenant = ctx.iam.createTenant(input)
    changeLog(exchange, 'iam.tenant.create', 'tenant', tenant.id, tenant.name)
    return tenant
  })

  // -- 计量（usage 管道，v1.2 第 2 步） --------------------------------------
  guarded('GET', '/api/usage/events', 'usage.read', (exchange) => {
    return ctx.usage.query({
      ...(exchange.query.get('tenant_id') ? { tenant_id: exchange.query.get('tenant_id')! } : {}),
      ...(exchange.query.get('principal') ? { principal: exchange.query.get('principal')! } : {}),
      ...(exchange.query.get('resource') ? { resource: exchange.query.get('resource')! } : {}),
      ...(exchange.query.get('from') ? { from: exchange.query.get('from')! } : {}),
      ...(exchange.query.get('to') ? { to: exchange.query.get('to')! } : {}),
      ...(exchange.query.get('limit') ? { limit: Number(exchange.query.get('limit')) } : {}),
    })
  })

  guarded('GET', '/api/usage/totals', 'usage.read', (exchange) => {
    return ctx.usage.totals({
      ...(exchange.query.get('tenant_id') ? { tenant_id: exchange.query.get('tenant_id')! } : {}),
      ...(exchange.query.get('principal') ? { principal: exchange.query.get('principal')! } : {}),
      // REL-08：resource 过滤此前被路由静默丢弃（服务层 totals() 已支持）——?resource=<不存在键> 返回全库数字
      ...(exchange.query.get('resource') ? { resource: exchange.query.get('resource')! } : {}),
      ...(exchange.query.get('from') ? { from: exchange.query.get('from')! } : {}),
    })
  })

  /**
   * 计量自推（self-report）防伪造（C22/D11/V23 关联）：usage.write 是 Agent 默认凭证权限点，
   * 请求体 subject/org 此前不做归属校验，任意持点主体可伪造他者（他 agent/他人/他组织）的计量事实。
   * 现按可信 caller（exchange.principal，禁止来自请求参数）收敛 subject 归属：
   *   - machine：只能申报与自己凭证绑定的 agent:<refId>（refId 与令牌 principal.refId 一致）；
   *     事件 org 与该 Agent 登记组织不一致同样拒绝（跨组织）；
   *   - human：只能申报自己（user:<userId>）或本组织子树内的协作类键（kb:* / panel:*）；
   *   - '*' 平台管理员保留既有运维补录路径（既有合法路径不动）。
   * 跨主体/跨组织 → 403 中文拒绝 + audit.authz.denied 留痕（不静默改写）。
   */
  const orgSubtreeContains = (rootId: string, orgId: string): boolean => {
    let current = ctx.iam.orgs().get(orgId)
    let guard = 0
    while (current && guard++ < 32) {
      if (current.id === rootId) return true
      current = current.parentId ? ctx.iam.orgs().get(current.parentId) : undefined
    }
    return false
  }
  const denyUsageOwnership = (exchange: HttpExchange, info: ReturnType<ConsoleRouteDeps['caller']>, subject: string, reason: string): void => {
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point: 'usage.write(subject-ownership)',
      path: exchange.path,
      ...(subject ? { subject } : {}),
    })
    exchange.fail(403, 'FORBIDDEN', t('禁止写入其他主体或组织的计量事实（{reason}）', { reason }))
  }
  const assertUsageSubjectOwnership = (exchange: HttpExchange, info: ReturnType<ConsoleRouteDeps['caller']>, input: { org: string; subject: string }): boolean => {
    if (info.permissions.includes('*')) return true
    if (info.kind === 'machine') {
      const boundSubject = info.refType === 'agent' && info.refId ? `agent:${info.refId}` : ''
      if (!boundSubject) {
        denyUsageOwnership(exchange, info, input.subject, t('机器凭证未绑定 Agent 资源，无自有计量主体'))
        return false
      }
      if (input.subject !== boundSubject) {
        denyUsageOwnership(exchange, info, input.subject, t('机器主体只能申报自身计量 subject={subject}', { subject: boundSubject }))
        return false
      }
      const agent = ctx.resourceCore.get('agent', info.refId!)
      if (agent?.orgId && input.org && input.org !== agent.orgId) {
        denyUsageOwnership(exchange, info, input.subject, t('事件 org={org} 超出绑定 Agent 组织（{orgId}）', { org: input.org, orgId: agent.orgId }))
        return false
      }
      return true
    }
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const ownOrg = user?.orgId
    const subjectAllowed = input.subject === `user:${info.userId}` || /^(kb|panel):/.test(input.subject)
    if (!subjectAllowed) {
      denyUsageOwnership(exchange, info, input.subject, t('人类主体只能申报本人（user:<self>）或本组织协作类键（kb:*/panel:*）'))
      return false
    }
    if (!ownOrg || !input.org || !orgSubtreeContains(ownOrg, input.org)) {
      denyUsageOwnership(exchange, info, input.subject, t('事件 org={org} 超出你的组织子树（{ownOrg}）', { org: input.org || t('（空）'), ownOrg: ownOrg ?? t('未归属组织') }))
      return false
    }
    return true
  }

  guarded('POST', '/api/usage/record', 'usage.write', (exchange) => {
    const input = body<{ org: string; subject: string; principal: string; resource: string; meters: Array<{ key: string; value: number; unit: string }>; tenant_id?: string; trace_id?: string; idempotency_key?: string }>(exchange)
    if (!assertUsageSubjectOwnership(exchange, caller(exchange), input)) return
    const event = ctx.usage.record(input)
    changeLog(exchange, 'usage.record', 'usage_event', event.event_id, event.resource, t('{meters} charge={cents}分', { meters: event.meters.map((meter) => `${meter.key}=${meter.value}`).join(','), cents: event.pricing.charge_cents }))
    return event
  })

  // -- 全员工作台 / 效果回传（WP-04/A3 + WP-07/D1） ---------------------------------

  /** 资产引用 → 展示名（agent/app/nas 走资源注册表，mcp/skill 走各自注册表；id 或 slug 命中均可）。 */
  const usageAssetName = (resource: string): string => {
    const colon = resource.indexOf(':')
    const type = resource.slice(0, colon)
    const id = resource.slice(colon + 1)
    const matches = (item: { id?: string; slug?: string; name?: string }): boolean => item.id === id || item.slug === id
    try {
      if (type === 'agent' || type === 'app' || type === 'nas') return ctx.resourceCore.list(type).find(matches)?.name ?? id
      if (type === 'mcp') return ctx.mcpRegistry.services().all().find(matches)?.name ?? id
      if (type === 'skill') return ctx.skillHub.skills().all().find(matches)?.name ?? id
    } catch { /* 注册表缺失时回落裸标识 */ }
    return id
  }

  /**
   * 最近调用（WP-04/A3 全员工作台）：当前登录人自身的计量事件 ≤5，只读自见（不做跨人透视）。
   * 管理口径仍走 /api/usage/events（usage.read）。
   * console.read（2026-10-17）：纯读自见接口，被 console.login 蕴含（真实用户零感知），演示态可读。
   */
  guarded('GET', '/api/usage/recent', 'console.read', (exchange) => {
    const info = caller(exchange)
    if (!info.userId) return { items: [] }
    const limit = Math.min(Number(exchange.query.get('limit') ?? 5) || 5, 20)
    const subject = `user:${info.userId}`
    const items = ctx.usage.query({ limit: 200 }).items
      .filter((event) => event.subject === subject)
      .slice(0, limit)
      .map((event) => ({
        event_id: event.event_id,
        occurred_at: event.occurred_at,
        resource: event.resource,
        name: usageAssetName(event.resource),
        meters: event.meters,
        charge_cents: event.pricing.charge_cents,
        nonbillable: event.pricing.rate?.nonbillable === true,
      }))
    return { items }
  })

  /**
   * 反馈回传（WP-07/D1）：👍/👎 薄端点 —— 落零价快照 usage 事件（D2：charge=0 + nonbillable，
   * 不污染计量口径）。主体经 X-On-Behalf-User 归因（Agent 代用户回传），缺省取登录人；
   * 幂等键=主体+资源+消息（评分随事件内容 meter unit 落账），同 messageId 改评分不双计、同键重放不重复计数。
   * W4 收敛：X-On-Behalf-User 此前零校验（任意主体可归因到任意用户，伪造他人口径的反馈事实），
   * 现机器主体按「归一化 + 白名单三通道」收敛（见下方守卫注释）；human 主体行为完全不变。
   */
  // -- feedback 归因守卫（W4）：X-On-Behalf-User 白名单收敛 ---------------------------------
  // 头值归一化：平台 userId 直查 → 钉钉 staffId 等三方标识经 identityLinks 反查回平台 userId
  // （镜像 plugin-nas resolveUser 口径；iam 注释：hermes X-On-Behalf-User 头即 staffId 口径）。
  // attribution-only（MCP 治理契约 §4，2026-10-22）：本头仅作反馈「归因」（谁替谁说的话），
  // 禁止作为授权事实——授权面身份一律取令牌解析结果（exchange.principal.unified）；
  // 归因合法性由下方白名单守卫承担，本读取处行为保持不变。
  const resolveFeedbackOnBehalfUser = (raw: string): string | undefined => {
    const direct = ctx.iam.users().get(raw)
    if (direct) return direct.id
    const link = ctx.iam.identityLinks().findOne((item) => item.providerUserId === raw)
    return link ? ctx.iam.users().get(link.userId)?.id : undefined
  }
  // 拒绝形态照 denyUsageOwnership 样板：audit.authz.denied 留痕（point=usage.feedback(on-behalf:...)）
  // + 403 中文原因，不静默改写。
  const denyFeedbackAttribution = (exchange: HttpExchange, info: ReturnType<ConsoleRouteDeps['caller']>, point: string, subject: string, message: string): void => {
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point,
      path: exchange.path,
      ...(subject ? { subject } : {}),
    })
    exchange.fail(403, 'FORBIDDEN', message)
  }
  /**
   * 机器主体归因白名单守卫（human 行为不变，既有代报场景保持）：
   *   - machine+无头：维持既有 403（补同形 audit 留痕，point=usage.feedback(on-behalf:missing)）；
   *   - machine+有头：头值先归一化（fail-closed——两步皆 miss 拒绝，不可归因到不存在的人），通过后按
   *     三通道白名单放行：①Agent 负责人（resourceCore ownerId）②绑定真人（agentRegistry boundUsers）
   *     ③员工主管（workforceStore 结构化探测；console 先于 workforce 装配，缺席即静默跳过该通道，
   *     不用 workforceIdentity.resolveByCaller——停职/无任用时返 null 会误杀合法主管）；
   *     '*' 平台管理员直通白名单但不跳过归一化（归一化失败仍 403）。
   * 返回 false=已拒绝（守卫内已写 audit + 403，调用方短路）；string=本次应采用的归因标识
   * （human=原样透传保持既有口径；machine=归一化后的平台 userId）。
   */
  const assertFeedbackAttribution = (exchange: HttpExchange, info: ReturnType<ConsoleRouteDeps['caller']>, onBehalfRaw: string): string | false => {
    if (info.kind !== 'machine') return onBehalfRaw
    const point = info.refType === 'agent' && info.refId
      ? `usage.feedback(on-behalf:agent:${info.refId})`
      : 'usage.feedback(on-behalf:machine)'
    if (!onBehalfRaw) {
      denyFeedbackAttribution(exchange, info, 'usage.feedback(on-behalf:missing)', '', t('机器主体回传反馈须携带 X-On-Behalf-User 归因到人'))
      return false
    }
    const targetUserId = resolveFeedbackOnBehalfUser(onBehalfRaw)
    if (!targetUserId) {
      denyFeedbackAttribution(exchange, info, point, onBehalfRaw, t('禁止将反馈归因到不存在的主体（{subject} 未命中平台用户与三方身份映射）', { subject: onBehalfRaw }))
      return false
    }
    if (info.permissions.includes('*')) return targetUserId
    if (info.refType !== 'agent' || !info.refId) {
      denyFeedbackAttribution(exchange, info, point, targetUserId, t('机器凭证未绑定 Agent 资源，无归因白名单通道'))
      return false
    }
    if (ctx.resourceCore.get('agent', info.refId)?.ownerId === targetUserId) return targetUserId
    if (ctx.agentRegistry.boundUsers(info.refId).some((item) => item.userId === targetUserId)) return targetUserId
    // 员工主管通道（结构化探测）：workforceStore 由 plugin-workforce 后补装配，缺席/形状不符静默跳过。
    // cordis 严格注入：console fiber 未声明 workforceStore（装配序在其后），裸读 ctx 键会抛
    // 「cannot get property without inject」——必须 try/catch 包裹（缺席=跳过通道，不阻断守卫）。
    let workforce: {
      bindings?: { findWhere?: (query: Record<string, unknown>) => Array<{ employeeId?: string }> }
      employees?: { get?: (id?: string) => { supervisorUserId?: string } | undefined }
    } | undefined
    try {
      workforce = (ctx as unknown as { workforceStore?: typeof workforce }).workforceStore
    } catch { /* console 未注入 workforceStore（装配序在其后）——员工主管通道跳过 */ }
    const binding = workforce?.bindings?.findWhere?.({ agentId: info.refId, status: 'active' })?.[0]
    const supervisorUserId = binding ? workforce?.employees?.get?.(binding.employeeId)?.supervisorUserId : undefined
    if (supervisorUserId && supervisorUserId === targetUserId) return targetUserId
    denyFeedbackAttribution(exchange, info, point, targetUserId, t('归因目标不在该 Agent 的白名单内（负责人/绑定真人/员工主管三通道均未命中）'))
    return false
  }

  guarded('POST', '/api/usage/feedback', 'console.login', (exchange) => {
    const info = caller(exchange)
    const input = body<{ resource: string; messageId?: string; score: 'up' | 'down'; note?: string }>(exchange)
    if (!input.resource?.trim() || (input.score !== 'up' && input.score !== 'down')) {
      exchange.fail(400, 'BAD_REQUEST', t('resource 与 score（up/down）必填'))
      return
    }
    // W4：归因收敛入口——machine 走白名单守卫（拒绝时已 403+audit，短路）；human 原样透传（行为不变）
    const onBehalfHeader = exchange.headers['x-on-behalf-user']
    const onBehalfResolved = assertFeedbackAttribution(exchange, info,
      String((Array.isArray(onBehalfHeader) ? onBehalfHeader[0] : onBehalfHeader) ?? '').trim())
    if (onBehalfResolved === false) return
    const onBehalf = onBehalfResolved
    const subject = onBehalf ? `user:${onBehalf}` : (info.userId ? `user:${info.userId}` : '')
    if (!subject) {
      exchange.fail(403, 'FORBIDDEN', t('机器主体回传反馈须携带 X-On-Behalf-User 归因到人'))
      return
    }
    // W4：组织口径随归因——机器代报（onBehalf=已归一化目标 userId）取目标用户组织；
    // human（含 OBO 代报）维持调用者组织不变。机器无 userId，原口径恒空串会让
    // usage 事件 org 必填校验 400，绑定真人白名单通道永远到不了 200。
    const orgSourceUserId = info.kind === 'machine' && onBehalf ? onBehalf : (info.userId ?? '')
    const orgId = (orgSourceUserId ? ctx.iam.users().get(orgSourceUserId)?.orgId : undefined) ?? ''
    const event = ctx.usage.record({
      ...nonbillableUsage({
        org: orgId,
        subject,
        principal: orgId ? `org:${orgId}` : 'platform',
        resource: input.resource,
        idempotency_key: `feedback:${subject}:${input.resource}:${input.messageId ?? 'anon'}`,
      }),
      // 评分随事件内容（meter unit）落账：幂等键去 score 段后（同 messageId 改评分不双计），
      // 聚合面 feedbackStats 改从事件内容取分；同键改评由 usage.record 的 feedback 幂等口径承接。
      meters: [{ key: 'calls', value: 1, unit: input.score }],
    })
    changeLog(exchange, 'usage.feedback', 'usage_event', event.event_id, input.resource,
      t('{score}{note}（非计费零价快照，X-On-Behalf-User{onBehalf}）', { score: input.score, note: input.note ? t('：{note}', { note: input.note }) : '', onBehalf: onBehalf ? `=${onBehalf}` : t('未用') }))
    return { event_id: event.event_id, charge_cents: event.pricing.charge_cents, nonbillable: event.pricing.rate?.nonbillable === true }
  })

  guarded('GET', '/api/usage/price-book', 'usage.admin', () => ({
    entries: ctx.usage.priceBook().all(),
  }))

  guarded('PUT', '/api/usage/price-book', 'usage.admin', (exchange) => {
    const input = body<{ pattern: string; meter_key: string; list_cents_per_unit: number; cost_cents_per_unit: number; units_per_step: number; tax_rate?: number; currency?: string; rate_version?: string }>(exchange)
    const entry = ctx.usage.upsertPrice({ tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08', ...input })
    changeLog(exchange, 'usage.price.upsert', 'price_entry', entry.id, entry.pattern)
    return entry
  })

  guarded('POST', '/api/usage/reconcile', 'usage.admin', (exchange) => {
    const since = exchange.query.get('from') ?? undefined
    const reconciliation = ctx.usage.reconcile(since)
    const drift = ctx.usage.capabilityDrift(since)
    changeLog(exchange, 'usage.reconcile', 'usage', 'reconcile', '', `mismatch=${reconciliation.mismatch} drift=${drift.drift.length}`)
    return { reconciliation, drift }
  })

  guarded('GET', '/api/usage/dead-letters', 'usage.admin', () => ({
    items: ctx.usage.deadLetters().all(),
  }))

  guarded('POST', '/api/usage/replay', 'usage.admin', (exchange) => {
    const { from } = body<{ from: string }>(exchange)
    const result = ctx.usage.replay(from)
    changeLog(exchange, 'usage.replay', 'usage', 'replay', '', `replayed=${result.replayed}`)
    return result
  })

  guarded('POST', '/api/usage/dead-letters/retry', 'usage.admin', (exchange) => {
    const result = ctx.usage.retryDeadLetters()
    changeLog(exchange, 'usage.deadletter.retry', 'usage', 'dead-letters', '', t('重投 {retried} 条，剩余 {remaining} 条', { retried: result.retried, remaining: result.remaining }))
    return result
  })

  // -- 总线死信（QA C-03）：对齐 usage 死信面——运维不再翻 jsonl -------------------
  guarded('GET', '/api/bus/dead-letters', 'usage.admin', () => ({
    deadLetters: ctx.platformBus.deadLetters(),
  }))

  guarded('POST', '/api/bus/dead-letters/retry', 'usage.admin', (exchange) => {
    const result = ctx.platformBus.retryDeadLetters()
    changeLog(exchange, 'bus.deadletter.retry', 'bus', 'dead-letters', '', t('尝试 {attempted} 条，重投 {redelivered} 条，保留 {retained} 条', { attempted: result.attempted, redelivered: result.redelivered, retained: result.retained }))
    return result
  })

  // 保留策略手动巡检（缺省按 USAGE_RETENTION_DAYS 配置的窗口；body.days 允许管理员临时以更短窗口清理，
  // 0=本次跳过）。日常清理由 usage 服务内建定时巡检承担，此端点是运维的手动对账口。
  guarded('POST', '/api/usage/retention/purge', 'usage.admin', (exchange) => {
    const input = body<{ days?: number }>(exchange)
    const days = typeof input.days === 'number' && Number.isFinite(input.days) && input.days >= 0 ? Math.floor(input.days) : undefined
    const result = ctx.usage.purgeExpired(days)
    changeLog(exchange, 'usage.retention.purge', 'usage', 'retention', '', t('days={days} 事件={events} 水位={watermarks} 死信={deadLetters}', { days: days ?? 'default', events: result.purgedEvents, watermarks: result.purgedWatermarks, deadLetters: result.purgedDeadLetters }))
    return { ...result, retentionDays: ctx.usage.retentionDays }
  })

  guarded('PUT', '/api/usage/capability-grants', 'usage.admin', (exchange) => {
    const input = body<{ principal: string; capabilities: string[]; source?: string }>(exchange)
    return ctx.usage.grantCapabilities(input.principal, input.capabilities, input.source ?? 'console')
  })

  // -- 成本摘要与反馈聚合（IAW 交接 4-1/4-2，面板度量驾驶舱数据源） ----------------
  // 权限分层：panel.read 可查，但非 usage.read 主体强制收敛到自身组织（scope=self-org）。
  // 窗口边界为 UTC 日界（与 usage byDay/costReport 口径一致）。
  const usageWindowBounds = (window: string): { from: string; to: string } => {
    const now = new Date()
    const to = now.toISOString()
    if (window === 'month') return { from: `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`, to }
    return { from: `${now.toISOString().slice(0, 10)}T00:00:00.000Z`, to }
  }

  guarded('GET', '/api/usage/summary', 'panel.read', (exchange) => {
    const info = caller(exchange)
    const canCrossOrg = info.permissions.includes('*') || info.permissions.includes('usage.read')
    const window = exchange.query.get('window') === 'month' ? 'month' : 'today'
    const { from, to } = usageWindowBounds(window)
    let org = exchange.query.get('org') ?? undefined
    let subject = exchange.query.get('subject') ?? undefined
    if (!canCrossOrg) {
      const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
      org = user?.orgId ?? '__no_org__' // 组织解析失败 → 空聚合（fail-closed，不透穿全平台成本）
      subject = undefined
    }
    const summary = ctx.usage.summary({ from, to, ...(org ? { org } : {}), ...(subject ? { subject } : {}) })
    // 预算进度（1-4 联动）：modelgw 预算在位时随摘要返回，缺席=无预算配置
    let budget: unknown = null
    try {
      budget = (ctx.modelGateway as unknown as { budgetStatusFor?: (org: string) => unknown } | undefined)?.budgetStatusFor?.(org ?? '') ?? null
    } catch { /* 预算面缺席不阻塞摘要 */ }
    return { window, scope: canCrossOrg ? 'platform' : 'self-org', ...(org ? { org } : {}), ...(subject ? { subject } : {}), budget, ...summary }
  })

  guarded('GET', '/api/usage/feedback-stats', 'panel.read', (exchange) => {
    const info = caller(exchange)
    const canCrossOrg = info.permissions.includes('*') || info.permissions.includes('usage.read')
    const daysParam = Number(exchange.query.get('days') ?? 30)
    const days = exchange.query.get('days') === 'all' ? 0 : Math.min(Math.max(Number.isFinite(daysParam) ? daysParam : 30, 1), 365)
    const from = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined
    let org = exchange.query.get('org') ?? undefined
    if (!canCrossOrg) {
      const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
      org = user?.orgId ?? '__no_org__'
    }
    const stats = ctx.usage.feedbackStats({ ...(from ? { from } : {}), ...(org ? { org } : {}) })
    return { windowDays: days, scope: canCrossOrg ? 'platform' : 'self-org', ...(org ? { org } : {}), ...stats }
  })

  // -- 模型渠道治理（IAW 交接 1-2/1-3/1-4：渠道组/遥测/预算，modelgw 域面） --------
  guarded('GET', '/api/modelgw/channel-groups', 'panel.read', () => ({
    groups: ctx.modelGateway.channelGroups().all().map((group) => ({
      ...group,
      chain: [group.primary, group.backup1, group.backup2].filter(Boolean),
      stepTimeoutMs: group.stepTimeoutMs ?? 8000,
    })),
  }))

  guarded('PUT', '/api/modelgw/channel-groups', 'panel.config.write', (exchange) => {
    const input = body<{ slug: string; name: string; primary: string; backup1?: string; backup2?: string; manual?: boolean; stepTimeoutMs?: number; enabled?: boolean }>(exchange)
    if (!input.slug?.trim() || !input.primary?.trim() || !input.name?.trim()) {
      exchange.fail(400, 'BAD_REQUEST', t('slug/name/primary 必填'))
      return
    }
    if (input.stepTimeoutMs !== undefined && (input.stepTimeoutMs < 500 || input.stepTimeoutMs > 60_000)) {
      exchange.fail(400, 'BAD_REQUEST', t('stepTimeoutMs 应在 500-60000ms 之间（PRD §4.1 口径 8000）'))
      return
    }
    const group = ctx.modelGateway.upsertChannelGroup({
      slug: input.slug.trim(), name: input.name.trim(), primary: input.primary.trim(),
      ...(input.backup1 ? { backup1: input.backup1.trim() } : {}),
      ...(input.backup2 ? { backup2: input.backup2.trim() } : {}),
      ...(input.manual !== undefined ? { manual: input.manual } : {}),
      ...(input.stepTimeoutMs !== undefined ? { stepTimeoutMs: input.stepTimeoutMs } : {}),
      enabled: input.enabled ?? true,
    })
    changeLog(exchange, 'modelgw.channel_group.upsert', 'modelgw_channel_group', group.id, group.name)
    return group
  })

  /**
   * 降级链调用入口（IAW 交接 1-2）：按渠道组 主→备1→备2 逐级尝试，每步 stepTimeoutMs 超时；
   * 每次降级发 modelgw.degraded（面板 SSE 提示条消费）。全链失败且组配 manual=true →
   * 200 + ok:false + escalated:true（转人工），不造假回复。
   */
  guarded('POST', '/api/modelgw/channel-groups/:slug/invoke', 'panel.write', async (exchange) => {
    const input = body<{ messages?: Array<{ role: string; content: string }>; prompt?: string; dataClass?: string; maxTokens?: number }>(exchange)
    const messages = input.messages ?? (input.prompt ? [{ role: 'user', content: input.prompt }] : [])
    if (messages.length === 0) {
      exchange.fail(400, 'BAD_REQUEST', t('messages（或 prompt）必填'))
      return
    }
    const info = caller(exchange)
    const orgId = (info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined)
      ?? ctx.iam.orgs().find((org) => org.parentId === null).at(0)?.id ?? ''
    const dataClass = input.dataClass === 'public' || input.dataClass === 'internal' || input.dataClass === 'secret' ? input.dataClass : undefined
    const result = await ctx.modelGateway.invokeWithFallback({
      group: exchange.params['slug']!,
      orgId,
      subject: info.userId ? `user:${info.userId}` : `machine:${info.principalId}`,
      messages,
      // C22/D11（additive）：渠道组直调也组装可信 caller 随调用传入——身份只取 exchange.principal
      // （console 鉴权中间件的 Bearer 验证结果），禁止来自请求体；modelgw（组4）按可选 caller
      // 做受管数字员工判定与统一归因，使面板渠道组链路与 REST/MCP 链路的主体口径一致。
      // org/subject 现状保留（组织维度口径不动，历史统计不失真）。
      caller: {
        kind: info.kind,
        principalId: info.principalId,
        ...(info.userId ? { userId: info.userId } : {}),
        ...(info.refType ? { refType: info.refType } : {}),
        ...(info.refId ? { refId: info.refId } : {}),
        name: info.name,
      },
      ...(dataClass ? { dataClass } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    })
    return result
  })

  guarded('GET', '/api/modelgw/:slug/telemetry', 'panel.read', (exchange) => {
    const slug = exchange.params['slug']!
    if (!ctx.modelGateway.models().findOne((item) => item.slug === slug)) {
      exchange.fail(404, 'NOT_FOUND', t('模型不存在：{slug}', { slug }))
      return
    }
    const windowDays = Math.min(Math.max(Number(exchange.query.get('window')?.replace(/d$/, '') ?? 7) || 7, 1), 30)
    return ctx.modelGateway.telemetryFor(slug, windowDays)
  })

  guarded('GET', '/api/modelgw/budgets', 'panel.read', (exchange) => ({
    budgets: ctx.modelGateway.budgets().all()
      .filter((budget) => (exchange.query.get('org') ? (budget.orgId ?? '') === exchange.query.get('org') : true)),
  }))

  guarded('PUT', '/api/modelgw/budgets', 'panel.config.write', (exchange) => {
    const input = body<{
      orgId?: string; modelSlug?: string; subject?: string; freezeAgent?: boolean
      dailyLimitCents?: number; monthlyLimitCents?: number
      warnRatio?: number; action?: 'warn' | 'block'; enabled?: boolean
    }>(exchange)
    for (const [key, value] of [['dailyLimitCents', input.dailyLimitCents], ['monthlyLimitCents', input.monthlyLimitCents]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        exchange.fail(400, 'BAD_REQUEST', t('{key} 应为非负数（分）', { key }))
        return
      }
    }
    try {
      const budget = ctx.modelGateway.upsertBudget({
        ...(input.orgId ? { orgId: input.orgId } : {}),
        ...(input.modelSlug ? { modelSlug: input.modelSlug } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.freezeAgent !== undefined ? { freezeAgent: input.freezeAgent } : {}),
        ...(input.dailyLimitCents !== undefined ? { dailyLimitCents: input.dailyLimitCents } : {}),
        ...(input.monthlyLimitCents !== undefined ? { monthlyLimitCents: input.monthlyLimitCents } : {}),
        warnRatio: input.warnRatio ?? 0.8,
        action: input.action ?? 'warn',
        enabled: input.enabled ?? true,
      })
      changeLog(exchange, 'modelgw.budget.upsert', 'modelgw_budget', budget.id, `${budget.orgId ?? t('（平台级）')}${budget.subject ? `/${budget.subject}` : ''}${budget.modelSlug ? `/${budget.modelSlug}` : ''}`)
      return budget
    } catch (error) {
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  })

  // R4 删除面：配错/废弃预算的删除口（此前只能 enabled:false 滞留）
  guarded('DELETE', '/api/modelgw/budgets/:id', 'panel.config.write', (exchange) => {
    ctx.modelGateway.removeBudget(exchange.params['id']!)
    changeLog(exchange, 'modelgw.budget.delete', 'modelgw_budget', exchange.params['id'] ?? '', '')
    return { deleted: true }
  })

}
