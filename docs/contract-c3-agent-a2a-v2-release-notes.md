# 契约发布说明：contract-c3 升版 v2（A2A 完整协作闭环 + UHP 执行驱动）

> **依据**：《企业数字员工内网通信协作方案设计（融合版）v2.0》
> **冻结基线**：contract-c3 v1（2026-09-11）
> **发布日期**：2026-10-20　｜　**变更纪律**：红线 1（升版须发发布说明并双侧同步）+ 红线 2（attrs 白名单 additive）
> **双侧同步**：本说明与 `docs/contract-c3-agent-a2a.md`（v1 原文保留）、「协议键中文对照总表」三处一致。

## 一、v1 诚实缺席项的补齐声明

contract-c3 v1 声明的四项「不在范围」，本版补齐三项半：

| 缺席项 | v2 状态 | 落点 |
|---|---|---|
| 完整 A2A 会话协商协议 | **已补齐** | plugin-a2a JSON-RPC 方法面（message/send·stream、tasks/get·list·cancel）+ 八态 Task 生命周期 |
| 跨运行时发现（discovery） | **已补齐**（内网形态） | `GET /api/a2a/directory` 平台内目录 + well-known Agent Card（不做公网 registry 抓取） |
| 自治级别双向协商握手 | **已补齐** | A0-A3 协商策略引擎（纯函数矩阵）+ A3×A3 要约/还价（上限 3 轮，超限 rejected） |
| A3 多方仲裁 | **未做**（诚实保留） | 3 方以上协作由 flow-core 事务流承载 SLA 升级与人工仲裁，不引入新仲裁协议；本版未新增 flow-core 编排绑定，落点见「七、未尽事项」 |

## 二、结构变更登记（红线 2：Agent 资产 attrs additive）

`AGENT_TYPE_SPEC` 新增「协作属性」字段组（全部选填、不设 requiredForOnline；存量登记按缺省口径兼容，退化为 v1 点名调用行为）：

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `a2aDataClassCeiling` | enum `public/internal/secret` | `internal` | A2A 协作可接收的最高任务数据密级（渠道口径；与业务密级 `dataClass` 是两套同名不同义枚举，禁止按名直译，D14 纪律不变） |
| `uhpHarnessRef` | string | 空 | 指向 plugin-uhp configured harness 注册项；空 = UHP 按本 Agent attrs 临时投影执行 |
| `uhpSessionPolicy` | enum `task-bound/employee-bound` | `task-bound` | UHP 会话续接策略 |

**usage_events 表 additive**（对齐 D3 先例）：新增 `context_id TEXT NOT NULL DEFAULT ''` 列（A2A contextId 协作链归集），存量库 pragma 探测 + ALTER 幂等迁移；`UsageRecordInput.contextId` 可选入参，聚合/幂等口径不变。

## 三、v1 端点兼容声明（不破坏）

- `POST /api/agents/:idOrSlug/a2a/invoke` **原样保留**（权限点 `agent.a2a.invoke` 不变），行为仍是 v1 单轮平台代答——存量调用方零感知。
- `agent.a2a.invoked` 事件继续发射，payload 增加可选 `taskId`/`contextId` 键（additive）。
- v1 的计量口径（零价快照 `resource=agent:<id>`、幂等键 `a2a:<agentId>:<principal>:<序号>`）在 v2 任务收口时延续，幂等键细化为 `a2a:<agentId>:<principal>:<taskId>`（+ 尝试序号 `:a<n>`），审计类型仍为 `agent.a2a.invoke`（invoke 双分支）。

## 四、新增端点与协议面（权限/鉴权全量登记）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /.well-known/agent-card.json` | 免鉴权（协议面） | 平台目录卡（含 Ed25519 验签公钥） |
| `GET /.well-known/agents/:slug/agent-card.json` | 免鉴权（协议面） | 单员工签名卡（JWS EdDSA；先验签后采信） |
| `POST /api/agents/:slug/a2a` | guarded `agent.a2a.invoke` | JSON-RPC 2.0 主端点（message/send·stream、tasks/get·list·cancel） |
| `GET /v1/a2a/tasks/:taskId/events` | 自校验 `?token=`（fail-closed） | 任务 SSE 事件流 |
| `GET /api/a2a/directory`、`GET /api/a2a/tasks[/:taskId]`、`GET /api/a2a/fulfillment`、`GET /api/a2a/patrols`、`GET /api/a2a/rules` | guarded `a2a.directory.read` | 治理视图 |
| `POST /api/a2a/tasks/:taskId/acceptance` | guarded `a2a.task.accept` | 人工交付验收 |
| `POST /api/a2a/rules`、`DELETE /api/a2a/rules/:id`、`POST /api/a2a/patrol/run` | guarded `a2a.admin` | 审批规则与巡检 |
| `GET /v1/uhp` | 免鉴权（规范要求） | UHP 能力发现（版本锁定 2026-08-11，conformance=core） |
| `POST /v1/uhp/responses`、`GET /v1/uhp/responses/:id`、`POST /v1/uhp/responses/:id/cancel` | 自校验 Bearer + `uhp.invoke` | UHP 任务面（幂等键请求头；stream=true 为 SSE） |
| `GET/POST /api/uhp/harnesses[/:id]`、`GET /api/uhp/responses` | guarded `uhp.read`/`uhp.admin` | harness 注册表管理 |

> 工程注记：方案原文的 `/api/agents/:slug/.well-known/agent-card.json` 路径形态调整为 `/.well-known/agents/:slug/agent-card.json`——PUBLIC_PATHS 白名单无法以精确匹配表达 `:slug` 段，前缀放行会过度放开 `/api/agents/*` 鉴权域；well-known 属 A2A 规范的标准发现面，置于协议保留前缀（不进 /api RBAC 域）既满足规范「匿名可读」又零扩大控制台白名单泄露面。

## 五、语义决议（协商矩阵 × 人类调用方）

A0-A3 协商矩阵（方案 §6.4）的行/列均为**数字员工自治级别**，仅约束「员工互调」。人类/外部服务调用方不进矩阵：

- 目标 A0 → `single_turn`（平台代答问答，v1 语义）；
- 目标 A1+ → 按 A1 列语义（A1 目标→人在环执行、A2/A3 目标→执行事后报告），执行深度始终受治理检查五项约束。

机器凭证绑定 Agent 的调用方取该 Agent 的 `attrs.autonomy` 进矩阵（A3 调用方 × A0 目标 → 拒绝等）。

## 六、治理与验收口径（与方案 §6.2/§6.3 对齐的差异声明）

1. **治理检查五项**：① 权限点（HTTP 边界 guarded 强制）；② 在线 + 非冻结 + workforce permit 覆盖（受管员工探测，探针异常按 legacy 放行）；③ 密级天花板（越级拒绝）；④ 预算配额（modelgw `budgetStatusForSubject` 预检，熔断 block 拒绝）；⑤ 敏感审批规则（命中 → `auth_required` 挂审批中心工单，审批通过幂等恢复、驳回 → rejected）。
2. **中断态**：`input_required` 由调用方携 taskId 续答（协商续轮或补输入）；`auth_required` 必经审批中心人工闭环；恢复派发幂等键含尝试序号，重试不重复执行。
3. **验收**：v1 的「workforce 交付验收单」是 permit 绑定的受控执行路径专用；A2A 任务（平台 harness 执行）的验收落在任务本体 `acceptance` 字段（人工、仅 completed 可验收、必须填理由），履约视图按任务聚合完成率/中断率/验收通过率/P95 耗时。两套验收共用「验收不轻信自报」原则。
4. **执行层诚实边界**：内置 dsh harness v1 = 单步真实模型执行（modelgw 分级路由 + 预算熔断 + 会话续接），不做虚构工具执行循环；请求级 `tools` 注入一律接受不生效并记 `metadata.ignored_fields`；MCP 工具面继续走 MCP 网关（受管员工经 workforce 受控调用）。

## 七、未尽事项（升版路线，如实声明）

1. **A3 多方仲裁**：待 flow-core 编排绑定（编排层只调 A2A 面纪律落地时一并施工）。
2. **Artifact NAS 落地**：文件型交付物经 NAS 网关受控写入与签名下载链接（UHP Extended 级 conformance）本版未开——卡片诚实声明 `files_input/files_output=false`。
3. **模型 token 的协作链归集**：协作链事件（`a2a:<agentId>:<principal>:<taskId>`）携带 calls+tokens 快照；模型网关原始 token 事件仍以 modelgw 计量为权威（预算熔断口径），两账并行使者，不做双写合并。
4. **Gateway 边缘化**（方案 §10.2）：待 ADR-0001 Postgres 迁移完成后评估；当前单进程形态下 SSE 长连接压力已由同步等待窗（默认 12s）+ 心跳挂起兜底。
