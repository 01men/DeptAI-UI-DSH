# 组A 分报告 · 架构契约与协议面

- **实例**：`http://127.0.0.1:7341`（数据 `data-qa-gA-20261021`，stub `7441`）
- **判定**：**48 / 49 通过**
- **执行脚本**：`qa-runtime-20261021/group-a.mjs` ｜ **结果**：`qa-runtime-20261021/result-A.json` ｜ **日志**：`run-A.log`

## 一、结论

架构契约面**基本全绿**。UHP 与 A2A 的架构落点在「发现面往返、事件总线纪律、八态状态机、协商引擎、幂等链、协议同构、卡片自描述、巡检」八个维度均实测成立；唯一失败是 `/v1/uhp` 发现面仍包平台信封（P2-02），属口径一致性缺陷。

## 二、逐项结果

### A1 发现面 → 调用面往返（14 项，13 通过）

| 断言 | 结果 | 说明 |
|---|---|---|
| 平台目录卡匿名可读且为规范裸体 | ✅ | `/.well-known/agent-card.json` 无 `{ok,data}` 信封 |
| 平台目录卡声明 Ed25519 验签公钥 | ✅ | `algorithm=Ed25519` |
| 单员工卡 JWS 独立验签通过 | ✅ | 用 `node:crypto` 独立复验 `${protected}.${payload}` |
| 篡改 `card.url` 后验签失败 | ✅ | 签名真实覆盖 body，非摆设 |
| 卡片声明 eventsUrl / securitySchemes.scopes / 协议扩展 | ✅ | 支撑「只靠卡片协作」 |
| 卡片计量双主体口径（callerMeteringSubject） | ✅ | Q-32 已修 |
| 不存在员工卡 404 | ✅ | 不泄露存在性 |
| UHP 发现面免鉴权 + 版本锁定 + conformance=core | ✅ | `uhp_version=2026-08-11` |
| UHP 诚实声明 files_input/files_output=false | ✅ | 未做 NAS artifact，与发布说明一致 |
| **UHP 发现面应为规范裸体** | ❌ | **实际仍返回 `{"ok":true,"data":{...}}`；well-known 已改裸体而 UHP 未同步 → P2-02** |
| 发现面公布的 harness id 可直接作 model 调用 | ✅ | `harness/h-qa-a1-exec` → 200，`harness_id` 一致（Q-7 已修） |

> 本轮曾因选到 `public` 天花板的 `h-qa-a0-tip` 而得到密级拒绝，改用 `internal` 天花板后确认往返一致——此为测试用例选择问题，非产品缺陷。

### A2 事件总线纪律与 P0 纵深（11 项，全通过）

| 断言 | 结果 | 证据 |
|---|---|---|
| 执行链路 A2A→UHP 贯通（execute_report） | ✅ | `state=completed, mode=execute_report` |
| 任务 attempts=1 | ✅ | 首次派发 |
| UHP 执行记录与任务一一对应（taskId 双向） | ✅ | `/api/uhp/responses?taskId=` 命中 |
| 执行记录归属字段完整 | ✅ | 存储层 `callerPrincipalId / dispatchedByPlatform=true / actChainJson` 齐备 |
| 外部凭证注入 `ybk_a2a_task_id` → 400 | ✅ | `TASK_BINDING_FORBIDDEN` |
| 受害任务未被推进 | ✅ | 仍 `auth_required`，零 artifact |
| 外部直调 UHP 不建立任务归属 | ✅ | 无 `task_id` |
| progress 来源拒绝审计通道存在 | ✅ | `a2a.task.progress_rejected` |
| 总线纪律：A2A→UHP 仅 1 处只读探测且已 inject 声明 | ✅ | `uhpGateway.harnesses().get()`（静态核对） |

### A3 八态生命周期（4 项，全通过）

- 任务集合可观测 ≥5 态；`history[]` 迁移成链（含 `status` 条目）；completed 带 `startedAt/finishedAt`。
- 矩阵拒绝任务 `mode=rejected`（Q-10 已修）。
- 补充独立验证：终态二次取消被拒（`repro/state-machine-terminal.mjs` → `-32000`）。

### A4 协商矩阵（4 项，全通过）

- **16 格逐格与方案 §6.4 一致**（纯函数 `negotiateMode`）。
- A3×A3 accept → 自动执行 completed；counter → `input_required`；3 轮超限 → `rejected`；offers 双向留痕。

> 首轮测试曾报 6 格不一致，复核为测试方期望表行列写反（方案表行=被调方、列=调用方），实现无误，已在脚本中修正。

### A5 幂等链（4 项，全通过）

- 同幂等键重放返回原 response；
- 审批恢复 `attempts=1`、无重复执行；
- 协作链按 `contextId` 归集 `calls=1`；
- **计量幂等键含 `taskId` 与 `:a<n>`**（Q-20 已修，两层同形）。

### A6 协议同构（1 项，通过）

- `message/stream` 返回 JSON-RPC Task（`raw.data.jsonrpc === '2.0'`），非裸 SSE（Q-8 已修）；
- `tasks/list` 可用。

### A7 UHP 契约面（5 项，全通过）

- `tools/functions/mcp_servers` 注入 → `ignored_fields` 留痕（Q-1 越权原语封堵）；
- `previous_response_id` 继承 `session_id` 并回填上一轮回答（Q-23 已修）；
- 无令牌 401 / 无 `uhp.invoke` 403；
- SSE 无令牌/坏令牌均 401（Q-28 已修）；带令牌可建立 `text/event-stream`。

### A8 声明-授权一致性（3 项，全通过）

- ghost harness 引用被巡检捕获并留痕；
- `/api/a2a/patrols` 可回溯；
- 隔离组织账号目录零可见（组织子树收敛）。

## 三、本组发现的缺陷

| 编号 | 级别 | 缺陷 | 位置 |
|---|---|---|---|
| P2-02 | P2 | `/v1/uhp` 仍包平台信封，与 well-known 的规范裸体口径不一致 | `packages/plugin-uhp/src/index.ts:673-675`（`exchange.ok(gateway.discovery())`） |

## 四、架构判断（考核项：UHP 与 A2A 架构落地）

- **事件总线唯一通道纪律成立**：A2A→UHP 仅 `a2a.task.dispatch/progress/cancel` 三事件；UHP→A2A 零直连。唯一跨包读取是巡检对 harness 注册表的只读探测，且已在 `inject` 显式声明（`plugin-a2a/src/index.ts:1244`）。
- **但「异常按 legacy 放行」的兜底策略有代价**：未 inject 的服务读取失败被 `catch` 吞掉，导致治理第 2 项静默失效（详见组D 与 P2-01）。
- **幂等链是双层的且同形**：执行派发与计量落账共用 `dispatchKey(task, attempts)`，审查为正确设计。