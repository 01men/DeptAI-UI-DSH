/** 应用外壳：路由 + 布局 + 侧边栏 + 顶栏 + ⌘K 命令面板。 */
import { icon } from './icons.js'
import { session, api, exchangeBridgeSession, demoStatus, IS_LOCAL_HOST, CONNECTION_NAME } from './api.js'
import { $, $$, h, toast, esc } from './ui.js'
import { openCmdk } from './cmdk.js'
import { replayPlatformTheme, PLATFORM_KEY } from './platform.js'
import { resolveLanding, isBareLanding, LANDING_PREF_KEY } from './landing.js'
import { resolvePanels } from './connections.js'
import { consumeNextSources, exitWithNext } from './next-redirect.js'
import rqI18n from './i18n.js'
import { mountThemeSwitcher, replayUiTheme } from './theme.js'

// 平台主题（WP-05/B3）：启动即回放记忆的平台（免闪默认色）。写入方为平台身份下发方
// （applyPlatformTheme——卡片包域回流后的工作台校准、或部署方预置 heng_ops_platform 键）。
replayPlatformTheme()
replayUiTheme()

// 钉钉微应用入口探测（WP-11）：钉钉 webview UA 且无记忆平台时，标记钉钉入口态。
// 只写独立键 heng_ops_dingtalk，不写 heng_ops_platform——钉钉是入口不是第六平台，不改五平台 data-platform 语义。
try {
  if (/DingTalk/i.test(navigator.userAgent) && !localStorage.getItem(PLATFORM_KEY)) {
    localStorage.setItem('heng_ops_dingtalk', '1')
    document.documentElement.dataset.platformEntry = 'dingtalk'
  }
} catch { /* 忽略 */ }

// 页面级懒加载（2026-10-18 · 首屏修复）：此前本页静态 import 全部 25 个页面模块，
// 浏览器必须等最慢的一个下载+解析完才能执行首行代码。本机 7302 首屏 315ms，
// 但经 Cloudflare 隧道公网单请求 RTT 约 0.9s，45 个 script 争抢并发 → 实测 9~14s
// 「白屏观感」（加载屏只有 len=8 的暖纸底+居中小字）。根因是静态 import 的瀑布，
// 不是应用性能、也不是深层模块串行（模块图深度仅 3 层）。
// 改为动态 import：首屏只多 1 个请求（当前路由页），其余页面按需取。
// 动态 import 自身有模块缓存，这里再缓存一层是为了失败后可重试（catch 里删键）。
const pageModules = new Map()
function lazy(spec, name) {
  return async (...args) => {
    let mod = pageModules.get(spec)
    if (!mod) {
      mod = import(spec).catch((error) => { pageModules.delete(spec); throw error })
      pageModules.set(spec, mod)
    }
    return (await mod)[name](...args)
  }
}

const renderLogin = lazy('./pages/login.js', 'renderLogin')
const renderHome = lazy('./pages/home.js', 'renderHome')
const renderDashboard = lazy('./pages/dashboard.js', 'renderDashboard')
const renderIam = lazy('./pages/iam/index.js', 'renderIam')
const renderAuthn = lazy('./pages/authn.js', 'renderAuthn')
const renderMcp = lazy('./pages/mcp.js', 'renderMcp')
const renderNas = lazy('./pages/nas.js', 'renderNas')
const renderNasAuthz = lazy('./pages/nas-authz.js', 'renderNasAuthz')
const renderConnectors = lazy('./pages/connectors.js', 'renderConnectors')
const renderPanels = lazy('./pages/panels.js', 'renderPanels')
const renderSkills = lazy('./pages/skills.js', 'renderSkills')
const renderAgents = lazy('./pages/agents.js', 'renderAgents')
const renderA2a = lazy('./pages/a2a.js', 'renderA2a')
const renderApps = lazy('./pages/apps.js', 'renderApps')
const renderAudit = lazy('./pages/audit.js', 'renderAudit')
const renderApprovals = lazy('./pages/approvals.js', 'renderApprovals')
const renderAssets = lazy('./pages/assets.js', 'renderAssets')
const renderFinops = lazy('./pages/finops.js', 'renderFinops')
const renderExec = lazy('./pages/exec.js', 'renderExec')
const renderPlatform = lazy('./pages/platform.js', 'renderPlatform')
const renderConnect = lazy('./pages/connect.js', 'renderConnect')
const renderConnections = lazy('./pages/connections.js', 'renderConnections')
const renderGateway = lazy('./pages/gateway.js', 'renderGateway')
const renderUsage = lazy('./pages/usage.js', 'renderUsage')
const renderAccess = lazy('./pages/access.js', 'renderAccess')
const renderMe = lazy('./pages/me.js', 'renderMe')
const renderOauthAuthorize = lazy('./pages/oauth.js', 'renderOauthAuthorize')
const renderOauthError = lazy('./pages/oauth.js', 'renderOauthError')
const renderOauthLogout = lazy('./pages/oauth.js', 'renderOauthLogout')
import { mountUpdateBadge, openUpdateDrawer } from './update.js'

// 导航分组（2026-10-22 IA 收敛：总览 / 资源 / 协作与执行 / 治理 / 企业）。
// 「协作与执行」独立成组：执行中枢（目标·任务·调度）、A2A 协作、UHP 执行是「让数字员工跑起来」
// 的一条主线，混在资源台账里会被误读成又一类可盘点资产；资源组只留被管理对象本身。
// 资产登记（#/register）已下线：登记入口分别落在各资源页自身的新建动作上，不再有独立的登记看板。
const NAV = [
  { section: '总览', items: [
    { path: '#/dashboard', label: '工作台', icon: 'dashboard', perm: 'console.login' },
    // 部门面板（2026-10-22）：不再是硬编码外链，改为「宿主连接 × 部门」登记清单页（#/panels）。
    // 只有登记过的面板才有一键入口——把「从哪个宿主进哪个部门」变成可管理的事实，而不是靠目标宿主记忆。
    { path: '#/panels', label: '部门面板', icon: 'users', perm: 'panel.read' },
  ] },
  { section: '资源', items: [
    { path: '#/assets', label: '资产台账', icon: 'boxes', perm: 'usage.read' },
    { path: '#/skills', label: 'Skill 市场', icon: 'store', perm: 'skill.read', badge: 'skills' },
    { path: '#/gateway', label: '模型网关', icon: 'route', perm: 'usage.read' },
    { path: '#/agents', label: 'Agent 本体', icon: 'bot', perm: 'agent.read' },
    { path: '#/apps', label: 'AI 应用', icon: 'app', perm: 'app.read' },
    { path: '#/mcp', label: 'MCP 服务', icon: 'plug', perm: 'mcp.service.read' },
    // 个人接入令牌与 MCP 调用配置（归属 MCP 服务板块：配置的是本平台 /mcp 工具面的接入）
    { path: '#/me', label: '我的接入', icon: 'user', perm: 'console.login' },
    { path: '#/nas', label: 'NAS 存储', icon: 'server', perm: 'nas.read' },
    { path: '#/connectors', label: '连接器', icon: 'plug', perm: 'connector.catalog.read' },
  ] },
  { section: '协作与执行', items: [
    // 执行中枢：目标/项目/任务/调度四位一体（#/exec），工作台「目标与价值/行动项目」tab 的下钻落点
    { path: '#/exec', label: '执行中枢', icon: 'target', perm: 'exec.read' },
    // A2A 协作：数字员工跨运行时协作面（目录发现 / 任务追踪 / 履约与巡检），读权限随目录
    { path: '#/a2a', label: 'A2A 协作', icon: 'flow', perm: 'a2a.directory.read' },
    // UHP 执行：harnesses 注册表 + 执行记录（A2A 页的 UHP tab 的一级入口；同一页面不同落点）
    { path: '#/a2a?tab=uhp', label: 'UHP 执行', icon: 'cpu', perm: 'uhp.read' },
  ] },
  { section: '治理', items: [
    { path: '#/usage', label: '用量与成本', icon: 'barChart3', perm: 'usage.read' },
    { path: '#/finops', label: '财务视图', icon: 'coins', perm: 'usage.read' },
    { path: '#/nas-authz', label: '数据权限', icon: 'shield', perm: 'nas.authz.read' },
    { path: '#/approvals', label: '审批中心', icon: 'fileCheck', perm: 'approval.read', badge: 'approvals' },
    { path: '#/audit', label: '审计与告警', icon: 'shieldAlert', perm: 'audit.read', badge: 'alerts' },
    { path: '#/authn', label: '认证与令牌', icon: 'key', perm: 'authn.principal.read' },
  ] },
  { section: '企业', items: [
    { path: '#/iam', label: '组织与账号', icon: 'building2', perm: 'iam.user.read' },
    { path: '#/iam?tab=roles', label: '角色权限', icon: 'shield', perm: 'iam.org.read' },
    { path: '#/iam?tab=connectors', label: '三方集成', icon: 'link', perm: 'iam.org.read' },
    { path: '#/access', label: '平台接入', icon: 'fingerprint', perm: 'connect.manage' },
    { path: '#/connections', label: '宿主服务连接', icon: 'server', perm: 'console.login' },
    { path: '#/platform', label: '插件与工具', icon: 'puzzle', perm: 'console.login' },
  ] },
]

const app = $('#app')

// 懒加载后这些页面渲染都变成异步：加载失败不再同步抛出（那会被 hashchange 抛出到
// window.onerror），而是变成 rejected promise——不接住就是静默白屏。故统一兜底成
// 可重试错误卡，与 renderShell 内既有的页面级兜底保持一致口径。
function guard(renderThunk, target) {
  Promise.resolve()
    .then(renderThunk)
    .catch((error) => {
      target.innerHTML = `
        <div class="card card-pad" style="text-align:center;padding:44px 24px">
          <div style="font-size:30px;margin-bottom:10px">🚫</div>
          <div style="font-weight:600;margin-bottom:6px">页面加载失败</div>
          <div class="fs-12 text-3" style="margin-bottom:18px">${esc(error?.message ?? '未知错误')}</div>
          <button class="btn btn-default" id="page-retry">重试</button>
        </div>`
      $('#page-retry')?.addEventListener('click', () => navigate())
    })
}

function currentHash() { return location.hash || '#/dashboard' }

function navigate() {
  const hash = currentHash()
  const [path, query] = hash.split('?')
  const params = new URLSearchParams(query ?? '')
  const page = path.replace(/^#\//, '') || 'dashboard'

  // OAuth 协议页（授权/错误/登出）：独立于控制台外壳，无会话也放行（页面自带登录面板）
  if (page.startsWith('oauth/')) {
    const oauthBuilders = {
      'oauth/authorize': renderOauthAuthorize,
      'oauth/error': renderOauthError,
      'oauth/logout': renderOauthLogout,
    }
    guard(() => (oauthBuilders[page] ?? renderOauthError)(app, params), app)
    return
  }

  // 产品首页（公共营销页，#/home）：免会话可浏览；未登录裸落地（'' | '#/' | '#/dashboard'）
  // 也落首页——先让产品展示全貌，登录从导航/CTA 进入（不再直接整登录页）。
  // 例外：带 ?ticket= 的一键免登入口仍直落登录页（票据由登录页消费，落在营销页会静默丢票）。
  // 演示态（DEMO_MODE=1 免登只读会话）例外：裸落地直接进控制台——访客要的就是产品本体，
  // 营销首页仍可经 #/home 显式到达。
  const hasTicket = new URLSearchParams(location.search).has('ticket')
  if (page === 'home' || (!session.token && !session.isDemo && !hasTicket && isBareLanding(location.hash))) {
    guard(() => renderHome(app), app)
    return
  }

  // 显式 #/login 深链（含营销首页「登录」CTA）在演示态同样放行——访客可随时转真实登录
  // （演示实例上用演示账号登录即得完整功能），这是演示会话唯一不接管的路由。
  if (page === 'login' && !session.token) {
    guard(() => renderLogin(app), app)
    return
  }

  if (!session.token && !session.isDemo) {
    // 宿主连接页会话前置（docs/frontend-host-switching.md）：登录前就要能换目标宿主，
    // 以极简独立形态渲染（不走控制台外壳）；有会话时走下方 builders 在外壳内渲染。
    if (page === 'connections') {
      guard(() => renderConnections(app, params, { standalone: true }), app)
      return
    }
    guard(() => renderLogin(app), app)
    return
  }

  const builders = {
    dashboard: renderDashboard,
    iam: renderIam,
    authn: renderAuthn,
    mcp: renderMcp,
    nas: renderNas,
    'nas-authz': renderNasAuthz,
    connectors: renderConnectors,
    panels: renderPanels,
    skills: renderSkills,
    agents: renderAgents,
    a2a: renderA2a,
    apps: renderApps,
    assets: renderAssets,
    finops: renderFinops,
    exec: renderExec,
    audit: renderAudit,
    approvals: renderApprovals,
    platform: renderPlatform,
    connect: renderConnect,
    connections: renderConnections,
    gateway: renderGateway,
    usage: renderUsage,
    access: renderAccess,
    me: renderMe,
  }
  const builder = builders[page] ?? renderDashboard
  renderShell(page, params, builder)
}

function renderShell(page, params, builder) {
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img class="brand-mark brand-logo" src="ybk-mark.png" alt="元冰可">
          <div>
            <div class="brand-name" style="font-size:13.5px;line-height:1.3">元冰可 AIOS</div>
            <div class="brand-sub">企业 AI 资源管理平台</div>
          </div>
        </div>
        <nav class="sidebar-nav" id="nav"></nav>
        <div class="sidebar-footer" id="sidebar-footer"></div>
      </aside>
      <div class="sidebar-mask" id="sidebar-mask"></div>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn nav-toggle" id="nav-toggle" title="导航菜单" aria-label="打开导航菜单">${icon('menu')}</button>
          <div class="topbar-search" id="cmdk-trigger">
            ${icon('search', 15)}
            <span>搜索资源、执行操作…</span>
            <kbd>⌘K</kbd>
          </div>
          <div class="topbar-right">
            <div id="theme-switcher-host"></div>
            ${IS_LOCAL_HOST ? '' : `<button class="badge badge-warn no-dot" id="conn-indicator" title="当前连接远程宿主服务，点击管理连接" style="cursor:pointer;border:0">${icon('server', 13)} ${esc(CONNECTION_NAME)}</button>`}
            <button class="icon-btn" id="btn-refresh" title="刷新数据">${icon('refresh')}</button>
            <div style="position:relative" id="update-host"></div>
            <div style="position:relative" id="alert-host"></div>
            <div class="avatar" id="avatar" title="${esc(session.user?.displayName ?? '')}">${esc((session.user?.displayName ?? '?').slice(0, 1))}</div>
          </div>
        </header>
        ${session.isDemo ? `<div class="demo-banner" id="demo-banner" role="status">${icon('eye', 14)}<strong>${esc(rqI18n.t('演示模式 · 只读'))}</strong><span>${esc(rqI18n.t('写操作已禁用；自行部署后可体验完整功能（创建/审批/执行）。'))}</span></div>` : ''}
        <main class="content" id="page-content"></main>
      </div>
    </div>`

  // 首页与控制台互相切换时恢复语言选择器，不留下悬浮的重复控件。
  rqI18n.mountSwitcher()
  // 01门入口（2026-11-01）：演示横幅内补「打开工作台」——01门是 dsh 侧装态（/gate01/panel/），
  // 底座不感知；探针存在才渲染（gate01-entry.js），任何部署形态都不出死链。探测失败静默不露。
  if (session.isDemo) {
    void import('./gate01-entry.js')
      .then(({ probeGate01Panel }) => probeGate01Panel())
      .then((url) => {
        if (!url) return
        $('#demo-banner')?.insertAdjacentHTML('beforeend',
          `<a class="demo-banner-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(rqI18n.t('打开 01门 · 部门工作台'))}${icon('arrowUp', 13)}</a>`)
      })
      .catch(() => { /* 探测失败按未挂载处理 */ })
  }
  // 侧边导航
  const nav = $('#nav')
  // 高亮判定：同路径下「带查询」的项优先（如 #/a2a 与 #/a2a?tab=uhp 共存时只亮一个）
  const isActive = (item) => {
    if (!item.path) return false
    const [itemPath, itemQuery] = item.path.split('?')
    const [nowPath, nowQuery] = currentHash().split('?')
    if (itemPath !== nowPath) return false
    if (itemQuery) return itemQuery === (nowQuery ?? '')
    if (!nowQuery) return true
    return !NAV.some((group) => group.items.some((sibling) => sibling.path === `${nowPath}?${nowQuery}`))
  }
  for (const section of NAV) {
    const visible = section.items.filter((item) => session.can(item.perm))
    if (!visible.length) continue
    const sec = h(`<div class="nav-section"><div class="nav-section-title">${esc(section.section)}</div></div>`)
    for (const item of visible) {
      const active = isActive(item)
      const el = h(`<div class="nav-item ${active ? 'active' : ''}">${icon(item.icon)}<span>${esc(item.label)}</span><span class="nav-badge hidden"></span></div>`)
      el.onclick = () => {
        // 移动端抽屉导航（≤1024px）：选中即收起，避免遮挡落点内容
        document.body.classList.remove('nav-open')
        // ext 外链项（部门面板独立 SPA）：整页跳转，不进 hash 路由；显式跨工作台切换记录落地偏好
        if (item.ext) {
          if (item.landing) { try { localStorage.setItem(LANDING_PREF_KEY, item.landing) } catch { /* 忽略 */ } }
          location.assign(item.ext())
          return
        }
        location.hash = item.path
      }
      item._badgeEl = el.querySelector('.nav-badge')
      sec.appendChild(el)
    }
    nav.appendChild(sec)
  }

  // 侧边栏底部用户信息（浅色侧栏 · 设计适配：文字用语义 token，不再内联深色底专用色值）
  const footer = $('#sidebar-footer')
  footer.innerHTML = `
    <div class="flex" style="gap:10px">
      <div class="avatar sm">${esc((session.user?.displayName ?? '?').slice(0, 1))}</div>
      <div class="grow" style="min-width:0">
        <div class="fs-13 ellipsis" style="font-weight:600">${esc(session.user?.displayName ?? '')}</div>
        <div class="fs-11 ellipsis" style="color:var(--text-3)">${esc(session.user?.roles?.[0] ?? '成员')}</div>
      </div>
      <button class="icon-btn" id="btn-logout" title="${esc(session.isDemo ? rqI18n.t('退出演示') : rqI18n.t('退出登录'))}" style="width:28px;height:28px">${icon(session.isDemo ? 'x' : 'logout', 15)}</button>
    </div>`
  $('#btn-logout').onclick = async () => {
    // 演示会话：内存态身份，退出即清（无服务端会话可注销；回营销首页继续浏览）
    if (session.isDemo) {
      session.exitDemo()
      location.hash = '#/home'
      navigate()
      return
    }
    try { await api.post('/api/auth/logout') } catch { /* ignore */ }
    session.clear()
    location.hash = '#/login'
    navigate()
  }
  $('#btn-refresh').onclick = () => { navigate(); toast(rqI18n.t('数据已刷新')) }
  $('#conn-indicator')?.addEventListener('click', () => { location.hash = '#/connections' })
  $('#cmdk-trigger').onclick = () => openCmdk()
  $('#avatar').onclick = () => openCmdk()
  mountThemeSwitcher($('#theme-switcher-host'))

  // 移动端抽屉导航（≤1024px）：汉堡开合 + 遮罩点击收起；导航项点击已在上方收起
  $('#nav-toggle').onclick = () => document.body.classList.toggle('nav-open')
  $('#sidebar-mask').onclick = () => document.body.classList.remove('nav-open')

  // 徽标（待审批/未读告警）与平台更新提示
  void refreshBadges()
  void mountUpdateBadge()

  // 平台更新：30 分钟轮询一次徽标（自动检查的结果会在页面切换时自然刷新）
  clearInterval(window.__updatePoll)
  window.__updatePoll = setInterval(() => { if (session.token) void mountUpdateBadge() }, 30 * 60 * 1000)

  const content = $('#page-content')
  // 页面级统一兜底：任一页 builder 抛错（首请求 403/网络失败等）不再留白，渲染可重试错误卡
  builder(content, params, { rerender: navigate }).catch((error) => {
    content.innerHTML = `
      <div class="card card-pad" style="text-align:center;padding:44px 24px">
        <div style="font-size:30px;margin-bottom:10px">🚫</div>
        <div style="font-weight:600;margin-bottom:6px">页面加载失败</div>
        <div class="fs-12 text-3" style="margin-bottom:18px">${esc(error?.message ?? '未知错误')}</div>
        <button class="btn btn-default" id="page-retry">重试</button>
      </div>`
    $('#page-retry')?.addEventListener('click', () => navigate())
  })
}

async function refreshBadges() {
  try {
    const overview = await api.get('/api/overview')
    const targets = { approvals: overview.approvals?.pending ?? 0, alerts: overview.alerts?.unread ?? 0, skills: overview.skills?.pendingApproval ?? 0 }
    for (const section of NAV) {
      for (const item of section.items) {
        if (!item._badgeEl || !item.badge) continue
        const count = targets[item.badge] ?? 0
        item._badgeEl.textContent = String(count)
        item._badgeEl.classList.toggle('hidden', count === 0)
      }
    }
    const host = $('#alert-host')
    if (host && overview.alerts?.unread > 0) {
      host.innerHTML = `<button class="icon-btn" id="btn-alerts" title="${esc(rqI18n.t('{n} 条未读告警', { n: overview.alerts.unread }))}">${icon('bell')}<span class="dot"></span></button>`
      host.querySelector('#btn-alerts').onclick = () => { location.hash = '#/audit?tab=alerts' }
    } else if (host) {
      host.innerHTML = `<button class="icon-btn" title="暂无未读告警">${icon('bell')}</button>`
    }
  } catch { /* 静默 */ }
}

// 全局路由
window.addEventListener('hashchange', navigate)

/** 首个已登记且可达的面板地址（落地分诊用）；没有登记返回 ''。 */
function firstRegisteredPanelUrl() {
  const panel = resolvePanels(localStorage, new URL('.', document.baseURI).pathname.replace(/\/$/, ''))
    .find((item) => item.available)
  return panel?.url ?? ''
}

// 启动链：会话就绪 → 已登录态 next 消费 → 落地分诊 → 首帧渲染（docs/entry-switching.md）。
// 会话链与部门面板同款：已有令牌 → 宿主 Cookie 直通（独立形态 /dsh-bridge/* 不存在，静默跳过）；
// ?ticket= 由登录页消费（仅未登录落到登录页时生效）。
// 落地分诊：纯业务身份裸落地 → 进部门面板（一个入口按身份落地）；
// 面板/控制台的显式切换入口会记录偏好（heng_ops_landing），偏好=console 时不参与分诊；
// 深链（#/其他页面）与页内导航永不触发分诊。
async function boot() {
  if (!session.token) await exchangeBridgeSession()
  // 免登演示态探测（2026-10-17）：无令牌且服务端开启 DEMO_MODE=1 → 注入内存只读演示会话，
  // 直接进控制台（工作台首屏即产品全貌）。探测端点公开且失败回退 {demo:false}，
  // 演示能力缺失永不阻塞既有启动链；真令牌用户不受影响（isDemo 以 token 优先失效）。
  if (!session.token) {
    const status = await demoStatus()
    if (status.demo) {
      session.enterDemo({ principalId: status.principalId, name: status.name, readonlyPermissions: status.readonlyPermissions ?? [] })
    }
  }
  // 已登录态 next 消费（交接 F 清单 P 节，2026-09-11）：next 的解析/白名单/出口原本只在登录页，
  // 而控制台路由在已有会话时直接渲染外壳——宿主已登录时打开「宿主/?next=<面板地址>」参数被
  // 静默丢弃，远程 dsh 面板向导的跨源扫码回跳死洞（须先登出宿主才能走通）。现于启动链按
  // finishLogin 同规则出口（跨源签一次性自助票带 #entry_ticket= 回跳 / 同源直接跳转），
  // 已登录态扫码通道变成「打开宿主页 → 立即带票弹回面板」的静默授权；未登录态与既有登录页
  // 行为不变（登录页出口在 next-redirect.js 共享面，同一规则）。
  if (session.token && (await exitWithNext({ ...consumeNextSources(), api }))) return
  const user = session.user
  if (user && isBareLanding(location.hash) && resolveLanding(user) === 'panel') {
    let pref = ''
    try { pref = localStorage.getItem(LANDING_PREF_KEY) ?? '' } catch { /* 忽略 */ }
    if (pref !== 'console') {
      try { localStorage.setItem(LANDING_PREF_KEY, 'panel') } catch { /* 忽略 */ }
      // 面板入口以「宿主 × 部门」登记为准（#/panels）：有登记直达首个已登记面板，
      // 没登记就停在登记页引导——不再硬跳裸 /panel/ 让业务同学落到目标宿主的默认部门。
      const target = firstRegisteredPanelUrl()
      if (target) { location.replace(target); return }
      location.hash = '#/panels'
    }
  }
  navigate()
}

boot()

// ⌘K 快捷键；Esc 收起移动端抽屉导航
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (session.token) openCmdk()
  }
  if (e.key === 'Escape') document.body.classList.remove('nav-open')
})
