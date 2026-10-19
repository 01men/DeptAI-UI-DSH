# 评审报告：DSH 部门 Agent 工作台 v2 设计成果落地评审与实施计划

> 评审对象：`D:\软件\WorkBuddy\2026-09-07-12-09-05\dsh-agent-panel-design\`（DESIGN.md + index.html 878 行可交互原型 + 对比图）
> 评审基准：本仓库 `custom/dsh-rq` 分支现状（plugin-console 零构建 SPA / plugin-rq-card 会话卡片 / 后端插件体系 / selftest 820+ 断言）
> 评审角色：技术架构负责人；评审方式：六大领域并行差距分析（骨架外壳 / 会话看板 / 钉钉桥接 / 场景图谱与授权 / 五部门看板 / 插件封装与工程落地），全部结论经仓库代码实证。

---

## 一、总体评审结论

**设计质量：通过，可进入实施。** 方向与平台架构高度契合：

- 一切皆插件：`plugin-panel-*` 封装形态符合 dsh 插件体系；
- 治理面复用：审批（audit approvals）、计量（usage）、审计（changeLog）、能力授予（capability-grants）全部有现成载体；
- 数据驱动皮肤：原型本身就是"一套骨架五种皮肤"的 DEPT_META 数据驱动结构，与仓库 cardpacks 先例一致；
- QB01 家电 27 场景 + GCJX 工程机械 18 场景已在原型内建模，可直接剥离为种子 JSON。

**但 7 处设计口径与仓库现状冲突，实施前必须修订或裁决（可回传设计方）：**

| # | 设计口径 | 现状冲突 | 裁决建议 |
|---|---------|---------|---------|
| D1 | 计量键 `panel:<dept>:@<行业code>` | `plugin-usage/src/index.ts:534` 硬校验 `/^[a-z]+:[A-Za-z0-9._-]+$/`，双冒号+`@` 直接非法，`record()` 会抛错 | 改为 `panel:<dept>.<code>`（如 `panel:mfg.qb01`），零 schema 改动 |
| D2 | 钉钉身份绑定走官方连接器 `/bind` 一次性码 | 官方连接器 owner-binding 私存 `~/.dsh-dingtalk/`，不向平台暴露，拿不到 iam 账号↔staffId 映射；而 plugin-iam 已有扫码绑定 + identityLinks（unionId/staffId 双链） | 以 iam 扫码绑定为事实源，砍掉绑定码向导第 3 步；官方 `/bind` 仅留 DSH owner 语义 |
| D3 | 权限点 `dingtalk.message.send`、事件 `approval.requested`、`bus.subscribe` | PermissionCatalog 无 `dingtalk.*`；现有事件名是 `approval.created`；总线订阅本就不需要权限点 | 设计更名对齐仓库 |
| D4 | 五个 `plugin-panel-<dept>` 各带 `public/panel.js` 骨架 | 五份约 800 行骨架拷贝，与原型自身数据驱动结构矛盾 | **1 个 plugin-panel-core（骨架+共享 REST）+ 5 个部门数据包**（皮肤/配置/差异工具） |
| D5 | 图谱包上架插件市场（license 资产） | 市场 L0 门禁强制 `content.prompts` 非空 + 反向域名 id，纯数据 JSON 过不了 `parseManifest`；Ed25519 验签方向是"开发者签投稿"，不是"平台签 license" | v1 走内置资产通道（克隆 cardpacks 模式）；市场上架作为 Phase 4 契约扩展（`content.scenegraph`） |
| D6 | 行业三态 + license 下发（Ed25519 验签） | license 签发/验签/吊销链路不存在；平台侧签名私钥管理是新建安全议题 | 复用 audit approvals（申请→审批）+ grantCapabilities（激活）；Ed25519 原语复用 plugin-market，平台私钥按 owner-only 0600 惯例保管 |
| D7 | 部门码 rd/strategy | 与 cardpacks 五平台主题（rd/strategy 同名不同义）冲突 | 面板前缀统一 `panel.<dept>.*`，主题变量面板自管（`data-dept`），不复用 `data-platform` |

**另暴露 2 个仓库侧欠账（本设计触发，需顺手补齐）：**

- 面板插件自注册路由不进 routeMatrix，会逃出 selftest 的 100% RBAC 越权断言网——必须补"自注册+矩阵登记"机制；
- 告警规则 `channels:['dingtalk']` 目前只有数据没有投递实现（plugin-audit 无任何发送代码）——"Agent 升级告警同步钉钉群"依赖本次新建桥接面坐实。

---

## 二、开发量清单（前后端工作项）

### A. 前端（全部零构建 vanilla ESM，铁律不变）

可直接复用：`ui.js` 组件库（modal/drawer/table/charts）、`realtime.js`（SSE 降级轮询，目前零页面使用，面板是首个真实消费者）、`cmdk.js` 骨架、`errors.js`/`icons.js`、免登通道（entry-ticket，`/rq` 同源天然继承）。

| # | 工作项 | 性质 | 说明 |
|---|--------|------|------|
| F1 | 面板外壳（顶栏/部门 rail/三栏/hash 路由） | 新建 | 原型剥离；`serveStatic('/panel', …)` 挂载，对外 `/rq/panel/` |
| F2 | 五部门皮肤 | 新建 | `:root[data-dept=…]` 五组 CSS 变量，色值取原型 DEPT_META |
| F3 | 会话流组件（四类消息气泡 + 身份徽标 + 钉钉回执） | 新建 | **必须改造原型的 innerHTML 直渲为 esc() 白名单渲染**（XSS 面） |
| F4 | 输入区（@chips / 钉钉同步开关 / 提及解析） | 新建 | chips 数据源 = `GET /api/agents` + `GET /api/iam/roster` |
| F5 | Agent 操作卡片渲染器 + ops 按钮行为 | 新建 | vanilla JS 版（rq-card 是 React 构建产物，只借设计不借代码）；按钮→REST 映射 + 乐观态/回滚 |
| F6 | 任务看板 Tab（四泳道） | 新建 | 原型仅占位，从零 |
| F7 | 部门知识 Tab（产出物沉淀 + 引用复用） | 新建 | 从零 |
| F8 | 场景图谱 Tab（分组场景卡/评级统计/派诊断/同步钉钉） | 新建 | 原型渲染近乎照搬，数据改服务端供给 |
| F9 | 右栏 widget 组件库（bars/funnel/alerts/todos/feeds 五型 + 来源徽标） | 新建 | funnel/alerts/feeds 手写 DOM/SVG（禁图表库）；**来源徽标（连接器/手工/模拟）是治理硬性 DoD** |
| F10 | 行业选择器（三态徽标）+ 激活申请弹窗 | 新建 | 原型交互完整可剥离 |
| F11 | 钉钉状态胶囊 + 绑定向导（改为扫码绑定） | 新建 | 复用 iam.js 扫码绑定逻辑 |
| F12 | ⌘K 动态源接入 + 面板配置抽屉 | 新建/改造 | cmdk 数据源换 Agent/频道/场景/同事 |
| F13 | 实时化接入 | 接线 | realtime.js 接新 SSE/poll 端点，消息流/看板/未读数订阅 |
| F14 | console 侧小改：市场管理页（pages/market.js 新建）、审批中心行业激活 payload 展示、usage 资源名映射补 `panel:` 前缀 | 新建/小改 | console NAV 硬编码，需注册 |

### B. 后端

可直接复用（零改动）：guarded()+RBAC+changeLog 审计骨架、opsStorage 集合模式、tools/execute 工具桥、audit approvals（createApproval/registerExecutor/decideApproval，high 风险二次确认内建）、usage.record/grantCapabilities/价格簿机制、modelGateway.invoke、connector execute 七步链、iam 钉钉连接器（通讯录/SSO/identityLinks）、platformBus 事件总线、serveStatic 多 SPA 机制。

**新数据模型（opsStorage 集合，全部新建，落 plugin-panel-core）：**

- `panel:deptConfigs`（部门↔orgId、主题、协作模式、widget/KPI 布局）
- `panel:channels` / `panel:messages`（含 dd 同步/来源标记、uniqueOn 去重键）——**全平台目前没有任何 channel/message 模型，最大缺口之一**
- `panel:tasks`（泳道状态机 todo/doing/review/done，卡片动作落点）
- `panel:artifacts`（部门知识）、`panel:readCursors`（未读数）
- `scenegraph:industries` / `scenegraph:activations`（org×行业三态：locked/pending/active）
- `dingtalk:bridgeChannels` / `dingtalk:bridgeMessages`（群桥绑定 + msgId 去重回执）

**新 REST（挂 console guarded 区或自注册+矩阵登记）：**

- `GET /api/panel/:dept/overview|board`、`GET/PUT …/widgets|kpis`（配置抽屉）
- `GET/POST /api/panel/:dept/channels`、`GET/POST …/messages`、`POST /api/panel/messages/:id/card-action`
- `GET/POST/PATCH /api/panel/:dept/tasks`、`GET /api/panel/:dept/artifacts`
- `GET /api/panel/:dept/stream`（SSE，**服务端零 SSE 端点，从零新建**）+ `GET …/poll`（降级）
- `GET /api/panel/industries`（三态）、`POST …/activate-requests`、`GET /api/panel/scenegraph?industry=`
- `GET /api/dingtalk/status`、`POST/DELETE /api/dingtalk/channels/:id/bridge`、`POST /api/approvals/:id/push-dingtalk`

**新服务/运行时：**

- **panelAgentRuntime**（最大缺口之二）：读 agent 资产（model/systemPrompt/riskLevel/dataClass）→ 组装频道上下文 → modelgw 单轮（MVP 无工具循环）→ 产出写 messages+artifacts → 计量 → emit 事件。dsh 宿主"单助手+工具"范式不动，自建轻运行时是唯一不碰宿主的解
- **widget 求值器** `resolveWidgetSource()`：connector/mcp/manual/mock 四源适配，逐 widget 降级（照抄 portal.board() 范式）
- **场景图谱加载服务**：克隆 cardpacks 模式（validateScenegraph 校验器 lint/运行时双端共用 + 失效处理 + `scenegraph.updated` 热刷新）
- **行业激活链路**：申请→audit approval（kind=`industry.activation`）→ executor 签发 license（Ed25519，验签 fail-closed）→ 置 active + grantCapabilities + 价格簿校验
- **钉钉桥接 plugin-dingtalk-bridge**：出向复用 iam 连接器凭证/corpAccessToken 缓存（不开新凭证存储）；入向引入 `dingtalk-stream` SDK（仓内零钉钉 SDK）；审批桥订阅 `approval.created` → 推卡片 → 回决写回 decideApproval（fail-closed 复用既有强制）；顺带坐实告警 dingtalk 通道投递
- **工具**（注册共享 tools 键）：`panel_agents_list / panel_msg_send(--sync-dingtalk) / panel_task_create|transition / panel_scene_diag / panel_widget_data`

**注册表扩展（additive 小改但卡住一切合法性）：**

- PermissionCatalog + BuiltinRoles + 角色迁移数组：`panel.read/panel.write/panel.config.write/panel.task.write/dingtalk.message.send/scenegraph.read/scenegraph.activate`
- 价格簿播种 `panel:*` 零费率（不播种 record() 硬拒绝）
- PlatformEvents：`panel.*`、`scenegraph.updated`
- gen-manifests.mjs PLUGINS 数组 + industry/dingtalk 节发射（**注意 YAML 子集解析器：数组必须块式输出**）
- 三处装配同步：boot-all.ts / cordis.yml / selftest mountCtx（+`/api/platform/info` 硬编码清单）
- usage resource 校验、plugin-market `content.scenegraph` 载体扩展（Phase 4）

### C. 明确不做/移交项

- **业务连接器生态为零**（ERP/MES/CRM/PLM 一概没有，种子只有 hackernews 演示）——演示期 100% 数据走 manual/mock + 来源徽标，连接器接入作为显性运营工作项移交，不堵面板开发
- 任务看板/部门知识两个 Tab 原型只有占位，列为后续迭代
- DWS 数字员工为可选增强，最后做
- KBaaS / 编排画布（WP-13/15）维持既有延期决议，与本设计无冲突

---

## 三、风险与外部依赖

1. **R-SPIKE（阻塞性）**：`@dingtalk-real-ai/dsh-dingtalk` 不在仓内，其是否向 dsh 共享 ToolRuntime 暴露发送/事件面未知——实施前先做 spike 拿连接器文档核对；且同一 clientId 全企业仅一条 Stream 连接，官方连接器与自建入向不能并存
2. **凭证单一来源**：iam connector config（appKey/secret）为唯一事实源，禁止 `$DSH_HOME/.credentials.yaml` 双源
3. **架构约束**：宿主 web diff=0（面板只活 `/rq` 下，不进宿主会话 UI）；console 零构建；上游合并摩擦——新建 plugin-panel-* 是本项目独占目录，合并摩擦为零
4. **安全治理**：消息 XSS 白名单渲染、绑定/解绑/推送全量审计、钉钉回决身份校验（staffId↔identityLinks 反查）+ fail-closed、计量键格式裁决先行
5. **钉钉 webview**：SSE 必须配 30s 轮询兜底（既有结论），stream+poll 双端点都要提供

---

## 四、实施路径（阶段计划，按依赖排序，不计人天）

**Phase 0 · 裁决与工程底座**（解锁一切的前置）

1. 四项裁决定稿：面板装载形态 / 插件划分（1 骨架+5 数据包）/ 计量键格式（`panel:<dept>.<code>`）/ 钉钉路线（spike 官方连接器暴露面 + 确定组合方案）
2. 向设计方反馈 D1-D7 修订意见，设计文档口径对齐
3. 注册表扩展：PermissionCatalog/角色迁移、价格簿 `panel:*`、PlatformEvents、gen-manifests 生成器（industry/dingtalk 节、块式数组）
4. routeMatrix 机制下沉或插件自报登记（保住 RBAC 100% 断言网）
- 门禁：`npm run selftest && npm run lint:manifests` 全绿

**Phase 1 · 面板骨架 + 数据面 + 家电×制造部标杆**（DESIGN.md 落地路线第一步）

5. plugin-panel-core：serveStatic('/panel')、外壳 HTML/JS/CSS、data-dept 皮肤、api.js BASE 适配（修 `new URL('.', baseURI)` 在 `/rq/panel/` 下的推导缺陷）
6. `panel:*` 集合 + 核心 REST + 权限点接线
7. 消息闭环（channels/messages + F3/F4 前端）→ 任务域（tasks 状态机 + 看板 + 卡片动作 confirm-dispatch/reprioritize 走纯平台链）
8. panelAgentRuntime MVP（modelgw 单轮）→ @Agent 唤起回写 + artifacts 沉淀
9. widget 抽象 + board 聚合端点（manual/mock 源 + 来源徽标），五部门渲染跑通
10. Agent 名册接线（GET /api/agents 按 orgId 过滤）+ 发起协作入口
- 门禁：dom-smoke 面板版用例、walkthrough 面板链路、selftest 新 sections 随做随补

**Phase 2 · 场景图谱 + 授权激活 + 计量**

11. validateScenegraph + QB01/GCJX JSON 从原型剥离 + 加载服务 + `scenegraph.updated`
12. 行业三态端点 + 行业选择器/激活弹窗接通真链路（approvals executor + license 签发验签 + grantCapabilities）
13. 场景图谱 Tab + `panel_scene_diag` 工具（诊断任务进会话）
14. 计量埋点 `panel:<dept>.<code>` + console 市场管理页 + 审批中心 payload 展示
- 门禁：激活全流程/计量落账/图谱热更新进 selftest

**Phase 3 · 实时化 + 钉钉桥接**

15. SSE `/api/panel/:dept/stream` + poll 端点 + realtime.js 接入（消息流/LIVE 看板/未读数）
16. plugin-dingtalk-bridge：状态胶囊（读 iam bindings）→ 频道群桥建解绑 → 出向发送+回执 → 入向 Stream+去重
17. 审批卡片推送钉钉 + 回决写回（fail-closed）→ 告警 dingtalk 通道坐实
18. DWS 数字员工增强（官方连接器安装/状态展示）
- 门禁：钉钉 chatbot stub 进 selftest（参照既有 ddStub 模式）、dingtalk-h5-smoke 扩展

**Phase 4 · 五部门裂变 + 资产化**

19. rd/sales/strategy/fin 四个部门数据包（纯配置+皮肤+差异工具）
20. 市场 L0 契约扩展（`content.scenegraph`）→ 图谱包上架 → 复制其余 13 行业（数据建模工作量）
21. 测试收口：装配一致性断言、面板 RBAC 矩阵全覆盖

全程铁律：每阶段 `npm run selftest`（820+ 递增）+ `npm run lint:manifests` 全绿方可推送交付；只开发 `custom/dsh-rq`，上游只 fetch 不 push，推送目标仅 RQ-DSH。
