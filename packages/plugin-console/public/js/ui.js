/** 组件库：Toast / Drawer / Modal / 图表 / 徽章 / 空状态 / 表格 / 下拉。 */
import rqI18n from './i18n.js'
import { icon, PATHS } from './icons.js'

// ---------- 基础 DOM 助手 ----------
export function h(html) {
  const tpl = document.createElement('template')
  tpl.innerHTML = html.trim()
  if (tpl.content.children.length > 1) {
    // h() 只返回首个顶层元素，多根内容会被静默丢弃；多元素场景请传字符串给 openModal/openDrawer
    console.warn('h(): 输入含多个顶层元素，仅返回第一个（其余被丢弃，请改用字符串）', tpl.content.children)
  }
  return tpl.content.firstElementChild
}
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}
export function $(selector, root = document) { return root.querySelector(selector) }
export function $$(selector, root = document) { return [...root.querySelectorAll(selector)] }

// ---------- 格式化 ----------
export function fmtNum(value) {
  const n = Number(value ?? 0)
  if (n >= 1e8) {
    if (rqI18n.lang === 'en-US') return `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })}M`
    return rqI18n.t('{v} 亿', { v: (n / 1e8).toFixed(1) })
  }
  if (n >= 1e4) {
    if (rqI18n.lang === 'en-US') return `${(n / 1e3).toLocaleString('en-US', { maximumFractionDigits: 0 })}K`
    return rqI18n.t('{v} 万', { v: (n / 1e4).toFixed(1) })
  }
  return n.toLocaleString('zh-CN')
}
export function fmtCost(value) {
  return `¥${Number(value ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
export function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function timeAgo(iso) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return rqI18n.t('刚刚')
  if (diff < 3600_000) return rqI18n.t('{n} 分钟前', { n: Math.floor(diff / 60_000) })
  if (diff < 86400_000) return rqI18n.t('{n} 小时前', { n: Math.floor(diff / 3600_000) })
  if (diff < 7 * 86400_000) return rqI18n.t('{n} 天前', { n: Math.floor(diff / 86400_000) })
  return fmtTime(iso)
}
export function fmtPct(value) {
  return `${Math.round(Number(value ?? 0) * 1000) / 10}%`
}

// ---------- 状态徽章 ----------
const STATUS_MAP = {
  online: ['badge-ok', '已上线'], published: ['badge-ok', '已上架'], active: ['badge-ok', '正常'], healthy: ['badge-ok', '健康'], ok: ['badge-ok', '成功'],
  gray: ['badge-info', '灰度中'], trial: ['badge-info', '试运行'], pending: ['badge-warn', '待激活'], pending_approval: ['badge-warn', '待审批'],
  verifying: ['badge-info', '验证中'], scanning: ['badge-info', '扫描中'], pending_domain: ['badge-warn', '待领域审批'], pending_security: ['badge-warn', '待安全加签'],
  draft: ['badge-muted', '开发中'], archived: ['badge-muted', '已归档'], deprecated: ['badge-muted', '已弃用'], unknown: ['badge-muted', '未知'],
  degraded: ['badge-warn', '降级'], offline: ['badge-warn', '已下线'], down: ['badge-danger', '不可用'], unhealthy: ['badge-danger', '异常'],
  rejected: ['badge-danger', '已驳回'], error: ['badge-danger', '失败'], denied: ['badge-danger', '拒绝'], frozen: ['badge-danger', '已冻结'],
  deactivated: ['badge-muted', '已注销'], approved: ['badge-ok', '已通过'], executed: ['badge-ok', '已执行'], failed: ['badge-danger', '执行失败'],
  superseded: ['badge-muted', '已收口'],
}
export function statusBadge(status, label) {
  const [cls, text] = STATUS_MAP[status] ?? ['badge-muted', status]
  return `<span class="badge ${cls}">${esc(label ?? text)}</span>`
}
export function resultBadge(result) {
  const map = { ok: ['badge-ok', '成功'], denied: ['badge-danger', '拒绝'], error: ['badge-danger', '异常'] }
  const [cls, text] = map[result] ?? ['badge-muted', result]
  return `<span class="badge ${cls} no-dot">${text}</span>`
}
export function auditTypeBadge(type) {
  const map = { auth: ['badge-brand', '认证'], authz: ['badge-purple', '授权'], invoke: ['badge-info', '调用'], change: ['badge-warn', '变更'] }
  const [cls, text] = map[type] ?? ['badge-muted', type]
  return `<span class="badge ${cls} no-dot">${text}</span>`
}

// ---------- Toast ----------
let toastWrap
export function toast(message, type = 'success') {
  if (!toastWrap) {
    toastWrap = h('<div class="toast-wrap"></div>')
    document.body.appendChild(toastWrap)
  }
  const el = h(`<div class="toast toast-${type}">${icon(type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info')}<span>${esc(message)}</span></div>`)
  toastWrap.appendChild(el)
  setTimeout(() => {
    el.classList.add('out')
    setTimeout(() => el.remove(), 300)
  }, 2600)
}

/**
 * 复制文本到剪贴板。navigator.clipboard 仅在安全上下文（HTTPS/localhost）可用，
 * 控制台常经局域网 HTTP 访问，此时降级为 execCommand 方案。
 */
export function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text)
      .then(() => toast(rqI18n.t('已复制到剪贴板')))
      .catch(() => {
        if (copyTextFallback(text)) toast(rqI18n.t('已复制到剪贴板'))
        else toast(rqI18n.t('复制失败，请手动选择复制'), 'error')
      })
  }
  if (copyTextFallback(text)) toast(rqI18n.t('已复制到剪贴板'))
  else toast(rqI18n.t('复制失败，请手动选择复制'), 'error')
}

/** 非安全上下文下的剪贴板降级：临时 textarea + execCommand('copy')。 */
function copyTextFallback(text) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  ta.remove()
  return ok
}

// ---------- Drawer ----------
/**
 * 抽屉头默认按纯文本渲染 title/sub（安全审查 P1-01，2026-10-31）：名称/描述等数据库字段
 * 此前被直接拼进 innerHTML，攻击者创建含脚本字段名的资源即可在打开详情的管理员浏览器里
 * 执行脚本（存储型 XSS，令牌存于 localStorage 可被读走）。确需富文本（徽标/等宽 span）的
 * 调用方改传 titleHtml / subHtml（内容必须已 esc()），普通字段一律走 title / sub。
 */
export function openDrawer({ title, sub, titleHtml, subHtml, body, foot, wide, onClose }) {
  closeDrawer()
  const mask = h('<div class="drawer-mask"></div>')
  const drawer = h(`
    <div class="drawer ${wide ? 'drawer-wide' : ''}">
      <div class="drawer-head">
        <div class="grow">
          <div class="drawer-title">${titleHtml ?? esc(title ?? '')}</div>
          ${(titleHtml || subHtml || sub) ? `<div class="drawer-sub">${subHtml ?? esc(sub ?? '')}</div>` : ''}
        </div>
        <button class="drawer-close" title="关闭">${icon('x')}</button>
      </div>
      <div class="drawer-body"></div>
      ${foot ? '<div class="drawer-foot"></div>' : ''}
    </div>`)
  const bodyEl = drawer.querySelector('.drawer-body')
  if (typeof body === 'string') bodyEl.innerHTML = body
  else if (body) bodyEl.appendChild(body)
  if (foot) {
    const footEl = drawer.querySelector('.drawer-foot')
    if (typeof foot === 'string') footEl.innerHTML = foot
    else footEl.appendChild(foot)
  }
  const close = () => {
    drawer.classList.remove('show')
    mask.classList.remove('show')
    setTimeout(() => { drawer.remove(); mask.remove(); onClose?.() }, 260)
  }
  drawer.querySelector('.drawer-close').onclick = close
  mask.onclick = close
  document.body.append(mask, drawer)
  requestAnimationFrame(() => { mask.classList.add('show'); drawer.classList.add('show') })
  return { el: drawer, body: bodyEl, close }
}

export function closeDrawer() {
  document.querySelectorAll('.drawer').forEach((el) => el.remove())
  document.querySelectorAll('.drawer-mask').forEach((el) => el.remove())
}

// ---------- Modal ----------
/** openModal 与 openDrawer 同规（P1-01）：title 默认纯文本转义，富文本走 titleHtml（内容须已 esc）。 */
export function openModal({ title, titleHtml, body, foot, wide, onClose }) {
  closeModal()
  const mask = h('<div class="modal-mask"></div>')
  const modal = h(`
    <div class="modal ${wide ? 'modal-lg' : ''}">
      <div class="modal-head"><div class="modal-title">${titleHtml ?? esc(title ?? '')}</div></div>
      <div class="modal-body"></div>
      ${foot ? '<div class="modal-foot"></div>' : '<div style="height:14px"></div>'}
    </div>`)
  const bodyEl = modal.querySelector('.modal-body')
  if (typeof body === 'string') bodyEl.innerHTML = body
  else if (body) bodyEl.appendChild(body)
  if (foot) {
    const footEl = modal.querySelector('.modal-foot')
    if (typeof foot === 'string') footEl.innerHTML = foot
    else footEl.appendChild(foot)
    // 默认行为：foot 按钮点击即关闭；调用方后续绑定的 onclick 会覆盖此默认值
    const cancelBtn = footEl.querySelector('[data-cancel]')
    if (cancelBtn) cancelBtn.onclick = () => close()
    const okBtn = footEl.querySelector('[data-ok]')
    if (okBtn) okBtn.onclick = () => close()
  }
  const close = () => { modal.classList.remove('show'); mask.classList.remove('show'); setTimeout(() => { modal.remove(); mask.remove(); onClose?.() }, 200) }
  mask.onclick = (e) => { if (e.target === mask) close() }
  document.body.appendChild(mask)
  mask.appendChild(modal)
  requestAnimationFrame(() => { mask.classList.add('show'); modal.classList.add('show') })
  return { el: modal, body: bodyEl, close }
}

export function closeModal() {
  document.querySelectorAll('.modal').forEach((el) => el.remove())
  document.querySelectorAll('.modal-mask').forEach((el) => el.remove())
}

/** 确认弹窗（支持必填原因，用于 L4 高危操作）。 */
export function confirmDialog({ title, message, requireReason, danger, confirmText = '确认' }) {
  return new Promise((resolve) => {
    const modal = openModal({
      title,
      body: `
        <div class="muted-box" style="display:flex;gap:10px;align-items:flex-start">
          <span style="color:var(--${danger ? 'danger' : 'warn'});flex-shrink:0;margin-top:1px">${icon('alert', 17)}</span>
          <div>${message}</div>
        </div>
        ${requireReason ? `
        <div class="form-item" style="margin-top:14px;margin-bottom:0">
          <label class="form-label">操作原因<span class="req">*</span></label>
          <textarea class="form-control" id="dlg-reason" placeholder="将写入审计日志，请说明本次操作的业务背景"></textarea>
          <div class="form-hint">高危操作的原因将永久留痕，供审计回溯</div>
        </div>` : ''}`,
      foot: `<button class="btn btn-default" id="dlg-cancel">取消</button>
             <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="dlg-ok">${esc(confirmText)}</button>`,
      onClose: () => resolve(null),
    })
    modal.el.querySelector('#dlg-cancel').onclick = () => { modal.close(); resolve(null) }
    modal.el.querySelector('#dlg-ok').onclick = () => {
      const reason = modal.body.querySelector('#dlg-reason')?.value.trim()
      if (requireReason && !reason) {
        toast(rqI18n.t('请填写操作原因（审计要求）'), 'error')
        return
      }
      modal.close()
      resolve({ ok: true, reason })
    }
  })
}

// ---------- 空状态 ----------
export function emptyState({ title, desc, actionText, onAction, icon: ic = 'box' }) {
  const el = h(`
    <div class="empty">
      <div class="empty-ill">${gradientIll(ic)}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
      ${actionText ? `<button class="btn btn-primary">${icon('plus', 14)}${esc(actionText)}</button>` : ''}
    </div>`)
  if (actionText && onAction) el.querySelector('button').onclick = onAction
  return el
}

function gradientIll(ic) {
  return `
    <svg viewBox="0 0 128 96" width="128" height="96">
      <defs>
        <linearGradient id="eg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#b6e0ee"/><stop offset="1" stop-color="#dceef5"/>
        </linearGradient>
      </defs>
      <rect x="14" y="18" width="100" height="62" rx="10" fill="url(#eg)"/>
      <rect x="24" y="30" width="44" height="7" rx="3.5" fill="#fff" opacity=".9"/>
      <rect x="24" y="43" width="64" height="7" rx="3.5" fill="#fff" opacity=".75"/>
      <rect x="24" y="56" width="52" height="7" rx="3.5" fill="#fff" opacity=".6"/>
      <circle cx="97" cy="61" r="15" fill="#0a5f87" opacity=".14"/>
      <g transform="translate(89,53)" stroke="#0a5f87" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
        ${iconRaw(ic, 16)}
      </g>
    </svg>`
}
function iconRaw(name, size) {
  // 复用 icons 中的 path（避免嵌套 svg）：此处直接内嵌一个子 svg
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PATH_CACHE[name] ?? ''}</svg>`
}
const PATH_CACHE = PATHS

// ---------- SVG 图表 ----------
export function sparkline(values, { width = 220, height = 48, color = '#0a5f87', fill = true } = {}) {
  if (!values?.length) return '<span class="text-4 fs-12">暂无数据</span>'
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const step = values.length > 1 ? width / (values.length - 1) : width
  const points = values.map((v, i) => [i * step, height - 4 - ((v - min) / span) * (height - 10)])
  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  const area = `${line}L${width},${height}L0,${height}Z`
  const gid = 'g' + Math.random().toString(36).slice(2, 8)
  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      ${fill ? `<path d="${area}" fill="url(#${gid})"/>` : ''}
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${points.at(-1)[0]}" cy="${points.at(-1)[1]}" r="3" fill="${color}"/>
    </svg>`
}

export function barChart(items, { width = 560, height = 170, color = '#0a5f87', format = (v) => v } = {}) {
  if (!items?.length) return '<div class="text-4 fs-12" style="padding:20px">暂无数据</div>'
  const max = Math.max(...items.map((i) => i.value), 1)
  const gap = 6
  const barW = Math.max(4, (width - gap * (items.length - 1)) / items.length)
  const bars = items.map((item, i) => {
    const barH = Math.max(2, (item.value / max) * (height - 34))
    const x = i * (barW + gap)
    const y = height - 22 - barH
    const w = barW
    return `
      <rect x="${x}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${color}" opacity="${0.55 + 0.45 * (item.value / max)}">
        <title>${esc(item.label)}: ${esc(format(item.value))}</title>
      </rect>
      ${items.length <= 16 || i % Math.ceil(items.length / 12) === 0 ? `<text x="${x + w / 2}" y="${height - 7}" font-size="9" fill="#8a8f99" text-anchor="middle">${esc(item.label.slice(5))}</text>` : ''}`
  }).join('')
  return `<svg width="100%" viewBox="0 0 ${width} ${height}" style="display:block">${bars}</svg>`
}

export function lineChart(series, { width = 560, height = 170, colors = ['#0a5f87', '#059669', '#f59e0b'], labels = [] } = {}) {
  const all = series.flat()
  if (!all.length) return '<div class="text-4 fs-12" style="padding:20px">暂无数据</div>'
  const max = Math.max(...all, 1)
  const n = Math.max(...series.map((s) => s.length))
  const step = n > 1 ? width / (n - 1) : width
  const paths = series.map((values, si) => {
    const points = values.map((v, i) => [i * step, height - 26 - (v / max) * (height - 44)])
    const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
    return `<path d="${line}" fill="none" stroke="${colors[si % colors.length]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
  }).join('')
  return `<svg width="100%" viewBox="0 0 ${width} ${height}" style="display:block">${paths}</svg>`
}

export function donut(segments, size = 120) {
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1
  const r = size / 2 - 10
  const c = 2 * Math.PI * r
  let offset = 0
  const arcs = segments.map((seg) => {
    const len = (seg.value / total) * c
    const arc = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${seg.color}" stroke-width="12" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(seg.label)}: ${esc(String(seg.value))}</title></circle>`
    offset += len
    return arc
  }).join('')
  return `<svg width="${size}" height="${size}">${arcs}</svg>`
}

// ---------- CIO 仪表盘组件（2026-10-14 设计适配 · 暖纸 + 深青蓝，规格 §3） ----------
// 全部为返回 HTML 字符串的纯函数（chipRow/tabRow 除外，返回带事件绑定的 Element）。
// 图表算法移植自设计稿 components/shared.tsx（坐标/渐变/虚线网格/末点圆点）；
// 中文数字格式沿用上方 fmtNum/fmtCost。SVG 属性不吃 var()，主色用字面量单源：

const BRAND = '#0a5f87'   // --brand-500 深青蓝（换肤双处同步：tokens.css / 本常量）
const GRID_C = '#e0ddd8'  // 虚线网格线（--border）
const TEXT_C = '#706864'  // 坐标轴文字（--text-3）

/** 空态块：虚线边框 + 弱化底。 */
export function emptyHint(text) {
  return `<div class="empty-hint">${esc(text ?? '暂无数据')}</div>`
}

/** 区块标题：{ label, title, extra, actions } → .page-head 结构；actions/title/extra 为 HTML 字符串。 */
export function sectionHead({ label, title, extra, actions } = {}) {
  return `
    <div class="page-head">
      <div class="grow">
        ${label ? `<div class="micro-label" style="margin-bottom:4px">${esc(label)}</div>` : ''}
        <h2 class="page-title">${title ?? ''}</h2>
        ${extra ? `<div class="page-sub">${extra}</div>` : ''}
      </div>
      ${actions ? `<div class="page-head-actions">${actions}</div>` : ''}
    </div>`
}

/** 指标卡：{ label, value, sub, tone }，tone: ''|'warn'|'crit'；value/sub 为 HTML 字符串。 */
export function statCard({ label, value, sub, tone = '' } = {}) {
  return `
    <div class="stat-card">
      <div class="micro-label">${esc(label ?? '')}</div>
      <div class="stat-value${tone ? ' ' + tone : ''}" style="margin-top:6px">${value ?? '—'}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>`
}

const HEALTH_MAP = {
  healthy: ['dot-ok', '健康'],
  warning: ['dot-warn', '关注'],
  critical: ['dot-crit', '熔断'],
  offline: ['dot-off', '离线'],
}
/** 健康红绿灯：health 'healthy'|'warning'|'critical'|'offline' → .dot 组合 + 中文标签。 */
export function healthDot(health, { pulse = false } = {}) {
  const [cls, label] = HEALTH_MAP[health] ?? ['dot-off', health ?? '未知']
  const pulsing = pulse && health === 'critical'
  return `<span style="display:inline-flex;align-items:center;gap:6px">` +
    `<span class="dot ${cls}${pulsing ? ' pulse' : ''}"></span>` +
    `<span class="fs-12 text-3">${esc(label)}</span></span>`
}

const LIFECYCLE_MAP = {
  draft: ['pill-draft', '草稿'],
  online: ['pill-online', '已上线'],
  offline: ['pill-offline', '已下线'],
  archived: ['pill-archived', '已归档'],
  deprecated: ['pill-deprecated', '已弃用'],
}
/** 生命周期徽章：s 'draft'|'online'|'offline'|'archived'|'deprecated'。 */
export function lifecycleBadge(s) {
  const [cls, label] = LIFECYCLE_MAP[s] ?? ['pill', s ?? '未知']
  return `<span class="pill ${cls}">${esc(label)}</span>`
}

const TYPE_MAP = {
  mcp: ['tbadge-mcp', 'MCP 服务'],
  agent: ['tbadge-agent', 'Agent'],
  app: ['tbadge-app', 'AI 应用'],
  skill: ['tbadge-skill', 'Skill'],
  model: ['tbadge-model', '模型路由'],
  nas: ['tbadge-nas', 'NAS 存储'],
}
/** 资产类型徽章：type 'mcp'|'agent'|'app'|'skill'|'model'|'nas'。 */
export function typeBadge(type) {
  const [cls, label] = TYPE_MAP[String(type ?? '').toLowerCase()] ?? ['tbadge', type ?? '未知']
  return `<span class="tbadge ${cls}">${esc(label)}</span>`
}

/** 进度条：percent 0-100；tone ''|'warn'|'ok'；width CSS 宽度；label 单行尾注（如「灰度 40%」）。 */
export function progressBar(percent, { tone = '', width = '80px', label = '' } = {}) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent ?? 0))))
  return `<span style="display:inline-flex;align-items:center;gap:8px">` +
    `<span class="bar" style="width:${esc(width)}"><span class="bar-fill${tone ? ' ' + tone : ''}" style="width:${pct}%"></span></span>` +
    (label ? `<span class="mono tnum text-3" style="font-size:11px">${esc(label)}</span>` : '') +
    `</span>`
}

/** 面积趋势图（带 Y 轴刻度/虚线网格/渐变填充/末点圆点）：{ series, labels, unit, color, height }。 */
export function areaChart({ series, labels = [], unit = '', color = BRAND, height = 180 } = {}) {
  if (!series?.length) return emptyHint('暂无数据')
  const w = 720, h = height, padL = 42, padB = 22, padT = 10, ticks = 4
  const max = Math.max(...series) * 1.12 || 1
  const x = (i) => padL + (i / Math.max(1, series.length - 1)) * (w - padL - 8)
  const y = (v) => padT + (1 - v / max) * (h - padT - padB)
  const d = series.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${d} L${x(series.length - 1).toFixed(1)},${(h - padB).toFixed(1)} L${x(0).toFixed(1)},${(h - padB).toFixed(1)} Z`
  const gid = 'ac' + Math.random().toString(36).slice(2, 8)
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = (max / ticks) * i
    return `<line x1="${padL}" x2="${w - 8}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${GRID_C}" stroke-width="1"${i === 0 ? '' : ' stroke-dasharray="2 4"'}/>` +
      `<text x="${padL - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" fill="${TEXT_C}" font-size="9.5">${esc(fmtNum(Math.round(v)))}</text>`
  }).join('')
  const every = Math.max(1, Math.ceil(labels.length / 7))
  const xLabels = labels.map((l, i) =>
    i % every === 0 ? `<text x="${x(i).toFixed(1)}" y="${h - 6}" text-anchor="middle" fill="${TEXT_C}" font-size="9.5">${esc(String(l))}</text>` : ''
  ).join('')
  const last = series.length - 1
  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;display:block" role="img" aria-label="趋势图">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.16"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.01"/>
      </linearGradient></defs>
      ${grid}
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="${x(last).toFixed(1)}" cy="${y(series[last]).toFixed(1)}" r="3" fill="${color}" stroke="#fff" stroke-width="1.5"/>
      ${xLabels}
      ${unit ? `<text x="${w - 8}" y="12" text-anchor="end" fill="${TEXT_C}" font-size="9.5">${esc(unit)}</text>` : ''}
    </svg>`
}

/** 双序列趋势（实线实际 + 虚线目标）：{ actual, target, labels, unit, color, height }。 */
export function dualTrendChart({ actual = [], target = [], labels = [], unit = '', color = BRAND, height = 200 } = {}) {
  if (!actual.length || !target.length) return emptyHint('暂无数据')
  const w = 720, h = height, padL = 40, padB = 22, padT = 12, ticks = 4
  const max = Math.max(...target, ...actual) * 1.15 || 1
  const x = (i) => padL + (i / Math.max(1, actual.length - 1)) * (w - padL - 10)
  const y = (v) => padT + (1 - v / max) * (h - padT - padB)
  const path = (arr) => arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const gid = 'dg' + Math.random().toString(36).slice(2, 8)
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = (max / ticks) * i
    return `<line x1="${padL}" x2="${w - 10}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${GRID_C}" stroke-width="1"${i === 0 ? '' : ' stroke-dasharray="2 4"'}/>` +
      `<text x="${padL - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" fill="${TEXT_C}" font-size="9.5">${esc(fmtNum(Math.round(v)))}</text>`
  }).join('')
  const xLabels = labels.map((l, i) =>
    i % 2 === 0 ? `<text x="${x(i).toFixed(1)}" y="${h - 6}" text-anchor="middle" fill="${TEXT_C}" font-size="9.5">${esc(String(l))}</text>` : ''
  ).join('')
  const last = actual.length - 1
  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;display:block" role="img" aria-label="双序列趋势图">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.14"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.01"/>
      </linearGradient></defs>
      ${grid}
      <path d="${path(actual)} L${x(last).toFixed(1)},${(h - padB).toFixed(1)} L${x(0).toFixed(1)},${(h - padB).toFixed(1)} Z" fill="url(#${gid})"/>
      <path d="${path(target)}" fill="none" stroke="#938c88" stroke-width="1.4" stroke-dasharray="5 4"/>
      <path d="${path(actual)}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="${x(last).toFixed(1)}" cy="${y(actual[last]).toFixed(1)}" r="3.2" fill="${color}" stroke="#fff" stroke-width="1.5"/>
      ${xLabels}
      ${unit ? `<text x="${w - 10}" y="13" text-anchor="end" fill="${TEXT_C}" font-size="9.5">${esc(unit)}</text>` : ''}
    </svg>`
}

/** 横条排行：items [{ name, value, hint }]，format 默认 fmtNum（中文数字）。 */
export function hBarList(items, { format } = {}) {
  const list = items ?? []
  if (!list.length) return emptyHint('暂无数据')
  const fmt = format ?? ((v) => fmtNum(v))
  const max = Math.max(...list.map((i) => Number(i.value) || 0), 1)
  return `<div style="display:flex;flex-direction:column;gap:10px">` + list.map((it, idx) => `
    <div>
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:4px">
        <span class="ellipsis fs-13" style="min-width:0">
          <span class="mono tnum text-3" style="font-size:11px;margin-right:8px">${String(idx + 1).padStart(2, '0')}</span>${esc(it.name ?? '')}
        </span>
        <span class="tnum mono" style="font-size:12px;white-space:nowrap">${esc(String(fmt(it.value)))}${it.hint != null && it.hint !== '' ? ` <span class="text-4" style="font-size:11px;font-family:var(--font)">${esc(it.hint)}</span>` : ''}</span>
      </div>
      <div class="bar"><span class="bar-fill" style="width:${((Number(it.value) || 0) / max * 100).toFixed(1)}%"></span></div>
    </div>`).join('') + `</div>`
}

/** 带中心数值甜甜圈（区别于上方 donut）：parts [{ label, value, color }]。centerValue 为 HTML 字符串。 */
export function donutCenter(parts, { centerLabel = '', centerValue = '', size = 120 } = {}) {
  const segs = parts ?? []
  if (!segs.length) return emptyHint('暂无数据')
  const total = segs.reduce((s, p) => s + (Number(p.value) || 0), 0) || 1
  const r = 44, c = 2 * Math.PI * r
  let acc = 0
  const arcs = segs.map((p) => {
    const frac = (Number(p.value) || 0) / total
    const arc = `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${p.color}" stroke-width="13" stroke-dasharray="${(frac * c).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-acc * c).toFixed(2)}"/>`
    acc += frac
    return arc
  }).join('')
  const legend = segs.map((p) => `
    <div style="display:flex;align-items:center;gap:8px;font-size:12px">
      <span style="width:8px;height:8px;border-radius:2px;background:${p.color};flex-shrink:0"></span>
      <span class="text-3 ellipsis" style="flex:1;min-width:0">${esc(p.label)}</span>
      <span class="tnum mono">${(((Number(p.value) || 0) / total) * 100).toFixed(1)}%</span>
    </div>`).join('')
  return `
    <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
      <div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0">
        <svg viewBox="0 0 120 120" width="${size}" height="${size}" style="transform:rotate(-90deg)">
          <circle cx="60" cy="60" r="${r}" fill="none" stroke="#f0eeea" stroke-width="13"/>
          ${arcs}
        </svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
          <div class="tnum" style="font-size:18px;font-weight:600;line-height:1.2">${centerValue}</div>
          <div class="text-3" style="font-size:10.5px">${esc(centerLabel)}</div>
        </div>
      </div>
      <div style="min-width:140px;flex:1;display:flex;flex-direction:column;gap:6px">${legend}</div>
    </div>`
}

/** 30 天热力条：values 每日次数（色深 = 当日用量），big 用于详情抽屉大图。 */
export function heatStrip(values, { big = false } = {}) {
  const vals = (values ?? []).map((v) => Number(v) || 0)
  if (!vals.length) return emptyHint('暂无数据')
  const max = Math.max(...vals, 1)
  const cells = vals.map((v, i) => {
    const bg = v === 0 ? '#eae7e1' : `hsl(201 88% ${Math.round(68 - (v / max) * 40)}%)`
    return `<span class="heat-cell" style="background:${bg}" title="${esc(rqI18n.t('第 {i} 天 · {n} 次', { i: i + 1, n: v }))}"></span>`
  }).join('')
  return `<span class="heat-strip${big ? ' big' : ''}">${cells}</span>`
}

/** 过滤胶囊行（返回 Element）：options [{ value, label, count }]，onPick(value)。 */
export function chipRow(options, activeValue, onPick) {
  const el = h('<div class="chips"></div>')
  ;(options ?? []).forEach((opt) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'chip' + (opt.value === activeValue ? ' active' : '')
    btn.innerHTML = `${esc(opt.label ?? '')}${opt.count != null ? `<span class="chip-count tnum">${esc(String(opt.count))}</span>` : ''}`
    btn.onclick = () => onPick?.(opt.value)
    el.appendChild(btn)
  })
  return el
}

/** 分段标签行（返回 Element）：options [{ key, label, badge, badgeTone }]，onPick(key)。 */
export function tabRow(options, activeKey, onPick) {
  const el = h('<div class="tabbar"></div>')
  ;(options ?? []).forEach((opt) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tab' + (opt.key === activeKey ? ' active' : '')
    btn.innerHTML = `${esc(opt.label ?? '')}${opt.badge != null ? `<span class="tab-badge${opt.badgeTone === 'warn' ? ' warn' : ''}">${esc(String(opt.badge))}</span>` : ''}`
    btn.onclick = () => onPick?.(opt.key)
    el.appendChild(btn)
  })
  return el
}

// ---------- 表格 ----------
export function renderTable({ columns, rows, rowKey = (row, i) => row.id ?? i, onRowClick, empty = '暂无数据' }) {
  if (!rows?.length) {
    const el = h('<div class="card"></div>')
    el.appendChild(emptyState({ title: empty, desc: '当前筛选条件下没有匹配记录', icon: 'search' }))
    return el
  }
  const head = columns.map((col) => `<th style="${col.width ? `width:${col.width}` : ''}">${col.title}</th>`).join('')
  const body = rows.map((row, i) => `
    <tr data-key="${esc(String(rowKey(row, i)))}">
      ${columns.map((col) => `<td class="${col.cls ?? ''}">${col.render ? col.render(row, i) : esc(row[col.key])}</td>`).join('')}
    </tr>`).join('')
  const el = h(`
    <div class="card table-wrap">
      <table class="tbl">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`)
  if (onRowClick) {
    el.querySelectorAll('tbody tr').forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest('button, a, input, select, .stop')) return
        onRowClick(rowKey(rowOf(tr, rows, rowKey)), rowOf(tr, rows, rowKey))
      }
    })
  }
  return el
}
function rowOf(tr, rows, rowKey) {
  const key = tr.dataset.key
  return rows.find((row, i) => String(rowKey(row, i)) === key)
}

// ---------- 下拉菜单 ----------
export function attachDropdown(anchorEl, menuBuilder) {
  let menu = null
  const close = (e) => {
    if (menu && !menu.contains(e.target) && !anchorEl.contains(e.target)) {
      menu.remove(); menu = null
      document.removeEventListener('click', close)
    }
  }
  anchorEl.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu) { menu.remove(); menu = null; return }
    menu = h(`<div class="dropdown-menu"></div>`)
    menuBuilder(menu)
    const wrap = anchorEl.closest('.dropdown') ?? anchorEl.parentElement
    wrap.style.position = 'relative'
    wrap.classList.add('dropdown')
    wrap.appendChild(menu)
    document.addEventListener('click', close)
  })
}

// ---------- 表单收集 ----------
export function collectForm(rootEl) {
  const data = {}
  rootEl.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'checkbox') data[el.name] = el.checked
    else data[el.name] = el.value.trim ? el.value.trim() : el.value
  })
  return data
}

export function field(label, inputHtml, { hint, required, full } = {}) {
  return `
    <div class="form-item ${full ? 'full' : ''}">
      <label class="form-label">${esc(label)}${required ? '<span class="req">*</span>' : ''}</label>
      ${inputHtml}
      ${hint ? `<div class="form-hint">${esc(hint)}</div>` : ''}
    </div>`
}

export function inputField(name, { placeholder, value, lg } = {}) {
  return `<input class="input ${lg ? 'input-lg' : ''}" name="${name}" placeholder="${esc(placeholder ?? '')}" value="${esc(value ?? '')}">`
}

export function selectField(name, options, { value } = {}) {
  return `<select class="select" name="${name}">${options.map((opt) =>
    `<option value="${esc(opt.value)}" ${opt.value === value ? 'selected' : ''}>${esc(opt.label)}</option>`).join('')}</select>`
}

// ---------- 可搜索选择器（UI-04：长列表选择，如 150+ 组织） ----------
// 原生 select 无法搜索、无法展示全路径，同名部门极易选错；此组件弹出可过滤的
// 路径列表，选项按 group（如法人）分组展示完整路径。
let pickerSeq = 0
const pickerRegistry = new Map()

/**
 * @param options Array<{ value, label, group? }> — label 建议传完整路径（如「法人 / 部门」）
 * @param opts.emptyLabel 允许空值时的占位项文案（如「（作为顶级组织）」）；不传则必选
 */
export function searchableSelectField(name, options, { value, placeholder = '点击选择，支持搜索', emptyLabel } = {}) {
  const key = `ss${++pickerSeq}`
  pickerRegistry.set(key, { options, emptyLabel, placeholder })
  const selected = options.find((opt) => opt.value === value)
  return `
    <div class="searchable-select" data-sselect="${key}">
      <input type="hidden" name="${esc(name)}" value="${esc(value ?? '')}">
      <input class="input" type="text" readonly data-ss-display placeholder="${esc(placeholder)}" value="${esc(selected?.label ?? '')}" title="${esc(selected?.label ?? '')}">
      <div class="searchable-select-menu" data-ss-menu>
        <div class="searchable-select-search">${icon('search', 14)}<input type="text" data-ss-q placeholder="输入名称或路径关键词过滤"></div>
        <div class="searchable-select-list" data-ss-list></div>
      </div>
    </div>`
}

/** 在容器内激活所有 searchable-select / multi-select（弹窗内容插入 DOM 后调用一次）。 */
let pickerGlobalBound = false
export function mountSearchableSelects(rootEl) {
  // 全局点击关闭只绑一次，避免每次弹窗都向 document 累积监听器
  if (!pickerGlobalBound) {
    pickerGlobalBound = true
    document.addEventListener('click', (e) => {
      document.querySelectorAll('.searchable-select.open').forEach((p) => {
        if (!p.contains(e.target)) p.classList.remove('open')
      })
    })
  }
  rootEl?.querySelectorAll('[data-sselect]').forEach((picker) => {
    const key = picker.dataset.sselect
    const conf = pickerRegistry.get(key)
    pickerRegistry.delete(key)
    if (!conf) return
    if (conf.multi) return mountMultiPicker(picker, conf)
    const hidden = picker.querySelector('[name]')
    const display = picker.querySelector('[data-ss-display]')
    const menu = picker.querySelector('[data-ss-menu]')
    const qEl = picker.querySelector('[data-ss-q]')
    const list = picker.querySelector('[data-ss-list]')
    let lastValue = hidden.value

    const renderList = (keyword) => {
      const kw = (keyword ?? '').trim().toLowerCase()
      const matched = conf.options.filter((opt) => !kw || String(opt.label).toLowerCase().includes(kw) || String(opt.group ?? '').toLowerCase().includes(kw))
      if (!matched.length && !conf.emptyLabel) {
        list.innerHTML = '<div class="searchable-select-empty">没有匹配的选项</div>'
        return
      }
      // 按 group 分组（保持传入顺序），无 group 的归入同一组
      const groups = new Map()
      for (const opt of matched) {
        const g = opt.group ?? ''
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g).push(opt)
      }
      let html = ''
      if (!kw && conf.emptyLabel) {
        html += `<div class="searchable-select-item" data-value="">${esc(conf.emptyLabel)}</div>`
      }
      for (const [group, opts] of groups) {
        if (group) html += `<div class="searchable-select-group">${esc(group)}</div>`
        for (const opt of opts) {
          // 全路径展示：父链弱化、末级名称强调，同名部门一眼可辨
          const label = String(opt.label)
          const cut = label.lastIndexOf(' / ')
          const visual = cut >= 0
            ? `<span class="path-muted">${esc(label.slice(0, cut + 3))}</span>${esc(label.slice(cut + 3))}`
            : esc(label)
          const active = opt.value === lastValue ? ' active' : ''
          html += `<div class="searchable-select-item${active}" data-value="${esc(opt.value)}" title="${esc(label)}">${visual}</div>`
        }
      }
      if (!matched.length) html += '<div class="searchable-select-empty">没有匹配的选项，换个关键词试试</div>'
      list.innerHTML = html
      list.querySelectorAll('.searchable-select-item').forEach((item) => {
        item.onclick = () => {
          const opt = conf.options.find((o) => String(o.value) === item.dataset.value)
          hidden.value = item.dataset.value
          lastValue = item.dataset.value
          display.value = opt?.label ?? ''
          display.title = opt?.label ?? ''
          closeMenu()
        }
      })
      const active = list.querySelector('.searchable-select-item.active')
      if (active) active.scrollIntoView({ block: 'center' })
    }

    const openMenu = () => {
      picker.classList.add('open')
      renderList('')
      qEl.value = ''
      setTimeout(() => qEl.focus(), 0)
    }
    const closeMenu = () => picker.classList.remove('open')
    display.onclick = () => { picker.classList.contains('open') ? closeMenu() : openMenu() }
    qEl.oninput = () => renderList(qEl.value)
    menu.onclick = (e) => e.stopPropagation()
  })
}

// ---------- 多选搜索选择器（绑定主体/限定用户/编排 Agent 等多选场景） ----------
// 选中项以 chip 呈现，框内输入即过滤候选；值以逗号串写入同名 hidden input，
// 与 collectForm / [name=xxx].value 读取模式完全兼容。

/**
 * @param options Array<{ value, label, group? }>
 * @param opts.values 初始选中值数组
 */
export function multiSelectField(name, options, { values = [], placeholder = '搜索并选择，可多选' } = {}) {
  const key = `ms${++pickerSeq}`
  pickerRegistry.set(key, { options, placeholder, multi: true })
  return `
    <div class="searchable-select multi-select" data-sselect="${key}">
      <input type="hidden" name="${esc(name)}" value="${esc(values.map(String).join(','))}">
      <div class="ms-box" data-ms-box>
        <span class="ms-chips" data-ms-chips></span>
        <input class="ms-input" type="text" data-ms-q placeholder="${esc(placeholder)}">
      </div>
      <div class="searchable-select-menu" data-ss-menu>
        <div class="searchable-select-list" data-ss-list></div>
      </div>
    </div>`
}

function mountMultiPicker(picker, conf) {
  const hidden = picker.querySelector('[name]')
  const box = picker.querySelector('[data-ms-box]')
  const chipsEl = picker.querySelector('[data-ms-chips]')
  const inlineQ = picker.querySelector('[data-ms-q]')
  const list = picker.querySelector('[data-ss-list]')
  let selected = hidden.value ? hidden.value.split(',').filter(Boolean) : []

  const labelOf = (v) => conf.options.find((opt) => String(opt.value) === String(v))?.label ?? v

  const renderChips = () => {
    hidden.value = selected.join(',')
    chipsEl.innerHTML = selected.map((v) => `
      <span class="ms-chip" title="${esc(labelOf(v))}">
        <span class="ms-chip-label">${esc(labelOf(v))}</span>
        <button type="button" class="ms-x" data-ms-remove="${esc(v)}" title="移除">${icon('x', 10)}</button>
      </span>`).join('')
    inlineQ.placeholder = selected.length ? '' : (conf.placeholder ?? '搜索并选择，可多选')
    chipsEl.querySelectorAll('[data-ms-remove]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation()
        selected = selected.filter((v) => v !== btn.dataset.msRemove)
        renderChips()
        renderList(inlineQ.value)
      }
    })
  }

  const renderList = (keyword) => {
    if (!conf.options.length) {
      list.innerHTML = '<div class="searchable-select-empty">没有可选项</div>'
      return
    }
    const kw = (keyword ?? '').trim().toLowerCase()
    const matched = conf.options.filter((opt) => !kw || String(opt.label).toLowerCase().includes(kw) || String(opt.group ?? '').toLowerCase().includes(kw))
    if (!matched.length) {
      list.innerHTML = '<div class="searchable-select-empty">没有匹配的选项，换个关键词试试</div>'
      return
    }
    const groups = new Map()
    for (const opt of matched) {
      const g = opt.group ?? ''
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push(opt)
    }
    let html = ''
    for (const [group, opts] of groups) {
      if (group) html += `<div class="searchable-select-group">${esc(group)}</div>`
      for (const opt of opts) {
        const picked = selected.includes(String(opt.value))
        html += `<div class="searchable-select-item${picked ? ' active' : ''}" data-value="${esc(opt.value)}" title="${esc(opt.label)}"><span class="ms-item-check">${picked ? '✓ ' : ''}</span>${esc(opt.label)}</div>`
      }
    }
    list.innerHTML = html
    list.querySelectorAll('.searchable-select-item').forEach((item) => {
      item.onclick = () => {
        const v = item.dataset.value
        selected = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]
        renderChips()
        renderList(inlineQ.value)
      }
    })
  }

  const openMenu = () => {
    picker.classList.add('open')
    renderList(inlineQ.value)
    setTimeout(() => inlineQ.focus(), 0)
  }
  box.onclick = () => { picker.classList.contains('open') ? picker.classList.remove('open') : openMenu() }
  inlineQ.oninput = () => renderList(inlineQ.value)
  picker.querySelector('[data-ss-menu]').onclick = (e) => e.stopPropagation()
  renderChips()
}

export function textareaField(name, { placeholder, value, rows = 3 } = {}) {
  return `<textarea class="form-control" name="${name}" rows="${rows}" placeholder="${esc(placeholder ?? '')}">${esc(value ?? '')}</textarea>`
}

// ---------- 首次访问概念卡（Skill/Agent/MCP/AI 应用术语解释，每模块仅展示一次） ----------
const CONCEPT_SEEN_PREFIX = 'heng_ops_concept_'

/**
 * 模块首次访问时在页头下方显示非阻塞概念卡（一句话定位 + 3 条要点 +「知道了」）。
 * 用内联横幅而非弹窗：弹窗会与页面自身的创建/编辑弹窗产生关闭时序冲突，
 * 且首次用户往往正要去执行操作，非阻塞不打断任务路径。
 * 已读标记存 localStorage；隐私模式下读写失败时静默降级为本次会话不记忆。
 */
export function maybeShowConceptCard(contentEl, key, { icon: ic = 'info', title, subtitle, points }) {
  if (!contentEl) return
  let seen = false
  try { seen = localStorage.getItem(CONCEPT_SEEN_PREFIX + key) === '1' } catch { /* 读取失败视为未读 */ }
  if (seen) return
  const card = h(`
    <div class="concept-banner mb-14">
      <div class="concept-icon">${icon(ic, 22)}</div>
      <div class="grow">
        <div class="concept-title">${esc(rqI18n.t('初次了解 · {title}', { title }))}</div>
        <div class="concept-sub">${esc(subtitle)}</div>
        <ul class="concept-points">${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      </div>
      <button class="btn btn-default btn-sm" data-concept-ok>${esc(rqI18n.t('知道了'))}</button>
    </div>`)
  card.querySelector('[data-concept-ok]').onclick = () => {
    card.remove()
    try { localStorage.setItem(CONCEPT_SEEN_PREFIX + key, '1') } catch { /* 写入失败仅影响下次仍会显示 */ }
  }
  // 调用点位于 innerHTML 赋值之前，挂到微任务保证插入时页面骨架已就绪
  queueMicrotask(() => contentEl.prepend(card))
}

// ---------- 分页 ----------
export function pagination(total, page, pageSize, onPage) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return h('<span></span>')
  const el = h(`
    <div class="flex" style="justify-content:flex-end;margin-top:14px;gap:6px">
      <span class="fs-12 text-3">${esc(rqI18n.t('共 {n} 条', { n: total }))}</span>
      <button class="btn btn-ghost btn-sm" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      <span class="fs-13" style="padding:0 6px">${page} / ${pages}</span>
      <button class="btn btn-ghost btn-sm" data-p="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页 ›</button>
    </div>`)
  el.querySelectorAll('button[data-p]').forEach((btn) => {
    btn.onclick = () => onPage(Number(btn.dataset.p))
  })
  return el
}
