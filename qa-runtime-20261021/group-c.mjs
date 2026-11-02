#!/usr/bin/env node
/**
 * 组C —— 前端展示完整性复测（上一轮 Q-11..Q-19 主战场）
 *
 * 做法：静态对账 + DOM 冒烟（jsdom），不依赖真实浏览器。
 *   C1. 后端 A2A/UHP 端点 → 前端入口覆盖（逐端点列已接/未接 + 占比）
 *   C2. /api/usage/collaborations 前端接线
 *   C3. a2a.js 三语覆盖率（排除 URL/变量等非文案）
 *   C4. 权限态：无 a2a.task.accept 时验收按钮隐藏 + 说明；无 a2a.admin 时规则入口
 *   C5. SSE 实时进度
 *   C6. 加载屏三数与后端真实值绑定
 *   C7. 哈希路由注册 + 页面 builder 冒烟（jsdom）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKit, readGroup, createAsserts } from './kit.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const g = readGroup('C')
const kit = createKit(g.base, g.adminToken)
const { check, summary } = createAsserts('C')
const admin = (await kit.login('admin')).token
kit.setToken(admin)

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const a2aPage = read('packages/plugin-console/public/js/pages/a2a.js')
const appJs = read('packages/plugin-console/public/js/app.js')
const indexHtml = read('packages/plugin-console/public/index.html')

// ---------------------------------------------------------------- C1 端点覆盖
const backendEndpoints = [
  ['GET', '/api/a2a/directory'], ['GET', '/api/a2a/tasks'], ['GET', '/api/a2a/tasks/:taskId'],
  ['POST', '/api/a2a/tasks/:taskId/acceptance'], ['GET', '/api/a2a/fulfillment'],
  ['GET', '/api/a2a/rules'], ['POST', '/api/a2a/rules'], ['DELETE', '/api/a2a/rules/:id'],
  ['POST', '/api/a2a/patrol/run'], ['GET', '/api/a2a/patrols'],
  ['POST', '/api/agents/:slug/a2a'],
  ['GET', '/api/uhp/harnesses'], ['POST', '/api/uhp/harnesses'], ['PATCH', '/api/uhp/harnesses/:id'], ['DELETE', '/api/uhp/harnesses/:id'],
  ['GET', '/api/uhp/responses'],
  ['GET', '/api/usage/collaborations'],
]
const coverage = backendEndpoints.map(([method, path]) => {
  // 端点可能写成模板字符串（/api/a2a/tasks/${id}/acceptance），按路径段特征匹配
  const segments = path.replace(/^\/api\//, '').split('/').filter((seg) => seg && !seg.startsWith(':'))
  const lines = a2aPage.split('\n')
  const hits = lines.map((line, i) => ({ line, no: i + 1 })).filter(({ line }) => segments.every((seg) => line.includes(seg)))
  const direct = hits.length > 0
  const isWrite = method !== 'GET'
  const methodMatched = hits.some(({ line }) => line.includes(`api.${method.toLowerCase()}(`) || line.includes(`api('${method}'`))
  return { method, path, direct, methodMatched: isWrite ? methodMatched : true, firstLine: hits[0]?.no }
})
const unwired = coverage.filter((row) => !row.direct)
check(`C1 后端 A2A/UHP 端点前端接线率（${coverage.length - unwired.length}/${coverage.length}）`,
  unwired.length === 0, JSON.stringify(unwired))
console.log(`     未接端点：${unwired.map((r) => `${r.method} ${r.path}`).join('、') || '无'}`)
check('C1 未接端点占比 ≤ 20%', unwired.length / coverage.length <= 0.2,
  `${unwired.length}/${coverage.length}`)
const methodMismatch = coverage.filter((row) => row.direct && !row.methodMatched)
check('C1 已接端点 HTTP 方法无错配', methodMismatch.length === 0, JSON.stringify(methodMismatch))

// ---------------------------------------------------------------- C2 协作链计量接线
const collabRefs = ['/api/usage/collaborations'].map((needle) =>
  [...a2aPage.split('\n').entries()].filter(([, line]) => line.includes(needle)).map(([i]) => i + 1))
check('C2 /api/usage/collaborations 前端接线（Q-11 重点主缺口）',
  collabRefs[0].length > 0, 'frontend has no reference')
check('C2 协作链区块渲染函数存在（非仅请求）',
  /renderCollaborations|collaboration/i.test(a2aPage), 'no render fn')

// ---------------------------------------------------------------- C3 三语覆盖
function loadLocale(locale) {
  const dir = join(ROOT, 'packages/plugin-console/public/locales', locale)
  const merged = {}
  if (!existsSync(dir)) return merged
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    Object.assign(merged, JSON.parse(readFileSync(join(dir, file), 'utf8')))
  }
  return merged
}
const keysRaw = [...a2aPage.matchAll(/\bt\('((?:[^'\\]|\\.)+)'/g)].map((m) => m[1])
const isCopy = (key) => !key.startsWith('/') && !key.startsWith('api') && !/^[a-z0-9_.:-]+$/i.test(key.replace(/[\s\u4e00-\u9fa5]/g, '')) === false ? true : true
// 过滤明显非文案：URL、纯 ASCII 标识符（如 'tab'、'context' 仍算文案，保留计入缺失便于暴露）
const copyKeys = [...new Set(keysRaw)].filter((k) => !k.startsWith('/') && !k.startsWith('http'))
const enDict = loadLocale('en-US')
const jaDict = loadLocale('ja-JP')
const missEn = copyKeys.filter((k) => !(k in enDict))
const missJa = copyKeys.filter((k) => !(k in jaDict))
check(`C3 a2a.js 文案键总数（${copyKeys.length}）`, copyKeys.length > 0, 'no keys')
check(`C3 en-US 覆盖率 ≥ 95%（缺 ${missEn.length}）`, missEn.length / copyKeys.length <= 0.05,
  JSON.stringify(missEn.slice(0, 12)))
check(`C3 ja-JP 覆盖率 ≥ 95%（缺 ${missJa.length}）`, missJa.length / copyKeys.length <= 0.05,
  JSON.stringify(missJa.slice(0, 12)))
const enDictAll = { ...loadLocale('en-US'), ...loadLocale('en-US') }
const bareEnglish = ['accepted', 'denied', 'completed', 'canceled']
const bareHits = Object.entries(enDict).filter(([k, v]) => bareEnglish.includes(String(v)) && /[\u4e00-\u9fa5]/.test(k))
check('C3 词典无「中文键 → 裸协议词」翻译（如 验收通过→accepted）', bareHits.length === 0,
  JSON.stringify(bareHits.slice(0, 8)))

// ---------------------------------------------------------------- C4 权限态
check('C4 无 a2a.task.accept 权限时验收按钮隐藏（canAccept 判定）',
  /a2a\.task\.accept/.test(a2aPage) && /(canAccept|hasPerm|permissions\.includes)/.test(a2aPage),
  'no permission gate in a2a.js')
check('C4 无权限/非完成态时给出说明文案（而非只隐藏按钮）',
  /A2A_ACCEPT_HINT|无权限|权限不足|不可验收|仅.*验收/.test(a2aPage), 'no explanation copy near accept flow')
check('C4 a2a.admin 规则管理入口有权限判定',
  /a2a\.admin/.test(a2aPage), 'no a2a.admin gate')

// ---------------------------------------------------------------- C5 SSE
const realtimeSrc = read('packages/plugin-console/public/js/realtime.js')
check('C5 平台具备 SSE 传输基建（realtime.js 支持 EventSource + 轮询降级）',
  /EventSource/.test(realtimeSrc), 'no EventSource in realtime.js')
check('C5【体验缺口】a2a 页未接入 SSE，长任务仅一次性快照（Q-15 未修）',
  /EventSource|text\/event-stream/.test(a2aPage), 'a2a page has no SSE; only polling snapshot')

// ---------------------------------------------------------------- C6 加载屏三数
const pluginCount = await kit.api('GET', '/api/platform/info')
const perms = await kit.api('GET', '/api/iam/permissions')
const pluginRows = pluginCount.data?.plugins ?? []
const realPlugins = pluginCount.data?.pluginCount ?? (Array.isArray(pluginRows) ? pluginRows.length : Object.keys(pluginRows).length)
const realPerms = (perms.data?.catalog ?? perms.data?.permissions ?? []).length
const htmlNums = {
  plugins: Number((indexHtml.match(/(\d+)\s*个插件/) ?? [])[1]),
  perms: Number((indexHtml.match(/(\d+)\s*个权限/) ?? [])[1]),
  routes: Number((indexHtml.match(/(\d+)\s*个\s*REST/) ?? [])[1] ?? (indexHtml.match(/(\d+)\s*REST/) ?? [])[1]),
}
check('C6 加载屏插件数与 /api/platform/info 一致', htmlNums.plugins === realPlugins,
  JSON.stringify({ html: htmlNums.plugins, real: realPlugins }))
check('C6 加载屏权限点数与 /api/iam/permissions 一致', htmlNums.perms === realPerms,
  JSON.stringify({ html: htmlNums.perms, real: realPerms }))
const enShell = JSON.parse(readFileSync(join(ROOT, 'packages/plugin-console/public/locales/en-US/10-shell-core.json'), 'utf8'))
const staleStartupKeys = Object.entries(enShell).filter(([k, v]) => /\d+\s*个插件|个权限点|个 REST/.test(String(v)))
check('C6 启动文案词典无历史数字死键（84/85/94 等）',
  staleStartupKeys.length === 0, JSON.stringify(staleStartupKeys.slice(0, 6)))

// ---------------------------------------------------------------- C7 路由与 DOM 冒烟
check('C7 a2a 页面已在 SPA 路由注册表中注册',
  /a2a/.test(appJs) && (/#\/a2a|'a2a'|"a2a"/).test(appJs), 'a2a route not registered')
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: `${g.base}/#/a2a`, pretendToBeVisual: true })
globalThis.document = dom.window.document
globalThis.window = dom.window
globalThis.location = dom.window.location
globalThis.localStorage = dom.window.localStorage
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.NodeFilter = dom.window.NodeFilter
globalThis.Node = dom.window.Node
globalThis.Text = dom.window.Text
try { Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true }) } catch { /* Node 已内置 navigator */ }
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
const pageModule = await import(join(ROOT, 'packages/plugin-console/public/js/pages/a2a.js')).catch((e) => ({ __error: e }))
check('C7 a2a.js 可被 ESM 加载（无语法/顶层错误）', !pageModule.__error, String(pageModule.__error ?? '').slice(0, 200))
const exported = pageModule.__error ? [] : Object.keys(pageModule)
check('C7 a2a.js 导出渲染入口', exported.length > 0, JSON.stringify(exported))

const final = summary()
console.log('\n' + JSON.stringify({ total: final.total, passed: final.passed, failed: final.failed, failures: final.failures }, null, 2))
const fs = await import('node:fs')
fs.writeFileSync(new URL('./result-C.json', import.meta.url), JSON.stringify(final, null, 2))