/**
 * workforce-loop-drill —— 数字员工「质量分析员」闭环独立验收演练（组7 QA 补充 drill）。
 *
 * 蓝本：《数字员工与平台资源调用-技术关联与施工实施路径-20261015》§16 贯穿样例：
 *   质量主管任用「金华工厂质量分析员」→ 建员工绑 Agent → 任用（mcp 只读 + nas 只读 + model，
 *   dataClass=internal）激活 → 认领任务（幂等）→ 受控调用（NAS 只读真实路径 / 模型真实路径 /
 *   MCP 诚实落账路径）→ 受控 artifact → 交付 submit → 任务 review → accept/reject 决策 →
 *   停职撤权（permit 全 revoked + verifyPermit fail-closed）。
 *
 * 装配：最小树进程内挂载（等价 selftest 组7 章节依赖序），独立 PORT=7391（不撞 selftest 7311），
 *   独立临时数据目录（os.tmpdir()+随机后缀），结尾清理。断言失败 exit 1。
 * 用法：node tests/workforce-loop-drill.mjs
 */
import { createServer } from 'node:http'
import { rm } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as platformCore from '../packages/platform-core/src/index.ts'
import * as resourceCore from '../packages/plugin-resource-core/src/index.ts'
import * as iam from '../packages/plugin-iam/src/index.ts'
import * as authn from '../packages/plugin-authn/src/index.ts'
import * as usage from '../packages/plugin-usage/src/index.ts'
import * as audit from '../packages/plugin-audit/src/index.ts'
import * as market from '../packages/plugin-market/src/index.ts'
import * as agent from '../packages/plugin-agent/src/index.ts'
import * as app from '../packages/plugin-app/src/index.ts'
import * as connector from '../packages/plugin-connector/src/index.ts'
import * as mcp from '../packages/plugin-mcp/src/index.ts'
import * as nas from '../packages/plugin-nas/src/index.ts'
import * as skillhub from '../packages/plugin-skillhub/src/index.ts'
import * as modelgw from '../packages/plugin-modelgw/src/index.ts'
import * as connect from '../packages/plugin-connect/src/index.ts'
import * as update from '../packages/plugin-update/src/index.ts'
import * as portal from '../packages/plugin-portal/src/index.ts'
import * as consolePlugin from '../packages/plugin-console/src/index.ts'
import * as panelCore from '../packages/plugin-panel-core/src/index.ts'
import * as flowCore from '../packages/plugin-flow-core/src/index.ts'
import * as execHub from '../packages/plugin-exec-hub/src/index.ts'

const PORT = 7391 // 独立端口（selftest=7311，workforce 章节=7316）
const NAS_GW_PORT = 7392
const MODEL_STUB_PORT = 7393
const MCP_STUB_PORT = 7394
const RUN_TAG = `wfdrill-${Date.now().toString(36)}`

// 迟到的 keep-alive rejection 不吞汇总输出（同 selftest 纪律）
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
const codeOf = (error) => (error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '')

/** 产品缺陷登记（QA drill 发现、不大改，交总负责人转对应组）。 */
const defects = []
function registerDefect(id, where, expected, actual, reason) {
  defects.push({ id, where, expected, actual, reason })
  console.log(`  \x1b[33m⚠ 产品缺陷登记 ${id}：${where}\n     期望：${expected}\n     实际：${actual}\n     原因：${reason}\x1b[0m`)
}

// ---------------------------------------------------------------- stub：NAS 文件网关（复刻 synology-filestation-mcp 契约，最小集）
const NAS_GW_TOKEN = `gw-${RUN_TAG}`
const NAS_GW_IP = '192.168.0.196'
const nasGwCalls = []
const nasGwStub = createServer(async (req, res) => {
  const json = (status, payload, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(payload))
  }
  if (req.method !== 'POST' || req.url !== '/mcp') return json(404, { error: 'not found' })
  if (req.headers.authorization !== `Bearer ${NAS_GW_TOKEN}`) return json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: '网关鉴权失败' } })
  if (req.headers['x-nas-ip'] !== NAS_GW_IP) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32002, message: '未知 NAS 设备（X-NAS-IP）' } })
  let message = null
  try { message = JSON.parse(await new Promise((resolve, reject) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => resolve(raw)); req.on('error', reject) })) } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
  const sessionHeaders = { 'mcp-session-id': `stub-session-${RUN_TAG}` }
  if (message.id === undefined || message.id === null) { res.writeHead(202, sessionHeaders); res.end(); return }
  const reply = (result) => json(200, { jsonrpc: '2.0', id: message.id, result }, sessionHeaders)
  const text = (value) => reply({ content: [{ type: 'text', text: JSON.stringify(value) }] })
  if (message.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synology-filestation-drill-stub', version: '1.0.0' } })
  if (message.method === 'tools/list') {
    const names = ['fs_list_shares', 'fs_list', 'fs_get_info', 'fs_search', 'fs_download']
    return reply({ tools: names.map((name) => ({ name, description: `stub ${name}`, inputSchema: { type: 'object' } })) })
  }
  if (message.method === 'tools/call') {
    const name = String(message.params?.name ?? '')
    const args = message.params?.arguments ?? {}
    nasGwCalls.push({ name, args, onBehalf: req.headers['x-on-behalf-user'] ?? null })
    if (name === 'fs_list_shares') return text({ shares: [{ name: 'quality', path: '/quality', isdir: true }] })
    if (name === 'fs_list') return text({ files: [{ name: 'Q-1024-sop.md', isdir: false, size: 128 }], total: 1, offset: 0 })
    if (name === 'fs_get_info') {
      const reqPaths = Array.isArray(args.path) ? args.path : [args.path].filter(Boolean)
      return text({ files: reqPaths.map((p) => ({ path: p, name: String(p).split('/').pop(), size: 128, isdir: false })) })
    }
    if (name === 'fs_search') return text({ files: [{ path: `/quality/found/${args.pattern}` }], taskid: 'tsk_1' })
    if (name === 'fs_download') {
      // 对齐真实网关契约：网关进程侧落盘 local_dir（同机/共享卷），返回 saved_to + bytes
      const reqPaths = Array.isArray(args.path) ? args.path : [args.path].filter(Boolean)
      const destDir = String(args.local_dir ?? '/tmp')
      const fsPromises = await import('node:fs/promises')
      await fsPromises.mkdir(destDir, { recursive: true })
      const payload = Buffer.from(`批次 Q-1024 SOP（drill stub）：检验标准与根因分析指引 v1（tag=${RUN_TAG}）`, 'utf8')
      const written = []
      for (const p of reqPaths) {
        const filename = String(p).split('/').filter(Boolean).pop() ?? 'file.bin'
        const target = `${destDir}/${filename}`
        await fsPromises.writeFile(target, payload)
        written.push({ saved_to: target, bytes: payload.length })
      }
      return text(written[0] ?? { saved_to: destDir, bytes: 0 })
    }
    return reply({ content: [{ type: 'text', text: `未知工具：${name}` }], isError: true })
  }
  return reply({ content: [{ type: 'text', text: `方法不存在：${message.method}` }], isError: true })
})

// ---------------------------------------------------------------- stub：OpenAI 兼容模型上游（/v1/chat/completions）
const modelStubCalls = []
const modelStub = createServer(async (req, res) => {
  const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
  let body = {}
  try { body = JSON.parse(await new Promise((resolve) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => resolve(raw)) })) } catch { /* ignore */ }
  modelStubCalls.push({ url: req.url, model: body.model })
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    return json(200, {
      choices: [{ message: { role: 'assistant', content: `批次 Q-1024 根因假设（drill stub）：温控波动导致检验数据漂移，建议复核探头标定（tag=${RUN_TAG}）` } }],
      usage: { prompt_tokens: 120, completion_tokens: 80 },
    })
  }
  return json(404, { error: 'not found' })
})

// ---------------------------------------------------------------- stub：MCP 业务后端（JSON-RPC over HTTP，real 传输层真实往返）
const mcpBackendCalls = []
const mcpBackendStub = createServer(async (req, res) => {
  const json = (status, payload, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(payload)) }
  let message = {}
  try { message = JSON.parse(await new Promise((resolve) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => resolve(raw)) })) } catch { /* ignore */ }
  const sessionHeaders = { 'mcp-session-id': `mcp-stub-session-${RUN_TAG}` }
  if (message.id === undefined || message.id === null) { res.writeHead(202, sessionHeaders); res.end(); return }
  const reply = (result) => json(200, { jsonrpc: '2.0', id: message.id, result }, sessionHeaders)
  if (message.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'qms-batch-drill-stub', version: '1.0.0' } })
  // W1/V11：tools/list 含读（qms_batch_read）与写（qms_batch_export）两工具——远端清单无法自证风险，
  // 经 syncTools 同步后两工具在网关侧一律落 riskLevel='unknown'（不再隐式映射 read）
  if (message.method === 'tools/list') return reply({ tools: [
    { name: 'qms_batch_read', description: 'stub qms_batch_read', inputSchema: { type: 'object' } },
    { name: 'qms_batch_export', description: 'stub qms_batch_export（写：导出批次数据）', inputSchema: { type: 'object' } },
  ] })
  if (message.method === 'tools/call') {
    const name = String(message.params?.name ?? '')
    const args = message.params?.arguments ?? {}
    mcpBackendCalls.push({ name, args })
    return reply({
      content: [{ type: 'text', text: JSON.stringify({ tool: name, factory: args.factoryId ?? '', batch: args.batch ?? '', rows: 128, note: `检验记录读取成功（tag=${RUN_TAG}）` }) }],
      usage: { totalTokens: 21 },
    })
  }
  return reply({ content: [{ type: 'text', text: `未知方法：${message.method}` }], isError: true })
})

await new Promise((resolve) => nasGwStub.listen(NAS_GW_PORT, '127.0.0.1', resolve))
await new Promise((resolve) => modelStub.listen(MODEL_STUB_PORT, '127.0.0.1', resolve))
await new Promise((resolve) => mcpBackendStub.listen(MCP_STUB_PORT, '127.0.0.1', resolve))

// ---------------------------------------------------------------- 最小树进程内挂载（独立端口 + 独立临时数据目录）
const DATA_DIR = mkdtempSync(join(tmpdir(), 'wf-loop-drill-'))
const evidence = {}
let fatal = null
try {
  const ctx = new Context()
  await ctx.plugin(platformCore, { dataDir: DATA_DIR, http: { port: PORT } })
  await ctx.plugin(resourceCore)
  await ctx.plugin(iam)
  await ctx.plugin(authn)
  await ctx.plugin(usage)
  await ctx.plugin(audit)
  await ctx.plugin(market)
  await ctx.plugin(connector)
  await ctx.plugin(mcp)
  await ctx.plugin(nas)
  await ctx.plugin(skillhub)
  await ctx.plugin(agent)
  await ctx.plugin(app)
  await ctx.plugin(modelgw)
  await ctx.plugin(connect, { role: 'host' })
  await ctx.plugin(update)
  await ctx.plugin(portal)
  await ctx.plugin(consolePlugin)
  await ctx.plugin(panelCore)
  await ctx.plugin(flowCore)
  await ctx.plugin(execHub)
  // workforce 挂载点：全部依赖之后（agent→exec-hub→workforce），dataDir 显式指向隔离目录
  const wf = await import('../packages/plugin-workforce/src/index.ts')
  await ctx.plugin(wf, { dataDir: join(DATA_DIR, 'domain') })

  // ================================================================ S1 契约面
  section('S1 契约面与装配')
  check('A01', 'workforce 挂载后 ctx.workforcePolicy.isReady()=true（策略端口已登记，缺省拒绝面收口）',
    ctx.workforcePolicy?.isReady() === true && typeof ctx.workforcePolicy?.port === 'function' && ctx.workforcePolicy.port() !== null)

  // ================================================================ S2 夹具（组织 + 真人主管 + 测试 Agent + 真实上游）
  section('S2 夹具：测试组织 / 真人主管 / 测试 Agent / 真实上游')
  const adminUser = ctx.iam.users().findOne((u) => u.username === 'admin')
  check('A02', 'console 基线初始化产出 admin（测试真人主管）', Boolean(adminUser?.id))
  const adminPrincipal = ctx.authn.ensureHumanPrincipal(adminUser.id, adminUser.displayName ?? '质量主管')
  const adminCaller = { kind: 'human', principalId: adminPrincipal.id, userId: adminUser.id, name: '质量主管' }
  const org = ctx.iam.createOrg({ name: `金华工厂-QA-drill-${RUN_TAG}` }, iam.SYSTEM_ACTOR)
  check('A03', '测试工作组织创建（§16.1 金华工厂）', Boolean(org?.id))
  const agentReg = ctx.agentRegistry.register({ name: '质量分析员-技术Agent', ownerId: adminUser.id, ownerName: '质量主管', orgId: org.id, attrs: { description: 'workforce-loop-drill：数字员工绑定用', model: 'deepseek-chat', riskLevel: 'low' } })
  const agentA = agentReg.agent
  // 机器 caller（§13.2）：主体来自已验证机器凭证（refType=agent 可反查员工绑定），非请求参数自报
  const machineCaller = { kind: 'machine', principalId: agentReg.credential.principal.id, refType: 'agent', refId: agentA.id, name: agentA.name }
  const rivalReg = ctx.agentRegistry.register({ name: '撞绑用-他人Agent', ownerId: adminUser.id, ownerName: '质量主管', orgId: org.id, attrs: { description: 'workforce-loop-drill：排他认领用', model: 'deepseek-chat', riskLevel: 'low' } })
  const rivalCaller = { kind: 'machine', principalId: rivalReg.credential.principal.id, refType: 'agent', refId: rivalReg.agent.id, name: rivalReg.agent.name }
  check('A04', '测试 Agent×2 与机器凭证就位（refType=agent）',
    Boolean(agentA?.id && agentReg.credential?.principal?.id && rivalReg.agent?.id && rivalReg.credential?.principal?.id))

  // 真实上游①：模型目录登记（endpoint 指向本进程 stub，§16.2 步骤5）
  const MODEL_SLUG = `drill-qa-model-${RUN_TAG}`
  ctx.modelGateway.upsertModel({ slug: MODEL_SLUG, displayName: 'drill 质量分析模型', provider: 'stub', endpoint: `http://127.0.0.1:${MODEL_STUB_PORT}/v1`, apiKey: `sk-${RUN_TAG}`, costCentsPerKTokens: 1, status: 'online', dataClassLimit: 'internal' })
  // 真实上游②：MCP 服务（real 传输，endpoint 指向本进程 stub）+ 权限组；测试验证→全量上架
  // （§16.2 步骤2 检验数据读取；D1 修复后受管真实调用走「网关工作闸门→原权限组→real 传输」全链）
  const mcpService = ctx.mcpRegistry.createService({ name: '质量检验数据服务', slug: `drill-qms-${RUN_TAG}`, description: '批次检验数据读取（drill）', endpoint: `http://127.0.0.1:${MCP_STUB_PORT}/mcp`, transport: 'http', mode: 'external', exec: 'real', orgId: org.id, owner: adminUser.id, tools: [{ name: 'qms_batch_read', description: '读取批次检验数据', inputSchema: { type: 'object' }, riskLevel: 'read' }] })
  await ctx.mcpRegistry.verifyService(mcpService.id)
  await ctx.mcpRegistry.deployService(mcpService.id, { grayPercent: 100, changelog: 'drill 全量上架', actor: adminUser.id })
  const permGroup = ctx.mcpRegistry.createPermGroup({
    name: `drill-qms-ro-${RUN_TAG}`,
    description: '质量分析员只读权限组（drill）',
    policies: { [mcpService.id]: { allowedTools: ['qms_batch_read'], constraints: { readOnly: true } } },
    subjects: [{ type: 'agent', id: agentA.id, name: agentA.name }],
  })
  // 真实上游③：NAS 资产上线（initialize 探活 + tools/list，§16.2 步骤4 SOP 目录）
  const nasEntity = ctx.nasRegistry.register({ name: '质量SOP文件库', slug: `drill-sop-${RUN_TAG}`, attrs: { description: 'SOP 只读目录（drill）', gatewayUrl: `http://127.0.0.1:${NAS_GW_PORT}/mcp`, accessToken: NAS_GW_TOKEN, nasIp: NAS_GW_IP, rootPath: '/' }, ownerId: adminUser.id, orgId: org.id })
  await ctx.nasRegistry.online(nasEntity.id, adminUser.id)
  check('A05', '真实上游就位（模型目录/MCP real 服务已上线+只读权限组/NAS 已上线）',
    Boolean(ctx.modelGateway.models().all().some((m) => m.slug === MODEL_SLUG))
    && ctx.mcpRegistry.services().get(mcpService.id)?.status === 'online'
    && Boolean(ctx.mcpRegistry.services().get(mcpService.id)?.tools.some((t) => t.name === 'qms_batch_read'))
    && ctx.nasRegistry.get(nasEntity.id)?.status === 'online',
    `mcp=${ctx.mcpRegistry.services().get(mcpService.id)?.status} nas=${ctx.nasRegistry.get(nasEntity.id)?.status}`)

  // ================================================================ S3 员工与绑定（§16.1）
  section('S3 员工档案与一对一运行绑定')
  const employee = ctx.workforceEmployees.create({ name: 'jh-quality-analyst', displayName: '金华工厂质量分析员', orgId: org.id, supervisorUserId: adminUser.id, agentId: agentA.id, principalId: agentReg.credential.principal.id, runtime: 'dsh' })
  check('A06', '员工档案创建：active + 主绑定 Agent 回填', employee?.status === 'active' && employee?.primaryAgentId === agentA.id && employee?.supervisorUserId === adminUser.id, JSON.stringify(employee ?? {}))
  const bindings = ctx.workforceEmployees.bindingsFor(employee.id)
  check('A07', '员工↔Agent 一对一有效绑定（active，主体=机器凭证 principal）',
    bindings.length === 1 && bindings[0].agentId === agentA.id && bindings[0].status === 'active' && bindings[0].principalId === agentReg.credential.principal.id, JSON.stringify(bindings))
  const rivalEmployee = ctx.workforceEmployees.create({ name: 'jh-rival-analyst', displayName: '撞绑用员工', orgId: org.id, supervisorUserId: adminUser.id, agentId: rivalReg.agent.id })
  let dupRejected = false
  try { ctx.workforceEmployees.bindAgent(adminCaller, rivalEmployee.id, agentA.id) } catch { dupRejected = true }
  check('A08', '同 Agent 已被占用时再次绑定被拒绝（一对一约束，附录 A 决策 1）', dupRejected)
  evidence.employeeId = employee.id

  // ================================================================ S4 任用（§16.1：mcp 只读 + nas 只读 + model，dataClass=internal）
  section('S4 任用版本与激活探针（§16.1）')
  const grants = [
    { kind: 'mcp', registryId: mcpService.id, actions: ['qms_batch_read'], risk: 'read', constraints: { factoryIds: ['JH-01'] } },
    { kind: 'nas', registryId: nasEntity.id, actions: ['read'], risk: 'read', constraints: { pathPrefixes: ['/quality'] } },
    { kind: 'model', registryId: MODEL_SLUG, actions: ['invoke'], risk: 'read', constraints: { maxTokens: 256 } },
  ]
  const appointment = ctx.workforceAppointments.create({ employeeId: employee.id, position: '金华工厂质量分析员', orgId: org.id, dataClass: 'internal', effectiveFrom: new Date().toISOString(), grants, approvedBy: adminUser.id, approvalRef: `drill-appr-${RUN_TAG}` })
  check('A09', '任用 v1 创建：preparing 起步 + dataClass=internal + 三项资源授权期望',
    appointment?.version === 1 && appointment?.status === 'preparing' && appointment?.dataClass === 'internal', JSON.stringify(appointment ?? {}))
  const activated = await ctx.workforceAppointments.activate(adminCaller, appointment.id)
  check('A10', '激活探针逐 grant 全过 → 任用 effective（不签发 permit 的前提）', activated?.status === 'effective', `status=${activated?.status} reason=${activated?.statusReason}`)
  const grantRows = ctx.workforceCapabilities.grantsFor(appointment.id)
  check('A11', '三项资源授权均 effective 且 ref 回填（真实权限组/目录映射引用，非 UI 勾选项）',
    grantRows.length === 3 && grantRows.every((g) => g.status === 'effective' && g.ref !== ''),
    JSON.stringify(grantRows.map((g) => ({ kind: g.kind, status: g.status, ref: g.ref }))))
  const manifest = ctx.workforceCapabilities.activeForAppointment(appointment.id)
  const tools = manifest ? ctx.workforceCapabilities.toolsFor(manifest.id) : []
  check('A12', '能力清单 active 且句柄非空（mcp/nas/model 各 ≥1，任务允许的工具句柄集）',
    Boolean(manifest) && manifest.status === 'active'
      && tools.some((t) => t.kind === 'mcp') && tools.some((t) => t.kind === 'nas') && tools.some((t) => t.kind === 'model'),
    `manifest=${manifest?.id ?? '无'} tools=${JSON.stringify(tools.map((t) => t.handle))}`)
  evidence.appointmentId = appointment.id
  evidence.manifestId = manifest?.id ?? ''

  // ================================================================ S5 认领（§16.2 步骤1：拉取并认领待办）
  section('S5 exec-hub 目标/任务认领：permit / 租约 / run 齐备 + 幂等')
  const issue = ctx.execHub.createIssue({ orgId: org.id, title: '分析批次 Q-1024 异常，输出可复核根因假设与纠正建议', assigneeAgentId: agentA.id, createdBy: adminUser.id })
  check('A13', 'exec-hub 任务创建（todo 起步，指派给员工技术 Agent）', Boolean(issue?.id) && issue.status === 'todo', JSON.stringify({ id: issue?.id, status: issue?.status }))
  const claim1 = await ctx.workforceAdmission.claimWork(machineCaller, { issueId: issue.id })
  check('A14', '机器 WorkCallerRef（refType=agent）首次认领：run/租约/permit/清单四件套齐备',
    claim1.ok === true && Boolean(claim1.runId) && Boolean(claim1.lease?.id) && claim1.lease.leaseVersion >= 1 && Boolean(claim1.permit?.id) && claim1.tools.length >= 1,
    JSON.stringify(claim1.ok ? {} : { code: claim1.code, message: claim1.message }).slice(0, 240))
  check('A15', 'permit 与租约绑定一致（runId/leaseId/leaseVersion 服务端投影，issue.executionRunId 同步）',
    claim1.ok === true
    && claim1.permit.runId === claim1.runId
    && claim1.permit.leaseId === claim1.lease.id
    && claim1.permit.leaseVersion === claim1.lease.leaseVersion
    && ctx.execHub.issues().get(issue.id)?.executionRunId === claim1.runId,
    JSON.stringify(claim1.ok ? { run: claim1.runId, lease: claim1.lease.id, v: claim1.lease.leaseVersion } : claim1))
  evidence.issueId = issue.id
  if (claim1.ok === true) {
    evidence.runId = claim1.runId
    evidence.permitId = claim1.permit.id
    evidence.leaseVersion = claim1.lease.leaseVersion
  }
  const claimReplay = await ctx.workforceAdmission.claimWork(machineCaller, { issueId: issue.id })
  check('A16', '同主体同任务重复认领幂等：idempotent=true 且 runId/permitId 不变（不产生第二租约）',
    claimReplay.ok === true && claimReplay.idempotent === true && claimReplay.runId === claim1.runId && claimReplay.permit.id === claim1.permit.id,
    JSON.stringify(claimReplay.ok ? { idempotent: claimReplay.idempotent, runId: claimReplay.runId } : claimReplay).slice(0, 240))
  let rivalOutcome = { rejected: false, detail: '' }
  try {
    const rival = await ctx.workforceAdmission.claimWork(rivalCaller, { issueId: issue.id })
    rivalOutcome = { rejected: rival.ok === false, detail: rival.ok === false ? `code=${rival.code}` : JSON.stringify(rival).slice(0, 120) }
  } catch (error) {
    // 服务层以 WorkforceError 异常拒绝同样成立（诚实失败即可）
    rivalOutcome = { rejected: true, detail: `throw ${codeOf(error) || errText(error)}` }
  }
  check('A17', '他人主体（另一 Agent 绑定）认领同任务被拒绝（租约排他）',
    rivalOutcome.rejected, rivalOutcome.detail)
  const renewed = await ctx.workforceAdmission.renewWorkLease(machineCaller, claim1.permit.id)
  check('A18', '续租心跳成功（D3 修复硬化：同主体同 run 同租约，renewedAt/expiresAt 推进，版本不变）',
    renewed.ok === true
    && renewed.lease.id === claim1.lease.id
    && renewed.lease.leaseVersion === claim1.lease.leaseVersion
    && renewed.lease.expiresAt > claim1.lease.expiresAt
    && renewed.lease.renewedAt >= claim1.lease.acquiredAt,
    JSON.stringify(renewed.ok
      ? { lease: renewed.lease.id.slice(0, 16), expiresAt: `${claim1.lease.expiresAt}→${renewed.lease.expiresAt}`, renewedAt: renewed.lease.renewedAt }
      : { code: renewed.code, message: renewed.message }))

  // ================================================================ S6 受控调用（§16.2 步骤2/4/5 + §16.3 异常路径）
  section('S6 受控调用：NAS 只读真实路径 / 模型真实路径 / MCP 真实全链 + 策略拒绝 + 步骤幂等')
  const nasHandle = claim1.tools.find((t) => t.kind === 'nas')
  const modelHandle = claim1.tools.find((t) => t.kind === 'model')
  const mcpHandle = claim1.tools.find((t) => t.kind === 'mcp')
  const NAS_STEP = 'drill.step1.read_sop'
  const NAS_ARGS = { path: '/quality/sop/Q-1024-sop.md' }
  const nasInvoke = await ctx.workforceInvocations.invoke(machineCaller, { permitId: claim1.permit.id, toolHandle: nasHandle.handle, stepKey: NAS_STEP, arguments: NAS_ARGS })
  check('A19', 'NAS 只读真实调用 completed（§16.2 步骤4：SOP 读取，网关真实往返 + 内容回传）',
    nasInvoke.status === 'completed' && typeof nasInvoke.content === 'string' && nasInvoke.content.includes(RUN_TAG)
      && modelStubCalls !== null && nasGwCalls.some((c) => c.name === 'fs_download'),
    JSON.stringify({ status: nasInvoke.status, content: String(nasInvoke.content ?? '').slice(0, 60) }))
  const nasRecord = await ctx.workforceInvocations.get(machineCaller, nasInvoke.invocationId)
  check('A20', 'NAS 调用步骤事实落账（InvocationRecord 归属/租约/参数摘要哈希齐备）',
    nasRecord.employeeId === employee.id && nasRecord.runId === claim1.runId && nasRecord.permitId === claim1.permit.id
      && nasRecord.appointmentId === appointment.id && nasRecord.status === 'completed'
      && /^[0-9a-f]{64}$/.test(nasRecord.argsHash) && nasRecord.settledAt !== '',
    JSON.stringify({ id: nasRecord.id, status: nasRecord.status, argsHash: nasRecord.argsHash.slice(0, 12) }))
  evidence.invocations = [{ id: nasRecord.id, stepKey: nasRecord.stepKey, kind: nasRecord.kind, status: nasRecord.status, errorCode: nasRecord.errorCode }]

  const MODEL_STEP = 'drill.step2.draft'
  const MODEL_ARGS = { messages: [{ role: 'user', content: '根据批次 Q-1024 检验数据与 SOP 形成根因假设' }] }
  const modelInvoke = await ctx.workforceInvocations.invoke(machineCaller, { permitId: claim1.permit.id, toolHandle: modelHandle.handle, stepKey: MODEL_STEP, arguments: MODEL_ARGS })
  check('A21', '模型真实调用 completed（§16.2 步骤5：草案生成，网关证据含 tokens/密级）',
    modelInvoke.status === 'completed' && typeof modelInvoke.content === 'string' && modelInvoke.content.includes(RUN_TAG)
      && Boolean(modelInvoke.gatewayRef?.model) && modelInvoke.gatewayRef?.dataClass === 'internal'
      && modelStubCalls.some((c) => c.model === MODEL_SLUG),
    JSON.stringify({ status: modelInvoke.status, gatewayRef: modelInvoke.gatewayRef ?? {} }).slice(0, 240))
  evidence.invocations.push({ id: modelInvoke.invocationId, stepKey: MODEL_STEP, kind: 'model', status: modelInvoke.status, errorCode: '' })

  const usageLinks = ctx.workforceStore.usageLinks.findWhere({ invocationId: modelInvoke.invocationId })
  const linkedEvent = usageLinks.length > 0 ? (ctx.usage.query({}).items ?? []).find((e) => e.event_id === usageLinks[0].usageEventId) : undefined
  check('A22', '模型调用 usage 关联：workforce_usage_links ≥1 且事件在消费台账（§11.3 只关联不复制流水）',
    usageLinks.length >= 1 && Boolean(linkedEvent) && linkedEvent.resource === `model:${MODEL_SLUG}`,
    JSON.stringify({ links: usageLinks.length, event: linkedEvent ? { id: linkedEvent.event_id, resource: linkedEvent.resource } : null }))
  evidence.usageLinkCount = usageLinks.length

  const MCP_STEP = 'drill.step3.batch_read'
  const MCP_ARGS = { factoryId: 'JH-01', batch: 'Q-1024' }
  const mcpInvoke = await ctx.workforceInvocations.invoke(machineCaller, { permitId: claim1.permit.id, toolHandle: mcpHandle.handle, stepKey: MCP_STEP, arguments: MCP_ARGS })
  // D1 修复硬化：受管真实 MCP 调用走「网关工作闸门（permit 校验）→原权限组→real 传输」全链
  const gatewayWorkCall = ctx.mcpRegistry.calls().findOne((c) => c.serviceId === mcpService.id && c.ok === true && c.work?.permitId === claim1.permit.id)
  const mcpUsageEvent = (ctx.usage.query({}).items ?? []).find((e) => e.resource === `mcp:${mcpService.slug}`)
  check('A23', 'MCP 真实调用 completed（网关工作闸门→原权限组→real 传输全链；网关落工作关联与 usage 事件）',
    mcpInvoke.status === 'completed' && mcpBackendCalls.some((c) => c.name === 'qms_batch_read')
      && Boolean(gatewayWorkCall) && gatewayWorkCall.work?.employeeId === employee.id && Boolean(mcpUsageEvent),
    JSON.stringify({ status: mcpInvoke.status, stubCalls: mcpBackendCalls.length, gatewayWork: Boolean(gatewayWorkCall), usageEvent: mcpUsageEvent?.event_id ?? null }).slice(0, 240))
  evidence.invocations.push({ id: mcpInvoke.invocationId, stepKey: MCP_STEP, kind: 'mcp', status: mcpInvoke.status, errorCode: '' })

  // V08/V28 策略拒绝：句柄不在能力清单 → 预留前 fail-closed 拒绝（不产生调用记录，不给未授予动作留账面）
  const rogueHandle = `${mcpService.id}.qms_batch_export`
  const rogueInManifest = ctx.workforceCapabilities.toolsFor(claim1.manifest.id).some((t) => t.handle === rogueHandle)
  const rogueLeakProbe = () => ctx.workforceStore.invocations.findWhere({ runId: claim1.runId, stepKey: 'drill.step4.rogue' }).length > 0
  let rogueCode = ''
  try {
    const rogue = await ctx.workforceInvocations.invoke(machineCaller, { permitId: claim1.permit.id, toolHandle: rogueHandle, stepKey: 'drill.step4.rogue', arguments: { factoryId: 'JH-01' } })
    rogueCode = rogue.status === 'denied' ? (rogue.code ?? '') : `status=${rogue.status}`
  } catch (error) {
    rogueCode = codeOf(error) || errText(error) // 服务层以 WorkforceError 抛出同样成立
  }
  check('A24', '句柄不在能力清单 → TOOL_NOT_GRANTED 拒绝（V08/V28 fail-closed，预留前拒绝不留账）',
    !rogueInManifest && rogueCode === 'TOOL_NOT_GRANTED' && !rogueLeakProbe(),
    `inManifest=${rogueInManifest} code=${rogueCode || '未拒绝'} leaked=${rogueLeakProbe()}`)

  // 步骤幂等（§11.5）：completed 步骤同 stepKey 同参数重放 = 回放原事实（不重复执行）
  const mcpStubCallsBeforeReplay = mcpBackendCalls.length
  const replayMcp = await ctx.workforceInvocations.invoke(machineCaller, { permitId: claim1.permit.id, toolHandle: mcpHandle.handle, stepKey: MCP_STEP, arguments: MCP_ARGS })
  check('A25', '同 run 同 stepKey 同参数重放 = 幂等回放（同 invocationId，网关不重复执行）',
    replayMcp.invocationId === mcpInvoke.invocationId && replayMcp.status === 'completed' && mcpBackendCalls.length === mcpStubCallsBeforeReplay,
    JSON.stringify({ first: mcpInvoke.invocationId, replay: replayMcp.invocationId, stubCalls: `${mcpStubCallsBeforeReplay}→${mcpBackendCalls.length}` }))
  let conflictCode = ''
  try {
    // 不同参数须仍在业务范围内（factoryId 命中授权工厂），仅改变批次号 → 只触发步骤冲突而非范围拒绝
    const conflict = await ctx.workforceInvocations.invoke(machineCaller, { permitId: claim1.permit.id, toolHandle: mcpHandle.handle, stepKey: MCP_STEP, arguments: { factoryId: 'JH-01', batch: 'Q-9999' } })
    conflictCode = conflict.status === 'denied' ? (conflict.code ?? '') : `status=${conflict.status}`
  } catch (error) {
    conflictCode = codeOf(error) || errText(error) // 服务层以 WorkforceError 抛出同样成立
  }
  check('A26', '同 stepKey 不同参数 = STEP_ARGUMENT_CONFLICT 冲突拒绝（不覆盖原动作）',
    conflictCode === 'STEP_ARGUMENT_CONFLICT', `code=${conflictCode}`)

  // D2 修复硬化：completed 步骤（NAS）的同参数重放——回放原结果且网关不重复执行
  const nasStubCallsBeforeReplay = nasGwCalls.length
  const replayNas = await ctx.workforceInvocations.invoke(machineCaller, { permitId: claim1.permit.id, toolHandle: nasHandle.handle, stepKey: NAS_STEP, arguments: NAS_ARGS })
  check('A35', 'completed 步骤同参数重放 = 幂等回放（同 invocationId，NAS 网关不重复落盘）',
    replayNas.invocationId === nasInvoke.invocationId && replayNas.status === 'completed' && nasGwCalls.length === nasStubCallsBeforeReplay,
    JSON.stringify({ first: nasInvoke.invocationId, replay: replayNas.invocationId, status: replayNas.status, stubCalls: `${nasStubCallsBeforeReplay}→${nasGwCalls.length}` }))

  // ================================================================ S7 交付与验收（§16.2 步骤6/7：完成与验收分开）
  section('S7 受控 artifact → 交付 submit → review → accept/reject 决策')
  const artifact = await ctx.workforceArtifacts.createUpload(machineCaller, {
    name: 'Q-1024-根因分析草案.md', contentType: 'text/markdown',
    contentBase64: Buffer.from(`# 批次 Q-1024 根因分析\n\n根因假设与纠正建议（证据：SOP+检验数据+模型草案，tag=${RUN_TAG}）。`).toString('base64'),
    runId: claim1.runId,
  })
  check('A27', '受控 artifact 上传（staging 元信息 + sha256 摘要 + 归属本 run）',
    Boolean(artifact?.id) && artifact.sizeBytes > 0 && /^[0-9a-f]{64}$/.test(artifact.sha256 ?? '') && artifact.runId === claim1.runId && artifact.employeeId === employee.id,
    JSON.stringify(artifact ?? {}))
  evidence.artifactId = artifact.id
  let v30Code = ''
  try { await ctx.workforceDelivery.submit(machineCaller, { permitId: claim1.permit.id, summary: '仅摘要无证据（drill）', artifactIds: [] }) } catch (error) { v30Code = codeOf(error) || errText(error) }
  check('A28', '仅摘要无证据的交付被拒（ARTIFACT_SCOPE_DENIED，V30）', v30Code === 'ARTIFACT_SCOPE_DENIED', `code=${v30Code}`)
  const deliverable = await ctx.workforceDelivery.submit(machineCaller, { permitId: claim1.permit.id, summary: '批次 Q-1024 根因假设与纠正建议（附 SOP/数据/草案证据）', artifactIds: [artifact.id] })
  const issueAfterSubmit = ctx.execHub.issues().get(issue.id)
  check('A29', '交付 submit → exec-hub 任务转 review（技术完成≠验收完成，§6.5）',
    deliverable?.status === 'submitted' && issueAfterSubmit?.status === 'review',
    JSON.stringify({ deliverable: deliverable?.status, issue: issueAfterSubmit?.status }))
  evidence.deliverableId = deliverable.id
  const accepted = await ctx.workforceDelivery.decide(adminCaller, { deliverableId: deliverable.id, decision: 'accepted', reason: 'drill：证据齐备验收通过' })
  const issueAfterAccept = ctx.execHub.issues().get(issue.id)
  check('A30', 'accept 决策（真人）→ 任务 done（验收权决定业务完成）',
    accepted?.status === 'accepted' && issueAfterAccept?.status === 'done' && accepted.decidedBy === adminUser.id,
    JSON.stringify({ decision: accepted?.status, issue: issueAfterAccept?.status, by: accepted?.decidedBy }))
  evidence.acceptance = { deliverableId: deliverable.id, decision: 'accepted', by: accepted.decidedBy }

  // 退回路径（第二任务）：submit → rejected → 任务回 in_progress 且调用事实保留（V30 语义）
  const issue2 = ctx.execHub.createIssue({ orgId: org.id, title: '分析批次 Q-1025 异常（退回路径演练）', assigneeAgentId: agentA.id, createdBy: adminUser.id })
  const claimB = await ctx.workforceAdmission.claimWork(machineCaller, { issueId: issue2.id })
  let rejectedOk = false
  let rejectDetail = ''
  if (claimB.ok === true) {
    const bInvoke = await ctx.workforceInvocations.invoke(machineCaller, { permitId: claimB.permit.id, toolHandle: nasHandle.handle, stepKey: 'drill.b1.read_sop', arguments: { path: '/quality/sop/Q-1025-sop.md' } })
    const artifactB = await ctx.workforceArtifacts.createUpload(machineCaller, { name: 'Q-1025-草案v1.md', contentType: 'text/markdown', contentBase64: Buffer.from('证据不足的草案 v1').toString('base64'), runId: claimB.runId })
    const deliverableB = await ctx.workforceDelivery.submit(machineCaller, { permitId: claimB.permit.id, summary: '待退回交付（drill）', artifactIds: [artifactB.id] })
    const rejected = await ctx.workforceDelivery.decide(adminCaller, { deliverableId: deliverableB.id, decision: 'rejected', reason: 'drill：证据不足退回' })
    const issue2After = ctx.execHub.issues().get(issue2.id)
    const factsKept = await ctx.workforceInvocations.listByRun(machineCaller, claimB.runId)
    rejectedOk = rejected?.status === 'rejected' && issue2After?.status === 'in_progress'
      && factsKept.some((f) => f.id === bInvoke.invocationId && f.status === 'completed')
    rejectDetail = JSON.stringify({ decision: rejected?.status, issue: issue2After?.status, facts: factsKept.length }).slice(0, 200)
    evidence.rejection = { deliverableId: deliverableB.id, decision: 'rejected', runId: claimB.runId, invocationFactsKept: factsKept.length }
  } else {
    rejectDetail = `第二任务认领失败：${JSON.stringify({ code: claimB.code, message: claimB.message }).slice(0, 160)}`
  }
  check('A31', '退回路径：rejected → 任务回退 in_progress 且调用事实保留不删（V30）', rejectedOk, rejectDetail)

  // ================================================================ S8 停职撤权（§16.3 / V07：撤权即终结受控动作）
  section('S8 停职撤权：permit 全 revoked + verifyPermit fail-closed')
  const suspended = ctx.workforceEmployees.setStatus(adminCaller, employee.id, 'suspended', 'drill：停职撤权演练')
  const permitsAfter = ctx.workforceStore.permits.findWhere({ employeeId: employee.id })
  check('A32', '员工 suspend 后其全部 active permit 被撤销（revoked，V07）',
    suspended?.status === 'suspended' && permitsAfter.length >= 2 && permitsAfter.every((p) => p.status === 'revoked'),
    JSON.stringify(permitsAfter.map((p) => ({ id: p.id.slice(0, 16), status: p.status }))))
  let verifyCode = ''
  try { await ctx.workforceAdmission.verifyPermit(machineCaller, claim1.permit.id) } catch (error) { verifyCode = codeOf(error) || errText(error) }
  check('A33', 'verifyPermit 对已撤 permit 抛错（fail-closed，被撤授权不复活）', verifyCode === 'TOOL_NOT_GRANTED', `code=${verifyCode || '未抛错'}`)
  let reactivated = false
  try { ctx.workforceEmployees.setStatus(adminCaller, employee.id, 'active', 'drill 收尾：复岗'); reactivated = ctx.workforceEmployees.get(employee.id).status === 'active' } catch { reactivated = false }
  check('A34', '复岗流转成功（suspended→active；被撤 permit 不随复岗恢复）', reactivated
    && ctx.workforceStore.permits.findWhere({ employeeId: employee.id }).every((p) => p.status === 'revoked'))

  // ================================================================ S9 W1 风险登记闸门（V11 根治 · D-① 两级审批）
  section('S9 W1 风险登记闸门：未登记写拒绝落账 + 登记→两级审批→按登记风险放行（V11 根治）')
  // 放在 S8 之后的原因：workforce 身份解析恒取「最新生效任用」——若在中途创建第二任用，
  // A31 的 claimB/句柄解析会被重投影到新清单。收尾段创建任用 v2 不影响既有 35 项断言。
  // 工具同步：以远端 tools/list 为准刷新清单 → 全部工具 riskLevel 变 unknown（V11：远端清单不再隐式
  // 映射 read）。A23 夹具在 createService 时已显式申报 riskLevel:'read'，闸门按显式申报值放行只读调用，
  // 此前不受影响；同步后写工具的收敛路径即本节 A36/A37。
  const synced = await ctx.mcpRegistry.syncTools(mcpService.id)
  // 写授权夹具：非只读权限组（unknown 不得借它按 read 放行）+ 任用 v2 授 qms_batch_export（grant risk='write'）
  ctx.mcpRegistry.createPermGroup({
    name: `drill-qms-export-${RUN_TAG}`,
    description: '导出工具权限组（W1 夹具：非只读语境）',
    policies: { [mcpService.id]: { allowedTools: ['qms_batch_export'], constraints: {} } },
    subjects: [{ type: 'agent', id: agentA.id, name: agentA.name }],
  })
  const grantsW = [{ kind: 'mcp', registryId: mcpService.id, actions: ['qms_batch_export'], risk: 'write', constraints: { factoryIds: ['JH-01'] } }]
  const appointmentW = ctx.workforceAppointments.create({ employeeId: employee.id, position: '金华工厂质量分析员（数据导出）', orgId: org.id, dataClass: 'internal', effectiveFrom: new Date().toISOString(), grants: grantsW, approvedBy: adminUser.id, approvalRef: `drill-appr-w-${RUN_TAG}` })
  const activatedW = await ctx.workforceAppointments.activate(adminCaller, appointmentW.id)
  const issueW = ctx.execHub.createIssue({ orgId: org.id, title: '导出批次 Q-1024 检验数据（W1 风险登记演练）', assigneeAgentId: agentA.id, createdBy: adminUser.id })
  const claimW = await ctx.workforceAdmission.claimWork(machineCaller, { issueId: issueW.id })
  const exportHandle = claimW.ok === true ? claimW.tools.find((t) => t.kind === 'mcp' && t.action === 'qms_batch_export') : undefined
  let exportDeny = { status: '', code: '' }
  if (claimW.ok === true && exportHandle) {
    // A36（W1 验收）：未登记写工具受控调用——闸门 facts.risk=unknown（无生效登记），
    // 端口按句柄风险裁决：写句柄 → RISK_UNREGISTERED 拒绝（fail-closed，写能力必须先经登记审批）
    const denyOutcome = await ctx.workforceInvocations.invoke(machineCaller, { permitId: claimW.permit.id, toolHandle: exportHandle.handle, stepKey: 'drill.w1.export_deny', arguments: { factoryId: 'JH-01' } })
    exportDeny = { status: denyOutcome.status, code: denyOutcome.code ?? '' }
  }
  // 网关侧证据：invoke() 的 gate denied 分支照 V07 口径落 mcp:calls（status='denied' + 附领域拒绝码）
  const deniedGatewayCall = ctx.mcpRegistry.calls().findOne((c) => c.serviceId === mcpService.id && c.tool === 'qms_batch_export' && c.status === 'denied')
  check('A36', '未登记写工具受控调用被拒且网关落账（sync 后工具=unknown；RISK_UNREGISTERED 附码落 mcp:calls）',
    synced.tools.length === 2 && synced.tools.every((t) => t.riskLevel === 'unknown')
      && activatedW?.status === 'effective' && claimW.ok === true && Boolean(exportHandle)
      && exportDeny.status === 'denied'
      && Boolean(deniedGatewayCall) && deniedGatewayCall.ok === false && deniedGatewayCall.code === 'RISK_UNREGISTERED',
    `synced=${synced.tools.map((t) => `${t.name}:${t.riskLevel}`).join(',')} activate=${activatedW?.status} claim=${JSON.stringify(claimW.ok ? {} : { code: claimW.code }).slice(0, 120)} outcome=${exportDeny.status}/${exportDeny.code || '（workforce 层不透传网关码，详见 mcp:calls）'} gateway=${deniedGatewayCall ? `${deniedGatewayCall.status}/${deniedGatewayCall.code}` : '未落账'}`)

  // A37（W1 验收）：登记→domain 审→security 审→effective（D-① 两级审批，进程内直调 mcpToolRisks）
  // → 闸门 facts.risk 取登记生效值 write → 端口写句柄匹配放行 → 原权限组 → real 传输完成。
  const riskActor = { id: adminUser.id, name: '质量主管' }
  const riskRecord = ctx.mcpToolRisks.submit({ serviceId: mcpService.id, toolName: 'qms_batch_export', risk: 'write', reason: `drill：质检批次数据导出为受控写能力（tag=${RUN_TAG}）`, actor: riskActor })
  const domainOk = ctx.mcpToolRisks.decide(riskRecord.id, { decision: 'approve', level: 'domain', opinion: 'drill：领域审批通过', actor: riskActor })
  const securityOk = ctx.mcpToolRisks.decide(riskRecord.id, { decision: 'approve', level: 'security', opinion: 'drill：安全加签通过', actor: riskActor })
  const exportOk = claimW.ok === true && exportHandle
    ? await ctx.workforceInvocations.invoke(machineCaller, { permitId: claimW.permit.id, toolHandle: exportHandle.handle, stepKey: 'drill.w1.export_ok', arguments: { factoryId: 'JH-01' } })
    : { status: 'skipped', invocationId: '' }
  const okGatewayCall = ctx.mcpRegistry.calls().findOne((c) => c.serviceId === mcpService.id && c.tool === 'qms_batch_export' && c.ok === true)
  check('A37', '登记+两级审批生效后按登记风险放行（pending_domain→pending_security→effective；受控调用 completed）',
    riskRecord.status === 'pending_domain' && domainOk.status === 'pending_security' && securityOk.status === 'effective'
      && ctx.mcpToolRisks.effectiveRisk(mcpService.id, 'qms_batch_export') === 'write'
      && exportOk.status === 'completed' && mcpBackendCalls.some((c) => c.name === 'qms_batch_export') && Boolean(okGatewayCall),
    `flow=${riskRecord.status}→${domainOk.status}→${securityOk.status} effectiveRisk=${ctx.mcpToolRisks.effectiveRisk(mcpService.id, 'qms_batch_export')} outcome=${exportOk.status} stub=${mcpBackendCalls.some((c) => c.name === 'qms_batch_export')} gatewayOk=${Boolean(okGatewayCall)}`)
  evidence.riskGate = {
    syncedToolsUnknown: synced.tools.every((t) => t.riskLevel === 'unknown'),
    denyOutcome: exportDeny.status,
    deniedCallLogged: Boolean(deniedGatewayCall) && deniedGatewayCall.code === 'RISK_UNREGISTERED',
    registrationId: riskRecord.id,
    registrationFlow: `${riskRecord.status}→${domainOk.status}→${securityOk.status}`,
    exportCompleted: exportOk.status === 'completed',
  }
} catch (error) {
  fatal = error
  console.error(`\x1b[31m[drill][fatal] ${error instanceof Error ? error.stack?.slice(0, 800) ?? error.message : String(error)}\x1b[0m`)
} finally {
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {})
  await new Promise((resolve) => nasGwStub.close(resolve))
  await new Promise((resolve) => modelStub.close(resolve))
  await new Promise((resolve) => mcpBackendStub.close(resolve))
}

// ================================================================ 证据链 JSON（附录 C 证据包最小形态）
console.log(`\n\x1b[90m━━ 证据链（附录 C 证据包最小形态） ━\x1b[0m`)
console.log(JSON.stringify({
  drill: 'workforce-loop-drill',
  port: PORT,
  at: new Date().toISOString(),
  scenario: '§16 质量分析员闭环（金华工厂 · 批次 Q-1024）',
  employeeId: evidence.employeeId ?? null,
  appointmentId: evidence.appointmentId ?? null,
  manifestId: evidence.manifestId ?? null,
  issueId: evidence.issueId ?? null,
  runId: evidence.runId ?? null,
  permitId: evidence.permitId ?? null,
  leaseVersion: evidence.leaseVersion ?? null,
  invocations: evidence.invocations ?? [],
  artifactId: evidence.artifactId ?? null,
  deliverableId: evidence.deliverableId ?? null,
  acceptance: evidence.acceptance ?? null,
  rejection: evidence.rejection ?? null,
  usageLinks: evidence.usageLinkCount ?? 0,
  riskGate: evidence.riskGate ?? null,
  registeredDefects: defects.map((d) => `${d.id} ${d.where}`),
}, null, 2))

// ================================================================ 汇总
const failed = results.filter((item) => !item.pass)
console.log(`\n${'━'.repeat(46)}`)
if (fatal || failed.length > 0) {
  console.log(`  \x1b[1mworkforce-loop-drill：${results.length - failed.length}/${results.length} 通过\x1b[0m`)
  for (const item of failed) console.log(`   ✘ [${item.section}] ${item.id} ${item.name}`)
} else {
  console.log(`  \x1b[1m\x1b[32mworkforce-loop-drill：闭环通过（${results.length} 项断言）\x1b[0m`)
}
// 终扫：opsStorage 防抖刷盘可能在 finally 清理后重建草稿文件——先让挂起刷盘落地，再反复清到目录消失
for (let sweep = 0; sweep < 5 && existsSync(DATA_DIR); sweep++) {
  await new Promise((resolve) => setTimeout(resolve, 120))
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {})
}
process.exit(fatal || failed.length > 0 ? 1 : 0)
