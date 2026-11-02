/** 执行中枢（D 团队前端 · 目标/项目/任务/调度四位一体）：
 *  总览（健康与队列）→ 目标（OKR 树 + 项目）→ 任务（Issue 流转与唤醒）→ 调度（唤醒队列 + 例行规则）。
 *  后端 /api/exec/* 未就绪或失败时按 tab 降级为错误卡（不白屏），操作失败统一 toast。 */
import { api, session } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, confirmDialog, collectForm,
  field, inputField, selectField, textareaField, statusBadge, timeAgo, fmtTime,
} from '../ui.js'

// ---------- 字典 ----------
const ORG_ROLE_LABEL = { ceo: 'CEO', cto: 'CTO', manager: '经理', engineer: '工程师', analyst: '分析师' }
const HEALTH_BADGE = {
  healthy: ['badge-ok', '健康'], stale: ['badge-warn', '迟滞'], silent: ['badge-danger', '失联'],
  frozen: ['badge-purple', '已冻结'], offline: ['badge-muted', '离线'],
}
const ISSUE_STATUS = {
  todo: ['badge-muted', '待办'], in_progress: ['badge-info', '进行中'], review: ['badge-warn', '待审'],
  done: ['badge-ok', '完成'], cancelled: ['badge-muted', '已取消'],
}
const ISSUE_TRANSITIONS = {
  todo: [['in_progress', '开始'], ['cancelled', '取消']],
  in_progress: [['review', '提审'], ['cancelled', '取消']],
  review: [['done', '完成'], ['in_progress', '退回'], ['cancelled', '取消']],
}
const PRIORITY_BADGE = { P0: 'badge-danger', P1: 'badge-warn', P2: 'badge-info', P3: 'badge-muted' }
const TRIGGER_BADGE = {
  assign: ['badge-brand', '派发'], comment: ['badge-info', '评论'], dependency: ['badge-purple', '依赖解除'],
  routine: ['badge-ok', '例行'], api: ['badge-muted', 'API'], webhook: ['badge-info', 'Webhook'],
}
const GOAL_STATUS = {
  active: ['badge-info', '进行中'], done: ['badge-ok', '已完成'], paused: ['badge-warn', '已暂停'],
  archived: ['badge-muted', '已归档'], draft: ['badge-muted', '草案'],
}
const ROUTINE_KIND = { interval: ['badge-info', '定时间隔'], cron: ['badge-brand', 'Cron'], webhook: ['badge-purple', 'Webhook'] }

const badge = (map, key) => {
  const [cls, text] = map[key] ?? ['badge-muted', key ?? '—']
  return `<span class="badge ${cls} no-dot">${esc(text)}</span>`
}

/** 按当前会话组织过滤可选 Agent（自己组织优先；组织未知或无匹配时回落全量，避免空下拉）。 */
function agentsOfMyOrg(agents) {
  const myOrg = session.user?.orgId
  if (!myOrg) return agents
  const mine = agents.filter((a) => a.orgId === myOrg)
  return mine.length ? mine : agents
}

// ---------- 页面骨架 ----------
export async function renderExec(content, params, ctx) {
  const tab = params.get('tab') ?? 'overview'
  if (!session.can('exec.read')) {
    content.innerHTML = `
      <div class="page-head"><div><div class="micro-label">EXEC HUB</div><div class="page-title">执行中枢</div></div></div>
      <div class="card card-pad" style="text-align:center;padding:44px 24px">
        <div style="font-size:30px;margin-bottom:10px">🔒</div>
        <div style="font-weight:600;margin-bottom:6px">无访问权限</div>
        <div class="fs-12 text-3">需要「exec.read」权限（执行中枢只读）才能查看目标、任务与调度。</div>
      </div>`
    return
  }

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">EXEC HUB</div>
        <div class="page-title">执行中枢</div>
        <div class="page-sub">目标 → 项目 → 任务 → Agent 执行：唤醒队列驱动的心跳式调度，人机共用的执行视图。</div>
      </div>
      <div class="page-actions" id="exec-actions"></div>
    </div>
    <div class="tabs" id="exec-tabs">
      <div class="tab ${tab === 'overview' ? 'active' : ''}" data-tab="overview">总览</div>
      <div class="tab ${tab === 'goals' ? 'active' : ''}" data-tab="goals">目标</div>
      <div class="tab ${tab === 'issues' ? 'active' : ''}" data-tab="issues">任务</div>
      <div class="tab ${tab === 'routine' ? 'active' : ''}" data-tab="routine">调度</div>
    </div>
    <div id="exec-body"><div class="card card-pad text-4" style="text-align:center">加载中…</div></div>`

  $$('#exec-tabs .tab').forEach((el) => {
    el.onclick = () => { location.hash = `#/exec?tab=${el.dataset.tab}` }
  })

  const body = $('#exec-body')
  await renderTab(tab, body, ctx)

  // ⌘K「新建执行任务」入口（cmdk 设标记 + 派发事件双通道，事件早到由标记兜底）
  hookNewIssueEvent()
  if (window.__execNewIssueRequested) {
    window.__execNewIssueRequested = false
    setTimeout(() => openIssueCreate(ctx), 60)
  }
}

async function renderTab(tab, body, ctx) {
  if (tab === 'goals') return renderGoalsTab(body, ctx)
  if (tab === 'issues') return renderIssuesTab(body, ctx)
  if (tab === 'routine') return renderRoutineTab(body, ctx)
  return renderOverviewTab(body, ctx)
}

/** 单 tab 加载失败 → 错误卡 + 重试（dashboard.js 降级模式），不白屏。 */
function mountErrorCard(body, title, message, retry) {
  body.innerHTML = `
    <div class="card card-pad" style="text-align:center;padding:44px 24px">
      <div style="font-size:30px;margin-bottom:10px">🚫</div>
      <div style="font-weight:600;margin-bottom:6px">${esc(title)}</div>
      <div class="fs-12 text-3" style="margin-bottom:18px">${esc(message)}</div>
      <button class="btn btn-default" data-retry>重试</button>
    </div>`
  body.querySelector('[data-retry]').onclick = () => {
    body.innerHTML = '<div class="card card-pad text-4" style="text-align:center">加载中…</div>'
    void retry()
  }
}

// ---------- Tab 1：总览 ----------
async function renderOverviewTab(body, ctx) {
  let ov
  try {
    ov = await api.get('/api/exec/overview')
  } catch (error) {
    return mountErrorCard(body, '执行总览加载失败', rqI18n.t('{msg}（执行中枢后端可能尚未部署到当前宿主）', { msg: error.message }), () => renderTab('overview', body, ctx))
  }
  const agents = ov.agentsHealth ?? []

  body.innerHTML = `
    <div class="stat-grid mb-20">
      ${statItem('zap', '待唤醒', ov.pendingWakes ?? 0, '已入队等待派发的唤醒', 'var(--warn)', 'var(--warn-bg)')}
      ${statItem('clock', '延迟队列', ov.deferredWakes ?? 0, '因阻塞/休眠延后的唤醒', 'var(--info)', 'var(--info-bg)')}
      ${statItem('activity', '活跃 Run', ov.activeRuns ?? 0, '执行中的运行实例', 'var(--ok)', 'var(--ok-bg)')}
      ${statItem('lock', '锁定中任务', ov.lockedIssues ?? 0, ov.zombieLocks ? rqI18n.t('含 {n} 个疑似僵尸锁', { n: ov.zombieLocks }) : '被 run 持锁执行的任务', 'var(--purple)', 'var(--purple-bg)')}
    </div>
    <div class="card">
      <div class="card-head">
        <span class="card-title">${icon('bot', 15)} Agent 健康</span>
        <span class="card-sub">${esc(rqI18n.t('{n} 个 Agent 接入组织执行', { n: agents.length }))}</span>
        ${session.can('exec.admin') ? `<div class="card-head-actions"><button class="btn btn-primary btn-sm" id="exec-tick">${icon('play', 13)} 立即调度一轮</button></div>` : ''}
      </div>
      <div class="card-body" style="padding-top:6px">
        ${agents.length ? `
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>Agent</th><th>组织角色</th><th>职级</th><th>状态</th><th>冻结</th><th>最近心跳</th><th>最近提报</th><th>健康度</th></tr></thead>
            <tbody>
              ${agents.map((a) => `
                <tr>
                  <td><div class="col-strong">${esc(a.name ?? a.agentId)}</div><div class="col-sub mono fs-11">${esc(a.agentId ?? '')}</div></td>
                  <td class="fs-12">${esc(ORG_ROLE_LABEL[a.orgRole] ?? a.orgRole ?? '—')}</td>
                  <td class="fs-12">${esc(a.rank ?? '—')}</td>
                  <td>${a.status ? statusBadge(a.status) : '<span class="text-4 fs-12">—</span>'}</td>
                  <td>${a.frozen ? '<span class="badge badge-purple no-dot">已冻结</span>' : '<span class="text-4 fs-12">—</span>'}</td>
                  <td class="fs-12 text-3">${a.lastHeartbeatAt ? timeAgo(a.lastHeartbeatAt) : '—'}</td>
                  <td class="fs-12 text-3">${a.lastMetricsReportAt ? timeAgo(a.lastMetricsReportAt) : '—'}</td>
                  <td>${badge(HEALTH_BADGE, a.health)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : `<div class="tbl-empty">${icon('bot', 28)}<span>暂无 Agent 健康数据——Agent 接入组织并上报心跳后显示</span></div>`}
      </div>
    </div>`

  const tickBtn = body.querySelector('#exec-tick')
  if (tickBtn) tickBtn.onclick = async () => {
    tickBtn.classList.add('btn-loading')
    try {
      const r = await api.post('/api/exec/tick')
      toast(rqI18n.t('调度完成：处理 {a} · 唤醒 {b} · 延迟 {c} · 跳过 {d} · 回收锁 {e}', { a: r.processed, b: r.woken, c: r.deferred, d: r.skipped, e: r.reclaimed }))
      await renderTab('overview', body, ctx)
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      tickBtn.classList.remove('btn-loading')
    }
  }
}

function statItem(ic, label, value, foot, color, bg) {
  return `
    <div class="stat-card">
      <div class="stat-icon" style="background:${bg};color:${color}">${icon(ic, 18)}</div>
      <div class="stat-value">${esc(String(value ?? 0))}</div>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-foot">${esc(foot)}</div>
    </div>`
}

// ---------- Tab 2：目标 ----------
async function renderGoalsTab(body, ctx) {
  let goalsData, projectsData
  try {
    ;[goalsData, projectsData] = await Promise.all([
      api.get('/api/exec/goals'),
      api.get('/api/exec/projects'),
    ])
  } catch (error) {
    return mountErrorCard(body, '目标数据加载失败', rqI18n.t('{msg}（执行中枢后端可能尚未部署到当前宿主）', { msg: error.message }), () => renderTab('goals', body, ctx))
  }
  const goals = goalsData.goals ?? []
  const projects = projectsData.projects ?? []
  const goalById = new Map(goals.map((g) => [g.id, g]))
  const canWrite = session.can('exec.write')

  // 父子树：父目标不在集合（或空 parentGoalId）的作为根
  const childrenOf = new Map()
  const roots = []
  for (const goal of goals) {
    if (goal.parentGoalId && goalById.has(goal.parentGoalId)) {
      if (!childrenOf.has(goal.parentGoalId)) childrenOf.set(goal.parentGoalId, [])
      childrenOf.get(goal.parentGoalId).push(goal)
    } else roots.push(goal)
  }

  const goalRow = (goal, depth) => {
    const kids = childrenOf.get(goal.id) ?? []
    return `
      <div class="goal-row" data-id="${esc(goal.id)}" style="padding-left:${depth * 22}px">
        <div class="flex" style="gap:10px;align-items:flex-start;flex-wrap:wrap">
          ${depth > 0 ? `<span class="text-4" style="font-size:12px">${icon('chevronRight', 12)}</span>` : ''}
          <div class="grow" style="min-width:220px">
            <div class="flex" style="gap:8px;flex-wrap:wrap">
              <span style="font-weight:600">${esc(goal.title)}</span>
              ${badge(GOAL_STATUS, goal.status)}
            </div>
            <div class="fs-12 text-3 mt-4">
              ${goal.metric ? esc(rqI18n.t('指标：{metric} {base} → {target}{unit}', { metric: goal.metric, base: String(goal.metricBaseline ?? '?'), target: String(goal.metricTarget ?? '?'), unit: goal.metricUnit ?? '' })) : '未设指标'}
              ${goal.periodStart || goal.periodEnd ? esc(rqI18n.t(' · 期限 {start} ~ {end}', { start: goal.periodStart ?? '?', end: goal.periodEnd ?? '?' })) : ''}
            </div>
          </div>
          ${canWrite ? `
          <div style="flex-shrink:0;display:flex;gap:6px">
            <button class="btn btn-ghost btn-sm stop" data-goal-edit="${esc(goal.id)}">${icon('edit', 12)}编辑</button>
            <button class="btn btn-danger-ghost btn-sm stop" data-goal-del="${esc(goal.id)}">${icon('trash', 12)}删除</button>
          </div>` : ''}
        </div>
      </div>
      ${kids.map((kid) => goalRow(kid, depth + 1)).join('')}`
  }

  body.innerHTML = `
    <div class="card mb-20">
      <div class="card-head">
        <span class="card-title">${icon('target', 15)} 目标树</span>
        <span class="card-sub">${esc(rqI18n.t('{n} 个目标', { n: goals.length }))}</span>
        ${canWrite ? `<div class="card-head-actions">
          <button class="btn btn-default btn-sm" id="goal-create">${icon('plus', 13)} 新建目标</button>
          <button class="btn btn-primary btn-sm" id="project-create">${icon('plus', 13)} 新建项目</button>
        </div>` : ''}
      </div>
      <div class="card-body" style="padding-top:4px">
        ${goals.length ? roots.map((goal) => goalRow(goal, 0)).join('') : `<div class="tbl-empty">${icon('target', 28)}<span>还没有目标——从公司级目标开始逐层拆解</span></div>`}
      </div>
    </div>
    <div class="card">
      <div class="card-head">
        <span class="card-title">${icon('layers', 15)} 项目</span>
        <span class="card-sub">${esc(rqI18n.t('{n} 个项目承接目标落地', { n: projects.length }))}</span>
      </div>
      <div class="card-body" style="padding-top:8px">
        ${projects.length ? `
        <div class="grid-2">
          ${projects.map((p) => {
            const progress = p.issueProgress ?? {}
            const total = progress.total ?? 0
            const done = progress.done ?? 0
            const pct = total > 0 ? Math.round((done / total) * 100) : 0
            return `
            <div class="muted-box" style="display:flex;flex-direction:column;gap:8px">
              <div class="flex" style="gap:8px;align-items:center">
                <span style="font-weight:600">${icon('box', 13)} ${esc(p.name)}</span>
                <span style="flex:1"></span>
                <span class="fs-12 text-3">${esc(goalById.get(p.goalId)?.title ?? p.goalId ?? '未关联目标')}</span>
              </div>
              ${p.description ? `<div class="fs-12 text-3">${esc(p.description)}</div>` : ''}
              ${(p.repos ?? []).length ? `<div class="flex" style="gap:6px;flex-wrap:wrap">${p.repos.map((repo) => `<span class="badge badge-muted no-dot mono fs-11">${esc(repo)}</span>`).join('')}</div>` : ''}
              <div>
                <div class="flex fs-12" style="justify-content:space-between;margin-bottom:3px">
                  <span class="text-3">任务进度</span>
                  <span style="font-weight:600">${done}/${total}${esc(rqI18n.t('（{p}%）', { p: pct }))}</span>
                </div>
                <div style="height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden">
                  <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#0052D9,#00A3FF)"></div>
                </div>
              </div>
            </div>`
          }).join('')}
        </div>` : `<div class="tbl-empty">${icon('box', 28)}<span>暂无项目——新建项目承接目标执行</span></div>`}
      </div>
    </div>`

  if (canWrite) {
    body.querySelector('#goal-create').onclick = () => openGoalForm(goals, null, ctx)
    body.querySelector('#project-create').onclick = () => openProjectForm(goals, null, ctx)
    body.querySelectorAll('[data-goal-edit]').forEach((btn) => {
      btn.onclick = () => openGoalForm(goals, goalById.get(btn.dataset.goalEdit), ctx)
    })
    body.querySelectorAll('[data-goal-del]').forEach((btn) => {
      btn.onclick = async () => {
        const goal = goalById.get(btn.dataset.goalDel)
        const confirmed = await confirmDialog({
          title: rqI18n.t('删除目标 · {name}', { name: goal.title }), danger: true, confirmText: '确认删除',
          message: rqI18n.t('将删除目标「<b>{name}</b>」。其下仍有子目标或关联项目时服务端会拒绝（409）。', { name: esc(goal.title) }),
        })
        if (!confirmed) return
        try {
          await api.delete(`/api/exec/goals/${goal.id}`)
          toast(rqI18n.t('目标已删除')); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    })
  }
}

/** 新建/编辑目标抽屉（编辑时排除自身及其子孙作为父目标候选）。 */
function openGoalForm(goals, goal, ctx) {
  const excluded = new Set()
  if (goal) {
    const collect = (id) => { excluded.add(id); (childrenListOf(goals, id) ?? []).forEach((kid) => collect(kid.id)) }
    collect(goal.id)
  }
  const parentOptions = [
    { value: '', label: '（作为顶级目标）' },
    ...goals.filter((g) => !excluded.has(g.id)).map((g) => ({ value: g.id, label: g.title })),
  ]
  const drawer = openDrawer({
    title: goal ? '编辑目标' : '新建目标',
    sub: goal ? `ID ${goal.id}` : '目标自上而下拆解：公司 → 部门 → 个人/Agent',
    body: `
      ${field('标题', inputField('title', { value: goal?.title }), { required: true, full: true })}
      ${field('描述', textareaField('description', { value: goal?.description, rows: 2 }), { full: true })}
      <div class="form-grid">
        ${field('指标', inputField('metric', { value: goal?.metric, placeholder: '如：客户工单 24h 解决率' }))}
        ${field('单位', inputField('metricUnit', { value: goal?.metricUnit, placeholder: '如：% / 单 / 万元' }))}
        ${field('基线', `<input class="input" type="number" step="any" name="metricBaseline" value="${esc(goal?.metricBaseline ?? '')}" placeholder="当前值">`)}
        ${field('目标值', `<input class="input" type="number" step="any" name="metricTarget" value="${esc(goal?.metricTarget ?? '')}" placeholder="期望值">`)}
        ${field('父目标', selectField('parentGoalId', parentOptions, { value: goal?.parentGoalId ?? '' }))}
        ${field('负责人', inputField('ownerUserId', { value: goal?.ownerUserId, placeholder: '用户 ID（选填）' }))}
        ${field('开始日期', `<input class="input" type="date" name="periodStart" value="${esc(goal?.periodStart ?? '')}">`)}
        ${field('结束日期', `<input class="input" type="date" name="periodEnd" value="${esc(goal?.periodEnd ?? '')}">`)}
      </div>`,
    foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>${goal ? '保存' : '创建'}</button>`,
  })
  drawer.el.querySelector('[data-cancel]').onclick = () => drawer.close()
  drawer.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const data = collectForm(drawer.body)
    if (!data.title) return toast(rqI18n.t('请填写目标标题'), 'error')
    const payload = {
      title: data.title,
      description: data.description || undefined,
      metric: data.metric || undefined,
      metricBaseline: data.metricBaseline === '' ? undefined : Number(data.metricBaseline),
      metricTarget: data.metricTarget === '' ? undefined : Number(data.metricTarget),
      metricUnit: data.metricUnit || undefined,
      ownerUserId: data.ownerUserId || undefined,
      parentGoalId: data.parentGoalId || undefined,
      periodStart: data.periodStart || undefined,
      periodEnd: data.periodEnd || undefined,
    }
    btn.classList.add('btn-loading')
    try {
      if (goal) await api.patch(`/api/exec/goals/${goal.id}`, payload)
      else await api.post('/api/exec/goals', payload)
      toast(goal ? rqI18n.t('目标已保存') : rqI18n.t('目标已创建'))
      drawer.close(); ctx.rerender()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

function childrenListOf(goals, parentId) {
  return goals.filter((g) => g.parentGoalId === parentId)
}

/** 新建项目抽屉（代码仓以逗号分隔录入，提交转数组）。 */
function openProjectForm(goals, project, ctx) {
  const goalOptions = [
    { value: '', label: '（暂不关联目标）' },
    ...goals.map((g) => ({ value: g.id, label: g.title })),
  ]
  const drawer = openDrawer({
    title: project ? '编辑项目' : '新建项目',
    sub: '项目承接目标，任务挂在项目下执行',
    body: `
      ${field('名称', inputField('name', { value: project?.name }), { required: true, full: true })}
      ${field('描述', textareaField('description', { value: project?.description, rows: 2 }), { full: true })}
      ${field('关联目标', selectField('goalId', goalOptions, { value: project?.goalId ?? '' }), { full: true })}
      ${field('代码仓', inputField('repos', { value: (project?.repos ?? []).join(', '), placeholder: '逗号分隔，如 github.com/ybkk/ops, github.com/ybkk/panel' }), { full: true, hint: '多个仓库用逗号分隔' })}`,
    foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>${project ? '保存' : '创建'}</button>`,
  })
  drawer.el.querySelector('[data-cancel]').onclick = () => drawer.close()
  drawer.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const data = collectForm(drawer.body)
    if (!data.name) return toast(rqI18n.t('请填写项目名称'), 'error')
    const payload = {
      name: data.name,
      description: data.description || undefined,
      goalId: data.goalId || undefined,
      repos: data.repos ? data.repos.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
    }
    btn.classList.add('btn-loading')
    try {
      if (project) await api.patch(`/api/exec/projects/${project.id}`, payload)
      else await api.post('/api/exec/projects', payload)
      toast(project ? rqI18n.t('项目已保存') : rqI18n.t('项目已创建'))
      drawer.close(); ctx.rerender()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

// ---------- Tab 3：任务 ----------
async function renderIssuesTab(body, ctx) {
  let all
  try {
    all = await api.get('/api/exec/issues')
  } catch (error) {
    return mountErrorCard(body, '任务列表加载失败', rqI18n.t('{msg}（执行中枢后端可能尚未部署到当前宿主）', { msg: error.message }), () => renderTab('issues', body, ctx))
  }
  const issues = all.issues ?? []
  const canWrite = session.can('exec.write')

  // 筛选器候选项从全量数据派生（状态 / 项目 / Agent 三维，服务端过滤）
  const statusOptions = [{ value: '', label: '全部状态' }, ...Object.keys(ISSUE_STATUS).map((s) => ({ value: s, label: ISSUE_STATUS[s][1] }))]
  const projectOptions = [{ value: '', label: '全部项目' }, ...distinct(issues.map((i) => i.projectId), issues.map((i) => i.projectName))]
  const agentOptions = [{ value: '', label: '全部 Agent' }, ...distinct(issues.map((i) => i.assigneeAgentId), issues.map((i) => i.assigneeAgentName))]

  body.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title">${icon('checkSquare', 15)} 任务</span>
        <span class="card-sub" id="issue-count"></span>
        ${canWrite ? `<div class="card-head-actions"><button class="btn btn-primary btn-sm" id="issue-create">${icon('plus', 13)} 新建任务</button></div>` : ''}
      </div>
      <div class="card-body" style="padding-top:8px">
        <div class="filter-bar">
          <select class="select" id="issue-f-status" style="width:130px">${statusOptions.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>
          <select class="select" id="issue-f-project" style="width:170px">${projectOptions.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>
          <select class="select" id="issue-f-agent" style="width:150px">${agentOptions.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>
        </div>
        <div class="table-wrap" id="issue-table"></div>
      </div>
    </div>`

  if (canWrite) body.querySelector('#issue-create').onclick = () => openIssueCreate(ctx)

  async function reload() {
    const status = body.querySelector('#issue-f-status').value
    const projectId = body.querySelector('#issue-f-project').value
    const agentId = body.querySelector('#issue-f-agent').value
    let data
    try {
      data = await api.get('/api/exec/issues' + api.qs({ status, projectId, agentId }))
    } catch (error) {
      body.querySelector('#issue-table').innerHTML = `<div class="tbl-empty">${icon('alert', 28)}<span>${esc(rqI18n.t('加载失败：{msg}', { msg: error.message }))}</span></div>`
      return
    }
    const list = data.issues ?? []
    body.querySelector('#issue-count').textContent = rqI18n.t('共 {n} 条', { n: list.length })
    body.querySelector('#issue-table').innerHTML = list.length ? `
      <table class="tbl">
        <thead><tr><th>标题</th><th>状态</th><th>执行锁</th><th>负责人 Agent</th><th>优先级</th><th>所属项目</th><th>截止</th>${canWrite ? '<th style="width:250px">操作</th>' : ''}</tr></thead>
        <tbody>
          ${list.map((issue) => `
            <tr data-id="${esc(issue.id)}">
              <td><div class="col-strong">${esc(issue.title)}</div>${(issue.blockerIds ?? []).length ? `<div class="col-sub fs-11">${esc(rqI18n.t('阻塞于 {n} 个前置任务', { n: issue.blockerIds.length }))}</div>` : ''}</td>
              <td>${badge(ISSUE_STATUS, issue.status)}</td>
              <td>${lockedBadge(issue)}</td>
              <td class="fs-12">${esc(issue.assigneeAgentName ?? issue.assigneeAgentId ?? '未指派')}</td>
              <td><span class="badge ${PRIORITY_BADGE[issue.priority] ?? 'badge-muted'} no-dot">${esc(issue.priority ?? '—')}</span></td>
              <td class="fs-12">${esc(issue.projectName ?? '—')}</td>
              <td class="fs-12 text-3">${issue.dueAt ? fmtTime(issue.dueAt).slice(0, 10) : '—'}</td>
              ${canWrite ? `
              <td>
                <div class="flex" style="gap:6px;flex-wrap:wrap">
                  ${(ISSUE_TRANSITIONS[issue.status] ?? []).map(([to, label]) =>
                    `<button class="btn btn-${to === 'cancelled' ? 'danger-ghost' : 'default'} btn-sm stop" data-transition="${esc(issue.id)}" data-to="${esc(to)}">${esc(label)}</button>`).join('')}
                  <button class="btn btn-default btn-sm stop" data-wake="${esc(issue.id)}" title="手动触发一次唤醒（入队派发）">${icon('zap', 12)} 唤醒</button>
                  <button class="btn btn-ghost btn-sm stop" data-detail="${esc(issue.id)}">详情</button>
                </div>
              </td>` : ''}
            </tr>`).join('')}
        </tbody>
      </table>` : `<div class="tbl-empty">${icon('checkSquare', 28)}<span>当前筛选下没有任务</span></div>`

    body.querySelectorAll('[data-transition]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api.post(`/api/exec/issues/${btn.dataset.transition}/transition`, { to: btn.dataset.to })
          toast(rqI18n.t('已流转到「{status}」', { status: rqI18n.t(ISSUE_STATUS[btn.dataset.to]?.[1] ?? btn.dataset.to) }))
          await reload()
        } catch (error) { toast(error.message, 'error') }
      }
    })
    body.querySelectorAll('[data-wake]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api.post(`/api/exec/issues/${btn.dataset.wake}/wake`, { reason: 'manual' })
          toast(rqI18n.t('已触发唤醒（进入唤醒队列）'))
          await reload()
        } catch (error) { toast(error.message, 'error') }
      }
    })
    body.querySelectorAll('[data-detail]').forEach((btn) => {
      btn.onclick = () => openIssueDetail(btn.dataset.detail, ctx)
    })
  }

  for (const id of ['issue-f-status', 'issue-f-project', 'issue-f-agent']) {
    body.querySelector(`#${id}`).onchange = () => void reload()
  }
  await reload()
}

function lockedBadge(issue) {
  if (!issue.executionRunId) return '<span class="text-4 fs-12">—</span>'
  const runHead = String(issue.executionRunId).slice(0, 6)
  return `<span class="badge badge-purple no-dot mono" title="${esc(rqI18n.t('运行 {run}{locked}', { run: issue.executionRunId, locked: issue.executionLockedAt ? rqI18n.t(' · 加锁于 {time}', { time: fmtTime(issue.executionLockedAt) }) : '' }))}">🔒 ${esc(runHead)}</span>`
}

function distinct(ids, labels) {
  const seen = new Set()
  const out = []
  ids.forEach((id, index) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push({ value: id, label: labels[index] ?? id })
  })
  return out
}

/** ⌘K「新建执行任务」事件钩子（跨渲染只保留一个监听器）。 */
let newIssueHook = null
function hookNewIssueEvent() {
  if (newIssueHook) window.removeEventListener('exec:new-issue', newIssueHook)
  newIssueHook = () => {
    window.__execNewIssueRequested = false
    openIssueCreate({ rerender: () => {
      const target = '#/exec?tab=issues'
      if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'))
      else location.hash = target
    } })
  }
  window.addEventListener('exec:new-issue', newIssueHook)
}

/** 新建任务抽屉：负责人 Agent 按自己组织过滤；前置任务 = 单选下拉 + 已选 chips。 */
async function openIssueCreate(ctx) {
  const [agentsRes, projectsRes, issuesRes] = await Promise.all([
    api.get('/api/agents').catch(() => ({ agents: [] })),
    api.get('/api/exec/projects').catch(() => ({ projects: [] })),
    api.get('/api/exec/issues').catch(() => ({ issues: [] })),
  ])
  const agents = agentsOfMyOrg(agentsRes.agents ?? [])
  const projects = projectsRes.projects ?? []
  const blockers = (issuesRes.issues ?? []).filter((i) => i.status !== 'done' && i.status !== 'cancelled')

  const drawer = openDrawer({
    title: '新建执行任务',
    sub: '指派给 Agent 后自动触发派发唤醒',
    body: `
      ${field('标题', inputField('title'), { required: true, full: true })}
      ${field('详情', textareaField('detail', { rows: 3, placeholder: '任务背景、验收标准、注意事项…' }), { full: true })}
      <div class="form-grid">
        ${field('所属项目', selectField('projectId', [{ value: '', label: '（不挂项目）' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]))}
        ${field('负责人 Agent', selectField('assigneeAgentId', [{ value: '', label: '（暂不指派）' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]), { hint: '仅显示与本账号同组织的 Agent' })}
        ${field('优先级', selectField('priority', ['P0', 'P1', 'P2', 'P3'].map((p) => ({ value: p, label: p })), { value: 'P2' }))}
        ${field('截止日期', `<input class="input" type="date" name="dueAt">`)}
      </div>
      ${field('前置任务', `
        <div class="flex" style="gap:8px">
          ${selectField('blockerPick', [{ value: '', label: '选择前置任务（可选）' }, ...blockers.map((i) => ({ value: i.id, label: rqI18n.t('{title}（{status}）', { title: i.title, status: rqI18n.t(ISSUE_STATUS[i.status]?.[1] ?? i.status) }) }))], {})}
          <button type="button" class="btn btn-default btn-sm" id="blocker-add" style="height:34px">${icon('plus', 12)}添加</button>
        </div>
        <div class="chips mt-8" id="blocker-chips"></div>`, { full: true, hint: '前置任务完成（依赖解除）前，本任务不会唤醒执行' })}`,
    foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>创建任务</button>`,
  })

  const picked = new Set()
  const blockerById = new Map(blockers.map((i) => [i.id, i]))
  const renderChips = () => {
    const chipsEl = drawer.body.querySelector('#blocker-chips')
    chipsEl.innerHTML = [...picked].map((id) => `
      <span class="chip active" data-chip="${esc(id)}">${esc(blockerById.get(id)?.title ?? id)} ✕</span>`).join('')
    chipsEl.querySelectorAll('[data-chip]').forEach((chip) => {
      chip.onclick = () => { picked.delete(chip.dataset.chip); renderChips() }
    })
  }
  drawer.body.querySelector('#blocker-add').onclick = () => {
    const pick = drawer.body.querySelector('[name="blockerPick"]').value
    if (!pick) return toast(rqI18n.t('请先在下拉中选择前置任务'), 'error')
    picked.add(pick)
    renderChips()
  }

  drawer.el.querySelector('[data-cancel]').onclick = () => drawer.close()
  drawer.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const data = collectForm(drawer.body)
    if (!data.title) return toast(rqI18n.t('请填写任务标题'), 'error')
    btn.classList.add('btn-loading')
    try {
      await api.post('/api/exec/issues', {
        title: data.title,
        detail: data.detail || undefined,
        projectId: data.projectId || undefined,
        assigneeAgentId: data.assigneeAgentId || undefined,
        priority: data.priority || 'P2',
        dueAt: data.dueAt || undefined,
        blockerIds: [...picked],
      })
      toast(rqI18n.t('任务已创建（指派 Agent 时已自动入队唤醒）'))
      drawer.close()
      ctx.rerender()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

/** 任务详情抽屉：详情文本 + 血缘链（goal→project）+ blockers + 上下文包（若返回）。 */
async function openIssueDetail(issueId, ctx) {
  let issue = null
  let lineage = null
  try {
    const [issuesRes, lineageRes] = await Promise.all([
      api.get('/api/exec/issues'),
      api.get(`/api/exec/lineage/${issueId}`),
    ])
    issue = (issuesRes.issues ?? []).find((i) => i.id === issueId) ?? null
    lineage = lineageRes
  } catch {
    // 血缘接口失败：仅展示本地可推导信息（不阻断详情）
  }
  if (!issue && !lineage) return toast(rqI18n.t('任务详情加载失败'), 'error')

  const ancestry = lineage?.ancestry ?? issue?.goalAncestry ?? []
  const blockers = lineage?.blockers ?? []
  const contextPack = lineage?.contextPack ?? lineage?.context ?? null

  const drawer = openDrawer({
    title: issue?.title ?? rqI18n.t('任务 {id}', { id: issueId }),
    sub: `${badge(ISSUE_STATUS, issue?.status)} ${issue?.projectName ? ` · ${issue.projectName}` : ''}`,
    body: `
      <div class="desc-grid mb-14">
        <div class="desc-item"><span class="k">负责人 Agent</span><span class="v">${esc(issue?.assigneeAgentName ?? issue?.assigneeAgentId ?? '未指派')}</span></div>
        <div class="desc-item"><span class="k">优先级</span><span class="v">${esc(issue?.priority ?? '—')}</span></div>
        <div class="desc-item"><span class="k">截止</span><span class="v">${issue?.dueAt ? fmtTime(issue.dueAt) : '—'}</span></div>
        <div class="desc-item"><span class="k">执行锁</span><span class="v">${issue?.executionRunId ? `🔒 run ${esc(issue.executionRunId.slice(0, 8))}` : '无'}</span></div>
      </div>
      ${issue?.detail ? `
      <div class="card-title mb-8">任务详情</div>
      <div class="muted-box mb-14" style="white-space:pre-wrap">${esc(issue.detail)}</div>` : ''}
      <div class="card-title mb-8">血缘链（目标 → 项目）</div>
      <div class="mb-14 flex" style="gap:6px;flex-wrap:wrap;align-items:center">
        ${ancestry.length ? ancestry.map((title, index) => `${index > 0 ? `<span class="text-4">${icon('chevronRight', 12)}</span>` : ''}<span class="badge badge-brand no-dot">${esc(title?.title ?? title)}</span>`).join('') : '<span class="text-4 fs-12">未挂接目标链</span>'}
        ${lineage?.project ? `<span class="text-4">${icon('chevronRight', 12)}</span><span class="badge badge-info no-dot">${esc(lineage.project.name ?? lineage.project)}</span>` : ''}
      </div>
      <div class="card-title mb-8">前置任务</div>
      <div class="mb-14">
        ${blockers.length ? blockers.map((b) => `
          <div class="flex" style="padding:7px 0;border-bottom:1px solid var(--border)">
            ${badge(ISSUE_STATUS, b.status)}
            <span class="fs-12 grow ellipsis">${esc(b.title ?? b.id)}</span>
          </div>`).join('') : '<span class="text-4 fs-12">无前置任务</span>'}
      </div>
      ${contextPack ? `
      <div class="card-title mb-8">上下文包</div>
      <div class="code-block" style="max-height:220px">${esc(JSON.stringify(contextPack, null, 2))}</div>` : ''}`,
    foot: session.can('exec.write') ? `<button class="btn btn-default" data-wake>${icon('zap', 14)} 唤醒</button><button class="btn btn-default" data-close>关闭</button>` : '',
  })
  drawer.el.querySelector('[data-close]')?.addEventListener('click', () => drawer.close())
  drawer.el.querySelector('[data-wake]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      await api.post(`/api/exec/issues/${issueId}/wake`, { reason: 'manual' })
      toast(rqI18n.t('已触发唤醒')); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
  })
}

// ---------- Tab 4：调度 ----------
async function renderRoutineTab(body, ctx) {
  let wakesData, routinesData
  try {
    ;[wakesData, routinesData] = await Promise.all([
      api.get('/api/exec/wakes'),
      api.get('/api/exec/routines'),
    ])
  } catch (error) {
    return mountErrorCard(body, '调度数据加载失败', rqI18n.t('{msg}（执行中枢后端可能尚未部署到当前宿主）', { msg: error.message }), () => renderTab('routine', body, ctx))
  }
  const wakes = wakesData.wakes ?? []
  const routines = routinesData.routines ?? []
  const canWrite = session.can('exec.write')

  body.innerHTML = `
    <div class="card mb-20">
      <div class="card-head">
        <span class="card-title">${icon('zap', 15)} 唤醒队列</span>
        <span class="card-sub">${esc(rqI18n.t('{n} 条唤醒记录 · 失败项会带 lastError', { n: wakes.length }))}</span>
      </div>
      <div class="card-body" style="padding-top:6px">
        ${wakes.length ? `
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>触发源</th><th>状态</th><th>Agent</th><th>关联任务</th><th>创建时间</th><th>最近错误</th></tr></thead>
            <tbody>
              ${wakes.map((w) => `
                <tr>
                  <td>${badge(TRIGGER_BADGE, w.trigger)}${w.triggerDetail ? `<div class="col-sub fs-11 ellipsis" style="max-width:180px">${esc(w.triggerDetail)}</div>` : ''}</td>
                  <td>${w.status ? statusBadge(w.status) : '—'}</td>
                  <td class="fs-12">${esc(w.agentName ?? w.agentId ?? '—')}</td>
                  <td class="mono fs-11">${esc(w.issueId ?? '—')}</td>
                  <td class="fs-12 text-3">${w.createdAt ? timeAgo(w.createdAt) : '—'}</td>
                  <td>${w.lastError ? `<span class="fs-11 ellipsis" style="color:var(--danger);display:inline-block;max-width:220px;vertical-align:middle" title="${esc(w.lastError)}">${esc(w.lastError)}</span>` : '<span class="text-4 fs-12">—</span>'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : `<div class="tbl-empty">${icon('zap', 28)}<span>唤醒队列为空——派发、评论、依赖解除与例行规则都会在这里留痕</span></div>`}
      </div>
    </div>
    <div class="card">
      <div class="card-head">
        <span class="card-title">${icon('clock', 15)} 例行规则</span>
        <span class="card-sub">${esc(rqI18n.t('{n} 条 · 定时唤醒 Agent 执行例行工作', { n: routines.length }))}</span>
        ${canWrite ? `<div class="card-head-actions"><button class="btn btn-primary btn-sm" id="routine-create">${icon('plus', 13)} 新建例行</button></div>` : ''}
      </div>
      <div class="card-body" style="padding-top:6px">
        ${routines.length ? `
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>名称</th><th>Agent</th><th>类型</th><th>规则</th><th>启用</th><th>最近触发</th>${canWrite ? '<th>操作</th>' : ''}</tr></thead>
            <tbody>
              ${routines.map((r) => `
                <tr data-id="${esc(r.id)}">
                  <td class="col-strong">${esc(r.name)}</td>
                  <td class="fs-12">${esc(r.agentName ?? r.agentId ?? '—')}</td>
                  <td>${badge(ROUTINE_KIND, r.kind)}</td>
                  <td class="fs-12">${routineRuleText(r)}</td>
                  <td>${r.enabled ? '<span class="badge badge-ok no-dot">启用</span>' : '<span class="badge badge-muted no-dot">停用</span>'}</td>
                  <td class="fs-12 text-3">${r.lastFiredAt ? timeAgo(r.lastFiredAt) : '未触发'}</td>
                  ${canWrite ? `
                  <td>
                    <div class="flex" style="gap:6px">
                      <button class="btn btn-default btn-sm stop" data-toggle="${esc(r.id)}" data-next="${r.enabled ? 'false' : 'true'}">${r.enabled ? '停用' : '启用'}</button>
                      <button class="btn btn-danger-ghost btn-sm stop" data-rdel="${esc(r.id)}">${icon('trash', 12)}</button>
                    </div>
                  </td>` : ''}
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : `<div class="tbl-empty">${icon('clock', 28)}<span>暂无例行规则——为 Agent 配置定时间隔、Cron 或 Webhook 例行唤醒</span></div>`}
      </div>
    </div>`

  if (canWrite) {
    body.querySelector('#routine-create').onclick = () => void openRoutineCreate(ctx)
    body.querySelectorAll('[data-toggle]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api.patch(`/api/exec/routines/${btn.dataset.toggle}`, { enabled: btn.dataset.next === 'true' })
          toast(btn.dataset.next === 'true' ? rqI18n.t('已启用') : rqI18n.t('已停用'))
          await renderTab('routine', body, ctx)
        } catch (error) { toast(error.message, 'error') }
      }
    })
    body.querySelectorAll('[data-rdel]').forEach((btn) => {
      btn.onclick = async () => {
        const confirmed = await confirmDialog({
          title: '删除例行规则', danger: true, confirmText: '确认删除',
          message: '删除后该 Agent 的例行唤醒立即停止，操作不可恢复。',
        })
        if (!confirmed) return
        try {
          await api.delete(`/api/exec/routines/${btn.dataset.rdel}`)
          toast(rqI18n.t('例行规则已删除'))
          await renderTab('routine', body, ctx)
        } catch (error) { toast(error.message, 'error') }
      }
    })
  }
}

function routineRuleText(r) {
  if (r.kind === 'interval') return rqI18n.t('每 {n} 分钟', { n: r.intervalMinutes ?? '?' })
  if (r.kind === 'cron') return `<span class="mono">${esc(r.cron ?? '?')}</span>`
  if (r.kind === 'webhook') return `<span class="mono">${esc(r.webhookPath ?? '?')}</span>`
  return '—'
}

/** 新建例行抽屉：类型切换三种输入（间隔分钟 | Cron 5 段分钟级 | Webhook 路径自动生成）。 */
async function openRoutineCreate(ctx) {
  const agentsRes = await api.get('/api/agents').catch(() => ({ agents: [] }))
  const agents = agentsOfMyOrg(agentsRes.agents ?? [])

  const drawer = openDrawer({
    title: '新建例行规则',
    sub: '定时唤醒 Agent 执行例行工作（例会纪要、巡检提报…）',
    body: `
      <div class="form-grid">
        ${field('Agent', selectField('agentId', agents.map((a) => ({ value: a.id, label: a.name }))), { required: true })}
        ${field('名称', inputField('name', { placeholder: '如：每日晨会纪要' }), { required: true })}
      </div>
      ${field('类型', selectField('kind', [
        { value: 'interval', label: '定时间隔' },
        { value: 'cron', label: 'Cron 表达式' },
        { value: 'webhook', label: 'Webhook 触发' },
      ]), { full: true })}
      <div id="routine-kind-body">
        <div data-kind="interval">${field('间隔（分钟）', `<input class="input" type="number" name="intervalMinutes" min="1" placeholder="如 30" value="30">`, { full: true, hint: '每隔 N 分钟唤醒一次该 Agent' })}</div>
        <div data-kind="cron" style="display:none">${field('Cron 表达式', inputField('cron', { placeholder: '0 9 * * 1-5' }), { full: true, hint: '标准 5 段（分钟 小时 日 月 星期）分钟级；示例 0 9 * * 1-5 = 工作日每天 9:00' })}</div>
        <div data-kind="webhook" style="display:none">${field('Webhook 路径', inputField('webhookPath', { placeholder: '留空自动生成' }), { full: true, hint: '留空将按规则 ID 自动生成；外部系统 POST 该路径即触发一次唤醒' })}</div>
      </div>
      <label class="flex" style="gap:8px;align-items:center;cursor:pointer">
        <input type="checkbox" name="enabled" checked style="accent-color:var(--brand-500)">
        <span class="fs-12 text-2">创建后立即启用</span>
      </label>`,
    foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>创建</button>`,
  })

  drawer.body.querySelector('[name="kind"]').onchange = (e) => {
    const kind = e.target.value
    drawer.body.querySelectorAll('[data-kind]').forEach((el) => {
      el.style.display = el.dataset.kind === kind ? '' : 'none'
    })
  }

  drawer.el.querySelector('[data-cancel]').onclick = () => drawer.close()
  drawer.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const data = collectForm(drawer.body)
    if (!data.agentId) return toast(rqI18n.t('请选择 Agent'), 'error')
    if (!data.name) return toast(rqI18n.t('请填写名称'), 'error')
    const payload = {
      agentId: data.agentId,
      name: data.name,
      kind: data.kind,
      enabled: Boolean(data.enabled),
    }
    if (data.kind === 'interval') {
      if (!data.intervalMinutes) return toast(rqI18n.t('请填写间隔分钟数'), 'error')
      payload.intervalMinutes = Number(data.intervalMinutes)
    }
    if (data.kind === 'cron') {
      if (!data.cron) return toast(rqI18n.t('请填写 Cron 表达式'), 'error')
      payload.cron = data.cron
    }
    if (data.kind === 'webhook' && data.webhookPath) payload.webhookPath = data.webhookPath
    btn.classList.add('btn-loading')
    try {
      await api.post('/api/exec/routines', payload)
      toast(rqI18n.t('例行规则已创建'))
      drawer.close(); ctx.rerender()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}
