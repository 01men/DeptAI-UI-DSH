# C 组报告：编排与集成域（2026-09-12）

> 总报告见 [qa-report-20260912-overview.md](qa-report-20260912-overview.md)
> **测试对象**：plugin-flow-core / plugin-connector / plugin-connect / platform-core 事件总线 / plugin-dsh-bridge
> **基线**：git `2122c2c`；实例 http://127.0.0.1:7301（独立宿主形态，DEMO_SEED=1）
> **方法**：黑盒 API 实测 + 只读代码审读 + 以仓库真实源码跑行为探针（未改任何仓库代码；探针脚本在系统临时目录）
> **账号**：仅用 admin 与自建账号 `orch-codd`；自建资源一律 `orch-`/`orch-C` 前缀

---

## 一、缺陷清单

### BUG-C-01【P1】总线自观察事件存在无终止的自激放大循环（劣质订阅者可拖垮全总线）
- **场景**：任一监听器订阅 `bus.listener_error`（或 `bus.dead_letter`）且处理函数持续抛错。第三方插件经 `ctx.platformBus.on` 可合法注册（`on()` 无来源/名称校验），当前内置插件无此订阅，故为条件触发。
- **复现**（真实 bus.ts 探针）：注册 `bus.on('bus.listener_error', ()=>{throw…})` + 一个普通失败监听器，emit 一次业务事件后观测 journal：
  ```
  t=2s journal=9   t=10s journal=49   t=20s journal=94   t=30s journal=139（持续增长不停止，死信 27 条）
  ```
- **实际 vs 预期**：每次失败派发都 `emit bus.listener_error`（4 次重试=4 条）+ 入死信再 `emit bus.dead_letter`（1 条）；这些告警事件又被同一个失败监听器消费、再失败、再产告警——事件数按 ~5/1.05s 净增速**永远增长**，journal/死信文件无限膨胀；若失败监听器挂在热点事件（如 `usage.recorded`）上，流量按 5× 放大，最终触发 `backpressure_overflow`（>10000 队列），此后每条新事件都挤掉一条旧事件并再发一条 `bus.dead_letter` 告警，**队列永久饱和、真实事件被持续挤入死信**。预期：告警事件的失败应有断路器（如告警事件不再派发给当次失败的监听器、或不为告警事件再产告警）。
- **根因**：`packages/platform-core/src/bus.ts:331-354`（`deliver()` 逐次失败无条件 `emit(PlatformEvents.BusListenerError…)`，345 行）+ `bus.ts:301-309`（`enterDeadLetter()` 再 `emit(BusDeadLetter)`）；注释只防了「死信事件自身失败递归入死信」，未防跨事件回授循环。

### BUG-C-02【P2】死信重投丢失 `source`，对 `plugin:` 事件必抛错，且「先清空后重投」导致其余死信永久丢失
- **复现**（真实 bus.ts 探针）：制造两条死信（一条 `emit('plugin:evil:tick',…,{source:'plugin:evil'})` 的失败投递 + 一条普通平台事件死信），调用 `retryDeadLetters()`：
  ```
  重投前死信数 = 2
  retryDeadLetters 抛错 = [bus] 插件命名空间事件 plugin:evil:tick 必须携带来源（source: plugin:…，期望 plugin:evil）
  重投后死信剩 = 0 | 死信文件行 = 0
  probe.plain 重投是否到达健康监听器 = 否——该条死信已随 store 清空而永久丢失
  ```
- **实际 vs 预期**：一条不可重投的死信导致整个重投操作中断，且因 store/文件在循环前已被清空，**余下死信既未重投也不复存在**——恰是 8908a99 承诺封死的「丢事件=丢证据」。预期：逐条重投、失败条目保留，并保留原 `source` 重发。
- **根因**：`packages/platform-core/src/bus.ts:288-298`（`retryDeadLetters()` 先清 `deadLetterStore` 并截断文件再循环 `emit`；`emit(record.eventName, record.payload)` 不带 source）；且 `BusDeadLetterRecord`（bus.ts:138-146）根本没有 source 字段，重投在结构上无法还原来源。

### BUG-C-03【P2】总线死信无任何查询/重放运维面，「死信可查询/重放」在运行系统上不可达
- **复现**：
  ```bash
  curl -s http://127.0.0.1:7301/api/bus/dead-letters -H "Authorization: Bearer $T"   # → 404 路由不存在
  curl -s -X POST http://127.0.0.1:7301/api/bus/retry -H "Authorization: Bearer $T"  # → 404 路由不存在
  curl -s http://127.0.0.1:7301/api/usage/dead-letters -H "Authorization: Bearer $T" # → 200（usage 管道有完整死信面）
  ```
- **实际 vs 预期**：`deadLetters()`/`retryDeadLetters()` 仅有进程内方法，console 全部路由无任何出口；对照 usage 管道有 `/api/usage/dead-letters` 与重试口（`plugin-console/src/index.ts:3779/3788`）。总线死信一旦产生，运维只能翻 `bus-dead-letters.jsonl` 文件且无法重放。
- **根因**：8908a99 只交付了总线能力，未在 `packages/plugin-console/src/index.ts` 增加对应路由。

### BUG-C-04【P2】ODD 非法声明被静默剔除——安全控制 fail-open 消失，管理员无感知
- **复现**（实测，均返回 200）：
  ```bash
  curl -s -X PATCH .../api/connector/perm-groups/cpg_xxx -d '{"odd":{"allowedServices":["hackernews"],"activeHours":{"start":25,"end":9}}}'
  # → odd = {"allowedServices":["hackernews"]}（时间窗限制无声消失）
  ```
  探针补充：`activeHours:{start:9.5,end:18}`、`dataFreshnessMinutes:-3/NaN`、`allowedServices:"hn"`（字符串形态）全部静默丢弃，部分导致整个 odd 块折叠为 undefined。
- **实际 vs 预期**：显式声明了非法 ODD 约束时应报 400 或至少告警留痕；实际限制直接蒸发（比「报错」更危险的是「看似配置成功实则无约束」）。`normalizeOdd` 注释口径是「剔除未声明字段」，但对**已声明但非法**的值同样静默折叠，属 fail-open。
- **根因**：`packages/plugin-connector/src/odd.ts:78-92`（`normalizeOdd` 无错误通道）；`plugin-connector/src/index.ts:887/900` 与 `plugin-console/src/index.ts:2026-2044` 直接采信，无校验/告警。

### BUG-C-05【P3】单监听器挂起使全总线头阻塞 ~21.5 秒（量化）
- **复现**（探针）：注册一个永不返回的监听器，随后 emit 下一事件：5s 超时未到时后续事件零派发；约 21.5s（4 次尝试×5s 超时 + 50/200/800ms 退避）后才开始派发，挂起者最终入死信。
- **实际 vs 预期**：异步串行 FIFO 是声明的设计，但「5s 超时熔断」只计失败不隔离——一个卡死的审计/面板订阅者将整体拖延所有事件驱动面（SSE 扇出、通知、usage）。预期至少：超时重试期间不阻塞其他事件的派发，或文档明示该代价。根因 `bus.ts:317-354`（drain 串行 await deliver）。

### BUG-C-06【P3】flow：skip 唯一 running 步骤后流程静默停滞
- **复现**：`POST /api/flow/flows/$F/steps/a/transition -d '{"action":"skip"}'`——2 步流（a=running,b=pending）：skip a 后 → running=[]、b 仍 pending、status=running、无任何告警。
- **实际 vs 预期**：done 会自动推进下一待启步骤，skip 不推进且无「流程无活动步骤」的提示/事件，TF 无声卡死（currentStep 变 undefined）。预期：skip 当前步骤后同样自动推进，或发出可观测的停滞信号。根因 `packages/plugin-flow-core/src/index.ts:302-310`（仅 `rule.to==='done'` 分支推进）。

### BUG-C-07【P3】flow：slaMinutes 零/负值无校验，负值流程「出生即逾期」且 overdueMinutes 可为负
- **复现**：`POST /api/flow/flows {"slaMinutes":-5}` → 200；GET 显示 `slaBreached=true, overdueMinutes=5`；`slaMinutes:0.01` → `slaBreached=true, overdueMinutes=-0.01`（breached 却逾期分钟数为负，口径自相矛盾）。
- **根因**：`plugin-flow-core/src/index.ts:232`（dueAt 直接折算，无 `>0` 校验）、`:260-273`（viewOf 计算）。

### BUG-C-08【P3】数据血缘无环引用检测，a→b→c→a 成环被接受
- **复现**：依次 `PUT /api/resource/lineage` 建 `b→a`、`c→b`、`a→c` 全部 200。自环（a→a）与未登记数据集被正确拒绝；因血缘遍历为深度 1（`lineage()` 仅取直接边，实测环上查询 2ms），不致死循环——属数据质量门禁缺失而非可用性缺陷。根因 `packages/plugin-resource-core/src/index.ts:586-592`（仅 `derived===source` 拒绝）。

### BUG-C-09【P3】指标字典：指纹键序敏感造成伪口径冲突；仲裁后 supersedes 指针残留陈旧值
- **复现**：同码登记 `payload:{b:1,a:2}` 与 `{a:2,b:1}`（逻辑相同）→ 两条都 `conflict=true` 并存为新口径（指纹为 `JSON.stringify` 直序列化，键序敏感）。仲裁口径1→口径2→再仲裁回口径1 后，各 superseded 记录的 `supersedes` 指针一部分指向当前 active、一部分为 null，账面不一致。
- **根因**：`plugin-resource-core/src/index.ts:613-615`（指纹未做键排序归一）；`:646-656`（arbitrate 只更新当前 `status==='active'` 者的指针，历史 superseded 指针不清理）。

### BUG-C-10【P3】独立宿主下 dsh-bridge 全部挂载/身份面被 SPA 回退吞成 200 HTML（不诚实报错）
- **复现**（独立宿主，boot-all 不装配 dsh-bridge，属预期缺席）：
  ```
  GET  /rq                  → 200 text/html（SPA 壳）
  GET  /rq/api/overview     → 200 text/html（API 客户端期待 JSON 却拿到 HTML）
  GET  /dsh-bridge/status   → 200 text/html
  POST /dsh-bridge/redeem   → 200 text/html（集成方 r.json() 将报 "Unexpected token <"）
  GET  /auth/entry?ticket=x → 200 text/html
  对照：未知 /api/* → 404 JSON「路由不存在」（诚实）
  ```
- **实际 vs 预期**：/api/* 有保护（API 永不落静态页），但 `/rq`、`/dsh-bridge/*`、`/auth/entry` 这些「只有 dsh-web 形态才存在」的约定前缀没有同等保护，未装配时被 SPA 兜底伪装成 200 页面，集成方难以诊断。预期：对已登记的保留挂载前缀在插件缺席时返回 404/503 JSON。
- **根因**：`packages/platform-core/src/http.ts:384-390`（SPA 兜底对一切非 `/api` 路径、任意 method 返回 fallback 页，无保留前缀豁免）。

### BUG-C-11【P3】数据集质量分并发更新 = 无版本的 last-write-wins
- **复现**：对同一数据集并发 5 次 PUT quality（各不相同）→ 全部 200，最终 overall 落为其中一份，无冲突检测、无版本史、无告警。质量分登记是快照语义可接受，但多人同时打分时先提交者结果被无声覆盖。根因 `plugin-resource-core/src/index.ts:546-563`（整对象覆写，无乐观锁/历史）。

### 观察项（不计缺陷）
- `bus-journal.jsonl` 只增不转：无大小/保留策略（对照 usage 有 730d 保留），长期运行无限膨胀（`bus.ts:207-216`）。
- 新鲜度判定对「未来目录时间戳」（时钟回拨/上游写错）恒判新鲜（负 age 永不超阈值），`odd.ts:63-67`。
- ODD 白名单大小写敏感（`GitHub`≠`github` 离域），偏严属 fail-closed，可接受但建议文档写明。
- 连接器网关一经配置无删除/恢复「未配置」API（只有 offline），`plugin-console/src/index.ts:1785-1830`。
- `flow.status` 枚举含 `archived` 但无任何归档入口（死枚举）；`FlowTemplateChanged` 未接面板 SSE 扇出（wireEventBus 仅 Created/StepUpdated/Completed，`plugin-panel-core/src/service.ts:886-903`）。
- contextPack 与步骤 note 在 API 层原样存取（JSON 语义正确）；全仓当前**无任何 HTML 渲染消费方**（console SPA 无 flow 页面），注入风险为潜伏态：`PUT /api/flow/templates` 接受 `<script>`/`<img onerror>` 等载荷并原样返回。一旦下游以 innerHTML 渲染即成 XSS，建议在契约中写明转义责任。

## 二、验证通过清单

**事件总线（8908a99 回归）**
1. journal 持久化落盘格式：逐行 JSON `{id,name,payload,at[,source]}`，实测 654 行、id 1..654 单调无坏行（含其他组的带 source 事件，来源字段如实落盘）。
2. 重启回放（探针以实例 journal 副本起新总线）：装载最近 300 条进 ring、seq 续接（541→542），「重启不丢最近事件、续号」成立。
3. 异步串行派发：emit 同步返回事件对象、监听器 FIFO 串行（bus.test 6/6 复跑全绿）。
4. 监听器异常隔离：同事件健康监听器照常收到载荷（异常不拖垮其他订阅者）；失败者 50/200/800ms 退避重试 4 次后入死信，`bus.listener_error`×4 + `bus.dead_letter`×1 全部落 journal，死信文件同步落盘。
5. 死信重投 at-least-once：健康监听器确实重复收到（口径与注释一致）——但见 BUG-C-02。
6. 第三方命名空间校验逐字保持（保留前缀拒绝、`plugin:` 必带来源）。

**flow-core 全链路**
7. 模板 CRUD（code 正则/步骤校验/≤30 步）→ 一键实例化（快照复制：模板改 v2 后既有实例仍 3 步，新实例用新模板）→ contextPack 随实例返回。
8. 步骤状态机矩阵全对：pending→running→done/blocked/skipped、blocked→restart、done 自动推进、并行双 running、全链 done/skipped→completed、终态（completed/cancelled）流转与取消一律 400 且文案明确。
9. 并发竞态：12×并行 complete 同一步 → 恰好 1 成功且拒绝原因一致；6×并行 start → 0 成功（已被自动推进，语义正确）；并行 complete 两个 running 步骤 → 双成功、下一待启步骤恰好推进一次、无丢更新（状态机为同步读改写，单线程下无竞态）。
10. SLA/甘特：dueAt=createdAt+sla 读取时点判定 slaBreached；步骤 startedAt/finishedAt/actor 齐备可直渲甘特；flow.created/step.updated/completed 共 19 条全部入 journal。

**connector ODD（bd381c7）**
11. odd 声明块经 console POST/PATCH 透传入库、四字段 round-trip 正确；`odd:{}`/`odd:null` 语义为清除（实测确认）。
12. inOdd 判定矩阵（真实 odd.ts 探针 + 随包 odd.test 13/13 复跑绿）：白名单内/外、排除清单命中/未命中、新鲜度（缺目录时间戳 fail-closed、无效时间串 fail-closed、3min/5min 内、6min/5min 陈旧拒绝）、时间窗 [start,end) 边界、跨零点 22→6（23:00/05:59 IN、12:00 OUT）、start===end 单小时窗、多约束叠加离域拒绝并给出 reasons。
13. 实例侧网关 env 门禁 fail-closed 诚实逐因报错（未配置/管理口令未解析/`OOMOL_CONNECT_ENCRYPTION_KEY` 未设置三态清晰，目录同步与 execute 全部被拒而非静默）。权限组每次变更镜像失败显式发 `connector.policy_mirror_failed`（实测 5 条）不静默。

**connect（f2568a8）**
14. 随包 proxy.test 7/7 复跑全绿：intercept/decorate 正式扩展点换装与还原、未接入=本地（显式语义）、宿主不可达→显式抛错+节流 `connect.degraded` 绝不静默落本地、缺扩展点→显式降级+状态透出、未知工具 decorate 抛错。
15. 独立宿主 host 形态在位：`connect_code_create/codes/clients/client_disable` 等 host 工具注册（工具总数 78），`/api/connect/clients|codes` 正常应答；client 角色工具正确缺席（role 隔离成立）。

**数据要素域**
16. 数据集登记 upsert（code 正则/分级枚举）、质量分四维 0-100 校验（101/字符串"80" 拒绝）、overall 等权均值正确（90/80/70/60→75）。
17. 血缘：深度 1 双向查询正确（环上亦然）、`dataset` 缺参诚实 400、自环与未登记数据集拒绝。
18. 指标字典：首条默认 active、异口径并存 conflict=true、同内容重复登记幂等 conflict=false、仲裁切换与「取代 N 条」计数正确、仲裁他码/不存在定义被拒。`resource.dataset.changed`×9、`resource.metric.changed`×6 全部入 journal，审计可检索。

**dsh-bridge**
19. 独立宿主不装配 dsh-bridge（boot-all 无此插件，符合「仅 dsh-web 宿主」设计）；`entryTickets` 惰性解析修复在代码层成立（请求期 `entryTicketsAt()`，服务缺席时兑换得到明确错误文案而非整面 404，`plugin-dsh-bridge/src/index.ts:335-346`）——真实 dsh-web 形态行为见待确认。

## 三、待确认项
1. **connector.odd_exit 端到端落盘**：实例进程未设 `OOMOL_CONNECT_ENCRYPTION_KEY`，连接器数据面整体 fail-closed、目录无法同步，离域调用无法在实例上触发；invokeAction 中的插桩点（`plugin-connector/src/index.ts:1238-1250`）经代码审读确认，`connector.odd_exit` 事件入 journal 待有桩实例复验。注意离域拒绝的审计留痕走 `emitDeniedEvent` 直记审计（不依赖该事件），该路径已见其他 deny 场景工作正常。
2. **backpressure_overflow（>10000）实弹触发**：代码路径在案（`bus.ts:263-268`），因自激增速 ~5 事件/s 需 >30 分钟饱和，未在线复现。
3. **dsh-web 宿主形态**（/rq 挂载半 + entryTickets 并发装载竞态修复）：独立宿主不可达，需 dsh web 环境复验。
4. **connect client 角色在线 fail-closed**（真实转发失败→`connect.degraded` 落实例 journal）：实例为 host 角色，单测已覆盖，未在线复现。

## 四、遗留环境影响披露（C 组会话产物）
- 已建并保留（orch- 前缀，供修复回归对照）：组织 `org_mtxuwjmg8oa9o9uo`、用户 `orch-codd`、iam 组 `orch-c-odds`、数据集 `orch-c-ds-a/b/c`（含质量分/血缘环）、指标 `orch-c-gmv`×4 定义与仲裁史、模板 `orch-c-tpl1`、流程 `orch-C-*`×6；审计留痕 33 条。
- 已删除：连接器权限组 `orch-c-odd-full`（避免持续镜像失败告警）。
- **网关记录**：实测期间将 `/api/connector/gateway` 指向本组临时 OC 桩 `http://127.0.0.1:17363`（原状态为未配置；API 无删除口无法复原）。桩进程仍在运行；实例重启前建议运维清理该记录或改配真实网关（实例本就因缺加密钥而整体 fail-closed，无数据面风险）。

## 五、结论

本批次三项重点改动（8908a99 总线管道、f2568a8 connect fail-closed、bd381c7 ODD）的主干语义与实现质量总体扎实（持久化/回放/隔离/重试/判定矩阵实测通过），但总线在「自观察事件回授」与「死信重投还原」两处存在真实的可靠性漏洞（BUG-C-01/02/03），ODD 存在 fail-open 的静默剔除（BUG-C-04），建议在下一修复批次优先处理。
