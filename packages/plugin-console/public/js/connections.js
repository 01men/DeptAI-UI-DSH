/**
 * 宿主服务连接管理（docs/frontend-host-switching.md）：控制台默认连本机宿主，
 * 可手动配置其他宿主服务地址（如 http://192.168.0.7:7300），配置过即可一键切换，
 * 切换后整页自动刷新生效（BASE 在 api.js 模块加载时定刻，刷新是应用新连接的唯一途径）。
 *
 * 本模块保持纯函数 + 常量：所有读写经注入的 storage（localStorage 形状），
 * Node 可直接导入（selftest 经 connections.test.mjs 直测），不触碰 DOM。
 * DOM 侧（连接页 UI）在 pages/connections.js；BASE 消费方在 api.js。
 */

/** 连接清单存储键：[{ id, name, base, createdAt }]（不含内置本机连接）。 */
export const CONNECTIONS_KEY = 'heng_ops_connections'
/** 活动连接存储键：连接 id；''/缺省 = 内置本机连接。 */
export const ACTIVE_KEY = 'heng_ops_active_connection'
/** 内置本机连接 id：base 取本页部署前缀（同源），不可删除。 */
export const LOCAL_ID = 'local'

/** 地址规范化：http(s) URL、去尾斜杠、拒绝 query/hash。合法返回 { ok, base }，否则 { ok: false, error }。 */
export function normalizeBase(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return { ok: false, error: '请填写宿主服务地址' }
  if (!/^https?:\/\//i.test(value)) return { ok: false, error: '地址需以 http:// 或 https:// 开头' }
  let url
  try { url = new URL(value) } catch { return { ok: false, error: '地址格式不合法' } }
  if (url.search || url.hash) return { ok: false, error: '地址不带查询参数与 # 锚点' }
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, base: url.origin + path }
}

/** 读取连接清单（存储损坏/形态不对时回落空清单）。 */
export function loadConnections(storage) {
  try {
    const raw = storage.getItem(CONNECTIONS_KEY)
    const list = raw ? JSON.parse(raw) : []
    if (!Array.isArray(list)) return []
    return list.filter((item) => item && typeof item.id === 'string' && typeof item.base === 'string')
  } catch { return [] }
}

export function saveConnections(storage, list) {
  storage.setItem(CONNECTIONS_KEY, JSON.stringify(list))
}

export function getActiveId(storage) {
  try { return storage.getItem(ACTIVE_KEY) || '' } catch { return '' }
}

/** 切换活动连接（只写偏好不刷新；调用方负责 location.reload() 应用）。 */
export function setActiveId(storage, id) {
  if (id === LOCAL_ID) storage.removeItem(ACTIVE_KEY)
  else storage.setItem(ACTIVE_KEY, id)
}

/**
 * 活动连接决议：本机 = { id: LOCAL_ID, name: '本机宿主服务', base: mountBase }（mountBase 为
 * 本页部署前缀 '' 或 '/rq'）；远程 = 清单内对应项，清单已删则回落本机（防悬空）。
 */
export function activeConnection(storage, mountBase = '') {
  const id = getActiveId(storage)
  if (id && id !== LOCAL_ID) {
    const found = loadConnections(storage).find((item) => item.id === id)
    if (found) return found
  }
  return { id: LOCAL_ID, name: '本机宿主服务', base: mountBase }
}

/** 新增/更新连接：base 规范化失败返回 { ok:false, error }；同名远处自动去重更新。 */
export function upsertConnection(storage, { id, name, base }) {
  const normalized = normalizeBase(base)
  if (!normalized.ok) return normalized
  const list = loadConnections(storage)
  const target = { id: id || `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: String(name ?? '').trim() || new URL(normalized.base).host, base: normalized.base, createdAt: Date.now() }
  const index = list.findIndex((item) => item.id === target.id)
  if (index >= 0) {
    target.createdAt = list[index].createdAt
    list[index] = target
  } else {
    list.push(target)
  }
  saveConnections(storage, list)
  return { ok: true, list, connection: target }
}

/** 删除连接。返回 removedActive 表示删的是活动连接（调用方需回落本机并刷新）。 */
export function removeConnection(storage, id) {
  const list = loadConnections(storage).filter((item) => item.id !== id)
  saveConnections(storage, list)
  // 指向该宿主的面板登记一并清理：宿主没了，入口留着只会点出空白页
  const panels = loadPanels(storage)
  const kept = panels.filter((item) => item.connectionId !== id)
  if (kept.length !== panels.length) savePanels(storage, kept)
  const removedActive = id !== LOCAL_ID && getActiveId(storage) === id
  if (removedActive) setActiveId(storage, LOCAL_ID)
  return { list, removedActive }
}

// ---------------------------------------------------------------------------
// 部门面板登记（2026-10-22）：面板以「宿主连接 × 部门」为一条登记项。
//
// 此前「部门面板」是一个硬编码外链（永远指向当前活动宿主的 /panel/），宿主连接清单
// 与面板入口之间没有任何事实上的关联；换宿主后出现哪个部门的看板完全取决于目标宿主
// 自己的 localStorage 记忆。现在把关系显式化：只有在本页登记过的面板，才会出现在
// 控制台「部门面板」清单里并可一键跳转——登记项即「这台宿主的哪个部门可被访问」。
// 存储同样留在浏览器（与连接清单同域同生命期），不引入服务端状态。
// ---------------------------------------------------------------------------

/** 面板登记存储键：[{ id, name, connectionId, dept, createdAt }]。 */
export const PANELS_KEY = 'heng_ops_panels'

/**
 * 部门标识合法字符：与服务端 panel-core 的 DEPT_RE（/^[a-z]{2,12}$/）同口径。
 * 前端不放宽——手工填的 `RD` / `rd-team` 会被 /api/panel/* 以 400 拒绝，
 * 表现为入口能点开但面板里什么都没有。
 */
const PANEL_DEPT_RE = /^[a-z]{2,12}$/

export function loadPanels(storage) {
  try {
    const list = JSON.parse(storage.getItem(PANELS_KEY) ?? '[]')
    if (!Array.isArray(list)) return []
    // dept 形态不合法的脏数据一并滤除：它的入口必然被服务端 400，留着只是制造坏链接
    return list.filter((item) => item && typeof item.id === 'string' && typeof item.dept === 'string' && PANEL_DEPT_RE.test(item.dept))
  } catch { return [] }
}

export function savePanels(storage, list) {
  storage.setItem(PANELS_KEY, JSON.stringify(list))
}

/**
 * 新增/更新面板登记。connectionId 缺省为本机；name 留空回落「部门标识 @ 宿主名」。
 * 同一「宿主 × 部门」只允许一条（重复登记返回既有项，避免清单里出现两个一样的入口）。
 */
export function upsertPanel(storage, { id, name, connectionId, dept, mountBase = '' }) {
  const deptId = String(dept ?? '').trim()
  if (!deptId) return { ok: false, error: '请填写部门标识（如 mfg / rd）' }
  if (!PANEL_DEPT_RE.test(deptId)) {
    return { ok: false, error: '部门标识只能是小写字母，2–12 位（如 mfg / rd / strategy），需与目标宿主的部门标识一致' }
  }
  const hostId = connectionId || LOCAL_ID
  const host = hostId === LOCAL_ID
    ? { id: LOCAL_ID, name: '本机宿主服务', base: mountBase }
    : loadConnections(storage).find((item) => item.id === hostId)
  if (!host) return { ok: false, error: '目标宿主连接不存在，请先在连接清单中新增' }
  const list = loadPanels(storage)
  const duplicate = list.find((item) => item.connectionId === hostId && item.dept === deptId && item.id !== id)
  if (duplicate) return { ok: false, error: `该宿主的「${deptId}」部门已登记为「${duplicate.name}」` }
  const target = {
    id: id || `pnl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: String(name ?? '').trim() || `${deptId} @ ${host.name}`,
    connectionId: hostId,
    dept: deptId,
    createdAt: Date.now(),
  }
  const index = list.findIndex((item) => item.id === target.id)
  if (index >= 0) {
    target.createdAt = list[index].createdAt
    list[index] = target
  } else {
    list.push(target)
  }
  savePanels(storage, list)
  return { ok: true, list, panel: target }
}

/** 删除面板登记。连接被删除时，指向它的面板登记一并清理（防悬空入口）。 */
export function removePanel(storage, id) {
  const list = loadPanels(storage).filter((item) => item.id !== id)
  savePanels(storage, list)
  return { list }
}

/** 面板地址：本机走同源相对路径（挂载形态带前缀），远程宿主拼完整地址。 */
export function panelUrl(panel, storage, mountBase = '') {
  const host = panel.connectionId === LOCAL_ID
    ? { base: mountBase }
    : loadConnections(storage).find((item) => item.id === panel.connectionId)
  if (!host) return ''
  const base = String(host.base ?? '').replace(/\/+$/, '')
  return `${base}/panel/?dept=${encodeURIComponent(panel.dept)}`
}

/** 面板登记解析：带上宿主展示名与可用性（宿主连接已删/不存在时 available=false）。 */
export function resolvePanels(storage, mountBase = '') {
  return loadPanels(storage).map((panel) => {
    const url = panelUrl(panel, storage, mountBase)
    const hostName = panel.connectionId === LOCAL_ID
      ? '本机宿主服务'
      : loadConnections(storage).find((item) => item.id === panel.connectionId)?.name ?? '（宿主已删除）'
    const active = activeConnection(storage, mountBase)
    return { ...panel, url, hostName, available: url !== '', isActiveHost: active.id === panel.connectionId }
  })
}
