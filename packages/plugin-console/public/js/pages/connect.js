/**
 * 平台接入 · 路由兼容壳（Kimi CIO 仪表盘设计适配 §4/§5.9，2026-10-14）：
 * #/connect 的 enroll 接入码全功能已并入 #/access?tab=enroll（pages/access.js），
 * 这里仅做薄重定向保证旧书签不死链；导出名 renderConnect 保持（app.js builders 不动）。
 * 原 ?tab=clients|codes|overview 内层子页语义经 ?sub= 转发继续可达。
 */
export async function renderConnect(content, params) {
  const sub = params?.get('tab')
  const suffix = sub ? `&sub=${encodeURIComponent(sub)}` : ''
  location.hash = `#/access?tab=enroll${suffix}`
}
