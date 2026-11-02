/**
 * 当前更新（4d882f1 宿主平台功能域 + 31bf04c RQ 澄清）· 真实实例交互核查。
 * 用法：node scripts/live-verify-current-update.mjs [BASE]（默认 http://127.0.0.1:7355）
 * 覆盖：CORS 令牌铸造面收紧 / 面板与控制台新面 / AGENT_SSO_ENFORCE 上线门禁 /
 *       OIDC 协议端点 / 入场票据一次性 / RBAC 越权 / nas-authz 判定。
 */
const BASE = (process.argv[2] ?? 'http://127.0.0.1:7355').replace(/\/+$/, '')
let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✘ ${name}${detail ? `  ← ${detail}` : ''}`) }
}
async function raw(method, path, { headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    redirect: 'manual',
  })
  const h = {}
  for (const [k, v] of res.headers.entries()) h[k.toLowerCase()] = v
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, headers: h, text, json }
}
const api = async (method, path, { token, body, origin } = {}) => raw(method, path, {
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(origin ? { origin } : {}),
  },
  body,
})

console.log(`» 核查目标：${BASE}`)

// ── 0. 健康与登录面 ────────────────────────────────────────────────
const health = await api('GET', '/api/health')
check('健康检查 GET /api/health', health.json?.ok === true)

const badLogin = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } })
check('错误口令登录被拒 401', badLogin.status === 401, `status=${badLogin.status}`)

const ADMIN_PASS = process.env.LIVECHECK_ADMIN_PASS ?? 'LiveCheck@2026'
const login = await api('POST', '/api/auth/login', { body: { username: 'admin', password: ADMIN_PASS } })
check('admin 登录签发令牌（ADMIN_PASSWORD 引导）', login.status === 200 && !!login.json?.data?.token, `status=${login.status}`)
const admin = login.json?.data?.token

// ── 1. CORS 令牌铸造面收紧（31bf04c · 澄清第 1 条）──────────────────
const evil = 'http://evil.example'
const preflightAuth = await raw('OPTIONS', '/api/auth/login', {
  headers: { origin: evil, 'access-control-request-method': 'POST' },
})
check('预检 /api/auth/login 任意来源 → 不发放 ACAO（* 豁免）',
  !preflightAuth.headers['access-control-allow-origin'],
  `acao=${preflightAuth.headers['access-control-allow-origin']}`)
const directAuth = await api('POST', '/api/auth/login', { origin: evil, body: { username: 'admin', password: 'wrong' } })
check('直跨域 POST /api/auth/login → 响应无 ACAO',
  !directAuth.headers['access-control-allow-origin'],
  `acao=${directAuth.headers['access-control-allow-origin']}`)

const preflightApps = await raw('OPTIONS', '/api/apps', {
  headers: { origin: evil, 'access-control-request-method': 'GET' },
})
check('预检 /api/apps 任意来源 → 仍按 blanket * 放行',
  preflightApps.headers['access-control-allow-origin'] === '*',
  `acao=${preflightApps.headers['access-control-allow-origin']}`)

const preflightPortal = await raw('OPTIONS', '/api/portal/stats', {
  headers: { origin: evil, 'access-control-request-method': 'GET' },
})
check('预检 /api/portal/* 未登记来源 → 自管 CORS 不放行',
  !preflightPortal.headers['access-control-allow-origin'],
  `acao=${preflightPortal.headers['access-control-allow-origin']}`)
const preflightOidc = await raw('OPTIONS', '/api/authn/oidc/authorize', {
  headers: { origin: evil, 'access-control-request-method': 'GET' },
})
check('预检 /api/authn/oidc/* 未登记来源 → 不放行',
  !preflightOidc.headers['access-control-allow-origin'],
  `acao=${preflightOidc.headers['access-control-allow-origin']}`)

// ── 2. 面板与控制台新面（4d882f1 C/D）──────────────────────────────
const panelRoot = await raw('GET', '/panel')
check('/panel 302 → /panel/（目录形态归一）',
  panelRoot.status === 302 && panelRoot.headers['location'] === '/panel/',
  `status=${panelRoot.status} loc=${panelRoot.headers['location']}`)
const panelSpa = await raw('GET', '/panel/')
check('/panel/ 面板 SPA 可达 200', panelSpa.status === 200 && panelSpa.headers['content-type'].includes('text/html'))
const panelNoAuth = await api('GET', '/api/panel/depts')
check('面板 REST 无令牌 → 401（fail-closed）', panelNoAuth.status === 401, `status=${panelNoAuth.status}`)
const depts = await api('GET', '/api/panel/depts', { token: admin })
check('GET /api/panel/depts → 五部门骨架', depts.status === 200 && depts.json?.data?.depts?.length === 5,
  `status=${depts.status} n=${depts.json?.data?.depts?.length}`)
const models = await api('GET', '/api/panel/models', { token: admin })
check('GET /api/panel/models 模型目录面', models.status === 200, `status=${models.status}`)

const consoleIdx = await raw('GET', '/')
check('控制台 SPA GET / → 200', consoleIdx.status === 200 && consoleIdx.text.includes('<html'))
const connJs = await raw('GET', '/js/connections.js')
check('新增 connections.js（宿主连接切换）静态可达', connJs.status === 200, `status=${connJs.status}`)
const landingJs = await raw('GET', '/js/landing.js')
check('新增 landing.js（落地分诊）静态可达', landingJs.status === 200, `status=${landingJs.status}`)

// ── 3. RBAC 越权网（权限服务）──────────────────────────────────────
const orgs = await api('GET', '/api/iam/orgs', { token: admin })
const rootOrgId = orgs.json?.data?.[0]?.id ?? orgs.json?.data?.orgs?.[0]?.id
check('组织树可读（取根组织）', !!rootOrgId, `resp=${JSON.stringify(orgs.json?.data)?.slice(0, 120)}`)
const memberName = `livecheck_member_${Date.now() % 100000}`
const memberCreate = await api('POST', '/api/iam/users', {
  token: admin,
  body: { username: memberName, displayName: '核查-普通成员', orgId: rootOrgId, password: 'LiveCheck@2026' },
})
check('创建无特权成员账号', memberCreate.status === 200 && !!memberCreate.json?.data?.id, `status=${memberCreate.status} ${JSON.stringify(memberCreate.json?.error)}`)
const memberLogin = await api('POST', '/api/auth/login', { body: { username: memberName, password: 'LiveCheck@2026' } })
const dev = memberLogin.json?.data?.token
check('成员账号登录', !!dev, `status=${memberLogin.status}`)
const iamUsers = await api('GET', '/api/iam/users', { token: dev })
check('RBAC：dev 访问 IAM 用户表 → 403 越权拦截', iamUsers.status === 403, `status=${iamUsers.status}`)
const iamUsersAdmin = await api('GET', '/api/iam/users', { token: admin })
check('RBAC：admin 访问 IAM 用户表 → 200', iamUsersAdmin.status === 200, `status=${iamUsersAdmin.status}`)
const rosterDev = await api('GET', '/api/iam/roster', { token: dev })
check('名册通道 iam.roster.read：dev（无权限点）→ 403', rosterDev.status === 403, `status=${rosterDev.status}`)

// ── 4. AGENT_SSO_ENFORCE 上线门禁（B 项 · 双点校验挂单点）────────────
const uniq = Date.now() % 100000
const agentCreate = await api('POST', '/api/agents', { token: admin, body: {
  name: `核查-门禁验证Agent-${uniq}`,
  attrs: { description: '当前更新核查用', model: 'deepseek-chat', riskLevel: 'low', dataClass: 'internal' },
} })
check('创建 Agent 资产（含必填属性）', agentCreate.status === 200, `status=${agentCreate.status} ${JSON.stringify(agentCreate.json?.error)}`)
const agentId = agentCreate.json?.data?.agent?.id ?? agentCreate.json?.data?.id
const machineCred = agentCreate.json?.data?.credential
const gateBlocked = await api('POST', `/api/agents/${agentId}/transition`, { token: admin, body: { action: 'online' } })
check('上线门禁：未纳管 Agent 申请上线被拒（挂单点）',
  gateBlocked.status !== 200 && String(gateBlocked.json?.error?.message ?? gateBlocked.json?.error ?? '').includes('身份纳管'),
  `status=${gateBlocked.status} err=${JSON.stringify(gateBlocked.json?.error)}`)
const entryUrlSet = await api('PATCH', `/api/agents/${agentId}`, { token: admin, body: { attrs: { entryUrl: 'https://agent.example.com/ui' } } })
check('登记 entryUrl（零成本逃生门）', entryUrlSet.status === 200, `status=${entryUrlSet.status}`)
const gatePass = await api('POST', `/api/agents/${agentId}/transition`, { token: admin, body: { action: 'online' } })
check('上线门禁：登记 entryUrl 后放行（产生审批单）', gatePass.status === 200 && !!gatePass.json?.data?.approval, `status=${gatePass.status} ${JSON.stringify(gatePass.json?.error)}`)

// 机器身份不可签发非环回回调 SSO 客户端（机器自助仅限环回回调，ssoManageDecision）
if (machineCred?.clientId && machineCred?.clientSecret) {
  const machineLogin = await api('POST', '/api/auth/client-credentials', {
    body: { clientId: machineCred.clientId, clientSecret: machineCred.clientSecret },
  })
  const machineToken = machineLogin.json?.data?.token
  check('机器凭证 client-credentials 登录', !!machineToken, `status=${machineLogin.status}`)
  const ssoAsMachine = await api('POST', `/api/agents/${agentId}/sso-client`, {
    token: machineToken,
    body: { redirectUris: ['https://a.example/cb'] },
  })
  check('机器身份签发非环回回调 SSO 客户端 → 403（机器自助仅限环回）', ssoAsMachine.status === 403,
    `status=${ssoAsMachine.status} ${JSON.stringify(ssoAsMachine.json?.error)}`)
} else {
  check('机器身份签发非环回回调 SSO 客户端 → 403（机器自助仅限环回）', false, '无机器凭证返回')
}

// ── 5. OIDC 协议端点（authn 插件）────────────────────────────────
const oidcDisc = await raw('GET', '/.well-known/openid-configuration')
check('OIDC 发现端点 /.well-known/openid-configuration', oidcDisc.status === 200 && !!oidcDisc.json?.authorization_endpoint,
  `status=${oidcDisc.status}`)
const ssoIssue = await api('POST', `/api/agents/${agentId}/sso-client`, { token: admin, body: { redirectUris: ['http://127.0.0.1:7999/cb'] } })
check('owner(admin) 签发 Agent SSO OIDC 客户端', ssoIssue.status === 200 && !!ssoIssue.json?.data?.clientId, `status=${ssoIssue.status} ${JSON.stringify(ssoIssue.json?.error)}`)
const clientId = ssoIssue.json?.data?.clientId
if (clientId) {
  const authorize = await raw('GET', `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://127.0.0.1:7999/cb')}&scope=openid&state=livecheck&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`)
  check('OIDC authorize → 302 平台授权页', authorize.status === 302 && String(authorize.headers['location']).includes('req='),
    `status=${authorize.status} loc=${authorize.headers['location']}`)
  const authorizeBad = await raw('GET', `/oauth/authorize?response_type=code&client_id=oc-notexist&redirect_uri=${encodeURIComponent('http://127.0.0.1:7999/cb')}&scope=openid&state=x&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`)
  check('OIDC authorize 未知 client_id → 302 平台错误页', authorizeBad.status === 302 && String(authorizeBad.headers['location']).includes('error='), `status=${authorizeBad.status} loc=${authorizeBad.headers['location']}`)
}

// ── 6. 入场票据一次性（app 免登通道）──────────────────────────────
const appCreate = await api('POST', '/api/apps', { token: admin, body: {
  name: `核查-票据应用-${uniq}`,
  attrs: { description: '当前更新核查用', appType: 'web', riskLevel: 'low', entryUrl: 'https://app.example.com' },
} })
check('创建应用资产', appCreate.status === 200, `status=${appCreate.status} ${JSON.stringify(appCreate.json?.error)}`)
const appId = appCreate.json?.data?.app?.id ?? appCreate.json?.data?.id
const ticket = await api('POST', `/api/apps/${appId}/entry-ticket`, { token: admin })
check('签发应用入场票据（human-only）', ticket.status === 200 && !!ticket.json?.data?.ticket, `status=${ticket.status} ${JSON.stringify(ticket.json?.error)}`)
const tk = ticket.json?.data?.ticket
if (tk) {
  const redeem1 = await api('POST', '/api/authn/entry-tickets/redeem', { body: { ticket: tk } })
  check('票据首次兑换 → 200（身份交付）', redeem1.status === 200 && !!redeem1.json?.data?.identity?.sub, `status=${redeem1.status}`)
  const redeem2 = await api('POST', '/api/authn/entry-tickets/redeem', { body: { ticket: tk } })
  check('票据重放 → 400 拒绝（一次性消费）', redeem2.status === 400, `status=${redeem2.status}`)
}

// ── 7. nas-authz 权限判定（注册 NAS + check）──────────────────────
const nasCreate = await api('POST', '/api/nas', { token: admin, body: {
  name: `核查-NAS-${uniq}`,
  attrs: { description: '当前更新核查用', gatewayUrl: 'http://127.0.0.1:1/mcp', accessToken: 'lc_dummy_token', nasIp: '127.0.0.1', dataClass: 'internal' },
} })
check('注册 NAS 资产（draft）', nasCreate.status === 200, `status=${nasCreate.status} ${JSON.stringify(nasCreate.json?.error)}`)
const nasId = nasCreate.json?.data?.nas?.id ?? nasCreate.json?.data?.id
const memberUser = memberCreate.json?.data
const authzCheck = await api('POST', '/api/nas/authz/check', { token: admin, body: {
  nasId, userId: `user:${memberUser?.id ?? 'nobody'}`, paths: ['/'], op: 'read',
} })
check('nas-authz check 端点出判定（无作用域 → deny）',
  authzCheck.status === 200 && ['allow', 'deny'].includes(authzCheck.json?.data?.decision ?? ''),
  `status=${authzCheck.status} resp=${JSON.stringify(authzCheck.json?.data)?.slice(0, 160)}`)

// ── 8. 审批执行点复核（双点校验执行面）────────────────────────────
const approvals = await api('GET', '/api/approvals?state=pending', { token: admin })
const onlineApproval = (approvals.json?.data?.items ?? approvals.json?.data ?? []).find?.((a) => a?.type?.includes('agent') || a?.subjectType === 'agent')
check('审批队列可达（上线审批单在案）', approvals.status === 200, `status=${approvals.status}`)

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
console.log(`  实测结果：${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail > 0) { console.log('失败项：' + failures.join(' | ')); process.exit(1) }
console.log('  全部通过 ✔')
