#!/usr/bin/env node
/**
 * refresh-governance-mcp-tokens.mjs —— 治理双身份 MCP 令牌自愈刷新（DSH 侧）。
 *
 * 背景：平台机器令牌（client-credentials 换牌）有效期 2 小时（authn.verify 固定 TTL），
 * 客户端侧存的是静态 Bearer，过期即调用失败。DSH 不会自行续期，故需主动刷新。
 *
 * 本脚本做四件事（幂等、可反复跑）：
 *   ① 读 ~/.ybkkasi/../ybkkasi/data/governance-credentials.json 取 clientId/clientSecret（不轮换 secret）
 *   ② 经 POST /api/auth/client-credentials 为 operator / reviewer 各换一把新令牌
 *   ③ 经 DSH 连接器 HTTP API（POST http://127.0.0.1:7777/mcp-connector/api，method=configure）
 *      把新令牌写回 DSH 连接并重建 MCP 客户端（DSH 侧重建后即刻生效，无需重启宿主）
 *   ④ 写回核验（防假绿，2026-10-28）：重读 DSH 存储，硬断言两条连接 updatedAt 距今
 *      ≤ --max-staleness-min（默认 120）且存储令牌未过期——连接器"应答 ok 但没落盘"
 *      时脚本以非零退出，gov-token 作业 GT-01 不再被假绿掩盖
 *
 * 失败告警出口（防静默，2026-10-28；全链路只依赖平台能力与 DSH 基座，不引入任何外部 webhook）：
 *   本脚本层（DSH 基座本地，平台不可达时也成立）：
 *     · 追加一条 JSONL 到 <data-dir>/governance-refresh-alerts.jsonl（org daily 作业 D-GOV-ALERTS 计入当日摘要硬失败）
 *     · macOS 本机通知（osascript display notification；launchd gui 域可直接弹出）
 *   作业层（平台可见，org/automation/jobs/gov-token.mjs 负责）：硬失败边缘触发时向平台研发部面板发告警工件，
 *     控制台面板即刻可见；需外推到钉钉群的由平台钉钉桥接（企业应用凭据在平台侧）承接，本地零配置。
 *
 * 不打印任何 secret/令牌原文，只报到期时刻。
 *
 * 用法：
 *   node scripts/refresh-governance-mcp-tokens.mjs [--data-dir <dir>] [--dsh-url http://127.0.0.1:7777]
 *       [--skip-if-fresh] [--fresh-window-min 90] [--force]
 *
 *   --skip-if-fresh   仅当 DSH 里存的令牌剩余寿命 < fresh-window-min 时才换牌+重建（定时器用，避免无谓重建连接）
 *                     窗口 2026-10-28 由 30 调为 90：TTL 120 分钟 + 每小时巡检下，30 分钟窗口只要漏掉一次
 *                     定时触发令牌即过期；90 分钟窗口保证任意单次漏触发都不会断（代价是每小时重建一次连接）
 *   --force           无条件刷新（忽略新鲜度判断）
 *   --max-staleness-min  写回核验允许的 updatedAt 最大陈旧度（默认 120 分钟；skip 路径令牌新鲜 ⇒ 必然 ≤ 30 分钟）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : fallback
}
const PLATFORM_URL = (arg('--platform-url', process.env.YBKK_GOV_PLATFORM ?? 'https://ybkkasi.com')).replace(/\/+$/, '')
const DSH_URL = (arg('--dsh-url', process.env.DSH_WEB_URL ?? 'http://127.0.0.1:7777')).replace(/\/+$/, '')
const DATA_DIR = resolve(arg('--data-dir', join(homedir(), 'ybkkasi', 'data')))
const CRED_FILE = join(DATA_DIR, 'governance-credentials.json')
const DSH_STORE = resolve(arg('--dsh-store', join(homedir(), '.dsh', 'storages', 'mcp_connector.json')))
const SKIP_IF_FRESH = argv.includes('--skip-if-fresh')
const FORCE = argv.includes('--force')
const FRESH_WINDOW_MIN = Number(arg('--fresh-window-min', '90'))
const MAX_STALENESS_MIN = Number(arg('--max-staleness-min', '120'))
const ALERTS_FILE = join(DATA_DIR, 'governance-refresh-alerts.jsonl')

const log = (msg) => console.log(`[gov-refresh] ${msg}`)

/**
 * 硬失败告警出口（脚本层，任一失败不掩盖原始错误、不影响退出码；平台不可达时也成立）：
 *   ① 落盘 JSONL（org daily 作业 D-GOV-ALERTS 消费，进当日摘要硬失败）
 *   ② macOS 本机通知（DSH 基座所在机器；osascript display notification，launchd gui 域可直接弹出）
 * 平台侧可见的面板告警由 org gov-token 作业在检测到本脚本非零退出时边缘触发投递（见文件头）。
 */
const alert = async (msg) => {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(ALERTS_FILE, JSON.stringify({ at: new Date().toISOString(), platform: PLATFORM_URL, error: String(msg).slice(0, 300) }) + '\n')
  } catch { /* ① 落盘失败不掩盖原始错误 */ }
  if (process.platform === 'darwin') {
    try {
      execFileSync('osascript', ['-e', `display notification ${JSON.stringify(String(msg).slice(0, 200))} with title "gov-refresh 治理令牌刷新失败" sound name "Basso"`], { stdio: 'ignore', timeout: 5000 })
    } catch { /* ② 本机通知不可用（无 GUI 会话等）即跳过 */ }
  }
}
const fail = async (msg) => { console.error(`[gov-refresh] ✘ ${msg}`); await alert(msg); process.exit(1) }

if (!existsSync(CRED_FILE)) await fail(`凭证文件不存在：${CRED_FILE}（先跑 scripts/register-governance-credentials.mjs）`)
const cred = JSON.parse(readFileSync(CRED_FILE, 'utf8'))

/** 换牌取机器令牌（client-credentials）。网络层异常同样走告警出口。 */
const exchange = async (entry, label) => {
  let response
  let payload = null
  try {
    response = await fetch(`${PLATFORM_URL}/api/auth/client-credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: entry.clientId, clientSecret: entry.clientSecret }),
    })
    payload = await response.json().catch(() => null)
  } catch (e) {
    await fail(`${label} 换牌请求失败：${e.cause?.code ?? e.message}`)
  }
  if (!response.ok || payload?.ok === false) await fail(`${label} 换牌失败：${payload?.error?.message ?? response.status}`)
  return payload.data
}

/** 通过 DSH 连接器 API 更新连接并重建客户端。网络层异常同样走告警出口。 */
const configure = async (params, label) => {
  let response
  let payload = null
  try {
    response = await fetch(`${DSH_URL}/mcp-connector/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'configure', params }),
    })
    payload = await response.json().catch(() => null)
  } catch (e) {
    await fail(`${label} 连接器请求失败：${e.cause?.code ?? e.message}`)
  }
  if (!response.ok || payload?.ok === false) await fail(`${label} 配置失败：${payload?.message ?? response.status}`)
  return payload
}

const targets = [
  { key: 'operator', serverName: 'ybkk-governance', label: 'ybkk-governance（执行官）', dshKey: 'custom-ybkk-governance' },
  { key: 'reviewer', serverName: 'ybkk-governance-review', label: 'ybkk-governance-review（评审官）', dshKey: 'custom-ybkk-governance-review' },
]

/** 读 DSH 连接存储里已配置的令牌，算剩余寿命（分钟）。读不到返回 null（按「不新鲜」处理）。 */
const storedTokenTtlMin = (dshKey) => {
  try {
    if (!existsSync(DSH_STORE)) return null
    const store = JSON.parse(readFileSync(DSH_STORE, 'utf8'))
    const token = store?.tables?.connections?.[dshKey]?.auth?.bearerToken
    if (!token) return null
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'))
    if (!payload?.exp) return null
    return (payload.exp * 1000 - Date.now()) / 60000
  } catch {
    return null
  }
}

let refreshed = 0
let skipped = 0
for (const target of targets) {
  const entry = cred[target.key]
  if (!entry?.clientId) await fail(`凭证文件缺少 ${target.key} 条目`)

  if (SKIP_IF_FRESH && !FORCE) {
    const ttl = storedTokenTtlMin(target.dshKey)
    if (ttl !== null && ttl > FRESH_WINDOW_MIN) {
      log(`${target.label}：令牌仍新鲜（剩余约 ${Math.round(ttl)} 分钟 > ${FRESH_WINDOW_MIN} 分钟），跳过重建`)
      skipped += 1
      continue
    }
  }

  const issued = await exchange(entry, target.label)
  await configure({
    name: target.serverName,
    serverName: target.serverName,
    transport: 'streamable-http',
    url: `${PLATFORM_URL}/mcp`,
    authMode: 'bearer',
    bearerToken: issued.token,
    scope: 'global',
  }, target.label)
  log(`${target.label}：已刷新并重建（到期 ${issued.expiresAt}）`)
  refreshed += 1
}

log(`完成：刷新 ${refreshed} 条、跳过 ${skipped} 条（secret 未轮换，无需重新登记）`)

// ---- ④ 写回核验（防假绿）：连接器"应答 ok"不等于"落盘成功"。重读存储硬断言：
//      两条连接存在、updatedAt 距今 ≤ MAX_STALENESS_MIN、存储令牌未过期。任一不满足即非零退出。
const readStore = () => {
  try { return JSON.parse(readFileSync(DSH_STORE, 'utf8')) } catch { return null }
}
const store = readStore()
const stale = []
for (const target of targets) {
  const conn = store?.tables?.connections?.[target.dshKey]
  if (!conn) { stale.push(`${target.label}：DSH 存储中连接不存在`); continue }
  const updatedAgoMin = conn.updatedAt ? (Date.now() - Number(conn.updatedAt)) / 60000 : null
  if (updatedAgoMin === null || !Number.isFinite(updatedAgoMin) || updatedAgoMin > MAX_STALENESS_MIN) {
    stale.push(`${target.label}：updatedAt 距今 ${updatedAgoMin === null || !Number.isFinite(updatedAgoMin) ? '未知' : `${Math.round(updatedAgoMin)} 分钟`}（> ${MAX_STALENESS_MIN}）`)
    continue
  }
  const ttl = storedTokenTtlMin(target.dshKey)
  if (ttl === null || ttl <= 0) stale.push(`${target.label}：存储令牌缺失或已过期`)
}
if (stale.length) await fail(`写回核验失败（防假绿）：${stale.join('；')}`)
log(`写回核验：${targets.length} 条连接 updatedAt ≤ ${MAX_STALENESS_MIN} 分钟且令牌未过期`)
