/**
 * 01门（Gate 01 · DeptAI-UI-DSH）面板入口探测（2026-11-01）。
 *
 * 01门以 dsh 插件形态挂在宿主 /gate01 之下（面板 /gate01/panel/）；底座自身不感知该装态
 * ——控制台侧用「探测存在才渲染」的同源探针决定是否露出入口，保证任何部署形态都不出死链。
 * 探针打 GET /gate01/rqcard/link（rq-card 向导命名空间，需 x-rqcard-call 头）：
 *   - ok JSON（mode 字段在场）= 01门已挂载 → 返回面板地址；
 *   - 404 / SPA HTML 兜底 / 网络错误 = 未挂载 → 返回 null（调用方不渲染入口）。
 */

/** 挂载前缀推导：根部署为 ''，dsh 全量挂载形态为 '/rq'（与 panels.js 同源推导）。 */
function mountOf(baseURI) {
  return new URL('.', baseURI).pathname.replace(/\/$/, '')
}

/**
 * 可注入探针（baseURI / fetch 可替换，Node 零 DOM 直测；与 next-redirect.js 同风格）。
 * 挂载时返回**演示免密中转页**地址（相对同源，如 '/gate01-go.html'——自动签票兑换直达工作台，
 * 不再让客户手输账号密码，2026-11-01）；null = 未挂载。
 */
export async function probeGate01PanelWith({ baseURI = document.baseURI, fetchImpl = fetch } = {}) {
  const mount = mountOf(baseURI)
  try {
    const response = await fetchImpl(`${mount}/gate01/rqcard/link`, {
      headers: { 'x-rqcard-call': '1', accept: 'application/json' },
    })
    const contentType = String(response.headers?.get ? response.headers.get('content-type') ?? '' : '')
    if (!response.ok || !contentType.includes('json')) return null
    const payload = await response.json().catch(() => null)
    if (payload?.ok !== true || typeof payload.data?.mode !== 'string') return null
    return `${mount}/gate01-go.html`
  } catch {
    return null
  }
}

/** 页面用入口：真实全局环境。 */
export function probeGate01Panel() {
  return probeGate01PanelWith({})
}
