/**
 * workforce-runtime-drill —— 数字员工域真实宿主七场景联调（W7/T08 灰度交付包 · QA/交付组）。
 *
 * 与 loop-drill（进程内最小树）互补：本 drill spawn 真实宿主（node src/main.ts，独立端口 +
 * 独立临时数据目录，DEMO_SEED=1），全部夹具与断言走 REST（照 morning-peak-entry / full-chain-drill
 * 形态），stub 资产（MCP JSON-RPC + OpenAI 兼容模型）驻留 drill 主进程——跨宿主重启保留计数器，
 * 以支撑场景七的「重启后幂等回放不二次执行外部调用」硬证据（V26 真实重启）。
 *
 * 七场景（断言编号 R01 起）：
 *   1 拉取   GET /api/workforce/work-items（受管员工待办可见）
 *   2 认领   POST /api/workforce/claims → run/租约/permit/清单四件套 + 幂等
 *   3 续租   POST /api/workforce/leases/:id/renew → 同租约心跳推进（版本稳定语义，见 R06 注）
 *   4 资源调用 MCP real 往返 + 模型真实调用 + usage 关联可查
 *   5 交付   artifact 上传 → submit → review → accept → done
 *   6 取消   exec-hub transition cancelled → run 收口 + 租约释放（renew LEASE_STALE）
 *   7 重启恢复 SIGTERM → 同 data 同端口重启 → 持久事实读回一致 + 同 (runId,stepKey)
 *            幂等回放（stub 计数器不增）+ 已撤销 permit 重启后仍拒绝
 *
 * 用法：node tests/workforce-runtime-drill.mjs（端口 7323-7325，任一断言失败 exit 1）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST_PORT = 7323
const MCP_STUB_PORT = 7324
const MODEL_STUB_PORT = 7325
const BASE = `http://127.0.0.1:${HOST_PORT}`
const RUN_TAG = `wfrt-${Date.now().toString(36)}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'wf-runtime-drill-'))

process.on('unhandledRejection', (reason) => {
  console.error(`\x1b[33m[drill] 未处理的 rejection（已忽略）:\x1b[0m ${String(reason?.cause ?? reason).slice(0, 200)}`)
})

const results = []
let currentSection = ''
function section(name) {
  currentSection = name
  console.log(`\n\x1b[36m━━ ${name} ━\x1b[0m`)
}
function check(id, name, condition, detail = '') {
  const pass = Boolean(condition)
  results.push({ id, section: currentSection, name, pass })
  console.log(`  ${pass ? '\x1b[32m✔' : '\x1b[31m✘'} ${id} ${name}\x1b[0m${pass ? '' : `  ← ${detail}`}`)
  return pass
}
const errText = (error) => (error instanceof Error ? `${error.name}:${error.message}` : String(error))

async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let payload = null
  try { payload = await response.json() } catch { /* non-json */ }
  return { status: response.status, ok: payload?.ok ?? false, data: payload?.data, error: payload?.error }
}

/**
 * exec-hub 任务状态读取：无 GET 单条路由，统一走列表后按 id 取（exchange.query 面，可用）。
 * 注：/api/workforce/* 带 ?param= 的列表端点当前抛 400（routes.ts 读取了 HttpExchange 上不存在
 * 的 exchange.request.url——员工域组修复前，本 drill 一律走「无查询参数列表 + 客户端过滤」或
 * 单条 GET，不掩盖该缺陷；已登记缺陷观察 D-RT1 交员工域组）。
 */
async function issueOf(adminToken, issueId) {
  const list = await api('GET', '/api/exec/issues', { token: adminToken })
  return (list.data?.issues ?? []).find((item) => item.id === issueId) ?? null
}

/** 权威存储旁路直读（只读打开 txnstore.db，不干扰宿主 WAL）：持久事实核对用（列名与记录字段同名）。 */
const { DatabaseSync } = await import('node:sqlite')
function sqliteRows(table, column, value) {
  const db = new DatabaseSync(join(DATA_DIR, 'txnstore.db'), { readOnly: true })
  try {
    return db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).all(value)
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------- 宿主进程管理（重启场景复用）
let host = null
const hostLogTail = []

function spawnHost() {
  host = spawn(process.execPath, ['src/main.ts', '--port', String(HOST_PORT), '--data', DATA_DIR], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
    // DEMO_SEED：完整演示种子（隔离临时目录，不触碰仓库 data/）；更新检查关闭保确定性；
    // exec-hub 心跳压到 10 分钟不干扰断言（与 selftest 同纪律）
    env: { ...process.env, DEMO_SEED: '1', DSH_UPDATE_AUTO_CHECK: 'off', EXEC_HUB_TICK_MS: '600000', EXEC_HUB_FIRST_TICK_MS: '600000' },
  })
  host.stderr.on('data', (chunk) => {
    hostLogTail.push(String(chunk))
    if (hostLogTail.length > 40) hostLogTail.shift()
  })
  return host
}

async function waitHealthy(maxRounds = 100) {
  for (let i = 0; i < maxRounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true
    } catch { /* retry */ }
  }
  return false
}

async function stopHost(signal = 'SIGTERM') {
  if (!host) return
  const proc = host
  host = null
  proc.kill(signal)
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    try { if (proc.exitCode !== null || proc.signalCode !== null) return true } catch { /* poll */ }
    try { if (proc.killed && proc.exitCode !== null) return true } catch { /* poll */ }
  }
  proc.kill('SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 500))
  return false
}

/** admin 口令：基线首启随机口令文件优先（selftest 惯例）；DEMO_SEED 种子回退演示口令。 */
function adminPasswordOf() {
  const pwFile = join(DATA_DIR, 'admin-initial-password.txt')
  if (existsSync(pwFile)) {
    const value = readFileSync(pwFile, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('平台管理员'))[0] ?? ''
    if (value) return value
  }
  return 'Ybk@2026'
}

// ---------------------------------------------------------------- 资产 stub（驻留主进程，跨宿主重启保留计数器）
// stub 计数器是场景七「幂等回放不二次执行外部调用」的裁判：宿主重启前后长度不变＝未二次外呼。
const mcpStubCalls = []
const mcpBackendStub = createServer(async (req, res) => {
  const json = (status, payload, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(payload)) }
  let message = {}
  try { message = JSON.parse(await new Promise((resolve) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => resolve(raw)) })) } catch { /* ignore */ }
  const sessionHeaders = { 'mcp-session-id': `mcp-stub-${RUN_TAG}` }
  if (message.id === undefined || message.id === null) { res.writeHead(202, sessionHeaders); res.end(); return }
  const reply = (result) => json(200, { jsonrpc: '2.0', id: message.id, result }, sessionHeaders)
  if (message.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'qms-batch-runtime-stub', version: '1.0.0' } })
  if (message.method === 'tools/list') return reply({ tools: [{ name: 'qms_batch_read', description: 'stub qms_batch_read', inputSchema: { type: 'object' } }] })
  if (message.method === 'tools/call') {
    const name = String(message.params?.name ?? '')
    const args = message.params?.arguments ?? {}
    mcpStubCalls.push({ name, args, at: new Date().toISOString() })
    return reply({
      content: [{ type: 'text', text: JSON.stringify({ tool: name, factory: args.factoryId ?? '', batch: args.batch ?? '', rows: 128, note: `检验记录读取成功（tag=${RUN_TAG}）` }) }],
      usage: { totalTokens: 21 },
    })
  }
  return reply({ content: [{ type: 'text', text: `未知方法：${message.method}` }], isError: true })
})

const modelStubCalls = []
const modelStub = createServer(async (req, res) => {
  const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
  let body = {}
  try { body = JSON.parse(await new Promise((resolve) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => resolve(raw)) })) } catch { /* ignore */ }
  modelStubCalls.push({ url: req.url, model: body.model, at: new Date().toISOString() })
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    return json(200, {
      choices: [{ message: { role: 'assistant', content: `批次 Q-1024 根因假设（runtime drill stub）：温控波动导致检验数据漂移（tag=${RUN_TAG}）` } }],
      usage: { prompt_tokens: 120, completion_tokens: 80 },
    })
  }
  return json(404, { error: 'not found' })
})

await new Promise((resolve) => mcpBackendStub.listen(MCP_STUB_PORT, '127.0.0.1', resolve))
await new Promise((resolve) => modelStub.listen(MODEL_STUB_PORT, '127.0.0.1', resolve))

// ---------------------------------------------------------------- 证据与状态
const evidence = {
  drill: 'workforce-runtime-drill',
  port: HOST_PORT,
  stubs: { mcp: MCP_STUB_PORT, model: MODEL_STUB_PORT },
  runTag: RUN_TAG,
  restarts: 0,
  before: {},
  after: {},
  scenarios: [],
}

// ================================================================ 首次启动 + 夹具
let fatal = null
try {
  section('启动真实宿主（spawn node src/main.ts · 端口 7323 · 独立临时数据目录）')
  spawnHost()
  const booted = await waitHealthy()
  check('R00', '宿主就绪：/api/health 200（真实进程，非进程内挂载）', booted, hostLogTail.slice(-6).join('').slice(-600))
  if (!booted) throw new Error('宿主启动失败')

  const adminLogin = await api('POST', '/api/auth/login', { body: { username: 'admin', password: adminPasswordOf() } })
  check('R00b', 'admin 登录（口令来源：初始口令文件/演示种子）', adminLogin.ok && Boolean(adminLogin.data?.token), JSON.stringify(adminLogin.error ?? {}).slice(0, 160))
  const admin = adminLogin.data.token
  const adminUserId = adminLogin.data.user.id

  // -- 夹具：组织 / Agent / 工作面机器凭证 / 模型 / MCP -----------------------------
  section('夹具（REST）：组织 / Agent / workforce 机器凭证 / 模型与 MCP 真实上游')
  const org = await api('POST', '/api/iam/orgs', { token: admin, body: { name: `金华工厂-runtime-drill-${RUN_TAG}` } })
  const ORG_ID = org.data.id
  check('F01', '工作组织创建（§16.1 金华工厂）', org.ok && Boolean(ORG_ID), JSON.stringify(org.error ?? {}))

  const agentReg = await api('POST', '/api/agents', { token: admin, body: {
    name: '质量分析员-技术Agent(runtime)', ownerId: adminUserId, ownerName: '质量主管', orgId: ORG_ID,
    attrs: { description: 'workforce-runtime-drill：数字员工绑定用', model: 'deepseek-chat', riskLevel: 'low' },
  } })
  const AGENT_ID = agentReg.data.agent.id
  check('F02', 'Agent 注册（默认机器凭证含 exec.write，认领准入要求）', agentReg.ok && Boolean(AGENT_ID) && Boolean(agentReg.data.credential?.clientId), JSON.stringify(agentReg.error ?? {}).slice(0, 160))

  // workforce 工作面机器凭证：refType=agent 可反查员工绑定；workforce.invoke 过 REST 权限点
  const wfCred = await api('POST', '/api/authn/principals', { token: admin, body: {
    name: `wf-worker-${RUN_TAG}`, refType: 'agent', refId: AGENT_ID, scopes: ['workforce.invoke', 'exec.write'],
  } })
  const workerCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: wfCred.data.clientId, clientSecret: wfCred.data.clientSecret } })
  const worker = workerCc.data.token
  check('F03', 'workforce 工作面机器凭证就位（client-credentials 换发令牌）', Boolean(wfCred.data?.principalId) && Boolean(worker), JSON.stringify({ cred: wfCred.error ?? null, cc: workerCc.error ?? null }))

  const MODEL_SLUG = `rt-qa-model-${RUN_TAG}`
  const modelReg = await api('POST', '/api/modelgw/models', { token: admin, body: {
    slug: MODEL_SLUG, displayName: 'runtime drill 质量分析模型', provider: 'stub',
    endpoint: `http://127.0.0.1:${MODEL_STUB_PORT}/v1`, apiKey: `sk-${RUN_TAG}`,
    costCentsPerKTokens: 1, status: 'online', dataClassLimit: 'internal',
  } })
  check('F04', '模型目录登记（endpoint 指向本进程 stub）', modelReg.ok && Boolean(modelReg.data?.id), JSON.stringify(modelReg.error ?? {}).slice(0, 160))

  const mcpCreate = await api('POST', '/api/mcp/services', { token: admin, body: {
    name: '质量检验数据服务(runtime)', slug: `rt-qms-${RUN_TAG}`, orgId: ORG_ID,
    description: '批次检验数据读取（runtime drill）', endpoint: `http://127.0.0.1:${MCP_STUB_PORT}/mcp`,
    transport: 'http', mode: 'external', exec: 'real',
    tools: [{ name: 'qms_batch_read', description: '读取批次检验数据', inputSchema: { type: 'object', properties: { factoryId: { type: 'string' }, batch: { type: 'string' } } }, riskLevel: 'read' }],
  } })
  const MCP_ID = mcpCreate.data?.id
  const MCP_SLUG = mcpCreate.data?.slug
  const mcpVerify = MCP_ID ? await api('POST', `/api/mcp/services/${MCP_ID}/verify`, { token: admin }) : null
  const mcpDeploy = MCP_ID ? await api('POST', `/api/mcp/services/${MCP_ID}/deploy`, { token: admin, body: { grayPercent: 100, changelog: 'runtime drill 全量上架' } }) : null
  const permGroup = await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
    name: `rt-qms-ro-${RUN_TAG}`,
    policies: { [MCP_ID]: { allowedTools: ['qms_batch_read'], constraints: { readOnly: true } } },
    subjects: [{ type: 'agent', id: AGENT_ID, name: '质量分析员-技术Agent(runtime)' }],
  } })
  check('F05', 'MCP real 服务上架（verify→deploy 全量）+ Agent 只读权限组', Boolean(MCP_ID) && mcpDeploy?.ok && mcpDeploy.data?.status === 'online' && permGroup.ok && Boolean(mcpVerify?.data?.health?.status),
    `mcp=${MCP_ID ?? '无'} verify=${mcpVerify?.data?.health?.status ?? '-'} deploy=${mcpDeploy?.data?.status ?? '-'} perm=${permGroup.ok}`)

  const employee = await api('POST', '/api/workforce/employees', { token: admin, body: {
    name: 'jh-quality-analyst', displayName: '金华工厂质量分析员(runtime)', orgId: ORG_ID,
    supervisorUserId: adminUserId, agentId: AGENT_ID, principalId: wfCred.data.principalId, runtime: 'dsh',
  } })
  const EMP_ID = employee.data?.id
  check('F06', '员工创建（active + 主绑定 Agent + 主体=workforce 凭证 principal）',
    employee.ok && employee.data?.status === 'active' && employee.data?.primaryAgentId === AGENT_ID, JSON.stringify(employee.error ?? employee.data ?? {}).slice(0, 200))

  const appointment = await api('POST', '/api/workforce/appointments', { token: admin, body: {
    employeeId: EMP_ID, position: '金华工厂质量分析员', orgId: ORG_ID, dataClass: 'internal',
    effectiveFrom: new Date().toISOString(),
    grants: [
      { kind: 'mcp', registryId: MCP_ID, actions: ['qms_batch_read'], risk: 'read', constraints: { factoryIds: ['JH-01'] } },
      { kind: 'model', registryId: MODEL_SLUG, actions: ['invoke'], risk: 'read', constraints: { maxTokens: 256 } },
    ],
    approvedBy: adminUserId, approvalRef: `rt-appr-${RUN_TAG}`,
  } })
  const APPT_ID = appointment.data?.id
  const activated = APPT_ID ? await api('POST', `/api/workforce/appointments/${APPT_ID}/activate`, { token: admin }) : null
  check('F07', '任用 v1 激活（探针逐 grant 通过 → effective，可签发 permit 的前提）',
    appointment.ok && appointment.data?.status === 'preparing' && activated?.ok && activated.data?.status === 'effective',
    JSON.stringify({ create: appointment.error ?? null, activate: activated?.error ?? activated?.data?.statusReason ?? null }).slice(0, 240))
  evidence.employeeId = EMP_ID
  evidence.appointmentId = APPT_ID
  evidence.orgId = ORG_ID

  // ================================================================ 场景 1：拉取
  section('场景 1 拉取：受管员工待办可见（查询面不拦）')
  const issue1 = await api('POST', '/api/exec/issues', { token: admin, body: {
    orgId: ORG_ID, title: '分析批次 Q-1024 异常，输出可复核根因假设与纠正建议', assigneeAgentId: AGENT_ID,
  } })
  const ISSUE1 = issue1.data?.id
  check('R01', 'exec-hub 任务创建（todo 起步，指派员工技术 Agent）', issue1.ok && ISSUE1 && issue1.data?.status === 'todo', JSON.stringify(issue1.error ?? {}).slice(0, 160))
  const workItems = await api('GET', '/api/workforce/work-items', { token: worker })
  check('R02', '拉取待办：work-items 含该任务（员工身份按令牌反查，非参数自报）',
    workItems.ok && workItems.data?.employeeId === EMP_ID && (workItems.data?.items ?? []).some((item) => item.id === ISSUE1),
    JSON.stringify({ error: workItems.error ?? null, items: (workItems.data?.items ?? []).map((i) => i.id) }).slice(0, 200))

  // ================================================================ 场景 2：认领
  section('场景 2 认领：run/租约/permit/清单四件套 + 幂等')
  const claim1 = await api('POST', '/api/workforce/claims', { token: worker, body: { issueId: ISSUE1 } })
  const RUN1 = claim1.data?.runId
  const PERMIT1 = claim1.data?.permit?.id
  check('R03', '首次认领成功：runId/租约/permit/工具句柄四件套齐备',
    claim1.ok && RUN1 && claim1.data?.lease?.id && claim1.data?.lease?.leaseVersion >= 1 && PERMIT1 && (claim1.data?.tools ?? []).length >= 2,
    JSON.stringify(claim1.ok ? {} : { status: claim1.status, error: claim1.error }).slice(0, 240))
  check('R04', 'permit 与租约绑定一致（runId/leaseId/leaseVersion 服务端投影）',
    claim1.ok && claim1.data.permit.runId === RUN1 && claim1.data.permit.leaseId === claim1.data.lease.id
    && claim1.data.permit.leaseVersion === claim1.data.lease.leaseVersion,
    JSON.stringify(claim1.ok ? { run: RUN1 } : claim1.error ?? {}).slice(0, 160))
  const claimReplay = await api('POST', '/api/workforce/claims', { token: worker, body: { issueId: ISSUE1 } })
  check('R05', '同主体同任务重复认领幂等（idempotent=true，runId/permit 不变）',
    claimReplay.ok && claimReplay.data?.idempotent === true && claimReplay.data?.runId === RUN1 && claimReplay.data?.permit?.id === PERMIT1,
    JSON.stringify(claimReplay.ok ? { idem: claimReplay.data?.idempotent } : claimReplay.error ?? {}).slice(0, 160))
  evidence.issueId = ISSUE1
  evidence.runId = RUN1
  evidence.permitId = PERMIT1

  // ================================================================ 场景 3：续租
  section('场景 3 续租：同租约心跳推进（权威存储续期语义）')
  // 续租不带 ttlMinutes：按服务端缺省 TTL 心跳推进（若显式传短 TTL 会把 expiresAt 收窄——
  // 续期语义是 now+TTL 绝对时间，不是在原到期时间上延长；同 loop-drill A18 口径）
  const renew1 = await api('POST', `/api/workforce/leases/${PERMIT1}/renew`, { token: worker, body: {} })
  check('R06', '续租成功：同租约 id/版本不变，renewedAt/expiresAt 心跳推进（exec_run_leases 续期而非换代）',
    renew1.ok && renew1.data?.lease?.id === claim1.data.lease.id
    && renew1.data.lease.leaseVersion === claim1.data.lease.leaseVersion
    && renew1.data.lease.expiresAt > claim1.data.lease.expiresAt,
    JSON.stringify(renew1.ok
      ? { from: claim1.data.lease.expiresAt, to: renew1.data.lease.expiresAt }
      : { status: renew1.status, error: renew1.error }).slice(0, 200))

  // ================================================================ 场景 4：资源调用
  section('场景 4 资源调用：MCP real 往返 + 模型真实调用 + usage 关联')
  const mcpHandle = (claim1.data.tools ?? []).find((handle) => handle.startsWith(`${MCP_ID}.`) || handle.includes('qms_batch_read'))
  const modelHandle = (claim1.data.tools ?? []).find((handle) => handle.includes('invoke'))
  const mcpInvoke = await api('POST', '/api/workforce/invocations', { token: worker, body: {
    permitId: PERMIT1, toolHandle: mcpHandle, stepKey: 'r4.step1.batch_read',
    arguments: { factoryId: 'JH-01', batch: 'Q-1024' },
  } })
  const MCP_INV = mcpInvoke.data?.invocationId
  check('R07', 'MCP 受控调用 completed（网关工作闸门→权限组→real 传输真实往返）',
    mcpInvoke.ok && mcpInvoke.data?.status === 'completed' && Boolean(MCP_INV) && mcpStubCalls.length === 1,
    JSON.stringify({ status: mcpInvoke.data?.status, stubCalls: mcpStubCalls.length, error: mcpInvoke.error ?? mcpInvoke.data?.message }).slice(0, 240))
  const invRead = await api('GET', `/api/workforce/invocations/${MCP_INV}`, { token: worker })
  check('R08', '调用事实落账可查（归属员工/run、argsHash 摘要、settledAt）',
    invRead.ok && invRead.data?.id === MCP_INV && invRead.data?.employeeId === EMP_ID && invRead.data?.runId === RUN1
    && /^[0-9a-f]{64}$/.test(invRead.data?.argsHash ?? '') && invRead.data?.settledAt !== '',
    JSON.stringify(invRead.error ?? { id: invRead.data?.id }).slice(0, 200))
  const modelInvoke = await api('POST', '/api/workforce/invocations', { token: worker, body: {
    permitId: PERMIT1, toolHandle: modelHandle, stepKey: 'r4.step2.draft',
    arguments: { messages: [{ role: 'user', content: '根据批次 Q-1024 检验数据与 SOP 形成根因假设' }] },
  } })
  const MODEL_INV = modelInvoke.data?.invocationId
  check('R09', '模型受控调用 completed（真实上游往返，网关证据含模型/密级）',
    modelInvoke.ok && modelInvoke.data?.status === 'completed' && Boolean(MODEL_INV)
    && modelStubCalls.length === 1 && modelInvoke.data?.gatewayRef?.dataClass === 'internal',
    JSON.stringify({ status: modelInvoke.data?.status, stubCalls: modelStubCalls.length, gw: modelInvoke.data?.gatewayRef ?? null }).slice(0, 240))
  await new Promise((resolve) => setTimeout(resolve, 400))
  const mcpUsage = await api('GET', `/api/usage/events?resource=${encodeURIComponent(`mcp:${MCP_SLUG}`)}`, { token: admin })
  const modelUsage = await api('GET', `/api/usage/events?resource=${encodeURIComponent(`model:${MODEL_SLUG}`)}`, { token: admin })
  check('R10', 'usage 关联可查：mcp:<slug> 与 model:<slug> 消费事件在台账（§11.3）',
    mcpUsage.ok && (mcpUsage.data?.total ?? 0) >= 1 && modelUsage.ok && (modelUsage.data?.total ?? 0) >= 1,
    JSON.stringify({ mcp: mcpUsage.data?.total ?? 0, model: modelUsage.data?.total ?? 0 }).slice(0, 160))
  evidence.invocations = [
    { id: MCP_INV, stepKey: 'r4.step1.batch_read', kind: 'mcp', status: 'completed' },
    { id: MODEL_INV, stepKey: 'r4.step2.draft', kind: 'model', status: 'completed' },
  ]
  evidence.usageEvents = { mcp: mcpUsage.data?.total ?? 0, model: modelUsage.data?.total ?? 0 }

  // ================================================================ 场景 5：交付
  section('场景 5 交付：artifact 上传 → submit → review → accept → done')
  const artifact = await api('POST', '/api/workforce/artifacts', { token: worker, body: {
    name: 'Q-1024-根因分析草案.md', contentType: 'text/markdown',
    contentBase64: Buffer.from(`# 批次 Q-1024 根因分析\n\n根因假设与纠正建议（证据：SOP+检验数据+模型草案，tag=${RUN_TAG}）。`).toString('base64'),
    runId: RUN1,
  } })
  const ART_ID = artifact.data?.id
  check('R11', '受控 artifact 上传（staging + sha256 + 归属本 run）',
    artifact.ok && ART_ID && artifact.data?.sizeBytes > 0 && /^[0-9a-f]{64}$/.test(artifact.data?.sha256 ?? '') && artifact.data?.runId === RUN1,
    JSON.stringify(artifact.error ?? {}).slice(0, 160))
  const deliverable = await api('POST', '/api/workforce/deliverables', { token: worker, body: {
    permitId: PERMIT1, summary: '批次 Q-1024 根因假设与纠正建议（附 SOP/数据/草案证据）', artifactIds: [ART_ID],
  } })
  const DELIV_ID = deliverable.data?.id
  const issueAfterSubmit = await issueOf(admin, ISSUE1)
  check('R12', '交付 submit → 任务转 review（技术完成≠验收完成）',
    deliverable.ok && deliverable.data?.status === 'submitted' && issueAfterSubmit?.status === 'review',
    JSON.stringify({ deliverable: deliverable.data?.status ?? deliverable.error, issue: issueAfterSubmit?.status }).slice(0, 200))
  const accepted = await api('POST', '/api/workforce/acceptances', { token: admin, body: {
    deliverableId: DELIV_ID, decision: 'accepted', reason: 'runtime drill：证据齐备验收通过',
  } })
  const issueAfterAccept = await issueOf(admin, ISSUE1)
  check('R13', '真人 accept → 任务 done（验收权决定业务完成）',
    accepted.ok && accepted.data?.status === 'accepted' && accepted.data?.decidedBy === adminUserId && issueAfterAccept?.status === 'done',
    JSON.stringify({ decision: accepted.data?.status ?? accepted.error, issue: issueAfterAccept?.status }).slice(0, 200))
  evidence.deliverableId = DELIV_ID

  // ================================================================ 场景 6：取消
  section('场景 6 取消：exec-hub 取消 → run 收口 + 租约释放')
  const issue2 = await api('POST', '/api/exec/issues', { token: admin, body: {
    orgId: ORG_ID, title: 'runtime drill：取消路径演练（批次 Q-1025）', assigneeAgentId: AGENT_ID,
  } })
  const ISSUE2 = issue2.data?.id
  const claim2 = await api('POST', '/api/workforce/claims', { token: worker, body: { issueId: ISSUE2 } })
  const PERMIT2 = claim2.data?.permit?.id
  const RUN2 = claim2.data?.runId
  check('R14', '取消前置：第二任务认领成功（in_progress 持有租约）', claim2.ok && Boolean(PERMIT2), JSON.stringify(claim2.ok ? {} : claim2.error ?? {}).slice(0, 160))
  const cancel = await api('POST', `/api/exec/issues/${ISSUE2}/transition`, { token: admin, body: { to: 'cancelled' } })
  const issue2After = await issueOf(admin, ISSUE2)
  const runsAfter = await api('GET', '/api/exec/runs', { token: admin })
  const run2 = (runsAfter.data?.runs ?? []).find((run) => run.id === RUN2)
  check('R15', '任务取消：issue → cancelled 且 run 收口（failed 终态，不留悬挂执行）',
    cancel.ok && issue2After?.status === 'cancelled' && run2 && ['failed', 'completed'].includes(run2.status),
    JSON.stringify({ issue: issue2After?.status, run: run2?.status ?? '缺失' }).slice(0, 200))
  const renew2 = await api('POST', `/api/workforce/leases/${PERMIT2}/renew`, { token: worker, body: {} })
  check('R16', '取消后续租被拒（LEASE_STALE：workforce 面的租约释放证据，关闭组织/失效租约不得延长工作）',
    renew1.ok && !renew2.ok && renew2.status === 403 && renew2.error?.code === 'LEASE_STALE',
    JSON.stringify({ status: renew2.status, error: renew2.error }).slice(0, 200))
  evidence.cancel = { issueId: ISSUE2, runId: RUN2, runStatus: run2?.status ?? '', renewCode: renew2.error?.code ?? '' }

  // ================================================================ 场景 7：重启恢复（V26 真实重启证据）
  section('场景 7 重启恢复：制造持久事实 → SIGTERM → 同 data 同端口重启')
  // 持久事实：①completed 步骤（场景 4 的 mcp/model invocation）②active permit（第三任务 run3 在途）
  const issue3 = await api('POST', '/api/exec/issues', { token: admin, body: {
    orgId: ORG_ID, title: 'runtime drill：重启恢复在途任务（批次 Q-1026）', assigneeAgentId: AGENT_ID,
  } })
  const ISSUE3 = issue3.data?.id
  const claim3 = await api('POST', '/api/workforce/claims', { token: worker, body: { issueId: ISSUE3 } })
  const PERMIT3 = claim3.data?.permit?.id
  const RUN3 = claim3.data?.runId
  check('R17', '在途任务认领（active permit + active 租约，重启恢复的持久事实）', claim3.ok && Boolean(PERMIT3), JSON.stringify(claim3.ok ? {} : claim3.error ?? {}).slice(0, 160))

  // 已撤销 permit 夹具：第二员工 + 模型任用 + 认领 + 任用撤销（permit 全 revoked）
  const agentB = await api('POST', '/api/agents', { token: admin, body: {
    name: '撤权用-技术Agent(runtime)', ownerId: adminUserId, ownerName: '质量主管', orgId: ORG_ID,
    attrs: { description: 'workforce-runtime-drill：已撤销 permit 重启拒绝用', model: 'deepseek-chat', riskLevel: 'low' },
  } })
  const AGENT_B = agentB.data?.agent?.id
  const credB = await api('POST', '/api/authn/principals', { token: admin, body: {
    name: `wf-worker-b-${RUN_TAG}`, refType: 'agent', refId: AGENT_B, scopes: ['workforce.invoke', 'exec.write'],
  } })
  const ccB = await api('POST', '/api/auth/client-credentials', { body: { clientId: credB.data.clientId, clientSecret: credB.data.clientSecret } })
  const workerB = ccB.data.token
  const employeeB = await api('POST', '/api/workforce/employees', { token: admin, body: {
    name: 'jh-revoke-analyst', displayName: '撤权用员工(runtime)', orgId: ORG_ID,
    supervisorUserId: adminUserId, agentId: AGENT_B, principalId: credB.data.principalId, runtime: 'dsh',
  } })
  const apptB = await api('POST', '/api/workforce/appointments', { token: admin, body: {
    employeeId: employeeB.data?.id, position: '撤权用质量分析员', orgId: ORG_ID, dataClass: 'internal',
    effectiveFrom: new Date().toISOString(),
    grants: [{ kind: 'model', registryId: MODEL_SLUG, actions: ['invoke'], risk: 'read', constraints: { maxTokens: 64 } }],
    approvedBy: adminUserId,
  } })
  const apptBActivate = await api('POST', `/api/workforce/appointments/${apptB.data?.id}/activate`, { token: admin })
  const issueB = await api('POST', '/api/exec/issues', { token: admin, body: {
    orgId: ORG_ID, title: 'runtime drill：撤权用任务', assigneeAgentId: AGENT_B,
  } })
  const claimB = await api('POST', '/api/workforce/claims', { token: workerB, body: { issueId: issueB.data?.id } })
  const PERMIT_B = claimB.data?.permit?.id
  const apptBRevoke = await api('POST', `/api/workforce/appointments/${apptB.data?.id}/revoke`, { token: admin, body: { reason: 'runtime drill：撤销任用以制造已撤销 permit' } })
  check('R18', '已撤销 permit 夹具就位（任用撤销 → permit revoked，重启后验证仍拒绝）',
    claimB.ok && Boolean(PERMIT_B) && apptBRevoke.ok && apptBRevoke.data?.status === 'revoked',
    JSON.stringify({ claim: claimB.ok, revoke: apptBRevoke.data?.status ?? apptBRevoke.error }).slice(0, 200))

  // -- 重启前快照（持久事实基准） ------------------------------------------------
  // 列表读取纪律：/api/workforce/* 带 ?param= 的列表端点在 routes.ts 修复前抛 400（D-RT1）——
  // 无查询参数列表 + 客户端过滤；调用账本/交付读回另以 SQLite 直读复核（权威存储旁路验证）。
  const apptRowsBefore = sqliteRows('workforce_appointments', 'employeeId', EMP_ID)
  const delivRowsBefore = await sqliteRows('workforce_deliverables', 'runId', RUN1)
  const permit3Before = await sqliteRows('workforce_permits', 'runId', RUN3)
  const empBefore = await api('GET', `/api/workforce/employees/${EMP_ID}`, { token: admin })
  const mcpCallsBefore = mcpStubCalls.length
  const modelCallsBefore = modelStubCalls.length
  const mcpInvBefore = await api('GET', `/api/workforce/invocations/${MCP_INV}`, { token: worker })
  evidence.before = {
    employee: { id: empBefore.data?.id, status: empBefore.data?.status },
    appointmentCount: apptRowsBefore.filter((row) => String(row.employeeId) === EMP_ID && row.status === 'effective').length,
    invocation: mcpInvBefore.data ? { id: mcpInvBefore.data.id, status: mcpInvBefore.data.status, settledAt: mcpInvBefore.data.settledAt, argsHash: mcpInvBefore.data.argsHash } : null,
    deliverable: delivRowsBefore.map((row) => ({ id: row.id, status: row.status, version: row.version })),
    permit3: permit3Before.map((row) => ({ id: row.id, status: row.status })),
    stubCounters: { mcp: mcpCallsBefore, model: modelCallsBefore },
  }
  console.log(`\x1b[90m» 重启前快照：invocation=${MCP_INV} stub 计数 mcp=${mcpCallsBefore} model=${modelCallsBefore}\x1b[0m`)

  // -- SIGTERM → 重启（同 data 目录同端口） --------------------------------------
  const stopOk = await stopHost('SIGTERM')
  spawnHost()
  evidence.restarts = 1
  const rebooted = await waitHealthy()
  check('R19', 'SIGTERM 优雅退出 + 同 data 同端口重启就绪（V26 真实重启）', stopOk && rebooted, `stopOk=${stopOk} rebooted=${rebooted} log=${hostLogTail.slice(-4).join('').slice(-300)}`)
  const adminLogin2 = await api('POST', '/api/auth/login', { body: { username: 'admin', password: adminPasswordOf() } })
  const admin2 = adminLogin2.data?.token

  // ① 持久事实读回一致
  const empAfter = await api('GET', `/api/workforce/employees/${EMP_ID}`, { token: admin2 })
  const apptRowsAfter = sqliteRows('workforce_appointments', 'employeeId', EMP_ID)
  const workItemsAfter = await api('GET', '/api/workforce/work-items', { token: worker })
  check('R20', '员工/任用持久事实读回一致（员工 REST 读回 + 任用 SQLite 直读 + 受管身份解析可用）',
    empAfter.ok && empAfter.data?.id === EMP_ID && empAfter.data?.status === 'active'
    && apptRowsAfter.some((row) => row.id === APPT_ID && row.status === 'effective' && String(row.employeeId) === EMP_ID)
    && workItemsAfter.ok && workItemsAfter.data?.employeeId === EMP_ID,
    JSON.stringify({ employee: empAfter.data?.status, appointments: apptRowsAfter.map((row) => ({ id: row.id, status: row.status })),
      resolve: workItemsAfter.ok ? workItemsAfter.data?.employeeId : `fail:${JSON.stringify(workItemsAfter.error ?? {}).slice(0, 80)}` }).slice(0, 300))
  const mcpInvAfter = await api('GET', `/api/workforce/invocations/${MCP_INV}`, { token: worker })
  const delivRowsAfter = await sqliteRows('workforce_deliverables', 'runId', RUN1)
  const permit3After = await sqliteRows('workforce_permits', 'runId', RUN3)
  const beforeInv = evidence.before.invocation
  check('R21', '调用账本/交付/permit 读回一致（completed 步骤 id/status/settledAt/argsHash 逐字段相等；交付与 permit 经 SQLite 直读核对）',
    Boolean(mcpInvAfter.data) && mcpInvAfter.data.status === beforeInv?.status && mcpInvAfter.data.settledAt === beforeInv?.settledAt
    && mcpInvAfter.data.argsHash === beforeInv?.argsHash
    && JSON.stringify(delivRowsAfter.map((row) => ({ id: row.id, status: row.status, version: row.version }))) === JSON.stringify(evidence.before.deliverable)
    && JSON.stringify(permit3After.map((row) => ({ id: row.id, status: row.status }))) === JSON.stringify(evidence.before.permit3),
    JSON.stringify({ before: beforeInv, after: mcpInvAfter.data ? { id: mcpInvAfter.data.id, status: mcpInvAfter.data.status } : null,
      delivBefore: evidence.before.deliverable, delivAfter: delivRowsAfter.map((row) => ({ id: row.id, status: row.status })) }).slice(0, 320))
  evidence.after = { invocation: mcpInvAfter.data ? { id: mcpInvAfter.data.id, status: mcpInvAfter.data.status, settledAt: mcpInvAfter.data.settledAt, argsHash: mcpInvAfter.data.argsHash } : null }
  evidence.after.deliverable = delivRowsAfter.map((row) => ({ id: row.id, status: row.status, version: row.version }))
  evidence.after.permit3 = permit3After.map((row) => ({ id: row.id, status: row.status }))

  // ② 同 (runId, stepKey) 幂等回放：stub 计数器不增（不二次执行外部调用）
  const replayMcp = await api('POST', '/api/workforce/invocations', { token: worker, body: {
    permitId: PERMIT1, toolHandle: mcpHandle, stepKey: 'r4.step1.batch_read',
    arguments: { factoryId: 'JH-01', batch: 'Q-1024' },
  } })
  const replayModel = await api('POST', '/api/workforce/invocations', { token: worker, body: {
    permitId: PERMIT1, toolHandle: modelHandle, stepKey: 'r4.step2.draft',
    arguments: { messages: [{ role: 'user', content: '根据批次 Q-1024 检验数据与 SOP 形成根因假设' }] },
  } })
  check('R22', '重启后同 (runId, stepKey) 同参数重放 = 幂等回放原结果（同 invocationId）',
    replayMcp.ok && replayMcp.data?.invocationId === MCP_INV && replayMcp.data?.status === 'completed'
    && replayModel.ok && replayModel.data?.invocationId === MODEL_INV,
    JSON.stringify({ mcp: replayMcp.data?.invocationId ?? replayMcp.error, model: replayModel.data?.invocationId ?? replayModel.error }).slice(0, 240))
  check('R23', '重启后重放未二次执行外部调用（stub 计数器跨重启不变：宿主重启不重放副作用，V26）',
    mcpStubCalls.length === mcpCallsBefore && modelStubCalls.length === modelCallsBefore,
    JSON.stringify({ mcp: `${mcpCallsBefore}→${mcpStubCalls.length}`, model: `${modelCallsBefore}→${modelStubCalls.length}` }))
  evidence.after.stubCounters = { mcp: mcpStubCalls.length, model: modelStubCalls.length }

  // 在途 permit 重启后仍可用（active permit 持久事实活着：可续租）
  const renew3 = await api('POST', `/api/workforce/leases/${PERMIT3}/renew`, { token: worker, body: {} })
  check('R24', '在途任务 active permit 重启后仍有效（续租成功，run3 租约持久）', renew3.ok && renew3.data?.lease?.id, JSON.stringify(renew3.ok ? {} : renew3.error).slice(0, 200))

  // ③ 已撤销 permit 重启后仍拒绝（verifyPermit fail-closed，被撤授权不复活）
  const revokedProbe = await api('POST', '/api/workforce/invocations', { token: workerB, body: {
    permitId: PERMIT_B, toolHandle: (claimB.data?.tools ?? []).find((handle) => handle.includes('invoke')),
    stepKey: 'r7.revoked.probe', arguments: { messages: [{ role: 'user', content: '已撤销 permit 不得再调用' }] },
  } })
  check('R25', '已撤销 permit 重启后仍拒绝（verifyPermit fail-closed：失效/不存在语义，被撤授权不复活）',
    revokedProbe.status === 400 && String(revokedProbe.error?.message ?? '').includes('permit'),
    JSON.stringify({ status: revokedProbe.status, error: revokedProbe.error }).slice(0, 240))
  evidence.after.revokedPermitProbe = { status: revokedProbe.status, message: revokedProbe.error?.message ?? '' }

  // -- 收口：宿主退出 + 临时目录清理在 finally -------------------------------------
  } catch (error) {
    fatal = error
    console.error(`\x1b[31m[drill][fatal] ${error instanceof Error ? error.stack?.slice(0, 800) ?? error.message : String(error)}\x1b[0m`)
  } finally {
    await stopHost('SIGTERM')
    await new Promise((resolve) => mcpBackendStub.close(resolve))
    await new Promise((resolve) => modelStub.close(resolve))
  }

  // ================================================================ 证据 JSON（附录 C 风格）+ 汇总
  console.log(`\n\x1b[90m━━ 证据 JSON（附录 C 风格） ━\x1b[0m`)
  evidence.assertions = results.map((item) => ({ id: item.id, name: item.name, pass: item.pass }))
  evidence.summary = {
    total: results.length,
    passed: results.filter((item) => item.pass).length,
    failed: results.filter((item) => !item.pass).length,
    restarts: evidence.restarts,
    restartComparison: {
      before: evidence.before,
      after: evidence.after,
    },
  }
  console.log(JSON.stringify(evidence, null, 2))

  const failed = results.filter((item) => !item.pass)
  console.log(`\n${'━'.repeat(46)}`)
  if (fatal || failed.length > 0) {
    console.log(`  \x1b[1mworkforce-runtime-drill：${results.length - failed.length}/${results.length} 通过\x1b[0m`)
    for (const item of failed) console.log(`   ✘ [${item.section}] ${item.id} ${item.name}`)
  } else {
    console.log(`  \x1b[1m\x1b[32mworkforce-runtime-drill：七场景全部通过（${results.length} 项断言，含 ${evidence.restarts} 次真实重启）\x1b[0m`)
  }
  // 终扫：opsStorage 防抖刷盘可能在 stopHost 后重建草稿文件——反复清到目录消失（同 loop-drill 纪律）
  for (let sweep = 0; sweep < 6 && existsSync(DATA_DIR); sweep++) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {})
  }
  process.exit(fatal || failed.length > 0 ? 1 : 0)
