# 开发日志（append-only）

> 格式：`## [UTC 时间] AgentID —— 工作单#x` + 改动摘要 / 涉及文件 / 遗留风险。
> 只追加，不改写他人条目。时间戳用当日实际时间。

---

## [2026-08-27] lead-agent —— 项目启动 + 进度体系建立

- 通读《dev-plan-connector.md》（C:\Users\Administrator\Downloads\dev-plan-connector.md），确认仓库 `D:\DSH-07\ybkkasi` 与计划落点对应（17 个插件包、cordis 双装载面、scripts 三脚本齐全）。
- 建立 `docs/dev-log-connector/{PROGRESS.md,journal.md}` 协作体系（协议/状态表/冲突地图/占用登记/T 进度）。
- 教训记录：第一版 PROGRESS.md 误把规划状态写成了已完成态，已重写为真实 todo 态——**后续任何 Agent 禁止预写未来状态**。
- 下一步：复制计划书到 `docs/dev-plan-connector.md`；创建 pre-M0 快照；开始精读参考代码（plugin-modelgw 骨架 / plugin-mcp 权限组与 invoke / console guarded 区 / boot-all 装载）后开工 #2。
- 遗留风险：本环境无 docker/sidecar 运行时，M0(#1) 的真实桥接联调只能交付文档+compose 文件，部署验证留给真实环境；selftest 以进程内 stub 承载 T-01~T-25/T-28/T-29。

## [2026-08-27] lead-agent —— 参考代码精读完成 + 认领 #2~#6

- 已确认关键先例落点：
  - 插件骨架模板 = plugin-modelgw（178 行）；env: 间接引用一行式在 modelgw L102。
  - 权限组/授权语义 = McpService.authorize（mcp L688-716）：subjects 命中（user_group 经 ctx.iam.resolveGroupMembers）、allowedTools 含 '*'；readOnly 强制已有，denyParams 在 mcp 侧确无强制点（本计划补上）。
  - invoke 网关形态 = mcp L720-779（限流滑动窗口 L734-743、recordCall 计量入 usage L860-874、事件 McpInvoked L851）。
  - usage：record 校验 L152-211（幂等重放返回既有事件不重复计量——正好支撑 T-22）、价格簿前缀匹配 `*:*` L377-385、ensureDefaultPriceBook L387-399、resource 正则 L498。
  - audit：registerExecutor L389、createApproval/decideApproval L394-453、evaluateAlerts 取值键（非 permission_denied/mcp_unhealthy 一律读 context.value）L314、authz.denied 监听 L196、consume('audit') 成本归集 L222-239。
  - billing.precheck L276-284。
  - console：use 中间件双轨身份 L143-166、guarded L184-195、changeLog L198-213、mcp import 端点 L1279-1293、工具桥 L2547-2567、POST /mcp L2609-2676、injectToolIdentity L2522-2545、resolveMcpCaller L2510-2516。
  - boot-all 为手工序列；cordis.yml/cordis.patch.yml 双装载面均有手工列表——三处都要加（journal 早前推断正确）。
  - gen-manifests PLUGINS 目前 12 个插件（无 market/modelgw/usage 等），manifest 五面生成口径已明确；lint 仅做 YAML 可解析校验。
- 设计决策（偏离计划的显式留痕，后续 journal 关联验证）：
  1. **oct_ 令牌值内存缓存**：令牌值仅创建时返回一次且库中只有哈希——平台侧采用进程内存 Map 缓存 + 重启后惰性重铸并 DELETE 旧令牌；台账集合（connector:tokens）永远只存 ocTokenId/policySnapshotHash。理由：oct_ 是平台自持的运行时令牌而非 provider 凭证，但为最大化贴近"零密钥落盘"红线（T-24 全文扫描），选择永不落盘。
  2. **connector.connect 审批两段式**：审批单负载禁止携带任何凭证字段（否则凭证进 audit 存储，违反红线一）。改为「申请单 → approve → 发起人在有效期内携 approvalId 提交实际凭证（finalize）」，executor 注册保留用于审批通过登记；实质门禁 = finalize 时校验 approvalId 状态 approved 且请求主体一致。
  3. **granting 组决定租户**：invoke 的 orgId 取命中权限组的 group.orgId（而非反查用户归属组织），使「计费主体=授权边界」严格一致（跨 org 授权天然隔离）。
  4. riskLevel 映射与默认 admin 兜底、denyParams 支持顶层键与点路径、限流窗口复用 mcp 形态等按计划书 §2.4/§2.1 执行。
- 认领范围：#2/#3/#4/#5/#6/#7/#8/#11 全部由 lead-agent 实施（见 PROGRESS.md 占用表）。

## [2026-08-27] lead-agent —— #2~#6,#8 实现完成 + 启动冒烟全通（部分验证）

- 新建 `packages/plugin-connector/`：package.json、src/{client,errors,risk,index,tools}.ts。
  - client.ts：OcClient v1.4.0 契约面（health/providers/actions/action/guide/connections PUT·GET·DELETE/oauth authorizations/runtime-tokens CRUD 含 PUT 四数组/executeAction（oct_+alias+Idempotency-Key）/listRuns cursor 分页），统一信封解包，OcError 错误码→状态映射表（connection_not_allowed 403 等）。
  - errors.ts：OcError{code,status,guidance}（guidance 承载 oauth_client_config_required 的自备 App 指引，P1 修正⑩）+ OcUnavailableError。注意 Node strip-only 模式禁用 TS 构造器参数属性——已改显式字段（自启动冒烟发现）。
  - risk.ts：heuristicRiskLevel（scope 正则 → 名称正则 → admin 兜底），RISK_RANK 比较。
  - index.ts（ConnectorHubService）：六个集合；gateway 单例+env: 间接引用+30s 探活+fail-closed（env 门禁先于网络探测）；目录同步（riskLevel 映射、resource 正则 skip、diff→事件→受影响组令牌镜像）；连接管理（OAuth 两段式审批 no-secret 设计、API Key 直达不落盘+脱敏 summarize、no_auth 登记级联删除检查、org:前缀强制、confirmConnectionStatus 轮询回填）；权限组 CRUD+validatePolicies(含引用连接存在性)+impact 预览；令牌镜像 mirrorTokenPolicy(快照 hash 变化才 PUT 四数组)/obtainOctToken(内存缓存+重启惰性重铸并 DELETE 旧值)；invoke 七步链 dryRun/admin 审批单去重(rateBucket key=组:caller、precheckCents 可配、幂等键 connector:<runId>、trace_id=executionId、auditPersisted=false 补记+errorRate)、executeWithRecovery(401/connection_not_allowed→PUT 最新快照+重试一次)；runPatrols(org 巡检：token.policy.allowedConnections ⊆ 组 org 内连接校验→synced 异常+audit.fire warning)；reconcileRuns(cursor 增量+processedIds 环形去重 cap 4000+usage trace_id 反查→绕行 critical)。
  - tools.ts：5 个 defineTool（catalog_search/connection_list/execute/perm_group_list/run_list）permission 与 REST 对齐。
- 接线改动：bus.ts +7 Connector* 常量；iam PermissionCatalog+8 点/BuiltinRoles(resource_admin 加 connector.* 通配,developer/auditor 显式点)/ensureConnectorPermissionsMigration(iam:migrations 标记集合)；usage ensureDefaultPriceBook+connector:* 零费率；audit CostRecord.connectorService 字段+consume 分支(toolCalls 计入)+7 个 Connector* 监听器(Invoked→invoke 日志透传 actChain/runId)；boot-all+cordis.yml+cordis.patch.yml 三处挂载（market 后 mcp 前）；gen-manifests PLUGINS+connector 条目；npm install 链接 workspace 包。
- plugin-mcp api.yaml 补登教训：**补登必须写进 gen-manifests.mjs 的 PLUGINS.api 数组**——直接改生成文件会被下次 npm run manifests 覆盖（已发现已修正）。
- console：inject+'connectorHub'；guarded connector 路由段 ~180 行插在 MCP/Skill 之间；runWithOcErrors(OcError duck-typing 透传 status/code/guidance)+restrictOrgScope(非 '*' 用户锁本组织)+resolveConnectorCaller+requireBodyOrg/maskReference；injectToolIdentity 增加 connector_execute 身份注入；resolveConnectorCaller 曾被误删又在路由段使用导致 ReferenceError——已修复（journal 复盘点：编辑共享大文件时用 grep 自查同名声明/引用对偶性）。
- `npm run lint:manifests` = 70/70 ✅。
- **启动冒烟（空库 data-smoke port 7399）**：bootAll 全树拉起成功；admin 登录 → GET /api/connector/gateway 返回 fail-closed 详情（envChecks 双 true、status unconfigured）✅；GET /api/connector/connections ✅；REST 工具桥执行 connector_catalog_search ✅；POST /mcp tools/list 含全部 5 个 connector_* 工具 ✅——三端同契约成立。
- 待办推进：#13 selftest（含端到端七步链/stub 全契约断言）、#9 页面、#10 CLI、#14 文档。

## [2026-08-27] lead-agent —— #13 selftest 全绿（521/521）+ #9/#10/#14 收口

### selftest 迭代过程（踩坑实录，供后续 Agent 复用）
1. **标识符遮蔽连环坑**：同一巨型 try 块内既有 OIDC 段的 `const oc`（openid-client 命名空间）与 `const ocTokens`（授权码响应），与 stub 变量同名 → 后段引用解析到 OIDC 局部（frozen namespace/plain object）。stub 侧改名 `ocCtl`/`ocLedgerTokens` 解决。教训：往共享大文件插断言前先 `grep -n "const <名>"` 排雷。
2. **探活 env 门禁误伤**：初版以 `gatewayStatus().available===false` 短路探测，把「尚未探活」过渡态文案持久化成 unavailableReason。修正为仅「加密钥缺失/adminToken 不可解析」两类硬问题才短路；过渡态必须继续真实探测。
3. **执行器注入校验**：audit executor 闭包访问 `ctx.connectorHub` 被 cordis 注入校验拒绝。改用与 plugin-mcp 相同形态——apply() 内 `new ConnectorHubService(ctx)` 直接持实例。
4. **stub 门禁语义**：open-connector 的 `/v1/actions` 接受 oct_ 而非必须管理口令；stub 初版一刀切拦导致平台合法调用全 401。已放行数据面 POST + oct_ 注册校验。
5. **审计中心 decideApproval 时序**：executor 在 status 仍为 pending 时同步执行——invokeAction 审批回查不能读状态，改内部标志 `viaApprovalExecutor`（不对外暴露）。
6. **T-02 确定性**：进程 env 无法运行中修改 → 落地只读预演探针 `GET /api/connector/gateway?assumeEnv=JSON`（resolveAdminToken 同步接受 envProbe），不改真实环境即可断言双分支 fail-closed 文案。
7. **幂等重放**：T-22 手工直连 stub（同 Idempotency-Key 两次）断言同 executionId+单 run；平台侧写类自动 randomUUID 保证不同逻辑调用各自独立键。
8. **T-13 确定性**：自动恢复删旧铸新——固定旧值匹配失稳；引入哨兵 `*ANY*` + 「最新铸造值=当前组令牌」规则后完全确定。
9. **候选组顺序不确定性**：多组并集命中时 authorize 取首个可用组，dry-run 组名/限流断言曾漂移。限流改为单点清单组隔离主体。
10. **http.ts 幂等写守卫**：错误处理器与外层 guarded 兜底存在同请求双写路径（ERR_HTTP_HEADERS_SENT 噪音）——platform-core ok()/fail() 增加 headersSent 早退，惠及全部域。

### 服务端补齐（随断言需求诚实外显）
- syncCatalog 目录下架 → 显式清单命中组先落库裁剪再镜像（PUT 四数组自然发生）。
- REST 新增：POST /api/connector/patrol、gateway GET assumeEnv 预览、perm-groups impact。
- plugin-mcp：createService 增加 bridgeFrom 透传入库；importServices 从 header x-bridged-from 打标。
- plugin-agent：机器凭证默认 scopes 补 connector.invoke + 存量一次性迁移 agent-scopes-connector-invoke-v1（照 usage.write 先例）。
- seed：连接器演示种子挂 OOMOL_CONNECT_DEMO_SEED=1 env 门禁（网关引用/no_auth 连接/只读模板组），生产基线零污染。

### #9 控制台 & #10 CLI
- pages/connectors.js：四 Tab（目录/连接/权限组/运行日志）；网关抽屉（env 检查可视化 + 预演探针文案位）；三形态向导（OAuth 跳转+轮询入口、api_key values JSON 过手直达「即刻丢弃」提示）；权限组 JSON 编辑器（影响面预览行 + 只读模板二次确认）；runs 表格 + oct 台账抽屉（明示永不显示令牌值）+ 对账按钮。
- app.js NAV AI 资源组 #/connectors（perm=connector.catalog.read）+ builders；mcp.js 对 bridgeFrom 渲染「桥接过渡」徽章（hover 说明降级语义）。
- dshctl COMMANDS.connector 全树 + help 用法段（gateway/catalog/connections/execute 审批指引/perm-groups/runs/reconcile/tokens）。

### #14 文档
- docs/connector-integration.md：架构一页图/compose(pin v1.4.0)+node 直跑/强制 env 对照/fail-closed 行为表/OAuth 直连·反代两拓扑 runbook/自备 App 四步/M0 操作含治理降级声明/M1+ CLI 手册/升级与未载项声明/故障排查速查。
- README.md 新增「三G」章（对齐三F 结构：红线三条/能力清单/验收口径）。
- skills/dsh-ops-connector/SKILL.md：何时使用/工具映射/六场景手册/五条护栏。
- PROGRESS.md 状态表/T 进度表更新为真实完成态（M3 #12 保持业务触发锁定）。

### 最终门禁
- npm run lint:manifests = 70/70 通过
- npm run selftest = 521/521 通过（exit=0；前序 sections 无回归 + 连接器 section ~52 断言）
- 快照：D:\DSH-07\snapshots\{pre-M0.tgz, post-M2.tgz}

### 遗留/交接事项
1. M0 真实 sidecar 部署联调（docker 环境）待执行：compose 已备好，检查清单见集成指南 §2/§3。
2. M3(#12) 市场化：设计就绪（manual-settlement 锁定），启动条件=首个外部开发者提交连接器型插件上架申请（P0 修正③）；届时工作面=市场 UI/manifest connector 字段/install approved⊆requested 扩展/settle 分支。
3. connector_latency p95 规则播种未加（error_rate 已接 evaluateAlerts）；运营需要时在 seedAlertRules 加一条 metric='connector_latency' 即生效。
4. 本环境 Node v24.15.0；strip-types 不支持构造器参数属性——新代码保持显式字段写法。

## [2026-08-27] cto-doc-agent —— 工作单#1 桥接集成指南初稿

- **认领与交付**：按协作协议在 PROGRESS.md §四登记（14:56）后执行 #1；本环境无 docker/sidecar 运行时，#1 按团队约定交付「文档 + compose 内容」，真实桥接联调留给生产环境 → #1 定为 partial。
- **前置核验**：通读 dev-plan-connector §〇/§2.2/§2.9/§2.11/§三#1 + PROGRESS/journal；对照真实代码逐条核验 M0 链路——`POST /api/mcp/import`（console L1279-1293，body `{config: string|object, autoDeploy?}`，root org，perm `mcp.service.write`）、`importServices()`（plugin-mcp L350-418，mcpServers 三形态解析、stdio 拒绝、`x-bridged-from`→`bridgeFrom` 打标、autoDeploy 缺省 true、不可达保草稿清工具）、`sync-tools`（L339-348，仅 external+real）、`authorize/invoke`（L699-727/L731+，权限组+限流+熔断 30s×3）、`McpImportResult`/`InvokeResult` 响应形状、登录端点 `/api/auth/login`、`/api/iam/groups`。
- **重要发现（并发与重叠）**：开工时发现 `docs/connector-integration.md` 已存在一份 lead-agent 随 #14 顺带产出的草稿（PROGRESS #1 当时仍 todo、无人按 #1 认领）。本版在其基础上按 #1 交付要求重构补全，并保留其中经代码核验属实的内容（M1+ CLI 手册、fail-closed 对照表含 `?assumeEnv=` 预演、dshctl 命令组）。**两处事实更正**：①草稿 M0 示例 headers 用「管理口令」调 `/mcp`——数据面应为 oct_ 运行时令牌（对齐计划书 §2.11「headers 携带 bootstrap/oct_ 令牌」）；②草稿 invoke 示例 tool 名 `hackernews_get_top_stories` 证据不足——应为 `execute_action` + actionId 参数，且工具名/参数以 tools/list 发现的 inputSchema 为准。
- **指南 v0.2 章节**：一定位与红线 → 二部署拓扑（ASCII，管理面/数据面标注）→ 三 sidecar 部署（compose pin v1.4.0 完整内容 + `${VAR:?}` 编排层 fail-closed、node 直跑、强制 env 表 + 双强制项缺失平台侧 fail-closed 文案、assumeEnv 预演）→ 四 OAuth 回调两拓扑 runbook（直连/反代各自 DNS·端口·配置步骤·取舍 + 速查表 + 自备 App 四步）→ 五 M0 step-by-step（探活→铸 oct_→登录→import 真实请求/响应示例→工具同步→权限组→execute_action 冒烟→回收）→ 六治理降级声明（P2 修正⑬ 五点 + bridgeFrom 徽章）→ 七 M1+ CLI 速览 → 八生产验证清单（A sidecar/B M0 桥接 T-25/C 三类 provider 全谱系/D fail-closed 逃生）→ 九升级与边界 + 故障排查 → 十撰写说明。
- **涉及文件**：`docs/connector-integration.md`（重构补全，v0.1→v0.2）；`docs/dev-log-connector/{journal.md,PROGRESS.md}`（协议回写）。未触碰任何代码文件，未运行 npm 命令。
- **遗留风险**：①真实环境桥接联调缺口（#1 partial 的唯一缺口）——执行人按指南 §八 清单勾选回填，完成后 #14 完稿；②指南 §5.6 的 execute_action 参数名以 tools/list inputSchema 为准的口径需在真实联调时确认（open-connector `/mcp` 工具 schema 属上游文档未细载项）；③「桥接过渡」徽章 UI（#/mcp 已随 #9 落地 mcp.js 渲染，#/connectors 侧徽章 hover 文案以 §六 声明为准）。

## [2026-08-27] lead-agent —— 验收意见四项处理 + 上游 v1.4.0 源码实证

### 验收闭环（用户验收反馈逐条落账）
1. **① connector.offline 执行器**：已补齐——hub 新增 `offlineGateway/onlineGateway/offlineConnection/onlineConnection` 四方法；`apply()` 注册 `connector.offline` executor（scope=gateway|connection 双分支）；探活引入 `maintOffline` 维护墓碑（30s 定时器不会自动复活，这是与普通探活失败的本质区别）；连接级下线引用新增 `offlinedAt/offlinedBy/offlinedStatusFrom` 字段，refresh/confirm 轮询对 offlined 态一律跳过不复活；invoke 增加连接级闸（策略唯一绑定别名或显式 alias 处于下线态 → 平台侧直接 denied「已下线」，不发 sidecar）。REST：POST /api/connector/gateway/{offline,online}、connections/:id/{offline,online}（默认 L4 审批、viaApproval=false 为管理员直连留痕路径）。CLI：gateway offline --reason [--direct]/online；connections offline <id> --reason [--direct]/online。selftest 新增双 scope 闭环断言（审批通过→executor 落地→fail-closed→恢复 healthy→连接 direct 下线→经由调用被拒→恢复 active）。
2. **② M0 真实联调回填**：本机确证无 docker（docker not found；ghcr 可达 401 正常，非网络阻塞）——生产部署步骤物理上无法在开发机执行，**维持 #1 partial，待运维按集成指南 §八清单在生产主机勾选回填**。本轮完成了清单 B/C 项的全部代码侧可验证部分：
   - 克隆上游 tag v1.4.0 至 D:\DSH-07\_upstream-oc（后已清理），源码级实证：`connection_not_allowed` 错误码（src/core/action-policy.ts L10/L190）、token 策略四数组 allowedActions/blockedActions/**allowedProxies**/allowedConnections（同文件 L30/L37）、x-oo-connector-alias（src/core/guarded-fetch.ts）——与我方 client.ts/镜像假设逐项吻合。
   - 吸收 cto-doc-agent 对 M0 形态的两处更正进 stub 与断言：/mcp 数据面鉴权=管理口令(bootstrap)或合法 oct_（此前 stub 未校验）；工具规范形态=**execute_action(actionId,input)**（tools/list 已加 canonical 条目，legacy 别名保留兼容既有 T-25 断言），并新增「桥接 execute_action 规范调用」断言。
3. **③ connector_latency 规则播种**：seedConnectorDemo 幂等播种两条规则——connector_error_rate(critical, gt 5) 与 connector_latency(warning, gt 3000ms)；hub invoke 成功尾部按单次耗时直评 evaluateAlerts('connector_latency',{value})（p95 运营关注口径，引擎语义为超阈即报）。selftest 断言两条规则随 DEMO 实例在场且 severity 正确。
4. **④ POST /mcp 直调 connector_execute 断言**：验收项原定"下次迭代"，成本极低故**本轮提前闭合**——rawReq tools/call id=88 直调 connector_execute，断言身份注入链路 + runId/exec-* 回执 + data.echo.viaMcp 透传。

### 技术债确认
- **多实例 oct_ 内存令牌缓存改造**：已知约束——每权限组令牌值仅存进程内存 Map，多实例横向扩展时各实例缓存漂移（重启惰性重铸+DELETE 旧值仅保证单实例收敛）。CTO 台账已登记；可能的演进方向（记录备查）：a) sidecar 支持 token 值二次获取/JWKS 形态则直取；b) 平台引入共享 KV（依赖部署形态决策）前维持单实例红线写进部署文档；c) short-TTL 重铸风暴防护。在本仓不做提前动工。

### 门禁与快照
- npm run lint:manifests：70/70 ✅
- npm run selftest：**531/531 通过（exit=0）**（首轮 521 → 验收轮 +9 offline/规则/mcp 直调 +1 execute_action 规范形态）
- 快照：D:\DSH-07\snapshots\post-acceptance.tgz（pre-M0/post-M2 仍在）

### 协作备注
- 本条目不动 cto-doc-agent 的任何历史条目与其对集成指南 §八 的结构化交付；两处 M0 口径更正已在其条目内说明，我方以代码+stub+断言形式吸收完毕。PROGRESS.md #1 行仅做句尾追加（上游实证结论），其状态判定（partial 待真实联调）不变。

## [2026-08-28] release-agent —— 架构审查修复验收 + 生产发布（selftest 557/557 + GUI 全绿 + 部署 192.168.0.7）

### 本轮内容
- 独立架构审查（ARCH-REVIEW-2026-08-28.md）的修复批次的系统验收与发布：
  P0-1 工具/REST 组织收敛统一（connectorHub.orgScopeFor 一套标准、外部机器 fail-closed 空集）、
  P0-2 身份注入防自填、机器主体角色化授权（roleIds + resolveMachineScopes）、
  控制台 authn/connectors/login/connect/iam/agents/apps 多页迭代 + base.css、copyText 抽取至 ui.js。
- 工具链：jsdom 入库为 devDependency，dom-smoke.mjs 纳入常规门禁。

### 门禁记录（全部本机实测）
- npm run lint:manifests = 70/70 ✅
- npm run selftest = 557/557 通过（exit=0）✅
- node scripts/dom-smoke.mjs（隔离实例 DEMO_SEED=1 :7301 data-guitest）= 14/14 ✅
  - 修正两处过时脚本预期（非产品回归）：T10 口令弹窗选择器 `#pw-copy`→`#cred-password`（弹窗结构早已更名，实测建号/口令展示/服务端落库均正常）；T14 签发凭证弹窗改异步拉取可绑定资源与授权目录后需 waitFor 打开，且新增授权必填校验（补 `#authz-star` 分支）。
- 真实浏览器 GUI 验收（Chromium 1440×900 黑盒）：登录双入口、连接器四 Tab、网关抽屉 env 可视化、
  新建连接三形态（api_key 即刻丢弃提示）、签发凭证空授权拦截 + `*` 一次性凭证、
  编辑权限即时生效（* → 附加 2 项）、轮换密钥闭环（clientId 不变/旧值吊销）、
  平台接入双卡、角色弹窗机器凭证同步提示条——全部通过。
- 已知轻微观察项（不阻塞）：签发凭证「已保存」后主体表格不即时自刷，重进页面计数正确（16→17）；权限编辑路径则即时刷新，两路径体验不一致，可后续统一。

### 发布
- GitHub：01men/ybkkasi main 提交并推送。
- 宿主平台：192.168.0.7:/opt/ops-platform（systemd ops-platform，:7300）同步变更文件后重启，健康探活 + 关键接口验证。
