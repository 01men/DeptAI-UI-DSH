/**
 * 落地分诊（统一入口 · 角色路由）：一个入口按身份落地——管理/治理身份进控制台，纯业务身份进部门面板。
 *
 * 规则（见 docs/entry-switching.md）：
 *   resolveLanding(user) === 'panel'   仅当「纯业务身份 + 面板可达」；
 *   其余一律 'console'（含平台管理员/组织管理员/资源管理员/开发者/审计员与自定义管理角色）。
 * 判据是权限点而非角色名：BuiltinRoles 的 member 角色不含任何管理域标记，
 * 其余内置角色经 userPermissions 通配展开后必持有至少一项（iam.user.read / approval.read / audit.read / usage.read）。
 *
 * 本模块保持纯函数 + 常量：Node 可直接导入（selftest 经 landing.test.mjs 直测），不触碰 DOM/localStorage。
 */

/** 管理域标记权限点：持有任一即视为管理/治理身份，落地控制台 */
export const MGMT_MARKERS = Object.freeze([
  'iam.user.read',
  'approval.read',
  'audit.read',
  'usage.read',
])

/** 跨工作台切换偏好键：面板/控制台的显式切换入口写入，分诊尊重既有偏好 */
export const LANDING_PREF_KEY = 'heng_ops_landing'

/** 部门面板可达：panel.read（'*' 全量亦可达） */
export function canPanel(user) {
  const permissions = user?.permissions ?? []
  return permissions.includes('*') || permissions.includes('panel.read')
}

/** 纯业务身份：无任何管理域标记（'*' 全量恒为管理域） */
export function isBusinessOnly(user) {
  const permissions = user?.permissions ?? []
  if (permissions.includes('*')) return false
  return !MGMT_MARKERS.some((point) => permissions.includes(point))
}

/** 分诊决议：'panel' | 'console' */
export function resolveLanding(user) {
  return isBusinessOnly(user) && canPanel(user) ? 'panel' : 'console'
}

/** 裸落地判定：仅「无 hash / #/ / #/dashboard」时分诊，深链刷新与页内导航不受影响 */
export function isBareLanding(hash) {
  const value = String(hash ?? '')
  return value === '' || value === '#/' || value === '#/dashboard'
}

/**
 * 登录回跳地址白名单：仅同源绝对路径（/ 开头且非 //），防 open redirect。
 * 安全审查 P2-1（2026-10-31）：拒绝反斜杠与控制字符——浏览器把 `/\` 归一化为 `//`
 * （协议相对 → 跨源），`%0d%0a`/`\t` 等控制字符可干扰头解析与地址栏语义；
 * 并以 URL 解析复核确认结果仍为本源相对路径（双保险）。
 */
export function sanitizeNext(raw) {
  const value = String(raw ?? '')
  if (!value.startsWith('/') || value.startsWith('//')) return ''
  if (value.includes('\\')) return ''
  if (/[\u0000-\u001f\u007f]/.test(value)) return ''
  try {
    const parsed = new URL(value, 'https://ybkkasi.invalid')
    if (parsed.origin !== 'https://ybkkasi.invalid') return ''
  } catch { return '' }
  return value
}

/**
 * 跨源回跳地址白名单（交接清单 G1）：仅 http(s) 且主机为回环/私网 IP 或 localhost 的绝对 URL。
 * 用途：远程 dsh 面板向导以 ?next=<本机面板地址> 发起宿主登录，登录完成后回跳本机并携带
 * 一次性自助 entry_ticket——白名单挡住「公网地址 + 票据」的 open redirect / 票据外泄面。
 * 公网主机一律拒绝（返回 ''），登录页按无 next 处理（诚实降级，不阻断登录）。
 */
export function sanitizeCrossOriginNext(raw) {
  let parsed
  try { parsed = new URL(String(raw ?? '')) } catch { return '' }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  if (parsed.username || parsed.password) return ''
  const host = parsed.hostname.toLowerCase()
  const isLoopback = host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  const isPrivate = /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
  return isLoopback || isPrivate ? parsed.href : ''
}
