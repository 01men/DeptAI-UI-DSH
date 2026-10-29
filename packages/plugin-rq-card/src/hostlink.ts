/**
 * 宿主连接服务（hostlink）——「装好插件即可用」的连接半部（M2 连接与登录）。
 *
 * 【定位】dsh 客户端装好插件后，向导/设置面/面板 SPA 都需要一个「本机如何到达01门数据面」
 * 的统一答案。本服务给出三种模式：
 *   - none   ：未配置（全新 dsh 首启态）——前端渲染连接向导；
 *   - local  ：本机即宿主（形态 B，本插件与 platform-core 同进程），面板直连同源 /api；
 *   - remote ：连接远端宿主（形态 C）——面板 REST 经本服务内置代理转发远端，浏览器零跨域。
 *
 * 【端点命名空间】全部挂 /rqcard/*（非 /api/*）。这是刻意选择：console 鉴权中间件只拦
 * /api/*，向导必须在「登录之前」可用（选宿主、设 admin 口令都发生在持令牌之前），走
 * /rqcard/* 免登命名空间 + 自带防线，与 /api/panel/stream（公开路径 + 内部 token 自校验）、
 * /api/connect/enroll（接入码本身即凭证）同一安全族。
 *
 * 【自带防线（免登命名空间的义务）】
 *   1. 向导头：所有 /rqcard/* 请求必须带 `x-rqcard-call: 1`。自定义头跨站发不出
 *      （会触发 CORS 预检，而非 /api 路径不放行预检）——挡住恶意网页对
 *      127.0.0.1 向导端点的 drive-by CSRF（改宿主指向钓鱼服务器截获登录凭据）。
 *      唯一豁免：GET /rqcard/proxy/api/panel/stream（issue #6，2026-10-29）——EventSource
 *      带不了自定义头，SSE 凭据走一次性 ticket（消费即焚）/自校验 token；该端点只读、
 *      响应无 CORS 头，跨站页连上了也读不到流内容，CSRF 面不扩大。
 *   2. 代理白名单：/rqcard/proxy/* 只转发 auth 族 + /api/panel/* + /api/health，
 *      白名单外 403；SSE（/api/panel/stream）流式透传（不缓冲、长连接不套 30s 整体超时），
 *      前端 30s 轮询仅作断线降级保留（issue #6 前「显式拒绝 SSE」已移除）。
 *   3. 代理只透传 Authorization 头（不带 Cookie）、redirect: 'manual'（令牌不随 302 外泄）。
 *
 * 【配置落盘】<dataDir>/gate01-host-link.json（0600，参照 connect-client.json 惯例）。
 */
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../platform-core/src/index.ts'

/** 持久化的宿主连接配置（对浏览器可见的形状：不含任何机密）。 */
export interface HostLinkConfig {
  /** none=未配置（首启向导态）；local=本机即宿主；remote=连接远端宿主。 */
  mode: 'none' | 'local' | 'remote'
  /** remote 模式下的宿主基址（如 http://192.168.1.5:3080）。 */
  hubBase?: string
  /** 宿主数据面挂载前缀：形态 B（dsh 挂载）为 '/gate01'（01门装态）或 '/rq'（上游宿主轨）；形态 A（独立宿主）为 ''。探测时自动判定。 */
  hubMountPrefix?: string
  /** 连接备注名（向导里可读的标识）。 */
  label?: string
  savedAt?: string
}

/** 健康探测结果。 */
export interface HubProbe {
  reachable: boolean
  /** HTTP 状态码（不可达为 0）。 */
  status: number
  /** 宿主平台版本（/api/health 返回时透出）。 */
  version?: string
  /** 数据面挂载前缀（探测命中 '/gate01'、'/rq' 或 ''）。 */
  mountPrefix?: string
}

/** 向导必须携带的调用头（CSRF 防线，见文件头注释第 1 条）。 */
export const RQCARD_CALL_HEADER = 'x-rqcard-call'

/** 代理白名单：精确路径。 */
const PROXY_ALLOW_EXACT = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/entry-ticket-session',
  '/api/authn/entry-tickets/redeem',
])

/** 代理白名单：前缀族（auth SSO 全族 + 面板 REST 全族）。 */
const PROXY_ALLOW_PREFIXES = ['/api/auth/sso', '/api/panel/']

/** 代理显式拒绝（白名单前缀内但不适合转发的路径）。
 * issue #6（2026-10-29）：/api/panel/stream 移出拒绝表——改为流式透传（见 proxy()），
 * 远端模式 2 秒可见性不再依赖 30s 轮询兜底；拒绝机制保留给后续确需屏蔽的路径。 */
const PROXY_DENY_EXACT = new Set<string>([])

/** 判定路径是否在代理白名单内。 */
export function proxyPathAllowed(path: string): boolean {
  if (PROXY_DENY_EXACT.has(path)) return false
  if (PROXY_ALLOW_EXACT.has(path)) return true
  return PROXY_ALLOW_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/** LAN 扫描的默认候选端口（独立宿主 7300 / dsh web 3080）。 */
const DEFAULT_SCAN_PORTS = [7300, 3080]
/** 单探针快档超时（毫秒）——局域网内 1.4s（350ms 基数 ×4）足够判定。 */
const PROBE_TIMEOUT_MS = 350
/** 探针放宽档超时（毫秒）——公网/跨网宿主 TLS+往返常超快档上限（issue #5），快探全超时后以该档复探一轮。 */
const PROBE_TIMEOUT_SLOW_MS = 6000
/** 代理转发超时（毫秒）；SSE 流式在响应头到达后解除（长连接生命周期交给客户端断开）。 */
const PROXY_TIMEOUT_MS = 30_000
/** setRemote timeoutMs 覆盖的合法区间（毫秒）。 */
const PROBE_TIMEOUT_OVERRIDE_MIN_MS = 500
const PROBE_TIMEOUT_OVERRIDE_MAX_MS = 30_000
/** 扫描候选总量上限（多网卡 /24 × 端口下的有界保证）。 */
const SCAN_CANDIDATE_LIMIT = 600

/** 规范化宿主基址：去尾斜杠、补 http://（与 connect 的 normalizeBaseUrl 同规）。 */
export function normalizeHubBase(input: string): string {
  let value = String(input ?? '').trim()
  if (value === '') throw new Error('宿主地址不能为空')
  // 非 http(s) 显式 scheme 先行拒绝（QA P2-O-1）：若先补 http:// 前缀，ftp://host 会被
  // 静默规范化成 http://ftp 并以「宿主不可达」误导用户，专属错误分支永不可达。
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)
  if (scheme && !/^https?$/i.test(scheme[1]!)) throw new Error('宿主地址仅支持 http/https')
  if (!scheme) value = `http://${value}`
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('宿主地址仅支持 http/https')
  if (!url.hostname) throw new Error('宿主地址缺少主机名')
  return `${url.protocol}//${url.host}`.replace(/\/+$/, '')
}

export interface HostLinkOptions {
  /** 配置文件目录（默认与平台存储同目录）。 */
  dataDir?: string
  /** 扫描候选端口覆盖（测试注入用）。 */
  scanPorts?: number[]
}

export class HostLinkService {
  private readonly ctx: Context
  private configFile: string
  private config: HostLinkConfig
  private readonly scanPorts: number[]

  constructor(ctx: Context, options: HostLinkOptions = {}) {
    this.ctx = ctx
    this.configFile = join(options.dataDir ?? ctx.opsStorage.dataDirPath, 'gate01-host-link.json')
    this.config = this.load()
    this.scanPorts = options.scanPorts ?? DEFAULT_SCAN_PORTS
  }

  /** 当前配置（对外只读）。 */
  getConfig(): Readonly<HostLinkConfig> {
    return this.config
  }

  /** 是否已连接（local/remote 均算；none=向导首启态）。 */
  isLinked(): boolean {
    return this.config.mode !== 'none'
  }

  // ---------------------------------------------------------------- 配置三通道

  /** 声明本机宿主模式（形态 B：本插件与数据面同进程，幂等）。 */
  setLocal(label?: string): HostLinkConfig {
    this.config = { mode: 'local', ...(label ? { label } : {}), savedAt: new Date().toISOString() }
    this.save()
    return this.config
  }

  /**
   * 连接远端宿主（形态 C）：先探测（自动判定挂载前缀），可达才落盘。
   *
   * 【两级探测（issue #5，2026-10-29）】默认先快档（1.4s/前缀，局域网体验不变），
   * 全部超时再以放宽档（6s/前缀）复探一轮——公网/跨网宿主 TLS+往返常超快档上限，
   * 单级快探会把可达宿主误判为不可达。`timeoutMs` 显式覆盖（向导可传，钳制在
   * 0.5s–30s）时只跑单级：调用方自己决定了判定窗，不再二次等待。
   */
  async setRemote(hubBaseInput: string, label?: string, opts: { timeoutMs?: number } = {}): Promise<{ config: HostLinkConfig; probe: HubProbe }> {
    const hubBase = normalizeHubBase(hubBaseInput)
    const override = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
      ? Math.min(PROBE_TIMEOUT_OVERRIDE_MAX_MS, Math.max(PROBE_TIMEOUT_OVERRIDE_MIN_MS, Math.round(opts.timeoutMs)))
      : null
    let probe = await this.probeHub(hubBase, override ?? PROBE_TIMEOUT_MS * 4)
    if (!probe.reachable && override === null) {
      probe = await this.probeHub(hubBase, PROBE_TIMEOUT_SLOW_MS)
    }
    if (!probe.reachable) {
      throw new Error(`宿主不可达：${hubBase}（健康检查无响应，请确认地址/端口/防火墙；跨网宿主网络慢时已放宽到 6s/前缀复探过一轮，仍不通多半是地址或网络不通）`)
    }
    this.config = {
      mode: 'remote',
      hubBase,
      hubMountPrefix: probe.mountPrefix ?? '',
      ...(label ? { label } : {}),
      savedAt: new Date().toISOString(),
    }
    this.save()
    return { config: this.config, probe }
  }

  /** 断开：回到未配置态（远端连接凭据在浏览器侧，本服务无令牌可清）。 */
  reset(): HostLinkConfig {
    this.config = { mode: 'none' }
    this.save()
    return this.config
  }

  // ---------------------------------------------------------------- 探测与扫描

  /**
   * 探测宿主：依次试 `${base}/gate01/api/health`（01门装态）、`${base}/rq/api/health`
   * （宿主轨全量形态，上游装配仍挂 /rq）与 `${base}/api/health`（独立宿主）。
   * 命中即返回，携带自动判定的挂载前缀。
   *
   * 【严格判据（Bug1 修复）】独立宿主对 `/gate01/api/health` 这类未匹配路径会以 SPA 兜底返回
   * 200 HTML——只看 HTTP 200 会把挂载前缀误判成挂载形态（登录跳错地址、代理打错路径）。
   * 必须解析出健康 JSON 信封（ok===true）才算命中，HTML/非 JSON 一律视为该前缀不可用。
   *
   * `timeoutMs` 可覆盖单前缀判定窗（默认快档 1.4s；局域网扫描 scan() 固定走默认档，
   * 不吃放宽档——600 候选 × 慢超时会拖死扫描）。
   */
  async probeHub(hubBase: string, timeoutMs: number = PROBE_TIMEOUT_MS * 4): Promise<HubProbe> {
    for (const mountPrefix of ['/gate01', '/rq', '']) {
      const url = `${hubBase}${mountPrefix}/api/health`
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
        if (!response.ok) continue
        const contentType = String(response.headers.get('content-type') ?? '')
        if (!contentType.includes('json')) continue
        const payload = await response.json().catch(() => null) as { ok?: boolean; data?: { version?: string } } | null
        if (payload?.ok !== true) continue
        return { reachable: true, status: response.status, version: payload.data?.version, mountPrefix }
      } catch { /* 该前缀不可达，试下一个 */ }
    }
    return { reachable: false, status: 0 }
  }

  /**
   * 局域网扫描：各 IPv4 网卡 /24 网段 × 候选端口，并行短超时探活。
   * @param candidates 显式候选（测试注入 / 向导历史地址），缺省按网卡推导。
   */
  async scan(candidates?: string[]): Promise<{ hosts: Array<{ endpoint: string; mountPrefix: string; version?: string }>; scanned: number }> {
    let list: string[]
    if (Array.isArray(candidates) && candidates.length > 0) {
      list = candidates.map((item) => normalizeHubBase(String(item)))
    } else {
      const seen = new Set<string>()
      list = []
      for (const addrs of Object.values(networkInterfaces())) {
        for (const addr of addrs ?? []) {
          if (addr.family !== 'IPv4' || addr.internal) continue
          const base = addr.address.split('.').slice(0, 3).join('.')
          for (let host = 1; host <= 254; host++) {
            for (const port of this.scanPorts) {
              const endpoint = `http://${base}.${host}:${port}`
              if (!seen.has(endpoint)) { seen.add(endpoint); list.push(endpoint) }
            }
          }
        }
      }
    }
    const bounded = list.slice(0, SCAN_CANDIDATE_LIMIT)
    const found: Array<{ endpoint: string; mountPrefix: string; version?: string }> = []
    await Promise.all(bounded.map(async (endpoint) => {
      const probe = await this.probeHub(endpoint).catch(() => null)
      if (probe?.reachable) found.push({ endpoint, mountPrefix: probe.mountPrefix ?? '', version: probe.version })
    }))
    return { hosts: found, scanned: bounded.length }
  }

  // ---------------------------------------------------------------- 代理（remote 模式数据面）

  /**
   * 把一次面板/auth 请求转发到远端宿主。白名单校验先于模式校验（未连接时
   * 白名单外路径同样回 403 PROXY_PATH_DENIED，语义不随连接状态漂移）。
   * 返回给 dispatch 的处理结果由调用方（中间件包装）写回响应。
   */
  async proxy(exchange: HttpExchange): Promise<void> {
    const path = exchange.path.replace(/^\/rqcard\/proxy/, '') || '/'
    if (!proxyPathAllowed(path)) {
      exchange.fail(403, 'PROXY_PATH_DENIED', `代理白名单之外的路由：${path}`)
      return
    }
    if (this.config.mode !== 'remote' || !this.config.hubBase) {
      exchange.fail(409, 'NOT_REMOTE', '当前不是远端连接模式（先在向导里选择并连接宿主）')
      return
    }
    const query = exchange.query.toString()
    // 远端登录入口（钉钉扫码页）按宿主真实挂载前缀构造——前缀判定由 probeHub 严格判据保证
    const target = `${this.config.hubBase}${this.config.hubMountPrefix ?? ''}${path}${query ? `?${query}` : ''}`
    const streamPath = path === '/api/panel/stream'
    const headers: Record<string, string> = { accept: streamPath ? 'text/event-stream' : 'application/json' }
    const authorization = exchange.headers.authorization
    if (authorization !== undefined) headers.authorization = String(authorization)
    let bodyText: string | undefined
    if (exchange.body !== undefined) {
      bodyText = typeof exchange.body === 'string' ? exchange.body : JSON.stringify(exchange.body)
      headers['content-type'] = 'application/json'
    }
    const controller = new AbortController()
    // 30s 护栏：非流式覆盖整个往返；流式（SSE）只护「拿到响应头之前」——响应头到达即解除，
    // 长连接生命周期交给客户端断开驱动（issue #6 前 SSE 被整体超时误杀，是当初显式拒绝的根因）。
    const guard = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(target, {
        method: exchange.method === 'HEAD' ? 'GET' : exchange.method,
        headers,
        body: bodyText,
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(guard)
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(502, 'HUB_UNREACHABLE', `远端宿主不可达：${message}`)
      return
    }
    // -- SSE 流式透传（issue #6）：不缓冲、不整读，逐块管道回浏览器；远端模式由此满足
    //    「已落库状态变化 2 秒内可见」，30s 轮询仅作断线降级。仅对 ok + text/event-stream
    //    生效：非 2xx（401 票据失效等）与 SPA HTML 兜底照走下方缓冲路径，前端拿 JSON/显式
    //    报错后自动降级轮询。
    if (streamPath && response.ok && String(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const streamHeaders: Record<string, string> = {
        'content-type': String(response.headers.get('content-type') ?? 'text/event-stream'),
      }
      const cacheControl = response.headers.get('cache-control')
      if (cacheControl) streamHeaders['cache-control'] = cacheControl
      exchange.res.writeHead(response.status, streamHeaders)
      const upstream = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
      const finish = () => {
        clearTimeout(guard)
        if (!exchange.res.writableEnded) exchange.res.end()
      }
      upstream.on('data', (chunk) => { if (!exchange.res.writableEnded) exchange.res.write(chunk) })
      upstream.on('end', finish)
      upstream.on('error', finish)
      exchange.res.on('close', () => { upstream.destroy(); finish() })
      return
    }
    clearTimeout(guard)
    // 宿主数据面只会回 JSON；拿到 HTML 说明地址/挂载前缀不对（SPA 兜底）——透传只会让
    // 前端把整页 HTML 当接口数据渲染，显式报错比静默错乱好（Bug1 的第二道防线）。
    const responseContentType = String(response.headers.get('content-type') ?? '')
    if (responseContentType.includes('text/html')) {
      exchange.fail(502, 'HUB_BAD_RESPONSE', '宿主返回了 HTML 而非 JSON（地址或挂载前缀可能不匹配，请在向导里重新测试连接）')
      return
    }
    const text = await response.text().catch(() => '')
    if (!exchange.res.writableEnded) {
      const headers: Record<string, string> = { 'content-type': String(response.headers.get('content-type') ?? 'application/json; charset=utf-8') }
      // 3xx Location 透传（QA T-02）：redirect:'manual' 下宿主 302（如 /api/auth/sso 登录跳转）
      // 的 location 若被静默丢弃，登录回跳链路将无声断裂——要么完整透传，要么别用 manual。
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) headers.location = location
      exchange.res.writeHead(response.status, headers)
      exchange.res.end(text)
    }
  }

  // ---------------------------------------------------------------- 落盘

  // plan-gate01 决策 1（2026-09-10）：「本机初始化」整链（形态 B 设口令：admin 初始口令文件判定、
  // 首登改密重登、对外网卡枚举）已删除——本机/远端统一为「连接宿主」流程，登录在宿主侧完成，
  // 本插件不再持有 iam/authn 依赖（inject 已收缩为 httpServer/tools/opsStorage）。
  // ---------------------------------------------------------------- 落盘

  private load(): HostLinkConfig {
    try {
      const raw = readFileSync(this.configFile, 'utf8')
      const parsed = JSON.parse(raw) as HostLinkConfig
      if (parsed && (parsed.mode === 'none' || parsed.mode === 'local' || parsed.mode === 'remote')) return parsed
    } catch { /* 无配置/坏配置一律回到首启态 */ }
    return { mode: 'none' }
  }

  private save(): void {
    writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), { mode: 0o600 })
    try { chmodSync(this.configFile, 0o600) } catch { /* Windows 上 chmod 近似 no-op，尽力而为 */ }
  }
}
