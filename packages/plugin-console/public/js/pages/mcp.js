/** MCP 服务：卡片墙 + 分类/搜索筛选 + 详情抽屉（监控图表/工具/版本/权限组）+ 部署向导。 */
import { api, session } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog, copyText,
  statusBadge, renderTable, collectForm, field, inputField, selectField, textareaField,
  fmtNum, fmtPct, timeAgo, emptyState, sparkline, barChart, lineChart, maybeShowConceptCard,
  multiSelectField, mountSearchableSelects,
} from '../ui.js'
import { ASSET_CATEGORIES, assetCategory } from '../taxonomy.js'

const ICON_COLORS = { kb: ['#eef6ff', '#0052D9'], chart: ['#ecfdf5', '#10b981'], ticket: ['#fff7ed', '#f97316'], hr: ['#f5f3ff', '#8b5cf6'], fx: ['#fef2f2', '#ef4444'], mcp: ['#eff6ff', '#3b82f6'] }

/** 输入防抖（列表搜索用）。 */
function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}

export async function renderMcp(content, params, ctx) {
  const [data, governance] = await Promise.all([
    api.get('/api/mcp/services'),
    // 治理待办摘要（W1-T2 契约 §5，只读）：失败（含旧后端无此端点）静默降级为无横幅
    api.get('/api/mcp/governance/summary').catch(() => null),
  ])
  const services = data.services

  // 首次访问概念卡（易用性整改：MCP 术语对业务成员有门槛）
  maybeShowConceptCard(content, 'mcp', {
    icon: 'plug',
    title: 'MCP 是什么？',
    subtitle: 'MCP = Agent 连接外部工具与数据的标准接口，可以理解为「万能插头」。',
    points: [
      '供给侧：把知识库、工单、图表等能力以统一规格提供给 Agent 调用。',
      '供给链路：注册登记 → 安全审核 → 测试验证 → 灰度发布 → 运行监控。',
      '平台托管：网关统一鉴权、限流熔断，调用全程透明计量。',
    ],
  })

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">MCP SERVICES</div>
        <div class="page-title">MCP 服务</div>
        <div class="page-sub">工具的供给链路：注册登记 → 安全审核 → 测试验证 → 灰度发布 → 运行监控。网关统一鉴权、限流熔断。</div>
      </div>
      <div class="page-actions">
        ${session.can('mcp.service.write') ? `<button class="btn btn-default" id="mcp-cred-migrate">${icon('key', 14)}凭证迁移</button>` : ''}
        ${session.can('mcp.permgroup.write') ? `<button class="btn btn-default" id="mcp-permgroups">${icon('shield', 14)}权限组管理</button>` : ''}
        ${session.can('mcp.service.write') ? `<button class="btn btn-primary" id="mcp-deploy-wizard">${icon('plus', 14)}接入 MCP 服务</button>` : ''}
      </div>
    </div>

    ${governanceBannerHtml(governance)}

    <div class="stat-grid mb-20">
      ${miniStat('server', '服务总数', services.length)}
      ${miniStat('wifi', '在线 / 灰度', services.filter((s) => ['online', 'gray'].includes(s.status)).length)}
      ${miniStat('activity', '累计调用', fmtNum(data.overview.totalCalls))}
      ${miniStat('zap', '成功率', fmtPct(data.overview.successRate))}
      ${miniStat('clock', 'P95 延迟', data.overview.p95Latency + 'ms')}
    </div>

    <div class="filter-bar">
      <div class="search-input">${icon('search')}<input class="input" id="mcp-q" placeholder="搜索服务名称 / 描述" style="width:200px"></div>
      <div class="chips" id="mcp-cats">
        <span class="chip active" data-c="">全部</span>
        ${ASSET_CATEGORIES.map((cat) => `<span class="chip" data-c="${cat}">${cat}</span>`).join('')}
      </div>
      <span class="fs-12 text-3" style="margin-left:auto" id="mcp-count"></span>
    </div>
    <div class="card-grid" id="mcp-cards"></div>`

  let mcpFilter = { q: '', category: '' }
  const renderCards = () => {
    const list = services.filter((svc) => {
      if (mcpFilter.category && assetCategory(svc) !== mcpFilter.category) return false
      if (mcpFilter.q && !`${svc.name}${svc.slug}${svc.description ?? ''}`.toLowerCase().includes(mcpFilter.q.toLowerCase())) return false
      return true
    })
    const countEl = $('#mcp-count')
    if (countEl) countEl.textContent = rqI18n.t('共 {n} 个服务', { n: list.length })
    const cards = $('#mcp-cards')
    if (!cards) return
    cards.innerHTML = ''
    if (!list.length) {
      cards.appendChild(emptyState({ title: services.length ? '没有匹配的 MCP 服务' : '还没有 MCP 服务', desc: services.length ? '换个分类或关键字试试' : '接入第一个 MCP 服务，为 Agent 提供工具能力', ...(session.can('mcp.service.write') && !services.length ? { actionText: '接入 MCP 服务', onAction: () => $('#mcp-deploy-wizard').click() } : {}) }))
    }
    for (const svc of list) {
    const [bg, color] = ICON_COLORS[svc.icon] ?? ICON_COLORS.mcp
    const health = svc.health?.status ?? 'unknown'
    const card = h(`
      <div class="res-card" data-id="${esc(svc.id)}">
        <div class="res-card-top">
          <div class="res-icon" style="background:${bg};color:${color}">${svcIcon(svc.icon)}</div>
          <div class="grow">
            <div class="res-name">${esc(svc.name)} ${statusBadge(svc.status)}${svc.bridgeFrom ? `<span class="badge badge-warning" title="M0 数据面桥接（open-connector）：仅服务级粗粒度权限组，无 action 级授权 / 连接级绑定 / oct_ 令牌镜像——生产纳管请走 #/connectors 原生链路">桥接过渡</span>` : ''}</div>
            <div class="res-slug">${esc(svc.endpoint || svc.slug)}</div>
          </div>
          <span class="traffic ${trafficClass(health)}" title="${esc(rqI18n.t('健康状态：{status}', { status: health }))}"></span>
        </div>
        <div class="res-desc">${esc(svc.description || '暂无描述')}</div>
        <div class="flex" style="gap:6px;flex-wrap:wrap">
          <span class="badge badge-brand no-dot">${esc(assetCategory(svc))}</span>
        </div>
        ${svc.status === 'gray' ? `
          <div>
            <div class="flex-between fs-12 mb-8"><span class="text-3">灰度比例</span><span>${svc.grayPercent}%</span></div>
            <div class="progress"><div class="progress-bar" style="width:${svc.grayPercent}%"></div></div>
          </div>` : ''}
        <div class="res-foot">
          <span class="metric">${icon('box', 13)}${esc(rqI18n.t('{n} 工具', { n: svc.tools.length }))}</span>
          <span class="metric">${icon('gitBranch', 13)}v${esc(svc.currentVersion)}</span>
          <span class="metric">${icon('activity', 13)}${esc(rqI18n.t(healthLabel(health)))}${svc.health?.latencyMs ? ` ${svc.health.latencyMs}ms` : ''}</span>
          <span style="margin-left:auto">${svc.mode === 'external' ? '<span class="badge badge-muted no-dot">外部注册</span>' : '<span class="badge badge-brand no-dot">平台托管</span>'}</span>
        </div>
      </div>`)
    card.onclick = () => openServiceDetail(svc.id, ctx)
    cards.appendChild(card)
  }
  }

  $('#mcp-q').oninput = debounce(() => { mcpFilter.q = $('#mcp-q').value.trim(); renderCards() }, 250)
  $$('#mcp-cats .chip').forEach((chip) => {
    chip.onclick = () => {
      $$('#mcp-cats .chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      mcpFilter.category = chip.dataset.c
      renderCards()
    }
  })
  renderCards()

  const deployBtn = $('#mcp-deploy-wizard')
  if (deployBtn) deployBtn.onclick = () => openDeployWizard(ctx)
  const permBtn = $('#mcp-permgroups')
  if (permBtn) permBtn.onclick = () => openPermGroups(ctx)
  const migrateBtn = $('#mcp-cred-migrate')
  if (migrateBtn) migrateBtn.onclick = () => openCredentialMigrate(ctx)
  wireGovernanceBanner(content, governance, ctx)

  if (params.get('action') === 'deploy') openDeployWizard(ctx)
  if (params.get('focus')) void openServiceDetail(params.get('focus'), ctx)
}

async function openServiceDetail(id, ctx) {
  // 归属实体名称反查（app/agent）与凭证元数据（GET 回显 hasSecret，永不回密文）；
  // 名称/凭证缺失（旧数据或只读权限）一律容错降级展示
  const [svcData, metrics, calls, groups, credential, appData, agentData] = await Promise.all([
    api.get('/api/mcp/services').then((d) => d.services.find((s) => s.id === id)),
    api.get(`/api/mcp/services/${id}/metrics`),
    api.get('/api/mcp/calls' + api.qs({ serviceId: id, limit: 15 })),
    api.get('/api/mcp/perm-groups'),
    api.get(`/api/mcp/services/${id}/credential`).catch(() => null),
    api.get('/api/apps').catch(() => ({ apps: [] })),
    api.get('/api/agents').catch(() => ({ agents: [] })),
  ])
  if (!svcData) return
  const [bg, color] = ICON_COLORS[svcData.icon] ?? ICON_COLORS.mcp

  const drawer = openDrawer({
    title: svcData.name,
    sub: `${svcData.endpoint} · ${svcData.mode === 'external' ? rqI18n.t('外部注册') : rqI18n.t('平台托管')} · v${svcData.currentVersion}`,
    wide: true,
    body: `
      <div class="flex mb-20" style="gap:14px">
        <div class="res-icon" style="width:52px;height:52px;font-size:26px;background:${bg};color:${color}">${svcIcon(svcData.icon)}</div>
        <div class="grow">
          <div class="flex" style="gap:8px;flex-wrap:wrap">
            ${statusBadge(svcData.status)}
            <span class="badge badge-brand no-dot">${esc(assetCategory(svcData))}</span>
            <span class="badge badge-muted no-dot">${svcData.transport.toUpperCase()}</span>
            <span class="badge ${svcData.health?.breakerOpen ? 'badge-danger' : 'badge-ok'} no-dot">${svcData.health?.breakerOpen ? '熔断开启' : '熔断关闭'}</span>
          </div>
          <div class="fs-12 text-3 mt-8">${esc(svcData.description)}</div>
        </div>
      </div>

      <div class="stat-grid mb-20" style="grid-template-columns:repeat(4,1fr)">
        ${miniStat('activity', '调用量', fmtNum(metrics.calls), true)}
        ${miniStat('check', '成功率', fmtPct(metrics.successRate), true)}
        ${miniStat('clock', 'P95 延迟', metrics.p95Latency + 'ms', true)}
        ${miniStat('coins', 'Token 消耗', fmtNum(metrics.tokens), true)}
      </div>

      <div class="tabs" id="svc-tabs">
        <div class="tab active" data-tab="monitor">监控</div>
        <div class="tab" data-tab="governance">${icon('shield', 13)} 治理</div>
        <div class="tab" data-tab="tools">${esc(rqI18n.t('工具 ({n})', { n: svcData.tools.length }))}</div>
        <div class="tab" data-tab="versions">版本</div>
        <div class="tab" data-tab="calls">调用明细</div>
        <div class="tab" data-tab="grants">授权主体</div>
      </div>
      <div id="svc-tab-body"></div>`,
    foot: `
      <button class="btn btn-default" id="svc-health">${icon('wifi', 14)}健康探测</button>
      ${svcData.mode === 'external' && svcData.exec === 'real' ? `<button class="btn btn-default" id="svc-sync-tools">${icon('refresh', 14)}同步工具</button>` : ''}
      ${svcData.status !== 'offline' ? `<button class="btn btn-default" id="svc-gray">${icon('trending', 14)}${svcData.status === 'gray' ? '调整灰度' : '灰度发布'}</button>` : ''}
      ${svcData.status !== 'offline' ? `<button class="btn btn-danger-ghost" id="svc-offline">${icon('alert', 14)}下线服务</button>` : ''}
      ${svcData.status === 'draft' ? `<button class="btn btn-primary" id="svc-verify">${icon('play', 14)}测试验证</button>` : ''}
      ${svcData.status === 'offline' ? `<button class="btn btn-danger-ghost" id="svc-delete">${icon('trash', 14)}删除服务</button>` : ''}`,
  })

  const tabBody = drawer.body.querySelector('#svc-tab-body')
  const renderTab = (tab) => {
    if (tab === 'monitor') {
      tabBody.innerHTML = `
        <div class="card card-pad mb-14">
          <div class="card-title mb-8">近 60 分钟调用（次/分钟）</div>
          ${barChart(metrics.series.map((s) => ({ label: s.minute, value: s.calls })), { width: 640, height: 150 })}
        </div>
        <div class="grid-2">
          <div class="card card-pad">
            <div class="card-title mb-8">平均延迟（ms）</div>
            ${lineChart([metrics.series.map((s) => s.avgLatency)], { width: 300, height: 130 })}
          </div>
          <div class="card card-pad">
            <div class="card-title mb-8">错误数</div>
            ${barChart(metrics.series.map((s) => ({ label: s.minute, value: s.errors })), { width: 300, height: 130, color: '#ef4444' })}
          </div>
        </div>
        <div class="card card-pad mt-14">
          <div class="card-title mb-8">按调用方统计</div>
          ${metrics.callers.map((c) => `
            <div class="flex" style="padding:6px 0;border-bottom:1px solid var(--border)">
              <span class="badge ${c.callerType === 'agent' ? 'badge-purple' : 'badge-brand'} no-dot">${c.callerType === 'agent' ? 'Agent' : '用户'}</span>
              <span class="fs-13 grow">${esc(c.callerName)}</span>
              <span class="col-num">${esc(rqI18n.t('{n} 次', { n: fmtNum(c.calls) }))}</span>
            </div>`).join('') || '<span class="text-4 fs-12">暂无调用</span>'}
        </div>`
    }
    if (tab === 'governance') {
      const sensitive = sensitiveHeaderKeys(svcData.headers)
      const credRef = credential?.credentialRef ?? svcData.credentialRef
      // 凭证状态三态：已配置（local:/env: 引用 + 是否存有密钥）/ 未配置但服务仍带敏感头（警示迁移）/ 未配置无需求
      const credHtml = credRef
        ? `<span class="badge badge-ok no-dot">${esc(rqI18n.t('已配置'))}</span>
           <span class="mono fs-12" style="margin-left:6px">${esc(credRef)}</span>
           <span class="badge ${credential?.hasSecret === false ? 'badge-muted' : 'badge-ok'} no-dot" style="margin-left:6px">${credential?.hasSecret === false ? esc(rqI18n.t('仅引用（无本地密钥）')) : esc(rqI18n.t('已存密钥'))}</span>
           ${credential?.headerName ? `<span class="fs-12 text-3" style="margin-left:6px">${esc(rqI18n.t('注入头：{header}', { header: credential.headerName }))}</span>` : ''}`
        : sensitive.length
          ? `<span class="badge badge-warn no-dot">${esc(rqI18n.t('明文凭证，建议迁移'))}</span>
             <span class="mono fs-12 text-3" style="margin-left:6px">${esc(rqI18n.t('敏感头：{keys}', { keys: sensitive.join('、') }))}</span>`
          : `<span class="badge badge-muted no-dot">${esc(rqI18n.t('未配置（无敏感头需求）'))}</span>`
      const sensitiveWarn = !credRef && sensitive.length ? `
        <div class="muted-box mt-8" style="display:flex;gap:8px;border-color:var(--warn-border);background:var(--warn-bg)">
          ${icon('alert', 15)}<span>${esc(rqI18n.t('该服务仍以明文请求头携带下游凭证（存量数据）。建议经「凭证迁移」转入 Secret Broker：密钥落平台密钥文件（0600），业务集合与 API 响应零明文。'))}</span>
        </div>` : ''
      tabBody.innerHTML = `
        <div class="card card-pad mb-14">
          <div class="card-title mb-8">${icon('shield', 14)} 治理属性</div>
          <div class="desc-grid">
            <div class="desc-item"><span class="k">${esc(rqI18n.t('归属实体'))}</span><span class="v">${ownerEntityHtml(svcData, appData, agentData)}</span></div>
            <div class="desc-item"><span class="k">${esc(rqI18n.t('数据密级'))}</span><span class="v"><span class="badge ${dataClassClass(svcData.dataClass)} no-dot">${esc(rqI18n.t(dataClassLabel(svcData.dataClass)))}</span></span></div>
            <div class="desc-item"><span class="k">${esc(rqI18n.t('暴露模式'))}</span><span class="v">${esc(rqI18n.t(exposureLabel(svcData.exposureMode)))}</span></div>
            <div class="desc-item"><span class="k">${esc(rqI18n.t('可见范围'))}</span><span class="v">${esc(rqI18n.t(visibilityLabel(svcData.visibility)))}</span></div>
            <div class="desc-item"><span class="k">${esc(rqI18n.t('部署环境'))}</span><span class="v">${esc(rqI18n.t(envStageLabel(svcData.environment)))}</span></div>
            ${svcData.archivedBy ? `<div class="desc-item"><span class="k">${esc(rqI18n.t('归档来源应用'))}</span><span class="v mono">${esc(svcData.archivedBy)}</span></div>` : ''}
          </div>
          <div class="form-hint mt-8">${esc(rqI18n.t('归属缺失（平台占位）会计入治理待办；应用经「能力绑定」认领后自动回写归属。'))}</div>
        </div>
        <div class="card card-pad mb-14">
          <div class="flex-between mb-8">
            <div class="card-title">${icon('key', 14)} 下游凭证（Secret Broker）</div>
            ${session.can('mcp.service.write') && !credRef && sensitive.length ? `<button class="btn btn-default btn-sm" id="svc-cred-migrate">${icon('refresh', 13)}凭证迁移</button>` : ''}
          </div>
          <div class="flex" style="gap:8px;flex-wrap:wrap;align-items:center">${credHtml}</div>
          ${sensitiveWarn}
          <div class="form-hint mt-8">${esc(rqI18n.t('凭证引用形态：local:（平台密钥文件）或 env:VAR（进程环境变量）；密钥原文不落业务集合、任何 API 不回显。'))}</div>
        </div>
        ${dataplaneCardHtml(svcData)}`
      const svcMigrateBtn = tabBody.querySelector('#svc-cred-migrate')
      if (svcMigrateBtn) svcMigrateBtn.onclick = () => openCredentialMigrate(ctx)
      const copyEpBtn = tabBody.querySelector('#dp-copy-endpoint')
      if (copyEpBtn) copyEpBtn.onclick = () => void copyText(dataplaneEndpoint(svcData))
      const copySnippetBtn = tabBody.querySelector('#dp-copy-snippet')
      if (copySnippetBtn) copySnippetBtn.onclick = () => void copyText(dataplaneSnippet(svcData))
    }
    if (tab === 'tools') {
      tabBody.innerHTML = svcData.tools.map((tool) => `
        <div class="card card-pad mb-8 flex" style="cursor:default">
          <div class="grow">
            <div class="flex" style="gap:8px">
              <span class="mono" style="font-weight:600">${esc(tool.name)}</span>
              <span class="badge ${riskClass(tool.riskLevel)} no-dot">${riskLabel(tool.riskLevel)}</span>
            </div>
            <div class="fs-12 text-3 mt-8">${esc(tool.description)}</div>
          </div>
          <button class="btn btn-default btn-sm stop" data-try="${esc(tool.name)}">${icon('play', 12)}试调用</button>
        </div>`).join('')
      tabBody.querySelectorAll('[data-try]').forEach((btn) => {
        btn.onclick = () => openTryInvoke(svcData, btn.dataset.try, ctx)
      })
    }
    if (tab === 'versions') {
      const versions = [...svcData.versions].reverse()
      tabBody.innerHTML = `
        <div class="timeline">
          ${versions.map((v) => `
            <div class="timeline-item ${v.status === 'current' ? 'ok' : v.status === 'rolled-back' ? 'danger' : ''}">
              <div class="timeline-dot"></div>
              <div class="timeline-title">v${esc(v.version)} <span class="badge ${v.status === 'current' ? 'badge-ok' : v.status === 'rolled-back' ? 'badge-danger' : 'badge-muted'} no-dot">${versionLabel(v.status)}</span></div>
              <div class="timeline-time">${timeAgo(v.publishedAt)}</div>
              <div class="timeline-body">${esc(v.changelog)}</div>
              ${v.status !== 'current' ? `<button class="btn btn-ghost btn-sm mt-8" data-rollback="${esc(v.version)}">回滚到此版本</button>` : ''}
            </div>`).join('') || '<span class="text-4 fs-12">暂无历史版本</span>'}
        </div>`
      tabBody.querySelectorAll('[data-rollback]').forEach((btn) => {
        btn.onclick = async () => {
          const result = await confirmDialog({ title: '版本回滚', message: rqI18n.t('将 <b>{name}</b> 回滚到 <b>v{version}</b>，调用方将在下一次请求生效。', { name: esc(svcData.name), version: esc(btn.dataset.rollback) }), confirmText: '回滚' })
          if (!result) return
          try {
            await api.post(`/api/mcp/services/${svcData.id}/rollback`, { targetVersion: btn.dataset.rollback })
            toast(rqI18n.t('已回滚')); drawer.close(); ctx.rerender()
          } catch (error) { toast(error.message, 'error') }
        }
      })
    }
    if (tab === 'calls') {
      tabBody.innerHTML = ''
      const table = renderTable({
        columns: [
          { title: '时间', width: 130, render: (c) => `<span class="fs-12 text-3">${timeAgo(c.at)}</span>` },
          { title: '工具', render: (c) => `<span class="mono fs-12">${esc(c.tool)}</span>` },
          { title: '调用方', render: (c) => esc(c.callerName) },
          { title: '版本', render: (c) => `<span class="fs-12 text-3">v${esc(c.version)}</span>` },
          { title: '状态', width: 100, render: (c) => statusBadge(c.status === 'ok' ? 'ok' : c.status) },
          { title: '延迟', width: 80, render: (c) => `<span class="col-num">${c.latencyMs}ms</span>` },
          { title: 'Token', width: 80, render: (c) => `<span class="col-num">${c.tokens || '—'}</span>` },
        ],
        rows: calls.items,
        onRowClick: () => {},
      })
      tabBody.appendChild(table)
    }
    if (tab === 'grants') {
      const granted = groups.groups.filter((g) => g.policies[svcData.id])
      tabBody.innerHTML = granted.map((g) => `
        <div class="card card-pad mb-8">
          <div class="flex-between mb-8">
            <span style="font-weight:600">${icon('shield', 14)} ${esc(g.name)}</span>
            <span class="fs-12 text-3">${esc(g.description || '')}</span>
          </div>
          <div class="fs-12 text-3 mb-8">${esc(rqI18n.t('工具策略：{policy}', { policy: policyLabel(g.policies[svcData.id]) }))}</div>
          <div class="flex" style="flex-wrap:wrap;gap:6px">
            ${g.subjects.map((s) => `<span class="badge ${subjectClass(s.type)} no-dot">${esc(s.name ?? s.id)}</span>`).join('')}
          </div>
        </div>`).join('') || '<span class="text-4 fs-12">尚无权限组授权该服务</span>'
    }
  }
  drawer.body.querySelectorAll('#svc-tabs .tab').forEach((el) => {
    el.onclick = () => {
      drawer.body.querySelectorAll('#svc-tabs .tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })
  renderTab('monitor')

  drawer.el.querySelector('#svc-health').onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      const result = await api.post(`/api/mcp/services/${svcData.id}/health`)
      toast(rqI18n.t('探测完成：{status}（{ms}ms）', { status: result.status, ms: result.latencyMs }))
      drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
  }
  const syncToolsBtn = drawer.el.querySelector('#svc-sync-tools')
  if (syncToolsBtn) syncToolsBtn.onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      const updated = await api.post(`/api/mcp/services/${svcData.id}/sync-tools`)
      toast(rqI18n.t('工具清单已同步：{n} 个工具', { n: updated.tools.length }))
      drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
  }
  const grayBtn = drawer.el.querySelector('#svc-gray')
  if (grayBtn) grayBtn.onclick = () => openGrayDialog(svcData, drawer, ctx)
  const offlineBtn = drawer.el.querySelector('#svc-offline')
  if (offlineBtn) offlineBtn.onclick = async () => {
    const result = await confirmDialog({
      title: '下线 MCP 服务（L4）', requireReason: true, danger: true, confirmText: '提交审批',
      message: rqI18n.t('下线 <b>{name}</b> 是高危操作，将生成审批单，审批通过后自动执行。所有依赖该服务的 Agent 调用会立即失败。', { name: esc(svcData.name) }),
    })
    if (!result) return
    try {
      const response = await api.post(`/api/mcp/services/${svcData.id}/offline`, { reason: result.reason })
      toast(rqI18n.t('已创建 L4 审批单，等待审批'))
      drawer.close(); ctx.rerender()
      void response
    } catch (error) { toast(error.message, 'error') }
  }
  const verifyBtn = drawer.el.querySelector('#svc-verify')
  if (verifyBtn) verifyBtn.onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      await api.post(`/api/mcp/services/${svcData.id}/verify`)
      toast(rqI18n.t('测试环境验证通过')); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
  }

  const deleteBtn = drawer.el.querySelector('#svc-delete')
  if (deleteBtn) deleteBtn.onclick = async () => {
    const result = await confirmDialog({
      title: rqI18n.t('删除 MCP 服务 · {name}', { name: svcData.name }), requireReason: true, danger: true, confirmText: '确认删除',
      message: rqI18n.t('将永久删除 <b>{name}</b> 的服务登记（含工具清单与探活状态），操作不可恢复；调用明细与审计数据保留。', { name: esc(svcData.name) }),
    })
    if (!result) return
    try {
      await api.delete(`/api/mcp/services/${svcData.id}`)
      toast(rqI18n.t('已删除')); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
}

function openGrayDialog(svc, drawer, ctx) {
  const modal = openModal({
    title: rqI18n.t('灰度发布 · {name}', { name: svc.name }),
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">
        ${icon('info', 15)}<span>灰度按调用方标签路由：未命中灰度比例的调用将继续走 <b>v${esc(svc.versions.find((v) => v.status === 'previous')?.version ?? svc.currentVersion)}</b> 稳定版本。</span>
      </div>
      ${field('灰度比例（%）', `<input class="input" type="range" min="0" max="100" step="5" value="${svc.grayPercent || 10}" id="gray-range" oninput="this.nextElementSibling.textContent=this.value+'%'"><div style="font-weight:600;margin-top:4px">${svc.grayPercent || 10}%</div>`)}
      ${field('新版本号', inputField('version', { value: bumpPatch(svc.currentVersion) }))}
      ${field('变更说明', textareaField('changelog', { placeholder: '本次发布内容…' }))}`,
    foot: `<button class="btn btn-default" data-dryrun>预演影响面</button><button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>发布</button>`,
  })
  const body = modal.body
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-dryrun]').onclick = async () => {
    try {
      const result = await api.post(`/api/mcp/services/${svc.id}/deploy`, { dryRun: true })
      const impact = result.impact?.length
        ? result.impact.map((i) => `<li>${esc(rqI18n.t('{name}（{type}）', { name: i.name, type: rqI18n.t(typeLabel(i.type)) }))}</li>`).join('')
        : '<li>无直接依赖方，可安全发布</li>'
      modal.close()
      openModal({ title: '影响面预演（dry-run）', body: `<div class="form-hint">以下资源可能受到本次发布影响：</div><ul style="padding-left:18px;line-height:2">${impact}</ul><div class="muted-box mt-14">dry-run 未执行任何变更。</div>`, foot: '<button class="btn btn-primary" data-ok>知道了</button>' })
        .el.querySelector('[data-ok]').onclick = () => openGrayDialog(svc, drawer, ctx)
    } catch (error) { toast(error.message, 'error') }
  }
  modal.el.querySelector('[data-ok]').onclick = async () => {
    const data = collectForm(body)
    try {
      await api.post(`/api/mcp/services/${svc.id}/deploy`, {
        grayPercent: Number(body.querySelector('#gray-range').value),
        version: data.version, changelog: data.changelog,
      })
      toast(rqI18n.t('已发布 v{version}', { version: data.version })); modal.close(); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
}

function openDeployWizard(ctx) {
  let step = 1
  const state = { transport: 'http' }
  const modal = openModal({
    title: '接入 MCP 服务', wide: true,
    body: `
      <div class="flex mb-20" style="gap:6px" id="wiz-steps">
        ${wizardStep(1, '选择来源', true)}${wizardArrow()}${wizardStep(2, '配置', false)}${wizardArrow()}${wizardStep(3, '验证发布', false)}
      </div>
      <div id="wiz-body"></div>`,
    foot: `
      <button class="btn btn-default" id="wiz-prev" style="visibility:hidden">上一步</button>
      <button class="btn btn-primary" id="wiz-next">下一步</button>`,
  })
  const bodyEl = modal.body.querySelector('#wiz-body')
  const prevBtn = modal.el.querySelector('#wiz-prev')
  const nextBtn = modal.el.querySelector('#wiz-next')

  const renderStep = () => {
    modal.body.querySelectorAll('#wiz-steps .wiz-step').forEach((el, index) => {
      el.classList.toggle('active', index + 1 === step)
      el.classList.toggle('done', index + 1 < step)
    })
    prevBtn.style.visibility = step === 1 ? 'hidden' : ''
    nextBtn.textContent = step === 3 ? (state.source === 'import' ? '导入并上线' : '验证并发布') : '下一步'
    if (step === 1) {
      bodyEl.innerHTML = `
        <div class="card-grid" style="grid-template-columns:1fr 1fr">
          ${sourceCard('import', '配置导入（JSON）', '粘贴 Claude / Cursor 等工具的 mcpServers 配置，自动注册并发现工具', 'clipboard')}
          ${sourceCard('endpoint', '外部服务注册', '手动登记 endpoint 与传输协议', 'globe')}
          ${sourceCard('template', '平台模板', '容器化托管，提供运行时模板与镜像', 'box')}
          ${sourceCard('image', '自有镜像', '指定容器镜像，由平台托管部署', 'server')}
        </div>`
      bodyEl.querySelectorAll('[data-source]').forEach((card) => {
        card.onclick = () => {
          state.source = card.dataset.source
          bodyEl.querySelectorAll('[data-source]').forEach((c) => c.classList.remove('selected'))
          card.classList.add('selected')
        }
      })
    }
    if (step === 2 && state.source === 'import') {
      bodyEl.innerHTML = `
        <div class="form-grid">
          <div class="form-item full">
            <label class="form-label">MCP 配置 JSON<span class="req">*</span></label>
            <textarea class="form-control" name="config" rows="10" style="font-family:var(--mono);font-size:12px" placeholder='${esc(JSON.stringify({ mcpServers: { 'teambition-mcp': { type: 'streamableHttp', url: 'https://open.teambition.com/api/mcp?userToken=你的令牌' } } }, null, 2))}'>${esc(state.config ?? '')}</textarea>
            <div class="form-hint">支持 Claude Desktop / Cursor / Cherry Studio 等工具通行的 mcpServers 格式；http、streamableHttp、sse 类型均可导入，导入后自动拉取远端工具清单并上线。token 已含在 url 中的配置可直接粘贴。</div>
          </div>
        </div>`
      return
    }
    if (step === 2) {
      const isExternal = state.source === 'endpoint'
      bodyEl.innerHTML = `
        <div class="form-grid">
          ${field('服务名称', inputField('name', { value: state.name }), { required: true })}
          ${field('服务标识', inputField('slug', { value: state.slug, placeholder: '小写字母与中划线' }), { hint: '唯一标识，用于权限组与调用' })}
          ${field('业务分类', selectField('category', ASSET_CATEGORIES.map((c) => ({ value: c, label: c })), { value: state.category }), { hint: '各资产板块统一口径，市场/目录按此筛选' })}
          ${field(isExternal ? '服务 Endpoint' : '运行地址', inputField('endpoint', { value: state.endpoint, placeholder: isExternal ? 'https://your-mcp.example.com/mcp' : '自动生成' }), { required: isExternal, full: true })}
          <div class="form-item">
            <label class="form-label">传输协议</label>
            <div class="segmented">
              <span class="segmented-item ${state.transport === 'http' ? 'active' : ''}" data-t="http">HTTP</span>
              <span class="segmented-item ${state.transport === 'sse' ? 'active' : ''}" data-t="sse">SSE</span>
              <span class="segmented-item ${state.transport === 'stdio' ? 'active' : ''}" data-t="stdio">stdio</span>
            </div>
          </div>
          ${field('服务描述', textareaField('description', { value: state.description, rows: 2 }), { full: true })}
        </div>`
      bodyEl.querySelectorAll('.segmented-item').forEach((el) => {
        el.onclick = () => {
          state.transport = el.dataset.t
          bodyEl.querySelectorAll('.segmented-item').forEach((i) => i.classList.remove('active'))
          el.classList.add('active')
        }
      })
    }
    if (step === 3 && state.source === 'import') {
      let entries = []
      let parseError = ''
      try {
        const parsed = JSON.parse(state.config)
        const map = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : parsed
        entries = Object.entries(map).map(([name, conf]) => ({ name, url: conf?.url ?? '', type: conf?.type ?? 'http' }))
      } catch (error) { parseError = error.message }
      bodyEl.innerHTML = `
        <div class="grid-2">
          <div>
            <div class="card-title mb-8">将导入以下服务</div>
            ${parseError
              ? `<div class="muted-box" style="color:var(--danger)">${esc(parseError)}</div>`
              : entries.map((entry) => `
                <div class="card card-pad mb-8">
                  <div class="flex-between">
                    <span style="font-weight:600">${esc(entry.name)}</span>
                    <span class="badge badge-muted no-dot">${esc(entry.type)}</span>
                  </div>
                  <div class="fs-12 text-3 mt-4 mono" style="word-break:break-all">${esc(entry.url || '（缺少 url，将被跳过）')}</div>
                </div>`).join('')}
            ${checkItem(true, '导入后自动连接服务并发现工具清单')}
            ${checkItem(true, '连接成功将自动测试验证并发布上线（草稿保留可回退）')}
          </div>
          <div>
            <div class="card-title mb-8">导入说明</div>
            <div class="code-block">POST /api/mcp/import
mode: external
exec: real
tools: 远端自动发现（tools/list）</div>
            <div class="form-hint mt-8">导入的服务与手动注册一致：经网关统一鉴权、限流熔断；在「权限组」为用户/Agent 授权后即可调用。</div>
          </div>
        </div>`
      return
    }
    if (step === 3) {
      const yaml = `# 配置预览（api.yaml 片段）
service: ${state.slug || 'my-service'}
mode: ${state.source === 'endpoint' ? 'external' : 'hosted'}
transport: ${state.transport || 'http'}
endpoint: ${state.endpoint || `mcp+http://platform-hosted/${state.slug || 'my-service'}`}
tools: []           # 部署后在「工具」页登记`
      bodyEl.innerHTML = `
        <div class="grid-2">
          <div>
            <div class="card-title mb-8">检查清单</div>
            ${checkItem(Boolean(state.name), '服务名称已填写')}
            ${checkItem(state.source !== 'endpoint' || Boolean(state.endpoint), state.source === 'endpoint' ? 'endpoint 已登记' : '平台托管，自动分配地址')}
            ${checkItem(true, '安全审核：静态扫描通过（演示环境自动通过）')}
            ${checkItem(true, '将进入「草稿」状态，需测试验证后发布')}
          </div>
          <div>
            <div class="card-title mb-8">配置预览</div>
            <div class="code-block">${esc(yaml)}</div>
          </div>
        </div>`
    }
  }
  const collect = () => { Object.assign(state, collectForm(bodyEl)) }
  prevBtn.onclick = () => { if (step > 1) { collect(); step--; renderStep() } }
  nextBtn.onclick = async () => {
    if (step === 1) {
      if (!state.source) return toast(rqI18n.t('请选择接入来源'), 'error')
      step = 2; renderStep(); return
    }
    if (step === 2) {
      collect()
      if (state.source === 'import') {
        if (!state.config?.trim()) return toast(rqI18n.t('请粘贴 MCP 配置 JSON'), 'error')
        try { JSON.parse(state.config) } catch { return toast(rqI18n.t('配置不是合法 JSON，请检查后重试'), 'error') }
        step = 3; renderStep(); return
      }
      if (!state.name) return toast(rqI18n.t('请填写服务名称'), 'error')
      step = 3; renderStep(); return
    }
    collect()
    nextBtn.classList.add('btn-loading')
    try {
      if (state.source === 'import') {
        const result = await api.post('/api/mcp/import', { config: state.config })
        const failures = result.results.filter((item) => !item.ok)
        if (result.imported > 0) toast(rqI18n.t('已导入 {n} 个服务（工具已自动发现并上线）', { n: result.imported }))
        if (failures.length) {
          toast(rqI18n.t('未导入：{list}', { list: failures.map((item) => rqI18n.t('{name}（{error}）', { name: item.name, error: item.error })).join('；') }).slice(0, 160), 'error')
          if (result.imported === 0) return
        }
        modal.close(); ctx.rerender()
        return
      }
      await api.post('/api/mcp/services', {
        name: state.name, slug: state.slug || undefined, description: state.description,
        category: state.category || undefined,
        endpoint: state.endpoint || undefined,
        transport: state.transport || 'http',
        mode: state.source === 'endpoint' ? 'external' : 'hosted',
      })
      toast(rqI18n.t('服务已创建（草稿），完成验证后即可发布'))
      modal.close(); ctx.rerender()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      nextBtn.classList.remove('btn-loading')
    }
  }
  renderStep()

  function sourceCard(value, title, desc, ic) {
    return `
      <div class="res-card ${state.source === value ? 'selected' : ''}" data-source="${value}">
        <div class="res-card-top">
          <div class="res-icon" style="background:var(--brand-50);color:var(--brand-500)">${icon(ic, 20)}</div>
          <div style="font-weight:600">${title}</div>
        </div>
        <div class="res-desc" style="min-height:0">${desc}</div>
      </div>`
  }
  function checkItem(ok, text) {
    return `<div class="flex" style="padding:6px 0"><span style="color:var(--${ok ? 'ok' : 'text-4)'})">${icon(ok ? 'check' : 'clock', 15)}</span><span class="fs-13 ${ok ? '' : 'text-3'}">${text}</span></div>`
  }
  function wizardStep(n, label) {
    return `<div class="wiz-step ${''}" data-n="${n}"><span class="wiz-dot">${n}</span>${label}</div>`
  }
  function wizardArrow() { return `<span class="wiz-arrow">→</span>` }
}

async function openPermGroups(ctx) {
  const [groups, services] = await Promise.all([
    api.get('/api/mcp/perm-groups'),
    api.get('/api/mcp/services'),
    api.get('/api/agents').catch(() => ({ agents: [] })),
  ])
  const drawer = openDrawer({
    title: 'MCP 权限组',
    sub: '权限组 = 一组 MCP 服务 + Tool 粒度访问策略，可绑定用户组 / Agent / 应用',
    wide: true,
    body: `<div id="pg-list"></div>`,
    foot: `<button class="btn btn-primary" id="pg-add">${icon('plus', 14)}新建权限组</button>`,
  })
  const list = drawer.body.querySelector('#pg-list')
  const renderList = () => {
    list.innerHTML = groups.groups.map((g) => `
      <div class="card card-pad mb-14">
        <div class="flex-between mb-8">
          <div>
            <span style="font-weight:600">${esc(g.name)}</span>
            <span class="fs-12 text-3" style="margin-left:8px">${esc(g.description || '')}</span>
          </div>
          <div class="flex" style="gap:6px">
            <button class="btn btn-ghost btn-sm" data-scope="${esc(g.id)}" title="${esc(rqI18n.t('按策略生成资源限定 scope 模板'))}">${icon('key', 13)}scope 模板</button>
            <button class="btn btn-ghost btn-sm" data-impact="${esc(g.id)}" title="${esc(rqI18n.t('预演该权限组的影响面：新增服务 / 写工具 / 高敏数据 / 跨组织'))}">${icon('activity', 13)}${esc(rqI18n.t('预演影响面'))}</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-del="${esc(g.id)}">${icon('trash', 13)}</button>
          </div>
        </div>
        ${Object.entries(g.policies).map(([serviceId, policy]) => `
          <div class="flex" style="padding:6px 0;border-bottom:1px dashed var(--border)">
            <span class="fs-13 grow">${esc(services.services.find((s) => s.id === serviceId)?.name ?? serviceId)}</span>
            <span class="fs-12 text-3">${policyLabel(policy)}</span>
          </div>`).join('')}
        <div class="flex mt-8" style="flex-wrap:wrap;gap:6px">
          ${g.subjects.map((s) => `<span class="badge ${subjectClass(s.type)} no-dot">${esc(s.name ?? s.id)}</span>`).join('') || '<span class="text-4 fs-12">未绑定主体</span>'}
        </div>
      </div>`).join('') || '<span class="text-4 fs-12">暂无权限组</span>'
    list.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = async () => {
        const result = await confirmDialog({ title: '删除权限组', message: '删除后相关主体的访问授权立即失效。', danger: true })
        if (!result) return
        await api.delete(`/api/mcp/perm-groups/${btn.dataset.del}`)
        toast(rqI18n.t('已删除')); drawer.close(); ctx.rerender()
      }
    })
    // 既有权限组的影响预演（W4 交付审计缺口 11：预演入口此前只在新建流程，
    // 「变更既有权限组前先看影响面」无入口）——按该组当前策略 dry-run，不落库
    list.querySelectorAll('[data-impact]').forEach((btn) => {
      btn.onclick = async () => {
        const group = groups.groups.find((g) => g.id === btn.dataset.impact)
        if (!group) return
        try {
          const report = await api.post('/api/mcp/perm-groups/dry-run', {
            name: group.name, description: group.description, policies: group.policies ?? {}, subjects: group.subjects ?? [],
          })
          const modal = openModal({
            title: rqI18n.t('权限组影响预演：{name}', { name: group.name }),
            body: `<div class="form-hint mb-8">${esc(rqI18n.t('按该权限组当前策略预演（不落库）：新增可访问服务 / 涉及写工具 / 高敏数据 / 跨组织暴露。'))}</div>
              <div id="pg-impact-existing">${impactReportHtml(report)}</div>`,
            foot: '<button class="btn btn-primary" data-ok>关闭</button>',
          })
          modal.el.querySelector('[data-ok]').onclick = () => modal.close()
        } catch (error) { toast(rqI18n.t('影响预演暂不可用：{msg}', { msg: error.message }), 'error') }
      }
    })
    // 资源限定 scope 模板（W3-T5 契约 §12 控制台消费面）：按权限组策略生成建议 scope 集
    list.querySelectorAll('[data-scope]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const result = await api.post(`/api/mcp/perm-groups/${btn.dataset.scope}/scope-template`)
          const scopes = result.scopes ?? result.templates ?? []
          const modal = openModal({
            title: rqI18n.t('建议 scope 模板'),
            body: `
              <div class="form-hint mb-8">${esc(rqI18n.t('按该权限组当前策略生成的资源限定 scope（可追加到机器凭证）：mcp.service:<slug>.invoke 服务级 / mcp.tool:<slug>:<tool>.invoke 工具级。'))}</div>
              <div class="code-block" style="white-space:pre-wrap;word-break:break-all">${esc(scopes.length ? scopes.join('\n') : rqI18n.t('（无——该权限组未授权任何服务）'))}</div>`,
            foot: `<button class="btn btn-default" id="pg-scope-copy">${icon('copy', 13)}复制</button><button class="btn btn-primary" data-ok>关闭</button>`,
          })
          modal.el.querySelector('#pg-scope-copy').onclick = () => void copyText(scopes.join('\n'))
          modal.el.querySelector('[data-ok]').onclick = () => modal.close()
        } catch (error) { toast(rqI18n.t('scope 模板暂不可用：{msg}', { msg: error.message }), 'error') }
      }
    })
  }
  renderList()
  drawer.el.querySelector('#pg-add').onclick = () => {
    const agentsPromise = api.get('/api/agents').catch(() => ({ agents: [] }))
    const groupsPromise = api.get('/api/iam/groups').catch(() => ({ groups: [] }))
    const appsPromise = api.get('/api/apps').catch(() => ({ apps: [] }))
    void Promise.all([agentsPromise, groupsPromise, appsPromise]).then(([agentData, groupData, appData]) => {
      // 主体候选：Agent / 用户组 / 应用 三类（与后端 subject 类型对齐）
      const subjectOptions = [
        ...(agentData.agents ?? []).map((a) => ({ value: `agent:${a.id}`, label: `${a.name}（${a.slug ?? a.id}）`, group: 'Agent' })),
        ...(groupData.groups ?? []).map((g) => ({ value: `user_group:${g.id}`, label: g.name, group: '用户组' })),
        ...(appData.apps ?? []).map((a) => ({ value: `app:${a.id}`, label: a.name, group: '应用' })),
      ]
      const modal = openModal({
        title: '新建 MCP 权限组', wide: true,
        body: `
          <div class="form-grid">
            ${field('名称', inputField('name'), { required: true })}
            ${field('描述', inputField('description'))}
          </div>
          <div class="card-title mb-8" style="margin-top:8px">服务与工具策略</div>
          ${services.services.map((s) => `
            <div class="card card-pad mb-8">
              <label class="flex mb-8"><input type="checkbox" data-service="${esc(s.id)}" style="accent-color:var(--brand-500)"><b>${esc(s.name)}</b></label>
              <div class="flex" style="gap:14px;padding-left:24px">
                <label class="flex fs-12"><input type="checkbox" data-ro="${esc(s.id)}" style="accent-color:var(--brand-500)">只读模式（禁止 write/admin 工具）</label>
                <span class="fs-12 text-3">默认放开全部工具</span>
              </div>
            </div>`).join('')}
          <div class="card-title mb-8">绑定主体</div>
          <div class="fs-12 text-3 mb-8" style="margin-top:8px">绑定后主体立即获得对应工具访问权（用户组经 iam 圈人，Agent 按机器身份命中，应用按客户端身份命中）</div>
          ${field('绑定主体（可多选）', multiSelectField('subjects', subjectOptions, { placeholder: '搜索并选择 Agent / 用户组 / 应用，可多选' }))}
          <div id="pg-impact" style="margin-top:8px"></div>`,
        foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-default" data-dryrun>预演影响面</button><button class="btn btn-primary" data-ok>创建</button>',
      })
      mountSearchableSelects(modal.el)
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      // 编辑器草稿 → 后端同构形态（policies / subjects），预演与创建共用同一份采集
      const collectDraft = () => {
        const form = collectForm(modal.body)
        const policies = {}
        modal.body.querySelectorAll('[data-service]:checked').forEach((el) => {
          const serviceId = el.dataset.service
          const ro = modal.body.querySelector(`[data-ro="${serviceId}"]`)?.checked
          policies[serviceId] = { allowedTools: '*', constraints: ro ? { readOnly: true } : {} }
        })
        const subjects = (form.subjects ?? '').split(',').filter(Boolean).map((v) => {
          const idx = v.indexOf(':')
          return { type: v.slice(0, idx), id: v.slice(idx + 1) }
        })
        return { name: form.name, description: form.description, policies, subjects }
      }
      let lastImpact = null
      modal.el.querySelector('[data-dryrun]').onclick = async () => {
        const draft = collectDraft()
        if (!draft.name?.trim()) return toast(rqI18n.t('请先填写权限组名称'), 'error')
        if (!Object.keys(draft.policies).length) return toast(rqI18n.t('请先勾选要授权的服务'), 'error')
        const holder = modal.body.querySelector('#pg-impact')
        holder.innerHTML = `<div class="text-4 fs-12">${esc(rqI18n.t('策略模拟中…'))}</div>`
        try {
          lastImpact = await api.post('/api/mcp/perm-groups/dry-run', draft)
          holder.innerHTML = impactReportHtml(lastImpact)
        } catch (error) {
          lastImpact = null
          holder.innerHTML = `<div class="muted-box fs-12">${esc(rqI18n.t('影响预演暂不可用：{msg}', { msg: error.message }))}</div>`
        }
      }
      modal.el.querySelector('[data-ok]').onclick = async () => {
        const draft = collectDraft()
        if (!draft.name?.trim()) return toast(rqI18n.t('请先填写权限组名称'), 'error')
        if (!Object.keys(draft.policies).length) return toast(rqI18n.t('请先勾选要授权的服务'), 'error')
        // 高危面二次确认（契约 §16「权限变更可预演影响面」）：预演发现写工具 / 高敏数据 / 跨组织时阻断直创
        if (lastImpact && impactIsRisky(lastImpact)) {
          const ack = await confirmDialog({
            title: '高危权限变更确认',
            message: rqI18n.t('影响预演发现本次授权包含<b>写/高危工具、高敏数据或跨组织暴露</b>。确认按此策略创建权限组？'),
            confirmText: '确认创建',
          })
          if (!ack) return
        }
        try {
          await api.post('/api/mcp/perm-groups', draft)
          toast(rqI18n.t('权限组已创建')); modal.close(); drawer.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    })
  }
}

function openTryInvoke(svc, toolName, ctx) {
  const modal = openModal({
    title: rqI18n.t('试调用 · {name}', { name: toolName }),
    body: `
      <div class="muted-box mb-14">通过统一网关调用（鉴权 / 限流 / 审计 / 指标全部生效）。参数以 JSON 输入。</div>
      ${field('参数（JSON）', textareaField('args', { value: '{\n  "query": "演示参数"\n}', rows: 5 }))}`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>调用</button>',
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      let args = {}
      try { args = JSON.parse(collectForm(modal.body).args || '{}') } catch { args = {} }
      const result = await api.post('/api/mcp/invoke', { serviceId: svc.id, tool: toolName, args })
      modal.close()
      openModal({
        title: result.ok ? '调用成功' : rqI18n.t('调用失败（{status}）', { status: result.status }),
        body: `<div class="code-block">${esc(JSON.stringify({ status: result.status, latencyMs: result.latencyMs, version: result.version, result: result.result ?? result.error }, null, 2))}</div>`,
        foot: '<button class="btn btn-primary" data-ok>关闭</button>',
      })
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

// ---------- W3-T6 治理待办 / 凭证迁移 / 服务级端点卡 ----------

/** 服务级数据面错误域码表（契约 §7：拒绝必带领域码，前端提示口径与 agent-onboarding §4.6 一致）。 */
const DATAPLANE_ERRORS = [
  ['-32003', 'AUDIENCE_MISMATCH', '令牌受众与本服务不符：用 audience=mcp:service:<slug> 重新换牌'],
  ['-32003', 'TOOL_NOT_VISIBLE_OR_DENIED', '工具不在你的可见清单或被权限组拒绝（列表即边界，勿硬闯）'],
  ['-32004', 'RATE_LIMITED', '触发限流：稍后重试，不要并发硬闯'],
  ['-32003', 'BREAKER_OPEN', '上游连续失败已熔断：探活恢复后自动闭合'],
  ['-32003', 'SERVICE_OFFLINE', '服务已下线'],
  ['-32003', 'SERVICE_NOT_PUBLISHED', '服务未发布（草稿 / 验证中）'],
  ['-32000', 'SERVICE_NOT_FOUND', '服务不存在（检查 slug）'],
]

/** 治理待办横幅（W1-T2 契约 §5）：unowned / 明文凭证 / 非 gateway 计数 + 可展开清单；空待办不渲染。 */
function governanceBannerHtml(governance) {
  const totals = governance?.totals
  if (!totals) return ''
  const total = (totals.unowned ?? 0) + (totals.plainHeader ?? 0) + (totals.nonGateway ?? 0)
  if (!total) return ''
  return `
    <div class="card card-pad mb-20" style="border-color:var(--warn-border);background:var(--warn-bg)">
      <div class="flex-between" style="flex-wrap:wrap;gap:8px">
        <div class="flex" style="gap:10px;align-items:center;flex-wrap:wrap">
          <span style="color:var(--warn);display:flex">${icon('shieldAlert', 15)}</span>
          <b class="fs-13">${esc(rqI18n.t('治理待办'))}</b>
          <span class="badge badge-warn no-dot">${esc(rqI18n.t('未指派归属 {n}', { n: totals.unowned ?? 0 }))}</span>
          <span class="badge badge-warn no-dot">${esc(rqI18n.t('明文凭证 {n}', { n: totals.plainHeader ?? 0 }))}</span>
          <span class="badge badge-warn no-dot">${esc(rqI18n.t('非 gateway 暴露 {n}', { n: totals.nonGateway ?? 0 }))}</span>
        </div>
        <button class="btn btn-default btn-sm" id="gov-toggle">${esc(rqI18n.t('展开清单'))}</button>
      </div>
      <div id="gov-list" style="display:none;margin-top:10px">${governanceListHtml(governance)}</div>
    </div>`
}

function governanceListHtml(governance) {
  const canWrite = session.can('mcp.service.write')
  const row = (inner) => `<div class="flex" style="padding:5px 0;border-bottom:1px dashed var(--border)">${inner}</div>`
  const unowned = (governance.unowned ?? []).map((item) => row(`
      <span class="fs-13 grow">${esc(item.serviceName)}</span>
      <span class="fs-12 text-3" style="margin-right:8px">${esc(item.reason ?? '')}</span>
      ${canWrite ? `<button class="btn btn-default btn-sm" data-assign="${esc(item.serviceId)}">${icon('user', 12)}${esc(rqI18n.t('指派归属'))}</button>` : ''}`))
  const plain = (governance.plainHeaderServices ?? []).map((item) => row(`
      <span class="fs-13 grow">${esc(item.serviceName)}</span>
      <span class="mono fs-12 text-3" style="margin-right:8px">${esc((item.keys ?? []).join('、'))}</span>
      ${canWrite ? `<button class="btn btn-default btn-sm" data-gov-migrate>${icon('refresh', 12)}${esc(rqI18n.t('迁移'))}</button>` : ''}`))
  const nonGateway = (governance.nonGateway ?? []).map((item) => row(`
      <span class="fs-13 grow">${esc(item.serviceName)}</span>
      <span class="fs-12 text-3">${esc(rqI18n.t('暴露模式：{mode}', { mode: rqI18n.t(exposureLabel(item.exposureMode)) }))}</span>`))
  const group = (title, rows) => `
    <div class="mb-10">
      <div class="fs-12 text-3 mb-4"><b>${esc(title)}</b> · ${rows.length}</div>
      ${rows.join('') || `<div class="text-4 fs-12">${esc(rqI18n.t('无'))}</div>`}
    </div>`
  return group(rqI18n.t('未指派归属'), unowned) + group(rqI18n.t('明文凭证'), plain) + group(rqI18n.t('非 gateway 暴露'), nonGateway)
}

function wireGovernanceBanner(content, governance, ctx) {
  if (!governance?.totals) return
  const toggle = $('#gov-toggle', content)
  if (toggle) toggle.onclick = () => {
    const list = $('#gov-list', content)
    const hidden = list.style.display === 'none'
    list.style.display = hidden ? '' : 'none'
    toggle.textContent = hidden ? rqI18n.t('收起清单') : rqI18n.t('展开清单')
  }
  content.querySelectorAll('[data-assign]').forEach((btn) => {
    btn.onclick = () => {
      const item = (governance.unowned ?? []).find((u) => u.serviceId === btn.dataset.assign)
      if (item) void openAssignOwnerModal(item, ctx)
    }
  })
  content.querySelectorAll('[data-gov-migrate]').forEach((btn) => {
    btn.onclick = () => openCredentialMigrate(ctx)
  })
}

/** 指派归属（快捷通道，契约 §5）：type=app 场景下拉选应用；其余形态走 owner-entity 全量语义由管理页承接。 */
async function openAssignOwnerModal(item, ctx) {
  const appData = await api.get('/api/apps').catch(() => ({ apps: [] }))
  const apps = appData.apps ?? []
  const modal = openModal({
    title: rqI18n.t('指派归属 · {name}', { name: item.serviceName }),
    body: `
      <div class="form-hint mb-8">${esc(rqI18n.t('归属 = 该 MCP 服务的责任主体（成本穿透与治理待办的责任锚点）。此处快捷指派为应用归属；应用经「能力绑定」认领时也会自动回写。'))}</div>
      ${apps.length
        ? field(rqI18n.t('选择应用'), searchableSelectField('appId', apps.map((a) => ({ value: a.id, label: `${a.name}（${a.slug ?? a.id}）` })), { placeholder: rqI18n.t('搜索应用名称 / 标识') }), { required: true })
        : `<div class="muted-box">${esc(rqI18n.t('平台暂无应用可指派（可先注册应用，或由管理员经 owner-entity 端点指派其他主体）。'))}</div>`}`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>指派</button>',
  })
  if (apps.length) mountSearchableSelects(modal.el)
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async () => {
    const appId = collectForm(modal.body).appId
    if (!appId) return toast(rqI18n.t('请选择归属应用'), 'error')
    try {
      await api.post(`/api/mcp/services/${item.serviceId}/owner-entity`, { type: 'app', id: appId })
      toast(rqI18n.t('归属已指派')); modal.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
}

/** 明文凭证迁移（契约 §6）：先 dryRun 预检报告 → 确认执行 → 迁移结果。密钥原文任何一步都不回显。 */
async function openCredentialMigrate(ctx) {
  let report
  try {
    report = await api.post('/api/mcp/credentials/migrate', { dryRun: true })
  } catch (error) { return toast(error.message, 'error') }
  const candidates = report.candidates ?? []
  const modal = openModal({
    title: rqI18n.t('明文凭证迁移（Secret Broker）'),
    body: candidates.length ? `
      <div class="form-hint mb-8">${esc(rqI18n.t('以下服务的请求头含敏感键（Authorization / Token / Secret / Key）。执行迁移后键值转入平台凭证代理（密钥文件 0600），服务记录只留 credentialRef 引用；注入头名取原键名。'))}</div>
      ${candidates.map((c) => `
        <div class="flex" style="padding:6px 0;border-bottom:1px dashed var(--border)">
          <span class="fs-13 grow">${esc(c.serviceName)}</span>
          <span class="mono fs-12 text-3">${esc((c.keys ?? []).join('、'))}</span>
        </div>`).join('')}`
      : `<div class="muted-box" style="display:flex;gap:8px">${icon('check', 15)}<span>${esc(rqI18n.t('未发现明文敏感头，无需迁移。'))}</span></div>`,
    foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>${esc(candidates.length ? rqI18n.t('执行迁移') : rqI18n.t('关闭'))}</button>`,
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    if (!candidates.length) return modal.close()
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      const result = await api.post('/api/mcp/credentials/migrate', {})
      modal.close()
      toast(rqI18n.t('已迁移 {n} 个服务的明文凭证', { n: result.migrated ?? candidates.length }))
      ctx.rerender()
    } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
  }
}

/** 详情抽屉「治理」tab · 归属实体展示（app/agent 反查名称；旧数据缺字段降级为平台占位）。 */
function ownerEntityHtml(svcData, appData, agentData) {
  const oe = svcData.ownerEntity ?? { type: 'platform' }
  if (oe.type === 'platform') return `<span class="badge badge-muted no-dot">${esc(rqI18n.t('平台占位（待指派）'))}</span>`
  const name = oe.type === 'app'
    ? (appData.apps ?? []).find((a) => a.id === oe.id)?.name
    : oe.type === 'agent'
      ? (agentData.agents ?? []).find((a) => a.id === oe.id)?.name
      : undefined
  const cls = { app: 'badge-info', agent: 'badge-purple' }[oe.type] ?? 'badge-muted'
  return `<span class="badge ${cls} no-dot">${esc(rqI18n.t(ownerEntityTypeLabel(oe.type)))}</span>
    <span style="margin-left:6px">${esc(name || oe.id || '—')}</span>`
}

/** 服务级 MCP 端点（契约 §7）：端点 + 最小接入示例 + 错误域码表（折叠）。 */
function dataplaneEndpoint(svc) {
  return `${location.origin}/mcp/services/${svc.slug}`
}

function dataplaneCardHtml(svc) {
  return `
    <div class="card card-pad">
      <div class="flex-between mb-8">
        <div class="card-title">${icon('plugZap', 14)} ${esc(rqI18n.t('服务级 MCP 端点'))}</div>
        <button class="btn btn-default btn-sm" id="dp-copy-endpoint">${icon('copy', 12)}${esc(rqI18n.t('复制端点'))}</button>
      </div>
      <div class="code-block" style="word-break:break-all">POST ${esc(dataplaneEndpoint(svc))}</div>
      <div class="form-hint mt-8">${esc(rqI18n.t('标准 MCP 协议（JSON-RPC 2.0 over POST）：Bearer 令牌须以 audience=mcp:service:<slug> 换取（短时委托令牌，长令牌不出域）；tools/list 按调用方权限过滤，列表即边界。'))}</div>
      <div class="flex mt-8" style="justify-content:space-between;align-items:center">
        <span class="fs-12 text-3">${esc(rqI18n.t('最小接入示例（curl）'))}</span>
        <button class="btn btn-ghost btn-sm" id="dp-copy-snippet">${icon('copy', 12)}${esc(rqI18n.t('复制示例'))}</button>
      </div>
      <div class="code-block" style="white-space:pre-wrap;font-size:11.5px">${esc(dataplaneSnippet(svc))}</div>
      <details style="margin-top:8px">
        <summary class="fs-12 text-3" style="cursor:pointer">${esc(rqI18n.t('错误域码提示表（拒绝一律 JSON-RPC error，按 error.data.code 处理）'))}</summary>
        <table style="width:100%;font-size:12px;margin-top:8px;border-collapse:collapse">
          <thead><tr>${['JSON-RPC', rqI18n.t('域码'), rqI18n.t('含义与处置')].map((head) => `<th class="text-3" style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border)">${esc(head)}</th>`).join('')}</tr></thead>
          <tbody>
            ${DATAPLANE_ERRORS.map(([code, domain, hint]) => `
              <tr>
                <td class="mono" style="padding:4px 6px;border-bottom:1px dashed var(--border)">${code}</td>
                <td class="mono" style="padding:4px 6px;border-bottom:1px dashed var(--border)">${domain}</td>
                <td style="padding:4px 6px;border-bottom:1px dashed var(--border)">${esc(rqI18n.t(hint))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </details>
    </div>`
}

function dataplaneSnippet(svc) {
  const origin = location.origin
  const ep = `${origin}/mcp/services/${svc.slug}`
  return [
    `# ① 机器令牌换服务级委托令牌（audience 绑定本服务，默认 900 秒）`,
    `curl -s -X POST ${origin}/api/authn/token/exchange \\`,
    `  -H "Authorization: Bearer <agent-token>" -H 'content-type: application/json' \\`,
    `  -d '{"audience":"mcp:service:${svc.slug}"}'`,
    ``,
    `# ② initialize 握手（回 mcp-session-id，serverInfo.name=mcp:${svc.slug}）`,
    `curl -s -X POST ${ep} \\`,
    `  -H "Authorization: Bearer <service-token>" -H 'content-type: application/json' \\`,
    `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"my-client","version":"1.0"}}}'`,
    ``,
    `# ③ tools/list（按身份过滤）与 ④ tools/call（统一网关链：鉴权/限流/熔断/审计/计量）`,
    `curl -s -X POST ${ep} -H "Authorization: Bearer <service-token>" \\`,
    `  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'`,
    `curl -s -X POST ${ep} -H "Authorization: Bearer <service-token>" \\`,
    `  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"<工具名>","arguments":{}}}'`,
  ].join('\n')
}

/** 权限组影响预演报告渲染（契约 §14）：newServices / writeTools / confidential / crossOrg / affectedSubjects。
 *  crossOrg 后端为布尔（服务 org × 主体 org 任一错位即 true）——渲染时归一化为单条清单项。 */
function impactIsRisky(report) {
  const confidential = report.confidentialData ?? report.confidential ?? []
  const crossOrg = typeof report.crossOrg === 'boolean' ? report.crossOrg : (report.crossOrg ?? []).length > 0
  return (report.writeTools ?? []).length > 0 || confidential.length > 0 || crossOrg
}

function impactItemText(item) {
  if (typeof item === 'string') return item
  if (item && typeof item === 'object') {
    if (item.tool && item.slug) return `${item.slug} · ${item.tool}`
    return item.name ?? item.tool ?? item.subject ?? item.id ?? JSON.stringify(item)
  }
  return String(item)
}

function impactReportHtml(report) {
  const crossOrg = typeof report.crossOrg === 'boolean'
    ? (report.crossOrg ? [rqI18n.t('存在跨组织的主体/服务组合')] : [])
    : (report.crossOrg ?? [])
  const section = (title, items, tone) => {
    const list = items ?? []
    return `
      <div class="fs-12" style="padding:4px 0"><b>${esc(title)}</b>（${list.length}）
        ${list.length
          ? `<div style="padding-left:10px;padding-top:2px">${list.map((item) => `<span class="badge ${tone} no-dot" style="margin:2px">${esc(impactItemText(item))}</span>`).join('')}</div>`
          : '<span class="text-4" style="margin-left:6px">无</span>'}
      </div>`
  }
  const risky = impactIsRisky(report)
  return `
    <div class="card card-pad" style="background:var(--surface-2)">
      <div class="card-title mb-8">${icon('shield', 14)} ${esc(rqI18n.t('影响预演（dry-run，未落库）'))}</div>
      ${section(rqI18n.t('新增服务'), report.newServices, 'badge-brand')}
      ${section(rqI18n.t('含写/高危工具'), report.writeTools, 'badge-warn')}
      ${section(rqI18n.t('涉高敏数据'), report.confidentialData ?? report.confidential, 'badge-danger')}
      ${section(rqI18n.t('跨组织暴露'), crossOrg, 'badge-danger')}
      ${section(rqI18n.t('受影响主体'), (report.affectedSubjects ?? []).map((s) => (typeof s === 'object' && s ? `${s.name ?? s.id}（${rqI18n.t(subjectLabel(s.type))}）` : s)), 'badge-muted')}
      ${risky ? `<div class="fs-12" style="color:var(--warn);margin-top:6px;display:flex;gap:6px">${icon('alert', 13)}<span>${esc(rqI18n.t('本次变更含高危面（写工具 / 高敏数据 / 跨组织），创建时将二次确认。'))}</span></div>` : ''}
    </div>`
}

function subjectLabel(type) {
  return { user_group: '用户组', agent: 'Agent', app: '应用' }[type] ?? (type ?? '—')
}

// ---------- helpers ----------
function miniStat(ic, label, value, compact) {
  return `
    <div class="${compact ? 'flex' : ''}" style="${compact ? 'background:var(--surface-2);border-radius:10px;padding:12px 14px;gap:10px' : ''}">
      <div class="stat-icon" style="${compact ? 'width:30px;height:30px;margin:0;background:var(--brand-50);color:var(--brand-500)' : 'background:var(--brand-50);color:var(--brand-500)'}">${icon(ic, compact ? 15 : 18)}</div>
      <div>
        <div class="stat-value" style="${compact ? 'font-size:17px' : ''}">${value}</div>
        <div class="stat-label">${esc(label)}</div>
      </div>
    </div>`
}
function svcIcon(ic) {
  const map = { kb: 'book', chart: 'chart', ticket: 'ticket', hr: 'users', fx: 'coins' }
  return icon(map[ic] ?? 'plug', 20)
}
function trafficClass(health) {
  return { healthy: 'traffic-green', degraded: 'traffic-yellow', down: 'traffic-red' }[health] ?? 'traffic-gray'
}
function healthLabel(health) {
  return { healthy: '健康', degraded: '降级', down: '不可用' }[health] ?? '未知'
}
function riskClass(level) {
  return { read: 'badge-ok', write: 'badge-warn', admin: 'badge-danger' }[level] ?? 'badge-muted'
}
function riskLabel(level) {
  return { read: '只读', write: '可写', admin: '高危' }[level] ?? level
}
function versionLabel(status) {
  return { current: '当前版本', previous: '历史版本', 'rolled-back': '已回滚' }[status] ?? status
}
function policyLabel(policy) {
  const tools = policy.allowedTools === '*' ? rqI18n.t('全部工具') : rqI18n.t('{n} 个工具', { n: policy.allowedTools.length })
  return policy.constraints?.readOnly ? rqI18n.t('{tools} · 只读模式', { tools }) : tools
}
function subjectClass(type) {
  return { user_group: 'badge-brand', agent: 'badge-purple', app: 'badge-info' }[type] ?? 'badge-muted'
}
function typeLabel(type) {
  return { agent: 'Agent', app: '应用', skill: 'Skill', mcp_service: 'MCP' }[type] ?? type
}
function dataClassLabel(cls) {
  return { public: '公开', internal: '内部', confidential: '机密' }[cls] ?? (cls ?? '—')
}
function dataClassClass(cls) {
  return { public: 'badge-ok', internal: 'badge-info', confidential: 'badge-danger' }[cls] ?? 'badge-muted'
}
function exposureLabel(mode) {
  return { gateway: '网关统一暴露', direct: '服务级直连', internal: '仅内部调用' }[mode] ?? (mode ?? '—')
}
function visibilityLabel(visibility) {
  return { org: '本组织', tenant: '同租户', 'cross-org': '跨组织（需审批）' }[visibility] ?? (visibility ?? '—')
}
function envStageLabel(env) {
  return { dev: '开发（dev）', staging: '预发（staging）', prod: '生产（prod）' }[env] ?? (env ?? '—')
}
function ownerEntityTypeLabel(type) {
  return { platform: '平台', app: '应用', agent: 'Agent', connector: '连接器' }[type] ?? type
}
/** 敏感头判定（与后端 maskServiceHeaders / SecretBroker 注入同口径）：/authorization|token|secret|key/i。 */
function sensitiveHeaderKeys(headers) {
  return Object.keys(headers ?? {}).filter((k) => /authorization|token|secret|key/i.test(k))
}
function bumpPatch(version) {
  const parts = String(version ?? '1.0.0').replace(/-rc\d+/, '').split('.').map(Number)
  parts[2] = (parts[2] ?? 0) + 1
  return parts.join('.')
}
