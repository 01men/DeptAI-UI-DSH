/** NAS 数据权限：规则/矩阵/例外（含过期倒计时）/C 关联组/NAS 锚点映射/check 试算/判定留痕/治理工具。 */
import { api, session } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openModal, openDrawer, confirmDialog, selectField,
  searchableSelectField, multiSelectField, mountSearchableSelects,
  renderTable, inputField, textareaField, timeAgo, emptyState, collectForm, field,
} from '../ui.js'

const OPS = ['read', 'download', 'write', 'modify', 'delete', 'share', 'admin']
const OP_LABEL = { read: '读取', download: '下载', write: '写入', modify: '改动', delete: '删除', share: '分享', admin: '管理' }
const ROLES = ['P', 'D', 'T', 'M']
const ROLE_LABEL = { P: 'P 平台负责人', D: 'D 部门负责人', T: 'T 班组负责人', M: 'M 成员', C: 'C 跨域只读(叠加)' }
const MATRIX_DEFAULT = {
  P: { read: 1, download: 1, write: 1, modify: 1, delete: 1, share: 1, admin: 1 },
  D: { read: 1, download: 1, write: 1, modify: 1, delete: 1, share: 1, admin: 0 },
  T: { read: 1, download: 1, write: 1, modify: 1, delete: 0, share: 0, admin: 0 },
  M: { read: 1, download: 1, write: 1, modify: 0, delete: 0, share: 0, admin: 0 },
}

let rules = null
let shareLinkPolicy = null
let nasList = []
let groupNames = new Map()
let orgList = []
let userList = []

export async function renderNasAuthz(content) {
  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">NAS AUTHZ</div>
        <div class="page-title">NAS 数据权限</div>
        <div class="page-sub">组织位置 + 角色层级 RBAC（P/D/T/M + C 叠加）：五步判定序，显式例外优先于角色矩阵；网关与 hermes 双强制点共用同一套规则，全链 fail-closed。</div>
      </div>
      <div class="page-actions">
        ${session.can('nas.authz.write') ? `<button class="btn btn-default" id="az-reconcile">${icon('refresh', 14)}组织目录对账</button>` : ''}
        ${session.can('nas.authz.write') ? `<button class="btn btn-default" id="az-vacancy">${icon('users', 14)}负责人悬空扫描</button>` : ''}
        ${session.can('nas.authz.check') ? `<button class="btn btn-primary" id="az-simulate">${icon('search', 14)}check 试算</button>` : ''}
      </div>
    </div>
    <div id="az-body" class="az-page"></div>`

  await loadAll()
  const reconcileBtn = $('#az-reconcile')
  if (reconcileBtn) reconcileBtn.onclick = () => runGovern('/api/nas/authz/reconcile', rqI18n.t('组织目录对账'))
  const vacancyBtn = $('#az-vacancy')
  if (vacancyBtn) vacancyBtn.onclick = () => runGovern('/api/nas/authz/leader-vacancy-scan', rqI18n.t('负责人悬空扫描'))
  const simulateBtn = $('#az-simulate')
  if (simulateBtn) simulateBtn.onclick = () => openSimulate()
  renderBody()
}

async function loadAll() {
  const [rulesResp, nasResp, groupsResp, orgsResp, usersResp, policyResp] = await Promise.all([
    api.get('/api/nas/authz/rules'),
    api.get('/api/nas').catch(() => ({ items: [] })),
    api.get('/api/iam/groups').catch(() => ({ groups: [] })),
    api.get('/api/iam/orgs').catch(() => []),
    api.get('/api/iam/users').catch(() => ({ users: [] })),
    api.get('/api/nas/authz/share-link-policy').catch(() => null),
  ])
  rules = rulesResp
  nasList = nasResp.items ?? []
  groupNames = new Map((groupsResp.groups ?? []).map((group) => [group.id, group.name]))
  orgList = Array.isArray(orgsResp) ? orgsResp : (orgsResp.orgs ?? [])
  userList = usersResp.users ?? []
  shareLinkPolicy = policyResp
}

/** 组织下拉选项：value=orgId（改名不漂移），label=完整路径。 */
function orgOptions() {
  const byId = new Map(orgList.map((org) => [org.id, org]))
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
  return orgList.map((org) => ({ value: org.id, label: pathOf(org) })).sort((a, b) => a.label.localeCompare(b.label, 'zh'))
}

const userOptions = () => userList.map((u) => ({
  value: u.id,
  label: rqI18n.t('{name}{org}', { name: u.displayName, org: u.orgName ? `（${u.orgName}）` : '' }),
  group: u.status === 'active' ? '在职' : '非在职',
}))

function renderBody() {
  const body = $('#az-body')
  body.innerHTML = `
    <div class="az-topgrid">
      <div class="card az-card" id="az-gates"></div>
      <div class="card az-card" id="az-matrix"></div>
    </div>
    <div class="card az-card az-mt" id="az-exceptions"></div>
    <div class="card az-card az-mt" id="az-share-link"></div>
    <div class="az-grid2 az-mt">
      <div class="card az-card" id="az-cgroups"></div>
      <div class="card az-card" id="az-anchors"></div>
    </div>
    <div class="card az-card az-mt" id="az-decisions"></div>`

  renderGates()
  renderMatrix()
  renderExceptions()
  renderShareLink()
  renderCGroups()
  renderAnchors()
  renderDecisions()
}

// -- 灰度开关 ---------------------------------------------------------------

function renderGates() {
  const holder = $('#az-gates')
  const canWrite = session.can('nas.authz.write')
  const gate = (key, label, desc) => `
    <div class="az-gate ${rules[key] ? 'on' : ''}">
      <div class="az-grow">
        <div class="az-gate-name">${label}</div>
        <div class="az-gate-desc">${desc}</div>
      </div>
      ${canWrite
        ? `<button class="btn btn-sm ${rules[key] ? 'btn-warning' : 'btn-default'}" data-gate="${key}">${rules[key] ? '已开启' : '已关闭'}</button>`
        : `<span class="fs-11 text-3" title="需要 nas.authz.write 权限">${rules[key] ? '已开启' : '已关闭'}（只读）</span>`}
    </div>`
  holder.innerHTML = `
    <div class="az-card-head">
      <div class="az-grow">
        <div class="az-card-title">灰度开关</div>
        <div class="az-card-sub">version ${rules.version} · ${esc(rqI18n.t('最近更新：{by}{at}', { by: rules.updatedBy ? esc(rules.updatedBy) : '—', at: rules.updatedAt ? ` · ${timeAgo(rules.updatedAt)}` : '' }))}</div>
      </div>
      <span class="badge no-dot ${rules.observeOnly ? 'badge-warn' : 'badge-ok'}">${rules.observeOnly ? '观察模式' : '强制执行'}</span>
    </div>
    ${gate('observeOnly', '观察模式 observeOnly', 'deny 只告警不拦截（G0）；关闭后网关/hermes 按判定强制执行')}
    ${gate('degradeAllToReadonly', '全量降级只读 degradeAllToReadonly', '所有 allow 视作 readonly（G3 应急降级）')}
    <div class="az-card-sub az-meta">开关修改即时生效并升版本留痕；判定依据以版本号对齐审计记录。</div>`

  $$('#az-gates [data-gate]').forEach((btn) => {
    btn.onclick = async () => {
      const key = btn.dataset.gate
      const next = !rules[key]
      if (key === 'degradeAllToReadonly' && next) {
        const confirmed = await confirmDialog({ title: '开启全量降级只读', message: '开启后所有用户写类操作将被拒绝（应急降级 G3）。确认开启？', danger: true, confirmText: '开启降级' })
        if (!confirmed) return
      }
      try {
        rules = await api.put('/api/nas/authz/rules', { ifVersion: rules.version, [key]: next })
        toast(rqI18n.t(next ? '已开启（version {v}）' : '已关闭（version {v}）', { v: rules.version }), 'success')
        renderBody()
      } catch (error) {
        toast(error.message, 'error')
      }
    }
  })
}

// -- 分享链接档位策略（签名分享链接的有效期上限与永久档开关） --------------------

const TIER_LABEL = { '1h': '1 小时', '24h': '24 小时', '7d': '7 天', '30d': '30 天' }

function renderShareLink() {
  const holder = $('#az-share-link')
  if (!holder) return
  // 无 nas.authz.read 时策略读不到：该组只读展示缺席原因，不硬编码猜测
  if (!shareLinkPolicy) {
    holder.innerHTML = `
      <div class="az-card-head">
        <div class="az-grow">
          <div class="az-card-title">分享链接档位</div>
          <div class="az-card-sub">需要 nas.authz.read 权限查看</div>
        </div>
      </div>`
    return
  }
  const policy = shareLinkPolicy
  const canWrite = session.can('nas.authz.write')
  const maxTtlDays = Math.round(policy.maxTtlSec / 86400)
  const presets = (policy.presets ?? []).map((item) => item.label).join(' / ')
  const secret = policy.secret ?? {}
  const keyState = secret.available
    ? `<span class="badge no-dot badge-ok">可用</span><code class="az-uid">${esc(secret.keyId ?? '')}</code>`
    : `<span class="badge no-dot badge-danger">不可用</span><span class="az-reason">${esc(secret.error ?? '未加载')}</span>`
  holder.innerHTML = `
    <div class="az-card-head">
      <div class="az-grow">
        <div class="az-card-title">分享链接档位</div>
        <div class="az-card-sub">${esc(rqI18n.t('NAS「复制下载链接」的有效期策略：上限与永久档开关。档位 {presets}', { presets }))}${esc(rqI18n.t('；不在档位内的值为自定义时长（须显式传 ttlSec）。'))}</div>
      </div>
      <span class="badge no-dot ${policy.allowPermanent ? 'badge-warn' : 'badge-muted'}">${policy.allowPermanent ? '永久档已开启' : '永久档已关闭'}</span>
    </div>
    <div class="az-gate ${policy.allowPermanent ? 'on' : ''}">
      <div class="az-grow">
        <div class="az-gate-name">永久档位 allowPermanent</div>
        <div class="az-gate-desc">关闭时前端「永久」选项置灰并提示「管理员未开启永久档位」，服务端同时拒绝签发（策略开关优先于权限点）。开启后须持 ${esc(policy.permanentPermission)} 才能签发永久链接。</div>
      </div>
      <button class="btn btn-sm ${canWrite ? (policy.allowPermanent ? 'btn-warning' : 'btn-default') : 'btn-default'}" id="az-sl-toggle" ${canWrite ? '' : 'disabled title="需要 nas.authz.write 权限"'}>${policy.allowPermanent ? '点击关闭' : '点击开启'}</button>
    </div>
    <div class="az-gate">
      <div class="az-grow">
        <div class="az-gate-name">有效期上限 maxTtlSec</div>
        <div class="az-gate-desc">签发时 ttlSec 超过此值会被明确拒绝（不回落到上限）。${esc(rqI18n.t('当前 {d} 天（{s} 秒）。', { d: maxTtlDays, s: policy.maxTtlSec }))}</div>
      </div>
      <button class="btn btn-sm btn-default" id="az-sl-max" ${canWrite ? '' : 'disabled title="需要 nas.authz.write 权限"'}>调整上限</button>
    </div>
    <div class="az-gate">
      <div class="az-grow">
        <div class="az-gate-name">签发资格 permanentPermission</div>
        <div class="az-gate-desc">可签发永久链接的权限点。当前：<code class="az-uid">${esc(policy.permanentPermission)}</code>（改小会放宽放权面，务必谨慎）。</div>
      </div>
      <button class="btn btn-sm btn-default" id="az-sl-perm" ${canWrite ? '' : 'disabled title="需要 nas.authz.write 权限"'}>调整权限点</button>
    </div>
    <div class="az-gate">
      <div class="az-grow">
        <div class="az-gate-name">独立签名密钥</div>
        <div class="az-gate-desc">${esc(rqI18n.t('与登录令牌密钥隔离，轮换不影响已发出的链接（旧钥永久保留验签，退役 {n} 份）。密钥文件不可读时拒绝签发（fail-closed）。', { n: secret.retiredCount ?? 0 }))}</div>
      </div>
      <div class="flex" style="gap:6px;align-items:center">${keyState}<button class="btn btn-sm btn-default" id="az-sl-rotate" ${canWrite ? '' : 'disabled title="需要 nas.authz.write 权限"'}>轮换</button></div>
    </div>
    <div class="az-card-sub az-meta">永久链接在权限回收或手动吊销前长期有效；每次取流实时复核签发人数据权限，可在 NAS 文件浏览「链接管理」中吊销。放权动作（开启永久档/调整权限点）经 changeLog 留痕。</div>`

  $('#az-sl-toggle').onclick = async () => {
    const next = !policy.allowPermanent
    if (next) {
      const confirmed = await confirmDialog({
        title: '开启永久档位', danger: true, confirmText: '确认开启',
        message: `开启后，持 <code>${esc(policy.permanentPermission)}</code>${esc(rqI18n.t(' 的用户可签发<b>永久有效</b>的下载链接（权限回收或吊销前长期可用）。按 A0–A3 阶梯，建议先以关闭态运行观测证据再放开。确认开启？'))}`,
      })
      if (!confirmed) return
    }
    try {
      await api.put('/api/nas/authz/share-link-policy', { allowPermanent: next })
      toast(rqI18n.t(next ? '永久档已开启' : '永久档已关闭'), 'success')
      shareLinkPolicy = await api.get('/api/nas/authz/share-link-policy').catch(() => shareLinkPolicy)
      renderBody()
    } catch (error) { toast(error.message, 'error') }
  }
  $('#az-sl-max').onclick = () => openShareLinkPolicyEditor('maxTtlSec')
  $('#az-sl-perm').onclick = () => openShareLinkPolicyEditor('permanentPermission')
  $('#az-sl-rotate').onclick = async () => {
    const confirmed = await confirmDialog({
      title: '轮换签名密钥', requireReason: true, danger: true, confirmText: '确认轮换',
      message: '轮换后新签发的链接用新密钥；<b>旧密钥永久保留验签</b>，已发出的链接不受影响。密钥材料泄露时请轮换，并配合吊销收敛。',
    })
    if (!confirmed) return
    try {
      const result = await api.post('/api/nas/authz/share-link-secret/rotate', { note: confirmed.reason })
      toast(rqI18n.t('已轮换：新密钥 {key}，退役 {n} 份', { key: result.keyId, n: result.retiredCount }))
      shareLinkPolicy = await api.get('/api/nas/authz/share-link-policy').catch(() => shareLinkPolicy)
      renderBody()
    } catch (error) { toast(error.message, 'error') }
  }
}

function openShareLinkPolicyEditor(fieldKey) {
  const policy = shareLinkPolicy
  const isMax = fieldKey === 'maxTtlSec'
  const modal = openModal({
    title: isMax ? '调整有效期上限' : '调整签发资格',
    body: isMax
      ? `${field('上限（天）', inputField('value', { value: String(Math.round(policy.maxTtlSec / 86400)) }), { required: true, hint: '签名链接可设置的最长有效期；超过即拒绝签发（不回落）。默认 30 天。' })}`
      : `${field('权限点', inputField('value', { value: policy.permanentPermission }), { required: true, hint: '可签发永久链接的权限点。默认 nas.authz.write（管理员级）。' })}`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>',
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async () => {
    const raw = collectForm(modal.body).value
    if (!raw) return toast(rqI18n.t('请填写值'), 'error')
    try {
      await api.put('/api/nas/authz/share-link-policy', isMax ? { maxTtlSec: Math.round(Number(raw) * 86400) } : { permanentPermission: String(raw).trim() })
      toast(rqI18n.t('已保存'))
      modal.close()
      shareLinkPolicy = await api.get('/api/nas/authz/share-link-policy').catch(() => shareLinkPolicy)
      renderBody()
    } catch (error) { toast(error.message, 'error') }
  }
}

// -- 操作矩阵 ---------------------------------------------------------------

function renderMatrix() {
  const holder = $('#az-matrix')
  const cell = (role, op) => {
    const override = rules.matrixOverrides?.[role]?.[op]
    const base = MATRIX_DEFAULT[role][op]
    const value = typeof override === 'boolean' ? override : Boolean(base)
    const title = typeof override === 'boolean' ? rqI18n.t('覆盖自内置 {mark}', { mark: base ? '✓' : '✗' }) : '内置默认'
    return `<td class="col-num" title="${title}"><span class="${value ? 'az-mark-ok' : 'az-mark-no'}">${value ? '✓' : '✗'}</span></td>`
  }
  holder.innerHTML = `
    <div class="az-card-head">
      <div class="az-grow">
        <div class="az-card-title">操作矩阵</div>
        <div class="az-card-sub">内置默认 + 覆盖项。readonly 语义 = read/download 放行、写类拒绝；admin 为平台规则管理权限点，网关侧恒 deny。</div>
      </div>
      <span class="badge no-dot badge-muted">${rules.matrixOverrides && Object.keys(rules.matrixOverrides).length ? '含覆盖项' : '默认矩阵'}</span>
    </div>
    <div class="az-table-box">
      <table class="tbl az-matrix">
        <thead><tr><th>角色</th>${OPS.map((op) => `<th>${OP_LABEL[op]}</th>`).join('')}</tr></thead>
        <tbody>
          ${ROLES.map((role) => `<tr><td class="az-role-cell"><span class="az-role-tag">${role}</span>${ROLE_LABEL[role].slice(2)}</td>${OPS.map((op) => cell(role, op)).join('')}</tr>`).join('')}
          <tr class="az-matrix-crow"><td class="az-role-cell"><span class="az-role-tag az-role-tag-c">C</span>跨域只读(叠加)</td><td colspan="7" class="az-matrix-cnote">read/download 放行（跨域），写类一律拒绝；白名单目录写需显式例外</td></tr>
        </tbody>
      </table>
    </div>`
}

// -- 例外列表 ---------------------------------------------------------------

function expireCountdown(iso) {
  if (!iso) return '<span class="text-4">永久</span>'
  const rest = new Date(iso).getTime() - Date.now()
  if (rest <= 0) return '<span class="badge no-dot badge-danger">已过期</span>'
  const days = Math.floor(rest / 86_400_000)
  const hours = Math.floor((rest % 86_400_000) / 3_600_000)
  return `<span class="az-expire">${esc(rqI18n.t('{d}天{h}时后到期', { d: days, h: hours }))}</span>`
}

function renderExceptions() {
  const holder = $('#az-exceptions')
  const items = rules.exceptions ?? []
  const canManage = session.can('nas.authz.write')
  holder.innerHTML = `
    <div class="az-card-head">
      <div class="az-grow">
        <div class="az-card-title">资源级例外</div>
        <div class="az-card-sub">显式 allow / deny，可过期；优先级高于角色矩阵。用于 C 跨域白名单写、临时授权、share 审批产物等。</div>
      </div>
      <div class="az-head-actions">
        <span class="badge no-dot badge-muted">${esc(rqI18n.t('{n} 条', { n: items.length }))}</span>
        ${canManage ? `<button class="btn btn-sm btn-primary" id="az-exc-add">${icon('plus', 12)}新建例外</button>` : ''}
      </div>
    </div>
    <div id="az-exc-table"></div>`
  const table = $('#az-exc-table')
  if (!items.length) {
    table.appendChild(emptyState({ title: '暂无例外', desc: '例外用于显式拒绝/授权：C 跨域白名单写、临时授权、share 审批产物等', icon: 'shield' }))
  } else {
    table.appendChild(renderTable({
      columns: [
        { title: '效果', width: 84, render: (item) => item.effect === 'allow' ? '<span class="badge no-dot badge-ok">放行</span>' : '<span class="badge no-dot badge-danger">拒绝</span>' },
        { title: 'NAS / 路径', render: (item) => `<div class="az-cell-main">${esc(nasName(item.nasId))}</div><div class="az-path" title="${esc(item.path)}">${esc(item.path)}</div>` },
        { title: '操作', render: (item) => `<span class="az-ops">${item.ops.map((op) => `<span class="az-op">${OP_LABEL[op] ?? op}</span>`).join('')}</span>` },
        { title: '限定用户', render: (item) => `<span class="fs-12">${item.userIds?.length ? `<span class="az-users">${item.userIds.map((id) => `<code class="az-uid">${esc(id)}</code>`).join('')}</span>` : '<span class="text-4">全部用户</span>'}</span>` },
        { title: '有效期', width: 130, render: (item) => expireCountdown(item.expiresAt) },
        { title: '事由', render: (item) => `<span class="az-reason">${esc(item.note ?? '—')}</span>` },
        ...(canManage ? [{ title: '', width: 60, render: (item) => `<button class="btn btn-sm btn-default" data-del="${esc(item.id)}">删除</button>` }] : []),
      ],
      rows: items,
    }))
  }
  const excAddBtn = $('#az-exc-add')
  if (excAddBtn) excAddBtn.onclick = () => openExceptionEditor()
  $$('#az-exc-table [data-del]').forEach((btn) => {
    btn.onclick = async () => {
      const confirmed = await confirmDialog({ title: '删除例外', message: rqI18n.t('删除例外 {id}？删除立即生效并升版本留痕。', { id: btn.dataset.del }), danger: true })
      if (!confirmed) return
      try {
        rules = await api.put('/api/nas/authz/rules', { ifVersion: rules.version, exceptions: rules.exceptions.filter((item) => item.id !== btn.dataset.del) })
        toast(rqI18n.t('例外已删除'), 'success')
        renderBody()
      } catch (error) { toast(error.message, 'error') }
    }
  })
}

function openExceptionEditor(existing) {
  const modal = openModal({
    title: existing ? '编辑例外' : '新建例外',
    wide: true,
    body: `
      ${selectField('effect', [{ value: 'deny', label: 'deny（显式拒绝）' }, { value: 'allow', label: 'allow（显式授权）' }], { value: existing?.effect ?? 'deny' })}
      <div class="form-item">
        <label class="form-label">NAS 资产<span class="req">*</span></label>
        ${searchableSelectField('nasId', nasList.map((item) => ({ value: item.id, label: rqI18n.t('{name}（{id}）', { name: item.name, id: item.id }) })), { value: existing?.nasId ?? '', placeholder: '点击选择 NAS 资产' })}
      </div>
      <div class="form-item">
        <label class="form-label">路径前缀<span class="req">*</span></label>
        ${inputField('path', { placeholder: '/路径前缀，/* 结尾通配子树，* 通配全部', value: existing?.path ?? '', lg: true })}
      </div>
      <div class="form-item">
        <label class="form-label">操作<span class="req">*</span></label>
        <div class="az-ops-picker">${OPS.map((op) => `
          <label class="az-op-check"><input type="checkbox" data-op="${op}" ${(existing?.ops ?? []).includes(op) ? 'checked' : ''}>${OP_LABEL[op]}<code>${op}</code></label>`).join('')}
        </div>
      </div>
      <div class="form-item">
        <label class="form-label">限定用户</label>
        ${multiSelectField('userIds', userOptions(), { values: existing?.userIds ?? [], placeholder: '搜索姓名添加限定用户；留空 = 对全部用户生效' })}
      </div>
      ${inputField('expiresAt', { placeholder: '到期时间 ISO（可选，如 2026-09-30T00:00:00Z）', value: existing?.expiresAt ?? '' })}
      ${inputField('note', { placeholder: '事由（审计留痕）', value: existing?.note ?? '' })}`,
    foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" id="az-exc-save">保存</button>`,
  })
  mountSearchableSelects(modal.el)
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('#az-exc-save').onclick = async () => {
    const read = (name) => modal.body.querySelector(`[name="${name}"]`)?.value?.trim() ?? ''
    const ops = [...modal.body.querySelectorAll('[data-op]:checked')].map((el) => el.dataset.op)
    const record = {
      ...(existing ? { id: existing.id } : {}),
      effect: read('effect') || 'deny',
      nasId: read('nasId'),
      path: read('path'),
      ops,
      ...(read('userIds') ? { userIds: read('userIds').split(',').map((item) => item.trim()).filter(Boolean) } : {}),
      ...(read('expiresAt') ? { expiresAt: read('expiresAt') } : {}),
      ...(read('note') ? { note: read('note') } : {}),
    }
    if (!record.nasId || !record.path || record.ops.length === 0) {
      toast(rqI18n.t('nasId / path / ops 必填'), 'error')
      return
    }
    try {
      rules = await api.put('/api/nas/authz/rules', { ifVersion: rules.version, exceptions: [...rules.exceptions.filter((item) => item.id !== record.id), record] })
      modal.close()
      toast(rqI18n.t('例外已保存'), 'success')
      renderBody()
    } catch (error) { toast(error.message, 'error') }
  }
}

// -- C 关联动态组 -----------------------------------------------------------

function renderCGroups() {
  const holder = $('#az-cgroups')
  const items = (rules.cGroups ?? []).map((id) => ({ id, name: groupNames.get(id) ?? id }))
  const canManage = session.can('nas.authz.write')
  holder.innerHTML = `
    <div class="az-card-head">
      <div class="az-grow">
        <div class="az-card-title">C 角色关联动态用户组</div>
        <div class="az-card-sub">组内成员获得跨域只读（read/download）；组重算漂移任何幅度都会发 cGroupDrift 告警。</div>
      </div>
      <div class="az-head-actions">
        <span class="badge no-dot badge-muted">${esc(rqI18n.t('{n} 组', { n: items.length }))}</span>
        ${canManage ? `<button class="btn btn-sm btn-default" id="az-cg-add">${icon('plus', 12)}关联组</button>` : ''}
      </div>
    </div>
    <div id="az-cg-list">${items.length ? items.map((item) => `
      <div class="az-cg-item">
        <span class="az-cg-name">${esc(item.name)}</span>
        ${canManage ? `<button class="btn btn-sm btn-default" data-cg="${esc(item.id)}">移除</button>` : ''}
      </div>`).join('') : '<div class="az-empty-line">尚未关联动态组</div>'}</div>`

  const cgAddBtn = $('#az-cg-add')
  if (cgAddBtn) cgAddBtn.onclick = () => {
    // 已关联值可能是组名或组 id，统一按名字去重
    const linkedNames = new Set((rules.cGroups ?? []).map((v) => groupNames.get(v) ?? v))
    const options = [...new Set([...groupNames.values()])]
      .filter((name) => !linkedNames.has(name))
      .map((name) => ({ value: name, label: name }))
    const modal = openModal({
      title: '关联 C 角色动态用户组',
      body: `
        <div class="form-item">
          <label class="form-label">动态用户组</label>
          ${options.length
            ? searchableSelectField('groupName', options, { placeholder: '点击选择用户组（按组名解析）' })
            : '<div class="az-empty-line">暂无可选用户组，请先在「组织与账号 → 用户组」创建</div>'}
        </div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" id="az-cg-save" ' + (options.length ? '' : 'disabled') + '>关联</button>',
    })
    mountSearchableSelects(modal.el)
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('#az-cg-save').onclick = async () => {
      const name = modal.body.querySelector('[name="groupName"]')?.value?.trim()
      if (!name) { toast(rqI18n.t('请选择用户组'), 'error'); return }
      try {
        rules = await api.put('/api/nas/authz/rules', { ifVersion: rules.version, cGroups: [...rules.cGroups ?? [], name] })
        modal.close()
        await loadAll()
        renderBody()
        toast(rqI18n.t('已关联（按组名解析）'), 'success')
      } catch (error) { toast(error.message, 'error') }
    }
  }
  $$('#az-cg-list [data-cg]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        rules = await api.put('/api/nas/authz/rules', { ifVersion: rules.version, cGroups: (rules.cGroups ?? []).filter((id) => id !== btn.dataset.cg) })
        toast(rqI18n.t('已移除'), 'success')
        renderBody()
      } catch (error) { toast(error.message, 'error') }
    }
  })
}

// -- NAS 接入组织锚点 -------------------------------------------------------

function renderAnchors() {
  const holder = $('#az-anchors')
  holder.innerHTML = `
    <div class="az-card-head">
      <div class="az-grow">
        <div class="az-card-title">NAS 接入组织锚点</div>
        <div class="az-card-sub">orgRoot = 平台级组织名或 orgId，作用域推导锚点；orgPathOverrides = orgId → 目录前缀映射，优先于名字推导（组织改名不漂移）。</div>
      </div>
        <span class="badge no-dot badge-muted">${esc(rqI18n.t('{n} 资产', { n: nasList.length }))}</span>
    </div>
    <div id="az-anchor-list"></div>`
  const list = $('#az-anchor-list')
  if (!nasList.length) {
    list.appendChild(emptyState({ title: '暂无 NAS 资产', desc: '先在 NAS 存储页纳管资产', icon: 'server' }))
    return
  }
  list.appendChild(renderTable({
    columns: [
      { title: '资产', render: (item) => `<div class="az-cell-main">${esc(item.name)}</div><div class="az-path" title="${esc(item.id)}">${esc(item.id)}</div>` },
      { title: 'orgRoot 组织锚点', render: (item) => item.attrs?.orgRoot
        ? `<code class="az-uid">${esc(item.attrs.orgRoot)}</code>`
        : '<span class="badge no-dot badge-danger">未配置 · 全 deny</span>' },
      { title: 'orgPathOverrides 目录映射', render: (item) => {
        const raw = item.attrs?.orgPathOverrides
        const text = typeof raw === 'string' && raw.trim() ? raw : (raw && typeof raw === 'object' ? JSON.stringify(raw) : '')
        return text
          ? `<span class="az-path" style="max-width:220px" title="${esc(text)}">${esc(text)}</span>`
          : '<span class="text-4">—</span>'
      } },
      // 锚点编辑是写操作（PUT rules）：无写点的账号（含演示访客）不渲染编辑入口，行点击也不开编辑器
      ...(session.can('nas.authz.write') ? [{ title: '', width: 70, render: () => '<button class="btn btn-sm btn-default" data-edit="1">编辑</button>' }] : []),
    ],
    rows: nasList,
    ...(session.can('nas.authz.write') ? { onRowClick: (id) => openAnchorEditor(nasList.find((item) => item.id === id)) } : {}),
  }))
  $$('#az-anchor-list [data-edit]').forEach((btn, index) => {
    btn.onclick = (event) => {
      event.stopPropagation()
      openAnchorEditor(nasList[index])
    }
  })
}

function openAnchorEditor(nas) {
  const raw = nas?.attrs?.orgPathOverrides
  const overridesText = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? JSON.stringify(raw, null, 2) : '')
  const modal = openModal({
    title: rqI18n.t('接入组织锚点：{name}', { name: nas?.name ?? '' }),
    body: `
      <div class="fs-11 text-4" style="margin-bottom:8px">orgRoot = 平台级组织锚点（作用域推导）；orgPathOverrides = orgId → 目录前缀映射，优先于锚点推导（组织改名不漂移）。</div>
      <div class="form-item">
        <label class="form-label">orgRoot 组织锚点</label>
        ${orgList.length
          ? searchableSelectField('orgRoot', orgOptions(), { value: nas?.attrs?.orgRoot ?? '', placeholder: '点击选择组织；留空 = 该 NAS 全 deny', emptyLabel: '（留空 = 该 NAS 全 deny）' })
          : inputField('orgRoot', { placeholder: '如「智造平台」；留空 = 该 NAS 全 deny', value: nas?.attrs?.orgRoot ?? '' })}
      </div>
      ${textareaField('orgPathOverrides', { placeholder: '{"org_xxx": "/生产"}', value: overridesText, rows: 4 })}`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" id="az-anchor-save">保存</button>',
  })
  mountSearchableSelects(modal.el)
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('#az-anchor-save').onclick = async () => {
    const orgRoot = modal.body.querySelector('[name="orgRoot"]')?.value?.trim() ?? ''
    const overrides = modal.body.querySelector('[name="orgPathOverrides"]')?.value?.trim() ?? ''
    if (overrides && !overrides.trim().startsWith('{')) {
      toast(rqI18n.t('orgPathOverrides 必须是 JSON 对象'), 'error')
      return
    }
    try {
      await api.patch(`/api/nas/${nas.id}`, { attrs: { orgRoot, ...(overrides ? { orgPathOverrides: overrides } : { orgPathOverrides: '' }) } })
      modal.close()
      await loadAll()
      renderBody()
      toast(rqI18n.t('锚点已更新'), 'success')
    } catch (error) { toast(error.message, 'error') }
  }
}

// -- 判定留痕 ---------------------------------------------------------------

async function renderDecisions() {
  const holder = $('#az-decisions')
  holder.innerHTML = `
    <div class="az-card-head">
      <div class="az-grow">
        <div class="az-card-title">判定留痕</div>
        <div class="az-card-sub">deny 全量 + delete/share/admin 高危；普通记录 90 天滚动、高危永久。</div>
      </div>
      <button class="btn btn-sm btn-default" id="az-dec-refresh">${icon('refresh', 12)}刷新</button>
    </div>
    <div id="az-dec-table"><div class="fs-12 text-4">加载中…</div></div>`
  $('#az-dec-refresh').onclick = () => { void renderDecisions() }
  const data = await api.get('/api/nas/authz/decisions?limit=50').catch(() => ({ items: [] }))
  const table = $('#az-dec-table')
  // 异步回来时视图可能已被切走（测试容器重建/快速路由切换）：节点不在即放弃本次落表
  if (!table) return
  table.innerHTML = ''
  const items = data.items ?? []
  if (!items.length) {
    table.appendChild(emptyState({ title: '暂无判定留痕', desc: 'deny 与高危操作判定会异步落痕', icon: 'scroll' }))
    return
  }
  const wrap = h('<div class="az-scroll"></div>')
  wrap.appendChild(renderTable({
    columns: [
      { title: '时间', width: 96, render: (item) => `<span class="fs-12 text-4">${timeAgo(item.createdAt)}</span>` },
      { title: '判定', width: 84, render: (item) => item.decision === 'allow' ? '<span class="badge no-dot badge-ok">放行</span>' : '<span class="badge no-dot badge-danger">拒绝</span>' },
      { title: '用户 / 角色', width: 150, render: (item) => `<span class="az-cell-main">${esc(item.userName ?? item.userId)}</span><span class="fs-11 text-3">${item.role ? esc(rqI18n.t('{role}{w}', { role: item.role, w: item.override ? rqI18n.t('（破窗）') : '' })) : '无主角色'}</span>` },
      { title: 'NAS / 路径', render: (item) => `<div class="az-cell-main">${esc(nasName(item.nasId))}</div><div class="az-path" title="${esc((item.paths ?? []).join('、'))}">${esc((item.paths ?? []).join('、'))}</div>` },
      { title: '操作', width: 92, render: (item) => `<span class="fs-12">${OP_LABEL[item.op] ?? item.op}${item.highRisk ? ' <span class="badge no-dot badge-warn">高危</span>' : ''}</span>` },
      { title: '理由', render: (item) => `<span class="az-reason" title="${esc((item.reasons ?? []).join('；'))}">${esc((item.reasons ?? []).join('；'))}</span>` },
    ],
    rows: items,
  }))
  table.appendChild(wrap)
}

// -- 试算与治理工具 ---------------------------------------------------------

function openSimulate() {
  const modal = openModal({
    title: 'check 试算',
    body: `
      <div class="fs-11 text-4" style="margin-bottom:8px">与网关/hermes 强制点同一套判定：输入用户与路径，返回决策、角色、作用域与 reasons。</div>
      <div class="form-item">
        <label class="form-label">NAS 资产</label>
        ${searchableSelectField('nasId', nasList.map((item) => ({ value: item.id, label: rqI18n.t('{name}（{id}）', { name: item.name, id: item.id }) })), { value: nasList[0]?.id ?? '', placeholder: '点击选择 NAS 资产' })}
      </div>
      ${inputField('userId', { placeholder: '平台 userId 或钉钉 userId' })}
      ${inputField('paths', { placeholder: '路径（多条用逗号分隔）', value: '/' })}
      ${selectField('op', OPS.map((op) => ({ value: op, label: OP_LABEL[op] })))}
      <label class="fs-12" style="display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" id="az-sim-override"> override 破窗（需 nas.authz.write，强制留痕）</label>
      <div id="az-sim-result" style="margin-top:10px"></div>`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" id="az-sim-run">判定</button>',
  })
  mountSearchableSelects(modal.el)
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('#az-sim-run').onclick = async () => {
    const read = (name) => modal.body.querySelector(`[name="${name}"]`)?.value?.trim() ?? ''
    const result = modal.body.querySelector('#az-sim-result')
    result.innerHTML = '<div class="fs-12 text-4">判定中…</div>'
    try {
      const data = await api.post('/api/nas/authz/check', {
        nasId: read('nasId'),
        userId: read('userId'),
        paths: read('paths').split(',').map((item) => item.trim()).filter(Boolean),
        op: read('op'),
        ...(modal.body.querySelector('#az-sim-override')?.checked ? { override: true } : {}),
      })
      result.innerHTML = `
        <div class="fs-13" style="font-weight:700">${data.decision === 'allow' ? '<span style="color:var(--ok,#16a34a)">放行（ALLOW）</span>' : '<span style="color:var(--danger,#dc2626)">拒绝（DENY）</span>'}
          <span class="fs-12 text-3">${esc(data.role ? rqI18n.t('角色 {role}', { role: rqI18n.t(ROLE_LABEL[data.role] ?? data.role) }) : rqI18n.t('无主角色'))}${data.cTag ? esc(rqI18n.t(' · C 叠加')) : ''}${data.observeOnly ? esc(rqI18n.t(' · 观察模式')) : ''}</span></div>
        <div class="fs-11 text-4" style="margin:4px 0">${esc(rqI18n.t('作用域：{scope}', { scope: data.scope?.length ? data.scope.map((item) => esc(item)).join('、') : rqI18n.t('（无）') }))}</div>
        ${(data.reasons ?? []).map((reason) => `<div class="fs-11 text-3">· ${esc(reason)}</div>`).join('')}
        <div class="fs-11 text-4" style="margin-top:6px">${esc(rqI18n.t('作用域快照：{json}', { json: JSON.stringify(data.scope ?? []) }))}</div>`
    } catch (error) {
      result.innerHTML = `<div class="fs-12" style="color:var(--danger,#dc2626)">${esc(error.message)}</div>`
    }
  }
}

async function runGovern(path, label) {
  try {
    const data = await api.post(path)
    const rows = data.report ?? data.vacant ?? []
    if (!rows.length) { toast(rqI18n.t('{label}：无发现', { label }), 'success'); return }
    openDrawer({
      title: rqI18n.t('{label}结果（{n}）', { label, n: rows.length }),
      body: `<div>${rows.map((row) => `
        <div style="padding:8px 0;border-bottom:1px solid var(--line,#eee)">
          <div class="fs-12" style="font-weight:600">${esc(row.nasName ?? row.orgName ?? '')}</div>
          ${(row.findings ?? []).map((finding) => `<div class="fs-11 text-3">· ${esc(finding.detail)}</div>`).join('') || '<div class="fs-11 text-4">（无明细）</div>'}
        </div>`).join('')}</div>`,
    })
  } catch (error) {
    toast(error.message, 'error')
  }
}

function nasName(id) {
  return nasList.find((item) => item.id === id)?.name ?? id
}

function hEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// session 引用占位：与其它页面一致的导入形态（未来按用户收敛视图时使用）
void session
