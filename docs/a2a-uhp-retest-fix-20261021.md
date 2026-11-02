# A2A/UHP 复测整改对账（QA 2026-10-21，P1×1 + P2×6）

- **被测批次**：`main` @ `479735c` + 未提交的 A2A/UHP 工作区变更
- **QA 结论**：149/160（93.1%），P0 已闭环，新增 P1×1（外部集成闭环断裂）、P2×6
- **本批处置**：7 项全部修复；selftest 由 1540 → **1553** 断言（新增 13 条针对性护栏），全绿
- **复跑证据**：五份 QA 复现脚本在本批修复后全部 `PASS`（见 §三）

---

## 一、逐项对账

### P1-01 · 外部 `refType=external` 凭证派活后读不到自己的任务

| 项 | 内容 |
|---|---|
| 现象 | `message/send` 成功 → 同一凭证 `tasks/get` `-32003`、`tasks/list` 空集、`tasks/cancel` 失败、SSE 403 |
| 根因 | `getTask()`/`listTasks()` 先做组织判定 `canSeeOrg()`；external 凭证既无 `userId` 也无 `refType=agent`，解析不出 orgId → 恒 `false`/空集。**归属判定排在其后，永远不可达**（Q-4 组织隔离引入的回归） |
| 修复 | 归属优先于组织收敛：`getTask` 先判 `callerPrincipalId === caller.principalId`，是则直接放行；非发起方再走组织子树 + 治理读判定。`listTasks` 同理按「本人任务 ∪ 组织可见任务」过滤 |
| 位置 | `packages/plugin-a2a/src/index.ts`（`getTask` / `listTasks`） |
| 护栏 | selftest「P1 护栏：外部凭证派活 / get / list / SSE / cancel」五条断言 |
| 复现脚本 | `repro/external-no-org.mjs` → 修复前 `FAIL`，修复后 `PASS`（`tasksListCount: 1`） |

> **为什么选「归属优先」而非「给 external 凭证登记组织」**：A2A 规范的核心场景就是「第三方
> 只凭卡片与机器凭证协作」，为它强加组织归属会把外部集成绑死在平台组织模型里；而「发起方
> 本人可见自己的任务」本就是既有语义（`taskView` 的 privileged 分支、`assertTaskOwner` 都以此为准）。
> 组织隔离的产品意图是**防止下级组织看到别人的任务**，不是**让发起人看不到自己的任务**。

### P2-01 · workforce permit 覆盖仍是空操作（上一批声称已修）

| 项 | 内容 |
|---|---|
| 现象 | 员工 active + 绑定到该 Agent + **零任用** → A2A 派单仍 `completed` |
| 根因 | `plugin-a2a` 的 `export const inject` 缺 `workforceIdentity`。cordis 的 Service 代理读未注入键会抛错，该异常被 `governanceCheck` 的 `try/catch` 吞掉并「按 legacy 放行」——permit 判定代码存在但永不可达 |
| 修复 | ① `inject` 补 `workforceIdentity`；② workforce 新增契约方法 `inspectAgent(agentId): AgentBindingState`（三段判定：未纳管 / 已纳管但 permit 失效 / permit 生效），取代原先对 `resolver.store.bindings` 内部结构的脆弱探测；③ 已纳管但失效 → `PERMIT_NOT_EFFECTIVE`（附 `EMPLOYEE_NOT_ACTIVE` / `NO_EFFECTIVE_APPOINTMENT` 细分原因） |
| 位置 | `packages/plugin-a2a/src/index.ts`（`governanceCheck` / `inject`）、`packages/plugin-workforce/src/{contract,identity-resolver}.ts` |
| 护栏 | selftest「受管态夹具 → PERMIT_NOT_EFFECTIVE」+「任用生效后放行（不是死锁）」 |
| 复现脚本 | `repro/permit-decisive.mjs` → 修复前 `FAIL（completed）`，修复后 `PASS` |

### P2-02 · `GET /v1/uhp` 仍包平台信封

- 修复：改为规范裸体（与 Agent Card well-known 同口径），`content-type: application/json` 直出
  `{ uhp_version, conformance_class, capabilities, harnesses }`。
- 同步：`cli/dshctl.mjs` 注释改为现状口径（`callLoose` 双兼容保留给旧实例升级窗口）；
  selftest 断言改为「裸体且无 `ok`/`data` 字段」。

### P2-03 · 外部直调 `stream=true` 的 SSE 永不闭合

| 项 | 内容 |
|---|---|
| 现象 | 执行实际 `completed`，SSE 只下发 `response.created` 后无后续帧（仅 15s 心跳） |
| 根因 | SSE 订阅 `a2a.task.progress`，而该事件**只对 `dispatchedByPlatform=true` 的记录发出**（P0 任务劫持闸门）；外部直调永远收不到 → 设计冲突 |
| 修复 | 新增记录级事件 **`uhp.response.progress`**（所有来源统一发出），SSE 改订阅它；`a2a.task.progress` 的闸门**保持不变**（P0 防御面不动）。另补「订阅后二次查终态」堵住 `createResponse → 订阅` 之间的完成竞态，SSE 收帧改幂等 `closeStream()` |
| 位置 | `packages/plugin-uhp/src/index.ts`（`emitProgress` / `POST /v1/uhp/responses` 流式分支） |
| 护栏 | selftest「UHP 外部直调 SSE 闭合（收到完成帧）」 |
| 复现脚本 | `repro/uhp-sse-direct.mjs` → 修复前 `eventsSeen=[response.created]`，修复后 `[response.created, output_text.delta, response.completed]` |

> **为什么不直接放开 `a2a.task.progress`**：那条事件驱动 A2A 八态状态机，放开等于给外部凭证
> 重新打开任务劫持路径（上一轮 P0）。新增事件只喂 SSE，不驱动任何状态机，因此不扩大攻击面。

### P2-04 · 顶层 `task_id` / `taskId` 注入静默忽略

- 修复：三条路径（`metadata.ybk_a2a_task_id` / 顶层 `task_id` / 顶层 `taskId`）统一
  `400 TASK_BINDING_FORBIDDEN` + `denyAudit` + 专项审计 `uhp.invoke.task_binding_denied`
  （审计 detail 带命中字段名与值，便于溯源探针来源）。
- 护栏：selftest 逐条断言三个变体均 400 且不建立绑定。

### P2-05 · a2a.js 三语各缺 7 条（93.5%，未达 95% 门禁）

- 补齐：`运行时`、`取消`、`删除`、`{n} ms`、`步数预算`、`UHP 执行记录`、`{n} 小时`
  （en-US / ja-JP），并顺带补齐 `approvals.js`（取消、审批通过）、`skills.js`（审批通过）、
  `iam/helpers.js`（用户名/口令模板）的存量缺口——现全部页面 **0 缺失**。
- **新增门禁**：`npm run lint:i18n`（`scripts/lint-i18n-coverage.mjs`）——
  ① **文件级**覆盖率 ≥95%（不允许「整体 99% 但新页面 60%」）；
  ② 模板占位符一致性（译文中 `{n}` 等插值名不得丢失/改名，否则翻译分支会静默吞变量）。
- 复查：30 个前端文件、缺失/不一致 0 处。

### P2-06 · a2a 页未接入 SSE 实时进度（Q-15 未修）

- 修复：任务抽屉优先建立任务 SSE（`/v1/a2a/tasks/:id/events`），消费 `task.snapshot` /
  `task.progress` / `task.terminal` 具名帧；无令牌（演示态）或建立失败自动降级 2s 轮询。
  关闭抽屉/终态/被顶掉时 `close()` 连接（防泄漏）。
- 基础设施：`realtime.js` 新增 `eventNames` 选项——EventSource 的 `onmessage` 只收**无命名**
  事件，具名事件必须 `addEventListener`；统一包装为 `{ event, ...data }`，与轮询响应同通道消费。
- **门禁补登**：`page-smoke.mjs` 新增 A2A 五 tab 用例（directory/tasks/fulfillment/rules/uhp），
  断言页头 + tab 结构 + 各 tab 核心区块真实渲染（31 → **36 用例，36/36 通过**）。
- 顺带修复：目录页运行时筛选项用 `new Option(...)`（浏览器专有全局），在 jsdom/SSR 下抛错 →
  改 `document.createElement('option')`。
- 顺带修复门禁自身的脆弱断言：`P04 AI 市场 skills` 此前断言 `.card`，但技能卡片实际类名是
  `.res-card`，`.card` 只来自热力图区块（依赖 usage 计量数据）——夹具有无计量数据会让该用例
  随机红绿。改断言 `.res-card`（这才是「市场卡片」的语义）。

---

## 二、架构纪律复核

| 纪律 | 本批是否改变 | 说明 |
|---|---|---|
| A2A ↔ UHP 只走 `ctx.platformBus` | 保持 | 新增 `uhp.response.progress` 仍走总线；无直连数据路径 |
| P0 任务绑定闸门（`dispatchedByPlatform`） | **未放宽** | 只新增独立事件，`a2a.task.progress` 仍只对平台派发记录发出 |
| 事件总线注入显式声明 | 强化 | `plugin-a2a.inject` 补 `workforceIdentity`；不再用「裸 ctx 结构化探测 + 吞异常」规避 inject 纪律（`runtimeCtx` 临时口径已删除） |
| 组织隔离 R11 | 保持 | 仅把「发起方本人」提升为归属短路，非发起方的组织过滤完全不变（隔离组织用例零回归） |
| 声明 ≤ 授权 | 保持 | Agent Card 技能投影逻辑未动 |

---

## 三、复跑证据（本批修复后，隔离实例 7346）

```text
repro/external-no-org.mjs   → PASS  dispatch=ok  tasksGet=visible  tasksListCount=1
repro/permit-decisive.mjs   → PASS  code=PERMIT_NOT_EFFECTIVE（fixture: employee 200 / binding 200 / appointments 0）
repro/uhp-sse-direct.mjs    → PASS  eventsSeen=[response.created, output_text.delta, response.completed]
repro/top-level-taskid.mjs  → PASS  metadata/topSnake/topCamel 均 400、bound=false
repro/state-machine-terminal.mjs → PASS  -32000「任务已终态（completed），不可取消」
curl /v1/uhp                → 裸体（顶层直接 uhp_version，无 ok/data 包裹）
```

全量门禁：

```text
npm run selftest         1553/1553 通过
npm run lint:manifests   0 红 / 11 警（8 豁免，均为既有）
npm run lint:boot-order  0 错误 / 49 提示（a2a→workforce、uhp→agent 依赖漂移已补录）
npm run lint:cjk         373 命中（合格）
npm run lint:i18n        30 文件 / 0 缺失（门槛 95%）
npm run test:contracts   rq-card 19/19
realtime.test.mjs        5/5（新增 eventNames 具名事件契约）
page-smoke               36/36（新增 A2A 五 tab；P04 断言改为 .res-card）
```

---

## 四、顺带修掉的测试基建缺陷（QA §6 第 5 条）

QA 两次踩中「selftest 固定端口被并行测试实例占用 → 假失败」。本批把 6 个子实例
（7313 基线口令 / 7316 workforce / 7318 灰度 / 7319 演示 / 7322 sqlite kill -9 / 7399 CORS 精确来源）
改为**内核分配空闲端口**（`freePort()`：listen(0) 取端口后立即释放）。
固定端口部署语义需要复现时可用 `SELFTEST_PIN_PORTS=1` 钉死。
验证：在另一个工作区的实例占用 7399 的情况下，本轮 selftest 仍 **1553/1553 全绿**。

---

## 五、给下一轮的诚实边界

1. **未做真实浏览器视觉验收**：SSE 接入用 jsdom + page-smoke 结构断言验证；真实 EventSource
   行为（断线重连、钉钉 webview 降级）依赖 `realtime.js` 既有单测（`realtime.test.mjs`）与
   代码审查，未做端到端浏览器录制。
2. **SSE 增量粒度**：内置 harness 单步执行，`output_text.delta` 仍是「完整输出单帧」——
   不是缺陷，是执行体能力的诚实边界（协议帧已就位，接多步 harness 时可直接细化）。
3. **permit 判定覆盖「绑定有效 + 任用生效」**，不校验任用授权范围是否覆盖目标 Agent 的
   工具面（那是受控调用 `invoke` 的职责，不在协作受理面重复判定）。
4. **`refType=external` 的组织语义**：本批按「发起方本人可见」解决，未引入 external 专属
   组织域；若产品后续要求「外部集成按客户组织隔离」，需在 principal 登记面新增组织归属字段
   （本次不预埋，避免半成品口径）。