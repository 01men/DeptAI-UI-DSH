/**
 * DOM 级前端集成冒烟测试：真实服务 + 真实前端模块 + jsdom 事件模拟。
 * 覆盖 2026-08-23 控制台弹窗系统性缺陷的全部回归场景（modal foot 按钮绑定 / TDZ / 双重导航）。
 * 用法：先启动隔离实例（DEMO_SEED=1 node src/main.ts --port 7301 --data data-guitest），
 *       再 SMOKE_BASE=http://127.0.0.1:7301 node tests/dom-smoke.mjs
 */
import { JSDOM, VirtualConsole } from 'jsdom'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:7301'
const REPO = fileURLToPath(new URL('..', import.meta.url))
const RUN_ID = Date.now().toString(36).slice(-5)
const JS_ROOT = join(REPO, 'packages', 'plugin-console', 'public', 'js')

// ---------- jsdom 环境 ----------
const pageErrors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => pageErrors.push(`jsdomError: ${e.message}${e.detail?.stack ? '\n' + e.detail.stack : ''}`))
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: `${BASE}/`, pretendToBeVisual: true, virtualConsole: vc,
})
const { window } = dom
globalThis.document = window.document
globalThis.window = window
globalThis.location = window.location
globalThis.localStorage = window.localStorage
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)

const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => nativeFetch(new URL(String(input), BASE).href, init)
process.on('unhandledRejection', (r) => pageErrors.push(`unhandledRejection: ${r?.stack ?? r}`))

// ---------- 断言工具 ----------
const results = []
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]) } catch (e) { results.push(['FAIL', `${name} — ${e.message}`]) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
async function waitFor(cond, ms = 4000, step = 50) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, step)) }
  return cond()
}
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]
const freshContent = () => { closeModalAll(); document.body.innerHTML = '<div id="content"></div>'; return $('#content') }
const closeModalAll = () => { document.body.innerHTML = '' }
const ctxOf = () => { const ctx = { count: 0, rerender() { ctx.count++ } }; return ctx }
const hasToast = (text) => $$('.toast').some((t) => t.textContent.includes(text))
const modalGone = () => waitFor(() => !$('.modal'))

async function raw(path, { method = 'GET', token, body } = {}) {
  const res = await nativeFetch(new URL(path, BASE).href, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || json?.ok === false) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json?.error ?? '')}`)
  return json?.data
}
const P = (p) => import(pathToFileURL(join(JS_ROOT, p)).href)

// ---------- 登录（admin 会话贯穿 UI 模块；ops 仅经 raw 发起审批） ----------
const { api, session } = await P('api.js')
const login = await raw('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Ybk@2026' } })
session.save(login.token, login.user)
if (login.refreshToken) session.saveRefresh(login.refreshToken)

// 演示种子在启动后异步落盘（void seedAll），健康检查先亮、Agent 面晚数秒就绪——
// 不等待会让 T3/T4 间歇拿到空列表（2026-10-14 观测：健康就绪后 0~1.5s 内才可见）。等齐再跑。
{
  const deadline = Date.now() + 30_000
  for (;;) {
    const agents = await raw('/api/agents', { token: login.token }).then((d) => d.agents, () => [])
    if (agents.length >= 5) break
    if (Date.now() > deadline) throw new Error(`演示种子 30s 未就绪（agents=${agents.length}），检查 DEMO_SEED=1 与数据目录`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

// ================= 场景 =================

await test('T1 工作台渲染 + 快捷入口点击跳转（dashboard.js:79 回归）', async () => {
  const { renderDashboard } = await P('pages/dashboard.js')
  await renderDashboard(freshContent(), new URLSearchParams(), ctxOf())
  assert($('#dash-goto-agents'), '快捷入口按钮存在')
  $('#dash-goto-agents').click()
  assert(location.hash === '#/agents', `点击后 hash 应为 #/agents，实际 ${location.hash}`)
  location.hash = ''
})

await test('T2 confirmDialog 取消/必填原因/确认（ui.js:177 回归）', async () => {
  const ui = await P('ui.js')
  const p1 = ui.confirmDialog({ title: '冒烟', message: 'x' })
  assert($('.modal'), '确认弹窗应出现')
  $('#dlg-cancel').click()
  assert(await modalGone(), '取消按钮应关闭弹窗')
  assert((await p1) === null, '取消应 resolve null')
  const p2 = ui.confirmDialog({ title: '冒烟', message: 'x', requireReason: true, danger: true })
  $('#dlg-ok').click()
  assert($('.modal'), '原因为空时弹窗应保持打开')
  assert(hasToast('操作原因'), '原因为空应提示')
  $('#dlg-reason').value = '冒烟测试：模拟高危操作原因'
  $('#dlg-ok').click()
  assert(await modalGone(), '确认按钮应关闭弹窗')
  const r2 = await p2
  assert(r2?.ok === true && r2.reason === '冒烟测试：模拟高危操作原因', `确认应 resolve ok+reason，实际 ${JSON.stringify(r2)}`)
})

await test('T3 审批中心 驳回弹窗真实执行（approvals.js:117/127 回归）', async () => {
  // 保证存在 pending 审批：由 ops 发起 Agent 下线（发起人 ops ≠ 审批人 admin）
  let pendings = (await api.get('/api/approvals')).approvals.filter((a) => a.status === 'pending')
  if (!pendings.length) {
    const ops = await raw('/api/auth/login', { method: 'POST', body: { username: 'ops', password: 'Ybk@2026' } })
    const agents = (await raw('/api/agents', { token: ops.token })).agents
    const online = agents.find((a) => a.status === 'online')
    assert(online, '演示数据中应存在在线 Agent')
    await raw(`/api/agents/${online.id}/transition`, { method: 'POST', token: ops.token, body: { action: 'offline', note: '冒烟测试：发起下线审批' } })
    pendings = (await api.get('/api/approvals')).approvals.filter((a) => a.status === 'pending')
    assert(pendings.length, 'ops 发起下线后应生成待审批单')
  }
  const { renderApprovals } = await P('pages/approvals.js')
  const ctx = ctxOf()
  await renderApprovals(freshContent(), new URLSearchParams(), ctx)
  const rejectBtn = $('[data-reject]')
  assert(rejectBtn, '待审批卡片应有驳回按钮')
  const targetId = rejectBtn.dataset.reject
  rejectBtn.click()
  assert($('.modal') && $('.modal [data-ok]'), '审批意见弹窗应打开（此前 openModal 未定义直接报错）')
  $('.modal textarea[name=opinion]').value = '冒烟测试：驳回意见'
  $('.modal [data-ok]').click()
  assert(await modalGone(), '提交后弹窗应关闭')
  assert(await waitFor(() => ctx.count > 0), '应触发列表刷新 rerender')
  const decided = (await api.get('/api/approvals')).approvals.find((a) => a.id === targetId)
  assert(decided?.status === 'rejected', `服务端审批单应已驳回，实际 ${decided?.status}`)
})

await test('T4 Agent 详情抽屉打开（agents.js:161 TDZ 回归）', async () => {
  const { renderAgents } = await P('pages/agents.js')
  await renderAgents(freshContent(), new URLSearchParams(), ctxOf())
  const card = $('#agent-list [data-id]')
  assert(card, 'Agent 列表应有卡片')
  card.click()
  assert(await waitFor(() => $('.drawer')), '点击卡片应打开详情抽屉（此前 TDZ 报错打不开）')
  $('.drawer-close').click()
  assert(await waitFor(() => !$('.drawer')), '抽屉应可关闭')
})

await test('T5 注册 Agent 弹窗 取消/真实创建（agents.js:378 回归）', async () => {
  const { renderAgents } = await P('pages/agents.js')
  await renderAgents(freshContent(), new URLSearchParams(), ctxOf())
  $('#agent-add').click()
  assert(await waitFor(() => $('.modal [data-cancel]')), '注册弹窗应打开且取消按钮可寻址')
  $('.modal [data-cancel]').click()
  assert(await modalGone(), '取消按钮应关闭弹窗（此前 null.onclick 报错）')
  $('#agent-add').click()
  const nameInput = await waitFor(() => $('.modal [name=name]')) && $('.modal [name=name]')
  assert(nameInput, '名称输入框应存在（缺失将导致服务端 slug 生成崩溃）')
  nameInput.value = '冒烟测试Agent-' + RUN_ID
  $('.modal [name=attr_description]').value = '冒烟测试描述'
  const modelSel = $('.modal select[name=attr_model]')
  if (modelSel?.options.length) modelSel.value = modelSel.options[0].value
  const riskSel = $('.modal select[name=attr_riskLevel]')
  if (riskSel?.options.length) riskSel.value = riskSel.options[0].value
  $('.modal [data-ok]').click()
  assert(await waitFor(() => $$('.modal').some((x) => x.textContent.includes('client_secret'))), '注册成功应展示机器凭证弹窗（仅一次）')
  $$('.modal').find((x) => x.textContent.includes('client_secret')).querySelector('[data-ok]').click()
  assert(await modalGone(), '「完成」按钮应关闭凭证弹窗')
  const agents = (await api.get('/api/agents')).agents
  assert(agents.some((a) => a.name === '冒烟测试Agent-' + RUN_ID), '服务端应真实创建该 Agent')
})

await test('T6 Skill 安装弹窗（skills.js:224 回归）', async () => {
  const { renderSkills } = await P('pages/skills.js')
  await renderSkills(freshContent(), new URLSearchParams(), ctxOf())
  const card = $('[data-id]')
  assert(card, 'Skill 市场应有卡片')
  card.click()
  assert(await waitFor(() => $('.drawer')), 'Skill 详情抽屉应打开')
  const installBtn = $('#sk-install')
  if (!installBtn) { results.push(['SKIP', 'T6a 当前 Skill 无安装按钮（状态不允许），跳过安装弹窗']); $('.drawer-close').click(); return }
  installBtn.click()
  assert(await waitFor(() => $('.modal [data-cancel]')), '安装弹窗应打开')
  $('.modal [data-cancel]').click()
  assert(await modalGone(), '取消按钮应关闭弹窗（此前 null.onclick 报错）')
  $('.drawer-close').click()
})

await test('T7 MCP 灰度发布 + dry-run 链路（mcp.js:286/295/298 回归）', async () => {
  const { renderMcp } = await P('pages/mcp.js')
  await renderMcp(freshContent(), new URLSearchParams(), ctxOf())
  const card = $('#mcp-cards [data-id]')
  assert(card, 'MCP 服务卡片应存在')
  card.click()
  assert(await waitFor(() => $('.drawer')), '服务详情抽屉应打开')
  const grayBtn = $('#svc-gray')
  if (!grayBtn) { results.push(['SKIP', 'T7 当前服务状态无灰度按钮，跳过灰度弹窗']); $('.drawer-close').click(); return }
  grayBtn.click()
  assert(await waitFor(() => $('.modal [data-dryrun]')), '灰度发布弹窗应打开且含预演按钮')
  $('.modal [data-dryrun]').click()
  assert(await waitFor(() => hasToast('dry-run') || $$('.modal').some((m) => m.textContent.includes('影响面预演'))), 'dry-run 应返回影响面弹窗')
  const dryModal = $$('.modal').find((m) => m.textContent.includes('影响面预演'))
  if (dryModal) {
    dryModal.querySelector('[data-ok]').click()
    assert(await waitFor(() => $('.modal [data-dryrun]')), '知道了应回到灰度弹窗（链式重开）')
  }
  $('.modal [data-cancel]')?.click()
  assert(await modalGone(), '取消应关闭灰度弹窗')
  $('.drawer-close').click()
})

await test('T8 MCP 接入向导 上一步/下一步（mcp.js:325 回归）', async () => {
  const { renderMcp } = await P('pages/mcp.js')
  await renderMcp(freshContent(), new URLSearchParams(), ctxOf())
  $('#mcp-deploy-wizard').click()
  assert(await waitFor(() => $('#wiz-next')), '向导弹窗应打开且下一步按钮可寻址（此前 null.onclick 报错）')
  const srcCard = $('[data-source="template"]')
  assert(srcCard, '向导第一步应有来源卡片')
  srcCard.click()
  $('#wiz-next').click()
  assert(await waitFor(() => $('.wiz-step.done')), '选择来源后下一步应推进到第二步')
  $('#wiz-prev').click()
  assert(await waitFor(() => !$('.wiz-step.done')), '上一步应回退')
  $('.modal-mask')?.click()
  assert(await modalGone(), '向导应可关闭')
})

await test('T9 MCP 权限组弹窗（mcp.js:519 回归）', async () => {
  const { renderMcp } = await P('pages/mcp.js')
  await renderMcp(freshContent(), new URLSearchParams(), ctxOf())
  $('#mcp-permgroups').click()
  assert(await waitFor(() => $('#pg-add')), '权限组抽屉应打开')
  $('#pg-add').click()
  assert(await waitFor(() => $('.modal [data-cancel]')), '新建权限组弹窗应打开')
  $('.modal [data-cancel]').click()
  assert(await modalGone(), '取消应关闭弹窗（此前 null.onclick 报错）')
  $('.drawer-close').click()
})

await test('T10 IAM 创建账号全流程 + 口令展示弹窗（iam/members.js 回归）', async () => {
  const { renderIam } = await P('pages/iam/index.js')
  await renderIam(freshContent(), new URLSearchParams('tab=members'), ctxOf())
  $('#user-add').click()
  assert($('.modal [data-ok]'), '创建账号弹窗应打开')
  $('.modal [name=displayName]').value = '冒烟测试账号'
  $('.modal [name=username]').value = 'smoke' + RUN_ID
  // UI-04 整改后组织选择为可搜索选择器：点开展示框 → 等待选项列表 → 点选第一个非空选项
  $('.modal [data-ss-display]').click()
  assert(await waitFor(() => $('.modal .searchable-select.open .searchable-select-item')), '组织选择器应展开选项列表')
  const orgItem = $$('.modal .searchable-select.open .searchable-select-item').find((el) => el.dataset.value)
  assert(orgItem, '组织选项列表应有可选项')
  orgItem.click()
  assert($('.modal [name=orgId]').value, '点选后隐藏字段应写入组织 ID')
  $('.modal [data-ok]').click()
  assert(await waitFor(() => $('#cred-password')), '创建成功后应展示凭据弹窗（用户名+口令，仅一次）')
  assert($('#cred-password').textContent.length >= 8, '初始口令应为随机强口令')
  $('#cred-password').closest('.modal').querySelector('[data-cancel]').click()
  assert(await modalGone(), '「我已妥善传达」应关闭口令弹窗')
  const users = (await api.get('/api/iam/users')).users
  assert(users.some((u) => u.username === 'smoke' + RUN_ID), '服务端应真实创建该账号')
})

await test('T11 IAM 新建组织 / 批量导入弹窗（iam/groups.js 回归）', async () => {
  const { renderIam } = await P('pages/iam/index.js')
  await renderIam(freshContent(), new URLSearchParams('tab=members'), ctxOf())
  $('#org-add').click()
  assert(await waitFor(() => $('.modal [data-ok]')), '新建组织弹窗应打开')
  $('.modal [name=name]').value = '冒烟测试组织-' + RUN_ID
  $('.modal [data-ok]').click()
  assert(await modalGone(), '创建后弹窗应关闭（此前 null.onclick 报错）')
  $('#user-import').click()
  assert(await waitFor(() => $('.modal [data-cancel]')), '批量导入弹窗应打开')
  $('.modal [data-cancel]').click()
  assert(await modalGone(), '取消应关闭导入弹窗')
})

await test('T12 审计 新建告警规则（audit.js:180 回归）', async () => {
  const { renderAudit } = await P('pages/audit.js')
  const ctx = ctxOf()
  await renderAudit(freshContent(), new URLSearchParams('tab=rules'), ctx)
  $('#rule-add').click()
  assert($('.modal [data-ok]'), '新建规则弹窗应打开')
  $('.modal [name=name]').value = '冒烟测试规则'
  $('.modal [data-ok]').click()
  assert(await modalGone(), '创建后弹窗应关闭（此前 null.onclick 报错）')
  assert(await waitFor(() => ctx.count > 0), '应触发刷新')
  const rules = (await api.get('/api/audit/alert-rules')).rules ?? (await api.get('/api/audit/alert-rules'))
  assert(JSON.stringify(rules).includes('冒烟测试规则'), '服务端应真实创建规则')
})

await test('T13 应用注册弹窗（apps.js:296 回归）', async () => {
  const { renderApps } = await P('pages/apps.js')
  await renderApps(freshContent(), new URLSearchParams(), ctxOf())
  $('#app-add').click()
  assert(await waitFor(() => $('.modal [data-cancel]')), '注册应用弹窗应打开')
  $('.modal [data-cancel]').click()
  assert(await modalGone(), '取消应关闭弹窗')
})

await test('T14 认证中心 签发凭证弹窗（authn.js:126 回归）', async () => {
  const { renderAuthn } = await P('pages/authn.js')
  await renderAuthn(freshContent(), new URLSearchParams(), ctxOf())
  $('#authn-credential').click()
  // 弹窗打开前需异步拉取可绑定资源与授权目录，等待打开
  assert(await waitFor(() => $('.modal [data-ok]')), '签发凭证弹窗应打开')
  $('.modal [name=name]').value = 'external:smoke-test'
  // 授权选择器为必填（至少选机器角色、附加权限点或 *）；冒烟走 '*' 全权限分支
  $('.modal #authz-star').click()
  $('.modal [data-ok]').click()
  assert(await waitFor(() => $$('.modal').some((m) => m.textContent.includes('client_secret'))), '签发后应展示凭证（仅一次）')
  const credModal = $$('.modal').find((m) => m.textContent.includes('client_secret'))
  credModal.querySelector('[data-ok]').click()
  assert(await modalGone(), '「已保存」按钮默认关闭行为应生效')
})

// ================= 汇总 =================
const passed = results.filter(([s]) => s === 'PASS').length
const failed = results.filter(([s]) => s === 'FAIL')
const skipped = results.filter(([s]) => s === 'SKIP')
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
for (const [status, name] of results) {
  const icon = { PASS: '✔', FAIL: '✘', SKIP: '–' }[status]
  console.log(`  ${icon} [${status}] ${name}`)
}
if (pageErrors.length) {
  console.log('\n—— 页面异常 ——')
  for (const e of pageErrors) console.log('  ' + e.split('\n')[0])
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`DOM 冒烟结果：${passed}/${results.length} 通过` + (skipped.length ? `（${skipped.length} 跳过）` : ''))
if (failed.length || pageErrors.length) { console.log('存在失败 ✘'); process.exit(1) }
console.log('全部通过 ✔')
