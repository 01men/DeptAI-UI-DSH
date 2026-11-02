/**
 * authz-smoke.mjs —— 网关数据权限钩子本地自测（dev-plan-nas-authz §四「网关 authz-smoke」）。
 *
 * 进程内 stub 平台 PDP（无需真实平台/NAS），覆盖：
 * 矩阵正/负向、路径提取（folder_path/path[]/dest_path 三形态）、读缓存/写不缓存、
 * PDP 不可达三级降级（快照→readonly→deny）、熔断进入/恢复、enforce=false 直通、
 * on-behalf 传递正确性、非授信令牌伪造 on-behalf 被拒、工具面 ↔ 操作映射双向一致。
 * 用法：node integrations/synology-filestation-mcp/test/authz-smoke.mjs
 */
import { createServer } from 'node:http'
import { rm, mkdir } from 'node:fs/promises'
import { AuthzClient, opForTool, extractPaths, localScopeCheck, TOOL_OP_MAP } from '../src/authz.js'

const PORT = 7393
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'pdp-selftest-token'
let pdpMode = 'normal' // normal | down | slow
let checkCalls = 0

const pdp = createServer((req, res) => {
  const json = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  if (req.method === 'POST' && req.url.startsWith('/api/auth/client-credentials')) {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const input = JSON.parse(body || '{}')
      if (input.clientId === 'mc_cc' && input.clientSecret === 'cs_cc') {
        return json(200, { ok: true, data: { token: 'cc-token-1', expiresAt: new Date(Date.now() + 3600_000).toISOString() } })
      }
      json(401, { ok: false, error: { message: 'bad credential' } })
    })
    return
  }
  const validTokens = new Set([TOKEN, 'cc-token-1'])
  if (!validTokens.has(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))) return json(401, { ok: false, error: { message: '鉴权失败' } })
  if (req.method === 'GET' && req.url.startsWith('/api/nas/authz/scope')) {
    return json(200, { ok: true, data: { role: 'M', scope: ['/vivo'], matrix: {}, observeOnly: false } })
  }
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (pdpMode === 'down') { try { req.socket.destroy() } catch { /* 已断开 */ } return }
    if (pdpMode === 'slow') { setTimeout(() => json(200, { ok: true }), 5000); return }
    let input
    try { input = JSON.parse(body) } catch { return json(400, { ok: false, error: { message: 'bad json' } }) }
    checkCalls += 1
    const onBehalf = req.headers['x-on-behalf-user']
    // stub 判定：用户 u_read 只读 /vivo/*；u_full 全放行；其余默认 deny
    if (onBehalf === 'u_full') return json(200, { ok: true, data: { decision: 'allow', role: 'D', scope: ['/'], reasons: ['stub.allow'] } })
    if (onBehalf === 'u_read' && (input.op === 'read' || input.op === 'download')) {
      return json(200, { ok: true, data: { decision: 'allow', role: 'M', scope: ['/vivo'], reasons: ['matrix.allow：stub 只读用户'] } })
    }
    return json(200, { ok: true, data: { decision: 'deny', role: 'M', scope: [], reasons: ['matrix.deny：stub 拒绝'] } })
  })
})
await new Promise((resolve) => pdp.listen(PORT, '127.0.0.1', resolve))

const results = []
const check = (name, condition, detail = '') => {
  results.push({ name, pass: Boolean(condition) })
  console.log(`  ${condition ? '✔' : '✘'} ${name}${condition ? '' : ` ← ${detail}`}`)
}

const SNAPSHOT_DIR = new URL('./.authz-snapshots-selftest/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
await rm(SNAPSHOT_DIR, { recursive: true, force: true }).catch(() => {})
await mkdir(SNAPSHOT_DIR, { recursive: true })

const client = new AuthzClient({
  platformBaseUrl: BASE,
  platformToken: TOKEN,
  snapshotDir: SNAPSHOT_DIR,
  checkTimeoutMs: 400,
  cacheTtlMs: 60_000,
  breakerCooldownMs: 300,
})

const trusted = { enforce: true, allowedOnBehalf: true, name: 'hermes-0195' }
const untrusted = { enforce: true, allowedOnBehalf: false, name: 'plain-client' }
const observer = { enforce: false, allowedOnBehalf: true, name: 'legacy-client' }

// 1) 矩阵正/负向 + on-behalf 传递
const allowRead = await client.evaluate({ tool: 'fs_list', args: { folder_path: '/vivo/视频' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
check('矩阵正向：只读用户 read 放行且带 reasons', allowRead.decision === 'allow' && allowRead.reasons.length > 0)
const denyWrite = await client.evaluate({ tool: 'fs_delete', args: { path: ['/vivo/视频/a.mp4'] }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
check('矩阵负向：只读用户 delete 拒绝且透传平台理由', denyWrite.decision === 'deny' && denyWrite.reasons[0].includes('stub 拒绝'))

// 2) 路径提取三形态
check('路径提取：folder_path 字符串（fs_list）', JSON.stringify(extractPaths('fs_list', { folder_path: '/a' })) === '["/a"]')
check('路径提取：path 数组（fs_delete）', JSON.stringify(extractPaths('fs_delete', { path: ['/a/b', '/c'] })) === '["/a/b","/c"]')
check('路径提取：dest_path（fs_upload）', JSON.stringify(extractPaths('fs_upload', { dest_path: '/skillhub', local_file: '/tmp/x.zip' })) === '["/skillhub"]')
check('操作映射：七类全覆盖 + 未知工具恒 deny',
  opForTool('fs_search') === 'read' && opForTool('fs_extract') === 'modify' && opForTool('fs_upload') === 'write' && opForTool('fs_share_link') === null)
const unknownTool = await client.evaluate({ tool: 'fs_share_link', args: { path: '/x' }, tokenEntry: trusted, onBehalfHeader: 'u_full', nasIp: '192.168.0.196' })
check('share/admin 类工具网关侧恒 deny（工具面不存在）', unknownTool.decision === 'deny')

// 2b) 工具面 ↔ 操作映射双向一致（G0 教训：映射面外工具在 observeOnly 下也被 op.unsupported 硬拒）
const GATEWAY_TOOLS = [
  'fs_list', 'fs_list_shares', 'fs_get_info', 'fs_search', 'fs_download',
  'fs_create_folder', 'fs_upload', 'fs_rename', 'fs_copy_move',
  'fs_compress', 'fs_extract', 'fs_delete',
  // 异步任务面：compress/extract/download 落任务后的状态查询与清理（G0 实测漏映射被硬拒后补齐）
  'fs_task_status', 'fs_task_clear',
]
check('工具面一致性：TOOL_OP_MAP 与网关 fs_* 工具清单双向一致（新增工具漏映射即硬拒面）',
  JSON.stringify(Object.keys(TOOL_OP_MAP).sort()) === JSON.stringify([...GATEWAY_TOOLS].sort()),
  `映射表=${Object.keys(TOOL_OP_MAP).sort().join(',')} 清单=${[...GATEWAY_TOOLS].sort().join(',')}`)
check('映射值域合法：全部落在七类操作内；异步任务工具 fs_task_status=read / fs_task_clear=delete',
  Object.values(TOOL_OP_MAP).every((op) => ['read', 'download', 'write', 'modify', 'delete', 'share', 'admin'].includes(op))
    && opForTool('fs_task_status') === 'read' && opForTool('fs_task_clear') === 'delete')

// 3) 读缓存 / 写不缓存
checkCalls = 0
await client.evaluate({ tool: 'fs_list', args: { folder_path: '/vivo' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
await client.evaluate({ tool: 'fs_list', args: { folder_path: '/vivo' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
const cachedReadCalls = checkCalls
checkCalls = 0
await client.evaluate({ tool: 'fs_delete', args: { path: ['/vivo'] }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
await client.evaluate({ tool: 'fs_delete', args: { path: ['/vivo'] }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
check('读缓存命中（第二次不再调 PDP）、写不缓存（每次实判）', cachedReadCalls === 1 && checkCalls === 2, `read=${cachedReadCalls} write=${checkCalls}`)

// 4) enforce=false 观察模式：照常过 PDP 留痕（deny 采集 G0 数据），但不拦截（换未缓存 key）
const observeAllow = await client.evaluate({ tool: 'fs_list', args: { folder_path: '/vivo/观察读' }, tokenEntry: observer, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
check('enforce=false 观察模式：PDP allow 原样放行（observeOnly 标注）', observeAllow.decision === 'allow' && observeAllow.observeOnly === true)
const observeDeny = await client.evaluate({ tool: 'fs_delete', args: { path: ['/观察外'] }, tokenEntry: observer, onBehalfHeader: 'u_read', nasIp: '10.1.0.196' })
check('enforce=false 观察模式：PDP deny 留痕但不拦截（observeOnly 标注）', observeDeny.decision === 'deny' && observeDeny.observeOnly === true)

// 5) 非授信令牌伪造 on-behalf 被拒
const forged = await client.evaluate({ tool: 'fs_list', args: { folder_path: '/vivo' }, tokenEntry: untrusted, onBehalfHeader: 'u_full', nasIp: '192.168.0.196' })
check('非授信令牌伪造 X-On-Behalf-User 被拒', forged.decision === 'deny' && forged.reasons[0].includes('FORGED_ON_BEHALF'))

// 6) 三级降级：先成功拿一次 scope 快照，再断掉 PDP
checkCalls = 0
await client.evaluate({ tool: 'fs_list', args: { folder_path: '/vivo/新目录' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
// 快照写入是异步落盘（refreshSnapshot），等待完成
await new Promise((resolve) => setTimeout(resolve, 300))
pdpMode = 'down'
// 降级判定使用未缓存的新路径（读缓存 TTL 内的同 key 命中会掩盖降级路径）
const snapshotRead = await client.evaluate({ tool: 'fs_list', args: { folder_path: '/vivo/降级读' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
check('三级降级①scope 快照：快照内读放行', snapshotRead.decision === 'allow' && snapshotRead.degraded === 'snapshot', JSON.stringify(snapshotRead))
const snapshotWrite = await client.evaluate({ tool: 'fs_create_folder', args: { folder_path: '/vivo', name: ['x'] }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
check('三级降级①scope 快照：快照内写拒绝', snapshotWrite.decision === 'deny' && snapshotWrite.degraded === 'snapshot')
const snapshotOut = await client.evaluate({ tool: 'fs_list', args: { folder_path: '/降级外读' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
check('三级降级①scope 快照：快照外读拒绝', snapshotOut.decision === 'deny' && snapshotOut.degraded === 'snapshot')

// 7) 无快照用户：readonly 降级（灰度可配）→ 默认 deny
const readonlyClient = new AuthzClient({ platformBaseUrl: BASE, platformToken: TOKEN, snapshotDir: SNAPSHOT_DIR, checkTimeoutMs: 300, degrade: 'readonly' })
const readonlyRead = await readonlyClient.evaluate({ tool: 'fs_list', args: { folder_path: '/x' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '10.0.0.9' })
check('三级降级②readonly（灰度可配）：无快照放行读', readonlyRead.decision === 'allow' && readonlyRead.reasons[0].includes('degraded.readonly'))
const readonlyWrite = await readonlyClient.evaluate({ tool: 'fs_delete', args: { path: ['/x'] }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '10.0.0.9' })
check('三级降级②readonly：写仍拒绝', readonlyWrite.decision === 'deny')
const denyClient = new AuthzClient({ platformBaseUrl: BASE, platformToken: TOKEN, snapshotDir: SNAPSHOT_DIR, checkTimeoutMs: 300, degrade: 'deny' })
const denied = await denyClient.evaluate({ tool: 'fs_list', args: { folder_path: '/x' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '10.0.0.9' })
check('三级降级③fail-closed deny（默认）', denied.decision === 'deny' && denied.reasons[0].includes('PDP_UNREACHABLE'))

// 8) 熔断进入/恢复
const breakerClient = new AuthzClient({ platformBaseUrl: BASE, platformToken: TOKEN, snapshotDir: SNAPSHOT_DIR, checkTimeoutMs: 200, breakerCooldownMs: 300 })
for (let i = 0; i < 5; i++) {
  await breakerClient.evaluate({ tool: 'fs_list', args: { folder_path: '/x' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: `10.9.0.${i}` })
}
check('熔断：连续 5 次超时进入 open（metrics 记录）', breakerClient.metrics.breakerOpened >= 1 && breakerClient.breakerOpen)
const breakerVerdict = await breakerClient.evaluate({ tool: 'fs_list', args: { folder_path: '/x' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '10.9.0.99' })
check('熔断期判定走降级路径', breakerVerdict.degraded !== undefined || breakerVerdict.decision === 'deny')
pdpMode = 'normal'
await new Promise((resolve) => setTimeout(resolve, 350)) // 冷却后半开恢复
const recovered = await breakerClient.evaluate({ tool: 'fs_list', args: { folder_path: '/vivo/新目录' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '192.168.0.196' })
check('熔断恢复：PDP 回来后自动退出降级', recovered.decision === 'allow' && recovered.degraded === undefined)

// 9) client-credentials 自动换牌（静态 token 缺省时的推荐形态）
const ccClient = new AuthzClient({ platformBaseUrl: BASE, clientId: 'mc_cc', clientSecret: 'cs_cc', snapshotDir: SNAPSHOT_DIR, checkTimeoutMs: 500 })
pdpMode = 'normal'
const ccVerdict = await ccClient.evaluate({ tool: 'fs_list', args: { folder_path: '/vivo/新目录' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '10.7.0.1' })
check('client-credentials 换牌后判定正常（自动续期）', ccVerdict.decision === 'allow' && ccVerdict.degraded === undefined, JSON.stringify(ccVerdict))

// 10) 慢响应（超过 checkTimeoutMs）按超时降级
pdpMode = 'slow'
const slowVerdict = await new AuthzClient({ platformBaseUrl: BASE, platformToken: TOKEN, snapshotDir: SNAPSHOT_DIR, checkTimeoutMs: 300 }).evaluate({ tool: 'fs_list', args: { folder_path: '/x' }, tokenEntry: trusted, onBehalfHeader: 'u_read', nasIp: '10.8.0.1' })
check('超时上限 ≤2s 生效：慢响应按超时降级（fail-closed）', slowVerdict.decision === 'deny' && slowVerdict.reasons.join().includes('PDP'))

await rm(SNAPSHOT_DIR, { recursive: true, force: true }).catch(() => {})
pdp.close()

const failed = results.filter((item) => !item.pass)
console.log(`\nauthz-smoke：${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
