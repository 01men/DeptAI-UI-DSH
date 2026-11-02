# 组D 分报告 · 后端执行面与状态机

- **实例**：`http://127.0.0.1:7344`（数据 `data-qa-gD-20261021`，stub `7444`）
- **判定**：**25 / 26 通过**
- **执行脚本**：`qa-runtime-20261021/group-d.mjs` ｜ **结果**：`result-D.json` ｜ **日志**：`run-D.log`

## 一、结论

执行面主干**稳固**：治理五查中 4 项生效、取消时序正确、审批恢复幂等、验收/履约聚合正确、并发下幂等收敛。两项需要关注：

1. **治理第 2 项的 permit 覆盖仍是空操作**（P2-01，决定性复现成立）；
2. **UHP 外部直调 SSE 不闭合**（P2-03，确定性复现成立）。

## 二、治理五查

| 项 | 断言 | 结果 | 证据 |
|---|---|---|---|
| ① 权限点 | HTTP 边界 guarded 强制（组B 门禁矩阵） | ✅ | 组B |
| ② 在线 | 非 online 目标 → `TARGET_NOT_ONLINE` | ✅ | 组D `D1` |
| ② 冻结 | 冻结目标 → `TARGET_FROZEN` | ✅ | 组D `D1` |
| ② **permit 覆盖** | 员工 active + 绑定 + **零任用** → 应 `PERMIT_NOT_EFFECTIVE` | ❌ **实际 completed** | `repro/permit-decisive.mjs` |
| ③ 密级天花板 | 越级 → `DATA_CLASS_EXCEEDED` | ✅ | 组D `D1` |
| ④ 预算熔断 | `block` 策略命中 → 拒绝 | ✅ | 组D `D1` |
| ⑤ 敏感审批规则 | 命中 → `auth_required` + 审批工单 | ✅ | 组D `D1` |

### P2-01 根因链（决定性）

```
plugin-a2a export const inject = [..., 'uhpGateway']   // ❌ 无 workforceIdentity
        ↓
governanceCheck: identity?.workforceIdentity            // Service 代理读未 inject 键 → 抛错
        ↓
catch { logger.warn('...按 legacy 放行') }              // 异常被吞，直接进入第 3 项
        ↓
已绑定但无任用的受管员工 → 照常派单 completed
```

- `packages/plugin-a2a/src/index.ts:1244`（inject 缺项）
- `packages/plugin-a2a/src/index.ts:422-447`（探测 + 吞错）
- 契约总表 §3.4 却已写明「2026-10-20 由空操作改为真实判定」→ **文档超前于实现**

> 该分支即便 inject 补全，仍需注意 `resolver.store` 是 `private get store()`：从外部访问 `resolver.store.bindings` 在 TypeScript 运行时**可读**（getter 无 `#` 私有），但依赖内部结构属脆弱耦合，建议改为契约方法（如 `isManaged(agentId)`）。

## 三、取消时序（4 项全通过）

| 断言 | 结果 |
|---|---|
| 同步等待窗超时返回在途任务（working） | ✅ |
| 在途取消即时生效（canceled） | ✅ |
| 取消后模型返回**不交付**（终态仍 canceled、零 artifact） | ✅ |
| 取消任务**不计入**协作链计量 | ✅ |

> 说明：`A2A_SYNC_WAIT_MS` 在本组设为 1000ms，慢任务 stub 延迟 2600ms，取消窗口确定可达。

## 四、审批恢复与幂等（2 项全通过）

- 审批通过 → `completed` 且 `attempts=1`；
- 只产生 **1 条** UHP 执行记录（无重复执行）。

## 五、验收与履约（4 项全通过）

- 发起人自验收 → 403（职责分离）；
- 第三方验收 → 200 且 `acceptance.status=accepted`；
- 履约视图聚合完成率 / 验收通过率 / P95 耗时；
- P95 非负且时间口径合理。

## 六、并发与竞态（3 项全通过）

| 场景 | 结果 |
|---|---|
| 5 个独立凭证并发 UHP 请求 | 全部 200，无 5xx |
| **5 并发同幂等键** | **只产生 1 个 response**（幂等收敛） |
| 5 并发 A2A 派发 | 5 个互不覆盖的 taskId |

> 这组是本轮对「真实并发」最有力的补充证据：上一轮登记的「并发竞态未覆盖」在同步 stub 下已可部分证伪（幂等收敛成立）。

## 七、会话续接（2 项全通过）

- `task-bound` 续接继承 `session_id`（Q-23）；
- 跨主体续接他人会话 → 403（`previous_response_id` 归属校验，`plugin-uhp/src/index.ts:351-356`）。

## 八、巡检（1 项通过）

- 同一次巡检捕获 **Skill 下架引用 + harness 幽灵引用** 两类漂移（多类漂移聚合）。

## 九、SSE

| 断言 | 结果 |
|---|---|
| A2A 任务 SSE 建立并推送历史快照（首帧 `event/data`） | ✅ |
| UHP `stream=true` 返回 `text/event-stream` | ✅（协议头正确） |
| **UHP 外部直调 SSE 闭合** | ❌ **P2-03** |

### P2-03 复现与根因

```json
{ "httpStatus": 200, "contentType": "text/event-stream",
  "eventsSeen": ["response.created"], "executionStatus": "completed",
  "verdict": "FAIL（SSE 未完成，执行实际状态=completed）" }
```

根因：SSE 订阅器监听 `platformBus.on('a2a.task.progress')`（`plugin-uhp/src/index.ts:817`），而 `emitProgress` 仅对 `dispatchedByPlatform=true` 的记录发出（同文件 `:530`）。外部直调（`dispatchedByPlatform=false`）永远不会收到 progress → SSE 永不闭合。**这是 P0 修复（外部直调不得驱动 A2A 状态机）与 SSE 复用同一事件通道造成的设计冲突。**

修复建议：SSE 改为直接订阅执行记录状态（`gateway.response(id)` 轮询/回调），或为 SSE 增设独立的 `uhp.response.progress` 内部事件（不驱动 A2A）。

## 十、本组发现的缺陷

| 编号 | 级别 | 缺陷 |
|---|---|---|
| P2-01 | P2（治理能力实质缺失，建议按 P1 排期） | workforce permit 覆盖仍为空操作 |
| P2-03 | P2 | UHP 外部直调 SSE 不闭合 |

## 十一、后端判断

- 执行面（派发/取消/恢复/续接/计量/验收/巡检）**全部实测成立**。
- 治理五查缺 1 项（permit），属**声明与实现不一致**，不是主流程阻断项，但会让「受管员工离岗后仍可接单」成为真实风险，建议优先修。