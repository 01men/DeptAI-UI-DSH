/**
 * 连接与登录向导（M2，fresh-install 首启体验）。
 *
 * 触发：boot.js 探测到宿主连接为 none 且浏览器无会话时渲染本向导。
 * 两条路径（B/C 双形态）：
 *   - 连接宿主（统一语义）：本机（localhost 预填）与远端地址同一流程——地址输入/扫描 →
     probe → 登录（登录在宿主侧完成）；探测到本机数据面时提供「在本机控制台登录」直达链接；
 *   - 连接远端宿主：手动输入/扫描宿主地址（IP:port）→ 测试连接 → 账号密码登录
     （经本机插件代理，浏览器零跨域）；钉钉扫码引导到宿主登录页完成。
 *     （经本机插件代理，浏览器零跨域）；钉钉扫码引导到宿主登录页完成。
 *
 * 数据面：全部经 /rqcard/* 免登向导端点（须带 x-rqcard-call 头，服务端 CSRF 防线）；
 * 远端登录经 /rqcard/proxy/api/auth/login（白名单内）。登录成功后 location.reload()
 * 重走 boot 链（作用域/代理/会话一次性就位）。
 */
import { api, setConnectionScope, setRemoteProxy, session } from './api.js'

const esc = (text) => String(text ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const HISTORY_KEY = 'panel_hub_history'

/** 向导端点请求：统一带向导头；非 2xx 抛错（error.message 透出）。
 *  超时与网络错误给中文可行动文案（QA BUG-U-03/U-04 同规）。 */
async function wfetch(base, method, wpath, body) {
  let response
  try {
    response = await fetch(`${base}${wpath}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-rqcard-call': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('请求超时：服务响应过慢，请稍后重试')
    }
    throw new Error('网络连接失败：请确认服务已启动、地址正确后重试')
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error?.message ?? `请求失败（${response.status}）`)
  }
  return payload?.data
}

function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') } catch { return [] }
}

function rememberHub(hubBase, label) {
  const list = readHistory().filter((item) => item.hubBase !== hubBase)
  list.unshift({ hubBase, label: label ?? '', savedAt: new Date().toISOString() })
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 6)))
}

export async function start({ base, hostBridge = false }) {
  const root = document.getElementById('app')
  root.innerHTML = `
    <div class="wizard">
      <div class="wz-head">
        <div class="wz-logo">🌳 01门 <span class="badge">开始使用</span></div>
        <p>欢迎使用部门工作台！只需两步：选择「把这台电脑作为工作台」或「连接公司已有的服务器」，
        完成后即可使用部门工作台、战略看板和 Agent 协作。不确定选哪个？问一下公司里负责系统的人。</p>
      </div>
      <div class="wz-cards">
        <section class="wz-card" id="wzLocal">
          <h2>🖥 把这台电脑作为工作台</h2>
          <p class="wz-sub">适合第一次使用、或这台电脑就是公司唯一服务器的情况。数据和账号都保存在本机。</p>
          <div id="wzLocalBody"></div>
        </section>
        <section class="wz-card" id="wzRemote">
          <h2>🔗 连接公司已有的服务器</h2>
          <p class="wz-sub">适合公司已经部署了服务器、大家共用的情况。输入服务器的地址（可扫码）即可。</p>
          <div id="wzRemoteBody"></div>
        </section>
      </div>
      <p class="wz-foot">登录支持账号密码与钉钉扫码；使用中的问题请联系管理员。数据与权限统一由服务器管理。</p>
    </div>`

  renderLocalCard(root, base)
  renderRemoteCard(root, base)
}

// ---------------------------------------------------------------- 本机（连接统一语义的一侧）
// plan-gate01 决策 1（2026-09-10）：「本机初始化」（形态 B 设口令）已随服务端向导本机链路整体
// 删除——本机与远端统一为「连接宿主」流程，登录在宿主侧完成。本卡片只做两件事：
//   1. 探测本机数据面（同源 /api/health 的 JSON 信封）：在场 = 全量开发形态 → 给「在本机控制台登录」直达链接；
//   2. 缺席 = 纯 01门 装态 → 诚实引导去右侧「连接公司已有的服务器」。

async function renderLocalCard(root, base) {
  const body = root.querySelector('#wzLocalBody')
  // next 传绝对 URL（G1 票据分支白名单 = 回环/私网）：同源相对路径只落裸跳转，面板拿不到会话
  const here = encodeURIComponent(location.origin + location.pathname + location.search + location.hash)
  let hubReachable = false
  let loginAvailable = false
  let loginUnavailable = false
  try {
    // 数据面探测：/api/health 是 console 的路由（01门装态缺席），改探面板自有
    // /api/panel/depts——任何 HTTP 应答（200 演示放行 / 401 严格态）都证明数据面在场。
    const response = await fetch(`${base}/api/panel/depts`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) })
    hubReachable = response.status > 0 && response.status !== 404
  } catch { /* 本机数据面缺席 = 纯 01门 装态 */ }
  if (hubReachable) {
    // 登录面探测（2026-09-11 写通道补环）：console 在场 → 走控制台登录页；console 缺席但
    // authn 在场（01门 6-entry 装态面板自持登录面）→ 本卡片直接给同源登录表单。
    // 探针 = 空 body POST /api/panel/auth/login（panel 自有命名空间，不依赖 console）：
    //   400 = 登录面可用；503 = 认证面未装配（纯演示形态）；401 = console 中间件在守（走控制台）。
    let probeStatus = 0
    try {
      const probe = await fetch(`${base}/api/panel/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(3000),
      })
      probeStatus = probe.status
    } catch { /* 探测失败按不可登录处理 */ }
    loginAvailable = probeStatus === 400
    loginUnavailable = probeStatus === 503
  }
  if (hubReachable && loginUnavailable) {
    body.innerHTML = `
      <div class="wz-ok">🖥 本机数据面已就绪，但认证面未装配（纯演示形态）。</div>
      <p class="wz-hint">当前可以只读浏览内置演示数据；账号登录需要装配中包含认证中心（ops-authn）。</p>`
  } else if (hubReachable && loginAvailable) {
    body.innerHTML = `
      <div class="wz-ok">✅ 本机数据面已就绪，可直接登录。</div>
      <div class="wz-form">
        <input type="text" id="wzLocalUser" placeholder="账号" autocomplete="username" value="">
        <input type="password" id="wzLocalPass" placeholder="密码" autocomplete="current-password">
        <button class="btn primary" id="wzLocalGo">登录</button>
      </div>
      <div id="wzLocalErr" class="wz-err"></div>
      <p class="wz-hint">首次部署：管理员账号 admin，初始口令见服务器数据目录 admin-initial-password.txt。</p>`
    body.querySelector('#wzLocalGo').onclick = async (event) => {
      const button = event.target
      const errBox = body.querySelector('#wzLocalErr')
      errBox.textContent = ''
      button.disabled = true
      try {
        const response = await fetch(`${base}/api/panel/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: body.querySelector('#wzLocalUser').value.trim(),
            password: body.querySelector('#wzLocalPass').value,
          }),
          signal: AbortSignal.timeout(15_000),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok === false) throw new Error(payload?.error?.message ?? '登录失败')
        session.save(payload.data.token, payload.data.user)
        if (payload.data.refreshToken) session.saveRefresh(payload.data.refreshToken)
        window.location.reload()
      } catch (error) {
        button.disabled = false
        errBox.textContent = error.message
      }
    }
  } else if (hubReachable) {
    body.innerHTML = `
      <div class="wz-ok">✅ 本机数据面已就绪。</div>
      <a href="${base}/?next=${here}#/login"><button class="btn primary">在本机控制台登录</button></a>
      <p class="wz-hint">支持账号密码与钉钉扫码（本机同源，登录后自动回到面板）。</p>`
  } else {
    body.innerHTML = `
      <div class="wz-ok">🖥 这台电脑还没有可登录的控制台。</div>
      <p class="wz-hint">在右侧「连接公司已有的服务器」输入地址开始使用；首次部署的管理员请先在宿主服务器上完成安装。</p>`
  }
}
// ---------------------------------------------------------------- 远端宿主（形态 C）

async function renderRemoteCard(root, base) {
  const body = root.querySelector('#wzRemoteBody')
  body.innerHTML = `
    <div class="wz-form">
      <input type="text" id="wzHubInput" placeholder="服务器地址，如 http://192.168.1.5:7300" spellcheck="false">
      <button class="btn primary" id="wzHubConnect">测试并连接</button>
    </div>
    <button class="btn wz-scan" id="wzHubScan">📡 在局域网内自动查找服务器</button>
    <div class="wz-history" id="wzHubHistory"></div>
    <div class="wz-found" id="wzHubFound"></div>
    <div id="wzHubErr" class="wz-err"></div>`

  const history = readHistory()
  const historyBox = body.querySelector('#wzHubHistory')
  historyBox.innerHTML = history.length > 0
    ? `<span class="wz-hint">最近：</span>` + history.map((item) =>
      `<button class="wz-chip" data-hub="${esc(item.hubBase)}">${esc(item.hubBase)}</button>`).join('')
    : ''
  historyBox.querySelectorAll('.wz-chip').forEach((el) => {
    el.onclick = () => { body.querySelector('#wzHubInput').value = el.dataset.hub }
  })

  body.querySelector('#wzHubScan').onclick = async (event) => {
    const button = event.target
    button.disabled = true
    button.textContent = '扫描中…（约数秒）'
    const found = body.querySelector('#wzHubFound')
    found.innerHTML = '<span class="wz-hint">正在探测本网段常见端口（7300/3080）…</span>'
    try {
      const candidates = [...new Set([...history.map((item) => item.hubBase)])]
      const result = await wfetch(base, 'POST', '/rqcard/link/scan', candidates.length > 0 ? { candidates } : {})
      found.innerHTML = result.hosts.length > 0
        ? result.hosts.map((host) => `
          <button class="wz-host" data-hub="${esc(host.endpoint)}">
            <b>${esc(host.endpoint)}</b>
            <span class="sub">01门服务器${host.version ? ` · v${esc(host.version)}` : ''}</span>
          </button>`).join('')
        : '<span class="wz-hint">没有找到服务器——请确认服务器已开机、防火墙已放行，或直接输入地址。</span>'
      found.querySelectorAll('.wz-host').forEach((el) => {
        el.onclick = () => { body.querySelector('#wzHubInput').value = el.dataset.hub }
      })
    } catch (error) {
      found.innerHTML = `<span class="wz-err">${esc(error.message)}</span>`
    } finally {
      button.disabled = false
      button.textContent = '📡 在局域网内自动查找服务器'
    }
  }

  body.querySelector('#wzHubConnect').onclick = async (event) => {
    const button = event.target
    const hubBase = body.querySelector('#wzHubInput').value.trim()
    const errBox = body.querySelector('#wzHubErr')
    errBox.textContent = ''
    button.disabled = true
    try {
      const result = await wfetch(base, 'POST', '/rqcard/link/remote', { hubBase })
      rememberHub(result.config.hubBase, result.config.label)
      renderRemoteLogin(body, base, {
        hubBase: result.config.hubBase,
        hubMountPrefix: result.config.hubMountPrefix ?? '',
        version: result.probe?.version,
      })
    } catch (error) {
      errBox.textContent = error.message
    } finally {
      button.disabled = false
    }
  }
}

/** 远端连接成功后的登录步骤：账号密码（代理全闭环）+ 钉钉扫码（宿主页完成，G1 回跳前向兼容）。 */
function renderRemoteLogin(body, base, { hubBase, hubMountPrefix, version }) {
  const hubPanelBase = `${hubBase}${hubMountPrefix}`
  // G1 前向兼容（交接清单 handoff-f-remainder G1-a）：把本机面板绝对地址作为 next 带给宿主登录页——
  // 宿主已采纳回跳增强时，扫码/登录完成即按 next 自动回到本机 dsh 并携带一次性 entry_ticket
  // （boot.js 兑换建立会话）；未采纳的宿主按防 open redirect 白名单忽略跨源 next（落宿主默认页），
  // 行为与从前一致、无害。
  const localPanelUrl = `${location.origin}${base}/panel/`
  body.innerHTML = `
    <div class="wz-ok">✅ 已连接服务器 <b>${esc(hubBase)}</b>${version ? `（v${esc(version)}）` : ''}</div>
    <div class="wz-form">
      <input type="text" id="wzLoginUser" placeholder="账号" autocomplete="username" value="">
      <input type="password" id="wzLoginPass" placeholder="密码" autocomplete="current-password">
      <button class="btn primary" id="wzLoginGo">登录</button>
    </div>
    <button class="btn wz-dd" id="wzLoginDd">💬 用钉钉扫码登录</button>
    <p class="wz-hint">没有账号？请联系管理员开通。账号登录成功后自动进入本工作台；钉钉扫码会打开登录页，完成后自动回到本页，若未自动返回请点下方「我已完成扫码」。</p>
    <button class="btn wz-back" id="wzLoginCheck">我已完成扫码——校验本机会话</button>
    <button class="btn wz-back" id="wzLoginBack">← 重新选择服务器</button>
    <div id="wzLoginErr" class="wz-err"></div>`
  body.querySelector('#wzLoginDd').onclick = () => {
    // 零弹窗铁律合规（2026-10-29 架构统一）：整页跳转宿主登录页；登录成功后按 next 回跳本机面板
    window.location.href = `${hubPanelBase}/?next=${encodeURIComponent(localPanelUrl)}#/login`
  }
  // 回导校验（G1 未采纳期的诚实降级）：本机面板与宿主跨源，浏览器同源隔离使宿主页扫码会话
  // 无法直接带回——这里只校验「本机是否已持有该连接的有效会话」：有效即进工作台；无效则如实
  // 说明并导向账号密码登录，不假装能取回宿主侧会话。
  body.querySelector('#wzLoginCheck').onclick = async () => {
    const errBox = body.querySelector('#wzLoginErr')
    errBox.textContent = ''
    // 作用域与代理对齐当前连接：me 走代理白名单（api.js 自带 401 刷新重试与向导头）
    setConnectionScope(hubBase)
    setRemoteProxy(true)
    if (!session.token) {
      errBox.textContent = '本机没有该连接的会话：宿主页的扫码会话无法跨站带回（浏览器同源隔离）。请用上方账号密码登录（同一宿主账号，经本机代理全闭环）；宿主侧 G1 回跳增强上线后扫码将自动带回本机。'
      return
    }
    try {
      await api.get('/api/auth/me')
      window.location.reload()
    } catch {
      session.clear()
      errBox.textContent = '本机会话已失效：宿主页的扫码会话无法跨站带回（浏览器同源隔离）。请用上方账号密码重新登录（同一宿主账号，经本机代理全闭环）。'
    }
  }
  body.querySelector('#wzLoginBack').onclick = () => {
    void wfetch(base, 'POST', '/rqcard/link/reset', {}).then(() => window.location.reload())
  }
  body.querySelector('#wzLoginGo').onclick = async (event) => {
    const button = event.target
    button.disabled = true
    body.querySelector('#wzLoginErr').textContent = ''
    try {
      // 登录走代理白名单（/api/auth/login）：作用域先切到该宿主，令牌按连接隔离
      setConnectionScope(hubBase)
      const response = await fetch(`${base}/rqcard/proxy/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rqcard-call': '1' },
        body: JSON.stringify({
          username: body.querySelector('#wzLoginUser').value.trim(),
          password: body.querySelector('#wzLoginPass').value,
        }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error?.message ?? '登录失败')
      session.save(payload.data.token, payload.data.user)
      if (payload.data.refreshToken) session.saveRefresh(payload.data.refreshToken)
      rememberHub(hubBase)
      window.location.reload()
    } catch (error) {
      button.disabled = false
      body.querySelector('#wzLoginErr').textContent = error.message
    }
  }
}
