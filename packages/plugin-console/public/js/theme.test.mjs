/** 控制台主题：真实 DOM/模块与本地 D3、Cytoscape 数据模型的集成自测。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><head></head><body><div class="topbar-right"></div><div id="switch"></div><main id="content"></main></body></html>', {
  url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
})
for (const key of ['window', 'document', 'navigator', 'localStorage', 'location', 'MutationObserver', 'CustomEvent', 'Node', 'NodeFilter']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
localStorage.setItem('rq_lang', 'zh-CN')

const overview = { agents: { total: 1 }, approvals: { pending: 2 }, costTrend: [{ key: '2026-10-01', llmTokens: 12 }, { key: '2026-10-02', llmTokens: 30 }] }
const exec = { goals: 2, projects: 1, issuesByStatus: { todo: 1, done: 1 }, kpis: { callsToday: 3, tokensToday: 42, risk: { critical: 1, warning: 2 } }, insight: { text: '系统运行正常' } }
let calls = []
let allowed = ['console.read', 'exec.read', 'agent.read', 'audit.read', 'approval.read', 'workforce.read']
const payloads = {
  '/api/exec/overview': exec,
  '/api/workforce/overview': { employees: 3 },
  '/api/exec/goals': { goals: [{ id: 'g1', title: '目标一' }, { id: 'g2', title: '子目标', parentGoalId: 'g1' }] },
  '/api/exec/projects': { projects: [{ id: 'p1', name: '项目一', goalId: 'g2' }] },
  '/api/exec/issues': { issues: [{ id: 'i1', title: '<img src=x onerror=alert(1)>', projectId: 'p1', assigneeAgentId: 'a1', status: 'todo' }] },
  '/api/agents': { agents: [{ id: 'a1', name: '执行官', status: 'online' }] },
}
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: options.method || 'GET' })
  const data = payloads[String(url)]
  return { ok: data !== undefined, status: data === undefined ? 404 : 200, json: async () => ({ ok: data !== undefined, data }) }
}
window.eval(await readFile(new URL('../vendor/d3-7.9.0.min.js', import.meta.url), 'utf8'))
window.eval(await readFile(new URL('../vendor/cytoscape-3.33.1.min.js', import.meta.url), 'utf8'))
const actualCytoscape = window.cytoscape
let lastGraph
// jsdom 没有 canvas；用相同 Cytoscape 内核的 headless 模式验证元素与事件。
window.cytoscape = (opts) => { lastGraph = actualCytoscape(window.JSON.parse(JSON.stringify({ elements: opts.elements, layout: opts.layout, headless: true, styleEnabled: false }))); return lastGraph }
const { session } = await import('./api.js')
const { mountThemeSwitcher, replayUiTheme, UI_THEME_KEY } = await import('./theme.js')
const { mountThemeLens, buildGraph } = await import('./theme-lens.js')
session.enterDemo({ name: '演示访客', get readonlyPermissions() { return allowed } })
const waitFor = async (predicate) => {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)) }
  assert.fail('等待界面状态超时')
}
const select = (theme) => {
  const picker = document.querySelector('#ui-theme-switcher')
  picker.value = theme
  picker.dispatchEvent(new window.Event('change', { bubbles: true }))
}

// 合并在一个场景中验证真实切换事件与异步渲染，不依赖实现私有函数。
test('五套主题切换、保留偏好、真实关联、图表、权限与降级', async () => {
  document.documentElement.dataset.platform = 'strategy'
  replayUiTheme()
  assert.equal(document.documentElement.dataset.uiTheme, 'classic')
  mountThemeSwitcher(document.querySelector('#switch'))
  const picker = document.querySelector('#ui-theme-switcher')
  assert.equal(picker.options.length, 5)
  const host = document.querySelector('#content')
  mountThemeLens(host, overview)
  assert.equal(host.textContent, '')

  select('clear')
  await waitFor(() => host.querySelector('#lens-status-chart svg'))
  assert.match(host.textContent, /让每一次 AI 协作都有迹可循/)
  assert.match(host.textContent, /待办 1/)
  assert.equal(localStorage.getItem(UI_THEME_KEY), 'clear')
  assert.equal(document.documentElement.dataset.platform, 'strategy')
  document.documentElement.dataset.uiTheme = 'classic'
  replayUiTheme()
  assert.equal(document.documentElement.dataset.uiTheme, 'clear')

  select('graph')
  await waitFor(() => host.querySelectorAll('[data-node]').length === 5 && lastGraph?.nodes().length === 5)
  assert.equal(lastGraph.edges().length, 4)
  assert.equal(host.querySelectorAll('img').length, 0, '不应将业务名称作为 HTML 执行')
  host.querySelector('[data-node="agent:a1"]').click()
  assert.match(host.querySelector('#lens-node-detail').textContent, /执行官/)
  assert.match(host.querySelector('#lens-node-detail').textContent, /已上线/)
  assert.match(host.textContent, /不代表实际调用/)

  select('night')
  await waitFor(() => host.querySelector('#lens-trend-chart svg'))
  assert.equal(lastGraph.destroyed(), true)
  assert.match(host.textContent, /系统运行正常/)
  assert.match(host.querySelector('#lens-trend-chart svg').getAttribute('aria-label'), /10-02: 30/)
  assert.ok(host.querySelector('a[href="#/audit?tab=alerts"]'))

  select('crystal')
  await waitFor(() => host.querySelector('.lens-crystal #lens-status-chart svg'))
  assert.match(host.textContent, /让数字员工协同/)
  assert.equal(host.querySelector('[data-crystal-scene]').dataset.renderer, 'static')
  assert.equal(localStorage.getItem(UI_THEME_KEY), 'crystal')
  assert.ok(host.querySelector('a[href="#/home"]'))
  assert.equal(host.querySelectorAll('.crystal-kpis strong')[1].textContent, '3', '数字员工指标取 workforce 员工档案，不混用 Agent 登记数')
  assert.equal(host.querySelector('a[href="#/mcp"]'), null, '缺少服务读权限，不显示能力入口')

  select('classic')
  assert.equal(host.textContent, '')
  allowed = ['console.read']
  calls = []
  select('graph')
  await waitFor(() => /没有查看权限/.test(host.textContent))
  assert.equal(calls.length, 0, '无 exec.read 时不得请求受限接口')
  select('night')
  await waitFor(() => host.querySelector('.lens-night'))
  assert.equal(host.querySelector('a[href="#/approvals"]'), null)
  assert.equal(host.querySelector('a[href="#/audit?tab=alerts"]'), null)
  select('crystal')
  await waitFor(() => host.querySelector('.lens-crystal'))
  assert.equal(host.querySelectorAll('.crystal-operation-grid a').length, 0)
  assert.ok([...host.querySelectorAll('.crystal-kpis strong')].every((el) => el.textContent === '—'), '无权限时不把不可见指标伪装成零')
  allowed = ['console.read', 'usage.read']
  select('crystal')
  await waitFor(() => host.querySelector('.lens-crystal'))
  assert.equal(host.querySelector('a[href="#/gateway"]'), null, '模型入口必须具备模型和面板读取权限')
  assert.ok(calls.every((c) => c.method === 'GET'))
  select('classic')
})

test('图谱只连接存在的外键端点并截断超大数据', () => {
  const result = buildGraph([{ id: 'g', title: 'G', parentGoalId: 'missing' }], [{ id: 'p', name: 'P', goalId: 'g' }], [{ id: 'i', title: 'I', projectId: 'missing', assigneeAgentId: 'missing' }], [])
  assert.equal(result.nodes.length, 3)
  assert.equal(result.edges.length, 1)
  const limited = buildGraph(Array.from({ length: 70 }, (_, i) => ({ id: String(i), title: String(i) })), [], [], [])
  assert.equal(limited.nodes.length, 60)
})
