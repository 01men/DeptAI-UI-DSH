/**
 * 复现：refType=external 机器凭证可以成功派活，但永远看不到自己的任务
 * 根因：plugin-a2a getTask/listTasks 的组织判定 canSeeOrg() 只对 human(userId) 与
 *       machine+refType=agent(refId→agent.orgId) 解析组织；refType=external 无组织归属
 *       → return false / 空集。而归属判定（callerPrincipalId === principalId）在其后，
 *       永远不可达。
 */
const base = process.env.BASE ?? 'http://127.0.0.1:7345'
const login = async (u) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Ybk@2026' }) }).then(r => r.json())).data.token
const admin = await login('admin')
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + admin }
const agents = (await (await fetch(base + '/api/agents', { headers: H })).json()).data.agents
const target = agents.find(a => a.status === 'online' && a.attrs?.autonomy !== 'A0')
const p = (await (await fetch(base + '/api/authn/principals', { method: 'POST', headers: H, body: JSON.stringify({ name: 'ext-repro-' + Date.now(), refType: 'external', scopes: ['agent.a2a.invoke', 'agent.read'] }) })).json()).data
const cc = (await (await fetch(base + '/api/auth/client-credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: p.clientId, clientSecret: p.clientSecret }) })).json()).data
const tok = cc.token
const rpc = async (m, params) => {
  const r = await fetch(base + '/api/agents/' + target.slug + '/a2a', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params }) })
  const j = await r.json(); return j.data ?? j
}
const sent = await rpc('message/send', { message: 'external 自查复现' })
const taskId = sent.result?.task?.taskId
const got = await rpc('tasks/get', { taskId })
const list = await rpc('tasks/list', { limit: 50 })
console.log(JSON.stringify({
  principalKind: 'external',
  dispatch: { ok: Boolean(taskId), state: sent.result?.task?.state },
  tasksGet: got.error ? { code: got.error.code, message: got.error.message } : { state: got.result?.task?.state },
  tasksListCount: list.result?.tasks?.length ?? null,
  verdict: got.error?.code === -32003 ? 'FAIL（无法读取自己发起的任务；外部集成闭环断裂）' : 'PASS',
}, null, 2))
