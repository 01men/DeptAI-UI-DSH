# 组C · 前端完整性报告 —— A2A / UHP 验收（2026-10-20）

> 测试负责人：组C 前端完整性 QA
> 被测实例：`http://127.0.0.1:7311`（QA 实例，全程未重启 / 未 kill 任何进程；未触碰 7300/7301/7302）
> 被测变更：`packages/plugin-console/public/js/pages/a2a.js`（569 行，新增）+ `app.js` / `index.html` / `locales/{en-US,ja-JP}/10-shell-core.json` / `manifest/api.yaml` / `demo-mode.ts` / `routes/usage.ts` / `plugin-usage` / 新增 `plugin-a2a` + `plugin-uhp`
> 纪律：本轮**只测不改**，全程未修改任何源码。

---

## 1. 概述与实测手段说明

### 1.1 结论一句话

A2A 协作页三个分区（协作目录 / 任务追踪 / 履约视图）在**真实浏览器**里全部渲染成功、零 JS 报错、权限降级正确；但**后端新增的 15 个 REST 端点里有 8 个前端完全没有入口**（含 C4 协作链计量这一本轮主打新增端点），三语言只补了 4 个键、**119 条面向用户文案在 en-US / ja-JP 双双缺译**，加载屏权限点数写 94、后端真实只有 **92**。

### 1.2 实测手段分层（诚实标注）

| 手段 | 覆盖范围 | 说明 |
|---|---|---|
| **真浏览器（ZCode In-app Browser / Chromium 内核）** | A2A 页三 tab 渲染、任务抽屉、验收弹窗、护栏拦截、四账号降级、全站 22 个 hash 冒烟、JS 报错收集、截图 | `tab.playwright.domSnapshot()` / `evaluate()`。**限制**：该 IAB 后端的合成点击（`locator.click`）在本机一律 3s 超时，`force:true` 同样超时；所有点击改为**页面内 `element.click()` 程序化派发**。这不影响渲染/数据/权限结论，但「真实鼠标命中测试」这一项**未覆盖**（列入遗留）。 |
| **真实 HTTP（node fetch，`/tmp/qa/lib.mjs`）** | 21 个端点 × 6 账号状态码矩阵、响应体结构、JSON-RPC 四方法、SSE、验收写路径 | 命令与响应片段见 §3 / §4 |
| **静态代码审阅** | `a2a.js`、`app.js`、`i18n.js`、`plugin-a2a/src/index.ts`、`plugin-uhp/src/index.ts`、`plugin-iam` PermissionCatalog、`index.html`、三份词典 | 全部给 `文件:行号` |
| ~~jsdom~~ | 未使用 | 真浏览器可用，无需降级 |

### 1.3 测试账号与有效权限（实测自 `POST /api/auth/login` 返回的 `user.permissions`）

| 账号 | 角色 | A2A/UHP 相关权限点 |
|---|---|---|
| `admin` | 平台超级管理员 | `*` |
| `qa-a2aadmin` | QA协作管理员 | `a2a.directory.read`, `a2a.task.accept`, `a2a.admin`, `uhp.read`, `uhp.admin` |
| `qa-acceptor` | QA验收员 | `a2a.directory.read`, `a2a.task.accept` |
| `qa-collab` | QA协作观察员 | `a2a.directory.read`, `uhp.read` |
| `qa-member` | QA普通成员 | （无任何 a2a./uhp. 点） |
| `qa-ro` | QA资源只读 | `a2a.directory.read` |

---

## 2. A2A 页面功能清单与逐项验证表

### 2.1 页面声明的 UI 能力（源码清点：`a2a.js` 569 行）

| # | 能力 | 源码位置 | 依赖端点 | 权限点 |
|---|---|---|---|---|
| C1 | 页头：标题「A2A 协作」+ 长描述 + `.page-actions`（**空容器**） | `a2a.js:78-85` | — | — |
| C2 | 首次访问概念卡（`maybeShowConceptCard`） | `a2a.js:68-77` | — | — |
| C3 | 三 tab 切换（directory / tasks / fulfillment） | `a2a.js:86-94` | — | — |
| C4 | 目录·关键字搜索（300ms debounce） | `a2a.js:108,176` | `GET /api/a2a/directory?q=` | `a2a.directory.read` |
| C5 | 目录·自治级别筛选（A0-A3） | `a2a.js:109-112,177` | `?autonomy=` | 同上 |
| C6 | 目录·运行时筛选（按目录出现过的 runtime 回填） | `a2a.js:113,141-145,178` | `?runtime=` | 同上 |
| C7 | 目录·可承接密级筛选（public/internal/secret） | `a2a.js:114-117,179` | `?dataClass=` | 同上 |
| C8 | 目录卡片网格（头像/名称/slug/自治徽标/描述/技能前 4 + 「+N 项」/运行时/密级天花板/技能数/详情→） | `a2a.js:146-173` | `GET /api/a2a/directory` | 同上 |
| C9 | 员工详情抽屉（技能清单全量 + tags + 治理字段 + JSON-RPC 调用指引） | `a2a.js:184-217` | 复用目录数据 | 同上 |
| C10 | 任务·八态状态 chips（全部 + 8 态） | `a2a.js:267-271` | `GET /api/a2a/tasks?state=` | 同上 |
| C11 | 任务·目标员工下拉筛选 | `a2a.js:230-233,272` | `?agentId=` | 同上 |
| C12 | 任务表 9 列（任务ID/目标员工/状态/模式/密级/Token消耗/发起方/验收/创建）+ 行点击 | `a2a.js:247-263` | `GET /api/a2a/tasks?limit=100` | 同上 |
| C13 | 任务详情抽屉（状态说明 / 9 项 desc-grid / 任务消息 / 协商轮次与要约 / 交付物 / 历史时间线 / 交付验收区） | `a2a.js:277-332` | `GET /api/a2a/tasks/:taskId` | 同上 |
| C14 | 人工验收三重门（completed ∧ 未验收 ∧ `session.can('a2a.task.accept')`） | `a2a.js:287` | — | `a2a.task.accept` |
| C15 | 验收确认弹窗（理由必填护栏 + 通过/驳回） | `a2a.js:335-368` | `POST /api/a2a/tasks/:taskId/acceptance` | 同上 |
| C16 | 履约表 11 列（接收/完成/失败/中断/取消·驳回/完成率/验收通过率/平均耗时/P95/Token） | `a2a.js:385-408` | `GET /api/a2a/fulfillment` | `a2a.directory.read` |
| C17 | 一致性巡检摘要卡（巡检数 / 漂移数高亮 / findings 明细 / 保留份数） | `a2a.js:413-442` | `GET /api/a2a/patrols?limit=5` | 同上 |
| C18 | 各分区空态 / 错误态 | `a2a.js:137,262,318,407,439,475,491` | — | — |

### 2.2 逐项验证结果（全部为真浏览器或真实 HTTP 实测）

| # | 验证结论 | 证据 |
|---|---|---|
| **导航接线** | ✅ **真注册**，非仅文件存在 | `app.js:54` `renderA2a = lazy('./pages/a2a.js','renderA2a')`；`app.js:193` `builders` 中 `a2a: renderA2a`；`app.js:90` NAV「资源」组 `{ path:'#/a2a', label:'A2A 协作', perm:'a2a.directory.read' }`。真浏览器：admin 侧栏实测 25 个导航项，第 9 项为 `A2A Collaboration`；`location.hash='#/a2a'` 可直达并渲染 |
| C1 | ⚠️ 页头 `.page-actions` 是**空容器**（`innerHTML === ''`） | 真浏览器 `document.querySelector('.page-actions').innerHTML` → `""`；无任何页头操作按钮 |
| C2 | ✅ 首次访问弹概念卡，按钮 `data-concept-ok` 可见 | 浏览器快照含 `First time here · A2A 协作是什么？` + `button "Got it"` |
| C3 | ✅ 三 tab 均可切换并各自渲染 | `#/a2a?tab=directory|tasks|fulfillment` 三次渲染 `#page-content` 文本长度 615 / 5164 / 534，0 报错 |
| C4-C7 | ✅ 四个筛选项均已渲染且选项正确 | 快照：搜索框 `placeholder="搜索员工名称 / slug / 能力描述"`；自治下拉 `全部自治级别 / A0·只读应答 / A1·受控执行 / A2·自主执行 / A3·协商自治`；运行时下拉**自动回填** `全部运行时 / dsh / hermes`（`a2a.js:141-145` 生效）；密级下拉 `可承接任意密级 / 可承接「公开」/「内部」/「秘密」` |
| C8 | ✅ 6 张卡片全部渲染，字段绑定正确 | 实测目录返回 6 名员工（qa-a0-tip A0 dsh public、qa-a1-exec A1 dsh internal、qa-a2-auto A2 dsh internal、qa-a3-neg A3 hermes secret、qa-caller-bot A2 dsh internal、qa-a3-caller A3 hermes secret）；卡片显示自治徽标 / 描述 / `暂未声明技能` / 运行时 / 密级天花板 / 技能数 0。截图 `截图/a2a-directory-zh.png` |
| C9 | ✅ 抽屉可开 | 真实点击 `.res-card` 后抽屉渲染，含技能清单空态 + `发起协作：向 /api/agents/<slug>/a2a 发送 JSON-RPC（method=message/send），需 agent.a2a.invoke 权限` |
| C10 | ✅ 9 个 chips（全部 + 8 态）全部渲染 | 快照：`All / 已受理 / Executing / 待补充输入 / 待授权审批 / Completed / Execution failed / Cancelled / denied` |
| C11 | ✅ 6 个员工下拉项全渲染 | 快照含 `全部目标员工 / QA-A0提示型员工（qa-a0-tip）…` |
| C12 | ✅ 9 列表头 + 30 行数据全部渲染 | 表头 `Tasks / 目标员工 / Status / Mode / Classification / Token consumption / 发起方 / 验收 / Create`；数据行如 `mvg69w61ie0j… qa-a2-auto … Completed 执行 · 事后报告 Internal 120 / 30 user:usr_… — 1 min ago` |
| C12-字段映射 | ✅ **字段名对得上**（重点核对项） | 前端用 `task.inputTokens/outputTokens`（`a2a.js:254`）；后端 `A2aCollabService.taskView()`（`plugin-a2a/src/index.ts:810-837`）确实返回 `inputTokens/outputTokens/model/approvalId/acceptance/startedAt/negotiation/artifacts/history`。实测 union 键：`taskId,contextId,agentId,agentSlug,callerSubject,callerAutonomy,targetAutonomy,mode,state,stateReason,message,dataClass,artifacts,history,attempts,createdAt,finishedAt,responseId,inputTokens,outputTokens,model,startedAt`。未验收任务的 `inputTokens/outputTokens` 为 `undefined` → JSON 省略 → 前端 `?? 0` 兜底成 `0 / 0`，**语义正确**（被密级拒绝的任务本就没有 token 计量） |
| C13 | ✅ 抽屉全字段渲染 | 抽屉实测含：状态说明「任务完成（含交付物 1 项）」/ 任务 ID / 协作会话 / 目标员工 / 发起方 / 自治级别 A1→A2 / 模型 deepseek-chat·1 次 / Token 120入 30出 / 创建·开始执行·到达终态 / 任务消息 / 交付物 reply.txt(text/plain, 26B, 内容可见) / 历史时间线 3 条(Status/Completed、Status/Executing、消息) / 交付验收区 |
| **C14** | ✅ **验收门三重判定正确** | 抽屉 footer 按钮 id 集合：<br>· `qa-acceptor`(有 `a2a.task.accept`) → `['a2a-accept-accepted','a2a-accept-rejected']` ✅<br>· `qa-a2aadmin` → 同上 ✅<br>· `qa-collab`(**无** accept 权限) → `[]` ✅（**不点了才 403，点了才知**的要求满足）<br>· 已验收任务 / 非 completed 任务 → 实测 acceptanceBadge 只渲染徽标，无 footer 按钮 |
| **C15** | ✅ 写路径端到端可用 + 护栏前后端双拦 | 浏览器：点「验收通过」→ 弹窗含 `#a2a-accept-reason` textarea + `[data-ok]`（文案 `Confirm approval`）+ `[data-cancel]`（`Cancel`）；**空理由点击 → toast「验收必须填写理由（护栏要求）」×2，弹窗未关闭、未发请求** ✅<br>后端侧：`POST /api/a2a/tasks/:id/acceptance` body `{decision,reason}` **与前端 `a2a.js:357` 完全一致**；实测 `qa-acceptor` rejected→200、`qa-a2aadmin` accepted→200、`空 reason`→400 `验收必须填写理由（护栏要求）`、`qa-collab`→403 `缺少权限点 a2a.task.accept` |
| C16 | ✅ 11 列 4 行履约数据全部渲染 | 表头 `数字员工/接收/完成/失败/中断/取消·驳回/完成率/验收/平均耗时/P95 耗时/Token 消耗`；行如 `QA-A2自主型员工 qa-a2-auto 24 19 0 0 0/5 79.2% 15.8% 3过/0驳 5毫秒 17毫秒 2,280/570` |
| C17 | ✅ 巡检摘要卡渲染 | `一致性巡检（声明 ≤ 授权 · 能力漂移治理） / usr_…ukidnsk7vg · 2 分钟前 / 巡检员工 6 个 / 漂移 0 个 / 全部一致 / 已保留最近 5 份巡检报告…`；实测 `POST /api/a2a/patrol/run` 返回 `{checkedAgents:6, driftAgents:0, findings:[]}` 与前端字段一致 |
| C18 | ⚠️ 空态齐备但**无权限专属空态** | 空态文案均在字典命中（`暂无协作任务…`/`暂无协作履约数据…`/`暂无历史事件`/`暂无巡检报告…`）。但**无 a2a 域的权限降级组件**（详见 §4） |

### 2.3 反向核对：前端请求 → 后端是否都存在（404/405 实测）

前端 `a2a.js` 共 6 个请求点，全部命中已注册路由，**零 404**：

| 前端请求 | 后端注册位置 | 实测 |
|---|---|---|
| `GET /api/a2a/directory` | `plugin-a2a/src/index.ts:1081` | 200 |
| `GET /api/a2a/tasks` | `:1185` | 200（30 条） |
| `GET /api/a2a/tasks/:taskId` | `:1192` | 200 / 不存在时 404（正确） |
| `POST /api/a2a/tasks/:taskId/acceptance` | `:1198` | 200 |
| `GET /api/a2a/fulfillment` | `:1215` | 200 |
| `GET /api/a2a/patrols` | `:1249` | 200 |

---

## 3. 后端能力 vs 前端入口对账表（核心）

### 3.1 plugin-a2a 全量端点（14 条）

| # | 端点 | 方法 | 权限点 | 后端实测 | 前端入口 |
|---|---|---|---|---|---|
| 1 | `/.well-known/agent-card.json` | GET | 匿名 | 200 | ❌ 无（协议发现面，浏览器端不必展示，可接受） |
| 2 | `/.well-known/agents/:slug/agent-card.json` | GET | 匿名 | 200（不存在→404） | ❌ 无（同上，可接受） |
| 3 | `/api/a2a/directory` | GET | `a2a.directory.read` | 200 | ✅ `a2a.js:123,225` |
| 4 | `/api/agents/:slug/a2a` · `message/send` | POST(JSON-RPC) | `agent.a2a.invoke` | 200（造出 completed 任务+交付物） | ❌ **无「发起协作」入口** |
| 5 | 同上 · `message/stream` | POST(SSE) | `agent.a2a.invoke` | 未直测（路由同 4） | ❌ 无 |
| 6 | 同上 · `tasks/get` | POST(JSON-RPC) | `agent.a2a.invoke` | 200 | ❌ 无（前端走 REST 等价面，可接受） |
| 7 | 同上 · `tasks/list` | POST(JSON-RPC) | `agent.a2a.invoke` | 200 | ❌ 无（前端走 REST 等价面，可接受） |
| 8 | 同上 · `tasks/cancel` | POST(JSON-RPC) | `agent.a2a.invoke` | 200 语义（终态任务→`-32000 任务已终态（completed），不可取消`） | ❌ **无「取消任务」按钮** |
| 9 | `/v1/a2a/tasks/:taskId/events` | GET(SSE, `?token=`) | `agent.a2a.invoke` 或 `a2a.directory.read` | 200 `text/event-stream`（无 token→401，member→403） | ❌ **无实时进度订阅**（抽屉只能开一次快照） |
| 10 | `/api/a2a/tasks` | GET | `a2a.directory.read` | 200 | ✅ `a2a.js:239` |
| 11 | `/api/a2a/tasks/:taskId` | GET | `a2a.directory.read` | 200 | ✅ `a2a.js:280` |
| 12 | `/api/a2a/tasks/:taskId/acceptance` | POST | `a2a.task.accept` | 200 | ✅ `a2a.js:357` |
| 13 | `/api/a2a/fulfillment` | GET | `a2a.directory.read` | 200 | ✅ `a2a.js:376` |
| 14 | `/api/a2a/rules` | GET | `a2a.directory.read` | 200（返回 `{id,name,matchKeyword,enabled,createdBy}`） | ❌ **缺口** |
| 15 | `/api/a2a/rules` | POST | `a2a.admin` | 200（member/collab/acceptor → 403） | ❌ **缺口** |
| 16 | `/api/a2a/rules/:id` | DELETE | `a2a.admin` | 404（不存在）/ 403（无权限） | ❌ **缺口** |
| 17 | `/api/a2a/patrol/run` | POST | `a2a.admin` | 200 `{checkedAgents:6,driftAgents:0,findings:[]}` | ❌ **缺口** |
| 18 | `/api/a2a/patrols` | GET | `a2a.directory.read` | 200 | ✅ `a2a.js:379` |

（18 行 = 14 条 REST/协议端点中 JSON-RPC 展开为 5 个方法后的条目数）

### 3.2 plugin-uhp 全量端点（9 条）—— 前端 **0 入口**

| # | 端点 | 方法 | 权限点 | 后端实测 | 前端入口 |
|---|---|---|---|---|---|
| 19 | `/v1/uhp`（discovery：version / conformance_class / capabilities / harnesses） | GET | 匿名 | 200 | ❌ 无 |
| 20 | `/v1/uhp/responses` | POST | `uhp.invoke` | 200 语义（admin 带 `*`→进到业务层报 `执行体不存在：x`；无权限→403） | ❌ 无 |
| 21 | `/v1/uhp/responses/:id` | GET | `uhp.invoke` | 404（不存在） | ❌ 无 |
| 22 | `/v1/uhp/responses/:id/cancel` | POST | `uhp.invoke` | 400 `response 不存在：nope`；无权限→403 | ❌ 无 |
| 23 | `/api/uhp/harnesses` | GET | `uhp.read` | 200（admin/collab 200；member/acceptor/a2aadmin 中的非 uhp.read 者 403） | ❌ 无 |
| 24 | `/api/uhp/harnesses` | POST | `uhp.admin` | 400 `Agent 不存在：nope（harness 必须绑定真实 Agent 资产）` | ❌ 无 |
| 25 | `/api/uhp/harnesses/:id` | PATCH | `uhp.admin` | 404 / 403 | ❌ 无 |
| 26 | `/api/uhp/harnesses/:id` | DELETE | `uhp.admin` | 404 / 403 | ❌ 无 |
| 27 | `/api/uhp/responses` | GET | `uhp.read` | 200（`{total,items[]}`，含 `usage.input_tokens/output_tokens`、`harness_id`、`metadata.ybk_agent_id`） | ❌ 无 |

> `grep -rn "api/a2a\|api/uhp\|/v1/uhp\|/v1/a2a" packages/plugin-console/public/` 实测输出**只有 8 行，全部在 `a2a.js`**，`/api/uhp`、`/v1/uhp`、`/v1/a2a` 在整个前端**零引用**。

### 3.3 usage 域本轮新增端点（C4 协作链计量）—— 前端 **0 入口**

| # | 端点 | 方法 | 权限点 | 后端实测 | 前端入口 |
|---|---|---|---|---|---|
| 28 | `/api/usage/collaborations?days=&limit=` | GET | `usage.read` | 200：`{from, top:[{contextId,events,tokens,cost_cents,charge_cents,firstAt,lastAt}]}` | ❌ **缺口（本轮主打新增端点）** |
| 29 | `/api/usage/collaborations?context=<id>` | GET | `usage.read` | 200：`{contextId, events:[{…contextId, meters:[calls/input_tokens/output_tokens], pricing…}]}` | ❌ **缺口** |

> `grep -rn "usage/collaborations" packages/plugin-console/public/` → **无匹配**。
> `packages/plugin-console/public/js/pages/usage.js:21` 是全页唯一的 usage 请求（`/api/usage/report?days=28&dim=…`）。
> `manifest/api.yaml` 第 20 行已登记该端点，说明**契约侧认为它是控制台能力**。
> 附带：`plugin-a2a/src/index.ts` 第 214 行告诉用户「向 `/api/agents/<slug>` 发 JSON-RPC 需 `agent.a2a.invoke`」，但**控制台内没有任何地方能进入这条链路**，用户被引导到一个 UI 完全不支持的操作上。

### 3.4 「后端已实现但前端无入口」缺口清单（8 条，按建议优先级）

| 缺口 | 端点 | 权限点 | 建议 UI 位置 | 优先级 |
|---|---|---|---|---|
| **G1** | `GET /api/usage/collaborations` | `usage.read` | `pages/usage.js` 新增「协作链」tab，或 `pages/a2a.js` 履约视图上方加「协作链成本」卡片（contextId 可点跳转任务追踪 tab） | **P1**（本轮 C4 主打端点，manifest 已登记） |
| **G2** | `GET /api/a2a/rules` | `a2a.directory.read` | `pages/a2a.js` 新增第 4 个 tab「审批规则」 | **P1**（read 面，人人有权限却完全不可见） |
| **G3** | `POST /api/a2a/rules` | `a2a.admin` | 同 G2 tab 内「新增规则」按钮 + 表单（name / matchKeyword / matchDataClassAtLeast） | **P1** |
| **G4** | `DELETE /api/a2a/rules/:id` | `a2a.admin` | 同 G2 tab 列表行删除 | **P1** |
| **G5** | `POST /api/a2a/patrol/run` | `a2a.admin` | 履约视图 `.page-actions`（当前空容器 `a2a.js:84`）放「立即巡检」按钮；`session.can('a2a.admin')` 控制显隐 | **P1** |
| **G6** | `GET /api/uhp/harnesses`（+ POST/PATCH/DELETE） | `uhp.read` / `uhp.admin` | 建议挂在 `pages/agents.js` 的 Agent 详情「UHP harness」段，或 A2A 页第 4 tab | **P2** |
| **G7** | `GET /api/uhp/responses` | `uhp.read` | 同 G6 页的「执行记录」表 | **P2** |
| **G8** | `GET /v1/uhp`（discovery）、`POST /v1/uhp/responses`、`GET/CANCEL /v1/uhp/responses/:id` | 匿名 / `uhp.invoke` | 协议执行面，前端可不展示；但至少在 A2A 页加一条「协议面：/v1/uhp（uhp.invoke）」的能力说明 | **P3** |
| （另）G9 | `POST /api/agents/:slug/a2a` `message/send` / `tasks/cancel` | `agent.a2a.invoke` | 任务详情抽屉 foot 加「取消任务」（仅非终态 ∧ 有权时）；「发起协作」建议在员工详情抽屉加（输入框 + 密级下拉） | **P2** |
| （另）G10 | `GET /v1/a2a/tasks/:taskId/events`（SSE） | `agent.a2a.invoke` / `a2a.directory.read` | 抽屉打开时 `EventSource` 订阅，实时刷新进度 | **P3**（体验增强） |

**小结**：后端 27 条端点中前端有入口的 6 条（22%）；`plugin-uhp` 9 条端点前端 0 覆盖。

---

## 4. 多账号权限降级实测（真浏览器）

| 账号 | 导航可见 | 直达 `#/a2a` | 抽屉 | 验收按钮 | 判定 |
|---|---|---|---|---|---|
| `admin` | ✅ 25 项，含 A2A Collaboration | ✅ 正常渲染 | ✅ | ✅ 2 个 | PASS |
| `qa-a2aadmin` | ✅ 7 项，含 A2A | ✅ 正常渲染 | ✅ | ✅ 2 个 | PASS |
| `qa-acceptor` | ✅ 7 项，含 A2A | ✅ 正常渲染 | ✅ | ✅ 2 个 | PASS |
| `qa-collab` | ✅ 11 项，含 A2A | ✅ 正常渲染 | ✅ | ✅ **0 个（正确隐藏）** | **PASS 带 P2 建议** |
| `qa-member` | ✅ 6 项，**A2A 项已隐藏**（`app.js:90` perm 过滤生效） | ⚠️ 显示统一错误卡 | n/a（无数据行） | n/a | PASS |

### 4.1 `qa-member` 深链降级（正面）

实测 `#page-content` 全文：
```
🚫 | Failed to load page | Missing permission point a2a.directory.read. Contact your administrator to adjust the role. | Retry
```
- 不是白屏、不是空白、不是无限 loading ✅
- 由 `app.js:316-325` 的页面级兜底渲染，含「重试」按钮 ✅
- 与既有页降级写法一致（`app.js:122-131` 同一模板）✅

### 4.2 `qa-collab` 只读协作面（唯一 P2 建议）

- ✅ **按钮级降级正确**：`a2a.directory.read` 无 → 验收按钮 0 个，用户不会「点了才 403」
- ⚠️ **缺少权限感知提示**：抽屉底部**仍然显示**
  `任务已完成，等待人工验收：完成 ≠ 业务闭环，验收通过才归档。`
  但没有任何按钮。观察员被告知「该验收了」却找不到入口，也看不到「你缺少 `a2a.task.accept` 权限」。
- 对照既有页面写法：`pages/agents.js` / `pages/usage.js` 在无权限时用的是 `page-actions` 隐藏 + 数据区空态（`emptyState`），A2A 页**没有**这一层。建议：
  ```js
  // 建议（未改源码）：acceptanceSection(task, canAccept)
  // canAccept=false 且 session.can('a2a.task.accept') 时，改为
  //   「任务已完成，等待人工验收（你当前无 a2a.task.accept 权限，请联系协作管理员验收）」
  ```
- ⚠️ **`a2a.admin` 能力对 admin / qa-a2aadmin 完全不可见**：巡检卡只读展示，无「立即巡检」按钮（G5），规则无任何入口（G2-G4）——这是「无入口」而非「无降级」。

### 4.3 权限点与路由的实测一致性矩阵（真实 HTTP）

| 端点 | admin | qa-member | qa-collab | qa-a2aadmin | qa-acceptor | anon |
|---|---|---|---|---|---|---|
| `GET /api/a2a/directory` | 200 | **403** | 200 | 200 | 200 | 403 |
| `GET /api/a2a/tasks` | 200 | 403 | 200 | 200 | 200 | 403 |
| `GET /api/a2a/tasks/:id`（不存在） | 404 | 403 | 404 | 404 | 404 | 403 |
| `GET /api/a2a/fulfillment` | 200 | 403 | 200 | 200 | 200 | 403 |
| `GET /api/a2a/rules` | 200 | 403 | 200 | 200 | 200 | 403 |
| `POST /api/a2a/patrol/run` | 200 | 403 | **403** | 200 | **403** | 403 |
| `POST /api/a2a/rules` | 200 | 403 | **403** | 200 | **403** | 403 |
| `DELETE /api/a2a/rules/:id` | 404 | 403 | 403 | 404 | 403 | 403 |
| `POST /api/agents/:slug/a2a` | 200 | 403 | **403** | **403** | **403** | 403 |
| `GET /v1/a2a/tasks/:id/events?token=` | 200 | **403** | 200 | — | — | 无 token→401 |
| `GET /api/uhp/harnesses` | 200 | 403 | 200 | 200 | **403** | 403 |
| `GET /api/uhp/responses` | 200 | 403 | 200 | 200 | 403 | 403 |
| `POST /api/uhp/harnesses` | 400（业务） | 403 | 403 | 400（业务） | 403 | 403 |
| `POST /v1/uhp/responses` | 404（业务） | 403 | 403 | 403 | 403 | 403 |
| `GET /.well-known/agent-card.json` | 200 | 200 | 200 | 200 | 200 | **200（设计如此）** |
| `GET /v1/uhp` | 200 | 200 | 200 | 200 | 200 | **200（设计如此）** |

✅ **未发现任何「前端会请求但后端放行越权」的洞**；权限矩阵与角色声明完全吻合。

---

## 5. 三语言完整性

### 5.1 i18n 引擎机制（决定验收口径）

`public/js/i18n.js` 采用 **DOM 级 MutationObserver + 文本节点整词精确匹配**（`i18n.js:60-64, 96-118`），键 = 中文原文。
- 因此 **`a2a.js` 硬编码中文本身不是缺陷**，只要键在词典里就能被翻译；
- **但只有 `zh-CN` / `en-US` / `ja-JP` 三个 locale 目录**（无 `zh-CN/` 目录，中文即源语言，无词典）。

### 5.2 本轮改动面核对

| 项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| `app.js` NAV 新增项 | label `'A2A 协作'` | `app.js:90` 硬编码，无 `t()` | ✅ 依赖 DOM 引擎，可翻译 |
| `a2a.js` 三个 tab | `协作目录 / 任务追踪 / 履约视图` | `a2a.js:87-89` 硬编码，无 `t()` | ✅ DOM 引擎翻译成功 |
| `en-US/10-shell-core.json` | 补 4 键 | **已补**：`A2A 协作`→`A2A Collaboration`、`协作目录`→`Collaboration Directory`、`任务追踪`→`Task Tracking`、`履约视图`→`Fulfillment` | ✅ |
| `ja-JP/10-shell-core.json` | 补 4 键 | **已补**：`A2A 協作` / `協作ディレクトリ` / `タスク追跡` / `履行ビュー` | ✅ |
| 真浏览器验证 | 4 键真的生效 | 快照中 `A2A Collaboration` / `Collaboration Directory` / `Task Tracking` / `Fulfillment` 全部为英文 | ✅ |

### 5.3 三份词典键集合差异

`GET /locales/en-US` 与 `GET /locales/ja-JP` 实测：
```
locale=en-US count=5169 actual keys=5169
locale=ja-JP count=5169 actual keys=5169
en-US only keys: 0
ja-JP only keys: 0
```
✅ **两语键集合完全一致，无单边缺失**。（无 zh-CN 词典目录属设计，非缺失。）

### 5.4 `a2a.js` 词典覆盖率（静态提取 153 条面向用户中文短语）

| 指标 | 数值 |
|---|---|
| 提取到的面向用户中文短语（含拼接片段） | 153 |
| **en-US 缺失** | **119（77.8%）** |
| **ja-JP 缺失** | **119（77.8%）** |
| 仅 en 缺 / ja 有（或反之）的键 | **0**（两语同进同退） |
| 已被翻译的通用词 | 34（如 已完成/已取消/公开/内部/秘密/任务/模式/密级/Token 消耗/创建/全部/详情 →/运行时…） |

**结论：本轮 4 个键只覆盖了「页面外壳 4 个词」，页面主体（表格列、筛选器、状态标签、抽屉、验收弹窗、巡检卡）几乎全部未补词。**

### 5.5 真浏览器实测的未翻译文案（locale=en-US，`#page-content` 内）

**任务追踪 tab**（16 条文本节点 + 2 条属性）：
```
已受理 · 待补充输入 · 待授权审批 · 全部目标员工 · 目标员工 · 发起方 · 验收
单轮问答 · 双向协商 · 执行 · 事后报告
title="输入 / 输出" · title="人工验收结论"
```

**履约视图 tab**：
```
数字员工 · 接收 · 完成 · 失败 · 中断 · 取消/驳回 · 完成率 · 验收 · 平均耗时 · P95 耗时 · Token 消耗
一致性巡检（声明 ≤ 授权 · 能力漂移治理） · 巡检员工 · 漂移 · 全部一致 · 已保留最近 5 份巡检报告，此处展示最新一份。
title="待补充输入 + 待授权审批" · title="验收通过 3 · 验收驳回 0"
```

**任务详情抽屉 + 验收弹窗**：
```
协作任务 · 状态说明 · 任务 ID · 协作会话 · 开始执行 · 到达终态 · 任务消息 · 交付物（1）· 历史时间线
交付验收 · 验收驳回 · 验收理由 · 验收结论是任务归档口径：验收不轻信员工自报，由人做最终判断
任务已完成，等待人工验收：完成 ≠ 业务闭环，验收通过才归档。
title="人工验收结论" · title="导航菜单"
```

**协作目录 tab**（首屏截图可见）：
```
搜索员工名称 / slug / 能力描述 · 全部自治级别 · 全部运行时 · 可承接任意密级 · 可承接「公开」…
暂未声明技能 · 密级天花板（可承接的最高任务密级） · 技能数 · A0 · 只读应答 …
页头长描述「数字员工跨运行时协作面：能力目录发现、协作任务全链路追踪…」
```

### 5.6 附带发现：既有词典词条语义不佳（被 A2A 页放大）

| 中文键 | en-US 现译 | ja-JP 现译 | 在 A2A 页的表现 |
|---|---|---|---|
| `已拒绝` | **`denied`** | 拒否 | 状态 chip 显示 `denied`，与按钮语义混淆 |
| `验收通过` | **`accepted`** | 検収通過 | **验收主按钮文案变成裸协议词 `accepted`**（截图/DOM 实测），而并列的 `验收驳回` 完全没译 → 同一按钮组一中一英 |
| `确认通过` | Confirm approval | 承認を確定 | OK |
| `已取消` | Cancelled | キャンセル済み | OK |

### 5.7 加载屏文案与词典脱钩

| 位置 | 文案 | 状态 |
|---|---|---|
| `index.html:28` 静态 zh 文案 | `正在装载 29 个插件包 · 94 个权限点 · 448 个 REST 路由 · 83 个 MCP 工具` | 当前值 |
| `index.html:55-57` 内联 `T` 映射 zh/en/ja | 同上三语（含 `94 permission points` / `94 権限ポイント`） | ✅ 自洽，**真实渲染正确**（内联脚本先于 i18n 词典执行） |
| `locales/en-US/10-shell-core.json:3` | 键仍为 **`正在装载 27 个插件包 · 84 个权限点 · 354 个 REST 路由 …`** → 值 `Loading 27 plugin packages · 84 permission points …` | ❌ **陈旧键，与 index.html 当前文案完全对不上** |
| `locales/ja-JP/10-shell-core.json:3` | 同样停留在 27/84/354 | ❌ 同上 |

> git 证据：`479735c chore(console): 加载屏文案权限点数 84 → 85（zh/en/ja 三语同步）` 把 index.html 改成 85，但 **词典被改成了 84 → 85 的旧基线**；随后工作区又把 index.html 推到 94，**词典从此再没跟上**。实测两份词典里 `85` 和 `94` 两种串**都不存在**，只有 `84` 一种。
> 影响面：加载屏实际显示由内联脚本负责（三语正确），所以**当前无用户可见故障**；但这是**死键 + 陈旧数据**，一旦有人删掉内联脚本改回 `rqI18n.t()` 就会立刻暴露错误数字。

---

## 6. 权限点数一致性核对（重点：本轮改动面）

| 来源 | 数值 | 证据 |
|---|---|---|
| **后端运行时真实值** | **92** | `GET /api/iam/permissions` → `data.catalog.length = 92`（admin 实测）。24 个权限组，含 `A2A 协作`(3) + `UHP 执行驱动`(3) |
| 后端静态推导 | 92 | `plugin-iam/src/index.ts` PermissionCatalog 数组内 `point:` **86** 项 + `plugin-a2a` push **3** + `plugin-uhp` push **3** = 92。`plugin-agent` 的 `exec.read/exec.write`（`plugin-agent/src/index.ts:782-783`）已包含在 IAM 的 86 内（`plugin-iam/src/index.ts:328-329`），幂等 push 不增计数 |
| **`index.html` 声明** | **94** | `index.html:28` 与 `index.html:55-57`（zh/en/ja 三语一致） |
| **差值** | **+2（前端虚高）** | ❌ **不对齐** |
| 任务书描述的预期 | 「后端新增 A2A 4 个 + UHP 3 个」 | 实际后端新增 **A2A 3 个**（`a2a.directory.read` / `a2a.task.accept` / `a2a.admin`，`plugin-a2a/src/index.ts:1056-1060`）+ **UHP 3 个**（`uhp.read` / `uhp.admin` / `uhp.invoke`，`plugin-uhp/src/index.ts:560-564`）= **6 个，不是 7 个**。若按「84 + 6 = 90」推算也到不了 94 |
| 插件包数 | `index.html` 29 == `ls packages/` 29 ✅ | 但 `/api/platform/info` 实测 `plugins` 只有 **18** 个（缺 connector / flow-core / exec-hub / workforce / uhp / a2a / portal / dsh-bridge / rq-card / platform-i18n）。`pages/platform.js` 用它渲染 → 「插件与工具」页显示 **"18 plugins online"**，与加载屏「29 个插件包」对不上 |
| REST 路由数 | `index.html` 448 vs 静态扫描去重后 **456** 个 `method+path` 注册 | ⚠️ 计数口径可能不同（含非 HTTP 面/条件注册），**列为 P2 待确认**，不作为缺陷定论 |
| MCP 工具数 | 83，未核对 | — |

**判定：权限点数 94 ≠ 92，确认为 P1 缺陷**（加载屏是公网首发页第一屏，且本轮两次改动都只动了它，说明这块缺乏自动化断言）。

> 补充：`scripts/selftest.mjs` 中**没有任何断言锁定加载屏三数**（grep `ybkBootStats|个权限点|REST 路由` 零命中），所以 84→85→94 的漂移不会被门禁拦住。

---

## 7. 断言结果一览

| ID | 断言 | 结果 | 证据类型 |
|---|---|---|---|
| A-01 | `#/a2a` hash 路由真实注册到 `a2a.js` | ✅ PASS | `app.js:54,90,193` + 真浏览器侧栏 25 项含 A2A + 直达渲染 |
| A-02 | A2A 页面 3 个 tab 均可渲染 | ✅ PASS | 真浏览器 615/5164/534 字符，0 报错 |
| A-03 | 目录 6 张卡片数据绑定正确 | ✅ PASS | 真浏览器 DOM + `截图/a2a-directory-zh.png` |
| A-04 | 任务表 9 列 30 行渲染、字段名对得上 | ✅ PASS | 真浏览器 DOM + `taskView` 静态核对 |
| A-05 | 任务详情抽屉全字段渲染 | ✅ PASS | 真浏览器抽屉全文 |
| A-06 | 履约 11 列 + 巡检卡渲染 | ✅ PASS | 真浏览器 DOM |
| A-07 | 验收三重门（状态 ∧ 未验收 ∧ 权限）正确 | ✅ PASS | 4 账号按钮 id 集合实测 |
| A-08 | 验收理由必填护栏前端生效 | ✅ PASS | 空理由点击 → toast×2，弹窗未关 |
| A-09 | 验收写路径 `{decision,reason}` 前后端契约一致 | ✅ PASS | `a2a.js:357` vs `plugin-a2a:1199`，实测 200/400/403 |
| A-10 | 前端 6 个请求端点后端均存在（零 404） | ✅ PASS | 真实 HTTP |
| A-11 | 后端 27 端点权限矩阵与角色声明一致 | ✅ PASS | 状态码矩阵 |
| A-12 | `qa-member` 导航隐藏 + 深链降级非白屏 | ✅ PASS | 真浏览器 |
| A-13 | `qa-collab` 验收按钮正确隐藏 | ✅ PASS | 真浏览器 0 按钮 |
| A-14 | 22 个 hash 全页面冒烟零 JS 报错 | ✅ PASS | 真浏览器 `window.onerror`/`unhandledrejection`/`console.error` 收集器全 0 |
| A-15 | 4 个新 locale 键在 en-US/ja-JP 都已补齐且生效 | ✅ PASS | 静态 + 真浏览器 |
| A-16 | en-US / ja-JP 键集合无单边差异 | ✅ PASS | 5169 = 5169，差集 0 |
| A-17 | **`a2a.js` 全部面向用户文案已补三语** | ❌ **FAIL** | **119/153 缺失，两语同缺** |
| A-18 | **加载屏权限点数 = 后端真实值** | ❌ **FAIL** | **index.html 94 vs 后端 92** |
| A-19 | 加载屏词典键与 index.html 文案一致 | ❌ FAIL | 词典仍停在 27/84/354 |
| A-20 | **后端新增端点均有前端入口** | ❌ **FAIL** | **27 端点仅 6 条有入口；缺口 8 条（G1-G8）** |
| A-21 | `a2a.admin` 能力在 UI 可见（规则增删 / 立即巡检） | ❌ FAIL | `.page-actions` 为空，巡检卡只读 |
| A-22 | `uhp.read`/`uhp.admin`/`uhp.invoke` 能力在 UI 可见 | ❌ FAIL | 前端零 `/api/uhp` 引用 |
| A-23 | `/api/usage/collaborations`（C4 主打端点）有 UI 入口 | ❌ FAIL | 前端零引用，manifest 已登记 |
| A-24 | 只读账号（collab）无权限区块有明确降级提示 | ⚠️ PARTIAL | 按钮隐藏 PASS，文案仍诱导「等待人工验收」FAIL |
| A-25 | 无「前端有后端无」的悬空请求 | ✅ PASS | 零 404 |
| A-26 | 插件数口径一致（加载屏 29 vs 插件页 18） | ❌ FAIL | `/api/platform/info` 实测 |

**汇总：26 条断言 —— PASS 15 / FAIL 10 / PARTIAL 1**

---

## 8. 缺陷清单

### P0
无。未发现白屏、越权、悬空请求、数据错误或崩溃。

### P1

| ID | 缺陷 | 位置 | 影响 | 证据 |
|---|---|---|---|---|
| **C-1** | **后端已实现能力前端无入口（G1-G5，5 条）**：C4 协作链计量 `/api/usage/collaborations`、A2A 审批规则 GET/POST/DELETE、`POST /api/a2a/patrol/run` 全部无入口 | `pages/usage.js`、`pages/a2a.js`（`.page-actions` 为空 `a2a.js:84`） | 持 `a2a.admin` 的协作管理员在 UI 上**没有任何治理动作**；`a2a.admin` 权限点在控制台里形同虚设；本轮 C4 端点 manifest 已登记却零 UI | grep 零引用 + 真浏览器 `.page-actions.innerHTML === ""` + 端点 200 实测 |
| **C-2** | **`plugin-uhp` 9 条端点前端 0 覆盖（G6-G7，2 组）** | 全前端 | `uhp.read`/`uhp.admin` 两个权限点在控制台无任何落点；Agent 详情看不到自己的 harness 绑定与执行记录 | `grep -rn "api/uhp\|/v1/uhp" packages/plugin-console/public/` 零命中 |
| **C-3** | **加载屏权限点数 94 ≠ 后端真实 92** | `index.html:28,55,56,57` | 公网首发第一屏传播错误产品数字；本轮已两次漂移（84→85→94） | `GET /api/iam/permissions` → 92；静态 86+3+3=92 |
| **C-4** | **`a2a.js` 三语覆盖仅 22%，119 条面向用户文案在 en-US 与 ja-JP 双双缺译** | `a2a.js` 全文；建议落 `locales/{en-US,ja-JP}/10-shell-core.json` | 英文/日文用户进入 A2A 页看到的是**中英日混杂界面**：表头、筛选器、状态 chip、抽屉、验收弹窗、巡检卡全中文 | 真浏览器 locale=en-US 采集 16 条文本 + 2 属性（任务 tab）、28 条（履约 tab）、20+ 条（抽屉+弹窗） |
| **C-5** | **只读账号无验收权限时，文案仍写「等待人工验收」但无按钮、无权限说明** | `a2a.js:462-476`（`acceptanceSection`）、`a2a.js:287`（`canAccept`） | `qa-collab` 观察员被引导去执行自己无权执行的动作，且不知道原因 | 真浏览器 qa-collab 抽屉：按钮 0 个 + 仍显示 `任务已完成，等待人工验收：完成 ≠ 业务闭环，验收通过才归档。` |

### P2

| ID | 缺陷 | 位置 | 影响 |
|---|---|---|---|
| **C-6** | 加载屏词典死键：`en-US`/`ja-JP` 的启动文案键仍为 `27 个插件包 · 84 个权限点 · 354 个 REST 路由`，与 `index.html` 当前 `29/94/448` 完全脱钩 | `locales/*/10-shell-core.json:3` | 当前无用户可见故障（内联脚本先行渲染），但陈旧键一旦被复活即显示错误数字 |
| **C-7** | 既有词典词条语义不佳：`已拒绝`→`denied`（状态 chip 变成裸协议词）、`验收通过`→`accepted`（**验收主按钮在英文界面显示 `accepted`**，与并列的 `验收驳回` 完全不译，一一中英） | `locales/*/10-shell-core.json` | 英文界面验收按钮组割裂 |
| **C-8** | 插件数口径不一致：加载屏「29 个插件包」 vs `/api/platform/info` 返回 18 个 → 「插件与工具」页显示 `18 plugins online` | `index.html:28` vs `plugin-console` `/api/platform/info` | 用户在同一产品内看到两个插件数 |
| **C-9** | 加载屏 REST 路由数 448 vs 静态去重注册 456（差 8） | `index.html:28` | 口径待确认；若属实同样是错误数字 |
| **C-10** | 无「发起协作」「取消任务」入口（G9）：`a2a.js:214` 主动告诉用户去调 `POST /api/agents/<slug>/a2a`，但控制台不提供任何路径 | `a2a.js:211-215`（抽屉提示）+ `a2a.js:321-324`（抽屉 foot） | 用户被引导到 UI 完全不支持的操作；任务无法在 UI 取消 |
| **C-11** | 无 SSE 实时进度（G10）：抽屉只取一次快照 | `a2a.js:280` | 长任务在抽屉里看不到推进，只能反复关开 |
| **C-12** | REST 路由数无自动化断言保护 | `scripts/selftest.mjs`（grep 零命中） | 84→85→94 的漂移不会被门禁拦住，本轮已实漂移两次 |
| **C-13** | `.page-actions` 空容器占位但永不渲染内容 | `a2a.js:84` | 未来补「立即巡检」等页头操作时容易漏掉 |

---

## 9. 通过项摘要

1. **导航接线真实可用**——不是「文件在就算数」，`app.js` 的 lazy import + builders + NAV 三处齐备，真浏览器侧栏可见、可直达。
2. **数据源全部喂得饱**——6 个请求端点的返回结构与 `a2a.js` 消费的字段名**逐一核对无误**，包括易漏的 `inputTokens/outputTokens/model/approvalId/acceptance/startedAt/negotiation/artifacts/history`。未验收任务的 `?? 0` 兜底语义正确。
3. **验收三重门设计到位**——「完成 ≠ 业务闭环」在 UI 上真落地：只有 `completed ∧ 未验收 ∧ 持 a2a.task.accept` 才出按钮；理由必填护栏**前后端双拦**（前端 toast + 后端 400）。
4. **权限降级不白屏**——`qa-member` 深链直达得到统一错误卡 + 重试按钮，与 `app.js` 全站兜底模板一致。
5. **无权限按钮正确隐藏**——`qa-collab` 的验收按钮实测 0 个，不存在「点了才 403」。
6. **零悬空请求**——前端 6 个端点全部命中；21 端点 × 6 账号矩阵中未发现越权放行。
7. **权限矩阵与角色声明 100% 吻合**——`a2a.admin` / `a2a.task.accept` / `uhp.*` / `agent.a2a.invoke` 各自 403 边界正确。
8. **全站 22 个 hash + A2A 3 tab 冒烟零 JS 报错**（`window.onerror` / `unhandledrejection` / `console.error` 三重收集器全为 0）。
9. **en-US / ja-JP 词典键集合完全对齐**（5169 = 5169，差集 0），本轮新增的 4 个 A2A 键真实生效。
10. **demo-mode 白名单纪律正确**——`a2a.directory.read` / `uhp.read` 进白名单，5 个写/执行类权限点全部未进，且有 405 闸门双保险。

---

## 10. 风险与遗留

| 项 | 说明 |
|---|---|
| **合成点击未覆盖** | 本机 IAB 后端的 `locator.click()` 一律 3s 超时（含 `force:true`），所有点击改为页面内 `element.click()` 派发。渲染 / 数据 / 权限结论不受影响，但**真实鼠标命中、hover 态、焦点序、键盘可达性未测**。 |
| **无 hover / 键盘导航测试** | 任务表行 hover 态、抽屉 Esc 关闭、tab 键盘切换等未覆盖。 |
| **无移动端断点测试** | `app.js` 有 ≤1024px 抽屉导航分支，未在窄视口验证 A2A 页 9 列表格的横向滚动。 |
| **协商分支无样本数据** | 数据集中 `negotiation` 字段恒缺失，A2A 详情抽屉的「协商轮次 / 要约 / 还价」区块（`a2a.js:478-492`）**只有静态审阅，无实测渲染证据**。建议补一条 A3×A3 协商任务后复测。 |
| **`approvalId` / `auth_required` 分支无样本** | 审批挂起分支同样只有静态审阅。 |
| **无 `qa-ro` 账号的 UI 降级截图** | `qa-ro` 有 `a2a.directory.read` 但无 `a2a.task.accept`/`uhp.*`，预期与 `qa-collab` 同型，未单独跑浏览器（HTTP 层已验证）。 |
| **REST 路由数 448 vs 456** | 静态扫描口径可能包含非 HTTP 面、条件注册或测试专用路由，**未取得权威口径**，暂不定性为缺陷。 |
| **i18n 覆盖率按「文本片段」统计** | 119/153 中的部分条目是长句被切分后的片段（如 `八态状态机 + 协商 + 人工验收`），逐条人工核对过，实际「需人工补词的用户可见原子串」约 **70-80 条**。 |
| **测试数据污染** | 本轮在共享 QA 实例上创建了 4 条 A2A 任务（3 completed + 1 终态）、1 条规则（`C组规则` ×2，admin 与 qa-a2aadmin 各一）、4 份巡检报告、2 条验收记录。**未清理**，供后续复现。 |
| **`/tmp/qa/c/` 下临时脚本** | 全部探针脚本与证据矩阵留在 `/tmp/qa/c/`（`endpoints.mjs` / `matrix.json` / `i18n-audit.mjs` / `dict-en.json` / `dict-ja.json`），仓库内零新增文件（除本报告与两张截图）。 |

### 建议修复顺序
1. **C-3 / C-12**（权限点数 + 加门禁断言）——半小时内可闭环，且是公网第一屏。
2. **C-1**（G1-G5 五个入口）——`a2a.admin` 权限点当前在 UI 上完全无效，是本轮交付的最大功能缺口。
3. **C-4 + C-7**（补 ~80 条三语词条 + 修 `已拒绝`/`验收通过` 两条语义）——可与 C-1 同批做，因为新增 tab 的文案也要一起进词典。
4. **C-5**（只读账号验收区降级文案）——一行改动。
5. **C-2 / C-8 / C-10 / C-11**——下一迭代。

---

*报告完*
