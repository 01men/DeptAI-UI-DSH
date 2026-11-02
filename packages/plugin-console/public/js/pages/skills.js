/**
 * Skill 市场（规格 docs/internal/design-adaptation-spec-20261014.md §5.3，布局照设计稿 Market.tsx）：
 * 卡片网格（名称+验签盾+状态+发布者+简介+30 天热力条+版本/安装数/风险徽标）+ 分类/搜索/排序
 * + 详情抽屉（状态/验签/版本/描述/热力大图/版本审批时间线/安装与审批动作）。
 * 数据：既有 /api/skills/*（列表/详情/安装/审批/提交）；热力 = /api/skills/usage-heatmap（真实计量）。
 * 旧市场全部功能保留：上架/安装/两级审批/提交/编辑/资源包/弃用/删除/存储配置/我的提交/待审批。
 */
import { api, session, downloadBlob } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog,
  statusBadge, collectForm, field, inputField, selectField, textareaField,
  fmtNum, timeAgo, emptyState, maybeShowConceptCard,
  searchableSelectField, mountSearchableSelects,
} from '../ui.js'
import { sectionHead, chipRow, heatStrip, emptyHint } from '../components/asset-drawer.js'
import { ASSET_CATEGORIES } from '../taxonomy.js'

/** Agent 状态枚举（协议值 ASCII）→ 选择器选项中文伴随（option 纯文本不能用 statusBadge） */
const AGENT_STATUS_LABEL = { online: '已上线', offline: '已下线', draft: '开发中', archived: '已归档' }

export async function renderSkills(content, params, ctx) {
  const data = await api.get('/api/skills')
  // 首次访问概念卡（易用性整改：Skill 术语对业务成员有门槛）
  maybeShowConceptCard(content, 'skills', {
    icon: 'sparkles',
    title: 'Skill 是什么？',
    subtitle: 'Skill = 给 Agent 用的「专项技能包」，像手机装 App 一样即装即用。',
    points: [
      '能做什么：生成周报、读取合同要点、分析销售数据等专项任务。',
      '怎么上架：提交 → 自动安全扫描 → 两级审批 → 版本化上架，高风险需安全团队加签。',
      '怎么使用：按场景在市场挑选，下载安装即登记依赖，随时可停用。',
    ],
  })

  content.innerHTML = `
    ${sectionHead({
      label: 'SKILL MARKET',
      title: 'Skill 市场',
      extra: '提交 → 静态扫描 → 两级审批 → 版本化上架 · 契约五面 Ed25519 验签 · 卡片色深 = 当日使用次数（30 天热力）',
      actions: `
        <button class="btn btn-default" id="skill-storage">${icon('server', 14)}存储配置</button>
        <button class="btn btn-default" id="skill-mine">${icon('user', 14)}我的提交</button>
        ${session.can('skill.approve') ? `<button class="btn btn-default" id="skill-review">${icon('checkSquare', 14)}待审批<span class="badge badge-danger no-dot" id="skill-review-count" style="margin-left:6px;display:none">0</span></button>` : ''}
        ${session.can('skill.submit') ? `<button class="btn btn-primary" id="skill-submit">${icon('plus', 14)}提交新技能</button>` : ''}`,
    })}
    <div id="skill-heatmap" class="mb-20"></div>
    <div class="filter-bar">
      <div id="skill-cats"></div>
      <div class="search-input">${icon('search')}<input class="input" id="skill-q" placeholder="搜索技能名称、描述、标签、作者..." style="width:220px"></div>
      <div class="segmented" style="margin-left:auto" id="skill-sort">
        <span class="segmented-item active" data-sort="downloads">按下载</span>
        <span class="segmented-item" data-sort="rating">按评分</span>
        <span class="segmented-item" data-sort="updated">按更新</span>
      </div>
    </div>
    <div class="grid-cards g3" id="skill-cards"></div>`

  let state = { q: '', cat: '', sort: 'downloads', mode: 'market' }
  // 30 天热力数据：卡片热力条与全局热力图共用一次拉取（usage 计量 + 下载流水回填，真实数据）
  const heatState = { byId: new Map() }
  let lastSkills = []

  const refresh = async () => {
    const query = api.qs(state.mode === 'mine' ? { mine: 1 } : state.mode === 'review' ? { pending: 1 } : { q: state.q || undefined, category: state.cat || undefined, sort: state.sort })
    const result = await api.get('/api/skills' + query)
    renderCards(result.skills ?? [])
    void updateReviewBadge()
  }

  function renderCards(skills) {
    lastSkills = skills
    const holder = $('#skill-cards')
    if (!holder) return
    holder.innerHTML = ''
    if (!skills.length) {
      holder.appendChild(emptyState({
        title: state.mode === 'review' ? '没有待审批的 Skill' : state.mode === 'mine' ? '你还没有提交过 Skill' : '没有匹配的 Skill',
        desc: state.mode === 'market' ? '换个关键字或分类试试' : '提交第一个 Skill 到市场，让能力复用起来',
        actionText: state.mode === 'market' ? undefined : '提交 Skill',
        onAction: () => $('#skill-submit').click(),
        icon: 'sparkles',
      }))
      return
    }
    for (const skill of skills) {
      const heat = Array.isArray(skill.heat) ? skill.heat : heatState.byId.get(skill.id)
      const riskCls = skill.riskLevel === 'high' ? 'risk-crit' : skill.riskLevel === 'medium' ? 'risk-high' : 'risk-normal'
      const riskText = skill.riskLevel === 'high' ? '高风险' : skill.riskLevel === 'medium' ? '中风险' : '低风险'
      const card = h(`
        <div class="res-card fade-up" data-id="${esc(skill.id)}" style="cursor:pointer">
          <div class="res-card-top">
            <div class="grow" style="min-width:0">
              <div class="res-name">
                <span class="ellipsis" style="min-width:0" title="${esc(skill.name)}">${esc(skill.name)}</span>
                ${skill.verified ? `<span style="color:var(--ok);display:inline-flex;flex-shrink:0" title="Ed25519 验签通过">${icon('shieldCheck', 14)}</span>` : ''}
              </div>
              <div class="fs-12 text-4 ellipsis" style="margin-top:2px">${esc(skill.authorName)}${skill.category ? ` · ${esc(skill.category)}` : ''}</div>
            </div>
            ${statusBadge(skill.status)}
          </div>
          <div class="res-desc" title="${esc(skill.summary)}">${esc(skill.summary)}</div>
          <div style="margin-top:10px">${heat ? heatStrip(heat) : '<span class="fs-11 text-4">近 30 天暂无使用记录</span>'}</div>
          <div class="res-foot">
            <span class="metric mono">v${esc(skill.currentVersion)}</span>
            <span class="metric" title="安装量">${icon('download', 13)}${esc(rqI18n.t('{n} 安装', { n: fmtNum(skill.stats.installs) }))}</span>
            <span class="metric" title="评分">${icon('star', 13)}${skill.stats.rating || '—'}</span>
            <span class="risk-pill ${riskCls}">${riskText}</span>
            <span style="margin-left:auto;color:var(--brand-500)">详情 →</span>
          </div>
        </div>`)
      card.onclick = () => openSkillDetail(skill.id, ctx, refresh, heatState)
      holder.appendChild(card)
    }
  }

  // 待审批徽标：在途项计数（驳回不算待办），让审批人在市场页第一眼看到待办
  const updateReviewBadge = async () => {
    const badge = $('#skill-review-count')
    if (!badge) return
    try {
      const result = await api.get('/api/skills' + api.qs({ pending: 1 }))
      const actionable = (result.skills ?? []).filter((s) => s.status !== 'rejected').length
      badge.textContent = String(actionable)
      badge.style.display = actionable > 0 ? '' : 'none'
    } catch { /* 静默 */ }
  }

  // 技能热力图：skill × 日 使用矩阵（usage 计量为主、历史下载流水回填）；无数据不占位
  api.get('/api/skills/usage-heatmap?days=30')
    .then((hm) => {
      for (const s of hm.skills ?? []) heatState.byId.set(s.id, s.cells)
      const heatmapHolder = $('#skill-heatmap')
      if (hm.skills?.length && heatmapHolder) heatmapHolder.innerHTML = heatCard(hm)
      renderCards(lastSkills) // 热力数据到位后重绘卡片色深
    })
    .catch(() => undefined)

  // 分类 chipRow（全部 + 服务端分类）：后端固定返回标准 11 项在前、存量遗留分类附后
  $('#skill-cats').appendChild(chipRow(
    [{ value: '', label: '全部' }, ...(data.categories ?? []).map((cat) => ({ value: cat, label: cat }))],
    state.cat,
    (value) => { state.cat = value; state.mode = 'market'; void refresh() },
  ))

  $('#skill-q').oninput = debounce(() => { state.q = $('#skill-q').value.trim(); state.mode = 'market'; void refresh() }, 300)
  $$('#skill-sort .segmented-item').forEach((el) => {
    el.onclick = () => {
      $$('#skill-sort .segmented-item').forEach((i) => i.classList.remove('active'))
      el.classList.add('active')
      state.sort = el.dataset.sort
      void refresh()
    }
  })
  $('#skill-mine').onclick = () => { state.mode = state.mode === 'mine' ? 'market' : 'mine'; void refresh() }
  $('#skill-storage').onclick = () => openStorageModal()
  const reviewBtn = $('#skill-review')
  if (reviewBtn) reviewBtn.onclick = () => { state.mode = state.mode === 'review' ? 'market' : 'review'; void refresh() }
  const submitBtn = $('#skill-submit')
  if (submitBtn) submitBtn.onclick = () => openSubmitModal(ctx, refresh)

  await refresh()
  if (params.get('action') === 'submit' && session.can('skill.submit')) openSubmitModal(ctx, refresh)
  if (params.get('focus')) void openSkillDetail(params.get('focus'), ctx, refresh, heatState)
}

async function openSkillDetail(id, ctx, refresh, heatState) {
  const [skill, agentData] = await Promise.all([
    api.get(`/api/skills/${id}`),
    api.get('/api/agents').catch(() => ({ agents: [] })),
  ])
  const versions = [...skill.versions].reverse()
  const current = versions[0]

  // 30 天热力：优先列表已带回的字段/页面级缓存，缺省时单独补拉（focus 直达场景）
  let heat = Array.isArray(skill.heat) ? skill.heat : heatState?.byId?.get(skill.id)
  if (!heat) {
    const hm = await api.get('/api/skills/usage-heatmap?days=30').catch(() => null)
    heat = hm?.skills?.find((s) => s.id === skill.id)?.cells
  }

  const drawer = openDrawer({
    title: skill.name,
    sub: `${skill.category} · v${skill.currentVersion} · ${rqI18n.t('发布者 {name}', { name: skill.authorName })}`,
    wide: true,
    body: `
      <div class="flex mb-8" style="gap:8px;flex-wrap:wrap;align-items:center">
        ${statusBadge(skill.status)}
        <span class="risk-pill ${skill.riskLevel === 'high' ? 'risk-crit' : skill.riskLevel === 'medium' ? 'risk-high' : 'risk-normal'}">${skill.riskLevel === 'high' ? '高风险（需安全加签）' : skill.riskLevel === 'medium' ? '中风险' : '低风险'}</span>
        ${skill.verified ? `<span class="flex" style="gap:4px;align-items:center;color:var(--ok);font-size:12px">${icon('shieldCheck', 14)} Ed25519 验签通过</span>` : ''}
        ${skill.tags.map((tag) => `<span class="badge badge-muted no-dot">${esc(tag)}</span>`).join('')}
      </div>
      <div class="fs-13" style="line-height:1.7;color:var(--text-2)">${esc(skill.description || skill.summary)}</div>
      ${skill.deprecatedReason ? `
        <div class="muted-box mt-8" style="display:flex;gap:8px;border-color:var(--warn-border);background:var(--warn-bg)">
          ${icon('alert', 15)}<span><b>弃用原因</b>${esc(rqI18n.t('：{reason}{at}', { reason: skill.deprecatedReason, at: skill.deprecatedAt ? `（${timeAgo(skill.deprecatedAt)}）` : '' }))}</span>
        </div>` : ''}

      <div class="stat-grid mt-14 mb-14" style="grid-template-columns:repeat(4,1fr)">
        ${miniStat('download', '下载量', fmtNum(skill.stats.downloads))}
        ${miniStat('box', '安装量', fmtNum(skill.stats.installs))}
        ${miniStat('star', '评分', rqI18n.t('{r}（{n} 人）', { r: skill.stats.rating || '—', n: skill.stats.ratingCount }))}
        ${miniStat('layers', '版本数', versions.length)}
      </div>

      <div class="mb-14">
        <div class="micro-label mb-8">30 天使用热力</div>
        ${heat ? heatStrip(heat, { big: true }) : emptyHint('近 30 天暂无使用记录')}
        <p class="fs-11 text-4" style="margin-top:6px">usage 计量事件为主、计量接入前下载流水按日回填去重；色深 = 当日使用次数</p>
      </div>

      <div class="tabs" id="sk-tabs">
        <div class="tab active" data-tab="readme">效果示例</div>
        <div class="tab" data-tab="versions">版本与审批</div>
      </div>
      <div id="sk-tab-body"></div>`,
    foot: `
      ${skill.status === 'published' ? `<button class="btn btn-default" id="sk-download">${icon('download', 14)}下载</button>` : ''}
      ${skill.status === 'published' && session.can('skill.install') ? `<button class="btn btn-primary" id="sk-install">${icon('plus', 14)}安装到团队</button>` : ''}
      ${canManage(skill) ? `<button class="btn btn-default" id="sk-edit">${icon('edit', 14)}编辑信息</button>` : ''}
      ${canManage(skill) && skill.versions.some((v) => v.status === 'published') ? `<button class="btn btn-default" id="sk-repkg">${icon('refresh', 14)}更新资源包</button>` : ''}
      ${session.can('skill.approve') && (current?.status === 'pending_domain' || current?.status === 'pending_security') ? `<button class="btn btn-primary" id="sk-approve">${icon('check', 14)}审批</button>` : ''}
      ${session.can('skill.approve') && current?.status === 'approved' && skill.status !== 'published' ? `<button class="btn btn-primary" id="sk-publish">${icon('send', 14)}上架</button>` : ''}
      ${session.can('skill.publish') && skill.status === 'published' ? `<button class="btn btn-danger-ghost" id="sk-deprecate">${icon('alert', 14)}弃用</button>` : ''}
      ${session.can('skill.publish') && ['deprecated', 'offline', 'rejected'].includes(skill.status) ? `<button class="btn btn-danger-ghost" id="sk-delete">${icon('trash', 14)}删除</button>` : ''}`,
  })

  const tabBody = drawer.body.querySelector('#sk-tab-body')
  const renderTab = (tab) => {
    if (tab === 'readme') {
      tabBody.innerHTML = `
        <div class="muted-box" style="display:flex;gap:8px;margin-bottom:12px">
          ${icon('info', 15)}<span>${esc(rqI18n.t('SKILL.md 由模型按需加载：何时使用 / 操作步骤 / 输出格式。适用模型：{models}', { models: skill.applicableModels.map(esc).join('、') }))}</span>
        </div>
        <div class="code-block">${esc(current?.content ?? '（暂无内容）')}</div>`
    }
    if (tab === 'versions') {
      tabBody.innerHTML = `
        <div class="timeline">
          ${versions.map((v) => `
            <div class="timeline-item ${v.status === 'published' ? 'ok' : v.status === 'rejected' ? 'danger' : 'current'}">
              <div class="timeline-dot"></div>
              <div class="timeline-title flex" style="gap:8px">v${esc(v.version)} ${statusBadge(versionStatus(v.status))}</div>
              <div class="timeline-time">${esc(rqI18n.t('提交于 {time}', { time: timeAgo(v.submittedAt) }))}${v.publishedAt ? esc(rqI18n.t(' · 上架于 {time}', { time: timeAgo(v.publishedAt) })) : ''}</div>
              <div class="timeline-body">${esc(v.changelog)}</div>
              ${v.package ? `
                <div class="fs-12 mt-8" style="color:var(--text-3);display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  ${icon('server', 12)}<span>${esc(rqI18n.t('包存储：{where}', { where: v.package.storage === 'nas' ? `NAS（${esc(v.package.nasId ?? '')}）` : rqI18n.t('平台本地') }))}</span>
                  ${v.package.path ? `<span class="mono text-4" style="word-break:break-all">${esc(v.package.path)}</span>` : ''}
                  ${v.package.sizeBytes !== undefined ? `<span>· ${fmtBytes(v.package.sizeBytes)}</span>` : ''}
                  ${v.package.uploadedAt ? `<span class="text-4">· ${timeAgo(v.package.uploadedAt)}</span>` : ''}
                </div>` : ''}
              ${v.findings?.length ? `
                <div class="mt-8">
                  ${v.findings.map((f) => `
                    <div class="flex" style="padding:3px 0">
                      <span style="color:var(--${f.level === 'block' ? 'danger' : f.level === 'warn' ? 'warn' : 'info'})">${icon(f.level === 'block' ? 'alert' : f.level === 'warn' ? 'alert' : 'info', 13)}</span>
                      <span class="fs-12">${esc(f.message)}<span class="mono text-4" style="margin-left:6px">${esc(f.rule)}</span></span>
                    </div>`).join('')}
                </div>` : ''}
              ${v.approvals?.length ? `
                <div class="mt-8">
                  ${v.approvals.map((a) => `
                    <div class="flex" style="padding:3px 0">
                      <span style="color:var(--ok)">${icon('check', 13)}</span>
                      <span class="fs-12">${esc(rqI18n.t('{level}：{name} —— {opinion}', { level: a.level === 'domain' ? rqI18n.t('领域审批') : rqI18n.t('安全加签'), name: a.approverName, opinion: a.opinion }))}</span>
                    </div>`).join('')}
                </div>` : ''}
              ${v.rejectedReason ? `<div class="fs-12" style="color:var(--danger);padding:4px 0">${esc(rqI18n.t('驳回原因：{reason}', { reason: v.rejectedReason }))}</div>` : ''}
            </div>`).join('')}
        </div>`
    }
  }
  drawer.body.querySelectorAll('#sk-tabs .tab').forEach((el) => {
    el.onclick = () => {
      drawer.body.querySelectorAll('#sk-tabs .tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })
  renderTab('readme')

  const downloadBtn = drawer.el.querySelector('#sk-download')
  if (downloadBtn) downloadBtn.onclick = async () => {
    try {
      // 先登记下载（审计可回溯谁下载了哪个版本），再拉 zip 触发浏览器保存
      await api.post(`/api/skills/${skill.id}/download`, {})
      const blob = await downloadBlob(`/api/skills/${skill.id}/package?version=${encodeURIComponent(skill.currentVersion)}`)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${skill.slug}-${skill.currentVersion}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast(rqI18n.t('已下载 skill.zip（下载已登记）'))
    } catch (error) { toast(error.message, 'error') }
  }
  const installBtn = drawer.el.querySelector('#sk-install')
  if (installBtn) installBtn.onclick = () => {
    const modal = openModal({
      title: '安装到 Agent',
      body: `
        ${field('目标 Agent', searchableSelectField('agentId', agentData.agents.map((a) => ({ value: a.id, label: rqI18n.t('{name}（{status}）', { name: a.name, status: rqI18n.t(AGENT_STATUS_LABEL[a.status] ?? a.status) }) })), { placeholder: '点击选择目标 Agent，支持搜索' }), { required: true })}
        <div class="form-hint">安装后自动登记依赖关系，Agent 的「关联 Skill」属性同步回填。</div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>安装</button>',
    })
    mountSearchableSelects(modal.el)
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      try {
        await api.post(`/api/skills/${skill.id}/install`, { agentId: collectForm(modal.body).agentId, version: skill.currentVersion })
        toast(rqI18n.t('安装成功，依赖已登记')); modal.close(); drawer.close(); refresh?.()
      } catch (error) { toast(error.message, 'error') }
    }
  }
  const editBtn = drawer.el.querySelector('#sk-edit')
  if (editBtn) editBtn.onclick = () => openEditModal(skill, ctx, refresh)
  const repkgBtn = drawer.el.querySelector('#sk-repkg')
  if (repkgBtn) repkgBtn.onclick = () => openReplacePackageModal(skill, ctx, refresh)
  const approveBtn = drawer.el.querySelector('#sk-approve')
  if (approveBtn) approveBtn.onclick = () => {
    const needLevel = current?.status === 'pending_domain' ? 'domain' : 'security'
    const modal = openModal({
      title: rqI18n.t('审批 · {name} v{version}', { name: skill.name, version: current.version }),
      body: `
        <div class="muted-box mb-14" style="display:flex;gap:8px">
          ${icon('info', 15)}
          <span>${needLevel === 'domain' ? rqI18n.t('领域负责人审批：评估业务适用性与描述准确性。') : rqI18n.t('安全团队加签：该 Skill 包含外联/写文件等高风险行为。')}${skill.riskLevel === 'high' ? rqI18n.t('（高风险：两级审批均须通过，允许同一人连审两级）') : ''}</span>
        </div>
        ${field('审批意见', textareaField('opinion', { placeholder: '请说明审批依据…' }), { required: true })}`,
      foot: '<button class="btn btn-danger-ghost" data-reject>驳回</button><button class="btn btn-primary" data-ok>通过</button>',
    })
    modal.el.querySelector('[data-reject]').onclick = async () => {
      const opinion = collectForm(modal.body).opinion
      if (!opinion) return toast(rqI18n.t('请填写意见'), 'error')
      try {
        await api.post(`/api/skills/${skill.id}/approve`, { decision: 'reject', level: needLevel, opinion })
        toast(rqI18n.t('已驳回')); modal.close(); drawer.close(); refresh?.()
      } catch (error) { toast(error.message, 'error') }
    }
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const opinion = collectForm(modal.body).opinion
      if (!opinion) return toast(rqI18n.t('请填写意见'), 'error')
      try {
        await api.post(`/api/skills/${skill.id}/approve`, { decision: 'approve', level: needLevel, opinion })
        toast(rqI18n.t('审批通过')); modal.close(); drawer.close(); refresh?.()
      } catch (error) { toast(error.message, 'error') }
    }
  }
  const publishBtn = drawer.el.querySelector('#sk-publish')
  if (publishBtn) publishBtn.onclick = async () => {
    try {
      await api.post(`/api/skills/${skill.id}/publish`, {})
      toast(rqI18n.t('已上架市场')); drawer.close(); refresh?.()
    } catch (error) { toast(error.message, 'error') }
  }
  const deprecateBtn = drawer.el.querySelector('#sk-deprecate')
  if (deprecateBtn) deprecateBtn.onclick = async () => {
    const result = await confirmDialog({
      title: '弃用 Skill', requireReason: true, danger: true, confirmText: '确认弃用',
      message: '弃用后市场不可安装；存量引用的 Agent 会收到迁移告警。旧版本保留可回滚。',
    })
    if (!result) return
    try {
      const response = await api.post(`/api/skills/${skill.id}/deprecate`, { reason: result.reason })
      if (response.referencingAgents?.length) {
        toast(rqI18n.t('已弃用；{n} 个 Agent 收到迁移告警', { n: response.referencingAgents.length }))
      } else {
        toast(rqI18n.t('已弃用'))
      }
      drawer.close(); refresh?.()
    } catch (error) { toast(error.message, 'error') }
  }

  const deleteBtn = drawer.el.querySelector('#sk-delete')
  if (deleteBtn) deleteBtn.onclick = async () => {
    const result = await confirmDialog({
      title: rqI18n.t('删除 Skill · {name}', { name: skill.name }), requireReason: true, danger: true, confirmText: '确认删除',
      message: '将永久删除该 Skill 记录（含全部版本与下载/安装登记），操作不可恢复；审计数据保留。',
    })
    if (!result) return
    try {
      await api.delete(`/api/skills/${skill.id}`)
      toast(rqI18n.t('已删除')); drawer.close(); refresh?.()
    } catch (error) { toast(error.message, 'error') }
  }
}

function openSubmitModal(ctx, refresh) {
  const modal = openModal({
    title: '提交 Skill 到市场', wide: true,
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">
        ${icon('zap', 15)}<span>提交后自动进入流水线：<b>静态扫描</b>（恶意代码 / 密钥泄露检测）→ <b>领域审批</b> → 高风险额外 <b>安全加签</b> → 上架。</span>
      </div>
      <div class="form-grid">
        ${field('名称', inputField('name'), { required: true })}
        ${field('分类', selectField('category', ASSET_CATEGORIES.map((c) => ({ value: c, label: c }))))}
        ${field('一句话简介', inputField('summary'), { full: true })}
        ${field('版本号', inputField('version', { value: '1.0.0' }))}
        ${field('标签（逗号分隔）', inputField('tags', { placeholder: '文档,自动化' }))}
      </div>
      ${field('SKILL.md 内容', textareaField('content', { placeholder: '# Skill 名称\n\n## 何时使用\n…\n\n## 操作步骤\n1. …', rows: 8 }), { required: true, hint: '静态扫描将检测破坏性命令、动态执行、密钥泄露等风险模式' })}
      ${field('Skill 包（skill.zip，选填）', '<input class="input" type="file" id="skill-pkg" accept=".zip,application/zip">', { hint: '随版本保存：上架时按存储配置写入平台本地或 NAS（见「存储配置」）' })}`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>提交（进入扫描）</button>',
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      const data = collectForm(modal.body)
      const pkgFile = modal.body.querySelector('#skill-pkg')?.files?.[0]
      let packageBase64
      if (pkgFile) packageBase64 = await readFileBase64(pkgFile)
      const result = await api.post('/api/skills', {
        name: data.name, category: data.category, summary: data.summary, version: data.version,
        content: data.content,
        tags: data.tags ? data.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
        ...(packageBase64 !== undefined ? { packageBase64 } : {}),
      })
      modal.close()
      if (result.status === 'rejected') {
        openModal({
          title: '静态扫描未通过（自动驳回）',
          body: `<div class="form-hint" style="margin-bottom:10px">检测到阻断级问题，请修复后重新提交：</div>
            ${result.findings.filter((f) => f.level === 'block').map((f) => `<div class="flex" style="padding:4px 0"><span style="color:var(--danger)">${icon('alert', 14)}</span><span class="fs-13">${esc(f.message)}</span></div>`).join('')}`,
          foot: '<button class="btn btn-primary" data-ok>知道了</button>',
        })
      } else {
        const warns = result.findings?.filter((f) => f.level === 'warn') ?? []
        openModal({
          title: '已提交，等待审批',
          body: warns.length
            ? `<div class="form-hint" style="margin-bottom:8px">扫描发现风险提示（将要求安全加签）：</div>${warns.map((f) => `<div class="flex" style="padding:3px 0"><span style="color:var(--warn)">${icon('alert', 14)}</span><span class="fs-13">${esc(f.message)}</span></div>`).join('')}`
            : `<div class="flex" style="gap:8px;padding:8px 0"><span style="color:var(--ok)">${icon('check', 16)}</span><span>扫描通过，进入领域审批环节。</span></div>`,
          foot: '<button class="btn btn-primary" data-ok>知道了</button>',
        })
      }
      refresh?.()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

/** 是否可管理该 Skill（编辑信息 / 更新资源包）：作者本人或平台管理员。 */
function canManage(skill) {
  return skill.authorId === session.user?.id || session.can('skill.publish')
}

/** 编辑已上架 Skill 的市场信息（名称/分类/标签/简介/描述/适用模型/依赖/可见性）；slug 保持不变。 */
function openEditModal(skill, ctx, refresh) {
  const modal = openModal({
    title: rqI18n.t('编辑信息 · {name}', { name: skill.name }), wide: true,
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">
        ${icon('info', 15)}<span>直接更新市场展示信息，无需重新走审批；Skill 标识（slug）与已有版本保持不变。SKILL.md 内容变更请提交新版本。</span>
      </div>
      <div class="form-grid">
        ${field('名称', inputField('name', { value: skill.name }), { required: true })}
        ${field('分类', selectField('category', ASSET_CATEGORIES.map((c) => ({ value: c, label: c })), { value: ASSET_CATEGORIES.includes(skill.category) ? skill.category : '其他' }))}
        ${field('作者 / 开发者名称', inputField('authorName', { value: skill.authorName }), { hint: '市场署名（列表与详情展示）；Skill 归属账号不变' })}
        ${field('一句话简介', inputField('summary', { value: skill.summary }), { full: true })}
        ${field('标签（逗号分隔）', inputField('tags', { value: (skill.tags ?? []).join(','), placeholder: '文档,自动化' }))}
        ${field('适用模型（逗号分隔）', inputField('applicableModels', { value: (skill.applicableModels ?? []).join(',') }))}
        ${field('依赖 Skill slug（逗号分隔）', inputField('deps', { value: (skill.deps ?? []).join(',') }), { hint: '安装该 Skill 时建议一并安装的前置 Skill' })}
        ${field('可见性', selectField('visibility', [
          { value: 'all', label: '全员可见' },
          { value: 'orgs', label: '指定组织可见' },
        ], { value: skill.visibility === 'orgs' ? 'orgs' : 'all' }))}
        ${field('目标组织 ID（逗号分隔）', inputField('targetOrgs', { value: (skill.targetOrgs ?? []).join(','), placeholder: 'org_xxx,org_yyy' }), { full: true, hint: '可见性为「指定组织」时必填；成员仅在其所属组织内可见该 Skill' })}
      </div>
      ${field('详细描述', textareaField('description', { value: skill.description || '', rows: 6, placeholder: '面向使用者的完整说明：能力边界、前置条件、使用示例…' }))}`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
  })
  const syncOrgVisibility = () => {
    const needOrg = modal.body.querySelector('[name="visibility"]')?.value === 'orgs'
    const orgItem = modal.body.querySelector('[name="targetOrgs"]')?.closest('.form-item')
    if (orgItem) orgItem.style.display = needOrg ? '' : 'none'
  }
  syncOrgVisibility()
  modal.body.querySelector('[name="visibility"]').onchange = syncOrgVisibility
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      const data = collectForm(modal.body)
      const toList = (value) => (value ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      if (data.visibility === 'orgs' && toList(data.targetOrgs).length === 0) {
        throw new Error(rqI18n.t('可见性为「指定组织」时须填写至少一个目标组织 ID'))
      }
      await api.patch(`/api/skills/${skill.id}`, {
        name: data.name, category: data.category, summary: data.summary, description: data.description,
        tags: toList(data.tags), applicableModels: toList(data.applicableModels), deps: toList(data.deps),
        visibility: data.visibility, authorName: data.authorName,
        ...(data.visibility === 'orgs' ? { targetOrgs: toList(data.targetOrgs) } : {}),
      })
      toast(rqI18n.t('信息已更新')); modal.close()
      openSkillDetail(skill.id, ctx, refresh)
      refresh?.()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

/** 重新手动上传当前已发布版本的 skill.zip 资源包（原地替换，版本号不变）。 */
function openReplacePackageModal(skill, ctx, refresh) {
  const published = [...skill.versions].reverse().find((v) => v.status === 'published')
  const pkg = published?.package
  const modal = openModal({
    title: rqI18n.t('更新资源包 · v{version}', { version: published?.version ?? skill.currentVersion }),
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">
        ${icon('info', 15)}<span>上传新的 skill.zip 原地替换当前已发布版本的资源包：<b>版本号不变</b>、不重走审批；下载/安装即刻取到新包。存储后端为 NAS 时会同步重传（失败则本次更新不生效）。</span>
      </div>
      ${pkg ? `
      <div class="desc-grid mb-14">
        <div class="desc-item"><span class="k">当前包</span><span class="v">${pkg.storage === 'nas' ? `NAS · ${esc(pkg.path ?? '')}` : esc(rqI18n.t('平台本地'))}</span></div>
        ${pkg.sizeBytes !== undefined ? `<div class="desc-item"><span class="k">大小</span><span class="v">${fmtBytes(pkg.sizeBytes)}</span></div>` : ''}
        ${pkg.uploadedAt ? `<div class="desc-item"><span class="k">上传于</span><span class="v">${timeAgo(pkg.uploadedAt)}</span></div>` : ''}
      </div>` : ''}
      ${field('skill.zip 包', '<input class="input" type="file" id="skill-repkg" accept=".zip,application/zip">', { required: true, hint: '须为合法 ZIP（PK 魔数），base64 后上限 32MB' })}`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>上传并替换</button>',
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const file = modal.body.querySelector('#skill-repkg')?.files?.[0]
    if (!file) return toast(rqI18n.t('请选择 skill.zip 文件'), 'error')
    btn.classList.add('btn-loading')
    try {
      const packageBase64 = await readFileBase64(file)
      const result = await api.put(`/api/skills/${skill.id}/package`, { packageBase64 })
      toast(rqI18n.t('资源包已更新（{size}{nas}）', { size: fmtBytes(result.package?.sizeBytes ?? 0), nas: result.package?.storage === 'nas' ? rqI18n.t(' · 已上传 NAS') : '' }))
      modal.close()
      openSkillDetail(skill.id, ctx, refresh)
      refresh?.()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

/** Skill 包存储配置（local / NAS）：写入口需 skill.storage.write，无权限降级只读。 */
async function openStorageModal() {
  let data
  try {
    data = await api.get('/api/skill-storage')
  } catch (error) {
    toast(error.message, 'error')
    return
  }
  const { config, nasOptions } = data
  const canWrite = session.can('skill.storage.write')
  const modal = openModal({
    title: 'Skill 包存储配置',
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">
        ${icon('info', 15)}<span>决定 Skill 上架时 skill.zip 包的存放位置：<b>平台本地</b>（内联存储）或 <b>NAS</b>（上架时上传到指定 NAS 资产的 basePath 下）。</span>
      </div>
      ${canWrite ? `
      <div class="form-item">
        <label class="form-label">存储模式</label>
        <div class="segmented" id="st-mode">
          <span class="segmented-item ${config.mode !== 'nas' ? 'active' : ''}" data-m="local">平台本地</span>
          <span class="segmented-item ${config.mode === 'nas' ? 'active' : ''}" data-m="nas">NAS</span>
        </div>
      </div>
      <div id="st-nas-fields" style="${config.mode === 'nas' ? '' : 'display:none'}">
        ${nasOptions.length ? `
          ${field('目标 NAS（仅已上线）', selectField('nasId', nasOptions.map((n) => ({ value: n.id, label: rqI18n.t('{name}（{slug} · 根路径 {path}）', { name: n.name, slug: n.slug, path: n.rootPath ?? '/' }) })), { value: config.nasId }), { required: true })}
          ${field('basePath', inputField('basePath', { value: config.basePath ?? '/skillhub', placeholder: '/skillhub' }), { required: true, hint: '以 / 开头的绝对路径（如 /共享名/skillhub），上架时按 Skill 归档' })}
        ` : '<div class="muted-box" style="color:var(--warn)">暂无「已上线」的 NAS 资产可选：请先在「NAS 存储」页纳管并上线。</div>'}
      </div>` : `
      <div class="desc-grid">
        <div class="desc-item"><span class="k">当前模式</span><span class="v">${config.mode === 'nas' ? 'NAS' : '平台本地'}</span></div>
        ${config.mode === 'nas' ? `
          <div class="desc-item"><span class="k">目标 NAS</span><span class="v mono">${esc(config.nasId ?? '—')}</span></div>
          <div class="desc-item"><span class="k">basePath</span><span class="v mono">${esc(config.basePath ?? '—')}</span></div>` : ''}
        <div class="desc-item"><span class="k">最近更新</span><span class="v">${config.updatedAt ? `${timeAgo(config.updatedAt)} · ${esc(config.updatedBy ?? '')}` : '—'}</span></div>
      </div>
      <div class="form-hint mt-8">你当前没有 skill.storage.write 权限，仅可查看。</div>`}`,
    foot: canWrite
      ? '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>'
      : '<button class="btn btn-primary" data-ok>关闭</button>',
  })
  if (!canWrite) return
  let mode = config.mode === 'nas' ? 'nas' : 'local'
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.body.querySelectorAll('#st-mode .segmented-item').forEach((el) => {
    el.onclick = () => {
      modal.body.querySelectorAll('#st-mode .segmented-item').forEach((i) => i.classList.remove('active'))
      el.classList.add('active')
      mode = el.dataset.m
      modal.body.querySelector('#st-nas-fields').style.display = mode === 'nas' ? '' : 'none'
    }
  })
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const form = collectForm(modal.body)
    if (mode === 'nas' && !nasOptions.length) return toast(rqI18n.t('暂无可用的已上线 NAS 资产'), 'error')
    btn.classList.add('btn-loading')
    try {
      await api.put('/api/skill-storage', mode === 'nas'
        ? { mode, nasId: form.nasId, basePath: form.basePath }
        : { mode })
      toast(rqI18n.t('存储配置已保存')); modal.close()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(rqI18n.t('读取本地文件失败')))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

function fmtBytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB'
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KB'
  return n + ' B'
}

function versionStatus(status) {
  const map = {
    published: 'published', approved: 'approved', rejected: 'rejected',
    pending_domain: 'pending_domain', pending_security: 'pending_security',
    scanning: 'scanning', deprecated: 'deprecated',
  }
  return map[status] ?? status
}

function miniStat(ic, label, value) {
  return `
    <div style="background:var(--surface-2);border-radius:10px;padding:12px 14px">
      <div style="color:var(--brand-500)">${icon(ic, 16)}</div>
      <div style="font-size:16px;font-weight:700;margin-top:6px">${value}</div>
      <div class="stat-sub">${esc(label)}</div>
    </div>`
}

function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}

/** 技能热力图卡片：行=skill、列=日、色深=使用次数（下载/安装计量口径）。 */
function heatCard({ days, skills, maxCell }) {
  const rows = skills.slice(0, 12)
  const cell = 15
  const gap = 3
  const labelW = 148
  const width = labelW + days.length * (cell + gap)
  const height = rows.length * (cell + gap) + 16
  const cells = rows.map((skill, r) => skill.cells.map((value, c) => {
    const opacity = value > 0 ? 0.1 + 0.9 * (value / maxCell) : 0.04
    return `<rect x="${labelW + c * (cell + gap)}" y="${r * (cell + gap)}" width="${cell}" height="${cell}" rx="3" fill="var(--brand-500)" fill-opacity="${opacity.toFixed(2)}"><title>${esc(rqI18n.t('{name} · {day} · {n} 次', { name: skill.name, day: days[c], n: value }))}</title></rect>`
  }).join('')).join('')
  const rowLabels = rows.map((skill, r) =>
    `<text x="0" y="${r * (cell + gap) + 11}" font-size="11" fill="var(--text-3)">${esc(skill.name.length > 13 ? skill.name.slice(0, 12) + '…' : skill.name)}</text>`).join('')
  const dayTicks = days.map((day, c) => c % 7 === 6
    ? `<text x="${labelW + c * (cell + gap)}" y="${height - 3}" font-size="10" fill="var(--text-4)">${esc(day.slice(5))}</text>` : '').join('')
  return `
    <div class="card">
      <div class="card-head"><span class="card-title">${icon('chart', 15)} 技能使用热力图</span><span class="card-sub">近 30 天 · 下载/安装计量（含历史流水回填）</span></div>
      <div class="card-body" style="padding-top:10px">
        <div style="overflow-x:auto">
          <svg width="${Math.max(width, 360)}" height="${height}" style="display:block">
            ${rowLabels}${cells}${dayTicks}
          </svg>
        </div>
        <div class="flex fs-11 text-4" style="justify-content:space-between;margin-top:4px">
          <span>${esc(rqI18n.t('Top {n}（按窗口使用次数）', { n: rows.length }))}</span>
          <span>${esc(rqI18n.t('色深 = 当日使用次数（峰值 {n}）', { n: maxCell }))}</span>
        </div>
      </div>
    </div>`
}
