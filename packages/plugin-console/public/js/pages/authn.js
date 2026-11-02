/** 认证与令牌：机器凭证 + 令牌生命周期 + on-behalf-of 说明。 */
import { api, session } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog,
  renderTable, statusBadge, collectForm, field, inputField, selectField,
  fmtTime, timeAgo, emptyState,
} from '../ui.js'

export async function renderAuthn(content, params, ctx) {
  const [principals, tokens, oidcClients] = await Promise.all([
    api.get('/api/authn/principals'),
    api.get('/api/authn/tokens'),
    api.get('/api/authn/oidc/clients').catch(() => null),
  ])
  const canOidc = oidcClients !== null
  const canOidcWrite = session.can('authn.oidc.write')
  const canPrincipalWrite = session.can('authn.principal.write')

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">AUTHN / TOKENS</div>
        <div class="page-title">认证与令牌</div>
        <div class="page-sub">人与机器双轨身份；令牌统一签发 / 校验 / 吊销，密钥 KMS 托管，支持轮换。外部应用经 OIDC 协议接入（RS256 / JWKS）。</div>
      </div>
      <div class="page-actions">
        ${session.can('authn.token.revoke') ? `<button class="btn btn-default" id="authn-rotate">${icon('refresh', 14)}轮换签名密钥</button>` : ''}
        ${canOidcWrite ? `<button class="btn btn-default" id="oidc-keys-rotate">${icon('shield', 14)}轮换 OIDC 签名密钥</button>` : ''}
        ${canOidcWrite ? `<button class="btn btn-default" id="oidc-client-add">${icon('plug', 14)}登记 OIDC 客户端</button>` : ''}
        ${canPrincipalWrite ? `<button class="btn btn-primary" id="authn-credential">${icon('key', 14)}签发机器凭证</button>` : ''}
      </div>
    </div>

    <div class="tabs">
      <div class="tab active" data-tab="principals">${esc(rqI18n.t('身份主体 ({n})', { n: principals.principals.length }))}</div>
      <div class="tab" data-tab="tokens">${esc(rqI18n.t('访问令牌 ({n})', { n: tokens.total }))}</div>
      ${canOidc ? `<div class="tab" data-tab="oidc">${esc(rqI18n.t('OIDC 客户端 ({n})', { n: oidcClients.clients.length }))}</div>` : ''}
    </div>
    <div id="authn-body"></div>`

  const body = $('#authn-body')
  $$('.tab').forEach((el) => {
    el.onclick = () => {
      $$('.tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })

  function renderTab(tab) {
    if (tab === 'principals') {
      const table = renderTable({
        columns: [
          {
            title: '主体', width: '24%',
            render: (p) => `
              <div class="flex" style="gap:10px">
                <div class="avatar sm" style="${p.type === 'machine' ? 'background:linear-gradient(135deg,#8b5cf6,#6d28d9)' : ''}">${icon(p.type === 'machine' ? 'settings' : 'user', 13)}</div>
                <div>
                  <div class="col-strong">${esc(p.name)}</div>
                  <div class="col-sub mono">${esc(p.id)}</div>
                </div>
              </div>`,
          },
          { title: '类型', width: 90, render: (p) => `<span class="badge ${p.type === 'human' ? 'badge-brand' : 'badge-purple'} no-dot">${p.type === 'human' ? '人员' : '机器'}</span>` },
          { title: '绑定资源', render: (p) => esc(refLabel(p)) },
          {
            title: '权限范围',
            render: (p) => {
              if (p.type !== 'machine') return '<span class="text-4">—</span>'
              const resolved = p.resolvedScopes ?? p.scopes ?? []
              if (!resolved.length) return '<span class="text-4">—</span>'
              const tip = resolved.includes('*') ? rqI18n.t("'*' 全部权限") : resolved.join(', ')
              if (resolved.includes('*')) return `<span class="badge badge-danger no-dot" title="${esc(tip)}">全部权限（*）</span>`
              const roleTags = (p.roleNames ?? []).map((name) => `<span class="badge badge-purple no-dot">${esc(name)}</span>`).join(' ')
              const extra = p.scopes?.length ?? 0
              const extraTag = extra ? `<span class="fs-11 text-3">${esc(rqI18n.t('附加 {n} 项', { n: extra }))}</span>` : ''
              const summary = [roleTags, extraTag].filter(Boolean).join(' ')
              return `<span style="display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;max-width:300px" title="${esc(rqI18n.t('生效权限点：{tip}', { tip }))}">${summary || `<span class="mono fs-11">${esc(tip)}</span>`}</span>`
            },
          },
          { title: '客户端 ID', render: (p) => p.clientId ? `<span class="mono fs-12">${esc(p.clientId)}</span>` : '<span class="text-4">—</span>' },
          { title: '活跃令牌', width: 90, render: (p) => `<span class="col-num">${p.activeTokens}</span>` },
          { title: '状态', width: 90, render: (p) => statusBadge(p.status === 'active' ? 'active' : 'frozen', p.status === 'active' ? '正常' : '已禁用') },
          {
            title: '', width: 150,
            render: (p) => p.type === 'machine' && canPrincipalWrite ? `
              <button class="btn btn-default btn-sm" data-scopes="${esc(p.id)}">编辑权限</button>
              ${p.clientId ? `<button class="btn btn-danger-ghost btn-sm" data-rotate="${esc(p.id)}">轮换密钥</button>` : ''}` : '',
          },
        ],
        rows: principals.principals,
        onRowClick: (id, row) => openPrincipalDetail(row),
      })
      body.innerHTML = ''
      body.appendChild(table)
      body.querySelectorAll('[data-scopes]').forEach((btn) => {
        btn.onclick = (event) => {
          event.stopPropagation()
          openScopesEditor(principals.principals.find((p) => p.id === btn.dataset.scopes), ctx)
        }
      })
      body.querySelectorAll('[data-rotate]').forEach((btn) => {
        btn.onclick = (event) => {
          event.stopPropagation()
          rotateCredential(principals.principals.find((p) => p.id === btn.dataset.rotate), ctx)
        }
      })
    } else if (tab === 'tokens') {
      const table = renderTable({
        columns: [
          { title: '令牌', render: (t) => `<span class="mono fs-12">${esc(t.jti.slice(0, 18))}…</span><div class="col-sub">${esc(t.principalName)}</div>` },
          { title: '类型', width: 90, render: (t) => `<span class="badge ${t.kind === 'machine' ? 'badge-purple' : 'badge-brand'} no-dot">${t.kind === 'machine' ? '机器' : '访问'}</span>` },
          { title: '签发途径', render: (t) => `<span class="fs-12">${esc(t.issuedBy)}</span>` },
          { title: '签发时间', width: 140, render: (t) => `<span class="fs-12 text-3">${fmtTime(t.issuedAt)}</span>` },
          { title: '过期时间', width: 140, render: (t) => `<span class="fs-12 ${new Date(t.expiresAt) < new Date() ? '' : 'text-3'}">${fmtTime(t.expiresAt)}</span>` },
          {
            title: '状态', width: 110,
            render: (t) => t.revokedAt
              ? statusBadge('offline', '已吊销')
              : new Date(t.expiresAt) < new Date() ? statusBadge('deprecated', '已过期') : statusBadge('online', '生效中'),
          },
          {
            title: '', width: 80,
            render: (t) => !t.revokedAt ? `<button class="btn btn-danger-ghost btn-sm stop" data-revoke="${esc(t.jti)}">吊销</button>` : '',
          },
        ],
        rows: tokens.tokens,
        onRowClick: () => {},
      })
      body.innerHTML = ''
      body.appendChild(table)
      body.querySelectorAll('[data-revoke]').forEach((btn) => {
        btn.onclick = async () => {
          const result = await confirmDialog({
            title: '吊销令牌', requireReason: true, danger: true, confirmText: '立即吊销',
            message: '吊销后该令牌的所有请求立即返回 401。此操作不可恢复。',
          })
          if (!result) return
          await api.delete(`/api/authn/tokens/${btn.dataset.revoke}`, { reason: result.reason })
          toast(rqI18n.t('令牌已吊销')); ctx.rerender()
        }
      })
    } else if (tab === 'oidc') {
      renderOidcClientsTab(body, oidcClients, ctx)
    }
  }
  renderTab('principals')

  const credentialBtn = $('#authn-credential')
  if (credentialBtn) credentialBtn.onclick = async () => {
    // 已注册的可绑定主体：选择后自动回填 refType/refId（凭据与资源真正关联），外部系统仍可手填
    let bindable, authz
    try {
      ;[bindable, authz] = await Promise.all([api.get('/api/authn/bindable-resources'), fetchAuthzOptions()])
    } catch (error) { toast(error.message, 'error'); return }
    const entries = [
      ...bindable.agents.map((a) => ({ value: `agent:${a.id}`, refType: 'agent', refId: a.id, name: a.name, label: rqI18n.t('Agent · {name}（{status}）', { name: a.name, status: a.status }), search: `${a.name} agent ${a.id}`.toLowerCase() })),
      ...bindable.apps.map((a) => ({ value: `app:${a.id}`, refType: 'app', refId: a.id, name: a.name, label: rqI18n.t('AI 应用 · {name}（{status}）', { name: a.name, status: a.status }), search: `${a.name} app 应用 ${a.id}`.toLowerCase() })),
    ]
    const modal = openModal({
      title: '签发机器凭证（Client Credentials）', wide: true,
      body: `
        <div class="muted-box mb-14" style="display:flex;gap:8px">${icon('info', 15)}<span>用于 Agent / 应用 / 外部系统以机器身份接入平台。Secret 仅在创建后展示一次。</span></div>
        <div class="form-grid">
          ${field('绑定主体（可搜索已注册的 Agent / AI 应用）', `
            <input class="input" id="cred-bind-q" placeholder="输入关键词过滤，或直接下拉选择" autocomplete="off">
            <select class="select" id="cred-bind" style="margin-top:6px"></select>`, { required: true, full: true })}
          <div id="cred-name-holder" class="form-item full"></div>
          ${authzPickerHtml(authz, [], [])}
        </div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>签发</button>',
    })
    const bindSelect = modal.body.querySelector('#cred-bind')
    const nameHolder = modal.body.querySelector('#cred-name-holder')
    const renderOptions = (query) => {
      const q = (query ?? '').trim().toLowerCase()
      const visible = q ? entries.filter((e) => e.search.includes(q)) : entries
      const selected = bindSelect.value
      bindSelect.innerHTML =
        `<option value="external">外部系统（手动填写名称）</option>` +
        visible.map((e) => `<option value="${esc(e.value)}">${esc(e.label)}</option>`).join('')
      if (selected && [...bindSelect.options].some((o) => o.value === selected)) bindSelect.value = selected
      // 已选主体被过滤掉时，select 回落到外部系统——名称/关联区必须同步刷新，避免残留旧关联
      renderNameField()
    }
    const current = () => entries.find((e) => e.value === bindSelect.value)
    const renderNameField = () => {
      const entry = current()
      if (entry) {
        nameHolder.innerHTML = `
          <label class="form-label">自动关联</label>
          <div class="muted-box" style="display:flex;align-items:center;gap:8px">
            ${icon('link', 14)}
            <span>${esc(rqI18n.t('主体名称'))} <code class="mono">${esc(`${entry.refType}:${entry.name}`)}</code> · ${esc(rqI18n.t('关联'))} ${esc(entry.refType)} <code class="mono">${esc(entry.refId)}</code></span>
          </div>`
      } else {
        nameHolder.innerHTML = field('主体名称', inputField('name', { placeholder: '如 external:ci-system' }), { required: true })
      }
    }
    renderOptions('')
    bindAuthzPicker(modal)
    modal.body.querySelector('#cred-bind-q').oninput = (event) => renderOptions(event.target.value)
    bindSelect.onchange = renderNameField
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const data = collectForm(modal.body)
      const entry = current()
      const authzPick = collectAuthzPicker(modal)
      if (!authzPick) return toast(rqI18n.t('授权不能为空：至少选择机器角色、附加权限点或 *'), 'error')
      const payload = entry
        ? { name: `${entry.refType}:${entry.name}`, refType: entry.refType, refId: entry.refId, ...authzPick }
        : { name: data.name, refType: 'external', ...authzPick }
      if (!payload.name) return toast(rqI18n.t('外部系统需填写主体名称'), 'error')
      try {
        const result = await api.post('/api/authn/principals', payload)
        modal.close()
        openModal({
          title: '凭证已签发（仅此一次展示）',
          body: `
            <div class="form-hint" style="margin-bottom:10px;color:var(--danger)">请立即复制保存，关闭后无法再次查看 clientSecret。</div>
            <div class="code-block">principal_id: ${esc(result.principalId)}
client_id:     ${esc(result.clientId)}
client_secret: ${esc(result.clientSecret)}</div>
            <div class="form-hint mt-8">调用示例：POST /api/auth/client-credentials 获取访问令牌</div>`,
          foot: '<button class="btn btn-primary" data-ok>已保存</button>',
        })
      } catch (error) { toast(error.message, 'error') }
    }
  }

  const rotateBtn = $('#authn-rotate')
  if (rotateBtn) rotateBtn.onclick = async () => {
    const result = await confirmDialog({
      title: '轮换签名密钥', danger: true, confirmText: '确认轮换',
      message: '轮换后 <b>全部存量令牌立即失效</b>（宽限期机制生产环境可配）。确定继续？',
    })
    if (!result) return
    await api.post('/api/authn/rotate-secret')
    toast(rqI18n.t('签名密钥已轮换，存量令牌全部吊销'))
    setTimeout(() => ctx.rerender(), 500)
  }

  const keysRotateBtn = $('#oidc-keys-rotate')
  if (keysRotateBtn) keysRotateBtn.onclick = async () => {
    const result = await confirmDialog({
      title: '轮换 OIDC 签名密钥（JWKS）', danger: true, confirmText: '确认轮换',
      message: '新密钥立即承担签名；旧密钥 <b>24h 宽限期</b>内仍可验签（在途 id_token/access_token 不掉线），JWKS 同步公布两把公钥。确定继续？',
    })
    if (!result) return
    try {
      const rotated = await api.post('/api/authn/oidc/keys/rotate')
      toast(rqI18n.t('OIDC 签名密钥已轮换（新 kid={kid}，旧 key {h}h 宽限）', { kid: rotated.kid, h: rotated.graceHours }))
    } catch (error) { toast(error.message, 'error') }
  }

  const oidcAddBtn = $('#oidc-client-add')
  if (oidcAddBtn) oidcAddBtn.onclick = () => openOidcClientCreate(ctx)

  async function openPrincipalDetail(principal) {
    const tokens2 = await api.get('/api/authn/tokens' + api.qs({ principalId: principal.id }))
    const drawer = openDrawer({
      title: principal.name,
      sub: `${principal.type === 'human' ? rqI18n.t('人员身份') : rqI18n.t('机器身份')} · ${principal.id}`,
      body: `
        <div class="desc-grid mb-14">
          <div class="desc-item"><span class="k">类型</span><span class="v">${principal.type === 'human' ? '人员' : '机器'}</span></div>
          <div class="desc-item"><span class="k">状态</span><span class="v">${principal.status === 'active' ? '正常' : '已禁用'}</span></div>
          ${principal.clientId ? `<div class="desc-item"><span class="k">ClientId</span><span class="v mono">${esc(principal.clientId)}</span></div>` : ''}
          <div class="desc-item"><span class="k">绑定资源</span><span class="v">${esc(refLabel(principal))}</span></div>
        </div>
        ${(principal.type === 'machine') && (principal.roleIds?.length || principal.scopes.length) ? `
          <div class="card-title mb-8">权限范围（机器身份）</div>
          ${principal.roleIds?.length ? `
            <div class="fs-12 text-3 mb-4">机器角色（随组织角色实时同步）</div>
            <div class="flex mb-8" style="flex-wrap:wrap;gap:6px">${(principal.roleNames ?? principal.roleIds).map((n) => `<span class="badge badge-purple no-dot">${esc(n)}</span>`).join('')}</div>` : ''}
          ${principal.scopes.length ? `
            <div class="fs-12 text-3 mb-4">附加权限点</div>
            <div class="flex mb-14" style="flex-wrap:wrap;gap:6px">${principal.scopes.map((s) => `<span class="badge badge-brand no-dot mono">${esc(s)}</span>`).join('')}</div>` : '<div class="mb-14"></div>'}` : principal.type === 'human' && principal.scopes.length ? `
          <div class="card-title mb-8">权限范围（角色解析）</div>
          <div class="flex mb-14" style="flex-wrap:wrap;gap:6px">${principal.scopes.map((s) => `<span class="badge badge-brand no-dot mono">${esc(s)}</span>`).join('')}</div>` : ''}
        <div class="card-title mb-8">${esc(rqI18n.t('令牌（{n}）', { n: tokens2.total }))}</div>
        ${tokens2.tokens.slice(0, 8).map((t) => `
          <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border)">
            <span class="mono fs-12 grow">${esc(t.jti.slice(0, 22))}…</span>
            <span class="fs-11 text-3">${timeAgo(t.issuedAt)}</span>
            ${t.revokedAt ? statusBadge('offline', '已吊销') : statusBadge('online', '生效中')}
          </div>`).join('') || '<span class="text-4 fs-12">暂无令牌</span>'}`,
      foot: `
        ${principal.type === 'machine' && canPrincipalWrite ? `<button class="btn btn-default" id="pri-scopes">${icon('shield', 14)}编辑权限</button>` : ''}
        ${principal.type === 'machine' && principal.clientId && canPrincipalWrite ? `<button class="btn btn-danger-ghost" id="pri-rotate">${icon('refresh', 14)}轮换密钥</button>` : ''}
        ${principal.status === 'active'
          ? `<button class="btn btn-danger-ghost" id="pri-disable">${icon('alert', 14)}禁用身份（吊销全部令牌）</button>`
          : '<button class="btn btn-primary" id="pri-enable">启用身份</button>'}`,
    })
    const scopesBtn = drawer.el.querySelector('#pri-scopes')
    if (scopesBtn) scopesBtn.onclick = () => { drawer.close(); openScopesEditor(principal, ctx) }
    const priRotateBtn = drawer.el.querySelector('#pri-rotate')
    if (priRotateBtn) priRotateBtn.onclick = () => { drawer.close(); rotateCredential(principal, ctx) }
    const disableBtn = drawer.el.querySelector('#pri-disable')
    if (disableBtn) disableBtn.onclick = async () => {
      const result = await confirmDialog({ title: '禁用身份', requireReason: true, danger: true, message: rqI18n.t('禁用 <b>{name}</b> 后其全部令牌立即失效。', { name: esc(principal.name) }) })
      if (!result) return
      await api.post(`/api/authn/principals/${principal.id}/disable`, { reason: result.reason })
      toast(rqI18n.t('身份已禁用')); drawer.close(); ctx.rerender()
    }
    const enableBtn = drawer.el.querySelector('#pri-enable')
    if (enableBtn) enableBtn.onclick = async () => {
      try {
        await api.post(`/api/authn/principals/${principal.id}/enable`)
        toast(rqI18n.t('身份已启用')); drawer.close(); ctx.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  }

  if (params.get('action') === 'credential' && canPrincipalWrite) $('#authn-credential').click()

  // ---- 机器授权选择器（签发 / 编辑弹窗共用）：'*' 全部权限 + 机器角色多选 + 附加权限点分组多选 ----
  async function fetchAuthzOptions() {
    const [rolesRes, permRes] = await Promise.all([
      api.get('/api/iam/roles').catch(() => null),
      api.get('/api/iam/permissions'),
    ])
    return { roles: rolesRes?.roles ?? [], catalog: permRes.catalog }
  }

  function authzPickerHtml(options, selectedRoleIds = [], selectedScopes = []) {
    const star = selectedScopes.includes('*')
    const groups = new Map()
    for (const item of options.catalog) {
      if (!groups.has(item.group)) groups.set(item.group, [])
      groups.get(item.group).push(item)
    }
    return `
      <div class="form-item full mb-14">
        <label class="flex mb-14" style="gap:8px;cursor:pointer;font-weight:600">
          <input type="checkbox" id="authz-star" ${star ? 'checked' : ''} style="accent-color:var(--danger)">
          <span style="color:var(--danger)">'*' —— 全部权限（不可与其他授权混用）</span>
        </label>
        <label class="form-label">机器角色（与组织角色共用同一目录，角色变更实时同步到本凭证）</label>
        <div style="max-height:130px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px" id="authz-role-list">
          ${options.roles.length ? options.roles.map((role) => `
            <label class="flex" style="gap:6px;font-size:12.5px;cursor:pointer;padding:3px 0">
              <input type="checkbox" data-role="${esc(role.id)}" ${selectedRoleIds.includes(role.id) ? 'checked' : ''} style="accent-color:var(--brand-500)">
              <span style="font-weight:600">${esc(role.name)}</span>
              <span class="text-4 fs-11">${esc(role.description ?? '')}</span>
            </label>`).join('') : '<div class="text-4 fs-12">角色列表不可读（需要「查看组织」权限），请改用附加权限点</div>'}
        </div>
      </div>
      <div class="form-item full">
        <label class="form-label">附加权限点（按权限目录分组，生产建议最小授权）</label>
        <div style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px">
          ${[...groups.entries()].map(([group, items]) => `
            <div style="padding:6px 4px">
              <div class="fs-12" style="font-weight:600;color:var(--text-2)">${esc(group)}</div>
              <div class="flex" style="flex-wrap:wrap;gap:4px 14px">
                ${items.map((item) => `
                  <label class="flex" style="gap:6px;font-size:12px;cursor:pointer">
                    <input type="checkbox" data-point="${esc(item.point)}" ${selectedScopes.includes(item.point) ? 'checked' : ''} style="accent-color:var(--brand-500)">
                    <span>${esc(item.label)}</span><span class="mono text-4 fs-11">${esc(item.point)}</span>
                  </label>`).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>`
  }

  function bindAuthzPicker(modal) {
    const starBox = modal.body.querySelector('#authz-star')
    const boxes = () => [...modal.body.querySelectorAll('[data-role],[data-point]')]
    const syncStar = () => boxes().forEach((box) => { box.disabled = starBox.checked; if (starBox.checked) box.checked = false })
    starBox.onchange = syncStar
    syncStar()
  }

  /** 返回 { roleIds, scopes }；全空（未勾选 *）时返回 null。 */
  function collectAuthzPicker(modal) {
    const star = modal.body.querySelector('#authz-star').checked
    const roleIds = [...modal.body.querySelectorAll('[data-role]:checked')].map((box) => box.dataset.role)
    const scopes = [...modal.body.querySelectorAll('[data-point]:checked')].map((box) => box.dataset.point)
    if (!star && !roleIds.length && !scopes.length) return null
    return { roleIds, scopes: star ? ['*'] : scopes }
  }

  /** 编辑机器凭证权限范围：机器角色 + 附加权限点分组多选；调整后存量令牌联动吊销，机器侧需重新换牌。 */
  async function openScopesEditor(principal, ctx2) {
    let authz
    try {
      authz = await fetchAuthzOptions()
    } catch (error) { toast(error.message, 'error'); return }
    const selectedRoles = principal.roleIds ?? []
    const selectedScopes = (principal.scopes ?? []).filter((scope) => scope !== '*')
    const modal = openModal({
      title: rqI18n.t('编辑权限范围 · {name}', { name: principal.name }), wide: true,
      body: `
        <div class="muted-box mb-14" style="display:flex;gap:8px">${icon('info', 15)}<span>调整保存后该主体<b>全部存量令牌立即吊销</b>（收权即时生效），机器侧需用凭证重新换牌，新令牌按新范围签发。机器角色的权限点随角色编辑<b>实时同步</b>，无需重新换牌。</span></div>
        ${authzPickerHtml(authz, selectedRoles, selectedScopes)}`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存（联动吊销存量令牌）</button>',
    })
    bindAuthzPicker(modal)
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const authzPick = collectAuthzPicker(modal)
      if (!authzPick) return toast(rqI18n.t('授权不能为空：至少选择机器角色、附加权限点或 *'), 'error')
      try {
        await api.patch(`/api/authn/principals/${principal.id}`, authzPick)
        modal.close()
        toast(rqI18n.t('权限范围已更新；存量令牌已联动吊销，机器侧需重新换牌'))
        ctx2.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  }

  /** 轮换机器凭证密钥：clientId 不变、旧 secret 立即失效、存量令牌全部吊销；新 secret 仅此一次展示。 */
  async function rotateCredential(principal, ctx2) {
    const result = await confirmDialog({
      title: '轮换 clientSecret', danger: true, confirmText: '确认轮换',
      message: rqI18n.t('<b>{name}</b> 的旧 clientSecret <b>立即失效</b>，存量令牌<b>全部吊销</b>；clientId 保持不变，新 clientSecret 仅展示一次。', { name: esc(principal.name) }),
    })
    if (!result) return
    try {
      const rotated = await api.post(`/api/authn/principals/${principal.id}/rotate-secret`)
      openModal({
        title: '新 clientSecret（仅此一次展示）',
        body: `
          <div class="form-hint" style="margin-bottom:10px;color:var(--danger)">请立即复制保存，关闭后无法再次查看 clientSecret。</div>
          <div class="code-block">client_id:     ${esc(rotated.clientId)}
client_secret: ${esc(rotated.clientSecret)}</div>
          <div class="form-hint mt-8">${esc(rotated.note ?? '')}</div>`,
        foot: '<button class="btn btn-primary" data-ok>已保存</button>',
      })
      ctx2.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
}

function refLabel(principal) {
  if (principal.type === 'human') return '平台账号'
  if (principal.refType === 'agent') return rqI18n.t('Agent 本体（{id}）', { id: principal.refId ?? '—' })
  if (principal.refType === 'app') return rqI18n.t('AI 应用（{id}）', { id: principal.refId ?? '—' })
  return '外部系统'
}

// -- OIDC 客户端（管理员全局兜底管理面） ---------------------------------------

function renderOidcClientsTab(body, data, ctx) {
  const canWrite = session.can('authn.oidc.write')
  const table = renderTable({
    columns: [
      {
        title: '客户端', width: '24%',
        render: (c) => `
          <div class="flex" style="gap:10px">
            <div class="avatar sm" style="background:linear-gradient(135deg,#6366f1,#4f46e5)">${icon('plug', 13)}</div>
            <div>
              <div class="col-strong">${esc(c.name)}</div>
              <div class="col-sub mono">${esc(c.clientId)}</div>
            </div>
          </div>`,
      },
      { title: '类型', width: 110, render: (c) => `<span class="badge ${c.clientType === 'public' ? 'badge-purple' : 'badge-info'} no-dot">${c.clientType === 'public' ? 'public' : 'confidential'}</span>` },
      { title: '关联应用', render: (c) => c.refAppName ? `<span class="fs-12">${esc(c.refAppName)}</span>` : '<span class="text-4 fs-12">外部登记</span>' },
      { title: '回调地址', render: (c) => `<span class="fs-12 mono">${esc(c.redirectUris[0] ?? '—')}${c.redirectUris.length > 1 ? ` +${c.redirectUris.length - 1}` : ''}</span>` },
      { title: '签发时间', width: 130, render: (c) => `<span class="fs-12 text-3">${fmtTime(c.createdAt)}</span>` },
      { title: '状态', width: 90, render: (c) => statusBadge(c.status === 'active' ? 'active' : 'frozen', c.status === 'active' ? '使用中' : '已禁用') },
    ],
    rows: data.clients,
    onRowClick: (id, row) => openOidcClientDetail(row, ctx),
  })
  body.innerHTML = ''
  body.appendChild(table)
  void canWrite
}

function openOidcClientCreate(ctx) {
  const modal = openModal({
    title: '登记 OIDC 客户端（外部应用直连）', wide: true,
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">${icon('info', 15)}<span>应用侧按 OIDC 授权码模式接入（强制 PKCE S256）；secret 仅展示一次。平台登记的 AI 应用请到「AI 应用 → 详情 → SSO 配置」签发（自动关联）。</span></div>
      <div class="form-grid">
        ${field('客户端名称', inputField('name', { placeholder: '如 合作方 CRM' }), { required: true })}
        ${field('客户端类型', selectField('clientType', [
          { value: 'confidential', label: 'confidential —— 有后端，持有 secret' },
          { value: 'public', label: 'public —— 纯前端 SPA，免 secret' },
        ]))}
        ${field('回调地址 redirect_uris（每行一个）', `
          <textarea class="form-control mono" name="redirectUris" rows="2" placeholder="https://app.partner.example/cb"></textarea>`, { required: true, full: true, hint: '仅允许 https:// 或 http://localhost[:port]' })}
        <label class="flex" style="gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" name="consentRequired" checked style="accent-color:var(--brand-500)">
          <span>授权页要求用户显式勾选同意（外部应用建议开启）</span>
        </label>
      </div>`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>登记并签发</button>',
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async () => {
    const data = collectForm(modal.body)
    const redirectUris = modal.body.querySelector('[name=redirectUris]').value.split('\n').map((s) => s.trim()).filter(Boolean)
    try {
      const created = await api.post('/api/authn/oidc/clients', {
        name: data.name, redirectUris, clientType: data.clientType, consentRequired: data.consentRequired === true,
      })
      modal.close()
      openModal({
        title: 'OIDC 凭据（仅此一次展示）',
        body: `
          <div class="form-hint" style="margin-bottom:10px;color:var(--danger)">请立即复制保存，关闭后无法再次查看 client_secret。</div>
          <div class="code-block">client_id:     ${esc(created.clientId)}
${created.clientSecret ? `client_secret: ${esc(created.clientSecret)}` : '（public 客户端无 secret）'}</div>
          <div class="form-hint mt-8">${esc(created.note ?? '')}</div>`,
        foot: '<button class="btn btn-primary" data-ok>已保存</button>',
      })
      ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
}

async function openOidcClientDetail(client, ctx) {
  const canWrite = session.can('authn.oidc.write')
  const active = client.status === 'active'
  const drawer = openDrawer({
    title: client.name,
    sub: rqI18n.t('OIDC 客户端 · {id}', { id: client.clientId }) + (client.refAppName ? rqI18n.t(' · 关联应用 {name}', { name: client.refAppName }) : ''),
    body: `
      <div class="desc-grid mb-14">
        <div class="desc-item"><span class="k">类型</span><span class="v">${client.clientType === 'public' ? 'public（免 secret · 强制 PKCE）' : 'confidential'}</span></div>
        <div class="desc-item"><span class="k">状态</span><span class="v">${statusBadge(active ? 'active' : 'frozen', active ? '使用中' : '已禁用')}</span></div>
        <div class="desc-item"><span class="k">签发时间</span><span class="v">${fmtTime(client.createdAt)}</span></div>
        <div class="desc-item"><span class="k">显式同意</span><span class="v">${client.consentRequired ? '开启' : '关闭（登录即授权）'}</span></div>
      </div>
      <div class="card-title mb-8">回调地址（redirect_uris）</div>
      <div class="mb-14">${client.redirectUris.map((uri) => `<div class="fs-12 mono" style="padding:3px 0">${esc(uri)}</div>`).join('') || '<span class="text-4 fs-12">—</span>'}</div>
      ${client.postLogoutUris?.length ? `
      <div class="card-title mb-8">登出回跳白名单</div>
      <div class="mb-14">${client.postLogoutUris.map((uri) => `<div class="fs-12 mono" style="padding:3px 0">${esc(uri)}</div>`).join('')}</div>` : ''}
      <div class="card-title mb-8">接入端点</div>
      <div class="desc-grid">
        <div class="desc-item"><span class="k">discovery</span><span class="v mono">${esc(client.discovery.issuer)}/.well-known/openid-configuration</span></div>
        <div class="desc-item"><span class="k">authorize</span><span class="v mono">${esc(client.discovery.authorization_endpoint)}</span></div>
        <div class="desc-item"><span class="k">token</span><span class="v mono">${esc(client.discovery.token_endpoint)}</span></div>
        <div class="desc-item"><span class="k">userinfo</span><span class="v mono">${esc(client.discovery.userinfo_endpoint)}</span></div>
      </div>`,
    foot: canWrite
      ? `${client.clientType !== 'public' ? `<button class="btn btn-default" id="oc-rotate">${icon('refresh', 14)}轮换 secret</button>` : ''}
         ${active
           ? '<button class="btn btn-danger-ghost" id="oc-disable">禁用客户端</button>'
           : '<button class="btn btn-primary" id="oc-enable">启用客户端</button>'}`
      : '',
  })
  const rotateBtn = drawer.el.querySelector('#oc-rotate')
  if (rotateBtn) rotateBtn.onclick = async () => {
    const result = await confirmDialog({ title: '轮换 client_secret', danger: true, confirmText: '确认轮换', message: '旧 secret <b>立即失效</b>，新 secret 仅展示一次。' })
    if (!result) return
    try {
      const rotated = await api.post(`/api/authn/oidc/clients/${client.id}/rotate`)
      openModal({
        title: '新 client_secret（仅此一次展示）',
        body: `<div class="code-block">client_id:     ${esc(rotated.clientId)}
client_secret: ${esc(rotated.clientSecret)}</div>
          <div class="form-hint mt-8">${esc(rotated.note ?? '')}</div>`,
        foot: '<button class="btn btn-primary" data-ok>已保存</button>',
      })
    } catch (error) { toast(error.message, 'error') }
  }
  const disableBtn = drawer.el.querySelector('#oc-disable')
  if (disableBtn) disableBtn.onclick = async () => {
    const result = await confirmDialog({ title: '禁用 OIDC 客户端', requireReason: true, danger: true, confirmText: '立即禁用', message: '禁用后该客户端授权跳转与令牌刷新立即失败。' })
    if (!result) return
    try {
      await api.post(`/api/authn/oidc/clients/${client.id}/disable`, { reason: result.reason })
      toast(rqI18n.t('客户端已禁用')); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
  const enableBtn = drawer.el.querySelector('#oc-enable')
  if (enableBtn) enableBtn.onclick = async () => {
    try {
      await api.post(`/api/authn/oidc/clients/${client.id}/enable`)
      toast(rqI18n.t('客户端已启用')); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
}
