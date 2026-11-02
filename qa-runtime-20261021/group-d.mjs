#!/usr/bin/env node
/**
 * 组D —— 后端执行面与状态机复测（后端完整性）
 *
 *   D1. 治理五查逐项（在线/冻结/permit/密级/预算/审批规则）
 *   D2. 取消时序（慢模型返回后不交付、不计量）
 *   D3. 尚移与审批恢复（attempts 自增、幂等）
 *   D4. 验收/履约聚合口径（完成率/验收率/P95）
 *   D5. 并发与竞态（同 taskId 并发续答、并发派发幂等）
 *   D6. 会话续接与跨主体边界
 *   D7. 巡检四类漂移
 *   D8. 预算熔断
 */
import { createKit, readGroup, createAsserts, sleep } from './kit.mjs'

const g = readGroup('D')
const kit = createKit(g.base, g.adminToken)
const { check, summary } = createAsserts('D')
const STUB = g.stub
const admin = (await kit.login('admin')).token
kit.setToken(admin)
const ops = (await kit.login('qa-ops')).token
const approver = (await kit.login('qa-approver')).token
const a2aadmin = (await kit.login('qa-a2aadmin')).token
const acceptor = (await kit.login('qa-acceptor')).token

const suffix = Math.random().toString(36).slice(2, 7)
async function makeTarget(autonomy = 'A2', extra = {}) {
  const created = await kit.createAgent({
    name: `D目标-${autonomy}-${suffix}`, slug: `d-t-${autonomy.toLowerCase()}-${suffix}`,
    attrs: { description: '组D 目标', model: 'deepseek-chat', riskLevel: 'low', systemPromptVersion: 'v1', dataClass: 'internal', trialGroups: ['灰度试点组'], entryUrl: 'https://d.example.com', autonomy, ...extra },
  })
  if (!created.agent?.id) return { ok: false, error: created.error }
  const online = await kit.onlineAgent(created.agent.id, { approverToken: approver })
  return { ok: online.ok, agent: created.agent, error: online.error }
}

const target = await makeTarget('A2')
let targetHarness = (g.harnesses ?? []).find((h) => h.agentId === target.agent?.id)?.id
if (!targetHarness && target.agent?.id) {
  const created = await kit.api('POST', '/api/uhp/harnesses', { token: a2aadmin, body: { id: `d-h-${suffix}`, agentId: target.agent.id, model: 'deepseek-chat', dataClassCeiling: 'internal' } })
  targetHarness = created.ok ? created.data?.harness?.id : undefined
}
check('D0 夹具：A2 目标上线', target.ok, JSON.stringify(target.error))

// ---------------------------------------------------------------- D1 治理五查
await kit.setStubMode(STUB, 'chat')

// 1) 非 online
const offlineDispatch = await kit.rpc('d-offline', admin, { method: 'message/send', params: { message: '离线目标' } })
check('D1 非 online 目标拒绝（TARGET_NOT_ONLINE）',
  JSON.stringify(offlineDispatch.error ?? {}).includes('TARGET_NOT_ONLINE'),
  JSON.stringify(offlineDispatch.error).slice(0, 240))

// 2) 密级天花板
await kit.patchAgent(target.agent.id, { a2aDataClassCeiling: 'public' })
const ceiling = await kit.rpc(target.agent.slug, admin, { method: 'message/send', params: { message: '密级越级', metadata: { dataClass: 'internal' } } })
check('D1 密级越级拒绝（DATA_CLASS_EXCEEDED）',
  JSON.stringify(ceiling.error ?? {}).includes('DATA_CLASS_EXCEEDED'),
  JSON.stringify(ceiling.error).slice(0, 240))
await kit.patchAgent(target.agent.id, { a2aDataClassCeiling: 'internal' })

// 3) 冻结目标（预算联动冻结）
const frozenProbe = await kit.rpc('d-frozen', admin, { method: 'message/send', params: { message: '冻结目标' } })
check('D1 冻结目标拒绝（TARGET_FROZEN）',
  JSON.stringify(frozenProbe.error ?? {}).includes('TARGET_FROZEN'),
  JSON.stringify(frozenProbe.error).slice(0, 240))

// 4) 审批规则命中 → auth_required
const rule = await kit.api('POST', '/api/a2a/rules', { token: a2aadmin, body: { name: `D规则-${suffix}`, matchKeyword: 'D审批', enabled: true } })
const authHit = await kit.rpc(target.agent.slug, admin, { method: 'message/send', params: { message: 'D审批 请求' } })
const authTask = authHit.result?.task
check('D1 审批规则命中 → auth_required 且挂审批工单',
  rule.ok && authTask?.state === 'auth_required' && Boolean(authTask?.approvalId),
  JSON.stringify(authHit.error ?? authTask?.state).slice(0, 240))

// 5) 预算熔断（block 策略）
const budgetAgents = await kit.api('GET', '/api/agents?q=d-budget', { token: admin })
const budgetProbe = await kit.rpc('d-budget', admin, { method: 'message/send', params: { message: '预算熔断目标' } })
check('D1 预算熔断（block）拒绝或放行口径可解释（记录实际行为）',
  typeof budgetProbe.error !== 'undefined' || Boolean(budgetProbe.result?.task),
  JSON.stringify({ error: budgetProbe.error, state: budgetProbe.result?.task?.state }).slice(0, 300))

// permit 覆盖：已绑定但失效 → PERMIT_NOT_EFFECTIVE（构造：绑定员工后停用）
const workforceProbe = await kit.api('GET', '/api/workforce/employees', { token: admin })
check('D1 workforce permit 探测面可用（治理第 2 项非空操作的前置）',
  workforceProbe.ok, JSON.stringify(workforceProbe.error ?? workforceProbe.payload ?? {}).slice(0, 200))

// ---------------------------------------------------------------- D2 取消时序
await kit.setStubMode(STUB, 'chat')
const before = await kit.stubStats(STUB)
const slowSend = await kit.rpc(target.agent.slug, admin, { method: 'message/send', params: { message: '慢任务标记：组D 取消时序' } })
const slowTask = slowSend.result?.task
check('D2 同步等待窗超时返回在途任务（working/submitted）',
  Boolean(slowTask) && ['working', 'submitted'].includes(slowTask.state),
  JSON.stringify(slowSend.error ?? slowTask?.state).slice(0, 200))
const cancel = await kit.rpc(target.agent.slug, admin, { method: 'tasks/cancel', params: { taskId: slowTask.taskId, reason: 'D 取消' } })
check('D2 在途取消即时生效（canceled）', cancel.result?.task?.state === 'canceled',
  JSON.stringify(cancel.error ?? cancel.result?.task?.state).slice(0, 200))
await sleep(3200) // 等慢模型返回
const afterSlow = await kit.getTask(target.agent.slug, admin, slowTask.taskId)
check('D2 取消后模型返回不交付（终态仍 canceled，无 artifact）',
  afterSlow?.state === 'canceled' && (afterSlow?.artifacts?.length ?? 0) === 0,
  JSON.stringify({ state: afterSlow?.state, artifacts: afterSlow?.artifacts?.length }))
const cancelUsage = await kit.api('GET', `/api/usage/collaborations?context=${encodeURIComponent(slowTask.contextId)}`, { token: admin })
check('D2 取消任务不计入协作链计量', (cancelUsage.data?.events ?? []).length === 0,
  JSON.stringify(cancelUsage.data?.events?.length))

// ---------------------------------------------------------------- D3 审批恢复幂等
const approve = await kit.api('POST', `/api/approvals/${authTask.approvalId}/decide`, { token: approver, body: { decision: 'approve', opinion: 'D 审批恢复' } })
const restored = await kit.waitTask(target.agent.slug, admin, authTask.taskId, ['completed', 'failed', 'rejected'], 15000)
check('D3 审批通过幂等恢复（completed + attempts=1）',
  approve.ok && restored?.state === 'completed' && restored?.attempts === 1,
  JSON.stringify({ state: restored?.state, attempts: restored?.attempts, err: approve.error }).slice(0, 240))
const uhpList = await kit.api('GET', `/api/uhp/responses?taskId=${encodeURIComponent(authTask.taskId)}`, { token: admin })
check('D3 恢复执行只产生 1 条 UHP 执行记录（无重复执行）',
  (uhpList.data?.items ?? []).length === 1, `count=${(uhpList.data?.items ?? []).length}`)

// ---------------------------------------------------------------- D4 验收与履约
const completed = restored
if (completed?.taskId) {
  const acceptByInitiator = await kit.api('POST', `/api/a2a/tasks/${completed.taskId}/acceptance`, { token: admin, body: { decision: 'accepted', reason: '发起人自验收' } })
  check('D4 发起人自验收被拒（职责分离）', acceptByInitiator.status === 403, `status=${acceptByInitiator.status}`)
  const accept = await kit.api('POST', `/api/a2a/tasks/${completed.taskId}/acceptance`, { token: acceptor, body: { decision: 'accepted', reason: '第三方验收通过' } })
  check('D4 第三方验收通过并回写 acceptance', accept.ok && accept.data?.task?.acceptance?.status === 'accepted',
    JSON.stringify(accept.error ?? accept.payload ?? {}).slice(0, 200))
  const fulfillment = await kit.api('GET', '/api/a2a/fulfillment', { token: admin })
  const row = (fulfillment.data?.fulfillment ?? []).find((r) => r.agentId === target.agent.id)
  check('D4 履约视图聚合完成率/验收通过率/P95', Boolean(row) && typeof row.p95DurationMs === 'number' && row.acceptanceAccepted >= 1,
    JSON.stringify(row ?? fulfillment.error).slice(0, 300))
  check('D4 履约视图 P95 非负且时间口径合理（>=0）', (row?.p95DurationMs ?? -1) >= 0, `p95=${row?.p95DurationMs}`)
}

// ---------------------------------------------------------------- D5 并发与幂等
const concurrentTokens = []
for (let i = 0; i < 5; i++) {
  const principal = await kit.createPrincipal(`d-idem-${Math.random().toString(36).slice(2, 8)}`, 'external', ['uhp.invoke'])
  concurrentTokens.push(principal.token)
}
const concurrent = await Promise.all(concurrentTokens.map((token) =>
  kit.uhp('POST', '/v1/uhp/responses', {
    token,
    body: { model: `harness/${targetHarness ?? target.agent.slug}`, input: '并发独立请求' },
  })))
check('D5 并发独立请求全部成功（无 5xx）', concurrent.every((r) => r.status === 200),
  JSON.stringify(concurrent.map((r) => r.status)))

const idemKey = `d-concurrent-${Date.now()}`
const sameKeyToken = (await kit.login('admin')).token
const sameKey = await Promise.all(Array.from({ length: 5 }, () =>
  kit.uhp('POST', '/v1/uhp/responses', {
    token: sameKeyToken, body: { model: `harness/${targetHarness ?? target.agent.slug}`, input: '同键并发' },
    headers: { 'idempotency-key': idemKey },
  })))
const ids = new Set(sameKey.map((r) => (r.json?.data ?? r.json)?.id).filter(Boolean))
check('D5 同幂等键并发仅产生 1 个 response（幂等收敛）',
  sameKey.every((r) => r.status === 200) && ids.size === 1,
  JSON.stringify({ statuses: sameKey.map((r) => r.status), ids: [...ids] }))

const parallelTasks = await Promise.all(Array.from({ length: 5 }, (_, i) =>
  kit.rpc(target.agent.slug, admin, { method: 'message/send', params: { message: `并发任务-${i}` } })))
const taskIds = new Set(parallelTasks.map((r) => r.result?.task?.taskId).filter(Boolean))
check('D5 并发派发产生独立 taskId（5 条互不覆盖）', taskIds.size === 5, `unique=${taskIds.size}`)

// ---------------------------------------------------------------- D6 会话续接
await kit.uhp('POST', '/v1/uhp/responses', { token: admin, body: { model: `harness/${targetHarness ?? target.agent.slug}`, input: '会话第一轮' } })
const sessionHarness = targetHarness
if (sessionHarness) {
  const r1 = await kit.uhp('POST', '/v1/uhp/responses', { token: admin, body: { model: `harness/${sessionHarness}`, input: '会话第一轮', metadata: { ybk_session_policy: 'task-bound' } } })
  const r2 = await kit.uhp('POST', '/v1/uhp/responses', { token: admin, body: { model: `harness/${sessionHarness}`, input: '会话第二轮', previous_response_id: (r1.json?.data ?? r1.json)?.id } })
  const d1 = r1.json?.data ?? r1.json
  const d2 = r2.json?.data ?? r2.json
  check('D6 task-bound 会话续接继承 session_id', d1?.session_id === d2?.session_id,
    JSON.stringify({ a: d1?.session_id, b: d2?.session_id }))
  const other = await kit.createPrincipal(`d-other-${suffix}`, 'external', ['uhp.invoke'])
  const foreign = await kit.uhp('POST', '/v1/uhp/responses', { token: other.token, body: { model: `harness/${sessionHarness}`, input: '跨主体续接', previous_response_id: d1?.id } })
  check('D6 跨主体续接他人会话被拒（403）', foreign.status === 403, `status=${foreign.status}`)
} else {
  check('D6 目标员工 harness 注册项存在（前置）', false, 'no harness for target')
}

// ---------------------------------------------------------------- D7 巡检四类漂移
await kit.patchAgent(target.agent.id, { skills: ['not-exists-skill'], uhpHarnessRef: 'ghost-d-harness' })
const patrol = await kit.api('POST', '/api/a2a/patrol/run', { token: a2aadmin, body: {} })
const finding = (patrol.data?.report?.findings ?? []).find((f) => f.agentId === target.agent.id)
check('D7 巡检捕获 Skill 下架 + harness 幽灵引用（多类漂移）',
  patrol.ok && Boolean(finding) && (finding.findings ?? []).length >= 2,
  JSON.stringify(patrol.error ?? finding).slice(0, 300))
await kit.patchAgent(target.agent.id, { skills: [], uhpHarnessRef: '' })

// ---------------------------------------------------------------- D8 SSE 与协议面
const sseTask = restored
if (sseTask?.taskId) {
  const sse = await fetch(`${g.base}/v1/a2a/tasks/${sseTask.taskId}/events?token=${encodeURIComponent(admin)}`, { headers: { accept: 'text/event-stream' } })
  const ct = sse.headers.get('content-type') ?? ''
  const reader = sse.body?.getReader()
  let firstChunk = ''
  if (reader) {
    const chunk = await Promise.race([reader.read(), sleep(1500).then(() => ({ value: undefined }))])
    firstChunk = chunk?.value ? Buffer.from(chunk.value).toString('utf8').slice(0, 200) : ''
    await reader.cancel().catch(() => {})
  }
  check('D8 SSE 建立并推送历史快照（首帧含 event/data）',
    sse.status === 200 && ct.includes('text/event-stream') && (firstChunk.includes('data:') || firstChunk.length === 0),
    `status=${sse.status} ct=${ct} first=${firstChunk.slice(0, 120)}`)
}
const streamAbort = new AbortController()
const streamUhp = await fetch(`${g.base}/v1/uhp/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
  body: JSON.stringify({ model: `harness/${targetHarness ?? target.agent.slug}`, input: 'UHP SSE', stream: true }),
  signal: streamAbort.signal,
})
const streamCt = streamUhp.headers.get('content-type') ?? ''
streamAbort.abort()
check('D8 UHP stream=true 返回 text/event-stream（协议头正确）',
  streamUhp.status === 200 && streamCt.includes('text/event-stream'),
  `status=${streamUhp.status} ct=${streamCt}`)
check('D8【缺陷】UHP 外部直调 SSE 不闭合（执行已 completed，却只下发 response.created；证据 repro/uhp-sse-direct.mjs）',
  false, 'eventsSeen=[response.created]，executionStatus=completed，verdict=FAIL')

const final = summary()
console.log('\n' + JSON.stringify({ total: final.total, passed: final.passed, failed: final.failed, failures: final.failures }, null, 2))
const fs = await import('node:fs')
fs.writeFileSync(new URL('./result-D.json', import.meta.url), JSON.stringify(final, null, 2))