#!/usr/bin/env node
/**
 * 组E —— 外部 Agent 层验收 + CLI 回归
 *
 *   E1. 零平台 SDK 的外部 Agent 客户端：只靠 Agent Card 完成 发现→派活→轮询→SSE→列举→流式→取消
 *   E2. 卡片签名可独立验签 + 篡改失效
 *   E3. 机器凭证轮换后旧 secret 失效、clientId 不变
 *   E4. OBO 身份链端到端（人类代表员工发起 → 审计可追）
 *   E5. dshctl CLI：a2a/uhp 子命令覆盖 + 上一轮 6 条遗留缺陷复测
 */
import { execFile } from 'node:child_process'
import { createKit, readGroup, createAsserts, sleep } from './kit.mjs'

const g = readGroup('E')
const kit = createKit(g.base, g.adminToken)
const { check, summary } = createAsserts('E')
const STUB = g.stub
const ROOT = new URL('..', import.meta.url).pathname
const admin = (await kit.login('admin')).token
kit.setToken(admin)
const ops = (await kit.login('qa-ops')).token
const approver = (await kit.login('qa-approver')).token
const a2aadmin = (await kit.login('qa-a2aadmin')).token

const runCli = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, ['cli/dshctl.mjs', ...args], {
    cwd: ROOT,
    env: { ...process.env, DSHCTL_URL: g.base, ...env },
    timeout: 30000,
  }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), raw: error }))
})

// ---------------------------------------------------------------- E1 零 SDK 客户端（仅 fetch + 卡片）
const suffix = Math.random().toString(36).slice(2, 7)
const cardAgent = await kit.createAgent({
  name: `E目标-${suffix}`, slug: `e-target-${suffix}`,
  attrs: { description: '外部 Agent 验收目标', model: 'deepseek-chat', riskLevel: 'low', systemPromptVersion: 'v1', dataClass: 'internal', trialGroups: ['灰度试点组'], entryUrl: 'https://e.example.com', autonomy: 'A2' },
})
const ea = cardAgent.agent
const online = await kit.onlineAgent(ea.id, { approverToken: approver })
const harness = await kit.api('POST', '/api/uhp/harnesses', { token: a2aadmin, body: { id: `e-h-${suffix}`, agentId: ea.id, model: 'deepseek-chat', dataClassCeiling: 'internal' } })
await kit.setStubMode(STUB, 'chat')
check('E0 夹具：目标上线 + harness 注册', Boolean(ea?.id) && online.ok && harness.ok,
  JSON.stringify({ online, harness: harness.error }).slice(0, 300))

// 外部客户端：零平台 SDK，只读卡片 + 协议面
const cardFetch = await fetch(`${g.base}/.well-known/agents/${ea.slug}/agent-card.json`)
const discovered = await cardFetch.json()
check('E1 只读 well-known 发现卡片（外部客户端零 SDK）',
  cardFetch.status === 200 && discovered?.name && Array.isArray(discovered?.skills),
  JSON.stringify({ status: cardFetch.status, name: discovered?.name }).slice(0, 200))
check('E1 卡片含调用所需的全部契约面（endpoint/eventsUrl/scopes/协议扩展）',
  Boolean(discovered?.url || discovered?.endpoints) && Boolean(discovered?.eventsUrl)
    && Boolean(discovered?.securitySchemes?.ybkMachineCredential?.scopes?.['agent.a2a.invoke']),
  JSON.stringify({ url: discovered?.url, events: discovered?.eventsUrl, schemes: Object.keys(discovered?.securitySchemes ?? {}) }).slice(0, 300))

// 仅凭卡片 + 机器凭证派活（不 import 任何平台模块）
const ext = await kit.createPrincipal(`e-ext-${suffix}`, 'external', ['agent.a2a.invoke', 'agent.read'])
const rpcCall = async (method, params) => {
  const res = await fetch(`${g.base}/api/agents/${encodeURIComponent(ea.slug)}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ext.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'ext-1', method, params }),
  })
  const payload = await res.json().catch(() => ({}))
  return { status: res.status, inner: payload?.data ?? payload, payload }
}
const dispatch = await rpcCall('message/send', { message: '外部客户端派活（零 SDK）' })
const extTask = dispatch.inner?.result?.task
check('E1 外部客户端派活成功（message/send → Task）',
  Boolean(extTask?.taskId) && extTask?.state === 'completed',
  JSON.stringify(dispatch.inner?.error ?? extTask?.state).slice(0, 260))

const poll = await rpcCall('tasks/get', { taskId: extTask.taskId })
const pollError = poll.inner?.error
check('E1 tasks/get 轮询返回同一任务终态（外部凭证可查自己发起的任务）',
  poll.inner?.result?.task?.taskId === extTask.taskId, JSON.stringify(pollError ?? {}).slice(0, 240))
check('E1【缺陷】外部 refType=external 凭证 dispatch 成功但 tasks/get 被组织判定拒绝（-32003）',
  !(pollError?.code === -32003 && pollError?.message?.includes('组织可见范围')),
  JSON.stringify(pollError ?? {}).slice(0, 240))
const list = await rpcCall('tasks/list', { limit: 5 })
check('E1 tasks/list 可列举（外部客户端）', Array.isArray(list.inner?.result?.tasks), JSON.stringify(list.inner?.error ?? {}).slice(0, 240))
check('E1【缺陷】外部凭证 tasks/list 看不到自己发起的任务（返回空集）',
  (list.inner?.result?.tasks ?? []).some((t) => t.taskId === extTask.taskId) || Array.isArray(list.inner?.result?.tasks) === false,
  JSON.stringify({ count: list.inner?.result?.tasks?.length }).slice(0, 200))

// SSE：仅用卡片给的 eventsUrl + token
const eventsUrl = new URL(discovered.eventsUrl.replace(/\{taskId\}|:taskId/, extTask.taskId), g.base)
const sseRes = await fetch(`${eventsUrl.toString()}${eventsUrl.search ? '&' : '?'}token=${encodeURIComponent(ext.token)}`, { headers: { accept: 'text/event-stream' } })
const sseCt = sseRes.headers.get('content-type') ?? ''
const sseReader = sseRes.body?.getReader()
let sseFirst = ''
if (sseReader) {
  const chunk = await Promise.race([sseReader.read(), sleep(1500).then(() => ({ value: undefined }))])
  sseFirst = chunk?.value ? Buffer.from(chunk.value).toString('utf8') : ''
  await sseReader.cancel().catch(() => {})
}
check('E1 SSE 事件流可按卡片地址建立（外部客户端）',
  sseRes.status === 200 && sseCt.includes('text/event-stream'),
  `status=${sseRes.status} ct=${sseCt} first=${sseFirst.slice(0, 100)}`)

const streamCall = await rpcCall('message/stream', { message: '外部客户端流式' })
check('E1 message/stream 返回 JSON-RPC Task（同构）',
  Boolean(streamCall.inner?.result?.task?.taskId), JSON.stringify(streamCall.inner?.error ?? streamCall.inner ?? {}).slice(0, 240))

await kit.setStubMode(STUB, 'chat')
const cancelTarget = await rpcCall('message/send', { message: '慢任务标记：外部客户端取消' })
const cancelTaskId = cancelTarget.inner?.result?.task?.taskId
const cancelCall = cancelTaskId ? await rpcCall('tasks/cancel', { taskId: cancelTaskId, reason: '外部客户端取消' }) : {}
check('E1 tasks/cancel 外部客户端可取消自己发起的任务',
  cancelCall.inner?.result?.task?.state === 'canceled' || cancelCall.inner?.error?.code === -32003,
  JSON.stringify(cancelCall.inner?.error ?? cancelCall.inner?.result?.task?.state ?? {}).slice(0, 240))
if (cancelCall.inner?.result?.task?.state !== 'canceled') {
  check('E1【越权口径】外部客户端取消自己任务被拒（应允许）', false, JSON.stringify(cancelCall.inner?.error).slice(0, 200))
}

// 签名独立验证 + 篡改
const cardBody = await fetch(`${g.base}/.well-known/agent-card.json`).then((r) => r.json())
const crypto = await import('node:crypto')
let verifyOk = false
let tamperRejected = false
try {
  const pub = crypto.createPublicKey({ key: Buffer.from(cardBody.signingKeys[0].publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
  const { signatures, ...rest } = discovered
  const input = `${signatures[0].protected}.${Buffer.from(JSON.stringify(rest)).toString('base64url')}`
  verifyOk = crypto.verify(null, Buffer.from(input), pub, Buffer.from(signatures[0].signature, 'base64'))
  const tampered = { ...rest, name: 'tampered-name' }
  const tamperedInput = `${signatures[0].protected}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}`
  tamperRejected = !crypto.verify(null, Buffer.from(tamperedInput), pub, Buffer.from(signatures[0].signature, 'base64'))
} catch (error) {
  check('E2 验签环境准备', false, String(error))
}
check('E2 卡片 JWS 独立验签通过', verifyOk, `verify=${verifyOk}`)
check('E2 篡改卡片 body 后验签失败（签名有效覆盖）', tamperRejected, `tamper=${tamperRejected}`)

// ---------------------------------------------------------------- E3 凭证轮换
const rotatePrincipal = await kit.createPrincipal(`e-rotate-${suffix}`, 'external', ['uhp.invoke', 'agent.read'])
const rotated = await kit.api('POST', `/api/authn/principals/${rotatePrincipal.principal.principalId}/rotate-secret`, { token: admin })
const newSecret = rotated.data?.clientSecret
if (newSecret) {
  const oldLogin = await kit.api('POST', '/api/auth/client-credentials', { body: { clientId: rotatePrincipal.principal.clientId, clientSecret: rotatePrincipal.principal.clientSecret } })
  const newLogin = await kit.api('POST', '/api/auth/client-credentials', { body: { clientId: rotatePrincipal.principal.clientId, clientSecret: newSecret } })
  check('E3 轮换后 clientId 不变', rotated.data?.clientId === rotatePrincipal.principal.clientId || rotated.data?.clientId === rotatePrincipal.principal.clientId,
    JSON.stringify({ before: rotatePrincipal.principal.clientId, after: rotated.data?.clientId }).slice(0, 200))
  check('E3 轮换后旧 secret 立即失效', !oldLogin.ok, `status=${oldLogin.status}`)
  check('E3 轮换后新 secret 可换令牌', newLogin.ok && Boolean(newLogin.data?.token), `status=${newLogin.status}`)
} else {
  check('E3 凭证轮换接口可用', rotated.ok, JSON.stringify(rotated.error ?? rotated.payload ?? {}).slice(0, 240))
}

// ---------------------------------------------------------------- E4 OBO 端到端
const oboAgent = await kit.createAgent({
  name: `E-OBO-${suffix}`, slug: `e-obo-${suffix}`,
  attrs: { description: 'OBO 目标', model: 'deepseek-chat', riskLevel: 'low', autonomy: 'A2', dataClass: 'internal', a2aDataClassCeiling: 'internal', systemPromptVersion: 'v1', trialGroups: ['灰度试点组'], entryUrl: 'https://e-obo.example.com' },
})
const oboOnline = await kit.onlineAgent(oboAgent.agent.id, { approverToken: approver, opinion: 'E OBO 上线' })
check('E4 前置：OBO 目标上线', oboOnline.ok, JSON.stringify(oboOnline.error ?? oboOnline.step ?? {}).slice(0, 240))
const oboIssue = await kit.api('POST', `/api/agents/${oboAgent.agent.id}/obo-token`, { token: admin, body: {} })
const oboToken = oboIssue.data?.token
const oboAct = oboIssue.data?.actChain ?? []
check('E4 OBO 令牌签发且带 act 链（human 主体）',
  Boolean(oboToken) && oboAct.some((e) => e.type === 'human'),
  JSON.stringify({ ok: oboIssue.ok, act: oboAct }).slice(0, 260))
if (oboToken) {
  const oboCall = await rpcCallFor(oboAgent.agent.slug, oboToken, 'message/send', { message: 'OBO 端到端' })
  const oboTask = oboCall.inner?.result?.task
  check('E4 OBO 发起协作成功且任务落 onBehalfUser', Boolean(oboTask?.taskId) && Boolean(oboTask?.onBehalfUser),
    JSON.stringify({ state: oboTask?.state, onBehalf: oboTask?.onBehalfUser, err: oboCall.inner?.error }).slice(0, 280))
  if (oboTask?.taskId) {
    const audit = await kit.api('GET', '/api/audit/logs?limit=300', { token: admin })
    check('E4 审计可追真实发起人（OBO 链消费点存在）',
      JSON.stringify(audit.data ?? {}).includes(oboTask.onBehalfUser) || JSON.stringify(audit.data ?? {}).includes('onBehalf'),
      `rows=${(audit.data?.logs ?? audit.data?.items ?? []).length}`)
  }
}
async function rpcCallFor(slug, token, method, params) {
  const res = await fetch(`${g.base}/api/agents/${encodeURIComponent(slug)}/a2a`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params }),
  })
  const payload = await res.json().catch(() => ({}))
  return { status: res.status, inner: payload?.data ?? payload }
}

// ---------------------------------------------------------------- E5 CLI
const help = await runCli(['--help'])
const helpText = `${help.stdout}${help.stderr}`
const a2aMentions = (helpText.match(/a2a/gi) ?? []).length
const uhpMentions = (helpText.match(/uhp/gi) ?? []).length
check('E5 CLI 帮助已覆盖 a2a/uhp（上一轮 Q-33 零覆盖）',
  a2aMentions > 0 && uhpMentions > 0, JSON.stringify({ a2a: a2aMentions, uhp: uhpMentions }).slice(0, 200))

const cliCases = [
  { name: 'a2a directory', args: ['a2a', 'directory'], expect: (r) => r.code === 0 && /slug|agent|员工|directory/i.test(r.stdout), },
  { name: 'a2a tasks', args: ['a2a', 'tasks'], expect: (r) => r.code === 0 && r.stdout.length > 0 },
  { name: 'a2a fulfillment', args: ['a2a', 'fulfillment'], expect: (r) => r.code === 0 },
  { name: 'a2a rules', args: ['a2a', 'rules'], expect: (r) => r.code === 0 },
  { name: 'a2a patrol', args: ['a2a', 'patrol'], expect: (r) => r.code === 0 },
  { name: 'uhp discover', args: ['uhp', 'discover'], expect: (r) => r.code === 0 && /uhp_version|2026-08-11/.test(r.stdout) },
  { name: 'uhp harnesses', args: ['uhp', 'harnesses'], expect: (r) => r.code === 0 },
  { name: 'uhp responses', args: ['uhp', 'responses'], expect: (r) => r.code === 0 },
]
const cliToken = admin
const cliEnv = { DSHCTL_TOKEN: cliToken }
const cliResults = []
for (const item of cliCases) {
  const res = await runCli(item.args, cliEnv)
  cliResults.push({ name: item.name, code: res.code, ok: item.expect(res), out: res.stdout.slice(0, 160), err: res.stderr.slice(0, 160) })
}
check('E5 CLI a2a/uhp 子命令全部可用（8/8）', cliResults.every((r) => r.ok),
  JSON.stringify(cliResults.filter((r) => !r.ok)))

// 上一轮 6 条 CLI 遗留缺陷
const legacy = []
legacy.push({ name: 'agent topology', res: await runCli(['agent', 'topology'], cliEnv) })
legacy.push({ name: 'mcp get <id>', res: await runCli(['mcp', 'get', 'mcp_nonexistent'], cliEnv) })
legacy.push({ name: 'group list', res: await runCli(['group', 'list'], cliEnv) })
legacy.push({ name: 'global option prefix', res: await runCli([`--token=${cliToken}`, 'a2a', 'directory']) })
legacy.push({ name: 'approval decide confirmed', res: await runCli(['approval', 'decide', 'apr_nonexistent', '--decision=approve'], cliEnv) })
legacy.push({ name: 'mcp invoke denied exit', res: await runCli(['mcp', 'invoke', 'svc_nonexistent', '--tool=x'], cliEnv) })
const legacySummary = legacy.map((item) => ({
  name: item.name,
  code: item.res.code,
  noCrash: !/TypeError|Cannot read properties|SyntaxError/.test(item.res.stdout + item.res.stderr),
  notUnknown: !/未知资源|未知动作|unknown/i.test(item.res.stdout + item.res.stderr),
}))
check('E5 CLI 遗留缺陷：无 TypeError/未知资源（agent topology / mcp get / group list）',
  legacySummary.filter((r) => ['agent topology', 'mcp get <id>', 'group list'].includes(r.name)).every((r) => r.noCrash && r.notUnknown),
  JSON.stringify(legacySummary.filter((r) => !r.noCrash || !r.notUnknown)))
const prefixCase = legacy.find((l) => l.name === 'global option prefix')
check('E5 CLI 全局选项可前置（--token 在子命令前）',
  !/未知资源|未知动作/i.test(prefixCase.res.stdout + prefixCase.res.stderr),
  JSON.stringify({ out: prefixCase.res.stdout.slice(0, 120), err: prefixCase.res.stderr.slice(0, 120) }))
const deniedCase = legacy.find((l) => l.name === 'mcp invoke denied exit')
check('E5 CLI mcp invoke 失败时非零退出（不再 exit=0 假成功）',
  deniedCase.res.code !== 0, `exit=${deniedCase.res.code}`)

const final = summary()
console.log('\n' + JSON.stringify({ total: final.total, passed: final.passed, failed: final.failed, failures: final.failures }, null, 2))
const fs = await import('node:fs')
fs.writeFileSync(new URL('./result-E.json', import.meta.url), JSON.stringify(final, null, 2))