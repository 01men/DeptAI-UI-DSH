/**
 * 行业 AI 工作台（IAW Workbench，2026-09-11 改版）：五空间信息架构
 * （协作 collab / 图谱 map / 执行 flow / 能力 cap / 数据 data——协作首位 2026-09-11 用户裁决）
 * + 行业主题引擎（14 行业 data-industry 令牌覆盖）+ 场景详情抽屉。
 * 协作空间在场时右侧 Agent 协作栏自动收起（同一会话只留一个协作窗口）。
 *
 * 一切数据来自 /api/panel/* 与 /api/dingtalk/*；XSS 白名单渲染；SSE 优先 + 轮询降级
 * （realtime.js 复用）；演示态/远端形态/会话过期等既有服务行为全部保留。
 * 设计来源：WorkBuddy 原型 + 《行业 AI 工作台 PRD v1.0》（IAW-DS 设计系统）。
 * 原则：不做假数据、不放空占位入口——未实现的能力登记在 docs/handoff-iaw-gaps-to-main.md，
 * 界面上诚实缺席。唯一例外是行业演示预览（2026-09-11 用户需求）：locked/pending 行业
 * 进入只读预览——图谱为真实预置数据，会话/任务为图谱确定性派生的演示数据且全部带
 * 「演示」徽标（previewMessages/previewTasks），写操作 / 调用 / 交互一律拦截（previewLocked）。
 */
import { api, session, setBase as apiSetBase, ApiError } from './api.js'
import { setBase as depsSetBase, ui as uiDep, realtime as realtimeDep } from './deps.js'
// 制造工具箱空间（自「制造业 AI 工具集」并入，2026-10-19）：视图 + 导航清单 + 抽屉清理
import { MFG_NAV, mfgNavBadges, renderMfgView, closeMfgDrawer, showMfgSettings } from './mfg.js'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function esc(text) {
  // 引号一并转义（QA BUG-U-06）：本函数大量输出进 HTML 属性位（data-* / title），
  // 不转义双引号=用户可控值可在属性内闭合注入事件（存储型 XSS）。
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 白名单渲染（治理 DoD：XSS 面）：先全量转义，再仅放行 <b> 与 mention span——
 * 服务端种子/Agent 产出的轻标记可渲染，任何其他 HTML 一律按文本显示。
 */
export function md(text) {
  let s = esc(text)
  s = s.replaceAll('&lt;b&gt;', '<b>').replaceAll('&lt;/b&gt;', '</b>')
  s = s.replaceAll(`&lt;span class=&#39;mention&#39;&gt;`, '<span class="mention">')
  s = s.replaceAll('&lt;span class=&quot;mention&quot;&gt;', '<span class="mention">')
  s = s.replaceAll(`&lt;span class='mention'&gt;`, '<span class="mention">')
  s = s.replaceAll('&lt;span class="mention"&gt;', '<span class="mention">')
  s = s.replaceAll('&lt;/span&gt;', '</span>')
  s = s.replace(/(^|[\s（(])@([\p{L}\p{N}·]{2,20})/gu, '$1<span class="mention">@$2</span>')
  return s
}

const pad2 = (n) => String(n).padStart(2, '0')
/** 本地时区展示（QA BUG-U-01）：不直接切片 UTC ISO 串。 */
const fmtTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
/** 评级展示（PRD：四档制，五星为扩展位；>4 按真值入 title、按 4 渲染避免破格）。 */
const stars = (n) => {
  const v = Math.max(1, Math.min(4, Number(n) || 1))
  return `<span class="iaw-stars" title="现状评级 ${n}/4（四档制）">${'★'.repeat(v)}<span class="off">${'★'.repeat(4 - v)}</span></span>`
}
const TAG_CLS = { 降本: 'iaw-pill-cost', 提质: 'iaw-pill-quality', 增效: 'iaw-pill-eff', 增收: 'iaw-pill-rev', 安全: 'iaw-pill-safety', 环保: 'iaw-pill-eco', 新模式: 'iaw-pill-new', 节能: 'iaw-pill-eff' }
const TAG_ORDER = ['降本', '提质', '增效', '增收', '安全', '环保', '节能', '新模式']
const tagPill = (t) => `<span class="iaw-pill ${TAG_CLS[t] ?? 'iaw-pill-neutral'}">${esc(t)}</span>`
const LANE_LABELS = { todo: '待办', doing: '进行中', review: '待审', done: '完成' }
const LANE_ORDER = ['todo', 'doing', 'review', 'done']
const ACT_LABELS = { rd: '研发设计', mfg: '生产制造', scm: '供应链管理', svc: '运维服务', mkt: '数字营销', mgmt: '经营管理', fin: '法财税与成本' }
const ACT_CODE = { rd: 1, mfg: 2, scm: 5, svc: 3, mgmt: 4, mkt: 6, fin: 7 }
const PLATFORM_LABELS = { strategy: '战略', marketing: '营销', manufacturing: '制造', rd: '研发', quality: '质量' }
/** 行业徽标字（行业码 → 单字；顶栏/行业菜单用）。 */
const IND_AB = { YB01: '钢', SH01: '化', JB01: '工', QC01: '车', JB02: '机', WS01: '医', QB01: '电', QB02: '糖', QB03: '酒', QB04: '妆', SJ01: '锂', SJ02: '板', SJ03: '端', WJ01: '爆', GCJX: '工' }
const IND_COLOR = { YB01: '#FF6B1A', SH01: '#0B7A75', JB01: '#F5A800', QC01: '#1668E3', JB02: '#3B4A63', WS01: '#00857C', QB01: '#2F80ED', QB02: '#B5651D', QB03: '#B0702F', QB04: '#D9548C', SJ01: '#1E5EFF', SJ02: '#0B7A4B', SJ03: '#6C4CF1', WJ01: '#E8541E', GCJX: '#F5A800' }

const $id = (id) => document.getElementById(id)

function basePath() {
  const index = location.pathname.indexOf('/panel')
  return index > 0 ? location.pathname.slice(0, index) : ''
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const state = {
  hostBridge: false,
  /** 演示态（plan-gate01 决策 2）：宿主连接为 none 时展示内置演示数据横幅。 */
  demoMode: false,
  /** 远端宿主连接（形态 C）：{ hubBase, hubMountPrefix }；null=本机/未连接。 */
  remoteHub: null,
  /** 五空间导航：协作首位（2026-09-11 用户裁决）；space=collab/map/flow/cap/data；nav=空间内视图。#/board 深链 → cockpit。 */
  space: 'collab',
  nav: 'rooms',
  depts: [],
  dept: localStorage.getItem('panel_dept') ?? 'mfg',
  overview: null,
  industries: [],
  industry: null,
  /** 用户显式选择行业后置真：部门总览的默认行业不再覆盖用户选择（服务端默认只作用一次）。 */
  industryPinned: false,
  /** 行业演示预览（locked/pending 行业只读可看）：内置图谱 + 确定性演示会话/任务，写操作全拦。 */
  industryDemo: false,
  scenegraph: null,
  /** 罗盘状态：环节（links key）过滤 + 价值标签过滤。 */
  thread: 'ALL',
  tagFilter: new Set(),
  channelId: localStorage.getItem('panel_channel') ?? '',
  messages: [],
  tasks: [],
  artifacts: [],
  board: null,
  boardPlatform: localStorage.getItem('panel_board_platform') ?? '',
  ddStatus: null,
  bridges: [],
  ddSync: localStorage.getItem('panel_ddsync') === '1',
  /** dws 激活弹窗每页面加载至多自动弹一次（用户关闭后不缠人，顶栏 ⇄ 随时可再开）。 */
  ddPromptShown: false,
  /** 模型目录（modelgw 事实源 / dsh 配置桥只读）；chatModel='' 表示跟随各 Agent 资产配置。 */
  models: [],
  modelSource: '',
  chatModel: localStorage.getItem('panel_chat_model') ?? '',
  /** 可直调技能清单（skillhub published 且对当前账号组织开放；空=不展示技能入口）。 */
  skills: [],
  /** Agent 协作栏形态：panel=面板会话（默认）；dsh=内嵌 dsh 标准对话（hostBridge 在场时）。 */
  railMode: localStorage.getItem('iaw_rail_mode') ?? 'panel',
  /** 场景抽屉当前场景编码 + tab。 */
  scene: null,
  sceneTab: 0,
  /** 通知中心事件流（stream/poll 到达的系统级动态，内存环形，最多 100 条）。 */
  notices: [],
  /** 协作栏常驻态之外的对比选择（场景对比视图）：最多 3 个场景编码。 */
  compare: [],

  /** 钉钉拉取（dws CLI 入向）：自动轮播定时器句柄。 */
  ddPullTimer: null,
  stream: null,
  streamDept: '',
  /** 实时通道健康：downgraded=轮询降级态；stale=轮询连续失败（数据可能过期）。 */
  streamDowngraded: false,
  streamStale: false,
  lastRealtimeAt: 0,
}

/** 嵌套防护（M3）：?embed=1（dsh「01门工作台」视图 Tab 内嵌本面板）或自身已在 iframe 中。 */
const EMBEDDED = new URLSearchParams(location.search).has('embed') || (() => {
  try { return window.self !== window.top } catch { return true }
})()

function canEmbedDshChat() {
  return state.hostBridge && !EMBEDDED
}

async function toast(message, type) {
  const mod = await uiDep()
  mod.toast(message, type)
}

/** 富通知（右侧滑入卡：标题 + 正文 + 级联色）。 */
function richToast(title, body, type) {
  const host = $id('iawToasts')
  if (!host) { void toast(body || title, type === 'warn' ? 'error' : type); return }
  const el = document.createElement('div')
  el.className = `t ${type ?? ''}`
  el.innerHTML = `<div class="h">${esc(title)}<span class="x">✕</span></div><div>${body}</div>`
  el.querySelector('.x').onclick = () => el.remove()
  host.appendChild(el)
  while (host.children.length > 4) host.removeChild(host.firstChild)
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320) }, 5200)
}

/**
 * 模态骨架幂等创建（2026-10-29 修复）。
 *
 * 骨架原只在 init() 里插入，而**未登录路径**（renderLoginGuide）不经过 init()——
 * 此时点「本页登录」→ showModal() → $id('mask') 为 null → TypeError，
 * 页面被全局错误处理器接管成「加载出现异常，请刷新重试」，登录入口直接不可用。
 * 现改为：showModal 前置 ensureModalSkeleton()，init() 亦复用同一函数（不重复插入）。
 */
function ensureModalSkeleton() {
  if ($id('mask')) return
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-mask" id="mask">
      <div class="modal">
        <div class="modal-h"><span class="t" id="modalTitle"></span><span class="x" id="modalX">✕</span></div>
        <div class="modal-b" id="modalBody"></div>
      </div>
    </div>`)
  $id('modalX').onclick = hideModal
  $id('mask').addEventListener('click', (event) => {
    if (event.target.id === 'mask') hideModal()
  })
}

function showModal(title, bodyHtml) {
  ensureModalSkeleton()
  $id('modalTitle').textContent = title
  $id('modalBody').innerHTML = bodyHtml
  $id('mask').classList.add('show')
}

function hideModal() {
  stopDdLoginPoll()
  $id('mask')?.classList.remove('show')
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

export function start({ base, hostBridge = false, remoteHub = null, demoMode = false }) {
  apiSetBase(base)
  depsSetBase(base)
  state.hostBridge = hostBridge
  state.remoteHub = remoteHub
  state.demoMode = demoMode
  if (!session.token && !demoMode) {
    renderLoginGuide()
    return
  }
  if (location.hash === '#/board') { state.space = 'map'; state.nav = 'cockpit' }
  renderShell()
  window.addEventListener('hashchange', () => {
    if (location.hash === '#/board') { state.space = 'map'; state.nav = 'cockpit'; renderNav(); renderView() }
  })
  // 会话中途过期（QA BUG-U-05）：api.js 刷新失败即广播，此处统一切回登录引导
  window.addEventListener('panel:session-expired', () => {
    if ($id('app')?.dataset.booted) renderLoginGuide()
  })
  // 通道健康看门狗（QA BUG-U-02）：轮询降级态下超过 95s 无任何数据到达 →「连接中断」
  window.setInterval(() => {
    if (!state.streamDowngraded || state.streamStale) {
      if (!state.streamDowngraded && state.streamStale) { state.streamStale = false; renderStatus() }
      return
    }
    if (state.lastRealtimeAt > 0 && Date.now() - state.lastRealtimeAt > 95_000) {
      state.streamStale = true
      renderStatus()
    }
  }, 15_000)
  void init()
}

function renderLoginGuide() {
  // 远端连接态（形态 C）：会话失效时回到连接向导重连/重登
  if (state.remoteHub) {
    $id('app').innerHTML = `
      <div class="login-guide">
        <h1>🌳 01门 · 行业 AI 工作台</h1>
        <p>与远端宿主（${esc(state.remoteHub.hubBase)}）的会话已失效。</p>
        <button class="btn primary" id="reopenWizard">重新连接 / 登录</button>
      </div>`
    $id('reopenWizard').onclick = async () => {
      const wizard = await import('./wizard.js')
      wizard.start({ base: basePath(), hostBridge: state.hostBridge })
    }
    return
  }
  // 回跳语义：登录成功后带 next（绝对 URL）回到面板（G1 票据分支，boot.js 兑换建会话）；
  // 尾斜杠不能省：/gate01 不带斜杠会触发 302，把 #fragment 与 next 参数一并吃掉。
  const here = encodeURIComponent(location.origin + location.pathname + location.search + location.hash)
  $id('app').innerHTML = `
    <div class="login-guide">
      <h1>🌳 01门 · 行业 AI 工作台</h1>
      <p>当前浏览器没有有效的平台会话。<br>
      可直接在本页登录（账号密码），或从控制台登录后进入${state.hostBridge ? '（dsh 宿主在侧：主界面提供宿主会话直通）' : ''}。</p>
      <button class="btn primary" id="loginHere">本页登录</button>
      ${state.hostBridge
        ? '<button class="btn" id="loginConsole">打开宿主主界面</button>'
        : `<a href="${basePath()}/?next=${here}#/login"><button class="btn">去控制台登录</button></a>`}
    </div>`
  $id('loginHere').onclick = () => showLoginModal()
  $id('loginConsole')?.addEventListener('click', () => { location.href = '/' })
}

/**
 * 本页登录（2026-09-11 用户裁决）：演示态/装态不再被「去控制台」死链困住——
 * 面板自持登录面（/api/panel/auth/login，authn 在场即可用；全量形态经 console 公开白名单放行）。
 * 登录成功整页刷新重走 boot 链（会话/权限一次就位）。
 */
function showLoginModal() {
  showModal('🔐 登录行业 AI 工作台', `
    <p class="note" style="margin-top:0">使用平台账号登录（与控制台/宿主同一账号体系）。首次部署：管理员账号 admin，初始口令见服务器数据目录 admin-initial-password.txt。</p>
    <div style="display:flex;flex-direction:column;gap:10px">
      <input type="text" id="iawLoginUser" placeholder="账号" autocomplete="username">
      <input type="password" id="iawLoginPass" placeholder="密码" autocomplete="current-password">
      <div id="iawLoginErr" class="wz-err" style="color:var(--danger-600);font-size:12px;min-height:16px"></div>
      <button class="btn primary" id="iawLoginGo">登录</button>
    </div>`)
  const submit = async () => {
    const button = $id('iawLoginGo')
    const err = $id('iawLoginErr')
    err.textContent = ''
    button.disabled = true
    try {
      const payload = await api.post('/api/panel/auth/login', {
        username: $id('iawLoginUser').value.trim(),
        password: $id('iawLoginPass').value,
      })
      session.save(payload.token, payload.user)
      if (payload.refreshToken) session.saveRefresh(payload.refreshToken)
      hideModal()
      window.location.reload()
    } catch (error) {
      err.textContent = error.message
      button.disabled = false
    }
  }
  $id('iawLoginGo').onclick = () => void submit()
  for (const id of ['iawLoginUser', 'iawLoginPass']) {
    $id(id).addEventListener('keydown', (event) => { if (event.key === 'Enter') void submit() })
  }
}

async function init() {
  ensureModalSkeleton()
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeDrawer(); $id('iawIndMenu')?.classList.remove('open') }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      void openCmdk()
    }
  })

  try {
    const [deptsRes, indRes] = await Promise.all([api.get('/api/panel/depts'), api.get('/api/panel/industries')])
    state.depts = deptsRes.depts
    state.industries = indRes.industries
    const allowedDepts = state.depts.filter((dept) => dept.allowed !== false)
    if (!allowedDepts.some((dept) => dept.id === state.dept)) state.dept = allowedDepts[0]?.id ?? state.dept
    state.industry = state.industries.find((item) => item.state === 'active') ?? null
    // 用户上一次显式选择的行业（会话级持久化）：仍处于激活态才恢复；
    // 即使与默认行业相同也要钉住——否则部门总览默认值会在 switchDept 覆盖用户选择
    const savedIndustry = localStorage.getItem('iaw_industry')
    if (savedIndustry) {
      const saved = state.industries.find((item) => item.code === savedIndustry && item.state === 'active')
      if (saved) { state.industry = saved; state.industryPinned = true }
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      session.clear()
      renderLoginGuide()
      return
    }
    $id('app').innerHTML = `<div class="login-guide"><h1>面板数据加载失败</h1><p>${esc(error.message)}</p></div>`
    return
  }

  void refreshDingtalk()
  await refreshModels()
  await loadSkills()
  await switchDept(state.dept, { keepSpace: true })
  connectStream()
}

async function refreshDingtalk() {
  // 双源探测（2026-09-11 起本地 dws 面全形态注册）：宿主桥在场且身份已绑 → 宿主态（行为不变）；
  // 宿主绑定缺席（桥缺席的装态，或桥在场但未绑）→ 本地 dws 面兜底——用户可不经宿主平台直接用自家钉钉。
  let status = null
  let bridges = []
  try {
    const [hostStatus, hostBridges] = await Promise.all([api.get('/api/dingtalk/status'), api.get('/api/dingtalk/bridges')])
    status = hostStatus
    bridges = hostBridges.bridges
  } catch { /* 宿主桥缺席（01门装态）→ 走本地面 */ }
  if (!status?.bound) {
    try {
      const dwsStatus = await api.get('/api/panel/ddws/status')
      if (!status?.bound) { status = dwsStatus; bridges = [] }
    } catch { /* 本地面也不可用 → 维持现状（可能全 null） */ }
  }
  state.ddStatus = status
  state.bridges = bridges
  renderTopRight()
  maybePromptDdActivation()
  scheduleDdPull()
}

/**
 * 01门装态（dws 桥）激活弹窗（2026-09-11 用户需求：未登录或未绑定就弹激活指令）：
 * 进入面板后首次刷新即弹（每页面加载至多一次，用户关掉不缠人）；演示态只读不弹。
 */
function maybePromptDdActivation() {
  if (state.ddPromptShown || state.demoMode) return
  const dd = state.ddStatus
  if (dd?.via !== 'dws-cli') return
  const needLogin = Boolean(dd.auth && !dd.auth.authenticated)
  const unbound = !dd.bound
  if (!needLogin && !unbound) return
  if ($id('mask')?.classList.contains('show')) return
  state.ddPromptShown = true
  void showBind()
}

/** 模型目录（GET /api/panel/models）：失败时置空（协作栏退化为「未接入模型」提示）。 */
async function refreshModels() {
  try {
    const payload = await api.get('/api/panel/models')
    state.models = payload.models ?? []
    state.modelSource = payload.source ?? ''
  } catch {
    state.models = []
    state.modelSource = ''
  }
}

/** 可直调技能清单：拿不到就置空——不展示技能入口，不假装可用。 */
async function loadSkills() {
  try {
    state.skills = (await api.get(`/api/panel/${state.dept}/skills`)).skills ?? []
  } catch {
    state.skills = []
  }
}

// ---------------------------------------------------------------------------
// 实时通道（SSE 优先 + 轮询降级；复用 realtime.js）
// stream URL 首选一次性短时 ticket（POST /api/panel/stream-ticket，消费即焚）；
// 轮询连续失败 ≥3 轮 →「连接中断·点击重试」；成功自愈自动恢复。
// ---------------------------------------------------------------------------

const POLL_FAIL_BADGE_THRESHOLD = 3

function connectStream() {
  if (state.stream && state.streamDept === state.dept) return
  if (state.stream) { try { state.stream.close() } catch { /* 已关闭 */ } }
  state.streamDept = state.dept
  state.streamDowngraded = false
  state.streamStale = false
  state.lastRealtimeAt = Date.now()
  renderStatus()
  const remote = Boolean(state.remoteHub)
  const streamBase = remote ? `${basePath()}/rqcard/proxy` : basePath()
  const headers = session.token ? { authorization: `Bearer ${session.token}` } : {}
  if (remote && session.token) headers['x-rqcard-call'] = '1'
  void (async () => {
    let url = `${streamBase}/api/panel/stream?dept=${state.dept}&token=${encodeURIComponent(session.token)}`
    try {
      const ticket = await api.post('/api/panel/stream-ticket', { dept: state.dept })
      if (ticket?.ticket) url = `${streamBase}/api/panel/stream?dept=${state.dept}&ticket=${encodeURIComponent(ticket.ticket)}`
    } catch { /* 票据面不可用：回落 token 通道 */ }
    state.stream = (await realtimeDep()).createEventStream({
      url,
      pollPath: `${streamBase}/api/panel/${state.dept}/poll`,
      pollIntervalMs: 30_000,
      headers,
      onMessage: (data) => { renderStatus(); handleRealtime(data) },
      onDowngrade: () => {
        state.streamDowngraded = true
        renderStatus()
      },
      onPollError: (_error, info) => {
        if (info.consecutiveFailures >= POLL_FAIL_BADGE_THRESHOLD) renderStatus('down')
      },
    })
    renderStatus()
  })().catch(() => { /* realtime 依赖装载失败：静默，消息刷新退化为操作后手动拉取 */ })
}

/** 手动重连：「连接中断」点击后重建通道并给观察窗。 */
function reconnectStream() {
  if (state.stream) { try { state.stream.close() } catch { /* 已关闭 */ } }
  state.stream = null
  state.streamDept = ''
  state.lastRealtimeAt = Date.now()
  connectStream()
}

async function handleRealtime(data) {
  state.lastRealtimeAt = Date.now()
  if (state.streamStale) {
    state.streamStale = false
    renderStatus()
  }
  if (!data || typeof data !== 'object') return
  if (data.name === 'panel.message.created' && data.payload) {
    const payload = data.payload
    if (payload.dept !== state.dept) return
    pushNotice(`💬 ${payload.senderName ?? '有人'} 在协作频道发了新消息`)
    if (payload.channelId !== state.channelId) { void refreshOverview(); return }
    if (state.messages.some((m) => m.id === payload.messageId)) return
    try {
      const detail = await api.get(`/api/panel/${state.dept}/messages?channelId=${payload.channelId}&limit=20`)
      const fresh = detail.messages.filter((m) => !state.messages.some((x) => x.id === m.id))
      if (fresh.length > 0) {
        state.messages.push(...fresh)
        renderConversation($id('iawMsgs'))
        renderConversation($id('iawRoomsMsgs'))
        void refreshOverview()
      }
    } catch { /* 下轮轮询兜底 */ }
    return
  }
  if (data.name === 'panel.task.updated' || data.name === 'scenegraph.updated' || data.name === 'panel.industry.activated') {
    pushNotice(data.name === 'scenegraph.updated' ? '🗺 场景图谱已更新'
      : data.name === 'panel.industry.activated' ? '✅ 行业激活已生效'
        : '📌 任务有更新')
    if (data.name === 'scenegraph.updated') { state.scenegraph = null }
    await refreshOverview()
    if (['flow', 'map', 'collab'].includes(state.space)) await loadViewData()
    renderView()
    return
  }
  if (data.messages) {
    // 轮询降级应答：整体刷新消息与任务
    const fresh = data.messages.filter((m) => m.channelId === state.channelId && !state.messages.some((x) => x.id === m.id))
    if (fresh.length > 0) {
      state.messages.push(...fresh)
      renderConversation($id('iawMsgs'))
      renderConversation($id('iawRoomsMsgs'))
    }
    if (JSON.stringify(data.tasks) !== JSON.stringify(state.tasks)) {
      state.tasks = data.tasks
      if (state.space === 'flow' || state.nav === 'cockpit') renderView()
    }
  }
}

function pushNotice(text) {
  state.notices.unshift({ at: new Date().toISOString(), text })
  if (state.notices.length > 100) state.notices.pop()
  renderTopRight()
}

// ---------------------------------------------------------------------------
// 外壳渲染（IAW-DS：顶栏 / 三栏 / 事务流条 / 状态栏）
// ---------------------------------------------------------------------------

const SPACE_META = {
  // 协作首位（2026-09-11 用户裁决）：进入工作台即对话，频道会话即主界面
  collab: { label: '协作', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0112 0"/><path d="M16 5.5a3 3 0 010 5M18.5 20a6 6 0 00-3-5.2"/></svg>' },
  map: { label: '图谱', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="9" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.3 7.4l7.3 1.2M7.2 8.2l1.3 7.4M16.4 10.9l-5.6 5.6"/></svg>' },
  flow: { label: '执行', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/><path d="M6.5 10v4.5a2 2 0 002 2H14"/></svg>' },
  cap: { label: '能力', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>' },
  data: { label: '数据', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>' },
  // 制造工具箱空间（2026-10-19 并入「制造业 AI 工具集」）：工具广场 / 场景图谱 / 收藏 / 记录。
  // 交互框架沿用本工作台（视图路由 + api.js 出口 + ui.js 组件），视觉语言取自并入源项目。
  mfg: { label: '制造', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M3 20h18"/><path d="M5 20V9l5 3V9l5 3V5l4 3v12"/><path d="M9 20v-4h4v4"/></svg>' },
}

function navDef() {
  const pack = state.scenegraph?.pack
  const sceneCount = pack ? Object.values(pack.activities).reduce((sum, list) => sum + list.length, 0) : 0
  const linksCount = pack ? (pack.links ?? []).length : 0
  const toolCount = pack ? new Set(Object.values(pack.activities).flat().flatMap((s) => s.tools)).size : 0
  const modelCount = pack ? new Set(Object.values(pack.activities).flat().flatMap((s) => s.models)).size : 0
  const talentCount = pack ? new Set(Object.values(pack.activities).flat().flatMap((s) => s.talent)).size : 0
  const dataCount = pack ? new Set(Object.values(pack.activities).flat().flatMap((s) => s.data)).size : 0
  const inboxCount = activeTasks().filter((t) => t.lane !== 'done' && (t.assigneeName === session.user?.displayName || t.lane === 'review')).length
  const unread = (state.overview?.channels ?? []).reduce((sum, c) => sum + (c.unread ?? 0), 0)
    + activeTasks().filter((t) => t.lane === 'review').length
  return {
    map: [
      ['compass', '场景罗盘', '◎', sceneCount ? String(sceneCount) : ''],
      ['thread', '主线贯通', '⛓', linksCount ? String(linksCount) : ''],
      ['compare', '场景对比', '≡', state.compare.length ? String(state.compare.length) : ''],
      ['cockpit', '度量驾驶舱', '▤', ''],
      ['roadmap', '转型路线图', '⇥', ''],
    ],
    flow: [
      ['flow', '全部任务', '▦', activeTasks().length ? String(activeTasks().length) : ''],
      ['inbox', '我的收件箱', '☞', inboxCount ? String(inboxCount) : ''],
    ],
    cap: [
      ['mchannels', '模型渠道', '◈', state.models.length ? String(state.models.length) : ''],
      ['tools', '工具软件', '⚙', toolCount ? String(toolCount) : ''],
      ['kmodels', '知识模型', '☣', modelCount ? String(modelCount) : ''],
      ['talent', '人才技能', '❋', talentCount ? String(talentCount) : ''],
    ],
    data: [
      ['elements', '数据要素', '❖', dataCount ? String(dataCount) : ''],
    ],
    collab: [
      ['rooms', '协作频道', '#', (state.overview?.channels ?? []).length ? String((state.overview?.channels ?? []).length) : ''],
      ['agents', '数字同事', '☻', (state.overview?.dept?.agents ?? []).length ? String((state.overview?.dept?.agents ?? []).length) : ''],
      ['members', '成员', '☰', ''],
      ['notice', '通知中心', '✦', unread ? String(unread) : ''],
    ],
    // 制造工具箱空间：视图与徽标由 mfg.js 提供（模块级状态，随空间重入保持）
    mfg: MFG_NAV.map(([key, label, glyph, badge]) => [
      key, label, glyph,
      key === 'graph' ? (mfgNavBadges().graph ?? badge) : (mfgNavBadges()[key] ?? badge),
    ]),
  }
}

function renderShell() {
  $id('app').innerHTML = `
    ${state.demoMode ? `
    <div id="demoBanner" class="demo-banner">
      <span>🧪 当前展示的是<b>内置演示数据</b>（只读）——登录后解锁发消息、派任务等写操作</span>
      <button class="btn" id="demoLogin">登录</button>
      <button class="btn primary" id="demoOpenWizard">连接宿主</button>
    </div>` : ''}
    <div id="iawPreviewBar"></div>
    <div class="iaw-app" id="iawApp" data-industry="${esc(state.industry?.code ?? '')}">
      <header class="iaw-topbar">
        <div class="iaw-logo">IAW</div>
        <div class="iaw-brand">行业 AI 工作台<small>Industry AI Workbench</small></div>
        <div class="iaw-ind">
          <button class="iaw-ind-btn" id="iawIndBtn">
            <span class="iaw-ind-dot"></span><span id="iawIndName">${esc(state.industry?.name ?? '未激活行业')}</span><span class="caret">▾</span>
          </button>
          <div class="iaw-ind-menu" id="iawIndMenu"></div>
        </div>
        <div class="iaw-search" id="iawSearch" title="全局搜索（场景 / 要素 / 任务 / 频道 / 同事）">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-tertiary);flex:none"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input id="iawSearchInput" placeholder="搜索场景、要素、任务，或输入命令">
          <span class="iaw-kbd">Ctrl K</span>
        </div>
        <div class="iaw-top-right" id="iawTopRight"></div>
      </header>
      <div class="iaw-body">
        <nav class="iaw-side">
          <div class="iaw-seg" id="iawSeg"></div>
          <div class="iaw-nav-group" id="iawNavGroup"></div>
          <div class="iaw-side-foot" id="iawSideFoot"></div>
        </nav>
        <main class="iaw-main" id="iawMain"></main>
        <aside class="iaw-agent" id="iawAgent"></aside>
      </div>
      <div class="iaw-flowbar" id="iawFlowbar"></div>
      <div class="iaw-statusbar" id="iawStatusbar"></div>
      <div class="iaw-toasts" id="iawToasts"></div>
      <div id="mfgDrawer"></div>
    </div>`
  $id('demoOpenWizard')?.addEventListener('click', async () => {
    const wizard = await import('./wizard.js')
    wizard.start({ base: basePath() })
  })
  $id('demoLogin')?.addEventListener('click', () => showLoginModal())
  $id('iawIndBtn').onclick = (event) => { event.stopPropagation(); renderIndMenu(); $id('iawIndMenu').classList.toggle('open') }
  document.addEventListener('click', () => $id('iawIndMenu')?.classList.remove('open'))
  $id('iawSearchInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    const q = event.target.value.trim()
    if (q) void searchJump(q)
  })
  $id('iawSearch').onclick = (event) => {
    if (event.target.id !== 'iawSearchInput') void openCmdk()
  }
  renderSeg()
  renderNav()
  renderTopRight()
  renderAgentRail()
  renderStatus()
}

function renderSeg() {
  const seg = $id('iawSeg')
  if (!seg) return
  seg.innerHTML = Object.entries(SPACE_META).map(([key, meta]) => `
    <button class="${state.space === key ? 'on' : ''}" data-space="${key}" title="${meta.label}">${meta.icon}<span>${meta.label}</span></button>`).join('')
  seg.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      state.space = btn.dataset.space
      state.nav = null
      renderSeg()
      renderNav()
      void refreshView()
    }
  })
}

function renderNav() {
  const group = $id('iawNavGroup')
  if (!group) return
  const defs = navDef()
  if (!defs[state.space].some((n) => n[0] === state.nav)) state.nav = defs[state.space][0][0]
  const label = { collab: '协作空间', map: '图谱空间', flow: '执行空间', cap: '能力空间', data: '数据空间', mfg: '制造工具箱空间' }[state.space]
  group.innerHTML = `<div class="iaw-nav-title">${label} · ${esc(state.industry?.name ?? '未激活')}</div>` +
    defs[state.space].map((n) => `
      <button class="iaw-nav-item ${state.nav === n[0] ? 'on' : ''}" data-nav="${n[0]}">
        <span class="iaw-nav-ic">${n[2]}</span><span>${n[1]}</span>${n[3] ? `<span class="cnt">${n[3]}</span>` : ''}
      </button>`).join('')
  group.querySelectorAll('.iaw-nav-item').forEach((el) => {
    el.onclick = () => {
      state.nav = el.dataset.nav
      renderNav()
      void refreshView()
    }
  })
  renderSideFoot()
}

function renderSideFoot() {
  const foot = $id('iawSideFoot')
  if (!foot) return
  const pack = state.scenegraph?.pack
  const sceneCount = pack ? Object.values(pack.activities).reduce((sum, list) => sum + list.length, 0) : 0
  foot.innerHTML = `
    <div>数据源：<b>一图四清单</b>（工信部 2025 版）</div>
    <div>场景节点 <b>${sceneCount}</b> · 渠道 <b>${state.models.length}</b> · 数字同事 <b>${(state.overview?.dept?.agents ?? []).length}</b></div>
    ${state.overview?.org ? `<div>组织：<b>${esc(state.overview.org.name)}</b></div>` : ''}
    <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">
      ${session.can('panel.config.write') ? '<a href="javascript:void 0" id="iawCfgLink">面板配置</a>' : ''}
      ${state.space === 'mfg' ? '<a href="javascript:void 0" id="iawMfgCfgLink">工具箱设置</a>' : ''}
      ${consoleJumpLink()}
    </div>`
  // 显式跨工作台切换：记住去向（控制台启动分诊尊重该偏好，不再把人拽回面板）
  foot.querySelectorAll('[data-landing]').forEach((el) => {
    el.addEventListener('click', () => {
      try { localStorage.setItem('gate01_landing', el.dataset.landing) } catch { /* 忽略 */ }
    })
  })
  $id('iawCfgLink')?.addEventListener('click', () => void showConfig())
  $id('iawMfgCfgLink')?.addEventListener('click', () => showMfgSettings(showModal))
}

/**
 * 「管理控制台」跳转按连接形态指路（2026-09-11 用户实测 MIME 修复）：
 *   - 远端连接（形态 C）→ 绑定宿主的控制台根（宿主面在 hub 上，不在本机）；
 *   - dsh 宿主挂载形态 → 宿主主界面根（装态装配无控制台，/gate01 根≠控制台）；
 *   - 独立形态 → 同源控制台（basePath 即控制台根，行为不变）。
 */
function consoleJumpLink() {
  if (state.remoteHub) {
    return `<a href="${esc(state.remoteHub.hubBase)}/" target="_blank" rel="noopener" title="打开绑定宿主（${esc(state.remoteHub.hubBase)}）的控制台">宿主控制台 ↗</a>`
  }
  if (state.hostBridge) {
    return '<a href="/" title="打开 dsh 宿主主界面（当前装配无独立控制台）">宿主主界面 ↗</a>'
  }
  return `<a href="${basePath() || '/'}" data-landing="console" title="打开01门管理控制台">管理控制台 ↗</a>`
}

function renderTopRight() {
  const host = $id('iawTopRight')
  if (!host) return
  // 渠道健康：在线模型占比 + 实时通道状态合成
  const online = state.models.filter((model) => model.status === 'online').length
  const healthCls = state.streamStale ? 'bad' : state.models.length === 0 ? 'off' : online === state.models.length ? 'ok' : online > 0 ? 'warn' : 'bad'
  const healthTxt = state.models.length === 0 ? '未接入渠道' : `渠道 ${online}/${state.models.length}`
  const waic = state.board?.waic?.chargeCents
  const ddBound = state.ddStatus?.bound
  const unread = (state.overview?.channels ?? []).reduce((sum, c) => sum + (c.unread ?? 0), 0)
    + activeTasks().filter((t) => t.lane === 'review').length
  const user = session.user ?? (state.demoMode ? { displayName: '演示访客' } : null)
  host.innerHTML = `
    <div class="iaw-health" title="模型渠道健康 · ${state.streamDowngraded ? '实时走 30s 轮询' : '实时通道正常'}"><span class="iaw-dot ${healthCls}"></span><span>${healthTxt}</span></div>
    ${waic !== undefined ? `<div class="iaw-cost" title="近 7 天平台调用费用（WAIC 口径；计量面未接入时为 0）">7天 ¥ ${(waic / 100).toFixed(2)}</div>` : ''}
    <button class="iaw-iconbtn" id="iawDdBrief" title="${ddBound ? `钉钉已绑定（${esc(ddBound.displayName ?? '')}）` : '钉钉桥接：点击绑定'}">⇄</button>
    <button class="iaw-iconbtn" id="iawNoticeBtn" title="通知中心"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>${unread ? `<span class="iaw-badge-n">${unread > 99 ? '99+' : unread}</span>` : ''}</button>
    <button class="iaw-iconbtn" id="iawHelpBtn" title="帮助与快捷键"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 115 .5c0 1.5-2.5 2-2.5 3.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg></button>
    <div class="iaw-avatar" id="iawUserAvatar" title="${esc(user?.displayName ?? '?')}（点击退出登录）">${esc((user?.displayName ?? '?').slice(0, 1))}</div>`
  $id('iawDdBrief').onclick = () => void showBind()
  $id('iawNoticeBtn').onclick = () => { state.space = 'collab'; state.nav = 'notice'; renderSeg(); renderNav(); void refreshView() }
  $id('iawHelpBtn').onclick = () => showHelp()
  // 退出登录（QA P2-3）：车间共用电脑下一班不能沿用上一班身份；演示态头像 = 登录入口
  $id('iawUserAvatar').onclick = async () => {
    if (state.demoMode) {
      showLoginModal()
      return
    }
    if (!window.confirm(`退出当前账号（${user?.displayName ?? ''}）？`)) return
    session.clear()
    renderLoginGuide()
    void toast('已退出登录')
  }
  renderSideFoot()
}

/** 状态栏：实时通道三态 + 环境标记 + 图谱统计。 */
function renderStatus(kind) {
  renderPreviewBar()
  const bar = $id('iawStatusbar')
  if (!bar) return
  let live = ''
  const down = (title) => `<span class="live" id="iawLive" title="${esc(title)}"><span class="iaw-dot bad"></span>连接中断 · 点击重试</span>`
  if (kind === 'down') live = down('实时轮询连续失败。点击重建实时通道。')
  else if (state.streamStale) live = down('超过 90 秒没有收到任何数据（可能断网或服务重启）。点击重建实时通道。')
  else {
    const health = state.stream?.health?.()
    if (!health || health.transport === 'sse') live = '<span class="live" title="实时通道（SSE）已连接"><span class="iaw-dot ok"></span>LIVE</span>'
    else if (health.consecutivePollFailures > 0) live = down('实时轮询连续失败。点击重建实时通道。')
    else live = '<span class="live" title="实时通道不可用（如钉钉 webview），已按 30 秒轮询兜底"><span class="iaw-dot warn"></span>30s 轮询</span>'
  }
  const env = [state.industryDemo ? '演示预览' : '', state.demoMode ? '演示态' : '', state.remoteHub ? `远端 ${state.remoteHub.hubBase}` : '', EMBEDDED ? '嵌入形态' : ''].filter(Boolean).join(' · ')
  bar.innerHTML = `
    <span>${env || '01门'}</span>
    ${live}
    <div class="right">
      <span>密度：${state.industry?.code ? ({ YB01: '高密', SH01: '高密', JB01: '高密', QC01: '标准', JB02: '高密', WS01: '标准', QB01: '舒适', QB02: '标准', QB03: '舒适', QB04: '舒适', SJ01: '高密', SJ02: '高密', SJ03: '标准', WJ01: '高密' }[state.industry.code] ?? '标准') : '标准'}</span>
      <span>主题：${esc(state.industry?.name ?? '—')} ${esc(state.industry?.code ?? '')}</span>
      <span>IAW v1.0</span>
    </div>`
  $id('iawLive')?.addEventListener('click', () => { reconnectStream(); void toast('正在重建实时通道…') })
}

/** 演示预览横幅（locked/pending 行业只读可看）：行业说明 + 激活入口 + 退出预览。 */
function renderPreviewBar() {
  const bar = $id('iawPreviewBar')
  if (!bar) return
  if (!state.industryDemo || !state.industry) {
    if (bar.innerHTML !== '') bar.innerHTML = ''
    return
  }
  const ind = state.industry
  bar.innerHTML = `
    <span class="ic">🧪</span>
    <span class="tx"><b>演示预览</b> · 「${esc(ind.name)}（${esc(ind.code)}）」尚未激活——当前展示<b>内置演示数据（只读）</b>，不能使用 / 调用 / 交互；${ind.state === 'pending' ? '激活申请审批中，可在审批中心跟进' : '激活后解锁完整功能'}。</span>
    ${ind.state === 'locked' ? '<button class="btn primary" id="iawPreviewActivate">🔐 提交激活申请</button>' : '<span class="pv-pending">审批中</span>'}
    <button class="btn" id="iawPreviewExit">退出预览</button>`
  $id('iawPreviewActivate')?.addEventListener('click', () => showActivate(ind))
  $id('iawPreviewExit')?.addEventListener('click', () => void exitIndustryPreview())
}

/** 演示预览护栏：未激活行业只读——写操作 / 调用一律在入口拦截并给出可行动文案。 */
function previewLocked() {
  if (!state.industryDemo) return false
  void toast('演示预览（只读）：该行业未激活——激活后解锁使用 / 调用 / 交互', 'error')
  return true
}

// ---------------------------------------------------------------------------
// 演示预览数据（2026-09-11 用户需求：未激活行业给看演示数据）：
// 从当前行业图谱包确定性派生「协作会话 / 任务」假数据——引用真实场景编号/痛点/四要素，
// 全部带 demo 标记（消息气泡打「演示」徽标），绝不混入真实频道消息。
// ---------------------------------------------------------------------------

const previewPick = (arr, i) => (arr.length ? arr[i % arr.length] : undefined)

function previewMessages() {
  const pack = state.scenegraph?.pack
  if (!pack) return []
  const scenes = packScenes(pack)
  if (!scenes.length) return []
  const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600_000).toISOString()
  const s1 = previewPick(scenes, 0)
  const s2 = previewPick(scenes, Math.floor(scenes.length / 3))
  const s3 = previewPick(scenes, Math.floor(scenes.length * 2 / 3))
  const list = (xs, n) => xs.slice(0, n).join('、')
  const phase = (s) => (s.s <= 2 ? '阶段一 · 起步补基' : s.s === 3 ? '阶段二 · 集成提升' : '阶段三 · 引领示范')
  return [
    { id: 'pv-sys', senderType: 'system', senderName: '01门', text: `以下为「${pack.name}」内置演示数据（只读预览）——激活行业后解锁真实协作`, mentions: [], ddSync: 'none', demo: true, createdAt: at(26) },
    { id: 'pv-m1', senderType: 'human', senderName: '演示 · 工艺组 · 王工', text: `@数字同事 场景 ${s1.code} ${s1.name} 现状 ${'★'.repeat(Math.min(4, s1.s))}，痛点「${s1.pain.slice(0, 42)}…」，请按一图四清单评估改造优先级`, mentions: ['数字同事'], ddSync: 'none', demo: true, createdAt: at(25) },
    {
      id: 'pv-m2', senderType: 'agent', senderName: `${pack.name} · 数字同事`, senderIcon: '🤖',
      text: `已按四清单评估 ${s1.code}：知识模型侧优先引入 ${list(s1.models, 2)}；数据侧打通 ${list(s1.data, 2)}；工具侧可沿用 ${list(s1.tools, 2)}。现状 ${s1.s}/4，建议归入「${phase(s1)}」，详见场景详情抽屉。`,
      mentions: [], ddSync: 'none', demo: true, createdAt: at(24),
      card: {
        title: `生成任务卡：${s1.code} 数字化改造评估`,
        ops: [
          { id: 'op1', label: '生成任务卡', style: 'primary', action: 'task.create' },
          { id: 'op2', label: '推送钉钉卡片', style: 'dd', action: 'dd.push' },
        ],
        done: [],
      },
    },
    { id: 'pv-m3', senderType: 'human', senderName: '演示 · 生产部 · 李经理', text: `收到。${s2.code}（${s2.name}）这条线更急：「${s2.pain.slice(0, 42)}…」，麻烦一起看下`, mentions: [], ddSync: 'none', demo: true, createdAt: at(6) },
    { id: 'pv-m4', senderType: 'agent', senderName: `${pack.name} · 数字同事`, senderIcon: '🤖', text: `${s2.code} 已列入转型路线图「${phase(s2)}」（现状 ${s2.s}/4）；对标场景可用 ${s3.code}（${s3.name}）做贯通度比对——「场景对比」视图可直接勾选。`, mentions: [], ddSync: 'none', demo: true, createdAt: at(5) },
  ]
}

function previewTasks() {
  const pack = state.scenegraph?.pack
  if (!pack) return []
  const scenes = packScenes(pack)
  if (!scenes.length) return []
  const lanes = ['todo', 'doing', 'review', 'todo', 'doing', 'review', 'done']
  const owners = [
    { assigneeType: 'agent', assigneeName: '演示 · 数字同事' },
    { assigneeType: 'human', assigneeName: '演示 · 工艺组 · 王工' },
    { assigneeType: 'human', assigneeName: '演示 · 生产部 · 李经理' },
  ]
  const titleTemplates = [
    (s) => `场景诊断：${s.code} ${s.name}`,
    (s) => `四清单补全：${s.code} 工具/数据缺口梳理`,
    (s) => `改造立项评估：${s.code} ${s.name}`,
    (s) => `${s.code} 数字化方案评审`,
    (s) => `${s.code} 要素接入排期（${s.tools[0] ?? '工具链'}）`,
    (s) => `跨场景贯通对标：${s.code}`,
    (s) => `${s.code} 改造验收与评级更新`,
  ]
  return lanes.map((lane, i) => {
    const scene = previewPick(scenes, i * 5 + 1)
    if (!scene) return null
    return {
      id: `pv-t${i + 1}`, dept: state.dept, title: titleTemplates[i](scene), lane,
      sceneCode: scene.code, createdBy: 'demo-preview',
      createdAt: new Date(Date.now() - (i + 1) * 3600_000 * 7).toISOString(),
      ...owners[i % owners.length],
    }
  }).filter(Boolean)
}

/** 展示用数据源：演示预览态回演示数据，其余回真实持久层。 */
function activeTasks() {
  return state.industryDemo ? previewTasks() : state.tasks
}
function activeMessages() {
  return state.industryDemo ? previewMessages() : state.messages
}

/** 事务流条：进行中任务 + 最近动态（真实任务面，不虚构进度）。 */
function renderFlowbar() {
  const bar = $id('iawFlowbar')
  if (!bar) return
  const tasks = activeTasks()
  const doing = tasks.filter((t) => t.lane === 'doing')
  const review = tasks.filter((t) => t.lane === 'review')
  const latest = tasks.filter((t) => t.lane !== 'done').sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
  const total = tasks.length
  const done = tasks.filter((t) => t.lane === 'done').length
  const pct = total ? Math.round((done / total) * 100) : 0
  bar.innerHTML = `
    <div class="prog" style="width:${pct}%"></div>
    <div class="pp"><span class="breath"></span><span>${doing.length} 个任务进行中${review.length ? ` · ${review.length} 个待审` : ''}</span></div>
    <div class="txt">${latest ? `最近：${esc(latest.title)} · ${esc(LANE_LABELS[latest.lane] ?? latest.lane)}${latest.assigneeName ? ` · ${esc(latest.assigneeName)}` : ''}` : '暂无进行中的业务任务——在「执行空间」创建，或把场景交给数字同事'}</div>
    <div class="right"><span id="iawFlowGates" style="cursor:pointer">${review.length ? `▲ ${review.length} 个门禁待确认` : '门禁 0'}</span></div>`
  $id('iawFlowGates')?.addEventListener('click', () => {
    state.space = 'collab'; state.nav = 'notice'; renderSeg(); renderNav(); void refreshView()
  })
}

// ---------------------------------------------------------------------------
// 行业切换 + 激活
// ---------------------------------------------------------------------------

function renderIndMenu() {
  const menu = $id('iawIndMenu')
  menu.innerHTML = '<div class="iaw-ind-menu-label">14 个重点行业 · 一图四清单</div>' + state.industries.map((ind) => {
    const st = ind.state === 'active' ? '<span class="st active">已激活</span>'
      : ind.state === 'pending' ? '<span class="st pending">审批中 · 可预览</span>'
        : '<span class="st locked">待授权 · 可预览</span>'
    return `<button class="iaw-ind-item ${ind.code === state.industry?.code ? 'on' : ''}" data-code="${esc(ind.code)}">
      <span class="badge" style="background:${IND_COLOR[ind.code] ?? 'var(--ind-500)'}">${esc(IND_AB[ind.code] ?? '·')}</span>
      <span class="nm">${esc(ind.name)}<span style="display:block;font-size:10px;color:var(--text-tertiary)">${esc(ind.sub)}</span></span>
      ${st}</button>`
  }).join('') + `<div style="border-top:1px solid var(--border-subtle);margin-top:6px;padding:9px 10px;font-size:11px;color:var(--text-tertiary)">未激活行业可点击进入<b>演示预览（只读）</b>——切换 / 使用需宿主平台授权激活（usage 计量 + audit 留痕）</div>`
  menu.querySelectorAll('.iaw-ind-item').forEach((el) => {
    el.onclick = (event) => {
      event.stopPropagation()
      menu.classList.remove('open')
      void pickIndustry(el.dataset.code)
    }
  })
}

async function pickIndustry(code) {
  const ind = state.industries.find((item) => item.code === code)
  if (!ind) return
  if (ind.state === 'active') {
    state.industry = ind
    state.industryDemo = false
    state.industryPinned = true
    try { localStorage.setItem('iaw_industry', ind.code) } catch { /* 忽略 */ }
    await applyIndustrySwitch(ind)
    richToast('已切换行业主题', `主色 / 密度 / 动效节奏按 <b>${esc(ind.name)}</b> 覆盖，布局不变。`)
    return
  }
  // locked / pending：进入演示预览（2026-09-11 用户需求）——未激活也能看各行业预置数据
  //（图谱 + 确定性演示会话/任务），只是不能使用 / 调用 / 交互；激活入口收进预览横幅。
  state.industry = ind
  state.industryDemo = true
  state.industryPinned = true
  // 演示预览不持久化：刷新后回到已激活行业，避免「演示态」被误当成组织真实行业
  try { localStorage.removeItem('iaw_industry') } catch { /* 忽略 */ }
  await applyIndustrySwitch(ind)
  richToast(ind.state === 'pending' ? '演示预览 · 授权审批中' : '已进入演示预览',
    `「<b>${esc(ind.name)}</b>」尚未激活——当前展示内置演示数据（只读），激活后解锁使用 / 调用 / 交互。`)
}

/** 行业切换公共落位（激活 / 预览共用）：清图谱缓存 → 主题与标题 → 全量重渲染。 */
async function applyIndustrySwitch(ind) {
  state.scenegraph = null
  state.thread = 'ALL'
  state.tagFilter.clear()
  $id('iawApp')?.setAttribute('data-industry', ind.code)
  $id('iawIndName').textContent = ind.name
  renderIndMenu()
  renderStatus()
  await switchDept(state.dept, { keepSpace: true })
}

/** 退出演示预览：回到已激活行业（无激活行业则回未激活态）。 */
async function exitIndustryPreview() {
  const active = state.industries.find((item) => item.state === 'active')
  state.industryDemo = false
  state.industry = active ?? null
  state.industryPinned = false
  try { localStorage.removeItem('iaw_industry') } catch { /* 忽略 */ }
  if (active) {
    await applyIndustrySwitch(active)
    void toast('已退出演示预览，回到已激活行业')
  } else {
    $id('iawApp')?.setAttribute('data-industry', '')
    $id('iawIndName') && ($id('iawIndName').textContent = '未激活行业')
    renderIndMenu()
    renderStatus()
    await switchDept(state.dept, { keepSpace: true })
    void toast('已退出演示预览')
  }
}

function showActivate(ind) {
  showModal(`🔐 行业功能包授权激活 · ${ind.name}（${ind.code}）`, `
    <p class="note" style="margin-top:0">该行业场景图谱包尚未对本组织授权。行业切换与功能面板使用需经<b>宿主平台授权激活</b>——申请进入审批中心（高风险单需二次确认），激活后按 usage 计量、audit 全程留痕。</p>
    <div style="margin:14px 0">
      <div class="lic-row"><span class="lr-ic">🗺</span><span>${esc(ind.name)}场景图谱包（一图四清单）<span style="display:block;font-size:10px;color:var(--txt2)">${esc(ind.sub)}</span></span><span class="lr-st">待授权</span></div>
      <div class="lic-row"><span class="lr-ic">🧩</span><span>部门面板行业化配置（五部门 × 场景挂载）</span><span class="lr-st">随审批生效</span></div>
      <div class="lic-row"><span class="lr-ic">🤖</span><span>行业 Agent 阵容与数据面连接器映射</span><span class="lr-st">随审批生效</span></div>
    </div>
    <div class="flow"><span class="fn">① 提交申请</span><span class="fa">→</span><span class="fn">② 平台管理员审批</span><span class="fa">→</span><span class="fn">③ 激活 + 能力授权</span><span class="fa">→</span><span class="fn">④ 面板解锁</span></div>
    <div style="display:flex;gap:10px">
      <button class="btn primary" id="actSubmit">提交激活申请</button>
      <button class="btn" id="actCancel">取消</button>
    </div>
    <p class="note">计量说明：激活后部门面板按 resource='panel:&lt;dept&gt;.${esc(ind.code.toLowerCase())}' 计量（零费率起步，费率由平台运营配置）。</p>`)
  $id('actCancel').onclick = hideModal
  $id('actSubmit').onclick = async (event) => {
    event.target.disabled = true
    try {
      await api.post(`/api/panel/industries/${ind.code}/activate-requests`)
      ind.state = 'pending'
      hideModal()
      renderIndMenu()
      renderStatus()
      void toast('激活申请已提交，请等待平台管理员审批')
    } catch (error) {
      event.target.disabled = false
      void toast(error.message, 'error')
    }
  }
}

// ---------------------------------------------------------------------------
// 部门切换 + 数据装载
// ---------------------------------------------------------------------------

async function switchDept(deptId, { keepSpace } = {}) {
  state.dept = deptId
  localStorage.setItem('panel_dept', deptId)
  state.channelId = localStorage.getItem(`panel_channel_${deptId}`) ?? ''
  if (!keepSpace && !defsHasNav()) state.nav = defaultNav()
  connectStream()
  state.overview = await api.get(`/api/panel/${deptId}/overview`)
  const channels = state.overview.channels
  if (!channels.some((channel) => channel.id === state.channelId)) {
    state.channelId = channels[0]?.id ?? ''
    if (state.channelId) localStorage.setItem(`panel_channel_${state.dept}`, state.channelId)
  }
  if (!state.industryPinned && state.overview.industry) {
    // 用户未显式选择行业时，以部门绑定的激活行业为默认（服务端事实源只作用一次）
    const upper = state.overview.industry.code.toUpperCase()
    const match = state.industries.find((ind) => ind.code === upper)
    if (match) state.industry = match
  }
  $id('iawApp')?.setAttribute('data-industry', state.industry?.code ?? '')
  $id('iawIndName') && ($id('iawIndName').textContent = state.industry?.name ?? '未激活行业')
  renderTopRight()
  renderAgentRail()
  await refreshView()
}

function defsHasNav() {
  return navDef()[state.space]?.some((n) => n[0] === state.nav) ?? false
}

/** 装载当前视图数据（失败显式提示，不白屏）。演示预览态：只拉图谱，真实消息/任务不拉（展示层用演示数据）。 */
async function loadViewData() {
  try {
    // 演示预览态总是装载图谱：演示会话/任务由图谱包确定性派生（previewMessages/previewTasks）
    const wantsGraph = state.industryDemo || ['compass', 'thread', 'compare', 'roadmap', 'tools', 'kmodels', 'talent', 'elements'].includes(state.nav) || state.nav === 'cockpit'
    const wantsTasks = !state.industryDemo && (['flow', 'inbox'].includes(state.nav) || state.nav === 'cockpit' || state.space === 'collab')
    const jobs = []
    if (wantsGraph && state.industry && !state.scenegraph) {
      jobs.push(api.get(`/api/panel/scenegraph?industry=${state.industry.code.toUpperCase()}`).then((res) => { state.scenegraph = res }).catch(() => { state.scenegraph = null }))
    }
    if (wantsTasks) jobs.push(api.get(`/api/panel/${state.dept}/tasks`).then((res) => { state.tasks = res.tasks }).catch(() => {}))
    if (state.nav === 'cockpit' && !state.board) {
      const q = state.boardPlatform ? `?platform=${encodeURIComponent(state.boardPlatform)}` : ''
      jobs.push(api.get(`/api/panel/board${q}`).then((res) => { state.board = res }).catch(() => { state.board = null }))
    }
    // 协作栏常驻：当前频道消息始终装载（不再只在 rooms 视图拉取——2026-09-11 E2E 发现修复）；
    // 演示预览态跳过（含已读游标推进——预览绝不产生任何写副作用）
    if (!state.industryDemo && state.channelId) {
      jobs.push(api.get(`/api/panel/${state.dept}/messages?channelId=${state.channelId}&limit=80`).then((res) => {
        state.messages = res.messages
        return api.post(`/api/panel/channels/${state.channelId}/read`).catch(() => {})
      }).catch(() => {}))
    }
    if (state.space === 'collab' && (state.nav === 'notice' || state.nav === 'agents')) {
      jobs.push(api.get(`/api/panel/${state.dept}/artifacts`).then((res) => { state.artifacts = res.artifacts }).catch(() => {}))
    }
    await Promise.all(jobs)
  } catch (error) {
    void toast(error.message, 'error')
  }
}

async function refreshView() {
  await loadViewData()
  renderView()
}

async function refreshOverview() {
  try {
    state.overview = await api.get(`/api/panel/${state.dept}/overview`)
    renderNav()
    renderAgentRail()
    renderFlowbar()
  } catch { /* 静默 */ }
}

// ---------------------------------------------------------------------------
// 视图路由
// ---------------------------------------------------------------------------

function defaultNav() {
  return navDef()[state.space]?.[0]?.[0] ?? 'compass'
}

function renderView() {
  const main = $id('iawMain')
  if (!main) return
  const pack = state.scenegraph?.pack
  // 制造工具箱空间：独立渲染通道（自带数据装载与事件接线；异步不阻塞其余视图）
  if (state.space === 'mfg') {
    void renderMfgView(state.nav)
    $id('iawApp')?.classList.toggle('rail-off', true)
    renderFlowbar()
    renderStatus()
    renderNav()
    renderTopRight()
    renderCtx()
    return
  }
  closeMfgDrawer()
  const views = {
    compass: () => viewCompass(pack),
    thread: () => viewThread(pack),
    compare: () => viewCompare(pack),
    cockpit: () => viewCockpit(pack),
    roadmap: () => viewRoadmap(pack),
    flow: () => viewFlow(),
    inbox: () => viewInbox(),
    mchannels: () => viewMChannels(),
    tools: () => viewCapList(pack, 'tools'),
    kmodels: () => viewCapList(pack, 'models'),
    talent: () => viewCapList(pack, 'talent'),
    elements: () => viewElements(pack),
    rooms: () => viewRooms(),
    agents: () => viewAgents(),
    members: () => viewMembers(),
    notice: () => viewNotice(),
  }
  const render = views[state.nav] ?? (() => viewGenericHonest())
  main.innerHTML = render()
  main.scrollTop = 0
  wireView(main)
  // 协作空间 = 全宽频道会话，右侧协作栏收起（同一会话只保留一个协作窗口，2026-09-11 用户裁决）
  $id('iawApp')?.classList.toggle('rail-off', state.space === 'collab')
  renderFlowbar()
  renderStatus()
  renderNav()
  renderTopRight()
  renderCtx()
  renderConversation($id('iawMsgs'))
  renderConversation($id('iawRoomsMsgs'))
}

function viewGenericHonest() {
  return `<div class="iaw-view"><div class="iaw-empty">该视图未在当前版本开放——不做空占位入口，缺失能力已登记交接清单（docs/handoff-iaw-gaps-to-main.md）。</div></div>`
}

// ---------------------------------------------------------------------------
// 图谱空间：场景罗盘
// ---------------------------------------------------------------------------

function packScenes(pack) {
  if (!pack) return []
  return Object.values(pack.activities).flat()
}

function sceneLinkKey(scene, links) {
  // 场景编号第二段即环节字母（如 YB01-AB-2-1 → AB）；多环节场景归属其全部环节
  const seg = String(scene.code ?? '').split('-')[1] ?? ''
  return links?.length ? links.filter((l) => seg.includes(l.key)) : [{ key: seg, name: seg }]
}

function viewCompass(pack) {
  const ind = state.industry
  if (!ind) return `<div class="iaw-view"><div class="iaw-empty">本组织尚未激活行业场景图谱。请通过顶栏行业选择器提交激活申请。</div></div>`
  if (!pack) return `<div class="iaw-view"><div class="iaw-hero"><div class="iaw-hero-l"><div class="eyebrow">${esc(ind.code)} · 行业场景图谱 2025 版</div><h2>${esc(ind.name)} · 场景罗盘</h2><p>图谱包未装载（已激活但数据缺位）——请联系平台管理员检查 scenegraphs 目录，或经「行业选择器 → 激活」完成授权。</p></div></div></div>`

  const links = pack.links ?? []
  let scenes = packScenes(pack)
  if (state.thread !== 'ALL') scenes = scenes.filter((s) => sceneLinkKey(s, links).some((l) => l.key === state.thread))
  if (state.tagFilter.size > 0) scenes = scenes.filter((s) => s.tags.some((t) => state.tagFilter.has(t)))

  const total = packScenes(pack).length
  const started = packScenes(pack).filter((s) => s.s >= 3).length
  const avg = total ? (packScenes(pack).reduce((sum, s) => sum + s.s, 0) / total).toFixed(2) : '—'
  const actKeys = Object.keys(pack.activities).sort((a, b) => (ACT_CODE[a] ?? 9) - (ACT_CODE[b] ?? 9))

  let h = '<div class="iaw-view">'
  h += `<div class="iaw-hero"><div class="iaw-hero-l">
    <div class="eyebrow">${esc(pack.code)} · 行业场景图谱 ${esc(pack.version)} 版</div>
    <h2>${esc(pack.name)} · 场景罗盘</h2>
    <p>1 条主线 · ${actKeys.length} 类业务活动 · ${total} 个场景 · 4 类数字化要素。环节：${esc(pack.chains)}</p></div>
    <div class="iaw-hero-stats">
      <div class="iaw-hstat"><div class="v">${total}</div><div class="k">场景节点</div></div>
      <div class="iaw-hstat"><div class="v">${started}</div><div class="k">评级 ★★★+</div></div>
      <div class="iaw-hstat"><div class="v">${avg}</div><div class="k">平均现状评级</div></div>
    </div></div>`

  // 主线（环节链）过滤
  h += '<div class="iaw-thread"><div class="iaw-thread-node"><span class="t ' + (state.thread === 'ALL' ? 'on' : '') + '" data-thread="ALL">全部环节<small>' + total + '</small></span></div>'
  for (const l of links) {
    const n = packScenes(pack).filter((s) => sceneLinkKey(s, links).some((x) => x.key === l.key)).length
    if (n === 0) continue
    h += `<span class="iaw-thread-node"><span class="link"></span></span><div class="iaw-thread-node"><span class="t ${state.thread === l.key ? 'on' : ''}" data-thread="${esc(l.key)}">${esc(l.key)} · ${esc(l.name)}<small>${n}</small></span></div>`
  }
  h += '</div>'

  // 过滤（价值标签 + 编码/名称检索）
  h += '<div class="iaw-filters"><span class="lbl">价值标签</span>'
  const presentTags = TAG_ORDER.filter((t) => packScenes(pack).some((s) => s.tags.includes(t)))
  for (const t of presentTags) h += `<button class="iaw-chip ${state.tagFilter.has(t) ? 'on' : ''}" data-tag="${esc(t)}">${tagPill(t)}</button>`
  h += `<span class="grow"></span><input class="iaw-ghost-input" id="iawSceneSearch" placeholder="编码 / 名称"><span class="lbl">${scenes.length} 个场景</span></div>`

  // 业务活动泳道
  h += '<div class="iaw-lanes">'
  for (const act of actKeys) {
    const arr = scenes.filter((s) => pack.activities[act].includes(s))
    h += `<div class="iaw-lane"><div class="iaw-lane-h"><div class="n">${esc(ACT_LABELS[act] ?? act)}</div><div class="c">${act}</div><div class="s">${arr.length} 个场景</div></div><div class="iaw-lane-body">`
    if (!arr.length) h += '<div class="iaw-empty" style="padding:22px 0;width:100%">该环节下暂无符合筛选条件的场景</div>'
    for (const s of arr) {
      h += `<button class="iaw-node ${state.scene === s.code ? 'on' : ''}" data-scene="${esc(s.code)}" data-name="${esc(s.name)}">
        <div class="r1"><span class="code">${esc(s.code)}</span><span class="type ${s.type === '主场景' ? 'main' : ''}">${esc(s.type)}</span></div>
        <div class="nm">${esc(s.name)}</div>
        <div class="tags">${s.tags.map(tagPill).join('')}</div>
        <div class="r2">${stars(s.s)}<span class="ch">▣ 要素 ${s.tools.length + s.models.length + s.data.length + s.talent.length} 项</span></div>
      </button>`
    }
    h += '</div></div>'
  }
  h += '</div></div>'
  return h
}

// ---------------------------------------------------------------------------
// 图谱空间：主线贯通视图 / 场景对比 / 转型路线图（2026-09-11 补原型三视图，全部由图谱真实数据计算）
// ---------------------------------------------------------------------------

/** 行业环节链：links 缺位（如 qb01 包）时从场景编号第二段反推环节字母（名称暂用键名）。 */
function packLinks(pack) {
  if (pack.links?.length) return pack.links
  const seen = new Map()
  for (const s of packScenes(pack)) {
    const key = String(s.code ?? '').split('-')[1] ?? ''
    if (!key || seen.has(key)) continue
    seen.set(key, { key, name: key })
  }
  return [...seen.values()]
}

/** 环节聚合：场景数 / 平均评级 / 四要素复用度（被 ≥2 场景共用的要素占比 = 数字主线贯通度）。 */
function threadRows(pack) {
  const links = packLinks(pack)
  const scenes = packScenes(pack)
  const rows = []
  for (const link of links) {
    const arr = scenes.filter((s) => sceneLinkKey(s, links).some((l) => l.key === link.key))
    if (!arr.length) continue
    const stats = {}
    for (const key of ['tools', 'models', 'data', 'talent']) {
      const counter = new Map()
      for (const scene of arr) for (const item of new Set(scene[key])) counter.set(item, (counter.get(item) ?? 0) + 1)
      const all = [...counter.keys()]
      const shared = [...counter.entries()].filter(([, n]) => n >= 2)
      // 贯通度 = 跨场景复用要素占比（0-100；单场景环节按 100 计——无断点可言）
      stats[key] = { total: all.length, shared: shared.map(([name, n]) => ({ name, n })), pct: all.length === 0 ? 0 : arr.length === 1 ? 100 : Math.round(shared.length / all.length * 100) }
    }
    const pct = Math.round((stats.tools.pct + stats.models.pct + stats.data.pct + stats.talent.pct) / 4)
    rows.push({
      link,
      scenes: arr,
      avg: (arr.reduce((sum, s) => sum + s.s, 0) / arr.length).toFixed(1),
      pct,
      stats,
    })
  }
  return rows
}

function viewThread(pack) {
  if (!pack) return `<div class="iaw-view"><div class="iaw-empty">行业图谱未装载，主线贯通视图不可用。</div></div>`
  const links = pack.links ?? []
  let h = `<div class="iaw-view"><div class="iaw-page-head"><div><h1>主线贯通视图</h1><p>数字主线：跨场景贯通的数据 / 模型 / 工具接口串联与断点识别（贯通度 = 被两个以上场景共用的要素占比）</p></div></div>`
  const rows = threadRows(pack)
  if (!rows.length) return h + '<div class="iaw-empty">图谱中暂无环节场景。</div></div>'
  h += '<div class="iaw-thread-rows">'
  for (const row of rows) {
    h += `<div class="iaw-panel" style="margin-bottom:12px"><div class="iaw-panel-h"><h3><span class="iaw-pill iaw-pill-neutral">${esc(row.link.key)}</span> ${esc(row.link.name)}</h3>
      <div class="spacer"></div><span style="font-size:12px;color:var(--text-secondary)">${row.scenes.length} 个场景 · 平均评级 ${row.avg}</span>
      <span class="iaw-pill ${row.pct >= 50 ? 'iaw-pill-cost' : row.pct >= 25 ? 'iaw-pill-eff' : 'iaw-pill-neutral'}">贯通度 ${row.pct}%</span></div>
      <div class="iaw-barrows">`
    const groups = [['data', '数据要素', 'var(--accent-teal)'], ['models', '知识模型', 'var(--accent-amber)'], ['tools', '工具软件', 'var(--accent-indigo)'], ['talent', '人才技能', 'var(--accent-violet)']]
    for (const [key, label, color] of groups) {
      const st = row.stats[key]
      h += `<div class="iaw-bar-row"><span class="lb">${label}</span><div class="iaw-bar-track"><i style="width:${st.pct}%;background:${color}"></i></div><span class="vv">${st.pct}%</span></div>`
    }
    h += '</div>'
    const shared = [...row.stats.data.shared.slice(0, 2), ...row.stats.models.shared.slice(0, 2)].map((x) => x.name)
    h += shared.length ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:8px">贯通要素：${shared.map(esc).join(' · ')}</div>` : '<div style="font-size:11px;color:var(--text-tertiary);margin-top:8px">该环节暂无跨场景复用要素——数据/模型断点识别优先级最高</div>'
    h += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${row.scenes.slice(0, 6).map((s) => `<span class="scene" data-scene="${esc(s.code)}" style="cursor:pointer;font-family:var(--font-mono);font-size:10px;color:var(--text-link)">${esc(s.code)}</span>`).join('')}${row.scenes.length > 6 ? `<span style="font-size:10px;color:var(--text-tertiary)">等 ${row.scenes.length} 个</span>` : ''}</div>`
    h += '</div>'
  }
  h += '</div></div>'
  return h
}

function viewCompare(pack) {
  if (!pack) return `<div class="iaw-view"><div class="iaw-empty">行业图谱未装载，场景对比不可用。</div></div>`
  let h = `<div class="iaw-view"><div class="iaw-page-head"><div><h1>场景对比</h1><p>最多选 3 个场景并排比对：评级 / 价值标签 / 四要素清单 / 痛点（点击场景卡加入或移除）</p></div></div>`
  const scenes = packScenes(pack)
  const selected = state.compare.map((code) => scenes.find((s) => s.code === code)).filter(Boolean).slice(0, 3)
  h += `<div class="iaw-card" style="padding:10px 12px;margin-bottom:12px"><input class="iaw-ghost-input" id="iawCmpSearch" placeholder="编码 / 名称筛选候选场景（当前已选 ${selected.length}/3）" style="width:min(360px,100%)"></div>`
  h += '<div class="iaw-lanes"><div class="iaw-lane"><div class="iaw-lane-h"><div class="n">候选场景</div><div class="c">全环节</div><div class="s">${scenes.length}</div></div><div class="iaw-lane-body">'
  for (const s of scenes) {
    const on = state.compare.includes(s.code)
    h += `<button class="iaw-node ${on ? 'on' : ''}" data-cmp="${esc(s.code)}" data-name="${esc(s.name)}" data-code="${esc(s.code)}">
      <div class="r1"><span class="code">${esc(s.code)}</span><span class="type ${s.type === '主场景' ? 'main' : ''}">${esc(s.type)}</span></div>
      <div class="nm">${esc(s.name)}</div>
      <div class="r2">${stars(s.s)}<span class="ch">▣ ${s.tools.length + s.models.length + s.data.length + s.talent.length} 项</span></div>
    </button>`
  }
  h += '</div></div></div>'
  if (selected.length >= 2) {
    h += '<div class="iaw-card" style="overflow:auto"><table class="iaw-tbl"><thead><tr><th style="min-width:96px">维度</th>'
    h += selected.map((s) => `<th>${esc(s.code)}<br><span style="font-weight:400;font-size:11px">${esc(s.name)}</span></th>`).join('')
    h += '</tr></thead><tbody>'
    h += `<tr><td class="n">现状评级</td>${selected.map((s) => `<td>${stars(s.s)} <span style="font-size:11px;color:var(--text-tertiary)">${s.s}/4</span></td>`).join('')}</tr>`
    h += `<tr><td class="n">转型价值</td>${selected.map((s) => `<td>${s.tags.map(tagPill).join(' ') || '<span style="color:var(--text-tertiary)">原文未标注</span>'}</td>`).join('')}</tr>`
    const groups = [['tools', '工具软件'], ['models', '知识模型'], ['data', '数据要素'], ['talent', '人才技能']]
    for (const [key, label] of groups) {
      h += `<tr><td class="n">${label}</td>${selected.map((s) => `<td><ul style="margin:0;padding-left:14px;font-size:11px">${s[key].slice(0, 6).map((x) => `<li>${esc(x)}</li>`).join('')}${s[key].length > 6 ? `<li style="color:var(--text-tertiary)">等 ${s[key].length} 项</li>` : ''}</ul></td>`).join('')}</tr>`
    }
    h += `<tr><td class="n">痛点</td>${selected.map((s) => `<td style="font-size:11px">${esc(s.pain.slice(0, 80))}…</td>`).join('')}</tr>`
    h += '</tbody></table></div>'
  } else {
    h += `<div class="iaw-empty" style="padding:22px">在上方再选 ${2 - selected.length} 个场景开始对比</div>`
  }
  h += '</div>'
  return h
}

function viewRoadmap(pack) {
  if (!pack) return `<div class="iaw-view"><div class="iaw-empty">行业图谱未装载，转型路线图不可用。</div></div>`
  const scenes = packScenes(pack)
  const total = scenes.length
  const elems = (s) => s.tools.length + s.models.length + s.data.length + s.talent.length
  // 三阶段路线（PRD 四档评级 → 改造节奏）：起步补基（≤2★）→ 集成提升（3★）→ 引领示范（4★）
  const phases = [
    { key: 'p1', title: '阶段一 · 起步补基', sub: '现状 ≤★★ 的场景：四清单补全与基础改造，优先解决「从无到有」', arr: scenes.filter((s) => s.s <= 2), pill: 'iaw-pill-neutral' },
    { key: 'p2', title: '阶段二 · 集成提升', sub: '现状 ★★★ 的场景：系统集成为主，向跨场景贯通与数据闭环演进', arr: scenes.filter((s) => s.s === 3), pill: 'iaw-pill-eff' },
    { key: 'p3', title: '阶段三 · 引领示范', sub: '现状 ★★★★ 的场景：保持领先并沉淀为行业示范样本', arr: scenes.filter((s) => s.s >= 4), pill: 'iaw-pill-cost' },
  ]
  let h = `<div class="iaw-view"><div class="iaw-page-head"><div><h1>转型路线图</h1><p>${esc(pack.name)} · ${total} 个场景按现状评级分三阶段推进（评级来源：图谱现状自评）</p></div></div>`
  h += '<div class="iaw-grid-3">'
  for (const phase of phases) {
    const pct = total ? Math.round(phase.arr.length / total * 100) : 0
    h += `<div class="iaw-panel"><div class="iaw-panel-h"><h3>${phase.title}</h3><span class="iaw-pill ${phase.pill}">${phase.arr.length} 个 · ${pct}%</span></div>
      <div style="font-size:12px;color:var(--text-secondary);min-height:36px">${phase.sub}</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:10px">`
    const top = phase.arr.slice(0, 8)
    h += top.map((s) => `<div class="iaw-elem" style="margin:0"><div class="eh" style="cursor:pointer" data-scene="${esc(s.code)}"><span class="d" style="background:var(--ind-500)"></span><span style="font-family:var(--font-mono);font-size:10px">${esc(s.code)}</span>&nbsp;${esc(s.name)}<span class="iaw-pill iaw-pill-neutral cnt">${stars(s.s)}</span></div></div>`).join('')
      || '<div class="iaw-empty" style="padding:8px">该阶段暂无场景</div>'
    h += `</div>${phase.arr.length > top.length ? `<div style="font-size:10px;color:var(--text-tertiary);margin-top:6px">等 ${phase.arr.length} 个场景</div>` : ''}</div>`
  }
  h += '</div>'
  // 快赢清单：要素齐备但评级 ≤2★ —— 基础最好的「低评级」场景，改造启动成本最低
  const quickWins = scenes.filter((s) => s.s <= 2).sort((a, b) => elems(b) - elems(a)).slice(0, 8)
  h += '<div class="iaw-sect-title">优先启动（快赢清单）<span class="line"></span></div><div class="iaw-grid-2">'
  h += `<div class="iaw-panel"><div class="iaw-panel-h"><h3>要素齐备 · 评级待提升</h3></div>`
  h += quickWins.map((s) => `<div class="iaw-alert i" style="margin-bottom:8px"><span>▲</span><div class="sp"><b><span data-scene="${esc(s.code)}" style="cursor:pointer">${esc(s.code)} ${esc(s.name)}</span></b><br>评级 ${s.s}/4 · 要素 ${elems(s)} 项已结构化——建议首批启动改造</div></div>`).join('')
    || '<div class="iaw-empty" style="padding:16px">无 ≤2★ 场景，可聚焦集成提升阶段</div>'
  h += '</div>'
  h += `<div class="iaw-panel"><div class="iaw-panel-h"><h3>路线图口径</h3></div><div class="iaw-alert i"><span>▣</span><div class="sp">阶段划分按图谱现状评级（四档制）计算；改造进度（实际完成情况）以「执行空间」任务泳道为准——本视图回答「从哪里开始」，任务面回答「做到哪了」。</div></div>
    <div class="iaw-alert i" style="margin-top:10px"><span>▣</span><div class="sp"><b>带投资估算 / 工期排布的转型路线图属宿主平台事务流引擎能力</b>，已登记交接清单。</div></div></div>`
  h += '</div></div>'
  return h
}

// ---------------------------------------------------------------------------
// 图谱空间：度量驾驶舱
// ---------------------------------------------------------------------------

function donut(data, size = 150) {
  size = size || 150
  const r = size / 2 - 14; const cx = size / 2; const cy = size / 2
  const tot = data.reduce((a, b) => a + b.v, 0) || 1
  let off = -Math.PI / 2; let paths = ''
  for (const d of data) {
    const ang = d.v / tot * Math.PI * 2; const large = ang > Math.PI ? 1 : 0
    const x1 = cx + r * Math.cos(off); const y1 = cy + r * Math.sin(off)
    const x2 = cx + r * Math.cos(off + ang); const y2 = cy + r * Math.sin(off + ang)
    paths += `<path d="M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2}" fill="none" stroke="${d.c}" stroke-width="12"/>`
    off += ang
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="22" font-weight="500" fill="#1E2530" font-variant-numeric="tabular-nums">${tot}</text><text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="11" fill="#8D97A3">场景</text></svg>`
}

function barRows(rows) {
  const max = Math.max(...rows.map((r) => r.v)) || 1
  return '<div class="iaw-barrows">' + rows.map((r) =>
    `<div class="iaw-bar-row"><span class="lb">${esc(r.k)}</span><div class="iaw-bar-track"><i style="width:${(r.v / max * 100).toFixed(1)}%;background:${r.c || 'var(--ind-500)'}"></i></div><span class="vv">${r.v}</span></div>`).join('') + '</div>'
}

const TAG_COLORS = { 降本: '#12A150', 提质: '#4F46E5', 增效: '#E8A317', 增收: '#E11D48', 安全: '#0EA5E9', 环保: '#0B7A4B', 节能: '#F59E0B', 新模式: '#7C4DFF' }

function statCard(k, v, d, cls) {
  return `<div class="iaw-mcard"><div class="k">${k}</div><div class="v">${v}</div>${d ? `<div class="d ${cls || 'neutral'}">${d}</div>` : ''}</div>`
}

function viewCockpit(pack) {
  const ov = state.overview
  const ind = state.industry
  const scenes = packScenes(pack)
  const byLane = Object.fromEntries(LANE_ORDER.map((lane) => [lane, activeTasks().filter((t) => t.lane === lane).length]))
  const doneRate = activeTasks().length ? Math.round(byLane.done / activeTasks().length * 100) : 0

  let h = `<div class="iaw-view"><div class="iaw-page-head"><div><h1>度量驾驶舱</h1><p>${esc(ind?.name ?? '')} · ${esc(ov?.dept?.label ?? '')} · 数据窗口：近 7 天</p></div><div class="spacer"></div>
    ${(state.board?.availablePlatforms ?? []).map((pf) => `<button class="iaw-chip ${state.boardPlatform === pf ? 'on' : ''}" data-bplat="${esc(pf)}">${esc(PLATFORM_LABELS[pf] ?? pf)}</button>`).join('')}</div>`

  h += '<div class="iaw-metrics-row" style="margin-bottom:16px">'
  h += statCard('任务完成率', `${doneRate}<small>%</small>`, `${byLane.done} / ${activeTasks().length} 个任务`, doneRate >= 60 ? 'up' : 'down')
  h += statCard('平均现状评级', pack && scenes.length ? (scenes.reduce((sum, s) => sum + s.s, 0) / scenes.length).toFixed(2) + '<small>/ 4</small>' : '—', pack ? `${scenes.length} 个场景` : '图谱未装载', 'neutral')
  h += statCard('进行中任务', String(byLane.doing), `${byLane.review} 个待审`, byLane.review > 0 ? 'down' : 'neutral')
  h += statCard('沉淀产物', String(state.artifacts.length), '报告 / 工单 / 诊断', 'neutral')
  h += '</div>'

  h += '<div class="iaw-sect-title">评级与价值达成<span class="line"></span><span style="font-size:12px;color:var(--text-tertiary);font-weight:400">来自行业场景图谱 · 真实分布</span></div>'
  h += '<div class="iaw-grid-2">'
  const buckets = [
    { k: '★★★★ 引领', v: scenes.filter((s) => s.s >= 4).length, c: '#F59E0B' },
    { k: '★★★ 集成', v: scenes.filter((s) => s.s === 3).length, c: '#34D399' },
    { k: '★★ 单点', v: scenes.filter((s) => s.s === 2).length, c: '#60A5FA' },
    { k: '★ 起步', v: scenes.filter((s) => s.s <= 1).length, c: '#94A3B8' },
  ]
  h += `<div class="iaw-panel"><div class="iaw-panel-h"><h3>场景现状评级分布</h3></div>${barRows(buckets)}</div>`
  const tagCounts = TAG_ORDER.map((t) => ({ t, v: scenes.filter((s) => s.tags.includes(t)).length })).filter((x) => x.v > 0)
  h += `<div class="iaw-panel"><div class="iaw-panel-h"><h3>价值标签达成</h3></div><div class="iaw-donut-c">${donut(tagCounts.map((x) => ({ v: x.v, c: TAG_COLORS[x.t] ?? 'var(--ind-500)' })))}
    <div class="iaw-legend">${tagCounts.map((x) => `<div><i style="background:${TAG_COLORS[x.t]}"></i>${esc(x.t)} ${x.v}</div>`).join('')}</div></div></div>`
  h += '</div>'

  // 执行与协同
  h += '<div class="iaw-sect-title">执行与协同<span class="line"></span></div>'
  h += '<div class="iaw-grid-3">'
  h += `<div style="grid-column:span 2;display:grid;grid-template-columns:repeat(2,1fr);gap:12px;align-content:start">
    ${statCard('数字同事', String((ov?.dept?.agents ?? []).length), (ov?.dept?.agents ?? []).filter((a) => a.asset?.status === 'online').length + ' 个资产在线', 'neutral')}
    ${statCard('协作频道', String((ov?.channels ?? []).length), (ov?.channels ?? []).reduce((sum, c) => sum + (c.unread ?? 0), 0) + ' 条未读', 'neutral')}
    ${(ov?.kpis ?? []).slice(0, 2).map((kpi) => statCard(esc(kpi.label) + ` <span style="font-size:10px;color:var(--text-tertiary)">来源 ${esc(kpi.source)}</span>`, esc(kpi.value), '', 'neutral')).join('')}
  </div>`
  const alertsWidget = (ov?.widgets ?? []).find((w) => w.type === 'alerts' && !w.degraded)
  h += `<div class="iaw-panel"><div class="iaw-panel-h"><h3>预警中心</h3></div>
    ${alertsWidget ? alertsWidget.rows.map((row) => `<div class="iaw-alert ${row[0] === 'y' ? 'w' : 'i'}"><span>▲</span><div class="sp"><b>${esc(row[1])}</b><br>${esc(row[2])}</div></div>`).join('') : '<div class="iaw-empty" style="padding:16px">当前无预警数据源（告警 widget 未配置或已降级）</div>'}
  </div>`
  h += '</div>'

  // 渠道效能（模型目录真实字段；TTFT/TPS 遥测 = 宿主面缺口，诚实缺席）
  h += '<div class="iaw-sect-title">渠道效能<span class="line"></span></div>'
  h += '<div class="iaw-panel"><table class="iaw-tbl"><thead><tr><th>渠道</th><th>厂商</th><th>状态</th><th>挂牌价</th><th>成本价</th><th>Endpoint</th><th></th></tr></thead><tbody>'
  h += state.models.map((m) => `<tr>
    <td class="n">${esc(m.displayName || m.slug)} <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-tertiary)">${esc(m.slug)}</span></td>
    <td>${esc(m.provider || '—')}</td>
    <td><span class="iaw-sp" style="color:var(--${m.status === 'online' ? 'success' : 'neutral'}-600)"><span class="iaw-dot ${m.status === 'online' ? 'ok' : 'off'}"></span>${m.status === 'online' ? '在线' : '离线'}</span></td>
    <td class="n">${esc(m.listCentsPerKTokens)} 分/千tok</td>
    <td class="n">${esc(m.costCentsPerKTokens ?? '—')}</td>
    <td style="font-family:var(--font-mono);font-size:10px">${esc(m.endpoint || '未配置')}</td>
    <td>${session.can('panel.config.write') ? `<button class="iaw-btn iaw-btn-ghost iaw-btn-sm" data-mtest="${esc(m.slug)}">测试</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text-tertiary)">模型目录为空——在「能力空间 · 模型渠道」登记</td></tr>'
  h += '</tbody></table>'
  h += '<div class="iaw-alert i" style="margin-top:12px"><span>▣</span><div class="sp"><b>口径说明</b>：TTFT/TPS/可用率/采纳率等渠道遥测属宿主平台模型网关能力，当前版本未接入（已登记交接清单），面板不以演示数据冒充。</div></div>'
  h += '</div>'

  // 平台聚合面（board 端点真实下发）
  const b = state.board
  if (b) {
    const funnel = b.funnel ?? {}
    h += '<div class="iaw-sect-title">平台资产与价值漏斗<span class="line"></span></div>'
    h += `<div class="iaw-grid-3">
      <div class="iaw-panel"><div class="iaw-panel-h"><h3>在线资产</h3></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${statCard('AI 应用', String(b.assets?.appsOnline ?? 0), '', 'neutral')}
        ${statCard('Agent 本体', String(b.assets?.agentsOnline ?? 0), '', 'neutral')}
        ${statCard('已上架技能', String(b.assets?.skillsPublished ?? 0), '', 'neutral')}
        ${statCard('MCP 服务中', String(b.assets?.mcpServing ?? 0), '', 'neutral')}
      </div></div>
      <div class="iaw-panel"><div class="iaw-panel-h"><h3>价值漏斗（7 天）</h3></div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <div><div style="font-size:22px;font-weight:500">${funnel.exposed ?? 0}</div><div style="font-size:11px;color:var(--text-tertiary)">曝光</div></div><span>→</span>
          <div><div style="font-size:22px;font-weight:500">${funnel.clicked ?? 0}</div><div style="font-size:11px;color:var(--text-tertiary)">点击</div></div><span>→</span>
          <div><div style="font-size:22px;font-weight:500">${funnel.invoked ?? 0}</div><div style="font-size:11px;color:var(--text-tertiary)">调用</div></div><span>→</span>
          <div><div style="font-size:22px;font-weight:500">${funnel.completed ?? 0}</div><div style="font-size:11px;color:var(--text-tertiary)">完成</div></div>
        </div>
        <div class="iaw-alert i" style="margin-top:12px"><span>▣</span><div class="sp">${esc(b.roi?.note ?? 'ROI 估算口径见平台治理文档')}</div></div>
      </div>
      <div class="iaw-panel"><div class="iaw-panel-h"><h3>WAIC 口径（7 天）</h3></div>
        ${statCard('调用次数', String(b.waic?.count ?? 0), '', 'neutral')}
        ${statCard('平台费用', `¥${((b.waic?.chargeCents ?? 0) / 100).toFixed(2)}`, '计量面未接入时为 0', 'neutral')}
      </div>
    </div>`
  }
  h += '</div>'
  return h
}

// ---------------------------------------------------------------------------
// 执行空间：任务看板 / 我的收件箱
// ---------------------------------------------------------------------------

function viewFlow() {
  const tasks = activeTasks()
  const review = tasks.filter((t) => t.lane === 'review')
  let h = '<div class="iaw-view">'
  h += `<div class="iaw-page-head"><div><h1>事务流工作台</h1><p>最小执行单元是任务：待办 → 进行中 → 待审 → 完成；Agent 产出经门禁确认后落账</p></div><div class="spacer"></div>
    ${!state.industryDemo && session.can('panel.task.write') ? '<button class="iaw-btn iaw-btn-primary" id="iawNewTask">＋ 新建任务</button>' : ''}</div>`
  if (review.length > 0) {
    h += `<div class="iaw-gatebar"><span>▲</span><div class="sp"><b>门禁待确认</b>：${review.length} 个任务停在「待审」——Agent/同事的产出需人工复核后才能闭环。</div><button class="iaw-btn iaw-btn-ghost iaw-btn-sm" id="iawGateJump">去处理</button></div>`
  }
  h += '<div class="iaw-fkanban">'
  for (const lane of LANE_ORDER) {
    const arr = tasks.filter((t) => t.lane === lane)
    h += `<div class="iaw-fklane"><div class="iaw-fklane-h">${LANE_LABELS[lane]}<span class="cnt">${arr.length}</span></div><div class="iaw-fklane-b">`
    for (const t of arr) {
      h += `<div class="iaw-task" data-task="${esc(t.id)}" data-lane="${esc(t.lane)}">
        <div class="tt">${esc(t.title)}</div>
        <div class="tm">
          <span class="who">${t.assigneeType === 'agent' ? '🤖' : '🧑'} ${esc(t.assigneeName ?? '未指派')}</span>
          ${t.sceneCode ? `<span class="scene" data-scene="${esc(t.sceneCode)}">${esc(t.sceneCode)}</span>` : ''}
          <span style="margin-left:auto;display:flex;gap:4px">
            ${!state.industryDemo && lane !== 'todo' ? `<button class="iaw-chip" data-move="${esc(t.id)}" data-to="${LANE_ORDER[LANE_ORDER.indexOf(lane) - 1]}" title="回退">←</button>` : ''}
            ${!state.industryDemo && lane !== 'done' ? `<button class="iaw-chip" data-move="${esc(t.id)}" data-to="${LANE_ORDER[LANE_ORDER.indexOf(lane) + 1]}" title="推进">→</button>` : ''}
          </span>
        </div></div>`
    }
    h += `${state.industryDemo ? '' : `<button class="iaw-chip" data-addlane="${lane}" style="justify-content:center">＋ 新建</button>`}</div></div>`
  }
  h += '</div>'
  h += '<div class="iaw-sect-title">事务流模板 / 甘特排程<span class="line"></span></div>'
  h += '<div class="iaw-alert i"><span>▣</span><div class="sp"><b>多步事务流编排（模板库 / SLA / 甘特）属宿主平台事务流引擎能力</b>，当前版本以「任务四泳道」承载执行面；引擎级能力已登记交接清单（docs/handoff-iaw-gaps-to-main.md）。</div></div>'
  h += '</div>'
  return h
}

function viewInbox() {
  const me = session.user?.displayName ?? ''
  const tasks = activeTasks()
  const mine = tasks.filter((t) => t.lane !== 'done' && (t.assigneeName === me || t.lane === 'review'))
  const involved = tasks.filter((t) => t.lane === 'done' && t.assigneeName === me)
  let h = `<div class="iaw-view"><div class="iaw-page-head"><div><h1>我的收件箱</h1><p>${esc(me || '当前用户')} · 待我处理 ${mine.length} 项</p></div></div><div class="iaw-grid-2">`
  h += '<div class="iaw-panel"><div class="iaw-panel-h"><h3>待我处理</h3></div>'
  h += mine.map((t) => `<div class="iaw-elem" style="margin-bottom:8px;border-left:3px solid var(--${t.lane === 'review' ? 'warning' : 'ind'}-500);border-radius:0 10px 10px 0">
    <div class="eh">${esc(t.title)}</div>
    <ul><li>${esc(LANE_LABELS[t.lane] ?? t.lane)} · ${t.assigneeType === 'agent' ? 'Agent 产出' : '同事指派'}${t.sceneCode ? ` · 场景 ${esc(t.sceneCode)}` : ''}</li></ul>
    <div style="display:flex;gap:8px;margin-top:8px">
      ${!state.industryDemo && t.lane !== 'done' ? `<button class="iaw-btn iaw-btn-primary iaw-btn-sm" data-move="${esc(t.id)}" data-to="${LANE_ORDER[LANE_ORDER.indexOf(t.lane) + 1]}">推进到「${LANE_LABELS[LANE_ORDER[LANE_ORDER.indexOf(t.lane) + 1]]}」</button>` : ''}
      ${t.sceneCode ? `<button class="iaw-btn iaw-btn-ghost iaw-btn-sm" data-scene="${esc(t.sceneCode)}">查看场景</button>` : ''}
    </div></div>`).join('') || '<div class="iaw-empty" style="padding:20px">暂无待处理事项——任务被指派给你或停在待审时会出现在这里</div>'
  h += '</div>'
  h += '<div class="iaw-panel"><div class="iaw-panel-h"><h3>我已完成</h3></div><table class="iaw-tbl"><thead><tr><th>任务</th><th>场景</th></tr></thead><tbody>'
  h += involved.map((t) => `<tr><td class="n">${esc(t.title)}</td><td>${t.sceneCode ? `<span class="scene" data-scene="${esc(t.sceneCode)}" style="cursor:pointer;font-family:var(--font-mono);font-size:11px">${esc(t.sceneCode)}</span>` : '—'}</td></tr>`).join('') || '<tr><td colspan="2" style="text-align:center;color:var(--text-tertiary)">暂无完成记录</td></tr>'
  h += '</tbody></table></div>'
  h += '</div></div>'
  return h
}

// ---------------------------------------------------------------------------
// 能力空间：模型渠道 / 四清单
// ---------------------------------------------------------------------------

function viewMChannels() {
  const online = state.models.filter((m) => m.status === 'online').length
  const dshManaged = state.modelSource === 'dsh'
  const canEdit = session.can('panel.config.write') && !dshManaged
  let h = `<div class="iaw-view"><div class="iaw-page-head"><div><h1>模型渠道中心</h1><p>${dshManaged ? '当前为 dsh 配置托管模式（面板只读；增删改请在 dsh 侧完成）' : '模型目录是面板 Agent 调用的唯一事实源 · 调用走真实上游 · 未配置 endpoint 的模型拒绝调用'}</p></div><div class="spacer"></div>
    ${canEdit ? '<button class="iaw-btn iaw-btn-primary" id="iawModelAdd">＋ 接入渠道</button>' : ''}</div>`
  h += '<div class="iaw-metrics-row" style="margin-bottom:16px">'
  h += statCard('可用渠道', `${online}<small>/ ${state.models.length}</small>`, dshManaged ? 'dsh 托管目录' : '目录与 dsh 服务共用', 'neutral')
  h += statCard('协作栏默认', esc(state.models.find((m) => m.slug === state.chatModel)?.displayName ?? '跟随 Agent 资产'), '输入区可切换', 'neutral')
  h += '</div>'
  h += '<div class="iaw-grid-4">'
  h += state.models.map((m) => `<div class="iaw-mchan ${m.status === 'online' ? '' : 'offline'}">
    <div class="iaw-mchan-t"><span class="iaw-dot ${m.status === 'online' ? 'ok' : 'off'}"></span><span class="nm">${esc(m.displayName || m.slug)}</span><span class="iaw-pill iaw-pill-neutral">${esc(m.provider || '未登记厂商')}</span></div>
    <div class="iaw-mchan-m">${esc(m.slug)} · ${esc(m.endpoint || '未配置 endpoint（拒绝调用）')}</div>
    <div class="iaw-mchan-caps"><span class="iaw-pill iaw-pill-model">挂牌 ${esc(m.listCentsPerKTokens)} 分/千tok</span><span class="iaw-pill iaw-pill-neutral">成本 ${esc(m.costCentsPerKTokens ?? '—')}</span></div>
    <div class="iaw-mchan-caps"><span class="iaw-pill ${m.status === 'online' ? 'iaw-pill-cost' : 'iaw-pill-neutral'}">${m.status === 'online' ? '在线可调用' : '离线'}</span><span class="iaw-pill iaw-pill-neutral">密钥 ${esc(m.apiKey)}</span></div>
    <div class="iaw-mchan-f"><span>真实外呼测试</span><span style="display:flex;gap:6px">
      ${session.can('panel.config.write') ? `<button class="iaw-btn iaw-btn-ghost iaw-btn-sm" data-mtest="${esc(m.slug)}">测试</button>
      ${canEdit ? `<button class="iaw-btn iaw-btn-ghost iaw-btn-sm" data-medit="${esc(m.id)}">编辑</button><button class="iaw-btn iaw-btn-ghost iaw-btn-sm" data-mdel="${esc(m.id)}">删除</button>` : ''}` : ''}
    </span></div></div>`).join('') || '<div class="iaw-empty">模型目录为空：登记后即可在协作会话切换模型、供 Agent 真实调用。</div>'
  h += '</div>'
  h += '<div class="iaw-sect-title">路由规则与降级链<span class="line"></span></div>'
  h += '<div class="iaw-alert i"><span>▣</span><div class="sp"><b>分级路由 / 成本熔断 / 三级降级链属宿主平台模型网关能力</b>（按数据分级路由、超时 5xx 自动降级、遥测 TTFT/TPS），当前版本未接入，已登记交接清单；本页提供渠道登记与真实连通测试。</div></div>'
  h += '</div>'
  return h
}

function capAggregate(pack, kind) {
  const scenes = packScenes(pack)
  const map = new Map()
  for (const s of scenes) {
    for (const item of (s[kind] ?? [])) {
      if (!map.has(item)) map.set(item, [])
      map.get(item).push(s)
    }
  }
  return [...map.entries()].map(([name, arr]) => ({ name, scenes: arr })).sort((a, b) => b.scenes.length - a.scenes.length)
}

function viewCapList(pack, kind) {
  const titles = { tools: ['工具软件清单', '感知检测工具 / 中间件 / SaaS 化工业软件', 'iaw-pill-tool'], models: ['知识模型清单', '信息模型 / 机理模型 / 规则模型 / 智能模型', 'iaw-pill-model'], talent: ['人才技能清单', '技术研发 / 应用实施 / 业务管理 / 运维服务', 'iaw-pill-skill'] }
  const [title, sub, pill] = titles[kind]
  const items = pack ? capAggregate(pack, kind) : []
  let h = `<div class="iaw-view"><div class="iaw-page-head"><div><h1>${title}</h1><p>${esc(state.industry?.name ?? '')} · ${sub} · 来自场景图谱四清单</p></div></div>`
  if (!pack) return h + '<div class="iaw-empty">行业图谱未装载，四清单不可用。</div></div>'
  if (kind === 'talent' && state.skills.length > 0) {
    h += '<div class="iaw-sect-title">可直调技能（skillhub 已上架）<span class="line"></span></div><div class="iaw-grid-4">'
    h += state.skills.map((skill) => `<div class="iaw-panel"><div class="iaw-panel-h"><h3>⚡ ${esc(skill.name)}</h3><span class="iaw-pill iaw-pill-skill">v${esc(skill.version)}</span></div>
      <div style="font-size:12px;color:var(--text-secondary);min-height:34px">${esc(skill.summary || skill.category || '')}</div>
      <button class="iaw-btn iaw-btn-primary iaw-btn-sm" style="margin-top:8px" data-invokeskill="${esc(skill.name)}">在协作栏直调</button></div>`).join('')
    h += '</div>'
  }
  h += `<div class="iaw-sect-title">图谱条目（${items.length} 项）<span class="line"></span></div><div class="iaw-grid-4">`
  h += items.slice(0, 48).map((item) => `<div class="iaw-elem">
    <div class="eh"><span class="d" style="background:var(--ind-500)"></span>${esc(item.name)}<span class="iaw-pill ${pill} cnt">${item.scenes.length} 场景</span></div>
    <ul>${item.scenes.slice(0, 3).map((s) => `<li style="cursor:pointer" data-scene="${esc(s.code)}">${esc(s.code)} ${esc(s.name)}</li>`).join('')}</ul>
    ${item.scenes.length > 3 ? `<div style="font-size:10px;color:var(--text-tertiary);margin-top:6px">等 ${item.scenes.length} 个场景</div>` : ''}
  </div>`).join('') || '<div class="iaw-empty">图谱中暂无该类条目</div>'
  h += '</div></div>'
  return h
}

// ---------------------------------------------------------------------------
// 数据空间：数据要素
// ---------------------------------------------------------------------------

function viewElements(pack) {
  let h = `<div class="iaw-view"><div class="iaw-page-head"><div><h1>数据要素</h1><p>每个结论都必须可回溯 · 无数据时诚实显示缺口</p></div></div>`
  if (!pack) return h + '<div class="iaw-empty">行业图谱未装载，数据要素清单不可用。</div></div>'
  const scenes = packScenes(pack)
  const items = capAggregate(pack, 'data')
  const gaps = scenes.filter((s) => s.data.length < 2 || s.models.length < 2 || s.tools.length < 2 || s.talent.length < 2)
  h += '<div class="iaw-metrics-row" style="margin-bottom:16px">'
  h += statCard('已结构化数据要素', String(items.length), `覆盖 ${new Set(items.flatMap((i) => i.scenes.map((s) => s.code))).size} 个场景`, 'neutral')
  h += statCard('要素缺口场景', String(gaps.length), gaps.length ? '四清单存在薄弱项，建议优先补齐' : '全部场景四清单齐备', gaps.length ? 'down' : 'up')
  h += '</div>'
  h += '<div class="iaw-grid-2">'
  h += `<div class="iaw-panel"><div class="iaw-panel-h"><h3>要素资产（按关联场景数）</h3></div><table class="iaw-tbl"><thead><tr><th>数据要素</th><th>关联场景</th><th></th></tr></thead><tbody>`
  h += items.slice(0, 14).map((item) => `<tr><td class="n">${esc(item.name)}</td><td class="n">${item.scenes.length}</td>
    <td>${item.scenes.slice(0, 2).map((s) => `<span class="scene" data-scene="${esc(s.code)}" style="cursor:pointer;font-family:var(--font-mono);font-size:10px;color:var(--text-link)">${esc(s.code)}</span>`).join(' ')}</td></tr>`).join('')
    || '<tr><td colspan="3" style="text-align:center;color:var(--text-tertiary)">图谱中暂无数据要素条目</td></tr>'
  h += '</tbody></table></div>'
  h += `<div class="iaw-panel"><div class="iaw-panel-h"><h3>要素缺口清单</h3></div>`
  h += gaps.slice(0, 8).map((s) => `<div class="iaw-alert w"><span>▲</span><div class="sp"><b><span data-scene="${esc(s.code)}" style="cursor:pointer">${esc(s.code)} ${esc(s.name)}</span></b><br>四清单：工具 ${s.tools.length} · 模型 ${s.models.length} · 数据 ${s.data.length} · 技能 ${s.talent.length}</div></div>`).join('')
    || '<div class="iaw-empty" style="padding:16px">无缺口</div>'
  h += '<div class="iaw-alert i" style="margin-top:10px"><span>▣</span><div class="sp"><b>数据集接入 / 质量分 / 血缘 / 指标字典属宿主平台数据要素面</b>（resource-core），当前版本未接入，已登记交接清单。</div></div>'
  h += '</div></div></div>'
  return h
}

// ---------------------------------------------------------------------------
// 协作空间：频道会话 / 数字同事 / 成员 / 通知
// ---------------------------------------------------------------------------

function viewRooms() {
  const channels = state.overview?.channels ?? []
  const bridgeIds = new Set(state.bridges.filter((b) => b.purpose === 'channel').map((b) => b.channelId))
  let h = '<div class="iaw-view" style="display:flex;flex-direction:column;gap:12px;height:100%">'
  h += `<div class="iaw-page-head" style="margin-bottom:0"><div><h1>协作频道</h1><p>人 × 数字同事 × 钉钉 · 消息即协作，产物自动沉淀</p></div><div class="spacer"></div>
    ${state.industryDemo ? '' : '<button class="iaw-btn iaw-btn-primary" id="iawNewChannel">＋ 发起协作</button>'}</div>`
  h += '<div class="iaw-chips">' + channels.map((c) => `
    <span class="iaw-chip2 ${c.id === state.channelId ? 'on' : ''}" data-channel="${esc(c.id)}"># ${esc(c.name)}
    ${bridgeIds.has(c.id) ? '<span title="已绑定钉钉群桥">⇄</span>' : ''}
    ${c.unread > 0 ? `<span class="iaw-badge-n" style="position:static">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</span>`).join('') + '</div>'
  h += `<div class="iaw-card" style="flex:1;min-height:420px;display:flex;flex-direction:column;overflow:hidden">
    <div class="iaw-msgs" id="iawRoomsMsgs" style="flex:1"></div>
    ${composerHtml('rooms')}
  </div></div>`
  return h
}

function viewAgents() {
  const agents = state.overview?.dept?.agents ?? []
  let h = `<div class="iaw-view"><div class="iaw-page-head"><div><h1>数字同事</h1><p>${esc(state.overview?.dept?.label ?? '')} Agent 阵容 · 绑定 Agent 资产后可真实调用（面板配置中绑定）</p></div></div><div class="iaw-grid-3">`
  h += agents.map((agent) => `<div class="iaw-panel">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <div style="width:36px;height:36px;border-radius:10px;background:var(--ind-500);color:#fff;display:grid;place-items:center;font-size:16px">${esc(agent.icon)}</div>
      <div><div style="font-size:14px;font-weight:500">${esc(agent.name)}</div>
      <div style="font-size:11px;color:var(--text-tertiary)">${agent.asset ? `资产 ${esc(agent.asset.name)} · ${agent.asset.status === 'online' ? '在线' : esc(agent.asset.status)}${agent.asset.model ? ` · ${esc(agent.asset.model)}` : ''}` : '未绑定 Agent 资产'}</div></div>
    </div>
    <div style="font-size:12px;color:var(--text-secondary);min-height:34px">${esc(agent.desc)}</div>
    <div style="display:flex;gap:8px;margin-top:8px">
      ${state.industryDemo
        ? '<button class="iaw-btn iaw-btn-ghost iaw-btn-sm" disabled title="演示预览（只读）——激活行业后可唤起">@ 唤起协作</button>'
        : `<button class="iaw-btn iaw-btn-primary iaw-btn-sm" data-atagent="${esc(agent.name)}">@ 唤起协作</button>`}
    </div></div>`).join('') || '<div class="iaw-empty">本部门暂无 Agent 阵容（面板配置中添加）</div>'
  h += '</div>'
  h += `<div class="iaw-sect-title">执行原则<span class="line"></span></div>
  <div class="iaw-alert i"><span>▣</span><div class="sp"><b>自治级别说明</b>：数字同事的产出在「待审」泳道落账，需人工确认后才进入下游（人机协作门禁）；跨运行时（Hermes / OpenClaw / WorkBuddy）的 A2A 协议接入属宿主平台 agent 域，已登记交接清单。</div></div>`
  h += '</div>'
  return h
}

function viewMembers() {
  const members = state.overview?.members ?? []
  const me = session.user
  let h = `<div class="iaw-view"><div class="iaw-page-head"><div><h1>成员</h1><p>${esc(state.overview?.dept?.label ?? '')}名册 · ${members.length} 人${state.overview?.org ? ` · 组织 ${esc(state.overview.org.name)}` : ''}</p></div></div>`
  if (me) {
    h += `<div class="iaw-alert i"><span>▣</span><div class="sp">当前身份：<b>${esc(me.displayName ?? me.name ?? me.id)}</b>${me.roles?.length ? ` · 角色 ${me.roles.map((r) => esc(r.name ?? r)).join(' / ')}` : ''}</div></div>`
  }
  h += '<div class="iaw-panel"><table class="iaw-tbl"><thead><tr><th>姓名</th><th>职务</th><th>组织</th><th></th></tr></thead><tbody>'
  h += members.map((m) => `<tr><td class="n">${esc(m.name)}</td><td>${esc(m.title ?? '—')}</td><td>${esc(m.orgName ?? '—')}</td>
    <td>${state.industryDemo
      ? '<button class="iaw-btn iaw-btn-ghost iaw-btn-sm" disabled title="演示预览（只读）——激活行业后可唤起">@ 唤起</button>'
      : `<button class="iaw-btn iaw-btn-ghost iaw-btn-sm" data-atagent="${esc(m.name)}">@ 唤起</button>`}</td></tr>`).join('')
    || '<tr><td colspan="4" style="text-align:center;color:var(--text-tertiary)">名册为空（组织目录缺失或部门未绑定组织）</td></tr>'
  h += '</tbody></table>'
  h += '<div class="iaw-alert i" style="margin-top:10px"><span>▣</span><div class="sp"><b>场景级授权（角色分级的 ABAC 细粒度授权）属宿主平台 iam 域能力</b>，已登记交接清单。</div></div>'
  h += '</div></div>'
  return h
}

function viewNotice() {
  const review = activeTasks().filter((t) => t.lane === 'review')
  const unreadChannels = (state.overview?.channels ?? []).filter((c) => c.unread > 0)
  let h = `<div class="iaw-view"><div class="iaw-page-head"><div><h1>通知中心</h1><p>任务、门禁、未读、实时动态（内存保留最近 100 条）</p></div></div><div class="iaw-grid-2">`
  h += '<div class="iaw-panel"><div class="iaw-panel-h"><h3>门禁与未读</h3></div>'
  h += review.map((t) => `<div class="iaw-alert w"><span>▲</span><div class="sp"><b>任务待审：${esc(t.title)}</b><br>${t.assigneeType === 'agent' ? 'Agent 产出' : '同事提交'}${t.sceneCode ? ` · 场景 ${esc(t.sceneCode)}` : ''}</div>
    ${state.industryDemo ? '' : `<button class="iaw-btn iaw-btn-primary iaw-btn-sm" data-move="${esc(t.id)}" data-to="done">确认通过</button>`}</div>`).join('')
  h += unreadChannels.map((c) => `<div class="iaw-alert i"><span>💬</span><div class="sp"><b># ${esc(c.name)}</b><br>${c.unread} 条未读消息</div><button class="iaw-btn iaw-btn-ghost iaw-btn-sm" data-channel="${esc(c.id)}">去查看</button></div>`).join('')
  h += (review.length + unreadChannels.length === 0) ? '<div class="iaw-empty" style="padding:16px">暂无待办通知</div>' : ''
  h += '</div>'
  h += `<div class="iaw-panel"><div class="iaw-panel-h"><h3>实时动态</h3></div><div class="iaw-tl">`
  h += state.notices.slice(0, 30).map((n) => `<div class="iaw-tl-item"><span class="tt">${esc(fmtTime(n.at))}</span> · ${esc(n.text)}</div>`).join('') || '<div class="iaw-empty" style="padding:16px">暂无动态——实时事件到达后自动出现在这里</div>'
  h += '</div></div>'
  h += '</div></div>'
  return h
}

// ---------------------------------------------------------------------------
// 视图事件绑定
// ---------------------------------------------------------------------------

function wireView(host) {
  host.querySelectorAll('[data-atagent]').forEach((el) => {
    el.onclick = () => atMention(el.dataset.atagent)
  })
  host.querySelectorAll('[data-scene]').forEach((el) => {
    el.onclick = (event) => {
      event.stopPropagation()
      void openScene(el.dataset.scene)
    }
  })
  host.querySelectorAll('[data-thread]').forEach((el) => {
    el.onclick = () => { state.thread = el.dataset.thread; renderView() }
  })
  host.querySelectorAll('[data-tag]').forEach((el) => {
    el.onclick = () => {
      const t = el.dataset.tag
      if (state.tagFilter.has(t)) state.tagFilter.delete(t)
      else state.tagFilter.add(t)
      renderView()
    }
  })
  // 场景对比：点击场景卡加入/移除（≤3 个，FIFO 淘汰最旧）
  host.querySelectorAll('[data-cmp]').forEach((el) => {
    el.onclick = () => {
      const code = el.dataset.cmp
      const at = state.compare.indexOf(code)
      if (at >= 0) state.compare.splice(at, 1)
      else {
        state.compare.push(code)
        while (state.compare.length > 3) state.compare.shift()
      }
      renderView()
    }
  })
  const cmpSearch = host.querySelector('#iawCmpSearch')
  if (cmpSearch) {
    cmpSearch.oninput = () => {
      const q = cmpSearch.value.trim().toLowerCase()
      host.querySelectorAll('[data-cmp]').forEach((n) => {
        n.style.display = !q || n.dataset.code.toLowerCase().includes(q) || n.dataset.name.toLowerCase().includes(q) ? '' : 'none'
      })
    }
  }
  const sceneSearch = host.querySelector('#iawSceneSearch')
  if (sceneSearch) {
    sceneSearch.oninput = () => {
      const q = sceneSearch.value.trim().toLowerCase()
      host.querySelectorAll('.iaw-node').forEach((n) => {
        n.style.display = !q || n.dataset.code.toLowerCase().includes(q) || n.dataset.name.toLowerCase().includes(q) ? '' : 'none'
      })
    }
  }
  host.querySelectorAll('[data-bplat]').forEach((el) => {
    el.onclick = async () => {
      state.boardPlatform = el.dataset.bplat
      localStorage.setItem('panel_board_platform', state.boardPlatform)
      state.board = null
      await refreshView()
    }
  })
  host.querySelectorAll('[data-move]').forEach((el) => {
    el.onclick = async (event) => {
      event.stopPropagation()
      if (previewLocked()) return
      try {
        await api.post(`/api/panel/tasks/${el.dataset.move}/transition`, { lane: el.dataset.to })
        await refreshView()
        void refreshOverview()
      } catch (error) { void toast(error.message, 'error') }
    }
  })
  host.querySelectorAll('[data-addlane]').forEach((el) => {
    el.onclick = () => showNewTask(el.dataset.addlane)
  })
  host.querySelectorAll('[data-task]').forEach((el) => {
    el.onclick = (event) => {
      if (event.target.closest('[data-move],[data-scene]')) return
      const task = activeTasks().find((t) => t.id === el.dataset.task)
      if (task?.sceneCode) void openScene(task.sceneCode)
      else showNewTask(task?.lane ?? 'todo')
    }
  })
  const newTask = host.querySelector('#iawNewTask')
  if (newTask) newTask.onclick = () => showNewTask('todo')
  const gateJump = host.querySelector('#iawGateJump')
  if (gateJump) gateJump.onclick = () => { state.space = 'collab'; state.nav = 'notice'; renderSeg(); renderNav(); void refreshView() }
  host.querySelectorAll('[data-mtest]').forEach((el) => {
    el.onclick = async () => {
      el.disabled = true
      try {
        // 真实外呼可能慢于默认 20s（QA BUG-U-03 超时豁免项）
        const result = await api.post(`/api/panel/models/${encodeURIComponent(el.dataset.mtest)}/test`, {}, { timeoutMs: 60_000 })
        richToast(result.ok ? '连通正常' : '连通失败', result.ok ? `${esc(result.model)} · 输出 ${result.outputTokens} tokens（按量计费）` : esc(result.error), result.ok ? undefined : 'danger')
      } catch (error) {
        void toast(error.message, 'error')
      } finally {
        el.disabled = false
      }
    }
  })
  const modelAdd = host.querySelector('#iawModelAdd')
  if (modelAdd) modelAdd.onclick = () => showModelForm(null)
  host.querySelectorAll('[data-medit]').forEach((el) => {
    el.onclick = () => showModelForm(state.models.find((m) => m.id === el.dataset.medit) ?? null)
  })
  host.querySelectorAll('[data-mdel]').forEach((el) => {
    el.onclick = async () => {
      const model = state.models.find((item) => item.id === el.dataset.mdel)
      if (!window.confirm(`确定从模型目录移除「${model?.slug ?? el.dataset.mdel}」？（绑定该模型的 Agent 将无法调用）`)) return
      el.disabled = true
      try {
        await api.delete(`/api/panel/models/${el.dataset.mdel}`)
        void toast('已移除模型登记')
        await refreshModels()
        renderView()
      } catch (error) {
        el.disabled = false
        void toast(error.message, 'error')
      }
    }
  })
  host.querySelectorAll('[data-invokeskill]').forEach((el) => {
    el.onclick = () => insertSkill(el.dataset.invokeskill)
  })
  const newChannel = host.querySelector('#iawNewChannel')
  if (newChannel) newChannel.onclick = () => showNewChannel()
  host.querySelectorAll('[data-channel]').forEach((el) => {
    el.onclick = async () => {
      state.channelId = el.dataset.channel
      localStorage.setItem(`panel_channel_${state.dept}`, state.channelId)
      state.messages = []
      await refreshView()
    }
  })
  wireComposer(host)
}

// ---------------------------------------------------------------------------
// 场景详情抽屉（五 Tab：概览 / 四要素 / 痛点 / 事务流 / 协作）
// ---------------------------------------------------------------------------

function findSceneLocal(code) {
  const pack = state.scenegraph?.pack
  if (!pack) return null
  for (const [activity, scenes] of Object.entries(pack.activities)) {
    const hit = (scenes ?? []).find((s) => s.code === code)
    if (hit) return { pack, activity, scene: hit }
  }
  return null
}

async function openScene(code) {
  let hit = findSceneLocal(code)
  if (!hit) {
    // 跨行业场景（任务/消息引用了其他行业图谱的场景）：按编号前缀懒加载对应图谱包
    const prefix = String(code).split('-')[0]?.toUpperCase()
    if (/^[A-Z][A-Z0-9]{2,9}$/.test(prefix) && prefix !== state.industry?.code) {
      try {
        const res = await api.get(`/api/panel/scenegraph?industry=${prefix}`)
        hit = (() => {
          for (const [activity, scenes] of Object.entries(res.pack.activities)) {
            const found = (scenes ?? []).find((s) => s.code === code)
            if (found) return { pack: res.pack, activity, scene: found }
          }
          return null
        })()
      } catch { /* 未装载：诚实提示 */ }
    }
  }
  if (!hit) { void toast(`场景 ${code} 不在已装载的行业图谱中`, 'error'); return }
  state.scene = code
  state.sceneTab = 0
  renderDrawer(hit)
  $id('iawScrim')?.classList.add('open')
  $id('iawDrawer')?.classList.add('open')
  renderCtx()
  document.querySelectorAll('.iaw-node').forEach((n) => n.classList.toggle('on', n.dataset.code === code))
}

function closeDrawer() {
  $id('iawScrim')?.classList.remove('open')
  $id('iawDrawer')?.classList.remove('open')
}

function sceneTasks(code) {
  return activeTasks().filter((t) => t.sceneCode === code)
}

function sceneMessages(code) {
  return activeMessages().filter((m) => m.sceneCode === code)
}

function renderDrawer(hit) {
  const { pack, activity, scene } = hit
  const tabs = ['概览', '四要素', '痛点分析', '事务流', '协作']
  if (!$id('iawDrawer')) {
    $id('iawApp').insertAdjacentHTML('beforeend', `
      <div class="iaw-scrim" id="iawScrim"></div>
      <div class="iaw-drawer" id="iawDrawer"></div>`)
    $id('iawScrim').onclick = closeDrawer
  }
  const link = sceneLinkKey(scene, pack.links ?? []).map((l) => (l.name && l.name !== l.key) ? `${l.key} ${l.name}` : l.key).join(' · ') || '—'
  const elemTotal = scene.tools.length + scene.models.length + scene.data.length + scene.talent.length

  let body = ''
  if (state.sceneTab === 0) {
    body += `<div class="iaw-dl" style="margin-bottom:16px">
      <dt>场景编号</dt><dd class="mono">${esc(scene.code)}</dd>
      <dt>环节</dt><dd>${esc(link)}</dd>
      <dt>业务活动</dt><dd>${esc(ACT_LABELS[activity] ?? activity)}</dd>
      <dt>现状评级</dt><dd>${stars(scene.s)} <span style="color:var(--text-tertiary);font-size:11px">（${scene.s}/4）</span></dd>
      <dt>转型价值</dt><dd>${scene.tags.map(tagPill).join(' ') || '<span style="color:var(--text-tertiary)">原文未标注</span>'}</dd>
      <dt>四要素</dt><dd>▣ ${elemTotal} 项（工具 ${scene.tools.length} · 模型 ${scene.models.length} · 数据 ${scene.data.length} · 技能 ${scene.talent.length}）</dd>
      <dt>出处</dt><dd>《参考指引（2025 版）》附件 · 场景图谱原文</dd></div>`
    body += `<div class="iaw-sect-title" style="margin-top:4px">关联执行</div><div class="iaw-grid-3">
      ${statCard('关联任务', String(sceneTasks(scene.code).length), '', 'neutral')}
      ${statCard('频道讨论', String(sceneMessages(scene.code).length), '', 'neutral')}
      ${statCard('诊断', sceneTasks(scene.code).some((t) => t.title.includes('诊断')) ? '已发起' : '未发起', '', 'neutral')}
    </div>`
    body += `<div class="iaw-sect-title">最近动态</div><div class="iaw-tl">`
    const dynamics = [
      ...sceneTasks(scene.code).map((t) => ({ at: t.createdAt, text: `任务「${t.title}」· ${LANE_LABELS[t.lane] ?? t.lane}` })),
      ...sceneMessages(scene.code).map((m) => ({ at: m.createdAt, text: `${m.senderName}：${m.text.slice(0, 40)}` })),
    ].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
    body += dynamics.slice(0, 6).map((d) => `<div class="iaw-tl-item"><span class="tt">${esc(fmtTime(d.at))}</span> · ${esc(d.text)}</div>`).join('')
      || '<div class="iaw-empty" style="padding:12px">暂无动态——派发诊断或创建任务后出现在这里</div>'
    body += '</div>'
  } else if (state.sceneTab === 1) {
    const groups = [['工具软件', 'tools', 'var(--accent-indigo)'], ['知识模型', 'models', 'var(--accent-amber)'], ['数据要素', 'data', 'var(--accent-teal)'], ['人才技能', 'talent', 'var(--accent-violet)']]
    body += '<div class="iaw-alert i"><span>▣</span><div class="sp">本场景四要素为指引原文条目；要素缺口将驱动改造计划与诊断建议。</div></div>'
    for (const [label, key, color] of groups) {
      body += `<div class="iaw-elem" style="margin-bottom:12px"><div class="eh"><span class="d" style="background:${color}"></span>${label}<span class="iaw-pill iaw-pill-neutral cnt">${scene[key].length} 项</span></div><ul>
        ${scene[key].map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
    }
  } else if (state.sceneTab === 2) {
    body += `<div class="iaw-pain">${esc(scene.pain)}</div>`
    body += `<div class="iaw-sect-title" style="margin-top:0">要素完备度</div><div class="iaw-grid-4">
      ${statCard('工具软件', String(scene.tools.length), scene.tools.length < 2 ? '待补全' : '可用', scene.tools.length < 2 ? 'down' : 'up')}
      ${statCard('知识模型', String(scene.models.length), scene.models.length < 2 ? '待补全' : '可用', scene.models.length < 2 ? 'down' : 'up')}
      ${statCard('数据要素', String(scene.data.length), scene.data.length < 2 ? '待补全' : '可用', scene.data.length < 2 ? 'down' : 'up')}
      ${statCard('人才技能', String(scene.talent.length), scene.talent.length < 2 ? '待补全' : '可用', scene.talent.length < 2 ? 'down' : 'up')}
    </div>`
    body += `<div style="margin-top:14px;display:flex;gap:8px">
      ${state.industryDemo ? '' : `<button class="iaw-btn iaw-btn-primary" id="iawDrDiag">🤖 派数字同事诊断</button>
      <button class="iaw-btn iaw-btn-ghost" id="iawDrSyncDD">📤 同步钉钉群</button>`}
      ${state.industryDemo ? '<span class="iaw-pill iaw-pill-neutral" style="align-self:center" title="演示预览（只读）">🔒 激活后可派诊断 / 同步钉钉</span>' : ''}</div>`
  } else if (state.sceneTab === 3) {
    const related = sceneTasks(scene.code)
    body += `<div class="iaw-panel" style="box-shadow:none;border:1px solid var(--border-subtle)"><div class="iaw-panel-h"><h3>该场景的执行任务</h3><div class="spacer"></div>
      ${!state.industryDemo && session.can('panel.task.write') ? `<button class="iaw-btn iaw-btn-primary iaw-btn-sm" id="iawDrNewTask">＋ 新建任务</button>` : ''}</div>`
    body += related.map((t) => `<div class="iaw-elem" style="margin-bottom:8px"><div class="eh">${esc(t.title)}<span class="iaw-pill iaw-pill-neutral cnt">${LANE_LABELS[t.lane] ?? t.lane}</span></div>
      <ul><li>${t.assigneeType === 'agent' ? '🤖' : '🧑'} ${esc(t.assigneeName ?? '未指派')}</li></ul></div>`).join('')
      || '<div class="iaw-empty" style="padding:12px">暂无任务——从模板创建或交给数字同事</div>'
    body += '</div>'
    body += `<div class="iaw-alert i" style="margin-top:12px"><span>▣</span><div class="sp"><b>场景级事务流模板（多步编排 + SLA）属宿主平台事务流引擎能力</b>，已登记交接清单；当前以单任务承载。</div></div>`
  } else {
    const msgs = sceneMessages(scene.code)
    body += `<div class="iaw-panel" style="box-shadow:none;border:1px solid var(--border-subtle)"><div class="iaw-panel-h"><h3>频道内讨论 · ${esc(scene.code)}</h3></div>`
    body += msgs.length ? msgs.slice(-8).map((m) => `<div class="iaw-tl-item" style="padding:8px 0"><span class="tt">${esc(fmtTime(m.createdAt))}</span> · <b>${esc(m.senderName)}</b> · ${esc(m.text.slice(0, 60))}</div>`).join('')
      : '<div class="iaw-empty" style="padding:12px">当前频道暂无该场景的讨论——在协作栏 @数字同事 并带上场景编号即可关联</div>'
    body += `<button class="iaw-btn iaw-btn-ghost iaw-btn-sm" style="margin-top:10px" id="iawDrGotoChat">进入协作频道</button></div>`
  }

  $id('iawDrawer').innerHTML = `
    <div class="iaw-dr-h"><div class="r1"><span class="code">${esc(scene.code)}</span>
      <span class="iaw-pill ${scene.type === '主场景' ? 'iaw-pill-new' : 'iaw-pill-neutral'}">${esc(scene.type)}</span>
      <div style="margin-left:auto;display:flex;gap:6px"><button class="iaw-btn iaw-btn-ghost iaw-btn-sm" id="iawDrClose">✕</button></div></div>
      <h2>${esc(scene.name)}</h2>
      <div class="meta">${stars(scene.s)}${scene.tags.map(tagPill).join('')}
      <span class="iaw-pill iaw-pill-tool">▣ 要素 ${elemTotal} 项</span></div></div>
    <div class="iaw-dr-tabs">${tabs.map((t, i) => `<button class="${i === state.sceneTab ? 'on' : ''}" data-drtab="${i}">${t}${i === 1 ? `<span class="cnt">${elemTotal}</span>` : ''}${i === 3 ? `<span class="cnt">${sceneTasks(scene.code).length}</span>` : ''}</button>`).join('')}</div>
    <div class="iaw-dr-body">${body}</div>
    <div class="iaw-dr-foot">
      ${!state.industryDemo && session.can('panel.write') ? '<button class="iaw-btn iaw-btn-primary" id="iawDrDiagFoot">🤖 交给数字同事诊断</button>' : ''}
      ${state.industryDemo ? '' : '<button class="iaw-btn iaw-btn-ghost" id="iawDrAsk">✍ 让协作栏继续推进</button>'}
      ${state.industryDemo ? '<span style="align-self:center;font-size:11px;color:var(--text-tertiary)">演示预览（只读）——激活后可派诊断与协作推进</span>' : ''}
    </div>`

  $id('iawDrClose').onclick = closeDrawer
  $id('iawDrawer').querySelectorAll('[data-drtab]').forEach((el) => {
    el.onclick = () => { state.sceneTab = Number(el.dataset.drtab); renderDrawer(hit) }
  })
  const diag = () => void diagnoseScene(scene.code)
  $id('iawDrDiag')?.addEventListener('click', diag)
  $id('iawDrDiagFoot')?.addEventListener('click', diag)
  $id('iawDrSyncDD')?.addEventListener('click', (event) => void syncSceneToDingtalk(scene.code, event.currentTarget))
  $id('iawDrNewTask')?.addEventListener('click', () => showNewTask('todo', scene.code))
  $id('iawDrGotoChat')?.addEventListener('click', () => {
    closeDrawer()
    state.space = 'collab'; state.nav = 'rooms'
    renderSeg(); renderNav()
    void refreshView()
  })
  $id('iawDrAsk')?.addEventListener('click', () => {
    closeDrawer()
    state.railMode = 'panel'
    renderAgentRail()
    const input = $id('iawComposerInput')
    if (input) {
      input.value = `请针对场景 ${scene.code} ${scene.name} 给出改造建议（现状 ${'★'.repeat(Math.min(4, scene.s))}，痛点：${scene.pain.slice(0, 40)}…）`
      saveDraft(input)
      input.focus()
    }
  })
}

/** 派数字同事诊断（真实端点：生成任务 + 频道系统行，协作栏跟进）。 */
async function diagnoseScene(code) {
  if (previewLocked()) return
  try {
    await api.post(`/api/panel/${state.dept}/scenes/${code}/diagnose`)
    closeDrawer()
    richToast('诊断已派发', `场景 <b>${esc(code)}</b> 的诊断任务已生成，协作栏/频道内可跟进。`)
    await refreshView()
    void refreshOverview()
  } catch (error) {
    void toast(error.message, 'error')
  }
}

/** 场景卡同步钉钉（QA BUG-G-03 前置状态检查三连：连接器/绑定/群桥）。 */
async function syncSceneToDingtalk(code, btn) {
  if (previewLocked()) return
  if (!state.ddStatus?.connector?.configured) {
    void toast('钉钉桥接未配置：请联系管理员在控制台「三方集成」配置钉钉连接器', 'error')
    return
  }
  if (!state.ddStatus?.bound) {
    void toast('尚未绑定钉钉账号：请点击顶栏 ⇄ 完成扫码绑定', 'error')
    void showBind()
    return
  }
  const deptBridge = state.bridges.some((b) => b.purpose === 'channel' && (!b.dept || b.dept === state.dept))
  if (!deptBridge) {
    void toast('本部门尚未绑定钉钉群桥：请联系管理员绑定群后重试', 'error')
    return
  }
  btn.disabled = true
  try {
    await api.post(`/api/panel/${state.dept}/scenes/${code}/sync-dingtalk`)
    void toast('场景卡已请求同步至钉钉协作群')
  } catch (error) {
    void toast(error.message, 'error')
  } finally {
    btn.disabled = false
  }
}

// ---------------------------------------------------------------------------
// 右侧 Agent 协作栏（常驻：上下文条 + 会话 + 输入区；hostBridge 在场可切 dsh 对话）
// ---------------------------------------------------------------------------

function renderAgentRail() {
  const rail = $id('iawAgent')
  if (!rail) return
  const dept = state.overview?.dept
  const dshMode = state.railMode === 'dsh' && canEmbedDshChat()
  rail.innerHTML = `
    <div class="iaw-agent-h">
      <div class="iaw-agent-ava">${dshMode ? '🤖' : '榕'}<span class="st" style="background:var(--success-500)"></span></div>
      <div><div class="nm">${dshMode ? 'dsh 标准对话' : esc(dept?.label ?? '') + ' · 数字同事协作'}</div>
      <div class="rl">${dshMode ? '完整 Agent 运行时 · 在新窗口打开可脱手作业' : '门禁确认 · 产物沉淀 · 钉钉同步'}</div></div>
      ${canEmbedDshChat() ? `<button class="iaw-chip2 ${dshMode ? '' : 'on'}" id="iawRailPanel" style="margin-left:auto" title="面板会话（频道内协作）">面板</button>
      <button class="iaw-chip2 ${dshMode ? 'on' : ''}" id="iawRailDsh" title="内嵌 dsh 标准对话">dsh</button>` : ''}
    </div>
    ${dshMode ? `
      <div class="iaw-ctxbar"><span class="iaw-ctx">内嵌 dsh 对话 · <b id="iawRailBack" style="cursor:pointer;color:var(--text-link)">使用面板会话</b></span>
      <span class="iaw-ctx">📋 <b id="iawRailCtxCopy" style="cursor:pointer;color:var(--text-link)">携带部门上下文</b></span></div>
      <iframe style="flex:1;border:none;background:#fff" src="/" title="dsh 对话" referrerpolicy="same-origin"></iframe>
    ` : `
      <div class="iaw-ctxbar" id="iawCtxBar"></div>
      <div class="iaw-msgs" id="iawMsgs"></div>
      ${composerHtml('rail')}
    `}`
  if (canEmbedDshChat()) {
    $id('iawRailPanel').onclick = () => { state.railMode = 'panel'; localStorage.setItem('iaw_rail_mode', 'panel'); renderAgentRail(); renderConversation($id('iawMsgs')) }
    $id('iawRailDsh').onclick = () => { state.railMode = 'dsh'; localStorage.setItem('iaw_rail_mode', 'dsh'); renderAgentRail() }
    $id('iawRailCtxCopy')?.addEventListener('click', async () => {
      const context = `【01门·${dept?.label ?? ''}】行业 ${state.industry?.code ?? '未激活'} · 请围绕该部门场景协作（面板：${location.origin}${basePath()}/panel/?dept=${state.dept}）`
      try {
        await navigator.clipboard.writeText(context)
        void toast('上下文已复制——粘贴到对话即可让 Agent 进入该部门语境')
      } catch {
        void toast(context, 'info')
      }
    })
    $id('iawRailBack')?.addEventListener('click', () => { state.railMode = 'panel'; localStorage.setItem('iaw_rail_mode', 'panel'); renderAgentRail(); renderConversation($id('iawMsgs')) })
  }
  renderCtx()
  renderConversation($id('iawMsgs'))
}

/** 上下文条：当前场景/行业/渠道/模型 语境 chips（场景详情选中后注入）。 */
function renderCtx() {
  const bar = $id('iawCtxBar')
  if (!bar) return
  const scene = state.scene ? findSceneLocal(state.scene)?.scene : null
  const channel = (state.overview?.channels ?? []).find((c) => c.id === state.channelId)
  const chips = scene
    ? [`<span class="iaw-ctx">场景 <b>${esc(scene.code)}</b></span>`,
      `<span class="iaw-ctx">评级 <b>${'★'.repeat(Math.min(4, scene.s))}</b></span>`,
      `<span class="iaw-ctx">频道 <b># ${esc(channel?.name ?? '未选')}</b></span>`,
      `<span class="iaw-ctx" id="iawCtxClear" style="cursor:pointer">✕ 清除场景语境</span>`]
    : [`<span class="iaw-ctx">行业 <b>${esc(state.industry?.name ?? '未激活')}</b></span>`,
      `<span class="iaw-ctx">部门 <b>${esc(state.overview?.dept?.label ?? '—')}</b></span>`,
      `<span class="iaw-ctx">频道 <b># ${esc(channel?.name ?? '未选')}</b></span>`,
      `<span class="iaw-ctx">主渠道 <b>${esc(state.models.find((m) => m.slug === state.chatModel)?.displayName ?? '跟随 Agent')}</b></span>`]
  bar.innerHTML = chips.join('')
  $id('iawCtxClear')?.addEventListener('click', () => {
    state.scene = null
    renderCtx()
    renderView()
  })
}

// ---------------------------------------------------------------------------
// 会话渲染与发送（协作栏 + 频道视图共用）
// ---------------------------------------------------------------------------

function messageHtml(m, ddBound) {
  // 技能执行卡（本地瞬时态）：调用中转圈 / 异常阻断红卡；成功态以应答消息呈现。
  if (m.kind === 'skill-exec') {
    if (m.state === 'blocked') {
      return `<div class="iaw-msg"><div class="av" style="background:var(--danger-500)">⚡</div>
        <div class="bd"><div class="meta">${esc(m.skillName)} <span class="role" style="color:var(--danger-600)">执行失败</span></div>
        <div class="iaw-skill-exec blocked"><b>调用没有成功：</b>${esc(m.reason ?? '未知原因')}
          ${m.raw ? `<div><button class="iaw-btn iaw-btn-ghost iaw-btn-sm" data-retry="${esc(m.raw)}">↻ 重试</button></div>` : ''}</div></div></div>`
    }
    return `<div class="iaw-msg"><div class="av" style="background:#6366f1">⚡</div>
      <div class="bd"><div class="meta">${esc(m.skillName)} <span class="role">技能执行中</span></div>
      <div class="iaw-skill-exec"><span class="iaw-se-spin"></span> 正在执行「${esc(m.skillName)}」${esc(m.text ? `：${m.text.slice(0, 40)}` : '')}…</div></div></div>`
  }
  if (m.senderType === 'system') return `<div class="iaw-sys">⚡ ${md(m.text)}</div>`
  // 演示预览消息（previewMessages 派生）：meta 打「演示」徽标；操作卡按钮禁用（title 说明原因）
  const demoBadge = m.demo ? '<span class="role demo">演示</span>' : ''
  const ddBadge = m.ddSync === 'sent'
    ? '<div style="font-size:10px;color:var(--text-tertiary);margin-top:4px">⇄ 已同步钉钉</div>'
    : m.ddSync === 'pending' ? '<div style="font-size:10px;color:var(--text-tertiary);margin-top:4px">⇄ 钉钉投递中…</div>'
      : m.ddSync === 'failed' ? '<div style="font-size:10px;color:var(--danger-600);margin-top:4px">⇄ 钉钉投递失败</div>'
        : ''
  const card = m.card
    ? `<div class="card"><div class="t">${esc(m.card.title)}</div><div class="ops">${m.card.ops.map((op) => {
        const done = m.card.done.includes(op.id)
        const locked = state.industryDemo && !done
        return `<button class="iaw-btn ${done ? 'iaw-btn-ghost' : op.style === 'dd' ? 'iaw-btn-ghost' : 'iaw-btn-primary'} iaw-btn-sm"
          data-op="${esc(op.id)}" data-msg="${esc(m.id)}" ${done || state.industryDemo ? 'disabled' : ''}${locked ? ' title="演示数据——激活行业后可执行"' : ''}>${esc(op.label)}${done ? ' ✓' : ''}</button>`
      }).join('')}
      </div></div>`
    : ''
  if (m.senderType === 'human' && m.senderId && m.senderId === session.user?.id) {
    return `<div class="iaw-msg u"><div class="av" style="background:var(--warning-500)">我</div>
      <div class="bd"><div class="meta" style="justify-content:flex-end">${esc(m.senderName)}${demoBadge}</div><div>${md(m.text)}</div>${ddBadge}</div></div>`
  }
  if (m.senderType === 'agent') {
    return `<div class="iaw-msg a"><div class="av">${esc(m.senderIcon ?? '🤖')}</div>
      <div class="bd"><div class="meta">${esc(m.senderName)} <span class="role">Agent</span>${m.model ? `<span class="role">🧠 ${esc(m.model)}</span>` : ''}${demoBadge}</div>
      <div>${md(m.text)}</div>${card}${ddBadge}</div></div>`
  }
  const fromDd = m.ddSync === 'origin'
  return `<div class="iaw-msg"><div class="av" style="background:var(--neutral-500)">${esc((m.senderName ?? '?').slice(0, 1))}</div>
    <div class="bd"><div class="meta">${esc(m.senderName)}${fromDd ? '<span class="role">● 来自钉钉</span>' : ''}${demoBadge}</div>
    <div>${md(m.text)}</div>${card}${ddBadge}</div></div>`
}

function renderConversation(host) {
  if (!host) return
  const ddBound = Boolean(state.ddStatus?.bound)
  // 演示预览态：频道会话整体切到确定性演示数据（与真实频道/消息无关，只读）
  if (state.industryDemo) {
    host.innerHTML = previewMessages().map((m) => messageHtml(m, ddBound)).join('')
    host.querySelectorAll('[data-scene]').forEach((el) => {
      el.onclick = () => void openScene(el.dataset.scene)
    })
    host.scrollTop = host.scrollHeight
    return
  }
  if (!state.channelId) {
    host.innerHTML = '<div class="iaw-empty">本部门还没有协作频道——在「协作空间 · 协作频道」发起。</div>'
    return
  }
  const streamHtml = [...streamCards.values()].map((card) => `
    <div class="iaw-msg a"><div class="av">${esc(card.icon)}</div>
      <div class="bd"><div class="meta">${esc(card.name)} <span class="role">Agent</span>${card.model ? `<span class="role">🧠 ${esc(card.model)}</span>` : ''}${card.fallback ? '<span class="role" style="color:var(--warning-600)">转人工</span>' : ''}</div>
      <div class="iaw-stream">${md(card.text)}${card.fallback ? '' : '<span class="cursor"></span>'}</div></div></div>`).join('')
  host.innerHTML = activeMessages().map((m) => messageHtml(m, ddBound)).join('') + streamHtml
  host.querySelectorAll('[data-op]').forEach((el) => {
    el.onclick = () => void doCardAction(el.dataset.msg, el.dataset.op, el)
  })
  host.querySelectorAll('[data-retry]').forEach((el) => {
    el.onclick = () => {
      const input = $id('iawComposerInput')
      if (!input) { void toast('请切到协作会话后重试'); return }
      input.value = el.dataset.retry
      void sendMessage(input)
    }
  })
  host.querySelectorAll('[data-scene]').forEach((el) => {
    el.onclick = () => void openScene(el.dataset.scene)
  })
  host.scrollTop = host.scrollHeight
}

async function doCardAction(messageId, opId, btn) {
  if (previewLocked()) { btn.disabled = false; return }
  btn.disabled = true
  try {
    const result = await api.post(`/api/panel/messages/${messageId}/card-action`, { opId })
    const message = state.messages.find((m) => m.id === messageId)
    if (message?.card) message.card = result.message.card
    renderConversation($id('iawMsgs'))
    renderConversation(document.querySelector('#iawRoomsMsgs'))
    void toast(result.result)
    if (state.space === 'flow') void refreshView()
  } catch (error) {
    btn.disabled = false
    void toast(error.message, 'error')
  }
}

/** 输入草稿：按 部门:频道 落 localStorage——任何切换/刷新都不丢正在输入的内容。 */
function draftKey() {
  return `panel_draft:${state.dept}:${state.channelId}`
}
function saveDraft(input) {
  try { localStorage.setItem(draftKey(), input.value) } catch { /* 存储满/隐私模式忽略 */ }
}
function clearDraft() {
  try { localStorage.removeItem(draftKey()) } catch { /* 忽略 */ }
}

function composerHtml(place) {
  const dept = state.overview?.dept
  if (!dept) return ''
  // 演示预览态：输入区整体替换为锁定提示（不发请求、不可输入，交互面诚实缺席）
  if (state.industryDemo) {
    return `<div class="iaw-composer"><div class="box locked">🔒 演示预览（只读）——「${esc(state.industry?.name ?? '')}」激活后解锁发消息 / @数字同事 / 直调技能</div></div>`
  }
  const bound = Boolean(state.ddStatus?.bound)
  const onlineModels = state.models.filter((model) => model.status === 'online')
  const modelSwitch = onlineModels.length > 0
    ? `<select id="iawChatModel" class="iaw-model-sel" title="本次会话使用的模型（默认跟随 Agent 资产配置）">
        <option value="">🧠 跟随 Agent</option>
        ${onlineModels.map((model) => `<option value="${esc(model.slug)}" ${state.chatModel === model.slug ? 'selected' : ''}>${esc(model.displayName || model.slug)}</option>`).join('')}
      </select>`
    : '<span class="iaw-model-empty" id="iawModelEmptyHint" title="模型目录暂无在线模型——点击去登记">🧠 未接入模型</span>'
  const quick = place === 'rail' ? `
    <div class="iaw-quick">
      <button data-quick="diag">/诊断当前场景</button>
      <button data-quick="task">/转任务</button>
      <button data-quick="elements">/查数据</button>
    </div>` : ''
  const skillChips = state.skills.length > 0 ? `
    <div class="iaw-chips">${state.skills.slice(0, 4).map((skill) => `<span class="iaw-chip2" data-skill="${esc(skill.name)}" title="${esc(skill.summary ?? '')}">⚡ ${esc(skill.name)}</span>`).join('')}
    <span style="font-size:10px;color:var(--text-tertiary)">输入 /技能名 直调</span></div>` : ''
  const ddReady = Boolean(state.ddStatus?.connector?.configured)
  return `
    <div class="iaw-composer">
      ${quick}
      ${skillChips}
      <div class="box">
        <textarea id="iawComposerInput" rows="2" placeholder="发消息 / @数字同事 下任务 / /技能名 直调…（Ctrl+Enter 发送）"></textarea>
        <div class="tools">
          ${modelSwitch}
          <span class="iaw-chip2 ${state.ddSync && bound ? 'on' : ''}" id="iawDdToggle" title="${bound ? '本条消息同步钉钉群（开启后每 60s 自动拉取群新消息）' : '绑定钉钉后可用'}">⇄ 钉钉</span>
          ${ddReady ? `<span class="iaw-chip2" id="iawDdPull" title="从钉钉群拉取最新消息到当前频道">⇣ 拉取</span>` : ''}
          <span class="spacer"></span>
          <button class="iaw-send" id="iawComposerSend" title="发送 (Ctrl+Enter)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
        </div>
      </div>
    </div>`
}

function wireComposer(host) {
  if (!host) return
  const input = host.querySelector('#iawComposerInput')
  if (!input) return
  try { input.value = localStorage.getItem(draftKey()) ?? '' } catch { /* 忽略 */ }
  input.oninput = () => saveDraft(input)
  input.onkeydown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      void sendMessage(input)
    }
  }
  host.querySelector('#iawComposerSend')?.addEventListener('click', () => void sendMessage(input))
  host.querySelectorAll('[data-skill]').forEach((el) => {
    el.onclick = () => insertSkill(el.dataset.skill, input)
  })
  host.querySelectorAll('[data-quick]').forEach((el) => {
    el.onclick = () => {
      const kind = el.dataset.quick
      if (kind === 'diag') {
        if (!state.scene) { void toast('请先在场景罗盘中选择一个场景', 'error'); return }
        void diagnoseScene(state.scene)
      } else if (kind === 'task') {
        showNewTask('todo', state.scene ?? undefined)
      } else if (kind === 'elements') {
        state.space = 'data'; state.nav = 'elements'; renderSeg(); renderNav(); void refreshView()
      }
    }
  })
  const ddToggle = host.querySelector('#iawDdToggle')
  if (ddToggle) {
    ddToggle.onclick = () => {
      if (!state.ddStatus?.bound) { void showBind(); return }
      state.ddSync = !state.ddSync
      localStorage.setItem('panel_ddsync', state.ddSync ? '1' : '0')
      scheduleDdPull()
      renderView()
      renderAgentRail()
      if (state.ddSync) void pullDingtalkMessages(false)
    }
  }
  const ddPull = host.querySelector('#iawDdPull')
  if (ddPull) {
    ddPull.onclick = async () => {
      ddPull.style.opacity = '0.5'
      await pullDingtalkMessages(true)
      ddPull.style.opacity = ''
    }
  }
  const modelSel = host.querySelector('#iawChatModel')
  if (modelSel) {
    state.chatModel = modelSel.value
    modelSel.onchange = () => {
      state.chatModel = modelSel.value
      try { localStorage.setItem('panel_chat_model', state.chatModel) } catch { /* 忽略 */ }
      renderCtx()
    }
  }
  const modelHint = host.querySelector('#iawModelEmptyHint')
  if (modelHint) modelHint.onclick = () => { state.space = 'cap'; state.nav = 'mchannels'; renderSeg(); renderNav(); void refreshView() }
}

function atMention(name, inputEl) {
  const input = inputEl ?? $id('iawComposerInput')
  if (!input) {
    void toast(state.industryDemo ? '演示预览（只读）：激活行业后可在协作栏唤起数字同事' : '协作栏不可用')
    return
  }
  input.value = `@${name} ${input.value}`
  saveDraft(input)
  input.focus()
}

function insertSkill(name, inputEl) {
  const input = inputEl ?? $id('iawComposerInput')
  if (!input) {
    void toast(state.industryDemo ? '演示预览（只读）：激活行业后可直调技能' : '协作栏不可用')
    return
  }
  input.value = `/${name} ${input.value}`
  saveDraft(input)
  input.focus()
}

function parseSkillCommand(text) {
  const m = /^\/(.+?)(?:\s+([\s\S]*))?$/.exec(text)
  if (!m) return null
  const name = m[1].trim()
  const skill = state.skills.find((item) => item.name === name || item.slug === name)
  if (!skill) return null
  return { skill, message: (m[2] ?? '').trim() }
}

/** 技能直调（四态执行卡）：调用中（本地瞬时卡）→ 已完成（应答落频道）/ 异常阻断（红卡 + 重试）。 */
async function runSkillInvoke(skill, message, rawText) {
  const exec = {
    id: `local-skill-${Date.now()}`, kind: 'skill-exec', state: 'calling',
    skillName: skill.name, text: message, raw: rawText, at: new Date().toISOString(),
  }
  state.messages.push(exec)
  renderConversation($id('iawMsgs'))
  try {
    const result = await api.post(`/api/panel/${state.dept}/skills/invoke`, {
      skill: skill.name, message, channelId: state.channelId,
      ...(state.chatModel ? { model: state.chatModel } : {}),
    })
    state.messages = state.messages.filter((m) => m.id !== exec.id)
    for (const m of [result.message, result.replyMessage]) {
      if (m && !state.messages.some((x) => x.id === m.id)) state.messages.push(m)
    }
    if (!result.ok) state.messages.push({ ...exec, state: 'blocked', reason: result.reason })
    renderConversation($id('iawMsgs'))
    void refreshOverview()
  } catch (error) {
    state.messages = state.messages.filter((m) => m.id !== exec.id)
    state.messages.push({ ...exec, state: 'blocked', reason: error.message })
    renderConversation($id('iawMsgs'))
  }
}

/** 当前文本是否点名了部门名册中的数字同事（@触发；全名匹配，与后端 dispatchAgentMentions 同口径）。 */
function mentionsRosterAgent(text) {
  const agents = state.overview?.dept?.agents ?? []
  return agents.some((agent) => text.includes(`@${agent.name}`))
}

async function sendMessage(input) {
  if (previewLocked()) return
  const text = input.value.trim()
  if (!text || !state.channelId) return
  const skillCmd = parseSkillCommand(text)
  if (skillCmd) {
    input.value = ''
    clearDraft()
    await runSkillInvoke(skillCmd.skill, skillCmd.message, text)
    return
  }
  input.value = ''
  try {
    const result = await api.post(`/api/panel/${state.dept}/messages`, {
      channelId: state.channelId, text, ddSync: state.ddSync && Boolean(state.ddStatus?.bound),
      ...(state.chatModel ? { model: state.chatModel } : {}),
      // 点名数字同事时由前端流式端点驱动应答（SSE 增量卡），服务端跳过隐式派发防双跑
      ...(mentionsRosterAgent(text) ? { streamAgent: true } : {}),
    })
    clearDraft()
    state.messages.push(result.message)
    renderConversation($id('iawMsgs'))
    renderConversation($id('iawRoomsMsgs'))
    void refreshOverview()
    if (mentionsRosterAgent(text)) void streamAgentReplies(result.message.id)
  } catch (error) {
    if (error?.code === 'DEMO_READONLY') {
      void toast('演示数据只读：登录后即可发消息', 'error')
      showLoginModal()
      return
    }
    input.value = text
    saveDraft(input)
    void toast(error.message, 'error')
  }
}

// ---------------------------------------------------------------------------
// Agent 流式应答（2026-09-11 用户需求：@数字同事 → SSE 增量卡片渲染回复结果）
// POST /api/panel/:dept/agent-stream（fetch 流读取；SSE 帧经服务端流式转发模型输出）。
// 服务端在应答完成后照常落库 + 广播 panel.message.created → 全员可见；本端流式卡是瞬时层。
// ---------------------------------------------------------------------------

/** 流式卡瞬时状态（内存态，不进 state.messages——落库后由持久消息替代）。 */
const streamCards = new Map()

function renderStreamCards() {
  renderConversation($id('iawMsgs'))
  renderConversation($id('iawRoomsMsgs'))
}

/** 点名应答流：逐事件更新流式卡；done 后移除（持久消息经 SSE/轮询到达）。 */
async function streamAgentReplies(messageId) {
  const remote = Boolean(state.remoteHub)
  const streamBase = remote ? `${basePath()}/rqcard/proxy` : basePath()
  const headers = { 'content-type': 'application/json', ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) }
  if (remote && session.token) headers['x-rqcard-call'] = '1'
  let response
  try {
    response = await fetch(`${streamBase}/api/panel/${state.dept}/agent-stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messageId, ...(state.chatModel ? { model: state.chatModel } : {}) }),
    })
  } catch {
    void toast('流式应答通道连接失败——应答将以普通消息形式到达', 'error')
    return
  }
  if (!response.ok || !response.body) {
    // 端点不可用/权限失败：服务端隐式派发已跳过，回落拉一次消息兜底（无流式动画，结果仍可达）
    void refreshView()
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    let chunk
    try {
      chunk = await reader.read()
    } catch { break }
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      let event
      try { event = JSON.parse(line.slice(6)) } catch { continue }
      handleStreamEvent(event)
    }
  }
  // 兜底清场：通道结束仍有残留卡（如 done 事件丢失）→ 全部移除并刷新
  if (streamCards.size > 0) {
    streamCards.clear()
    renderStreamCards()
    void refreshView()
  }
}

function handleStreamEvent(event) {
  if (!event || typeof event !== 'object') return
  if (event.type === 'start') {
    streamCards.set(event.agent, { name: event.agent, icon: event.icon ?? '🤖', text: '', model: '' })
    renderStreamCards()
    return
  }
  if (event.type === 'delta') {
    const card = streamCards.get(event.agent)
    if (!card) return
    card.text += event.text ?? ''
    card.model = event.model ?? card.model
    renderStreamCards()
    return
  }
  if (event.type === 'fallback') {
    streamCards.set(event.agent ?? '?', { name: event.agent ?? '?', icon: '🤖', text: event.reason ?? '暂不能应答', fallback: true })
    renderStreamCards()
    return
  }
  if (event.type === 'done') {
    streamCards.delete(event.agent)
    renderStreamCards()
    return
  }
  if (event.type === 'end') {
    if (streamCards.size > 0) { streamCards.clear(); renderStreamCards() }
  }
}

// ---------------------------------------------------------------------------
// 钉钉入向拉取（dws CLI 桥，2026-09-11 用户需求：渠道消息往来联通）
// 手动「⇄ 拉取」按钮 + ddSync 开启时每 60s 自动拉取；新消息落当前频道（去重后）。
// ---------------------------------------------------------------------------

async function pullDingtalkMessages(manual) {
  if (!state.ddStatus?.connector?.configured) {
    if (manual) void toast('钉钉未配置：请先在钉钉绑定弹窗中安装/配置 dws CLI', 'error')
    return
  }
  if (!state.channelId) {
    if (manual) void toast('请先选择协作频道', 'error')
    return
  }
  try {
    const result = await api.post('/api/panel/ddws/pull', { channelId: state.channelId, limit: 20 }, { timeoutMs: 45_000 })
    if (result.error) {
      if (manual) void toast(result.error, 'error')
      return
    }
    if (result.inserted > 0) {
      await loadViewData()
      renderConversation($id('iawMsgs'))
      renderConversation($id('iawRoomsMsgs'))
      void refreshOverview()
      void toast(`已从钉钉拉取 ${result.inserted} 条新消息`)
    } else if (manual) {
      void toast('钉钉暂无新消息')
    }
  } catch (error) {
    if (manual) void toast(error.message, 'error')
  }
}

function scheduleDdPull() {
  if (state.ddPullTimer) { window.clearInterval(state.ddPullTimer); state.ddPullTimer = null }
  if (state.ddSync && state.ddStatus?.connector?.configured && state.channelId) {
    state.ddPullTimer = window.setInterval(() => void pullDingtalkMessages(false), 60_000)
  }
}

// ---------------------------------------------------------------------------
// 全局搜索 / ⌘K / 帮助
// ---------------------------------------------------------------------------

async function searchJump(q) {
  const query = q.trim().toLowerCase()
  if (!query) return
  const pack = state.scenegraph?.pack
  const hit = packScenes(pack).find((s) => s.code.toLowerCase().includes(query) || s.name.toLowerCase().includes(query))
  if (hit) {
    await openScene(hit.code)
    richToast('已定位场景', `${esc(hit.code)} · ${esc(hit.name)}`)
    return
  }
  await openCmdk(q)
}

async function openCmdk(prefill = '') {
  const mask = document.createElement('div')
  mask.className = 'cmdk-mask'
  mask.innerHTML = `
    <div class="cmdk">
      <input id="cmdkInput" placeholder="搜索 场景 / 数字同事 / 技能 / 频道 / 同事 / 任务…">
      <div class="cmdk-list" id="cmdkList"></div>
    </div>`
  document.body.appendChild(mask)
  mask.addEventListener('click', (event) => {
    if (event.target === mask) mask.remove()
  })
  const input = mask.querySelector('#cmdkInput')
  const list = mask.querySelector('#cmdkList')
  input.value = prefill
  input.focus()

  const sources = []
  for (const scene of packScenes(state.scenegraph?.pack)) {
    sources.push({ group: '场景', icon: '🗺', label: `${scene.code} ${scene.name}`, sub: ACT_LABELS[findSceneLocal(scene.code)?.activity ?? ''] ?? '', act: () => { mask.remove(); void openScene(scene.code) } })
  }
  for (const agent of (state.overview?.dept?.agents ?? [])) {
    sources.push({ group: '数字同事', icon: agent.icon, label: agent.name, sub: agent.asset ? `资产 ${agent.asset.name}` : '未绑定资产', act: () => { mask.remove(); atMention(agent.name) } })
  }
  for (const skill of state.skills.slice(0, 8)) {
    sources.push({ group: '技能', icon: '⚡', label: skill.name, sub: skill.summary || skill.category || '', act: () => { mask.remove(); insertSkill(skill.name) } })
  }
  for (const channel of (state.overview?.channels ?? [])) {
    sources.push({ group: '频道', icon: '#', label: channel.name, sub: `${channel.unread ?? 0} 未读`, act: () => { mask.remove(); state.channelId = channel.id; localStorage.setItem(`panel_channel_${state.dept}`, channel.id); state.space = 'collab'; state.nav = 'rooms'; renderSeg(); renderNav(); void refreshView() } })
  }
  for (const task of activeTasks().filter((t) => t.lane !== 'done').slice(0, 20)) {
    sources.push({ group: '任务', icon: '📌', label: task.title, sub: LANE_LABELS[task.lane] ?? task.lane, act: () => { mask.remove(); state.space = 'flow'; state.nav = 'flow'; renderSeg(); renderNav(); void refreshView() } })
  }
  for (const member of (state.overview?.members ?? [])) {
    sources.push({ group: '同事', icon: '🧑', label: member.name, sub: member.title ?? member.orgName ?? '', act: () => { mask.remove(); atMention(member.name) } })
  }
  for (const model of state.models) {
    sources.push({ group: '模型渠道', icon: '◈', label: model.displayName || model.slug, sub: model.status === 'online' ? '在线' : '离线', act: () => { mask.remove(); state.space = 'cap'; state.nav = 'mchannels'; renderSeg(); renderNav(); void refreshView() } })
  }

  const render = () => {
    const query = input.value.trim().toLowerCase()
    const hits = sources.filter((item) => !query || item.label.toLowerCase().includes(query) || String(item.sub).toLowerCase().includes(query)).slice(0, 40)
    list.innerHTML = hits.length === 0 ? '<div class="cmdk-empty">无匹配结果——场景支持编码/名称，如 YB01-B-2-1</div>'
      : [...new Set(hits.map((item) => item.group))].map((group) => `
        <div class="cmdk-group">${group}</div>
        ${hits.filter((item) => item.group === group).map((item) => {
          const idx = hits.indexOf(item)
          return `<div class="cmdk-item" data-idx="${idx}"><span>${esc(item.icon)}</span><span>${esc(item.label)}</span><span class="sub">${esc(String(item.sub))}</span></div>`
        }).join('')}`).join('')
    list.querySelectorAll('.cmdk-item').forEach((el) => {
      el.onclick = () => hits[Number(el.dataset.idx)]?.act()
    })
  }
  input.oninput = render
  render()
}

function showHelp() {
  showModal('📖 帮助与快捷键', `
    <p class="note" style="margin-top:0">行业 AI 工作台（IAW）——以「一图四清单」为知识骨架，模型渠道 / 数据驱动 / 业务事务流三大原则。</p>
    <div class="step"><div class="no">1</div><div><div class="st-t">五空间导航（协作首位）</div><div class="st-d">协作（频道/同事/成员/通知）· 图谱（场景罗盘/主线贯通/场景对比/驾驶舱/路线图）· 执行（任务/收件箱）· 能力（模型渠道/四清单）· 数据（数据要素）。协作空间全屏即会话，右侧协作栏自动收起。</div></div></div>
    <div class="step"><div class="no">2</div><div><div class="st-t">场景详情</div><div class="st-d">罗盘中点击场景卡打开抽屉：概览 / 四要素 / 痛点 / 事务流 / 协作；可派数字同事诊断、同步钉钉。</div></div></div>
    <div class="step"><div class="no">3</div><div><div class="st-t">人机协作门禁</div><div class="st-d">数字同事的产出停在「待审」，人工确认后才进入下游；协作栏里的操作卡可一键确认。</div></div></div>
    <div class="step"><div class="no">⌘</div><div><div class="st-t">快捷键</div><div class="st-d">Ctrl/⌘+K 全局搜索 · Ctrl/⌘+Enter 发送消息 · Esc 关闭抽屉/弹层。</div></div></div>`)
}

// ---------------------------------------------------------------------------
// 弹层：新建频道 / 新建任务 / 模型表单 / 钉钉绑定 / 面板配置
// ---------------------------------------------------------------------------

function showNewChannel() {
  if (previewLocked()) return
  showModal('＋ 发起协作（新建频道）', `
    <div style="display:flex;flex-direction:column;gap:10px">
      <input id="chanName" placeholder="频道名（如：异常快速响应群）" style="border:1px solid var(--line);border-radius:8px;padding:9px 12px;font-size:13px">
      <div style="display:flex;gap:10px">
        <button class="btn primary" id="chanSubmit">创建</button>
        <button class="btn" id="chanCancel">取消</button>
      </div>
    </div>`)
  $id('chanCancel').onclick = hideModal
  $id('chanSubmit').onclick = async (event) => {
    const name = $id('chanName').value.trim()
    if (!name) { void toast('频道名必填', 'error'); return }
    event.target.disabled = true
    try {
      const result = await api.post(`/api/panel/${state.dept}/channels`, { name })
      state.overview.channels.push({ ...result.channel, unread: 0 })
      state.channelId = result.channel.id
      localStorage.setItem(`panel_channel_${state.dept}`, state.channelId)
      hideModal()
      renderNav()
      state.space = 'collab'; state.nav = 'rooms'
      renderSeg(); renderNav()
      await refreshView()
    } catch (error) {
      event.target.disabled = false
      void toast(error.message, 'error')
    }
  }
}

function showNewTask(lane, sceneCode) {
  if (previewLocked()) return
  showModal('📌 新建任务', `
    <div style="display:flex;flex-direction:column;gap:10px">
      <input id="taskTitle" placeholder="任务标题" style="border:1px solid var(--line);border-radius:8px;padding:9px 12px;font-size:13px">
      <input id="taskScene" placeholder="关联场景编号（可选，如 ${esc(state.industry?.code ?? 'QB01')}-A-2-5）" value="${esc(sceneCode ?? '')}" style="border:1px solid var(--line);border-radius:8px;padding:9px 12px;font-size:13px">
      <div style="display:flex;gap:10px">
        <button class="btn primary" id="taskSubmit">创建到「${LANE_LABELS[lane]}」</button>
        <button class="btn" id="taskCancel">取消</button>
      </div>
    </div>`)
  $id('taskCancel').onclick = hideModal
  $id('taskSubmit').onclick = async (event) => {
    const title = $id('taskTitle').value.trim()
    if (!title) { void toast('标题必填', 'error'); return }
    event.target.disabled = true
    try {
      await api.post(`/api/panel/${state.dept}/tasks`, {
        title, lane,
        ...($id('taskScene').value.trim() ? { sceneCode: $id('taskScene').value.trim() } : {}),
      })
      hideModal()
      richToast('任务已创建', `${esc(title)} → ${esc(LANE_LABELS[lane])}`)
      await refreshView()
      void refreshOverview()
    } catch (error) {
      event.target.disabled = false
      void toast(error.message, 'error')
    }
  }
}

function showModelForm(existing) {
  showModal(existing ? `🧠 编辑模型 · ${esc(existing.slug)}` : '🧠 登记模型（OpenAI 兼容 chat/completions）', `
    <div class="mform">
      <label>模型 slug（唯一标识）*
        <input id="mfSlug" value="${esc(existing?.slug ?? '')}" ${existing ? 'disabled title="slug 是登记主键，如需变更请新建登记"' : ''} placeholder="如 deepseek-chat"></label>
      <label>显示名<input id="mfName" value="${esc(existing?.displayName ?? '')}" placeholder="缺省同 slug"></label>
      <label>厂商<input id="mfProvider" value="${esc(existing?.provider ?? '')}" placeholder="如 deepseek / aliyun / openai"></label>
      <label>Endpoint（OpenAI 兼容基址，必须含 /v1 路径）*<input id="mfEndpoint" value="${esc(existing?.endpoint ?? '')}" placeholder="如 https://api.deepseek.com/v1（漏 /v1 会 404）"></label>
      <label>API Key${existing ? '（留空保持不变）' : ''}<input id="mfKey" type="password" autocomplete="new-password" placeholder="${existing ? '留空保持既有密钥' : '直填或环境变量引用（如 env:DEEPSEEK_API_KEY）'}"></label>
      <div class="mform-grid">
        <label>挂牌价（分/千 tokens）*<input id="mfList" type="number" min="0" step="0.1" value="${existing?.listCentsPerKTokens ?? 0}"></label>
        <label>成本价（分/千 tokens）<input id="mfCost" type="number" min="0" step="0.1" value="${existing?.costCentsPerKTokens ?? ''}" placeholder="缺省为挂牌价一半"></label>
      </div>
      <label>状态<select id="mfStatus">
        <option value="online" ${existing?.status !== 'offline' ? 'selected' : ''}>在线（可调用）</option>
        <option value="offline" ${existing?.status === 'offline' ? 'selected' : ''}>离线（停用）</option>
      </select></label>
    </div>
    <div style="display:flex;gap:10px">
      <button class="btn primary" id="mfSave">保存</button>
      <button class="btn" id="mfCancel">返回</button>
    </div>
    <p class="note">密钥支持 env: 变量名引用，回显一律脱敏；保存即生效并全程审计。保存后用「测试」真实调用一次验证连通（按量计费）。</p>`)
  $id('mfCancel').onclick = hideModal
  $id('mfSave').onclick = async (event) => {
    const payload = {
      slug: $id('mfSlug').value.trim(),
      displayName: $id('mfName').value.trim(),
      provider: $id('mfProvider').value.trim(),
      endpoint: $id('mfEndpoint').value.trim(),
      listCentsPerKTokens: Number($id('mfList').value) || 0,
      status: $id('mfStatus').value,
    }
    const cost = $id('mfCost').value
    if (cost !== '') payload.costCentsPerKTokens = Number(cost)
    const key = $id('mfKey').value.trim()
    if (key) payload.apiKey = key
    if (!payload.slug) { void toast('模型 slug 必填', 'error'); return }
    if (!payload.endpoint) { void toast('Endpoint 必填（未配置不可调用）', 'error'); return }
    event.target.disabled = true
    try {
      await api.post('/api/panel/models', payload)
      void toast(`模型 ${payload.slug} 已保存`)
      await refreshModels()
      hideModal()
      renderAgentRail()
      if (state.nav === 'mchannels' || state.nav === 'cockpit') renderView()
    } catch (error) {
      event.target.disabled = false
      void toast(error.message, 'error')
    }
  }
}

/** dws 登录轮询定时器（模块级单例；弹窗关闭/换绑重渲/登录成功都要停）。 */
let ddLoginTimer = null
function stopDdLoginPoll() {
  if (ddLoginTimer) { clearInterval(ddLoginTimer); ddLoginTimer = null }
}

/** 登录步骤 HTML（未登录 → 发起按钮；已登录 → 绿勾+组织/账号）。 */
function dwsLoginStepHtml(auth) {
  const done = Boolean(auth?.authenticated)
  return `<div class="step ${done ? 'done' : ''}"><div class="no">${done ? '✓' : '2'}</div><div>
      <div class="st-t">登录钉钉（dws 设备码授权——本面板代发起，无需终端、不与宿主平台绑定）</div>
      <div class="st-d">${done
        ? `已登录：${esc(auth.corpName ?? '')}${auth.userName ? ` · ${esc(auth.userName)}` : ''}`
        : '点击「发起登录」生成授权链接与用户码，在浏览器打开并输入用户码完成钉钉授权，本页自动感知。'}</div>
      ${done ? '' : '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn dd" id="dwsLoginStart">🔑 发起登录</button><span id="dwsLoginBox" style="flex:1;min-width:220px"></span></div>'}</div></div>`
}

/** dws CLI 桥模式绑定面（装态无钉钉桥时）：安装 dws CLI → 登录钉钉 → 绑定目标群 → 测试投递。 */
function showBindDws(status) {
  stopDdLoginPoll()
  const auth = status.auth
  const steps = [
    `<div class="step ${status.installed ? 'done' : ''}"><div class="no">${status.installed ? '✓' : '1'}</div><div>
      <div class="st-t">dws CLI（钉钉官方命令行）</div>
      <div class="st-d">${status.installed
        ? `已安装（${esc(status.version ?? '')}）。授权态由 dws 自身管理，下一步在面板直接发起登录。`
        : esc(status.installHint ?? '未检测到 dws CLI')}</div>
      ${status.installed ? '' : '<div style="margin-top:8px"><button class="btn dd" id="dwsInstall">⬇ 一键安装 dws CLI</button></div>'}</div></div>`,
    dwsLoginStepHtml(auth),
    `<div class="step ${status.bound ? 'done' : ''}"><div class="no">${status.bound ? '✓' : '3'}</div><div>
      <div class="st-t">绑定目标钉钉群（群名或 openConversationId）</div>
      <div class="st-d">${status.bound
        ? `已绑定：${esc(status.group ?? status.bound?.displayName ?? '')}——开启「钉钉同步」的面板消息将投递到该群。`
        : '填写群名后绑定。此后面板消息开启「钉钉同步」即经 dws 投递到该群。'}</div>
      <div style="margin-top:8px;display:flex;gap:8px">
        <input id="dwsGroup" placeholder="如：异常快速响应群" value="${esc(status.group ?? '')}" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:13px">
        <button class="btn primary" id="dwsBindSave">${status.bound ? '换绑' : '绑定'}</button>
        ${status.bound ? '<button class="btn" id="dwsUnbind">解绑</button>' : ''}
      </div></div></div>`,
    `<div class="step"><div class="no">4</div><div>
      <div class="st-t">测试投递</div>
      <div class="st-d">向绑定群真实发送一条测试消息（走 dws chat，失败原因如实回显）。</div>
      <div style="margin-top:8px"><button class="btn" id="dwsTest" ${status.installed && status.bound ? '' : 'disabled'}>📤 发送测试消息</button></div></div></div>`,
  ]
  showModal('⇄ 钉钉连接（dws CLI 模式）', `${steps.join('')}
    <p class="note">安全边界：钉钉授权态归 dws CLI 自身（本面板零凭证，登录走官方设备码授权）；安装/登录/绑群/投递全程审计留痕；投递失败会落到消息同步状态与告警，绝不静默丢消息。</p>`)
  const installBtn = $id('dwsInstall')
  if (installBtn) {
    installBtn.onclick = async (event) => {
      event.target.disabled = true
      event.target.textContent = '⏳ 安装中（最长 4 分钟）…'
      try {
        const result = await api.post('/api/panel/ddws/install', {}, { timeoutMs: 260_000 })
        void toast(result.message, result.ok ? undefined : 'error')
      } catch (error) {
        void toast(error.message, 'error')
      }
      await refreshDingtalk()
      showBindDws(state.ddStatus ?? status)
    }
  }
  const loginBtn = $id('dwsLoginStart')
  if (loginBtn) {
    loginBtn.onclick = async () => {
      loginBtn.disabled = true
      loginBtn.textContent = '⏳ 正在发起…'
      const box = $id('dwsLoginBox')
      try {
        const result = await api.post('/api/panel/ddws/login', {}, { timeoutMs: 40_000 })
        if (result.already) {
          void toast(`dws 已处于登录态（${result.auth?.corpName ?? '钉钉'}）`)
          await refreshDingtalk()
          showBindDws(state.ddStatus ?? status)
          return
        }
        if (!result.started) {
          if (box) box.innerHTML = `<span style="color:#dc2626;font-size:12px">${esc(result.message ?? '发起登录失败')}</span>`
          loginBtn.disabled = false
          loginBtn.textContent = '🔑 发起登录'
          return
        }
        if (box) {
          box.innerHTML = `<div style="font-size:12px;line-height:1.7">
            <div>用户码：<b style="font-size:15px;letter-spacing:2px">${esc(result.userCode ?? '（见授权页）')}</b>${result.expiresInSeconds ? ` <span style="color:var(--txt2)">${Math.round(result.expiresInSeconds / 60)} 分钟内有效</span>` : ''}</div>
            <div><a class="btn primary" href="${esc(result.verifyUrl)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:4px;text-decoration:none">📱 打开钉钉授权页</a></div>
            <div style="color:var(--txt2);margin-top:4px">授权完成后本页自动继续（3 秒轮询中）。</div>
          </div>`
        }
        stopDdLoginPoll()
        ddLoginTimer = setInterval(async () => {
          try {
            const poll = await api.get('/api/panel/ddws/login')
            if (poll.authenticated) {
              stopDdLoginPoll()
              void toast(`✓ 钉钉登录成功（${poll.auth?.corpName ?? 'dws'}${poll.auth?.userName ? ` · ${poll.auth.userName}` : ''}）`)
              await refreshDingtalk()
              if ($id('mask')?.classList.contains('show')) showBindDws(state.ddStatus ?? status)
              return
            }
            if (!poll.active && poll.message) {
              stopDdLoginPoll()
              if (box) box.innerHTML = `<span style="color:#dc2626;font-size:12px">${esc(poll.message)}</span>`
              loginBtn.disabled = false
              loginBtn.textContent = '🔑 重新发起登录'
            }
          } catch { /* 瞬时网络错误下一轮再试 */ }
        }, 3000)
      } catch (error) {
        void toast(error.message, 'error')
        loginBtn.disabled = false
        loginBtn.textContent = '🔑 发起登录'
      }
    }
  }
  const saveBtn = $id('dwsBindSave')
  if (saveBtn) {
    saveBtn.onclick = async (event) => {
      const group = $id('dwsGroup').value.trim()
      if (!group) { void toast('群名/会话 ID 必填', 'error'); return }
      event.target.disabled = true
      try {
        await api.put('/api/panel/ddws/bind', { group })
        void toast(`已绑定钉钉群：${group}`)
        await refreshDingtalk()
        showBindDws(state.ddStatus ?? status)
      } catch (error) {
        event.target.disabled = false
        void toast(error.message, 'error')
      }
    }
  }
  const unbindBtn = $id('dwsUnbind')
  if (unbindBtn) {
    unbindBtn.onclick = async () => {
      try {
        await api.delete('/api/panel/ddws/bind')
        void toast('已解绑钉钉群')
        await refreshDingtalk()
        showBindDws(state.ddStatus ?? status)
      } catch (error) {
        void toast(error.message, 'error')
      }
    }
  }
  const testBtn = $id('dwsTest')
  if (testBtn) {
    testBtn.onclick = async (event) => {
      event.target.disabled = true
      try {
        const result = await api.post('/api/panel/ddws/test', {}, { timeoutMs: 40_000 })
        void toast(result.ok ? `✓ 已投递到「${result.group}」` : `✗ ${result.error}`, result.ok ? undefined : 'error')
      } catch (error) {
        void toast(error.message, 'error')
      }
      event.target.disabled = false
    }
  }
}

async function showBind() {
  const status = state.ddStatus
  if (status?.via === 'dws-cli') return showBindDws(status)
  const connectorOk = status?.connector?.configured
  const bound = status?.bound
  showModal('⇄ 钉钉身份绑定与消息桥接', `
    <div class="step ${connectorOk ? 'done' : ''}"><div class="no">${connectorOk ? '✓' : '1'}</div><div>
      <div class="st-t">宿主平台钉钉连接器</div>
      <div class="st-d">${connectorOk
        ? `已配置（${esc(status.connector.name ?? status.connector.corpId)} · ${status.connector.mode === 'real' ? '真实模式' : 'mock 演示模式——真实投递需切 real'}）`
        : '未配置：请管理员在控制台「组织与账号 → 三方集成」配置钉钉连接器'}</div></div></div>
    <div class="step ${bound ? 'done' : ''}"><div class="no">${bound ? '✓' : '2'}</div><div>
      <div class="st-t">绑定当前登录身份 ↔ 钉钉账号（iam 扫码绑定，事实源 identityLinks）</div>
      <div class="st-d">${bound
        ? `已绑定：${esc(bound.displayName)}（${esc(bound.corpId)}）`
        : '点击下方按钮，在钉钉中完成扫码授权即可。绑定后面板消息可同步钉钉群、场景卡可推送钉钉。'}</div>
      ${bound ? '' : '<div style="margin-top:8px"><button class="btn dd" id="bindStart">📱 去钉钉扫码绑定</button></div>'}</div></div>
    <div class="step"><div class="no">3</div><div>
      <div class="st-t">频道群桥（管理员）</div>
      <div class="st-d">绑定钉钉群会话后，开启「钉钉同步」的消息将投递到群。</div></div></div>
    <p class="note">安全边界：身份绑定事实源为 iam identityLinks（扫码授权）；出向投递凭证单一来源=连接器配置（本面板零凭证）；
    高风险审批钉钉回决必须二次确认（fail-closed）。</p>`)
  const startBtn = $id('bindStart')
  if (startBtn) {
    startBtn.onclick = async () => {
      try {
        const authorize = await api.post('/api/auth/sso/bind/authorize', { provider: 'dingtalk' })
        const url = authorize.redirectUrl ?? authorize.url ?? authorize.redirect_uri
        if (url) {
          window.open(url, '_blank', 'width=520,height=640')
          void toast('已打开钉钉授权页，完成后回到本页自动刷新状态')
          setTimeout(() => { void refreshDingtalk().then(() => { hideModal(); void showBind() }) }, 4000)
        } else {
          void toast('平台未返回授权地址，请检查钉钉连接器登录配置', 'error')
        }
      } catch (error) {
        void toast(error.message, 'error')
      }
    }
  }
}

async function showConfig() {
  const dept = state.overview?.dept
  if (!dept) return
  let orgs = null
  try {
    orgs = (await api.get('/api/panel/orgs')).orgs
  } catch { /* 无 panel.config.write 或组织面不可用：隐藏绑定区 */ }
  showModal(`⚙ ${esc(dept.label)}面板配置`, `
    <p class="note" style="margin-top:0">配置需 panel.config.write 权限。修改立即生效（全程审计）。</p>
    ${orgs ? `
    <div style="margin:12px 0">
      <div class="col-title"><span>组织绑定（绑定后仅该组织子树成员可访问本部门）</span></div>
      <div class="lic-row"><span class="lr-ic">🏷</span>
        <select id="cfgOrg" style="flex:1;border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px">
          <option value="">（不绑定——对全部 panel.read 持有者开放）</option>
          ${orgs.map((org) => `<option value="${esc(org.id)}" ${state.overview.org?.id === org.id ? 'selected' : ''}>${esc(org.name)}</option>`).join('')}
        </select>
      </div>
    </div>` : ''}
    <div style="margin:12px 0">
      <div class="col-title"><span>AGENT 阵容（@唤起键 · 绑定 Agent 资产后可真实调用）</span></div>
      ${dept.agents.map((agent, index) => `
        <div class="lic-row"><span class="lr-ic">${esc(agent.icon)}</span>
          <span style="flex:1">${esc(agent.name)}${agent.asset ? `<span style="font-size:10px;color:${agent.asset.status === 'online' ? '#16a34a' : 'var(--txt2)'}"> · 资产 ${esc(agent.asset.name)}（${esc(agent.asset.status)}）</span>` : ''}<span style="display:block;font-size:10px;color:var(--txt2)">${esc(agent.desc)}</span></span>
          <input id="agentRef${index}" value="${esc(agent.agentRef ?? '')}" placeholder="agent:资产id/slug（可空）"
            style="border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:11px;width:180px">
        </div>`).join('')}
    </div>
    <div style="display:flex;gap:10px">
      <button class="btn primary" id="cfgSave">保存配置</button>
      <button class="btn" id="cfgCancel">关闭</button>
    </div>`)
  $id('cfgCancel').onclick = hideModal
  $id('cfgSave').onclick = async (event) => {
    event.target.disabled = true
    try {
      const agents = dept.agents.map((agent, index) => {
        const ref = $id(`agentRef${index}`).value.trim()
        const rest = { name: agent.name, desc: agent.desc, icon: agent.icon, ...(agent.busy ? { busy: true } : {}) }
        return ref ? { ...rest, agentRef: ref } : rest
      })
      const orgSelect = $id('cfgOrg')
      const promises = [api.put(`/api/panel/${dept.id}/agents`, { agents })]
      if (orgSelect) promises.push(api.put(`/api/panel/${dept.id}/config`, { orgId: orgSelect.value || null }))
      const [agentsRes] = await Promise.all(promises)
      state.overview.dept.agents = agentsRes.agents
      hideModal()
      void toast('配置已保存（范围权限/阵容绑定立即生效）')
      await refreshOverview()
    } catch (error) {
      event.target.disabled = false
      void toast(error.message, 'error')
    }
  }
}
