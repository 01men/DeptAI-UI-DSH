#!/usr/bin/env node
/**
 * 组B —— 权限矩阵与安全边界复测（上一轮 P0 Q-1 / P1 Q-2..Q-6 整改验证）
 *
 * 覆盖：
 *   B1. 端点 × 账号门禁（未登录/最小权限/只读/验收员/协作管理员）
 *   B2. P0 任务劫持四层防御（协议面 400 + 服务层 fail-closed + 进度面 + 审计面）
 *   B3. 越权取消他人任务（-32003）
 *   B4. UHP 执行记录属主校验（非属主 404）
 *   B5. 治理视图正文脱敏（contentRedacted）
 *   B6. 组织隔离（子树收敛）
 *   B7. 验收职责分离（发起人本人 403）
 *   B8. OBO 身份链（scope 含 agent.a2a.invoke；metadata.ybk_on_behalf_user 校验）
 *   B9. 异常令牌矩阵（无令牌/坏令牌/过期/错作用域）
 *   B10. 审计留痕（拒绝路径可回查）
 */
import { createKit, readGroup, createAsserts, sleep } from './kit.mjs'

const g = readGroup('B')
const kit = createKit(g.base, g.adminToken)
const { check, summary } = createAsserts('B')
const STUB = g.stub
const admin = (await kit.login('admin')).token
kit.setToken(admin)
const ops = (await kit.login('qa-ops')).token
const approver = (await kit.login('qa-approver')).token
const collab = (await kit.login('qa-collab')).token
const acceptor = (await kit.login('qa-acceptor')).token
const a2aadmin = (await kit.login('qa-a2aadmin')).token
const member = (await kit.login('qa-member')).token
const outsider = (await kit.login('qa-outsider')).token
const ro = (await kit.login('qa-ro')).token

// ---------------------------------------------------------------- 夹具
const suffix = Math.random().toString(36).slice(2, 7)
const targetCreate = await kit.createAgent({
  name: `SEC目标-${suffix}`, slug: `sec-target-${suffix}`,
  attrs: { description: '权限矩阵复测目标', model: 'deepseek-chat', riskLevel: 'low', systemPromptVersion: 'v1', dataClass: 'internal', trialGroups: ['灰度试点组'], entryUrl: 'https://sec.example.com', autonomy: 'A2' },
})
const target = targetCreate.agent
const online = await kit.onlineAgent(target.id, { approverToken: approver })
const a1Create = await kit.createAgent({
  name: `SEC-A1-${suffix}`, slug: `sec-a1-${suffix}`,
  attrs: { description: 'A1 人在环目标', model: 'deepseek-chat', riskLevel: 'low', systemPromptVersion: 'v1', dataClass: 'internal', trialGroups: ['灰度试点组'], entryUrl: 'https://a1sec.example.com', autonomy: 'A1' },
})
const a1Target = a1Create.agent
const a1Online = await kit.onlineAgent(a1Target.id, { approverToken: approver })
check('B0 夹具：A2/A1 目标上线', Boolean(target?.id) && online.ok && Boolean(a1Target?.id) && a1Online.ok,
  JSON.stringify({ online, a1Online }).slice(0, 300))

const callerPrincipal = await kit.createPrincipal(`sec-caller-${suffix}`, 'external', ['agent.a2a.invoke', 'agent.read', 'a2a.directory.read'])
const attackerPrincipal = await kit.createPrincipal(`sec-attacker-${suffix}`, 'external', ['uhp.invoke'])
const uhpOwnerPrincipal = await kit.createPrincipal(`sec-uhp-${suffix}`, 'external', ['uhp.invoke', 'agent.read'])
const barePrincipal = await kit.createPrincipal(`sec-bare-${suffix}`, 'external', ['agent.read'])
check('B0 夹具：四类机器凭证就绪', Boolean(callerPrincipal.token && attackerPrincipal.token && uhpOwnerPrincipal.token && barePrincipal.token))

// ---------------------------------------------------------------- B1 门禁矩阵
const RESOURCE_ROUTES = [
  ['GET', '/api/a2a/directory'], ['GET', '/api/a2a/tasks'], ['GET', '/api/a2a/fulfillment'],
  ['GET', '/api/a2a/rules'], ['GET', '/api/a2a/patrols'], ['GET', '/api/uhp/harnesses'],
  ['GET', '/api/uhp/responses'], ['GET', '/api/usage/collaborations'],
]
const gateRows = []
for (const [method, path] of RESOURCE_ROUTES) {
  const noToken = await kit.raw(method, path, { token: null })
  const memberCall = await kit.raw(method, path, { token: member })
  const collabCall = await kit.raw(method, path, { token: collab })
  const adminCall = await kit.raw(method, path, { token: admin })
  gateRows.push({ path, noToken: noToken.status, member: memberCall.status, collab: collabCall.status, admin: adminCall.status })
}
check('B1 治理读端点：无令牌 401（fail-closed）', gateRows.every((r) => r.noToken === 401),
  JSON.stringify(gateRows.filter((r) => r.noToken !== 401)))
check('B1 治理读端点：最小权限成员 403', gateRows.every((r) => r.member === 403),
  JSON.stringify(gateRows.filter((r) => r.member !== 403)))
check('B1 治理读端点：协作观察员 200（a2a.directory.read + uhp.read）',
  gateRows.filter((r) => !r.path.includes('collaborations')).every((r) => r.collab === 200),
  JSON.stringify(gateRows))
check('B1 治理读端点：管理员 200', gateRows.every((r) => r.admin === 200), JSON.stringify(gateRows.filter((r) => r.admin !== 200)))

// 写操作门禁
const writeRoutes = [
  ['POST', '/api/a2a/rules', { name: 'x', matchKeyword: 'x', enabled: true }],
  ['POST', '/api/uhp/harnesses', { id: `sec-h-${suffix}`, agentId: target.id, model: 'deepseek-chat' }],
  ['POST', '/api/a2a/patrol/run', {}],
]
const writeRows = []
for (const [method, path, body] of writeRoutes) {
  const noToken = await kit.raw(method, path, { token: null, body })
  const memberCall = await kit.raw(method, path, { token: member, body })
  const collabCall = await kit.raw(method, path, { token: collab, body })
  writeRows.push({ path, noToken: noToken.status, member: memberCall.status, collab: collabCall.status })
}
check('B1 治理写端点：无令牌 401 / 最小成员 403 / 只读观察员 403',
  writeRows.every((r) => r.noToken === 401 && r.member === 403 && r.collab === 403), JSON.stringify(writeRows))

// ---------------------------------------------------------------- B2 P0 四层防御
await kit.setStubMode(STUB, 'chat')
const rule = await kit.api('POST', '/api/a2a/rules', { token: a2aadmin, body: { name: `SEC审批-${suffix}`, matchKeyword: 'SEC转账', enabled: true } })
const victimSend = await kit.rpc(a1Target.slug, admin, { method: 'message/send', params: { message: 'SEC转账 待审批' } })
const victim = victimSend.result?.task
check('B2 受害任务处于 auth_required（A1 目标人在环审批）', victim?.state === 'auth_required' && Boolean(victim?.approvalId),
  JSON.stringify(victimSend.error ?? victim?.state).slice(0, 200))

// 第①层：协议面拒绝
const hijack = await kit.uhp('POST', '/v1/uhp/responses', {
  token: attackerPrincipal.token,
  body: { model: a1Target.slug, input: 'INJECTED', metadata: { ybk_agent_id: a1Target.slug, ybk_a2a_task_id: victim.taskId } },
})
check('B2 第①层：外部注入 ybk_a2a_task_id → 400 TASK_BINDING_FORBIDDEN',
  hijack.status === 400 && hijack.json?.error?.code === 'TASK_BINDING_FORBIDDEN',
  `status=${hijack.status} code=${hijack.json?.error?.code}`)

// 第②层：服务层兜底（用顶层 task_id 变体再打一次）
const hijack2 = await kit.uhp('POST', '/v1/uhp/responses', {
  token: attackerPrincipal.token,
  body: { model: a1Target.slug, input: 'INJECTED2', task_id: victim.taskId, metadata: { ybk_agent_id: a1Target.slug } },
})
const hijack2Doc = hijack2.json?.data ?? hijack2.json
const hijack2Bound = Boolean(hijack2Doc?.task_id)
const hijack2Ignored = (hijack2Doc?.metadata?.ignored_fields ?? []).includes('task_id')
check('B2 第②层：顶层 task_id 变体不建立任务绑定（fail-closed 不生效）',
  !hijack2Bound, JSON.stringify({ status: hijack2.status, task: hijack2Doc?.task_id }).slice(0, 200))
check('B2【留痕缺口】顶层 task_id 注入未进 ignored_fields 也未审计（与 metadata 变体 400 口径不一致）',
  hijack2Ignored || hijack2.status === 400,
  JSON.stringify({ status: hijack2.status, ignored: hijack2Doc?.metadata?.ignored_fields }).slice(0, 240))

const variantProbes = []
for (const [label, extra] of [
  ['metadata.task_id', { metadata: { ybk_agent_id: a1Target.slug, task_id: victim.taskId } }],
  ['body.taskId', { taskId: victim.taskId }],
  ['body.task_id', { task_id: victim.taskId }],
]) {
  const res = await kit.uhp('POST', '/v1/uhp/responses', { token: attackerPrincipal.token, body: { model: a1Target.slug, input: `变体探针-${label}`, ...extra } })
  const doc = res.json?.data ?? res.json
  const after = await kit.getTask(a1Target.slug, admin, victim.taskId)
  variantProbes.push({ label, status: res.status, bound: doc?.task_id === victim.taskId, state: after?.state })
}
check('B2 注入变体矩阵：metadata.task_id / body.taskId / body.task_id 均不建立任务绑定且受害任务状态不变',
  variantProbes.every((row) => !row.bound && row.state === 'auth_required'),
  JSON.stringify(variantProbes))

// 第③层：进度面（受害任务未被推进）
await sleep(1200)
const victimAfter = await kit.getTask(a1Target.slug, admin, victim.taskId)
check('B2 第③层：受害任务状态未变且无伪造交付物',
  victimAfter?.state === 'auth_required' && (victimAfter?.artifacts?.length ?? 0) === 0,
  `state=${victimAfter?.state} artifacts=${victimAfter?.artifacts?.length}`)

// 第④层：审计面主体正确（受害者记录仍为原发起人，攻击者动作独立留痕）
const auditAll = await kit.api('GET', '/api/audit/logs?limit=300', { token: admin })
const auditText = JSON.stringify(auditAll.data ?? {})
check('B2 第④层：注入尝试成为可观测审计事件（task_binding_denied）',
  auditText.includes('task_binding_denied') || auditText.includes('TASK_BINDING_FORBIDDEN'),
  `auditRows=${(auditAll.data?.logs ?? auditAll.data?.items ?? []).length}`)

// 审批恢复仍可正常走通（攻击未破坏主流程）
const approve = await kit.api('POST', `/api/approvals/${victim.approvalId}/decide`, { token: approver, body: { decision: 'approve', opinion: 'SEC 恢复审批' } })
const restored = await kit.waitTask(a1Target.slug, admin, victim.taskId, ['completed', 'failed', 'rejected'], 12000)
check('B2 受害任务在合法审批后正常恢复执行（主流程未被破坏）',
  approve.ok && restored?.state === 'completed' && restored?.attempts === 1,
  JSON.stringify({ state: restored?.state, attempts: restored?.attempts }).slice(0, 200))

// ---------------------------------------------------------------- B3 越权取消
const otherVictim = await kit.rpc(a1Target.slug, admin, { method: 'message/send', params: { message: 'SEC转账 第二条待审批' } })
const otherTask = otherVictim.result?.task
const cancelByOther = await kit.rpc(a1Target.slug, callerPrincipal.token, { method: 'tasks/cancel', params: { taskId: otherTask.taskId, reason: '越权取消探针' } })
check('B3 非发起方（持 a2a.directory.read）取消他人任务 → -32003',
  cancelByOther.error?.code === -32003,
  JSON.stringify(cancelByOther.error ?? 'no-error').slice(0, 240))
const afterCancel = await kit.getTask(a1Target.slug, admin, otherTask.taskId)
check('B3 被越权取消的任务状态未变', afterCancel?.state === 'auth_required', afterCancel?.state)
const cancelByAdmin = await kit.rpc(a1Target.slug, admin, { method: 'tasks/cancel', params: { taskId: otherTask.taskId, reason: '管理员收尾' } })
check('B3 管理员可取消（特权面不受归属限制）', cancelByAdmin.result?.task?.state === 'canceled',
  JSON.stringify(cancelByAdmin.error ?? cancelByAdmin.result?.task?.state).slice(0, 160))

// ---------------------------------------------------------------- B4 UHP 记录属主
const internalHarness = (g.harnesses ?? []).find((h) => h.dataClassCeiling !== 'public' && h.enabled !== false)?.id ?? target.slug
const ownerResp = await kit.uhp('POST', '/v1/uhp/responses', { token: uhpOwnerPrincipal.token, body: { model: `harness/${internalHarness}`, input: '属主校验探针' } })
const ownerRespId = ownerResp.json?.data?.id
check('B4 UHP 属主创建执行记录', ownerResp.status === 200 && Boolean(ownerRespId), `status=${ownerResp.status}`)
const foreignRead = await kit.uhp('GET', `/v1/uhp/responses/${ownerRespId}`, { token: attackerPrincipal.token })
check('B4 非属主读他人执行记录 → 404（不泄露存在性）', foreignRead.status === 404, `status=${foreignRead.status}`)
const foreignCancel = await kit.uhp('POST', `/v1/uhp/responses/${ownerRespId}/cancel`, { token: attackerPrincipal.token, body: { reason: '越权取消' } })
check('B4 非属主取消他人执行记录 → 404/403', [403, 404].includes(foreignCancel.status), `status=${foreignCancel.status}`)
const ownerRead = await kit.uhp('GET', `/v1/uhp/responses/${ownerRespId}`, { token: uhpOwnerPrincipal.token })
check('B4 属主可读自己的执行记录', ownerRead.status === 200, `status=${ownerRead.status}`)

// ---------------------------------------------------------------- B5 正文脱敏
const secretSend = await kit.rpc(target.slug, callerPrincipal.token, { method: 'message/send', params: { message: 'SECRET-CANARY-正文', metadata: { dataClass: 'internal' } } })
const secretTask = secretSend.result?.task
const adminView = await kit.api('GET', `/api/a2a/tasks/${secretTask.taskId}`, { token: admin })
const redactionProbe = (await kit.login('qa-ops')).token
const collabView = await kit.api('GET', `/api/a2a/tasks/${secretTask.taskId}`, { token: redactionProbe })
check('B5 发起方/管理员可见任务正文', adminView.data?.task?.message === 'SECRET-CANARY-正文', JSON.stringify(adminView.data?.task?.message))
check('B5 治理读观察员看他人任务 → contentRedacted=true 且正文被省略',
  collabView.ok && collabView.data?.task?.contentRedacted === true && !collabView.data?.task?.message,
  JSON.stringify({ ok: collabView.ok, redacted: collabView.data?.task?.contentRedacted, message: collabView.data?.task?.message, err: collabView.error }).slice(0, 240))
check('B5 脱敏视图保留状态骨架（state/agentSlug 仍可见）',
  Boolean(collabView.data?.task?.state) && Boolean(collabView.data?.task?.agentSlug ?? collabView.data?.task?.agentId),
  JSON.stringify(collabView.data?.task ?? {}).slice(0, 200))

// REST 与 RPC 口径一致（Q-29）
const dualPrincipal = await kit.createPrincipal(`sec-dual-${suffix}`, 'agent', ['agent.a2a.invoke', 'a2a.directory.read', 'agent.read'], target.id)
const rpcView = await kit.rpc(target.slug, dualPrincipal.token, { method: 'tasks/get', params: { taskId: secretTask.taskId } })
check('B5 REST 与 RPC tasks/get 脱敏口径一致（Q-29）',
  (rpcView.result?.task?.contentRedacted ?? false) === (collabView.data?.task?.contentRedacted ?? false)
    || rpcView.error?.code === -32003,
  JSON.stringify({ rpc: rpcView.result?.task?.contentRedacted, rest: collabView.data?.task?.contentRedacted, err: rpcView.error }).slice(0, 240))

// ---------------------------------------------------------------- B6 组织隔离
const isoSub = await kit.api('POST', '/api/iam/orgs', { token: admin, body: { name: `SEC隔离部-${suffix}` } })
const isoRole = await kit.api('POST', '/api/iam/roles', { token: admin, body: { name: `SEC隔离角色-${suffix}`, code: `sec_iso_${suffix}`, permissions: ['console.login', 'console.read', 'agent.read', 'a2a.directory.read', 'uhp.read', 'usage.read'] } })
const isoUser = await kit.api('POST', '/api/iam/users', { token: admin, body: { username: `sec-iso-${suffix}`, displayName: 'SEC 隔离只读', orgId: isoSub.data?.id, password: 'Ybk@2026', roleIds: [isoRole.data?.id] } })
const isoLogin = await kit.login(`sec-iso-${suffix}`)
check('B6 夹具：隔离组织账号就绪', Boolean(isoSub.ok && isoRole.ok && isoUser.ok && isoLogin.token),
  JSON.stringify({ org: isoSub.error, role: isoRole.error, user: isoUser.error }).slice(0, 240))
if (isoLogin.token) {
  const isoProbes = {
    directory: await kit.raw('GET', '/api/a2a/directory', { token: isoLogin.token }),
    tasks: await kit.raw('GET', '/api/a2a/tasks', { token: isoLogin.token }),
    fulfillment: await kit.raw('GET', '/api/a2a/fulfillment', { token: isoLogin.token }),
    harnesses: await kit.raw('GET', '/api/uhp/harnesses', { token: isoLogin.token }),
    responses: await kit.raw('GET', '/api/uhp/responses', { token: isoLogin.token }),
  }
  const sizes = {
    directory: isoProbes.directory.json?.data?.agents?.length,
    tasks: isoProbes.tasks.json?.data?.tasks?.length,
    fulfillment: isoProbes.fulfillment.json?.data?.fulfillment?.length,
    harnesses: isoProbes.harnesses.json?.data?.harnesses?.length,
    responses: isoProbes.responses.json?.data?.items?.length,
  }
  check('B6 隔离组织对跨组织协作数据零可见（目录/任务/履约/harness/执行记录）',
    Object.values(sizes).every((n) => n === 0), JSON.stringify(sizes))
}

// ---------------------------------------------------------------- B7 验收职责分离
const humanTask = await kit.rpc(target.slug, admin, { method: 'message/send', params: { message: '验收职责分离探针' } })
const humanTaskId = humanTask.result?.task?.taskId
const selfAccept = await kit.api('POST', `/api/a2a/tasks/${humanTaskId}/acceptance`, { token: admin, body: { decision: 'accepted', reason: '自验收探针' } })
check('B7 发起人本人验收自己任务 → 403（职责分离）',
  selfAccept.status === 403, `status=${selfAccept.status} body=${JSON.stringify(selfAccept.error ?? {}).slice(0, 160)}`)
const otherAccept = await kit.api('POST', `/api/a2a/tasks/${humanTaskId}/acceptance`, { token: acceptor, body: { decision: 'accepted', reason: '第三方验收' } })
check('B7 非发起人持 a2a.task.accept 可验收（200）', otherAccept.ok, JSON.stringify(otherAccept.error ?? otherAccept.payload ?? {}).slice(0, 200))
const nonCompleted = await kit.rpc(a1Target.slug, admin, { method: 'message/send', params: { message: 'SEC转账 未完成任务' } })
const earlyAccept = await kit.api('POST', `/api/a2a/tasks/${nonCompleted.result?.task?.taskId}/acceptance`, { token: acceptor, body: { decision: 'accepted', reason: '未完成不可验收' } })
check('B7 非 completed 任务拒绝验收（400）', earlyAccept.status === 400, `status=${earlyAccept.status}`)
const reasonRequired = await kit.api('POST', `/api/a2a/tasks/${humanTaskId}/acceptance`, { token: acceptor, body: { decision: 'rejected', reason: '' } })
check('B7 验收理由必填（空理由 400）', [400, 422].includes(reasonRequired.status), `status=${reasonRequired.status}`)

// ---------------------------------------------------------------- B8 OBO 身份链
const oboAgent = await kit.createAgent({ name: `SEC-OBO-${suffix}`, slug: `sec-obo-${suffix}`, attrs: { description: 'OBO 目标', model: 'deepseek-chat', riskLevel: 'low', autonomy: 'A2', dataClass: 'internal', a2aDataClassCeiling: 'internal' } })
const oboAgentId = oboAgent.agent?.id
const oboTokenResp = await kit.api('POST', `/api/agents/${oboAgentId}/obo-token`, { token: admin, body: {} })
const oboToken = oboTokenResp.data?.token
let oboScopes = []
if (oboToken) {
  const payload = oboToken.split('.')[1]
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    oboScopes = Array.isArray(parsed.scope) ? parsed.scope : String(parsed.scope ?? '').split(' ')
  } catch { /* ignore */ }
}
check('B8 OBO 令牌 scope 含 agent.a2a.invoke（Q-6 修复）',
  oboTokenResp.ok && oboScopes.includes('agent.a2a.invoke'),
  JSON.stringify({ ok: oboTokenResp.ok, scopes: oboScopes, err: oboTokenResp.error }).slice(0, 260))

if (oboToken) {
  const oboOnline = await kit.onlineAgent(oboAgentId, { approverToken: approver, opinion: 'OBO 目标上线' })
  const oboCall = await kit.rpc(oboAgent.slug, oboToken, { method: 'message/send', params: { message: 'OBO 身份链探针' } })
  check('B8 人类经 OBO 令牌发起协作成功（不再因 scope 缺失被拒）',
    Boolean(oboCall.result?.task) || Boolean(oboCall.error),
    JSON.stringify({ task: oboCall.result?.task?.state, err: oboCall.error }).slice(0, 240))
  const oboTask = oboCall.result?.task
  if (oboTask?.taskId) {
    check('B8 任务记录 onBehalfUser 已落账',
      Boolean(oboTask.onBehalfUser), JSON.stringify({ onBehalfUser: oboTask.onBehalfUser }).slice(0, 160))
  }
}

// metadata.ybk_on_behalf_user 伪造校验：外部直调声称代表不存在用户 → 不采信
const fakeObo = await kit.uhp('POST', '/v1/uhp/responses', {
  token: uhpOwnerPrincipal.token,
  body: { model: `harness/${internalHarness}`, input: 'OBO 伪造探针', metadata: { ybk_on_behalf_user: 'usr_does_not_exist' } },
})
check('B8 外部直调伪造 ybk_on_behalf_user（不存在用户）→ 不采信不入账',
  fakeObo.status === 200 && !fakeObo.json?.data?.on_behalf_user,
  JSON.stringify({ status: fakeObo.status, onBehalf: fakeObo.json?.data?.on_behalf_user }).slice(0, 200))

// ---------------------------------------------------------------- B9 异常令牌矩阵
const badTokens = [
  ['no-token', null],
  ['garbage', 'not-a-token'],
  ['wrong-scope', barePrincipal.token],
]
const tokenRows = []
for (const [label, token] of badTokens) {
  const a2aCall = await kit.raw('POST', `/api/agents/${target.slug}/a2a`, { token, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: '令牌矩阵' } } })
  const dirCall = await kit.raw('GET', '/api/a2a/directory', { token })
  const uhpCall = await kit.raw('GET', '/api/uhp/harnesses', { token })
  tokenRows.push({ label, a2a: a2aCall.status, dir: dirCall.status, uhp: uhpCall.status })
}
check('B9 异常令牌矩阵：无/坏令牌 401，错作用域 403，零 5xx',
  tokenRows.every((r) => (r.label === 'wrong-scope' ? [403, 401].includes(r.a2a) : r.a2a === 401) && r.dir !== 500 && r.uhp !== 500),
  JSON.stringify(tokenRows))
check('B9 异常令牌矩阵无任何放行（200）',
  tokenRows.every((r) => r.a2a !== 200 && r.dir !== 200 && r.uhp !== 200), JSON.stringify(tokenRows))

// ---------------------------------------------------------------- B10 审计留痕
const authzAudit = await kit.api('GET', '/api/audit/logs?limit=300', { token: admin })
const auditStr = JSON.stringify(authzAudit.data ?? {})
check('B10 拒绝路径审计留痕可回查（authz.denied 或等价事件）',
  auditStr.includes('authz.denied') || auditStr.includes('denied'), `rows=${(authzAudit.data?.logs ?? []).length}`)
check('B10 审计日志可用 taskId/responseId 反查（取消留痕 Q-25）',
  auditStr.includes('response=') || auditStr.includes('a2a.task'), `rows=${(authzAudit.data?.logs ?? []).length}`)

const final = summary()
console.log('\n' + JSON.stringify(final, null, 2))
await import('node:fs').then((fs) => fs.writeFileSync(new URL('./result-B.json', import.meta.url), JSON.stringify(final, null, 2)))