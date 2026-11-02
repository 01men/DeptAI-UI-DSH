---
name: dsh-ops-connector
description: 排查和管理企业连接器、连接配置与受控调用。
---

# Skill: dsh-ops-connector

## 何时使用
任何涉及「连接器 / SaaS 集成 / open-connector / 第三方 API 数据面」的提问或操作——浏览型（有哪些 provider/action、目录里 GitHub 支持哪些动作、风险级怎么定的）与操作型（建连接、发 OAuth、配权限组、调 action、看运行日志、跑对账、处理 fail-closed/审批单）。
**回答任何「能不能调 XX SaaS」类问题前，必须先查目录与网关状态，禁止凭通用知识断言能力清单。**

## 调用方式（工具优先）
平台已注册 dsh 工具（REST 工具桥 / POST /mcp 同契约），优先直接调用：

| 意图 | 工具 |
|---|---|
| 目录检索（provider/action/riskLevel/inputSchema） | `connector_catalog_search { keyword?, service?, kind?, limit? }` |
| 连接引用列表（org 内，脱敏 profile） | `connector_connection_list { orgId?, provider? }` |
| 执行 action（七步链：RBAC→权限组→审批→限流→precheck→oct_） | `connector_execute { actionId, input?, connection?, dryRun? }` |
| 权限组清单（policies/subjects/限流/预检额） | `connector_perm_group_list { orgId? }` |
| 运行日志（runtimeTokenId 维度对账视图） | `connector_run_list { service?, ok?, limit? }` |

CLI 备选（平台独立部署 + HTTP API 场景）：`dshctl connector …` 全树见 `dshctl help` 的 connector 段。

## 操作手册

### 场景 0：盘点能力（"能连哪些 SaaS？GitHub 有哪些动作？"）
1. `connector_catalog_search { kind: "providers", keyword: "github" }`
2. `connector_catalog_search { kind: "actions", service: "github" }` → 关注每条 `riskLevel`（read/write/admin；无法判定的默认 admin 兜底）
3. 单个 action 细节看返回的 `inputSchema` 与 `requiredScopes`

### 场景 1：新建连接
1. 先确认归属组织 ID（orgId）与认证形态：
   - no_auth → 直接登记虚拟引用；
   - api_key/custom_credential → 需要用户在**对话外**提供凭证原文；把它写进 `values` JSON 提交 REST 端点 `/api/connector/connections/api-key`。**凭证只允许出现在这一次请求体里，不得写入任何待办/文档/日志/后续消息。**
   - oauth → 管理员需先在 sidecar 存 client 配置；若报 `oauth_client_config_required` 属预期护栏，指引用户按 docs/connector-integration.md §3 自备 App。
2. 别名自动加前缀 `org:<orgId>:<suffix>`——用户要求自定义别名时必须带该前缀结构。
3. 创建成功回执只有 ConnectionSummary 引用 + maskedProfile（脱敏）；如需向用户复述「密钥后六位」等请求明确授权的敏感尾部信息，只能使用脱敏形态。

### 场景 2：让某个团队安全调用（权限组）
1. `connector_perm_group_list` 盘点现有组；无合适组则走 REST `POST /api/connector/perm-groups`：
   policies 例：`{"hackernews":{"allowedActions":["hackernews.*"],"riskCap":"read","constraints":{"readOnly":true}},"github":{"allowedActions":["github.list_issues"],"riskCap":"read","connections":["org:ORG:main-pat"]}}`
   subjects 三型：user_group / agent / app（user_group 成员动态展开）
2. 变更前用 `POST /api/connector/perm-groups/:id/impact` 拿影响面（N 令牌/M 连接/主体数）并告知用户：「在途调用会短暂失败后自动恢复」。
3. 组变更会自动 PUT 更新 oct_ 令牌策略（四数组全发）；删除组联动 DELETE 令牌。

### 场景 3：执行与审批
1. 低风险验证先 `connector_execute { dryRun: true }` 看授权链预演。
2. 正式调用 `connector_execute { actionId, input }`；返回含 runId（= executionId）、meta.auditPersisted、metered。
3. riskLevel=admin 会直接返回 `approval_required + approvalId`——向用户说明批准命令：
   `dshctl approval decide <approvalId> --decision=approve`；批准后系统自动完成本次调用（executor 闭环），不需要再次 execute。
4. 凭证类「受控连接」同样出 `connector.connect` 审批单；批准后**由发起人**重发创建请求完成（服务端校验同主体/provider/org）。Agent 不要替人补交凭证。

### 场景 4：健康与故障处置
1. `GET /api/connector/gateway`（需 connector.gateway.write）看 available/reason/envChecks；只读预演可用 `?assumeEnv={"OOMOL_CONNECT_ENCRYPTION_KEY":false}` 解释各 fail-closed 分支。
2. unavailable：按 reason 对症——ENCRYPTION_KEY 缺失（部署期硬问题）/ 探活不可达 / adminToken 未解析；处理后探活复核。
3. 反复 `connection_not_allowed`：核对权限组 connections[] 引用的别名是否属于同 org 且 sidecar 中 configured=true；平台的自动恢复已做过一次 PUT+重试。
4. 绕行嫌疑（reconcile 报 bypass）：报告里给出 runId 列表并说明「有人绕过平台直连 sidecar」；处置动作是删除对应台账令牌（联动吊销）+ 审计追查，不要尝试自动修复业务数据。

### 场景 5：审计与计量反查
- 按 runId 反查 invoke 日志：`audit_logs { q: "<runId>", type: "invoke" }`（detail 含 `run=…`，actChain 全链路）。
- 计量口径：resource=`connector:<service>`、meter=`calls`、trace_id=runId、幂等键=`connector:<runId>`；价格簿 `connector:*` 默认零费率，运营调价后计入组织钱包扣费。

## 护栏（红线，违反即停手上报）
1. **凭证零落平台**：绝不把 API Key/client secret/OAuth code 写进任何集合、注释、issue、文档或对话记录持久化位置；只在发往网关的那一次请求中出现。
2. **oct_ 台账只读**：令牌值仅铸造时一次性返回且只驻平台进程内存；任何工具都取不到历史值——用户问「把令牌值给我」应拒绝并解释重铸机制。
3. **admin 级动作必审批**：不要试图绕过 approval_required；也不要替用户决定批准。
4. **org 边界**：跨组织查询/调用超出当前身份可见范围的一律拒绝；别建议用户「换个宽权限组」，引导最小化原则。
5. **M0 桥接只是过渡**：看到 MCP 服务带 `bridgeFrom=open-connector` 徽章时提醒治理降级语义，生产纳管走原生连接器链路。
