/** 多风格工作台：只消费现有只读接口；关系线仅取真实记录中的外键。 */
import { api, session } from './api.js'
import { currentUiTheme } from './theme.js'
import { esc, fmtNum } from './ui.js'
import rqI18n from './i18n.js'
import { icon } from './icons.js'
import { crystalMarkup, mountCrystalScene } from './crystal-scene.js'

const t = (key, params) => rqI18n.t(key, params)
let active = null
let graph = null
let crystal = null
let version = 0
const scripts = new Map()

function loadLibrary(name, relativePath) {
  if (window[name]) return Promise.resolve(window[name])
  if (!scripts.has(name)) {
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = new URL(relativePath, import.meta.url).href
      script.onload = () => window[name] ? resolve(window[name]) : reject(new Error(name))
      script.onerror = () => reject(new Error(name))
      document.head.appendChild(script)
    }).catch((error) => { scripts.delete(name); throw error })
    scripts.set(name, promise)
  }
  return scripts.get(name)
}

function destroyGraph() {
  if (graph) { graph.destroy(); graph = null }
  crystal?.destroy(); crystal = null
}

document.addEventListener('ybk-ui-theme-change', () => {
  if (active?.host?.isConnected) void render(active)
  else { ++version; destroyGraph(); active = null }
})
window.addEventListener('hashchange', () => {
  if (active?.host && !active.host.isConnected) { ++version; destroyGraph(); active = null }
})

export function mountThemeLens(host, overview) {
  ++version
  destroyGraph()
  active = { host, overview }
  void render(active)
}

const metric = (label, value, hint) => `<div class="lens-metric"><span>${esc(t(label))}</span><strong>${esc(value)}</strong><small>${esc(t(hint))}</small></div>`
const unavailable = () => `<p class="lens-empty">${esc(t('暂无可展示的数据，或当前账号没有查看权限。'))}</p>`

async function getExecOverview() {
  if (!session.can('exec.read')) return null
  try { return await api.get('/api/exec/overview') } catch { return null }
}

async function getWorkforceOverview() {
  if (!session.can('workforce.read')) return null
  try { return await api.get('/api/workforce/overview') } catch { return null }
}

async function render(state) {
  const run = ++version
  destroyGraph()
  const { host, overview } = state
  if (!host?.isConnected) return
  const theme = currentUiTheme()
  if (theme === 'classic') { host.replaceChildren(); return }
  host.innerHTML = `<section class="theme-lens lens-loading" aria-live="polite">${esc(t('正在加载主题视图…'))}</section>`
  const [exec, workforce] = await Promise.all([getExecOverview(), theme === 'crystal' ? getWorkforceOverview() : null])
  if (run !== version || !host.isConnected) return
  if (theme === 'clear') renderClear(host, overview, exec, run)
  else if (theme === 'graph') await renderGraph(host, overview, exec, run)
  else if (theme === 'crystal') renderCrystal(host, overview, exec, workforce, run)
  else renderNight(host, overview, exec, run)
}

function renderCrystal(host, overview, exec, workforce, run) {
  const label = (key) => esc(t(key))
  const link = (permission, route, title, glyph) => session.can(permission) ? `<a href="#/${route}"><span aria-hidden="true">${icon(glyph,18)}</span><span>${label(title)}</span><span aria-hidden="true">↗</span></a>` : ''
  const k = exec?.kpis
  host.innerHTML = `<section class="theme-lens lens-crystal" aria-label="${label('冰晶协同全景')}">
    <div class="lens-topline"><span>${label('数字员工 · 企业能力 · 统一治理')}</span><a href="#/home">${label('产品全景')} ↗</a></div>
    <div class="crystal-overview"><div class="crystal-overview-copy"><span class="lens-eyebrow">CONNECTED INTELLIGENCE</span><h2>${label('让数字员工协同，')}<br><span>${label('让企业能力聚合。')}</span></h2><p>${label('连接目标、行动与治理，让负责人看见进展和需要关注的事项。')}</p><div class="crystal-overview-actions">${link('exec.read','dashboard?tab=actions','查看行动','target')}${link('agent.read','agents','数字员工','users')}</div><small class="crystal-data-note">${label('基于当前账号可见数据')} · ${label('当前快照')}</small></div><div class="crystal-overview-art">${crystalMarkup()}<span class="crystal-art-label">${label('协作生态示意')}</span></div></div>
    <div class="crystal-kpis">
      ${metric('目标',exec ? fmtNum(exec.goals??0):'—','已登记目标')}
      ${metric('数字员工',Number.isFinite(workforce?.employees) ? fmtNum(workforce.employees):'—','已登记数字员工')}
      ${metric('今日调用',k ? fmtNum(k.callsToday??0):'—','统一计量口径')}
      ${metric('待处理',session.can('approval.read')&&overview.approvals ? fmtNum(overview.approvals.pending??0):'—','待审批事项')}
    </div>
    <div class="crystal-operation-grid"><div class="crystal-shortcuts"><h3>${label('企业能力')}</h3><div>${link('mcp.service.read','mcp','MCP 服务','plug')}${link('skill.read','skills','Skill 技能','sparkles')}${session.can('panel.read') ? link('modelgw.read','gateway','模型渠道','cpu') : ''}${link('app.read','apps','AI 应用','app')}${link('connector.catalog.read','connectors','SaaS 连接器','link')}${link('nas.read','nas','文件存储','server')}</div></div><div class="crystal-task-status"><h3>${label('任务状态分布')}</h3><div class="lens-chart" id="lens-status-chart">${exec?.issuesByStatus?'':unavailable()}</div><div class="crystal-governance-links">${link('approval.read','approvals','查看审批','checkSquare')}${link('audit.read','audit','审计记录','scroll')}${link('usage.read','usage','用量洞察','chart')}</div></div></div>
    ${!exec ? `<p class="lens-note">${label('执行中枢数据不可用，部分指标以破折号表示。')}</p>`:''}
  </section>`
  crystal = mountCrystalScene(host.querySelector('[data-crystal-scene]'))
  // 工作台以静态 3D 首帧为主，避免持续动效干扰日常操作。
  crystal.setMotion(false)
  if (exec?.issuesByStatus) void drawStatusChart(host.querySelector('#lens-status-chart'),exec.issuesByStatus,run)
}

function renderClear(host, overview, exec, run) {
  const kpis = exec?.kpis
  const statuses = exec?.issuesByStatus
  host.innerHTML = `<section class="theme-lens lens-clear" aria-label="${esc(t('经营总览主题视图'))}">
    <div class="lens-topline"><span>${esc(t('企业 AI 经营全景'))}</span><span>${esc(t('基于当前账号可见数据'))}</span></div>
    <div class="lens-clear-layout">
      <div class="lens-story"><span class="lens-eyebrow">${esc(t('从目标到结果'))}</span><h2>${esc(t('让每一次 AI 协作都有迹可循'))}</h2><p>${esc(t('连接目标、行动与治理，让负责人看见进展和需要关注的事项。'))}</p>${session.can('exec.read') ? `<a href="#/exec">${esc(t('查看执行中枢'))} ↗</a>` : ''}</div>
      <div class="lens-metrics">
        ${metric('目标', exec ? fmtNum(exec.goals) : '—', '已登记目标')}
        ${metric('行动项目', exec ? fmtNum(exec.projects) : '—', '已登记项目')}
        ${metric('数字员工', fmtNum(overview.agents?.total ?? 0), 'Agent 本体')}
        ${metric('待处理', fmtNum(overview.approvals?.pending ?? 0), '待审批事项')}
      </div>
    </div>
    <div class="lens-chart-line"><div><b>${esc(t('任务状态分布'))}</b><small>${esc(t('执行中枢 · 当前任务'))}</small></div><div class="lens-chart" id="lens-status-chart">${statuses ? '' : unavailable()}</div>${session.can('exec.read') ? `<a href="#/dashboard?tab=actions">${esc(t('查看行动'))} →</a>` : ''}</div>
    ${!kpis ? `<p class="lens-note">${esc(t('执行中枢数据不可用，部分指标以破折号表示。'))}</p>` : ''}
  </section>`
  if (statuses) void drawStatusChart(host.querySelector('#lens-status-chart'), statuses, run)
}

function renderNight(host, overview, exec, run) {
  const k = exec?.kpis
  const risk = k?.risk
  const trend = Array.isArray(overview.costTrend) ? overview.costTrend : []
  host.innerHTML = `<section class="theme-lens lens-night" aria-label="${esc(t('治理观察主题视图'))}">
    <div class="lens-topline"><span>${esc(t('治理观察'))} / ${esc(t('风险与运行'))}</span><span class="lens-live">${esc(t('当前快照'))}</span></div>
    <div class="lens-night-grid"><div class="lens-night-main"><span class="lens-eyebrow">${esc(t('让风险和运行状态一目了然'))}</span><h2>${esc(t('掌握全局，及时决策'))}</h2><p>${esc(exec?.insight?.text || t('执行中枢数据暂不可用，请检查权限或稍后重试。'))}</p>
      <div class="lens-night-actions">${session.can('audit.read') ? `<a href="#/audit?tab=alerts">${esc(t('查看告警'))} ↗</a>` : ''}${session.can('approval.read') ? `<a href="#/approvals">${esc(t('查看审批'))} ↗</a>` : ''}</div></div>
      <div class="lens-night-kpis">
        ${metric('严重风险', risk ? fmtNum(risk.critical) : '—', '未读告警与熔断')}
        ${metric('一般风险', risk ? fmtNum(risk.warning) : '—', '需关注事项')}
        ${metric('今日调用', k ? fmtNum(k.callsToday) : '—', '统一计量口径')}
        ${metric('今日 Token', k ? fmtNum(k.tokensToday) : '—', '统一计量口径')}
      </div>
      <div class="lens-trend"><div class="lens-trend-head"><div><b>${esc(t('Token 消耗趋势'))}</b><small>${esc(t('总览接口 · 最近可用日期'))}</small></div><span>${esc(t('按日'))}</span></div><div id="lens-trend-chart" class="lens-trend-chart">${trend.length ? '' : unavailable()}</div></div>
    </div>
  </section>`
  if (trend.length) void drawTrendChart(host.querySelector('#lens-trend-chart'), trend, run)
}

async function renderGraph(host, overview, exec, run) {
  if (!session.can('exec.read')) {
    host.innerHTML = `<section class="theme-lens lens-graph"><h2>${esc(t('目标与协作图谱'))}</h2>${unavailable()}</section>`
    return
  }
  const requests = [api.get('/api/exec/goals'), api.get('/api/exec/projects'), api.get('/api/exec/issues')]
  if (session.can('agent.read')) requests.push(api.get('/api/agents'))
  const response = await Promise.allSettled(requests)
  if (run !== version || !host.isConnected) return
  if (response.slice(0, 3).some((result) => result.status !== 'fulfilled')) {
    host.innerHTML = `<section class="theme-lens lens-graph"><h2>${esc(t('目标与协作图谱'))}</h2><p class="lens-empty">${esc(t('关系数据加载失败，请刷新后重试。'))}</p></section>`
    return
  }
  const goals = response[0].value.goals ?? []
  const projects = response[1].value.projects ?? []
  const issues = response[2].value.issues ?? []
  const agents = response[3]?.status === 'fulfilled' ? (response[3].value.agents ?? []) : []
  const all = buildGraph(goals, projects, issues, agents)
  host.innerHTML = `<section class="theme-lens lens-graph" aria-label="${esc(t('协作关系主题视图'))}">
    <div class="lens-topline"><span>${esc(t('协作关系'))}</span><span>${esc(t('真实关联 · 可拖拽缩放'))}</span></div>
    <div class="lens-graph-intro"><div><span class="lens-eyebrow">${esc(t('从目标到行动'))}</span><h2>${esc(t('目标与协作图谱'))}</h2><p>${esc(t('按已登记关系连接目标、项目、任务和数字员工；连线表示归属或指派，不代表实际调用。'))}</p></div><div class="lens-graph-counts"><span><strong>${fmtNum(goals.length)}</strong>${esc(t('目标'))}</span><span><strong>${fmtNum(projects.length)}</strong>${esc(t('项目'))}</span><span><strong>${fmtNum(issues.length)}</strong>${esc(t('任务'))}</span></div></div>
    ${all.nodes.length ? `<div class="lens-graph-body"><div id="lens-network" class="lens-network" aria-label="${esc(t('关系图，可使用下方节点列表选择'))}"></div><div class="lens-graph-side"><div class="lens-legend"><span>${esc(t('目标'))}</span><span>${esc(t('项目'))}</span><span>${esc(t('任务'))}</span><span>${esc(t('数字员工'))}</span></div><div id="lens-node-detail" class="lens-node-detail">${esc(t('选择图中节点或下方列表，查看类型和状态。'))}</div><div class="lens-node-list" aria-label="${esc(t('关系节点列表'))}">${all.nodes.map((n) => `<button type="button" data-node="${esc(n.data.id)}"><span>${esc(t(n.data.kind))}</span>${esc(n.data.fullName)}</button>`).join('')}</div><a href="#/exec">${esc(t('查看执行中枢'))} ↗</a></div></div>` : unavailable()}
    <p class="lens-note">${esc(t('仅展示可见数据；图谱最多展示 60 个节点。'))}${response[3]?.status === 'rejected' || !session.can('agent.read') ? ` ${esc(t('数字员工数据不可用，相关节点未展示。'))}` : ''}</p>
  </section>`
  if (!all.nodes.length) return
  const selectNode = (id) => {
    const found = all.nodes.find((node) => node.data.id === id)
    const detail = host.querySelector('#lens-node-detail')
    const statuses = { active: '进行中', achieved: '已达成', dropped: '已终止', archived: '已归档', todo: '待办', in_progress: '进行中', review: '待审', done: '已完成', cancelled: '已取消', online: '已上线', trial: '试运行', draft: '开发中', offline: '已下线' }
    if (found && detail) detail.innerHTML = `<b>${esc(found.data.fullName)}</b><br>${esc(t(found.data.kind))} · ${esc(t(statuses[found.data.status] || found.data.status || '状态未知'))}`
    if (graph && found) { graph.elements().removeClass('selected-node'); graph.getElementById(id).addClass('selected-node') }
  }
  host.querySelectorAll('[data-node]').forEach((button) => button.addEventListener('click', () => selectNode(button.dataset.node)))
  try {
    const cytoscape = await loadLibrary('cytoscape', '../vendor/cytoscape-3.33.1.min.js')
    if (run !== version || !host.isConnected) return
    const container = host.querySelector('#lens-network')
    graph = cytoscape({
      container, elements: [...all.nodes, ...all.edges],
      style: [
        { selector: 'node', style: { label: 'data(label)', 'background-color': 'data(color)', color: '#253e4e', 'font-size': 11, 'text-wrap': 'wrap', 'text-max-width': 92, 'text-valign': 'bottom', 'text-margin-y': 7, width: 26, height: 26, 'border-width': 4, 'border-color': '#fff', 'overlay-opacity': 0 } },
        { selector: 'edge', style: { width: 1.5, 'line-color': '#a8cbd1', 'target-arrow-color': '#a8cbd1', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': .7 } },
        { selector: '.selected-node', style: { 'border-color': '#102d45', 'border-width': 5 } },
      ],
      // 显式边界兼容局域网 HTTP（部分浏览器的 structuredClone 只在安全上下文提供）。
      layout: { name: 'breadthfirst', directed: true, padding: 32, spacingFactor: 1.3, boundingBox: { x1: 0, y1: 0, w: container.clientWidth || 700, h: container.clientHeight || 330 } },
      minZoom: .25, maxZoom: 2,
    })
    graph.on('tap', 'node', (event) => selectNode(event.target.id()))
  } catch (error) {
    console.warn('关系图加载失败', error)
    if (run === version && host.isConnected) host.querySelector('#lens-network').innerHTML = `<div class="lens-empty">${esc(t('图形组件加载失败，可使用右侧节点列表。'))}</div>`
  }
}

/** 只使用记录上存在且端点可见的关系，限制节点数以保持交互流畅。 */
export function buildGraph(goals, projects, issues, agents) {
  const nodes = []
  const edges = []
  const add = (type, list, label, color, nameKey) => {
    for (const item of list) {
      if (nodes.length >= 60) break
      if (!item?.id) continue
      const name = String(item[nameKey] || item.id)
      nodes.push({ data: { id: `${type}:${item.id}`, fullName: name, label: name.length > 12 ? `${name.slice(0, 12)}…` : name, kind: label, color, status: item.status || '' } })
    }
  }
  add('goal', goals, '目标', '#2b86ad', 'title')
  add('project', projects, '项目', '#7e6eca', 'name')
  add('issue', issues, '任务', '#38a487', 'title')
  add('agent', agents, '数字员工', '#d89d44', 'name')
  const ids = new Set(nodes.map((n) => n.data.id))
  const link = (source, target) => { if (ids.has(source) && ids.has(target)) edges.push({ data: { id: `${source}>${target}`, source, target } }) }
  goals.forEach((g) => { if (g.parentGoalId) link(`goal:${g.parentGoalId}`, `goal:${g.id}`) })
  projects.forEach((p) => { if (p.goalId) link(`goal:${p.goalId}`, `project:${p.id}`) })
  issues.forEach((i) => {
    if (i.projectId) link(`project:${i.projectId}`, `issue:${i.id}`)
    if (i.assigneeAgentId) link(`issue:${i.id}`, `agent:${i.assigneeAgentId}`)
  })
  return { nodes, edges }
}

async function drawStatusChart(el, statuses, run) {
  const rows = [['todo', '待办'], ['in_progress', '进行中'], ['review', '待审'], ['done', '已完成'], ['cancelled', '已取消']].map(([key, label]) => ({ label: t(label), value: Number(statuses[key] || 0) }))
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  if (!total) { el.innerHTML = unavailable(); return }
  try {
    const d3 = await loadLibrary('d3', '../vendor/d3-7.9.0.min.js')
    if (run !== version || !el.isConnected) return
    const colors = ['#8ba3b0', '#368db1', '#d4a056', '#20a47d', '#b5b5b5']
    const scale = d3.scaleLinear().domain([0, total]).range([0, 100])
    const svg = d3.select(el).append('svg').attr('viewBox', '0 0 100 7').attr('preserveAspectRatio', 'none').attr('role', 'img').attr('aria-label', rows.map((row) => `${row.label} ${row.value}`).join('，'))
    let offset = 0
    rows.forEach((row, i) => { if (row.value) svg.append('rect').attr('x', scale(offset)).attr('y', 0).attr('width', scale(row.value)).attr('height', 7).attr('fill', colors[i]); offset += row.value })
    d3.select(el).append('div').attr('class', 'lens-chart-legend').selectAll('span').data(rows).join('span').text((row) => `${row.label} ${row.value}`)
  } catch { if (run === version && el.isConnected) el.innerHTML = unavailable() }
}

async function drawTrendChart(el, trend, run) {
  const rows = trend.map((row) => ({ label: String(row.key || '').slice(5), value: Number(row.llmTokens) })).filter((row) => Number.isFinite(row.value))
  if (!rows.length) { el.innerHTML = unavailable(); return }
  try {
    const d3 = await loadLibrary('d3', '../vendor/d3-7.9.0.min.js')
    if (run !== version || !el.isConnected) return
    const width = 500, height = 100
    const x = d3.scalePoint().domain(rows.map((_, i) => i)).range([8, width - 8])
    const y = d3.scaleLinear().domain([0, d3.max(rows, (row) => row.value) || 1]).range([height - 12, 12])
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img').attr('aria-label', rows.map((row) => `${row.label}: ${row.value}`).join('，'))
    svg.append('path').datum(rows).attr('d', d3.area().x((_, i) => x(i)).y0(height - 12).y1((row) => y(row.value))).attr('fill', 'rgba(76,210,190,.12)')
    svg.append('path').datum(rows).attr('d', d3.line().x((_, i) => x(i)).y((row) => y(row.value))).attr('fill', 'none').attr('stroke', '#6ce0c8').attr('stroke-width', 2)
    svg.selectAll('circle').data(rows).join('circle').attr('cx', (_, i) => x(i)).attr('cy', (row) => y(row.value)).attr('r', 3).attr('fill', '#a0f2dc').append('title').text((row) => `${row.label}: ${row.value}`)
    d3.select(el).append('div').attr('class', 'lens-trend-labels').text(`${rows[0].label}                                      ${rows.at(-1).label}`)
  } catch { if (run === version && el.isConnected) el.innerHTML = unavailable() }
}
