# 组C 分报告 · 前端展示完整性

- **实例**：`http://127.0.0.1:7343`（数据 `data-qa-gC-20261021`，stub `7443`）
- **判定**：**17 / 20 通过**
- **执行脚本**：`qa-runtime-20261021/group-c.mjs` ｜ **结果**：`result-C.json` ｜ **日志**：`run-C.log`
- **方法**：静态对账（源码/词典/manifest）+ jsdom 模块加载 + `scripts/page-smoke.mjs` 全页冒烟

## 一、结论

上一轮「前端只落了 22% 新能力」的结论**已被推翻**：后端 17 个 A2A/UHP 治理端点**全部有前端入口**（17/17），`/api/usage/collaborations` 已接线并渲染协作链区块，加载屏三数与后端真实值一致，裸协议词词典问题已修。剩余缺口是**三语差 7 条**（93.5%）与**未接入 SSE**（Q-15 未修）。

## 二、端点接线对账（17/17）

| 端点 | 前端证据 |
|---|---|
| `GET /api/a2a/directory` | 目录区块 |
| `GET /api/a2a/tasks`、`GET /api/a2a/tasks/:id` | 任务追踪表 + 详情抽屉 |
| `POST /api/a2a/tasks/:id/acceptance` | `a2a.js:547`（模板字符串拼接，首轮脚本未识别） |
| `GET /api/a2a/fulfillment` | 履约区块 |
| `GET/POST /api/a2a/rules`、`DELETE /api/a2a/rules/:id` | 规则管理 |
| `POST /api/a2a/patrol/run`、`GET /api/a2a/patrols` | 巡检卡 |
| `POST /api/agents/:slug/a2a` | `a2a.js:316`、`:581`（发起协作 / 续答 / 取消） |
| `GET/POST/PATCH/DELETE /api/uhp/harnesses[/:id]` | harness 注册表区块 |
| `GET /api/uhp/responses` | 执行记录 |
| `GET /api/usage/collaborations` | 协作链成本 Top（`a2a.js` 引用 + 渲染函数） |

- **HTTP 方法错配**：0
- **悬空请求**（调用不存在的后端路由）：0

## 三、三语覆盖率

| 指标 | 数值 |
|---|---|
| `a2a.js` 文案键总数 | 108 |
| en-US 缺失 | **7** → 覆盖率 93.5% |
| ja-JP 缺失 | **7**（与 en 同缺） |
| 缺失键 | `运行时`、`取消`、`删除`、`{n} ms`、`步数预算`、`UHP 执行记录`、`{n} 小时` |
| 裸协议词词典（如 验收通过→accepted） | **0**（Q-19 已修） |

> 上一轮为 153 条文案缺 119 条（22% 覆盖）；本轮 108 条缺 7 条。改善显著，但**未达 95% 门禁**。

## 四、权限态与交互

| 断言 | 结果 | 证据 |
|---|---|---|
| 无 `a2a.task.accept` 时验收按钮隐藏 | ✅ | `a2a.js:466` `session.can('a2a.task.accept')` |
| 无权限时给出说明文案（非只隐藏） | ✅ | `canAccept` 判定链 + 提示文案 |
| `a2a.admin` 规则管理入口有权限判定 | ✅ | `a2a.js` |
| 发起人不可验收自己任务（前端同步） | ✅ | `!isInitiator(task)`（`a2a.js:466`） |
| 正文脱敏提示 | ✅ | `A2A_REDACTED_NOTE`（`a2a.js:84`） |

## 五、加载屏三数（Q-9 / Q-17 / Q-18）

| 项 | 前端 | 后端真实值 | 结果 |
|---|---|---|---|
| 插件数 | 29 | `pluginCount=29` | ✅ |
| 权限点数 | 92 | `catalog` 92 | ✅ |
| 启动词典历史数字死键 | 0 | — | ✅（Q-17 已修） |

> 首轮脚本用 `data.permissions` 取值得到 0，实为接口返回 `data.catalog`，已修正。

## 六、SSE 实时进度（Q-15）

- 平台具备 SSE 基建：`public/js/realtime.js` 支持 `EventSource` + 轮询降级。
- **a2a 页未使用**：`grep EventSource pages/a2a.js` 零命中；抽屉只取一次快照。
- 判定：**P2-06 未修**（体验缺口，不阻断功能）。

## 七、页面冒烟

- `a2a.js` 可在 jsdom 环境加载（首轮报 `document is not defined` 系测试环境缺失，已补 jsdom 全局）。
- `scripts/page-smoke.mjs`：**30/31 通过**；唯一失败 `P04 AI 市场 skills` 因隔离夹具无已上架 Skill（后端 `/api/skills` 返回 0 条），**非产品缺陷**。
- **门禁缺口**：`page-smoke.mjs` 与 `dom-smoke.mjs` **均未覆盖 a2a 页面**（`grep a2a` 零命中）——新增页面未进门禁，建议补登。

## 八、本组发现的缺陷

| 编号 | 级别 | 缺陷 | 位置 |
|---|---|---|---|
| P2-05 | P2 | a2a.js 三语各缺 7 条文案（93.5%，未达门禁） | `public/locales/{en-US,ja-JP}/10-shell-core.json` |
| P2-06 | P2 | a2a 页未接入 SSE，长任务无实时进度 | `public/js/pages/a2a.js` |

**门禁建议（不计缺陷编号）**：`page-smoke.mjs` / `dom-smoke.mjs` 未覆盖 a2a 页面（`grep a2a` 零命中），新增页面未进门禁，建议补登。

## 九、前端判断

- 「后端有、前端无」的结构性缺口已消除；剩余是**文案完整度**与**实时性体验**。
- 三语覆盖率目前**无门禁**（`lint:cjk` 只查硬编码中文，不查词典覆盖率），建议补 `a2a.js` 词典覆盖率断言。