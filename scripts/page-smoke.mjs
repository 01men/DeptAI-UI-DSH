/**
 * 全页面渲染冒烟（设计适配 2026-10-14）：逐页调用控制台 SPA 全部 builder，
 * 断言渲染不抛错、产出非空、页头/关键结构在位——覆盖 dom-smoke 未及的新页面
 * （gateway/usage/access/assets 六类台账/skills 市场/dashboard 五 tab/iam 各 tab）。
 * 用法：先启动隔离实例（DEMO_SEED=1 node src/main.ts --port 7301 --data data-guitest），
 *       再 SMOKE_BASE=http://127.0.0.1:7301 node scripts/page-smoke.mjs
 */
import { JSDOM, VirtualConsole } from 'jsdom'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:7301'
const REPO = fileURLToPath(new URL('..', import.meta.url))
const JS_ROOT = join(REPO, 'packages', 'plugin-console', 'public', 'js')

const pageErrors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => pageErrors.push(`jsdomError: ${e.message}`))
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: `${BASE}/`, pretendToBeVisual: true, virtualConsole: vc,
})
const { window } = dom
globalThis.document = window.document
globalThis.window = window
globalThis.location = window.location
globalThis.localStorage = window.localStorage
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
// 页面模块在 Node 侧按 ESM 直接 import 执行，其内部引用的是全局 MutationObserver
// （jsdom 只把它挂在 window 上，不注入 globalThis）→ 不注入会让 31 个页面用例
// 全部以「MutationObserver is not defined」失败，等于本门禁静默失效（基线 1/31）。
// MutationObserver 只在 window 上存在，这里直接透传，不做行为打桩。
globalThis.MutationObserver = window.MutationObserver
// 同理：i18n.js 遍历文本节点用 NodeFilter（jsdom 只挂 window），缺失会产生
// unhandledRejection 让门禁判红。
globalThis.NodeFilter = window.NodeFilter
globalThis.Node = window.Node
globalThis.Text = window.Text
// 语言钉死 zh-CN：本用例的断言匹配的是中文界面文案（如「万 tokens/成本」「接入管理」），
// 而 i18n.js 的 effectiveLocale() 读的是**全局** navigator（页面模块按 ESM 在 Node 侧执行，
// 不经过 window），Node 22 内置 navigator.language = en-US，会让 i18n 走翻译分支把界面
// 翻成英文导致误判红。产品默认语言本就是 zh-CN（偏好 > 浏览器语言 > zh-CN），此处与产品对齐。
Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true })
Object.defineProperty(window.navigator, 'languages', { value: ['zh-CN'], configurable: true })
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN', languages: ['zh-CN'], userAgent: window.navigator.userAgent },
  configurable: true,
  writable: true,
})
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => nativeFetch(new URL(String(input), BASE).href, init)
// jsdom 无 canvas 包：给营销页的背景 canvas 打桩（真实浏览器不受影响）
window.HTMLCanvasElement.prototype.getContext = () => ({ setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, fillRect() {}, save() {}, restore() {} })
// jsdom 无 IntersectionObserver：营销页懒加载观察器打桩（立即触发一次回调）
globalThis.IntersectionObserver = window.IntersectionObserver = class {
  constructor(cb) { this.cb = cb }
  observe(el) { this.cb([{ isIntersecting: true, target: el }], this) }
  unobserve() {} disconnect() {}
}
process.on('unhandledRejection', (r) => pageErrors.push(`unhandledRejection: ${r?.stack ?? r}`))

const results = []
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]) } catch (e) { results.push(['FAIL', `${name} — ${e.message}`]) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
async function waitFor(cond, ms = 6000, step = 60) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, step)) }
  return cond()
}
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]
const freshContent = () => { document.body.innerHTML = '<div id="content"></div>'; return $('#content') }
const ctxOf = () => { const ctx = { count: 0, rerender() { ctx.count++ } }; return ctx }
async function raw(path, { method = 'GET', token, body } = {}) {
  const res = await nativeFetch(new URL(path, BASE).href, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || json?.ok === false) throw new Error(`${method} ${path} → ${res.status}`)
  return json?.data
}
const P = (p) => import(pathToFileURL(join(JS_ROOT, p)).href)

const login = await raw('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Ybk@2026' } })
const { api, session } = await P('api.js')
session.save(login.token, login.user)
if (login.refreshToken) session.saveRefresh(login.refreshToken)

/** 渲染一页并断言：不抛错 + content 有实际产出（>200 字符）+ 无空白占位泄漏。 */
async function renderPage(modulePath, exportName, params = new URLSearchParams(), expect) {
  const mod = await P(modulePath)
  const builder = mod[exportName]
  assert(builder, `${modulePath} 缺少导出 ${exportName}`)
  const content = freshContent()
  await builder(content, params, ctxOf())
  const html = content.innerHTML
  assert(html.length > 200, `渲染产出过短（${html.length} 字符）——疑似半成品或空页`)
  if (expect) for (const [desc, fn] of expect) assert(fn(content, { $, $$ }), `期望未满足：${desc}`)
  return content
}

// ================= 设计适配新页面 =================
await test('P01 模型网关 gateway：路由卡 + Stat + 渠道链', async () => {
  await renderPage('pages/gateway.js', 'renderGateway', new URLSearchParams(), [
    ['Stat 指标卡', (c) => !!c.querySelector('.stat-card, .stat-value')],
    ['路由/模型信息', (c) => /路由|渠道|model/i.test(c.textContent)],
  ])
})
await test('P02 用量与成本 usage：图表 + 维度切换', async () => {
  const content = await renderPage('pages/usage.js', 'renderUsage', new URLSearchParams(), [
    ['SVG 图表', (c) => !!c.querySelector('svg')],
  ])
  assert(/万 tokens|成本/i.test(content.textContent), '应呈现 tokens/成本口径文案')
})
await test('P03 资产台账 assets：六类过滤 + 台账表', async () => {
  const content = await renderPage('pages/assets.js', 'renderAssets', new URLSearchParams(), [
    ['过滤胶囊', (c) => (c.textContent.match(/全部|MCP|Agent|应用|Skill|模型|NAS/g) ?? []).length >= 3],
  ])
  assert(await waitFor(() => /mcp:|agent:|app:|skill:|model:|nas:/.test($('#content').textContent), 8000), '台账应呈现资源键')
})
await test('P04 Skill 市场 skills：市场卡片结构', async () => {
  await renderPage('pages/skills.js', 'renderSkills', new URLSearchParams())
  // 技能卡片的类名是 .res-card；.card 只有热力图区块（依赖 usage 数据）才有——
  // 只断言 .card 会让本用例随夹具的计量数据有无而红绿（QA 2026-10-21 P04 复现）。
  assert(await waitFor(() => $$('.res-card').length >= 1, 8000), '市场卡片应渲染（.res-card）')
})
await test('P05 平台接入 access：三 tab', async () => {
  const content = await renderPage('pages/access.js', 'renderAccess', new URLSearchParams(), [
    ['tab 结构', (c) => /接入管理|宿主连接|连接器/.test(c.textContent)],
  ])
})
await test('P06 审批中心 approvals：左右布局 + 决策按钮钩子', async () => {
  await renderPage('pages/approvals.js', 'renderApprovals', new URLSearchParams())
  assert(await waitFor(() => !!$('[data-reject], [data-approve], #ap-reject') || /等待审批|暂无|没有待办/.test($('#content').textContent), 8000), '审批操作位或空态应在位')
})
// A2A 协作页（QA 2026-10-21 P2-06：新增页面此前未进 page-smoke，五 tab 零覆盖）
for (const tab of ['directory', 'tasks', 'fulfillment', 'rules', 'uhp']) {
  await test(`P06b A2A 协作 a2a${tab === 'directory' ? '' : `?tab=${tab}`}：页面结构 + 数据面接线`, async () => {
    const content = await renderPage('pages/a2a.js', 'renderA2a', new URLSearchParams({ tab }), [
      ['页头标题', (c) => /A2A 协作/.test(c.textContent)],
      ['tab 导航', (c) => c.querySelectorAll('#a2a-tabs .tab').length >= 4],
    ])
    const bodyFirst = content.querySelector('#a2a-body')?.textContent ?? ''
    // 数据面接线：各 tab 的核心区块必须真实渲染（不能只吐页头空壳）
    const probe = {
      directory: () => /协作目录|自治级别|没有匹配|搜索员工/.test($('#a2a-body')?.textContent ?? ''),
      tasks: () => /任务追踪|全部目标员工|暂无协作任务|通配|任务/.test($('#a2a-body')?.textContent ?? ''),
      fulfillment: () => /数字员工|接收|完成率|暂无协作履约/.test($('#a2a-body')?.textContent ?? ''),
      rules: () => /审批规则|规则名称|暂无审批规则|关键词/.test($('#a2a-body')?.textContent ?? ''),
      uhp: () => /执行体|UHP|harness|执行记录/.test($('#a2a-body')?.textContent ?? ''),
    }[tab]
    assert(await waitFor(probe, 9000), `${tab} 区块应渲染（body=${bodyFirst.slice(0, 80)}）`)
  })
}

// ================= 工作台五 tab =================
for (const [tab, hint] of [['', '总览'], ['cockpit', '经营'], ['goals', '目标'], ['actions', '行动'], ['collab', '协作'], ['ops', '平台运行']]) {
  await test(`P07 工作台 dashboard${tab ? `?tab=${tab}` : ''}：${hint}`, async () => {
    const params = tab ? new URLSearchParams({ tab }) : new URLSearchParams()
    await renderPage('pages/dashboard.js', 'renderDashboard', params)
    assert(await waitFor(() => $('#content').innerHTML.length > 600, 9000), '工作台内容应渲染')
  })
}

// ================= 企业域与专项页 =================
for (const [mod, name, params] of [
  ['pages/iam/index.js', 'renderIam', new URLSearchParams()],
  ['pages/iam/index.js', 'renderIam', new URLSearchParams({ tab: 'roles' })],
  ['pages/iam/index.js', 'renderIam', new URLSearchParams({ tab: 'connectors' })],
  ['pages/audit.js', 'renderAudit', new URLSearchParams()],
  ['pages/audit.js', 'renderAudit', new URLSearchParams({ tab: 'alerts' })],
  ['pages/finops.js', 'renderFinops', new URLSearchParams()],
  ['pages/agents.js', 'renderAgents', new URLSearchParams()],
  ['pages/apps.js', 'renderApps', new URLSearchParams()],
  ['pages/mcp.js', 'renderMcp', new URLSearchParams()],
  ['pages/nas.js', 'renderNas', new URLSearchParams()],
  ['pages/nas-authz.js', 'renderNasAuthz', new URLSearchParams()],
  ['pages/authn.js', 'renderAuthn', new URLSearchParams()],
  ['pages/connectors.js', 'renderConnectors', new URLSearchParams()],
  ['pages/panels.js', 'renderPanels', new URLSearchParams()],
  ['pages/platform.js', 'renderPlatform', new URLSearchParams()],
  ['pages/exec.js', 'renderExec', new URLSearchParams()],
  ['pages/connect.js', 'renderConnect', new URLSearchParams()],
  ['pages/home.js', 'renderHome', new URLSearchParams()],
  ['pages/login.js', 'renderLogin', new URLSearchParams()],
]) {
  await test(`P08 ${name} ${mod.split('/').pop()}${params.get('tab') ? `?tab=${params.get('tab')}` : ''}`, async () => {
    // connect.js 是路由兼容薄壳（design-adaptation-spec §5.9）：只改 hash 不产出内容
    if (mod === 'pages/connect.js') {
      const { renderConnect } = await P(mod)
      const content = freshContent()
      location.hash = ''
      await renderConnect(content, params, ctxOf())
      assert(location.hash.includes('#/access'), `薄壳应改写 hash 跳 access，实际 ${location.hash}`)
      return
    }
    await renderPage(mod, name, params)
  })
}

// ================= 汇总 =================
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
for (const [status, name] of results) console.log(`  ${status === 'PASS' ? '✔ [PASS]' : '✘ [FAIL]'} ${name}`)
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const failed = results.filter(([s]) => s === 'FAIL')
console.log(`页面冒烟结果：${results.length - failed.length}/${results.length} 通过`)
if (pageErrors.length) console.log('页面级 jsdom 错误：\n' + pageErrors.slice(0, 5).join('\n'))
if (failed.length || pageErrors.length) { console.log('存在失败 ✘'); process.exit(1) }
console.log('全部通过 ✔')
