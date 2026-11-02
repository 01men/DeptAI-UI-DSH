/**
 * 复现：UHP 顶层 task_id / taskId 变体既不被拒绝、也不留痕
 * 对比：metadata.ybk_a2a_task_id → 400 TASK_BINDING_FORBIDDEN + 专项审计
 *       顶层 task_id/taskId → 200 静默忽略（无 ignored_fields、无审计）→ 注入尝试不可观测
 * 说明：不建立绑定（安全无直接后果），但违反修复批次「拒绝而非忽略，使注入成为可观测审计事件」的声明
 */
const base = process.env.BASE ?? 'http://127.0.0.1:7342'
const login = async (u) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Ybk@2026' }) }).then(r => r.json())).data.token
const admin = await login('admin')
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + admin }
const harnesses = (await (await fetch(base + '/api/uhp/harnesses', { headers: H })).json()).data.harnesses
const h = harnesses.find(x => x.dataClassCeiling !== 'public')
const call = async (body) => {
  const r = await fetch(base + '/v1/uhp/responses', { method: 'POST', headers: H, body: JSON.stringify(body) })
  const j = await r.json(); return { http: r.status, doc: j.data ?? j }
}
const meta = await call({ model: 'harness/' + h.id, input: 'metadata 变体', metadata: { ybk_a2a_task_id: 'task_probe' } })
const top = await call({ model: 'harness/' + h.id, input: '顶层变体', task_id: 'task_probe' })
const topCamel = await call({ model: 'harness/' + h.id, input: '顶层驼峰', taskId: 'task_probe' })
console.log(JSON.stringify({
  metadataVariant: { http: meta.http, code: meta.doc?.error?.code, bound: Boolean(meta.doc?.task_id) },
  topSnake: { http: top.http, bound: Boolean(top.doc?.task_id), ignored: top.doc?.metadata?.ignored_fields },
  topCamel: { http: topCamel.http, bound: Boolean(topCamel.doc?.task_id), ignored: topCamel.doc?.metadata?.ignored_fields },
  verdict: (top.http !== 400 && !(top.doc?.metadata?.ignored_fields ?? []).includes('task_id'))
    ? 'FAIL（顶层注入静默忽略，无拒绝无留痕——与修复批次声明的「拒绝而非忽略」不一致）' : 'PASS',
}, null, 2))
