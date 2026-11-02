# 发布说明 · M0 合规止血（2026-09-09）

> 版本：宿主轨 main，M0 波次出口 ｜ 性质：**含契约变更，定制侧必须同步窗口对齐**
> 任务范围：M0-1（usage 管道硬化收尾）· M0-2（billing 下线封存）· M0-3（modelgw 用量透明化）· M0-4（全仓文案清理）
> 交付物：J4 契约 [contract-j4-usage-report.md](contract-j4-usage-report.md) · 封存档案 [billing-archive-register.md](billing-archive-register.md)

## 一、商业模式口径（最重要）

平台商业口径收敛为 **私有化年费 + 治理包**。按用量计费、转售、分成、代收全部终止：

- 价格簿 list 侧统一**零价快照**（`charge_cents` 恒 0），cost 侧保留**内部采购成本参考**；
- 产品页 / README / 控制台文案已全面移除结算语义；对外只呈现用量与内部成本穿透。

## 二、契约变更清单（红线 1 登记项）

### 2.1 API 下线（定制侧若有调用必须迁移）

| 下线端点 | 替代 |
|---|---|
| `GET /api/billing/wallets/:ownerType/:ownerId` | 无（余额语义废止）；用量看 `/api/usage/report/monthly` |
| `POST /api/billing/recharge` | 无 |
| `GET /api/billing/journal` | `GET /api/usage/events`（计量流水） |
| `POST /api/billing/verify` | `POST /api/usage/reconcile` |
| `PUT/GET /api/billing/budgets/:orgId` | 无（预算闸废止） |
| `POST /api/billing/settle` / `GET /api/billing/ledger` / `POST /api/billing/ledger/reverse` | 无（分账废止） |
| `GET /api/market/subscriptions` | 无（代收废止） |
| `/api/market/plugins`、`market_plugin_list` 工具：`billing` 字段 | `metering: { usageKey, unit }`（仅计量键，无金额） |

### 2.2 API 形状变更

- `POST /api/modelgw/invoke` 响应：移除 `chargeCents` / `balanceAfterCents`，新增 `costCents`（内部成本参考）；
  不再有余额/预算预检拒绝（`quota.exceeded` 在模型网关面不再产生）。
- `POST /api/modelgw/models` 入参：移除 `listCentsPerKTokens`；`costCentsPerKTokens` 语义 = 内部采购成本参考。
- `GET /api/assets/benefit` 响应：移除 `charge_cents` / `margin_cents`（收入/毛利语义废止），
  行字段为 `{ resource, label, kind, count, cost_cents, window_dau, cost_per_dau_cents }`。
- `GET /api/assets/inventory`：`chargeCents` → `costCents`，`summary.chargeCents30d` → `summary.costCents30d`。
- **新增** `GET /api/usage/report/monthly?month=YYYY-MM[&format=csv]`（权限点 `usage.read`）：J4 月度报表 JSON / CSV 自助导出。

### 2.3 事件

- `wallet.balance.changed`、`billing.ledger.settled` 无生产者（事件常量保留，事件族 additive-only 不删）。
  定制侧若有订阅，将不再收到事件，应移除订阅面。

### 2.4 权限点

- **移除**：`billing.read` / `billing.write` / `billing.admin`（存量角色若含这三点，解析时自动忽略即可，无需迁移数据）。
- 分组标签更名：「计量计费」→「用量计量」、「模型转售」→「模型网关」。

### 2.5 连接器

- 权限组 `precheckCents` 字段废止（存量数据兼容保留，运行时不读）；创建/更新入参不再接受该字段。
- `quota_exceeded` 调用状态在连接器面不再产生（wire 枚举保留兼容）。

### 2.6 计量口径（J4，冻结 v1）

- 价格簿默认规则迁移：`mcp:*` 由「list 30 / cost 15 分/千 tokens」迁移为「list 0 / cost 15（rate_version `v2026.09-cost`）」；
  仅当存量条目未被运营改过（与旧默认完全一致）时自动迁移，已调价条目不动。
- 市场安装第三方插件：价格簿登记一律零价（第三方声明价不再入账）；meter key 取声明保持不变（计量兼容）。
- J4 三维聚合 / CSV 导出契约见 [contract-j4-usage-report.md](contract-j4-usage-report.md)（冻结 v1，变更须升版）。

## 三、定制侧同步窗口（merge 翻译指引）

1. 面板/定制面若引用 `billing` 字段、`/api/billing/*`、订阅事件 → 按 §2.1/2.3 移除或迁移；
2. 面板文案「钱包额度已耗尽」（rq-card locales）属定制面三包（主分支不主动重构），请定制侧自行按新口径调整文案与降级路径；
3. 面板报表如需三维用量/导出，接 `GET /api/usage/report/monthly`（J4）；
4. `manifest/billing.yaml` 五面文件名保持必交（兼容），金额字段不再产生任何效果。

## 四、运维操作清单

- 测试环境（mdzx.fun:8801）：部署本次版本后执行 `node scripts/billing-archive-export.mjs` 完成封存导出（登记见档案文档）；
- 正式环境（192.168.0.7:7300）：发布时**手动重启前**先执行同一导出脚本，并把导出行数回填档案登记表。

## 五、验收记录

- `npm run selftest`：全绿（数量以本次运行为准，历史计数作废）；含死信重投演练、J4 三维报表与 CSV 导出新断言；
- `npm run lint:manifests`：85/85 通过；
- 全仓 grep（README / 产品.html / 控制台前端）：支付类文案零残留（下线公告中对被下线对象的指称除外）。
