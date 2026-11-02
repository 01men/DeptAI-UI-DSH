# 应用统一身份接入（App SSO）开发规划 V1.1

> **V1.1 变更**（2026-08-24）：新增 §五「模块边界：统一认证中心 与 平台-平台接入」、
> §六「规范性对齐：Keycloak / Authentik 行为基线」，并相应扩充 P1（错误码标准化）、
> P2（生命周期原语下沉 + 外部接入总览）、P3（TTL 可配 + openid-client 联测）工作项。
>
> **目标**：企业内超级个体/团队自研的 AI 应用，在发布上线前完成身份纳管——组织账号与登录
> 授权统一由本平台（衡）管理，业务权限保留在应用自身，仅以组织身份（`sub` + `org`/`roles`）关联。
> 本计划落地生态设计 v1.2「模式 B：平台作为外部应用的身份源」的**浏览器接入闭环**，
> 补齐 ecosystem-design.md §二（:179-182）描述、但代码尚未实现的 302 跳转式授权流，
> 并把「应用注册 → SSO 凭据签发 → 上线审批 → 按规范接入」打通为一条链。

---

## 〇、现状与差距

| 能力 | 现状 | 位置 |
|---|---|---|
| OIDC Provider 协议核心（授权码 + PKCE、RS256/JWKS、discovery、id_token） | ✅ 已实现，selftest 全覆盖 | `packages/plugin-authn/src/oidc.ts` |
| userinfo 返回 org/roles/tenant，冻结/离职即时 401 | ✅ 已实现（企业级联防） | `oidc.ts:181-197` |
| 浏览器跳转授权（GET /authorize → 平台登录页 → 302 回跳） | ❌ 现为 POST + 账密的程序化授权 | `oidc.ts:96,318` |
| refresh_token / end_session / revocation | ❌ 无；access token 固定 2h | `oidc.ts:141,170` |
| 应用注册自动获得 SSO 凭据 | ❌ 注册发的是机器凭证（应用调平台 API 方向）；OIDC 客户端为独立管理员登记，无关联 | `packages/plugin-app/src/index.ts:57-65`、`oidc.ts:21-26` |
| OIDC 客户端生命周期（列表/轮换/禁用）+ 控制台 UI | ❌ 仅 create，无 UI | console `src/index.ts:805-813` |
| 应用生命周期 ↔ SSO 客户端联动 | ❌ 无（app.offlined 仅联动机器凭证禁用） | `plugin-authn/src/index.ts:159-170` |
| 面向开发者的接入规范/示例 | ❌ 无 | docs/ 全库检索无 |

**结论**：「在平台注册发布即可统一登录」当前不成立。本计划 Phase 1+2 完成后成立，Phase 3+4 补全体验与文档。

---

## 一、总体设计

### 1.1 目标时序（浏览器授权码流程）

```
第三方 AI 应用                平台（衡）                     终端用户浏览器
     │                            │                              │
     │ 1. 302 → GET /oauth/authorize?client_id&redirect_uri      │
     │            &state&scope&nonce&code_challenge(S256) ────────►
     │                            │ 2. 参数校验，落「授权请求单」(5min TTL)
     │                            │ 3. 302 → /#/oauth/authorize?req=…
     │                            │◄──────────────────────────────│
     │                            │ 4. SPA 授权页：未登录→登录表单；已登录→(同意页)
     │                            │ 5. POST /api/authn/oidc/authorize {reqId}  (Bearer)
     │                            │ 6. 签发一次性 code，返回回跳地址
     │                            │ 7. 浏览器 302 → redirect_uri?code&state
     │◄───────────────────────────│───────────────────────────────│
     │ 8. POST /oauth/token (code + client_secret + code_verifier)
     │◄── access_token(2h) + id_token + refresh_token(7d) ────────│
     │ 9. GET /oauth/userinfo (Bearer) → sub/org/roles/tenant     │
     │ 10. 应用以 sub 为本地用户关联键，权限自管                   │
```

### 1.2 设计原则：最大化复用既有机制

| 复用点 | 依据 |
|---|---|
| 授权页嵌入现有 SPA（hash 路由 + 页面四步惯例） | `public/js/app.js:51-79` builders 映射、`NAV` 注册 |
| 会话复用 localStorage Bearer（同源可读），过期走 `tryRefresh` 自动续期 | `public/js/api.js:39-84` |
| code 签发逻辑沿用现有 `authorize()` 的白名单/PKCE/限流骨架，抽出 `issueCode()` 内部共享 | `oidc.ts:96-137` |
| refresh 轮转 + 重放整链吊销，仿 `authn.refreshSession` 同构实现 | `plugin-authn/src/index.ts:220-237` |
| app↔客户端生命周期联动走事件总线（authn 已监听 `AppOfflined`，同模式扩展） | `plugin-authn/src/index.ts:159-170` |
| 上线门禁挂在 `requestOnline` 校验链（`validateAttrs(...,'online')` 之后） | `plugin-app/src/index.ts:100-112`、`resource-core/src/index.ts:321-324` |
| 一次性 secret 展示、表单 modal、Drawer tab 均有现成 UI 惯例 | `connect.js:210-240`、`apps.js:68-197` |
| 测试进 selftest（HTTP 级断言 302/JSON，不依赖真浏览器） | `tests/selftest.mjs:512-556` OIDC 段 |

### 1.3 关键决策记录（ADR）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 新增「授权请求单」（authRequest）落库，GET /authorize 校验参数后 302 到 `/#/oauth/authorize?req=`，SPA 仅回传 reqId | 参数只校验一次、尽早拒绝非法 client（302 前）；前端不往返敏感参数，防篡改；便于审计「授权请求发起」。单次消费 + 5min TTL |
| D2 | **移除 `POST /oauth/authorize`（账密式）** | 该端点要求用户在第三方应用内输入平台密码，属反模式；功能尚未对外发布，无兼容包袱；OAuth 2.1 最佳实践只保留跳转流。selftest 同步改造 |
| D3 | **强制 PKCE（S256）**，所有客户端一律 | 现代最佳实践（OAuth 2.1 草案）；代码已支持校验，收紧无成本 |
| D4 | app 与 OIDC 客户端**松耦合**：`OidcClientRecord` 扩展 `refType:'app'/refId`，签发入口在应用侧（`POST /api/apps/:id/sso-client`），生命周期经事件联动 | 符合「插件协作铁律」（跨插件只走事件总线）；plugin-app 不感知 OIDC 内部结构，plugin-authn 不依赖 plugin-app |
| D5 | 上线门禁：`appType ∈ {web,h5}` 强制已配置有效 SSO 客户端（`APP_SSO_ENFORCE` 可配，默认 `web,h5`）；miniapp/desktop 建议不强制；api 型豁免 | 治理意图即「上线前身份纳管」；对无终端用户界面的应用不做无意义卡点 |
| D6 | 同意页默认关闭（`consentRequired:false`，字段与 UI 保留） | 企业内部应用间信任由平台登记行为背书；开放给外部开发者后再默认开启 |
| D7 | OIDC refresh token 独立于平台 dst1 refresh（`otr_` 前缀、库存 hash、轮转链），TTL 7d | 两套令牌受众/语义不同（外部 JWT 体系 vs 内部 API 体系）；桥接（OIDC token 换 dst1）**本期不做**，见 §六 |
| D8 | end_session 语义 = 「终结平台会话 + 回跳」，非严格全局 SLO | 平台无共享 Cookie（会话在 localStorage），架构下可达的最大程度；文档明示应用须自行清理本地会话 |
| D9 | 授权页/登录面板新建 `pages/oauth.js`，复制少量登录表单逻辑而非改造 `login.js` 主流程 | 登录页是全员入口，风险隔离；后续可抽共享组件 |
| D10 | 新权限点 `authn.oidc.read` / `authn.oidc.write`（替代现挂在 `authn.principal.write` 下的客户端登记）；应用侧签发走 `app.write` + owner 校验，无需 authn 权限点 | 权限语义分离；超级个体（dev 角色）可自助为自己 owner 的应用签发，不放大其全局权限 |
| D11 | 统一认证中心（plugin-authn）与平台接入（plugin-connect）**分层保持独立、不合并插件**；整合发生在服务层（生命周期原语下沉 authn）与控制台层（聚合视图「外部接入总览」） | authn 是唯一凭据内核、全部 `/api/*` 的鉴权热路径，须薄而稳定；connect 含客户端角色（工具远程代理/本机配置页），职责正交；Keycloak 的认证内核与客户端适配器同构分离。详见 §五 |
| D12 | 以 Keycloak / Authentik 的协议行为为规范性基线（RFC 6749 错误码、token TTL 可配、密钥轮换、事件留痕），并以 openid-client 标准库联测作为规范性验收；**不引入**二者替代自研 Provider | 对齐久经验证的行为而非引入重型组件——后者与「一切皆插件」轻量零外部依赖的部署形态冲突。详见 §六 |

---

## 二、分阶段实施计划

> 每个 Phase 独立可交付：selftest 全绿、README 能力清单同步更新。
> **MVP = Phase 1 + Phase 2**：完成后「注册应用 → 签发 SSO 凭据 → 上线审批 → 跳转登录」闭环成立。

### Phase 1 浏览器授权流（核心）

**后端（plugin-authn/oidc.ts + console）**

1. `OidcAuthRequestRecord`（collection `authn:oidcAuthRequests`）：
   `{clientId, redirectUri, state, scope, nonce?, codeChallenge, expiresAt, consumedAt?}`。
   与 `OidcCodeRecord` 一致不做主动清理，仅逻辑过期。
2. `GET /oauth/authorize`（公开）：
   - 校验 `response_type=code`、client 存在且 `status:'active'`、redirect_uri 精确白名单、scope 白名单、**强制 code_challenge + method=S256**；
   - 任一失败 → 302 `/#/oauth/error?error=invalid_request&error_description=…`（**绝不**携带外部 redirect_uri，防钓鱼/开放重定向）；
   - 成功 → 落 authRequest（5min）→ 302 `/#/oauth/authorize?req=<id>`。
3. `GET /api/authn/oidc/auth-requests/:id`（加入 `PUBLIC_PATHS`）：仅返回
   `{clientName, appRef?, scope, consentRequired}`，供登录前渲染，不回传 redirect_uri。
4. `POST /api/authn/oidc/authorize`（Bearer）：入参 `{reqId, consent?}`；
   校验 req 有效未消费未过期 → `principal.kind==='human'`（机器 403）→ user active →
   复用 `issueCode()`（自现有 `authorize()` 抽出：client/scope/PKCE 校验已前移，此处落 `OidcCodeRecord`）→
   标记消费 → 返回 `{location: redirectUri?code=…&state=…}`（state 原样透传）。
   同意校验：`consentRequired` 为 true 时必须 `consent===true`。
   沿用 `assertNotLocked` 限流骨架不变（POST /api/auth/login 已覆盖账密面）。
5. **删除** `POST /oauth/authorize` 路由与 `authorize()` 的账密入参路径。
6. `/oauth/token` 支持 `Authorization: Basic base64(client_id:client_secret)`（多数 OIDC 库默认），discovery 的 `token_endpoint_auth_methods_supported` 补 `client_secret_basic`。
7. 错误响应标准化（RFC 6749 §5.2，对齐 Keycloak）：token 端点错误统一映射
   `invalid_request / invalid_client / invalid_grant / invalid_scope / unsupported_grant_type`——
   `invalid_client` 返回 401（含 `WWW-Authenticate: Basic`），其余 400；中文 `error_description` 保留（双信息，Keycloak 同款）。

**前端（public/js）**

8. `pages/oauth.js`：
   - `#/oauth/authorize?req=` 主流程：查 auth-request → 无会话渲染登录面板（调 `POST /api/auth/login`，成功 `session.save` 后继续）→ 有会话（`api.js` 的 fetch 自带 401 续期）→ `consentRequired ? 同意卡片（client 名 + 申请 scope）: 直接提交` → `POST /api/authn/oidc/authorize` → `location.href = location`；
   - `#/oauth/error?error=&error_description=` 静态错误页（显示原因、返回控制台链接、不自动跳转）；
   - req 过期/已消费/登录失败 → 页内错误态 + 「重新从应用发起」提示。
9. `app.js`：builders 注册（`oauth`、`oauth/error` 两个 hash 路径），不入 NAV 侧边栏；
   注意 `navigate()` 的登录拦截（`app.js:55-58`）需放行本页（本页自带登录能力）。

**事件与审计**

10. `PlatformEvents` 新增 `oidc.authorize.granted / denied`；audit 插件订阅留痕（clientId、refApp、userId、失败原因）。

**selftest（新增 section「OIDC 浏览器授权流」）**

11. 无效 client_id → 302 至 `/#/oauth/error` 且 Location 不含外部域；redirect_uri 不在白名单 → 同上；
    合法请求（PKCE）→ 302 `/#/oauth/authorize?req=`；auth-request 公开查询仅暴露 clientName/scope；
    POST authorize：human ✓ / 机器 token 403 / reqId 重放 400 / 过期 400 / consentRequired 未同意 400；
    从 location 解析 code+state → token 交换（Basic 与 Post 两种认证、verifier 正误两例、code 重放拒绝）；
    state 原样回传断言；SPA 静态页 200。

### Phase 2 应用 ↔ SSO 客户端打通 + 控制台

**数据模型与生命周期（plugin-authn/oidc.ts）**

1. `OidcClientRecord` 扩展（全部可选，旧 JSON 兼容）：
   `refType?: 'app'`、`refId?: string`、`status: 'active'|'disabled'`（缺省视为 active）、
   `consentRequired?: boolean`、`postLogoutUris?: string[]`、`description?`。
2. 新方法：`listClients()`、`updateClient(id, {redirectUris, consentRequired, postLogoutUris, description})`、
   `rotateSecret(id)`（旧 secret 立即失效，返回一次性新 secret）、`disableClient(id)/enableClient(id)`；
   `authorize` 入口对 `status!=='active'` 拒绝。禁用/启用/吊销**原语下沉 authn 统一实现**
   （联动吊销令牌 + 审计留痕一次成型；connect 与 OIDC 共用同一套生命周期原语，见 §5.3）。
3. 事件联动（plugin-authn，仿 `index.ts:159-170` 的 `AppOfflined` 监听）：
   `app.offlined / app.archived → disableClient(refId)`；`app.online → enableClient(refId)`；
   `app.updated`（若改名）→ 同步 client name。若 `PlatformEvents` 缺 `AppOnlined/AppArchived`，由 plugin-app 补发。
4. 新权限点 `authn.oidc.read/write` 进 iam 角色种子（admin 全量、ops 授予、hr/audit 按需只读）；
   `POST /api/authn/oidc/clients` 迁移至 `authn.oidc.write`，新增 `GET /api/authn/oidc/clients` 列表。

**应用侧 API（plugin-app + console）**

5. `POST /api/apps/:id/sso-client`（`app.write` + owner 校验：principal 为 human 且 `app.ownerId===principal.userId`，或持 `authn.oidc.write`）：
   创建关联客户端（name=应用名，refType/refId 回填）→ 返回一次性 secret；
6. `PATCH /api/apps/:id/sso-client`（redirectUris/consentRequired/postLogoutUris）、
   `POST /api/apps/:id/sso-client/rotate`、`POST /api/apps/:id/sso-client/disable|enable`；
   `GET /api/apps/:id` 响应追加 `sso` 块（clientId、redirectUris、status、consentRequired、discovery 端点组）。
   redirectUri 校验：`https://` 或 `http://localhost[:port]`（本地调试）。
7. **上线门禁**：`requestOnline()`（`plugin-app/src/index.ts:100-112`）在 `validateAttrs(...,'online')` 后追加：
   `APP_SSO_ENFORCE`（默认 `web,h5`）命中 `appType` 且无 `status:'active'` 关联客户端 → 抛错并指路
   「应用详情 → SSO 配置」；审批单 payload 附 `ssoClientId` 供审批人核对。
8. 角色审视：dev 角色补 `app.write`（超级个体可注册应用；服务端 owner 校验限自身应用），iam 种子与演示说明同步。

**控制台 UI**

9. `apps.js` 详情 Drawer 新 tab「SSO 配置」：
   未签发 → 说明卡 + 签发按钮（modal：redirectUris 多行、consentRequired 开关）→ 一次性 secret modal（`code-block` + 复制，惯例 `connect.js:210-240`）；
   已签发 → clientId、状态徽标、redirectUris 行内编辑、轮换 secret、禁用/启用、discovery 地址一键复制、接入文档链接。
10. `authn.js` 新 tab「OIDC 客户端」：全局列表（client/refApp/状态/consent/操作），管理员视角兜底管理。
11. 「外部接入总览」tab（§5.3 控制台聚合）：跨渠道汇总机器凭证（按 `refType` 分组：app/agent/external）、
    OIDC 客户端（含 refApp）、connect 已接入客户端——状态/最近使用/跳转对应管理页；
    「认证与令牌」页头与「平台接入」页互加跳转链接，管理员一处看清「谁在用什么方式接入平台」。

**selftest**

11. 注册 web 应用 → 未签发即 `requestOnline` 被拒（门禁）→ 签发（secret 仅一次）→ 提交上线审批通过 →
    完整浏览器流走通（Phase 1 断言复用）→ `offline` 后 authorize 拒绝、`online` 恢复 →
    轮换后旧 secret 401 → 非 owner 的 dev 签发 403 → `GET /api/authn/oidc/clients` 列表含 refApp。

### Phase 3 会话补全：refresh / end_session / revocation / 密钥轮换

1. **refresh_token grant**（`/oauth/token`）：`OidcRefreshRecord`（collection `authn:oidcRefreshTokens`）：
   `{clientId, userId, scope, tokenHash, chainId, rotatedAt?, revokedAt?, expiresAt}`；
   轮转一次一换（同 chainId），重放检测 → **整链吊销**（同构 `authn.refreshSession` `index.ts:220-237`）；
   `scope` 参数只允许收窄；响应含新 access + 新 id_token + 新 refresh（`otr_` 明文仅此一次，库存 hash）；
   app.offlined 联动：禁用客户端时吊销其全部 refresh 链。
2. **end_session**：`GET /oauth/end_session?id_token_hint&post_logout_redirect_uri&state`：
   验签 hint（取 aud 定位 client）→ 回跳地址须命中该 client 的 `postLogoutUris` 或与某 redirectUri 同源 →
   302 `/#/oauth/logout?…`；`pages/oauth.js` 的 logout 页调 `POST /api/auth/logout`（吊销平台会话）+
   `session.clear()` → 跳回带 state。非法地址 → 平台错误页。
3. **revocation**（RFC 7009）：`POST /oauth/revoke`（client 认证 + token_type_hint）→ 吊销 access（jti 黑名单）
   或 refresh 链；响应恒 200（不泄露 token 存在性）。
4. **JWKS 密钥轮换**：`keys: OidcKeyMaterial[]`（签名用最新，验签按 header.kid 在数组匹配）；
   `POST /api/authn/oidc/keys/rotate`（`authn.oidc.write`）：生成新 key 入 JWKS，旧 key 保留验签 24h 宽限
   （覆盖 2h access token 全生命周期；refresh 为不透明串不受影响）；audit 留痕。
5. discovery 增量更新：`grant_types_supported` 补 `refresh_token`、`revocation_endpoint`、
   `end_session_endpoint`、`token_endpoint_auth_methods_supported: [post, basic]`（对齐 Keycloak discovery 字段完备性）。
6. token 有效期可配置（对齐 Keycloak realm/client 两级 lifespan 语义）：环境变量
   `OIDC_ACCESS_TTL_SECONDS`（默认 7200）、`OIDC_REFRESH_TTL_SECONDS`（默认 604800）；
   client 级覆盖字段预留（本期不做 UI）。
7. **openid-client 联测（规范性验收）**：selftest 引入 openid-client（OpenID 认证的标准客户端库，
   devDependency）以 discovery 驱动、零定制适配跑通 授权码 + PKCE → token → userinfo → refresh 全链；
   授权页 302 以拦截 redirect 方式模拟，不依赖真浏览器。「标准库能跑通」即规范合规的客观证据。
8. selftest：refresh 换发 → 旧 refresh 重放 → 新 refresh 同链失效；scope 扩大 400；
   end_session 合法/非法回跳；revoke 后 userinfo 401；rotate keys 后旧 token 宽限内验签通过、新 token kid 切换。

### Phase 4 开发者接入规范与示例

1. **`docs/app-sso-integration.md`**（给超级个体的接入规范，控制台 SSO tab 直接链接）：
   - 架构与适用场景（业务权限留应用、仅身份关联的推荐姿势）；
   - 接入五步：平台注册应用 → SSO 配置签发凭据 → （web/h5）上线门禁 → 应用实现授权码 + PKCE → 验证联调；
   - 端点与 discovery（`OIDC_ISSUER` 说明、内网/HTTPS 反代注意事项）；
   - claims 契约：`sub` 为**稳定关联键**（本地用户表外键）、`org{id,name,tenantId}/roles[]/tenant` 语义、
     权限映射建议（角色→应用内角色的映射表由应用自管）；
   - 安全清单：state 校验、PKCE 强制、secret 保管与轮换、HTTPS、登出联动（end_session + 应用自清会话）、
     冻结/离职即时失效的行为说明（userinfo 401 → 应用侧终结会话）；
   - FAQ：本地调试（localhost redirect）、多环境 issuer、id_token vs userinfo 取身份的取舍。
2. **最小示例**（文档内嵌）：Node/Express 完整可跑片段（发起授权 → 回调换 token → userinfo → 本地 session →
   登出联动）+ curl 手动走流。不新建 examples/ 目录，随文档演进。
3. README「能力清单」与 `docs/internal/ecosystem-design*.md` 交付状态表同步；`skills/dsh-ops-authn/SKILL.md` 补运维场景
   （客户端签发/轮换/禁用、密钥轮换 runbook）。

---

## 三、接口与数据模型汇总

**新增公开端点**（不经 `/api/*` Bearer 中间件）：

| 端点 | Phase | 说明 |
|---|---|---|
| `GET /oauth/authorize` | 1 | 参数校验 → authRequest → 302 SPA 授权页 / 错误页 |
| `GET /api/authn/oidc/auth-requests/:id` | 1 | 登录前只读（clientName/scope/consentRequired），入 `PUBLIC_PATHS` |
| `GET /oauth/end_session` | 3 | 302 logout 页 |
| `POST /oauth/revoke` | 3 | RFC 7009 |

**Bearer 端点**：

| 端点 | Phase | 权限 |
|---|---|---|
| `POST /api/authn/oidc/authorize` | 1 | 任意 active human（机器 403） |
| `GET /api/authn/oidc/clients` | 2 | `authn.oidc.read` |
| `POST /api/authn/oidc/clients`（改造） | 2 | `authn.oidc.write`（原 `authn.principal.write`） |
| `POST /api/apps/:id/sso-client` | 2 | `app.write` + owner，或 `authn.oidc.write` |
| `PATCH /api/apps/:id/sso-client`、`…/rotate`、`…/disable|enable` | 2 | 同上 |
| `POST /api/authn/oidc/keys/rotate` | 3 | `authn.oidc.write` |

**改造/删除**：`POST /oauth/authorize`（账密式）删除；`POST /oauth/token` 补 Basic 认证（P1）与 refresh grant（P3）。

**新集合**：`authn:oidcAuthRequests`（P1）、`authn:oidcRefreshTokens`（P3）；
`authn:oidcClients` 记录扩展可选字段（P2）——旧数据零迁移。

**新事件**（进 `PlatformEvents` 常量表，audit 订阅留痕）：
`oidc.authorize.granted/denied`（P1）、`oidc.client.created/rotated/disabled/enabled`（P2）、
`oidc.refresh.replayed`（P3，可挂告警规则）。

---

## 四、风险与兼容性

| 风险 | 应对 |
|---|---|
| `POST /oauth/authorize` 删除为 breaking | 功能未对外发布；selftest 与文档同 PR 改造；README 变更说明 |
| 授权页放行 hash 路由绕过登录拦截（`app.js:55-58`） | 仅放行 `#/oauth/*` 与 `#/logout`，其余路由维持原拦截 |
| 开放重定向 / 钓鱼 | redirect_uri 精确匹配白名单；参数错误一律平台错误页、绝不 302 外部；authRequest 单次消费 5min；state 仅透传由应用校验 |
| localStorage 会话被第三方页读取 | 同源策略保证仅平台域可读；接入文档禁止应用内嵌平台页取 token |
| `APP_SSO_ENFORCE` 门禁误伤存量应用 | 仅对 `online` 转移生效，存量 online 应用不回溯；环境变量可配空串关闭 |
| JWKS 轮换窗口验签失败 | 双 key 并行发布 + 24h 宽限（远超 2h access TTL）；selftest 回归 |
| openid-client 作为新增依赖 | 仅 selftest 开发依赖（devDependency），不进运行时；离线环境预取一次即可 |
| 无 Cookie 架构下「单点登出」语义弱化 | 文档显式声明 D8 语义；应用侧责任清单化 |

---

## 五、模块边界：统一认证中心 与 平台-平台接入

### 5.1 现状盘点

部署后的控制台有三个身份相关入口，容易给人「功能重复」的观感：

| 控制台入口 | 插件 | 管什么 | 定位 |
|---|---|---|---|
| 认证与令牌（页面名「统一认证中心」`#/authn`） | plugin-authn | 身份主体（人/机器双轨）、访问令牌签发/校验/吊销；P2 起增加 OIDC 客户端 | **能力层**：全平台唯一认证内核 |
| 平台接入 `#/connect` | plugin-connect | 接入码 → 远程 dsh 客户端 enroll/启停/审计 | **渠道层**：远程 dsh 运行时这一种接入方式的工作流 |
| 三方集成 `#/iam?tab=connectors` | plugin-iam | 钉钉等外部 IdP / 通讯录同步（入方向联邦） | 入方向：对接企业既有身份源 |

### 5.2 功能是否重复：是分层，不是重复

connect 的 enroll 最终调 `ctx.authn.createMachineCredential({refType:'external'})`（`plugin-connect/src/host.ts:158-162`）——
**凭据的签发、校验、吊销、限流、密钥全部收敛在 authn**；connect 只做三件 authn 不做的事：
一次性接入码工作流、远程客户端登记册（`ConnectClientRecord`）、客户端角色（工具远程代理 + 本机配置页，
`client.ts`/`config-page.ts`——这部分与认证完全正交）。

真正重复的是三处「样板」（P2 引入 OIDC 客户端后会变成第三遍）：
1. 控制台交互：一次性凭据展示 modal、禁用必填原因、状态徽标——各页各写一遍；
2. 生命周期动作：disable/enable + 联动吊销令牌 + 审计留痕的实现模式各写一遍；
3. 「谁接入了平台」的登记册语义分散（principals.refType / ConnectClientRecord / OidcClientRecord）。

### 5.3 决策：插件独立、原语下沉、控制台聚合（ADR D11）

| 层 | 决策 | 理由 |
|---|---|---|
| 插件层 | **不合并**。authn 保持唯一认证内核；connect 保持独立渠道插件 | ① connect 是双角色插件（宿主管理面 + 客户端远程代理/配置页），与认证内核职责正交；② authn 是所有 `/api/*` 请求的鉴权热路径，必须薄而稳定，渠道业务易变不应混入；③ 合并会违反「跨插件只走事件总线」铁律并制造反向依赖。**Keycloak 同构佐证**：其认证内核（realm/clients/tokens）与客户端适配器、分发渠道也是分离的 |
| 服务层 | 生命周期**原语下沉 authn**：禁用/启用/吊销/轮换统一为 authn 服务方法（内建联动吊销令牌 + 审计留痕），connect、OIDC、app 各渠道只登记元数据与渠道特有动作 | 消除三处样板；「禁用必留痕、必吊销令牌」的一致性由内核单点保证 |
| 登记层 | 外部凭据统一 `refType/refId` 语义（app / agent / external / oidc-client…），管理端按渠道可过滤 | 为跨渠道总览、审计归一、后续「外部接入」治理打基础 |
| 控制台层 | **聚合呈现**：「认证与令牌」升格为认证中心聚合页（身份主体 / 访问令牌 / OIDC 客户端 / 外部接入总览）；「平台接入」保留，定位为远程 dsh 接入引导与该渠道专属管理（三步接入说明、接入码、客户端） | 管理员一处看清「谁在用什么方式接入平台」；渠道页的场景化引导不被淹没，两种心智（按能力找 / 按场景找）各得其所 |

**P2 落地范围**：原语下沉随 OIDC client 的 disable/enable 一并收敛；控制台聚合新增「外部接入总览」tab（见 P2 工作项 11）。
后续新接入渠道（如模型网关直连客户端）一律按「渠道插件 + authn 原语 + refType 登记」模式扩展，不再各建样板。

---

## 六、规范性对齐：以 Keycloak / Authentik 为行为基线

**原则**：不引入这两个框架替代自研 Provider（与「一切皆插件」轻量内核、零外部服务依赖的部署形态冲突），
但对齐其久经验证的**协议行为、生命周期语义与管理面完备性**，并新增「标准客户端库联测」作为规范性验收手段。

| 领域 | Keycloak / Authentik 行为 | 本计划对齐情况 | 落点 |
|---|---|---|---|
| 错误响应 | RFC 6749 §5.2 标准错误码 + 正确状态码（invalid_client → 401 + WWW-Authenticate） | 现状为自定义中文消息透传 → **新增错误码映射** | P1 |
| token 有效期 | realm/client 两级可配置（Access Token Lifespan 等） | 现状 2h 硬编码 → **新增 TTL 环境变量**（client 级预留） | P3 |
| refresh 轮转 | Keycloak 可选 Revoke Refresh Token；Authentik 默认轮转 | 强制轮转 + 重放整链吊销（严于默认，保持） | P3 |
| 客户端生命周期 | Enabled 开关、secret 轮换、Client Scopes（default/optional） | status / rotateSecret 已计划；scope 全局白名单为**有意简化**（接入文档声明扩展路径） | P2 |
| 登出 | end_session + Valid post logout redirect URIs 白名单 | postLogoutUris 白名单 | P3 |
| 密钥轮换 | realm keys active/passive 并行，旧钥验签宽限 | JWKS 双 key + 24h 宽限 | P3 |
| 审计事件 | LOGIN / CODE_TO_TOKEN / REFRESH_TOKEN / LOGOUT 事件日志 | oidc.* 事件进 audit（命名对齐该事件类型表） | P1/P3 |
| 防暴力破解 | Brute Force Detector（失败计数 + 锁定升级） | `assertNotLocked` 全链复用（已具备，行为等价） | 已对齐 |
| 发现文档 | 字段完备（revocation / end_session / auth methods） | discovery 增量补全 | P3 |
| 管理面 | Admin Console 客户端管理完备 | OIDC 客户端管理页 + 应用 SSO tab + 外部接入总览 | P2 |
| 规范验收 | OpenID Certification / conformance suite | **openid-client（经 OpenID 认证的标准库）零定制跑通全流程**作为轻量等价物 | P3 |

**稳定性保障**（对齐之外的三条工程约束）：
1. **热路径守恒**：`/oauth/*` 验签为无状态 JWKS 本地校验，不引入数据库热点查询；限流复用 authn 既有机制，不新增运行时外部依赖；
2. **兼容承诺**：discovery 与 claims 只增不改；破坏性变更（删 POST authorize）在功能外发前一次性完成；
3. **回归底线**：每 Phase selftest 新段全绿 + 安全攻击面回归（code 重放 / redirect 白名单 / PKCE / refresh 重放）不回退，openid-client 联测进 P3 后长期驻留 selftest。

---

## 七、里程碑与交付顺序

| 里程碑 | 内容 |
|---|---|
| M1（P1） | 浏览器授权流 + 错误码标准化 + 审计 + selftest |
| **MVP（P1+P2）** | **注册 → 签发 → 上线门禁 → 跳转登录闭环 + 控制台（含外部接入总览、原语下沉）** |
| M3（P3） | refresh / end_session / revoke / 密钥轮换 / TTL 可配 / openid-client 联测 |
| M4（P4） | 接入规范 + 示例 + 文档同步 |

每里程碑交付物：代码 + selftest 新段全绿 + README/文档更新。P3、P4 可与 MVP 后的运营反馈并行。

## 八、明确不做（本期范围外）

- **OIDC token ↔ 平台 dst1 token 桥接**（应用以用户身份调平台 API / obo 链融合）——待外部应用产生真实需求后单独立项；
- **引入 Keycloak / Authentik 组件或以其替代自研 Provider**——只对齐行为基线（§六），保持轻量零外部依赖部署形态；
- **合并 plugin-authn 与 plugin-connect**——分层保持独立，整合只在原语与控制台层（§五）；
- 控制台 SPA 直接调 userinfo 的 CORS 支持——应用后端代理即可，避免扩大 CORS 面；
- CIBA、设备码流、动态客户端注册（RFC 7591）——无场景；
- 外部开发者门户自助登记（v1.2 第 5 步规划）——本期以「内部 owner 自助 + 管理员兜底」覆盖超级个体场景。
