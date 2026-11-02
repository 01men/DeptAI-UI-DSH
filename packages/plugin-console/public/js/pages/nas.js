/** NAS 存储：FS 文件存储类资产纳管（列表 / 新建 / mcpServers JSON 导入 / 详情 / 文件浏览器）。 */
import { api, session } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog,
  statusBadge, renderTable, collectForm, field, inputField, selectField, textareaField,
  fmtTime, timeAgo, emptyState, copyText,
} from '../ui.js'

const NAS_STATES = [
  { key: '', label: '全部' },
  { key: 'draft', label: '草稿' },
  { key: 'online', label: '已上线' },
  { key: 'offline', label: '已下线' },
  { key: 'archived', label: '已归档' },
]

export async function renderNas(content, params, ctx) {
  let filter = { q: params.get('q') ?? '', status: params.get('status') ?? '' }
  const data = await api.get('/api/nas' + api.qs(filter))
  const schema = data.schema

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">NAS / FILES</div>
        <div class="page-title">NAS 存储</div>
        <div class="page-sub">FS 文件存储类资产：经 MCP 文件网关（地址 + Bearer 令牌 + X-NAS-IP 路由头）统一纳管，探活 → 上线 → 工具发现，文件操作全程审计留痕。</div>
      </div>
      <div class="page-actions">
        ${session.can('nas.write') ? `<button class="btn btn-default" id="nas-import">${icon('plug', 14)}导入 mcpServers JSON</button>` : ''}
        ${session.can('nas.write') ? `<button class="btn btn-primary" id="nas-create">${icon('plus', 14)}新建 NAS 资产</button>` : ''}
      </div>
    </div>
    <div class="filter-bar">
      <div class="search-input">${icon('search')}<input class="input" id="nas-q" placeholder="搜索名称 / 描述 / IP" value="${esc(filter.q)}"></div>
      <div class="chips" id="nas-status">
        ${NAS_STATES.map((s) => `<span class="chip ${filter.status === s.key ? 'active' : ''}" data-s="${s.key}">${s.label}</span>`).join('')}
      </div>
    </div>
    <div id="nas-list"></div>`

  const refresh = async () => {
    const result = await api.get('/api/nas' + api.qs(filter))
    renderList(result.items)
  }

  function renderList(items) {
    const holder = $('#nas-list')
    holder.innerHTML = ''
    if (!items.length) {
      holder.appendChild(emptyState({
        title: '还没有 NAS 资产',
        desc: '新建资产或粘贴 mcpServers JSON 一键纳管，网关可达即可上线并发现文件工具',
        ...(session.can('nas.write') ? { actionText: '新建 NAS 资产', onAction: () => $('#nas-create').click() } : {}),
        icon: 'server',
      }))
      return
    }
    holder.appendChild(renderTable({
      columns: [
        {
          title: '资产', render: (item) => `
            <div class="fs-13" style="font-weight:600">${esc(item.name)}</div>
            <div class="fs-11 text-4 mono">${esc(item.slug ?? item.id)}</div>`,
        },
        { title: '状态', width: 90, render: (item) => statusBadge(item.status) },
        { title: '健康', width: 130, render: (item) => healthCell(item.health) },
        { title: '网关工具', width: 90, render: (item) => `<span class="col-num">${item.gatewayToolCount ?? 0}</span>` },
        { title: '描述', render: (item) => `<span class="fs-12 text-3">${esc(item.attrs?.description ?? '—')}</span>` },
        { title: '更新时间', width: 110, render: (item) => `<span class="fs-12 text-4">${timeAgo(item.updatedAt)}</span>` },
      ],
      rows: items,
      onRowClick: (id) => openNasDetail(id, ctx, schema),
      empty: '没有匹配的 NAS 资产',
    }))
  }

  $('#nas-q').oninput = debounce(() => { filter.q = $('#nas-q').value.trim(); void refresh() }, 300)
  $$('#nas-status .chip').forEach((chip) => {
    chip.onclick = () => {
      $$('#nas-status .chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      filter.status = chip.dataset.s
      void refresh()
    }
  })
  const createBtn = $('#nas-create')
  if (createBtn) createBtn.onclick = () => openNasCreate(schema, ctx)
  const importBtn = $('#nas-import')
  if (importBtn) importBtn.onclick = () => openNasImport(ctx)

  renderList(data.items)
  if (params.get('action') === 'create') openNasCreate(schema, ctx)
  if (params.get('action') === 'import') openNasImport(ctx)
  if (params.get('focus')) void openNasDetail(params.get('focus'), ctx, schema)
}

// ---------- 新建/编辑共用：schema 驱动表单（与 agents.js 同约定） ----------
function renderNasSchemaField(f, value) {
  const name = `attr_${f.key}`
  // 编辑时令牌不回填（回显为脱敏值），留空 = 保持不变
  const isSecret = f.key === 'accessToken' && value !== undefined
  const text = value === undefined || value === null || isSecret ? '' : String(value)
  const placeholder = isSecret ? '已保存，留空则保持不变' : f.placeholder
  if (f.type === 'enum') {
    return field(f.label, selectField(name, (f.options ?? []).map((o) => ({ value: o.value, label: o.hint ? `${o.label}（${o.hint}）` : o.label })), { value: text || String(f.defaultValue ?? '') }), { required: f.required, hint: f.hint })
  }
  if (f.type === 'text') {
    return field(f.label, textareaField(name, { placeholder, rows: 2, value: text }), { required: f.required, hint: f.hint, full: true })
  }
  if (f.type === 'tags') {
    const tagText = Array.isArray(value) ? value.join(', ') : text
    return field(f.label, inputField(`tags_${f.key}`, { placeholder: '逗号分隔', value: tagText }), { hint: f.hint })
  }
  return field(f.label, inputField(name, { placeholder, value: text || String(f.defaultValue ?? '') }), { required: f.required, hint: f.hint })
}

function openNasForm({ title, hint, schema, initial, submitText, onSubmit }) {
  const groupsByField = new Map()
  for (const fieldSpec of schema?.fields ?? []) {
    if (!groupsByField.has(fieldSpec.group)) groupsByField.set(fieldSpec.group, [])
    groupsByField.get(fieldSpec.group).push(fieldSpec)
  }
  const groupLabels = Object.fromEntries((schema?.groups ?? []).map((g) => [g.key, g.label]))
  const modal = openModal({
    title, wide: true,
    body: `
      ${hint ? `<div class="form-hint" style="margin-bottom:12px">${hint}</div>` : ''}
      <div class="form-grid">
        ${field('资产名称', inputField('name', { placeholder: '如：研发文件服务器', value: initial?.name ?? '' }), { required: true })}
        ${initial
          ? field('唯一标识', `<input class="input" value="${esc(initial.slug ?? initial.id)}" disabled>`, { hint: '标识创建后不可修改' })
          : field('唯一标识', inputField('slug', { placeholder: '小写字母与中划线，留空自动生成' }))}
      </div>
      ${[...groupsByField.entries()].map(([group, fields]) => `
        <div class="card-title mb-8" style="margin-top:6px">${esc(groupLabels[group] ?? group)}</div>
        <div class="form-grid">
          ${fields.map((f) => renderNasSchemaField(f, initial?.attrs?.[f.key])).join('')}
        </div>`).join('')}`,
    foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>${esc(submitText)}</button>`,
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const data = collectForm(modal.body)
    if (!data.name) return toast(rqI18n.t('请填写资产名称'), 'error')
    const attrs = {}
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('attr_') && value !== '') attrs[key.slice(5)] = value
      if (key.startsWith('tags_') && value) attrs[key.slice(4)] = value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    }
    btn.classList.add('btn-loading')
    try {
      await onSubmit({ name: data.name, slug: data.slug || undefined, attrs })
      modal.close()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

function openNasCreate(schema, ctx) {
  openNasForm({
    title: '新建 NAS 资产', schema, submitText: '创建',
    hint: '必填最小集即可创建草稿；上线前需补全接入属性（网关地址 / 令牌 / 设备 IP）。',
    onSubmit: async (data) => {
      await api.post('/api/nas', { name: data.name, slug: data.slug, attrs: data.attrs })
      toast(rqI18n.t('已创建（草稿），健康探活通过后可上线'))
      ctx.rerender()
    },
  })
}

/** 二次编辑：复用 schema 表单回填；留空字段保持不变（含令牌）。 */
function openNasEdit(nas, schema, ctx) {
  openNasForm({
    title: rqI18n.t('编辑 NAS 资产 · {name}', { name: nas.name }), schema, initial: nas, submitText: '保存',
    hint: '留空的属性保持原值不变；接入属性（网关/令牌/设备 IP）变更后即时生效并触发重新探活。',
    onSubmit: async (data) => {
      await api.patch(`/api/nas/${nas.id}`, { name: data.name, attrs: data.attrs })
      toast(rqI18n.t('已保存'))
      ctx.rerender()
    },
  })
}

// ---------- mcpServers JSON 导入 ----------
function openNasImport(ctx) {
  const example = JSON.stringify({ mcpServers: { 'synology-filestation': { url: 'http://192.168.0.7:3000/mcp', headers: { Authorization: 'Bearer 你的令牌', 'X-NAS-IP': '192.168.0.196' } } } }, null, 2)
  const modal = openModal({
    title: '导入 mcpServers JSON', wide: true,
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">
        ${icon('info', 15)}<span>粘贴 Claude / Cursor 等工具通行的 mcpServers 配置：解析网关地址、Bearer 令牌与 X-NAS-IP 设备路由头 → 创建资产 → 探活 → 可达即自动上线并发现工具。</span>
      </div>
      <div class="form-grid">
        ${field('资产名称（单条配置时可覆盖）', inputField('name', { placeholder: '留空使用配置中的服务名' }))}
        ${field('描述', inputField('description', { placeholder: '留空自动生成' }))}
      </div>
      ${field('MCP 配置 JSON', `<textarea class="form-control" name="config" rows="10" style="font-family:var(--mono);font-size:12px" placeholder='${esc(example)}'></textarea>`, { required: true })}
      <div id="import-results"></div>`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>导入并纳管</button>',
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const data = collectForm(modal.body)
    if (!data.config) return toast(rqI18n.t('请粘贴 MCP 配置 JSON'), 'error')
    try { JSON.parse(data.config) } catch { return toast(rqI18n.t('配置不是合法 JSON，请检查后重试'), 'error') }
    btn.classList.add('btn-loading')
    try {
      const result = await api.post('/api/nas/import', {
        config: data.config,
        name: data.name || undefined,
        description: data.description || undefined,
      })
      modal.body.querySelector('#import-results').innerHTML = `
        <div class="card-title mt-14 mb-8">${esc(rqI18n.t('导入结果（成功 {a} / {b}）', { a: result.imported, b: result.results.length }))}</div>
        ${result.results.map((item) => `
          <div class="card card-pad mb-8">
            <div class="flex-between">
              <span style="font-weight:600">${esc(item.name)}</span>
              ${item.ok ? `<span class="badge badge-ok no-dot">已纳管</span>` : `<span class="badge badge-danger no-dot">失败</span>`}
            </div>
            ${item.ok ? `
              <div class="fs-12 text-3 mt-8">
                ${esc(rqI18n.t('网关'))}${item.reachable ? `<span style="color:var(--ok)">${esc(rqI18n.t('可达'))}</span>${esc(rqI18n.t('，发现 {n} 个工具，状态 {status}', { n: item.tools ?? 0, status: item.status ?? '' }))}` : `<span style="color:var(--warn)">${esc(rqI18n.t('不可达'))}</span>`}
              </div>` : ''}
            ${item.error ? `<div class="fs-12 mt-8" style="color:var(--danger)">${esc(item.error)}</div>` : ''}
          </div>`).join('')}`
      if (result.imported > 0) toast(rqI18n.t('已导入 {n} 个 NAS 资产', { n: result.imported }))
      if (result.imported === result.results.length) { modal.close(); ctx.rerender() }
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

// ---------- 详情抽屉 ----------
async function openNasDetail(id, ctx, schema) {
  const nas = await api.get(`/api/nas/${id}`)
  const canWrite = session.can('nas.write')
  const online = nas.status === 'online'

  const drawer = openDrawer({
    title: nas.name,
    sub: `${nas.slug} · ${nas.attrs?.gatewayUrl ?? rqI18n.t('未配置网关')}`,
    wide: true,
    body: `
      <div class="flex mb-14" style="gap:8px;flex-wrap:wrap">
        ${statusBadge(nas.status)}
        ${healthCell(nas.health)}
        <span class="badge badge-info no-dot">${esc(rqI18n.t('密级：{level}', { level: rqI18n.t(dataClassLabel(nas.attrs?.dataClass)) }))}</span>
        ${(Array.isArray(nas.attrs?.tags) ? nas.attrs.tags : []).map((tag) => `<span class="badge badge-muted no-dot">${esc(tag)}</span>`).join('')}
      </div>

      <div class="tabs" id="nas-tabs">
        <div class="tab active" data-tab="overview">概览</div>
        <div class="tab" data-tab="tools">${esc(rqI18n.t('网关工具 ({n})', { n: (nas.gatewayTools ?? []).length }))}</div>
        <div class="tab" data-tab="fs">文件浏览</div>
        <div class="tab" data-tab="audit">审计</div>
      </div>
      <div id="nas-tab-body"></div>`,
    foot: `
      <button class="btn btn-default" id="nas-health">${icon('wifi', 14)}健康探活</button>
      ${canWrite && nas.status !== 'archived' ? `<button class="btn btn-default" id="nas-edit">${icon('edit', 14)}编辑</button>` : ''}
      ${canWrite ? `<button class="btn btn-default" id="nas-sync-tools">${icon('refresh', 14)}同步网关工具</button>` : ''}
      ${canWrite ? (nas.availableTransitions ?? []).map((t) => {
        const tone = t.action === 'online' ? 'btn-primary' : t.action === 'offline' ? 'btn-danger-ghost' : 'btn-default'
        const ic = t.action === 'online' ? 'play' : t.action === 'offline' ? 'alert' : 'box'
        return `<button class="btn ${tone}" data-action="${esc(t.action)}">${icon(ic, 14)}${esc(t.label)}</button>`
      }).join('') : ''}
      ${canWrite && ['draft', 'archived'].includes(nas.status) ? `<button class="btn btn-danger-ghost" id="nas-delete">${icon('trash', 14)}删除</button>` : ''}`,
  })

  const tabBody = drawer.body.querySelector('#nas-tab-body')
  const renderTab = (tab) => {
    if (tab === 'overview') {
      const attrs = nas.attrs ?? {}
      tabBody.innerHTML = `
        <div class="muted-box mb-14">${esc(attrs.description ?? '暂无描述')}</div>
        <div class="card-title mb-8">基本属性</div>
        <div class="desc-grid mb-14">
          <div class="desc-item"><span class="k">资产 ID</span><span class="v mono">${esc(nas.id)}</span></div>
          <div class="desc-item"><span class="k">标识</span><span class="v mono">${esc(nas.slug)}</span></div>
          <div class="desc-item"><span class="k">厂商/型号</span><span class="v">${esc(attrs.vendor ?? '—')}</span></div>
          <div class="desc-item"><span class="k">容量</span><span class="v">${esc(attrs.capacity ?? '—')}</span></div>
          <div class="desc-item"><span class="k">数据密级</span><span class="v">${dataClassLabel(attrs.dataClass)}</span></div>
          <div class="desc-item"><span class="k">创建时间</span><span class="v">${fmtTime(nas.createdAt)}</span></div>
        </div>
        <div class="card-title mb-8">接入属性</div>
        <div class="desc-grid">
          <div class="desc-item"><span class="k">MCP 网关地址</span><span class="v mono">${esc(attrs.gatewayUrl ?? '未配置')}</span></div>
          <div class="desc-item"><span class="k">访问令牌</span><span class="v mono">${esc(attrs.accessToken ?? '未配置')}<span class="fs-11 text-4">（已脱敏）</span></span></div>
          <div class="desc-item"><span class="k">NAS 设备 IP</span><span class="v mono">${esc(attrs.nasIp ?? '未配置')}</span></div>
          <div class="desc-item"><span class="k">授权根路径</span><span class="v mono">${esc(attrs.rootPath ?? '/')}</span></div>
          <div class="desc-item"><span class="k">上传中转目录</span><span class="v mono">${esc(attrs.stagingDir ?? '默认 <dataDir>/nas-staging')}</span></div>
          <div class="desc-item"><span class="k">最近探活</span><span class="v">${nas.health?.lastProbeAt ? timeAgo(nas.health.lastProbeAt) : '—'}${nas.health?.serverName ? ` · ${esc(nas.health.serverName)}` : ''}</span></div>
        </div>
        <div class="card-title mb-8" style="margin-top:14px">NAS 资源概览</div>
        <div id="nas-res-overview"><div class="fs-12 text-4" style="padding:6px 0">加载中…</div></div>`
      void loadResourceOverview(tabBody.querySelector('#nas-res-overview'))
    }
    if (tab === 'tools') {
      const tools = nas.gatewayTools ?? []
      tabBody.innerHTML = tools.length ? tools.map((tool) => `
        <div class="card card-pad mb-8">
          <div class="flex" style="gap:8px">
            <span class="mono" style="font-weight:600">${esc(tool.name)}</span>
          </div>
          ${tool.description ? `<div class="fs-12 text-3 mt-8">${esc(tool.description)}</div>` : ''}
        </div>`).join('') : '<span class="text-4 fs-12">尚未发现工具：上线后自动发现，或点击底部「同步网关工具」</span>'
    }
    if (tab === 'fs') {
      if (!online) {
        tabBody.innerHTML = `<div class="muted-box" style="display:flex;gap:8px">${icon('info', 15)}<span>仅「已上线」资产可执行文件操作，请先上线该 NAS。</span></div>`
        return
      }
      tabBody.innerHTML = '<div id="fs-browser"></div>'
      mountFsBrowser(tabBody.querySelector('#fs-browser'), nas, ctx)
    }
    if (tab === 'audit') {
      const logs = nas.audit ?? []
      tabBody.innerHTML = logs.length ? `
        <div class="timeline">
          ${logs.slice(0, 15).map((log) => `
            <div class="timeline-item">
              <div class="timeline-dot"></div>
              <div class="timeline-title">${esc(log.action)} ${log.result && log.result !== 'ok' ? statusBadge(log.result === 'denied' ? 'denied' : 'error') : ''}</div>
              <div class="timeline-time">${timeAgo(log.createdAt)} · ${esc(log.actorName ?? '')}</div>
              ${log.detail ? `<div class="timeline-body">${esc(log.detail)}</div>` : ''}
            </div>`).join('')}
        </div>` : '<span class="text-4 fs-12">暂无审计记录</span>'
    }
  }
  drawer.body.querySelectorAll('#nas-tabs .tab').forEach((el) => {
    el.onclick = () => {
      drawer.body.querySelectorAll('#nas-tabs .tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })
  renderTab('overview')

  /** NAS 资源概览：经网关 fs_list_shares / fs_get_info 实时查看基础资源（参考 synology-filestation-mcp）。 */
  async function loadResourceOverview(host) {
    if (!host) return
    if (!online) {
      host.innerHTML = `<div class="muted-box" style="display:flex;gap:8px">${icon('info', 15)}<span>仅「已上线」资产可实时查看 NAS 资源，请先上线。</span></div>`
      return
    }
    try {
      const rootPath = nas.attrs?.rootPath || '/'
      const [sharesRaw, infoRaw] = await Promise.all([
        api.get(`/api/nas/${nas.id}/fs`),
        api.get(`/api/nas/${nas.id}/fs/info` + api.qs({ path: rootPath })).catch(() => null),
      ])
      const shares = normalizeEntries(sharesRaw, true)
      const infoItems = infoRaw && typeof infoRaw === 'object' && !Array.isArray(infoRaw)
        ? Object.entries(infoRaw).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 8)
        : []
      host.innerHTML = `
        <div class="fs-12 text-3 mb-8">${esc(rqI18n.t('共享文件夹（{n}）· 点击跳转文件浏览：', { n: shares.length }))}</div>
        <div class="flex" style="gap:6px;flex-wrap:wrap">
          ${shares.length ? shares.map((s) => `<span class="chip" data-share="${esc(s.name)}" style="cursor:pointer">${icon('box', 12)} ${esc(s.name)}</span>`).join('') : '<span class="fs-12 text-4">未查询到共享文件夹</span>'}
        </div>
        ${infoItems.length ? `
          <div class="fs-12 text-3 mt-14 mb-8">${esc(rqI18n.t('授权根路径 {path} 详情：', { path: rootPath }))}</div>
          <div class="desc-grid">
            ${infoItems.map(([k, v]) => `<div class="desc-item"><span class="k">${esc(k)}</span><span class="v mono">${esc(String(v))}</span></div>`).join('')}
          </div>` : ''}`
      host.querySelectorAll('[data-share]').forEach((el) => {
        el.onclick = () => drawer.body.querySelector('#nas-tabs .tab[data-tab="fs"]')?.click()
      })
    } catch (error) {
      host.innerHTML = `<div class="muted-box" style="color:var(--danger)">${esc(error.message)}</div>`
    }
  }

  const editBtn = drawer.el.querySelector('#nas-edit')
  if (editBtn) editBtn.onclick = () => openNasEdit(nas, schema, ctx)
  const deleteBtn = drawer.el.querySelector('#nas-delete')
  if (deleteBtn) deleteBtn.onclick = async () => {
    const result = await confirmDialog({
      title: rqI18n.t('删除 NAS · {name}', { name: nas.name }), requireReason: true, danger: true, confirmText: '确认删除',
      message: '将永久删除该资产台账（含健康档案与工具发现缓存），操作不可恢复，审计数据保留。',
    })
    if (!result) return
    try {
      await api.delete(`/api/nas/${nas.id}`)
      toast(rqI18n.t('已删除')); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }

  drawer.el.querySelector('#nas-health').onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      const result = await api.post(`/api/nas/${nas.id}/health`)
      toast(rqI18n.t('探测完成：{status}（{ms}ms）', { status: rqI18n.t(healthText(result.status)), ms: result.latencyMs }), result.status === 'down' ? 'error' : 'success')
      drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
  }
  const syncBtn = drawer.el.querySelector('#nas-sync-tools')
  if (syncBtn) syncBtn.onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      const result = await api.post(`/api/nas/${nas.id}/sync-tools`)
      toast(rqI18n.t('工具清单已同步：{n} 个工具', { n: result.count }))
      drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
  }
  for (const transition of nas.availableTransitions ?? []) {
    const btn = drawer.el.querySelector(`[data-action="${transition.action}"]`)
    if (!btn) continue
    btn.onclick = async () => {
      if (transition.action === 'offline') {
        const result = await confirmDialog({
          title: rqI18n.t('下线 NAS · {name}', { name: nas.name }), requireReason: true, danger: true, confirmText: '确认下线',
          message: `下线后该 NAS 的全部文件操作（含 Skill 包存储）将立即不可用，审计数据保留。`,
        })
        if (!result) return
        try {
          await api.post(`/api/nas/${nas.id}/transition`, { action: 'offline', note: result.reason })
          toast(rqI18n.t('已下线')); drawer.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
        return
      }
      if (transition.action === 'archive') {
        const result = await confirmDialog({
          title: rqI18n.t('归档 NAS · {name}', { name: nas.name }), danger: true, confirmText: '确认归档',
          message: `归档为终态操作：资产转为只读台账，不再参与健康巡检与文件操作。`,
        })
        if (!result) return
        try {
          await api.post(`/api/nas/${nas.id}/transition`, { action: 'archive' })
          toast(rqI18n.t('已归档')); drawer.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
        return
      }
      try {
        await api.post(`/api/nas/${nas.id}/transition`, { action: transition.action })
        toast(rqI18n.t('已上线')); drawer.close(); ctx.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  }
}

// ---------- 文件浏览器 ----------
function mountFsBrowser(host, nas, ctx) {
  let currentPath = '' // '' = 共享文件夹根；此后形如 /share/sub
  let entries = []
  const canWrite = session.can('nas.write')

  const joinPath = (base, name) => `/${[base, name].join('/').split('/').filter(Boolean).join('/')}`

  const render = () => {
    const segments = currentPath.split('/').filter(Boolean)
    host.innerHTML = `
      <div class="flex mb-8" style="gap:8px;flex-wrap:wrap;align-items:center">
        <div class="grow fs-13" style="min-width:0">
          <span class="chip" data-crumb="" style="cursor:pointer">共享文件夹</span>
          ${segments.map((seg, i) => `
            <span class="text-4" style="margin:0 2px">/</span><span class="chip" data-crumb="${esc('/' + segments.slice(0, i + 1).join('/'))}" style="cursor:pointer">${esc(seg)}</span>`).join('')}
        </div>
        ${canWrite && currentPath ? `<button class="btn btn-default btn-sm" id="fs-mkdir">${icon('plus', 13)}新建文件夹</button>` : ''}
        ${canWrite && currentPath ? `<button class="btn btn-default btn-sm" id="fs-upload">${icon('arrowUp', 13)}上传</button>` : ''}
        <button class="btn btn-default btn-sm" id="fs-search">${icon('search', 13)}搜索</button>
        ${session.can('nas.authz.read') ? `<button class="btn btn-default btn-sm" id="fs-links">${icon('link', 13)}链接管理</button>` : ''}
        <button class="btn btn-ghost btn-sm" id="fs-reload" title="刷新">${icon('refresh', 13)}</button>
      </div>
      <div id="fs-table"></div>`
    host.querySelectorAll('[data-crumb]').forEach((el) => {
      el.onclick = () => { currentPath = el.dataset.crumb; void load() }
    })
    host.querySelector('#fs-reload').onclick = () => void load()
    host.querySelector('#fs-search').onclick = () => openSearch()
    const linksBtn = host.querySelector('#fs-links')
    if (linksBtn) linksBtn.onclick = () => void openShareLinksManager(nas)
    const mkdirBtn = host.querySelector('#fs-mkdir')
    if (mkdirBtn) mkdirBtn.onclick = () => openMkdir()
    const uploadBtn = host.querySelector('#fs-upload')
    if (uploadBtn) uploadBtn.onclick = () => openUpload()

    const tableHost = host.querySelector('#fs-table')
    tableHost.innerHTML = ''
    tableHost.appendChild(renderTable({
      columns: [
        {
          title: '名称', render: (entry) => `
            <span class="flex" style="gap:8px">
              <span style="color:var(--${entry.isDir ? 'brand-500' : 'text-4)'})">${icon(entry.isDir ? 'box' : 'file', 15)}</span>
              <span class="fs-13" style="${entry.isDir ? 'font-weight:600;cursor:pointer' : ''}" data-open="${entry.isDir ? '1' : ''}">${esc(entry.name)}</span>
            </span>`,
        },
        { title: '大小', width: 100, render: (entry) => `<span class="col-num fs-12">${entry.isDir ? '—' : fmtBytes(entry.size)}</span>` },
        { title: '修改时间', width: 130, render: (entry) => `<span class="fs-12 text-4">${fmtEntryTime(entry.mtime)}</span>` },
        {
          title: '操作', width: 230, render: (entry) => `
            <span class="flex" style="gap:4px">
              ${!entry.isDir ? `<button class="btn btn-ghost btn-sm stop" data-download title="下载到本机">${icon('download', 12)}</button>
              <button class="btn btn-ghost btn-sm stop" data-copylink title="复制下载链接">${icon('link', 12)}</button>` : ''}
              ${canWrite ? `<button class="btn btn-ghost btn-sm stop" data-rename title="重命名">${icon('edit', 12)}</button>` : ''}
              ${canWrite ? `<button class="btn btn-ghost btn-sm stop" data-delete title="删除" style="color:var(--danger)">${icon('trash', 12)}</button>` : ''}
            </span>`,
        },
      ],
      rows: entries,
      rowKey: (entry, i) => entry.name ?? i,
      onRowClick: (name, entry) => { if (entry?.isDir) { currentPath = joinPath(currentPath, entry.name); void load() } },
      empty: currentPath ? '空目录' : '未查询到共享文件夹',
    }))
    tableHost.querySelectorAll('tbody tr').forEach((tr, i) => {
      const entry = entries[i]
      if (!entry) return
      const path = joinPath(currentPath, entry.name)
      const downloadBtn = tr.querySelector('[data-download]')
      if (downloadBtn) downloadBtn.onclick = async (e) => {
        e.stopPropagation()
        // 一次性票据 + <a> 原生下载：免 Bearer 头，服务端流式直出，大文件不吃内存
        downloadBtn.classList.add('btn-loading')
        try {
          const { ticket } = await api.post(`/api/nas/${nas.id}/fs/download-ticket`, { path })
          const a = document.createElement('a')
          a.href = `/api/nas/${nas.id}/fs/file?path=${encodeURIComponent(path)}&ticket=${encodeURIComponent(ticket)}`
          a.download = entry.name
          a.style.display = 'none'
          document.body.appendChild(a)
          a.click()
          a.remove()
          toast(rqI18n.t('已开始下载 {name}', { name: entry.name }))
        } catch (error) { toast(error.message, 'error') }
        finally { downloadBtn.classList.remove('btn-loading') }
      }
      const copyLinkBtn = tr.querySelector('[data-copylink]')
      if (copyLinkBtn) copyLinkBtn.onclick = (e) => {
        e.stopPropagation()
        // 签名分享链接（2026-09-21 改造）：有效期可选（1 小时 / 24 小时默认 / 7 天 / 30 天 / 永久），
        // 取流时以签发者身份实时复核数据权限，链接可在「链接管理」中随时吊销
        void openShareLinkModal(nas, path, entry)
      }
      const renameBtn = tr.querySelector('[data-rename]')
      if (renameBtn) renameBtn.onclick = (e) => {
        e.stopPropagation()
        const modal = openModal({
          title: rqI18n.t('重命名 · {name}', { name: entry.name }),
          body: field('新名称', inputField('newName', { value: entry.name }), { required: true }),
          foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>重命名</button>',
        })
        modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
        modal.el.querySelector('[data-ok]').onclick = async () => {
          const newName = collectForm(modal.body).newName
          if (!newName || newName === entry.name) return modal.close()
          try {
            await api.post(`/api/nas/${nas.id}/fs/rename`, { path, newName })
            toast(rqI18n.t('已重命名')); modal.close(); void load()
          } catch (error) { toast(error.message, 'error') }
        }
      }
      const deleteBtn = tr.querySelector('[data-delete]')
      if (deleteBtn) deleteBtn.onclick = async (e) => {
        e.stopPropagation()
        const result = await confirmDialog({
          title: rqI18n.t('删除 · {name}', { name: entry.name }), danger: true, confirmText: '确认删除',
          message: rqI18n.t('将从 NAS 删除 <b>{path}</b>{dir}，操作将写入审计日志。', { path: esc(path), dir: entry.isDir ? rqI18n.t('（含目录内全部内容）') : '' }),
        })
        if (!result) return
        try {
          await api.post(`/api/nas/${nas.id}/fs/delete`, { paths: [path] })
          toast(rqI18n.t('已删除')); void load()
        } catch (error) { toast(error.message, 'error') }
      }
    })
  }

  const load = async () => {
    host.querySelector('#fs-table')?.replaceChildren(h('<div class="fs-12 text-4" style="padding:18px">加载中…</div>'))
    try {
      const raw = currentPath ? await api.get(`/api/nas/${nas.id}/fs` + api.qs({ path: currentPath })) : await api.get(`/api/nas/${nas.id}/fs`)
      entries = normalizeEntries(raw, !currentPath)
      render()
    } catch (error) {
      host.querySelector('#fs-table').innerHTML = `<div class="muted-box" style="color:var(--danger)">${esc(error.message)}</div>`
    }
  }

  const openMkdir = () => {
    const modal = openModal({
      title: rqI18n.t('新建文件夹 · {path}', { path: currentPath }),
      body: field('文件夹名称', inputField('folder', { placeholder: '如：skill-packages' }), { required: true }),
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>创建</button>',
    })
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const folder = collectForm(modal.body).folder
      if (!folder) return toast(rqI18n.t('请填写文件夹名称'), 'error')
      try {
        await api.post(`/api/nas/${nas.id}/fs/mkdir`, { path: joinPath(currentPath, folder) })
        toast(rqI18n.t('已创建')); modal.close(); void load()
      } catch (error) { toast(error.message, 'error') }
    }
  }

  const openUpload = () => {
    const modal = openModal({
      title: rqI18n.t('上传文件 · {path}', { path: currentPath }), wide: true,
      body: `
        <div class="form-grid">
          <div>
            <div class="form-label">本地文件（可多选）</div>
            <input class="input" type="file" name="files" multiple>
            <div class="form-hint">多个文件将依次上传到当前目录。</div>
          </div>
          <div>
            <div class="form-label">或选择文件夹（保留目录结构）</div>
            <input class="input" type="file" name="dirs" webkitdirectory directory multiple>
            <div class="form-hint">支持文件夹内嵌套子目录。仅 Chromium 内核生效。</div>
          </div>
        </div>
        <div id="upload-list" style="margin-top:14px"></div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>开始上传</button>',
    })
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    const fileInput = modal.body.querySelector('input[name=files]')
    const dirInput = modal.body.querySelector('input[name=dirs]')
    const listHost = modal.body.querySelector('#upload-list')

    const collectItems = () => {
      const items = []
      const files = fileInput.files ?? []
      for (const f of files) items.push({ relativePath: f.name, file: f })
      const dirs = dirInput.files ?? []
      for (const f of dirs) {
        const relRaw = String(f.webkitRelativePath ?? f.name)
        const rel = relRaw.includes('/') ? relRaw.split('/').slice(1).join('/') : f.name
        items.push({ relativePath: rel, file: f })
      }
      return items
    }

    const renderPreview = () => {
      const items = collectItems()
      const totalBytes = items.reduce((s, it) => s + it.file.size, 0)
      listHost.innerHTML = items.length === 0
        ? '<div class="muted-box">暂未选择文件</div>'
        : `<div class="fs-12 text-3 mb-8">${esc(rqI18n.t('待上传 <b>{n}</b> 项 · 共 {size}（点击「开始上传」执行）', { n: items.length, size: fmtBytes(totalBytes) }))}</div>
           <div style="max-height:200px;overflow:auto;border:1px solid var(--border);border-radius:6px">
             ${items.map((it, i) => `<div class="flex" style="padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px">
               <span class="text-4" style="min-width:32px">${i + 1}.</span>
               <span class="grow mono" style="word-break:break-all">${esc(it.relativePath)}</span>
               <span class="text-4">${fmtBytes(it.file.size)}</span>
             </div>`).join('')}
           </div>`
    }
    fileInput.onchange = renderPreview
    dirInput.onchange = renderPreview
    renderPreview()

    modal.el.querySelector('[data-ok]').onclick = async (e) => {
      const btn = e.currentTarget
      const items = collectItems()
      if (items.length === 0) return toast(rqI18n.t('请选择文件或文件夹'), 'error')
      btn.classList.add('btn-loading')
      btn.disabled = true

      const destDir = `/${[currentPath, ''].join('/').split('/').filter(Boolean).join('/')}`.replace(/\/+$/, '') || '/'
      let done = 0
      let failed = 0
      listHost.insertAdjacentHTML('beforeend', `<div class="fs-12 mt-8">${esc(rqI18n.t('进度：<b id="upd">0</b> / {total}（失败 <b id="upf" style="color:var(--danger)">0</b>）', { total: items.length }))}</div>`)
      const upd = listHost.querySelector('#upd')
      const upf = listHost.querySelector('#upf')

      const useBatch = items.length > 50
      try {
        if (useBatch) {
          const files = await Promise.all(items.map(async (it) => ({
            relativePath: it.relativePath,
            contentBase64: await readFileBase64(it.file),
          })))
          const result = await api.post(`/api/nas/${nas.id}/fs/upload-many`, { files, destDir })
          done = result.uploaded.length
          failed = result.failed.length
          upd.textContent = String(done)
          upf.textContent = String(failed)
          if (result.failed.length > 0) console.warn('upload-many 失败明细', result.failed)
        } else {
          for (const item of items) {
            try {
              const contentBase64 = await readFileBase64(item.file)
              const destPath = joinPath(currentPath, item.relativePath)
              await api.post(`/api/nas/${nas.id}/fs/upload`, { contentBase64, destPath })
              done++
            } catch (error) {
              failed++
              console.warn(`上传 ${item.relativePath} 失败`, error)
            }
            upd.textContent = String(done + failed)
            upf.textContent = String(failed)
          }
        }
        if (failed === 0) {
          toast(rqI18n.t('已上传 {n} 项到 {dir}', { n: done, dir: destDir }))
          modal.close(); void load()
        } else if (done > 0) {
          toast(rqI18n.t('部分成功：{ok} 成功 / {f} 失败', { ok: done, f: failed }), 'error')
          void load()
        } else {
          toast(rqI18n.t('上传失败：{n} 项', { n: failed }), 'error')
        }
      } catch (error) {
        toast(error.message, 'error')
      } finally {
        btn.classList.remove('btn-loading')
        btn.disabled = false
      }
    }
  }

  const openSearch = () => {
    const modal = openModal({
      title: '搜索文件', wide: true,
      body: `
        ${field('匹配模式', inputField('pattern', { placeholder: '如：report 或 *.zip' }), { required: true, hint: currentPath ? rqI18n.t('搜索范围：{path}', { path: currentPath }) : rqI18n.t('搜索范围：全部共享文件夹（根路径）') })}
        <div id="fs-search-results"></div>`,
      foot: '<button class="btn btn-default" data-cancel>关闭</button><button class="btn btn-primary" data-ok>搜索</button>',
    })
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async (e) => {
      const btn = e.currentTarget
      const pattern = collectForm(modal.body).pattern
      if (!pattern) return toast(rqI18n.t('请填写匹配模式'), 'error')
      btn.classList.add('btn-loading')
      try {
        const raw = await api.post(`/api/nas/${nas.id}/fs/search`, { pattern, path: currentPath || '/' })
        const results = normalizeSearchResults(raw)
        modal.body.querySelector('#fs-search-results').innerHTML = results.length ? `
          <div class="card-title mt-14 mb-8">${esc(rqI18n.t('命中 {n} 项', { n: results.length }))}</div>
          <div style="max-height:280px;overflow-y:auto">
            ${results.map((item) => `
              <div class="flex" style="padding:6px 0;border-bottom:1px solid var(--border)">
                <span style="color:var(--text-4)">${icon(item.isDir ? 'box' : 'file', 14)}</span>
                <span class="mono fs-12" style="word-break:break-all">${esc(item.path)}</span>
              </div>`).join('')}
          </div>` : '<div class="fs-12 text-4 mt-14">无匹配结果</div>'
      } catch (error) {
        toast(error.message, 'error')
      } finally {
        btn.classList.remove('btn-loading')
      }
    }
  }

  void load()
}

// ---------- 签名分享链接：有效期选择（2026-09-21 改造）+ 链接管理 ----------
const SHARE_TIER_TTL = { '1h': 3600, '24h': 86400, '7d': 604800, '30d': 2592000 }

async function openShareLinkModal(nas, path, entry) {
  // 永久选项显隐依据：权限点（本地判断）+ 策略开关（服务端权威，取不到时交给服务端拒绝）
  let policy = null
  try { policy = await api.get('/api/nas/authz/share-link-policy') } catch { policy = null }
  const canAuthzWrite = session.can('nas.authz.write')
  const permanentReason = !canAuthzWrite ? rqI18n.t('需 nas.authz.write 权限') : (policy && !policy.allowPermanent ? rqI18n.t('管理员未开启永久档位') : '')
  // 档位开关在「NAS 数据权限」治理页；有权限的管理员给一条直达路径（无权限者只说明原因）
  const permanentHint = permanentReason && canAuthzWrite
    ? rqI18n.t('{reason}，可在「数据权限 → 分享链接档位」中开启', { reason: permanentReason })
    : permanentReason
  const modal = openModal({
    title: rqI18n.t('复制下载链接 · {name}', { name: entry.name }),
    body: `
      <div class="form-hint mb-14">链接可贴到聊天/邮件等任意场景，打开即下载（无需登录）；取流时按<b>签发人当时的数据权限</b>实时复核，权限回收后链接即失效，也可在「链接管理」中随时吊销。</div>
      <div class="form-label">有效期</div>
      <div class="chips" id="share-tier" style="flex-wrap:wrap">
        <span class="chip" data-t="1h" style="cursor:pointer">1 小时</span>
        <span class="chip active" data-t="24h" style="cursor:pointer">24 小时</span>
        <span class="chip" data-t="7d" style="cursor:pointer">7 天</span>
        <span class="chip" data-t="30d" style="cursor:pointer">30 天</span>
        <span class="chip" data-t="permanent" style="cursor:pointer;${permanentReason ? 'opacity:.45' : ''}" ${permanentHint ? `title="${esc(permanentHint)}"` : ''}>${esc(rqI18n.t('永久'))}${permanentReason ? esc(rqI18n.t('（{reason}）', { reason: permanentReason })) : ''}</span>
      </div>
      <div class="fs-11 text-4" style="margin-top:8px">默认 24 小时；30 天与永久为显式选择——永久链接在权限回收前长期有效，签发前请确认文件适合长期分享。${permanentHint ? `<br><span style="color:var(--warn)">${esc(permanentHint)}</span>` : ''}</div>`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>复制链接</button>',
  })
  let tier = '24h'
  modal.body.querySelectorAll('#share-tier .chip').forEach((chip) => {
    chip.onclick = () => {
      if (chip.dataset.t === 'permanent' && permanentReason) return toast(permanentHint, 'error')
      modal.body.querySelectorAll('#share-tier .chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      tier = chip.dataset.t
    }
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    if (tier === 'permanent') {
      const ok = await confirmDialog({
        title: '签发永久链接', danger: true, confirmText: '确认签发',
        message: `永久链接在<b>权限回收或手动吊销前长期有效</b>，被转发即等同于交付文件本身，请确认此文件适合长期分享。<br><span class="fs-12 text-3">签发后可在 NAS 文件浏览 →「链接管理」中随时吊销。</span>`,
      })
      if (!ok) return
    }
    btn.classList.add('btn-loading')
    try {
      const result = tier === 'permanent'
        ? await api.post(`/api/nas/${nas.id}/fs/share-link`, { path, permanent: true })
        : await api.post(`/api/nas/${nas.id}/fs/share-link`, { path, ttlSec: SHARE_TIER_TTL[tier] })
      copyText(result.url)
      toast(tier === 'permanent' ? rqI18n.t('下载链接已复制，永久有效（可在链接管理中吊销）') : rqI18n.t('下载链接已复制，{ttl}内有效', { ttl: result.ttlLabel }))
      modal.close()
    } catch (error) { toast(error.message, 'error') }
    finally { btn.classList.remove('btn-loading') }
  }
}

async function openShareLinksManager(nas) {
  const canRevoke = session.can('nas.authz.write')
  const modal = openModal({
    title: rqI18n.t('链接管理 · {name}', { name: nas.name }), wide: true,
    body: '<div id="share-links-list"><div class="fs-12 text-4" style="padding:12px 0">加载中…</div></div>',
    foot: '<button class="btn btn-default" data-cancel>关闭</button>',
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  const load = async () => {
    const host = modal.body.querySelector('#share-links-list')
    try {
      const result = await api.get(`/api/nas/${nas.id}/fs/share-links` + api.qs({ includeRevoked: '1' }))
      const items = result.items ?? []
      host.innerHTML = ''
      if (!items.length) {
        host.innerHTML = '<div class="muted-box">尚未签发分享链接：在文件浏览中点击文件的「复制下载链接」即可签发。</div>'
        return
      }
      host.appendChild(renderTable({
        columns: [
          { title: '文件', render: (item) => `<span class="mono fs-12" style="word-break:break-all">${esc(item.path)}</span>` },
          { title: '签发人', width: 100, render: (item) => `<span class="fs-12">${esc(item.userName)}</span>` },
          { title: '状态 / 有效期', width: 170, render: (item) => shareStatusBadge(item) },
          { title: '使用', width: 60, render: (item) => `<span class="col-num fs-12">${item.useCount}</span>` },
          { title: '签发时间', width: 110, render: (item) => `<span class="fs-12 text-4">${timeAgo(item.createdAt)}</span>` },
          { title: '', width: 80, render: (item) => (!item.revokedAt && canRevoke
            ? `<button class="btn btn-ghost btn-sm stop" data-revoke="${esc(item.id)}" style="color:var(--danger)">吊销</button>` : '') },
        ],
        rows: items,
        rowKey: (item) => item.id,
        empty: '没有分享链接',
      }))
      host.querySelectorAll('[data-revoke]').forEach((btn) => {
        btn.onclick = async () => {
          const ok = await confirmDialog({
            title: '吊销分享链接', danger: true, confirmText: '确认吊销',
            message: '吊销后该链接立即失效（访问被拒绝），操作实时生效并写入审计日志。',
          })
          if (!ok) return
          try {
            await api.post(`/api/nas/${nas.id}/fs/share-links/${btn.dataset.revoke}/revoke`, {})
            toast(rqI18n.t('已吊销'))
            void load()
          } catch (error) { toast(error.message, 'error') }
        }
      })
    } catch (error) {
      host.innerHTML = `<div class="muted-box" style="color:var(--danger)">${esc(error.message)}</div>`
    }
  }
  void load()
}

function shareStatusBadge(item) {
  if (item.revokedAt) return `<span class="badge badge-danger no-dot">已吊销</span><span class="fs-11 text-4" style="margin-left:4px">${timeAgo(item.revokedAt)}</span>`
  if (item.status === 'expired') return '<span class="badge badge-muted no-dot">已过期</span>'
  if (item.expiresAt === null) return '<span class="badge badge-warn no-dot">永久有效</span>'
  return `<span class="badge badge-ok no-dot">有效</span><span class="fs-11 text-4" style="margin-left:4px">${esc(rqI18n.t('剩 {time}', { time: shareRemaining(item.remainingSec) }))}</span>`
}

function shareRemaining(sec) {
  if (sec === null) return rqI18n.t('永久')
  if (sec >= 86400) return rqI18n.t('{d} 天 {h} 时', { d: Math.floor(sec / 86400), h: Math.floor((sec % 86400) / 3600) })
  if (sec >= 3600) return rqI18n.t('{h} 时 {m} 分', { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60) })
  return rqI18n.t('{m} 分', { m: Math.max(1, Math.floor(sec / 60)) })
}

// ---------- helpers ----------
function normalizeEntries(raw, allDirs) {
  let arr = []
  if (Array.isArray(raw)) arr = raw
  else if (raw && typeof raw === 'object') {
    for (const key of ['files', 'items', 'entries', 'shares', 'list', 'data']) {
      if (Array.isArray(raw[key])) { arr = raw[key]; break }
    }
  }
  return arr.map((item) => {
    if (typeof item === 'string') return { name: item, isDir: true }
    const additional = item?.additional ?? {}
    const name = String(item?.name ?? item?.filename ?? item?.path ?? '')
    let isDir = item?.is_dir ?? item?.isDir ?? item?.isdir
    if (isDir === undefined && item?.type !== undefined) isDir = ['dir', 'directory', 'folder'].includes(String(item.type).toLowerCase())
    if (isDir === undefined && additional?.type !== undefined) isDir = ['dir', 'directory', 'folder'].includes(String(additional.type).toLowerCase())
    if (isDir === undefined) isDir = item?.size === undefined && !name.includes('.')
    return {
      name,
      isDir: allDirs ? true : Boolean(isDir),
      size: item?.size ?? item?.sizeBytes ?? (additional?.size >= 0 ? additional.size : undefined),
      mtime: item?.mtime ?? item?.modified ?? item?.lastModified ?? item?.time ?? additional?.time?.mtime,
    }
  }).filter((entry) => entry.name).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name))
}

function normalizeSearchResults(raw) {
  let arr = []
  if (Array.isArray(raw)) arr = raw
  else if (raw && typeof raw === 'object') {
    for (const key of ['results', 'files', 'items', 'matches', 'list']) {
      if (Array.isArray(raw[key])) { arr = raw[key]; break }
    }
  }
  return arr.map((item) => {
    if (typeof item === 'string') return { path: item, isDir: false }
    const path = String(item?.path ?? item?.name ?? '')
    let isDir = item?.is_dir ?? item?.isDir
    if (isDir === undefined) isDir = item?.size === undefined && !path.split('/').pop().includes('.')
    return { path, isDir: Boolean(isDir) }
  }).filter((item) => item.path)
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(rqI18n.t('读取本地文件失败')))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

function healthCell(health) {
  const status = health?.status ?? 'unknown'
  const latency = health?.latencyMs >= 0 && health?.latencyMs ? ` ${health.latencyMs}ms` : ''
  return `${statusBadge(status)}${latency ? `<span class="fs-11 text-4" style="margin-left:4px">${latency}</span>` : ''}`
}

function healthText(status) {
  return { healthy: '健康', degraded: '降级', down: '不可用', unknown: '未知' }[status] ?? status
}

function dataClassLabel(cls) {
  return { public: '公开', internal: '内部', confidential: '机密', secret: '绝密' }[cls] ?? (cls ?? '—')
}

function fmtBytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB'
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KB'
  return n + ' B'
}

function fmtEntryTime(value) {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'number') return fmtTime(new Date(value > 1e12 ? value : value * 1000).toISOString())
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? String(value) : fmtTime(new Date(parsed).toISOString())
}

function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}
