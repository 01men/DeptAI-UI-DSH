# 组B 分报告 · 权限矩阵与安全边界

- **实例**：`http://127.0.0.1:7342`（数据 `data-qa-gB-20261021`，stub `7442`）
- **判定**：**38 / 39 通过**
- **执行脚本**：`qa-runtime-20261021/group-b.mjs` ｜ **结果**：`result-B.json` ｜ **日志**：`run-B.log`

## 一、结论

上一轮 **P0（任务劫持）四层防御已全部实测闭环**；6 项 P1 安全整改（越权取消、UHP 记录属主、组织隔离、正文脱敏、验收职责分离、OBO 身份链）**全部验证通过**。唯一失败是**注入留痕口径不一致**（顶层 `task_id` 变体静默忽略，P2-04），不构成安全后果。

## 二、P0 四层防御逐层验证（核心）

构造：A1 目标 + 人类 admin 发起 → `auth_required`；攻击者为现场新建的 `scopes=['uhp.invoke']` 外部凭证。

| 层 | 断言 | 结果 | 证据 |
|---|---|---|---|
| ① 协议面 | `metadata.ybk_a2a_task_id` → **400 `TASK_BINDING_FORBIDDEN`** | ✅ | `plugin-uhp/src/index.ts:726-740` |
| ② 服务层 | 顶层 `task_id` 变体不建立任务绑定（fail-closed） | ✅ | `UhpBindingError` 只认 `dispatchedByPlatform` |
| ③ 进度面 | 受害任务仍 `auth_required`、零伪造 artifact | ✅ | `onProgress` responseId 配对校验 `plugin-a2a/src/index.ts:833-848` |
| ④ 审计面 | 注入尝试成为可观测审计（`task_binding_denied`） | ✅ | 专项审计 + `denied-ish` 记录 96 条 |
| 注入变体矩阵 | `metadata.task_id` / `body.taskId` / `body.task_id` 均不建立绑定且受害任务状态不变 | ✅ | 三变体全部 `state=auth_required` |
| 主流程未被破坏 | 攻击后经合法审批仍可 `completed`（attempts=1） | ✅ | — |

> **唯一缺口（P2-04）**：上述变体虽然不生效，但既未返回 400、也未写入 `ignored_fields`/审计，与修复批次声明的「拒绝而非忽略，使注入成为可观测审计事件」不一致。安全后果为零（不建立绑定），但**可观测性**不达标。

## 三、P1 整改复验（6 项全通过）

| 上一轮缺陷 | 复验断言 | 结果 | 证据 |
|---|---|---|---|
| Q-2 越权取消 | 非发起方（持 `a2a.directory.read`）取消他人任务 → **-32003**，状态未变；管理员可取消 | ✅ | `assertTaskOwner`（`plugin-a2a/src/index.ts:1026-1030`） |
| Q-3 UHP 记录无归属 | 非属主读 → **404**（不泄露存在性）；非属主取消 → 404/403；属主可读 | ✅ | `plugin-uhp/src/index.ts:859-880` |
| Q-4 组织隔离 | 隔离组织账号对目录/任务/履约/harness/执行记录 **零可见** | ✅ | `visibleOrgScope`（`plugin-uhp/src/index.ts:893`）、`canSeeOrg`（`plugin-a2a/src/index.ts:1005`） |
| Q-5 治理读=明文正文 | 治理观察员看他人任务 → `contentRedacted=true`，正文/artifact/协商原文/历史全脱敏，状态骨架保留 | ✅ | `taskView`（`plugin-a2a/src/index.ts:942-990`） |
| Q-29 REST/RPC 口径不一 | REST 与 `tasks/get` 脱敏口径一致 | ✅ | 两者同走 `getTask`+`taskView` |
| Q-30 验收无职责分离 | 发起人本人验收 → **403**；他人持 `a2a.task.accept` 可验收；非 completed 400；空理由 400 | ✅ | `acceptTask`（`:1053+`） |

## 四、OBO 身份链（Q-6）

| 断言 | 结果 | 说明 |
|---|---|---|
| OBO 令牌 scope 含 `agent.a2a.invoke` | ✅ | 实测 payload：`["mcp.invoke","skill.read","agent.read","agent.write","agent.a2a.invoke","usage.write","connector.invoke","modelgw.invoke","exec.read","exec.write"]` |
| act 链含 human 主体 | ✅ | `act:[{principalId, name:"平台管理员", type:"human"}]` |
| 外部直调伪造 `ybk_on_behalf_user`（不存在用户）不采信 | ✅ | 服务层校验「用户真实存在 + act 链/平台管理员/已绑定」 |

> 首轮脚本报「scope 为空」是测试方解析错误（`scope` 为数组，脚本按空格 split），已修正为数组解析后通过。

## 五、门禁矩阵（10 条路由 × 4 类账号）

| 维度 | 结果 |
|---|---|
| 治理读端点：无令牌 401 | ✅ 8/8 |
| 治理读端点：最小权限成员 403 | ✅ 8/8 |
| 治理读端点：协作观察员 200（`a2a.directory.read` + `uhp.read`） | ✅ 7/7（`/api/usage/collaborations` 需 `usage.read`，观察员未配，属预期） |
| 治理读端点：管理员 200 | ✅ 8/8 |
| 治理写端点：无令牌 401 / 成员 403 / 只读观察员 403 | ✅ 3/3 路由全部 |
| 异常令牌矩阵（无/坏/错作用域） | ✅ 零 5xx、零放行 |

## 六、本组发现的缺陷

| 编号 | 级别 | 缺陷 | 位置 |
|---|---|---|---|
| P2-04 | P2 | UHP 顶层 `task_id`/`taskId` 注入静默忽略，无 400、无 `ignored_fields`、无审计 | `plugin-uhp/src/index.ts:711-740`（仅检查 `metadata.ybk_a2a_task_id`） |

**复现**：`qa-runtime-20261021/repro/top-level-taskid.mjs`

## 七、安全判断

- 上一轮 P0 的**三面（审批绕过 / 交付物伪造 / 审计栽赃）均已不可复现**。
- 权限点声明面干净；归属校验与组织收敛的**顺序**在 `getTask` 中有副作用（见 P1-01，组E 发现）。
- 未发现 5xx、未发现信息泄露（404 隐藏存在性、脱敏保留骨架）。