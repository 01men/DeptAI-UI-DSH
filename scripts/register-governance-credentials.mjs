#!/usr/bin/env node
/**
 * register-governance-credentials.mjs —— AI 自治治理双身份凭证一键签发（对齐 register-dsh-app.mjs 惯例）。
 *
 * 平台自身即 MCP 服务（POST /mcp，与 REST 同一套权限体系）。AI 接管平台的推荐形态是
 * 「双身份」而非单把万能钥匙：登记/提交与评审/决策分离成两个机器主体，让 agent.online
 * 类审批的 R12 职责分离（提交人≠审批人）在自治链路里依然成立：
 *   ① ybkk-gov-operator  治理执行官：scopes=['*']（全链路登记/提交/部署/管理）
 *   ② ybkk-gov-reviewer  治理评审官：approval.read/decide + agent.read + mcp.service.read + audit.read
 *     （只读 + 审批决策；除 agent.online 的 R12 外，其余类型审批同人放行，由双身份提供纵深）
 *
 * 幂等可重跑：
 *   ① 按名称幂等查重（GET /api/authn/principals），已存在则复用不重建
 *   ② 不存在 → 经 POST /mcp authn_credential_create 签发（发凭证本身走 MCP 面，验证自举通道）
 *   ③ --rotate 时对已存在主体走 rotate-secret 轮换（旧 secret 立即失效）
 *   ④ client-credentials 换牌自验（/mcp tools/list + reviewer 调 approval_list）
 *   ⑤ 凭证落盘 <data-dir>/governance-credentials.json（0600；secret 仅签发/轮换时出现一次）
 *
 * 用法：
 *   node scripts/register-governance-credentials.mjs --url http://127.0.0.1:7300 \
 *     --data-dir /Users/ybkk/ybkkasi/data
 *   （管理员凭证：DSHCTL_USER/DSHCTL_PASS 或 --user/--pass；已有令牌直接给 DSHCTL_TOKEN）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chmodSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : fallback
}
const BASE_URL = (arg('--url', process.env.DSHCTL_URL ?? 'http://127.0.0.1:7300')).replace(/\/+$/, '')
const OPERATOR_NAME = arg('--operator-name', 'ybkk-gov-operator（治理执行官）')
const REVIEWER_NAME = arg('--reviewer-name', 'ybkk-gov-reviewer（治理评审官）')
const REVIEWER_SCOPES = (arg('--reviewer-scopes', 'approval.read,approval.decide,agent.read,mcp.service.read,audit.read'))
  .split(',').map((s) => s.trim()).filter(Boolean)
const ROTATE = argv.includes('--rotate')
const DATA_DIR = resolve(arg('--data-dir', './data'))
const CRED_FILE = join(DATA_DIR, 'governance-credentials.json')

const log = (msg) => console.log(`[gov-creds] ${msg}`)
const fail = (msg) => { console.error(`[gov-creds] ✘ ${msg}`); process.exit(1) }

async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${BASE_URL}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await response.json() } catch { /* non-json */ }
  return { status: response.status, ok: payload?.ok !== false && response.status < 400, data: payload?.data, error: payload?.error, raw: payload }
}

/** 平台 /mcp JSON-RPC（Streamable HTTP）。 */
async function mcp(token, method, params) {
  const response = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 100000, method, params }),
  })
  return response.json()
}
const toolCall = async (token, name, args) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args })
  if (r.error) fail(`/mcp ${name} → JSONRPC ${r.error.code}: ${r.error.message}`)
  if (r.result?.isError) fail(`/mcp ${name} → ${r.result.content?.[0]?.text}`)
  return JSON.parse(r.result.content[0].text)
}

// ---- ① 管理员身份 ----------------------------------------------------------
let adminToken = process.env.DSHCTL_TOKEN ?? ''
if (adminToken) log('使用 DSHCTL_TOKEN 环境变量令牌')
if (!adminToken) {
  const user = arg('--user', process.env.DSHCTL_USER ?? 'admin')
  const pass = arg('--pass', process.env.DSHCTL_PASS)
  if (!pass) fail('缺少管理员凭证：设置 DSHCTL_PASS（或 --pass），或直接提供 DSHCTL_TOKEN')
  const login = await api('POST', '/api/auth/login', { body: { username: user, password: pass } })
  if (!login.ok) fail(`管理员登录失败：${login.error?.message ?? login.status}（注意：连续失败 5 次触发锁定，勿反复试错）`)
  adminToken = login.data.token
  log(`管理员 ${user} 登录成功`)
}

// ---- ② 幂等查重 ------------------------------------------------------------
const principals = await api('GET', '/api/authn/principals', { token: adminToken })
if (!principals.ok) fail(`读取机器主体台账失败：${principals.error?.message ?? principals.status}`)
const findByName = (name) => (principals.data?.principals ?? []).find((item) => item.name === name)

// 已落盘凭证：仅在未轮换时仍然可用（rotate 后旧 secret 失效）
let saved = {}
if (existsSync(CRED_FILE)) {
  try { saved = JSON.parse(readFileSync(CRED_FILE, 'utf8')) } catch { /* 损坏即重签 */ }
}

const issueOrReuse = async (name, scopes, savedEntry) => {
  const existing = findByName(name)
  if (!existing) {
    log(`${name}：不存在，经 /mcp authn_credential_create 签发（scopes=${scopes.join(',') || '*'}）`)
    const created = await toolCall(adminToken, 'authn_credential_create', { name, scopes })
    return { principalId: created.principalId, clientId: created.clientId, clientSecret: created.clientSecret, rotated: true }
  }
  if (ROTATE) {
    log(`${name}：已存在（${existing.id}），--rotate 轮换 secret（旧 secret 立即失效）`)
    const rotated = await api('POST', `/api/authn/principals/${existing.id}/rotate-secret`, { token: adminToken })
    if (!rotated.ok) fail(`轮换失败：${rotated.error?.message ?? rotated.status}`)
    return { principalId: existing.id, clientId: rotated.data.clientId ?? existing.clientId, clientSecret: rotated.data.clientSecret, rotated: true }
  }
  if (savedEntry?.clientId === existing.clientId && savedEntry?.clientSecret) {
    log(`${name}：已存在且本地凭证匹配（${existing.id}），复用`)
    return { ...savedEntry, rotated: false }
  }
  fail(`${name}：已存在（${existing.id}）但本地无可用 secret。加 --rotate 轮换后取新 secret`)
}

const operator = await issueOrReuse(OPERATOR_NAME, ['*'], saved.operator)
const reviewer = await issueOrReuse(REVIEWER_NAME, REVIEWER_SCOPES, saved.reviewer)

// ---- ③ 换牌自验 ------------------------------------------------------------
const tokenOf = async (cred, label) => {
  const cc = await api('POST', '/api/auth/client-credentials', { body: { clientId: cred.clientId, clientSecret: cred.clientSecret } })
  if (!cc.ok || !cc.data?.token) fail(`${label} 换牌失败：${cc.error?.message ?? JSON.stringify(cc.raw).slice(0, 120)}`)
  return cc.data.token
}
const operatorToken = await tokenOf(operator, 'operator')
const reviewerToken = await tokenOf(reviewer, 'reviewer')

const listed = await mcp(operatorToken, 'tools/list', {})
const toolCount = listed.result?.tools?.length ?? 0
if (toolCount === 0) fail('operator /mcp tools/list 为空，自验不通过')
log(`operator 换牌自验：/mcp tools/list → ${toolCount} 个工具（全权限可见）`)
const pending = await toolCall(reviewerToken, 'approval_list', { status: 'pending' })
log(`reviewer 换牌自验：approval_list → ${pending.total} 条待办（${pending.pending} pending）`)

// ---- ④ 落盘（0600）--------------------------------------------------------
const record = {
  issuedAt: new Date().toISOString(),
  platform: BASE_URL,
  note: "clientSecret 仅签发/轮换时出现一次；--rotate 可轮换。operator=全权治理执行官（scopes=*），reviewer=只读+审批决策（R12 双身份）",
  operator: { name: OPERATOR_NAME, principalId: operator.principalId, clientId: operator.clientId, ...(operator.clientSecret ? { clientSecret: operator.clientSecret } : {}), scopes: ['*'] },
  reviewer: { name: REVIEWER_NAME, principalId: reviewer.principalId, clientId: reviewer.clientId, ...(reviewer.clientSecret ? { clientSecret: reviewer.clientSecret } : {}), scopes: REVIEWER_SCOPES },
}
writeFileSync(CRED_FILE, JSON.stringify(record, null, 2) + '\n')
chmodSync(CRED_FILE, 0o600)
log(`凭证落盘：${CRED_FILE}（0600）`)

// ---- ⑤ 接入配置 -----------------------------------------------------------
const mcpEntry = (label, serverName, envVar, cred) => `    // ${label}${cred.clientSecret ? '' : '（复用已存 secret）'}
    "${serverName}": {
      "url": "${BASE_URL}/mcp",
      "headers": { "Authorization": "Bearer \${${envVar}}" }
    }`
console.log(`
──────────────────────────────────────────────────────────
AI 自治治理双身份已就绪（MCP Server：${BASE_URL}/mcp）

① 先把令牌放进环境（换牌后的 Bearer，直接可用）：
   export YBKK_GOV_TOKEN=<operator 令牌>
   export YBKK_GOV_REVIEW_TOKEN=<reviewer 令牌>
   （或每次经 POST ${BASE_URL}/api/auth/client-credentials 用 clientId/clientSecret 换牌）

② MCP 客户端配置（Claude / Cursor / 任意 Streamable HTTP 客户端）：
{
  "mcpServers": {
${mcpEntry('执行官', 'ybkk-governance', 'YBKK_GOV_TOKEN', operator)},
${mcpEntry('评审官', 'ybkk-governance-review', 'YBKK_GOV_REVIEW_TOKEN', reviewer)}
  }
}

③ 职责分工（R12 职责分离在自治链路成立）：
   执行官（'*'）：agent_register / agent_transition / mcp_service_register /
                mcp_service_review / mcp_deploy / app_register / iam_* / 全部管理面
   评审官：approval_list → approval_decide（agent.online 必须由评审官决策，
          且 confirmed=true 显式确认 L4 高危）
──────────────────────────────────────────────────────────`)
