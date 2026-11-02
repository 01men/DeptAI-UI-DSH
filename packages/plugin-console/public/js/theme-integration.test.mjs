/** 隔离演示实例 + 控制台真实模块：主题与原有路由的前端功能自测。 */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { JSDOM } from 'jsdom'

const freePort = await new Promise((resolve, reject) => {
  const server = createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  server.on('error', reject)
})
const dataDir = await mkdtemp(join(tmpdir(), 'ybkk-theme-test-'))
const child = spawn(process.execPath, ['--experimental-strip-types', 'src/main.ts', '--port', String(freePort), '--data', dataDir], {
  cwd: process.cwd(), env: { ...process.env, DEMO_MODE: '1', DEMO_SEED: '1', EXEC_HUB_TICK_MS: '600000', EXEC_HUB_FIRST_TICK_MS: '600000' }, stdio: 'ignore',
})
const base = `http://127.0.0.1:${freePort}`
const nativeFetch = globalThis.fetch
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, label) => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await pause(25) }
  assert.fail(`等待失败：${label}`)
}
after(async () => {
  child.kill('SIGTERM')
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), pause(2000)])
  await rm(dataDir, { recursive: true, force: true })
})

test('演示态真实接口、主题切换和工作台导航', async () => {
  await waitFor(async () => { try { return (await nativeFetch(`${base}/api/platform/demo`)).ok } catch { return false } }, '演示实例启动')
  const indexResponse = await nativeFetch(`${base}/`)
  assert.equal(indexResponse.status, 200)
  assert.match(indexResponse.headers.get('content-security-policy'), /script-src 'self'/)
  const dom = new JSDOM(await indexResponse.text(), { url: `${base}/`, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true })
  for (const key of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'MutationObserver', 'CustomEvent', 'Node', 'NodeFilter']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
  localStorage.setItem('rq_lang', 'zh-CN')
  globalThis.fetch = (url, options) => nativeFetch(new URL(String(url), document.baseURI), options)
  // Node 导入模块得到 file: 的 import.meta.url；浏览器中该地址会是同源 HTTP。
  const append = document.head.appendChild.bind(document.head)
  document.head.appendChild = (element) => {
    if (element.tagName === 'SCRIPT' && element.src.startsWith('file:') && element.src.includes('/vendor/')) element.src = `${base}/vendor/${new URL(element.src).pathname.split('/').at(-1)}`
    return append(element)
  }
  for (const file of ['d3-7.9.0.min.js', 'cytoscape-3.33.1.min.js']) {
    const res = await nativeFetch(`${base}/vendor/${file}`)
    assert.equal(res.status, 200, `${file} 应由平台提供`)
    assert.match(res.headers.get('content-type'), /javascript/)
  }
  // 让库仍通过真实 <script> 按需加载；仅把 Cytoscape 的画布渲染器换成 headless。
  let cytoscape
  Object.defineProperty(window, 'cytoscape', { configurable: true, get: () => cytoscape, set: (real) => {
    cytoscape = (opts) => real(window.JSON.parse(JSON.stringify({ elements: opts.elements, layout: opts.layout, headless: true, styleEnabled: false })))
  } })
  await import('./app.js')
  await waitFor(() => document.querySelector('#ui-theme-switcher') && document.querySelector('#dash-tabs button'), '工作台首屏')
  assert.match(document.querySelector('#demo-banner').textContent, /演示模式.*只读/)
  assert.equal(document.querySelectorAll('#dash-tabs button').length, 5)
  assert.equal(document.querySelector('#ui-theme-switcher').options.length, 5)

  const changeTheme = (name) => { const el = document.querySelector('#ui-theme-switcher'); el.value = name; el.dispatchEvent(new window.Event('change', { bubbles: true })) }
  changeTheme('clear')
  await waitFor(() => document.querySelector('#lens-status-chart svg'), 'D3 任务状态图')
  assert.equal(typeof window.d3, 'object')
  assert.ok(document.querySelector('script[src*="d3-7.9.0.min.js"]'))
  document.querySelector('[data-ui-theme-choice="graph"]').click()
  await waitFor(() => document.querySelectorAll('#lens-network, .lens-node-list button').length > 1, '协作图谱')
  await waitFor(() => typeof window.cytoscape === 'function', 'Cytoscape 按需加载')
  assert.ok(document.querySelector('script[src*="cytoscape-3.33.1.min.js"]'))
  assert.equal(document.querySelector('#ui-theme-switcher').value, 'graph')
  assert.equal(document.querySelector('[data-ui-theme-choice="graph"]').getAttribute('aria-pressed'), 'true')
  assert.ok(document.querySelector('.lens-node-list button'))
  document.querySelector('.lens-node-list button').click()
  assert.ok(document.querySelector('#lens-node-detail b'))
  changeTheme('night')
  await waitFor(() => document.querySelector('.lens-night'), '治理观察')
  assert.equal(localStorage.getItem('ybk_console_ui_theme'), 'night')

  changeTheme('crystal')
  await waitFor(() => document.querySelector('.lens-crystal #lens-status-chart svg'), '冰晶真实任务图')
  assert.ok(document.querySelector('.crystal-shortcuts a[href="#/mcp"]'))
  assert.ok(document.querySelector('.crystal-shortcuts a[href="#/connectors"]'))
  location.hash = '#/home'
  // 2026-10-30 首页回退批次：公共产品首页回到「生态树」版（.home，科技蓝配色）——
  // 旧版首页自带导航（无顶栏语言切换器宿主），切换器恢复语义由下方工作台断言覆盖。
  await waitFor(() => document.querySelector('.home .home-nav'), '公共产品首页（生态树版）')
  assert.ok(document.querySelector('.home #home-login-btn'), '首页登录 CTA 在位')
  location.hash = '#/dashboard'
  await waitFor(() => document.querySelector('.lens-crystal'), '回到冰晶工作台')
  assert.ok(document.querySelector('.topbar-right #rq-lang-switcher'), '工作台语言切换器仍可用')
  assert.equal(document.querySelector('#ui-theme-switcher').value, 'crystal')
  changeTheme('night')
  await waitFor(() => document.querySelector('.lens-night'), '切回原治理主题')

  const actions = [...document.querySelectorAll('#dash-tabs button')].find((el) => el.textContent.includes('行动项目'))
  actions.click()
  await waitFor(() => location.hash.includes('tab=actions') && document.querySelector('#dash-tab-body'), '行动项目路由')
  assert.equal(document.querySelector('#ui-theme-switcher').value, 'night')
  location.hash = '#/dashboard'
  await waitFor(() => document.querySelector('.lens-night'), '返回驾驶舱')
  changeTheme('classic')
  await waitFor(() => !document.querySelector('.theme-lens'), '切回经典主题')
  assert.ok(document.querySelector('#dash-tabs'))
  assert.ok(document.querySelector('#demo-banner'))
  clearInterval(window.__updatePoll)
  dom.window.close()
})
