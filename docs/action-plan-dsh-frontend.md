# DSH 前端落地行动方案（执行版 V2 · Agent 开发团队版）

> **输入**：① 行动方案目标（目标 1 资产统一调运与权限贯通 / 目标 2 宿主 Agent 一体化 / 目标 3 多平台差异化交互 + 机制 3.1 / 3.2）；② 《DSH 前端产品设计方案 V2.0》；③ RQ-DSH 仓库代码级核对与架构评审结论（2026-09-02）。
> **V2 修订**：执行主体改为 **Agent 超级开发团队**。删除日历/人天排期，改为**依赖门禁 + 并行泳道**；任务全部改造为**契约先行、文件所有权明确、机器可验验收**的工作包（WP）；原「待评审决策」改为**默认决议 + 否决协议**，执行不被人类会话阻塞。
> **铁律（AGENTS.md）**：开发只在 `custom/dsh-rq`；上游 `01men/ybkkasi` 只读；每个 WP 合并前 `npm run selftest` + `npm run lint:manifests` 全绿，绿后 `git push` 交付。

---

## 〇、执行摘要

**结论：三大目标全部可在现有架构上达成**——不新增自研子系统、不改 dsh web 源码、不引入第二前端栈。前端增量收敛为：**7 个页面 + 1 个浏览器端注入插件 + 1 套卡片包 JSON 配置 + 2 个薄端点 + 1 次 usage/behavior schema 扩展**，共 16 个可并行/串行组合的工作包。

三大目标 ↔ 真实能力 ↔ 缺口：

| 目标 | 架构落点（已有，已核实） | 缺口（本方案补齐，WP 编号） |
|---|---|---|
| **目标 1** 资产统一调运与权限贯通（登记→鉴权→调用→回传闭环） | skillhub 提交流水线；mcp 网关 invoke()（鉴权/熔断/埋点/审计）；iam RBAC + nas-authz 五步判定序（fail-closed）；usage.recorded schema v1 | usage 值域缺 `app:`/`kb:`、零价快照约定缺失、行为事件无通道（WP-03/WP-07）；全链路闭环未整体演练验收过（WP-08/门禁） |
| **目标 2** 宿主 Agent 一体化（无跳转无二次登录，每次操作有宿主支撑） | dsh web 自带 UI；entry-ticket + OIDC；dsh-bridge M4/M5 身份绑定；dsh-ops-admin（管理动作已可自然语言完成） | 控制台票据免登未接线（WP-02）；dsh.client 注入能力边界未验证（WP-01）；绑定失效无预案（WP-04） |
| **目标 3** 多平台差异化交互 | 控制台 CSS 变量体系 + ui.yaml 声明式菜单 + 17 个运行中页面 | 卡片包配置模型与下发端点不存在（WP-05）；五平台差异需定版为三项配置 |

**V1 → V2 变更摘要**：① T0.3「决策会」改为 §六 默认决议（Agent 直接执行，人类保留否决权）；② 日历排期改为 Phase 退出门禁；③ T1–T5 重组为带契约与验收断言的 WP-04~08，四条泳道可并行；④ 新增 §一 Agent 团队执行规范（上下文引导/文件所有权/机器可验验收/回归门禁）；⑤ 新增共享文件冲突管理。

---

## 一、Agent 团队执行规范（每个工作包开工前生效）

1. **上下文引导**：领包 Agent 必读——`AGENTS.md`（同步铁律）、`docs/dev-plan-agent-host-unification.md`、`docs/nas-authz.md` §二、本文件全文、以及所领 WP 列出的触碰文件。
2. **契约先行**：每个 WP 先产出接口契约（manifest/api.yaml 增量、事件 schema、JSON schema），lint 通过后方可写实现。契约变更必须回写本文件对应小节。
3. **文件所有权**：多 Agent 并行时按 §三/§四 的「触碰文件」声明所有权；共享文件（`api.js`、`index.html`、`platform-core` 挂载注册点）只允许指定 WP 修改，后合并者负责适配。禁止跨包「顺手修」。
4. **机器可验验收**：每个 WP 的 DoD 必须落到以下之一，否则不得合并——selftest 断言节名、lint 规则名、可脚本化检查（curl/grep/diff 脚本）。「页面看着正常」不构成验收。
5. **回归门禁**：合并前 `npm run selftest && npm run lint:manifests` 全绿；每个 WP 至少自带一节新增断言（测试随包走，不欠账）。
6. **决策协议**：§六 的默认决议已定版，Agent 按默认执行，不等待人类。人类负责人可**否决**：否决不回滚已产出工作，只在其上加适配层；否决必须写入 §六 决策记录。
7. **提交与交付**：一个 WP 一个提交序列，信息格式对齐仓库惯例（`feat(scope): ...`）；门禁绿后立即 `git push`（push 即交付）。禁止在本地 `main` 做任何开发。

---

## 二、Phase 0：先决工作包（解除阻塞，WP-02/03 可并行）

### WP-01 dsh.client 注入能力边界 spike 【阻塞 WP-06】

- **目标**：定刻会话侧定制的实现档次。范本（`packages/client/ui-auth`、`packages/client/modules/src/index.ts`）位于 dsh harness checkout，本仓库不可核对，必须实测。
- **步骤**：定位 harness checkout（部署文档/运维路径/`docs/integrations/` 线索；两轮探索找不到则向运营者请求路径，此为唯一允许的外部求助点）→ 实测三类注入点 → 写判定报告。
- **三档判据（可测）**：
  - **档次 A**：消息级挂载点存在——能在会话消息流注入 DOM 节点且在一轮流式更新后仍存活，且能订阅工具调用生命周期事件 → WP-06 实现会话内完整执行卡片+四态+反馈条；
  - **档次 B**：仅启动图/侧栏级挂载 → 会话内最小注入集（反馈条 + 结果卡片外链），四态完整版放工作台/资产页；
  - **档次 C**：无可用挂载点 → 会话保持纯文本+链接，卡片体验全部收进工作台与钉钉；P1 主路径（一句话问答）不受影响。
- **产出**：`docs/spike-dsh-client-capability.md`（含档次判定与证据截图/日志）；档次判定写入 §六 决策记录。
- **降级保底**：若必须 DOM 探测，集中封装 + 上游版本探测，升级时自动降级为纯文本（不白屏）。验收不变量：**dsh web 源码 diff = 0**。

### WP-02 控制台票据免登接线 【阻塞 WP-04】

- **现状**：`plugin-console/public/js/pages/login.js` 与 `api.js` 无 redeem 痕迹；M4/M5 落地的是 dsh web 侧通道，普通员工「打开即工作台」在此断链。
- **契约**：`api.js` 增 redeem 流程（`POST /rq/api/authn/entry-tickets/redeem` → 建立控制台会话）；`login.js` 支持 `?ticket=` 一次性参数，消费后立即清除 URL 参数；门户/钉钉侧入口复用既有发票模式（同 `POST /api/agents/:id/entry-ticket`）。票据只进请求体与内存，不进常驻 URL、不进服务端日志。
- **触碰文件**（本 WP 独占）：`packages/plugin-console/public/js/api.js`、`pages/login.js`、`index.html`（含 base-path 一次性改造确认点）。
- **DoD（机器可验）**：selftest 新增节「console ticket redeem」——① 兑换成功建立会话；② 重放票据被拒；③ 票据不出现在任何服务端日志断言；④ 早高峰模拟脚本（50 并发领票/兑换）零失败（脚本入 `scripts/`，可重复执行）。

### WP-03 usage/behavior schema 扩展（默认决议版）【阻塞 WP-06/WP-07】

按 §六 默认决议直接执行：

1. `packages/plugin-usage/src/index.ts`：resource 值域注释与校验增补 `app:<id>`、`kb:<orgId>`；`UsageRecordInput` 支持零价快照便捷构造（`charge_cents=0`、rate 标 `nonbillable`）。
2. 新增 behavior 事件：schema `behavior.recorded` v1（additive-only），薄端点 `POST /rq/api/behavior/events`（iam 鉴权，write-only；SQLite collection，先写后发经 platformBus，audit/看板可订阅）。端点归属 `platform-core` 新文件 `src/behavior.ts`（若实现中发现与仓库惯例冲突，按惯例调整并在 §六 留痕）。
3. **DoD**：selftest 新增三节——「usage 值域扩展」「零价快照构造」「behavior 事件投递语义（幂等/死信/重放）」；schema 变更记录写入 usage 插件头注释。

**Phase 0 退出门禁**：WP-01 档次已判定；WP-02、WP-03 全绿并推送。

---

## 三、Phase 1：筑基收尾工作包（四条并行泳道 + 串行收口）

### 泳道 A：认证与工作台底座（目标 2 主承重）

**WP-04 全员工作台底座**（依赖 WP-02）

| 子项 | 内容 | DoD（机器可验） |
|---|---|---|
| A1 服务端强制 | 逐点核查 /rq/api 端点 iam 鉴权覆盖，产出「端点×角色」矩阵；禁止仅靠 ui.yaml 菜单隐藏 | selftest 节「rbac endpoint matrix」：普通成员直调管理端点 100% 被拒（矩阵驱动，端点清单变动即红） |
| A2 绑定自检+重绑 | 工作台加载探测 dsh-bridge 绑定态；失效 → 横幅 + 钉钉内一键重绑（entry-ticket+OIDC 既有通道）；errors 文案表补「身份绑定已失效」 | selftest：绑定失效态返回可识别原因码；前端呈现走 WP-06 文案模块 |
| A3 工作台骨架 | `pages/dashboard.js` 四区重构：问候区/场景卡片区/最近调用（≤5，usage 聚合经 portal 只读端点扩展）/对话入口 | 走查脚本断言核心路径 ≤3 步；所有请求经 `api.js request()`（grep 不变量：console 目录下除 api.js 外无裸 fetch/XHR） |

**触碰文件**：`pages/dashboard.js`（本泳道独占）、iam 相关 selftest。

### 泳道 B：卡片包与五平台主题（目标 3 主承重）

**WP-05 卡片包制与主题**（与泳道 A/C/D 并行；platform-core 内与 WP-03 分文件并行）

- **契约**：卡片包 JSON schema（平台/角色/卡片[标题、一句话说明、类型徽标、跳转、资产 ref]/顺序/首页上限 6）；下发端点 `GET /rq/api/platform/card-packs` 按「角色×平台」过滤，实现于 `platform-core/src/cardpacks.ts`（与 WP-03 的 `behavior.ts` 不同文件，互不阻塞）。
- **子项**：B1 schema+端点；B2 `lint:manifests` 增卡片包校验（必填/上限/资产 ref 存活性）；B3 主题 `:root[data-platform=…]` 五色 CSS 变量（战略 #3B4CC0 / 营销 #E8590C / 智造 #0C8599 / 研发 #7048E8 / 质量 #2F9E44），不引 Tailwind；B4 研发+质量试点卡片包配置。
- **DoD**：故意配错卡片包 → lint 红；新增/调整卡片零前端代码改动（改 JSON 生效，有测试证明）；主题切换仅 data-platform 属性差（样式快照对比）。

### 泳道 C：会话侧注入与四态反馈（目标 2 × 机制 3.2）

**WP-06 注入插件、四态与错误文案**（依赖 WP-01 档次判定、WP-03 feedback 端点契约）

- **C1 注入插件**：按 WP-01 判定档次实现（A=会话内完整卡片；B=最小注入集；C=纯外链）；内容：平台主题、资产感知面板（**过渡期两路规则召回**：场景绑定=卡片包配置 + usage 热度；语义召回留 Phase 3）、结果卡片、反馈条（→ WP-07 端点）。
- **C2 四态状态源映射**（前端只呈现）：

| 用户四态 | 状态源 | 呈现 |
|---|---|---|
| 调用中 | mcp invoke() 发起中 | 卡片骨架，可取消 |
| 执行中 | online/gray 且 health∈{healthy, degraded}（30s 轮询） | 进度脉冲；degraded 附「有点慢」 |
| 已完成 | 调用返回 + usage.recorded 落库 | 结果 + 👍/👎 |
| 异常阻断 | down / breakerOpen / nas-authz deny / 额度耗尽 | 红边条 + 业务文案 + 行动按钮 |

- **C3 错误文案共享模块** `js/errors.js`（本 WP 新建独占）：原因码→文案+行动按钮集中一处。初始六条：nas-authz deny（→申请访问）、breakerOpen（→恢复提醒）、额度耗尽（→查看/申请）、PDP_UNREACHABLE（→保护性提示）、degraded（→转后台+钉钉通知）、身份绑定失效（→一键重绑）。
- **DoD**：selftest 新增「错误文案映射完整性」节——枚举全部对外原因码，漏配文案即红（后续任何人新增原因码必须同步文案）；dsh web 源码 diff=0 不变量检查入 selftest；四态映射表有单测（状态输入→UI 态输出纯函数化）。

### 泳道 D：效果回传与埋点（目标 1 闭环末端）

**WP-07 feedback 与行为埋点**（依赖 WP-03）

- D1 `POST /rq/api/usage/feedback` 薄端点：👍/👎 → usage.record（零价快照，主体经 X-On-Behalf-User 归因）。
- D2 前端行为埋点：卡片曝光/点击/推荐位/登记漏斗步骤 → behavior.recorded；**不重复上报调用日志**（服务端计量已覆盖）。
- D3 看板口径定版（文档）：WAIC=usage 周聚合；漏斗五级=behavior+usage 联合；熔断/恢复=mcp health；L2 审批周期=skillhub 时间戳。
- **DoD**：selftest——feedback 落库断言（含归因字段）、behavior 事件端到端（record→bus→订阅方收到）、幂等重放不重复计数。

### 泳道 E：登记引导（机制 3.1）

**WP-08 登记引导页与 L3 备案跑通**（无前置依赖，可最早启动）

- E1 引导页（新 pages 片段）：「你要登记什么？」四磁贴 + 共性字段预填（owner/平台/部门/密级）+ 合规声明必勾。资产类型对目标 1 全覆盖：

| 磁贴 | 真实入口 | 时序 |
|---|---|---|
| 提示词/技能 | #/skills（skillhub） | 即期 |
| 自动化流程 | #/apps（app，既有 SSO 上线门禁） | 即期 |
| 接口/工具 | #/mcp 注册（verifying→gray→online） | 即期 |
| 文档/知识包 | **NAS 已授权目录登记**（授权范围必选） | kb.ingest 磁贴置灰标「深化期」 |
| 数据/模型 | 数据=nas-authz 授权目录；模型=modelgw 管理员接入（非自助登记） | 管理员通道 |

- E2 资产描述字段自本 WP 起按「未来可 embedding」规范填写（长度/关键词约定，写入表单校验）。
- **DoD**：四类资产各 ≥1 真实资产走完 **登记→审批→上架→授权→调用→回传** 全链路（演练记录入 `docs/`，每步引用真实 API 调用与 usage 事件 ID）；L3 登记→上架当日完成。

**Phase 1 退出门禁**：WP-04~08 全绿推送；门禁验收四项——① 全链路闭环演练通过；② 免登 ≤2 步、零二次登录；③ 研发+质量卡片包在用、核心路径 ≤3 步；④ selftest+lint 全绿。

### Phase 1 退出门禁执行记录（2026-09-02，全项通过）

| 门禁 | 结果 | 证据 |
|---|---|---|
| ① 全链路闭环演练 | ✅ 27/27 步 PASS（skill/app/mcp/nas 四资产 × 六步） | `node tests/full-chain-drill.mjs`（可重复执行），真实 usage 事件 ID 归档于 `docs/drill-full-chain-l3.md`；L3 登记→上架秒级达成 |
| ② 免登 ≤2 步、零二次登录 | ✅ 票据兑换直建控制台会话（1 步）；早高峰 50 并发零失败 | `tests/morning-peak-entry.mjs`（领票 50/50 · 兑换 50/50 · 会话可用 50/50，165ms）；selftest「console ticket redeem」节 |
| ③ 卡片包在用、核心路径 ≤3 步 | ✅ rd/quality 试点包过 lint 且存活过滤生效；走查 6/6 | `tests/walkthrough.mjs`（认证 1 + 进工作台 1 + 进功能 1 = 3 步达标）；`npm run lint:manifests`（清单 75/75 + 卡片包 2/2） |
| ④ selftest + lint 全绿 | ✅ selftest 801/801（基线 737 → +64 项随包断言） | `npm run selftest`；新增节：console ticket redeem / usage 值域 / 零价快照 / behavior 管道 / 卡片包与主题 / rbac endpoint matrix（212 越权探针 100% 被拒）/ usage 最近调用 / feedback 回传 / 错误文案映射完整性 / 四态状态源映射 / dsh 宿主挂载（behavior+cardpacks 进程内直测） |

---

## 四、Phase 2：推广工作包（依赖 Phase 1 门禁）

| WP | 内容 | DoD 要点 |
|---|---|---|
| WP-09 五平台全量 | 卡片包全量配置 + 主题齐备（纯配置动作，教练团接管运营位） | 5 套卡片包过 lint；每平台首页 ≤6 卡片；走查 ≤3 步 |
| WP-10 L1/L2 审批全量 | 复用 approvals 页；L1 加公司级终审标记+调用水印+二次确认；SLA 看板 | L2 审批周期 ≤2 工作日达成率 ≥90%（数据可查）；L1 终审标记在审计可追溯 |
| WP-11 钉钉微应用 | H5 复用同一对话面；**钉钉 webview cookie/SSE 实测**；SSE 失败自动降级 30s 轮询（不恢复 WS）；车间平板优先验证智造包 | P3 路径 ≤2 步；降级路径有自动化测试；webview 实测报告入 docs/ |
| WP-12 看板 v1 + 目录瘦身 | 老板战略视图走 portal 只读端点扩展（不开特权接口）；资产目录单栏卡片流+类型/平台筛选 chips | 漏斗指标可测（behavior 全量）；目录页性能与筛选有断言 |

**Phase 2 退出门禁执行记录（2026-09-02，全项通过）**：selftest 820/820；lint 清单 75/75 + 卡片包 5/5（五平台全量）；走查 6/6 核心路径 3 步；早高峰 50/50；全链路演练 27/27；钉钉 H5 冒烟 6/6（SSE 降级 30s 轮询，`docs/dingtalk-webview-report.md` 含现场实测清单）。WP-10 增量：高风险审批服务端强制二次确认 + 公司级终审标记审计可追溯（approval.final_review）+ MCP 调用水印 + SLA 看板（/api/approvals/sla）。WP-12 增量：portal /board 只读聚合（漏斗四级=behavior+usage+mcp 联合、WAIC、ROI 用工成本模型）+ 目录单栏卡片流（纯函数筛选 1000 项 <50ms 断言）+ 战略看板页。

---

## 五、Phase 3：深化工作包（★=依赖外部排期）

> **执行记录（2026-09-02）**：WP-14 已提前落地（ROI 随 WP-12 看板 v1 下发）；WP-15/16 评估完成、路线预置；WP-13 维持降级态（启用 checklist 就绪）。详见 `docs/phase3-deepening-evaluation.md`。

- **WP-13** ★KBaaS 上线后：kb.ingest 磁贴启用、语义召回第三路启用（依赖 WP-08 E2 描述规范已生效）。
- **WP-14** ROI 看板对接用工成本模型（usage 聚合 → 替代工时估算）。
- **WP-15** app 编排可视化画布例外条款评审（默认不另起栈，触发条件见 V2.0 §2.3）。
- **WP-16** 管理动作 Agent 化扩展评估：dsh-ops-admin 已有 37 工具基础，审批动作卡片化进入 Agent 会话的可行性（目标 2 管理面补全）。

---

## 六、默认决议与决策记录（否决协议见 §一.6）

| # | 决议 | 状态 | 备注 |
|---|---|---|---|
| D1 | usage resource 值域增补 `app:<id>`、`kb:<orgId>`（additive） | **默认采纳，直接执行** | 前向兼容义务已定版；变更记录入 usage 插件头注释 |
| D2 | 非计费事件统一零价快照（charge_cents=0，rate 标 nonbillable） | **默认采纳，直接执行** | 不采纳则 usage.record 录不进反馈/知识事件 |
| D3 | 行为事件独立 `behavior.recorded`，不混入 usage 计量管道 | **默认采纳，直接执行** | 避免污染计费口径 |
| D4 | L4 终审由平台管理员承接 + audit 留痕 + 钉钉审批卡 48h 超时升级老板 | **默认采纳** | 替代 V2.0 §12 待决项，避免审批瓶颈绑在老板日历 |
| D5 | dsh.client 实现档次（A/B/C） | **已判定：档次 A（2026-09-02，spike 实测）** | 证据与实现建议见 `docs/spike-dsh-client-capability.md`：消息流 slot（`tool.call.toolview`/`conversation.chat.assistant-actions`）流式增量存活 + `ctx.conversationEvents` 可订阅工具生命周期；新约束——cordis.yml 客户端条目必须写包名（require.resolve 解析），`lib/client.js` 必须在 `dsh web` 启动前构建，否则宿主启动失败（降级预案见 spike 文档 §5） |
| D6 | behavior 端点归属 platform-core | **默认采纳（已按此落地 + 一处惯例微调）** | behavior.ts/cardpacks.ts 均落 platform-core（钦定）；REST 路由注册：behavior 端点在 behavior.ts 自带（双层 fail-closed 鉴权），card-packs 端点按仓库惯例由 console 聚合（角色×平台×ref 存活性三维过滤需要 iam/资源注册表），已在两文件头注释留痕 |
| D7 | 会话侧新增兜底原因码 `invoke-error`（WP-06 报备） | **已采纳（2026-09-02）** | 工具结果 isError 且无平台侧六码时，会话卡呈现 blocked + invoke-error 兜底文案；已计入 errors.js 文案完整性枚举（selftest 断言） |

**勘误回执（对 V2.0 设计文档，随本方案执行生效）**：① §8.2 kb.ingest 改标深化期入口，推广期=NAS 目录登记；② §8.1 状态机拆两层标注（`pending_domain/pending_security` 属 SkillVersion 态，`plugin-skillhub/src/index.ts:50`；Skill 本体 `:21`）；③ F6/§6.1 出处修正为 dsh harness checkout；④ §10.1 补注 D1/D2/D3。

---

## 七、三大目标可测量验收口径

| 目标 | 验收口径 | 检查方法 |
|---|---|---|
| 目标 1 闭环 | 四类资产全链路演练通过；调用→usage 事件覆盖率 100%；NAS 拒绝 100% 有申请闭环；L3 登记→上架 ≤1 工作日 | WP-08 演练记录 + selftest 断言 + usage/mcp/skillhub/nas-authz 数据 |
| 目标 2 一体化 | 门户/钉钉→对话 ≤2 步、零二次登录；会话内已授权资产可召回可调用；dsh web 源码 diff=0 | 免登埋点 + behavior 事件 + harness diff 检查脚本（入 selftest） |
| 目标 3 差异化 | 5 套卡片包过 lint；主题仅 data-platform 差异；首页 ≤6 卡片、核心路径 ≤3 步 | lint:manifests + 走查脚本 + 样式快照对比 |

---

## 八、风险登记册（逐条挂 WP）

| 风险 | 等级 | 缓解 | 残余 |
|---|---|---|---|
| R1 dsh.client 能力边界未验证，会话内富卡片可能退化为 DOM hack | 高 | WP-01 档次判定 + A/B/C 降级预案 + 注入面最小化 | 档次 B/C 时会话内体验让渡给工作台/钉钉 |
| R2 全员入口认证链路（console 免登 / 服务端强制 / 并发 / 钉钉 webview） | 高 | WP-02 / WP-04 A1 / WP-11 降级轮询 | webview 兼容以实测报告为准 |
| R3 KBaaS 未实现却出现在登记入口 | 中 | WP-08 磁贴时序修正 | 无——降级即期可用 |
| R4 usage/behavior schema 未定，度量落空 | 中 | WP-03 默认决议 + WP-07 落地 | 无 |
| R5 身份绑定失效成头号故障（fail-closed） | 中 | WP-04 A2 自检+重绑 | 依赖重绑通道可用性 |
| R6 共享文件改造（api.js/index.html/base-path）的合并冲突面 | 低 | §一.3 文件所有权独占 + 显式标记注释 + 合并检查清单 | 常规冲突成本 |
| R7（新增）多 Agent 并行写同一包导致提交缠绕 | 低 | 一包一提交序列 + 门禁绿才 push + 文件所有权地图 | 无 |

---

## 九、阶段依赖与门禁总览（无日历，按依赖推进）

```
Phase 0（串行起点）
  WP-01 ──────────────┐（阻塞泳道 C）
  WP-02 ──┐           │
  WP-03 ──┼─（并行）──┤（阻塞泳道 C/D；WP-02 阻塞泳道 A）
          │           │
Phase 1（四泳道并行）
  泳道 A：WP-04（依赖 WP-02）
  泳道 B：WP-05（无前置）
  泳道 C：WP-06（依赖 WP-01、WP-03）
  泳道 D：WP-07（依赖 WP-03）
  泳道 E：WP-08（无前置，可最早启动）
  ── Phase 1 退出门禁（四项验收，见 §三）──
Phase 2：WP-09 ~ WP-12（依赖 Phase 1 门禁；四包可并行）
Phase 3：WP-13 ★外部排期 / WP-14 / WP-15 / WP-16
```

**原业务参考窗口**（仅对照，不作为执行约束）：筑基收尾 2026-09、推广 2026-10~11、深化 2026-12。Agent 团队按依赖尽早完成，门禁通过即进入下一 Phase。

---

## 十、版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| V1 | 2026-09-02 | 初版：人类团队执行假设，T0-T14 任务 + 日历排期 |
| V2 | 2026-09-02 | 执行主体改为 Agent 超级开发团队：删日历/人天排期，改依赖门禁与并行泳道；T0.3 决策会改为默认决议 D1-D4/D6（+否决协议）；任务重组为 WP-01~16（契约先行/文件所有权/机器可验 DoD/测试随包走）；新增 §一 执行规范与 R7 并行冲突风险；T→WP 映射：T0.1→WP-01、T0.2→WP-02、T0.3→WP-03、T1→WP-04、T2→WP-05、T3→WP-06、T4→WP-07、T5→WP-08、T6-T10→WP-09~12、T11-T14→WP-13~16 |

*本行动方案与《DSH 前端产品设计方案 V2.0》配套：设计定「是什么」，本文件定「谁以何种顺序、按什么验收」。工作包可整体指派给 Agent 团队，指派时引用 WP 编号即可。*
