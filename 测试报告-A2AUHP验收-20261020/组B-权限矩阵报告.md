# 组B · A2A / UHP 权限矩阵测试报告

- **被测变更**：`packages/plugin-a2a`（A2A 协作平面 v1.3.0）+ `packages/plugin-uhp`（UHP 执行驱动层）
- **被测实例**：`http://127.0.0.1:7311`（QA 可写实例；模型 stub `127.0.0.1:7399`）
- **测试日期**：2026-10-20
- **测试角色**：组B 权限矩阵（多角色越权 / 误拒）
- **纪律声明**：全程**只做测试与取证，未修改任何源码**；测试期间对 QA 实例仅做了可回收的夹具造数（临时机器凭证已全部 disable、探针 harness 已删除、探针规则已删除、临时扩权已还原）。

---

## 一、概述

本轮针对 A2A 协作平面与 UHP 执行驱动层的新端点面做了 **545 次权限判定**（门禁矩阵 358 + fail-closed 108 + 过期令牌 31 + 语义深测 48），核心结论：

| 维度 | 结果 |
|------|------|
| **权限点门禁（声明面）** | ✅ 干净。358 次门禁判定（313 主矩阵 + 45 JSON-RPC 方法面），**0 误放行 / 0 误拒** |
| **fail-closed（异常令牌）** | ✅ 干净。108 次异常令牌判定 + 31 次**自然过期令牌**判定，0 个 5xx，0 放行；唯一偏差是 SSE 对坏令牌/过期令牌返回 400 而非 401 |
| **越权原语封堵（`tools`）** | ✅ 通过。4 类注入全部"接受但不生效 + 记入 `metadata.ignored_fields`" |
| **验收接口人类专属门禁** | ✅ 通过。机器凭证即使被授予 `a2a.task.accept` 仍 403 |
| **任务级越权** | ❌ **发现 1 项 P0**：任意 `uhp.invoke` 机器凭证可劫持任意 A2A 任务，**绕过人在环审批门禁** |
| **组织隔离** | ❌ **发现跨组织泄露**：A2A/UHP 治理面完全无组织子树过滤（对照 `/api/agents` 的 R11 口径） |
| **审计留痕** | ⚠️ `/api/*` 拒绝路径留痕完整（`console.authz.denied`）；**`/v1/uhp/*` 与 SSE 拒绝路径零留痕** |

**一句话结论**：**权限点声明本身没有"缺声明就放行"的漏洞（零门禁误放行），真正的越权全部发生在"权限点声明之后"——治理视图（`a2a.directory.read` / `uhp.read`）被实现为"跨组织、跨主体、无归属、无组织"的万能读权限，并且 UHP 任务面把请求体里的 `ybk_a2a_task_id` 直接当成可信的任务归属凭据。**

---

## 二、测试账号矩阵

### 2.1 人类账号（9）

| 账号 | 角色 | 组织 | 权限点集合 |
|------|------|------|-----------|
| `admin` | 平台超级管理员 | 根组织（`org_mvg65e9lidmbgujd`） | `*` |
| `qa-ops` | QA资源管理员 | 根组织 | `agent.read/write/approve/offline`、`iam.org.read/write`、`iam.user.read/write`、`modelgw.read/admin`、`usage.read`、`audit.read`、`approval.read/decide`、**`a2a.directory.read`**、**`uhp.read`**、`mcp.service.read`、`skill.read`、`console.login/read` |
| `qa-approver` | 审批人 | 根组织 | `agent.read`、`approval.read`、`approval.decide`、`audit.read`、`iam.org.read`、`iam.user.read` |
| `qa-collab` | 协作观察员 | **QA技术中心**（`org_mvg65wqiidmm0h3x`） | `agent.read`、**`a2a.directory.read`**、**`uhp.read`**、`usage.read`、`console.login/read` |
| `qa-acceptor` | 验收员 | 根组织 | `agent.read`、**`a2a.directory.read`**、**`a2a.task.accept`** |
| `qa-a2aadmin` | 协作管理员 | 根组织 | `agent.read`、**`a2a.directory.read`**、**`a2a.task.accept`**、**`a2a.admin`**、**`uhp.read`**、**`uhp.admin`** |
| `qa-member` | 最小权限成员 | 根组织 | `agent.read`、`console.login/read` |
| `qa-ro` | 隔离组织只读 | **QA隔离部**（`org_mvg65wqjidmow2ek`） | `agent.read`、**`a2a.directory.read`**、`console.login/read` |
| `qa-outsider` | 跨组织越权探针 | **QA隔离部** | `agent.read`、`console.login/read` |

### 2.2 机器凭证（4 + 3 临时）

| 凭证 | refType / 绑定 | scopes | 用途 |
|------|----------------|--------|------|
| `qa-caller-cc` | agent / `qa-caller-bot`(A2) | `agent.a2a.invoke`、`agent.read`、`a2a.directory.read` | 正常发起方 |
| `qa-a3-cc` | agent / `qa-a3-caller`(A3, hermes) | 同上 | A3 发起方 |
| `qa-uhp-cc` | external | **`uhp.invoke`**、`agent.read` | UHP 任务面 |
| `qa-weak-cc` | external | **仅 `agent.read`** | UHP 任务面 403 探针 / 任务可见性探针 |
| `qa-b-min-uhp`（临时，已 disable） | external | **仅 `uhp.invoke`** | P0 最小权限复现 |
| `qa-b-invoke-only`（临时，已 disable） | external | **仅 `agent.a2a.invoke`** | 任务级可见性/SSE 错误码探针 |
| `qa-b-uhp-owner` / `qa-b-uhp-attacker`（临时，已 disable） | external | `uhp.invoke`、`agent.read` | UHP response 归属探针 |

### 2.3 数字员工

`qa-a0-tip`(A0/public天花板)、`qa-a1-exec`(A1/internal)、`qa-a2-auto`(A2/internal)、`qa-a3-neg`(A3/hermes/secret)、`qa-caller-bot`(A2)、`qa-a3-caller`(A3/hermes)——**全部属根组织**。

---

## 三、端点 × 账号判定矩阵

图例：✅ 应放行且已放行 · ⛔ 应拒绝且已拒绝 · ❌放 误放行 · ❌拒 误拒 · `·` 本轮未覆盖该格

| # | 端点 | 所需权限点 | admin | ops | approver | collab | acceptor | a2aadmin | member | ro | outsider | caller-cc | a3-cc | uhp-cc | weak-cc |
|---|------|---------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 1 | `GET /.well-known/agent-card.json` | （免鉴权） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2 | `GET /.well-known/agents/:slug/agent-card.json` | （免鉴权） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3 | `GET /api/a2a/directory` | `a2a.directory.read` | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 4 | `POST /api/agents/:slug/a2a` · `tasks/list` | `agent.a2a.invoke` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 5 | `POST /api/agents/:slug/a2a` · 未知方法 | `agent.a2a.invoke` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 6 | `GET /api/a2a/tasks` | `a2a.directory.read` | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 7 | `GET /api/a2a/tasks/:taskId`（他人任务） | `a2a.directory.read` | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 8 | `GET /api/a2a/fulfillment` | `a2a.directory.read` | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 9 | `GET /api/a2a/rules` | `a2a.directory.read` | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 10 | `GET /api/a2a/patrols` | `a2a.directory.read` | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 11 | `POST /api/a2a/tasks/:taskId/acceptance` | `a2a.task.accept` + 人类 | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ |
| 12 | `POST /api/a2a/rules` | `a2a.admin` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ |
| 13 | `DELETE /api/a2a/rules/:id` | `a2a.admin` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ |
| 14 | `POST /api/a2a/patrol/run` | `a2a.admin` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ |
| 15 | `GET /v1/uhp`（能力发现） | （免鉴权） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 16 | `POST /v1/uhp/responses` | `uhp.invoke` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ |
| 17 | `GET /v1/uhp/responses/:id` | `uhp.invoke` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ |
| 18 | `POST /v1/uhp/responses/:id/cancel` | `uhp.invoke` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ |
| 19 | `GET /api/uhp/harnesses` | `uhp.read` | ✅ | ✅ | ⛔ | ✅ | ⛔ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ |
| 20 | `GET /api/uhp/responses` | `uhp.read` | ✅ | ✅ | ⛔ | ✅ | ⛔ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ |
| 21 | `POST /api/uhp/harnesses` | `uhp.admin` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ |
| 22 | `PATCH /api/uhp/harnesses/:id` | `uhp.admin` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ |
| 23 | `DELETE /api/uhp/harnesses/:id` | `uhp.admin` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ |
| 24 | `GET /v1/a2a/tasks/:taskId/events`（SSE `?token=`） | `agent.a2a.invoke` \| `a2a.directory.read` \| `*` | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 25 | `POST /api/agents/:slug/a2a` · `message/send` | `agent.a2a.invoke` | ✅ | ⛔ | ⛔ | · | · | · | ⛔ | · | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 26 | `POST /api/agents/:slug/a2a` · `message/stream` | `agent.a2a.invoke` | ✅ | ⛔ | ⛔ | · | · | · | ⛔ | · | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 27 | `POST /api/agents/:slug/a2a` · `tasks/get` | `agent.a2a.invoke` | ✅ | ⛔ | ⛔ | · | · | · | ⛔ | · | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 28 | `POST /api/agents/:slug/a2a` · `tasks/list` | `agent.a2a.invoke` | ✅ | ⛔ | ⛔ | · | · | · | ⛔ | · | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 29 | `POST /api/agents/:slug/a2a` · `tasks/cancel` | `agent.a2a.invoke` | ✅ | ⛔ | ⛔ | · | · | · | ⛔ | · | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| 30 | `GET /.well-known/agent-card.json`（匿名无令牌） | （免鉴权） | ✅ | — | — | — | — | — | — | — | — | — | — | — | — |

**门禁矩阵小结（#1–#29，363 次判定）**

| 判定 | 数量 |
|------|------|
| ✅ 应放行已放行 | **145** |
| ⛔ 应拒绝已拒绝 | **213** |
| ❌ 误放行（门禁层） | **0** |
| ❌ 误拒（门禁层） | **0** |
| 5xx | **0** |
| **合计** | **358**（主矩阵 313 + JSON-RPC 方法面 45） |

> ⚠️ 表中的 ✅/⛔ 仅代表**权限点门禁**判定正确。第 3、6–10、19、20、24、27–29 行存在**门禁之后的越权**（跨组织 / 跨主体），见第四章缺陷清单。#25–#29 灰色格未覆盖（无 `agent.a2a.invoke` 的账号在门禁即被拒，行为与 #4 完全同构）。

---

## 四、缺陷清单

### 🔴 B-1（P0）任意 `uhp.invoke` 机器凭证可劫持任意 A2A 任务，绕过人在环审批门禁

**位置**：`packages/plugin-uhp/src/index.ts` L594–687（`POST /v1/uhp/responses` 将 `metadata['ybk_a2a_task_id']` 原样透传给 `createResponse({ taskId })`）→ `run()` L484 `emitProgress(record.taskId)` → `a2a.onProgress()`（`plugin-a2a/src/index.ts` L722–749）直接把目标任务推入终态。

**根因**：`taskId` 来自**请求体**，服务端未校验该 task 是否属于当前 principal、是否由 UHP 派发路径产生、是否处于可推进状态。`a2a.onProgress` 侧只按 `payload.taskId` 查任务并 `transition()`，**不做来源校验**。

**最小复现路径**

```
# 1) 造一个处于「人在环审批等待中」的目标任务（admin 发起，A1 目标 → execute_confirm）
POST /api/agents/qa-a1-exec/a2a          Authorization: Bearer <admin>
{ "jsonrpc":"2.0","id":"1","method":"message/send",
  "params":{"message":"待审批任务"} }
→ 200, taskId=task_xxxx, state="auth_required"（等待审批，绝不能被绕过）

# 2) 攻击者：一个 scopes=["uhp.invoke"] 的外部机器凭证（无任何 A2A 权限、非任务发起方、跨组织）
POST /v1/uhp/responses                   Authorization: Bearer <uaPmin-uhp>
{ "model":"qa-a2-auto", "input":"INJECTED",
  "metadata": { "ybk_agent_id":"qa-a2-auto",
                "ybk_a2a_task_id":"task_xxxx" } }
→ 200, id=resp_xxxx, task_id=task_xxxx

# 3) 观察：目标任务被强制推进终态，交付物被替换
GET /api/a2a/tasks/task_xxxx            Authorization: Bearer <admin>
→ state="completed"，stateReason="任务完成（含交付物 1 项）"
  artifacts[0].content = 攻击者的模型输出
  attempts=0（从未经过 A2A 派发链路）
```

**实测证据**（本轮）

| 观测项 | 值 |
|--------|-----|
| 注入前目标任务状态 | `auth_required`（审批工单 `apr_mvg6dsobien9atkv` 挂着） |
| 注入后目标任务状态 | **`completed`** |
| 注入后交付物 | `[{"artifactId":"art_mvg6dvt3ieniigeb","name":"reply.txt","content":"A2A/UHP QA STUB 应答 #67","sizeBytes":26}]` |
| 攻击者 scopes | **仅 `["uhp.invoke"]`**（无 `agent.read`、无任何 `a2a.*`） |
| 审计归属 | `uhp.invoke  ok  actor=uhp  harness=h-qa-a2-auto ... task=task_mvg6dsoaien6ldly` → **记在系统 `uhp` 名下，攻击者 principal 未出现在审计中** |

**影响**
1. **直接击穿治理方案的核心承诺**——`auth_required` / `approval.create` 这条"人在环审批"链路可被任何最小权限机器凭证单方面短路。
2. **跨租户写入**——可向任意组织的任意任务注入伪造交付物与 token 计量。
3. **审计洗白**——审计 `actorId` 记为 `uhp`（系统），攻击者不可追溯，事后无法归因。

**边界补充**：`ybk_data_class:"secret"` 的注入会被 harness 天花板 + modelgw 分级锁死（目标任务转 `failed`，审计记「数据分级越界」），说明**密级维度有兜底、任务归属维度完全没有兜底**。

**修复建议**
- `POST /v1/uhp/responses` 收到 `metadata.ybk_a2a_task_id` 时，必须校验该 task 的 `callerPrincipalId === verified.principal.id`，否则 403；或
- 更稳妥：**`/v1/uhp` 协议面禁止外部主体直接携带 `ybk_a2a_task_id`**——该字段仅允许由 `a2a.task.dispatch` 总线路径（服务端内部）注入，直调请求携带即 400。
- `a2a.onProgress` 增加来源校验：仅接受本进程 `uhp.inflight` 中登记的 `(taskId → responseId)` 配对。
- 审计补 `callerPrincipalId`，不要一律记 `uhp`。

---

### 🟠 B-2（P1）A2A / UHP 治理视图**完全无组织隔离**，跨组织读取全部任务明文正文与模型交付物

**位置**：
- `plugin-a2a/src/index.ts` L1184–1191（`GET /api/a2a/tasks`）与 L1192–1199（`GET /api/a2a/tasks/:taskId`）：只过 `a2a.directory.read` 门禁，**无任何 org 过滤**
- L1081–1089（`GET /api/a2a/directory`）与 L1215（`GET /api/a2a/fulfillment`）：同上
- `plugin-uhp/src/index.ts` L711–716（`GET /api/uhp/harnesses`）、L758–768（`GET /api/uhp/responses`）：同上
- 对照口径：`/api/agents` 已实现组织子树过滤（R11），A2A/UHP 治理面**未复用**

**最小复现路径**

```
# qa-ro：组织 = QA隔离部（org_mvg65wqjidmow2ek），权限 = agent.read + a2a.directory.read

GET /api/agents            Authorization: Bearer <qa-ro>
→ 200, agents=[]                      ✅ 组织子树过滤生效（隔离正确）

GET /api/a2a/directory     Authorization: Bearer <qa-ro>
→ 200, 6 名员工全部属根组织：
   qa-a0-tip, qa-a1-exec, qa-a2-auto, qa-a3-neg, qa-caller-bot, qa-a3-caller

GET /api/a2a/tasks?limit=3 Authorization: Bearer <qa-ro>
→ 200, 3 条根组织任务全文，例如：
   agentSlug=qa-a2-auto  callerSubject=agent:agt_mvg65y94idps38ro  dataClass=internal
   message = "组A契约对齐：A2A→UHP 幂等键链探针"
   artifacts[0].content = "A2A/UHP QA STUB 应答 #39"     ← 模型真实输出
   history[]（含全部要约/还价/状态流水）

GET /api/a2a/fulfillment   Authorization: Bearer <qa-ro>
→ 200, 3 行根组织员工履约统计（received/completed/acceptancePassRate/token 汇总）

# qa-collab：组织 = QA技术中心（org_mvg65wqiidmm0h3x），权限含 uhp.read
GET /api/uhp/harnesses     Authorization: Bearer <qa-collab>
→ 200, 可见根组织 harness 配置：
   {"agentId":"agt_mvg65xluidp4m49p","model":"qa-stub-model",
    "toolPermGroupIds":[],"stepBudget":7}

GET /api/uhp/responses?limit=50  Authorization: Bearer <qa-collab>
→ 200, total=22，全部 response 的 output_text 明文可见
```

**影响**：任意一个被授予 `a2a.directory.read` 或 `uhp.read` 的**下级组织**，即可读取全平台所有组织的协作任务正文、员工产出、履约指标与执行配置。`qa-ro` 角色名为"隔离组织只读"，实为"全平台只读"。

**修复建议**
- `listTasks` / `directory` / `fulfillment` / `uhp.harnesses` / `uhp.responses` 统一接入与 `/api/agents` 相同的 org 子树过滤（按 `agent.orgId ∈ 可见组织集合` 收敛）。
- `a2a.directory.read` 语义收敛为"**本组织可见范围内**的协作目录与任务治理视图"，并在权限点 label 上同步表述。

---

### 🟠 B-3（P1）`a2a.directory.read` 治理视图权限 = 全平台任务明文正文读取权（口径问题）

**位置**：`plugin-a2a/src/index.ts` L840–847

```ts
getTask(caller: CallerRefLike, taskId: string): A2aTaskRecord {
  const task = this.tasks().findOne((item) => item.taskId === taskId)
  if (!task) throw new NotFoundError(...)
  if (task.callerPrincipalId !== caller.principalId
      && !caller.permissions.includes('*')
      && !caller.permissions.includes('a2a.directory.read')) {
    throw new Error(t('无权查看该任务（仅发起方或治理视图持有者）'))
  }
  return task
}
```

**实测**：`qa-caller-cc`（机器员工凭证）与 `qa-collab` / `qa-ro`（只读观察员）均可读取 **admin 发起的**任务全文：

```
POST /api/agents/qa-a2-auto/a2a  Bearer <qa-caller-cc>
{"method":"tasks/get","params":{"taskId":"task_mvg68xnwidwdt8ah"}}
→ 200, message="机密探针-B：管理员任务正文-ADMIN-SECRET-0002"（含 artifacts[0].content）
```

`taskView()` 返回的字段包含：`message`（原始指令正文）、`artifacts[].content`（模型完整输出）、`negotiation.offers[]`（要约/还价原文）、`history[]`（全量流水）。即：**"只读治理视图"这一名义上的元数据权限，在实现上是全量明文读取权限**。

**弱凭证对照（这部分是正确的）**：

| 主体 | REST `GET /api/a2a/tasks/:id` | RPC `tasks/get` | 判定 |
|------|------|------|------|
| `qa-weak-cc`（仅 `agent.read`） | **403 FORBIDDEN** | **403 FORBIDDEN** | ✅ 正确拒绝 |
| `qa-member`（仅 `agent.read`+console） | **403 FORBIDDEN** | **403 FORBIDDEN** | ✅ 正确拒绝 |
| 仅 `agent.a2a.invoke` 的临时凭证 | 403（门禁） | 403 / JSON-RPC error | ✅ 正确拒绝 |

**产品口径建议（三选一，建议 B）**

| 方案 | 做法 | 优劣 |
|------|------|------|
| A. 维持现状 | 明确文档化"`a2a.directory.read` = 全平台任务正文读取权" | 实现零改动；但该权限点名称与 label（"读取 A2A 协作目录与任务治理视图"）严重低估其风险，一旦误授给下级组织即造成全平台数据泄露 |
| **B. 拆分元数据读 / 明文读（推荐）** | 新增 `a2a.task.read.meta`（只返 `taskId/state/agentSlug/callerSubject/timestamps/tokens`），把 `message` / `artifacts` / `negotiation` / `history` 的明文读取划入 `a2a.task.accept` 或新增的 `a2a.task.read.content` | 与"治理巡检"和"业务交付"两类真实诉求分离；控制台治理看板用前者即可 |
| C. 明文读取需二次授权 | 保留单点，但读取明文字段时要求调用方同时具备 `agent.read` + 同组织 | 改动面较大，且跨员工协作场景下同组织判定复杂 |

---

### 🟠 B-4（P1）UHP response 无归属校验：任一 `uhp.invoke` 主体可读/取消他人的执行记录

**位置**：`plugin-uhp/src/index.ts` L689–708

```ts
http.register('GET', '/v1/uhp/responses/:id', (exchange) => {
  const verified = verifyCaller(exchange)      // 只校验 scopes 含 uhp.invoke
  if (!verified) return
  const record = gateway.response(exchange.params['id'] ?? '')
  if (!record) { exchange.fail(404, ...) }
  exchange.ok(uhpView(record))                 // 无 callerPrincipalId 比对
})
// cancelResponse 同样无归属校验
```

**最小复现路径**

```
# 属主：qa-b-uhp-owner（scopes=["uhp.invoke","agent.read"]）
POST /v1/uhp/responses  →  resp_mvg6b6jlieao2ibt

# 攻击者：qa-b-uhp-attacker（同级最小权限，另一 principal）
GET  /v1/uhp/responses/resp_mvg6b6jlieao2ibt   → 200，output_text 明文返回
POST /v1/uhp/responses/resp_mvg6b6jlieao2ibt/cancel → 400「response 已终态」，
                                                   即请求已进入业务处理器（未在鉴权层被拒）
```

**影响**：`uhp.invoke` 是执行面凭证，同层任意服务/外部集成之间可以互相读取输入输出内容、并互相取消在途任务（DoS + 数据泄露）。若其中任一方绑定在另一个组织，即退化为跨组织越权。

**修复建议**：`response()` / `cancelResponse()` 增加归属判定——`record` 需持久化 `callerPrincipalId`，非属主且非持 `uhp.read`/`*` 者 403；`employee-bound` 会话按 `sessionId` 归属校验。

---

### 🟠 B-5（P1）`tasks/cancel` 无归属/组织校验——治理读权限蕴含跨主体写权限

**位置**：`plugin-a2a/src/index.ts` L859–866（`cancelTask` → 复用 `getTask` 的宽松判定）

**最小复现路径**

```
# admin 发起、处于审批等待中的任务
POST /api/agents/qa-a1-exec/a2a  Bearer <admin>  {"method":"message/send", ...}
→ task_mvg6fbx6if8lksyx, state=auth_required

# 另一 principal 的机器员工凭证（qa-caller-cc：agent.a2a.invoke + a2a.directory.read）
POST /api/agents/qa-a2-auto/a2a  Bearer <qa-caller-cc>
{"method":"tasks/cancel","params":{"taskId":"task_mvg6fbx6if8lksyx","reason":"other-principal-cancel"}}
→ 200 OK

GET /api/a2a/tasks/task_mvg6fbx6if8lksyx  Bearer <admin>
→ state="canceled"，stateReason="other-principal-cancel"
```

**说明**：路由层 `agent.a2a.invoke` 门禁是有效的（`qa-collab`/`qa-ro` 因无该点被 403 拦住，实测确认），但**在门禁之内**，`cancelTask` 完全复用 `getTask` 的"发起方 或 持 `a2a.directory.read`"口径，导致**读权限蕴含了对他人任务的写（取消）权限**，且无组织校验，可击穿审批中的任务。

**修复建议**：`cancelTask` 使用独立的严格判定——仅 `task.callerPrincipalId === caller.principalId` 或 `*`；治理视图持有者如需代管，走独立的 `a2a.admin` 动作并留痕。

---

### 🟡 B-6（P2）`/v1/uhp/*` 与 SSE 端点的拒绝路径零审计留痕

**位置**：`plugin-uhp/src/index.ts` L574–592（`verifyCaller`）、`plugin-a2a/src/index.ts` L1159–1181（SSE 处理器）

**实测**：触发 6 类拒绝（A2A guarded 403 ×3、UHP 403、UHP 401、SSE 403）后，审计仅新增 **3 条**，全部为 `console.authz.denied`（即仅 `/api/*` 走 `RestGate.requirePermission` 的那条路径留痕）。

```
审计全量 500 条统计：
  console.authz.denied   242 条   （/api/* 域）
  action 含 uhp 且 result=denied   0 条
  提及 events/SSE 的记录          0 条
```

`/v1/*` 与 `/.well-known/*` 不在 `plugin-console` 鉴权中间件覆盖范围（中间件仅拦 `/api/`），自校验路径未补 `ctx.platformBus.emit('audit.authz.denied', ...)`。

**修复建议**：`verifyCaller` 与 SSE 处理器的每个 `exchange.fail(401/403, ...)` 前补 `audit.authz.denied` 埋点，actor 取 `verified?.principal.id ?? '(anon)'`。

---

### 🟡 B-7（P2）SSE 端点错误码不规范（越权返回 400 而非 403，坏令牌返回 400 而非 401）

**位置**：`plugin-a2a/src/index.ts` L1178–1180

```ts
} catch (error) {
  exchange.fail(error instanceof NotFoundError ? 404 : 400, 'BAD_REQUEST', ...)
}
```

所有非 `NotFoundError` 一律 400，包括**权限不足**与**令牌非法**两类完全不同的语义。

**实测（仅持 `agent.a2a.invoke` 的临时凭证读他人任务）**

```
GET /v1/a2a/tasks/task_mvg68xnwidwdt8ah/events?token=<invoke-only>
→ 400 {"code":"BAD_REQUEST","message":"无权查看该任务（仅发起方或治理视图持有者）"}

GET /v1/a2a/tasks/<id>/events?token=zzz        → 400 「令牌格式不合法」
GET /v1/a2a/tasks/<id>/events?token=<签名篡改>  → 400 「令牌签名校验失败」
GET /v1/a2a/tasks/<id>/events?token=<自然过期>   → 400 「令牌已过期」
GET /v1/a2a/tasks/<id>/events（无 token）       → 401 ✅ 规范
```

JSON-RPC 面同样以 `-32000` 通用码返回权限错误，未使用保留的权限错误码。

**判定**：**数据未泄露（fail-closed 成立），仅状态码语义不合规**——安全设备/WAF/审计告警依赖 401/403 分流，当前实现会让"权限拒绝"混入"参数错误"噪声。

**修复建议**：把 `ctx.authn.verify` 异常映射为 401，把 `getTask` 抛出的权限异常映射为 403（可引入 `ForbiddenError` 类型，与 `NotFoundError` 并列）。

---

### 🟡 B-8（P2）REST 任务详情与 RPC `tasks/get` 的归属口径不一致

**位置**：`plugin-a2a/src/index.ts` L1192–1199 vs L840–847

REST `GET /api/a2a/tasks/:taskId` 直接 `collab.tasks().findOne(...)` 返回，**完全不调用 `getTask`**，因此不执行归属判定；RPC `tasks/get` 则执行。同一份数据、两个端点、两种口径。

实测：`qa-collab` 通过 REST 读到 admin 的任务全文（见 B-3 证据）。虽然 REST 额外要求 `a2a.directory.read`（RPC 只要求 `agent.a2a.invoke`），但"REST 比 RPC 宽"这一不一致会让后续加固时出现单点遗漏。

**修复建议**：REST 详情端点改为调用 `collab.getTask(caller, taskId)`，与 RPC 单一实现。

---

### 🟡 B-9（P2）交付验收无职责分离（任意 `a2a.task.accept` 持有者可验收任意任务，含自己发起的）

**位置**：`plugin-a2a/src/index.ts` L869–881（`acceptTask` 只校验 `state === 'completed'` 与 `reason` 非空）

**实测**

```
# qa-acceptor 验收 admin 发起的任务
POST /api/a2a/tasks/task_mvg69iecidyuux7j/acceptance  Bearer <qa-acceptor>
{"decision":"accepted","reason":"跨主体验收探针"}
→ 200, acceptance={"status":"accepted","by":"usr_mvg65wtlidnmrmj7", ...}

# admin 验收自己发起的任务（同一主体既是发起方又是验收方）
POST /api/a2a/tasks/task_mvg68xnwidwdt8ah/acceptance  Bearer <admin>
{"decision":"accepted","reason":"自验收探针"}
→ 200, acceptance={"status":"accepted","by":"usr_mvg65e9midmcih9e", ...}
```

代码注释声明"验收不轻信自报"，但实现层面没有 `acceptance.by !== task.callerUserId` 这条独立性约束，验收通过率指标（`acceptancePassRate`）因此可被自验收刷高。

**修复建议**：增加"验收人 ≠ 任务发起人（人侧）"的独立性校验，或在履约统计中把自验收单列。

---

## 五、越权原语封堵验证结果（请求级 `tools`）

被测实现：`plugin-uhp/src/index.ts` L637–638 → L301–303 → L336–342

```ts
requestTools: body.tools !== undefined ? body.tools : metadata['tools'],
...
const ignoredFields: string[] = []
if (input.requestTools !== undefined) ignoredFields.push('tools')
...
metadataJson: JSON.stringify({ ..., ignored_fields: ignoredFields })
```

| # | 注入载荷 | HTTP | `metadata.ignored_fields` | 模型是否真的调用了工具 | 判定 |
|---|----------|------|--------------------------|----------------------|------|
| 1 | 顶层 `tools: [{"type":"function","name":"shell"}]` | 200 | `["tools"]` | 否（输出为 stub 文本应答） | ✅ 接受但不生效 + 留痕 |
| 2 | `metadata.tools: [{"type":"function","name":"shell"}]` | 200 | `["tools"]` | 否 | ✅ |
| 3 | 顶层 + `metadata.tools` 同传（不同载荷） | 200 | `["tools"]`（仅记一次，不重复） | 否 | ✅ |
| 4 | 伪装 MCP：`metadata.tools: [{"type":"mcp","server":"evil-mcp","tool":"delete_all"}]` | 200 | `["tools"]` | 否 | ✅ |
| 5 | 基线（不传 tools） | 200 | `[]` | 否 | ✅ 未误报 |

**结论：越权原语封堵通过 ✅**。四类注入载荷全部被"接受但不生效"，且统一记入 `metadata.ignored_fields`，留痕可在 `GET /v1/uhp/responses/:id` 与 `GET /api/uhp/responses` 的 `metadata.ignored_fields` 字段回查。

**遗留建议（P3）**：`ignored_fields` 目前只记字段名 `tools`，不记被忽略载荷的摘要/来源 IP/principal，事后无法判断"是谁试图注入什么"。建议补 `ignored_fields_detail`（截断后的载荷指纹 + actorId）。

---

## 六、组织隔离结果

| 账号 | 组织 | `/api/agents`（R11 口径） | `/api/a2a/directory` | `/api/a2a/tasks` | `/api/a2a/fulfillment` | `/api/uhp/harnesses` | 跨组织发起协作 |
|------|------|------|------|------|------|------|------|
| `qa-outsider` | QA隔离部 | 200 · **0 条** ✅ | **403** ⛔ | **403** ⛔ | **403** ⛔ | **403** ⛔ | **403** ⛔ |
| `qa-ro` | QA隔离部 | 200 · **0 条** ✅ | **200 · 6 条根组织员工** ❌ | **200 · 23 条根组织任务全文** ❌ | **200 · 3 行根组织统计** ❌ | 403 ⛔ | 403 ⛔ |
| `qa-collab` | QA技术中心 | — | 200 · 6 条 | 200 · 23 条 ❌ | — | **200 · 根组织 harness 配置** ❌ | 403 ⛔ |
| `qa-member` | 根组织 | 200 · 6 条 | 403 ⛔ | 403 ⛔ | 403 ⛔ | 403 ⛔ | 403 ⛔ |
| `qa-ops` | 根组织 | 200 · 6 条 | 200 · 6 条 | 200 · 23 条 | 200 | 200 · 6 条 | 403 ⛔ |

**结论**：

1. ✅ **权限点层面的组织隔离有效**——未持 `a2a.directory.read` / `uhp.read` / `agent.a2a.invoke` 的隔离组织账号，全部在门禁层被 403 拦住；`/api/agents` 的组织子树过滤也正确返回 0 条。
2. ❌ **一旦授予治理读权限点，组织隔离即刻失效**（B-2）——`qa-ro` 与 `qa-collab` 的表现是"隔离组织只读"实为"全平台只读"。这是本轮最严重的一类**授权设计缺陷**（不是实现 bug，而是权限点语义未绑定组织维度）。
3. ✅ **写操作的组织隔离成立**——`tasks/cancel`、`message/send` 在隔离组织账号上被 `agent.a2a.invoke` 门禁 403 拦住。

**建议**：A2A/UHP 治理端点在 `gate.guarded` 之上增加一层统一的 org 收敛中间件，与 `/api/agents` 复用同一份 org 可见性计算，避免治理面成为"绕过组织隔离的后门"。

---

## 七、通过项摘要

### 7.1 权限点门禁（零误放行 / 零误拒）

- ✅ 24 个 A2A/UHP 受保护端点 × 13 账号 = **313 次判定**，`PASS_ALLOW 130 / PASS_DENY 183 / FAIL 0`
- ✅ JSON-RPC 五方法（`message/send`·`message/stream`·`tasks/get`·`tasks/list`·`tasks/cancel`）× 9 账号 = **45 次判定**，`PASS_ALLOW 15 / PASS_DENY 30 / FAIL 0`
- ✅ 三个新权限点的最小必要授权面正确：`a2a.admin`（admin + qa-a2aadmin）、`a2a.task.accept`（admin + qa-acceptor + qa-a2aadmin）、`uhp.admin`（admin + qa-a2aadmin）、`uhp.invoke`（admin + qa-uhp-cc）、`a2a.directory.read`（admin/qa-ops/qa-collab/qa-acceptor/qa-a2aadmin/qa-ro/两台 agent 凭证）
- ✅ `qa-approver`（审批人，6 点）在全部 A2A/UHP 端点被正确 403 —— 不会因"同在审批域"而误放

### 7.2 fail-closed

- ✅ **108 次异常令牌判定，0 个 5xx**
  - 8 类令牌变体 × 13 个受保护端点 = 104 次，**104/104 通过**
  - SSE `?token=` 自校验 4 次，**2/4 通过**（无 token → 401 ✅、错 scope → 403 ✅、垃圾串 → 400 ⚠️、签名篡改 → 400 ⚠️）
- ✅ 无令牌 / 空串 / `Bearer ` 空值 / 垃圾串 → `/api/*` 全部 `401 UNAUTHORIZED`、`/v1/*` 全部 `401`、`SSE` 无 token 参数 `401`
- ✅ 签名篡改（`sub` 篡改、`exp` 改为过去、`scope` 提权为 `*`）→ 全部 `401 TOKEN_INVALID`，**权限点提权篡改未生效**
- ✅ 错 scope 凭证（`qa-weak-cc` 仅 `agent.read`）→ 全部 `403 FORBIDDEN`，含 `POST /v1/uhp/responses`（`缺少权限点 uhp.invoke`）与 acceptance 端点（`缺少权限点 a2a.task.accept`）
- ✅ 令牌被主动吊销后（`令牌已被吊销：权限范围调整联动`）立即 401 —— 权限范围变更联动吊销机制工作正常
- ✅ **自然过期令牌 fail-closed（31 次判定，30/30 规范拒绝）**：等待 bootstrap 原始令牌（`exp=1792471474`）自然过期后，用 `qa-collab` / `qa-a2aadmin` / `qa-member` 三个账号各打 10 个受保护端点（`/api/a2a/directory|tasks|fulfillment`、`/api/uhp/harnesses|responses`、`/v1/uhp/responses/:id`、`POST /v1/uhp/responses`、`POST /api/agents/:slug/a2a`、`/api/audit/logs`）——**30/30 全部 `401 TOKEN_INVALID`「令牌已过期」**，无任何端点放行
- ⚠️ 唯一偏差：SSE 对坏令牌/签名失败/**自然过期令牌**均返回 400（`令牌格式不合法` / `令牌签名校验失败` / `令牌已过期`）而非 401（见 B-7，已拒绝不泄露）

### 7.3 协议免鉴权面

- ✅ `GET /.well-known/agent-card.json`、`GET /.well-known/agents/:slug/agent-card.json`、`GET /v1/uhp` 三个协议要求免鉴权端点，13 账号 + 匿名全部 200
- ✅ 平台卡仅列 `status === 'online'` 的员工；离线/不存在 slug 一律 404（不泄露离线资产存在性）
- ✅ 路径穿越探针 `slug="../../api/a2a/directory"` → 404，未穿透
- ✅ 平台卡携带 `signingKeys`（Ed25519 公钥），支持"先验签后采信"

### 7.4 验收接口人类专属门禁

- ✅ 通过 `PATCH /api/authn/principals/:id` 给外部机器凭证 `qa-uhp-cc` **临时追加** `a2a.task.accept`，重新换发令牌后调用 acceptance：
  → **403 FORBIDDEN「交付验收仅限人类用户（验收不轻信自报，人在环收口）」**
- ✅ 还原 scopes 后 → 403「缺少权限点 `a2a.task.accept`」，两层门禁均生效
- ✅ `acceptTask` 对非 `completed` 状态、空白 `reason` 均拒绝（不轻信自报）
- ✅ `tasks/get` 弱凭证（`qa-weak-cc` 仅 `agent.read`）REST + RPC 双通道均 403

### 7.5 审计留痕

- ✅ `/api/*` 拒绝路径：`RestGate.requirePermission` 统一发 `audit.authz.denied`，累计 242 条，覆盖 actor / 权限点 / path
- ✅ 治理拒绝有业务留痕：`a2a.task.rejected / result=denied`（协商矩阵拒绝、密级越级）、`agent.a2a.invoke / result=error`（执行失败）
- ✅ 变更留痕：`a2a.rule.create/delete`、`a2a.patrol.run`、`a2a.task.acceptance`、`uhp.harness.upsert/update/delete`、`authn.principal.create/disable/scopes`
- ❌ `/v1/uhp/*` 与 SSE 拒绝路径零留痕（B-6）

### 7.6 其他正向验证

- ✅ 跨 harness 会话续接被拒：`previous_response_id` 属其他执行体 → 400「`previous_response_id 属于其他执行体，拒绝跨 harness 会话续接`」
- ✅ 密级天花板生效：`dataClass=secret` 注入被 harness 天花板 + modelgw 分级锁死
- ✅ `uhp.admin` harness 写路径全链路 2xx（创建 → 更新 → 删除），探针 harness 已清理
- ✅ 幂等键语义生效：同 `Idempotency-Key` 重放返回原 response

---

## 八、风险与遗留

### 8.1 阻断级（建议发版前修复）

| ID | 级别 | 一句话 |
|----|------|--------|
| B-1 | **P0** | `uhp.invoke` 凭证可劫持任意 A2A 任务并绕过人在环审批，且审计归属被洗白为系统 |
| B-2 | **P1** | A2A/UHP 治理面无组织隔离，下级组织持治理读权限即可读全平台任务正文与执行配置 |

### 8.2 本轮未覆盖 / 遗留

| 项 | 原因 | 建议 |
|----|------|------|
| **跨组织 `agent.a2a.invoke`** | 现有机器凭证全部绑定根组织员工，无"隔离组织的 agent 凭证"夹具 | 结合 B-2/B-5 修复后，用隔离组织的 agent 凭证补测 `message/send` / `tasks/cancel` 的跨组织行为（代码层 `sendMessage` / `cancelTask` 均无 org 判定，预期会失败） |
| **`employee-bound` 会话跨主体续接** | 需先有 employee-bound 模式的在途 session | 归属校验补齐后复测 |
| **A3×A3 要约-还价中的越权** | 协商轮次由 `NEGOTIATION_MAX_ROUNDS=3` 收敛，未构造出 3 轮还价的越权场景 | 补一轮"伪造 counter 要约使目标任务进入 input_required 后由非发起方续答"的探针 |
| **并发竞态**（cancel 与 completed 同时到达） | stub 模型同步返回，竞态窗口不可复现 | 建议在集成环境用真实慢模型复测 `cancelRequested` 与模型返回的时序 |
| **A2A 目录的 org 字段投影** | `GET /api/a2a/directory` 返回 `agentId`（内部 id）给所有 `a2a.directory.read` 持有者 | 建议非 `*` 主体改用 slug 投影，避免内部 id 外泄 |
| **规则/巡检内容跨组织** | `GET /api/a2a/rules`、`/api/a2a/patrols` 同为 `a2a.directory.read`，含 `createdBy` 与漂移明细 | 随 B-2 一并收敛 |
| **`a2a.task.accept` 无职责分离** | B-9 已记录；`qa-a2aadmin` 同时持 `a2a.admin` + `a2a.task.accept`，可自建规则再自验收 | 需产品决策是否强制验收人独立性 |

### 8.3 建议的回归护栏

1. **路由×权限点矩阵自动断言**：CI 中固化"每个 A2A/UHP 路由的声明权限点 + 越权拒绝码"，新增路由未声明权限点即失败（可复用 `gate.guarded` 的 `RouteAuthDecl` 反射）。
2. **组织隔离回归**：为每个治理读端点增加一条"下级组织账号读上级组织资源 → 403/空集"的 CI 断言。
3. **越权原语回归**：对 `/v1/uhp/responses` 的每个非协议字段（`tools` / `functions` / `mcp_servers` / `ybk_a2a_task_id` / `ybk_on_behalf_user`）注入探针，断言「不生效 + 留痕 + 无副作用」。
4. **审计覆盖度断言**：对每个鉴权拒绝分支断言审计中出现对应 `authz.denied` 记录。

---

## 附录 A · 取证脚本与产物

| 文件 | 内容 |
|------|------|
| `/tmp/qa/refresh.mjs` | 全量令牌刷新（9 账号 + 4 机器凭证） |
| `/tmp/qa/setup-fixtures.mjs` / `setup-accept.mjs` | 造数：A2A 任务（机器发起/管理员发起/待验收 5 条）、UHP 直调 response |
| `/tmp/qa/matrix.mjs` | **主矩阵** 313 次判定 → `results-matrix.json` |
| `/tmp/qa/rpc-methods.mjs` | JSON-RPC 五方法面 45 次判定 → `results-rpc.json` |
| `/tmp/qa/failclosed.mjs` | fail-closed 108 次判定 → `results-failclosed.json` |
| `/tmp/qa/deep.mjs` / `deep2.mjs` | 语义深测（工具封堵 / 可见性 / 组织隔离 / 验收门禁 / harness 往返 / 审计） |
| `/tmp/qa/audit-gap.mjs` / `audit-precise.mjs` | 审计覆盖度与动作分布统计 |
| `/tmp/qa/p0.mjs` / `attack-taskid.mjs` | **B-1 P0 复现与边界确认** → `results-p0.json` |
| `/tmp/qa/cancel-escalation.mjs` | **B-5 越权取消验证** |
| `/tmp/qa/repro.mjs` | **B-2/B-3 最小复现取证** → `results-repro.json` |
| `/tmp/qa/expired.mjs` | **自然过期令牌** fail-closed（31 次）→ `results-expired.json` |

## 附录 B · 关键证据 ID

| 对象 | ID |
|------|-----|
| 机器凭证发起任务（机密探针-A） | `task_mvg68xhtidw1swpu` |
| admin 发起任务（机密探针-B） | `task_mvg68xnwidwdt8ah` |
| UHP 直调 response（机密探针-C） | `resp_mvg68xtwidwxvwli` |
| **B-1 P0 被劫持任务** | `task_mvg6dsoaien6ldly`（`auth_required` → `completed`） |
| B-1 注入的伪造交付物 | `art_mvg6dvt3ieniigeb` |
| B-1 被绕过的审批工单 | `apr_mvg6dsobien9atkv` |
| B-4 跨主体读取的 response | `resp_mvg6b6jlieao2ibt` |
| B-5 被越权取消的任务 | `task_mvg6fbx6if8lksyx`（admin 所有 → `canceled`） |
| B-9 自验收任务 | `task_mvg68xnwidwdt8ah`（`by=usr_mvg65e9midmcih9e` = admin 本人） |
