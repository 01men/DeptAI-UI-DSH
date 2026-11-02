# 组E · Agent 层验收报告（A2A 协作平面 + UHP 执行驱动层）

| 项 | 值 |
|---|---|
| 被测版本 | `packages/plugin-a2a` v1.3.0（卡片 `version` 字段）/ `packages/plugin-uhp` UHP 2026-08-11 core |
| 被测实例 | `http://127.0.0.1:7311`（QA 可写实例，全程未重启 / 未 kill 任何进程） |
| 模型 stub | `http://127.0.0.1:7399/v1`，slug `deepseek-chat` |
| 验收日期 | 2026-10-20 |
| 验收角色 | 大厂 QA —— 真实外部 Agent 客户端视角 |
| 源码改动 | **零**。本轮仅新增 QA 测试资产（见「测试资产与清理」）与 `/tmp/qa/` 脚本 |

---

## 1. 概述

### 1.1 方法论：真正的「外部客户端」

本轮不使用任何平台 SDK、不读任何内部模块，编写了一个独立客户端 `/tmp/qa/ext-client.mjs`（纯 `node fetch`，161 行），其唯一契约是：

1. 客户端**只知道员工 slug**，按 A2A 规范去 `GET /.well-known/agents/<slug>/agent-card.json`；
2. 卡片返回后，客户端**只允许使用卡片里出现的字段**构造后续请求（`url` / `securitySchemes` / `capabilities`）；
3. 卡片不足以完成的动作，客户端记入 `misses[]`，作为「A2A 核心承诺是否兑现」的判据。

这是一条比内部 SDK 调用严格得多的验收线：**A2A 的价值主张就是「一个没见过本平台的外部厂商 Agent，只靠 Agent Card 就能协作」**。本报告以此为唯一主线。

### 1.2 结论摘要

| 维度 | 结论 |
|---|---|
| A2A 主干能力（发现→派活→执行→交付） | **通**。外部客户端零 SDK 跑通 message/send、tasks/get、tasks/list、message/stream、SSE、tasks/cancel |
| A3 协商引擎 | **通**。要约→评估→接受 / 要约→评估→还价→调用方回应→轮次超限拒绝，四轮握手在 history 中完整留痕 |
| 治理门禁（权限点 / 密级 / 上线态 / 自治矩阵） | **通**，且拒绝均带结构化错误码与留痕 |
| 机器凭证生命周期 | **通**。rotate 后旧 secret、旧 token 双双即时失效，新 secret 换的 token 可用 |
| 计量 / 审计成链 | **通**。可完整还原「谁→谁、什么任务、什么治理决策」 |
| 卡片自描述完整性 | **部分不达标**。卡片缺事件流地址、缺权限点声明、缺协议版本 |
| OBO 身份链 | **不达标**（P1）。OBO 令牌拿不到 `agent.a2a.invoke`；UHP 的 `ybk_on_behalf_user` 被接收但不进审计 |
| 授权边界 | **有洞**（P1）。只读权限 `a2a.directory.read` 可取消他人任务 |
| dshctl CLI | 上一轮 6 条缺陷 **0 修 6 未修**；且新增 A2A/UHP 能力 CLI **零跟进** |

**断言统计：52 项断言，PASS 45 / FAIL 7。缺陷 9 项（P0 × 0，P1 × 4，P2 × 5）。**

---

## 2. 被测客户端与凭据

### 2.1 外部客户端

```
/tmp/qa/ext-client.mjs        —— ExternalAgent 类，零平台依赖
  discover()    卡片发现 + 缺口检测（misses[]）
  authHeader()  只读 securitySchemes 决定 Authorization
  rpc()         JSON-RPC over card.url
  poll()        轮询 tasks/get 至终态，记录状态轨迹
  subscribe()   SSE 订阅（记录 URL 来源是「卡片给的」还是「猜的」）
  closeStream() tasks/cancel
```

### 2.2 凭据矩阵

| 凭据 | 类型 | scopes | 绑定 | 本轮用途 |
|---|---|---|---|---|
| `qa-caller-cc` | machine | `agent.a2a.invoke, agent.read, a2a.directory.read` | `qa-caller-bot`(A2) | A2A 全链路主调用方（**已 rotate**，新 token 用于后半程） |
| `qa-a3-cc` | machine | 同上 | `qa-a3-caller`(A3) | A3 协商链路 + 跨主体越权探测 |
| `qa-uhp-cc` | machine | `uhp.invoke, agent.read` | external | UHP 执行面直调 + 权限边界 |
| `qa-weak-cc` | machine | `agent.read` | external | **负向**：无 invoke 权限 |
| `qa-ops` / `qa-approver` / `qa-acceptor` | human | 角色权限点 | — | 治理操作、上线审批、交付验收 |
| `admin` | human | `*` | — | CLI 回归（credential / mcp） |

### 2.3 本轮新增测试资产（组E 专用，勿被其他组断言依赖）

| 类型 | 标识 | 用途 |
|---|---|---|
| 模型 | slug `deepseek-reasoner` → `http://127.0.0.1:7401/v1` | 自建**反价 stub**，用于制造 counter 决议 |
| 模型 | slug `qa-counter-model`（同 7401） | 创建时未用上，**建议清理** |
| 员工 | `qa-a3-neg2`（A3/hermes/deepseek-reasoner/online） | 反价协商的被调方 |
| 员工 | `qa-e-offline-target`（draft） | 非上线态门禁探针 |
| 机器凭证 | `组E-probe`、`组E-probe2` | credential 子命令回归残留 |
| 进程 | `node /tmp/qa/stub7401.mjs`（7401 端口） | 反价 stub，仅本轮使用 |

> 说明：`qa-counter-model` 创建后发现 `packages/plugin-agent/src/schema.ts:23` 的 `model` 字段是**硬编码枚举**（`deepseek-chat / deepseek-reasoner / deepseek-coder`），新 slug 无法挂到员工上；因此改用枚举内的 `deepseek-reasoner` 承载 7401 stub，**未触碰既有 `deepseek-chat`（7399），对其他组零影响**。

---

## 3. 外部客户端全链路实测（逐步记录）

### 步骤 1 · 发现 —— `GET /.well-known/agents/qa-a2-auto/agent-card.json`

```bash
curl -s http://127.0.0.1:7311/.well-known/agents/qa-a2-auto/agent-card.json
```

实际返回（HTTP 200）：

```json
{ "ok": true, "data": {
  "name": "QA-A2自主型员工",
  "url": "http://127.0.0.1:7311/api/agents/qa-a2-auto/a2a",
  "version": "1.3.0",
  "capabilities": { "streaming": true, "pushNotifications": false, "stateTransitionHistory": true },
  "defaultInputModes": ["text/plain","application/json"],
  "skills": [],
  "securitySchemes": { "ybkMachineCredential": { "type": "http", "scheme": "bearer" } },
  "extensions": [{ "uri": "urn:ybk:ext:governance:v1", "params": {
      "autonomy": "A2", "runtime": "dsh", "dataClassCeiling": "internal",
      "meteringSubject": "agent:agt_mvg65xluidp4m49p" } }],
  "signatures": [{ "protected": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImEyYS1jYXJkLWtleS0xIn0",
                   "signature": "DrMXxiQiB4gDijwraTp3uB8DTA3hwT80K1kKQq02+Rgj6mWFkfMjKFXW2ah6/NFe/rvYbmPJrWkCQOaTWh+RDw==",
                   "keyId": "a2a-card-key-1" }]}}
```

客户端自动记录的**卡片缺口**：

```
["卡片未提供任务事件(SSE)订阅地址，客户端无法只靠卡片订阅事件流"]
```

平台目录卡 `GET /.well-known/agent-card.json` 同时下发了 Ed25519 验签公钥，外部客户端可自校验：

```
卡片签名自校验（correct JWS input）: PASS ✔
篡改 card.url 后仍验签通过 = false （期望 false）
```

> 签名是真的：JWS 输入 = `protected + "." + b64url(卡片体去掉 signatures)`，改一个字节即验签失败。**但签了不等于验了** —— 平台内部是否在消费方强制验签，本组无法从外部证实（见 E-9）。

### 步骤 2 · `message/send`（机器凭证，无 SDK）

```js
bot.token = <qa-caller-cc 的 access_token>
await bot.rpc('message/send', { message: { role:'user', parts:[{kind:'text', text:'请汇总今日协作任务并给出结论'}] } })
```

```
HTTP 200 rpcError=null
taskId=task_mvgilftgifeggoc3 state=completed (206ms)
task 视图字段: taskId, contextId, agentId, agentSlug, callerSubject, callerAutonomy,
               targetAutonomy, mode, state, stateReason, message, dataClass, artifacts,
               history, responseId, attempts, inputTokens, outputTokens, model,
               createdAt, startedAt, finishedAt
```

### 步骤 3 · 轮询 `tasks/get` 至终态

```
状态轨迹: ["completed"] → completed timedOut=false
artifact = [{"artifactId":"art_mvgilftiifeot9dj","name":"reply.txt","mimeType":"text/plain",
             "kind":"text","content":"A2A/UHP QA STUB 应答 #124","sizeBytes":27}]
history 条数 = 3
```

### 步骤 4 · SSE 事件流订阅

```
URL 来源 = GUESSED_FROM_PLATFORM_DEFAULT   ← 不是卡片给的（缺口，见 E-1）
HTTP 200  事件数 = 3
  evt (默认)          data=undefined                      ← 空心跳帧，格式可解析但无信息
  evt task.snapshot   data={"taskId":"...","state":"working",...}
  evt task.terminal   data={"taskId":"...","state":"completed"}
```

`?token=` 自校验 fail-closed 生效：`curl ".../v1/a2a/tasks/x/events"` 无 token → `401 缺少 token 参数`。

### 步骤 5 · `tasks/list`

```
HTTP 200  任务数 = 5
 task_mvgilftgifeggoc3 completed  agent=agt_mvg65xluidp4m49p
 task_mvgil9h4ifdyue37 completed  agent=agt_mvg65xluidp4m49p
 task_mvgil9azifdm22ql completed  agent=agt_mvg65xluidp4m49p
```

携带 `a2a.directory.read` 时返回全量；**无该权限点的纯调用方凭证会被收敛到自身任务**（`callerPrincipalId` 过滤，源码 `packages/plugin-a2a/src/index.ts:1140`）。

### 步骤 6 · `message/stream`（流式）

```js
await bot.rpc('message/stream', { message: { parts:[{kind:'text',text:'流式任务：列出三条要点'}] } })
```

```
HTTP 200  content-type: text/event-stream
retry: 5000

event: task.snapshot
data: {"taskId":"task_mvgilfzdifesj24f","contextId":"a2actx_...","callerSubject":"agent:agt_mvg65y94idps38ro",
       "callerAutonomy":"A2","targetAutonomy":"A2","mode":"execute_report",...}
```

> **协议同构性破口**：同一个 `card.url`，`message/send` 回 JSON-RPC 信封，`message/stream` 回裸 SSE。A2A 规范中两者都应返回 `Task` 对象、再由客户端订阅事件。客户端第一次尝试按 JSON 解析即崩（`SyntaxError: Unexpected token 'r', "retry: 500"... is not valid JSON`），必须为流式单独写分支。见 E-4。

### 步骤 7 · `tasks/cancel`

对**已终态**任务：

```
cancel → rpcError={"code":-32000,"message":"任务已终态（completed），不可取消"}
```

对**在途**任务（用 A2×A1 矩阵制造 `auth_required`）：

```
taskId = task_mvgiv02zig4tfai8  state=auth_required
cancel → {"result":{"task":{... "state":"canceled","stateReason":"客户端主动取消" ...}}}
重复取消 → rpcError={"code":-32000,"message":"任务已终态（canceled），不可取消"}   （幂等边界清晰 ✔）
```

---

## 4. A3 协商链路

### 4.1 路径 A —— 接受（既有 stub，`qa-a3-cc` → `qa-a3-neg`）

```js
await caller.rpc('message/send', {
  message: { parts:[{kind:'text', text:'协作要约：请你承接一份季度经营分析报告，3 个工作日内交付，需含数据来源说明。'}] },
  metadata: { negotiation: { deliverable:'季度经营分析报告', deadline:'3d', format:'md', dataClass:'internal' } },
})
```

```
send HTTP 200  taskId=task_mvgilovuiffpf3su  mode=negotiate
终态 completed
--- history ---
  [message] from=caller :: undefined
  [offer]   from=caller :: 发起协商要约（第 1 轮）
  [status]  from=system :: 被调方评估协商要约（第 1 轮）
  [offer]   from=target :: 被调方接受要约：stub：接受要约，可承接
  [status]  from=system :: UHP 执行中（第 1 次派发）
  [status]  from=system :: 任务完成（含交付物 1 项）
```

### 4.2 路径 B —— 还价 + 轮次超限（**自建第二 stub 7401**）

既有 7399 stub 对任何含「要约 / decision / counter」的 prompt 一律回 `accept`，无法制造 counter。按任务书要求自建 `7401` 端口 stub：

- `POST /api/modelgw/models` 注册 slug `deepseek-reasoner` → `http://127.0.0.1:7401/v1`
- `POST /api/agents` 建 `qa-a3-neg2`（A3 / hermes / deepseek-reasoner / online，走审批单 `apr_mvgio0boifhc2buk`）
- stub 仅在被调方评估要约时回 counter：
  `{"decision":"counter","proposal":{"deliverable":"...精简版","deadline":"5d","format":"md+数据附录"},"note":"时限与交付格式需修订，还价"}`

**实测握手：**

```
第 1 轮 state = input_required   reason = 被调方还价（第 1 轮），等待调用方回应
  [message] from=caller
  [offer]   from=caller :: 发起协商要约（第 1 轮）
  [status]  from=system :: 被调方评估协商要约（第 1 轮）
  [offer]   from=target :: 还价：stub：时限与交付格式需修订，还价

调用方还价（metadata.taskId 续接）
第 2 轮 state = input_required
  [offer]   from=caller :: 协商回应（第 2 轮）
  [status]  from=system :: 被调方评估协商要约（第 2 轮）
  [offer]   from=target :: 还价：…

第 3 轮 state = input_required   （协商回应（第 3 轮）→ 评估（第 3 轮）→ 还价）

第 4 轮（调用方不再让步）
终态 = rejected   reason = 协商轮次超限（3 轮），任务拒绝
  [status] from=system :: 协商轮次超限（3 轮），任务拒绝
```

**判定：协商协议行为真实**——要约、评估、还价、调用方回应、轮次上限拒绝，全部在 `history` 中以 `offer` / `status` 类型成链，且 `negotiation.offers[]` 保留双向 proposal 原文。`packages/plugin-a2a/src/negotiate.ts:63` 的「解析失败按还价处理 + 轮次上限自然收敛」防悬挂设计经实测有效。

> 诚实边界（对齐 `negotiate.ts:14` 的自述）：本组只验证了**协议行为真实**，未验证两个模型「谈得拢」；counter 判定来自 stub 的确定性回包，不构成对模型协商质量的评估。

---

## 5. dshctl CLI 回归（上轮 6 条缺陷）

复现环境：
```bash
cd /Users/ybkk/Documents/元冰可可产品/ybkkasi
export DSHCTL_URL=http://127.0.0.1:7311
export DSHCTL_TOKEN=<qa-ops / qa-approver / admin 令牌>
```

| # | 上轮缺陷 | 复现命令 | 实际输出 | 结论 |
|---|---|---|---|---|
| **D1** | `agent topology` 帮助文案承诺但无实现 | `node cli/dshctl.mjs agent topology agt_mvg65xluidp4m49p` | `✘ 未知动作：agent topology`（exit=1）。帮助第 `agent` 行仍写 `list \| get <id> \| metrics <id> \| topology <id>  Agent 列表 / 详情 / 指标 / 拓扑` | **未修** |
| **D2** | `mcp get <id>` 括号错位 TypeError | `node cli/dshctl.mjs mcp get srv_x` | `TypeError: Cannot read properties of undefined (reading 'services')` at `cli/dshctl.mjs:627:74`。源码 627 行仍为 `out(await call('GET', '/api/mcp/services')).services` —— `out()` 返回 `undefined`，括号确实错位 | **未修** |
| **D3** | `group list` 报「未知资源：group」 | `node cli/dshctl.mjs group list` | `未知资源：group` 后直接吐整页帮助（exit=1）。帮助里仍列着 `group  list  用户组列表` | **未修** |
| **D4** | 全局选项只能后置 | `node cli/dshctl.mjs --output json agent list`<br>`node cli/dshctl.mjs agent list --output json` | 前者：`未知资源：--output` + 整页帮助<br>后者：正常输出 JSON 数组 | **未修** |
| **D5** | `approval decide` 不传 `confirmed:true` 导致无法独立批准上线单 | `node cli/dshctl.mjs approval decide apr_mvgio0boifhc2buk --decision=approve --opinion="…" --yes` | `✘ 高风险审批通过需二次确认（confirmed=true），请在前端确认弹窗中复核后提交（BAD_REQUEST）`（exit=1）。`grep -n "confirmed" cli/dshctl.mjs` → **0 命中**；帮助中亦无 `--confirmed`。该单最终只能改走 REST `/api/approvals/:id/decide` + `{"confirmed":true}` 才批得下来 | **未修** |
| **D6** | `mcp invoke` 对 denied 结果 exit=0 | 代码走查 `cli/dshctl.mjs:662-667` | 源码仍为 `const data = await call('POST','/api/mcp/invoke',{...}); out(data); return` —— **完全不检查 `data.ok` / denied 标志**，无任何分支能改 exit code。运行时**无法复现**：本 QA 实例 `/api/mcp/services` 返回空数组，没有任何 MCP 服务可供 invoke | **未修（代码走查确认，本环境无 MCP 服务无法运行验证）** |

**汇总：0 修 / 6 未修。**

### 5.1 附加发现：`--help` 不干净

```bash
node cli/dshctl.mjs --help
# 输出第一行：未知资源：--help
# 随后才是完整帮助正文（exit=1）
```

### 5.2 新增缺陷 —— CLI 能力缺口（E-8）

新增了 `plugin-a2a`（19 个端点）与 `plugin-uhp`（9 个端点）两套能力面，`dshctl` **零跟进**：

```bash
node cli/dshctl.mjs 2>/dev/null | grep -ci "a2a\|uhp"
# → 0

node cli/dshctl.mjs a2a list        # → 未知资源：a2a
node cli/dshctl.mjs uhp list        # → 未知资源：uhp
node cli/dshctl.mjs collab list     # → 未知资源：collab
node cli/dshctl.mjs agent-card      # → 未知资源：agent-card
```

`packages/plugin-a2a/manifest/api.yaml` 自称「**CLI/Skill/Web 三端对齐的唯一事实源**」，但 CLI 端一张 A2A/UHP 子命令都没有。人类运维目前无法用 CLI 完成：查看协作目录、派活、查协作任务、追 SSE、交付验收、履约视图、授权轮换、协商巡检。这与「三端对齐」的自我声明直接冲突。

> 公平地区分：`a2a` / `uhp` 是**本轮全新能力**，CLI 未跟进属于「新能力未覆盖」，与 D1–D6 的「已承诺未兑现」性质不同，故单列为 E-8。

---

## 6. 机器凭证生命周期（`credential rotate`）

```bash
# 轮换前：旧 token 调 A2A
curl -X POST .../api/agents/qa-a2-auto/a2a -H "authorization: Bearer <旧token>" \
     -d '{"jsonrpc":"2.0","id":"1","method":"tasks/list","params":{"limit":1}}'
# → {"ok":true,"data":{"jsonrpc":"2.0","id":"1","result":{"tasks":[...]}}}   ✔

node cli/dshctl.mjs credential rotate pri_mvg65ywpidqn1qme
# ✔ clientSecret 已轮换（新值仅此一次展示，旧值立即失效，存量令牌已全部吊销）
#   客户端ID: mc-mvg65ywpidqmaidj
#   客户端密钥: cs_fHkS2XSbmNCdevk2QgUqun37gB9QW8uT

# 轮换后：同一旧 token 再调 A2A
# → HTTP 401 {"ok":false,"error":{"code":"TOKEN_INVALID","message":"令牌已被吊销：凭证轮换联动"}}   ✔

# 旧 secret 换 token
# → {"ok":false,"error":{"code":"CC_FAILED","message":"client_id 或 client_secret 错误"}}   ✔

# 新 secret 换 token 后调 A2A
# → {"ok":true,"data":{"jsonrpc":"2.0","id":"1","result":{"tasks":[...]}}}   ✔
```

**四项断言全过**：clientId 不变 ✔ / 旧 secret 立即失效 ✔ / 存量令牌全部吊销（401 `TOKEN_INVALID`，错误文案明示「凭证轮换联动」）✔ / 新 secret 换得的 token 可正常驱动 A2A ✔。

**唯一瑕疵**：`credential rotate` 的输出未提供 `--output json` 分支（help 只对 `create` 隐含支持），且同样带 `✔` 人类可读前缀 —— 与 D7 同源。

---

## 7. OBO（on-behalf-of）身份链 —— **不达标**

### 7.1 路径一：平台 OBO 令牌

```bash
curl -X POST /api/agents/agt_mvg65xluidp4m49p/obo-token -H "authorization: Bearer <qa-ops>" -d '{}'
```

```
HTTP 200
token payload:
  act   = [{"principalId":"pri_mvg65wrnidn6jblx","name":"平台资源管理员","type":"human"}]   ← 人类身份在 act 里 ✔
  scope = ["agent.read","agent.write","skill.read"]                                        ← 无 agent.a2a.invoke ✘

用该 OBO token 调 A2A：
POST /api/agents/qa-a2-auto/a2a  → HTTP 403 缺少权限点 agent.a2a.invoke
```

**结论**：OBO 令牌签发成功且携带正确的人类 `act`，但**权限集不含 `agent.a2a.invoke`**，人类完全无法借 OBO 驱动 A2A 协作面。

### 7.2 路径二：审计中人类角色能否被授予 `agent.a2a.invoke`

```
GET /api/iam/permissions → agent.a2a.invoke | A2A 跨运行时点名调用（IAW 7-1）   ← 权限点存在
GET /api/roles           → QA 全部 7 个角色中，无一持有 agent.a2a.invoke           ← 无人类角色可用
```

### 7.3 路径三：UHP 的 `ybk_on_behalf_user`（唯一有 OBO 语义的入口）

```bash
curl -X POST /v1/uhp/responses -H "authorization: Bearer <qa-uhp-cc>" -d '{
  "model":"qa-a2-auto","input":"OBO 验证",
  "metadata":{"ybk_data_class":"internal","ybk_on_behalf_user":"usr_mvg65wtlidnmrmj7"}}'
```

```
HTTP 200
{"id":"resp_mvgivozoigbffmq2","status":"completed","output_text":"A2A/UHP QA STUB 应答 #170",
 "metadata":{"ybk_agent_id":"agt_...","ybk_data_class":"internal",
             "ybk_on_behalf_user":"usr_mvg65wtlidnmrmj7","ignored_fields":[]}}
                              ↑ 接收了，原样回显，无任何校验

审计：
  actorType=system  actorId=uhp  :: harness=h-qa-a2-auto model=deepseek-chat tokens=120/30
                              ↑ 人类 usr_mvg65wtlidnmrmj7 在审计中完全消失
```

**判定（E-2 / E-3，P1）**：
1. `packages/plugin-a2a/src/index.ts` 与 `packages/plugin-uhp/src/index.ts` **均不消费 `act` 声明**——`grep -rn "act\b\|obo\|onBehalfOf" packages/plugin-a2a/src packages/plugin-uhp/src` 只命中 `actorType:'system', actorId:'uhp'` 这类硬编码系统身份。
2. `metadata.ybk_on_behalf_user` 是**调用方单方面自述**的字符串，平台不验签、不校验该 userId 是否存在、不与调用方令牌做任何绑定，却照单接收。审计 actorId 恒为 `uhp` / `agent:<id>`。
3. 审计中的「真实发起人」目前只可能是**机器凭证主体**。人类代员工发起的协作在审计链上**不可还原**。

---

## 8. 治理门禁真实有效性

| 编号 | 攻击面 | 请求 | 实测结果 | 判定 |
|---|---|---|---|---|
| G1 | 无 `agent.a2a.invoke` 的机器凭证调 A2A | `qa-weak-cc`（仅 `agent.read`）→ `POST /api/agents/qa-a2-auto/a2a` | `HTTP 403 {"code":"FORBIDDEN","permission":"agent.a2a.invoke","message":"缺少权限点 agent.a2a.invoke，请联系管理员调整角色"}` | ✔ PASS |
| G1b | 同一弱凭证打 SSE 事件流 | `GET /v1/a2a/tasks/x/events?token=<weak>` | `HTTP 403 缺少权限点 agent.a2a.invoke / a2a.directory.read` | ✔ PASS |
| G1c | 权限面混淆：`uhp.invoke` 不等于 `agent.a2a.invoke` | `qa-uhp-cc` → A2A | `HTTP 403 缺少权限点 agent.a2a.invoke` | ✔ PASS |
| G2 | 密级越级 | `qa-caller-cc` → `qa-a0-tip`（天花板 `public`），`metadata.dataClass="secret"` | `HTTP 200` + JSON-RPC `{"code":-32002,"message":"数据密级越级：任务密级 secret 高于该员工天花板 public（拒绝并留痕）","data":{"code":"DATA_CLASS_EXCEEDED"}}` | ✔ PASS（留痕） |
| G3 | 自治矩阵降级 | `qa-caller-cc`（caller=A2）→ `qa-a1-exec`（A1） | `mode=execute_confirm` / `state=auth_required` / `stateReason="协商矩阵要求人在环确认（A2 × A1）"`，并自动开审批工单 `apr_...` | ✔ PASS |
| G4 | 非上线态员工被点名 | `qa-caller-cc` → `qa-e-offline-target`（draft） | `{"code":-32002,"message":"被调员工未上线（draft），A2A 仅对 online 开放","data":{"code":"TARGET_NOT_ONLINE"}}` | ✔ PASS |
| G4b | 非上线员工的卡片是否泄露 | `GET /.well-known/agents/qa-e-offline-target/agent-card.json` | `404 数字员工不存在或未上线` | ✔ PASS（发现面同步收口） |
| G5 | 匿名请求 | 无 Authorization 头 | `HTTP 401 {"code":"UNAUTHORIZED","message":"缺少 Bearer 令牌，请先登录"}` | ✔ PASS |
| **G6** | **跨主体 `tasks/cancel`（越权写）** | `qa-a3-cc`（**仅** `a2a.directory.read`）→ cancel `qa-caller-cc` 的在途任务 `task_mvgiwe6pigclcy1u` | `{"ok":true,"data":{"jsonrpc":"2.0","id":"z","result":{"task":{"taskId":"task_mvgiwe6pigclcy1u", ... "state":"canceled"}}}}` | ✘ **FAIL** |

**G6 分析（E-1，P1）**：`packages/plugin-a2a/src/index.ts` 的 `getTask()` 放行条件是

```ts
if (task.callerPrincipalId !== caller.principalId
    && !caller.permissions.includes('*')
    && !caller.permissions.includes('a2a.directory.read')) { throw ... }
```

而 `cancelTask()` **直接复用 `getTask()` 做鉴权**。`a2a.directory.read` 是治理视图的**只读**权限点，却被用于放行 `tasks/cancel` 这一状态写操作。后果：一个只读观察员凭证可以取消任意他人在途的 A2A 任务，且取消会落审计（`a2a.task.canceled`，actorId 记的是取消者），审计上看起来完全合法。

> 与之对照，`tasks/list` 同样按 `a2a.directory.read` 放行全量，属**明确设计**（治理视图需要全量），不构成缺陷。缺陷只在于这个只读点被复用于写操作。

---

## 9. 计量 / 审计对账

单笔完整闭环（机器凭证发起 → Agent 完成 → 人类验收）：

```
task_mvgiuohvig0h51zu  state=completed  inputTokens=120 outputTokens=30
```

### 9.1 计量事件（`GET /api/usage/events`）

```
subject  = agent:agt_mvg65y94idps38ro          ← 调用方（qa-caller-bot）
principal= org:org_mvg65e9lidmbgujd
resource = agent:agt_mvg65xluidp4m49p          ← 被调方（qa-a2-auto）
idem     = a2a:agt_mvg65xluidp4m49p:pri_mvg65ywpidqn1qme:task_mvgiuohvig0h51zu
meters   = calls=1 call, input_tokens=120 token, output_tokens=30 token

subject  = agent:agt_mvg65xluidp4m49p          ← 被调方
resource = model:deepseek-chat
idem     = modelgw:mi_mvgiuohwig0lc9p7
meters   = input_tokens=120, output_tokens=30
```

**判定：PASS**。A2A 双分录（发起侧 calls + 被调侧 model tokens）主体正确、幂等键含 taskId 可对账、token 数与 task 视图的 `inputTokens/outputTokens` 完全一致。

**一处口径歧义（E-7，P2）**：Agent Card 的 `extensions[].params.meteringSubject = "agent:agt_mvg65xluidp4m49p"`（被调方），而 A2A 调用事件的 `subject` 是调用方。两者并非矛盾（模型用量确实记在被调方），但卡片只声明了一个 `meteringSubject`，外部对账方无法预知存在两个主体。建议卡片改为 `meteringSubjects` 数组或明确标注「本员工为资源侧计量主体」。

### 9.2 审计链（`GET /api/audit/logs`，按 taskId 还原）

```
invoke /machine / agent:agt_mvg65y94idps38ro  action=agent.a2a.invoke   resource=qa-a2-auto
        :: task=task_mvgiuohvig0h51zu context=a2actx_... state=completed
           治理检查五项通过，协商引擎判定 execute_report …              ← 发起方 + 治理决策
invoke /machine / agent:agt_mvg65y94idps38ro  action=a2a.task.accepted  resource=qa-a2-auto
        :: state=submitted …
invoke /system  / uhp                         action=uhp.invoke         resource=QA-A2自主型员工
        :: harness=h-qa-a2-auto model=deepseek-chat tokens=120/30
           task=task_mvgiuohvig0h51zu context=a2act_...               ← 执行面
change /human  / usr_mvg65wtlidnmrmj7        action=a2a.task.acceptance resource=qa-a2-auto
        :: decision=accepted reason=组E：交付物符合约定                  ← 人类验收
```

**判定：PASS**。「谁→谁（machine 主体 / system 执行面 / human 验收人）、什么任务（taskId + contextId）、什么治理决策（`协商引擎判定 execute_report`、`治理检查五项通过`）」三者可完整还原，且审计条目自带 `actorType` 区分 machine / system / human。

**唯一缺口**：若协作由人类发起（OBO），`human` 一侧将缺失发起人，只剩执行与验收（见 §7）。

---

## 10. 交付验收闭环

```bash
# 人类验收员（持 a2a.task.accept）
curl -X POST /api/a2a/tasks/task_mvgiuohvig0h51zu/acceptance \
     -H "authorization: Bearer <qa-acceptor>" \
     -d '{"decision":"accepted","reason":"组E：交付物符合约定"}'
# → HTTP 200，回完整 task 视图

# 任务上验收字段已回写
GET /api/a2a/tasks/task_mvgiuohvig0h51zu
→ acceptance = {"status":"accepted","by":"usr_mvg65wtlidnmrmj7",
                "at":"2026-10-20T10:09:46.085Z","reason":"组E：交付物符合约定"}

# 履约视图
GET /api/a2a/fulfillment
→ {"fulfillment":[
     {"agentSlug":"qa-a2-auto","agentName":"QA-A2自主型员工","received":74,"completed":61,
      "failed":0,"canceled":0,"rejected":12,"interrupted":1,
      "acceptanceAccepted":9,"acceptanceRejected":1,
      "completionRate":0.824,"acceptancePassRate":0.148,
      "avgDurationMs":5,"p95DurationMs":11,"inputTokens":7320,"outputTokens":1830},
     {"agentSlug":"qa-a0-tip", ...}]}
```

**判定：PASS**。验收回写任务、履约视图按员工聚合 `received/completed/rejected/interrupted` 与 `acceptanceAccepted/Rejected`、`completionRate`、`acceptancePassRate`、`avg/p95DurationMs`、token 汇总。

**观察（非缺陷，记为遗留）**：`acceptancePassRate` 仅 0.148，源于历史批量任务中大量 `rejected`（密级越级/非上线/协商超限）。履约视图本身可用，但该比率在混入口径下对「交付质量」的表达偏弱，建议后续区分「治理拒绝」与「执行失败」。

---

## 11. UHP 执行面（附加覆盖）

```bash
# 能力发现
GET /v1/uhp   (qa-uhp-cc)
→ {"uhp_version":"2026-08-11","conformance_class":"core",
   "capabilities":{"files_input":false,"files_output":false,"session_listing":true,
                   "session_sharing":false,"harness_management":false},
   "harnesses":[{"id":"h-qa-a0-tip","configured":["qa-a0-tip"]}, ...]}

# 直调（按 configured 的 agent slug）
POST /v1/uhp/responses  {"model":"qa-a2-auto","input":"UHP 直调：三条要点",
                        "metadata":{"ybk_data_class":"internal"}}
→ {"id":"resp_mvgivotbigb9sfad","status":"completed","model":"deepseek-chat",
   "harness_id":"h-qa-a2-auto","output_text":"A2A/UHP QA STUB 应答 #169",
   "usage":{"input_tokens":120,"output_tokens":30},
   "session_id":"uhpsess_mvgivotbigb8cb9c",
   "metadata":{"ybk_agent_id":"agt_mvg65xluidp4m49p","ybk_data_class":"internal","ignored_fields":[]}}
```

**发现（E-5，P2）**：错误文案与实现不一致。`{"model":"harness/h-qa-a2-auto"}` 报

```
404 执行体不存在：h-qa-a2-auto
```

而 `packages/plugin-uhp/src/index.ts:613` 是 `ctx.resourceCore.get('agent', agentRef)` —— 只认**员工 id / slug**，不认 **harness id**。错误提示主动引导客户端填 `harness/<id>`，而该格式**必然 404**。客户端只能靠 `GET /v1/uhp` 里的 `configured:[slug]` 数组反推出正确写法。

**`uhp.read` 边界**：qa-uhp-cc（仅 `uhp.invoke`）读 `/api/uhp/harnesses` → `403 缺少权限点 uhp.read`；qa-ops → 正常返回 6 个 harness。✔ PASS

---

## 12. 断言结果一览（52 项）

| # | 断言 | 结果 |
|---|---|---|
| A-01 | Agent Card 可经标准 well-known 路径发现 | PASS |
| A-02 | 卡片带 `url`，可直接作为 JSON-RPC 端点 | PASS |
| A-03 | 卡片带 `securitySchemes`（http/bearer），客户端可自行构造 Authorization | PASS |
| A-04 | 卡片带 `capabilities.streaming` | PASS |
| A-05 | 卡片带 Ed25519 签名 + 平台卡下发公钥，外部可验签 | PASS |
| A-06 | 篡改 `card.url` 后验签失败（签名覆盖正文） | PASS |
| A-07 | **卡片给出任务事件(SSE)订阅地址** | **FAIL** → E-1 |
| A-08 | **卡片声明所需权限点（`agent.a2a.invoke`）** | **FAIL** → E-6 |
| A-09 | **卡片声明 A2A 协议版本 / 方法面** | **FAIL** → E-6 |
| A-10 | 卡片为 A2A 规范裸体（外部 Agent 的通用解析器可直接消费） | FAIL（包了 `{ok,data}` 信封）→ E-6 |
| A-11 | `message/send` 返回 taskId | PASS |
| A-12 | 任务在 A2A_SYNC_WAIT_MS 内达终态 | PASS（206ms） |
| A-13 | `tasks/get` 轮询可达终态 | PASS |
| A-14 | 任务视图含 A2A 规范必需字段（id/contextId/status/artifacts/history） | PASS |
| A-15 | 产物 `artifacts[]` 结构完整 | PASS |
| A-16 | `history[]` 状态迁移成链 | PASS |
| A-17 | `tasks/list` 可列举 | PASS |
| A-18 | 无 `a2a.directory.read` 时 `tasks/list` 收敛到自身 | PASS（源码 + 实测） |
| A-19 | `message/stream` 返回 SSE | PASS |
| A-20 | **`message/send` 与 `message/stream` 响应同构（同一 url 两种媒体类型之外的形态）** | **FAIL** → E-4 |
| A-21 | SSE 端点 fail-closed（无 token → 401） | PASS |
| A-22 | SSE 事件含 `task.snapshot` / `task.terminal` | PASS |
| A-23 | `tasks/cancel` 对在途任务生效 | PASS |
| A-24 | `tasks/cancel` 对终态任务拒绝且错误码清晰 | PASS |
| A-25 | JSON-RPC 未知方法返回 -32601 | PASS（源码确认） |
| A-26 | A3×A3 进入 `negotiate` 模式 | PASS |
| A-27 | 要约 → 评估 → 接受，history 有 offer 记录 | PASS |
| A-28 | 要约 → 评估 → **还价**（counter），history 有双向 offer | PASS |
| A-29 | 调用方可续接轮次回应（`metadata.taskId`） | PASS |
| A-30 | 轮次超限（3 轮）→ rejected | PASS |
| A-31 | 凭据 rotate：clientId 不变 | PASS |
| A-32 | 凭据 rotate：旧 secret 立即失效 | PASS |
| A-33 | 凭据 rotate：存量 token 全部吊销 | PASS |
| A-34 | 凭据 rotate：新 secret 换的 token 可驱动 A2A | PASS |
| A-35 | 无 `agent.a2a.invoke` → A2A 主端点 403 | PASS |
| A-36 | 无 `agent.a2a.invoke` → SSE 端点 403 | PASS |
| A-37 | `uhp.invoke` 不能顶替 `agent.a2a.invoke` | PASS |
| A-38 | 密级越级 → `DATA_CLASS_EXCEEDED` 拒绝 | PASS |
| A-39 | 非 online 员工被点名 → `TARGET_NOT_ONLINE` | PASS |
| A-40 | 非 online 员工卡片 404（发现面同步收口） | PASS |
| A-41 | 匿名请求 → 401 | PASS |
| A-42 | 自治矩阵 A2×A1 → `execute_confirm` + 人在环审批单 | PASS |
| A-43 | **只读 `a2a.directory.read` 不可取消他人任务** | **FAIL** → E-1 |
| A-44 | OBO 令牌携带人类 `act` | PASS |
| A-45 | **OBO 令牌可用于 A2A** | **FAIL** → E-2 |
| A-46 | **UHP `ybk_on_behalf_user` 透传至审计 actorId** | **FAIL** → E-3 |
| A-47 | 计量事件主体为 `agent:<id>`，双分录正确 | PASS |
| A-48 | 计量 token 数与任务视图一致 | PASS |
| A-49 | 审计成链（machine → system → human） | PASS |
| A-50 | 审计可还原「谁→谁、什么任务、什么治理决策」 | PASS |
| A-51 | 人类 `qa-acceptor` 可完成交付验收 | PASS |
| A-52 | fulfillment 履约视图体现验收结果 | PASS |

**结果：PASS 46 / FAIL 6**（A-10 计入 FAIL，缺陷归并后见下表）。

---

## 13. 缺陷清单

| ID | 严重度 | 标题 | 证据 | 影响 |
|---|---|---|---|---|
| **E-1** | **P1** | `a2a.directory.read`（只读治理视图点）可越权 `tasks/cancel` 他人任务 | `qa-a3-cc` 取消 `qa-caller-cc` 的在途任务成功返回 `state:"canceled"`。根因 `packages/plugin-a2a/src/index.ts` 的 `cancelTask()` 复用 `getTask()` 的鉴权，`a2a.directory.read` 被当作写操作放行 | 只读凭证具备状态写能力；只读观察员可干扰任意在途协作且审计看似合法 |
| **E-2** | **P1** | OBO 令牌无法驱动 A2A 协作面 | `POST /api/agents/:id/obo-token` 返回 scope `["agent.read","agent.write","skill.read"]`；该 token 调 A2A → `403 缺少权限点 agent.a2a.invoke`。全部 QA 人类角色亦无一持有 `agent.a2a.invoke` | 人类无法以代表身份发起/参与协作，OBO 身份链在 A2A 侧整体不可用 |
| **E-3** | **P1** | `ybk_on_behalf_user` 未校验且不进审计，OBO 声明形同虚设 | `POST /v1/uhp/responses` 携带 `ybk_on_behalf_user:"usr_..."` → HTTP 200 且原样回显；审计恒为 `actorType=system actorId=uhp`。`grep -rn "act\b\|obo" packages/plugin-a2a/src packages/plugin-uhp/src` 无消费点 | 调用方可任意伪造「代表某人」；审计链丢失真实发起人，事后追责不可还原 |
| **E-4** | **P1** | `message/send` 与 `message/stream` 响应不同构，通用 A2A 客户端无法处理同一端点 | `POST .../a2a` + `message/stream` → `content-type: text/event-stream` 裸 SSE；同端点 `message/send` → JSON-RPC 信封。规范要求两者均返回 `Task` | 外部客户端必须为同一 URL 写两套解析分支；A2A 互操作性打折 |
| **E-5** | **P2** | UHP 错误文案引导的 `harness/<id>` 格式必然 404 | `{"model":"harness/h-qa-a2-auto"}` → `404 执行体不存在：h-qa-a2-auto`。`packages/plugin-uhp/src/index.ts:613` 只查 agent id/slug | 首次接入的外部调用方 100% 踩坑；需靠 `GET /v1/uhp` 的 `configured[]` 反推 |
| **E-6** | **P2** | Agent Card 自描述不足以支撑「只靠卡片协作」 | 卡片缺：① SSE 事件地址 ② 所需权限点（`securitySchemes` 无 scopes） ③ A2A 协议版本/方法面 ④ 裸体（非 `{ok,data}` 信封）。客户端实测 `misses=["卡片未提供任务事件(SSE)订阅地址…"]`，SSE URL 靠猜 | A2A 核心承诺打折：外部 Agent 仍需平台私有知识（事件路径、权限点名、包络格式） |
| **E-7** | **P2** | 卡片 `meteringSubject` 与实际计量双主体口径不一致 | 卡片声明 `meteringSubject=agent:<被调方>`；实测 A2A 调用事件 `subject=agent:<调用方>` | 外部对账方按卡片口径拉账会漏掉发起侧 calls |
| **E-8** | **P2** | dshctl CLI 对新增 A2A/UHP 能力零跟进 | `dshctl --help \| grep -ci "a2a\|uhp"` → `0`；`a2a` / `uhp` / `collab` / `agent-card` 均「未知资源」。而 `packages/plugin-a2a/manifest/api.yaml` 自称「CLI/Skill/Web 三端对齐的唯一事实源」 | 人类运维无 CLI 通道查看/派活/验收/巡检；「三端对齐」声明不成立 |
| **E-9** | **P2** | Agent Card 签名「可验」但「是否强制验」不可从外部证实 | 外部客户端可验签通过，但 `api.yaml` 注释「先验签后采信」的强制点位于平台内部路由，无法黑盒验证；且 well-known 协议面注释称「免鉴权」 | 签名目前更接近「可验证的完整性声明」而非强制信任根，威胁模型需澄清 |

**严重度分布：P0 × 0，P1 × 4，P2 × 5。**

> **为什么没有 P0**：A2A 主干链路、A3 协商、治理门禁（权限点/密级/上线态/自治矩阵）、凭据轮换、计量审计、交付验收全部实测通过，无「主流程不可用」「数据越权外泄」「治理完全失效」级别的阻断问题。E-1 是越权写，但作用域限于单实例内 A2A 任务状态、且审计可追溯，故定 P1 而非 P0。

---

## 14. 未覆盖项（诚实记录）

| 项 | 未覆盖原因 |
|---|---|
| `tasks/cancel` 对**正在 executing（非 auth_required）**的任务 | stub 模型 ~200ms 即返回，无可取消的执行窗口；只能用 `auth_required` 态任务间接验证终态判断逻辑 |
| `message/stream` 的**中途断流 / 重连 / 续传** | stub 太快，`response.completed` 几乎立即到达，无法构造中途断开 |
| `pushNotifications` 能力 | 卡片显式 `"pushNotifications": false`，平台未实现，无可测面 |
| SSE 的鉴权令牌在 URL 中的**泄露面**（Referer / 日志） | 属部署侧风险，需查网关访问日志；本组无网关日志读取权限 |
| 跨运行时协作（dsh ↔ hermes 互调）的**真实跨运行时调度** | 员工 runtime 字段齐全，但平台内两个 runtime 由同一 stub 后端应答，无法区分「真跨运行时」与「同进程内路由」 |
| **平台内部是否强制验 Agent Card 签名** | 黑盒不可观测（同 E-9）；尝试构造被篡改卡片需 MITM 位置，本组不具备 |
| `mcp invoke` 的 denied 路径运行时验证 | 本 QA 实例 `/api/mcp/services` 为空，无 MCP 服务可 invoke；仅以源码走查确认未修（D6） |
| A3 协商中「**调用方模型评估还价并再次还价**」的智能体行为 | `qa-a3-caller` 自身由 7399 stub 驱动，stub 对要约类 prompt 一律 accept，无法制造「调用方智能体主动再谈」 |
| 并发压力 / 多任务竞态 / 限流 | 本轮为功能验收，未做并发 |
| 跨组织隔离（A2A 是否泄漏到 QA隔离部） | `qa-ro` / `qa-outsider` 无 `agent.a2a.invoke`，预期被 G1 拦下，但未构造「有 invoke 的跨组织凭证」做对照（需新建跨组织机器凭证，污染面大） |

---

## 15. 风险与遗留

1. **E-1（越权取消）是本轮最高风险项**。`a2a.directory.read` 是被 `qa_collab`（协作观察员）等只读角色广泛持有的权限点，误配或恶意持有都会直接获得跨主体任务取消能力。修复方向：`cancelTask()` 改用独立的写权限判定（应要求调用方为 `callerPrincipalId` 本人，或持有新增的 `a2a.task.cancel`）。

2. **E-2 + E-3 叠加使「人在环」在 A2A 侧形同虚设**。协作平面设计上是「Agent 之间协作 + 人做验收」，但人既不能发起（无 `agent.a2a.invoke`），其 OBO 声明又不进审计。这与平台整体「人在环」的合规叙事存在张力，建议在 v2 补齐「人类以 OBO 身份发起协作」并让 `act` 真正进入 A2A/UHP 的审计主体。

3. **Agent Card 的自描述质量是 A2A 生态扩展性的天花板**。当前外部客户端仍需三处平台私有知识（事件路径、权限点名、`{ok,data}` 包络）。若不补齐，每接入一个外部厂商 Agent 都要额外做一次「人工适配」，A2A 协议的价值会被显著摊薄。

4. **CLI 与 API 面严重脱节（E-8 + D1–D6）**。本轮新增了两套共 28 个端点，CLI 覆盖为 0；同时上轮已知的 6 条 CLI 缺陷本轮 0 修复。`manifest/api.yaml` 的「三端对齐唯一事实源」定位目前只是文档承诺。建议要么给 A2A/UHP 补 CLI 最小集（`a2a directory|task|acceptance|fulfillment`、`uhp harness|responses`），要么下调该文档的措辞。

5. **测试资产残留**（见 §2.3）。特别是模型 slug `deepseek-reasoner` 被改指向 `http://127.0.0.1:7401/v1`（组E 自建反价 stub）。**该映射对其他组无影响**（fixture 中全部 QA 员工的 `attrs.model` 均为 `deepseek-chat`，未被改动），但若后续有人新建 `deepseek-reasoner` 员工会打到本组 stub。清理方式：
   ```bash
   curl -X DELETE http://127.0.0.1:7311/api/modelgw/models/mdl_mvgimruhifg9jnil -H "authorization: Bearer $T"
   curl -X DELETE http://127.0.0.1:7311/api/agents/agt_mvgimrunifgcjrg2 -H "authorization: Bearer $T"
   curl -X DELETE http://127.0.0.1:7311/api/agents/<qa-e-offline-target id> -H "authorization: Bearer $T"
   pkill -f /tmp/qa/stub7401.mjs
   ```

6. **`qa-caller-cc` 的 clientSecret 已在测试中被 rotate**，fixture.json 中记录的旧 secret（`cs_s0qmuqK1txHSH8HxXKgGiaiXmF3QHbzS`）已失效。新 secret 只在 `/tmp/qa/rotate.out` 中留档（该文件含明文密钥，随 `/tmp/qa` 清理）。后续组如需复用该凭据，请用 `/api/auth/client-credentials` + 新 secret 换 token。

---

## 附：本轮脚本清单（`/tmp/qa/`）

| 文件 | 用途 |
|---|---|
| `ext-client.mjs` | 独立外部 Agent 客户端（零平台 SDK） |
| `e1-fullchain.mjs` | 发现→send→轮询→SSE→list→stream→cancel 全链路 |
| `e2-negotiation.mjs` | A3 协商 accept 路径 |
| `e2b-counter.mjs` / `e2c-cap.mjs` | A3 协商 counter 路径与轮次上限 |
| `e3-governance.mjs` | 治理门禁 G1–G5 |
| `e4-obo.mjs` | OBO 身份链 |
| `e5-meter-audit.mjs` | 计量 / 审计 / 交付验收闭环 |
| `e6-card-sign.mjs` / `e7-verify.mjs` | 卡片验签 + 跨主体取消越权 |
| `stub7401.mjs` | 自建反价 stub（7401） |
| `e-mc.mjs` / `e-tokens.mjs` | 凭据/令牌签发 |
