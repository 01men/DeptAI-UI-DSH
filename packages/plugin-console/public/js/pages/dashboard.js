/** 工作台（CIO 五视图）：cockpit 经营驾驶舱 / goals 目标与价值 / actions 行动项目 / collab 人机协作 / ops 平台运行。
 *  设计适配（docs/internal/design-adaptation-spec-20261014.md §5.1）：tabRow 分段标签 + ?tab= 同步；
 *  全部经营数据来自真实 API（执行中枢 / 总览 / 审批 / 审计 / 用量），失败按链路降级，不造演示数据。
 *  权限语义保留（QA-02）：处理审批（approval.read）/ 查看 Agent（agent.read）/ 用量明细（usage.read）CTA 按权限渲染。 */
import { api, session, bridgeStatus, BASE } from '../api.js'
import { icon } from '../icons.js'
import {
  $, $$, esc, fmtNum, fmtCost, fmtPct, timeAgo, statusBadge,
  tabRow, sectionHead, statCard, progressBar, areaChart, dualTrendChart, hBarList, donutCenter,
  typeBadge, healthDot, lifecycleBadge, emptyHint, chipRow,
} from '../ui.js'
import { errorBarHtml } from '../errors.js'
import rqI18n from '../i18n.js'
import { mountThemeLens } from '../theme-lens.js'
import { mountThemeQuickSwitcher } from '../theme.js'

const TABS = [
  { key: 'cockpit', label: '经营驾驶舱' },
  { key: 'goals', label: '目标与价值' },
  { key: 'actions', label: '行动项目' },
  { key: 'collab', label: '人机协作' },
  { key: 'ops', label: '平台运行' },
]
const TAB_HINTS = {
  cockpit: '先看全局，再下钻目标、行动与人机协作',
  goals: '每项行动，都有一个经营理由',
  actions: '目标 → 行动 → 交付 → 验收',
  collab: '人负责判断，数字员工负责交付',
  ops: '平台资源与治理口径 · 用量透明与内部成本穿透',
}

/** 图表用色（与设计稿资产类型色系对齐的图表字面量，仅用于 SVG 填色）。 */
const CHART_COLORS = ['#0e7490', '#7c3aed', '#2563eb', '#059669', '#d97706', '#e11d48', '#0a5f87', '#f59e0b']

const PROJECT_STATUS = { active: ['badge-info', '进行中'], done: ['badge-ok', '已完成'], archived: ['badge-muted', '已归档'] }
const ISSUE_STATUS_LABEL = { todo: '待办', in_progress: '进行中', review: '待审', done: '完成', cancelled: '已取消' }
const ISSUE_COLS = ['todo', 'in_progress', 'review', 'done', 'cancelled']
const PRIORITY_BADGE = { P0: 'badge-danger', P1: 'badge-warn', P2: 'badge-info', P3: 'badge-muted' }

/** 资产类型中文名（fleet 台账 / 分类速览共用）。 */
const TYPE_LABELS = { mcp: 'MCP 服务', agent: 'Agent 本体', app: 'AI 应用', skill: 'Skill', model: '模型', nas: 'NAS 存储' }

// ================================================================ 页面骨架
export async function renderDashboard(content, params, ctx) {
  const wanted = params.get('tab') ?? 'cockpit'
  const tab = TABS.some((t) => t.key === wanted) ? wanted : 'cockpit'
  content.innerHTML = `<div class="card card-pad text-4" style="text-align:center;padding:60px 0">加载中…</div>`

  let d
  try {
    d = await api.get('/api/overview')
  } catch (error) {
    content.innerHTML = `
      <div class="card card-pad" style="text-align:center;padding:44px 24px">
        <div style="margin-bottom:10px;color:var(--danger)">${icon('alert', 26)}</div>
        <div style="font-weight:600;margin-bottom:6px">工作台数据加载失败</div>
        <div class="fs-12 text-3" style="margin-bottom:18px">${esc(error.message)}</div>
        <button class="btn btn-default" id="dash-retry">重试</button>
      </div>`
    $('#dash-retry').onclick = () => ctx?.rerender?.()
    return
  }

  const hour = new Date().getHours()
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  const firstName = session.user?.displayName ?? ''
  const isManager = session.can('usage.read')

  content.innerHTML = `
    ${sectionHead({
      label: 'WORKBENCH / CIO',
      title: esc(rqI18n.t('{greet}，{name}', { greet: rqI18n.t(greet), name: firstName })),
      extra: `今天有 <b style="color:var(--warn)">${fmtNum(d.approvals?.pending ?? 0)}</b> 个审批待处理、<b style="color:var(--danger)">${fmtNum(d.alerts?.unread ?? 0)}</b> 条未读告警，${d.conflicts > 0 ? `以及 <b style="color:var(--brand-600)">${fmtNum(d.conflicts)}</b> 条三方同步冲突待确认。` : '平台整体运行平稳。'}`,
      actions: `
        ${d.conflicts > 0 && session.can('iam.user.read') ? `<button class="btn btn-default" id="dash-goto-conflicts" style="color:var(--brand-600)">${icon('link', 14)}${esc(rqI18n.t('处理同步冲突（{n}）', { n: fmtNum(d.conflicts) }))}</button>` : ''}
        ${session.can('agent.read') ? `<button class="btn btn-default" id="dash-goto-agents">${icon('bot', 14)}查看 Agent</button>` : ''}
        ${session.can('approval.read') ? `<button class="btn btn-primary" id="dash-goto-approve">${icon('checkSquare', 14)}处理审批</button>` : ''}`,
    })}
    ${tab === 'cockpit' ? '<div id="theme-quick-switcher"></div><div id="theme-lens"></div>' : ''}
    <div id="dash-binding-banner"></div>
    <div class="flex mb-14" style="gap:10px;align-items:center;flex-wrap:wrap">
      <div id="dash-tabs"></div>
      <span class="fs-11 text-3 grow" style="text-align:right">${esc(TAB_HINTS[tab])}</span>
    </div>
    <div id="dash-tab-body" class="fade-up"></div>`

  // 五视图分段标签（ui.js tabRow 契约）：切换即写 ?tab=（hash 变化不丢，可回退/刷新/分享）
  const badge = (d.approvals?.pending ?? 0) > 0 ? rqI18n.t('{n} 待决策', { n: fmtNum(d.approvals.pending) }) : ''
  const tabsEl = tabRow(
    TABS.map((t) => (t.key === 'cockpit' && badge ? { key: t.key, label: t.label, badge, badgeTone: 'warn' } : t)),
    tab,
    (key) => { location.hash = `#/dashboard?tab=${key}` },
  )
  $('#dash-tabs').appendChild(tabsEl)

  $('#dash-goto-agents')?.addEventListener('click', () => { location.hash = '#/agents' })
  $('#dash-goto-approve')?.addEventListener('click', () => { location.hash = '#/approvals' })
  $('#dash-goto-conflicts')?.addEventListener('click', () => { location.hash = '#/iam?tab=conflicts' })

  void mountBindingBanner()
  if (tab === 'cockpit') {
    mountThemeQuickSwitcher($('#theme-quick-switcher'))
    mountThemeLens($('#theme-lens'), d)
  }

  const body = $('#dash-tab-body')
  if (tab === 'goals') await renderGoalsTab(body)
  else if (tab === 'actions') await renderActionsTab(body)
  else if (tab === 'collab') await renderCollabTab(body, d)
  else if (tab === 'ops') await renderOpsTab(body, d, isManager)
  else await renderCockpitTab(body, d)
}

/** A2 绑定自检：dsh 宿主形态下探测绑定态，失效出横幅 + 一键重绑；独立形态静默。 */
async function mountBindingBanner() {
  const host = $('#dash-binding-banner')
  if (!host) return
  const status = await bridgeStatus()
  if (!status || status.bound !== false) return
  host.innerHTML = errorBarHtml('binding-invalid', status.reason)
}

// ================================================================ Tab 1：cockpit 经营驾驶舱
async function renderCockpitTab(body, d) {
  body.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px" class="mb-14 dashboard-insight-grid">
      <div class="card card-pad">
        <div class="flex" style="gap:12px;align-items:flex-start">
          <span class="stat-icon" style="background:var(--brand-50);color:var(--brand-500);flex-shrink:0">${icon('sparkles', 16)}</span>
          <div class="grow" style="min-width:0">
            <div class="micro-label">今日经营洞察</div>
            <p id="dash-insight-text" class="fs-13" style="margin:6px 0 0;line-height:1.7;color:var(--text-1)">洞察生成中…</p>
          </div>
          <button class="btn btn-default btn-sm" id="dash-insight-go" style="flex-shrink:0">查看行动 ${icon('chevronRight', 12)}</button>
        </div>
      </div>
      <div class="card card-pad">
        <div class="flex" style="justify-content:space-between;align-items:center">
          <span class="micro-label">${icon('bell', 12)} 运行与业务影响</span>
          <span class="fs-11 text-3 tnum" id="dash-exc-summary"></span>
        </div>
        <div id="dash-exceptions" style="margin-top:10px"></div>
      </div>
    </div>

    <div class="grid-cards g4 mb-14" id="dash-kpis"></div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px" class="mb-14">
      <div class="card card-pad">
        ${sectionHead({
          label: 'VALUE / TRACKING',
          title: 'AI 价值兑现趋势',
          extra: '从应用投入，追踪到业务结果 · 数据来自执行中枢目标价值口径',
        })}
        <div id="dash-value"></div>
      </div>
      <div class="card card-pad">
        ${sectionHead({
          label: 'DECISION',
          title: '需要您决策',
          actions: session.can('approval.read') ? `<a href="#/approvals" class="btn btn-ghost btn-sm">全部决策 ${icon('chevronRight', 12)}</a>` : '',
        })}
        <div id="dash-decisions"></div>
        <div class="fs-11 text-3" style="margin-top:10px;background:var(--surface-2);border-radius:6px;padding:8px 10px;line-height:1.6">先看业务影响，再决定执行边界 · 全程留痕</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <span class="card-title">${icon('clock', 15)} 最近调用</span>
          <div class="card-head-actions">${isManagerCta()}</div>
        </div>
        <div class="card-body" id="dash-recent"></div>
      </div>
      ${BASE ? `
      <div class="card" id="dash-chat-card">
        <div class="card-head"><span class="card-title">${icon('messageSquare', 15)} 对话入口</span></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="fs-13 text-2">自然语言直达：问数据、跑流程、调资产——每一次调用都有宿主支撑与审计归因。</div>
          <a class="btn btn-primary btn-lg btn-block" id="dash-open-chat-main" href="/" target="_top" rel="noopener">进入 AI 对话工作区</a>
          <div class="fs-11 text-4">单入口免登：从门户/钉钉进入即已登录，无需二次认证。</div>
        </div>
      </div>` : ''}
    </div>`

  $('#dash-insight-go').onclick = () => { location.hash = '#/dashboard?tab=actions' }

  // 洞察 + 异常：优先执行中枢经营口径，失败/无权限降级为总览真实数据派生
  void mountCockpitInsight(d)
  void mountCockpitKpis(d)
  void mountCockpitValue()
  void mountDecisionRows($('#dash-decisions'))
  void mountRecentCalls()
}

/** isManager 派生的用量明细 CTA（QA-02 权限门控模式：用量明细仅 usage.read 持有者可见）。 */
function isManagerCta() {
  const isManager = session.can('usage.read')
  return `${isManager ? `<a href="#/assets" class="fs-12">用量明细 ›</a>` : ''}`
}

/** 洞察文案 + 异常影响行：/api/exec/overview（WB 经营口径）→ /api/overview 派生 → 告警接口补真异常。 */
async function mountCockpitInsight(d) {
  const textEl = $('#dash-insight-text')
  const excEl = $('#dash-exceptions')
  const sumEl = $('#dash-exc-summary')
  let execOv = null
  if (session.can('exec.read')) {
    try { execOv = await api.get('/api/exec/overview') } catch { execOv = null }
  }

  let exceptions = []
  if (execOv?.insight?.text) {
    textEl.textContent = String(execOv.insight.text)
    exceptions = (execOv.insight.exceptions ?? []).slice(0, 3)
  } else {
    textEl.textContent = deriveInsightText(d, execOv)
    exceptions = deriveExceptions(d)
  }

  // 有审计权限时用真实未读告警补足异常行（洞察接口未提供时）
  if (!exceptions.length && session.can('audit.read')) {
    try {
      const alerts = await api.get('/api/audit/alerts?unread=1')
      exceptions = (alerts.alerts ?? []).slice(0, 2).map((alert) => ({
        name: alert.title,
        level: alert.severity === 'critical' ? 'critical' : 'warning',
        chain: alert.message || '审计告警',
        owner: rqI18n.t('告警 · {time}', { time: timeAgo(alert.createdAt) }),
      }))
    } catch { /* 无告警数据时保持空态 */ }
  }

  sumEl.textContent = exceptions.length
    ? rqI18n.t('{n} 项异常需要处置 · {m} 单审批待处理', { n: exceptions.length, m: fmtNum(d.approvals?.pending ?? 0) })
    : rqI18n.t('无运行异常 · {n} 单审批待处理', { n: fmtNum(d.approvals?.pending ?? 0) })
  excEl.innerHTML = exceptions.length ? exceptions.map((e) => `
    <div class="flex" style="gap:10px;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px">
      <span class="dot ${e.level === 'critical' ? 'dot-crit pulse' : 'dot-warn'}" style="flex-shrink:0"></span>
      <div class="grow" style="min-width:0">
        <div class="fs-13" style="font-weight:500" title="${esc(e.name)}">${ellipsis(e.name, 34)}</div>
        <div class="fs-11 text-3 ellipsis">${esc(e.chain ?? '')}${e.owner ? ` · ${esc(e.owner)}` : ''}</div>
      </div>
      <a href="#/audit?tab=alerts" class="fs-11" style="color:var(--brand-600);flex-shrink:0">看影响 ›</a>
    </div>`).join('') : emptyHint('当前没有需要处置的运行异常。')
}

/** KPI 四卡：执行中枢经营 KPI（今日口径）→ 总览派生（累计口径，标签如实标注）。 */
async function mountCockpitKpis(d) {
  const host = $('#dash-kpis')
  let execOv = null
  if (session.can('exec.read')) {
    try { execOv = await api.get('/api/exec/overview') } catch { execOv = null }
  }
  host.innerHTML = buildKpiCards(execOv, d)
}

function buildKpiCards(execOv, d) {
  const k = execOv?.kpis
  if (k) {
    const a = k.assets ?? {}
    const risk = k.risk ?? {}
    const riskCount = Number(risk.critical ?? 0) + Number(risk.warning ?? 0)
    return [
      statCard({ label: '受管资产', value: fmtNum(a.total ?? 0), sub: rqI18n.t('在线 {a} · 草稿 {b} · 弃用 {c}', { a: fmtNum(a.online ?? 0), b: fmtNum(a.draft ?? 0), c: fmtNum(a.deprecated ?? 0) }) }),
      statCard({ label: '今日调用', value: fmtNum(k.callsToday ?? 0), sub: '近 24 小时平台调用次数' }),
      statCard({ label: '今日消耗', value: fmtNum(k.tokensToday ?? 0), sub: k.costToday ? rqI18n.t('成本参考 {v}', { v: fmtCost(k.costToday) }) : 'Token 消耗（今日口径）' }),
      statCard({ label: '风险', value: fmtNum(riskCount), sub: riskCount ? rqI18n.t('熔断/严重 {a} · 关注 {b}', { a: fmtNum(risk.critical ?? 0), b: fmtNum(risk.warning ?? 0) }) : '当前无风险项', tone: riskCount ? (Number(risk.critical ?? 0) > 0 ? 'crit' : 'warn') : '' }),
    ].join('')
  }
  // 降级：总览真实计数（口径如实标注，不冒充今日值）
  const trend = d.costTrend ?? []
  const last = trend.at(-1)
  const riskCount = Number(d.alerts?.critical ?? 0) + Number(d.mcp?.unhealthyServices ?? 0) + Number(d.conflicts ?? 0)
  return [
    statCard({ label: '受管资产（总览口径）', value: fmtNum(managedTotal(d)), sub: rqI18n.t('Agent 在线 {a}/{b} · 应用在线 {c} · Skill 上架 {d}', { a: fmtNum(d.agents?.online ?? 0), b: fmtNum(d.agents?.total ?? 0), c: fmtNum(d.apps?.online ?? 0), d: fmtNum(d.skills?.published ?? 0) }) }),
    statCard({ label: '累计调用', value: fmtNum(d.mcp?.totalCalls ?? 0), sub: rqI18n.t('成功率 {p} · P95 {l}ms', { p: fmtPct(d.mcp?.successRate ?? 1), l: fmtNum(d.mcp?.p95Latency ?? 0) }) }),
    statCard({ label: last ? rqI18n.t('最新一日消耗（{d}）', { d: String(last.key).slice(5) }) : 'Token 消耗', value: fmtNum(last?.llmTokens ?? d.mcp?.tokens ?? 0), sub: last ? rqI18n.t('成本参考 {v}', { v: fmtCost(last.costYuan) }) : 'MCP 调用 Token 累计' }),
    statCard({ label: '风险', value: fmtNum(riskCount), sub: riskCount ? rqI18n.t('严重告警 {a} · MCP 熔断 {b} · 同步冲突 {c}', { a: fmtNum(d.alerts?.critical ?? 0), b: fmtNum(d.mcp?.unhealthyServices ?? 0), c: fmtNum(d.conflicts ?? 0) }) : '当前无风险项', tone: riskCount ? (Number(d.alerts?.critical ?? 0) > 0 ? 'crit' : 'warn') : '' }),
  ].join('')
}

/** 价值兑现双序列：执行中枢目标价值口径（WB 字段）→ 无数据空态（不造假曲线）。 */
async function mountCockpitValue() {
  const host = $('#dash-value')
  let goalsData = null
  if (session.can('exec.read')) {
    try { goalsData = await api.get('/api/exec/goals') } catch { goalsData = null }
  }
  const series = extractValueSeries(goalsData)
  if (!series) {
    host.innerHTML = emptyHint('暂无价值核验数据——在执行中枢为目标与项目登记价值口径并通过核验后，这里将展示「实际 vs 目标」双序列趋势。')
    return
  }
  const lastActual = Number(series.actual.at(-1) ?? 0)
  const lastTarget = Number(series.target.at(-1) ?? 0)
  host.innerHTML = `
    <div class="flex mb-8" style="gap:28px;align-items:baseline">
      <div><div class="fs-11 text-3">期末累计（实际）</div><div class="tnum" style="font-size:20px;font-weight:600">${fmtNum(lastActual)}${series.unit ? ` <span class="fs-12 text-3" style="font-weight:400">${esc(series.unit)}</span>` : ''}</div></div>
      <div><div class="fs-11 text-3">期末目标</div><div class="tnum" style="font-size:20px;font-weight:600">${fmtNum(lastTarget)}${series.unit ? ` <span class="fs-12 text-3" style="font-weight:400">${esc(series.unit)}</span>` : ''}</div></div>
      <div class="fs-11 text-3 grow" style="text-align:right">${esc(rqI18n.t('目标完成度 {v}', { v: lastTarget > 0 ? fmtPct(lastActual / lastTarget) : '—' }))}</div>
    </div>
    ${dualTrendChart({ actual: series.actual, target: series.target, labels: series.labels, unit: series.unit })}`
}

// ================================================================ Tab 2：goals 目标与价值
async function renderGoalsTab(body) {
  body.innerHTML = `<div class="card card-pad text-4" style="text-align:center">加载中…</div>`
  if (!session.can('exec.read')) {
    body.innerHTML = permCard('目标与价值', 'exec.read', '需要「exec.read」权限（执行中枢只读）才能查看目标、项目与价值口径。')
    return
  }
  let goalsData, projectsData
  try {
    ;[goalsData, projectsData] = await Promise.all([api.get('/api/exec/goals'), api.get('/api/exec/projects')])
  } catch (error) {
    body.innerHTML = errorCard('目标数据加载失败', rqI18n.t('{msg}（执行中枢后端可能尚未部署到当前宿主）', { msg: error.message }))
    return
  }
  const goals = goalsData.goals ?? []
  const projects = projectsData.projects ?? []
  const goalById = new Map(goals.map((g) => [g.id, g]))

  body.innerHTML = `
    <div class="card card-pad mb-14 flex" style="justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div>
        <div class="micro-label">GOALS / VALUE</div>
        <div style="font-size:15px;font-weight:600;margin-top:2px">目标与价值</div>
      </div>
      <span class="fs-11 text-3">每项行动，都有一个经营理由 · 目标拆解、指标口径、负责人和关联项目在同一条链路上</span>
    </div>
    ${goals.length ? `
    <div class="grid-cards g3 mb-14">
      ${goals.map((g) => goalCardHtml(g, projects)).join('')}
    </div>` : `<div class="mb-14">${emptyHint('还没有目标——从公司级目标开始逐层拆解（在执行中枢登记）。')}</div>`}
    <div class="card card-pad">
      <div class="micro-label mb-8">VERIFY / RULES</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
        ${[
          { no: '01', title: '统一计量口径', desc: '价值与用量均来自平台统一计量管道：usage 事件幂等入账，统计周期、维度与排除项在报表口径中固定，同一结果不重复计数。' },
          { no: '02', title: '变更先审批', desc: '权限变更、灰度上线、写入类授权等高风险操作一律先经审批中心：先看业务影响面，再决定执行边界，决策全程留痕。' },
          { no: '03', title: '结果可回溯', desc: '每次执行与调用进入审计日志，可从指标下钻到具体项目、任务、Agent 执行链与调用明细，验收证据随交付物归档。' },
        ].map((r) => `
          <div class="flex" style="gap:10px">
            <span class="tnum mono" style="font-size:13px;font-weight:600;color:var(--brand-600);flex-shrink:0">${esc(r.no)}</span>
            <div>
              <div class="fs-13" style="font-weight:500">${esc(r.title)}</div>
              <div class="fs-12 text-3" style="margin-top:2px;line-height:1.6">${esc(r.desc)}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>`

  // 关联行动下钻
  $$('[data-goto-exec]').forEach((el) => { el.onclick = () => { location.hash = '#/exec?tab=goals' } })
}

/** 目标卡：状态徽标 + 指标基线→目标 + 关联项目任务进度 + 负责人。 */
function goalCardHtml(goal, projects) {
  const linked = projects.filter((p) => p.goalId === goal.id)
  const agg = linked.reduce((acc, p) => {
    const prog = p.issueProgress ?? {}
    acc.total += Number(prog.total ?? 0)
    acc.done += Number(prog.done ?? 0)
    return acc
  }, { total: 0, done: 0 })
  const pct = agg.total > 0 ? Math.round((agg.done / agg.total) * 100) : 0
  const metricLine = goal.metric
    ? rqI18n.t('{metric}：{base} → {target}{unit}', {
        metric: goal.metric,
        base: String(goal.metricBaseline ?? '?'),
        target: String(goal.metricTarget ?? '?'),
        unit: goal.metricUnit ?? '',
      })
    : rqI18n.t('未设指标')
  return `
    <div class="card card-pad">
      <div class="flex" style="justify-content:space-between;align-items:center">
        ${statusBadge(goal.status)}
        <span class="fs-11 text-3">${linked.length ? rqI18n.t('关联行动 {n} 项', { n: linked.length }) : rqI18n.t('暂无关联行动')}</span>
      </div>
      <div style="font-weight:600;margin-top:10px" title="${esc(goal.title)}">${ellipsis(goal.title, 40)}</div>
      <div class="fs-11 text-3">${goal.periodStart || goal.periodEnd ? rqI18n.t('期限 {a} ~ {b}', { a: goal.periodStart ?? '?', b: goal.periodEnd ?? '?' }) : rqI18n.t('未设期限')}</div>
      ${goal.metric ? `
      <div class="tnum" style="font-size:24px;font-weight:600;margin-top:10px;line-height:1">${esc(String(goal.metricTarget ?? '—'))}<span class="fs-13 text-3" style="font-weight:500"> ${esc(goal.metricUnit ?? '')}${esc(rqI18n.t('（目标）'))}</span></div>
      <div class="fs-11 text-3" style="margin-top:4px">${metricLine}</div>` : `
      <div class="fs-12 text-3" style="margin-top:10px">${metricLine}${goal.description ? ` · ${ellipsis(goal.description, 30)}` : ''}</div>`}
      <div style="margin-top:12px">${progressBar(pct, { label: rqI18n.t('关联任务达成 {p}%（{d}/{t}）', { p: pct, d: agg.done, t: agg.total }) })}</div>
      <div class="fs-11 text-3" style="margin-top:6px">${esc(rqI18n.t('负责人'))} ${goal.ownerUserId ? `<span class="mono">${esc(goal.ownerUserId)}</span>` : esc(rqI18n.t('未指定'))}</div>
      ${linked.length ? `
      <div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
        ${linked.map((p) => {
          const prog = p.issueProgress ?? {}
          const ppct = (prog.total ?? 0) > 0 ? Math.round(((prog.done ?? 0) / prog.total) * 100) : 0
          return `
          <div class="flex fs-12" data-goto-exec style="justify-content:space-between;cursor:pointer;padding:2px 0">
            <span class="ellipsis" title="${esc(p.name)}">${esc(p.name)}</span>
            <span class="tnum mono text-3">${ppct}% ›</span>
          </div>`
        }).join('')}
      </div>` : ''}
    </div>`
}

// ================================================================ Tab 3：actions 行动项目
async function renderActionsTab(body) {
  body.innerHTML = `<div class="card card-pad text-4" style="text-align:center">加载中…</div>`
  if (!session.can('exec.read')) {
    body.innerHTML = permCard('行动项目', 'exec.read', '需要「exec.read」权限（执行中枢只读）才能查看行动项目与交付任务。')
    return
  }
  let projectsData, issuesData, goalsData
  try {
    ;[projectsData, issuesData, goalsData] = await Promise.all([
      api.get('/api/exec/projects'),
      api.get('/api/exec/issues'),
      api.get('/api/exec/goals'),
    ])
  } catch (error) {
    body.innerHTML = errorCard('行动数据加载失败', rqI18n.t('{msg}（执行中枢后端可能尚未部署到当前宿主）', { msg: error.message }))
    return
  }
  const projects = projectsData.projects ?? []
  const issues = issuesData.issues ?? []
  const goalTitles = new Map((goalsData.goals ?? []).map((g) => [g.id, g.title]))

  body.innerHTML = `
    <div class="card mb-14">
      <div class="card-head" style="flex-wrap:wrap;gap:10px">
        <div>
          <div class="micro-label">ACTIONS</div>
          <span class="card-title" style="margin-top:2px">${icon('layers', 15)} 重点行动推进</span>
        </div>
        <div class="card-head-actions" style="display:flex;gap:10px;align-items:center">
          <span id="actions-filter"></span>
          <a href="#/exec?tab=goals" class="btn btn-default btn-sm">全部项目 ${icon('chevronRight', 12)}</a>
        </div>
      </div>
      <div class="card-body" style="padding-top:4px" id="actions-table"></div>
      <div class="fs-11 text-3" style="padding:10px 16px;border-top:1px solid var(--border)">仅展示承接目标落地的行动项目 · 过程按任务状态推进，核验价值以执行中枢验收口径为准</div>
    </div>

    <div class="card card-pad">
      ${sectionHead({ label: 'DELIVERY / KANBAN', title: '交付任务看板', extra: '点击任务进入执行中枢查看执行记录与验收标准 · 有负责人、有边界、有交付标准' })}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px" id="actions-kanban"></div>
    </div>`

  // 项目状态过滤（chipRow 契约组件，本地重绘）
  let filter = 'all'
  const filterHost = $('#actions-filter')
  const chips = chipRow(
    [
      { value: 'all', label: '全部项目', count: projects.length },
      { value: 'active', label: '进行中', count: projects.filter((p) => p.status === 'active').length },
      { value: 'done', label: '已完成', count: projects.filter((p) => p.status === 'done').length },
      { value: 'archived', label: '已归档', count: projects.filter((p) => p.status === 'archived').length },
    ],
    filter,
    (value) => { filter = value; drawTable() },
  )
  filterHost.appendChild(chips)

  function drawTable() {
    const rows = projects.filter((p) => filter === 'all' || p.status === filter)
    $('#actions-table').innerHTML = rows.length ? `
      <table class="tbl">
        <thead><tr>
          <th>行动项目 / 关联目标</th><th style="width:150px">负责人</th><th style="width:190px">进度</th><th style="width:110px;text-align:right">核验价值</th><th style="width:90px;text-align:right">状态</th>
        </tr></thead>
        <tbody>
          ${rows.map((p) => {
            const prog = p.issueProgress ?? {}
            const pct = (prog.total ?? 0) > 0 ? Math.round(((prog.done ?? 0) / prog.total) * 100) : 0
            const st = PROJECT_STATUS[p.status] ?? ['badge-muted', p.status ?? '—']
            return `
            <tr data-goto-exec style="cursor:pointer">
              <td>
                <div class="col-strong">${esc(p.name)}</div>
                <div class="col-sub fs-11">${p.goalId ? rqI18n.t('关联目标 {name}', { name: goalTitles.get(p.goalId) ?? p.goalId }) : rqI18n.t('未关联目标')}${(p.repos ?? []).length ? rqI18n.t(' · 仓库 {n} 个', { n: (p.repos ?? []).length }) : ''}</div>
              </td>
              <td class="fs-12">${p.ownerUserId ? `<span class="mono">${esc(p.ownerUserId)}</span>` : '未指定'}</td>
              <td>${progressBar(pct, { width: '110px', label: `${prog.done ?? 0}/${prog.total ?? 0}（${pct}%）` })}</td>
              <td class="fs-12 text-3" style="text-align:right">待核验</td>
              <td style="text-align:right"><span class="badge ${st[0]} no-dot">${esc(st[1])}</span></td>
            </tr>`
          }).join('')}
        </tbody>
      </table>` : emptyHint('当前筛选下没有行动项目。')
    $$('#actions-table [data-goto-exec]').forEach((tr) => { tr.onclick = () => { location.hash = '#/exec?tab=goals' } })
  }
  drawTable()

  // 看板：按任务状态分列（真实状态机：待办/进行中/待审/完成/已取消）
  $('#actions-kanban').innerHTML = ISSUE_COLS.map((status) => {
    const list = issues.filter((i) => i.status === status)
    return `
    <div class="kanban-col">
      <div class="flex" style="justify-content:space-between;align-items:center;padding:0 2px;margin-bottom:8px">
        <span class="fs-12" style="font-weight:500">${esc(ISSUE_STATUS_LABEL[status] ?? status)}</span>
        <span class="tnum mono fs-11 text-3" style="background:var(--surface);border-radius:9px;padding:0 6px">${list.length}</span>
      </div>
      ${list.slice(0, 12).map((issue) => `
        <div class="kanban-card" data-issue="${esc(issue.id)}" style="padding:10px;cursor:pointer">
          <div class="flex" style="gap:6px;align-items:center">
            <span class="badge ${PRIORITY_BADGE[issue.priority] ?? 'badge-muted'} no-dot" style="font-size:10px">${esc(issue.priority ?? 'P3')}</span>
            ${issue.executionRunId ? '<span class="badge badge-purple no-dot" style="font-size:10px" title="任务执行加锁中">执行中</span>' : ''}
          </div>
          <div class="fs-13" style="font-weight:500;margin-top:6px;line-height:1.4" title="${esc(issue.title)}">${ellipsis(issue.title, 42)}</div>
          <div class="fs-11 text-3" style="margin-top:2px">${esc(issue.projectName ?? '未挂项目')}</div>
          <div class="flex fs-11 text-3" style="justify-content:space-between;margin-top:8px;border-top:1px solid var(--border);padding-top:6px">
            <span class="ellipsis" style="max-width:60%">${icon('bot', 11)} ${esc(issue.assigneeAgentName ?? issue.assigneeAgentId ?? '未指派')}</span>
            <span class="tnum mono">${issue.dueAt ? esc(fmtDue(issue.dueAt)) : ''}</span>
          </div>
        </div>`).join('') || `<div class="fs-11 text-4" style="text-align:center;padding:14px 0">暂无任务</div>`}
      ${list.length > 12 ? `<div class="fs-11 text-3" style="text-align:center;padding:4px 0">${esc(rqI18n.t('… 其余 {n} 条见执行中枢', { n: list.length - 12 }))}</div>` : ''}
    </div>`
  }).join('')
  $$('#actions-kanban [data-issue]').forEach((card) => { card.onclick = () => { location.hash = '#/exec?tab=issues' } })
}

// ================================================================ Tab 4：collab 人机协作
async function renderCollabTab(body, d) {
  body.innerHTML = `
    ${sectionHead({ label: 'COLLAB / HUMAN × AI', title: '人机协作', extra: '人负责判断，数字员工负责交付 · 把对话、任务、资源与结果留在同一个业务上下文里' })}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px" class="mb-14">
      <div class="card card-pad">
        <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:10px">
          <span class="fs-13" style="font-weight:600">数字员工正在协作</span>
          <span class="fs-11 text-3" id="collab-workers-count"></span>
        </div>
        <div id="collab-workers"><div class="fs-12 text-4" style="padding:10px 0">加载中…</div></div>
        <div class="fs-11 text-3" style="margin-top:10px;background:var(--surface-2);border-radius:6px;padding:8px 10px;line-height:1.6">执行绑定部门资源。新增权限与高风险操作先走审批。</div>
      </div>
      <div class="card card-pad">
        <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:10px">
          <span class="fs-13" style="font-weight:600">${icon('messageSquare', 14)} 协作会话（部门面板）</span>
          <span class="fs-11 text-3">只读摘要</span>
        </div>
        <div id="collab-sessions"><div class="fs-12 text-4" style="padding:10px 0">加载中…</div></div>
      </div>
    </div>
    <div class="grid-2">
      <div class="card card-pad">
        <div class="micro-label">当前业务目标</div>
        <div id="collab-goal"><div class="fs-12 text-4" style="padding:8px 0">加载中…</div></div>
      </div>
      <div class="card card-pad">
        <div class="micro-label" style="margin-bottom:10px">执行边界</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 20px" class="fs-12">
          ${[
            ['数据范围', '按部门面板绑定组织'],
            ['运行方式', '辅助分析 · 结果人工确认'],
            ['业务写入', '高风险操作先走审批'],
            ['对外发送', '连接器单独授权'],
          ].map(([k, v]) => `<div class="flex" style="justify-content:space-between;gap:8px"><span class="text-3">${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}
        </div>
      </div>
    </div>`

  void mountCollabWorkers(d)
  void mountCollabSessions()
  void mountCollabGoal()
}

/** 在线数字员工：/api/agents（agent.read）在线/灰度/试运行清单 → 无权限/失败降级总览计数。 */
async function mountCollabWorkers(d) {
  const host = $('#collab-workers')
  const countEl = $('#collab-workers-count')
  if (!session.can('agent.read')) {
    host.innerHTML = permHint('agent.read', '查看在线数字员工阵容')
    countEl.textContent = ''
    return
  }
  let agents = []
  try {
    agents = (await api.get('/api/agents')).agents ?? []
  } catch (error) {
    host.innerHTML = `<div class="fs-12 text-4" style="padding:8px 0">${esc(rqI18n.t('数字员工清单加载失败：{msg}', { msg: error.message }))}</div>`
    countEl.textContent = ''
    return
  }
  const running = agents.filter((a) => ['online', 'gray', 'trial'].includes(a.status))
  countEl.textContent = rqI18n.t('{a} 位在线 / 共 {b} 个', { a: running.length, b: agents.length })
  host.innerHTML = running.length ? running.slice(0, 6).map((a) => `
    <div class="flex" style="gap:10px;align-items:center;border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;cursor:pointer" data-goto-agents>
      <span class="stat-icon" style="background:var(--surface-2);color:var(--text-3);flex-shrink:0">${icon('bot', 15)}</span>
      <div class="grow" style="min-width:0">
        <div class="fs-13" style="font-weight:500">${esc(a.name)} ${lifecycleBadge(a.status)}</div>
        <div class="fs-11 text-3 ellipsis">${esc(rqI18n.t('绑定用户 {n}', { n: fmtNum(a.boundUserCount ?? 0) }))}${Number(a.metrics?.calls) > 0 ? esc(rqI18n.t(' · 累计调用 {n} 次', { n: fmtNum(a.metrics.calls) })) : ''}</div>
      </div>
    </div>`).join('') : emptyHint(rqI18n.t('当前没有在线数字员工（Agent 在线 {a}/{b}，上线后自动出现在这里）。', { a: fmtNum(d.agents?.online ?? 0), b: fmtNum(d.agents?.total ?? 0) }))
  $$('[data-goto-agents]', host).forEach((row) => { row.onclick = () => { location.hash = '#/agents' } })
}

/** 协作会话摘要：/api/panel/depts（panel.read）只读；403/失败出权限空态。 */
async function mountCollabSessions() {
  const host = $('#collab-sessions')
  let depts
  try {
    depts = (await api.get('/api/panel/depts')).depts ?? []
  } catch {
    host.innerHTML = emptyHint('部门面板会话不可见：需要「panel.read」权限，或面板服务尚未在当前宿主启用。')
    return
  }
  if (!depts.length) {
    host.innerHTML = emptyHint('还没有部门面板——配置部门面板后，人机协作会话将在这里汇总展示。')
    return
  }
  host.innerHTML = depts.slice(0, 6).map((dept) => `
    <div class="flex" style="gap:10px;align-items:center;border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px">
      <span class="stat-icon" style="background:var(--brand-50);color:var(--brand-500);flex-shrink:0">${icon('building2', 15)}</span>
      <div class="grow" style="min-width:0">
        <div class="fs-13" style="font-weight:500">${esc(dept.label ?? dept.id)}</div>
        <div class="fs-11 text-3 ellipsis">${esc(rqI18n.t('{name} · 数字员工 {n} 位{suffix}', { name: dept.org?.name ?? rqI18n.t('未绑定组织'), n: (dept.agents ?? []).length, suffix: dept.allowed === false ? rqI18n.t(' · 无访问权限') : '' }))}</div>
      </div>
      ${dept.allowed === false ? '' : `<a class="fs-11" style="color:var(--brand-600);flex-shrink:0" href="${BASE}/panel/?dept=${encodeURIComponent(dept.id)}" target="_top" rel="noopener">进入面板 ›</a>`}
    </div>`).join('')
}

/** 当前目标（执行中枢首个设指标的目标，只读）。 */
async function mountCollabGoal() {
  const host = $('#collab-goal')
  if (!session.can('exec.read')) {
    host.innerHTML = permHint('exec.read', '查看当前业务目标')
    return
  }
  let goals = []
  try { goals = (await api.get('/api/exec/goals')).goals ?? [] } catch { goals = [] }
  const goal = goals.find((g) => g.metric) ?? goals[0]
  if (!goal) {
    host.innerHTML = emptyHint('暂无当前目标——在执行中枢登记目标后，这里展示协作围绕的业务目标。')
    return
  }
  host.innerHTML = `
    <div class="flex" style="justify-content:space-between;align-items:center;gap:12px;margin-top:8px">
      <div style="min-width:0">
        <div class="fs-13" style="font-weight:500" title="${esc(goal.title)}">${ellipsis(goal.title, 40)}</div>
        <div class="fs-11 text-3" style="margin-top:2px">${goal.metric ? rqI18n.t('{metric}：{base} → {target}{unit}', { metric: goal.metric, base: String(goal.metricBaseline ?? '?'), target: String(goal.metricTarget ?? '?'), unit: goal.metricUnit ?? '' }) : rqI18n.t('未设指标')}</div>
      </div>
      <div class="tnum" style="text-align:right;flex-shrink:0">
        <span style="font-size:20px;font-weight:600">${esc(String(goal.metricTarget ?? '—'))}</span>
        <span class="fs-11 text-3" style="margin-left:6px">${esc(rqI18n.t('目标{unit}', { unit: goal.metricUnit ?? '' }))}</span>
      </div>
    </div>
    <div style="margin-top:10px;text-align:right"><a href="#/exec?tab=goals" class="fs-11" style="color:var(--brand-600)">进入执行中枢 ›</a></div>`
}

// ================================================================ Tab 5：ops 平台运行
async function renderOpsTab(body, d, isManager) {
  const trend = d.costTrend ?? []
  const riskCount = Number(d.alerts?.critical ?? 0) + Number(d.mcp?.unhealthyServices ?? 0)
  body.innerHTML = `
    ${sectionHead({ label: 'PLATFORM / OPS', title: '平台运行', extra: '平台资源与治理口径 · 用量透明与内部成本穿透' })}
    <div class="grid-cards g4 mb-14">
      ${statCard({ label: '受管 AI 资产', value: fmtNum(managedTotal(d)), sub: rqI18n.t('Agent {a} · 应用 {b} · Skill {c} · MCP 在线 {d}', { a: fmtNum(d.agents?.total ?? 0), b: fmtNum(d.apps?.total ?? 0), c: fmtNum(d.skills?.total ?? 0), d: fmtNum(d.mcp?.onlineServices ?? 0) }) })}
      ${statCard({ label: '累计调用', value: fmtNum(d.mcp?.totalCalls ?? 0), sub: rqI18n.t('成功率 {p} · P95 {l}ms', { p: fmtPct(d.mcp?.successRate ?? 1), l: fmtNum(d.mcp?.p95Latency ?? 0) }) })}
      ${statCard({ label: 'Token 消耗（MCP 口径）', value: fmtNum(d.mcp?.tokens ?? 0), sub: rqI18n.t('计量管道幂等入账 · 近 {n} 日成本 {c}', { n: trend.length, c: fmtCost(trend.reduce((s, row) => s + row.costYuan, 0)) }) })}
      ${statCard({ label: '风险', value: fmtNum(riskCount), sub: riskCount ? rqI18n.t('严重告警 {a} · MCP 熔断 {b}', { a: fmtNum(d.alerts?.critical ?? 0), b: fmtNum(d.mcp?.unhealthyServices ?? 0) }) : '无熔断项', tone: riskCount ? (Number(d.alerts?.critical ?? 0) > 0 ? 'crit' : 'warn') : '' })}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px" class="mb-14">
      <div class="card card-pad">
        <div class="card-head" style="margin-bottom:10px">
          <span class="card-title">${icon('barChart3', 15)} ${esc(rqI18n.t('用量趋势（近 {n} 天）', { n: trend.length }))}</span>
          <div class="card-head-actions">${isManager ? `<a href="#/assets" class="fs-12">用量明细 ›</a>` : ''}</div>
        </div>
        <div id="ops-usage"></div>
      </div>
      <div class="card card-pad">
        <div class="card-head" style="margin-bottom:10px">
          <span class="card-title">${icon('coins', 15)} 成本构成</span>
          <span class="card-sub">按组织 · 内部成本参考</span>
        </div>
        <div id="ops-cost" style="display:flex;justify-content:center"><div class="fs-12 text-4" style="padding:20px 0">加载中…</div></div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px" class="mb-14">
      <div class="card card-pad">
        <div class="card-head" style="margin-bottom:10px">
          <span class="card-title">${icon('building2', 15)} 部门用量</span>
          <span class="card-sub">本月 · tokens</span>
        </div>
        <div id="ops-depts"></div>
      </div>
      <div class="card card-pad">
        <div class="card-head" style="margin-bottom:10px">
          <span class="card-title">${icon('fileCheck', 15)} 待办审批</span>
          <div class="card-head-actions">${session.can('approval.read') ? '<a href="#/approvals" class="fs-12">全部 ›</a>' : ''}</div>
        </div>
        <div id="ops-approvals"></div>
      </div>
      <div class="card card-pad">
        <div class="card-head" style="margin-bottom:10px">
          <span class="card-title">${icon('radio', 15)} 最近事件</span>
          <div class="card-head-actions"><a href="#/audit?tab=logs" class="fs-12">审计 ›</a></div>
        </div>
        <div id="ops-events"></div>
      </div>
    </div>

    <div class="card card-pad">
      <div class="card-head" style="margin-bottom:12px">
        <span class="card-title">${icon('boxes', 15)} 资产健康速览</span>
        <div class="card-head-actions" style="display:flex;gap:8px">
          <a href="#/assets" class="btn btn-default btn-sm">资产台账 ${icon('chevronRight', 12)}</a>
        </div>
      </div>
      <div id="ops-fleet"></div>
      <div id="ops-circuit"></div>
    </div>`

  // 用量趋势：总览 14 日成本/Token 序列（真实计量聚合）
  const usageEl = $('#ops-usage')
  if (trend.length > 1) {
    usageEl.innerHTML = `
      ${areaChart({ series: trend.map((row) => +(row.llmTokens / 10000).toFixed(1)), labels: trend.map((row) => String(row.key).slice(5)), unit: rqI18n.t('万 tokens / 日'), height: 170 })}
      <div class="flex fs-12 text-3" style="justify-content:space-between;border-top:1px solid var(--border);padding-top:10px;margin-top:8px">
        <span>${esc(rqI18n.t('成本参考合计'))} <span class="tnum mono" style="font-weight:600;color:var(--text-1)">${fmtCost(trend.reduce((s, row) => s + row.costYuan, 0))}</span>${esc(rqI18n.t(' / {n} 天', { n: trend.length }))}</span>
        <span>按日归集 · 应用 → Agent → MCP 穿透</span>
      </div>`
  } else {
    usageEl.innerHTML = emptyHint('暂无用量趋势数据——平台产生计量事件后，这里展示近 14 天 Token 消耗曲线。')
  }

  // 成本构成 + 部门用量：月度用量报表（usage.read）双视图共用一次拉取
  if (isManager) {
    void mountOpsCostMix()
  } else {
    $('#ops-cost').innerHTML = permHint('usage.read', '查看成本构成')
    $('#ops-depts').innerHTML = permHint('usage.read', '查看部门用量分摊')
  }

  // 待办审批 top3（approval.read 门控）
  void mountDecisionRows($('#ops-approvals'), 3)

  // 最近事件时间线：审计日志（audit.read）→ 总览事件流降级
  void mountOpsEvents(d)

  // 资产健康速览：fleet 台账（WB 聚合端点）→ 总览六类派生
  void mountOpsFleet(d)

  // 熔断影响红条（存在 critical/熔断资产时）
  const circuit = []
  if ((d.mcp?.unhealthyServices ?? 0) > 0) circuit.push(rqI18n.t('MCP 熔断服务 {n} 个，相关调用按降级链路处理', { n: fmtNum(d.mcp.unhealthyServices) }))
  if ((d.alerts?.critical ?? 0) > 0) circuit.push(rqI18n.t('严重告警 {n} 条待处置', { n: fmtNum(d.alerts.critical) }))
  $('#ops-circuit').innerHTML = circuit.length ? `
    <div class="flex fs-12" style="gap:8px;align-items:center;margin-top:12px;border:1px solid var(--danger);background:var(--danger-bg);color:var(--danger);border-radius:6px;padding:8px 12px">
      ${icon('shieldAlert', 14)}
      <span class="grow">${esc(rqI18n.t('{items}，建议优先巡检处理。', { items: circuit.join(rqI18n.t('；')) }))}</span>
      <a href="#/mcp" style="color:var(--danger);text-decoration:underline;flex-shrink:0">去处理</a>
    </div>` : ''
}

/** 成本构成（组织维度甜甜圈）+ 部门用量（组织 tokens 横条）。 */
async function mountOpsCostMix() {
  let report = null
  try { report = await api.get('/api/usage/report/monthly') } catch { report = null }
  const byOrg = (report?.byOrg ?? []).filter((row) => Number(row.tokens ?? 0) > 0 || Number(row.cost_cents ?? 0) > 0)
  const costEl = $('#ops-cost')
  const deptEl = $('#ops-depts')
  if (!costEl || !deptEl) return
  if (!byOrg.length) {
    costEl.innerHTML = emptyHint('本月暂无组织维度成本数据。')
    deptEl.innerHTML = emptyHint('本月暂无组织维度用量数据。')
    return
  }
  const parts = byOrg.map((row, i) => ({
    label: row.dimension,
    value: Math.round(Number(row.cost_cents ?? 0) / 100),
    color: CHART_COLORS[i % CHART_COLORS.length],
  })).filter((p) => p.value > 0)
  const totalYuan = parts.reduce((s, p) => s + p.value, 0)
  costEl.innerHTML = parts.length
    ? donutCenter(parts, { centerLabel: '月成本参考', centerValue: fmtCost(totalYuan) })
    : emptyHint('本月成本参考为零（零价快照口径或尚无计费事件）。')
  deptEl.innerHTML = hBarList(
    byOrg.map((row) => ({ name: row.dimension, value: Number(row.tokens ?? 0), hint: rqI18n.t('{n} 次事件', { n: fmtNum(row.events ?? 0) }) })),
    { format: (v) => `${fmtNum(v)} tok` },
  )
}

/** 最近事件时间线：/api/audit/logs?limit=5（audit.read）→ /api/overview recentEvents 降级（事件名中文化）。 */
async function mountOpsEvents(d) {
  const host = $('#ops-events')
  if (session.can('audit.read')) {
    try {
      const logs = (await api.get('/api/audit/logs?limit=5')).items ?? []
      if (logs.length) {
        host.innerHTML = `<div class="timeline">${logs.map((log) => `
          <div class="tl-item ${log.result === 'ok' ? 'done' : 'current'}">
            <span class="tl-dot"></span>
            <div style="min-width:0">
              <div class="fs-13 ellipsis" title="${esc(log.action)}">${esc(log.action)}</div>
              <div class="fs-11 text-3 tnum">${timeAgo(log.createdAt)} · ${esc(log.actorName ?? '系统')}${log.result && log.result !== 'ok' ? ` · ${esc(log.result)}` : ''}</div>
            </div>
          </div>`).join('')}</div>`
        return
      }
    } catch { /* 降级到总览事件流 */ }
  }
  const events = (d.recentEvents ?? []).slice(0, 5)
  host.innerHTML = events.length ? `<div class="timeline">${events.map((event) => `
    <div class="tl-item ${eventBadgeTone(event.name) === 'done' ? 'done' : 'current'}">
      <span class="tl-dot"></span>
      <div style="min-width:0">
        <div class="fs-13 ellipsis" title="${esc(eventLabel(event.name))}">${esc(eventLabel(event.name))}</div>
        <div class="fs-11 text-3 tnum">${timeAgo(event.at)}${event.payload ? ` · ${ellipsis(event.payload, 26)}` : ''}</div>
      </div>
    </div>`).join('')}</div>` : emptyHint('暂无事件——平台事件将实时显示在这里。')
}

/** 资产健康速览：/api/fleet/ledger（WB 六类台账聚合）top10 → 总览派生分类卡。 */
async function mountOpsFleet(d) {
  const host = $('#ops-fleet')
  let rows = null
  try {
    const data = await api.get('/api/fleet/ledger')
    rows = data?.items ?? data?.assets ?? null
  } catch { rows = null }

  if (rows?.length) {
    host.innerHTML = `<div class="grid-cards g5">${rows.slice(0, 10).map((a) => `
      <div class="card card-pad" data-goto-assets style="cursor:pointer;padding:12px">
        <div class="flex" style="justify-content:space-between;align-items:center">
          ${typeBadge(a.type)}
          ${healthDot(a.health || 'offline', { pulse: a.health === 'critical' })}
        </div>
        <div class="fs-13" style="font-weight:500;margin-top:8px" title="${esc(a.name ?? '')}">${ellipsis(a.name ?? a.id ?? '—', 16)}</div>
        <div class="fs-11 text-3 tnum mono ellipsis" title="${esc(a.key ?? '')}">${esc(a.key ?? '—')}</div>
      </div>`).join('')}</div>`
    $$('[data-goto-assets]', host).forEach((tile) => { tile.onclick = () => { location.hash = '#/assets' } })
    return
  }

  // 降级：总览真实计数的分类速览（点击进台账下钻）
  const cats = [
    { type: 'agent', label: TYPE_LABELS.agent, main: fmtNum(d.agents?.online ?? 0), sub: rqI18n.t('在线 / 共 {a} · 试运行 {b}', { a: fmtNum(d.agents?.total ?? 0), b: fmtNum(d.agents?.trial ?? 0) }), warn: false },
    { type: 'app', label: TYPE_LABELS.app, main: fmtNum(d.apps?.online ?? 0), sub: rqI18n.t('在线 / 共 {a} · 试运行 {b}', { a: fmtNum(d.apps?.total ?? 0), b: fmtNum(d.apps?.trial ?? 0) }), warn: false },
    { type: 'skill', label: TYPE_LABELS.skill, main: fmtNum(d.skills?.published ?? 0), sub: rqI18n.t('上架 / 共 {a} · 待审批 {b}', { a: fmtNum(d.skills?.total ?? 0), b: fmtNum(d.skills?.pendingApproval ?? 0) }), warn: (d.skills?.pendingApproval ?? 0) > 0 },
    { type: 'mcp', label: TYPE_LABELS.mcp, main: fmtNum(d.mcp?.onlineServices ?? 0), sub: rqI18n.t('在线{suffix}', { suffix: (d.mcp?.unhealthyServices ?? 0) > 0 ? rqI18n.t(' · 熔断 {n}', { n: fmtNum(d.mcp.unhealthyServices) }) : rqI18n.t(' · 无熔断') }), warn: (d.mcp?.unhealthyServices ?? 0) > 0 },
  ]
  host.innerHTML = `
    <div class="grid-cards g4">${cats.map((c) => `
      <div class="card card-pad" data-goto-assets style="cursor:pointer;padding:12px">
        <div class="flex" style="justify-content:space-between;align-items:center">
          ${typeBadge(c.type)}
          <span class="dot ${c.warn ? 'dot-warn' : 'dot-ok'}"></span>
        </div>
        <div class="tnum" style="font-size:18px;font-weight:600;margin-top:8px">${esc(c.main)}</div>
        <div class="fs-11 text-3">${esc(c.sub)}</div>
      </div>`).join('')}</div>
    <div class="fs-11 text-4" style="margin-top:8px">分类速览（台账聚合端点未就绪时的降级视图）· 明细见资产台账</div>`
  $$('[data-goto-assets]', host).forEach((tile) => { tile.onclick = () => { location.hash = '#/assets' } })
}

// ================================================================ 共享装配
/** 待决策行（cockpit「需要您决策」与 ops「待办审批」共用）：pending top N，点击带 focus 进审批中心。 */
async function mountDecisionRows(host, limit = 3) {
  if (!host) return
  if (!session.can('approval.read')) {
    host.innerHTML = permHint('approval.read', '查看待办审批')
    return
  }
  let items = []
  try {
    const data = await api.get('/api/approvals?status=pending')
    items = (data.approvals ?? []).filter((item) => item.status === 'pending').slice(0, limit)
  } catch (error) {
    host.innerHTML = `<div class="fs-12 text-4" style="padding:10px 0">${esc(rqI18n.t('审批加载失败：{msg}', { msg: error.message }))}</div>`
    return
  }
  if (!items.length) {
    host.innerHTML = emptyHint('当前没有待办审批——所有审批已处理完毕。')
    return
  }
  host.innerHTML = items.map((item) => `
    <div style="display:flex;gap:10px;align-items:center;border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;cursor:pointer" data-approval="${esc(item.id)}">
      <span class="stat-icon" style="background:${item.riskLevel === 'high' ? 'var(--warn-bg)' : 'var(--brand-50)'};color:${item.riskLevel === 'high' ? 'var(--warn)' : 'var(--brand-500)'};flex-shrink:0">${icon(item.riskLevel === 'high' ? 'arrowUp' : 'check', 15)}</span>
      <div class="grow" style="min-width:0">
        <div class="fs-13" style="font-weight:500" title="${esc(item.title)}">${ellipsis(item.title, 30)}</div>
        <div class="fs-11 text-3">${esc(rqI18n.t('{name} 发起 · {kind} · {time}', { name: item.requesterName ?? '—', kind: item.kind ?? '', time: timeAgo(item.createdAt) }))}</div>
      </div>
      <span class="risk-pill ${item.riskLevel === 'high' ? 'risk-high' : 'risk-normal'}" style="flex-shrink:0">${item.riskLevel === 'high' ? '高风险' : '常规'}</span>
    </div>`).join('')
  $$('[data-approval]', host).forEach((row) => {
    row.onclick = () => { location.hash = `#/approvals?focus=${row.dataset.approval}` }
  })
}

/** A3 最近调用（≤5，自见）：来自 /api/usage/recent（当前登录人自身计量）。 */
async function mountRecentCalls() {
  const host = $('#dash-recent')
  if (!host) return
  try {
    const recent = await api.get('/api/usage/recent?limit=5')
    if (!recent.items?.length) {
      host.innerHTML = emptyHint('还没有调用记录——完成一次 AI 调用后，最近记录将显示在这里。')
      return
    }
    host.innerHTML = recent.items.map((item) => `
      <div class="flex" style="padding:10px 0;border-bottom:1px solid var(--border)">
        <span class="badge badge-muted no-dot" style="min-width:64px;justify-content:center">${esc(item.name || item.resource)}</span>
        <div class="grow fs-12 text-3">${item.meters?.map((meter) => `${esc(meter.key)} ${fmtNum(meter.value)}`).join(' · ') || '—'}${item.nonbillable ? esc(rqI18n.t(' · 非计费')) : ''}</div>
        <span class="fs-11 text-4">${timeAgo(item.occurred_at)}</span>
      </div>`).join('')
  } catch {
    host.innerHTML = `<div class="fs-12 text-4" style="padding:14px 0">最近调用加载失败</div>`
  }
}

// ================================================================ 派生与工具
/** 总览派生洞察文案：全部来自真实计数，不使用固定话术。 */
function deriveInsightText(d, execOv) {
  const parts = []
  parts.push(rqI18n.t('平台当前纳管 AI 资产 {n} 项：Agent 在线 {a}/{b}，AI 应用在线 {c} 个，Skill 上架 {d} 个。', {
    n: fmtNum(managedTotal(d)),
    a: fmtNum(d.agents?.online ?? 0), b: fmtNum(d.agents?.total ?? 0),
    c: fmtNum(d.apps?.online ?? 0), d: fmtNum(d.skills?.published ?? 0),
  }))
  if (execOv && (Number(execOv.goals ?? 0) > 0 || Number(execOv.projects ?? 0) > 0)) {
    parts.push(rqI18n.t('执行中枢正在推进 {a} 个目标、{b} 个项目。', { a: fmtNum(execOv.goals ?? 0), b: fmtNum(execOv.projects ?? 0) }))
  }
  if ((d.approvals?.pending ?? 0) > 0) parts.push(rqI18n.t('有 {n} 单审批待处理。', { n: fmtNum(d.approvals.pending) }))
  if ((d.alerts?.unread ?? 0) > 0) parts.push(rqI18n.t('未读告警 {n} 条{crit}。', { n: fmtNum(d.alerts.unread), crit: (d.alerts.critical ?? 0) > 0 ? rqI18n.t('（其中 {m} 条严重）', { m: fmtNum(d.alerts.critical) }) : '' }))
  if ((d.mcp?.unhealthyServices ?? 0) > 0) parts.push(rqI18n.t('MCP 熔断服务 {n} 个，相关调用按降级链路处理。', { n: fmtNum(d.mcp.unhealthyServices) }))
  if ((d.conflicts ?? 0) > 0) parts.push(rqI18n.t('三方同步冲突 {n} 条待确认。', { n: fmtNum(d.conflicts) }))
  if ((d.approvals?.pending ?? 0) === 0 && (d.alerts?.unread ?? 0) === 0 && !(d.conflicts > 0)) parts.push(rqI18n.t('当前无待办审批与未读告警，平台整体运行平稳。'))
  return parts.join('')
}

/** 总览派生异常行（无执行中枢洞察时的真实降级）。 */
function deriveExceptions(d) {
  const rows = []
  if ((d.mcp?.unhealthyServices ?? 0) > 0) rows.push({ name: rqI18n.t('MCP 熔断服务 {n} 个', { n: fmtNum(d.mcp.unhealthyServices) }), level: 'critical', chain: '调用按降级链路处理', owner: '平台运维' })
  if ((d.alerts?.critical ?? 0) > 0) rows.push({ name: rqI18n.t('严重告警 {n} 条', { n: fmtNum(d.alerts.critical) }), level: 'critical', chain: '审计与告警中心', owner: '平台治理' })
  else if ((d.alerts?.unread ?? 0) > 0) rows.push({ name: rqI18n.t('未读告警 {n} 条', { n: fmtNum(d.alerts.unread) }), level: 'warning', chain: '审计与告警中心', owner: '平台治理' })
  if ((d.conflicts ?? 0) > 0) rows.push({ name: rqI18n.t('三方同步冲突 {n} 条', { n: fmtNum(d.conflicts) }), level: 'warning', chain: '组织同步 · 待确认', owner: '组织管理员' })
  return rows
}

/** 受管资产总数（总览口径：Agent + 应用 + Skill + MCP 在线与异常服务）。 */
function managedTotal(d) {
  return Number(d.agents?.total ?? 0) + Number(d.apps?.total ?? 0) + Number(d.skills?.total ?? 0)
    + Number(d.mcp?.onlineServices ?? 0) + Number(d.mcp?.unhealthyServices ?? 0)
}

/** 执行中枢目标价值序列提取（WB 字段：goalsData.value = {actual,target,labels,unit}，容忍别名）。 */
function extractValueSeries(goalsData) {
  if (!goalsData || typeof goalsData !== 'object') return null
  const v = goalsData.value ?? goalsData.valueSeries ?? goalsData.valueTrend
  if (!v || !Array.isArray(v.actual) || v.actual.length < 2 || !Array.isArray(v.target)) return null
  const actual = v.actual.map(Number).filter((n) => Number.isFinite(n))
  const target = v.target.map(Number).filter((n) => Number.isFinite(n))
  if (actual.length < 2 || !target.length) return null
  return {
    actual,
    target,
    labels: Array.isArray(v.labels) && v.labels.length >= actual.length
      ? v.labels.slice(0, actual.length).map(String)
      : actual.map((_, i) => `T${i + 1}`),
    unit: typeof v.unit === 'string' ? v.unit : '',
  }
}

/** 权限空态卡（页面级）。 */
function permCard(title, point, message) {
  return `
    <div class="card card-pad" style="text-align:center;padding:44px 24px">
      <div style="margin-bottom:10px;color:var(--text-4)">${icon('lock', 24)}</div>
      <div style="font-weight:600;margin-bottom:6px">${esc(title)}</div>
      <div class="fs-12 text-3">${esc(message)}</div>
      <div class="fs-12 text-4" style="margin-top:6px">所需权限点：<span class="mono">${esc(point)}</span></div>
    </div>`
}

/** 权限空态（卡片内嵌）。 */
function permHint(point, what) {
  return emptyHint(rqI18n.t('需要「{point}」权限才能{what}。', { point, what }))
}

function errorCard(title, message) {
  return `
    <div class="card card-pad" style="text-align:center;padding:44px 24px">
      <div style="margin-bottom:10px;color:var(--danger)">${icon('alert', 24)}</div>
      <div style="font-weight:600;margin-bottom:6px">${esc(title)}</div>
      <div class="fs-12 text-3">${esc(message)}</div>
    </div>`
}

function ellipsis(text, max) {
  const str = String(text ?? '')
  return esc(str.length > max ? `${str.slice(0, max)}…` : str)
}

function fmtDue(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())}`
}

/** 事件名中文标签：字典命中优先；未收录事件按分段转译兜底（新事件不裸奔英文）。 */
const EVENT_LABELS = {
  'iam.user.frozen': '账号冻结', 'iam.user.activated': '账号启用', 'iam.org.changed': '组织变更',
  'iam.permission.changed': '权限变更', 'iam.connector.synced': '通讯录同步',
  'authn.token.issued': '令牌签发', 'authn.token.revoked': '令牌吊销',
  'oidc.authorize.granted': 'SSO 授权通过', 'oidc.authorize.denied': 'SSO 授权拒绝',
  'mcp.deployed': 'MCP 发布', 'mcp.offlined': 'MCP 下线', 'mcp.unhealthy': 'MCP 熔断', 'mcp.invoked': 'MCP 调用',
  'behavior.recorded': '行为事件',
  'connector.gateway.changed': '连接器网关变更', 'connector.gateway.synced': '连接器目录同步',
  'connector.gateway.unhealthy': '连接器网关异常', 'connector.connected': 'SaaS 连接建立',
  'connector.disconnected': 'SaaS 连接断开', 'connector.invoked': 'SaaS 连接器调用',
  'connector.permgroup.changed': '连接器权限组变更',
  'nas.registered': 'NAS 注册', 'nas.onlined': 'NAS 上线', 'nas.offlined': 'NAS 下线',
  'skill.published': 'Skill 上架', 'skill.submitted': 'Skill 提交', 'skill.installed': 'Skill 安装', 'skill.deprecated': 'Skill 弃用',
  'agent.registered': 'Agent 注册', 'agent.onlined': 'Agent 上线', 'agent.offlined': 'Agent 下线',
  'app.registered': '应用注册', 'app.onlined': '应用发布', 'app.offlined': '应用下架', 'app.updated': '应用更新', 'app.archived': '应用归档',
  'approval.created': '新建审批', 'approval.decided': '审批决策',
  'audit.alert.fired': '触发告警',
  'market.plugin.submitted': '插件提交', 'market.plugin.listed': '插件上架', 'market.plugin.installed': '插件安装',
  'connect.code.created': '接入码生成', 'connect.client.enrolled': '客户端接入', 'connect.client.disabled': '客户端停用',
  'platform.update.available': '发现平台更新', 'platform.update.applied': '平台更新完成',
}
function eventLabel(name, labels = EVENT_LABELS) {
  if (labels[name]) return labels[name]
  const SEGMENTS = {
    iam: '账号', authn: '认证', oidc: '单点登录', mcp: 'MCP', nas: 'NAS', audit: '审计',
    skill: '技能', agent: '智能体', app: '应用', usage: '用量', market: '市场',
    platform: '平台', approval: '审批', connector: '连接器', console: '控制台', connect: '接入',
    behavior: '行为', user: '用户', org: '组织', permission: '权限', token: '令牌', gateway: '网关', permgroup: '权限组',
    created: '创建', changed: '变更', issued: '签发', revoked: '吊销', deployed: '发布', onlined: '上线',
    offlined: '下线', unhealthy: '异常', invoked: '调用', connected: '连接', disconnected: '断开',
    submitted: '提交', published: '上架', installed: '安装', deprecated: '弃用', registered: '注册',
    updated: '更新', archived: '归档', granted: '通过', denied: '拒绝', fired: '触发', synced: '同步',
    available: '可更新', applied: '已应用', settled: '结算', enrolled: '接入', disabled: '停用', frozen: '冻结', activated: '启用',
  }
  const translated = name.split('.').map((seg) => SEGMENTS[seg] ?? seg).join(' · ')
  return translated === name ? name : translated
}

function eventBadgeTone(name) {
  if (name.includes('unhealthy') || name.includes('alert') || name.includes('frozen') || name.includes('revoked') || name.includes('offlined') || name.includes('offline') || name.includes('deprecated')) return 'crit'
  if (name.includes('deployed') || name.includes('published') || name.includes('onlined') || name.includes('registered')) return 'done'
  if (name.includes('approval')) return 'warn'
  return 'done'
}
