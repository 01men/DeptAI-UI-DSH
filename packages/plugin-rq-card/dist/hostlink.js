import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { Readable } from "node:stream";
const RQCARD_CALL_HEADER = "x-rqcard-call";
const PROXY_ALLOW_EXACT = /* @__PURE__ */ new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/entry-ticket-session",
  "/api/authn/entry-tickets/redeem"
]);
const PROXY_ALLOW_PREFIXES = ["/api/auth/sso", "/api/panel/"];
const PROXY_DENY_EXACT = /* @__PURE__ */ new Set([]);
function proxyPathAllowed(path) {
  if (PROXY_DENY_EXACT.has(path)) return false;
  if (PROXY_ALLOW_EXACT.has(path)) return true;
  return PROXY_ALLOW_PREFIXES.some((prefix) => path.startsWith(prefix));
}
const DEFAULT_SCAN_PORTS = [7300, 3080];
const PROBE_TIMEOUT_MS = 350;
const PROBE_TIMEOUT_SLOW_MS = 6e3;
const PROXY_TIMEOUT_MS = 3e4;
const PROBE_TIMEOUT_OVERRIDE_MIN_MS = 500;
const PROBE_TIMEOUT_OVERRIDE_MAX_MS = 3e4;
const SCAN_CANDIDATE_LIMIT = 600;
function normalizeHubBase(input) {
  let value = String(input ?? "").trim();
  if (value === "") throw new Error("\u5BBF\u4E3B\u5730\u5740\u4E0D\u80FD\u4E3A\u7A7A");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme && !/^https?$/i.test(scheme[1])) throw new Error("\u5BBF\u4E3B\u5730\u5740\u4EC5\u652F\u6301 http/https");
  if (!scheme) value = `http://${value}`;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("\u5BBF\u4E3B\u5730\u5740\u4EC5\u652F\u6301 http/https");
  if (!url.hostname) throw new Error("\u5BBF\u4E3B\u5730\u5740\u7F3A\u5C11\u4E3B\u673A\u540D");
  return `${url.protocol}//${url.host}`.replace(/\/+$/, "");
}
class HostLinkService {
  ctx;
  configFile;
  config;
  scanPorts;
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.configFile = join(options.dataDir ?? ctx.opsStorage.dataDirPath, "gate01-host-link.json");
    this.config = this.load();
    this.scanPorts = options.scanPorts ?? DEFAULT_SCAN_PORTS;
  }
  /** 当前配置（对外只读）。 */
  getConfig() {
    return this.config;
  }
  /** 是否已连接（local/remote 均算；none=向导首启态）。 */
  isLinked() {
    return this.config.mode !== "none";
  }
  // ---------------------------------------------------------------- 配置三通道
  /** 声明本机宿主模式（形态 B：本插件与数据面同进程，幂等）。 */
  setLocal(label) {
    this.config = { mode: "local", ...label ? { label } : {}, savedAt: (/* @__PURE__ */ new Date()).toISOString() };
    this.save();
    return this.config;
  }
  /**
   * 连接远端宿主（形态 C）：先探测（自动判定挂载前缀），可达才落盘。
   *
   * 【两级探测（issue #5，2026-10-29）】默认先快档（1.4s/前缀，局域网体验不变），
   * 全部超时再以放宽档（6s/前缀）复探一轮——公网/跨网宿主 TLS+往返常超快档上限，
   * 单级快探会把可达宿主误判为不可达。`timeoutMs` 显式覆盖（向导可传，钳制在
   * 0.5s–30s）时只跑单级：调用方自己决定了判定窗，不再二次等待。
   */
  async setRemote(hubBaseInput, label, opts = {}) {
    const hubBase = normalizeHubBase(hubBaseInput);
    const override = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.min(PROBE_TIMEOUT_OVERRIDE_MAX_MS, Math.max(PROBE_TIMEOUT_OVERRIDE_MIN_MS, Math.round(opts.timeoutMs))) : null;
    let probe = await this.probeHub(hubBase, override ?? PROBE_TIMEOUT_MS * 4);
    if (!probe.reachable && override === null) {
      probe = await this.probeHub(hubBase, PROBE_TIMEOUT_SLOW_MS);
    }
    if (!probe.reachable) {
      throw new Error(`\u5BBF\u4E3B\u4E0D\u53EF\u8FBE\uFF1A${hubBase}\uFF08\u5065\u5EB7\u68C0\u67E5\u65E0\u54CD\u5E94\uFF0C\u8BF7\u786E\u8BA4\u5730\u5740/\u7AEF\u53E3/\u9632\u706B\u5899\uFF1B\u8DE8\u7F51\u5BBF\u4E3B\u7F51\u7EDC\u6162\u65F6\u5DF2\u653E\u5BBD\u5230 6s/\u524D\u7F00\u590D\u63A2\u8FC7\u4E00\u8F6E\uFF0C\u4ECD\u4E0D\u901A\u591A\u534A\u662F\u5730\u5740\u6216\u7F51\u7EDC\u4E0D\u901A\uFF09`);
    }
    this.config = {
      mode: "remote",
      hubBase,
      hubMountPrefix: probe.mountPrefix ?? "",
      ...label ? { label } : {},
      savedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.save();
    return { config: this.config, probe };
  }
  /** 断开：回到未配置态（远端连接凭据在浏览器侧，本服务无令牌可清）。 */
  reset() {
    this.config = { mode: "none" };
    this.save();
    return this.config;
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
  async probeHub(hubBase, timeoutMs = PROBE_TIMEOUT_MS * 4) {
    for (const mountPrefix of ["/gate01", "/rq", ""]) {
      const url = `${hubBase}${mountPrefix}/api/health`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
        if (!response.ok) continue;
        const contentType = String(response.headers.get("content-type") ?? "");
        if (!contentType.includes("json")) continue;
        const payload = await response.json().catch(() => null);
        if (payload?.ok !== true) continue;
        return { reachable: true, status: response.status, version: payload.data?.version, mountPrefix };
      } catch {
      }
    }
    return { reachable: false, status: 0 };
  }
  /**
   * 局域网扫描：各 IPv4 网卡 /24 网段 × 候选端口，并行短超时探活。
   * @param candidates 显式候选（测试注入 / 向导历史地址），缺省按网卡推导。
   */
  async scan(candidates) {
    let list;
    if (Array.isArray(candidates) && candidates.length > 0) {
      list = candidates.map((item) => normalizeHubBase(String(item)));
    } else {
      const seen = /* @__PURE__ */ new Set();
      list = [];
      for (const addrs of Object.values(networkInterfaces())) {
        for (const addr of addrs ?? []) {
          if (addr.family !== "IPv4" || addr.internal) continue;
          const base = addr.address.split(".").slice(0, 3).join(".");
          for (let host = 1; host <= 254; host++) {
            for (const port of this.scanPorts) {
              const endpoint = `http://${base}.${host}:${port}`;
              if (!seen.has(endpoint)) {
                seen.add(endpoint);
                list.push(endpoint);
              }
            }
          }
        }
      }
    }
    const bounded = list.slice(0, SCAN_CANDIDATE_LIMIT);
    const found = [];
    await Promise.all(bounded.map(async (endpoint) => {
      const probe = await this.probeHub(endpoint).catch(() => null);
      if (probe?.reachable) found.push({ endpoint, mountPrefix: probe.mountPrefix ?? "", version: probe.version });
    }));
    return { hosts: found, scanned: bounded.length };
  }
  // ---------------------------------------------------------------- 代理（remote 模式数据面）
  /**
   * 把一次面板/auth 请求转发到远端宿主。白名单校验先于模式校验（未连接时
   * 白名单外路径同样回 403 PROXY_PATH_DENIED，语义不随连接状态漂移）。
   * 返回给 dispatch 的处理结果由调用方（中间件包装）写回响应。
   */
  async proxy(exchange) {
    const path = exchange.path.replace(/^\/rqcard\/proxy/, "") || "/";
    if (!proxyPathAllowed(path)) {
      exchange.fail(403, "PROXY_PATH_DENIED", `\u4EE3\u7406\u767D\u540D\u5355\u4E4B\u5916\u7684\u8DEF\u7531\uFF1A${path}`);
      return;
    }
    if (this.config.mode !== "remote" || !this.config.hubBase) {
      exchange.fail(409, "NOT_REMOTE", "\u5F53\u524D\u4E0D\u662F\u8FDC\u7AEF\u8FDE\u63A5\u6A21\u5F0F\uFF08\u5148\u5728\u5411\u5BFC\u91CC\u9009\u62E9\u5E76\u8FDE\u63A5\u5BBF\u4E3B\uFF09");
      return;
    }
    const query = exchange.query.toString();
    const target = `${this.config.hubBase}${this.config.hubMountPrefix ?? ""}${path}${query ? `?${query}` : ""}`;
    const streamPath = path === "/api/panel/stream";
    const headers = { accept: streamPath ? "text/event-stream" : "application/json" };
    const authorization = exchange.headers.authorization;
    if (authorization !== void 0) headers.authorization = String(authorization);
    let bodyText;
    if (exchange.body !== void 0) {
      bodyText = typeof exchange.body === "string" ? exchange.body : JSON.stringify(exchange.body);
      headers["content-type"] = "application/json";
    }
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(target, {
        method: exchange.method === "HEAD" ? "GET" : exchange.method,
        headers,
        body: bodyText,
        redirect: "manual",
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(guard);
      const message = error instanceof Error ? error.message : String(error);
      exchange.fail(502, "HUB_UNREACHABLE", `\u8FDC\u7AEF\u5BBF\u4E3B\u4E0D\u53EF\u8FBE\uFF1A${message}`);
      return;
    }
    if (streamPath && response.ok && String(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const streamHeaders = {
        "content-type": String(response.headers.get("content-type") ?? "text/event-stream")
      };
      const cacheControl = response.headers.get("cache-control");
      if (cacheControl) streamHeaders["cache-control"] = cacheControl;
      exchange.res.writeHead(response.status, streamHeaders);
      const upstream = Readable.fromWeb(response.body);
      const finish = () => {
        clearTimeout(guard);
        if (!exchange.res.writableEnded) exchange.res.end();
      };
      upstream.on("data", (chunk) => {
        if (!exchange.res.writableEnded) exchange.res.write(chunk);
      });
      upstream.on("end", finish);
      upstream.on("error", finish);
      exchange.res.on("close", () => {
        upstream.destroy();
        finish();
      });
      return;
    }
    clearTimeout(guard);
    const responseContentType = String(response.headers.get("content-type") ?? "");
    if (responseContentType.includes("text/html")) {
      exchange.fail(502, "HUB_BAD_RESPONSE", "\u5BBF\u4E3B\u8FD4\u56DE\u4E86 HTML \u800C\u975E JSON\uFF08\u5730\u5740\u6216\u6302\u8F7D\u524D\u7F00\u53EF\u80FD\u4E0D\u5339\u914D\uFF0C\u8BF7\u5728\u5411\u5BFC\u91CC\u91CD\u65B0\u6D4B\u8BD5\u8FDE\u63A5\uFF09");
      return;
    }
    const text = await response.text().catch(() => "");
    if (!exchange.res.writableEnded) {
      const headers2 = { "content-type": String(response.headers.get("content-type") ?? "application/json; charset=utf-8") };
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) headers2.location = location;
      exchange.res.writeHead(response.status, headers2);
      exchange.res.end(text);
    }
  }
  // ---------------------------------------------------------------- 落盘
  // plan-gate01 决策 1（2026-09-10）：「本机初始化」整链（形态 B 设口令：admin 初始口令文件判定、
  // 首登改密重登、对外网卡枚举）已删除——本机/远端统一为「连接宿主」流程，登录在宿主侧完成，
  // 本插件不再持有 iam/authn 依赖（inject 已收缩为 httpServer/tools/opsStorage）。
  // ---------------------------------------------------------------- 落盘
  load() {
    try {
      const raw = readFileSync(this.configFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && (parsed.mode === "none" || parsed.mode === "local" || parsed.mode === "remote")) return parsed;
    } catch {
    }
    return { mode: "none" };
  }
  save() {
    writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), { mode: 384 });
    try {
      chmodSync(this.configFile, 384);
    } catch {
    }
  }
}
export {
  HostLinkService,
  RQCARD_CALL_HEADER,
  normalizeHubBase,
  proxyPathAllowed
};
