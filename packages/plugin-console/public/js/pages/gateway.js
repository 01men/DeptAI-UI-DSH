/** 模型网关（#/gateway · WE 治理域，规格 docs/internal/design-adaptation-spec-20261014.md §5.4）：
 *  分级路由卡列表（模型 × 渠道降级链 主→备1→备2）+ 30d 用量/占比 + 预算熔断进度条 + 渠道探测；
 *  管理员治理（模型目录登记/上下线/删除、渠道组编辑、预算增删改）自 finops 页 #modelgw-card 迁入，
 *  API 动作逐字保留（POST/DELETE /api/modelgw/models、PUT /api/modelgw/channel-groups、PUT/DELETE /api/modelgw/budgets）。
 *  数据源（全部真实接口，零演示数据）：
 *   - /api/modelgw/models（modelgw.read）、/api/modelgw/channel-groups、/api/modelgw/budgets（panel.read，失败各自降级）
 *   - 30d 用量：GET /api/modelgw/routes-usage（WB 并行实现）→ 404 时回落 models 响应内联 usage30d 字段 → 仍无则该列收敛为「待接入」
 *   - 渠道时延/可用性：逐 slug GET /api/modelgw/:slug/telemetry?window=30（panel.read，失败隐藏时延列，不造假） */
import { api, session } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, confirmDialog, collectForm, field, inputField, selectField,
  fmtNum, fmtCost, emptyState, sectionHead, statCard, healthDot, progressBar, emptyHint,
} from '../ui.js'

export async function renderGateway(content, params, ctx) {
  content.innerHTML = '<div style="padding:48px;text-align:center;color:var(--text-3)">模型网关加载中…</div>'
  await mount(content, ctx)
}

async function mount(content, ctx) {
  const data = await loadGatewayData()
  if (data.fatal) {
    const box = h(`<div class="card card-pad"></div>`)
    box.appendChild(emptyState({
      title: data.fatal.status === 403 ? '无模型网关读取权限' : '模型目录加载失败',
      desc: data.fatal.status === 403
        ? '模型目录接口需要 modelgw.read 权限（当前登录身份未授予）；如需查看请联系管理员开通。'
        : rqI18n.t('{msg}（当前宿主可能未部署 modelgw 管理接口）', { msg: data.fatal.message }),
      actionText: '重试', onAction: () => void mount(content, ctx), icon: 'plug',
    }))
    content.innerHTML = ''
    content.appendChild(h(sectionHead({
      label: 'MODEL GATEWAY', title: '模型接入网关',
      extra: '统一模型接入 · 分级路由与渠道降级 · 预算熔断保护',
    })))
    content.appendChild(box)
    return
  }
  const { models, groups, budgets, usage, telemetry } = data
  const canAdmin = session.can('modelgw.admin')
  const canConfig = session.can('panel.config.write')

  // ---- 统计四卡 ----
  const totalTokens30d = usage.reduce((sum, row) => sum + (Number(row.tokens30d) || 0), 0)
  const onlineCount = models.filter((m) => m.status === 'online').length
  const chainSlugs = new Set()
  for (const g of groups) for (const slug of (g.chain?.length ? g.chain : [g.primary, g.backup1, g.backup2].filter(Boolean))) chainSlugs.add(slug)
  const channelCount = chainSlugs.size || models.length
  const enabledBudgets = budgets.filter((b) => b.enabled !== false)
  const blockCount = enabledBudgets.filter((b) => b.action === 'block').length
  const warnPct = enabledBudgets.length ? Math.round(Math.max(...enabledBudgets.map((b) => (Number(b.warnRatio) || 0))) * 100) : null
  const usageMap = new Map(usage.map((row) => [row.model, row]))

  content.innerHTML = `
    ${sectionHead({
      label: 'MODEL GATEWAY',
      title: '模型接入网关',
      extra: 'OpenAI 兼容真实转发 · 分级路由沿「主力 → 备用 → 兜底」降级链切换 · 预算熔断按内部成本参考口径',
      actions: `
        <button class="btn btn-default" id="gw-probe">${icon('zap', 14)} 渠道探测</button>
        ${canAdmin ? `<button class="btn btn-primary" id="gw-model-add">${icon('plus', 14)} 登记 / 更新模型</button>` : ''}`,
    })}
    <div class="stat-grid mb-20">
      ${statCard({
        label: '30d 总消耗',
        value: usage.length ? `<span class="tnum">${fmtNum(totalTokens30d)}</span> <span style="font-size:13px;font-weight:400;color:var(--text-3)">tokens</span>` : '—',
        sub: usage.length ? '近 30 天各路由实测 tokens 合计' : '30d 路由用量数据待接入（routes-usage）',
      })}
      ${statCard({
        label: '路由数',
        value: `<span class="tnum">${models.length}</span>`,
        sub: rqI18n.t('在线 {a} · 离线 {b}', { a: onlineCount, b: models.length - onlineCount }),
      })}
      ${statCard({
        label: '渠道数',
        value: `<span class="tnum">${channelCount}</span>`,
        sub: groups.length ? rqI18n.t('渠道组 {n} 个（主/备/兜底降级链）', { n: groups.length }) : '未配置渠道组（每路由单渠道直连）',
      })}
      ${statCard({
        label: '预算熔断',
        value: enabledBudgets.length ? `<span class="tnum">${enabledBudgets.length}</span> <span style="font-size:13px;font-weight:400;color:var(--text-3)">条规则</span>` : '未配置',
        sub: enabledBudgets.length
          ? rqI18n.t('熔断阻断 {b} 条 · 最高预警比 {w}% · 超限即{action}', { b: blockCount, w: warnPct ?? '—', action: blockCount ? rqI18n.t('熔断并告警') : rqI18n.t('告警') })
          : '暂无预算规则：超限不拦截，仅计量统计',
      })}
    </div>
    <div id="gw-routes"></div>
    <p class="fs-11 text-3" style="margin:14px 2px">
      分级路由：按失败率自动沿「主力 → 备用 → 兜底」降级链切换；预算熔断按价格簿零价快照 + 内部成本参考口径计算（不对外呈现金额结算）。
    </p>
    ${canConfig || canAdmin ? `
    <div class="card card-pad" style="margin-top:6px">
      <div class="card-title" style="margin-bottom:4px">${icon('settings', 15)} 网关治理（管理员通道）</div>
      <div class="fs-12 text-3" style="margin-bottom:12px">模型目录全量表与渠道组 / 预算编辑自财务视图迁入；全部写操作与审计留痕口径不变。</div>
      ${canAdmin ? `
      <div class="card-title" style="margin:0 0 8px;font-size:13px">${icon('plug', 14)} ${esc(rqI18n.t('模型目录（{n}）', { n: models.length }))}</div>
      <div id="gw-model-table"></div>` : ''}
      ${canConfig ? `
      <div class="card-title" style="margin:18px 0 8px;font-size:13px">${icon('gitBranch', 14)} 渠道组（主/备降级链）</div>
      <div id="gw-groups"></div>
      <div class="card-title" style="margin:18px 0 8px;font-size:13px">${icon('coins', 14)} 预算（日/月限额与熔断）</div>
      <div id="gw-budgets"></div>` : ''}
    </div>` : ''}
  `

  // ---- 路由卡列表 ----
  const routesHost = $('#gw-routes')
  if (!models.length) {
    routesHost.innerHTML = emptyHint(canAdmin ? '模型目录为空——点击右上角「登记 / 更新模型」接入第一个模型' : '模型目录为空（登记入口需 modelgw.admin 权限）')
  } else {
    for (const model of models) renderRouteCard(routesHost, model, { models, groups, budgets, usageMap, telemetry, canAdmin, ctx })
  }

  // ---- 渠道探测：重查目录 + 降级链 + 遥测（当前未部署主动拨测端点，不产生真实模型调用） ----
  $('#gw-probe').onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      const fresh = await loadGatewayData({ quiet: true })
      const freshChannels = new Set()
      for (const g of fresh.groups) for (const s of (g.chain ?? [g.primary])) freshChannels.add(s)
      toast(rqI18n.t('路由探测完成：{m} 条路由 · {c} 个渠道已重查（目录与遥测刷新，未产生真实模型调用）', { m: fresh.models.length, c: freshChannels.size || fresh.models.length }))
      await mount(content, ctx)
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn?.classList.remove('btn-loading')
    }
  }

  const addBtn = $('#gw-model-add')
  if (addBtn) addBtn.onclick = () => openModelForm(() => void mount(content, ctx))

  if (canAdmin) mountModelTable(models, () => void mount(content, ctx))
  if (canConfig) {
    void mountChannelGroups(models)
    void mountBudgets(() => void mount(content, ctx))
  }
}

/** 拉取页面全部数据：models 为硬依赖（失败进 fatal），其余各自降级不阻断。 */
async function loadGatewayData({ quiet } = {}) {
  const [modelsRes, groupsRes, budgetsRes, routesUsageRes] = await Promise.allSettled([
    api.get('/api/modelgw/models'),
    api.get('/api/modelgw/channel-groups'),
    api.get('/api/modelgw/budgets'),
    api.get('/api/modelgw/routes-usage'),
  ])
  if (modelsRes.status === 'rejected') {
    if (quiet) throw modelsRes.reason
    return { fatal: modelsRes.reason, models: [], groups: [], budgets: [], usage: [], telemetry: new Map() }
  }
  const models = modelsRes.value?.models ?? []
  const groups = groupsRes.status === 'fulfilled' ? (groupsRes.value?.groups ?? []) : []
  const budgets = budgetsRes.status === 'fulfilled' ? (budgetsRes.value?.budgets ?? []) : []

  // 30d 路由用量：routes-usage 优先 → models 响应内联 usage30d 回落 → 均无则空（页面收敛为「待接入」，不造假）
  let usage = []
  if (routesUsageRes.status === 'fulfilled') usage = routesUsageRes.value?.routes ?? []
  else if (models.some((m) => m.usage30d != null || m.tokens30d != null)) {
    usage = models.map((m) => ({ model: m.slug, tokens30d: m.tokens30d ?? m.usage30d?.tokens ?? 0, share: m.usage30d?.share ?? null, cost30d: m.usage30d?.cost ?? 0 }))
  }

  // 逐 slug 遥测（panel.read）：链上出现的去重 slug，上限 16 条防请求风暴；失败静默降级
  const slugs = new Set(models.map((m) => m.slug))
  for (const g of groups) for (const s of (g.chain?.length ? g.chain : [g.primary, g.backup1, g.backup2].filter(Boolean))) slugs.add(s)
  const telemetry = new Map()
  await Promise.all([...slugs].slice(0, 16).map(async (slug) => {
    try {
      const tel = await api.get(`/api/modelgw/${encodeURIComponent(slug)}/telemetry?window=30`)
      if (tel) telemetry.set(slug, tel)
    } catch { /* panel.read 缺失或宿主未部署：隐藏时延/降级列 */ }
  }))
  return { fatal: null, models, groups, budgets, usage, telemetry }
}

// ---------- 路由卡（模型 × 降级链渠道横排） ----------

const CH_KIND_STYLE = {
  主力: 'color:#b91c1c;background:rgba(192,32,32,0.10)',
  备用: 'color:var(--warn-strong);background:rgba(245,158,11,0.12)',
  兜底: 'color:var(--text-3);background:var(--surface-2)',
}

/** 渠道卡状态：离线→待机；有降级记录→降级中（呼吸点）；有调用量→承接流量；否则待机。全部由真实遥测/目录状态推导。 */
function channelState(slug, models, telemetry) {
  const model = models.find((m) => m.slug === slug)
  const tel = telemetry.get(slug)
  if (!model || model.status !== 'online') return { state: 'standby', dot: 'dot-off', label: model ? '待机' : '未登记', pulse: false }
  if (tel?.degradedInvocations > 0) return { state: 'degraded', dot: 'dot-warn', label: '降级中', pulse: true }
  if (tel && tel.invocations > 0) return { state: 'active', dot: 'dot-ok', label: '承接流量', pulse: false }
  return { state: 'standby', dot: 'dot-off', label: '待机', pulse: false }
}

function renderRouteCard(host, model, { models, groups, budgets, usageMap, telemetry, canAdmin, ctx }) {
  const group = groups.find((g) => g.primary === model.slug) ?? null
  const chain = group
    ? [group.primary, group.backup1, group.backup2].filter(Boolean)
    : [model.slug]
  const tel = telemetry.get(model.slug)
  const usage = usageMap.get(model.slug)

  // 路由健康：离线 → offline；可用率 < 95% → warning；其余在线即 healthy（遥测缺失时诚实按目录状态）
  const health = model.status !== 'online'
    ? 'offline'
    : (tel?.availability != null && tel.availability < 0.95 ? 'warning' : 'healthy')

  // 预算熔断：命中该 slug 的启用预算（精确 slug 优先，其次 '*'，再次未指定模型的组织级）；cost30d（元）对比月限额（分→元）
  const enabled = budgets.filter((b) => b.enabled !== false)
  const budget = enabled.find((b) => b.modelSlug === model.slug)
    ?? enabled.find((b) => b.modelSlug === '*')
    ?? enabled.find((b) => !b.modelSlug)
  let budgetHtml = '<span class="fs-11 text-4">未设预算</span>'
  if (budget) {
    const limitYuan = (Number(budget.monthlyLimitCents) || 0) / 100
    const usedYuan = (Number(usage?.cost30d) || 0) / 100 // routes-usage 的 cost30d 为内部成本参考分（usage 事件聚合口径）
    const pct = limitYuan > 0 ? (usedYuan / limitYuan) * 100 : null
    budgetHtml = pct != null
      ? progressBar(pct, {
        tone: pct > 70 ? 'warn' : '',
        width: '150px',
        label: `${Math.round(pct)}/${Math.round((budget.warnRatio ?? 0.8) * 100)}%`,
      }) + `<span class="fs-11 text-3" style="margin-left:6px">${esc(rqI18n.t('月限 {cost}', { cost: fmtCost(limitYuan) }))}</span>`
      : `<span class="fs-11 text-3">${esc(rqI18n.t('月限 {cost} · 用量待接入', { cost: fmtCost(limitYuan) }))}</span>`
  }

  const card = h(`
  <div class="card card-pad mb-12 fade-up">
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px">
      <span style="color:var(--${health === 'healthy' ? 'ok' : health === 'warning' ? 'warn' : 'text-4'});display:inline-flex">${icon('gitBranch', 16)}</span>
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:14.5px;font-weight:600">${esc(group?.name ?? model.displayName ?? model.slug)}</span>
          <span class="mono" style="background:var(--surface-2);border-radius:6px;padding:2px 7px;font-size:11px">${esc(model.slug)}</span>
          ${healthDot(health)}
          ${tel?.degradedInvocations > 0 ? `<span class="badge badge-warn no-dot">${icon('alert', 11)}${esc(rqI18n.t(' 30d 降级 {n} 次', { n: tel.degradedInvocations }))}</span>` : ''}
          ${group && group.enabled === false ? '<span class="badge badge-muted no-dot">渠道组停用</span>' : ''}
        </div>
        <div class="fs-11-5 text-3" style="margin-top:3px">
          ${usage
            ? `30d <span class="tnum mono">${fmtNum(usage.tokens30d ?? 0)}</span> tokens · 占比 <span class="tnum mono">${usage.share != null ? `${usage.share}%` : '—'}</span>`
            : '30d 用量待接入（routes-usage 未返回该路由）'}
          ${tel?.availability != null ? ` · 可用率 <span class="tnum mono">${Math.round(tel.availability * 100)}%</span>` : ''}
        </div>
      </div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:180px;justify-content:flex-end">
        <span style="color:var(--text-3);display:inline-flex">${icon('activity', 13)}</span>
        ${budgetHtml}
      </div>
      ${canAdmin ? `
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-default btn-sm stop" data-gw-toggle>${model.status === 'online' ? '下线' : '上线'}</button>
        <button class="btn btn-danger-ghost btn-sm stop" data-gw-del title="删除模型">${icon('trash', 12)}</button>
      </div>` : ''}
    </div>
    <div style="margin-top:14px;display:flex;flex-wrap:wrap;align-items:stretch;gap:8px">
      ${chain.map((slug, index) => {
        const st = channelState(slug, models, telemetry)
        const tel2 = telemetry.get(slug)
        const kind = index === 0 ? '主力' : index === 1 ? '备用' : '兜底'
        const border = st.state === 'active' ? 'var(--ok-border, #a7f3d0)' : st.state === 'degraded' ? 'var(--warn-border, #fcd9a4)' : 'var(--border)'
        const bg = st.state === 'active' ? 'rgba(5,150,105,0.04)' : st.state === 'degraded' ? 'rgba(245,158,11,0.06)' : 'var(--surface-2)'
        return `
        <div style="display:flex;align-items:center;gap:8px">
          <div style="min-width:172px;border:1px solid ${border};background:${bg};border-radius:8px;padding:9px 12px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;min-width:0">
                <span class="dot ${st.dot}${st.pulse ? ' pulse' : ''}"></span><span class="ellipsis" style="max-width:110px">${esc(models.find((m) => m.slug === slug)?.displayName ?? slug)}</span>
              </span>
              <span style="font-size:10px;font-weight:600;padding:1px 5px;border-radius:4px;${CH_KIND_STYLE[kind]}">${kind}</span>
            </div>
            <div style="margin-top:5px;display:flex;justify-content:space-between;font-size:10.5px;color:var(--text-3)">
              <span>${st.label}</span>
              <span class="mono tnum">${tel2?.p50LatencyMs != null ? `P50 ${tel2.p50LatencyMs}ms` : '时延 —'}</span>
            </div>
          </div>
          ${index < chain.length - 1 ? `<span style="color:var(--text-4)">${icon('chevronRight', 14)}</span>` : ''}
        </div>`
      }).join('')}
    </div>
    ${chain.length === 1 ? `<div class="fs-11 text-4" style="margin-top:8px">该路由未配置渠道组：单渠道直连，失败不降级（可在下方「渠道组」为其配置主/备链）。</div>` : ''}
  </div>`)
  const toggleBtn = card.querySelector('[data-gw-toggle]')
  if (toggleBtn) toggleBtn.onclick = () => toggleModel(model, () => ctx.rerender())
  const delBtn = card.querySelector('[data-gw-del]')
  if (delBtn) delBtn.onclick = () => deleteModel(model, () => ctx.rerender())
  host.appendChild(card)
}

/** 上下线切换：POST 全量 upsert（回传既有字段防默认值覆盖，apiKey 仅 env: 形式回传）——与 finops 旧逻辑逐字一致。 */
async function toggleModel(model, onDone) {
  const payload = {
    slug: model.slug,
    displayName: model.displayName ?? model.slug,
    provider: model.provider ?? 'external',
    endpoint: model.endpoint ?? '',
    costCentsPerKTokens: model.costCentsPerKTokens ?? 0,
    ...(model.inputCostCentsPerKTokens !== undefined ? { inputCostCentsPerKTokens: model.inputCostCentsPerKTokens } : {}),
    status: model.status === 'online' ? 'offline' : 'online',
    ...(model.dataClassLimit ? { dataClassLimit: model.dataClassLimit } : {}),
    ...(typeof model.apiKey === 'string' && model.apiKey.startsWith('env:') ? { apiKey: model.apiKey } : {}),
  }
  try {
    await api.post('/api/modelgw/models', payload)
    toast(payload.status === 'online' ? rqI18n.t('模型 {slug} 已上线', { slug: model.slug }) : rqI18n.t('模型 {slug} 已下线', { slug: model.slug }))
    onDone()
  } catch (error) { toast(error.message, 'error') }
}

async function deleteModel(model, onDone) {
  const confirmed = await confirmDialog({
    title: rqI18n.t('删除模型 · {slug}', { slug: model.slug }), danger: true, confirmText: '确认删除',
    message: rqI18n.t('将从模型目录删除「<b>{slug}</b>」，引用它的调用与渠道组会失去主/备路由，操作不可恢复。', { slug: esc(model.slug) }),
  })
  if (!confirmed) return
  try {
    await api.delete(`/api/modelgw/models/${encodeURIComponent(model.id ?? model.slug)}`)
    toast(rqI18n.t('模型已删除'))
    onDone()
  } catch (error) { toast(error.message, 'error') }
}

// ---------- 管理员治理：模型目录全量表（自 finops mountModelCatalog 迁入，交互不变） ----------

function emptyRow(cols, text) {
  return `<tr><td colspan="${cols}"><div class="tbl-empty">${icon('plug', 28)}<span>${esc(text)}</span></div></td></tr>`
}

function mountModelTable(models, rerender) {
  const host = $('#gw-model-table')
  host.innerHTML = `
    <div class="table-wrap">
      <table class="tbl">
        <thead><tr><th>slug</th><th>显示名</th><th>provider</th><th>状态</th><th>数据密级</th><th style="text-align:right">成本（分/千tokens）</th><th style="text-align:right">输入成本（分/千tokens）</th><th>endpoint</th><th>操作</th></tr></thead>
        <tbody>
          ${models.length ? models.map((m) => `
            <tr data-id="${esc(m.id ?? '')}" data-slug="${esc(m.slug)}">
              <td class="mono fs-12">${esc(m.slug)}</td>
              <td class="fs-12">${esc(m.displayName ?? m.display_name ?? '—')}</td>
              <td class="fs-12">${esc(m.provider ?? '—')}</td>
              <td>${m.status === 'online' ? '<span class="badge badge-ok no-dot">在线</span>' : '<span class="badge badge-muted no-dot">离线</span>'}</td>
              <td class="fs-12">${esc(m.dataClassLimit ?? '—')}</td>
              <td class="col-num fs-12" style="text-align:right">${m.costCentsPerKTokens ?? m.cost_cents_per_k_tokens ?? '—'}</td>
              <td class="col-num fs-12" style="text-align:right">${m.inputCostCentsPerKTokens ?? m.input_cost_cents_per_k_tokens ?? '—'}</td>
              <td class="mono fs-11 text-3 ellipsis" style="max-width:200px" title="${esc(m.endpoint ?? '')}">${esc(m.endpoint ?? '—')}</td>
              <td><div class="flex" style="gap:6px">
                <button class="btn btn-default btn-sm stop" data-mg-toggle="${esc(m.id ?? m.slug)}" data-next="${m.status === 'online' ? 'offline' : 'online'}">${m.status === 'online' ? '下线' : '上线'}</button>
                <button class="btn btn-danger-ghost btn-sm stop" data-mg-del="${esc(m.id ?? '')}" data-slug="${esc(m.slug)}">${icon('trash', 12)}</button>
              </div></td>
            </tr>`).join('') : emptyRow(9, '模型目录为空——登记第一个模型接入统一网关')}
        </tbody>
      </table>
    </div>`
  host.querySelectorAll('[data-mg-toggle]').forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest('tr')
      const slug = row.dataset.slug
      const record = models.find((m) => m.slug === slug) ?? {}
      const payload = {
        slug,
        displayName: record.displayName ?? slug,
        provider: record.provider ?? 'external',
        endpoint: record.endpoint ?? '',
        costCentsPerKTokens: record.costCentsPerKTokens ?? 0,
        ...(record.inputCostCentsPerKTokens !== undefined ? { inputCostCentsPerKTokens: record.inputCostCentsPerKTokens } : {}),
        status: btn.dataset.next,
        ...(record.dataClassLimit ? { dataClassLimit: record.dataClassLimit } : {}),
        ...(typeof record.apiKey === 'string' && record.apiKey.startsWith('env:') ? { apiKey: record.apiKey } : {}),
      }
      try {
        await api.post('/api/modelgw/models', payload)
        toast(btn.dataset.next === 'online' ? rqI18n.t('模型 {slug} 已上线', { slug }) : rqI18n.t('模型 {slug} 已下线', { slug }))
        rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  })
  host.querySelectorAll('[data-mg-del]').forEach((btn) => {
    btn.onclick = async () => {
      const confirmed = await confirmDialog({
        title: rqI18n.t('删除模型 · {slug}', { slug: btn.dataset.slug }), danger: true, confirmText: '确认删除',
        message: rqI18n.t('将从模型目录删除「<b>{slug}</b>」，引用它的调用与渠道组会失去主/备路由，操作不可恢复。', { slug: esc(btn.dataset.slug) }),
      })
      if (!confirmed) return
      try {
        await api.delete(`/api/modelgw/models/${btn.dataset.mgDel}`)
        toast(rqI18n.t('模型已删除'))
        rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  })
}

/** 登记/更新模型抽屉（POST /api/modelgw/models，同 slug 即更新；apiKey 提示 env:VAR_NAME 形式）——自 finops 迁入。 */
function openModelForm(rerender) {
  const drawer = openDrawer({
    title: '登记 / 更新模型',
    sub: '统一网关按 slug 路由；重复 slug 提交即为更新',
    body: `
      <div class="form-grid">
        ${field('slug', inputField('slug', { placeholder: '如 deepseek-v3 / qwen3-max' }), { required: true })}
        ${field('显示名', inputField('displayName', { placeholder: '如 DeepSeek V3' }))}
        ${field('provider', inputField('provider', { placeholder: '如 deepseek / openai / azure' }))}
        ${field('endpoint', inputField('endpoint', { placeholder: 'https://api.example.com/v1' }), { full: true })}
        ${field('apiKey', inputField('apiKey', { placeholder: 'env:DEEPSEEK_API_KEY' }), { full: true, hint: '推荐 env:VAR_NAME 形式引用宿主环境变量，避免明文落库' })}
        ${field('成本（分/千tokens）', `<input class="input" type="number" step="any" name="costCentsPerKTokens" placeholder="如 12 = ¥0.12/千tokens">`)}
        ${field('输入成本（分/千tokens）', `<input class="input" type="number" step="any" name="inputCostCentsPerKTokens" placeholder="如 2 = ¥0.02/千tokens（#14 输入 token 单独计价）">`)}
        ${field('状态', selectField('status', [{ value: 'online', label: '在线' }, { value: 'offline', label: '离线' }]))}
        ${field('数据密级上限', selectField('dataClassLimit', [
          { value: 'public', label: 'public（仅公开数据）' },
          { value: 'internal', label: 'internal（内部数据可用）' },
          { value: 'secret', label: 'secret（可处理机密）' },
        ]), { hint: '超出密级的数据类任务不会路由到该模型' })}
      </div>`,
    foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>`,
  })
  drawer.el.querySelector('[data-cancel]').onclick = () => drawer.close()
  drawer.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const data = collectForm(drawer.body)
    if (!data.slug) return toast(rqI18n.t('请填写模型 slug'), 'error')
    const payload = {
      slug: data.slug,
      displayName: data.displayName || undefined,
      provider: data.provider || undefined,
      endpoint: data.endpoint || undefined,
      apiKey: data.apiKey || undefined,
      status: data.status || 'online',
      dataClassLimit: data.dataClassLimit || undefined,
    }
    if (data.costCentsPerKTokens !== '') payload.costCentsPerKTokens = Number(data.costCentsPerKTokens)
    if (data.inputCostCentsPerKTokens !== '') payload.inputCostCentsPerKTokens = Number(data.inputCostCentsPerKTokens)
    btn.classList.add('btn-loading')
    try {
      await api.post('/api/modelgw/models', payload)
      toast(rqI18n.t('模型目录已保存'))
      drawer.close(); rerender()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

/** 渠道组：主/备1/备2 三级降级链编辑 + 整体保存（PUT /api/modelgw/channel-groups）——自 finops 迁入。 */
async function mountChannelGroups(models) {
  const host = $('#gw-groups')
  if (!host) return
  let groups = []
  try {
    const data = await api.get('/api/modelgw/channel-groups')
    groups = data?.groups ?? []
  } catch (error) {
    host.innerHTML = `<div class="fs-12 text-4" style="padding:10px 0">${esc(rqI18n.t('渠道组加载失败：{msg}', { msg: error.message }))}</div>`
    return
  }
  const slugOptions = (value) => [
    { value: '', label: '（无）' },
    ...models.map((m) => ({ value: m.slug, label: m.slug })),
  ].map((opt) => `<option value="${esc(opt.value)}" ${opt.value === (value ?? '') ? 'selected' : ''}>${esc(opt.label)}</option>`).join('')

  host.innerHTML = groups.length ? `
    <div class="table-wrap">
      <table class="tbl">
        <thead><tr><th>渠道组</th><th>主通道</th><th>备 1</th><th>备 2</th><th>启用</th></tr></thead>
        <tbody>
          ${groups.map((g, i) => `
            <tr data-i="${i}">
              <td><div class="col-strong">${esc(g.name ?? g.slug)}</div><div class="col-sub mono fs-11">${esc(g.slug)}</div></td>
              <td><select class="select" data-field="primary">${slugOptions(g.primary)}</select></td>
              <td><select class="select" data-field="backup1">${slugOptions(g.backup1)}</select></td>
              <td><select class="select" data-field="backup2">${slugOptions(g.backup2)}</select></td>
              <td><input type="checkbox" data-field="enabled" ${g.enabled ? 'checked' : ''} style="accent-color:var(--brand-500)"></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="flex" style="justify-content:flex-end;margin-top:10px"><button class="btn btn-primary btn-sm" id="gw-groups-save">保存渠道组</button></div>` : `<div class="fs-12 text-4" style="padding:10px 0">暂无渠道组配置</div>`

  host.querySelector('#gw-groups-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    const next = [...host.querySelectorAll('tbody tr')].map((tr) => {
      const group = groups[Number(tr.dataset.i)]
      return {
        ...group,
        primary: tr.querySelector('[data-field="primary"]').value,
        backup1: tr.querySelector('[data-field="backup1"]').value,
        backup2: tr.querySelector('[data-field="backup2"]').value,
        enabled: tr.querySelector('[data-field="enabled"]').checked,
      }
    })
    btn.classList.add('btn-loading')
    try {
      await api.put('/api/modelgw/channel-groups', { groups: next })
      toast(rqI18n.t('渠道组已保存'))
    } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
  })
}

/** 预算：列表 + 新增/编辑抽屉（组织下拉 / slug 通配 / 主体 / 日月限额分 / 预警比 / warn|block / 冻结联动）——自 finops 迁入。 */
async function mountBudgets(rerender) {
  const host = $('#gw-budgets')
  if (!host) return
  let budgets = []
  try {
    const data = await api.get('/api/modelgw/budgets')
    budgets = data?.budgets ?? []
  } catch (error) {
    host.innerHTML = `<div class="fs-12 text-4" style="padding:10px 0">${esc(rqI18n.t('预算加载失败：{msg}', { msg: error.message }))}</div>`
    return
  }
  const yuan = (cents) => fmtCost((Number(cents ?? 0) || 0) / 100)

  host.innerHTML = `
    <div class="flex" style="justify-content:flex-end;margin-bottom:8px"><button class="btn btn-default btn-sm" id="gw-budget-add">${icon('plus', 12)} 新增预算</button></div>
    <div class="table-wrap">
      <table class="tbl">
        <thead><tr><th>组织</th><th>模型</th><th>主体</th><th style="text-align:right">日限额</th><th style="text-align:right">月限额</th><th>预警比</th><th>动作</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          ${budgets.length ? budgets.map((b) => `
            <tr data-id="${esc(b.id)}">
              <td class="fs-12">${esc(b.orgId || '（平台级）')}</td>
              <td class="mono fs-12">${esc(b.modelSlug || '*')}</td>
              <td class="mono fs-11">${esc(b.subject || '（组织级）')}</td>
              <td class="col-num fs-12" style="text-align:right">${b.dailyLimitCents != null ? yuan(b.dailyLimitCents) : '—'}</td>
              <td class="col-num fs-12" style="text-align:right">${b.monthlyLimitCents != null ? yuan(b.monthlyLimitCents) : '—'}</td>
              <td class="col-num fs-12">${b.warnRatio != null ? `${Math.round(b.warnRatio * 100)}%` : '—'}</td>
              <td>${b.action === 'block' ? '<span class="badge badge-danger no-dot">超额阻断</span>' : '<span class="badge badge-warn no-dot">超额告警</span>'}</td>
              <td>${b.enabled ? '<span class="badge badge-ok no-dot">启用</span>' : '<span class="badge badge-muted no-dot">停用</span>'}${b.freezeAgent ? '<span class="badge badge-purple no-dot" style="margin-left:4px" title="超额时联动冻结相关 Agent">联动冻结</span>' : ''}</td>
              <td><div class="flex" style="gap:6px">
                <button class="btn btn-default btn-sm stop" data-bedit="${esc(b.id)}">编辑</button>
                <button class="btn btn-danger-ghost btn-sm stop" data-bdel="${esc(b.id)}">${icon('trash', 12)}</button>
              </div></td>
            </tr>`).join('') : emptyRow(9, '暂无预算规则——为组织或 Agent 设置日/月限额与熔断动作')}
        </tbody>
      </table>
    </div>`

  host.querySelector('#gw-budget-add').onclick = () => void openBudgetForm(null, () => void mountBudgets(rerender))
  host.querySelectorAll('[data-bedit]').forEach((btn) => {
    btn.onclick = () => {
      const budget = budgets.find((b) => b.id === btn.dataset.bedit)
      void openBudgetForm(budget, () => void mountBudgets(rerender))
    }
  })
  host.querySelectorAll('[data-bdel]').forEach((btn) => {
    btn.onclick = async () => {
      const confirmed = await confirmDialog({
        title: '删除预算规则', danger: true, confirmText: '确认删除',
        message: '删除后该维度的用量不再受限额约束（仅计费统计不受影响）。',
      })
      if (!confirmed) return
      try {
        await api.delete(`/api/modelgw/budgets/${btn.dataset.bdel}`)
        toast(rqI18n.t('预算规则已删除'))
        void mountBudgets(rerender)
      } catch (error) { toast(error.message, 'error') }
    }
  })
}

/** 预算新增/编辑抽屉（PUT /api/modelgw/budgets 保存）——自 finops 迁入。 */
async function openBudgetForm(budget, onSaved) {
  let orgs = []
  try {
    const data = await api.get('/api/iam/orgs')
    orgs = Array.isArray(data) ? data : (data?.orgs ?? [])
  } catch { /* 组织下拉失败时仍可手填 */ }
  const drawer = openDrawer({
    title: budget ? '编辑预算' : '新增预算',
    sub: '按组织 / 模型 / 主体三维度限定额度和超额动作',
    body: `
      <div class="form-grid">
        ${field('组织', selectField('orgId', [{ value: '', label: '（平台级 · 全组织）' }, ...orgs.map((o) => ({ value: o.id, label: o.name }))], { value: budget?.orgId ?? '' }), { full: true })}
        ${field('模型 slug', inputField('modelSlug', { value: budget?.modelSlug, placeholder: '如 deepseek-v3' }), { hint: '留空 = 全模型；* 可作通配（如 team-*）' })}
        ${field('主体 subject', inputField('subject', { value: budget?.subject, placeholder: '留空 = 组织级' }), { hint: 'Agent 级预算填 agent:AGENT_ID' })}
        ${field('日限额（分）', `<input class="input" type="number" name="dailyLimitCents" min="0" value="${esc(budget?.dailyLimitCents ?? '')}" placeholder="如 1234">`, { hint: '按分录入，如 1234 = ¥12.34/日' })}
        ${field('月限额（分）', `<input class="input" type="number" name="monthlyLimitCents" min="0" value="${esc(budget?.monthlyLimitCents ?? '')}" placeholder="如 30000">`, { hint: '按分录入，如 30000 = ¥300/月' })}
        ${field('预警比', `<input class="input" type="number" step="0.01" min="0" max="1" name="warnRatio" value="${esc(budget?.warnRatio ?? 0.8)}">`, { hint: '用量/限额 ≥ 该比例发预算告警，0.8 = 80%' })}
        ${field('超额动作', selectField('action', [
          { value: 'warn', label: 'warn（告警，不拦截）' },
          { value: 'block', label: 'block（熔断阻断调用）' },
        ], { value: budget?.action ?? 'warn' }))}
      </div>
      <label class="flex" style="gap:8px;align-items:center;cursor:pointer;margin-bottom:8px">
        <input type="checkbox" name="enabled" ${budget?.enabled !== false ? 'checked' : ''} style="accent-color:var(--brand-500)">
        <span class="fs-12 text-2">启用该预算</span>
      </label>
      <label class="flex" style="gap:8px;align-items:center;cursor:pointer">
        <input type="checkbox" name="freezeAgent" ${budget?.freezeAgent ? 'checked' : ''} style="accent-color:var(--brand-500)">
        <span class="fs-12 text-2">超额联动冻结相关 Agent（block 熔断时生效）</span>
      </label>`,
    foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>`,
  })
  drawer.el.querySelector('[data-cancel]').onclick = () => drawer.close()
  drawer.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const data = collectForm(drawer.body)
    if (data.dailyLimitCents === '' && data.monthlyLimitCents === '') return toast(rqI18n.t('日/月限额至少填一项'), 'error')
    const payload = {
      ...(budget?.id ? { id: budget.id } : {}),
      orgId: data.orgId || undefined,
      modelSlug: data.modelSlug || undefined,
      subject: data.subject || undefined,
      dailyLimitCents: data.dailyLimitCents === '' ? undefined : Number(data.dailyLimitCents),
      monthlyLimitCents: data.monthlyLimitCents === '' ? undefined : Number(data.monthlyLimitCents),
      warnRatio: data.warnRatio === '' ? undefined : Number(data.warnRatio),
      action: data.action || 'warn',
      enabled: Boolean(data.enabled),
      freezeAgent: Boolean(data.freezeAgent),
    }
    btn.classList.add('btn-loading')
    try {
      await api.put('/api/modelgw/budgets', payload)
      toast(rqI18n.t('预算已保存'))
      drawer.close(); onSaved()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}
