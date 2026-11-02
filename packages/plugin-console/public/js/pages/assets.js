/**
 * 资产台账（规格 docs/internal/design-adaptation-spec-20261014.md §5.2，布局照设计稿 Assets.tsx）：
 * 六类统一台账（chipRow 过滤 + 搜索 + 一键巡检 + 登记资产 + 行点击详情抽屉）
 * + 「运营报表」tab 保留旧资产运营页全部功能（inventory / report / benefit / retire-reasons）。
 * 数据源：GET /api/fleet/ledger（六类统一 schema，WB 实现）；旧功能继续走 /api/assets/*。
 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import { $, esc, toast, fmtCost, fmtNum } from '../ui.js'
import {
  openAssetDrawer, sectionHead, typeBadge, lifecycleBadge, healthDot, progressBar,
  chipRow, tabRow, emptyHint, TYPE_LABEL,
} from '../components/asset-drawer.js'
import rqI18n from '../i18n.js'

const TYPE_ORDER = ['mcp', 'agent', 'app', 'skill', 'model', 'nas']
const TYPE_ICON = { mcp: 'plug', agent: 'bot', app: 'app', skill: 'sparkles', model: 'zap', nas: 'server' }

/** 金额（分）→ 元展示（报表口径沿用）。 */
const fmtCents = (cents) => fmtCost((Number(cents) || 0) / 100)

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—'
}

export async function renderAssets(content, params, ctx) {
  const tab = params.get('tab') === 'report' ? 'report' : 'ledger'
  content.innerHTML = `
    ${sectionHead({
      label: 'ASSET LEDGER',
      title: '资产台账',
      extra: 'MCP / Agent / 应用 / Skill / 模型路由 / NAS 六类资产一处盘点 · 统一归属、健康、用量与成本穿透',
      actions: `
        ${/* 一键巡检是留痕写操作（POST，演示态被 405 闸门拦截）——演示访客隐藏 */ session.isDemo ? '' : `<button class="btn btn-default" id="ledger-healthcheck">${icon('zap', 14)} 一键巡检</button>`}`,
    })}
    <div id="asset-tabs" class="mb-14"></div>
    <div id="asset-tab-body"></div>`

  // 顶部动作：一键巡检（留痕审计 + toast 结果）。登记不再走独立看板——各资源页自带新建动作。
  const healthBtn = $('#ledger-healthcheck')
  if (healthBtn) healthBtn.onclick = async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    btn.textContent = rqI18n.t('巡检中…')
    try {
      const result = await api.post('/api/assets/healthcheck')
      toast(rqI18n.t('巡检完成：{a} 项资产，异常 {b} 项', { a: result.checked, b: result.abnormal }), result.abnormal > 0 ? 'error' : 'success')
      ctx.rerender()
    } catch (error) {
      toast(rqI18n.t('巡检失败：{msg}', { msg: error.message }), 'error')
      btn.disabled = false
      btn.textContent = rqI18n.t('一键巡检')
    }
  }

  $('#asset-tabs').appendChild(tabRow(
    [
      { key: 'ledger', label: '六类台账' },
      { key: 'report', label: '运营报表' },
    ],
    tab,
    (key) => { location.hash = `#/assets?tab=${key}` },
  ))

  if (tab === 'report') await renderReportTab(content, params)
  else renderLedgerTab(content, params)
}

// ============================ 六类统一台账 ============================

function renderLedgerTab(content, params) {
  const body = $('#asset-tab-body')
  const typeFilter = params.get('type') ?? ''
  const searchSeed = params.get('search') ?? params.get('q') ?? ''
  const state = { type: TYPE_ORDER.includes(typeFilter) ? typeFilter : '', search: searchSeed, items: [] }

  body.innerHTML = `
    <div class="filter-bar" id="ledger-filters" style="margin-bottom:10px">
      <div id="ledger-chips"></div>
      <div class="search-input" style="margin-left:auto">${icon('search')}<input class="input" id="ledger-q" placeholder="搜索名称 / 资源键 / 组织" style="width:220px" value="${esc(searchSeed)}"></div>
    </div>
    <div class="card table-wrap fade-up">
      <table class="tbl">
        <thead>
          <tr>
            <th>资产</th>
            <th>归属 / 负责人</th>
            <th>健康</th>
            <th style="text-align:right">30d 调用</th>
            <th style="text-align:right">30d 消耗</th>
            <th style="text-align:right">成本参考</th>
            <th style="text-align:right" title="近 30 天使用凭证数：Agent 使用资产后主动提报的使用事实（与平台自动计量互补）">使用凭证</th>
            <th>发布</th>
            <th style="text-align:right">趋势</th>
          </tr>
        </thead>
        <tbody id="ledger-body"><tr><td colspan="9" class="text-4 fs-12" style="padding:28px;text-align:center">${icon('activity', 14)} 台账加载中…</td></tr></tbody>
      </table>
    </div>
    <p class="fs-11 text-3" style="margin-top:8px">点击行打开右侧详情抽屉（概览 / 监控 / 权限 / 拓扑 / 审计 / 生命周期）· 列表不跳页</p>`

  const syncUrl = () => {
    const p = new URLSearchParams()
    p.set('tab', 'ledger')
    if (state.type) p.set('type', state.type)
    if (state.search) p.set('search', state.search)
    history.replaceState(null, '', `#/assets?${p.toString()}`)
  }

  const renderChips = () => {
    const holder = $('#ledger-chips')
    holder.innerHTML = ''
    const counts = new Map()
    for (const it of state.items) counts.set(it.type, (counts.get(it.type) ?? 0) + 1)
    holder.appendChild(chipRow(
      [
        { value: '', label: '全部', count: state.items.length },
        ...TYPE_ORDER.map((t) => ({ value: t, label: TYPE_LABEL[t], count: counts.get(t) ?? 0 })),
      ],
      state.type,
      (value) => { state.type = value; syncUrl(); renderRows() },
    ))
  }

  const renderRows = () => {
    const holder = $('#ledger-body')
    const rows = state.items.filter((it) => !state.type || it.type === state.type)
    if (!rows.length) {
      holder.innerHTML = `<tr><td colspan="9">${emptyHint(`${icon('search', 16)} ${esc(rqI18n.t('无匹配资产 — 试试调整筛选或搜索词'))}`)}</td></tr>`
      return
    }
    holder.innerHTML = rows.map((it) => `
      <tr data-id="${esc(it.id)}" style="cursor:pointer" class="fade-up">
        <td>
          <div class="flex" style="gap:10px;align-items:center;min-width:0">
            ${typeBadge(it.type)}
            <div style="min-width:0">
              <div class="fs-13 ellipsis" style="font-weight:500;max-width:280px" title="${esc(it.name)}">${esc(it.name)}</div>
              <div class="fs-11 text-4 mono tnum ellipsis" style="max-width:280px">${esc(it.key)}</div>
            </div>
          </div>
        </td>
        <td>
          <div class="fs-13">${esc(it.org || '—')}</div>
          <div class="fs-11 text-4">${esc(it.owner || '—')}</div>
        </td>
        <td>
          ${healthDot(it.health, { pulse: it.health === 'critical' })}
          ${it.grayPercent !== undefined && it.grayPercent !== null ? `<div style="margin-top:5px">${progressBar(it.grayPercent, { label: rqI18n.t('灰度 {p}%', { p: Math.round(it.grayPercent) }) })}</div>` : ''}
        </td>
        <td class="col-num tnum mono fs-12" style="text-align:right">${num(it.calls30d)}</td>
        <td class="col-num tnum mono fs-12" style="text-align:right">${fmtNum(it.tokens30d)}</td>
        <td class="col-num tnum mono fs-12" style="text-align:right">${fmtCents(it.cost30d)}</td>
        <td class="col-num tnum mono fs-12" style="text-align:right" title="近 30 天使用凭证（Agent 提报的使用事实）">${num(it.usageReports30d ?? 0)}</td>
        <td>${lifecycleBadge(it.lifecycle)}</td>
        <td style="text-align:right">${Array.isArray(it.trend) && it.trend.length ? trendSmall(it.trend) : '<span class="fs-11 text-4">暂无</span>'}</td>
      </tr>`).join('')
    holder.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.onclick = () => {
        const asset = state.items.find((it) => String(it.id) === tr.dataset.id)
        if (asset) openAssetDrawer(asset)
      }
    })
  }

  const load = async () => {
    const holder = $('#ledger-body')
    if (!holder) return
    holder.innerHTML = '<tr><td colspan="9" class="text-4 fs-12" style="padding:28px;text-align:center">台账加载中…</td></tr>'
    try {
      const data = await api.get('/api/fleet/ledger' + api.qs({ search: state.search || undefined }))
      state.items = data.items ?? []
      renderChips()
      renderRows()
    } catch (error) {
      holder.innerHTML = `<tr><td colspan="9">${emptyHint(`${icon('alert', 16)} ${esc(rqI18n.t('台账数据加载失败（{msg}）', { msg: error.message }))}<br><button class="btn btn-default btn-sm" id="ledger-retry" style="margin-top:10px">${esc(rqI18n.t('重试'))}</button>`)}</td></tr>`
      const retry = $('#ledger-retry')
      if (retry) retry.onclick = () => void load()
    }
  }

  // 搜索：防抖 300ms 后带 ?search= 重查（服务端口径过滤名称/资源键/组织）
  let debounce
  $('#ledger-q').oninput = () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      state.search = $('#ledger-q').value.trim()
      syncUrl()
      void load()
    }, 300)
  }
  void load()
}

/** 行内 14 日趋势迷你折线（宽 110 高 28，样式随语义 token）。 */
function trendSmall(values) {
  const w = 110
  const h = 28
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const points = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${h - 3 - ((v - min) / span) * (h - 7)}`)
  return `
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" style="display:inline-block;vertical-align:middle" aria-hidden="true">
      <polyline points="${points.join(' ')}" fill="none" stroke="var(--brand-500)" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <polyline points="0,${h} ${points.join(' ')} ${w},${h}" fill="var(--brand-500)" opacity="0.08" stroke="none"/>
    </svg>`
}

// ============================ 运营报表（旧资产运营页功能保留） ============================

async function renderReportTab(content, params) {
  const days = params.get('days') ?? 30
  const typeFilter = params.get('type') ?? ''
  const body = $('#asset-tab-body')
  body.innerHTML = `<div class="text-4 fs-12" style="padding:24px;text-align:center">报表加载中…</div>`
  const [inv, report, benefit, retire] = await Promise.all([
    api.get(`/api/assets/inventory?days=${days}${typeFilter ? `&type=${typeFilter}` : ''}`),
    api.get(`/api/assets/report?days=${days}`),
    api.get(`/api/assets/benefit?days=${days}`),
    api.get('/api/assets/retire-reasons?days=90'),
  ])

  body.innerHTML = `
    <div class="flex mb-14" style="gap:10px;align-items:center">
      <span class="fs-12 text-3">统计窗口</span>
      <select id="asset-days" class="select" style="width:auto">
        ${[7, 14, 30, 90].map((d) => `<option value="${d}" ${String(d) === String(days) ? 'selected' : ''}>${esc(rqI18n.t('近 {n} 天', { n: d }))}</option>`).join('')}
      </select>
      <span class="fs-11 text-4">口径：内部成本为零价快照，不对外结算</span>
    </div>

    <div class="stat-grid mb-20">
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--brand-50);color:var(--brand-500)">${icon('layers', 18)}</div>
        <div class="stat-value">${inv.items.length}</div>
        <div class="stat-sub">纳管资产</div>
        <div class="stat-foot">${Object.entries(inv.summary.byType).map(([t, v]) => rqI18n.t('{label} {n}', { label: rqI18n.t(TYPE_LABEL[t] ?? String(t)), n: v.total })).join(' · ')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--ok-bg);color:#047857">${icon('activity', 18)}</div>
        <div class="stat-value">${Object.values(inv.summary.byType).reduce((s, v) => s + v.inService, 0)}</div>
        <div class="stat-sub">在服务资产</div>
        <div class="stat-foot">已上线 / 灰度中 / 已上架</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:${inv.summary.unhealthy > 0 ? 'var(--danger-bg)' : 'var(--ok-bg)'};color:${inv.summary.unhealthy > 0 ? '#b91c1c' : '#047857'}">${icon(inv.summary.unhealthy > 0 ? 'alert' : 'shieldCheck', 18)}</div>
        <div class="stat-value" style="color:${inv.summary.unhealthy > 0 ? 'var(--danger)' : 'inherit'}">${inv.summary.unhealthy}</div>
        <div class="stat-sub">健康异常</div>
        <div class="stat-foot">不可用 / 降级</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--purple-bg);color:#6d28d9">${icon('coins', 18)}</div>
        <div class="stat-value">${fmtCents(inv.summary.costCents30d)}</div>
        <div class="stat-sub">${esc(rqI18n.t('{n} 天内部成本参考', { n: days }))}</div>
        <div class="stat-foot">零价快照 · 成本仅内部口径</div>
      </div>
    </div>

    <div class="grid-2 mb-20" style="grid-template-columns:1.1fr 1fr;align-items:start">
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('zap', 15)} 消耗 Top 资产</span><span class="card-sub">${esc(rqI18n.t('近 {n} 天 · 计量口径', { n: days }))}</span></div>
        <div class="card-body" style="padding-top:8px">
          ${report.topResources.slice(0, 8).map((row, i) => `
            <div class="flex" style="padding:9px 0;border-bottom:1px solid var(--border);gap:10px;align-items:center">
              <span class="rank ${i < 3 ? 'rank-top' : ''}">${i + 1}</span>
              <span class="fs-13 ellipsis" style="max-width:40%">${esc(row.label)}</span>
              <span class="fs-11 text-4 mono grow ellipsis">${esc(row.resource)}</span>
              <span class="fs-12 col-num" style="font-weight:600">${fmtCents(row.cost_cents)}</span>
              <span class="fs-11 text-4 col-num" style="min-width:56px;text-align:right">${esc(rqI18n.t('{n} 次', { n: row.count }))}</span>
            </div>`).join('') || '<span class="text-4 fs-12">暂无计量数据</span>'}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('trending', 15)} 日消耗趋势</span><span class="card-sub">全资产合计</span></div>
        <div class="card-body">${reportTrendSvg(report.byDay)}</div>
      </div>
    </div>

    <div class="grid-2 mb-20" style="grid-template-columns:1.35fr 1fr;align-items:start">
      <div class="card">
        <div class="card-head">
          <span class="card-title">${icon('coins', 15)} 成本穿透</span>
          <span class="card-sub">${esc(rqI18n.t('内部采购成本参考（零价快照，不对外结算）· 近 {n} 天', { n: days }))}</span>
        </div>
        <div class="card-body" style="padding:10px 8px 14px">
          <div class="flex mb-10" style="gap:18px;padding:0 6px">
            <span class="fs-12 text-4">调用 <b class="fs-14" style="color:var(--text-1)">${benefit.totals.count}</b> 次</span>
            <span class="fs-12 text-4">内部成本 <b class="fs-14" style="color:var(--text-1)">${fmtCents(benefit.totals.cost_cents)}</b></span>
          </div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>资产</th><th style="text-align:right">调用</th><th style="text-align:right">次数占比</th><th style="text-align:right">内部成本</th><th style="text-align:right">单位 DAU 成本</th></tr></thead>
              <tbody>
                ${benefit.rows.length ? benefit.rows.slice(0, 10).map((row) => `
                  <tr>
                    <td><div class="col-strong">${esc(row.label)}</div><div class="col-sub mono">${esc(row.resource)}</div></td>
                    <td class="col-num fs-12" style="text-align:right">${row.count}</td>
                    <td class="col-num fs-12" style="text-align:right">${benefit.totals.count > 0 ? `${((row.count / benefit.totals.count) * 100).toFixed(1)}%` : '—'}</td>
                    <td class="col-num fs-12" style="text-align:right;font-weight:600">${fmtCents(row.cost_cents)}</td>
                    <td class="col-num fs-12" style="text-align:right">${row.cost_per_dau_cents !== null && row.cost_per_dau_cents !== undefined ? fmtCents(row.cost_per_dau_cents) : '—'}</td>
                  </tr>`).join('') : `
                  <tr><td colspan="5"><div class="tbl-empty">${icon('coins', 28)}<span>窗口内暂无计量事件（成本随调用累积）</span></div></td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="card">
          <div class="card-head"><span class="card-title">${icon('users', 15)} 主体分摊（谁在用）</span><span class="card-sub">${esc(rqI18n.t('近 {n} 天', { n: days }))}</span></div>
          <div class="card-body" style="padding-top:8px">
            ${report.byPrincipal.slice(0, 6).map((row) => {
              const max = Math.max(...report.byPrincipal.map((r) => r.cost_cents), 1)
              return `
                <div style="padding:7px 0">
                  <div class="flex fs-12" style="margin-bottom:3px"><span class="ellipsis" style="max-width:60%">${esc(row.label)}</span><span style="margin-left:auto;font-weight:600">${fmtCents(row.cost_cents)}</span></div>
                  <div style="height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden">
                    <div style="height:100%;width:${Math.max((row.cost_cents / max) * 100, 2)}%;border-radius:3px;background:var(--brand-gradient, linear-gradient(90deg,var(--brand-600),var(--brand-400)))"></div>
                  </div>
                </div>`
            }).join('') || '<span class="text-4 fs-12">暂无计量数据</span>'}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">${icon('alert', 15)} 下架分析</span><span class="card-sub">近 90 天 · 原因聚合</span></div>
          <div class="card-body" style="padding-top:8px">
            ${retire.reasons?.length ? retire.reasons.slice(0, 5).map((row) => `
              <div class="flex" style="padding:7px 0;border-bottom:1px solid var(--border);gap:8px;align-items:flex-start">
                <span class="badge badge-muted no-dot" style="flex-shrink:0">${esc(rqI18n.t('{n} 次', { n: row.count }))}</span>
                <span class="grow">
                  <span class="fs-12" style="display:block">${esc(row.reason)}</span>
                  <span class="fs-11 text-4">${Object.entries(row.byType).map(([t, n]) => rqI18n.t('{label} {n}', { label: rqI18n.t(TYPE_LABEL[t] ?? String(t)), n })).join(' · ')}${row.samples?.[0] ? rqI18n.t(' · 最近 {name}', { name: row.samples[0].name }) : ''}</span>
                </span>
              </div>`).join('') : '<span class="text-4 fs-12">窗口内无下架/弃用记录</span>'}
          </div>
        </div>
      </div>
    </div>`

  $('#asset-days').onchange = () => {
    const p = new URLSearchParams()
    p.set('tab', 'report')
    p.set('days', $('#asset-days').value)
    location.hash = `#/assets?${p.toString()}`
  }
}

/** 报表：日消耗趋势 SVG（沿用零价快照口径）。 */
function reportTrendSvg(byDay) {
  if (!byDay.length) return '<span class="text-4 fs-12">窗口内无计量数据</span>'
  const max = Math.max(...byDay.map((d) => d.cost_cents), 1)
  const w = 100
  const points = byDay.map((d, i) => `${(i / Math.max(byDay.length - 1, 1)) * w},${28 - (d.cost_cents / max) * 24}`)
  return `
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" style="width:100%;height:64px;display:block">
      <polyline points="${points.join(' ')}" fill="none" stroke="var(--brand-500)" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
      <polyline points="0,30 ${points.join(' ')} 100,30" fill="var(--brand-500)" opacity="0.08" stroke="none"/>
    </svg>
    <div class="flex fs-11 text-4" style="justify-content:space-between;margin-top:2px">
      <span>${esc(byDay[0]?.day ?? '')}</span><span>${esc(rqI18n.t('峰值成本 {v} 元/日', { v: (max / 100).toFixed(2) }))}</span><span>${esc(byDay[byDay.length - 1]?.day ?? '')}</span>
    </div>`
}
