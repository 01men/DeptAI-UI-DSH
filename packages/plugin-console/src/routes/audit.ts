/**
 * Audit 域路由：审计查询/审批闭环（申请-批准-执行）/告警规则与触发/证据锚点与场景时间线（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出，处理器逐字搬运（行为与迁出前一致）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { t } from '../../../platform-i18n/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'

export function registerAuditRoutes(ctx: Context, deps: ConsoleRouteDeps): void {
  const { http, guarded, body, changeLog, caller } = deps
  // -- Audit / 审批 / 告警 --------------------------------------------------
  guarded('GET', '/api/audit/logs', 'audit.read', (exchange) => {
    return ctx.audit.query({
      type: (exchange.query.get('type') ?? undefined) as never,
      actorId: exchange.query.get('actorId') ?? undefined,
      resourceType: exchange.query.get('resourceType') ?? undefined,
      resourceId: exchange.query.get('resourceId') ?? undefined,
      result: exchange.query.get('result') ?? undefined,
      q: exchange.query.get('q') ?? undefined,
      since: exchange.query.get('since') ?? undefined,
      // 全链 trace 精确检索（W3-T5 契约 §14）：与 mcp.invoked 落审计的 traceId 维度对齐
      traceId: exchange.query.get('traceId') ?? undefined,
      limit: Number(exchange.query.get('limit') ?? 100),
    })
  })

  // ndjson 流式导出（W3-T5 契约 §14）：append-only 导出，行序=时间序，附尾行 _chainTip；
  // 权限点同既有审计读点。处理器直接写响应（guard 侧 writableEnded 判定自然跳过 ok 包装）。
  guarded('GET', '/api/audit/export', 'audit.read', (exchange) => {
    ctx.audit.exportNdjson(exchange, {
      since: exchange.query.get('since') ?? undefined,
      until: exchange.query.get('until') ?? undefined,
    })
  })

  guarded('GET', '/api/audit/summary', 'audit.read', () => ctx.audit.summary())

  guarded('GET', '/api/audit/alert-rules', 'audit.read', () => ({ rules: ctx.audit.alertRules().all() }))

  guarded('POST', '/api/audit/alert-rules', 'audit.rule.write', (exchange) => {
    const input = body<{ name: string; metric: string; threshold: number; windowMinutes?: number; severity?: 'critical' | 'warning' | 'info'; channels?: string[]; enabled?: boolean; description?: string }>(exchange)
    const rule = ctx.audit.createAlertRule({
      name: input.name,
      metric: input.metric,
      operator: 'gt',
      threshold: input.threshold,
      windowMinutes: input.windowMinutes ?? 10,
      severity: input.severity ?? 'warning',
      channels: input.channels ?? ['dingtalk'],
      enabled: input.enabled ?? true,
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
    changeLog(exchange, 'audit.rule.create', 'alert_rule', rule.id, rule.name)
    return rule
  })

  guarded('PATCH', '/api/audit/alert-rules/:id', 'audit.rule.write', (exchange) => {
    const input = body<{ enabled?: boolean; threshold?: number; severity?: string; channels?: string[] }>(exchange)
    const rule = ctx.audit.alertRules().update(exchange.params['id']!, input as never)
    changeLog(exchange, 'audit.rule.update', 'alert_rule', rule.id, rule.name)
    return rule
  })

  guarded('GET', '/api/audit/alerts', 'audit.read', (exchange) => ({
    alerts: ctx.audit.alerts().find((item) => (exchange.query.get('unread') === '1' ? !item.read : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }))

  guarded('POST', '/api/audit/alerts/:id/read', 'audit.read', (exchange) => {
    ctx.audit.markAlertRead(exchange.params['id']!)
    return { read: true }
  })

  guarded('POST', '/api/audit/alerts/read-all', 'audit.read', (exchange) => {
    const read = ctx.audit.markAllAlertsRead()
    changeLog(exchange, 'audit.alert.readAll', 'alert', 'all', '', t('一键全部已读（{n} 条）', { n: read }))
    return { read, unread: 0 }
  })

  guarded('GET', '/api/audit/cost', 'audit.read', (exchange) => {
    // QA B-04：days 参数此前被静默丢弃（「近 14 天」实为全量聚合）——未显式给 from 时按 days 折算窗口起点
    const from = exchange.query.get('from') ?? undefined
    const to = exchange.query.get('to') ?? undefined
    const daysParam = Number(exchange.query.get('days') ?? 0)
    const days = Number.isInteger(daysParam) && daysParam > 0 ? Math.min(daysParam, 365) : 0
    const effectiveFrom = from ?? (days > 0
      ? new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
      : undefined)
    return {
      groupBy: exchange.query.get('groupBy') ?? 'app',
      ...(days > 0 && !from ? { days } : {}),
      rows: ctx.audit.costReport((exchange.query.get('groupBy') ?? 'app') as 'app' | 'agent' | 'org' | 'date', effectiveFrom, to),
    }
  })

  // -- 证据锚点与场景时间线（IAW 交接 5-1/5-2） ---------------------------------
  // 面板消费面：结论级证据登记/反查 + 场景维度审计时间线（panel.read/write；治理面全量审计仍走 audit.read）。
  guarded('POST', '/api/audit/evidence', 'panel.write', (exchange) => {
    const input = body<{ anchors: Array<{ kind: string; id: string; name?: string; timeWindow?: { from: string; to: string }; hitRows?: number; qualityScore?: number }>; sceneCode?: string; messageId?: string; sessionId?: string; subject?: string; note?: string }>(exchange)
    const record = ctx.audit.recordEvidence({
      anchors: input.anchors ?? [],
      ...(input.sceneCode ? { sceneCode: input.sceneCode } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.note ? { note: input.note } : {}),
    })
    changeLog(exchange, 'audit.evidence.record', 'evidence', record.id, input.anchors?.map((anchor) => anchor.id).join(',') ?? '', t('{n} 个锚点{suffix}', { n: input.anchors?.length ?? 0, suffix: input.messageId ? t('，绑定消息 {messageId}', { messageId: input.messageId }) : '' }))
    return record
  })

  guarded('GET', '/api/audit/evidence/:id', 'panel.read', (exchange) => {
    const record = ctx.audit.getEvidence(exchange.params['id']!)
    if (!record) {
      exchange.fail(404, 'NOT_FOUND', t('证据登记不存在：{id}', { id: exchange.params['id'] }))
      return
    }
    return record
  })

  guarded('GET', '/api/audit/timeline', 'panel.read', (exchange) => {
    return ctx.audit.timeline({
      ...(exchange.query.get('sceneCode') ? { sceneCode: exchange.query.get('sceneCode')! } : {}),
      ...(exchange.query.get('since') ? { since: exchange.query.get('since')! } : {}),
      ...(exchange.query.get('limit') ? { limit: Number(exchange.query.get('limit')) } : {}),
    })
  })

}
