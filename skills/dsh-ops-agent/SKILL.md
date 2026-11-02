---
name: dsh-ops-agent
description: 管理数字员工的登记、授权、上下线和运行指标。
---

# Skill: dsh-ops-agent

## 何时使用
Agent 注册与属性登记、用户绑定、试运行/上线/下线生命周期（L4 审批）、运行监测与异常排查。


## 调用方式（工具优先）
平台已把运维能力注册为 dsh 工具，**回答现状问题（查询/盘点/排障）必须直接调用工具获取真实数据，禁止凭记忆回答**：
- agent_list / agent_get / agent_metrics / agent_metrics_report / agent_offline / agent_bind_user
（工具参数见各工具 schema；下文手册中的 `dshctl ...` 为「平台独立部署 + HTTP API 运维」场景的 CLI 备选，需 DSHCTL_TOKEN/DSHCTL_USER，在 dsh 会话内一般用不到。）

## 前置条件
agent.write / agent.approve 权限；上线审批需第二管理员配合。

## 操作手册

### 场景 1：下线异常 Agent（标准闭环）
1. `dshctl agent metrics <id>` → 确认异常（成功率骤降/调用突增）
2. `dshctl audit logs --resourceId=<id>` → 回溯最近变更
3. 影响面预览：GET /api/agents/<id> 的 impact 字段
4. `dshctl agent offline <id> --reason="<原因>" --requesterId=<发起人> --requesterName=<姓名>`
   → 生成 L4 审批单
5. 第二管理员：`dshctl approval decide <审批id> --decision=approve --opinion=<意见>`
6. 验证：`dshctl agent get <id>`（状态 offline、机器凭证禁用、绑定用户已通知）

### 场景 2：注册新 Agent
`dshctl agent create --name=<名称> --model=deepseek-chat --riskLevel=low`
→ 返回机器凭证（仅一次；scopes 含 mcp.invoke/skill.read/agent.read/agent.write/usage.write，Agent 可自推直连消耗的计量）。
补全 dataClass 后方可上线。
运营数据提报是接入义务（与 AI 应用同级）：Agent 必须每日 POST /api/agents/<id>/metrics-report
（dau/sessions/uniqueUsers，明细可传 userIds 平台侧哈希脱敏），并 PATCH attrs.entryUrl 提报交互界面地址。
凭证 secret 丢失/泄露：找管理员执行 `dshctl credential rotate <principalId>` 轮换（clientId 不变、旧值立即失效），无需重新注册。

### 场景 3：上线流程
1. 确认治理属性齐备（否则接口会给出具体缺失项）
2. 试运行：`dshctl agent ... transition submit_trial`（限定用户组）
3. 上线：POST /api/agents/<id>/transition {action:"online"} → 审批单 → 单人审批通过

## 护栏
- offline 必须给 reason；上线/下线均为 L4 审批
- 下线联动：吊销机器凭证 + 通知绑定用户 + 保留审计数据
- 调用频次突增（10 分钟 >120 次）会自动触发行为告警
