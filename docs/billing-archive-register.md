# billing 存量资金流水封存档案登记（M0-2）

> 登记日期：2026-09-09 ｜ 依据：《元冰可开发计划-主分支-ybkkasi.md》M0-2
> 封存期：**90 天**（自各环境导出日起算）｜ 测试环境导出日：2026-09-09 ｜ **销毁日期：2026-12-08**

## 1. 下线范围

plugin-billing（钱包/充值/扣费/流水/月度预算/账期结转/红字冲正）于 2026-09-09 退出运行时：

- 装配移除：`src/boot-all.ts`、`cordis.yml`、`cordis.patch.yml` 均不再装载 `ops-billing`；
- API 下线：控制台 8 个 `/api/billing/*` 端点全部移除（wallets / recharge / journal / verify / budgets / settle / ledger / ledger/reverse）；
- 权限点下线：`billing.read` / `billing.write` / `billing.admin`（IAM 权限点矩阵移除）；
- 事件停发：`wallet.balance.changed`、`billing.ledger.settled` 不再有生产者（事件常量保留于 platform-core，保持事件族 additive-only）；
- 依赖解除：plugin-modelgw（预检/扣费）、plugin-connector（precheck 闸）、plugin-console（演示充值种子）、market（订阅代收）全部改道或移除。

## 2. 封存对象与归档位置

| 数据 | 存储位置（各环境） | 归档文件（CSV，UTF-8 BOM） |
|---|---|---|
| 钱包流水 | `<数据目录>/data/txnstore.db` 表 `wallet_journal` | `data/archive/wallet_journal-<日期>.csv` |
| 复式分账分录 | 同库表 `ledger_entries` | `data/archive/ledger_entries-<日期>.csv` |
| 钱包余额快照 | 同库表 `wallets` | `data/archive/wallets-<日期>.csv`（对账复核用） |

- 导出工具：`scripts/billing-archive-export.mjs`（**只读**：仅 SELECT，可重复执行，每次生成带日期的新档案）；
- 用法：`node scripts/billing-archive-export.mjs [--db <txnstore.db>] [--out <目录>]`；
- 代码封存：`packages/plugin-billing/` 源码保留在仓库（头部有下线公告），不装载、不再改动；90 天期满确认无误后随数据一并删除。

## 3. 各环境登记表

| 环境 | 数据目录 | 导出执行日 | 档案行数（journal/ledger/wallets） | 销毁日期 |
|---|---|---|---|---|
| 测试 mdzx.fun:8801（Mac mini 7300） | `/Users/xiaodaoqin/ops-platform-test/data` | 2026-09-09 | 0 / 0 / 0（该实例 2026-09-09 全新初始化，未产生过资金流水；空档案 CSV 已落 `data/archive/`） | **2026-12-08** |
| 正式 192.168.0.7:7300 | `/opt/ops-platform/data` | 待正式发布时执行（发布说明已列入操作清单） | — | 导出日 + 90 天 |

> 存量账期权益登记（market `market:subscriptions` 集合，JSON 存档于 `<数据目录>/data/`）随代收功能一并停写；
> 如该集合在正式环境有存量记录，正式发布时一并人工确认后按同一销毁日期处置。

## 4. 销毁操作（2026-12-08 到期后）

1. 复核归档 CSV 完整性（行数与封存登记一致、无后续引用）；
2. 删除各环境 `data/archive/billing-*` 档案文件；
3. SQLite 清表：`DELETE FROM wallet_journal; DELETE FROM ledger_entries; DELETE FROM wallets;` 后 `VACUUM;`
   （或直接确认 `data/txnstore.db` 中三表为空即可，表结构保留无害）；
4. 删除仓库 `packages/plugin-billing/` 目录，更新本登记表销毁执行记录。
