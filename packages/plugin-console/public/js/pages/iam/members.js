/**
 * 组织成员 tab：组织架构树/账号列表/批量勾选拖拽调岗/新建组织账号/批量导入（R4 前端拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 pages/iam.js 的 renderIam 闭包拆出，逐字搬运（行为与迁出前一致）。
 */
import { api, session } from '../../api.js'
import { icon } from '../../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog, copyText,
  renderTable, statusBadge, collectForm, field, inputField, selectField, textareaField,
  searchableSelectField, mountSearchableSelects,
  attachDropdown, timeAgo, emptyState,
} from '../../ui.js'
import {
  providerName, nameStatusMismatch, strategyName, fieldName, syncStatCard,
  flattenTree, flattenTreePaths, findOrgNode, flattenOrgList, buildOrgPaths, debounce,
  showUserCredentials,
} from './helpers.js'
import rqI18n from '../../i18n.js'

export async function renderMembers(ctx) {
  let [treeData, usersData] = await Promise.all([
    api.get('/api/iam/orgs/tree'),
    api.get('/api/iam/users'),
  ])
  // 批量勾选 + 拖拽调岗共享状态：勾选集跨列表刷新保留；dragging 记录拖拽载荷
  // （dragover/drop 阶段安全策略读不到 dataTransfer.getData，须走闭包变量）。
  const selectedUserIds = new Set()
  let draggingUserIds = []
  $('#iam-actions').innerHTML = `
    ${session.can('iam.org.write') ? `<button class="btn btn-default" id="org-add">${icon('plus', 14)}新建组织</button>` : ''}
    ${session.can('iam.user.write') ? `<button class="btn btn-default" id="user-import">${icon('download', 14)}批量导入</button>` : ''}
    ${session.can('iam.user.write') ? `<button class="btn btn-primary" id="user-add">${icon('plus', 14)}创建账号</button>` : ''}`
  const userAddBtn = $('#user-add')
  if (userAddBtn) userAddBtn.onclick = () => openUserCreate(treeData, usersData)
  const orgAddBtn = $('#org-add')
  if (orgAddBtn) orgAddBtn.onclick = () => openOrgCreate(treeData)
  const userImportBtn = $('#user-import')
  if (userImportBtn) userImportBtn.onclick = () => void openUserImport()

  const body = $('#iam-body')
  body.innerHTML = `
    <div style="display:grid;grid-template-columns:280px 1fr;gap:14px;align-items:start">
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card" style="padding:10px 8px">
          <div class="flex" style="padding:4px 8px 8px;justify-content:space-between">
            <span class="fs-12 text-3" style="font-weight:600">组织架构</span>
            <span class="fs-11 text-4" id="org-user-total">${rqI18n.t('{n} 人', { n: usersData.total })}</span>
          </div>
          <div class="tree" id="org-tree"></div>
          <div class="fs-11 text-4" style="padding:8px 8px 2px;margin-top:6px;border-top:1px dashed var(--border);display:flex;gap:5px;align-items:center">${icon('gitBranch', 11)}<span>把右侧成员拖到部门上可直接调岗</span></div>
        </div>
        <div class="card" style="padding:12px 14px" id="iam-conn-card">
          <div class="micro-label" style="margin-bottom:8px">三方连接器</div>
          <div class="fs-12 text-4">加载中…</div>
        </div>
      </div>
      <div>
        <div class="filter-bar">
          <div class="search-input">${icon('search')}<input class="input" id="member-q" placeholder="搜索姓名 / 用户名 / 邮箱"></div>
          <select class="select" id="member-status" style="width:130px">
            <option value="">全部状态</option><option value="active">正常</option><option value="pending">待激活</option>
            <option value="frozen">已冻结</option><option value="deactivated">已注销</option>
          </select>
          <span class="fs-12 text-3" id="member-count"></span>
        </div>
        <div id="org-leader-bar"></div>
        <div id="member-batchbar"></div>
        <div id="member-table"></div>
      </div>
    </div>
    <div class="grid-cards g4 mt-14" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:14px">
      <div class="card" style="padding:14px">
        <div class="flex" style="gap:6px;align-items:center;font-size:13px;font-weight:500">${icon('shield', 14)} 权限点矩阵</div>
        <div class="fs-12 text-3 mt-4" style="line-height:1.7">角色 × 权限点统一注册，接口按权限点实时校验，越权调用即拒绝并留痕。</div>
      </div>
      <div class="card" style="padding:14px">
        <div class="flex" style="gap:6px;align-items:center;font-size:13px;font-weight:500">${icon('users', 14)} 动态用户组</div>
        <div class="fs-12 text-3 mt-4" style="line-height:1.7">用户组按组织链圈人，NAS 数据权限 C 叠加组跨域只读随组织变动自动重算。</div>
      </div>
      <div class="card" style="padding:14px">
        <div class="flex" style="gap:6px;align-items:center;font-size:13px;font-weight:500">${icon('fingerprint', 14)} 一人一号</div>
        <div class="fs-12 text-3 mt-4" style="line-height:1.7">同一三方身份仅可绑定一个平台账号（引擎级唯一约束），冲突进入对比式工单处理。</div>
      </div>
      <div class="card" style="padding:14px">
        <div class="flex" style="gap:6px;align-items:center;font-size:13px;font-weight:500">${icon('alert', 14)} 冻结联动</div>
        <div class="fs-12 text-3 mt-4" style="line-height:1.7">冻结账号即吊销其全部访问令牌（含 refresh 链），登录与调用入口立即失效。</div>
      </div>
    </div>
    <div class="card" id="agent-org-card" style="margin-top:14px"></div>`

  let selectedOrgId = null
  const treeEl = $('#org-tree')

  function renderTree() {
    treeEl.innerHTML = ''
    const allNode = treeNode({ id: '', name: '全部成员', count: usersData.total }, true)
    treeEl.appendChild(allNode)
    for (const node of treeData) treeEl.appendChild(treeNode(node))
  }
  function treeNode(node, isAll) {
    const el = h(`
      <div class="tree-node">
        <div class="tree-row ${selectedOrgId === node.id ? 'active' : ''}" data-org="${esc(node.id)}">
          <span class="tree-caret ${hasChildren(node) || isAll ? 'open' : ''}" style="${!hasChildren(node) && !isAll ? 'visibility:hidden' : ''}">${icon('chevronRight', 12)}</span>
          ${icon(isAll ? 'users' : 'building', 14)}
          <span class="ellipsis">${esc(node.name)}</span>
          <span class="tree-count">${countOf(node, isAll)}</span>
          ${node.id && !isAll ? `<span class="tree-actions" title="组织维护：新建子组织 / 重命名 / 调整上级 / 删除">${icon('more', 13)}</span>` : ''}
        </div>
        <div class="tree-children ${hasChildren(node) ? 'open' : ''}"></div>
      </div>`)
    const childrenEl = el.querySelector('.tree-children')
    for (const child of (node.children ?? [])) childrenEl.appendChild(treeNode(child))
    const row = el.querySelector('.tree-row')
    row.onclick = () => {
      selectedOrgId = node.id
      $$('.tree-row', treeEl).forEach((r) => r.classList.remove('active'))
      row.classList.add('active')
      void refreshMembers()
    }
    const actions = el.querySelector('.tree-actions')
    if (actions) actions.onclick = (e) => { e.stopPropagation(); openOrgMenu(e, node) }
    el.querySelector('.tree-caret').onclick = (e) => {
      e.stopPropagation()
      childrenEl.classList.toggle('open')
      el.querySelector('.tree-caret').classList.toggle('open')
    }
    if (node.id) {
      row.oncontextmenu = (e) => {
        e.preventDefault()
        openOrgMenu(e, node)
      }
      // 拖拽落点：成员表拖来的账号落到该组织（dragover 必须 preventDefault 才允许触发 drop）
      row.addEventListener('dragover', (e) => {
        if (!draggingUserIds.length) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        row.classList.add('drag-over')
      })
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'))
      row.addEventListener('drop', (e) => {
        e.preventDefault()
        row.classList.remove('drag-over')
        const ids = draggingUserIds.slice()
        draggingUserIds = []
        if (ids.length) void moveUsersToOrg(ids, node)
      })
    }
    return el
  }
  function hasChildren(node) { return (node.children ?? []).length > 0 }
  function countOf(node, isAll) {
    if (isAll) return usersData.total
    return usersData.users.filter((u) => u.orgId === node.id).length
  }
  function openOrgMenu(e, node) {
    const anchor = h(`<button class="btn btn-ghost btn-sm" style="position:fixed;left:${e.clientX}px;top:${e.clientY}px;opacity:0;pointer-events:none">${icon('more')}</button>`)
    document.body.appendChild(anchor)
    attachDropdown(anchor, (menu) => {
      menu.innerHTML = `
        <button class="dropdown-item" data-act="add-child">${icon('plus')}新建子组织</button>
        <button class="dropdown-item" data-act="leaders">${icon('users')}设置负责人</button>
        <button class="dropdown-item" data-act="rename">${icon('edit')}重命名</button>
        <button class="dropdown-item" data-act="move">${icon('gitBranch')}调整上级组织</button>
        <button class="dropdown-item danger" data-act="delete">${icon('trash')}删除组织</button>`
      menu.querySelector('[data-act="add-child"]').onclick = () => { anchor.remove(); openOrgCreate(treeData, node.id) }
      menu.querySelector('[data-act="leaders"]').onclick = () => { anchor.remove(); openOrgLeaders(node) }
      menu.querySelector('[data-act="rename"]').onclick = async () => {
        anchor.remove()
        const modal = openModal({
          title: '重命名组织',
          body: field('组织名称', inputField('name', { value: node.name }), { required: true }),
          foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
        })
        modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
        modal.el.querySelector('[data-ok]').onclick = async () => {
          const data = collectForm(modal.body)
          if (!data.name) return toast(rqI18n.t('名称不能为空'), 'error')
          await api.patch(`/api/iam/orgs/${node.id}`, { name: data.name })
          toast(rqI18n.t('已重命名')); modal.close(); location.hash = '#/iam'; ctx.rerender()
        }
      }
      menu.querySelector('[data-act="move"]').onclick = () => {
        anchor.remove()
        // 候选父级排除自身与全部子孙（体验层防环，服务端 moveOrg 环检测兜底）
        const excluded = new Set()
        const collectSubtree = (n) => { excluded.add(n.id); (n.children ?? []).forEach(collectSubtree) }
        collectSubtree(node)
        const candidates = flattenTreePaths(treeData).filter((o) => !excluded.has(o.value))
        const modal = openModal({
          title: esc(rqI18n.t('调整上级组织（{name}）', { name: node.name })),
          body: field('上级组织', searchableSelectField('parentId', candidates, { value: node.parentId ?? '', emptyLabel: '（作为顶级组织）', placeholder: '点击选择上级组织' })),
          foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
        })
        mountSearchableSelects(modal.body)
        modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
        modal.el.querySelector('[data-ok]').onclick = async () => {
          const data = collectForm(modal.body)
          try {
            await api.patch(`/api/iam/orgs/${node.id}`, { parentId: data.parentId || null })
            toast(rqI18n.t('已调整上级组织')); modal.close(); location.hash = '#/iam'; ctx.rerender()
          } catch (error) { toast(error.message, 'error') }
        }
      }
      menu.querySelector('[data-act="delete"]').onclick = async () => {
        anchor.remove()
        // 影响范围预判：子树组织数（不含自身）与直属账号数（usersData 为全量账号）
        let subOrgCount = 0
        const countSub = (n) => { for (const c of (n.children ?? [])) { subOrgCount++; countSub(c) } }
        countSub(node)
        const directUsers = usersData.users.filter((u) => u.orgId === node.id).length
        const cascade = subOrgCount > 0 || directUsers > 0
        const rangeDesc = cascade
          ? rqI18n.t('其下还有 <b>{orgs}</b> 个子组织、<b>{users}</b> 个直属账号。将<b>一键删除整棵子树</b>，直属账号自动上移到上级组织{suffix}。', { orgs: subOrgCount, users: directUsers, suffix: node.parentId ? '' : rqI18n.t('（首个存活组织）') })
          : rqI18n.t('该组织为空（无子组织、无直属账号）。')
        const result = await confirmDialog({
          title: '删除组织',
          message: rqI18n.t('确定删除「{name}」？{desc}', { name: esc(node.name), desc: rangeDesc }),
          danger: true,
          confirmText: cascade ? '一键删除整棵子树' : '确认删除',
        })
        if (!result) return
        try {
          const res = await api.delete(`/api/iam/orgs/${node.id}`, { cascade })
          toast(cascade && res.removedOrgs > 1 ? rqI18n.t('已删除 {orgs} 个组织，{users} 个账号上移', { orgs: res.removedOrgs, users: res.movedUsers }) : rqI18n.t('组织已删除'))
          location.hash = '#/iam'; ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    })
    anchor.click()
    // 菜单挂在 body 下且默认 absolute（top:100%）会落到文档末尾视口外：
    // 打开后改写为 fixed 定位到触发点旁，并按实际尺寸做屏幕边界收敛
    const menuEl = document.body.querySelector(':scope > .dropdown-menu')
    if (menuEl) {
      const width = menuEl.offsetWidth || 200
      const height = menuEl.offsetHeight || 150
      menuEl.style.position = 'fixed'
      menuEl.style.right = 'auto'
      menuEl.style.left = `${Math.max(8, Math.min(e.clientX, window.innerWidth - width - 8))}px`
      menuEl.style.top = `${Math.max(8, Math.min(e.clientY, window.innerHeight - height - 8))}px`
    }
  }

  async function refreshMembers() {
    const q = $('#member-q').value.trim()
    const status = $('#member-status').value
    const search = api.qs({ orgId: selectedOrgId || undefined, q: q || undefined, status: status || undefined })
    const data = await api.get('/api/iam/users' + search)
    $('#member-count').textContent = rqI18n.t('共 {n} 人', { n: data.total })
    renderLeaderBar()
    // MFA 列仅在数据源真实提供该字段时出现（设计 §5.8「MFA 若有」——无数据不造假列）
    const mfaKey = ['mfaEnabled', 'mfa'].find((key) => data.users.some((u) => u && u[key] !== undefined))
    const columns = [
      {
        title: '<input type="checkbox" class="member-checkall" title="全选本页成员">',
        width: '36px', cls: 'col-check',
        render: (u) => `<input type="checkbox" class="member-check" data-id="${esc(u.id)}"${selectedUserIds.has(u.id) ? ' checked' : ''}>`,
      },
      {
        title: '成员', width: '20%',
        render: (u) => `
          <div class="flex" style="gap:10px">
            <div class="avatar sm">${esc(u.displayName.slice(0, 1))}</div>
            <div>
              <div class="col-strong">${esc(u.displayName)}${nameStatusMismatch(u)}</div>
            </div>
          </div>`,
      },
      { title: '账号', width: 130, render: (u) => `<span class="mono fs-12 text-3">@${esc(u.username)}</span>` },
      { title: '角色', render: (u) => (u.roles?.length ? u.roles.map((r) => `<span class="badge badge-brand no-dot" style="margin-right:4px">${esc(r.name)}</span>`).join('') : '<span class="text-4">未分配</span>') },
      { title: '组织 / 职位', render: (u) => `<div>${esc(u.orgName || '—')}</div><div class="col-sub">${esc(u.title || '—')}</div>` },
      { title: '三方绑定', render: (u) => u.bindings?.length ? u.bindings.map((b) => `<span class="badge badge-purple no-dot">${esc(providerName(b.provider))}</span>`).join(' ') : '<span class="text-4">—</span>' },
      { title: '状态', width: 90, render: (u) => statusBadge(u.status) },
      { title: '最近登录', width: 130, render: (u) => `<span class="fs-12 text-3">${timeAgo(u.lastLoginAt)}</span>` },
    ]
    if (mfaKey) {
      columns.push({
        title: 'MFA', width: 90,
        render: (u) => u[mfaKey]
          ? `<span class="fs-12" style="color:var(--ok)">${icon('shieldCheck', 12)} 已开启</span>`
          : '<span class="fs-12" style="color:var(--warn)">未开启</span>',
      })
    }
    const table = renderTable({
      columns,
      rows: data.users,
      onRowClick: (id) => openUserDetail(id),
    })
    const holder = $('#member-table')
    holder.innerHTML = ''
    holder.appendChild(table)
    wireMemberTable(table)
    updateBatchBar()
  }

  /** 成员表接线：勾选（单选/全选）入集、行可拖拽（勾选集成员被拖动时整批携带）。 */
  function wireMemberTable(table) {
    table.querySelectorAll('input.member-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) selectedUserIds.add(cb.dataset.id)
        else selectedUserIds.delete(cb.dataset.id)
        updateBatchBar()
      })
    })
    const checkAll = table.querySelector('input.member-checkall')
    if (checkAll) checkAll.addEventListener('change', () => {
      table.querySelectorAll('input.member-check').forEach((cb) => {
        cb.checked = checkAll.checked
        if (checkAll.checked) selectedUserIds.add(cb.dataset.id)
        else selectedUserIds.delete(cb.dataset.id)
      })
      updateBatchBar()
    })
    table.querySelectorAll('tbody tr').forEach((tr) => {
      tr.draggable = true
      tr.addEventListener('dragstart', (e) => {
        draggingUserIds = selectedUserIds.has(tr.dataset.key) ? [...selectedUserIds] : [tr.dataset.key]
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', JSON.stringify(draggingUserIds)) } catch { /* 兜底走闭包变量 */ }
        tr.classList.add('row-dragging')
      })
      tr.addEventListener('dragend', () => {
        tr.classList.remove('row-dragging')
        draggingUserIds = []
      })
    })
  }

  /** 批量操作条：勾选数 > 0 时出现，提供批量改属性入口（调岗 / 职位 / 角色）。 */
  function updateBatchBar() {
    const bar = $('#member-batchbar')
    if (!bar) return
    if (!selectedUserIds.size) { bar.innerHTML = ''; return }
    bar.innerHTML = `
      <div class="flex muted-box" style="margin-bottom:10px;gap:8px;flex-wrap:wrap;align-items:center">
        ${icon('check', 14)}
        <span class="fs-12" style="font-weight:600">${esc(rqI18n.t('已选 {n} 人', { n: selectedUserIds.size }))}</span>
        <span class="fs-11 text-4">勾选后拖到左侧组织可批量调岗</span>
        <span style="flex:1"></span>
        <button class="btn btn-default btn-sm" data-batch="org">${icon('building', 12)}调整组织</button>
        <button class="btn btn-default btn-sm" data-batch="title">${icon('edit', 12)}设置职位</button>
        <button class="btn btn-default btn-sm" data-batch="roles">${icon('shield', 12)}分配角色</button>
        <button class="btn btn-ghost btn-sm" data-batch="clear">清空选择</button>
      </div>`
    bar.querySelector('[data-batch="org"]').onclick = () => openBatchOrgModal()
    bar.querySelector('[data-batch="title"]').onclick = () => openBatchTitleModal()
    bar.querySelector('[data-batch="roles"]').onclick = () => void openBatchRolesModal()
    bar.querySelector('[data-batch="clear"]').onclick = () => {
      selectedUserIds.clear()
      $$('#member-table input.member-check').forEach((cb) => { cb.checked = false })
      const checkAllEl = $('#member-table input.member-checkall')
      if (checkAllEl) checkAllEl.checked = false
      updateBatchBar()
    }
  }

  /**
   * 批量修改通用执行器：逐条 PATCH /api/iam/users/:id（服务端逐个校验并留痕），
   * 逐条容错、汇总结果——与同步冲突批量处理同口径，不新增后端接口。
   */
  async function applyBatchUpdates(label, buildPatch) {
    const ids = [...selectedUserIds]
    let ok = 0
    const failed = []
    for (const id of ids) {
      const user = usersData.users.find((u) => u.id === id)
      try {
        await api.patch(`/api/iam/users/${id}`, buildPatch(user))
        ok++
      } catch (error) { failed.push(`${user?.displayName ?? id}：${error.message}`) }
    }
    if (failed.length) toast(rqI18n.t('{label}：成功 {ok} 人，失败 {f} 人（{msg}）', { label, ok, f: failed.length, msg: failed[0] }), 'error')
    else toast(rqI18n.t('{label}完成：共 {n} 人', { label, n: ok }))
    selectedUserIds.clear()
    await reloadBaseData()
  }

  /** 批量调整组织：目标组织按「法人 / 部门」全路径搜索选择（与创建/编辑账号同组件）。 */
  function openBatchOrgModal() {
    const modal = openModal({
      title: rqI18n.t('批量调整组织（已选 {n} 人）', { n: selectedUserIds.size }),
      body: `
        <div class="form-hint" style="margin-bottom:10px">所选成员将统一移动到目标组织下，立即生效并写入变更留痕。</div>
        ${field('目标组织', searchableSelectField('orgId', flattenTreePaths(treeData), { placeholder: '点击选择：输入部门名搜索，显示「法人 / 部门」全路径' }), { required: true, full: true, hint: '同名部门跨法人重复，请认准完整路径再选' })}`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>确认调整</button>',
    })
    mountSearchableSelects(modal.body)
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const data = collectForm(modal.body)
      if (!data.orgId) return toast(rqI18n.t('请选择目标组织'), 'error')
      const orgName = flattenTreePaths(treeData).find((opt) => opt.value === data.orgId)?.label ?? data.orgId
      modal.close()
      await applyBatchUpdates(rqI18n.t('批量调岗到「{name}」', { name: orgName }), () => ({ orgId: data.orgId }))
    }
  }

  /** 批量设置职位：留空提交即批量清空职位。 */
  function openBatchTitleModal() {
    const modal = openModal({
      title: rqI18n.t('批量设置职位（已选 {n} 人）', { n: selectedUserIds.size }),
      body: field('职位', inputField('title', { placeholder: '如：算法工程师；留空则清空这些成员的职位' }), { full: true }),
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>确认设置</button>',
    })
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const title = (collectForm(modal.body).title ?? '').trim()
      modal.close()
      await applyBatchUpdates(title ? rqI18n.t('批量设置职位「{title}」', { title }) : rqI18n.t('批量清空职位'), () => ({ title }))
    }
  }

  /** 批量分配角色：以勾选角色替换所选成员的角色清单（服务端 assignRoles 校验并广播权限变更）。 */
  async function openBatchRolesModal() {
    let rolesData
    try { rolesData = await api.get('/api/iam/roles') } catch (error) { return toast(error.message, 'error') }
    const modal = openModal({
      title: rqI18n.t('批量分配角色（已选 {n} 人）', { n: selectedUserIds.size }),
      body: `
        <div class="form-hint" style="margin-bottom:10px">将以勾选的角色<b>替换</b>所选成员的角色清单；不勾选任何角色 = 批量清空角色。权限点实时生效。</div>
        ${rolesData.roles.map((role) => `
          <label class="flex" style="padding:10px 4px;border-bottom:1px solid var(--border);cursor:pointer">
            <input type="checkbox" name="batch-role" value="${esc(role.id)}" style="accent-color:var(--brand-500)">
            <div class="grow">
              <div class="fs-13" style="font-weight:500">${esc(role.name)} ${role.builtin ? '<span class="badge badge-muted no-dot">内置</span>' : ''}</div>
              <div class="fs-12 text-3">${esc(role.description)}</div>
            </div>
          </label>`).join('')}`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>确认分配</button>',
    })
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const roleIds = [...modal.body.querySelectorAll('input[name=batch-role]:checked')].map((el) => el.value)
      modal.close()
      await applyBatchUpdates(rqI18n.t('批量分配角色'), () => ({ roleIds }))
    }
  }

  /** 拖拽落点处理：把拖来的成员逐个调岗到目标组织，随后重拉组织树与成员表保持计数一致。 */
  async function moveUsersToOrg(userIds, orgNode) {
    const users = usersData.users.filter((u) => userIds.includes(u.id))
    const targets = users.filter((u) => u.orgId !== orgNode.id)
    if (!targets.length) { toast(rqI18n.t('所选成员已在该组织下，无需调岗')); return }
    let ok = 0
    const failed = []
    for (const user of targets) {
      try {
        await api.patch(`/api/iam/users/${user.id}`, { orgId: orgNode.id })
        ok++
      } catch (error) { failed.push(`${user.displayName}：${error.message}`) }
    }
    if (failed.length) toast(rqI18n.t('调岗到「{name}」：成功 {ok} 人，失败 {f} 人（{msg}）', { name: orgNode.name, ok, f: failed.length, msg: failed[0] }), 'error')
    else toast(rqI18n.t('已将 {n} 名成员移动到「{name}」', { n: ok, name: orgNode.name }))
    selectedUserIds.clear()
    await reloadBaseData()
  }

  /** 重拉组织树与全量账号并重渲染：保证树计数 / 人数 / 表格与服务端一致（拖拽与批量修改后调用）。 */
  async function reloadBaseData() {
    ;[treeData, usersData] = await Promise.all([
      api.get('/api/iam/orgs/tree'),
      api.get('/api/iam/users'),
    ])
    const totalEl = $('#org-user-total')
    if (totalEl) totalEl.textContent = rqI18n.t('{n} 人', { n: usersData.total })
    renderTree()
    await refreshMembers()
  }
  $('#member-q').oninput = debounce(() => void refreshMembers(), 250)
  $('#member-status').onchange = () => void refreshMembers()

  // 负责人栏：选中组织时展示当前负责人与口径（手动绑定 / 跟随同步）——
  // 负责人是 NAS 数据权限 P/D/T 角色推导依据，leaderVacant 告警后的处置入口
  function renderLeaderBar() {
    const barEl = $('#org-leader-bar')
    if (!barEl) return
    const orgNode = selectedOrgId ? findOrgNode(treeData, selectedOrgId) : null
    if (!orgNode) { barEl.innerHTML = ''; return }
    const leaderIds = orgNode.leaderUserIds ?? []
    const leaders = leaderIds.map((id) => usersData.users.find((u) => u.id === id)).filter(Boolean)
    const manual = orgNode.leaderSource === 'manual'
    barEl.innerHTML = `
      <div class="flex muted-box" style="margin-bottom:10px;gap:8px;flex-wrap:wrap;align-items:center">
        ${icon('users', 14)}
        <span class="fs-12 text-3" style="font-weight:600">负责人</span>
        ${leaders.length
          ? leaders.map((u) => `<span class="badge badge-brand no-dot">${esc(u.displayName)}</span>`).join('')
            + `<span class="badge ${manual ? 'badge-purple' : 'badge-muted'} no-dot">${manual ? '手动绑定 · 同步不覆盖' : '跟随钉钉同步'}</span>`
          : `<span class="fs-12 text-4">未设置——该部门在 NAS 数据权限中 delete/share 无人可执行，并触发负责人悬空告警</span>`}
        <button class="btn btn-ghost btn-sm" id="org-lead-set" style="margin-left:auto">${icon('edit', 12)}设置负责人</button>
      </div>`
    barEl.querySelector('#org-lead-set').onclick = () => openOrgLeaders(orgNode)
  }

  /** 负责人维护弹窗：复选多选（co-leader）+ 搜索；保存非空 = 手动绑定锁定，清空 = 恢复跟随同步。 */
  function openOrgLeaders(node) {
    const leaderIds = node.leaderUserIds ?? []
    const manual = node.leaderSource === 'manual'
    const modal = openModal({
      title: esc(rqI18n.t('设置负责人（{name}）', { name: node.name })),
      body: `
        <div class="muted-box mb-14" style="display:flex;gap:8px">
          ${icon('info', 15)}
          <span class="fs-12">负责人是 NAS 数据权限 P/D/T 角色的推导依据（可多选，co-leader）。${manual
            ? '当前为<b>手动绑定</b>：连接器同步不会覆盖；清空保存即恢复跟随钉钉同步。'
            : '当前跟随钉钉同步：保存非空后转为<b>手动绑定</b>并被同步锁定——钉钉侧没配负责人的部门用这里补录。'}</span>
        </div>
        <div class="search-input mb-8">${icon('search')}<input class="input" id="org-lead-q" placeholder="搜索姓名 / 用户名 / 部门"></div>
        <div id="org-lead-list" style="max-height:320px;overflow:auto"></div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" id="org-lead-save">保存</button>',
    })
    const listEl = modal.body.querySelector('#org-lead-list')
    const renderList = (kw) => {
      const key = String(kw ?? '').trim().toLowerCase()
      const candidates = usersData.users
        .filter((u) => u.status === 'active' || leaderIds.includes(u.id))
        .filter((u) => !key || `${u.displayName} ${u.username} ${u.orgName ?? ''}`.toLowerCase().includes(key))
        .slice(0, 50)
      listEl.innerHTML = candidates.length ? candidates.map((u) => `
        <label class="flex" style="padding:9px 4px;border-bottom:1px solid var(--border);cursor:pointer">
          <input type="checkbox" name="leader" value="${esc(u.id)}" ${leaderIds.includes(u.id) ? 'checked' : ''} style="accent-color:var(--brand-500)">
          <div class="avatar sm">${esc(u.displayName.slice(0, 1))}</div>
          <div class="grow">
            <div class="fs-13" style="font-weight:500">${esc(u.displayName)} <span class="fs-11 text-4">@${esc(u.username)}</span></div>
            <div class="fs-12 text-3">${esc(u.orgName ?? '—')} · ${esc(u.title || '未设置职位')}</div>
          </div>
        </label>`).join('') : '<div class="muted-box">没有匹配的账号</div>'
    }
    renderList('')
    modal.body.querySelector('#org-lead-q').oninput = debounce((e) => renderList(e.target.value), 200)
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('#org-lead-save').onclick = async () => {
      const picked = [...modal.body.querySelectorAll('input[name=leader]:checked')].map((el) => el.value)
      try {
        await api.patch(`/api/iam/orgs/${node.id}`, { leaderUserIds: picked })
        toast(picked.length ? rqI18n.t('负责人已保存（手动绑定，连接器同步不覆盖）') : rqI18n.t('已清空负责人（恢复跟随钉钉同步）'), 'success')
        modal.close(); location.hash = '#/iam'; ctx.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  }

  renderTree()
  await refreshMembers()
  // R7 人 + Agent 双层视图：组织树（人）之下的 Agent 名册卡；Agent 列表不可用时整卡降级隐藏
  void mountAgentOrgView(treeData)
  // 三方连接器摘要卡（§5.8）：connectors tab 数据摘要——模式 / 频率 / 最近同步 / 冲突数；无权限或无配置时降级
  void mountConnectorSummary()

  function openUserCreate(tree, users) {
    const modal = openModal({
      title: '创建账号', wide: true,
      body: `
        <div class="form-grid">
          ${field('姓名', inputField('displayName'), { required: true })}
          ${field('用户名', inputField('username', { placeholder: '字母数字，如 zhangsan' }), { required: true })}
          ${field('所属组织', searchableSelectField('orgId', flattenTreePaths(tree), { placeholder: '点击选择：输入部门名搜索，显示「法人 / 部门」全路径' }), { required: true, full: true, hint: '同名部门跨法人重复，请认准完整路径再选' })}
          ${field('职位', inputField('title'))}
          ${field('邮箱', inputField('email', { placeholder: '选填，默认 username@yuanbingke.com' }), { full: true })}
        </div>
        <div class="form-hint">创建后将生成随机初始口令（仅展示一次），账号状态为「正常」。</div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>创建</button>',
    })
    mountSearchableSelects(modal.body)
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const data = collectForm(modal.body)
      if (!data.orgId) return toast(rqI18n.t('请选择所属组织（支持搜索）'), 'error')
      try {
        const result = await api.post('/api/iam/users', data)
        modal.close()
        if (result.initialPassword) {
          showUserCredentials({
            userId: result.id,
            username: result.username,
            displayName: result.displayName,
            password: result.initialPassword,
            onDone: () => ctx.rerender(),
          })
        } else {
          toast(rqI18n.t('账号已创建')); ctx.rerender()
        }
      } catch (error) { toast(error.message, 'error') }
    }
  }

  function openOrgCreate(tree, parentId) {
    const modal = openModal({
      title: '新建组织',
      body: `
        ${field('上级组织', searchableSelectField('parentId', flattenTreePaths(tree), { value: parentId ?? '', emptyLabel: '（作为顶级组织）', placeholder: '点击选择上级组织' }), { hint: '选择后新组织挂在「法人 / 部门」路径下' })}
        ${field('组织名称', inputField('name'), { required: true })}`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>创建</button>',
    })
    mountSearchableSelects(modal.body)
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const data = collectForm(modal.body)
      try {
        await api.post('/api/iam/orgs', { name: data.name, parentId: data.parentId || null })
        toast(rqI18n.t('组织已创建')); modal.close(); ctx.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  }

  async function openUserImport() {
    let orgs = []
    try { orgs = await api.get('/api/iam/orgs') } catch { /* 组织读取失败时退回仅支持手填 orgId */ }
    // 组织解析索引：orgId / 全路径 / 唯一短名（小写键）→ orgId
    const orgOpts = buildOrgPaths(orgs)
    const labelById = new Map(orgOpts.map((opt) => [opt.value, opt.label]))
    const idByKey = new Map()
    const leafCount = new Map()
    for (const opt of orgOpts) {
      idByKey.set(String(opt.value).toLowerCase(), opt.value)
      idByKey.set(String(opt.label).toLowerCase(), opt.value)
      const leaf = String(opt.label).split(' / ').pop()
      leafCount.set(leaf, (leafCount.get(leaf) ?? 0) + 1)
    }
    for (const opt of orgOpts) {
      const leaf = String(opt.label).split(' / ').pop()
      if (leafCount.get(leaf) === 1) idByKey.set(leaf.toLowerCase(), opt.value)
    }
    const resolveOrg = (input) => {
      const key = String(input ?? '').trim().toLowerCase()
      if (!key) return { id: '', label: '' }
      const id = idByKey.get(key)
      return id ? { id, label: labelById.get(id) ?? id } : { id: null, label: String(input).trim() }
    }
    const modal = openModal({
      title: '批量导入账号',
      body: `
        <div class="form-hint" style="margin-bottom:10px">每行一个账号，格式：<code>用户名,姓名,组织ID或组织全路径,职位</code>（支持 Excel/CSV 导出后粘贴；组织可填 org_xxx、完整路径或唯一短名）</div>
        ${field('导入数据', textareaField('raw', { placeholder: 'wangwu,王五,org_xxx,算法工程师\nzhaoliu,赵六,杭州元冰可科技有限公司 / 数字化技术服务平台,产品经理', rows: 6 }), { full: true })}
        <div class="muted-box" id="import-preview">粘贴数据后在此预览解析结果…</div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>导入</button>',
    })
    const parseRows = () => modal.body.querySelector('[name="raw"]').value.split('\n').map((rawLine) => rawLine.trim()).filter(Boolean).map((rawLine) => {
      const [username, displayName, orgInput, title] = rawLine.split(',').map((s) => s?.trim())
      return { rawLine, username, displayName, orgInput, title, org: resolveOrg(orgInput) }
    })
    const previewEl = modal.body.querySelector('#import-preview')
    modal.body.querySelector('[name="raw"]').addEventListener('input', () => {
      const rows = parseRows()
      if (!rows.length) {
        previewEl.textContent = '粘贴数据后在此预览解析结果…'
        return
      }
      previewEl.innerHTML = rows.map((row) => {
        if (!row.username || !row.displayName || !row.orgInput) return `<div style="padding:2px 0;font-size:12px;color:var(--danger)">⚠ ${esc(rqI18n.t('{line}（字段不足：需要 用户名,姓名,组织,职位）', { line: row.rawLine }))}</div>`
        if (row.org.id === null) return `<div style="padding:2px 0;font-size:12px;color:var(--danger)">⚠ ${esc(rqI18n.t('{user} → 组织未命中：{org}', { user: row.username, org: row.orgInput }))}</div>`
        return `<div style="padding:2px 0;font-size:12px">· ${esc(rqI18n.t('{user} / {name} → 组织：{org}{title}', { user: row.username, name: row.displayName, org: row.org.label, title: row.title ? ` / ${row.title}` : '' }))}</div>`
      }).join('')
    })
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const rows = parseRows().filter((row) => row.username && row.displayName && row.orgInput)
      if (!rows.length) return toast(rqI18n.t('没有可导入的数据（检查格式）'), 'error')
      const bad = rows.filter((row) => row.org.id === null)
      if (bad.length) return toast(rqI18n.t('组织未命中：{orgs}，请修正后重试', { orgs: bad.map((row) => row.orgInput).join('、') }), 'error')
      try {
        const result = await api.post('/api/iam/users/import', { items: rows.map(({ username, displayName, org, title }) => ({ username, displayName, orgId: org.id, title })) })
        toast(rqI18n.t('导入完成：新建 {c}，跳过 {s}', { c: result.created.length, s: result.skipped.length }))
        modal.close(); ctx.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  }

  async function openUserDetail(id) {
    const [usersData2, rolesData, tree2] = await Promise.all([
      api.get('/api/iam/users'), api.get('/api/iam/roles'), api.get('/api/iam/orgs/tree'),
    ])
    const user = usersData2.users.find((u) => u.id === id)
    if (!user) return
    const drawer = openDrawer({
      title: user.displayName,
      sub: `@${user.username} · ${user.orgName ?? ''}`,
      body: `
        <div class="flex mb-14" style="gap:14px">
          <div class="avatar lg">${esc(user.displayName.slice(0, 1))}</div>
          <div class="grow">
            <div class="flex" style="gap:8px">${statusBadge(user.status)} <span class="fs-12 text-3">${esc(user.title || '未设置职位')}</span></div>
            <div class="fs-12 text-3 mt-8">${esc(user.email)}${user.phone ? ' · ' + esc(user.phone) : ''}</div>
          </div>
        </div>
        <div class="desc-grid mb-14">
          <div class="desc-item"><span class="k">组织</span><span class="v">${esc(user.orgName ?? '—')}</span></div>
          <div class="desc-item"><span class="k">创建时间</span><span class="v">${timeAgo(user.createdAt)}</span></div>
          <div class="desc-item"><span class="k">最近登录</span><span class="v">${timeAgo(user.lastLoginAt)}</span></div>
          <div class="desc-item"><span class="k">工号</span><span class="v">${esc(user.jobNumber ?? '—')}</span></div>
        </div>
        <div class="card-title mb-8">角色</div>
        <div class="mb-14" id="ud-roles">${user.roles?.map((r) => `<span class="badge badge-brand no-dot" style="margin:0 6px 6px 0">${esc(r.name)}</span>`).join('') || '<span class="text-4 fs-12">未分配角色</span>'}</div>
        <div class="card-title mb-8">三方身份绑定</div>
        <div class="mb-14">${user.bindings?.length ? user.bindings.map((b) => `
          <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border);gap:10px;align-items:center">
            <span class="badge badge-purple no-dot">${esc(providerName(b.provider))}</span>
            <span class="fs-12 grow" style="min-width:0">
              ${esc(b.displayName)}（${esc(b.unionId)}）
              ${b.corpId ? `<span class="fs-11 text-4"> · ${esc(b.corpId)}</span>` : ''}
            </span>
            <span class="fs-11 text-4">${timeAgo(b.boundAt)}</span>
            <button class="btn btn-ghost btn-sm" data-bind-replace="${esc(b.provider)}" data-bind-corp="${esc(b.corpId ?? '')}" title="${esc(rqI18n.t('解绑后立刻扫码绑定新身份'))}">${icon('refresh', 12)}${esc(rqI18n.t('更换'))}</button>
            <button class="btn btn-ghost btn-sm" data-bind-unbind="${esc(b.provider)}" data-bind-corp="${esc(b.corpId ?? '')}" style="color:var(--danger)" title="${esc(rqI18n.t('解除该三方身份绑定'))}">${icon('x', 12)}${esc(rqI18n.t('解绑'))}</button>
          </div>`).join('') : '<span class="text-4 fs-12">未绑定三方身份</span>'}
        </div>`,
      foot: `
        <button class="btn btn-default" id="ud-edit">${icon('edit', 14)}编辑</button>
        <button class="btn btn-default" id="ud-assign">${icon('shield', 14)}分配角色</button>
        <button class="btn btn-default" id="ud-bind">${icon('link', 14)}绑定三方</button>
        <button class="btn btn-default" id="ud-resetpw">${icon('key', 14)}重置口令</button>
        ${user.status === 'active' ? `<button class="btn btn-danger-ghost" id="ud-freeze">${icon('alert', 14)}冻结</button>` : ''}
        ${user.status === 'frozen' ? `<button class="btn btn-primary" id="ud-unfreeze">解除冻结</button>` : ''}
        ${user.status === 'pending' ? `<button class="btn btn-primary" id="ud-activate">激活账号</button>` : ''}`,
    })

    drawer.el.querySelector('#ud-edit').onclick = () => {
      const modal = openModal({
        title: '编辑账号', wide: true,
        body: `
          <div class="form-grid">
            ${field('姓名', inputField('displayName', { value: user.displayName }), { required: true })}
            ${field('职位', inputField('title', { value: user.title }))}
            ${field('邮箱', inputField('email', { value: user.email }))}
            ${field('手机号', inputField('phone', { value: user.phone }))}
            ${field('所属组织', searchableSelectField('orgId', flattenTreePaths(tree2), { value: user.orgId, placeholder: '点击选择：输入部门名搜索，显示「法人 / 部门」全路径' }), { full: true, hint: '同名部门跨法人重复，请认准完整路径再选' })}
          </div>`,
        foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
      })
      mountSearchableSelects(modal.body)
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      modal.el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.patch(`/api/iam/users/${user.id}`, collectForm(modal.body))
          toast(rqI18n.t('已保存')); modal.close(); drawer.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    }
    drawer.el.querySelector('#ud-assign').onclick = () => {
      const modal = openModal({
        title: '分配角色',
        body: rolesData.roles.map((role) => `
          <label class="flex" style="padding:10px 4px;border-bottom:1px solid var(--border);cursor:pointer">
            <input type="checkbox" name="role" value="${esc(role.id)}" ${user.roleIds.includes(role.id) ? 'checked' : ''} ${role.builtin && user.roleIds.includes(role.id) ? '' : ''} style="accent-color:var(--brand-500)">
            <div class="grow">
              <div class="fs-13" style="font-weight:500">${esc(role.name)} ${role.builtin ? '<span class="badge badge-muted no-dot">内置</span>' : ''}</div>
              <div class="fs-12 text-3">${esc(role.description)}</div>
            </div>
          </label>`).join(''),
        foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
      })
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      modal.el.querySelector('[data-ok]').onclick = async () => {
        const roleIds = [...modal.body.querySelectorAll('input[name=role]:checked')].map((el) => el.value)
        try {
          await api.patch(`/api/iam/users/${user.id}`, { roleIds })
          toast(rqI18n.t('角色已更新（权限点实时生效）')); modal.close(); drawer.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    }
    // 解绑 / 更换三方身份（2026-10-22）：
    //  - 解绑：DELETE /api/iam/users/:id/bindings/:provider?corpId=…，须 6 位二次验证码；
    //  - 更换：先「解绑」再「扫码绑定」两步。不在服务端一次做完「先解后绑」——绑定必须由 IdP 授权
    //    拿到 unionId，提前解绑会让用户在授权失败/取消时白丢已有绑定。
    const askVerifyCode = (action, onClose) => openModal({
      title: action,
      // 取消/遮罩关闭都要让外层 Promise 落地，否则调用方会一直挂起
      onClose,
      body: `
        <div class="muted-box mb-14" style="display:flex;gap:8px;border-color:#fcd34d;background:#fffbeb">
          ${icon('alert', 15)}<span class="fs-12">${esc(rqI18n.t('该操作会立即中断该账号当前的三方登录方式，需二次验证确认。'))}</span>
        </div>
        ${field(rqI18n.t('二次验证码'), inputField('verifyCode', { placeholder: rqI18n.t('6 位验证码') }), { required: true, hint: rqI18n.t('演示/自测环境可填 123456') })}`,
      foot: `<button class="btn btn-default" data-cancel>${esc(rqI18n.t('取消'))}</button><button class="btn btn-primary" data-ok>${esc(rqI18n.t('确认'))}</button>`,
    })
    /** 让用户输入二次验证码 → resolve(code) / 取消与关闭 → resolve('')。 */
    const promptVerifyCode = (action) => new Promise((resolve) => {
      let settled = false
      const finish = (code) => { if (settled) return; settled = true; resolve(code) }
      const modal = askVerifyCode(action, () => finish(''))
      modal.el.querySelector('[data-ok]').onclick = () => {
        const code = collectForm(modal.body).verifyCode ?? ''
        finish(code)
        modal.close()
      }
    })

    /** 绑定成功的回跳承接（扫码授权后 IdP 会整页返回控制台，绑定已完成）。 */
    const bindViaOauth = async (provider, corpId) => {
      const auth = await api.post('/api/auth/sso/bind/authorize', {
        provider,
        targetUserId: user.id,
        ...(corpId ? { configId: corpId } : {}),
      })
      if (!auth.authorizeUrl) throw new Error(rqI18n.t('身份源未返回授权地址（可能为 mock 模式），请改用手动绑定'))
      try { sessionStorage.setItem('heng_ops_bind_return', JSON.stringify({ userId: user.id, at: Date.now() })) } catch { /* 忽略 */ }
      window.location.href = auth.authorizeUrl
    }

    const providerConfigId = (binding) => binding.corpId || undefined

    drawer.el.querySelectorAll('[data-bind-unbind]').forEach((btn) => {
      btn.onclick = async () => {
        const provider = btn.dataset.bindUnbind
        const corpId = btn.dataset.bindCorp
        const confirmed = await confirmDialog({
          title: rqI18n.t('解绑三方身份'),
          danger: true,
          confirmText: rqI18n.t('确认解绑'),
          message: rqI18n.t('将解除 <b>{name}</b> 的 {provider} 身份绑定。解绑后该账号不能再以此身份登录，通讯录同步也不会自动绑回来（重新扫码绑定即可恢复）。', {
            name: esc(user.displayName),
            provider: esc(providerName(provider)),
          }),
        })
        if (!confirmed) return
        const code = await promptVerifyCode(rqI18n.t('解绑三方身份'))
        if (!code) return
        try {
          const path = `/api/iam/users/${user.id}/bindings/${encodeURIComponent(provider)}${corpId ? `?corpId=${encodeURIComponent(corpId)}` : ''}`
          await api.delete(path, { verifyCode: code })
          toast(rqI18n.t('已解绑 {provider}', { provider: providerName(provider) }))
          drawer.close()
          ctx.rerender()
        } catch (error) {
          toast(error.message, 'error')
        }
      }
    })

    drawer.el.querySelectorAll('[data-bind-replace]').forEach((btn) => {
      btn.onclick = async () => {
        const provider = btn.dataset.bindReplace
        const corpId = btn.dataset.bindCorp
        const confirmed = await confirmDialog({
          title: rqI18n.t('更换三方身份'),
          danger: true,
          confirmText: rqI18n.t('继续更换'),
          message: rqI18n.t('将先解除 <b>{name}</b> 当前的 {provider} 绑定，然后跳转 {provider} 扫码授权绑定新身份。若中途放弃授权，该账号将没有 {provider} 绑定。', {
            name: esc(user.displayName),
            provider: esc(providerName(provider)),
          }),
        })
        if (!confirmed) return
        const code = await promptVerifyCode(rqI18n.t('更换三方身份'))
        if (!code) return
        try {
          await api.post(`/api/iam/users/${user.id}/bindings/${encodeURIComponent(provider)}/replace`, {
            verifyCode: code,
            ...(corpId ? { corpId } : {}),
          })
          toast(rqI18n.t('已解绑旧身份，正在跳转扫码授权…'))
          await bindViaOauth(provider, providerConfigId({ corpId }))
        } catch (error) {
          toast(error.message, 'error')
        }
      }
    })

    drawer.el.querySelector('#ud-bind').onclick = async () => {
      let dingtalkConfigs = []
      try {
        const data = await api.get('/api/iam/connectors')
        dingtalkConfigs = (data?.configs ?? []).filter((c) => c.provider === 'dingtalk' && c.enabled && c.mode === 'real')
      } catch { /* 查询失败时仅提供手工录入 */ }
      const dingtalkReal = dingtalkConfigs.length > 0
      const modal = openModal({
        title: '绑定三方身份',
        body: `
          ${field('三方平台', selectField('provider', [{ value: 'dingtalk', label: '钉钉' }, { value: 'feishu', label: '飞书' }, { value: 'wecom', label: '企业微信' }]))}
          <div id="bind-oauth" ${dingtalkReal ? '' : 'style="display:none"'}>
            <div class="muted-box mb-14" style="display:flex;gap:8px;border-color:var(--brand-200);background:var(--brand-50)">
              ${icon('info', 15)}<span>无需填写任何 ID：点击按钮跳转钉钉授权，本机已登录钉钉将自动识别身份，未登录则扫码确认，授权后自动完成绑定。</span>
            </div>
            ${dingtalkConfigs.length > 1 ? field('选择主体', `<select class="select" id="bind-config-id">${dingtalkConfigs.map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.corpId)}</option>`).join('')}</select>`) : ''}
            <button class="btn btn-primary btn-block" id="bind-oauth-go">${icon('link', 14)}钉钉扫码授权绑定</button>
          </div>
          <details id="bind-manual-wrap" ${dingtalkReal ? '' : 'open'} style="margin-top:${dingtalkReal ? '14px' : '0'}">
            <summary class="fs-12 text-3" style="cursor:pointer;margin-bottom:10px">管理员手动绑定（备用）</summary>
            ${field('三方 unionId', inputField('unionId', { placeholder: '如 dd_u002' }), { required: !dingtalkReal })}
            ${field('三方昵称', inputField('displayName'))}
            ${field('二次验证码', inputField('verifyCode', { placeholder: '演示环境任意 6 位数字' }), { hint: '一人一号原则：同一三方身份只能绑定一个平台账号' })}
            <button class="btn btn-default btn-block" id="bind-manual-go">手动绑定</button>
          </details>`,
        foot: '<button class="btn btn-default" data-cancel>关闭</button>',
      })
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      const providerValue = () => modal.body.querySelector('[name="provider"]')?.value ?? 'dingtalk'
      modal.el.querySelector('#bind-oauth-go')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget
        btn.classList.add('btn-loading')
        try {
          if (providerValue() !== 'dingtalk') throw new Error(rqI18n.t('扫码授权绑定当前仅支持钉钉'))
          const configId = modal.body.querySelector('#bind-config-id')?.value
          const auth = await api.post('/api/auth/sso/bind/authorize', { provider: 'dingtalk', targetUserId: user.id, ...(configId ? { configId } : {}) })
          if (!auth.authorizeUrl) throw new Error(rqI18n.t('身份源未返回授权地址（可能为 mock 模式），请改用手动绑定'))
          // 必须整页跳转：弹窗/iframe 会被第三方 Cookie 策略拦截导致授权失败
          window.location.href = auth.authorizeUrl
        } catch (error) {
          toast(error.message, 'error')
          btn.classList.remove('btn-loading')
        }
      })
      modal.el.querySelector('#bind-manual-go')?.addEventListener('click', async () => {
        try {
          await api.post(`/api/iam/users/${user.id}/bindings`, { ...collectForm(modal.body), verifyCode: collectForm(modal.body).verifyCode || '123456' })
          toast(rqI18n.t('绑定成功')); modal.close(); drawer.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      })
    }
    drawer.el.querySelector('#ud-resetpw').onclick = async () => {
      const confirmed = await confirmDialog({
        title: '重置口令', danger: true, confirmText: '确认重置',
        message: rqI18n.t('将为 <b>{name}</b> 生成新的随机口令，原口令立即失效。新口令仅展示一次，请准备传达给本人。', { name: esc(user.displayName) }),
      })
      if (!confirmed) return
      try {
        const result = await api.post(`/api/iam/users/${user.id}/reset-password`)
        showUserCredentials({
          userId: user.id,
          username: result.username ?? user.username,
          displayName: user.displayName,
          password: result.initialPassword,
        })
      } catch (error) { toast(error.message, 'error') }
    }
    const freezeBtn = drawer.el.querySelector('#ud-freeze')
    if (freezeBtn) freezeBtn.onclick = async () => {
      const result = await confirmDialog({
        title: '冻结账号', danger: true, requireReason: true, confirmText: '确认冻结',
        message: rqI18n.t('冻结 <b>{name}</b> 后：其名下全部访问令牌将被立即吊销，无法登录任何入口。', { name: esc(user.displayName) }),
      })
      if (!result) return
      try {
        await api.post(`/api/iam/users/${user.id}/freeze`, { reason: result.reason })
        toast(rqI18n.t('已冻结并吊销全部令牌')); drawer.close(); ctx.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
    const unfreezeBtn = drawer.el.querySelector('#ud-unfreeze')
    if (unfreezeBtn) unfreezeBtn.onclick = async () => {
      await api.post(`/api/iam/users/${user.id}/unfreeze`, {})
      toast(rqI18n.t('已解除冻结')); drawer.close(); ctx.rerender()
    }
    const activateBtn = drawer.el.querySelector('#ud-activate')
    if (activateBtn) activateBtn.onclick = async () => {
      await api.post(`/api/iam/users/${user.id}/activate`, {})
      toast(rqI18n.t('账号已激活')); drawer.close(); ctx.rerender()
    }
  }
}

/**
 * Agent 组织视图（R7「人 + Agent」双层）：按组织分组的 Agent 名册。
 * orgRole 中文映射、attrs.managerId 跨表解析汇报上级、attrs.frozenAt 冻结徽章（title 带 frozenReason）。
 * 独立成卡不触碰上方交互组织树；GET /api/agents 失败时降级移除整卡。
 */
async function mountAgentOrgView(treeData) {
  const host = $('#agent-org-card')
  if (!host) return
  let agents = []
  try {
    const data = await api.get('/api/agents')
    agents = data.agents ?? []
  } catch {
    host.remove()
    return
  }
  const ORG_ROLE_LABEL = { ceo: 'CEO', cto: 'CTO', manager: '经理', engineer: '工程师', analyst: '分析师' }

  // 组织名解析：优先本页组织树（已是全量），树里没有的（如跨组织 Agent）原样显示 ID
  const orgNames = new Map()
  const walkTree = (nodes) => { for (const node of nodes ?? []) { orgNames.set(node.id, node.name); walkTree(node.children) } }
  walkTree(treeData)
  const agentById = new Map(agents.map((a) => [a.id, a]))

  const groups = new Map()
  for (const agent of agents) {
    const key = agent.orgId || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(agent)
  }

  const agentRow = (agent) => {
    const attrs = agent.attrs ?? {}
    const manager = attrs.managerId ? agentById.get(attrs.managerId) : null
    const frozen = Boolean(attrs.frozenAt)
    return `
      <tr>
        <td><div class="col-strong">${esc(agent.name)}</div><div class="col-sub mono fs-11">${esc(agent.slug ?? agent.id)}</div></td>
        <td class="fs-12">${esc(ORG_ROLE_LABEL[attrs.orgRole] ?? attrs.orgRole ?? '—')}</td>
        <td class="fs-12">${esc(attrs.rank ?? '—')}</td>
        <td class="fs-12">${manager ? esc(manager.name) : attrs.managerId ? `<span class="mono fs-11 text-4">${esc(attrs.managerId)}</span>` : '—'}</td>
        <td>${frozen ? `<span class="badge badge-purple no-dot" title="${esc(attrs.frozenReason ?? '已冻结')}">已冻结</span>` : '<span class="text-4 fs-12">—</span>'}</td>
        <td>${statusBadge(agent.status)}</td>
      </tr>`
  }

  const orgBlocks = [...groups.entries()].map(([orgId, list]) => `
    <div class="fs-13" style="font-weight:600;margin:14px 0 2px;display:flex;gap:6px;align-items:center">
      ${icon('building', 13)} ${esc(orgNames.get(orgId) ?? (orgId || '（未挂组织）'))}
      <span class="badge badge-muted no-dot">${list.length}</span>
    </div>
    <div class="table-wrap">
      <table class="tbl">
        <thead><tr><th>Agent</th><th>组织角色</th><th>职级</th><th>汇报上级</th><th>冻结</th><th>状态</th></tr></thead>
        <tbody>${list.map(agentRow).join('')}</tbody>
      </table>
    </div>`).join('')

  host.innerHTML = `
    <div class="card-head">
      <span class="card-title">${icon('bot', 15)} Agent 组织视图</span>
      <span class="card-sub">${esc(rqI18n.t('{n} 个 Agent 按组织归队 · 人与 Agent 同一张组织架构（R7 双层视图）', { n: agents.length }))}</span>
    </div>
    <div class="card-body" style="padding-top:0;padding-bottom:14px">
      ${agents.length ? orgBlocks : `<div class="tbl-empty">${icon('bot', 28)}<span>暂无 Agent——注册 Agent 并挂到组织后在此显示名册</span></div>`}
    </div>`
}

/**
 * 三方连接器摘要卡（§5.8 默认视图左列）：取自 connectors tab 同源数据
 * （GET /api/iam/connectors + /api/iam/conflicts），只读展示 模式 / 同步频率 / 最近同步 / 冲突数；
 * 无 iam.connector 读权限或请求失败时降级移除整卡，完整管理在「三方集成」tab。
 */
async function mountConnectorSummary() {
  const host = $('#iam-conn-card')
  if (!host) return
  let configs = []
  try {
    configs = (await api.get('/api/iam/connectors')).configs ?? []
  } catch {
    host.remove()
    return
  }
  let conflictCount = null
  try {
    conflictCount = (await api.get('/api/iam/conflicts')).conflicts.length
  } catch { /* 冲突数读不到时省略该行，不造假 */ }
  const conflictText = conflictCount === null ? '' : rqI18n.t(' · {n} 冲突', { n: conflictCount })
  const jumpTab = (tab) => { location.hash = `#/iam?tab=${tab}` }
  host.innerHTML = `
    <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:8px">
      <div class="micro-label">三方连接器</div>
      <button class="btn btn-ghost btn-sm" id="iam-conn-more">管理 ${icon('chevronRight', 12)}</button>
    </div>
    ${configs.length ? configs.map((config) => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px">
        <div class="flex" style="justify-content:space-between;align-items:center">
          <span class="fs-13" style="font-weight:500">${esc(config.name || providerName(config.provider))}</span>
          ${config.enabled
            ? `<span class="fs-11" style="display:inline-flex;align-items:center;gap:5px;color:var(--ok)"><span class="dot dot-ok" style="width:7px;height:7px;border-radius:50%;background:var(--ok);display:inline-block"></span>已启用</span>`
            : '<span class="fs-11 text-4">未启用</span>'}
        </div>
        <div class="fs-12 text-3" style="margin-top:6px;line-height:1.8">
          <div class="flex" style="justify-content:space-between"><span>模式</span><span class="mono">${config.mode === 'real' ? 'real' : 'mock'}</span></div>
          <div class="flex" style="justify-content:space-between"><span>同步频率</span><span class="mono">${(config.intervalMinutes ?? 60) > 0 ? esc(rqI18n.t('每 {n} 分钟', { n: config.intervalMinutes ?? 60 })) : '仅手动'}</span></div>
          <div class="flex" style="justify-content:space-between"><span>最近同步</span><span class="mono">${config.lastSyncAt ? timeAgo(config.lastSyncAt) : '从未同步'}${conflictText}</span></div>
        </div>
      </div>`).join('') : `
      <div class="fs-12 text-4" style="line-height:1.8">尚未接入三方身份源——到「三方集成」tab 配置钉钉等连接器后，通讯录将按频率自动同步。</div>`}
    ${conflictCount ? `<button class="btn btn-default btn-sm" id="iam-conn-conflicts" style="width:100%">${icon('alert', 12)}${esc(rqI18n.t('处理 {n} 条同步冲突', { n: conflictCount }))}</button>` : ''}`
  const moreBtn = host.querySelector('#iam-conn-more')
  if (moreBtn) moreBtn.onclick = () => { jumpTab('connectors') }
  const conflictBtn = host.querySelector('#iam-conn-conflicts')
  if (conflictBtn) conflictBtn.onclick = () => { jumpTab('conflicts') }
}

