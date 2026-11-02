# archive/ —— 已下线封存区

本目录存放已退出运行时、**不参与构建与加载**的历史包。根 `package.json` 的 workspaces 仅覆盖
`packages/*`，故本目录下的包不会被 npm workspace 解析，也不会出现在 `cordis.yml` 加载序列中。

## plugin-billing（@dsh-ops/plugin-billing）

- **状态**：已下线封存，未加载。
- **下线时间**：M0-2，2026-09-09（钱包/复分账功能面整体退出运行时）。
- **归档迁移**：OPT-P0-02，2026-09-12，自 `packages/plugin-billing` 迁入本目录。
  迁移原因：原位残留两处结构性漂移——`plugin-connector/plugin.yaml` 的 `depends` 仍声明
  `dsh-plugin-billing`（加载序校验口径污染）；`src/tools.ts` 仍调用已不存在的
  `ctx.billing.balance(...)`，一旦被误加载即崩。
- **存量数据**：SQLite（data/txnstore.db）wallet_journal 等流水经
  `scripts/billing-archive-export.mjs` 导出 CSV 只读封存 90 天，登记见
  `docs/billing-archive-register.md`。
- **恢复条件**：仅当产品重新立项计费域时，从 git 历史（本目录最后一次提交）恢复并重走
  五面清单 + 契约 lint 闸门，不得直接复活。

## legacy-brand/（旧品牌资产）

- **状态**：已下线封存，不参与构建与加载。
- **归档时间**：2026-10-15（审查反馈整体整改批次）。
- **内容**：`产品.html`（旧「榕器」品牌产品页，26 处旧品牌表述与 2026-10-13 品牌重塑「元冰可」冲突，
  处置决策=归档下线而非重写）与 `preview-fullpage.png`（其整页预览截图）。
- **恢复条件**：仅当需要历史品牌对照时从 git 历史查阅；对外口径以根 `README.md` 与官网现行页面为准。
