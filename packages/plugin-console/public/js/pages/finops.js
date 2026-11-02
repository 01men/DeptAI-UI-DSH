/** FinOps 财务视图（M2 CFO 视图 v1）：成本穿透 + 环比 + 空转检测，内部成本参考口径。 */
import { api, session } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import { $, esc, toast, fmtNum, fmtCost, openDrawer, collectForm, field, inputField, selectField, confirmDialog } from '../ui.js'

/** 环比徽标：涨红降绿（成本视角），无可比基数显示 —。 */
function deltaBadge(deltaPct) {
  if (deltaPct === null || deltaPct === undefined) return '<span class="fs-12 text-4">—</span>'
  if (deltaPct === 0) return '<span class="fs-12 text-4">持平</span>'
  const up = deltaPct > 0
  return `<span class="badge no-dot" style="${up ? 'background:var(--danger-bg);color:#b91c1c' : 'background:var(--ok-bg);color:#047857'}">${up ? icon('arrowUp', 11) : icon('arrowDown', 11)} ${Math.abs(deltaPct)}%</span>`
}

function emptyRow(cols, text) {
  return `<tr><td colspan="${cols}"><div class="tbl-empty">${icon('chart', 28)}<span>${esc(text)}</span></div></td></tr>`
}

export async function renderFinops(content, params, { rerender }) {
  const month = params.get('month') || new Date().toISOString().slice(0, 7)
  let data
  try {
    data = await api.get(`/api/finops/overview?month=${encodeURIComponent(month)}`)
  } catch (error) {
    content.innerHTML = `
      <div class="page-head"><div><div class="page-title">FinOps 财务视图</div></div></div>
      <div class="card"><div class="card-body"><div class="tbl-empty">${icon('alert', 28)}<span>${esc(rqI18n.t('报表加载失败：{msg}', { msg: error.message }))}</span></div>
      <div style="text-align:center"><button class="btn" id="finops-retry">${icon('refresh', 14)} 重试</button></div></div></div>`
    $('#finops-retry').onclick = () => rerender()
    return
  }
  const { penetration, idle } = data
  const dimTotal = penetration.totals

  const modelCount = penetration.byModel.length
  const orgCount = penetration.byOrg.length

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">FinOps 财务视图</div>
        <div class="page-desc">给管理者的一页纸：钱花在哪（部门 × 模型成本穿透）、花得值不值（空转检测）。
        金额为<b>内部成本参考</b>（零价快照口径，不对外结算）。</div>
      </div>
      <div class="page-actions">
        <input type="month" id="finops-month" class="input" style="width:auto" value="${esc(month)}" max="${esc(new Date().toISOString().slice(0, 7))}">
        <a class="btn" id="finops-csv" href="/api/finops/report/monthly?month=${encodeURIComponent(month)}&format=csv" title="导出本报表 CSV（Excel 可直接打开）">${icon('download', 14)} 导出 CSV</a>
      </div>
    </div>

    <div class="stat-grid mb-20">
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--purple-bg);color:#6d28d9">${icon('coins', 18)}</div>
        <div class="stat-value">${fmtCost(dimTotal.cost_cents / 100)}</div>
        <div class="stat-label">本月内部成本</div>
        <div class="stat-foot">${esc(rqI18n.t('上月同期 {cost}', { cost: fmtCost(dimTotal.prev_cost_cents / 100) }))} · ${deltaBadge(dimTotal.delta_pct)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--brand-50);color:var(--brand-500)">${icon('zap', 18)}</div>
        <div class="stat-value">${fmtNum(dimTotal.events)}</div>
        <div class="stat-label">计量事件</div>
        <div class="stat-foot">${esc(rqI18n.t('tokens 合计 {n}', { n: fmtNum(dimTotal.tokens) }))}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:${idle.idle.cost_cents > 0 ? 'var(--danger-bg)' : 'var(--ok-bg)'};color:${idle.idle.cost_cents > 0 ? '#b91c1c' : '#047857'}">${icon('wifi', 18)}</div>
        <div class="stat-value">${fmtCost(idle.idle.cost_cents / 100)}</div>
        <div class="stat-label">疑似空转成本</div>
        <div class="stat-foot">${esc(rqI18n.t('占模型调用成本 {p}% · {n} 次调用', { p: idle.idle.share_pct, n: idle.idle.events }))}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--ok-bg);color:#047857">${icon('building', 18)}</div>
        <div class="stat-value">${orgCount} <span class="fs-14 text-4">部门</span> / ${modelCount} <span class="fs-14 text-4">模型</span></div>
        <div class="stat-label">参与消耗的维度</div>
        <div class="stat-foot">${modelCount > 0 ? esc(rqI18n.t('成本最高模型：{model}', { model: penetration.byModel[0].dimension })) : '本月暂无模型消耗'}</div>
      </div>
    </div>

    <div class="grid-2 mb-20" style="grid-template-columns:1.4fr 1fr;align-items:start">
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('building', 15)} 部门成本穿透</span><span class="card-sub">${esc(penetration.month)}${esc(rqI18n.t(' · 按成本降序'))}</span></div>
        <div class="card-body" style="padding-top:6px">
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>部门</th><th style="text-align:right">调用</th><th style="text-align:right">tokens</th><th style="text-align:right">内部成本</th><th style="text-align:right">环比上月</th><th>主要模型</th></tr></thead>
              <tbody>
                ${penetration.byOrg.length ? penetration.byOrg.slice(0, 12).map((row) => `
                  <tr>
                    <td><div class="col-strong">${esc(row.dimension || '（未归口）')}</div></td>
                    <td class="col-num fs-12" style="text-align:right">${fmtNum(row.events)}</td>
                    <td class="col-num fs-12" style="text-align:right">${fmtNum(row.tokens)}</td>
                    <td class="col-num fs-12" style="text-align:right;font-weight:600">${fmtCost(row.cost_cents / 100)}</td>
                    <td class="col-num" style="text-align:right">${deltaBadge(row.delta_pct)}</td>
                    <td class="fs-11 text-4">${(row.topModels ?? []).map((m) => `<div class="mono" style="white-space:nowrap">${esc(m.model)} <span class="text-4">${m.share}%</span></div>`).join('') || '—'}</td>
                  </tr>`).join('') : emptyRow(6, rqI18n.t('{month} 暂无计量数据——资产开始调用后成本自动累积', { month: penetration.month }))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('bot', 15)} 模型成本排行</span><span class="card-sub">${esc(penetration.month)}</span></div>
        <div class="card-body" style="padding-top:8px">
          ${penetration.byModel.length ? penetration.byModel.slice(0, 8).map((row) => {
            const max = Math.max(...penetration.byModel.map((r) => r.cost_cents), 1)
            return `
              <div style="padding:7px 0">
                <div class="flex fs-12" style="margin-bottom:3px;gap:8px">
                  <span class="ellipsis mono" style="max-width:45%">${esc(row.dimension)}</span>
                  ${deltaBadge(row.delta_pct)}
                  <span style="margin-left:auto;font-weight:600">${fmtCost(row.cost_cents / 100)}</span>
                </div>
                <div style="height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden">
                  <div style="height:100%;width:${Math.max((row.cost_cents / max) * 100, 2)}%;border-radius:3px;background:linear-gradient(90deg,#0052D9,#00A3FF)"></div>
                </div>
              </div>`
          }).join('') : `<div class="tbl-empty">${icon('bot', 28)}<span>${esc(rqI18n.t('{month} 暂无模型调用计量', { month: penetration.month }))}</span></div>`}
        </div>
      </div>
    </div>

    <div class="card mb-20">
      <div class="card-head"><span class="card-title">${icon('chart', 15)} 部门 × 模型成本矩阵</span><span class="card-sub">内部成本（分）· Top 8 × Top 8 + 其他</span></div>
      <div class="card-body" style="padding-top:6px">
        ${(() => {
          const { orgs, models, cells } = penetration.matrix
          if (!orgs.length || !models.length) return `<div class="tbl-empty">${icon('chart', 28)}<span>${esc(rqI18n.t('{month} 暂无数据', { month: penetration.month }))}</span></div>`
          const flat = cells.flat().filter((v) => Number.isFinite(v))
          const max = Math.max(...flat, 1)
          const heat = (v) => v <= 0 ? '' : `background:rgba(79,110,247,${Math.max(0.06, (v / max) * 0.55).toFixed(2)})`
          return `
            <div class="table-wrap">
              <table class="tbl" style="font-size:11px">
                <thead><tr><th style="position:sticky;left:0">部门 \\ 模型</th>${models.map((m) => `<th class="mono" style="text-align:right">${esc(m)}</th>`).join('')}<th style="text-align:right">其他</th></tr></thead>
                <tbody>
                  ${orgs.map((org, i) => `
                    <tr>
                      <td class="col-strong" style="position:sticky;left:0">${esc(org)}</td>
                      ${models.map((_, j) => `<td class="col-num mono" style="text-align:right;${heat(cells[i][j])}">${cells[i][j] || '·'}</td>`).join('')}
                      <td class="col-num mono text-4" style="text-align:right">${cells[i][models.length] || '·'}</td>
                    </tr>`).join('')}
                  <tr>
                    <td class="col-strong text-4" style="position:sticky;left:0">其他</td>
                    ${models.map((_, j) => `<td class="col-num mono text-4" style="text-align:right">${cells[orgs.length][j] || '·'}</td>`).join('')}
                    <td class="col-num mono" style="text-align:right;font-weight:600">${cells[orgs.length][models.length] || '·'}</td>
                  </tr>
                </tbody>
              </table>
            </div>`
        })()}
      </div>
    </div>

    <div class="card mb-20">
      <div class="card-head">
        <span class="card-title">${icon('wifi', 15)} 空转检测（近似口径）</span>
        <span class="card-sub">${esc(rqI18n.t('判定：模型调用后 {n} 分钟内同一主体无任何后续动作（技能/工具/存储等）且无同 trace 关联动作', { n: idle.idleWindowMinutes }))}</span>
      </div>
      <div class="card-body" style="padding-top:8px">
        <div class="badge no-dot" style="background:var(--warn-bg,#fef3c7);color:#92400e;margin-bottom:10px">${icon('info', 13)}
          近似口径说明：纯对话（模型回复后用户直接离开）也会计入，本表用于发现「值得关注」的空转线索，<b>需人工复核</b>，不作为考核依据。 精确口径将在「任务结果回传」上线后自动替换。
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>对象</th><th style="text-align:right">总调用</th><th style="text-align:right">疑似空转</th><th style="text-align:right">空转占比</th><th style="text-align:right">空转成本</th></tr></thead>
            <tbody>
              ${(() => {
                const rows = [
                  ...idle.byModel.map((r) => ({ label: r.model, sub: '模型', ...r })),
                  ...idle.byOrg.map((r) => ({ label: r.org || '（未归口）', sub: '部门', ...r })),
                ].filter((r) => r.idle_events > 0).sort((a, b) => b.idle_cost_cents - a.idle_cost_cents)
                if (!rows.length) return emptyRow(5, '未检出疑似空转调用——或窗口内尚无模型调用数据')
                return rows.slice(0, 10).map((row) => `
                  <tr>
                    <td><div class="col-strong mono ellipsis" style="max-width:280px">${esc(row.label)}</div><div class="col-sub fs-11 text-4">${esc(row.sub)}</div></td>
                    <td class="col-num fs-12" style="text-align:right">${fmtNum(row.events)}</td>
                    <td class="col-num fs-12" style="text-align:right">${fmtNum(row.idle_events)}</td>
                    <td class="col-num fs-12" style="text-align:right">${row.events > 0 ? Math.round((row.idle_events / row.events) * 1000) / 10 : 0}%</td>
                    <td class="col-num fs-12" style="text-align:right;font-weight:600">${fmtCost(row.idle_cost_cents / 100)}</td>
                  </tr>`).join('')
              })()}
            </tbody>
          </table>
        </div>
        ${idle.samples.length ? `
          <details style="margin-top:10px">
            <summary class="fs-12 text-4" style="cursor:pointer">${esc(rqI18n.t('疑似空转样本（最近 {n} 条，点击展开人工复核）', { n: idle.samples.length }))}</summary>
            <div class="table-wrap" style="margin-top:6px">
              <table class="tbl" style="font-size:11px">
                <thead><tr><th>时间</th><th>主体</th><th>部门</th><th>模型</th><th style="text-align:right">tokens</th><th style="text-align:right">成本（分）</th></tr></thead>
                <tbody>
                  ${idle.samples.map((s) => `
                    <tr>
                      <td class="mono fs-11">${esc(s.occurred_at.replace('T', ' ').slice(0, 16))}</td>
                      <td class="mono fs-11">${esc(s.subject)}</td>
                      <td class="fs-11">${esc(s.org || '—')}</td>
                      <td class="mono fs-11">${esc(s.resource)}</td>
                      <td class="col-num mono" style="text-align:right">${fmtNum(s.tokens)}</td>
                      <td class="col-num mono" style="text-align:right">${s.cost_cents}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </details>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><span class="card-title">${icon('users', 15)} 消耗主体 Top 10</span><span class="card-sub">${esc(penetration.month)}${esc(rqI18n.t(' · 用户与 Agent 合计'))}</span></div>
      <div class="card-body" style="padding-top:6px">
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>主体</th><th>部门</th><th style="text-align:right">调用</th><th style="text-align:right">内部成本</th></tr></thead>
            <tbody>
              ${penetration.topSubjects.length ? penetration.topSubjects.map((row) => `
                <tr>
                  <td class="mono fs-12">${esc(row.subject)}</td>
                  <td class="fs-12">${esc(row.org || '—')}</td>
                  <td class="col-num fs-12" style="text-align:right">${fmtNum(row.events)}</td>
                  <td class="col-num fs-12" style="text-align:right;font-weight:600">${fmtCost(row.cost_cents / 100)}</td>
                </tr>`).join('') : emptyRow(4, rqI18n.t('{month} 暂无计量数据', { month: penetration.month }))}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    ${session.can('modelgw.read') ? '<div class="card" id="modelgw-card" style="margin-top:20px"></div>' : ''}`

  $('#finops-month').onchange = () => {
    const next = $('#finops-month').value
    if (!next) return
    location.hash = `#/finops?month=${next}`
  }

  void mountModelCatalog(rerender)
}

// ---------- 模型目录（管理员通道，R2-B）----------
// 三段合一卡：模型表（modelgw.read）+ 渠道组 / 预算（panel.config.write 可编辑）。
// 后端 /api/modelgw/* 未就绪时降级为卡内错误提示 + 重试，不阻断本页其余报表。
async function mountModelCatalog(rerender) {
  const host = $('#modelgw-card')
  if (!host) return

  let models = []
  let loadError = null
  try {
    const data = await api.get('/api/modelgw/models')
    models = data?.models ?? []
  } catch (error) {
    loadError = error.message
  }
  const canAdmin = session.can('modelgw.admin')
  const canConfig = session.can('panel.config.write')

  host.innerHTML = `
    <div class="card-head">
      <span class="card-title">${icon('plug', 15)} 模型目录（管理员通道）</span>
      <span class="card-sub">统一模型接入网关：模型登记 · 渠道组降级 · 预算熔断</span>
      ${canAdmin ? `<div class="card-head-actions"><button class="btn btn-primary btn-sm" id="mg-model-add">${icon('plus', 13)} 登记/更新模型</button></div>` : ''}
    </div>
    <div class="card-body" style="padding-top:6px">
      ${loadError ? `
      <div class="tbl-empty">${icon('alert', 28)}<span>${esc(rqI18n.t('模型目录加载失败：{msg}（当前宿主可能未部署 modelgw 管理接口）', { msg: loadError }))}</span></div>
      <div style="text-align:center;margin-top:8px"><button class="btn btn-default btn-sm" id="mg-retry">重试</button></div>` : `
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr><th>slug</th><th>显示名</th><th>provider</th><th>状态</th><th>数据密级</th><th style="text-align:right">成本（分/千tokens）</th><th>endpoint</th>${canAdmin ? '<th>操作</th>' : ''}</tr></thead>
          <tbody>
            ${models.length ? models.map((m) => `
              <tr data-id="${esc(m.id ?? '')}" data-slug="${esc(m.slug)}">
                <td class="mono fs-12">${esc(m.slug)}</td>
                <td class="fs-12">${esc(m.displayName ?? m.display_name ?? '—')}</td>
                <td class="fs-12">${esc(m.provider ?? '—')}</td>
                <td>${m.status === 'online' ? '<span class="badge badge-ok no-dot">在线</span>' : '<span class="badge badge-muted no-dot">离线</span>'}</td>
                <td class="fs-12">${esc(m.dataClassLimit ?? '—')}</td>
                <td class="col-num fs-12" style="text-align:right">${m.costCentsPerKTokens ?? m.cost_cents_per_k_tokens ?? '—'}</td>
                <td class="mono fs-11 text-3 ellipsis" style="max-width:200px" title="${esc(m.endpoint ?? '')}">${esc(m.endpoint ?? '—')}</td>
                ${canAdmin ? `
                <td>
                  <div class="flex" style="gap:6px">
                    <button class="btn btn-default btn-sm stop" data-mg-toggle="${esc(m.id ?? m.slug)}" data-next="${m.status === 'online' ? 'offline' : 'online'}">${m.status === 'online' ? '下线' : '上线'}</button>
                    <button class="btn btn-danger-ghost btn-sm stop" data-mg-del="${esc(m.id ?? '')}" data-slug="${esc(m.slug)}">${icon('trash', 12)}</button>
                  </div>
                </td>` : ''}
              </tr>`).join('') : emptyRow(8, '模型目录为空——登记第一个模型接入统一网关')}
          </tbody>
        </table>
      </div>`}
      ${canConfig ? `
      <div class="card-title" style="margin:20px 0 8px">${icon('gitBranch', 14)} 渠道组（主/备降级链）</div>
      <div id="mg-groups"></div>
      <div class="card-title" style="margin:20px 0 8px">${icon('coins', 14)} 预算（日/月限额与熔断）</div>
      <div id="mg-budgets"></div>` : ''}
    </div>`

  if (loadError) {
    host.querySelector('#mg-retry').onclick = () => void mountModelCatalog(rerender)
    return
  }
  if (canAdmin) {
    host.querySelector('#mg-model-add').onclick = () => openModelForm(rerender)
    host.querySelectorAll('[data-mg-toggle]').forEach((btn) => {
      btn.onclick = async () => {
        const row = btn.closest('tr')
        const slug = row.dataset.slug
        const record = models.find((m) => m.slug === slug) ?? {}
        // POST 为全量 upsert（省略字段回落默认值）：上下线必须回传既有字段，仅切换 status，
        // 否则 displayName/provider/cost 会被默认值覆盖。apiKey 服务端只回明文 env:* 形式，掩码不回传。
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
          void mountModelCatalog(rerender)
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
          void mountModelCatalog(rerender)
        } catch (error) { toast(error.message, 'error') }
      }
    })
  }
  if (canConfig) {
    void mountChannelGroups(models)
    void mountBudgets()
  }
}

/** 登记/更新模型抽屉（POST /api/modelgw/models，同 slug 即更新；apiKey 提示 env:VAR_NAME 形式）。 */
function openModelForm(rerender) {
  const drawer = openDrawer({
    title: '登记 / 更新模型',
    sub: '统一网关按 slug 路由；重复 slug 提交即为更新',
    body: `
      <div class="form-grid">
        ${field('slug', inputField('slug', { placeholder: '如 deepseek-v3 / gpt-4o' }), { required: true })}
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

/** 渠道组：主/备1/备2 三级降级链编辑 + 整体保存（PUT /api/modelgw/channel-groups）。 */
async function mountChannelGroups(models) {
  const host = $('#mg-groups')
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
    <div class="flex" style="justify-content:flex-end;margin-top:10px"><button class="btn btn-primary btn-sm" id="mg-groups-save">保存渠道组</button></div>` : `<div class="fs-12 text-4" style="padding:10px 0">暂无渠道组配置</div>`

  host.querySelector('#mg-groups-save')?.addEventListener('click', async (e) => {
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

/** 预算：列表 + 新增/编辑抽屉（组织下拉 / slug 通配 / 主体 / 日月限额分 / 预警比 / warn|block / 冻结联动）。 */
async function mountBudgets() {
  const host = $('#mg-budgets')
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
    <div class="flex" style="justify-content:flex-end;margin-bottom:8px"><button class="btn btn-default btn-sm" id="mg-budget-add">${icon('plus', 12)} 新增预算</button></div>
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
              <td>
                <div class="flex" style="gap:6px">
                  <button class="btn btn-default btn-sm stop" data-bedit="${esc(b.id)}">编辑</button>
                  <button class="btn btn-danger-ghost btn-sm stop" data-bdel="${esc(b.id)}">${icon('trash', 12)}</button>
                </div>
              </td>
            </tr>`).join('') : emptyRow(9, '暂无预算规则——为组织或 Agent 设置日/月限额与熔断动作')}
        </tbody>
      </table>
    </div>`

  host.querySelector('#mg-budget-add').onclick = () => void openBudgetForm(null, mountBudgets)
  host.querySelectorAll('[data-bedit]').forEach((btn) => {
    btn.onclick = () => {
      const budget = budgets.find((b) => b.id === btn.dataset.bedit)
      void openBudgetForm(budget, mountBudgets)
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
        void mountBudgets()
      } catch (error) { toast(error.message, 'error') }
    }
  })
}

/** 预算新增/编辑抽屉（PUT /api/modelgw/budgets 保存）。 */
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
