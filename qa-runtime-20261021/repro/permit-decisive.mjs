/**
 * 决定性验证：治理第 2 项 permit 覆盖是否真的被调用
 * 构造：员工(active) + 绑定到某 online Agent，且**不建任何任用**
 * 契约：已绑定但任用未生效 → 必须 PERMIT_NOT_EFFECTIVE（fail-closed）
 * 判据：若仍 completed，则探测分支根本未到达（异常被 catch 按 legacy 放行，或 resolver.store 取不到）
 */
const base = process.env.BASE ?? 'http://127.0.0.1:7344'
const login = async (u) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Ybk@2026' }) }).then(r => r.json())).data.token
const admin = await login('admin')
const approver = await login('qa-approver')
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + admin }
const HA = { 'content-type': 'application/json', authorization: 'Bearer ' + approver }
const call = async (m, p, b, h = H) => { const r = await fetch(base + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) }); const j = await r.json(); return { status: r.status, ...j } }
const orgs = (await call('GET', '/api/iam/orgs')).data
const orgId = Array.isArray(orgs) ? orgs[0].id : orgs.orgs[0].id
const users = (await call('GET', '/api/iam/users')).data.users
const supervisor = users.find(u => u.username === 'admin').id

const slug = 'permit-dec-' + Date.now().toString(36)
const created = await call('POST', '/api/agents', { name: 'PERMIT决定性目标', slug, attrs: { description: 'permit', model: 'deepseek-chat', riskLevel: 'low', systemPromptVersion: 'v1', dataClass: 'internal', trialGroups: ['灰度试点组'], entryUrl: 'https://p.example.com', autonomy: 'A2' } })
const agent = created.data.agent
await call('POST', `/api/agents/${agent.id}/transition`, { action: 'submit_trial' })
const onlineReq = await call('POST', `/api/agents/${agent.id}/transition`, { action: 'online', note: 'permit 决定性' })
await call('POST', `/api/approvals/${onlineReq.data?.approval?.id}/decide`, { decision: 'approve', opinion: 'permit', confirmed: true, finalReview: true }, HA)
const emp = await call('POST', '/api/workforce/employees', { name: 'PERMIT决定性员工', orgId, supervisorUserId: supervisor, agentId: agent.id })
const bind = await call('POST', `/api/workforce/employees/${emp.data?.id}/bindings`, { agentId: agent.id })
const appts = await call('GET', `/api/workforce/appointments?employeeId=${emp.data?.id}`)
const apptRows = Array.isArray(appts.data) ? appts.data : (appts.data?.items ?? [])

const rpc = async (m, p) => { const r = await fetch(base + '/api/agents/' + slug + '/a2a', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); const j = await r.json(); return j.data ?? j }
const dispatched = await rpc('message/send', { message: 'permit 决定性探针（无任用）' })

console.log(JSON.stringify({
  fixture: { employee: emp.status, binding: bind.status, appointments: apptRows.length },
  dispatch: dispatched.error ? { code: dispatched.error.data?.code, message: dispatched.error.message } : { state: dispatched.result?.task?.state },
  verdict: dispatched.error?.data?.code === 'PERMIT_NOT_EFFECTIVE'
    ? 'PASS（已绑定无任用被 fail-closed 拒绝）'
    : (dispatched.result?.task?.state
      ? 'FAIL（已绑定但无生效任用仍放行 → permit 探测分支未到达；静态证据：plugin-a2a inject 缺 workforceIdentity，异常被 catch 吞掉按 legacy 放行）'
      : 'INCONCLUSIVE'),
}, null, 2))
