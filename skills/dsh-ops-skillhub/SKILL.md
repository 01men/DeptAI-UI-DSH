---
name: dsh-ops-skillhub
description: 管理 Skill 的提交、审批、上架与安装。
---

# Skill: dsh-ops-skillhub

## 何时使用
任何涉及「Skill 市场」的提问或操作——包括浏览型问题（市场上有什么 Skill、能装什么、某个分类下有哪些、下载量/评分排名）和流水线任务（提交、审批、上架、安装到 Agent、弃用）。
**回答任何市场现状问题前必须先调用工具查询，禁止凭记忆列举市场内容。**

## 调用方式（工具优先）
平台已把运维能力注册为 dsh 工具，**优先直接调用**（无需 CLI、无需令牌，权限由平台侧管控）：

| 意图 | 工具 |
|---|---|
| 市场里能装什么（浏览/检索） | `skill_search`（q 关键字 / category 分类 / sort: downloads·rating·updated；不带参数=全量） |
| 提交新 Skill（进入扫描→审批流水线） | `skill_submit` |
| 审批（domain 领域 / security 安全加签） | `skill_approve` |
| 上架（版本不可变） | `skill_publish` |
| 安装到 Agent（自动登记依赖） | `skill_install` |
| 弃用（存量引用触发迁移告警） | `skill_deprecate` |

`dshctl skill ...` CLI 仅在「平台独立部署 + HTTP API 运维」场景作为备选（需 DSHCTL_TOKEN/DSHCTL_USER）。

## 操作手册

### 场景 0：浏览市场（如「Skill 市场里能装什么?」）
1. `skill_search {}` → 全量清单（name/category/summary/version/status/author/riskLevel/stats/tags）
2. 用户有偏好时加参数：`skill_search { category: "<分类>" }` 或 `{ sort: "downloads" }`
3. 汇报时按分类归组，标注 riskLevel（高风险 Skill 安装需两级审批）

### 场景 1：提交新 Skill
1. 准备 SKILL.md（何时使用/步骤/输出格式）
2. `skill_submit { name, content: "<SKILL.md 全文>", category, authorId, authorName, orgId, version? }`
3. blocked（恶意代码/密钥泄露）会自动驳回——修复后重新提交
4. 高风险（外联/写文件）需两级：domain 审批 + security 加签

### 场景 2：审批（领域负责人/安全团队）
1. `skill_search { q: "" }` 或控制台「待审批」视图定位待审版本
2. `skill_approve { skillId, level: "domain", decision: "approve", opinion: "<意见>" }`
3. 高风险再执行：`level: "security"`
4. `skill_publish { skillId }` 上架（版本不可变）

### 场景 3：安装到 Agent
`skill_install { skillId, agentId }`（自动登记依赖并回填关联列表）

### 场景 4：弃用与迁移
`skill_deprecate { skillId, reason: "<原因>" }`
存量引用的 Agent 会收到迁移告警——通知负责人更换替代版本。

## 护栏
- 版本不可变：修复必须递增版本号
- 强制下架（force）属 L4 操作，建议走审批
