/**
 * authz.js —— 网关数据权限钩子（synology-filestation-mcp 改造件，dev-plan-nas-authz §2.4）。
 *
 * 交付形态：仅产出代码，不随本期部署。集成方式见同目录 README.md（http.js 两处挂钩：
 * matchToken 解析 req.tokenEntry 之后、JSON-RPC tools/call 分发之前）。
 *
 * 硬性约束：
 * - 身份一律走 X-On-Behalf-User 请求头；非授信令牌（allowedOnBehalf !== true）携带该头 → 直接拒绝（防伪造，R4）；
 * - check 超时上限 ≤2s；连续 5 次超时熔断进入降级态，恢复自动退出并留痕（R2）；
 * - 三级降级：scope 快照（最后已知 scope + 矩阵，仅放行快照内读）→ readonly（放行读拒写）→ deny（fail-closed 默认）；
 * - deny 响应透传平台 reasons 给客户端。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// §2.1 操作映射：七类操作 → 网关工具面（share/admin 工具面不存在 → 网关侧恒 deny）。
// G0 实测教训：映射面外工具在 evaluate() 里先于 observe 直通被硬拒（op.unsupported），
// 网关新增工具漏映射即线上拒绝——authz-smoke 以「工具面 ↔ 映射表双向一致」断言兜底，
// 网关工具面扩张时必须同步补此表与 test 里的 GATEWAY_TOOLS 钉住清单。
export const TOOL_OP_MAP = {
  fs_list: 'read',
  fs_list_shares: 'read',
  fs_get_info: 'read',
  fs_search: 'read',
  fs_download: 'download',
  fs_create_folder: 'write',
  fs_upload: 'write',
  fs_rename: 'modify',
  fs_copy_move: 'modify',
  fs_compress: 'modify',
  fs_extract: 'modify',
  fs_delete: 'delete',
  fs_task_status: 'read',
  fs_task_clear: 'delete',
}

const READ_LIKE = new Set(['read', 'download'])
const WRITE_LIKE = new Set(['write', 'modify', 'delete', 'share', 'admin'])

export function opForTool(tool) {
  return TOOL_OP_MAP[tool] ?? null
}

/** 路径参数提取（三种形态：folder_path 字符串/数组、path 字符串/数组、dest_path 目标目录）。 */
export function extractPaths(tool, args = {}) {
  const paths = new Set()
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) paths.add(value.trim())
    if (Array.isArray(value)) value.forEach((item) => push(item))
  }
  push(args.folder_path)
  push(args.path)
  push(args.dest_path)
  return [...paths]
}

/** scope 快照的本地降级判定：仅放行快照作用域内的读，一切写拒绝。 */
export function localScopeCheck(snapshot, op, paths) {
  const scope = snapshot?.scope ?? []
  if (WRITE_LIKE.has(op)) {
    return { decision: 'deny', reasons: ['degraded.snapshot：PDP 不可达，快照降级模式拒绝一切写操作'], degraded: 'snapshot' }
  }
  const inScope = paths.length === 0 || paths.every((path) => scope.some((prefix) => pathWithin(path, prefix)))
  if (!inScope) {
    return { decision: 'deny', reasons: [`degraded.snapshot：路径超出最后已知作用域（${scope.join('、') || '空'}）`], degraded: 'snapshot' }
  }
  return { decision: 'allow', reasons: ['degraded.snapshot：PDP 不可达，最后已知作用域内放行读'], degraded: 'snapshot' }
}

function pathWithin(path, prefix) {
  const p = normalize(path)
  const f = normalize(prefix)
  if (f === '/') return true
  return p === f || p.startsWith(`${f}/`)
}

function normalize(path) {
  const segments = `/${path}`.replace(/\\/g, '/').split('/').filter(Boolean)
  return `/${segments.join('/')}`
}

export class AuthzClient {
  /**
   * @param options.platformBaseUrl 平台基址（PDP 所在）
   * @param options.platformToken   网关专用资源账号令牌（最小权限 nas.authz.check + nas.read）
   * @param options.snapshotDir     scope 快照落盘目录（per user+nasIp）
   * @param options.enforceGlobal   AUTHZ_ENFORCE 全局开关（'on'|'off'，缺省 on；off=kill-switch 全直通）
   * @param options.degrade         PDP 不可达且无快照时的策略：'deny'（默认，fail-closed）| 'readonly'（灰度期可配）
   */
  constructor(options = {}) {
    this.platformBaseUrl = (options.platformBaseUrl ?? process.env.AUTHZ_PLATFORM_URL ?? '').replace(/\/+$/, '')
    this.platformToken = options.platformToken ?? process.env.AUTHZ_PLATFORM_TOKEN ?? ''
    // 推荐形态：clientId/clientSecret（client-credentials 自动换牌续期），静态 token 仅作兼容
    this.clientId = options.clientId ?? process.env.AUTHZ_CLIENT_ID ?? ''
    this.clientSecret = options.clientSecret ?? process.env.AUTHZ_CLIENT_SECRET ?? ''
    this.ccToken = null
    this.ccExpiresAt = 0
    this.checkTimeoutMs = options.checkTimeoutMs ?? Number(process.env.AUTHZ_CHECK_TIMEOUT_MS ?? 2000)
    this.cacheTtlMs = options.cacheTtlMs ?? 300_000
    this.breakerThreshold = options.breakerThreshold ?? 5
    this.breakerCooldownMs = options.breakerCooldownMs ?? 30_000
    this.snapshotDir = options.snapshotDir ?? process.env.AUTHZ_SNAPSHOT_DIR ?? join('.', 'authz-snapshots')
    this.enforceGlobal = options.enforceGlobal ?? (process.env.AUTHZ_ENFORCE ?? 'on')
    this.degrade = options.degrade ?? (process.env.AUTHZ_DEGRADE ?? 'deny')
    this.decisionCache = new Map()
    this.consecutiveTimeouts = 0
    this.breakerOpenedAt = 0
    this.metrics = { checks: 0, allows: 0, denies: 0, cacheHits: 0, degraded: 0, breakerOpened: 0 }
  }

  /** 熔断器：连续 5 次超时 → open；冷却后半开探测。 */
  get breakerOpen() {
    if (this.consecutiveTimeouts < this.breakerThreshold) return false
    if (Date.now() - this.breakerOpenedAt < this.breakerCooldownMs) return true
    return false
  }

  /** enforce 生效判定：全局 kill-switch 优先，其次逐令牌 enforce 字段（缺省 false=观察直通）。 */
  isEnforced(tokenEntry = {}) {
    if (String(this.enforceGlobal).toLowerCase() === 'off') return false
    if (String(process.env.AUTHZ_ENFORCE ?? '').toLowerCase() === 'off') return false
    return tokenEntry.enforce === true
  }

  /**
   * on-behalf 防伪（R4）：只有 allowedOnBehalf=true 的授信令牌可携带 X-On-Behalf-User；
   * 非授信令牌携带该头 → 拒绝（而非降级为令牌身份），直连伪造他人身份直接被挡。
   */
  resolveOnBehalf(tokenEntry = {}, onBehalfHeader) {
    if (onBehalfHeader === undefined || onBehalfHeader === '') return { userId: tokenEntry.boundUserId ?? null }
    if (tokenEntry.allowedOnBehalf !== true) {
      return { error: { code: -32403, message: 'FORGED_ON_BEHALF：该令牌未授权携带 X-On-Behalf-User 身份头（伪造已被拒绝并留痕）' } }
    }
    return { userId: String(onBehalfHeader).trim() }
  }

  /**
   * 判定入口（http.js tools/call 分发前调用）：
   * 返回 { decision: 'allow'|'deny', reasons, ruleId?, observeOnly?, degraded?, breakerOpen? }。
   * 决策缓存：仅 read/download 缓存 300s；写类与 delete 每次实判。
   */
  async evaluate({ tool, args, tokenEntry, onBehalfHeader, nasIp }) {
    this.metrics.checks += 1
    const identity = this.resolveOnBehalf(tokenEntry, onBehalfHeader)
    if (identity.error) {
      this.metrics.denies += 1
      return { decision: 'deny', ...identity.error, reasons: [identity.error.message] }
    }
    const userId = identity.userId
    const op = opForTool(tool)
    // 未知/映射外工具（含未来的 share/admin 面）：恒 deny（§六 边界）
    if (!op) {
      this.metrics.denies += 1
      return { decision: 'deny', reasons: [`op.unsupported：工具 ${tool} 不在数据权限映射面内，恒拒绝`] }
    }
    const paths = extractPaths(tool, args)
    const cacheKey = `${userId ?? '-'}|${nasIp}|${op}|${paths.join('|')}`
    if (READ_LIKE.has(op)) {
      const cached = this.decisionCache.get(cacheKey)
      if (cached && cached.expiresAt > Date.now()) {
        this.metrics.cacheHits += 1
        return cached.entry
      }
    }

    let verdict
    if (this.breakerOpen && this.isEnforced(tokenEntry)) {
      verdict = this.degradedVerdict({ op, paths, nasIp, userId, note: 'breaker-open' })
    } else {
      try {
        verdict = await this.remoteCheck({ nasIp, userId, paths, op })
        this.consecutiveTimeouts = 0
        if (verdict.decision === 'allow' && userId && nasIp) await this.refreshSnapshot({ nasIp, userId })
      } catch (error) {
        this.consecutiveTimeouts += 1
        if (this.consecutiveTimeouts >= this.breakerThreshold) {
          this.breakerOpenedAt = Date.now()
          this.metrics.breakerOpened += 1
        }
        if (!this.isEnforced(tokenEntry)) {
          // G0 观察：PDP 不可达时零破坏直通（观察模式不引入新的失败面）
          verdict = { decision: 'allow', reasons: [`observe：PDP 不可达（${error.message}），该令牌未开启 enforce，直通`], observeOnly: true }
        } else {
          verdict = this.degradedVerdict({ op, paths, nasIp, userId, note: error.message })
        }
      }
      if (!this.isEnforced(tokenEntry)) {
        // G0 观察模式核心：未开 enforce 的令牌照常过 PDP 采集真实判定数据（灰度退出依据），
        // 全部标注 observeOnly → http.js 对 deny 记 OBSERVE-DENY 后放行，不拦截业务；观察判定不进缓存
        verdict = { ...verdict, observeOnly: true }
        if (verdict.decision === 'allow') verdict.reasons = [...verdict.reasons, 'observe：该令牌未开启 enforce（判定留痕，不拦截）']
      }
    }
    if (verdict.decision === 'allow') this.metrics.allows += 1
    else this.metrics.denies += 1
    // 观察模式的判定不进缓存（G0→G1 切换后旧观察判定不得泄露为放行/拦截依据）
    if (READ_LIKE.has(op) && !verdict.observeOnly) {
      this.decisionCache.set(cacheKey, { entry: verdict, expiresAt: Date.now() + this.cacheTtlMs })
    }
    return verdict
  }

  /** PDP 鉴权头：优先 client-credentials 自动换牌（过期前 60s 续期），回落静态 token。 */
  async platformHeaders() {
    if (this.clientId && this.clientSecret) {
      if (!this.ccToken || this.ccExpiresAt < Date.now() + 60_000) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.checkTimeoutMs)
        try {
          const response = await fetch(`${this.platformBaseUrl}/api/auth/client-credentials`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret }),
            signal: controller.signal,
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload?.ok === false || !payload?.data?.token) {
            throw new Error(`PDP_CC_FAILED：机器凭证换牌失败（HTTP ${response.status}）`)
          }
          this.ccToken = payload.data.token
          const expiresAtMs = Date.parse(payload.data.expiresAt ?? '')
          this.ccExpiresAt = Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 3600_000
        } finally {
          clearTimeout(timer)
        }
      }
      return { authorization: `Bearer ${this.ccToken}` }
    }
    if (!this.platformToken) throw new Error('PDP_UNCONFIGURED：平台地址/令牌未配置')
    return { authorization: `Bearer ${this.platformToken}` }
  }

  /** PDP 同步判定：X-On-Behalf-User 头携带真实用户身份（绝不进工具参数）。 */
  async remoteCheck({ nasIp, userId, paths, op }) {
    if (!this.platformBaseUrl) throw new Error('PDP_UNCONFIGURED：平台地址未配置')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.checkTimeoutMs)
    try {
      const response = await fetch(`${this.platformBaseUrl}/api/nas/authz/check`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(await this.platformHeaders()),
          'X-NAS-IP': nasIp,
          ...(userId ? { 'X-On-Behalf-User': userId } : {}),
        },
        body: JSON.stringify({ nasId: nasIp, userId, paths, op }),
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload?.ok === false) throw new Error(`PDP_HTTP_${response.status}：${payload?.error?.message ?? ''}`)
      const decision = payload.data
      return {
        decision: decision.decision === 'allow' && decision.observeOnly !== true ? 'allow' : decision.decision,
        reasons: decision.reasons ?? [],
        ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
        observeOnly: decision.observeOnly === true,
      }
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`PDP_TIMEOUT：check 超过 ${this.checkTimeoutMs}ms`)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** 三级降级：scope 快照（只读）→ 全局 readonly → deny（fail-closed）。 */
  degradedVerdict({ op, paths, nasIp, userId, note }) {
    this.metrics.degraded += 1
    const snapshot = this.loadSnapshot({ nasIp, userId })
    if (snapshot) {
      const local = localScopeCheck(snapshot, op, paths)
      return { ...local, reasons: [...local.reasons, `（降级原因：${note}）`] }
    }
    if (String(this.degrade).toLowerCase() === 'readonly' && READ_LIKE.has(op)) {
      return { decision: 'allow', reasons: [`degraded.readonly：PDP 不可达（${note}），灰度降级放行读`] }
    }
    if (String(this.degrade).toLowerCase() === 'readonly') {
      return { decision: 'deny', reasons: [`degraded.readonly：PDP 不可达（${note}），降级只读模式拒绝写`] }
    }
    return { decision: 'deny', reasons: [`PDP_UNREACHABLE：平台判定服务不可达（${note}），fail-closed 默认拒绝`] }
  }

  snapshotPath({ nasIp, userId }) {
    return join(this.snapshotDir, `${encodeURIComponent(userId ?? '-')}_${encodeURIComponent(nasIp)}.json`)
  }

  async refreshSnapshot({ nasIp, userId }) {
    // 拉取 scope 快照并落盘（幂等可缓存；scope 变化频率低）
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.checkTimeoutMs)
      const response = await fetch(`${this.platformBaseUrl}/api/nas/authz/scope?nasId=${encodeURIComponent(nasIp)}&userId=${encodeURIComponent(userId)}`, {
        headers: await this.platformHeaders(),
        signal: controller.signal,
      })
      clearTimeout(timer)
      const payload = await response.json().catch(() => ({}))
      const data = payload?.data
      if (!response.ok || !data?.scope) return
      mkdirSync(this.snapshotDir, { recursive: true })
      writeFileSync(this.snapshotPath({ nasIp, userId }), JSON.stringify({
        role: data.role ?? null, scope: data.scope, matrix: data.matrix ?? null, fetchedAt: new Date().toISOString(),
      }))
    } catch { /* 快照失败不影响主判定 */ }
  }

  loadSnapshot({ nasIp, userId }) {
    try {
      const raw = readFileSync(this.snapshotPath({ nasIp, userId }), 'utf8')
      const parsed = JSON.parse(raw)
      return parsed.scope ? parsed : null
    } catch {
      return null
    }
  }
}
