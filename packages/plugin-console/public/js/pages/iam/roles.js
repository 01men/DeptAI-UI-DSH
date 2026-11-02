/**
 * 角色权限 tab：角色矩阵/权限点编辑/成员授予（R4 前端拆分，REFACTOR-2026-10-13，2026-10-13）：
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
} from './helpers.js'
import rqI18n from '../../i18n.js'

export async function renderRoles(ctx) {
  $('#iam-actions').innerHTML = `<button class="btn btn-primary" id="role-add">${icon('plus', 14)}新建角色</button>`
  const data = await api.get('/api/iam/roles')
  const groups = new Map()
  for (const perm of data.catalog) {
    if (!groups.has(perm.group)) groups.set(perm.group, [])
    groups.get(perm.group).push(perm)
  }
  const body = $('#iam-body')
  body.innerHTML = `
    <div class="grid-2" style="grid-template-columns:1fr 1.2fr;align-items:start">
      <div class="card table-wrap">
        <table class="tbl">
          <thead><tr><th>角色</th><th>类型</th><th>权限数</th></tr></thead>
          <tbody id="role-rows"></tbody>
        </table>
      </div>
      <div class="card card-pad" id="perm-panel"><span class="text-4 fs-13">← 点击左侧角色查看权限点矩阵</span></div>
    </div>`
  const rowsEl = $('#role-rows')
  data.roles.forEach((role) => {
    const tr = h(`<tr>
      <td><div class="col-strong">${esc(role.name)}</div><div class="col-sub mono">${esc(role.code)}</div></td>
      <td>${role.builtin ? '<span class="badge badge-muted no-dot">内置</span>' : '<span class="badge badge-brand no-dot">自定义</span>'}</td>
      <td class="col-num">${role.permissions.includes('*') ? '全部' : role.permissions.length}</td>
    </tr>`)
    tr.onclick = () => renderPermPanel(role)
    rowsEl.appendChild(tr)
  })
  /** 角色表单弹窗：role 为空为新建，传入 role 为编辑（code 不可改，预填并回显权限勾选）。 */
  const openRoleModal = (role) => {
    const isEdit = !!role
    const has = (point) => role && (role.permissions.includes('*') || role.permissions.includes(point) || role.permissions.some((p) => p.endsWith('.*') && point.startsWith(p.slice(0, -1))))
    const modal = openModal({
      title: isEdit ? esc(rqI18n.t('编辑角色：{name}', { name: role.name })) : '新建角色', wide: true,
      body: `
        <div class="form-grid">
          ${field('角色名称', inputField('name', { value: role?.name ?? '' }), { required: true })}
          ${isEdit ? field('角色 code', `<code class="mono" style="line-height:32px">${esc(role.code)}</code>`, { hint: 'code 创建后不可修改' }) : field('角色 code', inputField('code', { placeholder: '小写字母，如 data_steward' }), { required: true })}
          ${field('描述', inputField('description', { value: role?.description ?? '' }), { full: true })}
        </div>
        <div class="card-title mb-8">权限点（菜单 + API + 数据范围）</div>
        <div class="muted-box mb-8" style="font-size:12px">引用此角色的<b>机器凭证</b>权限将实时同步：此处保存后立即生效，无需调整凭证。</div>
        <div style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px" id="new-role-perms">
          ${[...groups.entries()].map(([group, perms]) => `
            <div style="padding:6px 4px">
              <div class="fs-12" style="font-weight:600;color:var(--text-2)">${esc(group)}</div>
              ${perms.map((p) => `<label class="flex" style="padding:3px 0;font-size:12.5px;cursor:pointer">
                <input type="checkbox" name="perm" value="${esc(p.point)}" ${has(p.point) ? 'checked' : ''} style="accent-color:var(--brand-500)">
                <span>${esc(p.label)}</span><span class="mono text-4" style="margin-left:auto">${esc(p.point)}</span>
              </label>`).join('')}
            </div>`).join('')}
        </div>`,
      foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>${isEdit ? '保存' : '创建'}</button>`,
    })
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const data2 = collectForm(modal.body)
      const permissions = [...modal.body.querySelectorAll('input[name=perm]:checked')].map((el) => el.value)
      try {
        if (isEdit) {
          await api.patch(`/api/iam/roles/${role.id}`, { name: data2.name, description: data2.description, permissions })
          toast(rqI18n.t('角色已更新（权限实时生效）'))
        } else {
          await api.post('/api/iam/roles', { name: data2.name, code: data2.code, description: data2.description, permissions })
          toast(rqI18n.t('角色已创建'))
        }
        modal.close(); ctx.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  }
  $('#role-add').onclick = () => openRoleModal(null)

  function renderPermPanel(role) {
    const panel = $('#perm-panel')
    const has = (point) => role.permissions.includes('*') || role.permissions.includes(point) || role.permissions.some((p) => p.endsWith('.*') && point.startsWith(p.slice(0, -1)))
    panel.innerHTML = `
      <div class="flex-between mb-14">
        <div>
          <div class="card-title">${esc(role.name)} ${role.builtin ? '<span class="badge badge-muted no-dot">内置</span>' : ''}</div>
          <div class="fs-12 text-3 mt-8">${esc(role.description)}</div>
        </div>
        ${role.builtin ? '' : `<button class="btn btn-default btn-sm" id="role-edit">${icon('edit', 13)}编辑角色</button>`}
      </div>
      ${[...groups.entries()].map(([group, perms]) => `
        <div style="margin-bottom:12px">
          <div class="fs-12" style="font-weight:600;color:var(--text-2);margin-bottom:4px">${esc(group)}</div>
          ${perms.map((p) => `
            <div class="flex" style="padding:4px 0;font-size:12.5px">
              <span style="color:${has(p.point) ? 'var(--ok)' : 'var(--text-4)'}">${icon(has(p.point) ? 'check' : 'x', 13)}</span>
              <span class="${has(p.point) ? '' : 'text-4'}">${esc(p.label)}</span>
              <span class="mono text-4" style="margin-left:auto">${esc(p.point)}</span>
            </div>`).join('')}
        </div>`).join('')}`
    const editBtn = panel.querySelector('#role-edit')
    if (editBtn) editBtn.onclick = () => openRoleModal(role)
  }
}
