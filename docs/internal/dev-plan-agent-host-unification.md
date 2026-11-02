# 开发计划：dsh 宿主统一入口与 Agent 身份打通——单进程单入口 · OIDC-agent · 自然免登

> 版本：v1.0（2026-09-02）· 分支：`custom/dsh-rq`（本项目主分支线，不合并回 ybkkasi main）
> 关联需求：在 dsh 上启动宿主服务；对 dsh Agent 本身进行宿主资产登记；账号/登录/权限与宿主平台打通；
> 前端业务交互与后端管理服务统一。
> 方案决策（需求方拍板，2026-09-02）：
> ① dsh web 自带 UI 直接作为 Agent 交互界面，免登体验要做到"自然"（进入即已登录，无感知）；
> ② OIDC 与 Agent 资产的关联一步到位（对齐 app 侧既有能力，不留半成品通道）；
> ③ 部署形态必须**单进程单入口**（一个进程、一个端口承载 dsh 宿主 + 平台数据面）。
> 明确不采用：薄包装页 iframe 嵌 dsh UI（身份注入仍要靠宿主侧机制，纯增劣化）；反代合并两端口
> （与单进程目标相悖）；修改 dsh 前端/宿主源码（上游 harness checkout，避免 fork 漂移——全部扩展点
> 经实测存在于插件挂载面，无需改源码）。

---

## 〇、现状基线（已核实，2026-09-02）

| 事实 | 证据 | 对本计划的意义 |
|---|---|---|
| dsh web = 纯 node:http 服务器（`ctx.webServer`），默认 3080/127.0.0.1，CLI 拒绝 `--host 0.0.0.0` | `deepseek-harness/packages/host/webserver/src/index.ts:11,170`；`packages/bundle/web-app/src/startup.ts:69-71` | 单入口的宿主侧监听器已经存在，无需新建 |
| 插件可注册前缀/精确路由，handler 拥有完整 req/res 生命周期（可 Set-Cookie、可流式） | `webserver/src/index.ts:94-145`（register/registerUpgrade/registerFallback/tapIndex） | 元冰可数据面挂载点现成；`/api` 前缀已被 client-connection 占用（重复注册 throw，`connection/src/index.ts:96-98`）→ 元冰可必须挂 `/rq` 前缀 |
| fallback 席位只有一个且已被 dsh 前端占用（二次注册 throw） | `webserver/src/index.ts:125-131`、`frontend-static/src/index.ts:93-110` | 控制台 SPA 只能在 `/rq` 前缀内自管静态与 miss 回退 |
| index.html 每次响应都过 index taps（`__DSH_BOOT__` 注入即走此通道） | `webserver/src/index.ts:139-145,259-263`；`client/modules/src/index.ts:168-175` | 免登引导脚本可零源码注入 dsh UI |
| 浏览器端插件机制：包声明 `dsh.client` 即被伺服于 `/plugins/<id>/client.js` 并入启动图；ui-auth 是双面插件完整范本 | `packages/client/modules/src/index.ts:150-158,241-249`；`packages/client/ui-auth/` | 平台身份的浏览器半（查身份/触发 OIDC 跳转）有现成范式 |
| dsh web 无认证层（fence 防的是 DNS rebinding/跨站，README 自认 not auth）；工具执行无 HTTP 请求上下文（`ToolRunContext` 只有 agent/session） | `connection/README.md`；`packages/core/tools/src/index.ts:313-338` | 身份必须在宿主侧持久化（绑定存储），由会话关联；不能依赖请求上下文透传 |
| `session.create` 走 `POST /api/session.create`，可通过 `connection.rpc.intercept('/api', matcher, handler)` 认领端点（Typert 网关先例） | `apiproxy/src/api-proxy.ts:2107-2108`；`connection/src/rpc-host.ts:117-141`；`packages/api/gateway/src/index.ts:105-111` | 「浏览器会话 ↔ 平台身份」绑定可在插件内完成，不改 dsh 源码 |
| 元冰可 HTTP 是自研 `HttpServerService`（路由/中间件/静态/spa fallback 完整），请求入口收敛于 `dispatch(req,res)` | `packages/platform-core/src/http.ts:62-260` | 单进程挂载 = 抽出请求入口挂到 dsh webServer 前缀路由，改动面小 |
| 控制台 SPA 全部 API 调用收敛于 `api.js request()`，静态引用在 index.html 为绝对路径 | `packages/plugin-console/public/js/api.js:64-86`；`public/index.html` | base-path 改造点集中（api.js + index.html），一次性可控 |
| OIDC Provider 完整（授权码+PKCE+JWKS+discovery），但 `OidcClientRecord.refType` 仅 `'app'`；生命周期联动只听 App 事件；上线门禁 `APP_SSO_ENFORCE` 只覆盖 app | `plugin-authn/src/oidc.ts:48-50,154-169`；`plugin-app/src/index.ts:125-135` | OIDC-agent 一步到位 = 三处对等扩展（关联+联动+门禁），全部在本仓库 |
| entry-ticket 已有（一次性、120s、fragment 不进服务端日志、redeem 返回身份 JSON 不返令牌） | `plugin-authn/src/entry-ticket.ts`；console:2580-2651 | 免登通道复用；补「兑换→绑定 Cookie→（可选）短时令牌」一跳 |
| dsh 源码树在本机 `D:\DSH\deepseek-harness`（rc.7，master，vendor/cordis 在位）；`~/.dsh` 已配置 | 本机实测 | 阶段一联调无需额外准备 |
| 部署参考机 192.168.0.7:7300（独立形态）；门户 192.168.0.4:8092 走 plugin-portal 6 个公开只读端点 | `docs/agent-onboarding.md:10`；`docs/portal-integration.md` | 单入口后门户/控制台跳转目标域名端口统一为 dsh web |

---

## 一、目标与非目标

**目标**

1. **单进程单入口**：dsh web 进程（cordis fiber）内同时承载——dsh 宿主（会话/ToolRuntime/技能）、
   元冰可平台数据面（全部 `/api/*` REST、控制台 SPA、`/docs`、`/mcp`），一个端口对外。
   独立进程形态（`node src/main.ts`）保留为开发形态，行为不回退。
2. **dsh Agent 资产登记自动化**：一条命令完成 Agent 注册 → 机器凭证落盘（0600）→ OIDC 客户端签发
   → entryUrl/metrics 提报 → 试运行/上线审批材料就绪；登记产物被平台治理闭环覆盖（L4 审批、审计、计量）。
3. **身份打通**：
   - 控制台/门户「打开交互界面」→ entry-ticket → dsh web **免登即用**（无感知，无二次登录）；
   - 直接打开 dsh web 未登录 → 302 平台 OIDC 授权页 → 登录回跳建立会话（标准授权码 + PKCE）；
   - OIDC 客户端与 Agent 资产关联（refType='agent'）：owner 自助签发、下线联动禁用、上线门禁覆盖；
   - 会话绑定：dsh 会话 ↔ 平台用户身份，NAS 文件网关调用按 P0-2 红线注入 `X-On-Behalf-User`，
     平台侧操作留痕归因到人。
4. **前端统一**：控制台（管理面）与 dsh web（业务面）同源同端口；门户卡片、控制台 Agent 卡片
   的直达入口统一指向单入口地址。

**非目标（本期不做）**

- 不给 dsh 自有 `/api/*`（session/settings/credentials 等）加鉴权——dsh 明确"fence is not auth"，
  本期仅同源化收敛暴露面 + 文档声明残余风险；`/api` 全量门禁化列为后续 hardening 迭代
  （候选机制 `connection.rpc.intercept` + cookie 校验，需上游配合验证）。
- 不做 OIDC client_credentials/password grant（机器身份继续走平台自有 client-credentials 通道）。
- 不改 dsh 前端源码、不改 `session.create` schema（会话级 user 字段；用插件侧绑定表替代）。
- 不迁移管理面数据存储、不动计量/资金链路。

---

## 二、总体设计

### 2.0 目标架构（单进程单入口）

```
浏览器 / 门户 / 控制台
        │  单一入口 http://<host>:3080
        ▼
┌─────────────────────── dsh web 进程（cordis fiber）───────────────────────┐
│  ctx.webServer（node:http，唯一 listener）                                  │
│   ├─ /api/*            dsh client-connection（既有，不动）                   │
│   ├─ /plugins/*        dsh client modules（既有，不动）                      │
│   ├─ /auth/entry       [新] plugin-dsh-bridge：ticket 兑换→Set-Cookie→302 / │
│   ├─ /auth/oidc/*      [新] plugin-dsh-bridge：OIDC 回跳→换码→Set-Cookie    │
│   ├─ /rq/*             [新] plugin-dsh-bridge：前缀剥离→元冰可数据面           │
│   │    ├─ /rq/api/*        全部平台 REST（复用现有路由，原 /api 语义不变）    │
│   │    ├─ /rq/console/     控制台 SPA（base-path 感知）                      │
│   │    ├─ /rq/docs         文档静态                                          │
│   │    └─ /rq/mcp          MCP 端点                                          │
│   ├─ /（fallback）     dsh web 前端（tapIndex 注入免登引导脚本）              │
│  ctx.tools（共享接缝）  平台 37+ 运维工具 ↔ dsh 原生 ToolRuntime              │
│  [新] IdentityBindingService：cookie↔身份、sessionId↔身份 绑定存储           │
│  [新] session.create 拦截：建立 会话→身份 绑定                               │
│  plugin-nas 工具出站：按绑定注入 X-On-Behalf-User（standalone 形态行为不变）  │
└──────────────────────────────────────────────────────────────────────────┘
                    │ 共享 data/ 目录（同进程内即同份数据，无需双进程）
                    ▼
              元冰可插件树（iam/authn/agent/app/nas/… 全量，console+portal 首次进入 dsh 形态）
```

### 2.1 关键决策映射

| 决策 | 技术路径 |
|---|---|
| ① dsh web 自带 UI + 自然免登 | 免登引导走两层：控制台跳转带 `?entry_ticket=`（`/auth/entry` 服务器侧兑换，Set-Cookie 后 302 `/`，最自然）+ tapIndex 注入 fragment 引导脚本兜底（兼容既有 `#entry_ticket` 契约）。未登录访问由浏览器半插件触发 OIDC 跳转。dsh 前端零改动。 |
| ② OIDC-agent 一步到位 | `plugin-authn/oidc.ts` refType 扩展 `'app'|'agent'`：`createSsoClient` agent 版（owner 自助）、AgentOnlined/Offlined 生命周期联动、`AGENT_SSO_ENFORCE` 上线门禁（对齐 `APP_SSO_ENFORCE`）、控制台 Agent 详情页 SSO 配置 tab、`/oauth/authorize` 授权页复用。 |
| ③ 单进程单入口 | platform-core 暴露 `handleRequest(req,res)`（现 `dispatch` 收敛入口）；新增 `plugin-dsh-bridge`（`inject:['webServer','httpServer']`，仅 dsh 形态挂载）注册 `/rq` 前缀路由 + URL 前缀剥离 + `/rq`→`/rq/` 302；控制台 SPA base-path 感知（api.js 统一 BASE + index.html 相对引用 + html 响应时注入 `<base>` 兜底）。 |

### 2.2 身份模型（打通后的四条通道归一）

```
浏览器打开 dsh web
  ├─ 已有 rq_sid Cookie ──► IdentityBindingService 查得身份 ──► 直接进入（自然免登态）
  ├─ URL 带 entry_ticket（query 或 fragment）
  │     └─► /auth/entry（或引导脚本 POST /rq/api/authn/dsh-bridge/bind）
  │          └─► 平台 EntryTicketService.redeem（一次性、实时校验账号状态、双向审计）
  │               └─► Set-Cookie rq_sid（httpOnly、SameSite=Lax）──► 302 /
  └─ 未登录直开 ──► 302 /oauth/authorize（agent 关联 OIDC 客户端，PKCE）
        └─► 平台授权页（本地口令/钉钉扫码）──► /auth/oidc/callback 换码 ──► Set-Cookie ──► /

会话绑定：session.create 拦截 ──► sessionBindings[sessionId] = { userId, orgId, roles, ts }
工具出站（NAS 等）：exec.agent.session.id ──► 绑定表 ──► X-On-Behalf-User: <userId>
```

Cookie 会话复用平台 refresh 语义：rq_sid 存平台 refresh 凭据（服务端关联），过期静默续期；
账号冻结/离职实时失效（兑换与续期均走平台实时校验）。**不发放**可直调平台 REST 的长期 Bearer——
浏览器对平台数据面的调用仍走控制台既有 Bearer 流程（登录页/OIDC 会话内签发），rq_sid 只作
dsh web 侧身份绑定与审计归因，权限面最小化。

---

## 三、阶段一：单进程单入口（本计划的结构地基）

**改动点（全部在 D:\DSH-RQ）**

1. `platform-core/src/http.ts`：`dispatch` 收敛为公开 `handleRequest(req,res)`；`start()` 不变。
2. 新增 `packages/plugin-dsh-bridge/src/index.ts`（阶段一先做挂载半，身份半见阶段三/四）：
   - `inject: ['webServer','httpServer']`，Config `{ mountPath: '/rq' }`；
   - `webServer.register({kind:'prefix', path:'/rq', handler})`：剥离 `/rq` 前缀后调
     `httpServer.handleRequest`（req.url 原位改写）；`/rq` 精确命中 302 `/rq/`；
   - 控制台 index.html 响应时注入 `window.__RQ_BASE__='/rq'`（字符串替换一次，做法对齐
     dsh `injectBootManifest` 的 tapIndex 语义，但发生在自己前缀内、不占用全局 tap）。
3. 控制台 SPA base-path 感知：
   - `public/js/api.js`：`const BASE = window.__RQ_BASE__ ?? ''`，`fetch(BASE + path)`；
     `PUBLIC_TOKEN_PATHS` 等路径判断同步适配；
   - `public/index.html`：静态引用改相对路径（`css/base.css`、`js/app.js`、`ybk-mark.png`）；
   - 全量排查其余绝对引用（`fetch(`/`EventSource`/`window.open`/`href="/`/下载链接）。
4. `cordis.yml`（源码模式 overlay）：insert 追加 `portal`（先）与 `console`（后）与
   `dsh-bridge`（最后）；platform-core 配置保持 `startHttp:false, provideToolRuntime:false`。
   `cordis.patch.yml`（安装模式）同步。
5. selftest：新增「挂载适配」断言组——伪造 webServer 形状对象，验证前缀剥离/302/静态/SPA 回退/
   `/rq/api` 路由等价性；既有 684 断言必须全数通过（standalone 形态零行为变化）。

**验收**

- `npm run selftest` 684+ 全通过；
- 联调：`pnpm dsh web --patch cordis.yml` 起宿主后，`:3080/` 为 dsh UI、`:3080/rq/` 为控制台、
  `:3080/rq/api/overview` 可用、dsh 会话内运维工具可调用；
- 独立形态 `node src/main.ts` 行为不变（回归）。

---

## 四、阶段二：dsh Agent 资产登记自动化

**改动点**

1. 新增 `scripts/register-dsh-agent.mjs`：对平台（`DSHCTL_URL`/管理员或资源管理员凭证）执行
   agent-onboarding 全流程——注册（幂等：已存在则复用）、机器凭证写 `data/dsh-agent-credential.json`
   （0600，secret 不入 git）、`PATCH attrs`（entryUrl=`http://<单入口>:3080/`、systemPromptVersion、
   dataClass）、首次 `metrics-report`、（阶段三后）签发 agent 关联 OIDC 客户端
   （redirect_uri=`http://<单入口>:3080/auth/oidc/callback`）、`submit_trial` 材料输出。
2. `docs/agent-onboarding.md` 追加「平台自营 dsh Agent」小节（指向脚本 + 人工审批步骤）。
3. 凭证交接：dsh 侧后续可切 `plugin-connect` enroll 流（接入码换凭证），本期脚本直写 + 文档声明。

**验收**：脚本幂等重跑无副作用；平台侧 `dshctl agent get` 各治理字段齐备；审计含
`agent.register/agent.metrics.report` 记录。

---

## 五、阶段三：身份打通（OIDC-agent 一步到位 + 会话绑定）

1. **refType 扩展**（`plugin-authn/src/oidc.ts`）：`OidcClientRecord.refType: 'app'|'agent'`；
   `clientsForApp` → 泛化 `clientsForRef(refType, refId)`；`createSsoClient` 支持 agent
   （授权校验 = agent owner 或 `authn.oidc.write`）；PKCE/白名单/发现文档全部不变。
2. **生命周期联动**：authn 监听 `AgentOnlined/AgentOfflined/AgentArchived` → 启用/禁用/禁删
   关联客户端（对齐 App 侧 154-169 现状）。
3. **上线门禁**：`plugin-agent` 状态机 `submit_online` guard 增加「身份纳管检查」——存在关联
   OIDC 客户端或 entryUrl 免登通道验证记录；`AGENT_SSO_ENFORCE=1` 时缺纳管直接拒绝审批
   （对齐 plugin-app:125-135 语义，含执行期复核）。
4. **会话绑定与出站身份**（`plugin-dsh-bridge` 身份半）：
   - `IdentityBindingService`：`rq_sid → identity`（TTL=平台 refresh 语义）+
     `sessionBindings: sessionId → identity`（LRU + 过期）；
   - `connection.rpc.intercept('/api', session.create 匹配)`：从 Cookie 解 rq_sid → 建绑定；
     未绑定会话标记 anonymous（工具侧按现状放行，仅无归因）；
   - `plugin-nas` 工具出站：ctx 存在绑定服务时按 `exec.agent.session.id` 注入
     `X-On-Behalf-User`（standalone 形态无此服务，行为不变，P0-2 红线语义不变）。
5. **短时令牌（备选，视联调裁剪）**：`/rq/api/authn/dsh-bridge/user-token`——rq_sid 换
   人机交集 scopes 的 15min 令牌（复用 `issueOnBehalfOf` 交集逻辑），供 Agent 后端代用户
   回调平台 REST；默认关闭 `DSH_BRIDGE_USER_TOKEN=1` 开启。
6. **控制台 UI**：`agents.js` 详情页加「SSO 配置」区块（签发/重置 secret/redirect_uri 编辑/
   状态），`authn.js` OIDC 客户端列表标注 refType。

**验收**：selftest 新增——agent 关联客户端签发/联动禁用/门禁拒绝/兑换绑定/绑定过期/
NAS 注入头（绑定存在）/standalone 不注入（无绑定服务）断言组。

---

## 六、阶段四：dsh web UI 免登与入口统一

1. `/auth/entry?ticket=` 兑换路由 + tapIndex fragment 引导脚本（读 `location.hash` →
   同源 POST bind → 清 hash → reload），两者共用 bind 逻辑；
2. 浏览器半插件（`dsh.client` 声明，照 ui-auth 范本）：未绑定态在 dsh UI 显示
   「使用平台账号登录」浮层 → OIDC 跳转；已绑定显示用户名（RPC `/dsh-bridge/status`，
   `authority:'loopback'|'trusted-host'`）；
3. 控制台/门户直达入口：`openAgentEntry` 保持 `entryUrl#entry_ticket=` 契约（fragment 不进
   服务端日志），dsh 侧引导脚本承接；`entryUrl` 登记值切到单入口 `:3080/`；
4. 部署文档：`docs/deploy-enterprise.md` 重写为单进程形态（含 `--trusted-host`、
   `webserver host` patch 覆盖为 `0.0.0.0` 的安全声明——见 §七）。

**验收**：控制台点「打开交互界面」→ dsh UI 免登即用，NAS 工具操作在平台审计归因到登录人；
清 Cookie 直开 dsh UI → 一次 OIDC 登录 → 持久会话。

---

## 七、风险与安全边界

| 风险 | 处置 |
|---|---|
| dsh 自有 `/api/*` 无认证（会话/设置/凭证面），单入口绑定 0.0.0.0 后暴露面从本机扩到局域网 | 本期：同源化收敛（多数入口收敛到 3080 一个端口）+ 文档明示；dsh webserver host 覆盖 `0.0.0.0` 需 patch 直写（绕过 CLI 拒绝）并在部署文档标注残余风险与内网信任前提；hardening 迭代（`/api` 全量 cookie 门禁）列入 §一非目标的后续项 |
| rq_sid Cookie 泄露 = 身份冒用 | httpOnly + SameSite=Lax + 绑定表服务端 TTL + 实时账号状态校验；不发放长期 Bearer |
| OIDC secret 落 dsh 侧 | 仅存 bridge 插件 data 目录（0600），丢失走平台轮换；redirect_uri 白名单强制 |
| `/api` 前缀冲突、fallback 席位冲突 | 已核实（重复注册 throw），元冰可一律 `/rq` 前缀 + 前缀内自管静态 |
| 计量双计 | 沿用红线：经宿主 ToolRuntime/网关自动归集，禁止手动重复推送 |
| cordis 双实例 | junction 方向固化为部署文档一步（vendor/cordis → 本项目 node_modules），启动脚本内置校验 |
| 上游 dsh 升级 | 全部走插件挂载面（register/tapIndex/rpc.handle/intercept/client 插件），零源码 fork；rc.7 接口已逐一核实 |

---

## 八、实施顺序与里程碑

```
M1 阶段一（挂载）     platform-core handleRequest + dsh-bridge 挂载半 + SPA base-path + cordis.yml + selftest   ✅ 2026-09-02
M2 阶段三-A（OIDC）   refType/生命周期/门禁/控制台 UI（纯平台侧，可先行）                                          ✅ 2026-09-02
M3 阶段二（登记）     register-dsh-agent.mjs（依赖 M2 的客户端签发）                                              ✅ 2026-09-02
M4 阶段三-B（绑定）   IdentityBindingService + 会话绑定 + NAS 出站注入                                            ✅ 2026-09-02
                      （实施修正：dsh rc.7 的 /api 拦截器不向 handler 暴露 Cookie——
                       会话绑定改走自有前缀路由 /dsh-bridge/bind-session，由引导脚本显式调用）
M5 阶段四（免登 UI）  /auth/entry + 引导脚本 + OIDC 授权码通道（start/callback PKCE）+ 部署文档                    ✅ 2026-09-02
                      （浏览器半插件「登录态 UI 显示」降为后续迭代：免登/登录链路已闭环）
每步交付物 commit 并推送本项目主仓（RQ-DSH main），selftest 全绿为准。
落地验证：selftest 721/721；真实 dsh 宿主冒烟（127.0.0.1:3080 单端口承载 dsh UI + /rq/* 全数据面）；
register-dsh-agent.mjs 隔离实例端到端（首跑/幂等重跑/门禁放行）。
后续迭代（非阻塞）：dsh /api 全量 cookie 门禁（hardening）；浏览器半插件登录态 UI；多用户并发会话归因精确化。
```
