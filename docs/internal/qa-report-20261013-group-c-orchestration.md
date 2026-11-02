# C 组报告：编排与集成域回归（2026-10-13，REFACTOR-2026-10-13 后）

> 测试对象：platform-core 事件总线 / plugin-flow-core / plugin-connector(ODD) / plugin-connect / console routes/ops.ts 总线死信域
> 实例：http://127.0.0.1:7343（DEMO_SEED=1，data-qa-gc，v1.1.0，18 插件；已做一次 kill+重启用于回放测试）
> 方法：黑盒 API 实测 + 真实源码行为探针（临时目录，未改任何仓库文件）+ 随包单测复跑
> 上轮对照：docs/internal/qa-report-20260912-group-c-orchestration.md + release-notes-2026-09-12/13-qa-fixes.md

---

## 一、结论速览

- 用例 52，通过 48，已知未修按「现状记录」4（C-06 静默停滞、C-07 SLA 负/零值×2 项行为、另死信 record 缺 source 结构性观察 1 条）
- **本轮无新增 P1/P2 缺陷**；上轮 C 组 P1×1、P2×3 修复全部回归通过
- 上轮 P3×3（C-05 头阻塞 / C-06 skip 停滞 / C-07 SLA 负值）确认仍在（按既定排期未修），本轮实测留档

## 二、测试用例与结果

### T1 journal 完整性 —— PASS
- data-qa-gc/bus-journal.jsonl：重启前 186 行 → 测试后 229 行，逐行合法 JSON，id 1..229 **严格单调、0 坏行**。
- 复现：`node -e`（逐行 JSON.parse + 相邻 id 比较），见报告附录脚本。

### T2 总线主干（真实 bus.ts 探针，临时数据目录）—— PASS
- **异步串行 FIFO**：emit 同步返回（id 1/2/3，sync-seen=0）；健康监听器按序收到 id1@t1ms、id2@t1062ms、id3@t2121ms（每事件被同挂的失败者拖 1050ms=50+200+800，串行保序成立）。
- **监听器异常隔离**：同事件健康者每次首试即达，失败者不拖垮他人。
- **退避重试→死信**：3 事件 × 4 次尝试 = bus.listener_error×12 + bus.dead_letter×3；死信文件 3 条，`attempts=4`，error=「3 次重试均失败：probe-intended-failure」。
- 随包 bus.test.mjs **8/8 绿**（含 C-01/C-02 两条新增回归断言）。

### T2b HTTP 订阅端隔离（127.0.0.1:20441 stub）—— PASS
- /fail 恒 500 的订阅端：每事件被真实命中 4 次（2 事件=8 次 fetch 500）；/ok 订阅端每事件恰 1 次不受影响；死信 2 条。
- 说明：总线监听器为进程内形态，无 HTTP webhook 订阅机制（全仓 grep 证实），故以「监听器内调 HTTP stub」等价建模。

### T3 C-01 回归（P1 自激放大）—— **修复确认 PASS**
- 探针：失败者同时订阅 `probe.task` + `bus.listener_error` + `bus.dead_letter`，emit 一次业务事件后观测 15s。
- 实测：journal t=2s 即定格 6 行（1 业务 + 4 listener_error + 1 dead_letter），t=5/10/15s **零净增**；死信文件 6 条=1 原始 + 5 条「反馈事件监听器失败（不回授，QA C-01）」。
- 对照上轮：~5 事件/1.05s 永续增长 → 现在有界收敛。根因修复点：`packages/platform-core/src/bus.ts:143`（FEEDBACK_EVENTS）+ `bus.ts:364-366`（suppressAlert 直入死信、break 不重试不回授）。

### T4 C-02 回归（死信重投）—— **修复确认 PASS**
- 制造 3 条死信：probe.plain-a、probe.plain-b（可重投）+ plugin:evil:tick（带 source 合法入账，重投时因 record 无 source 必抛）。
- `retryDeadLetters()` → `{attempted:3, redelivered:2, retained:1}`；不可重投条目**原地保留**并追加原因「重投失败：[bus] 插件命名空间事件 plugin:evil:tick 必须携带来源…」；其余 2 条成功重发，健康监听器实际收到首投+重投（at-least-once）；死信文件同步改写为 1 行。不再「先清空后重投」整体丢失。
- 修复点：`bus.ts:297-315`（逐条 try/catch、retained 带原因、返回对象）。
- 残留观察（见三、OBS-1）：record 仍无 source 字段（`bus.ts:145-153`），`plugin:` 死信结构性不可重投，只能保留等待人工处置。

### T5 C-03 回归（总线死信运维面）—— **修复确认 PASS**
- `GET /api/bus/dead-letters` → 200 `{"deadLetters":[]}`；`POST /api/bus/dead-letters/retry` → 200 `{attempted:0,redelivered:0,retained:0}`（实例当前无死信，管道机制已由 T4 探针证实）。
- 权限闸：hr/dev/audit/ops 四角色均 **403**（usage.admin 门禁，routes/ops.ts:158-164）。

### T6 flow 状态机 —— 主干 PASS；C-06/C-07 现状记录
- 合法主干：模板实例化首步自动 running（startedAt 落时）→ complete a → b 自动 running → block/restart → 全链 done → status=completed、progress=100、flow.completed 事件。全对。
- 非法矩阵 7/7 拒绝（400 且文案明确）：complete@pending、start@running、restart@running、complete@done（终态步）、未知动作 freeze、不存在步骤、不存在 TF。
- 已结束 TF：cancelled/completed 后流转 400、重复 cancel 400。
- **并发**：6 路并行 complete 同一 running 步 → 恰 1 成功 5 拒绝（拒绝原因一致）、终态 completed/only:done/progress=100 无丢更新；6 路混合动作（complete/block/skip×2）→ 恰 1 胜出、终态一致。
- **模板快照**：改模板 v1(2 步)→v2(3 步) 后，旧实例仍 s1/s2，新实例 n1/n2/n3 —— 快照复制语义保持。
- **C-06 现状（未修，P3 延续）**：2 步流 skip 唯一 running 步 a → `a:skipped, b:pending, status=running, currentStep=undefined`，无任何告警/推进，静默停滞与上轮一致。根因未动：`packages/plugin-flow-core/src/index.ts:305-311`（仅 `rule.to==='done'` 推进下一步）。
- **C-07 现状（未修，P3 延续）**：`slaMinutes:-5` → 200、dueAt=createdAt−5min、读取视图 `slaBreached=true, overdueMinutes=5`（出生即逾期）；`slaMinutes:0.01` → `slaBreached=true, overdueMinutes=-0.01`（口径自相矛盾）；`slaMinutes:0` → 立即 breached。无 `>0` 校验：`index.ts:233`（dueAt 直折算）、`:266-272`（viewOf）。

### T7 ODD 判定（C-04 回归）—— **修复确认 PASS**
- 非法声明 10/10 一律 **400 拒绝**（逐条人可读文案）：activeHours.start=25、start=9.5、end=-1、dataFreshnessMinutes=-3/0/"5"、allowedServices="hn"/[]/含数字数组、excludedActions="bad"。
- 合法声明对照 200 且四字段 round-trip 正确（`{"allowedServices":["hackernews"],"dataFreshnessMinutes":30}`）；PATCH 部分更新不误伤。
- 修复点：`packages/plugin-connector/src/odd.ts:83-120`（normalizeOdd 非法即抛）→ connector index.ts:895/908 → 400 呈现。fail-open 静默剔除已封死。

### T8 connect 扩展点 —— PASS
- 随包 proxy.test.mjs **7/7 绿**（真实 ToolRuntimeLite + 存根客户端 + 真实 fetch ECONNREFUSED）：intercept 注册级换装（connect_ 前缀豁免）、decorate 存量包扎、未接入=本地（显式语义）、**宿主不可达 → isError 显式失败 + noteForwardFailure 绝不静默落本地**（client.ts:321 抛错，index.ts:212 节流 connect.degraded）、缺扩展点 → noteDegraded 显式降级、dispose 全部还原、未知工具 decorate 抛 TypeError。
- 实例 host 形态在位：`GET /api/connect/clients` 200（templates readonly/operator/full）。

### T9 journal 重启回放（kill + 指定命令重启）—— PASS
- 重启前打标记 flow.created（id=228）→ kill（PID 16173）→ 按 `DEMO_SEED=1 DSH_UPDATE_AUTO_CHECK=off nohup node src/main.ts --port 7343 --data data-qa-gc` 重启（新 PID 20670，1s 内 health OK）。
- `/api/platform/info` events 回放可见 id=228 标记（ring 装载最近事件）；新事件 id=**229** 续接无重号；journal 229 行 0 坏行仍单调；重启前创建的 12 个 TF 全部健在（演示数据持久）。

## 三、缺陷与观察清单（本轮）

| 编号 | 级别 | 一句话 | 位置 |
|---|---|---|---|
| 无新增 P1/P2 | — | 本轮 0 新增 | — |
| C-06（延续未修） | P3 | flow skip 唯一 running 步后静默停滞（无推进/无告警），与上轮一致 | packages/plugin-flow-core/src/index.ts:305-311 |
| C-07（延续未修） | P3 | slaMinutes 负/零/极小值无 >0 校验：出生即逾期、overdueMinutes 可为负自相矛盾 | packages/plugin-flow-core/src/index.ts:233、266-272 |
| OBS-1（新观察） | P3 | BusDeadLetterRecord 无 source 字段：plugin: 事件死信结构性不可重投（现按 C-02 口径原地保留+注明，可接受但无恢复路径） | packages/platform-core/src/bus.ts:145-153、303 |
| C-05（延续未修） | P3 | 单监听器失败拖慢同事件后续派发 ~1.05s/事件（T2 实测 id2 晚 1062ms）；5s 超时头阻塞未复测（代码未动 bus.ts:335-377） | packages/platform-core/src/bus.ts:335-377 |

## 四、上轮 C 组缺陷修复回归结论

- **C-01（P1 自激放大）：修复有效**——回授断路实测有界收敛（+6 事件封顶），单测⑦同证。
- **C-02（P2 死信重投丢失）：修复有效**——逐条重投 {3,2,1}，不可重投条目保留+注明，其余成功重投。
- **C-03（P2 死信无运维面）：修复有效**——GET/POST /api/bus/dead-letters 在线可用且 usage.admin 门禁生效（console 拆分后落 routes/ops.ts:158-164）。
- **C-04（P2 ODD fail-open）：修复有效**——10/10 非法声明 400，合法 round-trip 无误伤。
- C-05/C-06/C-07（P3）：按 09-12 报告排期未修，本轮实测留档（见三）。
- C-08/C-09/C-10/C-11（P3，数据血缘/指标指纹/SPA 兜底/质量分并发）：本轮范围外未复测。

## 五、通过面

重构后事件总线主干（journal 完整性/重启回放续号/FIFO 串行/异常隔离/退避死信/HTTP 订阅端隔离）、flow 状态机（矩阵/并发恰一次/模板快照）、ODD fail-closed、connect 扩展点契约全部保持扎实，上轮 4 项重点修复（C-01~C-04）全部真实落地，无回归。

## 六、遗留环境影响披露（C 组本轮产物）

- 实例 7343 已按规程 kill+重启一次（新 PID 20670，DEMO_SEED=1 data-qa-gc）。
- 保留 qa-c-/C组 前缀资产供修复回归对照：模板 qa-c-tpl3、qa-c-snap；TF 12 个（C组主干流/C07负SLA流/C06跳过流/C组重启标记流 等）。
- 已删除：连接器权限组 qa-c-odd-base（验证后清理）。
- 探针/脚本（/tmp）：qa-c-probe-t2-bus.mjs、qa-c-probe-t2b-http.mjs、qa-c-probe-t3-c01.mjs、qa-c-probe-t4-c02.mjs、qa-c-t6-flow.mjs；token 存 /tmp/qa-gc-token.txt。
- 本机 20441 stub 已关闭（进程退出即释放）。
