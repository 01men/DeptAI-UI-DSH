# F 域余量回流 · main 侧采纳决策与实施记录（2026-09-10）

> 对应清单：定制侧 `docs/handoff-f-remainder-to-main.md`（对 main `ff1a8de` 实测）。
> 本记录基于 main 当前 `5977067` 重算残余差异（`git diff 5977067 custom/dsh-rq`）：清单生成后 main
> 已自行推进（plugin-usage/realtime.js/realtime.test.mjs 等两侧同幅 = 已同步，不重复回流）。
> 闭环规则：采纳项定制侧 merge 吸收；不采纳项定制侧拆除或豁免登记。

## 一、决策回执

| 域 | 采纳？ | 备注 |
|---|---|---|
| A 审批深化 | ✅ 采纳 | plugin-audit WP-10 底座 + agent 标注 + console 三端点。排除定制侧 `PUBLIC_PATHS` 首行误合并的格式损伤 |
| B usage/recent | ✅ 采纳 | `GET /api/usage/recent`（console.login，自见 ≤5） |
| C 五平台主题/钉钉H5/dashboard | ◑ 部分采纳 | 主题（platform.js + base.css 五平台块 + 启动回放 + 钉钉入口探测）采纳；**dashboard 场景卡片区不采纳**（依赖定制面板 `/api/panel/board`，按清单警示待卡片包域表态）；对话入口卡按挂载形态显隐。钉钉 H5 降级（realtime.js + realtime.test.mjs）main 已自备，无需回流 |
| D 目录筛选/登记引导 | ✅ 采纳 | asset-filters 纯函数 + assets 瘦身 + register 引导页 + NAV「资产登记」（排除定制侧 NAV 重复的 Skill 行——rebase 残留） |
| E 测试资产 | ✅ 随域 | 四分节移植进 scripts/selftest.mjs + 新增 G1 分节；walkthrough / dingtalk-h5-smoke 不搬（H5 主体已在 main，行为等价）；dom-smoke 等布局迁移不强制 |
| F mcp/app riskLevel 水印 | ✅ 采纳 | app 2 处 high 标注；mcp `finalReview` + 调用水印 |
| G1 远程登录回跳闭环 | ✅ 采纳 | `POST /api/auth/entry-tickets/self`（refType `self`，TTL 硬上限 120s）+ 跨源 next 白名单（landing.js 纯函数：仅 http(s) 回环/私网主机）+ 登录页/SSO 回调双消费点。审计动作沿用 main 既有 `${refType}.entry.ticket.*` 约定（self.entry.ticket.issue / self.entry.ticket.session），不另设 authn.entryticket.redeemed 双轨 |
| G2 modelgw 流式化 | ❌ 暂缓 | 非必须，现状单轮非流式诚实工作 |
| G3 拷贝安装 TS 装载 | ❌ 维持挂起 | 01门产物已自解（dist 入库为其装机面）；宿主面包属 G3 架构议题，非本批 |
| H README 定制文档段 | ❌ 不采纳 | 内容描述定制面（/rqcard 向导等），建议定制侧移入 docs/plan-dsh-plugin-first.md 并还原 README |
| I 01门改名装配漂移 | ❌ 不采纳（豁免登记） | 产品身份值必须跟随**各自**根包名：main 保持 `dsh-enterprise-ops` / `@dsh-ops` / `/rq`。定制侧保留其值，收敛检查按「产品身份豁免」登记 |
| J Phase 3 追加漂移 | ◑ 部分采纳 | **dsh-bridge inject 收缩 + softRead 防御式软读：采纳**（main 全量装配下行为不变，抗缺提供者装配，真机已实证；宿主面健壮性）。rq-card tool.ts 内联 / exports / 根 files 闭包：不回流（rq-card 包内装机面，main 不涉） |
| K http.ts file() 守卫 | ✅ 采纳（最优先） | headersSent 幂等守卫，崩溃级缺陷 |

## 二、实施清单（本批 commit 范围）

1. **K** `packages/platform-core/src/http.ts`：`file()` 补 `res.headersSent` 守卫（含 catch 分支）。
2. **A** `packages/plugin-audit/src/index.ts`：`ApprovalRecord.riskLevel`/`finalReview`；`decideApproval` 高风险
   `confirmed` 服务端强制 + 终审标记 + `approval.final_review` 审计；`slaReport()`。
3. **A** `packages/plugin-agent/src/index.ts`：上线/下线 L4 审批 `riskLevel: 'high'`（2 处）。
4. **F** `packages/plugin-app/src/index.ts`：上线/下架 L4 审批 `riskLevel: 'high'`（2 处）。
5. **F** `packages/plugin-mcp/src/index.ts`：`McpServiceRecord.finalReview`；`McpCallRecord.watermark`；
   invoke 落水印。
6. **A+B+G1** `packages/plugin-console/src/index.ts`：
   `POST /api/mcp/services/:id/final-review`、`GET /api/approvals/sla`、approvals decide `confirmed`/`finalReview`
   透传、`GET /api/usage/recent`（+ usageAssetName）、`POST /api/auth/entry-tickets/self`、
   SSO 回调成功脚本消费跨源 next（`heng_ops_next_cross`）。
7. **G1** `packages/plugin-authn/src/entry-ticket.ts`：`refType` 增 `'self'`；`issue()` 增 `maxTtlSeconds` 选项。
8. **G1** `public/js/landing.js`：`sanitizeCrossOriginNext()` 纯函数（http(s) + 回环/私网主机才放行）。
9. **G1** `public/js/pages/login.js`：跨源 next 消费（finishLogin 统一出口签票回跳 fragment）、
   钉钉整页授权前暂存 `heng_ops_next_cross`。
10. **C** `public/js/platform.js`（新）、`public/css/base.css` 五平台主题块、`public/js/app.js`
    启动回放 + 钉钉入口探测。
11. **C** `public/js/pages/approvals.js`：SLA 看板 + 高风险/终审徽章 + 二次确认复选框（去定制 kind）。
12. **C** `public/js/pages/dashboard.js`：全员四区改造（问候/最近调用/对话入口 + 管理简报按 `usage.read`
    门控 + 绑定横幅 + behavior 埋点）；**无场景卡片区**。
13. **D** `public/js/asset-filters.js`（新）、`pages/assets.js` 目录瘦身、`pages/register.js`（新）、
    `app.js` NAV/builder；base.css reg-tile/chip 块。
14. **J** `packages/plugin-dsh-bridge/src/index.ts`：inject 3 键 + `softRead` 软读。
15. **E** `scripts/selftest.mjs`：移植「审批 SLA 与公司级终审」「usage 最近调用」「五平台主题（CSS 断言）」
    「目录筛选（纯函数 + 性能）」+ 新增「自助入场票据与跨源回跳（G1）」分节。
16. 文档：本记录 + README 最近更新行。

## 三、验证口径

- `npm run selftest` 全绿（新增断言随分节）。
- `npm run lint:manifests` 通过。
- 新端点经 rbac endpoint matrix 动态矩阵自动覆盖（console.login 权限点）。
