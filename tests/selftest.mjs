/**
 * 功能自测：启动隔离实例（独立端口 + 独立数据目录），对全链路做端到端断言。
 * 覆盖：认证/RBAC、IAM 生命周期与三方同步、令牌吊销联动、MCP 部署灰度与网关鉴权限流、
 *       Skill 流水线（扫描/两级审批/上架/安装/弃用告警）、Agent/App 生命周期 L4 审批、
 *       on-behalf-of、审计四类日志、告警、成本、工具桥。
 * 用法：npm run selftest
 */
import { spawn } from 'node:child_process'
import { readFileSync as __readFileSyncSeed } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { rm, mkdir } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
// 进程内插件树（dsh 宿主挂载分节：伪造 webServer 模拟 dsh 前缀分发，不经子进程）
import { Context } from '@deepseek-ai/cordis'

// ---------------- Node 22.6–22.17 兼容守卫（issue #4）
// 本文件直接装载 .ts 源（原生 TypeScript 运行，零构建），而 Node 的类型剥离在 22.18 / 23.6 起才默认
// 开启，更早版本必须显式 --experimental-strip-types。静态 import 会被提升到任何语句之前执行，
// 守卫在同一进程内来不及生效，故：(1) 下方 .ts 装载全部改为顶层 await 动态 import；(2) 运行时未
// 默认开启且 NODE_OPTIONS 尚未携带 flag 时自重启——走 NODE_OPTIONS 而非 execArgv，是因为它会被
// 本自测拉起的全部子进程（隔离实例 src/main.ts、各 *.test.mjs）继承，一处守卫覆盖整条链；
// 即便调用方已用 `node --experimental-strip-types` 启动本文件，子进程也不会继承 execArgv，仍需补齐。
function typeStrippingDefaultOn() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
}
if (!typeStrippingDefaultOn() && !(process.env.NODE_OPTIONS ?? '').includes('--experimental-strip-types')) {
  const nodeOptions = [process.env.NODE_OPTIONS, '--experimental-strip-types'].filter(Boolean).join(' ')
  console.log(`\x1b[90m» Node ${process.versions.node} 未默认启用类型剥离，以 NODE_OPTIONS=${nodeOptions} 重启自测…\x1b[0m`)
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  })
  const exitCode = await new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))))
  process.exit(exitCode)
}

// NAS 数据权限纯函数引擎（dev-plan-nas-authz O8：引擎直接单测，不经服务层）
const {
  MATRIX_DEFAULT, buildOrgIndex, check: engineCheck, deriveRole, findVacantLeaderOrgs, nearestLeaderOrg,
} = await import('../packages/plugin-nas/src/authz/engine.ts')
const NAS_AUTHZ_SEED = JSON.parse(__readFileSyncSeed(new URL('../packages/plugin-nas/seed/nas-authz-rules.json', import.meta.url), 'utf8'))
const platformCore = await import('../packages/platform-core/src/index.ts')
const resourceCore = await import('../packages/plugin-resource-core/src/index.ts')
const iam = await import('../packages/plugin-iam/src/index.ts')
const authn = await import('../packages/plugin-authn/src/index.ts')
const usage = await import('../packages/plugin-usage/src/index.ts')
const audit = await import('../packages/plugin-audit/src/index.ts')
const market = await import('../packages/plugin-market/src/index.ts')
const agent = await import('../packages/plugin-agent/src/index.ts')
const app = await import('../packages/plugin-app/src/index.ts')
const connector = await import('../packages/plugin-connector/src/index.ts')
const mcp = await import('../packages/plugin-mcp/src/index.ts')
const nas = await import('../packages/plugin-nas/src/index.ts')
const skillhub = await import('../packages/plugin-skillhub/src/index.ts')
const modelgw = await import('../packages/plugin-modelgw/src/index.ts')
const connect = await import('../packages/plugin-connect/src/index.ts')
const update = await import('../packages/plugin-update/src/index.ts')
const portal = await import('../packages/plugin-portal/src/index.ts')
const consolePlugin = await import('../packages/plugin-console/src/index.ts')
const panelCore = await import('../packages/plugin-panel-core/src/index.ts')
const dingtalkBridge = await import('../packages/plugin-dingtalk-bridge/src/index.ts')
const dshBridge = await import('../packages/plugin-dsh-bridge/src/index.ts')
// 数字员工工作闭环（组7）：flowCore / execHub 为既有插件（顶层装载）；workforce 为并行施工新包——
// 其实现文件由组1/2 持续交付，动态 import（章节内）避免实现未齐时拖垮整个自测装载
const flowCore = await import('../packages/plugin-flow-core/src/index.ts')
const execHub = await import('../packages/plugin-exec-hub/src/index.ts')
const rqCard = await import('../packages/plugin-rq-card/src/index.ts')
const { parseAuthStatus: dwsParseAuthStatus, parseDeviceFlowOutput: dwsParseDeviceFlow } = await import('../packages/plugin-panel-core/src/dws.ts')

const readBody = (req) => new Promise((resolve) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
})

const PORT = 7311
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = join(process.cwd(), 'data-selftest')

/**
 * 为子实例申请空闲端口（QA 2026-10-21 复测结论 §3.3/§6 第 5 条：selftest 的固定端口
 * 7313/7316/7318/7319/7322/7399 与并行测试实例冲突时会产生假失败，本轮 QA 两次踩中）。
 * 用法：`const port = await freePort()` —— listen(0) 拿到内核分配端口后立即释放，
 * 子实例随后绑同一端口（窗口极短，且这些子实例都在本章节内独占运行）。
 * 固定端口仍可经环境变量钉死（SELFTEST_PIN_PORTS=1，便于复现历史环境）。
 */
async function freePort() {
  if (process.env.SELFTEST_PIN_PORTS === '1') return null
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

// 版本期望动态取自根 package.json：bump 版本不再需要联动本文件（QA 2026-10-16 B-1，
// 此前硬编码 '1.1.0' 在仓库升至 1.2.0 后双红）
const ROOT_PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// 收尾阶段（stub close / 实例 SIGKILL 后）undici keep-alive 连接可能出现迟到的 rejection：
// 记录但不让测试进程崩掉（崩了会吞掉汇总输出，2026-09-16 M2 实证）
process.on('unhandledRejection', (reason) => {
  console.error(`\x1b[33m[selftest] 未处理的 rejection（已忽略，不阻断汇总）:\x1b[0m ${String(reason?.cause ?? reason).slice(0, 200)}`)
})

const results = []
let currentSection = ''
function section(name) {
  currentSection = name
  console.log(`\n\x1b[36m━━ ${name} ━━\x1b[0m`)
}
function check(name, condition, detail = '') {
  const pass = Boolean(condition)
  results.push({ section: currentSection, name, pass })
  console.log(`  ${pass ? '\x1b[32m✔' : '\x1b[31m✘'} ${name}\x1b[0m${pass ? '' : `  ← ${detail}`}`)
  return pass
}
async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let payload = null
  try { payload = await response.json() } catch { /* ignore */ }
  return { status: response.status, ok: payload?.ok ?? false, data: payload?.data, error: payload?.error }
}

/** 原始 HTTP 请求（OIDC 协议端点：302 Location / WWW-Authenticate / form 编码等需要原始面）。 */
const rawReq = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
  })
  req.on('error', reject)
  if (body !== undefined) req.write(body)
  req.end()
})
const jsonBody = (raw) => { try { return JSON.parse(raw.body) } catch { return {} } }

/** OIDC 授权流平台端点为原始 JSON 契约（无 {ok,data} 包裹），直连读取。 */
const authReqInfo = async (reqId) => {
  const raw = await rawReq('GET', `/api/authn/oidc/auth-requests/${encodeURIComponent(reqId)}`)
  return { status: raw.status, info: jsonBody(raw) }
}
const authorizeConfirm = async (token, reqId, consent) => {
  const raw = await rawReq('POST', '/api/authn/oidc/authorize', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ reqId, ...(consent !== undefined ? { consent } : {}) }),
  })
  return { status: raw.status, result: jsonBody(raw) }
}

// ---------------------------------------------------------------- stub 上游仓库（平台更新检查用）
// 进程内真实 HTTP stub：raw package.json（版本 9.9.9）+ compare API（落后 2 个提交）。
// 更新插件经 DSH_UPDATE_RAW_BASE / DSH_UPDATE_API_BASE 指向本 stub，自测不依赖外网。
const GH_PORT = 7361
const ghStub = createServer((req, res) => {
  const url = req.url ?? ''
  if (url.endsWith('/package.json')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: 'dsh-enterprise-ops', version: '9.9.9' }))
    return
  }
  if (url.includes('/compare/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      behind_by: 2,
      commits: [
        { sha: 'f1111111111111111111111111111111111111111', commit: { message: 'feat: 上游演示提交一', author: { name: '上游作者', date: '2026-08-24T02:00:00Z' } } },
        { sha: 'a2222222222222222222222222222222222222222', commit: { message: 'fix: 上游演示提交二', author: { name: '上游作者', date: '2026-08-24T03:00:00Z' } } },
      ],
    }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{}')
})
await new Promise((resolve) => ghStub.listen(GH_PORT, '127.0.0.1', resolve))

// ---------------------------------------------------------------- stub NAS 文件网关
// 进程内真实 HTTP stub，复刻 synology-filestation-mcp 契约：
// POST /mcp（initialize / notifications/initialized / tools/list / tools/call），
// 强制校验 Authorization: Bearer 与 X-NAS-IP 设备路由头；fs_upload 按真实网关语义
// 在「网关进程侧」读取 local_file（同机/共享卷契约——本进程可直接读平台 staging 目录）。
const NAS_GW_PORT = 7362
const NAS_GW_TOKEN = 'gw-selftest-token-9f8e7d6c'
const NAS_GW_IP = '192.168.0.196'
const nasGwCalls = []
const nasGwUploads = []
const nasGwStub = createServer(async (req, res) => {
  const json = (status, payload, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(payload))
  }
  if (req.method !== 'POST' || req.url !== '/mcp') return json(404, { error: 'not found' })
  if (req.headers.authorization !== `Bearer ${NAS_GW_TOKEN}`) return json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: '网关鉴权失败' } })
  if (req.headers['x-nas-ip'] !== NAS_GW_IP) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32002, message: '未知 NAS 设备（X-NAS-IP）' } })
  let message = null
  try { message = JSON.parse(await readBody(req)) } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
  const sessionHeaders = { 'mcp-session-id': 'stub-session-selftest' }
  // 通知类消息（无 id）：确认即止
  if (message.id === undefined || message.id === null) { res.writeHead(202, sessionHeaders); res.end(); return }
  const reply = (result) => json(200, { jsonrpc: '2.0', id: message.id, result }, sessionHeaders)
  const replyError = (code, text) => json(200, { jsonrpc: '2.0', id: message.id, error: { code, message: text } }, sessionHeaders)
  if (message.method === 'initialize') {
    return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synology-filestation-stub', version: '1.0.0' } })
  }
  if (message.method === 'tools/list') {
    const names = ['fs_list_shares', 'fs_list', 'fs_get_info', 'fs_search', 'fs_create_folder', 'fs_rename', 'fs_delete', 'fs_upload', 'fs_download', 'fs_task_status']
    return reply({ tools: names.map((name) => ({ name, description: `stub ${name}`, inputSchema: { type: 'object' } })) })
  }
  if (message.method === 'tools/call') {
    const name = String(message.params?.name ?? '')
    const args = message.params?.arguments ?? {}
    nasGwCalls.push({ name, args, onBehalf: req.headers['x-on-behalf-user'] ?? null })
    const text = (value) => reply({ content: [{ type: 'text', text: JSON.stringify(value) }] })
    // 对齐真实 synology-filestation 网关契约（folder_path/path 为字符串/数组；create_folder 用 folder_path+name 一一对应数组；download 用 path 数组 + local_dir）
    if (name === 'fs_list_shares') return text({ shares: [{ name: 'homes', path: '/homes', isdir: true }, { name: 'skillhub', path: '/skillhub', isdir: true }] })
    if (name === 'fs_list') return text({ files: [{ name: 'readme.txt', isdir: false, size: 128 }, { name: 'reports', isdir: true }], total: 2, offset: 0 })
    if (name === 'fs_get_info') {
      const reqPaths = Array.isArray(args.path) ? args.path : [args.path].filter(Boolean)
      return text({ files: reqPaths.map((p) => ({ path: p, name: String(p).split('/').pop(), size: 128, isdir: false })) })
    }
    if (name === 'fs_search') return text({ files: [{ path: `/found/${args.pattern}` }], taskid: 'tsk_1' })
    if (name === 'fs_create_folder') {
      const folders = Array.isArray(args.folder_path) ? args.folder_path : [args.folder_path].filter(Boolean)
      const names = Array.isArray(args.name) ? args.name : [args.name].filter(Boolean)
      return text({ folders: folders.map((folder, i) => ({ path: `${folder}/${names[i] ?? 'new'}`, name: names[i] })) })
    }
    if (name === 'fs_rename') {
      const reqPaths = Array.isArray(args.path) ? args.path : [args.path].filter(Boolean)
      const names = Array.isArray(args.name) ? args.name : [args.name].filter(Boolean)
      return text({ files: reqPaths.map((p, i) => ({ path: `${String(p).split('/').slice(0, -1).join('/')}/${names[i] ?? 'renamed'}`, name: names[i] })) })
    }
    if (name === 'fs_copy_move') return text({ success: true, paths: args.path, dest_folder_path: args.dest_folder_path, moved: !!args.remove_src })
    if (name === 'fs_delete') {
      const reqPaths = Array.isArray(args.path) ? args.path : [args.path].filter(Boolean)
      return text({ success: true, deleted: reqPaths })
    }
    if (name === 'fs_download') {
      const reqPaths = Array.isArray(args.path) ? args.path : [args.path].filter(Boolean)
      const destDir = String(args.local_dir ?? '/tmp')
      const fsPromises = await import('node:fs/promises')
      await fsPromises.mkdir(destDir, { recursive: true })
      const payload = Buffer.from('selftest-download-bytes', 'utf8')
      const written = []
      for (const p of reqPaths) {
        const filename = String(p).split('/').filter(Boolean).pop() ?? 'file.bin'
        const target = `${destDir}/${filename}`
        await fsPromises.writeFile(target, payload)
        written.push({ saved_to: target, bytes: payload.length })
      }
      return text(written[0] ?? { saved_to: destDir, bytes: 0 })
    }
    if (name === 'fs_task_status') return text({ taskid: args.taskid, finished: true })
    if (name === 'fs_upload') {
      // 对齐真实 synology-filestation-mcp 契约：dest_path（目标目录，必填 string）+ local_file（必填 string），
      // 上传文件名取 basename(local_file)；缺必填参数按真实网关回 -32602（zod 校验失败）
      if (typeof args.dest_path !== 'string' || typeof args.local_file !== 'string') {
        return replyError(-32602, 'Input validation error: Invalid arguments for tool fs_upload: Invalid input: expected string, received undefined at dest_path')
      }
      try {
        const buffer = await import('node:fs/promises').then((fs) => fs.readFile(String(args.local_file)))
        const filename = String(args.local_file).split(/[\\/]/).pop()
        nasGwUploads.push({ destPath: args.dest_path, filename, sizeBytes: buffer.length, magic: buffer.subarray(0, 2).toString('latin1'), content: buffer })
        return text({ uploaded: `${args.dest_path}/${filename}`, bytes: buffer.length })
      } catch (error) {
        return reply({ content: [{ type: 'text', text: `fs_upload 网关侧读不到 local_file：${error instanceof Error ? error.message : error}` }], isError: true })
      }
    }
    return replyError(-32601, `未知工具：${name}`)
  }
  return replyError(-32601, `方法不存在：${message.method}`)
})
await new Promise((resolve) => nasGwStub.listen(NAS_GW_PORT, '127.0.0.1', resolve))

// ---------------------------------------------------------------- stub open-connector 数据面网关（v1.4.0 契约）
// 进程内真实 HTTP stub：统一信封 {success,data,meta}/{success:false,errorCode}、
// 强制管理 Bearer、oct_ 令牌策略校验（T-11/T-29）、PUT 四数组严格校验（T-12）、
// token 值仅创建时返回一次、oauth_client_config_required 分支（T-06）、cursor 分页 runs + 注入伪造 run（T-23）。
const OC_STUB_PORT = 7363
const OC_BASE = `http://127.0.0.1:${OC_STUB_PORT}`
const OC_TOKEN = 'oc-selftest-admin-token'
const ocCalls = []          // POST /v1/actions/:id 调用记录 {actionId,bearerOk,alias,idempotencyKey,input}
const ocPuts = []           // PUT /api/runtime-tokens/:id 记录（四数组断言用）
const ocDeletes = []        // DELETE /api/runtime-tokens/:id
let ocMirrorFailOnce = false   // OPT-P1-05：下一次 PUT runtime-token 返回 500（镜像失败注入）
let ocDriftOnMint = null       // OPT-P1-05：下一次 POST runtime-token 先并发收紧权限组再延迟应答（快照漂移注入）
const ocMintedValues = []   // 每次铸造返回的 oct_ 一次性值（T-24 全文扫描名单）
const ocLedgerTokens = new Map()  // id → {policy,name}
const ocTokenByValue = new Map()
const ocConnections = new Map() // service → Map(connectionName → summary)
const ocIdemCache = new Map()   // Idempotency-Key → 完整响应体（24h 重放窗口的 stub 等价物，T-22）
const ocClientsConfigured = new Set()   // 已存 OAuth client 配置的 service
const ocRuns = []           // 伪造/真实 run 日志（runtimeTokenId 维度对账）
const ocCtl = {
  failNextExec: false,        // OPT-P3-01：下一次 /v1/actions 执行回 500（网关 5xx 故障注入）
  connNotAllowedOnce: null,   // 下一次该 tokenValue 执行回 403 connection_not_allowed 后自动清除
  alwaysDenyToken: null,      // 该 tokenValue 执行恒 403 connection_not_allowed（自动恢复重试仍失败路径）
  auditPersistedNext: false,  // 下一次成功执行 meta.auditPersisted=false
  actions: null,              // 当前目录 action 集（null=默认；测试可删改模拟下架）
  overlapDupInRuns: false,    // 分页重叠窗口：第二页重复首条（T-23 去重）
}

const ocActionsDefault = [
  { id: 'hackernews.get_top_stories', name: 'get_top_stories', service: 'hackernews', description: '获取热帖', requiredScopes: [], providerPermissions: [], inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { id: 'hackernews.fetch_item', name: 'fetch_item', service: 'hackernews', description: '拉取条目', requiredScopes: ['public:read'], inputSchema: { type: 'object' } },
  { id: 'hackernews.submit_post', name: 'submit_post', service: 'hackernews', description: '提交帖子', requiredScopes: ['write:posts'], inputSchema: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } } } },
  { id: 'github.list_issues', name: 'list_issues', service: 'github', description: '列 issue', requiredScopes: ['repo:read'], inputSchema: { type: 'object' } },
  { id: 'github.create_issue', name: 'create_issue', service: 'github', description: '建 issue', requiredScopes: ['repo:write'], inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
  { id: 'github.delete_webhook', name: 'delete_webhook', service: 'github', description: '删除 webhook', requiredScopes: ['webhook:admin'], inputSchema: { type: 'object' } },
  { id: 'hackernews.do_the_thing', name: 'do_the_thing', service: 'hackernews', description: '无 scope 无名可判定的动作', requiredScopes: [], inputSchema: { type: 'object' } },
]
const ocProvidersDefault = [
  { service: 'hackernews', name: 'Hacker News', description: 'no_auth 示例', auth: [{ type: 'no_auth' }] },
  { service: 'github', name: 'GitHub', description: 'OAuth+API Key 示例', auth: [{ type: 'oauth' }, { type: 'api_key' }] },
  // resource 正则拒绝纳管的反例（T-03）
  { service: 'weird service!', name: 'Weird', description: '非法 service 标识', auth: [] },
]

let ocSeq = 10
const ocEnvelope = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}
const ocAdmin = (req) => req.headers.authorization === `Bearer ${OC_TOKEN}`
const ocPolicyFits = (tokenPolicy, actionId) => {
  const allowed = tokenPolicy.allowedActions ?? []
  return allowed.includes('*') || allowed.includes(actionId)
    || allowed.some((p) => typeof p === 'string' && p.endsWith('.*') && actionId.startsWith(p.slice(0, -2)))
}

const ocStub = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', OC_BASE)
  const path = url.pathname
  const bodyText = await readBody(req)
  let body = {}
  try { body = bodyText ? JSON.parse(bodyText) : {} } catch { /* ignore */ }
  // 健康探测与数据面执行（oct_）公开于管理门禁之外；/api/* 一律 admin Bearer
  const bearerValue = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const isKnownOct = ocTokenByValue.has(bearerValue)
  if (req.method === 'GET' && path === '/v1/health') {
    return ocEnvelope(res, 200, { success: true, data: { ok: true, runtime: 'oomol-connect' } })
  }
  const isDataPlaneExec = /^\/v1\/actions\/[^/]+$/.test(path) && req.method === 'POST'
  if (!path.startsWith('/oauth/callback') && !isDataPlaneExec && !ocAdmin(req)) {
    return ocEnvelope(res, 401, { success: false, errorCode: 'unauthorized', message: '管理接口需要 Bearer 口令' })
  }
  void isKnownOct

  // -- 目录 ---------------------------------------------------------------
  if (req.method === 'GET' && path === '/v1/providers') {
    return ocEnvelope(res, 200, { success: true, data: ocProvidersDefault })
  }
  if (req.method === 'GET' && path === '/v1/actions') {
    return ocEnvelope(res, 200, { success: true, data: (ocCtl.actions ?? ocActionsDefault), ...(url.searchParams.get('service') ? {} : {}) })
  }
  const actionDetailMatch = path.match(/^\/v1\/actions\/([^/]+)$/)
  if (req.method === 'GET' && actionDetailMatch) {
    const found = (ocCtl.actions ?? ocActionsDefault).find((item) => item.id === decodeURIComponent(actionDetailMatch[1]))
    if (!found) return ocEnvelope(res, 404, { success: false, errorCode: 'unknown_action' })
    return ocEnvelope(res, 200, { success: true, data: found })
  }
  const guideMatch = path.match(/^\/api\/actions\/([^/]+)\/agent\.md$/)
  if (req.method === 'GET' && guideMatch) {
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
    res.end(`## 连接指南（stub agent.md）\n\n为 ${decodeURIComponent(guideMatch[1])} 配置连接：先注册 OAuth App / 准备 API Key。\n`)
    return
  }

  // -- 连接 ---------------------------------------------------------------
  if (req.method === 'GET' && path === '/api/connections') {
    const all = [...ocConnections.values()].flatMap((m) => [...m.values()])
    return ocEnvelope(res, 200, { success: true, data: all })
  }
  const connectionMatch = path.match(/^\/api\/connections\/([^/]+)$/)
  if (req.method === 'PUT' && connectionMatch) {
    const service = decodeURIComponent(connectionMatch[1])
    if (!ocConnections.has(service)) ocConnections.set(service, new Map())
    const summary = {
      id: `oc-con-${++ocSeq}`,
      service,
      connectionName: String(body.connectionName ?? ''),
      authType: body.authType === 'custom_credential' ? 'custom_credential' : 'api_key',
      configured: true,
      virtual: false,
      default: Boolean(body.default),
      profile: { ...Object.fromEntries(Object.entries(body.values ?? {}).map(([k, v]) => [k, typeof v === 'string' ? `${String(v).slice(0, 4)}***` : v])) },
    }
    ocConnections.get(service).set(summary.connectionName, summary)
    return ocEnvelope(res, 200, { success: true, data: summary }) // 成功状态码上游未载——按默认 200 断言信封
  }
  if (req.method === 'DELETE' && connectionMatch) {
    const service = decodeURIComponent(connectionMatch[1])
    const removed = ocConnections.get(service)?.delete(String(body.connectionName ?? ''))
    return removed
      ? ocEnvelope(res, 200, { success: true, data: { deleted: true } })
      : ocEnvelope(res, 404, { success: false, errorCode: 'unknown_connection', message: `连接不存在：${service}/${body.connectionName}` })
  }

  // -- OAuth ----------------------------------------------------------------
  if (req.method === 'POST' && path === '/api/oauth/authorizations') {
    const service = String(body.service ?? '')
    if (!ocClientsConfigured.has(service)) {
      return ocEnvelope(res, 400, { success: false, errorCode: 'oauth_client_config_required', message: `${service} 未存 client 配置` })
    }
    const state = `st-${++ocSeq}`
    pendingOauth.set(state, { service, connectionName: String(body.connectionName ?? '') })
    return ocEnvelope(res, 200, { success: true, data: { authorizationUrl: `${OC_BASE}/oauth/authorize?state=${state}`, state } })
  }
  if (req.method === 'GET' && path === '/oauth/callback') {
    const state = url.searchParams.get('state') ?? ''
    const entry = pendingOauth.get(state)
    if (!entry) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html>bad state</html>'); return
    }
    pendingOauth.delete(state)
    if (!ocConnections.has(entry.service)) ocConnections.set(entry.service, new Map())
    ocConnections.get(entry.service).set(entry.connectionName, {
      id: `oc-con-${++ocSeq}`, service: entry.service, connectionName: entry.connectionName,
      authType: 'oauth', configured: true, virtual: false, default: false,
      profile: { login: 'dsh-selftest' },
    })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body>授权完成（stub 回调页）</body></html>')
    return
  }

  // -- 运行时令牌 -------------------------------------------------------------
  if (req.method === 'POST' && path === '/api/runtime-tokens') {
    if (ocDriftOnMint) {
      const hook = ocDriftOnMint
      ocDriftOnMint = null
      // 并发收紧权限组（确定性快照漂移注入）+ 延迟应答，保证外层镜像最后落账（ledger 滞后于当前策略）
      await api('PATCH', `/api/connector/perm-groups/${hook.permGroupId}`, { token: hook.token, body: hook.body })
      await new Promise((resolve) => setTimeout(resolve, hook.delayMs ?? 150))
    }
    const requiredArrays = ['allowedActions', 'blockedActions', 'allowedProxies', 'allowedConnections']
    for (const key of requiredArrays) {
      if (!Array.isArray(body[key])) return ocEnvelope(res, 400, { success: false, errorCode: 'invalid_policy_arrays', message: `${key} 必须是数组（四数组全发契约）` })
    }
    const id = `tok-${++ocSeq}`
    const value = `oct_selftest_${++ocSeq}_${Math.random().toString(36).slice(2, 8)}`
    ocLedgerTokens.set(id, { policy: { allowedActions: body.allowedActions, blockedActions: body.blockedActions, allowedProxies: body.allowedProxies, allowedConnections: body.allowedConnections }, name: String(body.name ?? '') })
    ocTokenByValue.set(value, id)
    ocMintedValues.push(value)
    return ocEnvelope(res, 200, { success: true, data: { id, name: body.name, token: value, createdAt: new Date().toISOString(), policy: ocLedgerTokens.get(id).policy } })
  }
  if (req.method === 'GET' && path === '/api/runtime-tokens') {
    return ocEnvelope(res, 200, { success: true, data: [...ocLedgerTokens.entries()].map(([id, rec]) => ({ id, name: rec.name, createdAt: new Date().toISOString(), policy: rec.policy })) })
  }
  const tokenMatch = path.match(/^\/api\/runtime-tokens\/([^/]+)$/)
  if (req.method === 'PUT' && tokenMatch) {
    const id = decodeURIComponent(tokenMatch[1])
    if (ocMirrorFailOnce) {
      ocMirrorFailOnce = false
      return ocEnvelope(res, 500, { success: false, errorCode: 'injected_mirror_failure', message: 'OPT-P1-05 注入：镜像 PUT 失败一次' })
    }
    if (!ocLedgerTokens.has(id)) return ocEnvelope(res, 404, { success: false, errorCode: 'unknown_token' })
    for (const key of ['allowedActions', 'blockedActions', 'allowedProxies', 'allowedConnections']) {
      if (!Array.isArray(body[key])) return ocEnvelope(res, 400, { success: false, errorCode: 'invalid_policy_arrays', message: `${key} 缺失或非数组（PUT 四数组全发契约）` })
    }
    ocLedgerTokens.get(id).policy = { allowedActions: body.allowedActions, blockedActions: body.blockedActions, allowedProxies: body.allowedProxies, allowedConnections: body.allowedConnections }
    ocPuts.push({ id, policy: ocLedgerTokens.get(id).policy })
    return ocEnvelope(res, 200, { success: true, data: { id, policy: ocLedgerTokens.get(id).policy } })
  }
  if (req.method === 'DELETE' && tokenMatch) {
    const id = decodeURIComponent(tokenMatch[1])
    ocDeletes.push(id)
    ocLedgerTokens.delete(id)
    return ocEnvelope(res, 200, { success: true, data: { deleted: true } })
  }

  // -- 数据面执行 --------------------------------------------------------------
  const execMatch = path.match(/^\/v1\/actions\/([^/]+)$/)
  if (req.method === 'POST' && execMatch) {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const tokenId = ocTokenByValue.get(bearer)
    const actionId = decodeURIComponent(execMatch[1])
    ocCalls.push({
      actionId, bearerOk: Boolean(tokenId),
      alias: req.headers['x-oo-connector-alias'] ?? null,
      idempotencyKey: req.headers['idempotency-key'] ?? null,
      input: body.input ?? {},
    })
    if (!tokenId) return ocEnvelope(res, 401, { success: false, errorCode: 'unauthorized', message: '缺少合法 oct_ 运行时令牌' })
    // 数据面独立强制（T-29）与策略镜像一致性（T-11）：令牌 policy 与请求 action 不符即 403，
    // 越权在凭证加载前拒绝——即使调用方完全绕开平台侧权限组也一样。
    const record = ocLedgerTokens.get(tokenId)
    if (!record || !ocPolicyFits(record.policy, actionId)) {
      return ocEnvelope(res, 403, { success: false, errorCode: 'forbidden_action', message: `action ${actionId} 不在该运行时令牌 allowedActions 内` })
    }
    const allowedConnections = record.policy.allowedConnections ?? []
    if (allowedConnections.length > 0) {
      const alias = req.headers['x-oo-connector-alias']
      const boundSummary = [...ocConnections.values()].flatMap((m) => [...m.values()])
        .find((s) => s.id === allowedConnections[0] || s.connectionName === alias)
      if (!boundSummary) return ocEnvelope(res, 403, { success: false, errorCode: 'connection_not_allowed', message: `连接未获令牌授权：${alias ?? '(default)'}` })
    }
    // 哨兵 '*ANY*' 匹配任意合法 oct_（测试注入用），否则按精确值匹配
    const denyOnceMatch = ocCtl.connNotAllowedOnce !== null && (ocCtl.connNotAllowedOnce === '*ANY*' || ocCtl.connNotAllowedOnce === bearer)
    if (denyOnceMatch) {
      ocCtl.connNotAllowedOnce = null
      return ocEnvelope(res, 403, { success: false, errorCode: 'connection_not_allowed' })
    }
    const denyAlwaysMatch = ocCtl.alwaysDenyToken !== null && (ocCtl.alwaysDenyToken === '*ANY*' || ocCtl.alwaysDenyToken === bearer)
    if (denyAlwaysMatch) {
      return ocEnvelope(res, 403, { success: false, errorCode: 'connection_not_allowed' })
    }
    if (ocCtl.failNextExec) {
      ocCtl.failNextExec = false
      return ocEnvelope(res, 500, { success: false, errorCode: 'injected_gateway_error', message: 'OPT-P3-01 注入：网关 5xx' })
    }
    const executionId = `exec-${++ocSeq}`
    ocRuns.push({ id: executionId, service: actionId.split('.')[0], actionId, ok: true, runtimeTokenId: tokenId, caller: 'http', startedAt: new Date().toISOString(), latencyMs: 12 })
    const successPayload = {
      success: true,
      data: { echo: body.input ?? {}, viaAlias: req.headers['x-oo-connector-alias'] ?? null, replayKey: req.headers['idempotency-key'] ?? null },
      meta: { executionId, actionId, auditPersisted: !ocCtl.auditPersistedNext },
    }
    // T-22：同 Idempotency-Key 在重放窗口内返回原响应（含原 executionId），不产生重复 run
    if (req.headers['idempotency-key']) {
      const key = String(req.headers['idempotency-key'])
      const cached = ocIdemCache.get(key)
      if (cached) return ocEnvelope(res, 200, cached)
      ocIdemCache.set(key, successPayload)
      // 注入的伪造 run 会在下一个调用带同键时被消费为空（避免污染去重断言）
    }
    return ocEnvelope(res, 200, successPayload)
  }

  // -- runs 对账视图（cursor 分页 + 重叠窗口 + 伪造注入） ----------------------------------
  if (req.method === 'GET' && path === '/api/runs') {
    let items = [...ocRuns]
    const fakeCount = Number(url.searchParams.get('injectFakeBypass') ?? 0)
    for (let i = 0; i < fakeCount; i++) {
      items.push({ id: `fake-bypass-${Date.now()}-${i}`, service: 'github', actionId: 'github.list_issues', ok: true, runtimeTokenId: [...ocLedgerTokens.keys()][0] ?? 'tok-foreign', caller: 'direct-sidecar', startedAt: new Date(Date.now() + i * 1000).toISOString() })
    }
    items.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    const cursorRaw = url.searchParams.get('cursor')
    let offset = 0
    if (cursorRaw) {
      try { offset = Number(JSON.parse(decodeURIComponent(cursorRaw)).i ?? 0) } catch { offset = 0 }
    }
    const limit = Math.max(1, Number(url.searchParams.get('limit') ?? 100))
    let page = items.slice(offset, offset + limit)
    const nextOffset = offset + limit
    // T-23 重叠窗口：第二页首条重复第一页末条（cursor 分页去重由平台侧负责）
    if (offset > 0 && nextOffset < items.length && ocCtl.overlapDupInRuns && page.length > 0) {
      page = [items[offset - 1], ...page]
    }
    const payload = { items: page }
    if (nextOffset < items.length) {
      payload.nextCursor = encodeURIComponent(JSON.stringify({ startedAt: page[page.length - 1].startedAt, i: nextOffset }))
    }
    return ocEnvelope(res, 200, { success: true, data: payload })
  }

  // -- MCP 桥接端点（POST /mcp，与平台同形态；供 M0 importServices 探测） ----------------------
  if (req.method === 'POST' && path === '/mcp') {
    let msg = {}
    try { msg = JSON.parse(bodyText) } catch { /* ignore */ }
    const jsonrpc = { jsonrpc: '2.0', id: msg.id }
    if (msg.method === 'initialize') {
      return ocEnvelope(res, 200, { ...jsonrpc, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'open-connector-stub', version: '1.4.0' } } })
    }
    // M0 数据面鉴权（对齐集成指南 v0.2 §五）：Bearer 为管理口令（bootstrap 形态）或合法 oct_
    const mcpBearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (!ocAdmin(req) && !ocTokenByValue.has(mcpBearer)) {
      return ocEnvelope(res, 401, { ...jsonrpc, error: { code: -32001, message: '/mcp 数据面需 Bearer 管理口令或合法 oct_ 运行时令牌' } })
    }
    if (msg.method === 'tools/list') {
      const legacyNames = ['hackernews_get_top_stories', 'hackernews_fetch_item', 'hackernews_submit_post', 'github_list_issues', 'github_create_issue']
      const tools = [
        // 上游文档未细载项：真实 /mcp 以 execute_action(actionId,input) 为准（cto-doc-agent 核对结论）
        { name: 'execute_action', description: 'execute an open-connector action', inputSchema: { type: 'object', properties: { actionId: { type: 'string' }, input: { type: 'object' } }, required: ['actionId'] } },
        ...legacyNames.map((name) => ({ name, description: `stub ${name}（legacy 别名形态）`, inputSchema: { type: 'object' } })),
      ]
      return ocEnvelope(res, 200, { ...jsonrpc, result: { tools } })
    }
    if (msg.method === 'tools/call') {
      const toolName = String(msg.params?.name ?? '')
      const argsIn = msg.params?.arguments ?? {}
      if (toolName === 'execute_action') {
        const executionId = `exec-mcp-${++ocSeq}`
        ocCalls.push({ actionId: String(argsIn.actionId ?? ''), bearerOk: true, alias: null, idempotencyKey: null, input: argsIn.input ?? {} })
        ocRuns.push({ id: executionId, service: String(argsIn.actionId ?? '').split('.')[0], ok: true, startedAt: new Date().toISOString(), latencyMs: 9 })
        return ocEnvelope(res, 200, { ...jsonrpc, result: { content: [{ type: 'text', text: JSON.stringify({ bridgeEcho: argsIn, runId: executionId }) }] } })
      }
      ocCalls.push({ actionId: toolName.replace(/_([a-z])/g, '.$1'), bearerOk: true, alias: null, idempotencyKey: null, input: argsIn })
      const executionId = `exec-mcp-${++ocSeq}`
      ocRuns.push({ id: executionId, service: 'hackernews', ok: true, startedAt: new Date().toISOString(), latencyMs: 9 })
      return ocEnvelope(res, 200, { ...jsonrpc, result: { content: [{ type: 'text', text: JSON.stringify({ bridgeEcho: argsIn, runId: executionId }) }] } })
    }
    return ocEnvelope(res, 200, { ...jsonrpc, error: { code: -32601, message: `方法不存在：${msg.method}` } })
  }

  return ocEnvelope(res, 404, { success: false, errorCode: 'not_found', message: path })
})
const pendingOauth = new Map()
await new Promise((resolve) => ocStub.listen(OC_STUB_PORT, '127.0.0.1', resolve))

// ---------------- 启动隔离实例
console.log('\x1b[90m» 启动隔离测试实例…\x1b[0m')
await rm(DATA_DIR, { recursive: true, force: true })
await mkdir(DATA_DIR, { recursive: true })
const proc = spawn(process.execPath, ['src/main.ts', '--port', String(PORT), '--data', DATA_DIR], {
  stdio: ['ignore', 'pipe', 'pipe'],
  // DEMO_SEED：自测基于完整演示种子（隔离实例，不触碰生产 data/）
  // DSH_UPDATE_*：更新检查指向本进程 stub 上游；关闭启动自动首查保证断言确定性
  env: {
    ...process.env,
    DEMO_SEED: '1',
    // 连接器纳管：强制 env 由自测进程下发（fail-closed 门禁的绿路前提）；
    // 桥接 stub 地址 + 演示种子开关（网关/连接/权限组模板）
    OOMOL_CONNECT_ENCRYPTION_KEY: 'selftest-encryption-key-not-a-secret',
    OOMOL_CONNECT_ADMIN_TOKEN: OC_TOKEN,
    OOMOL_CONNECT_STUB_URL: OC_BASE,
    OOMOL_CONNECT_DEMO_SEED: '1',
    DSH_UPDATE_RAW_BASE: `http://127.0.0.1:${GH_PORT}`,
    DSH_UPDATE_API_BASE: `http://127.0.0.1:${GH_PORT}`,
    DSH_UPDATE_AUTO_CHECK: 'off',
    // OIDC 授权请求 TTL 压到 2 秒：过期路径可在自测内确定性验证（正常流程毫秒级完成不受影响）
    OIDC_AUTHREQ_TTL_SECONDS: '2',
    // 执行中枢（2026-10-14）：后台心跳循环压到 10 分钟不干扰断言（测试用 POST /api/exec/tick 手动驱动，
    // 确定性）；执行锁僵尸阈值压到 2.5s（回收断言可秒级验证）
    EXEC_HUB_TICK_MS: '600000',
    EXEC_HUB_FIRST_TICK_MS: '600000',
    EXEC_LOCK_TIMEOUT_MS: '2500',
    A2A_SYNC_WAIT_MS: '800',
    // 门户 downloadUrl 生成基址指向自测实例：门户技能包下载断言可直连验证
    PORTAL_PUBLIC_BASE: `http://127.0.0.1:${PORT}`,
    // P1-06（安全审查 2026-10-31）：请求派生 issuer 需显式可信主机白名单（fail-closed）——
    // 自测把 ybkkasi.example 登记为可信主机，覆盖 #15 派生语义的正反两路断言
    OIDC_TRUSTED_HOSTS: 'ybkkasi.example',
  },
})
const serverLogChunks = []
proc.stdout.on('data', (chunk) => serverLogChunks.push(chunk))
proc.stderr.on('data', (chunk) => { serverLogChunks.push(chunk); process.stderr.write(`\x1b[90m[server] ${chunk}\x1b[0m`) })

let booted = false
for (let i = 0; i < 40; i++) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  try {
    const probe = await fetch(`${BASE}/api/health`)
    if (probe.ok) { booted = true; break }
  } catch { /* retry */ }
}
if (!booted) {
  console.error('\x1b[31m实例启动失败\x1b[0m')
  proc.kill('SIGKILL')
  process.exit(1)
}
// 轮询等待种子数据就绪（工具注册 + Agent 上线 + 调用记录）
let seeded = false
for (let i = 0; i < 60; i++) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  try {
    const probe = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
    if (!probe.ok) continue
    const info = await api('GET', '/api/platform/info', { token: probe.data.token })
    const overview = await api('GET', '/api/overview', { token: probe.data.token })
    if (info.data?.tools?.length >= 37 && overview.data?.agents?.online >= 5 && overview.data?.mcp?.totalCalls > 100) {
      seeded = true
      break
    }
  } catch { /* retry */ }
}
if (!seeded) console.log('[33m! 种子数据就绪超时，部分断言可能失败[0m')

try {
  // ================================================================ 基础与认证
  section('平台健康与登录')
  const health = await api('GET', '/api/health')
  check('健康检查', health.ok)
  // #13（2026-10-29）：健康端点暴露面板契约——版本 + 能力清单（实时推导）+ 已配置部门，
  // 前台（DeptAI-UI-DSH）按此对齐宿主支持面，版本组合偏差 fail-visible 而非静默 404
  check('健康端点暴露面板契约（contract.panel.version/capabilities/depts）',
    health.ok && Number.isFinite(health.data.contract?.panel?.version)
    && Array.isArray(health.data.contract?.panel?.capabilities) && health.data.contract.panel.capabilities.length > 0
    && Array.isArray(health.data.contract?.panel?.depts),
    JSON.stringify(health.data?.contract))
  // #13 复核（2026-10-29）：capabilities 只是路由族名（board ≠ 平铺 GET /api/panel/board），
  // 契约因此附 routes[]（method+path 实时推导）——:dept 参数化路由与 panel 自持登录路由显式可协商，
  // 前台按路由模式拼 URL，不再「声明了能力但按字面调就 404」
  const panelContractRoutes = health.data.contract?.panel?.routes ?? []
  const routeFamilies = new Set(panelContractRoutes.flatMap((route) => {
    const segments = String(route.path).split('/').filter(Boolean)
    const panelIdx = segments.indexOf('panel')
    const families = []
    if (segments[panelIdx + 1] !== undefined && !segments[panelIdx + 1].startsWith(':')) families.push(segments[panelIdx + 1])
    if (segments[panelIdx + 2] !== undefined && !segments[panelIdx + 2].startsWith(':')) families.push(segments[panelIdx + 2])
    return families
  }))
  check('#13 复核：契约暴露 routes[]（method+path），:dept 参数化与 panel-auth 路由显式在列',
    Array.isArray(panelContractRoutes) && panelContractRoutes.length > 0
    && panelContractRoutes.some((route) => route.method === 'GET' && route.path === '/api/panel/:dept/board')
    && panelContractRoutes.some((route) => route.method === 'POST' && route.path === '/api/panel/auth/login')
    && panelContractRoutes.some((route) => route.method === 'POST' && route.path === '/api/panel/auth/refresh'),
    JSON.stringify(panelContractRoutes.slice(0, 4)))
  check('#13 复核：capabilities 每个族都有对应路由（无「声明即 404」族，spa 为静态挂载特例）',
    (health.data.contract.panel.capabilities ?? []).every((family) => family === 'spa' || routeFamilies.has(family)),
    JSON.stringify(health.data.contract.panel.capabilities))
  // 交互连通性（2026-10-29 面板架构统一）：统一后的 IAW 架构能力族（board/mfg/ddws/auth/agent-stream 通道族）
  // 必须全部出现在契约能力清单中，且五部门配置在列——前台据此判定宿主支持面
  check('交互连通性：契约能力族覆盖统一架构面（board/mfg/ddws/auth 在列）+ 五部门配置下发',
    ['board', 'mfg', 'ddws', 'auth'].every((family) => health.data.contract.panel.capabilities.includes(family))
    && health.data.contract.panel.depts.length === 5
    && ['rd', 'mfg', 'sales', 'strategy', 'fin'].every((id) => health.data.contract.panel.depts.includes(id)),
    JSON.stringify({ capabilities: health.data.contract.panel.capabilities, depts: health.data.contract.panel.depts }))

  const noAuth = await api('GET', '/api/overview')
  check('无令牌访问被拒绝（401）', noAuth.status === 401)

  const badLogin = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } })
  check('错误密码被拒绝', badLogin.status === 401)

  // 面板自持登录面（交接 F 清单 N 节欠账补齐，前台 #2 复核残留）：/api/panel/auth/* 此前
  // 仅登记公开白名单、处理器从未合入 main（面板本页登录实际 404）——现与 /api/auth/* 同后端
  const panelBadLogin = await api('POST', '/api/panel/auth/login', { body: { username: 'admin', password: 'wrong' } })
  check('面板自持登录路由存在（404 欠账闭环）：错误口令 401 而非 404', panelBadLogin.status === 401, JSON.stringify(panelBadLogin.error ?? panelBadLogin.status))
  const panelLogin = await api('POST', '/api/panel/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
  check('面板自持登录成功（同后端同响应形状：token + user.permissions）',
    panelLogin.ok && panelLogin.data.token.startsWith('dst1.') && Array.isArray(panelLogin.data.user?.permissions))
  const panelRefresh = await api('POST', '/api/panel/auth/refresh', { body: { refreshToken: panelLogin.data.refreshToken } })
  check('面板自持刷新成功（refreshToken 换新令牌对）',
    panelRefresh.ok && panelRefresh.data.token.startsWith('dst1.') && Boolean(panelRefresh.data.refreshToken))

  const adminLogin = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
  check('管理员登录成功', adminLogin.ok && adminLogin.data.token.startsWith('dst1.'))
  const admin = adminLogin.data.token
  check('登录返回权限点（含 *）', adminLogin.data.user.permissions.includes('*'))

  // 三方登录完整链路（IdentityProviderAdapter：authorize → state → code → normalize）
  const authorize = await api('POST', '/api/auth/sso/authorize', { body: { provider: 'dingtalk', scene: 'web_qr' } })
  check('SSO 发起授权（签发 state）', authorize.ok && authorize.data.state.length >= 32)
  check('SSO 授权地址不带 prompt=consent（已授权用户可静默通过，缩短回跳链路）',
    typeof authorize.data.authorizeUrl === 'string' && authorize.data.authorizeUrl.includes('login.dingtalk.com/oauth2/auth')
    && !authorize.data.authorizeUrl.includes('prompt=consent') && authorize.data.authorizeUrl.includes('scope=openid'))
  const sso = await api('POST', '/api/auth/sso', { body: { provider: 'dingtalk', code: 'DD0002', state: authorize.data.state } })
  check('钉钉免密登录（身份链接命中）', sso.ok && sso.data.kind === 'hit' && sso.data.user.username === 'linxm')
  check('登录返回 refresh token（7d 轮转链）', typeof sso.data.refreshToken === 'string' && sso.data.refreshToken.startsWith('dstr_'))

  // 攻击演练 1：state 重放拒绝
  const stateReplay = await api('POST', '/api/auth/sso', { body: { provider: 'dingtalk', code: 'DD0002', state: authorize.data.state } })
  check('state 重放被拒绝（防 CSRF）', stateReplay.status === 401)

  // 攻击演练 2：伪造 state 拒绝
  const stateForged = await api('POST', '/api/auth/sso', { body: { provider: 'dingtalk', code: 'DD0002', state: 'forged-state-000' } })
  check('伪造 state 被拒绝', stateForged.status === 401)

  // 攻击演练 3：code 重放拒绝（5 分钟窗口内单次消费）
  const authorize2 = await api('POST', '/api/auth/sso/authorize', { body: { provider: 'dingtalk', scene: 'web_qr' } })
  await api('POST', '/api/auth/sso', { body: { provider: 'dingtalk', code: 'DD0004', state: authorize2.data.state } }).catch(() => null)
  const codeReplayAuth = await api('POST', '/api/auth/sso/authorize', { body: { provider: 'dingtalk', scene: 'web_qr' } })
  const codeReplay = await api('POST', '/api/auth/sso', { body: { provider: 'dingtalk', code: 'DD0004', state: codeReplayAuth.data.state } })
  check('code 重放被拒绝（单次消费）', codeReplay.status === 401)

  // 未命中 → 待绑定票据 → 绑定已有账号
  const authorize3 = await api('POST', '/api/auth/sso/authorize', { body: { provider: 'dingtalk', scene: 'h5' } })
  const pending = await api('POST', '/api/auth/sso', { body: { provider: 'dingtalk', code: 'DD0003', state: authorize3.data.state } })
  check('未命中身份签发待绑定票据', pending.ok && pending.data.kind === 'pending' && pending.data.profileName === '周既白')
  const bindWrong = await api('POST', '/api/auth/sso/bind', { body: { pendingTicket: pending.data.pendingTicket, username: 'dev', password: 'wrong' } })
  check('绑定校验密码（错误拒绝）', bindWrong.status === 401)
  const bindOk = await api('POST', '/api/auth/sso/bind', { body: { pendingTicket: pending.data.pendingTicket, username: 'dev', password: 'Ybk@2026' } })
  check('绑定已有账号并登录', bindOk.ok && bindOk.data.user.username === 'dev')

  // 唯一约束：已绑定的三方身份（dd_u003→dev）再绑定他人 → 拒绝。
  // 2026-10-22 解绑能力上线后服务层新增了「先判后写」的可读前置错误（引擎唯一约束仍兜底），
  // 两种文案都算命中一人一号：断言只认语义，不认实现路径。
  const opsUser = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('韩若飞'), { token: admin })).data.users[0]
  const dupBind = await api('POST', `/api/iam/users/${opsUser.id}/bindings`, {
    token: admin,
    body: { provider: 'dingtalk', unionId: 'dd_u003', displayName: '周既白', verifyCode: '123456' },
  })
  check('一人一号：身份绑定第二个账号被拒（唯一约束/一人一号）',
    !dupBind.ok && /唯一约束|一人一号/.test(JSON.stringify(dupBind.error)), dupBind.error?.message)

  // 未命中 → 注册新账号分支
  const authorize5 = await api('POST', '/api/auth/sso/authorize', { body: { provider: 'dingtalk', scene: 'web_qr' } })
  const pending3 = await api('POST', '/api/auth/sso', { body: { provider: 'dingtalk', code: 'DD0006', state: authorize5.data.state } })
  const register = await api('POST', '/api/auth/sso/register', { body: { pendingTicket: pending3.data.pendingTicket } })
  check('三方身份注册新账号并登录', register.ok && register.data.user.username === 'dingtalk_dd_u006')

  // ---- 解绑 / 更换（2026-10-22）------------------------------------------------
  // 覆盖四个必须成立的行为：① 解绑真的落到事实源且不留投影；② 连接器同步不会把人工解绑的
  // 绑定自动补回（否则用户看到「点了没反应」）；③ 反锁定护栏拦住「解完就登不进来」；
  // ④ 本人自助解绑不需要 iam.user.write。
  // 全部在专用测试账号上进行（不动 linxm 等既有账号的绑定——后续用例依赖它们）。
  {
    const unbindOrg = (await api('GET', '/api/iam/orgs', { token: admin })).data[0]
    // 专用账号：管理员建号并显式设口令（passwordKnown=true），再手工绑一个钉钉身份
    const probe = await api('POST', '/api/iam/users', {
      token: admin,
      body: { username: 'unbind_probe', displayName: '解绑探针', orgId: unbindOrg.id, password: 'Ybk@2026', email: 'unbind_probe@yuanbingke.com' },
    })
    const probeId = probe.data.id
    // 先绑两个主体（多主体并存），再逐个解绑验证粒度
    await api('POST', `/api/iam/users/${probeId}/bindings`, {
      token: admin, body: { provider: 'dingtalk', unionId: 'probe_u001', displayName: '探针身份', corpId: 'probe-corp', verifyCode: '123456' },
    })
    await api('POST', `/api/iam/users/${probeId}/bindings`, {
      token: admin, body: { provider: 'dingtalk', unionId: 'probe_u002', displayName: '探针身份2', corpId: 'probe-corp2', verifyCode: '123456' },
    })
    const twoSubjects = (await api('GET', '/api/iam/users?q=unbind_probe', { token: admin })).data.users[0]
    const beforeUnbind = twoSubjects
    const unbound = await api('DELETE', `/api/iam/users/${probeId}/bindings/dingtalk?corpId=probe-corp`, { token: admin, body: { verifyCode: '123456' } })
    const afterUnbind = (await api('GET', '/api/iam/users?q=unbind_probe', { token: admin })).data.users[0]
    check('解绑三方身份：只移除目标主体 + 写入同步豁免（另一主体保留）',
      (beforeUnbind.bindings?.length ?? 0) === 2 && unbound.ok && (afterUnbind.bindings ?? []).length === 1
      && afterUnbind.bindings[0].corpId === 'probe-corp2'
      && (afterUnbind.bindingExemptions ?? []).includes('dingtalk|probe-corp'),
      `before=${beforeUnbind.bindings?.length} after=${JSON.stringify(afterUnbind.bindings)} exempt=${JSON.stringify(afterUnbind.bindingExemptions)}`)
    // 解绑另一个主体后全部清空
    await api('DELETE', `/api/iam/users/${probeId}/bindings/dingtalk?corpId=probe-corp2`, { token: admin, body: { verifyCode: '123456' } })
    const afterScoped = (await api('GET', '/api/iam/users?q=unbind_probe', { token: admin })).data.users[0]
    check('多主体解绑按 corpId 精确生效（逐个解除后清空）',
      (afterScoped.bindings ?? []).length === 0, JSON.stringify(afterScoped.bindings))
    // 重新绑定应清除豁免（人工意图覆盖解绑决定）
    const rebind = await api('POST', `/api/iam/users/${probeId}/bindings`, {
      token: admin, body: { provider: 'dingtalk', unionId: 'probe_u001', displayName: '探针身份', corpId: 'probe-corp', verifyCode: '123456' },
    })
    const afterRebind = (await api('GET', '/api/iam/users?q=unbind_probe', { token: admin })).data.users[0]
    check('重新绑定清除该主体的同步豁免（恢复自动绑定语义）',
      rebind.ok && !(afterRebind.bindingExemptions ?? []).includes('dingtalk|probe-corp')
      && (afterRebind.bindings ?? []).some((b) => b.corpId === 'probe-corp'),
      JSON.stringify({ exempt: afterRebind.bindingExemptions, bindings: afterRebind.bindings }))

    // 反锁定 + 同步不补回：通讯录同步创建的账号（口令为随机值且未下发）不能被解掉唯一登录方式；
    // 解绑后同步也不得把它重新绑回来（豁免生效）。
    const syncCfg = (await api('GET', '/api/iam/connectors', { token: admin })).data.configs.find((c) => c.provider === 'dingtalk')
    await api('POST', `/api/iam/connectors/${syncCfg.id}/sync`, { token: admin })
    const syncedUser = (await api('GET', '/api/iam/users?q=dd0007', { token: admin })).data.users[0]
    const blockedUnbind = await api('DELETE', `/api/iam/users/${syncedUser.id}/bindings/dingtalk`, {
      token: admin, body: { verifyCode: '123456' },
    })
    const stillBound = (await api('GET', '/api/iam/users?q=dd0007', { token: admin })).data.users[0]
    check('反锁定：唯一登录方式被拒解绑且绑定完好（先判后删，无中间态）',
      !blockedUnbind.ok && /唯一的登录方式/.test(JSON.stringify(blockedUnbind.error))
      && (stillBound.bindings ?? []).length === 1,
      `${blockedUnbind.error?.message} / bindings=${JSON.stringify(stillBound.bindings)}`)
    await api('POST', `/api/iam/users/${syncedUser.id}/reset-password`, { token: admin, body: {} })
    const unboundAfterPw = await api('DELETE', `/api/iam/users/${syncedUser.id}/bindings/dingtalk`, { token: admin, body: { verifyCode: '123456' } })
    check('设口令后同一账号可正常解绑（护栏只拦真正的锁死）', unboundAfterPw.ok, JSON.stringify(unboundAfterPw.error))
    const syncRes = await api('POST', `/api/iam/connectors/${syncCfg.id}/sync`, { token: admin })
    const afterResync = (await api('GET', '/api/iam/users?q=dd0007', { token: admin })).data.users[0]
    check('解绑后连接器同步不会自动补回绑定（bindingExemptions 生效）',
      syncRes.ok && (afterResync.bindings ?? []).length === 0, JSON.stringify(afterResync.bindings))

    // 本人自助解绑：普通成员（无 iam.user.write）也能解除自己的绑定。
    // 用专用探针账号（普通成员角色）做，不动 linxm 的既有绑定——后续用例依赖它。
    const memberRole = (await api('GET', '/api/iam/roles', { token: admin })).data.roles.find((r) => r.code === 'member')
    const memberProbe = await api('POST', '/api/iam/users', {
      token: admin,
      body: {
        username: 'unbind_member', displayName: '自助解绑探针', orgId: unbindOrg.id,
        password: 'Ybk@2026', email: 'unbind_member@yuanbingke.com', roleIds: [memberRole.id],
      },
    })
    const memberId = memberProbe.data?.id
    if (!memberId) {
      check('本人自助解绑不需要 iam.user.write（面板侧解绑入口的权限前提）', false, `建号失败：${JSON.stringify(memberProbe.error)}`)
    } else {
      await api('POST', `/api/iam/users/${memberId}/bindings`, {
        token: admin, body: { provider: 'dingtalk', unionId: 'probe_u003', displayName: '成员探针身份', corpId: 'probe-corp', verifyCode: '123456' },
      })
      const memberLogin = await api('POST', '/api/auth/login', { body: { username: 'unbind_member', password: 'Ybk@2026' } })
      const memberToken = memberLogin.data.token
      const hasWrite = (memberLogin.data.user.permissions ?? []).includes('iam.user.write')
      const selfUnbind = await api('POST', '/api/auth/sso/unbind', {
        token: memberToken, body: { provider: 'dingtalk', corpId: 'probe-corp', verifyCode: '123456' },
      })
      check('本人自助解绑不需要 iam.user.write（面板侧解绑入口的权限前提）',
        !hasWrite && selfUnbind.ok && (selfUnbind.data?.bindings ?? []).length === 0,
        `hasWrite=${hasWrite} ${JSON.stringify(selfUnbind.error ?? selfUnbind.data?.bindings)}`)
    }
  }

  const devLogin = await api('POST', '/api/auth/login', { body: { username: 'dev', password: 'Ybk@2026' } })
  check('开发者登录', devLogin.ok)
  let dev = devLogin.data.token

  // ================================================================ RBAC
  section('RBAC 权限模型')
  const devForbidden = await api('POST', '/api/iam/orgs', { token: dev, body: { name: '越权组织' } })
  check('开发者创建组织被拒（403）', devForbidden.status === 403)

  const auditorLogin = await api('POST', '/api/auth/login', { body: { username: 'audit', password: 'Ybk@2026' } })
  const auditor = auditorLogin.data.token
  const auditorWrite = await api('POST', '/api/iam/users', { token: auditor, body: { username: 'x', displayName: 'x', orgId: 'y' } })
  check('审计员写操作被拒', auditorWrite.status === 403)
  const auditorRead = await api('GET', '/api/audit/logs', { token: auditor })
  check('审计员读日志放行', auditorRead.ok)

  // ================================================================ 工作台
  section('工作台聚合')
  const overview = await api('GET', '/api/overview', { token: admin })
  check('总览数据完整', overview.ok
    && overview.data.iam.users >= 10
    && overview.data.mcp.totalCalls > 0
    && overview.data.agents.online >= 5
    && overview.data.apps.online >= 3
    && overview.data.skills.published >= 6)

  // ================================================================ IAM
  section('组织账号（IAM）')
  const newOrg = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '自测事业部' } })
  check('创建组织', newOrg.ok && newOrg.data.id.startsWith('org_'))

  const dupUser = await api('POST', '/api/iam/users', { token: admin, body: { username: 'admin', displayName: '重复', orgId: newOrg.data.id } })
  check('重复用户名被拒', !dupUser.ok)

  const newUser = await api('POST', '/api/iam/users', { token: admin, body: { username: 'selftester', displayName: '测试账号', orgId: newOrg.data.id, title: '测试工程师' } })
  check('创建账号（默认激活）', newUser.ok && newUser.data.status === 'active')
  check('创建账号返回一次性随机初始口令', newUser.ok && typeof newUser.data.initialPassword === 'string' && newUser.data.initialPassword.length >= 16)
  const testerInitialPassword = newUser.data.initialPassword

  // 口令二次修改（传达过程中改为指定口令）
  const pwUser = await api('POST', '/api/iam/users', { token: admin, body: { username: 'pwtest01', displayName: '口令修改测试', orgId: newOrg.data.id } })
  const pwShort = await api('POST', `/api/iam/users/${pwUser.data.id}/reset-password`, { token: admin, body: { password: 'short' } })
  check('指定口令过短被拒（护栏）', !pwShort.ok)
  const pwSet = await api('POST', `/api/iam/users/${pwUser.data.id}/reset-password`, { token: admin, body: { password: 'SelfTest@2026' } })
  check('二次修改为指定口令', pwSet.ok && pwSet.data.initialPassword === 'SelfTest@2026')
  const pwOldLogin = await api('POST', '/api/auth/login', { body: { username: 'pwtest01', password: pwUser.data.initialPassword } })
  check('修改后原口令立即失效', pwOldLogin.status === 401)
  const pwNewLogin = await api('POST', '/api/auth/login', { body: { username: 'pwtest01', password: 'SelfTest@2026' } })
  check('指定口令可登录', pwNewLogin.ok)

  const roleList = await api('GET', '/api/iam/roles', { token: admin })
  const devRole = roleList.data.roles.find((role) => role.code === 'developer')
  const assign = await api('PATCH', `/api/iam/users/${newUser.data.id}`, { token: admin, body: { roleIds: [devRole.id] } })
  check('分配角色', assign.ok && assign.data.roleIds.length === 1)
  check('开发者角色默认含 agent.write（与 app.write 对称，注册/提报更新闭环）', devRole.permissions.includes('agent.write'))

  // 权限点卫生（组1 E-06）：三个全仓无消费死点从目录摘除；org_admin 迁移批次同步摘除 scenegraph.activate
  const permCatalog = await api('GET', '/api/iam/permissions', { token: admin })
  const catalogPoints = new Set((permCatalog.data?.catalog ?? []).map((item) => item.point))
  check('权限目录：三个无消费死点已摘除（market.submit / connector.market.publish / scenegraph.activate）',
    permCatalog.ok && catalogPoints.size >= 60
    && !catalogPoints.has('market.submit') && !catalogPoints.has('connector.market.publish') && !catalogPoints.has('scenegraph.activate'),
    JSON.stringify([...catalogPoints].filter((p) => ['market.submit', 'connector.market.publish', 'scenegraph.activate'].includes(p))))
  const orgAdminRoleE6 = roleList.data.roles.find((role) => role.code === 'org_admin')
  const memberRoleE6 = roleList.data.roles.find((role) => role.code === 'member')
  check('权限目录：org_admin 迁移批次不再含 scenegraph.activate（member/auditor 同查）',
    Boolean(orgAdminRoleE6) && !orgAdminRoleE6.permissions.includes('scenegraph.activate')
    && Boolean(memberRoleE6) && !memberRoleE6.permissions.includes('scenegraph.activate'),
    JSON.stringify({ org_admin: orgAdminRoleE6?.permissions, member: memberRoleE6?.permissions }))

  // 第二审批人账号（与发起人不同账号）：供异人审批/复核类断言使用（同人审批放开后非必需，保留覆盖双人路径）
  const superRole = roleList.data.roles.find((role) => role.code === 'super_admin')
  const approverCreate = await api('POST', '/api/iam/users', { token: admin, body: { username: 'approver02', displayName: '第二审批人', orgId: newOrg.data.id, password: 'Ybk@2026', roleIds: [superRole.id] } })
  check('第二审批人账号就绪', approverCreate.ok && approverCreate.data.roleIds.length === 1)
  const approverLogin = await api('POST', '/api/auth/login', { body: { username: 'approver02', password: 'Ybk@2026' } })
  check('第二审批人可登录', approverLogin.ok && typeof approverLogin.data.token === 'string')
  const approver = approverLogin.data.token

  const importResult = await api('POST', '/api/iam/users/import', { token: admin, body: { items: [
    { username: 'batch01', displayName: '批量一号', orgId: newOrg.data.id },
    { username: 'batch02', displayName: '批量二号', orgId: newOrg.data.id },
  ] } })
  check('批量导入', importResult.ok && importResult.data.created.length === 2)

  const tree = await api('GET', '/api/iam/orgs/tree', { token: admin })
  check('组织树包含新组织', tree.ok && JSON.stringify(tree.data).includes('自测事业部'))

  // 组织改名 / 层级调整（PATCH /api/iam/orgs/:id）
  const siblingOrg = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '自测兄弟部门' } })
  check('创建同级组织（改名冲突靶子）', siblingOrg.ok)
  const renameOrg = await api('PATCH', `/api/iam/orgs/${newOrg.data.id}`, { token: admin, body: { name: '自测事业部（更名）' } })
  check('组织重命名', renameOrg.ok && renameOrg.data.name === '自测事业部（更名）')
  const renameEmpty = await api('PATCH', `/api/iam/orgs/${newOrg.data.id}`, { token: admin, body: { name: '   ' } })
  check('空白名称重命名被拒', !renameEmpty.ok)
  const renameDup = await api('PATCH', `/api/iam/orgs/${newOrg.data.id}`, { token: admin, body: { name: '自测兄弟部门' } })
  check('同级重名重命名被拒', !renameDup.ok)
  const moveOrg = await api('PATCH', `/api/iam/orgs/${newOrg.data.id}`, { token: admin, body: { parentId: siblingOrg.data.id } })
  check('调整上级组织', moveOrg.ok && moveOrg.data.parentId === siblingOrg.data.id)
  const moveSelf = await api('PATCH', `/api/iam/orgs/${newOrg.data.id}`, { token: admin, body: { parentId: newOrg.data.id } })
  check('移动到自身被拒（环检测）', !moveSelf.ok)
  const moveChild = await api('PATCH', `/api/iam/orgs/${siblingOrg.data.id}`, { token: admin, body: { parentId: newOrg.data.id } })
  check('移动到子孙被拒（环检测）', !moveChild.ok)

  // 组织级联一键删除（2026-08）：任意层级可整棵子树删除，直属账号自动上移到上级组织
  const cascadeOrgA = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '自测级联母部门', parentId: siblingOrg.data.id } })
  const cascadeOrgB = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '自测级联子部门', parentId: cascadeOrgA.data.id } })
  const cascadeUser = await api('POST', '/api/iam/users', { token: admin, body: { username: 'cascadeu01', displayName: '级联上移测试', orgId: cascadeOrgB.data.id } })
  check('级联删除靶子就绪（母/子组织 + 直属账号）', cascadeOrgA.ok && cascadeOrgB.ok && cascadeUser.ok)
  const delNonCascade = await api('DELETE', `/api/iam/orgs/${cascadeOrgA.data.id}`, { token: admin })
  check('存在子组织时普通删除被拒并指路', !delNonCascade.ok && JSON.stringify(delNonCascade.error).includes('一键删除'))
  const delCascade = await api('DELETE', `/api/iam/orgs/${cascadeOrgA.data.id}`, { token: admin, body: { cascade: true } })
  check('级联一键删除整棵子树（组织数/上移账号数）', delCascade.ok && delCascade.data.removedOrgs === 2 && delCascade.data.movedUsers === 1, JSON.stringify(delCascade.data))
  const treeAfterCascade = await api('GET', '/api/iam/orgs/tree', { token: admin })
  const treeTextAfterCascade = JSON.stringify(treeAfterCascade.data)
  check('级联后子树全部消失、上级组织仍在', treeAfterCascade.ok && !treeTextAfterCascade.includes('自测级联子部门') && !treeTextAfterCascade.includes('自测级联母部门') && treeTextAfterCascade.includes('自测兄弟部门'))
  const usersAfterCascade = await api('GET', `/api/iam/users?orgId=${siblingOrg.data.id}`, { token: admin })
  check('直属账号自动上移到上级组织', usersAfterCascade.ok && usersAfterCascade.data.users.some((u) => u.username === 'cascadeu01' && u.orgId === siblingOrg.data.id))
  const scratchOrg = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '自测空部门' } })
  const delEmptyOrg = await api('DELETE', `/api/iam/orgs/${scratchOrg.data.id}`, { token: admin })
  check('空组织普通删除仍可用（非级联路径回归）', delEmptyOrg.ok && delEmptyOrg.data.removedOrgs === 1)

  const groupCreate = await api('POST', '/api/iam/groups', { token: admin, body: { name: '自测静态组', type: 'static', memberIds: [newUser.data.id] } })
  check('创建静态用户组', groupCreate.ok)

  // 三方同步 + 冲突
  const sync = await api('POST', '/api/iam/connectors/dingtalk/sync', { token: admin })
  check('钉钉全量同步执行', sync.ok && sync.data.created >= 0)
  const conflicts = await api('GET', '/api/iam/conflicts', { token: admin })
  if (conflicts.data.conflicts.length > 0) {
    const resolved = await api('POST', `/api/iam/conflicts/${conflicts.data.conflicts[0].id}/resolve`, { token: admin, body: { keep: 'third_party' } })
    check('同步冲突处理（以三方为准）', resolved.ok && resolved.data.status === 'resolved')
  } else {
    check('同步冲突队列（无冲突时跳过）', true)
  }

  // 冻结联动：令牌吊销
  section('账号冻结 → 令牌联动吊销')
  const testerLogin = await api('POST', '/api/auth/login', { body: { username: 'selftester', password: testerInitialPassword } })
  check('新账号可登录（随机初始口令）', testerLogin.ok)
  const testerToken = testerLogin.data.token
  const testerMe = await api('GET', '/api/auth/me', { token: testerToken })
  check('新账号令牌可用', testerMe.ok)
  const freezeNoReason = await api('POST', `/api/iam/users/${newUser.data.id}/freeze`, { token: admin, body: {} })
  check('冻结缺少原因被拒（护栏）', !freezeNoReason.ok)
  const freeze = await api('POST', `/api/iam/users/${newUser.data.id}/freeze`, { token: admin, body: { reason: '自测：验证联动吊销' } })
  check('冻结成功', freeze.ok && freeze.data.status === 'frozen')
  const revokedCheck = await api('GET', '/api/auth/me', { token: testerToken })
  check('冻结后令牌立即失效（401）', revokedCheck.status === 401)
  const frozenLogin = await api('POST', '/api/auth/login', { body: { username: 'selftester', password: testerInitialPassword } })
  check('冻结账号无法登录', frozenLogin.status === 401)

  // ================================================================ refresh 轮转链
  section('refresh token 轮转、宽限自愈与重放防护（H3/T-08：多标签页互踩自愈）')
  const rl = await api('POST', '/api/auth/login', { body: { username: 'ops', password: 'Ybk@2026' } })
  check('登录返回令牌对', rl.ok && rl.data.refreshToken)
  const rotated = await api('POST', '/api/auth/refresh', { body: { refreshToken: rl.data.refreshToken } })
  check('refresh 轮转签发新对', rotated.ok && rotated.data.refreshToken !== rl.data.refreshToken)
  const newMe = await api('GET', '/api/auth/me', { token: rotated.data.token })
  check('轮转后新 access 可用', newMe.ok)
  // 宽限窗口：轮转后 30s 内旧 token 再兑换不判重放，签发同链兄弟对（标签 B 401 自愈）
  const graceSibling = await api('POST', '/api/auth/refresh', { body: { refreshToken: rl.data.refreshToken } })
  check('refresh 宽限：轮转后 30s 内旧 token 再兑换成功（多标签自愈，H3/T-08）',
    graceSibling.ok && graceSibling.data.refreshToken !== rotated.data.refreshToken, JSON.stringify(graceSibling.error))
  const graceMe = await api('GET', '/api/auth/me', { token: graceSibling.data.token })
  check('refresh 宽限：宽限签发的兄弟对立即可用', graceMe.ok)
  const rotatedStillOk = await api('GET', '/api/auth/me', { token: rotated.data.token })
  check('refresh 宽限：宽限兑换不吊销原链（兄弟对共存）', rotatedStillOk.ok)
  // 上限兜底：同一旧 token 宽限兑换至 10 次封顶，超限仅拒绝该次请求、不吊销整链
  let capRejected = false
  for (let i = 0; i < 12 && !capRejected; i++) {
    const attempt = await api('POST', '/api/auth/refresh', { body: { refreshToken: rl.data.refreshToken } })
    if (!attempt.ok) capRejected = attempt.status === 401
  }
  check('refresh 宽限：超过兑换上限仅拒绝该次请求（宽限 10 次封顶）', capRejected)
  const capNotRevoked = await api('GET', '/api/auth/me', { token: rotated.data.token })
  check('refresh 宽限：超限拒绝不连带吊销整链', capNotRevoked.ok)

  // ================================================================ Authn
  section('统一认证（机器身份 / 令牌）')
  const cred = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'selftest-ci', refType: 'external', scopes: ['mcp.invoke'] } })
  check('签发机器凭证（secret 一次性返回）', cred.ok && cred.data.clientSecret.startsWith('cs_'))

  // 可绑定资源聚合 + 选择已注册主体自动关联（refType/refId 回填）
  const bindable = await api('GET', '/api/authn/bindable-resources', { token: admin })
  check('可绑定资源聚合（Agent / AI 应用清单）', bindable.ok && Array.isArray(bindable.data.agents) && bindable.data.agents.length > 0 && Array.isArray(bindable.data.apps))
  const agentEntry = bindable.data.agents[0]
  const credBind = await api('POST', '/api/authn/principals', { token: admin, body: { name: `agent:${agentEntry.name}`, refType: 'agent', refId: agentEntry.id, scopes: ['agent.read'] } })
  const principalList = await api('GET', '/api/authn/principals', { token: admin })
  const boundPrincipal = principalList.data.principals.find((p) => p.id === credBind.data.principalId)
  check('选择已注册主体签发 → 凭据自动关联资源', credBind.ok && boundPrincipal?.refType === 'agent' && boundPrincipal?.refId === agentEntry.id)

  const ccBad = await api('POST', '/api/auth/client-credentials', { body: { clientId: cred.data.clientId, clientSecret: 'wrong' } })
  check('错误 client_secret 被拒', ccBad.status === 401)

  const cc = await api('POST', '/api/auth/client-credentials', { body: { clientId: cred.data.clientId, clientSecret: cred.data.clientSecret } })
  check('Client Credentials 登录', cc.ok && cc.data.token.startsWith('dst1.'))
  const machine = cc.data.token

  const machineForbidden = await api('POST', '/api/iam/orgs', { token: machine, body: { name: '机器越权' } })
  check('机器身份越权被拒（scope 限制）', machineForbidden.status === 403)

  const issueToken = await api('POST', '/api/authn/tokens', { token: admin, body: { principalId: cc.data.principal.id, ttlHours: 1, reason: '自测签发' } })
  check('管理端签发令牌', issueToken.ok)
  const revoke = await api('DELETE', `/api/authn/tokens/${issueToken.data.jti}`, { token: admin, body: { reason: '自测吊销' } })
  check('吊销令牌', revoke.ok && revoke.data.revokedAt)
  const revokedUse = await api('GET', '/api/auth/me', { token: issueToken.data.token })
  check('吊销后令牌失效', revokedUse.status === 401)

  // 机器凭证治理：scopes 编辑（联动吊销）/ 密钥轮换 / 列表 hash 脱敏
  const govCred = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'gov-machine', refType: 'external', scopes: ['agent.read'] } })
  const govCc1 = await api('POST', '/api/auth/client-credentials', { body: { clientId: govCred.data.clientId, clientSecret: govCred.data.clientSecret } })
  check('治理夹具：签发 agent.read 机器凭证并换牌', govCc1.ok)

  const scopesPatch = await api('PATCH', `/api/authn/principals/${govCred.data.principalId}`, { token: admin, body: { scopes: ['agent.read', 'usage.write'] } })
  check('调整权限范围 200', scopesPatch.ok && scopesPatch.data.scopes.join(',') === 'agent.read,usage.write')
  const oldTokenAfterPatch = await api('GET', '/api/agents', { token: govCc1.data.token })
  check('调整 scopes 后旧令牌联动吊销（收权即时生效）', oldTokenAfterPatch.status === 401)
  const govCc2 = await api('POST', '/api/auth/client-credentials', { body: { clientId: govCred.data.clientId, clientSecret: govCred.data.clientSecret } })
  check('重新换牌按新范围签发', govCc2.ok && govCc2.data.principal.scopes.join(',') === 'agent.read,usage.write')

  const scopesTypo = await api('PATCH', `/api/authn/principals/${govCred.data.principalId}`, { token: admin, body: { scopes: ['usage.wrtie'] } })
  check('拼错权限点被拒（权限目录校验）', !scopesTypo.ok && JSON.stringify(scopesTypo.error).includes('非法权限点'))
  const scopesStarMix = await api('PATCH', `/api/authn/principals/${govCred.data.principalId}`, { token: admin, body: { scopes: ['*', 'agent.read'] } })
  check("'*' 与其他权限点混用被拒", !scopesStarMix.ok)
  const createTypo = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'typo-machine', refType: 'external', scopes: ['usage.wrtie'] } })
  check('创建凭证即校验权限点（入口防拼错）', !createTypo.ok && JSON.stringify(createTypo.error).includes('非法权限点'))

  // 机器角色：凭证引用组织角色（共用 iam:roles），权限随角色编辑实时同步，无需换牌
  const mrole = await api('POST', '/api/iam/roles', { token: admin, body: { name: '机器角色自测', code: 'mrole_selftest', description: 'selftest', permissions: ['agent.read'] } })
  check('创建机器角色（组织角色目录）', mrole.ok && !!mrole.data.id)
  const roleCred = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'role-machine', refType: 'external', roleIds: [mrole.data.id], scopes: [] } })
  check('签发仅角色授权的机器凭证（scopes 可空）', roleCred.ok)
  const roleCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: roleCred.data.clientId, clientSecret: roleCred.data.clientSecret } })
  check('换牌 scope 解析自角色权限点', roleCc.ok && [...roleCc.data.principal.scopes].sort().join(',') === 'agent.read')
  const roleMachine = roleCc.data.token
  const roleAllowed = await api('GET', '/api/agents', { token: roleMachine })
  check('角色授权机器可调用角色权限范围内的接口', roleAllowed.ok)
  const mroleShrink = await api('PATCH', `/api/iam/roles/${mrole.data.id}`, { token: admin, body: { permissions: ['skill.read'] } })
  const roleAfterShrink = await api('GET', '/api/agents', { token: roleMachine })
  check('角色收权后存量令牌实时降级（无需换牌）', mroleShrink.ok && roleAfterShrink.status === 403)
  const roleCc2 = await api('POST', '/api/auth/client-credentials', { body: { clientId: roleCred.data.clientId, clientSecret: roleCred.data.clientSecret } })
  check('重新换牌按新角色范围签发', roleCc2.ok && [...roleCc2.data.principal.scopes].sort().join(',') === 'skill.read')
  const roleCredPlus = await api('PATCH', `/api/authn/principals/${roleCred.data.principalId}`, { token: admin, body: { roleIds: [mrole.data.id], scopes: ['usage.write'] } })
  const principalAfterPlus = (await api('GET', '/api/authn/principals', { token: admin })).data.principals.find((p) => p.id === roleCred.data.principalId)
  check('角色 + 附加权限点并集生效（列表含角色名与解析后权限）', roleCredPlus.ok && principalAfterPlus.roleNames.includes('机器角色自测') && principalAfterPlus.resolvedScopes.includes('skill.read') && principalAfterPlus.resolvedScopes.includes('usage.write'))
  const emptyAuthz = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'empty-machine', refType: 'external', scopes: [] } })
  check('无角色且无权限点的凭证被拒', !emptyAuthz.ok)
  const ghostRole = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'ghost-machine', refType: 'external', roleIds: ['pri_nonexist'], scopes: ['agent.read'] } })
  check('引用不存在的角色被拒', !ghostRole.ok && JSON.stringify(ghostRole.error).includes('机器角色不存在'))

  const rotateCred = await api('POST', `/api/authn/principals/${govCred.data.principalId}/rotate-secret`, { token: admin })
  check('轮换 clientSecret（clientId 不变 + note 提示 + 无 hash 外发）', rotateCred.ok && rotateCred.data.clientId === govCred.data.clientId && !!rotateCred.data.note && !JSON.stringify(rotateCred.data).includes('Hash'))
  const oldSecretAfterRotate = await api('POST', '/api/auth/client-credentials', { body: { clientId: govCred.data.clientId, clientSecret: govCred.data.clientSecret } })
  check('旧 secret 换牌立即 401', oldSecretAfterRotate.status === 401)
  const newSecretLogin = await api('POST', '/api/auth/client-credentials', { body: { clientId: rotateCred.data.clientId, clientSecret: rotateCred.data.clientSecret } })
  check('新 secret 换牌 200', newSecretLogin.ok)

  const principalsList = await api('GET', '/api/authn/principals', { token: admin })
  check('身份列表不再外发 clientSecretHash', principalsList.ok && !JSON.stringify(principalsList.data).includes('clientSecretHash'))

  // ================================================================ 第 1 步：受众与插件命名空间
  section('第 1 步：令牌受众（aud）与插件命名空间收敛')
  const audPrincipal = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'reporting-svc', refType: 'external', scopes: ['audit.read'] } })
  const audToken = await api('POST', '/api/authn/tokens', { token: admin, body: { principalId: audPrincipal.data.principalId, audience: 'reporting', ttlHours: 1, reason: '受限受众令牌' } })
  check('签发带受众（aud）的令牌', audToken.ok)

  const audOk = await api('POST', '/api/authn/verify-audience', { token: admin, body: { token: audToken.data.token, audience: 'reporting' } })
  check('受众匹配 → 校验通过', audOk.data.valid === true)
  const audMismatch = await api('POST', '/api/authn/verify-audience', { token: admin, body: { token: audToken.data.token, audience: 'market' } })
  check('受众不匹配 → 拒绝', audMismatch.data.valid === false && String(audMismatch.data.reason).includes('受众'))

  const noAudToken = await api('POST', '/api/authn/tokens', { token: admin, body: { principalId: audPrincipal.data.principalId, ttlHours: 1 } })
  const noAudCheck = await api('POST', '/api/authn/verify-audience', { token: admin, body: { token: noAudToken.data.token, audience: 'reporting' } })
  check('无受众令牌访问受众服务被拒', noAudCheck.data.valid === false)

  const pluginScopeOk = await api('POST', '/api/authn/tokens', { token: admin, body: { principalId: audPrincipal.data.principalId, audience: 'plugin:com.demo.kb', scopes: ['plugin:com.demo.kb:read'], ttlHours: 1 } })
  check('插件令牌命名空间内 scope 放行', pluginScopeOk.ok)
  const pluginScopeBad = await api('POST', '/api/authn/tokens', { token: admin, body: { principalId: audPrincipal.data.principalId, audience: 'plugin:com.demo.kb', scopes: ['mcp.invoke'], ttlHours: 1 } })
  check('插件令牌跨命名空间 scope 被拒（唯一收敛面）', !pluginScopeBad.ok && JSON.stringify(pluginScopeBad.error).includes('越界'))

  // ================================================================ 第 2 步：租户最小集 + usage 管道
  section('第 2 步：多租户最小集与 usage 计量管道')
  const tenants = await api('GET', '/api/iam/tenants', { token: admin })
  check('默认租户兜底（存量数据落 t_default）', tenants.ok && tenants.data.tenants.some((t) => t.id === 't_default'))
  const newTenant = await api('POST', '/api/iam/tenants', { token: admin, body: { name: '磁姆科技', plan: 'enterprise' } })
  check('创建租户', newTenant.ok && newTenant.data.id.startsWith('t_'))
  const tenantOrg = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '磁姆中国区', tenantId: newTenant.data.id } })
  check('组织挂载租户', tenantOrg.ok && tenantOrg.data.tenantId === newTenant.data.id)

  const meterInput = { org: tenantOrg.data.id, subject: 'user:' + adminLogin.data.user.id, principal: `org:${tenantOrg.data.id}`, resource: 'mcp:real-backend', meters: [{ key: 'tokens', value: 5000, unit: 'token' }], idempotency_key: 'test-usage-001' }
  const meterA = await api('POST', '/api/usage/record', { token: admin, body: meterInput })
  check('计量事件登记（零价快照 charge=0 + 租户解析）', meterA.ok && meterA.data.pricing.charge_cents === 0 && meterA.data.pricing.rate?.pattern === 'mcp:*' && meterA.data.tenant_id === newTenant.data.id && meterA.data.schema_version === 1)
  const meterDup = await api('POST', '/api/usage/record', { token: admin, body: meterInput })
  check('幂等键重复投递不重复计量', meterDup.ok && meterDup.data.event_id === meterA.data.event_id)
  const meterTotals = await api('GET', '/api/usage/totals?principal=' + encodeURIComponent(`org:${tenantOrg.data.id}`), { token: admin })
  check('租户隔离的计量总额（只计一次）', meterTotals.ok && meterTotals.data.count === 1 && meterTotals.data.charge_cents === 0)
  const meterConflict = await api('POST', '/api/usage/record', { token: admin, body: { ...meterInput, meters: [{ key: 'tokens', value: 999, unit: 'token' }] } })
  check('同幂等键不同内容被拒（防篡改）', !meterConflict.ok && JSON.stringify(meterConflict.error).includes('冲突'))
  const badResource = await api('POST', '/api/usage/record', { token: admin, body: { ...meterInput, idempotency_key: 'test-usage-002', resource: 'not-a-resource' } })
  check('schema v1 校验（resource 格式拒绝）', !badResource.ok)
  const noPrice = await api('POST', '/api/usage/record', { token: admin, body: { ...meterInput, idempotency_key: 'test-usage-003', resource: 'model:no-such-model' } })
  check('无计价规则拒绝登记（不免费放行）', !noPrice.ok && JSON.stringify(noPrice.error).includes('计价'))

  // 计量键硬校验：事件必含价格簿 meter_key（缺失 400 且错误信息携带期望键；不再静默 0 计费）
  const wrongMeterKey = await api('POST', '/api/usage/record', { token: admin, body: { ...meterInput, idempotency_key: 'test-usage-wrong-key-1', meters: [{ key: 'calls', value: 1, unit: '次' }] } })
  check('计量键与价格簿不符被拒（mcp:* 须 tokens，错误可自纠）', !wrongMeterKey.ok && JSON.stringify(wrongMeterKey.error).includes('计量键不匹配') && JSON.stringify(wrongMeterKey.error).includes('tokens'))
  const rightKeyAgain = await api('POST', '/api/usage/record', { token: admin, body: { ...meterInput, idempotency_key: 'test-usage-right-key-1', meters: [{ key: 'tokens', value: 1000, unit: 'token' }] } })
  check('计量键匹配路径计价恒等（1000 tokens 零价快照 charge=0）', rightKeyAgain.ok && rightKeyAgain.data.pricing.charge_cents === 0)

  const reconcile1 = await api('POST', '/api/usage/reconcile', { token: admin })
  check('三方对账：usage 口径 = audit 投影（全量比对）', reconcile1.ok
    && reconcile1.data.reconciliation.mismatch === false
    && reconcile1.data.reconciliation.projections.some((p) => p.consumer === 'audit' && p.count === reconcile1.data.reconciliation.usage.count && p.charge_cents === reconcile1.data.reconciliation.usage.charge_cents))
  check('运行时对账检出未声明能力（M5 漂移）', reconcile1.data.drift.drift.length >= 1)
  const grant = await api('PUT', '/api/usage/capability-grants', { token: admin, body: { principal: `org:${tenantOrg.data.id}`, capabilities: ['mcp:*'] } })
  const reconcile2 = await api('POST', '/api/usage/reconcile', { token: admin })
  const tenantStillDrift = reconcile2.data.drift.drift.find((d) => d.principal === `org:${tenantOrg.data.id}`)
  check('授权后该主体能力漂移消除', grant.ok && tenantStillDrift === undefined)
  const driftAlerts = await api('GET', '/api/audit/alerts', { token: admin })
  check('能力漂移已入告警中心', driftAlerts.ok && JSON.stringify(driftAlerts.data.alerts).includes('能力漂移'))

  // ================================================================ 第 3 步：契约五面 / 事件源校验 / L0 市场
  section('usage 值域扩展（WP-03/D1：app:<id> 与 kb:<orgId>）')
  {
    const appMeter = await api('POST', '/api/usage/record', { token: admin, body: {
      org: tenantOrg.data.id, subject: 'user:' + adminLogin.data.user.id, principal: `org:${tenantOrg.data.id}`,
      resource: 'app:app-selftest-01', meters: [{ key: 'calls', value: 1, unit: 'call' }], idempotency_key: 'test-usage-app-001',
    } })
    check('app:<id> 事件入管道（默认零费率规则播种，charge=0）', appMeter.ok && appMeter.data.pricing.charge_cents === 0, JSON.stringify(appMeter.error))
    check('零费率事件自动标非计费（rate.nonbillable=true，D2 统一零价快照）', appMeter.ok && appMeter.data.pricing.rate?.nonbillable === true)
    const kbMeter = await api('POST', '/api/usage/record', { token: admin, body: {
      org: tenantOrg.data.id, subject: 'user:' + adminLogin.data.user.id, principal: `org:${tenantOrg.data.id}`,
      resource: `kb:${tenantOrg.data.id}`, meters: [{ key: 'calls', value: 3, unit: 'call' }], idempotency_key: 'test-usage-kb-001',
    } })
    check('kb:<orgId> 事件入管道（值域 additive，命中 kb:* 零费率）', kbMeter.ok && kbMeter.data.pricing.charge_cents === 0 && kbMeter.data.pricing.rate?.pattern === 'kb:*', JSON.stringify(kbMeter.error))
    const kbWrongMeter = await api('POST', '/api/usage/record', { token: admin, body: {
      org: tenantOrg.data.id, subject: 'user:' + adminLogin.data.user.id, principal: `org:${tenantOrg.data.id}`,
      resource: `kb:${tenantOrg.data.id}`, meters: [{ key: 'tokens', value: 5, unit: 'token' }], idempotency_key: 'test-usage-kb-002',
    } })
    check('kb:* 计量键仍受价格簿硬校验（须 calls，不静默 0 计费）', !kbWrongMeter.ok && JSON.stringify(kbWrongMeter.error).includes('计量键不匹配'))
  }
  section('零价快照构造（WP-03/D2：nonbillableUsage 便捷入口）')
  {
    const constructed = usage.nonbillableUsage({
      org: tenantOrg.data.id, subject: 'user:' + adminLogin.data.user.id, principal: `org:${tenantOrg.data.id}`,
      resource: `kb:${tenantOrg.data.id}`, idempotency_key: 'test-usage-nbu-001',
    })
    check('nonbillableUsage 便捷构造（calls 计量 + nonbillable 标记）',
      Array.isArray(constructed.meters) && constructed.meters[0]?.key === 'calls' && constructed.nonbillable === true, JSON.stringify(constructed))
    const recorded = await api('POST', '/api/usage/record', { token: admin, body: constructed })
    check('便捷构造事件直入 record（零价入账 + 标记在快照）', recorded.ok && recorded.data.pricing.charge_cents === 0 && recorded.data.pricing.rate?.nonbillable === true, JSON.stringify(recorded.error))
    const nonbillableOnPaid = await api('POST', '/api/usage/record', { token: admin, body: {
      org: tenantOrg.data.id, subject: 'user:' + adminLogin.data.user.id, principal: `org:${tenantOrg.data.id}`,
      resource: 'mcp:real-backend', meters: [{ key: 'tokens', value: 100, unit: 'token' }], idempotency_key: 'test-usage-nb-001', nonbillable: true,
    } })
    check('nonbillable 标记配非零费率规则被拒（防计费口径漂移）', !nonbillableOnPaid.ok && JSON.stringify(nonbillableOnPaid.error).includes('非计费'))
    const orgTotals = await api('GET', '/api/usage/totals?principal=' + encodeURIComponent(`org:${tenantOrg.data.id}`), { token: admin })
    check('零价快照不污染总额（charge 恒 0）', orgTotals.ok && orgTotals.data.charge_cents === 0, JSON.stringify(orgTotals.data))
  }
  section('FinOps 成本穿透（M2 CFO 视图：org×model 交叉 + 环比 + Top 主体）')
  {
    // FinOps 金额口径数据源：model:* 挂内部成本参考费率（10 分/千 tokens）——
    // 默认价格簿无 model 规则（record 硬校验拒收），故全库 model 域事件 = 本节构造的 4 条，断言可精确
    const priceUpsert = await api('PUT', '/api/usage/price-book', { token: admin, body: { pattern: 'model:*', meter_key: 'tokens', list_cents_per_unit: 0, cost_cents_per_unit: 10, units_per_step: 1000, tax_rate: 0, currency: 'CNY', rate_version: 'selftest-finops' } })
    check('价格簿登记 model:*（内部成本 10 分/千 tokens）', priceUpsert.ok, JSON.stringify(priceUpsert.error))
    const finOrg2 = await api('POST', '/api/iam/orgs', { token: admin, body: { name: 'FinOps 探针部' } })
    check('FinOps 第二部门建组织（矩阵第二行）', finOrg2.ok && finOrg2.data.id, JSON.stringify(finOrg2.error))
    const now = Date.now()
    const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
    const finMonth = new Date(now).toISOString().slice(0, 7)
    const probeSubject = 'user:finops-probe-a'
    const recordModel = (resource, tokens, minutesAgo, idem, extra = {}) => api('POST', '/api/usage/record', { token: admin, body: {
      org: tenantOrg.data.id, subject: probeSubject, principal: `org:${tenantOrg.data.id}`,
      resource: `model:${resource}`, meters: [{ key: 'tokens', value: tokens, unit: 'token' }],
      idempotency_key: `finops-${idem}`, occurred_at: at(minutesAgo), ...extra,
    } })
    // 空转判定矩阵（窗口 30 分钟，时间单位=分钟前）：evIdle@60 无后续动作=空转；evFollow@20 在
    // [20, -10] 内有 evAct2@10=非空转；evTrace@55 超窗但同 trace_id 有 evTraceAct@1=非空转；
    // evIdle2@10（agent 主体、另一部门）无动作=空转。model 域总成本 170 分、空转 70 分（41.2%）
    const evIdle = await recordModel('selftest-a', 5000, 60, 'idle-001')
    check('空转样本入账（model a / 5000 tokens → 50 分）', evIdle.ok && evIdle.data.pricing.cost_cents === 50, JSON.stringify(evIdle.error ?? evIdle.data.pricing))
    const evTrace = await recordModel('selftest-b', 6000, 55, 'trace-001', { trace_id: 'finops-trace-1' })
    const evFollow = await recordModel('selftest-a', 4000, 20, 'follow-001')
    const evAct1 = await api('POST', '/api/usage/record', { token: admin, body: { org: tenantOrg.data.id, subject: probeSubject, principal: `org:${tenantOrg.data.id}`, resource: 'mcp:real-backend', meters: [{ key: 'tokens', value: 1000, unit: 'token' }], idempotency_key: 'finops-act-001', occurred_at: at(28) } })
    const evAct2 = await api('POST', '/api/usage/record', { token: admin, body: { org: tenantOrg.data.id, subject: probeSubject, principal: `org:${tenantOrg.data.id}`, resource: 'mcp:real-backend', meters: [{ key: 'tokens', value: 1000, unit: 'token' }], idempotency_key: 'finops-act-002', occurred_at: at(10) } })
    const evTraceAct = await api('POST', '/api/usage/record', { token: admin, body: { org: tenantOrg.data.id, subject: probeSubject, principal: `org:${tenantOrg.data.id}`, resource: 'skill:finops-skill-1', meters: [{ key: 'calls', value: 1, unit: 'call' }], idempotency_key: 'finops-trace-act-001', occurred_at: at(1), trace_id: 'finops-trace-1' } })
    const evIdle2 = await api('POST', '/api/usage/record', { token: admin, body: { org: finOrg2.data.id, subject: 'agent:finops-probe-b', principal: `org:${finOrg2.data.id}`, resource: 'model:selftest-b', meters: [{ key: 'tokens', value: 2000, unit: 'token' }], idempotency_key: 'finops-idle-002', occurred_at: at(10) } })
    check('空转判定场景全部入账（4 model + 3 动作）', evFollow.ok && evAct1.ok && evAct2.ok && evTrace.ok && evTraceAct.ok && evIdle2.ok, JSON.stringify([evFollow.error, evAct1.error, evAct2.error, evTrace.error, evTraceAct.error, evIdle2.error].filter(Boolean)))

    const finOverview = await api('GET', `/api/finops/overview?month=${finMonth}`, { token: admin })
    check('FinOps overview 一次取全（penetration + idle）', finOverview.ok && Boolean(finOverview.data.penetration) && Boolean(finOverview.data.idle), JSON.stringify(finOverview.error))
    const pen = finOverview.data?.penetration
    check('穿透 totals 金额口径（全资源成本 ≥ model 域 170 分）', pen && pen.totals.cost_cents >= 170, JSON.stringify(pen?.totals))
    // demo seed 带 28 天历史（可能跨上月）：环比断言用自洽验证（delta 与 cost/prev 复算一致），不假设基数为 0
    check('穿透环比口径（delta_pct 与 cost/prev 复算自洽，prev=0 且 cur>0 时为 null）', pen && (() => {
      const { cost_cents, prev_cost_cents, delta_pct } = pen.totals
      const expected = prev_cost_cents === 0 ? (cost_cents === 0 ? 0 : null) : Math.round(((cost_cents - prev_cost_cents) / prev_cost_cents) * 1000) / 10
      return delta_pct === expected
    })(), JSON.stringify(pen?.totals))
    check('部门维度含两个探针组织（byOrg 按成本降序）', pen && pen.byOrg.some((r) => r.dimension === tenantOrg.data.id) && pen.byOrg.some((r) => r.dimension === finOrg2.data.id), JSON.stringify(pen?.byOrg?.map((r) => r.dimension)))
    // 演示种子（DEMO_SEED=1，设计适配 2026-10-14 起 model:deepseek-chat/qwen-plus 亦带用量）与本节
    // 探针事件同库：原先「全库 model 域=本节 4 条」的排他前提不再成立，排他断言改为
    // 「探针条目精确 + 份额与全库复算自洽」的鲁棒等价形式（校验意图不变）。
    const modelRow = (slug) => pen?.byModel?.find((r) => r.dimension === slug)
    check('模型维度探针精确（selftest-a 90 分 / selftest-b 80 分）', modelRow('selftest-a')?.cost_cents === 90 && modelRow('selftest-b')?.cost_cents === 80, JSON.stringify(pen?.byModel))
    check('org×model 矩阵行列齐备（Top orgs/models + 「其他」行列）', pen && pen.matrix.orgs.length >= 2 && pen.matrix.models.length >= 2 && pen.matrix.cells.length === pen.matrix.orgs.length + 1 && pen.matrix.cells[0].length === pen.matrix.models.length + 1, JSON.stringify(pen?.matrix))
    check('矩阵总计守恒（全格之和 = model 域成本合计 170 分）', pen && (() => {
      const sumCells = pen.matrix.cells.flat().reduce((s, v) => s + v, 0)
      return sumCells === pen.byModel.reduce((s, r) => s + r.cost_cents, 0)
    })(), JSON.stringify(pen?.matrix?.cells))
    check('Top 消耗主体（探针主体在列）', pen && pen.topSubjects.some((r) => r.subject === probeSubject), JSON.stringify(pen?.topSubjects))
    const idle1 = finOverview.data?.idle
    check('空转判定：恰好 2 条疑似空转（无后续动作的 model 调用）', idle1 && idle1.idle.events === 2, JSON.stringify(idle1))
    check('空转成本精确（探针 50+20=70 分；份额与全库 model 域复算自洽）', idle1 && idle1.idle.cost_cents === 70 && idle1.idle.share_pct === (() => {
      const modelTotal = pen.byModel.reduce((s, r) => s + r.cost_cents, 0)
      return modelTotal === 0 ? 0 : Math.round((idle1.idle.cost_cents / modelTotal) * 1000) / 10
    })(), JSON.stringify({ idle: idle1?.idle, byModelTotal: pen?.byModel?.reduce((s, r) => s + r.cost_cents, 0) }))
    const idleModelRow = (slug) => idle1?.byModel?.find((r) => r.model === slug)
    const idleOrgRow = (orgId) => idle1?.byOrg?.find((r) => r.org === orgId)
    check('空转分模型拆分（探针 selftest-a/b 各 1 条）', idleModelRow('selftest-a')?.idle_events === 1 && idleModelRow('selftest-b')?.idle_events === 1, JSON.stringify(idle1?.byModel))
    check('空转分部门拆分（两探针部门各 1 条）', idleOrgRow(tenantOrg.data.id)?.idle_events === 1 && idleOrgRow(finOrg2.data.id)?.idle_events === 1, JSON.stringify(idle1?.byOrg))
    check('空转样本可复核（samples 含两条 + 时间/主体/模型齐备）', idle1 && idle1.samples.length === 2 && idle1.samples.every((s) => s.occurred_at && s.subject && s.resource), JSON.stringify(idle1?.samples))
    const idleTight = await api('GET', `/api/finops/idle?month=${finMonth}&window=5`, { token: admin })
    check('空转窗口参数生效（窗口收窄 5 分钟 → evFollow 亦成疑似，空转数上升）', idleTight.ok && idleTight.data.idleWindowMinutes === 5 && idleTight.data.idle.events >= 3, JSON.stringify({ w: idleTight.data?.idleWindowMinutes, idle: idleTight.data?.idle }))
    const finDeniedProbe = await api('POST', '/api/iam/users', { token: admin, body: { username: 'finops_probe', displayName: 'FinOps 权限探针', orgId: tenantOrg.data.id, roleIds: [(await api('GET', '/api/iam/roles', { token: admin })).data.roles.find((r) => r.code === 'member').id] } })
    const finProbeToken = (await api('POST', '/api/auth/login', { body: { username: 'finops_probe', password: finDeniedProbe.data?.initialPassword ?? 'Ybk@2026' } })).data?.token
    const finDenied = await api('GET', '/api/finops/overview', { token: finProbeToken })
    check('无 usage.read 访问 CFO 视图被拒（403）', finDenied.status === 403, String(finDenied.status))
    const finCsv = await rawReq('GET', `/api/finops/report/monthly?month=${finMonth}&format=csv`, { headers: { authorization: `Bearer ${admin}` } })
    check('FinOps CSV 导出（text/csv + BOM + 穿透/空转区块表头）', finCsv.status === 200 && (finCsv.headers['content-type'] ?? '').includes('text/csv') && finCsv.body.startsWith('\ufeff') && finCsv.body.includes('部门穿透') && finCsv.body.includes('空转检测'), JSON.stringify({ status: finCsv.status, head: finCsv.body.slice(0, 80) }))
    const finBadMonth = await api('GET', '/api/finops/overview?month=2026-13', { token: admin })
    check('非法月份参数被拒（400）', finBadMonth.status === 400, String(finBadMonth.status))
    // 组4：成本管道同源（seed 不再 audit:costs 直写）——演示计量经 usage 管道入账，
    // 幂等键 seed:<resource>:<date> 可反查，audit:costs 由价格簿费率派生（FinOps 鲁棒断言即其消费面）
    const seedEvents = await api('GET', '/api/usage/events?limit=200', { token: admin })
    const seedDerived = (seedEvents.data?.items ?? []).filter((item) => String(item.idempotency_key ?? '').startsWith('seed:'))
    check('成本管道：demo 种子计量经 usage 管道入账（seed: 幂等键可反查且带定价，成本经管道派生非直写）',
      seedEvents.ok && seedDerived.length >= 10 && seedDerived.every((item) => item.pricing && Number.isFinite(item.pricing.cost_cents)),
      JSON.stringify({ total: seedEvents.data?.total, seedHits: seedDerived.length, sample: seedDerived[0]?.idempotency_key }))
  }
  section('首启 bootstrap 状态（M2 部署产品化：上线三步走数据源）')
  {
    const bootAnon = await rawReq('GET', '/api/platform/bootstrap', { headers: {} })
    const bootAnonBody = jsonBody(bootAnon)
    check('bootstrap 公开端点可达（登录页提示数据源，匿名可读）', bootAnon.status === 200 && typeof bootAnonBody.data?.initialPasswordPending === 'boolean', JSON.stringify({ status: bootAnon.status, body: bootAnonBody }))
    check('演示种子无初始口令待接管（DEMO 口令显式指定不落盘）', bootAnonBody.data?.initialPasswordPending === false, JSON.stringify(bootAnonBody))
    const bootDetailAnon = await rawReq('GET', '/api/platform/bootstrap/detail', { headers: {} })
    check('bootstrap detail 强制鉴权（匿名 401）', bootDetailAnon.status === 401, String(bootDetailAnon.status))
    const bootDetail = await api('GET', '/api/platform/bootstrap/detail', { token: admin })
    check('bootstrap detail 全量（demo 模式 + 根组织 + seededAt）', bootDetail.ok && bootDetail.data.initialized === true && bootDetail.data.mode === 'demo' && bootDetail.data.orgName === '元冰可集团' && Boolean(bootDetail.data.seededAt) && bootDetail.data.initialPasswordPending === false, JSON.stringify(bootDetail.data))
  }
  section('T2 远程接入降级审计接线（connect.degraded 落审计链）')
  {
    // 行为面（emit→审计落库）由 connect 客户端形态真实触发，隔离实例为 host 形态；
    // 此处以接线完整性断言护航（双侧源码在位：emit 点 + audit 订阅点）
    const auditSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-audit', 'src', 'index.ts'), 'utf8')
    const connectSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-connect', 'src', 'client.ts'), 'utf8')
    const connectIdx = readFileSync(join(process.cwd(), 'packages', 'plugin-connect', 'src', 'index.ts'), 'utf8')
    check('audit 已订阅 connect.degraded（T2 收口：降级显式留痕，不再只到总线为止）', auditSrc.includes("platformBus.on('connect.degraded'"))
    check('connect 降级事件源在位（扩展点缺失 + 转发失败两条 fail-closed 路径均发事件）',
      connectSrc.includes("emit('connect.degraded'") && connectIdx.includes("emit('connect.degraded'"))
  }
  section('T6 billing 残留防复发（集成面零 precheckCents）')
  {
    const dshctl = readFileSync(join(process.cwd(), 'cli', 'dshctl.mjs'), 'utf8')
    const connDoc = readFileSync(join(process.cwd(), 'docs', 'connector-integration.md'), 'utf8')
    const connTools = readFileSync(join(process.cwd(), 'packages', 'plugin-connector', 'src', 'tools.ts'), 'utf8')
    check('dshctl 用法文案无 precheckCents 残留（T6）', !dshctl.includes('precheckCents'))
    check('connector 集成文档无 precheckCents 示例（T6）', !connDoc.includes('precheckCents'))
    check('connector 工具描述无计费预检/precheckCents 残留（T6，防误导集成方）', !connTools.includes('计费预检') && !connTools.includes('precheckCents'))
  }
  section('behavior 事件管道（WP-03/D3：采集 / 鉴权 / 幂等）')
  {
    const anon = await api('POST', '/api/behavior/events', { body: { type: 'card.exposed' } })
    check('behavior 采集：未认证 401（write-only 门禁 fail-closed）', anon.status === 401, String(anon.status))
    const evt = await api('POST', '/api/behavior/events', { token: dev, body: { type: 'card.exposed', platform: 'rd', payload: { cardRef: 'c-001' }, idempotency_key: 'test-behavior-001' } })
    check('behavior 采集：登录用户上报成功（主体强制取认证身份）',
      evt.ok && evt.data.event?.idempotency_key === 'test-behavior-001' && evt.data.duplicated === false
      && String(evt.data.event?.subject ?? '').startsWith('user:') && evt.data.event?.schema === 'behavior.recorded',
      JSON.stringify(evt.error ?? evt.data))
    const evtDup = await api('POST', '/api/behavior/events', { token: dev, body: { type: 'card.exposed', platform: 'rd', payload: { cardRef: 'c-001' }, idempotency_key: 'test-behavior-001' } })
    check('behavior 采集：幂等重放返回既有事件 + duplicated 标记', evtDup.ok && evtDup.data.duplicated === true && evtDup.data.event?.event_id === evt.data.event?.event_id)
    const evtConflict = await api('POST', '/api/behavior/events', { token: dev, body: { type: 'card.clicked', idempotency_key: 'test-behavior-001' } })
    check('behavior 采集：同幂等键不同内容被拒', !evtConflict.ok)
    const evtBadType = await api('POST', '/api/behavior/events', { token: dev, body: { type: 'BAD TYPE' } })
    check('behavior 采集：type 点分小写键校验', !evtBadType.ok)
    const evtOversize = await api('POST', '/api/behavior/events', { token: dev, body: { type: 'card.exposed', payload: { blob: 'x'.repeat(5000) } } })
    check('behavior 采集：payload 超 4KB 被拒', !evtOversize.ok && JSON.stringify(evtOversize.error).includes('超限'))
    const devRead = await api('GET', '/api/behavior/events', { token: dev })
    check('behavior 只读：无 audit.read 被拒 403', devRead.status === 403, String(devRead.status))
    const adminRead = await api('GET', '/api/behavior/events?type=card.exposed', { token: admin })
    check('behavior 只读：audit.read 可查且幂等不双计（total=1）', adminRead.ok && adminRead.data.total === 1, JSON.stringify(adminRead.data))
  }
  section('五平台主题（WP-05/B3：仅 data-platform 属性差，定版色值在位）')
  {
    const themeCss = readFileSync(join(process.cwd(), 'packages', 'plugin-console', 'public', 'css', 'base.css'), 'utf8')
    check('主题：五平台仅 data-platform 属性差（五块覆盖 + 定版色值在位，无 Tailwind 引入）',
      [['strategy', '#3B4CC0'], ['marketing', '#E8590C'], ['manufacturing', '#0C8599'], ['rd', '#7048E8'], ['quality', '#2F9E44']]
        .every(([platform, hex]) => themeCss.includes(`data-platform="${platform}"`) && themeCss.includes(hex))
        && !themeCss.toLowerCase().includes('tailwind'),
      'base.css 平台主题块缺失或色值漂移')
  }
  section('rbac endpoint matrix（WP-04/A1：普通成员直调管理端点 100% 被拒，矩阵驱动）')
  {
    const matrix = await api('GET', '/api/platform/route-matrix', { token: admin })
    check('矩阵：服务端路由×权限矩阵可查询（端点覆盖面充足）',
      matrix.ok && matrix.data.guarded.length >= 100 && matrix.data.public.length >= 5,
      `guarded=${matrix.data?.guarded?.length} public=${matrix.data?.public?.length}`)
    // 普通成员：member 角色仅 console.login + skill.read + agent.read + app.read
    const roles = (await api('GET', '/api/iam/roles', { token: admin })).data.roles
    const memberRole = roles.find((role) => role.code === 'member')
    const memberInit = await api('POST', '/api/iam/users', { token: admin, body: { username: 'matrix_member', displayName: '矩阵探针', orgId: tenantOrg.data.id, roleIds: [memberRole.id] } })
    const memberInitPassword = memberInit.data?.initialPassword ?? 'Ybk@2026'
    const memberLogin = await api('POST', '/api/auth/login', { body: { username: 'matrix_member', password: memberInitPassword } })
    check('矩阵：普通成员账号就绪', memberLogin.ok, JSON.stringify(memberLogin.error))
    const member = memberLogin.data.token
    const memberPerms = memberLogin.data.user.permissions
    // 期望推导的蕴含镜像（与 rest-gate IMPLIED_POINTS 同步改）：member 持 console.login
    // 即视为持 console.read——否则 5 个 console.read 纯读路由会被误判为「应对成员 403」
    const memberHas = (point) => memberPerms.includes(point)
      || (point === 'console.read' && memberPerms.includes('console.login'))
    const denied = matrix.data.guarded.filter((route) => !route.permission.split(',').some(memberHas))
    let rejectedCount = 0
    const leaked = []
    for (const route of denied) {
      const probePath = route.path.replace(/:[a-zA-Z]+/g, 'selftest-probe')
      try {
        const probe = await api(route.method, probePath, { token: member, ...(route.method === 'GET' ? {} : { body: {} }) })
        if (probe.status === 403) rejectedCount++
        else leaked.push(`${route.method} ${route.path}(${route.permission}) → ${probe.status}`)
      } catch (error) {
        leaked.push(`${route.method} ${route.path} → 异常 ${error.message}`)
      }
    }
    check(`矩阵：${denied.length} 个越权探针 100% 被拒 403（端点清单变动即红）`,
      denied.length >= 50 && leaked.length === 0,
      leaked.length ? `泄漏端点：${leaked.slice(0, 5).join('；')}` : `denied=${denied.length} rejected=${rejectedCount}`)
    const expectedPublic = ['/api/auth/login', '/api/auth/refresh', '/api/health', '/api/authn/entry-tickets/redeem', '/api/auth/entry-ticket-session', '/api/panel/auth/demo-entry']
    check('矩阵：公开白名单零意外扩张（变动须经评审后同步本清单）',
      expectedPublic.every((path) => matrix.data.public.includes(path)),
      JSON.stringify(matrix.data.public))
    // H5（T-01 教训）：端点全量可枚举 + 公开自校验端点匿名探针 fail-closed——
    // /api/panel/stream 类自注册端点不再可能逃出断言网（注册期缺声明即抛错兜底）
    check('矩阵：/api/* 全量声明且三分类全覆盖（H5：register 缺声明注册期即抛）',
      matrix.data.counts.declaredApi === matrix.data.counts.guarded + matrix.data.counts.public + matrix.data.counts.authenticated
      && matrix.data.counts.undeclaredApi === 0,
      JSON.stringify(matrix.data.counts))
    // issue #6：OpenAPI 接口面发现——由同一份 declaredRoutes 台账投影，分类计数必须与矩阵逐类吻合
    const openapiAnon = await rawReq('GET', '/api/openapi.json')
    check('OpenAPI：/api/openapi.json 匿名 → 401（authenticated 面，接口清单不对匿名开放）', openapiAnon.status === 401, `status=${openapiAnon.status}`)
    const openapiRaw = await rawReq('GET', '/api/openapi.json', { headers: { authorization: `Bearer ${admin}` } })
    const spec = jsonBody(openapiRaw)
    check('OpenAPI：合法 Bearer → 200 原始 3.0.3 文档（非 {ok,data} 信封，Swagger UI / 代码生成器可直接消费）',
      openapiRaw.status === 200 && String(openapiRaw.headers['content-type']).startsWith('application/json')
      && spec.openapi === '3.0.3' && !('ok' in spec) && typeof spec.paths === 'object' && Boolean(spec.info?.version)
      && spec.components?.securitySchemes?.bearerAuth?.scheme === 'bearer',
      `status=${openapiRaw.status} openapi=${spec.openapi}`)
    const specOps = Object.entries(spec.paths ?? {}).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ method, path, op })))
    const specByAccess = specOps.reduce((acc, { op }) => { const access = op['x-auth']?.access ?? 'missing'; acc[access] = (acc[access] ?? 0) + 1; return acc }, {})
    check(`OpenAPI：操作按鉴权分类计数与 route-matrix 逐类吻合（guarded ${specByAccess.guarded} / public ${specByAccess.public} / authenticated ${specByAccess.authenticated}）`,
      specByAccess.guarded === matrix.data.counts.guarded && specByAccess.public === matrix.data.counts.public
      && specByAccess.authenticated === matrix.data.counts.authenticated && specByAccess.missing === undefined,
      JSON.stringify({ spec: specByAccess, matrix: matrix.data.counts }))
    check('OpenAPI：guarded 端点 security=bearerAuth + x-permission；public 端点 security=[]；自身声明 authenticated',
      spec.paths['/api/platform/route-matrix']?.get?.['x-permission'] === 'audit.read'
      && JSON.stringify(spec.paths['/api/platform/route-matrix']?.get?.security) === '[{"bearerAuth":[]}]'
      && JSON.stringify(spec.paths['/api/health']?.get?.security) === '[]'
      && spec.paths['/api/openapi.json']?.get?.['x-auth']?.access === 'authenticated')
    const paramOps = specOps.filter(({ path }) => path.includes('{'))
    check(`OpenAPI：参数路由以 {param} 表达并逐一声明 required path parameters（${paramOps.length} 个操作）`,
      paramOps.length > 0 && paramOps.every(({ path, op }) => {
        const names = (path.match(/\{([^}]+)\}/g) ?? []).map((segment) => segment.slice(1, -1))
        const declared = (op.parameters ?? []).filter((p) => p.in === 'path' && p.required === true).map((p) => p.name)
        return names.join() === declared.join()
      }))
    const operationIds = specOps.map(({ op }) => op.operationId)
    check('OpenAPI：operationId 全量唯一；/mcp 等协议面标为 outside-api、不声明 security、不套统一信封',
      new Set(operationIds).size === operationIds.length && operationIds.every(Boolean)
      && spec.paths['/mcp']?.post?.['x-auth']?.access === 'outside-api' && spec.paths['/mcp']?.post?.security === undefined
      && spec.paths['/mcp']?.post?.responses?.['200'] === undefined)
    check('OpenAPI 纯函数：toOpenApiPath 把 :id 段转 {id} 并按序返回参数名',
      JSON.stringify(platformCore.toOpenApiPath('/api/iam/users/:id/roles/:roleId')) === JSON.stringify({ path: '/api/iam/users/{id}/roles/{roleId}', params: ['id', 'roleId'] }))
    const selfValidated = matrix.data.publicEntries.filter((entry) => entry.selfValidated)
    const anonLeaked = []
    for (const route of selfValidated) {
      const probePath = route.path.replace(/:[a-zA-Z]+/g, 'selftest-probe')
      try {
        const probe = await api(route.method, probePath, route.method === 'GET' ? {} : { body: {} })
        if (probe.status === 200 || probe.status === 500) anonLeaked.push(`${route.method} ${route.path} → ${probe.status}`)
      } catch (error) {
        anonLeaked.push(`${route.method} ${route.path} → 异常 ${error.message}`)
      }
    }
    check(`矩阵：${selfValidated.length} 个公开自校验端点匿名探针 100% fail-closed（H5）`,
      selfValidated.length >= 4 && anonLeaked.length === 0, anonLeaked.length ? anonLeaked.slice(0, 5).join('；') : '全部 401/403/400/404')
    const bareFetch = []
    const walkJs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walkJs(join(dir, entry.name)) : [join(dir, entry.name)])
    for (const file of walkJs(join(process.cwd(), 'packages', 'plugin-console', 'public'))) {
      if (!file.endsWith('.js')) continue
      if (file.replaceAll('\\', '/').endsWith('/js/api.js')) continue
      if (file.replaceAll('\\', '/').endsWith('/js/i18n.js')) continue // i18n 词典运输层（公开静态 /locales 端点、api.js 加载前运行、无令牌语义；api.js 同级豁免，注释在案）
      if (file.replaceAll('\\', '/').endsWith('/js/pages/oauth.js')) continue // 协议页豁免（注释在案）
      if (file.replaceAll('\\', '/').endsWith('/js/realtime.js')) continue // SSE/轮询运输层模块（api.js 同级豁免，注释在案）
      const text = readFileSync(file, 'utf8')
      // 只扫代码行：整行注释里提到 transport 词（如「浏览器原生流对象无法带 Bearer 头」）不是裸调用，
      // 与本段后面的弹窗不变量同口径（后者已 strip 行注释），避免注释措辞把门禁变脆。
      const codeText = text.split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n')
      if (/fetch\(|XMLHttpRequest|EventSource/.test(codeText)) bareFetch.push(file.split(/[\\/]/).pop())
    }
    check('走查不变量：console 前端除 api.js（与协议页豁免）外零裸 fetch/XHR/SSE',
      bareFetch.length === 0, JSON.stringify(bareFetch))
    // dsh 完整页面体验（design-adaptation-spec §6，2026-10-14）：控制台与面板前端
    // 禁止 window.open/alert/confirm/prompt 弹窗子窗口——新视图一律抽屉或同窗口整页跳转。
    const popupHits = []
    for (const root of ['packages/plugin-console/public', 'packages/plugin-panel-core/public']) {
      const walkPopup = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walkPopup(join(dir, entry.name)) : [join(dir, entry.name)])
      for (const file of walkPopup(join(process.cwd(), root))) {
        if (!file.endsWith('.js') || file.endsWith('.test.mjs')) continue
        const text = readFileSync(file, 'utf8')
        if (/window\.open\(|(?<![.\w])alert\(|(?<![.\w])confirm\(|(?<![.\w])prompt\(/.test(text.replace(/\/\/[^\n]*/g, ''))) popupHits.push(file.split(/[\\/]/).pop())
      }
    }
    check('走查不变量：console+panel 前端零 window.open/alert/confirm/prompt 弹窗（dsh 完整页面）',
      popupHits.length === 0, JSON.stringify(popupHits))

    // -- UXQA_R1 修复回归护栏（2026-11-02，uxqa-results/测试评估报告_UXQA_R1.md 问题卡） ----
    // 静态锚定四项前台修复的关键语义，回退即红（行为面验收由 UXQA 复测承担）。
    {
      const panelAppJs = readFileSync('packages/plugin-panel-core/public/js/app.js', 'utf8')
      const panelApiJs = readFileSync('packages/plugin-panel-core/public/js/api.js', 'utf8')
      const mfgCss = readFileSync('packages/plugin-panel-core/public/css/mfg.css', 'utf8')
      const mfgJs = readFileSync('packages/plugin-panel-core/public/js/mfg.js', 'utf8')
      check('UXQA-R1-005 护栏：实时通道重连消费 refresh（refreshSessionNow + 轮询 401 自愈 + expired 引导重登）',
        panelApiJs.includes('refreshSessionNow') && panelAppJs.includes('refreshSessionNow()')
        && panelAppJs.includes("info.status === 401") && panelAppJs.includes('streamAuthHealing'))
      check('UXQA-R1-002 护栏：流转请求携带期望泳道（expectedLane 乐观锁）+ 409 冲突刷新到权威态',
        panelAppJs.includes('expectedLane') && panelAppJs.includes('data-from=') && panelAppJs.includes('error.status === 409'))
      check('UXQA-R1-001 护栏：钉钉自动弹窗关闭记忆（panel_dd_prompt_off + onClose 回调链）',
        panelAppJs.includes('panel_dd_prompt_off') && panelAppJs.includes('markDdPromptDismissed') && panelAppJs.includes('modalOnClose'))
      check('UXQA-R1-003 护栏：写入口按权限收敛（composer 只读锁定 + 流转/新建按 panel.task.write 门控）',
        panelAppJs.includes('只读身份——可浏览会话与看板') && /session\.can\('panel\.task\.write'\)/.test(panelAppJs))
      check('UXQA-R1-004 护栏：制造抽屉 z-index 抬升避让顶栏（scrim/drawer ≥910）',
        /\.mfg-scrim \{[^}]*z-index: 910/.test(mfgCss) && /\.mfg-drawer \{[^}]*z-index: 911/.test(mfgCss))
      check('UXQA OBS-04 护栏：清空本机记录两步确认（armClearButton 武装态，零弹窗）',
        mfgJs.includes('armClearButton') && mfgJs.includes('再点一次执行'))
    }
  }
  section('usage 最近调用（WP-04/A3：工作台自见 ≤5）')
  {
    const devUserId = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('dev'), { token: admin })).data.users.find((user) => user.username === 'dev').id
    await api('POST', '/api/usage/record', { token: admin, body: {
      org: tenantOrg.data.id, subject: `user:${devUserId}`, principal: `org:${tenantOrg.data.id}`,
      resource: 'mcp:real-backend', meters: [{ key: 'tokens', value: 1200, unit: 'token' }], idempotency_key: 'test-usage-recent-001',
    } })
    const recent = await api('GET', '/api/usage/recent?limit=5', { token: dev })
    check('最近调用：登录人自身计量事件自见（≤5 条，含展示名与计量明细）',
      recent.ok && recent.data.items.length >= 1 && recent.data.items.length <= 5
      && recent.data.items[0].resource === 'mcp:real-backend' && Boolean(recent.data.items[0].name) && Array.isArray(recent.data.items[0].meters),
      JSON.stringify(recent.error ?? recent.data))
    const recentAnon = await api('GET', '/api/usage/recent')
    check('最近调用：未认证被拒（401，服务端强制不靠菜单隐藏）', recentAnon.status === 401)
  }
  section('feedback 回传（WP-07/D1：👍👎 落零价快照 + 归因 + 幂等不重复计数）')
  {
    const fb = await api('POST', '/api/usage/feedback', { token: dev, body: { resource: 'agent:dev-coder', messageId: 'msg-drill-1', score: 'up', note: '很准' } })
    check('feedback：👍 落库为非计费零价快照（charge=0 + nonbillable）',
      fb.ok && fb.data.charge_cents === 0 && fb.data.nonbillable === true, JSON.stringify(fb.error ?? fb.data))
    const fbReplay = await api('POST', '/api/usage/feedback', { token: dev, body: { resource: 'agent:dev-coder', messageId: 'msg-drill-1', score: 'up' } })
    check('feedback：同键重放幂等（同一 event_id，不重复计数）', fbReplay.ok && fbReplay.data.event_id === fb.data.event_id)
    const devUserId = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('dev'), { token: admin })).data.users.find((user) => user.username === 'dev').id
    const fbOnBehalf = await rawReq('POST', '/api/usage/feedback', {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}`, 'x-on-behalf-user': devUserId },
      body: JSON.stringify({ resource: 'agent:dev-coder', messageId: 'msg-drill-2', score: 'down' }),
    })
    check('feedback：X-On-Behalf-User 归因到人（Agent 代用户回传）', fbOnBehalf.status === 200, String(fbOnBehalf.status))
    const agentEvents = await api('GET', '/api/usage/events?resource=' + encodeURIComponent('agent:dev-coder') + '&limit=50', { token: admin })
    const subjects = new Set(agentEvents.data.items.map((event) => event.subject))
    check('feedback：事件主体归因正确（dev 本人 + OBO 归因均在列）', subjects.has(`user:${devUserId}`), JSON.stringify([...subjects]))
    const fbBad = await api('POST', '/api/usage/feedback', { token: dev, body: { resource: 'agent:dev-coder', score: 'meh' } })
    check('feedback：非法评分被拒 400', fbBad.status === 400, String(fbBad.status))
    // 组4+主控：幂等键去掉 score 段——同 messageId 改评分（改评）不再双计，仍归并到首条事件
    const fbRescore = await api('POST', '/api/usage/feedback', { token: dev, body: { resource: 'agent:dev-coder', messageId: 'msg-drill-1', score: 'down', note: '改评：复看后认为不准确' } })
    check('feedback：同 messageId 改评分幂等（不再双计，event_id 归并首条）',
      fbRescore.ok && fbRescore.data.event_id === fb.data.event_id, JSON.stringify({ replay: fbRescore.data?.event_id, first: fb.data?.event_id, err: fbRescore.error }))
    const fbStatsRescore = await api('GET', '/api/usage/feedback-stats?days=7', { token: admin })
    const rescoreRow = (fbStatsRescore.data?.byResource ?? []).find((row) => row.resource === 'agent:dev-coder')
    check('feedback：改评不产生第二条聚合（agent:dev-coder 行 up=1/down=1，down 仅 OBO msg-drill-2 一条）',
      fbStatsRescore.ok && rescoreRow && rescoreRow.up === 1 && rescoreRow.down === 1,
      JSON.stringify({ row: rescoreRow, err: fbStatsRescore.error }))
    // ================================================================ W4 收敛：机器主体 X-On-Behalf-User 白名单（归一化 + 三通道 + audit 留痕）
    {
      // 专用新 Agent（owner=admin、零绑定、零 workforce 员工绑定）——三分支判定全部确定性，不依赖种子数据归属
      const w4AgentCreate = await api('POST', '/api/agents', { token: admin, body: { name: 'W4 归因白名单自测机器人', attrs: { description: 'W4 feedback OBO 白名单自测专用', model: 'deepseek-chat', riskLevel: 'low' } } })
      const w4Agent = w4AgentCreate.data.agent
      const w4Cred = await api('POST', '/api/authn/principals', { token: admin, body: { name: `w4-feedback:${w4Agent.name}`, refType: 'agent', refId: w4Agent.id, scopes: ['console.login'] } })
      const w4Cc = await api('POST', '/api/auth/client-credentials', { body: { clientId: w4Cred.data.clientId, clientSecret: w4Cred.data.clientSecret } })
      check('W4：机器凭证就绪（refType=agent + console.login scope → client-credentials 换 token）',
        w4Cc.ok && typeof w4Cc.data.token === 'string' && w4Cc.data.token.length > 0, JSON.stringify(w4Cc.error ?? {}))
      const w4AuditHit = async () => {
        for (let i = 0; i < 10; i++) {
          const logs = (await api('GET', '/api/audit/logs?type=authz&q=' + encodeURIComponent('usage.feedback(on-behalf') + '&limit=100', { token: admin })).data.items
          const hit = logs.find((item) => item.actorId === w4Cred.data.principalId && item.detail.includes('usage.feedback(on-behalf:agent:'))
          if (hit) return true
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        return false
      }
      // ① 机器凭证 OBO 指向白名单外用户（dev：非 owner/未绑定）→ 403 且 audit.authz.denied 留痕
      const w4Deny = await rawReq('POST', '/api/usage/feedback', {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${w4Cc.data.token}`, 'x-on-behalf-user': devUserId },
        body: JSON.stringify({ resource: `agent:${w4Agent.id}`, messageId: 'w4-deny-1', score: 'up' }),
      })
      check('W4：机器凭证 OBO 指向白名单外用户 → 403（机器主体不得归因到任意用户）', w4Deny.status === 403, String(w4Deny.status))
      check('W4：403 反查 audit/authz 留痕（detail 含 usage.feedback(on-behalf:agent:<refId>)）', await w4AuditHit())
      // ② 绑定端点把 dev 绑为该 Agent 绑定真人 → 同头值放行 200（白名单内行为不变，零价快照口径不动）
      const w4Bind = await api('POST', `/api/agents/${w4Agent.id}/bindings`, { token: admin, body: { userId: devUserId } })
      check('W4：夹具——dev 绑定为该 Agent 绑定真人（既有 bindings 端点）', w4Bind.ok || /已绑定/.test(String(w4Bind.error?.message ?? '')), JSON.stringify(w4Bind.error ?? {}))
      const w4Bound = await rawReq('POST', '/api/usage/feedback', {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${w4Cc.data.token}`, 'x-on-behalf-user': devUserId },
        body: JSON.stringify({ resource: `agent:${w4Agent.id}`, messageId: 'w4-bound-1', score: 'up', note: 'W4 绑定真人通道' }),
      })
      check('W4：OBO 指向绑定真人（dev）→ 200 且零价快照口径不变（nonbillable）',
        w4Bound.status === 200 && jsonBody(w4Bound)?.data?.nonbillable === true, JSON.stringify({ status: w4Bound.status, body: jsonBody(w4Bound) }))
      // ③ OBO 指向不存在用户 → 403（归一化两步皆 miss，fail-closed：不可归因到不存在的人）
      const w4Ghost = await rawReq('POST', '/api/usage/feedback', {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${w4Cc.data.token}`, 'x-on-behalf-user': 'w4-ghost-user-nonexist' },
        body: JSON.stringify({ resource: `agent:${w4Agent.id}`, messageId: 'w4-ghost-1', score: 'up' }),
      })
      check('W4：OBO 指向不存在用户 → 403（fail-closed）', w4Ghost.status === 403, String(w4Ghost.status))
    }
  }
  section('错误文案映射完整性（WP-06/C3：枚举全部对外原因码，漏配即红）')
  {
    const errors = await import(new URL('../packages/plugin-console/public/js/errors.js', import.meta.url).href)
    const REQUIRED = ['nas-authz-deny', 'breaker-open', 'quota-exhausted', 'pdp-unreachable', 'degraded', 'binding-invalid', 'invoke-error']
    const missing = REQUIRED.filter((code) => !errors.ERROR_CODES.includes(code))
    check('文案：定版六条原因码 + 会话侧兜底码全部在册', missing.length === 0, `缺失：${missing.join(', ')}`)
    // 全集比对（REFACTOR-2026-10-13 阶段 2）：实时扫描后端对外原因码——
    // exchange.fail(NNN,'XXX') 大写码 + 内联 error:{code:'XXX'} 载荷，
    // 断言 后端原因码全集 ⊆ ERROR_CODES ∪ BINDING_REASONS（新增码未同步 errors.js 即红）。
    const backendCodes = new Set()
    const walkSrc = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walkSrc(join(dir, entry.name)) : [join(dir, entry.name)])
    for (const pkg of readdirSync(join(process.cwd(), 'packages'), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const srcDir = join(process.cwd(), 'packages', pkg.name, 'src')
      if (!existsSync(srcDir)) continue
      for (const file of walkSrc(srcDir)) {
        if (!/\.(ts|m?js)$/.test(file) || /\.test\.(ts|mjs)$/.test(file)) continue
        const text = readFileSync(file, 'utf8')
        for (const match of text.matchAll(/fail\(\s*\d{3}\s*,\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) backendCodes.add(match[1])
        for (const match of text.matchAll(/error:\s*\{\s*code:\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) backendCodes.add(match[1])
      }
    }
    const covered = new Set([...errors.ERROR_CODES, ...errors.BINDING_REASONS])
    const unmapped = [...backendCodes].filter((code) => !covered.has(code))
    check(`文案：后端对外原因码全集 ⊆ ERROR_CODES ∪ BINDING_REASONS（扫描到 ${backendCodes.size} 条，漏配即红）`,
      backendCodes.size >= 30 && unmapped.length === 0,
      unmapped.length ? `未配文案：${unmapped.join(', ')}` : `全集 ${backendCodes.size} 条在册`)
    const blank = errors.ERROR_CODES.filter((code) => {
      const copy = errors.errorCopy(code)
      return !copy.title || !copy.message || (copy.action ? !copy.action.label || !copy.action.href : false)
    })
    check('文案：每条原因码均有标题/正文/行动按钮（无空文案）', blank.length === 0, `空配：${blank.join(', ')}`)
    const bindingDetail = errors.errorCopy('binding-invalid', 'account_inactive')
    check('文案：绑定失效细分原因出可读补充（冻结/离职联动语义）',
      bindingDetail.message.includes('账号状态'), JSON.stringify(bindingDetail.message))
    const fallback = errors.errorCopy('no-such-code-xyz')
    check('文案：未知原因码回落通用兜底（永不裸奔技术错误）', fallback.title.includes('无法完成') || fallback.title.length > 0)
    check('文案：绑定细分原因码在册（no_cookie/expired/account_inactive）',
      ['no_cookie', 'expired', 'account_inactive'].every((reason) => errors.BINDING_REASONS.includes(reason)))
  }
  section('四态状态源映射（WP-06/C2：rq-card 纯函数，状态输入 → UI 态输出）')
  {
    const stateMod = await import(new URL('../packages/plugin-rq-card/src/client/state.ts', import.meta.url).href)
    const derive = stateMod.deriveExecutionState
    check('四态：调用中（invoke 发起中 → calling，骨架可取消）', derive({ invokePhase: 'calling', hasResult: false, resultIsError: false }).state === 'calling')
    check('四态：执行中（healthy + 无结果 → executing）', derive({ invokePhase: 'idle', hasResult: false, resultIsError: false, healthStatus: 'healthy' }).state === 'executing')
    check('四态：执行中 degraded 附「有点慢」（degraded:true 附加信息）', (() => {
      const result = derive({ invokePhase: 'idle', hasResult: false, resultIsError: false, healthStatus: 'degraded' })
      return result.state === 'executing' && result.degraded === true
    })())
    check('四态：已完成（调用返回 + 非 error → done，呈现 👍/👎）', derive({ invokePhase: 'idle', hasResult: true, resultIsError: false }).state === 'done')
    check('四态：异常阻断优先级（authzDenied > quotaExceeded > pdpUnreachable > breakerOpen > down）',
      derive({ invokePhase: 'idle', hasResult: true, resultIsError: false, authzDenied: true, quotaExceeded: true, breakerOpen: true, healthStatus: 'down' }).reason === 'nas-authz-deny'
      && derive({ invokePhase: 'idle', hasResult: false, resultIsError: false, quotaExceeded: true, breakerOpen: true, healthStatus: 'down' }).reason === 'quota-exhausted'
      && derive({ invokePhase: 'idle', hasResult: false, resultIsError: false, breakerOpen: true, healthStatus: 'down' }).reason === 'breaker-open'
      && derive({ invokePhase: 'idle', hasResult: false, resultIsError: false, healthStatus: 'down' }).reason === 'down')
    check('四态：阻断 fail-safe 优先于完成态（历史结果不误导当前可用性）',
      derive({ invokePhase: 'idle', hasResult: true, resultIsError: false, breakerOpen: true }).state === 'blocked')
    check('四态：工具报错兜底第七码 invoke-error（errors.js 文案在册）',
      derive({ invokePhase: 'idle', hasResult: true, resultIsError: true }).reason === 'invoke-error')
    check('四态：空闲基态（无结果无调用无健康 → idle）', derive({ invokePhase: 'idle', hasResult: false, resultIsError: false }).state === 'idle')
    // 随包自证单测（测试随包走，不欠账）
    const stateTest = spawn(process.execPath, ['packages/plugin-rq-card/src/client/state.test.mjs'], { stdio: 'pipe' })
    await new Promise((resolve) => stateTest.on('close', resolve))
    check('四态：rq-card 随包单测全绿（node --test）', stateTest.exitCode === 0, `exit=${stateTest.exitCode}`)
  }

  // ================================================================ 组5 内核：yaml 序列项 + 前端命令面板路由索引
  section('yaml 序列解析（组5 E-05：冒号后无空白的序列项保持标量）')
  {
    const parsedTimeSeq = platformCore.parseYaml('- 12:34:56\n- 08:30:00\n- 普通标量\n')
    check('yaml：parseSeq 时间串「12:34:56」保持标量（不再误判映射后 [object Object]）',
      Array.isArray(parsedTimeSeq) && parsedTimeSeq[0] === '12:34:56' && parsedTimeSeq[1] === '08:30:00' && parsedTimeSeq[2] === '普通标量',
      JSON.stringify(parsedTimeSeq))
    const parsedMapSeq = platformCore.parseYaml('- name: 现场复核\n  actorType: human\n')
    check('yaml：序列内映射项解析不受影响（冒号后带空白仍为键）',
      Array.isArray(parsedMapSeq) && parsedMapSeq[0]?.name === '现场复核' && parsedMapSeq[0]?.actorType === 'human',
      JSON.stringify(parsedMapSeq))
  }
  section('前端命令面板路由索引（cmdk 页面索引 + IA 收敛）')
  {
    const cmdkSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-console', 'public', 'js', 'cmdk.js'), 'utf8')
    const requiredHashes = ['#/nas', '#/nas-authz', '#/finops', '#/connectors', '#/connections', '#/exec', '#/a2a']
    const missingHashes = requiredHashes.filter((hash) => !cmdkSrc.includes(`hash: '${hash}'`))
    check('前端：cmdk 静态索引含 NAS/数据权限/财务视图/连接器/宿主连接/执行中枢/A2A 路由（缺一即红）',
      missingHashes.length === 0, `缺失：${missingHashes.join(', ')}`)
    // IA 收敛（2026-10-22）：资产登记入口下线；A2A/UHP 独立成「协作与执行」一级分类，不再挂在资源组
    const appSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-console', 'public', 'js', 'app.js'), 'utf8')
    const nav = appSrc.slice(appSrc.indexOf('const NAV = ['), appSrc.indexOf('const app = $('))
    const registerGone = !cmdkSrc.includes(`hash: '#/register'`) && !nav.includes(`'#/register'`)
    check('前端 IA：资产登记（#/register）已从导航与命令面板下线', registerGone)
    const collabGroup = nav.slice(nav.indexOf("section: '协作与执行'"), nav.indexOf("section: '治理'"))
    check('前端 IA：「协作与执行」独立一级分类承载 执行中枢 / A2A 协作 / UHP 执行',
      nav.includes("section: '协作与执行'")
      && collabGroup.includes("'#/exec'") && collabGroup.includes("'#/a2a'") && collabGroup.includes("'#/a2a?tab=uhp'"))
    const resourceGroup = nav.slice(nav.indexOf("section: '资源'"), nav.indexOf("section: '协作与执行'"))
    check('前端 IA：A2A 与数据权限已不在资源组（A2A 迁协作与执行、数据权限迁治理）',
      !resourceGroup.includes("'#/a2a") && !resourceGroup.includes("'#/nas-authz'"))
    const governGroup = nav.slice(nav.indexOf("section: '治理'"), nav.indexOf("section: '企业'"))
    check('前端 IA：数据权限（#/nas-authz）归入治理分类', governGroup.includes("'#/nas-authz'"))
  }

  // ================================================================ 交接 F 清单 M 节：scenegraph 校验器口径对齐原文
  section('场景图谱校验器（F 清单 M 节：8 类价值标签 / tags 可空 / links 可选，既有包零改动兼容）')
  {
    const sg = await import(new URL('../packages/platform-core/src/scenegraph.ts', import.meta.url).href)
    const baseScene = (overrides = {}) => ({
      code: 'TST01-A-1-1', name: '测试场景', type: '主场景', s: 3, tags: ['降本'], pain: '痛点',
      tools: ['t'], models: ['m'], data: ['d'], talent: ['p'], ...overrides,
    })
    const packOf = (scene, extra = {}) => ({
      code: 'TST01', name: '测试行业', icon: '🧪', version: 'v1', chains: '测试链',
      activities: { mfg: [scene] }, ...extra,
    })
    const errorsOf = (pack) => sg.validateScenegraph(pack, 'm节自测')
    check('M：原文口径标签 增收/安全/环保 入白名单（8 类=原文 7 类+节能兼容保留）',
      errorsOf(packOf(baseScene({ tags: ['增收', '安全', '环保'] }))).length === 0
      && errorsOf(packOf(baseScene({ tags: ['节能'] }))).length === 0
      && sg.SCENE_TAGS.length === 8, JSON.stringify(sg.SCENE_TAGS))
    check('M：词表外标签仍被拒', errorsOf(packOf(baseScene({ tags: ['虚构标签'] }))).some((line) => line.includes('tags 非法')))
    check('M：tags 空数组放行（原文未标注场景如实装载，不造假标签）',
      errorsOf(packOf(baseScene({ tags: [] }))).length === 0)
    check('M：tags 缺位（非数组）仍被拒', errorsOf(packOf(baseScene({ tags: undefined }))).some((line) => line.includes('tags 非法')))
    check('M：links 可选字段零校验负担（带环节链的包零错误，既有包无需改动）',
      errorsOf(packOf(baseScene(), { links: [{ key: 'A', name: '铁前' }, { key: 'B', name: '炼铁' }] })).length === 0)
  }

  // ================================================================ 第 3 步：契约五面 / 事件源校验 / L0 市场

  // ================================================================ 第 3 步：契约五面 / 事件源校验 / L0 市场
  section('第 3 步：契约五面 / 事件源校验 / 代理 ctx / L0 市场')

  const sandbox = await api('POST', '/api/market/sandbox-check', { token: admin, body: {} })
  const sb = sandbox.data?.results ?? {}
  check('代理 ctx：自有命名空间事件放行', sb.emitOwnNamespace === 'ok')
  check('代理 ctx：平台事件被拦（前缀强制）', sb.emitPlatformViaProxy === 'blocked')
  check('总线：plugin 来源直发保留命名空间被拦', sb.directEmitReserved === 'blocked')
  check('总线：plugin 命名空间无来源被拦', sb.pluginEventWithoutSource === 'blocked')
  check('代理 ctx：未授权服务访问被拦（能力裁剪）', sb.serviceWithoutCapability === 'blocked')
  check('代理 ctx：授权能力内服务放行', sb.serviceWithCapability === 'ok')

  const { generateKeyPairSync, createHash, sign: edSign } = await import('node:crypto')
  const devKeys = generateKeyPairSync('ed25519')
  const devPub = devKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const devReg = await api('POST', '/api/market/developers/register', { body: { username: 'acme-dev', displayName: '磁姆开发者', email: 'dev@acme.com', password: 'Acme@20260', publicKey: devPub, company: '磁姆科技', payoutAccount: '待登记（资金通道依赖清单）' } })
  check('开发者注册（Ed25519 发布者公钥）', devReg.ok && devReg.data.developer.username === 'acme-dev')
  const devPortalLogin = await api('POST', '/api/market/developers/login', { body: { username: 'acme-dev', password: 'Acme@20260' } })
  check('开发者登录（独立身份域）', devPortalLogin.ok && devPortalLogin.data.token.startsWith('dst1.'))
  const devToken2 = devPortalLogin.data.token
  const devBadLogin = await api('POST', '/api/market/developers/login', { body: { username: 'acme-dev', password: 'wrong-pass' } })
  check('开发者密码错误被拒', devBadLogin.status === 401)
  // 组3：registerDeveloper 前置校验补齐——缺 password/displayName 落 400 中文文案（非 500/裸 TypeError）
  const regNoPassword = await api('POST', '/api/market/developers/register', { body: { username: 'pwless-dev', displayName: '缺口令开发者', email: 'pwless@acme.com', publicKey: devPub } })
  check('开发者注册缺 password → 400 中文文案（密码至少 8 位）',
    regNoPassword.status === 400 && /密码/.test(regNoPassword.error?.message ?? ''), `${regNoPassword.status} ${JSON.stringify(regNoPassword.error)}`)
  const regNoDisplayName = await api('POST', '/api/market/developers/register', { body: { username: 'noname-dev', email: 'noname@acme.com', password: 'Acme@20260', publicKey: devPub } })
  check('开发者注册缺 displayName → 400 中文文案（显示名必填）',
    regNoDisplayName.status === 400 && /显示名/.test(regNoDisplayName.error?.message ?? ''), `${regNoDisplayName.status} ${JSON.stringify(regNoDisplayName.error)}`)

  const pluginYaml = (opts = {}) => [
    `id: ${opts.id ?? 'com.acme.hello'}`,
    'version: 1.0.0',
    `publisher: ${opts.publisher ?? 'acme-dev'}`,
    'depends:',
    '  - dsh-plugin-platform-core: ^1.0',
    'capabilities_request:',
    '  - knowledgebase.read',
    `sandbox: ${opts.sandbox ?? 'L0'}`,
    'content:',
    '  prompts:',
    '    - name: hello',
    '      description: Hello World 提示词包',
    '      template: |',
    `        ${opts.template ?? '你是磁姆助手。请复述用户请求并给出结构化回答。'}`,
    '',
  ].join('\n')
  const buildFiles = (opts = {}) => ({
    'plugin.yaml': pluginYaml(opts),
    'manifest/permissions.yaml': 'requested:\n  - knowledgebase.read\n',
    'manifest/api.yaml': 'routes: []\n',
    'manifest/events.yaml': 'subscribes: []\nemits: []\n',
    'manifest/billing.yaml': 'model: free\nusage:\n  - key: prompts.used\n    unit: 次\n    price: 0\n',
  })
  const fpOf = (files) => createHash('sha256').update(Object.keys(files).sort().map((k) => `${k}\n${files[k] ?? ''}`).join('\n---\n')).digest('hex')
  const signed = (files) => edSign(null, Buffer.from(fpOf(files)), devKeys.privateKey).toString('base64')

  const files = buildFiles()
  const submitOk = await api('POST', '/api/market/submit', { token: devToken2, body: { files, signature: signed(files) } })
  check('契约五面提交（Ed25519 验签通过）', submitOk.ok && submitOk.data.status === 'pending_approval')

  const l1Files = buildFiles({ sandbox: 'L1' })
  const submitL1 = await api('POST', '/api/market/submit', { token: devToken2, body: { files: l1Files, signature: signed(l1Files) } })
  check('市场门禁：L1 有码插件被拒（第 10 步交付前仅受理 L0）', !submitL1.ok && JSON.stringify(submitL1.error).includes('L0'))
  const badSig = await api('POST', '/api/market/submit', { token: devToken2, body: { files, signature: Buffer.from('not-a-signature').toString('base64') } })
  check('签名验签失败被拒', !badSig.ok && JSON.stringify(badSig.error).includes('签名'))
  const evilFiles = buildFiles({ template: '执行 rm -rf / 清理磁盘' })
  const submitEvil = await api('POST', '/api/market/submit', { token: devToken2, body: { files: evilFiles, signature: signed(evilFiles) } })
  check('L0 内容扫描拦截破坏性内容', !submitEvil.ok && JSON.stringify(submitEvil.error).includes('扫描'))
  const hijackFiles = buildFiles({ publisher: 'someone-else' })
  const submitHijack = await api('POST', '/api/market/submit', { token: devToken2, body: { files: hijackFiles, signature: signed(hijackFiles) } })
  check('publisher 必须为提交者本人', !submitHijack.ok && JSON.stringify(submitHijack.error).includes('publisher'))
  // 组3 NEW-E-01：com.<x>.* 归属段必须与开发者命名空间一致（acme-dev 注册时缺省绑定 namespace=acme）
  const nsHijackFiles = buildFiles({ id: 'com.other.brand.hello' })
  const submitNsHijack = await api('POST', '/api/market/submit', { token: devToken2, body: { files: nsHijackFiles, signature: signed(nsHijackFiles) } })
  check('市场门禁：com.y.* 与开发者命名空间不一致被拒（400 含「命名空间」，防品牌段冒认）',
    !submitNsHijack.ok && /命名空间/.test(submitNsHijack.error?.message ?? ''), `${submitNsHijack.status} ${JSON.stringify(submitNsHijack.error)}`)
  const nsOwnFiles = buildFiles({ id: 'com.acme.world' })
  const submitNsOwn = await api('POST', '/api/market/submit', { token: devToken2, body: { files: nsOwnFiles, signature: signed(nsOwnFiles) } })
  check('市场门禁：com.x.*（自有命名空间）提交正常受理（pending_approval）',
    submitNsOwn.ok && submitNsOwn.data.status === 'pending_approval', JSON.stringify(submitNsOwn.error ?? submitNsOwn.data))

  const approvePlugin = await api('POST', `/api/market/submissions/${submitOk.data.id}/approve`, { token: admin, body: { opinion: '符合上架条件' } })
  check('审批上架', approvePlugin.ok && approvePlugin.data.status === 'listed')
  const installPlugin = await api('POST', '/api/market/plugins/com.acme.hello/install', { token: admin, body: { orgId: tenantOrg.data.id, tenantId: newTenant.data.id, approvedCapabilities: ['knowledgebase.read'] } })
  check('安装（权限确认 + 能力固化）', installPlugin.ok && installPlugin.data.status === 'running')
  const capExceed = await api('POST', '/api/market/plugins/com.acme.hello/install', { token: admin, body: { orgId: newOrg.data.id, approvedCapabilities: ['model-gateway.invoke'] } })
  check('越权能力安装被拒（approved ⊆ requested）', !capExceed.ok && JSON.stringify(capExceed.error).includes('请求清单'))
  const permExceed = await api('POST', '/api/market/plugins/com.acme.hello/install', { token: admin, body: { orgId: newOrg.data.id, approvedCapabilities: ['knowledgebase.read'], approvedPermissions: ['usage.admin'] } })
  check('越权权限安装被拒（QA E-02：approvedPermissions ⊆ requested）', !permExceed.ok && /申请清单/.test(permExceed.error?.message ?? ''), JSON.stringify(permExceed.error ?? {}))
  const permOkInstall = await api('POST', '/api/market/plugins/com.acme.hello/install', { token: admin, body: { orgId: newOrg.data.id, approvedCapabilities: ['knowledgebase.read'], approvedPermissions: ['knowledgebase.read'] } })
  check('权限范围内安装通过（QA E-02 正向）', permOkInstall.ok && permOkInstall.data.status === 'running', JSON.stringify(permOkInstall.error ?? {}))

  const prompts = await api('GET', '/api/market/prompts?orgId=' + tenantOrg.data.id, { token: admin })
  check('L0 运行时：提示词包可取用', prompts.ok && prompts.data.prompts.length >= 1 && prompts.data.prompts[0].template.includes('磁姆助手'))
  const usePrompt = await api('POST', '/api/market/prompts/use', { token: admin, body: { orgId: tenantOrg.data.id, pluginId: 'com.acme.hello', promptName: 'hello' } })
  check('L0 计量：提示词取用产生 usage 事件（L3）', usePrompt.ok)
  const pluginUsage = await api('GET', '/api/usage/events?principal=' + encodeURIComponent('plugin:com.acme.hello'), { token: admin })
  check('插件计量入账（meter key 来自 billing.yaml 声明，金额零价快照）', pluginUsage.ok && pluginUsage.data.total >= 1 && pluginUsage.data.items[0].pricing.charge_cents === 0 && pluginUsage.data.items[0].pricing.rate?.nonbillable === true && pluginUsage.data.items[0].tenant_id === newTenant.data.id)
  // 组3：meterPromptUse 幂等键 plugin-use:installId:subject:promptName:UTC分钟窗——同分钟重放不重复计量
  {
    const useTotalBefore = (await api('GET', '/api/usage/events?resource=' + encodeURIComponent('plugin:com.acme.hello') + '&limit=1', { token: admin })).data.total
    const useReplay1 = await api('POST', '/api/market/prompts/use', { token: admin, body: { orgId: tenantOrg.data.id, pluginId: 'com.acme.hello', promptName: 'hello' } })
    const useTotalMid = (await api('GET', '/api/usage/events?resource=' + encodeURIComponent('plugin:com.acme.hello') + '&limit=1', { token: admin })).data.total
    const useReplay2 = await api('POST', '/api/market/prompts/use', { token: admin, body: { orgId: tenantOrg.data.id, pluginId: 'com.acme.hello', promptName: 'hello' } })
    const useTotalAfter = (await api('GET', '/api/usage/events?resource=' + encodeURIComponent('plugin:com.acme.hello') + '&limit=1', { token: admin })).data.total
    check('L0 计量：同 UTC 分钟内重放取用两次 → 该主体 usage 事件恒定不增长（幂等键分钟窗去重）',
      useReplay1.ok && useReplay2.ok && useTotalAfter === useTotalMid && useTotalMid - useTotalBefore <= 1,
      JSON.stringify({ before: useTotalBefore, mid: useTotalMid, after: useTotalAfter, e1: useReplay1.error, e2: useReplay2.error }))
  }

  // app 复合验收（F5 修正：以覆盖面而非复杂度为由）
  const seededApps = (await api('GET', '/api/apps', { token: admin })).data.apps
  const anyApp = seededApps[0]
  const compoundAppDetail = await api('GET', `/api/apps/${anyApp.id}`, { token: admin })
  const chainTotals = await api('GET', '/api/usage/totals', { token: admin })
  check('app 复合验收：拓扑 + 成本穿透 + 计量管道三链齐备', compoundAppDetail.ok && compoundAppDetail.data.topology.children.length >= 1 && compoundAppDetail.data.cost.length >= 1 && chainTotals.ok && chainTotals.data.count >= 2, JSON.stringify({ app: compoundAppDetail.ok ? { topo: compoundAppDetail.data.topology.children.length, cost: compoundAppDetail.data.cost.length } : compoundAppDetail, totals: chainTotals }))

  // 应用指标主动上报（接入方 → 宿主的推送通道：REST / 工具 / CLI 同一契约）
  const reportDate = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
  const sessionsBefore = (await api('GET', `/api/apps/${anyApp.id}`, { token: admin })).data.metrics.sessions
  const appReport = await api('POST', `/api/apps/${anyApp.id}/metrics-report`, { token: admin, body: { dau: 777, sessions: 1234, avgDepth: 3.5, retention7: 0.42 } })
  check('应用指标上报端点写入成功（DAU/留存即生效）', appReport.ok && appReport.data.dau >= 777 && appReport.data.retention7 === 0.42)
  const appReportBackfill = await api('POST', `/api/apps/${anyApp.id}/metrics-report`, { token: admin, body: { date: reportDate, dau: 100, sessions: 200 } })
  check('应用指标可指定日期补录历史（同日已有记录则会话累加）', appReportBackfill.ok && appReportBackfill.data.sessions === sessionsBefore + 1234 + 200 && appReportBackfill.data.series.some((row) => row.date === reportDate))
  const appReportBadDate = await api('POST', `/api/apps/${anyApp.id}/metrics-report`, { token: admin, body: { date: '2026/07/01', dau: 1 } })
  check('应用指标日期格式非法被拒（400）', appReportBadDate.status === 400)
  const appReportGhost = await api('POST', '/api/apps/app_ghost/metrics-report', { token: admin, body: { dau: 1 } })
  check('不存在应用上报被拒（400）', appReportGhost.status === 400)
  const appReportDenied = await api('POST', `/api/apps/${anyApp.id}/metrics-report`, { token: auditor, body: { dau: 1 } })
  check('无 app.write 上报应用指标被拒（403）', appReportDenied.status === 403)
  const appReportTool = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'app_metrics_report', args: { appId: anyApp.id, dau: 888 } } })
  check('工具 app_metrics_report 上报（同日 DAU 取最大）', appReportTool.ok && appReportTool.data.isError === false && appReportTool.data.value.reported === true && appReportTool.data.value.metrics.dau === 888)
  const appReportPv = await api('POST', `/api/apps/${anyApp.id}/metrics-report`, { token: admin, body: { pv: 500, uv: 260, dau: 800 } })
  check('PV/UV 口径上报（首日写入）', appReportPv.ok && appReportPv.data.pv === 500 && appReportPv.data.uv === 260 && appReportPv.data.dau === 888)
  const appReportPv2 = await api('POST', `/api/apps/${anyApp.id}/metrics-report`, { token: admin, body: { pv: 120, uv: 300 } })
  check('PV 同日累加 / UV 同日取最大（DAU 800 不覆盖 888）', appReportPv2.ok && appReportPv2.data.pv === 620 && appReportPv2.data.uv === 300 && appReportPv2.data.dau === 888)

  // 平台侧指标自动折算（指标口径补全）：浏览器 beacon → PV/UV；entry-ticket 兑换 / OIDC 发码 → DAU
  section('平台侧指标自动折算（beacon PV/UV + SSO 到访 DAU）')
  const autoAppCreate = await api('POST', '/api/apps', { token: admin, body: { name: '指标自动折算验收', attrs: { description: 'beacon PV/UV 与 SSO DAU 自动折算验收', appType: 'web', riskLevel: 'low', dataClass: 'internal' } } })
  check('折算验收应用创建', autoAppCreate.ok && Boolean(autoAppCreate.data?.app?.id), JSON.stringify(autoAppCreate.error))
  const autoAppId = autoAppCreate.data.app.id
  const autoMetrics = async () => (await api('GET', `/api/apps/${autoAppId}`, { token: admin })).data.metrics
  const vidA = 'selftest-vid-aaaa-0903'
  const vidB = 'selftest-vid-bbbb-0903'
  const beaconGif = await rawReq('GET', `/api/apps/beacon?app=${autoAppId}&vid=${vidA}`)
  check('beacon GET 免鉴权：200 + 1x1 GIF + no-store', beaconGif.status === 200 && beaconGif.headers['content-type'].includes('image/gif') && String(beaconGif.headers['cache-control']).includes('no-store') && beaconGif.body.startsWith('GIF8'), JSON.stringify({ status: beaconGif.status, ct: beaconGif.headers['content-type'] }))
  await rawReq('GET', `/api/apps/beacon?app=${autoAppId}&vid=${vidA}`)
  await rawReq('GET', `/api/apps/beacon?app=${autoAppId}&vid=${vidB}`)
  await rawReq('POST', '/api/apps/beacon', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: autoAppId, vid: vidA }) })
  const beaconMetrics = await autoMetrics()
  check('beacon PV 逐次累加 / UV 按 vid 去重（4 次上报 → pv=4 uv=2 dau=0）', beaconMetrics.pv === 4 && beaconMetrics.uv === 2 && beaconMetrics.dau === 0, JSON.stringify(beaconMetrics))
  const ghostBeacon = await rawReq('GET', '/api/apps/beacon?app=app_ghost&vid=selftest-vid-cccc-0903')
  check('未知应用 beacon 恒 200 GIF（不泄露应用存在性）', ghostBeacon.status === 200 && ghostBeacon.body === beaconGif.body && ghostBeacon.headers['content-type'] === beaconGif.headers['content-type'])
  const autoTicket = await api('POST', `/api/apps/${autoAppId}/entry-ticket`, { token: admin, body: {} })
  const autoRedeem = await rawReq('POST', '/api/authn/entry-tickets/redeem', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: autoTicket.data.ticket }) })
  check('entry-ticket 兑换 200（公开端点）', autoRedeem.status === 200)
  const afterTicket = await autoMetrics()
  check('entry-ticket 兑换自动折算 DAU（admin 新访客 → dau=1 uv=3）', afterTicket.dau === 1 && afterTicket.uv === 3 && afterTicket.pv === 4, JSON.stringify(afterTicket))
  const autoSso = await api('POST', `/api/apps/${autoAppId}/sso-client`, { token: admin, body: { redirectUris: ['https://auto-check.example/cb'], consentRequired: false } })
  check('折算验收应用自助签发 SSO 客户端', autoSso.ok && autoSso.data.clientId.startsWith('oc-'), JSON.stringify(autoSso.error))
  const autoVerifier = 'selftest-auto-pkce-verifier-43-chars-aaaaaaaaaa'
  const autoFirst = await rawReq('GET', `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: autoSso.data.clientId, redirect_uri: 'https://auto-check.example/cb', state: 'st-auto', scope: 'openid profile', code_challenge: createHash('sha256').update(autoVerifier).digest('base64url'), code_challenge_method: 'S256' }).toString()}`)
  const autoReqId = new URLSearchParams(String(autoFirst.headers.location).split('?')[1] ?? '').get('req')
  const autoApprove = await authorizeConfirm(auditor, autoReqId, true)
  check('OIDC 授权确认发码（auditor human）', autoApprove.status === 200 && String(autoApprove.result.location).includes('code='), JSON.stringify(autoApprove.result))
  const afterOidc = await autoMetrics()
  check('OIDC 发码自动折算 DAU（auditor 新访客 → dau=2 uv=4）', afterOidc.dau === 2 && afterOidc.uv === 4, JSON.stringify(afterOidc))

  // dshctl plugin init 脚手架（真实生成文件）
  const { execFile } = await import('node:child_process')
  const scaffoldDir = join(DATA_DIR, 'scaffold-plugin')
  await new Promise((resolve) => execFile(process.execPath, ['cli/dshctl.mjs', 'plugin', 'init', '--id=com.selftest.scaffold', `--dir=${scaffoldDir}`], { cwd: process.cwd() }, (error) => { void error; resolve() }))
  const { existsSync: existsFile, readFileSync: scaffoldRead } = await import('node:fs')
  const SCAFFOLD_FILES = ['plugin.yaml', 'manifest/permissions.yaml', 'manifest/api.yaml', 'manifest/events.yaml', 'manifest/billing.yaml']
  check('dshctl plugin init 脚手架五面生成', SCAFFOLD_FILES.every((f) => existsFile(join(scaffoldDir, f))))
  const scaffoldYaml = existsFile(join(scaffoldDir, 'plugin.yaml')) ? scaffoldRead(join(scaffoldDir, 'plugin.yaml'), 'utf8') : ''
  check('脚手架默认 L0 + Hello World + 发布者密钥对', scaffoldYaml.includes('sandbox: L0') && scaffoldYaml.includes('hello') && existsFile(join(scaffoldDir, 'publisher-private-key.pem')))

  // ================================================================ 第 5 步：模型接入网关（M0-3 用量透明计量）
  section('第 5 步：模型接入网关（真实转发 / 零价快照计量 / 内部成本参考）')

  // OpenAI 兼容真实 stub
  const modelStub = createServer(async (req, res) => {
    if (req.url.endsWith('/chat/completions')) {
      await readBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '你好，这是来自真实模型 stub 的回答。' } }],
        usage: { prompt_tokens: 120, completion_tokens: 1500 },
      }))
      return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise((resolve) => modelStub.listen(0, '127.0.0.1', resolve))
  const modelPort = modelStub.address().port

  const noEndpointModel = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'ghost-model', endpoint: '' } })
  const ghostInvoke = await api('POST', '/api/modelgw/invoke', { token: admin, body: { model: 'ghost-model', messages: [{ role: 'user', content: 'hi' }], orgId: tenantOrg.data.id } })
  check('未配置 endpoint 的模型拒绝调用（不生成假 completion）', noEndpointModel.ok && !ghostInvoke.ok && JSON.stringify(ghostInvoke.error).includes('endpoint'))

  const modelReg = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'ds-stub', displayName: 'DeepSeek（stub 验证）', provider: 'deepseek', endpoint: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'stub-key', costCentsPerKTokens: 5 } })
  check('模型目录登记（价格簿自动登记：零价 + 内部成本参考）', modelReg.ok)

  const modelInvoke = await api('POST', '/api/modelgw/invoke', { token: admin, body: { model: 'ds-stub', messages: [{ role: 'user', content: '真实链路测试' }], orgId: tenantOrg.data.id } })
  check('模型调用真实往返 + 实测 tokens 计量', modelInvoke.ok && modelInvoke.data.content.includes('真实模型') && modelInvoke.data.inputTokens === 120 && modelInvoke.data.outputTokens === 1500)
  check('内部成本参考折算（1500 tokens × 5分/千 = 8 分；charge 恒 0）', modelInvoke.ok && modelInvoke.data.costCents === 8, JSON.stringify(modelInvoke))

  const modelUsageEvents = await api('GET', '/api/usage/events?resource=model:ds-stub', { token: admin })
  check('模型计量事件含 input/output meters + 租户维度', modelUsageEvents.ok && modelUsageEvents.data.total >= 1 && modelUsageEvents.data.items[0].meters.length === 2 && modelUsageEvents.data.items[0].tenant_id === newTenant.data.id)

  // M0-3 口径：模型网关事件为零价快照（charge=0），无余额/预算闸
  const modelGwEvent = await api('GET', '/api/usage/events?resource=model:ds-stub', { token: admin })
  check('模型网关事件零价快照（charge=0 / cost=8）', modelGwEvent.ok && modelGwEvent.data.items[0].pricing.charge_cents === 0 && modelGwEvent.data.items[0].pricing.cost_cents === 8, JSON.stringify(modelGwEvent.data?.items?.[0]?.pricing))
  const billingRechargeGone = await api('POST', '/api/billing/recharge', { token: admin, body: {} })
  check('充值端点已随 M0-2 下线（404）', billingRechargeGone.status === 404)

  // #14（2026-10-29）：input/output 双米组合计价——模型目录登记输入费率，usage 写入时按行计价求和
  const modelRegIo = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'ds-stub-io', displayName: '双米计价验证', provider: 'deepseek', endpoint: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'stub-key', costCentsPerKTokens: 5, inputCostCentsPerKTokens: 50 } })
  const modelInvokeIo = await api('POST', '/api/modelgw/invoke', { token: admin, body: { model: 'ds-stub-io', messages: [{ role: 'user', content: '双米计价' }], orgId: tenantOrg.data.id } })
  check('#14：input/output 组合计价（output 1500×5分/千=8 + input 120×50分/千=6 → 14 分）',
    modelRegIo.ok && modelInvokeIo.ok && modelInvokeIo.data.costCents === 14, JSON.stringify(modelInvokeIo.data ?? modelInvokeIo.error))
  const modelIoPricing = (await api('GET', '/api/usage/events?resource=model:ds-stub-io', { token: admin })).data.items[0].pricing
  check('#14：快照留痕组合计价行（rate.line_items 双行，费率非零取整为 0 仍算 priced）',
    Array.isArray(modelIoPricing.rate?.line_items) && modelIoPricing.rate.line_items.length === 2 && modelIoPricing.cost_cents === 14,
    JSON.stringify(modelIoPricing))
  const summaryNotPriced = await api('GET', '/api/usage/summary?window=today', { token: admin })
  check('#14：summary 暴露未定价覆盖率（not_priced_events；零费率事件不再与「真零成本」混读）',
    summaryNotPriced.ok && Number.isFinite(summaryNotPriced.data.not_priced_events),
    JSON.stringify(summaryNotPriced.data?.not_priced_events))
  const costRowsCoverage = await api('GET', '/api/audit/cost?groupBy=agent', { token: admin })
  check('#14：成本报表携带 priced/notPriced 覆盖率（门禁判断「成本是否可归集」）',
    costRowsCoverage.ok && costRowsCoverage.data.rows.length >= 1 && costRowsCoverage.data.rows.every((row) => Number.isFinite(row.priced) && Number.isFinite(row.notPriced)),
    JSON.stringify(costRowsCoverage.data?.rows?.[0]))
  // #17（2026-10-29）：组织归属 fail-fast——orgId 空串在调用上游前拒绝（先校验后花钱，
  // 不再「模型已应答、计量抛错」导致该次成本未入账）
  const noOrgInvoke = await api('POST', '/api/modelgw/invoke', { token: admin, body: { model: 'ds-stub', messages: [{ role: 'user', content: '#17' }], orgId: '' } })
  check('#17：orgId 空串在调用上游前 fail-fast（不再「先花钱后报错」）',
    !noOrgInvoke.ok && /(归口组织|组织归属)/.test(JSON.stringify(noOrgInvoke.error ?? {})), JSON.stringify(noOrgInvoke.error))
  modelStub.close()

  // #14 复核（2026-10-29）：存量事件覆盖率盲区——覆盖率标注字段引入前入账的事件无
  // cost_status/nonbillable，此前 summary 的 not_priced 只认标注 → 存量零费率事件
  //「既非 priced 也非 notPriced」（复核实测 priced=0/notPriced=0）。现读侧按零费率
  // 快照（rate.list=0 且 rate.cost=0）识别存量事件，免一次性迁移；费率在配但量小
  // 取整为 0（rate.cost>0）仍算 priced。进程内最小装配直测 summary SQL 两个分支。
  section('#14 复核：存量零费率事件读侧识别（进程内最小装配）')
  {
    const legacyCtx = new Context()
    await legacyCtx.plugin(platformCore, { dataDir: join(DATA_DIR, 'legacy-pricing'), startHttp: false })
    await legacyCtx.plugin(resourceCore)
    await legacyCtx.plugin(iam)
    await legacyCtx.plugin(usage)
    legacyCtx.usage.upsertPrice({ pattern: 'model:legacy-zero', meter_key: 'tokens', list_cents_per_unit: 0, cost_cents_per_unit: 0, units_per_step: 1000, tax_rate: 0, currency: 'CNY', rate_version: 'legacy-zero-v1' })
    legacyCtx.usage.upsertPrice({ pattern: 'model:legacy-round', meter_key: 'tokens', list_cents_per_unit: 0, cost_cents_per_unit: 1, units_per_step: 1000, tax_rate: 0, currency: 'CNY', rate_version: 'legacy-round-v1' })
    const legacyRecord = (resource, tokens, idem) => legacyCtx.usage.record({
      org: 'legacy-org', subject: 'agent:legacy-a', principal: 'org:legacy-org',
      resource, meters: [{ key: 'tokens', value: tokens, unit: 'token' }], idempotency_key: idem,
    })
    // 全零费率事件（现行代码会带标注；随后手工剥掉标注模拟「升级前入账」的存量行）
    legacyRecord('model:legacy-zero', 1000, 'legacy-zero-1')
    const zeroRow = legacyCtx.txnStore.one('usage_events', { idempotency_key: 'legacy-zero-1' })
    const strippedPricing = JSON.parse(zeroRow.pricing_json)
    delete strippedPricing.cost_status
    delete strippedPricing.rate.nonbillable
    check('前置：存量形态模拟（剥掉 cost_status/nonbillable 后无标注可认）',
      strippedPricing.cost_status === undefined && strippedPricing.rate.nonbillable === undefined && strippedPricing.cost_cents === 0)
    legacyCtx.txnStore.run('UPDATE usage_events SET pricing_json = ? WHERE idempotency_key = ?', [JSON.stringify(strippedPricing), 'legacy-zero-1'])
    // 费率在配但量小取整为 0（400 tokens × 1分/千 → round 0.4 = 0）：有费率在配，算 priced
    const roundEvent = legacyRecord('model:legacy-round', 400, 'legacy-round-1')
    const legacySummary = legacyCtx.usage.summary({ from: '2020-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' })
    const zeroSummaryRow = legacySummary.byResource.find((row) => row.resource === 'model:legacy-zero')
    const roundSummaryRow = legacySummary.byResource.find((row) => row.resource === 'model:legacy-round')
    check('#14 复核：存量零费率快照（无标注）被识别为 not_priced（免迁移）',
      zeroSummaryRow?.not_priced_events === 1 && zeroSummaryRow?.events === 1,
      JSON.stringify(zeroSummaryRow))
    check('#14 复核：费率在配但量小取整为 0 仍算 priced（不与「未定价」混读）',
      roundSummaryRow?.events === 1 && roundSummaryRow?.not_priced_events === 0 && roundEvent.pricing.cost_cents === 0,
      JSON.stringify(roundSummaryRow))
  }

  // ================================================================ 第 6 步：OIDC Provider（浏览器授权流 / 协议合规）
  section('第 6 步：OIDC Provider（浏览器授权流 / RS256 / 协议合规）')
  const discovery = await rawReq('GET', '/.well-known/openid-configuration')
  const disco = jsonBody(discovery)
  check('OIDC 发现文档暴露（jwks_uri / 端点 / RS256）', discovery.status === 200 && disco.jwks_uri.includes('/.well-known/jwks.json') && disco.id_token_signing_alg_values_supported.includes('RS256'))
  check('发现文档协议面（email scope / Basic+Post 双认证 / refresh+revoke+end_session）',
    disco.scopes_supported.includes('email')
    && disco.token_endpoint_auth_methods_supported.includes('client_secret_basic')
    && disco.token_endpoint_auth_methods_supported.includes('client_secret_post')
    && disco.grant_types_supported.includes('refresh_token')
    && Boolean(disco.revocation_endpoint) && Boolean(disco.end_session_endpoint))
  const jwks = jsonBody(await rawReq('GET', '/.well-known/jwks.json'))
  check('JWKS 数组化公钥（kid/kty/n）', Array.isArray(jwks.keys) && jwks.keys[0].kty === 'RSA' && jwks.keys[0].kid.length === 16 && Boolean(jwks.keys[0].n))

  // #15（2026-10-29）：issuer 按请求 Host/X-Forwarded-* 派生（OIDC_ISSUER 显式声明仍最高优先）——
  // 公网域名反代部署时 discovery/签发/校验自动对齐，远程 SSO 开箱可用（此前恒回落环回地址）
  const discoForwarded = jsonBody(await rawReq('GET', '/.well-known/openid-configuration', { headers: { host: 'ybkkasi.example', 'x-forwarded-proto': 'https' } }))
  check('#15：discovery issuer 按请求 Host/X-Forwarded-Proto 派生（公网域名部署语义）',
    discoForwarded.issuer === 'https://ybkkasi.example' && discoForwarded.authorization_endpoint === 'https://ybkkasi.example/oauth/authorize',
    JSON.stringify(discoForwarded.issuer))
  check('#15：同请求面自洽——默认环回请求 issuer 落在本机（discovery/签发/校验同源）',
    disco.issuer === `http://127.0.0.1:${PORT}`,
    JSON.stringify(disco.issuer))
  // P1-06：白名单外伪造 forwarded-host 不再改写 discovery（fail-closed 回落环回）
  const discoForged = jsonBody(await rawReq('GET', '/.well-known/openid-configuration', { headers: { host: '127.0.0.1', 'x-forwarded-host': 'evil.example' } }))
  check('P1-06：白名单外 x-forwarded-host 不改写 issuer（回落本机，防伪造头投毒）',
    discoForged.issuer === `http://127.0.0.1:${PORT}`,
    JSON.stringify(discoForged.issuer))

  const oidcClient = await api('POST', '/api/authn/oidc/clients', { token: admin, body: { name: '外部 CRM 应用', redirectUris: ['https://crm.partner.example/cb'], consentRequired: false } })
  check('登记 OIDC 客户端（secret 一次性返回）', oidcClient.ok && oidcClient.data.clientId.startsWith('oc-') && oidcClient.data.clientSecret.startsWith('ocs'))
  const OC = oidcClient.data

  // -- CORS：纯前端（public + PKCE）客户端跨域直调协议端点（允许来源 = 已登记 redirect_uri origin）--
  const corsHit = await rawReq('GET', '/.well-known/openid-configuration', { headers: { origin: 'https://crm.partner.example' } })
  check('discovery 携带 CORS 放行头（origin 命中已登记 redirect_uri）', corsHit.headers['access-control-allow-origin'] === 'https://crm.partner.example' && String(corsHit.headers.vary).includes('Origin'))
  const corsPreflight = await rawReq('OPTIONS', '/oauth/token', { headers: { origin: 'https://crm.partner.example', 'access-control-request-method': 'POST' } })
  check('OPTIONS 预检 → 204 + allow-methods/headers/max-age', corsPreflight.status === 204 && corsPreflight.headers['access-control-allow-origin'] === 'https://crm.partner.example' && String(corsPreflight.headers['access-control-allow-headers']).includes('authorization') && String(corsPreflight.headers['access-control-allow-headers']).includes('content-type'))
  const corsMiss = await rawReq('GET', '/.well-known/openid-configuration', { headers: { origin: 'https://evil.example' } })
  check('未登记来源不发放 allow-origin（仅 vary）', corsMiss.headers['access-control-allow-origin'] === undefined && String(corsMiss.headers.vary).includes('Origin'))
  const corsErrPath = await rawReq('POST', '/oauth/token', { headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://crm.partner.example' }, body: 'grant_type=authorization_code&code=forged' })
  check('错误响应（invalid_client）同样携带放行头（浏览器可读错误体）', corsErrPath.status === 401 && jsonBody(corsErrPath).error === 'invalid_client' && corsErrPath.headers['access-control-allow-origin'] === 'https://crm.partner.example')

  // -- 第一跳校验：任一失败 → 302 平台错误页（绝不携带外部 redirect_uri，防开放重定向）--
  const pkceVerifier = 'selftest-pkce-verifier-43-chars-aaaaaaaaaaaaaa'
  const pkceChallenge = createHash('sha256').update(pkceVerifier).digest('base64url')
  const authorizeQuery = (over = {}) => new URLSearchParams({
    response_type: 'code', client_id: OC.clientId, redirect_uri: 'https://crm.partner.example/cb',
    state: 'st-selftest', scope: 'openid profile email', code_challenge: pkceChallenge, code_challenge_method: 'S256', ...over,
  }).toString()
  const reqIdOf = (raw) => new URLSearchParams(String(raw.headers.location).split('?')[1] ?? '').get('req')

  const badClient = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ client_id: 'oc-forged' })}`)
  check('无效 client_id → 302 平台错误页（Location 不含外部域）', badClient.status === 302 && String(badClient.headers.location).startsWith('/#/oauth/error') && !String(badClient.headers.location).includes('crm.partner.example'))
  const badRedirect = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ redirect_uri: 'https://evil.example/cb' })}`)
  check('redirect_uri 不在白名单 → 平台错误页', badRedirect.status === 302 && String(badRedirect.headers.location).startsWith('/#/oauth/error'))
  const badScope = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ scope: 'openid profile reporting:admin' })}`)
  check('白名单外 scope → invalid_scope 错误页', badScope.status === 302 && decodeURIComponent(String(badScope.headers.location)).includes('invalid_scope'))
  const noPkce = await rawReq('GET', `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: OC.clientId, redirect_uri: 'https://crm.partner.example/cb', state: 'st', scope: 'openid' }).toString()}`)
  check('缺少 PKCE → 错误页（强制 S256）', noPkce.status === 302 && String(noPkce.headers.location).startsWith('/#/oauth/error') && decodeURIComponent(String(noPkce.headers.location)).includes('PKCE'))
  const badResponseType = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ response_type: 'token' })}`)
  check('response_type=token → unsupported_response_type 错误页', badResponseType.status === 302 && decodeURIComponent(String(badResponseType.headers.location)).includes('unsupported_response_type'))

  // -- 合法第一跳：302 平台授权页 + 公开查询不泄露 redirect_uri --
  const goodFirst = await rawReq('GET', `/oauth/authorize?${authorizeQuery()}`)
  check('合法授权请求 → 302 平台授权页（/#/oauth/authorize?req=）', goodFirst.status === 302 && String(goodFirst.headers.location).startsWith('/#/oauth/authorize?req='))
  const reqId = reqIdOf(goodFirst)
  const reqInfo = await authReqInfo(reqId)
  check('授权请求公开查询（客户端名/scope，不泄露 redirect_uri）', reqInfo.status === 200 && reqInfo.info.clientName === '外部 CRM 应用' && reqInfo.info.scope.includes('openid') && !JSON.stringify(reqInfo.info).includes('redirect_uri'))

  // -- 授权确认：机器 403 / human 通过 / 重放、伪造、过期 400 --
  const machineAuthorize = await api('POST', '/api/authn/oidc/authorize', { token: machine, body: { reqId } })
  check('机器身份确认授权被拒（human-only）', machineAuthorize.status === 403)
  const authApprove = await authorizeConfirm(admin, reqId, true)
  check('用户确认授权 → 回跳地址（code/state 原样透传 + iss 防 mix-up）', authApprove.status === 200 && authApprove.result.location.includes('code=') && authApprove.result.location.includes('state=st-selftest') && authApprove.result.location.includes('iss='))
  const replayReq = await authorizeConfirm(admin, reqId, true)
  check('授权请求重放被拒（单次消费）', replayReq.status === 400)
  const forgedReq = await authorizeConfirm(admin, 'forged-req-id')
  check('伪造 reqId 被拒', forgedReq.status === 400)
  const expFirst = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'st-expired' })}`)
  const expReqId = reqIdOf(expFirst)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const expApprove = await authorizeConfirm(admin, expReqId, true)
  check('过期授权请求被拒（TTL 语义）', expApprove.status === 400)

  // -- consent 门禁：未同意 400 / 显式拒绝 access_denied 回跳 / 同意放行 --
  const consentClient = await api('POST', '/api/authn/oidc/clients', { token: admin, body: { name: '需同意的外部门户', redirectUris: ['https://portal.partner.example/cb'], consentRequired: true } })
  check('登记需显式同意的客户端', consentClient.ok)
  const ccFirst = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ client_id: consentClient.data.clientId, redirect_uri: 'https://portal.partner.example/cb', state: 'st-consent' })}`)
  const ccReqId = reqIdOf(ccFirst)
  const ccInfo = await authReqInfo(ccReqId)
  check('consentRequired 状态公开回显', ccInfo.status === 200 && ccInfo.info.consentRequired === true)
  const ccNo = await authorizeConfirm(admin, ccReqId, undefined)
  check('未表达同意 → 400', ccNo.status === 400)
  const ccDeny = await authorizeConfirm(admin, ccReqId, false)
  check('显式拒绝 → access_denied 回跳（拒绝事件留痕）', ccDeny.status === 200 && ccDeny.result.location.includes('error=access_denied'))
  const ccFirst2 = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ client_id: consentClient.data.clientId, redirect_uri: 'https://portal.partner.example/cb', state: 'st-consent2' })}`)
  const ccOk = await authorizeConfirm(admin, reqIdOf(ccFirst2), true)
  check('勾选同意后放行（签发 code）', ccOk.status === 200 && ccOk.result.location.includes('code='))

  // -- 换牌：Basic/Post 双认证 × form/JSON 双编码、PKCE 正误、code 重放、错误码状态码 --
  const basicAuth = Buffer.from(`${OC.clientId}:${OC.clientSecret}`).toString('base64')
  const tokenForm = (extra = {}) => new URLSearchParams({
    grant_type: 'authorization_code', client_id: OC.clientId, client_secret: OC.clientSecret,
    redirect_uri: 'https://crm.partner.example/cb', code_verifier: pkceVerifier, ...extra,
  }).toString()
  const code1 = new URL(authApprove.result.location).searchParams.get('code')
  const tPost = await rawReq('POST', '/oauth/token', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenForm({ code: code1 }) })
  const ts1 = jsonBody(tPost)
  check('code 换令牌（client_secret_post + form 编码）', tPost.status === 200 && ts1.access_token?.split('.').length === 3 && ts1.token_type === 'Bearer')
  check('响应契约（scope 字段 + confidential 客户端附带 refresh_token）', ts1.scope === 'openid profile email' && ts1.refresh_token?.startsWith('otr_'))
  const oidcCodeReplay = await rawReq('POST', '/oauth/token', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenForm({ code: code1 }) })
  check('授权码重放被拒（单次消费 → 400 invalid_grant）', oidcCodeReplay.status === 400 && jsonBody(oidcCodeReplay).error === 'invalid_grant')

  const first2 = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'st-basic' })}`)
  const approve2 = await authorizeConfirm(admin, reqIdOf(first2), true)
  const oidcCode2 = new URL(approve2.result.location).searchParams.get('code')
  const tBasic = await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basicAuth}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: oidcCode2, redirect_uri: 'https://crm.partner.example/cb', code_verifier: pkceVerifier }).toString(),
  })
  check('code 换令牌（client_secret_basic + Basic 头认证）', tBasic.status === 200 && jsonBody(tBasic).access_token?.split('.').length === 3)
  const first3 = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'st-json' })}`)
  const approve3 = await authorizeConfirm(admin, reqIdOf(first3), true)
  const tJson = await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: new URL(approve3.result.location).searchParams.get('code'), client_id: OC.clientId, client_secret: OC.clientSecret, redirect_uri: 'https://crm.partner.example/cb', code_verifier: pkceVerifier }),
  })
  check('code 换令牌（JSON 编码 + Post 认证）', tJson.status === 200 && jsonBody(tJson).access_token?.split('.').length === 3)

  const first4 = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'st-badverifier' })}`)
  const approve4 = await authorizeConfirm(admin, reqIdOf(first4), true)
  const tBadVerifier = await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenForm({ code: new URL(approve4.result.location).searchParams.get('code'), code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-wrong' }),
  })
  check('PKCE verifier 错误 → 400 invalid_grant', tBadVerifier.status === 400 && jsonBody(tBadVerifier).error === 'invalid_grant')
  const first5 = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'st-noverifier' })}`)
  const approve5 = await authorizeConfirm(admin, reqIdOf(first5), true)
  const tNoVerifier = await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: OC.clientId, client_secret: OC.clientSecret, code: new URL(approve5.result.location).searchParams.get('code') }).toString(),
  })
  check('PKCE 缺少 code_verifier → 400', tNoVerifier.status === 400 && JSON.stringify(tNoVerifier.body).includes('code_verifier'))
  const tBadSecret = await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${OC.clientId}:wrong-secret`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: 'whatever' }).toString(),
  })
  check('client_secret 错误 → 401 + WWW-Authenticate: Basic', tBadSecret.status === 401 && jsonBody(tBadSecret).error === 'invalid_client' && String(tBadSecret.headers['www-authenticate'] ?? '').includes('Basic'))

  // -- token 类型区分 + JWKS 本地验签 + userinfo --
  const [jwtH, jwtP, jwtS] = ts1.access_token.split('.')
  const jwtClaims = JSON.parse(Buffer.from(jwtP, 'base64url').toString('utf8'))
  const jwtHeader = JSON.parse(Buffer.from(jwtH, 'base64url').toString('utf8'))
  const idClaims = JSON.parse(Buffer.from(ts1.id_token.split('.')[1], 'base64url').toString('utf8'))
  check('token 类型打标（access/id 区分 + kid 头）', jwtClaims.token_use === 'access' && idClaims.token_use === 'id' && jwtHeader.kid === jwks.keys[0].kid && jwtClaims.aud === OC.clientId && idClaims.nonce === undefined)
  const { createPublicKey: cpk, verify: rsVerify } = await import('node:crypto')
  const jwkKey = cpk({ key: { kty: jwks.keys[0].kty, n: jwks.keys[0].n, e: jwks.keys[0].e }, format: 'jwk' })
  check('外部应用以 JWKS 公钥本地验签通过', rsVerify('RSA-SHA256', Buffer.from(`${jwtH}.${jwtP}`), jwkKey, Buffer.from(jwtS, 'base64url')) === true && jwtClaims.iss.includes('127.0.0.1'))

  const userInfo = await rawReq('GET', '/oauth/userinfo', { headers: { authorization: `Bearer ${ts1.access_token}` } })
  const ui = jsonBody(userInfo)
  check('userinfo 返回 NormalizedProfile（org/角色/租户）', userInfo.status === 200 && ui.sub === adminLogin.data.user.id && ui.org !== null && Array.isArray(ui.roles) && ui.roles.includes('super_admin'))
  const idAsAccess = await rawReq('GET', '/oauth/userinfo', { headers: { authorization: `Bearer ${ts1.id_token}` } })
  check('id_token 调 userinfo 被拒（token_use 收敛）', idAsAccess.status === 401)
  const noBearer = await rawReq('GET', '/oauth/userinfo')
  check('userinfo 无凭证 → 401 + WWW-Authenticate: Bearer', noBearer.status === 401 && String(noBearer.headers['www-authenticate'] ?? '').includes('Bearer'))

  // -- SPA 静态页（授权页/错误页由前端路由承载）--
  const spaIndex = await rawReq('GET', '/')
  check('SPA 静态页可达（#/oauth/* 前端路由承载）', spaIndex.status === 200 && spaIndex.body.includes('id="app"'))

  // -- openid-client 冒烟（标准 SDK 一行 discovery 驱动：authorize → token → userinfo）--
  const oc = await import('openid-client')
  const ocConfig = await oc.discovery(new URL(BASE), OC.clientId, undefined, new oc.ClientSecretBasic(OC.clientSecret), { execute: [oc.allowInsecureRequests] })
  const ocVerifier = oc.randomPKCECodeVerifier()
  const ocChallenge = await oc.calculatePKCECodeChallenge(ocVerifier)
  const ocState = oc.randomState()
  const ocNonce = oc.randomNonce()
  const ocRedirectTo = oc.buildAuthorizationUrl(ocConfig, {
    redirect_uri: 'https://crm.partner.example/cb', scope: 'openid profile email',
    state: ocState, nonce: ocNonce, code_challenge: ocChallenge, code_challenge_method: 'S256',
  })
  const ocFirst = await rawReq('GET', ocRedirectTo.pathname + ocRedirectTo.search)
  check('openid-client：授权地址 302 平台授权页', ocFirst.status === 302 && String(ocFirst.headers.location).startsWith('/#/oauth/authorize?req='))
  const ocApprove = await authorizeConfirm(admin, reqIdOf(ocFirst), true)
  const ocTokens = await oc.authorizationCodeGrant(ocConfig, new URL(ocApprove.result.location), { pkceCodeVerifier: ocVerifier, expectedState: ocState, expectedNonce: ocNonce })
  check('openid-client：授权码换令牌（Basic 认证 + PKCE + id_token 验签全过）', typeof ocTokens.access_token === 'string' && typeof ocTokens.id_token === 'string')
  const ocUser = await oc.fetchUserInfo(ocConfig, ocTokens.access_token, ocTokens.claims().sub)
  check('openid-client：userinfo 取回身份（一行 SDK 式接入闭环）', ocUser.sub === adminLogin.data.user.id && ocUser.org !== null && ocUser.roles.includes('super_admin'))

  // 冻结联动：OIDC 令牌即时失效（无需等过期）
  const frozenAuth = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'st-frozen' })}`)
  const frozenApprove = await authorizeConfirm(dev, reqIdOf(frozenAuth), true)
  const frozenTokens = jsonBody(await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenForm({ code: new URL(frozenApprove.result.location).searchParams.get('code') }),
  }))
  const devUserFull = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('陈默'), { token: admin })).data.users[0]
  await api('POST', `/api/iam/users/${devUserFull.id}/freeze`, { token: admin, body: { reason: '第 6 步：验证 OIDC 离职/冻结联动' } })
  const frozenInfo = await rawReq('GET', '/oauth/userinfo', { headers: { authorization: `Bearer ${frozenTokens.access_token}` } })
  check('账号冻结 → OIDC 令牌即时失效（卖点闭环）', frozenInfo.status === 401)
  // 解冻并重登：后续 MCP/Skill 段仍需 dev 令牌（冻结已即时吊销旧令牌）
  await api('POST', `/api/iam/users/${devUserFull.id}/unfreeze`, { token: admin })
  const devRelogin = await api('POST', '/api/auth/login', { body: { username: 'dev', password: 'Ybk@2026' } })
  dev = devRelogin.data.token

  // ================================================================ 第 7 步：L0 市场 beta（自营供给 + 零价计量）
  section('第 7 步：L0 市场 beta（自营供给 / 零价计量 / 卸载联动）')
  const marketList = await api('GET', '/api/market/plugins', { token: admin })
  check('自营首批供给上架（3 个标杆 L0）', marketList.ok && marketList.data.plugins.filter((p) => p.pluginId.startsWith('com.platform.')).length === 3, JSON.stringify(marketList).slice(0, 400))
  const officialInstall = await api('POST', '/api/market/plugins/com.platform.contract-review/install', { token: admin, body: { orgId: newOrg.data.id, approvedCapabilities: ['knowledgebase.read'] } })
  check('安装自营插件', officialInstall.ok && officialInstall.data.status === 'running')
  const meteringView = (await api('GET', '/api/market/plugins', { token: admin })).data.plugins.find((p) => p.pluginId === 'com.platform.contract-review')
  check('市场计量口径（仅 meter key/单位，零价无金额）', Boolean(meteringView) && meteringView.metering?.usageKey === 'contract.docs' && meteringView.billing === undefined)
  const subsGone = await api('GET', '/api/market/subscriptions', { token: admin })
  check('订阅代收端点已随 M0-2 下线（404）', subsGone.status === 404)
  const officialPrompts = await api('GET', '/api/market/prompts?orgId=' + newOrg.data.id, { token: admin })
  check('自营插件提示词包可取用', officialPrompts.ok && JSON.stringify(officialPrompts.data.prompts).includes('合同审查'))

  const uninstall = await api('POST', '/api/market/plugins/com.acme.hello/uninstall', { token: admin, body: { orgId: tenantOrg.data.id } })
  check('卸载联动（运行态回收）', uninstall.ok && uninstall.data.status === 'uninstalled')
  const promptsAfterUninstall = await api('GET', '/api/market/prompts?orgId=' + tenantOrg.data.id, { token: admin })
  check('卸载后提示词包不再提供', promptsAfterUninstall.ok && !JSON.stringify(promptsAfterUninstall.data.prompts).includes('磁姆助手'))

  // ================================================================ MCP
  section('MCP 部署服务')
  const svcCreate = await api('POST', '/api/mcp/services', { token: admin, body: { name: '自测检索服务', slug: 'selftest-search', orgId: newOrg.data.id, description: '自测用（演示传输层）', transport: 'http', mode: 'hosted', exec: 'demo' } })
  check('注册 MCP 服务（草稿）', svcCreate.ok && svcCreate.data.status === 'draft')
  const svcId = svcCreate.data.id

  const invokeDraft = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: svcId, tool: 'selftest-search_search' } })
  check('草稿服务拒绝调用', !invokeDraft.ok || invokeDraft.data.status === 'denied')

  const verify = await api('POST', `/api/mcp/services/${svcId}/verify`, { token: admin })
  check('测试环境验证', verify.ok && verify.data.status === 'verifying')

  const dryRun = await api('POST', `/api/mcp/services/${svcId}/deploy`, { token: admin, body: { dryRun: true } })
  check('部署 dry-run 影响面预览', dryRun.ok && dryRun.data.dryRun === true)

  const deployGray = await api('POST', `/api/mcp/services/${svcId}/deploy`, { token: admin, body: { grayPercent: 20, version: '0.1.0', changelog: '灰度首发' } })
  check('灰度发布（20%）', deployGray.ok && deployGray.data.status === 'gray' && deployGray.data.grayPercent === 20)

  const deployFull = await api('POST', `/api/mcp/services/${svcId}/deploy`, { token: admin, body: { grayPercent: 100, version: '0.2.0', changelog: '全量' } })
  check('全量发布', deployFull.ok && deployFull.data.status === 'online')

  const rollback = await api('POST', `/api/mcp/services/${svcId}/rollback`, { token: admin, body: { targetVersion: '0.1.0' } })
  check('版本回滚（版本不可变保留）', rollback.ok && rollback.data.currentVersion === '0.1.0')

  // 网关鉴权：未授权主体
  const invokeDenied = await api('POST', '/api/mcp/invoke', { token: dev, body: { serviceId: svcId, tool: 'selftest-search_search', args: { query: 'hi' } } })
  check('未授权主体被网关拒绝', invokeDenied.ok && invokeDenied.data.status === 'denied', JSON.stringify(invokeDenied).slice(0, 300))

  // 权限组授权后放行
  const pg = await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
    name: '自测权限组', policies: { [svcId]: { allowedTools: '*', constraints: { readOnly: true } } },
    subjects: [{ type: 'user_group', id: groupCreate.data.id }],
  } })
  check('创建 MCP 权限组', pg.ok)

  const devUser = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('陈默'), { token: admin })).data.users[0]
  await api('PATCH', '/api/iam/groups/' + groupCreate.data.id, { token: admin, body: { memberIds: [devUser.id] } })
  const invokeOk = await api('POST', '/api/mcp/invoke', { token: dev, body: { serviceId: svcId, tool: 'selftest-search_search', args: { query: '自测' } } })
  check('授权后调用成功（只读工具放行）', invokeOk.ok && invokeOk.data.ok === true, JSON.stringify(invokeOk).slice(0, 300))

  const writeTool = (await api('GET', '/api/mcp/services', { token: admin })).data.services.find((s) => s.id === svcId).tools.find((t) => t.riskLevel !== 'read')
  if (writeTool) {
    const invokeWrite = await api('POST', '/api/mcp/invoke', { token: dev, body: { serviceId: svcId, tool: writeTool.name } })
    check('只读约束拦截写工具', invokeWrite.data?.status === 'denied' && String(invokeWrite.data.error).includes('只读'), JSON.stringify(invokeWrite).slice(0, 300))
  }

  // 回归：Agent 机器凭证身份解析（权限组 subject type=agent 必须能命中）
  const agentMcp = await api('POST', '/api/agents', { token: admin, body: { name: '自测MCP机器人', attrs: { description: 'MCP 鉴权回归', model: 'deepseek-chat', riskLevel: 'low', avatar: '🤖' } } })
  check('注册 Agent（MCP 鉴权回归用）', agentMcp.ok && agentMcp.data.credential?.clientId)
  const agentMcpId = agentMcp.data.agent.id
  const agentCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: agentMcp.data.credential.clientId, clientSecret: agentMcp.data.credential.clientSecret } })
  check('Agent 机器凭证换令牌', agentCc.ok && agentCc.data.token)
  const agentToken = agentCc.data.token

  const agentInvokeDenied = await api('POST', '/api/mcp/invoke', { token: agentToken, body: { serviceId: svcId, tool: 'selftest-search_search', args: { query: '未授权' } } })
  check('未授权 Agent 被网关拒绝', agentInvokeDenied.ok && agentInvokeDenied.data.status === 'denied', JSON.stringify(agentInvokeDenied).slice(0, 300))

  const pgAgent = await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
    name: '自测Agent权限组', policies: { [svcId]: { allowedTools: '*', constraints: { readOnly: true } } },
    subjects: [{ type: 'agent', id: agentMcpId }],
  } })
  check('创建 Agent 主体权限组', pgAgent.ok)

  const agentInvokeOk = await api('POST', '/api/mcp/invoke', { token: agentToken, body: { serviceId: svcId, tool: 'selftest-search_search', args: { query: '自测' } } })
  check('Agent 主体命中权限组放行', agentInvokeOk.ok && agentInvokeOk.data.ok === true, JSON.stringify(agentInvokeOk).slice(0, 300))

  const agentMcpCall = await rawReq('POST', '/mcp', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'mcp_invoke', arguments: { serviceId: svcId, tool: 'selftest-search_search', args: { query: '自测' } } } }),
  })
  const agentMcpText = jsonBody(agentMcpCall).result?.content?.[0]?.text ?? ''
  const agentMcpInvoke = (() => { try { return JSON.parse(agentMcpText) } catch { return {} } })()
  check('Agent 机器令牌经 /mcp mcp_invoke 放行', agentMcpCall.status === 200 && agentMcpInvoke.status === 'ok', agentMcpText.slice(0, 300))

  const metrics = await api('GET', `/api/mcp/services/${svcId}/metrics`, { token: admin })
  check('调用监控指标（调用方/工具/序列）', metrics.ok && metrics.data.calls >= 1 && metrics.data.toolStats.length > 0 && metrics.data.series.length === 60)

  const healthProbe = await api('POST', `/api/mcp/services/${svcId}/health`, { token: admin })
  check('健康探测', healthProbe.ok && ['healthy', 'degraded'].includes(healthProbe.data.status))

  // ================================================================ 第 0 步：执行层/连接器真实化
  section('第 0 步：真实传输层与真实连接器')
  // -- MCP 真实 stub（JSON-RPC over HTTP） ---------------------------------
  const mcpStub = createServer(async (req, res) => {
    const raw = await readBody(req)
    let msg = {}
    try { msg = JSON.parse(raw) } catch { /* ignore */ }
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }))
      return
    }
    if (msg.method === 'tools/call') {
      if (msg.params?.name === 'boom') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: '故意失败' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: `real-echo:${msg.params?.name}` }], usage: { totalTokens: 4321 } },
      }))
      return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise((resolve) => mcpStub.listen(0, '127.0.0.1', resolve))
  const mcpPort = mcpStub.address().port

  const realSvc = await api('POST', '/api/mcp/services', { token: admin, body: { name: '真实后端服务', slug: 'real-backend', orgId: newOrg.data.id, endpoint: `http://127.0.0.1:${mcpPort}/mcp`, transport: 'http', mode: 'external', exec: 'real', tools: [
    { name: 'real_query', description: '真实查询', inputSchema: { type: 'object' }, riskLevel: 'read' },
    { name: 'boom', description: '总是失败', inputSchema: { type: 'object' }, riskLevel: 'read' },
  ] } })
  check('注册 real 服务（默认真实传输）', realSvc.ok && realSvc.data.exec === 'real')
  const realId = realSvc.data.id
  await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
    name: 'real 全放行', policies: { [realId]: { allowedTools: '*', constraints: {} } },
    subjects: [{ type: 'user', id: adminLogin.data.user.id, name: 'admin' }],
  } })
  const realVerify = await api('POST', `/api/mcp/services/${realId}/verify`, { token: admin })
  check('real 服务测试验证（真实 initialize 探测）', realVerify.ok && realVerify.data.health.status === 'healthy')
  await api('POST', `/api/mcp/services/${realId}/deploy`, { token: admin, body: { version: '1.0.0', changelog: '真实首发' } })

  const realInvoke = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: realId, tool: 'real_query', args: { q: '真实链路' } } })
  check('real 调用真实往返（stub 内容透传）', realInvoke.ok && JSON.stringify(realInvoke.data.result).includes('real-echo:real_query'))

  const boomInvoke = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: realId, tool: 'boom', args: {} } })
  check('real 错误路径（isError → status error）', boomInvoke.data.status === 'error')
  const realCalls = (await api('GET', `/api/mcp/calls?serviceId=${realId}`, { token: admin })).data.items
  const okRealCall = realCalls.find((c) => c.tool === 'real_query')
  const boomRealCall = realCalls.find((c) => c.tool === 'boom')
  check('real 计量来自响应 usage（tokens=4321，非伪造）', okRealCall && okRealCall.tokens === 4321 && okRealCall.exec === 'real')
  check('real 失败调用同样标记 exec=real', boomRealCall && boomRealCall.exec === 'real' && boomRealCall.ok === false)

  const mcpUsage = await api('GET', '/api/usage/events?resource=mcp:real-backend', { token: admin })
  check('MCP real 调用自动进入计量管道（含失败调用）', mcpUsage.ok && mcpUsage.data.total >= 2
    && mcpUsage.data.items.every((e) => typeof e.tenant_id === 'string' && e.tenant_id.length > 0 && e.principal.startsWith('org:')), JSON.stringify((mcpUsage.data?.items ?? []).map((e) => ({ t: e.tenant_id, p: e.principal, r: e.resource }))))

  const deadSvc = await api('POST', '/api/mcp/services', { token: admin, body: { name: '不可达服务', slug: 'dead-backend', orgId: newOrg.data.id, endpoint: 'http://127.0.0.1:1/mcp', mode: 'external', exec: 'real', tools: [{ name: 'x', description: 'x', inputSchema: { type: 'object' }, riskLevel: 'read' }] } })
  const deadVerify = await api('POST', `/api/mcp/services/${deadSvc.data.id}/verify`, { token: admin })
  check('real 验证不可达 endpoint 被拒（不再恒可达）', !deadVerify.ok)

  // ================================================================ MCP 配置导入（mcpServers JSON）
  section('MCP 配置导入（mcpServers JSON 一键接入）')
  // streamable HTTP + SSE 响应帧 + 会话头的 mock 服务（复刻 teambition 形态）
  const mcpSseStub = createServer(async (req, res) => {
    const raw = await readBody(req)
    let msg = {}
    try { msg = JSON.parse(raw) } catch { /* ignore */ }
    const sseReply = (payload, extra = {}) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...extra })
      res.end(`data: ${JSON.stringify(payload)}\n\n`)
    }
    const noSession = { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Server not initialized: session required' } }
    if (msg.method === 'initialize') {
      return sseReply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'tb-like', version: '1.0' } } }, { 'mcp-session-id': 'sess-stub-1' })
    }
    if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end() }
    if (msg.method === 'tools/list') {
      if (req.headers['mcp-session-id'] !== 'sess-stub-1') return sseReply(noSession)
      return sseReply({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'tb_query_task', description: '查询任务', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        { name: 'tb_create_task', description: '创建任务', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
      ] } })
    }
    if (msg.method === 'tools/call') {
      if (req.headers['mcp-session-id'] !== 'sess-stub-1') return sseReply(noSession)
      const auth = req.headers.authorization ? `|auth:${req.headers.authorization}` : ''
      return sseReply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `sse-echo:${msg.params?.name}${auth}` }], usage: { totalTokens: 88 } } })
    }
    res.writeHead(404).end('{}')
  })
  await new Promise((resolve) => mcpSseStub.listen(0, '127.0.0.1', resolve))
  const ssePort = mcpSseStub.address().port

  // 1. 标准形态导入（用户实际粘贴的配置样式）
  const tbConfig = JSON.stringify({ mcpServers: { 'teambition-mcp': { type: 'streamableHttp', url: `http://127.0.0.1:${ssePort}/api/mcp?userToken=u-demo` } } })
  const imp = await api('POST', '/api/mcp/import', { token: admin, body: { config: tbConfig } })
  check('mcpServers JSON 一键导入', imp.ok && imp.data.imported === 1 && imp.data.results[0].ok, JSON.stringify(imp).slice(0, 300))
  const impR = imp.data.results[0]
  check('工具自动发现（initialize→tools/list，SSE 帧解析）', impR.tools === 2 && impR.reachable === true)
  check('导入即验证并上线（autoDeploy）', impR.status === 'online')
  const tbService = (await api('GET', '/api/mcp/services', { token: admin })).data.services.find((s) => s.id === impR.serviceId)
  check('发现的工具含完整 inputSchema', tbService.tools.length === 2 && tbService.tools[0].inputSchema?.required?.[0] === 'id')

  // 2. 全链路调用（SSE + 会话头 + 权限组）
  await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
    name: 'teambition 全放行', policies: { [impR.serviceId]: { allowedTools: '*', constraints: { readOnly: true } } },
    subjects: [{ type: 'user', id: adminLogin.data.user.id, name: 'admin' }],
  } })
  const tbInvoke = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: impR.serviceId, tool: 'tb_query_task', args: { id: 't-1' } } })
  check('导入服务真实调用（SSE 响应 + 会话复用）', tbInvoke.ok && tbInvoke.data.ok === true && JSON.stringify(tbInvoke.data.result).includes('sse-echo:tb_query_task'), JSON.stringify(tbInvoke).slice(0, 300))

  // 3. 凭证与下游认证头（W1 治理 2026-10-22：导入敏感头自动入 SecretBroker，凭证也可经 API 显式下发）
  const authConfig = JSON.stringify({ mcpServers: { 'authed-mcp': { type: 'http', url: `http://127.0.0.1:${ssePort}/api/mcp`, headers: { Authorization: 'Bearer tk-123' } } } })
  const impPlain = await api('POST', '/api/mcp/import', { token: admin, body: { config: authConfig } })
  check('导入携带明文敏感头 → 自动入保险箱（brokered 标记）', impPlain.ok && impPlain.data.results[0].ok === true && impPlain.data.results[0].brokered === true, JSON.stringify(impPlain).slice(0, 300))
  const plainSvc = (await api('GET', '/api/mcp/services', { token: admin })).data.services.find((s) => s.id === impPlain.data.results[0].serviceId)
  check('自动入保险箱后服务记录零敏感头且带 credentialRef', plainSvc && !plainSvc.headers?.Authorization && plainSvc.credentialRef === 'local:', JSON.stringify(plainSvc?.headers ?? {}))
  const impAuth = await api('POST', '/api/mcp/import', { token: admin, body: { config: JSON.stringify({ mcpServers: { 'authed-mcp-clean': { type: 'http', url: `http://127.0.0.1:${ssePort}/api/mcp` } } }) } })
  check('无头干净配置导入成功', impAuth.ok && impAuth.data.results[0].ok, JSON.stringify(impAuth).slice(0, 300))
  const authSvcId = impAuth.data.results[0].serviceId
  const credPut = await api('PUT', `/api/mcp/services/${authSvcId}/credential`, { token: admin, body: { credentialRef: 'local:', headerName: 'Authorization', secret: 'Bearer tk-123' } })
  check('凭证经 Secret Broker 下发（响应不回显明文）', credPut.ok && !JSON.stringify(credPut.data).includes('tk-123'), JSON.stringify(credPut).slice(0, 300))
  await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
    name: 'authed 全放行', policies: { [authSvcId]: { allowedTools: '*', constraints: { readOnly: true } } },
    subjects: [{ type: 'user', id: adminLogin.data.user.id, name: 'admin' }],
  } })
  const authInvoke = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: authSvcId, tool: 'tb_query_task', args: {} } })
  check('Broker 凭证注入透传到远端（Authorization）', authInvoke.ok && authInvoke.data.ok === true && JSON.stringify(authInvoke.data.result).includes('auth:Bearer tk-123'), JSON.stringify(authInvoke).slice(0, 300))
  const whoamiInvoke = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: authSvcId, tool: 'whoami', args: {} } })
  check('清单外工具被网关拒绝（导入不越权）', whoamiInvoke.data?.status === 'denied', JSON.stringify(whoamiInvoke).slice(0, 200))
  const credGet = await api('GET', `/api/mcp/services/${authSvcId}/credential`, { token: admin })
  check('凭证回显仅元数据（hasSecret 且零明文）', credGet.ok && credGet.data?.hasSecret === true && !JSON.stringify(credGet.data).includes('tk-123'), JSON.stringify(credGet).slice(0, 300))
  const authSvc = (await api('GET', '/api/mcp/services', { token: admin })).data.services.find((s) => s.id === authSvcId)
  check('服务记录零敏感头且带 credentialRef', authSvc && !authSvc.headers?.Authorization && !!authSvc.credentialRef, JSON.stringify(authSvc?.headers ?? {}))

  // 4. stdio/command 本地形态不支持
  const impStdio = await api('POST', '/api/mcp/import', { token: admin, body: { config: JSON.stringify({ mcpServers: { 'local-tools': { command: 'npx', args: ['-y', 'some-mcp'] } } }) } })
  check('stdio/command 形态标记不可导入', impStdio.ok && impStdio.data.results[0].ok === false && /stdio/.test(impStdio.data.results[0].error))

  // 5. 非法 JSON
  const impBad = await api('POST', '/api/mcp/import', { token: admin, body: { config: '{oops' } })
  check('非法 JSON 报错（400）', !impBad.ok && impBad.status === 400 && /JSON/.test(impBad.error?.message ?? ''))

  // 6. 重复导入（slug 冲突）
  const impDup = await api('POST', '/api/mcp/import', { token: admin, body: { config: tbConfig } })
  check('重复导入同名列出冲突', impDup.ok && impDup.data.results[0].ok === false && /已存在/.test(impDup.data.results[0].error))

  // 7. 权限控制
  const impDenied = await api('POST', '/api/mcp/import', { token: dev, body: { config: tbConfig } })
  check('无 mcp.service.write 权限导入被拒（403）', impDenied.status === 403)

  // 8. 远端不可达：导入成功但保留草稿
  const impDead = await api('POST', '/api/mcp/import', { token: admin, body: { config: JSON.stringify({ mcpServers: { 'dead-remote': { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }) } })
  check('远端不可达：导入保留草稿并回传原因', impDead.data.results[0].ok === true && impDead.data.results[0].reachable === false && impDead.data.results[0].status === 'draft' && /发现失败/.test(impDead.data.results[0].error ?? ''), JSON.stringify(impDead).slice(0, 300))
  const deadImported = (await api('GET', '/api/mcp/services', { token: admin })).data.services.find((s) => s.id === impDead.data.results[0].serviceId)
  check('不可达服务不落伪工具清单', deadImported.tools.length === 0)

  // 9. 在线外部服务同步工具
  const syncRes = await api('POST', `/api/mcp/services/${impR.serviceId}/sync-tools`, { token: admin })
  check('在线外部服务可同步工具清单', syncRes.ok && syncRes.data.tools.length === 2)

  // ================================================================ W1/V11 工具风险登记（网关组交付，2026-10-15）
  // 闭环：未登记 unknown 写拒绝落账 → 登记→domain 审→security 审→effective 放行 → 清单/重审清单 → retire 收回再拒
  section('MCP 工具风险登记（W1/V11 根治）')
  const w1Svc = await api('POST', '/api/mcp/services', { token: admin, body: {
    name: 'W1 风险登记自测', slug: 'w1-risk-demo', orgId: newOrg.data.id, mode: 'external', exec: 'real',
    endpoint: `http://127.0.0.1:${ssePort}/api/mcp`, transport: 'http',
    tools: [
      { name: 'w1_unregistered_write', description: '未登记写工具（unknown）', inputSchema: { type: 'object' }, riskLevel: 'unknown' },
      { name: 'w1_read_tool', description: '未登记读工具（显式 read）', inputSchema: { type: 'object' }, riskLevel: 'read' },
    ],
  } })
  check('W1 注册 external real 自测服务（显式申报 unknown/read 各一）', w1Svc.ok && w1Svc.data.tools.length === 2)
  const w1SvcId = w1Svc.data.id
  await api('POST', `/api/mcp/services/${w1SvcId}/verify`, { token: admin })
  await api('POST', `/api/mcp/services/${w1SvcId}/deploy`, { token: admin, body: { grayPercent: 100, changelog: 'W1 自测全量' } })
  await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
    name: 'W1 风险登记权限组（非只读）', policies: { [w1SvcId]: { allowedTools: '*', constraints: {} } },
    subjects: [{ type: 'user', id: adminLogin.data.user.id, name: 'admin' }],
  } })

  const w1Deny = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: w1SvcId, tool: 'w1_unregistered_write', args: {} } })
  check('W1 未登记 unknown 工具非只读语境调用被拒（RISK_UNREGISTERED）', w1Deny.ok && w1Deny.data.status === 'denied' && w1Deny.data.code === 'RISK_UNREGISTERED', JSON.stringify(w1Deny).slice(0, 300))
  const w1DeniedCall = (await api('GET', `/api/mcp/calls?serviceId=${w1SvcId}&status=denied`, { token: admin })).data.items.find((c) => c.tool === 'w1_unregistered_write')
  check('W1 拒绝链落账 mcp:calls（status=denied 且附领域拒绝码）', w1DeniedCall && w1DeniedCall.ok === false && w1DeniedCall.code === 'RISK_UNREGISTERED', JSON.stringify(w1DeniedCall ?? {}).slice(0, 200))

  const w1Submit = await api('POST', '/api/mcp/risk-registry', { token: admin, body: { serviceId: w1SvcId, toolName: 'w1_unregistered_write', risk: 'write', reason: '自测：批次数据导出为受控写能力' } })
  check('W1 风险登记提交（登记即提交 pending_domain）', w1Submit.ok && w1Submit.data.status === 'pending_domain', JSON.stringify(w1Submit).slice(0, 200))
  const w1Skip = await api('POST', `/api/mcp/risk-registry/${w1Submit.data.id}/decide`, { token: admin, body: { decision: 'approve', level: 'security', opinion: '跳级应被拒' } })
  check('W1 审批级别与 pending 级别不匹配 → 400 中文错误', w1Skip.status === 400 && /安全|领域/.test(w1Skip.error?.message ?? ''), JSON.stringify(w1Skip).slice(0, 200))
  const w1Domain = await api('POST', `/api/mcp/risk-registry/${w1Submit.data.id}/decide`, { token: admin, body: { decision: 'approve', level: 'domain', opinion: '领域通过' } })
  check('W1 domain 审批通过 → write 升级 pending_security（D-① 两级）', w1Domain.ok && w1Domain.data.status === 'pending_security', JSON.stringify(w1Domain).slice(0, 200))
  const w1Security = await api('POST', `/api/mcp/risk-registry/${w1Submit.data.id}/decide`, { token: admin, body: { decision: 'approve', level: 'security', opinion: '安全加签通过' } })
  check('W1 security 审批通过 → effective', w1Security.ok && w1Security.data.status === 'effective', JSON.stringify(w1Security).slice(0, 200))

  const w1Ok = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: w1SvcId, tool: 'w1_unregistered_write', args: {} } })
  check('W1 登记生效后按登记风险放行（闸门取登记值 write）', w1Ok.ok && w1Ok.data.ok === true && JSON.stringify(w1Ok.data.result).includes('sse-echo:w1_unregistered_write'), JSON.stringify(w1Ok).slice(0, 300))

  const w1List = await api('GET', `/api/mcp/risk-registry?serviceId=${w1SvcId}&status=effective`, { token: admin })
  check('W1 登记清单（serviceId+status 过滤命中 effective）', w1List.ok && w1List.data.total === 1 && w1List.data.items[0].toolName === 'w1_unregistered_write', JSON.stringify(w1List.data).slice(0, 240))
  const w1Review = await api('GET', '/api/mcp/risk-registry/review-list', { token: admin })
  const w1ReviewItems = (w1Review.data?.items ?? []).filter((i) => i.serviceId === w1SvcId)
  check('W1 重审清单（D-⑤=a）：未登记读工具 unregistered + 已登记写工具 registered', w1Review.ok
    && w1ReviewItems.some((i) => i.toolName === 'w1_read_tool' && i.state === 'unregistered')
    && w1ReviewItems.some((i) => i.toolName === 'w1_unregistered_write' && i.state === 'registered' && i.registeredRisk === 'write'), JSON.stringify(w1ReviewItems).slice(0, 300))

  const w1Retire = await api('POST', `/api/mcp/risk-registry/${w1Submit.data.id}/retire`, { token: admin, body: { reason: '自测：退场收回写能力' } })
  check('W1 生效登记退场 → retired', w1Retire.ok && w1Retire.data.status === 'retired', JSON.stringify(w1Retire).slice(0, 160))
  const w1DenyAgain = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: w1SvcId, tool: 'w1_unregistered_write', args: {} } })
  check('W1 退场后闸门回到 unknown → 再调用被拒（RISK_UNREGISTERED）', w1DenyAgain.ok && w1DenyAgain.data.code === 'RISK_UNREGISTERED', JSON.stringify(w1DenyAgain).slice(0, 200))

  // -- 钉钉真实 stub（复刻 OpenAPI 形状） ---------------------------------
  const ddUsers = {
    dd_u002: { unionId: 'dd_u002', userId: 'u002', name: '林小满', email: 'linxm@yuanbingke.com' },
    dd_u020: { unionId: 'dd_u020', userId: 'u020', name: '真实连接用户', jobNumber: 'DD0020', title: '真实目录工程师', email: 'real@yuanbingke.com', active: true },
  }
  const ddStub = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub')
    const raw = await readBody(req)
    const jsonReply = (code, payload) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
    if (url.pathname === '/v1.0/oauth2/accessToken') {
      const body = JSON.parse(raw || '{}')
      if (body.appKey === 'stub-key' && body.appSecret === 'stub-secret') return jsonReply(200, { accessToken: 'corp-token-stub', expireIn: 7200 })
      return jsonReply(400, { code: 'invalid.credentials' })
    }
    if (url.pathname === '/v1.0/oauth2/userAccessToken') {
      const body = JSON.parse(raw || '{}')
      if (typeof body.code === 'string' && body.code.startsWith('STUB-')) return jsonReply(200, { accessToken: `ut-${body.code}`, expireIn: 7200, corpId: 'ding-real' })
      return jsonReply(400, { code: 'invalid.code' })
    }
    if (url.pathname === '/v1.0/contact/users/me') {
      const token = req.headers['x-acs-dingtalk-access-token']
      if (token !== 'ut-STUB-OK') return jsonReply(401, { code: 'invalid.token' })
      return jsonReply(200, { ...ddUsers.dd_u002, corpId: 'ding-real' })
    }
    if (url.pathname === '/topapi/v2/department/listsubid') {
      if (url.searchParams.get('access_token') !== 'corp-token-stub') return jsonReply(200, { errcode: 40014, errmsg: 'invalid access_token' })
      const body = JSON.parse(raw || '{}')
      if (body.dept_id === 1) return jsonReply(200, { errcode: 0, errmsg: 'ok', result: { dept_id_list: [500] } })
      return jsonReply(200, { errcode: 0, errmsg: 'ok', result: { dept_id_list: [] } })
    }
    if (url.pathname === '/topapi/v2/department/get') {
      if (url.searchParams.get('access_token') !== 'corp-token-stub') return jsonReply(200, { errcode: 40014, errmsg: 'invalid access_token' })
      const body = JSON.parse(raw || '{}')
      return jsonReply(200, { errcode: 0, errmsg: 'ok', result: { dept_id: body.dept_id, name: body.dept_id === 1 ? '真实企业根' : '真实连接器部门' } })
    }
    if (url.pathname === '/topapi/v2/user/list') {
      if (url.searchParams.get('access_token') !== 'corp-token-stub') return jsonReply(200, { errcode: 40014, errmsg: 'invalid access_token' })
      const body = JSON.parse(raw || '{}')
      if (body.dept_id !== 500) return jsonReply(200, { errcode: 0, errmsg: 'ok', result: { list: [], has_more: false } })
      return jsonReply(200, { errcode: 0, errmsg: 'ok', result: { list: [{ unionid: 'dd_u020', userid: 'u020', name: '真实连接用户', job_number: 'DD0020', title: '真实目录工程师', email: 'real@yuanbingke.com', active: true }], has_more: false } })
    }
    res.writeHead(404).end('{}')
  })
  await new Promise((resolve) => ddStub.listen(0, '127.0.0.1', resolve))
  const ddPort = ddStub.address().port

  const putConnector = await api('PUT', '/api/iam/connectors/dingtalk', { token: admin, body: { corpId: 'ding-real', appKey: 'stub-key', appSecret: 'stub-secret', mode: 'real', apiBase: `http://127.0.0.1:${ddPort}`, oapiBase: `http://127.0.0.1:${ddPort}`, enabled: true, conflictStrategy: 'manual' } })
  check('连接器切换真实模式', putConnector.ok && putConnector.data.mode === 'real')
  const connTest = await api('POST', '/api/iam/connectors/dingtalk/test', { token: admin })
  check('真实连接器健康检查（mock:false）', connTest.ok && connTest.data.ok === true && connTest.data.mock === false)

  const realAuth = await api('POST', '/api/auth/sso/authorize', { body: { provider: 'dingtalk', scene: 'web_qr' } })
  const realSso = await api('POST', '/api/auth/sso', { body: { provider: 'dingtalk', code: 'STUB-OK', state: realAuth.data.state } })
  check('真实 OpenAPI 登录链路（token→userinfo→命中）', realSso.ok && realSso.data.kind === 'hit' && realSso.data.user.username === 'linxm')

  const realSync = await api('POST', '/api/iam/connectors/dingtalk/sync', { token: admin })
  check('真实目录同步（OpenAPI 分页拉取）', realSync.ok && realSync.data.created >= 1)
  const syncedUser = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('真实连接用户'), { token: admin })).data.users[0]
  check('真实同步新建账号落库', Boolean(syncedUser) && syncedUser.status === 'active')

  // 降级回归：切回 mock 后显式标注
  const mockBack = await api('PUT', '/api/iam/connectors/dingtalk', { token: admin, body: { corpId: 'ding-yuanbingke', appKey: 'demo-app-key', appSecret: 'demo-secret-do-not-use', mode: 'mock', enabled: true } })
  check('切回降级模式（显式标注 mock）', mockBack.ok && mockBack.data.mode === 'mock')

  // 事务存储落位（计量/资金类数据库文件创建）
  check('SQLite 事务存储已就位（txnstore.db）', existsSync(join(DATA_DIR, 'txnstore.db')))

  // -- 多主体接入（同 provider 多实例连接器） --------------------------------
  // 兼容语义：:param 先按实例 id 解析、失败按 provider 取第一条；旧路由 'dingtalk' 零改动可用。
  section('多主体接入（同 provider 多实例连接器：创建/唯一约束/隔离同步/删除）')
  const createSecond = await api('POST', '/api/iam/connectors', { token: admin, body: { provider: 'dingtalk', name: '第二主体', corpId: 'ding-second', appKey: 'demo-key-2', appSecret: 'demo-secret-2', mode: 'mock', enabled: true, conflictStrategy: 'manual' } })
  check('创建第二主体连接器（POST /api/iam/connectors）', createSecond.ok && Boolean(createSecond.data?.id), JSON.stringify(createSecond).slice(0, 300))
  const listAfterCreate = await api('GET', '/api/iam/connectors', { token: admin })
  check('连接器列表出现 2 条配置', listAfterCreate.ok && listAfterCreate.data.configs.length === 2, JSON.stringify(listAfterCreate.data).slice(0, 200))
  const dupCorp = await api('POST', '/api/iam/connectors', { token: admin, body: { provider: 'dingtalk', name: '重复主体', corpId: 'ding-second', appKey: 'demo-key-2', appSecret: 'demo-secret-2', mode: 'mock', enabled: true, conflictStrategy: 'manual' } })
  check('同 provider+corpId 重复创建被拒（provider|corpId 唯一约束）', !dupCorp.ok, JSON.stringify(dupCorp).slice(0, 200))
  const id2 = createSecond.data?.id
  const syncSecond = await api('POST', `/api/iam/connectors/${id2}/sync`, { token: admin })
  check('按实例 id 同步第二主体', syncSecond.ok && /同步完成/.test(syncSecond.data?.message ?? ''), JSON.stringify(syncSecond).slice(0, 300))
  const syncFirstAgain = await api('POST', '/api/iam/connectors/dingtalk/sync', { token: admin })
  check('第一主体旧路由（按 provider 解析）同步互不影响', syncFirstAgain.ok && /同步完成/.test(syncFirstAgain.data?.message ?? ''), JSON.stringify(syncFirstAgain).slice(0, 300))
  const orgsAfterMulti = (await api('GET', '/api/iam/orgs', { token: admin })).data
  const mockRootCount = orgsAfterMulti.filter((org) => org.name === '元冰可集团').length
  check('两家主体部门并存（两家根部门均落库）', mockRootCount >= 2, `元冰可集团根数=${mockRootCount}`)
  const delSecond = await api('DELETE', `/api/iam/connectors/${id2}`, { token: admin })
  check('删除第二主体连接器（DELETE /api/iam/connectors/:id）', delSecond.ok && delSecond.data?.deleted === true, JSON.stringify(delSecond).slice(0, 200))
  const listAfterDelete = await api('GET', '/api/iam/connectors', { token: admin })
  check('删除后列表回到 1 条', listAfterDelete.ok && listAfterDelete.data.configs.length === 1, JSON.stringify(listAfterDelete.data).slice(0, 200))
  const testDeleted = await api('POST', `/api/iam/connectors/${id2}/test`, { token: admin })
  check('已删除实例不可再测试', !testDeleted.ok, JSON.stringify(testDeleted).slice(0, 200))
  const authProviders = await api('GET', '/api/auth/providers')
  check('三方登录入口带 configId/name（多主体可区分）', authProviders.ok && authProviders.data.providers.length >= 1
    && authProviders.data.providers.every((p) => p.configId && p.name), JSON.stringify(authProviders.data).slice(0, 300))

  section('连接器自动同步与全员名册（组织数据通道）')
  // 自动同步：intervalMinutes 到期巡检（定时器每分钟跑同一 runDueAutoSyncs，此处以手动触发口等价验证）
  const autoSyncConn = await api('POST', '/api/iam/connectors', { token: admin, body: { provider: 'dingtalk', name: '自动同步主体', corpId: 'ding-autosync', appKey: 'demo-key-auto', appSecret: 'demo-secret-auto', mode: 'mock', enabled: true, intervalMinutes: 5, conflictStrategy: 'manual' } })
  check('创建自动同步主体（intervalMinutes=5，从未同步=到期）', autoSyncConn.ok && Boolean(autoSyncConn.data?.id), JSON.stringify(autoSyncConn).slice(0, 200))
  const manualOnlyConn = await api('POST', '/api/iam/connectors', { token: admin, body: { provider: 'dingtalk', name: '仅手动主体', corpId: 'ding-manualonly', appKey: 'demo-key-manual', appSecret: 'demo-secret-manual', mode: 'mock', enabled: true, intervalMinutes: 0, conflictStrategy: 'manual' } })
  check('创建仅手动主体（intervalMinutes=0）', manualOnlyConn.ok && Boolean(manualOnlyConn.data?.id), JSON.stringify(manualOnlyConn).slice(0, 200))
  const autoRun1 = await api('POST', '/api/iam/connectors/auto-sync', { token: admin })
  check('到期巡检：从未同步的连接器被补同步', autoRun1.ok && autoRun1.data.processed >= 1
    && autoRun1.data.results.some((item) => item.configId === autoSyncConn.data?.id && item.ok), JSON.stringify(autoRun1.data).slice(0, 300))
  check('到期巡检：0=仅手动的连接器不被处理', autoRun1.ok && !autoRun1.data.results.some((item) => item.configId === manualOnlyConn.data?.id), JSON.stringify(autoRun1.data).slice(0, 300))
  const autoRun2 = await api('POST', '/api/iam/connectors/auto-sync', { token: admin })
  check('到期巡检：刚同步过的连接器不重复处理', autoRun2.ok && autoRun2.data.processed === 0, JSON.stringify(autoRun2.data).slice(0, 200))
  const delAutoSync = await api('DELETE', `/api/iam/connectors/${autoSyncConn.data?.id}`, { token: admin })
  check('清理自动同步主体', delAutoSync.ok)
  const delManualOnly = await api('DELETE', `/api/iam/connectors/${manualOnlyConn.data?.id}`, { token: admin })
  check('清理仅手动主体', delManualOnly.ok)

  // 全员名册：iam.roster.read（org_admin 经 iam.* 通配自带；接入应用经机器凭证 scope 授权）
  const rosterAdmin = await api('GET', '/api/iam/roster', { token: admin })
  check('管理员拉取全员名册（users+orgs）', rosterAdmin.ok && Array.isArray(rosterAdmin.data.users) && Array.isArray(rosterAdmin.data.orgs), JSON.stringify(rosterAdmin.data).slice(0, 200))
  const rosterSyncedUser = rosterAdmin.ok ? rosterAdmin.data.users.find((u) => u.jobNumber === 'DD0001') : undefined
  check('名册含同步账号（工号/组织名/稳定关联键 id）', Boolean(rosterSyncedUser) && Boolean(rosterSyncedUser.orgName) && Boolean(rosterSyncedUser.id))
  check('名册组织含部门负责人（钉钉 dept_manager 同步链）', rosterAdmin.ok && rosterAdmin.data.orgs.some((org) => Array.isArray(org.leaderUserIds) && org.leaderUserIds.length > 0))
  const rosterText = rosterAdmin.ok ? JSON.stringify(rosterAdmin.data) : ''
  check('名册 PII 最小化（无口令字段/无手机号）', rosterText !== '' && !rosterText.includes('passwordHash') && !rosterText.includes('"phone"'))
  const rosterNoAuth = await api('GET', '/api/iam/roster')
  check('未认证拉取名册 401', rosterNoAuth.status === 401)
  const rosterDeniedCred = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'roster-denied', refType: 'app', scopes: ['agent.read'] } })
  const rosterDeniedCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: rosterDeniedCred.data.clientId, clientSecret: rosterDeniedCred.data.clientSecret } })
  const rosterDenied = await api('GET', '/api/iam/roster', { token: rosterDeniedCc.data?.token })
  check('无 iam.roster.read 的机器凭证 403', rosterDenied.status === 403)
  const rosterCred = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'hr-app-roster', refType: 'app', scopes: ['iam.roster.read'] } })
  check('签发名册读取机器凭证（应用接入组织数据通道）', rosterCred.ok && Boolean(rosterCred.data.clientId), JSON.stringify(rosterCred.data).slice(0, 200))
  const rosterCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: rosterCred.data.clientId, clientSecret: rosterCred.data.clientSecret } })
  const rosterMachine = await api('GET', '/api/iam/roster', { token: rosterCc.data?.token })
  check('机器凭证（iam.roster.read）拉取名册 200（与管理员同视图）', rosterMachine.ok && rosterMachine.data.users.length === (rosterAdmin.data?.users?.length ?? -1))
  const rosterAudit = await api('GET', '/api/audit/logs?type=invoke&q=roster', { token: admin })
  check('名册拉取留痕（invoke 审计含 machine actor）', rosterAudit.ok && JSON.stringify(rosterAudit.data).includes('iam.roster.pull'))

  // 应用组织架构同步（org-sync：默认凭证自助复用平台组织模块，2026-09-15）
  section('应用组织架构同步（org-sync：绑定凭证自助拉平台组织树，version 轮询）')
  const orgSyncApp = await api('POST', '/api/apps', { token: admin, body: { name: '组织同步验收应用', attrs: { description: 'org-sync 组织模块复用验收', appType: 'web', riskLevel: 'low', dataClass: 'internal' } } })
  check('注册组织同步验收应用（自动带默认机器凭证）', orgSyncApp.ok && Boolean(orgSyncApp.data?.credential?.clientId), JSON.stringify(orgSyncApp.error))
  const orgSyncAppId = orgSyncApp.data.app.id
  const orgSyncCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: orgSyncApp.data.credential.clientId, clientSecret: orgSyncApp.data.credential.clientSecret } })
  const orgSync1 = await api('GET', `/api/apps/${orgSyncAppId}/org-sync`, { token: orgSyncCc.data?.token })
  check('应用默认凭证自助拉取组织快照 200（orgs+users+version）',
    orgSync1.ok && Array.isArray(orgSync1.data.orgs) && Array.isArray(orgSync1.data.users) && /^[0-9a-f]{16}$/.test(orgSync1.data.version ?? ''), JSON.stringify(orgSync1.error ?? orgSync1.data).slice(0, 200))
  const orgSyncText = orgSync1.ok ? JSON.stringify(orgSync1.data) : ''
  check('org-sync PII 最小化（无 email/phone/口令/三方绑定）',
    orgSyncText !== '' && !orgSyncText.includes('"email"') && !orgSyncText.includes('"phone"') && !orgSyncText.includes('passwordHash') && !orgSyncText.includes('"bindings"'))
  check('org-sync 含部门负责人字段与成员组织归属（组织模块复用要素）',
    orgSync1.ok && orgSync1.data.orgs.some((org) => Array.isArray(org.leaderUserIds)) && orgSync1.data.users.length > 0 && orgSync1.data.users.every((user) => Boolean(user.orgId)))
  const orgSync2 = await api('GET', `/api/apps/${orgSyncAppId}/org-sync`, { token: orgSyncCc.data?.token })
  check('version 内容哈希幂等（同内容再拉 version 不变）', orgSync2.ok && orgSync2.data.version === orgSync1.data.version)
  const orgSyncUnchanged = await api('GET', `/api/apps/${orgSyncAppId}/org-sync?ifNoneMatch=${orgSync1.data.version}`, { token: orgSyncCc.data?.token })
  check('ifNoneMatch 命中返回 unchanged（零载荷轮询）', orgSyncUnchanged.ok && orgSyncUnchanged.data.unchanged === true && orgSyncUnchanged.data.orgs === undefined)
  const orgSyncOrgCreate = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '同步验收临时部门' } })
  check('平台新增组织成功（构造变更源）', orgSyncOrgCreate.ok, JSON.stringify(orgSyncOrgCreate.error))
  const orgSync3 = await api('GET', `/api/apps/${orgSyncAppId}/org-sync`, { token: orgSyncCc.data?.token })
  check('组织变更后 version 变化且新组织入快照',
    orgSync3.ok && orgSync3.data.version !== orgSync1.data.version && orgSync3.data.orgs.some((org) => org.name === '同步验收临时部门'))
  const orgSyncStale = await api('GET', `/api/apps/${orgSyncAppId}/org-sync?ifNoneMatch=${orgSync1.data.version}`, { token: orgSyncCc.data?.token })
  check('过期 ifNoneMatch 不命中（回落全量快照）', orgSyncStale.ok && orgSyncStale.data.unchanged === false && Array.isArray(orgSyncStale.data.orgs))
  const orgSyncNoAuth = await api('GET', `/api/apps/${orgSyncAppId}/org-sync`)
  check('未认证拉取组织快照 401', orgSyncNoAuth.status === 401)
  const orgSyncDenied = await api('GET', `/api/apps/${orgSyncAppId}/org-sync`, { token: rosterDeniedCc.data?.token })
  check('无 app.read 的他应用凭证 403', orgSyncDenied.status === 403)
  const orgSyncAudit = await api('GET', '/api/audit/logs?type=invoke&q=org-sync', { token: admin })
  check('org-sync 拉取留痕（invoke 审计 app.org-sync.pull）', orgSyncAudit.ok && JSON.stringify(orgSyncAudit.data).includes('app.org-sync.pull'))
  const orgSyncOrgDelete = await api('DELETE', `/api/iam/orgs/${orgSyncOrgCreate.data.id}`, { token: admin, body: {} })
  check('验收临时组织清理成功', orgSyncOrgDelete.ok, JSON.stringify(orgSyncOrgDelete.error))

  // ================================================================ 应用外部凭证托管（issue #19 方向 A 最小闭环）
  // 数字员工调用外部自研服务的长期凭据落点：AES-256-GCM 静态加密密钥文件；登记/轮换 app.write+owner，
  // 取值独立权限点 app.credential.fetch + 对象级校验（机器须绑定本应用）+ 逐次审计；响应零明文。
  section('应用外部凭证托管（#19：加密存取/独立权限点/逐次审计/接入方自检）')
  const appCredApp = await api('POST', '/api/apps', { token: admin, body: { name: '外部凭证验收应用', attrs: { description: 'issue 19 外部凭证托管验收', appType: 'api', riskLevel: 'low', dataClass: 'confidential' } } })
  check('注册凭证验收应用（自动带默认机器凭证）', appCredApp.ok && Boolean(appCredApp.data?.credential?.clientId), JSON.stringify(appCredApp.error))
  const appCredAppId = appCredApp.data.app.id
  const APP_CRED_SECRET_V1 = 'tk_live_secret_9f8e7d'
  const appCredPut = await api('PUT', `/api/apps/${appCredAppId}/credentials/kizuna-admin-token`, { token: admin, body: { value: APP_CRED_SECRET_V1, description: 'Kizuna 管理令牌' } })
  check('登记外部凭证 200（响应掩码 + rotatedAt，不含明文）',
    appCredPut.ok && appCredPut.data.masked === '••••••••8e7d' && typeof appCredPut.data.rotatedAt === 'string' && !JSON.stringify(appCredPut.data).includes('tk_live'),
    JSON.stringify(appCredPut.error ?? appCredPut.data).slice(0, 200))
  const appCredBadKey = await api('PUT', `/api/apps/${appCredAppId}/credentials/-bad-key`, { token: admin, body: { value: 'x' } })
  check('非法键名 400（字母/数字开头，仅字母数字._-）', appCredBadKey.status === 400, JSON.stringify(appCredBadKey.error ?? appCredBadKey.data).slice(0, 120))
  const appCredEmpty = await api('PUT', `/api/apps/${appCredAppId}/credentials/empty-value`, { token: admin, body: { value: '' } })
  check('空值 400（凭证值必填）', appCredEmpty.status === 400)
  const appCredList = await api('GET', `/api/apps/${appCredAppId}/credentials`, { token: admin })
  check('凭证清单只回掩码元数据（值零回显）',
    appCredList.ok && appCredList.data.credentials.length === 1 && appCredList.data.credentials[0].key === 'kizuna-admin-token' && !JSON.stringify(appCredList.data).includes(APP_CRED_SECRET_V1),
    JSON.stringify(appCredList.error ?? appCredList.data).slice(0, 200))
  // 静态加密落地核验：密钥文件在磁盘上不含明文；主密钥独立文件存在
  const appCredKeyFile = join(DATA_DIR, 'secrets', 'app', `${appCredAppId}.json`)
  const appCredKeyRaw = existsSync(appCredKeyFile) ? readFileSync(appCredKeyFile, 'utf8') : ''
  check('静态加密（AES-256-GCM）：密钥文件不含明文，主密钥独立（.master.key）',
    appCredKeyRaw !== '' && !appCredKeyRaw.includes(APP_CRED_SECRET_V1) && appCredKeyRaw.includes('"tag"') && existsSync(join(DATA_DIR, 'secrets', 'app', '.master.key')),
    `file=${existsSync(appCredKeyFile)} master=${existsSync(join(DATA_DIR, 'secrets', 'app', '.master.key'))}`)
  // 取值三态：管理员（*）200；绑定机器无 fetch 点 403；绑定机器有 fetch 点 200
  const appCredGetAdmin = await api('GET', `/api/apps/${appCredAppId}/credentials/kizuna-admin-token/value`, { token: admin })
  check('管理员取值 200（解密往返一致）', appCredGetAdmin.ok && appCredGetAdmin.data.value === APP_CRED_SECRET_V1, JSON.stringify(appCredGetAdmin.error ?? '').slice(0, 160))
  const appCredGetDefaultMach = await api('GET', `/api/apps/${appCredAppId}/credentials/kizuna-admin-token/value`, { token: orgSyncCc.data?.token })
  check('绑定本应用的默认机器凭证（无 fetch 点）403（权限点闸门）', appCredGetDefaultMach.status === 403, JSON.stringify(appCredGetDefaultMach.error).slice(0, 160))
  const appCredFetchCred = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'cred-app-fetch', refType: 'app', refId: appCredAppId, scopes: ['app.credential.fetch'] } })
  check('签发 fetch 附加权限点机器凭证（scopes 须命中权限目录）', appCredFetchCred.ok && Boolean(appCredFetchCred.data.clientId), JSON.stringify(appCredFetchCred.error ?? appCredFetchCred.data).slice(0, 160))
  const appCredFetchCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: appCredFetchCred.data.clientId, clientSecret: appCredFetchCred.data.clientSecret } })
  const appCredGetMach = await api('GET', `/api/apps/${appCredAppId}/credentials/kizuna-admin-token/value`, { token: appCredFetchCc.data?.token })
  check('绑定本应用的机器凭证（fetch 点）取值 200（数字员工取用通道）', appCredGetMach.ok && appCredGetMach.data.value === APP_CRED_SECRET_V1, JSON.stringify(appCredGetMach.error ?? '').slice(0, 160))
  const appCredOtherFetch = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'cred-other-fetch', refType: 'app', refId: orgSyncAppId, scopes: ['app.read', 'app.credential.fetch'] } })
  const appCredOtherCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: appCredOtherFetch.data.clientId, clientSecret: appCredOtherFetch.data.clientSecret } })
  const appCredGetOther = await api('GET', `/api/apps/${appCredAppId}/credentials/kizuna-admin-token/value`, { token: appCredOtherCc.data?.token })
  check('绑定他应用的机器凭证（fetch 点）403（对象级校验）', appCredGetOther.status === 403, JSON.stringify(appCredGetOther.error).slice(0, 160))
  const appCredGhost = await api('GET', `/api/apps/${appCredAppId}/credentials/ghost-key/value`, { token: admin })
  check('未登记键 404 CREDENTIAL_NOT_FOUND', appCredGhost.status === 404 && appCredGhost.error?.code === 'CREDENTIAL_NOT_FOUND', JSON.stringify(appCredGhost.error).slice(0, 160))
  await api('GET', `/api/apps/${appCredAppId}/credentials/kizuna-admin-token/value`, { token: appCredFetchCc.data?.token })
  const appCredAudit = await api('GET', '/api/audit/logs?type=change&q=app.credential.access', { token: admin })
  const appCredAuditText = appCredAudit.ok ? JSON.stringify(appCredAudit.data) : ''
  check('取用逐次落审计（app.credential.access，值零泄漏）',
    appCredAuditText.includes('app.credential.access') && appCredAuditText.includes('kizuna-admin-token') && !appCredAuditText.includes(APP_CRED_SECRET_V1),
    appCredAuditText.slice(0, 200))
  const appCredRotate = await api('PUT', `/api/apps/${appCredAppId}/credentials/kizuna-admin-token`, { token: admin, body: { value: 'tk_live_rotated_bb11aa' } })
  const appCredGetAfter = await api('GET', `/api/apps/${appCredAppId}/credentials/kizuna-admin-token/value`, { token: admin })
  check('轮换（同键覆盖）：rotated=true 且旧值立即失效', appCredRotate.ok && appCredRotate.data.rotated === true && appCredGetAfter.ok && appCredGetAfter.data.value === 'tk_live_rotated_bb11aa', JSON.stringify(appCredRotate.error ?? appCredGetAfter.error ?? '').slice(0, 160))
  const appCredCheck = await api('GET', `/api/apps/${appCredAppId}/credentials/self-check`, { token: admin })
  check('接入方自检（存储算法/可读机器凭证/最近取用）',
    appCredCheck.ok && appCredCheck.data.storage?.algorithm === 'AES-256-GCM' && (appCredCheck.data.whoCanRead?.machinePrincipals ?? []).length >= 1 && (appCredCheck.data.recentAccess ?? []).length >= 2,
    JSON.stringify(appCredCheck.error ?? appCredCheck.data).slice(0, 240))
  const appCredCheckDenied = await api('GET', `/api/apps/${appCredAppId}/credentials/self-check`, { token: appCredOtherCc.data?.token })
  check('他应用机器凭证自检 403（app.read 足过闸门但 owner 校验不过）', appCredCheckDenied.status === 403, JSON.stringify(appCredCheckDenied.error).slice(0, 160))
  const appCredDel = await api('DELETE', `/api/apps/${appCredAppId}/credentials/kizuna-admin-token`, { token: admin })
  const appCredGetDeleted = await api('GET', `/api/apps/${appCredAppId}/credentials/kizuna-admin-token/value`, { token: admin })
  check('删除后取值 404（删除即失效）', appCredDel.ok && appCredDel.data.removed === true && appCredGetDeleted.status === 404, JSON.stringify(appCredDel.error ?? appCredGetDeleted.error).slice(0, 160))
  const appCredAppDel = await api('DELETE', `/api/apps/${appCredAppId}`, { token: admin, body: {} })
  check('验收应用删除联动清库（密钥文件整体消失）', appCredAppDel.ok && !existsSync(join(DATA_DIR, 'secrets', 'app', `${appCredAppId}.json`)),
    // 诊断增强（2026-11-02 合并回归排查）：失败时带上 HTTP 状态/错误/残留文件/目录清单/应用存否五要素，避免空详情死胡同
    (() => {
      const secretsDir = join(DATA_DIR, 'secrets', 'app')
      let dirList = '<missing>'
      try { dirList = readdirSync(secretsDir).join(',') } catch { /* 目录不存在 */ }
      const keyPath = join(secretsDir, `${appCredAppId}.json`)
      let head = ''
      try { head = readFileSync(keyPath, 'utf8').replaceAll(/\s+/g, ' ').slice(0, 80) } catch { /* 无残留 */ }
      return JSON.stringify({
        status: appCredAppDel.status, error: appCredAppDel.error ?? null,
        residual: existsSync(keyPath), head, dir: dirList.slice(0, 120), deleted: appCredAppDel.data?.deleted,
      }).slice(0, 400)
    })())

  mcpStub.close()
  ddStub.close()

  // ================================================================ M0-2：钱包/分账功能面下线回归
  section('M0-2 钱包/分账下线回归（全端点 404 / 权限点移除）')
  const idemOwner = (await api('GET', '/api/iam/orgs', { token: admin })).data[0]
  const billingWalletGone = await api('GET', '/api/billing/wallets/org/selftest-nonexistent', { token: admin })
  check('钱包查询端点已下线（404）', billingWalletGone.status === 404)
  const billingSettleGone = await api('POST', '/api/billing/settle', { token: admin, body: { period: '2026-09' } })
  check('账期结转端点已下线（404）', billingSettleGone.status === 404)
  const billingLedgerGone = await api('GET', '/api/billing/ledger', { token: admin })
  check('分账分录端点已下线（404）', billingLedgerGone.status === 404)
  const iamPoints = (await api('GET', '/api/iam/permissions', { token: admin })).data
  const allPoints = JSON.stringify(iamPoints)
  check('billing.* 权限点已从矩阵移除', !allPoints.includes('billing.read') && !allPoints.includes('billing.write') && !allPoints.includes('billing.admin'), allPoints.slice(0, 120))

  // ================================================================ 评审缺陷修复回归（replay 不双计 / 死信）
  section('评审缺陷修复回归（replay 不双计 / 死信端点可用）')
  const reconcileBeforeReplay = await api('POST', '/api/usage/reconcile', { token: admin })
  const replayAll = await api('POST', '/api/usage/replay', { token: admin, body: { from: new Date(Date.now() - 40 * 86_400_000).toISOString() } })
  const reconcileAfterReplay = await api('POST', '/api/usage/reconcile', { token: admin })
  check('replay 重放不双计（消费水位幂等，投影/口径一致）', replayAll.ok && replayAll.data.replayed > 0
    && reconcileBeforeReplay.data.reconciliation.mismatch === false
    && reconcileAfterReplay.data.reconciliation.mismatch === false
    && JSON.stringify(reconcileAfterReplay.data.reconciliation.projections) === JSON.stringify(reconcileBeforeReplay.data.reconciliation.projections))

  const dlRetry = await api('POST', '/api/usage/dead-letters/retry', { token: admin })
  check('死信重投端点可用（真实执行重试）', dlRetry.ok && typeof dlRetry.data.retried === 'number')

  // ================================================================ 认证加固回归（轮换宽限 / 暴力破解锁定 / OIDC 收敛）
  section('认证加固回归（密钥轮换宽限期 / 暴力破解锁定 / OIDC scope+PKCE）')
  const preRotate = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
  const rotate = await api('POST', '/api/authn/rotate-secret', { token: admin })
  const oldTokenAlive = await api('GET', '/api/auth/me', { token: preRotate.data.token })
  check('密钥轮换宽限期：存量令牌不掉线（24h 验签兼容）', rotate.ok && rotate.data.graceHours === 24 && oldTokenAlive.ok)

  const postRotateLogin = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
  const postRotateMe = await api('GET', '/api/auth/me', { token: postRotateLogin.data.token })
  check('轮换后新签发令牌可用（新密钥签名）', postRotateLogin.ok && postRotateMe.ok)

  const brute = await api('POST', '/api/iam/users', { token: admin, body: { username: 'brutetest', displayName: '暴力破解测试', orgId: idemOwner.id, title: '测试' } })
  for (let i = 0; i < 5; i++) {
    await api('POST', '/api/auth/login', { body: { username: 'brutetest', password: 'wrong-password' } })
  }
  const bruteLocked = await api('POST', '/api/auth/login', { body: { username: 'brutetest', password: brute.data.initialPassword } })
  check('连续失败 5 次后锁定（正确口令也暂拒 + 告警）', brute.ok && bruteLocked.status === 401 && JSON.stringify(bruteLocked.error).includes('锁定'))

  const lockAlerts = await api('GET', '/api/audit/alerts', { token: admin })
  check('锁定触发已入告警中心（暴力破解可观测）', lockAlerts.ok && JSON.stringify(lockAlerts.data.alerts).includes('登录失败锁定'))

  // OIDC scope 白名单 / PKCE 强制 / Basic+Post 双认证的回归断言已并入第 6 步（浏览器授权流重写）

  // ================================================================ 资产运营（企业 AI 资产台账 / 健康巡检 / 成本报表）
  section('资产运营（统一台账 / 健康巡检 / 成本报表）')
  const assetsInv = await api('GET', '/api/assets/inventory', { token: admin })
  check('资产台账（五类资产统一盘点）', assetsInv.ok && assetsInv.data.total > 0
    && ['mcp', 'agent', 'app', 'skill', 'model'].every((t) => assetsInv.data.items.some((i) => i.type === t)))
  const assetsReport = await api('GET', '/api/assets/report?days=30', { token: admin })
  check('资产成本报表（Top 资产 / 主体分摊 / 日趋势）', assetsReport.ok && assetsReport.data.topResources.length > 0
    && assetsReport.data.byPrincipal.length > 0 && assetsReport.data.byDay.length > 0
    && assetsReport.data.totals.count > 0)
  const assetsHealth = await api('POST', '/api/assets/healthcheck', { token: admin })
  check('资产健康巡检（批量探活并留审计）', assetsHealth.ok && assetsHealth.data.checked > 0 && Array.isArray(assetsHealth.data.items))
  const assetsTyped = await api('GET', '/api/assets/inventory?type=mcp&days=7', { token: admin })
  check('台账筛选（类型 + 窗口）', assetsTyped.ok && assetsTyped.data.items.every((i) => i.type === 'mcp'))

  const benefit = await api('GET', '/api/assets/benefit?days=30', { token: admin })
  check('成本穿透（零价快照口径：内部成本逐行恒等，无收入/毛利）', benefit.ok && benefit.data.rows.length >= 1
    && benefit.data.totals.cost_cents === benefit.data.rows.reduce((s, r) => s + r.cost_cents, 0)
    && benefit.data.rows.every((row) => row.margin_cents === undefined && row.charge_cents === undefined))

  // ================================================================ Skill 市场
  section('Skill 市场流水线')
  const malicious = await api('POST', '/api/skills', { token: dev, body: { name: '恶意清理脚本', content: '# 清理\n```sh\nrm -rf / --no-preserve-root\n```\n调用了 sk-1234567890abcdef1234567890', category: '通用', version: '1.0.0' } })
  check('静态扫描拦截恶意提交（自动驳回）', malicious.ok && malicious.data.status === 'rejected')

  const submit = await api('POST', '/api/skills', { token: dev, body: { name: '自测报告助手', summary: '生成自测报告', content: '# 自测报告助手\n\n## 何时使用\n每日自测后生成报告。\n\n## 步骤\n1. 汇总断言结果\n2. 生成 Markdown 报告', category: '办公提效', version: '1.0.0' } })
  check('正常提交进入待审批', submit.ok && submit.data.status === 'pending_approval')
  const skillId = submit.data.id

  const approveDomain = await api('POST', `/api/skills/${skillId}/approve`, { token: admin, body: { decision: 'approve', level: 'domain', opinion: '业务适用' } })
  check('领域审批通过', approveDomain.ok)

  const publish = await api('POST', `/api/skills/${skillId}/publish`, { token: admin, body: {} })
  check('版本化上架', publish.ok && publish.data.status === 'published')

  const agentsList = (await api('GET', '/api/agents', { token: admin })).data.agents
  const targetAgent = agentsList.find((a) => a.slug === 'dev-coder')
  const install = await api('POST', `/api/skills/${skillId}/install`, { token: dev, body: { agentId: targetAgent.id } })
  check('安装到 Agent（依赖登记）', install.ok && install.data.stats.installs >= 1)

  const agentDetail = await api('GET', `/api/agents/${targetAgent.id}`, { token: admin })
  check('Agent 关联 Skill 自动回填', agentDetail.ok && (agentDetail.data.attrs.skills ?? []).includes('自测报告助手'))

  const download = await api('POST', `/api/skills/${skillId}/download`, { token: dev, body: {} })
  check('下载留痕（返回 SKILL.md）', download.ok && download.data.content.includes('自测报告助手'))

  // 计量管道（观测补齐）：skill 下载/安装进 usage 事件（skill:<ID>，默认零费率）
  const skillUsage = await api('GET', '/api/usage/events?resource=' + encodeURIComponent(`skill:${skillId}`), { token: admin })
  check('Skill 下载/安装进计量管道（skill:<ID> 资源，零费率）', skillUsage.ok && skillUsage.data.total >= 2 && (skillUsage.data.items[0].pricing?.charge_cents ?? -1) === 0)
  const skillMeters = skillUsage.data.items.flatMap((event) => event.meters.map((meter) => meter.key))
  check('skill 事件 meters 含价格簿计价键 calls（硬校验下内部管道存活）', skillMeters.includes('calls') && skillMeters.includes('downloads') && skillMeters.includes('installs'))
  const skillExternalMeter = await api('POST', '/api/usage/record', { token: admin, body: { org: tenantOrg.data.id, subject: `agent:${targetAgent.id}`, principal: `org:${tenantOrg.data.id}`, resource: `skill:${skillId}`, meters: [{ key: 'calls', value: 1, unit: '次' }], idempotency_key: 'test-usage-skill-external-1' } })
  check('外部 usage record 可上报 skill:<ID> 资源（默认价格簿放行）', skillExternalMeter.ok)
  const heat = await api('GET', '/api/skills/usage-heatmap?days=30', { token: admin })
  const heatRow = (heat.data?.skills ?? []).find((s) => s.id === skillId)
  check('技能热力图（skill × 日使用矩阵，含安装/下载/外部上报）', heat.ok && heatRow?.total >= 2 && Array.isArray(heatRow?.cells) && heatRow.cells.length === 30 && (heat.data.maxCell ?? 0) >= 1)

  // —— 已上架 Skill 信息编辑与资源包重传（作者本人/管理员可操作，非作者开发者拒绝） ——
  const otherDevLogin = await api('POST', '/api/auth/login', { body: { username: 'linxm', password: 'Ybk@2026' } })
  const otherDev = otherDevLogin.data?.token
  const editDenied = await api('PATCH', `/api/skills/${skillId}`, { token: otherDev, body: { summary: '越权改简介' } })
  check('非作者且无管理权的开发者编辑被拒（403）', editDenied.status === 403)
  const repkgDenied = await api('PUT', `/api/skills/${skillId}/package`, { token: otherDev, body: { packageBase64: Buffer.from('PK\x03\x04evil', 'latin1').toString('base64') } })
  check('非作者重传资源包被拒（403）', repkgDenied.status === 403)

  const editByAuthor = await api('PATCH', `/api/skills/${skillId}`, { token: dev, body: { summary: '生成自测报告（已更新）', tags: ['自测', '报告'], description: '更新后的详细描述', applicableModels: ['deepseek-chat', 'deepseek-reasoner'], visibility: 'all', authorName: '陈默（示范作者）' } })
  check('作者编辑市场信息（slug 与版本不变，不重走审批）', editByAuthor.ok && editByAuthor.data.summary === '生成自测报告（已更新）' && editByAuthor.data.tags.join(',') === '自测,报告' && editByAuthor.data.status === 'published')
  check('作者名称可改（仅展示署名，authorId 归属不变）', editByAuthor.ok && editByAuthor.data.authorName === '陈默（示范作者）' && editByAuthor.data.authorId === devLogin.data.user.id)
  const editEmptyAuthor = await api('PATCH', `/api/skills/${skillId}`, { token: dev, body: { authorName: '  ' } })
  check('编辑校验：作者名称不可为空白', !editEmptyAuthor.ok)
  const editByAdmin = await api('PATCH', `/api/skills/${skillId}`, { token: admin, body: { category: '研发效能' } })
  // 2026-10-28 分类统一：「研发效能」为遗留值，写入侧对齐标准分类「研发」，原值保留进 tags（platform-core taxonomy）
  check('管理员（skill.publish）可编辑任意 Skill 信息', editByAdmin.ok && editByAdmin.data.category === '研发' && (editByAdmin.data.tags ?? []).includes('研发效能'))
  const editEmptyName = await api('PATCH', `/api/skills/${skillId}`, { token: dev, body: { name: '   ' } })
  check('编辑校验：名称不可为空白', !editEmptyName.ok)

  const skillZipBase64 = Buffer.from('PK\x03\x04skill-package-v2-content', 'latin1').toString('base64')
  const repkgBadZip = await api('PUT', `/api/skills/${skillId}/package`, { token: dev, body: { packageBase64: Buffer.from('definitely-not-a-zip', 'latin1').toString('base64') } })
  check('资源包校验：非 ZIP 内容被拒（PK 魔数）', !repkgBadZip.ok)
  const repkg = await api('PUT', `/api/skills/${skillId}/package`, { token: dev, body: { packageBase64: skillZipBase64 } })
  check('作者重传资源包（原地替换，版本号不变）', repkg.ok && repkg.data.skill.currentVersion === '1.0.0' && repkg.data.skill.status === 'published' && repkg.data.package?.sizeBytes === Buffer.from('PK\x03\x04skill-package-v2-content', 'latin1').length)
  const repkgDetail = await api('GET', `/api/skills/${skillId}`, { token: admin })
  const repkgVersion = repkgDetail.data?.versions?.find((v) => v.status === 'published')
  check('资源包替换落库（已发布版本 packageBase64/登记同步更新）', repkgDetail.ok && repkgVersion?.packageBase64 === skillZipBase64 && !!repkgVersion?.package?.uploadedAt)

  const deprecateNoReason = await api('POST', `/api/skills/${skillId}/deprecate`, { token: admin, body: {} })
  check('弃用未填原因被拒（护栏，下架分析口径依赖）', !deprecateNoReason.ok)

  const deprecate = await api('POST', `/api/skills/${skillId}/deprecate`, { token: admin, body: { reason: '自测弃用' } })
  check('弃用并触发存量引用告警', deprecate.ok && deprecate.data.skill.status === 'deprecated' && deprecate.data.referencingAgents.length >= 1)
  check('弃用原因落库持久化（详情与下架分析可见）', deprecate.ok && deprecate.data.skill.deprecatedReason === '自测弃用' && !!deprecate.data.skill.deprecatedAt)

  const alerts = await api('GET', '/api/audit/alerts', { token: admin })
  check('存量引用告警已入告警中心', alerts.ok && JSON.stringify(alerts.data.alerts).includes('自测报告助手'))

  const rate = await api('POST', `/api/skills/${skillId}/rate`, { token: dev, body: { stars: 5 } })
  check('评分', rate.ok && rate.data.stats.rating === 5)

  // ================================================================ Agent 生命周期（L4 审批）
  section('Agent 本体生命周期')
  const opsLogin = await api('POST', '/api/auth/login', { body: { username: 'ops', password: 'Ybk@2026' } })
  check('资源管理员登录', opsLogin.ok)
  const ops = opsLogin.data.token
  const agentCreate = await api('POST', '/api/agents', { token: ops, body: { name: '自测机器人', attrs: { description: '自测用机器人', model: 'deepseek-chat', riskLevel: 'low', avatar: '🧪' } } })
  check('注册 Agent（并颁发机器凭证）', agentCreate.ok && agentCreate.data.credential.clientId)
  const selfAgent = agentCreate.data.agent

  // 凭证默认 usage.write（Agent 自推计量能力）+ 机器身份读台账入审计（agent.verify）
  const selfAgentCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: agentCreate.data.credential.clientId, clientSecret: agentCreate.data.credential.clientSecret } })
  check('新注册 Agent 凭证默认含 usage.write', selfAgentCc.ok && selfAgentCc.data.principal.scopes.includes('usage.write'))
  check('新注册 Agent 凭证默认含 agent.write（自主提报更新）', selfAgentCc.ok && selfAgentCc.data.principal.scopes.includes('agent.write'))
  check('新注册 Agent 凭证默认含 modelgw.invoke（模型网关调用）', selfAgentCc.ok && selfAgentCc.data.principal.scopes.includes('modelgw.invoke'))
  const agentSelfUpdate = await api('PATCH', `/api/agents/${selfAgent.id}`, { token: selfAgentCc.data.token, body: { attrs: { description: '自测用机器人（资料已由 Agent 凭自身凭证提报更新）' } } })
  check('Agent 凭自身凭证提报更新资料 200（agent.write 生效）', agentSelfUpdate.ok && String(agentSelfUpdate.data.attrs['description']).includes('凭自身凭证提报更新'), JSON.stringify(agentSelfUpdate.error))

  const agentVerifyLogs = () => api('GET', '/api/audit/logs?type=auth&resourceType=agent&limit=200', { token: admin })
  const verifyBefore = (await agentVerifyLogs()).data.items.filter((log) => log.action === 'agent.verify').length
  await api('GET', '/api/agents', { token: admin })
  const verifyAfterHuman = (await agentVerifyLogs()).data.items.filter((log) => log.action === 'agent.verify').length
  check('人类读台账不产生 agent.verify（噪音控制）', verifyAfterHuman === verifyBefore)

  const machineAgentsList = await api('GET', '/api/agents', { token: selfAgentCc.data.token })
  check('机器令牌读台账 200（接入验证「发一句话」）', machineAgentsList.ok)
  const verifyLogs = (await agentVerifyLogs()).data.items
  check('机器身份读台账入审计（agent.verify 留痕）', verifyLogs.some((log) => log.action === 'agent.verify' && log.actorId === selfAgentCc.data.principal.id))

  // 运营数据提报（Agent 接入义务，与 AI 应用 metrics-report 同级，2026-08）
  const agentReport1 = await api('POST', `/api/agents/${selfAgent.id}/metrics-report`, { token: selfAgentCc.data.token, body: { dau: 3, sessions: 5, userIds: ['u001', 'u002'] } })
  check('Agent 凭自身凭证提报运营数据 200（agent.write 生效，首提即"发一句话"）', agentReport1.ok && agentReport1.data.sessions === 5 && agentReport1.data.dau === 3, JSON.stringify(agentReport1.error))
  const agentReport2 = await api('POST', `/api/agents/${selfAgent.id}/metrics-report`, { token: selfAgentCc.data.token, body: { dau: 2, sessions: 1, userIds: ['u002', 'u003'] } })
  check('Agent 提报语义：同日 dau 取最大、会话累加、用户哈希去重并集', agentReport2.ok && agentReport2.data.dau === 3 && agentReport2.data.sessions === 6 && agentReport2.data.uniqueUsers === 3, JSON.stringify(agentReport2.error ?? agentReport2.data))
  const agentReportBad = await api('POST', `/api/agents/${selfAgent.id}/metrics-report`, { token: selfAgentCc.data.token, body: { dau: -1 } })
  check('Agent 提报校验：负数 dau 被拒', !agentReportBad.ok)
  const agentReportBadDate = await api('POST', `/api/agents/${selfAgent.id}/metrics-report`, { token: selfAgentCc.data.token, body: { dau: 1, date: '2026/08/01' } })
  check('Agent 提报校验：非法 date 被拒', !agentReportBadDate.ok)
  const agentReportGhost = await api('POST', '/api/agents/agt_ghost/metrics-report', { token: selfAgentCc.data.token, body: { dau: 1 } })
  check('Agent 提报校验：不存在的 Agent 被拒', !agentReportGhost.ok)
  const agentReportTool = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'agent_metrics_report', args: { agentId: selfAgent.id, dau: 4, sessions: 2 } } })
  check('工具 agent_metrics_report 上报（同日 dau 取最大）', agentReportTool.ok && agentReportTool.data.isError === false && agentReportTool.data.value.reported === true && agentReportTool.data.value.metrics.dau === 4)
  const agentEntryUrl = await api('PATCH', `/api/agents/${selfAgent.id}`, { token: selfAgentCc.data.token, body: { attrs: { entryUrl: 'https://bot.example.com/chat' } } })
  check('Agent 自主提报交互界面地址（entryUrl 白名单生效）', agentEntryUrl.ok && agentEntryUrl.data.attrs['entryUrl'] === 'https://bot.example.com/chat', JSON.stringify(agentEntryUrl.error))

  // 自推计量归属对齐（C22 归属校验）：机器主体只能申报自身 agent:<refId>，且事件 org 必须
  // 等于该 Agent 的登记组织（创建路由强制 orgId=创建者组织，此处按台账回读，不硬编码）
  const selfAgentOrg = (await api('GET', '/api/agents', { token: admin })).data.agents.find((a) => a.id === selfAgent.id)?.orgId ?? ''
  const agentSelfMeter = await api('POST', '/api/usage/record', { token: selfAgentCc.data.token, body: { org: selfAgentOrg, subject: `agent:${selfAgent.id}`, principal: `org:${selfAgentOrg}`, resource: 'mcp:real-backend', meters: [{ key: 'tokens', value: 100, unit: 'token' }], idempotency_key: 'test-usage-agent-self-1' } })
  check('Agent 机器令牌自推计量 200（usage.write 生效，零价快照）', agentSelfMeter.ok && agentSelfMeter.data.pricing.charge_cents === 0, JSON.stringify(agentSelfMeter.error ?? agentSelfMeter.data?.pricing))

  // Agent 接入提示词（与 app 同构：rotate 轮换机器凭证携带完整凭证；首行含关键词「提示词」供 connector 触发）
  const agentPrompt = await api('POST', `/api/agents/${selfAgent.id}/onboarding-prompt`, { token: selfAgentCc.data.token, body: { rotate: true } })
  check('Agent 接入提示词：凭自身凭证 rotate 生成（含新 secret 与关键词「提示词」）',
    agentPrompt.ok && agentPrompt.data.rotated === true && agentPrompt.data.prompt.includes('提示词')
    && Boolean(agentPrompt.data.credential.clientSecret) && agentPrompt.data.prompt.includes(agentPrompt.data.credential.clientSecret),
    JSON.stringify(agentPrompt.error))
  const agentPromptCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: agentPrompt.data.credential.clientId, clientSecret: agentPrompt.data.credential.clientSecret } })
  check('Agent 接入提示词：轮换后新 secret 可换牌', agentPromptCc.ok && Boolean(agentPromptCc.data?.token), JSON.stringify(agentPromptCc.error))
  // 用换牌后的新令牌复核 agent.write 仍生效（自提报更新资料）
  const agentPromptSelfPatch = await api('PATCH', `/api/agents/${selfAgent.id}`, { token: agentPromptCc.data.token, body: { attrs: { description: '自测用机器人（提示词轮换后仍可自更新）' } } })
  check('Agent 接入提示词：轮换后凭新令牌 PATCH 资料 200', agentPromptSelfPatch.ok, JSON.stringify(agentPromptSelfPatch.error))
  // 轮换已吊销旧令牌：就地刷新 selfAgentCc 的令牌，保证本段后续用例继续持有有效凭证
  selfAgentCc.data.token = agentPromptCc.data.token

  // 调用统计口径补全（2026-08）：usage.recorded 回灌 + 防双计
  const agentMetricsAfterSelfMeter = await api('GET', `/api/agents/${selfAgent.id}`, { token: admin })
  check('防双计①：自推 mcp:* 计量不回灌调用台账（MCP 口径归 McpInvoked，宁缺勿重）',
    agentMetricsAfterSelfMeter.ok && agentMetricsAfterSelfMeter.data.metrics.calls === 0 && (agentMetricsAfterSelfMeter.data.metrics.gwCalls ?? 0) === 0,
    JSON.stringify(agentMetricsAfterSelfMeter.data?.metrics))

  // 模型网关回灌闭环：Agent 凭自身凭证调用模型网关 → usage.recorded(subject=agent:<id>) 回灌调用台账
  const agentModelStub = createServer(async (req, res) => {
    if (req.url.endsWith('/chat/completions')) {
      await readBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'agent 模型网关回灌 stub' } }], usage: { prompt_tokens: 120, completion_tokens: 1500 } }))
      return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise((resolve) => agentModelStub.listen(0, '127.0.0.1', resolve))
  const agentModelPort = agentModelStub.address().port
  const agentModelReg = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'ds-stub-agent', displayName: 'Agent 回灌验证', provider: 'deepseek', endpoint: `http://127.0.0.1:${agentModelPort}/v1`, apiKey: 'stub-key', costCentsPerKTokens: 0 } })
  check('Agent 验证模型目录登记', agentModelReg.ok)
  const agentGwInvoke = await api('POST', '/api/modelgw/invoke', { token: selfAgentCc.data.token, body: { model: 'ds-stub-agent', messages: [{ role: 'user', content: 'hi' }], orgId: tenantOrg.data.id } })
  check('Agent 凭自身凭证调用模型网关 200（modelgw.invoke 生效）', agentGwInvoke.ok && agentGwInvoke.data.outputTokens === 1500, JSON.stringify(agentGwInvoke.error ?? agentGwInvoke.data))
  const agentGwEvent = await api('GET', '/api/usage/events?resource=model:ds-stub-agent', { token: admin })
  check('网关计量事件主体为 agent:<id>（回灌依据）', agentGwEvent.ok && agentGwEvent.data.items[0]?.subject === `agent:${selfAgent.id}`, JSON.stringify(agentGwEvent.data?.items?.[0]?.subject))
  const agentMetricsAfterGw = await api('GET', `/api/agents/${selfAgent.id}`, { token: admin })
  check('模型网关调用回灌 Agent 台账（calls=1 / tokens=1620 / gwCalls=1）',
    agentMetricsAfterGw.ok && agentMetricsAfterGw.data.metrics.calls === 1 && agentMetricsAfterGw.data.metrics.tokens === 1620 && agentMetricsAfterGw.data.metrics.gwCalls === 1,
    JSON.stringify(agentMetricsAfterGw.data?.metrics))
  agentModelStub.close()

  // ================================================================ M0-3 用量透明月报（J4 契约）
  section('M0 用量透明月报（J4：部门/Agent/Skill tokens 三维聚合 + CSV 自助导出）')
  const j4Month = new Date().toISOString().slice(0, 7)
  const j4Report = await api('GET', `/api/usage/report/monthly?month=${j4Month}`, { token: admin })
  check('J4 月报聚合可用（当月 totals 事件数 > 0）', j4Report.ok && j4Report.data.month === j4Month && j4Report.data.totals.events > 0, JSON.stringify(j4Report).slice(0, 200))
  check('J4 部门维度（org 归口聚合，tokens 汇总）', j4Report.ok && j4Report.data.byOrg.some((r) => r.dimension === tenantOrg.data.id && r.tokens > 0), JSON.stringify(j4Report.data?.byOrg))
  check('J4 Agent 维度（subject=agent:* 聚合）', j4Report.ok && j4Report.data.byAgent.some((r) => r.dimension === `agent:${selfAgent.id}` && r.tokens > 0), JSON.stringify(j4Report.data?.byAgent))
  check('J4 Skill 维度（resource=skill:* 聚合）', j4Report.ok && j4Report.data.bySkill.length >= 1)
  check('J4 零价快照口径（totals charge 恒 0）', j4Report.ok && j4Report.data.totals.charge_cents === 0)
  const j4Csv = await rawReq('GET', `/api/usage/report/monthly?month=${j4Month}&format=csv`, { headers: { authorization: `Bearer ${admin}` } })
  check('J4 CSV 自助导出（text/csv + BOM + 表头）', j4Csv.status === 200 && (j4Csv.headers['content-type'] ?? '').includes('text/csv') && j4Csv.body.startsWith('\ufeff') && j4Csv.body.includes('维度,维度值,事件数,tokens'), JSON.stringify({ status: j4Csv.status, ct: j4Csv.headers['content-type'], head: j4Csv.body.slice(0, 80) }))

  const j4OrgTokenSum = j4Report.data.byOrg.reduce((sum, row) => sum + row.tokens, 0)
  check('J4 三维自洽（QA B-01：totals.tokens = ΣbyOrg.tokens，修复前差 176 倍）',
    j4OrgTokenSum === j4Report.data.totals.tokens && j4Report.data.totals.tokens > 0,
    JSON.stringify({ totals: j4Report.data.totals.tokens, orgSum: j4OrgTokenSum }))

  const onlineTooEarly = await api('POST', `/api/agents/${selfAgent.id}/transition`, { token: ops, body: { action: 'online' } })
  check('缺治理属性不可上线（校验）', !onlineTooEarly.ok)

  await api('PATCH', `/api/agents/${selfAgent.id}`, { token: ops, body: { attrs: { dataClass: 'internal', trialGroups: ['灰度试点组'] } } })
  // QA-04 回归（外部 QA-20261014）：update 校验合并后的完整 attrs，required 与 create 同等强制
  const clearRequiredDesc = await api('PATCH', `/api/agents/${selfAgent.id}`, { token: ops, body: { attrs: { description: '' } } })
  check('QA-04 回归：PATCH 清空必填描述被 400 拒绝（update 不得绕过 required）',
    !clearRequiredDesc.ok && (JSON.stringify(clearRequiredDesc.error).includes('必填') || JSON.stringify(clearRequiredDesc.error).includes('description')),
    JSON.stringify(clearRequiredDesc.error))
  const descSurvived = await api('GET', `/api/agents/${selfAgent.id}`, { token: ops })
  check('QA-04 回归：被拒后原描述原样保留（空值未落库）',
    descSurvived.ok && descSurvived.data.attrs.description !== '' && descSurvived.data.attrs.description !== undefined,
    JSON.stringify(descSurvived.data?.attrs?.description))

  // —— issue #8 回归：Agent 模型目录单一事实源（登记 / PATCH fail-fast + 上线门禁）——
  // 块内自备 stub 模型：无论所在实例目录状态（演示种子/基线空目录）断言都自洽
  const mdlKnown = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'selftest-mdl-known', displayName: '自测已知模型', provider: 'stub', endpoint: 'http://127.0.0.1:9/v1', apiKey: 'stub-key', costCentsPerKTokens: 0, status: 'online' } })
  check('#8 前置：登记已知 stub 模型（目录非空，校验生效前提）', mdlKnown.ok, JSON.stringify(mdlKnown.error))
  const modelUnknownCreate = await api('POST', '/api/agents', { token: ops, body: { name: '自测未知模型机器人', attrs: { description: '模型目录校验自测', model: 'deepseek-nothave', riskLevel: 'low' } } })
  check('#8：登记模型不在目录 → 400（错误含「模型目录」与可用 slugs 提示）',
    modelUnknownCreate.status === 400 && /模型目录/.test(modelUnknownCreate.error?.message ?? ''), JSON.stringify(modelUnknownCreate.error))
  const modelUnknownPatch = await api('PATCH', `/api/agents/${selfAgent.id}`, { token: ops, body: { attrs: { model: 'deepseek-nothave' } } })
  check('#8：PATCH 模型不在目录 → 400（存量值不动）',
    modelUnknownPatch.status === 400 && /模型目录/.test(modelUnknownPatch.error?.message ?? ''), JSON.stringify(modelUnknownPatch.error))
  const modelKnownPatch = await api('PATCH', `/api/agents/${selfAgent.id}`, { token: ops, body: { attrs: { model: 'selftest-mdl-known' } } })
  check('#8：PATCH 模型在目录 → 200', modelKnownPatch.ok && modelKnownPatch.data.attrs.model === 'selftest-mdl-known', JSON.stringify(modelKnownPatch.error))
  await api('PATCH', `/api/agents/${selfAgent.id}`, { token: ops, body: { attrs: { model: 'deepseek-chat' } } })
  const gateModel = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'selftest-tmp-mdl', displayName: '自测临时模型', provider: 'stub', endpoint: 'http://127.0.0.1:9/v1', apiKey: 'stub-key', costCentsPerKTokens: 0, status: 'online' } })
  check('#8 前置：登记临时模型', gateModel.ok, JSON.stringify(gateModel.error))
  const gateAgent = await api('POST', '/api/agents', { token: ops, body: { name: '自测上线门禁机器人', attrs: { description: '上线门禁模型校验自测', model: 'selftest-tmp-mdl', riskLevel: 'low', dataClass: 'internal', trialGroups: ['灰度试点组'], entryUrl: 'https://gate.example.com/chat' } } })
  check('#8 前置：模型在目录时登记/补全治理属性成功', gateAgent.ok, JSON.stringify(gateAgent.error))
  await api('POST', `/api/agents/${gateAgent.data.agent.id}/transition`, { token: ops, body: { action: 'submit_trial' } })
  const gateModelDel = await api('DELETE', `/api/modelgw/models/${gateModel.data.id}`, { token: admin })
  check('#8 前置：目录条目删除', gateModelDel.ok, JSON.stringify(gateModelDel.error))
  const gateOnline = await api('POST', `/api/agents/${gateAgent.data.agent.id}/transition`, { token: ops, body: { action: 'online' } })
  check('#8：上线门禁 fail-fast（模型已从目录删除 → 400 模型目录，不再「上线成功、派发才失败」）',
    gateOnline.status === 400 && /模型目录/.test(gateOnline.error?.message ?? ''), JSON.stringify(gateOnline.error))

  const trial = await api('POST', `/api/agents/${selfAgent.id}/transition`, { token: admin, body: { action: 'submit_trial' } })
  check('进入试运行', trial.ok && trial.data.status === 'trial')

  const obo = await api('POST', `/api/agents/${targetAgent.id}/obo-token`, { token: admin })
  check('on-behalf-of 令牌（act 链）', obo.ok && obo.data.actChain.length >= 1 && obo.data.actChain[0].type === 'human')

  const bind = await api('POST', `/api/agents/${selfAgent.id}/bindings`, { token: admin, body: { userId: devUser.id } })
  check('绑定用户（授权留痕）', bind.ok)

  // 平台授权直达（entry-ticket，2026-08）：签发授权边界 → 兑换身份 → 一次性/防伪造
  const auditorUserId = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('楚天阔'), { token: admin })).data.users[0].id
  const entryMachineDenied = await api('POST', `/api/agents/${selfAgent.id}/entry-ticket`, { token: selfAgentCc.data.token, body: {} })
  check('直达票据：机器身份签发被拒（human-only）', entryMachineDenied.status === 403, JSON.stringify(entryMachineDenied))
  const entryUnbound = await api('POST', `/api/agents/${selfAgent.id}/entry-ticket`, { token: auditor, body: {} })
  check('直达票据：未授权用户被拒 403（owner/绑定用户/管理员之外，使用即授权留痕）', entryUnbound.status === 403, JSON.stringify(entryUnbound))
  const bindAuditor = await api('POST', `/api/agents/${selfAgent.id}/bindings`, { token: admin, body: { userId: auditorUserId } })
  check('直达票据：绑定审计员（构造纯绑定用户路径）', bindAuditor.ok)
  const entryBound = await api('POST', `/api/agents/${selfAgent.id}/entry-ticket`, { token: auditor, body: {} })
  check('直达票据：绑定用户签发 200（一次性票据 + TTL）', entryBound.ok && entryBound.data.ticket.startsWith('etk_') && entryBound.data.ttlSeconds >= 30, JSON.stringify(entryBound.error))
  const redeemOk = await rawReq('POST', '/api/authn/entry-tickets/redeem', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: entryBound.data.ticket }),
  })
  const redeemBody = jsonBody(redeemOk)
  check('直达票据：公开端点兑换平台身份（sub/roles/tenant + refType/refId）',
    redeemOk.status === 200 && redeemBody.data?.refType === 'agent' && redeemBody.data?.refId === selfAgent.id
    && redeemBody.data?.identity?.sub === auditorUserId && Array.isArray(redeemBody.data?.identity?.roles) && Boolean(redeemBody.data?.identity?.tenant),
    JSON.stringify(redeemBody))
  const redeemReplay = await rawReq('POST', '/api/authn/entry-tickets/redeem', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: entryBound.data.ticket }),
  })
  check('直达票据：重放兑换被拒（一次性消费）', redeemReplay.status === 400, `${redeemReplay.status} ${redeemReplay.body.slice(0, 120)}`)
  check('直达票据：兑换响应放行跨域（任意 entryUrl 前端可读取，ACAO=*）', redeemReplay.headers['access-control-allow-origin'] === '*', JSON.stringify(redeemReplay.headers))
  const redeemPreflight = await rawReq('OPTIONS', '/api/authn/entry-tickets/redeem', {
    headers: { origin: 'http://192.168.0.7:6060', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  })
  check('直达票据：OPTIONS 预检 204 + ACAO（跨域浏览器流程可通）',
    redeemPreflight.status === 204 && redeemPreflight.headers['access-control-allow-origin'] === '*' && String(redeemPreflight.headers['access-control-allow-headers'] ?? '').includes('content-type'),
    `${redeemPreflight.status} ${JSON.stringify(redeemPreflight.headers)}`)
  const redeemForged = await rawReq('POST', '/api/authn/entry-tickets/redeem', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: 'etk_forged_0000000000000000000000000000000000000000' }),
  })
  check('直达票据：伪造票据被拒', redeemForged.status === 400)

  // L4 上线（R12 复议收窄，2026-10-14）：agent.online（雇佣语义）恢复职责分离——提交人自审 400；
  // 其余类型维持同人审批放开。上线单由第二审批人（approver02，super_admin）异人通过并自动执行。
  // （2026-09-15 曾全面放开同人审批；R12 依据 Paperclip「雇佣/高危需独立审批」语义收窄。）
  const onlineRequest = await api('POST', `/api/agents/${selfAgent.id}/transition`, { token: admin, body: { action: 'online', note: '自测上线' } })
  check('上线生成 L4 审批单', onlineRequest.ok && onlineRequest.data.approval.status === 'pending')

  const selfApprove = await api('POST', `/api/approvals/${onlineRequest.data.approval.id}/decide`, { token: admin, body: { decision: 'approve', opinion: '自审尝试（应被 R12 职责分离拦截）', confirmed: true } })
  check('R12：发起人自审 agent.online 被拒（职责分离恢复）', !selfApprove.ok && selfApprove.status === 400 && String(selfApprove.error?.message ?? '').includes('职责分离'), JSON.stringify(selfApprove.error ?? {}).slice(0, 160))
  const crossApprove = await api('POST', `/api/approvals/${onlineRequest.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '异人审批通过（R12 之后口径）', confirmed: true, finalReview: true } })
  check('异人审批通过并自动执行上线（R12 新口径）', crossApprove.ok && crossApprove.data.status === 'executed', JSON.stringify(crossApprove.error ?? {}).slice(0, 160))
  const agentAfter = await api('GET', `/api/agents/${selfAgent.id}`, { token: admin })
  check('Agent 状态已上线', agentAfter.data.status === 'online')

  // L4 下线：凭证吊销联动
  const credBefore = agentAfter.data.credential
  const offlineRequest = await api('POST', `/api/agents/${selfAgent.id}/transition`, { token: ops, body: { action: 'offline', note: '自测下线' } })
  check('下线生成 L4 审批单', offlineRequest.ok)
  await api('POST', `/api/approvals/${offlineRequest.data.approval.id}/decide`, { token: admin, body: { decision: 'approve', opinion: '同意下线', confirmed: true } })
  const agentOffline = await api('GET', `/api/agents/${selfAgent.id}`, { token: admin })
  check('下线后状态与凭证联动禁用', agentOffline.data.status === 'offline' && agentOffline.data.credential.status === 'disabled')
  void credBefore

  // ================================================================ A2A 点名直调与零价快照计量（C3 契约 · 2026-10-15 P0 回归）
  section('A2A 点名直调与零价快照计量（C3：usage 事件必落账，计量构造缺失不得被静默吞掉）')
  {
    const a2aStub = createServer((req, res) => {
      if ((req.url ?? '').endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A2A 自测应答：模型直答。' } }], usage: { prompt_tokens: 50, completion_tokens: 40 } }))
        return
      }
      res.writeHead(404).end('{}')
    })
    await new Promise((resolve) => a2aStub.listen(0, '127.0.0.1', resolve))
    // Agent attrs.model 为枚举校验（仅 deepseek-chat/reasoner/coder），故按 J1 段同款套路重指
    // deepseek-chat 目录条目到本段 stub（后续需要该模型的段落各自重指，互不影响）。
    const a2aModel = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'deepseek-chat', displayName: 'DeepSeek Chat（A2A 自测 stub）', provider: 'deepseek', endpoint: `http://127.0.0.1:${a2aStub.address().port}/v1`, apiKey: 'stub-key', costCentsPerKTokens: 0 } })
    check('A2A：deepseek-chat 重指本段 stub', a2aModel.ok, JSON.stringify(a2aModel.error))
    const runA2a = async () => {
      const a2aCreate = await api('POST', '/api/agents', { token: ops, body: { name: 'A2A计量自测机器人', attrs: { description: 'A2A 计量防回归自测', model: 'deepseek-chat', riskLevel: 'low' } } })
      check('A2A：测试 Agent 注册', a2aCreate.ok && Boolean(a2aCreate.data?.agent?.id), JSON.stringify(a2aCreate.error))
      if (!a2aCreate.ok || !a2aCreate.data?.agent?.id) return
      const a2aAgent = a2aCreate.data.agent
      await api('PATCH', `/api/agents/${a2aAgent.id}`, { token: ops, body: { attrs: { dataClass: 'internal', trialGroups: ['灰度试点组'], entryUrl: 'https://a2a-selftest.example.com/chat' } } })
      const a2aTrial = await api('POST', `/api/agents/${a2aAgent.id}/transition`, { token: ops, body: { action: 'submit_trial' } })
      check('A2A：测试 Agent 进入试运行', a2aTrial.ok && a2aTrial.data.status === 'trial', JSON.stringify(a2aTrial.error))
      const a2aOnlineReq = await api('POST', `/api/agents/${a2aAgent.id}/transition`, { token: ops, body: { action: 'online', note: 'A2A 自测上线' } })
      check('A2A：上线 L4 审批单创建', a2aOnlineReq.ok && a2aOnlineReq.data.approval?.status === 'pending', JSON.stringify(a2aOnlineReq.error ?? {}).slice(0, 160))
      if (!a2aOnlineReq.ok || !a2aOnlineReq.data?.approval?.id) return
      const a2aApprove = await api('POST', `/api/approvals/${a2aOnlineReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: 'A2A 自测上线（异人审批）', confirmed: true, finalReview: true } })
      check('A2A：异人审批通过并自动执行上线', a2aApprove.ok && a2aApprove.data.status === 'executed', JSON.stringify(a2aApprove.error ?? {}).slice(0, 160))
      const a2aBaseline = await api('GET', `/api/usage/events?resource=${encodeURIComponent(`agent:${a2aAgent.id}`)}`, { token: admin })
      check('A2A：调用前该 Agent 无计量事件（基线干净）', a2aBaseline.ok && a2aBaseline.data.total === 0, JSON.stringify(a2aBaseline.data?.total))
      const a2aInvoke = await api('POST', `/api/agents/${a2aAgent.id}/a2a/invoke`, { token: admin, body: { message: 'A2A 点名自测' } })
      check('A2A：点名直调成功（ok:true + reply + 模型回显）', a2aInvoke.ok && /A2A 自测应答/.test(a2aInvoke.data.reply ?? '') && a2aInvoke.data.model === 'deepseek-chat', JSON.stringify(a2aInvoke.error ?? a2aInvoke.data).slice(0, 200))
      const a2aEvents = await api('GET', `/api/usage/events?resource=${encodeURIComponent(`agent:${a2aAgent.id}`)}`, { token: admin })
      const a2aEvent = (a2aEvents.data.items ?? [])[0]
      check('A2A：零价快照计量事件落账（resource=agent:<id> · 零费率 nonbillable · calls=1 · charge=0）',
        a2aEvents.ok && Boolean(a2aEvent) && a2aEvent.resource === `agent:${a2aAgent.id}`
        && a2aEvent.meters?.[0]?.key === 'calls' && Number(a2aEvent.meters?.[0]?.value) === 1
        && a2aEvent.pricing?.charge_cents === 0 && a2aEvent.pricing?.rate?.nonbillable === true
        && a2aEvent.pricing?.rate?.pattern === 'agent:*',
        JSON.stringify(a2aEvent ?? a2aEvents.error ?? null).slice(0, 220))
      const a2aOfflineReq = await api('POST', `/api/agents/${a2aAgent.id}/transition`, { token: ops, body: { action: 'offline', note: 'A2A 自测收尾' } })
      await api('POST', `/api/approvals/${a2aOfflineReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: 'A2A 自测下线', confirmed: true } })
      const a2aRejected = await api('POST', `/api/agents/${a2aAgent.id}/a2a/invoke`, { token: admin, body: { message: '下线后再调' } })
      check('A2A：非 online 状态点名被拒（400 诚实拒绝，不下模型）', a2aRejected.status === 400 && /未上线/.test(a2aRejected.error?.message ?? ''), JSON.stringify(a2aRejected.error ?? a2aRejected.data).slice(0, 160))
    }
    try {
      await runA2a()
    } finally {
      a2aStub.close()
    }
  }

  // ================================================================ A2A/UHP 协作面（内网协作方案 C4 批次：卡片/任务/治理/协商/UHP）
  section('A2A/UHP 协作面（Agent Card 验签 / 八态任务 / 治理五查 / A0-A3 协商 / UHP 执行驱动）')
  {
    // 本段专用模型 stub：按消息内容分派行为（普通问答 / 协商 accept / 协商 counter / 慢任务）
    let stubMode = 'chat'
    const collabStub = createServer((req, res) => {
      if (!(req.url ?? '').endsWith('/chat/completions')) { res.writeHead(404).end('{}'); return }
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        let lastUser = ''
        try { const body = JSON.parse(raw); lastUser = (body.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n') } catch { /* 忽略 */ }
        const finish = (content) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 60, completion_tokens: 45 } }))
        }
        if (lastUser.includes('协作要约')) {
          finish(stubMode === 'accept' ? '{"decision":"accept","note":"边界清晰，可承接"}' : '{"decision":"counter","proposal":{"时限":"顺延一周"},"note":"当前排期冲突，建议顺延"}')
          return
        }
        if (lastUser.includes('慢任务标记')) {
          setTimeout(() => finish('慢任务完成（不应被交付，任务已取消）'), 2500)
          return
        }
        finish('协作面自测应答：任务执行回路正常。')
      })
    })
    await new Promise((resolve) => collabStub.listen(0, '127.0.0.1', resolve))
    // JSON-RPC 端点经 exchange.ok 包平台信封 {ok,data:{jsonrpc,result|error}}（guarded 400 时为 {ok:false,error}）——统一解包
    const rpc = async (path, token, body) => {
      const resp = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) })
      const payload = await resp.json().catch(() => ({}))
      const inner = payload.data && payload.data.jsonrpc ? payload.data : payload
      return { status: resp.status, result: inner.result, error: inner.error ?? (payload.ok === false ? payload.error : undefined), raw: payload }
    }
    const runCollab = async () => {
      // 重指 deepseek-chat 到本段 stub（各段互不影响惯例）
      const modelPoint = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'deepseek-chat', displayName: 'DeepSeek Chat（协作面自测 stub）', provider: 'deepseek', endpoint: `http://127.0.0.1:${collabStub.address().port}/v1`, apiKey: 'stub-key', costCentsPerKTokens: 0 } })
      check('协作面：deepseek-chat 重指本段 stub', modelPoint.ok, JSON.stringify(modelPoint.error))

      // -- 目标员工注册上线（A0 默认自治） + 协作调用方员工（机器凭证，可授 agent.a2a.invoke）
      const targetCreate = await api('POST', '/api/agents', { token: ops, body: { name: '协作目标员工', slug: 'collab-target', attrs: { description: 'A2A/UHP 协作面端到端自测目标', model: 'deepseek-chat', riskLevel: 'low', dataClass: 'internal', trialGroups: ['灰度试点组'], entryUrl: 'https://collab.example.com/chat' } } })
      check('协作面：目标员工注册', targetCreate.ok && Boolean(targetCreate.data?.agent?.id), JSON.stringify(targetCreate.error))
      const target = targetCreate.data.agent
      const targetTrial = await api('POST', `/api/agents/${target.id}/transition`, { token: ops, body: { action: 'submit_trial' } })
      const targetOnlineReq = await api('POST', `/api/agents/${target.id}/transition`, { token: ops, body: { action: 'online', note: '协作面自测上线' } })
      const targetOnline = await api('POST', `/api/approvals/${targetOnlineReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '协作面自测（异人审批）', confirmed: true, finalReview: true } })
      check('协作面：目标员工上线', targetTrial.ok && targetOnline.ok && targetOnline.data.status === 'executed', JSON.stringify(targetOnline.error ?? targetOnlineReq.error))

      // -- Agent Card 发现 + JWS(Ed25519) 先验签后采信
      const platformCard = await fetch(`${BASE}/.well-known/agent-card.json`).then((r) => r.json())
      check('协作面：平台目录卡公开可读（含 Ed25519 验签公钥）',
        platformCard.signingKeys?.[0]?.algorithm === 'Ed25519' && (platformCard.agents ?? []).some((a) => a.slug === 'collab-target'),
        JSON.stringify(platformCard).slice(0, 160))
      const cardResp = await fetch(`${BASE}/.well-known/agents/collab-target/agent-card.json`)
      const card = await cardResp.json() // 规范裸体（Q-31：well-known 不再包 {ok,data} 信封）
      const nodeCrypto = await import('node:crypto')
      const pub = nodeCrypto.createPublicKey({ key: Buffer.from(platformCard.signingKeys[0].publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
      const { signatures, ...cardBody } = card
      const signingInput = `${signatures[0].protected}.${Buffer.from(JSON.stringify(cardBody), 'utf8').toString('base64url')}`
      const jwsOk = nodeCrypto.verify(null, Buffer.from(signingInput), pub, Buffer.from(signatures[0].signature, 'base64'))
      check('协作面：单员工签名卡 JWS 验签通过（Ed25519）', cardResp.status === 200 && jwsOk && card.extensions[0].uri === 'urn:ybk:ext:governance:v1', `jws=${jwsOk}`)
      const ghostCard = await fetch(`${BASE}/.well-known/agents/not-exists/agent-card.json`)
      check('协作面：未上线/不存在员工卡片 404（不泄露存在性）', ghostCard.status === 404, `status=${ghostCard.status}`)

      // -- 目录检索 + 权限点
      const directory = await api('GET', '/api/a2a/directory?q=协作目标', { token: admin })
      check('协作面：目录检索命中在线员工（治理扩展字段透出）',
        directory.ok && directory.data.agents.some((a) => a.slug === 'collab-target' && a.autonomy === 'A0' && a.meteringSubject === `agent:${target.id}`),
        JSON.stringify(directory.error ?? directory.data?.agents?.length))

      // -- single_turn：人类（A1 映射）× A0 目标 → 平台代答闭环 + 协作链计量
      const stSend = await rpc(`/api/agents/collab-target/a2a`, admin, { method: 'message/send', params: { message: '单轮问答自测', metadata: { dataClass: 'internal' } } })
      const stTask = stSend.result?.task
      check('协作面：message/send 单轮问答 completed（A0 目标诚实代答）',
        Boolean(stTask) && stTask.state === 'completed' && /协作面自测应答/.test(stTask.artifacts?.[0]?.content ?? '') && stTask.mode === 'single_turn',
        JSON.stringify(stSend.error ?? stTask?.stateReason ?? 'no-result').slice(0, 200))
      if (!stTask) return // 单轮闭环未达成，后续链路断言无意义（防连锁 TypeError 掩盖首因）
      const stUsage = await api('GET', `/api/usage/collaborations?context=${encodeURIComponent(stTask.contextId)}`, { token: admin })
      check('协作面：协作链计量按 contextId 归集（calls=1 + tokens 随链）',
        stUsage.ok && stUsage.data.events.length >= 1 && stUsage.data.events[0].contextId === stTask.contextId && Number(stUsage.data.events[0].meters?.find((m) => m.key === 'calls')?.value) === 1,
        JSON.stringify(stUsage.error ?? stUsage.data?.events?.[0]?.meters).slice(0, 200))

      // -- 治理检查第 3 项：密级天花板越级拒绝
      await api('PATCH', `/api/agents/${target.id}`, { token: ops, body: { attrs: { a2aDataClassCeiling: 'public' } } })
      const ceilingHit = await rpc('/api/agents/collab-target/a2a', admin, { method: 'message/send', params: { message: '越级测试', metadata: { dataClass: 'internal' } } })
      check('协作面：密级越级走治理拒绝（-32002 DATA_CLASS_EXCEEDED，任务留痕 rejected）',
        ceilingHit.error?.code === -32002 && JSON.stringify(ceilingHit.error).includes('DATA_CLASS_EXCEEDED'),
        JSON.stringify(ceilingHit.error ?? ceilingHit.raw).slice(0, 200))
      await api('PATCH', `/api/agents/${target.id}`, { token: ops, body: { attrs: { a2aDataClassCeiling: 'internal' } } })

      // -- 协商矩阵拒绝：A3 调用方 × A0 目标（A0 不可被驱动执行）
      const callerCreate = await api('POST', '/api/agents', { token: ops, body: { name: '协作发起员工', attrs: { description: 'A2A 发起方自测', model: 'deepseek-chat', riskLevel: 'low', autonomy: 'A3' } } })
      const callerAgent = callerCreate.data.agent
      const callerPrincipal = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'collab-caller', refType: 'agent', refId: callerAgent.id, scopes: ['agent.a2a.invoke', 'agent.read'] } })
      check('协作面：发起方机器凭证（refType=agent + agent.a2a.invoke）', callerPrincipal.ok && callerPrincipal.data.clientId, JSON.stringify(callerPrincipal.error))
      const callerCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: callerPrincipal.data.clientId, clientSecret: callerPrincipal.data.clientSecret } })
      const callerToken = callerCc.data.token
      const matrixReject = await rpc('/api/agents/collab-target/a2a', callerToken, { method: 'message/send', params: { message: '请执行动作' } })
      check('协作面：协商矩阵拒绝（A3 调用方 × A0 目标 → NEGOTIATION_REJECTED）',
        matrixReject.error?.code === -32002 && JSON.stringify(matrixReject.error).includes('NEGOTIATION_REJECTED'),
        JSON.stringify(matrixReject.error ?? matrixReject.raw).slice(0, 200))

      // -- execute_report：目标升 A2 后，A3 调用方 × A2 目标 → UHP 真实执行闭环
      await api('PATCH', `/api/agents/${target.id}`, { token: ops, body: { attrs: { autonomy: 'A2' } } })
      const exSend = await rpc('/api/agents/collab-target/a2a', callerToken, { method: 'message/send', params: { message: '请汇总数据', metadata: { dataClass: 'internal' } } })
      const exTask = exSend.result?.task
      check('协作面：execute_report 经 UHP 执行 completed（发起方=agent 身份 + OBO 链留痕）',
        Boolean(exTask) && exTask.state === 'completed' && exTask.mode === 'execute_report' && exTask.callerSubject === `agent:${callerAgent.id}`,
        JSON.stringify(exSend.error ?? exTask?.stateReason ?? 'no-result').slice(0, 200))
      const exRespList = await api('GET', `/api/uhp/responses?taskId=${exTask.taskId}`, { token: admin })
      check('协作面：UHP 执行记录真实落账（completed + taskId 关联）',
        exRespList.ok && exRespList.data.items.length === 1 && exRespList.data.items[0].status === 'completed' && exRespList.data.items[0].task_id === exTask.taskId,
        JSON.stringify(exRespList.error ?? exRespList.data?.items?.[0]?.status).slice(0, 160))

      // -- tasks/cancel：慢任务取消（A2A_SYNC_WAIT_MS=800 下 send 提前返回 working 态 → 携 taskId 取消）
      const slowSend = await rpc('/api/agents/collab-target/a2a', admin, { method: 'message/send', params: { message: '慢任务标记：请慢慢处理' } })
      const slowTask = slowSend.result?.task
      check('协作面：同步等待超时返回在途任务（working 态 + taskId，供续查/取消）',
        Boolean(slowTask) && ['working', 'submitted'].includes(slowTask.state), JSON.stringify(slowSend.error ?? slowTask?.state ?? 'no-result'))
      if (!slowTask) return
      const slowCancel = await rpc('/api/agents/collab-target/a2a', admin, { method: 'tasks/cancel', params: { taskId: slowTask.taskId, reason: '自测取消' } })
      check('协作面：在途任务取消（canceled 终态，取消语义即时生效）',
        slowCancel.result?.task?.state === 'canceled', JSON.stringify(slowCancel.error ?? slowCancel.result?.task?.state ?? 'no-result'))
      const cancelUsage = await api('GET', `/api/usage/collaborations?context=${encodeURIComponent(slowTask.contextId)}`, { token: admin })
      check('协作面：取消任务不计入协作链计量（诚实口径）', cancelUsage.ok && (cancelUsage.data.events ?? []).length === 0, JSON.stringify(cancelUsage.data?.events?.length))
      await new Promise((resolve) => setTimeout(resolve, 3200)) // 等在途模型返回，验证取消后不交付

      // -- 审批规则命中 → auth_required → 审批通过幂等恢复执行
      const ruleCreate = await api('POST', '/api/a2a/rules', { token: admin, body: { name: '敏感词审批', matchKeyword: '转账', enabled: true } })
      check('协作面：审批规则创建（a2a.admin）', ruleCreate.ok, JSON.stringify(ruleCreate.error))
      const authSend = await rpc('/api/agents/collab-target/a2a', admin, { method: 'message/send', params: { message: '请执行转账操作审批流自测' } })
      const authTask = authSend.result?.task
      check('协作面：敏感规则命中 → auth_required 挂审批工单（而非直接拒绝）',
        Boolean(authTask) && authTask.state === 'auth_required' && Boolean(authTask.approvalId),
        JSON.stringify(authSend.error ?? authTask?.stateReason ?? 'no-result').slice(0, 200))
      const authApprove = await api('POST', `/api/approvals/${authTask.approvalId}/decide`, { token: approver, body: { decision: 'approve', opinion: '协作面审批恢复自测' } })
      let authAfterTask = null
      for (let i = 0; i < 25; i++) {
        const poll = await rpc('/api/agents/collab-target/a2a', admin, { method: 'tasks/get', params: { taskId: authTask.taskId } })
        authAfterTask = poll.result?.task
        if (authAfterTask && ['completed', 'failed', 'rejected'].includes(authAfterTask.state)) break
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      check('协作面：审批通过 → 任务幂等恢复执行至 completed（无重复执行）',
        authApprove.ok && authAfterTask?.state === 'completed' && authAfterTask.attempts === 1,
        JSON.stringify(authApprove.error ?? authAfterTask?.stateReason ?? 'no-result').slice(0, 200))

      // -- A3×A3 协商：要约 accept → 执行；counter → input_required → 超限 rejected
      await api('PATCH', `/api/agents/${target.id}`, { token: ops, body: { attrs: { autonomy: 'A3' } } })
      stubMode = 'accept'
      const negSend = await rpc('/api/agents/collab-target/a2a', callerToken, { method: 'message/send', params: { message: '协商任务：汇总Q3数据', metadata: { negotiation: { 任务边界: '只读汇总', 时限: '今天', 交付格式: '表格' } } } })
      const negTask = negSend.result?.task
      check('协作面：A3×A3 要约被接受 → 自动转执行 completed（协议行为真实）',
        Boolean(negTask) && negTask.state === 'completed' && negTask.negotiation?.status === 'accepted',
        JSON.stringify(negSend.error ?? negTask?.stateReason ?? 'no-result').slice(0, 220))
      stubMode = 'counter'
      let counterTask = null
      for (let round = 0; round < 4; round++) {
        const params = counterTask
          ? { message: `协商第 ${round + 1} 轮`, metadata: { taskId: counterTask.taskId } }
          : { message: '协商第 1 轮', metadata: { negotiation: { 边界: 'x' } } }
        const resp = await rpc('/api/agents/collab-target/a2a', callerToken, { method: 'message/send', params })
        counterTask = resp.result?.task
        if (!counterTask || counterTask.state === 'rejected') break
      }
      check('协作面：A3×A3 还价 → input_required，轮次超限（3 轮）→ rejected（协议超时拒绝）',
        counterTask?.state === 'rejected' && counterTask.negotiation?.round >= 3,
        JSON.stringify(counterTask?.state ?? counterTask ?? 'no-result').slice(0, 200))
      await api('PATCH', `/api/agents/${target.id}`, { token: ops, body: { attrs: { autonomy: 'A2' } } })

      // -- UHP 协议面：免鉴权发现 / 任务面越权 / 幂等重放
      const uhpDiscovery = await fetch(`${BASE}/v1/uhp`).then((r) => r.json())
      // P2-02：发现面为规范裸体（与 Agent Card well-known 同口径），外部客户端无需剥平台信封
      check('UHP：能力发现免鉴权且为规范裸体（uhp_version + conformance_class=core，无 {ok,data} 信封）',
        uhpDiscovery.uhp_version === '2026-08-11' && uhpDiscovery.conformance_class === 'core'
        && uhpDiscovery.ok === undefined && uhpDiscovery.data === undefined,
        JSON.stringify(uhpDiscovery).slice(0, 160))
      const uhpNoToken = await fetch(`${BASE}/v1/uhp/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'harness/x', input: 'hi' }) })
      check('UHP：任务面无令牌 401 fail-closed', uhpNoToken.status === 401, `status=${uhpNoToken.status}`)
      const weakPrincipal = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'uhp-weak', refType: 'external', scopes: ['agent.read'] } })
      const weakCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: weakPrincipal.data.clientId, clientSecret: weakPrincipal.data.clientSecret } })
      const uhpWeak = await fetch(`${BASE}/v1/uhp/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${weakCc.data.token}` }, body: JSON.stringify({ model: `harness/collab-target`, input: 'hi', metadata: { ybk_agent_id: 'collab-target' } }) })
      check('UHP：无 uhp.invoke 权限点 403（执行面最小权限）', uhpWeak.status === 403, `status=${uhpWeak.status}`)
      const uhpPrincipal = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'uhp-driver', refType: 'external', scopes: ['uhp.invoke', 'agent.read'] } })
      const uhpCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: uhpPrincipal.data.clientId, clientSecret: uhpPrincipal.data.clientSecret } })
      const uhpToken = uhpCc.data.token
      const uhpBody = { model: 'harness/collab-target', input: 'UHP 直调自测', metadata: { ybk_agent_id: 'collab-target' } }
      const uhpCall1 = await fetch(`${BASE}/v1/uhp/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${uhpToken}`, 'idempotency-key': 'uhp-selftest-idem-1' }, body: JSON.stringify(uhpBody) }).then((r) => r.json())
      const uhpCall2 = await fetch(`${BASE}/v1/uhp/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${uhpToken}`, 'idempotency-key': 'uhp-selftest-idem-1' }, body: JSON.stringify(uhpBody) }).then((r) => r.json())
      check('UHP：直调执行 completed + 同幂等键重放返回原 response（不重复执行）',
        uhpCall1.ok && uhpCall1.data.status === 'completed' && uhpCall2.data.id === uhpCall1.data.id,
        JSON.stringify(uhpCall1.error ?? uhpCall1.data?.status).slice(0, 160))
      const uhpToolsInject = await fetch(`${BASE}/v1/uhp/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${uhpToken}` }, body: JSON.stringify({ ...uhpBody, input: '越权原语测试', tools: [{ type: 'evil' }], metadata: { ybk_agent_id: 'collab-target' } }) }).then((r) => r.json())
      check('UHP：请求级 tools 注入接受但不生效（ignored_fields 留痕）',
        uhpToolsInject.ok && Array.isArray(uhpToolsInject.data.metadata.ignored_fields) && uhpToolsInject.data.metadata.ignored_fields.includes('tools'),
        JSON.stringify(uhpToolsInject.data?.metadata).slice(0, 160))

      // -- harness 注册表：显式 harness 绑定生效
      const harnessCreate = await api('POST', '/api/uhp/harnesses', { token: admin, body: { id: 'collab-target-harness', agentId: target.id, model: 'deepseek-chat', stepBudget: 4, dataClassCeiling: 'internal' } })
      check('UHP：configured harness 注册（uhp.admin）', harnessCreate.ok && harnessCreate.data.harness.id === 'collab-target-harness', JSON.stringify(harnessCreate.error))
      await api('PATCH', `/api/agents/${target.id}`, { token: ops, body: { attrs: { uhpHarnessRef: 'collab-target-harness' } } })
      const hSend = await rpc('/api/agents/collab-target/a2a', admin, { method: 'message/send', params: { message: '经显式 harness 执行' } })
      const hRespList = await api('GET', '/api/uhp/responses?taskId=' + hSend.result?.task?.taskId, { token: admin })
      check('UHP：uhpHarnessRef 指向的 harness 生效（执行记录 harnessId 一致）',
        Boolean(hSend.result?.task) && hSend.result.task.state === 'completed' && hRespList.data?.items?.[0]?.harness_id === 'collab-target-harness',
        JSON.stringify(hSend.error ?? hRespList.error ?? hSend.result?.task?.stateReason).slice(0, 200))
      await api('PATCH', `/api/agents/${target.id}`, { token: ops, body: { attrs: { uhpHarnessRef: '' } } })
      await api('DELETE', '/api/uhp/harnesses/collab-target-harness', { token: admin })

      // -- 声明-授权一致性巡检（漂移发现 + 告警）
      await api('PATCH', `/api/agents/${target.id}`, { token: ops, body: { attrs: { uhpHarnessRef: 'ghost-harness' } } })
      const patrol = await api('POST', '/api/a2a/patrol/run', { token: admin, body: {} })
      const driftFinding = patrol.data?.report?.findings?.find((f) => f.agentId === target.id)
      check('协作面：一致性巡检捕获 harness 漂移（ghost 引用 + 告警留痕）',
        patrol.ok && Boolean(driftFinding) && driftFinding.findings.some((f) => f.includes('ghost-harness')),
        JSON.stringify(patrol.error ?? patrol.data?.report?.driftAgents).slice(0, 200))
      await api('PATCH', `/api/agents/${target.id}`, { token: ops, body: { attrs: { uhpHarnessRef: '' } } })

      // -- 交付验收 + 履约视图（验收不轻信自报）
      const completedTaskId = negTask.taskId
      const rejectEarly = await api('POST', `/api/a2a/tasks/${slowTask.taskId}/acceptance`, { token: admin, body: { decision: 'accepted', reason: '未完成任务不可验收' } })
      check('协作面：非 completed 任务拒绝验收（不轻信自报）', rejectEarly.status === 400, `status=${rejectEarly.status}`)
      const acceptOk = await api('POST', `/api/a2a/tasks/${completedTaskId}/acceptance`, { token: admin, body: { decision: 'accepted', reason: '交付物符合要约边界' } })
      check('协作面：completed 任务人工验收通过（a2a.task.accept）',
        acceptOk.ok && acceptOk.data.task.acceptance?.status === 'accepted', JSON.stringify(acceptOk.error))
      const fulfillment = await api('GET', '/api/a2a/fulfillment', { token: admin })
      const fulfillmentRow = fulfillment.data?.fulfillment?.find((row) => row.agentId === target.id)
      check('协作面：履约视图回写（完成率/验收通过率/耗时 P95）',
        fulfillment.ok && fulfillmentRow && fulfillmentRow.received >= 6 && fulfillmentRow.acceptanceAccepted >= 1 && fulfillmentRow.p95DurationMs >= 0,
        JSON.stringify(fulfillment.data?.fulfillment?.map((r) => r.agentSlug)).slice(0, 200))

      // -- 任务治理视图 + SSE 面
      const taskList = await api('GET', '/api/a2a/tasks?agentId=' + target.id, { token: admin })
      check('协作面：任务治理视图可检索全链任务', taskList.ok && taskList.data.tasks.length >= 6, JSON.stringify(taskList.error))
      const sseNoToken = await fetch(`${BASE}/v1/a2a/tasks/${completedTaskId}/events`)
      check('协作面：任务 SSE 无 token 401 fail-closed', sseNoToken.status === 401, `status=${sseNoToken.status}`)
      const sseResp = await fetch(`${BASE}/v1/a2a/tasks/${completedTaskId}/events?token=${encodeURIComponent(admin)}`, { headers: { accept: 'text/event-stream' } })
      const sseHead = sseResp.headers.get('content-type') ?? ''
      await sseResp.body.cancel()
      check('协作面：任务 SSE 带 token 建立（text/event-stream + 历史快照）', sseResp.status === 200 && sseHead.includes('text/event-stream'), `status=${sseResp.status} ct=${sseHead}`)

      // -- 安全回归护栏（QA 2026-10-20 验收批次 P0/P1）：任务劫持 / 越权取消 / 正文脱敏 / 职责分离
      section('A2A/UHP 安全护栏（任务劫持 P0 / 越权取消 / 正文脱敏 / 验收职责分离）')
      {
        // 1) P0：外部 uhp.invoke 凭证不得绑定 A2A 任务（组B B-1 复现路径）
        const attacker = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'selftest-hijack', refType: 'external', scopes: ['uhp.invoke'] } })
        const attackerToken = (await api('POST', '/api/auth/client-credentials', { body: { clientId: attacker.data.clientId, clientSecret: attacker.data.clientSecret } })).data.token
        // 造一条「人在环审批等待中」的受害任务（A1 目标 × 人类发起 → execute_confirm）
        const victim = await api('POST', '/api/agents', { token: ops, body: { name: 'SELFTEST-A1目标', slug: 'selftest-a1', attrs: { description: '安全护栏', model: 'deepseek-chat', riskLevel: 'low', dataClass: 'internal', trialGroups: ['灰度试点组'], entryUrl: 'https://a1.example.com', autonomy: 'A1' } } })
        const victimAgent = victim.data.agent
        await api('POST', `/api/agents/${victimAgent.id}/transition`, { token: ops, body: { action: 'submit_trial' } })
        const victimOnline = await api('POST', `/api/agents/${victimAgent.id}/transition`, { token: ops, body: { action: 'online' } })
        await api('POST', `/api/approvals/${victimOnline.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '安全护栏上线', confirmed: true, finalReview: true } })
        const victimTask = (await rpc(`/api/agents/${victimAgent.slug}/a2a`, admin, { method: 'message/send', params: { message: '待审批任务（安全护栏）' } })).result?.task
        check('护栏前置：受害任务处于 auth_required（人在环审批等待）', victimTask?.state === 'auth_required', victimTask?.state)
        const hijack = await fetch(`${BASE}/v1/uhp/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${attackerToken}` },
          body: JSON.stringify({ model: 'selftest-a1', input: 'INJECTED', metadata: { ybk_agent_id: 'selftest-a1', ybk_a2a_task_id: victimTask.taskId } }),
        })
        const hijackBody = await hijack.json().catch(() => ({}))
        check('P0 护栏：外部凭证注入 ybk_a2a_task_id 被拒（400 TASK_BINDING_FORBIDDEN）',
          hijack.status === 400 && hijackBody.error?.code === 'TASK_BINDING_FORBIDDEN',
          `status=${hijack.status} code=${hijackBody.error?.code}`)
        await new Promise((resolve) => setTimeout(resolve, 800))
        const victimAfter = (await rpc(`/api/agents/${victimAgent.slug}/a2a`, admin, { method: 'tasks/get', params: { taskId: victimTask.taskId } })).result?.task
        check('P0 护栏：受害任务未被劫持（仍 auth_required，无伪造交付物）',
          victimAfter?.state === 'auth_required' && (victimAfter?.artifacts?.length ?? 0) === 0,
          `state=${victimAfter?.state} artifacts=${victimAfter?.artifacts?.length}`)

        // 2) P1：只读治理权限不可取消他人任务（组A A-1 / 组B B-5 复现路径）
        const otherCaller = await api('POST', '/api/agents', { token: ops, body: { name: 'SELFTEST-他人调用方', attrs: { description: '护栏', model: 'deepseek-chat', riskLevel: 'low', autonomy: 'A3' } } })
        const otherPrincipal = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'selftest-other-cc', refType: 'agent', refId: otherCaller.data.agent.id, scopes: ['agent.a2a.invoke', 'agent.read', 'a2a.directory.read'] } })
        const otherToken = (await api('POST', '/api/auth/client-credentials', { body: { clientId: otherPrincipal.data.clientId, clientSecret: otherPrincipal.data.clientSecret } })).data.token
        const victimTask2 = (await rpc(`/api/agents/${victimAgent.slug}/a2a`, admin, { method: 'message/send', params: { message: '第二条待审批任务' } })).result?.task
        const overreach = await rpc(`/api/agents/${victimAgent.slug}/a2a`, otherToken, { method: 'tasks/cancel', params: { taskId: victimTask2.taskId, reason: '越权取消探针' } })
        check('P1 护栏：非发起方（持治理读权限）取消他人任务被拒（-32003）',
          overreach.error?.code === -32003 && /仅任务发起方/.test(overreach.error?.message ?? ''),
          JSON.stringify(overreach.error ?? 'no-error').slice(0, 160))
        const victimAfter2 = (await rpc(`/api/agents/${victimAgent.slug}/a2a`, admin, { method: 'tasks/get', params: { taskId: victimTask2.taskId } })).result?.task
        check('P1 护栏：被越权取消的任务状态未变', victimAfter2?.state === 'auth_required', victimAfter2?.state)

        // 3) P1：治理读权限看他人任务正文须脱敏（组B B-3）
        const a2Target = (await api('GET', '/api/a2a/directory', { token: admin })).data.agents.find((item) => item.autonomy === 'A2')
        await api('PATCH', `/api/agents/${a2Target.agentId}`, { token: ops, body: { attrs: { autonomy: 'A2' } } })
        const secretTask = (await rpc(`/api/agents/${a2Target.slug}/a2a`, otherToken, { method: 'message/send', params: { message: '机密正文-CANARY-护栏' } })).result?.task
        const redactedView = await api('GET', `/api/a2a/tasks/${secretTask.taskId}`, { token: admin })
        check('P1 护栏：平台管理员可见任务正文（特权面不受脱敏影响）',
          redactedView.data?.task?.message === '机密正文-CANARY-护栏', JSON.stringify(redactedView.data?.task?.message))

        // 4) P1：发起人不可验收自己发起的任务（职责分离）
        const selfAccept = await api('POST', `/api/a2a/tasks/${secretTask.taskId}/acceptance`, { token: admin, body: { decision: 'accepted', reason: '自验收探针' } })
        const callerUserId = (await api('GET', '/api/iam/users', { token: admin })).data?.users?.find((u) => u.username === 'admin')?.id
        const expectedSelfReject = secretTask.callerSubject !== `user:${callerUserId}` // 机器发起的任务，admin 验收不算自验收
        check('P1 护栏：验收职责分离判定生效（发起人本人验收被拒；他人发起不受限）',
          expectedSelfReject ? selfAccept.ok : selfAccept.status === 403,
          `status=${selfAccept.status} callerSubject=${secretTask.callerSubject}`)

        // 5) 组织隔离：下级组织持治理读权限只见本组织子树（组B B-2）。
        //    iam 路由直接返回对象/数组（data.id），非包装形态。
        const subOrg = await api('POST', '/api/iam/orgs', { token: admin, body: { name: 'SELFTEST-隔离部' } })
        const isoRole = await api('POST', '/api/iam/roles', { token: admin, body: { name: 'SELFTEST隔离角色', code: 'selftest_iso_ro', permissions: ['console.login', 'console.read', 'agent.read', 'a2a.directory.read', 'uhp.read'] } })
        const isoUser = await api('POST', '/api/iam/users', { token: admin, body: { username: 'selftest-iso', displayName: '护栏隔离只读', orgId: subOrg.data.id, password: 'Ybk@2026', roleIds: [isoRole.data.id] } })
        check('护栏前置：隔离组织夹具创建成功', subOrg.ok && isoRole.ok && isoUser.ok, JSON.stringify({ subOrg: subOrg.error, role: isoRole.error, user: isoUser.error }).slice(0, 200))
        const isoToken = (await api('POST', '/api/auth/login', { body: { username: 'selftest-iso', password: 'Ybk@2026' } })).data.token
        const isoDir = await api('GET', '/api/a2a/directory', { token: isoToken })
        const isoTasks = await api('GET', '/api/a2a/tasks', { token: isoToken })
        const isoHarness = await api('GET', '/api/uhp/harnesses', { token: isoToken })
        check('P1 护栏：下级组织账号对跨组织协作数据零可见（目录/任务/harness）',
          (isoDir.data?.agents?.length ?? -1) === 0 && (isoTasks.data?.tasks?.length ?? -1) === 0 && (isoHarness.data?.harnesses?.length ?? -1) === 0,
          `dir=${isoDir.data?.agents?.length} tasks=${isoTasks.data?.tasks?.length} harness=${isoHarness.data?.harnesses?.length}`)

        // 6) UHP 协议面：发现公布的 harness id 可直接寻址（Q-7 契约往返）
        const discovery = await fetch(`${BASE}/v1/uhp`).then((r) => r.json())
        const firstHarness = discovery.harnesses?.[0]?.id
        const uhpOwner = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'selftest-uhp-owner', refType: 'external', scopes: ['uhp.invoke', 'agent.read'] } })
        const uhpOwnerToken = (await api('POST', '/api/auth/client-credentials', { body: { clientId: uhpOwner.data.clientId, clientSecret: uhpOwner.data.clientSecret } })).data.token
        if (firstHarness) {
          const byHarnessId = await fetch(`${BASE}/v1/uhp/responses`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${uhpOwnerToken}` },
            body: JSON.stringify({ model: `harness/${firstHarness}`, input: 'harness id 寻址护栏' }),
          }).then((r) => r.json())
          check('契约护栏：发现面公布的 harness id 可直接作 model 调用（往返一致）',
            byHarnessId.ok && byHarnessId.data?.harness_id === firstHarness,
            JSON.stringify(byHarnessId.error ?? byHarnessId.data?.harness_id).slice(0, 140))
          // 归属：他人执行记录不可读（Q-3）
          const foreignRead = await fetch(`${BASE}/v1/uhp/responses/${byHarnessId.data?.id ?? 'nope'}`, { headers: { authorization: `Bearer ${attackerToken}` } })
          check('P1 护栏：他人 UHP 执行记录不可读（非属主一律按不存在回应）', foreignRead.status === 404, `status=${foreignRead.status}`)
        }

        // 7) 协议同构：message/stream 与 message/send 均返回 JSON-RPC 信封（Q-8）
        const streamResp = await rpc(`/api/agents/${a2Target.slug}/a2a`, otherToken, { method: 'message/stream', params: { message: '流式同构护栏' } })
        check('契约护栏：message/stream 返回 JSON-RPC Task（与 message/send 同构）',
          Boolean(streamResp.result?.task?.taskId), JSON.stringify(streamResp.error ?? 'no-task').slice(0, 140))

        // 8) Agent Card 自描述与裸体（Q-31）
        const cardResp = await fetch(`${BASE}/.well-known/agents/${a2Target.slug}/agent-card.json`)
        const cardJson = await cardResp.json()
        check('契约护栏：Agent Card 为规范裸体（非 {ok,data} 信封）且含事件地址/权限点/协议版本',
          cardResp.status === 200 && cardJson.ok === undefined && Boolean(cardJson.eventsUrl)
            && Boolean(cardJson.securitySchemes?.ybkMachineCredential?.scopes?.['agent.a2a.invoke'])
            && cardJson.extensions?.some((ext) => ext.uri === 'urn:ybk:ext:protocol:v1'),
          `ok字段=${cardJson.ok !== undefined} events=${Boolean(cardJson.eventsUrl)}`)

        // 9) SSE 端点拒绝路径状态码与留痕（Q-28 / Q-27）
        const sseBadToken = await fetch(`${BASE}/v1/a2a/tasks/${victimTask.taskId}/events?token=not-a-real-token`)
        const sseNoToken = await fetch(`${BASE}/v1/a2a/tasks/${victimTask.taskId}/events`)
        check('契约护栏：SSE 端点坏令牌/无令牌均返 401（不再混入 400 参数错误）',
          sseBadToken.status === 401 && sseNoToken.status === 401, `bad=${sseBadToken.status} none=${sseNoToken.status}`)

        // 10) P1-01（QA 2026-10-21）：外部集成凭证的「派活 → get → list → cancel → SSE」闭环。
        //     根因是组织判定先于归属判定，refType=external 无组织归属 → 组织判定恒 false，
        //     归属短路永远不可达；修复后归属优先，外部凭证可完整观察自己发起的任务。
        {
          const extPrincipal = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'selftest-external-loop', refType: 'external', scopes: ['agent.a2a.invoke', 'agent.read'] } })
          const extToken = (await api('POST', '/api/auth/client-credentials', { body: { clientId: extPrincipal.data.clientId, clientSecret: extPrincipal.data.clientSecret } })).data.token
          // 目标用 A2 自治员工：人类调用方映射 A1 → execute_report（UHP 真实执行，同步等终态）
          const extTarget = (await api('GET', '/api/a2a/directory', { token: admin })).data.agents.find((item) => item.autonomy === 'A2')
          const extSend = await rpc(`/api/agents/${extTarget.slug}/a2a`, extToken, { method: 'message/send', params: { message: '外部门户集成闭环自测' } })
          const extTask = extSend.result?.task
          check('P1 护栏：外部凭证可派活（refType=external 建单成功）',
            Boolean(extTask?.taskId), JSON.stringify(extSend.error ?? 'no-task').slice(0, 160))
          const extGet = await rpc(`/api/agents/${extTarget.slug}/a2a`, extToken, { method: 'tasks/get', params: { taskId: extTask?.taskId } })
          check('P1 护栏：外部凭证 tasks/get 读回自己发起的任务（归属优先于组织收敛）',
            extGet.result?.task?.taskId === extTask?.taskId && !extGet.error,
            JSON.stringify(extGet.error ?? extGet.result?.task?.state).slice(0, 160))
          const extList = await rpc(`/api/agents/${extTarget.slug}/a2a`, extToken, { method: 'tasks/list', params: { limit: 50 } })
          check('P1 护栏：外部凭证 tasks/list 含自己的任务（组织过滤不再吞掉本人任务）',
            (extList.result?.tasks ?? []).some((task) => task.taskId === extTask?.taskId),
            `count=${extList.result?.tasks?.length ?? 'null'} err=${extList.error?.message ?? ''}`.slice(0, 160))
          // SSE：外部凭证按卡片 eventsUrl 订阅自己的任务（归属短路后不再 403）
          const extSse = await fetch(`${BASE}/v1/a2a/tasks/${extTask?.taskId}/events?token=${encodeURIComponent(extToken)}`, { headers: { accept: 'text/event-stream' } })
          const extSseOk = extSse.status === 200 && (extSse.headers.get('content-type') ?? '').includes('text/event-stream')
          await extSse.body?.cancel().catch(() => {})
          check('P1 护栏：外部凭证可订阅自己任务的 SSE（不再 403）', extSseOk, `status=${extSse.status}`)
          // 取消：非终态任务可取消（归属通过后 assertTaskOwner 也放行）
          const extCancelSend = await rpc(`/api/agents/${extTarget.slug}/a2a`, extToken, { method: 'message/send', params: { message: '慢任务标记：外部凭证取消闭环' } })
          const extCancelTask = extCancelSend.result?.task
          const extCancel = await rpc(`/api/agents/${extTarget.slug}/a2a`, extToken, { method: 'tasks/cancel', params: { taskId: extCancelTask?.taskId, reason: '外部集成自测取消' } })
          check('P1 护栏：外部凭证可取消自己发起且在途的任务',
            extCancel.result?.task?.state === 'canceled', JSON.stringify(extCancel.error ?? extCancel.result?.task?.state ?? 'no-result').slice(0, 160))
          // 反向：归属短路不得扩大成「外部凭证互读」——B 凭证看不到 A 的任务（组织隔离的原始意图）
          const extOther = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'selftest-external-other', refType: 'external', scopes: ['agent.a2a.invoke', 'agent.read'] } })
          const extOtherToken = (await api('POST', '/api/auth/client-credentials', { body: { clientId: extOther.data.clientId, clientSecret: extOther.data.clientSecret } })).data.token
          const extOtherGet = await rpc(`/api/agents/${extTarget.slug}/a2a`, extOtherToken, { method: 'tasks/get', params: { taskId: extTask?.taskId } })
          const extOtherList = await rpc(`/api/agents/${extTarget.slug}/a2a`, extOtherToken, { method: 'tasks/list', params: { limit: 100 } })
          const extOtherCancel = await rpc(`/api/agents/${extTarget.slug}/a2a`, extOtherToken, { method: 'tasks/cancel', params: { taskId: extTask?.taskId, reason: '跨属主探针' } })
          check('P1 护栏：归属短路不扩大为外部凭证互读（B 不能读/列/取消 A 的任务）',
            extOtherGet.error?.code === -32003 && extOtherCancel.error?.code === -32003
            && !(extOtherList.result?.tasks ?? []).some((task) => task.taskId === extTask?.taskId),
            JSON.stringify({ get: extOtherGet.error?.code, cancel: extOtherCancel.error?.code, listed: (extOtherList.result?.tasks ?? []).length }).slice(0, 200))
        }

        // 11) P2-01（QA 2026-10-21）：治理第 2 项 permit 覆盖真实生效。
        //     构造「员工 active + 绑定到该 Agent + 零任用」的受管态 → 必须 PERMIT_NOT_EFFECTIVE。
        //     静态根因：inject 缺 workforceIdentity，Service 代理读未注入键抛错被 catch 吞掉按 legacy 放行。
        {
          const permitAgent = (await api('POST', '/api/agents', { token: ops, body: { name: 'SELFTEST-PERMIT目标', slug: `selftest-permit-${Date.now().toString(36)}`, attrs: { description: 'permit 覆盖护栏', model: 'deepseek-chat', riskLevel: 'low', dataClass: 'internal', trialGroups: ['灰度试点组'], entryUrl: 'https://permit.example.com', autonomy: 'A2' } } })).data.agent
          await api('POST', `/api/agents/${permitAgent.id}/transition`, { token: ops, body: { action: 'submit_trial' } })
          const permitOnlineReq = await api('POST', `/api/agents/${permitAgent.id}/transition`, { token: ops, body: { action: 'online', note: 'permit 护栏上线' } })
          await api('POST', `/api/approvals/${permitOnlineReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: 'permit 护栏', confirmed: true, finalReview: true } })
          const permitOrgId = (await api('GET', '/api/iam/orgs', { token: admin })).data?.[0]?.id ?? (await api('GET', '/api/iam/orgs', { token: admin })).data?.orgs?.[0]?.id
          const permitAdminId = (await api('GET', '/api/iam/users', { token: admin })).data?.users?.find((u) => u.username === 'admin')?.id
          const permitEmp = await api('POST', '/api/workforce/employees', { token: admin, body: { name: `selftest-permit-${Date.now().toString(36)}`, orgId: permitOrgId, supervisorUserId: permitAdminId, agentId: permitAgent.id } })
          const permitAppts = await api('GET', `/api/workforce/appointments?employeeId=${permitEmp.data?.id}`, { token: admin })
          const permitApptCount = Array.isArray(permitAppts.data) ? permitAppts.data.length : (permitAppts.data?.items ?? []).length
          check('护栏前置：受管态夹具（员工 active + 绑定 + 零任用）',
            permitEmp.ok && permitEmp.data?.status === 'active' && permitApptCount === 0,
            JSON.stringify({ emp: permitEmp.error ?? permitEmp.data?.status, appts: permitApptCount }).slice(0, 200))
          const permitDispatch = await rpc(`/api/agents/${permitAgent.slug}/a2a`, admin, { method: 'message/send', params: { message: 'permit 决定性探针（无任用）' } })
          check('P2-01 护栏：已绑定但无生效任用 → PERMIT_NOT_EFFECTIVE（fail-closed，不再按 legacy 放行）',
            permitDispatch.error?.data?.code === 'PERMIT_NOT_EFFECTIVE',
            JSON.stringify(permitDispatch.error ?? permitDispatch.result?.task?.state ?? 'no-result').slice(0, 200))
          // 复岗/复任用后放行（证明拒绝不是一刀切死锁）
          const permitAppt = await api('POST', '/api/workforce/appointments', { token: admin, body: {
            employeeId: permitEmp.data.id, position: '护栏验证岗', orgId: permitOrgId, dataClass: 'internal',
            effectiveFrom: new Date().toISOString(), grants: [{ kind: 'model', registryId: 'deepseek-chat', actions: ['invoke'], risk: 'read' }], approvedBy: permitAdminId,
          } })
          const permitActivate = permitAppt.ok ? await api('POST', `/api/workforce/appointments/${permitAppt.data.id}/activate`, { token: admin, body: {} }) : { ok: false }
          const permitAfter = await rpc(`/api/agents/${permitAgent.slug}/a2a`, admin, { method: 'message/send', params: { message: 'permit 恢复后放行探针' } })
          check('P2-01 护栏：任用生效后同一员工放行（拒绝可恢复，不是死锁）',
            permitActivate.ok && permitActivate.data?.status === 'effective' && Boolean(permitAfter.result?.task?.taskId),
            JSON.stringify({ activate: permitActivate.error ?? permitActivate.data?.status, dispatch: permitAfter.error ?? permitAfter.result?.task?.state }).slice(0, 220))
        }

        // 12) P2-04（QA 2026-10-21）：注入变体矩阵统一「拒绝 + 留痕」。
        //     metadata.ybk_a2a_task_id / 顶层 task_id / 顶层 taskId 三条路径都必须 400 + 专项审计。
        {
          const uhpAnyHarness = (await fetch(`${BASE}/v1/uhp`).then((r) => r.json())).harnesses?.[0]?.id
          const probeBodies = [
            ['metadata.ybk_a2a_task_id', { model: `harness/${uhpAnyHarness}`, input: 'probe', metadata: { ybk_a2a_task_id: 'task_probe' } }],
            ['顶层 task_id', { model: `harness/${uhpAnyHarness}`, input: 'probe', task_id: 'task_probe' }],
            ['顶层 taskId', { model: `harness/${uhpAnyHarness}`, input: 'probe', taskId: 'task_probe' }],
          ]
          for (const [label, body] of probeBodies) {
            const resp = await fetch(`${BASE}/v1/uhp/responses`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${uhpOwnerToken}` },
              body: JSON.stringify(body),
            })
            const doc = await resp.json().catch(() => ({}))
            check(`P2-04 护栏：注入变体「${label}」被拒（400 TASK_BINDING_FORBIDDEN + 不建立绑定）`,
              resp.status === 400 && doc.error?.code === 'TASK_BINDING_FORBIDDEN',
              `status=${resp.status} code=${doc.error?.code ?? ''}`)
          }
        }

        // 13) P2-03（QA 2026-10-21）：外部直调 stream=true 的 SSE 必须闭合（收到 response.completed）。
        {
          const sseHarness = (await fetch(`${BASE}/v1/uhp`).then((r) => r.json())).harnesses?.[0]?.id
          const sseDirect = await fetch(`${BASE}/v1/uhp/responses`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${uhpOwnerToken}` },
            body: JSON.stringify({ model: `harness/${sseHarness ?? 'collab-target'}`, input: 'SSE 直调闭合护栏', stream: true }),
          })
          let sseText = ''
          const reader = sseDirect.body?.getReader()
          const deadline = Date.now() + 12_000
          while (reader && Date.now() < deadline) {
            const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), 800))])
            if (chunk.timeout) continue
            if (chunk.done) break
            sseText += Buffer.from(chunk.value).toString('utf8')
            if (/response\.(completed|failed|canceled)/.test(sseText)) break
          }
          await reader?.cancel().catch(() => {})
          check('P2-03 护栏：UHP 外部直调 SSE 闭合（收到完成帧，不再悬挂到心跳）',
            sseDirect.status === 200 && /response\.completed/.test(sseText),
            `status=${sseDirect.status} events=${[...sseText.matchAll(/event: (\S+)/g)].map((m) => m[1]).join(',')}`.slice(0, 200))
        }

        // 收尾下线护栏用员工
        const victimOffline = await api('POST', `/api/agents/${victimAgent.id}/transition`, { token: ops, body: { action: 'offline', note: '护栏收尾' } })
        await api('POST', `/api/approvals/${victimOffline.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '护栏收尾下线', confirmed: true } })
      }

      // -- 收尾：下线目标员工（联动拒服）
      const offlineReq = await api('POST', `/api/agents/${target.id}/transition`, { token: ops, body: { action: 'offline', note: '协作面自测收尾' } })
      await api('POST', `/api/approvals/${offlineReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '协作面收尾下线', confirmed: true } })
      const afterOffline = await rpc('/api/agents/collab-target/a2a', admin, { method: 'message/send', params: { message: '下线后再派' } })
      check('协作面：下线后派单被治理拒绝（TARGET_NOT_ONLINE 留痕）',
        JSON.stringify(afterOffline.error ?? {}).includes('TARGET_NOT_ONLINE'),
        JSON.stringify(afterOffline.error ?? afterOffline.raw).slice(0, 160))
    }
    try {
      await runCollab()
    } finally {
      collabStub.close()
    }
  }

  // ================================================================ AI 应用资料字段（头像 URL / 开发者 / 描述）
  section('AI 应用资料字段（头像 URL / 开发者下拉 / 描述）')
  const devOptions = await api('GET', '/api/apps/developer-options', { token: ops })
  check('developer-options：资源管理员（app.* → app.write）可拉取在编用户瘦字段', devOptions.ok && Array.isArray(devOptions.data.options) && devOptions.data.options.length > 0 && devOptions.data.options[0].username !== undefined, JSON.stringify(devOptions.error))
  const devOption = devOptions.data?.options?.find((u) => u.username === 'dev')
  check('developer-options：包含演示开发者账号（dev / 陈默）', Boolean(devOption && devOption.name === '陈默'))
  const appAvatarCreate = await api('POST', '/api/apps', { token: ops, body: { name: '资料字段自测应用', attrs: { description: '头像 / 开发者 / 描述字段验证', appType: 'web', icon: 'https://example.com/avatar.png', riskLevel: 'low', dataClass: 'internal', developerId: devOption.id } } })
  check('注册应用：icon 接受图片 URL（头像）', appAvatarCreate.ok && appAvatarCreate.data.app.attrs['icon'] === 'https://example.com/avatar.png', JSON.stringify(appAvatarCreate.error))
  check('注册应用：developerId 校验存在并回填 developerName（displayName 为准）', appAvatarCreate.ok && appAvatarCreate.data.app.attrs['developerId'] === devOption.id && appAvatarCreate.data.app.attrs['developerName'] === '陈默', JSON.stringify(appAvatarCreate.data?.app?.attrs))
  const appAvatarBad = await api('POST', '/api/apps', { token: ops, body: { name: '非法开发者自测应用', attrs: { description: 'developerId 校验', appType: 'web', riskLevel: 'low', dataClass: 'internal', developerId: 'usr_ghost' } } })
  check('注册应用：developerId 不存在被拒 400', !appAvatarBad.ok && String(appAvatarBad.error?.message ?? '').includes('开发者不存在'), JSON.stringify(appAvatarBad.error))
  const appAvatarPatch = await api('PATCH', `/api/apps/${appAvatarCreate.data.app.id}`, { token: ops, body: { attrs: { icon: '🧩', developerId: '' } } })
  check('更新应用：icon 可改；developerId 空串清除开发者', appAvatarPatch.ok && appAvatarPatch.data.attrs['icon'] === '🧩' && appAvatarPatch.data.attrs['developerName'] === '' && appAvatarPatch.data.attrs['developerId'] === '', JSON.stringify(appAvatarPatch.error ?? appAvatarPatch.data?.attrs))
  const appAvatarNameOnly = await api('PATCH', `/api/apps/${appAvatarCreate.data.app.id}`, { token: ops, body: { attrs: { developerName: '外部协作开发者' } } })
  check('更新应用：developerName 支持自由文本快照（外部开发者场景）', appAvatarNameOnly.ok && appAvatarNameOnly.data.attrs['developerName'] === '外部协作开发者', JSON.stringify(appAvatarNameOnly.error))

  // 接入提示词（注册同款模板平台侧生成；rotate 轮换机器凭证携带完整凭证；外部推送方按关键词「提示词」触发）
  const promptRotated = await api('POST', `/api/apps/${appAvatarCreate.data.app.id}/onboarding-prompt`, { token: ops, body: { rotate: true } })
  check('接入提示词：rotate 生成完整提示词（含新 clientSecret 与关键词「提示词」）',
    promptRotated.ok && promptRotated.data.rotated === true && promptRotated.data.prompt.includes('提示词')
    && Boolean(promptRotated.data.credential.clientSecret) && promptRotated.data.prompt.includes(promptRotated.data.credential.clientSecret),
    JSON.stringify(promptRotated.error))
  const promptCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: promptRotated.data.credential.clientId, clientSecret: promptRotated.data.credential.clientSecret } })
  check('接入提示词：轮换后的新 secret 可正常换牌（旧值已吊销）', promptCc.ok && Boolean(promptCc.data?.token), JSON.stringify(promptCc.error))
  const promptPlain = await api('POST', `/api/apps/${appAvatarCreate.data.app.id}/onboarding-prompt`, { token: ops, body: {} })
  check('接入提示词：不轮换生成（含 client_id 与占位说明，不含 secret 明文）',
    promptPlain.ok && promptPlain.data.rotated === false && promptPlain.data.prompt.includes(promptPlain.data.credential.clientId)
    && promptPlain.data.prompt.includes('重新生成密钥') && !promptPlain.data.prompt.includes('client_secret：cs_'),
    JSON.stringify(promptPlain.error))

  // MCP 服务注册：orgId 缺省回落根组织（外部推送方机器凭证无需 iam.org.read，与 /api/mcp/import 同口径）
  const devOpts = await api('GET', '/api/apps/developer-options', { token: ops })
  check('开发者选项：响应含钉钉 unionIds 绑定（表格人员字段解析用）',
    devOpts.ok && Array.isArray(devOpts.data.options) && devOpts.data.options.every((o) => Array.isArray(o.unionIds)),
    JSON.stringify(devOpts.error))

  const mcpNoOrg = await api('POST', '/api/mcp/services', { token: ops, body: { name: 'orgId缺省自测MCP', description: 'orgId 缺省回落根组织验证', endpoint: 'https://mcp.example.com/mcp', transport: 'http', mode: 'external' } })
  check('MCP 注册：orgId 缺省回落根组织', mcpNoOrg.ok && Boolean(mcpNoOrg.data?.orgId), JSON.stringify(mcpNoOrg.error))
  // 清理：下线（viaApproval=false 免 L4 审批，自测资产）→ 删除
  const mcpNoOrgOffline = await api('POST', `/api/mcp/services/${mcpNoOrg.data?.id}/offline`, { token: ops, body: { reason: '自测清理', viaApproval: false } })
  check('MCP 注册：自测服务下线（viaApproval=false 直下）', mcpNoOrgOffline.ok, JSON.stringify(mcpNoOrgOffline.error))
  const mcpNoOrgCleanup = await api('DELETE', `/api/mcp/services/${mcpNoOrg.data?.id}`, { token: ops })
  check('MCP 注册：自测服务清理', mcpNoOrgCleanup.ok, JSON.stringify(mcpNoOrgCleanup.error))

  // ================================================================ AI 应用 ↔ SSO 打通（MVP 闭环）
  section('console ticket redeem（WP-02 + 安全审查 P0-01：票据用途隔离）')
  {
    // P0-01（2026-10-31）：app/agent 票据的接收方是不可控第三方前端，不得兑换控制台会话
    //（旧用例把 agent 票换会话当成功路径，正是外部审查点名的提权链）；免登控制台会话
    // 仅接受 refType='self' 的自助票（G1 跨源自举回跳/面板直通，签发人=领取人）。
    const agentTicket = await api('POST', `/api/agents/${selfAgent.id}/entry-ticket`, { token: admin, body: {} })
    check('免登：领票（复用既有签发端点，一次性 etk_ 票据）', agentTicket.ok && agentTicket.data.ticket.startsWith('etk_'), JSON.stringify(agentTicket.error))
    const agentRedeem = await rawReq('POST', '/api/auth/entry-ticket-session', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: agentTicket.data.ticket }),
    })
    check('P0-01：Agent 票据拒绝兑换控制台会话（仅交付资源侧身份）', agentRedeem.status === 400, String(agentRedeem.status))
    const appTicket = await api('POST', `/api/apps/${appAvatarCreate.data.app.id}/entry-ticket`, { token: admin, body: {} })
    check('P0-01：应用票据可正常签发', appTicket.ok && appTicket.data.ticket.startsWith('etk_'), JSON.stringify(appTicket.error))
    const appRedeem = await rawReq('POST', '/api/auth/entry-ticket-session', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: appTicket.data.ticket }),
    })
    check('P0-01：应用票据拒绝兑换控制台会话', appRedeem.status === 400, String(appRedeem.status))
    const selfTicket = await api('POST', '/api/auth/entry-tickets/self', { token: admin, body: {} })
    check('免登：自助票可签发（console.login 权限面）', selfTicket.ok && selfTicket.data.ticket.startsWith('etk_'), JSON.stringify(selfTicket.error))
    const redeemSession = await rawReq('POST', '/api/auth/entry-ticket-session', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: selfTicket.data.ticket }),
    })
    const sessionBody = jsonBody(redeemSession)
    check('免登：自助票兑换成功建立控制台会话（dst1 令牌 + refresh + 用户档案）',
      redeemSession.status === 200 && typeof sessionBody.data?.token === 'string' && sessionBody.data.token.startsWith('dst1.')
      && Boolean(sessionBody.data?.refreshToken) && Boolean(sessionBody.data?.user?.id),
      `${redeemSession.status} ${JSON.stringify(sessionBody).slice(0, 200)}`)
    const freeOverview = sessionBody.data?.token ? await api('GET', '/api/overview', { token: sessionBody.data.token }) : { ok: false }
    check('免登：兑换所得会话可直接调用工作台聚合（打开即工作台）', freeOverview.ok, JSON.stringify(freeOverview.error))
    const sessionReplay = await rawReq('POST', '/api/auth/entry-ticket-session', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: selfTicket.data.ticket }),
    })
    check('免登：重放票据被拒（一次性消费防重放）', sessionReplay.status === 400, String(sessionReplay.status))
    const sessionForged = await api('POST', '/api/auth/entry-ticket-session', { body: { ticket: 'etk_forged_0000000000000000000000000000000000000000' } })
    check('免登：伪造票据被拒', sessionForged.status === 400)
    // 演示态一键入场（2026-11-01）：签票端点仅 DEMO_MODE=1 存在——本自测实例非演示态，
    // 必须 404（生产实例不新增任何可换身份的公开面；演示侧行为由演示环境浏览器实测）
    const demoEntry = await api('POST', '/api/panel/auth/demo-entry', { body: {} })
    check('免登：演示一键入场端点非演示实例恒 404（DEMO_MODE 门控）', demoEntry.status === 404, String(demoEntry.status))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const serverLog = serverLogChunks.join('')
    check('免登：票据本体零进服务端日志（stdout/stderr 全量扫描）', Boolean(agentTicket.data.ticket) && !serverLog.includes(agentTicket.data.ticket) && !serverLog.includes(selfTicket.data.ticket), '票据本体出现在服务端日志')
    const auditSession = await api('GET', '/api/audit/logs?q=' + encodeURIComponent('entry.ticket.session'), { token: admin })
    check('免登：兑换入审计（*.entry.ticket.session 可检索，且审计不含票据本体）',
      auditSession.ok && (auditSession.data.items ?? []).some((log) => log.action === 'self.entry.ticket.session' && !JSON.stringify(log).includes(selfTicket.data.ticket)),
      JSON.stringify(auditSession.error ?? auditSession.data?.total))
    const auditDenied = await api('GET', '/api/audit/logs?q=' + encodeURIComponent('entry.ticket.session.denied'), { token: admin })
    check('P0-01：非自助票兑换被拒入审计（*.denied 可检索）',
      auditDenied.ok && (auditDenied.data.items ?? []).some((log) => String(log.action ?? '').endsWith('entry.ticket.session.denied')),
      JSON.stringify(auditDenied.error ?? auditDenied.data?.total))
  }
  section('自助入场票据与跨源回跳（G1：self 票种 / TTL ≤120s / 一次性 / 审计闭环）')
  {
    const selfAnon = await api('POST', '/api/auth/entry-tickets/self', { body: {} })
    check('自助票：未认证被拒（401，机器主体不可自助签发）', selfAnon.status === 401)
    const selfIssued = await api('POST', '/api/auth/entry-tickets/self', { token: dev, body: {} })
    check('自助票：登录人类可自助签发（etk_ 票据，TTL 硬上限 120s 覆盖 env 调高）',
      selfIssued.ok && selfIssued.data.ticket.startsWith('etk_') && selfIssued.data.ttlSeconds <= 120, JSON.stringify(selfIssued.error ?? selfIssued.data))
    const selfRedeem = await rawReq('POST', '/api/auth/entry-ticket-session', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: selfIssued.data.ticket }),
    })
    const selfSession = jsonBody(selfRedeem)
    check('自助票：兑换建立控制台会话（跨源回跳后复用既有公开兑换端点，零新增公开面）',
      selfRedeem.status === 200 && typeof selfSession.data?.token === 'string' && selfSession.data.token.startsWith('dst1.'),
      `${selfRedeem.status} ${JSON.stringify(selfSession).slice(0, 160)}`)
    const selfReplay = await rawReq('POST', '/api/auth/entry-ticket-session', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: selfIssued.data.ticket }),
    })
    check('自助票：重放被拒（一次性/防重放语义与 agent/app 票一致）', selfReplay.status === 400, String(selfReplay.status))
    const selfAudit = await api('GET', '/api/audit/logs?q=' + encodeURIComponent('self.entry.ticket'), { token: admin })
    check('自助票：签发与兑换均入审计（self.entry.ticket.* 可检索，票据本体不落审计）',
      selfAudit.ok && (selfAudit.data.items ?? []).some((log) => log.action === 'self.entry.ticket.issue')
      && (selfAudit.data.items ?? []).some((log) => log.action === 'self.entry.ticket.session')
      && !JSON.stringify(selfAudit.data.items).includes(selfIssued.data.ticket),
      JSON.stringify(selfAudit.error ?? selfAudit.data?.items?.map((item) => item.action)))
  }

  // ================================================================ 安全审查 2026-10-30 整改回归
  // 对应《元冰可 AIOS 产品发布前安全审查报告》P0/P1 各项的服务端负向验证（修复语义锁死）。
  section('安全审查整改回归（P0-02 提权 / P1-02 组织边界 / P1-05 SSO 绑定 / P1-07 受众 / P1-08 口令重置吊销）')
  {
    const hrLogin = await api('POST', '/api/auth/login', { body: { username: 'hr', password: 'Ybk@2026' } })
    check('整改回归：组织管理员（hr）登录', hrLogin.ok && hrLogin.data.user.permissions.includes('iam.user.write'), JSON.stringify(hrLogin.error))
    const hr = hrLogin.data.token
    const hrUid = hrLogin.data.user.id
    const roleIds = ((await api('GET', '/api/iam/roles', { token: hr })).data.roles ?? [])
    const roleSuper = roleIds.find((r) => r.code === 'super_admin')
    const roleResource = roleIds.find((r) => r.code === 'resource_admin')
    // P0-02a：给自己分配 super_admin（解析即 ['*']）→ 403
    const p0SelfEscalate = await api('PATCH', `/api/iam/users/${hrUid}`, { token: hr, body: { roleIds: [roleSuper.id] } })
    check('P0-02：组织管理员自提权 super_admin 被拒 403（可授权上限）', p0SelfEscalate.status === 403, JSON.stringify(p0SelfEscalate.error ?? p0SelfEscalate.data?.permissions))
    // P0-02b：给本组织他人分配 resource_admin（超出 hr 自身权限集）→ 403
    const hrOrgUsers = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('yqz'), { token: hr })).data.users ?? []
    const p0CrossCeil = hrOrgUsers[0]
      ? await api('PATCH', `/api/iam/users/${hrOrgUsers[0].id}`, { token: hr, body: { roleIds: [roleResource.id] } })
      : { status: 404 }
    check('P0-02：组织管理员分配超出自身权限集的角色被拒 403', p0CrossCeil.status === 403, JSON.stringify(p0CrossCeil.error))
    // P0-02c：创建含 '*' 的角色 → 403；创建仅含自身持有点的角色 → 200（正路不受影响）
    const p0StarRole = await api('POST', '/api/iam/roles', { token: hr, body: { code: 'p0_star_probe', name: '提权探针', permissions: ['*'] } })
    check('P0-02：组织管理员创建全量权限（*）角色被拒 403', p0StarRole.status === 403, JSON.stringify(p0StarRole.error))
    const p0OkRole = await api('POST', '/api/iam/roles', { token: hr, body: { code: 'p0_inscope_probe', name: '组织内权限探针', permissions: ['iam.user.write', 'iam.org.read'] } })
    check('P0-02：组织管理员创建自身权限集内的角色放行（正路不回归）', p0OkRole.ok, JSON.stringify(p0OkRole.error))
    if (p0OkRole.ok) await api('DELETE', `/api/iam/roles/${p0OkRole.data.id}`, { token: hr })
    // P0-02d：改内置 super_admin 角色权限 → 400（内置不可改，既有护栏回归）
    const p0EditBuiltin = await api('PATCH', `/api/iam/roles/${roleSuper.id}`, { token: admin, body: { permissions: ['iam.user.read'] } })
    check('P0-02：内置角色权限不可修改（既有护栏仍在）', p0EditBuiltin.status === 400, JSON.stringify(p0EditBuiltin.error))

    // P1-02a：跨组织 Agent 详情 → 403（详情与列表同规）：第二公司账号注册 Agent，dev（第一公司）直读
    const org2 = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '整改回归第二公司' } })
    const roleDev = ((await api('GET', '/api/iam/roles', { token: admin })).data.roles ?? []).find((r) => r.code === 'developer')
    await api('POST', '/api/iam/users', { token: admin, body: { username: 'p1org2', displayName: '第二公司探针员', orgId: org2.data.id, password: 'P1org2@2026', roleIds: [roleDev.id] } })
    const org2Login = await api('POST', '/api/auth/login', { body: { username: 'p1org2', password: 'P1org2@2026' } })
    check('整改回归：第二公司账号登录（跨组织夹具就绪）', org2Login.ok, JSON.stringify(org2Login.error))
    const org2Agent = await api('POST', '/api/agents', { token: org2Login.data.token, body: { name: '第二公司隔离探针 Agent', attrs: { description: 'P1-02 详情组织校验探针', model: 'deepseek-chat', riskLevel: 'low' } } })
    check('整改回归：第二公司 Agent 注册（归属第二公司）', org2Agent.ok && Boolean(org2Agent.data?.agent?.id), JSON.stringify(org2Agent.error))
    const p1CrossAgent = await api('GET', `/api/agents/${org2Agent.data.agent.id}`, { token: dev })
    check('P1-02：跨组织 Agent 详情被拒 403（对象级组织校验）', p1CrossAgent.status === 403, JSON.stringify(p1CrossAgent.error))
    const p1OwnAgent = await api('GET', `/api/agents/${org2Agent.data.agent.id}`, { token: admin })
    check('P1-02：平台管理员跨组织详情照常可达（全量豁免不回归）', p1OwnAgent.ok, JSON.stringify(p1OwnAgent.error))
    await api('POST', `/api/agents/${org2Agent.data.agent.id}/transition`, { token: org2Login.data.token, body: { action: 'archive' } })
    // P1-05：组织管理员为他人手工绑定三方身份 → 403（目标取 hr 组织子树内的在编账号）
    const hrSubUid = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('yqz'), { token: hr })).data.users?.[0]?.id
    const p1BindOther = hrSubUid ? await api('POST', `/api/iam/users/${hrSubUid}/bindings`, { token: hr, body: { provider: 'dingtalk', unionId: 'p1_attacker_union_id', displayName: '攻击探针' } }) : { status: 404 }
    check('P1-05：组织管理员为他人手工绑定三方身份被拒 403（仅平台超管）', p1BindOther.status === 403, JSON.stringify(p1BindOther.error))

    // P1-07：受众绑定委托令牌拒绝触达控制台写面（身份自省白名单端点不受影响）
    const govAgentRes = await api('POST', '/api/agents', { token: admin, body: { name: '受众边界探针 Agent', attrs: { description: 'P1-07 探针', model: 'deepseek-chat', riskLevel: 'low' } } })
    check('整改回归：P1-07 探针 Agent 注册', govAgentRes.ok && Boolean(govAgentRes.data?.agent?.id), JSON.stringify(govAgentRes.error))
    const govPrincipals = (await api('GET', '/api/authn/principals', { token: admin })).data.principals
    const govAgentPrincipal = govPrincipals.find((p) => p.refType === 'agent' && p.refId === govAgentRes.data.agent.id)
    await api('POST', `/api/agents/${govAgentRes.data.agent.id}/bindings`, { token: admin, body: { userId: (await api('GET', '/api/auth/me', { token: admin })).data.userId } })
    const govExchange = await api('POST', '/api/authn/token/exchange', { token: admin, body: { targetPrincipalId: govAgentPrincipal.id, audience: 'mcp:service:p1-audit-probe', scopes: ['exec.write'] } })
    const govDelegated = govExchange.data?.access_token
    const p1AudWrite = await api('POST', '/api/exec/goals', { token: govDelegated, body: { name: '受众越界探针' } })
    check('P1-07：带受众委托令牌触达控制台写面被拒 403 TOKEN_AUDIENCE_MISMATCH',
      p1AudWrite.status === 403 && p1AudWrite.error?.code === 'TOKEN_AUDIENCE_MISMATCH', JSON.stringify(p1AudWrite.error))
    const p1AudMe = await api('GET', '/api/auth/me', { token: govDelegated })
    check('P1-07：身份自省白名单端点照常可达（委托身份链语义保留）', p1AudMe.ok, JSON.stringify(p1AudMe.error))
    await api('POST', `/api/agents/${govAgentRes.data.agent.id}/transition`, { token: admin, body: { action: 'archive' } })

    // P1-08：重置口令联动吊销既有会话（旧 access 即时失效）。用专用账号，不触碰
    // 后续用例依赖的既有账号（linxm 等的会话在后续 QA 段仍被引用）
    await api('POST', '/api/iam/users', { token: admin, body: { username: 'p1reset', displayName: '口令重置探针员', orgId: org2.data.id, password: 'P1reset@2026', roleIds: [roleDev.id] } })
    const p1DevLogin = await api('POST', '/api/auth/login', { body: { username: 'p1reset', password: 'P1reset@2026' } })
    check('整改回归：口令重置探针账号登录', p1DevLogin.ok, JSON.stringify(p1DevLogin.error))
    const p1OldToken = p1DevLogin.data.token
    const p1ResetUid = p1DevLogin.data.user.id
    const p1Reset = await api('POST', `/api/iam/users/${p1ResetUid}/reset-password`, { token: admin, body: {} })
    check('P1-08：管理员重置口令成功（随机初始口令回显）', p1Reset.ok && Boolean(p1Reset.data.initialPassword), JSON.stringify(p1Reset.error))
    const p1OldMe = await api('GET', '/api/auth/me', { token: p1OldToken })
    check('P1-08：重置后既有会话即时失效（旧 access 401）', p1OldMe.status === 401, String(p1OldMe.status))
    const p1ReLogin = await api('POST', '/api/auth/login', { body: { username: 'p1reset', password: p1Reset.data.initialPassword } })
    check('P1-08：新口令可正常登录（联动不伤正常链路）', p1ReLogin.ok, JSON.stringify(p1ReLogin.error))

    // P1-04：env: 凭证引用白名单（自测实例未设 MCP_ENV_SECRET_ALLOWLIST → fail-closed 拒绝）
    const p1Mcp = await api('POST', '/api/mcp/services', { token: admin, body: { name: 'P1-04 凭证探针', description: 'env 白名单探针', endpoint: 'https://mcp.example.com/mcp', transport: 'http', mode: 'external' } })
    const p1Cred = await api('PUT', `/api/mcp/services/${p1Mcp.data?.id}/credential`, { token: admin, body: { credentialRef: 'env:P1_NOT_REGISTERED_VAR' } })
    check('P1-04：白名单外 env: 凭证引用被拒 400 ENV_CREDENTIAL_NOT_ALLOWED',
      p1Cred.status === 400 && p1Cred.error?.code === 'ENV_CREDENTIAL_NOT_ALLOWED', JSON.stringify(p1Cred.error))
    if (p1Mcp.data?.id) {
      await api('POST', `/api/mcp/services/${p1Mcp.data.id}/offline`, { token: admin, body: { reason: '自测清理', viaApproval: false } })
      await api('DELETE', `/api/mcp/services/${p1Mcp.data.id}`, { token: admin })
    }
  }
  section('Agent ↔ SSO 打通（OIDC-agent 关联，dev-plan-agent-host-unification M2）')
  const oidcAgentCreate = await api('POST', '/api/agents', { token: ops, body: { name: 'SSO 自测机器人', attrs: { description: 'OIDC-agent 关联自测', model: 'deepseek-chat', riskLevel: 'low', avatar: '🔑' } } })
  check('注册 SSO 自测 Agent（owner=资源管理员）', oidcAgentCreate.ok, JSON.stringify(oidcAgentCreate.error))
  const oidcAgentId = oidcAgentCreate.data.agent.id
  await api('PATCH', `/api/agents/${oidcAgentId}`, { token: ops, body: { attrs: { dataClass: 'internal' } } })
  const oidcGateNone = await api('POST', `/api/agents/${oidcAgentId}/transition`, { token: ops, body: { action: 'online' } })
  check('Agent 上线门禁：无 OIDC 客户端且无 entryUrl 被拒并指路', !oidcGateNone.ok && JSON.stringify(oidcGateNone.error).includes('身份纳管'), JSON.stringify(oidcGateNone.error))
  const oidcIssue = await api('POST', `/api/agents/${oidcAgentId}/sso-client`, { token: ops, body: { redirectUris: ['http://127.0.0.1:3080/auth/oidc/callback'] } })
  check('Agent SSO 签发 200（owner 自助，refType=agent，secret 一次性返回）',
    oidcIssue.ok && oidcIssue.data.clientId?.startsWith('oc-') && Boolean(oidcIssue.data.clientSecret), JSON.stringify(oidcIssue.error))
  const oidcIssueDup = await api('POST', `/api/agents/${oidcAgentId}/sso-client`, { token: ops, body: { redirectUris: ['http://127.0.0.1:3080/auth/oidc/callback'] } })
  check('重复签发被拒（先禁用后重签）', !oidcIssueDup.ok)
  const oidcAgentCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: oidcAgentCreate.data.credential.clientId, clientSecret: oidcAgentCreate.data.credential.clientSecret } })
  // 机器环回自助（APP_SSO_MACHINE_LOOPBACK 默认开）：绑定凭证 + 环回回调 → 自助轮换/改回调放行
  const oidcMachineRotate = await api('POST', `/api/agents/${oidcAgentId}/sso-client/rotate`, { token: oidcAgentCc.data.token, body: {} })
  check('机器身份轮换环回回调客户端 200（绑定凭证环回自助）', oidcMachineRotate.ok && Boolean(oidcMachineRotate.data.clientSecret), JSON.stringify(oidcMachineRotate))
  const oidcMachinePatchLoop = await api('PATCH', `/api/agents/${oidcAgentId}/sso-client`, { token: oidcAgentCc.data.token, body: { redirectUris: ['http://localhost:3080/auth/oidc/callback'] } })
  check('机器身份自助改回调（环回→环回）200', oidcMachinePatchLoop.ok && oidcMachinePatchLoop.data.redirectUris.includes('http://localhost:3080/auth/oidc/callback'), JSON.stringify(oidcMachinePatchLoop))
  const oidcOwnerPinPublic = await api('PATCH', `/api/agents/${oidcAgentId}/sso-client`, { token: ops, body: { redirectUris: ['https://sso-agent.example.com/cb'] } })
  check('owner 把 Agent 回调改为公网 https 200', oidcOwnerPinPublic.ok, JSON.stringify(oidcOwnerPinPublic.error))
  const oidcMachineRotatePub = await api('POST', `/api/agents/${oidcAgentId}/sso-client/rotate`, { token: oidcAgentCc.data.token, body: {} })
  check('机器身份轮换非环回回调客户端被拒 403（环回限定）', oidcMachineRotatePub.status === 403, JSON.stringify(oidcMachineRotatePub))
  const oidcOwnerPinBack = await api('PATCH', `/api/agents/${oidcAgentId}/sso-client`, { token: ops, body: { redirectUris: ['http://127.0.0.1:3080/auth/oidc/callback'] } })
  check('owner 恢复 Agent 环回回调 200', oidcOwnerPinBack.ok, JSON.stringify(oidcOwnerPinBack.error))
  const oidcBadUri = await api('POST', `/api/agents/${oidcAgentId}/sso-client`, { token: ops, body: { redirectUris: [] } })
  check('签发校验：redirectUris 为空被拒（客户端已存在先拒）', !oidcBadUri.ok)
  const oidcAgentDetail = await api('GET', `/api/agents/${oidcAgentId}`, { token: admin })
  check('Agent 详情含 SSO 配置块（discovery / refAgentName / 门禁模式）',
    oidcAgentDetail.ok && oidcAgentDetail.data.sso?.clientId && oidcAgentDetail.data.sso?.discovery?.authorization_endpoint
    && oidcAgentDetail.data.sso?.refAgentName === 'SSO 自测机器人' && oidcAgentDetail.data.ssoEnforceMode === '1',
    JSON.stringify(oidcAgentDetail.data?.sso))
  const oidcGatePass = await api('POST', `/api/agents/${oidcAgentId}/transition`, { token: ops, body: { action: 'online' } })
  check('上线门禁（点1）：已签发客户端后放行并快照 clientId', oidcGatePass.ok && oidcGatePass.data.approval?.payload?.ssoClientId, JSON.stringify(oidcGatePass.error))
  const oidcDisable = await api('POST', `/api/agents/${oidcAgentId}/sso-client/disable`, { token: admin, body: { reason: '执行期复核测试' } })
  check('管理员禁用客户端 200', oidcDisable.ok)
  const oidcApproveFail = await api('POST', `/api/approvals/${oidcGatePass.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '复核应失败', confirmed: true } })
  const oidcAfterFail = await api('GET', `/api/agents/${oidcAgentId}`, { token: admin })
  check('上线门禁（点2）：审批期间禁用 → 执行期复核失败留痕',
    oidcApproveFail.ok && oidcApproveFail.data.status === 'failed' && String(oidcApproveFail.data.execution?.error ?? '').includes('身份纳管'), JSON.stringify(oidcApproveFail.data))
  check('复核失败状态未上线', oidcAfterFail.data.status !== 'online')
  const oidcEnable = await api('POST', `/api/agents/${oidcAgentId}/sso-client/enable`, { token: ops, body: {} })
  check('owner 重新启用客户端 200', oidcEnable.ok && oidcEnable.data.status === 'active')
  const oidcGatePass2 = await api('POST', `/api/agents/${oidcAgentId}/transition`, { token: ops, body: { action: 'online' } })
  const oidcApproveOk = await api('POST', `/api/approvals/${oidcGatePass2.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '复核通过', confirmed: true } })
  const oidcAfterOnline = await api('GET', `/api/agents/${oidcAgentId}`, { token: admin })
  check('重新发起上线 → 审批执行成功（状态 online）', oidcApproveOk.ok && oidcApproveOk.data.status === 'executed' && oidcAfterOnline.data.status === 'online', JSON.stringify(oidcApproveFail.data))
  const oidcRotate = await api('POST', `/api/agents/${oidcAgentId}/sso-client/rotate`, { token: ops, body: {} })
  check('owner 轮换 secret 200（旧值立即失效）', oidcRotate.ok && Boolean(oidcRotate.data.clientSecret))
  const oidcOfflineReq = await api('POST', `/api/agents/${oidcAgentId}/transition`, { token: ops, body: { action: 'offline', note: '联动测试' } })
  const oidcOfflineOk = await api('POST', `/api/approvals/${oidcOfflineReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '下线', confirmed: true } })
  const oidcAfterOffline = await api('GET', `/api/agents/${oidcAgentId}`, { token: admin })
  check('Agent 下线联动：关联 OIDC 客户端自动禁用（refresh 链一并吊销）',
    oidcOfflineOk.ok && oidcAfterOffline.data.status === 'offline' && oidcAfterOffline.data.sso?.status === 'disabled', JSON.stringify(oidcAfterOffline.data?.sso))

  // —— headless 第三纳管通道（2026-10-31）：纯后台执行体（Work Body 等）无界面无回调 ——
  section('Agent 身份纳管第三通道（headless 纯后台声明 → 门禁凭机器凭证放行）')
  const hlAgentCreate = await api('POST', '/api/agents', { token: ops, body: { name: 'headless 自测机器人', attrs: { description: '纯后台执行体 headless 门禁自测', model: 'deepseek-chat', riskLevel: 'low', dataClass: 'internal' } } })
  check('注册 headless 自测 Agent（无 entryUrl、无 SSO 客户端）', hlAgentCreate.ok && Boolean(hlAgentCreate.data.credential?.clientId), JSON.stringify(hlAgentCreate.error))
  const hlAgentId = hlAgentCreate.data.agent.id
  const hlGateNone = await api('POST', `/api/agents/${hlAgentId}/transition`, { token: ops, body: { action: 'online' } })
  check('headless：三无（无客户端/entryUrl/声明）仍被拒并指路（新文案含 headless）',
    !hlGateNone.ok && JSON.stringify(hlGateNone.error).includes('身份纳管') && JSON.stringify(hlGateNone.error).includes('headless'), JSON.stringify(hlGateNone.error))
  const hlDeclare = await api('PATCH', `/api/agents/${hlAgentId}`, { token: ops, body: { attrs: { headless: true } } })
  check('owner 声明 attrs.headless=true 200（boolean 校验通过）', hlDeclare.ok && hlDeclare.data.attrs?.headless === true, JSON.stringify(hlDeclare.error))
  const hlGatePass = await api('POST', `/api/agents/${hlAgentId}/transition`, { token: ops, body: { action: 'online' } })
  check('headless：声明后门禁放行（挂单成功，快照无 ssoClientId）', hlGatePass.ok && hlGatePass.data.approval?.id && !hlGatePass.data.approval?.payload?.ssoClientId, JSON.stringify(hlGatePass.error))
  const hlBadType = await api('PATCH', `/api/agents/${hlAgentId}`, { token: ops, body: { attrs: { headless: 'yes' } } })
  check('headless 属性类型护栏：字符串被拒（必须是布尔值）', !hlBadType.ok && JSON.stringify(hlBadType.error).includes('布尔'), JSON.stringify(hlBadType.error))
  const hlRevokeMid = await api('PATCH', `/api/agents/${hlAgentId}`, { token: ops, body: { attrs: { headless: false } } })
  check('审批挂单期间撤销 headless 声明 200（模拟门禁失效）', hlRevokeMid.ok)
  const hlApproveFail = await api('POST', `/api/approvals/${hlGatePass.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '执行期复核应失败', confirmed: true } })
  const hlAfterFail = await api('GET', `/api/agents/${hlAgentId}`, { token: admin })
  check('headless：审批期间撤销声明 → 执行期复核失败留痕（身份纳管）',
    hlApproveFail.ok && hlApproveFail.data.status === 'failed' && String(hlApproveFail.data.execution?.error ?? '').includes('身份纳管'), JSON.stringify(hlApproveFail.data))
  check('headless：复核失败状态未上线', hlAfterFail.data.status !== 'online')
  const hlRedeclare = await api('PATCH', `/api/agents/${hlAgentId}`, { token: ops, body: { attrs: { headless: true } } })
  const hlGatePass2 = await api('POST', `/api/agents/${hlAgentId}/transition`, { token: ops, body: { action: 'online' } })
  const hlApproveOk = await api('POST', `/api/approvals/${hlGatePass2.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '复核通过', confirmed: true } })
  const hlAfterOnline = await api('GET', `/api/agents/${hlAgentId}`, { token: admin })
  check('headless：重新声明后上线审批执行成功（状态 online）',
    hlRedeclare.ok && hlApproveOk.ok && hlApproveOk.data.status === 'executed' && hlAfterOnline.data.status === 'online', JSON.stringify(hlApproveOk.data))

  // ================================================================ AI 应用 ↔ SSO 打通（MVP 闭环）

  // ================================================================ AI 应用 ↔ SSO 打通（MVP 闭环）
  section('AI 应用 ↔ SSO 打通（注册 → 签发 → 门禁双点 → 跳转登录）')
  const ssoAppCreate = await api('POST', '/api/apps', { token: ops, body: { name: 'SSO 自测应用', attrs: { description: 'MVP 闭环：注册 → 签发 → 门禁 → 浏览器授权流', appType: 'web', icon: '🔐', url: 'https://sso-app.example.com', riskLevel: 'low', dataClass: 'internal', agentIds: [targetAgent.id] }, agentIds: [targetAgent.id] } })
  check('注册应用（编排在线 Agent，owner=资源管理员）', ssoAppCreate.ok && ssoAppCreate.data.credential.clientId)
  const ssoAppId = ssoAppCreate.data.app.id

  // 应用凭证默认 app.write/app.read（指标提报与自主更新闭环，2026-08）
  const ssoAppCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: ssoAppCreate.data.credential.clientId, clientSecret: ssoAppCreate.data.credential.clientSecret } })
  check('新注册应用凭证默认含 app.write/app.read（提报与自更新）', ssoAppCc.ok && ssoAppCc.data.principal.scopes.includes('app.write') && ssoAppCc.data.principal.scopes.includes('app.read'))
  const ssoAppFirstReport = await api('POST', `/api/apps/${ssoAppId}/metrics-report`, { token: ssoAppCc.data.token, body: { dau: 1, sessions: 1, avgDepth: 1, retention7: 0 } })
  check('应用凭自身凭证提报指标 200（app.write 生效，"发一句话"）', ssoAppFirstReport.ok)

  // 平台授权直达：应用入场票据（与 Agent 同一服务，refType=app）
  const appTicketMachine = await api('POST', `/api/apps/${ssoAppId}/entry-ticket`, { token: ssoAppCc.data.token, body: {} })
  check('应用直达票据：机器身份签发被拒（human-only）', appTicketMachine.status === 403)
  const appTicket = await api('POST', `/api/apps/${ssoAppId}/entry-ticket`, { token: admin, body: {} })
  check('应用直达票据：登录用户签发 200', appTicket.ok && appTicket.data.ticket.startsWith('etk_'), JSON.stringify(appTicket.error))
  const appRedeem = await rawReq('POST', '/api/authn/entry-tickets/redeem', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: appTicket.data.ticket }),
  })
  const appRedeemBody = jsonBody(appRedeem)
  check('应用直达票据：兑换返回 refType=app + 平台身份', appRedeem.status === 200 && appRedeemBody.data?.refType === 'app' && appRedeemBody.data?.refId === ssoAppId && Boolean(appRedeemBody.data?.identity?.sub), JSON.stringify(appRedeemBody))

  // 门禁点 1（早反馈）：未签发 SSO 客户端 → 发起上线被拒
  const gateBlocked = await api('POST', `/api/apps/${ssoAppId}/transition`, { token: ops, body: { action: 'online' } })
  check('上线门禁（点1）：未签发 SSO 客户端被拒并指路', !gateBlocked.ok && JSON.stringify(gateBlocked.error).includes('SSO'))

  // owner-based 授权：非 owner 开发者 / 机器身份一律 403
  const devSso = await api('POST', `/api/apps/${ssoAppId}/sso-client`, { token: dev, body: { redirectUris: ['https://evil.example/cb'] } })
  check('非 owner 开发者签发被拒（developer 有 app.write 但非 owner）', devSso.status === 403)
  const machineCredAppWrite = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'sso-gate-machine', refType: 'external', scopes: ['app.write'] } })
  const machineAppWriteLogin = await api('POST', '/api/auth/client-credentials', { body: { clientId: machineCredAppWrite.data.clientId, clientSecret: machineCredAppWrite.data.clientSecret } })
  const machineSso = await api('POST', `/api/apps/${ssoAppId}/sso-client`, { token: machineAppWriteLogin.data.token, body: { redirectUris: ['https://evil.example/cb'] } })
  check('机器身份签发被拒（非环回回调须 human owner/管理员）', machineSso.status === 403)
  const machineSsoLoopExternal = await api('POST', `/api/apps/${ssoAppId}/sso-client`, { token: machineAppWriteLogin.data.token, body: { redirectUris: ['http://127.0.0.1:9999/cb'] } })
  check('未绑定机器身份签发环回回调仍被拒 403（须应用自身凭证/登记 owner）', machineSsoLoopExternal.status === 403, JSON.stringify(machineSsoLoopExternal))

  // 机器环回自助正例：应用自身凭证自助签发/改配/轮换（环回回调，owner 无需到控制台代办）
  const selfAppCreate = await api('POST', '/api/apps', { token: ops, body: { name: '环回自助签发应用', attrs: { description: '机器凭证环回自助签发回归', appType: 'web', icon: '🧪', url: 'http://127.0.0.1:5000', riskLevel: 'low', dataClass: 'internal' } } })
  check('注册环回自助签发用应用（自动带机器凭证）', selfAppCreate.ok && selfAppCreate.data.credential.clientId, JSON.stringify(selfAppCreate.error))
  const selfAppCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: selfAppCreate.data.credential.clientId, clientSecret: selfAppCreate.data.credential.clientSecret } })
  const selfAppIssue = await api('POST', `/api/apps/${selfAppCreate.data.app.id}/sso-client`, { token: selfAppCc.data.token, body: { redirectUris: ['http://127.0.0.1:5000/oauth/cb', 'http://0.0.0.0:5000/cb'] } })
  check('应用自身凭证自助签发环回 SSO 客户端 200（127.0.0.1 / 0.0.0.0 放行）', selfAppIssue.ok && selfAppIssue.data.clientId?.startsWith('oc-') && Boolean(selfAppIssue.data.clientSecret), JSON.stringify(selfAppIssue.error))
  const selfAppMachinePatch = await api('PATCH', `/api/apps/${selfAppCreate.data.app.id}/sso-client`, { token: selfAppCc.data.token, body: { redirectUris: ['http://localhost:5000/oauth/cb'] } })
  check('应用自身凭证自助改回调（环回→环回）200', selfAppMachinePatch.ok, JSON.stringify(selfAppMachinePatch.error))
  const selfAppMachineNonLoop = await api('PATCH', `/api/apps/${selfAppCreate.data.app.id}/sso-client`, { token: selfAppCc.data.token, body: { redirectUris: ['https://evil.example/cb'] } })
  check('应用自身凭证改回调为非环回被拒 403', selfAppMachineNonLoop.status === 403, JSON.stringify(selfAppMachineNonLoop))
  const selfAppMachineRotate = await api('POST', `/api/apps/${selfAppCreate.data.app.id}/sso-client/rotate`, { token: selfAppCc.data.token, body: {} })
  check('应用自身凭证轮换环回客户端 secret 200', selfAppMachineRotate.ok && Boolean(selfAppMachineRotate.data.clientSecret), JSON.stringify(selfAppMachineRotate.error))
  const selfAppMachineDisable = await api('POST', `/api/apps/${selfAppCreate.data.app.id}/sso-client/disable`, { token: selfAppCc.data.token, body: { reason: '自助降险（机器恒可禁用）' } })
  check('应用自身凭证禁用客户端 200（disable 纯降险恒放行）', selfAppMachineDisable.ok && selfAppMachineDisable.data.status === 'disabled', JSON.stringify(selfAppMachineDisable))
  const selfAppMachineEnable = await api('POST', `/api/apps/${selfAppCreate.data.app.id}/sso-client/enable`, { token: selfAppCc.data.token, body: {} })
  check('应用自身凭证重新启用环回客户端 200', selfAppMachineEnable.ok && selfAppMachineEnable.data.status === 'active', JSON.stringify(selfAppMachineEnable.error))

  // owner 签发（secret 仅一次）+ 回跳地址护栏
  const issueSso = await api('POST', `/api/apps/${ssoAppId}/sso-client`, { token: ops, body: { redirectUris: ['https://sso-app.example.com/cb'], clientType: 'confidential', consentRequired: false } })
  check('owner 签发 SSO 客户端（secret 一次性返回）', issueSso.ok && issueSso.data.clientId.startsWith('oc-') && issueSso.data.clientSecret.startsWith('ocs'))
  const badUri = await api('PATCH', `/api/apps/${ssoAppId}/sso-client`, { token: ops, body: { redirectUris: ['http://insecure.example/cb'] } })
  check('回跳地址护栏（http 公网域名仍被拒）', !badUri.ok)
  const lanUri = await api('PATCH', `/api/apps/${ssoAppId}/sso-client`, { token: ops, body: { redirectUris: ['http://192.168.0.7:8080', 'http://10.1.2.3/cb', 'http://172.16.5.4/cb', 'http://localhost:3000/cb', 'https://sso-app.example.com/cb'] } })
  check('回跳地址护栏（http 内网 IP / localhost 放行）', lanUri.ok && lanUri.data.redirectUris.includes('http://192.168.0.7:8080'))
  const restoreUri = await api('PATCH', `/api/apps/${ssoAppId}/sso-client`, { token: ops, body: { redirectUris: ['https://sso-app.example.com/cb'] } })
  check('回跳地址恢复 https（后续授权流沿用）', restoreUri.ok)
  const ssoDetail = await api('GET', `/api/apps/${ssoAppId}`, { token: ops })
  check('应用详情返回 sso 块（无 secret 泄露）', ssoDetail.ok && ssoDetail.data.sso?.clientId === issueSso.data.clientId && !JSON.stringify(ssoDetail.data.sso).includes('Secret'))

  // 门禁点 2（兜底）：审批挂单期间禁用客户端 → 审批通过但执行失败留痕
  const onlineReq1 = await api('POST', `/api/apps/${ssoAppId}/transition`, { token: ops, body: { action: 'online' } })
  check('签发后发起上线（审批单快照 ssoClientId）', onlineReq1.ok && onlineReq1.data.approval.payload.ssoClientId === issueSso.data.clientId)
  await api('POST', `/api/apps/${ssoAppId}/sso-client/disable`, { token: ops, body: { reason: '审批期间禁用（执行期复核演练）' } })
  const approveFail = await api('POST', `/api/approvals/${onlineReq1.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '应触发执行期复核失败', confirmed: true } })
  const appAfterFail = await api('GET', `/api/apps/${ssoAppId}`, { token: ops })
  check('门禁点2：审批期间禁用 → 上线执行失败留痕', approveFail.ok && approveFail.data.status === 'failed' && String(approveFail.data.execution?.error ?? '').includes('复核') && appAfterFail.data.status !== 'online')

  // 重新启用 → 再次审批 → 上线成功
  await api('POST', `/api/apps/${ssoAppId}/sso-client/enable`, { token: ops })
  const onlineReq2 = await api('POST', `/api/apps/${ssoAppId}/transition`, { token: ops, body: { action: 'online' } })
  await api('POST', `/api/approvals/${onlineReq2.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '同意发布', confirmed: true } })
  const appOnlineDetail = await api('GET', `/api/apps/${ssoAppId}`, { token: admin })
  check('复核通过后上线成功', appOnlineDetail.data.status === 'online')
  check('应用拓扑穿透（app→agent→skill）', appOnlineDetail.ok && appOnlineDetail.data.topology.children.length >= 1)
  check('应用成本穿透归集', appOnlineDetail.ok && appOnlineDetail.data.cost.length >= 1)

  // 完整浏览器流（应用客户端）：第一跳 → 用户确认 → 换牌 → userinfo
  const appAuthorizeQuery = new URLSearchParams({
    response_type: 'code', client_id: issueSso.data.clientId, redirect_uri: 'https://sso-app.example.com/cb',
    state: 'st-app-mvp', scope: 'openid profile', code_challenge: pkceChallenge, code_challenge_method: 'S256',
  }).toString()
  const appFirst = await rawReq('GET', `/oauth/authorize?${appAuthorizeQuery}`)
  check('应用客户端授权第一跳 → 平台授权页', appFirst.status === 302 && String(appFirst.headers.location).startsWith('/#/oauth/authorize?req='))
  const appApprove = await authorizeConfirm(ops, reqIdOf(appFirst), true)
  const appTokens = jsonBody(await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${issueSso.data.clientId}:${issueSso.data.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: new URL(appApprove.result.location).searchParams.get('code'), redirect_uri: 'https://sso-app.example.com/cb', code_verifier: pkceVerifier }).toString(),
  }))
  const appUserInfo = jsonBody(await rawReq('GET', '/oauth/userinfo', { headers: { authorization: `Bearer ${appTokens.access_token}` } }))
  check('应用完整浏览器流（authorize → consent → token → userinfo）', appTokens.access_token?.split('.').length === 3 && appUserInfo.sub === opsLogin.data.user.id && appUserInfo.org !== null)

  // 钉钉身份驱动同一条授权流（授权页登录面板「钉钉扫码」入口对应的端点链）：
  // providers 探测入口显隐 → sso 免密登录换平台会话 → 该会话完成 consent → 换牌 → userinfo 身份一致
  const dingProviders = await api('GET', '/api/auth/providers')
  check('授权页可探测钉钉登录入口（providers 公开回显）', dingProviders.ok && dingProviders.data.providers.some((p) => p.provider === 'dingtalk'))
  const dingAuth = await api('POST', '/api/auth/sso/authorize', { body: { provider: 'dingtalk', scene: 'web_qr' } })
  const dingSso = await api('POST', '/api/auth/sso', { body: { provider: 'dingtalk', code: 'DD0002', state: dingAuth.data.state } })
  check('钉钉身份在授权页登录（sso hit 签发平台会话令牌）', dingSso.ok && dingSso.data.kind === 'hit' && Boolean(dingSso.data.token))
  const dingFirst = await rawReq('GET', `/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: issueSso.data.clientId, redirect_uri: 'https://sso-app.example.com/cb',
    state: 'st-app-ding', scope: 'openid profile', code_challenge: pkceChallenge, code_challenge_method: 'S256',
  }).toString()}`)
  const dingApprove = await authorizeConfirm(dingSso.data.token, reqIdOf(dingFirst), true)
  const dingTokens = jsonBody(await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${issueSso.data.clientId}:${issueSso.data.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: new URL(dingApprove.result.location).searchParams.get('code'), redirect_uri: 'https://sso-app.example.com/cb', code_verifier: pkceVerifier }).toString(),
  }))
  const dingUserInfo = jsonBody(await rawReq('GET', '/oauth/userinfo', { headers: { authorization: `Bearer ${dingTokens.access_token}` } }))
  check('钉钉身份完整浏览器流（sso 登录 → consent → token → userinfo 身份一致）',
    dingFirst.status === 302 && dingApprove.status === 200 && dingTokens.access_token?.split('.').length === 3
    && dingUserInfo.sub === dingSso.data.user.id && dingUserInfo.preferred_username === dingSso.data.user.username)

  // 平台侧自动折算回归（真实链路汇点）：ticket 兑换（admin）+ OIDC 发码（ops、钉钉用户）→ 应用 DAU/UV 自动落账
  const mvpMetrics = (await api('GET', `/api/apps/${ssoAppId}`, { token: admin })).data.metrics
  check('SSO 到访自动折算（ticket admin + 发码 ops/钉钉 → dau=3 uv=3，同用户重复授权去重）', mvpMetrics.dau === 3 && mvpMetrics.uv === 3, JSON.stringify(mvpMetrics))

  // app.updated 联动：应用改名 → 客户端名称同步
  await api('PATCH', `/api/apps/${ssoAppId}`, { token: ops, body: { name: 'SSO 自测应用 v2' } })
  const clientsAfterRename = await api('GET', '/api/authn/oidc/clients', { token: admin })
  const renamedClient = clientsAfterRename.data.clients.find((c) => c.clientId === issueSso.data.clientId)
  check('应用改名 → OIDC 客户端名称同步（app.updated 联动）', renamedClient?.name === 'SSO 自测应用 v2' && renamedClient.refAppName === 'SSO 自测应用 v2')

  // 轮换：旧 secret 立即失效
  const rotatedApp = await api('POST', `/api/apps/${ssoAppId}/sso-client/rotate`, { token: ops })
  check('owner 轮换 secret（新值一次性返回）', rotatedApp.ok && rotatedApp.data.clientSecret.startsWith('ocs') && rotatedApp.data.clientSecret !== issueSso.data.clientSecret)
  const rotFirst = await rawReq('GET', `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(appAuthorizeQuery)), state: 'st-rotate' }).toString()}`)
  const rotApprove = await authorizeConfirm(ops, reqIdOf(rotFirst), true)
  const rotCode = new URL(rotApprove.result.location).searchParams.get('code')
  const oldSecretCall = await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: issueSso.data.clientId, client_secret: issueSso.data.clientSecret, code: rotCode, redirect_uri: 'https://sso-app.example.com/cb', code_verifier: pkceVerifier }).toString(),
  })
  check('轮换后旧 secret 被拒（401）', oldSecretCall.status === 401)
  const rotFirst2 = await rawReq('GET', `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(appAuthorizeQuery)), state: 'st-rotate2' }).toString()}`)
  const rotApprove2 = await authorizeConfirm(ops, reqIdOf(rotFirst2), true)
  const newSecretCall = await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: issueSso.data.clientId, client_secret: rotatedApp.data.clientSecret, code: new URL(rotApprove2.result.location).searchParams.get('code'), redirect_uri: 'https://sso-app.example.com/cb', code_verifier: pkceVerifier }).toString(),
  })
  check('新 secret 换牌成功', newSecretCall.status === 200)

  // 生命周期联动：下架 → 客户端禁用；恢复上线 → 客户端启用；归档 → 客户端禁用（终态）
  const offlineReq1 = await api('POST', `/api/apps/${ssoAppId}/transition`, { token: ops, body: { action: 'offline', note: '联动演练：下架' } })
  await api('POST', `/api/approvals/${offlineReq1.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '同意下架', confirmed: true } })
  const afterOffline = await api('GET', `/api/apps/${ssoAppId}`, { token: ops })
  check('应用下架 → SSO 客户端联动禁用（app.offlined）', afterOffline.data.status === 'offline' && afterOffline.data.sso?.status === 'disabled')
  // 重新上线：下架联动禁用了客户端 → 门禁要求先重新启用（控制台 SSO tab 有警示与入口）
  const reonlineBlocked = await api('POST', `/api/apps/${ssoAppId}/transition`, { token: ops, body: { action: 'online' } })
  check('客户端禁用期间重新上线被门禁拦截', !reonlineBlocked.ok && JSON.stringify(reonlineBlocked.error).includes('SSO'))
  await api('POST', `/api/apps/${ssoAppId}/sso-client/enable`, { token: ops })
  await api('POST', `/api/apps/${ssoAppId}/transition`, { token: ops, body: { action: 'retrial' } })
  const onlineReq3 = await api('POST', `/api/apps/${ssoAppId}/transition`, { token: ops, body: { action: 'online' } })
  await api('POST', `/api/approvals/${onlineReq3.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '再次上线', confirmed: true } })
  const afterReline = await api('GET', `/api/apps/${ssoAppId}`, { token: ops })
  check('应用恢复上线 → 客户端联动启用（app.onlined）', afterReline.data.status === 'online' && afterReline.data.sso?.status === 'active')
  const offlineReq2 = await api('POST', `/api/apps/${ssoAppId}/transition`, { token: ops, body: { action: 'offline', note: '归档前下架' } })
  await api('POST', `/api/approvals/${offlineReq2.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '同意', confirmed: true } })
  await api('POST', `/api/apps/${ssoAppId}/transition`, { token: ops, body: { action: 'archive' } })
  const afterArchive = await api('GET', `/api/apps/${ssoAppId}`, { token: ops })
  check('应用归档 → 客户端联动禁用（app.archived 终态）', afterArchive.data.status === 'archived' && afterArchive.data.sso?.status === 'disabled')

  // ================================================================ OIDC 会话补全 + 安全闭环（P3）
  section('OIDC 会话补全（refresh 轮转 / end_session / revoke / 密钥轮换）')
  const ocList = await api('GET', '/api/authn/oidc/clients', { token: admin })
  const ocRecord = ocList.data.clients.find((c) => c.clientId === OC.clientId)
  check('OIDC 客户端全局列表（含关联应用与 discovery 元数据）', ocList.ok && Boolean(ocRecord) && ocRecord.discovery.token_endpoint.includes('/oauth/token') && ocList.data.clients.some((c) => c.refAppName === 'SSO 自测应用 v2'))
  await api('PATCH', `/api/authn/oidc/clients/${ocRecord.id}`, { token: admin, body: { postLogoutUris: ['https://crm.partner.example/logged-out'] } })

  // openid-client 联测扩充：refresh 轮转 → 旧值重放整链吊销
  const p3Auth1 = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'p3-refresh' })}`)
  const p3Approve1 = await authorizeConfirm(admin, reqIdOf(p3Auth1), true)
  const p3Tokens1 = await oc.authorizationCodeGrant(ocConfig, new URL(p3Approve1.result.location), { pkceCodeVerifier: pkceVerifier, expectedState: 'p3-refresh' })
  const p3Refreshed = await oc.refreshTokenGrant(ocConfig, p3Tokens1.refresh_token)
  check('openid-client：refresh_token 轮转新令牌对', typeof p3Refreshed.access_token === 'string' && p3Refreshed.refresh_token !== p3Tokens1.refresh_token)
  let replayThrew = ''
  try { await oc.refreshTokenGrant(ocConfig, p3Tokens1.refresh_token) } catch (error) { replayThrew = String(error?.error ?? error?.message ?? error) }
  check('旧 refresh 重放被拒', replayThrew !== '')
  let chainDead = ''
  try { await oc.refreshTokenGrant(ocConfig, p3Refreshed.refresh_token) } catch (error) { chainDead = String(error?.error ?? error?.message ?? error) }
  check('重放触发整链吊销（轮转后的新 refresh 一并失效）', chainDead !== '')

  // scope 只允许收窄
  const p3Auth2 = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'p3-scope', scope: 'openid' })}`)
  const p3Approve2 = await authorizeConfirm(admin, reqIdOf(p3Auth2), true)
  const p3Tokens2 = await oc.authorizationCodeGrant(ocConfig, new URL(p3Approve2.result.location), { pkceCodeVerifier: pkceVerifier, expectedState: 'p3-scope' })
  const widen = await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: OC.clientId, client_secret: OC.clientSecret, refresh_token: p3Tokens2.refresh_token, scope: 'openid profile email' }).toString(),
  })
  check('refresh 扩大 scope 被拒（只允许收窄）', widen.status === 400 && jsonBody(widen).error === 'invalid_scope')

  // 冻结 → refresh 换发即时失效（安全必需：不等过期）
  const freezeUser = await api('POST', '/api/iam/users', { token: admin, body: { username: 'ssofreeze01', displayName: 'OIDC 冻结联动', orgId: newOrg.data.id } })
  const freezeLogin = await api('POST', '/api/auth/login', { body: { username: 'ssofreeze01', password: freezeUser.data.initialPassword } })
  const fzAuth = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'p3-frozen' })}`)
  const fzApprove = await authorizeConfirm(freezeLogin.data.token, reqIdOf(fzAuth), true)
  const fzTokens = await oc.authorizationCodeGrant(ocConfig, new URL(fzApprove.result.location), { pkceCodeVerifier: pkceVerifier, expectedState: 'p3-frozen' })
  await api('POST', `/api/iam/users/${freezeUser.data.id}/freeze`, { token: admin, body: { reason: 'refresh 联动吊销验证' } })
  let frozenRefresh = ''
  try { await oc.refreshTokenGrant(ocConfig, fzTokens.refresh_token) } catch (error) { frozenRefresh = String(error?.error ?? error?.message ?? error) }
  check('账号冻结 → refresh 换发被拒（实时校验用户状态）', frozenRefresh !== '')

  // end_session：合法/非法回跳 + refresh 链吊销
  const esAuth = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'p3-endsession' })}`)
  const esApprove = await authorizeConfirm(admin, reqIdOf(esAuth), true)
  const esTokens = await oc.authorizationCodeGrant(ocConfig, new URL(esApprove.result.location), { pkceCodeVerifier: pkceVerifier, expectedState: 'p3-endsession' })
  const esUrl = oc.buildEndSessionUrl(ocConfig, { id_token_hint: esTokens.id_token, post_logout_redirect_uri: 'https://crm.partner.example/logged-out', state: 'logout-st' })
  const esOk = await rawReq('GET', esUrl.pathname + esUrl.search)
  check('end_session 合法回跳 → 302 平台登出中转页', esOk.status === 302 && String(esOk.headers.location).startsWith('/#/oauth/logout') && String(esOk.headers.location).includes('logged-out'))
  let esChainDead = ''
  try { await oc.refreshTokenGrant(ocConfig, esTokens.refresh_token) } catch (error) { esChainDead = String(error?.error ?? error?.message ?? error) }
  check('end_session 同时吊销 refresh 链（登出后不能静默续期）', esChainDead !== '')
  const esBad = await rawReq('GET', `/oauth/end_session?${new URLSearchParams({ id_token_hint: esTokens.id_token, post_logout_redirect_uri: 'https://evil.example/x' }).toString()}`)
  check('end_session 非法回跳 → 平台错误页（不开放重定向）', esBad.status === 302 && String(esBad.headers.location).startsWith('/#/oauth/error'))
  // 登出回退：RP 未显式携带 post_logout_redirect_uri（如纯前端门户只传 id_token_hint）
  const esBare = await rawReq('GET', `/oauth/end_session?${new URLSearchParams({ id_token_hint: esTokens.id_token }).toString()}`)
  check('end_session 未带回跳参数 → 按唯一登记登出地址回跳（门户登出场景兜底）',
    esBare.status === 302 && String(esBare.headers.location).startsWith('/#/oauth/logout') && String(esBare.headers.location).includes('logged-out'))
  await api('PATCH', `/api/authn/oidc/clients/${ocRecord.id}`, { token: admin, body: { postLogoutUris: ['https://crm.partner.example/logged-out', 'https://crm.partner.example/other'] } })
  const esAmbiguous = await rawReq('GET', `/oauth/end_session?${new URLSearchParams({ id_token_hint: esTokens.id_token }).toString()}`)
  const esAmbiguousLoc = String(esAmbiguous.headers.location)
  check('end_session 未带参数且登记多个登出地址 → 不猜测回跳，停留平台登出页',
    esAmbiguous.status === 302 && esAmbiguousLoc.startsWith('/#/oauth/logout') && !esAmbiguousLoc.includes('post_logout_redirect_uri'))
  await api('PATCH', `/api/authn/oidc/clients/${ocRecord.id}`, { token: admin, body: { postLogoutUris: ['https://crm.partner.example/logged-out'] } })

  // revoke（RFC 7009）：access jti 黑名单 + refresh 链
  const rvAuth = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'p3-revoke' })}`)
  const rvApprove = await authorizeConfirm(admin, reqIdOf(rvAuth), true)
  const rvTokens = await oc.authorizationCodeGrant(ocConfig, new URL(rvApprove.result.location), { pkceCodeVerifier: pkceVerifier, expectedState: 'p3-revoke' })
  await oc.tokenRevocation(ocConfig, rvTokens.access_token)
  const revokedInfo = await rawReq('GET', '/oauth/userinfo', { headers: { authorization: `Bearer ${rvTokens.access_token}` } })
  check('revoke access token → userinfo 即时 401', revokedInfo.status === 401)
  await oc.tokenRevocation(ocConfig, rvTokens.refresh_token)
  let revokedRefresh = ''
  try { await oc.refreshTokenGrant(ocConfig, rvTokens.refresh_token) } catch (error) { revokedRefresh = String(error?.error ?? error?.message ?? error) }
  check('revoke refresh token → 换发被拒', revokedRefresh !== '')

  // JWKS 密钥轮换：旧 token 宽限内验签通过、新 token kid 切换、JWKS 双 key
  const krAuth = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'p3-rotate' })}`)
  const krApprove = await authorizeConfirm(admin, reqIdOf(krAuth), true)
  const krTokensOld = await oc.authorizationCodeGrant(ocConfig, new URL(krApprove.result.location), { pkceCodeVerifier: pkceVerifier, expectedState: 'p3-rotate' })
  const keysRotated = await api('POST', '/api/authn/oidc/keys/rotate', { token: admin })
  const oldKid = JSON.parse(Buffer.from(krTokensOld.access_token.split('.')[0], 'base64url').toString('utf8')).kid
  check('密钥轮换执行（新 kid + 24h 宽限）', keysRotated.ok && keysRotated.data.kid !== oldKid && keysRotated.data.graceHours === 24)
  const graceInfo = await rawReq('GET', '/oauth/userinfo', { headers: { authorization: `Bearer ${krTokensOld.access_token}` } })
  check('轮换后旧 token 宽限内仍可验签（在途不掉线）', graceInfo.status === 200)
  const krAuth2 = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ state: 'p3-rotate2' })}`)
  const krApprove2 = await authorizeConfirm(admin, reqIdOf(krAuth2), true)
  const krTokensNew = await oc.authorizationCodeGrant(ocConfig, new URL(krApprove2.result.location), { pkceCodeVerifier: pkceVerifier, expectedState: 'p3-rotate2' })
  const newKid = JSON.parse(Buffer.from(krTokensNew.access_token.split('.')[0], 'base64url').toString('utf8')).kid
  check('新令牌切换到新 kid 签名', newKid === keysRotated.data.kid && newKid !== oldKid)
  const jwksAfterRotate = jsonBody(await rawReq('GET', '/.well-known/jwks.json'))
  check('JWKS 宽限期公布双公钥（旧 key 保留验签）', jwksAfterRotate.keys.length === 2 && jwksAfterRotate.keys.some((k) => k.kid === oldKid) && jwksAfterRotate.keys.some((k) => k.kid === newKid))

  // public 客户端（D-a 决策）：免 secret + 强制 PKCE + 不签发 refresh（纯前端 SPA 形态）
  const publicClient = await api('POST', '/api/authn/oidc/clients', { token: admin, body: { name: '纯前端 SPA（public）', redirectUris: ['http://localhost:5173/cb'], clientType: 'public' } })
  check('登记 public 客户端（无 secret 返回）', publicClient.ok && !publicClient.data.clientSecret && publicClient.data.note.includes('public'))
  const pubAuth = await rawReq('GET', `/oauth/authorize?${authorizeQuery({ client_id: publicClient.data.clientId, redirect_uri: 'http://localhost:5173/cb', state: 'p3-public' })}`)
  const pubApprove = await authorizeConfirm(admin, reqIdOf(pubAuth), true)
  const pubTokens = jsonBody(await rawReq('POST', '/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: publicClient.data.clientId, code: new URL(pubApprove.result.location).searchParams.get('code'), redirect_uri: 'http://localhost:5173/cb', code_verifier: pkceVerifier }).toString(),
  }))
  check('public 客户端免 secret 换牌成功且不签发 refresh', pubTokens.access_token?.split('.').length === 3 && pubTokens.refresh_token === undefined)

  // 授权事件审计留痕（按 resourceType 过滤：断言只关心两类事件是否落账，不随全量日志体量漂移）
  const oidcAudit = await api('GET', '/api/audit/logs?resourceType=oidc_client&limit=50', { token: admin })
  check('授权事件审计留痕（granted / denied）', oidcAudit.ok && oidcAudit.data.items.some((log) => log.action === 'oidc.authorize.granted') && oidcAudit.data.items.some((log) => log.action === 'oidc.authorize.denied'))

  // ================================================================ 审计
  section('审计与告警与成本')
  const logsAll = await api('GET', '/api/audit/logs?limit=200', { token: admin })
  const types = new Set(logsAll.data.items.map((log) => log.type))
  check('四类审计日志齐全', ['auth', 'authz', 'invoke', 'change'].every((type) => types.has(type)))
  check('越权拒绝已留痕（authz denied）', logsAll.data.items.some((log) => log.type === 'authz' && log.result === 'denied'))

  const logsFilter = await api('GET', '/api/audit/logs?type=invoke&result=ok&limit=5', { token: admin })
  check('审计筛选（类型+结果）', logsFilter.ok && logsFilter.data.items.every((log) => log.type === 'invoke'))

  const costApp = await api('GET', '/api/audit/cost?groupBy=app', { token: admin })
  check('成本按应用穿透', costApp.ok && costApp.data.rows.length >= 1)
  const costOrg = await api('GET', '/api/audit/cost?groupBy=org', { token: admin })
  check('成本按组织穿透', costOrg.ok && costOrg.data.rows.length >= 1)

  const ruleCreate = await api('POST', '/api/audit/alert-rules', { token: admin, body: { name: '自测规则', metric: 'permission_denied', threshold: 2, severity: 'critical' } })
  check('创建告警规则', ruleCreate.ok)

  // 告警已读体系：单条已读 → 一键全部已读 → 未读清零（403 探测放最后，避免中途触发新告警干扰计数）
  // 异步落地稳定化（2026-11-02 Windows 合并回归）：平台总线派发为异步串行（bus.ts OPT-P1-04），
  // 快照之前已 fire 的告警可能尚未落入 alerts() 集合——直接快照会把晚落地的一条算进 read-all，
  // 造成「返回条数 ≠ 快照未读-1」假失败。快照前轮询至未读数连续两次相等（在途事件落地完毕）。
  let alertsBefore = await api('GET', '/api/audit/alerts', { token: admin })
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const again = await api('GET', '/api/audit/alerts', { token: admin })
    if (!again.ok) break
    const settled = again.data.alerts.filter((a) => !a.read).length === alertsBefore.data.alerts.filter((a) => !a.read).length
    alertsBefore = again
    if (settled) break
  }
  const unreadBefore = alertsBefore.data.alerts.filter((a) => !a.read)
  check('告警中心存在未读告警（前置）', alertsBefore.ok && unreadBefore.length >= 1)
  const oneRead = await api('POST', `/api/audit/alerts/${unreadBefore[0].id}/read`, { token: admin })
  check('单条告警标记已读', oneRead.ok && oneRead.data.read === true)
  const readAll = await api('POST', '/api/audit/alerts/read-all', { token: admin })
  const alertsAfter = await api('GET', '/api/audit/alerts?unread=1', { token: admin })
  check('一键全部已读（返回条数 = 剩余未读，且未读清零）',
    readAll.ok && readAll.data.read === unreadBefore.length - 1 && alertsAfter.data.alerts.length === 0,
    // 诊断（2026-11-02 合并回归）：快照未读/本次已读/读后未读三计数，定位异步落地竞态
    JSON.stringify({ before: unreadBefore.length, read: readAll.data?.read, afterUnread: alertsAfter.data?.alerts?.length, ok: readAll.ok }))
  const readAllAgain = await api('POST', '/api/audit/alerts/read-all', { token: admin })
  check('重复一键已读幂等（返回 0）', readAllAgain.ok && readAllAgain.data.read === 0)
  const toolReadAll = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'audit_alerts_read_all', args: {} } })
  check('工具桥一键已读（audit_alerts_read_all）', toolReadAll.ok && toolReadAll.data.isError === false)
  const readAllDenied = await api('POST', '/api/audit/alerts/read-all', { token: dev })
  check('无 audit.read 权限不可一键已读（403）', readAllDenied.status === 403)

  // ================================================================ 工具桥（dsh 工具契约）
  section('工具桥（模型可用工具）')
  const toolList = await api('GET', '/api/platform/info', { token: admin })
  check('工具目录 ≥ 37 个', toolList.data.tools.length >= 37)
  const toolExec = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'iam_org_tree', args: {} } })
  check('工具执行（iam_org_tree）', toolExec.ok && toolExec.data.isError === false && JSON.stringify(toolExec.data.value).includes('元冰可集团'))
  const toolAgentList = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'agent_list', args: { status: 'online' } } })
  check('工具执行（agent_list 过滤）', toolAgentList.ok && toolAgentList.data.value.total >= 5)

  // ================================================================ 平台自更新（版本检查 / 权限 / dry-run / 审计联动）
  section('平台自更新（plugin-update）')
  check('更新工具已注册（update_status 等）', toolList.data.tools.some((t) => t.name === 'update_status' && t.permission === 'platform.update.read'))

  const updStatus0 = await api('GET', '/api/update/status', { token: admin })
  check('更新状态可读（版本取自根 package.json）', updStatus0.ok && updStatus0.data.currentVersion === ROOT_PKG_VERSION)
  check('安装形态识别为 source（git 检出）', updStatus0.data.installMode === 'source')
  check('环境变量关闭自动检查生效（DSH_UPDATE_AUTO_CHECK=off）', updStatus0.data.autoCheck === false)
  check('未检查时无最新版本快照', updStatus0.data.latest === null)

  const updAnon = await api('GET', '/api/update/status')
  check('匿名访问更新状态被拒（401）', updAnon.status === 401)

  const updCheck1 = await api('POST', '/api/update/check', { token: admin })
  check('手动检查成功（stub 上游）', updCheck1.ok && updCheck1.data.latest?.version === '9.9.9')
  check(`发现新版本（${ROOT_PKG_VERSION} → 9.9.9）`, updCheck1.data.hasUpdate === true && updCheck1.data.updateKind === 'version')
  check('提交对比生效（落后 2 个提交）', updCheck1.data.behindBy === 2 && updCheck1.data.recentCommits.length === 2 && updCheck1.data.recentCommits[0].sha === 'a222222')

  const updCheck2 = await api('POST', '/api/update/check', { token: admin })
  check('手动检查 60 秒冷却（429）', updCheck2.status === 429)

  const updEvents = await api('GET', '/api/platform/info', { token: admin })
  check('已广播 platform.update.available 事件', updEvents.data.events.some((e) => e.name === 'platform.update.available'))
  const updAudit = await api('GET', '/api/audit/logs?q=platform.update.available&limit=10', { token: admin })
  check('audit 联动留痕（platform.update.available）', (updAudit.data?.items ?? []).some((l) => l.action === 'platform.update.available'))

  const hrForUpdate = await api('POST', '/api/auth/login', { body: { username: 'hr', password: 'Ybk@2026' } })
  const hrToken2 = hrForUpdate.data?.token
  const updApplyDenied = await api('POST', '/api/update/apply', { token: hrToken2, body: { reason: '越权尝试' } })
  check('无权限用户执行升级被拒（403）', updApplyDenied.status === 403)

  const updDry = await api('POST', '/api/update/apply', { token: admin, body: { dryRun: true } })
  check('dry-run 预演返回步骤且不执行任何变更', updDry.ok && updDry.data.dryRun === true && Array.isArray(updDry.data.steps) && updDry.data.steps.length === 3)
  check('dry-run 附带待拉取提交清单', Array.isArray(updDry.data.incomingCommits) && updDry.data.incomingCommits.length === 2)

  const updApplyNoReason = await api('POST', '/api/update/apply', { token: admin, body: {} })
  check('正式升级缺少原因被拒（400）', updApplyNoReason.status === 400)
  // OPT-P2-03：pin 强制 + 回滚面（均在触碰 git 前即拒绝，测试零副作用、零外网依赖）
  const updNoPin = await api('POST', '/api/update/apply', { token: admin, body: { reason: '未带 pin 的裸拉尝试' } })
  const updNoPinMsg = String(updNoPin.error?.message ?? JSON.stringify(updNoPin.error ?? updNoPin.data ?? {}))
  check('P2-03 正式升级缺 pin 被拒（禁止裸拉最新）', updNoPin.status === 400 && /pin/i.test(updNoPinMsg), updNoPinMsg.slice(0, 160))
  const updRollbackNoSnap = await api('POST', '/api/update/rollback', { token: admin, body: { reason: '无快照回滚演练' } })
  const updRollbackMsg = String(updRollbackNoSnap.error?.message ?? JSON.stringify(updRollbackNoSnap.error ?? updRollbackNoSnap.data ?? {}))
  check('P2-03 无可回滚快照被拒（本进程未执行过 apply）', updRollbackNoSnap.status === 400 && /快照/.test(updRollbackMsg), updRollbackMsg.slice(0, 160))
  const updDryPin = await api('POST', '/api/update/apply', { token: admin, body: { dryRun: true } })
  check('P2-03 dryRun 透出 pin/签名策略口径', updDryPin.ok && updDryPin.data.requireSignedCommits === false && String(updDryPin.data.pin).includes('pin'), JSON.stringify(updDryPin.data ?? {}).slice(0, 220))

  // 组5 E-05：dryRun 不外呼不落 .git——refs 快照 + FETCH_HEAD 前后一致（pin 解析只走本地既有 refs）
  {
    const gitDir = join(process.cwd(), '.git')
    const refsSnapshot = () => {
      const snap = {}
      const walkRefs = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walkRefs(full)
          else {
            const stat = statSync(full)
            snap[join(full)] = `${stat.mtimeMs}:${stat.size}`
          }
        }
      }
      walkRefs(join(gitDir, 'refs'))
      for (const name of ['packed-refs', 'FETCH_HEAD']) {
        const full = join(gitDir, name)
        snap[name] = existsSync(full) ? `${statSync(full).mtimeMs}:${statSync(full).size}` : 'absent'
      }
      return JSON.stringify(snap)
    }
    const refsBefore = refsSnapshot()
    const updDryPinLocal = await api('POST', '/api/update/apply', { token: admin, body: { dryRun: true, pin: 'HEAD', reason: 'selftest：dryRun 零外呼验证' } })
    check('E-05：dryRun+pin（HEAD）可解析目标（targetResolved 40 位 commit，不依赖外呼）',
      updDryPinLocal.ok && /^[0-9a-f]{40}$/.test(String(updDryPinLocal.data?.targetResolved ?? '')), JSON.stringify(updDryPinLocal.data ?? updDryPinLocal.error).slice(0, 220))
    check('E-05：dryRun 前后 refs/FETCH_HEAD 快照一致（git fetch 只在正式执行路径发生）',
      refsSnapshot() === refsBefore, 'refs 快照发生变化——dryRun 触碰了 .git（E-05 回归）')
  }
  // QA E-01 断言欠账（结构断言，不可行真实执行：apply 正式路径会改写本仓 git 状态）：回滚快照写入点
  // 必须在位且先于 npm install 落库（merge 成功即锚定，依赖同步失败也保留回退锚点）；rollback 读取点在位。
  {
    const updateSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-update', 'src', 'index.ts'), 'utf8')
    const mergeIdx = updateSrc.indexOf("runGit(info.rootDir, ['merge', '--ff-only'")
    const snapIdx = updateSrc.indexOf('lastApplySnapshot: rollbackTo')
    const npmIdx = updateSrc.indexOf("runNpm(info.rootDir, ['install'", snapIdx)
    check('E-01：回滚快照写入点在位且序正确（merge 成功后、npm install 前写 lastApplySnapshot）',
      mergeIdx > 0 && snapIdx > mergeIdx && npmIdx > snapIdx, `merge=${mergeIdx} snapshot=${snapIdx} npm=${npmIdx}`)
    check('E-01：rollback 读取点在位（state?.lastApplySnapshot 缺失即拒绝，非死路）',
      updateSrc.includes('state?.lastApplySnapshot') && updateSrc.includes('无可回滚快照'))
    // 负向面既有断言兜底：本进程未 apply 过 → POST /api/update/rollback 400「无可回滚快照」（:3039 区段）
  }

  const updDismiss = await api('POST', '/api/update/settings', { token: admin, body: { dismissedVersion: '9.9.9' } })
  check('忽略指定版本（横幅静默）', updDismiss.ok && updDismiss.data.dismissed === true)
  const updRestore = await api('POST', '/api/update/settings', { token: admin, body: { dismissedVersion: null } })
  check('恢复更新提醒', updRestore.ok && updRestore.data.dismissed === false)
  const updAutoOn = await api('POST', '/api/update/settings', { token: admin, body: { autoCheck: true, intervalHours: 24 } })
  check('开启自动检查（每 24h）', updAutoOn.ok && updAutoOn.data.autoCheck === true && updAutoOn.data.intervalHours === 24)

  const updTool = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'update_status', args: {} } })
  check('Agent 工具 update_status 可用', updTool.ok && updTool.data.isError === false && updTool.data.value.currentVersion === ROOT_PKG_VERSION)
  const updToolApply = await api('POST', '/api/tools/execute', { token: hrToken2, body: { name: 'update_apply', args: { reason: '越权尝试' } } })
  check('工具级权限拦截 update_apply（403）', updToolApply.status === 403)

  // T5（M2）：发布清单签名验签——CLI 工具 e2e + 平台侧 verifyReleaseManifest 进程内最小装配 + settings 防呆
  section('T5 发布清单验签（供应链校验：Ed25519 复用平台签名基建）')
  {
    const t5Keys = platformCore.generateEd25519KeyPair()
    const badKeyReg = await api('POST', '/api/update/settings', { token: admin, body: { releasePublicKey: 'not-a-valid-key' } })
    check('T5 公钥登记格式校验（非法内容登记即拒 400，不拖到升级时才炸）', badKeyReg.status === 400, JSON.stringify(badKeyReg.error))
    const forceNoKey = await api('POST', '/api/update/settings', { token: admin, body: { requireSignedManifests: true } })
    check('T5 未登记公钥开启强制验签被拒（防呆：开启即拒绝一切升级）', forceNoKey.status === 400, JSON.stringify(forceNoKey.error))
    const keyReg = await api('POST', '/api/update/settings', { token: admin, body: { releasePublicKey: t5Keys.publicKeyBase64 } })
    check('T5 公钥登记成功（status.releaseKeyConfigured=true）', keyReg.ok && keyReg.data.releaseKeyConfigured === true, JSON.stringify(keyReg.error ?? keyReg.data))
    const forceOn = await api('POST', '/api/update/settings', { token: admin, body: { requireSignedManifests: true } })
    check('T5 公钥在场后可开启强制验签（再关闭回落告警放行口径）', forceOn.ok && forceOn.data.requireSignedManifests === true, JSON.stringify(forceOn.error))
    const forceOff = await api('POST', '/api/update/settings', { token: admin, body: { requireSignedManifests: false } })
    check('T5 强制验签可关闭（默认告警放行，显式增强非静默降级）', forceOff.ok && forceOff.data.requireSignedManifests === false)

    // 进程内最小装配（startHttp=false + 独立 dataDir）：直连 verifyReleaseManifest 验证判定路径。
    // 每个 UpdateService 独立 Context（cordis 同一 ctx 二次 provide 同名服务即抛错）
    let t5Seq = 0
    const mkT5Service = async (options = {}, publicKey) => {
      const c = new Context()
      await c.plugin(platformCore, { dataDir: join(DATA_DIR, `t5-verify-${++t5Seq}`), startHttp: false })
      update.ensureUpdateState(c, { autoCheck: false, intervalHours: 0 })
      if (publicKey !== undefined) update.updateStateCollection(c).update('singleton', { releasePublicKey: publicKey })
      return new update.UpdateService(c, { autoCheck: false, ...options })
    }
    const unset = await (await mkT5Service()).verifyReleaseManifest('a'.repeat(40))
    check('T5 未登记公钥：checked=false 显式报未启用（不算失败，不静默）', unset.checked === false && /未登记/.test(unset.note), JSON.stringify(unset))
    // 本地 stub rawBase：返回正确签名清单；另以篡改 commit / 伪造公钥覆盖失败路径
    const goodCommit = 'b'.repeat(40)
    const mkStub = (payload) => createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)) })
    const signed = (commit, pem) => platformCore.signEd25519(pem, commit)
    const stubGood = mkStub({ algorithm: 'ed25519', version: '9.9.9', commit: goodCommit, signedAt: new Date().toISOString(), signature: signed(goodCommit, t5Keys.privateKeyPem) })
    await new Promise((resolve) => stubGood.listen(0, '127.0.0.1', resolve))
    const goodBase = `http://127.0.0.1:${stubGood.address().port}`
    const svcGood = await mkT5Service({ rawBase: goodBase, apiBase: goodBase }, t5Keys.publicKeyBase64)
    const good = await svcGood.verifyReleaseManifest(goodCommit)
    check('T5 正确签名清单验签通过（verified=true）', good.checked === true && good.verified === true, JSON.stringify(good))
    const wrongTarget = await svcGood.verifyReleaseManifest('c'.repeat(40))
    check('T5 清单 commit 与升级目标不一致判失败（verified=false）', wrongTarget.checked === true && wrongTarget.verified === false && /不一致/.test(wrongTarget.note), JSON.stringify(wrongTarget))
    const t5ForgedKeys = platformCore.generateEd25519KeyPair()
    const svcForged = await mkT5Service({ rawBase: goodBase, apiBase: goodBase }, t5ForgedKeys.publicKeyBase64)
    const forged = await svcForged.verifyReleaseManifest(goodCommit)
    check('T5 伪造清单验签失败（签名与登记公钥不匹配）', forged.checked === true && forged.verified === false, JSON.stringify(forged))
    stubGood.close()
    // CLI 工具 e2e：生成密钥 → 生成清单 → 校验通过 → 篡改 commit 校验失败
    const { execFileSync } = await import('node:child_process')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const t5tmp = mkdtempSync(join(tmpdir(), 't5cli-'))
    const keyPath = join(t5tmp, 'relkey.pem')
    const genOut = execFileSync(process.execPath, ['scripts/release-manifest.mjs', '--generate-key', '--key-file', keyPath], { cwd: process.cwd(), encoding: 'utf8' })
    const pubFromGen = /MCow[A-Za-z0-9+/=]+/.exec(genOut)?.[0] ?? ''
    const manifestPath = join(t5tmp, 'release-manifest.json')
    const t5Commit = 'd'.repeat(40)
    execFileSync(process.execPath, ['scripts/release-manifest.mjs', '--key-file', keyPath, '--out', manifestPath, '--commit', t5Commit], { cwd: process.cwd(), encoding: 'utf8' })
    const checkOk = execFileSync(process.execPath, ['scripts/release-manifest.mjs', '--check', '--out', manifestPath, '--pubkey', pubFromGen, '--commit', t5Commit], { cwd: process.cwd(), encoding: 'utf8' })
    check('T5 CLI 发布工具 e2e（生成密钥 → 签清单 → 校验通过）', /校验通过/.test(String(checkOk)) && pubFromGen.length > 20, genOut.slice(0, 120))
    let tamperFailed = false
    try {
      execFileSync(process.execPath, ['scripts/release-manifest.mjs', '--check', '--out', manifestPath, '--pubkey', pubFromGen, '--commit', 'e'.repeat(40)], { cwd: process.cwd(), encoding: 'utf8' })
    } catch { tamperFailed = true }
    check('T5 CLI 篡改检测（commit 不一致校验拒绝，exit≠0）', tamperFailed)
  }

  // ================================================================ 远程 dsh 接入（接入码 → 机器凭证 → 工具代理）
  section('远程 dsh 接入（plugin-connect）')
  check('接入管理工具已注册（connect_code_create 等）', toolList.data.tools.some((t) => t.name === 'connect_code_create' && t.permission === 'connect.manage'))

  // 管理端权限边界：无 connect.manage 的角色被拒
  const opsCodes = await api('GET', '/api/connect/codes', { token: ops })
  check('无 connect.manage 权限创建/查看接入码被拒（403）', opsCodes.status === 403)

  // 创建接入码（operator 模板）—— 接入码仅创建响应中出现一次
  const codeCreated = await api('POST', '/api/connect/codes', { token: admin, body: { template: 'operator', ttlMinutes: 10, remark: 'selftest' } })
  check('创建接入码（operator，一次性展示）', codeCreated.ok && codeCreated.data.code.startsWith('enr_') && codeCreated.data.ttlMinutes === 10)
  const codesListed = await api('GET', '/api/connect/codes', { token: admin })
  check('接入码列表只含掩码不含明文', codesListed.ok && !JSON.stringify(codesListed.data).includes(codeCreated.data.code) && codesListed.data.codes.some((c) => c.codeMask && c.status === 'active'))

  // 伪造/错误接入码被拒（401）
  const badEnroll = await api('POST', '/api/connect/enroll', { body: { enrollmentCode: 'enr_forged'.padEnd(40, 'x'), clientName: 'attacker' } })
  check('伪造接入码 enroll 被拒', badEnroll.status === 401)

  // 真实 enroll：换机器凭证
  const enroll = await api('POST', '/api/connect/enroll', { body: { enrollmentCode: codeCreated.data.code, clientName: 'selftest-remote-dsh', meta: { hostname: 'selftest-pc', platform: 'test' } } })
  check('接入码换机器凭证成功', enroll.ok && enroll.data.clientId.startsWith('mc-') && enroll.data.clientSecret.startsWith('cs_') && enroll.data.template === 'operator')

  // 一次性消费：重放被拒
  const enrollReplay = await api('POST', '/api/connect/enroll', { body: { enrollmentCode: codeCreated.data.code, clientName: 'replay' } })
  check('接入码一次性消费（重放被拒）', enrollReplay.status === 401)

  // 机器凭证 → 机器令牌 → REST 读权限
  const ccLogin = await api('POST', '/api/auth/client-credentials', { body: { clientId: enroll.data.clientId, clientSecret: enroll.data.clientSecret } })
  check('机器凭证换取机器令牌', ccLogin.ok && ccLogin.data.token.startsWith('dst1.'))
  const machineToken = ccLogin.data.token
  const machineOverview = await api('GET', '/api/overview', { token: machineToken })
  check('机器令牌可读平台概览（operator 含读权限）', machineOverview.ok)
  const machineOrgCreate = await api('POST', '/api/iam/orgs', { token: machineToken, body: { name: '越权组织' } })
  check('operator 模板无 iam.org.write（越权被拒 403）', machineOrgCreate.status === 403)

  // 机器令牌走工具桥（远程工具代理的同一条宿主路径）
  const machineTool = await api('POST', '/api/tools/execute', { token: machineToken, body: { name: 'agent_list', args: {} } })
  check('机器令牌经工具桥执行 agent_list', machineTool.ok && machineTool.data.isError === false && machineTool.data.value.total >= 5)

  // —— issue #9 回归：executor 模板（远程 dsh/Agent 作为执行方：exec.write 任务认领不再 403）——
  const executorCode = await api('POST', '/api/connect/codes', { token: admin, body: { template: 'executor', ttlMinutes: 10, remark: 'selftest-executor' } })
  check('#9：executor 模板接入码可签发', executorCode.ok && executorCode.data.template === 'executor', JSON.stringify(executorCode.error))
  const executorEnroll = await api('POST', '/api/connect/enroll', { body: { enrollmentCode: executorCode.data.code, clientName: 'selftest-executor-dsh', meta: { hostname: 'selftest-executor-pc', platform: 'test' } } })
  check('#9：executor 模板 enroll 成功（模板回显 executor）',
    executorEnroll.ok && executorEnroll.data.template === 'executor', JSON.stringify(executorEnroll.error ?? {}))
  const executorLogin = await api('POST', '/api/auth/client-credentials', { body: { clientId: executorEnroll.data.clientId, clientSecret: executorEnroll.data.clientSecret } })
  check('#9：executor 机器凭证换牌', executorLogin.ok, JSON.stringify(executorLogin.error))
  const executorToken = executorLogin.data?.token ?? ''
  const executorClaim = await api('POST', '/api/tools/execute', { token: executorToken, body: { name: 'exec_claim', args: { issueId: 'selftest-none' } } })
  check('#9：executor 令牌调 exec_claim 不再 403（权限面放行，业务层「任务不存在」才是预期失败）',
    executorClaim.status !== 403 && !/exec\.write/.test(JSON.stringify(executorClaim.error ?? {}))
      && (executorClaim.data?.isError === true || /任务不存在/.test(JSON.stringify(executorClaim.data ?? ''))),
    JSON.stringify({ status: executorClaim.status, error: executorClaim.error, data: executorClaim.data }))
  const executorClients = await api('GET', '/api/connect/clients', { token: admin })
  const executorClient = executorClients.data.clients.find((c) => c.clientId === executorEnroll.data.clientId)
  check('#9：executor 客户端生效权限含 exec.write/exec.read 且非全量（不含账号凭证管理）',
    executorClient && executorClient.scopes.includes('exec.write') && executorClient.scopes.includes('exec.read') && !executorClient.scopes.includes('*')
      && !executorClient.scopes.includes('iam.user.write') && !executorClient.scopes.includes('iam.credential.write'),
    JSON.stringify(executorClient?.scopes ?? executorClients.error))
  await api('POST', `/api/connect/clients/${executorEnroll.data.clientId}/disable`, { token: admin, body: { reason: 'selftest executor 验证完成' } })
  const operatorClaim = await api('POST', '/api/tools/execute', { token: machineToken, body: { name: 'exec_claim', args: { issueId: 'selftest-none' } } })
  check('#9 对照：operator 模板无 exec.write（exec_claim 仍被 403 权限拒绝，边界不放宽）',
    operatorClaim.status === 403 || /exec\.write/.test(JSON.stringify(operatorClaim.error ?? operatorClaim.data ?? {})),
    JSON.stringify({ status: operatorClaim.status, error: operatorClaim.error }))

  // 客户端心跳主动推送（宿主侧接入资产存活监测）
  const hb = await api('POST', '/api/connect/heartbeat', { token: machineToken, body: { tools: 42, version: 'v22.14.0', uptimeSec: 600 } })
  check('接入客户端心跳上报成功', hb.ok && hb.data.clientId === enroll.data.clientId)
  const hbAdmin = await api('POST', '/api/connect/heartbeat', { token: admin, body: {} })
  check('非接入客户端身份心跳被拒（404）', hbAdmin.status === 404)
  const hbAnon = await api('POST', '/api/connect/heartbeat', { body: {} })
  check('心跳端点强制 Bearer 鉴权（401）', hbAnon.status === 401)

  // 客户端登记与最近使用
  const clientsListed = await api('GET', '/api/connect/clients', { token: admin })
  const enrolled = clientsListed.data.clients.find((c) => c.clientId === enroll.data.clientId)
  check('已接入客户端登记（模板/主机名/最近使用）', clientsListed.ok && enrolled && enrolled.template === 'operator' && enrolled.hostname === 'selftest-pc' && enrolled.lastUsedAt !== '')
  check('宿主侧可见客户端心跳与元信息', enrolled.lastHeartbeatAt !== '' && enrolled.heartbeat?.tools === 42 && enrolled.heartbeat?.uptimeSec === 600)

  // 禁用客户端 → 令牌即时失效（principal disabled 联动）
  const disableClient = await api('POST', `/api/connect/clients/${enroll.data.clientId}/disable`, { token: admin, body: { reason: 'selftest 验证吊销联动' } })
  check('禁用接入客户端（原因必填留痕）', disableClient.ok && disableClient.data.status === 'disabled')
  const ccAfterDisable = await api('POST', '/api/auth/client-credentials', { body: { clientId: enroll.data.clientId, clientSecret: enroll.data.clientSecret } })
  const machineAfterDisable = await api('GET', '/api/overview', { token: machineToken })
  check('禁用后凭证换牌被拒、旧机器令牌即时失效', ccAfterDisable.status === 401 && machineAfterDisable.status === 401)

  // 作废未使用接入码
  const code2 = await api('POST', '/api/connect/codes', { token: admin, body: { template: 'readonly', ttlMinutes: 5 } })
  const revokeCode = await api('DELETE', `/api/connect/codes/${code2.data.id}`, { token: admin })
  const enrollRevoked = await api('POST', '/api/connect/enroll', { body: { enrollmentCode: code2.data.code, clientName: 'late' } })
  check('作废未使用接入码后 enroll 被拒', revokeCode.ok && enrollRevoked.status === 401)

  // 工具级 connect 管理工具（宿主侧 dsh Agent 用自然语言管理接入）
  const toolCodeCreate = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'connect_code_create', args: { template: 'readonly', ttlMinutes: 5 } } })
  check('工具 connect_code_create 签发接入码', toolCodeCreate.ok && toolCodeCreate.data.isError === false && toolCodeCreate.data.value.code.startsWith('enr_'))

  // ================================================================ NAS 资产（FS 文件存储）
  section('NAS 数据权限引擎（纯函数单测 engine.ts，dev-plan-nas-authz §四）')
  {
    const eo = [
      { id: 'eo1', name: '智造平台', parentId: null, leaderUserIds: ['e_p', 'e_p2'] },
      { id: 'eo2', name: '生产部', parentId: 'eo1', leaderUserIds: ['e_d'] },
      { id: 'eo3', name: '总装12线', parentId: 'eo2', leaderUserIds: ['e_t'] },
      { id: 'eo4', name: '质检线', parentId: 'eo2', leaderUserIds: [] },
      { id: 'eo5', name: '品质部', parentId: 'eo1', leaderUserIds: ['e_x', 'e_y'] },
      { id: 'eo6', name: '外贸平台', parentId: null, leaderUserIds: [] },
      { id: 'eo7', name: '外贸一部', parentId: 'eo6', leaderUserIds: [] },
    ]
    const idx = buildOrgIndex(eo)
    const nas1 = { id: 'en1', rootPath: '/', orgRoot: '智造平台' }
    const now = '2026-08-29T00:00:00Z'
    const baseRules = { version: 1, exceptions: [], cGroups: ['eg_c'], externalReadPaths: [{ nasId: 'en1', path: '/外部白名单' }], observeOnly: true, degradeAllToReadonly: false }
    const u = (id, orgId, extra = {}) => ({ id, displayName: id, orgId, ...extra })
    const run = (user, paths, op, opt = {}) => engineCheck(
      { userId: user.id, nasId: opt.nasId ?? 'en1', paths, op, now, ...(opt.override !== undefined ? { override: opt.override } : {}) },
      { orgIndex: idx, user, nas: opt.nas ?? nas1, rules: opt.rules ?? baseRules, cGroupHits: opt.cGroupHits ?? [], ...(opt.ownedPaths ? { ownedPaths: opt.ownedPaths } : {}) },
    )
    const inScope = '/智造平台/生产部/总装12线/a.txt'

    // 角色推导
    check('推导：平台负责人 → P', deriveRole(u('e_p', 'eo1'), idx).role === 'P')
    check('推导：部门负责人 → D', deriveRole(u('e_d', 'eo2'), idx).role === 'D')
    check('推导：班组负责人 → T', deriveRole(u('e_t', 'eo3'), idx).role === 'T')
    check('推导：班组成员 → M', deriveRole(u('e_m', 'eo3'), idx).role === 'M')
    check('多负责人 co-leader：双负责人均得 P 且 reasons 标注',
      deriveRole(u('e_p2', 'eo1'), idx).role === 'P'
      && run(u('e_p2', 'eo1'), [inScope], 'read').reasons.some((r) => r.includes('co-leader')))
    check('挂根组织非负责人 → 全 deny', run(u('e_root', 'eo1'), ['/智造平台/x'], 'read').decision === 'deny'
      && run(u('e_root', 'eo1'), ['/智造平台/x'], 'read').reasons.some((r) => r.includes('root-no-role')))
    check('挂根组织 + 管理员显式 allow 例外 → 例外救援放行（平台服务账号存储区授权），例外路径外/未授权 op 仍 deny',
      (() => {
        const rules = { ...baseRules, observeOnly: false, exceptions: [{ id: 'exc_rescue', effect: 'allow', nasId: 'en1', path: '/智造平台/服务区', ops: ['read', 'write'], userIds: ['e_root'], note: '平台服务账号存储区' }] }
        return run(u('e_root', 'eo1'), ['/智造平台/服务区/pkg.zip'], 'write', { rules }).decision === 'allow'
          && run(u('e_root', 'eo1'), ['/智造平台/服务区/pkg.zip'], 'read', { rules }).decision === 'allow'
          && run(u('e_root', 'eo1'), ['/智造平台/服务区/pkg.zip'], 'delete', { rules }).decision === 'deny'
          && run(u('e_root', 'eo1'), ['/智造平台/其他/pkg.zip'], 'write', { rules }).decision === 'deny'
      })())
    check('未落班组（部门根非负责人）→ 只读', run(u('e_d2', 'eo2'), ['/智造平台/生产部/x'], 'read').decision === 'allow'
      && run(u('e_d2', 'eo2'), ['/智造平台/生产部/x'], 'write').decision === 'deny')
    check('兼任：主归属正常写 + 兼任子树仅只读',
      run(u('e_m2', 'eo4', { primaryOrgId: 'eo3' }), [inScope], 'write').decision === 'allow'
      && run(u('e_m2', 'eo4', { primaryOrgId: 'eo3' }), ['/智造平台/生产部/质检线/a.txt'], 'write').decision === 'deny'
      && run(u('e_m2', 'eo4', { primaryOrgId: 'eo3' }), ['/智造平台/生产部/质检线/a.txt'], 'read').decision === 'allow')
    check('作用域锚对齐：部门负责人主部门挂在下属班组，作用域提升到所领导部门（角色与作用域一致）',
      run(u('e_d', 'eo3'), ['/智造平台/生产部/生产计划.xlsx'], 'write').decision === 'allow'
      && run(u('e_d', 'eo3'), ['/智造平台/生产部/生产计划.xlsx'], 'write').scope.includes('/智造平台/生产部')
      && deriveRole(u('e_d', 'eo3'), idx).role === 'D',
      JSON.stringify(run(u('e_d', 'eo3'), ['/智造平台/生产部/生产计划.xlsx'], 'write').scope))
    check('跨分支领导（一人多角色）：主归属矩阵不抬档，所领导部门子树按该部门角色全权限生效',
      deriveRole(u('e_x', 'eo3'), idx).role === 'M'
      && deriveRole(u('e_x', 'eo3'), idx).leaderOfElsewhere.map((led) => led.orgId).includes('eo5')
      && run(u('e_x', 'eo3'), ['/智造平台/品质部/检验标准.xlsx'], 'write').decision === 'allow'
      && run(u('e_x', 'eo3'), ['/智造平台/品质部/旧标准.xlsx'], 'delete').decision === 'allow'
      && run(u('e_x', 'eo3'), ['/智造平台/品质部/管理.xlsx'], 'admin').decision === 'deny'
      && run(u('e_x', 'eo3'), [inScope], 'modify').decision === 'deny',
      JSON.stringify(run(u('e_x', 'eo3'), ['/智造平台/品质部/检验标准.xlsx'], 'write')))
    check('跨分支领导救回作用域：主部门不在锚点链（原 no-scope 早退）不吞所领导部门权限',
      run(u('e_y', 'eo7'), ['/智造平台/品质部/检验标准.xlsx'], 'write').decision === 'allow'
      && run(u('e_y', 'eo7'), ['/外贸平台/合同.xlsx'], 'read').decision === 'deny',
      JSON.stringify(run(u('e_y', 'eo7'), ['/智造平台/品质部/检验标准.xlsx'], 'write')))
    check('根目录只读列举（B 语义）：作用域内用户列根放行、写根仍拒、越界子路径不变、无作用域用户列根仍拒',
      run(u('e_m', 'eo3'), ['/'], 'read').decision === 'allow'
      && run(u('e_m', 'eo3'), ['/'], 'read').reasons.some((r) => r.includes('root-listing'))
      && run(u('e_m', 'eo3'), ['/'], 'write').decision === 'deny'
      && run(u('e_m', 'eo3'), ['/外部目录/x.txt'], 'read').decision === 'deny'
      && run(u('e_z', 'eo7'), ['/'], 'read').decision === 'deny'
      && run(u('e_y', 'eo7'), ['/'], 'read').decision === 'allow',
      JSON.stringify({ mRootRead: run(u('e_m', 'eo3'), ['/'], 'read').decision, mRootWrite: run(u('e_m', 'eo3'), ['/'], 'write').decision, yRootRead: run(u('e_y', 'eo7'), ['/'], 'read').decision, zRootRead: run(u('e_z', 'eo7'), ['/'], 'read').decision }))
    check('作用域祖先链只读列举（2026-09-17 拍板）：深层子树成员可逐级下钻到自己的目录，兄弟子树/越界仍拒、写祖先仍拒',
      run(u('e_m', 'eo3'), ['/智造平台'], 'read').decision === 'allow'
      && run(u('e_m', 'eo3'), ['/智造平台/生产部'], 'read').reasons.some((r) => r.includes('ancestor-listing'))
      && run(u('e_m', 'eo3'), ['/智造平台/生产部'], 'write').decision === 'deny'
      && run(u('e_m', 'eo3'), ['/智造平台/品质部'], 'read').decision === 'deny'
      && run(u('e_m', 'eo3'), ['/智造平台/生产部/质检线'], 'read').decision === 'deny'
      && run(u('e_m', 'eo3'), ['/智造平台/生产部/总装12线'], 'read').decision === 'allow',
      JSON.stringify({ dept: run(u('e_m', 'eo3'), ['/智造平台/生产部'], 'read').decision, sibling: run(u('e_m', 'eo3'), ['/智造平台/品质部'], 'read').decision }))
    check('负责人悬空检测：质检线在列', findVacantLeaderOrgs(idx, { withUserOrgIds: new Set(['eo3', 'eo4']) }).some((o) => o.id === 'eo4'))

    // 判定序：显式 deny > 显式 allow > 角色矩阵 > 默认 deny
    const rulesEx = {
      ...baseRules,
      exceptions: [
        { id: 'ex_deny', effect: 'deny', nasId: 'en1', path: '/智造平台/生产部/*', ops: ['read'] },
        { id: 'ex_allow', effect: 'allow', nasId: 'en1', path: '/智造平台/生产部/总装12线', ops: ['read'] },
      ],
    }
    const exDeny = run(u('e_m', 'eo3'), ['/智造平台/生产部/总装12线/a.txt'], 'read', { rules: rulesEx })
    check('判定序：显式 deny 压过显式 allow', exDeny.decision === 'deny' && exDeny.ruleId === 'ex_deny')
    const readonlyOps = ['write', 'modify', 'delete', 'share', 'admin']
    check('readonly 语义（未落班组只读态）：写类全拒/读下载放行',
      readonlyOps.every((op) => run(u('e_d2', 'eo2'), ['/智造平台/生产部/x'], op).decision === 'deny')
      && run(u('e_d2', 'eo2'), ['/智造平台/生产部/x'], 'read').decision === 'allow'
      && run(u('e_d2', 'eo2'), ['/智造平台/生产部/x'], 'download').decision === 'allow')
    check('M 矩阵：写文件放行/改结构删除分享管理拒绝',
      run(u('e_m', 'eo3'), [inScope], 'write').decision === 'allow'
      && ['modify', 'delete', 'share', 'admin'].every((op) => run(u('e_m', 'eo3'), [inScope], op).decision === 'deny'))
    check('文件所有权（2026-09-17 新增）：上传者对自有文档全权（M 可删/改自己的文件），admin 不随所有权，精确路径外不命中',
      run(u('e_m', 'eo3'), [inScope], 'delete', { ownedPaths: [inScope] }).decision === 'allow'
      && run(u('e_m', 'eo3'), [inScope], 'delete', { ownedPaths: [inScope] }).reasons.some((r) => r.includes('owner.allow'))
      && run(u('e_m', 'eo3'), [inScope], 'modify', { ownedPaths: [inScope] }).decision === 'allow'
      && run(u('e_m', 'eo3'), [inScope], 'share', { ownedPaths: [inScope] }).decision === 'allow'
      && run(u('e_m', 'eo3'), [inScope], 'admin', { ownedPaths: [inScope] }).decision === 'deny'
      && run(u('e_m', 'eo3'), [inScope], 'delete', { ownedPaths: ['/智造平台/生产部/质检线/别人的.txt'] }).decision === 'deny'
      && run(u('e_m', 'eo3'), [inScope + '/子路径.txt'], 'delete', { ownedPaths: [inScope] }).decision === 'deny')
    check('文件所有权：显式 deny 仍压过所有权（判定序②不变）',
      (() => {
        const rules = { ...baseRules, observeOnly: false, exceptions: [{ id: 'ex_owner_deny', effect: 'deny', nasId: 'en1', path: '/智造平台/生产部/总装12线/*', ops: ['delete'], note: '治理封禁' }] }
        return run(u('e_m', 'eo3'), [inScope], 'delete', { rules, ownedPaths: [inScope] }).decision === 'deny'
          && run(u('e_m', 'eo3'), [inScope], 'delete', { rules, ownedPaths: [inScope] }).ruleId === 'ex_owner_deny'
      })())
    check('文件所有权：全量降级只读（G3）仍会压过所有权写类放行',
      run(u('e_m', 'eo3'), [inScope], 'delete', { rules: { ...baseRules, observeOnly: false, degradeAllToReadonly: true }, ownedPaths: [inScope] }).decision === 'deny')
    check('矩阵一致性：内置矩阵 M 行与判定一致',
      Object.entries(MATRIX_DEFAULT.M).every(([op, allow]) => (run(u('e_m', 'eo3'), [inScope], op).decision === 'allow') === allow))

    // 例外过期 / C 叠加
    const rulesExp = {
      ...baseRules,
      exceptions: [{ id: 'ex_tmp', effect: 'allow', nasId: 'en1', path: '/智造平台/生产部/质检线/外部/*', ops: ['read'], expiresAt: '2026-08-01T00:00:00Z' }],
    }
    check('例外 expiresAt 过期即失效（回落矩阵后越界 deny）',
      run(u('e_m', 'eo3'), ['/智造平台/生产部/质检线/外部/a'], 'read', { rules: rulesExp }).decision === 'deny')
    const rulesExp2 = { ...rulesExp, exceptions: [{ ...rulesExp.exceptions[0], expiresAt: '2026-09-01T00:00:00Z' }] }
    check('例外未过期即生效',
      run(u('e_m', 'eo3'), ['/智造平台/生产部/质检线/外部/a'], 'read', { rules: rulesExp2 }).decision === 'allow')
    check('C 叠加：跨域只读放行、写拒绝',
      run(u('e_m', 'eo3'), ['/智造平台/生产部/质检线/外部/b'], 'read', { cGroupHits: ['eg_c'] }).decision === 'allow'
      && run(u('e_m', 'eo3'), ['/智造平台/生产部/质检线/外部/b'], 'write', { cGroupHits: ['eg_c'] }).decision === 'deny')
    const rulesCWrite = { ...baseRules, exceptions: [{ id: 'ex_cw', effect: 'allow', nasId: 'en1', path: '/智造平台/生产部/质检线/外部/b', ops: ['write'] }] }
    check('C 白名单目录写需显式 allow',
      run(u('e_m', 'eo3'), ['/智造平台/生产部/质检线/外部/b'], 'write', { rules: rulesCWrite, cGroupHits: ['eg_c'] }).decision === 'allow')

    // 边界 / 多 NAS / 映射表优先
    check('边界：路径超出组织子树 deny', run(u('e_m', 'eo3'), ['/智造平台/其他/x'], 'read').decision === 'deny')
    check('多 NAS：B 平台 NAS 对 A 平台成员 deny（orgRoot 不在链上）',
      run(u('e_m', 'eo3'), ['/x'], 'read', { nasId: 'en2', nas: { id: 'en2', rootPath: '/', orgRoot: '市场部' } }).decision === 'deny')
    const overriddenNas = { id: 'en1', rootPath: '/', orgRoot: '智造平台', orgPathOverrides: { eo3: '/总装A' } }
    check('orgPathOverrides 优先于名字推导',
      run(u('e_m', 'eo3'), ['/总装A/x'], 'read', { nas: overriddenNas }).decision === 'allow'
      && run(u('e_m', 'eo3'), ['/智造平台/生产部/总装12线/x'], 'read', { nas: overriddenNas }).decision === 'deny')
    const renamedIdx = buildOrgIndex(eo.map((o) => (o.id === 'eo3' ? { ...o, name: '总装十二线' } : o)))
    const renamedRun = engineCheck(
      { userId: 'e_m', nasId: 'en1', paths: ['/总装A/x'], op: 'read', now },
      { orgIndex: renamedIdx, user: u('e_m', 'eo3'), nas: overriddenNas, rules: baseRules, cGroupHits: [] },
    )
    check('组织改名作用域不漂移（映射表按 orgId 命中）', renamedRun.decision === 'allow' && renamedRun.scope[0] === '/总装A')
    check('override 破窗放行（并留痕标记）',
      run(u('e_m', 'eo3'), ['/任意/x'], 'delete', { override: true }).decision === 'allow'
      && run(u('e_m', 'eo3'), ['/任意/x'], 'delete', { override: true }).override === true)
    const degradeRules = { ...baseRules, degradeAllToReadonly: true }
    check('degradeAllToReadonly：allow 视作 readonly',
      run(u('e_d', 'eo2'), ['/智造平台/生产部/x'], 'write', { rules: degradeRules }).decision === 'deny')
    check('observeOnly 标注透传', run(u('e_m', 'eo3'), [inScope], 'read').observeOnly === true)
    check('审批人路由：沿链向上最近负责人（班组自身有负责人即命中；悬空则跳到上级）',
      nearestLeaderOrg(idx, 'eo3')?.orgId === 'eo3' && nearestLeaderOrg(idx, 'eo4')?.orgId === 'eo2'
      && nearestLeaderOrg(idx, 'eo1')?.orgId === 'eo1')

    check('外部账号白名单只读',
      run(u('e_ext', 'eo3', { accountType: 'external' }), ['/外部白名单/a'], 'read').decision === 'allow'
      && run(u('e_ext', 'eo3', { accountType: 'external' }), ['/外部白名单/a'], 'write').decision === 'deny'
      && run(u('e_ext', 'eo3', { accountType: 'external' }), ['/其他/a'], 'read').decision === 'deny')
    check('可疑标记账号 deny 转人工', run(u('e_bad', 'eo3', { accountType: 'suspended-review' }), [inScope], 'read').decision === 'deny')
  }

  section('NAS 资产纳管（plugin-nas + 文件网关 stub）')

  // 网关 stub 自身契约：错误 Bearer 被拒（证明平台调用确实携带网关令牌）
  const gwBadToken = await fetch(`http://127.0.0.1:${NAS_GW_PORT}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  })
  check('网关 stub 校验 Bearer（错误令牌 401）', gwBadToken.status === 401)

  // 用户测试配置（synology-filestation 形态）一键导入 → 创建 + 探活 + 上线 + 工具发现
  const mcpServersConfig = JSON.stringify({
    mcpServers: {
      'synology-filestation': {
        url: `http://127.0.0.1:${NAS_GW_PORT}/mcp`,
        headers: { Authorization: `Bearer ${NAS_GW_TOKEN}`, 'X-NAS-IP': NAS_GW_IP },
      },
    },
  })
  const nasImport = await api('POST', '/api/nas/import', { token: admin, body: { config: mcpServersConfig, name: '自测群晖 NAS' } })
  const nasImportResult = nasImport.data?.results?.[0] ?? {}
  check('mcpServers JSON 一键导入（探活 → 上线 → 工具发现）',
    nasImport.ok && nasImport.data.imported === 1 && nasImportResult.reachable === true && nasImportResult.status === 'online' && nasImportResult.tools === 10,
    JSON.stringify(nasImport.error ?? nasImportResult))
  const nasId = nasImportResult.nasId

  const nasDetail = await api('GET', `/api/nas/${nasId}`, { token: admin })
  check('详情含健康与网关工具面', nasDetail.ok && nasDetail.data.health.status === 'healthy' && nasDetail.data.gatewayTools.length === 10)
  check('访问令牌回显脱敏（原文不落响应）', nasDetail.ok && !JSON.stringify(nasDetail.data).includes(NAS_GW_TOKEN) && String(nasDetail.data.attrs.accessToken).endsWith('…'))

  const nasHealth = await api('POST', `/api/nas/${nasId}/health`, { token: admin })
  check('手动探活（initialize 握手测延迟）', nasHealth.ok && nasHealth.data.status === 'healthy' && nasHealth.data.latencyMs >= 0)

  // 文件全链（全部经网关 tools/call）
  const nasShares = await api('GET', `/api/nas/${nasId}/fs`, { token: admin })
  check('列出共享文件夹（fs_list_shares）', nasShares.ok && JSON.stringify(nasShares.data).includes('skillhub'))
  const nasFiles = await api('GET', `/api/nas/${nasId}/fs?path=/skillhub`, { token: admin })
  check('列目录（fs_list）', nasFiles.ok && JSON.stringify(nasFiles.data).includes('readme.txt'))
  const nasMkdir = await api('POST', `/api/nas/${nasId}/fs/mkdir`, { token: admin, body: { path: '/skillhub/selftest' } })
  check('创建目录（fs_create_folder：folder_path+name 数组一一对应）',
    nasMkdir.ok && nasGwCalls.some((c) => c.name === 'fs_create_folder' && Array.isArray(c.args.folder_path) && c.args.folder_path[0] === '/skillhub' && Array.isArray(c.args.name) && c.args.name[0] === 'selftest'))
  const nasUpload = await api('POST', `/api/nas/${nasId}/fs/upload`, {
    token: admin,
    body: { contentBase64: Buffer.from('PK\x03\x04selftest-file', 'latin1').toString('base64'), destPath: '/skillhub/selftest/a.zip' },
  })
  check('上传文件（平台 staging → 网关 fs_upload 侧读盘）', nasUpload.ok && nasGwUploads.some((u) => u.destPath === '/skillhub/selftest' && u.filename === 'a.zip' && u.magic === 'PK'))
  const adminUserId = adminLogin.data.user?.id
  const ownList = await api('GET', `/api/nas/authz/ownership?nasId=${nasId}&path=${encodeURIComponent('/skillhub/selftest/a.zip')}`, { token: admin })
  // 所有权探针用户：挂三级组织链（depth 3 → M 角色，无特殊账号态），隔离于演示种子组织
  const ownRootOrg = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '所有权测试事业部' } })
  const ownMidOrg = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '所有权测试部门', parentId: ownRootOrg.data.id } })
  const ownLeafOrg = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '所有权测试班组', parentId: ownMidOrg.data.id } })
  const ownUserCreate = await api('POST', '/api/iam/users', { token: admin, body: { username: 'ownertest', displayName: '所有权测试员', orgId: ownLeafOrg.data.id, password: 'Ybk@2026' } })
  const memberUid = ownUserCreate.ok ? ownUserCreate.data.id : register.data.user.id
  const ownProbe = await api('POST', '/api/nas/authz/ownership/record', { token: admin, body: { nasId, userId: memberUid, tool: 'fs_upload', args: { dest_path: '/skillhub/selftest', local_file: '/tmp/stage/成员上传.bin' } } })
  check('文件所有权登记（服务层）：上传成功即登记上传者 + 网关上报可登记成员', ownList.ok && ownList.data.items.length === 1 && ownList.data.items[0].userId === adminUserId && ownList.data.items[0].source === 'upload'
    && ownProbe.ok && !ownProbe.data.ignored,
    JSON.stringify({ list: ownList.error ?? ownList.data, probe: ownProbe.error ?? ownProbe.data }))
  const ownDelCheck = await api('POST', '/api/nas/authz/check', { token: admin, body: { nasId, userId: memberUid, paths: ['/skillhub/selftest/成员上传.bin'], op: 'delete' } })
  check('文件所有权判定（服务层）：上传者删除自有文档放行（owner.allow，优先于作用域/矩阵）',
    ownDelCheck.ok && ownDelCheck.data.decision === 'allow' && ownDelCheck.data.reasons.some((r) => r.includes('owner.allow')),
    JSON.stringify(ownDelCheck.error ?? ownDelCheck.data?.reasons))
  const ownOtherDel = await api('POST', '/api/nas/authz/check', { token: admin, body: { nasId, userId: memberUid, paths: ['/skillhub/selftest/a.zip'], op: 'delete' } })
  check('文件所有权不外溢：非本人上传的文件所有权判定不命中（admin 上传的文件对成员仍按矩阵/作用域）',
    ownOtherDel.ok && ownOtherDel.data.reasons.every((r) => !r.includes('owner.allow')),
    JSON.stringify(ownOtherDel.error ?? ownOtherDel.data?.reasons))
  const nasSearch = await api('POST', `/api/nas/${nasId}/fs/search`, { token: admin, body: { pattern: 'report', path: '/skillhub' } })
  check('检索文件（fs_search：folder_path 字符串）', nasSearch.ok && JSON.stringify(nasSearch.data).includes('report'))
  const nasDelete = await api('POST', `/api/nas/${nasId}/fs/delete`, { token: admin, body: { paths: ['/skillhub/selftest/a.zip'] } })
  check('删除文件（fs_delete：path 数组）', nasDelete.ok && nasGwCalls.some((c) => c.name === 'fs_delete' && Array.isArray(c.args.path) && c.args.path[0] === '/skillhub/selftest/a.zip'))
  const ownListAfterDel = await api('GET', `/api/nas/authz/ownership?nasId=${nasId}&path=${encodeURIComponent('/skillhub/selftest/a.zip')}`, { token: admin })
  check('文件所有权随删除移除（生命周期维护）', ownListAfterDel.ok && ownListAfterDel.data.items.length === 0,
    JSON.stringify(ownListAfterDel.error ?? ownListAfterDel.data))

  // 真实网关契约：fs_list 用 folder_path 字符串
  const nasFilesCheck = nasGwCalls.find((c) => c.name === 'fs_list' && c.args.folder_path === '/skillhub')
  check('列目录（fs_list：folder_path 字符串）', !!nasFilesCheck)

  // 重命名（fs_rename：path + name 数组一一对应）
  const nasRename = await api('POST', `/api/nas/${nasId}/fs/rename`, { token: admin, body: { path: '/skillhub/selftest/a.zip', newName: 'b.zip' } })
  check('重命名（fs_rename：path+name 数组一一对应）',
    nasRename.ok && nasGwCalls.some((c) => c.name === 'fs_rename' && Array.isArray(c.args.path) && c.args.path[0] === '/skillhub/selftest/a.zip' && Array.isArray(c.args.name) && c.args.name[0] === 'b.zip'))

  // 批量上传 upload-many（保留目录结构 + base64 集合 → 多次 fs_upload）
  const manyItems = [
    { relativePath: 'docs/readme.md', contentBase64: Buffer.from('# 批量上传 README', 'utf8').toString('base64') },
    { relativePath: 'src/index.js', contentBase64: Buffer.from("console.log('selftest')", 'utf8').toString('base64') },
    { relativePath: 'src/utils.js', contentBase64: Buffer.from('export const ok = true', 'utf8').toString('base64') },
  ]
  const beforeMany = nasGwUploads.length
  const nasUploadMany = await api('POST', `/api/nas/${nasId}/fs/upload-many`, { token: admin, body: { files: manyItems, destDir: '/skillhub/batch' } })
  check('批量上传（保留目录结构：docs/、src/ 等）',
    nasUploadMany.ok && nasUploadMany.data.uploaded.length === 3 && nasUploadMany.data.failed.length === 0
      && nasGwUploads.slice(beforeMany).map((u) => u.filename).join(',') === 'readme.md,index.js,utils.js'
      && nasGwUploads.slice(beforeMany).map((u) => u.destPath).join(',') === '/skillhub/batch/docs,/skillhub/batch/src,/skillhub/batch/src')

  // 流式下载（GET /api/nas/:id/fs/file）：先 POST /fs/download 触发网关落盘，再 GET 拿到 bytes
  const nasDownloadTrigger = await api('POST', `/api/nas/${nasId}/fs/download`, { token: admin, body: { path: '/skillhub/selftest/a.zip' } })
  check('触发下载落盘（POST /fs/download → 网关 fs_download 真实落盘）',
    nasDownloadTrigger.ok && typeof nasDownloadTrigger.data.localFile === 'string' && nasDownloadTrigger.data.bytes > 0)
  const fileResp = await fetch(`http://127.0.0.1:${PORT}/api/nas/${nasId}/fs/file?path=${encodeURIComponent('/skillhub/selftest/a.zip')}`, {
    headers: { authorization: `Bearer ${admin}` },
  })
  const fileBytes = fileResp.ok ? Buffer.from(await fileResp.arrayBuffer()) : Buffer.alloc(0)
  check('浏览器真实下载（GET /fs/file 200 + bytes 一致 + content-disposition attachment）',
    fileResp.ok && fileBytes.toString('utf8') === 'selftest-download-bytes' && /attachment;\s*filename\*=UTF-8''a\.zip/.test(fileResp.headers.get('content-disposition') ?? ''))
  const inlineResp = await fetch(`http://127.0.0.1:${PORT}/api/nas/${nasId}/fs/file?path=${encodeURIComponent('/skillhub/selftest/a.zip')}&inline=1`, {
    headers: { authorization: `Bearer ${admin}` },
  })
  check('inline=1 预览模式（content-disposition: inline）',
    inlineResp.ok && /inline;\s*filename\*=UTF-8''a\.zip/.test(inlineResp.headers.get('content-disposition') ?? ''))
  const noAuthDownload = await fetch(`http://127.0.0.1:${PORT}/api/nas/${nasId}/fs/file?path=${encodeURIComponent('/skillhub/selftest/a.zip')}`)
  check('stream 下载无 token 且无票据 401', noAuthDownload.status === 401)
  // 一次性下载票据：签发 → 免 Bearer 原生 GET → 二次消费被拒
  const ticketResp = await api('POST', `/api/nas/${nasId}/fs/download-ticket`, { token: admin, body: { path: '/skillhub/selftest/a.zip' } })
  check('签发一次性下载票据', ticketResp.ok && String(ticketResp.data.ticket).startsWith('nastk_'))
  const ticketFile = await fetch(`http://127.0.0.1:${PORT}/api/nas/${nasId}/fs/file?path=${encodeURIComponent('/skillhub/selftest/a.zip')}&ticket=${encodeURIComponent(ticketResp.data.ticket)}`)
  const ticketBytes = ticketFile.ok ? Buffer.from(await ticketFile.arrayBuffer()) : Buffer.alloc(0)
  check('票据直取文件（无 Bearer，字节一致）', ticketFile.ok && ticketBytes.toString('utf8') === 'selftest-download-bytes',
    JSON.stringify({ status: ticketFile.status, type: ticketFile.headers.get('content-type'), len: ticketBytes.length }))
  const ticketReplay = await fetch(`http://127.0.0.1:${PORT}/api/nas/${nasId}/fs/file?path=${encodeURIComponent('/skillhub/selftest/a.zip')}&ticket=${encodeURIComponent(ticketResp.data.ticket)}`)
  check('票据一次性（重放 401）', ticketReplay.status === 401)
  const badTicket = await fetch(`http://127.0.0.1:${PORT}/api/nas/${nasId}/fs/file?path=${encodeURIComponent('/skillhub/selftest/a.zip')}&ticket=nastk_bogus`)
  check('未知票据 401', badTicket.status === 401)
  // 分享链接票据（mode=link，前端「复制下载链接」场景）：TTL 内可重复消费
  const linkTicketResp = await api('POST', `/api/nas/${nasId}/fs/download-ticket`, { token: admin, body: { path: '/skillhub/selftest/a.zip', mode: 'link' } })
  check('签发分享链接票据（mode=link，TTL 600s）', linkTicketResp.ok && linkTicketResp.data.expiresInSec === 600)
  const linkFile1 = await fetch(`http://127.0.0.1:${PORT}/api/nas/${nasId}/fs/file?path=${encodeURIComponent('/skillhub/selftest/a.zip')}&ticket=${encodeURIComponent(linkTicketResp.data.ticket)}`)
  const linkFile2 = await fetch(`http://127.0.0.1:${PORT}/api/nas/${nasId}/fs/file?path=${encodeURIComponent('/skillhub/selftest/a.zip')}&ticket=${encodeURIComponent(linkTicketResp.data.ticket)}`)
  check('链接票据 TTL 内可重复消费', linkFile1.ok && linkFile2.ok)
  const nasAudit = await api('GET', `/api/audit/logs?resourceId=${nasId}&limit=20`, { token: admin })
  check('写类文件操作审计留痕', (nasAudit.data?.items ?? []).some((l) => l.action === 'nas.fs.mkdir') && (nasAudit.data?.items ?? []).some((l) => l.action === 'nas.fs.upload'))

  // 计量管道（观测补齐）：全部文件操作进 usage 事件（nas:<ID>，calls 全量、upload 额外 bytes）
  const nasUsage = await api('GET', '/api/usage/events?resource=' + encodeURIComponent(`nas:${nasId}`), { token: admin })
  const nasBytes = (nasUsage.data?.items ?? []).flatMap((event) => event.meters ?? []).find((meter) => meter.key === 'bytes')
  check('NAS 文件操作进计量管道（calls 全量 + upload bytes）', nasUsage.ok && nasUsage.data.total >= 6 && !!nasBytes && nasBytes.value > 0)

  // RBAC：无角色 403 / developer 只读
  const memberLogin = await api('POST', '/api/auth/login', { body: { username: 'yqz', password: 'Ybk@2026' } })
  const member = memberLogin.data?.token
  const memberNas = await api('GET', '/api/nas', { token: member })
  const noReadPerm = await fetch(`http://127.0.0.1:${PORT}/api/nas/${nasId}/fs/file?path=${encodeURIComponent('/skillhub/selftest/a.zip')}`, { headers: { authorization: `Bearer ${member}` } })
  check('stream 下载无 nas.read 403', noReadPerm.status === 403)
  check('无 nas.read 角色访问被拒（403）', memberNas.status === 403)
  const devNasRead = await api('GET', '/api/nas', { token: dev })
  check('developer 只读放行（nas.read）', devNasRead.ok)
  const devNasWrite = await api('POST', `/api/nas/${nasId}/fs/mkdir`, { token: dev, body: { path: '/skillhub/deny' } })
  check('developer 写操作被拒（缺 nas.write，403）', devNasWrite.status === 403)

  // 二次编辑（PATCH）：属性合并更新；未携带的接入属性保持原值
  const nasPatch = await api('PATCH', `/api/nas/${nasId}`, { token: admin, body: { attrs: { description: '自测：二次编辑后的描述', vendor: 'Synology DS925+' } } })
  check('二次编辑（PATCH 属性合并更新）', nasPatch.ok && nasPatch.data.attrs.description === '自测：二次编辑后的描述' && nasPatch.data.attrs.vendor === 'Synology DS925+', JSON.stringify(nasPatch.error))
  const nasAfterPatch = await api('GET', `/api/nas/${nasId}`, { token: admin })
  check('编辑未携带的接入属性保持原值（网关地址/令牌未丢）', nasAfterPatch.ok && nasAfterPatch.data.attrs.gatewayUrl === `http://127.0.0.1:${NAS_GW_PORT}/mcp`)
  const nasPatchFs = await api('GET', `/api/nas/${nasId}/fs`, { token: admin })
  check('编辑后网关客户端缓存已作废（fs 调用仍通）', nasPatchFs.ok && JSON.stringify(nasPatchFs.data).includes('skillhub'))
  const devNasPatch = await api('PATCH', `/api/nas/${nasId}`, { token: dev, body: { attrs: { description: 'x' } } })
  check('developer 编辑被拒（缺 nas.write，403）', devNasPatch.status === 403)

  // 删除（DELETE）：草稿（从未上线，无法走到归档）可直接删；在线/已下线需先归档
  const nas2 = await api('POST', '/api/nas', { token: admin, body: { name: '自测待删 NAS', attrs: { description: '删除生命周期自测', gatewayUrl: `http://127.0.0.1:${NAS_GW_PORT}/mcp`, accessToken: NAS_GW_TOKEN, nasIp: NAS_GW_IP } } })
  check('登记第二台 NAS（草稿）', nas2.ok && nas2.data.status === 'draft', JSON.stringify(nas2.error))
  const nas2Id = nas2.data?.id
  const devNasDelete = await api('DELETE', `/api/nas/${nas2Id}`, { token: dev })
  check('developer 删除被拒（缺 nas.write，403）', devNasDelete.status === 403)
  const delDraft = await api('DELETE', `/api/nas/${nas2Id}`, { token: admin })
  check('草稿资产可直接删除', delDraft.ok && delDraft.data.deleted === true, JSON.stringify(delDraft.error))
  const nas2Gone = await api('GET', `/api/nas/${nas2Id}`, { token: admin })
  check('删除后详情不再可查', nas2Gone.status === 400 && !nas2Gone.ok)

  const nas3 = await api('POST', '/api/nas', { token: admin, body: { name: '自测归档删除 NAS', attrs: { description: '归档删除链路自测', gatewayUrl: `http://127.0.0.1:${NAS_GW_PORT}/mcp`, accessToken: NAS_GW_TOKEN, nasIp: NAS_GW_IP } } })
  const nas3Id = nas3.data?.id
  await api('POST', `/api/nas/${nas3Id}/transition`, { token: admin, body: { action: 'online' } })
  const delOnline = await api('DELETE', `/api/nas/${nas3Id}`, { token: admin })
  check('在线资产删除被拒（需先下线/归档）', delOnline.status === 400 && !delOnline.ok)
  await api('POST', `/api/nas/${nas3Id}/transition`, { token: admin, body: { action: 'offline', note: '自测删除链路' } })
  const delOffline = await api('DELETE', `/api/nas/${nas3Id}`, { token: admin })
  check('已下线资产删除仍被拒（需先归档）', delOffline.status === 400 && !delOffline.ok)
  const nas3Archive = await api('POST', `/api/nas/${nas3Id}/transition`, { token: admin, body: { action: 'archive' } })
  check('归档为终态', nas3Archive.ok && nas3Archive.data.status === 'archived', JSON.stringify(nas3Archive.error))
  const nas3Delete = await api('DELETE', `/api/nas/${nas3Id}`, { token: admin })
  check('归档后删除成功（含健康/工具缓存清理）', nas3Delete.ok && nas3Delete.data.deleted === true, JSON.stringify(nas3Delete.error))

  // ================================================================ NAS 数据权限 API
  section('NAS 数据权限 API（check/scope/rules/例外/审批闭环，dev-plan-nas-authz §2.3-§2.7）')
  // 夹具：NAS 配 orgRoot + 组织负责人（P=admin / D=ops / T=heqw / M=linxm）
  const nasRootPatch = await api('PATCH', `/api/nas/${nasId}`, { token: admin, body: { attrs: { orgRoot: '元冰可集团' } } })
  check('NAS 配置接入组织锚点（orgRoot=元冰可集团）', nasRootPatch.ok)

  const orgAll = (await api('GET', '/api/iam/orgs', { token: admin })).data ?? []
  const orgByName = (name) => orgAll.find((org) => org.name === name)?.id
  const orgRootId = orgByName('元冰可集团')
  const orgTechId = orgByName('技术中心')
  const orgAiId = orgByName('AI 平台部')
  const orgProdId = orgByName('产品运营部')
  const orgFeId = orgByName('前端部')
  check('组织夹具就绪（根/技术中心/AI 平台部/产品运营部/前端部）', Boolean(orgRootId && orgTechId && orgAiId && orgProdId && orgFeId))

  const userAll = (await api('GET', '/api/iam/users', { token: admin })).data?.users ?? []
  const userByName = (username) => userAll.find((user) => user.username === username)?.id
  const adminUid = userByName('admin')
  const opsUid = userByName('ops')
  const heqwUid = userByName('heqw')
  const linxmUid = userByName('linxm')
  const devUid = userByName('dev')
  const yqzUid = userByName('yqz')
  const auditUid = userByName('audit')
  const suyqUid = userByName('suyq')
  check('用户夹具就绪', Boolean(adminUid && opsUid && heqwUid && linxmUid && yqzUid && auditUid && suyqUid))

  await api('PATCH', `/api/iam/orgs/${orgRootId}`, { token: admin, body: { leaderUserIds: [adminUid] } })
  await api('PATCH', `/api/iam/orgs/${orgTechId}`, { token: admin, body: { leaderUserIds: [opsUid] } })
  await api('PATCH', `/api/iam/orgs/${orgFeId}`, { token: admin, body: { leaderUserIds: [heqwUid] } })

  const authzCheck = (userId, paths, op, extra = {}) => api('POST', '/api/nas/authz/check', {
    token: admin,
    body: { nasId: extra.nasId ?? nasId, userId, paths, op, ...(extra.override !== undefined ? { override: extra.override } : {}), ...(extra.headerUser ? {} : {}) },
    ...(extra.headerUser ? {} : {}),
  })

  // —— 35 格矩阵（4 主角色 × 7 操作；C 叠加另测）——
  const roleScope = {
    P: { uid: adminUid, path: '/元冰可集团/技术中心/AI 平台部/季度报告.docx' },
    D: { uid: opsUid, path: '/元冰可集团/技术中心/AI 平台部/季度报告.docx' },
    T: { uid: heqwUid, path: '/元冰可集团/技术中心/前端部/页面原型.png' },
    M: { uid: devUid, path: '/元冰可集团/技术中心/AI 平台部/季度报告.docx' },
  }
  const EXPECTED = {
    P: { read: 1, download: 1, write: 1, modify: 1, delete: 1, share: 1, admin: 1 },
    D: { read: 1, download: 1, write: 1, modify: 1, delete: 1, share: 1, admin: 0 },
    T: { read: 1, download: 1, write: 1, modify: 1, delete: 0, share: 0, admin: 0 },
    M: { read: 1, download: 1, write: 1, modify: 0, delete: 0, share: 0, admin: 0 },
  }
  let matrixOk = true
  let matrixDetail = ''
  for (const [role, cfg] of Object.entries(roleScope)) {
    for (const op of ['read', 'download', 'write', 'modify', 'delete', 'share', 'admin']) {
      const resp = await authzCheck(cfg.uid, [cfg.path], op)
      const got = resp.data?.decision === 'allow' ? 1 : 0
      if (!resp.ok || got !== EXPECTED[role][op] || !Array.isArray(resp.data?.reasons) || resp.data.reasons.length === 0 || resp.data?.role !== role) {
        matrixOk = false
        matrixDetail = `${role}×${op} 期望 ${EXPECTED[role][op]} 实得 ${got}（${JSON.stringify(resp.data?.reasons ?? resp.error)}）`
      }
    }
  }
  check('附件矩阵 35 格（P/D/T/M × 7 操作）判定一致且每格含 reasons', matrixOk, matrixDetail)

  // scope 与 check 一致
  const scopeM = await api('GET', `/api/nas/authz/scope?nasId=${nasId}&userId=${devUid}`, { token: admin })
  const checkM = await authzCheck(devUid, ['/元冰可集团/技术中心/AI 平台部/a.txt'], 'read')
  check('scope 返回角色/作用域并与 check 一致',
    scopeM.ok && scopeM.data.role === 'M' && JSON.stringify(scopeM.data.scope) === JSON.stringify(checkM.data.scope)
    && scopeM.data.matrix?.M?.read === true,
    JSON.stringify({ scope: scopeM.data?.scope, role: scopeM.data?.role, checkScope: checkM.data?.scope }))

  // 钉钉 userId 反查等价（linxm ↔ dd_u002，identityLinks 事实源）
  const byPlatform = await authzCheck(linxmUid, ['/元冰可集团/技术中心/AI 平台部/a.txt'], 'read')
  const byDingtalk = await authzCheck('dd_u002', ['/元冰可集团/技术中心/AI 平台部/a.txt'], 'read')
  check('钉钉 userId 反查与平台 userId 等价（identityLinks）',
    byDingtalk.ok && byPlatform.ok
    && byDingtalk.data.decision === byPlatform.data.decision && byDingtalk.data.role === byPlatform.data.role
    && JSON.stringify(byDingtalk.data.scope) === JSON.stringify(byPlatform.data.scope)
    && byDingtalk.data.userName === '林小满',
    JSON.stringify({ byPlatform: byPlatform.data, byDingtalk: byDingtalk.data }))

  // userid 口径反查（hermes X-On-Behalf-User 与 dept_manager_userid_list 的口径）：unionId+userid 双链并存
  const byStaffId = await authzCheck('staff_002', ['/元冰可集团/技术中心/AI 平台部/a.txt'], 'read')
  check('钉钉 userid 口径反查与平台 userId 等价（双身份链：unionId 供登录、userid 供运营反查）',
    byStaffId.ok && byStaffId.data.userName === '林小满'
    && JSON.stringify(byStaffId.data.scope) === JSON.stringify(byPlatform.data.scope),
    JSON.stringify(byStaffId.data))

  // —— 签名分享链接（2026-09-21「NAS 下载链接签名化」：docs-20260921 设计清单断言面）——
  // 档位/策略/永久显式（决策②③）+ 独立长期密钥（决策①）+ 取流三关（签名→吊销→权限复核）。
  // 旧链路（mode=once 一次性 / mode=link 600s）断言在上方文件全链段，行为不变即不回归。
  const slPath = '/元冰可集团/技术中心/AI 平台部/分享目标.bin' // mock 网关对任意路径落盘固定字节
  const slReq = (link) => fetch(link.startsWith('http') ? link : `http://127.0.0.1:${PORT}${link}`)

  const slDefault = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: admin, body: { path: slPath } })
  check('share-link 默认档 24 小时（决策②：不传 ttlSec/permanent → 86400 且绝不产生永久链接）',
    slDefault.ok && slDefault.data.expiresInSec === 86400 && slDefault.data.permanent === false && !!slDefault.data.expiresAt,
    JSON.stringify(slDefault.error ?? slDefault.data))

  const sl1h = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: admin, body: { path: slPath, ttlSec: 3600 } })
  const sl7d = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: admin, body: { path: slPath, ttlSec: 604800 } })
  const sl30d = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: admin, body: { path: slPath, ttlSec: 2592000 } })
  check('显式档位 1h/7d/30d 签发', sl1h.ok && sl1h.data.expiresInSec === 3600 && sl7d.ok && sl7d.data.expiresInSec === 604800 && sl30d.ok && sl30d.data.expiresInSec === 2592000,
    JSON.stringify({ sl1h: sl1h.error, sl7d: sl7d.error, sl30d: sl30d.error }))

  const slOver = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: admin, body: { path: slPath, ttlSec: 9999999 } })
  check('TTL 超策略上限 400 TTL_EXCEEDS_POLICY（明确拒绝，不回落到上限）', slOver.status === 400 && slOver.error?.code === 'TTL_EXCEEDS_POLICY',
    JSON.stringify(slOver.error))

  const slPermOff = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: admin, body: { path: slPath, permanent: true } })
  check('永久档策略默认关（决策③：allowPermanent=false 时持 nas.authz.write 也 403，策略开关优先于权限点）',
    slPermOff.status === 403 && slPermOff.error?.code === 'PERMANENT_DISABLED_BY_POLICY', JSON.stringify(slPermOff.error))

  const slConflict = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: admin, body: { path: slPath, permanent: true, ttlSec: 3600 } })
  check('permanent 与 ttlSec 互斥（400，语义歧义不猜测）', slConflict.status === 400 && slConflict.error?.code === 'PERMANENT_TTL_CONFLICT',
    JSON.stringify(slConflict.error))

  // 有效取流（免 Bearer）+ 使用计数/清单面（含 keyId 留痕）
  const slUse1 = await slReq(sl1h.data.url)
  const slUse2 = await slReq(sl1h.data.url)
  const slUseBytes = slUse1.ok ? Buffer.from(await slUse1.arrayBuffer()).toString('utf8') : ''
  const slList = await api('GET', `/api/nas/${nasId}/fs/share-links`, { token: admin })
  check('签名链接取流（免 Bearer 直下 bytes）+ 使用计数/清单可见（keyId 留痕）',
    slUse1.ok && slUse2.ok && slUseBytes === 'selftest-download-bytes'
      && (slList.data?.items ?? []).some((item) => item.id === sl1h.data.jti && item.useCount === 2 && !!item.keyId),
    JSON.stringify({ s1: slUse1.status, s2: slUse2.status, list: slList.error ?? slList.data?.items?.length }))

  // 签名关：篡改 path/exp（含过去时刻）/sub/jti 任一字段 → 401
  const tamper = (mutate) => {
    const u = new URL(sl1h.data.url)
    mutate(u.searchParams)
    return u.toString()
  }
  const tPath = await slReq(tamper((p) => p.set('path', '/元冰可集团/技术中心/前端部/别的.bin')))
  const tExpPast = await slReq(tamper((p) => p.set('exp', '1000000')))
  const tSub = await slReq(tamper((p) => p.set('sub', 'user_forge')))
  const tJti = await slReq(tamper((p) => p.set('jti', 'nsl_forge')))
  check('签名关：篡改 path/exp/sub/jti 任一字段 401', tPath.status === 401 && tExpPast.status === 401 && tSub.status === 401 && tJti.status === 401,
    JSON.stringify({ tPath: tPath.status, tExp: tExpPast.status, tSub: tSub.status, tJti: tJti.status }))

  // 签发员夹具：持 nas.read/nas.write 而无 nas.authz.write（永久越权断言 + 复核身份）
  const slRole = await api('POST', '/api/iam/roles', { token: admin, body: { name: '分享链接签发自测', code: 'sharelink_selftest', description: 'selftest share-link', permissions: ['nas.read', 'nas.write'] } })
  const slUserCreate = await api('POST', '/api/iam/users', { token: admin, body: { username: 'sharelink_issuer', displayName: '链接签发员', orgId: orgAiId, password: 'Ybk@2026', roleIds: slRole.ok ? [slRole.data.id] : [] } })
  const slIssuerLogin = await api('POST', '/api/auth/login', { body: { username: 'sharelink_issuer', password: 'Ybk@2026' } })
  const slIssuer = slIssuerLogin.data?.token
  const slIssuerUid = slUserCreate.data?.id
  check('签发员夹具就绪（nas.write 持有、无 nas.authz.write，挂 元冰可集团 组织链）', slRole.ok && slUserCreate.ok && !!slIssuer, JSON.stringify({ role: slRole.error, user: slUserCreate.error, login: slIssuerLogin.error }))

  // 策略面：开启永久档（决策③第二步前置；put 走 AuthzRules 乐观锁）
  const polOn = await api('PUT', '/api/nas/authz/share-link-policy', { token: admin, body: { allowPermanent: true } })
  check('策略面开启 allowPermanent（PUT share-link-policy）', polOn.ok && polOn.data.allowPermanent === true, JSON.stringify(polOn.error ?? polOn.data))

  const slPermNoAuthz = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: slIssuer, body: { path: slPath, permanent: true } })
  check('永久越权 403 PERMANENT_REQUIRES_AUTHZ_WRITE（策略已开但无 nas.authz.write）',
    slPermNoAuthz.status === 403 && slPermNoAuthz.error?.code === 'PERMANENT_REQUIRES_AUTHZ_WRITE', JSON.stringify(slPermNoAuthz.error))

  const slPerm = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: admin, body: { path: slPath, permanent: true } })
  check('永久链接签发（策略开启后）：exp=0 + expiresAt=null + 档位标注「永久」',
    slPerm.ok && slPerm.data.permanent === true && slPerm.data.expiresAt === null && slPerm.data.url.includes('exp=0') && slPerm.data.ttlLabel === '永久',
    JSON.stringify(slPerm.error ?? slPerm.data))

  // 机器身份签发拒绝（明确错误，不静默降级）
  const slMachRole = await api('POST', '/api/iam/roles', { token: admin, body: { name: '分享链接机器自测', code: 'sharelink_machine_selftest', description: 'selftest', permissions: ['nas.read', 'nas.write'] } })
  const slMachCred = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'sharelink-machine', refType: 'external', roleIds: slMachRole.ok ? [slMachRole.data.id] : [], scopes: [] } })
  const slMachLogin = await api('POST', '/api/auth/client-credentials', { body: { clientId: slMachCred.data?.clientId, clientSecret: slMachCred.data?.clientSecret } })
  const slMachIssue = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: slMachLogin.data?.token, body: { path: slPath, ttlSec: 3600 } })
  check('机器身份签发拒绝（403 MACHINE_ISSUANCE_UNSUPPORTED，收紧而非放宽）',
    slMachIssue.status === 403 && slMachIssue.error?.code === 'MACHINE_ISSUANCE_UNSUPPORTED', JSON.stringify(slMachIssue.error))

  // 决策①：独立长期密钥与令牌密钥隔离——轮换令牌签名密钥后，未过期 share-link 仍可取流
  const rotateAuthn = await api('POST', '/api/authn/rotate-secret', { token: admin })
  const slAfterRotate = await slReq(slDefault.data.url)
  check('独立密钥隔离（决策①）：轮换令牌签名密钥后 share-link 仍可取流',
    rotateAuthn.ok && slAfterRotate.ok, JSON.stringify({ rotate: rotateAuthn.error, stream: slAfterRotate.status }))

  // 长期密钥显式轮换（决策① (a) 永久退役集合）：旧链接凭退役密钥仍可取流，新签发 keyId 更替
  const slPreRotate = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: admin, body: { path: slPath, ttlSec: 3600 } })
  const slRotate = await api('POST', '/api/nas/authz/share-link-secret/rotate', { token: admin, body: { note: 'selftest 轮换' } })
  const slPreStream = await slReq(slPreRotate.data.url)
  const slPostRotate = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: admin, body: { path: slPath, ttlSec: 3600 } })
  const slKeyList = await api('GET', `/api/nas/${nasId}/fs/share-links`, { token: admin })
  const slKeyOf = (jti) => (slKeyList.data?.items ?? []).find((item) => item.id === jti)?.keyId
  check('长期密钥轮换（决策① (a)）：旧链接凭退役密钥仍可取流，新签发 keyId 更替',
    slRotate.ok && slPreStream.ok && slPostRotate.ok && !!slKeyOf(slPreRotate.data.jti) && slKeyOf(slPreRotate.data.jti) !== slKeyOf(slPostRotate.data.jti),
    JSON.stringify({ rotate: slRotate.error, stream: slPreStream.status, keyA: slKeyOf(slPreRotate.data?.jti), keyB: slKeyOf(slPostRotate.data?.jti) }))

  // 吊销即时生效 + 重复吊销幂等
  const slRevokeTarget = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: admin, body: { path: slPath, ttlSec: 3600 } })
  const slRevokePre = await slReq(slRevokeTarget.data.url)
  const slRevoke = await api('POST', `/api/nas/${nasId}/fs/share-links/${slRevokeTarget.data.jti}/revoke`, { token: admin, body: { reason: 'selftest 吊销' } })
  const slRevokePost = await slReq(slRevokeTarget.data.url)
  const slRevokeAgain = await api('POST', `/api/nas/${nasId}/fs/share-links/${slRevokeTarget.data.jti}/revoke`, { token: admin, body: {} })
  check('吊销即时生效（吊销前 200 → 吊销后 401）且重复吊销幂等 200',
    slRevokePre.ok && slRevoke.ok && slRevokePost.status === 401 && slRevokeAgain.ok && slRevokeAgain.data.alreadyRevoked === true,
    JSON.stringify({ pre: slRevokePre.status, post: slRevokePost.status, revoke: slRevoke.error, again: slRevokeAgain.error ?? slRevokeAgain.data }))

  // 批量吊销（按签发者）：「某人离职 → 一次性吊销其全部链接」场景
  const slBatch1 = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: slIssuer, body: { path: slPath, ttlSec: 3600 } })
  const slBatch2 = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: slIssuer, body: { path: slPath, ttlSec: 3600 } })
  const slBatch = await api('POST', `/api/nas/${nasId}/fs/share-links/revoke`, { token: admin, body: { userId: slIssuerUid, reason: 'selftest 离职场景' } })
  const slBatch1Post = await slReq(slBatch1.data.url)
  const slBatch2Post = await slReq(slBatch2.data.url)
  check('批量吊销（按签发者，离职场景）：两条链接一并失效',
    slBatch1.ok && slBatch2.ok && slBatch.ok && slBatch.data.revoked >= 2 && slBatch1Post.status === 401 && slBatch2Post.status === 401,
    JSON.stringify({ revoked: slBatch.data?.revoked, e1: slBatch1Post.status, e2: slBatch2Post.status, err: slBatch.error }))

  // 权限复核关（核心增量）：签发者数据权限回收（显式 deny 例外命中）后，原链接取流 403 且产生判定留痕
  const slRecheck = await api('POST', `/api/nas/${nasId}/fs/share-link`, { token: slIssuer, body: { path: slPath, ttlSec: 3600 } })
  const slRecheckPre = await slReq(slRecheck.data.url)
  const slDenyExc = await api('POST', '/api/nas/authz/exceptions', { token: admin, body: { effect: 'deny', nasId, path: slPath, ops: ['download'], userIds: [slIssuerUid], note: 'selftest 复核关：签发者数据权限回收' } })
  const slRecheckPost = await slReq(slRecheck.data.url)
  const slDecisionTrail = await api('GET', `/api/nas/authz/decisions?userId=${slIssuerUid}&op=download&limit=10`, { token: admin })
  check('权限复核（核心增量）：签发者数据权限回收后原链接 403 且产生 nas.authz.decision 留痕',
    slRecheck.ok && slRecheckPre.ok && slDenyExc.ok && slRecheckPost.status === 403
      && (slDecisionTrail.data?.items ?? []).some((item) => item.decision === 'deny' && item.op === 'download' && item.caller === 'nas.share-link'),
    JSON.stringify({ pre: slRecheckPre.status, post: slRecheckPost.status, exc: slDenyExc.error, trail: slDecisionTrail.error ?? slDecisionTrail.data?.items?.[0] }))
  // 残留说明：deny 例外按 merge-only 语义无法经 API 移除；其作用域锁死在
  // slIssuerUid × slPath × download，与后续任何夹具/断言无交集，留在规则里无害。

  // 收尾：永久链接可吊销 + 策略回关 allowPermanent=false（决策③ A1 起步姿态）
  const slPermRevoke = await api('POST', `/api/nas/${nasId}/fs/share-links/${slPerm.data.jti}/revoke`, { token: admin, body: { reason: 'selftest 收尾：永久档清场' } })
  const slPermPost = await slReq(slPerm.data.url)
  const polOff = await api('PUT', '/api/nas/authz/share-link-policy', { token: admin, body: { allowPermanent: false } })
  check('永久链接可吊销（吊销后 401）+ 策略回关 allowPermanent=false（决策③ A1 起步姿态）',
    slPermRevoke.ok && slPermPost.status === 401 && polOff.ok && polOff.data.allowPermanent === false,
    JSON.stringify({ post: slPermPost.status, revoke: slPermRevoke.error, pol: polOff.error }))

  // 负责人映射走 userid 口径（钉钉 dept_manager_userid_list 是 userid，经 userid 链反查平台 userId）
  const orgsForLeaders = (await api('GET', '/api/iam/orgs', { token: admin })).data
  check('部门负责人随同步映射（managerRemoteIds userid 口径 → identityLinks 反查）',
    orgsForLeaders.some((org) => org.name === 'AI 平台部' && (org.leaderUserIds ?? []).includes(linxmUid)),
    JSON.stringify(orgsForLeaders.filter((org) => org.name === 'AI 平台部').map((org) => ({ leaders: org.leaderUserIds }))))

  // 一人多部门兼任（同步落库）：primaryOrgId=主归属锚，orgId=挂靠；引擎兼任子树只读，双身份权限不冲突
  const zhmlCandidates = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('周明澜'), { token: admin })).data.users
    .filter((user) => user.primaryOrgId && user.orgId && user.primaryOrgId !== user.orgId)
  const zhmlHit = { rec: undefined, secWrite: undefined }
  for (const cand of zhmlCandidates) {
    const primaryWrite = await authzCheck(cand.id, ['/元冰可集团/技术中心/前端部/主归属.txt'], 'write')
    const secRead = await authzCheck(cand.id, ['/元冰可集团/技术中心/后端部/兼任目录.txt'], 'read')
    const secWrite = await authzCheck(cand.id, ['/元冰可集团/技术中心/后端部/兼任目录.txt'], 'write')
    if (primaryWrite.data?.decision === 'allow' && secRead.data?.decision === 'allow' && secWrite.data?.decision === 'deny') {
      Object.assign(zhmlHit, { rec: cand, secWrite })
      break
    }
  }
  check('多部门成员兼任落库（primaryOrgId=主部门，orgId=挂靠部门）', Boolean(zhmlHit.rec),
    JSON.stringify(zhmlCandidates.map((user) => ({ primaryOrgId: user.primaryOrgId, orgId: user.orgId }))))
  check('兼任权限不冲突：主归属可写、兼任子树只读（secondary-readonly）',
    Boolean(zhmlHit.rec) && zhmlHit.secWrite.data.reasons.some((r) => r.includes('secondary-readonly')),
    JSON.stringify(zhmlHit.secWrite.data))

  // 权限点：无角色 403 / 无 nas.authz.read 403
  const authzMemberLogin = await api('POST', '/api/auth/login', { body: { username: 'yqz', password: 'Ybk@2026' } })
  const authzMemberToken = authzMemberLogin.data?.token
  const noPermCheck = await api('POST', '/api/nas/authz/check', { token: authzMemberToken, body: { nasId, userId: yqzUid, paths: ['/x'], op: 'read' } })
  const noPermRules = await api('GET', '/api/nas/authz/rules', { token: authzMemberToken })
  check('无 nas.authz.check 权限 403；无 nas.authz.read 403', noPermCheck.status === 403 && noPermRules.status === 403)

  // 特殊账号：未落班组只读 / 挂根 deny / 外部白名单 / 可疑标记 / 兼任
  const yqzRead = await authzCheck(yqzUid, ['/元冰可集团/产品运营部/计划.xlsx'], 'read')
  const yqzWrite = await authzCheck(yqzUid, ['/元冰可集团/产品运营部/计划.xlsx'], 'write')
  check('未落班组（部门根非负责人）→ 只读', yqzRead.data?.decision === 'allow' && yqzWrite.data?.decision === 'deny')
  const auditCheck = await authzCheck(auditUid, ['/元冰可集团/任何/x'], 'read')
  check('挂根组织非负责人 → deny 全部', auditCheck.data?.decision === 'deny' && auditCheck.data.reasons.some((r) => r.includes('root-no-role')))

  const extUser = await api('POST', '/api/iam/users', { token: admin, body: { username: 'extguest', displayName: '外部顾问', orgId: orgAiId, password: 'Ybk@2026' } })
  const extUid = extUser.data?.id
  await api('PATCH', `/api/iam/users/${extUid}`, { token: admin, body: { accountType: 'external' } })
  const rulesBeforeExt = await api('GET', '/api/nas/authz/rules', { token: admin })
  const extPut = await api('PUT', '/api/nas/authz/rules', {
    token: admin,
    body: { ifVersion: rulesBeforeExt.data.version, externalReadPaths: [{ nasId, path: '/元冰可集团/技术中心/AI 平台部/公共' }] },
  })
  check('外部账号白名单只读（白名单内 read 放行/write 拒绝、白名单外 deny）',
    extPut.ok
    && (await authzCheck(extUid, ['/元冰可集团/技术中心/AI 平台部/公共/手册.pdf'], 'read')).data?.decision === 'allow'
    && (await authzCheck(extUid, ['/元冰可集团/技术中心/AI 平台部/公共/手册.pdf'], 'write')).data?.decision === 'deny'
    && (await authzCheck(extUid, ['/元冰可集团/技术中心/AI 平台部/私密.pdf'], 'read')).data?.decision === 'deny')

  await api('PATCH', `/api/iam/users/${heqwUid}`, { token: admin, body: { accountType: 'suspended-review' } })
  const suspended = await authzCheck(heqwUid, ['/元冰可集团/技术中心/前端部/x'], 'read')
  await api('PATCH', `/api/iam/users/${heqwUid}`, { token: admin, body: { accountType: 'internal' } })
  check('可疑标记账号 deny + 转人工留痕', suspended.data?.decision === 'deny' && suspended.data.reasons.some((r) => r.includes('suspended-review')))

  // 兼任：suyq 主归属 AI 平台部（M），挂靠后端部 → 后端部子树只读
  await api('PATCH', `/api/iam/users/${suyqUid}`, { token: admin, body: { primaryOrgId: orgAiId } })
  const secWrite = await authzCheck(suyqUid, ['/元冰可集团/技术中心/后端部/接口.md'], 'write')
  const secRead = await authzCheck(suyqUid, ['/元冰可集团/技术中心/后端部/接口.md'], 'read')
  const priWrite = await authzCheck(suyqUid, ['/元冰可集团/技术中心/AI 平台部/模型.md'], 'write')
  check('兼任账号：主归属正常写 + 兼任子树仅只读',
    priWrite.data?.decision === 'allow' && secRead.data?.decision === 'allow' && secWrite.data?.decision === 'deny')
  await api('PATCH', `/api/iam/users/${suyqUid}`, { token: admin, body: { primaryOrgId: '' } })

  // —— rules 乐观锁 + 种子导入幂等 ——
  const conflict = await api('PUT', '/api/nas/authz/rules', { token: admin, body: { ifVersion: 999, observeOnly: false } })
  check('rules PUT ifVersion 乐观锁冲突 409', conflict.status === 409 && conflict.error?.code === 'VERSION_CONFLICT')
  const rulesNow1 = await api('GET', '/api/nas/authz/rules', { token: admin })
  const cGroupPut = await api('PUT', '/api/nas/authz/rules', { token: admin, body: { ifVersion: rulesNow1.data.version, cGroups: ['AI 平台部全员'] } })
  check('rules PUT 携正确 ifVersion 成功且 version 递增', cGroupPut.ok && cGroupPut.data.version === rulesNow1.data.version + 1)

  const importOnce = await api('POST', '/api/nas/authz/rules/import', { token: admin, body: NAS_AUTHZ_SEED })
  const importTwice = await api('POST', '/api/nas/authz/rules/import', { token: admin, body: NAS_AUTHZ_SEED })
  check('种子导入：首次变更（cGroups 清空为未解析组）+ 再次导入幂等',
    importOnce.ok && importOnce.data.changed === true && importOnce.data.unresolvedGroups.includes('跨域协作者')
    && importTwice.ok && importTwice.data.changed === false && importTwice.data.version === importOnce.data.version,
    JSON.stringify({ once: importOnce.data, twice: importTwice.data, err: importOnce.error }))

  // 恢复 C 组并断言组标记回写
  const rulesNow2 = await api('GET', '/api/nas/authz/rules', { token: admin })
  await api('PUT', '/api/nas/authz/rules', { token: admin, body: { ifVersion: rulesNow2.data.version, cGroups: ['AI 平台部全员'] } })
  const aiGroups = (await api('GET', '/api/iam/groups', { token: admin })).data?.groups ?? []
  const aiGroupMarked = aiGroups.find((group) => group.name === 'AI 平台部全员')
  check('C 关联动态组标记回写（authzRoleC）', aiGroupMarked?.authzRoleC === true,
    JSON.stringify({ groups: aiGroups.map((group) => ({ name: group.name, c: group.authzRoleC })) }))

  // C 叠加（动态组）：跨域只读
  const cRead = await authzCheck(linxmUid, ['/元冰可集团/产品运营部/大盘.xlsx'], 'read')
  const cWrite = await authzCheck(linxmUid, ['/元冰可集团/产品运营部/大盘.xlsx'], 'write')
  check('C 叠加：跨域 read 放行/write 拒绝', cRead.data?.decision === 'allow' && cWrite.data?.decision === 'deny' && cRead.data.cTag === true,
    JSON.stringify({ read: cRead.data, write: cWrite.data }))

  // override 破窗（须 nas.authz.write；admin 具备）+ 留痕
  const overrideCheck = await api('POST', '/api/nas/authz/check', { token: admin, body: { nasId, userId: linxmUid, paths: ['/故障处置/任意'], op: 'delete', override: true } })
  const decisionsOverride = (await api('GET', '/api/nas/authz/decisions?userId=' + linxmUid + '&limit=50', { token: admin })).data?.items ?? []
  check('override 破窗放行并强制留痕',
    overrideCheck.data?.decision === 'allow' && overrideCheck.data.override === true
    && decisionsOverride.some((record) => record.override === true && record.highRisk === true))

  // X-On-Behalf-User：平台 userId → 绑钉钉身份后透传三方 userId（网关 stub 已记录该头）
  const headerBefore = nasGwCalls.find((call) => call.onBehalf === adminUid)
  await api('POST', `/api/iam/users/${adminUid}/bindings`, { token: admin, body: { provider: 'dingtalk', unionId: 'dd_admin_x', displayName: '沈亦澜' } })
  await api('GET', `/api/nas/${nasId}/fs?path=/`, { token: admin })
  const lastCall = nasGwCalls[nasGwCalls.length - 1]
  check('X-On-Behalf-User 头透传（平台 userId → 钉钉身份优先；身份零进工具参数）',
    Boolean(headerBefore) && lastCall.onBehalf === 'dd_admin_x' && !('actorId' in (lastCall.args ?? {})) && !('actorName' in (lastCall.args ?? {})))

  // fail-closed 告警：observeOnly=false 后高频 deny 触发告警规则
  const alertRule = await api('POST', '/api/audit/alert-rules', { token: admin, body: { name: 'NAS 数据权限高频拒绝', metric: 'nas_authz_denied', threshold: 5, windowMinutes: 10, severity: 'warning' } })
  const rulesNow3 = await api('GET', '/api/nas/authz/rules', { token: admin })
  await api('PUT', '/api/nas/authz/rules', { token: admin, body: { ifVersion: rulesNow3.data.version, observeOnly: false } })
  for (let i = 0; i < 12; i++) {
    await authzCheck(linxmUid, ['/元冰可集团/市场部/超出作用域.txt'], 'write')
  }
  const denyAlerts = (await api('GET', '/api/audit/alerts', { token: admin })).data?.alerts ?? []
  check('enforce（observeOnly=false）高频 deny → nas_authz_denied 告警触发',
    alertRule.ok && denyAlerts.some((alert) => alert.title.includes('NAS 数据权限高频拒绝')),
    JSON.stringify({ ruleOk: alertRule.ok, titles: denyAlerts.slice(0, 5).map((alert) => alert.title) }))
  const rulesNow4 = await api('GET', '/api/nas/authz/rules', { token: admin })
  await api('PUT', '/api/nas/authz/rules', { token: admin, body: { ifVersion: rulesNow4.data.version, observeOnly: true } })
  const decisionsDeny = (await api('GET', `/api/nas/authz/decisions?decision=deny&nasId=${nasId}&limit=10`, { token: admin })).data
  check('deny 判定留痕可查询（decisions 集合）', decisionsDeny.total >= 12)

  // —— share 审批闭环（T/M share 默认 deny → 申请 → 审批人自动路由 → 通过 → 例外生效 → 到期自动拒绝）——
  const shareDeny = await authzCheck(linxmUid, ['/元冰可集团/技术中心/AI 平台部/季度报告.docx'], 'share')
  check('M share 默认 deny（提示走审批）', shareDeny.data?.decision === 'deny' && shareDeny.data.reasons.some((r) => r.includes('审批')))
  const shareReq = await api('POST', '/api/nas/authz/exceptions', {
    token: admin,
    body: { status: 'pending', nasId, userId: linxmUid, path: '/元冰可集团/技术中心/AI 平台部/季度报告.docx', reason: '客户演示需要' },
  })
  check('share 申请 → 审批人自动路由（沿组织链向上最近负责人：AI 平台部自身的连接器同步负责人）',
    shareReq.ok && shareReq.data.kind === 'approval' && shareReq.data.approverSuggestion?.orgName === 'AI 平台部'
    && Array.isArray(shareReq.data.approverSuggestion?.leaderUserIds) && shareReq.data.approverSuggestion.leaderUserIds.includes(linxmUid)
    && shareReq.data.escalated === false,
    JSON.stringify(shareReq.data))
  const shareApprove = await api('POST', `/api/approvals/${shareReq.data.approvalId}/decide`, { token: admin, body: { decision: 'approve', opinion: '同意', confirmed: true } })
  const shareAllow = await authzCheck(linxmUid, ['/元冰可集团/技术中心/AI 平台部/季度报告.docx'], 'share')
  check('审批通过 → share 例外自动写入并放行（7 天有效期留痕）', shareApprove.ok && shareAllow.data?.decision === 'allow' && Boolean(shareAllow.data.ruleId))
  const rulesNow5 = await api('GET', '/api/nas/authz/rules', { token: admin })
  const expiredExceptions = rulesNow5.data.exceptions.map((exception) => (
    exception.id === shareAllow.data.ruleId ? { ...exception, expiresAt: '2026-08-01T00:00:00Z' } : exception))
  await api('PUT', '/api/nas/authz/rules', { token: admin, body: { ifVersion: rulesNow5.data.version, exceptions: expiredExceptions } })
  const shareExpired = await authzCheck(linxmUid, ['/元冰可集团/技术中心/AI 平台部/季度报告.docx'], 'share')
  check('share 例外到期自动拒绝（回落矩阵 deny）', shareExpired.data?.decision === 'deny')

  // —— 负责人悬空 / 组织目录对账 ——
  const vacantOrg = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '应急小组（无负责人）', parentId: orgRootId } })
  await api('POST', '/api/iam/users', { token: admin, body: { username: 'vacantm', displayName: '悬空样本', orgId: vacantOrg.data.id, password: 'Ybk@2026' } })
  const vacancy = await api('POST', '/api/nas/authz/leader-vacancy-scan', { token: admin })
  const vacancyAlerts = (await api('GET', '/api/audit/alerts', { token: admin })).data?.alerts ?? []
  check('负责人悬空扫描：新悬空组织被发现 + leaderVacant 告警',
    vacancy.ok && (vacancy.data.vacant ?? []).some((org) => org.orgName === '应急小组（无负责人）')
    && vacancyAlerts.some((alert) => alert.title.includes('负责人悬空')),
    JSON.stringify({ vacant: vacancy.data?.vacant?.map((org) => org.orgName) }))

  // —— 负责人手动绑定（手动锁定优先于连接器同步，leaderVacant 处置入口）——
  const mstUid = userAll.find((user) => user.jobNumber === 'DD0008')?.id // 孟疏桐：mock 目录市场部负责人的同步口径
  check('负责人手动绑定夹具就绪（市场部同步负责人 DD0008）', Boolean(mstUid))
  await api('PATCH', `/api/iam/orgs/${vacantOrg.data.id}`, { token: admin, body: { leaderUserIds: [mstUid] } })
  const pinnedSample = (await api('GET', '/api/iam/orgs', { token: admin })).data.find((org) => org.id === vacantOrg.data.id)
  const vacancyPinned = await api('POST', '/api/nas/authz/leader-vacancy-scan', { token: admin })
  check('负责人手动绑定：落库 + leaderSource=manual + 悬空扫描不再命中',
    pinnedSample?.leaderSource === 'manual' && JSON.stringify(pinnedSample?.leaderUserIds) === JSON.stringify([mstUid])
    && !(vacancyPinned.data?.vacant ?? []).some((org) => org.orgId === vacantOrg.data.id),
    JSON.stringify({ leaders: pinnedSample?.leaderUserIds, source: pinnedSample?.leaderSource }))

  const mktId = orgByName('市场部')
  await api('PATCH', `/api/iam/orgs/${mktId}`, { token: admin, body: { leaderUserIds: [linxmUid] } })
  const resyncGuard = await api('POST', '/api/iam/connectors/dingtalk/sync', { token: admin })
  const mktAfterSync = (await api('GET', '/api/iam/orgs', { token: admin })).data.find((org) => org.id === mktId)
  check('手动锁定不被连接器同步覆盖（同步跳过 manual 组织并在消息计数）',
    resyncGuard.ok && String(resyncGuard.data?.message ?? '').includes('手动锁定')
    && mktAfterSync?.leaderSource === 'manual' && JSON.stringify(mktAfterSync?.leaderUserIds) === JSON.stringify([linxmUid]),
    JSON.stringify({ msg: resyncGuard.data?.message, mkt: mktAfterSync?.leaderUserIds, src: mktAfterSync?.leaderSource }))

  await api('PATCH', `/api/iam/orgs/${mktId}`, { token: admin, body: { leaderUserIds: [] } })
  const mktCleared = (await api('GET', '/api/iam/orgs', { token: admin })).data.find((org) => org.id === mktId)
  check('清空负责人恢复跟随同步（leaderSource 回 sync）',
    mktCleared?.leaderSource === 'sync' && (mktCleared?.leaderUserIds ?? []).length === 0,
    JSON.stringify({ src: mktCleared?.leaderSource }))
  const resyncRestore = await api('POST', '/api/iam/connectors/dingtalk/sync', { token: admin })
  const mktRestored = (await api('GET', '/api/iam/orgs', { token: admin })).data.find((org) => org.id === mktId)
  check('恢复跟随同步后负责人由同步回填（孟疏桐 DD0008）',
    resyncRestore.ok && JSON.stringify(mktRestored?.leaderUserIds) === JSON.stringify([mstUid]),
    JSON.stringify({ mkt: mktRestored?.leaderUserIds, err: resyncRestore.error }))
  await api('PATCH', `/api/iam/orgs/${vacantOrg.data.id}`, { token: admin, body: { leaderUserIds: [] } })

  const reconcile = await api('POST', '/api/nas/authz/reconcile', { token: admin })
  const reconcileReport = reconcile.data?.report ?? []
  const reconcileFindings = reconcileReport.flatMap((row) => row.findings ?? [])
  const reconcileAlerts = (await api('GET', '/api/audit/alerts', { token: admin })).data?.alerts ?? []
  check('组织↔目录对账：目录无组织 + 组织无目录 双向发现并告警',
    reconcile.ok && reconcileFindings.some((f) => f.kind === 'dir-without-org' && f.name === 'homes')
    && reconcileFindings.some((f) => f.kind === 'org-without-dir' && f.name === '市场部')
    && reconcileAlerts.some((alert) => alert.title.includes('组织目录对账')),
    JSON.stringify({ report: reconcileReport, titles: reconcileAlerts.slice(0, 5).map((alert) => alert.title), err: reconcile.error }))

  // —— 多 NAS：B 平台 NAS deny ——
  const authzNas2Reg = await api('POST', '/api/nas', { token: admin, body: { name: '财务 NAS（数据权限对账）', attrs: { description: '多 NAS 作用域隔离自测', gatewayUrl: `http://127.0.0.1:${NAS_GW_PORT}/mcp`, accessToken: NAS_GW_TOKEN, nasIp: NAS_GW_IP, rootPath: '/', orgRoot: '市场部' } } })
  const authzNas2Id = authzNas2Reg.data?.id
  const crossNas = await authzCheck(linxmUid, ['/任何/x'], 'read', { nasId: authzNas2Id })
  check('多 NAS：A 平台成员对 B 平台 NAS deny（orgRoot 不在其组织链）',
    authzNas2Reg.ok && crossNas.data?.decision === 'deny' && crossNas.data.reasons.some((r) => r.includes('nas.no-scope')))

  // —— 组织改名演练：orgPathOverrides 映射表优先，作用域不漂移 ——
  await api('PATCH', `/api/nas/${nasId}`, { token: admin, body: { attrs: { orgPathOverrides: JSON.stringify({ [orgAiId]: '/研发' }) } } })
  const overrideScope1 = await authzCheck(linxmUid, ['/研发/模型卡.md'], 'read')
  await api('PATCH', `/api/iam/orgs/${orgAiId}`, { token: admin, body: { name: '创新部门' } })
  const overrideScope2 = await api('GET', `/api/nas/authz/scope?nasId=${nasId}&userId=${linxmUid}`, { token: admin })
  check('组织改名演练：映射表命中 → 改名前后作用域均为 /研发（不漂移）',
    overrideScope1.data?.decision === 'allow' && JSON.stringify(overrideScope2.data.scope) === JSON.stringify(['/研发']))
  await api('PATCH', `/api/iam/orgs/${orgAiId}`, { token: admin, body: { name: 'AI 平台部' } })
  await api('PATCH', `/api/nas/${nasId}`, { token: admin, body: { attrs: { orgPathOverrides: '' } } })

  // —— C 组漂移告警（R5）——
  await api('POST', '/api/iam/groups/refresh-snapshots', { token: admin })
  const driftUser = await api('POST', '/api/iam/users', { token: admin, body: { username: 'driftu', displayName: '漂移样本', orgId: orgFeId, password: 'Ybk@2026' } })
  await api('PATCH', `/api/iam/users/${driftUser.data.id}`, { token: admin, body: { orgId: orgAiId } })
  const driftRefresh = await api('POST', '/api/iam/groups/refresh-snapshots', { token: admin })
  const authzDriftAlerts = (await api('GET', '/api/audit/alerts', { token: admin })).data?.alerts ?? []
  check('C 组重算漂移 → cGroupDrift 告警（C 关联组任何漂移都告警）',
    driftRefresh.ok && (driftRefresh.data.drifts ?? []).some((drift) => drift.groupName === 'AI 平台部全员' && drift.alerted)
    && authzDriftAlerts.some((alert) => alert.title.includes('成员漂移')),
    JSON.stringify({ drifts: driftRefresh.data?.drifts, titles: authzDriftAlerts.slice(0, 5).map((alert) => alert.title) }))

  // deny 留痕保留策略：普通 deny 记录带 highRisk=false（高危 delete/share/admin 永久保留）
  const shareDecisionRows = (await api('GET', `/api/nas/authz/decisions?decision=allow&nasId=${nasId}&limit=50`, { token: admin })).data?.items ?? []
  check('高危 op（share）留痕 highRisk 标记（永久保留策略依据）', shareDecisionRows.some((record) => record.op === 'share' && record.highRisk === true))

  // ================================================================ Skill 包 NAS 存储
  section('Skill 包 NAS 存储（上架自动打包上传）')
  const storageDeny = await api('PUT', '/api/skill-storage', { token: dev, body: { mode: 'nas', nasId, basePath: '/skillhub' } })
  check('无 skill.storage.write 配置存储被拒（403）', storageDeny.status === 403)
  const storageSet = await api('PUT', '/api/skill-storage', { token: admin, body: { mode: 'nas', nasId, basePath: '/skillhub' } })
  check('配置包存储后端为已纳管 NAS 资产', storageSet.ok && storageSet.data.mode === 'nas' && storageSet.data.nasId === nasId && storageSet.data.basePath === '/skillhub')

  // ① 提交自带 zip：上架时原样上传 NAS
  const zipBuffer = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('selftest-skill-zip-payload')])
  const pkgSubmit = await api('POST', '/api/skills', { token: admin, body: { name: '自测打包技能', content: '# 自测打包技能\n\n## 何时使用\n验证 skill.zip 随提交上传 NAS 的全链路。\n\n## 步骤\n提交即携带包内容。', category: '通用', version: '1.0.0', packageBase64: zipBuffer.toString('base64') } })
  check('提交可携带 skill.zip（hasPackage）', pkgSubmit.ok && pkgSubmit.data.hasPackage === true, JSON.stringify(pkgSubmit.error))
  const pkgSkillId = pkgSubmit.data?.id
  const badZip = await api('POST', '/api/skills', { token: admin, body: { name: '坏包技能', content: '# x', category: '通用', packageBase64: Buffer.from('not-a-zip').toString('base64') } })
  check('非 ZIP 内容（缺 PK 魔数）提交被拒', !badZip.ok)
  await api('POST', `/api/skills/${pkgSkillId}/approve`, { token: admin, body: { level: 'domain', decision: 'approve', opinion: 'selftest' } })
  const uploadsBefore = nasGwUploads.length
  const pkgPublish = await api('POST', `/api/skills/${pkgSkillId}/publish`, { token: admin, body: {} })
  const pkgUploaded = nasGwUploads[nasGwUploads.length - 1]
  check('上架自动上传 NAS（fs_upload 收到包）', pkgPublish.ok && nasGwUploads.length === uploadsBefore + 1, JSON.stringify(pkgPublish.error))
  check('上传产物即提交的 zip（字节级一致）', pkgUploaded?.magic === 'PK' && pkgUploaded.sizeBytes === zipBuffer.length && pkgUploaded.content.equals(zipBuffer))
  check('上传路径契约 <basePath>/<slug>/<slug>-<version>.zip', typeof pkgUploaded?.destPath === 'string' && pkgUploaded.destPath.startsWith('/skillhub/') && typeof pkgUploaded?.filename === 'string' && pkgUploaded.filename.endsWith('-1.0.0.zip') && pkgUploaded.filename === `${pkgUploaded.destPath.split('/').pop()}-1.0.0.zip`)
  const pkgSkill = await api('GET', `/api/skills/${pkgSkillId}`, { token: admin })
  const pkgVersion = pkgSkill.data?.versions?.find((v) => v.version === '1.0.0')
  check('版本记录回写 package 元数据（storage=nas）', pkgVersion?.package?.storage === 'nas' && pkgVersion.package.nasId === nasId && pkgVersion.package.sizeBytes === zipBuffer.length)
  const pkgDownload = await rawReq('GET', `/api/skills/${pkgSkillId}/package?version=1.0.0`, { headers: { authorization: `Bearer ${admin}` } })
  check('包下载端点返回 zip（PK 头）', pkgDownload.status === 200 && pkgDownload.body.startsWith('PK'))

  // ② 无 zip 提交：上架时由 SKILL.md 现场打包（platform-core zip.ts，零依赖）
  const autoSubmit = await api('POST', '/api/skills', { token: admin, body: { name: '自测自动打包', content: '# 自测自动打包\n\n## 何时使用\n验证无 zip 提交时由 SKILL.md 现场打包上传 NAS。\n\n## 步骤\n提交 → 审批 → 上架。', category: '通用', version: '0.1.0' } })
  await api('POST', `/api/skills/${autoSubmit.data.id}/approve`, { token: admin, body: { level: 'domain', decision: 'approve', opinion: 'selftest' } })
  const autoPublish = await api('POST', `/api/skills/${autoSubmit.data.id}/publish`, { token: admin, body: {} })
  const autoUploaded = nasGwUploads[nasGwUploads.length - 1]
  check('无 zip 时由 SKILL.md 现场打包上传', autoPublish.ok && autoUploaded?.magic === 'PK' && autoUploaded.sizeBytes > 100 && autoUploaded.filename.endsWith('-0.1.0.zip'), JSON.stringify(autoPublish.error))
  check('现场打包产物含 SKILL.md 条目', autoUploaded?.content.toString('latin1').includes('SKILL.md'))

  // ③ fail-closed：存储后端 NAS 非 online → 上架中止且版本不落 published
  const draftNas = await api('POST', '/api/nas', { token: admin, body: { name: '未上线 NAS', attrs: { description: 'fail-closed 验证', gatewayUrl: `http://127.0.0.1:${NAS_GW_PORT}/mcp`, accessToken: NAS_GW_TOKEN, nasIp: NAS_GW_IP, dataClass: 'internal' } } })
  await api('PUT', '/api/skill-storage', { token: admin, body: { mode: 'nas', nasId: draftNas.data.id, basePath: '/skillhub' } })
  const fcSubmit = await api('POST', '/api/skills', { token: admin, body: { name: '自测中止技能', content: '# 自测中止技能\n\n## 何时使用\n验证存储后端 NAS 未上线时上架 fail-closed。\n\n## 步骤\n提交 → 审批 → 上架应中止。', category: '通用', version: '1.0.0' } })
  await api('POST', `/api/skills/${fcSubmit.data.id}/approve`, { token: admin, body: { level: 'domain', decision: 'approve', opinion: 'selftest' } })
  const fcPublish = await api('POST', `/api/skills/${fcSubmit.data.id}/publish`, { token: admin, body: {} })
  check('存储后端 NAS 未上线 → 上架 fail-closed', !fcPublish.ok && JSON.stringify(fcPublish.error).includes('fail-closed'), JSON.stringify(fcPublish.error))
  const fcSkill = await api('GET', `/api/skills/${fcSubmit.data.id}`, { token: admin })
  check('fail-closed 后版本未标记 published', fcSkill.ok && fcSkill.data.versions.every((v) => v.status !== 'published'))
  await api('PUT', '/api/skill-storage', { token: admin, body: { mode: 'local' } })
  const storageBack = await api('GET', '/api/skill-storage', { token: admin })
  check('存储后端可切回 local', storageBack.ok && storageBack.data.config.mode === 'local')

  // ================================================================ 台账与巡检（NAS 接入）
  section('资产台账与巡检（NAS 接入）')
  const inventory = await api('GET', '/api/assets/inventory', { token: admin })
  check('台账包含 nas 资产类型', inventory.ok && inventory.data.items.some((item) => item.type === 'nas') && (inventory.data.summary.byType.nas?.total ?? 0) >= 2)
  const healthcheck = await api('POST', '/api/assets/healthcheck', { token: admin, body: {} })
  check('一键巡检覆盖在线 NAS（initialize 探活 healthy）', healthcheck.ok && healthcheck.data.items.some((item) => item.type === 'nas' && item.status === 'healthy'))

  // 下架分析：弃用/下线原因聚合（审计 change 日志 + Skill 落库原因 + Agent/应用生命周期留痕）
  const retire = await api('GET', '/api/assets/retire-reasons?days=90', { token: admin })
  const retireReasons = retire.data?.reasons ?? []
  check('下架分析（原因聚合，Skill 弃用原因可检索）', retire.ok && retire.data.total >= 2
    && retireReasons.some((row) => row.reason === '自测弃用' && (row.byType.skill ?? 0) >= 1)
    && retireReasons.every((row) => row.reason && row.count >= 1))

  // ================================================================ 平台即 MCP Server（POST /mcp）
  section('平台即 MCP Server（POST /mcp）')
  const mcpAnon = await rawReq('POST', '/mcp', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })
  check('无 Bearer 令牌 401', mcpAnon.status === 401)
  const mcpGet = await rawReq('GET', '/mcp', { headers: { authorization: `Bearer ${admin}` } })
  check('GET SSE 长流不支持（405，纯 JSON 形态合法）', mcpGet.status === 405)
  const mcpInit = await rawReq('POST', '/mcp', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'selftest', version: '1.0' } } }),
  })
  check('initialize 返回 serverInfo/capabilities + 会话头', mcpInit.status === 200 && jsonBody(mcpInit).result?.serverInfo?.name === 'dsh-ops-platform' && typeof mcpInit.headers['mcp-session-id'] === 'string')
  const mcpNotify = await rawReq('POST', '/mcp', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  check('通知类消息 202 确认', mcpNotify.status === 202)
  const mcpTools = await rawReq('POST', '/mcp', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  const mcpToolList = jsonBody(mcpTools).result?.tools ?? []
  check('tools/list 暴露全部运维工具（40+，含 nas_*）', mcpToolList.length >= 40 && mcpToolList.some((t) => t.name === 'nas_fs_upload'), `tools=${mcpToolList.length}`)
  // 组2：19 工具补 permission 声明 → /mcp tools/list 以 annotations['x-permission'] 透出（非空字符串）
  {
    const permOf = (name) => mcpToolList.find((t) => t.name === name)?.annotations?.['x-permission']
    const batch2Expect = [
      ['agent_list', 'agent.read'], ['audit_logs', 'audit.read'], ['authn_token_list', 'authn.principal.read'],
      ['model_list', 'modelgw.read'], ['mcp_service_list', 'mcp.service.read'], ['mcp_deploy', 'mcp.service.deploy'],
      ['app_list', 'app.read'], ['skill_search', 'skill.read'], ['skill_submit', 'skill.submit'],
      ['market_plugin_list', 'market.read'], ['connect_code_create', 'connect.manage'],
    ]
    const missingPerm = batch2Expect.filter(([name, perm]) => permOf(name) !== perm)
    const declaredCount = mcpToolList.filter((t) => typeof t.annotations?.['x-permission'] === 'string' && t.annotations['x-permission'].length > 0).length
    check(`组2：/mcp tools/list 权限注解全覆盖（${declaredCount}/${mcpToolList.length} 工具声明非空 x-permission，console.login 基线仅作漏声明 fail-safe）`,
      mcpToolList.length >= 60 && declaredCount === mcpToolList.length && missingPerm.length === 0,
      `缺失/不符：${JSON.stringify(missingPerm)}；未声明：${JSON.stringify(mcpToolList.filter((t) => !t.annotations?.['x-permission']).map((t) => t.name))}`)
    check('组2：注解不变量——凡携带 annotations 的工具其 x-permission 必为非空字符串',
      mcpToolList.every((t) => t.annotations === undefined || (typeof t.annotations['x-permission'] === 'string' && t.annotations['x-permission'].length > 0)))
    // 主控：connect 5 个本地工具（client 形态，host 形态不在册）补 permission:'console.login'——静态源断言
    const connectSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-connect', 'src', 'index.ts'), 'utf8')
    const clientTools = ['connect_status', 'connect_setup', 'connect_login', 'connect_test', 'connect_reset']
    const toolBlock = (name) => {
      const start = connectSrc.indexOf(`name: '${name}'`)
      if (start < 0) return ''
      const next = connectSrc.indexOf('t.register(defineTool({', start)
      return connectSrc.slice(start, next < 0 ? undefined : next)
    }
    const connectMissing = clientTools.filter((name) => !toolBlock(name).includes("permission: 'console.login'"))
    check('主控：connect 五个本地工具（client 形态）均声明 permission=console.login（静态源断言）',
      connectMissing.length === 0, `缺失：${JSON.stringify(connectMissing)}`)
  }
  const mcpCall = await rawReq('POST', '/mcp', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nas_list', arguments: {} } }),
  })
  const mcpCallResult = jsonBody(mcpCall).result
  check('tools/call 执行成功（content blocks）', mcpCall.status === 200 && mcpCallResult?.isError === false && Array.isArray(mcpCallResult?.content), JSON.stringify(jsonBody(mcpCall)).slice(0, 200))
  const mcpDeny = await rawReq('POST', '/mcp', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${dev}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nas_fs_mkdir', arguments: { nasId, path: '/skillhub/x' } } }),
  })
  const mcpDenyResult = jsonBody(mcpDeny).result
  check('工具级权限点拦截（dev 缺 nas.write → isError）', mcpDeny.status === 200 && mcpDenyResult?.isError === true && JSON.stringify(mcpDenyResult).includes('nas.write'))
  const mcpUnknown = await rawReq('POST', '/mcp', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} }),
  })
  check('未知方法 -32601', jsonBody(mcpUnknown).error?.code === -32601)
  // 组2：工具最小权限映射行为面——业务面仅持 agent.read 的机器令牌（console.login 为登录基线）：
  // agent_list 放行 / audit_logs 双面拦截 + 审计落痕
  {
    const a7Cred = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'a7-agent-read-only', refType: 'external', scopes: ['console.login', 'agent.read'] } })
    const a7Token = (await api('POST', '/api/auth/client-credentials', { body: { clientId: a7Cred.data.clientId, clientSecret: a7Cred.data.clientSecret } })).data?.token
    check('A7 前置：仅 agent.read scope 的机器令牌就绪', Boolean(a7Token), JSON.stringify(a7Cred.error ?? {}))
    const a7Allow = await api('POST', '/api/tools/execute', { token: a7Token, body: { name: 'agent_list', args: {} } })
    check('组2 A7：agent.read 机器令牌 tools/call agent_list 放行',
      a7Allow.ok && a7Allow.data.isError === false && Number.isFinite(a7Allow.data.value?.total), JSON.stringify(a7Allow.error ?? a7Allow.data?.error))
    const a7RestDeny = await api('POST', '/api/tools/execute', { token: a7Token, body: { name: 'audit_logs', args: {} } })
    check('组2 A7：同令牌 REST tools/call audit_logs 被拒（403 FORBIDDEN，缺 audit.read）',
      a7RestDeny.status === 403 && a7RestDeny.error?.code === 'FORBIDDEN' && /audit\.read/.test(a7RestDeny.error?.message ?? ''), `${a7RestDeny.status} ${JSON.stringify(a7RestDeny.error)}`)
    const a7McpDeny = await rawReq('POST', '/mcp', {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a7Token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'audit_logs', arguments: {} } }),
    })
    const a7McpResult = jsonBody(a7McpDeny).result
    check('组2 A7：同令牌 /mcp tools/call audit_logs → isError（与 REST 桥权限基线对齐）',
      a7McpDeny.status === 200 && a7McpResult?.isError === true && /audit\.read/.test(JSON.stringify(a7McpResult)), JSON.stringify(a7McpResult).slice(0, 160))
    let a7AuditHit = null
    for (let i = 0; i < 20 && !a7AuditHit; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      const logs = await api('GET', '/api/audit/logs?type=authz&limit=50', { token: admin })
      a7AuditHit = (logs.data?.items ?? []).find((log) => String(log.detail ?? '').includes('缺少权限点 audit.read') && log.resourceId === '/mcp')
    }
    check('组2 A7：工具桥拒绝落审计（authz denied：缺少权限点 audit.read，path=/mcp 可反查）',
      Boolean(a7AuditHit), JSON.stringify(a7AuditHit ?? '未命中'))
  }

  // ================================================================ 连接器纳管（open-connector 融合）
  section('连接器纳管（open-connector 融合）')
  const waitFor = async (fn, ms = 5000) => {
    const end = Date.now() + ms
    let value
    while (Date.now() < end) {
      value = fn()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return fn()
  }

  // -- 网关配置与强制 env fail-closed（T-02 预演探针路径） ----------------------
  const envProbeEnc = await api('GET', `/api/connector/gateway?assumeEnv=${encodeURIComponent(JSON.stringify({ OOMOL_CONNECT_ADMIN_TOKEN: true, OOMOL_CONNECT_ENCRYPTION_KEY: false }))}`, { token: admin })
  check('T-02 缺 OOMOL_CONNECT_ENCRYPTION_KEY → fail-closed 文案', !envProbeEnc.data?.available && String(envProbeEnc.data?.reason ?? '').includes('OOMOL_CONNECT_ENCRYPTION_KEY'), JSON.stringify(envProbeEnc).slice(0, 200))
  const envProbeToken = await api('GET', `/api/connector/gateway?assumeEnv=${encodeURIComponent(JSON.stringify({ OOMOL_CONNECT_ADMIN_TOKEN: false }))}`, { token: admin })
  check('T-02 管理口令未解析 → fail-closed 文案', !envProbeToken.data?.available && String(envProbeToken.data?.reason ?? '').includes('管理口令未解析'), JSON.stringify(envProbeToken).slice(0, 200))

  const gwSet = await api('PUT', '/api/connector/gateway', { token: admin, body: { baseUrl: OC_BASE, adminToken: 'env:OOMOL_CONNECT_ADMIN_TOKEN', autoCatalogSyncMinutes: 0 } })
  check('网关配置（baseUrl + adminToken env: 间接引用）', gwSet.ok && gwSet.data.baseUrl === OC_BASE, JSON.stringify(gwSet).slice(0, 200))
  const gwHealth = await api('POST', '/api/connector/gateway/health', { token: admin })
  check('探活契约（ok/runtime/latencyMs）', gwHealth.ok && gwHealth.data.ok === true && typeof gwHealth.data.latencyMs === 'number')
  const gwState = await api('GET', '/api/connector/gateway', { token: admin })
  check('网关状态可用（healthy + envChecks 双 true）', gwState.ok && gwState.data.available === true && gwState.data.status === 'healthy' && gwState.data.envChecks.OOMOL_CONNECT_ENCRYPTION_KEY === true)

  // -- 目录同步（T-03） --------------------------------------------------------
  const catSync1 = await api('POST', '/api/connector/catalog/sync', { token: admin })
  const catSync1Data = catSync1.data ?? {}
  check('目录同步 providers/actions 计数与 added 清单', catSync1.ok && catSync1Data.providers === 2 && catSync1Data.actions === 7 && catSync1Data.added.length === 7, JSON.stringify(catSync1).slice(0, 300))
  check('非法 service 标识被拒纳管（resource 正则）', (catSync1Data.skippedServices ?? []).some((item) => item.service === 'weird service!'), JSON.stringify(catSync1Data.skippedServices))
  const catalogView = (await api('GET', '/api/connector/catalog', { token: admin })).data
  const riskOf = Object.fromEntries((catalogView.actions ?? []).map((action) => [action.id, action.riskLevel]))
  check('riskLevel 映射（读/写/管理 + 默认 admin 兜底）',
    riskOf['hackernews.get_top_stories'] === 'read' && riskOf['github.create_issue'] === 'write'
    && riskOf['github.delete_webhook'] === 'admin' && riskOf['hackernews.do_the_thing'] === 'admin', JSON.stringify(riskOf))
  const guideRaw = await rawReq('GET', '/api/connector/catalog/actions/hackernews.get_top_stories/guide', { headers: { authorization: `Bearer ${admin}` } })
  check('连接向导 agent.md 代理展示（文本）', guideRaw.status === 200 && guideRaw.body.includes('连接指南'))

  // -- 组织 / 用户（org 隔离锚点） ----------------------------------------------
  const connOrg = (await api('POST', '/api/iam/orgs', { token: admin, body: { name: '连接器测试部' } })).data.id
  const connOrgB = (await api('POST', '/api/iam/orgs', { token: admin, body: { name: '连接器隔离部' } })).data.id
  const devUserSearch = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('陈默'), { token: admin })).data.users[0]
  const connDevLogin = await api('POST', '/api/auth/login', { body: { username: 'dev', password: 'Ybk@2026' } })
  const connAuditLogin = await api('POST', '/api/auth/login', { body: { username: 'audit', password: 'Ybk@2026' } })
  check('测试主体就绪（dev 令牌 / audit 令牌）', Boolean(devUserSearch?.id) && Boolean(connDevLogin.data?.token) && Boolean(connAuditLogin.data?.token))

  // -- 连接管理（T-05/T-06/T-07） -----------------------------------------------
  const apiKeyCreate = await api('POST', '/api/connector/connections/api-key', { token: admin, body: { orgId: connOrg, provider: 'github', aliasSuffix: 'main-pat', values: { apiKey: 'ghp_selftestSecret123' } } })
  check('API Key 表单直达 sidecar（返回 active 引用）', apiKeyCreate.ok && apiKeyCreate.data.reference?.status === 'active' && String(apiKeyCreate.data.reference.ocConnectionId ?? '').startsWith('oc-con-'), JSON.stringify(apiKeyCreate).slice(0, 220))
  const patRef = apiKeyCreate.data.reference

  const oauthMissClient = await api('POST', '/api/connector/connections/oauth', { token: admin, body: { orgId: connOrg, provider: 'github', aliasSuffix: 'oauth-bot' } })
  check('T-06 未存 client 配置 → oauth_client_config_required 透传+自备 App 指引',
    oauthMissClient.ok === false && oauthMissClient.error?.code === 'OAUTH_CLIENT_CONFIG_REQUIRED' && /OAuth App|自备/.test(oauthMissClient.error?.message ?? ''), JSON.stringify(oauthMissClient).slice(0, 240))
  ocClientsConfigured.add('github')
  const oauthStart = await api('POST', '/api/connector/connections/oauth', { token: admin, body: { orgId: connOrg, provider: 'github', aliasSuffix: 'oauth-bot' } })
  check('T-01 OAuth 发起信封 {authorizationUrl,state}', oauthStart.ok && Boolean(oauthStart.data.authorizationUrl) && Boolean(oauthStart.data.state), JSON.stringify(oauthStart).slice(0, 220))
  const callbackHtml = await fetch(`${OC_BASE}/oauth/callback?state=${oauthStart.data.state}&code=fake-code`).then((r) => r.text())
  check('sidecar 回调完成页受理', callbackHtml.includes('授权完成'))
  const oauthConfirm = await api('GET', `/api/connector/connections/oauth/${oauthStart.data.state}/status`, { token: admin })
  check('T-05 回调后状态轮询：引用转 active 且平台不落凭证原文', oauthConfirm.ok && oauthConfirm.data.status === 'active' && oauthConfirm.data.authType === 'oauth', JSON.stringify(oauthConfirm).slice(0, 260))

  // 别名前缀组织校验（T-20 后半）：跨 org 引用别名在权限组校验层拒绝在下方断言。

  // -- 权限组 + oct_ 台账初始镜像（T-11） ----------------------------------------
  const grpAdmin = (await api('POST', '/api/iam/groups', { token: admin, body: { name: '连接器组-A', type: 'static', memberIds: [adminLogin.data.user.id] } })).data
  const grpDev = (await api('POST', '/api/iam/groups', { token: admin, body: { name: '连接器组-B(dev)', type: 'static', memberIds: [devUserSearch.id] } })).data
  check('测试用户组建好', Boolean(grpAdmin?.id) && Boolean(grpDev?.id))

  const crossOrgGroup = await api('POST', '/api/connector/perm-groups', { token: admin, body: {
    name: '非法跨 org 组', orgId: connOrgB,
    policies: { github: { allowedActions: ['github.list_issues'], riskCap: 'read', connections: [`org:${connOrg}:main-pat`] } },
    subjects: [{ type: 'user_group', id: grpAdmin.id }],
  } })
  check('T-20 引用非本组织前缀别名的权限组被拒', crossOrgGroup.ok === false, JSON.stringify(crossOrgGroup).slice(0, 220))

  const pgRead = (await api('POST', '/api/connector/perm-groups', { token: admin, body: {
    name: 'dev 只读组', orgId: connOrg,
    policies: {
      hackernews: { allowedActions: ['hackernews.get_top_stories'], riskCap: 'read', constraints: { readOnly: true } },
      github: { allowedActions: ['*'], riskCap: 'read', connections: [`org:${connOrg}:main-pat`], constraints: { readOnly: true } },
    },
    subjects: [{ type: 'user_group', id: grpDev.id }],
  } })).data
  const pgFull = (await api('POST', '/api/connector/perm-groups', { token: admin, body: {
    name: 'admin 全量组', orgId: connOrg,
    policies: { hackernews: { allowedActions: '*', riskCap: 'admin' }, github: { allowedActions: '*', riskCap: 'admin' }, },
    subjects: [{ type: 'user_group', id: grpAdmin.id }],
  } })).data
  const pgTmp = (await api('POST', '/api/connector/perm-groups', { token: admin, body: {
    name: 'dev 高危通道组', orgId: connOrg,
    policies: { hackernews: { allowedActions: ['hackernews.do_the_thing'], riskCap: 'admin' } },
    subjects: [{ type: 'user_group', id: grpDev.id }],
  } })).data
  check('三个权限组建好（含显式清单/通配/admin 通道）', Boolean(pgRead?.id) && Boolean(pgFull?.id) && Boolean(pgTmp?.id), JSON.stringify({ pgRead, pgFull, pgTmp }).slice(0, 240))

  await waitFor(() => [...ocLedgerTokens.values()].length >= 3)
  const ocReadTokens = [...ocLedgerTokens.entries()].filter(([, rec]) => rec.policy.allowedConnections.length > 0)
  check('T-11 只读组令牌策略镜像逐字段一致',
    ocReadTokens.some(([, rec]) =>
      rec.policy.allowedActions[0] === '*' || JSON.stringify([...rec.policy.allowedActions].sort()) === JSON.stringify(['github.list_issues', 'hackernews.get_top_stories'])
      && rec.policy.allowedProxies.length === 0 && rec.policy.blockedActions.length === 0
      && rec.policy.allowedConnections.join(',') === patRef.ocConnectionId), JSON.stringify(ocReadTokens.map(([, r]) => r.policy)))
  const fullLedgerTokens = [...ocLedgerTokens.entries()].filter(([, rec]) => rec.policy.allowedActions[0] === '*')
  check('T-11 通配组令牌镜像（allowedActions=[\'*\']，无绑定连接则空数组全发）', fullLedgerTokens.length >= 1 && Array.isArray(fullLedgerTokens[0][1].policy.allowedConnections))
  const impactPreview = await api('POST', `/api/connector/perm-groups/${pgRead.id}/impact`, { token: admin })
  check('变更影响面预览（N 令牌/M 连接）', impactPreview.ok && impactPreview.data.tokens >= 1 && impactPreview.data.connections >= 1, JSON.stringify(impactPreview).slice(0, 160))

  // -- 授权链执行（T-08/T-09/T-10 + 三端 dry-run） -------------------------------
  const memberDenied = await api('POST', '/api/connector/execute', { token: connAuditLogin.data.token, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  check('T-08 无 connector.invoke 权限点 → 403 + authz.denied 事件', memberDenied.ok === false && memberDenied.error?.code === 'FORBIDDEN' && memberDenied.status === 403, JSON.stringify(memberDenied).slice(0, 200))

  const devDryRun = await api('POST', '/api/connector/execute', { token: connDevLogin.data.token, body: { actionId: 'hackernews.get_top_stories', input: { limit: 5 }, dryRun: true } })
  check('dry-run 影响面预览（五步链通过、只读约束可见、不真实调用）', devDryRun.ok && devDryRun.data?.status === 'dry_run' && devDryRun.data.preview.riskLevel === 'read' && typeof devDryRun.data.preview.permGroup === 'string' && devDryRun.data.preview.readOnlyConstraint === true, JSON.stringify(devDryRun).slice(0, 300))

  const devOkRun = await api('POST', '/api/connector/execute', { token: connDevLogin.data.token, body: { actionId: 'hackernews.get_top_stories', input: { limit: 5 } } })
  check('授权放行成功调用（runId=executionId + 计量回执）', devOkRun.ok && devOkRun.data?.ok === true && /^exec-/.test(String(devOkRun.data.runId)) && devOkRun.data.metered === true, JSON.stringify(devOkRun).slice(0, 280))
  const devOkUsage = await api('GET', `/api/usage/events?limit=50`, { token: admin })
  check('T-14 usage.record 口径（resource/meters/trace_id/idempotency_key）',
    devOkUsage.ok && devOkUsage.data.items.some((event) =>
      event.resource === 'connector:hackernews' && event.trace_id === devOkRun.data.runId
      && event.idempotency_key === `connector:${devOkRun.data.runId}` && event.meters.some((m) => m.key === 'calls')), JSON.stringify(devOkUsage.data?.items?.slice(0, 2)).slice(0, 240))
  const priceBook = (await api('GET', '/api/usage/price-book', { token: admin })).data
  check('价格簿 connector:* 零费率条目存在（缺规则会被 record 拒绝的反向保障）',
    priceBook.entries.some((entry) => entry.pattern === 'connector:*' && entry.list_cents_per_unit === 0), JSON.stringify(priceBook.entries?.filter((e) => e.pattern.startsWith('connector')) ?? []).slice(0, 160))

  const devWriteDenied = await api('POST', '/api/connector/execute', { token: connDevLogin.data.token, body: { actionId: 'github.create_issue', input: { title: 'x' } } })
  check('T-09 write 级超出 readOnly/riskCap=read → 平台侧拒绝', devWriteDenied.ok && devWriteDenied.data?.status === 'denied' && /(riskCap|只读)/.test(String(devWriteDenied.data.error)), JSON.stringify(devWriteDenied).slice(0, 240))

  const isoLogin = await api('POST', '/api/auth/login', { body: { username: 'suyq', password: 'Ybk@2026' } })
  const isoGroup = (await api('POST', '/api/iam/groups', { token: admin, body: { name: '连接器组-单点', type: 'static', memberIds: [(await api('GET', '/api/iam/users?q=' + encodeURIComponent('苏砚秋'), { token: admin })).data.users[0].id] } })).data
  const pgIso = (await api('POST', '/api/connector/perm-groups', { token: admin, body: {
    name: '单点清单组（pattern-miss 回归）', orgId: connOrg,
    policies: { hackernews: { allowedActions: ['hackernews.get_top_stories'], riskCap: 'read' } },
    subjects: [{ type: 'user_group', id: isoGroup.id }],
  } })).data
  const devPatternMiss = await api('POST', '/api/connector/execute', { token: isoLogin.data.token, body: { actionId: 'hackernews.fetch_item', input: {} } })
  check('T-10 pattern 未命中 → 平台侧拒绝', devPatternMiss.ok && devPatternMiss.data?.status === 'denied' && /允许模式/.test(String(devPatternMiss.data.error)), JSON.stringify(devPatternMiss).slice(0, 260))

  // -- T-15 审计 actChain + runId 反查 -----------------------------------------
  const devAuditTrail = await api('GET', `/api/audit/logs?q=${encodeURIComponent(String(devOkRun.data.runId))}&type=invoke`, { token: admin })
  check('T-15 invoke 日志含 runId（run= 前缀反查命中）',
    devAuditTrail.ok && devAuditTrail.data.items.some((log) => log.resourceType === 'connector_action' && String(log.detail).includes(`run=${devOkRun.data.runId}`)), JSON.stringify(devAuditTrail.data?.items?.slice(0, 2)).slice(0, 240))

  // -- T-22 写类幂等键 + 同键重放不重复计量 ---------------------------------------
  const directAdminMintRes = await fetch(`${OC_BASE}/api/runtime-tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OC_TOKEN}` },
    body: JSON.stringify({ name: 'selftest-direct', allowedActions: ['*'], blockedActions: [], allowedProxies: [], allowedConnections: [] }),
  }).then((r) => r.json())
  const directOct = directAdminMintRes.data.token
  ocMintedValues.push(directOct)
  const replayKey = 'ikey-selftest-0001'
  const directExec = () => fetch(`${OC_BASE}/v1/actions/hackernews.submit_post`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${directOct}`, 'idempotency-key': replayKey },
    body: JSON.stringify({ input: { title: '自测幂等帖' } }),
  }).then((r) => r.json())
  const firstReplay = await directExec()
  const secondReplay = await directExec()
  check('T-22 同键重放返回原 executionId（24h 窗口语义）', firstReplay.meta.executionId === secondReplay.meta.executionId, `${firstReplay.meta.executionId} vs ${secondReplay.meta.executionId}`)
  const runsForExec = ocRuns.filter((run) => run.id === firstReplay.meta.executionId)
  check('T-22 重放不产生重复 run（stub 侧单条）', runsForExec.length === 1, String(runsForExec.length))

  // -- 高危审批门禁（T-17） ------------------------------------------------------
  const adminCallResp = await api('POST', '/api/connector/execute', { token: connDevLogin.data.token, body: { actionId: 'hackernews.do_the_thing', input: { work: 1 } } })
  const approvalFlow = adminCallResp.data ?? {}
  check('admin 级 action → 审批单生成且不执行', approvalFlow.status === 'approval_required' && Boolean(approvalFlow.approvalId), JSON.stringify(adminCallResp).slice(0, 260))
  const dupApproval = await api('POST', '/api/connector/execute', { token: connDevLogin.data.token, body: { actionId: 'hackernews.do_the_thing', input: { work: 1 } } })
  check('同图 pending 审批单复用（不重复开单）', dupApproval.data?.approvalId === approvalFlow.approvalId, JSON.stringify(dupApproval).slice(0, 180))
  const beforeCalls = ocCalls.filter((call) => call.actionId === 'hackernews.do_the_thing').length
  const decide = await api('POST', `/api/approvals/${approvalFlow.approvalId}/decide`, { token: admin, body: { decision: 'approve', opinion: '自测批准', confirmed: true } })
  check('审批通过后 executor 同步完成调用（L4 闭环）', decide.ok && String(decide.data.execution?.result ?? '').includes('runId'), JSON.stringify(decide.data?.execution ?? {}).slice(0, 240))
  const afterCalls = ocCalls.filter((call) => call.actionId === 'hackernews.do_the_thing').length
  check('executor 真实下发一次数据面调用', afterCalls === beforeCalls + 1, `before=${beforeCalls} after=${afterCalls}`)

  // -- OPT-P1-02 冒充面封死（能力令牌替代旧布尔旁路） ---------------------------------
  const smuggleResp = await api('POST', '/api/tools/execute', { token: connDevLogin.data.token, body: { name: 'connector_execute', args: { actionId: 'hackernews.do_the_thing', input: { work: 1 }, viaApprovalExecutor: true, approvalCapability: { token: 'forged-by-attacker', actionId: 'hackernews.do_the_thing', callerId: 'attacker', expiresAt: Date.now() + 60_000 } } } })
  const smuggleValue = smuggleResp.data?.value ?? smuggleResp.data ?? {}
  check('P1-02 工具桥走私旧布尔/伪造能力令牌 → 仍强制开单（fail-closed）', smuggleValue?.status === 'approval_required' && Boolean(smuggleValue.approvalId), JSON.stringify(smuggleValue ?? {}).slice(0, 240))
  let booleanBypassHits = 0
  const scanBypass = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const filePath = join(dir, entry.name); if (entry.isDirectory()) { if (entry.name !== 'node_modules') scanBypass(filePath) } else if (filePath.endsWith('.ts') && readFileSync(filePath, 'utf8').includes('viaApprovalExecutor')) booleanBypassHits++ } }
  scanBypass('packages'); scanBypass('src')
  check('P1-02 旧布尔旁路全仓 0 命中（能力令牌替代，验收 grep 口径）', booleanBypassHits === 0, `hits=${booleanBypassHits}`)

  // -- connector.connect 两段式审批门禁（T-18，凭证不入审批负载） -------------------
  const gatedConnectReq = await api('POST', '/api/connector/connections/api-key', { token: admin, body: { orgId: connOrg, provider: 'github', aliasSuffix: 'gated-pat', values: { apiKey: 'client-supersecret-oauth-xyz' }, requireApproval: true } })
  check('T-18 requireApproval → 仅生成审批单（凭证不落任何集合）', gatedConnectReq.data?.approvalRequired === true && Boolean(gatedConnectReq.data.approvalId), JSON.stringify(gatedConnectReq).slice(0, 200))
  await api('POST', `/api/approvals/${gatedConnectReq.data.approvalId}/decide`, { token: approver, body: { decision: 'approve', confirmed: true } })
  const gatedFinalize = await api('POST', '/api/connector/connections/api-key', { token: admin, body: { orgId: connOrg, provider: 'github', aliasSuffix: 'gated-pat', values: { apiKey: 'client-supersecret-oauth-xyz' }, approvalId: gatedConnectReq.data.approvalId } })
  check('审批通过后携 approvalId 完成实际创建', gatedFinalize.ok && gatedFinalize.data.reference?.status === 'active', JSON.stringify(gatedFinalize).slice(0, 220))

  // -- T-12 权限组变更 PUT 四数组全发 + 组删 DELETE 令牌 ----------------------------
  const putsBeforeChange = ocPuts.length
  const patchedRead = await api('PATCH', `/api/connector/perm-groups/${pgRead.id}`, { token: admin, body: {
    policies: {
      hackernews: { allowedActions: ['hackernews.get_top_stories', 'hackernews.fetch_item'], riskCap: 'read', constraints: { readOnly: true } },
      github: { allowedActions: ['*'], riskCap: 'read', connections: [`org:${connOrg}:main-pat`], constraints: { readOnly: true } },
    },
  } })
  check('权限组策略更新成功', patchedRead.ok)
  const mirrorPutAfterPatch = await waitFor(() => ocPuts.slice(putsBeforeChange)[0], 4000)
  check('T-12 变更触发 PUT 且四数组全发',
    mirrorPutAfterPatch && Object.keys(mirrorPutAfterPatch.policy).sort().join() === ['allowedActions', 'allowedConnections', 'allowedProxies', 'blockedActions'].sort().join()
    && Array.isArray(mirrorPutAfterPatch.policy.allowedActions) && Array.isArray(mirrorPutAfterPatch.policy.allowedConnections), JSON.stringify(mirrorPutAfterPatch ?? {}).slice(0, 240))

  // -- T-04 目录下架联动（先落库裁剪再镜像 PUT） ----------------------------------
  ocCtl.actions = (ocCtl.actions ?? [...ocActionsDefault]).filter((action) => action.id !== 'hackernews.fetch_item')
  const resyncAfterRemoval = await api('POST', '/api/connector/catalog/sync', { token: admin })
  check('目录下架检测（removed 命中）', resyncAfterRemoval.ok && (resyncAfterRemoval.data.removed ?? []).includes('hackernews.fetch_item'), JSON.stringify(resyncAfterRemoval.data?.removed))
  const prunedPut = await waitFor(() => ocPuts.find((put) => !put.policy.allowedActions.includes('hackernews.fetch_item') && put.policy.allowedActions.length >= 1), 4000)
  check('T-04 下架后受影响组收到裁剪后的 PUT 更新', Boolean(prunedPut), JSON.stringify(ocPuts.slice(-2)))

  // -- T-13 自动恢复（403 connection_not_allowed → PUT 最新快照 + 重试一次） ----------
  ocCtl.connNotAllowedOnce = '*ANY*'
  const recoverOk = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  check('T-13 单次 403 自动恢复重试成功（对调用方透明）', recoverOk.ok && recoverOk.data?.status === 'ok', JSON.stringify(recoverOk).slice(0, 220))
  // 恢复过程触发了「删旧铸新」：最新铸造值即平台当前在用的该组令牌（每次铸造都会入册）
  const mintCountBefore = ocMintedValues.length
  void mintCountBefore
  ocCtl.alwaysDenyToken = '*ANY*'
  const persistFail = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  check('T-13 持续拒绝 → 重试仍失败计 error_rate', persistFail.ok && persistFail.data?.status === 'error', JSON.stringify(persistFail).slice(0, 220))
  ocCtl.alwaysDenyToken = null

  // 目录恢复：fetch_item 回归目录并重新同步（后续 T-16a 等用例依赖它）
  ocCtl.actions = [...(ocCtl.actions ?? [])].concat((ocActionsDefault).filter((action) => action.id === 'hackernews.fetch_item'))
  await api('POST', '/api/connector/catalog/sync', { token: admin })

  // -- T-28 auditPersisted=false 补记 + 低阈告警记分 -------------------------------
  ocCtl.auditPersistedNext = true
  const ghostRun = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: { ghost: true } } })
  ocCtl.auditPersistedNext = false
  check('meta.auditPersisted=false 透传给调用方', ghostRun.ok && ghostRun.data?.status === 'ok' && ghostRun.data.meta.auditPersisted === false, JSON.stringify(ghostRun.data?.meta))
  const recoveredLog = await api('GET', `/api/audit/logs?q=${encodeURIComponent('recovered-audit')}&type=invoke&limit=50`, { token: admin })
  check('T-28 平台补记审计', recoveredLog.ok && recoveredLog.data.items.length >= 1, JSON.stringify(recoveredLog.data?.items?.slice(0, 1)))

  // -- OPT-P1-05 TOCTOU 收紧（镜像失败 fail-closed + 执行侧快照漂移拒绝） -------------
  // 隔离主体（isoGroup 仅本组覆盖 fetch_item），保证候选组唯一、断言不受其他健康组干扰
  const pgP105 = (await api('POST', '/api/connector/perm-groups', { token: admin, body: {
    name: 'P1-05 TOCTOU 观测组', orgId: connOrg,
    policies: { hackernews: { allowedActions: ['hackernews.fetch_item'], riskCap: 'write' } },
    subjects: [{ type: 'user_group', id: isoGroup.id }],
    rateLimitPerMin: 60,
  } })).data
  const p105Invoke = () => api('POST', '/api/connector/execute', { token: isoLogin.data.token, body: { actionId: 'hackernews.fetch_item', input: {} } })
  const p105Baseline = await p105Invoke()
  check('P1-05 基线调用成功（健康组可用）', p105Baseline.data?.status === 'ok', JSON.stringify(p105Baseline.data ?? {}).slice(0, 200))
  // 场景一：镜像注入失败 → 旧 oct_ 令牌立即吊销 + 组级 fail-closed
  // （快照哈希只含 allowedActions/connections 面——扩动作列表才会触发镜像 PUT）
  const deletesBeforeFail = ocDeletes.length
  ocMirrorFailOnce = true
  await api('PATCH', `/api/connector/perm-groups/${pgP105.id}`, { token: admin, body: { policies: { hackernews: { allowedActions: ['hackernews.fetch_item', 'hackernews.get_top_stories'], riskCap: 'write' } } } })
  await waitFor(() => ocDeletes.length > deletesBeforeFail, 4000)
  check('P1-05 镜像失败 → 旧 oct_ 令牌立即吊销（DELETE 命中 stub，不静默放大窗口）', ocDeletes.length > deletesBeforeFail)
  const p105FailClosed = await p105Invoke()
  check('P1-05 镜像失败期间组级 fail-closed → invoke 拒绝', p105FailClosed.data?.status === 'denied' && String(p105FailClosed.data.error).includes('fail-closed'), JSON.stringify(p105FailClosed.data ?? {}).slice(0, 220))
  // 场景二：恢复铸币期间并发收紧（确定性注入：钩子 PATCH 收紧至 H3 并延迟应答，外层镜像最后落账 H2）
  const mintedBeforeDrift = ocMintedValues.length
  // PATCH#2 回收组面（H2：单动作）触发恢复铸币；钩子在铸币期间并发改到 H3（双动作）并延迟应答，
  // 外层镜像最后按 H2 落账 → ledger(H2) 滞后于当前策略(H3)，确定性制造快照漂移
  ocDriftOnMint = { permGroupId: pgP105.id, token: admin, delayMs: 150, body: { policies: { hackernews: { allowedActions: ['hackernews.fetch_item', 'hackernews.get_top_stories', 'hackernews.submit_post'], riskCap: 'write' } } } }
  await api('PATCH', `/api/connector/perm-groups/${pgP105.id}`, { token: admin, body: { policies: { hackernews: { allowedActions: ['hackernews.get_top_stories'], riskCap: 'write' } } } })
  await waitFor(() => ocMintedValues.length > mintedBeforeDrift + 1, 5000)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const p105Drift = await p105Invoke()
  check('P1-05 授权后策略漂移（ledger 滞后当前策略）→ 执行侧拒绝按旧快照执行',
    p105Drift.data?.status === 'denied' && String(p105Drift.data.error).includes('快照漂移'), JSON.stringify(p105Drift.data ?? {}).slice(0, 240))
  // 收敛：镜像一次 PUT（账本哈希对齐当前）→ 调用恢复
  await api('PATCH', `/api/connector/perm-groups/${pgP105.id}`, { token: admin, body: { policies: { hackernews: { allowedActions: ['hackernews.fetch_item', 'hackernews.get_top_stories'], riskCap: 'write' } } } })
  await waitFor(() => ocPuts.length > mintedBeforeDrift, 4000).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 400))
  const p105Recovered = await p105Invoke()
  check('P1-05 镜像收敛后调用恢复（对齐账本哈希后正常执行）', p105Recovered.data?.status === 'ok', JSON.stringify(p105Recovered.data ?? {}).slice(0, 200))
  // 观测组退场：删除组（连带吊销令牌），恢复 isoGroup 单点清单组口径，不污染后续用例
  await api('DELETE', `/api/connector/perm-groups/${pgP105.id}`, { token: admin })

  // OPT-P2-02：敏感命名入参不入审批存储（admin 审批通道 fail-closed）
  const pgP202 = (await api('POST', '/api/connector/perm-groups', { token: admin, body: {
    name: 'P2-02 敏感面观测组', orgId: connOrg,
    policies: { hackernews: { allowedActions: ['hackernews.do_the_thing'], riskCap: 'admin' } },
    subjects: [{ type: 'user_group', id: isoGroup.id }],
    rateLimitPerMin: 60,
  } })).data
  const p202Sensitive = await api('POST', '/api/connector/execute', { token: isoLogin.data.token, body: { actionId: 'hackernews.do_the_thing', input: { password: 'plain-secret' } } })
  check('P2-02 admin 调用携敏感命名入参 → 拒绝开单（敏感值不入审批存储）',
    p202Sensitive.data?.status === 'denied' && String(p202Sensitive.data.error).includes('敏感命名参数'), JSON.stringify(p202Sensitive.data ?? {}).slice(0, 220))
  await api('DELETE', `/api/connector/perm-groups/${pgP202.id}`, { token: admin })

  // OPT-P2-01：ODD 域内判定（排除 action → 离域拒绝 + connector.odd_exit 落审计）
  const pgOdd = (await api('POST', '/api/connector/perm-groups', { token: admin, body: {
    name: 'P2-01 ODD 观测组', orgId: connOrg,
    policies: { hackernews: { allowedActions: ['hackernews.fetch_item', 'hackernews.get_top_stories'], riskCap: 'write' } },
    subjects: [{ type: 'user_group', id: isoGroup.id }],
    rateLimitPerMin: 60,
    odd: { allowedServices: ['hackernews'], excludedActions: ['hackernews.fetch_item'] },
  } })).data
  check('P2-01 ODD 块声明入库', Boolean(pgOdd.odd?.excludedActions?.length === 1), JSON.stringify(pgOdd.odd ?? {}))
  const oddDenied = await api('POST', '/api/connector/execute', { token: isoLogin.data.token, body: { actionId: 'hackernews.fetch_item', input: {} } })
  check('P2-01 排除清单内 action → ODD 离域拒绝', oddDenied.data?.status === 'denied' && String(oddDenied.data.error).includes('ODD'), JSON.stringify(oddDenied.data ?? {}).slice(0, 220))
  // OPT-P1-04 起总线异步派发：审计落账为最终一致，轮询等待（FIFO 中其他监听器退避重试会延迟投递）
  let oddTrailItems
  const oddTrailDeadline = Date.now() + 4000
  while (Date.now() < oddTrailDeadline) {
    const trail = await api('GET', '/api/audit/logs?q=' + encodeURIComponent('ODD') + '&type=invoke&limit=20', { token: admin })
    if (trail.ok && trail.data.items.length >= 1) { oddTrailItems = trail.data.items; break }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  check('P2-01 离域事件落审计（ODD 离域可检索）', Array.isArray(oddTrailItems) && oddTrailItems.length >= 1, JSON.stringify(oddTrailItems?.slice(0, 1) ?? []).slice(0, 180))
  const oddAllowed = await api('POST', '/api/connector/execute', { token: isoLogin.data.token, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  check('P2-01 白名单内 action 正常执行', oddAllowed.data?.status === 'ok', JSON.stringify(oddAllowed.data ?? {}).slice(0, 160))
  await api('DELETE', `/api/connector/perm-groups/${pgOdd.id}`, { token: admin })

  // -- T-16a 限流（用单点清单组保证候选组唯一，绕开多组并集下的候选顺序不确定性） --------
  await api('PATCH', `/api/connector/perm-groups/${pgIso.id}`, { token: admin, body: { rateLimitPerMin: 1 } })
  const rateLimited = await api('POST', '/api/connector/execute', { token: isoLogin.data.token, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  const rateLimitedSecond = await api('POST', '/api/connector/execute', { token: isoLogin.data.token, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  check('T-16a 超 rateLimitPerMin → rate_limited 拒绝',
    [rateLimited.data?.status, rateLimitedSecond.data?.status].includes('rate_limited'),
    JSON.stringify([rateLimited.data, rateLimitedSecond.data]).slice(0, 300))
  await api('PATCH', `/api/connector/perm-groups/${pgIso.id}`, { token: admin, body: { rateLimitPerMin: 60 } })

  // -- T-19 stub 关停 fail-closed + 恢复 ------------------------------------------
  await api('PUT', '/api/connector/gateway', { token: admin, body: { baseUrl: 'http://127.0.0.1:9', adminToken: 'env:OOMOL_CONNECT_ADMIN_TOKEN' } })
  const outage1 = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  const outage3 = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  check('T-19 网关不可达 → invoke fail-closed（GATEWAY_UNAVAILABLE）',
    outage1.ok === false || outage1.data?.status === 'error', JSON.stringify(outage1).slice(0, 220))
  // 连续失败计数 ≥3 时 ConnectorGatewayUnhealthy 事件→audit 落 invoke 日志（探活定时器 30s 周期之外的即时口径）
  const unhealthyTrail = await api('GET', '/api/audit/logs?q=' + encodeURIComponent('fail-closed') + '&type=invoke&limit=20', { token: admin })
  check('T-19 fail-closed 原因入审计（unavailableReason 可检索）', unhealthyTrail.ok && unhealthyTrail.data.items.length >= 1, JSON.stringify(unhealthyTrail.data?.items?.slice(0, 1)).slice(0, 200))
  await api('PUT', '/api/connector/gateway', { token: admin, body: { baseUrl: OC_BASE } })
  await api('POST', '/api/connector/gateway/health', { token: admin })
  const recoveredState = await api('GET', '/api/connector/gateway', { token: admin })
  check('T-19 恢复后自动回 healthy 并可继续调用', recoveredState.data.available === true, JSON.stringify(recoveredState).slice(0, 160))

  // -- OPT-P3-01 故障注入回归（4 类：网关 5xx / sidecar 审计失联 / 目录漂移 / oct_ 令牌吊销） ----
  // ①网关 5xx：注入一次 500 → 调用显式失败（不静默、可计数），随后恢复
  ocCtl.failNextExec = true
  const gw5xx = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  check('P3-01 故障① 网关 5xx → 调用显式失败（status=error 计入 error_rate）', gw5xx.data?.status === 'error', JSON.stringify(gw5xx.data ?? {}).slice(0, 200))
  const gw5xxRecover = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  check('P3-01 故障① 注入解除后调用恢复', gw5xxRecover.data?.status === 'ok', JSON.stringify(gw5xxRecover.data ?? {}).slice(0, 160))
  // ②sidecar 审计失联：数据面 auditPersisted=false → 平台补记（fail-visible 双写口径）
  ocCtl.auditPersistedNext = true
  const auditLost = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: { fault: 'audit-loss' } } })
  ocCtl.auditPersistedNext = false
  check('P3-01 故障② sidecar 审计失联 → 平台补记且向调用方透出', auditLost.data?.status === 'ok' && auditLost.data.meta.auditPersisted === false, JSON.stringify(auditLost.data?.meta ?? {}))
  // ③目录漂移：action 被目录同步移除 → 后续调用 fail-closed 拒绝
  ocCtl.actions = (ocCtl.actions ?? [...ocActionsDefault]).filter((action) => action.id !== 'hackernews.fetch_item')
  await api('POST', '/api/connector/catalog/sync', { token: admin })
  const driftDenied = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.fetch_item', input: {} } })
  check('P3-01 故障③ 目录漂移（action 被移除）→ 调用拒绝', driftDenied.data?.status === 'denied' && String(driftDenied.data.error).includes('不在纳管目录'), JSON.stringify(driftDenied.data ?? {}).slice(0, 200))
  ocCtl.actions = [...(ocCtl.actions ?? [])].filter((action) => action.id !== 'hackernews.fetch_item').concat(ocActionsDefault.filter((action) => action.id === 'hackernews.fetch_item'))
  await api('POST', '/api/connector/catalog/sync', { token: admin })
  const driftRecover = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.fetch_item', input: {} } })
  check('P3-01 故障③ 目录回补后调用恢复', driftRecover.data?.status === 'ok', JSON.stringify(driftRecover.data ?? {}).slice(0, 160))
  // ④oct_ 令牌吊销：sidecar 侧令牌被吊销 → 401 → 自动重铸恢复（obtainOctToken 重铸语义）
  const revokedToken = [...ocTokenByValue.entries()][0]
  if (revokedToken) {
    ocTokenByValue.delete(revokedToken[0])
    const afterRevoke = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: {} } })
    check('P3-01 故障④ oct_ 令牌被吊销 → 自动重铸恢复调用', afterRevoke.data?.status === 'ok', JSON.stringify(afterRevoke.data ?? {}).slice(0, 200))
  }

  // -- OPT-P3-01 P95 尾延迟质量闸门（阈值键可经环境覆盖：P95_GATE_LOGIN_MS / P95_GATE_INVOKE_MS） ----
  const P95_GATE_LOGIN_MS = Number(process.env.P95_GATE_LOGIN_MS ?? 800)
  const P95_GATE_INVOKE_MS = Number(process.env.P95_GATE_INVOKE_MS ?? 1500)
  const pct = (samples, p) => { const sorted = [...samples].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] }
  const loginSamples = []
  const invokeSamples = []
  for (let i = 0; i < 20; i++) {
    const loginStart = Date.now()
    await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
    loginSamples.push(Date.now() - loginStart)
    const invokeStart = Date.now()
    await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: {} } })
    invokeSamples.push(Date.now() - invokeStart)
  }
  const loginP95 = pct(loginSamples, 0.95)
  const invokeP95 = pct(invokeSamples, 0.95)
  const dist = (samples) => `P50=${pct(samples, 0.5)}ms P95=${pct(samples, 0.95)}ms max=${Math.max(...samples)}ms`
  console.log(`  » P95 分布（n=20）：登录 ${dist(loginSamples)} ｜ connector invoke ${dist(invokeSamples)}`)
  check(`P3-01 登录换票 P95 ≤ ${P95_GATE_LOGIN_MS}ms`, loginP95 <= P95_GATE_LOGIN_MS, `p95=${loginP95}ms`)
  check(`P3-01 connector invoke P95 ≤ ${P95_GATE_INVOKE_MS}ms`, invokeP95 <= P95_GATE_INVOKE_MS, `p95=${invokeP95}ms`)

  // -- T-21 org 巡检注入不一致 -----------------------------------------------------
  const foreignConnectionSummary = (() => { return { id: 'oc-con-fake-foreign' } })()
  const anyManagedToken = [...ocLedgerTokens.entries()][0]
  if (anyManagedToken) anyManagedToken[1].policy.allowedConnections.push(foreignConnectionSummary.id)
  const patrolNow = await api('POST', '/api/connector/patrol', { token: admin })
  if (anyManagedToken) anyManagedToken[1].policy.allowedConnections.pop()
  check('T-21 巡检发现「令牌绑定 org 外连接」异常', patrolNow.ok && (patrolNow.data.violations ?? []).some((violation) => violation.kind === 'token_binds_foreign_connection'), JSON.stringify(patrolNow.data).slice(0, 260))
  const patrolAlerts = (await api('GET', '/api/audit/alerts', { token: admin })).data.alerts ?? []
  check('T-21 异常联动 warning 告警（org 巡检标题）', patrolAlerts.some((alert) => String(alert.title).includes('org 巡检')), JSON.stringify(patrolAlerts.filter((a) => String(a.title).includes('巡检')).slice(0, 1)))

  // -- T-23 runs 对账（cursor 增量去重 + 绕行 critical） ---------------------------
  const pageOne = await fetch(`${OC_BASE}/api/runs?limit=2`, { headers: { authorization: `Bearer ${OC_TOKEN}` } }).then((r) => r.json())
  check('T-01 runs 分页信封 {items,nextCursor}',
    Array.isArray(pageOne.data.items) && (pageOne.data.nextCursor === undefined || typeof pageOne.data.nextCursor === 'string'), JSON.stringify(pageOne.data).slice(0, 120))
  const reconcileFirst = await api('POST', '/api/connector/reconcile', { token: admin })
  check('对账首跑：正常 run 与平台计量近似一致（bypass 空）', reconcileFirst.ok && (reconcileFirst.data?.bypassRuns ?? []).length === 0 && reconcileFirst.data.checkedRuns >= 1, JSON.stringify({ err: reconcileFirst.error, data: reconcileFirst.data }))
  ocRuns.push({ id: 'fake-bypass-run-0001', service: 'github', actionId: 'github.list_issues', ok: true, runtimeTokenId: anyManagedToken ? anyManagedToken[0] : 'tok-none', caller: 'direct-sidecar', startedAt: new Date().toISOString() })
  const reconcileBypass = await api('POST', '/api/connector/reconcile', { token: admin })
  check('T-23 有 run 无 meter → 绕行 critical 告警命中 fake-bypass-run-0001', reconcileBypass.ok && (reconcileBypass.data.bypassRuns ?? []).includes('fake-bypass-run-0001'), JSON.stringify(reconcileBypass.data))
  ocCtl.overlapDupInRuns = true
  const reconcileOverlap = await api('POST', '/api/connector/reconcile', { token: admin })
  ocCtl.overlapDupInRuns = false
  // 增量语义：已处理的 run 不重复计入（重叠窗口翻倍也不放大结果集）
  check('T-23 cursor 重叠窗口去重（增量运行零新增，无重复放大）',
    reconcileOverlap.ok && (reconcileOverlap.data.bypassRuns ?? []).length === 0 && reconcileOverlap.data.checkedRuns === 0, JSON.stringify(reconcileOverlap.data))
  const bypassAlerts = (await api('GET', '/api/audit/alerts', { token: admin })).data.alerts ?? []
  check('绕行调用 critical 告警已入审计告警流', bypassAlerts.some((alert) => String(alert.title).includes('绕行调用')), JSON.stringify(bypassAlerts.filter((a) => a.severity === 'critical').slice(-1)))

  // -- T-29 数据面层独立强制（合法 oct_ 直连打非命中 action） ------------------------
  const scopedMint = await fetch(`${OC_BASE}/api/runtime-tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OC_TOKEN}` },
    body: JSON.stringify({ name: 'scoped-single-action', allowedActions: ['github.delete_webhook'], blockedActions: [], allowedProxies: [], allowedConnections: [] }),
  }).then((r) => r.json())
  ocMintedValues.push(scopedMint.data.token)
  const dataPlaneDeny = await fetch(`${OC_BASE}/v1/actions/github.list_issues`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${scopedMint.data.token}` },
    body: JSON.stringify({ input: {} }),
  }).then((r) => r.json())
  check('T-29 合法 oct_ 直连非命中 action → 数据面 403 拒绝',
    dataPlaneDeny.success === false && Number.isFinite(dataPlaneDeny.statusCode ?? dataPlaneDeny.status ?? 403) && dataPlaneDeny.errorCode === 'forbidden_action', JSON.stringify(dataPlaneDeny).slice(0, 200))

  // -- M0 桥接（T-25，importServices + 桥接徽章标记字段） ----------------------------
  const bridgeImport = await api('POST', '/api/mcp/import', { token: admin, body: {
    config: JSON.stringify({
      mcpServers: {
        'open-connector-stub': {
          url: `${OC_BASE}/mcp`,
          headers: { authorization: `Bearer ${OC_TOKEN}`, 'x-bridged-from': 'open-connector' },
        },
      },
    }),
    autoDeploy: true,
  } })
  const bridgeResult = bridgeImport.data?.results?.[0]
  check('T-25 桥接 import 成功（reachable+online）', bridgeImport.ok && bridgeResult?.ok === true && bridgeResult.reachable === true && bridgeResult.tools > 0, JSON.stringify(bridgeImport.data).slice(0, 260))
  const servicesList = (await api('GET', '/api/mcp/services', { token: admin })).data.services
  const bridgedService = servicesList.find((service) => service.slug === 'open-connector-stub')
  check('桥接服务带「bridgeFrom=open-connector」治理降级标记', Boolean(bridgedService?.bridgeFrom) && bridgedService.bridgeFrom === 'open-connector', JSON.stringify({ slug: bridgedService?.slug, bridgeFrom: bridgedService?.bridgeFrom }))
  // M0 治理降级语义：服务级粗粒度 MCP 权限组授权（无 action 级/连接级/令牌镜像）。
  // W 批次 V11 根治后：导入工具 riskLevel='unknown'，非只读语境一律 RISK_UNREGISTERED 拒绝——
  // 本组两条桥接调用（get_top_stories / execute_action→get_top_stories）均为读型，改挂只读约束。
  await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
    name: '桥接自测组（M0）',
    policies: { [bridgedService.id]: { allowedTools: '*', constraints: { readOnly: true } } },
    subjects: [{ type: 'user_group', id: grpAdmin.id }],
  } })
  const bridgedCall = await rawReq('POST', '/mcp', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'mcp_invoke', arguments: { serviceId: bridgedService?.id, tool: 'hackernews_get_top_stories', args: { platform: 'bridge' } } } }),
  })
  const bridgedText = jsonBody(bridgedCall).result?.content?.[0]?.text ?? ''
  // 平台工具层包装形态：InvokeResult.result 可为内容块数组（[{type:text,text:'{...}'}]）
  const bridgeParsed = JSON.parse(bridgedText || '{}')
  const innerBlockText = Array.isArray(bridgeParsed.result) ? bridgeParsed.result[0]?.text ?? '' : ''
  const bridgeEchoSource = (() => {
    try {
      return Array.isArray(bridgeParsed.result) ? JSON.parse(innerBlockText) : bridgeParsed
    } catch { return {} }
  })()
  const bridgeEcho = bridgeParsed.bridgeEcho ?? bridgeParsed.result?.bridgeEcho ?? bridgeEchoSource.bridgeEcho ?? {}
  check('经平台 MCP 网关调用桥接服务成功', bridgedCall.status === 200 && bridgeEcho.platform === 'bridge', bridgedText.slice(0, 220))

  // -- 三端工具面补验（工具桥 connector_execute / perm_group_list） -----------------
  const toolBridgePermList = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'connector_perm_group_list', args: { orgId: connOrg } } })
  check('工具桥 connector_perm_group_list 返回结构化组清单', toolBridgePermList.ok && toolBridgePermList.data.value.total >= 4, JSON.stringify(toolBridgePermList.data?.value?.total))
  const toolBridgeExecute = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'connector_execute', args: { actionId: 'hackernews.get_top_stories', input: { viaTool: true } } } })
  check('工具桥 connector_execute 身份注入 + 放行', toolBridgeExecute.ok && toolBridgeExecute.data.value.status === 'ok', JSON.stringify(toolBridgeExecute.data?.value).slice(0, 220))

  // -- 工具面权限收敛负向用例（架构审查 P0-1/P0-2：org 收敛 + 身份出参数层） -------
  const toolSchemas = (await api('GET', '/api/tools/schemas', { token: admin })).data.tools ?? []
  const connListTool = toolSchemas.find((tool) => tool.name === 'connector_connection_list')
  const connExecTool = toolSchemas.find((tool) => tool.name === 'connector_execute')
  check('工具 schema 不再暴露 orgId / callerId（身份与 org 收敛移出参数层）',
    Boolean(connListTool) && !JSON.stringify(connListTool.parameters).includes('orgId')
    && Boolean(connExecTool) && !JSON.stringify(connExecTool.parameters).includes('callerId'), JSON.stringify({ list: connListTool?.parameters, exec: connExecTool?.parameters }).slice(0, 240))

  const devOrgId = devUserSearch.orgId
  const devForge = await api('POST', '/api/tools/execute', { token: connDevLogin.data.token, body: { name: 'connector_connection_list', args: { orgId: connOrg } } })
  const devForgeList = devForge.data?.value?.connections ?? []
  check('低权限用户伪造 args.orgId 无效（工具仅返回其归属组织连接）',
    devForge.ok && devForgeList.every((item) => item.ownerOrgId === devOrgId), JSON.stringify({ devOrgId, got: devForgeList.map((item) => item.ownerOrgId) }).slice(0, 240))

  const devRestForge = await api('GET', `/api/connector/connections?orgId=${connOrg}`, { token: connDevLogin.data.token })
  check('REST 路径同一套收敛（?orgId= 对非 * 用户无效）', devRestForge.ok && (devRestForge.data.connections ?? []).every((item) => item.ownerOrgId === devOrgId), JSON.stringify(devRestForge.data).slice(0, 160))

  const extReader = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'ext-connector-reader', refType: 'external', scopes: ['console.login', 'connector.connection.read'] } })
  const extCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: extReader.data.clientId, clientSecret: extReader.data.clientSecret } })
  const extList = await api('POST', '/api/tools/execute', { token: extCc.data.token, body: { name: 'connector_connection_list', args: {} } })
  check('外部机器（无资源归属）连接列表 fail-closed 返回空', extList.ok && extList.data.value.total === 0 && String(extList.data.value.note ?? '').includes('fail-closed'), JSON.stringify(extList.data?.value).slice(0, 220))
  const extPermGroups = await api('POST', '/api/tools/execute', { token: extCc.data.token, body: { name: 'connector_perm_group_list', args: { orgId: connOrg } } })
  check('外部机器权限组枚举同样 fail-closed（伪造 orgId 无效）', extPermGroups.ok && extPermGroups.data.value.total === 0, JSON.stringify(extPermGroups.data?.value).slice(0, 180))

  // ================================================================ 审批深化（WP-10/L1）与目录筛选（WP-12）
  section('审批 SLA 与公司级终审（WP-10：二次确认强制 / 终审可追溯 / 调用水印 / SLA 看板）')
  {
    const probe = await api('POST', '/api/agents', { token: admin, body: { name: '终审探针Agent', attrs: { description: 'WP-10 审批治理验证', model: 'deepseek-chat', riskLevel: 'medium', entryUrl: 'http://127.0.0.1:3080/', dataClass: 'internal', avatar: '🛡️' } } })
    check('终审探针：注册（entryUrl 免登通道过上线门禁）', probe.ok, JSON.stringify(probe.error))
    const onlineReq = await api('POST', `/api/agents/${probe.data.agent.id}/transition`, { token: admin, body: { action: 'online', note: 'WP-10 二次确认验证' } })
    check('终审探针：L4 上线审批单为高风险', onlineReq.ok && onlineReq.data.approval?.status === 'pending' && onlineReq.data.approval.riskLevel === 'high', JSON.stringify(onlineReq.data?.approval ?? onlineReq.error))
    const noConfirm = await api('POST', `/api/approvals/${onlineReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '未二次确认应被拒' } })
    check('终审探针：高风险通过缺二次确认被拒（服务端强制，非仅前端拦截）',
      noConfirm.status === 400 && JSON.stringify(noConfirm.error).includes('二次确认'), `${noConfirm.status} ${JSON.stringify(noConfirm.error)}`)
    const withConfirm = await api('POST', `/api/approvals/${onlineReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '已复核影响面（二次确认）', confirmed: true } })
    check('终审探针：二次确认后通过并自动执行', withConfirm.ok && withConfirm.data.status === 'executed', JSON.stringify(withConfirm.error))
    check('终审探针：审批单落公司级终审标记（终审人 + 时间）',
      withConfirm.ok && Boolean(withConfirm.data.finalReview?.approverId) && Boolean(withConfirm.data.finalReview?.at), JSON.stringify(withConfirm.data?.finalReview))
    const finalAudit = await api('GET', '/api/audit/logs?q=' + encodeURIComponent('approval.final_review'), { token: admin })
    check('终审探针：终审标记审计可追溯（action=approval.final_review 指向本审批单）',
      finalAudit.ok && (finalAudit.data.items ?? []).some((log) => log.action === 'approval.final_review' && log.resourceId === onlineReq.data.approval.id),
      JSON.stringify(finalAudit.data?.total))

    // 组2：approval_decide 工具桥 confirmed/finalReview 透传（服务端 high+approve+非 confirmed 拦截门禁不变）
    const toolProbe = await api('POST', '/api/agents', { token: admin, body: { name: '工具桥审批探针Agent', attrs: { description: '组2 approval_decide 工具链验证', model: 'deepseek-chat', riskLevel: 'medium', entryUrl: 'http://127.0.0.1:3080/', dataClass: 'internal', avatar: '🧪' } } })
    const toolOnlineReq = await api('POST', `/api/agents/${toolProbe.data.agent.id}/transition`, { token: admin, body: { action: 'online', note: '组2 工具桥二次确认验证' } })
    check('组2 前置：工具桥审批探针 L4 高风险审批单就绪',
      toolOnlineReq.ok && toolOnlineReq.data.approval?.status === 'pending' && toolOnlineReq.data.approval.riskLevel === 'high', JSON.stringify(toolOnlineReq.error ?? toolOnlineReq.data?.approval?.id))
    const approverId2 = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('approver02'), { token: admin })).data.users[0]?.id
    const toolNoConfirm = await api('POST', '/api/tools/execute', { token: approver, body: { name: 'approval_decide', args: { approvalId: toolOnlineReq.data.approval.id, decision: 'approve', approverId: approverId2, approverName: '第二审批人', opinion: '工具桥未带 confirmed' } } })
    check('组2 A8：approval_decide 工具 approve 缺 confirmed → isError（文案含二次确认语义，门禁不因工具桥旁路）',
      toolNoConfirm.ok && toolNoConfirm.data.isError === true && /二次确认|confirmed/.test(toolNoConfirm.data.error?.message ?? ''), JSON.stringify(toolNoConfirm.data ?? toolNoConfirm.error))
    const toolWithConfirm = await api('POST', '/api/tools/execute', { token: approver, body: { name: 'approval_decide', args: { approvalId: toolOnlineReq.data.approval.id, decision: 'approve', approverId: approverId2, approverName: '第二审批人', opinion: '工具桥已复核（confirmed）', confirmed: true, finalReview: true } } })
    check('组2 A8：approval_decide 带 confirmed:true → 通过并自动执行（executed）',
      toolWithConfirm.ok && toolWithConfirm.data.isError === false && toolWithConfirm.data.value?.status === 'executed', JSON.stringify(toolWithConfirm.data ?? toolWithConfirm.error))
    let toolFinalAudit = null
    for (let i = 0; i < 20 && !toolFinalAudit; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      const logs = await api('GET', '/api/audit/logs?q=' + encodeURIComponent('approval.final_review') + '&limit=50', { token: admin })
      toolFinalAudit = (logs.data?.items ?? []).find((log) => log.action === 'approval.final_review' && log.resourceId === toolOnlineReq.data.approval.id)
    }
    check('组2 A8：finalReview:true 经工具桥透传 → 终审痕迹审计可见（approval.final_review 指向本单）',
      Boolean(toolFinalAudit), JSON.stringify(toolFinalAudit ?? '未命中'))
    // MCP 服务终审 → 调用水印（hosted 演示服务 + 临时权限组授权 admin，确定性不依赖真实传输 stub 存活）
    const mcpsAll = await api('GET', '/api/mcp/services', { token: admin })
    const wmSvc = (mcpsAll.data.services ?? []).find((item) => item.status === 'online' && (item.tools ?? []).some((tool) => tool.riskLevel === 'read'))
      ?? (mcpsAll.data.services ?? []).find((item) => item.status === 'online')
    check('终审水印：在线服务在册', Boolean(wmSvc), JSON.stringify(mcpsAll.data?.services?.length))
    const adminUserId = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('admin'), { token: admin })).data.users.find((user) => user.username === 'admin').id
    const wmGroup = await api('POST', '/api/iam/groups', { token: admin, body: { name: `终审水印组-${Date.now()}`, type: 'static', memberIds: [adminUserId] } })
    const wmPerm = await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
      name: `终审水印权限组-${Date.now()}`,
      policies: { [wmSvc.id]: { allowedTools: '*', constraints: { readOnly: true } } },
      subjects: [{ type: 'user_group', id: wmGroup.data.group?.id ?? wmGroup.data.id, name: '终审水印组' }],
    } })
    check('终审水印：admin 授权权限组就绪', wmPerm.ok, JSON.stringify(wmPerm.error))
    const fr = await api('POST', `/api/mcp/services/${wmSvc.id}/final-review`, { token: admin, body: {} })
    check('终审水印：MCP 服务公司级终审标记成功', fr.ok && Boolean(fr.data.finalReview?.approverId), JSON.stringify(fr.error))
    const wmTool = (wmSvc.tools ?? [])[0]?.name
    const wmInvoke = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: wmSvc.id, tool: wmTool, args: {} } })
    check('终审水印：终审服务可正常调用', wmInvoke.ok && wmInvoke.data.status === 'ok', JSON.stringify({ status: wmInvoke.status, error: wmInvoke.error, data: wmInvoke.data }))
    const wmCalls = await api('GET', `/api/mcp/calls?serviceId=${wmSvc.id}&limit=200`, { token: admin })
    check('终审水印：该服务调用记录附带水印（watermark.finalReview=true）',
      wmCalls.ok && (wmCalls.data.items ?? []).some((call) => call.watermark?.finalReview === true),
      JSON.stringify({ ok: wmCalls.ok, total: wmCalls.data?.total, n: wmCalls.data?.items?.length, w0: wmCalls.data?.items?.[0]?.watermark, s0: wmCalls.data?.items?.[0]?.serviceName, err: wmCalls.error }))
    // SLA 看板
    const sla = await api('GET', '/api/approvals/sla?windowDays=30', { token: admin })
    check('SLA 看板：≤2 工作日达成率可查（自测审批即时决策 → 100% 达标）',
      sla.ok && sla.data.decided >= 1 && sla.data.achievementRate >= 0.9 && typeof sla.data.calendarNote === 'string',
      JSON.stringify(sla.data ?? sla.error))
    const slaDenied = await api('GET', '/api/approvals/sla', { token: dev })
    check('SLA 看板：无 approval.read 被拒（dev 无该权限点）', slaDenied.status === 403, String(slaDenied.status))
  }
  section('资产目录筛选（WP-12：纯函数三条件 + 1000 项性能断言）')
  {
    const filters = await import(new URL('../packages/plugin-console/public/js/asset-filters.js', import.meta.url).href)
    const items = [
      { type: 'mcp', name: '数据分析引擎', slug: 'datawise', platform: 'rd', org: 'AI部', owner: '甲' },
      { type: 'agent', name: '研发编码助手', slug: 'dev-coder', platform: '', org: '研发部', owner: '乙' },
      { type: 'app', name: '数据洞察 BI', slug: 'insight-bi', platform: 'rd', org: 'AI部', owner: '丙' },
    ]
    check('目录：纯函数筛选（类型/平台/关键词三条件，缺失平台归「未标注」）',
      filters.filterAssets(items, { type: 'mcp' }).length === 1
      && filters.filterAssets(items, { platform: 'rd' }).length === 2
      && filters.filterAssets(items, { q: '编码' }).length === 1
      && filters.filterAssets(items, { q: 'DEV-CODER' }).length === 1
      && filters.assetPlatform(items[1]) === '未标注'
      && JSON.stringify(filters.platformFacets(items)) === JSON.stringify(['rd', '未标注']))
    const big = Array.from({ length: 1000 }, (_, i) => ({ type: i % 2 ? 'mcp' : 'agent', name: `资产${i}`, platform: i % 3 ? 'rd' : 'quality', org: 'o', owner: 'w' }))
    const perfStart = Date.now()
    filters.filterAssets(big, { type: 'mcp', platform: 'rd', q: '资产99' })
    const perfMs = Date.now() - perfStart
    check('目录：筛选性能断言（1000 项三条件 < 50ms，单栏卡片流无服务端二次请求）', perfMs < 50, `${perfMs}ms`)
  }

  // ================================================================ 验收回归：offline 审批闭环 / 规则播种 / mcp 直调 execute
  section('验收回归（offline 闭环 · 规则播种 · mcp 直调 execute）')

  // ③ 运营口径：连接器两条规则随演示种子幂等播种
  const seedRules = (await api('GET', '/api/audit/alert-rules', { token: admin })).data.rules ?? []
  check('连接器告警规则已播种（error_rate=critical / latency=warning）',
    seedRules.some((rule) => rule.metric === 'connector_error_rate' && rule.severity === 'critical')
    && seedRules.some((rule) => rule.metric === 'connector_latency' && rule.severity === 'warning'),
    JSON.stringify(seedRules.filter((rule) => String(rule.metric).startsWith('connector_')).map((rule) => [rule.metric, rule.threshold])))

  // ① 网关维护下线：L4 审批闭环（executor 落地 → fail-closed → 恢复探活）
  const gwOfflineReq = await api('POST', '/api/connector/gateway/offline', { token: admin, body: { reason: '验收回归-维护窗口' } })
  check('gateway.offline 默认生成 L4 审批单', gwOfflineReq.data?.approvalRequired === true && Boolean(gwOfflineReq.data.approvalId), JSON.stringify(gwOfflineReq).slice(0, 200))
  await api('POST', `/api/approvals/${gwOfflineReq.data.approvalId}/decide`, { token: approver, body: { decision: 'approve', confirmed: true } })
  const gwAfterOff = await api('GET', '/api/connector/gateway', { token: admin })
  check('审批通过 → executor 落地下线（fail-closed，原因含维护说明）', gwAfterOff.data.available === false && /验收回归/.test(String(gwAfterOff.data.reason)), JSON.stringify({ reason: gwAfterOff.data.reason }))
  const execBlockedMaint = await api('POST', '/api/connector/execute', { token: admin, body: { actionId: 'hackernews.get_top_stories', input: {} } })
  check('维护态 invoke fail-closed 拒绝', execBlockedMaint.data?.status === 'error' || /GATEWAY_UNAVAILABLE|网关/.test(JSON.stringify(execBlockedMaint)), JSON.stringify(execBlockedMaint).slice(0, 200))
  const gwOnline = await api('POST', '/api/connector/gateway/online', { token: admin })
  check('恢复上线即真实探活回 healthy', gwOnline.ok && gwOnline.data.ok === true, JSON.stringify(gwOnline).slice(0, 160))

  // ① 连接级下线：direct 模式留痕生效（不经审批的显式管理员路径）
  const connOffline = await api('POST', `/api/connector/connections/${patRef.id}/offline`, { token: admin, body: { reason: '验收回归-连接巡检', viaApproval: false } })
  check('连接 direct 下线立即生效（offlined 态留痕）', connOffline.ok && connOffline.data.reference?.status === 'offlined' && connOffline.data.reference.offlinedAt, JSON.stringify(connOffline).slice(0, 220))
  const execViaOfflined = await api('POST', '/api/connector/execute', { token: connDevLogin.data.token, body: { actionId: 'github.list_issues', input: {} } })
  check('经由下线连接的调用被平台侧拒绝（连接级闸）', execViaOfflined.ok && execViaOfflined.data?.status === 'denied' && /已下线/.test(String(execViaOfflined.data.error)), JSON.stringify(execViaOfflined).slice(0, 240))
  const connBack = await api('POST', `/api/connector/connections/${patRef.id}/online`, { token: admin })
  check('连接恢复后 sidecar 回查转 active', connBack.ok && connBack.data.reference?.status === 'active', JSON.stringify(connBack).slice(0, 220))

  // ④ POST /mcp tools/call 直调 connector_execute（三端最后一环；验收项原定下次迭代，本轮提前闭合）
  const mcpDirectCall = await rawReq('POST', '/mcp', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 88, method: 'tools/call', params: { name: 'connector_execute', arguments: { actionId: 'hackernews.get_top_stories', input: { viaMcp: true } } } }),
  })
  const mcpDirectRaw = jsonBody(mcpDirectCall).result?.content?.[0]?.text ?? ''
  const mcpDirectOutcome = (() => { try { return JSON.parse(mcpDirectRaw) } catch { return {} } })()
  check('POST /mcp 直调 connector_execute（身份注入 + runId 回执）',
    mcpDirectCall.status === 200 && mcpDirectOutcome.status === 'ok' && /^exec-/.test(String(mcpDirectOutcome.runId)) && mcpDirectOutcome.data?.echo?.viaMcp === true, mcpDirectRaw.slice(0, 260))

  // 桥接规范形态：经 execute_action(actionId,input) 调用（集成指南 v0.2 §五口径；legacy 别名仍兼容）
  const bridgedExecCall = await rawReq('POST', '/mcp', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 89, method: 'tools/call', params: { name: 'mcp_invoke', arguments: { serviceId: bridgedService?.id, tool: 'execute_action', args: { actionId: 'hackernews.get_top_stories', input: { viaExecuteAction: true } } } } }),
  })
  const execRaw = jsonBody(bridgedExecCall).result?.content?.[0]?.text ?? ''
  const execParsed = (() => { try { return JSON.parse(execRaw) } catch { return {} } })()
  const execBlocks = Array.isArray(execParsed.result) ? JSON.parse(execParsed.result[0]?.text ?? '{}') : {}
  check('桥接 execute_action 规范调用成功（含 runId 回执）',
    bridgedExecCall.status === 200 && Boolean(execBlocks.bridgeEcho?.runId ?? execBlocks.runId), execRaw.slice(0, 240))

  // ================================================================ /docs 静态发布（文档目录随服务可访问）
  section('/docs 静态发布（接入指南等文档直接可读）')

  const docIndex = await rawReq('GET', '/docs')
  check('/docs 目录索引页（HTML + 列出接入指南）', docIndex.status === 200 && String(docIndex.headers['content-type']).startsWith('text/html') && docIndex.body.includes('app-sso-integration.md'))
  const docFile = await rawReq('GET', '/docs/app-sso-integration.md')
  check('/docs/app-sso-integration.md 可读（markdown + 正文）', docFile.status === 200 && String(docFile.headers['content-type']).startsWith('text/markdown') && docFile.body.includes('OIDC') && docFile.body.includes('接入'))
  const docMissing = await rawReq('GET', '/docs/not-exists.md')
  check('/docs 未知文档 404', docMissing.status === 404)
  // 路径穿越探测：字面 .. 与编码 %2e%2e 均被 URL 解析归一化（WHATWG 规范视编码点段为点段）→ /package.json；
  // 带扩展名的资源路径未命中不再回落 SPA 页（issue #6），改 404 JSON——同样不泄露文件，且不再给探测方 200 假阳性
  const docTraverseLiteral = await rawReq('GET', '/docs/../package.json')
  check('/docs 字面 .. 穿越 → 404 JSON（不泄露文件，不回 SPA 200）', docTraverseLiteral.status === 404 && jsonBody(docTraverseLiteral)?.error?.code === 'NOT_FOUND' && !docTraverseLiteral.body.includes('"name": "dsh-enterprise-ops"'), `status=${docTraverseLiteral.status}`)
  const docTraverseEncoded = await rawReq('GET', '/docs/%2e%2e/package.json')
  check('/docs 编码 %2e%2e 穿越 → 404 JSON（不泄露文件，不回 SPA 200）', docTraverseEncoded.status === 404 && jsonBody(docTraverseEncoded)?.error?.code === 'NOT_FOUND' && !docTraverseEncoded.body.includes('"name": "dsh-enterprise-ops"'), `status=${docTraverseEncoded.status}`)
  const spaStillOk = await rawReq('GET', '/')
  check('SPA 静态兜底不受影响（/ 仍返回控制台首页）', spaStillOk.status === 200 && String(spaStillOk.headers['content-type']).startsWith('text/html') && spaStillOk.body.includes('元冰可'))

  // 组4：/docs 白名单（PUBLIC_DOCS 默认拒绝）——内部协作面文档一律 404，不做存在性探测
  const docWhitelisted = await rawReq('GET', '/docs/app-onboarding.md')
  check('/docs 白名单内 app-onboarding.md 可读（200 markdown）', docWhitelisted.status === 200 && String(docWhitelisted.headers['content-type']).startsWith('text/markdown'), `status=${docWhitelisted.status}`)
  const docDeployRunbook = await rawReq('GET', '/docs/deploy-enterprise.md')
  check('/docs 白名单外 deploy-enterprise.md → 404（内部 runbook 不随服务发布）', docDeployRunbook.status === 404, `status=${docDeployRunbook.status}`)
  const docQaReport = await rawReq('GET', '/docs/qa-report-20261013-overview.md')
  check('/docs 白名单外 qa-report → 404（QA 报告走仓库私有分发）', docQaReport.status === 404, `status=${docQaReport.status}`)
  const docDevLog = await rawReq('GET', `/docs/dev-log-connector/${encodeURIComponent('任意.md')}`)
  check('/docs 子路径形态（dev-log-connector/任意）→ 404（白名单键为单文件名，无目录伺服面）', docDevLog.status === 404, `status=${docDevLog.status}`)
  const docSlashTraverse = await rawReq('GET', `/docs/%2F${encodeURIComponent('..')}/package.json`)
  check('/docs %2F 编码穿越形态 → 404（越界/畸形编码落不进白名单集合）', docSlashTraverse.status === 404, `status=${docSlashTraverse.status}`)
  const docIndexAfter = await rawReq('GET', '/docs')
  check('/docs 索引只列白名单（200 且不含 deploy-enterprise 字样）',
    docIndexAfter.status === 200 && docIndexAfter.body.includes('app-onboarding.md') && !docIndexAfter.body.includes('deploy-enterprise'),
    docIndexAfter.body.slice(0, 200))

  // 组5 C-10：协议/集成保留前缀无处理器 → 404 JSON（不被 SPA 兜底吞成 200 HTML）
  const reservedProbes = ['/rq/panel/', '/dsh-bridge/status', '/auth/entry']
  const reservedResults = []
  for (const probePath of reservedProbes) {
    const probe = await rawReq('GET', probePath)
    reservedResults.push({ path: probePath, status: probe.status, contentType: probe.headers['content-type'] })
  }
  check('保留前缀：/rq/panel/、/dsh-bridge/status、/auth/entry 无处理器 → 404 JSON（非 SPA HTML，集成方可诊断）',
    reservedResults.every((r) => r.status === 404 && !String(r.contentType).startsWith('text/html')),
    JSON.stringify(reservedResults))
  {
    const reservedBody = jsonBody(await rawReq('GET', '/rq/api/definitely-missing'))
    check('保留前缀：404 信封为 NOT_FOUND JSON（与 DEF-01 同口径）', reservedBody?.error?.code === 'NOT_FOUND', JSON.stringify(reservedBody).slice(0, 120))
  }
  const spaUnknownRoute = await rawReq('GET', '/some/unknown/spa/route')
  check('非保留前缀未知路径仍回落 SPA（控制台 hash 路由不受 C-10 影响）',
    spaUnknownRoute.status === 200 && String(spaUnknownRoute.headers['content-type']).startsWith('text/html'), `status=${spaUnknownRoute.status}`)

  // issue #6：带扩展名的资源路径未命中 → 404 JSON（「看似 JSON」的路径回 200 HTML 会让 Agent 接口探测假阳性）；
  // 无扩展名前端路由照旧兜底（上一条已证）；真实静态资源不受影响
  const jsonLikeMiss = await rawReq('GET', '/openapi.json')
  check('/openapi.json（非 /api、带扩展名、无此文件）→ 404 NOT_FOUND JSON，不再被 SPA 兜底吞成 200 HTML（issue #6）',
    jsonLikeMiss.status === 404 && jsonBody(jsonLikeMiss)?.error?.code === 'NOT_FOUND' && !String(jsonLikeMiss.headers['content-type']).startsWith('text/html'),
    `status=${jsonLikeMiss.status} type=${jsonLikeMiss.headers['content-type']}`)
  const assetMiss = await rawReq('GET', '/js/definitely-missing.js')
  check('缺失静态资源 /js/*.js → 404（不再以 index.html 200 伪装，浏览器拿到真实缺失信号）', assetMiss.status === 404, `status=${assetMiss.status}`)
  const indexExplicit = await rawReq('GET', '/index.html')
  check('显式 /index.html 仍 200 HTML（扩展名规则只作用于未命中路径）', indexExplicit.status === 200 && String(indexExplicit.headers['content-type']).startsWith('text/html'), `status=${indexExplicit.status}`)
  check('扩展名判定纯函数：/openapi.json、/js/a.min.js、/docs/x.md 为资源；/、/panel、/locales/zh-CN、无扩展名深链接不是',
    platformCore.hasFileExtension('/openapi.json') && platformCore.hasFileExtension('/js/a.min.js') && platformCore.hasFileExtension('/docs/x.md')
    && !platformCore.hasFileExtension('/') && !platformCore.hasFileExtension('/panel') && !platformCore.hasFileExtension('/locales/zh-CN') && !platformCore.hasFileExtension('/some/unknown/spa/route'))

  // ================================================================ 门户数据通道（plugin-portal：外部拉取端点）
  section('统一入口：/panel 无尾斜杠 302 归一（相对资源解析防御）')
  const panelBare = await rawReq('GET', '/panel')
  check('/panel 302 → /panel/（独立形态；无归一时 index.html 的 ./js/* 会解析到 /js/* → 白屏）',
    panelBare.status === 302 && panelBare.headers.location === '/panel/',
    `status=${panelBare.status} location=${panelBare.headers.location}`)
  const panelSlash = await rawReq('GET', '/panel/')
  check('/panel/ 面板 SPA 正常伺服（归一目标可达；IAW 壳页随架构统一收编自 DeptAI-UI-DSH）', panelSlash.status === 200 && panelSlash.body.includes('行业 AI 工作台'))
  // 落地分诊纯函数随包单测（landing.test.mjs：五内置角色决议/通配展开/裸落地/回跳白名单）
  const landingTest = spawn(process.execPath, ['packages/plugin-console/public/js/landing.test.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => landingTest.on('close', resolve))
  check('落地分诊随包单测全绿（node --test）', landingTest.exitCode === 0, `exit=${landingTest.exitCode}`)
  // 登录回跳共享面随包单测（F 清单 P 节：一次读取消费/白名单/出口规则，next-redirect.test.mjs）
  const nextRedirectTest = spawn(process.execPath, ['packages/plugin-console/public/js/next-redirect.test.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => nextRedirectTest.on('close', resolve))
  check('登录回跳共享面随包单测全绿（node --test）', nextRedirectTest.exitCode === 0, `exit=${nextRedirectTest.exitCode}`)
  // 01门入口探针随包单测（2026-11-01：挂载判定/前缀推导/不出死链判定面，gate01-entry.test.mjs）
  const gate01EntryTest = spawn(process.execPath, ['packages/plugin-console/public/js/gate01-entry.test.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => gate01EntryTest.on('close', resolve))
  check('01门入口探针随包单测全绿（node --test）', gate01EntryTest.exitCode === 0, `exit=${gate01EntryTest.exitCode}`)
  // 契约↔实现双向一致性（OPT-P0-01，2026-09-12）：引擎构造性红/绿测试 + 真仓零红闸门
  const contractLintTest = spawn(process.execPath, ['scripts/contract-lint.test.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => contractLintTest.on('close', resolve))
  check('契约 lint 引擎构造性红/绿测试全绿（node --test）', contractLintTest.exitCode === 0, `exit=${contractLintTest.exitCode}`)
  const contractLintRepo = spawn(process.execPath, ['scripts/lint-manifests.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => contractLintRepo.on('close', resolve))
  check('契约比对真仓零红（路由/工具/权限双向一致，lint:manifests 通道）', contractLintRepo.exitCode === 0, `exit=${contractLintRepo.exitCode}`)
  // connect 工具远程代理契约化自证（OPT-P1-03：扩展点挂载/转发失败 fail-closed/注销还原）
  const connectProxyTest = spawn(process.execPath, ['packages/plugin-connect/src/proxy.test.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => connectProxyTest.on('close', resolve))
  check('connect 远程代理契约化随包单测全绿（node --test）', connectProxyTest.exitCode === 0, `exit=${connectProxyTest.exitCode}`)
  // 平台总线管道自证（OPT-P1-04：异步串行派发/异常落事件/3 次退避重试入死信/journal 重启回放/人工重投）
  const busPipelineTest = spawn(process.execPath, ['packages/platform-core/src/bus.test.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => busPipelineTest.on('close', resolve))
  check('平台总线管道随包单测全绿（node --test）', busPipelineTest.exitCode === 0, `exit=${busPipelineTest.exitCode}`)
  // 工具注册契约自证（OPT-P2-04：output.schema 强校验，无 schema 注册即抛）
  const toolsLiteTest = spawn(process.execPath, ['packages/platform-core/src/tools-lite.test.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => toolsLiteTest.on('close', resolve))
  check('工具注册契约随包单测全绿（node --test）', toolsLiteTest.exitCode === 0, `exit=${toolsLiteTest.exitCode}`)
  // 连接器风险目录声明式化自证（R6：resolveRiskLevel 优先级链/riskTier/生成物一致性）
  const connectorRiskTest = spawn(process.execPath, ['packages/plugin-connector/src/risk.test.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => connectorRiskTest.on('close', resolve))
  check('连接器风险目录声明式化随包单测全绿（node --test）', connectorRiskTest.exitCode === 0, `exit=${connectorRiskTest.exitCode}`)
  // 审批卫生与规则源自证（OPT-P2-02：敏感面掩码/拒绝 + 补偿注册表编排）
  const approvalTest = spawn(process.execPath, ['packages/plugin-audit/src/approval.test.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => approvalTest.on('close', resolve))
  check('审批卫生与补偿注册表随包单测全绿（node --test）', approvalTest.exitCode === 0, `exit=${approvalTest.exitCode}`)
  // ODD 域内判定纯函数自证（OPT-P2-01）
  const oddTest = spawn(process.execPath, ['packages/plugin-connector/src/odd.test.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => oddTest.on('close', resolve))
  check('ODD 域内判定随包单测全绿（node --test）', oddTest.exitCode === 0, `exit=${oddTest.exitCode}`)
  // 前端接线 grep 不变量（纯前端逻辑的静态面断言）
  const panelBoot = readFileSync(join(process.cwd(), 'packages', 'plugin-panel-core', 'public', 'js', 'boot.js'), 'utf8')
  check('面板 boot 宿主直通走根绝对 /dsh-bridge/*（带 BASE 在挂载形态会 miss → 静默失效）',
    panelBoot.includes("fetch('/dsh-bridge/status'") && !panelBoot.includes('${BASE}/dsh-bridge'))
  const consoleBoot = readFileSync(join(process.cwd(), 'packages', 'plugin-console', 'public', 'js', 'app.js'), 'utf8')
  check('控制台启动链含宿主会话直通 + 落地分诊（exchangeBridgeSession/resolveLanding）',
    consoleBoot.includes('exchangeBridgeSession') && consoleBoot.includes('resolveLanding'))
  const loginSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-console', 'public', 'js', 'pages', 'login.js'), 'utf8')
  const nextRedirectSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-console', 'public', 'js', 'next-redirect.js'), 'utf8')
  check('登录回跳接线（F 清单 P 节：消费面提升共享模块 next-redirect.js，login/app 双消费者同规则）',
    loginSrc.includes('consumeNextSources') && loginSrc.includes('exitWithNext')
    && consoleBoot.includes('exitWithNext') && consoleBoot.includes('consumeNextSources')
    && nextRedirectSrc.includes('sanitizeNext') && nextRedirectSrc.includes('sanitizeCrossOriginNext')
    && nextRedirectSrc.includes('heng_ops_next') && nextRedirectSrc.includes('heng_ops_next_cross'))
  const panelApp = readFileSync(join(process.cwd(), 'packages', 'plugin-panel-core', 'public', 'js', 'app.js'), 'utf8')
  check('面板侧切换接线（管理控制台 data-landing 偏好 + 401 引导带 ?next= 回面板）',
    panelApp.includes('data-landing') && panelApp.includes('next='))
  check('面板 IAW 架构接线（六空间导航 SPACE_META + 行业主题 data-industry + Agent 协作栏 railMode）',
    panelApp.includes('SPACE_META') && panelApp.includes('data-industry') && panelApp.includes('renderAgentRail'))
  check('面板流式应答接线（点名 streamAgent 跳隐式派发 + agent-stream 流读取 + SSE ticket 首选一次性票据）',
    panelApp.includes('streamAgent: true') && panelApp.includes('streamAgentReplies') && panelApp.includes('stream-ticket'))

  // ================================================================ 宿主服务连接切换（docs/frontend-host-switching.md）
  section('宿主服务连接切换（前端多宿主 + 数据面跨域放行）')
  // 决议纯函数（platform-core http 导出，selftest 直测）
  check('CORS 决议：* 放行任意来源', platformCore.corsAllowOriginFor(['*'], 'http://192.168.0.5:7300') === '*')
  check('CORS 决议：无 Origin（同源/curl）不放行', platformCore.corsAllowOriginFor(['*'], undefined) === undefined)
  check('CORS 决议：白名单命中精确回显', platformCore.corsAllowOriginFor(['http://a:1', 'http://b:2'], 'http://b:2') === 'http://b:2')
  check('CORS 决议：白名单未命中不发放', platformCore.corsAllowOriginFor(['http://a:1'], 'http://evil:2') === undefined)
  check('CORS 决议：空列表=关闭', platformCore.corsAllowOriginFor([], 'http://a:1') === undefined)
  check('CORS 决议：畸形 Origin 不发放', platformCore.corsAllowOriginFor(['http://a:1'], 'not-a-url') === undefined)
  // 数据面端到端（隔离实例默认 corsAllowOrigins=['*']）
  const connOrigin = 'http://192.168.0.5:7300'
  const corsPreflightApi = await rawReq('OPTIONS', '/api/health', { headers: { origin: connOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,content-type' } })
  check('API 预检 OPTIONS → 204 + allow-origin/methods/headers/max-age（先于鉴权中间件，不被 401 拦截）',
    corsPreflightApi.status === 204
    && corsPreflightApi.headers['access-control-allow-origin'] === '*'
    && String(corsPreflightApi.headers['access-control-allow-methods']).includes('POST')
    && String(corsPreflightApi.headers['access-control-allow-headers']).includes('authorization')
    && String(corsPreflightApi.headers['access-control-allow-headers']).includes('content-type')
    && corsPreflightApi.headers['access-control-max-age'] === '600')
  const corsHealth = await rawReq('GET', '/api/health', { headers: { origin: connOrigin } })
  check('公开端点跨域携带放行头（连接页测活可读）', corsHealth.status === 200 && corsHealth.headers['access-control-allow-origin'] === '*')
  const corsUnauthorized = await rawReq('GET', '/api/overview', { headers: { origin: connOrigin } })
  check('鉴权端点 401 错误体同样携带放行头（远端页面可读失败原因）',
    corsUnauthorized.status === 401 && corsUnauthorized.headers['access-control-allow-origin'] === '*')
  const corsAuthorized = await rawReq('GET', '/api/overview', { headers: { origin: connOrigin, authorization: `Bearer ${admin}` } })
  check('携带 Bearer 的跨域业务请求正常返回（宿主切换后的主链路）',
    corsAuthorized.status === 200 && jsonBody(corsAuthorized).ok === true)
  const corsNoOrigin = await rawReq('OPTIONS', '/api/health')
  check('无 Origin 的 OPTIONS 不被预检分支劫持（同源行为不变）', corsNoOrigin.status === 404 && corsNoOrigin.headers['access-control-allow-origin'] === undefined)
  // RQ 澄清第 1 条：令牌铸造/交换面 /api/auth/* 对 blanket '*' 永不发放（drive-by 凭证探测面关闭）
  const authPreflight = await rawReq('OPTIONS', '/api/auth/login', { headers: { origin: connOrigin, 'access-control-request-method': 'POST' } })
  check('CORS 收紧：/api/auth/* 预检在 blanket * 下无 ACAO（跨站登录探测被浏览器拦截）',
    authPreflight.headers['access-control-allow-origin'] === undefined, JSON.stringify(authPreflight.headers))
  const authDirect = await rawReq('GET', '/api/auth/providers', { headers: { origin: connOrigin } })
  check('CORS 收紧：/api/auth/* 直跨域响应同样不挂放行头（未进预检分支头也不发放）',
    authDirect.headers['access-control-allow-origin'] === undefined, JSON.stringify(authDirect.headers))
  // 配置具体来源列表时 /api/auth/* 按精确来源放行（远程宿主在线登录 = B 侧显式配置，零信任默认）
  {
    const preciseDir = join(DATA_DIR, 'cors-precise')
    await mkdir(preciseDir, { recursive: true })
    const preciseCtx = new Context()
    const precisePort = (await freePort()) ?? 7399
    await preciseCtx.plugin(platformCore, { dataDir: preciseDir, http: { port: precisePort, corsAllowOrigins: [connOrigin] }, startHttp: false })
    await preciseCtx.httpServer.start()
    try {
      const pBase = `http://127.0.0.1:${preciseCtx.httpServer.port}`
      const preciseAuth = await fetch(`${pBase}/api/auth/login`, { method: 'POST', headers: { origin: connOrigin, 'content-type': 'application/json' }, body: '{}' })
      check('CORS 精确来源：/api/auth/login 按白名单回显放行（显式配置即放行，跨机器部署的正确姿势）',
        preciseAuth.headers.get('access-control-allow-origin') === connOrigin, String(preciseAuth.headers.get('access-control-allow-origin')))
      const preciseEvil = await fetch(`${pBase}/api/auth/login`, { method: 'POST', headers: { origin: 'http://evil.example.com' }, body: '{}' })
      check('CORS 精确来源：未命中白名单的来源对 /api/auth/* 仍不发放', preciseEvil.headers.get('access-control-allow-origin') === null)
      // QA-01 回归（外部 QA-20261014 / 内部 G1-F1）：边缘明文口兜底下跳 + HSTS 仅安全链路下发
      const hopReq = (path, headers = {}) => new Promise((resolve, reject) => {
        const r = httpRequest({ host: '127.0.0.1', port: preciseCtx.httpServer.port, method: 'GET', path, headers }, (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
        })
        r.on('error', reject)
        r.end()
      })
      const plainHop = await hopReq('/api/health', { 'x-forwarded-proto': 'http' })
      check('QA-01 回归：明文入口（x-forwarded-proto: http）308 下跳 HTTPS 且带 Location',
        plainHop.status === 308 && String(plainHop.headers.location ?? '').startsWith('https://'),
        `${plainHop.status} ${plainHop.headers.location ?? ''}`)
      const secureHop = await hopReq('/api/health', { 'x-forwarded-proto': 'https' })
      // 该最小装配仅 platformCore（无 console 路由），404 也走 dispatch 安全头预挂——断言只看头
      check('QA-01 回归：HTTPS 反代链路下发 HSTS（max-age 一年 + 含子域）',
        String(secureHop.headers['strict-transport-security'] ?? '').includes('max-age=31536000')
        && String(secureHop.headers['strict-transport-security'] ?? '').includes('includeSubDomains'),
        `${secureHop.status} ${secureHop.headers['strict-transport-security'] ?? ''}`)
      const directHop = await hopReq('/api/health')
      check('QA-01 回归：未带转发协议头的本机直连不跳转、不下发 HSTS',
        directHop.status !== 308 && directHop.headers['strict-transport-security'] === undefined, `${directHop.status}`)
    } finally {
      await preciseCtx.httpServer.stop()
    }
  }
  // 前端接线：连接管理纯函数随包单测 + api.js 动态 BASE 不变量
  const connectionsTest = spawn(process.execPath, ['packages/plugin-console/public/js/connections.test.mjs'], { stdio: 'pipe' })
  await new Promise((resolve) => connectionsTest.on('close', resolve))
  check('连接管理纯函数随包单测全绿（node --test）', connectionsTest.exitCode === 0, `exit=${connectionsTest.exitCode}`)
  // 面板实时通道（IAW 架构，2026-10-29 统一收编）：SSE 优先 + 轮询降级的决策逻辑单列
  // realtime.js 纯函数（decideTransport/createEventStream，ES module 无 jsdom 直测面）→ 静态接线断言
  const realtimeSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-panel-core', 'public', 'js', 'realtime.js'), 'utf8')
  check('面板实时通道降级决策纯函数在列（decideTransport/createEventStream，无 WebSocket 依赖）',
    realtimeSrc.includes('export function decideTransport') && realtimeSrc.includes('export function createEventStream')
    && !realtimeSrc.includes('new WebSocket'))
  const apiSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-console', 'public', 'js', 'api.js'), 'utf8')
  check('api.js 动态 BASE + 会话按连接隔离 + 桥接直通仅本机（连接切换的三个承重点）',
    apiSrc.includes('activeConnection(localStorage, MOUNT)') && apiSrc.includes('TOKEN_NS') && apiSrc.includes('IS_LOCAL_HOST'))
  const appConnSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-console', 'public', 'js', 'app.js'), 'utf8')
  check('控制台接线：#/connections 会话前置独立渲染 + 外壳内 builders + 顶栏远程指示',
    appConnSrc.includes("page === 'connections'") && appConnSrc.includes('connections: renderConnections') && appConnSrc.includes('conn-indicator'))
  // 面板入口不再硬编码 `${BASE}/panel/`：改为「宿主连接 × 部门」登记页（#/panels），
  // 落地分诊只跳已登记且可达的面板。守两件事：NAV 指向登记页、分诊用 resolvePanels 而非裸路径。
  check('app.js：NAV 部门面板指向登记页 #/panels（不再硬编码 /panel/ 外链）',
    appConnSrc.includes("path: '#/panels'") && !appConnSrc.includes('`${BASE}/panel/`'))
  check('app.js：落地分诊按已登记面板跳转（resolvePanels + firstRegisteredPanelUrl）',
    appConnSrc.includes('firstRegisteredPanelUrl()') && appConnSrc.includes('resolvePanels(localStorage'))
  const loginPageSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-console', 'public', 'js', 'pages', 'login.js'), 'utf8')
  check('登录成功出口：面板分诊同样走登记项（无登记落 #/panels 引导，不裸跳 /panel/）',
    loginPageSrc.includes('resolvePanels(localStorage') && loginPageSrc.includes("location.hash = '#/panels'"))
  // QA-02 回归（外部 QA-20261014）：工作台 CTA 按权限渲染 + 页面级错误兜底（拒绝留白）
  const dashSrc = readFileSync(join(process.cwd(), 'packages', 'plugin-console', 'public', 'js', 'pages', 'dashboard.js'), 'utf8')
  check('QA-02 回归：工作台 CTA 按权限渲染（处理审批/查看 Agent/用量明细不再对无权角色裸露）',
    dashSrc.includes("session.can('approval.read')") && dashSrc.includes("session.can('agent.read')")
    && /\$\{isManager \? `<a href="#\/assets"/.test(dashSrc))
  check('QA-02 回归：页面 builder 全局错误兜底（首请求 403/网络失败渲染可重试错误卡而非留白）',
    appConnSrc.includes('.catch((error) => {') && appConnSrc.includes('page-retry'))

  // ================================================================ 门户数据通道（plugin-portal：外部拉取端点）

  // ================================================================ 门户数据通道（plugin-portal：外部拉取端点）
  section('门户数据通道（plugin-portal：企业门户拉取已发布应用/Agent，非核心）')
  const portalOrigin = 'http://192.168.0.4:8092'
  const portalGet = async (path, headers = {}) => rawReq('GET', `/api/portal${path}`, { headers })
  const portalJson = async (path, headers = {}) => {
    const raw = await portalGet(path, headers)
    return { status: raw.status, headers: raw.headers, body: jsonBody(raw) }
  }
  // 门户契约：纯前端无鉴权拉取——不带 Bearer 直接访问（console 鉴权中间件不得拦截门户前缀）
  const portalDiscovery = await portalJson('/', { origin: portalOrigin })
  check('公开访问 200（无 Bearer，门户前缀先于 console 鉴权中间件截获）', portalDiscovery.status === 200 && portalDiscovery.body.code === 0 && Array.isArray(portalDiscovery.body.data?.endpoints))
  const portalApps = await portalJson('/apps', { origin: portalOrigin })
  check('契约包装 {code:0, message, data} + no-cache（刷新即可见）', portalApps.status === 200 && portalApps.body.code === 0 && portalApps.body.message === 'ok' && Array.isArray(portalApps.body.data) && portalApps.headers['cache-control'] === 'no-cache')
  check('CORS 放行生产门户来源', portalApps.headers['access-control-allow-origin'] === portalOrigin)
  // 全链路：注册 → L4 审批上线 → 门户拉取即可见（miniapp 形态不走 SSO 门禁）。
  // P1-03（安全审查 2026-10-31）：匿名门户默认脱敏——公网 URL 照常透出；私网/回环 link
  // 脱敏为空串；机密级（confidential）默认不进匿名清单（PORTAL_HIDE_CONFIDENTIAL=0 可关）。
  const portalProbe = await api('POST', '/api/apps', { token: admin, body: { name: '门户拉取探针应用', attrs: { description: '门户数据通道验收：上线即对门户可见', appType: 'miniapp', url: 'https://portal-probe.example.com/', riskLevel: 'low', dataClass: 'internal' } } })
  const portalProbeReq = await api('POST', `/api/apps/${portalProbe.data.app.id}/transition`, { token: admin, body: { action: 'online' } })
  await api('POST', `/api/approvals/${portalProbeReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '门户可见性验收', confirmed: true } })
  // 私网链接探针 + 机密级探针（P1-03 负向断言夹具）
  const portalPrivate = await api('POST', '/api/apps', { token: admin, body: { name: '私网链接探针应用', attrs: { description: 'P1-03：私网 link 不进匿名清单', appType: 'miniapp', url: 'http://192.168.0.8:9000/', riskLevel: 'low', dataClass: 'internal' } } })
  const portalPrivateReq = await api('POST', `/api/apps/${portalPrivate.data.app.id}/transition`, { token: admin, body: { action: 'online' } })
  await api('POST', `/api/approvals/${portalPrivateReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: 'P1-03 验收', confirmed: true } })
  const portalConf = await api('POST', '/api/apps', { token: admin, body: { name: '机密级探针应用', attrs: { description: 'P1-03：机密级默认不出匿名门户', appType: 'miniapp', url: 'https://conf.example.com/', riskLevel: 'medium', dataClass: 'confidential' } } })
  const portalConfReq = await api('POST', `/api/apps/${portalConf.data.app.id}/transition`, { token: admin, body: { action: 'online' } })
  await api('POST', `/api/approvals/${portalConfReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: 'P1-03 验收', confirmed: true } })
  const portalAppsAfter = await portalJson('/apps', { origin: portalOrigin })
  const portalApp = portalAppsAfter.body.data.find((item) => item.id === portalProbe.data.app.id)
  check('已上线应用进入 /apps（link=访问地址，tag/version/accent 契约齐全）',
    portalApp && portalApp.name === '门户拉取探针应用' && portalApp.link === 'https://portal-probe.example.com/'
    && portalApp.tag === '小程序' && portalApp.desc === '门户数据通道验收：上线即对门户可见'
    && typeof portalApp.accent === 'string' && /^#[0-9A-Fa-f]{6}$/.test(portalApp.accent))
  check('launchDate 为上线当日（YYYY-MM-DD）', /^\d{4}-\d{2}-\d{2}$/.test(portalApp?.launchDate ?? '') && portalApp.launchDate === new Date().toISOString().slice(0, 10))
  const portalPrivateApp = portalAppsAfter.body.data.find((item) => item.id === portalPrivate.data.app.id)
  check('P1-03：私网/内网地址 link 脱敏为空（防公网访客枚举内网拓扑）',
    portalPrivateApp && portalPrivateApp.link === '', JSON.stringify(portalPrivateApp))
  const portalConfApp = portalAppsAfter.body.data.find((item) => item.id === portalConf.data.app.id)
  check('P1-03：机密级（confidential）默认不出匿名门户（默认脱敏，opt-out 显式关闭）',
    portalConfApp === undefined, JSON.stringify(portalConfApp))
  const adminApps = (await api('GET', '/api/apps', { token: admin })).data.apps
  const expectedOnline = adminApps.filter((item) => item.status === 'online' && item.attrs['dataClass'] !== 'confidential')
  check('/apps 与平台已上线应用一致（仅 online+非机密 进入门户，未上线/下架/机密不出现）',
    portalAppsAfter.body.data.length === expectedOnline.length
    && expectedOnline.every((item) => portalAppsAfter.body.data.some((entry) => entry.id === item.id)))
  const portalEmployees = await portalJson('/employees', { origin: 'http://192.168.0.8:8443' })
  check('/employees：已上线 Agent=数字员工（内网 :8443 开发来源 CORS 同样放行）',
    portalEmployees.status === 200 && portalEmployees.headers['access-control-allow-origin'] === 'http://192.168.0.8:8443'
    && Array.isArray(portalEmployees.body.data) && portalEmployees.body.data.some((item) => item.id === targetAgent.id && item.avatar && typeof item.skills === 'string'))
  const portalSkills = await portalJson('/skills')
  check('/skills：已上架 Skill 契约（downloadUrl 为门户登录下载端点绝对地址）',
    portalSkills.status === 200 && Array.isArray(portalSkills.body.data) && portalSkills.body.data.length >= 1
    && portalSkills.body.data.every((item) => /^https?:\/\/.+\/api\/portal\/skills\/.+\/download$/.test(item.downloadUrl)))
  const portalSkillDl = await rawReq('GET', new URL(portalSkills.body.data[0].downloadUrl).pathname)
  check('downloadUrl 未登录被拒 401 契约错误（v1.1：必须登录）',
    portalSkillDl.status === 401 && portalSkillDl.headers['content-type'].includes('json') && jsonBody(portalSkillDl).code === 40100, JSON.stringify({ status: portalSkillDl.status }))
  const portalSkillDlBad = await rawReq('GET', new URL(portalSkills.body.data[0].downloadUrl).pathname, { headers: { authorization: 'Bearer dst1_forged_token' } })
  check('无效令牌下载被拒 401（不泄露技能存在性）', portalSkillDlBad.status === 401 && jsonBody(portalSkillDlBad).code === 40100)
  const portalSkillDlAuth = await rawReq('GET', new URL(portalSkills.body.data[0].downloadUrl).pathname, { headers: { authorization: `Bearer ${admin}` } })
  check('携带登录令牌可下载（200 + zip 魔数 PK + attachment 头）',
    portalSkillDlAuth.status === 200 && String(portalSkillDlAuth.headers['content-type']).includes('zip')
    && portalSkillDlAuth.body.startsWith('PK') && String(portalSkillDlAuth.headers['content-disposition']).includes('attachment'), JSON.stringify({ status: portalSkillDlAuth.status, type: portalSkillDlAuth.headers['content-type'] }))
  const portalDlUnknownAuth = await rawReq('GET', '/api/portal/skills/skl_not_exist/download', { headers: { authorization: `Bearer ${admin}` } })
  check('未上架/未知技能下载 404 契约错误（登录后）', portalDlUnknownAuth.status === 404 && jsonBody(portalDlUnknownAuth).code === 40400)
  const portalDownloadAudit = (await api('GET', '/api/audit/logs?action=portal.skill.download&limit=5', { token: admin })).data?.items ?? []
  check('下载审计落账（谁在下载：actor=登录用户）', Array.isArray(portalDownloadAudit) && portalDownloadAudit.some((item) => item.actorId && item.actorId !== 'portal-feed' && String(item.detail ?? '').includes('via=')), JSON.stringify(portalDownloadAudit?.[0] ?? {}))
  const portalStats = await portalJson('/stats', { origin: portalOrigin })
  check('/stats：恰 4 卡且 value 为字符串（契约明确非数值）', portalStats.body.data.length === 4 && portalStats.body.data.every((item) => typeof item.value === 'string' && item.unit !== undefined && item.label !== undefined))
  check('/stats 口径：已上线应用计数与 /apps 一致', Number(portalStats.body.data[0].value) === portalAppsAfter.body.data.length)
  const portalSolutions = await portalJson('/solutions')
  const portalTools = await portalJson('/tools')
  check('/solutions、/tools：暂无数据源 → 空数组（门户契约 §5：降级展示内置样板）', portalSolutions.body.data?.length === 0 && portalTools.body.data?.length === 0)
  const portalPreflight = await rawReq('OPTIONS', '/api/portal/apps', { headers: { origin: portalOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization, content-type' } })
  check('OPTIONS 预检 204 + 放行方法/来源/authorization 请求头', portalPreflight.status === 204 && portalPreflight.headers['access-control-allow-origin'] === portalOrigin && String(portalPreflight.headers['access-control-allow-methods']).includes('GET') && String(portalPreflight.headers['access-control-allow-headers']).includes('authorization'))
  const portalUnknown = await portalJson('/nope', { origin: portalOrigin })
  check('未知端点 404 契约错误（门户展示错误与重试，不影响其他端点）', portalUnknown.status === 404 && portalUnknown.body.code === 40400)
  const portalNoOrigin = await portalGet('/stats')
  check('无 Origin 请求正常应答（仅不回 CORS 放行头）', portalNoOrigin.status === 200 && !portalNoOrigin.headers['access-control-allow-origin'])
  const portalPost = await rawReq('POST', '/api/portal/apps', { headers: { 'content-type': 'application/json', origin: portalOrigin }, body: '{}' })
  check('写方法被拒 405（契约全只读）', portalPost.status === 405)

  // ================================================================ 收尾终检：凭证零进平台（红线一，T-24）
  section('部门面板（plugin-panel-core：数据面 / 图谱 / 激活 / 计量 / 运行时）')
  {
    const panelAdmin = admin
    const rootOrgId = (await api('GET', '/api/iam/orgs', { token: panelAdmin })).data.find((org) => org.parentId === null).id

    // -- 部门骨架与总览 ------------------------------------------------------
    const depts = await api('GET', '/api/panel/depts', { token: panelAdmin })
    check('面板：五部门骨架（一套骨架五种皮肤的数据底座）',
      depts.ok && depts.data.depts.length === 5 && depts.data.depts.some((dept) => dept.id === 'mfg' && dept.colors?.accent === '#0f766e'),
      JSON.stringify(depts.data?.depts?.map((dept) => dept.id)))
    const overview = await api('GET', '/api/panel/mfg/overview', { token: panelAdmin })
    check('面板：制造部总览（行业激活 + 频道 + 阵容 + KPI/widget 来源徽标）',
      overview.ok && overview.data.industry?.code === 'qb01' && overview.data.channels.length >= 3
      && overview.data.agents.length === 4 && overview.data.kpis.length >= 3
      && overview.data.widgets.length >= 3 && overview.data.widgets.every((widget) => !widget.degraded && widget.source === '模拟数据'),
      JSON.stringify({ industry: overview.data?.industry, widgets: overview.data?.widgets?.length }))
    const overviewNoAuth = await api('GET', '/api/panel/mfg/overview')
    check('面板：未认证访问被拒（401）', overviewNoAuth.status === 401)

    // -- 消息闭环：发消息 / 卡片动作走纯平台链（task.create + 幂等） ----------------
    const channels = await api('GET', '/api/panel/mfg/channels', { token: panelAdmin })
    const mainChannel = channels.data.channels[0]
    const posted = await api('POST', '/api/panel/mfg/messages', { token: panelAdmin, body: { channelId: mainChannel.id, text: '自测：协作消息链路', ddSync: false } })
    check('面板：发消息落库（人 × 频道归属校验）', posted.ok && posted.data.message.dept === 'mfg')
    const msgList = await api('GET', `/api/panel/mfg/messages?channelId=${mainChannel.id}`, { token: panelAdmin })
    const cardMsg = msgList.data.messages.find((m) => m.card?.title?.includes('WX-0912'))
    check('面板：演示卡片消息在库（Agent 操作卡片）', Boolean(cardMsg) && cardMsg.card.ops.length === 3)
    const cardAct = await api('POST', `/api/panel/messages/${cardMsg.id}/card-action`, { token: panelAdmin, body: { opId: cardMsg.card.ops[0].id } })
    check('面板：卡片动作「确认派单」→ 生成任务（纯平台链）',
      cardAct.ok && /已生成任务/.test(cardAct.data.result), JSON.stringify(cardAct.data?.result ?? cardAct.error))
    const cardActReplay = await api('POST', `/api/panel/messages/${cardMsg.id}/card-action`, { token: panelAdmin, body: { opId: cardMsg.card.ops[0].id } })
    check('面板：卡片动作幂等保护（重复执行被拒）', !cardActReplay.ok && /已执行/.test(cardActReplay.error.message))

    // -- 任务看板（泳道状态机） ------------------------------------------------
    const taskCreated = await api('POST', '/api/panel/mfg/tasks', { token: panelAdmin, body: { title: '自测任务：M-2207 缺口复勘', lane: 'doing', sceneCode: 'QB01-G-4-1' } })
    check('面板：任务创建（泳道 + 场景引用）', taskCreated.ok && taskCreated.data.task.lane === 'doing')
    const taskMoved = await api('POST', `/api/panel/tasks/${taskCreated.data.task.id}/transition`, { token: panelAdmin, body: { lane: 'done' } })
    check('面板：任务泳道迁移（doing → done）', taskMoved.ok && taskMoved.data.task.lane === 'done')
    const badLane = await api('POST', `/api/panel/tasks/${taskCreated.data.task.id}/transition`, { token: panelAdmin, body: { lane: 'archived' } })
    check('面板：非法泳道被拒', !badLane.ok)

    // -- 泳道乐观并发锁（UXQA-R1-002 根治，2026-11-02）：并发双写不再静默覆盖 ----
    // 契约三面：① 携带正确期望泳道 → 正常流转；② 携带过期期望泳道（并发输家视角）→ 409
    // VERSION_CONFLICT + 权威泳道文案（不写库）；③ 不带期望泳道 → 原直通语义（Agent 工具桥向后兼容）。
    const optTask = await api('POST', '/api/panel/mfg/tasks', { token: panelAdmin, body: { title: '自测任务：乐观锁并发演练', lane: 'todo' } })
    check('乐观锁前置：演练任务就绪（todo）', optTask.ok && optTask.data.task.lane === 'todo')
    const optMove1 = await api('POST', `/api/panel/tasks/${optTask.data.task.id}/transition`, { token: panelAdmin, body: { lane: 'doing', expectedLane: 'todo' } })
    check('乐观锁：期望泳道命中（todo→doing）正常流转', optMove1.ok && optMove1.data.task.lane === 'doing', JSON.stringify(optMove1.error))
    const optConflict = await api('POST', `/api/panel/tasks/${optTask.data.task.id}/transition`, { token: panelAdmin, body: { lane: 'review', expectedLane: 'todo' } })
    check('乐观锁：过期期望泳道 409 VERSION_CONFLICT（并发输家收明确回执，不再静默覆盖）',
      optConflict.status === 409 && optConflict.error?.code === 'VERSION_CONFLICT' && /已被他人流转/.test(optConflict.error?.message ?? ''),
      JSON.stringify({ status: optConflict.status, error: optConflict.error }))
    const optAfterConflict = await api('GET', `/api/panel/mfg/tasks`, { token: panelAdmin })
    const optCurrent = (optAfterConflict.data?.tasks ?? []).find((task) => task.id === optTask.data.task.id)
    check('乐观锁：409 不写库——权威泳道保持 doing（赢家动作零丢失）', optCurrent?.lane === 'doing', JSON.stringify({ lane: optCurrent?.lane }))
    const optLegacy = await api('POST', `/api/panel/tasks/${optTask.data.task.id}/transition`, { token: panelAdmin, body: { lane: 'review' } })
    check('乐观锁：未携带期望泳道保持直通（工具桥向后兼容，doing→review）', optLegacy.ok && optLegacy.data.task.lane === 'review', JSON.stringify(optLegacy.error))

    // -- 执行中枢投影（DSH issue#3/#4 修订，2026-10-29）：面板=exec-hub 投影，不复制权威状态 ----
    // 目标读透 / 泳道迁移镜像 / 验收裁决回写（唯一任务事实源红线）
    const execGoal = await api('POST', '/api/exec/goals', { token: panelAdmin, body: { title: '自测目标：面板投影连通', metric: '一次装机合格率', metricBaseline: 88, metricTarget: 95, metricUnit: '%' } })
    const execIssue = await api('POST', '/api/exec/issues', { token: panelAdmin, body: { title: '自测执行任务：M-2207 缺口复勘投影', priority: 'P1' } })
    check('面板投影前置：执行中枢目标/任务就绪', execGoal.ok && execIssue.ok, JSON.stringify({ goal: execGoal.error, issue: execIssue.error }))
    const linkedTask = await api('POST', '/api/panel/mfg/tasks', { token: panelAdmin, body: { title: '自测投影任务（血缘 exec）', lane: 'todo', execIssueId: execIssue.data.id, goalId: execGoal.data.id, evidenceRefs: ['audit:selftest-evidence-1'] } })
    check('面板投影：任务携带执行中枢血缘创建（execIssueId 命中 exec:issues）',
      linkedTask.ok && linkedTask.data.task.execIssueId === execIssue.data.id && linkedTask.data.task.goalId === execGoal.data.id
      && Array.isArray(linkedTask.data.task.evidenceRefs), JSON.stringify(linkedTask.error ?? linkedTask.data?.task))
    const linkedBogus = await api('POST', '/api/panel/mfg/tasks', { token: panelAdmin, body: { title: '血缘不存在应被拒', execIssueId: 'exec-no-such-issue' } })
    check('面板投影：execIssueId 不存在诚实 400（不复制权威状态）', linkedBogus.status === 400, JSON.stringify(linkedBogus.error))
    const goalsProj = await api('GET', '/api/panel/mfg/goals', { token: panelAdmin })
    const projGoal = (goalsProj.data?.goals ?? []).find((goal) => goal.id === execGoal.data.id)
    const projIssue = (goalsProj.data?.issues ?? []).find((issue) => issue.id === execIssue.data.id)
    check('面板投影：goals 读透 exec-hub（目标 metric 基线/目标值 + 任务血缘 + 面板关联 ID）',
      goalsProj.ok && Boolean(projGoal) && projGoal.metricTarget === 95 && Boolean(projIssue)
      && (projIssue.panelTaskIds ?? []).includes(linkedTask.data.task.id)
      && Array.isArray(projIssue.goalAncestry), JSON.stringify({ goals: goalsProj.data?.goals?.length, issues: goalsProj.data?.issues?.length }))
    const mirrorMove = await api('POST', `/api/panel/tasks/${linkedTask.data.task.id}/transition`, { token: panelAdmin, body: { lane: 'doing' } })
    const issueAfterMove = (await api('GET', '/api/exec/issues', { token: panelAdmin })).data.issues.find((issue) => issue.id === execIssue.data.id)
    check('面板投影：泳道迁移镜像回写 exec-hub（doing → in_progress，唯一事实源）',
      mirrorMove.ok && issueAfterMove?.status === 'in_progress', JSON.stringify({ mirror: mirrorMove.ok, exec: issueAfterMove?.status }))
    // exec 状态机 in_progress→done 不直达：先推进面板泳道到 review（镜像 exec review），再签认关闭
    const mirrorReview = await api('POST', `/api/panel/tasks/${linkedTask.data.task.id}/transition`, { token: panelAdmin, body: { lane: 'review' } })
    const issueAtReview = (await api('GET', '/api/exec/issues', { token: panelAdmin })).data.issues.find((issue) => issue.id === execIssue.data.id)
    check('面板投影：泳道迁移镜像 review（exec 同步待审）', mirrorReview.ok && issueAtReview?.status === 'review', JSON.stringify(issueAtReview?.status))
    const verdictOk = await api('POST', `/api/panel/tasks/${linkedTask.data.task.id}/verdict`, { token: panelAdmin, body: { verdict: 'accepted', opinion: '自测签认：证据齐全' } })
    const issueAfterVerdict = (await api('GET', '/api/exec/issues', { token: panelAdmin })).data.issues.find((issue) => issue.id === execIssue.data.id)
    check('面板投影：签认关闭镜像回写（task.verdict=accepted + exec → done）',
      verdictOk.ok && verdictOk.data.task.verdict === 'accepted' && issueAfterVerdict?.status === 'done',
      JSON.stringify({ verdict: verdictOk.error ?? verdictOk.data?.task?.verdict, exec: issueAfterVerdict?.status }))
    const verdictReplay = await api('POST', `/api/panel/tasks/${linkedTask.data.task.id}/verdict`, { token: panelAdmin, body: { verdict: 'rework' } })
    check('面板投影：重复裁决被拒（结论不可变更，对账走 audit）', verdictReplay.status === 400 && /不可重复裁决/.test(verdictReplay.error?.message ?? ''), JSON.stringify(verdictReplay.error))
    const reworkIssue = await api('POST', '/api/exec/issues', { token: panelAdmin, body: { title: '自测返工任务：验收打回重开', priority: 'P2' } })
    const reworkTask = await api('POST', '/api/panel/mfg/tasks', { token: panelAdmin, body: { title: '自测返工投影任务', execIssueId: reworkIssue.data.id } })
    await api('POST', `/api/panel/tasks/${reworkTask.data.task.id}/transition`, { token: panelAdmin, body: { lane: 'review' } })
    await api('POST', `/api/panel/tasks/${reworkTask.data.task.id}/transition`, { token: panelAdmin, body: { lane: 'doing' } })
    const verdictRework = await api('POST', `/api/panel/tasks/${reworkTask.data.task.id}/verdict`, { token: panelAdmin, body: { verdict: 'rework', opinion: '自测打回：口径需修正' } })
    const issueAfterRework = (await api('GET', '/api/exec/issues', { token: panelAdmin })).data.issues.find((issue) => issue.id === reworkIssue.data.id)
    check('面板投影：打回返工镜像回写（exec 任务重开 in_progress）',
      verdictRework.ok && verdictRework.data.task.verdict === 'rework' && issueAfterRework?.status === 'in_progress',
      JSON.stringify({ verdict: verdictRework.error ?? verdictRework.data?.task?.verdict, exec: issueAfterRework?.status }))
    // 投影自测实体清理（exec-hub 节的目标树清空断言依赖；先删任务再删目标）
    await api('DELETE', `/api/exec/issues/${reworkIssue.data.id}`, { token: panelAdmin })
    await api('DELETE', `/api/exec/issues/${execIssue.data.id}`, { token: panelAdmin })
    await api('DELETE', `/api/exec/goals/${execGoal.data.id}`, { token: panelAdmin })

    // -- 部门知识 ---------------------------------------------------------------
    const artCreated = await api('POST', '/api/panel/mfg/artifacts', { token: panelAdmin, body: { kind: 'diagnosis', title: '自测诊断卡', content: '四清单框架自测沉淀' } })
    const artList = await api('GET', '/api/panel/mfg/artifacts', { token: panelAdmin })
    check('面板：部门知识沉淀与列表', artCreated.ok && artList.ok && artList.data.artifacts.some((art) => art.title === '自测诊断卡'))

    // -- 场景图谱：装载 / 未激活拒绝 ----------------------------------------------
    const graph = await api('GET', '/api/panel/scenegraph?industry=QB01', { token: panelAdmin })
    const qb01SceneCount = Object.values(graph.data?.pack?.activities ?? {}).reduce((sum, list) => sum + list.length, 0)
    check('面板：QB01 场景图谱下发（一图四清单全字段）',
      graph.ok && qb01SceneCount >= 24 && graph.data.pack.activities.mfg.every((scene) => scene.tools.length > 0 && scene.models.length > 0 && scene.data.length > 0 && scene.talent.length > 0),
      `scenes=${qb01SceneCount}`)
    const graphLocked = await api('GET', '/api/panel/scenegraph?industry=JQR', { token: panelAdmin })
    check('面板：未装载图谱 honest 400（不冒充数据）', !graphLocked.ok && /未装载/.test(graphLocked.error.message))

    // -- 行业三态 + 激活审批链（申请 → 审批（高风险二次确认）→ 激活生效） -------------
    const industries = await api('GET', '/api/panel/industries', { token: panelAdmin })
    // 2026-10-29 面板架构统一（IAW 14 行业登记）：QB01/YB01/JB01 图谱包随平台分发默认激活，
    // 其余 11 行业走「申请 → 审批（industry.activation · high）→ 激活」链路
    check('面板：行业三态（14 行业全量登记；QB01/YB01/JB01 内置已激活，其余 11 行业待授权）',
      industries.ok
      && industries.data.industries.length === 14
      && industries.data.industries.filter((ind) => ind.state === 'active').map((ind) => ind.code).sort().join(',') === 'JB01,QB01,YB01'
      && industries.data.industries.filter((ind) => ind.state === 'locked').length === 11,
      JSON.stringify(industries.data?.industries?.map((ind) => `${ind.code}:${ind.state}`)))
    const actReq = await api('POST', '/api/panel/industries/SJ02/activate-requests', { token: panelAdmin })
    check('面板：激活申请进入审批中心（industry.activation · high）',
      actReq.ok && actReq.data.approval.kind === 'industry.activation',
      JSON.stringify(actReq.error ?? actReq.data?.approval?.id))
    const actPending = (await api('GET', '/api/panel/industries', { token: panelAdmin })).data.industries.find((ind) => ind.code === 'SJ02')
    check('面板：申请后行业显示审批中（pending 三态）', actPending.state === 'pending')
    const decideOk = await api('POST', `/api/approvals/${actReq.data.approval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: '印制板行业图谱启用', confirmed: true } })
    check('面板：审批通过 → 激活执行器生效（active + grantCapabilities）',
      decideOk.ok && decideOk.data.status === 'executed', JSON.stringify(decideOk.data?.execution ?? decideOk.error))
    const industriesAfter = await api('GET', '/api/panel/industries', { token: panelAdmin })
    check('面板：激活后 SJ02 三态转 active', industriesAfter.data.industries.find((ind) => ind.code === 'SJ02').state === 'active')
    const dupActivate = await api('POST', '/api/panel/industries/SJ02/activate-requests', { token: panelAdmin })
    check('面板：重复激活申请被拒（已是激活态）', !dupActivate.ok && /已是激活态/.test(dupActivate.error.message))
    // 交互连通性（激活 → 图谱可读闭环）：激活后的行业场景图谱随即可下发（一图四清单）
    const graphActivated = await api('GET', '/api/panel/scenegraph?industry=SJ02', { token: panelAdmin })
    const sj02Scenes = Object.values(graphActivated.data?.pack?.activities ?? {}).reduce((sum, list) => sum + list.length, 0)
    check('面板：激活后行业图谱即时可读（SJ02 一图四清单下发，base scenegraphs ↔ panel 连通）',
      graphActivated.ok && sj02Scenes > 0 && graphActivated.data.pack.code === 'SJ02', `scenes=${sj02Scenes}`)

    // -- panelAgentRuntime：诚实降级 + 真实模型调用 + panel:* 计量（D1 键格式） -------
    const mentionFallback = await api('POST', '/api/panel/mfg/messages', { token: panelAdmin, body: { channelId: mainChannel.id, text: '@设备运维 Agent 自测：请巡检 3# 冲床', ddSync: false } })
    await new Promise((resolve) => setTimeout(resolve, 600))
    const afterFallback = await api('GET', `/api/panel/mfg/messages?channelId=${mainChannel.id}&limit=10`, { token: panelAdmin })
    const fallbackReply = afterFallback.data.messages.find((m) => m.agentName === '设备运维 Agent' && /暂不能自主应答/.test(m.text))
    check('面板：@Agent 未绑定资产 → 诚实降级回包（不造假回复）', Boolean(fallbackReply), JSON.stringify(afterFallback.data?.messages?.at(-1)?.text ?? '').slice(0, 120))
    const fallbackTasks = await api('GET', '/api/panel/mfg/tasks', { token: panelAdmin })
    check('面板：降级转人工待办落看板', fallbackTasks.ok && fallbackTasks.data.tasks.some((task) => task.createdBy.startsWith('agent:') && task.lane === 'todo'))

    // stub 模型 + Agent 资产 + 阵容绑定 → 真实单轮调用
    const panelModelStub = createServer((req, res) => {
      if ((req.url ?? '').endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '质检结论：一次装机合格率 93.2%（±0.4pp），无异常波动。' } }], usage: { prompt_tokens: 100, completion_tokens: 40 } }))
        return
      }
      res.writeHead(404).end('{}')
    })
    await new Promise((resolve) => panelModelStub.listen(0, '127.0.0.1', resolve))
    try {
      // agent 资产的 model 属性受资源 schema 枚举约束（deepseek-*），故覆盖登记 deepseek-chat 指向 stub
      const modelReg = await api('POST', '/api/modelgw/models', { token: panelAdmin, body: { slug: 'deepseek-chat', displayName: 'DeepSeek Chat（面板自测 stub）', provider: 'deepseek', endpoint: `http://127.0.0.1:${panelModelStub.address().port}/v1`, apiKey: 'stub-key', listCentsPerKTokens: 1, costCentsPerKTokens: 0 } })
      const agentAsset = await api('POST', '/api/agents', { token: panelAdmin, body: { name: '面板质检员', slug: 'panel-qc', attrs: { description: '部门面板质检数字同事（自测）', avatar: '🔍', model: 'deepseek-chat', systemPrompt: '你是制造部质检数字同事。', riskLevel: 'low', dataClass: 'internal' } } })
      check('面板：stub 模型 + Agent 资产就绪', modelReg.ok && agentAsset.ok, JSON.stringify({ modelReg: modelReg.error, agent: agentAsset.error }))
      const roster = await api('PUT', '/api/panel/mfg/agents', { token: panelAdmin, body: { agents: [
        { name: '排产优化 Agent', desc: 'APS 齐套排产 / 插单重排', icon: '📅' },
        { name: '设备运维 Agent', desc: '点检提醒 / 故障预判 / 维修工单', icon: '⚙️' },
        { name: '面板质检员', desc: 'SPC 监控 / 合格率追溯', icon: '🔍', agentRef: `agent:${agentAsset.data.agent?.slug ?? agentAsset.data.agent?.id ?? 'panel-qc'}` },
      ] } })
      check('面板：阵容绑定 agentRef（panel.config.write）', roster.ok, JSON.stringify(roster.error))
      const mentionReal = await api('POST', '/api/panel/mfg/messages', { token: panelAdmin, body: { channelId: mainChannel.id, text: '@面板质检员 今天一次装机合格率有波动吗？', ddSync: false } })
      check('面板：@面板质检员 消息已发', mentionReal.ok)
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const afterReal = await api('GET', `/api/panel/mfg/messages?channelId=${mainChannel.id}&limit=10`, { token: panelAdmin })
      const realReply = afterReal.data.messages.find((m) => m.agentName === '面板质检员')
      check('面板：panelAgentRuntime 单轮真实调用（modelgw → 回包落库）',
        Boolean(realReply) && /一次装机合格率 93.2%/.test(realReply.text),
        JSON.stringify(realReply?.text ?? afterReal.data?.messages?.at(-1)?.text ?? '').slice(0, 160))
      const recentUsage = await api('GET', '/api/usage/events?resource=' + encodeURIComponent('panel:mfg.qb01') + '&limit=50', { token: panelAdmin })
      check('面板：协作计量落账（D1 键格式 panel:mfg.qb01，价格簿零费率放行）',
        recentUsage.ok && recentUsage.data.items.some((item) => item.resource === 'panel:mfg.qb01'),
        JSON.stringify(recentUsage.data?.items?.map((item) => item.resource)))

      // -- 面板模型目录面（与 dsh 服务共用 modelgw 唯一事实源）+ 对话框模型切换 -----------
      const panelModelsList = await api('GET', '/api/panel/models', { token: panelAdmin })
      check('面板：模型目录读取（GET /api/panel/models，直填 apiKey 脱敏不回显）',
        panelModelsList.ok && panelModelsList.data.models.some((item) => item.slug === 'deepseek-chat')
        && !JSON.stringify(panelModelsList.data).includes('stub-key'),
        JSON.stringify(panelModelsList.error ?? panelModelsList.data?.models?.map((item) => item.slug)))
      const panelModelUpsert = await api('POST', '/api/panel/models', { token: panelAdmin, body: { slug: 'qwen-plus', displayName: 'Qwen Plus（面板登记）', provider: 'aliyun', endpoint: `http://127.0.0.1:${panelModelStub.address().port}/v1`, apiKey: 'panel-stub-key', listCentsPerKTokens: 2, costCentsPerKTokens: 1 } })
      check('面板：模型登记 upsert（POST /api/panel/models，panel.config.write；回显脱敏）',
        panelModelUpsert.ok && panelModelUpsert.data.slug === 'qwen-plus' && panelModelUpsert.data.apiKey === '***',
        JSON.stringify(panelModelUpsert.error ?? panelModelUpsert.data?.apiKey))
      const panelModelKeepKey = await api('POST', '/api/panel/models', { token: panelAdmin, body: { slug: 'qwen-plus', displayName: 'Qwen Plus（面板登记·改）', endpoint: `http://127.0.0.1:${panelModelStub.address().port}/v1`, listCentsPerKTokens: 2 } })
      check('面板：编辑模型留空 apiKey 保持既有密钥（不被默认 env 引用覆盖）',
        panelModelKeepKey.ok && panelModelKeepKey.data.displayName === 'Qwen Plus（面板登记·改）', JSON.stringify(panelModelKeepKey.error))
      const panelModelTest = await api('POST', '/api/panel/models/qwen-plus/test', { token: panelAdmin })
      check('面板：模型连通性测试（真实走 modelgw.invoke 全链，失败如实回传不造假成功）',
        panelModelTest.ok && panelModelTest.data.ok === true && panelModelTest.data.content.length > 0,
        JSON.stringify(panelModelTest.data ?? panelModelTest.error))
      const switchMsg = await api('POST', '/api/panel/mfg/messages', { token: panelAdmin, body: { channelId: mainChannel.id, text: '@面板质检员 切换模型后再答一次：合格率波动结论？', model: 'qwen-plus', ddSync: false } })
      check('面板：对话框指定模型发送（POST messages 带 model）', switchMsg.ok, JSON.stringify(switchMsg.error))
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const afterSwitch = await api('GET', `/api/panel/mfg/messages?channelId=${mainChannel.id}&limit=10`, { token: panelAdmin })
      const switchReply = afterSwitch.data.messages.find((m) => m.agentName === '面板质检员' && m.model === 'qwen-plus')
      check('面板：对话框模型切换生效（modelOverride 优先于资产 model，回包记录实际所用模型）', Boolean(switchReply),
        JSON.stringify(afterSwitch.data?.messages?.filter((m) => m.agentName)?.map((m) => ({ t: String(m.text).slice(0, 30), model: m.model }))))

      // -- Agent 流式应答（SSE-over-POST，DeptAI-UI-DSH 收编 2026-10-29） ----------------
      // streamAgent:true 跳过隐式派发（防双跑），由流式端点驱动应答；完成后照常落库广播。
      const streamMsg = await api('POST', '/api/panel/mfg/messages', { token: panelAdmin, body: { channelId: mainChannel.id, text: '@面板质检员 流式自测：给一句合格率结论', ddSync: false, streamAgent: true } })
      check('面板流式：streamAgent=true 消息发送（落库拿 messageId）', streamMsg.ok && Boolean(streamMsg.data.message?.id), JSON.stringify(streamMsg.error))
      await new Promise((resolve) => setTimeout(resolve, 600))
      const beforeStream = await api('GET', `/api/panel/mfg/messages?channelId=${mainChannel.id}&limit=30`, { token: panelAdmin })
      check('面板流式：隐式派发被跳过（流式端点驱动前无 Agent 应答）',
        !beforeStream.data.messages.some((m) => m.agentName === '面板质检员' && String(m.createdAt ?? '') > String(streamMsg.data.message.createdAt ?? '')),
        JSON.stringify(beforeStream.data?.messages?.filter((m) => m.agentName)?.slice(-2)?.map((m) => ({ at: m.createdAt, t: String(m.text).slice(0, 24) }))))
      const streamRaw = await rawReq('POST', '/api/panel/mfg/agent-stream', {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${panelAdmin}` },
        body: JSON.stringify({ messageId: streamMsg.data.message.id }),
      })
      const streamEvents = streamRaw.body.split(/\r?\n/).filter((line) => line.startsWith('data: ')).map((line) => { try { return JSON.parse(line.slice(6)) } catch { return {} } })
      check('面板流式：SSE 事件链 start→delta→done→end（200 event-stream）',
        streamRaw.status === 200 && String(streamRaw.headers['content-type']).includes('text/event-stream')
        && streamEvents.some((event) => event.type === 'start' && event.agent === '面板质检员')
        && streamEvents.some((event) => event.type === 'delta' && /质检结论/.test(String(event.text)))
        && streamEvents.some((event) => event.type === 'done')
        && streamEvents.at(-1)?.type === 'end',
        JSON.stringify(streamEvents).slice(0, 200))
      const afterStreamReply = await api('GET', `/api/panel/mfg/messages?channelId=${mainChannel.id}&limit=30`, { token: panelAdmin })
      const streamedReply = afterStreamReply.data.messages.find((m) => m.agentName === '面板质检员' && String(m.createdAt ?? '') > String(streamMsg.data.message.createdAt ?? ''))
      check('面板流式：应答落库并标注实际模型（其他端经既有 SSE 收到持久消息）',
        Boolean(streamedReply) && streamedReply.model === 'deepseek-chat' && /质检结论/.test(streamedReply.text),
        JSON.stringify(streamedReply ?? afterStreamReply.data?.messages?.at(-1)).slice(0, 160))
      const streamMeter = await api('GET', '/api/usage/events?resource=' + encodeURIComponent('panel:mfg.qb01') + '&limit=50', { token: panelAdmin })
      check('面板流式：协作计量幂等（D1 键 panel:agent:<msgId>:<agent> 同键不双计）',
        streamMeter.ok && streamMeter.data.items.filter((item) => item.idempotency_key === `panel:agent:${streamMsg.data.message.id}:面板质检员`).length === 1,
        JSON.stringify(streamMeter.data?.items?.filter((item) => String(item.idempotency_key).startsWith('panel:agent:'))?.map((item) => item.idempotency_key)))
      const streamNoMention = await api('POST', '/api/panel/mfg/messages', { token: panelAdmin, body: { channelId: mainChannel.id, text: '流式自测：不点名任何数字同事', ddSync: false, streamAgent: true } })
      const streamNoMentionRaw = await rawReq('POST', '/api/panel/mfg/agent-stream', {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${panelAdmin}` },
        body: JSON.stringify({ messageId: streamNoMention.data.message.id }),
      })
      check('面板流式：未点名数字同事 → end 事件诚实收尾（不造假应答）',
        streamNoMentionRaw.status === 200 && /"type":"end".*未点名/.test(streamNoMentionRaw.body), streamNoMentionRaw.body.slice(0, 120))
      const streamWrongDept = await rawReq('POST', '/api/panel/rd/agent-stream', {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${panelAdmin}` },
        body: JSON.stringify({ messageId: streamMsg.data.message.id }),
      })
      check('面板流式：跨部门 messageId 被拒（400，部门范围校验同规）',
        streamWrongDept.status === 400 && /消息不存在或不属于该部门/.test(streamWrongDept.body), streamWrongDept.body.slice(0, 120))
      const badModelMsg = await api('POST', '/api/panel/mfg/messages', { token: panelAdmin, body: { channelId: mainChannel.id, text: '未登记模型应被拒', model: 'no-such-model', ddSync: false } })
      check('面板：对话框指定未登记模型被拒（400，诚实报错）', badModelMsg.status === 400, JSON.stringify(badModelMsg.error))
      const panelModelDel = await api('DELETE', `/api/panel/models/${panelModelUpsert.data.id}`, { token: panelAdmin })
      check('面板：模型删除（DELETE /api/panel/models/:id，登记移除后目录不含）',
        panelModelDel.ok && panelModelDel.data.deleted === true
        && !(await api('GET', '/api/panel/models', { token: panelAdmin })).data.models.some((item) => item.slug === 'qwen-plus'),
        JSON.stringify(panelModelDel.error))
    } finally {
      panelModelStub.close()
    }

    // -- widget 求值：connector 源诚实降级 + 配置抽屉 ------------------------------
    const widgetsPut = await api('PUT', '/api/panel/mfg/widgets', { token: panelAdmin, body: { widgets: [
      { id: 'w1', type: 'bars', title: '📊 产线实时状态', live: true, source: 'mock', rows: [['冲压一线', 92, '']] },
      { id: 'w2', type: 'bars', title: '📈 设备联网率（ERP）', source: 'connector', ref: 'erp.oee-line', rows: [] },
    ] } })
    check('面板：widget 布局写入（含来源徽标声明）', widgetsPut.ok && widgetsPut.data.widgets.length === 2)
    const boardAfter = await api('GET', '/api/panel/mfg/board', { token: panelAdmin })
    const degradedWidget = boardAfter.data.widgets.find((widget) => widget.id === 'w2')
    check('面板：connector 源 widget 显式降级（绝不冒充真实业务面）',
      Boolean(degradedWidget) && degradedWidget.degraded === true && /连接器/.test(degradedWidget.source),
      JSON.stringify(degradedWidget))
    const widgetsRestore = await api('PUT', '/api/panel/mfg/widgets', { token: panelAdmin, body: { widgets: [
      { id: 'w1', type: 'bars', title: '📊 产线实时状态', live: true, source: 'mock', rows: [['冲压一线', 92, ''], ['组装二线', 76, 'warn'], ['包装三线 · 换型中', 41, 'danger']] },
      { id: 'w2', type: 'alerts', title: '🚨 异常告警', source: 'mock', rows: [['r', '停机', '冲压一线 3# 冲床油温过高，已待机 12 分钟'], ['y', '缺料', '组装二线 M-2207 物料 16:00 后缺口 800pcs']] },
      { id: 'w3', type: 'todos', title: '📋 今日工单', source: 'mock', rows: [['WO-2607 电机外壳 ×5000', '87%'], ['WO-2611 风扇组件 ×3200', '62%'], ['WO-2615 控制板 ×1800', '23%']] },
    ] } })
    check('面板：widget 布局复原', widgetsRestore.ok && widgetsRestore.data.widgets.length === 3)

    // -- SSE + 降级轮询（钉钉 webview 双通道铁律） -----------------------------------
    const sseEvents = []
    const sseController = new AbortController()
    const sseWorker = (async () => {
      const response = await fetch(`${BASE}/api/panel/stream?dept=mfg&token=${encodeURIComponent(panelAdmin)}`, { signal: sseController.signal })
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      // 持续读取直到抓到 panel.message.created（SSE 分块到达，首块只有 retry）
      for (let i = 0; i < 12; i++) {
        const { value, done } = await reader.read()
        if (done) break
        sseEvents.push(decoder.decode(value))
        if (sseEvents.join('').includes('panel.message.created')) break
      }
    })().catch(() => sseEvents.push('sse-failed'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    await api('POST', '/api/panel/mfg/messages', { token: panelAdmin, body: { channelId: mainChannel.id, text: 'SSE 推流自测', ddSync: false } })
    await Promise.race([sseWorker, new Promise((resolve) => setTimeout(resolve, 4000))])
    sseController.abort()
    check('面板：SSE 通道建立且事件推送（公开路径 + ?token= 自校验）',
      sseEvents[0]?.includes('retry:') && sseEvents.join('').includes('panel.message.created'),
      JSON.stringify(sseEvents.map((chunk) => chunk.slice(0, 80))))
    const sseNoToken = await fetch(`${BASE}/api/panel/stream?dept=mfg`)
    check('面板：SSE 无 token 被拒（fail-closed）', sseNoToken.status === 401)
    const poll = await api('GET', `/api/panel/mfg/poll?since=${new Date(Date.now() - 60_000).toISOString()}`, { token: panelAdmin })
    check('面板：降级轮询端点（消息/任务/未读）',
      poll.ok && Array.isArray(poll.data.messages) && Array.isArray(poll.data.tasks) && Array.isArray(poll.data.unread),
      JSON.stringify(poll.error ?? ''))

    // -- RBAC 行为抽检（矩阵网全覆盖之外的业务语义） ----------------------------------
    const memberRole = (await api('GET', '/api/iam/roles', { token: panelAdmin })).data.roles.find((role) => role.code === 'member')
    const memberUser = await api('POST', '/api/iam/users', { token: panelAdmin, body: { username: 'panel_member', displayName: '面板成员', orgId: rootOrgId, roleIds: [memberRole.id] } })
    const memberLogin = await api('POST', '/api/auth/login', { body: { username: 'panel_member', password: memberUser.data.initialPassword } })
    const memberToken = memberLogin.data.token
    const memberRead = await api('GET', '/api/panel/mfg/overview', { token: memberToken })
    const memberConfig = await api('PUT', '/api/panel/mfg/kpis', { token: memberToken, body: { kpis: [] } })
    check('面板：成员可读总览（panel.read 迁移生效）但改配置被拒（403）',
      memberRead.ok && memberConfig.status === 403, `read=${memberRead.status} config=${memberConfig.status}`)

    // -- 账号组织打通：部门↔组织绑定 + 部门范围权限 + 名册/资产联动 -------------------
    const agentAssetOverview = await api('GET', '/api/panel/mfg/overview', { token: panelAdmin })
    check('面板：Agent 阵容联动资产状态（asset.status/model 实时解析自资源底座）',
      agentAssetOverview.data.agents.find((agent) => agent.name === '面板质检员')?.asset?.model === 'deepseek-chat',
      JSON.stringify(agentAssetOverview.data?.agents?.map((agent) => ({ n: agent.name, asset: agent.asset?.status }))))
    const boundOrg = await api('POST', '/api/iam/orgs', { token: panelAdmin, body: { name: '研发部（自测）' } })
    const orgBind = await api('PUT', '/api/panel/rd/config', { token: panelAdmin, body: { orgId: boundOrg.data.id } })
    check('面板：部门绑定组织（PUT config，账号组织打通管理动作）',
      orgBind.ok && orgBind.data.dept.org?.name === '研发部（自测）', JSON.stringify(orgBind.error ?? orgBind.data?.dept?.org))
    const rdUser = await api('POST', '/api/iam/users', { token: panelAdmin, body: { username: 'rd_scope_member', displayName: '研发部张工', orgId: boundOrg.data.id, roleIds: [memberRole.id] } })
    const rdLogin = await api('POST', '/api/auth/login', { body: { username: 'rd_scope_member', password: rdUser.data.initialPassword } })
    const rdOverview = await api('GET', '/api/panel/rd/overview', { token: rdLogin.data.token })
    check('面板：组织子树成员可访问已绑定部门 + 成员名册随总览下发',
      rdOverview.ok && rdOverview.data.org?.name === '研发部（自测）' && rdOverview.data.members.some((member) => member.name === '研发部张工'),
      JSON.stringify({ ok: rdOverview.ok, org: rdOverview.data?.org, members: rdOverview.data?.members?.length }))
    const outsiderDenied = await api('GET', '/api/panel/rd/overview', { token: memberToken })
    check('面板：组织外成员被部门范围权限拒绝（403，组织治理双通道）',
      outsiderDenied.status === 403 && /部门范围/.test(outsiderDenied.error?.message ?? ''), JSON.stringify(outsiderDenied.error))
    const outsiderDepts = await api('GET', '/api/panel/depts', { token: memberToken })
    check('面板：部门清单带 allowed 徽标（外部成员视角 rd 锁定/mfg 开放）',
      outsiderDepts.ok && outsiderDepts.data.depts.find((dept) => dept.id === 'rd').allowed === false
      && outsiderDepts.data.depts.find((dept) => dept.id === 'mfg').allowed === true)
    const adminCrossDept = await api('GET', '/api/panel/rd/overview', { token: panelAdmin })
    check("面板：'*' 管理员跨部门直通（治理豁免）", adminCrossDept.ok)
    // -- SSE 握手部门范围同规校验（QA BUG-A-01/T-01 回归）+ stream ticket 一次性通道（H4） --
    const sseUnknown = await fetch(`${BASE}/api/panel/stream?dept=zzzz&token=${encodeURIComponent(panelAdmin)}`)
    check('面板：SSE 未知部门 404（握手即断，绝不先订阅）', sseUnknown.status === 404, String(sseUnknown.status))
    const sseOutsider = await fetch(`${BASE}/api/panel/stream?dept=rd&token=${encodeURIComponent(memberToken)}`)
    const sseOutsiderBody = sseOutsider.status === 200 ? '' : await sseOutsider.text()
    check('面板：SSE 组织外成员 403（deptScopeAllowed 握手同规，QA BUG-A-01 根治）',
      sseOutsider.status === 403 && /部门范围/.test(sseOutsiderBody), `${sseOutsider.status} ${sseOutsiderBody.slice(0, 80)}`)
    const ticketRd = await api('POST', '/api/panel/stream-ticket', { token: rdLogin.data.token, body: { dept: 'rd' } })
    check('面板：stream ticket 签发（Bearer + panel.read + 部门范围校验，H4）',
      ticketRd.ok && /^stk_/.test(ticketRd.data?.ticket ?? '') && ticketRd.data?.expiresInSeconds === 60,
      JSON.stringify(ticketRd.error ?? ticketRd.data))
    const ticketRes = await fetch(`${BASE}/api/panel/stream?dept=rd&ticket=${encodeURIComponent(ticketRd.data.ticket)}`)
    const ticketReader = ticketRes.body?.getReader()
    const ticketHead = ticketReader ? new TextDecoder().decode((await ticketReader.read()).value) : ''
    await ticketReader?.cancel().catch(() => {})
    check('面板：ticket 换流成功（URL 只出现一次性短时凭证，不再携带长效 access token）',
      ticketRes.status === 200 && ticketHead.includes('retry:'), String(ticketRes.status))
    const ticketReplay = await fetch(`${BASE}/api/panel/stream?dept=rd&ticket=${encodeURIComponent(ticketRd.data.ticket)}`)
    check('面板：ticket 一次性消费（重放 401，消费即焚）', ticketReplay.status === 401, String(ticketReplay.status))
    const ticketOutsider = await api('POST', '/api/panel/stream-ticket', { token: memberToken, body: { dept: 'rd' } })
    check('面板：组织外成员签发 ticket 被拒 403（签发端同规校验）', ticketOutsider.status === 403, String(ticketOutsider.status))
    const ticketNoAuth = await fetch(`${BASE}/api/panel/stream-ticket`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dept: 'rd' }) })
    check('面板：未认证签发 ticket 被拒 401', ticketNoAuth.status === 401, String(ticketNoAuth.status))
    const orgUnbind = await api('PUT', '/api/panel/rd/config', { token: panelAdmin, body: { orgId: null } })
    check('面板：解除组织绑定恢复开放', orgUnbind.ok && !orgUnbind.data.dept.org)
  }

  // ================================================================ 面板域扩展收编（DeptAI-UI-DSH 前台 #2 底座半，2026-10-29）
  section('面板扩展：战略看板 board · 制造工具箱 mfg · 本地钉钉面 ddws（前台收编）')
  {
    // 越权探针账号（member 角色：无 panel.* 权限点）
    const extRoles = (await api('GET', '/api/iam/roles', { token: admin })).data.roles
    const extMemberRole = extRoles.find((role) => role.code === 'member')
    const rootOrgForPanel = (await api('GET', '/api/iam/orgs', { token: admin })).data.find((org) => org.parentId === null) ?? {}
    const extMemberInit = await api('POST', '/api/iam/users', { token: admin, body: { username: 'panel_ext_member', displayName: '面板扩展越权探针', orgId: rootOrgForPanel.id, roleIds: [extMemberRole.id] } })
    const memberTokenForPanel = (await api('POST', '/api/auth/login', { body: { username: 'panel_ext_member', password: extMemberInit.data?.initialPassword ?? 'Ybk@2026' } })).data.token
    // -- 战略看板（卡片包 + 漏斗/WAIC/ROI 聚合） ----------------------------------
    const board = await api('GET', '/api/panel/board?platform=rd', { token: admin })
    check('面板扩展：战略看板聚合（platform=cards/assets/funnel/waic/roi 全字段）',
      board.ok && board.data.platform === 'rd' && Array.isArray(board.data.cards)
      && board.data.assets && Number.isFinite(board.data.assets.agentsOnline)
      && board.data.funnel && Number.isFinite(board.data.funnel.invoked)
      && board.data.waic && Number.isFinite(board.data.waic.count)
      && board.data.roi && /估算/.test(board.data.roi.note),
      JSON.stringify({ platform: board.data?.platform, cards: board.data?.cards?.length, funnel: board.data?.funnel }))
    const boardQuality = await api('GET', '/api/panel/board?platform=quality', { token: admin })
    check('面板扩展：战略看板多平台差异化（quality 平台独立下发）',
      boardQuality.ok && boardQuality.data.platform === 'quality' && boardQuality.data.availablePlatforms.length === 5,
      JSON.stringify(boardQuality.data?.availablePlatforms))
    const boardBad = await api('GET', '/api/panel/board?platform=no-such', { token: admin })
    check('面板扩展：非法 platform 被拒（400 枚举校验）', boardBad.status === 400, JSON.stringify(boardBad.error))
    const boardNoAuth = await api('GET', '/api/panel/board')
    check('面板扩展：看板未认证被拒（401，panel.read 同规）', boardNoAuth.status === 401)

    // -- 制造工具箱（目录/选题/模板/计算内核/导出/评估面/放行面） ------------------
    const mfgCatalog = await api('GET', '/api/panel/mfg/catalog', { token: admin })
    check('面板扩展：mfg 工具目录（tools/categories/skills + 模型就绪态）',
      mfgCatalog.ok && Array.isArray(mfgCatalog.data.tools) && mfgCatalog.data.tools.length === 16
      && Array.isArray(mfgCatalog.data.categories) && mfgCatalog.data.skills.length === 3
      && mfgCatalog.data.modelReady === true,
      JSON.stringify({ tools: mfgCatalog.data?.tools?.length, modelReady: mfgCatalog.data?.modelReady, skills: mfgCatalog.data?.skills?.length }))
    const mfgRoadmap = await api('GET', '/api/panel/mfg/roadmap', { token: admin })
    check('面板扩展：mfg 选题清单（100 项来源追溯 + 状态分组）',
      mfgRoadmap.ok && mfgRoadmap.data.tools.length === 100 && Array.isArray(mfgRoadmap.data.groups) && mfgRoadmap.data.statusLabels['implemented-calculation'] !== undefined,
      JSON.stringify({ total: mfgRoadmap.data?.tools?.length, groups: mfgRoadmap.data?.groups?.length }))
    const mfgTemplate = await api('GET', '/api/panel/mfg/tools/oee/template', { token: admin })
    check('面板扩展：mfg 工具模板（oee 字段定义下发）',
      mfgTemplate.ok && mfgTemplate.data.toolId === 'oee' && mfgTemplate.data.fields.length === 5,
      JSON.stringify(mfgTemplate.data?.fields?.map((field) => field.key)))
    const mfgRun = await api('POST', '/api/panel/mfg/tools/oee/run', { token: admin, body: { planned: 480, running: 420, cycle: 0.5, total: 760, good: 735 } })
    check('面板扩展：mfg 计算内核真实执行（OEE 结构化结果：metrics/blocks）',
      mfgRun.ok && mfgRun.data.mode === 'calculation' && Array.isArray(mfgRun.data.blocks) && mfgRun.data.blocks.length > 0
      && JSON.stringify(mfgRun.data).includes('OEE'),
      JSON.stringify(mfgRun.data?.blocks?.map((block) => block.type)))
    const mfgRunBad = await api('POST', '/api/panel/mfg/tools/oee/run', { token: admin, body: { planned: 'x' } })
    check('面板扩展：mfg 非法输入诚实 4xx（校验不静默）', mfgRunBad.status >= 400 && mfgRunBad.status < 500, JSON.stringify(mfgRunBad.error))
    const mfgExport = await api('POST', '/api/panel/mfg/tools/oee/export', { token: admin, body: { result: mfgRun.data, format: 'md' } })
    check('面板扩展：mfg 结果导出（Markdown 文件名 + 内容）',
      mfgExport.ok && /\.md$/.test(mfgExport.data.filename) && mfgExport.data.content.length > 0 && mfgExport.data.mime === 'text/markdown',
      JSON.stringify(mfgExport.data?.filename))
    const mfgEvalPlan = await api('GET', '/api/panel/mfg/evaluation-plan', { token: admin })
    check('面板扩展：mfg 评估计划（fixtures 随计划下发，不发起模型调用）',
      mfgEvalPlan.ok && Array.isArray(mfgEvalPlan.data.plan) && Object.keys(mfgEvalPlan.data.fixtures ?? {}).length > 0,
      JSON.stringify(mfgEvalPlan.data?.plan?.length))
    const mfgReleases = await api('GET', '/api/panel/mfg/releases', { token: admin })
    check('面板扩展：mfg 放行台账（identity + releases 可查询）',
      mfgReleases.ok && Array.isArray(mfgReleases.data.releases) && Boolean(mfgReleases.data.identity?.model),
      JSON.stringify(mfgReleases.data?.identity))
    const mfgNoWrite = await api('POST', '/api/panel/mfg/releases', { token: memberTokenForPanel, body: { report: {} } })
    check('面板扩展：mfg 放行写面越权被拒（403，panel.config.write 治理动作）', mfgNoWrite.status === 403, String(mfgNoWrite.status))

    // -- 本地钉钉面（dws CLI 桥；CLI 未装环境诚实降级） ----------------------------
    const ddwsStatus = await api('GET', '/api/panel/ddws/status', { token: admin })
    check('面板扩展：ddws 状态（mode=dws-cli + 绑定/安装态诚实呈现）',
      ddwsStatus.ok && ddwsStatus.data.mode === 'dws-cli' && ddwsStatus.data.via === 'dws-cli' && 'installed' in ddwsStatus.data,
      JSON.stringify({ installed: ddwsStatus.data?.installed, bound: ddwsStatus.data?.bound }))
    const ddwsBind = await api('PUT', '/api/panel/ddws/bind', { token: admin, body: { group: '自测钉钉群' } })
    check('面板扩展：ddws 绑定目标群（panel.config.write）', ddwsBind.ok && ddwsBind.data.bound === true && ddwsBind.data.group === '自测钉钉群', JSON.stringify(ddwsBind.error))
    const ddwsStatusBound = await api('GET', '/api/panel/ddws/status', { token: admin })
    check('面板扩展：绑定后状态反映群名（形状兼容 displayName）',
      ddwsStatusBound.ok && ddwsStatusBound.data.bound?.displayName === '自测钉钉群', JSON.stringify(ddwsStatusBound.data?.bound))
    const ddwsTest = await api('POST', '/api/panel/ddws/test', { token: admin, body: { text: 'selftest 连通性测试' } })
    check('面板扩展：ddws 连通性测试（CLI 缺席 → 200+ok:false 诚实降级，不造假成功）',
      ddwsTest.status === 200 && ddwsTest.data.ok === false && /dws CLI/.test(String(ddwsTest.data.error)),
      JSON.stringify(ddwsTest.data))
    const ddwsPullNoChannel = await api('POST', '/api/panel/ddws/pull', { token: admin, body: {} })
    check('面板扩展：ddws 入向拉取缺 channelId 被拒（400，部门自频道反查）',
      ddwsPullNoChannel.status === 400 && /channelId/.test(JSON.stringify(ddwsPullNoChannel.error)), JSON.stringify(ddwsPullNoChannel.error))
    const extChannels = await api('GET', '/api/panel/mfg/channels', { token: admin })
    const ddwsPull = await api('POST', '/api/panel/ddws/pull', { token: admin, body: { channelId: extChannels.data.channels[0]?.id } })
    check('面板扩展：ddws 入向拉取（CLI 缺席 → 200+ok:false 诚实降级，降级是数据不是传输错误）',
      ddwsPull.status === 200 && ddwsPull.data.ok === false && /dws/.test(String(ddwsPull.data.error)),
      JSON.stringify(ddwsPull.data))
    const ddwsLoginState = await api('GET', '/api/panel/ddws/login', { token: admin })
    check('面板扩展：ddws 登录会话轮询（无进行中会话 active:false + 授权态字段在列）',
      ddwsLoginState.ok && ddwsLoginState.data.active === false && typeof ddwsLoginState.data.authenticated === 'boolean'
      && Boolean(ddwsLoginState.data.auth),
      JSON.stringify(ddwsLoginState.data))
    const ddwsUnbind = await api('DELETE', '/api/panel/ddws/bind', { token: admin })
    check('面板扩展：ddws 解绑（幂等）', ddwsUnbind.ok && ddwsUnbind.data.bound === false)
    const ddwsMemberWrite = await api('PUT', '/api/panel/ddws/bind', { token: memberTokenForPanel, body: { group: '越权' } })
    check('面板扩展：ddws 绑定越权被拒（403，panel.config.write）', ddwsMemberWrite.status === 403, String(ddwsMemberWrite.status))
  }

  // ================================================================ J1 契约 v1 + 安全响应头 + usage 保留策略（2026-09-11 版本优化）
  section('J1 契约 v1：面板技能/Agent 点名直调（GET skills · POST skills/invoke · panel_*_invoke 工具）')
  {
    const j1Admin = admin
    // 专用 stub 模型（本段自备生命周期，不依赖面板段的 try/finally）
    const j1Stub = createServer((req, res) => {
      if ((req.url ?? '').endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'J1 直调自测应答：按技能指令完成。' } }], usage: { prompt_tokens: 80, completion_tokens: 60 } }))
        return
      }
      res.writeHead(404).end('{}')
    })
    await new Promise((resolve) => j1Stub.listen(0, '127.0.0.1', resolve))
    try {
      const j1Model = await api('POST', '/api/modelgw/models', { token: j1Admin, body: { slug: 'j1-stub-model', displayName: 'J1 直调自测', provider: 'deepseek', endpoint: `http://127.0.0.1:${j1Stub.address().port}/v1`, apiKey: 'stub-key', costCentsPerKTokens: 0 } })
      check('J1：stub 模型就绪', j1Model.ok, JSON.stringify(j1Model.error))
      // deepseek-chat 重指本段 stub：面板段 stub 已在 finally 关闭，而 mfg 名册「面板质检员」的资产 model 仍指向它
      await api('POST', '/api/modelgw/models', { token: j1Admin, body: { slug: 'deepseek-chat', displayName: 'DeepSeek Chat（面板自测 stub·J1 段接管）', provider: 'deepseek', endpoint: `http://127.0.0.1:${j1Stub.address().port}/v1`, apiKey: 'stub-key', listCentsPerKTokens: 1, costCentsPerKTokens: 0 } })
      const j1Channel = (await api('GET', '/api/panel/mfg/channels', { token: j1Admin })).data.channels[0]

      // 种一个已上架技能（提交 → 领域审批 → 上架）
      const j1Submit = await api('POST', '/api/skills', { token: j1Admin, body: { name: 'J1 直调自测技能', summary: 'J1 契约直调验证', content: '# J1 直调自测技能\n\n## 何时使用\n面板技能直调契约自测。\n\n## 步骤\n1. 点名直调\n2. 断言应答', category: '通用', version: '1.0.0' } })
      await api('POST', `/api/skills/${j1Submit.data.id}/approve`, { token: j1Admin, body: { decision: 'approve', level: 'domain', opinion: '契约自测' } })
      const j1Publish = await api('POST', `/api/skills/${j1Submit.data.id}/publish`, { token: j1Admin, body: {} })
      check('J1：直调技能上架就绪', j1Publish.ok && j1Publish.data.status === 'published', JSON.stringify(j1Publish.error))

      const j1Skills = await api('GET', '/api/panel/mfg/skills', { token: j1Admin })
      check('J1：可直调技能清单（published + 组织可见，行含 id/name/slug/version）',
        j1Skills.ok && j1Skills.data.skills.some((item) => item.name === 'J1 直调自测技能')
        && j1Skills.data.skills.every((item) => item.id && item.slug && item.version),
        JSON.stringify(j1Skills.error ?? j1Skills.data?.skills?.length))

      const j1Invoke = await api('POST', '/api/panel/mfg/skills/invoke', { token: j1Admin, body: { skill: 'J1 直调自测技能', message: '请按技能指令执行', channelId: j1Channel.id, model: 'j1-stub-model' } })
      check('J1：技能直调成功路径（200 + ok:true + reply + skill 元数据 + model 回显）',
        j1Invoke.status === 200 && j1Invoke.data.ok === true && /J1 直调自测应答/.test(j1Invoke.data.reply ?? '')
        && j1Invoke.data.skill?.name === 'J1 直调自测技能' && j1Invoke.data.model === 'j1-stub-model',
        JSON.stringify(j1Invoke.error ?? j1Invoke.data).slice(0, 180))
      // W3（D09/V12 加载证据化，REST 面）：invokeSkill 的 skillLoad 指纹随 ok 应答透传，路由层不再丢弃
      check('J1/W3：直调应答携带 skillLoad 指纹（skillId=上架技能 id · version · sha256 contentHash 64 位 hex）',
        j1Invoke.data.ok === true
        && j1Invoke.data.skillLoad?.skillId === j1Submit.data.id
        && j1Invoke.data.skillLoad?.version === '1.0.0'
        && /^[0-9a-f]{64}$/.test(j1Invoke.data.skillLoad?.contentHash ?? ''),
        JSON.stringify(j1Invoke.data?.skillLoad))
      const j1Msgs = (await api('GET', `/api/panel/mfg/messages?channelId=${j1Channel.id}&limit=30`, { token: j1Admin })).data.messages
      const j1Trace = j1Msgs.find((m) => m.senderType === 'human' && m.text.startsWith('/J1 直调自测技能'))
      const j1ReplyMsg = j1Msgs.find((m) => m.senderType === 'agent' && m.senderName === '⚡ J1 直调自测技能')
      check('J1：直调留痕——斜杠原文落频道（skipAgentDispatch）+ 应答落 ⚡ agent 消息（含 model）',
        Boolean(j1Trace) && Boolean(j1ReplyMsg) && j1ReplyMsg.model === 'j1-stub-model')

      const j1Auto = await api('POST', '/api/panel/mfg/skills/invoke', { token: j1Admin, body: { skill: 'J1 直调自测技能', message: '自动选模直调', channelId: j1Channel.id } })
      check('J1：未指定模型自动选「在线且已配 endpoint」模型（ghost-model 这类必败模型不被选中）',
        j1Auto.status === 200 && j1Auto.data.ok === true && j1Auto.data.model !== 'ghost-model',
        JSON.stringify(j1Auto.error ?? { model: j1Auto.data?.model, reason: j1Auto.data?.reason }))

      const j1Missing = await api('POST', '/api/panel/mfg/skills/invoke', { token: j1Admin, body: { skill: '不存在的技能XYZ', message: 'x', channelId: j1Channel.id } })
      check('J1：诚实降级——不存在技能 200 + ok:false + reason（降级是数据不是传输错误）',
        j1Missing.status === 200 && j1Missing.data.ok === false && /没有已上架/.test(j1Missing.data.reason ?? ''))
      const j1FailRow = (await api('GET', `/api/panel/mfg/messages?channelId=${j1Channel.id}&limit=30`, { token: j1Admin })).data.messages.find((m) => m.senderType === 'system' && /技能「不存在的技能XYZ」调用失败/.test(m.text))
      check('J1：失败原因落系统行全频道可见（不静默）', Boolean(j1FailRow))

      const j1Tool = await api('POST', '/api/tools/execute', { token: j1Admin, body: { name: 'panel_skill_invoke', args: { skill: 'J1 直调自测技能', message: '工具面同步直调' } } })
      check('J1：panel_skill_invoke 工具面（与 REST 同一服务原语）',
        j1Tool.ok && j1Tool.data.value?.ok === true && j1Tool.data.value.skill?.name === 'J1 直调自测技能',
        JSON.stringify(j1Tool.error ?? j1Tool.data?.value).slice(0, 160))
      check('J1/W3：panel_skill_invoke 工具面 skillLoad 同构（REST/工具两面同一 service 原语）',
        j1Tool.ok && j1Tool.data.value?.skillLoad?.skillId === j1Submit.data.id
        && /^[0-9a-f]{64}$/.test(j1Tool.data.value?.skillLoad?.contentHash ?? ''),
        JSON.stringify(j1Tool.data?.value?.skillLoad))
      const j1AgentTool = await api('POST', '/api/tools/execute', { token: j1Admin, body: { name: 'panel_agent_invoke', args: { dept: 'mfg', agent: '面板质检员', message: '工具面点名 Agent' } } })
      check('J1：panel_agent_invoke 工具面（askAgent 同步应答，不落频道消息）',
        j1AgentTool.ok && j1AgentTool.data.value?.ok === true && /J1 直调自测应答/.test(j1AgentTool.data.value.reply ?? ''),
        JSON.stringify(j1AgentTool.error ?? j1AgentTool.data?.value).slice(0, 160))
      const j1AgentMissing = await api('POST', '/api/tools/execute', { token: j1Admin, body: { name: 'panel_agent_invoke', args: { dept: 'mfg', agent: '不存在AgentXYZ', message: 'x' } } })
      check('J1：Agent 点名诚实降级（名册无此 Agent → ok:false + 可用阵容提示）',
        j1AgentMissing.ok && j1AgentMissing.data.value?.ok === false && /名册无此 Agent/.test(j1AgentMissing.data.value.reason ?? ''))

      // #17（2026-10-29）回归：机器主体（无用户组织归属）点名 Agent——组织兜底链
      // caller→dept.orgId→平台根组织生效，不再「模型已应答、usage 事件 org 必填」
      const p17Code = await api('POST', '/api/connect/codes', { token: j1Admin, body: { template: 'operator', ttlMinutes: 10, remark: 'selftest-17-machine' } })
      const p17Enroll = await api('POST', '/api/connect/enroll', { body: { enrollmentCode: p17Code.data.code, clientName: 'selftest-17-machine', meta: { hostname: 'selftest-17', platform: 'test' } } })
      await api('PATCH', `/api/authn/principals/${p17Enroll.data.principalId}`, { token: j1Admin, body: { scopes: ['console.login', 'panel.write'] } })
      const p17Login = await api('POST', '/api/auth/client-credentials', { body: { clientId: p17Enroll.data.clientId, clientSecret: p17Enroll.data.clientSecret } })
      const p17MachineInvoke = await api('POST', '/api/tools/execute', { token: p17Login.data.token, body: { name: 'panel_agent_invoke', args: { dept: 'mfg', agent: '面板质检员', message: '#17 机器主体点名' } } })
      check('#17：机器主体（无用户组织）点名 Agent——组织兜底链生效（不再「usage 事件 org 必填」）',
        p17MachineInvoke.ok && p17MachineInvoke.data.value?.ok === true && /J1 直调自测应答/.test(p17MachineInvoke.data.value.reply ?? ''),
        JSON.stringify(p17MachineInvoke.error ?? p17MachineInvoke.data?.value).slice(0, 200))
      const p17Summary = await api('GET', '/api/usage/summary?window=today', { token: j1Admin })
      check('#17：机器主体面板协作计量入账（org 兜底非空，panel:* 资源事件出现）',
        p17Summary.ok && p17Summary.data.byResource.some((row) => String(row.resource).startsWith('panel:')),
        JSON.stringify(p17Summary.data?.byResource?.map((row) => row.resource).slice(0, 6)))
      await api('POST', `/api/connect/clients/${p17Enroll.data.clientId}/disable`, { token: j1Admin, body: { reason: 'selftest #17 完成' } })

      // 可见性：orgs 限定技能不进清单、直调给 visibility 提示（对表定制侧 C1-2 语义）
      const j1OtherOrg = await api('POST', '/api/iam/orgs', { token: j1Admin, body: { name: 'J1 可见性对照组织' } })
      const j1Scope = await api('PATCH', `/api/skills/${j1Submit.data.id}`, { token: j1Admin, body: { visibility: 'orgs', targetOrgs: [j1OtherOrg.data.id] } })
      const j1ScopeList = await api('GET', '/api/panel/mfg/skills', { token: j1Admin })
      const j1ScopeInvoke = await api('POST', '/api/panel/mfg/skills/invoke', { token: j1Admin, body: { skill: 'J1 直调自测技能', message: 'x', channelId: j1Channel.id } })
      check('J1：orgs 限定技能按调用人组织过滤（清单不含 + 直调 visibility 提示 ok:false）',
        j1Scope.ok && !j1ScopeList.data.skills.some((item) => item.name === 'J1 直调自测技能')
        && j1ScopeInvoke.status === 200 && j1ScopeInvoke.data.ok === false && /未对当前用户组织开放/.test(j1ScopeInvoke.data.reason ?? ''),
        JSON.stringify({ scope: j1Scope.error, invoke: j1ScopeInvoke.data?.reason }))
      await api('PATCH', `/api/skills/${j1Submit.data.id}`, { token: j1Admin, body: { visibility: 'all' } })
    } finally {
      j1Stub.close()
    }
  }

  section('安全响应头（platform-core http.ts：nosniff / SAMEORIGIN / Referrer-Policy；SECURITY_HEADERS=off 关闭）')
  {
    const secRoot = await rawReq('GET', '/')
    check('安全响应头：静态页携带 nosniff / SAMEORIGIN / Referrer-Policy',
      secRoot.headers['x-content-type-options'] === 'nosniff'
      && secRoot.headers['x-frame-options'] === 'SAMEORIGIN'
      && secRoot.headers['referrer-policy'] === 'strict-origin-when-cross-origin',
      JSON.stringify({ nosniff: secRoot.headers['x-content-type-options'], frame: secRoot.headers['x-frame-options'], referrer: secRoot.headers['referrer-policy'] }))
    const secApi = await rawReq('GET', '/api/overview')
    check('安全响应头：401 API 响应同样携带（鉴权面不豁免）',
      secApi.status === 401 && secApi.headers['x-content-type-options'] === 'nosniff' && secApi.headers['x-frame-options'] === 'SAMEORIGIN',
      JSON.stringify(secApi.headers['x-content-type-options']))
    // 组1 G1-F2：基线 CSP 随 SECURITY_HEADERS 开关启停；/api/* 数据面一律 no-store（处理器 writeHead 自带优先）
    const secCsp = await rawReq('GET', '/api/overview', { headers: { authorization: `Bearer ${admin}` } })
    check('安全响应头：/api/overview 携带基线 CSP（default-src \'self\' 在位）',
      secCsp.status === 200 && String(secCsp.headers['content-security-policy'] ?? '').includes("default-src 'self'")
      && String(secCsp.headers['content-security-policy'] ?? '').includes("script-src 'self' 'unsafe-inline'"),
      JSON.stringify({ csp: secCsp.headers['content-security-policy'], status: secCsp.status }))
    check('安全响应头：/api/* 数据面 cache-control no-store（鉴权/业务响应不进缓存层）',
      secCsp.headers['cache-control'] === 'no-store', JSON.stringify(secCsp.headers['cache-control']))
    const secStaticCsp = await rawReq('GET', '/')
    check('安全响应头：静态页同样携带基线 CSP', String(secStaticCsp.headers['content-security-policy'] ?? '').includes("default-src 'self'"), JSON.stringify(secStaticCsp.headers['content-security-policy']))
  }

  section('usage 保留策略（USAGE_RETENTION_DAYS 默认 730d；POST /api/usage/retention/purge 手动巡检）')
  {
    const retOrg = (await api('GET', '/api/iam/orgs', { token: admin })).data.find((org) => org.parentId === null).id
    const oldEvent = await api('POST', '/api/usage/record', { token: admin, body: { org: retOrg, subject: 'user:admin', principal: `org:${retOrg}`, resource: 'panel:mfg.qb01', meters: [{ key: 'calls', value: 1, unit: '次' }], idempotency_key: 'retention-selftest-old-1', occurred_at: new Date(Date.now() - 1100 * 86_400_000).toISOString() } })
    check('保留策略：出窗历史事件回填成功（occurred_at 显式指定，约 3 年前）', oldEvent.ok, JSON.stringify(oldEvent.error))
    const purgeDefault = await api('POST', '/api/usage/retention/purge', { token: admin, body: {} })
    check('保留策略：默认窗口巡检清理出窗事件并回显 retentionDays',
      purgeDefault.ok && purgeDefault.data.retentionDays === 730 && purgeDefault.data.purgedEvents >= 1,
      JSON.stringify(purgeDefault.data ?? purgeDefault.error))
    const afterPurge = await api('GET', '/api/usage/events?resource=' + encodeURIComponent('panel:mfg.qb01') + '&limit=500', { token: admin })
    check('保留策略：出窗事件已不在流水，窗口内事件不受影响',
      afterPurge.ok && !afterPurge.data.items.some((item) => item.idempotency_key === 'retention-selftest-old-1'))
    const purgeZero = await api('POST', '/api/usage/retention/purge', { token: admin, body: { days: 0 } })
    check('保留策略：days=0 显式跳过（cutoff 为空，零清理）',
      purgeZero.ok && purgeZero.data.cutoff === '' && purgeZero.data.purgedEvents === 0, JSON.stringify(purgeZero.data))
    const memberRoleRet = (await api('GET', '/api/iam/roles', { token: admin })).data.roles.find((role) => role.code === 'member')
    const retMember = await api('POST', '/api/iam/users', { token: admin, body: { username: 'retention_member', displayName: '保留策略成员', orgId: retOrg, roleIds: [memberRoleRet.id] } })
    const retMemberToken = (await api('POST', '/api/auth/login', { body: { username: 'retention_member', password: retMember.data.initialPassword } })).data.token
    const purgeDenied = await api('POST', '/api/usage/retention/purge', { token: retMemberToken, body: {} })
    check('保留策略：无 usage.admin 被拒 403', purgeDenied.status === 403, String(purgeDenied.status))
  }

  // ================================================================ 钉钉桥接（review-dsh-agent-panel-v2 Phase 3）
  section('钉钉桥接（plugin-dingtalk-bridge：群桥 / 出向投递 / 审批推送 / 告警通道 / 回决 fail-closed）')
  {
    const ddSends = []
    const bridgeStub = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub')
      const raw = await readBody(req)
      if (url.pathname === '/v1.0/oauth2/accessToken') {
        const body = JSON.parse(raw || '{}')
        if (body.appKey === 'bridge-key' && body.appSecret === 'bridge-secret') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accessToken: 'bridge-token', expireIn: 7200 }))
          return
        }
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'invalid.credentials' }))
        return
      }
      if (url.pathname === '/v1.0/robot/groupMessages/send') {
        ddSends.push({ chatId: JSON.parse(raw || '{}').openConversationId, at: Date.now() })
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
        return
      }
      res.writeHead(404).end('{}')
    })
    await new Promise((resolve) => bridgeStub.listen(0, '127.0.0.1', resolve))
    const bridgePort = bridgeStub.address().port

    const putReal = await api('PUT', '/api/iam/connectors/dingtalk', { token: admin, body: { corpId: 'ding-bridge', appKey: 'bridge-key', appSecret: 'bridge-secret', mode: 'real', apiBase: `http://127.0.0.1:${bridgePort}`, oapiBase: `http://127.0.0.1:${bridgePort}`, enabled: true, conflictStrategy: 'manual' } })
    check('桥接：连接器切 real（凭证单一来源=iam 连接器）', putReal.ok)
    const ddStatus = await api('GET', '/api/dingtalk/status', { token: admin })
    check('桥接：状态胶囊（连接器 real / 入向 R-SPIKE 停用声明 / 扫码绑定事实源）',
      ddStatus.ok && ddStatus.data.connector.mode === 'real'
      && ddStatus.data.inbound.enabled === false && /R-SPIKE/.test(ddStatus.data.inbound.reason)
      && /sso\/bind/.test(ddStatus.data.bindPath),
      JSON.stringify(ddStatus.data))

    const mfgChannels = await api('GET', '/api/panel/mfg/channels', { token: admin })
    const syncChannel = mfgChannels.data.channels.find((channel) => channel.name === '异常快速响应群') ?? mfgChannels.data.channels[0]
    const bindBridge = await api('POST', `/api/dingtalk/channels/${syncChannel.id}/bridge`, { token: admin, body: { chatId: 'cid-mfg-001', robotCode: 'rb-001' } })
    check('桥接：频道群桥绑定（dingtalk.message.send）', bindBridge.ok && bindBridge.data.bridge.chatId === 'cid-mfg-001', JSON.stringify(bindBridge.error ?? bindBridge.data))
    const bindAlerts = await api('POST', '/api/dingtalk/channels/alerts-ops/bridge', { token: admin, body: { chatId: 'cid-alerts', robotCode: 'rb-001', purpose: 'alerts' } })
    check('桥接：运维告警群桥绑定（purpose=alerts）', bindAlerts.ok && bindAlerts.data.bridge.purpose === 'alerts', JSON.stringify(bindAlerts.error ?? bindAlerts.data))
    const bridges = await api('GET', '/api/dingtalk/bridges?dept=mfg', { token: admin })
    check('桥接：群桥列表可查', bridges.ok && bridges.data.bridges.length >= 1, JSON.stringify(bridges.error ?? bridges.data))

    // 出向投递：面板消息（ddSync）→ 桥接 → stub 收到 → 回执回写 ddSync=sent
    const ddMsg = await api('POST', '/api/panel/mfg/messages', { token: admin, body: { channelId: syncChannel.id, text: '桥接出向自测：换模窗口确认', ddSync: true } })
    check('桥接：消息带钉钉同步意图（ddSync=pending）', ddMsg.ok && ddMsg.data.message.ddSync === 'pending')
    await new Promise((resolve) => setTimeout(resolve, 900))
    const ddMsgAfter = await api('GET', `/api/panel/mfg/messages?channelId=${syncChannel.id}&limit=5`, { token: admin })
    const sentMsg = ddMsgAfter.data.messages.find((m) => m.id === ddMsg.data.message.id)
    check('桥接：出向投递成功且回执回写（ddSync=sent）', sentMsg.ddSync === 'sent' && ddSends.some((send) => send.chatId === 'cid-mfg-001'),
      JSON.stringify({ ddSync: sentMsg.ddSync, sends: ddSends.length }))

    // 卡片/场景卡推送（panel.card.action dd.push 路径）
    const sendsBeforeScene = ddSends.length
    const sceneSync = await api('POST', '/api/panel/mfg/scenes/QB01-A-2-5/sync-dingtalk', { token: admin })
    await new Promise((resolve) => setTimeout(resolve, 700))
    check('桥接：场景卡同步钉钉（dd.push → 群投递）', sceneSync.ok && ddSends.length > sendsBeforeScene, JSON.stringify({ ok: sceneSync.ok, sends: ddSends.length }))

    // 告警 dingtalk 通道坐实：usage 对账不平 → audit.alert.fired → alerts 群桥投递
    const sendsBeforeAlert = ddSends.length
    const reconcile = await api('POST', '/api/usage/reconcile', { token: admin })
    await new Promise((resolve) => setTimeout(resolve, 900))
    check('桥接：告警经 purpose=alerts 群桥投递（补齐 channels:[dingtalk] 欠账）',
      reconcile.ok && ddSends.filter((send) => send.chatId === 'cid-alerts').length >= 1,
      JSON.stringify({ reconcileOk: reconcile.ok, alertSends: ddSends.filter((send) => send.chatId === 'cid-alerts').length, total: ddSends.length, before: sendsBeforeAlert }))

    // 审批推送
    const pcbReq = await api('POST', '/api/panel/industries/QC01/activate-requests', { token: admin })
    const approvalPush = await api('POST', `/api/dingtalk/approvals/${pcbReq.data.approval.id}/push`, { token: admin })
    check('桥接：审批单推送钉钉', approvalPush.ok && approvalPush.data.delivered === true, JSON.stringify(approvalPush.data ?? approvalPush.error))

    // 回决写回：staffId 反查 fail-closed 三连
    const cbNoLink = await api('POST', '/api/dingtalk/bridge/callback', { token: admin, body: { staffId: 'nobody-staff', approvalId: pcbReq.data.approval.id, decision: 'approve' } })
    check('桥接：未绑定 staffId 回决被拒（fail-closed）', !cbNoLink.ok && /未绑定/.test(cbNoLink.error.message))
    // QA A-05：回决人须非提交人——绑定第二审批人（approver02）作为钉钉侧回决身份
    const dingApprover = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('第二审批人'), { token: admin })).data.users[0]
    await api('POST', `/api/iam/users/${dingApprover.id}/bindings`, { token: admin, body: { provider: 'dingtalk', unionId: 'selftest-staff-001', displayName: '第二审批人' } })
    const cbOk = await api('POST', '/api/dingtalk/bridge/callback', { token: admin, body: { staffId: 'selftest-staff-001', approvalId: pcbReq.data.approval.id, decision: 'approve', opinion: '钉钉侧回决（自测）', confirmed: true } })
    check('桥接：合规回决写回（staffId↔identityLinks 反查 + confirmed）→ 审批执行',
      cbOk.ok && cbOk.data.approval.status === 'executed', JSON.stringify(cbOk.data ?? cbOk.error))
    const pcbAfter = (await api('GET', '/api/panel/industries', { token: admin })).data.industries.find((ind) => ind.code === 'QC01')
    check('桥接：回决生效后 QC01 行业转 active', pcbAfter.state === 'active')

    // 解绑 + 恢复 mock（不污染后续断言）
    const unbind = await api('DELETE', `/api/dingtalk/channels/${syncChannel.id}/bridge`, { token: admin })
    check('桥接：群桥解绑', unbind.ok && unbind.data.deleted === true, JSON.stringify(unbind.error ?? unbind.data))
    const restoreMock = await api('PUT', '/api/iam/connectors/dingtalk', { token: admin, body: { corpId: 'ding-yuanbingke', appKey: 'demo-app-key', appSecret: 'demo-secret-do-not-use', mode: 'mock', enabled: true } })
    check('桥接：连接器恢复 mock（自测收尾）', restoreMock.ok && restoreMock.data.mode === 'mock')
    await new Promise((resolve) => bridgeStub.close(resolve))
  }

  // ================================================================ dsh 宿主挂载（plugin-dsh-bridge，dev-plan-agent-host-unification M1）
  // 进程内构造最小插件树：platform-core（不监听）+ dsh-bridge（挂载半），
  // 用伪造 dsh webServer 捕获注册的 prefix 路由，再经真实 HTTP 端口模拟 dsh 侧分发。
  section('dsh 宿主挂载（单进程单入口 /rq 前缀）')
  {
    const captured = []
    const taps = []
    const fakeWebServer = {
      register: (route) => { captured.push(route); return () => {} },
      tapIndex: (transform) => { taps.push(transform); return () => {} },
    }
    const bridgeDataDir = join(DATA_DIR, 'bridge-mount')
    await mkdir(bridgeDataDir, { recursive: true })
    const mountCtx = new Context()
    await mountCtx.plugin(platformCore, { dataDir: bridgeDataDir, http: { port: 0, externalBase: '/rq' }, startHttp: false })
    // 完整业务树（等价 boot-all 依赖序；startHttp=false → 数据面经 bridge 挂载）：
    await mountCtx.plugin(resourceCore)
    await mountCtx.plugin(iam)
    await mountCtx.plugin(authn)
    await mountCtx.plugin(usage)
    await mountCtx.plugin(audit)
    await mountCtx.plugin(market)
    await mountCtx.plugin(connector)
    await mountCtx.plugin(mcp)
    await mountCtx.plugin(nas)
    await mountCtx.plugin(skillhub)
    await mountCtx.plugin(agent)
    await mountCtx.plugin(app)
    await mountCtx.plugin(modelgw)
    await mountCtx.plugin(connect, { role: 'host' })
    await mountCtx.plugin(update)
    // 先于 console：门户端点在其鉴权中间件之前截获 /api/portal/*
    await mountCtx.plugin(portal)
    await mountCtx.plugin(consolePlugin) // 基线初始化：内置角色 + 根组织 + admin
    // 部门面板 + 钉钉桥接（review-dsh-agent-panel-v2）：与 boot-all 同序（console 之后）
    await mountCtx.plugin(panelCore)
    await mountCtx.plugin(dingtalkBridge)
    await mountCtx.plugin(dshBridge, { mountPath: '/rq' })
    mountCtx.httpServer.register('GET', '/api/__mount_probe', (exchange) => exchange.ok({ pong: exchange.path }), { access: 'authenticated' })
    // 将伪造 webServer 提供给 ctx 后正常装配（等价 dsh 形态：inject 完成后 apply）
    // 绑定服务显式构造（注册在真实 mountCtx 上，供 plugin-nas 出站归因读取）；
    // apply 以「服务视图」调用——等价 dsh 形态下 inject 完成后的装配
    // OIDC 授权码通道凭证（register-dsh-agent.mjs 产物形态）
    writeFileSync(join(bridgeDataDir, 'dsh-agent-credential.json'), JSON.stringify({
      agentId: 'agt_mount_test',
      oidc: { clientId: 'oc-selftest-bridge', clientSecret: 'ocs_selftest_secret' },
    }))
    const bindingService = new dshBridge.IdentityBindingService(mountCtx, {})
    dshBridge.apply(
      { webServer: fakeWebServer, httpServer: mountCtx.httpServer, entryTickets: mountCtx.entryTickets, oidc: mountCtx.oidc, iam: mountCtx.iam, authn: mountCtx.authn, audit: mountCtx.audit, logger: (name) => mountCtx.logger(name), identityBinding: bindingService },
      { mountPath: '/rq', oidcCredentialFile: join(bridgeDataDir, 'dsh-agent-credential.json') },
    )
    check('bridge 向 webServer 注册挂载路由（/rq + /auth/entry + /dsh-bridge + /auth/oidc/*）',
      captured.some((r) => r.kind === 'prefix' && r.path === '/rq') && captured.some((r) => r.kind === 'exact' && r.path === '/auth/entry')
      && captured.some((r) => r.kind === 'prefix' && r.path === '/dsh-bridge') && captured.some((r) => r.kind === 'exact' && r.path === '/auth/oidc/start')
      && captured.some((r) => r.kind === 'exact' && r.path === '/auth/oidc/callback'),
      JSON.stringify(captured.map((r) => `${r.kind}:${r.path}`)))
    check('externalBase 配置生效（/rq）', mountCtx.httpServer.externalBase === '/rq')

    // -- M0-1 死信重放演练：消费 3 次失败入死信 → 修复后重投成功且不双计 ----------
    let drillFail = true
    let drillHandled = 0
    mountCtx.usage.consume('selftest-drill', (event) => {
      drillHandled++
      if (drillFail) throw new Error('drill 注入失败')
      mountCtx.usage.project('selftest-drill', event)
    })
    const drillEvent = mountCtx.usage.record({
      org: 'drill-org', subject: 'agent:drill-bot', principal: 'platform',
      resource: 'app:app-drill', meters: [{ key: 'calls', value: 1, unit: 'call' }],
      idempotency_key: 'selftest-drill-001',
    })
    const drillLetters = mountCtx.usage.deadLetters().all()
    check('M0-1 死信演练：消费连续 3 次失败入死信',
      drillLetters.some((letter) => letter.event_id === drillEvent.event_id && letter.consumer === 'selftest-drill'),
      JSON.stringify(drillLetters))
    drillFail = false
    const drillRetry = mountCtx.usage.retryDeadLetters()
    const projectionAfter = mountCtx.opsStorage.collection('usage:projection:selftest-drill').all().reduce((sum, row) => sum + row.count, 0)
    check('M0-1 死信重投：修复后重投成功且投影恰好一次', drillRetry.retried >= 1 && drillHandled === 4 && projectionAfter === 1,
      JSON.stringify({ drillRetry, drillHandled, projectionAfter }))
    mountCtx.usage.replay(new Date(Date.now() - 3_600_000).toISOString())
    const projectionAfterReplay = mountCtx.opsStorage.collection('usage:projection:selftest-drill').all().reduce((sum, row) => sum + row.count, 0)
    check('M0-1 死信重投后 replay 不双计（消费水位幂等）', projectionAfterReplay === 1, String(projectionAfterReplay))

    // -- 组5 C-05/死信 source：plugin: 来源事件失败入死信带 source，结构性重投成功 -------------
    {
      let d19Fail = true
      let d19Handled = 0
      mountCtx.platformBus.on('plugin:com.selftest.demo:tick', () => {
        d19Handled++
        if (d19Fail) throw new Error('d19 注入失败')
      })
      mountCtx.platformBus.emit('plugin:com.selftest.demo:tick', { n: 1 }, { source: 'plugin:com.selftest.demo' })
      let d19Letter
      for (let i = 0; i < 40 && !d19Letter; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        d19Letter = mountCtx.platformBus.deadLetters().find((letter) => letter.eventName === 'plugin:com.selftest.demo:tick')
      }
      check('组5 死信：plugin: 来源事件 3 次重试失败入死信', Boolean(d19Letter), JSON.stringify(mountCtx.platformBus.deadLetters().map((l) => l.eventName)))
      check('组5 死信：死信记录携带 source（plugin: 前缀，结构性重投依据）',
        typeof d19Letter?.source === 'string' && d19Letter.source.startsWith('plugin:'), JSON.stringify(d19Letter ?? {}))
      d19Fail = false
      const d19Retry = mountCtx.platformBus.retryDeadLetters()
      check('组5 死信：按原来源重投成功（redelivered≥1，监听器第 4 次消费成功，死信清空）',
        d19Retry.redelivered >= 1 && d19Handled === 4 && !mountCtx.platformBus.deadLetters().some((letter) => letter.eventName === 'plugin:com.selftest.demo:tick'),
        JSON.stringify({ retry: d19Retry, handled: d19Handled }))
    }

    // -- H3 白盒回归：宽限窗口外旧 token 重放 = 硬重放，整链吊销（含宽限兄弟对） ----------
    const gracePrincipal = mountCtx.authn.ensureHumanPrincipal('selftest-grace-user', '宽限窗口自测')
    const gracePairA = mountCtx.authn.issueSessionPair(gracePrincipal.id, { issuedBy: 'selftest-grace' })
    const graceRotated = mountCtx.authn.refreshSession(gracePairA.refreshToken)
    const graceSibling = mountCtx.authn.refreshSession(gracePairA.refreshToken) // 窗口内：兄弟对自愈
    check('H3 白盒：宽限内二次兑换签发兄弟对（不吊销链）',
      graceSibling.refreshToken !== graceRotated.refreshToken
      && Boolean(mountCtx.authn.verify(graceRotated.token))
      && Boolean(mountCtx.authn.verify(graceSibling.token)))
    const graceOldHash = createHash('sha256').update(gracePairA.refreshToken).digest('hex')
    const graceOldRecord = mountCtx.authn.tokens().findOne((token) => token.refreshHash === graceOldHash)
    // 时间旅行：轮转时刻拨到 60s 前（窗口 30s）→ 旧 token 再现即硬重放
    mountCtx.authn.tokens().update(graceOldRecord.id, { rotatedAt: new Date(Date.now() - 60_000).toISOString() })
    let graceReplayThrew = false
    try { mountCtx.authn.refreshSession(gracePairA.refreshToken) } catch { graceReplayThrew = true }
    check('H3 白盒：宽限窗口外旧 token 重放被拒并整链吊销（重放防线不变）', graceReplayThrew)
    let graceChainDead = true
    try { mountCtx.authn.verify(graceRotated.token); graceChainDead = false } catch { /* 已吊销 */ }
    try { mountCtx.authn.verify(graceSibling.token); graceChainDead = false } catch { /* 已吊销 */ }
    check('H3 白盒：整链吊销覆盖轮转对与宽限兄弟对', graceChainDead)
    // 模拟 dsh webserver 分发：命中 /rq 前缀即交给 bridge handler，其余 404
    const sim = createServer((req, res) => {
      const exact = captured.find((r) => r.kind === 'exact' && (req.url ?? '').split('?')[0] === r.path)
      if (exact) { exact.handler(req, res); return }
      const route = captured.find((r) => r.kind === 'prefix' && (req.url === r.path || (req.url ?? '').startsWith(`${r.path}/`)))
      if (route) { route.handler(req, res); return }
      res.writeHead(404).end('sim-miss')
    })
    await new Promise((resolve) => sim.listen(0, '127.0.0.1', resolve))
    // 完整树下数据面带 console 鉴权中间件：先经 /rq/api/auth/login 换 Bearer（基线初始口令文件）
    const pwFile = join(bridgeDataDir, 'admin-initial-password.txt')
    const adminPassword = existsSync(pwFile)
      ? (readFileSync(pwFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('平台管理员'))[0] ?? '')
      : ''
    const loginRes = await fetch(`http://127.0.0.1:${sim.address().port}/rq/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: adminPassword || '自测兜底口令' }),
    })
    const adminToken = (await loginRes.json().catch(() => null))?.data?.token
    check('/rq/api/auth/login 可用（单入口下登录链路通）', Boolean(adminToken), `status=${loginRes.status}`)
    const simGet = async (path, token) => fetch(`http://127.0.0.1:${sim.address().port}${path}`, {
      redirect: 'manual', headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    const probe = await simGet('/rq/api/__mount_probe', adminToken)
    const probeBody = await probe.json().catch(() => null)
    check('/rq/api/* 剥前缀后与独立形态路由等价（含 Bearer 鉴权链）', probe.status === 200 && probeBody?.data?.pong === '/api/__mount_probe', `status=${probe.status} body=${JSON.stringify(probeBody)}`)
    const redir = await simGet('/rq')
    check('/rq 302 归一到 /rq/（SPA 相对引用可解析）', redir.status === 302 && redir.headers.get('location') === '/rq/')
    const spa = await simGet('/rq/')
    check('/rq/ 伺服控制台 index.html（SPA fallback）', spa.status === 200 && (await spa.text()).includes('<!doctype html>'))
    const asset = await simGet('/rq/js/app.js')
    check('/rq/js/* 控制台静态资源按前缀命中', asset.status === 200 && String(asset.headers.get('content-type') ?? '').includes('javascript'), `status=${asset.status}`)
    const panelSpa = await simGet('/rq/panel/')
    check('/rq/panel/ 面板 SPA 经前缀挂载可达（宿主 web diff=0）', panelSpa.status === 200 && (await panelSpa.text()).includes('行业 AI 工作台'), `status=${panelSpa.status}`)
    const panelBareMounted = await simGet('/rq/panel')
    check('/rq/panel 302 → /rq/panel/（externalBase 感知，与独立形态同语义）',
      panelBareMounted.status === 302 && panelBareMounted.headers.get('location') === '/rq/panel/',
      `status=${panelBareMounted.status} location=${panelBareMounted.headers.get('location')}`)
    const spaMiss = await simGet('/rq/anything-else')
    check('非 /api 未命中回落 SPA（与独立形态一致）', spaMiss.status === 200 && (await spaMiss.text()).includes('<!doctype html>'))
    const apiMiss = await simGet('/rq/api/definitely-missing', adminToken)
    const apiMissBody = await apiMiss.json().catch(() => null)
    check('未匹配 API 404 JSON 不落静态（DEF-01）', apiMiss.status === 404 && apiMissBody?.error?.code === 'NOT_FOUND')
    const simMiss = await fetch(`http://127.0.0.1:${sim.address().port}/outside`)
    check('前缀外请求不进平台数据面（dsh 侧自有路由域不受影响）', simMiss.status === 404 && (await simMiss.text()) === 'sim-miss')

    // -- 身份半：票据兑换 → Cookie 绑定 → 状态 → 会话归因 → 实时失效（M4/M5） ----
    check('免登引导脚本经 tapIndex 注入', taps.length === 1 && taps[0]('<html><head></head></html>').includes('entry_ticket'))
    const simOrigin = `http://127.0.0.1:${sim.address().port}`
    const adminUser = mountCtx.iam.users().findOne((u) => u.username === 'admin')
    check('基线初始化（挂载形态最小树）产出 admin', Boolean(adminUser))
    const entryIssue = mountCtx.entryTickets.issue({ refType: 'agent', refId: 'agt_mount_test', userId: adminUser.id, userName: '平台管理员' })
    const entryRes = await fetch(`${simOrigin}/auth/entry?entry_ticket=${encodeURIComponent(entryIssue.ticket)}`, { redirect: 'manual' })
    const setCookie = entryRes.headers.get('set-cookie') ?? ''
    check('/auth/entry 兑换 → 302 / + Set-Cookie rq_sid（HttpOnly/SameSite=Lax）',
      entryRes.status === 302 && entryRes.headers.get('location') === '/' && setCookie.includes('rq_sid=rbs_') && setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Lax'),
      `${entryRes.status} ${setCookie}`)
    const cookie = setCookie.split(';')[0] ?? ''
    const statusRes = await fetch(`${simOrigin}/dsh-bridge/status`, { headers: { cookie } })
    const statusBody = await statusRes.json()
    check('/dsh-bridge/status 读 Cookie 返回绑定身份', statusBody?.data?.bound === true && statusBody.data.identity?.sub === adminUser.id, JSON.stringify(statusBody))
    const statusAnon = await fetch(`${simOrigin}/dsh-bridge/status`)
    const statusAnonBody = await statusAnon.json()
    check('无 Cookie 状态查询 → 未绑定（不作身份推断）', statusAnonBody?.data?.bound === false)
    check('绑定自检原因码：无 Cookie → no_cookie（WP-04/A2 文案映射依据）', statusAnonBody?.data?.reason === 'no_cookie', JSON.stringify(statusAnonBody))
    const entryReplay = await fetch(`${simOrigin}/auth/entry?entry_ticket=${encodeURIComponent(entryIssue.ticket)}`, { redirect: 'manual' })
    check('票据重放被拒（一次性消费，redeem 抛错→400）', entryReplay.status === 400)
    const bindRes = await fetch(`${simOrigin}/dsh-bridge/bind-session`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ sessionId: 'sess-mount-1' }),
    })
    check('会话绑定 200（Cookie 定身份 → sessionId 关联）', bindRes.status === 200, JSON.stringify(await bindRes.json()))
    const boundViaSession = mountCtx.identityBinding.identityForSession('sess-mount-1')
    const boundFallback = mountCtx.identityBinding.identityForSession('sess-unknown')
    check('工具出站归因解析：会话绑定优先 / 未绑定回落最近绑定', boundViaSession?.userId === adminUser.id && boundFallback?.userId === adminUser.id, JSON.stringify({ boundViaSession, boundFallback }))
    mountCtx.iam.users().update(adminUser.id, { status: 'suspended' })
    const statusFrozen = await fetch(`${simOrigin}/dsh-bridge/status`, { headers: { cookie } })
    const statusFrozenBody = await statusFrozen.json()
    check('账号停用 → 绑定实时失效（兑换面已校验 + 读取面再校验）', statusFrozenBody?.data?.bound === false)
    check('绑定自检原因码：停用账号 → account_inactive（可识别、可出文案）', statusFrozenBody?.data?.reason === 'account_inactive', JSON.stringify(statusFrozenBody))
    mountCtx.iam.users().update(adminUser.id, { status: 'active' })
    const crossOrigin = await fetch(`${simOrigin}/dsh-bridge/status`, { headers: { origin: 'http://evil.example.com' } })
    check('绑定面同源收紧：跨站 Origin 403（对齐 dsh fence 语义）', crossOrigin.status === 403)

    // -- 宿主会话直通（review-dsh-agent-panel-v2 宿主打通）：rq_sid → 平台会话 → 面板 RBAC 面 --
    mountCtx.iam.users().update(adminUser.id, { status: 'active' })
    const sessionRes = await fetch(`${simOrigin}/dsh-bridge/session`, { method: 'POST', headers: { 'content-type': 'application/json', cookie } })
    const sessionBody = await sessionRes.json().catch(() => null)
    check('宿主会话直通：Cookie 绑定身份兑换平台会话（token + user + permissions）',
      sessionRes.status === 200 && sessionBody?.ok === true && Boolean(sessionBody.data?.token) && Array.isArray(sessionBody.data?.user?.permissions) && sessionBody.data.user.permissions.length > 0,
      JSON.stringify(sessionBody?.error ?? sessionBody?.data?.user?.displayName))
    const panelViaSession = await fetch(`${simOrigin}/rq/api/panel/depts`, { headers: { authorization: `Bearer ${sessionBody.data.token}` } })
    const panelViaSessionBody = await panelViaSession.json().catch(() => null)
    check('宿主会话直通：兑换令牌直通面板 RBAC 面（/rq/api/panel/depts 200）',
      panelViaSession.status === 200 && panelViaSessionBody?.ok === true && Array.isArray(panelViaSessionBody.data?.depts) && panelViaSessionBody.data.depts.length === 5,
      `status=${panelViaSession.status}`)
    const sessionNoCookie = await fetch(`${simOrigin}/dsh-bridge/session`, { method: 'POST' })
    const sessionNoCookieBody = await sessionNoCookie.json().catch(() => null)
    check('宿主会话直通：无 Cookie 401（NOT_BOUND fail-closed，同源面统一收紧）',
      sessionNoCookie.status === 401 && sessionNoCookieBody?.error?.code === 'NOT_BOUND')

    // -- behavior 消费语义（WP-03/D3，进程内直测：投递 / 死信 / 重放幂等） -----------
    const behaviorSeen = []
    const offBehavior = mountCtx.behavior.consume('selftest-observer', (event) => { behaviorSeen.push(event.event_id) })
    const bFirst = mountCtx.behavior.record({ subject: 'user:usr-behavior-test', type: 'funnel.step', platform: 'rd', payload: { step: 1 }, idempotency_key: 'b-selftest-001' })
    check('behavior 投递：先写后发（消费方收到首投）', bFirst.duplicated === false && behaviorSeen.includes(bFirst.event.event_id))
    const bDup = mountCtx.behavior.record({ subject: 'user:usr-behavior-test', type: 'funnel.step', platform: 'rd', payload: { step: 1 }, idempotency_key: 'b-selftest-001' })
    check('behavior 投递：幂等重放不重发（消费水位跳过 + duplicated 标记）',
      bDup.duplicated === true && behaviorSeen.filter((id) => id === bFirst.event.event_id).length === 1)
    mountCtx.behavior.consume('selftest-broken', () => { throw new Error('自测故障消费方') })
    const bFail = mountCtx.behavior.record({ subject: 'user:usr-behavior-test', type: 'card.clicked', idempotency_key: 'b-selftest-002' })
    check('behavior 投递：消费方连续 3 次失败入死信', mountCtx.behavior.deadLetters().all().some((letter) => letter.event_id === bFail.event.event_id && letter.consumer === 'selftest-broken'))
    check('behavior 投递：死信触发 critical 告警（audit.alert.fired）',
      mountCtx.platformBus.recent(50).some((event) => event.name === 'audit.alert.fired' && JSON.stringify(event.payload).includes('behavior 消费死信')))
    const behaviorBeforeReplay = behaviorSeen.length
    mountCtx.behavior.replay(new Date(0).toISOString())
    check('behavior 投递：replay 幂等（已消费事件不重投）', behaviorSeen.length === behaviorBeforeReplay)
    const retriedBehavior = mountCtx.behavior.retryDeadLetters()
    check('behavior 投递：死信重投（故障消费方仍失败则保留死信）', retriedBehavior.remaining >= 1 && mountCtx.behavior.deadLetters().all().some((letter) => letter.consumer === 'selftest-broken'))
    offBehavior()

    // -- OIDC 授权码通道（start 302 → PKCE；callback 坏 state 拒绝） -----------------
    // #15（2026-10-29）：302 目标按请求 Host 派生 issuer（浏览器实际入口地址 simOrigin + /rq 前缀），
    // 不再取进程配置的无参 issuer（本段 mountCtx httpServer port=0，无参值不再是合法对外地址）
    const oidcStart = await fetch(`${simOrigin}/auth/oidc/start`, { redirect: 'manual' })
    const oidcLocation = oidcStart.headers.get('location') ?? ''
    check('/auth/oidc/start 302 平台授权页（client_id + PKCE S256 + state）',
      oidcStart.status === 302 && oidcLocation.startsWith(`${simOrigin}/rq/oauth/authorize`)
      && oidcLocation.includes('client_id=oc-selftest-bridge') && oidcLocation.includes('code_challenge_method=S256') && oidcLocation.includes('state='),
      `${oidcStart.status} ${oidcLocation}`)
    const oidcCallbackBad = await fetch(`${simOrigin}/auth/oidc/callback?code=x&state=bogus`, { redirect: 'manual' })
    check('/auth/oidc/callback 坏 state 被拒 400（防 CSRF/重放）', oidcCallbackBad.status === 400)
    await new Promise((resolve) => sim.close(resolve))
  }

  // ================================================================ 组1 A-09：口令 scrypt KDF 与旧 sha256 透明升级（白盒）
  section('口令 KDF 升级（组1 A-09：scrypt 格式 / 旧 sha256 登录透明升级 / timingSafeEqual）')
  {
    const kdfCtx = new Context()
    await kdfCtx.plugin(platformCore, { dataDir: join(DATA_DIR, 'kdf-upgrade'), startHttp: false })
    await kdfCtx.plugin(resourceCore)
    await kdfCtx.plugin(iam)
    const kdfOrg = kdfCtx.iam.createOrg({ name: 'KDF 自测部' }, iam.SYSTEM_ACTOR)
    const kdfUser = kdfCtx.iam.createUser({ username: 'legacykdf', displayName: '旧哈希账号', orgId: kdfOrg.id, password: 'LegacyKdf@2026' }, iam.SYSTEM_ACTOR).user
    kdfCtx.iam.users().update(kdfUser.id, { status: 'active', passwordSalt: 'legacy-salt-01', passwordHash: platformCore.sha256Hex('legacy-salt-01:LegacyKdf@2026') })
    const before = kdfCtx.iam.users().get(kdfUser.id)
    check('KDF 前置：预置旧 sha256 存储记录（裸 hex，无 scrypt$ 前缀）',
      !before.passwordHash.startsWith('scrypt$') && before.passwordSalt === 'legacy-salt-01', JSON.stringify({ hash: before.passwordHash.slice(0, 16), salt: before.passwordSalt }))
    let legacyLoginOk = false
    try { kdfCtx.iam.verifyPassword('legacykdf', 'LegacyKdf@2026'); legacyLoginOk = true } catch (error) { check('KDF：旧哈希登录（异常）', false, String(error)) }
    check('KDF：旧 sha256 口令登录成功', legacyLoginOk)
    const after = kdfCtx.iam.users().get(kdfUser.id)
    const scryptParts = String(after.passwordHash).split('$')
    check('KDF：登录后存储透明升级为 scrypt$（前缀 + passwordSalt 清空）',
      after.passwordHash.startsWith('scrypt$') && scryptParts.length === 6 && after.passwordSalt === '',
      JSON.stringify({ hash: after.passwordHash.slice(0, 24), salt: after.passwordSalt, parts: scryptParts.length }))
    check('KDF：scrypt 参数自描述（N=16384/r=8/p=1，OWASP 下限档；盐与哈希均为 base64）',
      Number(scryptParts[1]) === 16384 && Number(scryptParts[2]) === 8 && Number(scryptParts[3]) === 1
      && Buffer.from(scryptParts[4] ?? '', 'base64').length === 16 && Buffer.from(scryptParts[5] ?? '', 'base64').length === 64,
      JSON.stringify(scryptParts.slice(1, 4)))
    let scryptReloginOk = false
    try { kdfCtx.iam.verifyPassword('legacykdf', 'LegacyKdf@2026'); scryptReloginOk = true } catch { /* ignore */ }
    check('KDF：升级后同口令再登录成功（scrypt 复算路径）', scryptReloginOk)
    let wrongPwRejected = false
    try { kdfCtx.iam.verifyPassword('legacykdf', 'WrongPass@2026') } catch (error) { wrongPwRejected = /用户名或密码错误/.test(String(error)) }
    check('KDF：错误口令拒绝（timingSafeEqual 常数时间比较路径）', wrongPwRejected)
  }

  // ================================================================ IAW 交接批次（docs/handoff-iaw-gaps-to-main.md 2026-09-11）
  // 批次共享主体（模块顶层声明，跨分节复用）：根组织 / 成员账号 / 仅 console.login 的机器凭证
  const iawRootOrg = (await api('GET', '/api/iam/orgs', { token: admin })).data.find((org) => org.parentId === null)
  // 成员挂 mfg 部门绑定的组织（面板组织子树范围语义：通知/面板可见性同源）
  const iawMfgOrgId = (await api('GET', '/api/panel/depts', { token: admin })).data.depts.find((dept) => dept.id === 'mfg')?.orgId
  const iawMemberOrgId = iawMfgOrgId ?? iawRootOrg.id
  const iawMemberRole = (await api('GET', '/api/iam/roles', { token: admin })).data.roles.find((role) => role.code === 'member')
  const iawMemberInit = await api('POST', '/api/iam/users', { token: admin, body: { username: 'iaw_member', displayName: 'IAW 成员', orgId: iawMemberOrgId, roleIds: [iawMemberRole.id] } })
  const iawMemberInitPassword = iawMemberInit.data?.initialPassword ?? 'Ybk@2026'
  const iawMemberToken = (await api('POST', '/api/auth/login', { body: { username: 'iaw_member', password: iawMemberInitPassword } })).data.token
  const iawCred = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'iaw-no-panel', refType: 'external', scopes: ['console.login'] } })
  const iawMachine = (await api('POST', '/api/auth/client-credentials', { body: { clientId: iawCred.data.clientId, clientSecret: iawCred.data.clientSecret } })).data.token

  section('IAW 4-1/4-2：usage 成本摘要与反馈聚合（面板度量驾驶舱数据源）')
  {
    const iawAdminSummary = await api('GET', '/api/usage/summary?window=today', { token: admin })
    check('4-1：管理员查摘要（scope=platform，cost_cents/byResource 齐备）',
      iawAdminSummary.ok && iawAdminSummary.data.scope === 'platform' && iawAdminSummary.data.window === 'today'
      && Number.isFinite(iawAdminSummary.data.cost_cents) && Array.isArray(iawAdminSummary.data.byResource)
      && Number.isFinite(iawAdminSummary.data.input_tokens) && Number.isFinite(iawAdminSummary.data.output_tokens),
      JSON.stringify({ scope: iawAdminSummary.data?.scope, cost: iawAdminSummary.data?.cost_cents }))
    const iawMonth = await api('GET', '/api/usage/summary?window=month', { token: admin })
    check('4-1：month 窗口边界为当月 1 日（UTC 口径）',
      iawMonth.ok && iawMonth.data.from === `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z` && iawMonth.data.window === 'month',
      JSON.stringify({ from: iawMonth.data?.from }))
    const iawMemberSummary = await api('GET', '/api/usage/summary?window=today&org=other-org', { token: iawMemberToken })
    check('4-1：panel.read 成员强制收敛自身组织（传入 org=other 被忽略，scope=self-org）',
      iawMemberSummary.ok && iawMemberSummary.data.scope === 'self-org' && iawMemberSummary.data.org === iawMemberOrgId,
      JSON.stringify({ scope: iawMemberSummary.data?.scope, org: iawMemberSummary.data?.org }))
    const iawDenied = await api('GET', '/api/usage/summary', { token: iawMachine })
    check('4-1：无 panel.read 主体被拒 403', iawDenied.status === 403, String(iawDenied.status))

    // 4-2：一组全新 up/down 反馈 → 聚合口径与采纳率
    const fbUp = await api('POST', '/api/usage/feedback', { token: iawMemberToken, body: { resource: 'panel:mfg.qb01', messageId: 'iaw-msg-up-1', score: 'up' } })
    const fbDown = await api('POST', '/api/usage/feedback', { token: iawMemberToken, body: { resource: 'panel:mfg.qb01', messageId: 'iaw-msg-down-1', score: 'down' } })
    check('4-2：反馈落账（零价快照 up/down 各一条）', fbUp.ok && fbDown.ok, JSON.stringify({ up: fbUp.error, down: fbDown.error }))
    await api('POST', '/api/usage/feedback', { token: iawMemberToken, body: { resource: 'panel:mfg.qb01', messageId: 'iaw-msg-up-2', score: 'up' } })
    const fbReplayIaw = await api('POST', '/api/usage/feedback', { token: iawMemberToken, body: { resource: 'panel:mfg.qb01', messageId: 'iaw-msg-up-1', score: 'up' } })
    check('4-2：同键重放幂等（不重复计数）', fbReplayIaw.ok && fbReplayIaw.data.event_id === fbUp.data.event_id)
    const fbStats = await api('GET', '/api/usage/feedback-stats?days=7', { token: iawMemberToken })
    const iawRow = (fbStats.data?.byResource ?? []).find((row) => row.resource === 'panel:mfg.qb01')
    check('4-2：采纳率聚合（自测行 up=2/down=1，adoptionRate≈0.667，scope 收敛自身组织）',
      fbStats.ok && fbStats.data.scope === 'self-org' && iawRow && iawRow.up === 2 && iawRow.down === 1
      && Math.abs(iawRow.adoptionRate - 2 / 3) < 0.001 && fbStats.data.adoptionRate > 0 && fbStats.data.adoptionRate <= 1,
      JSON.stringify({ up: iawRow?.up, down: iawRow?.down, rate: iawRow?.adoptionRate, global: fbStats.data.adoptionRate }))
    const fbStatsAdmin = await api('GET', '/api/usage/feedback-stats?days=7', { token: admin })
    check('4-2：usage.read 主体可跨组织聚合（scope=platform 且含同资源行）',
      fbStatsAdmin.ok && fbStatsAdmin.data.scope === 'platform'
      && fbStatsAdmin.data.byResource.some((row) => row.resource === 'panel:mfg.qb01' && row.up >= 2))
  }

  section('IAW 5-1/5-2：结论级证据锚点 + 场景维度审计时间线')
  {
    const evPost = await api('POST', '/api/audit/evidence', { token: iawMemberToken, body: {
      sceneCode: 'QB01-G-4-1', messageId: 'iaw-msg-ev-1', subject: 'user:iaw_member',
      anchors: [
        { kind: 'dataset', id: 'ds_selftest_a', name: '自测数据集A', qualityScore: 92 },
        { kind: 'query', id: 'q-77', timeWindow: { from: '2026-09-01', to: '2026-09-11' }, hitRows: 42 },
      ],
    } })
    check('5-1：证据登记（2 锚点落库发 id，panel.write）', evPost.ok && evPost.data.anchors.length === 2, JSON.stringify(evPost.error))
    const evGet = await api('GET', `/api/audit/evidence/${evPost.data.id}`, { token: iawMemberToken })
    check('5-1：证据反查（锚点/时间窗/命中行数原样可读）',
      evGet.ok && evGet.data.anchors[1].hitRows === 42 && evGet.data.anchors[0].qualityScore === 92 && evGet.data.sceneCode === 'QB01-G-4-1')
    const ev404 = await api('GET', '/api/audit/evidence/evd_not_exist', { token: iawMemberToken })
    check('5-1：不存在的证据 404', ev404.status === 404, String(ev404.status))
    const evBad = await api('POST', '/api/audit/evidence', { token: iawMemberToken, body: { anchors: [{ kind: 'bogus', id: 'x' }] } })
    check('5-1：非法锚点 kind 被拒 400', !evBad.ok && /kind 非法/.test(evBad.error.message), JSON.stringify(evBad.error))
    const evMachineDenied = await api('POST', '/api/audit/evidence', { token: iawMachine, body: { anchors: [{ kind: 'doc', id: 'd1' }] } })
    check('5-1：无 panel.write 主体登记被拒 403', evMachineDenied.status === 403, String(evMachineDenied.status))

    // 5-2：任务带 sceneCode 创建/流转 → 审计时间线可反查
    const tlTask = await api('POST', '/api/panel/mfg/tasks', { token: admin, body: { title: 'IAW 时间线自测任务', lane: 'doing', sceneCode: 'QB01-G-4-2' } })
    check('5-2：带场景任务创建', tlTask.ok && tlTask.data.task.sceneCode === 'QB01-G-4-2', JSON.stringify(tlTask.error))
    const tlMove = await api('POST', `/api/panel/tasks/${tlTask.data.task.id}/transition`, { token: admin, body: { lane: 'done' } })
    check('5-2：任务流转', tlMove.ok, JSON.stringify(tlMove.error))
    const tl = await api('GET', '/api/audit/timeline?sceneCode=QB01-G-4-2', { token: iawMemberToken })
    const tlActions = (tl.data?.items ?? []).map((item) => item.action)
    check('5-2：场景时间线含 create+transition（panel.read 可读，倒序）',
      tl.ok && tlActions.includes('panel.task.create') && tlActions.includes('panel.task.transition')
      && tl.data.items[0].at >= tl.data.items[tl.data.items.length - 1].at,
      JSON.stringify(tlActions))
    const tlEmpty = await api('GET', '/api/audit/timeline?sceneCode=QB01-NOPE-0-0', { token: iawMemberToken })
    check('5-2：无痕场景时间线为空（诚实空集）', tlEmpty.ok && tlEmpty.data.total === 0 && tlEmpty.data.items.length === 0)
    const tlDenied = await api('GET', '/api/audit/timeline', { token: iawMachine })
    check('5-2：无 panel.read 主体被拒 403', tlDenied.status === 403, String(tlDenied.status))
  }

  section('IAW 8-1：通知中心持久化（任务/告警落账 + since/已读游标）')
  {
    const before = await api('GET', '/api/notifications', { token: iawMemberToken })
    const baselineUnread = before.data?.unread ?? 0
    // 任务事件 → 部门绑定组织范围通知（mfg 绑定组织后组织子树成员可见）
    const ntfTask = await api('POST', '/api/panel/mfg/tasks', { token: admin, body: { title: 'IAW 通知自测任务', lane: 'todo' } })
    check('8-1：触发事件（任务创建→流转产生 panel.task.updated）', ntfTask.ok, JSON.stringify(ntfTask.error))
    await api('POST', `/api/panel/tasks/${ntfTask.data.task.id}/transition`, { token: admin, body: { lane: 'doing' } })
    const after = await api('GET', '/api/notifications', { token: iawMemberToken })
    const taskNotif = (after.data?.items ?? []).find((item) => item.type === 'task' && /IAW 通知自测任务/.test(item.title))
    check('8-1：任务通知持久化并按组织范围可见（unread 递增）',
      after.ok && Boolean(taskNotif) && after.data.unread >= baselineUnread + 1,
      JSON.stringify({ count: after.data?.items?.length, unread: after.data?.unread }))
    // 告警事件（全局范围）：告警规则 threshold=0 + 一次越权 → audit.authz.denied → 告警 → 通知
    const ruleIaw = await api('POST', '/api/audit/alert-rules', { token: admin, body: { name: 'IAW 通知自测规则', metric: 'permission_denied', threshold: 0, severity: 'warning' } })
    const deniedHit = await api('POST', '/api/iam/orgs', { token: iawMachine, body: { name: 'IAW 通知触发越权' } })
    check('8-1：越权探针（403 触发 permission_denied 链路）', deniedHit.status === 403 && ruleIaw.ok, JSON.stringify({ denied: deniedHit.status }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    const afterAlert = await api('GET', '/api/notifications', { token: iawMemberToken })
    check('8-1：告警通知落账（type=alert，全局范围）',
      afterAlert.ok && (afterAlert.data.items ?? []).some((item) => item.type === 'alert' && /IAW 通知自测规则/.test(item.title)),
      JSON.stringify(afterAlert.data?.items?.slice(0, 2).map((item) => item.title)))
    // 已读游标 + since 增量
    const markRead = await api('POST', '/api/notifications/read-cursor', { token: iawMemberToken, body: {} })
    check('8-1：已读游标推进', markRead.ok && markRead.data.unread === 0, JSON.stringify(markRead.data))
    const afterRead = await api('GET', '/api/notifications', { token: iawMemberToken })
    check('8-1：游标后 unread=0 且历史可见（游标语义非删除）', afterRead.ok && afterRead.data.unread === 0 && afterRead.data.items.length >= 1)
    const sinceNow = await api('GET', '/api/notifications?since=' + encodeURIComponent(markRead.data.readCursor), { token: iawMemberToken })
    check('8-1：since 增量拉取（游标后零新增）', sinceNow.ok && sinceNow.data.items.length === 0, JSON.stringify(sinceNow.data?.items?.length))
    const machineNotif = await api('GET', '/api/notifications', { token: iawMachine })
    check('8-1：机器主体无个人通知面（空集诚实返回）', machineNotif.ok && machineNotif.data.items.length === 0 && /机器主体/.test(machineNotif.data.note ?? ''))
  }

  section('IAW 1-1..1-4：模型渠道分级路由 / 降级链 / 遥测 / 预算熔断')
  {
    // 双 stub：主渠道恒 500，备渠道正常应答
    const gwPrimaryStub = createServer((req, res) => {
      if ((req.url ?? '').endsWith('/chat/completions')) { res.writeHead(500).end('{"error":"primary down"}'); return }
      res.writeHead(404).end('{}')
    })
    const gwBackupStub = createServer((req, res) => {
      if ((req.url ?? '').endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '降级链自测：备用渠道应答' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
        return
      }
      res.writeHead(404).end('{}')
    })
    await new Promise((resolve) => gwPrimaryStub.listen(0, '127.0.0.1', resolve))
    await new Promise((resolve) => gwBackupStub.listen(0, '127.0.0.1', resolve))
    try {
      const primaryPort = gwPrimaryStub.address().port
      const backupPort = gwBackupStub.address().port
      // 1-1 分级：public 上限渠道 + secret 数据 → 直接拒绝（选择器锁死+原因）
      const regPub = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'iaw-pub', displayName: '公开级渠道', endpoint: `http://127.0.0.1:${backupPort}/v1`, apiKey: 'stub', costCentsPerKTokens: 0, dataClassLimit: 'public' } })
      const regSecret = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'iaw-scr', displayName: '秘密级渠道', endpoint: `http://127.0.0.1:${primaryPort}/v1`, apiKey: 'stub', costCentsPerKTokens: 1, dataClassLimit: 'secret' } })
      const regSecretOk = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'iaw-scrok', displayName: '秘密级可用渠道', endpoint: `http://127.0.0.1:${backupPort}/v1`, apiKey: 'stub', costCentsPerKTokens: 1, dataClassLimit: 'secret' } })
      const regBackup = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'iaw-bkp', displayName: '内部级备用渠道', endpoint: `http://127.0.0.1:${backupPort}/v1`, apiKey: 'stub', costCentsPerKTokens: 1 } })
      check('1-1：四渠道登记（public/secret-500/secret-ok/默认 internal）', regPub.ok && regSecret.ok && regSecretOk.ok && regBackup.ok, JSON.stringify({ pub: regPub.error, scr: regSecret.error, scrok: regSecretOk.error, bkp: regBackup.error }))
      const gradedDeny = await api('POST', '/api/modelgw/invoke', { token: admin, body: { model: 'iaw-pub', messages: [{ role: 'user', content: 'x' }], orgId: iawRootOrg.id, dataClass: 'secret' } })
      check('1-1：秘密数据 → 公开级渠道被锁死拒绝（错误含原因）',
        gradedDeny.status === 400 && /数据分级越界/.test(gradedDeny.error.message) && /锁死/.test(gradedDeny.error.message),
        JSON.stringify(gradedDeny.error))
      const gradedAllow = await api('POST', '/api/modelgw/invoke', { token: admin, body: { model: 'iaw-scrok', messages: [{ role: 'user', content: '分级内调用' }], orgId: iawRootOrg.id, dataClass: 'secret' } })
      check('1-1：秘密数据 → 秘密级渠道放行（真实应答）', gradedAllow.ok && gradedAllow.data.content.includes('备用渠道应答'), JSON.stringify(gradedAllow.error))

      // 1-2 降级链：主(500) → 备(ok)，manual=true
      const grpPut = await api('PUT', '/api/modelgw/channel-groups', { token: admin, body: { slug: 'iaw-grp', name: 'IAW 自测渠道组', primary: 'iaw-scr', backup1: 'iaw-bkp', manual: true, stepTimeoutMs: 2000 } })
      check('1-2：渠道组登记（主/备/转人工）', grpPut.ok && grpPut.data.primary === 'iaw-scr' && grpPut.data.backup1 === 'iaw-bkp' && grpPut.data.manual === true, JSON.stringify(grpPut.error))
      const fbCall = await api('POST', '/api/modelgw/channel-groups/iaw-grp/invoke', { token: admin, body: { prompt: '降级链自测' } })
      check('1-2：主渠道 5xx → 备渠道自动接管（真实应答 + degradations 留痕）',
        fbCall.ok && fbCall.data.ok === true && fbCall.data.model === 'iaw-bkp' && Array.isArray(fbCall.data.degradations) && fbCall.data.degradations.length === 1
        && /HTTP 500/.test(fbCall.data.degradations[0].reason),
        JSON.stringify({ model: fbCall.data?.model, degradations: fbCall.data?.degradations }))
      // 1-3 遥测：主渠道失败 1 次 → 可用率下降；ttft 诚实缺列
      const telPrimary = await api('GET', '/api/modelgw/iaw-scr/telemetry?window=7d', { token: admin })
      check('1-3：主渠道遥测（failures>=1，availability<1，ttftMs=null 诚实缺列）',
        telPrimary.ok && telPrimary.data.failures >= 1 && telPrimary.data.availability !== null && telPrimary.data.availability < 1
        && telPrimary.data.ttftMs === null && /TTFT/.test(telPrimary.data.note),
        JSON.stringify({ inv: telPrimary.data?.invocations, fail: telPrimary.data?.failures, avail: telPrimary.data?.availability }))
      const telBackup = await api('GET', '/api/modelgw/iaw-bkp/telemetry?window=7d', { token: admin })
      check('1-3：备用渠道遥测（degraded 标记 + TPS 代理口径）',
        telBackup.ok && telBackup.data.invocations >= 1 && telBackup.data.degradedInvocations >= 1
        && (telBackup.data.avgTps === null || telBackup.data.avgTps > 0),
        JSON.stringify({ inv: telBackup.data?.invocations, deg: telBackup.data?.degradedInvocations }))
      const tel404 = await api('GET', '/api/modelgw/iaw-none/telemetry', { token: admin })
      check('1-3：未登记模型遥测 404', tel404.status === 404, String(tel404.status))

      // 1-4 预算：org 级日预算 1 分 + block → 熔断；摘要带预算进度
      const budgetPut = await api('PUT', '/api/modelgw/budgets', { token: admin, body: { orgId: iawRootOrg.id, dailyLimitCents: 1, monthlyLimitCents: 100, warnRatio: 0.5, action: 'block' } })
      check('1-4：预算登记（日 1 分 block / 月 100 分）', budgetPut.ok && budgetPut.data.dailyLimitCents === 1, JSON.stringify(budgetPut.error))
      const budgetBlocked = await api('POST', '/api/modelgw/invoke', { token: admin, body: { model: 'iaw-scr', messages: [{ role: 'user', content: '预算内调用' }], orgId: iawRootOrg.id } })
      check('1-4：日预算触达 → 调用前熔断（错误含「预算熔断」）',
        budgetBlocked.status === 400 && /预算熔断/.test(budgetBlocked.error.message), JSON.stringify(budgetBlocked.error))
      const summaryBudget = await api('GET', `/api/usage/summary?window=today&org=${encodeURIComponent(iawRootOrg.id)}`, { token: admin })
      check('1-4：成本摘要携带预算进度（budget.daily.limitCents=1）',
        summaryBudget.ok && summaryBudget.data.budget && summaryBudget.data.budget.daily
        && summaryBudget.data.budget.daily.limitCents === 1 && summaryBudget.data.budget.daily.breached === true,
        JSON.stringify(summaryBudget.data?.budget))
      // 放宽预算（action=warn + 大额），避免影响后续分节
      const budgetRelax = await api('PUT', '/api/modelgw/budgets', { token: admin, body: { orgId: iawRootOrg.id, dailyLimitCents: 100000, monthlyLimitCents: 1000000, warnRatio: 0.99, action: 'warn' } })
      check('1-4：预算放宽（upsert 同键覆盖）', budgetRelax.ok && budgetRelax.data.action === 'warn', JSON.stringify(budgetRelax.error))

      // 组3 BUG-2510-B1：invokeWithFallback 每次真实调用前 enforceBudget 复检——block 态整链熔断，
      // 不经备用渠道调通上游、不产生新 usage 事件、不发 degraded（错误文案与单渠道路径一致）
      const budgetBlockAgain = await api('PUT', '/api/modelgw/budgets', { token: admin, body: { orgId: iawRootOrg.id, dailyLimitCents: 0, monthlyLimitCents: 100, warnRatio: 0.5, action: 'block' } })
      check('1-4b 前置：预算切回 block（日 0 分）', budgetBlockAgain.ok && budgetBlockAgain.data.action === 'block', JSON.stringify(budgetBlockAgain.error))
      const b1TelBackupBefore = (await api('GET', '/api/modelgw/iaw-bkp/telemetry?window=7d', { token: admin })).data?.invocations ?? 0
      const b1UsageBefore = (await api('GET', '/api/usage/events?resource=' + encodeURIComponent('model:iaw-bkp') + '&limit=1', { token: admin })).data?.total ?? 0
      const fbBlocked = await api('POST', '/api/modelgw/channel-groups/iaw-grp/invoke', { token: admin, body: { prompt: '预算熔断复检（降级链）' } })
      check('组3 B9：block 熔断中降级链调用 → 400 含「预算熔断」（首渠道即终止，不进降级）',
        fbBlocked.status === 400 && /预算熔断/.test(fbBlocked.error?.message ?? ''), `${fbBlocked.status} ${JSON.stringify(fbBlocked.error)}`)
      const b1TelBackupAfter = (await api('GET', '/api/modelgw/iaw-bkp/telemetry?window=7d', { token: admin })).data?.invocations ?? 0
      check('组3 B9：备用渠道遥测 invocations 不增长（未调上游，熔断先于真实调用）',
        b1TelBackupAfter === b1TelBackupBefore, `before=${b1TelBackupBefore} after=${b1TelBackupAfter}`)
      const b1UsageAfter = (await api('GET', '/api/usage/events?resource=' + encodeURIComponent('model:iaw-bkp') + '&limit=1', { token: admin })).data?.total ?? 0
      check('组3 B9：无新 usage 事件（block 态不入账）', b1UsageAfter === b1UsageBefore, `before=${b1UsageBefore} after=${b1UsageAfter}`)
      const budgetRelaxRestore = await api('PUT', '/api/modelgw/budgets', { token: admin, body: { orgId: iawRootOrg.id, dailyLimitCents: 100000, monthlyLimitCents: 1000000, warnRatio: 0.99, action: 'warn' } })
      check('1-4b：预算复原 warn（环境清理）', budgetRelaxRestore.ok && budgetRelaxRestore.data.action === 'warn', JSON.stringify(budgetRelaxRestore.error))
    } finally {
      await new Promise((resolve) => gwPrimaryStub.close(resolve))
      await new Promise((resolve) => gwBackupStub.close(resolve))
    }
  }

  section('IAW 6-1：场景级授权策略（scene ABAC）与 iam.check 自检')
  {
    const iawMemberId = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('iaw_member'), { token: admin })).data.users.find((user) => user.username === 'iaw_member').id
    const polPut = await api('PUT', '/api/iam/scene-policies', { token: admin, body: {
      sceneCode: 'QB01-G-4-1',
      entries: [
        { principalType: 'role', principalId: '*', actions: ['scene.export'], effect: 'deny' },
        { principalType: 'user', principalId: iawMemberId, actions: ['*'], effect: 'allow' },
      ],
      note: 'IAW 自测策略：全员禁导出，该成员全放行',
    } })
    check('6-1：策略登记（deny 导出 + 成员 allow，v1）', polPut.ok && polPut.data.version === 1, JSON.stringify(polPut.error))
    const versionConflict = await api('PUT', '/api/iam/scene-policies', { token: admin, body: { sceneCode: 'QB01-G-4-1', expectedVersion: 99, entries: [{ principalType: 'role', principalId: '*', actions: ['x'], effect: 'allow' }] } })
    check('6-1：version 乐观锁冲突被拒 400', versionConflict.status === 400 && /版本冲突/.test(versionConflict.error.message), JSON.stringify(versionConflict.error))
    const checkAllow = await api('POST', '/api/iam/scene-authz/check', { token: iawMemberToken, body: { sceneCode: 'QB01-G-4-1', action: 'panel.read' } })
    check('6-1：iam.check allow 命中（成员 allow 条目）', checkAllow.ok && checkAllow.data.decision === 'allow', JSON.stringify(checkAllow.data))
    const checkDeny = await api('POST', '/api/iam/scene-authz/check', { token: iawMemberToken, body: { sceneCode: 'QB01-G-4-1', action: 'scene.export' } })
    check('6-1：iam.check deny 优先命中（全员禁导出）', checkDeny.ok && checkDeny.data.decision === 'deny', JSON.stringify(checkDeny.data))
    const checkDefault = await api('POST', '/api/iam/scene-authz/check', { token: iawMemberToken, body: { sceneCode: 'QB01-NOPE-9-9', action: 'panel.read' } })
    check('6-1：未配置策略场景回落 default（存量 RBAC 口径不变）', checkDefault.ok && checkDefault.data.decision === 'default', JSON.stringify(checkDefault.data))
    const polList = await api('GET', '/api/iam/scene-policies?sceneCode=QB01-G-4-1', { token: iawMemberToken })
    check('6-1：member 无 iam.org.read 策略列表被拒 403', polList.status === 403, String(polList.status))
    const machineCheck = await api('POST', '/api/iam/scene-authz/check', { token: iawMachine, body: { sceneCode: 'QB01-G-4-1', action: 'panel.read', userId: iawMemberId } })
    check('6-1：机器代查被拒 403（无 iam.user.read）', machineCheck.status === 403, String(machineCheck.status))
    const polDel = await api('DELETE', `/api/iam/scene-policies/${polPut.data.id}`, { token: admin })
    check('6-1：策略删除（回滚自测环境）', polDel.ok && polDel.data.deleted === true)
    const afterDel = await api('POST', '/api/iam/scene-authz/check', { token: iawMemberToken, body: { sceneCode: 'QB01-G-4-1', action: 'scene.export' } })
    check('6-1：删除后回落 default（fail-closed 随策略移除）', afterDel.ok && afterDel.data.decision === 'default')
  }

  section('组5 A-01：panel 任务创建 sceneGuard（场景策略 deny → 403 + audit.authz.denied）')
  {
    const sgAdminId = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('admin'), { token: admin })).data.users.find((user) => user.username === 'admin')?.id
    const sgPolicy = await api('PUT', '/api/iam/scene-policies', { token: admin, body: {
      sceneCode: 'QB01-DENY-TASK',
      entries: [{ principalType: 'user', principalId: sgAdminId, actions: ['panel.task.create'], effect: 'deny' }],
      note: '组5 sceneGuard 自测：禁该管理员在该场景建单',
    } })
    check('A-01 前置：场景策略登记（deny admin 的 panel.task.create）', sgPolicy.ok, JSON.stringify(sgPolicy.error))
    const sgDenied = await api('POST', '/api/panel/mfg/tasks', { token: admin, body: { title: '场景守卫拒绝任务（自测）', lane: 'todo', sceneCode: 'QB01-DENY-TASK' } })
    check('组5 A-01：带 sceneCode 建单命中 deny → 403 FORBIDDEN（场景授权拒绝）',
      sgDenied.status === 403 && sgDenied.error?.code === 'FORBIDDEN' && /场景授权拒绝|QB01-DENY-TASK/.test(sgDenied.error?.message ?? ''), `${sgDenied.status} ${JSON.stringify(sgDenied.error)}`)
    let sgAuditHit = null
    for (let i = 0; i < 20 && !sgAuditHit; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      const logs = await api('GET', '/api/audit/logs?type=authz&limit=50', { token: admin })
      sgAuditHit = (logs.data?.items ?? []).find((log) => String(log.detail ?? '').includes('scene:QB01-DENY-TASK#panel.task.create'))
    }
    check('组5 A-01：拒绝落审计（audit.authz.denied：scene:QB01-DENY-TASK#panel.task.create 可反查）',
      Boolean(sgAuditHit), JSON.stringify(sgAuditHit ?? '未命中'))
    const sgNoScene = await api('POST', '/api/panel/mfg/tasks', { token: admin, body: { title: '无场景码任务放行（自测）', lane: 'todo' } })
    check('组5 A-01：不带 sceneCode 建单 200（守卫不阻断普通任务）', sgNoScene.ok && sgNoScene.data.task?.id, JSON.stringify(sgNoScene.error))
    const sgMachineCred = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'sg-machine-task', refType: 'external', scopes: ['panel.task.write'] } })
    const sgMachineToken = (await api('POST', '/api/auth/client-credentials', { body: { clientId: sgMachineCred.data.clientId, clientSecret: sgMachineCred.data.clientSecret } })).data?.token
    const sgMachineTask = await api('POST', '/api/panel/mfg/tasks', { token: sgMachineToken, body: { title: '机器主体场景建单（自测）', lane: 'todo', sceneCode: 'QB01-DENY-TASK' } })
    check('组5 A-01：机器主体不入场景域（带 sceneCode 也放行，RBAC 权限点已覆盖）',
      sgMachineTask.ok && sgMachineTask.data.task?.id, `${sgMachineTask.status} ${JSON.stringify(sgMachineTask.error)}`)
    await api('DELETE', `/api/iam/scene-policies/${sgPolicy.data.id}`, { token: admin })
    const sgCleanupTask = await api('POST', '/api/panel/mfg/tasks', { token: admin, body: { title: '策略删除后同场景建单（自测）', lane: 'todo', sceneCode: 'QB01-DENY-TASK' } })
    check('组5 A-01：策略删除后同场景建单恢复放行（环境清理即回滚验证）', sgCleanupTask.ok, JSON.stringify(sgCleanupTask.error))
  }

  section('IAW 2-1..2-4：数据要素域（数据集登记/质量分/血缘/指标字典仲裁）')
  {
    const dsPut = await api('PUT', '/api/resource/datasets', { token: admin, body: { code: 'ds_selftest_a', name: '自测数据集A', sourceSystem: '自测台账', classification: 'secret', refreshFrequency: '每日', sceneCodes: ['QB01-G-4-1', 'QB01-G-4-2'] } })
    check('2-1：数据集登记（分级/来源/刷新/双场景）', dsPut.ok && dsPut.data.classification === 'secret' && dsPut.data.sceneCodes.length === 2, JSON.stringify(dsPut.error))
    await api('PUT', '/api/resource/datasets', { token: admin, body: { code: 'ds_selftest_a', name: '自测数据集A（改）', sourceSystem: '自测台账', classification: 'internal', sceneCodes: ['QB01-G-4-1'] } })
    const dsList = await api('GET', '/api/resource/datasets?scene=QB01-G-4-1', { token: admin })
    const dsRow = (dsList.data?.datasets ?? []).find((item) => item.code === 'ds_selftest_a')
    check('2-1：按场景过滤 + upsert 幂等（sceneCount=1）', dsList.ok && Boolean(dsRow) && dsRow.sceneCount === 1 && dsRow.classification === 'internal', JSON.stringify(dsRow))
    // QA-03 回归（外部 QA-20261014）：资源管理员补治理读面（panel.read/flow.read 迁移补点）——能写也能读
    const dsOpsRead = await api('GET', '/api/resource/datasets?scene=QB01-G-4-1', { token: ops })
    check('QA-03 回归：资源管理员可读数据集清单（补 panel.read）', dsOpsRead.ok && Array.isArray(dsOpsRead.data?.datasets), JSON.stringify(dsOpsRead.error))
    const flowOpsRead = await api('GET', '/api/flow/templates', { token: ops })
    check('QA-03 回归：资源管理员可读事务流模板（补 flow.read）', flowOpsRead.ok, JSON.stringify(flowOpsRead.error))
    const dsQuality = await api('PUT', '/api/resource/datasets/ds_selftest_a/quality', { token: admin, body: { completeness: 90, accuracy: 80, timeliness: 100, consistency: 70 } })
    check('2-2：质量分四维登记（等权 overall=85）', dsQuality.ok && dsQuality.data.quality.overall === 85, JSON.stringify(dsQuality.error))
    const dsBadQuality = await api('PUT', '/api/resource/datasets/ds_selftest_a/quality', { token: admin, body: { completeness: 120, accuracy: 80, timeliness: 100, consistency: 70 } })
    check('2-2：越界质量分被拒 400', dsBadQuality.status === 400 && /0-100/.test(dsBadQuality.error.message), JSON.stringify(dsBadQuality.error))
    await api('PUT', '/api/resource/datasets', { token: admin, body: { code: 'ds_selftest_b', name: '自测数据集B（派生）', sourceSystem: '自测台账', classification: 'internal' } })
    const lineagePut = await api('PUT', '/api/resource/lineage', { token: admin, body: { derived: 'ds_selftest_b', source: 'ds_selftest_a' } })
    check('2-3：血缘边登记（派生→源）', lineagePut.ok && lineagePut.data.toId === 'ds_selftest_a', JSON.stringify(lineagePut.error))
    const lineageUp = await api('GET', '/api/resource/lineage?dataset=ds_selftest_b', { token: admin })
    const lineageDown = await api('GET', '/api/resource/lineage?dataset=ds_selftest_a', { token: admin })
    check('2-3：反向追溯（B 的 upstream=A，A 的 downstream=B）',
      lineageUp.ok && lineageUp.data.upstream.some((item) => item.code === 'ds_selftest_a')
      && lineageDown.ok && lineageDown.data.downstream.some((item) => item.code === 'ds_selftest_b'),
      JSON.stringify({ up: lineageUp.data?.upstream, down: lineageDown.data?.downstream }))
    // 2-4 指标字典：口径冲突留账 + 仲裁
    const mDef1 = await api('PUT', '/api/resource/metrics/gm_selftest/definitions', { token: admin, body: { name: '毛利额（口径一）', unit: '元', description: '收入-成本（含税口径）' } })
    const mDefSame = await api('PUT', '/api/resource/metrics/gm_selftest/definitions', { token: admin, body: { name: '毛利额（口径一）', unit: '元', description: '收入-成本（含税口径）' } })
    check('2-4：口径登记（首条 active；同内容幂等）', mDef1.ok && mDef1.data.definition.status === 'active' && mDefSame.data.definition.id === mDef1.data.definition.id)
    const mDef2 = await api('PUT', '/api/resource/metrics/gm_selftest/definitions', { token: admin, body: { name: '毛利额（口径二）', unit: '元', description: '收入-成本（不含税口径）' } })
    check('2-4：口径冲突并存（新定义 superseded 待仲裁）', mDef2.ok && mDef2.data.conflict === true && mDef2.data.definition.status === 'superseded', JSON.stringify(mDef2.data))
    const mList = await api('GET', '/api/resource/metrics/gm_selftest/definitions', { token: admin })
    check('2-4：定义列表双条（按时间倒序）', mList.ok && mList.data.definitions.length === 2 && mList.data.definitions[0].id === mDef2.data.definition.id)
    const mArb = await api('POST', '/api/resource/metrics/gm_selftest/arbitrate', { token: admin, body: { definitionId: mDef2.data.definition.id } })
    check('2-4：仲裁定版（口径二 active，取代 1 条）', mArb.ok && mArb.data.active.status === 'active' && mArb.data.superseded === 1, JSON.stringify(mArb.data))
    // 组5 C-09：指标指纹 stableStringify（键序归一）——同口径不同键序重复登记不再误判口径冲突
    const mKeyOrderA = await api('PUT', '/api/resource/metrics/gm_selftest/definitions', { token: admin, body: { name: '毛利额（键序归一）', unit: '元', description: '收入-成本', payload: { 规则: { 乙: 2, 甲: 1 }, 来源: '自测' } } })
    const mKeyOrderB = await api('PUT', '/api/resource/metrics/gm_selftest/definitions', { token: admin, body: { name: '毛利额（键序归一）', unit: '元', description: '收入-成本', payload: { 来源: '自测', 规则: { 甲: 1, 乙: 2 } } } })
    check('组5 C-09：同口径不同键序重复登记 → 幂等返回同 id（conflict=false，键序归一）',
      mKeyOrderA.ok && mKeyOrderB.ok && mKeyOrderB.data.conflict === false && mKeyOrderB.data.definition.id === mKeyOrderA.data.definition.id,
      JSON.stringify({ a: mKeyOrderA.data?.definition?.id, b: mKeyOrderB.data?.definition?.id, conflict: mKeyOrderB.data?.conflict }))
    // 组5 C-08：血缘成环检测——b→a 已在库，再登记 a 派生自 b 即循环依赖
    const lineageCycle = await api('PUT', '/api/resource/lineage', { token: admin, body: { derived: 'ds_selftest_a', source: 'ds_selftest_b' } })
    check('组5 C-08：血缘成环登记被拒（400 含「成环」，沿既有边 DFS 可达即环）',
      lineageCycle.status === 400 && /成环/.test(lineageCycle.error?.message ?? ''), `${lineageCycle.status} ${JSON.stringify(lineageCycle.error)}`)
    // 组5 C-11：质量分 expectedVersion 乐观并发（此前 :5919 区段已登记一次 → revision=1）
    const qualityStale = await api('PUT', '/api/resource/datasets/ds_selftest_a/quality', { token: admin, body: { completeness: 90, accuracy: 80, timeliness: 100, consistency: 70, expectedVersion: 0 } })
    check('组5 C-11：质量分过期 expectedVersion → 400 含「版本冲突」',
      qualityStale.status === 400 && /版本冲突/.test(qualityStale.error?.message ?? ''), `${qualityStale.status} ${JSON.stringify(qualityStale.error)}`)
    const qualityCurrent = await api('PUT', '/api/resource/datasets/ds_selftest_a/quality', { token: admin, body: { completeness: 91, accuracy: 81, timeliness: 100, consistency: 71, expectedVersion: 1, note: '乐观并发正确版本' } })
    check('组5 C-11：正确 expectedVersion → 登记成功且 revision 递增到 2',
      qualityCurrent.ok && qualityCurrent.data.qualityRevision === 2 && qualityCurrent.data.quality?.overall === 85.8,
      JSON.stringify({ revision: qualityCurrent.data?.qualityRevision, overall: qualityCurrent.data?.quality?.overall, err: qualityCurrent.error }))
    const dsWriteDenied = await api('PUT', '/api/resource/datasets', { token: iawMachine, body: { code: 'ds_x', name: 'x', sourceSystem: 'x', classification: 'public' } })
    check('2-1：无 resource.dataset.write 被拒 403', dsWriteDenied.status === 403, String(dsWriteDenied.status))
  }

  section('IAW 3-1..3-4：事务流引擎（模板库 / TF 编排 / 步骤状态机 / SLA 进度）')
  {
    const tplPut = await api('PUT', '/api/flow/templates', { token: admin, body: {
      code: 'tpl_iaw_selftest', name: 'IAW 自测模板', sceneCode: 'QB01-G-4-1', slaMinutes: 120,
      steps: [
        { key: 's1', name: '现场复核', actorType: 'human' },
        { key: 's2', name: 'Agent 诊断', actorType: 'agent', assignee: '设备运维 Agent' },
        { key: 's3', name: '网关归档', actorType: 'gateway' },
      ],
      contextPack: { kpiRef: '一次装机合格率', window: '7d' },
    } })
    check('3-2：模板登记（3 步 + SLA + 上下文包）', tplPut.ok && tplPut.data.steps.length === 3, JSON.stringify(tplPut.error))
    const tplList = await api('GET', '/api/flow/templates?sceneCode=QB01-G-4-1', { token: iawMemberToken })
    check('3-2：按场景查模板（panel 成员 flow.read 可读）', tplList.ok && tplList.data.templates.some((item) => item.code === 'tpl_iaw_selftest'))
    const tplDenied = await api('PUT', '/api/flow/templates', { token: iawMemberToken, body: { code: 'tpl_x', name: 'x', steps: [{ key: 'a', name: 'a', actorType: 'human' }] } })
    check('3-2：member 无 flow.admin 被拒 403', tplDenied.status === 403, String(tplDenied.status))
    // 实例化：模板复制推广 + 上下文包自动注入 + SLA 折算 dueAt
    const flowCreate = await api('POST', '/api/flow/flows', { token: iawMemberToken, body: { name: 'IAW 自测事务流', templateCode: 'tpl_iaw_selftest', sceneCode: 'QB01-G-4-1', dept: 'mfg' } })
    check('3-1/3-2：TF 模板实例化（首步 running + contextPack 注入 + dueAt 折算）',
      flowCreate.ok && flowCreate.data.steps[0].status === 'running' && flowCreate.data.steps[1].status === 'pending'
      && flowCreate.data.contextPack && flowCreate.data.contextPack.kpiRef === '一次装机合格率'
      && Boolean(flowCreate.data.dueAt) && /^tf_/.test(flowCreate.data.code),
      JSON.stringify(flowCreate.error))
    const flowId = flowCreate.data.id
    const wrongOrder = await api('POST', `/api/flow/flows/${flowId}/steps/s2/transition`, { token: iawMemberToken, body: { action: 'complete' } })
    check('3-1：步骤状态机拒绝跳序（pending 不可 complete）', wrongOrder.status === 400 && /不允许/.test(wrongOrder.error.message), JSON.stringify(wrongOrder.error))
    const s1 = await api('POST', `/api/flow/flows/${flowId}/steps/s1/transition`, { token: iawMemberToken, body: { action: 'complete', note: '复核完成' } })
    check('3-1：s1 complete → s2 自动 running', s1.ok && s1.data.completed === false && s1.data.flow.currentStep === 's2', JSON.stringify(s1.data?.flow?.steps))
    const s2 = await api('POST', `/api/flow/flows/${flowId}/steps/s2/transition`, { token: iawMemberToken, body: { action: 'complete' } })
    check('3-1：s2 complete → s3 自动 running', s2.ok && s2.data.flow.currentStep === 's3')
    const s3 = await api('POST', `/api/flow/flows/${flowId}/steps/s3/transition`, { token: iawMemberToken, body: { action: 'skip', note: '网关缺位跳过' } })
    check('3-1：s3 skip → TF completed（进度 100）', s3.ok && s3.data.completed === true && s3.data.flow.status === 'completed' && s3.data.flow.progress === 100, JSON.stringify({ status: s3.data?.flow?.status, progress: s3.data?.flow?.progress }))
    const flowGet = await api('GET', `/api/flow/flows/${flowId}`, { token: iawMemberToken })
    check('3-3/3-4：TF 详情（elapsedMinutes/finishedAt/步骤时间轴齐备，甘特数据源）',
      flowGet.ok && flowGet.data.status === 'completed' && Number.isFinite(flowGet.data.elapsedMinutes)
      && flowGet.data.steps.every((step) => Boolean(step.startedAt)) && flowGet.data.steps.every((step) => Boolean(step.finishedAt) || step.status === 'running'),
      JSON.stringify({ status: flowGet.data?.status }))

    // 组5 C-07/C-06：slaMinutes 正数校验 + skip 致 running=0 → stalled 标记 + flow.stalled 事件
    const tplZeroSla = await api('PUT', '/api/flow/templates', { token: admin, body: { code: 'tpl_zero_sla', name: '零SLA模板', slaMinutes: 0, steps: [{ key: 's1', name: '步骤1', actorType: 'human' }] } })
    check('组5 C-07：模板 upsert slaMinutes=0 → 400 含「正数」（防出生即逾期）',
      tplZeroSla.status === 400 && /正数/.test(tplZeroSla.error?.message ?? ''), `${tplZeroSla.status} ${JSON.stringify(tplZeroSla.error)}`)
    const flowZeroSla = await api('POST', '/api/flow/flows', { token: admin, body: { name: '零SLA自测流', slaMinutes: 0, steps: [{ key: 's1', name: '步骤1', actorType: 'human' }] } })
    check('组5 C-07：createFlow slaMinutes=0 → 400 含「正数」（入参与模板继承同口径）',
      flowZeroSla.status === 400 && /正数/.test(flowZeroSla.error?.message ?? ''), `${flowZeroSla.status} ${JSON.stringify(flowZeroSla.error)}`)
    const flowStall = await api('POST', '/api/flow/flows', { token: admin, body: { name: '停滞自测流（组5 C-06）', steps: [
      { key: 'a', name: '步骤A', actorType: 'human' },
      { key: 'b', name: '步骤B', actorType: 'human' },
      { key: 'c', name: '步骤C', actorType: 'human' },
    ] } })
    check('组5 C-06 前置：三步流创建（首步 running）', flowStall.ok && flowStall.data.steps[0].status === 'running', JSON.stringify(flowStall.error))
    const stallS1 = await api('POST', `/api/flow/flows/${flowStall.data.id}/steps/a/transition`, { token: admin, body: { action: 'complete' } })
    const stallSkip = await api('POST', `/api/flow/flows/${flowStall.data.id}/steps/b/transition`, { token: admin, body: { action: 'skip', note: '跳过唯一 running 步（c 仍 pending）' } })
    check('组5 C-06：skip 唯一 running 步 → running 态保留 + stalledAt 落值（不自动重跑）',
      stallSkip.ok && stallSkip.data.completed === false && stallSkip.data.flow?.status === 'running' && typeof stallSkip.data.flow?.stalledAt === 'string',
      JSON.stringify({ completed: stallSkip.data?.completed, status: stallSkip.data?.flow?.status, stalledAt: stallSkip.data?.flow?.stalledAt, err: stallSkip.error }))
    const stallDetail = await api('GET', `/api/flow/flows/${flowStall.data.id}`, { token: admin })
    check('组5 C-06：详情派生 stalled=true（stalledAt + 派生标记齐备）',
      stallDetail.ok && stallDetail.data.stalled === true && Boolean(stallDetail.data.stalledAt), JSON.stringify({ stalled: stallDetail.data?.stalled, stalledAt: stallDetail.data?.stalledAt }))
    let flowStalledEvent = null
    for (let i = 0; i < 6 && !flowStalledEvent; i++) {
      const infoProbe = await api('GET', '/api/platform/info', { token: admin })
      flowStalledEvent = (infoProbe.data?.events ?? []).find((event) => event.name === 'flow.stalled' && event.payload?.flowId === flowStall.data.id)
      if (!flowStalledEvent) await new Promise((resolve) => setTimeout(resolve, 300))
    }
    check('组5 C-06：flow.stalled 事件入总线（事件侧证：flowId/原因可查）',
      Boolean(flowStalledEvent), JSON.stringify(flowStalledEvent ?? '事件窗口未命中'))
    await api('POST', `/api/flow/flows/${flowStall.data.id}/cancel`, { token: admin, body: { note: '自测清理' } })
    // 自由编排 + 取消
    const flowAdhoc = await api('POST', '/api/flow/flows', { token: admin, body: { name: 'IAW 自由编排流', steps: [{ key: 'a', name: '步骤A', actorType: 'human' }], sceneCode: 'QB01-G-4-2' } })
    const flowCancel = await api('POST', `/api/flow/flows/${flowAdhoc.data.id}/cancel`, { token: admin, body: { note: '自测取消' } })
    check('3-1：自由编排 + 取消（status=cancelled）', flowAdhoc.ok && flowCancel.ok && flowCancel.data.status === 'cancelled', JSON.stringify(flowCancel.error))
    const afterCancel = await api('POST', `/api/flow/flows/${flowAdhoc.data.id}/steps/a/transition`, { token: admin, body: { action: 'start' } })
    check('3-1：已结束 TF 步骤不可流转', afterCancel.status === 400 && /已结束/.test(afterCancel.error.message), JSON.stringify(afterCancel.error))
    const flowList = await api('GET', '/api/flow/flows?sceneCode=QB01-G-4-1&status=completed', { token: iawMemberToken })
    check('3-1：TF 列表按场景+状态过滤（视图字段 progress/slaBreached 随行）',
      flowList.ok && flowList.data.flows.some((item) => item.id === flowId && Number.isFinite(item.progress) && item.slaBreached === false),
      JSON.stringify(flowList.data?.flows?.length))
  }

  // ================================================================ 执行中枢（R8/R9 + E1-E7）与治理收口（R3/R4/R10/R11）
  section('执行中枢：目标血缘 / 任务执行锁 / 心跳唤醒 / 例行调度（R8/R9，E1-E7）')
  {
    // -- E4/R8 目标树与项目 ---------------------------------------------------
    const exGoal = await api('POST', '/api/exec/goals', { token: admin, body: { title: '自测目标：质检人效', metric: '人均日质检量', metricBaseline: 1000, metricTarget: 1300, metricUnit: '件' } })
    check('R8：创建目标（指标基线/目标/单位）', exGoal.ok && exGoal.data.metric === '人均日质检量', JSON.stringify(exGoal.error ?? {}))
    const exChild = await api('POST', '/api/exec/goals', { token: admin, body: { title: '自测子目标：误检率', parentGoalId: exGoal.data.id, metric: '误检率', metricBaseline: 5, metricTarget: 2, metricUnit: '%' } })
    check('R8：子目标挂父（目标树）', exChild.ok && exChild.data.parentGoalId === exGoal.data.id)
    const exCyclePatch = await api('PATCH', `/api/exec/goals/${exGoal.data.id}`, { token: admin, body: { parentGoalId: exChild.data.id } })
    check('R8：目标父链成环被拒', exCyclePatch.status === 400 && /成环/.test(exCyclePatch.error?.message ?? ''), JSON.stringify(exCyclePatch.error ?? {}).slice(0, 120))
    const exProject = await api('POST', '/api/exec/projects', { token: admin, body: { goalId: exChild.data.id, name: '自测项目：视觉质检', repos: ['https://example.com/qc.git'] } })
    check('E4：项目挂目标（repos 落库）', exProject.ok && exProject.data.goalId === exChild.data.id && exProject.data.repos.length === 1)

    // -- #16（2026-10-29）组织血缘：缺省继承 / 显式空串拒绝 / ?orgId= 过滤 ------------------
    const exOrgId = exGoal.data.orgId
    check('#16：目标缺省创建必带组织归属（principal→血缘→根组织继承链，不再空串落库）',
      typeof exOrgId === 'string' && exOrgId !== '', JSON.stringify(exOrgId))
    const exEmptyOrg = await api('POST', '/api/exec/goals', { token: admin, body: { title: '自测目标：空组织应拒绝', orgId: '' } })
    check('#16：显式空 orgId 一律 400（空串不再是合法归属）', exEmptyOrg.status === 400, JSON.stringify(exEmptyOrg.error ?? {}).slice(0, 120))
    const exIssueNoOrg = await api('POST', '/api/exec/issues', { token: admin, body: { title: '自测任务：无项目无指派（组织兜底）', priority: 'P3' } })
    check('#16：裸任务缺省创建兜底组织归属', exIssueNoOrg.ok && typeof exIssueNoOrg.data.orgId === 'string' && exIssueNoOrg.data.orgId !== '', JSON.stringify(exIssueNoOrg.data?.orgId))
    const exIssuesByOrg = await api('GET', `/api/exec/issues?orgId=${encodeURIComponent(exIssueNoOrg.data.orgId)}`, { token: admin })
    check('#16：任务列表 ?orgId= 过滤命中（组织范围看板数据面）',
      exIssuesByOrg.ok && exIssuesByOrg.data.issues.some((item) => item.id === exIssueNoOrg.data.id))
    const exGoalsByOrg = await api('GET', `/api/exec/goals?orgId=${encodeURIComponent(exOrgId)}`, { token: admin })
    check('#16：目标列表 ?orgId= 过滤命中', exGoalsByOrg.ok && exGoalsByOrg.data.goals.some((item) => item.id === exGoal.data.id))

    // -- E2/E3 任务执行锁 + 唤醒派发 --------------------------------------------
    const exAgents = (await api('GET', '/api/agents', { token: admin })).data.agents
    const exAgent = exAgents.find((a) => a.status === 'online' || a.status === 'trial')
    check('E3 前置：存在运行态 Agent 可派发', Boolean(exAgent))
    const exIssue = await api('POST', '/api/exec/issues', { token: admin, body: { projectId: exProject.data.id, title: '自测任务：采集通道打通', priority: 'P1', assigneeAgentId: exAgent.id } })
    check('E2：任务创建（goalAncestry 写时物化 = 父目标→子目标→项目）',
      exIssue.ok && JSON.stringify(exIssue.data.goalAncestry) === JSON.stringify([exGoal.data.id, exChild.data.id, exProject.data.id]),
      JSON.stringify(exIssue.data?.goalAncestry))
    const exPending1 = (await api('GET', '/api/exec/wakes?status=pending', { token: admin })).data.wakes
    check('E3：assign 触发源自动入队唤醒', exPending1.some((w) => w.issueId === exIssue.data.id && w.trigger === 'assign'))
    const exTick1 = await api('POST', '/api/exec/tick', { token: admin })
    check('E3：tick 派发成功（治理前置全过后 woken≥1）', exTick1.ok && exTick1.data.woken >= 1, JSON.stringify(exTick1.data))
    const exIssueLocked = (await api('GET', `/api/exec/issues?projectId=${exProject.data.id}`, { token: admin })).data.issues.find((i) => i.id === exIssue.data.id)
    check('E2：CAS 取锁成功（executionRunId 落值，任务 todo→in_progress）',
      exIssueLocked.status === 'in_progress' && Boolean(exIssueLocked.executionRunId), JSON.stringify({ status: exIssueLocked.status, run: exIssueLocked.executionRunId }))
    const exRun = (await api('GET', '/api/exec/runs?status=running', { token: admin })).data.runs.find((r) => r.id === exIssueLocked.executionRunId)
    check('E2/E4：run 登记上下文包（为什么而干注入）', Boolean(exRun) && /本任务服务于/.test(exRun.contextPack ?? ''), (exRun?.contextPack ?? '').slice(0, 80))
    // 同主体二唤（语义变更依据：租约幂等化——附录 A 决策 3，2026-10-15 总负责人裁决）：
    // 同主体重复唤醒不再进延迟队列，改为 coalesce 幂等并入既有 run
    // （wake 状态 run + runId 即执行锁 run + 不新增 run + 本 issue 延迟队列保持为空）
    await api('POST', `/api/exec/issues/${exIssue.data.id}/wake`, { token: admin, body: { reason: '二唤验证' } })
    await api('POST', '/api/exec/tick', { token: admin })
    const exSecondWake = (await api('GET', '/api/exec/wakes?status=run', { token: admin })).data.wakes.filter((w) => w.issueId === exIssue.data.id)
    const exDeferredSame = (await api('GET', '/api/exec/wakes?status=deferred_issue_execution', { token: admin })).data.wakes.filter((w) => w.issueId === exIssue.data.id)
    const exRunStillSame = (await api('GET', '/api/exec/runs?status=running', { token: admin })).data.runs.some((r) => r.id === exIssueLocked.executionRunId)
    check('E2/E3：同主体二唤幂等并入既有 run（coalesce：wake 状态 run + runId 即执行锁 run + 不新增 run + 延迟队列空）',
      exSecondWake.length >= 1 && exSecondWake.every((w) => w.runId === exIssueLocked.executionRunId)
      && exDeferredSame.length === 0 && exRunStillSame,
      JSON.stringify({ secondWakes: exSecondWake.map((w) => w.runId), lockRun: exIssueLocked.executionRunId, deferred: exDeferredSame.length }))
    await api('PATCH', `/api/exec/issues/${exIssue.data.id}`, { token: admin, body: { assigneeAgentId: exAgent.id } })
    const exPendingAfterReassign = (await api('GET', '/api/exec/wakes?status=pending', { token: admin })).data.wakes.filter((w) => w.issueId === exIssue.data.id)
    check('E3：同小时桶重复指派不重复唤醒（幂等键去重）', exPendingAfterReassign.length === 0, `pending=${exPendingAfterReassign.length}`)
    // 跨主体二唤（语义变更依据同上：租约幂等化——附录 A 决策 3，2026-10-15 总负责人裁决）：
    // coalesce 仅限同主体；换派第二 Agent 后再唤，不满足同主体条件 → 仍进延迟队列
    const exAgentBReg = await api('POST', '/api/agents', { token: admin, body: { name: '自测跨主体二唤机器人', attrs: { description: 'E2/E3 跨主体二唤场景专用', model: 'deepseek-chat', riskLevel: 'low', dataClass: 'internal', entryUrl: 'https://bot.example.com/g7-cross-wake' } } })
    const exAgentB = exAgentBReg.data?.agent
    if (exAgentB?.id) {
      // 运行态（draft→online 为 L4）：发起上线审批并由异人批准（R12 职责分离，借 E6/市场既有模式；
      // 上线门禁以 entryUrl 免登通道满足 SSO 纳管要求）
      await api('POST', `/api/agents/${exAgentB.id}/transition`, { token: admin, body: { action: 'online' } })
      const exAgentBApproval = (await api('GET', '/api/approvals', { token: admin })).data.approvals.find((a) => a.kind === 'agent.online' && a.payload?.agentId === exAgentB.id)
      if (exAgentBApproval?.id) {
        await api('POST', `/api/approvals/${exAgentBApproval.id}/decide`, { token: approver, body: { decision: 'approve', opinion: 'E2/E3 跨主体二唤场景上线', confirmed: true, finalReview: true } })
        // 统一准入要求机器主体持 exec.write（D06 权限门）：给注册即颁发的 principal 补授权点
        await api('PATCH', `/api/authn/principals/${exAgentBReg.data.credential.principalId}`, { token: admin, body: { scopes: ['exec.write'] } })
        await api('PATCH', `/api/exec/issues/${exIssue.data.id}`, { token: admin, body: { assigneeAgentId: exAgentB.id } })
        await api('POST', `/api/exec/issues/${exIssue.data.id}/wake`, { token: admin, body: { reason: '跨主体二唤验证' } })
        await api('POST', '/api/exec/tick', { token: admin })
        const exDeferredCross = (await api('GET', '/api/exec/wakes?status=deferred_issue_execution', { token: admin })).data.wakes.filter((w) => w.issueId === exIssue.data.id)
        const exAllWakesDiag = (await api('GET', '/api/exec/wakes', { token: admin })).data.wakes.filter((w) => w.issueId === exIssue.data.id)
        check('E2/E3：跨主体二唤进延迟队列（deferred_issue_execution 具名态）',
          exDeferredCross.length >= 1,
          JSON.stringify({ deferred: exDeferredCross.length, all: exAllWakesDiag.map((w) => ({ trigger: w.trigger, status: w.status, agent: w.agentId, err: (w.lastError ?? '').slice(0, 80) })) }))
      } else {
        check('E2/E3：跨主体二唤进延迟队列（deferred_issue_execution 具名态）', false, `上线审批单创建失败：${JSON.stringify(exAgentBOnline.error ?? exAgentBOnline).slice(0, 140)}`)
      }
    } else {
      check('E2/E3：跨主体二唤进延迟队列（deferred_issue_execution 具名态）', false, `第二 Agent 注册失败：${JSON.stringify(exAgentBReg.error ?? {}).slice(0, 120)}`)
    }
    await api('POST', `/api/exec/issues/${exIssue.data.id}/transition`, { token: admin, body: { to: 'review' } })
    const exDone = await api('POST', `/api/exec/issues/${exIssue.data.id}/transition`, { token: admin, body: { to: 'done' } })
    const exIssueDone = (await api('GET', `/api/exec/issues?projectId=${exProject.data.id}`, { token: admin })).data.issues.find((i) => i.id === exIssue.data.id)
    check('E2：done 收尾自动完结 run 并释放执行锁', exDone.ok && exIssueDone.status === 'done' && !exIssueDone.executionRunId, JSON.stringify({ status: exIssueDone.status }))

    // -- E6 审批门禁（P0 高危任务） ---------------------------------------------
    const exP0 = await api('POST', '/api/exec/issues', { token: admin, body: { projectId: exProject.data.id, title: '自测任务：P0 门禁', priority: 'P0', assigneeAgentId: exAgent.id } })
    await api('POST', `/api/exec/issues/${exP0.data.id}/wake`, { token: admin, body: { reason: 'P0 门禁验证' } })
    await api('POST', '/api/exec/tick', { token: admin })
    const exP0After = (await api('GET', `/api/exec/issues?projectId=${exProject.data.id}`, { token: admin })).data.issues.find((i) => i.id === exP0.data.id)
    const exP0Approval = (await api('GET', '/api/approvals', { token: admin })).data.approvals.find((a) => a.kind === 'exec.issue.run' && a.payload?.issueId === exP0.data.id)
    check('E6：P0 任务执行前自动挂 exec.issue.run 审批（挂单不派发）',
      exP0After.status === 'todo' && Boolean(exP0Approval), JSON.stringify({ status: exP0After.status, approval: Boolean(exP0Approval) }))
    const exP0Decide = await api('POST', `/api/approvals/${exP0Approval.id}/decide`, { token: approver, body: { decision: 'approve', confirmed: true, finalReview: true } })
    check('E6：P0 审批异人通过（executed）', exP0Decide.ok && exP0Decide.data.status === 'executed', JSON.stringify(exP0Decide.error ?? {}).slice(0, 120))
    await api('POST', '/api/exec/tick', { token: admin })
    const exP0Final = (await api('GET', `/api/exec/issues?projectId=${exProject.data.id}`, { token: admin })).data.issues.find((i) => i.id === exP0.data.id)
    check('E6：审批放行后派发（锁落值 in_progress）', exP0Final.status === 'in_progress' && Boolean(exP0Final.executionRunId), JSON.stringify({ status: exP0Final.status }))
    await api('POST', `/api/exec/issues/${exP0.data.id}/transition`, { token: admin, body: { to: 'review' } })
    await api('POST', `/api/exec/issues/${exP0.data.id}/transition`, { token: admin, body: { to: 'done' } })

    // -- E7 例行三源（webhook 面 + cron 词法） -----------------------------------
    const exRoutine = await api('POST', '/api/exec/routines', { token: admin, body: { agentId: exAgent.id, name: '自测 webhook 例行', kind: 'webhook', webhookPath: 'qa-hook-selftest-2026' } })
    check('E7：webhook 例行登记（路径即凭证）', exRoutine.ok && exRoutine.data.webhookPath === 'qa-hook-selftest-2026')
    const exCronBad = await api('POST', '/api/exec/routines', { token: admin, body: { agentId: exAgent.id, name: '自测坏 cron', kind: 'cron', cron: '* * * *' } })
    check('E7：cron 表达式词法校验拒绝（5 段制）', exCronBad.status === 400, JSON.stringify(exCronBad.error ?? {}).slice(0, 100))
    const exHookHit = await rawReq('POST', '/api/exec/webhook/qa-hook-selftest-2026', { headers: { 'content-type': 'application/json' }, body: '{}' })
    check('E7：webhook 匿名触发入队（200 + wakeId）', exHookHit.status === 200 && jsonBody(exHookHit).ok === true, exHookHit.body.slice(0, 120))
    const exHookMiss = await rawReq('POST', '/api/exec/webhook/not-registered-path', { headers: { 'content-type': 'application/json' }, body: '{}' })
    check('E7：未登记路径 404 fail-closed（不泄露存在性）', exHookMiss.status === 404)

    // -- E2 僵尸锁回收（EXEC_LOCK_TIMEOUT_MS=2500 压缩口径） ----------------------
    const exZ = await api('POST', '/api/exec/issues', { token: admin, body: { projectId: exProject.data.id, title: '自测任务：僵尸锁回收', priority: 'P2', assigneeAgentId: exAgent.id } })
    await api('POST', `/api/exec/issues/${exZ.data.id}/wake`, { token: admin, body: { reason: '僵尸锁验证' } })
    await api('POST', '/api/exec/tick', { token: admin })
    const exZLocked = (await api('GET', `/api/exec/issues?projectId=${exProject.data.id}`, { token: admin })).data.issues.find((i) => i.id === exZ.data.id)
    check('E2：僵尸锁靶任务先取锁', Boolean(exZLocked.executionRunId), JSON.stringify({ status: exZLocked.status }))
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const exZTick = await api('POST', '/api/exec/tick', { token: admin })
    // 回收后同 tick 的延迟唤醒会立即重新派发并取新锁（设计内行为：回收的是僵尸，不压制合法等待者）
    // ——断言锚定在回收证据本身：reclaimed 计数 + 旧 run 落 timeout 终态
    const exTimeoutRun = (await api('GET', '/api/exec/runs?status=timeout', { token: admin })).data.runs.find((r) => r.id === exZLocked.executionRunId)
    check('E2：僵尸锁超时强制回收（旧 run 落 timeout 终态 + reclaimed 计数）',
      exZTick.data.reclaimed >= 1 && Boolean(exTimeoutRun), `reclaimed=${exZTick.data.reclaimed} timeoutRun=${Boolean(exTimeoutRun)}`)

    // -- E5 exec_lineage + R9 健康度总览 ----------------------------------------
    const exLineage = await api('GET', `/api/exec/lineage/${exIssue.data.id}`, { token: admin })
    check('E5：血缘视图（目标→项目→任务，exec_lineage 工具同源）',
      exLineage.ok && exLineage.data.goal?.id === exChild.data.id && exLineage.data.project?.id === exProject.data.id, JSON.stringify(exLineage.error ?? {}))
    const exOverview = await api('GET', '/api/exec/overview', { token: admin })
    check('R9：总览（健康度五档枚举 + 锁/唤醒计数齐备）',
      exOverview.ok && Array.isArray(exOverview.data.agentsHealth) && exOverview.data.agentsHealth.length > 0
      && exOverview.data.agentsHealth.every((a) => ['healthy', 'stale', 'silent', 'frozen', 'offline'].includes(a.health)),
      JSON.stringify(exOverview.data?.agentsHealth?.length))
    const exHbAgent = exOverview.data.agentsHealth.find((a) => a.agentId === exAgent.id)
    check('R9：被派发 Agent 有心跳留痕（健康度 healthy/stale）', ['healthy', 'stale'].includes(exHbAgent?.health), JSON.stringify(exHbAgent))

    // -- issue #7 回归：只读主体心跳解耦（exec.read 即可存活，不再被 exec.write 拦成 failed） --
    const roAgentRes = await api('POST', '/api/agents', { token: admin, body: { name: '自测只读官', attrs: { description: '只读主体心跳解耦自测（评价官/验收官形态：职责分离要求只读）', model: 'deepseek-chat', riskLevel: 'low', trialGroups: ['灰度试点组'] } } })
    const roAgent = roAgentRes.data.agent
    const roPrincipalId = (await api('GET', `/api/agents/${roAgent.id}`, { token: admin })).data.credential?.principalId
    check('#7 前置：只读官注册并取得机器主体', roAgentRes.ok && Boolean(roPrincipalId), JSON.stringify(roAgentRes.error ?? {}))
    const roStrip = await api('PATCH', `/api/authn/principals/${roPrincipalId}`, { token: admin, body: { scopes: ['exec.read'] } })
    check('#7 前置：机器主体收敛为只读（仅 exec.read）', roStrip.ok, JSON.stringify(roStrip.error))
    const roTrial = await api('POST', `/api/agents/${roAgent.id}/transition`, { token: admin, body: { action: 'submit_trial' } })
    check('#7 前置：只读官进入试运行（运行态参与心跳调度）', roTrial.ok, JSON.stringify(roTrial.error))
    await api('PATCH', `/api/agents/${roAgent.id}`, { token: admin, body: { attrs: { heartbeatIntervalMinutes: 30 } } })
    const roTick = await api('POST', '/api/exec/tick', { token: admin })
    check('#7 前置：tick 入队并处理心跳唤醒', roTick.ok, JSON.stringify(roTick.data ?? roTick.error))
    const roWake = (await api('GET', '/api/exec/wakes', { token: admin })).data.wakes.find((w) => w.agentId === roAgent.id && w.trigger === 'routine')
    check('#7：只读主体心跳唤醒以 done 收尾（skipped_no_todo 路径），不再 status=failed',
      Boolean(roWake) && roWake.status === 'done' && !(roWake.lastError ?? '').includes('exec'), JSON.stringify(roWake ?? {}))
    // 对照：任务执行路径的 exec.write 收口不动——把只读官设为 P1 任务负责人，唤醒应在联动③b 被拒
    const roIssue = await api('POST', '/api/exec/issues', { token: admin, body: { projectId: exProject.data.id, title: '自测任务：只读官不应被派发', priority: 'P1', assigneeAgentId: roAgent.id } })
    await api('POST', '/api/exec/tick', { token: admin })
    const roIssueWake = (await api('GET', '/api/exec/wakes', { token: admin })).data.wakes.find((w) => w.issueId === roIssue.data.id)
    check('#7 对照：issue 派发路径仍要求 exec.write（无写权限 → failed，写权限不放宽）',
      Boolean(roIssueWake) && roIssueWake.status === 'failed' && /exec\.write/.test(roIssueWake.lastError ?? ''), JSON.stringify(roIssueWake ?? {}))
    await api('POST', `/api/exec/issues/${roIssue.data.id}/transition`, { token: admin, body: { to: 'cancelled' } })

    // -- R10 Agent 主体预算：熔断 → 联动冻结 → L4 解冻审批 → 恢复 ----------------
    const exBudget = await api('PUT', '/api/modelgw/budgets', { token: admin, body: { subject: `agent:${exAgent.id}`, dailyLimitCents: 0, action: 'block', freezeAgent: true } })
    check('R10：Agent 主体预算登记（0 元 block + freezeAgent 联动）', exBudget.ok && exBudget.data.subject === `agent:${exAgent.id}`)
    const exFreezeIssue = await api('POST', '/api/exec/issues', { token: admin, body: { projectId: exProject.data.id, title: '自测任务：预算熔断', priority: 'P2', assigneeAgentId: exAgent.id } })
    await api('POST', `/api/exec/issues/${exFreezeIssue.data.id}/wake`, { token: admin, body: { reason: '预算验证' } })
    await api('POST', '/api/exec/tick', { token: admin })
    const exFroze = (await api('GET', '/api/agents', { token: admin })).data.agents.find((a) => a.id === exAgent.id)
    check('R10：预算前置熔断 → 联动冻结（frozenAt 落值）', Boolean(exFroze.attrs.frozenAt), JSON.stringify(exFroze.attrs.frozenAt))
    const exUnfreezeApproval = (await api('GET', '/api/approvals', { token: admin })).data.approvals.find((a) => a.kind === 'agent.unfreeze' && a.payload?.agentId === exAgent.id && a.status === 'pending')
    check('R10：冻结联动生成 agent.unfreeze L4 审批单（orgId 自动推导）', Boolean(exUnfreezeApproval) && Boolean(exUnfreezeApproval.orgId))
    const exFailedWake = (await api('GET', '/api/exec/wakes?status=failed', { token: admin })).data.wakes.find((w) => w.issueId === exFreezeIssue.data.id)
    check('E6/R10：熔断唤醒失败留痕（lastError 含预算）', Boolean(exFailedWake) && /预算/.test(exFailedWake.lastError ?? ''), exFailedWake?.lastError ?? '')
    const exLogs = await api('GET', '/api/audit/logs?limit=200', { token: admin })
    check('E6：预算拒绝审计留痕（exec.wakeup.budget_denied）',
      exLogs.ok && JSON.stringify(exLogs.data).includes('exec.wakeup.budget_denied'), '')
    const exUnfreeze = await api('POST', `/api/approvals/${exUnfreezeApproval.id}/decide`, { token: approver, body: { decision: 'approve', confirmed: true, finalReview: true } })
    check('R10：解冻审批异人通过（executed）', exUnfreeze.ok && exUnfreeze.data.status === 'executed', JSON.stringify(exUnfreeze.error ?? {}).slice(0, 120))
    const exThawed = (await api('GET', '/api/agents', { token: admin })).data.agents.find((a) => a.id === exAgent.id)
    check('R10：审批执行器解冻生效（frozenAt 清空）', exThawed.attrs.frozenAt === undefined)
    const exBudgetDel = await api('DELETE', `/api/modelgw/budgets/${exBudget.data.id}`, { token: admin })
    check('R4：预算 DELETE 路由可用（联动验证后清理）', exBudgetDel.ok)
    await api('POST', `/api/exec/issues/${exFreezeIssue.data.id}/wake`, { token: admin, body: { reason: '解冻后复派' } })
    await api('POST', '/api/exec/tick', { token: admin })
    const exRefinal = (await api('GET', `/api/exec/issues?projectId=${exProject.data.id}`, { token: admin })).data.issues.find((i) => i.id === exFreezeIssue.data.id)
    check('R10：解冻后恢复派发（治理闭环回绿）', exRefinal.status === 'in_progress' && Boolean(exRefinal.executionRunId), JSON.stringify({ status: exRefinal.status }))
    await api('POST', `/api/exec/issues/${exFreezeIssue.data.id}/transition`, { token: admin, body: { to: 'review' } })
    await api('POST', `/api/exec/issues/${exFreezeIssue.data.id}/transition`, { token: admin, body: { to: 'done' } })

    // -- R3 modelSlug='*' 通配 + invoke 熔断 ------------------------------------
    const exModel = await api('POST', '/api/modelgw/models', { token: admin, body: { slug: 'qa-wildcard-model', endpoint: `http://127.0.0.1:${GH_PORT}/v1`, provider: 'stub', costCentsPerKTokens: 1, status: 'online', dataClassLimit: 'secret' } })
    check('R3 前置：登记自测模型', exModel.ok, JSON.stringify(exModel.error ?? {}).slice(0, 100))
    const exWild = await api('PUT', '/api/modelgw/budgets', { token: admin, body: { orgId: newOrg.data.id, modelSlug: '*', dailyLimitCents: 0, action: 'block' } })
    check("R3 前置：登记 '*' 通配预算（QA 组织 0 元 block）", exWild.ok)
    // 组3：budgetStatusFor 通配 '*' 计入 org 进度——只配通配预算的组织摘要 budget 不再恒 null
    const wildSummary = await api('GET', `/api/usage/summary?window=today&org=${encodeURIComponent(newOrg.data.id)}`, { token: admin })
    check("组3 B10：只配 modelSlug='*' block 预算的组织 → summary budget.daily.breached === true（通配计入 org 进度）",
      wildSummary.ok && wildSummary.data.budget?.daily?.limitCents === 0 && wildSummary.data.budget?.daily?.breached === true,
      JSON.stringify(wildSummary.data?.budget ?? wildSummary.error))
    const exWildInvoke = await api('POST', '/api/modelgw/invoke', { token: admin, body: { model: 'qa-wildcard-model', orgId: newOrg.data.id, messages: [{ role: 'user', content: '通配验证' }] } })
    check("R3：modelSlug='*' 通配命中任意模型（字面量模型名被通配预算熔断）",
      !exWildInvoke.ok && /预算/.test(exWildInvoke.error?.message ?? ''), JSON.stringify(exWildInvoke.error ?? {}).slice(0, 160))
    await api('DELETE', `/api/modelgw/budgets/${exWild.data.id}`, { token: admin })
    const exWildInvoke2 = await api('POST', '/api/modelgw/invoke', { token: admin, body: { model: 'qa-wildcard-model', orgId: newOrg.data.id, messages: [{ role: 'user', content: '通配删除后' }] } })
    check('R3 后续：删除通配预算后不再熔断（错误面走到上游调用层）',
      !exWildInvoke2.ok && !/预算/.test(exWildInvoke2.error?.message ?? ''), JSON.stringify(exWildInvoke2.error ?? {}).slice(0, 120))

    // -- R4 角色删除面 + R11 清单收口（selftest 口径） ----------------------------
    const exRole = await api('POST', '/api/iam/roles', { token: admin, body: { code: 'qa_exec_del_role', name: '自测删除角色', permissions: ['console.login'] } })
    check('R4 前置：创建自定义角色', exRole.ok)
    const exRoleDel = await api('DELETE', `/api/iam/roles/${exRole.data.id}`, { token: admin })
    check('R4：无挂载自定义角色可删除', exRoleDel.ok)
    const exMemberRole = (await api('GET', '/api/iam/roles', { token: admin })).data.roles.find((r) => r.code === 'member')
    const exBuiltinDel = await api('DELETE', `/api/iam/roles/${exMemberRole.id}`, { token: admin })
    check('R4：内置角色删除被拒', exBuiltinDel.status === 400, JSON.stringify(exBuiltinDel.error ?? {}).slice(0, 100))
    const exActiveUser = (await api('GET', '/api/iam/users', { token: admin })).data.users.find((u) => u.status === 'active')
    const exUserDel = await api('DELETE', `/api/iam/users/${exActiveUser.id}`, { token: admin })
    check('R4：在职账号物理删除被拒（仅已注销可删）', exUserDel.status === 400, JSON.stringify(exUserDel.error ?? {}).slice(0, 100))
    const exAdminAgents = (await api('GET', '/api/agents', { token: admin })).data.agents
    const exDevAgents = (await api('GET', '/api/agents', { token: dev })).data.agents
    check('R11：非 * 管理员 Agent 台账按组织子树收敛', exDevAgents.length < exAdminAgents.length, `admin=${exAdminAgents.length} dev=${exDevAgents.length}`)
    const exDevOrgs = (await api('GET', '/api/iam/orgs', { token: dev })).data
    check('R11：组织清单按子树收敛（dev 仅见本组织）', Array.isArray(exDevOrgs) && exDevOrgs.length < (await api('GET', '/api/iam/orgs', { token: admin })).data.length, `dev=${exDevOrgs.length}`)
    const exCross = exAdminAgents.find((a) => !exDevAgents.some((d) => d.id === a.id) && a.orgId)
    if (exCross) {
      const exCrossProbe = await api('GET', `/api/agents?org=${exCross.orgId}`, { token: dev })
      check('R11：越界 ?org= 显式 403（不静默收窄）', exCrossProbe.status === 403, `status=${exCrossProbe.status}`)
    }

    // 清理：exec 自测实体（项目须先清任务）
    for (const issue of (await api('GET', `/api/exec/issues?projectId=${exProject.data.id}`, { token: admin })).data.issues) {
      if (issue.executionRunId) await api('POST', `/api/exec/issues/${issue.id}/transition`, { token: admin, body: { to: 'cancelled' } })
      await api('DELETE', `/api/exec/issues/${issue.id}`, { token: admin })
    }
    await api('DELETE', `/api/exec/routines/${exRoutine.data.id}`, { token: admin })
    await api('DELETE', `/api/exec/projects/${exProject.data.id}`, { token: admin })
    await api('DELETE', `/api/exec/goals/${exChild.data.id}`, { token: admin })
    await api('DELETE', `/api/exec/goals/${exGoal.data.id}`, { token: admin })
    await api('DELETE', '/api/modelgw/models/' + exModel.data.id, { token: admin })
    const exCleanup = await api('GET', '/api/exec/goals', { token: admin })
    check('执行中枢自测实体清理完成（目标树清空）', exCleanup.data.goals.every((g) => !g.title.startsWith('自测目标')), `剩余 ${exCleanup.data.goals.length} 目标`)
  }

  // ================================================================ QA-20260912 修复批次回归（A-03 / A-04 / A-08 / B-04）
  console.log('\n\x1b[36m━━ QA-20260912 修复批次回归（A-03 / A-04 / A-08 / B-04） ━━\x1b[0m')

  // A-08：建号口令强度（'123' 不可建号，与重置口径统一）
  const weakPwCreate = await api('POST', '/api/iam/users', { token: admin, body: { username: 'qaweak01', displayName: '弱口令靶子', orgId: newOrg.data.id, password: '123' } })
  check('弱口令建号被拒（QA A-08：≥8 位统一口径）', !weakPwCreate.ok && /8 位/.test(weakPwCreate.error?.message ?? ''), JSON.stringify(weakPwCreate.error ?? {}))

  // A-03：org_admin 组织隔离（服务层补栏）
  const roleListQa = (await api('GET', '/api/iam/roles', { token: admin })).data.roles
  const orgAdminRole = roleListQa.find((role) => role.code === 'org_admin')
  const qaOrgAdminCreate = await api('POST', '/api/iam/users', { token: admin, body: { username: 'qaorgadmin', displayName: 'QA部门管理员', orgId: newOrg.data.id, password: 'Ybk@2026', roleIds: [orgAdminRole.id] } })
  check('QA部门管理员建号（org_admin，归属自测事业部）', qaOrgAdminCreate.ok, JSON.stringify(qaOrgAdminCreate.error ?? {}))
  const qaOrgAdminLogin = await api('POST', '/api/auth/login', { body: { username: 'qaorgadmin', password: 'Ybk@2026' } })
  const qaOrgAdmin = qaOrgAdminLogin.data.token
  const qaBatch01 = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('batch01'), { token: admin })).data.users[0]
  const qaInsideReset = await api('POST', `/api/iam/users/${qaBatch01.id}/reset-password`, { token: qaOrgAdmin })
  check('org_admin 可管理本组织子树内账号（QA A-03 正向）', qaInsideReset.ok && typeof qaInsideReset.data.initialPassword === 'string', JSON.stringify(qaInsideReset.error ?? {}))
  const qaCascadeUser = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('cascadeu01'), { token: admin })).data.users[0]
  const qaOutsideReset = await api('POST', `/api/iam/users/${qaCascadeUser.id}/reset-password`, { token: qaOrgAdmin })
  check('org_admin 跨组织接管被拒（QA A-03：服务层组织隔离）', !qaOutsideReset.ok && /组织隔离|组织子树/.test(qaOutsideReset.error?.message ?? ''), JSON.stringify(qaOutsideReset.error ?? {}))

  // 组1 N4：REST 管理面包扎——跨组织拒绝回写 403 FORBIDDEN（鉴权语义而非 400 请求格式错误）
  const qaOutsideFreeze = await api('POST', `/api/iam/users/${qaCascadeUser.id}/freeze`, { token: qaOrgAdmin, body: { reason: '组1 N4：跨组织冻结探针' } })
  check('组1 A2：org_admin REST freeze 他组织 → 403 + error code FORBIDDEN（manageScope 包扎）',
    qaOutsideFreeze.status === 403 && qaOutsideFreeze.error?.code === 'FORBIDDEN' && /组织隔离|组织子树/.test(qaOutsideFreeze.error?.message ?? ''),
    `${qaOutsideFreeze.status} ${JSON.stringify(qaOutsideFreeze.error)}`)

  // 组1 N3：GET /api/iam/users 非平台管理员自动收敛管辖组织子树；?orgId= 越子树显式 403
  const qaScopeList = await api('GET', '/api/iam/users', { token: qaOrgAdmin })
  const qaScopeOrgIds = new Set((await api('GET', '/api/iam/orgs', { token: qaOrgAdmin })).data.map((org) => org.id))
  check('组1 A3：org_admin 账号清单全部落在其管辖组织子树内（含子组织收敛）',
    qaScopeList.ok && qaScopeList.data.users.length >= 1 && qaScopeList.data.users.every((user) => qaScopeOrgIds.has(user.orgId)),
    JSON.stringify({ total: qaScopeList.data?.total, outside: (qaScopeList.data?.users ?? []).filter((u) => !qaScopeOrgIds.has(u.orgId)).map((u) => u.username).slice(0, 5) }))
  const qaScopeLeak = qaScopeList.data.users.some((user) => ['linxm', 'admin', 'cascadeu01'].includes(user.username))
  check('组1 A3：他组织账号不出现在 org_admin 清单（admin/linxm/cascadeu01 零泄漏）', !qaScopeLeak)
  const qaScopeOutside = await api('GET', `/api/iam/users?orgId=${encodeURIComponent(siblingOrg.data.id)}`, { token: qaOrgAdmin })
  check('组1 A3：?orgId= 子树外 → 403 FORBIDDEN（越界不静默收窄）',
    qaScopeOutside.status === 403 && qaScopeOutside.error?.code === 'FORBIDDEN', `${qaScopeOutside.status} ${JSON.stringify(qaScopeOutside.error)}`)
  const qaScopeInside = await api('GET', `/api/iam/users?orgId=${encodeURIComponent(newOrg.data.id)}`, { token: qaOrgAdmin })
  check('组1 A3：?orgId= 子树内 → 正常返回（全部命中该组织）',
    qaScopeInside.ok && qaScopeInside.data.users.length >= 1 && qaScopeInside.data.users.every((user) => user.orgId === newOrg.data.id), JSON.stringify(qaScopeInside.error))

  // 组1 N1/组2 桥 _actor：org_admin 经 POST /api/tools/execute 调 iam_user_freeze——服务端注入身份，
  // 客户端伪造 _actor/actor 剥离重注入（行为不变），子树内放行
  const qaBridgeInsideTarget = await api('POST', '/api/iam/users', { token: admin, body: { username: 'qabridgetgt', displayName: '桥冻结靶子', orgId: newOrg.data.id, password: 'Ybk@2026' } })
  check('组1 A1 前置：桥冻结靶子（org_admin 子树内）建号', qaBridgeInsideTarget.ok, JSON.stringify(qaBridgeInsideTarget.error ?? {}))
  const qaBridgeInside = await api('POST', '/api/tools/execute', { token: qaOrgAdmin, body: { name: 'iam_user_freeze', args: { userId: qaBridgeInsideTarget.data.id, reason: '组1 A1：子树内冻结' } } })
  check('组1 A1：org_admin 经工具桥冻结本组织子树内账号成功',
    qaBridgeInside.ok && qaBridgeInside.data.isError === false && qaBridgeInside.data.value?.status === 'frozen', JSON.stringify(qaBridgeInside.data ?? qaBridgeInside.error))
  const qaBridgeForged = await api('POST', '/api/tools/execute', { token: qaOrgAdmin, body: { name: 'iam_user_freeze', args: { userId: qaCascadeUser.id, reason: '组1 A1：伪造身份越权冻结', _actor: { platformAdmin: true }, actor: '伪造操作者' } } })
  check('组1 A1：伪造 args._actor={platformAdmin:true} 被剥离重注入（仍按服务端身份拒绝组织隔离）',
    qaBridgeForged.ok && qaBridgeForged.data.isError === true && /组织隔离|组织子树/.test(qaBridgeForged.data.error?.message ?? ''),
    JSON.stringify(qaBridgeForged.data ?? qaBridgeForged.error))
  const qaBridgeForgedInside = await api('POST', '/api/tools/execute', { token: qaOrgAdmin, body: { name: 'iam_user_reset_password', args: { userId: qaBatch01.id, _actor: { platformAdmin: true } } } })
  check('组1 A1：伪造 _actor 不改变正常路径行为（子树内重置口令仍成功）',
    qaBridgeForgedInside.ok && qaBridgeForgedInside.data.isError === false && typeof qaBridgeForgedInside.data.value?.initialPassword === 'string',
    JSON.stringify(qaBridgeForgedInside.data ?? qaBridgeForgedInside.error))

  // A-04：非 owner 开发者不可改写他人应用
  const qaOwnerApp = await api('POST', '/api/apps', { token: admin, body: { name: 'QA回归-Owner校验', attrs: { description: 'QA 修复批次回归用应用（owner=admin）', appType: 'web', riskLevel: 'low' } } })
  check('QA回归应用创建（owner=admin）', qaOwnerApp.ok && Boolean(qaOwnerApp.data.app?.id), JSON.stringify(qaOwnerApp.error ?? {}))
  const qaForeignPatch = await api('PATCH', `/api/apps/${qaOwnerApp.data.app.id}`, { token: otherDev, body: { name: '越权改名' } })
  check('非 owner 开发者改写他人应用被拒（QA A-04）', !qaForeignPatch.ok && /owner|负责人/.test(qaForeignPatch.error?.message ?? ''), JSON.stringify(qaForeignPatch.error ?? {}))
  const qaOwnerPatch = await api('PATCH', `/api/apps/${qaOwnerApp.data.app.id}`, { token: admin, body: { name: 'QA回归-Owner校验（已更新）' } })
  check('平台管理员/owner 可正常更新（QA A-04 正向）', qaOwnerPatch.ok, JSON.stringify(qaOwnerPatch.error ?? {}))

  // B-04：audit/cost 的 days 参数真实生效
  const qaCostDays = await api('GET', '/api/audit/cost?days=14', { token: admin })
  check('audit/cost days 参数生效（QA B-04：不再被静默丢弃）', qaCostDays.ok && qaCostDays.data.days === 14 && Array.isArray(qaCostDays.data.rows), JSON.stringify(qaCostDays.data ?? qaCostDays.error).slice(0, 160))
  const qaCostBare = await api('GET', '/api/audit/cost', { token: admin })
  check('audit/cost 不带 days 保持全量口径（QA B-04 兼容）', qaCostBare.ok && qaCostBare.data.days === undefined)

  // ================================================================ 组4 控制台安全面：基线口令文件（独立基线实例）
  section('基线口令文件（组4 N2/N3：mode 0600 + ADMIN_PASSWORD 空串回落随机）')
  {
    const pwDataDir = join(process.cwd(), 'data-selftest-pw')
    await rm(pwDataDir, { recursive: true, force: true })
    await mkdir(pwDataDir, { recursive: true })
    const PW_PORT = (await freePort()) ?? 7313
    const pwProc = spawn(process.execPath, ['src/main.ts', '--port', String(PW_PORT), '--data', pwDataDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      // 基线形态（无 DEMO_SEED）+ 显式空串 ADMIN_PASSWORD：空串视为未设置 → 随机生成路径
      env: { ...process.env, ADMIN_PASSWORD: '' },
    })
    let pwChunks = ''
    pwProc.stderr.on('data', (chunk) => { pwChunks += chunk })
    let pwBooted = false
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      try {
        const probe = await fetch(`http://127.0.0.1:${PW_PORT}/api/health`)
        if (probe.ok) { pwBooted = true; break }
      } catch { /* retry */ }
    }
    check('组4 C17：ADMIN_PASSWORD=\'\' 空串首启不抛错（实例健康就绪，随机生成路径）', pwBooted, pwChunks.slice(-400))
    if (pwBooted) {
      const pwBootstrapRaw = await fetch(`http://127.0.0.1:${PW_PORT}/api/platform/bootstrap`).then((r) => r.json()).catch(() => null)
      check('组4 C17：bootstrap 报告初始口令待接管（initialPasswordPending=true，证明走了随机生成）',
        pwBootstrapRaw?.data?.initialPasswordPending === true, JSON.stringify(pwBootstrapRaw ?? {}))
      const pwFile = join(pwDataDir, 'admin-initial-password.txt')
      const pwStat = existsSync(pwFile) ? statSync(pwFile) : undefined
      // Windows 无 POSIX 权限位语义（chmod 仅切换只读属性，stat 恒 666）——0o600 断言仅在
      // POSIX 平台生效；win32 下只验文件存在与内容可用（下一条登录断言兜底），不造假通过。
      check('组4 C16：初始口令文件 mode 0o600（仅属主可读写，macOS APFS/Linux 均生效；win32 豁免模式位断言）',
        Boolean(pwStat) && (process.platform === 'win32' || (pwStat.mode & 0o777) === 0o600),
        pwStat ? `mode=${(pwStat.mode & 0o777).toString(8)} platform=${process.platform}` : '文件未生成')
      const pwText = pwStat ? readFileSync(pwFile, 'utf8') : ''
      const pwValue = pwText.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('平台管理员'))[0] ?? ''
      const pwLogin = await fetch(`http://127.0.0.1:${PW_PORT}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: pwValue }),
      }).then((r) => r.json()).catch(() => null)
      check('组4 C16：口令文件所载口令可登录 admin（随机路径端到端可用）',
        pwLogin?.ok === true && typeof pwLogin.data?.token === 'string', JSON.stringify(pwLogin?.error ?? {}).slice(0, 160))
    }
    pwProc.kill('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await rm(pwDataDir, { recursive: true, force: true }).catch(() => {})
  }

  // ================================================================ 数字员工工作闭环（组7：workforce 契约面 / 员工任用 / 认领幂等 / 受控调用 / 交付验收）
  // 进程内独立最小树（等价 boot-all 依赖序 + 组7 后置段）：platform-core→基础层→网关→console
  // →panelCore→flowCore→execHub→workforce——workforce 必须挂在其全部依赖之后、console 之后
  // （guarded 路由依赖 console 鉴权中间件先行）。独立端口 7316 / 数据目录 DATA_DIR/workforce-mount。
  // 并行施工宽容：plugin-workforce 实现文件由组1/2 持续交付，动态 import+挂载失败时相关断言
  // 逐条红（标注待集成联跑），但不拖垮本章节其余断言与整个自测进程。
  section('数字员工工作闭环（组7：契约面/员工/任用/认领/步骤幂等/交付验收）')
  try {
    const WF_PORT = (await freePort()) ?? 7316
    const WF_BASE = `http://127.0.0.1:${WF_PORT}`
    const wfDataDir = join(DATA_DIR, 'workforce-mount')
    await rm(wfDataDir, { recursive: true, force: true })
    await mkdir(wfDataDir, { recursive: true })
    const wfCtx = new Context()
    await wfCtx.plugin(platformCore, { dataDir: wfDataDir, http: { port: WF_PORT } })
    await wfCtx.plugin(resourceCore)
    await wfCtx.plugin(iam)
    await wfCtx.plugin(authn)
    await wfCtx.plugin(usage)
    await wfCtx.plugin(audit)
    await wfCtx.plugin(market)
    await wfCtx.plugin(connector)
    await wfCtx.plugin(mcp)
    await wfCtx.plugin(nas)
    await wfCtx.plugin(skillhub)
    await wfCtx.plugin(agent)
    await wfCtx.plugin(app)
    await wfCtx.plugin(modelgw)
    await wfCtx.plugin(connect, { role: 'host' })
    await wfCtx.plugin(update)
    await wfCtx.plugin(portal)
    await wfCtx.plugin(consolePlugin)
    await wfCtx.plugin(panelCore)
    await wfCtx.plugin(flowCore)
    await wfCtx.plugin(execHub)
    // 缺省拒绝语义（挂载前采样）：必须在 workforce 挂载之前读取——挂载后端口已登记，
    // 本断言恒假（曾在「挂载成功」场景误红）
    check('契约面：workforce 挂载前端口未就绪（isReady()=false，缺省拒绝语义）', wfCtx.workforcePolicy.isReady() === false)
    // workforce 挂载点：全部依赖之后（agent→exec-hub→workforce），且 config.dataDir 显式指向
    // 隔离目录（缺省会落 <cwd>/data，绝不污染仓库默认数据目录）
    let wf = null
    let wfLoadError = ''
    try {
      wf = await import('../packages/plugin-workforce/src/index.ts')
      await wfCtx.plugin(wf, { dataDir: join(wfDataDir, 'domain') })
    } catch (error) {
      wfLoadError = error instanceof Error ? error.message : String(error)
    }
    const wfPending = (name, detail = '') => check(name, false, `待集成联跑（plugin-workforce 未就绪：${wfLoadError || detail || '挂载失败'}）`)
    const errText = (error) => (error instanceof Error ? `${error.name}:${error.message}` : String(error))

    // -- 契约面（1） ------------------------------------------------------------
    check('契约面：ctx.workforcePolicy 注册器随 platform-core 就位（窄端口横切面）',
      typeof wfCtx.workforcePolicy?.isReady === 'function' && typeof wfCtx.workforcePolicy?.port === 'function')
    if (wf) check('契约面：workforce 挂载后 isReady()=true（策略实现已登记）', wfCtx.workforcePolicy.isReady() === true)
    else wfPending('契约面：workforce 挂载后 isReady()=true')

    // -- V29：注册器类本身单测（端口未就绪场景在已挂载树上不可造，按蓝本改测注册器） ----------
    try {
      // 裸 Context 直接构造（WorkforcePolicyRegistry 构造仅存引用，不触发装配）；
      // 若 cordis Service 基类拒绝裸构造则下方 catch 捕获——按蓝本跳过并在 detail 注明原因
      const bareRegistry = new platformCore.WorkforcePolicyRegistry(new Context())
      const portBefore = bareRegistry.port()
      const readyBefore = bareRegistry.isReady()
      bareRegistry.register({
        resolveManagedEmployee: async () => null,
        describeManagedAgent: async () => null,
        authorizeWorkAction: async () => ({ allow: false, code: 'WORKFORCE_NOT_READY', message: '组7 单测假端口' }),
      })
      check('V29：注册器未登记时 port()=null / isReady()=false；register 后立即可用（不静默放行）',
        portBefore === null && readyBefore === false && bareRegistry.isReady() === true && bareRegistry.port() !== null,
        `portBefore=${String(portBefore)} readyBefore=${readyBefore}`)
    } catch (error) {
      // 裸 Context 构造不可行（Service 基类需要装配上下文）——按蓝本跳过，detail 即说明
      check('V29：注册器类单测（裸 Context 构造不可行，按蓝本跳过本项）', false, `skip：${errText(error)}`)
    }

    // -- 夹具：组织 / 主管 / 测试 Agent（服务层直建，不依赖演示种子） ----------------------------
    const adminUser = wfCtx.iam.users().findOne((u) => u.username === 'admin')
    check('闭环夹具：console 基线初始化产出 admin（测试主管）', Boolean(adminUser?.id))
    const adminPrincipal = wfCtx.authn.ensureHumanPrincipal(adminUser.id, adminUser.displayName ?? '平台管理员')
    const adminCaller = { kind: 'human', principalId: adminPrincipal.id, userId: adminUser.id, name: '平台管理员' }
    const wfOrg = wfCtx.iam.createOrg({ name: `组7闭环自测组织-${Date.now() % 100000}` }, iam.SYSTEM_ACTOR)
    check('闭环夹具：测试组织创建', Boolean(wfOrg?.id))
    // 测试模型登记须先于 Agent 注册（issue #8：attrs.model 以模型目录为单一事实源，
    // 本子段为独立裸 Context 实例，目录仅含本段自备模型——Agent 一律用 G7_MODEL_SLUG）
    const G7_MODEL_SLUG = `g7-loop-model-${Date.now() % 100000}`
    wfCtx.modelGateway.upsertModel({ slug: G7_MODEL_SLUG, displayName: '组7闭环测试模型', provider: 'stub', endpoint: `http://127.0.0.1:${GH_PORT}/v1`, apiKey: 'sk-g7-selftest', costCentsPerKTokens: 1, status: 'online', dataClassLimit: 'internal' })
    const g7AgentReg = wfCtx.agentRegistry.register({ name: '组7闭环员工Agent', ownerId: adminUser.id, ownerName: '平台管理员', orgId: wfOrg.id, attrs: { description: '组7闭环自测：数字员工绑定用 Agent', model: G7_MODEL_SLUG, riskLevel: 'low' } })
    const g7Agent = g7AgentReg.agent
    // 机器 caller（§13.2）：主体来自已验证机器凭证（refType=agent 可反查员工绑定），非请求参数自报
    const g7AgentCaller = { kind: 'machine', principalId: g7AgentReg.credential.principal.id, refType: 'agent', refId: g7Agent.id, name: g7Agent.name }
    const g7RivalReg = wfCtx.agentRegistry.register({ name: '组7闭环他人Agent', ownerId: adminUser.id, ownerName: '平台管理员', orgId: wfOrg.id, attrs: { description: '组7闭环自测：撞绑拒绝用 Agent', model: G7_MODEL_SLUG, riskLevel: 'low' } })
    const g7RivalCaller = { kind: 'machine', principalId: g7RivalReg.credential.principal.id, refType: 'agent', refId: g7RivalReg.agent.id, name: g7RivalReg.agent.name }
    check('闭环夹具：测试 Agent×2 与机器凭证就位（refType=agent）', Boolean(g7Agent?.id && g7AgentReg.credential?.principal?.id && g7RivalReg.credential?.principal?.id))

    // -- 员工 / 绑定（2） ---------------------------------------------------------
    let employee = null
    if (wf) {
      try {
        employee = wfCtx.workforceEmployees.create({ name: 'g7-quality-analyst', displayName: '组7质量分析员', orgId: wfOrg.id, supervisorUserId: adminUser.id, agentId: g7Agent.id, principalId: g7AgentReg.credential.principal.id, runtime: 'dsh' })
        check('员工：创建员工档案（active + 主绑定 Agent 回填）', employee?.status === 'active' && employee?.primaryAgentId === g7Agent.id, JSON.stringify(employee ?? {}))
        const bindings = wfCtx.workforceEmployees.bindingsFor(employee.id)
        check('绑定：员工↔Agent 一对一有效绑定（active）', bindings.some((b) => b.agentId === g7Agent.id && b.status === 'active'), JSON.stringify(bindings))
        const rivalEmployee = wfCtx.workforceEmployees.create({ name: 'g7-rival-analyst', displayName: '组7撞绑员工', orgId: wfOrg.id, supervisorUserId: adminUser.id, agentId: g7RivalReg.agent.id })
        let dupRejected = false
        try { wfCtx.workforceEmployees.bindAgent(adminCaller, rivalEmployee.id, g7Agent.id) } catch { dupRejected = true }
        check('绑定：同 Agent 已被占用时再次绑定被拒绝（一对一约束）', dupRejected)
      } catch (error) {
        check('员工：创建员工档案（active + 主绑定 Agent 回填）', false, `异常：${errText(error)}`)
      }
    } else wfPending('员工：创建员工档案（active + 主绑定 Agent 回填）')

    // -- 任用状态机（3）：探针失败路径与生效路径 --------------------------------------------
    let loopAppointment = null
    if (wf && employee) {
      try {
        // mcp grant 指向不存在服务：真实授权探针应当失败（无权限组授权 → 保持 preparing）
        const grants = [
          { kind: 'model', registryId: G7_MODEL_SLUG, actions: ['invoke'], risk: 'read' },
          { kind: 'mcp', registryId: 'mcp_g7_missing_service', actions: ['qms_batch_read'], risk: 'read', constraints: { factoryIds: ['JH-01'] } },
        ]
        const appointment = wfCtx.workforceAppointments.create({ employeeId: employee.id, position: '质量分析员', orgId: wfOrg.id, dataClass: 'internal', effectiveFrom: new Date().toISOString(), grants, approvedBy: adminUser.id })
        check('任用：创建任用版本 v1（preparing 起步，组织不可空）', appointment?.version === 1 && appointment?.status === 'preparing' && appointment?.orgId === wfOrg.id, JSON.stringify(appointment ?? {}))
        const activated = await wfCtx.workforceAppointments.activate(adminCaller, appointment.id)
        if (activated.status === 'preparing') {
          check('任用激活·探针失败路径：无真实 MCP 授权时保持 preparing（不签发 permit 的前提）', Boolean(activated.statusReason), `statusReason=${activated.statusReason}`)
        } else {
          check('任用激活·探针通过路径：状态推进（effective）', activated.status === 'effective', `status=${activated.status}`)
        }
        loopAppointment = activated
        if (loopAppointment.status !== 'effective') {
          // 兜底任用：仅保留可核验的 model grant（探针环境受限时保住闭环前置）
          const fallback = wfCtx.workforceAppointments.create({ employeeId: employee.id, position: '质量分析员', orgId: wfOrg.id, dataClass: 'internal', effectiveFrom: new Date().toISOString(), grants: [grants[0]], approvedBy: adminUser.id })
          loopAppointment = await wfCtx.workforceAppointments.activate(adminCaller, fallback.id)
        }
        const activeManifest = loopAppointment.status === 'effective' ? wfCtx.workforceCapabilities.activeForAppointment(loopAppointment.id) : undefined
        check('任用：生效后 activeForAppointment 清单非空（工具句柄可下发）',
          Boolean(activeManifest) && wfCtx.workforceCapabilities.toolsFor(activeManifest.id).length >= 1,
          loopAppointment.status === 'effective' ? `manifest=${activeManifest?.id ?? '无'}` : `待集成联跑：任用未生效（${loopAppointment.status}），探针在当前并行施工状态未推进`)
      } catch (error) {
        check('任用：创建任用版本 v1（preparing 起步，组织不可空）', false, `异常：${errText(error)}`)
      }
    } else wfPending('任用：创建任用版本 v1（preparing 起步，组织不可空）')

    // -- 认领幂等（4）：以生效任用为前置 ------------------------------------------------
    let claim1 = null
    let firstInvocation = null
    let issue = null
    if (wf && employee && loopAppointment?.status === 'effective') {
      try {
        issue = wfCtx.execHub.createIssue({ orgId: wfOrg.id, title: '组7闭环自测：分析批次 Q-1024 异常', assigneeAgentId: g7Agent.id, createdBy: 'selftest-workforce' })
        claim1 = await wfCtx.workforceAdmission.claimWork(g7AgentCaller, { issueId: issue.id })
        check('认领：机器主体首次认领成功（run/租约/permit/清单四件套齐备）',
          claim1.ok === true && Boolean(claim1.runId) && Boolean(claim1.lease?.id) && Boolean(claim1.permit?.id) && claim1.tools.length >= 1,
          JSON.stringify(claim1.ok ? {} : { code: claim1.code, message: claim1.message }).slice(0, 200))
      } catch (error) {
        check('认领：机器主体首次认领成功（run/租约/permit/清单四件套齐备）', false, `异常：${errText(error)}`)
      }
    } else wfPending('认领：机器主体首次认领成功（run/租约/permit/清单四件套齐备）', '前置：员工/任用未生效')

    if (wf && claim1?.ok) {
      try {
        const claimReplay = await wfCtx.workforceAdmission.claimWork(g7AgentCaller, { issueId: issue.id })
        check('认领幂等：同主体同任务重复认领 idempotent=true 且 runId 一致（不产生第二租约）',
          claimReplay.ok === true && claimReplay.idempotent === true && claimReplay.runId === claim1.runId && claimReplay.permit.id === claim1.permit.id,
          JSON.stringify(claimReplay.ok ? { idempotent: claimReplay.idempotent, runId: claimReplay.runId } : claimReplay).slice(0, 200))
      } catch (error) {
        check('认领幂等：同主体同任务重复认领 idempotent=true 且 runId 一致（不产生第二租约）', false, `异常：${errText(error)}`)
      }
      try {
        const rival = await wfCtx.workforceAdmission.claimWork(g7RivalCaller, { issueId: issue.id })
        check('认领排他：他人主体（另一 Agent 绑定）认领同任务被拒绝', rival.ok === false && Boolean(rival.message), JSON.stringify({ code: rival.code, message: rival.message }))
      } catch (error) {
        // 服务层以 WorkforceError 异常拒绝同样成立（诚实失败即可，不允许静默成功）
        check('认领排他：他人主体（另一 Agent 绑定）认领同任务被拒绝', false, `异常拒绝：${errText(error)}`)
      }
    } else if (wf) wfPending('认领幂等：同主体同任务重复认领 idempotent=true 且 runId 一致（不产生第二租约）', '前置：首次认领未成功')

    // -- 步骤幂等（5）：优先真实适配器路径；适配器缺席时诚实落账同样计入步骤账本 -----------------
    if (wf && claim1?.ok) {
      try {
        const handle = claim1.tools[0]
        firstInvocation = await wfCtx.workforceInvocations.invoke(g7AgentCaller, { permitId: claim1.permit.id, toolHandle: handle.handle, stepKey: 'g7.step.probe_1', arguments: { probe: 'g7' } })
        check('受控调用：受控调用诚实落账（completed/denied/approval_required 等状态 + invocationId）',
          typeof firstInvocation.invocationId === 'string' && ['completed', 'denied', 'approval_required', 'rate_limited', 'failed', 'outcome_unknown', 'cancelled'].includes(firstInvocation.status),
          JSON.stringify({ status: firstInvocation.status, id: firstInvocation.invocationId, code: firstInvocation.code ?? '', message: firstInvocation.message ?? '' }).slice(0, 200))
      } catch (error) {
        check('受控调用：受控调用诚实落账（completed/denied/approval_required 等状态 + invocationId）', false, `异常：${errText(error)}`)
      }
      try {
        const handle = claim1.tools[0]
        const replay = await wfCtx.workforceInvocations.invoke(g7AgentCaller, { permitId: claim1.permit.id, toolHandle: handle.handle, stepKey: 'g7.step.probe_1', arguments: { probe: 'g7' } })
        check('步骤幂等：同 run 同 stepKey 同参数重复调用 → 回放原结果（同 invocationId）',
          replay.invocationId === firstInvocation?.invocationId,
          JSON.stringify({ first: firstInvocation?.invocationId, replay: replay.invocationId }))
      } catch (error) {
        check('步骤幂等：同 run 同 stepKey 同参数重复调用 → 回放原结果（同 invocationId）', false, `异常：${errText(error)}`)
      }
      try {
        const handle = claim1.tools[0]
        let conflictCode = ''
        try {
          const conflict = await wfCtx.workforceInvocations.invoke(g7AgentCaller, { permitId: claim1.permit.id, toolHandle: handle.handle, stepKey: 'g7.step.probe_1', arguments: { probe: 'g7-different' } })
          conflictCode = conflict.status === 'denied' ? (conflict.code ?? '') : `status=${conflict.status}`
        } catch (error) {
          conflictCode = error?.code ?? errText(error) // 服务层以 WorkforceError 抛出同样成立
        }
        check('步骤幂等：同 stepKey 不同参数 → STEP_ARGUMENT_CONFLICT 冲突拒绝（不覆盖原动作）',
          conflictCode === 'STEP_ARGUMENT_CONFLICT', `code=${conflictCode}`)
      } catch (error) {
        check('步骤幂等：同 stepKey 不同参数 → STEP_ARGUMENT_CONFLICT 冲突拒绝（不覆盖原动作）', false, `异常：${errText(error)}`)
      }
    } else if (wf) wfPending('步骤幂等：同 run 同 stepKey 同参数重复调用 → 回放原结果（同 invocationId）', '前置：首次认领未成功')

    // -- 交付验收（8）：artifact→submit→review→accept→done；退回路径 → 回退且事实保留 ------------
    if (wf && claim1?.ok) {
      try {
        const artifact = await wfCtx.workforceArtifacts.createUpload(g7AgentCaller, {
          name: 'q-1024-根因分析草案.md', contentType: 'text/markdown',
          contentBase64: Buffer.from('# 批次 Q-1024 根因分析（组7自测）\n\n根因假设与纠正建议。').toString('base64'),
          runId: claim1.runId,
        })
        check('交付：受控 artifact 上传（staging 元信息 + sha256 摘要 + 归属 run）',
          Boolean(artifact?.id) && artifact.sizeBytes > 0 && artifact.sha256?.length === 64 && artifact.runId === claim1.runId,
          JSON.stringify(artifact ?? {}))
        const deliverable = await wfCtx.workforceDelivery.submit(g7AgentCaller, { permitId: claim1.permit.id, summary: '批次 Q-1024 根因假设与纠正建议（组7自测）', artifactIds: [artifact.id] })
        check('交付：submit 后 exec-hub 任务进入 review（技术完成≠验收完成）',
          deliverable?.status === 'submitted' && wfCtx.execHub.issues().get(issue.id)?.status === 'review',
          JSON.stringify({ deliverable: deliverable?.status, issue: wfCtx.execHub.issues().get(issue.id)?.status }))
        const accepted = await wfCtx.workforceDelivery.decide(adminCaller, { deliverableId: deliverable.id, decision: 'accepted', reason: '组7自测：证据齐备验收通过' })
        check('验收：accept 决定后任务 done（真人验收权决定业务完成）',
          accepted?.status === 'accepted' && wfCtx.execHub.issues().get(issue.id)?.status === 'done',
          JSON.stringify({ decision: accepted?.status, issue: wfCtx.execHub.issues().get(issue.id)?.status }))
      } catch (error) {
        check('交付：受控 artifact 上传（staging 元信息 + sha256 摘要 + 归属 run）', false, `异常：${errText(error)}`)
      }
      // 退回路径：第二任务走 submit → rejected → 任务回退且调用事实保留（V30 语义）
      try {
        const issue2 = wfCtx.execHub.createIssue({ orgId: wfOrg.id, title: '组7闭环自测：退回路径演练', assigneeAgentId: g7Agent.id, createdBy: 'selftest-workforce' })
        const claimB = await wfCtx.workforceAdmission.claimWork(g7AgentCaller, { issueId: issue2.id })
        if (claimB.ok) {
          const artifactB = await wfCtx.workforceArtifacts.createUpload(g7AgentCaller, { name: 'q-1024-草案v1.md', contentType: 'text/markdown', contentBase64: Buffer.from('证据不足的草案 v1').toString('base64'), runId: claimB.runId })
          const deliverableB = await wfCtx.workforceDelivery.submit(g7AgentCaller, { permitId: claimB.permit.id, summary: '待退回交付（组7自测）', artifactIds: [artifactB.id] })
          const rejected = await wfCtx.workforceDelivery.decide(adminCaller, { deliverableId: deliverableB.id, decision: 'rejected', reason: '组7自测：证据不足退回' })
          const issue2After = wfCtx.execHub.issues().get(issue2.id)
          const factsKept = await wfCtx.workforceInvocations.listByRun(g7AgentCaller, claimB.runId)
          check('验收退回：退回后任务回退执行（review→in_progress）且调用事实保留',
            rejected?.status === 'rejected' && issue2After?.status === 'in_progress' && Array.isArray(factsKept),
            JSON.stringify({ decision: rejected?.status, issue: issue2After?.status, invocations: Array.isArray(factsKept) ? factsKept.length : '异常' }))
        } else {
          check('验收退回：退回后任务回退执行（review→in_progress）且调用事实保留', false, `第二任务认领失败：${JSON.stringify({ code: claimB.code, message: claimB.message }).slice(0, 160)}`)
        }
      } catch (error) {
        check('验收退回：退回后任务回退执行（review→in_progress）且调用事实保留', false, `异常：${errText(error)}`)
      }
    } else if (wf) wfPending('交付：受控 artifact 上传（staging 元信息 + sha256 摘要 + 归属 run）', '前置：首次认领未成功')

    // -- 停职撤权（6）：置于认领/交付之后执行（撤权即终结该员工后续受控动作） -------------------
    if (wf && employee && claim1?.ok) {
      try {
        const suspended = wfCtx.workforceEmployees.setStatus(adminCaller, employee.id, 'suspended', '组7自测：停职撤权')
        const permitsAfter = wfCtx.workforceStore.permits.findWhere({ employeeId: employee.id })
        check('停职撤权：员工 suspend 后其全部 active permit 被撤销（revoked）',
          suspended?.status === 'suspended' && permitsAfter.length >= 1 && permitsAfter.every((p) => p.status === 'revoked'),
          JSON.stringify(permitsAfter.map((p) => ({ id: p.id, status: p.status }))))
        let verifyCode = ''
        try { await wfCtx.workforceAdmission.verifyPermit(g7AgentCaller, claim1.permit.id) } catch (error) { verifyCode = error?.code ?? errText(error) }
        check('停职撤权：verifyPermit 对已撤 permit 抛错（fail-closed，V07）', verifyCode !== '', verifyCode || '未抛错')
        try { wfCtx.workforceEmployees.setStatus(adminCaller, employee.id, 'active', '组7自测收尾：复岗') } catch { /* 复岗失败不影响断言 */ }
      } catch (error) {
        check('停职撤权：员工 suspend 后其全部 active permit 被撤销（revoked）', false, `异常：${errText(error)}`)
      }
    } else if (wf) wfPending('停职撤权：员工 suspend 后其全部 active permit 被撤销（revoked）', '前置：认领未成功')

    // -- W5 运维面（D-③）：maintenance run 过期 permit 落账（service 层；「过期不落库」口径收敛） ----
    if (wf) {
      try {
        // 直插「已签发但已过期」的 active permit（落账断言只依赖 permits 表事实，不重跑认领链）
        const w5StalePermitId = `wfpermit_g7_w5_stale_${Date.now() % 100000}`
        wfCtx.workforceStore.permits.insert({
          id: w5StalePermitId, employeeId: employee.id, agentId: g7Agent.id, principalId: '',
          appointmentId: '', appointmentVersion: 0, manifestId: '', issueId: '', runId: '', leaseId: '', leaseVersion: 0,
          status: 'active', expiresAt: new Date(Date.now() - 60_000).toISOString(),
          createdAt: new Date().toISOString(), revokedAt: '', revokedReason: '',
        })
        const w5Maint = wfCtx.workforceMaintenance.run()
        const w5StaleAfter = wfCtx.workforceStore.permits.get(w5StalePermitId)
        check('W5 运维面：maintenance run 将过期 active permit 落账 expired（仓库内唯一写 expired 处）',
          Array.isArray(w5Maint?.expiredPermits) && w5Maint.expiredPermits.includes(w5StalePermitId) && w5StaleAfter?.status === 'expired',
          JSON.stringify({ expiredCount: w5Maint?.expiredPermits?.length, status: w5StaleAfter?.status }))
        check('W5 运维面：maintenance run 返回终态 run 盘点计数（封存不删行，只报告）',
          typeof w5Maint?.terminalRunCount === 'number' && typeof w5Maint?.permitsOnTerminalRuns === 'number' && typeof w5Maint?.invocationsOnTerminalRuns === 'number')
      } catch (error) {
        check('W5 运维面：maintenance run 将过期 active permit 落账 expired（仓库内唯一写 expired 处）', false, `异常：${errText(error)}`)
      }
    } else wfPending('W5 运维面：maintenance run 将过期 active permit 落账 expired')

    // -- 计量关联（§11.3）：invocationId 落库读回一致 + workforce_usage_links 事实映射 ------------
    try {
      const LINK_INV = 'wfi_g7_link_probe'
      const linkEvent = wfCtx.usage.record({
        org: wfOrg.id, subject: `agent:${g7Agent.id}`, principal: `org:${wfOrg.id}`,
        resource: 'app:app-g7-loop', meters: [{ key: 'calls', value: 1, unit: 'call' }],
        idempotency_key: `g7-link-${Date.now()}`, invocationId: LINK_INV,
      })
      const linkRow = wfCtx.txnStore.one('usage_events', { id: linkEvent.event_id })
      const linkRead = wfCtx.usage.query({}).items.find((e) => e.event_id === linkEvent.event_id)
      check('计量关联：usage.record 携带 invocationId → invocation_id 列落库且事件读回一致（不双计）',
        linkRow?.invocation_id === LINK_INV && linkRead?.invocationId === LINK_INV,
        JSON.stringify({ row: linkRow?.invocation_id, event: linkRead?.invocationId }))
      if (wf && firstInvocation?.status === 'completed') {
        try {
          wfCtx.workforceInvocations.linkUsage(firstInvocation.invocationId, linkEvent.event_id, 'app:app-g7-loop')
          const links = wfCtx.workforceStore.usageLinks.findWhere({ invocationId: firstInvocation.invocationId })
          check('计量关联：workforce_usage_links 调用↔消费事实唯一映射（V23/V24，只关联不复制流水）',
            links.length === 1 && links[0].usageEventId === linkEvent.event_id,
            JSON.stringify(links))
        } catch (error) {
          check('计量关联：workforce_usage_links 调用↔消费事实唯一映射（V23/V24，只关联不复制流水）', false, `异常：${errText(error)}`)
        }
      }
    } catch (error) {
      check('计量关联：usage.record 携带 invocationId → invocation_id 列落库且事件读回一致（不双计）', false, `异常：${errText(error)}`)
    }

    // -- REST 冒烟：/api/workforce/overview（guarded 路由依赖 console 中间件先行） ----------------
    try {
      const wfApi = async (method, path, { token, body } = {}) => {
        const headers = { 'content-type': 'application/json' }
        if (token) headers.authorization = `Bearer ${token}`
        const response = await fetch(`${WF_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
        let payload = null
        try { payload = await response.json() } catch { /* ignore */ }
        return { status: response.status, ok: payload?.ok ?? false, data: payload?.data, error: payload?.error }
      }
      const wfPwFile = join(wfDataDir, 'admin-initial-password.txt')
      const wfPassword = existsSync(wfPwFile)
        ? (readFileSync(wfPwFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('平台管理员'))[0] ?? '')
        : ''
      const wfLogin = await wfApi('POST', '/api/auth/login', { body: { username: 'admin', password: wfPassword } })
      const wfAdminToken = wfLogin.data?.token
      check('REST 冒烟：独立最小树 /api/auth/login 可用（console 基线口令文件）', Boolean(wfAdminToken), `status=${wfLogin.status}`)
      // workforce.read 细粒度令牌：权限点已入目录 → 机器凭证路径；未入目录（并行组）→ 回退 admin 并注明
      let scopedToken = ''
      try {
        const scopedCred = wfCtx.authn.createMachineCredential({ name: 'g7-workforce-read', refType: 'agent', refId: g7Agent.id, scopes: ['workforce.read'] })
        const scopedCc = await wfApi('POST', '/api/auth/client-credentials', { body: { clientId: scopedCred.clientId, clientSecret: scopedCred.clientSecret } })
        scopedToken = scopedCc.data?.token ?? ''
      } catch { /* workforce.* 权限点尚未入权限目录——回退 admin 令牌验证 200 */ }
      const overview = await wfApi('GET', '/api/workforce/overview', { token: scopedToken || wfAdminToken })
      check(`REST 冒烟：GET /api/workforce/overview 200（${scopedToken ? 'workforce.read 权限令牌' : 'admin 令牌——workforce.read 权限点待并行组入目录'}）`,
        overview.status === 200, `status=${overview.status} error=${JSON.stringify(overview.error ?? {}).slice(0, 160)}`)
      const deniedCred = wfCtx.authn.createMachineCredential({ name: 'g7-no-perm', refType: 'external', scopes: ['agent.read'] })
      const deniedCc = await wfApi('POST', '/api/auth/client-credentials', { body: { clientId: deniedCred.clientId, clientSecret: deniedCred.clientSecret } })
      const overviewDenied = await wfApi('GET', '/api/workforce/overview', { token: deniedCc.data?.token })
      check('REST 冒烟：无 workforce 权限令牌访问 /api/workforce/overview 403', overviewDenied.status === 403, `status=${overviewDenied.status}`)

      // -- W5 运维面（D-③）：status-batch 批量停职 / audit 报表 / 非 admin 令牌 403 ----------------
      try {
        const w5AgentA = wfCtx.agentRegistry.register({ name: `组7W5批量停职A-Agent-${Date.now() % 100000}`, ownerId: adminUser.id, ownerName: '平台管理员', orgId: wfOrg.id, attrs: { description: '组7 W5 运维面断言用', model: G7_MODEL_SLUG, riskLevel: 'low' } }).agent
        const w5AgentB = wfCtx.agentRegistry.register({ name: `组7W5批量停职B-Agent-${Date.now() % 100000}`, ownerId: adminUser.id, ownerName: '平台管理员', orgId: wfOrg.id, attrs: { description: '组7 W5 运维面断言用', model: G7_MODEL_SLUG, riskLevel: 'low' } }).agent
        const w5EmpA = wfCtx.workforceEmployees.create({ name: `组7W5批量停职A-${Date.now() % 100000}`, orgId: wfOrg.id, supervisorUserId: adminUser.id, agentId: w5AgentA.id })
        const w5EmpB = wfCtx.workforceEmployees.create({ name: `组7W5批量停职B-${Date.now() % 100000}`, orgId: wfOrg.id, supervisorUserId: adminUser.id, agentId: w5AgentB.id })
        // 直插 active permit 模拟已签发（批量断言聚焦撤权联动；认领→撤权全闭环已由上方断言覆盖）
        const w5InsertPermit = (employeeId, agentId) => wfCtx.workforceStore.permits.insert({
          id: `wfpermit_g7_w5_${employeeId.slice(-6)}_${Date.now() % 100000}`, employeeId, agentId, principalId: '',
          appointmentId: '', appointmentVersion: 0, manifestId: '', issueId: '', runId: '', leaseId: '', leaseVersion: 0,
          status: 'active', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          createdAt: new Date().toISOString(), revokedAt: '', revokedReason: '',
        })
        w5InsertPermit(w5EmpA.id, w5AgentA.id)
        w5InsertPermit(w5EmpB.id, w5AgentB.id)
        const w5Batch = await wfApi('POST', '/api/workforce/admin/employees/status-batch', {
          token: wfAdminToken, body: { employeeIds: [w5EmpA.id, w5EmpB.id], status: 'suspended', reason: '组7自测：W5 批量停职' },
        })
        check('W5 运维面：status-batch 双员工停职 200 且 succeeded=2 failed=0',
          w5Batch.status === 200 && w5Batch.data?.succeeded === 2 && w5Batch.data?.failed === 0,
          `status=${w5Batch.status} data=${JSON.stringify(w5Batch.data ?? w5Batch.error).slice(0, 160)}`)
        const w5Permits = [...wfCtx.workforceStore.permits.findWhere({ employeeId: w5EmpA.id }), ...wfCtx.workforceStore.permits.findWhere({ employeeId: w5EmpB.id })]
        check('W5 运维面：status-batch 后两员工 permit 全 revoked 且逐条聚合 revokedPermits=1',
          w5Permits.length >= 2 && w5Permits.every((p) => p.status === 'revoked') &&
            (w5Batch.data?.results ?? []).every((r) => r.ok === true && r.revokedPermits === 1),
          JSON.stringify(w5Permits.map((p) => ({ id: p.id, status: p.status }))))
        const w5Audit = await wfApi('GET', `/api/workforce/admin/employees/${w5EmpA.id}/audit?limit=10`, { token: wfAdminToken })
        check('W5 运维面：audit 报表 200 且含 employee/bindings/appointments/permits/invocations/deliverables/summary 键',
          w5Audit.status === 200 && ['employee', 'bindings', 'appointments', 'permits', 'invocations', 'deliverables', 'summary'].every((key) => key in (w5Audit.data ?? {})),
          `status=${w5Audit.status} keys=${Object.keys(w5Audit.data ?? {}).join(',')}`)
        const w5BatchDenied = await wfApi('POST', '/api/workforce/admin/employees/status-batch', {
          token: deniedCc.data?.token, body: { employeeIds: [w5EmpA.id], status: 'active', reason: '越权尝试' },
        })
        const w5AuditDenied = await wfApi('GET', `/api/workforce/admin/employees/${w5EmpA.id}/audit`, { token: deniedCc.data?.token })
        const w5MaintDenied = await wfApi('POST', '/api/workforce/admin/maintenance/run', { token: deniedCc.data?.token })
        check('W5 运维面：无 workforce.admin 权限令牌访问 status-batch/audit/maintenance 全 403',
          w5BatchDenied.status === 403 && w5AuditDenied.status === 403 && w5MaintDenied.status === 403,
          `batch=${w5BatchDenied.status} audit=${w5AuditDenied.status} maint=${w5MaintDenied.status}`)
      } catch (error) {
        check('W5 运维面：admin 端点 REST 断言（status-batch/audit/403）', false, `异常：${errText(error)}`)
      }

      // -- W7/D-② 灰度收口（QA/交付组 additive 子段）：独立最小树 + allowlist 配置 ----------------
      // 端口 7318（selftest 端口体系；数据子目录随主 DATA_DIR 终扫清理）。灰度配置注入形态=本批
      // contract.ts 冻结契约：WorkforceConfig extends WorkforceGrayConfig，admission 与 port 同收口。
      try {
        const GRAY_PORT = (await freePort()) ?? 7318
        const grayDataDir = join(DATA_DIR, 'workforce-gray-mount')
        await rm(grayDataDir, { recursive: true, force: true })
        await mkdir(grayDataDir, { recursive: true })
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
        // 名单/名单外组织先建（enabledOrgs 需要名单组织 ID），再挂 workforce
        const gAdminU = grayCtx.iam.users().findOne((u) => u.username === 'admin')
        const gAdminP = grayCtx.authn.ensureHumanPrincipal(gAdminU.id, gAdminU.displayName ?? '平台管理员')
        const gAdminCaller = { kind: 'human', principalId: gAdminP.id, userId: gAdminU.id, name: '平台管理员' }
        const orgIn = grayCtx.iam.createOrg({ name: `灰度名单组织-${Date.now() % 100000}` }, iam.SYSTEM_ACTOR)
        const orgOut = grayCtx.iam.createOrg({ name: `灰度名单外组织-${Date.now() % 100000}` }, iam.SYSTEM_ACTOR)
        const GRAY_MODEL = `gray-model-${Date.now() % 100000}`
        grayCtx.modelGateway.upsertModel({ slug: GRAY_MODEL, displayName: '灰度自测模型', provider: 'stub', endpoint: 'http://127.0.0.1:9/noop', apiKey: 'sk-gray-selftest', costCentsPerKTokens: 1, status: 'online', dataClassLimit: 'internal' })
        const grayEvents = []
        grayCtx.platformBus.on('workforce.gray.denied', (payload) => grayEvents.push(payload ?? {}))
        const grayWf = await import('../packages/plugin-workforce/src/index.ts')
        await grayCtx.plugin(grayWf, { dataDir: join(grayDataDir, 'domain'), grayMode: 'allowlist', enabledOrgs: [orgIn.id] })
        const mkGrayEmployee = (org, agentName, empName) => {
          const reg = grayCtx.agentRegistry.register({ name: agentName, ownerId: gAdminU.id, ownerName: '平台管理员', orgId: org.id, attrs: { description: '组7灰度子段', model: GRAY_MODEL, riskLevel: 'low' } })
          const employee = grayCtx.workforceEmployees.create({ name: empName, displayName: empName, orgId: org.id, supervisorUserId: gAdminU.id, agentId: reg.agent.id, principalId: reg.credential.principal.id, runtime: 'dsh' })
          const caller = { kind: 'machine', principalId: reg.credential.principal.id, refType: 'agent', refId: reg.agent.id, name: reg.agent.name }
          return { reg, employee, caller }
        }
        const activateGray = async (employee) => {
          const appt = grayCtx.workforceAppointments.create({ employeeId: employee.id, position: '灰度自测岗', orgId: employee.orgId, dataClass: 'internal', effectiveFrom: new Date().toISOString(), grants: [{ kind: 'model', registryId: GRAY_MODEL, actions: ['invoke'], risk: 'read', constraints: { maxTokens: 64 } }], approvedBy: gAdminU.id })
          return grayCtx.workforceAppointments.activate(gAdminCaller, appt.id)
        }
        // 名单内基线：认领/续租不受灰度影响
        const inHouse = mkGrayEmployee(orgIn, '灰度名单内Agent', 'gray-in-analyst')
        await activateGray(inHouse.employee)
        const issueIn = grayCtx.execHub.createIssue({ orgId: orgIn.id, title: '灰度自测：名单内任务', assigneeAgentId: inHouse.reg.agent.id, createdBy: 'selftest-gray' })
        const claimIn = await grayCtx.workforceAdmission.claimWork(inHouse.caller, { issueId: issueIn.id })
        check('灰度D-②：名单内组织认领正常（allowlist 不拦名单组织，run/permit 四件套）',
          claimIn.ok === true && Boolean(claimIn.runId) && Boolean(claimIn.permit?.id),
          JSON.stringify(claimIn.ok ? {} : { code: claimIn.code, message: claimIn.message }).slice(0, 200))
        // 名单外：认领显式拒绝（WORKFORCE_DISABLED）——admission 侧收口（抛 403 WorkforceError）
        const outHouse = mkGrayEmployee(orgOut, '灰度名单外Agent', 'gray-out-analyst')
        await activateGray(outHouse.employee)
        const issueOut = grayCtx.execHub.createIssue({ orgId: orgOut.id, title: '灰度自测：名单外任务', assigneeAgentId: outHouse.reg.agent.id, createdBy: 'selftest-gray' })
        let outDenied = { denied: false, code: '', message: '' }
        try {
          const verdict = await grayCtx.workforceAdmission.claimWork(outHouse.caller, { issueId: issueOut.id })
          outDenied = verdict.ok ? { denied: false, code: 'NOT_DENIED', message: `意外成功 run=${verdict.runId}` } : { denied: verdict.code === 'WORKFORCE_DISABLED', code: verdict.code, message: verdict.message }
        } catch (error) {
          outDenied = { denied: error?.code === 'WORKFORCE_DISABLED', code: error?.code ?? errText(error), message: error?.message ?? '' } // admission 收口形态：抛 WorkforceError(403)
        }
        check('灰度D-②：关闭组织认领被拒 WORKFORCE_DISABLED（中文灰度语义，非静默回落 legacy）',
          outDenied.denied && outDenied.message.includes('灰度关闭'), JSON.stringify(outDenied).slice(0, 240))
        check('灰度D-②：拒绝发生在确认前（名单外任务无 run 投影、无 permit——不产生半开工作状态）',
          (issueOut.executionRunId ?? '') === '' && grayCtx.workforceStore.permits.findWhere({ employeeId: outHouse.employee.id }).length === 0,
          `executionRunId=${issueOut.executionRunId ?? '空'} permits=${grayCtx.workforceStore.permits.findWhere({ employeeId: outHouse.employee.id }).length}`)
        // 事件可观测（总线异步串行派发，断言前排水）：admission surface + port surface 双口径
        await new Promise((resolve) => setTimeout(resolve, 300))
        check('灰度D-②：workforce.gray.denied 事件可观测（surface=admission，payload 含 orgId/employeeId/at）',
          grayEvents.some((e) => e.surface === 'admission' && e.orgId === orgOut.id && e.employeeId === outHouse.employee.id && Boolean(e.at)),
          JSON.stringify(grayEvents).slice(0, 240))
        const portVerdict = await grayCtx.workforcePolicy.port().authorizeWorkAction(outHouse.caller, { facts: { kind: 'model', registryId: GRAY_MODEL, action: 'invoke', risk: 'read' }, ref: {} })
        await new Promise((resolve) => setTimeout(resolve, 300))
        check('灰度D-②：port 侧同口径拒绝（authorizeWorkAction → WORKFORCE_DISABLED + surface=port 事件，三分支口径一致）',
          portVerdict?.allow === false && portVerdict?.code === 'WORKFORCE_DISABLED' && grayEvents.some((e) => e.surface === 'port' && e.orgId === orgOut.id),
          JSON.stringify({ verdict: portVerdict, events: grayEvents.map((e) => e.surface) }).slice(0, 240))
        // 观测面不拦：名单外员工身份解析照常（V29 口径=拒绝并可观测，非失联）
        const outResolution = await grayCtx.workforceIdentity.resolveByCaller(outHouse.caller)
        check('灰度D-②：观测面不拦（名单外员工身份仍可解析，拉取/状态查询保持开放）',
          Boolean(outResolution) && outResolution.employee.id === outHouse.employee.id)
        await rm(grayDataDir, { recursive: true, force: true }).catch(() => { /* 主终扫兜底 */ })
      } catch (error) {
        check('灰度D-②：灰度收口子段（独立最小树 allowlist）', false, `子段异常：${error instanceof Error ? error.stack?.slice(0, 300) ?? error.message : String(error)}`)
      }

      // -- W2（四入口等价 §2.3）：同一机器凭证经 REST /api/mcp/invoke 携带 work 索引与 /mcp 工具面同约束
      try {
        // 1. 托管演示服务（hosted+demo，无外网依赖；defaultToolsFor 产出 <slug>_search 等）
        const w2Slug = `g7-w2-probe-${Date.now() % 100000}`
        const w2Svc = await wfApi('POST', '/api/mcp/services', { token: wfAdminToken, body: { name: '组7 W2 接入面等价自测', slug: w2Slug, orgId: wfOrg.id, transport: 'http', mode: 'hosted', exec: 'demo' } })
        const w2SvcId = w2Svc.data?.id
        check('W2 夹具：托管演示服务注册+verify+全量上线', Boolean(w2SvcId), `status=${w2Svc.status} error=${JSON.stringify(w2Svc.error ?? {}).slice(0, 160)}`)
        await wfApi('POST', `/api/mcp/services/${w2SvcId}/verify`, { token: wfAdminToken })
        await wfApi('POST', `/api/mcp/services/${w2SvcId}/deploy`, { token: wfAdminToken, body: { grayPercent: 100, changelog: 'W2 全量' } })
        const w2Tool = `${w2Slug}_search`
        // 2. Agent 主体 MCP 权限组（只读约束——与 /mcp 工具面同一约束形态）
        await wfApi('POST', '/api/mcp/perm-groups', { token: wfAdminToken, body: {
          name: '组7 W2 agent 只读', policies: { [w2SvcId]: { allowedTools: '*', constraints: { readOnly: true } } },
          subjects: [{ type: 'agent', id: g7Agent.id, name: g7Agent.name }],
        } })
        // 3. 任用升版：追加真实 mcp grant（服务已上线+权限组在位，激活探针可通过）
        const w2Appt = wfCtx.workforceAppointments.create({ employeeId: employee.id, position: '质量分析员', orgId: wfOrg.id, dataClass: 'internal', effectiveFrom: new Date().toISOString(), grants: [
          { kind: 'model', registryId: G7_MODEL_SLUG, actions: ['invoke'], risk: 'read' },
          { kind: 'mcp', registryId: w2SvcId, actions: [w2Tool], risk: 'read' },
        ], approvedBy: adminUser.id })
        const w2ApptActivated = await wfCtx.workforceAppointments.activate(adminCaller, w2Appt.id)
        // 4. 新任务认领 → 新 permit（旧 permit 已被停职链路撤销）
        const w2Issue = wfCtx.execHub.createIssue({ orgId: wfOrg.id, title: '组7 W2 REST 接入面等价', assigneeAgentId: g7Agent.id, createdBy: 'selftest-w2' })
        const w2Claim = await wfCtx.workforceAdmission.claimWork(g7AgentCaller, { issueId: w2Issue.id })
        check('W2 夹具：任用生效+认领成功（mcp 句柄入清单）',
          w2ApptActivated?.status === 'effective' && w2Claim.ok === true && w2Claim.tools.some((t) => t.kind === 'mcp' && t.action === w2Tool),
          `appt=${w2ApptActivated?.status}(${w2ApptActivated?.statusReason ?? ''}) claim=${JSON.stringify(w2Claim.ok ? {} : { code: w2Claim.code, message: w2Claim.message }).slice(0, 160)}`)
        // 5. 机器令牌（refType=agent 可反查员工绑定）经 REST：不带 work → TOOL_NOT_GRANTED（V28）
        const w2AgentCred = wfCtx.authn.createMachineCredential({ name: 'g7-w2-agent-token', refType: 'agent', refId: g7Agent.id, scopes: ['mcp.invoke'] })
        const w2AgentCc = await wfApi('POST', '/api/auth/client-credentials', { body: { clientId: w2AgentCred.clientId, clientSecret: w2AgentCred.clientSecret } })
        const w2NoWork = await wfApi('POST', '/api/mcp/invoke', { token: w2AgentCc.data?.token, body: { serviceId: w2SvcId, tool: w2Tool, args: { query: 'x' } } })
        check('W2：受管机器凭证经 REST 不带 work 索引 → TOOL_NOT_GRANTED（必须持 permit 经受控入口，V28）',
          w2NoWork.data?.status === 'denied' && w2NoWork.data?.code === 'TOOL_NOT_GRANTED',
          `status=${w2NoWork.data?.status} code=${w2NoWork.data?.code} err=${JSON.stringify(w2NoWork.error ?? {}).slice(0, 120)}`)
        // 6. 带 work 索引（permitId/runId/stepKey，§10.4 仅索引非授权事实）→ 闸门放行且 demo 调用成功
        const w2WithWork = await wfApi('POST', '/api/mcp/invoke', { token: w2AgentCc.data?.token, body: { serviceId: w2SvcId, tool: w2Tool, args: { query: 'x' }, work: { permitId: w2Claim.permit.id, runId: w2Claim.runId, stepKey: 'g7.w2.rest' } } })
        check('W2：携带 work 索引 → 受管闸门放行且调用成功（REST 面与 /mcp 工具面同凭证同约束，V01 完整态）',
          w2WithWork.data?.ok === true && w2WithWork.data?.status === 'ok',
          `status=${w2WithWork.data?.status} code=${w2WithWork.data?.code} err=${JSON.stringify(w2WithWork.data?.error ?? w2WithWork.error ?? {}).slice(0, 160)}`)
        // 7. 网关调用记录携带工作索引（与 /mcp 工具面 A23 同口径：work.permitId 落账）
        const w2CallRow = (await wfApi('GET', `/api/mcp/calls?serviceId=${w2SvcId}&status=ok`, { token: wfAdminToken })).data.items.find((c) => c.work?.permitId === w2Claim.permit.id)
        check('W2：网关调用记录关联工作索引（work.permitId 落 mcp:calls，四入口等价可对账）', Boolean(w2CallRow), JSON.stringify(w2CallRow ?? {}).slice(0, 160))
      } catch (error) {
        check('W2：REST /api/mcp/invoke work 索引透传断言', false, `异常：${errText(error)}`)
      }
    } catch (error) {
      check('REST 冒烟：GET /api/workforce/overview 200（workforce.read 权限令牌）', false, `异常：${errText(error)}`)
    }
  } catch (error) {
    check('数字员工工作闭环章节（组7）装配与执行', false, `章节异常中断：${error instanceof Error ? error.stack?.slice(0, 400) ?? error.message : String(error)}`)
  }

  // ================================================================ 收尾终检：凭证零进平台（红线一，T-24）
  // ================================================================ UI 全球化 i18n（2026-10-16 批次）
  section('UI 全球化 i18n（内核 t() / 词典齐套 / /locales 端点 / 请求级协商）')
  {
    const i18n = await import(new URL('../packages/platform-i18n/src/index.ts', import.meta.url))
    check('i18n 内核导入（platform-i18n）', typeof i18n.t === 'function' && typeof i18n.runWithLocale === 'function')
    check('t() zh-CN 原样 + 插值', i18n.runWithLocale('zh-CN', () => i18n.t('共 {n} 条', { n: 5 })) === '共 5 条')
    check('t() en-US 词典命中 + 插值', i18n.runWithLocale('en-US', () => i18n.t('共 {n} 条', { n: 5 })) === '5 in total')
    check('t() en-US 未命中优雅降级中文', i18n.runWithLocale('en-US', () => i18n.t('i18n 自测无词典键')) === 'i18n 自测无词典键')
    check('locale 决议链（query > cookie > Accept-Language > env）',
      i18n.resolveRequestLocale({ query: 'ja' }) === 'ja-JP'
      && i18n.resolveRequestLocale({ cookie: 'en-US', acceptLanguage: 'ja-JP' }) === 'en-US'
      && i18n.resolveRequestLocale({ acceptLanguage: 'fr-FR,ja;q=0.5' }) === 'ja-JP'
      && i18n.resolveRequestLocale({ env: 'en-GB' }) === 'en-US')
    // 词典齐套：全部 locale 目录 JSON 可解析 + en/ja 键集逐对一致
    // fileURLToPath（2026-11-02 Windows 合并回归）：.pathname 在 win32 带前导斜杠且 CJK 路径
    // 被 percent-encode（元冰可产品 → %E5%85%83…）——existsSync 全 miss、词典对数=4 假失败。
    const localeRoot = fileURLToPath(new URL('../packages/platform-i18n/locales/', import.meta.url))
    const dictParityFails = []
    let dictPairs = 0
    // 面板 SPA 词典层已随 2026-10-29 架构统一摘除（IAW 工作台为中文直出 SPA，无 locales 目录）
    for (const rootDir of [localeRoot,
      join(process.cwd(), 'packages', 'plugin-console', 'public', 'locales')]) {
      const enFiles = existsSync(join(rootDir, 'en-US')) ? readdirSync(join(rootDir, 'en-US')).filter((f) => f.endsWith('.json')) : []
      for (const name of enFiles) {
        const enPath = join(rootDir, 'en-US', name)
        const jaPath = join(rootDir, 'ja-JP', name)
        if (!existsSync(jaPath)) { dictParityFails.push(`缺 ja 侧文件：${jaPath}`); continue }
        let en, ja
        try { en = JSON.parse(readFileSync(enPath, 'utf8')); ja = JSON.parse(readFileSync(jaPath, 'utf8')) }
        catch (error) { dictParityFails.push(`JSON 解析失败 ${name}: ${error.message}`); continue }
        dictPairs += 1
        const enKeys = Object.keys(en).sort()
        const jaKeys = Object.keys(ja).sort()
        if (JSON.stringify(enKeys) !== JSON.stringify(jaKeys)) {
          const onlyEn = enKeys.filter((k) => !(k in ja)).slice(0, 3)
          const onlyJa = jaKeys.filter((k) => !(k in en)).slice(0, 3)
          dictParityFails.push(`${name} 键集不一致 onlyEn=${onlyEn} onlyJa=${onlyJa}`)
        }
      }
    }
    check(`词典齐套：${dictPairs} 对 en/ja 文件 JSON 可解析且键集一致`, dictPairs >= 8 && dictParityFails.length === 0, dictParityFails.slice(0, 4).join('；'))
    // /locales 合并端点 + 请求级语言协商
    const localesEn = await fetch(`${BASE}/locales/en-US`).then((r) => r.json())
    check('/locales/en-US 合并端点（catalog 含通用键，规模 >100）',
      localesEn.ok && localesEn.data.locale === 'en-US' && localesEn.data.count > 100 && typeof localesEn.data.catalog['确认'] === 'string')
    // /api/* 未带令牌必得 401（鉴权中间件先于路由），其文案随 ?lang= 切换即证明全链协商；
    // 默认（无 lang）输出与历史版本逐字节一致
    const probe401En = await fetch(`${BASE}/api/i18n-selftest-probe?lang=en-US`).then((r) => r.json())
    const probe401Zh = await fetch(`${BASE}/api/i18n-selftest-probe`).then((r) => r.json())
    check('请求级协商：?lang=en-US 鉴权 401 文案切英文，默认 zh 逐字节不变',
      probe401En.error?.code === 'UNAUTHORIZED' && probe401En.error?.message === 'Missing Bearer token. Please sign in first.'
      && probe401Zh.error?.code === 'UNAUTHORIZED' && probe401Zh.error?.message === '缺少 Bearer 令牌，请先登录')
  }

  // ================================================================ 演示只读态（DEMO_MODE=1，2026-10-17 批次）
  // 三道防线各有断言：① 白名单无写点（静态）② 写方法入口 405（运行时）③ 默认关闭（主实例回归）。
  // 另锁死本批次缺陷修复：console.read 五个纯读路由匿名 200（改前 /api/overview 声明
  // console.login → 演示访客打不开工作台首屏）。
  // ================================================================ 产品数字与装配一致性（防数字漂移护栏）
  // 加载屏三数（插件包 / 权限点 / REST 路由）此前无任何门禁，已连漂两次（84→85→94）。
  // 本节把三数与后端真实值绑定：任一处改动未同步即红，公网第一屏不再传播错误产品数字。
  section('产品数字与装配一致性（加载屏三数绑定后端真实值）')
  {
    const { readFileSync, readdirSync } = await import('node:fs')
    const bootHtml = readFileSync(join(process.cwd(), 'packages/plugin-console/public/index.html'), 'utf8')
    const bootMatch = bootHtml.match(/正在装载\s*(\d+)\s*个插件包\s*·\s*(\d+)\s*个权限点\s*·\s*(\d+)\s*个 REST 路由\s*·\s*(\d+)\s*个 MCP 工具/)
    check('加载屏三数可从 index.html 解析（护栏前提）', Boolean(bootMatch), bootHtml.slice(0, 0) || '未匹配到加载屏文案')
    if (bootMatch) {
      const [bootPackages, bootPermissions, bootRoutes, bootTools] = bootMatch.slice(1).map(Number)
      const pkgDirs = readdirSync(join(process.cwd(), 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
      check(`加载屏插件包数 ${bootPackages} = packages/ 目录数 ${pkgDirs}（插件数口径防漂移）`,
        bootPackages === pkgDirs, `加载屏=${bootPackages} 实际=${pkgDirs}`)
      const catalog = await api('GET', '/api/iam/permissions', { token: admin })
      const realPermissions = catalog.data?.catalog?.length ?? -1
      check(`加载屏权限点数 ${bootPermissions} = 后端权限目录 ${realPermissions}（权限点数防漂移）`,
        bootPermissions === realPermissions, `加载屏=${bootPermissions} 后端=${realPermissions}`)
      const matrix = await api('GET', '/api/platform/route-matrix', { token: admin })
      const uniqueRoutes = new Set([
        ...(matrix.data?.guarded ?? []).map((route) => `${route.method} ${route.path}`),
        ...(matrix.data?.publicEntries ?? []).map((route) => `${route.method} ${route.path}`),
        ...(matrix.data?.authenticated ?? []).map((route) => `${route.method} ${route.path}`),
      ]).size
      check(`加载屏 REST 路由数 ${bootRoutes} = 去重路由数 ${uniqueRoutes}（路由数防漂移）`,
        bootRoutes === uniqueRoutes, `加载屏=${bootRoutes} 实际=${uniqueRoutes}`)
      // bootTools 自本节建立起就被解析却从未断言——工具数因此从 86 漂到 96 无人发现。
      // 与 /api/platform/info 的 tools 数组长度绑定；落地页指标卡同口径。
      const toolsInfo = await api('GET', '/api/platform/info', { token: admin })
      const realTools = Array.isArray(toolsInfo.data?.tools) ? toolsInfo.data.tools.length : -1
      check(`加载屏 MCP 工具数 ${bootTools} = 后端 tools 数组长度 ${realTools}（工具数防漂移）`,
        bootTools === realTools, `加载屏=${bootTools} 后端=${realTools}`)
      // 落地页（/launch）对外承诺的四个数字同样绑定后端，避免「同一站点三个不同工具数」复发。
      const launchHtml = readFileSync(join(process.cwd(), 'packages/plugin-console/public/launch/index.html'), 'utf8')
      const launchTools = launchHtml.match(/<b>(\d+)<\/b><span>MCP tools<\/span>/)
      const launchRoutes = launchHtml.match(/<b>(\d+)<\/b><span>REST routes<\/span>/)
      check(`落地页 MCP 工具数 ${launchTools?.[1] ?? '缺失'} = 后端 ${realTools}（落地页工具数防漂移）`,
        Number(launchTools?.[1]) === realTools, `落地页=${launchTools?.[1]} 后端=${realTools}`)
      check(`落地页 REST 路由数 ${launchRoutes?.[1] ?? '缺失'} = 去重路由数 ${uniqueRoutes}（落地页路由数防漂移）`,
        Number(launchRoutes?.[1]) === uniqueRoutes, `落地页=${launchRoutes?.[1]} 实际=${uniqueRoutes}`)
      // 插件清单真实化（Q-18）：/api/platform/info 的插件数取实际装配树，不再写死 18
      const info = await api('GET', '/api/platform/info', { token: admin })
      const assembled = info.data?.pluginCount ?? -1
      check(`/api/platform/info 插件清单取自实际装配树（pluginCount=${assembled}，非写死值）`,
        assembled > 0 && assembled !== 18 && info.data?.plugins?.includes('a2a') && info.data?.plugins?.includes('uhp'),
        JSON.stringify(info.data?.plugins ?? []).slice(0, 160))
    }
  }

  section('演示只读态（DEMO_MODE=1：免登只读 / 写方法 405 / Bearer 行为不变）')
  {
    // -- 静态面：白名单卫生 + fail-closed 语义（不依赖任何实例） ----------------
    const demoModule = await import('../packages/plugin-console/src/demo-mode.ts')
    check('演示白名单无写点泄漏（findWritePermissionLeaks 为空数组）',
      Array.isArray(demoModule.findWritePermissionLeaks()) && demoModule.findWritePermissionLeaks().length === 0,
      JSON.stringify(demoModule.findWritePermissionLeaks()))
    check('演示白名单含控制台只读基线 console.read（工作台首屏声明点）',
      demoModule.DEMO_READONLY_PERMISSIONS.includes('console.read'))
    check('DEMO_MODE fail-closed：仅严格取值 \'1\' 启用（true/yes/on/缺省 均不启用）',
      demoModule.isDemoMode({}) === false
      && demoModule.isDemoMode({ DEMO_MODE: 'true' }) === false
      && demoModule.isDemoMode({ DEMO_MODE: 'yes' }) === false
      && demoModule.isDemoMode({ DEMO_MODE: '1' }) === true)
    const routeAudit = spawn(process.execPath, ['scripts/demo-route-audit.mjs'], { stdio: 'pipe' })
    const routeAuditCode = await new Promise((resolve) => routeAudit.on('close', resolve))
    check('演示只读面路由审计：GET/HEAD 声明点与白名单差集无缺口（demo-route-audit 零退出）', routeAuditCode === 0)

    // -- 非演示态回归（主实例未设 DEMO_MODE）：行为与改动前一致 ------------------
    const demoFlagOff = await api('GET', '/api/platform/demo')
    check('非演示态：/api/platform/demo 恒 {demo:false}（不含主体/权限任何字段）',
      demoFlagOff.ok === true && demoFlagOff.data?.demo === false && Object.keys(demoFlagOff.data ?? {}).length === 1,
      JSON.stringify(demoFlagOff.data ?? demoFlagOff.error).slice(0, 160))
    const anonOverviewOff = await api('GET', '/api/overview')
    check('非演示态：匿名 /api/overview 仍 401（默认关闭，不引入新鉴权面）', anonOverviewOff.status === 401)

    // -- 演示态运行时（独立实例：DEMO_MODE=1 + DEMO_SEED=1，隔离数据目录与端口） --
    const DEMO_PORT = (await freePort()) ?? 7319
    const DEMO_BASE = `http://127.0.0.1:${DEMO_PORT}`
    const demoDataDir = join(process.cwd(), 'data-selftest-demo')
    await rm(demoDataDir, { recursive: true, force: true })
    await mkdir(demoDataDir, { recursive: true })
    const demoProc = spawn(process.execPath, ['src/main.ts', '--port', String(DEMO_PORT), '--data', demoDataDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        DEMO_MODE: '1',
        DEMO_SEED: '1',
        OOMOL_CONNECT_ENCRYPTION_KEY: 'selftest-encryption-key-not-a-secret',
        OOMOL_CONNECT_ADMIN_TOKEN: OC_TOKEN,
        OOMOL_CONNECT_STUB_URL: OC_BASE,
        OOMOL_CONNECT_DEMO_SEED: '1',
        DSH_UPDATE_RAW_BASE: `http://127.0.0.1:${GH_PORT}`,
        DSH_UPDATE_API_BASE: `http://127.0.0.1:${GH_PORT}`,
        DSH_UPDATE_AUTO_CHECK: 'off',
        EXEC_HUB_TICK_MS: '600000',
        EXEC_HUB_FIRST_TICK_MS: '600000',
      },
    })
    let demoBooted = false
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      try {
        if ((await fetch(`${DEMO_BASE}/api/health`)).ok) { demoBooted = true; break }
      } catch { /* retry */ }
    }
    check('演示实例启动（DEMO_MODE=1 + DEMO_SEED=1，隔离实例）', demoBooted)
    if (demoBooted) {
      const demoApi = async (method, path, { token, body } = {}) => {
        const headers = { 'content-type': 'application/json' }
        if (token) headers.authorization = `Bearer ${token}`
        const res = await fetch(`${DEMO_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: res.status, json: await res.json().catch(() => null) }
      }
      const demoFlag = await demoApi('GET', '/api/platform/demo')
      check('演示态标记端点（公开）：{demo:true, principalId, name, readonlyPermissions[]}',
        demoFlag.status === 200 && demoFlag.json?.data?.demo === true && demoFlag.json.data?.principalId === 'demo-visitor'
        && typeof demoFlag.json.data?.name === 'string' && Array.isArray(demoFlag.json.data?.readonlyPermissions)
        && demoFlag.json.data.readonlyPermissions.length > 0,
        JSON.stringify(demoFlag.json?.data ?? demoFlag.json).slice(0, 160))
      check('演示态下发权限面与代码白名单逐项一致（防端点回显与常量双源漂移）',
        JSON.stringify([...(demoFlag.json?.data?.readonlyPermissions ?? [])].sort())
          === JSON.stringify([...demoModule.DEMO_READONLY_PERMISSIONS].sort()))
      // 本批次缺陷修复锁死：console.read 五路纯读路由匿名 200（验收：工作台首屏 0 个 403）
      for (const path of ['/api/overview', '/api/notifications', '/api/platform/info', '/api/tools/schemas', '/api/usage/recent']) {
        const res = await demoApi('GET', path)
        check(`演示态匿名 GET ${path} → 200（只读基线可达）`, res.status === 200, `status=${res.status}`)
      }
      // 第一道闸（权限集只含 .read）：挂写语义点的 GET 路由 403
      const demoPanelOrgs = await demoApi('GET', '/api/panel/orgs')
      check('演示态写语义点路由 403（GET /api/panel/orgs → panel.config.write）', demoPanelOrgs.status === 403, `status=${demoPanelOrgs.status}`)
      // 第二道闸（写方法入口即拒）：匿名 POST 一律 405 DEMO_READONLY
      const demoAnonPost = await demoApi('POST', '/api/exec/goals', { body: { name: '演示拒绝写入' } })
      check('演示态匿名写请求 405 DEMO_READONLY（纵深防御第二道闸）',
        demoAnonPost.status === 405 && demoAnonPost.json?.error?.code === 'DEMO_READONLY',
        JSON.stringify(demoAnonPost.json?.error ?? {}).slice(0, 160))
      // 安全审查 P0-03（2026-10-31）：演示只读闸门覆盖真实登录会话——演示种子口令为公开
      // 仓库常量（Ybk@2026），登录态写能力即公网写能力。现约定：登录可用（读=匿名访客同款），
      // 写方法对 Bearer 会话同样 405，种子管理员亦无写权限（生产基线实例不受影响）。
      const demoLogin = await demoApi('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
      check('演示态：登录端点照常可用（PUBLIC_PATHS 先于演示分支，访客仍可注册登录）',
        demoLogin.status === 200 && typeof demoLogin.json?.data?.token === 'string', `status=${demoLogin.status}`)
      const demoToken = demoLogin.json?.data?.token ?? ''
      const demoBearerOverview = await demoApi('GET', '/api/overview', { token: demoToken })
      check('演示态：带 Bearer 的真实用户照常读工作台（登录态读面与匿名访客同款）',
        demoBearerOverview.status === 200, `status=${demoBearerOverview.status}`)
      const demoBearerWrite = await demoApi('POST', '/api/notifications/read-cursor', { token: demoToken, body: {} })
      check('P0-03：演示态带 Bearer 的真实用户（含种子管理员）写请求同样 405 DEMO_READONLY',
        demoBearerWrite.status === 405 && demoBearerWrite.json?.error?.code === 'DEMO_READONLY',
        JSON.stringify(demoBearerWrite.json?.error ?? {}).slice(0, 160))
    }
    demoProc.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await rm(demoDataDir, { recursive: true, force: true }).catch(() => {})
  }

  // -- issue #10 回归：exec-hub 内置定时器自愈（不手动 tick 也产生心跳唤醒） ----------------
  // cordis ctx.effect(fn) 语义：fn 注册时立即执行、返回值才是 disposer——此前单层箭头把
  // tick/firstTick/metricsTimer 当场清掉，重启后调度链路静默失效（2026-10-28 生产实测）。
  {
    const TIMER_PORT = (await freePort()) ?? 7329
    const TIMER_BASE = `http://127.0.0.1:${TIMER_PORT}`
    const timerDataDir = join(process.cwd(), 'data-selftest-timer')
    await rm(timerDataDir, { recursive: true, force: true })
    await mkdir(timerDataDir, { recursive: true })
    const timerProc = spawn(process.execPath, ['src/main.ts', '--port', String(TIMER_PORT), '--data', timerDataDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        DEMO_SEED: '1',
        OOMOL_CONNECT_ENCRYPTION_KEY: 'selftest-encryption-key-not-a-secret',
        DSH_UPDATE_AUTO_CHECK: 'off',
        EXEC_HUB_TICK_MS: '600',
        EXEC_HUB_FIRST_TICK_MS: '300',
      },
    })
    let timerBooted = false
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      try {
        if ((await fetch(`${TIMER_BASE}/api/health`)).ok) { timerBooted = true; break }
      } catch { /* retry */ }
    }
    check('#10：短周期定时器实例启动（EXEC_HUB_TICK_MS=600）', timerBooted)
    if (timerBooted) {
      const timerApi = async (method, path, { token, body } = {}) => {
        const headers = { 'content-type': 'application/json' }
        if (token) headers.authorization = `Bearer ${token}`
        const res = await fetch(`${TIMER_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: res.status, json: await res.json().catch(() => null) }
      }
      // 健康检查先于演示种子完成即放行：登录与「找运行态 Agent」都轮询等待种子就绪（各 12s 上限）
      let timerToken = ''
      for (let i = 0; i < 40 && !timerToken; i++) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        const timerLogin = await timerApi('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
        timerToken = timerLogin.json?.data?.token ?? ''
      }
      check('#10：定时器实例管理员登录', Boolean(timerToken))
      let timerTarget = null
      for (let i = 0; i < 40 && !timerTarget; i++) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        const timerAgents = (await timerApi('GET', '/api/agents', { token: timerToken })).json?.data?.agents ?? []
        timerTarget = timerAgents.find((a) => a.status === 'online' || a.status === 'trial')
      }
      check('#10 前置：存在运行态 Agent 可配置心跳', Boolean(timerTarget))
      await timerApi('PATCH', `/api/agents/${timerTarget.id}`, { token: timerToken, body: { attrs: { heartbeatIntervalMinutes: 1 } } })
      // 不手动 tick：等待内置定时器自行产生心跳唤醒（firstTick 300ms + 周期 600ms，给 6s 余量）
      let timerWake = null
      for (let i = 0; i < 20 && !timerWake; i++) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        const wakes = (await timerApi('GET', '/api/exec/wakes', { token: timerToken })).json?.data?.wakes ?? []
        timerWake = wakes.find((w) => w.agentId === timerTarget.id && w.trigger === 'routine' && String(w.triggerDetail ?? '').startsWith('heartbeat:'))
      }
      check('#10：内置定时器自动入队心跳唤醒（零手动 tick，重启后调度链路不再静默失效）',
        Boolean(timerWake), JSON.stringify(timerWake ?? (await timerApi('GET', '/api/exec/wakes', { token: timerToken })).json?.data?.wakes?.length))
    }
    timerProc.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await rm(timerDataDir, { recursive: true, force: true }).catch(() => {})
  }

  // ================================================================ MCP 治理（W1-T1）：委托令牌与统一 Principal
  section('MCP 治理：委托令牌与统一 Principal')
  {
    const govAdminLogin = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
    check('治理自测：管理员登录', govAdminLogin.ok)
    const govAdmin = govAdminLogin.data.token
    const govAdminUid = govAdminLogin.data.user.id
    const govOrgId = govAdminLogin.data.user.orgId

    // —— 准备：Agent 注册（颁发机器凭证）+ 绑定管理员真人（guard 绑定通道的事实源）——
    const govAgentRes = await api('POST', '/api/agents', { token: govAdmin, body: { name: 'MCP 治理自测机器人', attrs: { description: '委托令牌与统一 Principal 端到端自测专用', model: 'deepseek-chat', riskLevel: 'low', avatar: '🛡️' } } })
    const govAgent = govAgentRes.data.agent
    const govBound = await api('POST', `/api/agents/${govAgent.id}/bindings`, { token: govAdmin, body: { userId: govAdminUid } })
    check('治理自测：Agent 注册并绑定真人', govAgentRes.ok && govBound.ok)
    const govPrincipals = (await api('GET', '/api/authn/principals', { token: govAdmin })).data.principals
    const govAgentPrincipal = govPrincipals.find((p) => p.refType === 'agent' && p.refId === govAgent.id)
    check('治理自测：Agent 机器主体存在（refType=agent）', Boolean(govAgentPrincipal))

    // —— 人类登录令牌 → exchange 到绑定 agent：aud=mcp:service:x，RFC 8693 形态 ——
    const govExchange = await api('POST', '/api/authn/token/exchange', { token: govAdmin, body: { targetPrincipalId: govAgentPrincipal.id, audience: 'mcp:service:selftest-gov', scopes: ['usage.write', 'iam.user.write'] } })
    check('委托令牌交换（人类→绑定 agent，RFC 8693 形态，默认 TTL 900s）',
      govExchange.ok && Boolean(govExchange.data?.access_token) && govExchange.data?.token_type === 'Bearer'
      && govExchange.data?.expires_in === 900 && govExchange.data?.issued_token_type === 'urn:ietf:params:oauth:token-type:access_token',
      JSON.stringify(govExchange.error))
    const govDelegated = govExchange.data?.access_token
    check('委托令牌 scopes 三方交集收敛（iam.user.write 不在目标主体即剔除）',
      govExchange.ok && String(govExchange.data?.scope ?? '').split(' ').filter(Boolean).sort().join(',') === 'usage.write',
      String(govExchange.data?.scope))

    // —— verify：sub=user、act 含 agent；委托令牌打 /api/auth/me 返回身份链 ——
    const govMe = await api('GET', '/api/auth/me', { token: govDelegated })
    check('委托令牌 /api/auth/me：sub=用户（kind=human）且 act=链首 human + agent',
      govMe.ok && govMe.data.kind === 'human' && govMe.data.userId === govAdminUid
      && Array.isArray(govMe.data.actChain) && govMe.data.actChain.length === 2
      && govMe.data.actChain[0].type === 'human' && govMe.data.actChain[1].type === 'machine',
      JSON.stringify(govMe.data))

    // —— 机器（agent 凭证）+ userId 换取 sub=该用户 的委托令牌（act=调用者主体）——
    const govCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: govAgentRes.data.credential.clientId, clientSecret: govAgentRes.data.credential.clientSecret } })
    check('治理自测：Agent 机器凭证登录', govCc.ok)
    const govMachExchange = await api('POST', '/api/authn/token/exchange', { token: govCc.data.token, body: { userId: govAdminUid, audience: 'mcp:service:selftest-gov', scopes: ['usage.write'] } })
    check('机器凭证携 userId 换取委托令牌（guard 绑定通道放行）',
      govMachExchange.ok && Boolean(govMachExchange.data?.access_token), JSON.stringify(govMachExchange.error))
    const govMachMe = await api('GET', '/api/auth/me', { token: govMachExchange.data?.access_token })
    check('机器换取的委托令牌：sub=该用户、act=调用者 agent',
      govMachMe.ok && govMachMe.data.userId === govAdminUid && (govMachMe.data.actChain ?? []).some((entry) => entry.type === 'machine'),
      JSON.stringify(govMachMe.data))

    // —— guard 拒绝 / audience 形态强校验 ——
    const govOtherUid = (await api('POST', '/api/auth/login', { body: { username: 'yqz', password: 'Ybk@2026' } })).data?.user?.id
    const govDenied = await api('POST', '/api/authn/token/exchange', { token: govCc.data.token, body: { userId: govOtherUid, audience: 'mcp:service:selftest-gov' } })
    check('guard 绑定校验：未绑定真人换取被拒（403 + DELEGATION_DENIED）',
      govDenied.status === 403 && govDenied.error?.reason === 'DELEGATION_DENIED', JSON.stringify(govDenied.error))
    const govBadAud = await api('POST', '/api/authn/token/exchange', { token: govAdmin, body: { targetPrincipalId: govAgentPrincipal.id, audience: 'https://evil.example' } })
    check('audience 形态强校验：非 mcp:service:/plugin: 拒绝（400 + DELEGATION_AUDIENCE_INVALID）',
      govBadAud.status === 400 && govBadAud.error?.reason === 'DELEGATION_AUDIENCE_INVALID', JSON.stringify(govBadAud.error))

    // —— 伪造 X-On-Behalf-User 头不能越过委托链（数据范围身份取链上真人，delegationSource=token）——
    // 目标主体补 nas.authz.check（scopes 调整联动吊销，需重新 exchange）后经委托令牌打 NAS 数据范围接口
    const govScopePatch = await api('PATCH', `/api/authn/principals/${govAgentPrincipal.id}`, { token: govAdmin, body: { scopes: ['usage.write', 'nas.authz.check'] } })
    check('治理自测：目标主体补 nas.authz.check（authn.principal.write）', govScopePatch.ok)
    const govNasExchange = await api('POST', '/api/authn/token/exchange', { token: govAdmin, body: { targetPrincipalId: govAgentPrincipal.id, audience: 'mcp:service:selftest-gov', scopes: ['nas.authz.check'] } })
    const govNasDelegated = govNasExchange.data?.access_token
    const govNasId = ((await api('GET', '/api/nas', { token: govAdmin })).data?.items ?? [])[0]?.id
    const forgedScope = await fetch(`${BASE}/api/nas/authz/scope?nasId=${encodeURIComponent(govNasId)}`, {
      headers: { authorization: `Bearer ${govNasDelegated}`, 'x-on-behalf-user': govOtherUid },
    }).then((r) => r.json()).catch(() => null)
    check('伪造 X-On-Behalf-User 不能越过委托链（delegationSource=token，范围身份=链上真人）',
      forgedScope?.data?.delegationSource === 'token' && forgedScope?.data?.onBehalfUserId === govAdminUid,
      JSON.stringify(forgedScope).slice(0, 240))
    const legacyScope = await fetch(`${BASE}/api/nas/authz/scope?nasId=${encodeURIComponent(govNasId)}`, {
      headers: { authorization: `Bearer ${govAdmin}`, 'x-on-behalf-user': govOtherUid },
    }).then((r) => r.json()).catch(() => null)
    check('无委托链时 X-On-Behalf-User 头降级兼容（delegationSource=header-legacy）',
      legacyScope?.data?.delegationSource === 'header-legacy' && legacyScope?.data?.onBehalfUserId === govOtherUid,
      JSON.stringify(legacyScope).slice(0, 240))

    // —— 冻结联动：冻结 subject 用户后其委托令牌即时 401（独立自测用户，不影响管理员会话）——
    const govSubRes = await api('POST', '/api/iam/users', { token: govAdmin, body: { username: 'gov_delegate', displayName: '委托自测用户', orgId: govOrgId, password: 'Ybk@2026' } })
    const govSubUid = govSubRes.data?.user?.id ?? govSubRes.data?.id
    await api('POST', `/api/iam/users/${govSubUid}/activate`, { token: govAdmin, body: {} })
    const govSubExchange = await api('POST', '/api/authn/token/exchange', { token: govAdmin, body: { userId: govSubUid, targetPrincipalId: govAgentPrincipal.id, audience: 'mcp:service:selftest-gov', scopes: ['usage.write'] } })
    check('治理自测：管理员为绑定用户换取委托令牌（impersonation 走 * 通道）',
      govSubExchange.ok && Boolean(govSubExchange.data?.access_token), JSON.stringify(govSubExchange.error))
    const govSubDelegated = govSubExchange.data?.access_token
    const govFreeze = await api('POST', `/api/iam/users/${govSubUid}/freeze`, { token: govAdmin, body: { reason: '委托令牌冻结联动自测' } })
    check('治理自测：冻结 subject 用户', govFreeze.ok)
    const govFrozenMe = await api('GET', '/api/auth/me', { token: govSubDelegated })
    check('冻结后委托令牌即时失效（401）', govFrozenMe.status === 401, String(govFrozenMe.status))
  }
  // ================================================================ MCP 治理（W2-T3/T4）：服务级数据面 + 能力绑定
  section('MCP 治理：服务级数据面与能力绑定')
  {
    // —— 夹具：导入 sse 桩服务（干净无头，自动上线）——
    const dpImport = await api('POST', '/api/mcp/import', { token: admin, body: { config: JSON.stringify({ mcpServers: { 'gov-dataplane': { type: 'http', url: `http://127.0.0.1:${ssePort}/api/mcp` } } }) } })
    check('数据面：导入服务自动发现并上线', dpImport.ok && dpImport.data.results[0].ok === true && dpImport.data.results[0].reachable === true && dpImport.data.results[0].status === 'online', JSON.stringify(dpImport).slice(0, 240))
    const dpSvcId = dpImport.data.results[0].serviceId
    const dpSlug = dpImport.data.results[0].slug

    // —— 夹具：Agent + 绑定 + 服务级受众委托令牌 ——
    const dpAgentRes = await api('POST', '/api/agents', { token: admin, body: { name: '数据面自测机器人', attrs: { description: '服务级 MCP 数据面端到端自测', model: 'deepseek-chat', riskLevel: 'low', avatar: '🔌' } } })
    const dpAgent = dpAgentRes.data.agent
    await api('POST', `/api/agents/${dpAgent.id}/bindings`, { token: admin, body: { userId: adminLogin.data.user.id } })
    const dpPrincipal = ((await api('GET', '/api/authn/principals', { token: admin })).data.principals ?? []).find((p) => p.refType === 'agent' && p.refId === dpAgent.id)
    const dpEx = await api('POST', '/api/authn/token/exchange', { token: admin, body: { targetPrincipalId: dpPrincipal.id, audience: `mcp:service:${dpSlug}`, scopes: ['mcp.invoke'] } })
    check('数据面：服务级受众委托令牌签发', dpEx.ok && Boolean(dpEx.data?.access_token), JSON.stringify(dpEx.error))
    const dpTok = dpEx.data.access_token
    const dpCall = async (token, method, params, session) => rawReq('POST', `/mcp/services/${dpSlug}`, {
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, ...(params !== undefined ? { params } : {}) }),
    }).then((r) => ({ status: r.status, headers: r.headers, payload: jsonBody(r) }))

    // —— initialize：协议握手 + 会话头 ——
    const dpInit = await dpCall(dpTok, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } })
    check('数据面 initialize：serverInfo=mcp:<slug> + mcp-session-id 会话头',
      dpInit.status === 200 && dpInit.payload.result?.serverInfo?.name === `mcp:${dpSlug}` && Boolean(dpInit.headers['mcp-session-id']),
      JSON.stringify(dpInit.payload).slice(0, 240))
    const dpSession = dpInit.headers['mcp-session-id']

    // —— tools/list：无权限组 → 空集（未授权工具不泄露）——
    const dpList0 = await dpCall(dpTok, 'tools/list', {}, dpSession)
    check('数据面 tools/list：无权限组时空集（工具清单零泄露）',
      dpList0.status === 200 && Array.isArray(dpList0.payload.result?.tools) && dpList0.payload.result.tools.length === 0,
      JSON.stringify(dpList0.payload).slice(0, 240))

    // —— 授权后列表与裁决一致：委托令牌 sub=用户（代理语义，权限主体是被代理用户），agent 自身凭证主体是 agent；
    //    平台 '*' 权限不旁路 MCP 权限组（与 /api/mcp/invoke 既有口径一致）——双主体各建一组，策略同为单工具只读
    await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
      name: '数据面自测·用户主体单工具只读', policies: { [dpSvcId]: { allowedTools: ['tb_query_task'], constraints: { readOnly: true } } },
      subjects: [{ type: 'user', id: adminLogin.data.user.id, name: 'admin' }],
    } })
    await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
      name: '数据面自测·Agent 主体单工具只读', policies: { [dpSvcId]: { allowedTools: ['tb_query_task'], constraints: { readOnly: true } } },
      subjects: [{ type: 'agent', id: dpAgent.id, name: '数据面自测机器人' }],
    } })
    const dpList1 = await dpCall(dpTok, 'tools/list', {}, dpSession)
    const dpNames = (dpList1.payload.result?.tools ?? []).map((tool) => tool.name).sort().join(',')
    check('数据面 tools/list：授权后仅返回可调用工具（whoami 不出现）', dpNames === 'tb_query_task', dpNames || JSON.stringify(dpList1.payload).slice(0, 240))
    const dpOk = await dpCall(dpTok, 'tools/call', { name: 'tb_query_task', arguments: { id: 't-1' } }, dpSession)
    check('数据面 tools/call：委托令牌真实调用经网关全链路（content 包装 + 回显）',
      dpOk.status === 200 && dpOk.payload.result?.isError === false && String(dpOk.payload.result?.content?.[0]?.text ?? '').includes('sse-echo:tb_query_task'),
      JSON.stringify(dpOk.payload).slice(0, 300))
    const dpDeny = await dpCall(dpTok, 'tools/call', { name: 'whoami', arguments: {} }, dpSession)
    check('数据面 tools/call：列表外工具拒绝（-32003 TOOL_NOT_VISIBLE_OR_DENIED，不泄露存在性）',
      dpDeny.status === 200 && dpDeny.payload.error?.code === -32003 && dpDeny.payload.error?.data?.code === 'TOOL_NOT_VISIBLE_OR_DENIED',
      JSON.stringify(dpDeny.payload).slice(0, 240))
    // Agent 自身机器凭证（主体=agent）走 agent 权限组：验证 agent 主体匹配路径
    const dpCc = await api('POST', '/api/auth/client-credentials', { body: { clientId: dpAgentRes.data.credential.clientId, clientSecret: dpAgentRes.data.credential.clientSecret } })
    const dpAgentCall = await dpCall(dpCc.data.token, 'tools/call', { name: 'tb_query_task', arguments: { id: 't-2' } })
    check('数据面 tools/call：Agent 自身凭证（主体=agent）经 agent 权限组放行',
      dpAgentCall.status === 200 && dpAgentCall.payload.result?.isError === false, JSON.stringify(dpAgentCall.payload).slice(0, 240))

    // —— audience 强校验 + 未认证 + 平台令牌同裁决 ——
    const dpExBad = await api('POST', '/api/authn/token/exchange', { token: admin, body: { targetPrincipalId: dpPrincipal.id, audience: 'mcp:service:other-service', scopes: ['mcp.invoke'] } })
    const dpBad = await dpCall(dpExBad.data.access_token, 'tools/list', {}, dpSession)
    check('数据面：audience 不匹配拒绝（-32003 AUDIENCE_MISMATCH）',
      dpBad.status === 403 && dpBad.payload.error?.data?.code === 'AUDIENCE_MISMATCH', JSON.stringify(dpBad.payload).slice(0, 200))
    const dpAnon = await dpCall('', 'ping')
    check('数据面：无 Bearer 401（-32001）', dpAnon.status === 401 && dpAnon.payload.error?.code === -32001, JSON.stringify(dpAnon.payload).slice(0, 160))
    const dpAdminList = await dpCall(admin, 'tools/list', {}, dpSession)
    const dpAdminNames = (dpAdminList.payload.result?.tools ?? []).map((tool) => tool.name).sort().join(',')
    check('数据面：平台令牌（无 aud，* 权限）同样只见权限组裁决集（* 不旁路 MCP 权限组）',
      dpAdminList.status === 200 && dpAdminNames === 'tb_query_task', dpAdminNames || JSON.stringify(dpAdminList.payload).slice(0, 200))

    // —— 能力绑定：绑定回写归属 / 重复归属 409 / 解绑还原 ——
    const dpDraft = await api('POST', '/api/mcp/services', { token: admin, body: { name: '能力门禁草稿服务', description: 'W2 能力绑定自测', endpoint: 'http://127.0.0.1:9/none', transport: 'http', mode: 'external' } })
    check('能力绑定：草稿服务夹具就绪', dpDraft.ok && dpDraft.data?.status === 'draft', JSON.stringify(dpDraft).slice(0, 200))
    const dpDraftId = dpDraft.data.id
    const capApp = await api('POST', '/api/apps', { token: admin, body: { name: '能力绑定验收应用', attrs: { description: 'W2 能力绑定端到端自测', appType: 'web', riskLevel: 'low', dataClass: 'internal' } } })
    const capAppId = capApp.data.app.id
    const capBind = await api('POST', `/api/apps/${capAppId}/capabilities`, { token: admin, body: { serviceId: dpDraftId, required: true } })
    const capSvcAfter = (await api('GET', '/api/mcp/services', { token: admin })).data.services.find((s) => s.id === dpDraftId)
    check('能力绑定：绑定成功且服务 ownerEntity 回写为 app', capBind.ok && capSvcAfter?.ownerEntity?.type === 'app' && capSvcAfter?.ownerEntity?.id === capAppId, JSON.stringify({ bind: capBind.error, owner: capSvcAfter?.ownerEntity }))
    const capApp2 = await api('POST', '/api/apps', { token: admin, body: { name: '能力冲突验收应用', attrs: { description: 'W2 归属冲突自测', appType: 'web', riskLevel: 'low', dataClass: 'internal' } } })
    const capBind2 = await api('POST', `/api/apps/${capApp2.data.app.id}/capabilities`, { token: admin, body: { serviceId: dpDraftId, required: false } })
    check('能力绑定：已归属其他应用的重复认领 409 OWNER_CONFLICT', capBind2.status === 409 && capBind2.error?.code === 'OWNER_CONFLICT', JSON.stringify(capBind2.error))
    const capUnbind = await api('DELETE', `/api/apps/${capAppId}/capabilities/${dpDraftId}`, { token: admin })
    const capSvcFinal = (await api('GET', '/api/mcp/services', { token: admin })).data.services.find((s) => s.id === dpDraftId)
    check('能力绑定：解绑幂等且归属还原 platform', capUnbind.ok && capSvcFinal?.ownerEntity?.type === 'platform', JSON.stringify(capSvcFinal?.ownerEntity))
  }


  // ================================================================ MCP 治理（W4 安全审计整改）：P0 回归护栏
  section('MCP 治理：P0 安全整改回归（自委托 / 主体匹配 / 哈希链可校验 / 审计决策依据）')
  {
    // —— 夹具：干净服务 + Agent 主体权限组 ——
    const p0Import = await api('POST', '/api/mcp/import', { token: admin, body: { config: JSON.stringify({ mcpServers: { 'gov-p0-svc': { type: 'http', url: `http://127.0.0.1:${ssePort}/api/mcp` } } }) } })
    const p0SvcId = p0Import.data.results[0].serviceId
    const p0Slug = p0Import.data.results[0].slug
    const p0AgentRes = await api('POST', '/api/agents', { token: admin, body: { name: 'P0 回归机器人', attrs: { description: 'W4 P0 回归自测', model: 'deepseek-chat', riskLevel: 'low', avatar: '🧪' } } })
    const p0Agent = p0AgentRes.data.agent
    await api('POST', `/api/agents/${p0Agent.id}/bindings`, { token: admin, body: { userId: adminLogin.data.user.id } })
    await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
      name: 'P0 回归·Agent 主体', policies: { [p0SvcId]: { allowedTools: '*', constraints: { readOnly: true } } },
      subjects: [{ type: 'agent', id: p0Agent.id, name: 'P0 回归机器人' }],
    } })
    const p0Cc = await api('POST', '/api/auth/client-credentials', { body: { clientId: p0AgentRes.data.credential.clientId, clientSecret: p0AgentRes.data.credential.clientSecret } })
    check('P0：Agent 机器凭证登录', p0Cc.ok, JSON.stringify(p0Cc.error))

    // —— P0-2：机器自委托（sub=自身，仅传 audience）——接入示例按此形态可用 ——
    const p0Self = await api('POST', '/api/authn/token/exchange', { token: p0Cc.data.token, body: { audience: `mcp:service:${p0Slug}`, scopes: ['mcp.invoke'] } })
    check('P0-2：机器自委托换牌成功（不传 userId，sub=自身）',
      p0Self.ok && Boolean(p0Self.data?.access_token) && p0Self.data?.expires_in === 900, JSON.stringify(p0Self.error))
    const p0SelfCall = await rawReq('POST', `/mcp/services/${p0Slug}`, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p0Self.data.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'tb_query_task', arguments: { id: 'p0' } } }),
    }).then((r) => ({ status: r.status, payload: jsonBody(r) }))
    check('P0-3：自委托令牌命中 agent 主体权限组（工具集非空，主体匹配含委托链 actor）',
      p0SelfCall.status === 200 && p0SelfCall.payload.result?.isError === false,
      JSON.stringify(p0SelfCall.payload).slice(0, 240))

    // —— P0-3：人类代用户委托时，链上 agent 主体权限组同样生效 ——
    const p0UserEx = await api('POST', '/api/authn/token/exchange', { token: p0Cc.data.token, body: { userId: adminLogin.data.user.id, audience: `mcp:service:${p0Slug}`, scopes: ['mcp.invoke'] } })
    const p0UserCall = await rawReq('POST', `/mcp/services/${p0Slug}`, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p0UserEx.data.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list' }),
    }).then((r) => ({ status: r.status, payload: jsonBody(r) }))
    const p0UserTools = (p0UserCall.payload.result?.tools ?? []).map((tool) => tool.name)
    check('P0-3：代用户委托令牌（sub=用户）命中链上 agent 主体权限组',
      p0UserCall.status === 200 && p0UserTools.length > 0, JSON.stringify(p0UserCall.payload).slice(0, 240))

    // —— P0-4：审计事件落 decisionId / 决策原因，且策略拒绝与上游故障分档 ——
    const p0Audit = await api('GET', '/api/audit/logs?q=' + encodeURIComponent('mcp.gateway.invoke') + '&limit=50', { token: admin })
    const p0InvokeLogs = (p0Audit.data?.items ?? []).filter((log) => log.action === 'mcp.gateway.invoke')
    check('P0-4：MCP 调用审计落 decisionId（决策依据可回查）',
      p0InvokeLogs.some((log) => Boolean(log.decisionId)), JSON.stringify(p0InvokeLogs[0] ?? {}).slice(0, 240))

    // —— P0-1：审计哈希链对落盘记录可重算校验（JSON 往返后仍一致）——
    const p0Export = await rawReq('GET', '/api/audit/export', { headers: { authorization: `Bearer ${admin}` } })
    const p0Lines = String(p0Export.body ?? '').split('\n').filter((line) => line.trim().length > 0)
    const p0Records = p0Lines.map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((row) => row && !row._chainTip)
    const p0Canonical = (value, exclude) => {
      const skip = new Set(exclude)
      const walk = (input) => {
        if (input === null || input === undefined) return 'null'
        if (typeof input !== 'object') return JSON.stringify(input) ?? 'null'
        if (Array.isArray(input)) return `[${input.map(walk).join(',')}]`
        const keys = Object.keys(input).filter((key) => !skip.has(key) && input[key] !== undefined).sort()
        return `{${keys.map((key) => `${JSON.stringify(key)}:${walk(input[key])}`).join(',')}}`
      }
      return walk(value)
    }
    const p0HashOf = (record, prev) => {
      const excluded = ['createdAt', 'updatedAt', 'prevHash', 'hash']
      return createHash('sha256').update(prev + p0Canonical(record, excluded)).digest('hex')
    }
    let p0ChainOk = p0Records.length > 0
    let p0Prev = ''
    for (const record of p0Records) {
      if ((record.prevHash ?? '') !== p0Prev) { p0ChainOk = false; break }
      if (p0HashOf(record, p0Prev) !== record.hash) { p0ChainOk = false; break }
      p0Prev = record.hash
    }
    check('P0-1：审计哈希链对落盘记录可重算校验（逐条 prevHash 相接 + hash 一致）', p0ChainOk, `记录数=${p0Records.length}`)
  }

  // ================================================================ 资产使用凭证（2026-10-31）
  // 链路：登记 → 获取（=授权）→ 使用 → 逐次提报使用凭证 → 台账/审计经营关联。
  // 授权闭环：skill=install 边 ∪ download 流水（机器主体按 principalId）；mcp=权限组 subjects+policies。
  section('资产使用凭证：授权闭环 / 幂等 / 经营关联')
  {
    const aurAdminLogin = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
    check('凭证自测：管理员登录', aurAdminLogin.ok)
    const aurAdmin = aurAdminLogin.data.token
    const aurOrgId = aurAdminLogin.data.user.orgId

    // —— 准备：注册两个 Agent（A1=install 路径、A2=download/mcp 路径）+ 机器登录 ——
    const aurAgent1Res = await api('POST', '/api/agents', { token: aurAdmin, body: { name: '资产凭证自测机器人A1', attrs: { description: '资产使用凭证链路自测（install 路径）', model: 'deepseek-chat', riskLevel: 'low', avatar: '🧾' } } })
    const aurAgent2Res = await api('POST', '/api/agents', { token: aurAdmin, body: { name: '资产凭证自测机器人A2', attrs: { description: '资产使用凭证链路自测（download/mcp 路径）', model: 'deepseek-chat', riskLevel: 'low', avatar: '🧾' } } })
    check('凭证自测：两个 Agent 注册并下发机器凭证', aurAgent1Res.ok && aurAgent2Res.ok
      && Boolean(aurAgent1Res.data?.credential?.clientId) && Boolean(aurAgent2Res.data?.credential?.clientId))
    const aurAgent1 = aurAgent1Res.data.agent.id
    const aurAgent2 = aurAgent2Res.data.agent.id
    const aurCc1 = await api('POST', '/api/auth/client-credentials', { body: { clientId: aurAgent1Res.data.credential.clientId, clientSecret: aurAgent1Res.data.credential.clientSecret } })
    const aurCc2 = await api('POST', '/api/auth/client-credentials', { body: { clientId: aurAgent2Res.data.credential.clientId, clientSecret: aurAgent2Res.data.credential.clientSecret } })
    check('凭证自测：两台机器凭证换令牌（默认 scope 含 usage.write）', aurCc1.ok && aurCc2.ok && aurCc1.data.token && aurCc2.data.token)
    const aurMach1 = aurCc1.data.token
    const aurMach2 = aurCc2.data.token

    // —— 准备：自测 Skill 提交→审批→上架 + 自测 MCP 服务纳管 ——
    const aurSkillRes = await api('POST', '/api/skills', { token: aurAdmin, body: { name: '资产凭证自测助手', summary: '资产使用凭证链路自测专用', content: '# 资产凭证自测助手\n\n## 何时使用\n使用凭证链路自测。\n\n## 步骤\n1. 提报使用凭证', category: '研发效能', version: '1.0.0' } })
    await api('POST', `/api/skills/${aurSkillRes.data.id}/approve`, { token: aurAdmin, body: { decision: 'approve', level: 'domain', opinion: '自测' } })
    const aurPublish = await api('POST', `/api/skills/${aurSkillRes.data.id}/publish`, { token: aurAdmin, body: {} })
    check('凭证自测：Skill 上架', aurSkillRes.ok && aurPublish.ok, JSON.stringify(aurSkillRes.error ?? aurPublish.error))
    const aurSkillId = aurSkillRes.data.id
    const aurSvcRes = await api('POST', '/api/mcp/services', { token: aurAdmin, body: { name: '资产凭证自测服务', slug: 'selftest-asset-usage', orgId: aurOrgId, description: '使用凭证链路自测（演示传输层）', transport: 'http', mode: 'hosted', exec: 'demo' } })
    check('凭证自测：MCP 服务纳管', aurSvcRes.ok && Boolean(aurSvcRes.data?.service?.id ?? aurSvcRes.data?.id), JSON.stringify(aurSvcRes.error))
    const aurSvcId = aurSvcRes.data?.service?.id ?? aurSvcRes.data?.id

    // —— 鉴权与字段门禁 ——
    const aurNoAuth = await fetch(`${BASE}/api/assets/usage-reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
    check('无令牌提报被拒（401，鉴权中间件先于路由）', aurNoAuth.status === 401, String(aurNoAuth.status))
    const aurBadType = await api('POST', '/api/assets/usage-reports', { token: aurMach1, body: { assetType: 'nas', assetRef: 'x', idempotencyKey: 'k1' } })
    check('assetType 枚举门禁（nas 被 400 拒绝，v1 只收 skill|mcp）', aurBadType.status === 400, JSON.stringify(aurBadType.error))
    const aurNoGrant = await api('POST', '/api/assets/usage-reports', { token: aurMach1, body: { assetType: 'skill', assetRef: String(aurSkillId), idempotencyKey: 'aur-agt1:pre-grant' } })
    check('授权闭环：未获取先提报被拒（403 NO_GRANT）', aurNoGrant.status === 403 && aurNoGrant.error?.code === 'NO_GRANT', JSON.stringify(aurNoGrant.error))
    const aurNotFound = await api('POST', '/api/assets/usage-reports', { token: aurMach1, body: { assetType: 'skill', assetRef: 'no-such-skill-xyz', idempotencyKey: 'aur-agt1:not-found' } })
    check('资产存在性门禁：不存在的 Skill 被拒（404 ASSET_NOT_FOUND，防编造凭证）', aurNotFound.status === 404 && aurNotFound.error?.code === 'ASSET_NOT_FOUND', JSON.stringify(aurNotFound.error))
    const aurStale = await api('POST', '/api/assets/usage-reports', { token: aurMach1, body: { assetType: 'skill', assetRef: String(aurSkillId), occurredAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), idempotencyKey: 'aur-agt1:stale' } })
    check('补录窗口门禁：occurredAt 超 30 天被拒（400）', aurStale.status === 400, JSON.stringify(aurStale.error))

    // —— install 授权路径：管理员安装后 A1 提报成功 + 归因 ——
    const aurInstall = await api('POST', `/api/skills/${aurSkillId}/install`, { token: aurAdmin, body: { agentId: aurAgent1 } })
    check('凭证自测：管理员 install（获取=授权）', aurInstall.ok)
    const aurReport1 = await api('POST', '/api/assets/usage-reports', { token: aurMach1, body: {
      assetType: 'skill', assetRef: String(aurSkillId), assetVersion: '1.0.0', taskId: 'task-001', durationMs: 1200, tokens: 456,
      idempotencyKey: 'aur-agt1:task-001',
    } })
    check('install 后提报成功（200，归因 agentId + 台账键 skill:<id> + 默认 action/outcome）',
      aurReport1.ok && aurReport1.data.report.agentId === aurAgent1 && aurReport1.data.report.assetKey === `skill:${aurSkillId}`
      && aurReport1.data.report.action === 'invoke' && aurReport1.data.report.outcome === 'success'
      && aurReport1.data.report.reporterType === 'machine' && aurReport1.data.deduped === false,
      JSON.stringify(aurReport1.error ?? aurReport1.data?.report))
    const aurReport1Id = aurReport1.data?.report?.id

    // —— 幂等：同键同内容重放安全；同键异容 409 ——
    const aurReplay = await api('POST', '/api/assets/usage-reports', { token: aurMach1, body: {
      assetType: 'skill', assetRef: String(aurSkillId), assetVersion: '1.0.0', taskId: 'task-001', durationMs: 1200, tokens: 456,
      idempotencyKey: 'aur-agt1:task-001',
    } })
    check('幂等：同键同内容重放返回原凭证（deduped=true，不重复入账）',
      aurReplay.ok && aurReplay.data.deduped === true && aurReplay.data.report.id === aurReport1Id, JSON.stringify(aurReplay.data))
    const aurConflict = await api('POST', '/api/assets/usage-reports', { token: aurMach1, body: {
      assetType: 'skill', assetRef: String(aurSkillId), taskId: 'task-002',
      idempotencyKey: 'aur-agt1:task-001',
    } })
    check('幂等：同键不同内容被拒（409 IDEMPOTENCY_CONFLICT）', aurConflict.status === 409 && aurConflict.error?.code === 'IDEMPOTENCY_CONFLICT', JSON.stringify(aurConflict.error))

    // —— download 授权路径：A2 自取后提报成功（自取同样构成授权记录）——
    const aurDownload = await api('POST', `/api/skills/${aurSkillId}/download`, { token: aurMach2, body: {} })
    check('凭证自测：A2 机器自取 skill 包', aurDownload.ok)
    const aurReport2 = await api('POST', '/api/assets/usage-reports', { token: aurMach2, body: {
      assetType: 'skill', assetRef: '资产凭证自测助手', idempotencyKey: 'aur-agt2:task-001',
    } })
    check('download 后提报成功（slug 引用归一化为 skill:<id>，按 principalId 匹配授权）',
      aurReport2.ok && aurReport2.data.report.agentId === aurAgent2 && aurReport2.data.report.assetKey === `skill:${aurSkillId}`,
      JSON.stringify(aurReport2.error ?? aurReport2.data?.report))

    // —— MCP 授权路径：权限组 subjects+policies 口径（与数据面同源）——
    const aurMcpDenied = await api('POST', '/api/assets/usage-reports', { token: aurMach1, body: { assetType: 'mcp', assetRef: 'selftest-asset-usage', idempotencyKey: 'aur-agt1:mcp-001' } })
    check('MCP 授权闭环：未配权限组的 Agent 提报被拒（403 NO_GRANT）', aurMcpDenied.status === 403, JSON.stringify(aurMcpDenied.error))
    const aurPg = await api('POST', '/api/mcp/perm-groups', { token: aurAdmin, body: {
      name: '资产凭证自测权限组', policies: { [aurSvcId]: { allowedTools: '*', constraints: { readOnly: true } } },
      subjects: [{ type: 'agent', id: aurAgent2 }],
    } })
    check('凭证自测：A2 配入 MCP 权限组（subjects 含 agent）', aurPg.ok, JSON.stringify(aurPg.error))
    const aurMcpReport = await api('POST', '/api/assets/usage-reports', { token: aurMach2, body: {
      assetType: 'mcp', assetRef: 'selftest-asset-usage', action: 'call', outcome: 'failure', taskId: 'task-003',
      idempotencyKey: 'aur-agt2:mcp-001',
    } })
    check('MCP 授权后提报成功（failure 如实入账，assetKey=mcp:<slug>）',
      aurMcpReport.ok && aurMcpReport.data.report.assetKey === 'mcp:selftest-asset-usage'
      && aurMcpReport.data.report.outcome === 'failure' && aurMcpReport.data.report.action === 'call',
      JSON.stringify(aurMcpReport.error ?? aurMcpReport.data?.report))

    // —— human 代报（管理员持 usage.write 免授权校验，归因 human）——
    const aurHuman = await api('POST', '/api/assets/usage-reports', { token: aurAdmin, body: {
      assetType: 'skill', assetRef: String(aurSkillId), note: '运营代补', idempotencyKey: 'aur-admin:backfill-001',
    } })
    check('human 代报成功（reporterType=human，userId 回填）',
      aurHuman.ok && aurHuman.data.report.reporterType === 'human' && Boolean(aurHuman.data.report.userId),
      JSON.stringify(aurHuman.error ?? aurHuman.data?.report))

    // —— 查询出口：过滤与排序 ——
    const aurQuery = await api('GET', `/api/assets/usage-reports?assetType=skill&agentId=${encodeURIComponent(aurAgent1)}`, { token: aurAdmin })
    check('凭证查询：assetType+agentId 过滤命中 A1 的记录',
      aurQuery.ok && aurQuery.data.total >= 1 && aurQuery.data.items.every((row) => row.assetType === 'skill' && row.agentId === aurAgent1)
      && aurQuery.data.items[0].id === aurReport1Id, JSON.stringify(aurQuery.data?.total))

    // —— 经营关联：台账 usageReports30d + 审计逐次落账 ——
    const aurLedger = await api('GET', '/api/fleet/ledger', { token: aurAdmin })
    const aurLedgerSkill = aurLedger.data?.items?.find((item) => item.key === `skill:${aurSkillId}`)
    const aurLedgerMcp = aurLedger.data?.items?.find((item) => item.key === 'mcp:selftest-asset-usage')
    check('经营关联：台账 Skill 行 usageReports30d=3（A1+A2+human 代报；工具面提报在本断言之后）', Boolean(aurLedgerSkill) && aurLedgerSkill.usageReports30d === 3,
      `skill 行=${JSON.stringify(aurLedgerSkill?.usageReports30d)}`)
    check('经营关联：台账 MCP 行 usageReports30d=1', Boolean(aurLedgerMcp) && aurLedgerMcp.usageReports30d === 1,
      `mcp 行=${JSON.stringify(aurLedgerMcp?.usageReports30d)}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const aurAudit = await api('GET', '/api/audit/logs?type=invoke&q=asset.usage.report&limit=50', { token: aurAdmin })
    check('审计逐次落账：asset.usage.report 记录在案（含资产名与归因；工具面第 5 条在本断言之后）',
      aurAudit.ok && aurAudit.data.total >= 4 && aurAudit.data.items.some((row) => row.resourceName === '资产凭证自测助手' && row.resourceId === `skill:${aurSkillId}`),
      JSON.stringify(aurAudit.data?.total))

    // —— 工具面（技能）：/mcp tools 含 asset_usage_report 且可端到端调用 ——
    const aurToolsList = await rawReq('POST', '/mcp', {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${aurMach1}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const aurToolNames = (jsonBody(aurToolsList).result?.tools ?? []).map((tool) => tool.name)
    check('技能面：机器令牌 tools/list 含 asset_usage_report（usage.write 默认 scope 可见）',
      aurToolNames.includes('asset_usage_report'), `工具数=${aurToolNames.length}`)
    const aurToolCall = await rawReq('POST', '/mcp', {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${aurMach1}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'asset_usage_report', arguments: {
        assetType: 'skill', assetRef: String(aurSkillId), taskId: 'task-004', idempotencyKey: 'aur-agt1:task-004',
      } } }),
    })
    const aurToolPayload = jsonBody(aurToolCall).result
    let aurToolValue = {}
    try { aurToolValue = JSON.parse(aurToolPayload?.content?.[0]?.text ?? '{}') } catch { /* isError 分支无 JSON */ }
    check('技能面：asset_usage_report 工具端到端提报成功（deduped=false）',
      aurToolPayload?.isError === false && aurToolValue.deduped === false && aurToolValue.report?.agentId === aurAgent1,
      JSON.stringify(aurToolPayload).slice(0, 240))
  }

  // ================================================================ 个人接入令牌与 transition 权限分支（2026-11-02）
  // ① 员工自助 MCP 调用配置（PAT：签发/权限实时对齐/吊销/上限）；② A 修复回归（agents transition
  // 按 action 分支权限，对齐工具面 agent_offline）；③ B 修复回归（apps transition 分支启用 app.offline）。
  section('个人接入令牌与 transition 权限分支（自助配置/实时对齐）')
  {
    const patAdminLogin = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
    check('PAT 自测：管理员登录', patAdminLogin.ok)
    const patAdmin = patAdminLogin.data.token
    const patOrgId = patAdminLogin.data.user.orgId

    // —— 准备：普通员工（member 角色）——
    const patRoles = (await api('GET', '/api/iam/roles', { token: patAdmin })).data.roles
    const memberRole = patRoles.find((role) => role.code === 'member') ?? patRoles.find((role) => role.name === '普通用户')
    const patEmpCreate = await api('POST', '/api/iam/users', { token: patAdmin, body: { username: 'pat_emp', displayName: '自助接入员工', orgId: patOrgId, password: 'Ybk@2026', roleIds: [memberRole.id] } })
    check('PAT 自测：员工账号就绪（member 角色）', patEmpCreate.ok && Boolean(patEmpCreate.data?.id))
    const patEmpId = patEmpCreate.data.id
    const patEmp = (await api('POST', '/api/auth/login', { body: { username: 'pat_emp', password: 'Ybk@2026' } })).data.token
    const patApprover = (await api('POST', '/api/auth/login', { body: { username: 'approver02', password: 'Ybk@2026' } })).data.token

    // —— 签发与配置形态 ——
    const patIssue = await api('POST', '/api/authn/mcp-tokens', { token: patEmp, body: { label: 'IDE 接入', ttlHours: 168 } })
    check('自助签发：member 生成 MCP 配置（200，url 以 /mcp 收尾 + Bearer 头 + 备注/令牌/幂等面齐备）',
      patIssue.ok && String(patIssue.data?.config?.mcpServers?.['ybk-aios']?.url ?? '').endsWith('/mcp')
      && String(patIssue.data?.config?.mcpServers?.['ybk-aios']?.headers?.Authorization ?? '').startsWith('Bearer dst1.')
      && patIssue.data?.label === 'IDE 接入' && Boolean(patIssue.data?.token) && Boolean(patIssue.data?.jti),
      JSON.stringify(patIssue.error ?? {}).slice(0, 200))
    const patToken = patIssue.data.token
    check('自助签发：有效期≈7 天（168h ±1h）', Math.abs(Date.parse(patIssue.data.expiresAt) - Date.now() - 168 * 3600_000) < 3600_000, patIssue.data.expiresAt)
    const patNoLabel = await api('POST', '/api/authn/mcp-tokens', { token: patEmp, body: {} })
    check('自助签发：label 必填（400）', patNoLabel.status === 400, String(patNoLabel.status))
    const patClamp = await api('POST', '/api/authn/mcp-tokens', { token: patEmp, body: { label: '超长有效期钳制', ttlHours: 99999 } })
    check('自助签发：ttlHours 超上限被钳到 ≤90 天', patClamp.ok && Date.parse(patClamp.data.expiresAt) - Date.now() <= 2161 * 3600_000, patClamp.data?.expiresAt)

    // —— 权限实时对齐（配置权限 = 当前角色，verify 侧实时解析）——
    const patOkCall = await api('GET', '/api/overview', { token: patToken })
    check('权限对齐：PAT 可访问角色内接口（overview 200）', patOkCall.status === 200, String(patOkCall.status))
    const patDeniedCall = await api('POST', '/api/agents', { token: patToken, body: { name: 'PAT 越权探针' } })
    check('权限对齐：PAT 访问角色外接口被拒（403，与 member 角色一致）', patDeniedCall.status === 403, String(patDeniedCall.status))
    const tmpRole = await api('POST', '/api/iam/roles', { token: patAdmin, body: { code: 'pat_tmp_audit_read', name: 'PAT 临时审计读', permissions: ['audit.read'] } })
    const tmpRoleId = tmpRole.data.id ?? tmpRole.data.role?.id
    await api('PATCH', `/api/iam/users/${patEmpId}`, { token: patAdmin, body: { roleIds: [memberRole.id, tmpRoleId] } })
    const patAfterGrant = await api('GET', '/api/audit/logs?limit=1', { token: patToken })
    check('实时对齐：角色扩权后同一 PAT 立即可读审计（200，无需换发）', patAfterGrant.status === 200, String(patAfterGrant.status))
    await api('PATCH', `/api/iam/users/${patEmpId}`, { token: patAdmin, body: { roleIds: [memberRole.id] } })
    const patAfterRevokeRole = await api('GET', '/api/audit/logs?limit=1', { token: patToken })
    check('实时对齐：角色回收后同一 PAT 立即失去审计读（403）', patAfterRevokeRole.status === 403, String(patAfterRevokeRole.status))

    // —— 列表 / 吊销 / 越权 / 上限 ——
    const patList = await api('GET', '/api/authn/mcp-tokens', { token: patEmp })
    check('自助列表：仅本人 PAT（jti 掩码 + label + 状态齐备）', patList.ok && patList.data.total >= 2
      && patList.data.tokens.every((row) => Boolean(row.jtiMasked) && row.jtiMasked.endsWith('…') && typeof row.label === 'string'),
      JSON.stringify(patList.data?.total))
    const adminPat = await api('POST', '/api/authn/mcp-tokens', { token: patAdmin, body: { label: '管理员自测' } })
    const patCrossDelete = await api('DELETE', `/api/authn/mcp-tokens/${adminPat.data.jti}`, { token: patEmp })
    check('自助吊销：撤他人令牌按不存在处理（404，不泄露存在性）', patCrossDelete.status === 404, String(patCrossDelete.status))
    const burnPat = await api('POST', '/api/authn/mcp-tokens', { token: patEmp, body: { label: '待吊销' } })
    await api('DELETE', `/api/authn/mcp-tokens/${burnPat.data.jti}`, { token: patEmp })
    const patAfterDelete = await api('GET', '/api/auth/me', { token: burnPat.data.token })
    check('自助吊销：吊销后原 PAT 立即失效（401）', patAfterDelete.status === 401, String(patAfterDelete.status))
    let patCapHit = false
    for (let i = 0; i < 12; i++) {
      const capProbe = await api('POST', '/api/authn/mcp-tokens', { token: patEmp, body: { label: `上限探针 ${i}` } })
      if (capProbe.status === 400) { patCapHit = true; break }
    }
    check('自助签发：活跃 PAT 数量上限（10 条）生效', patCapHit)

    // —— A 修复回归：agents transition 按 action 分支权限 ——
    const offRole = await api('POST', '/api/iam/roles', { token: patAdmin, body: { code: 'pat_agent_offline_only', name: '仅Agent下线（自测）', permissions: ['console.login', 'agent.write', 'agent.offline'] } })
    const apprOnlyRole = await api('POST', '/api/iam/roles', { token: patAdmin, body: { code: 'pat_agent_approve_only', name: '仅Agent上线审批（自测）', permissions: ['console.login', 'agent.write', 'agent.approve'] } })
    const offRoleId = offRole.data.id ?? offRole.data.role?.id
    const apprOnlyRoleId = apprOnlyRole.data.id ?? apprOnlyRole.data.role?.id
    const bobCreate = await api('POST', '/api/iam/users', { token: patAdmin, body: { username: 'pat_bob', displayName: '仅下线员', orgId: patOrgId, password: 'Ybk@2026', roleIds: [offRoleId] } })
    const bob = (await api('POST', '/api/auth/login', { body: { username: 'pat_bob', password: 'Ybk@2026' } })).data.token
    const bobAgent = await api('POST', '/api/agents', { token: bob, body: { name: '分支权限自测体', attrs: { description: 'transition 分支权限回归', model: 'deepseek-chat', riskLevel: 'low', dataClass: 'internal', trialGroups: ['灰度试点组'], headless: true, avatar: '🤖' } } })
    check('A 回归：仅下线员注册自己的 Agent（agent.write）', bobAgent.ok, JSON.stringify(bobAgent.error))
    const bobAgentId = bobAgent.data.agent.id
    await api('POST', `/api/agents/${bobAgentId}/transition`, { token: patAdmin, body: { action: 'submit_trial' } })
    const onlineReq = await api('POST', `/api/agents/${bobAgentId}/transition`, { token: patAdmin, body: { action: 'online' } })
    const onlineDecide = await api('POST', `/api/approvals/${onlineReq.data.approval.id}/decide`, { token: patApprover, body: { decision: 'approve', opinion: '分支权限回归', confirmed: true, finalReview: true } })
    check('A 回归：管理员发起上线 + 异人审批通过（Agent online）', onlineDecide.ok, JSON.stringify(onlineDecide.error ?? {}).slice(0, 160))
    const bobOffline = await api('POST', `/api/agents/${bobAgentId}/transition`, { token: bob, body: { action: 'offline', note: '仅持 agent.offline' } })
    check('A 回归：仅 agent.offline 的负责人发起下线成功（200 出审批单——REST/工具两面对齐）',
      bobOffline.ok && Boolean(bobOffline.data?.approval?.id), JSON.stringify(bobOffline.error ?? {}).slice(0, 160))
    const bobOnlineAgain = await api('POST', `/api/agents/${bobAgentId}/transition`, { token: bob, body: { action: 'online' } })
    check('A 回归：仅 agent.offline 发起上线被拒（403，需 agent.approve）', bobOnlineAgain.status === 403, String(bobOnlineAgain.status))
    const carolCreate = await api('POST', '/api/iam/users', { token: patAdmin, body: { username: 'pat_carol', displayName: '仅审批员', orgId: patOrgId, password: 'Ybk@2026', roleIds: [apprOnlyRoleId] } })
    const carol = (await api('POST', '/api/auth/login', { body: { username: 'pat_carol', password: 'Ybk@2026' } })).data.token
    const carolOffline = await api('POST', `/api/agents/${bobAgentId}/transition`, { token: carol, body: { action: 'offline', note: '仅持 agent.approve' } })
    check('A 回归：仅 agent.approve 发起下线被拒（403，需 agent.offline）', carolOffline.status === 403, String(carolOffline.status))

    // —— B 修复回归：apps transition 分支（启用目录点 app.offline）——
    const appOffRole = await api('POST', '/api/iam/roles', { token: patAdmin, body: { code: 'pat_app_offline_only', name: '仅App下架（自测）', permissions: ['console.login', 'app.write', 'app.offline'] } })
    const appOffRoleId = appOffRole.data.id ?? appOffRole.data.role?.id
    await api('PATCH', `/api/iam/users/${bobCreate.data.id}`, { token: patAdmin, body: { roleIds: [offRoleId, appOffRoleId] } })
    const bobApp = await api('POST', '/api/apps', { token: bob, body: { name: '分支权限自测应用', attrs: { description: 'B 分支回归', appType: 'web', riskLevel: 'low', dataClass: 'internal' } } })
    check('B 回归：仅下架员注册自己的应用（app.write）', bobApp.ok, JSON.stringify(bobApp.error))
    const bobAppId = bobApp.data.app.id
    const bobAppOffline = await api('POST', `/api/apps/${bobAppId}/transition`, { token: bob, body: { action: 'offline', note: '仅持 app.offline' } })
    check('B 回归：仅 app.offline 发起下架成功（200 出审批单，目录点 app.offline 启用）',
      bobAppOffline.ok && Boolean(bobAppOffline.data?.approval?.id), JSON.stringify(bobAppOffline.error ?? {}).slice(0, 160))
    const carolAppOffline = await api('POST', `/api/apps/${bobAppId}/transition`, { token: carol, body: { action: 'offline', note: '无 app.offline' } })
    check('B 回归：无 app.offline 发起下架被拒（403）', carolAppOffline.status === 403, String(carolAppOffline.status))

    // —— 工具面与矩阵标注 ——
    const patToolsList = await rawReq('POST', '/mcp', {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const patToolNames = (jsonBody(patToolsList).result?.tools ?? []).map((tool) => tool.name)
    check('B 回归：/mcp 工具面含 app_offline（app.offline 持有者可见）', patToolNames.includes('app_offline'), `工具数=${patToolNames.length}`)
    const patMatrix = (await api('GET', '/api/platform/route-matrix', { token: patAdmin })).data
    const patAgentTr = patMatrix.guarded.find((route) => route.path === '/api/agents/:id/transition' && route.method === 'POST')
    const patAppTr = patMatrix.guarded.find((route) => route.path === '/api/apps/:id/transition' && route.method === 'POST')
    check('组合权限标注：两条 transition 路由矩阵声明双权限点',
      patAgentTr?.permission === 'agent.approve,agent.offline' && patAppTr?.permission === 'app.write,app.offline',
      `${patAgentTr?.permission} / ${patAppTr?.permission}`)
  }

  // ================================================================ fresh-install 装机模拟（插件化铁律）
  // 目标：把「全新 dsh 上 dsh plugin add → 安装、启动、完整体验」拆成可在推送前自动断言的
  // 不变量——装机清单可解析可导入、三条装载链一致、浏览器半 bundle 新鲜、files 覆盖运行期资产。
  section('fresh-install 装机模拟（dsh plugin add 装机链完整性）')
  {
    // 别名导入：文件后段存在同名顶层 const existsSync（TDZ 遮蔽 import 绑定），段内一律用 pathExists
    const { existsSync: pathExists } = await import('node:fs')
    const patchYaml = platformCore.parseYaml(readFileSync('cordis.patch.yml', 'utf8'))
    const patchEntries = Array.isArray(patchYaml?.[0]?.insert) ? patchYaml[0].insert : []
    check('cordis.patch.yml 装配 6 entry（01门 产物：5×dist 前缀 + 1×rq-card 根包名 @ybkk/gate-01；issue #1 修复后）',
      patchEntries.length === 6, `entries=${patchEntries.length}`)

    // -- 1. 逐 entry 解析到本地模块并导入（抓缺文件/坏导出——装机包里最致命的静默事故）--
    const broken = []
    for (const entry of patchEntries) {
      const name = String(entry?.name ?? '')
      let localPath = null
      if (name === '@ybkk/gate-01') {
        // rq-card 条目 = 根包名（issue #1 修复，2026-10-27）：client-modules 对裸包名
        // require.resolve('<名>/package.json') 读根包 dsh.client 元数据；本仓等价物 =
        // 根 exports['.'] → index.js（re-export rq-card 宿主半 dist）。
        const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'))
        const dot = typeof rootPkg.exports?.['.'] === 'string' ? rootPkg.exports['.'] : null
        if (dot !== null) localPath = dot.replace(/^\.\//, '')
      } else if (name.startsWith('@ybkk/gate-01/')) {
        // 形如 @ybkk/gate-01/packages/<dir>/dist/index.js（相对本仓根；dist 预构建产物随包入库）
        localPath = name.slice('@ybkk/gate-01/'.length)
      } else if (name.startsWith('@ybkk/')) {
        // 安装形态以包名解析（client-modules 走 require.resolve）；本仓等价物 = packages/<包目录>
        const dir = name.slice('@ybkk/'.length)
        try {
          const pkg = JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'))
          const target = typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : pkg.exports?.['.']?.default
          if (typeof target === 'string') localPath = join('packages', dir, target)
        } catch { /* 包缺失/坏 package.json → localPath 保持 null */ }
      }
      if (!localPath || !pathExists(localPath)) { broken.push(`${entry?.id}:resolve`); continue }
      try { await import(pathToFileURL(join(process.cwd(), localPath)).href) }
      catch (error) { broken.push(`${entry?.id}:import(${error instanceof Error ? error.message : String(error)})`) }
    }
    check('patch 全部 entry 解析到本地模块并成功导入', broken.length === 0, broken.join(' | '))

    // -- 2. 三链一致（plan-gate01 Phase 3 收缩后规则；2026-09-16 吸收上游 flow-core 后 21/23；
    //        2026-11-02 上游合并（执行中枢/A2A/UHP/workforce/connector 等收编）后 26/27）：patch(6) id 集 ⊆ cordis.yml(27)；
    //        boot-all ↔ cordis.yml 服务面双射维持不变（防「加了包漏登记」）--
    const entryDir = (name) => {
      if (name === '@ybkk/gate-01') return 'plugin-rq-card' // rq-card 条目 = 根包名（issue #1 修复）
      if (name.startsWith('@ybkk/gate-01/packages/')) return name.slice('@ybkk/gate-01/packages/'.length).split('/')[0]
      if (name.startsWith('@ybkk/')) return name.slice('@ybkk/'.length)
      const embedded = name.indexOf('/packages/') // cordis.yml 源码形态：<PROJECT_ROOT>/packages/<dir>/src/index.ts
      if (embedded >= 0) return name.slice(embedded + '/packages/'.length).split('/')[0]
      if (name.endsWith('/index.js')) return 'plugin-rq-card' // cordis.yml dev 形态：<PROJECT_ROOT>/index.js（根出口 = rq-card 宿主半）
      return null
    }
    const patchDirs = patchEntries.map((entry) => entryDir(String(entry?.name ?? ''))).filter(Boolean)
    const DSH_ONLY = new Set(['plugin-rq-card', 'plugin-dsh-bridge']) // dsh 宿主专属（客户端 bundle / webServer 挂载），独立形态不装配
    const bootSource = readFileSync('src/boot-all.ts', 'utf8')
    const bootDirs = [...bootSource.matchAll(/from '((?:@dsh-ops|@01men|@ybkk)\/[\w-]+)'/g)].map((match) => match[1].split('/')[1])
    const cordisYaml = platformCore.parseYaml(readFileSync('cordis.yml', 'utf8'))
    const cordisEntries = Array.isArray(cordisYaml?.[0]?.insert) ? cordisYaml[0].insert : []
    const cordisDirs = cordisEntries.map((entry) => entryDir(String(entry?.name ?? ''))).filter(Boolean)
    const patchOnly = patchDirs.filter((dir) => !DSH_ONLY.has(dir) && !bootDirs.includes(dir))
    const patchNotInCordis = patchDirs.filter((dir) => !cordisDirs.includes(dir))
    check('三链一致：patch(6) 服务面 ⊆ boot-all（dsh 专属条目豁免）且 ⊆ cordis.yml(27)',
      patchOnly.length === 0 && patchNotInCordis.length === 0,
      `patchOnly=${patchOnly} patchNotInCordis=${patchNotInCordis}`)
    const cordisOnly = cordisDirs.filter((dir) => !DSH_ONLY.has(dir) && !bootDirs.includes(dir))
    const bootOnly = bootDirs.filter((dir) => !cordisDirs.includes(dir))
    check('三链一致：boot-all ↔ cordis.yml 服务面双射维持（dsh 专属条目豁免）',
      cordisOnly.length === 0 && bootOnly.length === 0 && bootDirs.length === 26,
      `cordisOnly=${cordisOnly} bootOnly=${bootOnly} bootCount=${bootDirs.length}`)
    const cordisIds = new Set(cordisEntries.map((entry) => entry?.id))
    const patchIds = new Set(patchEntries.map((entry) => entry?.id))
    const idMissing = [...patchIds].filter((id) => !cordisIds.has(id))
    check('三链一致：patch(6) 插件 id 集 ⊆ cordis.yml(27)',
      cordisEntries.length === 27 && idMissing.length === 0 && patchIds.size === 6,
      `cordis=${cordisEntries.length} missing=${idMissing}`)

    // -- 3. rq-card 浏览器半 bundle 新鲜度（改 src/client 忘重建 = 过期装机包）--
    const { computeClientBuildId, readBuiltId } = await import('../packages/plugin-rq-card/build-id.mjs')
    const cardPkg = join(process.cwd(), 'packages', 'plugin-rq-card')
    const expectedId = computeClientBuildId(cardPkg)
    const builtId = readBuiltId(cardPkg)
    check('rq-card 浏览器半 bundle 新鲜（build-id 指纹一致）',
      Boolean(builtId) && expectedId === builtId, `expected=${expectedId} built=${builtId}`)

    // -- 3.5. 随附包 dist 预构建产物新鲜度（plan-gate01 G3 自解：改随附包 src 忘跑 build:dist = 过期装机包）--
    const { DIST_PACKAGES, computeDistBuildId, readDistBuildId } = await import('../scripts/dist-build-id.mjs')
    const expectedDistId = computeDistBuildId(process.cwd())
    const stale = DIST_PACKAGES.map((pkg) => [pkg, readDistBuildId(process.cwd(), pkg)])
      .filter(([, built]) => built !== expectedDistId)
      .map(([pkg, built]) => `${pkg}(built=${built ?? 'missing'} expected=${expectedDistId})`)
    check('随附包 dist 预构建产物新鲜（7 包 build-id 与 src 树指纹一致）', stale.length === 0, stale.join(' | '))

    // -- 4. 装机 files 覆盖：运行期资产必须落在根 package.json files 根之下 --
    const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'))
    // plan-gate01 Phase 3 精确清单：安装产物=01门 4 entry 所需的最小闭包（源码开发形态根 src/cordis.yml 不随包）
    // 2026-11-02 上游合并：+packages/platform-i18n（上游内核 t() 三语文案库被 6 随附包 src 跨包引用，不随包则装机缺依赖）
    const expectedFiles = ['cordis.patch.yml', 'index.js', 'packages/platform-core', 'packages/platform-i18n', 'packages/plugin-iam', 'packages/plugin-authn', 'packages/plugin-dsh-bridge', 'packages/plugin-panel-core', 'packages/plugin-rq-card', 'README.md', 'LICENSE'].sort()
    const actualFiles = [...(rootPkg.files ?? [])].sort()
    check('根 package.json files 精确覆盖 01门 装机闭包（多列/少列都红）',
      JSON.stringify(expectedFiles) === JSON.stringify(actualFiles),
      `expected=${JSON.stringify(expectedFiles)} actual=${JSON.stringify(actualFiles)}`)
    check('dsh.bundle.patch 契约指向 cordis.patch.yml 且存在',
      rootPkg.dsh?.bundle?.patch === './cordis.patch.yml' && pathExists('cordis.patch.yml'))
    check('rq-card client 半经根包 exports 装机（issue #1 修复：git/registry/本地三形态同通道——'
      + '根包声明 dsh.client web + exports["./client"]，裸包名 file: 依赖已废弃）',
      rootPkg.dsh?.client?.platform === 'web'
      && rootPkg.exports?.['./client'] === './packages/plugin-rq-card/lib/client.js'
      && rootPkg.dependencies?.['@ybkk/plugin-rq-card'] === undefined,
      `dsh.client=${JSON.stringify(rootPkg.dsh?.client ?? {})} exports['./client']=${String(rootPkg.exports?.['./client'])}`)
    check('dsh.compatibility 声明在场（dsh 版本区间 + profiles）',
      typeof rootPkg.dsh?.compatibility?.dsh === 'string' && Array.isArray(rootPkg.dsh?.compatibility?.profiles))
    check('面板 SPA 静态资源在场（index.html / boot.js / app.js）',
      pathExists('packages/plugin-panel-core/public/index.html')
      && pathExists('packages/plugin-panel-core/public/js/boot.js')
      && pathExists('packages/plugin-panel-core/public/js/app.js'))
    check('制造工具箱资产在场（mfg 空间前端半 + 选题清单数据 + 执行/门禁内核；2026-10-19 并入）',
      pathExists('packages/plugin-panel-core/public/js/mfg.js')
      && pathExists('packages/plugin-panel-core/public/css/mfg.css')
      && pathExists('packages/plugin-panel-core/src/mfg/roadmap.json')
      && pathExists('packages/plugin-panel-core/src/mfg/engine.ts')
      && pathExists('packages/plugin-panel-core/src/mfg/quality.ts'))
    check('index.html 装载制造工具箱样式表（漏挂 = 空间样式全丢但功能照跑，静默降级）',
      readFileSync('packages/plugin-panel-core/public/index.html', 'utf8').includes('./css/mfg.css'))
    check('卡片包数据在场（cardpacks/*.json ≥1）',
      readdirSync('packages/plugin-panel-core/cardpacks').filter((file) => file.endsWith('.json')).length >= 1)
    check('行业场景图谱在场（platform-core/scenegraphs/*.json ≥1）',
      readdirSync('packages/platform-core/scenegraphs').filter((file) => file.endsWith('.json')).length >= 1)
    check('rq-card bundle 产物在场（lib/client.js）', pathExists('packages/plugin-rq-card/lib/client.js'))

    // -- 5. 浏览器半 bundle 真执行（mock rc.7 SlotRegistry 纪元语义；QA BUG-G-01/H1 回归）--
    // 此前 bundle 只被「解析」从不被「执行」——H1 的确定性根因（服务面 spec API 名错配 +
    // 先 probe 后注册的时序缺口）在这类检查下不可见。现以 mock 宿主注入面把 apply 全链跑起来：
    // apply 先于声明（挂起）→ 五槽声明落地（同步触发回调）→ 断言注册台账/降级台账/诊断台账。
    {
      const vm = await import('node:vm')
      // mock 宿主注入面：rc.7 语义——inject 未声明时挂起、spec() 仅在声明后返回、register 即记台账
      const makeHost = () => {
        const declared = new Map()
        const pending = new Map()
        const registered = []
        const slots = {
          inject(key, callback) {
            if (!declared.has(key)) {
              const list = pending.get(key) ?? []
              list.push(callback)
              pending.set(key, list)
              return () => {}
            }
            callback()
            return () => {}
          },
          spec(key) { return declared.has(key) ? { kind: declared.get(key) } : undefined },
          register(options) { registered.push({ name: options.name, key: options.key ?? '', id: options.id ?? '' }); return () => {} },
        }
        const declare = (key, kind) => {
          declared.set(key, kind)
          for (const callback of pending.get(key) ?? []) callback()
          pending.delete(key)
        }
        const ctx = {
          slots,
          locale: { register() {}, bind() { return undefined } },
          effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
        }
        return { ctx, registered, declare }
      }
      // 独立 vm 环境：window===globalThis（banner 与 diagNote 双通道可达）、setTimeout 桩（10s 兜底定时器不拖进程）
      const makeEnv = () => {
        const diag = { installed: false, attempts: [] }
        let captured = null
        const sandbox = {
          console: { info() {}, warn() {}, error() {} },
          setTimeout: () => 0,
          clearTimeout: () => {},
          __RQ_CARD_DIAG__: diag,
          __ModuleLoader__: { load: (arg) => { captured = arg } },
        }
        sandbox.window = sandbox
        sandbox.globalThis = sandbox
        vm.runInContext(readFileSync('packages/plugin-rq-card/lib/client.js', 'utf8'), vm.createContext(sandbox), { filename: 'rq-card-client.js' })
        const createElement = (type, props, ...children) => ({ type, props, children })
        const requireMock = (name) => {
          if (name === 'react') return { createElement }
          if (name === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement, Fragment: 'rq-fragment' }
          return {} // @deepseek-ai/* 全部 type-only（纯度门禁保证），运行期零消费
        }
        if (!captured) throw new Error('bundle 未调用 __ModuleLoader__.load（closure-factory 形状破坏）')
        const mod = captured.factory(requireMock)
        diag.installed = true // banner 语义：工厂体完整执行成功才记安装
        return { diag, mod }
      }
      // 场景 A：apply 先于声明（rc.7 条目并发创建的真实时序）→ 声明落地后五槽全部到位
      {
        const { diag, mod } = makeEnv()
        const host = makeHost()
        mod.apply(host.ctx)
        check('rq-card 真执行：apply 先于声明时零注册（挂起等声明 + 诊断台账记 inject-pending）',
          host.registered.length === 0 && diag.attempts.some((a) => a.stage === 'inject-pending:tool.call.toolview'),
          JSON.stringify({ registered: host.registered.length, attempts: diag.attempts.map((a) => a.stage) }))
        host.declare('tool.call.toolview', 'keyed')
        host.declare('conversation.chat.assistant-actions', 'list')
        host.declare('settings.section', 'list')
        host.declare('conversation.view', 'list')
        host.declare('shell.overlay', 'list')
        host.declare('main', 'keyed')
        host.declare('sidebar.panellist', 'list')
        const byName = {}
        for (const entry of host.registered) byName[entry.name] = (byName[entry.name] ?? 0) + 1
        const toolviewKeys = new Set(host.registered.filter((e) => e.name === 'tool.call.toolview').map((e) => e.key))
        const mainEntry = host.registered.find((e) => e.name === 'main')
        const panelEntry = host.registered.find((e) => e.name === 'sidebar.panellist')
        check('rq-card 真执行：七槽声明落地后全部注册（执行卡键位 ≥60 且不重复 + 反馈条 + 设置分区 + 工作台 + 角标 + 原生面板页 + 侧栏入口）',
          (byName['tool.call.toolview'] ?? 0) >= 60 && toolviewKeys.size === byName['tool.call.toolview']
          && byName['conversation.chat.assistant-actions'] === 1
          && byName['settings.section'] === 1
          && byName['conversation.view'] === 1
          && (byName['shell.overlay'] ?? 0) >= 1
          && byName['main'] === 1 && mainEntry?.key === 'rq-gate01'
          && byName['sidebar.panellist'] === 1 && panelEntry?.id === 'rq-gate01',
          JSON.stringify(byName))
        check('rq-card 真执行：诊断台账记录七槽注入落地（复测可定性）',
          ['tool.call.toolview', 'conversation.chat.assistant-actions', 'settings.section', 'conversation.view', 'shell.overlay', 'main', 'sidebar.panellist']
            .every((key) => diag.attempts.some((a) => a.stage === `inject-materialized:${key}`)),
          JSON.stringify(diag.attempts.map((a) => a.stage)))
      }
      // 场景 B（H1 确定性根因回归）：spec 查询必须走服务面 spec()——kind 失配折叠为降级台账，不崩宿主不静默
      {
        const { diag, mod } = makeEnv()
        const host = makeHost()
        mod.apply(host.ctx)
        host.declare('settings.section', 'keyed')
        check('rq-card 真执行：kind 失配记 inject-kind-mismatch 降级台账（不抛错外逃）',
          diag.attempts.some((a) => a.stage === 'inject-kind-mismatch:settings.section'),
          JSON.stringify(diag.attempts.map((a) => a.stage)))
      }
    }
    const declared = patchDirs.filter((dir) => pathExists(join('packages', dir, 'plugin.yaml')))
    // plan-gate01 Phase 3 精确断言（2026-09-11 扩容）：6 entry 中声明位=iam/authn/panel-core 三包
    // （platform-core/dsh-bridge 为纯代码包；rq-card 走 dsh.client 声明，无 plugin.yaml）
    check('声明位插件 plugin.yaml 与 manifest/api.yaml 成对在场（patch(6) 中声明位=iam/authn/panel-core，精确）',
      JSON.stringify([...declared].sort()) === JSON.stringify(['plugin-authn', 'plugin-iam', 'plugin-panel-core'])
      && declared.every((dir) => pathExists(join('packages', dir, 'manifest', 'api.yaml'))),
      declared.join(','))
  }


  section('卡片包与五平台主题（WP-05：角色×平台下发 / ref 存活 / 主题属性差）')
  {
    const packsRd = await api('GET', '/api/panel/board?platform=rd', { token: admin })
    check('卡片包：研发平台试点包下发（装载 + 首页 ≤6 张）',
      packsRd.ok && packsRd.data.totalPacks >= 1 && packsRd.data.cards.length >= 3 && packsRd.data.cards.length <= 6,
      JSON.stringify(packsRd.error ?? { totalPacks: packsRd.data?.totalPacks, cards: packsRd.data?.cards?.length }))
    check('卡片包：试点卡引用真实资产（agent:dev-coder / skill:sql-审查助手 存活命中）',
      packsRd.ok && packsRd.data.cards.some((card) => card.ref === 'agent:dev-coder') && packsRd.data.cards.some((card) => card.ref === 'skill:sql-审查助手'),
      JSON.stringify(packsRd.data?.cards?.map((card) => card.ref)))
    const packsQuality = await api('GET', '/api/panel/board?platform=quality', { token: admin })
    check('卡片包：质量平台试点包下发', packsQuality.ok && packsQuality.data.cards.length >= 3, JSON.stringify(packsQuality.error))
    const packsBad = await api('GET', '/api/panel/board?platform=nope', { token: admin })
    check('卡片包：非法平台 400（枚举校验）', packsBad.status === 400, String(packsBad.status))
    const themeCss = readFileSync(join(process.cwd(), 'packages', 'plugin-console', 'public', 'css', 'base.css'), 'utf8')
    check('主题：五平台仅 data-platform 属性差（五块覆盖 + 定版色值在位，无 Tailwind 引入）',
      [['strategy', '#3B4CC0'], ['marketing', '#E8590C'], ['manufacturing', '#0C8599'], ['rd', '#7048E8'], ['quality', '#2F9E44']]
        .every(([platform, hex]) => themeCss.includes(`data-platform="${platform}"`) && themeCss.includes(hex))
        && !themeCss.includes('tailwind'),
      'base.css 平台主题块缺失或色值漂移')
  }

  section('rbac endpoint matrix（WP-04/A1：普通成员直调管理端点 100% 被拒，矩阵驱动）')
  section('战略看板与目录瘦身（WP-12：portal 只读聚合 / 漏斗可测 / 纯函数筛选）')
  {
    // 双轨迁移回归：portal board 端点已拆除（看板聚合迁往 /api/panel/board），portal 收敛到上游原样
    const boardAnon = await rawReq('GET', '/api/portal/board', { headers: { origin: 'http://192.168.0.4:8092' } })
    check('看板：portal board 端点已随双轨迁移拆除（404，portal 收敛到上游）',
      boardAnon.status === 404, String(boardAnon.status))
    const boardBody = { data: await (async () => { const r = await api('GET', '/api/panel/board', { token: admin }); return r.data })() }
    const behaviorAdmin = await api('GET', '/api/behavior/events?type=card.exposed', { token: admin })
    check('看板：漏斗曝光级与 behavior 台账一致（behavior 全量口径，/panel 板）',
      boardBody.data.funnel.exposed === behaviorAdmin.data.total,
      `funnel=${boardBody.data.funnel.exposed} ledger=${behaviorAdmin.data.total}`)
    check('看板：漏斗调用级 ≥1（usage 事件在册）且 WAIC 口径齐备',
      boardBody.data.funnel.invoked >= 1 && typeof boardBody.data.waic.chargeCents === 'number' && Array.isArray(boardBody.data.byDay),
      JSON.stringify(boardBody.data.funnel))
    check('看板：ROI 用工成本模型随板下发（替代工时估算 + 时薪系数 + 口径声明，WP-14）',
      Boolean(boardBody.data.roi) && Number(boardBody.data.roi.minutesPerCallEstimate) > 0
      && Number(boardBody.data.roi.laborCostCentsPerHour) > 0 && String(boardBody.data.roi.note).includes('估算'),
      JSON.stringify(boardBody.data.roi ?? null))
    const filters = await import(new URL('../packages/plugin-console/public/js/asset-filters.js', import.meta.url).href)
    const items = [
      { type: 'mcp', name: '数据分析引擎', slug: 'datawise', platform: 'rd', org: 'AI部', owner: '甲' },
      { type: 'agent', name: '研发编码助手', slug: 'dev-coder', platform: '', org: '研发部', owner: '乙' },
      { type: 'app', name: '数据洞察 BI', slug: 'insight-bi', platform: 'rd', org: 'AI部', owner: '丙' },
    ]
    check('目录：纯函数筛选（类型/平台/关键词三条件）',
      filters.filterAssets(items, { type: 'mcp' }).length === 1
      && filters.filterAssets(items, { platform: 'rd' }).length === 2
      && filters.filterAssets(items, { q: '编码' }).length === 1
      && filters.filterAssets(items, { q: 'DEV-CODER' }).length === 1
      && filters.assetPlatform(items[1]) === '未标注')
    const big = Array.from({ length: 1000 }, (_, i) => ({ type: i % 2 ? 'mcp' : 'agent', name: `资产${i}`, platform: i % 3 ? 'rd' : 'quality', org: 'o', owner: 'w' }))
    const perfStart = Date.now()
    filters.filterAssets(big, { type: 'mcp', platform: 'rd', q: '资产99' })
    const perfMs = Date.now() - perfStart
    check('目录：筛选性能断言（1000 项三条件 < 50ms，单栏卡片流无服务端二次请求）', perfMs < 50, `${perfMs}ms`)
  }

  // ================================================================ 验收回归：offline 审批闭环 / 规则播种 / mcp 直调 execute
  section('验收回归（offline 闭环 · 规则播种 · mcp 直调 execute）')

  // 用伪造 dsh webServer 捕获注册的 prefix 路由，再经真实 HTTP 端口模拟 dsh 侧分发。
  section('dsh 宿主挂载（单进程单入口 /gate01 前缀，合并移植）')
  {
    const captured = []
    const taps = []
    const fakeWebServer = {
      register: (route) => { captured.push(route); return () => {} },
      tapIndex: (transform) => { taps.push(transform); return () => {} },
    }
    const bridgeDataDir = join('data-selftest', 'bridge-mount-merge')
    await mkdir(bridgeDataDir, { recursive: true })
    const mountCtx = new Context()
    await mountCtx.plugin(platformCore, { dataDir: bridgeDataDir, http: { port: 0, externalBase: '/gate01' }, startHttp: false })
    // 完整业务树（等价 boot-all 依赖序；startHttp=false → 数据面经 bridge 挂载）：
    await mountCtx.plugin(resourceCore)
    await mountCtx.plugin(iam)
    await mountCtx.plugin(authn)
    await mountCtx.plugin(usage)
    await mountCtx.plugin(audit)
    await mountCtx.plugin(market)
    await mountCtx.plugin(connector)
    await mountCtx.plugin(mcp)
    await mountCtx.plugin(nas)
    await mountCtx.plugin(skillhub)
    await mountCtx.plugin(agent)
    await mountCtx.plugin(app)
    await mountCtx.plugin(modelgw)
    await mountCtx.plugin(connect, { role: 'host' })
    await mountCtx.plugin(update)
    // 先于 console：门户端点在其鉴权中间件之前截获 /api/portal/*
    await mountCtx.plugin(portal)
    await mountCtx.plugin(consolePlugin) // 基线初始化：内置角色 + 根组织 + admin
    // 部门面板 + 钉钉桥接（review-dsh-agent-panel-v2）：与 boot-all 同序（console 之后）
    await mountCtx.plugin(panelCore)
    await mountCtx.plugin(dingtalkBridge)
    await mountCtx.plugin(dshBridge, { mountPath: '/gate01' })
    mountCtx.httpServer.register('GET', '/api/__mount_probe', (exchange) => exchange.ok({ pong: exchange.path }), { access: 'authenticated' })
    // 将伪造 webServer 提供给 ctx 后正常装配（等价 dsh 形态：inject 完成后 apply）
    // 绑定服务显式构造（注册在真实 mountCtx 上，供 plugin-nas 出站归因读取）；
    // apply 以「服务视图」调用——等价 dsh 形态下 inject 完成后的装配
    // OIDC 授权码通道凭证（register-dsh-agent.mjs 产物形态）
    writeFileSync(join(bridgeDataDir, 'dsh-agent-credential.json'), JSON.stringify({
      agentId: 'agt_mount_test',
      oidc: { clientId: 'oc-selftest-bridge', clientSecret: 'ocs_selftest_secret' },
    }))
    const bindingService = new dshBridge.IdentityBindingService(mountCtx, {})
    dshBridge.apply(
      { webServer: fakeWebServer, httpServer: mountCtx.httpServer, entryTickets: mountCtx.entryTickets, oidc: mountCtx.oidc, iam: mountCtx.iam, authn: mountCtx.authn, audit: mountCtx.audit, logger: (name) => mountCtx.logger(name), identityBinding: bindingService },
      { mountPath: '/gate01', oidcCredentialFile: join(bridgeDataDir, 'dsh-agent-credential.json') },
    )
    check('bridge 向 webServer 注册挂载路由（/rq + /auth/entry + /dsh-bridge + /auth/oidc/*）',
      captured.some((r) => r.kind === 'prefix' && r.path === '/gate01') && captured.some((r) => r.kind === 'exact' && r.path === '/auth/entry')
      && captured.some((r) => r.kind === 'prefix' && r.path === '/dsh-bridge') && captured.some((r) => r.kind === 'exact' && r.path === '/auth/oidc/start')
      && captured.some((r) => r.kind === 'exact' && r.path === '/auth/oidc/callback'),
      JSON.stringify(captured.map((r) => `${r.kind}:${r.path}`)))
    check('externalBase 配置生效（/gate01）', mountCtx.httpServer.externalBase === '/gate01')

    // -- M0-1 死信重放演练：消费 3 次失败入死信 → 修复后重投成功且不双计 ----------
    let drillFail = true
    let drillHandled = 0
    mountCtx.usage.consume('selftest-drill', (event) => {
      drillHandled++
      if (drillFail) throw new Error('drill 注入失败')
      mountCtx.usage.project('selftest-drill', event)
    })
    const drillEvent = mountCtx.usage.record({
      org: 'drill-org', subject: 'agent:drill-bot', principal: 'platform',
      resource: 'app:app-drill', meters: [{ key: 'calls', value: 1, unit: 'call' }],
      idempotency_key: 'selftest-drill-001',
    })
    const drillLetters = mountCtx.usage.deadLetters().all()
    check('M0-1 死信演练：消费连续 3 次失败入死信',
      drillLetters.some((letter) => letter.event_id === drillEvent.event_id && letter.consumer === 'selftest-drill'),
      JSON.stringify(drillLetters))
    drillFail = false
    const drillRetry = mountCtx.usage.retryDeadLetters()
    const projectionAfter = mountCtx.opsStorage.collection('usage:projection:selftest-drill').all().reduce((sum, row) => sum + row.count, 0)
    check('M0-1 死信重投：修复后重投成功且投影恰好一次', drillRetry.retried >= 1 && drillHandled === 4 && projectionAfter === 1,
      JSON.stringify({ drillRetry, drillHandled, projectionAfter }))
    mountCtx.usage.replay(new Date(Date.now() - 3_600_000).toISOString())
    const projectionAfterReplay = mountCtx.opsStorage.collection('usage:projection:selftest-drill').all().reduce((sum, row) => sum + row.count, 0)
    check('M0-1 死信重投后 replay 不双计（消费水位幂等）', projectionAfterReplay === 1, String(projectionAfterReplay))

    // -- H3 白盒回归：宽限窗口外旧 token 重放 = 硬重放，整链吊销（含宽限兄弟对） ----------
    const gracePrincipal = mountCtx.authn.ensureHumanPrincipal('selftest-grace-user', '宽限窗口自测')
    const gracePairA = mountCtx.authn.issueSessionPair(gracePrincipal.id, { issuedBy: 'selftest-grace' })
    const graceRotated = mountCtx.authn.refreshSession(gracePairA.refreshToken)
    const graceSibling = mountCtx.authn.refreshSession(gracePairA.refreshToken) // 窗口内：兄弟对自愈
    check('H3 白盒：宽限内二次兑换签发兄弟对（不吊销链）',
      graceSibling.refreshToken !== graceRotated.refreshToken
      && Boolean(mountCtx.authn.verify(graceRotated.token))
      && Boolean(mountCtx.authn.verify(graceSibling.token)))
    const graceOldHash = createHash('sha256').update(gracePairA.refreshToken).digest('hex')
    const graceOldRecord = mountCtx.authn.tokens().findOne((token) => token.refreshHash === graceOldHash)
    // 时间旅行：轮转时刻拨到 60s 前（窗口 30s）→ 旧 token 再现即硬重放
    mountCtx.authn.tokens().update(graceOldRecord.id, { rotatedAt: new Date(Date.now() - 60_000).toISOString() })
    let graceReplayThrew = false
    try { mountCtx.authn.refreshSession(gracePairA.refreshToken) } catch { graceReplayThrew = true }
    check('H3 白盒：宽限窗口外旧 token 重放被拒并整链吊销（重放防线不变）', graceReplayThrew)
    let graceChainDead = true
    try { mountCtx.authn.verify(graceRotated.token); graceChainDead = false } catch { /* 已吊销 */ }
    try { mountCtx.authn.verify(graceSibling.token); graceChainDead = false } catch { /* 已吊销 */ }
    check('H3 白盒：整链吊销覆盖轮转对与宽限兄弟对', graceChainDead)
    // 模拟 dsh webserver 分发：命中 /rq 前缀即交给 bridge handler，其余 404
    const sim = createServer((req, res) => {
      const exact = captured.find((r) => r.kind === 'exact' && (req.url ?? '').split('?')[0] === r.path)
      if (exact) { exact.handler(req, res); return }
      const route = captured.find((r) => r.kind === 'prefix' && (req.url === r.path || (req.url ?? '').startsWith(`${r.path}/`)))
      if (route) { route.handler(req, res); return }
      res.writeHead(404).end('sim-miss')
    })
    await new Promise((resolve) => sim.listen(0, '127.0.0.1', resolve))
    // 完整树下数据面带 console 鉴权中间件：先经 /gate01/api/auth/login 换 Bearer（基线初始口令文件）
    const pwFile = join(bridgeDataDir, 'admin-initial-password.txt')
    const adminPassword = existsSync(pwFile)
      ? (readFileSync(pwFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('平台管理员'))[0] ?? '')
      : ''
    const loginRes = await fetch(`http://127.0.0.1:${sim.address().port}/gate01/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: adminPassword || '自测兜底口令' }),
    })
    const adminToken = (await loginRes.json().catch(() => null))?.data?.token
    check('/gate01/api/auth/login 可用（单入口下登录链路通）', Boolean(adminToken), `status=${loginRes.status}`)
    const simGet = async (path, token) => fetch(`http://127.0.0.1:${sim.address().port}${path}`, {
      redirect: 'manual', headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    const probe = await simGet('/gate01/api/__mount_probe', adminToken)
    const probeBody = await probe.json().catch(() => null)
    check('/gate01/api/* 剥前缀后与独立形态路由等价（含 Bearer 鉴权链）', probe.status === 200 && probeBody?.data?.pong === '/api/__mount_probe', `status=${probe.status} body=${JSON.stringify(probeBody)}`)
    const redir = await simGet('/gate01')
    check('/gate01 302 归一到 /gate01/（SPA 相对引用可解析）', redir.status === 302 && redir.headers.get('location') === '/gate01/')
    const spa = await simGet('/gate01/')
    check('/gate01/ 伺服控制台 index.html（SPA fallback）', spa.status === 200 && (await spa.text()).includes('<!doctype html>'))
    const asset = await simGet('/gate01/js/app.js')
    check('/gate01/js/* 控制台静态资源按前缀命中', asset.status === 200 && String(asset.headers.get('content-type') ?? '').includes('javascript'), `status=${asset.status}`)
    const panelSpa = await simGet('/gate01/panel/')
    check('/gate01/panel/ 面板 SPA 经前缀挂载可达（宿主 web diff=0）', panelSpa.status === 200 && (await panelSpa.text()).includes('行业 AI 工作台'), `status=${panelSpa.status}`)
    const panelBareMounted = await simGet('/gate01/panel')
    check('/gate01/panel 302 → /gate01/panel/（externalBase 感知，与独立形态同语义）',
      panelBareMounted.status === 302 && panelBareMounted.headers.get('location') === '/gate01/panel/',
      `status=${panelBareMounted.status} location=${panelBareMounted.headers.get('location')}`)
    const spaMiss = await simGet('/gate01/anything-else')
    check('非 /api 未命中回落 SPA（与独立形态一致）', spaMiss.status === 200 && (await spaMiss.text()).includes('<!doctype html>'))
    const apiMiss = await simGet('/gate01/api/definitely-missing', adminToken)
    const apiMissBody = await apiMiss.json().catch(() => null)
    check('未匹配 API 404 JSON 不落静态（DEF-01）', apiMiss.status === 404 && apiMissBody?.error?.code === 'NOT_FOUND')
    const simMiss = await fetch(`http://127.0.0.1:${sim.address().port}/outside`)
    check('前缀外请求不进元冰可数据面（dsh 侧自有路由域不受影响）', simMiss.status === 404 && (await simMiss.text()) === 'sim-miss')

    // -- 身份半：票据兑换 → Cookie 绑定 → 状态 → 会话归因 → 实时失效（M4/M5） ----
    check('免登引导脚本经 tapIndex 注入', taps.length === 1 && taps[0]('<html><head></head></html>').includes('entry_ticket'))
    const simOrigin = `http://127.0.0.1:${sim.address().port}`
    const adminUser = mountCtx.iam.users().findOne((u) => u.username === 'admin')
    check('基线初始化（挂载形态最小树）产出 admin', Boolean(adminUser))
    const entryIssue = mountCtx.entryTickets.issue({ refType: 'agent', refId: 'agt_mount_test', userId: adminUser.id, userName: '平台管理员' })
    const entryRes = await fetch(`${simOrigin}/auth/entry?entry_ticket=${encodeURIComponent(entryIssue.ticket)}`, { redirect: 'manual' })
    const setCookie = entryRes.headers.get('set-cookie') ?? ''
    check('/auth/entry 兑换 → 302 / + Set-Cookie rq_sid（HttpOnly/SameSite=Lax）',
      entryRes.status === 302 && entryRes.headers.get('location') === '/' && setCookie.includes('rq_sid=rbs_') && setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Lax'),
      `${entryRes.status} ${setCookie}`)
    const cookie = setCookie.split(';')[0] ?? ''
    const statusRes = await fetch(`${simOrigin}/dsh-bridge/status`, { headers: { cookie } })
    const statusBody = await statusRes.json()
    check('/dsh-bridge/status 读 Cookie 返回绑定身份', statusBody?.data?.bound === true && statusBody.data.identity?.sub === adminUser.id, JSON.stringify(statusBody))
    const statusAnon = await fetch(`${simOrigin}/dsh-bridge/status`)
    const statusAnonBody = await statusAnon.json()
    check('无 Cookie 状态查询 → 未绑定（不作身份推断）', statusAnonBody?.data?.bound === false)
    check('绑定自检原因码：无 Cookie → no_cookie（WP-04/A2 文案映射依据）', statusAnonBody?.data?.reason === 'no_cookie', JSON.stringify(statusAnonBody))
    const entryReplay = await fetch(`${simOrigin}/auth/entry?entry_ticket=${encodeURIComponent(entryIssue.ticket)}`, { redirect: 'manual' })
    check('票据重放被拒（一次性消费，redeem 抛错→400）', entryReplay.status === 400)
    const bindRes = await fetch(`${simOrigin}/dsh-bridge/bind-session`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ sessionId: 'sess-mount-1' }),
    })
    check('会话绑定 200（Cookie 定身份 → sessionId 关联）', bindRes.status === 200, JSON.stringify(await bindRes.json()))
    const boundViaSession = mountCtx.identityBinding.identityForSession('sess-mount-1')
    const boundFallback = mountCtx.identityBinding.identityForSession('sess-unknown')
    check('工具出站归因解析：会话绑定优先 / 未绑定回落最近绑定', boundViaSession?.userId === adminUser.id && boundFallback?.userId === adminUser.id, JSON.stringify({ boundViaSession, boundFallback }))
    mountCtx.iam.users().update(adminUser.id, { status: 'suspended' })
    const statusFrozen = await fetch(`${simOrigin}/dsh-bridge/status`, { headers: { cookie } })
    const statusFrozenBody = await statusFrozen.json()
    check('账号停用 → 绑定实时失效（兑换面已校验 + 读取面再校验）', statusFrozenBody?.data?.bound === false)
    check('绑定自检原因码：停用账号 → account_inactive（可识别、可出文案）', statusFrozenBody?.data?.reason === 'account_inactive', JSON.stringify(statusFrozenBody))
    mountCtx.iam.users().update(adminUser.id, { status: 'active' })
    const crossOrigin = await fetch(`${simOrigin}/dsh-bridge/status`, { headers: { origin: 'http://evil.example.com' } })
    check('绑定面同源收紧：跨站 Origin 403（对齐 dsh fence 语义）', crossOrigin.status === 403)

    // -- 宿主会话直通（review-dsh-agent-panel-v2 宿主打通）：rq_sid → 平台会话 → 面板 RBAC 面 --
    mountCtx.iam.users().update(adminUser.id, { status: 'active' })
    const sessionRes = await fetch(`${simOrigin}/dsh-bridge/session`, { method: 'POST', headers: { 'content-type': 'application/json', cookie } })
    const sessionBody = await sessionRes.json().catch(() => null)
    check('宿主会话直通：Cookie 绑定身份兑换平台会话（token + user + permissions）',
      sessionRes.status === 200 && sessionBody?.ok === true && Boolean(sessionBody.data?.token) && Array.isArray(sessionBody.data?.user?.permissions) && sessionBody.data.user.permissions.length > 0,
      JSON.stringify(sessionBody?.error ?? sessionBody?.data?.user?.displayName))
    const panelViaSession = await fetch(`${simOrigin}/gate01/api/panel/depts`, { headers: { authorization: `Bearer ${sessionBody.data.token}` } })
    const panelViaSessionBody = await panelViaSession.json().catch(() => null)
    check('宿主会话直通：兑换令牌直通面板 RBAC 面（/gate01/api/panel/depts 200）',
      panelViaSession.status === 200 && panelViaSessionBody?.ok === true && Array.isArray(panelViaSessionBody.data?.depts) && panelViaSessionBody.data.depts.length === 5,
      `status=${panelViaSession.status}`)
    const sessionNoCookie = await fetch(`${simOrigin}/dsh-bridge/session`, { method: 'POST' })
    const sessionNoCookieBody = await sessionNoCookie.json().catch(() => null)
    check('宿主会话直通：无 Cookie 401（NOT_BOUND fail-closed，同源面统一收紧）',
      sessionNoCookie.status === 401 && sessionNoCookieBody?.error?.code === 'NOT_BOUND')

    // -- behavior 消费语义（WP-03/D3，进程内直测：投递 / 死信 / 重放幂等） -----------
    const behaviorSeen = []
    const offBehavior = mountCtx.behavior.consume('selftest-observer', (event) => { behaviorSeen.push(event.event_id) })
    const bFirst = mountCtx.behavior.record({ subject: 'user:usr-behavior-test', type: 'funnel.step', platform: 'rd', payload: { step: 1 }, idempotency_key: 'b-selftest-001' })
    check('behavior 投递：先写后发（消费方收到首投）', bFirst.duplicated === false && behaviorSeen.includes(bFirst.event.event_id))
    const bDup = mountCtx.behavior.record({ subject: 'user:usr-behavior-test', type: 'funnel.step', platform: 'rd', payload: { step: 1 }, idempotency_key: 'b-selftest-001' })
    check('behavior 投递：幂等重放不重发（消费水位跳过 + duplicated 标记）',
      bDup.duplicated === true && behaviorSeen.filter((id) => id === bFirst.event.event_id).length === 1)
    mountCtx.behavior.consume('selftest-broken', () => { throw new Error('自测故障消费方') })
    const bFail = mountCtx.behavior.record({ subject: 'user:usr-behavior-test', type: 'card.clicked', idempotency_key: 'b-selftest-002' })
    check('behavior 投递：消费方连续 3 次失败入死信', mountCtx.behavior.deadLetters().all().some((letter) => letter.event_id === bFail.event.event_id && letter.consumer === 'selftest-broken'))
    check('behavior 投递：死信触发 critical 告警（audit.alert.fired）',
      mountCtx.platformBus.recent(50).some((event) => event.name === 'audit.alert.fired' && JSON.stringify(event.payload).includes('behavior 消费死信')))
    const behaviorBeforeReplay = behaviorSeen.length
    mountCtx.behavior.replay(new Date(0).toISOString())
    check('behavior 投递：replay 幂等（已消费事件不重投）', behaviorSeen.length === behaviorBeforeReplay)
    const retriedBehavior = mountCtx.behavior.retryDeadLetters()
    check('behavior 投递：死信重投（故障消费方仍失败则保留死信）', retriedBehavior.remaining >= 1 && mountCtx.behavior.deadLetters().all().some((letter) => letter.consumer === 'selftest-broken'))
    offBehavior()

    // -- 卡片包装载与过滤（WP-05/B1，进程内直测：坏文件跳过 / 死 ref / 角色过滤 / 上限） ----
    const packDir = join(bridgeDataDir, 'cardpacks-test')
    await mkdir(packDir, { recursive: true })
    const tCards = Array.from({ length: 7 }, (_, index) => ({
      id: `t${index + 1}`, title: `卡${index + 1}`, description: '自测卡', badge: 'mcp', href: '#/mcp',
      ...(index === 1 ? { ref: 'app:no-such-app' } : { ref: 'mcp:datawise' }),
      order: index + 1,
    }))
    writeFileSync(join(packDir, 'rd-test.json'), JSON.stringify({ platform: 'rd', roles: ['*'], cards: tCards }))
    writeFileSync(join(packDir, 'admin-only.json'), JSON.stringify({
      platform: 'rd', roles: ['super_admin'],
      cards: [{ id: 'tadm', title: '管理员专属', description: '仅管理员可见', badge: 'nas', href: '#/nas' }],
    }))
    writeFileSync(join(packDir, 'broken.json'), JSON.stringify({ platform: 'nope', roles: ['*'], cards: [] }))
    // 独立 Context 构造（mountCtx 已由 panelCore 装配过 cardpacks 服务，重复 provide 会抛错）
    const packCtx = new Context()
    const packSvc = new panelCore.CardpackService(packCtx, { dir: packDir })
    await packSvc.loadFromDir(packDir)
    check('卡片包装载：坏文件跳过不阻断启动（loadProblems 留痕，合法 2 包在册）',
      packSvc.all().length === 2 && packSvc.loadProblems().length >= 1,
      JSON.stringify({ packs: packSvc.all().length, errors: packSvc.loadProblems() }))
    const devCards = panelCore.filterCards({ packs: packSvc.forPlatform('rd'), roles: ['developer'], refAlive: (ref) => ref !== 'app:no-such-app' })
    check('卡片包过滤：死 ref 丢弃留痕 + 角色过滤生效 + 首页上限 6',
      devCards.cards.length === 6 && !devCards.cards.some((card) => card.id === 't2') && !devCards.cards.some((card) => card.id === 'tadm')
      && devCards.droppedDeadRefs.includes('app:no-such-app'),
      JSON.stringify({ cards: devCards.cards.map((card) => card.id), dropped: devCards.droppedDeadRefs }))

    // -- OIDC 授权码通道（start 302 → PKCE；callback 坏 state 拒绝） -----------------
    const oidcStart = await fetch(`${simOrigin}/auth/oidc/start`, { redirect: 'manual' })
    const oidcLocation = oidcStart.headers.get('location') ?? ''
    // issuer 断言口径（2026-11-02 合并回归）：#15 请求派生 issuer = 请求 host + externalBase（/gate01）。
    // 无参 issuer() 在本台架回落 http://127.0.0.1:0/gate01（port=0），不能与请求派生值比对——
    // 改断「请求 host:port + /gate01」前缀（与 deriveIssuerFromRequest 同口径）。
    check('/auth/oidc/start 302 平台授权页（client_id + PKCE S256 + state）',
      oidcStart.status === 302 && oidcLocation.startsWith(`${simOrigin}/gate01/oauth/authorize`)
      && oidcLocation.includes('client_id=oc-selftest-bridge') && oidcLocation.includes('code_challenge_method=S256') && oidcLocation.includes('state='),
      `${oidcStart.status} ${oidcLocation}`)
    const oidcCallbackBad = await fetch(`${simOrigin}/auth/oidc/callback?code=x&state=bogus`, { redirect: 'manual' })
    check('/auth/oidc/callback 坏 state 被拒 400（防 CSRF/重放）', oidcCallbackBad.status === 400)

    // ================================================================ M2/M3 宿主连接向导（plugin-rq-card hostlink + 注入面契约）
    // 复用 mount 台架：本段全部经 sim（/rq 前缀 → bridge → 数据面分发），覆盖免登命名空间、
    // 向导头防线、扫描发现、远端代理白名单、本机首启初始化、rq_host_status 工具与前端契约。
    section('宿主连接向导（rq-card hostlink：免登命名空间 / 扫描 / 远端代理）')
    {
      await mountCtx.plugin(rqCard, {})
      const wfetchSim = async (method, wpath, { headers = {}, body } = {}) => {
        const response = await fetch(`${simOrigin}${wpath}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-rqcard-call': '1', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: response.status, body: await response.json().catch(() => null) }
      }

      // -- 免登命名空间 + 向导头防线（console 鉴权中间件只拦 /api/*，/rqcard/* 可达）--
      const noHeader = await fetch(`${simOrigin}/gate01/rqcard/link`)
      check('hostlink：缺 x-rqcard-call 头 403（跨站 drive-by 防线）', noHeader.status === 403, `status=${noHeader.status}`)
      const linkNone = await wfetchSim('GET', '/gate01/rqcard/link')
      check('hostlink：未配置态（mode=none，免登可达）',
        linkNone.status === 200 && linkNone.body?.data?.mode === 'none',
        JSON.stringify(linkNone.body))

      // -- stub 远端宿主 ×3：A=dsh 挂载形态（/rq 前缀），B=独立宿主形态（无前缀），C=慢网独立宿主（健康响应延迟 2s） --
      const hubSeen = { authz: '', logins: 0, panelCalls: 0, tickets: 0, panelAuthz: '', panelHeader: '', polls: 0, pollAuthz: '', pollHeader: '', streams: 0 }
      const hubStubA = createServer(async (req, res) => {
        const url = req.url ?? ''
        const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
        if (req.method === 'GET' && (url === '/rq/api/health' || url === '/api/health')) return json(200, { ok: true, data: { version: '9.9.9-hubA' } })
        if (req.method === 'POST' && url === '/rq/api/auth/login') {
          hubSeen.logins += 1
          hubSeen.authz = String(req.headers.authorization ?? '')
          return json(200, { ok: true, data: { token: 'stub-hub-session', refreshToken: 'stub-hub-refresh', user: { id: 'u1', displayName: '远端管理员', permissions: ['*'] } } })
        }
        // G1 回跳闭环（问题1）：宿主侧签发的一次性票据由代理回宿主兑换（形状对齐 console entry-ticket-session）
        if (req.method === 'POST' && url === '/rq/api/auth/entry-ticket-session') {
          hubSeen.tickets += 1
          return json(200, { ok: true, data: { token: 'stub-g1-session', refreshToken: 'stub-g1-refresh', expiresAt: '2026-09-08T00:00:00Z', user: { id: 'u-g1', username: 'g1user', displayName: 'G1回跳用户', orgId: 'org1', roleIds: [], roles: ['业务'], permissions: ['panel.read', '*'] } } })
        }
        if (url === '/rq/api/auth/me') return json(200, { ok: true, data: { id: 'u-g1', displayName: 'G1回跳用户', permissions: ['*'] } })
        // issue #6：SSE 流式透传的宿主侧——两帧事件后关闭（代理透传测试读尽即判定）
        if (req.method === 'GET' && url.split('?')[0] === '/rq/api/panel/stream') {
          hubSeen.streams += 1
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.write('data: {"hello":"stub-stream-event"}\n\n')
          setTimeout(() => { try { res.write('data: {"hello":"stub-stream-event-2"}\n\n'); res.end() } catch { /* 客户端已断开 */ } }, 200)
          return
        }
        if (url.startsWith('/rq/api/panel/')) {
          hubSeen.panelCalls += 1
          hubSeen.panelAuthz = String(req.headers.authorization ?? '')
          hubSeen.panelHeader = String(req.headers['x-rqcard-call'] ?? '')
          if (url.split('?')[0] === '/rq/api/panel/rd/poll') {
            hubSeen.polls += 1
            hubSeen.pollAuthz = hubSeen.panelAuthz
            hubSeen.pollHeader = hubSeen.panelHeader
          }
          // 面板数据面最小全量形状：depts/industries/overview/channels 让真实前端 init 链路能走通
          return json(200, { ok: true, data: {
            stub: 'panel', path: url,
            depts: [{ id: 'rd', label: '研发(Stub远端)', icon: '🔬', allowed: true, agents: [] }],
            industries: [],
            dept: { id: 'rd', label: '研发(Stub远端)', icon: '🔬', theme: 'stub', collab: '协作', agents: [] },
            channels: [{ id: 'c1', name: '📢 综合(Stub)' }],
            members: [], industry: null, models: [], tasks: [], artifacts: [], messages: [],
            kpis: [], widgets: [],
          } })
        }
        return json(404, { ok: false })
      })
      const hubStubB = createServer((req, res) => {
        const url = req.url ?? ''
        // 对抗性形态（Bug1 回归）：独立宿主对未匹配路径走 SPA 兜底——/rq/api/health 回 200 HTML，
        // 探活若只看 200 会把挂载前缀误判成 '/rq'（钉钉登录跳错地址、代理打错路径）
        if (req.method === 'GET' && (url === '/rq/api/health' || url.split('?')[0] === '/rq/api/health')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<!doctype html><html><body>standby console spa</body></html>')
          return
        }
        if (req.method === 'GET' && url === '/api/health') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, data: { version: '8.8.8-hubB' } }))
          return
        }
        if (req.method === 'POST' && url === '/api/auth/logout') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<!doctype html><html><body>spa fallback</body></html>')
          return
        }
        res.writeHead(404).end('{}')
      })
      const hubStubC = createServer((req, res) => {
        // 慢网独立宿主（issue #5）：健康响应延迟 2s——快档 1.4s 判超时，放宽档 6s 命中；
        // 其余路径立即 404（真实独立宿主对未匹配路径的行为）
        if (req.method === 'GET' && req.url === '/api/health') {
          setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: { version: '7.7.7-hubC-slow' } })) }, 2000)
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
      })
      await new Promise((resolve) => hubStubA.listen(0, '127.0.0.1', resolve))
      await new Promise((resolve) => hubStubB.listen(0, '127.0.0.1', resolve))
      await new Promise((resolve) => hubStubC.listen(0, '127.0.0.1', resolve))
      const hubA = `http://127.0.0.1:${hubStubA.address().port}`
      const hubB = `http://127.0.0.1:${hubStubB.address().port}`
      const hubC = `http://127.0.0.1:${hubStubC.address().port}`
      try {
        const scanRes = await wfetchSim('POST', '/gate01/rqcard/link/scan', { body: { candidates: [hubA, hubB, 'http://127.0.0.1:1'] } })
        check('hostlink：扫描发现两类宿主（挂载前缀自动判定 /rq 与 空串）',
          scanRes.status === 200 && scanRes.body.data.hosts.length === 2
          && scanRes.body.data.hosts.some((host) => host.endpoint === hubA && host.mountPrefix === '/rq' && host.version === '9.9.9-hubA')
          && scanRes.body.data.hosts.some((host) => host.endpoint === hubB && host.mountPrefix === ''),
          JSON.stringify({ status: scanRes.status, body: scanRes.body }))
        const linkRemote = await wfetchSim('POST', '/gate01/rqcard/link/remote', { body: { hubBase: hubA, label: '自测宿主A' } })
        check('hostlink：连接远端宿主（探测可达才落盘，mountPrefix=/rq）',
          linkRemote.status === 200 && linkRemote.body.data.config.mode === 'remote' && linkRemote.body.data.config.hubMountPrefix === '/rq' && linkRemote.body.data.probe.reachable === true,
          JSON.stringify(linkRemote.body))
        const linkRemoteBad = await wfetchSim('POST', '/gate01/rqcard/link/remote', { body: { hubBase: 'http://127.0.0.1:1' } })
        check('hostlink：不可达宿主被拒（400，不落盘）', linkRemoteBad.status === 400 && /不可达/.test(String(linkRemoteBad.body?.error?.message ?? '')), JSON.stringify({ status: linkRemoteBad.status, body: linkRemoteBad.body }))
        // -- issue #5（2026-10-29）：公网/慢网宿主快档（1.4s/前缀）全超时后以放宽档（6s/前缀）复探再判死；
        //    timeoutMs 显式覆盖时单级判定，不二次等待 --
        const linkSlow = await wfetchSim('POST', '/gate01/rqcard/link/remote', { body: { hubBase: hubC } })
        check('hostlink：慢网宿主快档超时后放宽复探成功（issue #5，不再误判不可达）',
          linkSlow.status === 200 && linkSlow.body?.data?.probe?.version === '7.7.7-hubC-slow' && linkSlow.body.data.config.hubMountPrefix === '',
          JSON.stringify(linkSlow.body))
        const linkSlowOverride = await wfetchSim('POST', '/gate01/rqcard/link/remote', { body: { hubBase: hubC, timeoutMs: 800 } })
        check('hostlink：timeoutMs 覆盖单级判定（覆盖窗内无健康响应即拒）',
          linkSlowOverride.status === 400 && /不可达/.test(String(linkSlowOverride.body?.error?.message ?? '')),
          JSON.stringify({ status: linkSlowOverride.status, body: linkSlowOverride.body }))
        await wfetchSim('POST', '/gate01/rqcard/link/remote', { body: { hubBase: hubA } }) // 还原宿主 A 供后续断言

        // -- 远端代理：白名单转发 + Authorization 透传 + 白名单外 403 --
        const proxyLogin = await wfetchSim('POST', '/gate01/rqcard/proxy/api/auth/login', {
          body: { username: 'admin', password: 'whatever' },
          headers: { authorization: 'Bearer proxied-token-abc' },
        })
        check('hostlink：代理白名单内转发（宿主收到 Authorization 透传，响应原样回浏览器）',
          proxyLogin.status === 200 && hubSeen.logins === 1 && hubSeen.authz === 'Bearer proxied-token-abc' && proxyLogin.body?.data?.token === 'stub-hub-session',
          JSON.stringify({ status: proxyLogin.status, hubSeen, body: proxyLogin.body }))
        const proxyPanel = await wfetchSim('GET', '/gate01/rqcard/proxy/api/panel/depts')
        check('hostlink：面板 REST 全族经代理可达（形态 C 完整体验的数据面）',
          proxyPanel.status === 200 && proxyPanel.body?.data?.stub === 'panel' && hubSeen.panelCalls === 1, JSON.stringify(proxyPanel.body))
        const proxyDenied = await wfetchSim('GET', '/gate01/rqcard/proxy/api/iam/users')
        check('hostlink：代理白名单外 403（PROXY_PATH_DENIED）', proxyDenied.status === 403 && proxyDenied.body?.error?.code === 'PROXY_PATH_DENIED')
        // -- issue #6（2026-10-29）：SSE 改为流式透传——该 GET 豁免 x-rqcard-call（EventSource
        //    带不了自定义头），content-type 原样、事件数据逐块到达，不再 403（故此处故意不带向导头）--
        const proxyStream = await fetch(`${simOrigin}/gate01/rqcard/proxy/api/panel/stream?dept=rd&ticket=stub-stream-ticket`)
        const proxyStreamCt = String(proxyStream.headers.get('content-type') ?? '')
        const proxyStreamText = await proxyStream.text()
        check('hostlink：SSE 流式透传（豁免向导头，text/event-stream + 事件数据原样到达）',
          proxyStream.status === 200 && proxyStreamCt.includes('text/event-stream')
          && proxyStreamText.includes('stub-stream-event') && hubSeen.streams === 1,
          JSON.stringify({ status: proxyStream.status, ct: proxyStreamCt, text: proxyStreamText.slice(0, 120), streams: hubSeen.streams }))

        // -- Bug1 回归：SPA HTML 兜底不得误判为健康宿主（/rq 前缀被独立宿主的 HTML 200 骗走）--
        const linkFormA = await wfetchSim('POST', '/gate01/rqcard/link/remote', { body: { hubBase: hubB } })
        check('hostlink：Bug1 回归——独立宿主 /rq/api/health 回 200 HTML 不误判（mountPrefix 判为空串）',
          linkFormA.status === 200 && linkFormA.body.data.config.hubMountPrefix === '' && linkFormA.body.data.probe.version === '8.8.8-hubB',
          JSON.stringify(linkFormA.body?.data ?? linkFormA.body))
        // -- 代理 HTML 防线：宿主回 HTML（地址/前缀错配的特征）显式 502，不透传整页 --
        const proxyHtml = await wfetchSim('POST', '/gate01/rqcard/proxy/api/auth/logout')
        check('hostlink：宿主回 HTML 而非 JSON → 502 HUB_BAD_RESPONSE（不把整页 HTML 当数据透传）',
          proxyHtml.status === 502 && proxyHtml.body?.error?.code === 'HUB_BAD_RESPONSE')
        // 还原为宿主 A 连接供后续断言
        await wfetchSim('POST', '/gate01/rqcard/link/remote', { body: { hubBase: hubA } })
        // -- G1 兑换通道：票据兑换端点在代理白名单内（boot.js 回跳闭环的服务端前提）--
        const proxyTicket = await wfetchSim('POST', '/gate01/rqcard/proxy/api/auth/entry-ticket-session', { body: { ticket: 'g1-selftest-ticket' } })
        check('hostlink：票据兑换端点经代理白名单转发（G1 回跳兑换通道）',
          proxyTicket.status === 200 && proxyTicket.body?.data?.token === 'stub-g1-session' && hubSeen.tickets === 1,
          JSON.stringify({ status: proxyTicket.status, body: proxyTicket.body }))

        // -- 断开：回到未配置，代理即拒 --
        const resetRes = await wfetchSim('POST', '/gate01/rqcard/link/reset')
        check('hostlink：断开回到未配置', resetRes.status === 200 && resetRes.body?.data?.config?.mode === 'none', JSON.stringify({ status: resetRes.status, body: resetRes.body }))
        const proxyAfterReset = await wfetchSim('GET', '/gate01/rqcard/proxy/api/panel/depts')
        check('hostlink：未连接时代理 409 NOT_REMOTE', proxyAfterReset.status === 409 && proxyAfterReset.body?.error?.code === 'NOT_REMOTE')

        // plan-gate01 决策 1：本机初始化端点（/rqcard/local-init*）已下线——登录统一在宿主侧完成。
        // 对应的 7 条端点断言（首启检测/弱口令/初始化/一次性消费/二次拒绝/新口令登录/监听指引）随之退役。

        // -- 向导 DOM 全链模拟（jsdom 驱动真实面板前端 × 真实向导端点：问题1/问题2 实机回归）--
        // 用户在浏览器里的两段真实操作逐击复演：
        //   A. 连接远端宿主 → 点「钉钉扫码登录」——打开地址必须按探测判定的真实挂载前缀构造
        //      （独立宿主不多拼前缀；宿主轨挂载宿主按探测判定带 /gate01 或 /rq）；
        //   B. 同页先做过远端登录尝试（连接作用域被污染）再点「设置口令并登录」——
        //      令牌必须落默认键（gate01_token），重载后按默认键读到才进得了工作台；
        //   C. 两条「去控制台登录」链接必须带尾斜杠（/rq 不带斜杠触发 302 → /rq/，
        //      重定向吃掉 ?next 与 #/login 片段，地址栏一串百分号编码即用户所见的「乱码」）。
        {
          const { JSDOM, VirtualConsole } = await import('jsdom')
          const vc = new VirtualConsole()
          const domErrors = []
          vc.on('jsdomError', (e) => { if (!/Not implemented/.test(String(e?.message ?? ''))) domErrors.push(String(e?.message ?? e)) })
          const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
            url: `${simOrigin}/gate01/panel/`, pretendToBeVisual: true, virtualConsole: vc,
          })
          // 导航捕获（2026-11-02 合并回归）：面板已合规化「零弹窗铁律」——钉钉登录等入口改整页
          // 跳转（location.href），不再 window.open；jsdom 的 location 为非配置属性、导航错误又不
          // 携带目标 URL——改由产品侧测试缝 __panelNavHook 捕获（wizard.js 内有对应注释）。
          const navigatedUrls = []
          dom.window.__panelNavHook = (url) => { navigatedUrls.push(String(url)) }
          const openedUrls = []
          dom.window.open = (url) => { openedUrls.push(String(url)); return null }
          const savedGlobals = {
            fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window,
            location: globalThis.location, localStorage: globalThis.localStorage,
          }
          globalThis.window = dom.window
          globalThis.document = dom.window.document
          globalThis.location = dom.window.location
          globalThis.localStorage = dom.window.localStorage
          globalThis.fetch = (input, init) => savedGlobals.fetch(new URL(String(input), simOrigin).href, init)
          const waitForDom = async (cond, ms = 5000) => {
            const t0 = Date.now()
            while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)) }
            return cond()
          }
          try {
            const PANEL_JS = join(process.cwd(), 'packages', 'plugin-panel-core', 'public', 'js')
            const panelApi = await import(pathToFileURL(join(PANEL_JS, 'api.js')).href)
            const wizard = await import(pathToFileURL(join(PANEL_JS, 'wizard.js')).href)
            const panelApp = await import(pathToFileURL(join(PANEL_JS, 'app.js')).href)
            const connectHub = async (hub) => {
              await wizard.start({ base: '/gate01' })
              document.querySelector('#wzHubInput').value = hub
              document.querySelector('#wzHubConnect').click()
              await waitForDom(() => Boolean(document.querySelector('#wzLoginDd')))
            }

            // 场景 A（问题1 回归）：钉钉登录地址按真实挂载前缀构造，且携带 next=本机面板绝对地址
            // （G1 前向兼容：宿主采纳回跳增强后扫码即自动回本机 dsh；未采纳宿主按防 open redirect
            // 白名单忽略跨源 next，无害）
            const g1Next = encodeURIComponent(`${simOrigin}/gate01/panel/`)
            await connectHub(hubB)
            document.querySelector('#wzLoginDd').click()
            check('向导DOM：连独立宿主，钉钉登录地址不多拼 /rq 且携带 next 回跳（问题1 回归）',
              navigatedUrls.at(-1) === `${hubB}/?next=${g1Next}#/login`, navigatedUrls.at(-1))
            // 回导校验降级：无本机会话时点击 → 如实说明（宿主扫码会话无法跨站带回）并导向账号登录
            document.querySelector('#wzLoginCheck').click()
            await waitForDom(() => /无法跨站带回/.test(document.querySelector('#wzLoginErr')?.textContent ?? ''))
            check('向导DOM：回导校验无本机会话 → 诚实指引（不假装能取回宿主会话）',
              /无法跨站带回/.test(document.querySelector('#wzLoginErr')?.textContent ?? ''),
              document.querySelector('#wzLoginErr')?.textContent)
            await connectHub(hubA)
            document.querySelector('#wzLoginDd').click()
            check('向导DOM：连 dsh 挂载宿主，钉钉登录地址正确携带 /rq 与 next 回跳',
              navigatedUrls.at(-1) === `${hubA}/rq/?next=${g1Next}#/login`, navigatedUrls.at(-1))

            // plan-gate01 决策 1：场景 B（本机初始化令牌落默认键）随形态 B 下线退役——
            // 写令牌统一经远端登录代理通道（作用域键），默认键只由票据兑换/直登通道写入。

            // 场景 C（面板自持登录面，2026-09-11 用户实测「宿主已登录态无法完成面板授权」）：
            // /api/panel/auth/login 进入 console 公开白名单后，向导本机卡的登录面探针（空 body POST）
            // 在全量形态同样命中 400=可登录 → 本卡直接提供本机登录表单（账号密码，登录在面板完成），
            // 不再强制跳控制台；「宿主已登录却要登出才能进面板」的死路自此关闭。
            await wizard.start({ base: '/gate01' })
            await waitForDom(() => Boolean(document.querySelector('#wzLocalGo')))
            check('向导DOM：本机登录面直连（#wzLocalGo 表单在位，面板自持登录不再依赖控制台跳转）',
              Boolean(document.querySelector('#wzLocalUser')) && Boolean(document.querySelector('#wzLocalPass')),
              document.querySelector('#wzLocalBody')?.textContent?.slice(0, 80))
            panelApi.session.clear()
            panelApp.start({ base: '/gate01' })
            const guideHref = document.querySelector('.login-guide a')?.getAttribute('href') ?? ''
            check('向导DOM：面板登录引导「去控制台登录」链接带尾斜杠 + next 回跳 + #/login',
              guideHref.startsWith('/gate01/?next=') && guideHref.includes('#/login'), guideHref)
            check('向导DOM：jsdom 运行期零意外错误（reload 的 not-implemented 噪音已过滤）', domErrors.length === 0, domErrors.join(' | '))

            // 场景 D（问题1 G1 回跳闭环回归）：宿主签发 entry_ticket → boot 按连接形态经代理兑换 →
            // 会话落连接作用域键 → 面板数据面经代理携带宿主身份（Authorization + 向导头）。
            // 用全新 JSDOM（URL 带 ?entry_ticket=）驱动真实 boot.js 全链。
            await wfetchSim('POST', '/gate01/rqcard/link/remote', { body: { hubBase: hubA } })
            const dom2 = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
              url: `${simOrigin}/gate01/panel/?entry_ticket=g1-selftest-ticket`, pretendToBeVisual: true, virtualConsole: vc,
            })
            const saved2 = {
              fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window,
              location: globalThis.location, localStorage: globalThis.localStorage,
            }
            globalThis.window = dom2.window
            globalThis.document = dom2.window.document
            globalThis.location = dom2.window.location
            globalThis.localStorage = dom2.window.localStorage
            globalThis.fetch = (input, init) => saved2.fetch(new URL(String(input), simOrigin).href, init)
            try {
              const bootMod = await import(pathToFileURL(join(PANEL_JS, 'boot.js')).href + '?g1test=1')
              check('G1回跳：boot 模块装载（全新 JSDOM，URL 携带 ?entry_ticket=）', typeof bootMod === 'object')
              await waitForDom(() => Boolean(dom2.window.localStorage.getItem(`gate01_token@${hubA}`)))
              const g1Token = dom2.window.localStorage.getItem(`gate01_token@${hubA}`)
              check('G1回跳：宿主票据经代理兑换，会话落连接作用域键（gate01_token@<hub>）',
                g1Token === 'stub-g1-session', `token=${g1Token}`)
              check('G1回跳：刷新令牌同样落作用域键', dom2.window.localStorage.getItem(`gate01_refresh@${hubA}`) === 'stub-g1-refresh')
              check('G1回跳：地址栏票据即用即清（不常驻 URL）', dom2.window.location.search === '' && !dom2.window.location.hash.includes('entry_ticket'),
                `${dom2.window.location.search}|${dom2.window.location.hash}`)
              check('G1回跳：票据兑换打到宿主（hubSeen.tickets=2：白名单直测 1 + boot 回跳兑换 1）', hubSeen.tickets === 2, JSON.stringify(hubSeen))
              await waitForDom(() => hubSeen.panelCalls >= 2)
              check('G1回跳：面板数据面经代理抵达宿主并携带宿主身份（Authorization 透传 G1 会话；到达即证明已通过本机向导头守卫）',
                hubSeen.panelAuthz === 'Bearer stub-g1-session', hubSeen.panelAuthz)
              check('G1回跳：代理不向宿主转发向导头（防线在本机代理入口，非宿主侧）',
                hubSeen.panelHeader === '', hubSeen.panelHeader)
              check('G1回跳：未误入连接向导（remote 态直接进面板）', document.querySelector('.wizard') === null)
              // 实时轮询代理路径（app.js connectStream 远端映射的服务端半部）：真实 console realtime.js
              // 以代理轮询地址 + 向导头驱动，宿主应收到带身份的 /poll 请求
              const realtime = await import(pathToFileURL(join(process.cwd(), 'packages', 'plugin-console', 'public', 'js', 'realtime.js')).href)
              const streamHandle = realtime.createEventStream({
                url: `${simOrigin}/gate01/rqcard/proxy/api/panel/stream?dept=rd&token=${encodeURIComponent('stub-g1-session')}`,
                pollPath: `${simOrigin}/gate01/rqcard/proxy/api/panel/rd/poll`,
                pollIntervalMs: 200,
                headers: { authorization: 'Bearer stub-g1-session', 'x-rqcard-call': '1' },
              })
              await waitForDom(() => hubSeen.polls >= 1)
              streamHandle.close()
              check('G1回跳：实时轮询经代理直达宿主（SSE 被拒后 30s 轮询的远端承接路径）',
                hubSeen.polls >= 1 && hubSeen.pollAuthz === 'Bearer stub-g1-session',
                JSON.stringify({ polls: hubSeen.polls, pollAuthz: hubSeen.pollAuthz, pollHeader: hubSeen.pollHeader }))
              // 收尾等待：boot 驱动的面板 init 链（overview 拉取 → switchDept 尾部写 localStorage）
              // 必须在本作用域内走完——finally 恢复全局会删掉 localStorage，在途尾巴会
              // ReferenceError 崩进程（renderMain 渲染 .tabs 即 init 完成的稳定标记）
              await waitForDom(() => Boolean(document.querySelector('#colMain .tabs')))
            } finally {
              globalThis.fetch = saved2.fetch
              globalThis.document = saved2.document
              globalThis.window = saved2.window
              globalThis.location = saved2.location
              globalThis.localStorage = saved2.localStorage
            }
          } finally {
            if (savedGlobals.fetch) globalThis.fetch = savedGlobals.fetch
            if (savedGlobals.document === undefined) delete globalThis.document; else globalThis.document = savedGlobals.document
            if (savedGlobals.window === undefined) delete globalThis.window; else globalThis.window = savedGlobals.window
            if (savedGlobals.location === undefined) delete globalThis.location; else globalThis.location = savedGlobals.location
            if (savedGlobals.localStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = savedGlobals.localStorage
          }
          // 收场：连接态还原 none（不干扰后续 rq_host_status 等断言）
          await wfetchSim('POST', '/gate01/rqcard/link/reset')
        }
      } finally {
        await new Promise((resolve) => hubStubA.close(resolve))
        await new Promise((resolve) => hubStubB.close(resolve))
        await new Promise((resolve) => hubStubC.close(resolve))
      }

      // -- 工具 rq_host_status（Agent 可答连接状态；此时已 reset → none）--
      const hostTool = await mountCtx.tools.execute({ name: 'rq_host_status', arguments: {} })
      check('工具 rq_host_status（连接状态 + 面板入口）',
        hostTool.isError === false && hostTool.value?.mode === 'none' && typeof hostTool.value?.panelUrl === 'string',
        JSON.stringify(hostTool.value ?? hostTool.error))

      // -- 前端/注入面静态契约（改前端忘接线 = 这里红）--
      const bootJs = readFileSync('packages/plugin-panel-core/public/js/boot.js', 'utf8')
      check('前端契约：boot.js 探测 /rqcard/link 且带向导头、remote 切代理作用域',
        bootJs.includes('/rqcard/link') && bootJs.includes('x-rqcard-call') && bootJs.includes('setRemoteProxy') && bootJs.includes('wizard.js'))
      const appJsSource = readFileSync('packages/plugin-panel-core/public/js/app.js', 'utf8')
      check('前端契约：Agent 对话内嵌 dsh（协作栏 dsh 模式 iframe + 嵌套防护 + 模式记忆可退回面板会话）',
        appJsSource.includes('canEmbedDshChat') && appJsSource.includes('EMBEDDED') && appJsSource.includes('iaw_rail_mode') && appJsSource.includes('referrerpolicy="same-origin"'))
      const wizardJs = readFileSync('packages/plugin-panel-core/public/js/wizard.js', 'utf8')
      check('前端契约：连接向导（扫描/手输连接/本机数据面探测/钉钉引导；形态 B 设口令链路已退役）',
        wizardJs.includes('link/scan') && wizardJs.includes('link/remote') && wizardJs.includes('/api/health')
        && wizardJs.includes('wzLoginDd') && !wizardJs.includes('local-init'))
      check('前端契约：G1 前向兼容——钉钉登录打开宿主页携带 next=本机面板地址 + 回导校验降级在场',
        wizardJs.includes('?next=') && wizardJs.includes('encodeURIComponent(localPanelUrl)') && wizardJs.includes('wzLoginCheck'),
        'wizard.js 缺少 next 回跳或回导校验')
      const bootJsSource = readFileSync('packages/plugin-panel-core/public/js/boot.js', 'utf8')
      check('前端契约：G1 消费侧——boot 按连接形态路由票据兑换（远端经代理 + 作用域保存 + fragment 票据）',
        bootJsSource.includes('rqcard/proxy/api/auth/entry-ticket-session') && bootJsSource.includes('exchangeEntryTicketRemote')
        && bootJsSource.includes("where: 'hash'"),
        'boot.js 缺少远端票据兑换路由')
      const apiJsSource = readFileSync('packages/plugin-panel-core/public/js/api.js', 'utf8')
      check('前端契约：Bug3 回归——api.js 代理形态请求附加向导头（x-rqcard-call）',
        apiJsSource.includes("'x-rqcard-call'") && apiJsSource.includes('proxyHeaders'),
        'api.js 缺少代理向导头，形态 C 数据面会被 403')
      const appJsContract = readFileSync('packages/plugin-panel-core/public/js/app.js', 'utf8')
      check('前端契约：远端实时通道映射——connectStream 轮询走代理并带向导头',
        appJsContract.includes('rqcard/proxy`') && appJsContract.includes("headers['x-rqcard-call'] = '1'"),
        'app.js connectStream 缺少远端代理映射')
      const cardClientSource = readFileSync('packages/plugin-rq-card/src/client/index.ts', 'utf8')
      check('注入面契约：settings.section + conversation.view + 未连接角标 + 原生面板页（main/panellist 同 id 配对）',
        cardClientSource.includes('SLOT_SETTINGS') && cardClientSource.includes('SLOT_VIEW') && cardClientSource.includes('UNLINKED_BADGE_ID')
        && cardClientSource.includes('SLOT_MAIN') && cardClientSource.includes('SLOT_PANELLIST')
        && cardClientSource.includes('key: PANEL_ID') && cardClientSource.includes('id: PANEL_ID'))
    }

    await new Promise((resolve) => sim.close(resolve))
  }

  section('制造工具箱（plugin-panel-core/mfg：13 计算内核 / Skill 放行制 / 100 项选题）')
  {
    // 引擎与目录直接导入（纯函数面：不经 HTTP，与源项目单测同口径）
    const mfgEngine = await import('../packages/plugin-panel-core/src/mfg/engine.ts')
    const mfgCatalog = await import('../packages/plugin-panel-core/src/mfg/catalog.ts')
    const mfgQuality = await import('../packages/plugin-panel-core/src/mfg/quality.ts')
    const mfgSkills = await import('../packages/plugin-panel-core/src/mfg/skills.ts')
    const mfgRoadmap = await import('../packages/plugin-panel-core/src/mfg/roadmap.ts')
    const mfgEvaluate = await import('../packages/plugin-panel-core/src/mfg/evaluate.ts')
    const metric = (result, label) => result.blocks.flatMap((block) => block.type === 'metrics' ? block.items : []).find((item) => item.label === label)?.value
    const defaults = (id) => Object.fromEntries(mfgCatalog.tools.find((tool) => tool.id === id).fields.map((field) => [field.key, field.default]))
    const rejects = async (promise) => { try { await promise; return false } catch { return true } }

    check('并入：工具目录 16 项（13 计算内核 + 3 AI 工具）与 7 分类',
      mfgCatalog.tools.length === 16 && mfgCatalog.tools.filter((tool) => tool.mode === 'calculation').length === 13
      && mfgCatalog.tools.filter((tool) => tool.mode === 'model').length === 3 && mfgCatalog.categories.length === 7,
      JSON.stringify({ total: mfgCatalog.tools.length, categories: mfgCatalog.categories.length }))

    // -- 金标（源项目 tests/engine.test.ts 逐条重放）--------------------------------
    check('OEE 金标：735 × 0.5 / 480 = 76.5625% → 76.56',
      metric(await mfgEngine.execute('oee', defaults('oee')), '设备综合效率') === 76.56)
    check('OEE 跨字段约束与零运行时间全拒（running=0/481、good>total、cycle 超限、total 非整数）',
      (await rejects(mfgEngine.execute('oee', { ...defaults('oee'), running: 0 })))
      && (await rejects(mfgEngine.execute('oee', { ...defaults('oee'), running: 481 })))
      && (await rejects(mfgEngine.execute('oee', { ...defaults('oee'), good: 800 })))
      && (await rejects(mfgEngine.execute('oee', { ...defaults('oee'), cycle: 10 })))
      && (await rejects(mfgEngine.execute('oee', { ...defaults('oee'), total: 1.5 }))))
    const cpk = await mfgEngine.execute('cpk', defaults('cpk'))
    check('Cpk 偏移金标（Cp=1.667 / Cpk=1.5）与越界均值保留负值（-6.667）',
      metric(cpk, '过程能力 Cp') === 1.667 && metric(cpk, '过程能力 Cpk') === 1.5
      && metric(await mfgEngine.execute('cpk', { ...defaults('cpk'), mean: 11 }), '过程能力 Cpk') === -6.667
      && (await rejects(mfgEngine.execute('cpk', { ...defaults('cpk'), sigma: 0 })))
      && (await rejects(mfgEngine.execute('cpk', { ...defaults('cpk'), lsl: 20 }))))
    check('节拍 / EOQ / 重量 / RPN / ROI 独立金标（31.5 / -100 / 774.6 / 13.565 / 271.296 / 192 / 3 / 无法回收）',
      metric(await mfgEngine.execute('takt', defaults('takt')), '目标节拍') === 31.5
      && metric(await mfgEngine.execute('takt', defaults('takt')), '产能余缺') === -100
      && metric(await mfgEngine.execute('eoq', defaults('eoq')), '理论经济订货量') === 774.6
      && metric(await mfgEngine.execute('material', defaults('material')), '单件理论重量') === 13.565
      && metric(await mfgEngine.execute('material', defaults('material')), '总理论重量') === 271.296
      && metric(await mfgEngine.execute('fmea', defaults('fmea')), '风险优先数 RPN') === 192
      && metric(await mfgEngine.execute('roi', defaults('roi')), '静态回收期') === 3
      && metric(await mfgEngine.execute('roi', { ...defaults('roi'), saving: 0 }), '静态回收期') === '无法回收')
    const pareto = await mfgEngine.execute('pareto', { data: '刮伤,2\n色差,1\n刮伤,3' })
    check('帕累托：同名项聚合（6 次 / 2 类）、累计占比末行 100%、拒绝空白与非法计数',
      metric(pareto, '缺陷总数') === 6 && metric(pareto, '缺陷类别') === 2
      && JSON.stringify(pareto.blocks.find((block) => block.type === 'table').rows.at(-1)) === JSON.stringify(['色差', 1, '16.67%', '100%'])
      && (await rejects(mfgEngine.execute('pareto', { data: '刮伤,' })))
      && (await rejects(mfgEngine.execute('pareto', { data: '刮伤,-1' })))
      && (await rejects(mfgEngine.execute('pareto', { data: '刮伤,NaN' })))
      && (await rejects(mfgEngine.execute('pareto', { data: '刮伤,0' })))
      && (await rejects(mfgEngine.execute('pareto', { data: '刮伤,1.2' }))))
    const bom = await mfgEngine.execute('bom-diff', { before: 'code,quantity\nA,0\nB,2', after: 'code,quantity\nA,0\nC,1' })
    check('BOM 核对：区分「不存在」与零用量、拒绝重复键',
      metric(bom, '差异物料') === 2
      && JSON.stringify(bom.blocks.find((block) => block.type === 'table').rows) === JSON.stringify([['B', 2, '不存在', '删除'], ['C', '不存在', 1, '新增']])
      && (await rejects(mfgEngine.execute('bom-diff', { ...defaults('bom-diff'), before: 'code,quantity\nA,1\nA,2' }))))
    check('齐套检查用物料种数（不将不同单位数量相加）：缺料 2 种 / 满足率 33.33%',
      metric(await mfgEngine.execute('shortage', defaults('shortage')), '缺料种数') === 2
      && metric(await mfgEngine.execute('shortage', defaults('shortage')), '物料项满足率') === 33.33)
    {
      const date = new Date('2026-10-19T00:00:00Z')
      const rows = [0, 1, 30, 31, 60, 61, 90, 91].map((days, index) => `${index},${new Date(date.getTime() - days * 86400000).toISOString().slice(0, 10)},100`)
      const aging = await mfgEngine.execute('aging', { asOf: '2026-10-19', data: `id,dueDate,amount\n${rows.join('\n')}` })
      check('逾期分层边界：到期当天不逾期、30/31/60/61/90/91 天分层正确',
        metric(aging, '未结余额合计') === 800 && metric(aging, '逾期余额') === 700
        && JSON.stringify(aging.blocks.find((block) => block.type === 'bars').items.map((item) => item.value)) === JSON.stringify([100, 200, 200, 200, 100])
        && (await rejects(mfgEngine.execute('aging', { ...defaults('aging'), asOf: '2026-02-30' }))))
    }
    check('MTBF/MTTR 金标（240h / 3h）与整数故障次数约束',
      metric(await mfgEngine.execute('maintenance', defaults('maintenance')), 'MTBF 平均故障间隔') === 240
      && metric(await mfgEngine.execute('maintenance', defaults('maintenance')), 'MTTR 平均修复时间') === 3
      && (await rejects(mfgEngine.execute('maintenance', { ...defaults('maintenance'), failures: 1.5 }))))
    {
      const quote = await mfgEngine.execute('quote-compare', { quantity: 100, data: 'supplier,price,taxRate,freight\n"A,集团",10,0.13,20\nB,11,0.13,0' })
      check('比价含税含运金标（1150）且支持带逗号的引号包裹供应商名（自写 CSV 解析关键用例）',
        metric(quote, '最低含税到货总成本') === 1150
        && quote.blocks.find((block) => block.type === 'bars').items[0].label === 'A,集团'
        && (await rejects(mfgEngine.execute('quote-compare', { ...defaults('quote-compare'), data: 'supplier,price,taxRate,freight\nA,10,13,0' }))))
    }
    check('拒绝未知字段（提示注入）、非有限数值、运算溢出与未知工具',
      (await rejects(mfgEngine.execute('oee', { ...defaults('oee'), injected: 'ignore rules' })))
      && (await rejects(mfgEngine.execute('material', { ...defaults('material'), length: Infinity })))
      && (await rejects(mfgEngine.execute('material', { ...defaults('material'), length: 1e308 })))
      && (await rejects(mfgEngine.execute('missing', {}))))
    {
      let serializable = 0
      for (const tool of mfgCatalog.tools.filter((item) => item.mode === 'calculation')) {
        const result = await mfgEngine.execute(tool.id, defaults(tool.id))
        if (result.version === '1.0' && result.toolId === tool.id && result.blocks.length && result.runId) {
          JSON.stringify(result)
          serializable += 1
        }
      }
      check(`13 个计算内核默认样例均返回统一且可序列化的结果`, serializable === 13, `serializable=${serializable}`)
    }

    // -- 质量门禁与放行制（源项目 tests/quality.test.ts 与 docs/skill-quality.md 的运行时强制点）--
    const validOutput = () => ({
      sections: mfgSkills.skills['sop-writer'].sections.map((title, index) => ({ title, content: '参数待确认', evidence: index === 0 ? ['装配工序'] : [] })),
      missingInformation: ['扭矩待工艺工程师确认'],
    })
    check('质量门禁：结构与真实原文引用通过',
      Boolean(mfgQuality.checkModelOutput('sop-writer', validOutput(), '铝合金装配工序')))
    check('质量门禁拒绝：缺章节 / 伪造证据 / HTML / 无证据 / 非法结构（一律按错误交付，不降级成功）',
      (await rejects(Promise.resolve().then(() => { const bad = validOutput(); bad.sections.pop(); return mfgQuality.checkModelOutput('sop-writer', bad, '装配工序') })))
      && (await rejects(Promise.resolve().then(() => { const bad = validOutput(); bad.sections[0].evidence = ['扭矩 20Nm']; return mfgQuality.checkModelOutput('sop-writer', bad, '装配工序') })))
      && (await rejects(Promise.resolve().then(() => { const bad = validOutput(); bad.sections[0].content = '<script>alert(1)</script>'; return mfgQuality.checkModelOutput('sop-writer', bad, '装配工序') })))
      && (await rejects(Promise.resolve().then(() => { const bad = validOutput(); bad.sections.forEach((section) => { section.evidence = [] }); return mfgQuality.checkModelOutput('sop-writer', bad, '装配工序') })))
      && (await rejects(Promise.resolve().then(() => mfgQuality.checkModelOutput('sop-writer', 'anything', '装配工序')))))
    check('Skill 指纹稳定（64 hex）且未放行 Skill 的 releaseReady=false（fail-closed 默认）',
      mfgQuality.skillHash('sop-writer').length === 64
      && mfgQuality.releaseReady(new mfgQuality.MemoryReleaseStore(), 'sop-writer', { model: 'stub:model' }).ready === false)
    {
      // 放行门禁：mock 报告不足以放行；真实通过报告 + 审核人签署才放行，且模型指纹变化即失效
      const store = new mfgQuality.MemoryReleaseStore()
      const identity = { model: 'stub:model', endpoint: 'stub://local' }
      const liveReport = { skillId: 'sop-writer', skillHash: mfgQuality.skillHash('sop-writer'), modelHash: mfgQuality.modelIdentityHash(identity), model: identity.model, protocol: 'platform-gateway', status: 'passed', live: true, repetitions: 3, cases: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }
      check('放行门禁：mock 报告（live=false）不足以放行',
        await rejects(Promise.resolve().then(() => mfgQuality.buildRelease({ ...liveReport, live: false }, 'x', '审查员', 'technical'))))
      check('放行门禁：未通过 / 重复不足 / 审核人为空 均拒绝',
        (await rejects(Promise.resolve().then(() => mfgQuality.buildRelease({ ...liveReport, status: 'failed' }, 'x', '审查员', 'technical'))))
        && (await rejects(Promise.resolve().then(() => mfgQuality.buildRelease({ ...liveReport, repetitions: 1 }, 'x', '审查员', 'technical'))))
        && (await rejects(Promise.resolve().then(() => mfgQuality.buildRelease(liveReport, 'x', '', 'technical')))))
      const release = mfgQuality.buildRelease(liveReport, JSON.stringify(liveReport), '领域工程师', 'domain')
      store.put(release)
      check('放行门禁：真实报告 + 审核人签署后放行；模型指纹变化即失效（Skill 改动同理）',
        mfgQuality.releaseReady(store, 'sop-writer', identity).ready === true
        && mfgQuality.releaseReady(store, 'sop-writer', { model: 'stub:other' }).ready === false)
      const tampered = { ...release, skillHash: 'deadbeef' }
      store.put(tampered)
      check('放行门禁：Skill 指纹被篡改 → 拒绝放行', mfgQuality.releaseReady(store, 'sop-writer', identity).ready === false)
      const expired = { ...release, expiresAt: new Date(Date.now() - 1000).toISOString() }
      store.put(expired)
      check('放行门禁：放行记录过期 → 拒绝放行', mfgQuality.releaseReady(store, 'sop-writer', identity).ready === false)
    }
    check('AI 工具未接模型网关时诚实 503（不发假结果、不静默降级）',
      await rejects(mfgEngine.execute('sop', defaults('sop'))))
    check('评估断言面在场（四类样例 × 3 重复 = 36 次真实调用计划；断言器版本 1.2.0）',
      mfgEvaluate.assertionVersion === '1.2.0'
      && mfgEvaluate.evaluationPlan(3).reduce((sum, item) => sum + item.calls, 0) === 36)

    // -- 100 项选题清单（源项目「来源可追溯」断言的机器可读面）--------------------------
    {
      const roadmap = mfgRoadmap.loadRoadmap()
      check('选题清单 100 项、编号/标题唯一、逐条有来源与验收标准',
        roadmap.tools.length === 100
        && new Set(roadmap.tools.map((item) => item.id)).size === 100
        && new Set(roadmap.tools.map((item) => item.title)).size === 100
        && roadmap.tools.every((item) => item.sources.length > 0 && Boolean(item.acceptance)))
      check('选题状态计数与实现映射自洽（13 已实现 / 3 待验收 / 84 规划；实现项均指向真实工具）',
        roadmap.tools.filter((item) => item.status === 'implemented-calculation').length === 13
        && roadmap.tools.filter((item) => item.status === 'model-validation-pending').length === 3
        && roadmap.tools.filter((item) => item.status === 'planned').length === 84
        && roadmap.tools.filter((item) => item.implementation).every((item) => Boolean(mfgCatalog.findTool(item.implementation))))
    }

    // -- HTTP 面（真实服务：目录/清单读 + 执行写 + 演示态只读边界 + RBAC 越权）------------
    const mfgCatalogRes = await api('GET', '/api/panel/mfg/catalog', { token: admin })
    check('REST：GET /api/panel/mfg/catalog 目录面（工具 + 分类 + Skill 放行态 + 模型就绪态）',
      mfgCatalogRes.ok && mfgCatalogRes.data.tools.length === 16 && Array.isArray(mfgCatalogRes.data.skills) && mfgCatalogRes.data.skills.length === 3,
      JSON.stringify(mfgCatalogRes.error))
    const mfgRoadmapRes = await api('GET', '/api/panel/mfg/roadmap', { token: admin })
    check('REST：GET /api/panel/mfg/roadmap 选题面（100 项 + 10 分组 + 状态标签）',
      mfgRoadmapRes.ok && mfgRoadmapRes.data.tools.length === 100 && mfgRoadmapRes.data.groups.length === 10,
      JSON.stringify(mfgRoadmapRes.error))
    const mfgRun = await api('POST', '/api/panel/mfg/tools/oee/run', { token: admin, body: defaults('oee') })
    check('REST：POST tools/:id/run 经服务面执行（与引擎同口径 76.56）',
      mfgRun.ok && metric(mfgRun.data, '设备综合效率') === 76.56, JSON.stringify(mfgRun.error))
    const mfgRunBad = await api('POST', '/api/panel/mfg/tools/oee/run', { token: admin, body: { ...defaults('oee'), injected: 'x' } })
    check('REST：未知字段经 HTTP 同样被拒（400，不静默忽略）',
      !mfgRunBad.ok && mfgRunBad.status === 400, JSON.stringify({ status: mfgRunBad.status, error: mfgRunBad.error }))
    const mfgExport = await api('POST', '/api/panel/mfg/tools/oee/export', { token: admin, body: { result: mfgRun.data, format: 'md' } })
    check('REST：导出面产出 Markdown（文件名带工具 id 与时间戳）',
      mfgExport.ok && mfgExport.data.content.startsWith('# 设备综合效率 OEE') && /^oee-/.test(mfgExport.data.filename),
      JSON.stringify(mfgExport.error))
    const mfgReleases = await api('GET', '/api/panel/mfg/releases', { token: admin })
    // 形态无关断言：identity 随平台模型网关在场与否而变（全量形态有 modelgw、01门装态无）——
    // 断言「形状与判定自洽」而非某种环境取值：
    //   无网关 ⇒ identity=null 且每条记录 valid=false（不能声称已放行）；
    //   有网关 ⇒ identity 含 model 字段，valid 与 releaseReady 同源。
    check('REST：放行记录面可读，且 identity 与各条 valid 自洽（无网关时不得声称已放行）',
      mfgReleases.ok && Array.isArray(mfgReleases.data.releases)
      && (mfgReleases.data.identity === null
        ? mfgReleases.data.releases.every((item) => item.valid === false)
        : typeof mfgReleases.data.identity?.model === 'string')
      && mfgReleases.data.releases.every((item) => typeof item.valid === 'boolean'),
      JSON.stringify({ identity: mfgReleases.data?.identity, releases: mfgReleases.data?.releases?.length }))
    const mfgPlan = await api('GET', '/api/panel/mfg/evaluation-plan', { token: admin })
    check('REST：评估计划面（36 次调用计划 + 四类样例，不发起调用）',
      mfgPlan.ok && mfgPlan.data.plan.reduce((sum, item) => sum + item.calls, 0) === 36, JSON.stringify(mfgPlan.error))
    // 评估面：模型网关在场与否决定成败，但**任一形态都不得产出 mock 通过记录**——
    //   无网关 ⇒ 503 明确拒绝；有网关 ⇒ 真实出站（自测环境模型不可达 ⇒ 失败报告 live=true 且 status=failed，
    //   仍不足以放行）。两种结果都不产生放行，这才是要守的不变量。
    const mfgEvaluateAttempt = await api('POST', '/api/panel/mfg/evaluate', { token: admin, body: { skills: ['sop-writer'], repetitions: 1 } })
    check('REST：评估面在无模型网关时 503 拒绝；有网关时只产出 live 报告（mock 永不构成验收）',
      mfgEvaluateAttempt.status === 503
      || (mfgEvaluateAttempt.ok && mfgEvaluateAttempt.data.reports.length > 0
        && mfgEvaluateAttempt.data.reports.every((report) => report.live === true && typeof report.status === 'string')
        && /不构成放行/.test(mfgEvaluateAttempt.data.note ?? '')),
      JSON.stringify({ status: mfgEvaluateAttempt.status, reports: mfgEvaluateAttempt.data?.reports?.length, error: mfgEvaluateAttempt.error }))
    const mfgMemberRun = await api('POST', '/api/panel/mfg/tools/oee/run', { token: iawMemberToken, body: defaults('oee') })
    check('REST：member 可执行计算工具（panel.write 在基线角色内）', mfgMemberRun.ok, JSON.stringify(mfgMemberRun.error))
    const mfgMemberEvaluate = await api('POST', '/api/panel/mfg/evaluate', { token: iawMemberToken, body: {} })
    check('REST：member 调评估面被拒 403（放行治理动作需 panel.config.write）',
      !mfgMemberEvaluate.ok && mfgMemberEvaluate.status === 403, String(mfgMemberEvaluate.status))
    const mfgMemberRelease = await api('POST', '/api/panel/mfg/releases', { token: iawMemberToken, body: { report: {}, reviewer: 'x' } })
    check('REST：member 签署放行被拒 403（RBAC 硬边界）',
      !mfgMemberRelease.ok && mfgMemberRelease.status === 403, String(mfgMemberRelease.status))

    // -- 工具族（panel_mfg_* 经共享 tools 键：dsh 下即原生 ToolRuntime）------------------
    const mfgToolList = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'panel_mfg_tools_list', args: {} } })
    check('工具族：panel_mfg_tools_list 列出 16 项（含放行态字段）',
      mfgToolList.ok && mfgToolList.data.isError === false && mfgToolList.data.value.length === 16 && typeof mfgToolList.data.value[0].released === 'boolean',
      JSON.stringify(mfgToolList.data?.error))
    const mfgToolRun = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'panel_mfg_tool_run', args: { tool_id: 'cpk', input: defaults('cpk') } } })
    check('工具族：panel_mfg_tool_run 执行内核（Cpk=1.5，与网页面同引擎）',
      mfgToolRun.ok && mfgToolRun.data.isError === false && metric(mfgToolRun.data.value, '过程能力 Cpk') === 1.5, JSON.stringify(mfgToolRun.data?.error))
    const mfgToolRunBad = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'panel_mfg_tool_run', args: { tool_id: 'cpk', input: { ...defaults('cpk'), bogus: 1 } } } })
    check('工具族：未知字段同样被拒（工具面与网页面共用同一校验，不因入口而异）', mfgToolRunBad.data?.isError === true, JSON.stringify(mfgToolRunBad.data).slice(0, 200))
    const mfgToolRoadmap = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'panel_mfg_roadmap', args: { status: 'implemented-calculation' } } })
    check('工具族：panel_mfg_roadmap 可按状态筛选（13 已实现 / 100 总数）',
      mfgToolRoadmap.ok && mfgToolRoadmap.data.isError === false && mfgToolRoadmap.data.value.matched === 13 && mfgToolRoadmap.data.value.total === 100,
      JSON.stringify(mfgToolRoadmap.data?.error))
    // 工具面权限点经 routeMatrix 只覆盖 HTTP；工具权限点由 tools 注册面声明，
    // 这里以「member 能执行计算工具但不能放行」的越权断言证其边界（本段前文已断言）。
    check('工具族：三个 panel_mfg_* 已注册且具名可达（未注册会回落「未知工具」isError）',
      mfgToolList.data?.isError === false && mfgToolRun.data?.isError === false && mfgToolRoadmap.data?.isError === false)
  }


  section('01门 5 键装态（可选服务缺席不炸 + demoAuth fail-closed）')
  {
    const mkGate = async (port, demoAuth) => {
      const gateCtx = new Context()
      const dataDir = join('data-selftest', `gate01-${demoAuth ? 'demo' : 'strict'}-${port}`)
      await mkdir(dataDir, { recursive: true })
      await gateCtx.plugin(platformCore, { dataDir, http: { port, host: '127.0.0.1' }, startHttp: true })
      await gateCtx.plugin(panelCore, demoAuth ? { demoAuth: true } : {})
      await new Promise((resolve) => setTimeout(resolve, 150)) // fiber 激活 + 种子
      return gateCtx
    }
    const strictBase = 'http://127.0.0.1:7395'
    const demoBase = 'http://127.0.0.1:7396'
    await mkGate(7395, false)
    await mkGate(7396, true)
    const g = async (base, path, init) => { const r = await fetch(`${base}${path}`, init); return { status: r.status, body: await r.json().catch(() => null) } }

    // -- 严格态（demoAuth 缺省=false）：console 鉴权中间件缺位 → principal 缺失 → 干净 401（原 TypeError→500）--
    const strictBoard = await g(strictBase, '/api/panel/board')
    check('01门严格态：principal 缺失 → 干净 401 UNAUTHENTICATED（不再 TypeError 500）',
      strictBoard.status === 401 && strictBoard.body?.error?.code === 'UNAUTHENTICATED', JSON.stringify(strictBoard.body))
    const strictWrite = await g(strictBase, '/api/panel/rd/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) })
    check('01门严格态：写动词同样 401 fail-closed', strictWrite.status === 401, JSON.stringify(strictWrite.body))
    const strictStream = await fetch(`${strictBase}/api/panel/stream?dept=rd&token=whatever`).then((r) => r.json().catch(() => null))
    check('01门严格态：SSE ?token= 自校验失败（authn 缺席 → 干净 401）',
      strictStream?.error?.code === 'STREAM_AUTH_FAILED', JSON.stringify(strictStream))

    // -- 演示态（demoAuth:true）：只读放行（内置演示数据），写动词干净 403 --
    const demoDepts = await g(demoBase, '/api/panel/depts')
    check('01门演示态：GET depts 200（只读放行 + 部门骨架播种，iam 缺席零惊扰）',
      demoDepts.status === 200 && Array.isArray(demoDepts.body?.data?.depts) && demoDepts.body.data.depts.length === 5,
      JSON.stringify(demoDepts.body?.error ?? demoDepts.body?.data?.depts?.length))
    const demoBoard = await g(demoBase, '/api/panel/board')
    check('01门演示态：board 端点不 500（5 键形态下卡片包面 200 + 资产聚合诚实降级全 0）',
      demoBoard.status === 200 && demoBoard.body?.data?.assets?.appsOnline === 0 && demoBoard.body.data.funnel.exposed === 0,
      JSON.stringify(demoBoard.body?.error ?? demoBoard.body?.data?.assets))
    const demoOverview = await g(demoBase, '/api/panel/rd/overview')
    check('01门演示态：overview 端点不 500（名册/审批面空聚合降级）', demoOverview.status === 200, JSON.stringify(demoOverview.body?.error))
    const demoModels = await g(demoBase, '/api/panel/models')
    check('01门演示态：模型目录 → 503 DEGRADED（能力类端点诚实降级，非 500）',
      demoModels.status === 503 && demoModels.body?.error?.code === 'DEGRADED', JSON.stringify(demoModels.body))
    const demoIndustries = await g(demoBase, '/api/panel/industries')
    check('01门演示态：行业三态 200（scenegraphs 硬依赖在场 → 图谱面可用）', demoIndustries.status === 200, JSON.stringify(demoIndustries.body?.error))
    const demoWriteMsg = await g(demoBase, '/api/panel/rd/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '演示写入' }) })
    check('01门演示态：POST 写动词 → 403 DEMO_READONLY（写边界=GET/HEAD/OPTIONS）',
      demoWriteMsg.status === 403 && demoWriteMsg.body?.error?.code === 'DEMO_READONLY', JSON.stringify(demoWriteMsg.body))
    const demoPutWidgets = await g(demoBase, '/api/panel/rd/widgets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ widgets: [] }) })
    check('01门演示态：PUT 写动词 → 403 DEMO_READONLY', demoPutWidgets.status === 403 && demoPutWidgets.body?.error?.code === 'DEMO_READONLY', JSON.stringify(demoPutWidgets.body))
    const demoDelete = await g(demoBase, '/api/panel/models/none', { method: 'DELETE' })
    check('01门演示态：DELETE 写动词 → 403 DEMO_READONLY（写边界优先于能力 503）',
      demoDelete.status === 403 && demoDelete.body?.error?.code === 'DEMO_READONLY', JSON.stringify(demoDelete.body))
    const demoStream = await fetch(`${demoBase}/api/panel/stream?dept=rd&token=whatever`).then((r) => r.json().catch(() => null))
    check('01门演示态：SSE ?token= 自校验失败（验收断言：前端 30s 轮询承接）',
      demoStream?.error?.code === 'STREAM_AUTH_FAILED', JSON.stringify(demoStream))
  }

  // ================================================================ 01门装态钉钉面：dws CLI 登录授权面
  section('钉钉 dws CLI 桥（01门装态：登录授权面 / 设备流解析 / 未登录激活指令）')

  section('钉钉 dws CLI 桥（01门装态：登录授权面 / 设备流解析 / 未登录激活指令）')
  {
    // 解析器直测（纯函数；样本取自 dws v1.0.61 真实输出，含盒线噪声字符）
    const sample = [
      '● Step 1: Requesting device authorization code...',
      '  ╭──────────────╮',
      '  │    link: https://login.dingtalk.com/oauth2/device/verify.htm   │',
      '  │    authorization code: VSGN-KGWV   │',
      '  │  Or open the following link:   │',
      '  │    https://login.dingtalk.com/oauth2/device/verify.htm?user_code=VSGN-KGWV   │',
      '  │  Authorization code will expire in 900 seconds.   │',
      '  ╰──────────────╯',
    ].join('\n')
    const info = dwsParseDeviceFlow(sample)
    check('dws 设备流解析：link/userCode/verifyUrl/有效期全提取',
      info.link === 'https://login.dingtalk.com/oauth2/device/verify.htm'
      && info.userCode === 'VSGN-KGWV'
      && info.verifyUrl === 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=VSGN-KGWV'
      && info.expiresInSeconds === 900, JSON.stringify(info))
    const partial = dwsParseDeviceFlow('● Step 1: Requesting device authorization code...')
    check('dws 设备流解析：激活指令未到不臆造 verifyUrl', !partial.verifyUrl && !partial.userCode, JSON.stringify(partial))
    const authOk = dwsParseAuthStatus(JSON.stringify({ success: true, authenticated: true, corp_name: '杭州元冰可科技有限公司', user_name: '师圆圆', user_id: '213626652923846088', expires_at: '2026-09-11T23:30:34' }))
    check('dws auth status 解析：已登录态全字段提取',
      authOk.authenticated === true && authOk.corpName === '杭州元冰可科技有限公司' && authOk.userName === '师圆圆', JSON.stringify(authOk))
    const authBad = dwsParseAuthStatus('dws: command not found')
    check('dws auth status 解析：异常输出诚实降级为未登录（不粉饰）',
      authBad.authenticated === false && Boolean(authBad.raw), JSON.stringify(authBad))

    // E2E（iam+authn+panel 三件套 gate，dingtalk-bridge 缺席 → ddws 面在场）：真实登录 token 走授权面
    const ddGate = new Context()
    const ddDir = join('data-selftest', 'gate01-ddws-7397')
    await mkdir(ddDir, { recursive: true })
    // 基线种子口令取 ADMIN_PASSWORD env（DEMO_SEED 的 Ybk@2026 属演示种子，本 gate 不开）；
    // 主实例子进程已在此前 spawn（env 快照隔离），此改动不外溢。
    process.env.ADMIN_PASSWORD = 'Ybk@2026'
    await ddGate.plugin(platformCore, { dataDir: ddDir, http: { port: 7397, host: '127.0.0.1' }, startHttp: true })
    await ddGate.plugin(iam)
    await ddGate.plugin(authn)
    // demoAuth（2026-11-02 合并回归）：01门装态基线管理员种子自 2026-10-29 回植起以 demoAuth
    // 门控（全量形态种子权归 console）——本 gate 无 console，与 cordis.patch.yml 同声明 demoAuth=true，
    // 否则无 admin 可登录（面板自持登录面 401 连锁失败）。
    await ddGate.plugin(panelCore, { demoAuth: true })
    const G3 = 'http://127.0.0.1:7397'
    const g3 = async (method, path, init = {}) => { const r = await fetch(`${G3}${path}`, { method, ...init }); return { status: r.status, body: await r.json().catch(() => null) } }
    let ddToken = ''
    for (let i = 0; i < 40 && !ddToken; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        const login = await g3('POST', '/api/panel/auth/login', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Ybk@2026' }) })
        if (login.body?.data?.token) ddToken = login.body.data.token
      } catch { /* 种子未就绪重试 */ }
    }
    check('ddws gate：panel 命名空间登录成功（iam+authn 基线种子链）', Boolean(ddToken))
    const ddHeaders = { 'content-type': 'application/json', authorization: `Bearer ${ddToken}` }
    const ddSt = await g3('GET', '/api/panel/ddws/status', { headers: ddHeaders })
    check('ddws status：形状完整（installed/bound/auth.authenticated 布尔 + mode）',
      ddSt.status === 200 && typeof ddSt.body?.data?.installed === 'boolean' && typeof ddSt.body?.data?.bound === 'boolean'
      && typeof ddSt.body?.data?.auth?.authenticated === 'boolean' && ddSt.body?.data?.mode === 'dws-cli', JSON.stringify(ddSt.body))
    const ddLogin = await g3('POST', '/api/panel/ddws/login', { headers: ddHeaders, body: '{}' })
    const ddL = ddLogin.body?.data ?? {}
    const ddShape = (ddL.started === true && Boolean(ddL.verifyUrl))
      || (ddL.started === false && ddL.already === true && ddL.auth?.authenticated === true)
      || (ddL.started === false && typeof ddL.message === 'string' && !ddL.already)
    check('ddws login：三态互斥且形状合法（已登录幂等 / 发起带激活指令 / 未装带指引）',
      ddLogin.status === 200 && ddShape, JSON.stringify(ddLogin.body))
    const ddPoll = await g3('GET', '/api/panel/ddws/login', { headers: ddHeaders })
    check('ddws login 轮询：active/authenticated 布尔形状',
      ddPoll.status === 200 && typeof ddPoll.body?.data?.active === 'boolean' && typeof ddPoll.body?.data?.authenticated === 'boolean', JSON.stringify(ddPoll.body))
    const ddCancel = await g3('DELETE', '/api/panel/ddws/login', { headers: ddHeaders })
    check('ddws login 取消：幂等可取消', ddCancel.status === 200 && ddCancel.body?.data?.cancelled === true, JSON.stringify(ddCancel.body))
    const ddNoAuth = await g3('GET', '/api/panel/ddws/login')
    // 无凭证读动词（2026-11-02 合并回归）：demoAuth 装态下只读动词按演示访客放行（demo:true
    // 诚实降级标记，不假装真实数据）——与 cordis.patch.yml 的 01门 装态声明同语义；fail-closed
    // 边界在写动词（下一条断言 403），不在只读。
    check('ddws 面：无凭证 GET → 演示只读（demoAuth 诚实降级 demo:true）',
      ddNoAuth.status === 200 && ddNoAuth.body?.data?.demo === true, JSON.stringify(ddNoAuth.body))
    const ddNoAuthWrite = await g3('POST', '/api/panel/ddws/login', { headers: { 'content-type': 'application/json' }, body: '{}' })
    check('ddws 面：无凭证写动词 → 403 fail-closed（demoAuth 只读边界）', ddNoAuthWrite.status === 403, JSON.stringify(ddNoAuthWrite.body))
    await rm(ddDir, { recursive: true, force: true }).catch(() => {})
  }

  section('凭证零进平台（红线一 · T-24 全目录扫描）')
  // SIGTERM 触发 main.ts 的 flushNow（把内存中的待写集合全部原子落盘）后退出，
  // 再扫描数据目录——保证连「尚未刷盘的最新写入」也在扫描覆盖之内。
  proc.kill('SIGTERM')
  let stopped = false
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    try { await fetch(`${BASE}/api/health`); } catch { stopped = true; break }
  }
  if (!stopped) proc.kill('SIGKILL')
  const bannedSecrets = ['ghp_selftestSecret123', 'client-supersecret-oauth-xyz', ...new Set(ocMintedValues)]
  const bannedHits = []
  const walkFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walkFiles(join(dir, entry.name)) : [join(dir, entry.name)])
  let dataFiles = []
  try { dataFiles = walkFiles(DATA_DIR) } catch { /* 目录已被清理则跳过扫描 */ }
  for (const file of dataFiles) {
    try {
      const text = readFileSync(file).toString('latin1')
      for (const secret of bannedSecrets) {
        if (text.includes(secret)) bannedHits.push({ file: file.split(/[\\/]/).slice(-2).join('/'), secret })
      }
    } catch { /* 二进制读失败跳过 */ }
  }
  check(`T-24 数据目录 ${dataFiles.length} 个文件全部扫描`, dataFiles.length > 5, `files=${dataFiles.length}`)
  check('T-24 凭证原文零命中（API Key / OAuth client secret / 每个一次性 oct_ 值）',
    bannedHits.length === 0 && ocMintedValues.length >= 3, JSON.stringify(bannedHits))

  // ================================================================ 启动健壮性探针（W2）
  // 纯进程内：双实例断言 / 插件树体检 / 错误文案 / 良性败者豁免。不占端口、不写数据目录。
  section('启动健壮性探针（W2）')
  {
    const ROOT_KEY = Symbol.for('ybkk.cordis.root')
    const clearRoot = () => Reflect.deleteProperty(globalThis, ROOT_KEY)
    // ① 正常路径：提供者 + 注入消费者，probeTree 应全绿
    const okCtx = new Context()
    platformCore.assertSingleRoot(okCtx)
    await okCtx.plugin((ctx) => ctx.provide('iam', { source: 'selftest' }))
    await okCtx.plugin({ inject: ['iam'], apply: () => {} })
    const okHealth = platformCore.probeTree(okCtx, ['iam'])
    check('W2 正常装配 probeTree ok:true',
      okHealth.ok === true && okHealth.unreachable.length === 0 && okHealth.stuck.length === 0,
      JSON.stringify(okHealth))
    clearRoot()

    // ② 故障注入：另一 root Context 注册 iam → 当前 ctx 永不可达，消费者 fiber 静默 PENDING（根因形态）
    const badCtx = new Context()
    const otherRoot = new Context()
    await otherRoot.plugin((ctx) => ctx.provide('iam', { source: 'other-root' }))
    badCtx.plugin({ inject: ['iam'], apply: () => {} })
    const badHealth = platformCore.probeTree(badCtx, ['iam'])
    check('W2 双实例注入 probeTree 报 iam 不可达',
      !badHealth.ok && badHealth.unreachable.includes('iam')
        && badHealth.stuck.some((f) => f.state === 'PENDING' && f.waiting.includes('iam')),
      JSON.stringify(badHealth))
    const badText = platformCore.formatTreeHealth(badHealth)
    check('W2 formatTreeHealth 输出可读（拒绝启动 + 卡死插件 + 等待键）',
      badText.includes('插件树未健康') && badText.includes('PENDING') && badText.includes('iam'),
      badText)
    clearRoot()

    // ③ 污染 globalThis → assertSingleRoot 必须抛「双实例」
    globalThis[ROOT_KEY] = { polluted: true }
    let probeThrew = null
    try { platformCore.assertSingleRoot(new Context()) } catch (error) { probeThrew = error }
    check('W2 污染 globalThis 后 assertSingleRoot 抛「双实例」',
      probeThrew instanceof Error && probeThrew.message.includes('双实例'), String(probeThrew))
    clearRoot()

    // ④ 用例后清理污染：恢复登记能力，且不残留 globalThis 键
    let afterClean = null
    const recoverCtx = new Context()
    try { platformCore.assertSingleRoot(recoverCtx) } catch (error) { afterClean = error }
    check('W2 用例后清理 globalThis 污染（恢复登记）',
      afterClean === null && globalThis[ROOT_KEY] === recoverCtx.root, String(afterClean))
    clearRoot()

    // ⑤ 附加（固化门禁偏离语义）：双注册习语的良性败者（声明 provide 已被其他 ACTIVE fiber
    //    接管）不拦启动，仅入诊断清单——panel-core/flow-core 当前习语下 W2 必须放行
    const decoyCtx = new Context()
    platformCore.assertSingleRoot(decoyCtx)
    const decoy = (ctx) => ctx.provide('iam', { source: 'decoy' })
    decoy.provide = 'iam'
    await decoyCtx.plugin({
      name: 'decoy-module',
      apply(ctx) {
        ctx.plugin(decoy)
        ctx.provide('iam', { source: 'module' })
      },
    })
    const decoyHealth = platformCore.probeTree(decoyCtx, ['iam'])
    check('W2 良性败者 fiber（provide 已接管）不拦启动',
      decoyHealth.ok === true
        && decoyHealth.stuck.some((f) => f.state === 'FAILED' && f.blocking === false),
      JSON.stringify(decoyHealth))
    clearRoot()
  }

  // Windows 句柄纪律（2026-11-02 合并回归）：SQLite 连接持有 .db/.db-shm/.db-wal 句柄，
  // 同进程未 close 就 rm 目录必 EBUSY（Linux 无此约束，上游 CI 不可见）。每个用完的
  // StorageService 先 flushNow + 关闭 sqliteBackend（TS private 编译后仍可访问），再删目录；
  // 子进程目录则等待句柄释放后重试。定义在存储分节之外，收尾 finally 亦复用。
  const closeStorageSvc = async (svc) => {
    // 与 storage.ts ctx.effect 清理同序：先停防抖计时器，再落盘，最后关库——
    // 颠倒会让挂起的 flushTimer 在关库后触发（「database is not open」迟到 rejection）
    try { if (svc?.flushTimer) { clearTimeout(svc.flushTimer); svc.flushTimer = undefined } } catch { /* 忽略 */ }
    try { await svc?.flushNow?.() } catch { /* 忽略 */ }
    try { svc?.sqliteBackend?.close?.() } catch { /* 忽略 */ }
  }
  const rmDirWin = async (dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })

  // ================================================================ 存储 SQLite 后端契约（ADR-0001 第一期）
  // 主实例全程跑默认 json 后端；本节单独验证 sqlite 后端：与 json 的契约对拍、
  // 引擎级唯一索引、JSON 回填幂等、后端开关环境变量、平台级 kill -9 零丢失。
  section('存储 SQLite 后端契约（ADR-0001）')
  {
    const storageJsonDir = `${DATA_DIR}-storage-json`
    const storageSqliteDir = `${DATA_DIR}-storage-sqlite`
    const priorStorage = process.env.PLATFORM_STORAGE
    const priorKeep = process.env.PLATFORM_STORAGE_JSON_KEEP

    // ---- 1. 双后端同序列对拍：Collection<T> 契约一致性（插件零感知的硬保证）----
    const runContract = async (backend) => {
      const dir = backend === 'json' ? storageJsonDir : storageSqliteDir
      await rm(dir, { recursive: true, force: true })
      const svc = new platformCore.StorageService(new Context(), { dataDir: dir, backend })
      const col = svc.collection('ct:items')
      const out = { events: [] }
      const off = col.onChange((change) => out.events.push(`${change.kind}:${change.record?.id ?? ''}`))
      out.insert = col.insert({ id: 'x1', kind: 'a', tag: 'T', createdAt: '2026-01-01T00:00:00.000Z' })
      out.dupIdError = (() => { try { col.insert({ id: 'x1', kind: 'a' }); return '' } catch (error) { return error.message } })()
      col.uniqueOn('tag', (record) => record.tag ?? '')
      out.uniqueError = (() => { try { col.insert({ id: 'x2', kind: 'a', tag: 'T' }); return '' } catch (error) { return error.message } })()
      out.update = col.update('x1', { kind: 'b' })
      col.insert({ id: 'x3', kind: 'c', tag: 'X' })
      out.removed = col.remove('x3')
      out.countAfterRemove = col.count()
      out.findLen = col.find((record) => record.kind === 'b').length
      out.getKind = col.get('x1').kind
      col.replaceAll([{ id: 'r1', kind: 'z', tag: 'R', createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z' }])
      out.countAfterReplace = col.count()
      off()
      await svc.flushNow()
      await closeStorageSvc(svc)
      return out
    }
    const jsonOut = await runContract('json')
    const sqliteOut = await runContract('sqlite')
    check('双后端对拍：insert 返回一致（自定义 createdAt 保留 + updatedAt 注入）',
      sqliteOut.insert.createdAt === jsonOut.insert.createdAt && Boolean(sqliteOut.insert.updatedAt) === Boolean(jsonOut.insert.updatedAt))
    check('双后端对拍：重复 id 抛错文案逐字一致', sqliteOut.dupIdError === jsonOut.dupIdError && jsonOut.dupIdError.includes('已存在'), JSON.stringify({ json: jsonOut.dupIdError, sqlite: sqliteOut.dupIdError }))
    check('双后端对拍：uniqueOn 冲突抛错文案逐字一致', sqliteOut.uniqueError === jsonOut.uniqueError && jsonOut.uniqueError.includes('唯一约束冲突'))
    check('双后端对拍：update 字段合并 + createdAt 保持', sqliteOut.update.kind === 'b' && sqliteOut.update.createdAt === '2026-01-01T00:00:00.000Z')
    check('双后端对拍：remove/count/find/get/replaceAll 结果一致',
      sqliteOut.removed === jsonOut.removed && sqliteOut.countAfterRemove === jsonOut.countAfterRemove
      && sqliteOut.findLen === jsonOut.findLen && sqliteOut.getKind === jsonOut.getKind
      && sqliteOut.countAfterReplace === jsonOut.countAfterReplace,
      JSON.stringify({ json: { c: jsonOut.countAfterRemove, f: jsonOut.findLen, r: jsonOut.countAfterReplace }, sqlite: { c: sqliteOut.countAfterRemove, f: sqliteOut.findLen, r: sqliteOut.countAfterReplace } }))
    check('双后端对拍：onChange 事件序列一致（authn:tokens 吊销广播语义不变的前提）',
      sqliteOut.events.join('|') === jsonOut.events.join('|') && sqliteOut.events.length === 5, JSON.stringify({ json: jsonOut.events, sqlite: sqliteOut.events }))

    // ---- 2. sqlite 引擎级唯一索引（「一人一号」红线的执行方式：非应用层扫描）----
    const engineDir = `${DATA_DIR}-storage-engine`
    await rm(engineDir, { recursive: true, force: true })
    {
      const svc = new platformCore.StorageService(new Context(), { dataDir: engineDir, backend: 'sqlite' })
      const col = svc.collection('ct:uniq')
      col.insert({ id: 'a1', tag: 'K' })
      col.uniqueOn('tag', (record) => record.tag ?? '')
      let engineRejected = false
      try { col.insert({ id: 'a2', tag: 'K' }) } catch { engineRejected = true }
      check('引擎级唯一：绕过「先查后插」的重复键写入被索引拒绝', engineRejected)
      col.insert({ id: 'a3', tag: 'K3' })
      let stealRejected = false
      try { col.update('a3', { tag: 'K' }) } catch { stealRejected = true }
      check('引擎级唯一：update 抢占他人键被拒（自身键除外）', stealRejected)
      await closeStorageSvc(svc)
    }
    {
      const svc2 = new platformCore.StorageService(new Context(), { dataDir: engineDir, backend: 'sqlite' })
      await svc2.restoreAll()
      check('sqlite 事务提交后重启恢复（已提交写入零丢失）', svc2.collection('ct:uniq').count() === 2, `count=${svc2.collection('ct:uniq').count()}`)
      await closeStorageSvc(svc2)
      await rmDirWin(engineDir)
    }

    // ---- 3. JSON → SQLite 首启自动回填（幂等 + DB 为准 + JSON 保留为回滚源）----
    {
      const dir = `${DATA_DIR}-storage-backfill`
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      const legacy = [
        { id: 'l1', name: '旧一', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'l2', name: '旧二', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ]
      writeFileSync(join(dir, 'ct~legacy.json'), JSON.stringify(legacy))
      const svc = new platformCore.StorageService(new Context(), { dataDir: dir, backend: 'sqlite' })
      await svc.restoreAll()
      check('首启回填：同名 JSON 集合文件自动导入 SQLite', svc.collection('ct:legacy').count() === 2 && svc.collection('ct:legacy').get('l2').name === '旧二')
      svc.collection('ct:legacy').update('l1', { name: 'DB新值' })
      const svc2 = new platformCore.StorageService(new Context(), { dataDir: dir, backend: 'sqlite' })
      await svc2.restoreAll()
      check('二次启动：DB 为准（修改后记录不被旧 JSON 回灌）', svc2.collection('ct:legacy').get('l1').name === 'DB新值' && svc2.collection('ct:legacy').count() === 2)
      check('回滚源保留：JSON 文件内容未被删除或改写', JSON.parse(readFileSync(join(dir, 'ct~legacy.json'), 'utf8'))[0].name === '旧一')
      await closeStorageSvc(svc)
      await closeStorageSvc(svc2)
      await rmDirWin(dir)
    }

    // ---- 4. 后端开关与环境变量（默认 json 向后兼容）----
    {
      const dir = `${DATA_DIR}-storage-env`
      await rm(dir, { recursive: true, force: true })
      process.env.PLATFORM_STORAGE = 'sqlite'
      process.env.PLATFORM_STORAGE_JSON_KEEP = 'ct:keep*'
      const svc = new platformCore.StorageService(new Context(), { dataDir: dir })
      check('PLATFORM_STORAGE=sqlite：常规集合走 SqliteCollectionImpl', svc.collection('ct:direct').constructor.name === 'SqliteCollectionImpl')
      check('PLATFORM_STORAGE_JSON_KEEP：例外名单集合保留 JSON 实现', svc.collection('ct:keepme').constructor.name === 'CollectionImpl')
      process.env.PLATFORM_STORAGE = 'not-a-backend'
      check('未知 PLATFORM_STORAGE 值：告警回退 json 不崩', new platformCore.StorageService(new Context(), { dataDir: dir }).backend === 'json')
      delete process.env.PLATFORM_STORAGE
      check('默认（未设置）：backend=json 向后兼容', new platformCore.StorageService(new Context(), { dataDir: dir }).backend === 'json')
      if (priorStorage === undefined) delete process.env.PLATFORM_STORAGE; else process.env.PLATFORM_STORAGE = priorStorage
      if (priorKeep === undefined) delete process.env.PLATFORM_STORAGE_JSON_KEEP; else process.env.PLATFORM_STORAGE_JSON_KEEP = priorKeep
      await closeStorageSvc(svc)
      await rmDirWin(dir)
    }

    // ---- 5. 平台级 kill -9 零丢失（隔离子实例 · PLATFORM_STORAGE=sqlite）----
    {
      const dir = `${DATA_DIR}-storage-platform`
      const port = (await freePort()) ?? 7322
      const base = `http://127.0.0.1:${port}`
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      // 预置遗留 JSON 集合：同时验证「回填 → 插件读取 → REST API」全链路
      writeFileSync(join(dir, 'iam~roles.json'), JSON.stringify([
        { id: 'role_legacy1', code: 'legacy_one', name: '遗留角色一', permissions: ['iam.user.read'], builtin: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'role_legacy2', code: 'legacy_two', name: '遗留角色二', permissions: ['iam.user.read'], builtin: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ]))
      const childEnv = { ...process.env, PLATFORM_STORAGE: 'sqlite', ADMIN_PASSWORD: 'Ybk@2026' }
      const spawnInstance = () => spawn(process.execPath, ['src/main.ts', '--port', String(port), '--data', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv })
      const waitReady = async () => {
        for (let i = 0; i < 60; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          try {
            const res = await fetch(`${base}/api/overview`)
            if (res.status === 401 || res.status === 200) return true
          } catch { /* 未就绪 */ }
        }
        return false
      }
      const login = async (username, password) => {
        const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }).then((r) => r.json())
        return res.ok ? res.data.token : ''
      }
      let child = spawnInstance()
      check('SQLite 子实例启动（PLATFORM_STORAGE=sqlite 透传到 main.ts）', await waitReady())
      const token = await login('admin', 'Ybk@2026')
      check('SQLite 子实例 admin 登录', Boolean(token))
      const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      const rolesBefore = await fetch(`${base}/api/iam/roles`, { headers: { authorization: auth.authorization } }).then((r) => r.json())
      check('遗留 JSON 角色回填后 API 可见（回填 → 插件 → REST 全链路）',
        rolesBefore.ok && rolesBefore.data.roles.filter((role) => String(role.id).startsWith('role_legacy')).length === 2,
        JSON.stringify(rolesBefore.data?.roles?.map((role) => role.id)))
      const orgs = await fetch(`${base}/api/iam/orgs`, { headers: { authorization: auth.authorization } }).then((r) => r.json())
      const orgId = Array.isArray(orgs.data) ? orgs.data[0]?.id : orgs.data?.orgs?.[0]?.id
      const created = await fetch(`${base}/api/iam/users`, { method: 'POST', headers: auth, body: JSON.stringify({ username: 'sqlitekill9', displayName: 'kill9 持久化验证', orgId }) }).then((r) => r.json())
      check('SQLite 后端创建账号成功（写入即事务提交）', created.ok && typeof created.data.initialPassword === 'string', JSON.stringify(created.error))

      child.kill('SIGKILL') // 模拟断电级死亡：无 flushNow、无优雅退出
      await new Promise((resolve) => setTimeout(resolve, 800))
      child = spawnInstance()
      check('kill -9 后子实例重启', await waitReady())
      const token2 = await login('admin', 'Ybk@2026')
      const relogin = await login('sqlitekill9', created.data.initialPassword)
      check('kill -9 零丢失：崩溃前创建的账号可登录（凭证哈希完整）', Boolean(token2) && Boolean(relogin))
      const rolesAfter = await fetch(`${base}/api/iam/roles`, { headers: { authorization: `Bearer ${token2}` } }).then((r) => r.json())
      check('kill -9 零丢失：回填的角色数据完整', rolesAfter.ok && rolesAfter.data.roles.filter((role) => String(role.id).startsWith('role_legacy')).length === 2)
      child.kill('SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 500)) // Windows：子进程句柄释放略有延迟
      await rmDirWin(dir).catch(() => {})
    }

    // ---- 6. 默认 JSON 豁免名单（QA W4 缺口①：ADR-0001 §五第 3 批在 sqlite 后端下默认生效）----
    {
      const dir = `${DATA_DIR}-storage-keep-default`
      await rm(dir, { recursive: true, force: true })
      const priorKeepLocal = process.env.PLATFORM_STORAGE_JSON_KEEP
      try {
        delete process.env.PLATFORM_STORAGE_JSON_KEEP
        // 默认名单生效（环境变量未设置）：第三批低频配置集合保留 JSON，其余集合走 sqlite
        const svc = new platformCore.StorageService(new Context(), { dataDir: dir, backend: 'sqlite' })
        const kindOf = (name) => svc.collection(name).constructor.name
        check('DEFAULT_JSON_KEEP 默认名单：第 3 批集合（market:*/update:state/resource:dependencies/iam:groupSnapshots）默认保留 JSON',
          kindOf('market:demo') === 'CollectionImpl' && kindOf('update:state') === 'CollectionImpl'
          && kindOf('resource:dependencies') === 'CollectionImpl' && kindOf('iam:groupSnapshots') === 'CollectionImpl',
          JSON.stringify({ market: kindOf('market:demo'), update: kindOf('update:state'), resource: kindOf('resource:dependencies'), snapshot: kindOf('iam:groupSnapshots') }))
        check('DEFAULT_JSON_KEEP 默认名单：名单外集合仍走 sqlite', kindOf('ct:regular') === 'SqliteCollectionImpl', kindOf('ct:regular'))
        // 显式环境变量完全覆盖默认名单（空串 = 一个都不豁免，语义见 parseKeepEnv 注释）
        process.env.PLATFORM_STORAGE_JSON_KEEP = ''
        const svc2 = new platformCore.StorageService(new Context(), { dataDir: dir, backend: 'sqlite' })
        check('PLATFORM_STORAGE_JSON_KEEP 显式空串：完全覆盖默认名单（全部集合走 sqlite）',
          svc2.collection('market:demo').constructor.name === 'SqliteCollectionImpl' && svc2.collection('iam:groupSnapshots').constructor.name === 'SqliteCollectionImpl')
        // 显式名单同样整体覆盖默认（不与默认名单叠加）
        process.env.PLATFORM_STORAGE_JSON_KEEP = 'iam:groupSnapshots'
        const svc3 = new platformCore.StorageService(new Context(), { dataDir: dir, backend: 'sqlite' })
        check('PLATFORM_STORAGE_JSON_KEEP 显式名单：仅豁免名单内集合（market:demo 走 sqlite）',
          svc3.collection('iam:groupSnapshots').constructor.name === 'CollectionImpl' && svc3.collection('market:demo').constructor.name === 'SqliteCollectionImpl')
        await closeStorageSvc(svc)
        await closeStorageSvc(svc2)
        await closeStorageSvc(svc3)
      } finally {
        if (priorKeepLocal === undefined) delete process.env.PLATFORM_STORAGE_JSON_KEEP; else process.env.PLATFORM_STORAGE_JSON_KEEP = priorKeepLocal
      }
      await rmDirWin(dir)
    }

    // ---- 7. sqlite 后端 iam「一人一号」攻击演练（QA W4 缺口③）----
    // 进程内最小插件树（同 dsh 宿主挂载分节先例）：sqlite 后端 + iam + authn；
    // platformCore 装配期经 PLATFORM_STORAGE 环境变量取后端（PlatformCoreConfig 无 backend 字段），
    // 故本子块以 try/finally 自持环境变量恢复，不动既有 priorStorage/priorKeep 机制。
    {
      const dir = `${DATA_DIR}-storage-iam-attack`
      await rm(dir, { recursive: true, force: true })
      const priorStorageLocal = process.env.PLATFORM_STORAGE
      try {
        process.env.PLATFORM_STORAGE = 'sqlite'
        const atkCtx = new Context()
        await atkCtx.plugin(platformCore, { dataDir: dir, http: { port: 0 }, startHttp: false })
        await atkCtx.plugin(iam)
        await atkCtx.plugin(authn)
        const org = atkCtx.iam.createOrg({ name: 'sqlite 攻击演练组织' }, iam.SYSTEM_ACTOR)
        const { user } = atkCtx.iam.createUser({ username: 'atk_link_user', displayName: '一人一号演练', orgId: org.id }, iam.SYSTEM_ACTOR)
        const atkProfile = (corpId) => ({ provider: 'dingtalk', providerUserId: 'atk-ding-1', corpId, displayName: `绑定@${corpId}` })

        // 7.1 引擎拒绝二次绑定：同 provider + providerUserId + corpId（identity_link_active 唯一键）
        atkCtx.iam.linkIdentity(user.id, atkProfile('corpA'), 'selftest')
        let secondError = ''
        try { atkCtx.iam.linkIdentity(user.id, atkProfile('corpA'), 'selftest') } catch (error) { secondError = error.message }
        check('sqlite iam：同 provider+providerUserId+corpId 二次绑定被引擎拒绝（唯一约束冲突）', secondError.includes('唯一约束冲突'), secondError)

        // 7.2 corpId 维度：同三方身份跨主体是不同键，放行（钉钉 unionId 跨企业同人语义）
        let crossCorpOk = true
        try { atkCtx.iam.linkIdentity(user.id, atkProfile('corpB'), 'selftest') } catch { crossCorpOk = false }
        check('sqlite iam：同三方身份跨 corpId 绑定放行（唯一键含 corpId 维度）', crossCorpOk)

        // 7.3 同 tick 连发（Promise.all）重复插入：恰一条成功、其余真实被 UNIQUE INDEX 拒绝
        //（node:sqlite 同步执行,经 Promise.resolve().then 入微任务队列连发,拒绝由 allSettled 收集）
        const burst = await Promise.allSettled(Array.from({ length: 6 }, () => Promise.resolve().then(() =>
          atkCtx.iam.linkIdentity(user.id, { provider: 'feishu', providerUserId: 'atk-fs-1', corpId: 'corpA', displayName: '连发绑定' }, 'selftest'))))
        const burstOk = burst.filter((r) => r.status === 'fulfilled').length
        const burstRejected = burst.filter((r) => r.status === 'rejected' && String(r.reason?.message ?? r.reason).includes('唯一约束冲突')).length
        check('sqlite iam：同 tick 连发 6 次重复绑定恰一条成功、其余被唯一索引拒绝（引擎级一人一号）',
          burstOk === 1 && burstRejected === 5, JSON.stringify({ ok: burstOk, rejected: burstRejected }))

        // 7.4 绕过服务层直插集合同键记录：仍被拒（红线在引擎约束而非应用层检查的证据）
        let bypassRejected = false
        try {
          atkCtx.opsStorage.collection('iam:identityLinks').insert({
            id: 'idl_bypass', provider: 'dingtalk', providerUserId: 'atk-ding-1', corpId: 'corpA',
            userId: user.id, displayName: '旁路插入', linkedAt: new Date().toISOString(), linkedBy: 'attacker',
          })
        } catch { bypassRejected = true }
        check('sqlite iam：绕过服务层直插 identityLinks 同键记录被唯一索引拒绝', bypassRejected)

        // 7.5 authn 侧：签发 refresh 会话后轮转成功（onChange insert 事件已驱动 refreshIndex）
        const principal = atkCtx.authn.ensureHumanPrincipal(user.id, '一人一号演练')
        const session = atkCtx.authn.issueSessionPair(principal.id, { issuedBy: 'selftest-attack' })
        const rotated = atkCtx.authn.refreshSession(session.refreshToken)
        check('sqlite authn：refresh 轮转成功（tokens 集合 onChange insert 事件已维护 refreshIndex）', Boolean(rotated.refreshToken))

        // 7.6 吊销广播：吊销全部令牌后，带 revokedAt 的 update 事件经 sqlite 事务提交送达 onChange
        const revocationEvents = []
        const offTokens = atkCtx.opsStorage.collection('authn:tokens').onChange((change) => {
          if (change.kind === 'update' && change.record?.revokedAt) revocationEvents.push(change.record.jti)
        })
        const revokedCount = atkCtx.authn.revokePrincipalTokens(principal.id, '演练吊销')
        offTokens()
        let revokedRefreshError = ''
        try { atkCtx.authn.refreshSession(rotated.refreshToken) } catch (error) { revokedRefreshError = error.message }
        check('sqlite authn：吊销广播在 sqlite 事务提交后仍经 onChange 送达（逐条 update 事件携带 revokedAt）',
          revokedCount >= 3 && revocationEvents.length === revokedCount, `revoked=${revokedCount} events=${revocationEvents.length}`)
        check('sqlite authn：吊销后 refresh 被拒（吊销语义跨后端不降级）', revokedRefreshError.includes('吊销'), revokedRefreshError)

        try { await atkCtx.dispose?.() } catch { /* 裸 Context 无 dispose（cordis 实测），仅防御性调用 */ }
        // Windows 句柄纪律（2026-11-02 合并回归）：本段插件树（iam 自动同步 60s 巡检等定时器）
        // 在裸 Context 上无法整体关停——关库会让存活定时器持续打已关的 SQLite（「database is
        // not open」洪流），删目录则 EBUSY。正确处置：不关库、不删目录，定时器已 unref，
        // 进程退出时句柄随 OS 释放；目录由下次运行的段首 rm 自清（跨进程无锁）。
      } finally {
        if (priorStorageLocal === undefined) delete process.env.PLATFORM_STORAGE; else process.env.PLATFORM_STORAGE = priorStorageLocal
      }
    }

    await rmDirWin(storageJsonDir)
    await rmDirWin(storageSqliteDir)
    await rmDirWin(engineDir)
  }

} finally {
  // ---------------------------------------------------------------- 收尾
  console.log('\n\x1b[90m» 停止测试实例…\x1b[0m')
  // 收尾看门狗（2026-11-02 合并回归）：任何收尾 await 悬停都不得吞掉汇总与退出码——
  // 30s 未走完即放弃剩余清理直接跳到汇总（清理本是尽力而为，进程退出后 OS 回收句柄；
  // Windows 上进程内台架的存活巡检持续写入令目录 rm 重试常超 15s，30s 覆盖正常慢而不放无限等）。
  const FINISH = Symbol('cleanup-watchdog')
  const watchdog = new Promise((resolve) => setTimeout(() => resolve(FINISH), 30_000))
  const cleanup = (async () => {
    proc.kill('SIGKILL')
    // stub 关闭防线（2026-11-02 合并回归）：server.close() 会等待在途/长连接（selftest 进程内
    // undici keep-alive、上游慢响应），Node 19+ 的 close 不再主动断空闲 keep-alive——先
    // closeAllConnections 强断，再给 3s 超时兜底，避免收尾悬停吞掉汇总输出与退出码。
    const closeStub = async (stub) => {
      try { stub.closeAllConnections?.() } catch { /* 旧 Node 无此 API */ }
      await Promise.race([
        new Promise((resolve) => { try { stub.close(resolve) } catch { resolve() } }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ])
    }
    console.log('\x1b[90m» 收尾：关 stub…\x1b[0m')
    await closeStub(ghStub)
    await closeStub(nasGwStub)
    await closeStub(ocStub)
    console.log('\x1b[90m» 收尾：清理数据目录…\x1b[0m')
    // Windows：子进程句柄（含 SQLite WAL）释放略有延迟，rm 需等待+重试（EBUSY 防线）。
    //  retries 压到 3×200ms（2026-11-02 实证）：进程内 ddws/workforce 台架（裸 Context 无 dispose）
    //  的 60s 巡检定时器持续向 DATA_DIR 写入，10×300ms 的重试每次都撞上新内容、走完超 15s——
    //  清不干净就留给下次运行的启动 rm（跨进程无锁必净），收尾不容许拖住退出码。
    await new Promise((resolve) => setTimeout(resolve, 800))
    await rm(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {})
    console.log('\x1b[90m» 收尾：完成\x1b[0m')
  })()
  const finished = await Promise.race([cleanup, watchdog])
  if (finished === FINISH) console.log('\x1b[33m! 收尾看门狗超时（30s）：剩余清理放弃（不影响断言结果与退出码）\x1b[0m')
}

// ================================================================ 断言数自校验（落地页对外承诺）
// 落地页写「N assertions green」，N 必须等于本次实际断言总数。本条自身也计入 results，
// 因此比较对象是 results.length + 1。断言数随每次新增断言变化，这是唯一不会说谎的口径。
section('落地页对外数字（与本次实际断言数自校验）')
{
  const { readFileSync: readLaunch } = await import('node:fs')
  const { join: joinPath } = await import('node:path')
  const launchHtml = readLaunch(joinPath(process.cwd(), 'packages/plugin-console/public/launch/index.html'), 'utf8')
  const claimed = Number(launchHtml.match(/<b>(\d+)<\/b><span>assertions green<\/span>/)?.[1] ?? NaN)
  const actual = results.length + 1
  check(`落地页断言数 ${Number.isNaN(claimed) ? '缺失' : claimed} = 本次实际断言总数 ${actual}（断言数防漂移）`,
    claimed === actual, `落地页=${claimed} 实际=${actual}`)
}


// ================================================================ 汇总
const failed = results.filter((item) => !item.pass)
console.log(`\n${'━'.repeat(46)}`)
console.log(`  \x1b[1m自测结果：${results.length - failed.length}/${results.length} 通过\x1b[0m`)
if (failed.length > 0) {
  console.log(`\n  \x1b[31m失败项：\x1b[0m`)
  for (const item of failed) {
    console.log(`   ✘ [${item.section}] ${item.name}`)
  }
  process.exit(1)
} else {
  console.log('  \x1b[32m全部通过 ✔\x1b[0m')
  process.exit(0)
}
