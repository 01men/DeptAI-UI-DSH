/** 应用外壳：路由 + 布局 + 侧边栏 + 顶栏 + ⌘K 命令面板。 */
import { icon } from './icons.js'
import { session, api, exchangeBridgeSession, BASE, IS_LOCAL_HOST, CONNECTION_NAME } from './api.js'
import { $, $$, h, toast, esc } from './ui.js'
import { openCmdk } from './cmdk.js'
import { replayPlatformTheme, PLATFORM_KEY } from './platform.js'
import { resolveLanding, isBareLanding, LANDING_PREF_KEY } from './landing.js'
import { consumeNextSources, exitWithNext } from './next-redirect.js'

// 平台主题（WP-05/B3）：启动即回放记忆的平台（免闪默认色）。写入方为平台身份下发方
// （applyPlatformTheme——卡片包域回流后的工作台校准、或部署方预置 heng_ops_platform 键）。
replayPlatformTheme()

// 钉钉微应用入口探测（WP-11）：钉钉 webview UA 且无记忆平台时，标记钉钉入口态。
// 只写独立键 heng_ops_dingtalk，不写 heng_ops_platform——钉钉是入口不是第六平台，不改五平台 data-platform 语义。
try {
  if (/DingTalk/i.test(navigator.userAgent) && !localStorage.getItem(PLATFORM_KEY)) {
    localStorage.setItem('heng_ops_dingtalk', '1')
    document.documentElement.dataset.platformEntry = 'dingtalk'
  }
} catch { /* 忽略 */ }

import { renderLogin } from './pages/login.js'
import { renderDashboard } from './pages/dashboard.js'
import { renderIam } from './pages/iam.js'
import { renderAuthn } from './pages/authn.js'
import { renderMcp } from './pages/mcp.js'
import { renderNas } from './pages/nas.js'
import { renderNasAuthz } from './pages/nas-authz.js'
import { renderConnectors } from './pages/connectors.js'
import { renderSkills } from './pages/skills.js'
import { renderAgents } from './pages/agents.js'
import { renderApps } from './pages/apps.js'
import { renderAudit } from './pages/audit.js'
import { renderApprovals } from './pages/approvals.js'
import { renderAssets } from './pages/assets.js'
import { renderFinops } from './pages/finops.js'
import { renderRegister } from './pages/register.js'
import { renderPlatform } from './pages/platform.js'
import { renderConnect } from './pages/connect.js'
import { renderConnections } from './pages/connections.js'
import { renderOauthAuthorize, renderOauthError, renderOauthLogout } from './pages/oauth.js'
import { mountUpdateBadge, openUpdateDrawer } from './update.js'

const NAV = [
  { section: '总览', items: [
    { path: '#/dashboard', label: '工作台', icon: 'dashboard', perm: 'console.login' },
    // 部门面板（review-dsh-agent-panel-v2）：独立零构建 SPA，经 ext 外链进入（/panel，挂载形态 /rq/panel/）
    { ext: () => `${BASE}/panel/`, label: '部门面板', icon: 'users', perm: 'console.login', landing: 'panel' },
  ] },
  { section: 'AI 资源', items: [
    { path: '#/register', label: '资产登记', icon: 'zap', perm: 'console.login' },
    { path: '#/skills', label: 'Skill 市场', icon: 'sparkles', perm: 'skill.read', badge: 'skills' },
    { path: '#/agents', label: 'Agent 本体', icon: 'bot', perm: 'agent.read' },
    { path: '#/apps', label: 'AI 应用', icon: 'app', perm: 'app.read' },
    { path: '#/mcp', label: 'MCP 服务', icon: 'plug', perm: 'mcp.service.read' },
    { path: '#/nas', label: 'NAS 存储', icon: 'server', perm: 'nas.read' },
    { path: '#/nas-authz', label: '数据权限', icon: 'shield', perm: 'nas.authz.read' },
    { path: '#/connectors', label: '连接器', icon: 'plug', perm: 'connector.catalog.read' },
  ] },
  { section: '治理与运营', items: [
    { path: '#/assets', label: '资产运营', icon: 'layers', perm: 'usage.read' },
    { path: '#/finops', label: '财务视图', icon: 'coins', perm: 'usage.read' },
    { path: '#/approvals', label: '审批中心', icon: 'checkSquare', perm: 'approval.read', badge: 'approvals' },
    { path: '#/audit', label: '审计与告警', icon: 'scroll', perm: 'audit.read', badge: 'alerts' },
    { path: '#/authn', label: '认证与令牌', icon: 'key', perm: 'authn.principal.read' },
  ] },
  { section: '组织', items: [
    { path: '#/iam', label: '组织与账号', icon: 'users', perm: 'iam.user.read' },
    { path: '#/iam?tab=roles', label: '角色权限', icon: 'shield', perm: 'iam.org.read' },
    { path: '#/iam?tab=connectors', label: '三方集成', icon: 'link', perm: 'iam.org.read' },
  ] },
  { section: '平台', items: [
    { path: '#/connect', label: '平台接入', icon: 'fingerprint', perm: 'connect.manage' },
    { path: '#/connections', label: '宿主服务连接', icon: 'server', perm: 'console.login' },
    { path: '#/platform', label: '插件与工具', icon: 'puzzle', perm: 'console.login' },
  ] },
]

const app = $('#app')

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
    ;(oauthBuilders[page] ?? renderOauthError)(app, params)
    return
  }

  if (!session.token) {
    // 宿主连接页会话前置（docs/frontend-host-switching.md）：登录前就要能换目标宿主，
    // 以极简独立形态渲染（不走控制台外壳）；有会话时走下方 builders 在外壳内渲染。
    if (page === 'connections') {
      renderConnections(app, params, { standalone: true })
      return
    }
    renderLogin(app)
    return
  }

  const builders = {
    dashboard: renderDashboard,
    register: renderRegister,
    iam: renderIam,
    authn: renderAuthn,
    mcp: renderMcp,
    nas: renderNas,
    'nas-authz': renderNasAuthz,
    connectors: renderConnectors,
    skills: renderSkills,
    agents: renderAgents,
    apps: renderApps,
    assets: renderAssets,
    finops: renderFinops,
    audit: renderAudit,
    approvals: renderApprovals,
    platform: renderPlatform,
    connect: renderConnect,
    connections: renderConnections,
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
            <div class="brand-name" style="white-space:normal;font-size:13px;line-height:1.35">元冰可|企业AI资源管理平台</div>
            <div class="brand-sub">DeepSeek Harness · 一切皆插件</div>
          </div>
        </div>
        <nav class="sidebar-nav" id="nav"></nav>
        <div class="sidebar-footer" id="sidebar-footer"></div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="topbar-search" id="cmdk-trigger">
            ${icon('search', 15)}
            <span>搜索资源、执行操作…</span>
            <kbd>⌘K</kbd>
          </div>
          <div class="topbar-right">
            ${IS_LOCAL_HOST ? '' : `<button class="badge badge-warn no-dot" id="conn-indicator" title="当前连接远程宿主服务，点击管理连接" style="cursor:pointer;border:0">${icon('server', 13)} ${esc(CONNECTION_NAME)}</button>`}
            <button class="icon-btn" id="btn-refresh" title="刷新数据">${icon('refresh')}</button>
            <div style="position:relative" id="update-host"></div>
            <div style="position:relative" id="alert-host"></div>
            <div class="avatar" id="avatar" title="${esc(session.user?.displayName ?? '')}">${esc((session.user?.displayName ?? '?').slice(0, 1))}</div>
          </div>
        </header>
        <main class="content" id="page-content"></main>
      </div>
    </div>`

  // 侧边导航
  const nav = $('#nav')
  for (const section of NAV) {
    const visible = section.items.filter((item) => session.can(item.perm))
    if (!visible.length) continue
    const sec = h(`<div class="nav-section"><div class="nav-section-title">${esc(section.section)}</div></div>`)
    for (const item of visible) {
      const active = item.path && currentHash().split('?')[0] === item.path
      const el = h(`<div class="nav-item ${active ? 'active' : ''}">${icon(item.icon)}<span>${esc(item.label)}</span><span class="nav-badge hidden"></span></div>`)
      el.onclick = () => {
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

  // 侧边栏底部用户信息
  const footer = $('#sidebar-footer')
  footer.innerHTML = `
    <div class="flex" style="gap:10px">
      <div class="avatar sm">${esc((session.user?.displayName ?? '?').slice(0, 1))}</div>
      <div class="grow" style="min-width:0">
        <div class="fs-13 ellipsis" style="color:#e5e7eb">${esc(session.user?.displayName ?? '')}</div>
        <div class="fs-11 text-4 ellipsis">${esc(session.user?.roles?.[0] ?? '成员')}</div>
      </div>
      <button class="icon-btn" id="btn-logout" title="退出登录" style="width:28px;height:28px">${icon('logout', 15)}</button>
    </div>`
  $('#btn-logout').onclick = async () => {
    try { await api.post('/api/auth/logout') } catch { /* ignore */ }
    session.clear()
    location.hash = '#/login'
    navigate()
  }
  $('#btn-refresh').onclick = () => { navigate(); toast('数据已刷新') }
  $('#conn-indicator')?.addEventListener('click', () => { location.hash = '#/connections' })
  $('#cmdk-trigger').onclick = () => openCmdk()
  $('#avatar').onclick = () => openCmdk()

  // 徽标（待审批/未读告警）与平台更新提示
  void refreshBadges()
  void mountUpdateBadge()

  // 平台更新：30 分钟轮询一次徽标（自动检查的结果会在页面切换时自然刷新）
  clearInterval(window.__updatePoll)
  window.__updatePoll = setInterval(() => { if (session.token) void mountUpdateBadge() }, 30 * 60 * 1000)

  const content = $('#page-content')
  builder(content, params, { rerender: navigate })
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
      host.innerHTML = `<button class="icon-btn" id="btn-alerts" title="${overview.alerts.unread} 条未读告警">${icon('bell')}<span class="dot"></span></button>`
      host.querySelector('#btn-alerts').onclick = () => { location.hash = '#/audit?tab=alerts' }
    } else if (host) {
      host.innerHTML = `<button class="icon-btn" title="暂无未读告警">${icon('bell')}</button>`
    }
  } catch { /* 静默 */ }
}

// 全局路由
window.addEventListener('hashchange', navigate)

// 启动链：会话就绪 → 已登录态 next 消费 → 落地分诊 → 首帧渲染（docs/entry-switching.md）。
// 会话链与部门面板同款：已有令牌 → 宿主 Cookie 直通（独立形态 /dsh-bridge/* 不存在，静默跳过）；
// ?ticket= 由登录页消费（仅未登录落到登录页时生效）。
// 落地分诊：纯业务身份裸落地 → 进部门面板（一个入口按身份落地）；
// 面板/控制台的显式切换入口会记录偏好（heng_ops_landing），偏好=console 时不参与分诊；
// 深链（#/其他页面）与页内导航永不触发分诊。
async function boot() {
  if (!session.token) await exchangeBridgeSession()
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
      location.replace(`${BASE}/panel/`)
      return
    }
  }
  navigate()
}

boot()

// ⌘K 快捷键
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (session.token) openCmdk()
  }
})
