/** AI 应用本体：列表 + 详情（指标/编排拓扑/成本穿透/生命周期）。 */
import { api, session } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog, copyText,
  statusBadge, renderTable, collectForm, field, inputField, selectField, textareaField,
  fmtNum, fmtPct, fmtCost, fmtTime, timeAgo, emptyState, lineChart, maybeShowConceptCard,
  multiSelectField, searchableSelectField, mountSearchableSelects,
} from '../ui.js'
import { buildAppOnboardingText, openOnboardingModal } from '../onboarding.js'
import { errorBarHtml } from '../errors.js'
import { ASSET_CATEGORIES, assetCategory } from '../taxonomy.js'
import {
  dataClassLabel, riskClass, riskLabel, typeLabel, stateLabel, actionLabel,
  miniStat, renderTopologyList, barChartSafe,
} from './agents.js'

const APP_TYPE = { web: ['Web 应用', 'globe'], h5: ['H5', 'app'], miniapp: ['小程序', 'app'], desktop: ['桌面端', 'server'], api: ['API 服务', 'plug'] }

const isIconUrl = (value) => /^https?:\/\//i.test(String(value ?? '').trim())

/** 输入防抖（列表搜索用）。 */
function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}

/** 头像 / 图标渲染：http(s) 图片地址渲染为 <img> 头像，其余按 emoji 文本展示（.res-icon 同尺寸）。 */
function appIconHtml(value) {
  if (isIconUrl(value)) {
    return `<img class="res-icon" src="${esc(String(value).trim())}" alt="" referrerpolicy="no-referrer" style="object-fit:cover;background:linear-gradient(135deg,#eef6ff,#dcecff)">`
  }
  return `<div class="res-icon" style="background:linear-gradient(135deg,#eef6ff,#dcecff);font-size:21px">${esc(String(value ?? '').trim() || '✨')}</div>`
}

/** 平台授权直达：签发一次性入场票据后带 #entry_ticket 同窗口整页跳转应用
 *  （裸跳转已下线；弹窗子窗口已消灭——与应用自有 OIDC 接入互不影响，§6）。 */
async function openAppEntry(app) {
  try {
    const issued = await api.post(`/api/apps/${app.id}/entry-ticket`)
    location.assign(`${app.attrs['url']}#entry_ticket=${encodeURIComponent(issued.ticket)}`)
  } catch (error) { toast(error.message, 'error') }
}

export async function renderApps(content, params, ctx) {
  const data = await api.get('/api/apps')
  const apps = data.apps

  // 首次访问概念卡（易用性整改）
  maybeShowConceptCard(content, 'apps', {
    icon: 'app',
    title: 'AI 应用是什么？',
    subtitle: 'AI 应用 = 员工直接使用的智能应用入口（问答助手、文档助手等）。',
    points: [
      '形态多样：在 Agent 底座上扩展 Web / H5 / 小程序等访问入口。',
      '依赖可穿透：应用 → Agent → MCP/Skill 的调用链与成本一图归集。',
      '治理统一：谁能用、用了多少，走平台统一身份与审计。',
    ],
  })

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">AI APPS</div>
        <div class="page-title">AI 应用</div>
        <div class="page-sub">在 Agent 底座上扩展应用形态与访问入口；应用 → Agent → MCP/Skill 依赖一图穿透，成本链路可归集。</div>
      </div>
      <div class="page-actions">
        ${session.can('app.write') ? `<button class="btn btn-primary" id="app-add">${icon('plus', 14)}注册应用</button>` : ''}
      </div>
    </div>
    <div class="filter-bar">
      <div class="search-input">${icon('search')}<input class="input" id="app-q" placeholder="搜索应用名称 / 标识"></div>
      <div class="chips" id="app-cats">
        <span class="chip active" data-c="">全部</span>
        ${ASSET_CATEGORIES.map((cat) => `<span class="chip" data-c="${cat}">${cat}</span>`).join('')}
      </div>
      <span class="fs-12 text-3" style="margin-left:auto" id="app-count"></span>
    </div>
    <div class="card-grid" id="app-cards"></div>`

  const apps0 = apps
  let appFilter = { q: '', category: '' }

  const renderCards = () => {
    const list = apps0.filter((a) => {
      if (appFilter.category && assetCategory(a.attrs) !== appFilter.category) return false
      if (appFilter.q && !`${a.name}${a.slug}`.toLowerCase().includes(appFilter.q.toLowerCase())) return false
      return true
    })
    const countEl = $('#app-count')
    if (countEl) countEl.textContent = rqI18n.t('共 {n} 个应用', { n: list.length })
    const holder = $('#app-cards')
    if (!holder) return
    holder.innerHTML = ''
    if (!list.length) {
      holder.appendChild(emptyState({ title: '没有匹配的 AI 应用', desc: '换个分类或关键字试试', icon: 'app' }))
      return
    }
    for (const app of list) {
      const [typeLabel_, typeIcon] = APP_TYPE[app.attrs['appType']] ?? ['应用', 'app']
      const card = h(`
      <div class="res-card" data-id="${esc(app.id)}">
        <div class="res-card-top">
          ${appIconHtml(app.attrs['icon'])}
          <div class="grow">
            <div class="res-name">${esc(app.name)} ${statusBadge(app.status)}</div>
            <div class="res-slug">${esc(app.slug)} · ${esc(rqI18n.t(typeLabel_))}${app.attrs['publishVersion'] ? ' · ' + esc(app.attrs['publishVersion']) : ''}</div>
          </div>
        </div>
        <div class="res-desc">${esc(app.attrs['description'] ?? '')}</div>
        <div class="flex" style="gap:6px;flex-wrap:wrap">
          <span class="badge badge-brand no-dot">${esc(assetCategory(app.attrs))}</span>
          ${(Array.isArray(app.attrs['agentIds']) ? app.attrs['agentIds'] : []).length
            ? `<span class="badge badge-purple no-dot">${esc(rqI18n.t('编排 {n} 个 Agent', { n: app.attrs['agentIds'].length }))}</span>` : '<span class="text-4 fs-12">未编排 Agent</span>'}
          ${(app.attrs['channels'] ?? []).map((ch) => `<span class="badge badge-muted no-dot">${esc(ch)}</span>`).join('')}
        </div>
        <div class="res-foot">
          <div class="res-foot-main">
            <span class="metric">${icon('eye', 13)}PV ${fmtNum(app.metrics.pv ?? 0)}</span>
            <span class="metric">${icon('users', 13)}UV ${fmtNum(app.metrics.uv ?? 0)}</span>
            <span class="metric">${icon('users', 13)}DAU ${fmtNum(app.metrics.dau)}</span>
            <span class="metric">${icon('activity', 13)}${esc(rqI18n.t('会话 {n}', { n: fmtNum(app.metrics.sessions) }))}</span>
          </div>
          <div class="res-foot-side">
            ${app.attrs['url'] ? `<a class="btn btn-ghost btn-sm" data-entry href="javascript:void(0)">${icon('external', 13)}打开</a>` : ''}
            ${app.attrs['developerName'] ? `<span class="text-4">${esc(rqI18n.t('开发者 · {name}', { name: app.attrs['developerName'] }))}</span>` : ''}
          </div>
        </div>
      </div>`)
      const entryBtn = card.querySelector('[data-entry]')
      if (entryBtn) entryBtn.onclick = (e) => { e.stopPropagation(); void openAppEntry(app) }
      card.onclick = () => openAppDetail(app.id, ctx)
      holder.appendChild(card)
    }
  }

  $('#app-q').oninput = debounce(() => { appFilter.q = $('#app-q').value.trim(); renderCards() }, 250)
  $$('#app-cats .chip').forEach((chip) => {
    chip.onclick = () => {
      $$('#app-cats .chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      appFilter.category = chip.dataset.c
      renderCards()
    }
  })
  renderCards()

  const addBtn = $('#app-add')
  if (addBtn) addBtn.onclick = () => openAppCreate(data.schema, ctx)
  if (params.get('action') === 'create' && session.can('app.write')) openAppCreate(data.schema, ctx)
  if (params.get('focus')) void openAppDetail(params.get('focus'), ctx)
}

async function openAppDetail(id, ctx) {
  const app = await api.get(`/api/apps/${id}`)
  const titleIcon = isIconUrl(app.attrs['icon'])
    ? `<img src="${esc(String(app.attrs['icon']).trim())}" alt="" referrerpolicy="no-referrer" style="width:22px;height:22px;border-radius:6px;object-fit:cover;vertical-align:-4px;margin-right:6px">`
    : esc(app.attrs['icon'] ?? '✨')
  const drawer = openDrawer({
    title: `${titleIcon} ${app.name}`,
    sub: `${app.slug} · ${app.attrs['url'] ?? rqI18n.t('未登记访问地址')}`,
    wide: true,
    body: `
      <div class="flex mb-14" style="gap:8px;flex-wrap:wrap">
        ${statusBadge(app.status)}
        <span class="badge ${riskClass(app.attrs['riskLevel'])} no-dot">${esc(rqI18n.t('风险：{level}', { level: rqI18n.t(riskLabel(app.attrs['riskLevel'])) }))}</span>
        <span class="badge badge-info no-dot">${esc(rqI18n.t('密级：{level}', { level: rqI18n.t(dataClassLabel(app.attrs['dataClass'])) }))}</span>
        ${app.attrs['developerName'] ? `<span class="badge badge-muted no-dot">${icon('user', 12)} ${esc(rqI18n.t('开发者：{name}', { name: app.attrs['developerName'] }))}</span>` : ''}
        ${(app.attrs['channels'] ?? []).map((ch) => `<span class="badge badge-muted no-dot">${esc(ch)}</span>`).join('')}
        ${app.attrs['url'] ? `<button class="btn btn-default btn-sm" id="app-open-entry">${icon('external', 13)}带平台身份打开应用</button>` : '<span class="text-4 fs-12">未登记访问地址</span>'}
      </div>

      <div class="stat-grid mb-20" style="grid-template-columns:repeat(6,1fr)">
        ${miniStat('eye', '今日 PV', fmtNum(app.metrics.pv ?? 0))}
        ${miniStat('users', '今日 UV', fmtNum(app.metrics.uv ?? 0))}
        ${miniStat('users', '今日 DAU', fmtNum(app.metrics.dau))}
        ${miniStat('activity', '累计会话', fmtNum(app.metrics.sessions))}
        ${miniStat('zap', '会话深度', rqI18n.t('{n} 轮', { n: app.metrics.avgDepth }))}
        ${miniStat('trending', '7 日留存', fmtPct(app.metrics.retention7))}
      </div>

      <div class="tabs" id="app-tabs">
        <div class="tab active" data-tab="topology">编排拓扑</div>
        <div class="tab" data-tab="metrics">应用指标</div>
        <div class="tab" data-tab="cost">成本穿透</div>
        <div class="tab" data-tab="caps">${icon('puzzle', 13)} MCP 能力</div>
        <div class="tab" data-tab="creds">${icon('lock', 13)} 外部凭证</div>
        <div class="tab" data-tab="lifecycle">生命周期</div>
        <div class="tab" data-tab="sso">${icon('key', 13)} SSO 配置${app.sso ? (app.sso.status === 'active' ? '' : ' ⚠') : ''}</div>
      </div>
      <div id="app-tab-body"></div>`,
    foot: (app.availableTransitions.map((t) => {
      const isL4 = t.action === 'online' || t.action === 'offline'
      return `<button class="btn ${isL4 ? 'btn-primary' : 'btn-default'}" data-action="${esc(t.action)}">${icon(t.action === 'online' ? 'play' : t.action === 'offline' ? 'alert' : 'chevronRight', 14)}${esc(t.label)}</button>`
    }).join('') || '<button class="btn btn-default" disabled>终态</button>')
      + `<button class="btn btn-default" id="app-onboard">${icon('book', 14)}生成接入提示词</button>`
      + `<button class="btn btn-default" id="app-edit">${icon('edit', 14)}编辑资料</button>`
      + (['draft', 'archived'].includes(app.status) ? `<button class="btn btn-danger-ghost" id="app-delete">${icon('trash', 14)}删除</button>` : ''),
  })

  const tabBody = drawer.body.querySelector('#app-tab-body')
  const openEntryBtn = drawer.body.querySelector('#app-open-entry')
  if (openEntryBtn) openEntryBtn.onclick = () => void openAppEntry(app)
  const renderTab = (tab) => {
    if (tab === 'topology') {
      tabBody.innerHTML = `
        <div class="card card-pad mb-14">
          <div class="card-title mb-14">${icon('gitBranch', 14)} 依赖拓扑（应用 → Agent → MCP/Skill）</div>
          ${topologySvg(app.topology)}
          <div class="form-hint mt-8">异常节点标红；一图穿透到底层能力，出问题可快速定位层级。</div>
        </div>
        <div class="card card-pad">
          <div class="card-title mb-8">结构化视图</div>
          ${renderTopologyList(app.topology)}
        </div>
        ${app.impact.length ? `
          <div class="card card-pad mt-14" style="border-color:var(--warn-border);background:var(--warn-bg)">
            <div class="card-title mb-8">${icon('alert', 14)} 影响面（若下架）</div>
            ${app.impact.map((i) => `<div class="fs-13" style="padding:3px 0">${esc(rqI18n.t('· {name}（{type}）', { name: i.name, type: rqI18n.t(typeLabel(i.type)) }))}</div>`).join('')}
          </div>` : ''}`
    }
    if (tab === 'metrics') {
      tabBody.innerHTML = `
        <div class="card card-pad mb-14">
          <div class="card-title mb-8">近 14 天 UV / DAU（日去重口径）</div>
          ${lineChart([app.metrics.series.map((s) => s.uv ?? 0), app.metrics.series.map((s) => s.dau)], { width: 640, height: 150, colors: ['#10b981', '#0052D9'], labels: ['UV', 'DAU'] })}
        </div>
        <div class="card card-pad mb-14">
          <div class="card-title mb-8">近 14 天 PV（页面浏览量）</div>
          ${barChartSafe(app.metrics.series.map((s) => ({ label: s.date, value: s.pv ?? 0 })), 640, 150)}
        </div>
        <div class="card card-pad">
          <div class="card-title mb-8">近 14 天会话数</div>
          ${barChartSafe(app.metrics.series.map((s) => ({ label: s.date, value: s.sessions })), 640, 150)}
        </div>`
    }
    if (tab === 'cost') {
      const total = app.cost.reduce((s, row) => s + row.costYuan, 0)
      tabBody.innerHTML = `
        <div class="flex-between mb-14">
          <div><span class="fs-12 text-3">累计成本</span><div style="font-size:22px;font-weight:700">${fmtCost(total)}</div></div>
          <span class="fs-12 text-3">应用 → Agent → MCP/模型 穿透归集</span>
        </div>
        ${app.cost.map((row) => `
          <div class="flex" style="padding:10px 0;border-bottom:1px solid var(--border)">
            <span class="badge badge-purple no-dot">Agent</span>
            <span class="fs-13 grow">${esc(row.agentName)}</span>
            <span class="fs-12 text-3" style="margin-right:14px">${esc(rqI18n.t('Token {t} · 调用 {c}', { t: fmtNum(row.llmTokens), c: fmtNum(row.toolCalls) }))}</span>
            <span style="font-weight:600">${fmtCost(row.costYuan)}</span>
          </div>`).join('') || '<span class="text-4 fs-12">暂无成本数据</span>'}`
    }
    if (tab === 'caps') renderCapsTab(tabBody, app, ctx)
    if (tab === 'creds') renderCredsTab(tabBody, app, ctx)
    if (tab === 'lifecycle') {
      tabBody.innerHTML = `
        <div class="timeline">
          ${app.lifecycleHistory.map((entry, index) => `
            <div class="timeline-item ${index === app.lifecycleHistory.length - 1 ? 'current' : 'ok'}">
              <div class="timeline-dot"></div>
              <div class="timeline-title">${esc(rqI18n.t('{action} → {state}', { action: entry.action === 'create' ? rqI18n.t('注册创建') : rqI18n.t(actionLabel(entry.action)), state: rqI18n.t(stateLabel(entry.to)) }))}</div>
              <div class="timeline-time">${esc(rqI18n.t('{time} · 操作人 {name}', { time: timeAgo(entry.at), name: entry.actor }))}</div>
              ${entry.note ? `<div class="timeline-body">${esc(entry.note)}</div>` : ''}
            </div>`).join('')}
        </div>`
    }
    if (tab === 'sso') renderSsoTab(tabBody, app, ctx)
  }
  drawer.body.querySelectorAll('#app-tabs .tab').forEach((el) => {
    el.onclick = () => {
      drawer.body.querySelectorAll('#app-tabs .tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })
  renderTab('topology')

  for (const transition of app.availableTransitions) {
    const btn = drawer.el.querySelector(`[data-action="${transition.action}"]`)
    if (!btn) continue
    btn.onclick = async () => {
      if (transition.action === 'online' || transition.action === 'offline') {
        const isOnline = transition.action === 'online'
        const result = await confirmDialog({
          title: isOnline ? '应用发布上线（L4）' : '应用下架（L4）',
          requireReason: !isOnline,
          danger: !isOnline,
          confirmText: '提交审批',
          message: isOnline
            ? rqI18n.t('发布 <b>{name}</b> 需要另一管理员审批确认。', { name: esc(app.name) })
            : rqI18n.t('下架 <b>{name}</b> 后终端用户立即无法访问，机器凭证同步吊销。', { name: esc(app.name) }),
        })
        if (!result) return
        try {
          await api.post(`/api/apps/${app.id}/transition`, { action: transition.action, note: result.reason ?? '发布申请' })
          toast(rqI18n.t('已创建审批单')); drawer.close(); ctx.rerender()
        } catch (error) {
          // 能力门禁早反馈（W2-T4 契约 §10）：message 列明服务名+原因，就地解析为醒目清单而非一闪而过的 toast
          if (String(error.message).includes('CAPABILITY_GATE_FAILED')) openCapabilityGateModal(error.message)
          else toast(error.message, 'error')
        }
      } else {
        try {
          await api.post(`/api/apps/${app.id}/transition`, { action: transition.action })
          toast(rqI18n.t('状态已更新')); drawer.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    }
  }

  const editBtn = drawer.el.querySelector('#app-edit')
  if (editBtn) editBtn.onclick = () => openAppEdit(app, ctx)

  const onboardBtn = drawer.el.querySelector('#app-onboard')
  if (onboardBtn) onboardBtn.onclick = () => openAppOnboardPrompt(app)

  const deleteBtn = drawer.el.querySelector('#app-delete')
  if (deleteBtn) deleteBtn.onclick = async () => {
    const result = await confirmDialog({
      title: rqI18n.t('删除应用 · {name}', { name: app.name }), requireReason: true, danger: true, confirmText: '确认删除',
      message: rqI18n.t('将永久删除 <b>{name}</b>：清除编排依赖、禁用 SSO 客户端与机器凭证，操作不可恢复；指标与审计数据保留。', { name: esc(app.name) }),
    })
    if (!result) return
    try {
      await api.delete(`/api/apps/${app.id}`)
      toast(rqI18n.t('已删除')); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
}

/** SSO 配置 tab：未签发 → 签发引导；已签发 → 回调管理 / 轮换 / 启停 / discovery；两态均附「平台直达」卡片。 */
function renderSsoTab(holder, app, ctx) {
  const sso = app.sso
  const enforced = (app.ssoEnforceTypes ?? []).includes(app.attrs['appType'])
  if (!sso) {
    holder.innerHTML = `
      <div class="card card-pad">
        <div class="card-title mb-8">${icon('key', 14)} 应用身份纳管（SSO）</div>
        <div class="fs-13 text-2 mb-8" style="line-height:1.9">
          签发 OIDC 客户端后，应用即可按标准协议接入平台统一身份：
          <div class="muted-box mt-8" style="font-size:12.5px">
            ① 授权码模式跳转 <code class="mono">${esc(app.sso?.discovery?.authorization_endpoint ?? '/oauth/authorize')}</code>（强制 PKCE S256）<br>
            ② <code class="mono">code</code> 换 <code class="mono">id_token / access_token</code>（Basic 或 Post 认证）<br>
            ③ <code class="mono">access_token</code> 调 <code class="mono">/oauth/userinfo</code> 取用户身份（sub / org / roles / tenant），业务权限应用内自理
          </div>
        </div>
        ${enforced ? `<div class="muted-box mb-14" style="display:flex;gap:8px;border-color:var(--warn-border);background:var(--warn-bg)">${icon('alert', 15)}<span><b>${esc(rqI18n.t('{type} 形态应用上线门禁', { type: app.attrs['appType'] }))}</b>${esc(rqI18n.t('：未完成 SSO 签发前，上线审批将被拒绝。'))}</span></div>` : ''}
        <button class="btn btn-primary" id="sso-issue">${icon('key', 14)}签发 SSO 客户端</button>
        <a class="btn btn-default" href="https://github.com/01men/ybkkasi/blob/main/docs/app-sso-integration.md" target="_blank" style="margin-left:8px">接入文档</a>
        <div class="form-hint mt-8">本机联调免控制台：回调地址为环回（127.0.0.1 / localhost / 0.0.0.0）时，应用机器凭证可直接 <code class="mono">POST /api/apps/${esc(app.id)}/sso-client</code> 自助签发并一次性取回 secret（改回调 PATCH 同路径，换 secret POST …/rotate）。</div>
      </div>
      ${entryDirectCardHtml(app)}`
    holder.querySelector('#sso-issue').onclick = () => openIssueSsoModal(app, ctx)
    wireEntryDirectCard(holder, app)
    return
  }
  const active = sso.status === 'active'
  holder.innerHTML = `
    <div class="card card-pad mb-14">
      <div class="flex-between mb-8">
        <div class="card-title">${icon('key', 14)} 已签发客户端 ${statusBadge(active ? 'active' : 'frozen', active ? '使用中' : '已禁用')}</div>
        <span class="badge ${sso.clientType === 'public' ? 'badge-purple' : 'badge-info'} no-dot">${sso.clientType === 'public' ? 'public（免 secret · 强制 PKCE）' : 'confidential'}</span>
      </div>
      <div class="desc-grid mb-14">
        <div class="desc-item"><span class="k">client_id</span><span class="v mono">${esc(sso.clientId)} <button class="btn btn-ghost btn-sm" id="sso-copy-id">复制</button></span></div>
        <div class="desc-item"><span class="k">关联应用</span><span class="v">${esc(sso.refAppName ?? app.name)}</span></div>
        <div class="desc-item"><span class="k">签发时间</span><span class="v">${fmtTime(sso.createdAt)}</span></div>
      </div>
      <div class="form-item">
        <label class="form-label">回调地址（redirect_uris，每行一个；https://，或 http:// 内网/本机地址）</label>
        <textarea class="form-control mono" id="sso-redirects" rows="2">${esc(sso.redirectUris.join('\n'))}</textarea>
      </div>
      <div class="form-item">
        <label class="form-label">登出回跳白名单（post_logout_redirect_uris，每行一个，可空）</label>
        <textarea class="form-control mono" id="sso-postlogouts" rows="2">${esc((sso.postLogoutUris ?? []).join('\n'))}</textarea>
      </div>
      <label class="flex" style="gap:8px;font-size:13px;margin:6px 0 12px;cursor:pointer">
        <input type="checkbox" id="sso-consent" ${sso.consentRequired ? 'checked' : ''} style="accent-color:var(--brand-500)">
        <span>授权页要求用户显式勾选同意（对外部应用建议开启）</span>
      </label>
      <div class="flex" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="sso-save">${icon('check', 14)}保存配置</button>
        ${sso.clientType !== 'public' ? `<button class="btn btn-default" id="sso-rotate">${icon('refresh', 14)}轮换 secret</button>` : ''}
        ${active
          ? '<button class="btn btn-danger-ghost" id="sso-disable">禁用客户端</button>'
          : '<button class="btn btn-primary" id="sso-enable">启用客户端</button>'}
      </div>
      ${!active && enforced ? `<div class="muted-box mt-8" style="display:flex;gap:8px;border-color:var(--warn-border);background:var(--warn-bg)">${icon('alert', 15)}<span>${esc(rqI18n.t('客户端处于禁用状态：{type} 形态应用的上线门禁将被阻断。', { type: app.attrs['appType'] }))}</span></div>` : ''}
    </div>
    <div class="card card-pad">
      <div class="card-title mb-8">${icon('plug', 14)} 接入端点（discovery）</div>
      <div class="desc-grid">
        <div class="desc-item"><span class="k">issuer</span><span class="v mono">${esc(sso.discovery.issuer)}</span></div>
        <div class="desc-item"><span class="k">authorize</span><span class="v mono">${esc(sso.discovery.authorization_endpoint)}</span></div>
        <div class="desc-item"><span class="k">token</span><span class="v mono">${esc(sso.discovery.token_endpoint)}</span></div>
        <div class="desc-item"><span class="k">userinfo</span><span class="v mono">${esc(sso.discovery.userinfo_endpoint)}</span></div>
      </div>
      <div class="flex mt-8" style="gap:8px">
        <button class="btn btn-default btn-sm" id="sso-copy-discovery">复制 discovery 地址</button>
        <a class="btn btn-default btn-sm" href="https://github.com/01men/ybkkasi/blob/main/docs/app-sso-integration.md" target="_blank">接入文档</a>
      </div>
      <div class="form-hint mt-8">应用侧按 OIDC 标准接入（openid-client / oidc-client-ts 一行 discovery 驱动）；id_token 验签公钥见 JWKS：<code class="mono">${esc(sso.discovery.issuer)}/.well-known/jwks.json</code></div>
    </div>
    ${entryDirectCardHtml(app)}`
  holder.querySelector('#sso-copy-id').onclick = () => void copyText(sso.clientId)
  holder.querySelector('#sso-copy-discovery').onclick = () => void copyText(`${sso.discovery.issuer}/.well-known/openid-configuration`)
  wireEntryDirectCard(holder, app)
  holder.querySelector('#sso-save').onclick = async () => {
    const redirectUris = holder.querySelector('#sso-redirects').value.split('\n').map((s) => s.trim()).filter(Boolean)
    const postLogoutUris = holder.querySelector('#sso-postlogouts').value.split('\n').map((s) => s.trim()).filter(Boolean)
    try {
      await api.patch(`/api/apps/${app.id}/sso-client`, { redirectUris, postLogoutUris, consentRequired: holder.querySelector('#sso-consent').checked })
      toast(rqI18n.t('SSO 配置已保存')); openAppDetail(app.id, ctx)
    } catch (error) { toast(error.message, 'error') }
  }
  const rotateBtn = holder.querySelector('#sso-rotate')
  if (rotateBtn) rotateBtn.onclick = async () => {
    const result = await confirmDialog({
      title: '轮换 client_secret', danger: true, confirmText: '确认轮换',
      message: '旧 secret <b>立即失效</b>，应用侧需同步更新。新 secret 仅展示一次。',
    })
    if (!result) return
    try {
      const rotated = await api.post(`/api/apps/${app.id}/sso-client/rotate`)
      showSsoSecret(rotated)
    } catch (error) { toast(error.message, 'error') }
  }
  const disableBtn = holder.querySelector('#sso-disable')
  if (disableBtn) disableBtn.onclick = async () => {
    const result = await confirmDialog({
      title: '禁用 SSO 客户端', requireReason: true, danger: true, confirmText: '立即禁用',
      message: '禁用后该应用的登录跳转与令牌刷新立即失败（refresh 链一并吊销）。',
    })
    if (!result) return
    try {
      await api.post(`/api/apps/${app.id}/sso-client/disable`, { reason: result.reason })
      toast(rqI18n.t('客户端已禁用')); openAppDetail(app.id, ctx)
    } catch (error) { toast(error.message, 'error') }
  }
  const enableBtn = holder.querySelector('#sso-enable')
  if (enableBtn) enableBtn.onclick = async () => {
    try {
      await api.post(`/api/apps/${app.id}/sso-client/enable`)
      toast(rqI18n.t('客户端已启用')); openAppDetail(app.id, ctx)
    } catch (error) { toast(error.message, 'error') }
  }
}

/** 平台直达（entry-ticket）卡片：与应用自有 OIDC 接入互补，未签发 SSO 客户端也可用。 */
function entryDirectCardHtml(app) {
  if (!app.attrs['url']) {
    return `
      <div class="card card-pad mt-14">
        <div class="card-title mb-8">${icon('external', 14)} 平台直达（entry-ticket）</div>
        <div class="form-hint">未登记访问地址（attrs.url）——登记后控制台即可带平台身份直达应用。</div>
      </div>`
  }
  return `
    <div class="card card-pad mt-14">
      <div class="flex-between mb-8">
        <div class="card-title">${icon('external', 14)} 平台直达（entry-ticket）</div>
        <span class="badge badge-ok no-dot">已启用</span>
      </div>
      <div class="desc-grid mb-14">
        <div class="desc-item"><span class="k">访问地址</span><span class="v mono">${esc(app.attrs['url'])}</span></div>
        <div class="desc-item"><span class="k">兑换端点</span><span class="v mono">POST /api/authn/entry-tickets/redeem</span></div>
        <div class="desc-item"><span class="k">票据时效</span><span class="v">一次性 · 短时（默认 120s）</span></div>
      </div>
      <div class="flex" style="gap:8px">
        <button class="btn btn-primary" id="sso-entry-open">${icon('external', 14)}带平台身份打开应用</button>
      </div>
      <div class="form-hint mt-8">「打开应用」按钮已升级为带平台身份直达：签发一次性票据后以 <code class="mono">#entry_ticket=…</code> 打开，应用前端兑换平台身份；与上方标准 OIDC 授权码接入互不影响。</div>
    </div>`
}

function wireEntryDirectCard(holder, app) {
  const btn = holder.querySelector('#sso-entry-open')
  if (btn) btn.onclick = () => void openAppEntry(app)
}

/** MCP 能力 tab（W2-T4 契约 §10 控制台消费面）：能力清单 + 绑定/解绑。
 *  服务摘要由后端投影（零 headers）；GET/POST/DELETE 端点权限点为 app.write。 */
function renderCapsTab(holder, app, ctx) {
  if (!session.can('app.write')) {
    holder.innerHTML = `<div class="muted-box">${esc(rqI18n.t('能力绑定属应用管理操作（app.write），当前账号无权限查看。'))}</div>`
    return
  }
  holder.innerHTML = '<div class="text-4 fs-12">加载中…</div>'
  void (async () => {
    const [capData, svcData] = await Promise.all([
      api.get(`/api/apps/${app.id}/capabilities`).catch(() => null),
      api.get('/api/mcp/services').catch(() => ({ services: [] })),
    ])
    const capabilities = capData?.capabilities ?? []
    const boundIds = new Set(capabilities.map((c) => c.serviceId))
    const candidates = (svcData.services ?? []).filter((s) => !boundIds.has(s.id))
    holder.innerHTML = `
      <div class="card card-pad mb-14">
        <div class="card-title mb-8">${icon('puzzle', 14)} ${esc(rqI18n.t('已绑定 MCP 能力（{n}）', { n: capabilities.length }))}</div>
        <div class="fs-12 text-3 mb-8">${esc(rqI18n.t('能力 = 应用对 MCP 服务的显式声明：required 能力参与上线门禁（服务须在线/已验证/工具非空/凭证就绪）；绑定自动回写服务归属。'))}</div>
        ${capabilities.length ? capabilities.map((cap) => {
          const svc = cap.service
          return `
            <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border);gap:8px;flex-wrap:wrap">
              <span class="fs-13" style="font-weight:500;min-width:140px">${esc(svc?.name ?? cap.serviceId)}</span>
              ${svc ? statusBadge(svc.status) : '<span class="badge badge-muted no-dot">—</span>'}
              ${svc ? `<span class="badge ${svc.dataClass === 'confidential' ? 'badge-danger' : svc.dataClass === 'public' ? 'badge-ok' : 'badge-info'} no-dot">${esc(rqI18n.t(dataClassLabel(svc.dataClass)))}</span>` : ''}
              <span class="badge ${cap.required ? 'badge-warn' : 'badge-muted'} no-dot">${cap.required ? esc(rqI18n.t('必需（门禁项）')) : esc(rqI18n.t('可选'))}</span>
              ${svc ? `<span class="badge ${svc.health?.status === 'healthy' ? 'badge-ok' : svc.health?.status === 'degraded' ? 'badge-warn' : 'badge-muted'} no-dot">${esc(rqI18n.t('健康：{status}', { status: svc.health?.status ?? 'unknown' }))}</span>` : ''}
              ${svc ? `<span class="fs-12 text-3">${esc(rqI18n.t('{n} 工具', { n: svc.toolCount ?? 0 }))}${svc.hasCredential ? ` · ${esc(rqI18n.t('凭证就绪'))}` : ''}</span>` : ''}
              <button class="btn btn-ghost btn-sm stop" data-unbind="${esc(cap.serviceId)}" style="color:var(--danger);margin-left:auto">${icon('x', 12)}${esc(rqI18n.t('解绑'))}</button>
            </div>`
        }).join('') : `<div class="text-4 fs-12">${esc(rqI18n.t('尚未绑定任何 MCP 能力（编排 Agent 可直接调用，能力声明用于应用级门禁与归属治理）。'))}</div>`}
      </div>
      <div class="card card-pad">
        <div class="card-title mb-8">${icon('plus', 14)} ${esc(rqI18n.t('绑定新能力'))}</div>
        <div id="cap-bind-error"></div>
        ${candidates.length ? `
          <div class="form-grid">
            ${field(rqI18n.t('选择 MCP 服务'), searchableSelectField('serviceId', candidates.map((s) => ({
              value: s.id,
              label: `${s.name}（${s.slug}）· ${s.status}`,
            })), { placeholder: rqI18n.t('搜索服务名称 / 标识') }), { required: true })}
            <label class="flex" style="gap:8px;font-size:13px;align-items:center;cursor:pointer">
              <input type="checkbox" id="cap-required" style="accent-color:var(--brand-500)">
              <span>${esc(rqI18n.t('设为必需能力（required，参与上线门禁）'))}</span>
            </label>
          </div>
          <button class="btn btn-primary btn-sm mt-8" id="cap-bind">${icon('link', 13)}${esc(rqI18n.t('绑定'))}</button>`
        : `<div class="text-4 fs-12">${esc(rqI18n.t('没有可绑定的服务（全部已绑定，或无 MCP 服务）。'))}</div>`}
      </div>`
    mountSearchableSelects(holder)
    holder.querySelectorAll('[data-unbind]').forEach((btn) => {
      btn.onclick = async () => {
        const ack = await confirmDialog({
          title: rqI18n.t('解绑能力服务'),
          message: rqI18n.t('解绑后该服务不再参与本应用的上线门禁；若服务归属本应用，将联动还原为平台占位。'),
          confirmText: rqI18n.t('确认解绑'),
        })
        if (!ack) return
        try {
          await api.delete(`/api/apps/${app.id}/capabilities/${btn.dataset.unbind}`)
          toast(rqI18n.t('已解绑'))
          renderCapsTab(holder, app, ctx)
        } catch (error) { toast(error.message, 'error') }
      }
    })
    const bindBtn = holder.querySelector('#cap-bind')
    if (bindBtn) {
      bindBtn.onclick = async () => {
        const serviceId = collectForm(holder).serviceId
        if (!serviceId) return toast(rqI18n.t('请选择要绑定的 MCP 服务'), 'error')
        const required = holder.querySelector('#cap-required')?.checked === true
        try {
          await api.post(`/api/apps/${app.id}/capabilities`, { serviceId, required })
          toast(rqI18n.t('已绑定（服务归属同步回写本应用）'))
          renderCapsTab(holder, app, ctx)
        } catch (error) {
          // 归属冲突按 errors.js 既有文案渲染（OWNER_CONFLICT），后端 message 附具体服务明细
          holder.querySelector('#cap-bind-error').innerHTML = error.code === 'OWNER_CONFLICT'
            ? errorBarHtml('OWNER_CONFLICT') + `<div class="fs-12 text-3" style="margin:-8px 0 12px">${esc(error.message)}</div>`
            : `<div class="muted-box fs-13 mb-14" style="border-color:var(--danger);color:var(--danger)">${esc(error.message)}</div>`
          toast(error.message, 'error')
        }
      }
    }
  })()
}

/** 能力门禁拒绝（CAPABILITY_GATE_FAILED）解析弹窗：把 message 中「——」后的「；」分隔失败项列成清单。 */
function openCapabilityGateModal(message) {
  const text = String(message)
  const body = text.includes('——') ? text.slice(text.indexOf('——') + 2) : text
  const items = body.split('；').map((s) => s.trim()).filter(Boolean)
  openModal({
    title: rqI18n.t('上线门禁未通过（能力检查）'),
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px;border-color:var(--warn-border);background:var(--warn-bg)">
        ${icon('alert', 15)}<span>${esc(rqI18n.t('以下 required 能力未满足上线条件（须在线/已验证/工具非空/无未决高危/凭证就绪）。逐项处理后再发起上线审批。'))}</span>
      </div>
      ${items.map((item) => `
        <div class="flex" style="padding:7px 0;border-bottom:1px dashed var(--border);gap:8px">
          <span style="color:var(--danger);display:flex">${icon('circleAlert', 14)}</span>
          <span class="fs-13">${esc(item)}</span>
        </div>`).join('')}`,
    foot: `<a class="btn btn-default" data-cancel href="#/mcp">${icon('plug', 13)}${esc(rqI18n.t('前往 MCP 服务页处理'))}</a><button class="btn btn-primary" data-ok>${esc(rqI18n.t('知道了'))}</button>`,
  })
}

/** 签发 SSO 客户端弹窗（redirectUris / 类型 / 同意策略）。 */
function openIssueSsoModal(app, ctx) {
  const modal = openModal({
    title: rqI18n.t('签发 SSO 客户端 · {name}', { name: app.name }), wide: true,
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">${icon('info', 15)}<span>client_secret 仅签发后展示一次；应用按 OIDC 授权码模式接入（强制 PKCE S256）。</span></div>
      <div class="form-grid">
        ${field('回调地址 redirect_uris（每行一个）', `
          <textarea class="form-control mono" name="redirectUris" rows="2" placeholder="https://app.example.com/auth/cb&#10;http://192.168.0.7:8080/auth/cb（内网）&#10;http://localhost:3000/cb（本机调试）"></textarea>`, { required: true, full: true, hint: 'https:// 任意主机；http:// 仅限内网（localhost / 127.0.0.1 / 10.x / 172.16-31.x / 192.168.x）' })}
        ${field('客户端类型', selectField('clientType', [
          { value: 'confidential', label: 'confidential —— 有后端，持有 secret（推荐）' },
          { value: 'public', label: 'public —— 纯前端 SPA，免 secret（强制 PKCE、不发 refresh）' },
        ]), { full: true })}
        <label class="flex" style="gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" name="consentRequired" style="accent-color:var(--brand-500)">
          <span>授权页要求用户显式勾选同意（对外部应用建议开启）</span>
        </label>
      </div>`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>签发</button>',
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async () => {
    const data = collectForm(modal.body)
    const redirectUris = (modal.body.querySelector('[name=redirectUris]').value).split('\n').map((s) => s.trim()).filter(Boolean)
    try {
      const created = await api.post(`/api/apps/${app.id}/sso-client`, {
        redirectUris,
        clientType: data.clientType,
        consentRequired: data.consentRequired === true,
      })
      modal.close()
      showSsoSecret(created)
      openAppDetail(app.id, ctx)
    } catch (error) { toast(error.message, 'error') }
  }
}

/** 一次性 secret 展示弹窗（签发 / 轮换共用）。 */
function showSsoSecret({ clientId, clientSecret, note }) {
  openModal({
    title: 'SSO 凭据（仅此一次展示）',
    body: `
      <div class="form-hint" style="margin-bottom:10px;color:var(--danger)">请立即复制保存，关闭后无法再次查看 client_secret。</div>
      <div class="code-block">client_id:     ${esc(clientId)}
${clientSecret ? `client_secret: ${esc(clientSecret)}` : '（public 客户端无 secret，凭 PKCE 保护）'}</div>
      <div class="form-hint mt-8">${esc(note ?? '')}</div>`,
    foot: '<button class="btn btn-primary" data-ok>已保存</button>',
  })
}

/** SVG 树形拓扑图（手工布局，节点分列排布）。 */
function topologySvg(root) {
  const layers = []
  const collect = (node, depth) => {
    if (!layers[depth]) layers[depth] = []
    layers[depth].push(node)
    for (const child of node.children) collect(child, depth + 1)
  }
  collect(root, 0)
  const NODE_W = 148, NODE_H = 54, GAP_X = 26, GAP_Y = 18
  const width = Math.max(...layers.map((l) => l.length)) * (NODE_W + GAP_X) - GAP_X
  const height = layers.length * (NODE_H + GAP_Y) + 20
  const posOf = new Map()
  layers.forEach((layer, depth) => {
    const layerWidth = layer.length * (NODE_W + GAP_X) - GAP_X
    const startX = (width - layerWidth) / 2
    layer.forEach((node, index) => {
      posOf.set(node, { x: startX + index * (NODE_W + GAP_X), y: 16 + depth * (NODE_H + GAP_Y) })
    })
  })
  const colorOf = (node) => {
    if (node.status === 'unhealthy') return { border: '#ef4444', bg: '#fef2f2', text: '#b91c1c' }
    if (node.type === 'app') return { border: '#0052D9', bg: '#eef6ff', text: '#003a9e' }
    if (node.type === 'agent') return { border: '#8b5cf6', bg: '#f5f3ff', text: '#6d28d9' }
    if (node.type === 'skill') return { border: '#10b981', bg: '#ecfdf5', text: '#047857' }
    return { border: '#d4d6dd', bg: '#f8f9fb', text: '#4b5059' }
  }
  const nodeIcon = (node) => ({ app: 'app', agent: 'bot', skill: 'sparkles' }[node.type] ?? 'box')
  let edges = ''
  let nodes = ''
  const walkEdges = (node) => {
    for (const child of node.children) {
      const from = posOf.get(node), to = posOf.get(child)
      const x1 = from.x + NODE_W / 2, y1 = from.y + NODE_H
      const x2 = to.x + NODE_W / 2, y2 = to.y
      edges += `<path d="M${x1},${y1} C${x1},${y1 + 14} ${x2},${y2 - 14} ${x2},${y2}" fill="none" stroke="#c9ccd4" stroke-width="1.6"/>`
      walkEdges(child)
    }
  }
  walkEdges(root)
  for (const [node, pos] of posOf) {
    const c = colorOf(node)
    nodes += `
      <g transform="translate(${pos.x},${pos.y})" style="cursor:default">
        <rect width="${NODE_W}" height="${NODE_H}" rx="10" fill="${c.bg}" stroke="${c.border}" stroke-width="1.4"/>
        <g transform="translate(10,14)" stroke="${c.text}" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${iconPathsRaw(nodeIcon(node))}</g>
        <text x="34" y="24" font-size="12" font-weight="600" fill="${c.text}">${esc(clip(node.name, 11))}</text>
        <text x="34" y="40" font-size="10" fill="#8a8f99">${esc(node.statusLabel)}</text>
      </g>`
  }
  return `
    <div style="overflow-x:auto">
      <svg width="${Math.max(width, 320)}" height="${height}" viewBox="0 0 ${Math.max(width, 320)} ${height}">
        ${edges}${nodes}
      </svg>
    </div>`
}
function iconPathsRaw(name) {
  return ICON_PATH_CACHE[name] ?? ''
}
import { PATHS as ICON_PATH_CACHE } from '../icons.js'
function clip(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 编辑应用资料（头像/开发者/描述/访问地址）：与注册白名单同源，PATCH attrs；开发者空选表示清除。 */
function openAppEdit(app, ctx) {
  void api.get('/api/apps/developer-options').catch(() => ({ options: [] })).then((devData) => {
    const devOptions = (devData.options ?? []).map((u) => ({ value: u.id, label: rqI18n.t('{name}（@{user}）', { name: u.name, user: u.username }), group: u.orgName || '未分组' }))
    const modal = openModal({
      title: rqI18n.t('编辑应用资料 · {name}', { name: app.name }), wide: true,
      body: `
        <div class="form-grid">
          ${field('头像 / 图标', inputField('icon', { value: String(app.attrs['icon'] ?? '✨'), placeholder: 'emoji 或图片 URL（https://…）' }), { hint: '填图片 http(s) 地址即显示为头像' })}
          ${field('开发者', searchableSelectField('developerId', devOptions, {
            value: app.attrs['developerId'] ?? '',
            placeholder: '搜索姓名 / 账号选择开发者',
            emptyLabel: '（不指定开发者）',
          }))}
          ${field('访问地址', inputField('url', { value: String(app.attrs['url'] ?? ''), placeholder: 'https://…' }), { full: true })}
          ${field('描述', textareaField('description', { rows: 2, value: app.attrs['description'] ?? '' }), { required: true, full: true })}
        </div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
    })
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    mountSearchableSelects(modal.el)
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const data = collectForm(modal.body)
      const attrs = { developerId: data.developerId ?? '' }
      if (String(data.icon ?? '').trim()) attrs.icon = String(data.icon).trim()
      if (String(data.url ?? '').trim()) attrs.url = String(data.url).trim()
      if (String(data.description ?? '').trim()) attrs.description = String(data.description).trim()
      try {
        await api.patch(`/api/apps/${app.id}`, { attrs })
        toast(rqI18n.t('应用资料已更新')); modal.close(); openAppDetail(app.id, ctx)
      } catch (error) { toast(error.message, 'error') }
    }
  })
}

/** 生成接入提示词：注册同款模板由平台侧生成（单一事实源）；可选轮换机器凭证（旧 secret 失效）以携带完整凭证。 */
function openAppOnboardPrompt(app) {
  const modal = openModal({
    title: rqI18n.t('生成接入提示词 · {name}', { name: app.name }),
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px;line-height:1.8">${icon('info', 15)}<span>按<b>注册同款模板</b>生成全文（换牌 → 接入验证 → SSO 打通 → 计量 → MCP 服务级数据面）。<br>
      <b>重新生成密钥并生成</b>：提示词携带完整 client_secret，<b>旧 secret 立即失效</b>——首次接入或密钥丢失时选这个；<br>
      <b>仅生成（不轮换）</b>：仅含 client_id，secret 部分为占位，适合只想重看接入步骤的场景。</span></div>`,
    foot: `
      <button class="btn btn-default" data-cancel>取消</button>
      <button class="btn btn-default" data-plain>仅生成（不轮换）</button>
      <button class="btn btn-primary" data-rotate>重新生成密钥并生成</button>`,
  })
  const generate = async (rotate) => {
    try {
      const result = await api.post(`/api/apps/${app.id}/onboarding-prompt`, { rotate })
      modal.close()
      openOnboardingModal({
        title: rqI18n.t('接入提示词 · {name}{suffix}', { name: app.name, suffix: rotate ? rqI18n.t('（密钥已重新生成）') : '' }),
        resourceLabel: 'AI 应用',
        resource: app,
        credential: result.credential,
        metaRows: [
          ['应用 ID', app.id],
          ['client_id', result.credential.clientId],
          ...(result.credential.clientSecret ? [['client_secret', result.credential.clientSecret]] : []),
        ],
        guideText: result.prompt,
      })
    } catch (error) { toast(error.message, 'error') }
  }
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-plain]').onclick = () => void generate(false)
  modal.el.querySelector('[data-rotate]').onclick = () => void generate(true)
}

function openAppCreate(schema, ctx) {
  void Promise.all([
    api.get('/api/agents'),
    api.get('/api/apps/developer-options').catch(() => ({ options: [] })),
  ]).then(([agentData, devData]) => {
    const onlineAgents = agentData.agents.filter((a) => a.status === 'online' || a.status === 'trial')
    const modal = openModal({
      title: '注册 AI 应用', wide: true,
      body: `
        <div class="form-grid">
          ${field('应用名称', inputField('name'), { required: true })}
          ${field('应用标识', inputField('slug', { placeholder: '小写字母与中划线' }))}
          ${field('应用类型', selectField('appType', [
            { value: 'web', label: 'Web 应用' }, { value: 'h5', label: 'H5' }, { value: 'miniapp', label: '小程序' },
            { value: 'desktop', label: '桌面端' }, { value: 'api', label: 'API 服务' },
          ]), { required: true })}
          ${field('头像 / 图标', inputField('icon', { value: '✨', placeholder: 'emoji 或图片 URL（https://…）' }), { hint: '填图片 http(s) 地址即显示为头像，否则按 emoji 展示' })}
          ${field('访问地址', inputField('url', { placeholder: 'https://…' }), { full: true, hint: '上线（发布）前必须登记' })}
          ${field('描述', textareaField('description', { rows: 2 }), { required: true, full: true })}
        </div>
        <div class="card-title mb-8" style="margin-top:8px">归属与编排</div>
        ${field('开发者', searchableSelectField('developerId', (devData.options ?? []).map((u) => ({
          value: u.id,
          label: rqI18n.t('{name}（@{user}）', { name: u.name, user: u.username }),
          group: u.orgName || '未分组',
        })), { placeholder: '搜索姓名 / 账号选择开发者', emptyLabel: '（不指定，默认注册人）' }), { full: true, hint: '从平台在编用户中选择；不选则默认注册人' })}
        <div class="card-title mb-8" style="margin-top:8px">编排 Agent（依赖拓扑数据源）</div>
        ${onlineAgents.length
          ? field('选择编排 Agent（可多选）', multiSelectField('agentIds', onlineAgents.map((a) => ({
              value: a.id,
              label: rqI18n.t('{avatar} {name}（{slug}）', { avatar: a.attrs['avatar'] ?? '🤖', name: a.name, slug: a.slug }),
            })), { placeholder: '搜索并选择编排 Agent，可多选；留空表示暂无依赖' }))
          : '<div class="form-hint mb-8">没有在线 Agent 可编排（Agent 需先上线）</div>'}
        <div class="form-grid">
          ${field('风险等级', selectField('riskLevel', [{ value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }]), { required: true })}
          ${field('数据密级', selectField('dataClass', [{ value: 'internal', label: '内部' }, { value: 'public', label: '公开' }, { value: 'confidential', label: '机密' }]), { required: true })}
        </div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>注册应用</button>',
    })
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    mountSearchableSelects(modal.el)
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const data = collectForm(modal.body)
      const agentIds = (data.agentIds ?? '').split(',').filter(Boolean)
      try {
        const result = await api.post('/api/apps', {
          name: data.name, slug: data.slug || undefined,
          attrs: {
            appType: data.appType, icon: data.icon, url: data.url, description: data.description,
            riskLevel: data.riskLevel, dataClass: data.dataClass, agentIds,
            ...(data.developerId ? { developerId: data.developerId } : {}),
          },
          agentIds,
        })
        modal.close()
        if (result.credential) {
          openOnboardingModal({
            title: '注册成功 · 接入指引与应用凭证（仅此一次展示）',
            resourceLabel: 'AI 应用',
            resource: result.app,
            credential: result.credential,
            metaRows: [
              ['应用 ID', result.app.id],
              ['标识', result.app.slug],
              ['client_id', result.credential.clientId],
              ['client_secret', result.credential.clientSecret],
            ],
            guideText: buildAppOnboardingText(result.app, result.credential),
          })
        }
        ctx.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  })
}

/** 外部凭证 tab（issue #19 方向 A 最小闭环）：数字员工调用外部自研服务的长期凭据平台落点。
 *  登记即 AES-256-GCM 加密落密钥文件；值任何响应绝不回显（只回掩码 + 轮换时间）；
 *  取值须独立权限点 app.credential.fetch（对象级校验 + 逐次审计）；附接入方自检卡。 */
function renderCredsTab(holder, app, ctx) {
  if (!session.can('app.write')) {
    holder.innerHTML = `<div class="muted-box">${esc(rqI18n.t('外部凭证属应用管理操作（app.write），当前账号无权限查看。'))}</div>`
    return
  }
  holder.innerHTML = '<div class="text-4 fs-12">加载中…</div>'
  void (async () => {
    const [credData, checkData] = await Promise.all([
      api.get(`/api/apps/${app.id}/credentials`).catch(() => null),
      api.get(`/api/apps/${app.id}/credentials/self-check`).catch(() => null),
    ])
    const credentials = credData?.credentials ?? []
    const canFetch = session.can('app.credential.fetch')
    holder.innerHTML = `
      <div class="card card-pad mb-14">
        <div class="card-title mb-8">${icon('lock', 14)} ${esc(rqI18n.t('已登记外部凭证（{n}）', { n: credentials.length }))}</div>
        <div class="fs-12 text-3 mb-8">${esc(rqI18n.t('数字员工调用外部自研服务的长期凭据落点：登记即 AES-256-GCM 加密（值任何响应不回显，只回掩码）；取值须 app.credential.fetch 且每次落审计。'))}</div>
        ${credentials.length ? credentials.map((cred) => `
          <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border);gap:8px;flex-wrap:wrap;align-items:center">
            <span class="fs-13 mono" style="font-weight:500;min-width:160px">${esc(cred.key)}</span>
            <span class="fs-12 mono text-3">${esc(cred.masked)}</span>
            ${cred.description ? `<span class="fs-12 text-3">${esc(cred.description)}</span>` : ''}
            <span class="fs-12 text-4">${esc(rqI18n.t('轮换 {time} · {by}', { time: timeAgo(cred.rotatedAt), by: cred.rotatedBy }))}</span>
            <span class="flex" style="gap:6px;margin-left:auto">
              ${canFetch ? `<button class="btn btn-ghost btn-sm" data-fetch="${esc(cred.key)}">${icon('eye', 12)}${esc(rqI18n.t('取值'))}</button>` : ''}
              <button class="btn btn-ghost btn-sm" data-rotate="${esc(cred.key)}">${icon('refresh', 12)}${esc(rqI18n.t('轮换'))}</button>
              <button class="btn btn-ghost btn-sm" data-remove="${esc(cred.key)}" style="color:var(--danger)">${icon('trash', 12)}${esc(rqI18n.t('删除'))}</button>
            </span>
          </div>`).join('') : `<div class="text-4 fs-12">${esc(rqI18n.t('尚未登记外部凭证（第三方 API key / 内部服务 token 等长期凭据在此登记后，数字员工凭机器身份 + app.credential.fetch 取用）。'))}</div>`}
        <div class="form-grid mt-14">
          ${field(rqI18n.t('凭证键名'), inputField('cred-key', { placeholder: 'kizuna-admin-token' }), { required: true })}
          ${field(rqI18n.t('凭证值'), `<input class="input" name="cred-value" type="password" autocomplete="off" placeholder="${esc(rqI18n.t('长期凭据明文（仅登记时提交，落库即加密）'))}">`, { required: true })}
          ${field(rqI18n.t('描述（可选）'), inputField('cred-desc', { placeholder: rqI18n.t('如：Kizuna 产品服务管理令牌') }))}
        </div>
        <div id="cred-error"></div>
        <button class="btn btn-primary btn-sm mt-8" id="cred-put">${icon('plus', 13)}${esc(rqI18n.t('登记 / 轮换（同键覆盖）'))}</button>
      </div>
      <div class="card card-pad">
        <div class="card-title mb-8">${icon('shield', 14)} ${esc(rqI18n.t('接入方自检（托管在哪 / 谁能读 / 最近谁读过）'))}</div>
        ${checkData ? `
          <div class="desc-grid mb-14">
            <div class="desc-item"><span class="k">存储</span><span class="v">${esc(rqI18n.t('{algo} 静态加密 · 密钥文件 0600 / 目录 0700 · 主密钥独立', { algo: checkData.storage?.algorithm ?? 'AES-256-GCM' }))}</span></div>
            <div class="desc-item"><span class="k">${esc(rqI18n.t('可读权限点'))}</span><span class="v mono">${esc(checkData.whoCanRead?.permissionPoint ?? 'app.credential.fetch')}</span></div>
            <div class="desc-item"><span class="k">${esc(rqI18n.t('可读机器凭证'))}</span><span class="v">${(checkData.whoCanRead?.machinePrincipals ?? []).length ? esc(checkData.whoCanRead.machinePrincipals.map((p) => p.name).join('、')) : esc(rqI18n.t('无（机器凭证须绑定本应用并授予该权限点）'))}</span></div>
            <div class="desc-item"><span class="k">${esc(rqI18n.t('可读人工规则'))}</span><span class="v">${esc(checkData.whoCanRead?.humanRule ?? '')}</span></div>
          </div>
          ${(checkData.recentAccess ?? []).length ? `
            <div class="fs-12 text-3 mb-8">${esc(rqI18n.t('最近取用（逐次落审计）：'))}</div>
            ${checkData.recentAccess.map((item) => `
              <div class="flex fs-12" style="padding:4px 0;border-bottom:1px dashed var(--border);gap:10px">
                <span class="text-4">${esc(fmtTime(item.at))}</span>
                <span style="min-width:110px">${esc(item.actorName)}</span>
                <span class="text-3" style="flex:1">${esc(item.detail)}</span>
              </div>`).join('')}` : `<div class="text-4 fs-12">${esc(rqI18n.t('暂无取用记录（每次取值自动落审计）。'))}</div>`}`
        : `<div class="text-4 fs-12">${esc(rqI18n.t('自检数据不可用（无 app.read 权限）。'))}</div>`}
      </div>`
    holder.querySelectorAll('[data-fetch]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const res = await api.get(`/api/apps/${app.id}/credentials/${btn.dataset.fetch}/value`)
          const ack = await confirmDialog({
            title: rqI18n.t('凭证取值：{key}', { key: btn.dataset.fetch }),
            message: `<div class="fs-13">${esc(rqI18n.t('明文仅本次弹窗展示（请勿粘贴到聊天/工单）；本次取用已落审计。'))}</div><div class="mono fs-13 mt-8" style="user-select:all;word-break:break-all">${esc(res.value)}</div>`,
            confirmText: rqI18n.t('复制'),
          })
          if (ack?.ok) { await copyText(res.value); toast(rqI18n.t('已复制')) }
        } catch (error) { toast(error.message, 'error') }
      }
    })
    holder.querySelectorAll('[data-rotate]').forEach((btn) => {
      btn.onclick = () => {
        // 轮换复用登记表单（同键覆盖即轮换）：键名预填 + 值聚焦，不引入第二处明文输入面
        const keyInput = holder.querySelector('[name="cred-key"]')
        const valueInput = holder.querySelector('[name="cred-value"]')
        if (keyInput && valueInput) {
          keyInput.value = btn.dataset.rotate
          valueInput.value = ''
          valueInput.focus()
          keyInput.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          toast(rqI18n.t('轮换 {key}：请在下方输入新值后点「登记 / 轮换」', { key: btn.dataset.rotate }))
        }
      }
    })
    holder.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.onclick = async () => {
        const ack = await confirmDialog({
          title: rqI18n.t('删除凭证：{key}', { key: btn.dataset.remove }),
          message: rqI18n.t('删除后数字员工将无法再取用该凭据（依赖它的调用会失败）。'),
          confirmText: rqI18n.t('确认删除'),
        })
        if (!ack) return
        try {
          await api.delete(`/api/apps/${app.id}/credentials/${btn.dataset.remove}`)
          toast(rqI18n.t('已删除'))
          renderCredsTab(holder, app, ctx)
        } catch (error) { toast(error.message, 'error') }
      }
    })
    const putBtn = holder.querySelector('#cred-put')
    if (putBtn) {
      putBtn.onclick = async () => {
        const form = collectForm(holder)
        if (!form['cred-key']?.trim()) return toast(rqI18n.t('请填写凭证键名'), 'error')
        if (!form['cred-value']) return toast(rqI18n.t('请填写凭证值'), 'error')
        try {
          const res = await api.put(`/api/apps/${app.id}/credentials/${form['cred-key'].trim()}`, { value: form['cred-value'], description: form['cred-desc'] || undefined })
          toast(res.rotated ? rqI18n.t('已轮换（旧值立即失效）') : rqI18n.t('已登记（AES-256-GCM 加密落库）'))
          renderCredsTab(holder, app, ctx)
        } catch (error) {
          holder.querySelector('#cred-error').innerHTML = errorBarHtml(error.code ?? 'BAD_REQUEST') + `<div class="fs-12 text-3" style="margin:-8px 0 12px">${esc(error.message)}</div>`
        }
      }
    }
  })()
}
