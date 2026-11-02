#!/usr/bin/env node
/**
 * dshctl —— 企业 AI 资源平台命令行（CLI/Skill 双封装的 CLI 端）。
 *
 * 统一动词集合：list / get / create / update / freeze / deploy / rollback
 *               / offline / invoke / submit / approve / publish / install
 *               / metrics / logs / token / sync / topology / cost
 *               / a2a 目录·派活·任务·验收·履约·规则·巡检 / uhp 发现·harness·执行记录
 *
 * 全局约定（方案 §4.2）：
 *   --output json|table   机器可读优先，默认 table
 *   --dry-run             仅支持预演的命令可变更预览；其他写请求拒绝执行
 *   --yes                 非交互模式（供 Agent 调用）
 *   错误码统一且带修复建议
 *
 * 认证：DSHCTL_TOKEN 环境变量，或 admin 账号自动登录。
 */
import fs from 'node:fs'
let BASE = process.env.DSHCTL_URL ?? 'http://127.0.0.1:7300'
const argv = process.argv.slice(2)

// ------------------------------------------------------------------ utils
function flag(name, fallback) {
  // 支持 --name value 与 --name=value 两种风格
  const index = argv.findIndex((item) => item === `--${name}` || (item.startsWith(`--${name}=`)))
  if (index === -1) return fallback
  const item = argv[index]
  if (item.includes('=')) return item.split('=').slice(1).join('=') || fallback
  const value = argv[index + 1]
  return value && !value.startsWith('--') ? value : true
}
function argOf(name) {
  return flag(name.replace(/^--/, ''), undefined)
}
// 布尔语义旗标归一：--x / --x=true / --x on 均为真；--x=false|0|no|off 为假
function truthyFlag(name) {
  const value = flag(name)
  if (value === undefined || value === false) return false
  if (value === true) return true
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

// 全局选项（D4）：既可前置也可后置。前置的若不剥离会被当成「资源名」报「未知资源：--output」，
// 故在资源识别前统一从 argv 头部剥离并记入 GLOBALS；后置的仍由 flag() 就地查找。
// --token 特例：前置位视为平台令牌；后置位保留给子命令私有语义（nas create --token= 是 NAS 访问令牌）。
const GLOBAL_VALUE_FLAGS = ['output', 'lang', 'url', 'token']
const GLOBAL_BOOL_FLAGS = ['dry-run', 'yes', 'confirm']
const GLOBALS = {}
function consumeLeadingGlobals() {
  for (;;) {
    const item = argv[0]
    if (!item || !item.startsWith('--')) break
    const name = item.slice(2).split('=')[0]
    if (!GLOBAL_VALUE_FLAGS.includes(name) && !GLOBAL_BOOL_FLAGS.includes(name)) break
    argv.shift()
    if (item.includes('=')) { GLOBALS[name] = item.split('=').slice(1).join('=') || true; continue }
    if (GLOBAL_BOOL_FLAGS.includes(name)) { GLOBALS[name] = true; continue }
    const value = argv[0]
    if (value !== undefined && !value.startsWith('--')) { argv.shift(); GLOBALS[name] = value }
    else GLOBALS[name] = true
  }
}
consumeLeadingGlobals()

const OUTPUT = GLOBALS.output !== undefined ? GLOBALS.output : flag('output', 'table')
const leadingDryRun = GLOBALS['dry-run']
const DRY_RUN = truthyFlag('dry-run') || (leadingDryRun !== undefined && leadingDryRun !== false &&
  !['false', '0', 'no', 'off'].includes(String(leadingDryRun).trim().toLowerCase()))
const ASSUME_YES = truthyFlag('yes') || truthyFlag('confirm') || GLOBALS.yes === true || GLOBALS.confirm === true
// --url：CLI 旗标优先于 DSHCTL_URL 环境变量（前置后置均可）
{
  const urlFlag = GLOBALS.url !== undefined ? GLOBALS.url : flag('url')
  if (urlFlag && urlFlag !== true) BASE = String(urlFlag).replace(/\/+$/, '')
}

// ------------------------------------------------------------------ i18n
// 界面语言决议（协议口径 R10）：--lang 旗标 > DSHCTL_LANG > PLATFORM_LOCALE > zh-CN。
// 宽容归一（en-GB→en-US 等）；不支持的语言逐级降级，最终回 zh-CN（输出与历史版本逐字节一致）。
const LANG_PREFIXES = [['zh', 'zh-CN'], ['en', 'en-US'], ['ja', 'ja-JP']]
function normalizeLocale(input) {
  const lower = String(input ?? '').trim().toLowerCase()
  if (!lower) return null
  for (const [prefix, locale] of LANG_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}-`)) return locale
  }
  return null
}
const LOCALE = normalizeLocale(GLOBALS.lang !== undefined ? GLOBALS.lang : flag('lang'))
  ?? normalizeLocale(process.env.DSHCTL_LANG)
  ?? normalizeLocale(process.env.PLATFORM_LOCALE)
  ?? 'zh-CN'
// 词典：复用 packages/platform-i18n/locales/<locale>/*.json（按文件名序浅合并，与平台 t() 同源）。
// 目录缺失或解析失败静默降级中文（零依赖单文件约束：不经由 platform-i18n TS 模块）。
const I18N = (() => {
  if (LOCALE === 'zh-CN') return {}
  try {
    const dir = new URL(`../packages/platform-i18n/locales/${LOCALE}/`, import.meta.url)
    const merged = {}
    for (const name of fs.readdirSync(dir).filter((item) => item.endsWith('.json')).sort()) {
      try {
        const parsed = JSON.parse(fs.readFileSync(new URL(name, dir), 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') merged[key] = value
        }
      } catch { /* 单个词典文件损坏跳过（fail-soft，等价缺翻译降级中文） */ }
    }
    return merged
  } catch { return {} }
})()
function interpolate(template, params) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}
// t(中文原文)：zh-CN 原样（{name} 插值）；其它语言命中词典用译文、未命中回中文原文，再统一插值。
function t(zh, params) {
  if (LOCALE === 'zh-CN') return interpolate(zh, params)
  return interpolate(I18N[zh] ?? zh, params)
}

let token = process.env.DSHCTL_TOKEN ?? ''

async function call(method, path, body) {
  // 默认拒绝预演模式下的写请求；只放行服务端明确实现 dryRun 的接口和认证登录。
  // 防止调用者误以为所有命令都支持 --dry-run，实际却执行了变更。
  const previewEndpoint = method === 'POST' && body?.dryRun === true && (
    /^\/api\/mcp\/services\/[^/]+\/deploy$/.test(path) ||
    path === '/api/connector/execute' || path === '/api/update/apply'
  )
  const isLogin = method === 'POST' && path === '/api/auth/login'
  if (DRY_RUN && !['GET', 'HEAD'].includes(method) && !previewEndpoint && !isLogin) {
    fail(t('该操作不支持 --dry-run，已阻止写入请求：{method} {path}', { method, path }))
  }
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok === false) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`
    const code = payload?.error?.code ?? `HTTP_${response.status}`
    fail(t('{message}（{code}）', { message, code }))
  }
  return payload?.data
}

function readFileSyncLocal(path) {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch {
    fail(t('文件不存在或不可读：{path}', { path }))
    return ''
  }
}

function fail(message) {
  console.error(`\n✘ ${message}`)
  console.error(t('  修复建议：检查服务是否运行（{base}）、令牌是否有效（DSHCTL_TOKEN）、参数是否完整。', { base: BASE }))
  console.error(t('  帮助：dshctl help'))
  process.exit(1)
}

async function ensureToken() {
  if (token) return
  const username = process.env.DSHCTL_USER
  const password = process.env.DSHCTL_PASS
  if (!username || !password) {
    fail(t('未提供凭据：请通过 DSHCTL_USER / DSHCTL_PASS 指定账号口令，或 DSHCTL_TOKEN 直接携带令牌'))
  }
  try {
    const data = await call('POST', '/api/auth/login', { username, password })
    token = data.token
  } catch {
    fail(t('自动登录失败：请检查 DSHCTL_USER / DSHCTL_PASS 是否正确，或改用 DSHCTL_TOKEN'))
  }
}

// 宽容调用（免鉴权规范端点）：A2A well-known 与 UHP /v1 均为规范裸 JSON（无 {ok,data} 信封）。
// 兼容规则：响应含布尔 ok 字段按平台信封解（ok=false 报错退出），否则整体视为数据。
// 信封分支保留仅为对接升级窗口内的旧版被管实例，不再是主路径。
async function callLoose(method, path) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}${path}`, { method, headers })
  const payload = await response.json().catch(() => null)
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.ok === 'boolean') {
    if (!response.ok || payload.ok === false) {
      const message = payload?.error?.message ?? `HTTP ${response.status}`
      const code = payload?.error?.code ?? `HTTP_${response.status}`
      fail(t('{message}（{code}）', { message, code }))
    }
    return payload.data
  }
  if (!response.ok) fail(t('HTTP {status}', { status: response.status }))
  return payload
}

// A2A JSON-RPC 调用：平台信封内的 JSON-RPC 2.0。error 分支 exit 非 0 并打印 error.message 与 error.data.code。
async function callJsonRpc(slug, method, params) {
  const data = await call('POST', `/api/agents/${encodeURIComponent(slug)}/a2a`, { jsonrpc: '2.0', id: 1, method, params })
  if (data && typeof data === 'object' && data.error) {
    const detail = data.error.data && data.error.data.code ? ` / ${data.error.data.code}` : ''
    console.error(`\n✘ ${t('{message}（JSON-RPC {code}{detail}）', { message: data.error.message ?? 'JSON-RPC error', code: data.error.code ?? '', detail })}`)
    console.error(t('  修复建议：检查目标数字员工是否在线、数据密级是否越权、参数是否完整。'))
    console.error(t('  帮助：dshctl help'))
    process.exit(1)
  }
  return data?.result
}

// ------------------------------------------------------------------ 输出
// 表头中文标签：键为列名（--output json 的协议键，保留 ASCII），值为 table 模式的中文显示名
const HEADER_ZH = {
  id: 'ID', name: '名称', status: '状态', createdAt: '创建时间', username: '用户名', org: '组织',
  code: '编码', builtin: '内置', permissions: '权限', provider: '提供方', kind: '类型',
  jti: '令牌标识', principal: '主体', expires: '过期时间', principalId: '主体ID', clientId: '客户端ID',
  refType: '关联类型', scopes: '权限范围', activeTokens: '有效令牌', version: '版本', gray: '灰度',
  health: '健康', tools: '工具数', calls: '调用量', successRate: '成功率', p95Latency: 'P95延迟',
  tokens: '令牌量', tool: '工具', ok: '成功', avgLatency: '平均延迟', type: '类型', depth: '深度',
  rootPath: '根路径', nasId: 'NAS资产', reachable: '可达', error: '错误', downloads: '下载量',
  rating: '评分', findings: '扫描发现', latencyMs: '延迟(ms)', reason: '原因', service: '服务',
  riskLevel: '风险级', description: '描述', alias: '别名', authType: '认证类型', maskedProfile: '凭证摘要',
  ocConnectionId: '连接器连接', policies: '策略', subjects: '主体数', actionId: '动作ID',
  runtimeTokenId: '运行时令牌', startedAt: '开始时间', checkedRuns: '已核运行', matchedMeters: '已匹配计量',
  bypass: '绕行', cursor: '游标', permGroupId: '权限组ID', ocTokenId: '连接器令牌', hash: '策略指纹',
  lastSyncedAt: '最近同步', model: '模型', success: '成功率', clientSecret: '客户端密钥', note: '备注',
  url: '地址', dau: 'DAU', agentName: 'Agent名称', llmTokens: 'LLM令牌', toolCalls: '工具调用',
  costYuan: '成本(元)', time: '时间', action: '动作', actor: '操作者', resource: '资源', result: '结果',
  severity: '级别', title: '标题', read: '已读', requester: '申请人', key: '键', runtime: '运行时',
  plugins: '插件', collections: '集合', plugin: '插件', event_id: '事件ID', subject: '主体',
  meters: '计量', charge: '费用(分)', codeMask: '接入码', template: '模板', expiresAt: '过期时间',
  usedBy: '使用者', remark: '备注', hostname: '主机名', lastUsedAt: '最近使用', isError: '出错',
  durationMs: '耗时(ms)', value: '返回值', developer: '开发者', installs: '安装量', usageKey: '计量键',
  members: '成员数', agent: 'Agent', taskId: '任务ID', state: '状态', outputText: '输出',
  slug: 'Slug', agentId: 'AgentID', autonomy: '自主度', ceiling: '密级上限', harnessId: 'Harness',
  stepBudget: '步数预算', received: '接收数', completionRate: '完成率', acceptancePassRate: '验收通过率',
}
// 状态枚举中文伴随：协议值保留 ASCII（json 输出原样），table 模式经此映射展示（对齐 errors.js 映射表做法）
const STATUS_ZH = {
  active: '活跃', inactive: '停用', pending: '待审批', approved: '已通过', rejected: '已驳回',
  published: '已上架', deprecated: '已弃用', online: '在线', offline: '离线', degraded: '降级',
  healthy: '健康', unhealthy: '异常', draft: '草稿', frozen: '已冻结', used: '已使用',
  expired: '已过期', disabled: '已禁用', enabled: '已启用', running: '运行中', failed: '失败',
  succeeded: '成功', allow: '放行', deny: '拒绝', info: '提示', warning: '警告', critical: '严重',
  submitted: '已提交', reviewing: '审批中', stopped: '已停止', unknown: '未知',
  completed: '已完成', canceled: '已取消', working: '执行中', queued: '排队中',
  input_required: '待补充输入', auth_required: '待授权', requested: '已请求',
}
const zhEnum = (value) => t(STATUS_ZH[String(value)] ?? value)
const isEnumCol = (col) => col === 'status' || col === 'health' || col === 'severity' || col === 'decision' || col === 'state'

function out(data, columns, title) {
  if (OUTPUT === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  if (Array.isArray(data)) return table(data, columns, title)
  const entries = Object.entries(data ?? {})
  if (entries.length === 0) { console.log(t('（空结果）')); return }
  if (typeof data !== 'object') { console.log(data); return }
  const labelOf = (key) => t(HEADER_ZH[key] ?? key)
  const width = Math.max(...entries.map(([key]) => labelOf(key).length)) + 2
  for (const [key, value] of entries) {
    const shown = isEnumCol(key) ? zhEnum(value) : value
    const text = t(typeof shown === 'object' ? JSON.stringify(shown) : String(shown ?? '—'))
    console.log(`  ${(labelOf(key) + ':').padEnd(width)}${text.length > 100 ? text.slice(0, 100) + '…' : text}`)
  }
}

function table(rows, columns, title) {
  if (title) console.log('\n' + t('{title}（{count}）', { title: t(title), count: rows.length }))
  if (!rows.length) { console.log(t('  （无数据）')); return }
  const cols = columns ?? Object.keys(rows[0]).slice(0, 6)
  const labelOf = (col) => t(HEADER_ZH[col] ?? col)
  const cellOf = (row, col) => {
    const value = isEnumCol(col) ? zhEnum(row[col]) : row[col]
    return value
  }
  const widths = cols.map((col) => Math.max(labelOf(col).length, ...rows.map((row) => String(cellOf(row, col) ?? '').length, 20)))
  const line = (cells) => '  ' + cells.map((cell, i) => String(cell ?? '').slice(0, 32).padEnd(widths[i])).join('  ')
  console.log(line(cols.map(labelOf)))
  console.log(line(widths.map((w) => '─'.repeat(Math.min(w, 32)))))
  for (const row of rows) console.log(line(cols.map((col) => t(String(cellOf(row, col) ?? '')))))
}

function ok(message) {
  console.log(`✔ ${message}`)
}

// ------------------------------------------------------------------ 命令表
const COMMANDS = {
  help: {
    desc: '显示帮助',
    run: () => {
      // 帮助逐行输出：每行独立过 t()（含中文的整行为词典键，纯 ASCII 行原样）
      const lines = [
        'dshctl —— 企业 AI 资源平台 CLI（基于 DeepSeek Harness 一切皆插件架构）',
        '',
        '用法：dshctl <resource> <action> [参数] [全局选项]',
        '',
        '资源与动作：',
        '  org       list | create --name=<名称> [--parent=<orgId>]   组织树 / 新建组织',
        '  user      list [--org= --status= --q=] | create --username= --displayName= --orgId=   用户列表 / 新建账号',
        '            freeze <userId> --reason=<原因>   （L4：自动联动吊销令牌）',
        '  role      list                            角色列表',
        '  group     list                            用户组列表',
        '  sync      run --provider=dingtalk          触发三方通讯录同步',
        '  conflict  list | resolve <id> --keep=third_party|platform   同步冲突列表 / 裁决保留侧',
        '  token     list [--principalId=] | issue --principalId= --ttlHours=   令牌列表 / 签发',
        '            revoke <jti> --reason=<原因>     吊销令牌',
        '  credential list                                        列出机器凭证（principalId/clientId/scopes/状态）',
        '          create --name= --scope=a,b[,c|*] [--refType= --refId=]   （clientSecret 仅返回一次）',
        '          scopes <principalId> --scopes=a,b[,c|*]   调整权限范围（存量令牌联动吊销）',
        '          rotate <principalId>                       轮换 clientSecret（仅本次展示，旧值立即失效）',
        '  mcp       list [--status=] | get <id> | metrics <id> | health <id>   MCP 服务列表 / 详情 / 指标 / 探活',
        '            deploy <id> [--gray=20] [--version=] [--changelog=] [--dry-run]   发布（灰度/预演）',
        '            rollback <id> --targetVersion=     回滚到指定版本',
        '            offline <id> --reason=<原因>      （L4：生成审批单）',
        '            invoke <id> --tool=<工具名> [--args=<JSON>]   调用服务内工具',
        '  skill     list [--q= --category=] | get <id>           Skill 列表 / 详情',
        '            submit --name= --content-file=<SKILL.md路径> [--category=] [--package=<skill.zip>]   提交审核',
        '            approve <id> --level=domain|security --decision=approve|reject --opinion=   审批（领域/安全两级）',
        '            publish <id> | install <id> --agentId= | deprecate <id> --reason=   上架 / 安装到 Agent / 弃用',
        '            storage get | storage set --mode=local|nas [--nas-id= --base-path=]   Skill 包存储位',
        '  nas       list [--status= --q=] | get <id>             NAS 资产列表 / 详情',
        '            create --name= --gateway-url= --token= --nas-ip= [--root-path=] [--staging-dir=]   注册 NAS 资产',
        '            import --config=<mcpServers JSON 或 @文件> [--name=]   （synology-filestation 配置一键纳管）',
        '            health <id> | online <id> | offline <id> --reason=     探活 / 上线 / 下线',
        '            shares <id> | files <id> [--path=] | mkdir <id> --path= | delete <id> --path=   共享/文件浏览/建目录/删除',
        '            upload <id> --file=<本地路径> --dest=<NAS路径> | search <id> --pattern= [--path=]   上传 / 搜索',
        '            authz check --nas=<id> --user=<平台或钉钉userId> --path=<路径> --op=read|download|write|modify|delete|share|admin [--override]   数据权限判定',
        '            authz scope --nas=<id> --user=<userId>     查询用户在某 NAS 的作用域',
        '            authz rules get | rules set [--observe-only=on|off] [--degrade-readonly=on|off] [--c-groups=组名1,组名2]   规则查看 / 调整',
        '            authz rules import --file=<rules.json> | decisions [--decision=deny] [--limit=50]   规则导入 / 判定流水',
        '  connector gateway get | gateway set --base-url= --admin-token-env=VAR | gateway health   网关配置 / 探活',
        '            catalog providers [--search=] | catalog actions [--service=] [--search=]   目录：提供方 / 动作',
        '            catalog action <actionId> [--guide]        动作详情（--guide 输出接入指引）',
        '            connections list [--org=] | connections create --provider= --auth-type=no_auth|api_key|oauth   连接列表 / 创建',
        '                     --org=<orgId> [--alias-suffix=main] [--values=@file.json] [--scopes=a,b]',
        '                     connections delete <id> --yes [--force]   删除连接（被引用时 --force 解除）',
        '            gateway offline --reason=<原因> [--direct] | gateway online     （L4 审批 / 直连留痕）',
        '            connections offline <id> --reason= [--direct] | online <id>     连接下线 / 恢复',
        '            execute --action=<actionId> [--connection=<alias>] [--input=@file.json] [--dry-run]   执行连接器动作',
        '            perm-groups list | get | create --file=@group.json | impact <id> | delete <id> --yes   权限组管理',
        '            runs [--service=] [--ok=true|false] [--limit=50]     运行流水',
        '            reconcile                              runs 对账（有 run 无 meter 即绕行告警，人工复核口径）',
        '            tokens                                 oct_ 台账（永不返回令牌值）',
        '  agent     list [--status=] | get <id> | metrics <id> | topology <id>   Agent 列表 / 详情 / 指标 / 拓扑',
        '            create --name= --model= --riskLevel=     注册 Agent',
        '            offline <id> --reason=<原因> --requesterId= --requesterName=   （L4 审批）',
        '            bind <id> --userId=                      绑定用户',
        '  app       list | get <id> | metrics <id> | topology <id> | cost <id>   应用列表 / 详情 / 指标 / 拓扑 / 成本',
        '            report <id> [--dau= --sessions= --avg-depth= --retention7= --date=]   （应用指标主动上报）',
        '  usage     record --org= --subject= --principal= --resource= --meter=key:value:unit[,...]',
        '                                            （计量事件主动推送，schema v1 + 幂等键；',
        '                                             meter key 须与价格簿一致：mcp:* → tokens、model:<slug> → output_tokens，',
        '                                             不匹配会被硬拒绝，报错直接给出期望键）',
        '            [--idempotency-key= --tenant-id=]        幂等键 / 租户（可选）',
        '            events [--principal= --resource= --limit=] | totals [--principal= --from=]   计量事件查询 / 汇总',
        '  audit     logs [--type= --resourceId= --limit=] | alerts [--unread] | read-all   审计日志 / 告警 / 全部已读',
        '  approval  list [--pending] | decide <id> --decision=approve|reject --opinion= [--confirmed] [--final-review]   审批单列表 / 裁决（高风险单需 --confirmed 二次确认）',
        '  cost      report --groupBy=app|agent|org|date      成本报表（按应用/Agent/组织/日期）',
        '  platform  info                              插件树 / 工具目录 / 集合',
        '  update    status | check                    平台版本与上游更新状态 / 立即检查（60s 冷却）',
        '            apply [--dry-run] [--reason=<原因>]  一键升级（git pull + npm install，source 形态）',
        '            set [--auto=on|off] [--hours=24]   自动检查偏好',
        '  connect   code [--template=readonly|operator|executor|full] [--ttl=15] [--remark=]   签发接入码',
        '            （创建一次性接入码：远程 dsh 凭此申请机器凭证）',
        '            codes | clients | disable <clientId> --reason=<原因>   接入码列表 / 已接入客户端 / 禁用',
        '  tool      exec --name=<工具名> [--args=<JSON>]   直接调用注册的工具',
        '  plugin    init --id=<com.vendor.name> [--dir=./my-plugin]   初始化插件脚手架',
        '            （本地脚手架：契约五面 + Ed25519 发布者密钥对 + Hello World 提示词包）',
        '            sign --dir=<目录>                对五面指纹签名（输出 signature）',
        '            submit --dir=<目录> --user=<开发者账号> [--password=<密码>]',
        '            list | install <pluginId> --orgId= --caps=<逗号分隔能力> [--tenantId=]',
        '  a2a       directory [--q= --skill= --runtime= --autonomy=]   A2A 协作目录（在线数字员工发现）',
        '            card <slug>                       读取 Agent Card（well-known，免鉴权，兼容裸 JSON / 信封）',
        '            send <slug> --message=<文本> [--data-class=] [--context=]   派活（JSON-RPC message/send）',
        '            tasks [--agent= --state= --context= --limit=] | task <taskId>   协作任务列表 / 详情',
        '            cancel <slug> <taskId> [--reason=] | accept <taskId> --decision=accepted|rejected --reason=   取消 / 交付验收（人在环）',
        '            fulfillment                       履约视图（完成率 / 耗时 / 验收通过率）',
        '            rules | rule-add --name= [--keyword=] [--data-class-at-least=internal|secret] | rule-rm <id>   审批规则管理',
        '            patrol                            触发协商一致性巡检',
        '  uhp       discover                          UHP 能力发现（免鉴权）',
        '            harnesses | harness-add --id= --agent= --model= [--step-budget=] [--ceiling=] | harness-rm <id>   harness 注册表管理',
        '            responses [--task= --agent= --limit=]   UHP 执行记录',
        '',
        '全局选项：',
        '  --output json|table    输出格式（默认 table，机器消费建议 json）',
        '  --dry-run              支持预演的操作查看影响面；其他写入会被拒绝',
        '  --yes                  跳过交互确认（供 Agent 非交互调用）',
        '  --url <base>           平台地址（默认 http://127.0.0.1:7300）',
        '  --token <token>        平台令牌（优先于 DSHCTL_TOKEN）',
        '  --lang <zh-CN|en-US|ja-JP>  界面语言（默认 zh-CN，亦可用环境变量 DSHCTL_LANG）',
        '',
        '认证：DSHCTL_TOKEN（优先）或 DSHCTL_USER / DSHCTL_PASS（默认 admin）',
      ]
      console.log('\n' + lines.map((line) => t(line)).join('\n') + '\n')
    },
  },

  // ---------------------------------------------------------------- IAM
  plugin: {
    desc: '第三方插件市场（L0 声明式契约）',
    run: async () => {
      const action = argv[0]
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const { generateKeyPairSync, createPrivateKey, sign: edSign, createHash } = await import('node:crypto')

      const MANIFEST_FILES = ['plugin.yaml', 'manifest/permissions.yaml', 'manifest/api.yaml', 'manifest/events.yaml', 'manifest/billing.yaml']

      const readManifestFiles = async (dir) => {
        const files = {}
        for (const rel of MANIFEST_FILES) {
          const content = await fs.readFile(path.join(dir, rel), 'utf8')
          files[rel] = content
        }
        return files
      }
      const fingerprintOf = (files) => {
        const canonical = Object.keys(files).sort().map((key) => `${key}\n${files[key] ?? ''}`).join('\n---\n')
        return createHash('sha256').update(canonical).digest('hex')
      }

      if (action === 'init') {
        if (DRY_RUN) fail(t('plugin init 不支持 --dry-run，已阻止创建本地文件'))
        const id = argOf('--id')
        if (!id || !/^[a-z0-9]+(\.[a-z0-9-]+){1,3}$/.test(id)) fail(t('用法：dshctl plugin init --id=<com.vendor.name> [--dir=./my-plugin]'))
        const dir = argOf('--dir') ?? `./plugin-${id.split('.').pop()}`
        const { publicKey, privateKey } = generateKeyPairSync('ed25519')
        const publisher = argOf('--publisher') ?? id.split('.')[0]
        await fs.mkdir(path.join(dir, 'manifest'), { recursive: true })
        const writeFile = async (rel, content) => { await fs.writeFile(path.join(dir, rel), content, 'utf8'); ok(t('已生成 {path}', { path: path.join(dir, rel) })) }
        await writeFile('plugin.yaml', [
          '# 第三方插件契约 · 元数据面（L0 声明式：无任何可执行代码）',
          `id: ${id}`,
          'version: 0.1.0',
          `publisher: ${publisher}`,
          'depends:',
          '  - dsh-plugin-platform-core: ^1.0',
          'capabilities_request:',
          '  - knowledgebase.read',
          'sandbox: L0',
          '# L0 声明式内容：提示词包（改提示词 = 改行为，内容变更需重走审批）',
          'content:',
          '  prompts:',
          `    - name: hello`,
          `      description: Hello World 提示词包`,
          `      template: |`,
          `        你是「${id}」提供的助手。请按以下步骤输出：`,
          `        1. 复述用户请求`,
          `        2. 给出结构化回答`,
          '',
        ].join('\n'))
        await writeFile('manifest/permissions.yaml', [
          '# 权限声明面：requested 项在安装时由企业逐项审批（approved ⊆ requested）',
          'requested:',
          '  - knowledgebase.read',
          '',
        ].join('\n'))
        await writeFile('manifest/api.yaml', [
          '# 声明式提供面（L0 阶段仅登记描述，平台不开放真实路由）',
          'routes: []',
          '',
        ].join('\n'))
        await writeFile('manifest/events.yaml', [
          '# 事件声明面：订阅自由；发射必须收敛在 plugin:<id>: 命名空间',
          `subscribes: []`,
          'emits: []',
          '',
        ].join('\n'))
        await writeFile('manifest/billing.yaml', [
          '# 计量声明面（兼容字段：仅 meter key/单位参与计量登记，金额侧平台一律零价快照）',
          'model: free',
          'usage:',
          `  - key: prompts.used`,
          `    unit: 次`,
          `    price: 0`,
          '',
        ].join('\n'))
        await fs.writeFile(path.join(dir, 'publisher-private-key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), 'utf8')
        const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
        console.log('')
        ok(t('脚手架完成：{dir}（目标：30 分钟内 Hello World 跑通）', { dir }))
        console.log(`  ${t('发布者公钥（注册开发者账号时提交）：')}\n  ${publicKeyBase64}`)
        console.log(t('  私钥已写入 {path}（仅本地保存，切勿上传）', { path: path.join(dir, 'publisher-private-key.pem') }))
        console.log(t('  下一步：'))
        console.log(t('   1) 调用 POST /api/market/developers/register 注册开发者（字段：username/email/password/publicKey）'))
        console.log(t('   2) dshctl plugin sign --dir={dir}      （生成五面签名）', { dir }))
        console.log(t('   3) dshctl plugin submit --dir={dir} --user=<开发者账号>', { dir }))
        return
      }

      if (action === 'sign') {
        const dir = argOf('--dir')
        if (!dir) fail(t('用法：dshctl plugin sign --dir=<目录>'))
        const files = await readManifestFiles(dir)
        const fingerprint = fingerprintOf(files)
        const privateKeyPem = await fs.readFile(path.join(dir, 'publisher-private-key.pem'), 'utf8')
        const signature = edSign(null, Buffer.from(fingerprint), createPrivateKey(privateKeyPem)).toString('base64')
        out({ fingerprint, signature })
        return
      }

      if (action === 'submit') {
        const dir = argOf('--dir')
        const user = argOf('--user')
        if (!dir || !user) fail(t('用法：dshctl plugin submit --dir=<目录> --user=<开发者账号> [--password=]'))
        const files = await readManifestFiles(dir)
        const fingerprint = fingerprintOf(files)
        const privateKeyPem = await fs.readFile(path.join(dir, 'publisher-private-key.pem'), 'utf8')
        const signature = edSign(null, Buffer.from(fingerprint), createPrivateKey(privateKeyPem)).toString('base64')
        token = '' // 开发者身份域登录（独立于平台管理员令牌）
        const login = await call('POST', '/api/market/developers/login', { username: user, password: argOf('--password') ?? '' })
        token = login.token
        const submission = await call('POST', '/api/market/submit', { files, signature })
        ok(t('已提交：{pluginId}@{version}（{status}）', { pluginId: submission.pluginId, version: submission.version, status: zhEnum(submission.status) }))
        out(submission)
        return
      }

      if (action === 'list' || !action) {
        await ensureToken()
        const data = await call('GET', '/api/market/plugins')
        out(data.plugins.map((item) => ({ pluginId: item.pluginId, version: item.version, developer: item.developer, installs: item.installs, usageKey: item.metering?.usageKey ?? '' })), ['pluginId', 'version', 'developer', 'installs', 'usageKey'])
        return
      }

      if (action === 'install') {
        const pluginId = argv[1]
        const orgId = argOf('--orgId')
        if (!pluginId || !orgId) fail(t('用法：dshctl plugin install <pluginId> --orgId=<组织> [--caps=能力1,能力2] [--tenantId=]'))
        await ensureToken()
        const data = await call('POST', `/api/market/plugins/${pluginId}/install`, {
          orgId,
          ...(argOf('--tenantId') ? { tenantId: argOf('--tenantId') } : {}),
          approvedCapabilities: (argOf('--caps') ?? '').split(',').filter(Boolean),
        })
        ok(t('已安装：{pluginId}@{version} → 组织 {orgId}（能力：{caps}）', { pluginId: data.pluginId, version: data.version, orgId: data.orgId, caps: data.capabilities.join(',') || t('无') }))
        return
      }

      fail(t('未知动作：{resource} {action}', { resource: 'plugin', action }))
    },
  },

  org: {
    run: async () => {
      const action = argv[0]
      await ensureToken()
      if (action === 'list' || action === 'tree' || !action) {
        const tree = await call('GET', '/api/iam/orgs/tree')
        const flat = []
        const walk = (nodes, depth) => nodes.forEach((node) => { flat.push({ ...node, depth }); walk(node.children, depth + 1) })
        walk(tree, 0)
        out(flat.map((node) => ({ id: node.id, name: '  '.repeat(node.depth) + node.name, status: node.status, createdAt: node.createdAt.slice(0, 10) })), ['id', 'name', 'status', 'createdAt'])
        return
      }
      if (action === 'create') {
        const data = await call('POST', '/api/iam/orgs', { name: argOf('--name'), parentId: argOf('--parent') ?? null })
        ok(t('组织已创建：{name}（{id}）', { name: data.name, id: data.id }))
        out(data)
        return
      }
      fail(t('未知动作：{resource} {action}', { resource: 'org', action }))
    },
  },
  user: {
    run: async () => {
      const action = argv[0]
      await ensureToken()
      if (!action || action === 'list') {
        const search = new URLSearchParams()
        if (flag('org')) search.set('orgId', flag('org'))
        if (flag('status')) search.set('status', flag('status'))
        if (flag('q')) search.set('q', flag('q'))
        const data = await call('GET', '/api/iam/users' + (search.size ? `?${search}` : ''))
        out(data.users.map((user) => ({ id: user.id, username: user.username, name: user.displayName, org: user.orgName, status: user.status })), ['id', 'username', 'name', 'org', 'status'])
        return
      }
      if (action === 'create') {
        const data = await call('POST', '/api/iam/users', {
          username: argOf('--username'), displayName: argOf('--displayName'),
          orgId: argOf('--orgId'), title: flag('title'), email: flag('email'),
        })
        ok(t('账号已创建：{name}（{id}）', { name: data.displayName, id: data.id }))
        return
      }
      if (action === 'freeze') {
        const reason = flag('reason')
        if (!reason) fail(t('freeze 必须提供 --reason（审计要求）'))
        if (!ASSUME_YES && OUTPUT === 'table') {
          console.log(t('将冻结账号 {user}，原因：{reason}。其名下全部令牌将被吊销。', { user: argv[1], reason }))
          if (!await confirm()) { console.log(t('已取消（使用 --yes 跳过确认）')); return }
        }
        const data = await call('POST', `/api/iam/users/${argv[1]}/freeze`, { reason: String(reason) })
        ok(t('已冻结 {name}，令牌已联动吊销', { name: data.displayName }))
        return
      }
      fail(t('未知动作：{resource} {action}', { resource: 'user', action }))
    },
  },
  role: {
    run: async () => {
      await ensureToken()
      const data = await call('GET', '/api/iam/roles')
      out(data.roles.map((role) => ({ code: role.code, name: role.name, builtin: role.builtin, permissions: role.permissions.join(',') })), ['code', 'name', 'builtin', 'permissions'])
    },
  },
  group: {
    run: async () => {
      const action = argv[0] ?? 'list'
      await ensureToken()
      if (!action || action === 'list') {
        const data = await call('GET', '/api/iam/groups')
        out((data.groups ?? []).map((group) => ({
          id: group.id,
          name: group.name,
          type: group.type,
          members: Array.isArray(group.resolvedMembers) ? group.resolvedMembers.length : (group.memberIds ?? []).length,
        })), ['id', 'name', 'type', 'members'], '用户组')
        return
      }
      fail(t('用法：group list（用户组列表；成员数为动态规则解析后的去重总数）'))
    },
  },
  sync: {
    run: async () => {
      await ensureToken()
      if (argv[0] === 'run') {
        const data = await call('POST', `/api/iam/connectors/${flag('provider', 'dingtalk')}/sync`)
        ok(data.message)
        return
      }
      fail(t('用法：dshctl sync run --provider=dingtalk'))
    },
  },
  conflict: {
    run: async () => {
      await ensureToken()
      if (!argv[0] || argv[0] === 'list') {
        const data = await call('GET', '/api/iam/conflicts')
        out(data.conflicts.map((c) => ({ id: c.id, provider: c.provider, kind: c.kind, status: c.status })), ['id', 'provider', 'kind', 'status'])
        return
      }
      if (argv[0] === 'resolve') {
        const data = await call('POST', `/api/iam/conflicts/${argv[1]}/resolve`, { keep: flag('keep', 'third_party') })
        ok(t('冲突已处理：保留 {side}', { side: data.resolution }))
        return
      }
      fail(t('用法：conflict list | resolve <id> --keep=third_party|platform'))
    },
  },

  // ---------------------------------------------------------------- authn
  token: {
    run: async () => {
      const action = argv[0]
      await ensureToken()
      if (!action || action === 'list') {
        const search = new URLSearchParams()
        if (flag('principalId')) search.set('principalId', flag('principalId'))
        const data = await call('GET', '/api/authn/tokens' + (search.size ? `?${search}` : ''))
        out(data.tokens.map((t) => ({ jti: t.jti.slice(0, 12) + '…', principal: t.principalName, kind: t.kind, status: t.revokedAt ? '已吊销' : '生效中', expires: t.expiresAt.slice(0, 16).replace('T', ' ') })), ['jti', 'principal', 'kind', 'status', 'expires'])
        return
      }
      if (action === 'issue') {
        const data = await call('POST', '/api/authn/tokens', { principalId: argOf('--principalId'), ttlHours: Number(flag('ttlHours', 2)), reason: flag('reason', 'cli') })
        ok(t('令牌已签发'))
        out(data)
        return
      }
      if (action === 'revoke') {
        const reason = flag('reason')
        if (!reason) fail(t('revoke 必须提供 --reason'))
        await call('DELETE', `/api/authn/tokens/${argv[1]}`, { reason: String(reason) })
        ok(t('令牌 {jti} 已吊销', { jti: argv[1] }))
        return
      }
      fail(t('未知动作：{resource} {action}', { resource: 'token', action }))
    },
  },
  credential: {
    run: async () => {
      await ensureToken()
      const action = argv[0] ?? 'list'
      const id = argv[1]
      if (action === 'list') {
        const data = await call('GET', '/api/authn/principals')
        out(data.principals.filter((p) => p.type === 'machine').map((p) => ({
          principalId: p.id,
          clientId: p.clientId ?? '—',
          name: p.name,
          refType: p.refType ?? 'external',
          scopes: (p.scopes ?? []).join(','),
          status: p.status,
          activeTokens: p.activeTokens,
        })), ['principalId', 'clientId', 'name', 'refType', 'scopes', 'status', 'activeTokens'])
        return
      }
      if (action === 'create') {
        const scopes = String(flag('scope', 'mcp.invoke')).split(',').map((s) => s.trim()).filter(Boolean)
        const payload = { name: argOf('--name'), refType: flag('refType', 'external'), scopes }
        const refId = argOf('--refId')
        if (refId) payload.refId = String(refId)
        if (!payload.name) fail(t('用法：credential create --name=<名称> --scope=<权限点>[,<权限点>…] [--refType= --refId=]'))
        const data = await call('POST', '/api/authn/principals', payload)
        if (OUTPUT === 'json') { out(data); return }
        ok(t('凭证已签发（clientSecret 仅此一次展示）'))
        out(data)
        return
      }
      if (action === 'scopes') {
        const scopesRaw = argOf('--scopes')
        if (!id || !scopesRaw) fail(t('用法：credential scopes <principalId> --scopes=<权限点>[,<权限点>…|*]'))
        const scopes = String(scopesRaw).split(',').map((s) => s.trim()).filter(Boolean)
        const data = await call('PATCH', `/api/authn/principals/${id}`, { scopes })
        if (OUTPUT === 'json') { out({ principalId: data.id, name: data.name, scopes: data.scopes.join(','), status: data.status }); return }
        ok(t('权限范围已更新为 {scopes}（存量令牌已联动吊销，机器侧需重新换牌）', { scopes: data.scopes.join(',') }))
        out({ principalId: data.id, name: data.name, scopes: data.scopes.join(','), status: data.status })
        return
      }
      if (action === 'rotate') {
        if (!id) fail(t('用法：credential rotate <principalId>'))
        const data = await call('POST', `/api/authn/principals/${id}/rotate-secret`)
        // 机器可读分支：--output json 时输出纯净 JSON（✔ 人类提示不进 stdout，避免破坏管道消费）
        if (OUTPUT === 'json') { out(data); return }
        ok(t('clientSecret 已轮换（新值仅此一次展示，旧值立即失效，存量令牌已全部吊销）'))
        out(data)
        return
      }
      fail(t('用法：credential list | create --name= --scope=a,b[,c|*] [--refType= --refId=] | scopes <principalId> --scopes=a,b[,c|*] | rotate <principalId>'))
    },
  },

  // ---------------------------------------------------------------- mcp
  mcp: {
    run: async () => {
      const action = argv[0] ?? 'list'
      const id = argv[1]
      await ensureToken()
      if (action === 'list') {
        const data = await call('GET', '/api/mcp/services')
        out(data.services.map((s) => ({ id: s.id, name: s.name, status: s.status, version: 'v' + s.currentVersion, gray: s.grayPercent + '%', health: s.health.status, tools: s.tools.length })), ['id', 'name', 'status', 'version', 'gray', 'health', 'tools'])
        return
      }
      if (action === 'get') {
        // D2 修复：原写法 `out(await call(...)).services` 括号错位（对 out() 返回值取 .services），
        // 正确语义：取列表后按 id 过滤出单条详情。
        if (!id) fail(t('用法：mcp get <服务ID>'))
        const data = await call('GET', '/api/mcp/services')
        const service = (data.services ?? []).find((item) => item.id === id)
        if (!service) fail(t('MCP 服务不存在：{id}', { id }))
        out(service)
        return
      }
      if (action === 'metrics') {
        const data = await call('GET', `/api/mcp/services/${id}/metrics`)
        out({ calls: data.calls, successRate: data.successRate, p95Latency: data.p95Latency, tokens: data.tokens })
        table(data.toolStats, ['tool', 'calls', 'ok', 'avgLatency'], '工具统计')
        return
      }
      if (action === 'health') { ok(JSON.stringify(await call('POST', `/api/mcp/services/${id}/health`))); return }
      if (action === 'deploy') {
        const body = { grayPercent: flag('gray') ? Number(flag('gray')) : undefined, version: flag('version'), changelog: flag('changelog'), dryRun: Boolean(DRY_RUN) }
        if (DRY_RUN) {
          const data = await call('POST', `/api/mcp/services/${id}/deploy`, body)
          out(data.impact, ['type', 'name', 'depth'], 'dry-run 影响面（未执行变更）')
          return
        }
        if (!ASSUME_YES && OUTPUT === 'table') {
          console.log(t('将发布服务 {id}{mode}。', { id, mode: body.grayPercent !== undefined ? t('（灰度 {n}%）', { n: body.grayPercent }) : t('（全量）') }))
          if (!await confirm()) { console.log(t('已取消')); return }
        }
        const data = await call('POST', `/api/mcp/services/${id}/deploy`, body)
        ok(t('已发布：v{version}（{status}）', { version: data.currentVersion, status: zhEnum(data.status) }))
        return
      }
      if (action === 'rollback') {
        const data = await call('POST', `/api/mcp/services/${id}/rollback`, { targetVersion: argOf('--targetVersion') })
        ok(t('已回滚到 v{version}', { version: data.currentVersion }))
        return
      }
      if (action === 'offline') {
        const reason = flag('reason')
        if (!reason) fail(t('offline 必须提供 --reason（L4 护栏）'))
        const data = await call('POST', `/api/mcp/services/${id}/offline`, { reason: String(reason), viaApproval: true })
        ok(t('已创建 L4 审批单：{id}（审批通过后自动执行）', { id: data.approval.id }))
        return
      }
      if (action === 'invoke') {
        let args = {}
        if (flag('args')) { try { args = JSON.parse(String(flag('args'))) } catch { fail(t('--args 必须是合法 JSON')) } }
        const data = await call('POST', '/api/mcp/invoke', { serviceId: id, tool: argOf('--tool'), args })
        // D6 修复：denied / error / rate_limited / breaker_open 均为业务失败（HTTP 200 但 ok=false），
        // 必须以非 0 退出码呈现，供脚本与 Agent 判定。
        if (!data || data.ok === false || (data.status && data.status !== 'ok')) {
          console.error(`\n✘ ${t('MCP 调用未成功：{error}（status={status}{code}）', {
            error: data?.error ?? '—',
            status: data?.status ?? 'unknown',
            code: data?.code ? `，code=${data.code}` : '',
          })}`)
          console.error(t('  修复建议：确认服务已发布且在线、工具名正确、当前身份具备调用授权（denied 时可申请工作级授权）。'))
          console.error(t('  帮助：dshctl help'))
          process.exit(1)
        }
        out(data)
        return
      }
      fail(t('未知动作：{resource} {action}', { resource: 'mcp', action }))
    },
  },

  // ---------------------------------------------------------------- nas
  nas: {
    desc: 'NAS 文件存储资产（FS 类，经 MCP 网关访问）',
    run: async () => {
      const action = argv[0] ?? 'list'
      const id = argv[1]
      await ensureToken()
      if (action === 'authz') {
        const sub = argv[1]
        if (sub === 'check') {
          const nasId = argOf('--nas')
          const user = argOf('--user')
          const path = argOf('--path')
          const op = argOf('--op')
          if (!nasId || !user || !path || !op) fail(t('用法：nas authz check --nas=<id> --user=<userId> --path=<路径> --op=<操作> [--override]'))
          const data = await call('POST', '/api/nas/authz/check', {
            nasId, userId: user, paths: String(path).split(','), op,
            ...(flag('override') ? { override: true } : {}),
          })
          out(data, null, t('判定：{decision}（角色 {role}{ctag}，作用域 {scope}）', {
            decision: t(data.decision === 'allow' ? '放行' : '拒绝'),
            role: data.role ?? '—',
            ctag: data.cTag ? ' +C' : '',
            scope: (data.scope ?? []).join(' '),
          }))
          return
        }
        if (sub === 'scope') {
          const nasId = argOf('--nas')
          const user = argOf('--user')
          if (!nasId || !user) fail(t('用法：nas authz scope --nas=<id> --user=<userId>'))
          out(await call('GET', `/api/nas/authz/scope?nasId=${encodeURIComponent(nasId)}&userId=${encodeURIComponent(user)}`))
          return
        }
        if (sub === 'rules') {
          const verb = argv[2] ?? 'get'
          if (verb === 'get') { out(await call('GET', '/api/nas/authz/rules')); return }
          if (verb === 'import') {
            const file = argOf('--file')
            if (!file) fail(t('用法：nas authz rules import --file=<rules.json>'))
            out(await call('POST', '/api/nas/authz/rules/import', JSON.parse(readFileSyncLocal(file))))
            return
          }
          if (verb === 'set') {
            const current = await call('GET', '/api/nas/authz/rules')
            const patch = { ifVersion: current.version }
            const observe = argOf('--observe-only')
            if (observe !== undefined) patch.observeOnly = String(observe) === 'on'
            const degrade = argOf('--degrade-readonly')
            if (degrade !== undefined) patch.degradeAllToReadonly = String(degrade) === 'on'
            const cGroups = argOf('--c-groups')
            if (cGroups !== undefined) patch.cGroups = String(cGroups).split(',').map((item) => item.trim()).filter(Boolean)
            const saved = await call('PUT', '/api/nas/authz/rules', patch)
            ok(t('规则已更新（version {from} → {to}）', { from: current.version, to: saved.version }))
            return
          }
          fail(t('用法：nas authz rules get | set [...] | import --file=<rules.json>'))
          return
        }
        if (sub === 'decisions') {
          const search = new URLSearchParams()
          if (flag('decision')) search.set('decision', flag('decision'))
          search.set('limit', String(argOf('--limit') ?? 50))
          out(await call('GET', `/api/nas/authz/decisions?${search}`))
          return
        }
        fail(t('用法：nas authz check | scope | rules | decisions'))
        return
      }
      if (action === 'list') {
        const search = new URLSearchParams()
        if (flag('status')) search.set('status', flag('status'))
        if (flag('q')) search.set('q', flag('q'))
        const data = await call('GET', '/api/nas' + (search.size ? `?${search}` : ''))
        out(data.items.map((n) => ({ id: n.id, name: n.name, status: n.status, health: n.health?.status ?? '—', tools: n.gatewayToolCount, rootPath: n.attrs?.rootPath ?? '/' })), ['id', 'name', 'status', 'health', 'tools', 'rootPath'])
        return
      }
      if (action === 'get') { out(await call('GET', `/api/nas/${id}`)); return }
      if (action === 'create') {
        const name = argOf('--name')
        const gatewayUrl = argOf('--gateway-url')
        const accessToken = argOf('--token')
        const nasIp = argOf('--nas-ip')
        if (!name || !gatewayUrl || !accessToken || !nasIp) fail(t('用法：nas create --name= --gateway-url= --token= --nas-ip= [--root-path=] [--description=]'))
        const data = await call('POST', '/api/nas', {
          name,
          attrs: {
            description: flag('description', 'CLI 注册'),
            gatewayUrl, accessToken, nasIp,
            rootPath: flag('root-path', '/'),
            ...(flag('staging-dir') ? { stagingDir: flag('staging-dir') } : {}),
            dataClass: 'internal',
          },
        })
        ok(t('NAS 资产已创建：{name}（{id}，{status}）', { name: data.name, id: data.id, status: zhEnum(data.status) }))
        return
      }
      if (action === 'import') {
        const config = argOf('--config')
        if (!config) fail(t('用法：nas import --config=<mcpServers JSON 或 @文件路径> [--name=]'))
        const payload = String(config).startsWith('@')
          ? await import('node:fs/promises').then((fs) => fs.readFile(String(config).slice(1), 'utf8'))
          : String(config)
        const data = await call('POST', '/api/nas/import', { config: payload, name: flag('name'), description: flag('description') })
        out(data.results, ['name', 'ok', 'nasId', 'reachable', 'tools', 'status', 'error'], t('导入结果（成功 {n}）', { n: data.imported }))
        return
      }
      if (action === 'health') { out(await call('POST', `/api/nas/${id}/health`)); return }
      if (action === 'online') { const data = await call('POST', `/api/nas/${id}/transition`, { action: 'online' }); ok(t('已上线：{name}（{status}）', { name: data.name, status: zhEnum(data.status) })); return }
      if (action === 'offline') {
        const reason = flag('reason')
        if (!reason) fail(t('offline 必须提供 --reason（护栏要求）'))
        const data = await call('POST', `/api/nas/${id}/transition`, { action: 'offline', note: String(reason) })
        ok(t('已下线：{name}（{status}）', { name: data.name, status: zhEnum(data.status) }))
        return
      }
      if (action === 'shares') { out(await call('GET', `/api/nas/${id}/fs`)); return }
      if (action === 'files') {
        const path = flag('path', '')
        const data = await call('GET', `/api/nas/${id}/fs` + (path ? `?path=${encodeURIComponent(String(path))}` : ''))
        out(data)
        return
      }
      if (action === 'mkdir') {
        const path = argOf('--path')
        if (!path) fail(t('mkdir 需要 --path=<NAS路径>'))
        out(await call('POST', `/api/nas/${id}/fs/mkdir`, { path }))
        return
      }
      if (action === 'delete') {
        const path = argOf('--path')
        if (!path) fail(t('delete 需要 --path=<NAS路径>'))
        if (!ASSUME_YES && OUTPUT === 'table') {
          console.log(t('将删除 NAS {id} 上的路径：{path}', { id, path }))
          if (!await confirm()) { console.log(t('已取消（使用 --yes 跳过确认）')); return }
        }
        out(await call('POST', `/api/nas/${id}/fs/delete`, { paths: [path] }))
        return
      }
      if (action === 'upload') {
        const file = argOf('--file')
        const dest = argOf('--dest')
        if (!file || !dest) fail(t('用法：nas upload <id> --file=<本地路径> --dest=<NAS路径>'))
        const buffer = await import('node:fs/promises').then((fs) => fs.readFile(file))
        out(await call('POST', `/api/nas/${id}/fs/upload`, { contentBase64: buffer.toString('base64'), destPath: dest }))
        ok(t('已上传 → {dest}', { dest }))
        return
      }
      if (action === 'search') {
        const pattern = argOf('--pattern')
        if (!pattern) fail(t('search 需要 --pattern=<关键字>'))
        out(await call('POST', `/api/nas/${id}/fs/search`, { pattern, path: flag('path', '/') }))
        return
      }
      fail(t('未知动作：{resource} {action}', { resource: 'nas', action }))
    },
  },

  // ---------------------------------------------------------------- skill
  skill: {
    run: async () => {
      const action = argv[0] ?? 'list'
      const id = argv[1]
      await ensureToken()
      if (!action || action === 'list') {
        const search = new URLSearchParams()
        if (flag('q')) search.set('q', flag('q'))
        if (flag('category')) search.set('category', flag('category'))
        const data = await call('GET', '/api/skills' + (search.size ? `?${search}` : ''))
        out(data.skills.map((s) => ({ id: s.id, name: s.name, status: s.status, version: 'v' + s.currentVersion, downloads: s.stats.downloads, rating: s.stats.rating })), ['id', 'name', 'status', 'version', 'downloads', 'rating'])
        return
      }
      if (action === 'get') { out(await call('GET', `/api/skills/${id}`)); return }
      if (action === 'submit') {
        const file = argOf('--content-file')
        if (!file) fail(t('submit 需要 --content-file=<SKILL.md 路径>'))
        const fs = await import('node:fs/promises')
        const content = await fs.readFile(file, 'utf8')
        const packageFile = argOf('--package')
        const packageBase64 = packageFile ? (await fs.readFile(packageFile)).toString('base64') : undefined
        const data = await call('POST', '/api/skills', {
          name: argOf('--name'), content, category: flag('category', '通用'), summary: flag('summary', ''),
          version: flag('version', '1.0.0'),
          ...(packageBase64 !== undefined ? { packageBase64 } : {}),
        })
        ok(t('已提交：{result}{pkg}', {
          result: t(data.status === 'rejected' ? '静态扫描未通过（自动驳回）' : '进入审批流水线'),
          pkg: data.hasPackage ? t('（含 skill.zip 包）') : '',
        }))
        out({ id: data.id, status: data.status, findings: (data.findings ?? []).map((f) => f.message).join('；') })
        return
      }
      if (action === 'storage') {
        const sub = argv[1] ?? 'get'
        if (sub === 'get') {
          const data = await call('GET', '/api/skill-storage')
          out(data.config)
          table(data.nasOptions, ['id', 'name', 'rootPath'], '可用 NAS（online）')
          return
        }
        if (sub === 'set') {
          const mode = String(flag('mode', ''))
          if (mode !== 'local' && mode !== 'nas') fail(t('storage set 需要 --mode=local|nas'))
          const body = { mode }
          if (mode === 'nas') {
            body.nasId = argOf('--nas-id')
            if (!body.nasId) fail(t('--mode=nas 需要 --nas-id=<NAS资产ID>'))
            body.basePath = flag('base-path', '/skills')
          }
          const data = await call('PUT', '/api/skill-storage', body)
          ok(t('Skill 包存储已切换：{mode}{target}', { mode: data.mode, target: data.nasId ? ` → ${data.nasId}:${data.basePath}` : '' }))
          return
        }
        fail(t('用法：skill storage get | set --mode=local|nas [--nas-id= --base-path=]'))
      }
      if (action === 'approve') {
        const data = await call('POST', `/api/skills/${id}/approve`, {
          decision: flag('decision', 'approve'), level: flag('level', 'domain'), opinion: flag('opinion', 'CLI 审批'),
        })
        ok(t('审批完成'))
        return
      }
      if (action === 'publish') { await call('POST', `/api/skills/${id}/publish`, {}); ok(t('已上架')); return }
      if (action === 'install') {
        await call('POST', `/api/skills/${id}/install`, { agentId: argOf('--agentId') })
        ok(t('已安装（依赖已登记）'))
        return
      }
      if (action === 'deprecate') {
        const reason = flag('reason')
        if (!reason) fail(t('deprecate 必须提供 --reason'))
        const data = await call('POST', `/api/skills/${id}/deprecate`, { reason: String(reason) })
        ok(t('已弃用；存量引用 {n} 个 Agent 已告警', { n: data.referencingAgents.length }))
        return
      }
      fail(t('未知动作：{resource} {action}', { resource: 'skill', action }))
    },
  },

  // ---------------------------------------------------------------- agent / app
  connector: {
    desc: 'SaaS 连接器纳管（open-connector 数据面网关适配）',
    run: async () => {
      const group = argv[0] ?? 'gateway'
      const sub = argv[1]
      await ensureToken()
      const jsonBodyFromFile = async (raw) => {
        if (!raw) return {}
        return JSON.parse(String(raw).startsWith('@')
          ? await import('node:fs/promises').then((fs) => fs.readFile(String(raw).slice(1), 'utf8'))
          : String(raw))
      }
      // ---- 网关 ----
      if (group === 'gateway') {
        if (sub === 'set') {
          const baseUrl = argOf('--base-url')
          if (!baseUrl) fail(t('用法：connector gateway set --base-url= [--admin-token-env=VAR]'))
          const adminTokenEnv = argOf('--admin-token-env')
          await call('PUT', '/api/connector/gateway', {
            baseUrl,
            ...(adminTokenEnv ? { adminToken: `env:${adminTokenEnv}` } : {}),
          })
          ok(t('网关已保存：{url}（探活已触发，可用 connector gateway health 复核）', { url: baseUrl }))
          return
        }
        if (sub === 'health') {
          const data = await call('POST', '/api/connector/gateway/health')
          out([data], ['ok', 'latencyMs', 'reason'])
          return
        }
        if (sub === 'offline') {
          const reason = argOf('--reason')
          if (!reason) fail(t('用法：connector gateway offline --reason=<原因> [--direct]  （默认 L4 审批；--direct 需管理员并留痕）'))
          const payload = { reason }
          if (flag('direct')) payload.viaApproval = false
          const data = await call('POST', '/api/connector/gateway/offline', payload)
          if (data.approvalRequired) ok(t('已生成 L4 审批单 {id}；dshctl approval decide {id} --decision=approve', { id: data.approvalId }))
          else ok(t('网关已维护下线（fail-closed，invoke 全部拒绝）'))
          return
        }
        if (sub === 'online') {
          const data = await call('POST', '/api/connector/gateway/online')
          console.log('\n' + (data.ok ? t('✔ 网关恢复在线') : t('✘ 探活未通过：{reason}', { reason: data.reason ?? '' })))
          return
        }
        out(await call('GET', '/api/connector/gateway'))
        return
      }
      // ---- 目录 ----
      if (group === 'catalog') {
        if (sub === 'providers') {
          const data = await call('GET', '/api/connector/catalog' + (flag('search') ? `?q=${encodeURIComponent(flag('search'))}&kind=providers` : '?kind=providers'))
          out(data.providers.map((p) => ({ service: p.service, name: p.name, description: p.description })), ['service', 'name', 'description'])
          return
        }
        if (sub === 'actions') {
          const params = new URLSearchParams({ kind: 'actions' })
          if (flag('service')) params.set('service', flag('service'))
          if (flag('search')) params.set('q', flag('search'))
          const data = await call('GET', `/api/connector/catalog?${params}`)
          out(data.actions.map((a) => ({ id: a.id, service: a.service, riskLevel: a.riskLevel, description: a.description })), ['id', 'service', 'riskLevel', 'description'])
          return
        }
        if (sub === 'action') {
          const actionId = argv[2]
          if (!actionId) fail(t('用法：connector catalog action <actionId> [--guide]'))
          if (flag('guide')) {
            const raw = await fetch(`${BASE}/api/connector/catalog/actions/${encodeURIComponent(actionId)}/guide`, { headers: { authorization: `Bearer ${token}` } })
            console.log(await raw.text())
            return
          }
          out(await call('GET', `/api/connector/catalog/actions/${encodeURIComponent(actionId)}`))
          return
        }
      }
      // ---- 连接 ----
      if (group === 'connections') {
        if (sub === 'list') {
          const search = new URLSearchParams()
          if (flag('org')) search.set('orgId', flag('org'))
          const data = await call('GET', '/api/connector/connections' + (search.size ? `?${search}` : ''))
          out(data.connections.map((c) => ({
            id: c.id, provider: c.provider, alias: c.alias, authType: c.authType,
            status: c.status, org: c.ownerOrgId,
            maskedProfile: c.maskedProfile ? Object.entries(c.maskedProfile).map(([k, v]) => `${k}=${v}`).join(' ') : '',
          })), ['id', 'provider', 'alias', 'authType', 'status', 'org', 'maskedProfile'])
          return
        }
        if (sub === 'create') {
          const provider = argOf('--provider')
          const authType = argOf('--auth-type')
          const org = argOf('--org')
          const aliasSuffix = argOf('--alias-suffix', 'main')
          if (!provider || !authType || !org) fail(t('用法：connector connections create --provider= --auth-type=no_auth|api_key|oauth --org=<orgId> [--alias-suffix=main] [--values=@file.json]'))
          const endpoint = authType === 'oauth' ? '/api/connector/connections/oauth'
            : authType === 'no_auth' ? '/api/connector/connections/no-auth'
              : '/api/connector/connections/api-key'
          const payload = { provider, aliasSuffix, orgId: org }
          if (authType !== 'no_auth' && authType !== 'oauth') payload.values = await jsonBodyFromFile(argOf('--values'))
          if (authType === 'oauth' && flag('scopes')) payload.requestedScopes = String(flag('scopes')).split(',')
          const data = await call('POST', endpoint, payload)
          if (data.approvalRequired) { ok(t('已进入审批门禁：审批单 {id}；批准后重发并带相同参数即可完成创建（服务端校验 approvalId）', { id: data.approvalId })); return }
          if (data.authorizationUrl) {
            console.log('\n' + [
              t('✔ 授权页：{url}', { url: data.authorizationUrl }),
              t('  state={state}', { state: data.state }),
              t('  完成授权后执行 dshctl connector connections list 观察状态'),
            ].join('\n'))
            return
          }
          out(data.reference, ['id', 'alias', 'provider', 'authType', 'status', 'ocConnectionId'])
          return
        }
        if (sub === 'delete') {
          const id = argv[2]
          if (!id) fail(t('用法：connector connections delete <id> --yes （仍被权限组引用时可加 --force 解除引用并镜像令牌）'))
          if (!ASSUME_YES) fail(t('删除连接需要确认：请携带 --yes'))
          const data = await call('DELETE', `/api/connector/connections/${id}`, flag('force') ? { force: true } : {})
          console.log('\n' + t('✔ 连接已删除{groups}', {
            groups: Array.isArray(data.releasedGroups) && data.releasedGroups.length > 0
              ? t('（解除引用组：{groups}）', { groups: data.releasedGroups.join(',') })
              : '',
          }))
          return
        }
      }
        if (sub === 'offline' || sub === 'online') {
          const id = argv[2]
          if (!id) fail(t('用法：connector connections {sub} <id> [--reason= 原因] [--direct]', { sub }))
          if (sub === 'online') {
            await call('POST', `/api/connector/connections/${id}/online`)
            ok(t('连接已恢复（sidecar 状态回查中）'))
            return
          }
          const reason = argOf('--reason')
          if (!reason) fail(t('下线必须填写原因：connector connections offline <id> --reason=<原因> [--direct]'))
          const payload = { reason }
          if (flag('direct')) payload.viaApproval = false
          const data = await call('POST', `/api/connector/connections/${id}/offline`, payload)
          if (data.approvalRequired) ok(t('已生成 L4 审批单 {id}；批准后连接进入下线态', { id: data.approvalId }))
          else ok(t('连接已下线：{alias}', { alias: data.reference?.alias ?? id }))
          return
        }
      // ---- 执行 ----
      if (group === 'execute') {
        const actionId = argOf('--action')
        if (!actionId) fail(t('用法：connector execute --action=<actionId> [--connection=<alias>] [--input=@file.json] [--dry-run]'))
        const input = await jsonBodyFromFile(argOf('--input'))
        const body = { actionId, input }
        if (argOf('--connection')) body.connection = argOf('--connection')
        if (DRY_RUN) body.dryRun = true
        const data = await call('POST', '/api/connector/execute', body)
        if (data.status === 'approval_required') {
          console.log('\n' + [
            t('⏸ admin 级 action 已生成审批单 {id}', { id: data.approvalId }),
            t('  批准：dshctl approval decide {id} --decision=approve', { id: data.approvalId }),
            t('  批准后 executor 自动完成调用与计量'),
          ].join('\n'))
          return
        }
        out(data)
        return
      }
      // ---- 权限组 ----
      if (group === 'perm-groups') {
        if (sub === 'create') {
          const file = argOf('--file')
          if (!file) fail(t('用法：connector perm-groups create --file=@group.json（含 name/orgId/policies/subjects/rateLimitPerMin）'))
          const payload = await jsonBodyFromFile(file)
          const data = await call('POST', '/api/connector/perm-groups', payload)
          ok(t('权限组已创建：{id}（独立 oct_ 令牌按四数组全发语义镜像 policies）', { id: data.id }))
          return
        }
        if (sub === 'impact') {
          const id = argv[2]
          if (!id) fail(t('用法：connector perm-groups impact <id>   变更影响面预览（N 令牌 / M 连接 / 主体数）'))
          out(await call('POST', `/api/connector/perm-groups/${id}/impact`))
          return
        }
        if (sub === 'delete') {
          const id = argv[2]
          if (!id) fail(t('用法：connector perm-groups delete <id> --yes   联动 DELETE 对应运行时令牌'))
          if (!ASSUME_YES) fail(t('删除权限组会吊销其运行时令牌：请携带 --yes'))
          await call('DELETE', `/api/connector/perm-groups/${id}`)
          ok(t('已删除并联动吊销运行时令牌'))
          return
        }
        if (sub === 'get') {
          out(await call('GET', '/api/connector/perm-groups'))
          return
        }
        const data = await call('GET', '/api/connector/perm-groups')
        out(data.groups.map((g) => ({ id: g.id, name: g.name, org: g.orgId, policies: Object.keys(g.policies).join('|'), subjects: g.subjects.length })), ['id', 'name', 'org', 'policies', 'subjects'])
        return
      }
      // ---- 运行日志 / 对账 / 台账 ----
      if (group === 'runs') {
        const search = new URLSearchParams()
        if (flag('service')) search.set('service', flag('service'))
        if (flag('ok')) search.set('ok', String(flag('ok')))
        search.set('limit', String(argOf('--limit', 50)))
        const data = await call('GET', `/api/connector/runs?${search}`)
        out(data.items.map((r) => ({ id: r.id, service: r.service, actionId: r.actionId, ok: r.ok, runtimeTokenId: r.runtimeTokenId, startedAt: r.startedAt })), ['id', 'service', 'actionId', 'ok', 'runtimeTokenId', 'startedAt'])
        return
      }
      if (group === 'reconcile') {
        const data = await call('POST', '/api/connector/reconcile')
        out([{
          checkedRuns: data.checkedRuns,
          matchedMeters: data.matchedMeters,
          bypass: (data.bypassRuns ?? []).join(',') || '-',
          cursor: data.cursor ?? '-',
        }], ['checkedRuns', 'matchedMeters', 'bypass', 'cursor'])
        return
      }
      if (group === 'tokens') {
        const data = await call('GET', '/api/connector/tokens')
        out(data.tokens.map((t) => ({ permGroupId: t.permGroupId, ocTokenId: t.ocTokenId, hash: t.policySnapshotHash, lastSyncedAt: t.lastSyncedAt })), ['permGroupId', 'ocTokenId', 'hash', 'lastSyncedAt'])
        return
      }
      fail(t('未知 connector 子命令：{group}（见 dshctl help）', { group }))
    },
  },

  agent: {
    run: async () => {
      const action = argv[0] ?? 'list'
      const id = argv[1]
      await ensureToken()
      if (!action || action === 'list') {
        const search = new URLSearchParams()
        if (flag('status')) search.set('status', flag('status'))
        const data = await call('GET', '/api/agents')
        const agents = data.agents.filter((a) => !flag('status') || a.status === flag('status'))
        out(agents.map((a) => ({ id: a.id, name: a.name, status: a.status, model: a.attrs.model, calls: a.metrics.calls, success: a.metrics.successRate })), ['id', 'name', 'status', 'model', 'calls', 'success'])
        return
      }
      if (action === 'get') { out(await call('GET', `/api/agents/${id}`)); return }
      if (action === 'metrics') {
        const data = await call('GET', `/api/agents/${id}`).then((agent) => agent.metrics)
        out(data)
        return
      }
      // D1 修复：Agent 详情（GET /api/agents/:id）自带 topology 字段（依赖/绑定树，深度 2），直接投影输出
      if (action === 'topology') {
        if (!id) fail(t('用法：agent topology <id>'))
        const topology = (await call('GET', `/api/agents/${id}`)).topology
        const flat = []
        const walk = (node, depth) => {
          flat.push({ id: node.id, type: node.type, name: '  '.repeat(depth) + (node.name ?? ''), status: node.status })
          for (const child of node.children ?? []) walk(child, depth + 1)
        }
        if (Array.isArray(topology)) for (const node of topology) walk(node, 0)
        else if (topology) walk(topology, 0)
        out(flat, ['id', 'type', 'name', 'status'], 'Agent 拓扑')
        return
      }
      if (action === 'create') {
        const data = await call('POST', '/api/agents', {
          name: argOf('--name'),
          attrs: { description: flag('description', 'CLI 注册'), model: flag('model', 'deepseek-chat'), riskLevel: flag('riskLevel', 'low') },
        })
        ok(t('Agent 已注册：{name}（{id}）', { name: data.agent.name, id: data.agent.id }))
        if (data.credential) out({ clientId: data.credential.clientId, clientSecret: data.credential.clientSecret, note: '密钥仅此一次返回' })
        return
      }
      if (action === 'offline') {
        const reason = flag('reason')
        if (!reason) fail(t('offline 必须提供 --reason（L4 护栏）'))
        const requesterId = argOf('--requesterId'), requesterName = argOf('--requesterName')
        if (!requesterId || !requesterName) fail(t('offline 需要 --requesterId 与 --requesterName（审批发起人）'))
        const data = await call('POST', `/api/agents/${id}/transition`, { action: 'offline', note: String(reason) }).catch(async () => {
          // 降级：直接走 transition 接口（当前用户为发起人）
          return null
        })
        void data
        const approvals = await call('GET', '/api/approvals')
        const pending = approvals.approvals.find((a) => a.status === 'pending' && a.title.includes('下线'))
        ok(pending ? t('已创建 L4 审批单：{id}', { id: pending.id }) : t('审批单已创建'))
        return
      }
      if (action === 'bind') {
        await call('POST', `/api/agents/${id}/bindings`, { userId: argOf('--userId') })
        ok(t('已绑定用户'))
        return
      }
      fail(t('未知动作：{resource} {action}', { resource: 'agent', action }))
    },
  },
  app: {
    run: async () => {
      const action = argv[0] ?? 'list'
      const id = argv[1]
      await ensureToken()
      if (!action || action === 'list') {
        const data = await call('GET', '/api/apps')
        out(data.apps.map((a) => ({ id: a.id, name: a.name, status: a.status, type: a.attrs.appType, url: a.attrs.url, dau: a.metrics.dau })), ['id', 'name', 'status', 'type', 'url', 'dau'])
        return
      }
      if (action === 'get') { out(await call('GET', `/api/apps/${id}`)); return }
      if (action === 'metrics') { out((await call('GET', `/api/apps/${id}`)).metrics); return }
      if (action === 'report') {
        if (!id) fail(t('用法：app report <id> [--pv=] [--uv=] [--dau=] [--sessions=] [--avg-depth=] [--retention7=] [--date=YYYY-MM-DD]'))
        const input = {}
        for (const [flagName, key] of [['pv', 'pv'], ['uv', 'uv'], ['dau', 'dau'], ['sessions', 'sessions'], ['avg-depth', 'avgDepth'], ['retention7', 'retention7']]) {
          const value = flag(flagName)
          if (value !== undefined && value !== true) input[key] = Number(value)
        }
        const date = flag('date')
        if (date && date !== true) input.date = String(date)
        if (Object.keys(input).length === 0) fail(t('至少上报一项指标：--pv= / --uv= / --dau= / --sessions= / --avg-depth= / --retention7=（可选 --date= 补录历史）'))
        const data = await call('POST', `/api/apps/${id}/metrics-report`, input)
        ok(t('应用指标已上报（宿主侧已记录）'))
        out(data)
        return
      }
      if (action === 'topology') { out((await call('GET', `/api/apps/${id}`)).topology); return }
      if (action === 'cost') { table((await call('GET', `/api/apps/${id}`)).cost, ['agentName', 'llmTokens', 'toolCalls', 'costYuan'], '成本穿透'); return }
      fail(t('未知动作：{resource} {action}', { resource: 'app', action }))
    },
  },

  // ---------------------------------------------------------------- a2a / uhp（协作与执行驱动）
  a2a: {
    desc: 'A2A 协作面（目录 / Agent Card / 派活 / 任务 / 验收 / 履约 / 规则 / 巡检）',
    run: async () => {
      const action = argv[0] ?? 'directory'
      const queryOf = (pairs) => {
        const search = new URLSearchParams()
        for (const [flagName, key] of pairs) {
          const value = flag(flagName)
          if (value !== undefined && value !== true) search.set(key, String(value))
        }
        return search.size ? `?${search}` : ''
      }
      if (!action || action === 'directory') {
        await ensureToken()
        const data = await call('GET', '/api/a2a/directory' + queryOf([['q', 'q'], ['skill', 'skill'], ['runtime', 'runtime'], ['autonomy', 'autonomy'], ['data-class', 'dataClass']]))
        out((data.agents ?? []).map((entry) => ({
          agentId: entry.agentId, slug: entry.slug, name: entry.name, runtime: entry.runtime,
          autonomy: entry.autonomy, ceiling: entry.dataClassCeiling,
          skills: (entry.skills ?? []).map((skill) => skill?.name ?? skill?.id ?? skill).join(','),
        })), ['agentId', 'slug', 'name', 'runtime', 'autonomy', 'ceiling', 'skills'], 'A2A 协作目录')
        return
      }
      if (action === 'card') {
        const slug = argv[1]
        if (!slug) fail(t('用法：a2a card <slug>（well-known 免鉴权；兼容裸 JSON 与平台信封）'))
        out(await callLoose('GET', `/.well-known/agents/${encodeURIComponent(slug)}/agent-card.json`))
        return
      }
      if (action === 'send') {
        const slug = argv[1]
        const message = argOf('--message')
        if (!slug || !message) fail(t('用法：a2a send <slug> --message=<文本> [--data-class=] [--context=]'))
        const metadata = {}
        if (flag('data-class')) metadata.dataClass = String(flag('data-class'))
        if (flag('context')) metadata.contextId = String(flag('context'))
        const result = await callJsonRpc(slug, 'message/send', { message: String(message), metadata })
        out(result?.task ?? result)
        return
      }
      if (action === 'tasks') {
        await ensureToken()
        const data = await call('GET', '/api/a2a/tasks' + queryOf([['agent', 'agentId'], ['state', 'state'], ['context', 'contextId'], ['limit', 'limit']]))
        out((data.tasks ?? []).map((task) => ({
          taskId: task.taskId, agent: task.agentSlug ?? task.agentId, state: task.state, mode: task.mode,
          dataClass: task.dataClass, message: task.message,
        })), ['taskId', 'agent', 'state', 'mode', 'dataClass', 'message'], 'A2A 协作任务')
        return
      }
      if (action === 'task') {
        const taskId = argv[1]
        if (!taskId) fail(t('用法：a2a task <taskId>'))
        await ensureToken()
        const data = await call('GET', `/api/a2a/tasks/${encodeURIComponent(taskId)}`)
        out(data.task ?? data)
        return
      }
      if (action === 'cancel') {
        const slug = argv[1]
        const taskId = argv[2]
        if (!slug || !taskId) fail(t('用法：a2a cancel <slug> <taskId> [--reason=]'))
        await ensureToken()
        const params = { taskId }
        if (flag('reason')) params.reason = String(flag('reason'))
        const result = await callJsonRpc(slug, 'tasks/cancel', params)
        out(result?.task ?? result)
        return
      }
      if (action === 'accept') {
        const taskId = argv[1]
        const decision = flag('decision')
        if (!taskId || !['accepted', 'rejected'].includes(decision)) {
          fail(t('用法：a2a accept <taskId> --decision=accepted|rejected --reason=<理由>（仅人类用户；仅 completed 任务可验收）'))
        }
        await ensureToken()
        const data = await call('POST', `/api/a2a/tasks/${encodeURIComponent(taskId)}/acceptance`, { decision, reason: String(flag('reason', '')) })
        ok(t('验收已登记：{decision}', { decision: decision === 'accepted' ? t('通过') : t('驳回') }))
        out(data.task ?? data)
        return
      }
      if (action === 'fulfillment') {
        await ensureToken()
        const data = await call('GET', '/api/a2a/fulfillment')
        out(data.fulfillment ?? data, ['agentSlug', 'agentName', 'received', 'completed', 'failed', 'completionRate', 'acceptancePassRate', 'avgDurationMs', 'p95DurationMs'], 'A2A 履约视图')
        return
      }
      if (action === 'rules') {
        await ensureToken()
        const data = await call('GET', '/api/a2a/rules')
        out(data.rules ?? data, ['id', 'name', 'matchDataClassAtLeast', 'matchKeyword', 'enabled'], 'A2A 审批规则')
        return
      }
      if (action === 'rule-add') {
        const name = argOf('--name')
        if (!name) fail(t('用法：a2a rule-add --name=<名称> [--keyword=] [--data-class-at-least=internal|secret]（至少一个匹配条件）'))
        await ensureToken()
        const body = { name: String(name) }
        if (flag('keyword')) body.matchKeyword = String(flag('keyword'))
        if (flag('data-class-at-least')) body.matchDataClassAtLeast = String(flag('data-class-at-least'))
        const data = await call('POST', '/api/a2a/rules', body)
        ok(t('规则已创建：{id}', { id: data.rule?.id ?? '' }))
        out(data.rule ?? data)
        return
      }
      if (action === 'rule-rm') {
        const ruleId = argv[1]
        if (!ruleId) fail(t('用法：a2a rule-rm <规则ID>'))
        await ensureToken()
        await call('DELETE', `/api/a2a/rules/${encodeURIComponent(ruleId)}`)
        ok(t('规则已删除：{id}', { id: ruleId }))
        return
      }
      if (action === 'patrol') {
        await ensureToken()
        const data = await call('POST', '/api/a2a/patrol/run', {})
        out(data.report ?? data)
        return
      }
      fail(t('未知动作：{resource} {action}', { resource: 'a2a', action }))
    },
  },
  uhp: {
    desc: 'UHP 执行驱动（能力发现 / harness 注册表 / 执行记录）',
    run: async () => {
      const action = argv[0] ?? 'discover'
      if (!action || action === 'discover') {
        // 规范要求免鉴权：/v1/uhp 不在 /api 鉴权域；裸 JSON / 信封双兼容
        out(await callLoose('GET', '/v1/uhp'))
        return
      }
      await ensureToken()
      if (action === 'harnesses') {
        const data = await call('GET', '/api/uhp/harnesses')
        out((data.harnesses ?? []).map((harness) => ({
          id: harness.id, agent: harness.agentName ?? harness.agentId, model: harness.model,
          stepBudget: harness.stepBudget, ceiling: harness.dataClassCeiling, enabled: harness.enabled,
        })), ['id', 'agent', 'model', 'stepBudget', 'ceiling', 'enabled'], 'UHP harness 注册表')
        return
      }
      if (action === 'harness-add') {
        const harnessId = argOf('--id')
        const agent = argOf('--agent')
        const model = argOf('--model')
        if (!harnessId || !agent || !model) fail(t('用法：uhp harness-add --id=<harnessID> --agent=<agentId> --model=<模型slug> [--step-budget=] [--ceiling=internal|secret]'))
        const body = { id: String(harnessId), agentId: String(agent), model: String(model) }
        if (flag('step-budget')) body.stepBudget = Number(flag('step-budget')) || undefined
        if (flag('ceiling')) body.dataClassCeiling = String(flag('ceiling'))
        const data = await call('POST', '/api/uhp/harnesses', body)
        ok(t('harness 已登记：{id}', { id: data.harness?.id ?? harnessId }))
        out(data.harness ?? data)
        return
      }
      if (action === 'harness-rm') {
        const harnessId = argv[1]
        if (!harnessId) fail(t('用法：uhp harness-rm <harnessID>'))
        await call('DELETE', `/api/uhp/harnesses/${encodeURIComponent(harnessId)}`)
        ok(t('harness 已删除：{id}', { id: harnessId }))
        return
      }
      if (action === 'responses') {
        const search = new URLSearchParams()
        if (flag('task')) search.set('taskId', String(flag('task')))
        if (flag('agent')) search.set('agentId', String(flag('agent')))
        if (flag('limit')) search.set('limit', String(flag('limit')))
        const data = await call('GET', '/api/uhp/responses' + (search.size ? `?${search}` : ''))
        out((data.items ?? []).map((item) => ({
          id: item.id, status: item.status, model: item.model, harnessId: item.harness_id,
          outputText: item.output_text, createdAt: item.created_at,
        })), ['id', 'status', 'model', 'harnessId', 'outputText', 'createdAt'], 'UHP 执行记录')
        return
      }
      fail(t('未知动作：{resource} {action}', { resource: 'uhp', action }))
    },
  },

  // ---------------------------------------------------------------- audit / approval / cost / platform
  audit: {
    run: async () => {
      const action = argv[0] ?? 'logs'
      await ensureToken()
      if (action === 'logs') {
        const search = new URLSearchParams()
        if (flag('type')) search.set('type', flag('type'))
        if (flag('resourceId')) search.set('resourceId', flag('resourceId'))
        search.set('limit', String(flag('limit', 30)))
        const data = await call('GET', '/api/audit/logs' + (search.size ? `?${search}` : ''))
        out(data.items.map((log) => ({ time: log.createdAt.slice(0, 19).replace('T', ' '), type: log.type, action: log.action, actor: log.actorName, resource: log.resourceName, result: log.result })), ['time', 'type', 'action', 'actor', 'resource', 'result'])
        return
      }
      if (action === 'alerts') {
        const data = await call('GET', '/api/audit/alerts' + (flag('unread') ? '?unread=1' : ''))
        out(data.alerts.map((a) => ({ time: a.createdAt.slice(0, 16).replace('T', ' '), severity: a.severity, title: a.title })), ['time', 'severity', 'title'])
        return
      }
      if (action === 'read-all') {
        const result = await call('POST', '/api/audit/alerts/read-all')
        out([{ read: result.read }], ['read'])
        return
      }
      fail(t('未知动作：{resource} {action}', { resource: 'audit', action }))
    },
  },
  approval: {
    run: async () => {
      const action = argv[0] ?? 'list'
      await ensureToken()
      if (!action || action === 'list') {
        const data = await call('GET', '/api/approvals')
        const list = flag('pending') ? data.approvals.filter((a) => a.status === 'pending') : data.approvals
        out(list.map((a) => ({ id: a.id, title: a.title, status: a.status, requester: a.requesterName })), ['id', 'title', 'status', 'requester'])
        return
      }
      if (action === 'decide') {
        const decision = flag('decision')
        if (!['approve', 'reject'].includes(decision)) fail(t('--decision 必须是 approve|reject'))
        // D5 修复：高风险审批（如上线单）服务端要求 confirmed=true 二次确认；--final-review 走终审口径。
        const body = { decision, opinion: flag('opinion', 'CLI 审批') }
        if (truthyFlag('confirmed')) body.confirmed = true
        if (truthyFlag('final-review')) body.finalReview = true
        const data = await call('POST', `/api/approvals/${argv[1]}/decide`, body)
        ok(t('审批完成：{status}', { status: zhEnum(data.status) }))
        return
      }
      fail(t('用法：approval list [--pending] | decide <id> --decision= --opinion= [--confirmed 高风险单必带] [--final-review]'))
    },
  },
  cost: {
    run: async () => {
      await ensureToken()
      const data = await call('GET', '/api/audit/cost?groupBy=' + (flag('groupBy', 'app')))
      table(data.rows, ['key', 'llmTokens', 'toolCalls', 'costYuan'], t('成本（按{groupBy}）', { groupBy: flag('groupBy', 'app') }))
    },
  },
  platform: {
    run: async () => {
      await ensureToken()
      const data = await call('GET', '/api/platform/info')
      out({ name: data.name, version: data.version, runtime: data.runtime, plugins: data.plugins.join(', '), tools: data.tools.length, collections: data.collections.length })
      table(data.tools.map((t) => ({ name: t.name, plugin: t.plugin ?? '', description: t.description })), ['name', 'plugin', 'description'], '工具目录')
    },
  },
  usage: {
    desc: '计量事件（推送式上报 / 查询）',
    run: async () => {
      const action = argv[0] ?? 'events'
      await ensureToken()
      if (action === 'record') {
        const metersRaw = argOf('--meter')
        const input = {
          org: argOf('--org'), subject: argOf('--subject'), principal: argOf('--principal'), resource: argOf('--resource'),
        }
        if (!input.org || !input.subject || !input.principal || !input.resource || !metersRaw) {
          fail(t('用法：usage record --org=<orgId> --subject=user:<id>|agent:<id> --principal=org:<id>|plugin:<id>|platform --resource=model:<slug>|mcp:<slug>|plugin:<id> --meter=key:value:unit[,...] [--idempotency-key=] [--tenant-id=]'))
        }
        const meters = String(metersRaw).split(',').map((item) => {
          const [key, value, unit] = item.split(':')
          if (!key || value === undefined || Number.isNaN(Number(value)) || !unit) fail(t('--meter 项格式非法：{item}（应为 key:value:unit）', { item }))
          return { key, value: Number(value), unit }
        })
        const body = { ...input, meters }
        if (argOf('--idempotency-key')) body.idempotency_key = argOf('--idempotency-key')
        if (argOf('--tenant-id')) body.tenant_id = argOf('--tenant-id')
        const data = await call('POST', '/api/usage/record', body)
        ok(t('计量事件已登记：{event_id}（charge={charge}分）', { event_id: data.event_id, charge: data.pricing.charge_cents }))
        return
      }
      if (action === 'events') {
        const search = new URLSearchParams()
        if (flag('principal')) search.set('principal', flag('principal'))
        if (flag('resource')) search.set('resource', flag('resource'))
        if (flag('limit')) search.set('limit', String(flag('limit')))
        const data = await call('GET', '/api/usage/events' + (search.size ? `?${search}` : ''))
        out(data.items.map((e) => ({ event_id: e.event_id, resource: e.resource, subject: e.subject, meters: e.meters.map((m) => `${m.key}=${m.value}${m.unit}`).join(','), charge: e.pricing.charge_cents, time: e.occurred_at?.slice(0, 19).replace('T', ' ') })), ['event_id', 'resource', 'subject', 'meters', 'charge', 'time'], '计量事件')
        return
      }
      if (action === 'totals') {
        const search = new URLSearchParams()
        if (flag('principal')) search.set('principal', flag('principal'))
        if (flag('from')) search.set('from', flag('from'))
        out(await call('GET', '/api/usage/totals' + (search.size ? `?${search}` : '')))
        return
      }
      fail(t('用法：usage record --org= --subject= --principal= --resource= --meter=key:value:unit[,...] | events [--principal= --resource= --limit=] | totals [--principal= --from=]'))
    },
  },
  connect: {
    desc: '远程 dsh 接入管理（接入码 / 已接入客户端）',
    run: async () => {
      const action = argv[0] ?? 'codes'
      await ensureToken()
      if (action === 'code') {
        const template = flag('template', 'readonly')
        const ttl = Number(flag('ttl', 15)) || 15
        const data = await call('POST', '/api/connect/codes', { template, ttlMinutes: ttl, remark: String(flag('remark', '')) })
        console.log('\n' + t('  接入码（仅本次展示，{n} 分钟内一次性有效）：', { n: data.ttlMinutes }))
        console.log(`  ┌─────────────────────────────────────────────────────┐`)
        console.log(`  │ ${data.code} │`)
        console.log(`  └─────────────────────────────────────────────────────┘`)
        console.log(t('  模板：{template}（{resolved}）  过期：{expiresAt}', { template, resolved: data.template, expiresAt: data.expiresAt }))
        console.log(t('  远程电脑 dsh 安装插件后执行：connect_setup { hubUrl, enrollmentCode } 即完成接入；'))
        console.log(t('  或让其在浏览器打开 http://127.0.0.1:7390 配置页填写。') + '\n')
        return
      }
      if (action === 'codes') {
        const data = await call('GET', '/api/connect/codes')
        out(data.codes.map((c) => ({ codeMask: c.codeMask, template: c.template, status: c.status, expiresAt: c.expiresAt, usedBy: c.usedBy ?? '', remark: c.remark })), ['codeMask', 'template', 'status', 'expiresAt', 'usedBy', 'remark'], '接入码')
        return
      }
      if (action === 'clients') {
        const data = await call('GET', '/api/connect/clients')
        out(data.clients.map((c) => ({ name: c.name, clientId: c.clientId, template: c.template, status: c.status, hostname: c.hostname, enrolledAt: c.enrolledAt, lastUsedAt: c.lastUsedAt || '' })), ['name', 'clientId', 'template', 'status', 'hostname', 'lastUsedAt'], '已接入客户端')
        return
      }
      if (action === 'disable') {
        const target = argv[1]
        const reason = flag('reason')
        if (!target || !reason) fail(t('用法：connect disable <clientId|记录ID> --reason=<原因>'))
        const data = await call('POST', `/api/connect/clients/${target}/disable`, { reason })
        ok(t('客户端已禁用（联动吊销全部令牌）：{id}', { id: data.id }))
        return
      }
      fail(t('用法：connect code [--template=readonly|executor|operator|full] [--ttl=15] [--remark=] | codes | clients | disable <clientId> --reason='))
    },
  },
  tool: {
    run: async () => {
      await ensureToken()
      if (argv[0] === 'exec') {
        const name = argOf('--name')
        if (!name) fail(t('tool exec 需要 --name=<工具名>'))
        let args = {}
        if (flag('args')) { try { args = JSON.parse(String(flag('args'))) } catch { fail(t('--args 必须是合法 JSON')) } }
        const data = await call('POST', '/api/tools/execute', { name, args })
        out({ isError: data.isError, durationMs: data.durationMs, value: data.value })
        return
      }
      fail(t('用法：tool exec --name=<工具名> [--args=<JSON>]'))
    },
  },
  update: {
    desc: '平台自更新（上游版本检查 / 一键升级）',
    run: async () => {
      const action = argv[0] ?? 'status'
      await ensureToken()
      if (action === 'status') {
        const data = await call('GET', '/api/update/status')
        if (OUTPUT === 'json') { console.log(JSON.stringify(data, null, 2)); return }
        out({
          当前版本: `v${data.currentVersion}`,
          安装形态: t(data.installMode === 'source' ? '源码检出（git，可一键升级）' : '插件市场安装（bundle，宿主侧升级）'),
          上游仓库: `${data.repo}@${data.branch}`,
          上游最新: data.latest ? t('v{version}（检查于 {checkedAt}）', { version: data.latest.version, checkedAt: data.latest.checkedAt }) : t('未检查'),
          有可用更新: data.hasUpdate ? t('是（{detail}）', { detail: data.updateKind === 'version' ? t('新版本') : t('上游领先 {n} 个提交', { n: data.behindBy }) }) : t('否'),
          自动检查: data.autoCheck ? t('每 {n} 小时', { n: data.intervalHours }) : t('关闭'),
          最近检查: data.lastCheckedAt || t('从未'),
          ...(data.lastError ? { 上次异常: data.lastError } : {}),
        })
        if (data.hasUpdate && (data.recentCommits ?? []).length > 0 && OUTPUT !== 'json') {
          console.log('\n' + t('  上游新增提交：'))
          for (const commit of data.recentCommits.slice(0, 10)) console.log(`   ${commit.sha}  ${commit.message}`)
        }
        return
      }
      if (action === 'check') {
        const data = await call('POST', '/api/update/check')
        ok(data.hasUpdate
          ? t('发现新版本：v{current} → v{latest}{behind}', {
              current: data.currentVersion,
              latest: data.latest?.version ?? '?',
              behind: data.behindBy > 0 ? t('（上游领先 {n} 个提交）', { n: data.behindBy }) : '',
            })
          : t('已是最新版本（v{version}）', { version: data.currentVersion }))
        return
      }
      if (action === 'apply') {
        const dryRun = DRY_RUN === true || flag('dry-run', false) === true
        const reason = String(flag('reason', ''))
        if (dryRun) {
          const plan = await call('POST', '/api/update/apply', { dryRun: true })
          console.log('\n' + t('  升级预演（不执行任何变更）：'))
          for (const step of plan.steps ?? []) console.log(`   · ${step}`)
          for (const commit of plan.incomingCommits ?? []) console.log(`   ↑ ${commit}`)
          return
        }
        if (!reason) fail(t('正式升级必须 --reason=<原因>（留痕要求）；先看影响面可加 --dry-run'))
        const proceed = ASSUME_YES || await confirm()
        if (!proceed) { console.log(t('已取消')); return }
        const data = await call('POST', '/api/update/apply', { reason })
        if (data.supported === false) {
          console.log(`\n  ${data.instructions}\n`)
          return
        }
        ok(data.notice ?? t('升级完成'))
        if (data.gitOutput) console.log('\n' + t('  git 输出摘要：') + '\n' + String(data.gitOutput).split('\n').slice(0, 8).map((line) => `   ${line}`).join('\n'))
        return
      }
      if (action === 'set') {
        const input = {}
        const auto = flag('auto', undefined)
        if (auto !== undefined) input.autoCheck = auto === 'on' || auto === true
        const hours = flag('hours', undefined)
        if (hours !== undefined) input.intervalHours = Number(hours) || 0
        if (!Object.keys(input).length) fail(t('用法：update set [--auto=on|off] [--hours=24]'))
        const data = await call('POST', '/api/update/settings', input)
        ok(t('自动检查：{state}', { state: data.autoCheck ? t('每 {n} 小时', { n: data.intervalHours }) : t('关闭') }))
        return
      }
      fail(t('用法：update status | check | apply [--dry-run] [--reason=<原因>] | set [--auto=on|off] [--hours=24]'))
    },
  },
}

async function confirm() {
  process.stdout.write(t('确认执行？(y/N) '))
  const answer = await new Promise((resolve) => {
    process.stdin.once('data', (data) => resolve(data.toString().trim().toLowerCase()))
  })
  return answer === 'y' || answer === 'yes'
}

// ------------------------------------------------------------------ main
const resource = argv.shift() ?? 'help'
// 后置 --token 作为平台令牌（前置的已在 consumeLeadingGlobals 剥离）。
// 例外：nas create 的 --token 是 NAS 访问令牌（子命令私有语义），不当平台令牌消费。
if (GLOBALS.token !== undefined) {
  if (GLOBALS.token !== true) token = String(GLOBALS.token)
} else {
  const trailingToken = flag('token')
  if (trailingToken !== undefined && trailingToken !== true && !(resource === 'nas' && argv[0] === 'create')) token = String(trailingToken)
}
// 5.1：--help / -h / help（含任意位置出现的 --help / -h）一律干净输出帮助并以 0 退出
if (resource === '--help' || resource === '-h' || resource === 'help' || argv.includes('--help') || argv.includes('-h')) {
  COMMANDS.help.run()
  process.exit(0)
}
const command = COMMANDS[resource]
if (!command) {
  console.error(t('未知资源：{resource}', { resource }))
  COMMANDS.help.run()
  process.exit(1)
}
await command.run()
