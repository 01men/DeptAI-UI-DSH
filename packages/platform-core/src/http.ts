/**
 * HTTP 服务：REST 路由 + 静态资源 + 中间件，独立宿主的数据面入口。
 * 真实 dsh 部署下控制台可独立进程运行（本服务随 platform-core 提供）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { parseCookieHeader, resolveRequestLocale, runWithLocale, t } from '../../platform-i18n/src/index.ts'

export interface HttpExchange {
  method: string
  path: string
  params: Record<string, string>
  query: URLSearchParams
  headers: IncomingMessage['headers']
  body: any
  raw: IncomingMessage
  res: ServerResponse
  /** 鉴权中间件写入的调用方身份。 */
  principal?: unknown
  ok(data?: unknown, init?: { status?: number }): void
  fail(status: number, code: string, message: string, extra?: Record<string, unknown>): void
  file(absolutePath: string, contentType?: string): void
}

export type HttpHandler = (exchange: HttpExchange) => void | Promise<void>
export type HttpMiddleware = (exchange: HttpExchange) => boolean | void | Promise<boolean | void>

/**
 * 路由鉴权 profile（QA 2026-09-08 T-01 教训的平台加固，交接清单 H5）：
 * /api/* 端点注册时必须显式声明，使 RBAC 断言网可枚举全部端点——
 * 含「公开+自校验」这一显式类别（如 SSE ?token=/?ticket= 端点），
 * 同类缺口（自注册端点逃出断言网）不再依赖人肉发现。
 * - guarded：权限点保护（登记进 routeMatrix，断言网对普通成员探针断言 403）；
 * - authenticated：仅控制台鉴权中间件要求 Bearer，无独立权限点（身份自辖端点）；
 * - public：免鉴权白名单；selfValidated=true 表示处理器自带凭证校验（fail-closed），
 *   断言网对其实施匿名探针必须被拒的覆盖断言。
 */
export type RouteAuthDecl =
  | { access: 'guarded'; permission: string }
  | { access: 'authenticated' }
  | { access: 'public'; selfValidated?: boolean }

/** 台账条目：/api/* 外的路由（/oauth/*、/mcp、/docs 等）不属控制台鉴权域，自动归类 outside-api。 */
export type RouteLedgerEntry = { method: string; path: string; auth: RouteAuthDecl | { access: 'outside-api' } }

/** /api/* 路径判定（声明义务的作用域：控制台鉴权中间件与 RBAC 断言网覆盖面）。 */
const isApiPattern = (pattern: string): boolean => pattern === '/api' || pattern.startsWith('/api/')

interface Route {
  method: string
  segments: string[]
  handler: HttpHandler
}

export interface HttpServerConfig {
  port?: number
  host?: string
  /**
   * 对外挂载前缀（默认 ''，即根路径）。挂载进完整 dsh 宿主（plugin-dsh-bridge）时设为 '/rq'：
   * 平台侧所有「根绝对路径」构造（OIDC 授权页 302、SSO 回跳 HTML 等）据此拼接，
   * 保证单入口（dsh web 端口）下 /rq 前缀内的链接自洽。
   */
  externalBase?: string
  /**
   * 跨域放行来源（docs/frontend-host-switching.md：控制台「宿主连接切换」——A 机页面直连 B 机数据面）。
   * 默认 ['*']：数据面是纯 Bearer 通道，跨域请求不携带 Cookie（/dsh-bridge/* 注册在 dsh webServer
   * 根上、不经本分发），放开不改变同源语义；传 [] 关闭；传具体来源列表则精确回显（配合 Vary: Origin）。
   */
  corsAllowOrigins?: string[]
  /**
   * 安全响应头（默认开）：全部响应追加 `x-content-type-options: nosniff`、`x-frame-options: SAMEORIGIN`
   * （挂载形态 /rq 与 dsh web 同源，SAMEORIGIN 不影响宿主面同源内嵌；钉钉 H5 微应用为顶层 webview）、
   * `referrer-policy: strict-origin-when-cross-origin` 与基线 `content-security-policy`（G1-F2）。
   * `SECURITY_HEADERS=off`（或 config false）一键关闭，对齐 PORTAL_SYNC / IAM_CONNECTOR_AUTO_SYNC 惯例。
   */
  securityHeaders?: boolean
}

/**
 * CORS 放行决议（纯函数，selftest 直测）：返回应回写的 access-control-allow-origin 值，
 * 未命中返回 undefined（不发放放行头）。
 */
export function corsAllowOriginFor(allowOrigins: readonly string[], originHeader: string | undefined): string | undefined {
  if (!originHeader || allowOrigins.length === 0) return undefined
  if (allowOrigins.includes('*')) return '*'
  let origin = ''
  try { origin = new URL(originHeader).origin } catch { return undefined }
  return allowOrigins.includes(origin) ? origin : undefined
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json',
}

/**
 * 基线 CSP（G1-F2，随 securityHeaders 开关启停）。取值依据页面实际用法：
 * 控制台/面板为零构建 SPA（外链 module 脚本 + 模板字符串生成的少量内联事件处理器），
 * OIDC 授权页/文档索引为服务端内联样式——script/style 需放行 'unsafe-inline'；
 * connect-src 在 'self' 之上放行 http/https：控制台「宿主连接切换」（docs/frontend-host-switching.md）
 * 会把 API 请求直发远程宿主，仅 'self' 会掐断该特性。后续可收紧路径：内联事件处理器改事件委托
 * （去 script 'unsafe-inline'）；connect-src 收敛为部署显式宿主清单。
 */
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http: https:"

/**
 * 协议/集成保留前缀（C-10）：/oauth、/.well-known、/mcp 是注册在本服务的协议面；
 * /rq、/dsh-bridge、/auth/entry 仅注册在 dsh webServer（独立宿主下本服务无对应处理器）；
 * /api 是数据面、/docs 是随包文档挂载。命中且无任何路由/静态目录匹配时返回 404 JSON，
 * 不再被 SPA 兜底吞成 200 HTML——集成方拿到可诊断的失败信号。
 * 仅作用于「无处理器命中」的兜底分支：已注册路由（/oauth/authorize、/mcp、/docs/* 等）不受影响，
 * 控制台/面板自有页面路由（hash 路由 + /panel、/ 静态挂载）不在此列。
 */
const RESERVED_PATH_PREFIXES = ['/api', '/rq', '/dsh-bridge', '/auth/entry', '/oauth', '/.well-known', '/mcp', '/docs']

const isReservedPath = (pathname: string): boolean =>
  RESERVED_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

export class HttpServerService extends Service {
  static readonly provide = 'httpServer'

  private routes: Route[] = []
  private middlewares: HttpMiddleware[] = []
  private staticDirs: Array<{ prefix: string; dir: string; fallback?: string }> = []
  private server: Server | undefined
  readonly port: number
  readonly host: string
  /** 对外挂载前缀：'' 或形如 '/rq'（无尾斜杠）。见 HttpServerConfig.externalBase。 */
  readonly externalBase: string
  private readonly corsAllowOrigins: string[]
  /** 安全响应头默认开启（nosniff / SAMEORIGIN / Referrer-Policy）；SECURITY_HEADERS=off 或 config 显式 false 关闭。 */
  private readonly securityHeaders: boolean
  /**
   * 路由×权限矩阵（跨插件共享登记处）。register() 对 guarded 声明自动汇入（幂等去重），
   * selftest「RBAC 端点矩阵 100% 越权断言网」据此驱动（review-dsh-agent-panel-v2 Phase 0）。
   */
  readonly routeMatrix: Array<{ method: string; path: string; permission: string }> = []
  /**
   * 全量路由台账（H5）：每个 register 都落一条，/api/* 缺声明在注册期直接抛错（fail-loud），
   * route-matrix 端点据此暴露计数，断言网核对「guarded+public+authenticated 全覆盖」。
   */
  readonly declaredRoutes: RouteLedgerEntry[] = []

  constructor(ctx: Context, config: HttpServerConfig = {}) {
    super(ctx, 'httpServer')
    this.port = config.port ?? 7300
    this.host = config.host ?? '0.0.0.0'
    this.externalBase = (config.externalBase ?? '').replace(/\/+$/, '')
    this.corsAllowOrigins = config.corsAllowOrigins ?? ['*']
    this.securityHeaders = config.securityHeaders ?? process.env.SECURITY_HEADERS !== 'off'
    ctx.effect(() => () => {
      void this.stop()
    })
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => {
      void this.dispatch(req, res)
    })
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        server.removeListener('error', reject)
        resolvePromise()
      })
    })
    this.server = server
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  use(middleware: HttpMiddleware): () => void {
    this.middlewares.push(middleware)
    return () => {
      const index = this.middlewares.indexOf(middleware)
      if (index >= 0) this.middlewares.splice(index, 1)
    }
  }

  register(method: string, pattern: string, handler: HttpHandler, auth?: RouteAuthDecl): () => void {
    // H5（T-01 教训）：/api/* 端点必须声明鉴权 profile，缺声明在注册期即抛错——
    // 插件 apply 期抛错会让装配响亮失败，绝不让未声明端点静默上线逃出断言网。
    if (isApiPattern(pattern) && auth === undefined) {
      throw new Error(
        `httpServer: 注册 ${method.toUpperCase()} ${pattern} 缺少鉴权声明（auth: guarded{permission} | authenticated | public{selfValidated?}）`
        + '——自注册端点必须可被 RBAC 断言网枚举（交接清单 H5）',
      )
    }
    const normalized = auth ?? { access: 'outside-api' as const }
    this.declaredRoutes.push({ method: method.toUpperCase(), path: pattern, auth: normalized })
    if (auth?.access === 'guarded') {
      const key = `${method.toUpperCase()} ${pattern}`
      if (!this.routeMatrix.some((route) => `${route.method} ${route.path}` === key)) {
        this.routeMatrix.push({ method: method.toUpperCase(), path: pattern, permission: auth.permission })
      }
    }
    const segments = pattern.split('/').filter(Boolean)
    const route: Route = { method: method.toUpperCase(), segments, handler }
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index >= 0) this.routes.splice(index, 1)
    }
  }

  /** 便捷注册全部常用动词。 */
  route(pattern: string, handler: HttpHandler, methods = ['GET']): void {
    for (const method of methods) this.register(method, pattern, handler)
  }

  serveStatic(prefix: string, dir: string, fallback?: string): () => void {
    const entry = { prefix, dir: resolve(dir), fallback }
    this.staticDirs.push(entry)
    return () => {
      const index = this.staticDirs.indexOf(entry)
      if (index >= 0) this.staticDirs.splice(index, 1)
    }
  }

  private match(method: string, pathSegments: string[]): { route: Route; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) continue
      if (route.segments.length !== pathSegments.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < route.segments.length; i++) {
        const pattern = route.segments[i]!
        const actual = pathSegments[i]!
        if (pattern.startsWith(':')) {
          params[pattern.slice(1)] = decodeURIComponent(actual)
        } else if (pattern !== actual) {
          matched = false
          break
        }
      }
      if (matched) return { route, params }
    }
    return undefined
  }

  /**
   * 请求入口（公开）。独立形态由 start() 的 listener 调用；挂载形态（plugin-dsh-bridge，
   * 完整 dsh 宿主下的单进程单入口）由 dsh webServer 的前缀路由剥离对外前缀后直接调用。
   * 调用方保证 req.url 已是平台内部路径（/api/*、/、/docs/* 等）。
   */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathSegments = url.pathname.split('/').filter(Boolean).map((s) => s)
    const method = (req.method ?? 'GET').toUpperCase()

    // UI 全球化（2026-10-16）：请求级语言决议（?lang= > Cookie rq_lang > Accept-Language >
    // PLATFORM_LOCALE > zh-CN），以 AsyncLocalStorage 包裹中间件+处理器+静态兜底全链——
    // 任意深度的路由/服务代码调 t() 即得当前请求语言；默认 zh-CN 输出逐字节不变（selftest 零影响）。
    const requestLocale = resolveRequestLocale({
      query: url.searchParams.get('lang'),
      cookie: parseCookieHeader(req.headers.cookie)['rq_lang'],
      acceptLanguage: req.headers['accept-language'],
      env: process.env.PLATFORM_LOCALE,
    })

    // 边缘明文口兜底下跳（外部 QA-20261014 QA-01 / 内部 G1-F1）：平台自身仅 HTTP（TLS 由
    // Cloudflare Tunnel/反代承接），x-forwarded-proto: http 即代表用户走了明文入口，308 保方法
    // 跳转 HTTPS；未带该头的本机/内网直连与 dsh 挂载形态不受影响。根治仍需边缘层
    // 「Always Use HTTPS」，此处为源站兜底。HSTS 仅在确认安全传输时下发（明文链路无意义）。
    const forwardedProto = (req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() ?? ''
    if (forwardedProto === 'http') {
      res.statusCode = 308
      res.setHeader('location', `https://${req.headers.host ?? url.host}${url.pathname}${url.search}`)
      res.end()
      return
    }

    // 安全响应头（默认开，SECURITY_HEADERS=off 关闭）：经 setHeader 预挂，与后续
    // ok/fail/file 的 writeHead 自然合并（与下方 CORS 放行头同一合并机制）。
    if (this.securityHeaders) {
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('x-frame-options', 'SAMEORIGIN')
      res.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
      res.setHeader('content-security-policy', CONTENT_SECURITY_POLICY)
      if (forwardedProto === 'https' || (req.socket as { encrypted?: boolean }).encrypted) {
        res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains')
      }
    }

    // /api/* 数据面一律 no-store（G1-F2）：鉴权/业务响应不得进任何缓存层；
    // 处理器经 writeHead 显式下发的缓存头（portal 契约 no-cache、SSE no-cache、静态 no-cache）优先生效
    if (isApiPattern(url.pathname)) {
      res.setHeader('cache-control', 'no-store')
    }

    // 跨域放行（宿主连接切换，docs/frontend-host-switching.md）：只覆盖平台 REST 数据面 /api/*，
    // 且豁免自管 CORS 的子面——门户通道 /api/portal/* 与 OIDC 协议的 /api/authn/oidc/* 自行按
    // 来源精确放行，不得被放宽（/oauth/*、/.well-known/* 不在 /api 内，天然不受影响）；
    // 令牌铸造/交换面 /api/auth/*（login/refresh/票据兑换等公开端点）对 blanket '*' 永不发放
    // （RQ 澄清第 1 条：防任意网页跨站读取登录响应做 drive-by 凭证探测）——配置具体来源
    // 列表时仍按精确来源放行（corsAllowOriginFor 返回具体 origin 不受此豁免），远程宿主
    // 在线登录由 B 侧显式配置来源，符合零信任默认基调。
    // 先于鉴权中间件——浏览器预检 OPTIONS 不带 Bearer，不得被 401 拦截；放行头经 setHeader
    // 预挂，与后续 ok/fail/file 的 writeHead 自然合并（错误体跨域同样可读）。
    const blanketCorsExempt = url.pathname.startsWith('/api/portal/')
      || url.pathname.startsWith('/api/authn/oidc/')
      || (this.corsAllowOrigins.includes('*') && url.pathname.startsWith('/api/auth/'))
    const blanketCorsPath = url.pathname.startsWith('/api/') && !blanketCorsExempt
    const allowOrigin = blanketCorsPath ? corsAllowOriginFor(this.corsAllowOrigins, req.headers.origin) : undefined
    if (allowOrigin) {
      res.setHeader('access-control-allow-origin', allowOrigin)
      res.setHeader('vary', 'Origin')
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'authorization, content-type'),
          'access-control-max-age': '600',
        })
        res.end()
        return
      }
    }

    let body: any
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const rawBody = Buffer.concat(chunks).toString('utf8')
      if (rawBody) {
        const contentType = String(req.headers['content-type'] ?? '')
        if (contentType.includes('application/json')) {
          try {
            body = JSON.parse(rawBody)
          } catch {
            body = undefined
          }
        } else if (contentType.includes('form')) {
          body = Object.fromEntries(new URLSearchParams(rawBody))
        } else {
          body = rawBody
        }
      }
    }

    const exchange: HttpExchange = {
      method,
      path: url.pathname,
      params: {},
      query: url.searchParams,
      headers: req.headers,
      body,
      raw: req,
      res,
      ok(data, init) {
        // 幂等守卫：错误处理器已写过响应时忽略（连接器路由的错误透传与外层 guarded 的兜底
        // 存在同请求双写路径，二次 writeHead 会抛 ERR_HTTP_HEADERS_SENT）
        if (res.headersSent) return
        const payload = data === undefined ? { ok: true } : { ok: true, data }
        const text = JSON.stringify(payload)
        res.writeHead(init?.status ?? 200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(text)
      },
      fail(status, code, message, extra) {
        if (res.headersSent) return
        const payload = JSON.stringify({ ok: false, error: { code, message, ...extra } })
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(payload)
      },
      file(absolutePath, contentType) {
        void (async () => {
          try {
            // 幂等守卫（与 ok/fail 同款）：错误处理器已写过响应时忽略——本方法体运行在
            // 异步 IIFE 中，二次 writeHead 抛 ERR_HTTP_HEADERS_SENT 且无人接，会以
            // uncaughtException 打死整个宿主进程（gate01-smoke 真机实证，2026-09-10）
            if (res.headersSent) return
            const info = await stat(absolutePath)
            if (!info.isFile()) {
              res.writeHead(404).end('not found')
              return
            }
            const type = contentType ?? MIME[extname(absolutePath)] ?? 'application/octet-stream'
            res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'cache-control': 'no-cache' })
            createReadStream(absolutePath).pipe(res)
          } catch {
            if (!res.headersSent) res.writeHead(404).end('not found')
          }
        })()
      },
    }

    try {
      // 请求级 locale 上下文包裹全链（中间件 → 路由处理器 → 静态/SPA 兜底）
      await runWithLocale(requestLocale, () => this.dispatchInner(exchange, method, pathSegments, url))
    } catch (error) {
      if (!res.writableEnded) {
        // 生产安全：500 兜底不回传内部异常文本，详情仅入服务日志
        exchange.fail(500, 'INTERNAL', t('服务器内部错误，请稍后重试或联系管理员'))
      }
      console.error(`[http] ${method} ${url.pathname} 处理异常`, error)
    }
  }

  /** dispatch 的内层（请求级 locale 上下文内执行）：中间件链 → 路由匹配 → 静态目录/SPA 兜底。 */
  private async dispatchInner(
    exchange: HttpExchange,
    method: string,
    pathSegments: string[],
    url: URL,
  ): Promise<void> {
    const res = exchange.res
    for (const middleware of this.middlewares) {
      const blocked = await middleware(exchange)
      if (blocked === true) return
      if (res.writableEnded) return
    }

    const matched = this.match(method, pathSegments)
    if (matched) {
      exchange.params = matched.params
      await matched.route.handler(exchange)
      return
    }

    // 静态目录最长前缀优先（/docs 等子路径挂载先于 / 兜底；同长保持注册顺序）
    const staticCandidates = this.staticDirs
      .map((entry) => ({ entry, prefix: entry.prefix.replace(/\/$/, '') }))
      .filter(({ prefix }) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
      .sort((a, b) => b.prefix.length - a.prefix.length)
    if (staticCandidates.length > 0) {
      // DEF-01 + C-10：/api 与协议/集成保留前缀（/rq、/dsh-bridge、/auth/entry、/oauth…）永不回落到
      // 静态资源/SPA 页面——无对应路由且无同名静态挂载时一律 404 JSON，集成方拿到可诊断的失败信号；
      // 有真实挂载（如 /docs、/panel 静态目录命中）则照常伺服，控制台自有页面路由不受影响
      const handledByStatic = staticCandidates.some(({ prefix }) => prefix !== '' && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)))
      if (isReservedPath(url.pathname) && !handledByStatic) {
        exchange.fail(404, 'NOT_FOUND', t('路由不存在：{method} {path}', { method, path: url.pathname }))
        return
      }
      const best = staticCandidates[0]!
      await this.serveFromDir(exchange, best.entry, url.pathname.slice(best.prefix.length))
      return
    }
    if (this.staticDirs.length > 0) {
      // SPA 兜底：非协议/集成路径回落到第一个静态目录的 fallback 页（同上 C-10 口径）
      if (!isReservedPath(url.pathname)) {
        const entry = this.staticDirs[0]!
        await this.serveFromDir(exchange, entry, entry.fallback ?? '/index.html')
        return
      }
    }
    exchange.fail(404, 'NOT_FOUND', t('路由不存在：{method} {path}', { method, path: url.pathname }))
  }

  private async serveFromDir(exchange: HttpExchange, entry: { dir: string; fallback?: string }, relative: string): Promise<void> {
    // 百分号解码按段进行（中文等非 ASCII 文件名：浏览器发出的 /docs/<中文>.md 是
    // percent-encoded 形态，不解码 stat 恒 miss → 中文文档 404，QA-20261014 G3-08-D1）。
    // 解码后段内不得出现路径分隔符或 .. ——防 %2F 借解码越过目录（保持与原样路径同级的防穿越强度）。
    let rel = relative
    try {
      rel = relative
        .split('/')
        .map((segment) => {
          const decoded = decodeURIComponent(segment)
          if (decoded.includes('/') || decoded.includes('\\') || decoded === '..') throw new Error('unsafe segment')
          return decoded
        })
        .join('/')
    } catch {
      // 畸形编码（含非法 % 序列或越界段）：按原样路径尝试，由下方 stat 兜底
    }
    let target = join(entry.dir, normalize(rel).replace(/^([/\\])+/, ''))
    if (relative === '' || relative === '/') target = join(entry.dir, 'index.html')
    try {
      const info = await stat(target)
      if (info.isDirectory()) target = join(target, 'index.html')
    } catch {
      // 带扩展名的资源路径未命中（/openapi.json、/js/missing.js、/docs/x.md…）不回落 index.html（issue #6）：
      // 「看起来是 JSON/脚本」的路径回 200 HTML 会让 Agent 的接口探测与健康检查假阳性；SPA 兜底只服务
      // 无扩展名的前端路由（控制台/面板为 hash 路由，深链接路径本就不带扩展名）。
      if (hasFileExtension(rel)) {
        exchange.fail(404, 'NOT_FOUND', t('路由不存在：{method} {path}', { method: exchange.method, path: exchange.path }))
        return
      }
      const fallback = entry.fallback ?? '/index.html'
      target = join(entry.dir, fallback.replace(/^\/+/, ''))
    }
    exchange.file(target)
  }
}

/** 末段含 `.ext`（ext 为 1–8 位字母数字）即视为资源文件路径；`/v1/x`、`/locales/zh-CN` 这类无扩展名路径不算。 */
export function hasFileExtension(pathname: string): boolean {
  const last = pathname.split('/').filter(Boolean).at(-1) ?? ''
  return /\.[a-zA-Z0-9]{1,8}$/.test(last)
}

/** 以当前模块为基准解析资源目录（ESM 下替代 __dirname）。 */
export function assetDir(importMeta: ImportMeta, ...relative: string[]): string {
  return join(fileURLToPath(importMeta.url), '..', '..', ...relative)
}
