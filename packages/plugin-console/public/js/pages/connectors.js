/**
 * 连接器纳管：SaaS 连接器（open-connector 数据面网关）控制台页。
 * 页内分期（dev-plan-connector §2.9）：
 *   M1——网关设置 / 目录浏览（只读）/ 连接卡片墙 + 三形态向导 / 运行日志抽屉；
 *   M2——权限组管理（policies 编辑、subjects 绑定、模板安装二次确认、变更影响面提示）。
 * 桥接过渡：经 POST /api/mcp/import 纳入的 open-connector MCP 服务在 #/mcp 打「桥接」徽章。
 * 空白态均提供上手指引（三步接入 / 三形态连接 / 权限组模型），并修复与 ui.js 组件库的 API 对齐。
 */
import { api, session } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  $, $$, esc, toast, openDrawer, openModal, confirmDialog,
  renderTable, fmtTime, field, inputField, selectField, textareaField,
  searchableSelectField, multiSelectField, mountSearchableSelects,
} from '../ui.js'

const RISK_BADGE = { read: 'success', write: 'warning', admin: 'danger' }
const AUTH_LABEL = { oauth: 'OAuth', api_key: 'API Key', custom_credential: '自定义凭证', no_auth: '免凭证' }
/** 连接状态枚举（协议值 ASCII）→ 展示中文标签 */
const CONN_STATUS_LABEL = { active: '已启用', pending: '待授权' }

/** 本页局部 hyperscript：h(tag, props, ...children)。与 ui.js 的模板字符串 h(html) 区分。 */
function h(tag, props, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'style') el.style.cssText = value
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'dataset') Object.assign(el.dataset, value)
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    if (child.nodeType) el.appendChild(child)
    else if (typeof child === 'string' && child.includes('<')) {
      const tpl = document.createElement('template')
      tpl.innerHTML = child.trim()
      el.appendChild(tpl.content)
    } else el.appendChild(document.createTextNode(String(child)))
  }
  return el
}

const errText = (error) => error?.message ?? String(error)

export async function renderConnectors(content, params, ctx) {
  let tab = params.get('tab') ?? 'catalog'

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">CONNECTOR / SAAS</div>
        <div class="page-title">连接器</div>
        <div class="page-sub">1,000+ SaaS Provider 的数据面纳管：目录 / 连接（OAuth · API Key · 免凭证）/ 双层授权（权限组 ↔ oct_ 令牌镜像）/ 计量对账。凭证托管在连接器网关侧，平台零密钥落盘。</div>
      </div>
      <div class="page-actions" id="cn-head-actions"></div>
    </div>
    <div class="filter-bar">
      <div class="chips" id="cn-tabs">
        ${[['catalog', '目录'], ['connections', '连接'], ['perm-groups', '权限组'], ['runs', '运行日志']]
          .map(([key, label]) => `<span class="chip ${tab === key ? 'active' : ''}" data-tab="${key}">${label}</span>`).join('')}
      </div>
    </div>
    <div id="cn-body"></div>`

  $('#cn-tabs').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-tab]')
    if (!chip) return
    tab = chip.dataset.tab
    $$('#cn-tabs .chip').forEach((node) => node.classList.toggle('active', node.dataset.tab === tab))
    void renderTab()
  })

  let gatewayStatus = null
  await refreshGateway()
  await renderTab()

  async function refreshGateway() {
    try {
      gatewayStatus = await api.get('/api/connector/gateway')
    } catch {
      gatewayStatus = null
    }
    renderHeadActions()
  }

  function renderHeadActions() {
    const host = $('#cn-head-actions')
    if (!host) return
    if (!gatewayStatus) {
      host.innerHTML = `<span class="badge badge-warn no-dot">${icon('alert', 12)} 网关状态未知（无 connector.gateway.write 权限点？）</span>`
    } else {
      const available = gatewayStatus.available === true
      host.innerHTML = `
        <span class="badge ${available ? 'badge-ok' : 'badge-danger'}" title="${esc(gatewayStatus.reason ?? '')}">
          ${icon(available ? 'check' : 'alert', 12)} ${available ? esc(rqI18n.t('网关在线 {ms}ms', { ms: gatewayStatus.latencyMs ?? 0 })) : esc(rqI18n.t('网关不可用'))}
        </span>`
    }
    host.insertAdjacentHTML('beforeend', `
      <button class="btn btn-default" id="cn-guide-btn">${icon('book', 14)}接入指引</button>
      ${session.can('connector.gateway.write') ? `<button class="btn btn-default" id="cn-gateway">${icon('settings', 14)}网关设置</button>` : ''}`)
    $('#cn-guide-btn').addEventListener('click', () => guideDrawer())
    $('#cn-gateway')?.addEventListener('click', () => gatewayDrawer())
  }

  // -- 网关设置抽屉 ------------------------------------------------------------
  function gatewayDrawer() {
    const statusPromise = gatewayStatus
      ? Promise.resolve(gatewayStatus)
      : api.get('/api/connector/gateway').catch(() => null)
    void statusPromise.then((gw) => {
      gatewayStatus = gw ?? { available: false, reason: '状态获取失败（检查 connector.gateway.write 权限点）', envChecks: {} }
      const status = gatewayStatus
      const available = status.available === true
      const envKey = status.envChecks?.OOMOL_CONNECT_ENCRYPTION_KEY
      const envToken = status.envChecks?.OOMOL_CONNECT_ADMIN_TOKEN
      const drawer = openDrawer({
        title: '连接器网关设置',
        sub: 'open-connector 数据面网关：平台只保存地址与口令引用，凭证全部托管在网关侧保险库',
        body: `
          <div class="kv-list">
            <div class="kv"><span class="k">状态</span><span class="v" id="gw-status-val">
              <span class="badge ${available ? 'badge-ok' : 'badge-danger'} no-dot">${available ? esc(rqI18n.t('可用 · 探活 {ms}ms', { ms: status.latencyMs ?? 0 })) : esc(status.reason ?? '不可用')}</span>
            </span></div>
            <div class="kv"><span class="k">网关地址（baseUrl）</span><span class="v mono">${esc(status.baseUrl ?? '未配置')}</span></div>
            <div class="kv"><span class="k">上次探活</span><span class="v">${status.lastProbeAt ? `${fmtTime(status.lastProbeAt)}${status.latencyMs !== undefined ? `（${status.latencyMs}ms）` : ''}` : '—'}</span></div>
            <div class="kv"><span class="k">OOMOL_CONNECT_ENCRYPTION_KEY</span><span class="v">${envKey ? '✅ 已设置（AES-256-GCM 生效）' : '❌ 缺失 → 网关 fail-closed，拒绝写入凭证'}</span></div>
            <div class="kv"><span class="k">OOMOL_CONNECT_ADMIN_TOKEN</span><span class="v">${envToken ? '✅ 已设置' : '⚠️ 未设置（需以字面量配置 adminToken）'}</span></div>
          </div>
          <div class="section-title" style="margin:18px 0 10px">接入配置</div>
          ${field('网关地址（baseUrl）', inputField('baseUrl', { placeholder: 'http://open-connector:3000', value: status.baseUrl ?? '' }), { required: true, hint: 'open-connector sidecar 服务地址（内网可达即可）' })}
          ${field('管理口令 adminToken', inputField('adminToken', { placeholder: 'env:OOMOL_CONNECT_ADMIN_TOKEN' }), { hint: '推荐用 env: 前缀间接引用环境变量，避免明文落盘；留空表示沿用现有口令' })}
          <div class="muted-box" style="margin-top:6px">💡 首次接入：在 open-connector 侧设置好两个环境变量 → 此处填写 baseUrl → 保存并探活 → 回到目录页点「同步目录」。</div>`,
        foot: `<button class="btn btn-default" id="gw-probe">${icon('refresh', 14)}立即探活</button>
               <button class="btn btn-primary" id="gw-save">${icon('check', 14)}保存并探活</button>`,
      })
      drawer.el.querySelector('#gw-probe').addEventListener('click', async () => {
        try {
          const result = await api.post('/api/connector/gateway/health')
          toast(rqI18n.t('在线 {ms}ms', { ms: result.latencyMs ?? 0 }))
          const statusEl = drawer.body.querySelector('#gw-status-val')
          if (statusEl) statusEl.innerHTML = `<span class="badge badge-ok no-dot">${esc(rqI18n.t('可用 · 探活 {ms}ms', { ms: result.latencyMs ?? 0 }))}</span>`
        } catch (error) {
          toast(errText(error), 'error')
        }
        await refreshGateway()
      })
      drawer.el.querySelector('#gw-save').addEventListener('click', async () => {
        const base = drawer.body.querySelector('[name=baseUrl]').value.trim()
        if (!base) return toast(rqI18n.t('baseUrl 必填'), 'error')
        const payload = { baseUrl: base }
        const token = drawer.body.querySelector('[name=adminToken]').value.trim()
        if (token) payload.adminToken = token
        try {
          await api.put('/api/connector/gateway', payload)
          toast(rqI18n.t('已保存并完成探活'))
          drawer.close()
        } catch (error) {
          return toast(errText(error), 'error')
        }
        await refreshGateway()
      })
    })
  }

  // -- 接入指引抽屉（配置 / 新建 / 管理维护 全流程说明） -----------------------------
  function guideDrawer() {
    const gw = gatewayStatus
    const available = gw?.available === true
    openDrawer({
      title: '连接器接入指引',
      sub: '从零配置到日常维护：平台零密钥，凭证全程托管在连接器网关侧',
      body: `
        <div class="cn-guide-sec">
          <div class="cn-guide-sec-title">${icon('settings', 15)}① 配置网关（一次性）</div>
          <p>
            连接器能力由 open-connector 数据面网关提供。在 open-connector 侧设置 <code>OOMOL_CONNECT_ENCRYPTION_KEY</code>（凭证加密密钥，缺失时网关 fail-closed）与
            <code>OOMOL_CONNECT_ADMIN_TOKEN</code>（管理口令），然后打开「网关设置」填写 sidecar 地址（如 <code>http://open-connector:3000</code>）保存并探活。当前状态：<b>${available ? '✅ 网关在线' : '⛔ 网关未配置/不可用'}</b>${available ? esc(rqI18n.t('，延迟 {ms}ms', { ms: gatewayStatus.latencyMs ?? 0 })) : ''}。
          </p>
        </div>
        <div class="cn-guide-sec">
          <div class="cn-guide-sec-title">${icon('refresh', 15)}② 同步目录</div>
          <p>探活成功后，在「目录」页签点击「同步目录」，一键拉取全部 Provider 与 Action（含风险级、requiredScopes、入参 schema 与 agent.md 连接指南）。目录只读，可搜索过滤。</p>
        </div>
        <div class="cn-guide-sec">
          <div class="cn-guide-sec-title">${icon('link', 15)}③ 新建连接（三形态）</div>
          <p>在「连接」页签点「新建连接」：<b>no_auth</b> 免凭证直接登记引用；<b>oauth</b> 走代理授权流（跳转授权页，自备 App 见连接指南）；<b>api_key / custom_credential</b> 凭证 JSON 原样送入网关保险库后即刻丢弃。完整别名自动生成：<code>org:&lt;orgId&gt;:&lt;后缀&gt;</code>。</p>
        </div>
        <div class="cn-guide-sec">
          <div class="cn-guide-sec-title">${icon('shield', 15)}④ 授权：权限组 ↔ oct_ 令牌</div>
          <p>在「权限组」页签定义 policies（允许的 service / action pattern、<code>riskCap</code> 风险上限、只读约束）与 subjects（谁可调用）。保存即铸造一枚独立 <code>oct_</code> 运行时令牌（仅铸造时可见、永不落盘）；策略修改后令牌在一个巡检周期内自动收敛。</p>
        </div>
        <div class="cn-guide-sec">
          <div class="cn-guide-sec-title">${icon('activity', 15)}⑤ 日常维护与对账</div>
          <p>「运行日志」页签展示每次 Action 调用（runId / Provider / 结果 / 令牌引用）；「oct_ 台账」核对平台镜像的令牌快照；「运行对账」把网关运行记录与平台计量流水逐条核对，发现 bypass 旁路调用即告警。删除连接前需先解绑引用它的权限组。</p>
        </div>`,
    })
  }

  // -- 指引面板（空白态通用组件） -------------------------------------------------
  function buildGuidePanel({ heroIcon, title, badge, desc, steps, forms, tips }) {
    const panel = h('div', { class: 'cn-guide' })
    panel.innerHTML = `
      <div class="cn-guide-hero">
        <div class="cn-guide-hero-ic">${icon(heroIcon, 22)}</div>
        <div>
          <div class="cn-guide-title">${title}${badge ?? ''}</div>
          <div class="cn-guide-desc">${desc}</div>
        </div>
      </div>
      ${steps?.length ? `<div class="cn-guide-steps">${steps.map((step, i) => `
        <div class="cn-step">
          <div class="cn-step-head">
            <span class="cn-step-no ${step.done ? 'cn-done' : ''}">${step.done ? icon('check', 13) : i + 1}</span>
            <span class="cn-step-title">${step.title}</span>
          </div>
          <div class="cn-step-desc">${step.desc}</div>
          <div class="cn-step-foot" data-step-foot="${i}"></div>
        </div>`).join('')}</div>` : ''}
      ${forms?.length ? `<div class="cn-guide-forms">${forms.map((form) => `
        <div class="cn-form-card">
          <span class="cn-form-tag ${form.tagClass}">${icon(form.tagIcon, 12)}${form.tag}</span>
          <div class="cn-form-name">${form.name}</div>
          <div class="cn-form-desc">${form.desc}</div>
        </div>`).join('')}</div>` : ''}
      ${tips?.length ? `<div class="cn-guide-tips">${tips.map((tip) => `<span class="cn-tip">${icon(tip.icon ?? 'info', 12)}${tip.text}</span>`).join('')}</div>` : ''}`
    for (const [i, step] of (steps ?? []).entries()) {
      const footEl = panel.querySelector(`[data-step-foot="${i}"]`)
      for (const action of step.actions ?? []) {
        const btn = h('button', { class: `btn btn-sm ${action.primary ? 'btn-primary' : 'btn-default'}` }, action.label)
        btn.addEventListener('click', action.onClick)
        footEl.appendChild(btn)
      }
      if (step.done && !step.actions?.length) {
        footEl.innerHTML = `<span class="cn-step-done-tip">${icon('check', 13)}已完成</span>`
      }
    }
    return panel
  }

  async function renderTab() {
    const body = $('#cn-body')
    body.innerHTML = ''
    if (tab === 'catalog') await renderCatalog(body)
    else if (tab === 'connections') await renderConnections(body)
    else if (tab === 'perm-groups') await renderPermGroups(body)
    else await renderRuns(body)
  }

  // -- 目录 -----------------------------------------------------------------
  async function renderCatalog(host) {
    host.innerHTML = `
      <div class="filter-bar">
        <div class="search-input">${icon('search')}<input class="input" id="cn-q" placeholder="搜索 provider / action"></div>
      </div>
      <div id="cn-catalog"></div>`
    const load = async () => {
      const q = $('#cn-q').value.trim()
      let catalog
      try {
        catalog = await api.get('/api/connector/catalog' + api.qs(q ? { q } : {}))
      } catch (error) {
        toast(rqI18n.t('目录加载失败：{msg}', { msg: errText(error) }), 'error')
        return
      }
      renderCatalogBody(catalog)
    }
    $('#cn-q').addEventListener('input', debounce(load, 300))
    await load()

    function renderCatalogBody(catalog) {
      const holder = $('#cn-catalog')
      holder.innerHTML = ''
      if (!catalog.providers?.length && !catalog.actions?.length) {
        const configured = gatewayStatus?.available === true
        holder.appendChild(buildGuidePanel({
          heroIcon: 'plug',
          title: '三步接入 SaaS 连接器',
          badge: `<span class="badge ${configured ? 'badge-ok' : 'badge-warn'} no-dot">${configured ? '网关在线 · 待同步目录' : '网关未配置'}</span>`,
          desc: '这里将展示 open-connector 网关纳管的 1,000+ SaaS Provider 与 Action 目录。首次使用按下面三步走，全程约 5 分钟；凭证只存网关侧，平台零密钥落盘。',
          steps: [
            {
              title: '配置网关并探活',
              done: configured,
              desc: '在 open-connector 侧设好 <code>ENCRYPTION_KEY</code> / <code>ADMIN_TOKEN</code>，再于「网关设置」填写 sidecar 地址（如 <code>http://open-connector:3000</code>）保存探活。',
              actions: session.can('connector.gateway.write') ? [{ label: '打开网关设置', primary: true, onClick: () => gatewayDrawer() }] : [],
            },
            {
              title: '同步目录',
              desc: '探活通过后一键拉取 Provider 与 Action 目录（含风险级、入参 schema、agent.md 连接指南），支持关键词检索。',
              actions: session.can('connector.connection.write') ? [{ label: '同步目录', primary: configured, onClick: () => syncCatalog() }] : [],
            },
            {
              title: '建连接 · 发权限',
              desc: '到「连接」页签登记 OAuth / API Key / 免凭证连接；再到「权限组」页签发行 <code>oct_</code> 运行时令牌，供 Agent 受控调用。',
            },
          ],
          tips: [
            { icon: 'shieldCheck', text: '凭证托管在网关保险库，平台只存 org 别名引用与脱敏 profile' },
            { icon: 'key', text: '每权限组独立铸造一枚 oct_ 令牌，支持限流与风险上限' },
            { icon: 'activity', text: '运行日志 + oct_ 台账对账，旁路调用无所遁形' },
          ],
        }))
        return
      }
      const sectionTitle = (text) => h('div', { class: 'section-title', style: 'margin:14px 0 8px;font-weight:600' }, text)
      holder.appendChild(sectionTitle(rqI18n.t('服务商（{n}）', { n: catalog.providers.length })))
      const grid = h('div', { class: 'grid grid-4', style: 'gap:10px' })
      for (const provider of catalog.providers.slice(0, 60)) {
        const card = h('div', { class: 'card card-hover', style: 'padding:12px;cursor:pointer' },
          h('div', { style: 'font-weight:600' }, String(provider.name ?? provider.service)),
          h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, `${provider.service}`))
        card.addEventListener('click', () => openProviderDrawer(provider, catalog))
        grid.appendChild(card)
      }
      holder.appendChild(grid)
      holder.appendChild(sectionTitle(rqI18n.t('动作（{n}{suffix}）', { n: catalog.actions.length, suffix: catalog.actions.length >= 60 ? rqI18n.t('+，输入关键词过滤') : '' })))
      const rows = catalog.actions.slice(0, 60).map((action) => ({
        id: action.id,
        service: action.service,
        riskLevel: `<span class="badge badge-${RISK_BADGE[action.riskLevel] ?? 'default'}">${action.riskLevel}</span>`,
        description: action.description ?? '',
        __raw: action,
      }))
      holder.appendChild(renderTable({
        columns: [
          { key: 'id', title: '动作 ID' },
          { key: 'service', title: '服务商' },
          { key: 'riskLevel', title: '风险级', render: (row) => `<span class="badge badge-${RISK_BADGE[row.__raw.riskLevel] ?? 'default'}">${row.__raw.riskLevel}</span>` },
          { key: 'description', title: '说明' },
        ],
        rows,
        onRowClick: (row) => openActionDrawer(row.__raw),
      }))
      if ((catalog.skippedServices ?? []).length > 0) {
        holder.appendChild(h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
          rqI18n.t('被拒纳管 service：{list}（计量资源正则约束）', { list: catalog.skippedServices.map((item) => item.service).join('、') })))
      }
    }
  }

  function openProviderDrawer(provider, catalog) {
    const actions = catalog.actions.filter((action) => action.service === provider.service)
    const drawer = openDrawer({
      title: `${provider.name ?? provider.service}`,
      body: `
        <div class="muted-box" style="margin-bottom:12px">${esc(String(provider.description ?? ''))}</div>
        <div class="section-title" style="margin-bottom:6px">${esc(rqI18n.t('动作（{n}）', { n: actions.length }))}</div>
        ${actions.slice(0, 50).map((action) => `
          <div class="list-row" data-action="${esc(action.id)}" style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer">
            <span class="mono" style="font-size:12px">${esc(action.id)}</span>
            <span class="badge badge-${RISK_BADGE[action.riskLevel] ?? 'default'}">${action.riskLevel}</span>
          </div>`).join('') || '<div class="muted" style="font-size:12px">（无 action，或关键词过滤后为空）</div>'}
        <div id="pv-guide" class="muted" style="margin-top:12px;font-size:12px;white-space:pre-wrap"></div>`,
    })
    drawer.body.addEventListener('click', (event) => {
      const row = event.target.closest('[data-action]')
      if (!row) return
      const action = actions.find((item) => item.id === row.dataset.action)
      if (action) openActionDrawer(action)
    })
  }

  async function openActionDrawer(action) {
    const drawer = openDrawer({
      title: action.id,
      body: `
        <span class="badge badge-${RISK_BADGE[action.riskLevel] ?? 'default'}">${action.riskLevel}</span>
        <div class="muted-box" style="margin-top:10px">${esc(action.description ?? '')}</div>
        ${(action.requiredScopes ?? []).length ? `<div class="kv" style="margin-top:10px"><span class="k">requiredScopes</span><span class="v mono">${esc(action.requiredScopes.join(', '))}</span></div>` : ''}
        <pre class="code-block" style="margin-top:10px;max-height:260px;overflow:auto">${esc(JSON.stringify(action.inputSchema ?? {}, null, 2))}</pre>
        <div class="section-title" style="margin:14px 0 6px">连接指南（agent.md 预览）</div>
        <div id="ad-guide" class="muted" style="white-space:pre-wrap;font-size:12px">加载中…</div>`,
    })
    try {
      const guide = await api.get(`/api/connector/catalog/actions/${encodeURIComponent(action.id)}/guide`)
      drawer.body.querySelector('#ad-guide').textContent = guide.guide ?? ''
    } catch {
      drawer.body.querySelector('#ad-guide').textContent = '（guide 获取失败：需要 connector.catalog.read）'
    }
  }

  async function syncCatalog() {
    try {
      const result = await api.post('/api/connector/catalog/sync')
      toast(rqI18n.t('目录已同步：providers={p} actions={a}', { p: result.providers, a: result.actions }))
    } catch (error) {
      return toast(rqI18n.t('同步失败：{msg}', { msg: errText(error) }), 'error')
    }
    await renderTab()
  }

  // -- 连接 -----------------------------------------------------------------
  async function renderConnections(host) {
    host.innerHTML = `<div id="cn-conns">加载中…</div>`
    const result = await api.get('/api/connector/connections')
    const holder = $('#cn-conns')
    holder.innerHTML = ''
    const headBar = h('div', { class: 'filter-bar', style: 'justify-content:flex-end' })
    const addBtn = h('button', { class: 'btn btn-primary' }, icon('plus', 14), '新建连接')
    addBtn.addEventListener('click', () => connectionWizard())
    headBar.appendChild(addBtn)
    holder.appendChild(headBar)
    if (!(result.connections ?? []).length) {
      holder.appendChild(buildGuidePanel({
        heroIcon: 'link',
        title: '还没有连接引用',
        desc: '连接 = 平台侧的 <code>org:&lt;orgId&gt;:&lt;别名&gt;</code> 引用 + 网关侧的真实凭证。平台永不接触明文密钥。点右上角「新建连接」，按 Provider 的鉴权形态三选一：',
        forms: [
          { tag: 'no_auth', tagClass: 't-free', tagIcon: 'check', name: '免凭证', desc: '适用于无需鉴权的公开 Provider（如 hackernews）。直接登记虚拟引用，创建即可调用。' },
          { tag: 'OAuth', tagClass: 't-oauth', tagIcon: 'external', name: '代理授权流', desc: '填 requestedScopes 后跳转授权页完成授权；自备第三方 App 时，按 Action 的「连接指南」配置回调地址。' },
          { tag: 'API Key', tagClass: 't-key', tagIcon: 'key', name: '表单直达网关', desc: '凭证 JSON 原样送入网关保险库后即刻丢弃，平台不落盘、不进日志、不留痕。' },
        ],
        tips: [
          { icon: 'info', text: '目录同步后可从 Provider 下拉选择；未同步时直接手填 service 标识（如 hackernews）' },
          { icon: 'trash', text: '删除连接前需先在权限组中解绑，否则会被拒绝' },
        ],
      }))
      return
    }
    const grid = h('div', { class: 'grid grid-3', style: 'gap:12px' })
    for (const ref of result.connections) {
      const card = h('div', { class: 'card', style: 'padding:14px;display:flex;flex-direction:column;gap:6px' })
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>${esc(ref.provider)}</strong>
          <span class="badge badge-${ref.status === 'active' ? 'ok' : ref.status === 'pending' ? 'warn' : 'danger'}">${esc(CONN_STATUS_LABEL[ref.status] ?? ref.status)}</span>
        </div>
        <div class="mono muted" style="font-size:12px">${esc(ref.alias)}</div>
        <div style="font-size:12px">${AUTH_LABEL[ref.authType] ?? esc(ref.authType)}${ref.bridge ? ' · <span class="badge">桥接过渡</span>' : ''}</div>
        ${ref.maskedProfile ? `<div class="mono muted" style="font-size:11px">${esc(Object.entries(ref.maskedProfile).map(([k, v]) => `${k}=${v}`).join(' · ').slice(0, 80))}</div>` : ''}`
      const delBtn = h('button', { class: 'btn btn-danger btn-sm', style: 'margin-top:auto' }, '删除')
      delBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: '删除连接', message: rqI18n.t('确认删除 <b>{alias}</b>？若仍被权限组引用将拒绝（可先解绑）。', { alias: esc(ref.alias) }), danger: true })
        if (!ok) return
        try {
          await api.delete(`/api/connector/connections/${ref.id}`, {})
          toast(rqI18n.t('已删除'))
        } catch (error) {
          return toast(errText(error), 'error')
        }
        await renderTab()
      })
      card.appendChild(delBtn)
      grid.appendChild(card)
    }
    holder.appendChild(grid)
  }

  /** 组织下拉选项：value=orgId，label=完整路径（同名部门靠路径区分）。 */
  function buildOrgOptions(orgs) {
    const byId = new Map((orgs ?? []).map((o) => [o.id, o]))
    const pathOf = (org) => {
      const parts = []
      let cur = org
      const seen = new Set()
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id)
        parts.unshift(cur.name)
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      }
      return parts.join(' / ')
    }
    return (orgs ?? []).map((o) => ({ value: o.id, label: pathOf(o) })).sort((a, b) => a.label.localeCompare(b.label, 'zh'))
  }

  async function connectionWizard(providerHint) {
    let providers = []
    try {
      providers = (await api.get('/api/connector/catalog')).providers ?? []
    } catch { /* catalog.read 缺失时向导降级为手填 */ }
    let orgOpts = []
    try {
      orgOpts = buildOrgOptions(await api.get('/api/iam/orgs'))
    } catch { /* iam.org.read 缺失时降级为手填 orgId */ }
    const modal = openModal({
      title: '新建连接（三形态）',
      body: `
        ${field('Provider', searchableSelectField('provider', [
          { value: '', label: providerHint ?? '（目录未同步时手动输入）' },
          ...providers.slice(0, 200).map((item) => ({ value: item.service, label: rqI18n.t('{name}（{service}）', { name: item.name ?? item.service, service: item.service }) })),
        ], { value: providerHint ?? '', placeholder: '点击选择 Provider，支持搜索' }), { hint: '目录同步后可搜索下拉选择；也可在下一栏直接填 service 标识' })}
        ${field('或直接填 service 标识', inputField('serviceInput', { placeholder: 'hackernews / github …' }))}
        ${field('认证形态', selectField('authType', [
          { value: 'no_auth', label: 'no_auth：免凭证虚拟登记' },
          { value: 'oauth', label: 'oauth：代理授权流（自备 App 见指南）' },
          { value: 'api_key', label: 'api_key / custom_credential：表单直达网关（不落盘）' },
        ], { value: 'no_auth' }))}
        ${field('别名后缀', inputField('aliasSuffix', { value: 'main' }), { required: true, hint: '完整别名 = org:<orgId>:<后缀>' })}
        ${field('归属组织', orgOpts.length
          ? searchableSelectField('orgId', orgOpts, { placeholder: '点击选择归属组织，支持搜索' })
          : inputField('orgId', { placeholder: 'org_xxx' }), { required: true })}
        <div id="cw-dynamic"></div>`,
      foot: `<button class="btn btn-default" data-cancel>取消</button>
             <button class="btn btn-primary" id="cw-submit">${icon('zap', 14)}创建</button>`,
    })
    mountSearchableSelects(modal.el)
    const dynamic = modal.body.querySelector('#cw-dynamic')
    const renderDynamic = () => {
      const type = modal.body.querySelector('[name=authType]').value
      if (type === 'api_key') {
        dynamic.innerHTML = field('凭证字段（JSON）', textareaField('valuesJson', { placeholder: '{"apiKey": "…"} 或 {"token": "…"}', rows: 4 }), { hint: '原样送入网关保险库后即刻丢弃，平台不落盘' })
      } else if (type === 'oauth') {
        dynamic.innerHTML = field('授权范围（requestedScopes）', inputField('requestedScopes', { placeholder: '留空使用 Provider 默认 scopes，多个用英文逗号分隔' }))
      } else {
        dynamic.innerHTML = '<div class="muted-box">免凭证连接直接登记引用，无需任何密钥材料。</div>'
      }
    }
    renderDynamic()
    modal.body.querySelector('[name=authType]').addEventListener('change', renderDynamic)
    modal.el.querySelector('#cw-submit').addEventListener('click', async () => {
      const val = (name) => modal.body.querySelector(`[name=${name}]`).value.trim()
      const providerName = val('provider') || val('serviceInput')
      if (!providerName || !val('aliasSuffix') || !val('orgId')) return toast(rqI18n.t('provider / 别名后缀 / 组织 ID 必填'), 'error')
      const type = val('authType')
      const endpoint = type === 'oauth' ? '/api/connector/connections/oauth' : type === 'no_auth' ? '/api/connector/connections/no-auth' : '/api/connector/connections/api-key'
      const payload = { provider: providerName, aliasSuffix: val('aliasSuffix'), orgId: val('orgId'), authType: type }
      if (type === 'api_key') {
        try { payload.values = JSON.parse(dynamic.querySelector('[name=valuesJson]').value || '{}') } catch { return toast(rqI18n.t('凭证字段必须是合法 JSON'), 'error') }
        payload.authType = 'api_key'
      }
      if (type === 'oauth') {
        const scopes = dynamic.querySelector('[name=requestedScopes]').value.trim()
        if (scopes) payload.requestedScopes = scopes.split(',').map((item) => item.trim()).filter(Boolean)
      }
      let created
      try {
        created = await api.post(endpoint, payload)
      } catch (error) {
        return toast(rqI18n.t('创建失败：{msg}', { msg: errText(error) }), 'error')
      }
      modal.close()
      if (created.approvalRequired) {
        toast(rqI18n.t('已进入审批门禁：审批单 {id} 通过后再携 approvalId 提交', { id: created.approvalId }))
        return
      }
      if (type === 'oauth' && created.authorizationUrl) {
        // dsh 完整页面体验（§6）：OAuth 同窗口整页跳转，服务商回跳由 callback 承接
        toast(rqI18n.t('即将跳转授权页；完成授权后回跳本平台查看状态'))
        location.assign(created.authorizationUrl)
        return
      }
      toast(rqI18n.t('连接已创建（凭证只存于连接器网关）'))
      await renderTab()
    })
  }

  // -- 权限组（M2 分期） -------------------------------------------------------
  async function renderPermGroups(host) {
    host.innerHTML = `<div id="cn-pgs">加载中…</div>`
    const result = await api.get('/api/connector/perm-groups')
    const holder = $('#cn-pgs')
    holder.innerHTML = ''
    const bar = h('div', { class: 'filter-bar', style: 'justify-content:flex-end' })
    const templateBtn = h('button', { class: 'btn btn-default' }, icon('sparkles', 14), '安装只读模板')
    templateBtn.addEventListener('click', async () => {
      // 二次确认（评审 2.2-3）：模板同样建立权限组与令牌
      const ok = await confirmDialog({ title: '安装只读模板', message: '将创建「riskCap=read + readOnly」的 hackernews.* 模板权限组，并联动铸造 oct_ 运行时令牌。确认继续？' })
      if (!ok) return
      try {
        const rootOrgs = (await api.get('/api/iam/orgs')).data ?? []
        const rootOrg = Array.isArray(rootOrgs) ? rootOrgs.find((org) => !org.parentId) : undefined
        if (!rootOrg) return toast(rqI18n.t('组织数据未初始化'), 'error')
        await api.post('/api/connector/perm-groups', {
          name: `只读模板-${Date.now().toString(36)}`,
          orgId: rootOrg.id,
          policies: { hackernews: { allowedActions: ['hackernews.*'], riskCap: 'read', constraints: { readOnly: true } } },
          subjects: [],
        })
        toast(rqI18n.t('模板已安装（可在列表编辑 subjects）'))
      } catch (error) {
        return toast(rqI18n.t('安装失败：{msg}', { msg: errText(error) }), 'error')
      }
      await renderTab()
    })
    const createBtn = h('button', { class: 'btn btn-primary' }, icon('plus', 14), '新建权限组')
    createBtn.addEventListener('click', () => permGroupModal())
    bar.append(templateBtn, createBtn)
    holder.appendChild(bar)

    if (!(result.groups ?? []).length) {
      holder.appendChild(buildGuidePanel({
        heroIcon: 'shield',
        title: '权限组：给 Agent 发一张“限定区域的门禁卡”',
        desc: '权限组 = <b>policies</b>（允许哪些 Provider / Action、风险上限、只读约束）+ <b>subjects</b>（谁可调用）。每个权限组独立铸造一枚 <code>oct_</code> 运行时令牌：令牌值仅在铸造时返回一次、永不落盘，平台只留快照哈希用于对账。',
        steps: [
          { title: '定义策略 policies', desc: '声明允许的 service 与 action pattern（如 <code>hackernews.*</code>）、风险上限 <code>riskCap</code>，可绑定指定连接并施加 readOnly 约束。' },
          { title: '绑定主体 subjects', desc: '把权限组授予用户 / Agent 等主体；subject 维度独立限流（次/分），超限即拒。' },
          { title: '下发 oct_ 令牌', desc: '保存即铸令牌、即刻可用；修改策略后令牌在一个巡检周期内自动收敛，无需换发。' },
        ],
        tips: [
          { icon: 'zap', text: '快速体验：点右上角「安装只读模板」，一键创建 hackernews 只读权限组' },
          { icon: 'alert', text: '编辑权限组会自动预览影响面（N 令牌 / M 连接），在途调用短暂失败后自动恢复' },
        ],
      }))
      return
    }
    const rows = result.groups.map((group) => ({
      id: group.id,
      name: group.name,
      orgId: group.orgId,
      policiesSummary: Object.entries(group.policies).map(([service, policy]) =>
        `${service}:${policy.allowedActions === '*' ? '*' : (policy.allowedActions ?? []).join('|')}@${policy.riskCap}${policy.constraints?.readOnly ? '(ro)' : ''}`).join('<br>'),
      subjects: group.subjects.map((subject) => `${subject.type}:${subject.name ?? subject.id}`).join(', '),
      rateLimitPerMin: group.rateLimitPerMin,
      __raw: group,
    }))
    holder.appendChild(renderTable({
      columns: [
        { key: 'name', title: '名称' },
        { key: 'orgId', title: '组织' },
        { key: 'policiesSummary', title: '策略（pattern@riskCap）', render: (row) => row.policiesSummary },
        { key: 'subjects', title: '主体' },
      ],
      rows,
      onRowClick: (row) => permGroupModal(row.__raw),
    }))
  }

  async function permGroupModal(existing) {
    const isEdit = Boolean(existing)
    const defaultPolicies = existing?.policies ?? { hackernews: { allowedActions: ['hackernews.get_top_stories'], riskCap: 'read', constraints: { readOnly: true } } }
    // 主体候选：Agent / 用户组 / 应用 三类（与后端 subject 类型对齐），组织用于归属下拉
    const [agentsData, groupsData, appsData, orgsData] = await Promise.all([
      api.get('/api/agents').catch(() => ({ agents: [] })),
      api.get('/api/iam/groups').catch(() => ({ groups: [] })),
      api.get('/api/apps').catch(() => ({ apps: [] })),
      api.get('/api/iam/orgs').catch(() => []),
    ])
    const subjectOptions = [
      ...(agentsData.agents ?? []).map((a) => ({ value: `agent:${a.id}`, label: rqI18n.t('{name}（{slug}）', { name: a.name, slug: a.slug ?? a.id }), group: 'Agent' })),
      ...(groupsData.groups ?? []).map((g) => ({ value: `user_group:${g.id}`, label: g.name, group: '用户组' })),
      ...(appsData.apps ?? []).map((a) => ({ value: `app:${a.id}`, label: a.name, group: '应用' })),
    ]
    const orgOpts = buildOrgOptions(Array.isArray(orgsData) ? orgsData : orgsData.orgs ?? [])
    const modal = openModal({
      title: isEdit ? rqI18n.t('编辑权限组：{name}', { name: existing.name }) : '新建权限组',
      wide: true,
      body: `
        <div style="display:flex;gap:12px">
          <div style="flex:1">${field('名称', inputField('name', { value: existing?.name ?? '' }), { required: true })}</div>
          <div style="flex:1">${field('归属组织', !isEdit && orgOpts.length
            ? searchableSelectField('orgId', orgOpts, { placeholder: '点击选择归属组织，支持搜索' })
            : `<input class="input" name="orgId" placeholder="org_xxx" value="${esc(existing?.orgId ?? '')}" ${isEdit ? 'disabled' : ''}>`, { required: !isEdit })}</div>
        </div>
        ${field('policies（{service:{allowedActions:[],riskCap,connections?,constraints?}}）', textareaField('policiesJson', { value: JSON.stringify(defaultPolicies, null, 2), rows: 10 }), { required: true })}
        ${field('绑定主体', multiSelectField('subjects', subjectOptions, {
          values: (existing?.subjects ?? []).map((s) => `${s.type}:${s.id}`),
          placeholder: '搜索并选择 Agent / 用户组 / 应用，可多选；留空 = 暂不授权仅持令牌',
        }))}
        <div style="display:flex;gap:12px">
          <div style="flex:1">${field('限流（次/分/主体）', inputField('rateLimitPerMin', { value: String(existing?.rateLimitPerMin ?? 60) }))}</div>
        </div>
        <div id="pg-impact" class="form-hint">${isEdit ? '正在预览变更影响面…' : '变更影响面：保存前自动预览 N 个令牌 / M 个连接受影响。'}</div>`,
      foot: `<button class="btn btn-default" data-cancel>取消</button>
             <button class="btn btn-primary" id="pg-save">${isEdit ? '保存（PUT 四数组全发镜像令牌）' : '创建并铸令牌'}</button>`,
    })
    mountSearchableSelects(modal.el)
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('#pg-save').addEventListener('click', async () => {
      const val = (name) => modal.body.querySelector(`[name=${name}]`)?.value ?? ''
      let policies
      try {
        policies = JSON.parse(val('policiesJson'))
      } catch (error) {
        return toast(rqI18n.t('policies JSON 解析失败：{msg}', { msg: error.message }), 'error')
      }
      // 主体值格式 type:id（id 不含冒号），还原为后端 subjects 数组
      const subjects = val('subjects').split(',').filter(Boolean).map((v) => {
        const idx = v.indexOf(':')
        return { type: v.slice(0, idx), id: v.slice(idx + 1) }
      })
      const basePayload = {
        name: val('name').trim(),
        policies,
        subjects,
        rateLimitPerMin: Number(val('rateLimitPerMin')) || 60,
      }
      if (!basePayload.name) return toast(rqI18n.t('请填写名称'), 'error')
      if (!isEdit && !val('orgId')) return toast(rqI18n.t('请选择归属组织'), 'error')
      const target = isEdit ? `/api/connector/perm-groups/${existing.id}` : '/api/connector/perm-groups'
      try {
        if (isEdit) await api.patch(target, basePayload)
        else await api.post(target, { ...basePayload, orgId: val('orgId') })
      } catch (error) {
        return toast(rqI18n.t('保存失败：{msg}', { msg: errText(error) }), 'error')
      }
      toast(isEdit ? rqI18n.t('已保存：令牌策略将在一个巡检周期内收敛') : rqI18n.t('已创建并铸发独立 oct_ 令牌'))
      modal.close()
      await renderTab()
    })
    // 编辑态：打开即拉取影响面预览（N 令牌 / M 连接）
    if (isEdit) {
      void api.post(`/api/connector/perm-groups/${existing.id}/impact`).then((impact) => {
        const line = modal.body.querySelector('#pg-impact')
        if (line) line.textContent = rqI18n.t('变更影响面：{t} 个令牌 / {c} 个连接 / {s} 个主体；在途调用会短暂失败后自动恢复', { t: impact.tokens, c: impact.connections, s: impact.subjects })
      }).catch(() => {})
    }
  }

  // -- 运行日志 / 对账 ----------------------------------------------------------
  async function renderRuns(host) {
    host.innerHTML = `<div id="cn-runs">加载中…</div>`
    const holder = $('#cn-runs')
    const result = await api.get('/api/connector/runs').catch((error) => ({ items: null, knownTokens: 0, error }))
    holder.innerHTML = ''
    const bar = h('div', { class: 'filter-bar', style: 'justify-content:flex-end' })
    const ledgerBtn = h('button', { class: 'btn btn-default' }, icon('ticket', 14), 'oct_ 台账')
    ledgerBtn.addEventListener('click', async () => {
      let ledgers
      try {
        ledgers = (await api.get('/api/connector/tokens')).tokens ?? []
      } catch (error) {
        return toast(errText(error), 'error')
      }
      openDrawer({
        title: rqI18n.t('oct_ 运行时令牌台账（{n}）', { n: ledgers.length }),
        body: `
          <div class="muted-box" style="margin-bottom:10px;font-size:12px">平台只存 ocTokenId 与策略快照哈希；token 值仅铸造时一次性返回且仅驻进程内存，永不落盘。</div>
          ${renderTable({
            columns: [
              { key: 'ocTokenId', title: 'ocTokenId' },
              { key: 'hash', title: '快照哈希' },
              { key: 'lastSyncedAt', title: '最近镜像' },
            ],
            rows: ledgers.map((ledger) => ({ ...ledger, hash: ledger.policySnapshotHash })),
          })}`,
      })
    })
    const reconcileBtn = h('button', { class: 'btn btn-default' }, icon('refresh', 14), '运行对账')
    reconcileBtn.addEventListener('click', async () => {
      let outcome
      try {
        outcome = await api.post('/api/connector/reconcile')
      } catch (error) {
        return toast(rqI18n.t('对账失败：{msg}', { msg: errText(error) }), 'error')
      }
      toast(rqI18n.t('已核对 {a} 条 · 匹配 {b} 条 · 旁路 {c} 条', { a: outcome.checkedRuns, b: outcome.matchedMeters, c: outcome.bypassRuns.length }), outcome.bypassRuns.length === 0 ? 'success' : 'error')
      await renderTab()
    })
    bar.append(ledgerBtn, reconcileBtn)
    holder.appendChild(bar)

    if (!Array.isArray(result.items)) {
      holder.appendChild(buildGuidePanel({
        heroIcon: 'activity',
        title: '运行日志暂不可用',
        badge: '<span class="badge badge-warn no-dot">未就绪</span>',
        desc: '运行日志需要 <code>connector.runs.read</code> 权限点与健康的网关连接。完成网关接入并产生真实调用后，这里会逐条展示每次 Action 调用（runId / Provider / 结果 / 令牌引用），并支持台账核对与计量对账。',
        steps: [
          { title: '接入网关', desc: '参考「目录」页签的三步指引完成网关配置与目录同步。', ...(session.can('connector.gateway.write') ? { actions: [{ label: '打开网关设置', primary: true, onClick: () => gatewayDrawer() }] } : {}) },
          { title: '产生调用', desc: 'Agent 携 oct_ 令牌经网关调用 Action 后，运行记录即出现在此处。' },
          { title: '对账审计', desc: '点上方「oct_ 台账」核对令牌镜像；「运行对账」逐条核对网关记录 ↔ 平台计量流水，bypass 即旁路调用。' },
        ],
      }))
      return
    }
    holder.appendChild(renderTable({
      columns: [
        { key: 'id', title: '运行 ID（runId = executionId）' },
        { key: 'service', title: '服务商' },
        { key: 'actionId', title: '动作' },
        { key: 'ok', title: '结果', render: (row) => row.ok },
        { key: 'runtimeTokenId', title: '运行令牌 ID（runtimeTokenId）' },
        { key: 'startedAt', title: '时间' },
      ],
      rows: result.items.map((run) => ({ ...run, ok: run.ok ? '<span class="badge badge-ok">成功</span>' : '<span class="badge badge-danger">失败</span>', startedAt: fmtTime(run.startedAt ?? '') })),
    }))
  }
}

function debounce(fn, ms) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}
