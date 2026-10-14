import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
const name = "dsh-bridge";
const inject = ["webServer", "httpServer", "opsStorage"];
const softRead = (ctx, key) => {
  try {
    if (typeof ctx?.reflect?.get === "function") return ctx.reflect.get(key, false);
    return ctx?.[key];
  } catch {
    return void 0;
  }
};
const BIND_TOKEN_PREFIX = "rbs_";
const DEFAULT_COOKIE = "rq_sid";
const DEFAULT_TTL_SECONDS = 24 * 3600;
const MAX_BINDINGS = 500;
const base64url = (input) => input.toString("base64url");
const originOf = (req) => {
  const proto = String(req.headers["x-forwarded-proto"] ?? "http");
  return `${proto}://${req.headers.host ?? "localhost"}`;
};
class IdentityBindingService extends Service {
  static provide = "identityBinding";
  byToken = /* @__PURE__ */ new Map();
  bySession = /* @__PURE__ */ new Map();
  current;
  ttlMs;
  cookieName;
  constructor(ctx, config = {}) {
    super(ctx, "identityBinding");
    this.cookieName = config.cookieName ?? DEFAULT_COOKIE;
    this.ttlMs = (config.bindTtlSeconds ?? DEFAULT_TTL_SECONDS) * 1e3;
  }
  /** 兑换票据并建立绑定：一次性消费 + 实时账号状态校验在 redeem 内完成。 */
  bindByTicket(redeem, ticket) {
    const result = redeem(ticket);
    const token = BIND_TOKEN_PREFIX + randomBytes(24).toString("hex");
    const record = {
      token,
      userId: result.identity.sub,
      name: result.identity.name ?? result.identity.sub,
      roles: result.identity.roles ?? [],
      orgId: result.identity.org?.id,
      issuedAt: Date.now()
    };
    this.evictExpired();
    if (this.byToken.size >= MAX_BINDINGS) {
      const oldest = [...this.byToken.values()].sort((a, b) => a.issuedAt - b.issuedAt)[0];
      if (oldest) this.byToken.delete(oldest.token);
    }
    this.byToken.set(token, record);
    this.current = record;
    return { token, identity: this.publicIdentity(record) };
  }
  /** 读 Cookie 解析绑定身份：过期/未知/账号非 active 一律视为未绑定。 */
  identityForCookie(cookieHeader) {
    const token = this.readCookieToken(cookieHeader);
    if (!token) return void 0;
    const record = this.byToken.get(token);
    if (!record || Date.now() - record.issuedAt > this.ttlMs) return void 0;
    if (!this.isAccountActive(record.userId)) return void 0;
    return this.publicIdentity(record);
  }
  /**
   * 绑定自检（WP-04/A2）：带可识别原因码的绑定态查询——
   * no_cookie（从未绑定/已注销）/ expired（绑定过期）/ account_inactive（账号冻结离职联动失效）。
   * 工作台横幅与重绑引导按 reason 出文案（errors.js「身份绑定已失效」族）。
   */
  bindingStatus(cookieHeader) {
    const token = this.readCookieToken(cookieHeader);
    if (!token) return { bound: false, reason: "no_cookie" };
    const record = this.byToken.get(token);
    if (!record || Date.now() - record.issuedAt > this.ttlMs) return { bound: false, reason: "expired" };
    if (!this.isAccountActive(record.userId)) return { bound: false, reason: "account_inactive" };
    return { bound: true, identity: this.publicIdentity(record) };
  }
  /** 直接以平台身份建立绑定（OIDC 授权码通道：userinfo 换取后）。 */
  bindIdentity(identity) {
    const token = BIND_TOKEN_PREFIX + randomBytes(24).toString("hex");
    const record = {
      token,
      userId: identity.sub,
      name: identity.name ?? identity.sub,
      roles: identity.roles ?? [],
      orgId: identity.org?.id,
      issuedAt: Date.now()
    };
    this.evictExpired();
    this.byToken.set(token, record);
    this.current = record;
    return token;
  }
  /** 绑定 dsh 会话（浏览器引导脚本调用；Cookie 定身份）。 */
  bindSession(sessionId, cookieHeader) {
    const identity = this.identityForCookie(cookieHeader);
    if (!identity) return false;
    this.evictExpired();
    if (this.bySession.size >= MAX_BINDINGS) {
      const oldest = this.bySession.keys().next().value;
      if (oldest !== void 0) this.bySession.delete(oldest);
    }
    this.bySession.set(sessionId, String(identity.sub));
    return true;
  }
  /** 工具出站归因解析：会话绑定优先，未绑定回落最近一次绑定（单操作者姿态）。 */
  identityForSession(sessionId) {
    this.evictExpired();
    const boundId = sessionId ? this.bySession.get(sessionId) : void 0;
    const record = (boundId && [...this.byToken.values()].find((item) => item.userId === boundId)) ?? this.current;
    if (!record || Date.now() - record.issuedAt > this.ttlMs) return void 0;
    if (!this.isAccountActive(record.userId)) return void 0;
    return { userId: record.userId, name: record.name };
  }
  /** 注销：移除该 Cookie 的绑定（会话绑定随 TTL 自然过期）。 */
  revoke(cookieHeader) {
    const token = this.readCookieToken(cookieHeader);
    if (token) this.byToken.delete(token);
  }
  get cookie() {
    return this.cookieName;
  }
  publicIdentity(record) {
    return { sub: record.userId, name: record.name, roles: record.roles, org: record.orgId ? { id: record.orgId } : void 0 };
  }
  readCookieToken(cookieHeader) {
    if (!cookieHeader) return void 0;
    for (const part of cookieHeader.split(";")) {
      const [name2, ...rest] = part.trim().split("=");
      if (name2 === this.cookieName) return decodeURIComponent(rest.join("="));
    }
    return void 0;
  }
  isAccountActive(userId) {
    try {
      const iam = softRead(this.ctx, "iam");
      const user = iam?.users().get(userId);
      if (!user) return false;
      return user.status === void 0 || user.status === "active";
    } catch {
      return false;
    }
  }
  evictExpired() {
    const now = Date.now();
    for (const [token, record] of this.byToken) {
      if (now - record.issuedAt > this.ttlMs) this.byToken.delete(token);
    }
  }
}
function apply(ctx, config = {}) {
  const mountPath = (config.mountPath ?? "/rq").replace(/\/+$/, "");
  let prebound;
  try {
    prebound = ctx.identityBinding;
  } catch {
    prebound = void 0;
  }
  const bindingService = prebound ?? new IdentityBindingService(ctx, { cookieName: config.cookieName, bindTtlSeconds: config.bindTtlSeconds });
  if (!mountPath.startsWith("/") || mountPath === "/") {
    throw new Error(`dsh-bridge mountPath \u975E\u6CD5\uFF1A${JSON.stringify(config.mountPath)}\uFF08\u987B\u4E3A\u4EE5 / \u5F00\u5934\u7684\u975E\u6839\u8DEF\u5F84\uFF09`);
  }
  const webServer = ctx.webServer;
  const httpServer = ctx.httpServer;
  if (!webServer || typeof webServer.register !== "function") {
    throw new Error("dsh-bridge \u9700\u8981 ctx.webServer\uFF08\u4EC5\u5728\u5B8C\u6574 dsh web \u5BBF\u4E3B\u4E0B\u88C5\u914D\u672C\u63D2\u4EF6\uFF09");
  }
  if (!httpServer) {
    throw new Error("dsh-bridge \u9700\u8981 ctx.httpServer\uFF08platform-core \u5FC5\u987B\u5148\u4E8E\u672C\u63D2\u4EF6\u88C5\u914D\uFF09");
  }
  webServer.register({
    kind: "prefix",
    path: mountPath,
    handler(req, res) {
      const url = req.url ?? "/";
      if (url === mountPath) {
        res.writeHead(302, { location: `${mountPath}/` }).end();
        return;
      }
      const inner = url.startsWith(`${mountPath}/`) ? url.slice(mountPath.length) : url;
      req.url = inner.startsWith("/") ? inner : `/${inner}`;
      void httpServer.dispatch(req, res);
    }
  });
  ctx.logger("dsh-bridge").info(`\u5143\u51B0\u53EF\u6570\u636E\u9762\u5DF2\u6302\u8F7D\u81F3 dsh webServer\uFF1A${mountPath}/*\uFF08\u5355\u8FDB\u7A0B\u5355\u5165\u53E3\uFF09`);
  const binding = bindingService;
  const entryTicketsAt = () => softRead(ctx, "entryTickets");
  if (!binding) {
    ctx.logger("dsh-bridge").warn("\u8EAB\u4EFD\u534A\u672A\u88C5\u914D\uFF1A\u7F3A\u5C11 identityBinding \u670D\u52A1\uFF08\u4EC5\u6302\u8F7D\u534A\u751F\u6548\uFF09");
    return;
  }
  const redeemTicket = (ticket) => {
    const entryTickets = entryTicketsAt();
    if (!entryTickets) throw new Error("entryTickets \u670D\u52A1\u672A\u5C31\u7EEA\uFF08\u88C5\u914D\u8FDB\u884C\u4E2D\uFF09\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    return entryTickets.redeem(ticket, "dsh-bridge");
  };
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = req.headers.host ?? "";
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  };
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  };
  const cookieAttrs = (token, maxAge) => `${config.cookieName ?? DEFAULT_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  webServer.register({
    kind: "exact",
    path: "/auth/entry",
    handler(req, res) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const ticket = url.searchParams.get("entry_ticket") ?? url.searchParams.get("ticket") ?? "";
      if (!ticket) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("missing entry_ticket");
        return;
      }
      try {
        const bound = binding.bindByTicket((t) => redeemTicket(t), ticket);
        res.writeHead(302, {
          "set-cookie": cookieAttrs(bound.token, config.bindTtlSeconds ?? DEFAULT_TTL_SECONDS),
          location: "/"
        }).end();
      } catch (error) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(`entry_ticket \u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  webServer.register({
    kind: "prefix",
    path: "/dsh-bridge",
    handler(req, res) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const endpoint = url.pathname.replace(/^\/dsh-bridge\/?/, "");
      if (!sameOrigin(req)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const json = (status, payload, extraHeaders = {}) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders }).end(JSON.stringify(payload));
      };
      if (req.method === "POST" && endpoint === "redeem") {
        void readBody(req).then((body) => {
          const ticket = String(body["ticket"] ?? "");
          if (!ticket) {
            json(400, { ok: false, error: { code: "BAD_REQUEST", message: "missing ticket" } });
            return;
          }
          try {
            const bound = binding.bindByTicket((t) => redeemTicket(t), ticket);
            json(200, { ok: true, data: { identity: bound.identity } }, {
              "set-cookie": cookieAttrs(bound.token, config.bindTtlSeconds ?? DEFAULT_TTL_SECONDS)
            });
          } catch (error) {
            json(400, { ok: false, error: { code: "INVALID_TICKET", message: error instanceof Error ? error.message : String(error) } });
          }
        });
        return;
      }
      if (req.method === "GET" && endpoint === "status") {
        const status = binding.bindingStatus(req.headers.cookie);
        json(200, { ok: true, data: status });
        return;
      }
      if (req.method === "POST" && endpoint === "logout") {
        binding.revoke(req.headers.cookie);
        json(200, { ok: true, data: { bound: false } }, { "set-cookie": `${config.cookieName ?? DEFAULT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
        return;
      }
      if (req.method === "POST" && endpoint === "bind-session") {
        void readBody(req).then((body) => {
          const sessionId = String(body["sessionId"] ?? "");
          if (!sessionId) {
            json(400, { ok: false, error: { code: "BAD_REQUEST", message: "missing sessionId" } });
            return;
          }
          const okFlag = binding.bindSession(sessionId, req.headers.cookie);
          json(okFlag ? 200 : 401, { ok: okFlag, data: { bound: okFlag } });
        });
        return;
      }
      if (req.method === "POST" && endpoint === "session") {
        void (async () => {
          const status = binding.bindingStatus(req.headers.cookie);
          if (!status.bound || !status.identity) {
            json(401, { ok: false, error: { code: "NOT_BOUND", message: `\u5BBF\u4E3B\u4F1A\u8BDD\u672A\u7ED1\u5B9A\uFF08${status.reason ?? "unknown"}\uFF09\u2014\u2014\u8BF7\u4ECE dsh \u5BBF\u4E3B\u5165\u53E3\u8FDB\u5165\u6216\u4F7F\u7528\u5165\u573A\u7968\u636E` } });
            return;
          }
          const deps = {
            get authn() {
              return softRead(ctx, "authn");
            },
            get iam() {
              return softRead(ctx, "iam");
            },
            get audit() {
              return softRead(ctx, "audit");
            }
          };
          if (!deps.authn || !deps.iam) {
            json(503, { ok: false, error: { code: "AUTHN_UNAVAILABLE", message: "authn \u670D\u52A1\u4E0D\u53EF\u7528\uFF08\u6302\u8F7D\u5F62\u6001\u88C5\u914D\u4E0D\u5B8C\u6574\uFF09" } });
            return;
          }
          const user = deps.iam.users().get(String(status.identity.sub));
          if (!user || user.status !== void 0 && user.status !== "active") {
            json(401, { ok: false, error: { code: "ACCOUNT_INACTIVE", message: "\u7ED1\u5B9A\u8D26\u53F7\u5DF2\u51BB\u7ED3\u6216\u4E0D\u5B58\u5728\uFF08fail-closed\uFF09" } });
            return;
          }
          const principal = deps.authn.ensureHumanPrincipal(user.id, user.displayName);
          const session = deps.authn.issueSessionPair(principal.id, { issuedBy: "dsh-bridge:cookie" });
          try {
            deps.iam.markLogin(user.id);
          } catch {
          }
          deps.audit?.record({
            type: "auth",
            actorType: "human",
            actorId: user.id,
            actorName: user.displayName,
            action: "dsh_bridge.cookie.session",
            resourceType: "dsh_bridge",
            resourceId: "rq_sid",
            resourceName: "\u5BBF\u4E3B\u4F1A\u8BDD",
            result: "ok",
            detail: "\u5BBF\u4E3B Cookie \u7ED1\u5B9A\u8EAB\u4EFD\u5151\u6362\u5E73\u53F0\u4F1A\u8BDD\uFF08\u514D\u767B\u76F4\u8FBE\u5143\u51B0\u53EF\u6570\u636E\u9762\uFF09"
          });
          json(200, {
            ok: true,
            data: {
              token: session.token,
              refreshToken: session.refreshToken,
              expiresAt: session.access.expiresAt,
              user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                orgId: user.orgId,
                roleIds: user.roleIds,
                roles: user.roleIds.map((roleId) => deps.iam?.roles().get(roleId)?.name).filter(Boolean),
                permissions: deps.iam.userPermissions(user.id)
              }
            }
          });
        })();
        return;
      }
      json(404, { ok: false, error: { code: "NOT_FOUND", message: `\u672A\u77E5\u7AEF\u70B9\uFF1A${req.method} /dsh-bridge/${endpoint}` } });
    }
  });
  const oidc = softRead(ctx, "oidc");
  const dataDirPath = ctx.opsStorage?.dataDirPath;
  const credFile = config.oidcCredentialFile ?? (dataDirPath ? join(dataDirPath, "dsh-agent-credential.json") : void 0);
  const pendingOidc = /* @__PURE__ */ new Map();
  const OIDC_PENDING_TTL = 10 * 6e4;
  if (oidc && credFile && existsSync(credFile)) {
    let oidcClient;
    try {
      const parsed = JSON.parse(readFileSync(credFile, "utf8"));
      if (parsed?.oidc?.clientId) oidcClient = { clientId: parsed.oidc.clientId, clientSecret: parsed.oidc.clientSecret };
    } catch {
    }
    if (oidcClient) {
      webServer.register({
        kind: "exact",
        path: "/auth/oidc/start",
        handler(req, res) {
          if (!sameOrigin(req)) {
            res.writeHead(403).end("forbidden");
            return;
          }
          const redirectUri = `${originOf(req)}/auth/oidc/callback`;
          const verifier = base64url(randomBytes(32));
          const state = base64url(randomBytes(16));
          const challenge = base64url(createHash("sha256").update(verifier).digest());
          pendingOidc.set(state, { verifier, redirectUri, issuedAt: Date.now() });
          for (const [key, value] of pendingOidc) {
            if (Date.now() - value.issuedAt > OIDC_PENDING_TTL) pendingOidc.delete(key);
          }
          const authorize = new URL(`${oidc.issuer()}/oauth/authorize`);
          authorize.searchParams.set("response_type", "code");
          authorize.searchParams.set("client_id", oidcClient.clientId);
          authorize.searchParams.set("redirect_uri", redirectUri);
          authorize.searchParams.set("scope", "openid profile");
          authorize.searchParams.set("state", state);
          authorize.searchParams.set("code_challenge", challenge);
          authorize.searchParams.set("code_challenge_method", "S256");
          res.writeHead(302, { location: authorize.toString() }).end();
        }
      });
      webServer.register({
        kind: "exact",
        path: "/auth/oidc/callback",
        handler(req, res) {
          void (async () => {
            const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
            const code = url.searchParams.get("code") ?? "";
            const state = url.searchParams.get("state") ?? "";
            const pending = pendingOidc.get(state);
            pendingOidc.delete(state);
            if (!code || !pending || Date.now() - pending.issuedAt > OIDC_PENDING_TTL) {
              res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("OIDC \u56DE\u8DF3\u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u767B\u5F55");
              return;
            }
            try {
              const tokenRes = await fetch(`${oidc.issuer()}/oauth/token`, {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  ...oidcClient.clientSecret ? { authorization: `Basic ${Buffer.from(`${oidcClient.clientId}:${oidcClient.clientSecret}`).toString("base64")}` } : {}
                },
                body: new URLSearchParams({
                  grant_type: "authorization_code",
                  code,
                  redirect_uri: pending.redirectUri,
                  code_verifier: pending.verifier
                }).toString()
              });
              const tokenPayload = await tokenRes.json().catch(() => null);
              const accessToken = tokenPayload?.access_token;
              if (!tokenRes.ok || !accessToken) throw new Error(tokenPayload?.error_description ?? `token \u7AEF\u70B9\u5931\u8D25\uFF08${tokenRes.status}\uFF09`);
              const userinfoRes = await fetch(`${oidc.issuer()}/oauth/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } });
              const userinfo = await userinfoRes.json().catch(() => null);
              if (!userinfoRes.ok || !userinfo?.sub) throw new Error("userinfo \u6362\u53D6\u5931\u8D25");
              const identity = {
                sub: String(userinfo.sub),
                name: typeof userinfo.name === "string" ? userinfo.name : void 0,
                roles: Array.isArray(userinfo.roles) ? userinfo.roles.map(String) : void 0,
                org: userinfo.org && typeof userinfo.org === "object" ? { id: String(userinfo.org.id ?? "") || void 0 } : void 0
              };
              const token = binding.bindIdentity(identity);
              res.writeHead(302, {
                "set-cookie": cookieAttrs(token, config.bindTtlSeconds ?? DEFAULT_TTL_SECONDS),
                location: "/"
              }).end();
            } catch (error) {
              res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(`OIDC \u767B\u5F55\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
            }
          })();
        }
      });
      ctx.logger("dsh-bridge").info("OIDC \u6388\u6743\u7801\u901A\u9053\u5DF2\u6302\u8F7D\uFF1A/auth/oidc/start \u2192 /auth/oidc/callback\uFF08PKCE S256\uFF09");
    } else {
      ctx.logger("dsh-bridge").info(`OIDC \u51ED\u8BC1\u6587\u4EF6\u65E0 oidc \u5B57\u6BB5\uFF0C\u6388\u6743\u7801\u901A\u9053\u672A\u542F\u7528\uFF1A${credFile}`);
    }
  } else {
    ctx.logger("dsh-bridge").info(`OIDC \u51ED\u8BC1\u6587\u4EF6\u4E0D\u5B58\u5728\uFF08${credFile ?? "\u672A\u914D\u7F6E"}\uFF09\uFF0C\u6388\u6743\u7801\u901A\u9053\u672A\u542F\u7528\u2014\u2014\u53EF\u5148\u8FD0\u884C register-dsh-agent.mjs`);
  }
  const tapIndex = webServer.tapIndex;
  if (typeof tapIndex === "function") {
    tapIndex.call(webServer, (html) => {
      const script = `<script>(function(){try{var m=(location.hash||'').match(/[#&]entry_ticket=([^&]+)/);if(!m)return;fetch('/dsh-bridge/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:decodeURIComponent(m[1])})}).then(function(r){return r.json()}).then(function(j){try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}if(j&&j.ok)location.reload();}).catch(function(){});}catch(e){}})();<\/script>`;
      const head = html.indexOf("<head>");
      if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`;
      return `${script}${html}`;
    });
    ctx.logger("dsh-bridge").info("\u514D\u767B\u5F15\u5BFC\u811A\u672C\u5DF2\u6CE8\u5165 dsh web UI\uFF08#entry_ticket fragment \u5151\u6362\uFF09");
  } else {
    ctx.logger("dsh-bridge").warn("webServer.tapIndex \u4E0D\u53EF\u7528\u2014\u2014#entry_ticket fragment \u901A\u9053\u964D\u7EA7\uFF0C\u4EC5 /auth/entry?entry_ticket= query \u901A\u9053\u53EF\u7528");
  }
}
export {
  IdentityBindingService,
  apply,
  inject,
  name
};
