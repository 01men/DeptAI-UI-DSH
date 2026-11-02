/**
 * workforce-rollback-drill —— 数字员工域回滚演练（W7/T08 灰度交付包 · QA/交付组 · 决策 D-②）。
 *
 * 三演练（断言编号 W/G 起）：
 *   演练一 装配回退：git worktree 检出 HEAD 副本，从 src/boot-all.ts / cordis.yml / cordis.patch.yml
 *          三处摘除 workforce（不动仓库原文件），spawn 真实宿主（端口 7327）——断言宿主正常起、
 *          /api/workforce/overview 404、残留 workforce_* 表无害（拷贝数据目录直读验证），
 *          演练后 git worktree remove 且仓库工作区零污染。
 *   演练二 SQLite 增量兼容：带 workforce 宿主（端口 7329）对同一 data 目录二次启动——
 *          ensureTable 幂等（迁移不报错不重建）、员工数据读回一致、行数不翻倍。
 *   演练三 灰度期语义（D-② 组织级 allowlist，进程内最小树，端口 7328）：名单组织认领/续租正常、
 *          名单外组织认领显式拒绝（WORKFORCE_DISABLED）+ workforce.gray.denied 事件可达
 *          （admission/port 双 surface）+ 续租同口径收口 + 观测面不拦 + 事件落账（bus journal）。
 *
 * 用法：node tests/workforce-rollback-drill.mjs（端口 7326-7329，任一断言失败 exit 1）
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
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

const REPO = process.cwd()
const FIXTURE_PORT = 7326 // 演练一夹具（带 workforce 宿主，产出含 workforce_* 表的 data 目录）
const WORKTREE_PORT = 7327 // 演练一摘除装配后的 worktree 宿主
const GRAY_PORT = 7328 // 演练三进程内最小树
const REBOOT_PORT = 7329 // 演练二二次启动
const RUN_TAG = `wf rb-${Date.now().toString(36)}`.replace(/\s/g, '-')
const TMP = mkdtempSync(join(tmpdir(), 'wf-rollback-'))
const FIXTURE_DATA = join(TMP, 'fixture-data')
const COPY_DATA = join(TMP, 'worktree-data')
const REBOOT_DATA = join(TMP, 'reboot-data')
const WORKTREE = join(TMP, 'worktree')

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

// ---------------------------------------------------------------- 宿主进程管理
const hostLogs = new Map()
function spawnHost(port, dataDir, { demoSeed = false } = {}) {
  const env = { ...process.env, DSH_UPDATE_AUTO_CHECK: 'off' }
  if (demoSeed) env.DEMO_SEED = '1'
  const proc = spawn(process.execPath, ['src/main.ts', '--port', String(port), '--data', dataDir], {
    cwd: REPO,
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
  })
  const tail = []
  hostLogs.set(port, tail)
  proc.stderr.on('data', (chunk) => { tail.push(String(chunk)); if (tail.length > 40) tail.shift() })
  return proc
}

async function waitHealthy(port, maxRounds = 100) {
  for (let i = 0; i < maxRounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true
    } catch { /* retry */ }
  }
  return false
}

async function stopHost(proc, signal = 'SIGTERM') {
  if (!proc) return false
  proc.kill(signal)
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (proc.exitCode !== null || proc.signalCode !== null) return true
  }
  proc.kill('SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 500))
  return false
}

function apiFor(port) {
  return async function api(method, path, { token, body } = {}) {
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    let payload = null
    try { payload = await response.json() } catch { /* non-json */ }
    return { status: response.status, ok: payload?.ok ?? false, data: payload?.data, error: payload?.error }
  }
}

/** admin 口令：初始口令文件（基线首启）优先，演示种子回退 Ybk@2026。 */
function adminPasswordOf(dataDir) {
  const pwFile = join(dataDir, 'admin-initial-password.txt')
  if (existsSync(pwFile)) {
    const value = readFileSync(pwFile, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('平台管理员'))[0] ?? ''
    if (value) return value
  }
  return 'Ybk@2026'
}

/** 权威存储旁路直读（只读打开 txnstore.db）。 */
const { DatabaseSync } = await import('node:sqlite')
function sqliteTables(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workforce_%' ORDER BY name`).all().map((row) => row.name)
  } finally {
    db.close()
  }
}
function sqliteCount(dbFile, table) {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() ?? { n: 0 }).n)
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------- 全局状态
let fatal = null
const procs = []
const evidence = { drill: 'workforce-rollback-drill', at: new Date().toISOString(), tmp: TMP, scenarios: {} }
let gitStatusBefore = ''
let worktreeAdded = false

try {
  // ================================================================ 演练一：装配回退（git worktree 摘除三处装配）
  section('演练一 装配回退：git worktree 摘除 boot-all.ts / cordis.yml / cordis.patch.yml 三处 workforce')
  gitStatusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' })
  execFileSync('git', ['worktree', 'add', '--detach', WORKTREE, 'HEAD'], { cwd: REPO, stdio: 'pipe' })
  worktreeAdded = true
  check('W01', 'git worktree 检出 HEAD 副本（不动仓库工作区）',
    existsSync(join(WORKTREE, 'src/boot-all.ts')) && existsSync(join(WORKTREE, 'cordis.yml')) && existsSync(join(WORKTREE, 'cordis.patch.yml')))

  // 三处装配摘除（只改副本；原文件先留指纹，演练后比对零污染）
  const originals = {
    boot: await readFile(join(REPO, 'src/boot-all.ts'), 'utf8'),
    yml: await readFile(join(REPO, 'cordis.yml'), 'utf8'),
    patch: await readFile(join(REPO, 'cordis.patch.yml'), 'utf8'),
  }
  const stripWorkforceLines = (text) => text.split('\n').filter((line) => !/workforce/i.test(line)).join('\n')
  const surgery = {
    boot: stripWorkforceLines(originals.boot),
    yml: stripWorkforceLines(originals.yml),
    patch: stripWorkforceLines(originals.patch),
  }
  await writeFile(join(WORKTREE, 'src/boot-all.ts'), surgery.boot)
  await writeFile(join(WORKTREE, 'cordis.yml'), surgery.yml)
  await writeFile(join(WORKTREE, 'cordis.patch.yml'), surgery.patch)
  check('W02', '三处副本摘除 workforce 且宿主骨架完整（原文件指纹未变、结构关键行保留）',
    !/workforce/i.test(surgery.boot) && !/workforce/i.test(surgery.yml) && !/workforce/i.test(surgery.patch)
    && surgery.boot.includes('dingtalkBridge') && surgery.yml.includes('ops-dingtalk-bridge') && surgery.patch.includes('ops-dingtalk-bridge')
    && (await readFile(join(REPO, 'src/boot-all.ts'), 'utf8')) === originals.boot
    && (await readFile(join(REPO, 'cordis.yml'), 'utf8')) === originals.yml
    && (await readFile(join(REPO, 'cordis.patch.yml'), 'utf8')) === originals.patch)

  // 夹具：带 workforce 宿主产出含 workforce_* 表的 data 目录（含 1 行员工事实）
  const fixtureApi = apiFor(FIXTURE_PORT)
  const fixtureProc = spawnHost(FIXTURE_PORT, FIXTURE_DATA)
  procs.push(fixtureProc)
  const fixtureUp = await waitHealthy(FIXTURE_PORT)
  if (!fixtureUp) throw new Error(`夹具宿主启动失败：${(hostLogs.get(FIXTURE_PORT) ?? []).slice(-4).join('')}`)
  const fxLogin = await fixtureApi('POST', '/api/auth/login', { body: { username: 'admin', password: adminPasswordOf(FIXTURE_DATA) } })
  const fx = fxLogin.data.token
  const fxOrg = await fixtureApi('POST', '/api/iam/orgs', { token: fx, body: { name: `回滚演练组织-${RUN_TAG}` } })
  const fxAgent = await fixtureApi('POST', '/api/agents', { token: fx, body: {
    name: `回滚演练Agent-${RUN_TAG}`, ownerId: fxLogin.data.user.id, ownerName: '平台管理员', orgId: fxOrg.data.id,
    attrs: { description: 'workforce-rollback-drill 夹具', model: 'deepseek-chat', riskLevel: 'low' },
  } })
  const fxEmp = await fixtureApi('POST', '/api/workforce/employees', { token: fx, body: {
    name: 'rollback-analyst', displayName: '回滚演练员工', orgId: fxOrg.data.id,
    supervisorUserId: fxLogin.data.user.id, agentId: fxAgent.data.agent.id, runtime: 'dsh',
  } })
  check('W03', '夹具宿主（带 workforce）产出持久事实：员工 1 行落 SQLite',
    fxEmp.ok && Boolean(fxEmp.data?.id) && sqliteCount(join(FIXTURE_DATA, 'txnstore.db'), 'workforce_employees') === 1,
    JSON.stringify({ login: fxLogin.ok, org: fxOrg.ok, agent: fxAgent.ok, emp: fxEmp.data?.id ?? fxEmp.error }).slice(0, 240))
  await stopHost(fixtureProc)

  // 拷贝数据目录 → worktree 宿主（无 workforce 装配）顶着残留数据启动
  await cp(FIXTURE_DATA, COPY_DATA, { recursive: true })
  // worktree 复用主仓 node_modules（目录符号链接；模块 realpath 落回主仓，装配行为由 worktree 副本决定）
  await symlink(join(REPO, 'node_modules'), join(WORKTREE, 'node_modules'), 'dir').catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error
  })
  const wtApi = apiFor(WORKTREE_PORT)
  const wtProc = spawn(process.execPath, ['src/main.ts', '--port', String(WORKTREE_PORT), '--data', COPY_DATA], {
    cwd: WORKTREE,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DSH_UPDATE_AUTO_CHECK: 'off' },
  })
  procs.push(wtProc)
  const wtLogs = []
  wtProc.stderr.on('data', (chunk) => { wtLogs.push(String(chunk)); if (wtLogs.length > 40) wtLogs.shift() })
  hostLogs.set(WORKTREE_PORT, wtLogs)
  const wtUp = await waitHealthy(WORKTREE_PORT)
  check('W04', '摘除装配后宿主正常启动（/api/health 200，残留 workforce_* 表不阻碍装配）', wtUp, wtLogs.slice(-6).join('').slice(-500))

  const wtOverview = await wtApi('GET', '/api/workforce/overview', { token: (await wtApi('POST', '/api/auth/login', { body: { username: 'admin', password: adminPasswordOf(COPY_DATA) } })).data?.token })
  check('W05', 'workforce 域已摘除：GET /api/workforce/overview → 404（无路由即无工作面）', wtOverview.status === 404,
    `status=${wtOverview.status} error=${JSON.stringify(wtOverview.error ?? {}).slice(0, 120)}`)

  const copiedTables = sqliteTables(join(COPY_DATA, 'txnstore.db'))
  check('W06', 'workforce_* 表残留无害：拷贝数据直读——表齐且员工事实读回一致（数据保留可查，不丢不坏）',
    copiedTables.includes('workforce_employees') && copiedTables.includes('workforce_permits')
    && sqliteCount(join(COPY_DATA, 'txnstore.db'), 'workforce_employees') === 1,
    `tables=${copiedTables.length} employees=${sqliteCount(join(COPY_DATA, 'txnstore.db'), 'workforce_employees')}`)
  await stopHost(wtProc)
  evidence.scenarios.assemblyRollback = { worktree: WORKTREE, copiedTables, overviewStatus: wtOverview.status }

  // ================================================================ 演练二：SQLite 增量兼容（同 data 目录二次启动）
  section('演练二 SQLite 增量兼容：同 data 目录二次启动（ensureTable 幂等，数据不重建不丢）')
  const rbApi = apiFor(REBOOT_PORT)
  const rbProc1 = spawnHost(REBOOT_PORT, REBOOT_DATA)
  procs.push(rbProc1)
  const rbUp1 = await waitHealthy(REBOOT_PORT)
  if (!rbUp1) throw new Error(`演练二首次启动失败：${(hostLogs.get(REBOOT_PORT) ?? []).slice(-4).join('')}`)
  const rbLogin1 = await rbApi('POST', '/api/auth/login', { body: { username: 'admin', password: adminPasswordOf(REBOOT_DATA) } })
  const rb = rbLogin1.data.token
  const rbOrg = await rbApi('POST', '/api/iam/orgs', { token: rb, body: { name: `增量兼容组织-${RUN_TAG}` } })
  const rbAgent = await rbApi('POST', '/api/agents', { token: rb, body: {
    name: `增量兼容Agent-${RUN_TAG}`, ownerId: rbLogin1.data.user.id, ownerName: '平台管理员', orgId: rbOrg.data.id,
    attrs: { description: 'workforce-rollback-drill 演练二', model: 'deepseek-chat', riskLevel: 'low' },
  } })
  const rbEmp = await rbApi('POST', '/api/workforce/employees', { token: rb, body: {
    name: 'incremental-analyst', displayName: '增量兼容员工', orgId: rbOrg.data.id,
    supervisorUserId: rbLogin1.data.user.id, agentId: rbAgent.data.agent.id, runtime: 'dsh',
  } })
  const RB_EMP_ID = rbEmp.data?.id
  const rowsBeforeReboot = sqliteCount(join(REBOOT_DATA, 'txnstore.db'), 'workforce_employees')
  await stopHost(rbProc1)

  const rbProc2 = spawnHost(REBOOT_PORT, REBOOT_DATA)
  procs.push(rbProc2)
  const rbUp2 = await waitHealthy(REBOOT_PORT)
  check('W07', '二次启动成功（ensureTable 幂等：迁移不报错、不重建表、宿主就绪）', rbUp2, (hostLogs.get(REBOOT_PORT) ?? []).slice(-6).join('').slice(-400))
  const rbLogin2 = await rbApi('POST', '/api/auth/login', { body: { username: 'admin', password: adminPasswordOf(REBOOT_DATA) } })
  const rbEmpAfter = await rbApi('GET', `/api/workforce/employees/${RB_EMP_ID}`, { token: rbLogin2.data?.token })
  const rowsAfterReboot = sqliteCount(join(REBOOT_DATA, 'txnstore.db'), 'workforce_employees')
  check('W08', '数据读回一致且不翻倍（员工 REST 读回 = 原记录；SQLite 行数 1→1）',
    rbEmpAfter.ok && rbEmpAfter.data?.id === RB_EMP_ID && rbEmpAfter.data?.name === 'incremental-analyst'
    && rowsBeforeReboot === 1 && rowsAfterReboot === 1,
    JSON.stringify({ before: rowsBeforeReboot, after: rowsAfterReboot, emp: rbEmpAfter.data?.id ?? rbEmpAfter.error }).slice(0, 200))
  await stopHost(rbProc2)
  evidence.scenarios.sqliteIncremental = { employeesBefore: rowsBeforeReboot, employeesAfter: rowsAfterReboot, employeeId: RB_EMP_ID }

  // ================================================================ 演练三：灰度期语义（D-② allowlist，进程内最小树）
  section('演练三 灰度期语义（D-②）：allowlist 名单外显式拒绝并可观测，名单内正常，观测面不拦')
  const grayDataDir = await mkdtemp(join(tmpdir(), 'wf-gray-'))
  const grayCtx = new Context()
  await grayCtx.plugin(platformCore, { dataDir: grayDataDir, http: { port: GRAY_PORT } })
  await grayCtx.plugin(resourceCore)
  await grayCtx.plugin(iam)
  await grayCtx.plugin(authn)
  await grayCtx.plugin(usage)
  await grayCtx.plugin(audit)
  await grayCtx.plugin(market)
  await grayCtx.plugin(connector)
  await grayCtx.plugin(mcp)
  await grayCtx.plugin(nas)
  await grayCtx.plugin(skillhub)
  await grayCtx.plugin(agent)
  await grayCtx.plugin(app)
  await grayCtx.plugin(modelgw)
  await grayCtx.plugin(connect, { role: 'host' })
  await grayCtx.plugin(update)
  await grayCtx.plugin(portal)
  await grayCtx.plugin(consolePlugin)
  await grayCtx.plugin(panelCore)
  await grayCtx.plugin(flowCore)
  await grayCtx.plugin(execHub)
  // 夹具先于 workforce 挂载：enabledOrgs 需要名单组织 ID
  const gAdmin = grayCtx.iam.users().findOne((user) => user.username === 'admin')
  const gPrincipal = grayCtx.authn.ensureHumanPrincipal(gAdmin.id, gAdmin.displayName ?? '平台管理员')
  const gAdminCaller = { kind: 'human', principalId: gPrincipal.id, userId: gAdmin.id, name: '平台管理员' }
  const orgIn = grayCtx.iam.createOrg({ name: `灰度名单组织-${RUN_TAG}` }, iam.SYSTEM_ACTOR)
  const orgOut = grayCtx.iam.createOrg({ name: `灰度名单外组织-${RUN_TAG}` }, iam.SYSTEM_ACTOR)
  const G_MODEL_SLUG = `gray-model-${Date.now() % 100000}`
  grayCtx.modelGateway.upsertModel({ slug: G_MODEL_SLUG, displayName: '灰度演练模型', provider: 'stub', endpoint: 'http://127.0.0.1:9/noop', apiKey: 'sk-gray-drill', costCentsPerKTokens: 1, status: 'online', dataClassLimit: 'internal' })
  // workforce 挂载（灰度配置在此注入——本批落地形态：WorkforceConfig.grayMode/enabledOrgs，契约=contract.ts）
  const wf = await import('../packages/plugin-workforce/src/index.ts')
  await grayCtx.plugin(wf, { dataDir: join(grayDataDir, 'domain'), grayMode: 'allowlist', enabledOrgs: [orgIn.id] })
  check('G01', '灰度配置注入：allowlist + 名单=[名单组织]（WorkforceConfig extends WorkforceGrayConfig，contract.ts 冻结形态）',
    grayCtx.workforcePolicy?.isReady() === true && orgIn.id !== orgOut.id)

  // workforce.gray.denied 事件观测（进程内直连总线；派发为异步串行队列，断言前显式等待排水）
  const grayEvents = []
  grayCtx.platformBus.on('workforce.gray.denied', (payload) => grayEvents.push({ ...(payload ?? {}), seenAt: new Date().toISOString() }))
  const drainBus = () => new Promise((resolve) => setTimeout(resolve, 300))

  const mkEmployeeFixture = (org, agentName, employeeName) => {
    const reg = grayCtx.agentRegistry.register({
      name: agentName, ownerId: gAdmin.id, ownerName: '平台管理员', orgId: org.id,
      attrs: { description: 'workforce-rollback-drill 演练三', model: 'deepseek-chat', riskLevel: 'low' },
    })
    const employee = grayCtx.workforceEmployees.create({
      name: employeeName, displayName: employeeName, orgId: org.id, supervisorUserId: gAdmin.id,
      agentId: reg.agent.id, principalId: reg.credential.principal.id, runtime: 'dsh',
    })
    const caller = { kind: 'machine', principalId: reg.credential.principal.id, refType: 'agent', refId: reg.agent.id, name: reg.agent.name }
    return { reg, employee, caller }
  }
  const activateModelAppointment = async (employee) => {
    const appointment = grayCtx.workforceAppointments.create({
      employeeId: employee.id, position: '质量分析员（灰度演练）', orgId: employee.orgId, dataClass: 'internal',
      effectiveFrom: new Date().toISOString(),
      grants: [{ kind: 'model', registryId: G_MODEL_SLUG, actions: ['invoke'], risk: 'read', constraints: { maxTokens: 64 } }],
      approvedBy: gAdmin.id,
    })
    return grayCtx.workforceAppointments.activate(gAdminCaller, appointment.id)
  }

  // 名单内：认领/续租正常
  const inHouse = mkEmployeeFixture(orgIn, '名单内员工Agent', 'gray-in-analyst')
  const inAppt = await activateModelAppointment(inHouse.employee)
  const issueIn = grayCtx.execHub.createIssue({ orgId: orgIn.id, title: '灰度演练：名单内任务', assigneeAgentId: inHouse.reg.agent.id, createdBy: gAdmin.id })
  const claimIn = await grayCtx.workforceAdmission.claimWork(inHouse.caller, { issueId: issueIn.id })
  check('G02', '名单内组织：认领成功（run/租约/permit 四件套，allowlist 不拦名单组织）',
    claimIn.ok === true && Boolean(claimIn.runId) && Boolean(claimIn.permit?.id),
    JSON.stringify(claimIn.ok ? {} : { code: claimIn.code, message: claimIn.message }).slice(0, 200))
  const renewIn = await grayCtx.workforceAdmission.renewWorkLease(inHouse.caller, claimIn.ok ? claimIn.permit.id : '', {})
  check('G03', '名单内组织：续租正常（灰度只关工作面准入，不误伤名单组织心跳）', renewIn.ok === true, JSON.stringify(renewIn))

  // 名单外：认领显式拒绝（WORKFORCE_DISABLED）且发生在确认前
  const outHouse = mkEmployeeFixture(orgOut, '名单外员工Agent', 'gray-out-analyst')
  const outAppt = await activateModelAppointment(outHouse.employee)
  const issueOut = grayCtx.execHub.createIssue({ orgId: orgOut.id, title: '灰度演练：名单外任务', assigneeAgentId: outHouse.reg.agent.id, createdBy: gAdmin.id })
  let outClaim = { denied: false, code: '', message: '' }
  try {
    const verdict = await grayCtx.workforceAdmission.claimWork(outHouse.caller, { issueId: issueOut.id })
    outClaim = verdict.ok
      ? { denied: false, code: 'NOT_DENIED', message: `意外成功 run=${verdict.runId}` }
      : { denied: verdict.code === 'WORKFORCE_DISABLED', code: verdict.code, message: verdict.message }
  } catch (error) {
    // 服务层以 WorkforceError 显式抛出＝拒绝语义（admission 收口形态：抛 403 领域错误）
    outClaim = { denied: error?.code === 'WORKFORCE_DISABLED', code: error?.code ?? errText(error), message: error?.message ?? '' }
  }
  check('G04', '名单外组织：认领显式拒绝 WORKFORCE_DISABLED（中文灰度语义，非静默回落）',
    outClaim.denied && outClaim.message.includes('灰度关闭'),
    JSON.stringify(outClaim).slice(0, 240))
  check('G05', '拒绝发生在确认前：名单外任务无 run 投影、无 permit、无租约（不产生半开工作状态）',
    (issueOut.executionRunId ?? '') === '' && grayCtx.workforceStore.permits.findWhere({ employeeId: outHouse.employee.id }).length === 0,
    `executionRunId=${issueOut.executionRunId ?? '空'} permits=${grayCtx.workforceStore.permits.findWhere({ employeeId: outHouse.employee.id }).length}`)

  // admission 侧事件可达（surface:'admission'）
  await drainBus()
  const admissionEvent = grayEvents.find((event) => event.surface === 'admission' && event.orgId === orgOut.id)
  check('G06', 'workforce.gray.denied 事件可达（surface=admission，payload 含 orgId/employeeId/at）',
    Boolean(admissionEvent) && admissionEvent.employeeId === outHouse.employee.id && Boolean(admissionEvent.at),
    JSON.stringify(grayEvents).slice(0, 240))

  // port 侧同口径（受控调用入口同判同事件）
  let portVerdict = null
  try {
    portVerdict = await grayCtx.workforcePolicy.port().authorizeWorkAction(outHouse.caller, {
      facts: { kind: 'model', registryId: G_MODEL_SLUG, action: 'invoke', risk: 'read' },
      ref: {},
    })
  } catch (error) {
    portVerdict = { allow: false, code: errText(error), message: '' }
  }
  await drainBus()
  const portEvent = grayEvents.find((event) => event.surface === 'port' && event.orgId === orgOut.id)
  check('G07', 'port 侧同口径拒绝（authorizeWorkAction → WORKFORCE_DISABLED + surface=port 事件；三分支口径一致）',
    portVerdict?.allow === false && portVerdict?.code === 'WORKFORCE_DISABLED' && Boolean(portEvent),
    JSON.stringify({ verdict: portVerdict, eventCount: grayEvents.length }).slice(0, 240))
  // 续租同口径收口：以灰度关闭配置复核名单内既有 permit（原型链构造，不动挂载实例与 cordis 注册表）
  const { AdmissionService } = await import('../packages/plugin-workforce/src/admission-service.ts')
  const closedAdmission = Object.create(AdmissionService.prototype)
  closedAdmission.ctx = grayCtx
  closedAdmission.grayConfig = { grayMode: 'allowlist', enabledOrgs: [] } // 组织被移出名单后的续租请求
  let renewDenied = { denied: false, code: '', message: '' }
  try {
    const verdict = await closedAdmission.renewWorkLease(inHouse.caller, claimIn.ok ? claimIn.permit.id : '')
    renewDenied = { denied: false, code: verdict.ok ? 'NOT_DENIED' : verdict.code, message: verdict.message ?? '' }
  } catch (error) {
    renewDenied = { denied: error?.code === 'WORKFORCE_DISABLED', code: error?.code ?? errText(error), message: error?.message ?? '' }
  }
  await drainBus()
  check('G08', '续租同口径收口：关闭组织的既有 permit 也不得续租延长工作（WORKFORCE_DISABLED + 事件）',
    renewDenied.denied && renewDenied.message.includes('灰度关闭')
    && grayEvents.filter((event) => event.surface === 'admission').length >= 2,
    JSON.stringify({ renewDenied, events: grayEvents.map((event) => event.surface) }).slice(0, 240))

  // 观测面不拦：名单外员工身份解析/待办拉取照常（观测开放，仅工作路径收口）
  const outResolution = await grayCtx.workforceIdentity.resolveByCaller(outHouse.caller)
  check('G09', '观测面不拦：名单外员工身份仍可解析（拉取/状态查询保持开放，V29 口径=拒绝且可观测而非失联）',
    Boolean(outResolution) && outResolution.employee.id === outHouse.employee.id && outResolution.appointment.status === 'effective',
    JSON.stringify({ resolved: Boolean(outResolution) }))

  // 事件落账（bus journal 持久化，重启可回放）
  const journalFile = join(grayDataDir, 'bus-journal.jsonl')
  const journalLines = existsSync(journalFile)
    ? readFileSync(journalFile, 'utf8').split('\n').filter((line) => line.includes('"workforce.gray.denied"'))
    : []
  check('G10', 'denied 落账：bus journal 持久化 ≥3 条 workforce.gray.denied（admission×2 + port×1，重启可回放）',
    journalLines.length >= 3, `journal=${journalLines.length} lines`)
  evidence.scenarios.gray = {
    mode: 'allowlist',
    enabledOrgs: [orgIn.id],
    deniedEvents: grayEvents.length,
    journalLines: journalLines.length,
    outClaim,
    portVerdict: { allow: portVerdict?.allow, code: portVerdict?.code },
    renewDenied,
  }
  await rm(grayDataDir, { recursive: true, force: true }).catch(() => {})
} catch (error) {
  fatal = error
  console.error(`\x1b[31m[drill][fatal] ${error instanceof Error ? error.stack?.slice(0, 900) ?? error.message : String(error)}\x1b[0m`)
} finally {
  // 收尾：worktree 摘除 + 目录清扫 + 仓库工作区零污染校验
  console.log('\n\x1b[90m» 收尾：worktree remove + 临时目录清扫…\x1b[0m')
  let worktreeRemoved = false
  if (worktreeAdded) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', WORKTREE], { cwd: REPO, stdio: 'pipe' })
      execFileSync('git', ['worktree', 'prune'], { cwd: REPO, stdio: 'pipe' })
      worktreeRemoved = !existsSync(WORKTREE)
    } catch (error) {
      console.error(`\x1b[33m[drill] worktree remove 失败（需人工清理 ${WORKTREE}）：${errText(error)}\x1b[0m`)
    }
  }
  let gitStatusAfter = gitStatusBefore
  let repoClean = true
  try {
    gitStatusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' })
    repoClean = gitStatusAfter === gitStatusBefore
  } catch { /* git 不可用时跳过校验 */
    gitStatusAfter = `error`
  }
  check('W09', '演练收尾：git worktree 已移除，仓库工作区零污染（git status 与演练前一致）',
    worktreeRemoved && repoClean, `removed=${worktreeRemoved} clean=${repoClean}`)

  for (const proc of procs) {
    try { proc.kill('SIGKILL') } catch { /* already dead */ }
  }
  for (let sweep = 0; sweep < 6 && existsSync(TMP); sweep++) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    await rm(TMP, { recursive: true, force: true }).catch(() => {})
  }
  evidence.worktreeRemoved = worktreeRemoved
  evidence.repoClean = repoClean
}

// ================================================================ 证据 JSON + 汇总
console.log(`\n\x1b[90m━━ 证据 JSON ━\x1b[0m`)
evidence.assertions = results.map((item) => ({ id: item.id, name: item.name, pass: item.pass }))
console.log(JSON.stringify(evidence, null, 2))

const failed = results.filter((item) => !item.pass)
console.log(`\n${'━'.repeat(46)}`)
if (fatal || failed.length > 0) {
  console.log(`  \x1b[1mworkforce-rollback-drill：${results.length - failed.length}/${results.length} 通过\x1b[0m`)
  for (const item of failed) console.log(`   ✘ [${item.section}] ${item.id} ${item.name}`)
} else {
  console.log(`  \x1b[1m\x1b[32mworkforce-rollback-drill：三演练全部通过（${results.length} 项断言）\x1b[0m`)
}
process.exit(fatal || failed.length > 0 ? 1 : 0)
