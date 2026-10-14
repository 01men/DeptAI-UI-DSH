# 宿主平台相关功能差异 · 交接清单（custom/dsh-rq → 上游 main）

> 目标读者：负责 ybkkasi 主分支（main）的开发 Agent。
> 目标：把定制分支 `custom/dsh-rq` 上**宿主平台相关**的功能差异移植/推送到 main。
> 生成时间：2026-09-07；对比基点见下。

## 0. 分支状态与移植总策略

| 项 | 值 |
|---|---|
| 合并基点（共同祖先） | `229ce59`（连接器定时自动同步 + 全员名册） |
| 定制分支独有提交 | 24 个（含 2 个 merge 提交、治理与文档提交） |
| 上游 main 新提交（定制分支还没有） | 7 个：e8c0421 产品落地页、54d0414 skill 包替换、aacc5f6 技能下载鉴权+登录页钉钉扫码、4bcde8e onboarding 模块化+OIDC promptConsent、c005db9/4aea848/e5a6f0e nas-authz |

**移植方式**：不要整体 merge（双向分叉 24:7，且定制分支的治理铁律禁止反向合并）。
按本文档的功能域，以 **cherry-pick 功能提交 + 在 main 最新代码上重放修改型 diff** 结合的方式落地。
重点：`plugin-authn/src/oidc.ts` 与 `plugin-portal/src/index.ts`、`plugin-console/public/js/pages/login.js`
在上游 4bcde8e/aacc5f6 已被修改过，**必须以 main 版本为底座重新施加改动**，不能整文件覆盖。

**建议落地顺序**：A 底座 → B 宿主桥/身份 → C 控制台入口面 → D 面板/会话注入 → E 脚本/装配 → 每步跑 `npm run selftest && npm run lint:manifests`。
定制分支 selftest 当前 913 项全绿，可作为移植后的行为对照（main 基线 700+ 项，移植会净增约 200 项断言）。

---

## A. 平台底座改动（所有宿主功能的前置依赖，必须先落）

来源提交：7fa29b5(M1)、c6a0cd8、74841d8、9b96522、91a9e74（跨提交累积）

| 文件 | 改动 | 说明 |
|---|---|---|
| `packages/platform-core/src/http.ts` | +64 | ① `HttpServerConfig.externalBase`（挂载前缀 '/rq'，根绝对路径构造自洽）；② `corsAllowOrigins` + 纯函数 `corsAllowOriginFor()`（数据面 CORS，只覆盖 /api/*，豁免 /api/portal/ 与 /api/authn/oidc/，OPTIONS 预检先于鉴权中间件，Vary: Origin）；③ `dispatch()` 由 private 改 public（挂载形态由 dsh webServer 剥前缀后调用）；④ `routeMatrix` 共享登记处（插件自注册路由必须推入，保住 selftest RBAC 100% 越权断言网） |
| `packages/platform-core/src/bus.ts` | +13 | PlatformEvents 新增：`behavior.recorded`、`panel.message.created`、`panel.card.action`、`panel.task.updated`、`panel.industry.activated`、`scenegraph.updated`、`dingtalk-bridge.delivered`；保留命名空间扩 `behavior./panel./scenegraph./dingtalk-bridge.` |
| `packages/platform-core/src/storage.ts` | +20 | 信号落盘钩子 `installSignalFlush()`：SIGTERM/SIGINT → flushNow（form B 挂载进 dsh 后无 main.ts 的等价钩子，防抖窗口写入会丢；幂等双注册，与 form A 并存） |
| `packages/platform-core/src/index.ts` | +19/-3 | 装配 Behavior/Cardpack/Scenegraph 服务；`http.externalBase` 透传；`provideToolRuntime` 语义注释（挂载形态 false） |

## B. dsh 宿主桥与 Agent 身份打通（宿主核心，M1~M5）

设计全文：`docs/dev-plan-agent-host-unification.md`（+248，必读，随代码一起带过去）

| 功能 | 承载提交 | 文件 | 内容 |
|---|---|---|---|
| M1 单进程单入口 | 7fa29b5 | `packages/plugin-dsh-bridge/src/index.ts`（**全新包**） | 把元冰可数据面（REST/控制台 SPA/面板/docs/mcp）以 `/rq` 前缀挂进 dsh webServer；dsh web 端口即唯一入口 |
| M2 OIDC-agent 关联 | db72c39 | `packages/plugin-authn/src/oidc.ts`（+32/-10）、`packages/plugin-agent/src/index.ts`（+112） | oidc：refType 扩 `'agent'`、`clientsForAgent()`、Agent 上下线事件联动 enable/disable 客户端、issuer 与 webBase 带 externalBase 前缀。agent：`POST/PATCH /api/agents/:id/sso-client`、`POST .../sso-client/rotate` 签发/轮换/启停（owner 或 authn.oidc.write 授权）；`AGENT_SSO_ENFORCE=oidc` 上线门禁（上线前必须完成身份纳管）；inject 增 `oidc` |
| M3 一键登记脚本 | 569a7e6 | `scripts/register-dsh-agent.mjs`（**新增**） | 平台自营 dsh Agent 资产登记：注册/机器凭证落盘/OIDC 客户端签发，幂等可重跑 |
| M4/M5 身份绑定+免登+授权码通道 | e2fc09c、c6a0cd8 | `plugin-dsh-bridge/src/index.ts`（同包累积）、`plugin-console/src/index.ts`（`POST /api/auth/entry-ticket-session` 公开路径） | `/auth/entry` 票据免登；`/dsh-bridge/redeem\|status\|logout\|bind-session\|session`（Cookie→平台会话直通，同源收紧 fail-closed）；OIDC 授权码通道；tapIndex 免登脚本注入 |

## C. 控制台入口面（落地分诊 / 免登回跳 / 宿主连接切换）

| 功能 | 承载提交 | 文件 | 内容 |
|---|---|---|---|
| 统一入口与角色落地分诊 | c0fca1a | `packages/plugin-console/public/js/landing.js`（**新增**，纯函数）+ `landing.test.mjs`（node --test 随包单测）、`index.html`、`app.js`、`pages/login.js` | 管理员→控制台 / 业务员→面板的分诊规则定版；登录回跳 `?next=`（`heng_ops_next` 暂存 + `sanitizeNext` 白名单，仅放行本站相对路径）；宿主形态两处真缺陷修复 |
| 前端宿主服务连接切换 | 74841d8 | `public/js/connections.js`（**新增**，纯函数，storage 注入可测）+ `connections.test.mjs` + `pages/connections.js`（#/connections 页）、`api.js` | 控制台可手动配置/一键切换宿主数据面地址；api.js BASE 模块加载定刻；localStorage 三键（token/refresh/user）按连接命名空间隔离 |
| BASE 导入回归守卫 | 8ad3ddb | selftest 内静态断言 | 防「部门面板」NAV 点击 ReferenceError 无响应复发（app.js 不得从 api.js 具名导入 BASE 值） |
| OIDC 前端页适配 | e2fc09c | `pages/oauth.js`（M）、`oidc.ts` webBase() | 授权/登出/错误页 302 带 externalBase 前缀（挂载形态 /rq 自洽） |

⚠ 冲突预警：`pages/login.js` 与 `oidc.ts` 在上游 aacc5f6/4bcde8e 已有改动（钉钉扫码默认化、promptConsent 强制重授权）。移植时以 main 最新版为底座叠加本清单改动。

## D. 部门 Agent 工作台面板 + dsh 会话注入（宿主上的业务面）

设计/评审文档：`docs/review-dsh-agent-panel-v2.md`、`docs/panel-implementation.md`、`docs/spike-dsh-client-capability.md`、`docs/action-plan-dsh-frontend.md`、`docs/entry-switching.md`、`docs/frontend-host-switching.md`

| 功能 | 承载提交 | 文件 | 内容 |
|---|---|---|---|
| panel-core 全量 | 91a9e74 → ff8e275 | `packages/plugin-panel-core/**`（**全新包**：plugin.yaml、manifest/{api,events,permissions,ui}.yaml、src/{index,service}.ts、src/seed/*、public/ 零构建 SPA） | /panel 静态 + /api/panel/* REST（guarded+routeMatrix）；SSE `/api/panel/stream?token=` 自校验 + 30s 轮询降级；panelAgentRuntime（@Agent 唤起→modelgw 单轮，诚实降级转人工）；panel_* 工具族（dsh 下即原生 ToolRuntime）；行业激活审批执行器；**模型配置面（/api/panel/models 增删查+连通性测试）+ 对话框模型切换（messages 带 model，回包记录所用模型）**（ff8e275） |
| 面板底座 | 91a9e74 | `packages/platform-core/src/scenegraph.ts`（**新增**）、`scenegraphs/{qb01,gcjx}.json`、iam 权限点 `panel.read/panel.write/panel.task.write/panel.config.write/scenegraph.read/scenegraph.activate` 及角色矩阵扩展（`plugin-iam/src/index.ts` +15） | 场景图谱装载/校验 + 部门面板权限点进 RBAC 与内置角色 |
| 会话注入插件 | 04bd1a0(WP-01)、13358a9(WP-06) | `packages/plugin-rq-card/**`（**全新包**：build.mjs、lib/client.js 预构建、src/index.ts） | dsh.client 双面插件：会话四态执行卡 + 👍/👎 反馈。铁律：cordis.yml 条目必须写包名（require.resolve 按包元数据解析），启动前必须 `node packages/plugin-rq-card/build.mjs` 预构建，缺 bundle 宿主启动响亮抛错 |
| 效果回传管道 | c6a0cd8(WP-03) | `packages/platform-core/src/behavior.ts`（**新增**）、`plugin-usage/src/index.ts`（nonbillableUsage）、console `POST /api/usage/feedback`、portal inject `behavior` | dsh 会话行为埋点独立于计量管道（behavior.recorded），audit/看板订阅 |
| 独立形态装配 | 91a9e74、9b96522 | `src/boot-all.ts`（+7：装配 panelCore、dingtalkBridge） | REST 鉴权依赖 console 中间件先行，装配顺序：console → panel-core → dingtalk-bridge → dsh-bridge |

配套（面板功能依赖但非宿主专属，一并带走）：`plugin-dingtalk-bridge/**`（**全新包**，群桥/出向投递/审批推送，订阅 panel.message.created）。

## E. 装配与验证（宿主形态运行面）

| 文件 | 说明 |
|---|---|
| `cordis.yml` / `cordis.patch.yml` | 宿主形态装配清单：platform-core（provideToolRuntime=false、startHttp=false、http.externalBase=/rq）→ connect(client) → 业务插件 → console → panel-core → dingtalk-bridge → dsh-bridge(mountPath=/rq) → rq-card（包名条目）。用法：把本仓库 cordis 链接为 dsh 源码树 vendor/cordis 后 `pnpm dsh web --patch cordis.yml` |
| `scripts/verify-live-host.mjs`（**新增**） | live 宿主真实性验证：面板/桥接认证面 + 资产盘点（宿主形态验收工具） |
| `package.json` | `files`/`compatibility`（dsh >=0.1.0-rc.7，profiles: web）——DSH STORE 上架契约（663a8be），宿主生态相关 |
| selftest/tests | `tests/{full-chain-drill,walkthrough,morning-peak-entry,dingtalk-h5-smoke,dom-smoke}.mjs` + selftest 面板/桥接/免登分节（约 +200 项断言，移植后以此对照） |

## F. 明确不在本次移植范围（非宿主平台差异）

- WP-09~12 看板推广：platform-core `cardpacks.ts` + 5 个 cardpacks/*.json、console `pages/board.js`、`pages/register.js`、`asset-filters.js`、dashboard/approvals/assets/skills 页改动（纯平台业务功能，主分支可另行评估）
- 审批深化：audit 终审标记 + SLA 报表（+77）、mcp/app riskLevel 水印（WP-10）
- nas-authz、hermes-patch / synology-filestation-mcp integrations、产品文档类
- 仓库治理：AGENTS.md、PROJECT.md、`scripts/hooks/pre-push`、README/LICENSE、`.gitignore`（cordis.local.yml）、cli→examples 迁移

## 验收基线（移植完成的定义）

1. `npm run selftest` 全绿（main 700+ 项 + 本清单净增约 200 项；关键分节：宿主桥免登/会话直通/OIDC 通道、部门面板数据面/运行时/计量、模型目录面与对话框切换、宿主连接切换 CORS、统一入口落地分诊）。
2. `npm run lint:manifests` 全绿。
3. 宿主形态实测：`pnpm dsh web --patch cordis.yml` 单进程启动，/rq/panel 可用、票据免登与会话直通通过、`node scripts/verify-live-host.mjs` 通过。
