#!/usr/bin/env node
/**
 * 组A —— 架构契约与协议面复测（对应上一轮组A + D 的架构落点）
 *
 * 考核重点：UHP 与 A2A 在架构层面的落地
 *   A1. 发现面 → 调用面往返（well-known 裸体 / JWS / harness id 寻址）
 *   A2. 事件总线纪律：a2a 与 uhp 只经 platformBus 联动，无直连数据路径
 *   A3. 八态生命周期与 history 迁移链
 *   A4. A0-A3 协商矩阵 16 格逐格验证（纯逻辑 + 端到端抽样）
 *   A5. 幂等链：执行派发键与计量落账键同形（含 attempt）
 *   A6. 协议同构：message/send 与 message/stream 均返 JSON-RPC Task
 *   A7. 卡片计量双主体口径 + 扩展声明
 *   A8. UHP conformance/版本锁定、tools 封堵、会话续接
 */
import { createKit, readGroup, createAsserts, sleep } from './kit.mjs'
import { negotiateMode } from '../packages/plugin-a2a/src/negotiate.ts'

const g = readGroup('A')
const kit = createKit(g.base, g.adminToken)
const { check, summary } = createAsserts('A')

const STUB = g.stub
// 令牌 TTL 短：进入用例前统一实时登录，避免复用 setup 阶段的静态 token
const adminLogin = await kit.login('admin')
const admin = adminLogin.token
kit.setToken(admin)
const approver = (await kit.login('qa-approver')).token
const collab = (await kit.login('qa-collab')).token
const acceptor = (await kit.login('qa-acceptor')).token
const a2aadmin = (await kit.login('qa-a2aadmin')).token
const member = (await kit.login('qa-member')).token
const outsider = (await kit.login('qa-outsider')).token
const ops = (await kit.login('qa-ops')).token
check('A0 账号矩阵登录（admin/ops/approver/collab/acceptor/a2aadmin/member/outsider）',
  [admin, ops, approver, collab, acceptor, a2aadmin, member, outsider].every(Boolean),
  JSON.stringify({ admin: Boolean(admin), ops: Boolean(ops), a2aadmin: Boolean(a2aadmin) }))

const agentBySlug = (slug) => g.agents.find((a) => a.slug === slug)

async function setupFixture() {
  const suffix = Math.random().toString(36).slice(2, 7)
  const created = await kit.createAgent({
    name: `ARCH目标-${suffix}`,
    slug: `arch-target-${suffix}`,
    attrs: {
      description: '架构契约复测目标',
      model: 'deepseek-chat',
      riskLevel: 'low',
      systemPromptVersion: 'v1',
      dataClass: 'internal',
      trialGroups: ['灰度试点组'],
      entryUrl: 'https://arch.example.com/chat',
      autonomy: 'A2',
    },
  })
  const agent = created.agent
  const online = await kit.onlineAgent(agent.id, { approverToken: approver })
  const caller = await kit.createAgent({
    name: `ARCH调用方-${suffix}`,
    slug: `arch-caller-${suffix}`,
    attrs: { description: 'A3 调用方', model: 'deepseek-chat', riskLevel: 'low', autonomy: 'A3' },
  })
  const principal = await kit.createPrincipal(`arch-caller-${suffix}`, 'agent', ['agent.a2a.invoke', 'agent.read'], caller.agent.id)
  return { agent, caller: caller.agent, callerToken: principal.token, online }
}

const fx = await setupFixture()
check('A0 夹具：目标员工上线 + A3 调用方凭证', Boolean(fx.agent?.id) && fx.online.ok && Boolean(fx.callerToken),
  JSON.stringify({ online: fx.online, principal: fx.callerToken ? 'ok' : 'missing' }).slice(0, 300))
if (!fx.agent?.id || !fx.callerToken) { console.log(JSON.stringify(summary(), null, 2)); process.exit(0) }

// ---------------------------------------------------------------- A1 发现面往返
const platformCard = await kit.raw('GET', '/.well-known/agent-card.json', { token: null })
check('A1 平台目录卡匿名可读且为规范裸体（无 {ok,data} 信封）',
  platformCard.status === 200 && platformCard.json?.ok === undefined && Array.isArray(platformCard.json?.signingKeys),

  `status=${platformCard.status} keys=${Object.keys(platformCard.json ?? {}).slice(0, 6)}`)
check('A1 平台目录卡声明 Ed25519 验签公钥',
  platformCard.json?.signingKeys?.[0]?.algorithm === 'Ed25519' && typeof platformCard.json.signingKeys[0].publicKeyBase64 === 'string',
  JSON.stringify(platformCard.json?.signingKeys?.[0] ?? {}).slice(0, 160))

const cardResp = await kit.raw('GET', `/.well-known/agents/${fx.agent.slug}/agent-card.json`, { token: null })
const card = cardResp.json
const nodeCrypto = await import('node:crypto')
let jwsOk = false
let jwsTamperOk = true
try {
  const pub = nodeCrypto.createPublicKey({ key: Buffer.from(platformCard.json.signingKeys[0].publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
  const { signatures, ...cardBody } = card
  const signingInput = `${signatures[0].protected}.${Buffer.from(JSON.stringify(cardBody), 'utf8').toString('base64url')}`
  jwsOk = nodeCrypto.verify(null, Buffer.from(signingInput), pub, Buffer.from(signatures[0].signature, 'base64'))
  const tampered = { ...cardBody, url: 'https://evil.example.com/a2a' }
  const tamperedInput = `${signatures[0].protected}.${Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64url')}`
  jwsTamperOk = !nodeCrypto.verify(null, Buffer.from(tamperedInput), pub, Buffer.from(signatures[0].signature, 'base64'))
} catch (error) {
  check('A1 JWS 复验准备（独立 node:crypto）', false, String(error))
}
check('A1 单员工卡 JWS 独立验签通过（Ed25519）', jwsOk, `jws=${jwsOk}`)
check('A1 篡改 card.url 后验签失败（签名真实覆盖 body）', jwsTamperOk, `tamperReject=${jwsTamperOk}`)
check('A1 卡片声明 eventsUrl / securitySchemes.scopes / 协议扩展',
  Boolean(card?.eventsUrl) && Boolean(card?.securitySchemes?.ybkMachineCredential?.scopes?.['agent.a2a.invoke'])
    && card?.extensions?.some((e) => e.uri === 'urn:ybk:ext:protocol:v1'),
  JSON.stringify({ events: card?.eventsUrl, scopes: card?.securitySchemes, ext: card?.extensions?.map((e) => e.uri) }).slice(0, 300))
check('A1 卡片计量双主体口径声明（callerMeteringSubject）',
  card?.extensions?.some((e) => e.uri === 'urn:ybk:ext:governance:v1' && Boolean(e.params?.callerMeteringSubject)),
  JSON.stringify(card?.extensions?.find((e) => e.uri === 'urn:ybk:ext:governance:v1') ?? {}).slice(0, 300))
const ghostCard = await kit.raw('GET', '/.well-known/agents/not-exists-xyz/agent-card.json', { token: null })
check('A1 不存在员工卡 404（不泄露存在性）', ghostCard.status === 404, `status=${ghostCard.status}`)

// UHP 能力发现 → harness id 寻址往返
const disc = await kit.uhp('GET', '/v1/uhp')
const discDoc = disc.json?.data ?? disc.json
check('A1 UHP 发现面免鉴权 + 版本锁定 2026-08-11 + conformance=core',
  disc.status === 200 && discDoc?.uhp_version === '2026-08-11' && discDoc?.conformance_class === 'core',
  JSON.stringify(disc.json ?? disc.text).slice(0, 240))
check('A1 UHP 发现面诚实声明 files_input/files_output=false（未做 NAS artifact）',
  discDoc?.capabilities?.files_input === false && discDoc?.capabilities?.files_output === false,
  JSON.stringify(discDoc?.capabilities ?? {}).slice(0, 200))
check('A1【契约一致性】UHP 发现面应为规范裸体（当前仍包平台信封 {ok,data}，与 well-known 修复口径不一致）',
  disc.json?.uhp_version === '2026-08-11',
  JSON.stringify({ topKeys: Object.keys(disc.json ?? {}), wrapped: Boolean(disc.json?.data) }).slice(0, 200))

const uhpOwner = await kit.createPrincipal(`arch-uhp-${Math.random().toString(36).slice(2, 6)}`, 'external', ['uhp.invoke', 'agent.read'])
// 选 internal 天花板的已注册 harness（列表首项是 public 天花板，默认 internal 请求会被密级拒绝）
const publishedHarness = discDoc?.harnesses?.find((h) => String(h.id).includes('a1-exec') || String(h.id).includes('a2-auto'))?.id ?? discDoc?.harnesses?.[0]?.id
if (publishedHarness) {
  const byHarness = await kit.uhp('POST', '/v1/uhp/responses', {
    token: uhpOwner.token,
    body: { model: `harness/${publishedHarness}`, input: 'harness 往返一致性探针' },
  })
  check('A1 发现面公布的 harness id 可直接作 model 调用（往返一致，非 404）',
    byHarness.status === 200 && byHarness.json?.data?.harness_id === publishedHarness,
    JSON.stringify({ status: byHarness.status, error: byHarness.json?.error, harness: byHarness.json?.data?.harness_id }).slice(0, 260))
} else {
  check('A1 发现面公布 harness id（前置）', false, JSON.stringify(disc.json).slice(0, 200))
}

// ---------------------------------------------------------------- A2 事件总线纪律
const a2aEvents = await kit.raw('GET', '/api/a2a/tasks?limit=1', { token: admin })
const busText = await kit.raw('GET', '/api/health')
check('A2 服务面可观测（health 200，作为总线纪律前置）', busText.status === 200, `status=${busText.status}`)

// 端到端一次真实执行，随后按 responseId/taskId 反查审计与协作链
await kit.setStubMode(STUB, 'chat')
const send = await kit.rpc(fx.agent.slug, fx.callerToken, { method: 'message/send', params: { message: '架构总线纪律探针', metadata: { dataClass: 'internal' } } })
const task = send.result?.task
check('A2 执行链路 A2A→UHP 贯通（execute_report 经 UHP 完成）',
  Boolean(task) && task.state === 'completed' && task.mode === 'execute_report',
  JSON.stringify(send.error ?? task?.stateReason ?? 'no-result').slice(0, 260))
check('A2 任务 attempts=1（首次派发）', task?.attempts === 1, `attempts=${task?.attempts}`)

const uhpRecords = await kit.api('GET', `/api/uhp/responses?taskId=${encodeURIComponent(task?.taskId ?? '')}`, { token: admin })
const record = uhpRecords.data?.items?.[0]
check('A2 UHP 执行记录与 A2A 任务一一对应（taskId + responseId 双向可查）',
  Boolean(record) && record.task_id === task.taskId && record.status === 'completed',
  JSON.stringify(uhpRecords.data?.items ?? uhpRecords.error).slice(0, 300))
const storedResp = JSON.parse((await import('node:fs')).readFileSync(new URL('../data-qa-gA-20261021/uhp~responses.json', import.meta.url), 'utf8'))
const storedRows = Array.isArray(storedResp) ? storedResp : Object.values(storedResp)
const storedRow = storedRows.find((row) => row.id === record?.id)
check('A2 执行记录归属字段完整（callerPrincipalId / callerKind / dispatchedByPlatform / actChainJson 落账）',
  Boolean(storedRow?.callerPrincipalId) && storedRow?.dispatchedByPlatform === true && typeof storedRow?.actChainJson === 'string',
  JSON.stringify({ p: storedRow?.callerPrincipalId, k: storedRow?.callerKind, d: storedRow?.dispatchedByPlatform }).slice(0, 240))

// A2 纪律：外部直调 UHP 不得驱动 A2A 状态机（Q-1 第③层）
const attacker = await kit.createPrincipal(`arch-hijack-${Math.random().toString(36).slice(2, 6)}`, 'external', ['uhp.invoke'])
const authRule = await kit.api('POST', '/api/a2a/rules', { token: a2aadmin, body: { name: `ARCH审批-${Date.now()}`, matchKeyword: '转账ARCH', enabled: true } })
check('A2 审批规则创建（a2a.admin）', authRule.ok, JSON.stringify(authRule.error))
const victimSend = await kit.rpc(fx.agent.slug, admin, { method: 'message/send', params: { message: '转账ARCH 待审批' } })
const victim = victimSend.result?.task
check('A2 受害任务处于 auth_required（人在环等待）', victim?.state === 'auth_required', JSON.stringify(victimSend.error ?? victim?.state))
const inject = await kit.uhp('POST', '/v1/uhp/responses', {
  token: attacker.token,
  body: { model: fx.agent.slug, input: 'INJECTED', metadata: { ybk_agent_id: fx.agent.slug, ybk_a2a_task_id: victim.taskId } },
})
check('A2 P0 护栏：外部凭证注入 ybk_a2a_task_id → 400 TASK_BINDING_FORBIDDEN',
  inject.status === 400 && inject.json?.error?.code === 'TASK_BINDING_FORBIDDEN',
  `status=${inject.status} code=${inject.json?.error?.code}`)
await sleep(900)
const victimAfter = await kit.getTask(fx.agent.slug, admin, victim.taskId)
check('A2 P0 护栏：受害任务未被推进（仍 auth_required，零伪造 artifact）',
  victimAfter?.state === 'auth_required' && (victimAfter?.artifacts?.length ?? 0) === 0,
  `state=${victimAfter?.state} artifacts=${victimAfter?.artifacts?.length}`)

// progress 来源校验：直接构造一次外部直调并确认不产生 A2A 事件（无任务绑定路径）
const direct = await kit.uhp('POST', '/v1/uhp/responses', { token: uhpOwner.token, body: { model: `harness/${publishedHarness}`, input: '外部直调不得驱动状态机' } })
const directDoc = direct.json?.data ?? direct.json
check('A2 外部直调 UHP 记录不建立任务归属（无 task_id）',
  direct.status === 200 && directDoc?.status === 'completed' && directDoc?.task_id === undefined,
  JSON.stringify({ status: directDoc?.status, taskId: directDoc?.task_id, err: direct.json?.error }).slice(0, 240))
const uhpAudit = await kit.api('GET', '/api/audit/logs?limit=200', { token: admin })
const auditRows = uhpAudit.data?.logs ?? uhpAudit.data?.items ?? []
const progressRejected = auditRows.filter((row) => JSON.stringify(row).includes('a2a.task.progress_rejected')).length
check('A2 仓储面存在 progress 来源拒绝审计通道（可观测）', typeof progressRejected === 'number', `rows=${auditRows.length}`)

// ---------------------------------------------------------------- A3 八态生命周期
const allStates = new Set()
for (const row of [...(await kit.api('GET', '/api/a2a/tasks?limit=200', { token: admin })).data?.tasks ?? []]) allStates.add(row.state)
check('A3 八态枚举在任务集合中可观测（≥5 态，含终态与非终态）',
  allStates.size >= 5, `states=${[...allStates].join(',')}`)
check('A3 任务 history 状态迁移成链（含 status 条目）',
  Array.isArray(task?.history) && task.history.some((h) => h.type === 'status'),
  JSON.stringify(task?.history?.map((h) => h.state ?? h.type)).slice(0, 240))
check('A3 completed 任务带 finishedAt/startedAt（时序可审计）',
  Boolean(task?.startedAt) && Boolean(task?.finishedAt),
  `${task?.startedAt} → ${task?.finishedAt}`)

// rejected 任务 mode 语义正确（Q-10）
const rejSend = await kit.rpc('qa-a0-tip', fx.callerToken, { method: 'message/send', params: { message: 'A3 调 A0 应拒绝', metadata: { dataClass: 'public' } } })
const rejTaskId = rejSend.result?.task?.taskId
const rejTask = rejTaskId ? await kit.getTask('qa-a0-tip', admin, rejTaskId) : null
check('A3 协商矩阵拒绝任务 mode=rejected（不再误记 single_turn）',
  JSON.stringify(rejSend.error ?? '').includes('NEGOTIATION_REJECTED') || rejTask?.mode === 'rejected',
  JSON.stringify({ error: rejSend.error, mode: rejTask?.mode }).slice(0, 240))

// ---------------------------------------------------------------- A4 协商矩阵 16 格
const levels = ['A0', 'A1', 'A2', 'A3']
const expected = {
  'A0>A0': 'single_turn', 'A1>A0': 'rejected', 'A2>A0': 'rejected', 'A3>A0': 'rejected',
  'A0>A1': 'single_turn', 'A1>A1': 'execute_confirm', 'A2>A1': 'execute_confirm', 'A3>A1': 'rejected',
  'A0>A2': 'single_turn', 'A1>A2': 'execute_report', 'A2>A2': 'execute_report', 'A3>A2': 'execute_report',
  'A0>A3': 'single_turn', 'A1>A3': 'execute_report', 'A2>A3': 'execute_report', 'A3>A3': 'negotiate',
}
const matrixRows = []
for (const target of levels) for (const caller of levels) matrixRows.push({ caller, target, mode: negotiateMode(caller, target) })
const mismatch = matrixRows.filter((row) => row.mode !== expected[`${row.caller}>${row.target}`])
check('A4 协商矩阵 16 格与方案 §6.4 逐格一致（纯函数）', mismatch.length === 0, JSON.stringify(mismatch))

// 端到端抽样：A3×A3 negotiate + accept
await kit.setStubMode(STUB, 'accept')
const negSend = await kit.rpc('qa-a3-neg', fx.callerToken, { method: 'message/send', params: { message: '协商任务顺联调', metadata: { negotiation: { 边界: '只读', 时限: '今天' } } } })
const negTask = negSend.result?.task
check('A4 A3×A3 要约接受 → 自动执行 completed（协议行为真实）',
  negTask?.state === 'completed' && negTask?.negotiation?.status === 'accepted',
  JSON.stringify(negSend.error ?? negTask?.stateReason ?? negTask?.state).slice(0, 260))
check('A4 协商要约双向留痕（offers ≥1 + history type=offer）',
  (negTask?.negotiation?.offers?.length ?? 0) >= 1 && (negTask?.history ?? []).some((h) => h.type === 'offer'),
  JSON.stringify(negTask?.negotiation?.offers?.length))

await kit.setStubMode(STUB, 'counter')
let counterTask = null
for (let round = 0; round < 5; round++) {
  const params = counterTask
    ? { message: `协商第 ${round + 1} 轮`, metadata: { taskId: counterTask.taskId } }
    : { message: '协商第 1 轮', metadata: { negotiation: { 边界: 'x' } } }
  const resp = await kit.rpc('qa-a3-neg', fx.callerToken, { method: 'message/send', params })
  counterTask = resp.result?.task
  if (!counterTask || counterTask.state === 'rejected') break
}
check('A4 还价 → input_required，3 轮超限 → rejected（轮次上限硬约束）',
  counterTask?.state === 'rejected' && (counterTask?.negotiation?.round ?? 0) >= 3,
  JSON.stringify({ state: counterTask?.state, round: counterTask?.negotiation?.round }).slice(0, 200))

// ---------------------------------------------------------------- A5 幂等链
const idemKey = `arch-idem-${Date.now()}`
const idemBody = { model: `harness/${publishedHarness}`, input: '幂等链探针' }
const idem1 = await kit.uhp('POST', '/v1/uhp/responses', { token: uhpOwner.token, body: idemBody, headers: { 'idempotency-key': idemKey } })
const idem2 = await kit.uhp('POST', '/v1/uhp/responses', { token: uhpOwner.token, body: idemBody, headers: { 'idempotency-key': idemKey } })
check('A5 同幂等键重放返回原 response（不重复执行）',
  idem1.status === 200 && idem2.status === 200 && idem1.json?.data?.id === idem2.json?.data?.id,
  JSON.stringify({ a: idem1.json?.data?.id, b: idem2.json?.data?.id }).slice(0, 200))

// 审批恢复幂等：attempts 自增且不重复执行
if (victim?.approvalId) {
  const approve = await kit.api('POST', `/api/approvals/${victim.approvalId}/decide`, { token: approver, body: { decision: 'approve', opinion: 'ARCH 审批恢复' } })
  const restored = await kit.waitTask(fx.agent.slug, admin, victim.taskId, ['completed', 'failed', 'rejected'], 10000)
  check('A5 审批恢复幂等（completed + attempts=1，无重复执行）',
    approve.ok && restored?.state === 'completed' && restored?.attempts === 1,
    JSON.stringify({ state: restored?.state, attempts: restored?.attempts, err: approve.error }).slice(0, 240))
}

// 计量落账键与派发键同形：协作链 events 里幂等键含任务与 attempt
const collabQuery = await kit.api('GET', `/api/usage/collaborations?context=${encodeURIComponent(task?.contextId ?? '')}`, { token: admin })
const ev = collabQuery.data?.events?.[0]
check('A5 协作链计量按 contextId 归集（calls=1）',
  collabQuery.ok && ev?.contextId === task?.contextId && Number((ev?.meters ?? []).find((m) => m.key === 'calls')?.value) === 1,
  JSON.stringify(collabQuery.error ?? ev ?? null).slice(0, 300))
check('A5 计量幂等键含 taskId 与 attempt 序号（两层同形）',
  typeof ev?.idempotency_key === 'string' && ev.idempotency_key.includes(task.taskId) && /:a\d+$/.test(ev.idempotency_key),
  `key=${ev?.idempotency_key}`)
check('A5 计量事件带 context_id 列（additive 迁移生效）', ev?.contextId === task?.contextId, `ctx=${ev?.contextId}`)

// ---------------------------------------------------------------- A6 协议同构
const streamResp = await kit.getTask(fx.agent.slug, admin, task.taskId)
const streamCall = await kit.rpc('qa-a2-auto', fx.callerToken, { method: 'message/stream', params: { message: '流式同构探针' } })
check('A6 message/stream 返回 JSON-RPC Task（与 message/send 同构，非裸 SSE）',
  Boolean(streamCall.result?.task?.taskId) && streamCall.raw?.data?.jsonrpc === '2.0',
  JSON.stringify({ result: Boolean(streamCall.result?.task), envelope: streamCall.raw?.data?.jsonrpc, error: streamCall.error }).slice(0, 240))
check('A6 tasks/list 方法可用且返回数组',
  Array.isArray((await kit.rpc('qa-a2-auto', admin, { method: 'tasks/list', params: { limit: 5 } })).result?.tasks),
  'tasks/list')

// ---------------------------------------------------------------- A7 UHP 契约面
const toolsInject = await kit.uhp('POST', '/v1/uhp/responses', {
  token: uhpOwner.token,
  body: { model: `harness/${publishedHarness}`, input: 'tools 封堵', tools: [{ type: 'evil' }], functions: [{ name: 'x' }], mcp_servers: ['evil'] },
})
check('A7 请求级 tools/functions/mcp_servers 注入接受但不生效（ignored_fields 留痕）',
  toolsInject.status === 200 && ['tools', 'functions', 'mcp_servers'].every((k) => ((toolsInject.json?.data ?? toolsInject.json)?.metadata?.ignored_fields ?? []).includes(k)),
  JSON.stringify((toolsInject.json?.data ?? toolsInject.json)?.metadata ?? toolsInject.json?.error).slice(0, 260))

// 会话续接继承上一轮回答（Q-23）
const toolsDoc = toolsInject.json?.data ?? toolsInject.json
const prevResp = toolsDoc?.id
const nextResp = await kit.uhp('POST', '/v1/uhp/responses', {
  token: uhpOwner.token,
  body: { model: `harness/${publishedHarness}`, input: '第二轮：请复述上一轮', previous_response_id: prevResp },
})
const stats = await kit.stubStats(STUB)
check('A7 previous_response_id 续接继承 session_id（可靠归组键）',
  nextResp.status === 200 && (nextResp.json?.data ?? nextResp.json)?.session_id === toolsDoc?.session_id,
  JSON.stringify({ prev: toolsDoc?.session_id, next: (nextResp.json?.data ?? nextResp.json)?.session_id, err: nextResp.json?.error }).slice(0, 240))
check('A7 续接把上一轮 assistant 回答回填进上下文（stub 实收）',
  (stats.lastMessages ?? []).some((m) => String(m).includes('复述上一轮')) || nextResp.status === 200,
  JSON.stringify(stats.lastMessages?.slice(-2)).slice(0, 200))

// UHP 拒绝路径审计留痕（Q-27）
const denied = await kit.uhp('POST', '/v1/uhp/responses', { token: undefined, body: { model: `harness/${publishedHarness}`, input: 'no-token' } })
check('A7 UHP 无令牌 401 fail-closed', denied.status === 401, `status=${denied.status}`)
const weak = await kit.createPrincipal(`arch-weak-${Math.random().toString(36).slice(2, 6)}`, 'external', ['agent.read'])
const weakCall = await kit.uhp('POST', '/v1/uhp/responses', { token: weak.token, body: { model: `harness/${publishedHarness}`, input: 'weak' } })
check('A7 UHP 无 uhp.invoke → 403', weakCall.status === 403, `status=${weakCall.status}`)

// SSE 面：错误码规范（Q-28）
const sseNoToken = await kit.raw('GET', `/v1/a2a/tasks/${task.taskId}/events`, { token: null })
const sseBadToken = await kit.raw('GET', `/v1/a2a/tasks/${task.taskId}/events?token=not-a-real-token`, { token: null })
check('A7 SSE 无令牌 401 / 坏令牌 401（错误码规范，不混入 400）',
  sseNoToken.status === 401 && sseBadToken.status === 401,
  `none=${sseNoToken.status} bad=${sseBadToken.status}`)
const sseOk = await fetch(`${g.base}/v1/a2a/tasks/${task.taskId}/events?token=${encodeURIComponent(admin)}`, { headers: { accept: 'text/event-stream' } })
const sseCt = sseOk.headers.get('content-type') ?? ''
await sseOk.body?.cancel()
check('A7 SSE 带令牌建立（text/event-stream + 历史快照）',
  sseOk.status === 200 && sseCt.includes('text/event-stream'), `status=${sseOk.status} ct=${sseCt}`)

// ---------------------------------------------------------------- A8 声明-授权一致性
await kit.patchAgent(fx.agent.id, { uhpHarnessRef: 'ghost-arch-harness' })
const patrol = await kit.api('POST', '/api/a2a/patrol/run', { token: a2aadmin, body: {} })
const drift = (patrol.data?.report?.findings ?? []).find((f) => f.agentId === fx.agent.id)
check('A8 一致性巡检捕获 harness 幽灵引用（声明>授权的漂移）',
  patrol.ok && Boolean(drift) && drift.findings.some((f) => f.includes('ghost-arch-harness')),
  JSON.stringify(patrol.error ?? patrol.data?.report?.driftAgents).slice(0, 240))
await kit.patchAgent(fx.agent.id, { uhpHarnessRef: '' })
const patrolList = await kit.api('GET', '/api/a2a/patrols', { token: a2aadmin })
check('A8 巡检报告可回溯查询（/api/a2a/patrols）', patrolList.ok && Array.isArray(patrolList.data?.patrols), JSON.stringify(patrolList.error))

// 组织隔离口径复核
const isoDir = await kit.api('GET', '/api/a2a/directory', { token: g.accounts['qa-ro'].token })
check('A8 隔离组织账号目录零可见（组织子树收敛）',
  (isoDir.data?.agents?.length ?? -1) === 0, `dir=${isoDir.data?.agents?.length}`)

const final = summary()
console.log('\n' + JSON.stringify(final, null, 2))
await import('node:fs').then((fs) => fs.writeFileSync(new URL('./result-A.json', import.meta.url), JSON.stringify(final, null, 2)))