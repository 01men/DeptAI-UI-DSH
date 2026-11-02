import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Service } from "@deepseek-ai/cordis";
import { parseCookieHeader, resolveRequestLocale, runWithLocale, t } from "../../platform-i18n/dist/index.js";
const isApiPattern = (pattern) => pattern === "/api" || pattern.startsWith("/api/");
function corsAllowOriginFor(allowOrigins, originHeader) {
  if (!originHeader || allowOrigins.length === 0) return void 0;
  if (allowOrigins.includes("*")) return "*";
  let origin = "";
  try {
    origin = new URL(originHeader).origin;
  } catch {
    return void 0;
  }
  return allowOrigins.includes(origin) ? origin : void 0;
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".map": "application/json"
};
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http: https:";
const RESERVED_PATH_PREFIXES = ["/api", "/rq", "/dsh-bridge", "/auth/entry", "/oauth", "/.well-known", "/mcp", "/docs"];
const isReservedPath = (pathname) => RESERVED_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
class HttpServerService extends Service {
  static provide = "httpServer";
  routes = [];
  middlewares = [];
  staticDirs = [];
  server;
  port;
  host;
  /** 对外挂载前缀：'' 或形如 '/rq'（无尾斜杠）。见 HttpServerConfig.externalBase。 */
  externalBase;
  corsAllowOrigins;
  /** 安全响应头默认开启（nosniff / SAMEORIGIN / Referrer-Policy）；SECURITY_HEADERS=off 或 config 显式 false 关闭。 */
  securityHeaders;
  /**
   * 路由×权限矩阵（跨插件共享登记处）。register() 对 guarded 声明自动汇入（幂等去重），
   * selftest「RBAC 端点矩阵 100% 越权断言网」据此驱动（review-dsh-agent-panel-v2 Phase 0）。
   */
  routeMatrix = [];
  /**
   * 全量路由台账（H5）：每个 register 都落一条，/api/* 缺声明在注册期直接抛错（fail-loud），
   * route-matrix 端点据此暴露计数，断言网核对「guarded+public+authenticated 全覆盖」。
   */
  declaredRoutes = [];
  constructor(ctx, config = {}) {
    super(ctx, "httpServer");
    this.port = config.port ?? 7300;
    this.host = config.host ?? "0.0.0.0";
    this.externalBase = (config.externalBase ?? "").replace(/\/+$/, "");
    this.corsAllowOrigins = config.corsAllowOrigins ?? ["*"];
    this.securityHeaders = config.securityHeaders ?? process.env.SECURITY_HEADERS !== "off";
    ctx.effect(() => () => {
      void this.stop();
    });
  }
  async start() {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.dispatch(req, res);
    });
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.removeListener("error", reject);
        resolvePromise();
      });
    });
    this.server = server;
  }
  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = void 0;
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }
  use(middleware) {
    this.middlewares.push(middleware);
    return () => {
      const index = this.middlewares.indexOf(middleware);
      if (index >= 0) this.middlewares.splice(index, 1);
    };
  }
  register(method, pattern, handler, auth) {
    if (isApiPattern(pattern) && auth === void 0) {
      throw new Error(
        `httpServer: \u6CE8\u518C ${method.toUpperCase()} ${pattern} \u7F3A\u5C11\u9274\u6743\u58F0\u660E\uFF08auth: guarded{permission} | authenticated | public{selfValidated?}\uFF09\u2014\u2014\u81EA\u6CE8\u518C\u7AEF\u70B9\u5FC5\u987B\u53EF\u88AB RBAC \u65AD\u8A00\u7F51\u679A\u4E3E\uFF08\u4EA4\u63A5\u6E05\u5355 H5\uFF09`
      );
    }
    const normalized = auth ?? { access: "outside-api" };
    this.declaredRoutes.push({ method: method.toUpperCase(), path: pattern, auth: normalized });
    if (auth?.access === "guarded") {
      const key = `${method.toUpperCase()} ${pattern}`;
      if (!this.routeMatrix.some((route2) => `${route2.method} ${route2.path}` === key)) {
        this.routeMatrix.push({ method: method.toUpperCase(), path: pattern, permission: auth.permission });
      }
    }
    const segments = pattern.split("/").filter(Boolean);
    const route = { method: method.toUpperCase(), segments, handler };
    this.routes.push(route);
    return () => {
      const index = this.routes.indexOf(route);
      if (index >= 0) this.routes.splice(index, 1);
    };
  }
  /** 便捷注册全部常用动词。 */
  route(pattern, handler, methods = ["GET"]) {
    for (const method of methods) this.register(method, pattern, handler);
  }
  serveStatic(prefix, dir, fallback) {
    const entry = { prefix, dir: resolve(dir), fallback };
    this.staticDirs.push(entry);
    return () => {
      const index = this.staticDirs.indexOf(entry);
      if (index >= 0) this.staticDirs.splice(index, 1);
    };
  }
  match(method, pathSegments) {
    for (const route of this.routes) {
      if (route.method !== method && !(route.method === "GET" && method === "HEAD")) continue;
      if (route.segments.length !== pathSegments.length) continue;
      const params = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const pattern = route.segments[i];
        const actual = pathSegments[i];
        if (pattern.startsWith(":")) {
          params[pattern.slice(1)] = decodeURIComponent(actual);
        } else if (pattern !== actual) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return void 0;
  }
  /**
   * 请求入口（公开）。独立形态由 start() 的 listener 调用；挂载形态（plugin-dsh-bridge，
   * 完整 dsh 宿主下的单进程单入口）由 dsh webServer 的前缀路由剥离对外前缀后直接调用。
   * 调用方保证 req.url 已是平台内部路径（/api/*、/、/docs/* 等）。
   */
  async dispatch(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathSegments = url.pathname.split("/").filter(Boolean).map((s) => s);
    const method = (req.method ?? "GET").toUpperCase();
    const requestLocale = resolveRequestLocale({
      query: url.searchParams.get("lang"),
      cookie: parseCookieHeader(req.headers.cookie)["rq_lang"],
      acceptLanguage: req.headers["accept-language"],
      env: process.env.PLATFORM_LOCALE
    });
    const forwardedProto = (req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() ?? "";
    if (forwardedProto === "http") {
      res.statusCode = 308;
      res.setHeader("location", `https://${req.headers.host ?? url.host}${url.pathname}${url.search}`);
      res.end();
      return;
    }
    if (this.securityHeaders) {
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("x-frame-options", "SAMEORIGIN");
      res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
      res.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
      if (forwardedProto === "https" || req.socket.encrypted) {
        res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
      }
    }
    if (isApiPattern(url.pathname)) {
      res.setHeader("cache-control", "no-store");
    }
    const blanketCorsExempt = url.pathname.startsWith("/api/portal/") || url.pathname.startsWith("/api/authn/oidc/") || this.corsAllowOrigins.includes("*") && url.pathname.startsWith("/api/auth/");
    const blanketCorsPath = url.pathname.startsWith("/api/") && !blanketCorsExempt;
    const allowOrigin = blanketCorsPath ? corsAllowOriginFor(this.corsAllowOrigins, req.headers.origin) : void 0;
    if (allowOrigin) {
      res.setHeader("access-control-allow-origin", allowOrigin);
      res.setHeader("vary", "Origin");
      if (method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "access-control-allow-headers": String(req.headers["access-control-request-headers"] ?? "authorization, content-type"),
          "access-control-max-age": "600"
        });
        res.end();
        return;
      }
    }
    let body;
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      if (rawBody) {
        const contentType = String(req.headers["content-type"] ?? "");
        if (contentType.includes("application/json")) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            body = void 0;
          }
        } else if (contentType.includes("form")) {
          body = Object.fromEntries(new URLSearchParams(rawBody));
        } else {
          body = rawBody;
        }
      }
    }
    const exchange = {
      method,
      path: url.pathname,
      params: {},
      query: url.searchParams,
      headers: req.headers,
      body,
      raw: req,
      res,
      ok(data, init) {
        if (res.headersSent) return;
        const payload = data === void 0 ? { ok: true } : { ok: true, data };
        const text = JSON.stringify(payload);
        res.writeHead(init?.status ?? 200, { "content-type": "application/json; charset=utf-8" });
        res.end(text);
      },
      fail(status, code, message, extra) {
        if (res.headersSent) return;
        const payload = JSON.stringify({ ok: false, error: { code, message, ...extra } });
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(payload);
      },
      file(absolutePath, contentType) {
        void (async () => {
          try {
            if (res.headersSent) return;
            const info = await stat(absolutePath);
            if (!info.isFile()) {
              res.writeHead(404).end("not found");
              return;
            }
            const type = contentType ?? MIME[extname(absolutePath)] ?? "application/octet-stream";
            res.writeHead(200, { "content-type": type, "content-length": info.size, "cache-control": "no-cache" });
            createReadStream(absolutePath).pipe(res);
          } catch {
            if (!res.headersSent) res.writeHead(404).end("not found");
          }
        })();
      }
    };
    try {
      await runWithLocale(requestLocale, () => this.dispatchInner(exchange, method, pathSegments, url));
    } catch (error) {
      if (!res.writableEnded) {
        exchange.fail(500, "INTERNAL", t("\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u6216\u8054\u7CFB\u7BA1\u7406\u5458"));
      }
      console.error(`[http] ${method} ${url.pathname} \u5904\u7406\u5F02\u5E38`, error);
    }
  }
  /** dispatch 的内层（请求级 locale 上下文内执行）：中间件链 → 路由匹配 → 静态目录/SPA 兜底。 */
  async dispatchInner(exchange, method, pathSegments, url) {
    const res = exchange.res;
    for (const middleware of this.middlewares) {
      const blocked = await middleware(exchange);
      if (blocked === true) return;
      if (res.writableEnded) return;
    }
    const matched = this.match(method, pathSegments);
    if (matched) {
      exchange.params = matched.params;
      await matched.route.handler(exchange);
      return;
    }
    const staticCandidates = this.staticDirs.map((entry) => ({ entry, prefix: entry.prefix.replace(/\/$/, "") })).filter(({ prefix }) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)).sort((a, b) => b.prefix.length - a.prefix.length);
    if (staticCandidates.length > 0) {
      const handledByStatic = staticCandidates.some(({ prefix }) => prefix !== "" && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)));
      if (isReservedPath(url.pathname) && !handledByStatic) {
        exchange.fail(404, "NOT_FOUND", t("\u8DEF\u7531\u4E0D\u5B58\u5728\uFF1A{method} {path}", { method, path: url.pathname }));
        return;
      }
      const best = staticCandidates[0];
      await this.serveFromDir(exchange, best.entry, url.pathname.slice(best.prefix.length));
      return;
    }
    if (this.staticDirs.length > 0) {
      if (!isReservedPath(url.pathname)) {
        const entry = this.staticDirs[0];
        await this.serveFromDir(exchange, entry, entry.fallback ?? "/index.html");
        return;
      }
    }
    exchange.fail(404, "NOT_FOUND", t("\u8DEF\u7531\u4E0D\u5B58\u5728\uFF1A{method} {path}", { method, path: url.pathname }));
  }
  async serveFromDir(exchange, entry, relative) {
    let rel = relative;
    try {
      rel = relative.split("/").map((segment) => {
        const decoded = decodeURIComponent(segment);
        if (decoded.includes("/") || decoded.includes("\\") || decoded === "..") throw new Error("unsafe segment");
        return decoded;
      }).join("/");
    } catch {
    }
    let target = join(entry.dir, normalize(rel).replace(/^([/\\])+/, ""));
    if (relative === "" || relative === "/") target = join(entry.dir, "index.html");
    try {
      const info = await stat(target);
      if (info.isDirectory()) target = join(target, "index.html");
    } catch {
      if (hasFileExtension(rel)) {
        exchange.fail(404, "NOT_FOUND", t("\u8DEF\u7531\u4E0D\u5B58\u5728\uFF1A{method} {path}", { method: exchange.method, path: exchange.path }));
        return;
      }
      const fallback = entry.fallback ?? "/index.html";
      target = join(entry.dir, fallback.replace(/^\/+/, ""));
    }
    exchange.file(target);
  }
}
function hasFileExtension(pathname) {
  const last = pathname.split("/").filter(Boolean).at(-1) ?? "";
  return /\.[a-zA-Z0-9]{1,8}$/.test(last);
}
function assetDir(importMeta, ...relative) {
  return join(fileURLToPath(importMeta.url), "..", "..", ...relative);
}
export {
  HttpServerService,
  assetDir,
  corsAllowOriginFor,
  hasFileExtension
};
