/** ⌘K 命令面板：搜资源、跳页面、执行高频动作。 */
import { api, session } from './api.js'
import { icon } from './icons.js'
import { h, esc, toast, $ } from './ui.js'
import rqI18n from './i18n.js'

export function openCmdk() {
  closeCmdk()
  const mask = h(`
    <div class="cmdk-mask">
      <div class="cmdk">
        <div class="cmdk-input-wrap">
          ${icon('search', 18)}
          <input class="cmdk-input" placeholder="搜索资源或输入命令…（如：下线 agent、发布 skill）" autofocus>
          <kbd style="font-size:10.5px;background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:1px 5px;color:var(--text-4)">ESC</kbd>
        </div>
        <div class="cmdk-list"></div>
      </div>
    </div>`)
  document.body.appendChild(mask)
  const input = mask.querySelector('.cmdk-input')
  const list = mask.querySelector('.cmdk-list')
  let items = []
  let activeIndex = 0

  mask.onclick = (e) => { if (e.target === mask) closeCmdk() }
  const onKey = (e) => {
    if (e.key === 'Escape') { closeCmdk(); window.removeEventListener('keydown', onKey, true) }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    if (e.key === 'Enter') { e.preventDefault(); items[activeIndex]?.run() }
  }
  window.addEventListener('keydown', onKey, true)
  input.oninput = () => void refresh(input.value)
  input.focus()

  function move(delta) {
    activeIndex = Math.max(0, Math.min(items.length - 1, activeIndex + delta))
    render()
  }

  async function refresh(q) {
    const query = q.trim()
    const staticItems = buildStaticItems(query)
    let dynamicItems = []
    if (query.length >= 1 && session.token) {
      dynamicItems = await buildDynamicItems(query)
    }
    items = [...staticItems, ...dynamicItems].slice(0, 14)
    activeIndex = 0
    render()
  }

  function highlight(text, q) {
    if (!q) return esc(text)
    const index = text.toLowerCase().indexOf(q.toLowerCase())
    if (index < 0) return esc(text)
    return esc(text.slice(0, index)) + '<b>' + esc(text.slice(index, index + q.length)) + '</b>' + esc(text.slice(index + q.length))
  }

  function render() {
    const q = input.value.trim()
    const groups = new Map()
    for (const item of items) {
      if (!groups.has(item.group)) groups.set(item.group, [])
      groups.get(item.group).push(item)
    }
    let html = ''
    let idx = 0
    for (const [group, groupItems] of groups) {
      html += `<div class="cmdk-group-title">${esc(group)}</div>`
      for (const item of groupItems) {
        html += `
          <div class="cmdk-item ${idx === activeIndex ? 'active' : ''}" data-idx="${idx}">
            ${icon(item.icon ?? 'chevronRight', 16)}
            <div class="cmdk-item-title grow">
              <div>${highlight(item.title, q)}</div>
              ${item.sub ? `<div class="cmdk-item-sub">${esc(item.sub)}</div>` : ''}
            </div>
            ${item.kbd ? `<kbd>${esc(item.kbd)}</kbd>` : ''}
          </div>`
        idx++
      }
    }
    if (!items.length) html = '<div style="padding:28px;text-align:center;color:var(--text-4);font-size:13px">没有匹配的结果</div>'
    list.innerHTML = html
    list.querySelectorAll('.cmdk-item').forEach((el) => {
      el.onmouseenter = () => { activeIndex = Number(el.dataset.idx); render() }
      el.onclick = () => items[Number(el.dataset.idx)]?.run()
    })
  }

  void refresh('')
}

function closeCmdk() {
  document.querySelectorAll('.cmdk-mask').forEach((el) => el.remove())
}

function buildStaticItems(q) {
  const pages = [
    { title: '工作台', hash: '#/dashboard', icon: 'dashboard' },
    { title: '执行中枢（目标/任务/调度）', hash: '#/exec', icon: 'target', perm: 'exec.read' },
    { title: 'A2A 协作（数字员工协作面）', hash: '#/a2a', icon: 'flow', perm: 'a2a.directory.read' },
    { title: 'UHP 执行（执行体与执行记录）', hash: '#/a2a?tab=uhp', icon: 'cpu', perm: 'uhp.read' },
    { title: '资产台账（六类统一盘点）', hash: '#/assets', icon: 'layers', perm: 'usage.read' },
    { title: 'Skill 市场', hash: '#/skills', icon: 'sparkles', perm: 'skill.read' },
    { title: '模型网关', hash: '#/gateway', icon: 'route', perm: 'usage.read' },
    { title: 'Agent 本体', hash: '#/agents', icon: 'bot', perm: 'agent.read' },
    { title: 'AI 应用', hash: '#/apps', icon: 'app', perm: 'app.read' },
    { title: 'MCP 服务', hash: '#/mcp', icon: 'plug', perm: 'mcp.service.read' },
    { title: 'NAS 存储', hash: '#/nas', icon: 'server', perm: 'nas.read' },
    { title: '数据权限', hash: '#/nas-authz', icon: 'shield', perm: 'nas.authz.read' },
    { title: '连接器', hash: '#/connectors', icon: 'plug', perm: 'connector.catalog.read' },
    { title: '用量与成本', hash: '#/usage', icon: 'barChart3', perm: 'usage.read' },
    { title: '财务视图', hash: '#/finops', icon: 'coins', perm: 'usage.read' },
    { title: '审批中心', hash: '#/approvals', icon: 'checkSquare', perm: 'approval.read' },
    { title: '审计与告警', hash: '#/audit', icon: 'scroll', perm: 'audit.read' },
    { title: '组织与账号', hash: '#/iam', icon: 'users', perm: 'iam.user.read' },
    { title: '角色权限', hash: '#/iam?tab=roles', icon: 'shield', perm: 'iam.org.read' },
    { title: '三方集成（钉钉同步）', hash: '#/iam?tab=connectors', icon: 'link', perm: 'iam.org.read' },
    { title: '平台接入', hash: '#/access', icon: 'fingerprint', perm: 'connect.manage' },
    { title: '我的接入', hash: '#/me', icon: 'user', perm: 'console.login' },
    { title: '宿主服务连接', hash: '#/connections', icon: 'server', perm: 'console.login' },
    { title: '认证与令牌', hash: '#/authn', icon: 'key', perm: 'authn.principal.read' },
    { title: '插件与工具', hash: '#/platform', icon: 'puzzle' },
  ]
  const actions = []
  if (session.can('skill.submit')) actions.push({ title: '提交新 Skill 到市场', hash: '#/skills?action=submit', icon: 'plus', group: '动作' })
  if (session.can('agent.write')) actions.push({ title: '注册新 Agent', hash: '#/agents?action=create', icon: 'plus', group: '动作' })
  if (session.can('app.write')) actions.push({ title: '注册新 AI 应用', hash: '#/apps?action=create', icon: 'plus', group: '动作' })
  if (session.can('mcp.service.write')) actions.push({ title: '接入新 MCP 服务', hash: '#/mcp?action=deploy', icon: 'plus', group: '动作' })
  if (session.can('iam.connector.write')) actions.push({ title: '触发钉钉通讯录同步', hash: '#/iam?tab=connectors&action=sync', icon: 'refresh', group: '动作' })
  if (session.can('authn.principal.write')) actions.push({ title: '签发机器凭证', hash: '#/authn?action=credential', icon: 'key', group: '动作' })
  // 执行中枢新建任务（R8）：跳 #/exec 后派发自定义事件打开抽屉；exec.js 首渲染以标记位兜底早到事件
  if (session.can('exec.write')) actions.push({
    title: '新建执行任务', icon: 'plus', group: '动作',
    run: () => {
      go('#/exec')
      window.__execNewIssueRequested = true
      setTimeout(() => window.dispatchEvent(new CustomEvent('exec:new-issue')), 350)
    },
  })

  const all = [
    ...pages.filter((p) => !p.perm || session.can(p.perm)).map((p) => ({ ...p, group: '页面', run: () => go(p.hash) })),
    ...actions.map((a) => ({ ...a, run: () => go(a.hash) })),
  ]
  if (!q) return all.slice(0, 8)
  return all.filter((item) => item.title.toLowerCase().includes(q.toLowerCase()))
}

async function buildDynamicItems(q) {
  const items = []
  try {
    const [skills, agents, apps, mcps] = await Promise.all([
      session.can('skill.read') ? api.get('/api/skills' + api.qs({ q })) : Promise.resolve({ skills: [] }),
      session.can('agent.read') ? api.get('/api/agents') : Promise.resolve({ agents: [] }),
      session.can('app.read') ? api.get('/api/apps') : Promise.resolve({ apps: [] }),
      session.can('mcp.service.read') ? api.get('/api/mcp/services') : Promise.resolve({ services: [] }),
    ])
    for (const skill of (skills.skills ?? []).slice(0, 3)) {
      items.push({ group: 'Skill', icon: 'sparkles', title: skill.name, sub: rqI18n.t('市场 · {status}', { status: skill.status }), run: () => go(`#/skills?focus=${skill.id}`) })
    }
    for (const agent of (agents.agents ?? []).filter((a) => `${a.name}${a.slug}`.toLowerCase().includes(q.toLowerCase())).slice(0, 3)) {
      items.push({ group: 'Agent', icon: 'bot', title: agent.name, sub: `${agent.slug} · ${agent.status}`, run: () => go(`#/agents?focus=${agent.id}`) })
    }
    for (const app of (apps.apps ?? []).filter((a) => `${a.name}${a.slug}`.toLowerCase().includes(q.toLowerCase())).slice(0, 3)) {
      items.push({ group: 'AI 应用', icon: 'app', title: app.name, sub: `${app.slug} · ${app.status}`, run: () => go(`#/apps?focus=${app.id}`) })
    }
    for (const svc of (mcps.services ?? []).filter((s) => `${s.name}${s.slug}`.toLowerCase().includes(q.toLowerCase())).slice(0, 3)) {
      items.push({ group: 'MCP 服务', icon: 'plug', title: svc.name, sub: `${svc.slug} · ${svc.status}`, run: () => go(`#/mcp?focus=${svc.id}`) })
    }
  } catch { /* 静默 */ }
  return items
}

function go(hash) {
  closeCmdk()
  if (location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    location.hash = hash
  }
}
