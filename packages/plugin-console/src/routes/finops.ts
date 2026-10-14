/**
 * FinOps CFO 视图路由（M2，按 routes/market.ts 拆分模式新建——不再向 apply() 增重）：
 * 成本穿透（org×model 交叉 + 环比）与空转检测（无后续动作的调用，近似口径）。
 * 权限沿用 usage.read（聚合报表，不暴露个体明细）；金额口径 = 内部成本参考（cost_cents），
 * charge_cents 零价快照恒 0 不参与穿透（对齐 docs/contract-j4-usage-report.md M0-3 口径）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../../platform-core/src/index.ts'

export interface FinOpsRouteDeps {
  guarded: (method: string, path: string, permission: string, handler: (exchange: HttpExchange) => unknown | Promise<unknown>) => void
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function monthParam(exchange: HttpExchange): string | undefined {
  const value = exchange.query.get('month') ?? ''
  if (value === '') return undefined
  if (!MONTH_RE.test(value)) throw new Error('月份格式应为 YYYY-MM（如 2026-09）')
  return value
}

/** CSV 值转义（逗号/引号/换行）。 */
function csvEsc(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function registerFinOpsRoutes(ctx: Context, deps: FinOpsRouteDeps): void {
  const { guarded } = deps

  // CFO 视图一次请求全量数据（穿透 + 空转）：页面单请求渲染，无瀑布依赖
  guarded('GET', '/api/finops/overview', 'usage.read', (exchange) => {
    const month = monthParam(exchange)
    const idleWindowMinutes = Number(exchange.query.get('window') ?? '') || undefined
    return {
      penetration: ctx.usage.costPenetration(month),
      idle: ctx.usage.idleAnalysis({ ...(month !== undefined ? { month } : {}), ...(idleWindowMinutes !== undefined ? { idleWindowMinutes } : {}) }),
    }
  })

  // 空转独立查询（窗口分钟数可调，供复核近似口径敏感度）
  guarded('GET', '/api/finops/idle', 'usage.read', (exchange) => {
    const month = monthParam(exchange)
    const idleWindowMinutes = Number(exchange.query.get('window') ?? '') || undefined
    return ctx.usage.idleAnalysis({ ...(month !== undefined ? { month } : {}), ...(idleWindowMinutes !== undefined ? { idleWindowMinutes } : {}) })
  })

  // CFO 成本报表导出（Excel 友好 UTF-8 BOM CSV）：穿透三维 + 空转汇总两个区块
  guarded('GET', '/api/finops/report/monthly', 'usage.read', (exchange) => {
    const month = monthParam(exchange)
    const report = ctx.usage.costPenetration(month)
    const idle = ctx.usage.idleAnalysis({ month: report.month })
    if ((exchange.query.get('format') ?? '') !== 'csv') return { penetration: report, idle }
    const lines: string[] = []
    lines.push(`元冰可 FinOps 成本报表（${report.month}；金额=内部成本参考分，零价快照口径 charge 恒 0）`)
    lines.push('区块,维度,维度值,事件数,tokens,cost_cents,上月cost_cents,环比%,备注')
    const push = (block: string, dim: string, values: Array<string | number>) => lines.push([block, dim, ...values.map(csvEsc)].join(','))
    push('total', 'ALL', ['全口径', report.totals.events, report.totals.tokens, report.totals.cost_cents, report.totals.prev_cost_cents, report.totals.delta_pct ?? '—', ''])
    for (const row of report.byOrg) {
      push('部门穿透', 'org', [row.dimension, row.events, row.tokens, row.cost_cents, row.prev_cost_cents, row.delta_pct ?? '—', (row.topModels ?? []).map((m) => `${m.model} ${(m.share ?? 0)}%`).join(' / ')])
    }
    for (const row of report.byModel) {
      push('模型穿透', 'model', [row.dimension, row.events, row.tokens, row.cost_cents, row.prev_cost_cents, row.delta_pct ?? '—', ''])
    }
    push('空转检测', '近似口径', [`无后续动作调用（窗口 ${idle.idleWindowMinutes} 分钟，需人工复核）`, idle.idle.events, idle.idle.tokens, idle.idle.cost_cents, '', '', `占模型调用成本 ${idle.idle.share_pct}%`])
    for (const row of idle.byModel) {
      push('空转-按模型', 'model', [row.model, row.idle_events, '', row.idle_cost_cents, '', '', `全口径 ${row.events} 次事件`])
    }
    exchange.res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="finops-report-${report.month}.csv"`,
    })
    exchange.res.end('\ufeff' + lines.join('\r\n') + '\r\n')
    return undefined
  })
}
