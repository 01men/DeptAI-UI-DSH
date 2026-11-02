---
name: dsh-ops-audit
description: 查询审计日志、告警、审批与用量成本。
---

# Skill: dsh-ops-audit

## 何时使用
安全审计回溯（认证/授权/调用/变更四类日志）、告警处理、审批中心流转、成本分析报表。


## 调用方式（工具优先）
平台已把运维能力注册为 dsh 工具，**回答现状问题（查询/盘点/排障）必须直接调用工具获取真实数据，禁止凭记忆回答**：
- audit_logs / audit_alerts_list / audit_alerts_read_all / approval_decide / audit_cost_report
（工具参数见各工具 schema；下文手册中的 `dshctl ...` 为「平台独立部署 + HTTP API 运维」场景的 CLI 备选，需 DSHCTL_TOKEN/DSHCTL_USER，在 dsh 会话内一般用不到。）

## 操作手册

### 场景 1：越权事件调查
1. `dshctl audit logs --type=authz` → 过滤 denied 记录
2. 按 actorId 聚合频次；同一主体 10 分钟 >5 次会触发告警规则
3. 处置：冻结账号（dsh-ops-iam 场景1）+ 吊销令牌（dsh-ops-authn）

### 场景 2：变更回溯
`dshctl audit logs --resourceId=<资源id>` → 完整变更时间线（含 on-behalf-of 令牌链）

### 场景 3：审批中心
1. `dshctl approval list --pending`
2. `dshctl approval decide <id> --decision=approve|reject --opinion=<意见>`
3. L4 审批通过后自动执行（执行结果回写审批单）

### 场景 4：成本报表
`dshctl cost report --groupBy=app` / `--groupBy=org` / `--groupBy=date`

## 护栏
- 审计日志只追加不删除（WORM 语义）
- 审批单人制：有审批权限即可通过（允许自审）
