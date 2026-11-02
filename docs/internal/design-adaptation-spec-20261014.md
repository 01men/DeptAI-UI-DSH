# Kimi CIO 仪表盘设计适配规格（作战地图）2026-10-14

> **交付状态：已完成（2026-10-14 深夜批次）**。验收记录：
> - selftest **1258/1258 全绿**（含新增「console+panel 前端零 window.open/alert/confirm/prompt 弹窗」走查断言；FinOps CFO 四断言因演示种子新增 model: 用量由排他精确改为探针精确+份额自洽复算，校验意图不变）
> - dom-smoke **15/15**（T3 审批按钮 data-reject 钩子恢复）；新增 **scripts/page-smoke.mjs 全页面渲染冒烟 31/31**（五 tab 工作台/gateway/usage/access/六类台账/AI 市场/iam 三 tab/18 个专项页）
> - lint 全家桶：manifests / boot-order / cjk 0 错误
> - 浏览器 GUI 实测：真实登录→工作台五 tab→资产台账抽屉（六 tab 详情）→12 页批量巡检零错误卡；视觉经 vision 模型复核（暖纸+深青蓝+浅侧栏落地，无破损）
> - **dsh 挂载形态**：/rq 前缀反代模拟实测——同源完整页面（无 iframe/弹窗）、BASE 推导 /rq/、登录与全部 API 走挂载前缀、三新页巡检通过
> - 修复记录：gateway renderRouteCard 缺 models 参数（ReferenceError）；tokens「万」/成本「分→元」单位换算四处（assets/asset-drawer/gateway 预算/usage 含 CSV）；panel 钉钉授权弹窗→同窗口跳转；nas-authz 异步落表空节点防御
> - ⚠️ 部署提示：**存量运行实例需平滑重启一次**以注册新后端路由（/api/fleet/ledger、/api/usage/report、/api/modelgw/routes-usage、/api/exec/overview、/api/skills heat 字段），否则新前端对这些端点得到 404 并按设计降级为空态。

设计稿来源：`Kimi_Agent_CIO仪表盘设计.zip`（React+Tailwind+shadcn，仅作视觉/信息架构规范消费）。
移植目标：`packages/plugin-console/public/`（零构建原生 ESM SPA）。

## 0. 铁律（不可违反）

1. 不引入构建链/框架/tailwind——selftest 断言 base.css 无 tailwind（selftest.mjs:1153-1157）。
2. 除 api.js（豁免 oauth.js/realtime.js）外零裸 fetch/XHR/EventSource（selftest.mjs:1213-1225）。新页面一律 `import { api } from '../api.js'`。
3. tokens.css 是 token 单一声明源；panel.css 经 `@import "../../css/tokens.css"` 反向消费——改语义 token 值时不得破坏该路径。
4. `data-platform` 五平台主题机制保留（base.css `:root[data-platform=...]` 覆写 --brand-* 仍优先生效）。
5. dsh 挂载形态（/rq 前缀）必须是同源完整页面：禁止 `window.open`/`alert`/`confirm` 类弹窗子窗口；需要新视图一律页面内抽屉（openDrawer）或整页跳转。
6. 页面渲染签名不变：`async renderXxx(content, params, ctx)`，`content.innerHTML = ...` 模式。
7. 所有用户可见文案中文（lint-cjk 覆盖）。

## 1. 设计 token 映射（tokens.css 值更新——语义名不变，只改值）

设计稿（HSL，index.css :root）→ 现有 token：

| 设计稿变量 | HSL | ≈Hex | 映射到现有 token |
|---|---|---|---|
| --background | 45 18% 96.8% | #f8f6f3 | `--bg` |
| --foreground | 30 8% 12% | #231f1d | `--text-1` |
| --card | 0 0% 100% | #fff | `--surface` |
| --primary | 201 88% 31% | #0a5f87 | `--brand-500`（主品牌阶整体重算，见下） |
| --muted-foreground | 30 4% 42% | #706864 | `--text-3` |
| --border | 40 9% 88% | #e0ddd8 | `--border` |
| --muted | 45 10% 94% | #f0eeea | `--surface-2` |
| --destructive | 4 72% 44% | #c02020 | `--danger` |
| --sidebar-background | 45 14% 95.2% | #f2f0ec | `--sidebar-bg`（**深色侧栏→浅暖色侧栏**） |
| --sidebar-foreground | 30 5% 30% | #484442 | `--sidebar-text` |
| --sidebar-accent | 45 10% 92% | #eae7e1 | `--sidebar-hover` |
| --sidebar-border | 40 9% 88% | #e0ddd8 | （新增 `--sidebar-border`） |

品牌阶重算（primary=hsl(201 88% 31%)≈#0a5f87 为主值，设计稿图示含 sky→cyan 渐变 `from-sky-700 to-cyan-500`）：
- `--brand-50:#f0f7fa; --brand-100:#dceef5; --brand-200:#b6e0ee; --brand-300:#7fcbe0; --brand-400:#38a8c8; --brand-500:#0a5f87; --brand-600:#084d70; --brand-700:#063d59; --brand-gradient: linear-gradient(135deg,#075985 0%,#0e7490 55%,#22b8cf 100%)`
- `--brand-primary: var(--brand-500)` 联动不变。
- 语义色保持现有 ok/info/warn/danger 语义（设计稿 emerald/amber/red/sky 与现有值接近，微调对齐设计稿：ok→#059669（emerald-600），info→#0284c7（sky-600），warn→#f59e0b 不变，danger→#dc2626）。
- 中性色系切暖：--bg:#f8f6f3; --surface:#ffffff; --surface-2:#f0eeea; --border:#e0ddd8; --border-strong:#d1cdc6; --text-1:#231f1d; --text-2:#4d4643; --text-3:#706864; --text-4:#a39c96。
- 侧栏组全换浅色：--sidebar-bg:#f2f0ec; --sidebar-bg-2:#eae7e1; --sidebar-text:#706864; --sidebar-text-active:#231f1d; --sidebar-hover:#eae7e1; --sidebar-active:rgba(10,95,135,0.10)（选中态浅底+左侧 2px 主色条由 base.css 实现）。
- 布局：--sidebar-w:218px; --topbar-h:56px。
- 字体加 Inter 前缀：--font: Inter, -apple-system, ...（系统无 Inter 时自然回退，不引外部字体文件）；--mono: "JetBrains Mono", ui-monospace, ...。
- rq-card 的 --rq-* 对照表**不动**（dsh 宿主文档内变量，与本主题无关）。
- 覆写注释「主题（元冰可品牌 · 科技蓝）」段落头改为「主题（CIO 仪表盘 · 暖纸 + 深青蓝，2026-10-14 设计适配）」。

## 2. base.css 新增组件类契约（页面组直接用，不得自造同类）

```
.micro-label          10.5px/600/uppercase/letter-spacing .14em/色 text-3
.page-head            页头块（micro-label+标题+副题+右侧动作）margin-bottom 16px
.page-title           17px/600/tracking-tight
.page-sub             12px/text-3，margin-top 2px
.chip                 圆角胶囊过滤钮（全部/六类等）：padding 4px 12px/12.5px/bg surface/ring 1px border
.chip.active          bg text-1 色、color #fff
.stat-card            指标卡：border+bg surface+p 16px+radius 8px
.stat-value           22px/600/tnum
.stat-sub             12px/text-3
.tabbar               分段标签容器：inline-flex bg muted radius 8px padding 4px gap 4px
.tab / .tab.active    分段标签钮；active=bg surface+shadow-sm+600
.tab-badge            标签内小圆角计数徽标（amber 变体 .tab-badge.warn）
.dot/.dot-ok/.dot-warn/.dot-crit/.dot-off   7px 圆点（ok=#059669,warn=#f59e0b,crit=#dc2626,off=#a8a29e）
.pulse                pulse-dot 动画（红点呼吸，keyframes 从设计稿移植）
.pill                 生命周期徽章：radius-full+11px+ring-1 inset（.pill-online 绿/.pill-draft 蓝/.pill-offline|archived 灰/.pill-deprecated 琥珀）
.tbadge               资产类型徽章 11px/600（.tbadge-mcp 青/.tbadge-agent 紫/.tbadge-app 蓝/.tbadge-skill 绿/.tbadge-model 琥珀/.tbadge-nas 玫红）
.bar/.bar-fill        6px 圆角进度条，fill=brand 渐变；.bar-fill.warn 琥珀；.bar-fill.ok 绿
.risk-pill            审批风险徽章（.risk-crit 红/.risk-high 琥珀/.risk-normal 灰）
.timeline/.tl-item/.tl-dot   垂直时间线（dot 19px 圆，done=绿底白勾✓，current=主色，pending=灰）
.kanban-col           看板列：bg muted/40 radius 8px padding 10px
.kanban-card          看板卡：bg surface border radius 8px，hover 上移 2px+shadow
.grid-cards           卡片网格：grid gap 12px，minmax 响应式（2/3/4/5 列由 .g2/.g3/.g4/.g5 变体）
.drawer-tabs          详情抽屉内二级标签（复用 .tabbar）
.search-input         带左放大镜的搜索框 32px 高
.mono/.tnum           等宽/表格数字工具类（如未有）
.empty-hint           虚线边框空态块
.heat-cell            市场热力格 7px（色深由内联 background 决定）
.fade-up              进场动画（translateY(4px)→0 + opacity，240ms）
```

既有类（.card/.btn/.badge/.tbl/.drawer/.modal/.toast/.nav-item/.topbar 等）保留类名，仅由 WA 更新视觉值（暖色/圆角 8px/边框 #e0ddd8 等），页面组零改动自动换肤。

## 3. ui.js 新增组件函数契约（WA 实现，页面组消费）

```js
// 全部返回 HTML 字符串（sparkline 既有签名保留不动）
sectionHead({ label, title, extra, actions })            // .page-head 结构；actions 为 HTML 字符串
statCard({ label, value, sub, tone })                    // tone: ''|'warn'|'crit'
healthDot(health, { pulse } = {})                        // 'healthy'|'warning'|'critical'|'offline' → .dot 组合+中文
lifecycleBadge(s)                                        // 'draft'|'online'|'offline'|'archived'|'deprecated'
typeBadge(type)                                          // 'mcp'|'agent'|'app'|'skill'|'model'|'nas'
progressBar(percent, { tone = '', width = '80px', label = '' } = {})
areaChart({ series, labels, unit = '', color, height = 180 })        // 纯 SVG 面积图（设计稿 AreaChart 移植）
dualTrendChart({ actual, target, labels, unit = '', color, height = 200 })  // 实线+虚线目标
hBarList(items, { format } = {})                         // items:[{name,value,hint}] 横条排行
donutCenter(parts, { centerLabel, centerValue, size = 120 })         // 带中心数值甜甜圈（区别于既有 donut）
heatStrip(values, { big = false } = {})                  // 30 天热力条
chipRow(options, activeValue, onPick)                    // 返回 Element；options:[{value,label,count}]；onPick(value)
tabRow(options, activeKey, onPick)                       // .tabbar 分段标签；options:[{key,label,badge,badgeTone}]
emptyHint(text)                                          // .empty-hint 空态
```

既有 sparkline 颜色默认值改为 var(--brand-500) 对应新主色（#0a5f87）。barChart/lineChart/donut 默认色同步换。

## 4. 信息架构（NAV 重组 · app.js）

四组主干对齐设计稿，全部现有功能保留：

```
总览   工作台(#/dashboard 五tab) ｜ 部门面板(ext /panel/) ｜ 执行中枢(#/exec)
资源   资产台账(#/assets 六类统一) ｜ AI 市场(#/skills) ｜ 模型网关(#/gateway 新) ｜
       资产登记(#/register) ｜ Agent 本体(#/agents) ｜ AI 应用(#/apps) ｜ MCP 服务(#/mcp) ｜
       NAS 存储(#/nas) ｜ 数据权限(#/nas-authz) ｜ 连接器(#/connectors)
治理   用量与成本(#/usage 新) ｜ 财务视图(#/finops) ｜ 审批中心(#/approvals) ｜
       审计与告警(#/audit) ｜ 认证与令牌(#/authn)
企业   组织与账号(#/iam) ｜ 角色权限(#/iam?tab=roles) ｜ 三方集成(#/iam?tab=connectors) ｜
       平台接入(#/access 新=合并 connect+connections+connector 状态) ｜ 插件与工具(#/platform)
```

- 旧路由兼容：`#/connect`、`#/connections` 保留 builder（重定向语义：connect→access tab，connections→access tab=hosts），书签不死链。
- renderShell 页头：内容区顶部加 `.page-head`（micro-label 大写域标签 + 标题 + 副题问候语），由各页面 builder 输出（app.js 不强插）。
- builders 注册：`gateway: renderGateway`、`usage: renderUsage`、`access: renderAccess` 新增；其余不变。

## 5. 页面规格（对设计稿逐页）

### 5.1 工作台 #/dashboard（五 tab，tabRow 切换）
- cockpit 经营驾驶舱：今日经营洞察卡（/api/exec/overview 洞察文案；缺则由 goals 完成度+alerts 派生真实文案，禁止硬编码假话术）+ 异常影响卡（alerts）+ 经营口径工具条（组织筛选+周期）+ KPI 四卡（受管资产/今日调用/今日消耗/风险，/api/overview 派生）+ 价值兑现双序列图（/api/exec/goals 价值口径；无数据时空态）+ 需要您决策（approvals pending top3 → #/approvals）。
- goals 目标与价值：目标卡网格（/api/exec/goals：tag/达成进度/负责人/关联行动 pct）+ 核验规则卡（静态治理文案）。
- actions 行动项目：项目表（/api/exec/projects：负责人/进度条/核验价值/状态 pill）+ 交付任务看板（/api/exec/tasks 按状态分列 kanban）。
- collab 人机协作：数字员工在协作卡（/api/panel/agents 或 agents API 在线清单）+ 演示会话（/api/panel/streams 摘要，只读）+ 当前目标 + 执行边界（只读卡）。
- ops 平台运行：四 Stat（overview）+ 用量趋势 areaChart（/api/usage/recent 或 /api/usage/report）+ 成本构成 donutCenter（finops/usage 派生）+ 部门用量 hBarList + 待办审批 top3 + SSE 事件流（realtime.js 若在，否则审计最近 5 条）+ 资产健康速览网格（六类台账 top10 → /api/fleet/ledger）+ 熔断影响红条。
- 保留现有权限 CTA 门控语义（selftest 有断言：dashboard.js 权限 CTA grep 不变量 selftest.mjs:4761-4876——更新断言时同步）。

### 5.2 资产台账 #/assets（六类统一台账）
- chipRow 六类过滤+全部（计数）+ search-input（名称/资源键/组织）+ 一键巡检（既有 /api/assets/healthcheck）+ 登记资产（→#/register）。
- 台账表：TypeBadge+名称/资源键(mono)｜归属/负责人｜HealthDot(+灰度条)｜30d 调用｜30d 消耗｜成本参考｜LifecycleBadge｜sparkline 趋势。
- 行点击 → openDrawer 资产详情抽屉（wide）：概览/监控/权限/拓扑/审计/生命周期 tabRow（数据按类型走既有各域 API：agents/apps/mcp/nas/skills/modelgw 详情；无则空态）。
- 数据源：新聚合端点 GET /api/fleet/ledger?search=&type=（WB 实现），六类统一 schema：{id,type,key,name,org,owner,health,lifecycle,grayPercent,calls30d,tokens30d,cost30d,dau,trend[14],version,autonomy,desc}。真实数据映射：健康=healthcheck 结果/熔断态；趋势=近 14 日 usage。
- 旧 assets 页功能（inventory/healthcheck/报表）并入：tab 或抽屉动作，不丢功能。

### 5.3 AI 市场 #/skills（设计稿 Market 样式）
- 卡片网格：名称+验签盾（verified=Ed25519 通过）+状态 pill+publisher+desc 两行+HeatStrip 30 天热力+版本/安装数/风险徽标；分类 chipRow+搜索。
- 卡点击 → 详情抽屉（状态+验签+版本+desc+热力大图+依赖/引用清单+安装/审批动作）。
- 数据：既有 /api/skills/*（列表含 installs/风险）；热力=近 30 日每日使用次数（usage 按 skill 聚合，WB 补端点或列表字段）。

### 5.4 模型网关 #/gateway（新页）
- Stat 四卡（30d 总消耗/路由数/渠道数/预算熔断）+ 路由卡列表：路由名+model mono 徽标+状态+占比+预算进度条（Flame）+降级链渠道卡（承接流量/降级中/待机，P95）+ 渠道探测按钮（探测动作留痕 audit）。
- 数据：/api/modelgw/models + channel-groups + budgets（已有）；30d 消耗=/api/usage/report 按 model 聚合（WB 补）。
- finops 的 #modelgw-card 保留但降级为摘要卡+「进入网关」链接（功能不删）。

### 5.5 用量与成本 #/usage（新页）
- tokens/成本双维度切换 tabRow + 28 天 areaChart + Top 资产 hBarList + 部门分摊表（占比条+环比）+ 单位 DAU 成本条 + 导出 CSV（既有 finops 导出动作，下载行为留痕）。
- 数据：GET /api/usage/report?days=28&dim=（WB 补：序列/部门分摊/Top 资产/单位 DAU——全部从 usage 事件真实聚合，空数据空态）。

### 5.6 审批中心 #/approvals
- 左列表（风险 risk-pill+标题+申请人+组织+时间+已决状态）右详情（dry-run 影响面 mono 列表+审批时间线 timeline+通过并执行/驳回必填原因）。
- 数据/动作：既有 /api/approvals*。已决态文案「本单已通过/驳回 · 结果已回写」。

### 5.7 审计与告警 #/audit
- 告警规则速览三卡（规则名+触发次数+级别色）→ tab=alerts 既有数据；四类过滤 chipRow（全部/认证/调用/变更/安全）+搜索（动作/主体/目标）+日志表（时间 mono/类型/动作/act 调用链 chips→/目标 mono/结果 OK·DENY·ALERT 徽标）。
- 数据：既有 /api/audit*。act 链字段若无则隐藏列（不造假）。

### 5.8 组织与账号 #/iam
- 左：组织树（根+子组织+人数）+三方连接器卡（模式/频率/最近同步/冲突数）。右：账号表（头像字/成员/账号 mono/角色/组织/MFA）。
- 底部四能力卡（权限点矩阵/动态用户组/一人一号/冻结联动——真实能力静态说明）。
- 数据：既有 /api/iam/*。角色权限/三方集成 tab 保留（?tab=）。

### 5.9 平台接入 #/access（合并 connect+connections+connectors 状态）
- tabRow：接入管理（原 connect 页 enroll 接入码全功能）｜宿主连接（原 connections 页全功能）｜连接器目录（原 connectors 摘要+入口）。
- 原 #/connect、#/connections、#/connectors 路由保留可直达（builders 映射到 access 对应 tab），旧书签不死。

### 5.10 专项页换肤适配（agents/apps/mcp/nas/nas-authz/authn/register/finops/platform/exec/connections）
- 不改功能逻辑，仅：页头改 sectionHead 结构、表格/徽章/按钮类对齐新组件类、抽屉统一 openDrawer。exec 页保留（工作台 goals/actions tab 是其概览下钻）。

### 5.11 产品首页 #/home + 登录页 #/login
- home.css 联动换暖色主色（按钮/链接/渐变引用 token），结构不动。

## 6. dsh 完整页面保障

- agents.js「交互界面」`window.open(entryUrl#entry_ticket=…,'_blank')` → 改 `location.assign(entryUrl + '#entry_ticket=…')` 同窗口整页跳转（dsh 挂载下跳 /rq/panel/ 完整页）。
- panel 钉钉授权 520x640 弹窗：改同窗口跳转（OAuth provider 回跳由 DingTalk 服务商 callback 承接；若实现依赖 popup则改为顶部提示条+整页跳转，不留子窗口）。
- 全 public/ 禁止新增 window.open/alert/confirm/prompt（selftest 加静态走查断言，豁免清单置空）。

## 7. 测试与验收（第三波统一执行）

1. selftest 更新：五平台主题色值断言、前端接线 grep 不变量（dashboard.js/新页面）、window.open 零走查、新路由注册断言。全量 `npm run selftest` 绿。
2. dom-smoke 扩场景：六类台账过滤+抽屉、gateway 页渲染、usage 页维度切换、approvals 左右布局、access 三 tab、home 换肤冒烟。
3. 浏览器 GUI 实测（browser-use）：逐页截图验收视觉对齐 + 关键交互（过滤/抽屉/审批/导出）。
4. dsh 挂载验证：伪造 webServer /rq 前缀分节（selftest 已有）+ MOUNT 推导单测 + /rq/panel/ 302 归一断言保持全绿。
5. lint 全家桶：manifests/boot-order/cjk/contract-lint 通过。

## 8. 分工与文件冲突域（严格遵守，越界先协调）

- WA 设计系统：css/tokens.css、css/base.css、css/home.css、index.html、js/ui.js、js/icons.js、panel 侧 panel.css 联动。不碰 pages/*、不碰 app.js。
- WB 后端 API：packages/plugin-console/src/routes/*、相关 service 注入、DEMO_SEED 种子。不碰 public/。
- WC 工作台：js/pages/dashboard.js、js/pages/home.js、js/pages/login.js（换肤）。
- WD 资产域：js/pages/assets.js、js/pages/skills.js、js/components/asset-drawer.js（新文件）。
- WE 治理域：js/pages/gateway.js（新）、js/pages/usage.js（新）、js/pages/approvals.js、js/pages/audit.js、js/pages/finops.js（摘要降级）。
- WF 企业域：js/pages/iam/*、js/pages/access.js（新）、js/pages/connect.js|connections.js|connectors.js（路由兼容壳）、agents/apps/mcp/nas/nas-authz/authn/register/platform/exec 换肤 + window.open 消灭。
- WG 测试：scripts/selftest.mjs、scripts/dom-smoke.mjs（最后统一跑，避免和页面组写冲突）。
- app.js（NAV/builders/renderShell）由主控（我）统一改，页面组不碰。
