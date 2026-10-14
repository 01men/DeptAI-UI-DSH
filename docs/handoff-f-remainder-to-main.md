# F 域余量 · 受控回流清单（custom/dsh-rq → 上游 main · 第二批）

> 目标读者：ybkkasi main 开发 Agent。生成：2026-09-08（双轨改造 Phase 3 交付物）。
> 前置：宿主平台 A–E 域已于 2026-09 移植进 main；看板/卡片包域已由定制侧整体迁入
> `plugin-panel-core`（/panel 面），定制分支对上游的宿主面差异已收敛至本清单所列余量。
> 模板沿用 [handoff-host-features-to-main.md](handoff-host-features-to-main.md)。
> 闭环规则（[plan-dual-track-custom.md](plan-dual-track-custom.md) Phase 3）：主分支采纳 → 定制侧 merge 吸收；
> **不采纳 → 定制侧拆除该差异**（收敛优先，双方都不留长期分叉）。

## 0. 当前残余差异基线（对 main `ff1a8de` 实测）

```bash
git diff ff1a8de custom/dsh-rq --stat -- packages/   # 本清单全部内容
```

除下述功能余量外，其余差异均为**治理与布局类或定制自有面，不回流**：定制自有三包
（plugin-panel-core 含 cardpacks 域 / plugin-rq-card / plugin-dingtalk-bridge）与 scenegraphs、
AGENTS.md / PROJECT.md / docs/plan-*、tests 目录布局（scripts→tests 迁移，澄清第 8 条已定版）、
scripts/hooks/pre-push、package.json 的 selftest 路径与 dsh STORE 契约、examples/cli 布局。

## A. 审批深化（WP-10/L1：高风险二次确认 + 公司级终审 + SLA 看板）——建议采纳

| 文件 | 改动 |
|---|---|
| `packages/plugin-agent/src/index.ts` | +8：Agent 上线 L4 审批 riskLevel 统一标注 `high`（2 处，附注释） |
| `packages/plugin-audit/src/index.ts` | +78/-1：WP-10/L1 底座——`ApprovalRecord` 增 `riskLevel`/`finalReview` 字段；`decideApproval` 高风险通过强制二次确认（`confirmed`，服务端 fail-closed）并落公司级终审标记（审计 `approval.final_review` 可追溯）；`slaReport()` SLA 报表（≤2 个工作日达成率+逾期清单） |
| `packages/plugin-console/src/index.ts` | +69 中的审批部分：`POST /api/mcp/services/:id/final-review`（公司级终审标记端点）；`/api/approvals/sla`（SLA 达成率看板端点）；审批 decide 的 `confirmed` 强制二次确认（服务端 fail-closed） |

说明：`plugin-audit` 的 WP-10 底座此前**未移植进 main**（对 ff1a8de 实测为定制侧增量），采纳 A 时
须与 console 侧执行端点一并回流。
selftest 对照分节：`审批 SLA 与公司级终审（WP-10）`（tests/selftest.mjs）。
采纳方式：按文件 cherry-pick + main 底座重放；验收 = selftest 该分节全绿。

## B. 全员工作台最近调用（WP-04/A3）——建议采纳

| 文件 | 改动 |
|---|---|
| `packages/plugin-console/src/index.ts` | +69 中的 usage 部分：`GET /api/usage/recent`（登录人自身计量事件 ≤5 条自见，只读不跨人） |

依赖：无（usage 管道两侧一致）。selftest 对照：`usage 最近调用（WP-04/A3）` 分节。

## C. 五平台主题 + 钉钉 H5 降级 + 工作台联动（WP-05/B3 + WP-11 + dashboard 联动）——成组评估

| 文件 | 内容 | 依赖 |
|---|---|---|
| `packages/plugin-console/public/js/platform.js` | 平台主题回放（记忆平台免闪） | base.css 主题块 |
| `packages/plugin-console/public/css/base.css` | 五平台 `data-platform` 定版色块（+88） | — |
| `packages/plugin-console/public/js/app.js` | +17：主题回放启动 + 钉钉 webview 入口探测 + 登记引导 NAV | platform.js / register.js |
| `packages/plugin-console/public/js/realtime.js` | +132：钉钉 webview UA 探测降级链路（30s 轮询兜底） | — |
| `packages/plugin-console/public/js/pages/dashboard.js` | +126：场景卡片区 / 最近调用区 / 主题联动 | **见下方依赖警示** |
| `packages/plugin-console/public/js/pages/approvals.js`、`pages/assets.js` | 审批终审展示 / 目录筛选联动 | A / D |

⚠ **依赖警示（dashboard.js）**：场景卡片数据源已从 `/api/platform/card-packs`（main 无此端点）改为
`/api/panel/board`——该端点属于**定制面板数据面**（plugin-panel-core，非宿主面）。主分支如采纳
dashboard 改动，二选一：① 连同卡片包模型一并回流（platform-core 级 cardpacks.ts + cardpacks/*.json +
下发端点，即原 WP-05/B1 全量，main 侧此前未移植）；② 不采纳 dashboard 卡片区块，仅采纳其余部分。
定制侧建议：**暂缓**，待主分支对卡片包域是否有宿主面诉求表态后一并决策。

## D. 目录筛选 + 资产登记引导（WP-12 + WP-08）——运营向，主分支自行取舍

| 文件 | 内容 |
|---|---|
| `packages/plugin-console/public/js/asset-filters.js` | 纯函数目录筛选（类型/平台/关键词，1000 项 <50ms 有性能断言） |
| `packages/plugin-console/public/js/pages/assets.js` | 资产目录接筛选（+86） |
| `packages/plugin-console/public/js/pages/register.js` | 资产登记引导页（六磁贴分诊 + 描述 embedding 规范预检，+149） |

不采纳则定制侧拆除对应页面与 NAV（不留分叉）。

## E. 测试资产（随对应功能域决策）

| 文件 | 随迁域 |
|---|---|
| `tests/selftest.mjs` 对应分节 | A/B/C/D 各分节随功能域一并搬（main 侧 scripts/selftest.mjs 布局） |
| `tests/walkthrough.mjs`、`tests/dingtalk-h5-smoke.mjs` | C（钉钉 H5 降级）——澄清第 7 条既定口径 |
| `tests/dom-smoke.mjs`、`tests/full-chain-drill.mjs`、`tests/morning-peak-entry.mjs` | 布局随 tests/ 迁移（澄清第 8 条：行为等价，不强制） |

## F. mcp/app riskLevel 水印（WP-10/L1）——建议采纳

| 文件 | 改动 |
|---|---|
| `packages/plugin-app/src/index.ts` | +4：应用上/下线 L4 审批统一标注 `riskLevel: 'high'`（2 处，附注释） |
| `packages/plugin-mcp/src/index.ts` | +5：`McpServiceRecord` 增 `finalReview` 终审标记字段；`McpCallRecord` 增调用水印字段——终审服务的全部调用附 `watermark`，审计可追溯 |

依赖：A 的 `plugin-audit` 底座（`finalReview` 标记来源）。任何宿主部署都受益（双轨计划 §3 评估口径倾向采纳）。
selftest 对照：`审批 SLA 与公司级终审（WP-10）` 分节水印断言。

## G. 远程 dsh 人类登录闭环 + 模型流式（dsh 插件化充分落地，2026-09-08）——建议采纳

定制侧已完成「装好插件即可用」的连接向导与对话打通（定版设计：[plan-dsh-plugin-first.md](plan-dsh-plugin-first.md)）：
免登 `/rqcard/*` 向导命名空间、LAN 扫描选宿主、账号密码经本机插件代理全闭环登录、dsh 会话
「元冰可工作台」视图 Tab 与面板「Agent 对话」双向内嵌、`panel_agent_invoke`/`panel_board_digest`
协作工具族。以下为**远程形态（C）钉钉扫码登录闭环**的宿主侧增强建议——不采纳也能用
（定制侧维持「跳宿主登录页 + 回导向导校验」降级），采纳后体验闭环：

| # | 文件（main 侧） | 改动 | 价值 |
|---|---|---|---|
| G1-a | `packages/plugin-console/src/index.ts`（登录页/登录成功路径） | 登录页支持可信 `next` 参数：完成登录（含钉钉扫码）后按 `next` 回跳，fragment 携带一次性自助 `entry_ticket`；需新增 `POST /api/auth/entry-tickets/self`（已登录人类为自己签发短时票据，进 PUBLIC_PATHS） | 远程 dsh 面板向导发起 `next=<本地面板地址>`，钉钉扫码后自动回到本机 dsh、票据兑换即建立会话——零手工回导 |
| G1-b | 同上（票据签发约束） | 自助票据 TTL ≤120s，复用 authn EntryTicket 既有一次性/防重放语义；`authn.entryticket.redeemed` 审计留痕 | 防票据扩散；审计闭环 |
| G2（可选） | `packages/plugin-modelgw/src/index.ts` | `invoke` 增 `stream` 变体（SSE，OpenAI 兼容流式透传） | 面板内置协作会话与 dsh 侧富卡可升级流式输出（非必须；现状单轮非流式诚实工作） |
| G3 | dsh 侧 `vendor/loader`（或 main 侧预构建分发） | 拷贝安装形态（`dsh plugin add github:`，pnpm 装入 node_modules）下 Node（≥22.6）拒绝类型剥离 node_modules 内 TS（实测 `--experimental-transform-types` 亦不解除）——全部 `src/index.ts` 形式 loader entry 不可执行，**全仓架构级**限制。解法二选一：① dsh loader 在 import 前自行剥离 TS（vendor/loader Entry._init 预处理）；② 平台提供预构建分发（构建 JS 镜像 + 指向 .js 的安装补丁）。定制侧已实证：源码/链接形态（`link:` 安装，真实路径在 node_modules 外）完整体验 8/8 绿 | 「全新 dsh 拷贝安装完整体验」的最后一公里；定制侧根包已补 `@dsh-ops/plugin-rq-card` file: 依赖使包名在安装形态可解析（该修复与 G3 无关、始终需要） |

定制侧对照降级路径已实现（2026-09-08）：向导打开宿主登录页**已携带** `?next=<本机面板绝对地址>`（G1 前向兼容，
未采纳宿主按防 open redirect 白名单忽略、无害）；boot.js 已按连接形态经代理兑换回跳票据（query/fragment 双形态、
会话落连接作用域）——**G1 采纳即闭环，定制侧零后续改动**；未采纳期向导提供「我已完成扫码」回导校验诚实降级
（proxy `/api/auth/me`：本机有有效会话即进工作台，无则如实说明并导向账号密码登录）。同批修复：探活严格判据
（独立宿主 SPA 兜底 200 HTML 不再误判挂载前缀）、代理对宿主 HTML 响应显式 502、api.js 代理请求补向导头
（形态 C 数据面防线内通行）、实时轮询远端代理映射。
selftest 对照：`宿主连接向导` 分节（50 项，含向导 jsdom DOM 全链与 G1 回跳闭环回归）+ `panel_agent_invoke/board_digest`（4 项）+ `fresh-install 装机模拟`（13 项）。

## H. README「装好插件即可用」定制文档段（2026-09-08）——随整包同步取舍

| 文件 | 内容 |
|---|---|
| `README.md`（+33） | 「装好插件即可用（fresh-install 体验）」节：向导首启与形态 B/C 体验说明、`/rqcard/*` 免登命名空间三道防线、对话与看板双向打通、装机铁律与装机形态边界（对应 G3）——内容描述的是定制面功能，落在宿主面 README 上 |

归属建议：宿主侧文档「遗留 1」的整包同步时随包采纳；不采纳则定制侧把该节移入
`docs/plan-dsh-plugin-first.md` 并还原 README（收敛检查红项清零）。

## I. 「01门」改名装配漂移（plan-gate01 Phase 1，2026-09-10）——宿主面受控值改动

本分支产品收缩为「01门」（AI 代理与人类的协作前台，定义见 docs/plan-gate01.md），根包改名
`dsh-enterprise-ops` → `@ybkk/gate-01`、定制包 scope `@dsh-ops/*` → `@ybkk/*`（仅定制三包）、
挂载前缀 `/rq` → `/gate01`。由此产生以下**宿主面文件受控漂移**（全部为值/装配改动，零逻辑改动），
主分支侧按「采纳/不采纳」定性；不采纳时定制侧在收敛检查中拆除或豁免登记：

| 文件 | 改动 | 定性说明 |
|---|---|---|
| `packages/platform-core/src/version.ts:12` | `PLATFORM_PACKAGE` 值 `'dsh-enterprise-ops'` → `'@ybkk/gate-01'`（+注释） | 运行期向上解析仓库根的判据，必须跟随根包名，否则版本定位/自更新根目录错乱。宿主面唯一源码值改动 |
| `src/boot-all.ts:26-27` | panel-core / dingtalk-bridge 两行 import scope `@dsh-ops` → `@01men` | 跟随定制包改名，其余 18 行宿主面包 import 不动 |
| `cordis.yml` | `externalBase`/`mountPath` `/rq` → `/gate01`；rq-card entry name → `@ybkk/plugin-rq-card` | 装配配置跟随产品挂载前缀与包名 |
| `cordis.patch.yml` | 同上 + 全部 entry 前缀 `dsh-enterprise-ops/` → `@ybkk/gate-01/` | 同上（patch 收缩为 4×dist 见 plan-gate01 Phase 3，另行登记） |
| 根 `package.json` | name → `@ybkk/gate-01`；dependencies 键 → `@ybkk/plugin-rq-card` | 定制分支产品定义，**不回流**（main 的根包名由 main 侧自定） |

配套：rq-card 数据文件 `rq-host-link.json` → `gate01-host-link.json`（定制面，不回流）；
panel SPA localStorage 键 `heng_ops_*` → `gate01_*`（panel 定制面；**console 的 `heng_ops_*` 未动**）；
`probeHub` 探测序列 `['/gate01','/rq','']`（兼容宿主轨 `/rq` 与 01门 `/gate01` 两种挂载形态）。
selftest 装机段已同步适配（前缀解析/双 scope 正则/防泄露探针/dist 新鲜度断言）。

## J. plan-gate01 Phase 3 追加漂移（2026-09-10，真机实装实证后修订）

| 文件 | 改动 | 定性说明 |
|---|---|---|
| `packages/plugin-dsh-bridge/src/index.ts:73` | inject 8 键 → 3 键（`[webServer, httpServer, opsStorage]`） | 宿主轨全量形态 8 键全在、行为不变；01门 4-entry 装配下 entryTickets/oidc/iam/authn/audit 无提供者，声明=永久挂起。运行期访问本为防御式可选语义，已全部改 `ctx.reflect.get(key,false)`（含 entryTickets/oidc/iam/authn/audit 五点——形状断言 `(ctx as {k?}).k` 防不了 cordis get trap 的「未声明即抛」，真机 boot 实证） |
| `packages/plugin-rq-card/src/tool.ts`（新增） | defineTool + 最小类型面内联（复制自 platform-core/src/tools-lite.ts） | rq-card 是独立 npm 包（client-modules 包名要求），安装位置无 packages/* 兄弟目录，跨包相对值导入必然 ERR_MODULE_NOT_FOUND（真机实装实证）。副本漂移，上游 merge 后 diff 核对 |
| 根 `package.json` files | 精确闭包 `[cordis.patch.yml, packages/platform-core, packages/plugin-dsh-bridge, packages/plugin-panel-core, packages/plugin-rq-card, README.md, LICENSE]` | plan-gate01 原稿清单漏列 plugin-dsh-bridge（4 entry 却列 3 包），真机实装暴露后修正 |
| `packages/plugin-rq-card/package.json` exports | `.` → `./dist/index.js` | 两形态统一包名，build:dist 入开发重建仪式（selftest dist 新鲜度断言覆盖） |

## K. 紧急缺陷修复漂移（2026-09-10 晚，真机运行期实证）——建议 main 尽快采纳

| 文件 | 改动 | 说明 |
|---|---|---|
| `packages/platform-core/src/http.ts`（`file()`） | 补 `res.headersSent` 幂等守卫（与同文件 `ok`/`fail` 同款） | `file()` 方法体运行在异步 IIFE 中，双写路径下二次 `writeHead` 抛 `ERR_HTTP_HEADERS_SENT` 且无人接——以 uncaughtException 打死整个宿主进程（gate01-smoke 真机运行期崩溃实证，栈=dist/http.js:228）。`ok`/`fail` 已有守卫，`file` 是遗漏点 |

## Q. 品牌与仓库更名（2026-10-14）——纯文案替换，零逻辑改动

全仓品牌口径随上游改名收敛（决策凭据：`docs/rebrand-yuanbingke-20261014.md`）：品牌中文名「元冰可」、
英文 `Yuanbingke`、宿主仓库切至 `01men/ybkkasi`、品牌位图换为 `ybk-mark.png`、
版权主体 → 杭州元冰可科技有限公司。上游侧已先行同批切换（commit `894137b`），本仓库措辞以上游为准。

涉及宿主机区文件的改动**全部为字符串替换**（品牌名/仓库地址/版权行），零逻辑与装配语义变化：

| 文件 | 改动 | 定性说明 |
|---|---|---|
| `packages/plugin-console/src/index.ts`、`src/routes/finops.ts` | 品牌串（控制台名、MCP serverInfo title/instructions、`/docs` 页标题与正文、FinOps 报表头） | 与 main 同口径，上游已同形替换 |
| `packages/plugin-console/public/**` | 控制台 SPA 品牌串 + 位图引用改名（换为 `ybk-mark.png`，位图随上游现行官方标） | 同上；位图文件为二进制替换 |
| `packages/plugin-dsh-bridge/src/index.ts`、`packages/plugin-usage/src/index.ts`、`packages/plugin-modelgw/src/index.ts` | 注释中的品牌串 | 纯注释 |
| `packages/plugin-agent/src/onboarding.ts`、`packages/plugin-app/src/onboarding.ts` | 注释中的外部技能名 → `hermes asset-push`（去品牌化，与上游一致，不臆造重命名） | 纯注释 |
| `packages/plugin-iam/src/index.ts`、`packages/plugin-console/src/seed.ts`、`packages/plugin-panel-core/src/index.ts` | 演示组织名「元冰可集团」（随上游：main 侧 seed 已同为「元冰可集团」） | 演示数据，与 main 同口径 |
| `scripts/hooks/pre-push`、`.github/workflows/selftest.yml` | 上游仓库名哨兵/标题 | 定制侧治理资产 |

**不回流项**：根 `package.json`（`@ybkk/gate-01` 已发布包名与 `repository` 指向 RQ-DSH）、
`README.md`/`llms.txt`/`产品.html`（定制轨对外口径）、`AGENTS.md`/`PROJECT.md`（治理文档）、
npm scope `@ybkk/*`（装配契约，改名即装机破裂，另行决策）。

验证：`npm run build:dist`（dist build-id `e5921e9691177d27`）+ `node packages/plugin-rq-card/build.mjs`
+ `npm run selftest`（1322/1322 绿）+ `npm run lint:manifests`（105/105 绿）。

## 闭环记录（2026-09-10，main 侧回执 `handoff-f-remainder-adoption-20260910.md` ＋ 定制侧吸收）

- **main 实施提交**：`7f5f3ea`（本地，push 前夕）——A/B/D/F/G1/J/K 采纳落地，selftest 978 绿。
- **定制侧吸收**：merge 7f5f3ea（冲突 3 文件：console app.js/dashboard.js 取 main；tests/selftest.mjs
  保留定制布局并移植 G1 自助票分节 5 断言）。C 部分采纳中的 dashboard 场景卡片区不采纳——
  **卡片包域表态：同意暂缓**（01门 装态 board 为演示面；全量形态场景卡片区随卡片包域专项另行回流）。
- **定制侧整改**：H README 已还原（定制文档段拆除）；E main 布局 selftest 未落地（rename 检测并入
  tests 冲突，tests/ 布局定版维持）；console PUBLIC_PATHS 格式损伤修复（main A 项点名）；base.css
  场景卡片死代码拆除；approvals.js 定制审批 kind 映射保留（豁免登记，定制面板域配套）。
- **收敛检查**：宿主面源码对 7f5f3ea 锚点零残余（仅存 I 豁免产品身份值 + approvals.js kind 映射 +
  01门 装机面 dist/）。
- **闭环补充（2026-09-11）**：M/N/P 反馈已由 main 第二批采纳（回执见 main 仓库
  `docs/handoff-f-remainder-adoption-20260911.md`，决策表见下方追加行）；O 节定制面 main 不消费。
  定制侧按 Phase 3 闭环规则 merge 吸收。

## L. G1-a 宿主半缺陷修复（2026-09-10 晚，真机闭环实证）——请 main 采纳

| 文件 | 改动 | 说明 |
|---|---|---|
| `packages/plugin-console/public/js/pages/login.js` | `?next=` 参数改为一次读取共享（`urlNextParam`），URL 清参后置 | 7f5f3ea 的 G1-a 实现：同源分支 IIFE 读完即 `replaceState` 清参，跨源分支 IIFE 再读 `location.search` 永远为空——**跨源回跳在任何场景都不生效**（本机全量栈 × 01门向导 浏览器闭环实证：修复前登录后落宿主 dashboard，修复后自动回跳本机面板 + 票据免登全链打通）。J 节 dsh-bridge softRead 同类教训：双消费者共享一次参数读取 |

## M. IAW 改版漂移（2026-09-11，行业 AI 工作台前端重构配套）——请 main 评审采纳

背景：定制轨前端按《行业 AI 工作台 PRD v1.0》（WorkBuddy 原型）整体重构为五空间 IAW 工作台，
场景图谱包从 2 个（QB01/GCJX）扩容为 14 个重点行业（工信部《参考指引（2025 版）》全量编码）。
扩容数据暴露了 scenegraph 校验器两处词表/口径与原文的偏差，属**加法式最小改动**，向后兼容
（既有 qb01 包零改动照常通过校验）：

| 文件 | 改动 | 说明 |
|---|---|---|
| `packages/platform-core/src/scenegraph.ts`（`SCENE_TAGS`） | 白名单 5 类 → 8 类（原 5 类 + 原文口径的 增收/安全/环保） | 工信部原文价值标签口径为 降本/提质/增效/增收/安全/环保/新模式（PRD §2.5「严格对齐原文」）；main 版五类缺 增收/安全/环保，而民爆（安全）、白酒（安全）等行业脱离这些标签无法如实表达。保留「节能」兼容既有 qb01 包 |
| `packages/platform-core/src/scenegraph.ts`（`validateScenegraph` tags 校验） | 「tags 非空」放宽为「可为空数组」 | 原文相当比例场景未显式标注价值标签（实测 807 场景中 504 个无标注）——此前唯一合规做法是虚构标签，违反本项目「不造假数据」红线；放宽后按原文如实装载，按标签筛选的场景视图自然排除无标注场景 |
| `packages/platform-core/src/scenegraph.ts`（`ScenegraphPack.links?`） | 新增**可选**字段 `links?: Array<{key,name}>`（行业环节链） | 原文图谱按行业环节组织（如钢铁 A 铁前/B 炼铁…），此前仅 `chains` 单字符串无法结构化消费；缺位时前端从场景编号第三段反推（既有 qb01 包无需改动）。校验器不对该字段做强校验 |

## N. 装态可用性修复漂移（2026-09-11 下午，用户实测四问题修复配套）——请 main 评审采纳

背景：用户真机实测暴露 4 个可用性问题（宿主已登录态面板无法完成授权 / 控制台跳转 MIME 白屏 /
协作消息链路不通 / 钉钉拉取缺失），修复涉及 2 个宿主面文件的最小加法改动：

| 文件 | 改动 | 说明 |
|---|---|---|
| `packages/plugin-console/src/index.ts`（`PUBLIC_PATHS`） | +`/api/panel/auth/login`、`/api/panel/auth/refresh` | 面板自持登录面（panel 命名空间，转发同一 authn 后端）在全量形态曾被 console 鉴权中间件拦截为 401——宿主已登录用户在面板本页登录被迫「先登出」。白名单不放行任何数据（鉴权由 authn.login 自身承担，口令错误仍 401） |
| `packages/plugin-dsh-bridge/src/index.ts`（身份半 entryTickets 解析） | apply 期软读 → **请求期惰性解析**（`entryTicketsAt()`） | dsh Loader 并发装载 patch entry 时 authn 可能晚于 dsh-bridge 发布 entryTickets——apply 期软读是竞态写法，装态身份半整体缺席（/dsh-bridge/* 404），宿主 Cookie 直通失效。惰性解析后服务就绪前兑换请求得到明确错误，就绪即通 |

## O. IAW 协作首位改版（2026-09-11 下午，用户裁决五项）——定制面自研，main 不消费

1. **协作空间移至首位**（五空间序：协作/图谱/执行/能力/数据），默认进入协作频道；协作空间在场时
   右侧 Agent 协作栏自动收起（`rail-off`）——同一会话只保留一个协作窗口。
2. **图谱空间补三视图**（原型/PRD 定义、WorkBuddy 原型占位的落地）：主线贯通（跨场景要素复用度
   计算）、场景对比（≤3 场景并排比对）、转型路线图（按评级三阶段 + 快赢清单）——全部由图谱真实
   数据计算，零虚构；场景图谱包增量合并 +12 个「数据完整」场景（321→333，scripts/merge-scene-list.mjs
   可复放；四清单缺项场景依旧不造数入库）。
3. **Agent 流式应答**：POST /api/panel/:dept/agent-stream（SSE-over-POST，guarded + panel.write），
   @数字同事 → {start/delta/done/fallback} 事件流，dsh 模型桥走原生 text-delta 流、modelgw 单轮
   整段下发（不造假流式动画）；完成后照常落库 + 广播。前端流式卡为瞬时层（内存态，不进消息库）。
4. **钉钉入向拉取（dws CLI 桥）**：POST /api/panel/ddws/pull 按 messageId 幂等去重落频道；
   前端「⇣ 拉取」按钮 + ddSync 开启时 60s 自动拉取。
5. **着陆归一**：panel-core 新增 `landingRedirect` 装配开关（仅 cordis.patch.yml 声明）——装态
   `/gate01/` 302 到 `/gate01/panel/`，杜绝「无 console 装配下 SPA 兜底把缺资源壳页发给浏览器 →
   module MIME 白屏」。全量形态不声明，根路径着陆归 console（行为不变）。

## P. 宿主已登录态 G1 扫码回跳死洞（2026-09-11，用户真机实测实证）——请 main 采纳

背景：N 节修复解决了宿主已登录态的**账号密码**路径（面板自持登录面白名单），但**钉钉扫码**
通道（必须借助宿主登录页完成扫码）仍带一个结构性死洞：宿主控制台已登录时扫码授权永远无法
闭环——打开宿主登录页只看到控制台工作台，不签票、不回跳；只有先登出宿主才能走通。

根因（定制侧逐行定位）：

- `?next=` 消费 + 跨源自助签票 + `#entry_ticket=` 回跳的**全部逻辑只存在于登录页**
  （`login.js` renderLogin 内 :141-190 `finishLogin` 出口）；SSO 回调脚本消费的
  `heng_ops_next_cross`（`src/index.ts` :432-435）也只有登录页的 `startDingOauth` 会写入。
- 而控制台路由**只在无会话时渲染登录页**（`app.js` navigate :98-107：`session.token`
  在场即直接渲染控制台外壳）。宿主已登录时打开 `宿主/?next=<面板地址>#/login`：
  next 参数被静默丢弃 → 不签票、不回跳 → 用户落在宿主工作台；向导侧「我已完成扫码」
  诚实降级报错（跨源隔离，本机侧无从校验）。
- 这正是同源形态早已认知的死循环（panel boot.js `consoleSessionPassthrough` 注释原文点名
  「next 被已登录态忽略」）——同源用面板直通兜住了，**跨源/扫码通道没有对应处理**。

建议修法（一处集中改动）：把 next 消费逻辑从登录页提升到启动链——`app.js` boot/navigate 在
「已有会话 + `?next=`（或 `heng_ops_next_cross`）在场且可解析」时，执行与 `finishLogin`
相同的出口：跨源白名单目的地 → `POST /api/auth/entry-tickets/self` 签票 →
`location.assign(next#entry_ticket=…)`；同源目的地 → 直接 `location.assign(next)`。
落地后扫码通道在已登录态变为「打开宿主页 → 立即带票弹回面板」的静默授权；
未登录态与既有登录页行为不变。

| 文件 | 改动 | 说明 |
|---|---|---|
| `packages/plugin-console/public/js/app.js` | 启动链（boot 或 navigate 入口）增加「已登录态 next 消费」：会话在场且 `?next=`/`heng_ops_next_cross` 可解析时按 login.js `finishLogin` 同规则出口（跨源签自助票带 fragment 回跳 / 同源直接跳转），随后照常渲染 | 修复宿主已登录态扫码回跳死洞。建议顺带把 next 解析/白名单逻辑（`sanitizeNext`/`sanitizeCrossOriginNext` 消费侧）抽为 login.js 与 app.js 共享的模块，避免 L 节「双消费者各自读取」教训重演 |

过渡期口径（定制侧已知情，待 main 采纳后失效）：远端向导改用账号密码登录（代理全闭环，
不依赖宿主浏览器会话）；钉钉扫码在宿主已登录态不可用，须先登出宿主再扫。

## 决策回执（请 main 侧填写后回传）

> main 侧已回填（2026-09-10，基线 main `5977067` 重算残余差异；实施与验证记录见 main 仓库
> `docs/handoff-f-remainder-adoption-20260910.md`）。注意：本清单对 `ff1a8de` 实测，main 此后已
> 自行推进——realtime.js / realtime.test.mjs（钉钉 H5 降级）与 plugin-usage 等两侧同幅差异系
> 已同步内容，不在本批回流范围。

| 域 | 采纳？ | 备注 |
|---|---|---|
| A 审批深化 | ✅ 采纳 | plugin-audit 底座 + agent 标注 + console 三端点整体回流；已剔除定制侧 `PUBLIC_PATHS` 首行误合并格式损伤（回流时修复）。main 既有 selftest 的 agent/app 上下线审批调用点已随 fail-closed 语义补 `confirmed: true` |
| B usage/recent | ✅ 采纳 | `GET /api/usage/recent`（console.login，自见 ≤5） |
| C 五平台主题/钉钉H5/dashboard | ◑ 部分采纳 | 主题（platform.js / base.css 五平台块 / 启动回放 / 钉钉入口探测）与审批终审展示采纳；**dashboard 场景卡片区不采纳**（依赖 `/api/panel/board` 定制面板数据面，按依赖警示待卡片包域表态；main 侧 dashboard 已按「仅采纳其余部分」改造，对话入口卡按挂载形态显隐）；H5 降级 main 已自备（realtime.js + realtime.test.mjs），walkthrough / dingtalk-h5-smoke 不搬（行为等价）；base.css 场景卡片 CSS 未搬（无消费方） |
| D 目录筛选/登记引导 | ✅ 采纳 | asset-filters + assets 瘦身 + register 引导页 + NAV「资产登记」；已剔除定制侧 NAV 重复的「Skill 市场」行（rebase 残留）与 approvals 页 industry.activation / panel.* 定制 kind |
| E 测试资产 | ✅ 随域 | 「审批 SLA 与公司级终审」「usage 最近调用」「五平台主题 CSS 断言」「资产目录筛选（纯函数+性能）」四分节移植进 scripts/selftest.mjs；跨源 next 白名单用例入 landing.test.mjs（main 的 landing.js 纯函数随包单测通道）；dom-smoke 等布局迁移不强制，未搬 |
| F mcp/app riskLevel 水印 | ✅ 采纳 | app 2 处 high + mcp finalReview / 调用水印，随 A 底座一并落地 |
| G1 远程登录回跳闭环（next + 自助 entry_ticket） | ✅ 采纳 | `POST /api/auth/entry-tickets/self`（EntryTicket 增 `self` 票种，TTL 硬上限 120s 覆盖 env 调高）；跨源 next 白名单 = landing.js `sanitizeCrossOriginNext()` 纯函数（仅回环/私网 http(s)；公网/伪协议/带凭据拒绝），比整页白名单更收窄 open redirect 面；登录页 finishLogin 与 SSO 回调脚本双消费点（`heng_ops_next_cross` 暂存过钉钉整页授权）。审计沿用 main 既有 `${refType}.entry.ticket.*` 约定（self.entry.ticket.issue / .session），未另设 authn.entryticket.redeemed 双轨。**定制侧零后续改动成立：G1 采纳即闭环** |
| G2 modelgw 流式化 | ❌ 暂缓 | 非必须；现状单轮非流式诚实工作，待面板协作会话有流式诉求再议 |
| G3 拷贝安装形态 TS 装载（dsh loader 预剥离 / 平台预构建分发） | ❌ 维持挂起 | 01门产物已自解（dist 入库）；宿主面包属平台预构建分发架构议题，登记维持，非本批 |
| I 01门改名装配漂移 | ❌ 不采纳（豁免登记） | 产品身份值必须跟随**各自**根包名——main 保持 `dsh-enterprise-ops` / `@dsh-ops` / `/rq`，定制侧保留 `@01men/gate-01` / `/gate01`；此域属「产品身份固有分叉」，请定制侧在收敛检查按豁免登记（不可拆除，拆除即版本定位/自更新根目录错乱） |
| J 01门 Phase 3 追加漂移（dsh-bridge inject 收缩 / rq-card 内联 / files 闭包） | ◑ 部分采纳 | **dsh-bridge inject 8→3 + softRead 防御式软读：采纳**（main 全量装配行为不变；抗缺提供者装配属宿主面健壮性，真机已实证）。rq-card tool.ts 内联 / exports / 根 files 闭包：不回流（rq-card 包内装机面，main 不涉） |
| K http.ts file() headersSent 守卫（宿主崩溃级缺陷） | ✅ 采纳（本批最先落地） | 幂等守卫两处（writeHead 前 + catch 分支）原样回流 |
| M IAW 改版 scenegraph 漂移（2026-09-11） | ✅ 采纳 | `7f5f3ea` 后新批：SCENE_TAGS 5→8（原文 增收/安全/环保 入表，节能兼容保留）、tags 可为空数组、`links?` 可选环节链（校验器不强校验）——与定制侧同形加法，既有 qb01/gcjx 零改动过 lint。selftest 新增「场景图谱校验器（F 清单 M 节）」5 断言；实施回执见 main 仓库 `docs/handoff-f-remainder-adoption-20260911.md` |
| N 装态可用性修复（2026-09-11 下午） | ✅ 采纳 | N-1 PUBLIC_PATHS +`/api/panel/auth/login|refresh` **先行登记**（main 侧 panel 自持登录面路由尚未随 IAW 前端合入，无路由命中=零行为变化，merge 后即闭环）；N-2 dsh-bridge entryTickets 请求期惰性解析（`entryTicketsAt()`）原样回流——注册面不再早退于 entryTickets 缺席，就绪前兑换得到明确错误 |
| O IAW 协作首位改版（2026-09-11 下午） | ❌ 不消费（定制面自研） | 五空间序/三视图/agent-stream/ddws pull/landingRedirect 属定制面板域，main 不消费；O.3/O.4/O.5 随面板域专项另行评估（与 C 节 dashboard 卡片区块同口径） |
| P 宿主已登录态 G1 扫码回跳死洞（2026-09-11） | ✅ 采纳 | 按建议修法 + 抽共享模块：新增 `public/js/next-redirect.js`（`consumeNextSources()` 一次读取 + `exitWithNext()` 跨源自助票/同源直跳，白名单事实源仍在 landing.js 纯函数）；login.js 改走共享面（语义不变），app.js boot 在落地分诊前消费（已登录态静默授权，未登录态行为不变）。随包单测 next-redirect.test.mjs 7 例入 node --test 通道；**P 节过渡期口径自本回执起失效**（宿主已登录态扫码通道已闭环） |

未采纳项由定制侧在下一个同步周期内拆除（北极星 diff 相应归零）；**I 域例外：按豁免登记处理**
（产品身份值，拆除即错乱）。
