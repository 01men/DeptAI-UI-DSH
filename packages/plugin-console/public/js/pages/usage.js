/** 用量与成本（#/usage · WE 治理域，规格 docs/internal/design-adaptation-spec-20261014.md §5.5）：
 *  tokens / 成本双维度切换 + 28 天面积趋势 + Top 资产横条 + 部门分摊表（占比条 + 环比）+ 单位 DAU 成本条 + 导出 CSV。
 *  数据源：GET /api/usage/report?days=28&dim=tokens|cost（WB 实现，真实 usage 事件聚合；空数据空态，零演示数据）。
 *  导出：以已加载的 28 天报表在前端组 CSV（BOM + a[download] Blob 下载，不开新窗）；
 *  月度口径的服务端导出仍保留在财务视图（/api/usage/report/monthly 与 /api/finops/report/monthly?format=csv）。 */
import { api } from '../api.js'
import { icon } from '../icons.js'
import {
  $, esc, toast, fmtNum, fmtCost, emptyState, sectionHead, tabRow, areaChart, hBarList,
  progressBar, emptyHint,
} from '../ui.js'
import rqI18n from '../i18n.js'

export async function renderUsage(content, params, ctx) {
  const dim = params.get('dim') === 'cost' ? 'cost' : 'tokens'
  content.innerHTML = '<div style="padding:48px;text-align:center;color:var(--text-3)">用量报表加载中…</div>'

  let report = null
  let loadError = null
  try {
    report = await api.get(`/api/usage/report?days=28&dim=${dim}`)
  } catch (error) {
    loadError = error
  }

  content.innerHTML = `
    ${sectionHead({
      label: 'USAGE REPORT / J4',
      title: '用量与成本穿透',
      extra: '部门 / 资产 / 应用效率三维聚合 · 价格簿零价快照 + 内部成本参考 · 对外不呈现金额结算语义',
      actions: `<button class="btn btn-default" id="usage-csv">${icon('download', 14)} 导出 CSV</button>`,
    })}
    <div id="usage-body"></div>`

  const body = $('#usage-body')
  if (loadError) {
    const box = document.createElement('div')
    body.appendChild(box)
    box.appendChild(emptyState({
      title: loadError.status === 403 ? '无用量报表读取权限' : '用量报表暂不可用',
      desc: loadError.status === 403
        ? '用量报表接口需要 usage.read 权限；如需查看请联系管理员开通。'
        : rqI18n.t('{msg}——/api/usage/report（28 天报表）可能尚未在当前宿主部署，可先前往财务视图查看月度口径报表。', { msg: loadError.message }),
      actionText: '重试',
      onAction: () => ctx.rerender(),
      icon: 'chart',
    }))
    bindExport(null)
    return
  }

  const series = report?.series ?? []
  const byOrg = report?.byOrg ?? []
  const topAssets = report?.topAssets ?? []
  const unitDau = report?.unitDau ?? []
  const days = report?.days ?? (series.length || 28)

  // 维度切换（tabRow）：切换后带 dim 参数重查（服务端按维度聚合占比/排行口径）
  const tabs = tabRow([
    { key: 'tokens', label: '消耗（tokens）' },
    { key: 'cost', label: '成本参考（元）' },
  ], dim, (key) => { location.hash = `#/usage?dim=${key}` })
  const tabsMount = document.createElement('div')
  tabsMount.appendChild(tabs)

  // report 各 cost 字段均为内部成本参考分（usage 事件聚合口径），展示/导出侧统一 /100 折元
  const yuan = (cents) => (Number(cents) || 0) / 100
  const values = series.map((point) => Number(dim === 'cost' ? yuan(point.cost) : point.tokens) || 0)
  const total = values.reduce((sum, value) => sum + value, 0)
  const chartHtml = areaChart({
    series: values,
    labels: series.map((point) => String(point.date ?? '').slice(5)),
    unit: dim === 'cost' ? '元 / 日' : 'tokens / 日',
    color: dim === 'cost' ? '#c2410c' : undefined,
    height: 200,
  })

  body.innerHTML = `
    <div class="grid-2 mb-20" style="grid-template-columns:2fr 1fr;align-items:stretch">
      <div class="card card-pad">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
          <div id="usage-tabs"></div>
          <span class="tnum mono fs-12 text-3">
            ${esc(rqI18n.t('{n} 天合计', { n: days }))} <b class="tnum mono" style="color:var(--text-1);font-size:13px">${dim === 'cost' ? fmtCost(total) : fmtNum(total)}</b> ${dim === 'cost' ? esc(rqI18n.t('元')) : 'tokens'}
          </span>
        </div>
        ${series.length ? chartHtml : emptyHint(rqI18n.t('近 {n} 天暂无用量数据——资产开始调用后每日序列自动累积', { n: days }))}
        <div class="fs-11 text-3" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;gap:16px;flex-wrap:wrap">
          <span>口径：零价快照计量（charge 恒 0）+ 内部成本参考</span>
          <span style="margin-left:auto">金额不对外结算，仅用于内部穿透与预算熔断</span>
        </div>
      </div>
      <div class="card card-pad">
        ${sectionHead({ label: 'BY ASSET / TOP', title: 'Top 资产消耗', extra: '按内部成本参考排序 · 近 30 天' })}
        ${hBarList(topAssets.map((asset) => ({
          name: asset.name || asset.key,
          value: yuan(asset.cost),
          hint: rqI18n.t('{n} 次调用', { n: fmtNum(asset.calls) }),
        })), { format: (value) => fmtCost(value) })}
      </div>
    </div>
    <div class="grid-2" style="align-items:start">
      <div class="card card-pad">
        ${sectionHead({ label: 'BY ORG', title: '部门用量分摊', extra: 'tokens 占比与环比 · 口径与审计一致' })}
        ${byOrg.length ? `
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr>
              <th>部门</th><th style="text-align:right">消耗（tokens）</th><th style="width:150px">占比</th><th style="text-align:right">环比</th>
            </tr></thead>
            <tbody>
              ${byOrg.map((row) => `
                <tr>
                  <td><div class="col-strong">${esc(row.org || '（未归口）')}</div></td>
                  <td class="tnum mono fs-12" style="text-align:right">${fmtNum(row.tokens)}</td>
                  <td>${progressBar(Number(row.share) || 0, { width: '84px', label: `${Number(row.share ?? 0).toFixed(1)}%` })}</td>
                  <td class="tnum mono fs-12" style="text-align:right;color:${row.delta >= 0 ? 'var(--ok)' : 'var(--danger)'}">${row.delta == null ? '—' : `${row.delta >= 0 ? '+' : ''}${row.delta}%`}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : emptyHint('暂无部门分摊数据——调用事件按组织归口后自动聚合')}
      </div>
      <div class="card card-pad">
        ${sectionHead({ label: 'EFFICIENCY', title: '应用效率：单位 DAU 成本', extra: '指标 × 成本打通 · 按资产窗口 DAU 派生' })}
        ${unitDau.length ? `
        <div style="display:flex;flex-direction:column;gap:14px">
          ${(() => {
            const max = Math.max(...unitDau.map((u) => yuan(u.costPerDau)), 0.000001)
            return unitDau.map((u) => {
              const perDau = yuan(u.costPerDau)
              const high = perDau > 1
              return `
              <div>
                <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:4px">
                  <span class="fs-13 ellipsis" style="min-width:0">${esc(u.name || u.key)}</span>
                  <span class="tnum mono fs-12" style="${high ? 'color:var(--warn-strong)' : ''}">${fmtCost(perDau)} <span class="text-3" style="font-family:var(--font)">/ DAU</span></span>
                </div>
                <div class="bar" style="width:100%"><span class="bar-fill${high ? ' warn' : ' ok'}" style="width:${((perDau / max) * 100).toFixed(1)}%"></span></div>
                <div class="fs-11 text-4" style="margin-top:3px">${esc(rqI18n.t('窗口 DAU {n}', { n: fmtNum(u.dau) }))}</div>
              </div>`
            }).join('')
          })()}
        </div>
        <p class="fs-11 text-3" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);line-height:1.6">
          单位 DAU 成本高于 ¥1/DAU 的资产以琥珀色标出（低频高消耗场景常见），建议评估长文本路由或缓存编排模板优化。
        </p>` : emptyHint('暂无单位 DAU 成本数据——需应用类资产接入 DAU 指标后派生')}
      </div>
    </div>`

  $('#usage-tabs').appendChild(tabs)
  bindExport({ series, byOrg, topAssets, unitDau, days, dim })
}

/** 前端组 CSV + a[download] 下载（同源 Blob，不开新窗）：四段式（每日序列 / 部门分摊 / Top 资产 / 单位 DAU）。 */
function bindExport(report) {
  $('#usage-csv').onclick = () => {
    if (!report || !report.series?.length) {
      toast(rqI18n.t('暂无可导出的用量数据（报表为空或未加载）'), 'error')
      return
    }
    const cell = (value) => {
      const text = String(value ?? '')
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
    }
    const yuan = (cents) => (Number(cents) || 0) / 100 // 分→元（与页面展示口径一致）
    const lines = []
    lines.push(`用量与成本报表（近 ${report.days} 天，维度：${report.dim === 'cost' ? '成本参考（元）' : 'tokens'}；口径：零价快照 + 内部成本参考）`)
    lines.push('')
    lines.push('日期,tokens,成本参考(元),调用次数')
    for (const point of report.series) {
      lines.push([cell(point.date), point.tokens ?? 0, yuan(point.cost), point.calls ?? 0].join(','))
    }
    lines.push('')
    lines.push('部门,tokens,占比%,环比%')
    for (const row of report.byOrg ?? []) {
      lines.push([cell(row.org), row.tokens ?? 0, row.share ?? 0, row.delta ?? ''].join(','))
    }
    lines.push('')
    lines.push('资产键,资产名,成本参考(元),调用次数,tokens')
    for (const asset of report.topAssets ?? []) {
      lines.push([cell(asset.key), cell(asset.name), yuan(asset.cost), asset.calls ?? 0, asset.tokens ?? 0].join(','))
    }
    lines.push('')
    lines.push('资产键,资产名,单位DAU成本(元),DAU')
    for (const unit of report.unitDau ?? []) {
      lines.push([cell(unit.key), cell(unit.name), yuan(unit.costPerDau), unit.dau ?? 0].join(','))
    }
    const blob = new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `usage-report-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast(rqI18n.t('已生成 CSV（{file} · 自助导出）', { file: `usage-report-${new Date().toISOString().slice(0, 10)}.csv` }))
  }
}
