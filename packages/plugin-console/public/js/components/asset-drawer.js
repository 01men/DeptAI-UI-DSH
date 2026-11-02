/**
 * 资产详情抽屉（六类统一 · 规格 docs/internal/design-adaptation-spec-20261014.md §5.2）：
 * openAssetDrawer(asset) —— 台账行点击后弹出的 wide 抽屉，六 tab（概览/监控/权限/拓扑/审计/生命周期）。
 * 权限/拓扑按 asset.type 复用各域既有详情端点（agents/apps/mcp/nas/skills/modelgw），403/404 时空态。
 *
 * 另含 WD 设计组件兼容层：ui.js §3 契约函数（WA 并行落地中）已存在则直接透传，
 * 未落地时回退到本地等价实现（类名/签名与契约一致，样式由 base.css §2 组件类承载），
 * WA 合入后本地回退自动让位，页面组零改动。
 */
import { api } from '../api.js'
import { icon } from '../icons.js'
import { h, esc, toast, openDrawer, fmtCost, fmtNum, timeAgo, sparkline } from '../ui.js'
import * as uiKit from '../ui.js'
import { renderTopologyList } from '../pages/agents.js'
import rqI18n from '../i18n.js'

// ============ 设计组件兼容层（签名与 ui.js §3 契约一致） ============

export const TYPE_LABEL = { mcp: 'MCP 服务', agent: 'Agent', app: 'AI 应用', skill: 'Skill', model: '模型路由', nas: 'NAS 存储' }
const HEALTH_CN = { healthy: '健康', warning: '关注', critical: '熔断', offline: '离线' }
const HEALTH_CLS = { healthy: 'dot-ok', warning: 'dot-warn', critical: 'dot-crit', offline: 'dot-off' }
const LIFECYCLE_CN = { draft: '草稿', online: '已上线', offline: '已下线', archived: '已归档', deprecated: '已弃用' }

function sectionHeadFallback({ label, title, extra, actions } = {}) {
  return `
    <div class="page-head">
      <div>
        ${label ? `<div class="micro-label">${esc(label)}</div>` : ''}
        <div class="page-title">${esc(title)}</div>
        ${extra ? `<div class="page-sub">${esc(extra)}</div>` : ''}
      </div>
      ${actions ? `<div class="page-actions">${actions}</div>` : ''}
    </div>`
}

function statCardFallback({ label, value, sub, tone = '' } = {}) {
  return `
    <div class="stat-card">
      <div class="micro-label">${esc(label)}</div>
      <div class="stat-value${tone ? ' ' + tone : ''}">${value}</div>
      ${sub !== undefined && sub !== '' ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
    </div>`
}

function healthDotFallback(health, { pulse = false } = {}) {
  const cls = HEALTH_CLS[health] ?? 'dot-off'
  return `<span class="flex" style="gap:6px;align-items:center;white-space:nowrap"><span class="dot ${cls}${pulse && health === 'critical' ? ' pulse' : ''}"></span><span class="fs-12 text-3">${esc(HEALTH_CN[health] ?? '未知')}</span></span>`
}

function lifecycleBadgeFallback(s) {
  const cn = LIFECYCLE_CN[s]
  return `<span class="pill${cn ? ` pill-${s}` : ''}">${esc(cn ?? s ?? '未知')}</span>`
}

function typeBadgeFallback(type) {
  const cn = TYPE_LABEL[type]
  return `<span class="tbadge${cn ? ` tbadge-${type}` : ''}">${esc(cn ?? type)}</span>`
}

function progressBarFallback(percent, { tone = '', width = '80px', label = '' } = {}) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
  return `<span class="flex" style="gap:8px;align-items:center;white-space:nowrap">
    <span class="bar" style="width:${esc(width)}"><span class="bar-fill${tone ? ` ${tone}` : ''}" style="width:${pct}%"></span></span>
    ${label ? `<span class="fs-11 text-3 tnum">${esc(label)}</span>` : ''}
  </span>`
}

function heatStripFallback(values, { big = false } = {}) {
  const list = Array.isArray(values) ? values : []
  const max = Math.max(...list, 1)
  const cells = list.map((v, i) => {
    const n = Number(v) || 0
    const bg = n === 0 ? 'var(--surface-2)' : `hsl(201 88% ${Math.round(68 - (n / max) * 40)}%)`
    return `<span class="heat-cell" style="background:${bg}" title="${esc(rqI18n.t('第 {i} 天 · {n} 次', { i: i + 1, n }))}"></span>`
  }).join('')
  return cells ? `<span class="heat-strip${big ? ' big' : ''}">${cells}</span>` : '<span class="fs-12 text-4">窗口内暂无使用记录</span>'
}

function chipRowFallback(options, activeValue, onPick) {
  const el = h('<div class="chips"></div>')
  for (const opt of options ?? []) {
    const chip = h(`<button type="button" class="chip${opt.value === activeValue ? ' active' : ''}"></button>`)
    chip.innerHTML = `${esc(opt.label ?? opt.value ?? '')}${opt.count !== undefined && opt.count !== null ? `<span class="tnum" style="margin-left:6px;font-size:10.5px;opacity:.65">${Number(opt.count)}</span>` : ''}`
    chip.onclick = () => {
      el.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip))
      onPick?.(opt.value)
    }
    el.appendChild(chip)
  }
  return el
}

function tabRowFallback(options, activeKey, onPick) {
  const el = h('<div class="tabbar"></div>')
  for (const opt of options ?? []) {
    const tab = h(`<button type="button" class="tab${opt.key === activeKey ? ' active' : ''}"></button>`)
    tab.innerHTML = `${esc(opt.label ?? opt.key ?? '')}${opt.badge !== undefined && opt.badge !== null ? `<span class="tab-badge${opt.badgeTone === 'warn' ? ' warn' : ''}">${Number(opt.badge)}</span>` : ''}`
    tab.onclick = () => {
      el.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab))
      onPick?.(opt.key)
    }
    el.appendChild(tab)
  }
  return el
}

function emptyHintFallback(text) {
  return `<div class="empty-hint">${text}</div>`
}

export const sectionHead = uiKit.sectionHead ?? sectionHeadFallback
export const statCard = uiKit.statCard ?? statCardFallback
export const healthDot = uiKit.healthDot ?? healthDotFallback
export const lifecycleBadge = uiKit.lifecycleBadge ?? lifecycleBadgeFallback
export const typeBadge = uiKit.typeBadge ?? typeBadgeFallback
export const progressBar = uiKit.progressBar ?? progressBarFallback
export const heatStrip = uiKit.heatStrip ?? heatStripFallback
export const chipRow = uiKit.chipRow ?? chipRowFallback
export const tabRow = uiKit.tabRow ?? tabRowFallback
export const emptyHint = uiKit.emptyHint ?? emptyHintFallback

// ============ 资产详情抽屉 ============

/** 各域资源页地址（生命周期动作与深度管理跳转用；focus 参数各域页均已支持自动开详情）。 */
function domainPath(asset) {
  switch (asset.type) {
    case 'agent': return `#/agents?focus=${encodeURIComponent(asset.id)}`
    case 'app': return `#/apps?focus=${encodeURIComponent(asset.id)}`
    case 'mcp': return `#/mcp?focus=${encodeURIComponent(asset.id)}`
    case 'nas': return `#/nas?focus=${encodeURIComponent(asset.id)}`
    case 'skill': return `#/skills?focus=${encodeURIComponent(asset.id)}`
    default: return '#/gateway'
  }
}

/** 按类型拉取各域既有详情 API；未命中返回 null，调用方渲染空态。 */
async function fetchDomainDetail(asset) {
  switch (asset.type) {
    case 'agent': return api.get(`/api/agents/${encodeURIComponent(asset.id)}`)
    case 'app': return api.get(`/api/apps/${encodeURIComponent(asset.id)}`)
    case 'nas': return api.get(`/api/nas/${encodeURIComponent(asset.id)}`)
    case 'skill': return api.get(`/api/skills/${encodeURIComponent(asset.id)}`)
    case 'mcp': {
      const data = await api.get('/api/mcp/services')
      return (data.services ?? []).find((s) => s.id === asset.id) ?? null
    }
    case 'model': {
      const data = await api.get('/api/modelgw/models')
      return (data.models ?? []).find((m) => m.id === asset.id || m.slug === asset.key || m.slug === asset.id) ?? null
    }
    default: return null
  }
}

/** 审计资源类型映射（changeLog 各域 resourceType 口径）。 */
const AUDIT_RESOURCE_TYPE = { agent: 'agent', app: 'app', skill: 'skill', mcp: 'mcp_service', nas: 'nas', model: 'model' }

/** 该资产相关审计事件：先按 资源类型+资源ID 精确查，无结果再按资源键全文回查。 */
async function fetchAssetAudit(asset) {
  const resourceType = AUDIT_RESOURCE_TYPE[asset.type]
  if (resourceType) {
    const exact = await api.get('/api/audit/logs' + api.qs({ resourceType, resourceId: asset.id, limit: 8 })).catch(() => null)
    if (exact?.items?.length) return exact.items
  }
  const fuzzy = await api.get('/api/audit/logs' + api.qs({ q: asset.key, limit: 8 })).catch(() => null)
  return fuzzy?.items ?? []
}

/** 单资产健康探活：MCP/NAS 有独立探活端点，其余类型走台账批量巡检并提示汇总。 */
async function probeAssetHealth(asset) {
  if (asset.type === 'mcp') {
    const result = await api.post(`/api/mcp/services/${encodeURIComponent(asset.id)}/health`)
    toast(rqI18n.t('探测完成：{status}（{ms}ms）', { status: result.status, ms: result.latencyMs }), result.status === 'down' ? 'error' : 'success')
    return
  }
  if (asset.type === 'nas') {
    const result = await api.post(`/api/nas/${encodeURIComponent(asset.id)}/health`)
    toast(rqI18n.t('探测完成：{status}（{ms}ms）', { status: result.status, ms: result.latencyMs }), result.status === 'down' ? 'error' : 'success')
    return
  }
  const result = await api.post('/api/assets/healthcheck')
  toast(rqI18n.t('巡检完成：{a} 项资产，异常 {b} 项', { a: result.checked, b: result.abnormal }), result.abnormal > 0 ? 'error' : 'success')
}

const AUTONOMY_CN = {
  A0: '仅人工触发',
  A1: '点名直调，人机协同',
  A2: '模板内自主，超模板转人工',
}

function kvRow(k, v) {
  return `<div class="desc-item"><span class="k">${esc(k)}</span><span class="v">${v ?? '<span class="text-4">—</span>'}</span></div>`
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—'
}

/**
 * 打开六类统一资产详情抽屉。
 * @param asset 台账行对象（/api/fleet/ledger schema：id/type/key/name/org/owner/health/lifecycle/…）
 */
export function openAssetDrawer(asset) {
  if (!asset) return
  const drawer = openDrawer({
    titleHtml: esc(asset.name),
    subHtml: `<span class="mono">${esc(asset.key)}</span>`,
    wide: true,
    body: `
      <div class="flex mb-14" style="gap:10px;flex-wrap:wrap;align-items:center">
        ${typeBadge(asset.type)}
        ${lifecycleBadge(asset.lifecycle)}
        ${healthDot(asset.health, { pulse: asset.health === 'critical' })}
        ${asset.grayPercent !== undefined && asset.grayPercent !== null ? progressBar(asset.grayPercent, { label: rqI18n.t('灰度 {p}%', { p: Math.round(asset.grayPercent) }) }) : ''}
      </div>
      <div class="drawer-tabs" id="ad-tabs"></div>
      <div id="ad-tab-body"></div>`,
  })
  const tabBody = drawer.body.querySelector('#ad-tab-body')
  const tabsEl = drawer.body.querySelector('#ad-tabs')

  const renderTab = (tab) => {
    if (tab === 'overview') renderOverview()
    if (tab === 'monitor') renderMonitor()
    if (tab === 'perm') renderPerm()
    if (tab === 'topology') renderTopology()
    if (tab === 'audit') renderAudit()
    if (tab === 'lifecycle') renderLifecycle()
  }

  // —— 概览 ——
  function renderOverview() {
    const autonomy = asset.autonomy
    tabBody.innerHTML = `
      <div class="muted-box mb-14">${esc(asset.desc || '暂无描述（在各域资产页补全治理属性后展示）')}</div>
      <div class="desc-grid">
        ${kvRow('归属组织', esc(asset.org || '—'))}
        ${kvRow('负责人', esc(asset.owner || '—'))}
        ${kvRow('资源键', `<span class="mono">${esc(asset.key)}</span>`)}
        ${asset.version ? kvRow('当前版本', `<span class="mono">${esc(asset.version)}</span>`) : ''}
        ${autonomy ? kvRow('自治级别', `<span class="mono">${esc(autonomy)}</span>（${esc(rqI18n.t(AUTONOMY_CN[autonomy] ?? '未登记口径'))}）`) : ''}
        ${kvRow('近 30 天调用', `<span class="tnum mono">${num(asset.calls30d)}</span>`)}
        ${kvRow('近 30 天消耗', `<span class="tnum mono">${fmtNum(asset.tokens30d)} tokens</span>`)}
        ${kvRow('成本参考', `<span class="tnum mono">${fmtCost((Number(asset.cost30d) || 0) / 100)}</span>（零价快照 · 内部采购成本参考）`)}
        ${asset.dau !== undefined && asset.dau !== null ? kvRow('DAU', `<span class="tnum mono">${num(asset.dau)}</span>`) : ''}
      </div>
      <div class="flex mt-14" style="gap:8px;border-top:1px solid var(--border);padding-top:14px">
        <button class="btn btn-default btn-sm" id="ad-probe">${icon('wifi', 13)} ${esc(rqI18n.t('健康巡检'))}</button>
        <a class="btn btn-ghost btn-sm" href="${domainPath(asset)}">${icon('external', 13)} ${esc(rqI18n.t('前往{type}页管理', { type: rqI18n.t(TYPE_LABEL[asset.type] ?? '资产') }))}</a>
      </div>`
    tabBody.querySelector('#ad-probe').onclick = async (e) => {
      const btn = e.currentTarget
      btn.classList.add('btn-loading')
      try {
        await probeAssetHealth(asset)
      } catch (error) {
        toast(error.message, 'error')
      } finally {
        btn.classList.remove('btn-loading')
      }
    }
  }

  // —— 监控 ——
  function renderMonitor() {
    const trend = Array.isArray(asset.trend) ? asset.trend : []
    tabBody.innerHTML = `
      <div class="grid-cards g3 mb-14">
        ${statCard({ label: '近 30 天调用', value: `<span class="tnum">${num(asset.calls30d)}</span>`, sub: '网关与计量事件聚合' })}
        ${statCard({ label: '近 30 天消耗', value: `<span class="tnum">${fmtNum(asset.tokens30d)}</span>`, sub: 'tokens · 计量口径' })}
        ${statCard({ label: '成本参考', value: `<span class="tnum">${fmtCost((Number(asset.cost30d) || 0) / 100)}</span>`, sub: '零价快照 · 内部口径' })}
      </div>
      ${asset.dau !== undefined && asset.dau !== null ? `<div class="mb-14">${statCard({ label: 'DAU', value: `<span class="tnum">${num(asset.dau)}</span>`, sub: '日活跃用户（资产提报口径）' })}</div>` : ''}
      <div class="micro-label mb-8">近 14 天调用趋势</div>
      ${trend.length ? sparkline(trend, { width: 560, height: 110 }) : emptyHint('暂无计量数据（趋势随调用累积，接入后自动生成）')}`
  }

  // —— 权限（各域详情 API） ——
  async function renderPerm() {
    tabBody.innerHTML = '<div class="text-4 fs-12">加载中…</div>'
    let detail
    try {
      detail = await fetchDomainDetail(asset)
    } catch (error) {
      tabBody.innerHTML = emptyHint(rqI18n.t('暂无权限查看该资产的权限信息（{msg}）', { msg: error.message }))
      return
    }
    if (!detail) {
      tabBody.innerHTML = emptyHint(rqI18n.t('台账中的该{type}在对应域内已不存在或不可见', { type: rqI18n.t(TYPE_LABEL[asset.type] ?? '资产') }))
      return
    }
    let html = ''
    if (asset.type === 'agent') {
      html += `
        <div class="card-title mb-8">机器凭证</div>
        ${detail.credential ? `
          <div class="desc-grid mb-14">
            ${kvRow('Client ID', `<span class="mono">${esc(detail.credential.clientId)}</span>`)}
            ${kvRow('状态', detail.credential.status === 'active' ? '正常' : '已禁用')}
            ${kvRow('活跃令牌', rqI18n.t('{n} 个', { n: detail.credential.activeTokens }))}
          </div>` : '<div class="muted-box mb-14">未颁发机器凭证</div>'}
        <div class="card-title mb-8">绑定用户（使用即授权留痕）</div>
        <div class="mb-14">
          ${(detail.boundUsers ?? []).length ? detail.boundUsers.map((b) => `
            <div class="flex fs-13" style="padding:7px 0;border-bottom:1px solid var(--border);gap:8px;align-items:center">
              <span class="avatar sm">${esc(String(b.userName).slice(0, 1))}</span>
              <span class="grow">${esc(b.userName)}</span>
              <span class="fs-11 text-4">${esc(rqI18n.t('{time} 绑定', { time: timeAgo(b.boundAt) }))}</span>
            </div>`).join('') : '<span class="text-4 fs-12">暂无绑定用户</span>'}
        </div>`
    } else if (asset.type === 'app') {
      html += `
        <div class="desc-grid mb-14">
          ${kvRow('开发者', esc(detail.attrs?.developerName || '—'))}
          ${kvRow('访问地址', detail.attrs?.url ? `<span class="mono">${esc(detail.attrs.url)}</span>` : '未登记')}
          ${kvRow('投放渠道', (detail.attrs?.channels ?? []).length ? detail.attrs.channels.map((c) => `<span class="badge badge-muted no-dot">${esc(c)}</span>`).join(' ') : '—')}
          ${kvRow('SSO 接入', detail.sso ? (detail.sso.status === 'active' ? '已启用' : '已配置（未激活）') : '未配置')}
        </div>`
    } else if (asset.type === 'mcp') {
      html += `
        <div class="desc-grid mb-14">
          ${kvRow('接入方式', detail.mode === 'external' ? '外部注册' : '平台托管')}
          ${kvRow('传输协议', `<span class="mono">${esc(String(detail.transport ?? 'stdio').toUpperCase())}</span>`)}
          ${kvRow('熔断状态', detail.health?.breakerOpen ? '熔断开启（调用被拒绝）' : '熔断关闭')}
        </div>
        <div class="card-title mb-8">授权主体（MCP 权限组反查）</div>
        <div id="ad-mcp-grants" class="mb-8"><span class="text-4 fs-12">加载中…</span></div>`
    } else if (asset.type === 'nas') {
      html += `
        <div class="desc-grid mb-14">
          ${kvRow('文件网关', detail.attrs?.gatewayUrl ? `<span class="mono">${esc(detail.attrs.gatewayUrl)}</span>` : '未配置')}
          ${kvRow('密级', esc(detail.attrs?.dataClass || '—'))}
          ${kvRow('容量', esc(detail.attrs?.capacity || '—'))}
          ${kvRow('标签', (detail.attrs?.tags ?? []).length ? detail.attrs.tags.map((t) => `<span class="badge badge-muted no-dot">${esc(t)}</span>`).join(' ') : '—')}
        </div>`
    } else if (asset.type === 'skill') {
      html += `
        <div class="desc-grid mb-14">
          ${kvRow('可见性', detail.visibility === 'orgs' ? rqI18n.t('指定组织（{n} 个）', { n: (detail.targetOrgs ?? []).length }) : '全员可见')}
          ${detail.visibility === 'orgs' && (detail.targetOrgs ?? []).length ? kvRow('目标组织', detail.targetOrgs.map((o) => `<span class="mono fs-12">${esc(o)}</span>`).join(' ')) : ''}
          ${kvRow('适用模型', (detail.applicableModels ?? []).length ? detail.applicableModels.map(esc).join('、') : '不限')}
          ${kvRow('前置依赖', (detail.deps ?? []).length ? detail.deps.map((d) => `<span class="mono fs-12">${esc(d)}</span>`).join(' ') : '无')}
        </div>`
    } else if (asset.type === 'model') {
      html += `
        <div class="desc-grid mb-14">
          ${kvRow('供应商', esc(detail.provider ?? '—'))}
          ${kvRow('路由状态', detail.status === 'online' ? '在线' : '下线')}
          ${kvRow('分级上限', esc(detail.dataClassLimit ?? 'internal'))}
          ${kvRow('内部单价', detail.costCentsPerKTokens !== undefined ? `${fmtCost(detail.costCentsPerKTokens)} / K tokens` : '—')}
        </div>`
    }
    tabBody.innerHTML = html || emptyHint('该资产类型暂无权限视图')

    if (asset.type === 'mcp') {
      // MCP 授权主体：权限组反查（复用 agents.js 同源数据口径）
      void (async () => {
        const holder = tabBody.querySelector('#ad-mcp-grants')
        try {
          const [pgData, svcData] = await Promise.all([
            api.get('/api/mcp/perm-groups').catch(() => ({ groups: [] })),
            api.get('/api/mcp/services').catch(() => ({ services: [] })),
          ])
          const svcName = new Map((svcData.services ?? []).map((s) => [s.id, s.name]))
          const granted = (pgData.groups ?? []).filter((g) => Object.keys(g.policies ?? {}).includes(asset.id))
          holder.innerHTML = granted.length ? granted.map((g) => `
            <div class="card card-pad mb-8">
              <div class="flex"><b class="fs-13">${esc(g.name)}</b><span class="fs-12 text-4" style="margin-left:auto">${esc(g.description ?? '')}</span></div>
              <div class="flex fs-12" style="padding:6px 0">
                <span class="mono">${esc(svcName.get(asset.id) ?? asset.key)}</span>
                <span class="badge badge-muted no-dot" style="margin-left:auto">${g.policies[asset.id]?.allowedTools === '*' ? rqI18n.t('全部工具') : rqI18n.t('{n} 个工具', { n: (g.policies[asset.id]?.allowedTools ?? []).length })}</span>
                ${g.policies[asset.id]?.constraints?.readOnly ? '<span class="badge badge-info no-dot">只读</span>' : ''}
              </div>
              <div class="fs-11 text-4">${esc(rqI18n.t('绑定主体 {n} 个（Agent / 应用，网关强制校验）', { n: (g.subjects ?? []).length }))}</div>
            </div>`).join('') : '<span class="text-4 fs-12">尚无权限组授予该服务——网关将拒绝全部调用。</span>'
        } catch {
          holder.innerHTML = '<span class="text-4 fs-12">权限组信息加载失败</span>'
        }
      })()
    }
  }

  // —— 拓扑（依赖关系一图穿透） ——
  async function renderTopology() {
    tabBody.innerHTML = '<div class="text-4 fs-12">加载中…</div>'
    let detail
    try {
      detail = await fetchDomainDetail(asset)
    } catch (error) {
      tabBody.innerHTML = emptyHint(rqI18n.t('暂无权限查看该资产的拓扑信息（{msg}）', { msg: error.message }))
      return
    }
    if (!detail) {
      tabBody.innerHTML = emptyHint(rqI18n.t('台账中的该{type}在对应域内已不存在或不可见', { type: rqI18n.t(TYPE_LABEL[asset.type] ?? '资产') }))
      return
    }
    let html = '<div class="micro-label mb-8">编排拓扑 · 依赖一图穿透</div>'
    if ((asset.type === 'agent' || asset.type === 'app') && detail.topology) {
      html += `
        <div class="card card-pad mb-10">${renderTopologyList(detail.topology)}</div>
        ${(detail.impact ?? []).length ? `
          <div class="card card-pad" style="border-color:var(--warn-border);background:var(--warn-bg)">
            <div class="card-title mb-8">${icon('alert', 14)} 影响面（若下线）</div>
            ${detail.impact.map((i) => `<div class="fs-13" style="padding:3px 0">· ${esc(i.name)}${esc(rqI18n.t('（{type}）', { type: rqI18n.t(TYPE_LABEL[i.type] ?? i.type) }))}</div>`).join('')}
          </div>` : ''}`
    } else if (asset.type === 'mcp' && Array.isArray(detail.tools)) {
      html += detail.tools.length ? `
        <div class="fs-12 text-3 mb-8">${esc(rqI18n.t('该服务暴露 {n} 个工具（Agent / 应用经权限组调用）', { n: detail.tools.length }))}</div>
        ${detail.tools.map((tool) => `
          <div class="flex fs-13" style="padding:7px 0;border-bottom:1px solid var(--border);gap:8px;align-items:center">
            <span class="mono" style="font-weight:600">${esc(tool.name)}</span>
            <span class="fs-12 text-3 grow ellipsis">${esc(tool.description ?? '')}</span>
          </div>`).join('')}` : emptyHint('该服务尚未发现工具（上线后自动发现）')
    } else if (asset.type === 'nas') {
      const tools = detail.gatewayTools ?? []
      html += tools.length ? `
        <div class="fs-12 text-3 mb-8">${esc(rqI18n.t('文件网关暴露 {n} 个工具（文件操作全程审计留痕）', { n: tools.length }))}</div>
        ${tools.map((tool) => `
          <div class="flex fs-13" style="padding:7px 0;border-bottom:1px solid var(--border);gap:8px;align-items:center">
            <span class="mono" style="font-weight:600">${esc(tool.name)}</span>
            <span class="fs-12 text-3 grow ellipsis">${esc(tool.description ?? '')}</span>
          </div>`).join('')}` : emptyHint('尚未发现网关工具（上线后自动发现）')
    } else if (asset.type === 'skill') {
      const deps = detail.deps ?? []
      html += deps.length ? `
        <div class="fs-12 text-3 mb-8">安装该 Skill 时建议一并安装的前置依赖</div>
        ${deps.map((d) => `<div class="flex fs-13" style="padding:7px 0;border-bottom:1px solid var(--border);gap:8px"><span class="mono">${esc(d)}</span></div>`).join('')}` : emptyHint('该 Skill 无前置依赖')
    } else if (asset.type === 'model') {
      html += '<div id="ad-model-chains"><span class="text-4 fs-12">加载中…</span></div>'
    } else {
      html += emptyHint('该资产类型暂无拓扑视图')
    }
    tabBody.innerHTML = html

    if (asset.type === 'model') {
      void (async () => {
        const holder = tabBody.querySelector('#ad-model-chains')
        try {
          const data = await api.get('/api/modelgw/channel-groups')
          const slug = detail.slug ?? asset.key
          const groups = (data.groups ?? []).filter((g) => (g.chain ?? []).includes(slug))
          holder.innerHTML = groups.length ? `
            <div class="fs-12 text-3 mb-8">${esc(rqI18n.t('引用该模型的渠道路由（主用 / 降级链）'))}</div>
            ${groups.map((g) => `
              <div class="card card-pad mb-8">
                <div class="flex"><b class="fs-13">${esc(g.name)}</b><span class="badge ${g.enabled ? 'badge-ok' : 'badge-muted'} no-dot" style="margin-left:auto">${g.enabled ? '启用' : '停用'}</span></div>
                <div class="fs-12 text-3 mt-8">${esc(rqI18n.t('链路：'))}<span class="mono">${(g.chain ?? []).map(esc).join(' → ')}</span></div>
              </div>`).join('')}` : emptyHint('暂无渠道路由引用该模型')
        } catch (error) {
          holder.innerHTML = emptyHint(rqI18n.t('渠道路由信息不可见（{msg}）', { msg: error.message }))
        }
      })()
    }
  }

  // —— 审计 ——
  async function renderAudit() {
    tabBody.innerHTML = '<div class="text-4 fs-12">加载中…</div>'
    const logs = await fetchAssetAudit(asset)
    if (!logs.length) {
      tabBody.innerHTML = emptyHint('窗口内与该资产相关的审计事件为 0（读操作不计入，噪音控制）')
      return
    }
    tabBody.innerHTML = logs.map((l) => `
      <div class="card card-pad mb-8">
        <div class="flex" style="gap:8px;align-items:center">
          <span class="mono fs-12" style="font-weight:600">${esc(l.action)}</span>
          <span class="badge ${l.result === 'ok' ? 'badge-ok' : l.result === 'denied' ? 'badge-danger' : 'badge-warn'} no-dot" style="margin-left:auto">${esc(String(l.result ?? '').toUpperCase())}</span>
        </div>
        <div class="fs-12 text-3" style="margin-top:6px">${esc(l.actorName || '系统')} · ${esc(l.resourceName || l.resourceType || '')}</div>
        ${l.detail ? `<div class="fs-11 text-4" style="margin-top:4px">${esc(String(l.detail).slice(0, 120))}</div>` : ''}
        <div class="fs-11 text-4 tnum" style="margin-top:4px">${timeAgo(l.createdAt)}</div>
      </div>`).join('')
  }

  // —— 生命周期 ——
  async function renderLifecycle() {
    tabBody.innerHTML = '<div class="text-4 fs-12">加载中…</div>'
    let detail = null
    try {
      detail = await fetchDomainDetail(asset)
    } catch { /* 无详情权限时降级为台账口径只读展示 */ }
    const order = ['draft', 'online', 'offline', 'archived']
    const normalized = asset.lifecycle === 'deprecated' ? 'offline' : (order.includes(asset.lifecycle) ? asset.lifecycle : 'draft')
    const currentIdx = order.indexOf(normalized)
    const deprecated = asset.lifecycle === 'deprecated'
    tabBody.innerHTML = `
      <div class="micro-label mb-8">生命周期状态机 · 高危变更强制 L4 审批</div>
      <div class="timeline mb-14">
        ${order.map((s, i) => `
          <div class="tl-item">
            <span class="tl-dot${i < currentIdx ? ' done' : i === currentIdx ? ' current' : ''}"></span>
            <div>
              <div class="fs-13" style="font-weight:${i === currentIdx ? 600 : 400}">${esc(rqI18n.t(LIFECYCLE_CN[s]))}${i === currentIdx ? esc(rqI18n.t('（当前）')) : ''}</div>
              ${i === currentIdx && deprecated ? `<div class="fs-11" style="color:var(--warn)">${esc(rqI18n.t('已标记弃用：存量引用将收到迁移告警'))}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>
      ${detail && (detail.availableTransitions ?? []).length ? `
        <div class="card-title mb-8">${esc(rqI18n.t('可执行动作（需在{type}页执行）', { type: rqI18n.t(TYPE_LABEL[asset.type] ?? '资产') }))}</div>
        <div class="flex mb-14" style="gap:8px;flex-wrap:wrap">
          ${detail.availableTransitions.map((t) => `<span class="badge badge-muted no-dot">${esc(t.label)}</span>`).join('')}
        </div>` : ''}
      <div class="muted-box mb-14" style="display:flex;gap:8px">
        ${icon('info', 15)}<span>${esc(rqI18n.t('上线 / 下线 / 归档等状态变更由各域生命周期端点执行，高危操作强制 L4 审批单（原因必填、全程留痕、执行结果回写）。'))}</span>
      </div>
      <a class="btn btn-default" style="width:100%" href="${domainPath(asset)}">${icon('external', 13)} ${esc(rqI18n.t('前往{type}页执行生命周期动作', { type: rqI18n.t(TYPE_LABEL[asset.type] ?? '资产') }))}</a>`
  }

  tabsEl.appendChild(tabRow(
    [
      { key: 'overview', label: '概览' },
      { key: 'monitor', label: '监控' },
      { key: 'perm', label: '权限' },
      { key: 'topology', label: '拓扑' },
      { key: 'audit', label: '审计' },
      { key: 'lifecycle', label: '生命周期' },
    ],
    'overview',
    (key) => renderTab(key),
  ))
  renderTab('overview')
  return drawer
}
