import { createHash, generateKeyPairSync, randomUUID, sign as rsSign, verify as rsVerify, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { PlatformEvents, sha256Hex, newId, generateSecret } from "../../platform-core/dist/index.js";
import { t } from "../../platform-i18n/dist/index.js";
class OidcEndpointError extends Error {
  status;
  error;
  headers;
  constructor(status, error, description, headers = {}) {
    super(description);
    this.status = status;
    this.error = error;
    this.headers = headers;
  }
}
const KEY_GRACE_MS = 24 * 36e5;
const AUTHREQ_TTL_MS = (Number(process.env.OIDC_AUTHREQ_TTL_SECONDS ?? 300) || 300) * 1e3;
const CODE_TTL_MS = (Number(process.env.OIDC_CODE_TTL_SECONDS ?? 300) || 300) * 1e3;
const ACCESS_TTL_SECONDS = Number(process.env.OIDC_ACCESS_TTL_SECONDS ?? 7200) || 7200;
const REFRESH_TTL_SECONDS = Number(process.env.OIDC_REFRESH_TTL_SECONDS ?? 604800) || 604800;
class OidcService extends Service {
  static provide = "oidc";
  /** authn：复用登录限流；resourceCore：OIDC 客户端关联应用名回显（resource-core 先于本服务就绪，无环）。 */
  static inject = ["authn", "resourceCore"];
  keys;
  cleanupTimer;
  constructor(ctx) {
    super(ctx, "oidc");
    if (!process.env.OIDC_ISSUER) {
      ctx.logger("oidc").info(
        "\u672A\u914D\u7F6E OIDC_ISSUER\uFF1Aissuer \u6309\u8BF7\u6C42 Host/X-Forwarded-* \u5934\u6D3E\u751F\uFF08\u53CD\u4EE3/\u516C\u7F51\u57DF\u540D\u90E8\u7F72\u5F00\u7BB1\u53EF\u7528\uFF0C#15\uFF09\uFF1B\u591A\u57DF\u540D\u6216\u9700\u8981\u56FA\u5B9A issuer \u951A\u70B9\u7684\u90E8\u7F72\u8BF7\u663E\u5F0F\u58F0\u660E OIDC_ISSUER\uFF08\u89C1 docs/app-sso-integration.md\uFF09"
      );
    }
    this.keys = this.loadOrCreateKeys();
    this.registerRoutes();
    this.cleanupExpired();
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 24 * 36e5);
    this.cleanupTimer.unref?.();
    ctx.effect(() => () => {
      if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    });
    ctx.platformBus.on(PlatformEvents.AppOfflined, (payload) => {
      const { id } = payload;
      for (const client of this.clientsForApp(id)) this.disableClient(client.id, t("\u5E94\u7528\u4E0B\u7EBF\u8054\u52A8"));
    });
    ctx.platformBus.on(PlatformEvents.AppArchived, (payload) => {
      const { id } = payload;
      for (const client of this.clientsForApp(id)) this.disableClient(client.id, t("\u5E94\u7528\u5F52\u6863\u8054\u52A8"));
    });
    ctx.platformBus.on(PlatformEvents.AppOnlined, (payload) => {
      const { id } = payload;
      for (const client of this.clientsForApp(id)) this.enableClient(client.id);
    });
    ctx.platformBus.on(PlatformEvents.AppUpdated, (payload) => {
      const { id, name } = payload;
      for (const client of this.clientsForApp(id)) this.updateClient(client.id, { name });
    });
    ctx.platformBus.on(PlatformEvents.AgentOfflined, (payload) => {
      const { id } = payload;
      for (const client of this.clientsForAgent(id)) this.disableClient(client.id, t("Agent \u4E0B\u7EBF\u8054\u52A8"));
    });
    ctx.platformBus.on(PlatformEvents.AgentOnlined, (payload) => {
      const { id } = payload;
      for (const client of this.clientsForAgent(id)) this.enableClient(client.id);
    });
    ctx.platformBus.on(PlatformEvents.UserFrozen, (payload) => {
      const { userId, reason } = payload;
      this.revokeUserRefreshChains(userId, t("\u8D26\u53F7\u51BB\u7ED3\u8054\u52A8\uFF1A{reason}", { reason }));
    });
  }
  /**
   * 签发方 issuer（#15，2026-10-29）：解析优先级——
   *   1. OIDC_ISSUER 显式声明（多域名/严格部署的固定锚点，最高优先）；
   *   2. 按请求派生：x-forwarded-host/host + x-forwarded-proto（反代场景，与 console requestOrigin
   *      同口径）+ externalBase 前缀——公网域名部署时 discovery/签发/校验自动对齐，远程 SSO 开箱可用；
   *   3. 回落 http://127.0.0.1:<port><base>（本机调试）。
   * 不传请求上下文时保持旧行为（env ?? 环回）——非请求面调用（测试/内部校验）零感知。
   *
   * 安全审查 P1-06（2026-10-31）：请求派生受外部头（x-forwarded-host/host）影响，公网上可被
   * 伪造头改写 discovery 元数据。收敛规则：
   *   - OIDC_ISSUER 已设 → 永远返回固定值，不再按请求派生（固定发行方）；
   *   - 未设时仅当派生 host 命中 OIDC_TRUSTED_HOSTS 白名单（逗号分隔精确匹配）才采信，
   *     否则回落环回（fail-closed）——公网部署必须二选一显式配置。
   */
  issuer(origin) {
    if (process.env.OIDC_ISSUER) return process.env.OIDC_ISSUER;
    const derived = this.deriveIssuerFromRequest(origin);
    return derived ?? `http://127.0.0.1:${this.ctx.httpServer.port}${this.ctx.httpServer.externalBase}`;
  }
  /** 按请求头派生对外 issuer（host 缺失/不在可信白名单返回 undefined 走回落）。 */
  deriveIssuerFromRequest(origin) {
    if (!origin) return void 0;
    const header = (name) => {
      const value = origin.headers[name];
      return value === void 0 ? void 0 : String(Array.isArray(value) ? value[0] : value);
    };
    const host = header("x-forwarded-host") ?? header("host");
    if (!host) return void 0;
    const trusted = new Set(String(process.env.OIDC_TRUSTED_HOSTS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
    let hostname = "";
    try {
      hostname = new URL(`http://${host}`).hostname.toLowerCase();
    } catch {
      hostname = "";
    }
    const loopback = hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
    if (!loopback && !trusted.has(hostname)) return void 0;
    const proto = header("x-forwarded-proto") ?? "http";
    return `${proto}://${host}${this.webBase()}`;
  }
  /** JWT 校验可接受的 issuer 集合：OIDC_ISSUER 已设即仅固定值；未设时并入可信白名单派生值。 */
  acceptedIssuers(origin) {
    const staticIssuer = this.issuer();
    const derived = this.deriveIssuerFromRequest(origin);
    return derived !== void 0 && derived !== staticIssuer ? [staticIssuer, derived] : [staticIssuer];
  }
  /** 平台 SPA 内部页面的对外前缀（独立形态 ''，dsh 挂载形态 '/rq'）。 */
  webBase() {
    return this.ctx.httpServer?.externalBase ?? "";
  }
  clients() {
    const collection = this.ctx.opsStorage.collection("authn:oidcClients");
    collection.uniqueOn("oidc_client_id", (item) => item.clientId);
    return collection;
  }
  codes() {
    return this.ctx.opsStorage.collection("authn:oidcCodes");
  }
  authRequests() {
    return this.ctx.opsStorage.collection("authn:oidcAuthRequests");
  }
  refreshTokens() {
    return this.ctx.opsStorage.collection("authn:oidcRefreshTokens");
  }
  deniedJtis() {
    return this.ctx.opsStorage.collection("authn:oidcDeniedJtis");
  }
  clientByClientId(clientId) {
    return this.clients().findOne((item) => item.clientId === clientId);
  }
  clientsForAgent(agentId) {
    return this.clients().find((item) => item.refType === "agent" && item.refId === agentId);
  }
  clientsForApp(appId) {
    return this.clients().find((item) => item.refType === "app" && item.refId === appId);
  }
  static isClientActive(client) {
    return (client.status ?? "active") === "active";
  }
  // -- 客户端生命周期 -------------------------------------------------------
  /** 对外脱敏（QA SEC-02）：clientSecretHash 为凭证哈希，客户端列表/详情响应一律不外发（对齐 principals 的脱敏口径）；内部校验仍走 clients()/clientByClientId() 原始记录。 */
  publicClient(client) {
    const { clientSecretHash, ...safe } = client;
    void clientSecretHash;
    return safe;
  }
  createClient(input) {
    const clientType = input.clientType ?? "confidential";
    const clientId = "oc-" + newId("id").slice(3);
    const clientSecret = clientType === "public" ? "" : generateSecret("ocs");
    const client = this.clients().insert({
      id: newId("oc"),
      name: input.name,
      clientId,
      clientSecretHash: clientType === "public" ? "" : sha256Hex(clientSecret),
      redirectUris: input.redirectUris,
      ...input.description !== void 0 ? { description: input.description } : {},
      ...input.consentRequired !== void 0 ? { consentRequired: input.consentRequired } : {},
      ...input.postLogoutUris !== void 0 ? { postLogoutUris: input.postLogoutUris } : {},
      clientType,
      ...input.refType !== void 0 ? { refType: input.refType } : {},
      ...input.refId !== void 0 ? { refId: input.refId } : {}
    });
    return { client: this.publicClient(client), clientSecret };
  }
  listClients() {
    return this.clients().all().map((client) => this.publicClient({
      ...client,
      ...client.refType === "app" && client.refId ? { refAppName: this.ctx.resourceCore?.get("app", client.refId)?.name ?? client.refId } : {},
      ...client.refType === "agent" && client.refId ? { refAgentName: this.ctx.resourceCore?.get("agent", client.refId)?.name ?? client.refId } : {}
    }));
  }
  updateClient(id, patch) {
    return this.publicClient(this.clients().update(id, patch));
  }
  /** 轮换 secret：旧值立即失效，新值仅本次返回。 */
  rotateSecret(id) {
    const client = this.clients().get(id);
    if (!client) throw new Error(t("OIDC \u5BA2\u6237\u7AEF\u4E0D\u5B58\u5728\uFF1A{id}", { id }));
    if ((client.clientType ?? "confidential") === "public") throw new Error(t("public \u5BA2\u6237\u7AEF\u65E0 secret\uFF0C\u65E0\u9700\u8F6E\u6362"));
    const clientSecret = generateSecret("ocs");
    const updated = this.clients().update(id, { clientSecretHash: sha256Hex(clientSecret) });
    return { client: this.publicClient(updated), clientSecret };
  }
  disableClient(id, reason) {
    const client = this.clients().get(id);
    if (!client) throw new Error(t("OIDC \u5BA2\u6237\u7AEF\u4E0D\u5B58\u5728\uFF1A{id}", { id }));
    this.revokeClientRefreshChains(client.clientId, t("\u5BA2\u6237\u7AEF\u7981\u7528\u8054\u52A8\uFF1A{reason}", { reason }));
    return this.publicClient(this.clients().update(id, { status: "disabled" }));
  }
  enableClient(id) {
    return this.publicClient(this.clients().update(id, { status: "active" }));
  }
  // -- 浏览器授权流 ---------------------------------------------------------
  /** 允许对外签发的 scope 白名单（不得任意申请并原样进 JWT）。 */
  static ALLOWED_SCOPES = ["openid", "profile", "email"];
  /** 授权码格式校验（S256 应为 43-128 位 base64url）。 */
  static assertPkceChallenge(challenge) {
    if (challenge === void 0 || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      throw new OidcEndpointError(302, "invalid_request", t("\u7F3A\u5C11\u6216\u975E\u6CD5\u7684 code_challenge\uFF08\u672C Provider \u5F3A\u5236 PKCE S256\uFF0C43-128 \u4F4D base64url\uFF09"));
    }
  }
  /**
   * 发起授权（GET /oauth/authorize）：协议面校验 → 落授权请求 → 302 平台授权页。
   * 任一校验失败抛 OidcEndpointError（路由层统一 302 平台错误页，不携带外部 redirect_uri）。
   */
  beginAuthorization(input) {
    if (input.responseType !== "code") {
      throw new OidcEndpointError(302, "unsupported_response_type", t("response_type \u4EC5\u652F\u6301 code\uFF08\u6536\u5230\uFF1A{received}\uFF09", { received: input.responseType ?? t("\u7F3A\u5931") }));
    }
    if (!input.state) throw new OidcEndpointError(302, "invalid_request", t("state \u5FC5\u586B\uFF08CSRF \u9632\u62A4\uFF09"));
    const client = this.clientByClientId(String(input.clientId ?? ""));
    if (!client) throw new OidcEndpointError(302, "unauthorized_client", t("OIDC \u5BA2\u6237\u7AEF\u4E0D\u5B58\u5728\uFF1A{id}", { id: input.clientId ?? t("\u7F3A\u5931") }));
    if (!OidcService.isClientActive(client)) throw new OidcEndpointError(302, "unauthorized_client", t("OIDC \u5BA2\u6237\u7AEF\u5DF2\u7981\u7528\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458"));
    const redirectUri = input.redirectUri ?? client.redirectUris[0];
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      throw new OidcEndpointError(302, "invalid_request", t("redirect_uri \u672A\u767B\u8BB0\u5728\u5BA2\u6237\u7AEF\u767D\u540D\u5355"));
    }
    const scopes = (input.scope ?? "openid profile").split(/\s+/).filter(Boolean);
    const offender = scopes.find((scope) => !OidcService.ALLOWED_SCOPES.includes(scope));
    if (offender) throw new OidcEndpointError(302, "invalid_scope", t("scope \u672A\u83B7\u6388\u6743\uFF1A{scope}\uFF08\u5141\u8BB8\uFF1A{allowed}\uFF09", { scope: offender, allowed: OidcService.ALLOWED_SCOPES.join(" ") }));
    if (input.codeChallengeMethod !== void 0 && input.codeChallengeMethod !== "S256") {
      throw new OidcEndpointError(302, "invalid_request", t("code_challenge_method \u4EC5\u652F\u6301 S256"));
    }
    OidcService.assertPkceChallenge(input.codeChallenge);
    return this.authRequests().insert({
      id: randomUUID(),
      clientId: client.clientId,
      redirectUri,
      state: input.state,
      scope: scopes.join(" "),
      ...input.nonce !== void 0 ? { nonce: input.nonce } : {},
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: "S256",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      expiresAt: new Date(Date.now() + AUTHREQ_TTL_MS).toISOString()
    });
  }
  /** 授权页公开查询（不泄露 redirect_uri / secret 等内部字段）。 */
  authRequestInfo(reqId) {
    const req = this.authRequests().get(reqId);
    if (!req || req.consumedAt || new Date(req.expiresAt).getTime() < Date.now()) {
      throw new Error(t("\u6388\u6743\u8BF7\u6C42\u65E0\u6548\u3001\u5DF2\u4F7F\u7528\u6216\u5DF2\u8FC7\u671F"));
    }
    const client = this.clientByClientId(req.clientId);
    if (!client || !OidcService.isClientActive(client)) throw new Error(t("OIDC \u5BA2\u6237\u7AEF\u4E0D\u53EF\u7528"));
    const appRef = client.refType === "app" && client.refId ? (() => {
      const app = this.ctx.resourceCore?.get("app", client.refId);
      return app ? { id: app.id, name: app.name } : void 0;
    })() : void 0;
    return {
      clientName: client.name,
      ...appRef !== void 0 ? { appRef } : {},
      scope: req.scope,
      consentRequired: client.consentRequired === true
    };
  }
  /**
   * 授权页确认（POST /api/authn/oidc/authorize，human-only）：
   * 校验授权请求 →（需要同意时必须显式 consent）→ 签发一次性 code → 返回回跳地址。
   * consent 显式为 false → access_denied 回跳 + denied 事件；缺省 → 400（未表达同意）。
   */
  completeAuthorization(input, origin) {
    const req = this.authRequests().get(input.reqId);
    if (!req) throw new Error(t("\u6388\u6743\u8BF7\u6C42\u65E0\u6548\uFF08reqId \u9519\u8BEF\u6216\u5DF2\u88AB\u6E05\u7406\uFF09"));
    if (req.consumedAt) throw new Error(t("\u6388\u6743\u8BF7\u6C42\u5DF2\u88AB\u4F7F\u7528\uFF08\u5355\u6B21\u6D88\u8D39\uFF0C\u9632\u91CD\u653E\uFF09"));
    if (new Date(req.expiresAt).getTime() < Date.now()) throw new Error(t("\u6388\u6743\u8BF7\u6C42\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u4ECE\u5E94\u7528\u91CD\u65B0\u53D1\u8D77"));
    const client = this.clientByClientId(req.clientId);
    if (!client) throw new Error(t("\u6388\u6743\u8BF7\u6C42\u6307\u5411\u7684\u5BA2\u6237\u7AEF\u4E0D\u5B58\u5728"));
    if (!OidcService.isClientActive(client)) throw new Error(t("OIDC \u5BA2\u6237\u7AEF\u5DF2\u7981\u7528\uFF0C\u65E0\u6CD5\u5B8C\u6210\u6388\u6743"));
    const user = this.ctx.iam.users().get(input.userId);
    if (!user) throw new Error(t("\u7528\u6237\u4E0D\u5B58\u5728"));
    if (user.status !== "active") throw new Error(t("\u8D26\u53F7\u72B6\u6001\u5F02\u5E38\uFF0C\u65E0\u6CD5\u6388\u6743"));
    if (client.consentRequired === true && input.consent !== true) {
      if (input.consent === void 0) throw new Error(t("\u8BE5\u5E94\u7528\u8981\u6C42\u663E\u5F0F\u540C\u610F\u540E\u624D\u80FD\u6388\u6743"));
      this.authRequests().update(req.id, { consumedAt: (/* @__PURE__ */ new Date()).toISOString() });
      this.ctx.platformBus.emit(PlatformEvents.OidcAuthorizeDenied, {
        reqId: req.id,
        clientId: client.clientId,
        clientName: client.name,
        userId: user.id,
        userName: user.displayName
      });
      return { location: withQuery(req.redirectUri, { error: "access_denied", error_description: t("\u7528\u6237\u62D2\u7EDD\u6388\u6743"), state: req.state }) };
    }
    const code = this.issueCode({ ...req, userId: user.id });
    this.authRequests().update(req.id, { consumedAt: (/* @__PURE__ */ new Date()).toISOString() });
    this.ctx.platformBus.emit(PlatformEvents.OidcAuthorizeGranted, {
      reqId: req.id,
      clientId: client.clientId,
      clientName: client.name,
      userId: user.id,
      userName: user.displayName,
      scope: req.scope
    });
    return { location: withQuery(req.redirectUri, { code, state: req.state, iss: this.issuer(origin) }) };
  }
  issueCode(req) {
    const code = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    this.codes().insert({
      id: code,
      clientId: req.clientId,
      userId: req.userId,
      redirectUri: req.redirectUri,
      state: req.state,
      ...req.nonce !== void 0 ? { nonce: req.nonce } : {},
      scope: req.scope,
      codeChallenge: req.codeChallenge,
      codeChallengeMethod: "S256",
      expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString()
    });
    return code;
  }
  // -- 换牌 / 刷新 -----------------------------------------------------------
  /** 客户端认证：Basic 与 Post 双形态；public 客户端免 secret。失败计入暴力破解锁定。 */
  authenticateClient(clientId, clientSecret) {
    const invalidClient = (description) => new OidcEndpointError(401, "invalid_client", description, { "www-authenticate": 'Basic realm="dsh-ops-oidc"' });
    if (!clientId) throw invalidClient(t("\u7F3A\u5C11 client_id"));
    const client = this.clientByClientId(clientId);
    if (!client) throw invalidClient(t("client_id \u4E0D\u5B58\u5728\uFF1A{clientId}", { clientId }));
    if (!OidcService.isClientActive(client)) throw invalidClient(t("OIDC \u5BA2\u6237\u7AEF\u5DF2\u7981\u7528"));
    if ((client.clientType ?? "confidential") === "confidential") {
      if (!clientSecret) throw invalidClient(t("\u7F3A\u5C11 client_secret"));
      if (client.clientSecretHash !== sha256Hex(clientSecret)) {
        this.ctx.authn.recordLoginFailure(`oidc-token:${clientId}`);
        throw invalidClient(t("client_secret \u9519\u8BEF"));
      }
    }
    this.ctx.authn.recordLoginSuccess(`oidc-token:${clientId}`);
    return client;
  }
  /**
   * /oauth/token：authorization_code（PKCE 强制校验、code 单次消费）与 refresh_token（轮转 + 重放整链吊销）。
   */
  token(input, origin) {
    const client = this.authenticateClient(input.clientId, input.clientSecret);
    if (input.grantType === "authorization_code") return this.authorizationCodeGrant(client, input, origin);
    if (input.grantType === "refresh_token") return this.refreshGrant(client, input, origin);
    throw new OidcEndpointError(400, "unsupported_grant_type", t("\u4E0D\u652F\u6301\u7684 grant_type\uFF1A{grantType}", { grantType: input.grantType }));
  }
  authorizationCodeGrant(client, input, origin) {
    const bad = (description) => new OidcEndpointError(400, "invalid_grant", description);
    if (!input.code) throw new OidcEndpointError(400, "invalid_request", t("code \u5FC5\u586B"));
    const record = this.codes().get(input.code);
    if (!record) throw bad(t("\u6388\u6743\u7801\u65E0\u6548"));
    if (record.usedAt) throw bad(t("\u6388\u6743\u7801\u5DF2\u88AB\u4F7F\u7528\uFF08\u5355\u6B21\u6D88\u8D39\uFF0C\u9632\u91CD\u653E\uFF09"));
    if (new Date(record.expiresAt).getTime() < Date.now()) throw bad(t("\u6388\u6743\u7801\u5DF2\u8FC7\u671F"));
    if (record.clientId !== client.clientId) throw bad(t("\u6388\u6743\u7801\u4E0E\u5BA2\u6237\u7AEF\u4E0D\u5339\u914D"));
    if (input.redirectUri && input.redirectUri !== record.redirectUri) throw bad(t("redirect_uri \u4E0E\u6388\u6743\u65F6\u4E0D\u4E00\u81F4"));
    if (!record.codeChallenge) throw bad(t("\u6388\u6743\u672A\u767B\u8BB0 PKCE challenge"));
    if (!input.codeVerifier) throw bad(t("\u6388\u6743\u4F7F\u7528\u4E86 PKCE\uFF0Ctoken \u8BF7\u6C42\u5FC5\u987B\u643A\u5E26 code_verifier"));
    const derived = createHash("sha256").update(input.codeVerifier).digest("base64url");
    if (derived !== record.codeChallenge) throw bad(t("PKCE \u6821\u9A8C\u5931\u8D25\uFF1Acode_verifier \u4E0D\u5339\u914D"));
    this.codes().update(record.id, { usedAt: (/* @__PURE__ */ new Date()).toISOString() });
    const user = this.ctx.iam.users().get(record.userId);
    if (!user || user.status !== "active") throw bad(t("\u7528\u6237\u72B6\u6001\u5F02\u5E38\uFF0C\u65E0\u6CD5\u7B7E\u53D1\u4EE4\u724C"));
    return this.issueTokenSet(client, { userId: record.userId, scope: record.scope, ...record.nonce !== void 0 ? { nonce: record.nonce } : {} }, origin);
  }
  refreshGrant(client, input, origin) {
    const bad = (description) => new OidcEndpointError(400, "invalid_grant", description);
    if (!input.refreshToken) throw new OidcEndpointError(400, "invalid_request", t("refresh_token \u5FC5\u586B"));
    if ((client.clientType ?? "confidential") === "public") throw bad(t("public \u5BA2\u6237\u7AEF\u4E0D\u7B7E\u53D1 refresh token"));
    const hash = sha256Hex(input.refreshToken);
    const record = this.refreshTokens().findOne((item) => item.tokenHash === hash);
    if (!record || record.clientId !== client.clientId) throw bad(t("refresh token \u65E0\u6548"));
    if (record.revokedAt) throw bad(t("refresh token \u5DF2\u540A\u9500\uFF1A{reason}", { reason: record.revokedReason ?? "" }));
    if (new Date(record.expiresAt).getTime() < Date.now()) throw bad(t("refresh token \u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u6388\u6743"));
    if (record.rotatedAt) {
      this.revokeRefreshChain(record.chainId, t("refresh token \u91CD\u653E\u68C0\u6D4B\uFF08\u539F\u8F6E\u8F6C\u4E8E {at}\uFF09", { at: record.rotatedAt }));
      throw bad(t("\u68C0\u6D4B\u5230 refresh token \u91CD\u653E\uFF1A\u8BE5\u6388\u6743\u94FE\u5DF2\u6574\u4F53\u540A\u9500\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u6388\u6743"));
    }
    const user = this.ctx.iam.users().get(record.userId);
    if (!user || user.status !== "active") throw bad(t("\u7528\u6237\u72B6\u6001\u5F02\u5E38\uFF08\u51BB\u7ED3/\u79BB\u804C\u8054\u52A8\u5931\u6548\uFF09"));
    const granted = record.scope.split(/\s+/).filter(Boolean);
    const requested = input.scope !== void 0 ? input.scope.split(/\s+/).filter(Boolean) : granted;
    const widened = requested.find((scope2) => !granted.includes(scope2));
    if (widened) throw new OidcEndpointError(400, "invalid_scope", t("refresh \u53EA\u5141\u8BB8\u6536\u7A84 scope\uFF1A{scopes} \u672A\u5728\u539F\u6388\u6743\u8303\u56F4\u5185", { scopes: widened }));
    const scope = requested.join(" ");
    this.refreshTokens().update(record.id, { rotatedAt: (/* @__PURE__ */ new Date()).toISOString() });
    const tokenSet = this.issueTokenSet(client, { userId: record.userId, scope, chainId: record.chainId }, origin);
    return tokenSet;
  }
  issueTokenSet(client, granted, origin) {
    const nowSec = Math.floor(Date.now() / 1e3);
    const user = this.ctx.iam.users().get(granted.userId);
    const payload = {
      // #15：iss 按请求面派生（env 显式声明优先），与 discovery 对齐
      iss: this.issuer(origin),
      sub: granted.userId,
      aud: client.clientId,
      azp: client.clientId,
      iat: nowSec,
      exp: nowSec + ACCESS_TTL_SECONDS,
      jti: randomUUID(),
      scope: granted.scope,
      ...granted.nonce !== void 0 ? { nonce: granted.nonce } : {},
      ...user !== void 0 ? { preferred_username: user.username, name: user.displayName } : {}
    };
    const access = this.signJwt({ ...payload, token_use: "access" });
    const idToken = this.signJwt({ ...payload, token_use: "id" });
    const result = {
      access_token: access,
      id_token: idToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      scope: granted.scope
    };
    if ((client.clientType ?? "confidential") === "confidential") {
      const refreshRaw = "otr_" + randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      this.refreshTokens().insert({
        id: newId("ort"),
        clientId: client.clientId,
        userId: granted.userId,
        scope: granted.scope,
        tokenHash: sha256Hex(refreshRaw),
        chainId: granted.chainId ?? newId("rchain"),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1e3).toISOString()
      });
      result.refresh_token = refreshRaw;
    }
    return result;
  }
  // -- 吊销面 ---------------------------------------------------------------
  revokeRefreshChain(chainId, reason) {
    let count = 0;
    for (const record of this.refreshTokens().find((item) => item.chainId === chainId && !item.revokedAt)) {
      this.refreshTokens().update(record.id, { revokedAt: (/* @__PURE__ */ new Date()).toISOString(), revokedReason: reason });
      count++;
    }
    return count;
  }
  revokeUserRefreshChains(userId, reason) {
    let count = 0;
    for (const record of this.refreshTokens().find((item) => item.userId === userId && !item.revokedAt)) {
      this.refreshTokens().update(record.id, { revokedAt: (/* @__PURE__ */ new Date()).toISOString(), revokedReason: reason });
      count++;
    }
    return count;
  }
  revokeClientRefreshChains(clientId, reason) {
    let count = 0;
    for (const record of this.refreshTokens().find((item) => item.clientId === clientId && !item.revokedAt)) {
      this.refreshTokens().update(record.id, { revokedAt: (/* @__PURE__ */ new Date()).toISOString(), revokedReason: reason });
      count++;
    }
    return count;
  }
  /** RFC 7009 /oauth/revoke：access（jti 黑名单）或 refresh（整链）；恒 200。 */
  revokeToken(input, origin) {
    const client = this.authenticateClient(input.clientId, input.clientSecret);
    if (!input.token) return;
    if (input.token.startsWith("otr_") || input.tokenTypeHint === "refresh_token") {
      const hash = sha256Hex(input.token);
      const record = this.refreshTokens().findOne((item) => item.tokenHash === hash);
      if (record && record.clientId === client.clientId) this.revokeRefreshChain(record.chainId, t("\u5BA2\u6237\u7AEF\u4E3B\u52A8\u540A\u9500\uFF08RFC 7009\uFF09"));
      return;
    }
    try {
      const claims = this.verifyJwt(input.token, { audience: void 0, ...origin !== void 0 ? { origin } : {} });
      if (claims.aud !== client.clientId) return;
      this.deniedJtis().insert({
        id: newId("odj"),
        jti: String(claims.jti ?? ""),
        expiresAt: new Date((typeof claims.exp === "number" ? claims.exp : Math.floor(Date.now() / 1e3)) * 1e3).toISOString(),
        reason: t("\u5BA2\u6237\u7AEF\u4E3B\u52A8\u540A\u9500\uFF08RFC 7009\uFF09")
      });
    } catch {
    }
  }
  isJtiDenied(jti) {
    if (typeof jti !== "string" || !jti) return false;
    const record = this.deniedJtis().findOne((item) => item.jti === jti);
    return record !== void 0 && new Date(record.expiresAt).getTime() > Date.now();
  }
  // -- RP 发起登出 -----------------------------------------------------------
  /**
   * GET /oauth/end_session：验签 id_token_hint 定位 client → 吊销该用户在该 client 下的
   * refresh 链 → 回跳地址命中 postLogoutUris → 302 平台登出页（页面清会话后带 state 跳回）。
   * 未携带 post_logout_redirect_uri 时（轻量 RP 只传 id_token_hint），若该 client 仅登记了
   * 一个登出回跳地址，按其登记意图回跳——仍受白名单约束，显式传参非法依旧拒绝（防开放重定向）。
   */
  endSession(input, origin) {
    if (!input.idTokenHint) throw new OidcEndpointError(302, "invalid_request", t("\u7F3A\u5C11 id_token_hint"));
    let claims;
    try {
      claims = this.verifyJwt(input.idTokenHint, { audience: void 0, ...origin !== void 0 ? { origin } : {} });
    } catch (error) {
      throw new OidcEndpointError(302, "invalid_request", t("id_token_hint \u9A8C\u7B7E\u5931\u8D25\uFF1A{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
    const client = this.clientByClientId(String(claims.aud ?? ""));
    if (!client) throw new OidcEndpointError(302, "invalid_request", t("id_token_hint \u53D7\u4F17\uFF08aud\uFF09\u672A\u547D\u4E2D\u5DF2\u767B\u8BB0\u5BA2\u6237\u7AEF"));
    const userId = String(claims.sub ?? "");
    for (const record of this.refreshTokens().find((item) => item.clientId === client.clientId && item.userId === userId && !item.revokedAt)) {
      this.refreshTokens().update(record.id, { revokedAt: (/* @__PURE__ */ new Date()).toISOString(), revokedReason: t("RP \u53D1\u8D77\u767B\u51FA\u8054\u52A8") });
    }
    const logoutParams = new URLSearchParams({
      ...input.postLogoutRedirectUri !== void 0 ? { post_logout_redirect_uri: input.postLogoutRedirectUri } : {},
      ...input.state !== void 0 ? { state: input.state } : {},
      client: client.name
    });
    const logoutPage = `${this.webBase()}/#/oauth/logout?${logoutParams.toString()}`;
    const whitelist = client.postLogoutUris ?? [];
    if (input.postLogoutRedirectUri === void 0) {
      if (whitelist.length === 1) {
        logoutParams.set("post_logout_redirect_uri", whitelist[0]);
        return { location: `${this.webBase()}/#/oauth/logout?${logoutParams.toString()}` };
      }
      return { location: logoutPage };
    }
    if (!whitelist.includes(input.postLogoutRedirectUri)) {
      throw new OidcEndpointError(302, "invalid_request", t("post_logout_redirect_uri \u672A\u767B\u8BB0\u5728\u5BA2\u6237\u7AEF\u767B\u51FA\u767D\u540D\u5355"));
    }
    return { location: logoutPage };
  }
  // -- userinfo ---------------------------------------------------------------
  /** userinfo：仅接受 access token（token_use 校验）+ aud 必须命中有效 client + 用户实时状态；origin 提供时 iss 同步接受请求面派生值（#15）。 */
  userinfo(accessToken, origin) {
    const claims = this.verifyJwt(accessToken, { audience: void 0, ...origin !== void 0 ? { origin } : {} });
    if (claims.token_use !== "access") throw new Error(t("\u8BE5\u7AEF\u70B9\u4EC5\u63A5\u53D7 access token\uFF08id_token \u4E0D\u80FD\u76F4\u63A5\u8C03 userinfo\uFF09"));
    const client = this.clientByClientId(String(claims.aud ?? ""));
    if (!client || !OidcService.isClientActive(client)) throw new Error(t("token \u53D7\u4F17\uFF08aud\uFF09\u4E0D\u662F\u6709\u6548\u5BA2\u6237\u7AEF"));
    if (this.isJtiDenied(claims.jti)) throw new Error(t("token \u5DF2\u88AB\u540A\u9500\uFF08RFC 7009\uFF09"));
    const user = this.ctx.iam.users().get(claims.sub ?? "");
    if (!user) throw new Error(t("\u7528\u6237\u4E0D\u5B58\u5728"));
    if (user.status !== "active") throw new Error(t("\u7528\u6237\u72B6\u6001\u5F02\u5E38\uFF08\u51BB\u7ED3/\u79BB\u804C\u8054\u52A8\u5931\u6548\uFF09"));
    const org = this.ctx.iam.orgs().get(user.orgId);
    const scopes = String(claims.scope ?? "").split(/\s+/);
    return {
      sub: user.id,
      preferred_username: user.username,
      name: user.displayName,
      // email claim 按 scope 裁剪（未申请 email scope 不外发）
      ...scopes.includes("email") && user.email ? { email: user.email } : {},
      org: org !== void 0 ? { id: org.id, name: org.name, tenantId: org.tenantId ?? "t_default" } : null,
      roles: user.roleIds.map((roleId) => this.ctx.iam.roles().get(roleId)?.code).filter(Boolean),
      tenant: org?.tenantId ?? "t_default",
      scope: claims.scope
    };
  }
  // -- JWT（RS256，数组化 JWKS） ----------------------------------------------
  signJwt(payload) {
    const key = this.activeKey();
    const header = { alg: "RS256", typ: "JWT", kid: key.kid };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const head = Buffer.from(JSON.stringify(header)).toString("base64url");
    const signature = rsSign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privatePem).toString("base64url");
    return `${head}.${body}.${signature}`;
  }
  /** 签名恒用最新 key；验签按 header.kid 在数组（含宽限期内的退役 key）中匹配。 */
  activeKey() {
    const alive = this.keys.filter((key) => key.retiredAt === void 0 || Date.now() - new Date(key.retiredAt).getTime() < KEY_GRACE_MS);
    const candidates = alive.filter((key) => key.retiredAt === void 0);
    return candidates[0] ?? alive[0];
  }
  /**
   * JWT 校验：签名 + header.kid 匹配 JWKS 公布密钥 + iss 归属本 Provider + exp 有效；
   * options.audience 指定时校验受众（azp/aud 必须命中）；
   * options.origin 指定时 iss 同时接受请求面派生值（#15：公网域名签发的令牌在同域名校验通过）。
   */
  verifyJwt(token, options = {}) {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error(t("JWT \u683C\u5F0F\u4E0D\u5408\u6CD5"));
    let header;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      throw new Error(t("JWT \u5934\u90E8\u89E3\u6790\u5931\u8D25"));
    }
    const key = this.keys.find((item) => item.kid === header.kid);
    if (!key) throw new Error(t("JWT kid \u4E0E JWKS \u516C\u5E03\u5BC6\u94A5\u4E0D\u5339\u914D"));
    if (key.retiredAt !== void 0 && Date.now() - new Date(key.retiredAt).getTime() >= KEY_GRACE_MS) {
      throw new Error(t("JWT \u7B7E\u540D\u5BC6\u94A5\u5DF2\u8FC7\u5BBD\u9650\u671F"));
    }
    const valid = rsVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key.publicPem, Buffer.from(parts[2], "base64url"));
    if (!valid) throw new Error(t("JWT \u7B7E\u540D\u6821\u9A8C\u5931\u8D25\uFF08RS256\uFF09"));
    let claims;
    try {
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      throw new Error(t("JWT \u8F7D\u8377\u89E3\u6790\u5931\u8D25"));
    }
    if (!this.acceptedIssuers(options.origin).includes(String(claims.iss ?? ""))) throw new Error(t("JWT \u7B7E\u53D1\u65B9\uFF08iss\uFF09\u6821\u9A8C\u5931\u8D25"));
    if (typeof claims.exp === "number" && claims.exp * 1e3 < Date.now()) throw new Error(t("JWT \u5DF2\u8FC7\u671F"));
    if (options.audience !== void 0) {
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(options.audience)) throw new Error(t("JWT \u53D7\u4F17\uFF08aud\uFF09\u6821\u9A8C\u5931\u8D25\uFF1A\u671F\u671B {expected}", { expected: options.audience }));
    }
    return claims;
  }
  jwks() {
    const published = this.keys.filter((key) => key.retiredAt === void 0 || Date.now() - new Date(key.retiredAt).getTime() < KEY_GRACE_MS);
    return { keys: published.map((key) => {
      const jwk = createPublicKey(key.publicPem).export({ format: "jwk" });
      return {
        kty: jwk.kty,
        use: "sig",
        alg: "RS256",
        kid: key.kid,
        n: jwk.n,
        e: jwk.e
      };
    }) };
  }
  /** 管理端密钥轮换：新 key 立即承担签名，旧 key 进入 24h 验签宽限。 */
  rotateKeys() {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.keys = this.keys.map((key) => key.retiredAt === void 0 ? { ...key, retiredAt: now } : key);
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const material = {
      privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      publicPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      kid: createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex").slice(0, 16),
      createdAt: now
    };
    this.keys = [material, ...this.keys];
    this.saveKeys();
    return { graceHours: KEY_GRACE_MS / 36e5, kid: material.kid };
  }
  discovery(origin) {
    const issuer = this.issuer(origin);
    return {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      userinfo_endpoint: `${issuer}/oauth/userinfo`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      end_session_endpoint: `${issuer}/oauth/end_session`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: [...OidcService.ALLOWED_SCOPES],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      claims_supported: ["sub", "name", "preferred_username", "iss", "aud", "exp", "iat", "jti", "nonce", "email"]
    };
  }
  /** 过期记录清理（对齐 M2 惯例：过期 7 天后物理删除，不无限累积）。 */
  cleanupExpired() {
    const cutoff = Date.now() - 7 * 24 * 36e5;
    let removed = 0;
    for (const record of this.authRequests().all()) {
      if (new Date(record.expiresAt).getTime() < cutoff && this.authRequests().remove(record.id)) removed++;
    }
    for (const record of this.codes().all()) {
      if (new Date(record.expiresAt).getTime() < cutoff && this.codes().remove(record.id)) removed++;
    }
    for (const record of this.refreshTokens().all()) {
      if (new Date(record.expiresAt).getTime() < cutoff && this.refreshTokens().remove(record.id)) removed++;
    }
    for (const record of this.deniedJtis().all()) {
      if (new Date(record.expiresAt).getTime() < cutoff && this.deniedJtis().remove(record.id)) removed++;
    }
    const before = this.keys.length;
    this.keys = this.keys.filter((key) => key.retiredAt === void 0 || Date.now() - new Date(key.retiredAt).getTime() < KEY_GRACE_MS);
    if (this.keys.length !== before) this.saveKeys();
    return removed;
  }
  loadOrCreateKeys() {
    const file = join(this.ctx.opsStorage.dataDirPath, "oidc-keys.json");
    const fresh = () => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      return {
        privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        publicPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
        kid: createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex").slice(0, 16),
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    };
    try {
      if (existsSync(file)) {
        const stored = JSON.parse(readFileSync(file, "utf8"));
        const list = Array.isArray(stored.keys) ? stored.keys : [stored];
        const valid = list.filter((item) => item && item.privatePem && item.publicPem && item.kid);
        if (valid.length > 0) return valid;
      }
      mkdirSync(this.ctx.opsStorage.dataDirPath, { recursive: true });
      const material = fresh();
      writeFileSync(file, JSON.stringify({ keys: [material] }, null, 2), { encoding: "utf8", mode: 384 });
      return [material];
    } catch {
      return [fresh()];
    }
  }
  saveKeys() {
    try {
      const file = join(this.ctx.opsStorage.dataDirPath, "oidc-keys.json");
      writeFileSync(file, JSON.stringify({ keys: this.keys }, null, 2), { encoding: "utf8", mode: 384 });
    } catch (error) {
      console.error("[oidc] \u5BC6\u94A5\u6587\u4EF6\u843D\u76D8\u5931\u8D25\uFF08\u4EC5\u5F71\u54CD\u8F6E\u6362\u6301\u4E45\u5316\uFF09", error);
    }
  }
  // -- 协议端点 ---------------------------------------------------------------
  /**
   * CORS 允许来源：已登记客户端 redirect_uri 的 origin ∪ OIDC_CORS_ORIGINS（逗号分隔显式清单）。
   * 收敛在已登记来源内——未登记站点的页面拿不到放行头；code 本身绑定 redirect_uri，双重兜底。
   */
  allowedCorsOrigins() {
    const origins = new Set(
      String(process.env.OIDC_CORS_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean)
    );
    for (const client of this.clients().all()) {
      for (const uri of client.redirectUris ?? []) {
        try {
          origins.add(new URL(uri).origin);
        } catch {
        }
      }
    }
    return origins;
  }
  /** 按 Origin 头生成放行头；无 Origin（非浏览器调用）不发放，未登记来源仅回 vary。 */
  corsHeaders(exchange) {
    const header = exchange.headers["origin"];
    const origin = Array.isArray(header) ? header[0] : header;
    if (!origin) return {};
    if (!this.allowedCorsOrigins().has(origin)) return { vary: "Origin" };
    return { vary: "Origin", "access-control-allow-origin": origin };
  }
  /** 公开端点（非 /api/*：不受控制台 Bearer 中间件约束，属 OIDC 协议要求）。 */
  registerRoutes() {
    const http = this.ctx.httpServer;
    const raw = (exchange, status, payload, extra = {}) => {
      exchange.res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...this.corsHeaders(exchange), ...extra });
      exchange.res.end(JSON.stringify(payload));
    };
    const redirect = (exchange, location) => {
      exchange.res.writeHead(302, { location });
      exchange.res.end();
    };
    const clientIp = (exchange) => String(exchange.raw.socket?.remoteAddress ?? "unknown");
    const preflight = (exchange) => {
      exchange.res.writeHead(204, {
        ...this.corsHeaders(exchange),
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "600"
      });
      exchange.res.end();
    };
    for (const pattern of ["/oauth/token", "/oauth/userinfo", "/oauth/revoke", "/.well-known/openid-configuration", "/.well-known/jwks.json"]) {
      http.register("OPTIONS", pattern, preflight);
    }
    http.register("GET", "/.well-known/openid-configuration", (exchange) => {
      raw(exchange, 200, this.discovery(exchange));
    });
    http.register("GET", "/.well-known/jwks.json", (exchange) => {
      raw(exchange, 200, this.jwks());
    });
    http.register("GET", "/oauth/authorize", (exchange) => {
      const q = exchange.query;
      const throttleKey = `oidc-authorize-ip:${clientIp(exchange)}`;
      try {
        this.ctx.authn.assertNotLocked(throttleKey);
        const req = this.beginAuthorization({
          responseType: q.get("response_type") ?? void 0,
          clientId: q.get("client_id") ?? void 0,
          redirectUri: q.get("redirect_uri") ?? void 0,
          state: q.get("state") ?? void 0,
          scope: q.get("scope") ?? void 0,
          nonce: q.get("nonce") ?? void 0,
          codeChallenge: q.get("code_challenge") ?? void 0,
          codeChallengeMethod: q.get("code_challenge_method") ?? void 0
        });
        redirect(exchange, `${this.webBase()}/#/oauth/authorize?req=${encodeURIComponent(req.id)}`);
      } catch (error) {
        const err = error instanceof OidcEndpointError ? error : new OidcEndpointError(302, "access_denied", error instanceof Error ? error.message : String(error));
        if (err.error === "unauthorized_client" || err.message.includes("redirect_uri")) {
          try {
            this.ctx.authn.recordLoginFailure(throttleKey);
          } catch {
          }
        }
        redirect(exchange, `${this.webBase()}/#/oauth/error?error=${encodeURIComponent(err.error)}&error_description=${encodeURIComponent(err.message)}`);
      }
    });
    http.register("GET", "/api/authn/oidc/auth-requests/:id", (exchange) => {
      try {
        raw(exchange, 200, this.authRequestInfo(exchange.params["id"]));
      } catch (error) {
        raw(exchange, 404, { error: "invalid_request", error_description: error instanceof Error ? error.message : String(error) });
      }
    }, { access: "public", selfValidated: true });
    http.register("POST", "/api/authn/oidc/authorize", async (exchange) => {
      const input = exchange.body ?? {};
      const info = exchange.principal;
      if (!info) {
        raw(exchange, 401, { error: "invalid_request", error_description: t("\u7F3A\u5C11 Bearer \u4F1A\u8BDD\uFF0C\u8BF7\u5148\u767B\u5F55\u5E73\u53F0") });
        return;
      }
      if (info.kind !== "human" || !info.userId) {
        raw(exchange, 403, { error: "invalid_request", error_description: t("\u6388\u6743\u786E\u8BA4\u4EC5\u9650\u767B\u5F55\u7528\u6237\uFF08human\uFF09\uFF0C\u673A\u5668\u8EAB\u4EFD\u4E0D\u53EF\u4EE3\u66FF\u7528\u6237\u6388\u6743") });
        return;
      }
      if (!input.reqId) {
        raw(exchange, 400, { error: "invalid_request", error_description: t("reqId \u5FC5\u586B") });
        return;
      }
      try {
        const result = this.completeAuthorization({ reqId: input.reqId, userId: info.userId, ...input.consent !== void 0 ? { consent: input.consent } : {} }, exchange);
        raw(exchange, 200, result);
      } catch (error) {
        raw(exchange, 400, { error: "consent_required", error_description: error instanceof Error ? error.message : String(error) });
      }
    }, { access: "authenticated" });
    http.register("POST", "/oauth/token", async (exchange) => {
      const bodyInput = exchange.body ?? {};
      const authHeader = String(exchange.headers["authorization"] ?? "");
      let basicId;
      let basicSecret;
      if (authHeader.startsWith("Basic ")) {
        try {
          const decoded = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf8");
          const idx = decoded.indexOf(":");
          basicId = decodeURIComponent(decoded.slice(0, idx));
          basicSecret = decodeURIComponent(decoded.slice(idx + 1));
        } catch {
        }
      }
      try {
        const result = this.token({
          grantType: bodyInput["grant_type"] ?? "authorization_code",
          clientId: basicId ?? bodyInput["client_id"],
          clientSecret: basicSecret ?? bodyInput["client_secret"],
          ...bodyInput["code"] !== void 0 ? { code: bodyInput["code"] } : {},
          ...bodyInput["redirect_uri"] !== void 0 ? { redirectUri: bodyInput["redirect_uri"] } : {},
          ...bodyInput["code_verifier"] !== void 0 ? { codeVerifier: bodyInput["code_verifier"] } : {},
          ...bodyInput["refresh_token"] !== void 0 ? { refreshToken: bodyInput["refresh_token"] } : {},
          ...bodyInput["scope"] !== void 0 ? { scope: bodyInput["scope"] } : {}
        }, exchange);
        raw(exchange, 200, result, { "cache-control": "no-store", pragma: "no-cache" });
      } catch (error) {
        const err = error instanceof OidcEndpointError ? error : new OidcEndpointError(400, "invalid_grant", error instanceof Error ? error.message : String(error));
        raw(exchange, err.status, { error: err.error, error_description: err.message }, err.headers);
      }
    });
    http.register("GET", "/oauth/userinfo", (exchange) => {
      const header = String(exchange.headers["authorization"] ?? "");
      const headerSafe = (text) => encodeURIComponent(text).replace(/"/g, "%22");
      const deny = (description) => {
        raw(exchange, 401, { error: "invalid_token", error_description: description }, { "www-authenticate": `Bearer error="invalid_token", error_description="${headerSafe(description)}"` });
      };
      if (!header.startsWith("Bearer ")) {
        raw(exchange, 401, { error: "invalid_token", error_description: t("\u7F3A\u5C11 Bearer access token") }, { "www-authenticate": "Bearer" });
        return;
      }
      try {
        raw(exchange, 200, this.userinfo(header.slice(7), exchange));
      } catch (error) {
        deny(error instanceof Error ? error.message : String(error));
      }
    });
    http.register("GET", "/oauth/end_session", (exchange) => {
      const q = exchange.query;
      try {
        const result = this.endSession({
          idTokenHint: q.get("id_token_hint") ?? void 0,
          postLogoutRedirectUri: q.get("post_logout_redirect_uri") ?? void 0,
          state: q.get("state") ?? void 0
        }, exchange);
        redirect(exchange, result.location);
      } catch (error) {
        const err = error instanceof OidcEndpointError ? error : new OidcEndpointError(302, "invalid_request", error instanceof Error ? error.message : String(error));
        redirect(exchange, `${this.webBase()}/#/oauth/error?error=${encodeURIComponent(err.error)}&error_description=${encodeURIComponent(err.message)}`);
      }
    });
    http.register("POST", "/oauth/revoke", async (exchange) => {
      const bodyInput = exchange.body ?? {};
      const authHeader = String(exchange.headers["authorization"] ?? "");
      let basicId;
      let basicSecret;
      if (authHeader.startsWith("Basic ")) {
        try {
          const decoded = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf8");
          const idx = decoded.indexOf(":");
          basicId = decodeURIComponent(decoded.slice(0, idx));
          basicSecret = decodeURIComponent(decoded.slice(idx + 1));
        } catch {
        }
      }
      try {
        this.revokeToken({
          clientId: basicId ?? bodyInput["client_id"],
          clientSecret: basicSecret ?? bodyInput["client_secret"],
          token: bodyInput["token"],
          tokenTypeHint: bodyInput["token_type_hint"]
        }, exchange);
        raw(exchange, 200, {});
      } catch (error) {
        const err = error instanceof OidcEndpointError ? error : new OidcEndpointError(400, "unsupported_token_type", error instanceof Error ? error.message : String(error));
        raw(exchange, err.status, { error: err.error, error_description: err.message }, err.headers);
      }
    });
  }
}
function withQuery(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
export {
  OidcEndpointError,
  OidcService
};
