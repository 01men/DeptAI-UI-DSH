/**
 * A2A 协作（协作面治理视图，协作方案 §6）：数字员工跨运行时协作的统一视图。
 *   - 协作目录：在线员工 Agent Card 投影（技能 / 自治级别 / 运行时 / 密级天花板），关键字与治理维度筛选；
 *     持 agent.a2a.invoke 权限可在详情抽屉内直接发起协作（JSON-RPC message/send）；
 *   - 任务追踪：八态状态机任务表 + 详情抽屉（状态原因 / 协商要约 / 历史时间线 / 交付物 / 人工验收 / 取消任务）；
 *     抽屉打开且任务非终态时优先走任务 SSE（/v1/a2a/tasks/:id/events，快照 + 进度 + 终态帧），
 *     浏览器不支持 SSE / 建立失败 / 演示态无令牌时自动降级为 2s 轮询（realtime.js 统一通道，Q-15）；
 *   - 履约视图：每员工完成率 / 验收通过率 / 耗时分位 / Token 消耗，附协作链成本 Top（usage.read）与
 *     声明-授权一致性巡检摘要（a2a.admin 可立即巡检）；
 *   - 审批规则：关键字 / 密级阈值治理规则（读随目录；增删需 a2a.admin）；
 *   - UHP 执行：harness 注册表管理（uhp.read 可见，uhp.admin 增删启停）+ 执行记录查询。
 * 数据：/api/a2a/*、/api/uhp/*、/api/usage/collaborations、/api/agents/:slug/a2a（JSON-RPC）。
 * 隐私：任务视图对仅持目录读权限的非发起方脱敏（contentRedacted），正文区显示占位说明。
 */
import { api, session, BASE } from '../api.js'
import { createEventStream } from '../realtime.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog,
  renderTable, fmtNum, fmtPct, fmtCost, timeAgo, emptyState, maybeShowConceptCard,
} from '../ui.js'
import { chipRow, emptyHint } from '../components/asset-drawer.js'
import { ASSET_CATEGORIES } from '../taxonomy.js'

/** 任务八态（协议枚举保留 ASCII）→ 徽标色 + 中文伴随。 */
const A2A_STATE_META = {
  submitted: ['badge-info', '已受理'],
  working: ['badge-brand', '执行中'],
  input_required: ['badge-warn', '待补充输入'],
  auth_required: ['badge-warn', '待授权审批'],
  completed: ['badge-ok', '已完成'],
  failed: ['badge-danger', '执行失败'],
  canceled: ['badge-muted', '已取消'],
  rejected: ['badge-danger', '已拒绝'],
}

/** 任务终态（协议枚举保留 ASCII）：到达后停止抽屉轮询、隐藏取消入口。 */
const A2A_TERMINAL_STATES = new Set(Object.keys({
  completed: true,
  failed: true,
  canceled: true,
  rejected: true,
}))

/** 协作模式（A0-A3 协商矩阵输出）→ 中文伴随。 */
const A2A_MODE_LABEL = {
  single_turn: '单轮问答',
  execute_confirm: '执行 · 人在环确认',
  execute_report: '执行 · 事后报告',
  negotiate: '双向协商',
  rejected: '矩阵拒绝',
}

/** 自治级别 → 中文伴随（A0 只读应答 / A1 受控执行 / A2 自主执行 / A3 协商自治）。 */
const A2A_AUTONOMY_LABEL = {
  A0: 'A0 · 只读应答',
  A1: 'A1 · 受控执行',
  A2: 'A2 · 自主执行',
  A3: 'A3 · 协商自治',
}

/** 数据密级 → 中文伴随。 */
const A2A_CLASS_LABEL = { public: '公开', internal: '内部', secret: '秘密' }

/** 协商状态 → 中文伴随。 */
const A2A_NEGOTIATION_LABEL = { open: '协商中', accepted: '已达成', rejected: '已拒绝', expired: '已超限' }

/** 历史事件来源 / 类型 → 中文伴随。 */
const A2A_HISTORY_FROM = { caller: '发起方', target: '目标员工', system: '系统' }
const A2A_HISTORY_TYPE = { message: '消息', status: '状态', offer: '协商要约' }

/** 验收结论徽标用词（统计口径，与按钮文案分键：按钮见 A2A_ACCEPT_ACTIONS）。 */
const A2A_ACCEPTANCE_LABEL = { accepted: '验收通过', rejected: '验收驳回' }

/**
 * 人工验收动作（decision 协议值 → 抽屉按钮与确认弹窗文案）：
 * completed ≠ 业务闭环，验收通过才归档；理由必填并写入审计（验收不轻信自报）。
 * 按钮文案用「通过验收 / 验收驳回」独立键，不与统计用词「验收通过」共用（Q-19）。
 */
const A2A_ACCEPT_ACTIONS = {
  accepted: { label: '通过验收', action: '确认通过', button: 'btn-primary', icon: 'check', hint: '确认该任务交付达到验收标准：结论与理由写入审计日志，任务归档为验收通过。' },
  rejected: { label: '驳回验收', action: '确认驳回', button: 'btn-danger-ghost', icon: 'x', hint: '驳回该任务交付：结论与理由写入审计日志，由发起方跟进整改后重新发起协作。' },
}

/** 脱敏占位（后端 contentRedacted：仅持目录读权限的非发起方看不到正文）。 */
const A2A_REDACTED_NOTE = '正文已按权限脱敏（需发起方、验收员或平台管理员权限）'

/** UHP 执行记录状态（协议枚举保留 ASCII）→ 徽标色 + 中文伴随。 */
const UHP_STATUS_META = {
  queued: ['badge-muted', '排队中'],
  in_progress: ['badge-brand', '执行中'],
  completed: ['badge-ok', '已完成'],
  failed: ['badge-danger', '执行失败'],
  canceled: ['badge-muted', '已取消'],
}

/** 发起协作后的落点：跨 hash 重渲染传递，任务追踪渲染完成后打开该任务抽屉。 */
let pendingTaskFocus = null

/** 当前登录用户 id（callerSubject 形如 user:<id>；用于发起方判定与职责分离）。 */
function currentUserId() {
  return String(session.user?.id ?? '')
}

/** 是否任务发起人本人（职责分离：发起人不可验收自己发起的任务）。 */
function isInitiator(task) {
  const id = currentUserId()
  return id !== '' && task.callerSubject === `user:${id}`
}

export async function renderA2a(content, params, ctx) {
  const requested = params.get('tab') ?? 'directory'
  const uhpVisible = session.can('uhp.read')
  const tab = (requested === 'uhp' && !uhpVisible) ? 'directory' : requested
  // 首次访问概念卡（与 Agent/Skill 页同款：协作协议对业务成员有门槛）
  maybeShowConceptCard(content, 'a2a', {
    icon: 'flow',
    title: 'A2A 协作是什么？',
    subtitle: 'A2A = 数字员工之间的协作协议：能力目录发现 → 协商定模式 → 执行 → 人工验收闭环。',
    points: [
      '协作目录：在线员工的能力卡片（技能、自治级别、可承接密级），跨运行时统一发现。',
      '任务追踪：每笔协作任务的八态推进全程留痕，协商要约与交付物可回溯。',
      '验收闭环：任务完成 ≠ 业务闭环，人工验收通过才归档（验收不轻信自报）。',
    ],
  })
  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">A2A 协作</div>
        <div class="page-desc">数字员工跨运行时协作面：能力目录发现、协作任务全链路追踪（八态状态机 + 协商 + 人工验收）、履约与一致性巡检。</div>
      </div>
      <div class="page-actions" id="a2a-page-actions"></div>
    </div>
    <div class="tabs" id="a2a-tabs">
      <div class="tab ${tab === 'directory' ? 'active' : ''}" data-tab="directory">协作目录</div>
      <div class="tab ${tab === 'tasks' ? 'active' : ''}" data-tab="tasks">任务追踪</div>
      <div class="tab ${tab === 'fulfillment' ? 'active' : ''}" data-tab="fulfillment">履约视图</div>
      <div class="tab ${tab === 'rules' ? 'active' : ''}" data-tab="rules">审批规则</div>
      ${uhpVisible ? `<div class="tab ${tab === 'uhp' ? 'active' : ''}" data-tab="uhp">UHP 执行</div>` : ''}
    </div>
    <div id="a2a-body"></div>`
  $$('#a2a-tabs .tab').forEach((el) => {
    el.onclick = () => { location.hash = `#/a2a?tab=${el.dataset.tab}` }
  })
  if (tab === 'directory') await renderDirectory()
  if (tab === 'tasks') await renderTasks(params)
  if (tab === 'fulfillment') await renderFulfillment()
  if (tab === 'rules') await renderRules()
  if (tab === 'uhp') await renderUhp()
}

// ---------------------------------------------------------------------------
// 区块一：协作目录（Agent Card 投影卡片网格 + 检索筛选 + 发起协作）
// ---------------------------------------------------------------------------

async function renderDirectory() {
  const body = $('#a2a-body')
  body.innerHTML = `
    <div class="filter-bar">
      <div class="search-input">${icon('search')}<input class="input" id="a2a-q" placeholder="搜索员工名称 / slug / 能力描述" style="width:230px"></div>
      <select class="select" id="a2a-category" style="width:130px">
        <option value="">全部分类</option>
        ${ASSET_CATEGORIES.map((cat) => `<option value="${cat}">${cat}</option>`).join('')}
      </select>
      <select class="select" id="a2a-autonomy" style="width:150px">
        <option value="">全部自治级别</option>
        ${Object.entries(A2A_AUTONOMY_LABEL).map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('')}
      </select>
      <select class="select" id="a2a-runtime" style="width:130px"><option value="">全部运行时</option></select>
      <select class="select" id="a2a-dataclass" style="width:160px">
        <option value="">可承接任意密级</option>
        ${Object.entries(A2A_CLASS_LABEL).map(([value, label]) => `<option value="${esc(value)}">${esc(rqI18n.t('可承接「{cls}」', { cls: rqI18n.t(label) }))}</option>`).join('')}
      </select>
    </div>
    <div class="grid-cards g3" id="a2a-agent-cards"></div>`

  const state = { q: '', autonomy: '', runtime: '', dataClass: '', category: '' }
  const refresh = async () => {
    const result = await api.get('/api/a2a/directory' + api.qs({
      q: state.q || undefined,
      autonomy: state.autonomy || undefined,
      runtime: state.runtime || undefined,
      dataClass: state.dataClass || undefined,
      category: state.category || undefined,
    }))
    renderAgentCards(result.agents ?? [])
  }

  function renderAgentCards(agents) {
    const holder = $('#a2a-agent-cards')
    if (!holder) return
    holder.innerHTML = ''
    if (!agents.length) {
      holder.appendChild(emptyState({ title: '没有匹配的数字员工', desc: '换个关键字或筛选条件试试；仅「已上线」员工会进入协作目录', icon: 'bot' }))
      return
    }
    // 运行时筛选项按当前目录出现过的运行时回填（仅首渲染填充一次）
    const runtimeSel = $('#a2a-runtime')
    if (runtimeSel && runtimeSel.options.length <= 1) {
      const runtimes = [...new Set(agents.map((agent) => String(agent.runtime ?? '')).filter(Boolean))]
      for (const value of runtimes) {
        // 用 createElement 而非 new Option(...)：Option 构造器是浏览器专有全局，
        // jsdom/SSR 环境不存在，会让「目录 tab」在门禁环境里直接抛错（非真实行为）。
        const option = document.createElement('option')
        option.value = value
        option.textContent = value
        runtimeSel.appendChild(option)
      }
    }
    for (const agent of agents) {
      const skillCount = (agent.skills ?? []).length
      const card = h(`
        <div class="res-card fade-up" data-id="${esc(agent.agentId)}" style="cursor:pointer">
          <div class="res-card-top">
            <div class="res-icon" style="font-size:22px">${esc(agent.avatar ?? '🤖')}</div>
            <div class="grow" style="min-width:0">
              <div class="res-name"><span class="ellipsis" style="min-width:0" title="${esc(agent.name)}">${esc(agent.name)}</span></div>
              <div class="fs-12 text-4 ellipsis mono" style="margin-top:2px">${esc(agent.slug)}</div>
            </div>
            ${autonomyBadge(agent.autonomy)}
          </div>
          <div class="res-desc" title="${esc(agent.description)}">${esc(agent.description || '（暂无能力描述）')}</div>
          <div class="flex" style="gap:6px;flex-wrap:wrap;margin-top:10px;min-height:22px">
            <span class="badge badge-brand no-dot">${esc(agent.category ?? '其他')}</span>
            ${(agent.skills ?? []).slice(0, 4).map((skill) => `<span class="badge badge-muted no-dot" title="${esc(skill.description ?? '')}">${esc(skill.name)}</span>`).join('')}
            ${skillCount > 4 ? `<span class="fs-11 text-4" style="align-self:center">${esc(rqI18n.t('+{n} 项', { n: skillCount - 4 }))}</span>` : ''}
            ${skillCount === 0 ? `<span class="fs-11 text-4">${esc(rqI18n.t('暂未声明技能'))}</span>` : ''}
          </div>
          <div class="res-foot">
            <span class="metric" title="运行时">${icon('server', 13)}${esc(agent.runtime)}</span>
            <span class="metric" title="密级天花板（可承接的最高任务密级）">${icon('shield', 13)}${esc(rqI18n.t(A2A_CLASS_LABEL[agent.dataClassCeiling] ?? agent.dataClassCeiling))}</span>
            <span class="metric" title="技能数">${icon('zap', 13)}${skillCount}</span>
            <span style="margin-left:auto;color:var(--brand-500)">${esc(rqI18n.t('详情 →'))}</span>
          </div>
        </div>`)
      card.onclick = () => openAgentDrawer(agent)
      holder.appendChild(card)
    }
  }

  $('#a2a-q').oninput = debounce(() => { state.q = $('#a2a-q').value.trim(); void refresh() }, 300)
  $('#a2a-category').onchange = () => { state.category = $('#a2a-category').value; void refresh() }
  $('#a2a-autonomy').onchange = () => { state.autonomy = $('#a2a-autonomy').value; void refresh() }
  $('#a2a-runtime').onchange = () => { state.runtime = $('#a2a-runtime').value; void refresh() }
  $('#a2a-dataclass').onchange = () => { state.dataClass = $('#a2a-dataclass').value; void refresh() }
  await refresh()
}

/** 员工详情抽屉：完整卡片信息（技能清单 + 治理扩展字段 + 发起协作表单）。 */
function openAgentDrawer(agent) {
  const canInvoke = session.can('agent.a2a.invoke')
  const drawer = openDrawer({
    titleHtml: `${esc(agent.avatar ?? '🤖')} ${esc(agent.name)}`,
    subHtml: `<span class="mono">${esc(agent.slug)}</span> · ${esc(agent.runtime)} ${esc(rqI18n.t('运行时'))} · ${esc(rqI18n.t('{time}更新', { time: timeAgo(agent.updatedAt) }))}`,
    wide: true,
    body: `
      <div class="flex mb-8" style="gap:8px;flex-wrap:wrap;align-items:center">
        ${autonomyBadge(agent.autonomy)}
        <span class="badge badge-brand no-dot">${esc(agent.category ?? '其他')}</span>
        <span class="badge badge-info no-dot" title="可承接的最高任务密级">${esc(rqI18n.t('密级天花板'))} · ${esc(rqI18n.t(A2A_CLASS_LABEL[agent.dataClassCeiling] ?? agent.dataClassCeiling))}</span>
        <span class="badge badge-muted no-dot mono">${esc(agent.runtime)}</span>
      </div>
      <div class="fs-13" style="line-height:1.7;color:var(--text-2)">${esc(agent.description || '（暂无能力描述）')}</div>
      <div class="desc-grid mt-14 mb-14">
        <div class="desc-item"><span class="k">员工 ID</span><span class="v mono">${esc(agent.agentId)}</span></div>
        <div class="desc-item"><span class="k">计量主体</span><span class="v mono">${esc(agent.meteringSubject ?? '—')}</span></div>
        <div class="desc-item"><span class="k">能力卡片</span><span class="v mono">${esc(agent.url ?? '—')}</span></div>
        <div class="desc-item"><span class="k">卡片更新</span><span class="v">${timeAgo(agent.updatedAt)}</span></div>
      </div>
      <div class="micro-label mb-8">${esc(rqI18n.t('技能清单（{n}）', { n: (agent.skills ?? []).length }))}</div>
      ${(agent.skills ?? []).map((skill) => `
        <div class="muted-box mb-8">
          <div class="flex" style="gap:8px;align-items:center;flex-wrap:wrap">
            <b class="fs-13">${esc(skill.name)}</b>
            <span class="mono fs-11 text-4">${esc(skill.id)}</span>
          </div>
          ${skill.description ? `<div class="fs-12 text-3" style="margin-top:4px">${esc(skill.description)}</div>` : ''}
          ${(skill.tags ?? []).length ? `<div class="flex" style="gap:6px;flex-wrap:wrap;margin-top:6px">${skill.tags.map((tag) => `<span class="badge badge-muted no-dot">${esc(tag)}</span>`).join('')}</div>` : ''}
        </div>`).join('') || emptyHint('该员工暂未声明技能（卡片技能面为空）')}
      ${canInvoke ? invokeFormHtml(agent) : `
      <div class="muted-box mt-14" style="display:flex;gap:8px">
        ${icon('info', 15)}
        <span class="fs-12">${esc(rqI18n.t('发起协作需 agent.a2a.invoke 权限（当前账号未持有）；请联系平台管理员开通后，即可在此直接向该员工发起协作任务。'))}</span>
      </div>`}`,
  })
  if (canInvoke) bindInvokeForm(drawer, agent)
}

/** 发起协作表单（agent.a2a.invoke）：消息必填 + 密级 + 可选协作链 ID（G9）。 */
function invokeFormHtml(agent) {
  return `
    <div class="muted-box mt-14">
      <div class="micro-label mb-8">${icon('send', 13)} ${esc(rqI18n.t('发起协作'))}</div>
      <div class="form-item">
        <label class="form-label">${esc(rqI18n.t('协作消息'))}<span class="req">*</span></label>
        <textarea class="form-control" id="a2a-invoke-message" rows="3" placeholder="描述本次协作要完成的事项（将作为任务消息发送给对方员工）"></textarea>
      </div>
      <div class="form-item">
        <label class="form-label">${esc(rqI18n.t('数据密级'))}</label>
        <select class="select" id="a2a-invoke-dataclass">
          ${Object.entries(A2A_CLASS_LABEL).map(([value, label]) => `<option value="${esc(value)}">${esc(rqI18n.t(label))}</option>`).join('')}
        </select>
        <div class="form-hint">${esc(rqI18n.t('超过对方密级天花板的任务会被治理规则与审批流程拦截'))}</div>
      </div>
      <div class="form-item" style="margin-bottom:0">
        <label class="form-label">${esc(rqI18n.t('协作链 ID（可选）'))}</label>
        <input class="input" id="a2a-invoke-context" placeholder="留空自动生成；填写同一 ID 可归入同一协作会话">
      </div>
      <button class="btn btn-primary" id="a2a-invoke-submit" style="margin-top:12px">${icon('send', 14)}${esc(rqI18n.t('发起协作'))}</button>
    </div>`
}

/** 绑定发起协作提交：JSON-RPC message/send；信封内 error 展示 message，成功跳任务追踪并开抽屉。 */
function bindInvokeForm(drawer, agent) {
  const submit = drawer.el.querySelector('#a2a-invoke-submit')
  if (!submit) return
  submit.onclick = async (e) => {
    const btn = e.currentTarget
    const message = drawer.el.querySelector('#a2a-invoke-message')?.value.trim() ?? ''
    if (!message) return toast(rqI18n.t('请填写协作消息'), 'error')
    const dataClass = drawer.el.querySelector('#a2a-invoke-dataclass')?.value ?? 'public'
    const contextId = drawer.el.querySelector('#a2a-invoke-context')?.value.trim() ?? ''
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message, metadata: { dataClass } },
    }
    if (contextId) payload.params.metadata.contextId = contextId
    btn.classList.add('btn-loading')
    try {
      // 平台信封已被 api.js 解包为 data：{jsonrpc,id,result:{task}} 或 {jsonrpc,id,error:{code,message}}
      const resp = await api.post(`/api/agents/${encodeURIComponent(agent.slug)}/a2a`, payload)
      if (resp && typeof resp === 'object' && resp.error) {
        toast(resp.error.message || rqI18n.t('协作请求被拒绝'), 'error')
        return
      }
      const task = resp?.result?.task
      if (!task?.taskId) {
        toast(rqI18n.t('协作请求已提交，但未返回任务，请稍后在任务追踪中查看'), 'error')
        return
      }
      toast(rqI18n.t('协作任务已发起：{id}', { id: shortTaskId(task.taskId) }))
      drawer.close()
      pendingTaskFocus = task.taskId
      location.hash = '#/a2a?tab=tasks'
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

// ---------------------------------------------------------------------------
// 区块二：任务追踪（八态筛选 + 任务表 + 详情抽屉 + 人工验收 + 取消 + 轮询）
// ---------------------------------------------------------------------------

async function renderTasks(params) {
  const body = $('#a2a-body')
  const contextFilter = (params.get('context') ?? '').trim()
  const directory = await api.get('/api/a2a/directory').catch(() => ({ agents: [] }))
  const agents = directory.agents ?? []
  body.innerHTML = `
    <div class="filter-bar">
      <div class="grow" id="a2a-state-chips"></div>
      ${contextFilter ? `<span class="badge badge-info no-dot" style="cursor:pointer" id="a2a-context-clear" title="点击清除协作会话过滤">${esc(rqI18n.t('协作会话'))} · ${esc(shortTaskId(contextFilter))} ✕</span>` : ''}
      <select class="select" id="a2a-agent-filter" style="width:190px">
        <option value="">全部目标员工</option>
        ${agents.map((agent) => `<option value="${esc(agent.agentId)}">${esc(agent.name)}（${esc(agent.slug)}）</option>`).join('')}
      </select>
    </div>
    <div id="a2a-task-table"></div>`

  const state = { state: '', agentId: '', contextId: contextFilter }
  const refresh = async () => {
    const result = await api.get('/api/a2a/tasks' + api.qs({
      state: state.state || undefined,
      agentId: state.agentId || undefined,
      contextId: state.contextId || undefined,
      limit: 100,
    }))
    renderTaskTable(result.tasks ?? [])
  }

  function renderTaskTable(tasks) {
    const holder = $('#a2a-task-table')
    if (!holder) return
    holder.innerHTML = ''
    const table = renderTable({
      columns: [
        { title: '任务', width: 130, render: (task) => `<span class="mono fs-12" title="${esc(task.taskId)}">${esc(shortTaskId(task.taskId))}</span>` },
        { title: '目标员工', render: (task) => `<div class="col-strong">${esc(task.agentSlug)}</div><div class="col-sub mono">${esc(shortTaskId(task.contextId))}</div>` },
        { title: '状态', width: 108, render: (task) => stateBadge(task.state) },
        { title: '模式', width: 140, render: (task) => `<span class="fs-12">${esc(rqI18n.t(A2A_MODE_LABEL[task.mode] ?? task.mode))}</span>` },
        { title: '密级', width: 64, render: (task) => `<span class="fs-12">${esc(rqI18n.t(A2A_CLASS_LABEL[task.dataClass] ?? task.dataClass))}</span>` },
        { title: 'Token 消耗', width: 110, render: (task) => `<span class="mono fs-12 text-3" title="输入 / 输出">${fmtNum(task.inputTokens ?? 0)} / ${fmtNum(task.outputTokens ?? 0)}</span>` },
        { title: '发起方', width: 130, render: (task) => `<span class="mono fs-12 text-3">${esc(task.callerSubject)}</span>` },
        { title: '验收', width: 90, render: (task) => task.acceptance ? acceptanceBadge(task.acceptance.status) : '<span class="text-4 fs-12">—</span>' },
        { title: '创建', width: 96, render: (task) => `<span class="fs-12 text-3">${timeAgo(task.createdAt)}</span>` },
      ],
      rows: tasks,
      rowKey: (task) => task.taskId,
      onRowClick: (taskId) => openTaskDrawer(taskId, refresh),
      empty: '暂无协作任务（任务经 A2A 端点发起后在此追踪）',
    })
    holder.appendChild(table)
  }

  $('#a2a-state-chips').appendChild(chipRow(
    [{ value: '', label: '全部' }, ...Object.entries(A2A_STATE_META).map(([value, meta]) => ({ value, label: meta[1] }))],
    state.state,
    (value) => { state.state = value; void refresh() },
  ))
  $('#a2a-agent-filter').onchange = () => { state.agentId = $('#a2a-agent-filter').value; void refresh() }
  $('#a2a-context-clear')?.addEventListener('click', () => { location.hash = '#/a2a?tab=tasks' })
  await refresh()
  // 发起协作成功后的落点：打开刚创建的任务抽屉（G9）
  if (pendingTaskFocus) {
    const focus = pendingTaskFocus
    pendingTaskFocus = null
    void openTaskDrawer(focus, refresh)
  }
}

/**
 * 任务详情抽屉。抽屉打开且任务非终态时实时刷新（Q-15）：
 *   ① 首选任务 SSE（/v1/a2a/tasks/:id/events，快照 / 进度 / 终态帧），经 realtime.js 统一封装
 *     （SSE 优先、失败降级轮询——钉钉 webview 长连接不稳，铁律不破）；
 *   ② 无令牌（演示态）或 SSE 建立失败 → 降级为 2s 轮询 /api/a2a/tasks/:id。
 * 关闭抽屉、被其他抽屉顶掉或到达终态即停（SSE 连接必须 close，避免泄漏）。
 */
async function openTaskDrawer(taskId, onChanged) {
  let task
  try {
    const result = await api.get(`/api/a2a/tasks/${encodeURIComponent(taskId)}`)
    task = result.task
  } catch (error) {
    toast(error.message, 'error')
    return
  }
  let stopped = false
  let timer = 0
  let stream = null
  const drawer = openDrawer({
    titleHtml: `${esc(rqI18n.t('协作任务'))} <span class="mono">${esc(shortTaskId(task.taskId))}</span>`,
    sub: `${esc(task.agentSlug)} · ${esc(rqI18n.t(A2A_MODE_LABEL[task.mode] ?? task.mode))} · ${esc(rqI18n.t(A2A_CLASS_LABEL[task.dataClass] ?? task.dataClass))}${esc(rqI18n.t('密级'))}`,
    wide: true,
    body: `<div class="fs-12 text-4">…</div>`,
    foot: ' ',
    onClose: () => {
      stopped = true
      clearTimeout(timer)
      if (stream) { try { stream.close() } catch { /* 已关闭 */ } stream = null }
    },
  })

  /** 全量重绘抽屉主体与按钮区（轮询 / 操作后复用）。 */
  const render = () => {
    drawer.body.innerHTML = `
      <div class="flex mb-8" style="gap:8px;flex-wrap:wrap;align-items:center">
        ${stateBadge(task.state)}
        <span class="badge badge-muted no-dot">${esc(rqI18n.t(A2A_MODE_LABEL[task.mode] ?? task.mode))}</span>
        ${task.negotiation ? `<span class="badge badge-purple no-dot">${esc(rqI18n.t('协商 · {status}（第 {a}/{b} 轮）', { status: rqI18n.t(A2A_NEGOTIATION_LABEL[task.negotiation.status] ?? task.negotiation.status), a: task.negotiation.round, b: task.negotiation.maxRounds }))}</span>` : ''}
        ${task.acceptance ? acceptanceBadge(task.acceptance.status) : ''}
      </div>
      ${task.stateReason ? `<div class="muted-box mb-14" style="display:flex;gap:8px">${icon('info', 15)}<span><b>${esc(rqI18n.t('状态说明'))}</b> · ${esc(task.stateReason)}</span></div>` : ''}
      <div class="desc-grid mb-14">
        <div class="desc-item"><span class="k">任务 ID</span><span class="v mono">${esc(task.taskId)}</span></div>
        <div class="desc-item"><span class="k">协作会话</span><span class="v mono">${esc(task.contextId)}</span></div>
        <div class="desc-item"><span class="k">目标员工</span><span class="v">${esc(task.agentSlug)}</span></div>
        <div class="desc-item"><span class="k">发起方</span><span class="v mono">${esc(task.callerSubject)}${task.onBehalfUser ? ` <span class="fs-11 text-3" style="font-family:var(--font)">（${esc(rqI18n.t('代表用户'))} ${esc(task.onBehalfUser)}）</span>` : ''}</span></div>
        <div class="desc-item"><span class="k">自治级别</span><span class="v">${esc(rqI18n.t(A2A_AUTONOMY_LABEL[task.callerAutonomy] ?? task.callerAutonomy))} → ${esc(rqI18n.t(A2A_AUTONOMY_LABEL[task.targetAutonomy] ?? task.targetAutonomy))}</span></div>
        <div class="desc-item"><span class="k">模型 / 尝试</span><span class="v">${esc(task.model || '—')} · ${esc(rqI18n.t('{n} 次', { n: task.attempts ?? 0 }))}</span></div>
        <div class="desc-item"><span class="k">Token 消耗</span><span class="v mono">${fmtNum(task.inputTokens ?? 0)} ${esc(rqI18n.t('入'))} / ${fmtNum(task.outputTokens ?? 0)} ${esc(rqI18n.t('出'))}</span></div>
        ${task.approvalId ? `<div class="desc-item"><span class="k">关联审批工单</span><span class="v mono">${esc(task.approvalId)}</span></div>` : ''}
        <div class="desc-item"><span class="k">创建时间</span><span class="v">${timeAgo(task.createdAt)}</span></div>
        ${task.startedAt ? `<div class="desc-item"><span class="k">开始执行</span><span class="v">${timeAgo(task.startedAt)}</span></div>` : ''}
        ${task.finishedAt ? `<div class="desc-item"><span class="k">到达终态</span><span class="v">${timeAgo(task.finishedAt)}</span></div>` : ''}
      </div>
      <div class="micro-label mb-8">${esc(rqI18n.t('任务消息'))}</div>
      ${messageBlock(task)}
      ${negotiationSection(task)}
      ${artifactsSection(task)}
      <div class="micro-label mb-8">${esc(rqI18n.t('历史时间线'))}</div>
      ${(task.history ?? []).length ? `<div class="timeline mb-14">${[...task.history].reverse().map((entry) => historyItem(entry, task)).join('')}</div>` : emptyHint('暂无历史事件')}
      <div class="micro-label mb-8">${esc(rqI18n.t('交付验收'))}</div>
      ${acceptanceSection(task)}`

    // foot：验收动作（三重门 + 职责分离）与取消任务（非终态 ∧ 发起人或平台管理员）
    const canAccept = task.state === 'completed' && !task.acceptance && session.can('a2a.task.accept') && !isInitiator(task)
    const canCancel = !A2A_TERMINAL_STATES.has(task.state) && session.can('agent.a2a.invoke') && (isInitiator(task) || session.can('*'))
    const footEl = drawer.el.querySelector('.drawer-foot')
    if (!footEl) return
    footEl.innerHTML = [
      ...(canAccept ? Object.entries(A2A_ACCEPT_ACTIONS).map(([decision, meta]) =>
        `<button class="btn ${esc(meta.button)}" id="a2a-accept-${esc(decision)}">${icon(meta.icon, 14)}${esc(rqI18n.t(meta.label))}</button>`) : []),
      ...(canCancel ? [`<button class="btn btn-default" id="a2a-task-cancel">${icon('x', 14)}${esc(rqI18n.t('取消任务'))}</button>`] : []),
    ].join('')
    if (canAccept) {
      for (const [decision] of Object.entries(A2A_ACCEPT_ACTIONS)) {
        const btn = footEl.querySelector(`#a2a-accept-${decision}`)
        if (btn) btn.onclick = () => openAcceptanceModal(task, decision, drawer, onChanged)
      }
    }
    const cancelBtn = footEl.querySelector('#a2a-task-cancel')
    if (cancelBtn) cancelBtn.onclick = () => openCancelModal(task, reload, onChanged)
  }

  /** 重新拉取任务并重绘（取消成功 / 轮询共用）。 */
  const reload = async () => {
    try {
      const result = await api.get(`/api/a2a/tasks/${encodeURIComponent(taskId)}`)
      task = result.task
      if (!stopped && drawer.el.isConnected) render()
      return task
    } catch (error) {
      toast(error.message, 'error')
      return null
    }
  }

  render()
  // 实时刷新：非终态才订阅。SSE 与轮询互斥——SSE 可用时由帧驱动 reload，降级后由轮询兜底。
  if (!A2A_TERMINAL_STATES.has(task.state)) {
    // 演示态/无令牌：任务流端点自校验 ?token= 参数，浏览器原生流对象无法带 Bearer 头 → 直接走轮询。
    if (session.token) {
      const eventsUrl = `${BASE}/v1/a2a/tasks/${encodeURIComponent(taskId)}/events?token=${encodeURIComponent(session.token)}`
      stream = createEventStream({
        url: eventsUrl,
        pollPath: `${BASE}/api/a2a/tasks/${encodeURIComponent(taskId)}`,
        pollIntervalMs: 2000,
        headers: session.token ? { authorization: `Bearer ${session.token}` } : {},
        eventNames: ['task.snapshot', 'task.progress', 'task.terminal'],
        onMessage: (payload) => {
          if (stopped || !drawer.el.isConnected) return
          // SSE 具名帧（realtime.js 统一包装为 { event, ...data }）：
          //   task.snapshot = 服务端 taskView 本体（直接重绘，省一次往返）；
          //   task.progress / task.terminal 只作信号，状态机口径以服务端重取为准。
          if (payload?.event === 'task.snapshot' && payload.taskId) {
            const { event: _event, ...snapshot } = payload
            task = snapshot
            if (drawer.el.isConnected) render()
            if (A2A_TERMINAL_STATES.has(task.state)) stopRealtime()
            return
          }
          if (payload?.event === 'task.progress') {
            if (payload.phase === 'delta') return // 单步执行无增量帧
            void reload().then((next) => {
              if (next && A2A_TERMINAL_STATES.has(next.state)) stopRealtime()
            })
            return
          }
          if (payload?.event === 'task.terminal') {
            void reload().then(() => stopRealtime())
            return
          }
          // 轮询降级路径：响应体是平台信封 {ok,data:{task}}，直接消费快照（省一次往返）
          const polled = payload?.data?.task
          if (polled) {
            task = polled
            if (drawer.el.isConnected) render()
            if (A2A_TERMINAL_STATES.has(task.state)) stopRealtime()
          }
        },
        onDowngrade: () => {
          // 已降级为轮询：首轮由 realtime.js 立即发起，此处无需动作（仅保留可观测性）
        },
        onPollError: () => { /* 轮询失败下一轮重试；抽屉关闭即停 */ },
      })
    } else {
      timer = setTimeout(async () => {
        while (!stopped) {
          if (!drawer.el.isConnected) return
          const next = await reload()
          if (stopped || !drawer.el.isConnected) return
          if (!next || A2A_TERMINAL_STATES.has(next.state)) return
          await new Promise((resolve) => { timer = setTimeout(resolve, 2000) })
        }
      }, 2000)
    }
  }

  /** 关停实时通道（终态/抽屉关闭共用的幂等出口）。 */
  function stopRealtime() {
    stopped = true
    clearTimeout(timer)
    if (stream) { try { stream.close() } catch { /* 已关闭 */ } stream = null }
  }
}

/** 任务消息区：脱敏任务显示占位说明，不显示 undefined（后端 contentRedacted 契约）。 */
function messageBlock(task) {
  if (task.message != null && task.message !== '') {
    return `<div class="code-block mb-14" style="max-height:160px">${esc(task.message)}</div>`
  }
  if (task.contentRedacted) {
    return `<div class="muted-box mb-14" style="display:flex;gap:8px">${icon('lock', 15)}<span class="fs-12 text-3">${esc(rqI18n.t(A2A_REDACTED_NOTE))}</span></div>`
  }
  return `<div class="code-block mb-14" style="max-height:160px">${esc('（空）')}</div>`
}

/** 验收确认弹窗：decision 由抽屉按钮注入，理由必填（护栏要求），提交后刷新列表。 */
function openAcceptanceModal(task, decision, drawer, onChanged) {
  const meta = A2A_ACCEPT_ACTIONS[decision] ?? {}
  const modal = openModal({
    titleHtml: `${esc(rqI18n.t(meta.label ?? '交付验收'))} · <span class="mono">${esc(shortTaskId(task.taskId))}</span>`,
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">
        ${icon('info', 15)}<span class="fs-13">${esc(rqI18n.t(meta.hint ?? ''))}</span>
      </div>
      <div class="form-item" style="margin-bottom:0">
        <label class="form-label">${esc(rqI18n.t('验收理由'))}<span class="req">*</span></label>
        <textarea class="form-control" id="a2a-accept-reason" rows="3" placeholder="验收结论与依据（交付物核验情况、业务影响…），将写入审计日志"></textarea>
        <div class="form-hint">${esc(rqI18n.t('验收结论是任务归档口径：验收不轻信员工自报，由人做最终判断'))}</div>
      </div>`,
    foot: `<button class="btn btn-default" data-cancel>${esc(rqI18n.t('取消'))}</button><button class="btn ${esc(meta.button ?? 'btn-primary')}" data-ok>${esc(rqI18n.t(meta.action ?? '提交'))}</button>`,
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const reason = modal.body.querySelector('#a2a-accept-reason').value.trim()
    if (!reason) return toast(rqI18n.t('验收必须填写理由（护栏要求）'), 'error')
    btn.classList.add('btn-loading')
    try {
      await api.post(`/api/a2a/tasks/${encodeURIComponent(task.taskId)}/acceptance`, { decision, reason })
      toast(rqI18n.t('验收结论已提交，任务状态已更新'))
      modal.close()
      drawer.close()
      onChanged?.()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

/** 取消任务弹窗（G9）：非终态 ∧ 发起人本人或平台管理员；JSON-RPC tasks/cancel，理由必填。 */
function openCancelModal(task, reload, onChanged) {
  const modal = openModal({
    titleHtml: `${esc(rqI18n.t('取消任务'))} · <span class="mono">${esc(shortTaskId(task.taskId))}</span>`,
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">
        ${icon('info', 15)}<span class="fs-13">${esc(rqI18n.t('取消后任务立即停止执行并归档为「已取消」，已产生的计量照常入账；理由写入审计日志。'))}</span>
      </div>
      <div class="form-item" style="margin-bottom:0">
        <label class="form-label">${esc(rqI18n.t('取消理由'))}<span class="req">*</span></label>
        <textarea class="form-control" id="a2a-cancel-reason" rows="3" placeholder="说明取消原因（将写入审计日志）"></textarea>
      </div>`,
    foot: `<button class="btn btn-default" data-cancel>${esc(rqI18n.t('取消'))}</button><button class="btn btn-danger" data-ok>${esc(rqI18n.t('确认取消'))}</button>`,
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const reason = modal.body.querySelector('#a2a-cancel-reason').value.trim()
    if (!reason) return toast(rqI18n.t('请填写取消理由（审计要求）'), 'error')
    btn.classList.add('btn-loading')
    try {
      const resp = await api.post(`/api/agents/${encodeURIComponent(task.agentSlug)}/a2a`, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/cancel',
        params: { taskId: task.taskId, reason },
      })
      if (resp && typeof resp === 'object' && resp.error) {
        toast(resp.error.message || rqI18n.t('取消请求被拒绝'), 'error')
        return
      }
      toast(rqI18n.t('取消请求已提交，任务已归档为「已取消」'))
      modal.close()
      await reload()
      onChanged?.()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

// ---------------------------------------------------------------------------
// 区块三：履约视图（协作链成本 Top + 每员工统计 + 一致性巡检 + 立即巡检）
// ---------------------------------------------------------------------------

async function renderFulfillment() {
  const body = $('#a2a-body')
  const result = await api.get('/api/a2a/fulfillment')
  const fulfillment = result.fulfillment ?? []
  // 巡检报告缺席不阻塞履约主表（例行巡检按环境变量周期执行）
  const patrols = await api.get('/api/a2a/patrols?limit=5').then((data) => data.patrols ?? []).catch(() => [])
  // 协作链成本 Top（G1，usage.read）：无权限时不渲染卡片（不是空态）
  const collab = session.can('usage.read')
    ? await api.get('/api/usage/collaborations?days=30&limit=10').catch(() => null)
    : null
  body.innerHTML = `
    ${collab ? collabCostCardHtml(collab) : ''}
    <div id="a2a-fulfillment-table"></div>
    <div class="mt-20" id="a2a-patrol"></div>`
  const holder = $('#a2a-fulfillment-table')
  holder.innerHTML = ''
  holder.appendChild(renderTable({
    columns: [
      { title: '数字员工', render: (row) => `<div class="col-strong">${esc(row.agentName)}</div><div class="col-sub mono">${esc(row.agentSlug)}</div>` },
      { title: '接收', width: 70, render: (row) => `<span class="tnum">${fmtNum(row.received)}</span>` },
      { title: '完成', width: 70, render: (row) => `<span class="tnum" style="color:${row.completed ? 'var(--ok)' : 'inherit'}">${fmtNum(row.completed)}</span>` },
      { title: '失败', width: 70, render: (row) => `<span class="tnum" style="color:${row.failed ? 'var(--danger)' : 'inherit'}">${fmtNum(row.failed)}</span>` },
      { title: '中断', width: 70, render: (row) => `<span class="tnum" title="待补充输入 + 待授权审批">${fmtNum(row.interrupted)}</span>` },
      { title: '取消/驳回', width: 90, render: (row) => `<span class="tnum text-3">${fmtNum(row.canceled)} / ${fmtNum(row.rejected)}</span>` },
      { title: '完成率', width: 84, render: (row) => `<span class="tnum">${fmtPct(row.completionRate)}</span>` },
      {
        title: '验收',
        width: 118,
        render: (row) => `
          <span class="tnum" title="${esc(rqI18n.t('验收通过 {a} · 验收驳回 {b}', { a: fmtNum(row.acceptanceAccepted), b: fmtNum(row.acceptanceRejected) }))}">${fmtPct(row.acceptancePassRate)}</span>
          <div class="col-sub">${esc(rqI18n.t('{a} 过 / {b} 驳', { a: fmtNum(row.acceptanceAccepted), b: fmtNum(row.acceptanceRejected) }))}</div>`,
      },
      { title: '平均耗时', width: 96, render: (row) => `<span class="tnum fs-12">${fmtDuration(row.avgDurationMs)}</span>` },
      { title: 'P95 耗时', width: 96, render: (row) => `<span class="tnum fs-12">${fmtDuration(row.p95DurationMs)}</span>` },
      { title: 'Token 消耗', width: 116, render: (row) => `<span class="mono fs-12 text-3" title="输入 / 输出">${fmtNum(row.inputTokens ?? 0)} / ${fmtNum(row.outputTokens ?? 0)}</span>` },
    ],
    rows: fulfillment,
    rowKey: (row) => row.agentId,
    empty: '暂无协作履约数据（协作任务产生后自动聚合）',
  }))
  renderPatrol($('#a2a-patrol'), patrols)
  if (collab) bindCollabCostCard(collab)
  // 页头操作（G5 / C-13）：a2a.admin 可立即巡检
  const actions = $('#a2a-page-actions')
  if (actions && session.can('a2a.admin')) {
    actions.innerHTML = `<button class="btn btn-default" id="a2a-patrol-run">${icon('shieldCheck', 14)}${esc(rqI18n.t('立即巡检'))}</button>`
    actions.querySelector('#a2a-patrol-run').onclick = async (e) => {
      const btn = e.currentTarget
      btn.classList.add('btn-loading')
      try {
        const { report } = await api.post('/api/a2a/patrol/run', {})
        const drift = Number(report?.driftAgents ?? 0)
        toast(rqI18n.t('巡检完成：{n} 个员工，漂移 {d} 个', { n: Number(report?.checkedAgents ?? 0), d: drift }), drift > 0 ? 'error' : 'success')
        const latest = await api.get('/api/a2a/patrols?limit=5').then((data) => data.patrols ?? []).catch(() => [])
        renderPatrol($('#a2a-patrol'), latest)
      } catch (error) {
        toast(error.message, 'error')
      } finally {
        btn.classList.remove('btn-loading')
      }
    }
  }
}

/** 协作链成本 Top 卡（G1）：点击会话跳任务追踪并按 contextId 过滤。 */
function collabCostCardHtml(collab) {
  const rows = collab.top ?? []
  return `
    <div class="card mb-20" id="a2a-collab-cost">
      <div class="card-head">
        <span class="card-title">${icon('coins', 15)} ${esc(rqI18n.t('协作链成本 Top（近 30 天）'))}</span>
        <span class="card-sub">${esc(rqI18n.t('自 {from} 起 · 按内部成本参考排序 · 点击会话查看任务明细', { from: String(collab.from ?? '').slice(0, 10) }))}</span>
      </div>
      <div class="card-body" style="padding-top:10px" id="a2a-collab-cost-body"></div>
    </div>`
}

function bindCollabCostCard(collab) {
  const holder = $('#a2a-collab-cost-body')
  if (!holder) return
  const rows = collab.top ?? []
  if (!rows.length) {
    holder.innerHTML = emptyHint('暂无协作链计量数据（协作任务产生计量事件后自动聚合）')
    return
  }
  const yuan = (cents) => (Number(cents) || 0) / 100
  const table = renderTable({
    columns: [
      { title: '协作会话', render: (row) => `<span class="mono fs-12" title="${esc(row.contextId)}">${esc(shortTaskId(row.contextId))}</span>` },
      { title: '事件数', width: 90, render: (row) => `<span class="tnum">${fmtNum(row.events)}</span>` },
      { title: 'Token 消耗', width: 120, render: (row) => `<span class="mono fs-12 text-3">${fmtNum(row.tokens ?? 0)}</span>` },
      { title: '成本参考', width: 110, render: (row) => `<span class="tnum fs-12" title="${esc(rqI18n.t('计量 {a} · 计费 {b}（分）', { a: fmtNum(row.cost_cents ?? 0), b: fmtNum(row.charge_cents ?? 0) }))}">${fmtCost(yuan(row.cost_cents))}</span>` },
      { title: '最近活动', width: 110, render: (row) => `<span class="fs-12 text-3">${timeAgo(row.lastAt)}</span>` },
    ],
    rows,
    rowKey: (row) => row.contextId,
    onRowClick: (contextId) => { location.hash = `#/a2a?tab=tasks&context=${encodeURIComponent(contextId)}` },
    empty: '暂无协作链计量数据（协作任务产生计量事件后自动聚合）',
  })
  holder.innerHTML = ''
  holder.appendChild(table)
}

/** 最近巡检报告摘要：漂移员工数 > 0 高亮（声明 ≤ 授权一致性治理）。 */
function renderPatrol(holder, patrols) {
  if (!holder) return
  const latest = patrols[0]
  const hasDrift = Number(latest?.driftAgents ?? 0) > 0
  holder.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title">${icon('shieldAlert', 15)} ${esc(rqI18n.t('一致性巡检（声明 ≤ 授权 · 能力漂移治理）'))}</span>
        <span class="card-sub">${latest ? `${esc(latest.actor)} · ${timeAgo(latest.at)}` : esc(rqI18n.t('暂无报告'))}</span>
      </div>
      <div class="card-body" style="padding-top:10px">
        ${latest ? `
          <div class="flex mb-10" style="gap:18px;flex-wrap:wrap;align-items:center">
            <span class="fs-13">${esc(rqI18n.t('巡检员工 {n} 个', { n: fmtNum(latest.checkedAgents) }))}</span>
            <span class="fs-13" style="color:${hasDrift ? 'var(--warn)' : 'var(--ok)'}">${esc(rqI18n.t('漂移 {n} 个', { n: fmtNum(latest.driftAgents) }))}</span>
            ${hasDrift
              ? `<span class="badge badge-warn">${esc(rqI18n.t('存在声明/授权漂移，请按明细清理登记'))}</span>`
              : `<span class="badge badge-ok">${esc(rqI18n.t('全部一致'))}</span>`}
          </div>
          ${(latest.findings ?? []).map((group) => `
            <div class="muted-box mb-8" style="${hasDrift ? 'border-color:var(--warn-border)' : ''}">
              <div class="fs-13"><b>${esc(group.agentName)}</b><span class="mono fs-11 text-4" style="margin-left:8px">${esc(group.agentId)}</span></div>
              ${(group.findings ?? []).map((line) => `
                <div class="flex fs-12" style="padding:3px 0;gap:6px"><span style="color:var(--warn)">${icon('alert', 13)}</span><span>${esc(line)}</span></div>`).join('')}
            </div>`).join('')}
          ${patrols.length > 1 ? `<div class="fs-11 text-4 mt-8">${esc(rqI18n.t('已保留最近 {n} 份巡检报告，此处展示最新一份。', { n: patrols.length }))}</div>` : ''}
        ` : emptyHint('暂无巡检报告（例行巡检按平台巡检周期执行后在此汇总）')}
      </div>
    </div>`
}

// ---------------------------------------------------------------------------
// 区块四：审批规则（读随目录；增删需 a2a.admin）
// ---------------------------------------------------------------------------

async function renderRules() {
  const body = $('#a2a-body')
  const canAdmin = session.can('a2a.admin')
  body.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title">${icon('fileCheck', 15)} ${esc(rqI18n.t('审批规则'))}</span>
        <span class="card-sub">${esc(rqI18n.t('命中规则（关键词或密级阈值）的协作任务需人工审批放行，由审批中心闭环'))}</span>
      </div>
      <div class="card-body" style="padding-top:10px" id="a2a-rules-body"></div>
    </div>`
  const actions = $('#a2a-page-actions')
  if (actions && canAdmin) {
    actions.innerHTML = `<button class="btn btn-primary" id="a2a-rule-create">${icon('plus', 14)}${esc(rqI18n.t('新增规则'))}</button>`
    actions.querySelector('#a2a-rule-create').onclick = () =>
      openRuleModal(async () => renderTable_((await api.get('/api/a2a/rules')).rules ?? []))
  }

  let rules = []
  try {
    rules = (await api.get('/api/a2a/rules')).rules ?? []
  } catch (error) {
    const holder = $('#a2a-rules-body')
    if (holder) {
      holder.innerHTML = ''
      holder.appendChild(emptyState({ title: '审批规则加载失败', desc: error.message, icon: 'fileCheck' }))
    }
    return
  }
  renderTable_(rules)

  function renderTable_(list) {
    const holder = $('#a2a-rules-body')
    if (!holder) return
    holder.innerHTML = ''
    const table = renderTable({
      columns: [
        { title: '规则名称', render: (rule) => `<div class="col-strong">${esc(rule.name)}</div>` },
        { title: '关键词匹配', render: (rule) => rule.matchKeyword ? `<span class="mono fs-12">${esc(rule.matchKeyword)}</span>` : '<span class="text-4 fs-12">—</span>' },
        {
          title: '密级阈值',
          width: 120,
          render: (rule) => rule.matchDataClassAtLeast
            ? `<span class="fs-12">${esc(rqI18n.t(A2A_RULE_CLASS_LABEL[rule.matchDataClassAtLeast] ?? rule.matchDataClassAtLeast))}</span>`
            : '<span class="text-4 fs-12">—</span>',
        },
        { title: '状态', width: 84, render: (rule) => `<span class="badge ${rule.enabled ? 'badge-ok' : 'badge-muted'} no-dot">${esc(rqI18n.t(rule.enabled ? '启用' : '停用'))}</span>` },
        { title: '创建人', width: 140, render: (rule) => `<span class="mono fs-12 text-3">${esc(rule.createdBy ?? '—')}</span>` },
        { title: '创建', width: 96, render: (rule) => `<span class="fs-12 text-3">${timeAgo(rule.createdAt)}</span>` },
        ...(canAdmin ? [{
          title: '操作',
          width: 80,
          render: (rule) => `<button class="btn btn-danger-ghost btn-sm" data-del="${esc(rule.id)}" data-name="${esc(rule.name)}">${icon('trash', 13)}${esc(rqI18n.t('删除'))}</button>`,
        }] : []),
      ],
      rows: list,
      rowKey: (rule) => rule.id,
      empty: '暂无审批规则（命中规则的任务将进入人工审批）',
    })
    holder.appendChild(table)
    holder.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = () => deleteRule(btn.dataset.del, btn.dataset.name, async () => renderTable_((await api.get('/api/a2a/rules')).rules ?? []))
    })
  }
}

/** 密级阈值展示（规则命中口径：任务密级达到阈值即命中）。 */
const A2A_RULE_CLASS_LABEL = { internal: '内部及以上', secret: '秘密及以上' }

/** 新增审批规则弹窗（a2a.admin）：名称必填，关键词 / 密级阈值至少一个匹配条件。 */
function openRuleModal(onCreated) {
  const modal = openModal({
    title: rqI18n.t('新增审批规则'),
    body: `
      <div class="form-item">
        <label class="form-label">${esc(rqI18n.t('规则名称'))}<span class="req">*</span></label>
        <input class="input" id="a2a-rule-name" placeholder="如：涉密任务人工把关">
      </div>
      <div class="form-item">
        <label class="form-label">${esc(rqI18n.t('关键词匹配'))}</label>
        <input class="input" id="a2a-rule-keyword" placeholder="消息包含该关键词时命中（可选）">
      </div>
      <div class="form-item">
        <label class="form-label">${esc(rqI18n.t('密级阈值'))}</label>
        <select class="select" id="a2a-rule-class">
          <option value="">${esc(rqI18n.t('不限制'))}</option>
          ${Object.entries(A2A_RULE_CLASS_LABEL).map(([value, label]) => `<option value="${esc(value)}">${esc(rqI18n.t(label))}</option>`).join('')}
        </select>
        <div class="form-hint">${esc(rqI18n.t('任务密级达到阈值即命中（与关键词为「或」关系，至少配置一个）'))}</div>
      </div>
      <div class="form-item" style="margin-bottom:0">
        <label class="flex" style="gap:8px;align-items:center;cursor:pointer">
          <input type="checkbox" id="a2a-rule-enabled" checked>
          <span class="fs-13">${esc(rqI18n.t('创建后立即启用'))}</span>
        </label>
      </div>`,
    foot: `<button class="btn btn-default" data-cancel>${esc(rqI18n.t('取消'))}</button><button class="btn btn-primary" data-ok>${esc(rqI18n.t('创建'))}</button>`,
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const name = modal.body.querySelector('#a2a-rule-name').value.trim()
    const matchKeyword = modal.body.querySelector('#a2a-rule-keyword').value.trim()
    const matchDataClassAtLeast = modal.body.querySelector('#a2a-rule-class').value
    const enabled = modal.body.querySelector('#a2a-rule-enabled').checked
    if (!name) return toast(rqI18n.t('请填写规则名称'), 'error')
    if (!matchKeyword && !matchDataClassAtLeast) return toast(rqI18n.t('至少配置一个匹配条件（关键词或密级阈值）'), 'error')
    btn.classList.add('btn-loading')
    try {
      await api.post('/api/a2a/rules', {
        name,
        ...(matchKeyword ? { matchKeyword } : {}),
        ...(matchDataClassAtLeast ? { matchDataClassAtLeast } : {}),
        enabled,
      })
      toast(rqI18n.t('审批规则已创建'))
      modal.close()
      onCreated?.()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

/** 删除审批规则：ui.js confirmDialog（不使用 window.confirm）。 */
async function deleteRule(id, name, onDeleted) {
  const confirmed = await confirmDialog({
    title: rqI18n.t('删除审批规则'),
    message: esc(rqI18n.t('确定删除规则「{name}」？删除后立即生效，历史审批与审计记录保留。', { name })),
    danger: true,
    confirmText: rqI18n.t('确认删除'),
  })
  if (!confirmed) return
  try {
    await api.delete(`/api/a2a/rules/${encodeURIComponent(id)}`)
    toast(rqI18n.t('审批规则已删除'))
    onDeleted?.()
  } catch (error) {
    toast(error.message, 'error')
  }
}

// ---------------------------------------------------------------------------
// 区块五：UHP 执行（harness 注册表 + 执行记录；uhp.read 可见，uhp.admin 管写）
// ---------------------------------------------------------------------------

async function renderUhp() {
  const body = $('#a2a-body')
  let harnesses = []
  let responses = { total: 0, items: [] }
  let loadError = null
  try {
    ;[harnesses, responses] = await Promise.all([
      api.get('/api/uhp/harnesses'),
      api.get('/api/uhp/responses?limit=50'),
    ])
    harnesses = harnesses.harnesses ?? []
    responses = { total: responses.total ?? 0, items: responses.items ?? [] }
  } catch (error) {
    loadError = error
  }
  if (loadError) {
    body.innerHTML = ''
    body.appendChild(emptyState({
      title: 'UHP 数据加载失败',
      desc: loadError.message,
      icon: 'zap',
    }))
    return
  }
  const canAdmin = session.can('uhp.admin')
  body.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title">${icon('zap', 15)} ${esc(rqI18n.t('执行体注册表（harness）'))}</span>
        <span class="card-sub">${esc(rqI18n.t('统一执行面：模型 × 工具权限组 × 步数 / 时间预算 × 密级天花板'))}</span>
      </div>
      <div class="card-body" style="padding-top:10px" id="a2a-uhp-harnesses"></div>
    </div>
    <div class="card mt-20">
      <div class="card-head">
        <span class="card-title">${icon('scroll', 15)} ${esc(rqI18n.t('执行记录'))}</span>
        <span class="card-sub">${esc(rqI18n.t('最近 {n} 条 · 共 {total} 条', { n: responses.items.length, total: fmtNum(responses.total) }))}</span>
      </div>
      <div class="card-body" style="padding-top:10px" id="a2a-uhp-responses"></div>
    </div>`
  renderHarnessTable(harnesses)
  renderResponseTable(responses.items)

  // 页头操作：新增 harness（uhp.admin）
  const actions = $('#a2a-page-actions')
  if (actions && canAdmin) {
    actions.innerHTML = `<button class="btn btn-primary" id="a2a-harness-create">${icon('plus', 14)}${esc(rqI18n.t('新增 harness'))}</button>`
    actions.querySelector('#a2a-harness-create').onclick = async () => {
      const directory = await api.get('/api/a2a/directory').catch(() => ({ agents: [] }))
      openHarnessModal(directory.agents ?? [], refreshHarnesses)
    }
  }

  async function refreshHarnesses() {
    try {
      const data = await api.get('/api/uhp/harnesses')
      renderHarnessTable(data.harnesses ?? [])
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  function renderHarnessTable(list) {
    const holder = $('#a2a-uhp-harnesses')
    if (!holder) return
    holder.innerHTML = ''
    const table = renderTable({
      columns: [
        { title: '执行体 ID', render: (item) => `<span class="mono fs-12 col-strong">${esc(item.id)}</span>` },
        { title: '目标员工', render: (item) => `<div class="col-strong">${esc(item.agentName ?? item.agentId)}</div><div class="col-sub mono">${esc(item.agentId)}</div>` },
        { title: '模型', width: 130, render: (item) => `<span class="mono fs-12">${esc(item.model)}</span>` },
        { title: '渠道组', width: 100, render: (item) => item.channelGroup ? `<span class="mono fs-12">${esc(item.channelGroup)}</span>` : '<span class="text-4 fs-12">—</span>' },
        { title: '步数预算', width: 88, render: (item) => `<span class="tnum fs-12">${item.stepBudget != null ? fmtNum(item.stepBudget) : '—'}</span>` },
        { title: '时间预算', width: 96, render: (item) => `<span class="tnum fs-12">${item.timeBudgetMs != null ? esc(rqI18n.t('{n} ms', { n: fmtNum(item.timeBudgetMs) })) : '—'}</span>` },
        { title: '密级天花板', width: 96, render: (item) => `<span class="fs-12">${esc(rqI18n.t(A2A_CLASS_LABEL[item.dataClassCeiling] ?? item.dataClassCeiling ?? '—'))}</span>` },
        { title: '工具权限组', width: 96, render: (item) => `<span class="tnum fs-12">${(item.toolPermGroupIds ?? []).length}</span>` },
        { title: '状态', width: 84, render: (item) => `<span class="badge ${item.enabled ? 'badge-ok' : 'badge-muted'} no-dot">${esc(rqI18n.t(item.enabled ? '启用' : '停用'))}</span>` },
        ...(canAdmin ? [{
          title: '操作',
          width: 130,
          render: (item) => `
            <button class="btn btn-ghost btn-sm" data-toggle="${esc(item.id)}" data-enabled="${item.enabled ? '1' : '0'}">${icon(item.enabled ? 'x' : 'check', 13)}${esc(rqI18n.t(item.enabled ? '停用' : '启用'))}</button>
            <button class="btn btn-danger-ghost btn-sm" data-del="${esc(item.id)}">${icon('trash', 13)}${esc(rqI18n.t('删除'))}</button>`,
        }] : []),
      ],
      rows: list,
      rowKey: (item) => item.id,
      empty: '暂无 UHP 执行体（harness 将模型与工具权限组绑定为可执行单元）',
    })
    holder.appendChild(table)
    if (canAdmin) {
      holder.querySelectorAll('[data-toggle]').forEach((btn) => {
        btn.onclick = async () => {
          const enabled = btn.dataset.enabled !== '1'
          btn.classList.add('btn-loading')
          try {
            await api.patch(`/api/uhp/harnesses/${encodeURIComponent(btn.dataset.toggle)}`, { enabled })
            toast(rqI18n.t(enabled ? '执行体已启用' : '执行体已停用'))
            await refreshHarnesses()
          } catch (error) {
            toast(error.message, 'error')
          } finally {
            btn.classList.remove('btn-loading')
          }
        }
      })
      holder.querySelectorAll('[data-del]').forEach((btn) => {
        btn.onclick = async () => {
          const confirmed = await confirmDialog({
            title: rqI18n.t('删除 UHP 执行体'),
            message: esc(rqI18n.t('确定删除执行体「{id}」？删除后经该执行体的调用立即失败。', { id: btn.dataset.del })),
            danger: true,
            confirmText: rqI18n.t('确认删除'),
          })
          if (!confirmed) return
          try {
            await api.delete(`/api/uhp/harnesses/${encodeURIComponent(btn.dataset.del)}`)
            toast(rqI18n.t('执行体已删除'))
            await refreshHarnesses()
          } catch (error) {
            toast(error.message, 'error')
          }
        }
      })
    }
  }

  function renderResponseTable(items) {
    const holder = $('#a2a-uhp-responses')
    if (!holder) return
    holder.innerHTML = ''
    const table = renderTable({
      columns: [
        { title: '执行记录 ID', render: (item) => `<span class="mono fs-12" title="${esc(item.id)}">${esc(shortTaskId(item.id))}</span>` },
        { title: '状态', width: 96, render: (item) => uhpStatusBadge(item.status) },
        { title: '模型', width: 130, render: (item) => `<span class="mono fs-12">${esc(item.model)}</span>` },
        { title: '执行体', width: 130, render: (item) => `<span class="mono fs-12 text-3" title="${esc(item.harness_id ?? '')}">${esc(shortTaskId(item.harness_id ?? '—'))}</span>` },
        { title: 'Token 消耗', width: 120, render: (item) => `<span class="mono fs-12 text-3" title="输入 / 输出">${fmtNum(item.usage?.input_tokens ?? 0)} / ${fmtNum(item.usage?.output_tokens ?? 0)}</span>` },
        { title: '会话', width: 110, render: (item) => `<span class="mono fs-12 text-4" title="${esc(item.session_id ?? '')}">${esc(shortTaskId(item.session_id ?? '—'))}</span>` },
        { title: '任务', width: 110, render: (item) => item.task_id ? `<span class="mono fs-12 text-3" title="${esc(item.task_id)}">${esc(shortTaskId(item.task_id))}</span>` : '<span class="text-4 fs-12">—</span>' },
        { title: '创建时间', width: 96, render: (item) => `<span class="fs-12 text-3">${timeAgo(item.created_at)}</span>` },
      ],
      rows: items,
      rowKey: (item) => item.id,
      onRowClick: (id) => {
        const item = items.find((row) => row.id === id)
        if (item) openUhpResponseDrawer(item)
      },
      empty: '暂无 UHP 执行记录（经 /v1/uhp 发起的执行在此留痕）',
    })
    holder.appendChild(table)
  }
}

function uhpStatusBadge(status) {
  const [cls, label] = UHP_STATUS_META[status] ?? ['badge-muted', status]
  return `<span class="badge ${cls}">${esc(rqI18n.t(label ?? status))}</span>`
}

/** 新增 harness 弹窗（uhp.admin）：agentId 下拉来自协作目录，模型必填。 */
function openHarnessModal(agents, onCreated) {
  const agentOptions = agents.map((agent) => ({ value: agent.agentId, label: `${agent.name}（${agent.slug}）` }))
  const modal = openModal({
    title: rqI18n.t('新增 UHP 执行体（harness）'),
    body: `
      <div class="form-item">
        <label class="form-label">${esc(rqI18n.t('执行体 ID'))}</label>
        <input class="input" id="a2a-harness-id" placeholder="留空由平台自动生成；自定义 ID 需全局唯一">
      </div>
      <div class="form-item">
        <label class="form-label">${esc(rqI18n.t('目标员工'))}<span class="req">*</span></label>
        <select class="select" id="a2a-harness-agent">
          <option value="">${esc(rqI18n.t('请选择目标员工'))}</option>
          ${agentOptions.map((opt) => `<option value="${esc(opt.value)}">${esc(opt.label)}</option>`).join('')}
        </select>
        <div class="form-hint">${esc(rqI18n.t('harness 必须绑定真实 Agent 资产（协作目录在线员工）'))}</div>
      </div>
      <div class="form-item">
        <label class="form-label">${esc(rqI18n.t('模型'))}<span class="req">*</span></label>
        <input class="input" id="a2a-harness-model" placeholder="如 deepseek-chat（经模型网关路由）">
      </div>
      <div class="form-item">
        <label class="form-label">${esc(rqI18n.t('步数预算'))}</label>
        <input class="input" id="a2a-harness-steps" placeholder="单次执行最大工具调用步数（留空使用平台默认）">
      </div>
      <div class="form-item">
        <label class="form-label">${esc(rqI18n.t('时间预算（毫秒）'))}</label>
        <input class="input" id="a2a-harness-time" placeholder="单次执行最长耗时（留空使用平台默认）">
      </div>
      <div class="form-item">
        <label class="form-label">${esc(rqI18n.t('密级天花板'))}</label>
        <select class="select" id="a2a-harness-class">
          ${Object.entries(A2A_CLASS_LABEL).map(([value, label]) => `<option value="${esc(value)}">${esc(rqI18n.t(label))}</option>`).join('')}
        </select>
      </div>
      <div class="form-item" style="margin-bottom:0">
        <label class="flex" style="gap:8px;align-items:center;cursor:pointer">
          <input type="checkbox" id="a2a-harness-enabled" checked>
          <span class="fs-13">${esc(rqI18n.t('创建后立即启用'))}</span>
        </label>
      </div>`,
    foot: `<button class="btn btn-default" data-cancel>${esc(rqI18n.t('取消'))}</button><button class="btn btn-primary" data-ok>${esc(rqI18n.t('创建'))}</button>`,
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const id = modal.body.querySelector('#a2a-harness-id').value.trim()
    const agentId = modal.body.querySelector('#a2a-harness-agent').value
    const model = modal.body.querySelector('#a2a-harness-model').value.trim()
    const stepsRaw = modal.body.querySelector('#a2a-harness-steps').value.trim()
    const timeRaw = modal.body.querySelector('#a2a-harness-time').value.trim()
    const dataClassCeiling = modal.body.querySelector('#a2a-harness-class').value
    const enabled = modal.body.querySelector('#a2a-harness-enabled').checked
    if (!agentId) return toast(rqI18n.t('请选择目标员工'), 'error')
    if (!model) return toast(rqI18n.t('请填写模型'), 'error')
    btn.classList.add('btn-loading')
    try {
      await api.post('/api/uhp/harnesses', {
        ...(id ? { id } : {}),
        agentId,
        model,
        ...(stepsRaw !== '' && Number.isFinite(Number(stepsRaw)) ? { stepBudget: Number(stepsRaw) } : {}),
        ...(timeRaw !== '' && Number.isFinite(Number(timeRaw)) ? { timeBudgetMs: Number(timeRaw) } : {}),
        ...(dataClassCeiling ? { dataClassCeiling } : {}),
        enabled,
      })
      toast(rqI18n.t('执行体已创建'))
      modal.close()
      onCreated?.()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

/** UHP 执行记录抽屉：输出内容与 metadata（行点击进入，G7）。 */
function openUhpResponseDrawer(item) {
  openDrawer({
    titleHtml: `${esc(rqI18n.t('UHP 执行记录'))} <span class="mono">${esc(shortTaskId(item.id))}</span>`,
    sub: `${esc(item.model)} · ${timeAgo(item.created_at)}`,
    wide: true,
    body: `
      <div class="flex mb-8" style="gap:8px;flex-wrap:wrap;align-items:center">
        ${uhpStatusBadge(item.status)}
        <span class="badge badge-muted no-dot mono">${esc(item.harness_id ?? '—')}</span>
      </div>
      <div class="desc-grid mb-14">
        <div class="desc-item"><span class="k">执行记录 ID</span><span class="v mono">${esc(item.id)}</span></div>
        <div class="desc-item"><span class="k">模型</span><span class="v mono">${esc(item.model)}</span></div>
        <div class="desc-item"><span class="k">会话 ID</span><span class="v mono">${esc(item.session_id ?? '—')}</span></div>
        ${item.task_id ? `<div class="desc-item"><span class="k">关联任务</span><span class="v mono">${esc(item.task_id)}</span></div>` : ''}
        <div class="desc-item"><span class="k">Token 消耗</span><span class="v mono">${fmtNum(item.usage?.input_tokens ?? 0)} ${esc(rqI18n.t('入'))} / ${fmtNum(item.usage?.output_tokens ?? 0)} ${esc(rqI18n.t('出'))}</span></div>
        <div class="desc-item"><span class="k">创建时间</span><span class="v">${timeAgo(item.created_at)}</span></div>
      </div>
      ${item.error ? `<div class="muted-box mb-14" style="display:flex;gap:8px;border-color:var(--danger-border)">${icon('alert', 15)}<span class="fs-12">${esc(typeof item.error === 'string' ? item.error : safeJson(item.error))}</span></div>` : ''}
      <div class="micro-label mb-8">${esc(rqI18n.t('输出内容'))}</div>
      <div class="code-block mb-14" style="max-height:320px">${esc(item.output_text || '（空）')}</div>
      <div class="micro-label mb-8">${esc(rqI18n.t('元数据（metadata）'))}</div>
      <div class="code-block" style="max-height:220px">${esc(safeJson(item.metadata))}</div>`,
  })
}

// ---------------------------------------------------------------------------
// 局部渲染助手
// ---------------------------------------------------------------------------

function stateBadge(state) {
  const [cls, label] = A2A_STATE_META[state] ?? ['badge-muted', state]
  return `<span class="badge ${cls}">${esc(rqI18n.t(label ?? state))}</span>`
}

function autonomyBadge(autonomy) {
  return `<span class="badge badge-purple no-dot" title="自治级别（A0 只读应答 → A3 协商自治）">${esc(rqI18n.t(A2A_AUTONOMY_LABEL[autonomy] ?? autonomy))}</span>`
}

function acceptanceBadge(status) {
  const label = A2A_ACCEPTANCE_LABEL[status]
  return `<span class="badge ${status === 'accepted' ? 'badge-ok' : 'badge-danger'} no-dot" title="人工验收结论">${esc(rqI18n.t(label ?? status))}</span>`
}

/** 交付验收区（C-5/Q-16）：无验收权限与发起人本人（职责分离）均给出明确降级文案。 */
function acceptanceSection(task) {
  if (task.acceptance) {
    const label = A2A_ACCEPTANCE_LABEL[task.acceptance.status]
    return `
      <div class="muted-box" style="display:flex;gap:8px;align-items:flex-start">
        ${icon(A2A_ACCEPT_ACTIONS[task.acceptance.status]?.icon ?? 'info', 15)}
        <span><b>${esc(rqI18n.t(label ?? '已验收'))}</b> · ${esc(task.acceptance.by)} · ${timeAgo(task.acceptance.at)}
          <div class="fs-12 text-3" style="margin-top:4px">${esc(task.acceptance.reason)}</div>
        </span>
      </div>`
  }
  if (task.state === 'completed') {
    if (isInitiator(task)) {
      return `<div class="muted-box" style="display:flex;gap:8px">${icon('info', 15)}<span>${esc(rqI18n.t('职责分离：发起人不可验收自己发起的任务，请由其他持有 a2a.task.accept 权限的成员验收。'))}</span></div>`
    }
    if (!session.can('a2a.task.accept')) {
      return `<div class="muted-box" style="display:flex;gap:8px">${icon('info', 15)}<span>${esc(rqI18n.t('任务已完成，等待人工验收（你当前无 a2a.task.accept 权限，请联系协作管理员验收）：完成 ≠ 业务闭环，验收通过才归档。'))}</span></div>`
    }
    return `<div class="muted-box" style="display:flex;gap:8px">${icon('info', 15)}<span>${esc(rqI18n.t('任务已完成，等待人工验收：完成 ≠ 业务闭环，验收通过才归档。'))}</span></div>`
  }
  return emptyHint('任务到达「已完成」后开放人工验收')
}

function negotiationSection(task) {
  const negotiation = task.negotiation
  if (!negotiation) return ''
  const redacted = Boolean(task.contentRedacted)
  return `
    <div class="micro-label mb-8">${esc(rqI18n.t('协商轮次（上限 {n} 轮 · {status}）', { n: negotiation.maxRounds, status: rqI18n.t(A2A_NEGOTIATION_LABEL[negotiation.status] ?? negotiation.status) }))}</div>
    ${(negotiation.offers ?? []).map((offer) => `
      <div class="muted-box mb-8">
        <div class="flex fs-12" style="gap:8px;align-items:center">
          <span class="badge badge-info no-dot">${esc(rqI18n.t('第 {n} 轮', { n: offer.round }))}</span>
          <span class="text-3">${esc(rqI18n.t('{from}要约', { from: rqI18n.t(A2A_HISTORY_FROM[offer.from] ?? offer.from) }))}</span>
          <span class="text-4" style="margin-left:auto">${timeAgo(offer.at)}</span>
        </div>
        ${offer.note ? `<div class="fs-12" style="margin-top:6px">${esc(offer.note)}</div>` : ''}
        ${offer.proposal != null
          ? `<div class="code-block" style="margin-top:6px;max-height:140px">${esc(safeJson(offer.proposal))}</div>`
          : redacted
            ? `<div class="fs-12 text-3" style="margin-top:6px;display:flex;gap:6px;align-items:center">${icon('lock', 13)}${esc(rqI18n.t(A2A_REDACTED_NOTE))}</div>`
            : `<div class="code-block" style="margin-top:6px;max-height:140px">${esc(safeJson(offer.proposal))}</div>`}
      </div>`).join('') || emptyHint('协商引擎未产生要约（按协商矩阵直接定模式执行）')}`
}

function artifactsSection(task) {
  const list = task.artifacts ?? []
  if (!list.length) return ''
  const redacted = Boolean(task.contentRedacted)
  return `
    <div class="micro-label mb-8">${esc(rqI18n.t('交付物（{n}）', { n: list.length }))}</div>
    ${list.map((artifact) => `
      <div class="muted-box mb-8">
        <div class="flex fs-13" style="gap:8px;align-items:center;flex-wrap:wrap">
          ${icon('file', 14)}
          <b>${esc(artifact.name)}</b>
          <span class="mono fs-11 text-4">${esc(artifact.mimeType ?? '')}</span>
          <span class="text-4 fs-11" style="margin-left:auto">${fmtBytes(artifact.sizeBytes)}</span>
        </div>
        ${artifact.content
          ? `<div class="code-block" style="margin-top:6px;max-height:200px">${esc(artifact.content)}</div>`
          : redacted
            ? `<div class="fs-12 text-3" style="margin-top:6px;display:flex;gap:6px;align-items:center">${icon('lock', 13)}${esc(rqI18n.t(A2A_REDACTED_NOTE))}</div>`
            : ''}
      </div>`).join('')}`
}

function historyItem(entry, task) {
  const redacted = Boolean(task?.contentRedacted)
  const head = entry.type === 'status'
    ? `${stateBadge(entry.state)}<span class="fs-12 text-3">${esc(entry.note ?? '')}</span>`
    : `<span class="fs-13">${esc(rqI18n.t(A2A_HISTORY_FROM[entry.from] ?? entry.from))} · ${esc(rqI18n.t(A2A_HISTORY_TYPE[entry.type] ?? entry.type))}</span>`
  const body = entry.text
    ? `<div class="timeline-body fs-12">${esc(entry.text)}</div>`
    : entry.type !== 'status' && redacted
      ? `<div class="timeline-body fs-12 text-3" style="display:flex;gap:6px;align-items:center">${icon('lock', 12)}${esc(rqI18n.t(A2A_REDACTED_NOTE))}</div>`
      : ''
  return `
    <div class="timeline-item ${historyTone(entry)}">
      <div class="timeline-dot"></div>
      <div class="timeline-title flex" style="gap:8px;align-items:center;flex-wrap:wrap">
        <span class="badge badge-muted no-dot">${esc(rqI18n.t(A2A_HISTORY_TYPE[entry.type] ?? entry.type))}</span>
        ${head}
      </div>
      <div class="timeline-time">${esc(timeAgo(entry.at))}</div>
      ${body}
    </div>`
}

function historyTone(entry) {
  const tones = { completed: 'ok', failed: 'danger', rejected: 'danger' }
  if (entry.type !== 'status') return tones[entry.state] ?? 'current'
  return tones[entry.state] ?? 'current'
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** 任务/会话 ID 短码：剥协议前缀，超长截断（完整 ID 在详情抽屉展示）。 */
function shortTaskId(id) {
  const bare = String(id ?? '').replace(/^[a-z]+_/, '')
  return bare.length > 12 ? `${bare.slice(0, 12)}…` : bare
}

function safeJson(value) {
  if (value === undefined || value === null || value === '') return '（无）'
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function fmtDuration(ms) {
  const n = Number(ms ?? 0)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1000) return rqI18n.t('{n} 毫秒', { n: Math.round(n) })
  if (n < 60_000) return rqI18n.t('{n} 秒', { n: (n / 1000).toFixed(1) })
  if (n < 3600_000) return rqI18n.t('{m} 分 {s} 秒', { m: Math.floor(n / 60_000), s: Math.round((n % 60_000) / 1000) })
  return rqI18n.t('{n} 小时', { n: (n / 3600_000).toFixed(1) })
}

function fmtBytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`
  return `${n} B`
}

function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}
