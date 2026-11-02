# 更新日志

本文件记录对外可感知的版本节点。过程性批次明细（QA 报告、交接单、批次计划）见
`docs/internal/`（不构成对外契约）；早期完整发布说明见 `docs/internal/release-notes-*.md`。

## [Unreleased] · 演示一键免密入场 01门工作台 + 控制台 01门入口（2026-11-01）

demo.ybkkasi.com 挂上 01门（DeptAI-UI-DSH，dsh demo profile :7778，远端绑定演示底座）后，
客户直达面板会落「连接向导」要求输账号密码。本次把登陆这一步从演示体验里拿掉：

- **`POST /api/panel/auth/demo-entry`**（公开白名单，处理器内 `isDemoMode` 否决——非演示实例
  恒 404，生产零新增面）：服务端登录种子演示账号，签发 ≤120s 一次性自助票（refType=self，
  复用既有票据用途隔离语义），入审计 `demo.entry.ticket.issue`。
- **`gate01-go.html` 免密中转页**：签票与 01门装态探测并行，票据经 `#entry_ticket=` 片段
  直达面板自助兑换（面板 boot 既有链路）；未部署 01门指去底座内置部门面板，异常诚实提示。
- **控制台 01门入口**：同源探针（`gate01-entry.js`，存在才渲染，任何部署形态不出死链）+
  演示横幅与首页入口；随包单测 3 项；selftest 非演示实例 404 断言 + 公开白名单锁定，
  路由数 496 / 断言数 1795（防漂移闸同步）。
- 浏览器实测（公网）：控制台入口 → 中转页自动签票兑换 → 完整工作台（演示身份「沈亦澜」，
  看板/任务/频道/SSE 全通），客户全程零输入。部署与验收记录：
  `docs/internal/gate01-demo-deploy-20261101.md`。

## [Unreleased] · transition 权限按动作分支 + 员工自助 MCP 调用配置（2026-11-02）

全局 API/MCP 对齐审查发现两项权限口径问题（REST/工具两面对同一动作要求不同权限点；目录点
app.offline 零执行面），连同「员工在平台自主生成 MCP 调用配置」诉求一并落地：

- **transition 权限分支（A/B 修复）**：`POST /api/agents/:id/transition` 改为一端点多分支——
  action=offline 守 `agent.offline`（对齐工具面 agent_offline），其余动作守 `agent.approve`；
  `POST /api/apps/:id/transition` 同款启用目录点 `app.offline`（下架）其余守 `app.write`。
  权限判定先于 owner 校验（RBAC 探针 403 语义不变），组合权限标注进路由矩阵与 openapi。
- **app_offline 工具（+1 工具，98）**：仿 agent_offline——L4 审批单 + 影响面说明，桥接面服务端
  注入发起人身份；目录 app.offline 孤儿点转正，agent/app 两域下线语义一致。
- **个人接入令牌（+3 路由，499）**：`POST/GET/DELETE /api/authn/mcp-tokens`——员工为「自己」签发
  带备注的长效令牌（缺省 30 天、上限 90 天 `MCP_PAT_MAX_TTL_HOURS` 可调、每人活跃 ≤10 条），
  签发即返回标准 mcpServers JSON（Streamable HTTP + Bearer）供外部 MCP 客户端一键复制。
  **权限与角色实时对齐是构造性的**：human 令牌在 verify 时按当前角色实时解析权限——角色变更
  即时生效、吊销立即失效，配置永远不超越本人角色。明文仅返回一次（对齐接入码先例）；列表恒掩码；
  自助吊销仅限本人（非本人按 404）；管理员侧沿用既有令牌台账与吊销面。
- **控制台「我的接入」（#/me）**：全员可见新页面——身份卡（生效权限点数）+ 生成表单（备注/有效期）
  + 一次性配置弹窗（明文 JSON + 一键复制 + 安全警示）+ 我的令牌表（掩码/状态/吊销）；
  演示态隐藏签发入口（只读口径）。列表守卫 console.read（演示只读白名单基线点，真实用户零感知）。
- **自测**：新增 24 条断言（签发形态/TTL 钳制/label 门禁/权限内外访问/角色扩收权实时跟随/
  掩码列表/越权吊销 404/吊销即失效/数量上限/A-B 双侧分支正反路径/工具面 app_offline/矩阵
  组合标注），1819/1819 全绿；路由数 499、工具数 98 防漂移闸同步。

## [Unreleased] · 资产使用凭证：Agent 获取授权 → 主动提报 → 台账经营关联全链路（2026-10-31）

此前 skill.zip 下载到 Agent 本地执行后平台完全无感知（只有下载流水，无使用记录）；现有
metrics-report 是 DAU 运营口径，不是资产粒度的使用凭证——「Agent 登记后获取 skill/MCP 资产、
使用后主动提报使用记录、记录进资产经营」的链路断在最后两环。本次打通全链路：

- **授权闭环（不新建授权原语）**：提报校验建立在既有获取记录上——skill 取 install 依赖边
  ∪ download 流水（机器主体按 principalId 匹配，自取同样构成授权）；MCP 与数据面同口径
  （权限组 subjects 含该 Agent 且 policies 覆盖目标服务）。未获取先提报 403 NO_GRANT。
- **提报服务**：`POST /api/assets/usage-reports`（复用 `usage.write` 权限点——Agent 注册默认
  scope 已含，存量免换证）；凭证流水独立集合 `usage:assetReports`（引擎级幂等键唯一），
  字段：assetType/assetRef/assetKey（与台账同键）/assetVersion/action/occurredAt/outcome/
  durationMs/tokens/taskId/note/idempotencyKey；同键同内容重放返回原凭证（deduped）、同键
  异容 409、不存在资产 404（防编造）、补录窗 30 天。human 持 usage.write 可代报（归因 human）。
- **逐次审计**：每次提报 emit `usage.asset.reported`，plugin-audit 订阅落 `asset.usage.report`
  （对齐 app.secret.access 先例）；与计量事件口径互补互不替代（计量=平台自动、计费管道；
  凭证=使用方自证、经营证据）。
- **经营关联**：`GET /api/fleet/ledger` 六类台账行新增 `usageReports30d`（近 30 天凭证数），
  控制台资产台账新增「使用凭证」列；`GET /api/assets/usage-reports` 凭证流水查询/对账出口
  （REST 面 +2 路由，495）。
- **技能面（+1 工具，97）**：`asset_usage_report` MCP 工具——Agent 经平台工具面直接提报，
  无需手拼 REST（工具片段 inject 补 skillHub/mcpRegistry/resourceCore，服务级注入不动的防环）。
- **文档（Agent 的记忆）**：`docs/agent-onboarding.md` 新增 §4.7「资产获取与使用凭证提报」
  （链路总览/获取=授权/字段表/幂等与错误语义/数据面调用免逐次提报的口径边界）；
  README.agent.md（中英）、llms.txt 同步最小事实；skill/MCP 使用后回报要求纳入接入验收。
- **自测**：新增 26 条断言（401/枚举门禁/未授权 403/404/补录窗/install 与 download 双授权
  路径/MCP 权限组路径/human 代报/幂等重放与异容/查询过滤/台账关联/审计落账/工具面端到端），
  落地页断言数 1767 → 1793。

## [Unreleased] · 应用外部凭证托管：数字员工可存取的长期第三方凭据平台落点（2026-10-31，#19）

GitHub issue #19（enhancement）实测反馈：数字员工/接入应用要调用「用长期固定凭据鉴权的外部
自研服务」时，平台没有任何可存取落点（`/api/secrets`、`/api/vault` 404；app attrs 白名单无
secret 字段；connector 凭证保险库 write-only 且平台无回读），明文只能落各机器本地 0600 文件
——无归属、轮换逐台改、审计断链。按 issue 方向 A 落地最小闭环：

- **加密存取**：新增 `appCredentials` 服务（`packages/plugin-app/src/credentials.ts`）——
  值 AES-256-GCM 静态加密（每条目独立 IV + auth tag），主密钥独立文件（0600）首用生成；
  密钥文件 0600 / 目录 0700，与 SecretBroker 同纪律且叠加静态加密（平台全仓首个加密存储位）。
- **授权模型**：登记/轮换/删除沿用 `app.write` + owner 校验（与能力绑定同口径）；**取值
  （拿到明文）走独立权限点 `app.credential.fetch`**（新权限点，目录收录、缺省无内置角色持有）+
  对象级校验（机器凭证须绑定本应用，human 须 owner 或管理员）——绑定而不授权同样 403。
- **逐次审计**：每次取值 emit `app.secret.access` 事件（payload 仅元数据零值），plugin-audit
  订阅落 `app.credential.access`；轮换同键覆盖（旧值立即失效）；应用删除联动清库（删除即销毁）。
- **REST 面（+5 路由，493）**：`GET/PUT/DELETE /api/apps/:id/credentials(/:key)`、
  `GET .../:key/value`（404 CREDENTIAL_NOT_FOUND）、`GET .../self-check`（接入方自检：
  托管在哪 / 谁能读 / 最近谁读过，一条命令）。响应零明文（只回 `masked` + `rotatedAt`）。
- **控制台**：应用详情新增「外部凭证」tab（登记/轮换/删除/取值弹窗/自检卡片）；errors.js
  补 `CREDENTIAL_NOT_FOUND` 文案；en/ja 词典补齐 34 条新文案。
- **文档**：新增 `docs/app-credentials.md`（安全模型/端点契约/授权流程/边界对照）；
  app-onboarding.md 指引接入方凭据落平台托管而非本地文件。
- **自测**：新增 18 条断言（加密落盘核验/双闸门 403/404 语义/轮换失效/审计零泄漏/自检/
  删除联动清库），落地页断言数 1749 → 1767；随包单测 `credentials.test.mjs` 6 条（含
  篡改检测 fail-closed 与重启解密往返）。

## [Unreleased] · Agent 身份纳管第三通道 headless + SSO 页负责人侧 entryUrl 登记（2026-10-31）

用户实测反馈：Work Body 等纯后台 Agent 接入后点「上线」被门禁拦住，而签发 SSO 客户端强制
要回调地址——没有交互界面的执行体既签发不了客户端也没有 entryUrl 可登记，无路可走。本批
补齐第三纳管通道并顺带修 UI 引导：

- **headless 声明通道**：Agent 属性新增 `headless`（boolean，tech 组）——无任何面向用户界面
  的执行体（Work Body、定时任务型等）显式声明后，上线门禁（`AGENT_SSO_ENFORCE=1` 默认模式）
  凭**已颁发的机器身份凭证**放行；未颁发凭证的声明不放行（无凭证放行等于无主体上线），
  `oidc` 严格模式不适用。声明写入属性、全程审计，挂单/执行双点校验对齐既有语义（审批期间
  撤销声明 → 执行期复核失败留痕）。
- **SSO 配置页重排**：纳管说明改为「三选一」按形态选路指引（有界面要免登 → entryUrl /
  有界面要标准协议 → OIDC / 无界面 → headless）；新增 headless 声明卡（声明/撤销、oidc 模式
  与缺凭证提示）；`entryUrl` 新增**负责人直接登记**表单（此前仅 Agent 侧自助提报，负责人在
  UI 无入口）；注册表单支持 boolean 字段渲染；概览页交互界面行识别 headless 声明。
- **i18n**：en-US / ja-JP 前后端词典补齐新增文案（含门禁新文案三语）。
- **自测**：新增 9 条断言（三无拒绝新文案 / 声明放行 / boolean 类型护栏 / 撤销后执行期复核
  失败 / 重新声明上线成功），落地页断言数同步 1740 → 1749。

## [Unreleased] · 产品首页回退到上一版（生态树）并换上科技蓝配色（2026-10-30）

维护者反馈「这版（冰晶）首页不好看」，按裁决回退公共产品首页，同时把上一版的浅蓝/青蓝
色调换成冰晶主题的科技蓝：

- **回退面**：`plugin-console/public/{js/pages/home.js, css/home.css}` 恢复为 PR #18 之前
  的「品牌叙事 + 资源生态树 canvas 特效 + 能力矩阵 + 架构理念 + 快速开始」版本；
  冰晶版首页专属的单测 `pages/home.test.mjs` 移除，CI 命令同步摘除该文件。
- **保留面**（未回退）：冰晶**主题系统**本身完整保留——`data-ui-theme=crystal` 主题变量、
  控制台「冰晶协同全景」透镜（`theme-lens.js` + `crystal-scene.js`）、随包 Three.js、
  en/ja 冰晶词典。回退只针对公共产品首页（`#/home`）。
- **科技蓝换色**：一次性品牌字面量从「元冰蓝 #0052D9 / 冰湖青 #00A3FF / 青蓝 #0A5F87 系」
  换为冰晶主题色系——主蓝 `#1466CF`、亮蓝 `#28B5EC`、深蓝 `#0E3A7A`，浅色阶（边框/背景/
  文字灰蓝）同步平移；微信绿 `#07C160` 语义色保留。canvas 生态树与星尘的 rgba 通道同源替换。
- **健壮性加固**（随回退补）：旧版首页的特效依赖 `canvas 2D` + `IntersectionObserver` +
  `requestAnimationFrame`，此前在能力缺席环境（headless/jsdom、禁用 canvas 的浏览器）
  会抛错并整页白屏。本次统一加能力缺席守卫：canvas 无上下文→跳过特效；无观察者→直接置
  终态（数字落终值、滚动显现直接可见）；无动画帧→数字直出，**降级后页面结构与全部文案仍完整可见**。
- 集成测试（`theme-integration.test.mjs`）首页段随之改写为生态树版断言，并顺带修掉一条
  依赖已删首页单测的 CI 引用。

## [Unreleased] · 执行中枢投影批次：面板任务血缘/验收裁决/目标读透（DeptAI-UI-DSH issue#3/#4 修订，2026-10-29）

落仓库反馈两_open issue 的最小修订集——面板=执行中枢投影，不复制权威状态（唯一任务事实源红线）：

- **任务血缘 additive（#3）**：`panel:tasks` 新增 `execIssueId / goalId / evidenceRefs[] /
  verdict / verdictBy / verdictAt / verdictOpinion / reworkOf` 字段；创建任务携带
  `execIssueId` 时必须能在 `exec:issues` 命中（不存在诚实 400，exec-hub 缺席 01门演示态
  亦诚实拒绝），血缘只能来自权威面，不再塞 detail 纯文本。
- **泳道迁移镜像回写（#3）**：`transitionTask` 对携带血缘的任务镜像 exec-hub 状态机
  （doing→in_progress 等）；镜像失败如实落审计 detail 不阻塞本地流转——对账面可查。
- **验收裁决（#4）**：新端点 `POST /api/panel/tasks/:id/verdict`（panel.task.write）——
  `accepted` 签认关闭（镜像 exec → done）/ `rework` 打回返工（镜像 exec → in_progress 重开）；
  同一任务不可重复裁决；结论+意见落任务与审计，`panel.task.updated` 事件随帧广播。
- **目标读透（#4）**：新端点 `GET /api/panel/:dept/goals`（panel.read）——exec-hub
  goals/issues 按部门绑定组织子树投影下发（目标含 metric 基线/目标值、任务含
  goalAncestry 血缘与面板关联 ID）；exec-hub 缺席 503 DEGRADED 诚实降级。
- **前台面**：IAW 执行空间新增「目标投影」视图（目标卡含进度条 + 权威任务表含血缘链
  `goalAncestry` 反解与验收动作）；任务四泳道卡片携带执行血缘 `⛓ exec` 徽标与
  签认/打回结论徽标。
- 已知边界（后续批次）：高风险动作的面板内审批闸口、kill switch/暂停派单/人工接管
  （issue#4 建议第 3/4 条）未在本批落地。

## [Unreleased] · 面板架构统一：底座侧部门面板整体收编为 DeptAI-UI-DSH 面板轨实现（2026-10-29）

维护者拍板「当前项目的部门面板全部砍掉，统一使用 01men/DeptAI-UI-DSH 的面板架构」。
底座仓 `packages/plugin-panel-core` 不再维护独立分叉——整包替换为面板轨（DeptAI-UI-DSH）
同名插件的实现（同 id `dsh-plugin-panel-core`、同 `panel` 服务键、同权限点、同路由族，
插件 id/服务契约零变化，全部消费方 dingtalk-bridge/console/CLI 零改动），自此面板架构
只有一份事实：上游在面板轨仓演进，底座仓跟随收编。

- **SPA 整体换代**：旧「五部门面板」前端（dept.js + en/ja 词典 + i18n.js）退役，
  换为 IAW 六空间工作台（协作/图谱/执行/能力/数据/制造；SPACE_META 导航 +
  行业主题 data-industry + Agent 协作栏 + 会话执行卡 + 连接宿主向导 + SSE 优先轮询降级
  实时通道）。面板 SPA 词典层随之摘除（IAW 为中文直出零词典架构），
  console `/locales/:locale` 合并端点同步移除 panel 词典目录层。
- **服务端软依赖瘦身**：inject 从 13 键硬依赖收敛为数据面基座 5 键
  （httpServer/opsStorage/platformBus/tools/scenegraphs），iam/authn/audit/usage/
  modelgw/resourceCore/skillHub 转运行期软读 + 端点级诚实降级（503 DEGRADED）；
  新增 demoAuth/landingRedirect 装配开关（仅 01门装态声明，全量形态缺省关闭、行为不变）。
- **回植底座侧治理语义（6 项）**：①`PANEL_CONTRACT_VERSION` 契约版本导出（#13）；
  ②#17 组织兜底链 `resolveOrgId`（caller→dept.orgId→根组织，机器主体点名不再
  「已应答、usage org 必填」）覆盖 invoke/stream/ask/skill 全部计量与网关调用点；
  ③A-01 场景级授权 `sceneGuard`（任务挂 sceneCode 时强制裁决，deny/fail-closed→403）；
  ④D09/V16 技能证据化 `skillLoad`（REST 与工具面同构透传）与受管数字员工问答分型
  `workforce` 标注；⑤ddws pull 部门取向自频道反查修正（平铺路径下原实现必 400）；
  ⑥基线管理员种子以 demoAuth 门控（全量形态种子权归 console，消除双种子竞态）。
  另修复收编版本 `invokeAgent/streamAgentReply` 审计路径 `asset/model` 坏引用
  （prepareAgentInvocation 现随 ok 载荷返回 asset）。
- **行业登记升级为工信部 2025 版 14 行业**：钢铁/石化/工程机械/机器人/汽车/医疗装备/家电/
  制糖/白酒/美妆/锂电/印制板/智能终端/民爆；QB01/YB01/JB01 图谱包随平台分发默认激活，
  其余 11 行业走「申请→审批→激活」链路。`platform-core/scenegraphs/` 数据目录
  同步扩为 14 包（原 qb01/gcjx 两包退役，工程机械编码更替 GCJX→JB01）。
- **面板自持登录路由归属归一**：`/api/panel/auth/login|refresh` 处理器由 console 移交
  panel-core 自持注册（authn 转发、响应形状逐字段一致），console 不再重复登记
  （避免 health 契约 declaredRoutes 双计）。
- **连通性实测**：契约比对 0 红（501 代码路由 / 519 清单声明）；起服实测 health 契约
  26 能力族 + 59 条面板路由、/panel 302 归一、IAW 壳页伺服、面板自持登录链全通；
  selftest 面板三节（数据面/扩展面/J1 直调）+ #17 机器主体点名全绿。

## [Unreleased] · README 定位重写：从「堆工具」到「新生产关系的运行底座」（2026-10-29）

- 根 README 以「新生产力 vs 旧生产关系」重写产品定位：新增「堆工具为什么不管用」
  （生产关系三问：人与生产资料、分工协作、价值分配）与「元冰可 AIOS 是什么：新生产关系的运行底座」两节；
  以五要点对照表（人与生产资料 / 分工 / 人与权力 / 协作 / 价值分配）说明平台各基本盘
  （资产登记确权、目标-任务派单、可授权可审计的智能体调动、插件树协作、幂等计量）与重塑点的对应关系；
  原「一个面向协作与治理的 AI 平台」四要点并入定位论述，接入与运维章节不变。
- 术语契约 GLOSSARY 升 v1.2：新增「十、定位论述术语增补」（生产关系 / 生产力 / 运行底座 /
  确权 / 动态派单等 11 条，中英日三语）。
- English 版同步翻译重写（源文标注 2026-10-29 positioning rewrite）；日本語版 `stale: true`
  标注补记定位重写，待下次校正统一更新；Agent 视图按既有分工不承载产品定位，无需改动。

## [Unreleased] · 面板域扩展整体收编：战略看板 / 制造工具箱 / 本地钉钉面 / Agent 流式应答（DeptAI-UI-DSH 前台 #2 底座半，2026-10-29）

维护者拍板「全部收编生效」后，DeptAI-UI-DSH 前台仓 panel-core 的 21 条扩展路由整体并入 main
（此前按 handoff F 清单留定制分支；并入后 gate-01 前台对 main 宿主的 23 条缺口全部闭环，
另 2 条 panel-auth 已在上批补齐）：

- **战略看板 `GET /api/panel/board`**（panel.read）：卡片包（card pack，角色 × 平台过滤、
  失效资产引用过滤 + 告警）+ 漏斗（曝光/点击→调用→完成）+ WAIC 周聚合 + ROI 替代工时估算
  （估算口径声明随响应下发）。卡片包 5 平台 JSON 随包分发，`CARDPACK_DIR` 可覆盖。
- **制造工具箱 `/api/panel/mfg/*`（10 条）**：13 个确定性计算内核（OEE/CPK/帕累托/EOQ 等）
  + 3 个 AI 工具（Skill 放行制：评估→人工审阅→签署放行，fail-closed）+ 100 项选题清单
  （来源追溯 PMO 行号 + PDF 页码）。目录/选题/模板/执行/导出为 panel.read/write，
  评估发起与放行签署为 panel.config.write（放行是治理动作）。配套 `panel_mfg_*` 工具族 ×3；
  对外原因码 `MODEL_NOT_CONFIGURED`（面板零密钥铁律，诚实 503）与 `INTERNAL_ERROR`
  补入前端文案注册表。
- **本地钉钉面 `/api/panel/ddws/*`（8 条）**：dws CLI 桥（钉钉官方命令行）——状态/一键安装/
  设备流登录（激活指令弹窗直出）/群绑定/连通性测试/入向消息拉取（按 messageId 幂等去重落库）。
  与宿主 plugin-dingtalk-bridge **共存不互斥**（命名空间铁律：绝不碰 /api/dingtalk/*）；
  消息 ddSync 出向按「群桥在场让位宿主桥，否则 dws 投递」事件时裁决。CLI 缺席全部诚实降级
  （200 + ok:false，降级是数据不是传输错误）。
- **Agent 流式应答 `POST /api/panel/:dept/agent-stream`**（panel.write，SSE-over-POST）：
  @数字同事 → 逐事件 start/delta/done/fallback；`messages` 面新增 `streamAgent` 参数
  （跳过隐式派发防双跑）。与 invokeAgent 同一决策链（资产绑定/模型取向/#17 组织兜底/
  V16/D08 分型标注/审计留痕/D1 协作计量同键幂等），`<think>` 思考块经门控不进正文；
  modelgw 当前非流式单轮 → 整段单个 delta（不造假打字动画），网关长出 streamEvents 自动走增量。
- **`panel_board_digest` 工具**：战略看板摘要的工具面同构（panel.read）。
- **移植修正**：`ddws/pull` 原实现按 `:dept` 路径参数解析部门，平铺路径下必 400（前台仓潜在 bug）——
  改为自 channelId 反查频道归属部门并做组织范围校验。
- 契约同步：panel-core manifest 登记 21 路由 + 4 工具；health `contract.panel` 能力族实时
  扩容（board/mfg/ddws/agent-stream）；加载屏 486 REST 路由 / 96 MCP 工具。
- selftest 1697/1697 全绿（本批新增 29 断言：流式事件链/隐式派发跳过/幂等计量/跨部门拒绝 7 条，
  看板聚合与越权、mfg 真实执行/导出/放行越权、ddws 诚实降级与绑定 22 条；错误文案映射扫描同步扩容）。

## [Unreleased] · #13/#14 复核残留闭环：契约自描述 + 面板自持登录面 + 存量计价识别（2026-10-29）

复核报告（截图）指出两项已关闭 issue 仍有残留，逐项核实属实并修复：

**#13 残留：capabilities 声明 `board` 但 `GET /api/panel/board` 404（「契约不实」）**

- 根因：capabilities 只是**路由族名**（`board` = 「有 board 族路由」），实际形状是
  `/api/panel/:dept/board`——按字面拼平铺 URL 必然 404，契约没把可调形状告诉前台。
- 修复：`contract.panel` 新增 `routes[]`（additive，method+path 从 declaredRoutes 实时推导）——
  `:dept` 参数化路由、写-only 族（agents/config 仅 PUT）、scenegraph/scenegraphs 并存族全部
  显式可见，前台按路由模式对齐调用形状，不再「声明了能力但按字面调就 404」。
- 顺带闭环**前台 #2 复核残留中的 panel-auth 404 欠账**：`/api/panel/auth/login`、
  `/api/panel/auth/refresh` 此前仅登记公开白名单、处理器从未合入 main（源码注释自认
  「先行登记，合入后即闭环」）——现与 `/api/auth/*` 同一 authn 后端、同响应形状补齐注册，
  面板本页登录/刷新不再 404。

**#14 残留：成本仍全零且 `priced=0/notPriced=0`（两个桶都没进）**

- 根因一（价格簿全零）：6/6 模型 `costCentsPerKTokens=0` 属运行时数据（模型经管理端登记时
  未填费率），非代码缺陷——计价链路按「全零费率 = 未定价」处理是正确语义；**补录真实费率
  仍是运营动作**（管理端模型表单已含输入/输出单价字段，价格簿按调用时点读取、即时生效）。
- 根因二（双零盲区，代码缺陷，本次修复）：`/api/usage/summary` 的 `not_priced` 判定只认
  修复后新增的标注字段——**存量事件**（标注引入前入账）既进不了 priced 也进不了 notPriced。
  现读侧按零费率快照（`rate.list=0 且 rate.cost=0`，存量事件 rate 快照恒在）识别存量零费率
  事件为 not_priced，**免一次性迁移**；费率在配但量小取整为 0 仍算 priced，rate 缺失保守计 priced。
- audit 成本报表行新增 `coverage`（`live`/`legacy`/`mixed`）：存量 CostRecord（无覆盖率字段）
  与被新事件合并过的存量桶（`legacyUncounted` 标记）不再把「存量未知」误读成「在档 0」，
  门禁可区分「归集可信」与「需回填/待费率」。
- mfg×10 / ddws×8 / agent-stream 仍 404 属**定制面板域自研面**（handoff F 遗留采纳清单明确
  「main 不消费，留定制分支另行评估」），不属本仓欠账；health 契约 `routes[]` 已让宿主实际
  支持面对前台显式可协商。

- selftest 1668/1668 全绿（本批新增 8 断言：契约 routes[] 与能力族对账、面板自持登录/刷新
  401→200、存量零费率读侧识别与取整为 0 不混读；清单 lint 同步登记两条新路由）。

## [Unreleased] · README 三视图：中文 / English / Agent（2026-10-29）

- **README 拆成三种视图**，共用同一套事实，面向不同读者：
  - 根 [README.md](README.md)（简体中文，默认）、[docs/i18n/en/README.md](docs/i18n/en/README.md)（English）
    为产品视图，结构对等：定位 → 界面证据 → 快速开始 → 架构 → 接入 → Agent 入口 → 运行边界 → 文档索引。
  - 新增 [README.agent.md](README.agent.md) 与 [docs/i18n/en/README.agent.md](docs/i18n/en/README.agent.md) 为
    Agent 视图官方入口：接入点、操作边界、身份与权限模型、计量与成本、失败语义，面向 MCP 客户端 /
    dsh Agent / CI 脚本。每页顶部有视图切换。
- **英文版按现中文版重写**：原 `docs/i18n/en/README.md` 为 2026-10-15 基线（386 行），与本轮精简后的
  中文版已脱节（旧插件树全景、M0 合规长章、过期计数）。新版对齐现行口径 —— 25 个插件清单 /
  9 份运维 Skill / Node ≥ 22.6 / `DEMO_MODE` 与 `DEMO_SEED` 语义。
- **易变数字不再写进 README**：工具数、路由数、权限点、断言数一律以目标实例运行时为准
  （`/api/openapi.json`、`/mcp`），文档只说明「会随版本与调用方权限变化」——避免再次出现文档与
  实测不一致。
- **真实界面截图为证据**：产品视图引用仓库内演示实例截图（数字员工 / MCP 服务 / 审批审计），
  并标注为演示数据；不引入外部素材、不使用装饰性图形。
- 日文版标 `stale: true` 并加视图导航：原典基准日 2026-10-15，待下轮校正；指向中文、英文与
  Agent 视图作为最新口径。
- 联动：`llms.txt` 阅读入口补 Agent 视图与英文版；npm `files` 增补 `README.agent.md` 与
  `docs/i18n`（离线部署不再缺件）；`docs/i18n/README.md` 目录结构登记新页。

## [Unreleased] · 协作主通道组织兜底与计量 fail-fast（issue #17，2026-10-29）

- **面板三处模型调用组织兜底链**（频道点名 / 工具面 askAgent / 技能直调）：调用方用户组织 →
  部门绑定组织（R11）→ 平台根组织，`orgSource` 随审计留痕——机器主体 / 外部工具通道没有用户
  归属时不再拿空串打到计量校验上。
- **modelgw fail-fast**：`invokeTracked` 入口先校验 `orgId`，空串在调用上游**之前**拒绝——
  杜绝「模型已应答、token 已消耗，计量落账才抛『usage 事件 org 必填』」的先花钱后报错
  （该形态同时导致该次成本未入账，污染 #14 的成本口径）。
- selftest：modelgw 空 org 拒绝、机器主体点名 Agent 成功、panel:* 计量入账。

## [Unreleased] · README 整改与 CLI 预演安全（PR #12 合并，2026-10-29）

- **README 重写**：突出数字员工协作、可信治理、真实界面与最短接入路径，移除重复介绍、
  过期数字与历史过程叙述；Agent 索引同步精简。
- **CLI 预演默认拦截（fail-closed）**：`--dry-run` 不再静默放行不支持预演的写请求——仅已实现
  预演的命令（MCP 部署、连接器执行、平台更新）可出变更预览，其余写请求直接拒绝并说明；
  本地脚手架创建与删除确认同步保护。自带 `cli/tests/dry-run.test.mjs` 覆盖。
- **发布包补齐**：Skill（九份运维 Skill 增加可发现元信息）、CLI 与 llms.txt 纳入 npm `files`，
  离线部署不再缺件。
- **部署文档纠错**：修正 dsh 挂载路径与多进程共享数据目录的错误说明。

## [Unreleased] · 控制台四套可切换主题（PR #11 合并，2026-10-29）

- 控制台新增四套界面主题：**经典原版 / 澄明经营总览 / 星图协作关系 / 夜航治理观察**——驾驶舱内
  单击切换，其他页面走顶栏切换；选择存浏览器本地，独立于平台身份主题，原有五个工作台视图、
  路由与演示只读限制不受影响。
- 星图主题按需加载本地分发的 D3（任务状态 / Token 趋势）与 Cytoscape（目标-项目-任务-数字员工
  真实关联图，支持拖拽/缩放/节点选择，最多 60 节点，缺权限/无数据/组件失败均有降级），不引前端
  构建步骤、不走第三方 CDN；依赖附许可文件随包分发。
- 数据全部来自既有只读接口；关系线表示登记的父子/归属/指派关系，不冒充实际调用。
- 自带前端单测（theme / theme-integration，jsdom + headless）与 `timer-permission.test.mjs`
  定时器生命周期回归；合并冲突解决口径：exec-hub/connect/CLI/文档的修复块一律以 main 已落地
  版本（#7/#9/#10）为准，仅保留主题与测试增量，selftest 1657/1657 全绿。

## [Unreleased] · GitHub 反馈修复批次二（issue #13 / #14 / #15 / #16，2026-10-29）

**#16 exec 域组织血缘断链（goals/projects/issues 空串 orgId 落库）**

- 创建路径收口：显式空串 orgId 一律 400（缺省请不传）；缺省时按继承链自动归属——调用主体组织
  （console 统一 principal 反查的 `unified.orgId`）→ 血缘（任务沿项目/Agent、项目沿目标）→ 平台根组织。
  服务层 `assertOrgInput` 双重校验（空串拒绝 + 组织存在性），REST/MCP/内部调用同源生效。
- 存量迁移：启动时把 exec:goals / exec:projects / exec:issues 的空 orgId 记录归根组织，幂等且留
  审计（`exec.orgid.migrate`）；组织树未播种时跳过、下次启动补齐。
- `/api/exec/goals|projects|issues` 增加 `?orgId=` 过滤（组织范围看板/成本/配额的数据面）。
- selftest：缺省创建必带归属、空串 400、裸任务兜底归属、goals/issues 过滤命中，共 5 断言。

**#15 OIDC discovery issuer 硬编码环回地址（公网域名远程 SSO 不可用）**

- issuer 解析改为三级：`OIDC_ISSUER` 显式声明（多域名/严格部署的固定锚点，最高优先）→ 按请求
  `X-Forwarded-Proto` + `X-Forwarded-Host`/`Host` 派生（与 console requestOrigin 同口径）→ 回落
  `http://127.0.0.1:<port>`。公网域名反代部署 discovery/authorize/token/userinfo 端点自动对齐对外
  origin，远程 SSO 开箱可用（反代需透传转发头，或显式声明 `OIDC_ISSUER`）。
- 请求上下文贯穿签发与校验面：discovery、completeAuthorization（RFC 9207 iss 回跳）、
  issueTokenSet（token iss）、userinfo / end_session / revoke（verifyJwt 经 `acceptedIssuers` 同时
  接受静态与请求派生 issuer）——同请求面自洽，跨域名混用令牌仍被拒（多域名请固定 `OIDC_ISSUER`）。
- dsh-bridge OIDC 登录通道（/auth/oidc/start|callback）、console 三处 discovery 展示、portal 令牌
  解析同步改为按请求派生；docs/app-sso-integration.md、deploy-enterprise.md、协议键对照表更新。
- selftest：转发的 Host/proto 派生 issuer、环回自洽共 2 断言；dsh 挂载段断言改按请求入口地址。

**#14 成本归集恒 0（token 有计量、成本无依据，0 被误读为「零成本」）**

- 模型目录增加 `inputCostCentsPerKTokens`（分/千 tokens）：输入 token 与输出分开计价。modelgw
  invoke 时点从价格簿读取双费率，以**组合计价行**（`costLineItems`，additive-only）入 usage 事件，
  成本 = Σ 行计价；快照 `rate.line_items` 原样留痕可复算。价格簿仍是唯一调价面（model:<slug> 与
  新增 model:<slug>:input 两个条目，upsertModel 自动同步）。
- 「未知 ≠ 零」语义（fail-closed）：快照新增 `pricing.cost_status`——费率未配/全零费率导致的 0
  标 `not_priced`；费率在配但量小取整为 0 仍算 priced。`/api/usage/summary` 暴露
  `not_priced_events`（总/分资源），预算护栏与净效果据此判断「成本是否可归集」。
- audit 成本报表覆盖率：CostRecord 增 `pricedEvents/notPricedEvents`（additive），消费侧按事件
  分类累计；`audit_cost_report` 与 `/api/audit/cost` 每行返回 `priced/notPriced`。
- 修复管理端静默清零：模型保存路由此前 `costCentsPerKTokens ?? 0` 会把未填费率的保存把价格簿
  清零；改为缺省保留既有值。网关/FinOps 页模型表单补输入成本字段，目录表加输入单价列。
- selftest：双米组合计价 14 分、快照 line_items 留痕、summary 覆盖率、成本报表 priced/notPriced，
  共 4 断言。

**#13 /api/health 无面板契约版本（前台宿主版本偏差静默 404）**

- `/api/health` 暴露 `contract.panel`：`version`（panel-core 导出 `PANEL_CONTRACT_VERSION`，
  能力族语义变化时递增）+ `capabilities`（从 declaredRoutes 实时推导的面板能力族：board/widgets/
  channels/tasks/stream/scenegraph/spa 等）+ `depts`（已配置部门）+ `apiRoutes` 计数（与
  /api/openapi.json 对账）。前台（DeptAI-UI-DSH）按能力清单判断宿主支持面，偏差 fail-visible；
  跨仓 CI 断言（frontend ⊆ host）在前台仓按同一契约消费。
- selftest：契约三元组（version/capabilities/depts）断言 1 条。

断言总数 1645 → **1657 全绿**（Node 24.21.0 实测；含四个 issue 的行为级回归与 #15 挂载形态断言修正）。

## [Unreleased] · GitHub 反馈修复批次（issue #7 / #8 / #9 / #10，2026-10-29）

**#10 定时器静默失效（cordis ctx.effect 误用，波及全仓库 10 处）**

- cordis 4.0.4 的 `ctx.effect(fn)`：fn 在注册时**立即执行**，返回值才是清理函数。exec-hub 心跳循环
  此前用单层箭头把 `setInterval`/`setTimeout` 在装配期当场清掉——进程重启后内置 tick 永不运行，
  routine 唤醒/心跳永不入队，Agent 健康度全部 silent 且无日志报错（生产实测重启 18h 后才发现），
  唯一可用通道只剩管理员手动 `POST /api/exec/tick`。
- 同类误用一并修复（同一 bug 类）：plugin-iam 连接器自动同步、plugin-authn 令牌清理 ×2 与
  OIDC/入场票据清理、plugin-nas 分享链接清理、plugin-a2a 例行巡检、plugin-usage 保留策略、
  plugin-workforce 台账巡检、platform-core behavior 消费者表清理——全部改为 `ctx.effect(() => () => { … })`
  返回 disposer 的正确写法。
- selftest 新增端到端断言：短周期定时器隔离实例（`EXEC_HUB_TICK_MS=600`）**零手动 tick** 亦自动
  入队心跳唤醒——该缺陷此前完全无测试覆盖（既有断言全用手动 tick 驱动）。

**#7 只读 Agent 心跳被 exec.write 拦死**

- `processWake` 权限解耦：存活心跳只要求 `exec.read`（评价官/验收官等职责分离只读角色照常参与
  心跳调度），`exec.write` 移到真正写路径收口——无 issue 心跳：无待办 `skipped_no_todo`/done；
  有待办但只读以 `skipped_permission` 非错误收尾（不再每一拍 `status=failed`）。任务执行路径
  （issue 派发）仍要求 `exec.write`，边界不放宽；身份未纳管（连 `exec.read` 都没有）保持 failed。

**#8 Agent 模型枚举与模型目录两套口径（单一事实源）**

- `attrs.model` 废除硬编码三值枚举（deepseek-chat/reasoner/coder）：可选值 = 模型网关目录
  （`modelgw:models`）。登记 / PATCH（提供 model 时）/ 上线门禁三处 fail-fast 校验「目录中存在」，
  错误即列可用 slugs；目录 online 状态与渠道就绪属运行时事实，由 modelgw invoke 权威 enforce。
  空目录放行（全新部署引导期不锁死 Agent 登记）；modelgw 未装配时跳过（异常装配降级 legacy）。
- 目录读取走 `ctx.reflect.get('modelGateway')` 软读——严格注入下直访会被 get trap 硬抛
  「without inject」（exec_claim 同款坑，1b31af2 的教训复用）。
- 演示种子补齐 `deepseek-reasoner` / `deepseek-coder` 目录条目（此前 4 个种子 Agent 配了目录外模型，
  即本 issue 事故形态）；upsertModel 前移到 Agent 注册之前（校验依赖目录先就位）。
- 控制台注册表单「底层模型」改从 `/api/modelgw/models` 动态取选项（online 在前、offline 标注，
  拉取失败退回手填）；`agent_register` 工具描述同步指向目录。
- selftest：登记/PATCH 目录外模型 400（含可用 slugs 提示）、上线门禁 fail-fast（目录条目删除后
  上线即 400，不再「上线成功、派发才失败」）。

**#9 connect 缺「执行方」接入模板**

- 新增 `executor` 模板：只读 + `exec.write` 任务认领/执行 + `usage.write` 用量自报，不含账号与
  凭证管理——远程 dsh/Agent 承担任务执行不再被迫二选一（`operator` 无法认领 / `full` 等价管理员 `*`）。
  `operator` 模板描述同步明确「不含任务执行」。接入码创建校验、connect_code_create 工具枚举、
  控制台模板表、CLI 帮助、docs/deploy-enterprise.md 模板表五处同步。
- selftest：executor 模板签发 → enroll → 机器令牌调 `exec_claim` 不再 403（业务层「任务不存在」
  才是预期失败）、生效权限含 `exec.write`/`exec.read` 且不含账号凭证管理；对照 operator 仍 403。

断言总数 1621 → **1645 全绿**（Node 24.21.0 实测；含 #10 内置定时器隔离实例与 #7/#8/#9 行为级回归）。

## [Unreleased] · 治理令牌自愈刷新健壮化与告警出口收敛（gov-token / gov-refresh，2026-10-28）

- `scripts/refresh-governance-mcp-tokens.mjs`（治理双身份 MCP 令牌自愈刷新入库，org 自动化
  gov-token 作业每小时调用）三处健壮化：
  - **写回核验（防假绿）**：刷新后重读 DSH 存储断言两连接 `updatedAt` ≤ 120 分钟且令牌未过期、
    连接器应答 ok，任一不成立非零退出——杜绝「脚本绿、令牌已断」的假成功。
  - **续期窗口 30 → 90 分钟**：TTL 120 分钟 + 每小时巡检节奏下，30 分钟窗口漏一次触发即过期
    （10-27/28 实际断链 21 小时）；90 分钟窗口容忍任意单次漏触发不断链，org gov-token 作业同步显式传参。
  - 换牌 / 连接器网络层异常并入告警出口（原先走未捕获异常绕过 fail）。
- 告警出口收敛为 DSH 基座本地闭环：硬失败统一落盘 `data/governance-refresh-alerts.jsonl`
  （org daily 作业 D-GOV-ALERTS 断言消费）+ macOS 本机通知（osascript，launchd gui 域可直接弹出）；
  平台面板告警由 org gov-token 作业边缘触发投递，钉钉外推交平台钉钉桥接——脚本层不再需要任何
  本地 webhook / secret 配置。
- selftest：管理员编辑 Skill 断言对齐分类统一口径（「研发效能」→「研发」，原值保留进 tags）。

## [Unreleased] · Skill 市场改名 + exec_claim 软读修复 + 自动化闭环实测（2026-10-28）

- 控制台板块改名「AI 市场 → Skill 市场」：导航 / 命令面板 / 页头 / 三语键 / 冒烟用例名同步。
- `exec_claim` 受管探测改 `ctx.reflect.get` 软读：修复装配 workforce 后调用必炸
  「cannot get property without inject」（生产实测发现，闭环脚本首次跑通即暴露）。
- 新增 `scripts/run-closed-loop-review.mjs`：执行中枢自动化闭环驱动（立案 → 心跳 → 唤醒 → 认领 →
  审查 → 交回 → 脉络回读 → A2A 追踪），幂等可重跑；配套 `scripts/refresh-governance-mcp-tokens.mjs`
  将治理双身份 MCP 令牌刷新纳入自动化。
- 实测：三官心跳 30 分钟全部 healthy；血缘 / 唤醒 / run / A2A 任务追踪公网可读；ybkk 子域复核 200
  （方案 V2.2 已落地）；闭环审查与修订记录见 `docs/internal/ybkk-subdomain-closed-loop-review-20261028.md`。

## [Unreleased] · 各资产板块标签分类统一（2026-10-28）

- 平台资产统一业务分类口径固定为 11 项：**财务 / 行政 / 人事 / 销售 / 运营 / 战略 / 生产 / 研发 /
  质量 / 制造 / 其他**（`platform-core/src/taxonomy.ts` 单点定义）。Skill 市场 / Agent 本体 / AI 应用 /
  MCP 服务 / A2A 协作目录五个板块全部接入；连接器目录为外部网关同步数据，暂不套用。
- **Skill 市场**（对齐市场样式）：分类筛选条固定返回标准 11 项（不再随数据漂移），存量遗留分类附后可筛；
  搜索关键字覆盖扩展为名称 / 简介 / 描述 / 标签 / 分类 / 作者（搜索框占位符同步）；提交与编辑表单分类
  选项换为标准 11 项，写入侧自动对齐（如「研发效能」→「研发」），非标准原值保留进 tags 不丢信息。
- **Agent 本体 / AI 应用**：属性表新增「业务分类」枚举字段（注册表单缺省「其他」，存量数据校验不受影响）；
  列表页新增分类筛选（Agent 卡片/表格与 AI 应用卡片展示分类徽标；AI 应用页补齐搜索 + 分类筛选条）。
- **MCP 服务**：登记/更新支持 `category` 字段（写入归一化），页面新增搜索 + 分类筛选条，卡片与详情展示分类。
- **A2A 协作目录**：目录条目透出业务分类并支持按分类筛选，员工卡片/详情展示分类。
- 存量数据迁移：`scripts/align-asset-categories.mjs`（幂等）把 `skill~skills.json` 遗留分类对齐到标准 11 项
  （原值保留进 tags）并为存量 MCP 服务补缺省分类；演示 seed 的技能/Agent/应用/MCP 分类同步换新口径。
- 三语文案补齐（en-US / ja-JP）；selftest 1621 项全绿。

## [Unreleased] · GitHub 反馈修复批次（issue #4 / #5 / #6，2026-10-27）

**#6 OpenAPI 接口面发现 + SPA 兜底收口**

- 新增 `GET /api/openapi.json`（authenticated）：由 httpServer 的 `declaredRoutes` 路由台账运行时投影为
  OpenAPI 3.0.3 原始文档（不包 `{ok,data}` 信封，Swagger UI / 代码生成器直接消费）。每个操作携带
  `x-auth`（guarded / authenticated / public / outside-api 精确声明）与 `x-permission`（权限点），
  `:id` 段转 `{id}` 并逐一声明 path parameters；分类计数与 `/api/platform/route-matrix` 逐类吻合
  （selftest 固化：guarded 425 / public 27 / authenticated 11，operationId 全量唯一）。
- 静态兜底收口：带扩展名的资源路径未命中（`/openapi.json`、`/js/missing.js`、`/docs/x.md`、
  `/docs/../package.json` 归一后的 `/package.json`）不再回落 `index.html` 200 HTML，改 404
  `NOT_FOUND` JSON——「看似 JSON」的路径回 200 HTML 曾让 Agent 接口探测与 interface-check 假阳性；
  无扩展名前端路由（hash 路由深链接）与真实静态资源行为不变。
- 加载屏 REST 路由数 462 → 463（index.html + en-US / ja-JP 词典同步）；README 路由数按运行时实测校正
  450 → 463；plugin-console manifest api.yaml 登记新端点。

**#4 Node 22.6–22.17 可运行性（engines 承诺落实）**

- `scripts/selftest.mjs` 此前顶部静态导入 `.ts` 源，在类型剥离未默认开启的 Node（22.18 / 23.6 之前）
  上父进程在任何断言前即 `ERR_UNKNOWN_FILE_EXTENSION` 崩溃。现改为顶层 `await import()` 装载，并加
  版本守卫：未默认开启且 `NODE_OPTIONS` 未带 flag 时以 `NODE_OPTIONS=--experimental-strip-types`
  自重启——子进程（隔离实例、各 `*.test.mjs`）一并继承，一处守卫覆盖整条链。
- npm 脚本 `start` / `lint:manifests` / `lint:boot-order` / `test:contracts` 与 Dockerfile CMD 内联
  `--experimental-strip-types`（Node ≥ 22.18 上为静默 no-op）。
- CI `quality-gate` 增加 Node 22.14 轨（与 24 并行矩阵），守住 `>=22.6` 声明；README / CONTRIBUTING
  补充版本说明。

**#5 dsh bundle 安装后 rq-card `ERR_MODULE_NOT_FOUND`**

- 根因（实证）：client-modules 的 `locatePkgJson` 取条目首段包名、再向上找名字完全匹配的 package.json，
  rq-card 条目只能写裸包名 `@dsh-ops/plugin-rq-card`，因此必须能从 profile 根解析；而根 `package.json`
  此前 `dependencies` 为空，`workspaces` 只在仓库内生效，单包安装进 profile 后该包缺席。
- 修复：根 `dependencies` 声明 `"@dsh-ops/plugin-rq-card": "file:packages/plugin-rq-card"`——dsh profile
  为 pnpm `nodeLinker: hoisted`，copy 安装（`github:` / `file:`）时 pnpm 会把它 hoist 到 profile 根
  （模拟 profile 实测 `createRequire(profile).resolve(...)` 成功）。仓库内 `npm install` 行为不变
  （workspace 链接复用）。
- link 安装（`dsh plugin add /path`，不带 `file:`）属 pnpm 语义限制（不装被链接包的依赖），README 与
  `cordis.patch.yml` 明示需再 `add /path/packages/plugin-rq-card` 补一条链接；纠正了「workspace 包随发布/
  安装链路就位」的误导性注释。

断言总数 1610 → **1621 全绿**（Node 24.21.0 与 22.14.0 双版本实测）。

## [Unreleased] · AI 自治治理闭环（MCP 工具面补全）

**登记/评审工具面（+6 个 MCP 工具，86 → 92）**

- 平台 `/mcp` 此前管理面「评审强、登记弱」：MCP 服务登记/verify/终审、Agent 登记/上线提请、
  AI 应用登记只有 REST 入口，审批待办也无法经 MCP 发现。本次补全（权限点全部复用既有目录，无新增）：
  - `approval_list`（plugin-audit，`approval.read`）：审批列表查询（状态/类型/关键字过滤），
    自治闭环入口——先发现待办再 `approval_decide`。
  - `mcp_service_register`（plugin-mcp，`mcp.service.write`）：登记 MCP 服务（draft 态）；
    工具清单风险缺省 unknown（与 REST 同口径不隐式 read）；敏感凭证不入工具参数（走 credential API）。
  - `mcp_service_review`（plugin-mcp，`mcp.service.deploy`）：verify（真实探活）/ final-review
    （公司级终审水印）/ sync-tools 三动作，补齐 draft → verifying → online 状态机的 MCP 面。
  - `agent_register`（plugin-agent，`agent.write`）：登记数字员工（draft + 机器凭证签发）；
    schema 必填 attrs（description/model/riskLevel）在工具描述中显式声明。
  - `agent_transition`（plugin-agent，`agent.approve`）：submit_trial / online / archive 流转；
    online 提请仍生成 L4 审批单（职责分离不旁路）。
  - `app_register`（plugin-app，`app.write`）：登记 AI 应用（可编排已上线 Agent，签发机器凭证）；
    developerId 校验与 REST 同口径。
- 登记类工具身份一律取令牌（`exec.principal` fail-closed），动作落 `audit` 变更哈希链
  （agent.create / mcp.service.create / app.create 等与 REST changeLog 同口径）。
- 修复既有缺陷：`mcp_deploy`/`mcp_offline` 工具运行时访问 `ctx.resourceCore` 未声明 inject，
  /mcp 链路触发 `cannot get property "resourceCore" without inject`——mcp-tools inject 清单补齐
  （`iam`/`audit`/`resourceCore`）。
- 清单同步：四个插件 manifest api.yaml tools 声明补齐，契约比对工具 97/97 零红；首屏计数
  文案 86 → 92（index.html / launch / en-US / ja-JP locale 同步，含词典 key）。

**AI 自治治理双身份接入**

- 新增 `scripts/register-governance-credentials.mjs`：一键签发「治理执行官（`'*'` 全权）+
  治理评审官（只读 + 审批决策）」双机器身份。单凭证无法闭环 agent.online（R12 职责分离
  提交人≠审批人，且 `/mcp` 服务端强制 approval_decide 审批人=令牌身份）——双身份让自治
  链路天然满足职责分离。幂等可重跑（查重复用 / `--rotate` 轮换），凭证落盘 0600，
  自验（换牌 + tools/list + approval_list）后输出 MCP 客户端接入配置。

## [1.5.0] · 2026-10-22 · AI 平台 MCP 治理与身份权限整改

**统一身份与委托令牌**

- 平台新增统一 Principal（`UnifiedPrincipal`）：控制台鉴权中间件是唯一权威装配点，
  verify 后组装 `CallerInfo` 兼容超集 + `unified` 字段——bridge / A2A / NAS OBO / MCP invoke
  等消费面一律读 `unified`，从请求参数或 header 声明身份一律无效（参数伪造身份防线）。
- 新增委托令牌交换 `POST /api/authn/token/exchange`（RFC 8693 风格）：人类调用者可为目标
  Agent/应用签发 OBO 令牌，机器凭证可换取 `sub=用户` 的委托令牌；audience 强校验
  `mcp:service:<slug>` / `plugin:<id>` 形态；TTL 默认 900s 上限 3600s，act 链（human 之后）
  跳数上限 4；授权事实 fail-closed（守卫未注入一律拒绝）；账号冻结即时吊销其被代理令牌。
- `X-On-Behalf-User` 降级为**仅归因**（审计口径），不再是授权事实：授权一律以令牌及其委托链为准，
  代用户操作优先改用委托令牌；NAS 侧保留 header 兼容并标记 `delegationSource`（token / header-legacy）。

**服务级 MCP 数据面**

- 新增服务级 MCP 端点 `POST /mcp/services/<服务slug>`（别名 `POST /mcp/s/<服务ID>`）：标准
  Streamable HTTP（JSON-RPC 2.0 over POST），initialize / ping / tools/list / tools/call 全量支持；
  Bearer 令牌 audience 强校验（`AUDIENCE_MISMATCH` 即拒）；调用统一走既有网关链
  （鉴权 / 权限组 / 限流 / 熔断 / 风险 / 审计 / 计量），长令牌不出域。
- `tools/list` 按调用方权限过滤：权限组 allowedTools 交集 + 只读约束过滤写工具 + 高敏数据类无授权
  不出现——列表即边界，不在列表中的工具调用返回 `-32003 TOOL_NOT_VISIBLE_OR_DENIED`（拒绝路径与
  列表过滤一致，不泄露工具存在性）；平台 `/mcp` 运维面同口径过滤；`/api/mcp/invoke` 与 `mcp_invoke`
  保留为兼容层（行为不变）。
- 下游凭证经 Secret Broker 保管：`PUT/GET /api/mcp/services/:id/credential` 下发/回显（API 永不回显
  密钥原文），值落 `data/secrets/mcp/`（0600），业务集合零密钥；`POST /api/mcp/credentials/migrate`
  把存量明文敏感头一键迁入（先 dryRun 预检）；新写入敏感 headers 直接 400 `SENSITIVE_HEADERS_FORBIDDEN`
  （`MCP_ALLOW_PLAIN_HEADERS=1` 为迁移期逃生门，默认关）。

**应用能力绑定与生命周期**

- 新增应用能力声明：`GET/POST/DELETE /api/apps/:id/capabilities(…)`（`app.write`）——应用对 MCP 服务
  显式挂载 `required/optional` 能力，绑定自动回写服务归属（owner 唯一，冲突 409 `OWNER_CONFLICT`）；
  服务摘要投影零 headers（业务集合与任何 API 响应绝不出现凭证/敏感头）。
- 应用上线门禁扩展：每个 required 能力对应服务必须在线（online/gray）/ 已 verify / 工具非空 /
  无未决高危登记 / 凭证就绪，任一不满足即 400 `CAPABILITY_GATE_FAILED` 并列明服务名+原因；
  下架联动：归属该应用的服务自动置 offline，归档记 `archivedBy`。
- MCP 服务记录新增治理属性：`ownerEntity / dataClass / exposureMode / visibility / environment /
  credentialRef`（additive，启动幂等迁移补默认值）；资源依赖图补 `app→mcp (capability)` 边，
  拓扑 app→agent→mcp 可穿透。

**统一策略决策与组织约束**

- MCP 调用主裁决收拢到策略决策点（PDP）：iam-permission / mcp-permgroup / scene-ABAC / org-constraint /
  risk-gate 模块化裁决，deny 优先、reasons 聚合；NAS / Connector 决策出口统一以 PDP 表达
  （decisionId + reasons 进审计）。每次调用/拒绝均带 `decisionId`。
- 资源限定 scope：`mcp.service:<slug>.invoke` / `mcp.tool:<slug>:<tool>.invoke` 两种形态进入机器凭证
  scope 校验与 invoke 首层判定（权限组仍是第二层强制闸门，不因 scope 放行绕过）；
  `POST /api/mcp/perm-groups/:id/scope-template` 按权限组策略生成建议 scope 模板。
- 组织与租户硬约束：`visibility='org'` 跨组织直接拒绝 `ORG_SCOPE_DENIED`，`'tenant'` 同租户放行，
  `'cross-org'` 必须存在有效审批引用；委托链用户 org 与目标数据 org 校验同理。

**审计冷热分层与全链追踪**

- 审计日志追加 sha256 哈希链（`prevHash/hash`，可校验防篡改）与可选 `traceId`；
  `GET /api/audit/logs?traceId=` 按 trace 检索，`GET /api/audit/export?since=&until=` ndjson 全链导出
  （行序=时间序，附尾行 `_chainTip`）。
- MCP 调用记录增量 `traceId / argsHash / decisionId / upstreamStatus`（热数据 `mcp:calls` 维持 5000
  环形上限滚动清理，allow/deny 调用已双写审计事件不丢痕）；`mcp.invoked` 事件 payload v2
  （traceId / argsHash / decisionId / decisionReasons / delegationChain / riskLevel / dataClass / upstreamStatus）。
- 全链 trace：入口无 trace 即生成 32hex traceId，下游 HTTP 转发带 W3C `traceparent` 头，
  usage 计量回填 `trace_id`；`POST /api/mcp/perm-groups/dry-run` 策略模拟（影响报告
  newServices/writeTools/confidential/crossOrg/affectedSubjects，不落库）支撑权限变更预演。

**控制台与开发者体验**

- MCP 服务详情新增「治理」页：归属实体 / 数据密级 / 暴露模式 / 可见范围 / 环境与下游凭证状态
  （`local:`/`env:` 引用 + 是否存有密钥；存量明文头就地警示「建议迁移」）；「服务级 MCP 端点」卡
  给出 `POST /mcp/services/<slug>`、换牌+initialize/tools/list/tools/call 最小 curl 示例（一键复制）
  与错误域码提示表。
- MCP 页顶部治理待办横幅（未指派归属 / 明文凭证 / 非 gateway 暴露计数，可展开清单，unowned 项
  就地「指派归属」）；工具栏「凭证迁移」入口（dryRun 报告 → 确认执行 → 迁移结果）。
- 权限组编辑器新增「预演影响面」（dry-run 影响报告分组展示，含写工具/高敏/跨组织高危面时创建
  二次确认）与每组建「scope 模板」（建议 scope 清单一键复制）。
- 应用详情新增「MCP 能力」页（清单 + 绑定/解绑 + OWNER_CONFLICT 门禁文案就地渲染）；
  上线被 `CAPABILITY_GATE_FAILED` 拒绝时失败项以醒目清单弹窗展示（不再一闪而过）。
- Agent 详情新增「可调用 MCP 能力」页（权限组反查按服务聚合可调用工具面 + 最近 3 条拒绝原因）。
- 接入提示词与文档对齐：Agent/App 注册模板补「服务级 MCP 数据面」步骤（换牌 → initialize →
  tools/list → tools/call），X-On-Behalf-User 话术统一降级为「仅归因」；`docs/agent-onboarding.md`
  新增 §4.6 服务级接入、`docs/app-onboarding.md` 同步归因口径。
- 全部新增界面文案补齐 en-US / ja-JP 词典（`lint:i18n` 文件级 ≥95% 覆盖 + 占位符一致门禁保持全绿）。

**W4 独立审计整改（对抗性验收发现并修复）**

独立审计（功能完整性 + 对抗性安全两条线）挖出 4 个阻断项，全部修复并补回归护栏：
- **审计哈希链可校验性**：哈希计算原将 `undefined` 值渲染为 `null`，而落盘 JSON 会丢弃该键，
  导致「内存重算哈希」与「落盘记录重算哈希」分叉——哈希链对最关键的 MCP 调用记录不可校验。
  `canonicalJson` 改为跳过 `undefined` 键（与 `JSON.stringify` 语义对齐），导出后逐条重算一致。
- **机器自委托换牌通道**：原实现要求机器调用者必须携带 `userId`，而全部接入示例只传
  `audience`（实测 400，推荐路径不可用）。按整改计划 §6.2「Agent 自身调用」新增自委托模式：
  sub=调用者自身、act 链为空、audience 绑定目标服务；长期机器凭证不出域，授权面由 scopes
  三方交集夹紧到自身实时权限。示例另补三种换牌模式说明（自委托 / 代用户 / 人类换牌）。
- **委托链主体匹配**：委托令牌以 sub（用户）投影调用者，导致链上 Agent/App 身份永远匹配不到
  同名主体权限组，标准接入路径静默返回空工具集。统一主体 `actChain` 节点随附 `refId`（资源 id），
  调用者投影输出可匹配主体集合（主体 + 链上 Agent/App 演员），权限组按该集合匹配；人类普通会话
  行为不变（不继承他人授权）。
- **审计决策依据落库**：`decisionId` / `decisionReasons` 随 MCP 调用落审计，策略拒绝分档为
  `denied`（区别于上游故障 `error`）——决策依据不再随 5000 条热数据滚动而丢失。
- 附带收口：资源限定 scope 的服务存在性校验接线（错配 scope 签发期即拒）；清单生成器补齐
  authn/app 新端点（防 `npm run manifests` 抹除）；`mcp:migrations` 纳入 JSON 保留名单；拓扑按
  权限组合成 agent→mcp 边（App → Agent → MCP 可穿透）；既有权限组补「预演影响面」入口。
- 回归护栏：selftest 新增「W4 P0 安全整改回归」段（自委托 e2e / 主体匹配 / 哈希链落盘重算 /
  审计决策依据），断言总数 1604 → **1610 全绿**；新增单测 93 例全绿；独立黑盒复验 18/18 通过。

> 已知遗留（P2，不阻断）：委托令牌的 `audience` 在 REST 面不做强制（仅 MCP 数据面校验），
> 令牌 scopes 已按「请求 ∩ 调用者 ∩ 目标」夹紧，不构成提权，后续可收敛为全入口受众校验。

> 升级说明：治理属性由启动幂等迁移自动补默认值（存量服务落 `ownerEntity={type:'platform'}` 并计入
> 治理待办）；存量明文敏感头服务会在 MCP 页治理待办横幅提示，走「凭证迁移」即可无感转入 Secret Broker；
> 服务级端点需要委托令牌（audience=`mcp:service:<slug>`），旧的长令牌直连路径仍可用但不再推荐。

## [1.4.0] · 2026-10-22 · 信息架构收敛 + 部门面板登记制 + 登录可用性预检 + 治理属性瘦身

**导航信息架构（IA）重排（对外可见的界面变更）**

- 侧边栏由「总览 / 资源 / 治理 / 企业」重排为 **「总览 / 资源 / 协作与执行 / 治理 / 企业」**。
  「协作与执行」独立成组，承载执行中枢、A2A 协作、UHP 执行——这三者是「让数字员工跑起来」
  的一条主线，此前混在资源台账里会被误读成又一类可盘点资产。
- **资产登记页（`#/register`）下线**：登记动作回归各资源页自身的新建入口，不再有独立登记看板。
  `register.js` 及其样式、命令面板条目、资产台账的「登记资产」按钮一并移除。
- 数据权限（`#/nas-authz`）迁入治理组；A2A 与 UHP 各自拥有一级入口（UHP 落到 `#/a2a?tab=uhp`）。
- 同路径下带查询串的导航项优先高亮（`#/a2a` 与 `#/a2a?tab=uhp` 共存时只亮一个）。

**部门面板改为「宿主 × 部门」登记制（入口不再硬编码）**

- 此前「部门面板」是固定外链 `${BASE}/panel/`，与控制台的宿主服务连接清单没有事实关联——
  换宿主后进哪个部门完全由目标宿主自己的 `localStorage` 记忆决定。现在面板入口 = 一条登记项：
  只有登记过的「宿主 + 部门」才产生跳转地址，未登记不产生任何链接。
- 新增 `#/panels` 登记清单页；登记面同时嵌在「宿主服务连接」页（`#/connections`）。
  存储留在浏览器（`heng_ops_panels`，与连接清单同域同生命期），不引入服务端状态。
- 删除宿主连接时，指向它的面板登记一并清理；绕过删除产生的脏数据在清单里标「宿主已删除」并禁用进入。
- 面板侧新增 `?dept=` 深链：优先于本地记忆，越权/不存在的部门静默回落（不把越权尝试暴露成错误）。
  深链校验与服务端 `DEPT_RE`（`/^[a-z]{2,12}$/`）严格同口径——此前前端放宽到大写/数字/连字符，
  会让 `?dept=RD`、`?dept=rd-team` 先通过前端再被 `/api/panel/*` 以 400 拒绝，表现为点进面板空白。
- 落地分诊（`app.js boot()` / `login.js finishLogin()`）改用登记项：有已登记且可达的面板直达该面板，
  无登记落 `#/panels` 引导。登录侧挂载前缀改取页面自身路径，不再误用远程宿主态的 `BASE`。
- 工作台「协作会话」卡的「进入面板」补 `?dept=`，直达对应部门而非目标宿主的默认记忆部门。

**钉钉扫码登录可用性预检**

- 新增适配器可选契约 `probeAuthorize(redirectUri)`：服务端先拉一次授权页，识别 IdP 侧应用级拒绝
  （钉钉 `900103`「应用不存在」/ `900108` 未开通登录能力），把「整页跳转到一张只能关掉的错误页」
  换成登录页上的可执行指引（开发者后台「登录与分享」补回调域名、核对 AppKey），并自动切回账号密码兜底。
- 预检结果按 `provider|configId|redirectUri` 缓存 2 分钟，登录页重复点击不再每次多打一次 IdP；
  网络失败/页面结构变化一律按放行处理——预检只做增强，不作为登录门禁。
- 授权页（`#/oauth/authorize`）同口径：命中拒绝时就地展开手动授权码兜底，授权流不中断。

**治理属性瘦身：移除 `systemPromptVersion`**

- Agent 白名单与上线门禁移除「系统提示词版本」。上线门禁收敛为三项：`dataClass`（密级）、
  身份纳管（OIDC 客户端或 `entryUrl`）、进入试运行另需 `trialGroups` 非空。
- UHP harness 记录的 `systemPromptVersion` 一并移除；平台不承担提示词版本台账职责，
  提示词与模型版本请写进 `description` / `tags`。
- 存量登记里的 `systemPromptVersion` 值不再参与校验，展示层（Agent 详情）也不再读取。

**三方身份解绑与更换（账号详情页）**

- 新增 `POST /api/auth/sso/unbind`（本人自助，操作对象恒为会话本人）与
  `DELETE /api/iam/users/:id/bindings/:provider?corpId=…`（管理面，`corpId` 限定单一主体）。
- 新增 `POST /api/iam/users/:id/bindings/:provider/replace`：更换 = 前置解绑 + 扫码重绑两步。
  不在同一请求里「先解后绑」——绑定必须由 IdP 授权拿到 unionId，提前解绑会让用户在授权
  失败/取消时白丢既有绑定。
- 解绑写入 `bindingExemptions`（`provider|corpId`）：连接器同步不再按工号自动把身份绑回来，
  否则用户会看到「点了没反应」；重新扫码绑定即自动清除豁免。与 `leaderSource='manual'`
  的「人工决定优先于同步事实」同构。
- 反锁定护栏：三方身份是 SSO 自注册 / 通讯录同步账号唯一已知的登录凭据（初始口令为随机值
  且从未下发）。解绑后若既无剩余三方绑定、又无 `passwordKnown` 标记，直接拒绝并提示先设口令。
- 解绑按 `provider`（或 `provider+corpId`）全量删除事实源链接，`bindings` 投影由剩余
  `identityLinks` 重算——此前 `findOne` + 单条 `remove` 会留下幽灵链接，且按 provider 一刀切
  过滤投影会误清其他主体的展示行。

**回归护栏**

- `connections.test.mjs` 面板登记用例 6 → 7（新增「dept 口径与服务端 DEPT_RE 一致 + 存量脏数据被滤」）；
  新增 `plugin-panel-core/public/js/dept.test.mjs`（深链解析/越权回落/脏参数忽略，6 例）。
- `selftest` 前端接线节改断言：NAV 指向 `#/panels` 而非硬编码 `/panel/`；落地分诊走 `resolvePanels`；
  `#/register` 已从导航与命令面板下线；「协作与执行」独立分组承载三项。
- `cmdk` 页面索引补 A2A / UHP / 执行中枢，移除资产登记。
- 修复 `npm run manifests` 破坏性覆盖：生成器清单漏登记 `GET /api/usage/collaborations`，
  每次重生成都会静默删掉这条真实路由的声明。
- 补齐 `cpu` 图标（此前 UHP 导航项引用未定义图标，会静默回落成 info 图标）。

> 界面变更对现有部署无破坏性：老用户的 `#/register` 书签会落到工作台；面板入口需在 `#/panels`
> 登记一次「宿主 × 部门」（此前是硬编码直达，现在改为显式登记）。

## [1.3.1] · 2026-10-21 · A2A/UHP 复测整改（QA P1×1 + P2×6，含 1 项「声称已修」实为空操作的回退修复）

**外部集成闭环（P1-01，对外部第三方 Agent 开放的前置阻断项）**

- `refType=external` 机器凭证此前可成功派活，但 `tasks/get` 恒 `-32003`、`tasks/list` 恒空、
  `tasks/cancel` 无法取消、事件流 403——外部集成在「派活之后」全部断裂。根因：`getTask`/
  `listTasks` 的组织判定先于归属判定，而 external 凭证没有组织归属，归属短路永远不可达。
- 修复：**归属优先于组织收敛**——任务发起方本人恒定可见自己的任务；组织隔离（Q-4）只约束
  非发起方的治理读。内部 `refType=agent` 行为不变，跨组织隔离用例零回归。

**治理第 2 项 permit 覆盖真实生效（P2-01，上一批声称已修实为空操作）**

- 静态根因：`plugin-a2a` 的 `inject` 缺 `workforceIdentity` → cordis Service 代理读未注入键
  抛错 → 被 `governanceCheck` 的 `catch` 吞掉「按 legacy 放行」，受管员工离岗后仍可接单。
- 修复：补 `inject` 声明；把「探测 `resolver.store` 内部结构」改为契约方法
  **`workforceIdentity.inspectAgent()`**（三段判定：未纳管 / 已纳管但 permit 失效 / permit
  生效），脆弱耦合一并消除。受管但失效 → `PERMIT_NOT_EFFECTIVE`（fail-closed），
  恢复任用后可再次放行（不是死锁）。

**UHP 协议面口径统一**

- **P2-02**：`GET /v1/uhp` 改规范裸体（与 Agent Card well-known 同口径），外部 UHP 客户端
  无需再剥平台 `{ok,data}` 信封；CLI 的宽松解析保留为旧实例升级窗口兼容。
- **P2-04**：任务绑定注入变体矩阵（`metadata.ybk_a2a_task_id` / 顶层 `task_id` / 顶层
  `taskId`）统一 `400 TASK_BINDING_FORBIDDEN` + 专项审计 `uhp.invoke.task_binding_denied`
  （此前顶层变体静默丢弃，注入尝试不可观测）。
- **P2-03**：外部直调 `stream=true` 的 SSE 此前只下发 `response.created` 后悬挂（订阅器监听
  的 `a2a.task.progress` 只对平台派发记录发出）。新增记录级事件 **`uhp.response.progress`**
  （所有来源统一发出、不驱动 A2A 状态机，故不扩大任务绑定闸门攻击面），SSE 改订阅该事件并
  补「订阅后二次查终态」堵住竞态。

**前端完整性**

- **P2-05**：a2a 页三语补齐（en-US / ja-JP 各 7 条：运行时/取消/删除/`{n} ms`/步数预算/
  UHP 执行记录/`{n} 小时`），并顺带补齐 approvals/skills/iam-helpers 既有缺口；新增门禁
  `npm run lint:i18n`（**文件级 ≥95%** + 模板占位符一致性，防「整体达标但新页面残缺」）。
- **P2-06**：任务抽屉接入任务 SSE（`/v1/a2a/tasks/:id/events`，快照/进度/终态帧），经
  `realtime.js` 统一封装（SSE 优先、失败/无令牌降级 2s 轮询）；`realtime.js` 新增
  `eventNames` 具名事件支持（EventSource 的 `onmessage` 只收无命名事件）。
- 修复 a2a 目录页在无 `Option` 全局的环境（jsdom/SSR/门禁）下抛错；`page-smoke` 补 A2A
  五 tab 用例（此前新增页面零门禁覆盖，31 → 36 用例）。

**回归护栏（selftest 1552/1552）**

- 新增：external 凭证「派活→get→list→cancel→SSE」五段闭环；受管态（绑定无任用）→
  `PERMIT_NOT_EFFECTIVE` + 恢复任用后放行；注入变体矩阵三条路径；UHP 直调 SSE 闭合；
  `/v1/uhp` 裸体断言。
- 文档同步：《协议键中文对照总表》§3.4 permit 行改为实况口径、§六补「规范裸体例外」、
  事件清点口径按实际 93 条重算；`plugin-a2a` / `plugin-uhp` 的 `plugin.yaml` 补依赖声明
  （a2a→workforce、uhp→agent），`manifest/events.yaml` 登记 `uhp.response.progress`。
- 测试基建：selftest 的 6 个子实例（基线口令/workforce/灰度/演示/sqlite kill -9/CORS 精确来源）
  由固定端口改为内核分配空闲端口（`SELFTEST_PIN_PORTS=1` 可钉死复现），根治 QA 两次踩中的
  「并行实例占用固定端口 → 假失败」；`page-smoke` 的 P04 断言由 `.card`（依赖热力图数据）
  改为 `.res-card`（技能卡真实类名），消除数据依赖导致的随机红绿。
- CI：`quality-gate` 增 `lint:i18n` 与 `realtime.test.mjs` 两步。

> 复测缺陷对账：`docs/a2a-uhp-retest-fix-20261021.md`（逐项「缺陷→根因→修复→护栏」）。

## [1.3.0] · 2026-10-20 · A2A/UHP 验收缺陷整改批次（QA P0×1 + P1×9 + P2×24）

**安全整改（上线前阻断项）**

- **P0 任务劫持封堵（四层防御）**：外部 `uhp.invoke` 凭证此前可借 `metadata.ybk_a2a_task_id`
  劫持任意 A2A 任务（绕过人在环审批、伪造交付物、审计栽赃）。修复：协议面拒绝外部任务绑定
  （`400 TASK_BINDING_FORBIDDEN` + 专项审计）、服务层 `dispatchedByPlatform` fail-closed、
  进度回传仅认平台派发记录（外部直调永不驱动 A2A 状态机）、A2A 侧 responseId 配对校验 +
  审计主体改记真实调用方。selftest 新增「A2A/UHP 安全护栏」分节复刻攻击路径回归。
- **越权取消封堵**：`tasks/cancel` 改严格所有权判定（此前只读治理权限点可取消他人任务），
  JSON-RPC 保留码 `-32003` 分流归属拒绝。
- **UHP 执行记录归属**：读/取消仅属主可用（非属主按 404 回应，不泄露 id 存在性）。
- **组织隔离**：A2A 目录/任务/履约/巡检与 UHP harness/执行记录全面接入 R11 组织子树口径
  （此前下级组织持治理读权限即可读全平台任务明文）。
- **正文脱敏**：`a2a.directory.read` 收敛为元数据视图，任务正文/交付物内容/协商要约需发起方
  本人、验收员或平台管理员（`contentRedacted` 标记）。
- **验收职责分离**：任务发起人不可验收自己发起的任务（403）。

**契约与身份链**

- OBO 身份链打通：Agent 凭证默认 scope 补 `agent.a2a.invoke`（+存量迁移）；令牌 act 链的
  真实发起人写入任务与审计；`ybk_on_behalf_user` 外部自述不再采信（须校验可代表关系）。
- UHP 寻址修复：发现面公布的 `harness/<id>` 可直接调用（此前必然 404，selftest 曾把实现细节
  当契约）。
- 协议同构：`message/stream` 与 `message/send` 统一返回 JSON-RPC Task，流式由专用 SSE 端点
  承载（卡片已声明地址）。
- Agent Card 升级为规范裸体（不再包 `{ok,data}` 信封）并补齐自描述：事件地址、所需权限点、
  协议版本与方法面、计量双主体口径。
- `mode` 台账保真（矩阵拒绝不再误记 single_turn）、幂等键两层统一（含 attempt）、调用方
  `contextId` 透传（同链多 Task 归集可用）、permit 覆盖真实判定（`PERMIT_NOT_EFFECTIVE`）、
  会话续接继承 session_id 并回填上一轮回答、协作链 Top 确定性排序、UHP 审计带 responseId、
  `/v1` 与 SSE 拒绝路径审计留痕、SSE 错误码规范分流（401/403/404）。
- 治理拒绝原因码 6 条补录《协议键中文对照总表》§3.4（含 `code:` 形态清点命令）。

**产品数字与前端/CLI 补齐**

- 加载屏权限点数纠正为后端真实值 **92**（84→85→94 三次漂移的根因是无门禁——新增 selftest
  「产品数字与装配一致性」分节把三数与后端绑定）；`/api/platform/info` 插件清单改取实际
  装配树（此前写死 18 项）。
- 控制台 A2A 页新增「审批规则」「UHP 执行」两个 tab 与协作链成本卡（后端 27 端点的前端
  覆盖率 22% → 治理动作全入口）；新增「发起协作」「取消任务」入口；长任务抽屉 2s 轮询；
  无权限验收文案不再误导；a2a.js 面向用户文案 en-US/ja-JP 各补 ~190 条（22% → 全覆盖）。
- dshctl CLI：新增 `a2a`（12 动作）/`uhp`（5 动作）子命令；修复存量 6 缺陷（agent topology、
  mcp get 括号错位、group list、全局选项前置、approval decide `--confirmed`、mcp invoke
  denied 退出码）与 `--help`；`credential rotate --output json` 纯净输出。

> 修复对账清单：`docs/contract-c3-agent-a2a-v2-fix-batch-20261020.md`（逐项「缺陷→根因→修复
> →回归护栏」，供验收复测）。

## [1.3.0] · 2026-10-20 · 企业数字员工内网协作面（A2A/UHP，contract-c3 升版 v2）

**A2A 协作平面（新插件 plugin-a2a）**

- **Agent Card**：在线员工自动投影生成签名卡（技能 = 已上架 Skill + subjects 命中的 MCP
  权限组，声明不大于授权、不接受自由填写）；JWS（EdDSA/Ed25519）签名复用平台验签基建，
  私钥落盘 0600、目录卡附公钥，先验签后采信；`/.well-known/agent-card.json`（平台目录）与
  `/.well-known/agents/:slug/agent-card.json`（单员工）免鉴权发现。
- **跨运行时目录**：`GET /api/a2a/directory` 按技能/密级/运行时/自治级别检索在线员工——
  补齐 contract-c3 v1 诚实缺席的 discovery（内网形态）。
- **Task 生命周期**：JSON-RPC 主端点 `POST /api/agents/:slug/a2a`（message/send·stream、
  tasks/get·list·cancel，复用 v1 权限点 `agent.a2a.invoke`），八态机
  （submitted/working/input_required/auth_required/completed/failed/canceled/rejected）；
  任务 SSE 事件流（`/v1/a2a/tasks/:taskId/events?token=`，fail-closed）。v1 点名直调端点
  原样保留，行为不变。
- **治理检查五项**：权限点 / 在线·非冻结·permit 覆盖 / 密级天花板（越级拒绝）/ 预算配额
  （modelgw 熔断口径预检）/ 敏感审批规则（命中 → `auth_required` 挂审批中心工单，通过后
  幂等恢复执行、驳回 → rejected）。
- **A0-A3 协商引擎**：纯函数矩阵（仅约束数字员工互调；人类调用方按目标级别直判）；
  A3×A3 要约-还价（上限 3 轮，超限 rejected），协商全程审计。
- **验收与履约**：人工交付验收（仅 completed、必填理由——不轻信自报）；履约视图
  （接收/完成率/中断/验收通过率/耗时 P95/tokens）；声明-授权一致性巡检（例行 + 手动，
  捕获幽灵 Skill/权限组/harness 引用与模型离线漂移并告警）。

**UHP 执行驱动（新插件 plugin-uhp）**

- `GET /v1/uhp` 能力发现（免鉴权；版本锁定 2026-08-11，conformance=core 诚实声明，
  文件输入输出未做不宣称）。
- `POST /v1/uhp/responses` 任务面（Responses 兼容子集 + ybk metadata 扩展）：自校验
  Bearer + `uhp.invoke`；幂等键请求头（同键重放返回原 response）；`previous_response_id`
  会话续接；取消联动；`stream=true` SSE。请求级 `tools` 注入一律接受不生效并记
  `ignored_fields`（越权原语封堵）。
- configured harness 注册表（`/api/uhp/harnesses`，uhp.read/uhp.admin）：模型渠道、密级
  天花板、步数/时间预算、工具白名单投影；Agent `attrs.uhpHarnessRef` 显式引用，缺省按
  attrs 临时投影。内置 dsh harness = 单步真实模型执行（modelgw 分级路由 + 预算熔断），
  不虚构工具执行循环（诚实边界）。

**底座与治理**

- plugin-agent：schema 增「协作属性」字段组（a2aDataClassCeiling / uhpHarnessRef /
  uhpSessionPolicy，additive，存量缺省兼容——contract-c3 v2 红线 2 登记）。
- plugin-usage：usage_events 增 `context_id` 列（D3 同款幂等迁移）；协作链聚合
  `GET /api/usage/collaborations`——同一 A2A contextId 多 Task 计量按链归集「一次协作总成本」。
- 治理闭环：每次协作一条审计链（治理决策 + invoke 双分支 + 审批工单 + 验收结论）；
  `agent.a2a.invoked` 事件 additive 升级；新增权限点 6 个（a2a.directory.read / a2a.task.accept
  / a2a.admin / uhp.read / uhp.admin / uhp.invoke），全部进 RBAC 越权探针矩阵。
- 控制台：新增「A2A 协作」页（协作目录 / 任务追踪 / 履约视图三区块，三语导航）；
  演示只读白名单有意增补 `a2a.directory.read`、`uhp.read`（写/验收/执行类不进白名单）。
- 契约与文档：`docs/contract-c3-agent-a2a-v2-release-notes.md`（升版发布说明）与
  `docs/a2a-uhp-implementation.md`（施工对账）；协议键中文对照总表增记 4 事件 + 6 权限点
  + 3 环境变量。
- 质量：selftest 新增「A2A/UHP 协作面」分节约 30 项断言（卡片验签/治理拒绝/审批恢复/协商
  accept·counter·超限/取消不计量/幂等重放/巡检漂移/验收/履约/SSE fail-closed），全量
  1523/1523 通过；boot-order / manifests / demo-route-audit 三门禁绿。

## [1.3.0] · 2026-10-16 · 启动健壮性与交付卫生批次（EXEC-CHECKLIST 整改收口）

**启动健壮性（W2 · P0）**

- 新增启动探针 `platform-core/boot-probe.ts`：`assertSingleRoot` 双实例守卫 + `probeTree`
  插件树体检 + `formatTreeHealth` 可读报告。`boot-all` 两道接线——首个插件装配前查双实例、
  全部装配后体检必需服务（opsStorage/platformBus/httpServer/iam/authn/usage/audit），
  不健康即**拒绝启动**（打印卡死插件与等待的 inject 键，取代旧日「沉默 PENDING 零报错」）。
- FAILED fiber 引入「良性败者」豁免：声明 provide 已被其他 ACTIVE fiber 接管的 husk
  （panel-core/flow-core 既有双注册习语产物）只入诊断清单不拦启动；真故障照拦。
- 演练与断言：`scripts/boot-drill.mjs` 五场景（正常/双实例不可达/文案可读/污染清理/真故障）；
  selftest 新增「启动健壮性探针」节 6 条断言。

**版本锁定与 CI 双轨（W3）**

- `@deepseek-ai/cordis` 去 caret 精确锁定 **4.0.4**（`npm ci` 任意机器解析一致）。
- CI 双轨 `quality-gate.yml`：`gate`（lint 三门禁 + selftest + 契约测试，必须绿，全程不碰
  dsh）与 `dsh-compat`（仅手动触发、`continue-on-error`、matrix rc.7/rc.9，实验轨允许红）。
- 新增 `scripts/check-dsh-compat.mjs`：`dsh.compatibility.dshReleases` 从此有唯一机器验证
  来源——版本确认/实体来源确认/cordis 单实例覆盖/装配 probeTree + 无重复注册/回写记录
  五断言；环境不可达时输出「兼容性未验证」并以退出码 2 结束，绝不谎报兼容。
  rc.7 本机实测五项全过。

**存储收尾（W4 · ADR-0001 第二期落地）**

- sqlite 后端默认豁免名单 `DEFAULT_JSON_KEEP`（9 项）：低频配置型集合（resource:dependencies /
  update:state / oidc-keys / market:* / platform:bootstrap / agent·app·iam migrations /
  iam:groupSnapshots）默认保留 JSON，与 ADR 第三批结论对齐；`PLATFORM_STORAGE_JSON_KEEP`
  显式设置时完全覆盖默认。
- JSON→SQL 回填加**事务内对账**：逐集合条数 + 逐条规范化 SHA-256 哈希，不一致整体回滚、
  启动响亮失败（消息含集合名与差异数）。
- sqlite 后端 iam「一人一号」端到端攻击演练 7 断言：二次绑定引擎拒绝、跨 corpId 放行、
  同 tick 竞态恰一条成功、绕层直插被拒、refresh 轮转、吊销经 onChange 可靠广播、吊销后
  refresh 被拒。
- ADR 口径双侧回写：压测正式改「串行 10k 写 P99<50ms」（node:sqlite 同步 API 单写者，
  不做多进程压测的论证在册）；`PLATFORM_STORAGE_MIGRATED` 条款废止（后端级开关 +
  JSON_KEEP 名单即回滚机制）。

**dsh 耦合面收窄（W5）**

- 窄端口 `platform-core/host-bridge.ts`：plugin-dsh-bridge（ctx.webServer 七调用点）与
  plugin-rq-card client（ctx.slots/locale）全部 dsh API 调用收进 adapter，dsh 特有类型
  不进端口签名，升级改动面锁死在 adapter 内；mock 契约测试 42 条
  （`npm run test:contracts`），dsh 升级只需重跑该组。inject 键与外部行为零变化。

**交付卫生**

- 夹带改动专项（QA 2026-10-16 §3）：plugin-mcp `mcpToolRisks` 服务与 `mcp.risk.admin`
  权限确认为误删，按方案 A 恢复；根修 `scripts/gen-manifests.mjs`——risk-registry 增强面
  与 console `/locales/:locale` 声明补进生成器数据源并支持权限注释，**再跑生成器与仓库
  逐字节一致**（此前重跑会反复冲掉手工增强面，即夹带漂移的源头）。
- selftest 版本期望动态化（读根 package.json，bump 不再联动测试；修复 1.2.0 批次
  1448/1450 的 2 项红）。
- 品牌卫生清零：llms.txt 与 docs/i18n 共 88 处 RongQi → YuanBingKe；部署文档 4 处旧品牌
  「衡 ·」→ 元冰可；根目录品牌指南迁移 `docs/internal/`。
- CONTRIBUTING 标注已验证 Node 版本（v24.21.0 实测）；中英部署文档补齐双形态
  experimental 声明。
- 门禁：selftest **1467/1467 全绿**（1450 基线 + W2 六条 + 存储收尾十一条）；
  lint 三门禁 0 错误；契约测试 42/42；boot-drill 五场景全绿；check-dsh-compat rc.7 全过。

## [1.2.0] · 2026-10-16 · 产品化收口批次

**存储（ADR-0001 第一期）**

- 业务集合存储双后端化：默认 JSON（零变化、向后兼容），`PLATFORM_STORAGE=sqlite` 切换
  SQLite 后端——写入即事务（WAL + `synchronous=FULL`）、`uniqueOn` 落引擎级唯一索引、
  常驻内存不随记录数增长；首启自动回填既有 JSON 数据（文件保留为回滚源），
  回退工具 `scripts/storage-export.mjs`、基准工具 `scripts/storage-bench.mjs`（10k 写入 P99 < 1ms）。
  27 个业务插件零改动。selftest 新增 SQLite 后端契约节（双后端对拍/引擎级唯一/回填幂等/
  平台级 kill -9 零丢失），总计 1450 项断言（当批门禁遗留 2 项版本期望红，
  已于 1.3.0 动态化修复回绿）。

**分发与叙事**

- GitHub topics 增补 `dsh-plugin` 等六项（dsh 生态官方发现机制）；仓库描述改为一句价值陈述。
- README 整体重写（684 → 200 行）：价值前置第一屏（给已经跑 dsh 的团队的企业管控台）、
  「与市面方案的关系」竞品边界表、「诚实边界」节前置并更新存储双形态口径。
- 文档收敛：docs/ 根只留对外文档（README / 架构 / 部署与接入指南 / 契约 7 份 / i18n）；
  QA 报告、交接单、重构基线、发布说明等 67 个过程物料外移 `docs/internal/`。
- 新增 `docs/ARCHITECTURE.md`（架构稳定入口）、`CONTRIBUTING.md`、本 `CHANGELOG.md`、
  `docs/adr-0001-storage-migration.md`（含落地记录）。

## [1.1.0] · 2026-10-15/16 · 全球化与数字员工二期

- 运行时表现层内置 zh-CN（默认）/ en-US / ja-JP 三语实时切换（协议层 ASCII 键不改写）；
  语言切换不生效双缺陷收口。
- 数字员工二期 W 批次：MCP 工具可信风险登记流程、REST/Panel 接入面等价收敛、
  usage 代报白名单、workforce.admin 运维面、灰度交付包。
- 执行中枢 plugin-exec-hub 整体交付：目标树、30s 心跳循环、执行锁 CAS、例行调度、
  Agent 组织化、预算联动冻结 + L4 解冻。
- 审查反馈整改批次：组织隔离 fail-closed、MCP 工具权限最小化（存量工具逐一补声明）、
  模型渠道降级链预算守卫。

## [1.0.0] · 2026-09-09 → 2026-10-14 · 基线到生态

- M0 基线：IAM / 统一认证（Authn + OIDC Provider）/ MCP 部署服务 / Skill 市场 / Agent 本体 /
  AI 应用 / 用量计量 / 模型网关 / 审计告警九域；合规收敛（废止计费转售，零价快照口径）。
- M1-1 契约冻结 v1 齐套（J1-J4）；IAW 流程编排批次（flow-core）；M2 优化批次。
- 生态化演进（v1.2 设计）：连接器纳管、NAS 存储、插件市场（契约五面 + Ed25519 验签）、
  数字员工（workforce）、执行中枢、钉钉桥接、dsh 宿主双形态。
- 全局重构 REFACTOR-2026-10-13 七项收敛 + 品牌重塑元冰可 + 全站移动端适配
  + Kimi CIO 仪表盘设计适配（暖纸 + 深青蓝设计系统）。

[1.2.0]: https://github.com/01men/ybkkasi
[1.1.0]: https://github.com/01men/ybkkasi
[1.0.0]: https://github.com/01men/ybkkasi
