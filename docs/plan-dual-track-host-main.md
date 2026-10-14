# 双轨开发计划 · 宿主平台主分支参考（ybkkasi main）

> 目标读者：ybkkasi main 开发 Agent。生成：2026-09-08，由定制分支（RQ）侧起草。
> 前置事实：宿主功能域已移植进 main（89074d9 / 80a65e3 / ff1a8de，selftest 927/927 绿），
> RQ 侧已逐条回复 8 项风险/疑点（[handoff-host-features-clarification.md](handoff-host-features-clarification.md)）。
> 本文档确立双轨制下主分支的角色、边界与协作协议。定制分支侧计划：[plan-dual-track-custom.md](plan-dual-track-custom.md)。

---

## 0. 角色定位

- **main = 宿主平台/控制台的唯一开发线**，同时是 API/事件**契约所有者**：
  `/api/panel/*` 路由语义、`panel.*` / `behavior.*` / `scenegraph.*` 事件、CORS 与 authn 契约、
  `/rq` 挂载语义、权限点矩阵（panel.*/scenegraph.* 等）。
- **定制分支（custom/dsh-rq）= dsh 前端交互插件/看板开发线 + dsh 部署装配**；
  dsh 生产环境跑的是定制分支装配——main 的宿主代码经定制侧 merge 后才进入 dsh 形态
  （「一体两面」的物理载体在定制分支，main 是宿主面的开发上游）。
- 合并方向唯一（main → custom）；定制 → main 仅「交接清单 + cherry-pick/重放」受控回流
  （2026-09 宿主功能移植即先例模板）。

---

## 1. 移植收尾核对（A–E 验收基线补遗）

已达成：selftest 927/927、lint:manifests 绿；澄清 #1/#2/#6 代码与文档落地（80a65e3）。

待核对补齐（按优先级）：

1. **验收基线第 3 条 live 实测**：vendor/cordis 链接后 `pnpm dsh web --patch cordis.yml` 单进程启动 +
   `node scripts/verify-live-host.mjs`——若 main 侧尚未跑过，补跑一次作为移植正式收口。
2. **澄清 #4 文档层**：运维须知是否已含 `/api/panel/stream` 查询串日志脱敏（或短保留期）指引、
   反代 log_format 提示。
3. **澄清 #5 文档层**：多用户并发宿主下「工具出站归因不作为计费/追责事实源」声明是否已写入部署文档。
4. **澄清 #2 升级指引**进发布说明（存量 Agent 二选一：签发 OIDC 客户端 / 登记 entryUrl；
   开发环境显式 `AGENT_SSO_ENFORCE=0`）。
5. **backlog 登记**：#3 多租户 modelgw 收敛点、#4 SSE token 硬化（dsh-bridge Cookie 或 fetch 流式替代）、
   #5 dsh 会话级绑定。

---

## 2. 目录所有权（主分支视角）

| 区 | 目录 | 规则 |
|---|---|---|
| 宿主面（main 拥有并演进） | platform-core、plugin-console、plugin-authn、plugin-agent、plugin-audit、plugin-portal、plugin-iam、plugin-usage、plugin-skillhub、plugin-app、plugin-mcp、nas-authz、**plugin-dsh-bridge（宿主桥=宿主入口设施）**、src/boot-all.ts、cordis.yml、cordis.patch.yml | 自由演进；契约变更履行 §4 义务 |
| 定制面（定制分支拥有；main 侧接收性维护） | plugin-panel-core、plugin-rq-card、plugin-dingtalk-bridge、scenegraphs/*.json | 演进以定制分支为准；main 仅做安全修复并在发布说明通知，**不做主动重构**（避免与定制分叉、给下游 merge 造冲突） |
| 治理/文档（定制侧所有） | AGENTS.md、PROJECT.md、scripts/hooks、docs/handoff-*、docs/plan-* | main 不消费 |

---

## 3. F 范围重划界（定制侧已定选项 b）

定制分支将把看板 UI 结构性迁入 plugin-panel-core（/panel 面），**控制台不再含看板面**。据此：

- **从 F 评估范围移除（勿移植）**：console `pages/board.js` 与 `#/board` NAV、portal board 端点、
  console src/index.ts 的 cardpack hunks、`platform-core/src/cardpacks.ts` + `cardpacks/*.json`——
  定制侧将把这些从 platform-core / console / portal 中迁出，三目录会收敛到 main 原样。
- **仍在 F 待评估**（定制侧将出第二份交接清单 `handoff-f-remainder-to-main.md`）：
  - 审批深化：audit 终审标记 + SLA 报表（约 +77）
  - mcp/app riskLevel 水印
  - console UX 余量：register.js 资产登记引导磁贴、asset-filters.js 目录筛选、
    dashboard/approvals/assets/skills 页改动
  - dingtalk-h5-smoke.mjs / walkthrough.mjs 测试（随对应功能域）
- **评估口径建议**：任何宿主部署都受益的（审批 SLA、水印）倾向采纳；推广期运营向的可不收——
  不收则定制侧自行拆除，双方都不留长期分叉。

---

## 4. 契约演进纪律（对下游定制的义务）

1. API / 事件 / 权限点 / CORS / authn 行为变更 → **发布说明标注行为变化与迁移指引**
   （定制侧以发布说明作为 merge 时的翻译层）。
2. selftest 是契约的可执行文档：改契约必须同步改断言（927 基线不回退）；lint:manifests 保持绿。
3. 定制面三包的 main 侧副本随受控回流更新，不单独演进。

---

## 5. 协作协议

- **定制 → main**：只接受 `docs/handoff-*.md` 清单（沿用 handoff-host-features-to-main.md 模板），
  按 cherry-pick + main 底座重放落地，每域 selftest + lint 后并入；不接受定制分支整分支 merge/push。
- **main → custom**：常规 git 流，定制侧按节奏 merge；main 无额外动作，
  但发布说明质量直接决定下游同步成本。
- **例行**：每次发版打 tag + 发布说明，并通知定制侧同步窗口。

---

## 6. 主分支自身路线（与双轨并行、不依赖定制侧）

- nas-authz 长期待办：系统账号组织建模（选项 B）、例外授权 90 天到期复审（2026-12 前后）。
- OIDC promptConsent 强制重授权后的授权快照运维观察。
- Skill 包替换生态（skill.updated / package_replaced）运营观察。
- 产品落地页与文档一致性维护（ff1a8de 已带核查与在线更新验证脚本）。
