/**
 * 用户组 tab：静态组/动态组/成员维护/组织快照（R4 前端拆分，REFACTOR-2026-10-13，2026-10-13）：
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

export async function renderGroups(ctx) {
  $('#iam-actions').innerHTML = `<button class="btn btn-primary" id="group-add">${icon('plus', 14)}新建用户组</button>`
  const [data, treeData] = await Promise.all([api.get('/api/iam/groups'), api.get('/api/iam/orgs/tree')])
  const body = $('#iam-body')
  if (!data.groups.length) {
    body.innerHTML = ''
    body.appendChild(emptyState({ title: '还没有用户组', desc: '用户组是授权的最小单位——静态组手工圈人，动态组按规则自动圈人', actionText: '新建用户组', onAction: () => $('#group-add').click() }))
  } else {
    body.innerHTML = `<div id="group-list"></div>`
    const list = $('#group-list')
    for (const group of data.groups) {
      const card = h(`
        <div class="card card-pad mb-14">
          <div class="flex-between mb-8">
            <div class="flex">
              <span class="badge ${group.type === 'dynamic' ? 'badge-purple' : 'badge-brand'} no-dot">${group.type === 'dynamic' ? '动态组' : '静态组'}</span>
              <span style="font-weight:600">${esc(group.name)}</span>
              <span class="fs-12 text-3">${esc(group.description || '')}</span>
            </div>
            <div class="flex">
              <button class="btn btn-ghost btn-sm" data-edit>${icon('edit', 13)}编辑</button>
              <button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-del>${icon('trash', 13)}</button>
            </div>
          </div>
          <div class="flex" style="flex-wrap:wrap;gap:6px">
            ${group.resolvedMembers.slice(0, 12).map((m) => `<span class="badge badge-muted no-dot">${icon('user', 12)}${esc(m.displayName)}</span>`).join('')}
            ${group.resolvedMembers.length > 12 ? `<span class="fs-12 text-4">${esc(rqI18n.t('等 {n} 人', { n: group.resolvedMembers.length }))}</span>` : ''}
            ${group.resolvedMembers.length === 0 ? '<span class="fs-12 text-4">暂无成员（动态组按规则实时圈人）</span>' : ''}
          </div>
        </div>`)
      card.querySelector('[data-edit]').onclick = () => openGroupEditor(group, treeData)
      card.querySelector('[data-del]').onclick = async () => {
        const result = await confirmDialog({ title: '删除用户组', message: esc(rqI18n.t('删除「{name}」后，基于该组的授权（MCP 权限组等）将同步失效。', { name: group.name })), danger: true })
        if (!result) return
        await api.delete(`/api/iam/groups/${group.id}`)
        toast(rqI18n.t('已删除')); ctx.rerender()
      }
      list.appendChild(card)
    }
  }
  $('#group-add').onclick = () => openGroupEditor(null, treeData)

  function openGroupEditor(group, tree) {
    const modal = openModal({
      title: group ? '编辑用户组' : '新建用户组', wide: true,
      body: `
        <div class="form-grid">
          ${field('名称', inputField('name', { value: group?.name }), { required: true })}
          ${field('类型', selectField('type', [{ value: 'static', label: '静态组（手工维护）' }, { value: 'dynamic', label: '动态组（按规则自动圈人）' }], { value: group?.type ?? 'static' }), { required: true })}
          ${field('描述', inputField('description', { value: group?.description }), { full: true })}
        </div>
        <div class="form-hint" style="margin:0 0 10px">动态组规则：按部门子树 + 职位过滤，实时生效</div>
        <div class="form-grid">
          ${field('圈人部门（动态组）', searchableSelectField('ruleOrgId', flattenTreePaths(tree), { value: group?.rule?.orgIds?.[0] ?? '', emptyLabel: '（不限）', placeholder: '点击选择部门' }))}
          ${field('职位过滤（动态组）', inputField('ruleTitle', { value: group?.rule?.title, placeholder: '如：算法工程师' }))}
        </div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
    })
    mountSearchableSelects(modal.body)
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const data2 = collectForm(modal.body)
      const payload = {
        name: data2.name,
        type: data2.type,
        description: data2.description,
        ...(data2.type === 'dynamic' ? { rule: { ...(data2.ruleOrgId ? { orgIds: [data2.ruleOrgId] } : {}), ...(data2.ruleTitle ? { title: data2.ruleTitle } : {}) } } : {}),
      }
      try {
        if (group) await api.patch(`/api/iam/groups/${group.id}`, payload)
        else await api.post('/api/iam/groups', payload)
        toast(rqI18n.t('已保存')); modal.close(); ctx.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  }
}
