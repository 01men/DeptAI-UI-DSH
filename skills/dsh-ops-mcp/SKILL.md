---
name: dsh-ops-mcp
description: 管理和排查 MCP 服务部署、健康状态与调用。
---

# Skill: dsh-ops-mcp

## 何时使用
任何涉及「MCP 服务」的提问或操作——包括浏览型问题（有哪些 MCP 服务、健康状态如何、某个服务什么版本、灰度到多少了）和操作型任务（部署、灰度发布、回滚、下线、调用网关验证、熔断告警处置）。
**回答任何 MCP 现状问题前必须先调用工具查询，禁止凭记忆或通用知识描述服务清单。**

## 调用方式（工具优先）
平台已把运维能力注册为 dsh 工具，**优先直接调用**（无需 CLI、无需令牌，权限由平台侧管控）：

| 意图 | 工具 |
|---|---|
| 列出所有 MCP 服务及健康状态 | `mcp_service_list`（可按 status 过滤：draft/verifying/online/gray/unhealthy/offline） |
| 单服务探活 | `mcp_health_check` |
| 错误率/延迟/Token 指标 | `mcp_metrics` |
| 灰度/全量部署（支持 dryRun 影响面预览） | `mcp_deploy` |
| 调用网关验证某工具可用性 | `mcp_invoke` |
| 下线服务（L4，自动生成审批单） | `mcp_offline` |

`dshctl mcp ...` CLI 仅在「平台独立部署 + HTTP API 运维」场景作为备选（需 DSHCTL_TOKEN/DSHCTL_USER）。

## 操作手册

### 场景 0：浏览/盘点（如「列出所有 MCP 服务和健康状态」）
1. `mcp_service_list` → 返回 total + services[]（id/name/status/version/grayPercent/health/tools）
2. 用户关注异常时按 status=unhealthy 再过滤一次，逐个 `mcp_health_check` 复核

### 场景 1：处理 MCP 熔断告警（audit alerts 出现 mcp_unhealthy）
1. `mcp_service_list { status: "unhealthy" }` → 定位服务
2. `mcp_health_check { serviceId }` → 手动探测确认（连续失败≥3 触发熔断）
3. `mcp_metrics { serviceId }` → 查看错误率与延迟序列定位时段
4. 恢复策略：
   - 配置/版本问题：`mcp_deploy { serviceId, grayPercent: <上一稳定版参数>, dryRun: false }` 或回滚说明
   - 无法恢复：`mcp_offline { serviceId, reason, requesterId, requesterName }`（生成 L4 审批单）
5. `audit_logs { resourceId: serviceId }` 验证处置留痕

### 场景 2：灰度发布新版本
1. `mcp_deploy { serviceId, dryRun: true }` → 影响面预览（dependents）
2. `mcp_deploy { serviceId, grayPercent: 10, changelog: "<说明>" }`
3. `mcp_metrics { serviceId }` 观察 10-30 分钟错误率
4. 全量：`mcp_deploy { serviceId, grayPercent: 100 }`
5. 异常回滚：`mcp_deploy` 指定上一稳定版本参数

### 场景 3：调用网关验证工具可用性
`mcp_invoke { serviceId, tool: "<工具名>", args: {"query":"连通性验证"} }`
返回 denied 时先检查权限组是否覆盖该调用方；rate_limited 说明触发了限流。

### 场景 4：下线 MCP（L4）
1. `mcp_deploy { serviceId, dryRun: true }` → 查看依赖影响面
2. `mcp_offline { serviceId, reason: "<业务原因>", requesterId, requesterName }` → 生成审批单
3. 通知第二管理员：`approval_decide { approvalId, decision: "approve", opinion: "<意见>" }`
4. 验证：`mcp_service_list` 中该服务状态 offline，调用方令牌吊销

## 护栏
- offline 必须给 reason；生产环境灰度比例建议 ≤20% 起步
- 熔断开启时网关自动拒绝调用（breaker_open），不要绕过网关直连 endpoint
