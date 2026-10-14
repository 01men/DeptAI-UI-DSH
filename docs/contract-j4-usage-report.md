# J4 契约：用量报表数据口径 v1（冻结稿）

> 冻结日期：2026-09-09 ｜ 所有者：宿主轨 main（ybkkasi）｜ 消费方：定制侧面板报表、控制台资产运营页
> 变更纪律：本契约升版须发发布说明并双侧同步（红线 1）；定制侧以发布说明为 merge 翻译层。
> 实现锚点：`packages/plugin-usage/src/index.ts` `UsageService.monthlyReport()`；控制台端点 `GET /api/usage/report/monthly`。

## 1. 数据源与事件口径

- 唯一数据源：usage 计量事件流水（`usage_events`，SQLite `data/txnstore.db`），**不读任何金额账本**（billing 已下线封存）。
- 事件窗口：按 `occurred_at`（ISO UTC）落在 `[当月 1 日 00:00, 次月 1 日 00:00)` 内的事件；月份参数格式 `YYYY-MM`。
- 幂等：事件以 `idempotency_key` 引擎级唯一，重复投递不重复计数；报表口径即落库口径，可经 `POST /api/usage/reconcile` 对账。

## 2. tokens 三维聚合（J4 核心）

tokens 取事件 `meters[]` 中**计量键名含 `tokens` 的米值求和**（覆盖 `tokens` / `input_tokens` / `output_tokens`，
同事件多键累加；不含 `calls` 等非 tokens 米）。三个冻结维度：

| 维度 | 归类字段 | 说明 |
|---|---|---|
| 部门 byOrg | `org`（**部门归口字段**） | 所有事件必带 org；无组织归属的事件归口 `t_default` 租户下空串 org，不参与任何部门 |
| Agent byAgent | `subject` 且前缀 `agent:` | on-behalf-of 终点为 Agent 的事件（含 Agent 经网关/连接器的消耗） |
| Skill bySkill | `resource` 且前缀 `skill:` | Skill 调用/下载回填事件 |

附加维度（additive，便于成本穿透，非 J4 冻结面）：`byModel`（resource 前缀 `model:`）。

每行输出：`dimension / events / tokens / charge_cents / cost_cents / nonbillable_events`。

## 3. 金额口径（M0-3 收敛后）

- `charge_cents`：**零价快照恒 0**。平台商业口径为按「团队 + 领域资产」定价或制造业私有化交付项目制
  （2026-09-15 更新），价格簿 list 侧统一零价，
  报表不呈现任何对外结算金额；价格簿保留调价能力仅供未来运营决策，一旦调价须先升版本契约。
- `cost_cents`：**内部采购成本参考**（价格簿 cost 侧 × 实测米值折算），仅用于内部成本穿透，不得对外呈现为账单。
- `nonbillable_events`：命中零费率规则（list=cost=0）的零价快照事件数（`rate.nonbillable=true`），
  观测类事件（反馈/知识包/面板等）在此列，不污染成本口径。

## 4. 交付契约（控制台端点）

- `GET /api/usage/report/monthly?month=YYYY-MM` → JSON（权限点 `usage.read`）：
  `{ month, from, to, totals, byOrg[], byAgent[], bySkill[], byModel[] }`；
- `GET /api/usage/report/monthly?month=YYYY-MM&format=csv` → CSV 文件下载（UTF-8 BOM，Excel 直接打开），
  列：`维度,维度值,事件数,tokens,charge_cents(零价快照恒0),cost_cents(内部成本参考),nonbillable事件数`；
  行分组顺序：total → org → agent → skill → model。**企业主可凭 `usage.read` 权限自助导出**（M0-3 验收口径）。

## 5. selftest 断言锚点

- 三维聚合与部门归口：第 2 步 usage 管道分节（跨维度事件播种后断言 byOrg/byAgent/bySkill/tokens）；
- 零价快照：charge_cents 恒 0、nonbillable 计数；
- CSV 导出：`format=csv` 返回 `text/csv` 且含 BOM 与表头；
- 死信重放演练：消费方 3 次失败入死信 → `usage_deadletter_retry` 重投成功且不双计（消费水位幂等）。
