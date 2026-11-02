/**
 * iam 页共享辅助（R4 前端拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 账号凭据展示弹窗 + 工具函数族（组织树拍平/路径/查找/防抖/枚举名映射），
 * 自 pages/iam.js 逐字搬运，供五个 tab 模块统一转引。
 */
import { api, session } from '../../api.js'
import rqI18n from '../../i18n.js'
import { icon } from '../../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog, copyText,
  renderTable, statusBadge, collectForm, field, inputField, selectField, textareaField,
  searchableSelectField, mountSearchableSelects,
  attachDropdown, timeAgo, emptyState,
} from '../../ui.js'

export function showUserCredentials({ userId, username, displayName, password, onDone }) {
  let current = password
  const modal = openModal({
    title: esc(rqI18n.t('账号凭据（{name}）', { name: displayName })),
    body: `
      <div class="form-hint" style="margin-bottom:12px">请立即复制并安全传达给本人；口令仅本次展示，传达前可在下方直接二次修改。</div>
      <div class="muted-box mb-8" style="display:flex;align-items:center;gap:10px;justify-content:space-between">
        <span style="min-width:64px" class="fs-12 text-4">用户名</span>
        <code id="cred-username" style="flex:1;font-size:15px;font-weight:700;color:var(--danger);word-break:break-all">${esc(username)}</code>
        <button class="btn btn-default btn-sm" id="cred-copy-user">复制</button>
      </div>
      <div class="muted-box mb-8" style="display:flex;align-items:center;gap:10px;justify-content:space-between">
        <span style="min-width:64px" class="fs-12 text-4">口令</span>
        <code id="cred-password" style="flex:1;font-size:15px;font-weight:700;color:var(--danger);word-break:break-all">${esc(current)}</code>
        <button class="btn btn-default btn-sm" id="cred-copy-pw">复制</button>
      </div>
      <button class="btn btn-default btn-sm mb-8" id="cred-copy-all">${icon('check', 12)}一键复制完整凭据（用户名 + 口令）</button>
      <div class="card-title mb-8 mt-14">二次修改口令（可选）</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="input" id="cred-newpw" placeholder="新口令（至少 8 位，不含中文）" autocomplete="off" style="flex:1">
        <button class="btn btn-default" id="cred-setpw">设为该口令</button>
        <button class="btn btn-default" id="cred-randpw">重新随机</button>
      </div>
      <div class="form-hint mt-8">修改后原口令立即失效，请以弹窗内最新口令为准传达。</div>`,
    foot: '<button class="btn btn-primary" data-cancel>我已妥善传达</button>',
  })
  const pwEl = modal.body.querySelector('#cred-password')
  const applyPassword = (next, note) => {
    current = next
    pwEl.textContent = current
    modal.body.querySelector('#cred-newpw').value = ''
    toast(note)
  }
  const resetTo = async (payload, note) => {
    try {
      const result = await api.post(`/api/iam/users/${userId}/reset-password`, payload)
      applyPassword(result.initialPassword, note)
    } catch (error) { toast(error.message, 'error') }
  }
  modal.body.querySelector('#cred-copy-user').onclick = () => void copyText(username)
  modal.body.querySelector('#cred-copy-pw').onclick = () => void copyText(current)
  modal.body.querySelector('#cred-copy-all').onclick = () => void copyText(rqI18n.t('用户名：{u}\n口令：{p}', { u: username, p: current }))
  modal.body.querySelector('#cred-setpw').onclick = () => {
    const next = modal.body.querySelector('#cred-newpw').value.trim()
    if (next.length < 8) return toast(rqI18n.t('口令长度不得少于 8 位'), 'error')
    void resetTo({ password: next }, rqI18n.t('口令已更新为指定值，请重新复制传达'))
  }
  modal.body.querySelector('#cred-randpw').onclick = () => void resetTo({}, rqI18n.t('已重新生成随机口令，请重新复制传达'))
  modal.el.querySelector('[data-cancel]').onclick = () => { modal.close(); onDone?.() }
}

export function providerName(provider) {
  return { dingtalk: '钉钉', feishu: '飞书', wecom: '企业微信' }[provider] ?? provider
}
/**
 * UI-05：姓名里含「已废除/离职/退休」等状态字样但账号状态仍是「正常」时给出提示徽标。
 * 根因多为改名后未停用（数据卫生），提示管理员进入详情核实处理。
 */
export function nameStatusMismatch(user) {
  if (user.status !== 'active') return ''
  const keywords = ['废除', '已废', '离职', '退休', '辞退', '解聘', '停用', '注销', '删除']
  const hit = keywords.find((kw) => String(user.displayName ?? '').includes(kw))
  if (!hit) return ''
  const tip = rqI18n.t('姓名含「{state}」字样，但账号状态仍为「正常」，可能是改名后未停用，请进入详情核实', { state: hit })
  return ` <span class="badge badge-warn no-dot" title="${esc(tip)}">${esc(rqI18n.t('名称疑似已{state}？', { state: hit }))}</span>`
}
export function strategyName(strategy) {
  return { manual: '人工确认', third_party_wins: '以三方为准', platform_wins: '以平台为准' }[strategy] ?? strategy
}
export function fieldName(key) {
  return { displayName: '姓名', title: '职位', orgId: '所属部门', orgName: '部门名称', unionId: '三方ID' }[key] ?? key
}
export function syncStatCard(label, value, color) {
  return `
    <div style="background:var(--surface-2);border-radius:10px;padding:14px 16px">
      <div class="fs-12 text-3">${esc(label)}</div>
      <div style="font-size:16px;font-weight:600;color:${color};margin-top:4px">${esc(value)}</div>
    </div>`
}
export function flattenTree(nodes, depth = 0, out = []) {
  for (const node of nodes ?? []) {
    out.push({ id: node.id, name: node.name, depth })
    flattenTree(node.children ?? [], depth + 1, out)
  }
  return out
}
/**
 * 拍平组织树为带「法人 / 部门」完整路径的选项序列（UI-04）：
 * 跨法人同名部门极多，仅凭名称无法区分，选项统一展示全路径并按顶级组织（法人）分组。
 */
export function flattenTreePaths(nodes, parentPath = [], rootName = '', out = []) {
  for (const node of nodes ?? []) {
    const path = [...parentPath, node.name]
    out.push({ value: node.id, label: path.join(' / '), group: rootName || node.name })
    flattenTreePaths(node.children ?? [], path, rootName || node.name, out)
  }
  return out
}
/** 组织树按 id 查节点（负责人栏用；树节点为 OrgRecord 展开，自带 leaderUserIds/leaderSource）。 */
export function findOrgNode(nodes, id) {
  for (const node of nodes ?? []) {
    if (node.id === id) return node
    const hit = findOrgNode(node.children ?? [], id)
    if (hit) return hit
  }
  return null
}
/** 平铺组织列表（GET /api/iam/orgs）按 parentId 还原层级，拍平成带缩进深度的序列（下拉选项用）。 */
export function flattenOrgList(orgs) {
  const childrenOf = new Map()
  for (const org of orgs ?? []) {
    const key = org.parentId ?? ''
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key).push(org)
  }
  const out = []
  const walk = (parentId, depth) => {
    const list = (childrenOf.get(parentId) ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    for (const org of list) {
      out.push({ id: org.id, name: org.name, depth })
      walk(org.id, depth + 1)
    }
  }
  walk('', 0)
  return out
}
/** 平铺组织列表 → 带「法人 / 部门」全路径的可搜索选项（UI-04，与 flattenTreePaths 输出同构）。 */
export function buildOrgPaths(orgs) {
  const byId = new Map((orgs ?? []).map((o) => [o.id, o]))
  const pathOf = (org) => {
    const parts = []
    let cur = org
    const seen = new Set()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      parts.unshift(cur.name)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return parts.join(' / ')
  }
  const ordered = flattenOrgList(orgs)
  return ordered.map((item) => {
    const org = byId.get(item.id)
    const label = pathOf(org)
    return { value: item.id, label, group: label.split(' / ')[0] ?? label }
  })
}
export function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}