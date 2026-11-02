# App SSO 实施计划（执行版）

> 本文档为纯执行计划，已并入评审修正（协议合规、安全闭环、代码事实对账），可直接按 Phase 施工。
> 目标：企业内自研 AI 应用上线前完成身份纳管——「注册应用 → 签发 SSO 凭据 → 上线门禁 → 跳转登录」闭环。
> **MVP = Phase 1 + Phase 2**。
>
> ✅ **交付说明（2026-08-24）**：本计划 P1–P4 全部落地，`npm run selftest` 324/324 全绿
> （含浏览器授权流、MVP 闭环、P3 安全闭环与 openid-client 冒烟）。接入指南见
> [docs/app-sso-integration.md](app-sso-integration.md)；设计背景见 [dev-plan-app-sso.md](dev-plan-app-sso.md)。
> 决策点 D-a 已定为：**支持 `clientType:'public'`**（免 secret + 强制 PKCE + 不发 refresh），文档同时保留 BFF 推荐。

## 全局质量门与前置事实

- **质量门**：仓库无 typecheck/build/test 脚本，`npm run selftest` 是唯一回归手段。每 Phase 的 selftest 新段必须当 Phase 内完成、全绿才算交付，不留尾巴。
- **真实事件名**（`platform-core/src/bus.ts`）：`app.registered` / `app.onlined` / `app.offlined`（过去式）；`app.updated` / `app.archived` 当前不存在，需 plugin-app 补发。
- **内置角色**：`super_admin(*)` / `org_admin` / `resource_admin(含 app.*)` / `developer(仅 app.read)` / `member` / `auditor`。新权限点须先入 `PermissionCatalog`，角色通配（如 `app.*`）按目录前缀展开。
- **owner 校验是全库首例 owner-based 授权**（现状一律 permission-point 制），在 plugin-app 服务层显式实现：human 且 `app.ownerId === principal.userId`，或持 `authn.oidc.write`；机器 principal 一律 403。
- **OIDC 客户端生命周期方法独立新建**（OIDC client 不是 principal，不能复用 `disablePrincipal/enablePrincipal`）。
- 跨插件调用沿用现状惯例：plugin-app 注入并调用 `OidcService` 公开方法，不读写其集合；状态联动走事件总线。

---

## Phase 1：浏览器授权流 + 协议合规面

**后端（plugin-authn/oidc.ts）**
1. 新增 `OidcAuthRequestRecord`（collection `authn:oidcAuthRequests`）：`{clientId, redirectUri, state, scope, nonce?, codeChallenge, expiresAt, consumedAt?, createdAt}`。reqId 用 `crypto.randomUUID()` 级高熵；5min TTL、单次消费；纳入既有每日过期清理巡检（7 天物理删除，对齐 M2 惯例）。
2. `GET /oauth/authorize`（公开）：校验 `response_type=code`、client 存在且 active、redirect_uri 精确白名单、scope 白名单、强制 PKCE S256；任一失败 → 302 `/#/oauth/error?error=…&error_description=…`（**绝不携带外部 redirect_uri**）；成功 → 落 authRequest → 302 `/#/oauth/authorize?req=<id>`。按来源 IP 加基础限流（复用 `assertNotLocked` 骨架）。
3. `GET /api/authn/oidc/auth-requests/:id` 入 `PUBLIC_PATHS`：仅返回 `{clientName, appRef?, scope, consentRequired}`。
4. `POST /api/authn/oidc/authorize`（Bearer）：`{reqId, consent?}` → 校验 req 有效未消费未过期 → human-only（机器 403）→ user active → 复用抽出的 `issueCode()` → 标记消费 → 返回 `{location}`；`consentRequired` 为 true 时必须 `consent===true`。
5. **删除 `POST /oauth/authorize`**（账密式）路由与账密入参路径；**同步重写 selftest 第 6 段与 PKCE/scope 加固段**到新浏览器流（隐藏工作量，列入任务清单）。
6. `/oauth/token`：补 `client_secret_basic`（Authorization: Basic base64(client_id:secret)）；**按 Content-Type 分流同时接受 form-encoded 与 JSON**（RFC 6749 强制，标准客户端只发 form）；响应体补 `scope` 字段。
7. 错误码状态码归位（RFC 6749 §5.2）：`invalid_grant` 等 → 400；`invalid_client` → 401 + `WWW-Authenticate: Basic`；中文 `error_description` 保留。
8. **token 类型区分**：access token 载荷加 `token_use:'access'`，id_token 加 `token_use:'id'`；`userinfo()` 校验 `token_use==='access'` 且 aud 为有效 client（现状 access/id token 同构、userinfo 不校验类型，必须在外发前收敛）。
9. **JWKS 结构改数组**：存储 `keys: OidcKeyMaterial[]`（旧单 key 文件加载时自动包装为数组，零停机）；`verifyJwt/jwks()` 按 header.kid 在数组中匹配（签名用最新 key）。
10. `OIDC_ACCESS_TTL_SECONDS` 环境变量（默认 7200），替换 2h 硬编码。
11. discovery 修正与补全：`scopes_supported` 补 `email`（与 ALLOWED_SCOPES 对齐）；`token_endpoint_auth_methods_supported: ['client_secret_post','client_secret_basic']`。
12. 授权回跳 URL 追加 `iss` 参数（RFC 9207 防 mix-up）；userinfo/authorize 的 401 补 `WWW-Authenticate: Bearer`（RFC 6750）；userinfo 的 `email` claim 按 scope 裁剪。

**前端（plugin-console/public/js）**
13. `pages/oauth.js`：`#/oauth/authorize?req=` 主流程（查 auth-request → 无会话渲染登录面板 → 有会话 → consent 卡片或直接提交 → POST authorize → `location.href` 回跳）；`#/oauth/error` 静态错误页（**`error_description` 必须 `esc()` 转义**，不自动跳转）。
14. `app.js`：builders 注册 `oauth`、`oauth/error`，不入 NAV；`navigate()` 登录拦截仅放行 `#/oauth/*`。

**事件与审计**
15. `PlatformEvents` 新增 `oidc.authorize.granted / denied`；audit 订阅留痕。

**selftest（重写 + 新增）**
16. 无效 client_id / redirect_uri 不在白名单 → 302 平台错误页且 Location 不含外部域；合法请求（PKCE）→ 302 授权页；auth-request 公开查询不泄露 redirect_uri；POST authorize：human ✓ / 机器 403 / reqId 重放 400 / 过期 400 / 未同意 400；token 交换（**Basic 与 Post 两种认证、form 与 JSON 两种编码**、verifier 正误、code 重放拒绝）；state 原样透传；**id_token 调 userinfo → 401**；SPA 静态页 200。
17. **openid-client 冒烟进 selftest**：discovery 驱动跑通 authorize → token → userinfo 最小链（devDependency；授权页 302 以拦截 redirect 模拟）。

---

## Phase 2：应用 ↔ SSO 打通 + 控制台（MVP 收尾）

**数据模型与生命周期（plugin-authn/oidc.ts）**
1. `OidcClientRecord` 扩展可选字段（旧 JSON 零迁移）：`refType?:'app'`、`refId?`、`status:'active'|'disabled'`（缺省 active）、`consentRequired?`、`postLogoutUris?`、`description?`、`clientType?:'confidential'|'public'`（见决策点 D-a）。
2. 新方法：`listClients()`、`updateClient()`、`rotateSecret()`（旧 secret 立即失效、一次性返回新 secret）、`disableClient()/enableClient()`；authorize 入口拒绝 `status!=='active'`。
3. 事件联动（按真实事件名）：`app.offlined / app.archived → disableClient(refId)`；`app.onlined → enableClient(refId)`；`app.updated`（改名）→ 同步 client name。**plugin-app 侧补发**：`updateApp()` 发 `app.updated`；补 `archive()` 方法与入口并发 `app.archived`。

**权限（plugin-iam）**
4. `PermissionCatalog` 新增 `authn.oidc.read` / `authn.oidc.write`；角色种子：`super_admin` 自动覆盖、`resource_admin` 加 `authn.oidc.*`、`auditor` 加 `authn.oidc.read`、`developer` 补 `app.write`（服务端 owner 校验限自身应用）。`POST /api/authn/oidc/clients` 从 `authn.principal.write` 迁至 `authn.oidc.write`；新增 `GET /api/authn/oidc/clients` 列表。

**应用侧 API（plugin-app + console）**
5. `POST /api/apps/:id/sso-client`（owner 校验，见前置事实）：创建关联客户端（name=应用名，回填 refType/refId）→ 一次性返回 secret。
6. `PATCH /api/apps/:id/sso-client`、`…/rotate`、`…/disable|enable`；`GET /api/apps/:id` 响应追加 `sso` 块。redirectUri 校验：`https://` 或 `http://localhost[:port]`。
7. **上线门禁双点**：
   - 点 1（早反馈）：`requestOnline()` 在 `validateAttrs(...,'online')` 后检查 `APP_SSO_ENFORCE`（默认 `web,h5`）命中的 appType 是否有 active SSO 客户端，无则报错指路；审批单 payload 附 `ssoClientId`。
   - 点 2（兜底）：`app.online` 审批执行器内、`registry.online()` 之前复核客户端状态，失效则执行失败并留痕（防审批挂单期间禁用绕过）。

**控制台 UI**
8. apps.js 详情 Drawer 新 tab「SSO 配置」（签发 modal → 一次性 secret modal → 已签发态管理：redirectUris 行内编辑、轮换、禁用/启用、discovery 一键复制、文档链接）。
9. authn.js 新 tab「OIDC 客户端」全局列表（管理员兜底管理）。

**决策点 D-a（开工前定）**：纯前端 h5/SPA 无后端、无法持有 client_secret，与门禁矛盾。二选一：
- 支持 `clientType:'public'`（免 secret + 强制 PKCE + 不发 refresh 或短 TTL）；
- 或文档强制 BFF 架构（secret 只存应用后端），门禁文案同步。

**selftest**
10. 注册 web 应用 → 未签发 requestOnline 被拒 → 签发（secret 仅一次）→ 审批通过 → **执行期复核生效（审批期间禁用客户端 → 上线失败）** → 完整浏览器流 → offline/online 联动 → 轮换后旧 secret 401 → 非 owner developer 403 → 列表含 refApp。

---

## Phase 3：会话补全 + 安全闭环

1. **refresh_token grant**：`OidcRefreshRecord`（`authn:oidcRefreshTokens`）：`{clientId, userId, scope, tokenHash, chainId, rotatedAt?, revokedAt?, expiresAt}`；轮转一次一换、重放整链吊销（同构 `refreshSession`）；scope 只收窄；响应含新 access + id_token + refresh（`otr_` 明文仅一次，库存 hash）；`OIDC_REFRESH_TTL_SECONDS`（默认 604800）。
   - **安全必需**：换发时实时校验 `user.status==='active'`；`iam.user.frozen`/离职事件联动吊销该用户全部 OIDC refresh 链；禁用客户端时吊销其全部 refresh 链。
2. **end_session**：`GET /oauth/end_session?id_token_hint&post_logout_redirect_uri&state`：验签 hint 定位 client → 回跳地址命中 `postLogoutUris` → 302 `/#/oauth/logout` → 页面调 `POST /api/auth/logout` + 清本地会话 → 带 state 跳回；**同时吊销该用户在该 client 下的 refresh 链**（否则登出后应用仍可静默续期）。非法地址 → 平台错误页。
3. **revocation**（RFC 7009）：`POST /oauth/revoke`（client 认证 + token_type_hint，form 解析同 token 端点）→ 吊销 access（jti 黑名单）或 refresh 链；恒 200。
4. **JWKS 密钥轮换**：`POST /api/authn/oidc/keys/rotate`（`authn.oidc.write`）：新 key 入数组签名，旧 key 保留验签 24h 宽限（结构已在 P1 就位，本步只加管理端点）；audit 留痕。
5. discovery 补全：`grant_types_supported` 加 `refresh_token`、`revocation_endpoint`、`end_session_endpoint`。
6. openid-client 联测扩充至 refresh / revoke / end_session，常驻 selftest。
7. selftest：refresh 换发→旧 refresh 重放→整链失效；**冻结 → refresh 换发 401**；scope 扩大 400；end_session 合法/非法回跳 + refresh 链吊销断言；revoke 后 userinfo 401；rotate keys 后旧 token 宽限内验签通过、新 token kid 切换。

---

## Phase 4：文档 + 总览

1. `docs/app-sso-integration.md`（控制台 SSO tab 直链）：接入五步、端点与 discovery（`OIDC_ISSUER` 与内网/HTTPS 反代）、claims 契约（`sub` 稳定关联键、org/roles/tenant 语义）、安全清单（state/PKCE/secret 保管/HTTPS/登出联动/冻结即时失效）、**双 TTL 说明**（平台会话 access 30min vs OIDC access 默认 2h 的折中理由）、**BFF / public 客户端指引**（依 D-a 决策）、secret/密钥轮换 runbook、FAQ（localhost 调试、多环境 issuer、id_token vs userinfo）。
2. 最小示例：直接复用 P1 的 openid-client 冒烟脚本 + curl 手动走流。
3. README「四、核心能力对照」与 `docs/internal/ecosystem-design*.md` 交付状态同步；`skills/dsh-ops-authn/SKILL.md` 补运维场景。
4. 「外部接入总览」tab（只读聚合视图：机器凭证按 refType 分组 + OIDC 客户端含 refApp + connect 已接入客户端，跳转对应管理页）；「认证与令牌」与「平台接入」页互加跳转链接。

---

## 里程碑

| 里程碑 | 内容 | 交付物 |
|---|---|---|
| M1（P1） | 浏览器授权流 + 协议合规面（form/Basic/错误码/token 类型/JWKS 数组/openid-client 冒烟） | 代码 + selftest 新段全绿 |
| **MVP（P1+P2）** | **注册 → 签发 → 门禁（双点）→ 跳转登录闭环 + 控制台** | 同上 + README 同步 |
| M3（P3） | refresh / end_session / revoke / 密钥轮换 + 冻结联动安全闭环 + 全量联测 | 同上 |
| M4（P4） | 接入规范 + 示例 + 外部接入总览 | 文档 + UI |

## 明确不做（本期范围外）
OIDC token ↔ dst1 桥接；引入 Keycloak/Authentik 替代自研 Provider；合并 plugin-authn 与 plugin-connect；控制台 SPA 直调 userinfo 的 CORS；CIBA/设备码/动态客户端注册；外部开发者自助门户。
