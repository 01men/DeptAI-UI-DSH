---
name: dsh-ops-app
description: 管理 AI 应用的登记、拓扑和用量成本。
---

# Skill: dsh-ops-app

## 何时使用
AI 应用注册、编排拓扑查看、应用层指标（DAU/会话/留存）、成本穿透、发布/下架生命周期。


## 调用方式（工具优先）
平台已把运维能力注册为 dsh 工具，**回答现状问题（查询/盘点/排障）必须直接调用工具获取真实数据，禁止凭记忆回答**：
- app_list / app_topology / app_metrics / app_cost_breakdown
（工具参数见各工具 schema；下文手册中的 `dshctl ...` 为「平台独立部署 + HTTP API 运维」场景的 CLI 备选，需 DSHCTL_TOKEN/DSHCTL_USER，在 dsh 会话内一般用不到。）

## 操作手册

### 场景 1：排查应用故障（拓扑定位）
1. `dshctl app topology <id>` → 应用 → Agent → Skill 依赖树，异常节点标红
2. 对异常 Agent：`dshctl agent metrics <agentId>` 下钻
3. 底层 MCP：`dshctl mcp health <mcpId>` 探活

### 场景 2：成本归因
`dshctl app cost <id>` → 按 Agent 穿透 Token/调用/成本
全平台视角：`dshctl cost report --groupBy=app|org|date`

### 场景 3：发布/下架（L4）
POST /api/apps/<id>/transition {action:"online"|"offline"} → 审批单 → 单人审批通过自动执行。
下架联动吊销应用机器凭证。

## 护栏
- 应用只能编排「已上线」的 Agent（注册时校验）
- 上线前必须登记访问地址（url）与数据密级
