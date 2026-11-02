# 组A 契约对齐测试报告 — A2A 协作平面 / UHP 执行驱动层验收

| 项 | 内容 |
|---|---|
| 报告日期 | 2026-10-20 |
| 测试负责人 | 组A 契约对齐 QA |
| 被测变更 | `packages/plugin-a2a/`（新）、`packages/plugin-uhp/`（新）、`packages/plugin-console/public/js/pages/a2a.js`（新）、`plugin-usage` 增 contextId 维度、`plugin-agent` schema 扩字段、`plugin-console/routes/usage.ts` 增协作链查询 |
| 被测实例 | `http://127.0.0.1:7311`（可写 QA 实例，数据目录 `data-qa-20261020`） |
| 模型 stub | `http://127.0.0.1:7399/v1`（slug `deepseek-chat`） |
| 证据留存 | 测试脚本 `/tmp/qa/test-{a-wellknown,b-rpc,c-uhp,d-protocol-keys,e-authz}.mjs`，输出 `/tmp/qa/out-test-*.txt`，静态扫描器 `/tmp/qa/scan-routes.mjs`（结果 `/tmp/qa/route-scan.json`） |
| 纪律声明 | 全程只读测试，**未修改任何源码**；未重启/未 kill 任何进程；未触碰 7300/7301/7302 |

---

## 一、概述

本轮验收以「契约对齐」为唯一视角：**每一项断言都必须落到「静态定位 文件:行号」+「真机可复现请求/响应」双向证据**，不接受"看代码觉得没问题"。

核心结论：本批次的前后端路由对齐质量很高（374 个前端调用点 vs 458 条后端注册路由，A2A 新页面 7/7 精确命中，零孤儿页面、零方法错配），Agent Card 签名可独立验签通过，冻结契约中的幂等键分层、`contextId` 归集、`autonomy/runtime` 级别透出、协商矩阵、八态状态机、人工验收护栏均已兑现。**但存在 1 项安全越权（P0）与 4 项契约/一致性问题（P1×1、P2×4）**，其中 P0 为读权限点可执行跨发起方写操作（`tasks/cancel`），需在上线前修复。

严重级口径：P0=功能不可用/数据丢失/安全越权；P1=主流程缺陷或契约违背；P2=体验/一致性/可测性问题。

**总计：P0 = 1 项，P1 = 1 项，P2 = 4 项（另登记 4 项设计缺口，不计缺陷）。**

---

## 二、测试规模

| 维度 | 数量 |
|---|---|
| 静态扫描：console 前端 JS 文件 | 48 个（`packages/plugin-console/public/js/**/*.js`） |
| 静态扫描：前端 API 调用点 | 374 处（`api.get/post/put/patch/delete` + 裸 fetch + 动态串拼接） |
| 静态扫描：后端注册路由 | 458 条（`packages/*/src/**/*.ts` 内 `guarded(...)` / `http.register(...)` 字面量） |
| 静态扫描：前后端路径对账 | 374 条逐条比对；**路径未匹配 9 条 → 全部为模板字面量注册导致的扫描器假阳性，人工复核 9/9 均存在**（见 §五 通过项 P-3）；**方法错配 0 条** |
| A2A 专项对账路径 | 7 条（`pages/a2a.js` 全部 API 调用）→ 7/7 精确匹配后端 `plugin-a2a/src/index.ts` 注册行 |
| 真机断言总数 | **174 项**（A 23 / B 59 / C 44 / D 40 / E 8） |
| 断言通过 | **169 项** |
| 断言失败 | **5 项**（归并为 4 个缺陷 + 1 个缺陷的二次确认断言） |
| 协议键 ASCII 扫描 | 15 个对外响应面 / **734 个键**逐键扫描中文泄漏 |
| 中文对照总表覆盖核对 | 13 项事件/权限点/环境变量 + 5 项治理原因码 + 26 项新增对外字段 |
| 真机 HTTP 请求数 | 约 320 次（含 JSON-RPC、SSE 流、越权探针、验签复算） |

---

## 三、断言结果一览表

| 套件 | 主题 | 断言数 | 通过 | 失败 |
|---|---|---|---|---|
| A | well-known 契约 + JWS 独立验签 + governance 扩展 | 23 | 23 | 0 |
| B | A2A JSON-RPC 方法面 + 冻结契约（幂等键/contextId/401 口径/验收闭环） | 59 | 59 | 0 |
| C | UHP 协议面 + 幂等键链 + A2A↔UHP 联动 | 44 | 42 | 2 |
| D | 协议键 ASCII 纪律 + 中文对照总表覆盖 | 40 | 39 | 1 |
| E | 写面鉴权对称性 + 孤儿路由盘点 | 8 | 6 | 2 |
| **合计** | | **174** | **169** | **5** |

失败断言明细：

| 断言 | 结果 | 归并缺陷 |
|---|---|---|
| `C20 previous_response_id 会话续接生效` | ✘ | A-4（P2） |
| `C36 GET /v1/uhp 公布的 harness id 直接作 model=harness/<id> 调用` | ✘ | A-2（P1） |
| `D11 总表覆盖 A2A 治理拒绝原因码 5 条` | ✘ | A-3（P2） |
| `E2 tasks/cancel：非发起方（持 a2a.directory.read）应被拒` | ✘ | **A-1（P0）** |
| `E2b【越权确认】他人任务确实被改写为 canceled` | ✘ | A-1 的二次确认（同根因） |

---

## 四、缺陷清单

### A-1　`tasks/cancel` 跨发起方越权：读权限点 `a2a.directory.read` 可执行写动作

| 项 | 内容 |
|---|---|
| **编号** | A-1 |
| **严重级** | **P0（安全越权）** |
| **域** | A2A 协作平面 / 授权边界 |

**现象**

`cancelTask()` 直接复用 `getTask()` 作为授权闸门。`getTask()` 对持 `a2a.directory.read`（**只读**治理权限）的调用方直接放行，因此一台**并非任务发起方**的机器凭证，只要同时持 `agent.a2a.invoke` + `a2a.directory.read`（这正是协作型调用 Agent 的天然形状），即可把**别人创建的 A2A 任务**改写为 `canceled`，并经 `a2a.task.cancel` 总线事件连带中止该任务在 UHP 侧的在途执行。

**证据（静态）**

- `packages/plugin-a2a/src/index.ts:859-866`
  ```ts
  cancelTask(caller: CallerRefLike, taskId: string, reason: string): A2aTaskRecord {
    const task = this.getTask(caller, taskId)          // ← 读闸门被当作写闸门复用
    if (A2A_TERMINAL_STATES.includes(task.state)) throw new Error(...)
    this.transition(taskId, 'canceled', reason || t('调用方主动取消'))
    this.ctx.platformBus.emit('a2a.task.cancel', { taskId, reason })
  ```
- `packages/plugin-a2a/src/index.ts:843`（`getTask` 的放行条件）
  ```ts
  if (task.callerPrincipalId !== caller.principalId && !caller.permissions.includes('*')
      && !caller.permissions.includes('a2a.directory.read')) {   // ← 读权限点在此处被当作通行证
    throw new Error(t('无权查看该任务（仅发起方或治理视图持有者）'))
  }
  ```
- 对照组（**正确的写法**）：`packages/plugin-a2a/src/index.ts:470` 的续答路径做的是严格所有权校验，未给读权限开口子——
  ```ts
  if (task.callerPrincipalId !== caller.principalId && !caller.permissions.includes('*')) {
    throw new Error(t('仅任务发起方可续答该任务'))
  }
  ```
- `packages/plugin-a2a/src/index.ts:1141`（`tasks/list`）也把 `a2a.directory.read` 视为治理视图放行——**读语义下这是设计如此**，问题只在于 `cancelTask` 把它当成了写语义。

**证据（真机）**

```
前置：qa-a3-cc（principalId=pri_mvg65ywsidqrff73，绑定 qa-a3-caller）
  message/send "ZZRECONT 续答探针"  →  taskId=task_mvg6e6z0ieo104bm, state=auth_required
  发起方自读 tasks/get            →  auth_required

越权方：qa-caller-cc（principalId=pri_mvg65ywpidqn1qme，绑定 qa-caller-bot，
         scopes=["agent.a2a.invoke","agent.read","a2a.directory.read"]，非发起方）
  tasks/cancel {taskId, reason:"组A-E 越权取消探针"}
  →  HTTP 200，result.task.state = "canceled"

发起方复查：
  tasks/get {taskId} → state="canceled"，stateReason="组A-E 越权取消探针"
```
对照组（证明差异只在归属判定，而非取消能力本身）：
```
qa-a3-cc 取消自己创建的任务 → HTTP 200，state="canceled"（正常）
```
负向对照：
```
message/send 续答（同样持 a2a.directory.read 的非发起方）→ 被拒（-32000 仅任务发起方可续答该任务）
```
断言记录：`E2 / E2b`（`/tmp/qa/out-test-e.txt`）。

**根因**

写路径（`cancelTask`）缺少独立的归属校验，把只读治理权限点的"可见性"语义直接当作"可变更"语义。`A2A_TERMINAL_STATES` 的终态保护只能挡住"已终态再取消"，挡不住"非终态被他人取消"。

**修复建议**

1. 在 `cancelTask()` 内改为与续答路径同款的所有权判定：`task.callerPrincipalId === caller.principalId || caller.permissions.includes('*')`；如需治理角色代管取消，另设显式权限点（如 `a2a.task.cancel`），不与 `a2a.directory.read` 混用。
2. 抽出私有方法 `assertTaskOwner(task, caller)`，在 `sendMessage` 续答、`cancelTask` 两处复用，消除两处口径漂移。
3. 审计面补一条：A2A 任务状态由非发起方改写时，`auditTask` 的 `actorId` 应记录实际调用方 principal（当前已记录 `callerSubject`，确认无误即可）。

---

### A-2　UHP 发现面→调用面往返断裂：`model=harness/<harnessId>` 按 agent ref 解析

| 项 | 内容 |
|---|---|
| **编号** | A-2 |
| **严重级** | **P1（契约违背）** |
| **域** | UHP 协议面 / 契约一致性 |

**现象**

`GET /v1/uhp` 能力发现文档对外公布的是 **harness id**（`harnesses[].id`），`POST /v1/uhp/responses` 的报错文案也自述 `model 须为 harness/<id>`；但实现把 `harness/` 前缀剥掉后，把剩余段当作 **Agent 引用**去解析。因此按文档把发现结果原样回填到 `model` 上，客户端稳定拿到 **404**。

**证据（静态）**

- `packages/plugin-uhp/src/index.ts:611`（剥前缀后按 agent 解析）
  ```ts
  const agentRef = String(metadata['ybk_agent_id'] ?? String(body.model ?? '').replace(/^harness\//, '') ?? '')
  ```
- `packages/plugin-uhp/src/index.ts:615`（自述契约与实现不符）
  ```ts
  exchange.fail(400, 'BAD_REQUEST', t('缺少执行体：model 须为 harness/<id> 或 metadata.ybk_agent_id 必填'))
  ```
- `packages/plugin-uhp/src/index.ts:618-622`（只查 resourceCore，不查 harness 注册表）
  ```ts
  const agent = ctx.resourceCore.get('agent', agentRef) ?? ctx.resourceCore.bySlug('agent', agentRef)
  if (!agent) { exchange.fail(404, 'NOT_FOUND', t('执行体不存在：{ref}', { ref: agentRef })) ... }
  ```
- `packages/plugin-uhp/src/index.ts:626-639`：`createResponse({ ... })` 调用**未传** `harnessRef`，而 `resolveHarness()`（`:366-373`）才是真正查 harness 注册表的入口——即 HTTP 层无法把 `harness/<harnessId>` 解析成注册项。
- `packages/plugin-uhp/src/index.ts:255-261`（发现面公布的正是 harness id）
  ```ts
  harnesses: [...byHarnessId.entries()].map(([id, configured]) => ({ id, configured })),
  ```
- 文档同源矛盾：`docs/a2a-uhp-implementation.md:60` 验收快照列「显式 harness 生效」；`scripts/selftest.mjs:2944` 实测用的是 `model: 'harness/collab-target'`（**agent slug**），即 selftest 把"按 agent 解析"这一实现细节也一并烤进了断言，使该契约违背不被回归网捕获。

**证据（真机）**

```
GET /v1/uhp → harnesses[0] = {"id":"h-qa-a0-tip","configured":["qa-a0-tip"]}

POST /v1/uhp/responses  {"model":"harness/h-qa-a2-auto","input":"..."}
  → 404 {"ok":false,"error":{"code":"NOT_FOUND","message":"执行体不存在：h-qa-a2-auto"}}

POST /v1/uhp/responses  {"model":"harness/qa-a2-auto","input":"..."}     ← 传 agent slug 才行
  → 200 {"id":"resp_...","status":"completed","harness_id":"h-qa-a2-auto", ...}

寻址矩阵实测：
  model=harness/h-qa-a2-auto → 404（harness id）
  model=harness/qa-a2-auto   → 200（agent slug）
  model=agt_mvg65xluidp4m49p → 200（agent id）
  model=qa-a2-auto           → 200（agent slug）
  model=h-qa-a2-auto         → 404（harness id）
```
断言记录：`C36 / C37`（`/tmp/qa/out-test-c-uhp.txt`）。

**根因**

`harness/` 这个前缀在实现里是**纯装饰**（被 strip 掉），语义完全由后半段决定；协议文案与发现文档却把它声明成 harness 命名空间。同时 `createResponse` 的 `harnessRef` 形参在 HTTP 层从未被填充，导致 configured harness 注册表对 `/v1` 面不可寻址。

**修复建议（二选一，推荐 A）**

- **方案 A（对齐既有契约）**：`agentRef` 解析失败时回落到 `gateway.harnesses().get(agentRef)`，命中则由该 harness 反查 `agentId` 并把 `harnessRef` 透传给 `createResponse`；同时修正 selftest（`scripts/selftest.mjs:2944`）改用 harness id 做断言，使回归网真正覆盖该契约。
- **方案 B（改契约）**：把发现面改为公布 agent slug、把报错文案改为 `model 须为 harness/<agentRef>`，并显式登记"configured harness 无法从 /v1 面直接寻址，须经 a2a.task.dispatch 内部通道"的诚实边界。

---

### A-3　《协议键中文对照总表》未收录 A2A 治理拒绝原因码（5 条）

| 项 | 内容 |
|---|---|
| **编号** | A-3 |
| **严重级** | **P2（一致性 / 可测性）** |
| **域** | 协议键纪律 / 文档完备性 |

**现象**

A2A 的 5 个治理拒绝原因码经 JSON-RPC `error.data.code` 对外下发，属于跨系统契约键，但《协议键中文对照总表》第三节「错误原因码」未收录；总表自 §完备性口径 第 3 条给出的清点方法（`grep -rhoE "reason: *'[a-z0-9_.-]+'"` + 前端 `errors.js` 清点）也覆盖不到 `code:` 形态的新增码，清点口径与本批次实现不匹配。

**证据（静态）**

- `docs/协议键中文对照总表.md:212` — 第三节「错误原因码」共 37 条，无一条 A2A 治理码。
- `docs/协议键中文对照总表.md:459` — 完备性口径第 3 条的清点命令只 grep `reason:` 与 `errors.js`，漏 `code:` 形态。
- 新增码产生点：`packages/plugin-a2a/src/index.ts:357,358,370,378,502,505`（`TARGET_NOT_ONLINE` / `TARGET_FROZEN` / `DATA_CLASS_EXCEEDED` / `BUDGET_EXCEEDED` / `NEGOTIATION_REJECTED`），经 `:1153` 下发：
  ```ts
  if (error instanceof GovernanceError) return jsonRpcError(exchange, id, -32002, error.message, { code: error.code })
  ```

**证据（真机）**

```
grep -c '<code>' docs/协议键中文对照总表.md
  TARGET_NOT_ONLINE 0 / TARGET_FROZEN 0 / DATA_CLASS_EXCEEDED 0 / BUDGET_EXCEEDED 0 / NEGOTIATION_REJECTED 0
  （对照：UNAUTHORIZED/TOKEN_INVALID/FORBIDDEN/BAD_REQUEST/NOT_FOUND 各 1）

真机复现：
  rpc qa-a2-auto message/send {dataClass:"secret"} → error={code:-32002, data:{code:"DATA_CLASS_EXCEEDED"}}
  rpc qa-a0-tip  (a3CC) message/send             → error={code:-32002, data:{code:"NEGOTIATION_REJECTED"}}
```
断言记录：`D11 / D11b / D11d`。

**根因**

总表新增了 §1.2（A2A/UHP 事件）、§二（6 个权限点）、§4.10（3 个环境变量），但第三节错误原因码一节未随本批次同步，且完备性口径的清点命令未随实现形态扩展。

**修复建议**

1. 在总表第三节新增「3.4 A2A 治理拒绝原因码（5 条）」小节，逐条登记中文释义 + 产生位置（`plugin-a2a/src/index.ts` 治理检查五项）+ 对应 JSON-RPC 错误码（-32002）。
2. 把完备性口径第 3 条的清点命令补上 `grep -rhoE "code: *'[A-Z_]+'" packages/plugin-*/src --include="*.ts"`，并复核第三节条数统计（37 → 42）。

---

### A-4　UHP 直调会话身份不连续：`previous_response_id` 续接时 `session_id` 每次重新生成

| 项 | 内容 |
|---|---|
| **编号** | A-4 |
| **严重级** | **P2（一致性 / 可测性）** |
| **域** | UHP 协议面 |

**现象**

`previous_response_id` 会话续接时，消息历史确实从上一响应快照续接（内容层面成立），但 `session_id` 每一轮都新生成一个随机 `uhpsess_*`，导致"同一会话"在协议层没有稳定身份，`session_id` 无法作为会话归组键使用。

**证据（静态）**

- `packages/plugin-uhp/src/index.ts:304-307`
  ```ts
  const sessionId = sessionPolicy === 'task-bound'
    ? (input.taskId ?? newId('uhpsess'))     // ← 直调无 taskId → 每轮新随机 id
    : `emp:${agent.id}:${input.callerPrincipalId}`
  ```
- `packages/plugin-uhp/src/index.ts:81`（类型注释已登记该行为）
  ```
  /** 会话 id：task-bound=<a2a taskId>；employee-bound=`emp:<agentId>:<principalId>`；直调=独立生成。 */
  ```
  → 行为本身是**有意设计**，因此不是功能缺陷；但它是"代码注释声明的诚实边界"与"对外协议观感"之间的落差。
- `packages/plugin-uhp/src/index.ts:256`（能力发现声明）
  ```ts
  session_listing: true,
  ```
  而 `packages/plugin-uhp/manifest/api.yaml` 的 `/v1` 端点只有 `/v1/uhp`、`/v1/uhp/responses`(POST/GET/:id/cancel)，**无任何会话列举端点** → 能力声明与端点面不匹配（诚实边界问题）。

**证据（真机）**

```
s1: POST /v1/uhp/responses {model:"harness/qa-a2-auto", input:"第一轮：请记住代号 ALPHA-7"}
    → session_id = uhpsess_mvg6f267if4jrwyo
s2: POST /v1/uhp/responses {..., previous_response_id:"resp_mvg6f267if4kekbu", input:"第二轮：代号？"}
    → session_id = uhpsess_mvg6f2bzif4pqik7   （≠ s1）
    → previous_response_id = resp_mvg6f267if4kekbu（已回带，续接受理）

GET /v1/uhp → capabilities.session_listing = true，但无会话列举端点
```
断言记录：`C20 / C34b / C34c`。

**根因**

直调路径未复用上一响应的 `sessionId`；同时 `session_listing` 能力位按"Core 级含会话"直接置 true，未按实际端点面核账。

**修复建议**

1. `createResponse` 在给定 `previousResponseId` 且解析成功时，优先继承 `prev.sessionId`（而非重新生成），使 `session_id` 成为可靠的会话归组键。
2. 若确定本版不做会话列举，把 `capabilities.session_listing` 置 `false`（与 `files_input/files_output=false` 的诚实口径一致），并在 `manifest/api.yaml` 与发布说明 §七「未尽事项」中同步登记。

---

### A-5　SSE 端点两条拒绝路径状态码不统一（缺 token 401 / 非法 token 400）

| 项 | 内容 |
|---|---|
| **编号** | A-5 |
| **严重级** | **P2（一致性）** |
| **域** | A2A 任务事件流 |

**现象**

`GET /v1/a2a/tasks/:taskId/events` 两条拒绝路径返回不同状态码：完全缺 `?token=` 走显式 `fail(401, UNAUTHORIZED)`；`?token=<格式非法>` 落到 `catch` 分支 `fail(400, BAD_REQUEST)`。二者都是 fail-closed（均拒绝），但对客户端的状态码契约不统一。

**证据（静态）**　`packages/plugin-a2a/src/index.ts:1160-1181`

```ts
if (!token) { exchange.fail(401, 'UNAUTHORIZED', t('缺少 token 参数（SSE 端点自校验，fail-closed）')); return }
try { const verified = ctx.authn.verify(token); ... }
catch (error) { exchange.fail(error instanceof NotFoundError ? 404 : 400, 'BAD_REQUEST', ...) }   // ← 校验失败落到 400
```

**证据（真机）**

```
GET /v1/a2a/tasks/<taskId>/events                        → 401 {"code":"UNAUTHORIZED","message":"缺少 token 参数…"}
GET /v1/a2a/tasks/<taskId>/events?token=not-a-real-token  → 400 {"code":"BAD_REQUEST","message":"令牌格式不合法"}
GET /v1/a2a/tasks/<taskId>/events?token=<合法凭证>        → 200 text/event-stream（含 task.snapshot + task.terminal 回放）
```
断言记录：`B22 / B23 / B24`。

**根因**　`authn.verify` 的抛错未按语义分流（凭证无效 → 401，任务不存在 → 404），笼统落到 400。

**修复建议**　在 catch 中按错误语义分流——凭证解析/校验失败映射 401 `UNAUTHORIZED`（或 `TOKEN_INVALID`），仅参数解析类错误保留 400 `BAD_REQUEST`，使 SSE 面与 `/api` 域的鉴权状态码口径一致。

---

## 五、通过项摘要

### P-1　前端→后端路由对账：本批次零缺陷

- `packages/plugin-console/public/js/pages/a2a.js` 的 **7 个 API 调用 7/7 精确命中**后端注册行，方法与动态段形状全部匹配：

| 前端调用 | 位置 | 后端注册 | 位置 |
|---|---|---|---|
| `GET /api/a2a/directory` | a2a.js:123, :225 | `gate.guarded('GET','/api/a2a/directory','a2a.directory.read')` | plugin-a2a/src/index.ts:1081 |
| `GET /api/a2a/tasks` | a2a.js:239 | `guarded('GET','/api/a2a/tasks','a2a.directory.read')` | :1184 |
| `GET /api/a2a/tasks/${id}` | a2a.js:280 | `guarded('GET','/api/a2a/tasks/:taskId',…)` | :1192 |
| `POST /api/a2a/tasks/${id}/acceptance` | a2a.js:357 | `guarded('POST','/api/a2a/tasks/:taskId/acceptance','a2a.task.accept')` | :1200 |
| `GET /api/a2a/fulfillment` | a2a.js:376 | `guarded('GET','/api/a2a/fulfillment',…)` | :1215 |
| `GET /api/a2a/patrols?limit=5` | a2a.js:379 | `guarded('GET','/api/a2a/patrols',…)` | :1250 |

- 全量 374 个前端调用点 vs 458 条后端注册路由：**方法错配 0 条**；`a2a.js` 全部 import（`h,$ ,$$,esc,toast,openDrawer,openModal,renderTable,fmtNum,fmtPct,timeAgo,emptyState,maybeShowConceptCard` + `chipRow,emptyHint`）均可解析到真实导出；`renderTable` 的 `onRowClick(rowKey, row)` 调用约定与 `a2a.js:261` 的 `(taskId) => openTaskDrawer(taskId, refresh)` 一致。
- 无孤儿页面：`#/a2a` 已在 `app.js:54 / :90 / :193` 完成懒加载、导航项（`perm: 'a2a.directory.read'`）与路由注册三处挂载。

### P-2　Agent Card 签名：真机独立验签通过

- `GET /.well-known/agent-card.json`（平台目录卡）匿名 200，含 `signingKeys[0] = {keyId:"a2a-card-key-1", algorithm:"Ed25519", publicKeyBase64:"MCowBQYDK2VwAyEA…"}`；`agents[]` 6 条逐条含 `slug/name/autonomy/runtime/cardUrl`，`cardUrl` 形状精确为 `/.well-known/agents/:slug/agent-card.json`（**零宽字符 hack 已正确剥离**，`:300`）。
- `GET /.well-known/agents/qa-a2-auto/agent-card.json` 匿名 200，`signatures[0].protected` 解出 `{"alg":"EdDSA","typ":"JWT","kid":"a2a-card-key-1"}`。
- **用目录卡返回的 `publicKeyBase64` 独立复算验签：`Ed25519 detached-JWS 验签 = true`**（`node:crypto.verify(null, protected + "." + base64url(JSON.stringify(body)), publicKey, signature)`，keyType=ed25519）。
- governance 扩展 `urn:ybk:ext:governance:v1` 齐备且四键 ASCII：`autonomy:"A2"` / `runtime:"dsh"` / `dataClassCeiling:"internal"` / `meteringSubject:"agent:agt_…"`，值域合法。
- 目录卡与 `/api/a2a/directory` 的 `autonomy/runtime` **6/6 逐条一致**；单员工卡与目录亦一致。
- 不存在 slug → 404 且文案统一「数字员工不存在或未上线：xxx」，不泄露存在性。

### P-3　静态扫描的 9 条「未匹配」经人工复核全部为扫描器假阳性

`POST /api/agents/:id/sso-client/{enable|disable}`（`plugin-console/src/routes/entry-tickets.ts:256` 模板字面量注册）、`POST /api/apps/:id/sso-client/{…}`（`routes/apps.ts:280`）、`POST /api/authn/oidc/clients/:id/{…}`（`routes/authn.ts:197`）、`POST /api/iam/users/:id/{action}`（`routes/iam.ts:210`）——9/9 均在 `for (const [action] of …)` 循环内以 `` `/…/${action}` `` 模板注册，**后端路由真实存在**，扫描器字面量匹配无法覆盖。结论：本次变更（a2a.js / plugin-a2a / plugin-uhp）**未引入任何前端调用后端不存在的路径**。

### P-4　冻结契约关键点逐条兑现

| 契约点（出处） | 实测结果 |
|---|---|
| JSON-RPC 五方法面（`docs/contract-c3-…-v2-release-notes.md` §四） | `message/send`、`message/stream`、`tasks/get`、`tasks/list`、`tasks/cancel` 全部可调用 ✅ |
| 未知方法返回 -32601 | `{"code":-32601,"message":"未知 A2A 方法：tasks/frobnicate（支持 message/send·stream、tasks/get·list·cancel）"}`，HTTP 200 信封 ✅ |
| `autonomy`/`runtime` 必随响应透出（v1 冻结点） | `taskView` 含 `callerAutonomy`/`targetAutonomy`；v1 端点 `/a2a/invoke` 回归通过 ✅ |
| 未匹配 `/api` 路由匿名统一 401 | `/api/a2a/no-such-endpoint-xyz` 匿名 → 401 `UNAUTHORIZED`（带令牌才 404） ✅ |
| 幂等键分层 | UHP 侧 `a2a:<agentId>:<principal>:<taskId>:a<attempt>`（经 `/api/uhp/responses` 关联 taskId 验证）；usage 计量侧 `a2a:<agentId>:<principal>:<taskId>`（无 attempt 后缀） ✅ |
| 计量 `contextId` 归集 | `usage_events.context_id` 列已落库；`GET /api/usage/collaborations?context=<id>` 可查回，事件 `contextId` 与任务一致 ✅ |
| 零价快照 | 协作链事件 `charge_cents = 0` ✅ |
| 治理拒绝 -32002 族 | `DATA_CLASS_EXCEEDED`、`NEGOTIATION_REJECTED` 真机复现 ✅ |
| 协商矩阵（A0-A3，`negotiate.ts:31-46`） | A2×A0 → NEGOTIATION_REJECTED；A3×A0 → 拒绝；均与矩阵表一致 ✅ |
| 八态状态机 + `auth_required` 挂审批 | 敏感词规则命中 → `auth_required` + 审批工单；`tasks/cancel` → `canceled` ✅ |
| 验收护栏（不轻信自报） | 非 completed 任务验收被拒（400）；理由空白被拒（400）；机器凭证验收 403；人类验收回写 `acceptance` 并回写履约视图 ✅ |
| RBAC 越权探针 | member 对 5 个 `a2a.directory.read` 路由 + `a2a.task.accept` + `a2a.admin`(rules/patrol) 全部 403；`a2aadmin` 巡检可跑 ✅ |
| UHP 能力发现诚实边界 | `uhp_version=2026-08-11`、`conformance_class=core`、`files_input/files_output=false`、`harness_management=false` ✅ |
| UHP 越权原语封堵 | 请求级 `tools` 被接受但不生效，`metadata.ignored_fields = ["tools"]` 留痕 ✅ |
| UHP 幂等重放 | 同 `Idempotency-Key` 重放返回同一 `response.id`，且 `/api/uhp/responses` 中同键仅落 1 条 ✅ |
| 跨 harness 会话续接封堵 | `previous_response_id` 指向其他执行体 → 拒绝 ✅ |
| UHP SSE | `stream=true` → `text/event-stream`，`response.created` → `output_text.delta` → `response.completed` ✅ |
| 协议键 ASCII 纪律 | 15 个对外响应面 / **734 个键**扫描，**零中文键泄漏**；八态 / mode / dataClass / history.from / UHP status / ybk_* metadata 全部 ASCII 枚举 ✅ |
| manifest 声明完备性 | `plugin-a2a/manifest/api.yaml` 12 个端点、`plugin-uhp/manifest/api.yaml` 7 个端点全部与实现一致 ✅ |

### P-5　孤儿后端路由盘点（设计缺口，不计缺陷）

本批次 15 条新增后端路由中，**10 条在 console 前端无任何调用方**（无 UI 入口，仅 API/CLI 可达）：

- `GET|POST /api/a2a/rules`、`DELETE /api/a2a/rules/:id`（敏感操作审批规则管理无 UI）
- `POST /api/a2a/patrol/run`（手动巡检无 UI 触发点，仅 60 分钟例行）
- `GET|POST /api/uhp/harnesses`、`PATCH|DELETE /api/uhp/harnesses/:id`、`GET /api/uhp/responses`（**console 完全无 UHP 页面/导航项**）
- `GET /api/usage/collaborations`（`docs/a2a-uhp-implementation.md:14` 声称 console 侧新增"协作链计量查询路由"，但无任何前端消费方；`plugin-console/manifest/api.yaml` 已登记）

说明：A2A 页面定位为"治理只读视图 + 人工验收"（`pages/a2a.js:6` 注释明确），规则/UHP 管理面无 UI 属**设计如此**；但 `/api/usage/collaborations` 与 console manifest 的登记暗示原计划有 UI，建议在发布说明中如实登记为"本版只交付后端查询面，前端入口留待下批"。

---

## 六、风险与遗留

### 上线前必须处理

1. **A-1（P0）**：`tasks/cancel` 越权。建议在 `plugin-a2a` 修复后，将"非发起方取消他人任务"加入 `scripts/selftest.mjs` 的 A2A 分节断言与 RBAC 越权探针矩阵，防止回归。
2. **A-2（P1）**：UHP 发现面→调用面往返断裂。若采纳方案 A，需同步修正 `scripts/selftest.mjs:2944` 的 `model: 'harness/collab-target'` 断言——当前 selftest 把实现细节当契约，无法捕获该类违背。

### 建议本批内一并处理（成本极低）

3. **A-3（P2）**：总表第三节补 5 条治理码 + 扩展完备性清点命令（影响后续所有批次的协议键完备性判定）。
4. **A-5（P2）**：SSE catch 分支按语义分流 401/404/400（约 5 行改动）。
5. **A-4（P2）**：至少把 `capabilities.session_listing` 与实际端点面对齐（`true` → `false`），或在发布说明 §七登记。

### 测试覆盖遗留

6. **A3×A3 协商要约/还价/3 轮超限**未在本组实测（依赖模型 stub 输出 `{"decision":"accept|counter"}` JSON，当前 stub 返回固定文案，落在 `parseNegotiationDecision` 的宽松兜底分支 → 一律按 counter 处理）。该项属模型行为面，建议由功能/模型组在具备可控 stub 的环境补测。
7. **`TARGET_FROZEN` / `BUDGET_EXCEEDED` 两条治理码未真机复现**（需先造出冻结员工或预算熔断态），仅做静态可达性确认（`index.ts:358, 378`）。
8. **`tasks/list` 的 `callerPrincipalId` 过滤分支**在现有 fixture 下不可达——`qa-caller-cc` 与 `qa-a3-cc` 两台机器凭证都持 `a2a.directory.read`，按 `index.ts:1141` 均走"治理视图不加过滤"分支；按路径走过滤逻辑需要一台**仅** `agent.a2a.invoke`（无 `a2a.directory.read`）的凭证，当前 fixture 未提供。建议补一台探针凭证。
9. **JWS 采用 detached-payload JSON 序列化**（`signatures[].protected` + `signatures[].signature`，非 compact 三段式）。验证方必须按**原始键序**重序列化 body 才能验签成功，任何 parse→re-stringify 的中间层都会导致验签失败。本仓内 `card.ts:77-89` 的 `verifyAgentCard` 正确，但对接外部 A2A 网关时是易踩的互操作坑，建议在协作方案 §5.2 补充说明，或改用标准 compact 序列化。
10. **`/api/usage/collaborations` Top 榜排序未定义**：同分协作链（同样 150 tokens）在 `limit` 截断时进出不定（实测 `limit=20` 挤掉新链、`limit=100` 命中）。建议在 SQL 中补 `ORDER BY … , lastAt DESC` 的确定性次排序，避免成本看板抖动。

---

*报告生成：2026-10-20｜组A 契约对齐｜证据脚本与原始输出见 `/tmp/qa/`*
