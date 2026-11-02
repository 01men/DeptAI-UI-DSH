# 组D 后端完整性报告 —— A2A 协作平面 / UHP 执行驱动层

- 被测变更：`packages/plugin-a2a/src/index.ts`(1345 行) + `packages/plugin-uhp/src/index.ts`(787 行) + `packages/plugin-usage`(contextId 计量维度) + `packages/plugin-agent`(attrs 扩字段) + `packages/plugin-console/src/routes/usage.ts`
- 测试实例：`http://127.0.0.1:7311`（QA 隔离实例，全程只读/写测试数据，未重启服务、未 kill 任何进程）
- 模型 stub：共享 `http://127.0.0.1:7399/v1`（slug `deepseek-chat`）；组D 自建反价 stub `http://127.0.0.1:7400/v1`（slug `deepseek-coder`，本组自建进程）
- 报告日期：2026-10-20
- 证据落盘：`/tmp/qa/d-01-lifecycle.json` … `/tmp/qa/d-11-extra.json`（11 个结果文件）
- **本组为黑盒测试，未修改任何源码**；所有 fixture 变更均经公开 REST 接口造数。

---

## 一、概述

组D 覆盖 A2A 八态生命周期、治理检查五项、A0-A3 协商矩阵、计量闭环、审计闭环、UHP 执行面、事件总线纪律、声明-授权一致性巡检、交付验收闭环、任务事件 SSE 共 10 个受测面。

**结论：主体协议行为成立，八态全部可达、治理五项逐项拦得住、协商矩阵判定与期望逐格一致、审计闭环完整；发现 0 项 P0、2 项 P1、6 项 P2（另有 3 项观察项）。**

- 唯一系统性偏差：协商矩阵「拒绝」判定正确，但被拒任务的 `mode` 字段在任务台账里被记成 `single_turn`（协议数据失真，D-1）。
- 唯一越权类问题：协作任务可被**非发起方**取消（D-2），与同文件「仅任务发起方可续答」的口径自相矛盾。
- 核心关切「幂等键两层语义」实测结论：**两层键确实不同，但当前可达路径上 `attempt` 恒为 `a1`，因此不产生在线漏计**；真正的风险是"未来一旦重派发即漏计 + 静默吞冲突"（D-3，属潜在缺陷）。

---

## 二、实测规模

| 维度 | 数量 | 说明 |
|---|---|---|
| 断言总数 | **105** | 通过 100 / 失败 5（4 条同根因见 D-1，1 条见 D-8） |
| A2A 协作任务 | **120 条** | 组D 新建（completed 61 / rejected 29 / auth_required 12 / input_required 8 / failed 6 / canceled 4） |
| 新建数字员工 | 9 名 | `d-a0-caller` `d-a1-caller` `d-a2-caller` `d-a3-counter` `d-offline` `d-budget` `d-skilldrift` `d-harnessdrift` `d-frozen` |
| 新建机器凭证 | 5 个 | `d-a0cc` `d-a1cc` `d-a2cc` `d-usagecc` `d-invokeonly-cc`（均含 `agent.a2a.invoke`） |
| 新注册模型 / stub | 1 / 1 | `deepseek-coder` → 自建 7400 反价 stub（MARK-ACCEPT / ZZSLOW / ZZECHO 三种可控行为） |
| 新建治理规则 / 预算 | 2 / 2 | 关键词规则、密级规则；主体预算（limit 0 / action=block） |
| 计量事件核查 | 67 条 a2a 事件 | 其中 64 条带 `contextId` |
| 审计核查 | 8 类 action × 7 场景 | 近 200 条审计中 a2a/uhp 相关 180 条 |

**环境注记**：共享 fixture 的 `qa-caller-cc` 在测试期间被平台侧「凭证轮换联动」吊销（`TOKEN_INVALID: 令牌已被吊销`），组D 随即自建 `d-a2-caller/d-a2cc` 隔离自测；受影响的 D1/D2/D3 全部改用自持凭证重跑，结论可复现。

---

## 三、A2A 八态生命周期实测表

| 态 | 触发手段 | 实测证据（task.state / stateReason / history） | 判定 |
|---|---|---|---|
| `submitted` | `createTaskRecord` 唯一赋值点（`plugin-a2a/src/index.ts:547`） | **瞬态**：赋值后同一同步块内即被 transition 推进（runSingleTurn/dispatchTask 的 `transition('working')` 早于首个 await），REST 面不可稳定观测。全量扫描 167+ 条任务，**submitted 残留 = 0**；状态分布 {completed,rejected,auth_required,input_required,failed,canceled} | 设计如此（见 O-1 观察） |
| `working` | A2 目标 `execute_report` 派发 | `stateReason="UHP 执行中（第 1 次派发）"`；history 含 `{from:system,type:status,state:working}` | PASS |
| `input_required` | A3×A3 协商 + 自建反价 stub（模型回 `{"decision":"counter"}`） | `stateReason="被调方还价（第 1 轮），等待调用方回应"`；`negotiation.status=open`，offers=[caller:r1, target:r1]；history 含 `target:offer` | PASS |
| `auth_required` | ①命中关键词审批规则；②协商矩阵 `execute_confirm`（A1/A2×A1） | ①`stateReason="命中敏感操作审批规则，人在环确认后恢复执行"`+`approvalId`；②`stateReason="协商矩阵要求人在环确认（A2 × A1）"` | PASS（两条路径） |
| `completed` | 正常执行 | `stateReason="任务完成（含交付物 1 项）"`；history=[caller:message, system:working, system:completed]；artifacts 1 项 | PASS |
| `failed` | 目标 `uhpHarnessRef` 指向不存在的 harness | `stateReason="uhpHarnessRef 指向的 harness 不存在：h-nonexistent-xyz（请先在 UHP 注册或清空该引用）"`；history=[message, working, failed] | PASS（诚实失败） |
| `canceled` | ①`tasks/cancel` 取消 `input_required` 任务；②执行中经总线取消 UHP | ①`input_required → canceled`；②任务 `canceled`、**artifacts=0**、UHP response `status=canceled`/`output_text=""`（模型已返回的结果未交付） | PASS（两条路径） |
| `rejected` | 治理五项任一命中 / 协商矩阵拒绝 / 协商轮次超限 | 密级越级 `stateReason="数据密级越级：任务密级 internal 高于该员工天花板 public"`；矩阵拒绝 `"协商矩阵拒绝：调用方 A2 × 被调方 A0 不允许执行类交互"`；协商超限 `"协商轮次超限（3 轮），任务拒绝"` | PASS（3 类触发） |

**补充闭环实测（D11）**
- `input_required` 续答 → 被调方接受 → 派发 → `completed`（`negotiation.status=accepted`，offers=3，attempts=1，artifacts=1）✅
- 协商轮次逐轮推进：r2 input_required → r3 input_required → r4 `rejected`（expired）并留痕 `a2a.task.rejected(denied)` ✅
- 非任务发起方续答被拒：`"仅任务发起方可续答该任务"` ✅

---

## 四、治理检查五项实测表

| # | 检查项 | 命中输入 | 命中实测 | 不命中输入 | 不命中实测 | 判定 |
|---|---|---|---|---|---|---|
| ① | 权限点（`agent.a2a.invoke`，HTTP 边界 fail-closed，`index.ts:355` 登记语义位） | 弱凭证 `qa-weak-cc`（仅 `agent.read`） | **403** `缺少权限点 agent.a2a.invoke` | `d-a2cc` 持 `agent.a2a.invoke` | 受理并 `completed` | PASS |
| ②a | 目标在线 | `d-offline`（status=draft） | **rejected** `TARGET_NOT_ONLINE` | `qa-a2-auto`（online） | `completed` | PASS |
| ②b | 目标冻结 | `d-frozen`（预算联动冻结，`attrs.frozenAt` 已写） | **rejected** `TARGET_FROZEN` | 未冻结目标 | 正常受理 | PASS |
| ②c | workforce permit 覆盖 | — | **实现为空操作**：`describeAgent()` 返回值被 `void` 丢弃（`index.ts:360-366`），不参与判定 | 同左 | 同左 | **D-4（P2）** |
| ③ | 密级天花板 | `qa-a0-tip`（ceiling=public）+ `dataClass=internal` | **rejected** `DATA_CLASS_EXCEEDED` | `qa-a0-tip` + `dataClass=public` | `completed` | PASS |
| ④ | 预算配额 | `d-budget`（主体预算 dailyLimit=0 / action=block） | **rejected** `BUDGET_EXCEEDED`（`预算 mbgt_… 已超限`） | `qa-a2-auto`（无预算） | `completed` | PASS |
| ⑤ | 敏感操作审批规则 | 规则 `matchDataClassAtLeast=secret` + `dataClass=secret` | **auth_required** + 生成审批工单 `apr_…` | 同规则 + `dataClass=internal` | 正常受理 | PASS |

> ②b 冻结的可达性说明：本环境无「直接冻结」REST 面，冻结由 `exec-hub` 预算前置熔断联动（`POST /api/exec/tick` → `agentRegistry.freezeAgent`）产生，已实测生效（`frozenAt=2026-10-20T10:06:13.923Z`）。
> ③ 附带观察：协作面放行 secret 后，仍被 modelgw 渠道分级二次锁死（deepseek-coder 渠道上限 internal）→ 任务落 `failed` 而非治理层 `rejected`（见 D-10 观察项）。

---

## 五、协商引擎矩阵（9 组合 + 人类分支）

期望值对齐 `packages/plugin-a2a/src/negotiate.ts:31-46` `negotiateMode()`；实测 `task.mode` 取自任务台账。

| 调用方＼被调方 | A0 提示 | A1 执行 | A2 自主 | A3 协商 |
|---|---|---|---|---|
| **A0 提示** | single_turn ✅ | single_turn ✅ | single_turn ✅ | single_turn ✅ |
| **A1 执行** | **mode 记为 single_turn ❌**（判定=rejected，state=rejected） | execute_confirm ✅ | execute_report ✅ | execute_report ✅ |
| **A2 自主** | **mode 记为 single_turn ❌**（判定=rejected） | execute_confirm ✅ | execute_report ✅ | execute_report ✅ |
| **A3 协商** | **mode 记为 single_turn ❌**（判定=rejected） | **mode 记为 single_turn ❌**（判定=rejected） | execute_report ✅ | negotiate ✅（A3×A3 要约→接受→派发→completed） |

- **判定行为**：16 格全部与 `negotiateMode()` 期望一致（4 个 rejected 格均落 `state=rejected`，`stateReason="协商矩阵拒绝：调用方 A× 被调方 A0/A1 不允许执行类交互"`）。
- **数据保真**：4 个 rejected 格的 `task.mode` 均为 `single_turn` —— 与真实判定 `rejected` 不符（**D-1 / P1**）。
- **人类调用方特殊分支**（不进矩阵，按目标级别直判，`index.ts:496-499`）：A0→single_turn ✅ / A1→execute_confirm ✅ / A2→execute_report ✅ / **A3→execute_report ✅（人类调 A3 不进协商，直接执行事后报告）** —— 4/4 与设计一致。

---

## 六、计量闭环核对

| 核对项 | 实测 |
|---|---|
| 任务完成是否落账 | ✅ 1 条事件，`idempotency_key = a2a:agt_…:pri_…:task_…`（= `a2a:<agentId>:<principal>:<taskId>`，无 attempt 后缀） |
| calls / tokens | ✅ `calls=1, input_tokens=120, output_tokens=30` |
| 定价非计费 | ✅ `charge_cents=0, cost_cents=0, rate.nonbillable=true`（价格簿 `agent:*` 零费率快照） |
| contextId 归集 | ✅ 事件 `contextId == task.contextId`（`a2actx_…`），可由 `GET /api/usage/collaborations?context=<id>` 精确取回 |
| 调用方显式 contextId 透传 | ❌ 请求 `metadata.contextId=D-CHAIN-…` → 任务 contextId 仍为随机 `a2actx_…`（**D-8 / P2**） |
| 协作链汇总 | ⚠️ `GET /api/usage/collaborations?days=30` 可用，但 Top N 排序键退化（**D-6 / P2**） |
| UHP 幂等重放 | ✅ 同 `Idempotency-Key` 二次调用返回**原 record id**，UHP 记录数不增、不重复执行、不重复计量 |
| 幂等键两层语义 | ❌ **两层键确实不同**，详见下表（**D-3 / P2**） |

### 幂等键两层语义核对（核心关切）

| 层 | 键形态 | 源码 | 实测 |
|---|---|---|---|
| UHP 派发层 | `a2a:<agentId>:<principal>:<taskId>:a<attempt>` | `plugin-a2a/src/index.ts:614` | 同任务用 `:a2` 键调用 → **新增** UHP response 记录（同一 taskId 下 1→2 条），`status=completed` → **重试会被真实再执行** |
| usage 落账层 | `a2a:<agentId>:<principal>:<taskId>`（**无 attempt**） | `plugin-a2a/src/index.ts:772` | 同一 taskId 下 A2A 计量事件**恒为 1 条**，第二次执行的 token **未落账**（漏计） |
| usage 同键不同内容 | — | `plugin-usage/src/index.ts:342-344` | 自推同键不同内容 → **拒绝**：`幂等键冲突：… 已绑定事件 …，同键不同内容被拒绝`；而 `completeTask` 的 try/catch（`index.ts:763-782`）会**静默吞掉**该冲突 |

**诚实结论（区分"真缺陷"与"设计如此"）**
1. 两层键**语义确实不同**（dispatch 带 attempt、usage 不带），实测可复现。
2. 但在**当前可达路径上 `attempts` 恒为 1**：`input_required` 只能由协商还价产生，且 `negotiation.status` 恒为 `open`（实测 10/10 条 input_required 任务均为 open），因此 `index.ts:477-479` 的「非协商中断续答 → 重新派发」分支**不可达**，重派发路径不存在 → **当前无线上漏计**。
3. 因此定级 **P2（潜在缺陷）**：一旦未来引入重派发（attempts≥2），执行层会重复计费（modelgw 每次 invoke 独立计量键 `modelgw:<random>`），而协作链计量会静默丢一次，**两层口径不一致**。
4. 附：plugin-uhp 文件头（`index.ts:20-22`）声称幂等键模式为 `a2a:<agentId>:<principal>:<taskId>`（无 attempt），与 A2A 实际派发键不一致 —— **文档-实现漂移**。

---

## 七、审计闭环核对

| 场景 | 期望 action / result | 实测 | 判定 |
|---|---|---|---|
| 正常完成 | `a2a.task.accepted:ok` + `agent.a2a.invoke:ok` + `uhp.invoke:ok` | 三条齐全 | ✅ |
| 治理拒绝 | `a2a.task.rejected:denied` | 命中 | ✅ |
| 执行失败 | `agent.a2a.invoke:error` | 命中 | ✅ |
| 人在环 | `a2a.task.auth_required:ok`（+ `approval.create:ok`） | 命中 | ✅ |
| 取消 | `a2a.task.canceled:ok` | 命中 | ✅ |
| 交付验收 | `a2a.task.acceptance:ok`（type=change，含 decision/reason） | 命中 | ✅ |
| 一致性巡检 | `a2a.patrol.run:ok`（detail=「巡检 15 名在线员工，3 名存在漂移」） | 命中 | ✅ |
| UHP 取消留痕 | `uhp.invoke.canceled_after_completion:ok` | 命中，但 **detail 不含 responseId**（按 responseId 反查审计返回 0 条）→ **D-7 / P2** | ⚠️ |

**action 齐备性统计（近 200 条审计）**：`a2a.task.accepted` 40 / `a2a.task.rejected` 15 / `a2a.task.auth_required` 9 / `agent.a2a.invoke` 52 / `a2a.task.acceptance` 2 / `a2a.patrol.run` 1 / `uhp.invoke` 29 / `a2a.task.canceled` 4 —— **8 个关键 action 名全部存在且 result 分支正确**。

**治理决策 + invoke 双分支 + UHP 执行结果可在审计面完整还原**（按 `?q=<taskId>` 一次性取回该任务的全部审计条目）。

---

## 八、UHP 执行面

| 能力 | 实测 | 判定 |
|---|---|---|
| `GET /v1/uhp` 发现 | `uhp_version=2026-08-11`、`conformance_class=core`、能力位 5 项、14 个 harness，`harnesses[].configured` 均非空且指向在线员工 slug | ✅ |
| 鉴权 fail-closed | 无 token → **401**；持 `agent.read` 的弱凭证 → **403** `缺少权限点 uhp.invoke` | ✅ |
| 同步模式 | `status=completed` + `output_text` + `usage{input_tokens:120,output_tokens:30}` + `session_id` + `harness_id` | ✅ |
| SSE 模式 | 事件序列 `response.created → output_text.delta → response.completed` | ✅ |
| 幂等重放 | 同 `Idempotency-Key` 二次调用 → 同一 `id`，UHP 记录数 1，不重复执行/计量 | ✅ |
| `previous_response_id` 续接 | 上一轮 **user** 轮被带入下一轮（`roles=system,user,user`）；跨执行体续接被拒 `previous_response_id 属于其他执行体，拒绝跨 harness 会话续接` | ⚠️ 上一轮 **assistant 回答未进入续接上下文** → **D-5 / P2** |
| 取消语义 | 取消后 `status=canceled`、`output_text=""`、SSE 发 `response.canceled`、留痕 `uhp.invoke.canceled_after_completion`；终态再取消 → 诚实拒绝 | ✅ |
| A2A 取消 → UHP 联动 | 任务 `canceled` + artifacts=0 + UHP `output_text=""`（模型已返回的结果**未交付**） | ✅ |
| `metadata.ignored_fields` 越权原语封堵 | 顶层 `tools` 与 `metadata.tools` 均被接受但不生效，`metadata.ignored_fields=["tools"]` | ✅ |

---

## 九、巡检与验收闭环

### 声明-授权一致性巡检（`POST /api/a2a/patrol/run`）

| 核对项 | 实测 |
|---|---|
| RBAC | 无 `a2a.admin`（qa-member）→ **403** ✅ |
| 技能声明漂移 | `D-技能漂移员工`：`声明漂移：引用的 Skill「qa-removed-skill-xyz」已不在架（发布状态 不存在）…` ✅ |
| harness 授权漂移 | `D-harness漂移员工`：`harness 漂移：uhpHarnessRef 指向的 h-nonexistent-xyz 不存在，执行将诚实失败` ✅ |
| 误报 | 无漂移员工（qa-a2-auto）无 findings ✅（checkedAgents=15 / driftAgents=3） |
| 告警 | `audit.fire` warning 告警生成（6 条，标题含「声明-授权一致性巡检发现 N 项漂移」）✅ |
| 留痕 / 落库 | `a2a.patrol.run:ok` + `GET /api/a2a/patrols` 可查 ✅ |

### 交付验收闭环（`POST /api/a2a/tasks/:taskId/acceptance`）

| 核对项 | 实测 | 判定 |
|---|---|---|
| 非 completed 不可验收 | `仅 completed 任务可验收（当前 input_required）——不轻信自报，未完成不进验收` | ✅ |
| 理由必填 | 空白理由 → `验收必须填写理由（护栏要求）` | ✅ |
| 仅限人类 | 机器凭证（无 `a2a.task.accept`）→ 403；观察员角色 → 403 | ✅ |
| 结果回写 | `acceptance={status,by,at,reason}` 落任务记录；驳回分支 `status=rejected` | ✅ |
| 履约视图 | `received=95 / completed=82 / completionRate=0.863` 与任务台账实算**逐项吻合**；`acceptanceAccepted=11 / acceptancePassRate=0.134` 吻合；`avgDurationMs=22 / p95DurationMs=14` 有值 | ✅ |
| 履约视图 RBAC | 协作管理员角色无 `usage.read` → `/api/usage/collaborations` 403（D-9 观察） | ⚠️ |

### 任务事件 SSE（`GET /v1/a2a/tasks/:taskId/events?token=`）

| 核对项 | 实测 | 判定 |
|---|---|---|
| 已完成任务 | `task.snapshot`（state=completed）→ `task.terminal`（state=completed），流结束 | ✅ |
| 执行中任务 | `task.snapshot → task.progress(phase=completed) → task.snapshot → task.terminal` | ✅ |
| fail-closed | 无 token → 401 `缺少 token 参数（SSE 端点自校验，fail-closed）`；缺权限点 → 403 | ✅ |
| 心跳 | 订阅 input_required 任务 17s，收到 2 帧 `: ping`（15s 周期） | ✅ |
| 越权订阅 | 持 `a2a.directory.read` 的协作观察员可订阅他人任务事件（与 `getTask` 口径一致） | ✅（设计如此） |

### 事件总线纪律（A2A ↔ UHP）

静态核（`packages/plugin-a2a/src/index.ts` vs `packages/plugin-uhp/src/index.ts`）：

- A2A emit = `{a2a.task.changed, a2a.task.dispatch, a2a.task.cancel}`；A2A on ⊇ `{a2a.task.progress, a2a.task.changed}`
- UHP emit = `{a2a.task.progress}`；UHP on ⊆ `{a2a.task.dispatch, a2a.task.cancel, a2a.task.progress}`（第三项位于 `/v1/uhp/responses` 的 SSE 转发分支，属自身进度流）
- 双向配对齐备：dispatch(A2A→UHP) / progress(UHP→A2A) / cancel(A2A→UHP) ✅
- **无跨插件直连**：两插件互不 import；UHP 侧不读 `ctx.a2aCollab`；A2A 侧仅在巡检中只读 `ctx.uhpGateway.harnesses()`（纪律例外已在 contract-c3 v2 登记）✅
- 动态闭环：派发 → history 出现 `working` → `completed`（经总线回传推进）✅

---

## 十、断言结果一览

| 用例集 | 文件 | 断言 | 通过 | 失败 |
|---|---|---|---|---|
| D1 八态生命周期 | `d-01-lifecycle.json` | 8 | 8 | 0 |
| D2 治理五项 | `d-02-governance.json` | 6 | 6 | 0 |
| D3 协商矩阵（16 格 + 4 人类格） | `d-03-matrix.json` | 20 | 16 | 4（D-1 同根因） |
| D4 计量闭环 + 幂等键 | `d-04-usage.json` | 13 | 13 | 0 |
| D5 审计闭环 | `d-05-audit.json` | 8 | 8 | 0 |
| D6 UHP 执行面 | `d-06-uhp.json` | 13 | 13 | 0 |
| D7 事件总线纪律 | `d-07-bus.json` | 8 | 8 | 0 |
| D8 一致性巡检 | `d-08-patrol.json` | 8 | 8 | 0 |
| D9 验收与履约 | `d-09-acceptance.json` | 9 | 9 | 0 |
| D10 任务 SSE | `d-10-sse.json` | 5 | 5 | 0 |
| D11 补充（续答/超限/越权） | `d-11-extra.json` | 6 | 6 | 0 |
| **合计** | | **105** | **100** | **5** |

---

## 十一、缺陷清单

### P0（0 项）
无。

### P1（2 项）

**D-1｜协商矩阵拒绝的任务记录 `mode` 字段失真（P1）**
- 位置：`packages/plugin-a2a/src/index.ts:501`（`createTaskRecord({ caller, agent, message, dataClass, callerAutonomy, targetAutonomy })` 未透传 `mode`），兜底值见 `index.ts:546`（`mode: input.mode ?? 'single_turn'`）
- 实测证据：矩阵 16 格实测中，4 个 rejected 格（A1>A0、A2>A0、A3>A0、A3>A1）判定正确（`state=rejected`，`stateReason="协商矩阵拒绝：调用方 A2 × 被调方 A0 不允许执行类交互（A0 提示型员工不可被驱动执行）"`），但 `task.mode` 全部为 `single_turn`；`taskView()` 对外暴露的 `mode` 与 `stateReason` 语义冲突
- 影响：按 `mode` 统计的协议消费方（履约视图扩展、审计归类、控制台筛选）会把「被矩阵拒绝」误计为「单轮问答」
- 复现：`POST /api/agents/qa-a0-tip/a2a`（method=message/send, metadata.dataClass=public）由 A2 调用方发起 → `GET /api/a2a/tasks/<id>` 观察 `mode`

**D-2｜协作任务可被非发起方取消（跨主体越权取消，P1）**
- 位置：`packages/plugin-a2a/src/index.ts:859-866`（`cancelTask` 直接复用 `getTask` 的**可读性**判定：`发起方 || '*' || a2a.directory.read`），与同文件 `index.ts:470-472`（续答路径显式校验「仅任务发起方可续答该任务」）口径矛盾
- 实测证据：任务由 `qa-a3-cc` 创建（`input_required`），`d-a0cc`（**非发起方**，持 `agent.a2a.invoke` + `a2a.directory.read`）调用 `tasks/cancel` → 成功，`state: input_required → canceled`，`rpcError=null`；审计 `a2a.task.canceled:ok`
- 影响：任意具备 A2A 调用权且持有治理视图读权的凭证可取消他方在途协作任务，破坏任务归属与履约完整性（`canceled` 为终态，不可恢复）
- 复现：`POST /api/agents/d-a3-counter/a2a` method=tasks/cancel，令 taskId 属另一 principal

### P2（6 项）

**D-3｜幂等键两层语义不一致 + 重试漏计（潜在，P2）**
- 位置：`packages/plugin-a2a/src/index.ts:614`（派发键含 `:a<attempt>`）vs `packages/plugin-a2a/src/index.ts:772`（usage 落账键无 attempt）；`packages/plugin-uhp/src/index.ts:20-22`（文件头声称无 attempt，与实现不符）
- 实测证据：同 taskId 用 `:a2` 键重放 → UHP 新增 1 条 response 记录（1→2）且 `status=completed`（再执行一次）；usage 侧该 task 的 A2A 事件仍为 1 条（第二次执行 token 未落账）；usage 层同键不同内容 → `幂等键冲突：… 已绑定事件 …，同键不同内容被拒绝`，而 `completeTask` 的 try/catch（`index.ts:763-782`）会静默吞掉该错误
- 影响：当前可达路径 `attempts` 恒为 1（`input_required` 只能由协商还价产生，`negotiation.status` 实测 10/10 为 `open` → `index.ts:477-479` 分支不可达），**故无线上漏计**；但一旦引入重派发即出现「执行层计 2 次、协作链计量计 1 次」的口径裂口，且冲突被静默吞没

**D-4｜治理检查第 2 项的「workforce permit 覆盖」判定为空操作（P2）**
- 位置：`packages/plugin-a2a/src/index.ts:359-366`（`const managed = await identity.describeAgent(agent.id); void managed` —— 返回值被丢弃，注释称「非空即通过」但未判空）
- 实测证据：在线且未冻结的目标（`qa-a2-auto`）直接受理并 `completed`；受管/非受管员工在该检查上无任何差异；`describeAgent` 抛错时被 `catch` 吞掉并按 legacy 放行
- 影响：五项治理检查的第 2 项实为「在线 + 非冻结」两项，permit 覆盖**无实际拦截力**，与方案描述的治理强度不符

**D-5｜UHP 会话续接丢失被调方上一轮回答（P2）**
- 位置：`packages/plugin-uhp/src/index.ts:319-327`（`messagesJson` 只序列化输入侧消息，未回填 assistant 轮）+ `packages/plugin-uhp/src/index.ts:310-318`（续接时直接复用 `prev.messagesJson`）
- 实测证据：第一轮入参 `roles=system,user`；以 `previous_response_id` 续接后第二轮入参 `roles=system,user,user`（n=3）—— 上一轮 assistant 回答不在续接上下文中
- 影响：多轮会话不成立，被调方「不知道自己上一轮说了什么」，`employee-bound` 长期会话策略的语义受损

**D-6｜协作链 Top 汇总排序键在零价口径下退化（P2）**
- 位置：`packages/plugin-usage/src/index.ts:522-532`（`collaborationSummary` 的 `ORDER BY cost_cents DESC, events DESC`）
- 实测证据：窗口内 73 条协作链、Top 返回 50 条，**全部 `cost_cents=0`**（零价快照口径 `agent:*` 零费率），目标链未进入 Top 50；`?context=<id>` 精确取回正常
- 影响：「最贵协作链」分析不可用，Top N 为任意截断（数据可取回，但排序无意义）

**D-7｜UHP 取消留痕不可按 responseId/taskId 反查（P2）**
- 位置：`packages/plugin-uhp/src/index.ts:497-501`（`uhp.invoke.canceled_after_completion` 的 `detail` 只有中文说明，无 responseId / taskId）
- 实测证据：按 `?q=<responseId>` 查询审计返回 **0 条**；按 action 名查询可命中；`a2a.task.canceled` 的 detail 同样不含 responseId
- 影响：单次协作的「执行结果」与「取消决策」无法在审计面按 id 关联还原（跨源还原链断一环）

**D-8｜调用方指定的协作链 contextId 被丢弃，多 Task 同链归集无法构造（P2）**
- 位置：`packages/plugin-a2a/src/index.ts:454`（`sendMessage` 接收 `contextId?`）→ `packages/plugin-a2a/src/index.ts:537`（`createTaskRecord` 恒用 `contextId: newId('a2actx')`，无入参透传）
- 实测证据：请求 `metadata.contextId="D-CHAIN-1792491547365"` → 任务 `contextId=a2actx_mvgj6prnigx2zrao`（`matched=false`），计量事件随之取任务 contextId
- 影响：C4「同 contextId 多 Task 计量按链聚合」当前**无法由调用方构造**（每任务恒一链）；`GET /api/usage/collaborations` 的链聚合在真实协作场景下不可用
- 复现：`POST /api/agents/qa-a2-auto/a2a`（method=message/send, metadata.contextId=<自定义>）→ `GET /api/a2a/tasks/<id>` 观察 contextId

### 观察项（3 项，不计缺陷）

- **O-1 `submitted` 态 REST 面不可观测**：`packages/plugin-a2a/src/index.ts:547` 赋值后同一同步块内即被推进（`transition('working')` 早于首个 await），全量任务扫描 submitted 残留 = 0。协议语义无碍，但排障时看不到「已受理未派发」的中间态。
- **O-2 协作管理员角色缺 `usage.read`**：`qa_admin_a2a` 角色有 `a2a.admin`/`a2a.directory.read` 却无 `usage.read` → `/api/usage/collaborations` 对其 403，协作管理员无法自证协作链计量。
- **O-3 密级天花板通过后仍被渠道分级二次锁死**：`d-a3-counter`（协作天花板=secret）在 `dataClass=secret` 时协作面放行，但 modelgw 渠道 `deepseek-coder` 上限 internal → 任务落 `failed`（`数据分级越界：…已按 PRD §7.2 锁死该路由`）而非治理层 `rejected`。协作面天花板与渠道口径缺少对齐提示。

---

## 十二、未覆盖项与卡点

| 未覆盖项 | 卡点 / 原因 | 影响 |
|---|---|---|
| `submitted` 态的 HTTP 可观测快照 | 代码级瞬态（同一同步块推进），无窗口可捕获 | 八态中仅此态无法给出 REST 证据（已给代码+全量扫描证据） |
| governance ②c「workforce permit 覆盖」的真实命中/不命中 | 实现层空操作（`void managed`），无论受管与否结果一致 | 无法构造「命中 permit 缺失被拒」的用例（已作为 D-4 记录） |
| UHP 层「attempt≥2」的真实 A2A 派发 | `index.ts:477-479` 分支不可达（input_required 恒为协商态）→ A2A 侧 attempts 恒为 1 | 「重试不重复计量」只能从 UHP 侧模拟 `:a2` 键证明两层键不同，无法走完整 A2A 重派发链路（已作为 D-3 记录） |
| 真实模型/真实 harness 执行 | 环境仅提供 stub 模型，无外部 harness 实现体 | 工具面（MCP）执行未覆盖 —— 属 v1 诚实边界声明（`plugin-uhp` 文件头已声明不执行工具） |
| 密级 secret 级完整链路 | modelgw 渠道分级上限 internal，secret 请求被渠道锁死 | secret 密级仅验证到「协作面放行 → 渠道锁死 → failed」 |
| 多节点/跨实例重试 | 单实例环境 | 跨节点重试幂等（`a2a:...` 键共享存储）未验证 |
| 长任务与时间预算 | UHP `timeBudgetMs` 兜底超时（4000×300ms）需 >20min 任务才能触发 | 超时兜底分支未触发 |
| 并发同名调用方多任务链归集 | 单链 contextId 由任务创建时随机生成，同一协作链的多任务需外部显式传 contextId | `metadata.contextId` 入参在 `sendMessage` 中被接收但**未透传进 createTaskRecord**（`index.ts:524-555` 无 contextId 参数），故「同链多 Task 归集」当前无法由调用方构造 —— 建议下一轮专项 |

---

## 十三、风险与遗留

1. **协作链归集（contextId）维度尚未真正可用**：`sendMessage` 接收 `metadata.contextId`（`index.ts:1123`）但未写入任务记录（`createTaskRecord` 恒 `newId('a2actx')`，`index.ts:537`），任务 contextId 恒为随机值 → 「一次跨员工协作的总成本」在数据层不可成立（每任务一链，D-8）。本轮已实测：事件 `contextId` 与任务 `contextId` 一致、链路自洽，但**多任务归集能力未打通**。
2. **「attempt」维度形同虚设**：派发键带 attempt 而落账键不带，且 attempts 恒为 1 → 幂等防重与重试计量两条设计意图都处于「未启用」状态（见 D-3）。
3. **协议数据保真弱于判定正确性**：D-1 表明「判定层」严谨但「台账层」会失真，后续统计型需求（按 mode/自治级别出报表）会直接被污染。
4. **越权面在读侧与写侧口径不一**：读（tasks/get）与写（tasks/cancel）共用可读性判定，写侧缺归属校验（D-2）；而续答路径做了归属校验 → 同一文件内三套归属口径。
5. **取消语义的证据链在审计面断开**：D-7 使得「谁取消了哪次执行」只能靠 action 名聚合推断。
6. **环境侧外部扰动**：共享 fixture 凭证被其他测试组轮换吊销（`qa-caller-cc`），提示本轮多组并行下凭证生命周期管理需收敛。
7. **未覆盖的边界**：真实 harness、工具面执行、跨实例重试、密级 secret 完整链路、时间预算兜底。

---

## 附：复现材料

- 结果文件：`/tmp/qa/d-01-lifecycle.json`、`d-02-governance.json`、`d-03-matrix.json`、`d-04-usage.json`、`d-05-audit.json`、`d-06-uhp.json`、`d-07-bus.json`、`d-08-patrol.json`、`d-09-acceptance.json`、`d-10-sse.json`、`d-11-extra.json`
- 执行脚本：`/tmp/qa/d-01-lifecycle.mjs` … `/tmp/qa/d-11-extra.mjs`（共用 `d-lib.mjs`）
- 组D 扩展 fixture：`/tmp/qa/d-fixture.json`（员工/凭证/模型）；反价 stub：`/tmp/qa/d-counter-stub.mjs`（7400 端口，MARK-ACCEPT / ZZSLOW / ZZECHO）
- 共享 fixture：`/tmp/qa/fixture.json`（账号与基线凭证）
