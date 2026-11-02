/** 审批中心（#/approvals · WE 治理域，规格 docs/internal/design-adaptation-spec-20261014.md §5.6）：
 *  左列表（风险 risk-pill + 标题 + 申请人/组织/时间 + 已决徽标）右详情（申请负载 dry-run 影响面 mono 列表
 *  + 审批时间线 tl-item + 底部操作条）。
 *  既有动作与状态流转一行不改逻辑只换壳：GET /api/approvals、GET /api/approvals/sla、
 *  POST /api/approvals/:id/decide（意见必填 / 高风险二次确认 / 终审标记）、DELETE /api/approvals/:id（仅驳回单）。
 *  组织名展示：优先 /api/iam/orgs 解析（无权限静默回落 orgId 原样，不造假）。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openModal, collectForm, field, textareaField, statusBadge, timeAgo,
  emptyState, confirmDialog, sectionHead, tabRow,
} from '../ui.js'
import rqI18n from '../i18n.js'

export async function renderApprovals(content, params, ctx) {
  const data = await api.get('/api/approvals')
  let sla = null
  try { sla = await api.get('/api/approvals/sla?windowDays=30') } catch { /* SLA 看板失败不阻断列表 */ }
  let orgNames = new Map()
  try {
    const orgs = await api.get('/api/iam/orgs')
    orgNames = new Map((Array.isArray(orgs) ? orgs : (orgs?.orgs ?? [])).map((o) => [o.id, o.name]))
  } catch { /* 无 iam.org.read 权限时回落展示 orgId */ }

  const approvals = data.approvals
  const pendingCount = approvals.filter((a) => a.status === 'pending').length
  let statusFilter = 'pending'
  let activeId = params.get('focus')
    ?? (approvals.find((a) => a.status === 'pending') ?? approvals[0])?.id
    ?? null

  content.innerHTML = `
    ${sectionHead({
      label: 'APPROVAL / L4',
      title: '审批中心',
      extra: '上线 / 下线 / 下架 / 吊销强制审批单 · 有审批权限者单人通过即执行 · 执行结果回写',
    })}
    <div id="ap-tabs" style="margin-bottom:14px"></div>
    ${sla ? `
    <div class="card card-pad mb-14" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      <div class="card-title" style="margin:0">${icon('clock', 15)} ${esc(rqI18n.t('审批 SLA（近 {n} 天）', { n: sla.windowDays }))}</div>
      <div style="font-size:22px;font-weight:700;color:${sla.achievementRate >= 0.9 ? 'var(--ok)' : 'var(--danger)'}">${Math.round(sla.achievementRate * 1000) / 10}%</div>
      <span class="fs-12 text-3">${esc(rqI18n.t('≤2 工作日达成率 · 已决 {n} 单{over}', { n: sla.decided, over: sla.breached.length ? rqI18n.t(' · 超期 {n} 单', { n: sla.breached.length }) : '' }))}</span>
      <span class="fs-11 text-4">${esc(sla.calendarNote)}</span>
      ${sla.breached.length ? `<div class="fs-12" style="flex-basis:100%;color:var(--danger)">${esc(rqI18n.t('超期单：{items}{more}', { items: sla.breached.slice(0, 3).map((item) => `${esc(item.title)}${esc(rqI18n.t('（{n} 工作日）', { n: item.businessDays }))}`).join(rqI18n.t('、')), more: sla.breached.length > 3 ? rqI18n.t('等') : '' }))}</div>` : ''}
    </div>` : ''}
    <div class="grid-2" style="grid-template-columns:2fr 3fr;align-items:start">
      <div id="ap-list" style="display:flex;flex-direction:column;gap:8px"></div>
      <div id="ap-detail"></div>
    </div>`

  $('#ap-tabs').appendChild(tabRow([
    { key: 'pending', label: '待审批', badge: pendingCount, badgeTone: pendingCount > 0 ? 'warn' : undefined },
    { key: 'all', label: '全部', badge: approvals.length },
  ], statusFilter, (key) => { statusFilter = key; renderList() }))

  function visibleList() {
    return statusFilter === 'pending' ? approvals.filter((a) => a.status === 'pending') : approvals
  }

  function renderList() {
    const holder = $('#ap-list')
    holder.innerHTML = ''
    const list = visibleList()
    if (!list.length) {
      holder.appendChild(emptyState({
        title: statusFilter === 'pending' ? '没有待办审批' : '暂无审批记录',
        desc: 'L4 高危操作提交后将自动生成审批单',
        icon: 'checkSquare',
      }))
      return
    }
    for (const approval of list) {
      const decided = approval.status !== 'pending'
      const card = h(`
        <div class="card card-pad" data-id="${esc(approval.id)}" style="cursor:pointer;transition:border-color .15s,box-shadow .15s;${activeId === approval.id ? 'border-color:var(--brand-400);box-shadow:0 4px 16px -8px rgba(10,95,135,.4)' : ''}">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
            <span style="font-size:13.5px;font-weight:500;line-height:1.45">${esc(approval.title)}</span>
            ${riskPill(approval.riskLevel)}
          </div>
          <div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--text-3)">
            <span>${esc(approval.requesterName)}</span><span>·</span>
            <span>${esc(orgNames.get(approval.orgId) ?? approval.orgId ?? '—')}</span><span>·</span>
            <span class="mono">${esc(timeAgo(approval.createdAt))}</span>
            ${decided ? `<span style="margin-left:auto">${statusBadge(approval.status)}</span>` : ''}
          </div>
        </div>`)
      card.onclick = () => { activeId = approval.id; renderList(); renderDetail() }
      holder.appendChild(card)
    }
  }

  function renderDetail() {
    const holder = $('#ap-detail')
    holder.innerHTML = ''
    const approval = approvals.find((a) => a.id === activeId)
    if (!approval) {
      holder.appendChild(h(`<div class="card card-pad">${emptyStateText()}</div>`))
      return
    }
    const canDecide = session.can('approval.decide')
    const pending = approval.status === 'pending'
    const reason = pickReason(approval.payload)
    const payloadEntries = Object.entries(approval.payload ?? {})

    const detail = h(`
    <div class="card" style="overflow:hidden">
      <div style="border-bottom:1px solid var(--border);padding:16px 20px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div style="min-width:0">
            <div style="font-size:15px;font-weight:600">${esc(approval.title)}</div>
            <div style="margin-top:4px;font-size:12px;color:var(--text-3)">
              <span class="mono">${esc(approval.id)}</span> · ${esc(kindLabel(approval.kind))}${esc(rqI18n.t(' · {name} 提交于 {time}', { name: approval.requesterName, time: timeAgo(approval.createdAt) }))}
            </div>
          </div>
          ${riskPill(approval.riskLevel)}
        </div>
        ${reason ? `<p style="margin-top:12px;background:var(--surface-2);border-radius:8px;padding:12px 14px;font-size:13px;line-height:1.65;color:var(--text-2)">${esc(reason)}</p>` : ''}
      </div>

      <div style="padding:16px 20px">
        <div class="micro-label" style="margin-bottom:8px;display:flex;align-items:center;gap:6px">${icon('terminal', 13)} dry-run 影响面预览（申请负载）</div>
        ${payloadEntries.length ? `
        <ul style="display:flex;flex-direction:column;gap:6px;list-style:none;padding:0;margin:0">
          ${payloadEntries.map(([key, value]) => `
          <li style="display:flex;align-items:flex-start;gap:8px;font-size:13px">
            <span style="margin-top:7px;width:4px;height:4px;border-radius:50%;background:var(--brand-primary);flex-shrink:0"></span>
            <span class="mono fs-12" style="line-height:1.6">${esc(key)}：${esc(typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value))}</span>
          </li>`).join('')}
        </ul>
        <details style="margin-top:10px">
          <summary class="fs-12 text-4" style="cursor:pointer">查看完整申请负载（JSON）</summary>
          <div class="code-block" style="margin-top:8px;max-height:220px">${esc(JSON.stringify(approval.payload, null, 2))}</div>
        </details>` : emptyStateText('该审批单没有附带申请负载')}
      </div>

      <div style="border-top:1px solid var(--border);padding:16px 20px">
        <div class="micro-label" style="margin-bottom:12px">审批时间线</div>
        <div class="timeline">
          <div class="tl-item">
            <span class="tl-dot done"></span>
            <div style="min-width:0">
              <div style="font-size:13px">发起申请</div>
              <div class="tnum mono fs-11 text-3" style="margin-top:2px">${esc(timeAgo(approval.createdAt))} · ${esc(approval.requesterName)}</div>
            </div>
          </div>
          ${pending ? `
          <div class="tl-item">
            <span class="tl-dot current"></span>
            <div style="min-width:0">
              <div style="font-size:13px">等待审批</div>
              <div class="fs-12 text-3" style="margin-top:2px">任意具有审批权限的成员可处理（提交人与审批人可为同一账号）</div>
            </div>
          </div>` : `
          <div class="tl-item">
            <span class="tl-dot" style="${approval.status === 'rejected' ? 'background:var(--danger);color:var(--white)' : ''}">${approval.status === 'rejected' ? '✕' : ''}</span>
            <div style="min-width:0">
              <div style="font-size:13px">${decisionTitle(approval.status)}</div>
              <div class="tnum mono fs-11 text-3" style="margin-top:2px">${esc(timeAgo(approval.decidedAt))} · ${esc(approval.approverName ?? '')}</div>
              ${approval.opinion ? `<div class="fs-12-5 text-2" style="margin-top:4px;line-height:1.6">${esc(rqI18n.t('意见：{opinion}', { opinion: approval.opinion }))}</div>` : ''}
              ${approval.execution ? `<div class="fs-12 mono" style="margin-top:4px;word-break:break-all">${esc(approval.execution.error ?? approval.execution.result)}</div>` : ''}
              ${approval.supersededBy ? `<div class="fs-12 text-3" style="margin-top:4px">收口依据：<a href="#/approvals?focus=${esc(approval.supersededBy)}" class="mono">${esc(approval.supersededBy)}</a></div>` : ''}
            </div>
          </div>
          ${approval.finalReview ? `
          <div class="tl-item">
            <span class="tl-dot done"></span>
            <div style="min-width:0">
              <div style="font-size:13px">公司级终审标记（审计 action=approval.final_review）</div>
              <div class="tnum mono fs-11 text-3" style="margin-top:2px">${esc(timeAgo(approval.finalReview.at))} · ${esc(approval.finalReview.approverName)}</div>
            </div>
          </div>` : ''}`}
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:10px;border-top:1px solid var(--border);background:var(--surface-2);padding:13px 20px;flex-wrap:wrap">
        ${pending && canDecide ? `
          <button class="btn btn-primary btn-sm" id="ap-approve" data-approve="${esc(approval.id)}">${icon('check', 14)} 通过并执行</button>
          <button class="btn btn-default btn-sm" id="ap-reject" data-reject="${esc(approval.id)}">${icon('x', 14)} 驳回（原因必填）</button>
          <span style="margin-left:auto;font-size:11px;color:var(--text-3)">执行期复核 · 挂单期间资源被禁用将执行失败留痕</span>` : ''}
        ${pending && !canDecide ? `
          <span class="fs-13 text-3">等待审批中——需具备审批权限（approval.decide）的成员处理</span>` : ''}
        ${!pending ? decidedCopy(approval) : ''}
        ${approval.status === 'rejected' && canDecide ? `
          <button class="btn btn-danger-ghost btn-sm" id="ap-delete" style="margin-left:auto">${icon('trash', 13)} 删除该驳回单</button>` : ''}
      </div>
    </div>`)

    const approveBtn = detail.querySelector('#ap-approve')
    if (approveBtn) approveBtn.onclick = () => openDecision(approval.id, 'approve', ctx, approval)
    const rejectBtn = detail.querySelector('#ap-reject')
    if (rejectBtn) rejectBtn.onclick = () => openDecision(approval.id, 'reject', ctx, approval)
    const deleteBtn = detail.querySelector('#ap-delete')
    if (deleteBtn) deleteBtn.onclick = () => deleteApproval(approval, ctx)
    holder.appendChild(detail)
  }

  renderList()
  renderDetail()
}

function emptyStateText(text = '请选择左侧审批单查看详情') {
  return `<div style="padding:36px 16px;text-align:center;color:var(--text-3);font-size:13px">${esc(text)}</div>`
}

/** 风险徽章（risk-pill 组件类）：high→红 / medium→琥珀 / 其余→灰（值来自服务端 riskLevel 字段）。 */
function riskPill(riskLevel) {
  const [cls, label] = riskLevel === 'high' ? ['risk-crit', '高风险']
    : riskLevel === 'medium' ? ['risk-high', '中风险']
    : ['risk-normal', '常规']
  return `<span class="risk-pill ${cls}">${esc(label)}</span>`
}

/** 申请理由：负载内常见字段（reason/comment/opinion/title）择一，缺省不渲染（不造话术）。 */
function pickReason(payload) {
  const raw = payload?.reason ?? payload?.comment ?? payload?.justification ?? null
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function decisionTitle(status) {
  return { approved: '审批通过', executed: '审批通过并已执行', rejected: '已驳回', failed: '审批通过但执行失败', superseded: '已自动收口（同目标审批单已执行）' }[status] ?? status
}

function decidedCopy(approval) {
  if (approval.status === 'rejected') {
    return `<span style="font-size:13px;font-weight:500;color:var(--danger)">本单已驳回 · 原因已留痕，结果已回写并通知申请人</span>`
  }
  if (approval.status === 'failed') {
    return `<span style="font-size:13px;font-weight:500;color:var(--danger)">本单已通过但执行失败 · 失败原因已回写，可重新发起</span>`
  }
  if (approval.status === 'superseded') {
    return `<span style="font-size:13px;font-weight:500;color:var(--text-3)">本单已自动收口 · 同目标审批单已执行、诉求已满足，无需处理</span>`
  }
  return `<span style="font-size:13px;font-weight:500;color:#047857">本单已通过 · 结果已回写并通知申请人</span>`
}

/** 删除驳回审批单：仅清理已驳回单（不涉及已执行单与业务资产），服务端校验状态。——既有逻辑原样保留。 */
async function deleteApproval(approval, ctx) {
  const result = await confirmDialog({
    title: rqI18n.t('删除审批单 · {title}', { title: approval.title }), danger: true, confirmText: rqI18n.t('确认删除'),
    message: `${rqI18n.t('将删除该')}<b>${rqI18n.t('已驳回')}</b>${rqI18n.t('审批单（仅清理审批列表，不影响审计记录与业务资产），操作不可恢复。')}`,
  })
  if (!result) return
  try {
    await api.delete(`/api/approvals/${approval.id}`)
    toast(rqI18n.t('已删除驳回审批单'))
    ctx.rerender()
  } catch (error) { toast(error.message, 'error') }
}

/** 审批决策弹窗：意见必填、高风险二次确认（服务端强制）、可选公司级终审标记——既有逻辑逐字保留。 */
function openDecision(id, decision, ctx, approval) {
  const isHighRisk = approval?.riskLevel === 'high'
  const modal = openModal({
    title: decision === 'approve' ? rqI18n.t('审批通过') : rqI18n.t('驳回申请'),
    body: `
      ${decision === 'approve' ? `
        <div class="muted-box mb-14" style="display:flex;gap:8px;border-color:var(--ok-border);background:var(--ok-bg)">
          ${icon('check', 15)}<span>${rqI18n.t('通过后将')}<b>${rqI18n.t('自动执行')}</b>${rqI18n.t('对应的高危操作（执行结果会回写审批单）。')}</span>
        </div>` : ''}
      ${isHighRisk && decision === 'approve' ? `
        <div class="muted-box mb-14" style="display:flex;gap:8px;border-color:var(--danger-border);background:var(--danger-bg)">
          ${icon('alert', 15)}<span><b>${rqI18n.t('高风险审批（L1 公司级终审）')}</b>${rqI18n.t('：通过前请复核影响面；通过后将自动落公司级终审标记并写入审计。')}</span>
        </div>
        <label class="flex mb-14" style="gap:8px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" id="apc-confirm" style="margin-top:3px">
          <span class="fs-12 text-2">${rqI18n.t('二次确认：我已完整复核该高风险操作的影响面与回滚方案（不勾选将无法通过，服务端强制）。')}</span>
        </label>` : ''}
      ${decision === 'approve' && !isHighRisk ? `
        <label class="flex mb-14" style="gap:8px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" id="apc-final" style="margin-top:3px">
          <span class="fs-12 text-2">${rqI18n.t('同时落「公司级终审标记」（审计可追溯，非高风险默认可选）。')}</span>
        </label>` : ''}
      ${field(rqI18n.t('审批意见'), textareaField('opinion', { placeholder: decision === 'approve' ? rqI18n.t('如：已确认影响面，同意执行') : rqI18n.t('请说明驳回原因…') }), { required: true })}`,
    foot: `<button class="btn btn-default" data-cancel>${rqI18n.t('取消')}</button><button class="btn ${decision === 'approve' ? 'btn-primary' : 'btn-danger'}" data-ok>${decision === 'approve' ? rqI18n.t('确认通过') : rqI18n.t('确认驳回')}</button>`,
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const opinion = collectForm(modal.body).opinion
    if (!opinion) return toast(rqI18n.t('请填写审批意见'), 'error')
    if (isHighRisk && decision === 'approve' && !modal.body.querySelector('#apc-confirm')?.checked) {
      return toast(rqI18n.t('高风险审批需勾选二次确认（服务端强制）'), 'error')
    }
    const confirmed = isHighRisk && decision === 'approve'
    const finalReview = Boolean(modal.body.querySelector('#apc-final')?.checked)
    btn.classList.add('btn-loading')
    try {
      const result = await api.post(`/api/approvals/${id}/decide`, { decision, opinion, confirmed, finalReview })
      toast(decision === 'approve' ? rqI18n.t('审批通过，状态：{status}', { status: result.status }) : rqI18n.t('已驳回'))
      modal.close(); ctx.rerender()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

function kindLabel(kind) {
  return {
    'agent.online': 'Agent 上线', 'agent.offline': 'Agent 下线',
    'app.online': '应用发布', 'app.offline': '应用下架',
    'mcp.offline': 'MCP 下线',
  }[kind] ?? kind
}
