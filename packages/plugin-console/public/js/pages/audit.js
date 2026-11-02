/** 审计与告警：四类日志 + 告警中心/规则 + 成本分析。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openModal, confirmDialog, collectForm, field, inputField, selectField,
  renderTable, statusBadge, resultBadge, auditTypeBadge, fmtNum, fmtCost, timeAgo,
  emptyState, barChart, donut,
} from '../ui.js'
import rqI18n from '../i18n.js'

export async function renderAudit(content, params, ctx) {
  const tab = params.get('tab') ?? 'logs'
  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">审计与告警</div>
        <div class="page-desc">认证 / 授权 / 调用 / 变更四类日志统一入库，支持按人、按资源、按时间回溯；告警规则声明式配置。</div>
      </div>
      <div class="page-actions" id="audit-actions"></div>
    </div>
    <div class="tabs">
      <div class="tab ${tab === 'logs' ? 'active' : ''}" data-tab="logs">审计日志</div>
      <div class="tab ${tab === 'alerts' ? 'active' : ''}" data-tab="alerts">告警中心</div>
      <div class="tab ${tab === 'rules' ? 'active' : ''}" data-tab="rules">告警规则</div>
      <div class="tab ${tab === 'cost' ? 'active' : ''}" data-tab="cost">成本分析</div>
    </div>
    <div id="audit-body"></div>`
  $$('.tab').forEach((el) => {
    el.onclick = () => { location.hash = `#/audit?tab=${el.dataset.tab}` }
  })
  if (tab === 'logs') await renderLogs()
  if (tab === 'alerts') await renderAlerts()
  if (tab === 'rules') await renderRules()
  if (tab === 'cost') await renderCost()

  async function renderLogs() {
    $('#audit-actions').innerHTML = ''
    const body = $('#audit-body')
    body.innerHTML = `
      <div class="filter-bar">
        <div class="search-input">${icon('search')}<input class="input" id="log-q" placeholder="搜索动作 / 主体 / 资源 / 详情"></div>
        <select class="select" id="log-type" style="width:120px">
          <option value="">全部类型</option><option value="auth">认证</option><option value="authz">授权</option>
          <option value="invoke">调用</option><option value="change">变更</option>
        </select>
        <select class="select" id="log-result" style="width:120px">
          <option value="">全部结果</option><option value="ok">成功</option><option value="denied">拒绝</option><option value="error">异常</option>
        </select>
      </div>
      <div id="log-table"></div>`
    const refresh = async () => {
      const query = api.qs({
        q: $('#log-q').value.trim() || undefined,
        type: $('#log-type').value || undefined,
        result: $('#log-result').value || undefined,
        limit: 100,
      })
      const data = await api.get('/api/audit/logs' + query)
      const table = renderTable({
        columns: [
          { title: '类型', width: 84, render: (l) => auditTypeBadge(l.type) },
          { title: '动作', render: (l) => `<span class="mono fs-12">${esc(l.action)}</span>` },
          { title: '操作人', width: 140, render: (l) => `<div class="col-strong">${esc(l.actorName)}</div><div class="col-sub">${l.actorType === 'machine' ? '机器' : l.actorType === 'system' ? '系统' : '人员'}</div>` },
          { title: '资源', render: (l) => `<div>${esc(l.resourceName || '—')}</div><div class="col-sub">${esc(l.resourceType)}</div>` },
          { title: '结果', width: 84, render: (l) => resultBadge(l.result) },
          { title: '详情', render: (l) => `<span class="fs-12 text-3">${esc(clipStr(l.detail, 46))}</span>` },
          { title: '时间', width: 120, render: (l) => `<span class="fs-12 text-3">${timeAgo(l.createdAt)}</span>` },
        ],
        rows: data.items,
        onRowClick: (id, row) => {
          openModal({
            title: '审计详情',
            body: `
              <div class="desc-grid">
                <div class="desc-item"><span class="k">日志 ID</span><span class="v mono">${esc(row.id)}</span></div>
                <div class="desc-item"><span class="k">时间</span><span class="v">${esc(new Date(row.createdAt).toLocaleString('zh-CN'))}</span></div>
                <div class="desc-item"><span class="k">类型</span><span class="v">${auditTypeBadge(row.type)}</span></div>
                <div class="desc-item"><span class="k">结果</span><span class="v">${resultBadge(row.result)}</span></div>
                <div class="desc-item"><span class="k">动作</span><span class="v mono">${esc(row.action)}</span></div>
                <div class="desc-item"><span class="k">${esc(rqI18n.t('操作人'))}</span><span class="v">${esc(rqI18n.t('{name}（{type}）', { name: row.actorName, type: row.actorType }))}</span></div>
                <div class="desc-item"><span class="k">资源</span><span class="v">${esc(row.resourceName)} <span class="mono text-4">${esc(row.resourceType)}</span></span></div>
                <div class="desc-item"><span class="k">资源 ID</span><span class="v mono">${esc(row.resourceId || '—')}</span></div>
              </div>
              ${row.actChain?.length ? `
                <div class="card-title mt-14 mb-8">令牌链（on-behalf-of）</div>
                <div class="muted-box">${row.actChain.map((a) => `${esc(a.name)}<span class="text-4">(${esc(a.type)})</span>`).join(' <span class="text-4">→</span> ')}</div>` : ''}
              <div class="card-title mt-14 mb-8">详情</div>
              <div class="code-block" style="max-height:200px">${esc(row.detail || '（空）')}</div>`,
            foot: '<button class="btn btn-primary" data-ok>关闭</button>',
          })
        },
      })
      const holder = $('#log-table')
      holder.innerHTML = `<div class="fs-12 text-3 mb-8">${esc(rqI18n.t('共 {n} 条（展示最近 100 条）', { n: data.total }))}</div>`
      holder.appendChild(table)
    }
    $('#log-q').oninput = debounce(refresh, 300)
    $('#log-type').onchange = refresh
    $('#log-result').onchange = refresh
    await refresh()
  }

  async function renderAlerts() {
    const data = await api.get('/api/audit/alerts')
    const alerts = data.alerts
    const unread = alerts.filter((alert) => !alert.read)
    const body = $('#audit-body')
    $('#audit-actions').innerHTML = unread.length
      ? `<button class="btn btn-default" id="alert-read-all">${icon('check', 14)}${esc(rqI18n.t('全部已读（{n}）', { n: unread.length }))}</button>`
      : ''
    const readAllBtn = $('#alert-read-all')
    if (readAllBtn) readAllBtn.onclick = async () => {
      try {
        const result = await api.post('/api/audit/alerts/read-all')
        toast(rqI18n.t('已将 {n} 条告警标记为已读', { n: result.read })); ctx.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
    if (!alerts.length) {
      body.innerHTML = ''
      body.appendChild(emptyState({ title: '没有告警', desc: '平台运行平稳，告警将实时推送至此', icon: 'shieldCheck' }))
      return
    }
    body.innerHTML = alerts.map((alert) => `
      <div class="card card-pad mb-8 flex" style="gap:12px;${!alert.read ? 'border-left:3px solid var(--' + (alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warn' : 'info') + ')' : ''}">
        <span style="color:var(--${alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warn' : 'info'});flex-shrink:0;margin-top:2px">${icon(alert.severity === 'info' ? 'info' : 'alert', 17)}</span>
        <div class="grow">
          <div class="flex" style="gap:8px">
            <span style="font-weight:600;font-size:13.5px">${esc(alert.title)}</span>
            <span class="badge ${alert.severity === 'critical' ? 'badge-danger' : alert.severity === 'warning' ? 'badge-warn' : 'badge-info'} no-dot">${severityLabel(alert.severity)}</span>
          </div>
          <div class="fs-12 text-3 mt-8" style="line-height:1.6">${esc(alert.message)}</div>
        </div>
        <div style="flex-shrink:0;text-align:right">
          <div class="fs-11 text-4">${timeAgo(alert.createdAt)}</div>
          ${!alert.read ? `<button class="btn btn-ghost btn-sm mt-8" data-read="${esc(alert.id)}">标记已读</button>` : '<span class="fs-11" style="color:var(--ok)">已读</span>'}
        </div>
      </div>`).join('')
    body.querySelectorAll('[data-read]').forEach((btn) => {
      btn.onclick = async () => {
        await api.post(`/api/audit/alerts/${btn.dataset.read}/read`)
        toast(rqI18n.t('已标记')); ctx.rerender()
      }
    })
  }

  async function renderRules() {
    $('#audit-actions').innerHTML = `<button class="btn btn-primary" id="rule-add">${icon('plus', 14)}新建规则</button>`
    const data = await api.get('/api/audit/alert-rules')
    const body = $('#audit-body')
    body.innerHTML = data.rules.map((rule) => `
      <div class="card card-pad mb-8 flex" style="gap:14px">
        <div class="grow">
          <div class="flex" style="gap:8px">
            <span style="font-weight:600">${esc(rule.name)}</span>
            <span class="badge ${rule.severity === 'critical' ? 'badge-danger' : rule.severity === 'warning' ? 'badge-warn' : 'badge-info'} no-dot">${severityLabel(rule.severity)}</span>
            <span class="badge ${rule.enabled ? 'badge-ok' : 'badge-muted'}">${rule.enabled ? '已启用' : '已停用'}</span>
          </div>
          <div class="fs-12 text-3 mt-8">${esc(rule.description ?? '')}</div>
          <div class="fs-12 mono mt-8" style="color:var(--text-2)">${esc(rqI18n.t('当'))} <b>${esc(metricLabel(rule.metric))}</b>${esc(rqI18n.t(' &gt; {n}（{m} 分钟窗口）→ 通知 {channels}', { n: rule.threshold, m: rule.windowMinutes, channels: rule.channels.map(esc).join(rqI18n.t('、')) }))}</div>
        </div>
        <div style="flex-shrink:0">
          <button class="btn btn-default btn-sm" data-toggle="${esc(rule.id)}" data-enabled="${rule.enabled ? 1 : 0}">${rule.enabled ? '停用' : '启用'}</button>
        </div>
      </div>`).join('') || '<span class="text-4 fs-13">暂无告警规则</span>'
    body.querySelectorAll('[data-toggle]').forEach((btn) => {
      btn.onclick = async () => {
        await api.patch(`/api/audit/alert-rules/${btn.dataset.toggle}`, { enabled: btn.dataset.enabled !== '1' })
        toast(rqI18n.t('规则已更新')); ctx.rerender()
      }
    })
    $('#rule-add').onclick = () => {
      const modal = openModal({
        title: '新建告警规则',
        body: `
          <div class="form-grid">
            ${field('规则名称', inputField('name'), { required: true })}
            ${field('监控指标', selectField('metric', [
              { value: 'mcp_unhealthy', label: 'MCP 连续失败次数' },
              { value: 'permission_denied', label: '越权尝试次数' },
              { value: 'agent_burst', label: 'Agent 调用频次' },
            ]))}
            ${field('阈值', inputField('threshold', { value: '3' }), { required: true })}
            ${field('窗口（分钟）', inputField('windowMinutes', { value: '10' }))}
            ${field('级别', selectField('severity', [
              { value: 'critical', label: '严重（红色）' }, { value: 'warning', label: '警告（黄色）' }, { value: 'info', label: '提示（蓝色）' },
            ]))}
            ${field('描述', inputField('description'))}
          </div>
          <div class="form-hint">触发后推送渠道：钉钉机器人 / 邮件（演示环境写入告警中心）</div>`,
        foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>创建</button>',
      })
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      modal.el.querySelector('[data-ok]').onclick = async () => {
        const data2 = collectForm(modal.body)
        try {
          await api.post('/api/audit/alert-rules', {
            name: data2.name, metric: data2.metric, threshold: Number(data2.threshold) || 1,
            windowMinutes: Number(data2.windowMinutes) || 10, severity: data2.severity, description: data2.description,
            channels: ['dingtalk'], enabled: true,
          })
          toast(rqI18n.t('规则已创建')); modal.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    }
  }

  async function renderCost() {
    const body = $('#audit-body')
    body.innerHTML = `
      <div class="filter-bar">
        <div class="segmented" id="cost-dim">
          <span class="segmented-item active" data-d="app">按应用</span>
          <span class="segmented-item" data-d="agent">按 Agent</span>
          <span class="segmented-item" data-d="org">按组织</span>
          <span class="segmented-item" data-d="date">按日期</span>
        </div>
        <span class="fs-12 text-3">成本链路：应用 → Agent → MCP / 模型 穿透归集</span>
      </div>
      <div id="cost-body"></div>`
    const refresh = async (dim) => {
      const data = await api.get('/api/audit/cost' + api.qs({ groupBy: dim }))
      const total = data.rows.reduce((s, r) => s + r.costYuan, 0)
      const tokens = data.rows.reduce((s, r) => s + r.llmTokens, 0)
      const palette = ['#0052D9', '#8b5cf6', '#10b981', '#f59e0b', '#3b82f6', '#ef4444', '#14b8a6', '#a78bfa']
      $('#cost-body').innerHTML = `
        <div class="grid-2 mb-14" style="grid-template-columns:2fr 1fr;align-items:stretch">
          <div class="card card-pad">
            <div class="card-title mb-8">${dim === 'date' ? '每日成本趋势' : '成本分布 Top'}</div>
            ${barChart(data.rows.slice(0, dim === 'date' ? 30 : 10).map((r) => ({ label: r.key, value: r.costYuan })), { width: 620, height: 200, format: fmtCost })}
            <div class="flex-between mt-8">
              <span class="fs-12 text-3">${esc(rqI18n.t('合计 {c} · Token {n}', { c: fmtCost(total), n: fmtNum(tokens) }))}</span>
            </div>
          </div>
          <div class="card card-pad">
            <div class="card-title mb-8">占比</div>
            <div style="display:flex;gap:16px;align-items:center">
              ${donut(data.rows.slice(0, 6).map((r, i) => ({ label: r.key, value: r.costYuan, color: palette[i % palette.length] })))}
              <div class="grow">
                ${data.rows.slice(0, 6).map((r, i) => `
                  <div class="flex" style="padding:3px 0;font-size:12px">
                    <i style="width:9px;height:9px;border-radius:2.5px;background:${palette[i % palette.length]};display:inline-block;margin-right:6px"></i>
                    <span class="ellipsis grow">${esc(r.key)}</span>
                    <span>${fmtCost(r.costYuan)}</span>
                  </div>`).join('')}
              </div>
            </div>
          </div>
        </div>
        <div id="cost-table"></div>`
      const table = renderTable({
        columns: [
          { title: dim === 'date' ? '日期' : dim === 'app' ? '应用' : dim === 'agent' ? 'Agent' : '组织', render: (r) => `<span class="col-strong">${esc(r.key)}</span>` },
          { title: 'LLM Token 用量', render: (r) => `<span class="col-num">${fmtNum(r.llmTokens)}</span>` },
          { title: '工具调用', render: (r) => `<span class="col-num">${fmtNum(r.toolCalls)}</span>` },
          { title: '成本', render: (r) => `<span style="font-weight:600">${fmtCost(r.costYuan)}</span>` },
        ],
        rows: data.rows,
        onRowClick: () => {},
      })
      $('#cost-table').appendChild(table)
    }
    $$('#cost-dim .segmented-item').forEach((el) => {
      el.onclick = () => {
        $$('#cost-dim .segmented-item').forEach((i) => i.classList.remove('active'))
        el.classList.add('active')
        void refresh(el.dataset.d)
      }
    })
    await refresh('app')
  }
}

function severityLabel(severity) {
  return { critical: '严重', warning: '警告', info: '提示' }[severity] ?? severity
}
function metricLabel(metric) {
  return { mcp_unhealthy: 'MCP 连续失败', permission_denied: '越权尝试', agent_burst: 'Agent 调用频次' }[metric] ?? metric
}
function clipStr(text, max) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) + '…' : s
}
function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}
