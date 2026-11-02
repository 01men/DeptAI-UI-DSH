/**
 * 同步冲突 tab：冲突队列/以三方或本地为准的处置（R4 前端拆分，REFACTOR-2026-10-13，2026-10-13）：
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

export async function renderConflicts(ctx) {
  const [data, orgs] = await Promise.all([
    api.get('/api/iam/conflicts'),
    api.get('/api/iam/orgs'),
  ])
  const pending = data.conflicts
  // UI-07：org_id 原文（org_xxx）对业务用户无意义且无法判断差异实质，
  // 统一解析为「法人 / 部门」全路径展示；同名部门靠路径区分。
  const orgPathById = new Map(buildOrgPaths(orgs).map((opt) => [opt.value, opt.label]))
  $('#conflict-count').textContent = String(pending.length)
  $('#iam-actions').innerHTML = `
    <button class="btn btn-default" id="cf-batch-platform" ${pending.length ? '' : 'disabled'}>${icon('shield', 14)}一键保留平台</button>
    <button class="btn btn-danger-ghost" id="cf-batch-third" ${pending.length ? '' : 'disabled'}>${icon('refresh', 14)}一键以三方为准</button>`
  if (pending.length) {
    $('#cf-batch-platform').onclick = () => batchResolve('platform')
    $('#cf-batch-third').onclick = () => batchResolve('third_party')
  }
  const body = $('#iam-body')
  if (!pending.length) {
    body.innerHTML = ''
    body.appendChild(emptyState({ title: '没有待处理的同步冲突', desc: '三方通讯录与平台数据一致，或冲突均已处理', icon: 'shieldCheck' }))
    return
  }
  // 批量处理：逐条调用单条 resolve 接口，逐条容错，最后汇总结果（不新增后端接口）
  async function batchResolve(keep) {
    const confirmed = await confirmDialog({
      title: rqI18n.t('批量处理 {n} 条同步冲突', { n: pending.length }),
      message: keep === 'platform'
        ? rqI18n.t('将忽略三方差异，{n} 条冲突全部保留平台侧当前数据并关闭工单。', { n: pending.length })
        : rqI18n.t('将用三方通讯录数据覆盖平台侧数据，共 {n} 条，立即生效并留痕。确认继续？', { n: pending.length }),
      danger: keep !== 'platform',
      confirmText: rqI18n.t(keep === 'platform' ? '确认全部保留平台' : '确认全部以三方为准'),
    })
    if (!confirmed) return
    let ok = 0
    const failed = []
    for (const conflict of pending) {
      try {
        await api.post(`/api/iam/conflicts/${conflict.id}/resolve`, { keep })
        ok++
      } catch (error) {
        failed.push(error.message)
      }
    }
    if (failed.length) toast(rqI18n.t('已处理 {ok} 条，失败 {f} 条：{msg}', { ok, f: failed.length, msg: failed[0] }), 'error')
    else toast(rqI18n.t(keep === 'platform' ? '一键保留平台完成：共处理 {n} 条冲突' : '一键以三方为准完成：共处理 {n} 条冲突', { n: ok }), 'success')
    ctx.rerender()
  }
  for (const conflict of pending) {
    const card = h(`
      <div class="card card-pad mb-14">
        <div class="flex-between mb-14">
          <div class="flex">
            <span class="badge badge-warn">${esc(conflict.kind === 'user_attr' ? '属性差异' : conflict.kind)}</span>
            <span class="fs-12 text-3">来源：${esc(providerName(conflict.provider))} · ${timeAgo(conflict.createdAt)}</span>
          </div>
        </div>
        <div class="grid-2">
          <div style="border:1px solid var(--warn-border);background:var(--warn-bg);border-radius:10px;padding:14px">
            <div class="fs-12" style="font-weight:600;color:#b45309;margin-bottom:8px">三方数据（钉钉）</div>
            ${diffRows(conflict.thirdPartyData)}
          </div>
          <div style="border:1px solid var(--border);background:var(--surface-2);border-radius:10px;padding:14px">
            <div class="fs-12" style="font-weight:600;margin-bottom:8px">平台数据</div>
            ${diffRows(conflict.platformData)}
          </div>
        </div>
        <div class="flex mt-14" style="justify-content:flex-end">
          <button class="btn btn-default" data-keep="platform">保留平台</button>
          <button class="btn btn-primary" data-keep="third_party">以三方为准</button>
        </div>
      </div>`)
    card.querySelectorAll('[data-keep]').forEach((btn) => {
      btn.onclick = async () => {
        await api.post(`/api/iam/conflicts/${conflict.id}/resolve`, { keep: btn.dataset.keep })
        toast(rqI18n.t('冲突已处理'))
        ctx.rerender()
      }
    })
    body.appendChild(card)
  }
  function diffRows(rowData) {
    return Object.entries(rowData ?? {}).filter(([k]) => k !== 'jobNumber').map(([k, v]) => {
      // 部门差异显示完整路径而非原始 ID；组织已被删除时如实说明
      const value = k === 'orgId' ? (orgPathById.get(String(v)) ?? rqI18n.t('{org}（该组织已不在平台组织树中）', { org: v })) : v
      return `
      <div class="flex" style="padding:3px 0;font-size:12.5px">
        <span class="text-4" style="width:70px;flex-shrink:0">${fieldName(k)}</span><span>${esc(String(value ?? '—'))}</span>
      </div>`
    }).join('')
  }
}
