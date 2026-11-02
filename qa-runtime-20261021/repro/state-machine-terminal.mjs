/**
 * 复现：八态状态机缺少「终态不可再迁移」守卫
 * 思路：对 canceled 任务再发 tasks/cancel → 应拒绝（终态）；transition 内部无守卫
 * 另：auth_required 任务走 UHP 直调不推进（已由组A/B证明），但 transition 本身无来源约束
 */
const base = process.env.BASE ?? 'http://127.0.0.1:7344'
const login = async (u) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Ybk@2026' }) }).then(r => r.json())).data.token
const admin = await login('admin')
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + admin }
const agents = (await (await fetch(base + '/api/agents', { headers: H })).json()).data.agents
const target = agents.find(a => a.status === 'online' && (a.attrs?.autonomy === 'A2' || a.attrs?.autonomy === 'A3'))
const rpc = async (m, p) => {
  const r = await fetch(base + '/api/agents/' + target.slug + '/a2a', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) })
  const j = await r.json(); return j.data ?? j
}
// 取消已在终态的任务（先造一个完成的任务）
const done = await rpc('message/send', { message: '终态守卫探针' })
const taskId = done.result?.task?.taskId
const state1 = done.result?.task?.state
const cancelDone = await rpc('tasks/cancel', { taskId, reason: '对终态任务取消' })
const after = await rpc('tasks/get', { taskId })
console.log(JSON.stringify({
  initial: state1,
  cancelTerminalResult: cancelDone.error ?? cancelDone.result?.task?.state,
  finalState: after.result?.task?.state,
  verdict: cancelDone.error ? 'PASS（终态拒绝二次取消）' : 'FAIL（终态任务被接受取消请求，transition 无终态守卫）',
}, null, 2))
