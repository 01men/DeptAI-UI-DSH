# 交接清单 H1-H5 宿主侧落地与 H1 排查结论（ybkkasi main · 2026-09-09）

> 对应文档：`D:\DSH-RQ\docs\handoff-qa-fixes-to-main-20260908.md`（QA 2026-09-08 验收缺陷 ·
> 宿主平台侧修复清单）。本文档记录 main 上 H1~H5 的评估结论、实现与回归结果。
> H1 的"三个环节"已按交接要求在 dsh rc.7 检出（`D:\DSH\deepseek-harness`）逐一定位核实。

---

## 结论速览

| 项 | 优先级 | 结论 | main 落地 |
|---|---|---|---|
| H1 注入链 | P1 | rc.7 三环节核实完毕：装载器无静默路径（全页响亮失败）、注入白名单不存在（非阻塞）、五 slot 名录与 kind 全部匹配；**根因最大嫌疑是 QA 当时部署的 bundle 产物过期**（主仓提交的 lib/client.js 同样被证实与源不一致，本次已重建） | 排查结论（本文）+ bundle 重建 |
| H2 轮询静默 | P1 | `createEventStream` 新增 `onPollError` 回调 + `health()` 健康态 getter；非 2xx 计失败；面板徽标三态降级 | 已实现 + 4 项单测 |
| H3 refresh 互踩 | P1 | 30s 轮换宽限窗口 + 单 token 兑换 10 次封顶；窗口外重放防线不变（整链吊销） | 已实现 + 6 项断言 |
| H4 SSE query token | P2 | `POST /api/panel/stream-ticket`（Bearer + panel.read + 部门范围校验）签发 ≤60s 一次性 `stk_` 票据，GET `?ticket=` 消费即焚；`?token=` 通道保留过渡 | 已实现 + 7 项断言 |
| H5 断言网枚举 | P2 | `http.register` 对 `/api/*` 强制鉴权声明（缺失注册期即抛错）；guarded 自动入 routeMatrix；route-matrix 端点扩展三分类台账；selftest 新增全量枚举 + 公开自校验端点匿名探针 fail-closed 断言 | 已实现 + 全部注册点迁移 |
| H6 复测环境 | — | 非代码项，按原清单执行（不在本仓范围） | — |

---

## H1 · rc.7 会话侧注入链三环节排查结论（BUG-G-01 根因）

### 环节 1：装载器消费链——"注册被接受但工厂从未执行"在 rc.7 **不存在静默路径**

核实位置：`deepseek-harness/packages/client/modules/src/client/system.ts`、`packages/client/web/src/boot.tsx`。

- `window.__ModuleLoader__.load()` 只登记工厂（system.ts:88-95），物化在 entry `import()` 时同步执行
  （system.ts:114-133 `materialize`）——"注册不物化"的懒 CJS 模型本身是设计如此；
- 但 **rc.7 启动内核对每一个 boot 图条目**（不分 immediately 与否）都会 `loader.create({name})`
  并 `loader.await()` 后做全量清点（boot.tsx:189-208）；import 失败的条目无 fiber、apply 抛错的
  条目非 ACTIVE，`assertEntriesActive()` 会抛出
  `"web boot: N entries did not activate"`，整页停在加载页并渲染失败报告（boot.tsx:216-237 + 138-142）。
- **推论**：QA 现象（页面其余功能正常、唯独 rq-card 五处 slot 静默缺失）与 rc.7 的
  "单条目失败=全页响亮失败"语义不相容。最自洽的解释是 **apply 实际执行了、但五处 slot 探测
  全部落空**（见环节 3 的语义缺口），或 QA 现场部署的 web 内核并非 rc.7 检出版本。

### 环节 2：api-catalog / client-modules 白名单——**该机制在 rc.7 不存在**，非阻塞

- 两仓全量检索无 `api-catalog`；`dsh.client.inject` 字段仅做结构校验（modules/src/index.ts
  `parseDshClient`）并作为**信息性元数据**进 boot 图行（manifest.ts:56-58），无成员白名单 gate。
- 工厂内 `require()` 的解析链是 seed → statics → 已注册工厂（system.ts:142-156），与 inject
  声明无关。静态模块表（`packages/client/web/src/seed.ts` `getStaticModules`）含
  `react`、`react/jsx-runtime` 与 8 个平台包——rq-card bundle 的全部外部依赖
  （仅 react/jsx-runtime）都在册，require 不可能落空。
- rq-card 声明的 inject 四项中 `dsh-client-ui-settings` 未声明属正常（bundle 未使用该包；
  settings.section 槽经 `ctx.slots` 服务注册，不 require 包本体）。

### 环节 3：slot 契约——五个 key 在 rc.7 **全部在册且 kind/scope 匹配**，但存在时序语义缺口

| slot key | rc.7 定义处 | kind/scope | 与 spike §3.2 名录一致 |
|---|---|---|---|
| `tool.call.toolview` | ui-tool/src/client/apply.ts:28 | keyed / session | ✓ |
| `conversation.chat.assistant-actions` | ui-conversation/src/client/contract/slots.ts:109 | list / session | ✓ |
| `conversation.view` | 同上 :76 | list / session | ✓ |
| `settings.section` | ui-settings/src/client/contract/slots.ts:53 | list / **root** | ✓ |
| `shell.overlay` | ui-layout/src/client/index.ts:83、126 | list / **root** | ✓ |

**语义缺口（根因最大嫌疑）**：`specDynamic(key)` 是**点时刻查询**——槽在其属主包
（ui-tool/ui-conversation/ui-settings/ui-layout）apply 声明之前返回 `undefined`
（ui-slots/src/index.ts `specDynamic`：*"the spec, or undefined while undeclared"*）。
而 `slots.inject(key, cb)` 本身具备声明纪元机制（未声明时回调挂起、声明即触发）。
rq-card 现行客户端是 **先 probe 后 inject**（`probeSpec()` 命中才注册）：若 apply 跑在属主
包声明之前（条目并发创建、激活序不作保证），五处探测全数落空 → 旧 bundle 在此分支静默
不装任何东西 → 与 QA 现象逐点吻合（连兜底角标都不出现）。

### 根因排序与复测协议

1. **bundle 产物过期（已证实存在同类事实）**：QA 报告自身即发现仓库 b6a3329 提交的
   lib/client.js 与源指纹不一致。本次核查发现 **main 仓提交的 lib/client.js 同样与
   `node build.mjs` 现场产物不一致**（重建前后 sha256 变化），已重建入库。
   过期产物若编译自 slot 更名/重构前的旧源，五个探测自然全数落空。
2. **probe-before-declare 时序**：specDynamic 点时刻语义 + 先探测后注册的写法，
   在属主包未声明时全数静默落空。建议定制面把三段注册改为无条件 `slots.inject(...)`
   （纪元机制天然容忍属主后到）；`__RQ_CARD_DIAG__` 台账复测时可直接证实此分支
   （`attempts[].stage` 全部停在 slot 探测失败即可定性）。
3. rc.7 宿主侧**无需代码改动**：boot 全页响亮失败已是最强护栏；若复测仍复现，按
   `__RQ_CARD_DIAG__` 四态台账对号入座即可（`registered-not-materialized` 若真出现，
   携 system.ts:88-95/boot.tsx:216-237 行号升级给 dsh 团队）。

---

## H2 · realtime.js 轮询失败可观测（BUG-U-02 根治）

main 仓 `packages/plugin-console/public/js/realtime.js` 此前**整体缺失**（panel 的 deps.js
动态 import 它、selftest 给它留了走查豁免，但文件不在）——本批补齐，并以定制分支版本为基线
实现交接建议的契约：

- `createEventStream({...})` 新增可选 `onPollError(error, { consecutiveFailures, status? })`：
  轮询单轮失败逐次回调（含网络异常与**非 2xx 响应**——旧实现把 401/5xx 当成功吞掉）；
- 返回句柄新增 `health()`：`{ transport: 'sse'|'polling'|'connecting'|'closed', downgraded,
  consecutivePollFailures, lastPollOkAt, lastPollErrorAt, lastPollErrorMessage }`；
- 轮询成功自动清零连续失败计数（自愈即恢复）；`onPollError`/`health` 均为可选——**契约向后兼容**；
- 面板 `app.js` 接线：连续失败 ≥3 轮（30s 间隔下约 95s，与定制面看门狗口径一致）→
  徽标转「连接中断·点击重试」（红），点击整通道重建；成功自愈自动回 LIVE/30s 轮询。

单测：`packages/plugin-console/public/js/realtime.test.mjs`（4 用例：传输决议/SSE 保持/
降级+失败计数+自愈清零/close 停摆），selftest 主流程同挂该文件直测。

## H3 · refresh 轮换宽限窗口（T-08 多标签页互踩）

`plugin-authn` `refreshSession` 契约（响应形状不变，消费方零改动即自愈）：

- 旧 refreshToken 轮转后 **30s 内**（`REFRESH_GRACE_MS`）再现不判重放，签发**同链新兄弟对**
  （`issuedBy: 'refresh-grace'`）——各标签此后各持独立令牌，后续轮转互不影响；
- 单条已轮转记录宽限兑换 **10 次封顶**（`REFRESH_GRACE_MAX_REDEMPTIONS`）：窗口内超限仅拒绝
  该次请求（fail-closed、不牵连整链）；**窗口外再现仍是硬重放 → 整链吊销（防线不变）**；
- 定制面适配：面板 api.js 已收口于 `tryRefresh`，刷新成功即恢复正常，无需改动。

回归（selftest「refresh token 轮转、宽限自愈与重放防护」+ dsh 挂载段白盒）：
30s 内旧 token 再兑换成功且兄弟对可用、原链不吊销；超限拒绝不连带吊销；
白盒时间旅行（rotatedAt 拨回 60s）后重放被拒、整链（含宽限兄弟对）吊销。

## H4 · SSE 短时一次性 stream ticket（P2-O-5）

- **签发**：`POST /api/panel/stream-ticket`（guarded `panel.read` + 部门范围校验同规）→
  `{ ticket: 'stk_…', expiresInSeconds: 60 }`；票据仅存哈希、绑签发 principal+dept、
  内存台账（重启失效无害，EventSource retry 自动重取）；
- **消费**：`GET /api/panel/stream?dept=…&ticket=…` 消费即焚（重放 401）；dept 与签发部门
  不一致 400；URL 不再出现长效 access token；
- **过渡**：`?token=` 旧通道保留（含 BUG-A-01 同规校验），未升级消费方不受影响；
- **面板前端已迁移**：connectStream 先取 ticket，失败自动回落 token 通道；
- main 的 stream 处理器同时移植了定制分支的 **BUG-A-01（P0）修复**：principal 与 console
  中间件同规（human→userId）、未知部门 404、握手阶段 deptScopeAllowed 同规校验（绝不先订阅）——
  main 上的移植快照此前缺这三项。

## H5 · routeMatrix 对自注册端点的覆盖义务（T-01 教训平台化）

- `platform-core/http.ts`：`http.register(method, pattern, handler, auth?)` 新增第 4 参
  **鉴权声明**，`/api/*` 端点缺失声明**注册期即抛错**（插件 apply 期响亮失败，绝不静默上线）：
  - `{ access: 'guarded', permission }`——自动（幂等去重）汇入 `httpServer.routeMatrix`，
    三处 guarded()（console/panel-core/dingtalk-bridge）的手工 push 随之删除，单一事实源；
  - `{ access: 'authenticated' }`——仅控制台中间件 Bearer、无独立权限点；
  - `{ access: 'public', selfValidated? }`——免鉴权白名单；`selfValidated: true` 即交接清单
    要求的**「公开+自校验」显式类别**（stream/票据/接入码/下载类端点）；
  - `/api` 之外（/oauth、/mcp、/docs 等）自动归类 `outside-api`，不入断言网口径。
- `GET /api/platform/route-matrix` 扩展：`publicEntries`（含 selfValidated 标记）、
  `authenticated`、`counts`（declaredApi/guarded/public/authenticated/**undeclaredApi 恒 0**）。
- **断言网扩展**（selftest RBAC 段）：①三分类计数与声明台账全等（端点 100% 可枚举）；
  ②全部公开自校验端点匿名探针必须 fail-closed（200/500 即红）。
- 全部注册点已完成声明迁移（console 25+1 处、panel-core、dingtalk-bridge、connect×8、
  update×4、behavior×2、oidc×2）；behavior GET / connect 6 处 / update 3 处 /
  verify-audience / nas authz 写面**首次纳入越权断言网**（此前 inline 检查逃网）。

---

## 回归

- `npm run selftest`：946/946（含本次新增 H3×6 / H4×7 / H5×2 断言与 realtime 直测）
- `npm run lint:manifests`：85/85；`npm run manifests` 已再生成（stream-ticket 入 api.yaml）
- `node packages/plugin-console/public/js/realtime.test.mjs`：4/4
- plugin-rq-card lib/client.js 已按当前源重建（此前提交产物与源不一致，见 H1 根因排序第 1 条）

## 遗留与建议（不在本次范围）

1. main 上三个定制包（panel-core / rq-card / dingtalk-bridge）与面板前端仍是移植时快照，
   附录中其余定制面修复（重投/时区/XSS 引号转义/热区等）建议后续做一次**整包同步**，
   本批只顺手移植了 stream 处理器内的 P0（BUG-A-01）——因为它与本批改的正是同一段代码。
2. `?token=` SSE 旧通道保留至定制面全部消费方确认走 ticket 后，可在下个版本拒绝旧通道
   （PUBLIC_PATHS 不变，一处 fail-closed 收口）。
3. rq-card 客户端建议改为无条件 `slots.inject`（纪元机制）替代先 probe 后注册，
   与 `__RQ_CARD_DIAG__` 一起由定制面下批带上。
