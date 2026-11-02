/**
 * 复现/验证：治理检查第 2 项 workforce permit 覆盖是否真的生效（Q-22 声称已修）
 * 构造：员工(active) + 绑定该 Agent + 生效任用 → 应放行；随后停用员工 → 应 PERMIT_NOT_EFFECTIVE
 */
const base = process.env.BASE ?? 'http://127.0.0.1:7344'
const login = async (u) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Ybk@2026' }) }).then(r => r.json())).data.token
const admin = await login('admin')
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + admin }
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, ...(await r.json()) } }
const agents = (await call('GET', '/api/agents')).data.agents
const online = agents.find((a) => a.status === 'online')
const freeCreate = await call('POST', '/api/agents', { name: 'PERMIT独立目标', slug: `permit-target-${Date.now().toString(36)}`, attrs: { description: 'permit 探针', model: 'deepseek-chat', riskLevel: 'low', systemPromptVersion: 'v1', dataClass: 'internal', trialGroups: ['灰度试点组'], entryUrl: 'https://permit.example.com', autonomy: 'A2' } })
const free = freeCreate.data?.agent
if (!free) { console.log(JSON.stringify({ step: 'create-agent', response: freeCreate }, null, 2)); process.exit(1) }
await call('POST', `/api/agents/${free.id}/transition`, { action: 'submit_trial' })
const onlineReq = await call('POST', `/api/agents/${free.id}/transition`, { action: 'online', note: 'permit 探针上线' })
const approverToken = await login('qa-approver')
await fetch(base + `/api/approvals/${onlineReq.data?.approval?.id}/decide`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + approverToken }, body: JSON.stringify({ decision: 'approve', opinion: 'permit 探针', confirmed: true, finalReview: true }) })
const target = free ?? online
const orgs = (await call('GET', '/api/iam/orgs')).data
const orgId = Array.isArray(orgs) ? orgs[0].id : orgs.orgs[0].id
const users = (await call('GET', '/api/iam/users')).data.users
const supervisor = users.find(u => u.username === 'admin').id

const rpc = async (m, p) => { const r = await fetch(base + '/api/agents/' + target.slug + '/a2a', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); return (await r.json()).data }
const before = await rpc('message/send', { message: 'permit 探针-未纳管' })

const emp = await call('POST', '/api/workforce/employees', { name: 'PERMIT探针员工', orgId, supervisorUserId: supervisor, agentId: target.id })
const employeeId = emp.data?.id
const bind = await call('POST', `/api/workforce/employees/${employeeId}/bindings`, { agentId: target.id })
const appt = await call('POST', '/api/workforce/appointments', { employeeId, position: '协作执行', orgId, dataClass: 'internal', grants: [{ kind: 'mcp', registryId: 'mcp-probe', actions: ['invoke'], risk: 'read' }] })
const activate = appt.data?.id ? await call('POST', `/api/workforce/appointments/${appt.data.id}/activate`, {}) : null
const withPermit = await rpc('message/send', { message: 'permit 探针-已纳管生效' })

const suspend = await call('POST', `/api/workforce/employees/${employeeId}/status`, { status: 'suspended', reason: 'permit 失效探针' })
const afterSuspend = await rpc('message/send', { message: 'permit 探针-员工停用' })

console.log(JSON.stringify({
  fixture: { employee: emp.status, binding: bind.status, appointment: appt.status, activate: activate?.status },
  beforeManaged: before?.error?.message ?? before?.result?.task?.state,
  withPermit: withPermit?.error?.message ?? withPermit?.result?.task?.state,
  afterSuspend: afterSuspend?.error?.message ?? afterSuspend?.result?.task?.state,
  verdict: afterSuspend?.error?.data?.code === 'PERMIT_NOT_EFFECTIVE'
    ? 'PASS（permit 失效被拒）'
    : (withPermit?.result?.task?.state === 'completed' && afterSuspend?.result?.task?.state === 'completed'
      ? 'FAIL（停用后仍放行，permit 判定未生效）'
      : 'INCONCLUSIVE（夹具未建立受管态）'),
}, null, 2))
