/** Agent 本体：列表（卡片/表格双视图）+ 详情（概览/配置/权限/监控/审计/生命周期）。 */
import { api, session } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog, copyText,
  renderTable, statusBadge, collectForm, field, inputField, selectField, textareaField,
  fmtNum, fmtPct, timeAgo, emptyState, sparkline, lineChart, maybeShowConceptCard,
  searchableSelectField, multiSelectField, mountSearchableSelects,
} from '../ui.js'
import { buildAgentOnboardingText, openOnboardingModal } from '../onboarding.js'
import { ASSET_CATEGORIES, assetCategory } from '../taxonomy.js'

/** 平台授权直达：签发一次性入场票据后带 #entry_ticket 同窗口整页跳转交互界面
 *  （裸跳转已下线；弹窗子窗口已消灭——dsh 挂载形态下落到 /rq/panel/ 或目标页完整页面，§6）。 */
export async function openAgentEntry(agent) {
  try {
    const issued = await api.post(`/api/agents/${agent.id}/entry-ticket`)
    location.assign(`${agent.attrs['entryUrl']}#entry_ticket=${encodeURIComponent(issued.ticket)}`)
  } catch (error) { toast(error.message, 'error') }
}

export async function renderAgents(content, params, ctx) {
  const data = await api.get('/api/agents')
  const agents = data.agents
  const schema = data.schema
  let view = 'card'

  // 首次访问概念卡（易用性整改：Agent 术语对业务成员有门槛）
  maybeShowConceptCard(content, 'agents', {
    icon: 'bot',
    title: 'Agent 是什么？',
    subtitle: 'Agent = 能替人执行任务的智能助手，注册后即拥有平台身份。',
    points: [
      '注册即纳管：平台颁发唯一 ID 与机器凭证，权限边界清晰。',
      '上线要审批：上线走审批流，下线自动吊销凭证并通知绑定用户。',
      '全程可追溯：每个 Agent 的调用、成本、审计都能穿透到人。',
    ],
  })

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">AGENT FLEET</div>
        <div class="page-title">Agent 本体</div>
        <div class="page-sub">注册即纳管：颁发唯一 ID 与机器身份凭证；上线走审批，下线联动吊销凭证并通知绑定用户。</div>
      </div>
      <div class="page-actions">
        <div class="segmented" id="agent-view">
          <span class="segmented-item active" data-v="card">${icon('app', 14)}卡片</span>
          <span class="segmented-item" data-v="table">${icon('scroll', 14)}表格</span>
        </div>
        ${session.can('agent.write') ? `<button class="btn btn-primary" id="agent-add">${icon('plus', 14)}注册 Agent</button>` : ''}
      </div>
    </div>
    <div class="filter-bar">
      <div class="search-input">${icon('search')}<input class="input" id="agent-q" placeholder="搜索名称 / 标识"></div>
      <div class="chips" id="agent-status">
        <span class="chip active" data-s="">全部</span>
        <span class="chip" data-s="online">已上线</span>
        <span class="chip" data-s="trial">试运行</span>
        <span class="chip" data-s="draft">开发中</span>
        <span class="chip" data-s="offline">已下线</span>
      </div>
      <span class="fs-12 text-3" style="margin-left:auto" id="agent-count"></span>
    </div>
    <div class="filter-bar" style="margin-top:-10px">
      <div class="chips" id="agent-cats">
        <span class="chip active" data-c="">全部</span>
        ${ASSET_CATEGORIES.map((cat) => `<span class="chip" data-c="${cat}">${cat}</span>`).join('')}
      </div>
    </div>
    <div id="agent-list"></div>`

  let filter = { q: '', status: '', category: '' }

  const refresh = () => {
    const list = agents.filter((a) => {
      if (filter.status && a.status !== filter.status) return false
      // 分类统一口径：attrs.category 缺失/非标准值的存量按「其他」归拢
      if (filter.category && assetCategory(a.attrs) !== filter.category) return false
      if (filter.q && !`${a.name}${a.slug}`.toLowerCase().includes(filter.q.toLowerCase())) return false
      return true
    })
    $('#agent-count').textContent = rqI18n.t('共 {n} 个 Agent', { n: list.length })
    const holder = $('#agent-list')
    holder.innerHTML = ''
    if (!list.length) {
      holder.appendChild(emptyState({ title: '没有匹配的 Agent', desc: '调整筛选条件，或注册你的第一个 Agent', ...(session.can('agent.write') ? { actionText: '注册 Agent', onAction: () => $('#agent-add').click() } : {}), icon: 'bot' }))
      return
    }
    if (view === 'card') {
      const grid = h('<div class="card-grid"></div>')
      for (const agent of list) {
        const card = h(`
          <div class="res-card" data-id="${esc(agent.id)}">
            <div class="res-card-top">
              <div class="res-icon" style="background:var(--purple-bg);font-size:22px">${esc(agent.attrs['avatar'] ?? '🤖')}</div>
              <div class="grow">
                <div class="res-name">${esc(agent.name)} ${statusBadge(agent.status)}</div>
                <div class="res-slug">${esc(agent.slug)}</div>
              </div>
            </div>
            <div class="res-desc">${esc(agent.attrs['description'] ?? '')}</div>
            <div class="flex" style="gap:6px;flex-wrap:wrap">
              <span class="badge badge-brand no-dot">${esc(assetCategory(agent.attrs))}</span>
              <span class="badge badge-brand no-dot mono">${esc(agent.attrs['model'] ?? '—')}</span>
              ${Array.isArray(agent.attrs['skills']) && agent.attrs['skills'].length ? `<span class="badge badge-muted no-dot">${esc(rqI18n.t('{n} 个 Skill', { n: agent.attrs['skills'].length }))}</span>` : ''}
              ${agent.boundUserCount ? `<span class="badge badge-muted no-dot">${esc(rqI18n.t('{n} 绑定用户', { n: agent.boundUserCount }))}</span>` : ''}
            </div>
            <div class="res-foot">
              <span class="metric">${icon('activity', 13)}${esc(rqI18n.t('{n} 调用', { n: fmtNum(agent.metrics.calls) }))}</span>
              <span class="metric">${icon('check', 13)}${fmtPct(agent.metrics.successRate)}</span>
              ${agent.attrs['entryUrl'] ? `<a class="btn btn-ghost btn-sm" data-entry href="javascript:void(0)">${icon('external', 13)}交互界面</a>` : ''}
              <span style="margin-left:auto" class="text-4">${esc(agent.attrs['ownerName'] ?? '')}</span>
            </div>
          </div>`)
        const entryBtn = card.querySelector('[data-entry]')
        if (entryBtn) entryBtn.onclick = (e) => { e.stopPropagation(); void openAgentEntry(agent) }
        card.onclick = () => openAgentDetail(agent.id, ctx)
        grid.appendChild(card)
      }
      holder.appendChild(grid)
    } else {
      const table = renderTable({
        columns: [
          {
            title: 'Agent', width: '24%',
            render: (a) => `<div class="flex" style="gap:10px"><span style="font-size:18px">${esc(a.attrs['avatar'] ?? '🤖')}</span><div><div class="col-strong">${esc(a.name)}</div><div class="col-sub mono">${esc(a.slug)}</div></div></div>`,
          },
          { title: '状态', width: 90, render: (a) => statusBadge(a.status) },
          { title: '业务分类', width: 80, render: (a) => `<span class="fs-12">${esc(assetCategory(a.attrs))}</span>` },
          { title: '模型', render: (a) => `<span class="mono fs-12">${esc(a.attrs['model'] ?? '—')}</span>` },
          { title: '负责人', render: (a) => esc(a.attrs['ownerName'] ?? '—') },
          { title: '调用', width: 90, render: (a) => `<span class="col-num">${fmtNum(a.metrics.calls)}</span>` },
          { title: '成功率', width: 90, render: (a) => `<span class="col-num">${fmtPct(a.metrics.successRate)}</span>` },
          { title: 'Token', width: 90, render: (a) => `<span class="col-num">${fmtNum(a.metrics.tokens)}</span>` },
          { title: '数据密级', width: 90, render: (a) => `<span class="fs-12">${dataClassLabel(a.attrs['dataClass'])}</span>` },
        ],
        rows: list,
        onRowClick: (id) => openAgentDetail(id, ctx),
      })
      holder.appendChild(table)
    }
  }

  $$('#agent-view .segmented-item').forEach((el) => {
    el.onclick = () => {
      $$('#agent-view .segmented-item').forEach((i) => i.classList.remove('active'))
      el.classList.add('active')
      view = el.dataset.v
      refresh()
    }
  })
  $('#agent-q').oninput = debounce(() => { filter.q = $('#agent-q').value.trim(); refresh() }, 250)
  $$('#agent-status .chip').forEach((chip) => {
    chip.onclick = () => {
      $$('#agent-status .chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      filter.status = chip.dataset.s
      refresh()
    }
  })
  $$('#agent-cats .chip').forEach((chip) => {
    chip.onclick = () => {
      $$('#agent-cats .chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      filter.category = chip.dataset.c
      refresh()
    }
  })
  const addBtn = $('#agent-add')
  if (addBtn) addBtn.onclick = () => openAgentCreate(schema, ctx)
  refresh()
  if (params.get('action') === 'create' && session.can('agent.write')) openAgentCreate(schema, ctx)
  if (params.get('focus')) void openAgentDetail(params.get('focus'), ctx)
}

async function openAgentDetail(id, ctx) {
  const agent = await api.get(`/api/agents/${id}`)
  const drawer = openDrawer({
    title: `${agent.attrs['avatar'] ?? '🤖'} ${agent.name}`,
    sub: `${agent.slug} · ${agent.attrs['ownerName'] ?? ''} · ${agent.attrs['model'] ?? ''}`,
    wide: true,
    body: `
      <div class="flex mb-14" style="gap:8px;flex-wrap:wrap">
        ${statusBadge(agent.status)}
        <span class="badge ${riskClass(agent.attrs['riskLevel'])} no-dot">${esc(rqI18n.t('风险：{level}', { level: rqI18n.t(riskLabel(agent.attrs['riskLevel'])) }))}</span>
        <span class="badge badge-info no-dot">${esc(rqI18n.t('密级：{level}', { level: rqI18n.t(dataClassLabel(agent.attrs['dataClass'])) }))}</span>
        ${agent.attrs['env'] ? `<span class="badge badge-muted no-dot">${esc(rqI18n.t('环境：{env}', { env: rqI18n.t(envLabel(agent.attrs['env'])) }))}</span>` : ''}
      </div>

      <div class="stat-grid mb-20" style="grid-template-columns:repeat(4,1fr)">
        ${miniStat('activity', '累计调用', fmtNum(agent.metrics.calls))}
        ${miniStat('check', '成功率', fmtPct(agent.metrics.successRate))}
        ${miniStat('coins', 'Token 消耗', fmtNum(agent.metrics.tokens))}
        ${miniStat('clock', '平均响应', agent.metrics.avgLatencyMs + 'ms')}
      </div>

      <div class="tabs" id="ag-tabs">
        <div class="tab active" data-tab="overview">概览</div>
        <div class="tab" data-tab="monitor">监控</div>
        <div class="tab" data-tab="access">权限与绑定</div>
        <div class="tab" data-tab="resources">资源授权</div>
        <div class="tab" data-tab="mcp-cap">${icon('plug', 13)} 可调用 MCP 能力</div>
        <div class="tab" data-tab="sso">${icon('key', 13)} SSO 配置</div>
        <div class="tab" data-tab="deps">依赖拓扑</div>
        <div class="tab" data-tab="audit">审计</div>
        <div class="tab" data-tab="lifecycle">生命周期</div>
      </div>
      <div id="ag-tab-body"></div>`,
    foot: footForStatus(agent, ctx),
  })

  const tabBody = drawer.body.querySelector('#ag-tab-body')
  const renderTab = (tab) => {
    if (tab === 'overview') {
      tabBody.innerHTML = `
        <div class="muted-box mb-14">${esc(agent.attrs['description'] ?? '')}</div>
        <div class="desc-grid">
          <div class="desc-item"><span class="k">Agent ID</span><span class="v mono">${esc(agent.id)}</span></div>
          <div class="desc-item"><span class="k">底层模型</span><span class="v">${esc(agent.attrs['model'] ?? '—')}</span></div>
          <div class="desc-item"><span class="k">交互界面</span><span class="v">${agent.attrs['entryUrl']
            ? `<button class="btn btn-default btn-sm" id="ag-open-entry">${icon('external', 13)}带平台身份打开</button>`
            : agent.attrs['headless'] === true
              ? '<span class="text-4">纯后台执行（headless 已声明，无交互界面）</span>'
              : '<span class="text-4">未提报（接入后由 Agent 凭自身凭证 PATCH attrs.entryUrl）</span>'}</span></div>
          <div class="desc-item"><span class="k">机器凭证</span><span class="v">${agent.credential ? `<span class="badge badge-ok no-dot">已颁发</span> <span class="mono fs-12">${esc(agent.credential.clientId)}</span>` : '<span class="text-4">未颁发</span>'}</span></div>
          <div class="desc-item"><span class="k">创建时间</span><span class="v">${timeAgo(agent.createdAt)}</span></div>
          <div class="desc-item"><span class="k">最近活跃</span><span class="v">${agent.metrics.lastActiveAt ? timeAgo(agent.metrics.lastActiveAt) : '—'}</span></div>
        </div>
        ${agent.credential ? `
          <div class="card-title mt-14 mb-8">凭证状态</div>
          <div class="desc-grid">
            <div class="desc-item"><span class="k">状态</span><span class="v">${agent.credential.status === 'active' ? '正常' : '已禁用'}</span></div>
            <div class="desc-item"><span class="k">活跃令牌</span><span class="v">${esc(rqI18n.t('{n} 个', { n: agent.credential.activeTokens }))}</span></div>
          </div>
          <div class="flex mt-14">
            <button class="btn btn-default btn-sm" id="ag-obo">${icon('fingerprint', 13)}签发 on-behalf-of 令牌</button>
          </div>` : ''}`
      const oboBtn = tabBody.querySelector('#ag-obo')
      if (oboBtn) oboBtn.onclick = async () => {
        try {
          const result = await api.post(`/api/agents/${agent.id}/obo-token`)
          const modal = openModal({
            title: '身份透传令牌（on-behalf-of）',
            body: `
              <div class="form-hint" style="margin-bottom:10px">该令牌携带完整 act 链：用户 → Agent。下游 MCP 可识别真实操作人，审计可还原完整链路。令牌仅本次完整展示，请立即复制保存。</div>
              <div class="code-block" style="white-space:pre-wrap;word-break:break-all">${esc(rqI18n.t('act 链: {chain}', { chain: result.actChain.map((a) => `${a.name}(${a.type})`).join(' → ') }))}

token:    ${esc(result.token)}</div>`,
            foot: `<button class="btn btn-default" id="obo-copy">${icon('copy', 13)}复制完整令牌</button><button class="btn btn-primary" data-ok>关闭</button>`,
          })
          modal.el.querySelector('#obo-copy').onclick = () => void copyText(result.token)
        } catch (error) { toast(error.message, 'error') }
      }
      const openEntryBtn = tabBody.querySelector('#ag-open-entry')
      if (openEntryBtn) openEntryBtn.onclick = () => void openAgentEntry(agent)
    }
    if (tab === 'monitor') {
      tabBody.innerHTML = `
        <div class="card card-pad mb-14">
          <div class="card-title mb-8">运营数据（Agent 提报口径 · 接入义务）</div>
          <div class="stat-grid mb-8" style="grid-template-columns:repeat(3,1fr)">
            ${miniStat('users', '今日 DAU', fmtNum(agent.metrics.dau ?? 0))}
            ${miniStat('users', '今日对话用户（去重）', fmtNum(agent.metrics.uniqueUsers ?? 0))}
            ${miniStat('activity', '累计对话会话', fmtNum(agent.metrics.sessions))}
          </div>
          <div class="form-hint">由 Agent 每日主动提报（POST /api/agents/:id/metrics-report）；未提报即为本页空缺，可在审计中按 agent.metrics.report 追溯提报记录。</div>
        </div>
        <div class="card card-pad mb-14">
          <div class="card-title mb-8">近 14 天调用量（网关自动归集口径）</div>
          ${lineChart([agent.metrics.series.map((s) => s.calls)], { width: 640, height: 150 })}
        </div>
        <div class="card card-pad">
          <div class="card-title mb-8">近 14 天 Token 消耗</div>
          ${barChartSafe(agent.metrics.series.map((s) => ({ label: s.date, value: s.tokens })), 640, 150)}
        </div>`
    }
    if (tab === 'resources') {
      tabBody.innerHTML = '<div class="text-4 fs-12">加载中…</div>'
      void (async () => {
        const [pgData, svcData] = await Promise.all([
          api.get('/api/mcp/perm-groups').catch(() => ({ groups: [] })),
          api.get('/api/mcp/services').catch(() => ({ services: [] })),
        ])
        const svcName = new Map((svcData.services ?? []).map((s) => [s.id, s.name]))
        const granted = (pgData.groups ?? []).filter((g) => (g.subjects ?? []).some((s) => s.type === 'agent' && s.id === agent.id))
        tabBody.innerHTML = granted.length ? `
          <div class="card-title mb-8">MCP 资源授权（Agent 视角反查）</div>
          ${granted.map((g) => `
            <div class="card card-pad mb-10">
              <div class="flex"><b class="fs-13">${esc(g.name)}</b><span class="fs-12 text-4" style="margin-left:auto">${esc(g.description ?? '')}</span></div>
              ${Object.entries(g.policies ?? {}).map(([sid, p]) => `
                <div class="flex fs-12" style="padding:6px 0;border-bottom:1px solid var(--border)">
                  <span class="mono">${esc(svcName.get(sid) ?? sid)}</span>
                  <span class="badge badge-muted no-dot" style="margin-left:auto">${p.allowedTools === '*' ? esc(rqI18n.t('全部工具')) : esc(rqI18n.t('{n} 个工具', { n: (p.allowedTools ?? []).length }))}</span>
                  ${p.constraints?.readOnly ? '<span class="badge badge-info no-dot">只读</span>' : ''}
                </div>`).join('')}
            </div>`).join('')}
          <div class="form-hint mt-8">授权关系在「MCP 服务 → 权限组 → 绑定主体」中维护；MCP 网关强制校验，未授权服务的调用直接拒绝并在审计留痕。</div>
        ` : `
          <div class="muted-box mb-14" style="display:flex;gap:8px">${icon('info', 15)}<span>该 Agent 尚未被任何 MCP 权限组授权——网关将拒绝其全部 MCP 调用。</span></div>
          <div class="form-hint">前往「MCP 服务 → 权限组 → 绑定主体」勾选本 Agent，即可按服务/工具粒度授予访问范围（支持只读约束）。</div>
        `
      })()
    }
    if (tab === 'mcp-cap') renderMcpCapabilityTab(tabBody, agent)
    if (tab === 'access') {
      tabBody.innerHTML = `
        <div class="card-title mb-8">${esc(rqI18n.t('绑定用户（{n}）', { n: agent.boundUsers.length }))}<span class="fs-12 text-3" style="font-weight:400;margin-left:8px">记录"哪些用户可使用该 Agent"，使用即授权留痕</span></div>
        <div class="mb-14">
          ${agent.boundUsers.map((b) => `
            <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border)">
              <div class="avatar sm">${esc(b.userName.slice(0, 1))}</div>
              <span class="fs-13 grow">${esc(b.userName)}</span>
              <span class="fs-11 text-4">${esc(rqI18n.t('{time} 由 {name} 绑定', { time: timeAgo(b.boundAt), name: b.boundBy }))}</span>
              <button class="btn btn-ghost btn-sm stop" data-unbind="${esc(b.userId)}" style="color:var(--danger)">${icon('x', 12)}</button>
            </div>`).join('') || '<span class="text-4 fs-12">暂无绑定用户</span>'}
        </div>
        <button class="btn btn-default btn-sm" id="ag-bind">${icon('plus', 13)}绑定用户</button>`
      tabBody.querySelectorAll('[data-unbind]').forEach((btn) => {
        btn.onclick = async () => {
          await api.delete(`/api/agents/${agent.id}/bindings/${btn.dataset.unbind}`)
          toast(rqI18n.t('已解绑')); drawer.close(); void openAgentDetail(id, ctx)
        }
      })
      tabBody.querySelector('#ag-bind').onclick = async () => {
        const users = await api.get('/api/iam/users')
        const activeUsers = users.users.filter((u) => u.status === 'active')
        const modal = openModal({
          title: '绑定用户',
          body: field('选择用户', searchableSelectField('userId', activeUsers.map((u) => ({ value: u.id, label: rqI18n.t('{name}（{org}）', { name: u.displayName, org: u.orgName ?? '—' }) })), { placeholder: '点击选择，支持搜索姓名/组织' }), { required: true }),
          foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>绑定</button>',
        })
        mountSearchableSelects(modal.el)
        modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
        modal.el.querySelector('[data-ok]').onclick = async () => {
          try {
            await api.post(`/api/agents/${agent.id}/bindings`, { userId: collectForm(modal.body).userId })
            toast(rqI18n.t('绑定成功（授权已留痕）')); modal.close(); drawer.close(); void openAgentDetail(id, ctx)
          } catch (error) { toast(error.message, 'error') }
        }
      }
    }
    if (tab === 'sso') renderAgentSsoTab(tabBody, agent, ctx, () => openAgentDetail(id, ctx))
    if (tab === 'deps') {
      const topo = agent.topology
      tabBody.innerHTML = `
        <div class="card card-pad">
          <div class="card-title mb-8">${icon('gitBranch', 14)} 依赖拓扑（Agent → Skill）</div>
          ${renderTopologyList(topo)}
          <div class="form-hint mt-8">异常节点标红；由资源依赖图实时计算</div>
        </div>
        ${agent.impact.length ? `
          <div class="card card-pad mt-14" style="border-color:var(--warn-border);background:var(--warn-bg)">
            <div class="card-title mb-8">${icon('alert', 14)} 影响面（若下线）</div>
            ${agent.impact.map((i) => `<div class="fs-13" style="padding:3px 0">${esc(rqI18n.t('· {name}（{type}）', { name: i.name, type: rqI18n.t(typeLabel(i.type)) }))}</div>`).join('')}
          </div>` : ''}`
    }
    if (tab === 'audit') {
      tabBody.innerHTML = agent.audit.length ? `
        <div class="timeline">
          ${agent.audit.slice(0, 12).map((log) => `
            <div class="timeline-item">
              <div class="timeline-dot"></div>
              <div class="timeline-title">${esc(log.action)} ${log.result !== 'ok' ? statusBadge(log.result === 'denied' ? 'denied' : 'error') : ''}</div>
              <div class="timeline-time">${timeAgo(log.createdAt)} · ${esc(log.actorName)}</div>
              ${log.detail ? `<div class="timeline-body">${esc(log.detail)}</div>` : ''}
            </div>`).join('')}
        </div>` : '<span class="text-4 fs-12">暂无审计记录</span>'
    }
    if (tab === 'lifecycle') {
      tabBody.innerHTML = `
        <div class="timeline">
          ${agent.lifecycleHistory.map((entry, index) => `
            <div class="timeline-item ${index === agent.lifecycleHistory.length - 1 ? 'current' : 'ok'}">
              <div class="timeline-dot"></div>
              <div class="timeline-title">${esc(rqI18n.t('{action} → {state}', { action: entry.action === 'create' ? rqI18n.t('注册创建') : rqI18n.t(actionLabel(entry.action)), state: rqI18n.t(stateLabel(entry.to)) }))}</div>
              <div class="timeline-time">${esc(rqI18n.t('{time} · 操作人 {name}', { time: timeAgo(entry.at), name: entry.actor }))}</div>
              ${entry.note ? `<div class="timeline-body">${esc(entry.note)}</div>` : ''}
            </div>`).join('')}
        </div>
        <div class="muted-box mt-14" style="display:flex;gap:8px">
          ${icon('info', 15)}<span>状态机：开发 → 试运行（限定用户组）→ 上线 → 下线 → 归档。上线/下线为 L4 高危操作，强制审批。</span>
        </div>`
    }
  }
  drawer.body.querySelectorAll('#ag-tabs .tab').forEach((el) => {
    el.onclick = () => {
      drawer.body.querySelectorAll('#ag-tabs .tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })
  renderTab('overview')

  // 生命周期操作按钮
  for (const transition of agent.availableTransitions) {
    const btn = drawer.el.querySelector(`[data-action="${transition.action}"]`)
    if (!btn) continue
    btn.onclick = async () => {
      if (transition.action === 'online' || transition.action === 'offline') {
        const isOnline = transition.action === 'online'
        const result = await confirmDialog({
          title: isOnline ? 'Agent 上线（L4）' : 'Agent 下线（L4）',
          requireReason: !isOnline,
          danger: !isOnline,
          confirmText: '提交审批',
          message: isOnline
            ? rqI18n.t('上线 <b>{name}</b> 将生成审批单，有审批权限的管理员通过后自动执行。', { name: esc(agent.name) })
            : rqI18n.t('下线 <b>{name}</b> 后：机器凭证立即吊销、{n} 名绑定用户收到通知、审计数据保留。', { name: esc(agent.name), n: agent.boundUsers.length }),
        })
        if (!result) return
        try {
          const response = await api.post(`/api/agents/${agent.id}/transition`, {
            action: transition.action, note: result.reason ?? '上线申请',
          })
          toast(rqI18n.t('已创建审批单（审批通过后自动执行）'))
          drawer.close(); ctx.rerender()
          void response
        } catch (error) { toast(error.message, 'error') }
      } else {
        try {
          if (transition.action === 'submit_trial') {
            const groupsData = await api.get('/api/iam/groups').catch(() => ({ groups: [] }))
            const groupOptions = [...new Map((groupsData.groups ?? []).map((g) => [g.name, g])).values()]
              .map((g) => ({ value: g.name, label: g.name }))
            const modal = openModal({
              title: '进入试运行',
              body: field('试运行用户组', groupOptions.length
                ? searchableSelectField('groups', groupOptions, { placeholder: '点击选择用户组，支持搜索' })
                : inputField('groups', { placeholder: '用户组名称（当前无可选用户组，可手填）' }), { required: true, hint: '试运行期间仅该用户组成员可用' }),
              foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>确认</button>',
            })
            mountSearchableSelects(modal.el)
            modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
            modal.el.querySelector('[data-ok]').onclick = async () => {
              const groupName = collectForm(modal.body).groups
              if (!groupName) return toast(rqI18n.t('请选择试运行用户组'), 'error')
              const group = groupOptions.find((g) => g.value === groupName)
              await api.patch(`/api/agents/${agent.id}`, { attrs: { trialGroups: [group ? group.value : groupName] } })
              await api.post(`/api/agents/${agent.id}/transition`, { action: 'submit_trial' })
              toast(rqI18n.t('已进入试运行')); modal.close(); drawer.close(); ctx.rerender()
            }
            return
          }
          await api.post(`/api/agents/${agent.id}/transition`, { action: transition.action })
          toast(rqI18n.t('状态已更新')); drawer.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    }
  }

  const onboardBtn = drawer.el.querySelector('#ag-onboard')
  if (onboardBtn) onboardBtn.onclick = () => openAgentOnboardPrompt(agent)

  const deleteBtn = drawer.el.querySelector('#ag-delete')
  if (deleteBtn) deleteBtn.onclick = async () => {
    const result = await confirmDialog({
      title: rqI18n.t('删除 Agent · {name}', { name: agent.name }), requireReason: true, danger: true, confirmText: '确认删除',
      message: rqI18n.t('将永久删除 <b>{name}</b>：解绑全部绑定用户、吊销机器凭证、清理依赖关系，操作不可恢复；用量与审计数据保留。', { name: esc(agent.name) }),
    })
    if (!result) return
    try {
      await api.delete(`/api/agents/${agent.id}`)
      toast(rqI18n.t('已删除')); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
}

function footForStatus(agent, ctx) {
  const buttons = agent.availableTransitions.map((t) => {
    const isL4 = t.action === 'online' || t.action === 'offline'
    return `<button class="btn ${isL4 ? 'btn-primary' : 'btn-default'}" data-action="${esc(t.action)}">${icon(t.action === 'online' ? 'play' : t.action === 'offline' ? 'alert' : 'chevronRight', 14)}${esc(t.label)}</button>`
  }).join('')
  const deleteBtn = ['draft', 'archived'].includes(agent.status)
    ? `<button class="btn btn-danger-ghost" id="ag-delete">${icon('trash', 14)}删除</button>` : ''
  const onboardBtn = `<button class="btn btn-default" id="ag-onboard">${icon('book', 14)}生成接入提示词</button>`
  return buttons + onboardBtn + deleteBtn || '<button class="btn btn-default" disabled>终态（已归档）</button>'
}

/** 生成 Agent 接入提示词：注册同款模板由平台侧生成；可选轮换机器凭证（旧 secret 失效）以携带完整凭证。与 app 同构。 */
function openAgentOnboardPrompt(agent) {
  const modal = openModal({
    title: rqI18n.t('生成接入提示词 · {name}', { name: agent.name }),
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px;line-height:1.8">${icon('info', 15)}<span>按<b>注册同款模板</b>生成全文（换牌 → 运营数据提报 → 计量 → NAS 数据权限 → 服务级 MCP 数据面）。<br>
      <b>重新生成密钥并生成</b>：提示词携带完整 client_secret，<b>旧 secret 立即失效</b>——首次接入或密钥丢失时选这个；<br>
      <b>仅生成（不轮换）</b>：仅含 client_id，secret 部分为占位。</span></div>`,
    foot: `
      <button class="btn btn-default" data-cancel>取消</button>
      <button class="btn btn-default" data-plain>仅生成（不轮换）</button>
      <button class="btn btn-primary" data-rotate>重新生成密钥并生成</button>`,
  })
  const generate = async (rotate) => {
    try {
      const result = await api.post(`/api/agents/${agent.id}/onboarding-prompt`, { rotate })
      modal.close()
      openOnboardingModal({
        title: rqI18n.t('接入提示词 · {name}{suffix}', { name: agent.name, suffix: rotate ? rqI18n.t('（密钥已重新生成）') : '' }),
        resourceLabel: 'Agent',
        resource: agent,
        credential: result.credential,
        metaRows: [
          ['Agent ID', agent.id],
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

async function openAgentCreate(schema, ctx) {
  // 绑定类资源下拉数据源：拉取失败或为空时退回手填，不阻塞注册
  const [skillData, pgData, groupsData, modelData] = await Promise.all([
    api.get('/api/skills').catch(() => ({ skills: [] })),
    api.get('/api/mcp/perm-groups').catch(() => ({ groups: [] })),
    api.get('/api/iam/groups').catch(() => ({ groups: [] })),
    // 模型目录（issue #8 单一事实源）：可选项 = 目录登记的模型；online 在前，offline 标注状态
    api.get('/api/modelgw/models').catch(() => ({ models: [] })),
  ])
  const allModels = (modelData.models ?? []).map((m) => ({ value: m.slug, label: m.status === 'online' ? `${m.displayName}（${m.slug}）` : `${m.displayName}（${m.slug} · 未上线）` }))
  const resourceOptions = {
    skills: (skillData.skills ?? []).filter((s) => s.status === 'published')
      .map((s) => ({ value: s.slug, label: `${s.name}（${s.slug}）` })),
    mcpPermGroupIds: (pgData.groups ?? []).map((g) => ({ value: g.id, label: g.name })),
    trialGroups: [...new Map((groupsData.groups ?? []).map((g) => [g.name, g])).values()]
      .map((g) => ({ value: g.name, label: g.name })),
    model: [...allModels.filter((m) => !m.label.includes('未上线')), ...allModels.filter((m) => m.label.includes('未上线'))],
  }
  const groupsByField = new Map()
  for (const fieldSpec of schema.fields) {
    if (!groupsByField.has(fieldSpec.group)) groupsByField.set(fieldSpec.group, [])
    groupsByField.get(fieldSpec.group).push(fieldSpec)
  }
  const groupLabels = Object.fromEntries(schema.groups.map((g) => [g.key, g.label]))
  const modal = openModal({
    title: '注册 Agent', wide: true,
    body: `
      <div class="form-hint" style="margin-bottom:12px">渐进式表单：必填最小集即可创建草稿，其余可后续补全（上线前完成登记即可）。</div>
      <div class="form-grid">
        ${field('Agent 名称', inputField('name', { placeholder: '如：智能客服助手' }), { required: true })}
        ${field('唯一标识', inputField('slug', { placeholder: '小写字母与中划线，留空自动生成' }))}
      </div>
      ${[...groupsByField.entries()].map(([group, fields]) => `
        <div class="card-title mb-8" style="margin-top:6px">${esc(groupLabels[group] ?? group)}</div>
        <div class="form-grid">
          ${fields.map((f) => renderSchemaField(f)).join('')}
        </div>`).join('')}
      <div class="muted-box mt-8" style="display:flex;gap:8px">${icon('key', 15)}<span>注册成功后自动颁发机器身份凭证（Client Credentials），密钥仅展示一次。</span></div>`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>注册并颁发凭证</button>',
  })
  mountSearchableSelects(modal.el)
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async () => {
    const data = collectForm(modal.body)
    const attrs = {}
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('attr_') && value !== '') attrs[key.slice(5)] = value
      if (key.startsWith('tags_') && value) attrs[key.slice(5)] = value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    }
    try {
      const result = await api.post('/api/agents', { name: data.name, slug: data.slug || undefined, attrs })
      modal.close()
      if (result.credential) {
        openOnboardingModal({
          title: '注册成功 · 接入指引与机器凭证（仅此一次展示）',
          resourceLabel: 'Agent',
          resource: result.agent,
          credential: result.credential,
          metaRows: [
            ['Agent ID', result.agent.id],
            ['标识', result.agent.slug],
            ['client_id', result.credential.clientId],
            ['client_secret', result.credential.clientSecret],
          ],
          guideText: buildAgentOnboardingText(result.agent, result.credential),
        })
      } else {
        toast(rqI18n.t('注册成功'))
      }
      ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }

  function renderSchemaField(f) {
    const name = `attr_${f.key}`
    const tagsName = `tags_${f.key}`
    // 底层模型（issue #8 单一事实源）：选项来自模型目录；目录拉取失败/为空时退回手填 slug
    if (f.key === 'model') {
      const options = resourceOptions.model
      if (options?.length) {
        return field(f.label, selectField(name, options, { value: String(f.defaultValue ?? '') }), { required: f.required, hint: f.hint, full: false })
      }
      return field(f.label, inputField(name, { placeholder: f.placeholder || '模型目录中的 slug，如 deepseek-chat' }), { required: f.required, hint: f.hint })
    }
    if (f.type === 'boolean') {
      return field(f.label, `<label class="flex" style="gap:8px;font-size:13px;cursor:pointer;padding-top:6px"><input type="checkbox" name="${name}" ${f.defaultValue === true ? 'checked' : ''} style="accent-color:var(--brand-500)"><span>${esc(f.placeholder || rqI18n.t('是'))}</span></label>`, { required: f.required, hint: f.hint, full: false })
    }
    if (f.type === 'enum') {
      return field(f.label, selectField(name, (f.options ?? []).map((o) => ({ value: o.value, label: o.hint ? `${o.label}（${o.hint}）` : o.label })), { value: String(f.defaultValue ?? '') }), { required: f.required, hint: f.hint, full: false })
    }
    if (f.type === 'text') {
      return field(f.label, textareaField(name, { placeholder: f.placeholder, rows: 2 }), { required: f.required, hint: f.hint, full: true })
    }
    if (f.type === 'tags') {
      // 绑定类资源（skill / MCP 权限组 / 用户组）用多选搜索下拉；无可选项时退回手填
      const options = resourceOptions[f.key]
      if (options) {
        return field(f.label, options.length
          ? multiSelectField(tagsName, options, { placeholder: rqI18n.t('搜索并选择{label}，可多选', { label: f.label }) })
          : inputField(tagsName, { placeholder: '逗号分隔（平台暂无可选项，可手填）' }), { hint: f.hint, full: false })
      }
      return field(f.label, inputField(tagsName, { placeholder: '逗号分隔' }), { hint: f.hint, full: false })
    }
    const input = inputField(name, { placeholder: f.placeholder, value: String(f.defaultValue ?? '') })
    return field(f.label, input, { required: f.required, hint: f.hint })
  }
}

// ---------- shared helpers ----------
export function dataClassLabel(cls) {
  return { public: '公开', internal: '内部', confidential: '机密', secret: '绝密' }[cls] ?? (cls ?? '—')
}
export function riskClass(level) {
  return { low: 'badge-ok', medium: 'badge-warn', high: 'badge-danger' }[level] ?? 'badge-muted'
}
export function riskLabel(level) {
  return { low: '低', medium: '中', high: '高' }[level] ?? (level ?? '—')
}
export function envLabel(env) {
  return { sandbox: '平台沙箱', shared: '共享运行时', dedicated: '独占实例' }[env] ?? (env ?? '—')
}
export function typeLabel(type) {
  return { agent: 'Agent', app: '应用', skill: 'Skill', mcp_service: 'MCP' }[type] ?? type
}
export function stateLabel(state) {
  return { draft: '开发中', trial: '试运行', online: '已上线', offline: '已下线', archived: '已归档' }[state] ?? state
}
export function actionLabel(action) {
  return { submit_trial: '进入试运行', online: '上线', offline: '下线', retrial: '恢复试运行', archive: '归档' }[action] ?? action
}
export function miniStat(ic, label, value) {
  return `
    <div style="background:var(--surface-2);border-radius:10px;padding:12px 14px">
      <div style="color:var(--brand-500)">${icon(ic, 16)}</div>
      <div style="font-size:16px;font-weight:700;margin-top:6px">${value}</div>
      <div class="stat-label">${esc(label)}</div>
    </div>`
}
export function renderTopologyList(node) {
  return `
    <div class="flex" style="padding:8px 0">
      <span class="badge ${node.status === 'online' || node.status === 'published' ? 'badge-ok' : node.status === 'unhealthy' ? 'badge-danger' : 'badge-muted'} no-dot">${typeLabel(node.type)}</span>
      <span class="fs-13" style="font-weight:500">${esc(node.name)}</span>
      <span class="fs-12 text-3">${esc(node.statusLabel)}</span>
    </div>
    ${node.children.map((child) => `<div style="margin-left:22px;border-left:2px solid var(--border);padding-left:14px">${renderTopologyList(child)}</div>`).join('')}`
}
export function barChartSafe(items, width, height) {
  // 简单柱状（内联，避免循环依赖 ui.js 的命名冲突）
  if (!items?.length) return '<div class="text-4 fs-12">暂无数据</div>'
  const max = Math.max(...items.map((i) => i.value), 1)
  const gap = 6
  const barW = Math.max(4, (width - gap * (items.length - 1)) / items.length)
  const bars = items.map((item, i) => {
    const barH = Math.max(2, (item.value / max) * (height - 30))
    return `<rect x="${i * (barW + gap)}" y="${height - 20 - barH}" width="${barW}" height="${barH}" rx="3" fill="#8b5cf6" opacity="${0.5 + 0.5 * (item.value / max)}"><title>${esc(item.label)}: ${item.value}</title></rect>`
  }).join('')
  return `<svg width="100%" viewBox="0 0 ${width} ${height}">${bars}</svg>`
}
function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}

/** 「可调用 MCP 能力」tab（W3-T6 契约 §16 能力视图）：权限组反查 → 按服务聚合可调用工具面 + 最近拒绝原因。
 *  与「资源授权」tab 的差异：那边按权限组逐张卡片看授权关系；这边按服务聚合运行视角的可调用边界。 */
function renderMcpCapabilityTab(holder, agent) {
  holder.innerHTML = '<div class="text-4 fs-12">加载中…</div>'
  void (async () => {
    const [pgData, svcData, denied] = await Promise.all([
      api.get('/api/mcp/perm-groups').catch(() => ({ groups: [] })),
      api.get('/api/mcp/services').catch(() => ({ services: [] })),
      // 最近拒绝原因：调用台账按 callerId+status=denied 过滤（契约 callLog 既有参数能力）
      api.get('/api/mcp/calls' + api.qs({ callerId: agent.id, status: 'denied', limit: 3 })).catch(() => ({ items: [] })),
    ])
    const svcById = new Map((svcData.services ?? []).map((s) => [s.id, s]))
    const granted = (pgData.groups ?? []).filter((g) => (g.subjects ?? []).some((s) => s.type === 'agent' && s.id === agent.id))
    // 聚合：同一服务出现在多个权限组时并集展示（allowedTools '*' 直接吞并全部）
    const merged = new Map()
    for (const g of granted) {
      for (const [serviceId, policy] of Object.entries(g.policies ?? {})) {
        const entry = merged.get(serviceId) ?? { readOnly: true, tools: null, groups: [] }
        entry.groups.push(g.name)
        if (policy?.allowedTools === '*') entry.tools = null
        else if (entry.tools !== null) entry.tools = [...new Set([...(entry.tools ?? []), ...(policy?.allowedTools ?? [])])]
        if (!policy?.constraints?.readOnly) entry.readOnly = false
        merged.set(serviceId, entry)
      }
    }
    const rows = [...merged.entries()]
    holder.innerHTML = `
      <div class="card card-pad mb-14">
        <div class="card-title mb-8">${icon('plug', 14)} ${esc(rqI18n.t('可调用服务与工具（聚合 {n} 个服务）', { n: rows.length }))}</div>
        ${rows.length ? rows.map(([serviceId, entry]) => {
          const svc = svcById.get(serviceId)
          const toolBadges = entry.tools === null
            ? `<span class="badge badge-brand no-dot">${esc(rqI18n.t('全部工具'))}</span>`
            : (entry.tools ?? []).length
              ? (entry.tools ?? []).map((tool) => `<span class="badge badge-muted no-dot mono" style="margin:2px">${esc(tool)}</span>`).join('')
              : `<span class="text-4 fs-12">${esc(rqI18n.t('（空策略）'))}</span>`
          return `
            <div class="card card-pad mb-8" style="background:var(--surface-2)">
              <div class="flex" style="gap:8px;flex-wrap:wrap">
                <b class="fs-13">${esc(svc?.name ?? serviceId)}</b>
                ${svc ? statusBadge(svc.status) : ''}
                ${entry.readOnly ? `<span class="badge badge-info no-dot">${esc(rqI18n.t('只读'))}</span>` : ''}
                ${svc && svc.dataClass === 'confidential' ? `<span class="badge badge-danger no-dot">${esc(rqI18n.t('高敏'))}</span>` : ''}
                <span class="fs-12 text-3" style="margin-left:auto">${esc(rqI18n.t('来自：{groups}', { groups: entry.groups.join('、') }))}</span>
              </div>
              <div class="flex mt-8" style="gap:4px;flex-wrap:wrap">${toolBadges}</div>
            </div>`
        }).join('') : `
          <div class="muted-box mb-8" style="display:flex;gap:8px">${icon('info', 15)}<span>${esc(rqI18n.t('该 Agent 尚未被任何 MCP 权限组授权——服务级端点与网关都将拒绝其 MCP 调用。'))}</span></div>
          <div class="form-hint">${esc(rqI18n.t('前往「MCP 服务 → 权限组管理 → 绑定主体」勾选本 Agent 即可授予可调用面。'))}</div>`}
      </div>
      <div class="card card-pad">
        <div class="card-title mb-8">${icon('circleAlert', 14)} ${esc(rqI18n.t('最近拒绝原因（{n} 条）', { n: (denied.items ?? []).length }))}</div>
        ${(denied.items ?? []).length ? denied.items.map((call) => `
          <div class="flex" style="padding:6px 0;border-bottom:1px dashed var(--border);gap:8px">
            <span class="fs-12 text-3" style="min-width:88px">${esc(timeAgo(call.at))}</span>
            <span class="fs-13" style="min-width:130px">${esc(call.serviceName)}</span>
            <span class="mono fs-12">${esc(call.tool)}</span>
            <span class="fs-12" style="color:var(--danger);margin-left:auto;text-align:right">${esc(call.error ?? '')}</span>
          </div>`).join('') : `<div class="text-4 fs-12">${esc(rqI18n.t('暂无拒绝记录（或调用台账已滚动清理）。'))}</div>`}
        <div class="form-hint mt-8">${esc(rqI18n.t('拒绝同样落审计与调用台账；按原因处理（缺授权找管理员、受众不符重新换牌），不要变形重试。'))}</div>
      </div>`
  })()
}

/** SSO tab 公共交互接线：entryUrl 负责人侧登记（owner 免控制台直填）与 headless 声明/撤销。
 *  两分支（未签发 / 已签发客户端）共用——entryCard 两处都渲染，headlessCard 仅未签发分支渲染。 */
function wireAgentEntryAndHeadless(holder, agent, refresh) {
  const openBtn = holder.querySelector('#ag-sso-open')
  if (openBtn) openBtn.onclick = () => void openAgentEntry(agent)
  const entrySave = holder.querySelector('#ag-entry-save')
  if (entrySave) entrySave.onclick = async () => {
    const value = holder.querySelector('#ag-entry-input').value.trim()
    if (!/^https?:\/\//.test(value)) { toast(rqI18n.t('交互界面地址必须以 http:// 或 https:// 开头'), 'error'); return }
    try {
      await api.patch(`/api/agents/${agent.id}`, { attrs: { entryUrl: value } })
      toast(rqI18n.t('交互界面地址已登记，免登通道已启用'))
      refresh()
    } catch (error) { toast(error.message, 'error') }
  }
  const declare = holder.querySelector('#ag-headless-declare')
  if (declare) declare.onclick = async () => {
    try {
      await api.patch(`/api/agents/${agent.id}`, { attrs: { headless: true } })
      toast(rqI18n.t('已声明无交互界面（headless）：上线门禁凭机器凭证放行'))
      refresh()
    } catch (error) { toast(error.message, 'error') }
  }
  const revoke = holder.querySelector('#ag-headless-revoke')
  if (revoke) revoke.onclick = async () => {
    try {
      await api.patch(`/api/agents/${agent.id}`, { attrs: { headless: false } })
      toast(rqI18n.t('已撤销 headless 声明'))
      refresh()
    } catch (error) { toast(error.message, 'error') }
  }
}

/** Agent「SSO 配置」tab：OIDC 客户端管理（owner 自助）+ entry-ticket 平台直达 + headless 纯后台声明互补。
 *  门禁语义（AGENT_SSO_ENFORCE）：'1'=未纳管拒审（OIDC 客户端 / entryUrl / headless 三选一）；'oidc'=必须签发；'0'=关闭。 */
function renderAgentSsoTab(holder, agent, ctx, refresh) {
  const sso = agent.sso
  const mode = agent.ssoEnforceMode ?? '1'
  const modeBadge = mode === 'oidc'
    ? '<span class="badge badge-warn no-dot">门禁：必须签发 OIDC 客户端</span>'
    : mode === '1'
      ? '<span class="badge badge-muted no-dot">门禁：OIDC 客户端 / entryUrl / headless 三选一</span>'
      : ''
  const enforced = mode !== '0'
  const entryUrl = agent.attrs['entryUrl']
  const canWrite = session.can('agent.write')
  const entryCard = `
    <div class="card card-pad mt-14">
      <div class="flex-between mb-8">
        <div class="card-title">${icon('external', 14)} 平台授权直达（entry-ticket，零改造）</div>
        ${entryUrl ? '<span class="badge badge-ok no-dot">已启用</span>' : '<span class="badge badge-muted no-dot">未提报交互界面</span>'}
      </div>
      ${entryUrl ? `
        <div class="desc-grid mb-14">
          <div class="desc-item"><span class="k">交互界面</span><span class="v mono">${esc(entryUrl)}</span></div>
          <div class="desc-item"><span class="k">兑换端点</span><span class="v mono">POST /api/authn/entry-tickets/redeem</span></div>
          <div class="desc-item"><span class="k">票据时效</span><span class="v">一次性 · 短时（默认 120s，ENTRY_TICKET_TTL_SECONDS 可调）</span></div>
          <div class="desc-item"><span class="k">使用授权</span><span class="v">负责人 / 绑定用户 / 管理员（使用即授权留痕）</span></div>
        </div>
        <div class="flex" style="gap:8px">
          <button class="btn btn-primary" id="ag-sso-open">${icon('external', 14)}带平台身份打开交互界面</button>
        </div>
        <div class="form-hint mt-8">交互界面接入（前端三步）：① 控制台「带平台身份打开」→ 一次性票据以 <code class="mono">#entry_ticket=&lt;ticket&gt;</code> 片段跳转；② 界面读 URL fragment 调兑换端点；③ 响应返回平台身份 identity（sub / org / roles / tenant）。票据重放被拒、过期即焚、兑换实时校验账号状态（agent.entry.ticket.* 全程审计）。</div>`
        : canWrite ? `
        <div class="form-item">
          <label class="form-label">负责人直接登记（https:// 或内网 http:// 地址；登记后即满足上线门禁的免登通道）</label>
          <div class="flex" style="gap:8px">
            <input class="input" id="ag-entry-input" style="flex:1" placeholder="https://app.example.com/chat 或 http://192.168.0.7:3080/">
            <button class="btn btn-primary" id="ag-entry-save">${icon('check', 14)}登记</button>
          </div>
          <div class="form-hint mt-8">也可由 Agent 凭自身凭证提报：PATCH /api/agents/:id {"attrs":{"entryUrl":"https://…"}}。登记后控制台即可带平台身份直达。</div>
        </div>`
        : `<div class="form-hint">由 Agent 凭自身凭证提报：PATCH /api/agents/:id {"attrs":{"entryUrl":"https://…"}}。登记后控制台即可带平台身份直达。</div>`}
    </div>`
  const headless = agent.attrs['headless'] === true
  const headlessCard = `
    <div class="card card-pad mt-14">
      <div class="flex-between mb-8">
        <div class="card-title">${icon('bot', 14)} 无交互界面声明（headless · 纯后台）</div>
        ${headless ? '<span class="badge badge-ok no-dot">已声明</span>' : '<span class="badge badge-muted no-dot">未声明</span>'}
      </div>
      <div class="fs-13 text-2 mb-8" style="line-height:1.8">适合没有任何面向用户的交互界面、仅凭机器身份被平台调度与调用的执行体（Work Body、定时任务型等）：声明后上线门禁凭已颁发的机器凭证放行，无需签发 OIDC 客户端，也无需登记 entryUrl。</div>
      ${mode === 'oidc' ? `<div class="muted-box mb-8" style="font-size:12.5px">${icon('info', 14)} 当前门禁为 AGENT_SSO_ENFORCE=oidc 严格模式：headless 声明不作为放行依据，仍须签发 OIDC 客户端。</div>` : ''}
      ${!headless && !agent.credential ? `<div class="muted-box mb-8" style="font-size:12.5px;border-color:var(--warn-border);background:var(--warn-bg)">${icon('alert', 14)} 该 Agent 尚未颁发机器凭证：headless 声明放行前须先颁发凭证（无凭证放行等于无主体上线）。</div>` : ''}
      <div class="flex" style="gap:8px">
        ${headless
          ? `<button class="btn btn-default" id="ag-headless-revoke">${icon('x', 14)}撤销 headless 声明</button>`
          : `<button class="btn btn-default" id="ag-headless-declare">${icon('check', 14)}声明无交互界面（headless）</button>`}
      </div>
      <div class="form-hint mt-8">声明即写入 Agent 属性 attrs.headless，全程审计；上线审批（L4）照常执行，审批期间撤销声明将被执行期复核拦截。</div>
    </div>`
  if (!sso) {
    holder.innerHTML = `
      <div class="card card-pad">
        <div class="flex-between mb-8">
          <div class="card-title">${icon('key', 14)} Agent 身份纳管（SSO）</div>
          ${modeBadge}
        </div>
        <div class="fs-13 text-2 mb-8" style="line-height:1.9">
          身份纳管三选一（满足任一即可通过上线门禁；按 Agent 形态选择）：
          <div class="muted-box mt-8" style="font-size:12.5px;line-height:2">
            ① <b>登记交互界面地址 entryUrl</b>（免登通道，零改造）：有 Web 界面即可，免回调免协议改造——见下方「平台授权直达」卡；<br>
            ② <b>签发 OIDC 客户端</b>（标准协议）：交互界面按授权码模式接入平台统一账号与权限（/oauth/authorize 强制 PKCE S256 → code 换 id_token/access_token → userinfo 取身份）——需提供回调地址；<br>
            ③ <b>声明无交互界面 headless</b>（纯后台）：Work Body 等无任何界面的执行体，凭已颁发机器凭证放行——见下方声明卡。
          </div>
        </div>
        ${enforced ? `<div class="muted-box mb-14" style="display:flex;gap:8px;border-color:var(--warn-border);background:var(--warn-bg)">${icon('alert', 15)}<span><b>${esc(rqI18n.t('Agent 上线门禁'))}</b>${mode === 'oidc' ? esc(rqI18n.t('：未完成 SSO 签发前，上线审批将被拒绝。')) : esc(rqI18n.t('：既无 SSO 客户端、也未登记 entryUrl 或声明 headless 时，上线审批将被拒绝。'))}</span></div>` : ''}
        <button class="btn btn-primary" id="ag-sso-issue">${icon('key', 14)}签发 SSO 客户端</button>
        <div class="form-hint mt-8">本机联调免控制台：回调地址为环回（127.0.0.1 / localhost / 0.0.0.0）时，Agent 机器凭证可直接 <code class="mono">POST /api/agents/${esc(agent.id)}/sso-client</code> 自助签发（改回调 PATCH 同路径）。</div>
      </div>
      ${entryCard}
      ${headlessCard}`
    holder.querySelector('#ag-sso-issue').onclick = () => openAgentIssueSsoModal(agent, refresh)
    wireAgentEntryAndHeadless(holder, agent, refresh)
    return
  }
  const active = sso.status === 'active'
  holder.innerHTML = `
    <div class="card card-pad mb-14">
      <div class="flex-between mb-8">
        <div class="card-title">${icon('key', 14)} 已签发客户端 ${statusBadge(active ? 'active' : 'frozen', active ? '使用中' : '已禁用')}</div>
        <div class="flex" style="gap:8px;align-items:center">
          ${modeBadge}
          <span class="badge ${sso.clientType === 'public' ? 'badge-purple' : 'badge-info'} no-dot">${sso.clientType === 'public' ? 'public（免 secret · 强制 PKCE）' : 'confidential（带密钥）'}</span>
        </div>
      </div>
      <div class="desc-grid mb-14">
        <div class="desc-item"><span class="k">client_id</span><span class="v mono">${esc(sso.clientId)} <button class="btn btn-ghost btn-sm" id="ag-sso-copy-id">复制</button></span></div>
        <div class="desc-item"><span class="k">关联 Agent</span><span class="v">${esc(sso.refAgentName ?? agent.name)}</span></div>
        <div class="desc-item"><span class="k">签发时间</span><span class="v">${fmtTime(sso.createdAt)}</span></div>
      </div>
      <div class="form-item">
        <label class="form-label">回调地址（redirect_uris，每行一个；https://，或 http:// 内网/本机地址）</label>
        <textarea class="form-control mono" id="ag-sso-redirects" rows="2">${esc(sso.redirectUris.join('\n'))}</textarea>
      </div>
      <div class="form-item">
        <label class="form-label">登出回跳白名单（post_logout_redirect_uris，每行一个，可空）</label>
        <textarea class="form-control mono" id="ag-sso-postlogouts" rows="2">${esc((sso.postLogoutUris ?? []).join('\n'))}</textarea>
      </div>
      <label class="flex" style="gap:8px;font-size:13px;margin:6px 0 12px;cursor:pointer">
        <input type="checkbox" id="ag-sso-consent" ${sso.consentRequired ? 'checked' : ''} style="accent-color:var(--brand-500)">
        <span>授权页要求用户显式勾选同意（对外部界面建议开启）</span>
      </label>
      <div class="flex" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="ag-sso-save">${icon('check', 14)}保存配置</button>
        ${sso.clientType !== 'public' ? '<button class="btn btn-default" id="ag-sso-rotate">轮换 secret</button>' : ''}
        ${active
          ? '<button class="btn btn-danger-ghost" id="ag-sso-disable">禁用客户端</button>'
          : '<button class="btn btn-primary" id="ag-sso-enable">启用客户端</button>'}
      </div>
      ${!active && mode === 'oidc' ? `<div class="muted-box mt-8" style="display:flex;gap:8px;border-color:var(--warn-border);background:var(--warn-bg)">${icon('alert', 15)}<span>客户端处于禁用状态：AGENT_SSO_ENFORCE=oidc 门禁将阻断上线审批。</span></div>` : ''}
    </div>
    <div class="card card-pad mb-14">
      <div class="card-title mb-8">${icon('plug', 14)} 接入端点（discovery）</div>
      <div class="desc-grid">
        <div class="desc-item"><span class="k">issuer（签发方）</span><span class="v mono">${esc(sso.discovery.issuer)}</span></div>
        <div class="desc-item"><span class="k">authorize（授权端点）</span><span class="v mono">${esc(sso.discovery.authorization_endpoint)}</span></div>
        <div class="desc-item"><span class="k">token（令牌端点）</span><span class="v mono">${esc(sso.discovery.token_endpoint)}</span></div>
        <div class="desc-item"><span class="k">userinfo（用户信息端点）</span><span class="v mono">${esc(sso.discovery.userinfo_endpoint)}</span></div>
      </div>
      <div class="flex mt-8" style="gap:8px">
        <button class="btn btn-default btn-sm" id="ag-sso-copy-discovery">复制 discovery 地址</button>
      </div>
      <div class="form-hint mt-8">id_token 验签公钥见 JWKS：<code class="mono">${esc(sso.discovery.issuer)}/.well-known/jwks.json</code></div>
    </div>
    ${entryCard}`
  holder.querySelector('#ag-sso-copy-id').onclick = () => void copyText(sso.clientId)
  holder.querySelector('#ag-sso-copy-discovery').onclick = () => void copyText(`${sso.discovery.issuer}/.well-known/openid-configuration`)
  wireAgentEntryAndHeadless(holder, agent, refresh)
  holder.querySelector('#ag-sso-save').onclick = async () => {
    const redirectUris = holder.querySelector('#ag-sso-redirects').value.split('\n').map((x) => x.trim()).filter(Boolean)
    const postLogoutUris = holder.querySelector('#ag-sso-postlogouts').value.split('\n').map((x) => x.trim()).filter(Boolean)
    try {
      await api.patch(`/api/agents/${agent.id}/sso-client`, { redirectUris, postLogoutUris, consentRequired: holder.querySelector('#ag-sso-consent').checked })
      toast(rqI18n.t('SSO 配置已保存')); refresh()
    } catch (error) { toast(error.message, 'error') }
  }
  const rotateBtn = holder.querySelector('#ag-sso-rotate')
  if (rotateBtn) rotateBtn.onclick = async () => {
    const result = await confirmDialog({
      title: '轮换 client_secret', danger: true, confirmText: '确认轮换',
      message: '旧 secret <b>立即失效</b>，界面侧需同步更新。新 secret 仅展示一次。',
    })
    if (!result) return
    try {
      const rotated = await api.post(`/api/agents/${agent.id}/sso-client/rotate`)
      showAgentSsoSecret(rotated)
    } catch (error) { toast(error.message, 'error') }
  }
  const disableBtn = holder.querySelector('#ag-sso-disable')
  if (disableBtn) disableBtn.onclick = async () => {
    const result = await confirmDialog({
      title: '禁用 SSO 客户端', requireReason: true, danger: true, confirmText: '立即禁用',
      message: '禁用后该 Agent 的登录跳转与令牌刷新立即失败（refresh 链一并吊销）。',
    })
    if (!result) return
    try {
      await api.post(`/api/agents/${agent.id}/sso-client/disable`, { reason: result.reason })
      toast(rqI18n.t('客户端已禁用')); refresh()
    } catch (error) { toast(error.message, 'error') }
  }
  const enableBtn = holder.querySelector('#ag-sso-enable')
  if (enableBtn) enableBtn.onclick = async () => {
    try {
      await api.post(`/api/agents/${agent.id}/sso-client/enable`)
      toast(rqI18n.t('客户端已启用')); refresh()
    } catch (error) { toast(error.message, 'error') }
  }
}

/** 签发弹窗（redirect_uris 必填；dsh 单入口形态建议填 <dsh地址>/auth/oidc/callback）。 */
function openAgentIssueSsoModal(agent, refresh) {
  const modal = openModal({
    title: rqI18n.t('签发 SSO 客户端：{name}', { name: agent.name }),
    body: `
      <div class="form-item">
        <label class="form-label">回调地址（redirect_uris，每行一个；https://，或 http:// 内网/本机地址）</label>
        <textarea class="form-control mono" id="ag-sso-new-redirects" rows="3" placeholder="http://192.168.0.7:3080/auth/oidc/callback"></textarea>
      </div>
      <label class="flex" style="gap:8px;font-size:13px;margin:8px 0;cursor:pointer">
        <input type="checkbox" id="ag-sso-new-public" style="accent-color:var(--brand-500)">
        <span>public 客户端（纯前端界面：免 secret、强制 PKCE、不发 refresh token）</span>
      </label>
      <div class="form-hint">clientSecret 仅签发时展示一次；丢失走「轮换 secret」，不要重复签发。</div>`,
    foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" id="ag-sso-new-ok">${icon('key', 13)}签发</button>`,
  })
  modal.el.querySelector('#ag-sso-new-ok').onclick = async () => {
    const redirectUris = modal.el.querySelector('#ag-sso-new-redirects').value.split('\n').map((x) => x.trim()).filter(Boolean)
    if (redirectUris.length === 0) { toast(rqI18n.t('至少填写一个回调地址'), 'error'); return }
    try {
      const created = await api.post(`/api/agents/${agent.id}/sso-client`, {
        redirectUris,
        clientType: modal.el.querySelector('#ag-sso-new-public').checked ? 'public' : 'confidential',
      })
      modal.close()
      showAgentSsoSecret(created)
      refresh()
    } catch (error) { toast(error.message, 'error') }
  }
}

/** secret 一次性展示弹窗。 */
function showAgentSsoSecret(created) {
  const modal = openModal({
    title: '客户端凭证（仅本次展示）',
    body: `
      <div class="form-hint" style="margin-bottom:10px">请立即复制保存；关闭后不再展示，丢失请走「轮换 secret」。</div>
      <div class="code-block" style="white-space:pre-wrap;word-break:break-all">client_id:     ${esc(created.clientId)}
client_secret: ${esc(created.clientSecret ?? '（public 客户端无 secret）')}</div>`,
    foot: `<button class="btn btn-default" id="ag-sso-secret-copy">${icon('copy', 13)}复制</button><button class="btn btn-primary" data-ok>我已保存</button>`,
  })
  modal.el.querySelector('#ag-sso-secret-copy').onclick = () => void copyText(`client_id: ${created.clientId}\nclient_secret: ${created.clientSecret ?? ''}`)
}
