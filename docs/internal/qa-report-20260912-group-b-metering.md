# B 组报告：计量与模型网关域（2026-09-12）

> 总报告见 [qa-report-20260912-overview.md](qa-report-20260912-overview.md)
> **测试域**：plugin-usage / plugin-modelgw / billing 语义残留
> **基线**：git `2122c2c` ｜ **实例**：http://127.0.0.1:7301（DEMO_SEED=1）
> **方法**：黑盒 API 实测 + 底层事件手算对账 + 只读代码定位；自建资源一律 `meter-` 前缀（已全部清理/停用，stub 进程已杀）

---

## 一、缺陷清单（P1 × 1，P2 × 5，P3 × 2）

### BUG-B-01（P1）J4 月度报表与成本摘要的 tokens 聚合取「组内单行值」而非求和，报表核心数字严重不实
- **实际**：`GET /api/usage/report/monthly?month=2026-09` 返回 `totals.tokens=27,311`、`byOrg=[138,307 / 61,477 / 27,311]`；用底层事件（`/api/usage/events` 逐条手算）实际为 **合计 4,807,991**（三部门分别 1,575,435 / 925,512 / 2,307,044），报表比真实值**小 176 倍**，且 byOrg 各行之和(227,095) ≠ totals(27,311)，三维自洽性破坏。CSV 导出与 JSON 同源同错。`/api/usage/summary` 的 `byResource[].tokens` 同病：org-meter 对 `model:meter-secret-model` 两事件实际 84 tokens（17+29+9+29），返回 38（单事件值）。
- **预期**：契约 docs/contract-j4-usage-report.md §2「tokens 取计量键名含 tokens 的米值**求和**」。
- **交叉定位证据**：同报表 `cost_cents`（真 SUM）自洽（72,121=23,632+13,883+34,606 ✓）、`events` 自洽（55=14+12+29 ✓），唯独 tokens 错。
- **根因**：`packages/plugin-usage/src/index.ts:551`（monthlyReport 的 `tokensExpr` 是引用裸列 `e.meters_json` 的关联子查询，在 GROUP BY 查询 SELECT 中 SQLite 只对组内某一行求值）；同文件 `:466`（summary byResource 同型）。内存库最小复现：orgA 两事件(100000+500) 在 `GROUP BY e.org` 下返回 100000 而非 100500。**修复方向**：改为 `SUM((SELECT ... ))` 聚合包裹或 json_each 与主表 JOIN（已验证可行写法）。
- **复核**：总负责人测试后独立复测 → totals=27311、byOrg 各行之和≠totals，确认无误报。

### BUG-B-02（P2）modelgw 渠道组降级链转发上游的请求体缺 `model` 字段——真实上游下备渠道形同虚设
- **复现**：建组 主=offline 渠道、备1=指向 stub 的 `meter-secret-model`，`POST /api/modelgw/channel-groups/meter-grp-a/invoke {"prompt":"hello-degrade"}` → 成功降级命中备1，但响应 `content:"meter-stub-reply:unknown"`（stub 回显请求体 model 字段 = 缺失）；对照单渠道 `POST /api/modelgw/invoke` 返回 `"meter-stub-reply:meter-secret-model"`（正常）。
- **预期**：转发体应携带命中渠道 slug。
- **影响**：OpenAI 兼容上游 model 为必填，备渠道调用将 400 全链失败（降级链失效）；宽容上游则静默用默认模型，计量资源键 `model:<slug>` 与实际执行模型脱钩。
- **根因**：`packages/plugin-modelgw/src/index.ts:275` 传入的 `input` 类型为 `Omit<ModelInvokeInput,'model'>`（`:239`），`:474-475` 转发体 `model: input.model` 取 undefined 被 JSON.stringify 丢弃。应改用 `model.slug`。

### BUG-B-03（P2）usage_query 工具的 resource 过滤静默失效，向模型/CLI 返回全库数字
- **复现**：`POST /api/tools/execute`（注意入参名是 `args`）`{"name":"usage_query","args":{"resource":"model:meter-secret-model"}}` → `{"count":128,"cost_cents":167335}`（全库）；该资源实际仅 3 事件。principal/from 过滤正常（count=2 与 REST totals 一致）。
- **根因**：`packages/plugin-usage/src/tools.ts:25` 把 resource 传入 `ctx.usage.totals()`，而 `packages/plugin-usage/src/index.ts:401-414` totals() 的 WHERE 只处理 tenant_id/principal/from/to——resource 被静默忽略；工具 description 却宣称「按主体/资源/时间窗过滤」。

### BUG-B-04（P2）`/api/audit/cost` 的 `days` 参数被静默丢弃，窗口过滤失效，GUI 两个「14 天成本」自相矛盾
- **复现**：`GET /api/audit/cost?days=28`、`?days=14`、`?days=1` 返回**完全相同**的 `llmTokens=12,101,830, costYuan=18.152`；而工作台趋势 `GET /api/overview` costTrend 近 14 天合计 = **¥9.34**（已复现求和 9.34）。`from` 参数功能正常（`?from=2026-09-12` → ¥0.369，与趋势末日一致）。
- **根因**：`packages/plugin-console/src/index.ts:3609-3614` 路由只读 `groupBy/from/to`，`days` 被丢弃 → costReport 全库聚合。GUI 的「近 14 天」实为全量 28 天聚合，与工作台口径互相矛盾。

### BUG-B-05（P2）demo seed 绕过 usage 计量管道直写成本投影，自造非零金额——「charge 恒 0」断言在成本 UI 失真
- **证据**：usage_events 全部 130 条事件 `charge_cents` 恒 0（实测扫描）、reconcile 双投影 charge=0 一致；但 `audit:costs` 中有 28 天非零金额历史，`¥18.152 = 12,101,830 tokens × 0.0000015 元/token` 与硬编码费率完全吻合。
- **根因**：`packages/plugin-console/src/seed.ts:458-464` 直接 `costs.insert(...)` 造数——不经 `usage.record`（无 schema 校验、不产生 usage_events、绕过 D2 零价快照），费率 0.0000015 元/token 无价格簿依据。
- **影响**：工作台/成本分析呈现的「¥ 成本」全部是管道外自造数，与计量管道（全零）口径分裂，演示数据冒充真实成本归集。

### BUG-B-06（P2）audit 成本消费取 `charge_cents`（对外计费口径）充当「成本」呈现——金额结算语义残留，调价即爆
- **根因**：`packages/plugin-audit/src/index.ts:346`：`costYuan: Math.round(event.pricing.charge_cents) / 100`。
- **裁定**：
  1. **不是「内部成本参考的合法呈现」，是语义债残留**。J4 契约（docs/contract-j4-usage-report.md §3）明确：`cost_cents` 才是内部采购成本参考口径，`charge_cents` 是对外应收（零价快照）口径。用 charge_cents 生成 ¥「成本」，承载的是**结算语义**；当前恰因 charge 恒 0 而增量恒 0，未直接违规，但一旦运营按契约允许的程序把价格簿 list 调为非零，对外应收金额将立即以「成本」名义呈现给企业用户——正是 M0 禁止的「金额结算语义」。正确实现应取 `event.pricing.cost_cents`。
  2. 非零值**只存在于 seed 直写的 audit:costs 演示历史**（BUG-B-05）；运行时新写入事件经全链路演练（record/feedback/modelgw/mcp）charge=0 已验证。「charge 恒 0」对计量管道成立、对成本 UI 失真。
  3. demo seed 应改为经管道造数（零价 + cost_cents 双轨，如 `nonbillableUsage` 或带成本参考的价格簿规则），或至少把 audit:costs 造数改取成本口径并显式标注演示性质。

### BUG-B-07（P3）`modelgw.degraded` / `modelgw.budget.warning` 宣称「面板 SSE 提示条 + 审计」消费，实际零订阅方
- **证据**：事件确有 emit（`GET /api/overview` recentEvents 可见完整 payload，bus journal 落盘留痕——实测拿到 degraded 与 budget.warning 两条）；但 `packages/plugin-panel-core/src/service.ts:897-901` 流转发只订阅 5 个 panel/dingtalk 事件，audit 也未订阅 `modelgw.*`。降级与预算告警**发而无人消费**，提示条不存在。
- **根因**：`packages/plugin-modelgw/src/index.ts:235/17` 注释与 events.yaml 描述与实现不符（缓解：bus journal 留痕存在，非完全无痕）。

### BUG-B-08（P3）rq-card 卡片客户端残留 billing 语义（bc2e429「语义债清零」漏网）
- `packages/plugin-rq-card/src/client/index.ts:76`：工具白名单仍含 `billing_wallet_balance`（该工具仅存在于 archive/plugin-billing，运行时不存在）。
- `packages/plugin-rq-card/src/client/locales.ts:27/78`：「钱包额度已耗尽，请申请追加」/ 'Wallet quota exhausted — request a top-up' 文案仍随包。提交 bc2e429 的豁免清单（legacy precheckCents 字段、risk.ts ADMIN_SCOPE）未覆盖此处。

## 二、验证通过清单

1. **charge 恒 0（管道内全出口）**：价格簿 11 条 list 全零；usage_events 130 条 charge 全 0；`/api/usage/totals`、`/api/usage/recent`、J4 JSON+CSV、`/api/assets/report`（charge 集合={0}）、feedback、modelgw 计量事件、工具面 usage_query 全部 charge=0；market 出口零价格/分账字段（仅 metering usageKey+unit）；overview costTrend 无收入/毛利语义。**注意**：该断言依赖价格簿纪律（PUT price-book 可写非零 list，属契约允许的运营调价），管道强制力体现在「无规则拒绝入账 + nonbillable 只配零费率」。
2. **schema v1 校验**：非法 resource、缺 org、负值 meter、编造计量键（skill:* 报 tokens）、未登记资源（widget:*）全部 400 拒绝且文案指明修正方式；「宁可拒绝不可静默 0 计费」成立。
3. **幂等**：同 idempotency_key 重放返回同一 event_id 不重复计数；同键不同内容拒绝；`replay` 121→121 事件数不变；feedback 同键重放幂等。
4. **保留策略**：retentionDays=730、cutoff=2024-09-12 正确、purged=0；days=0 跳过；days=-5 安全回退默认窗口。
5. **purge 权限**：ops/hr/dev/audit 调 `/api/usage/retention/purge` 均 403（usage.admin），匿名 401。
6. **分级路由（1-1）**：secret→public 渠道拒绝（锁死文案完整）、缺省 internal fail-closed（internal→public 也拒）、secret→secret 放行；降级链逐步同样校验。
7. **降级链（1-2）**：offline 降级、网络错误降级、步超时降级（stepTimeoutMs=1000 实测 1125ms 切换、原因「模型调用超时（1000ms）」）、manual=true 全链失败返回 `escalated:true` 不造假回复、按主→备1→备2 顺序逐级留痕 degradations+modelgw.degraded 事件（bus journal 留痕、overview 可查）、停用组/不存在组/引用未登记模型均拒绝。
8. **预算熔断（1-4）**：block 在调用前熔断（used=1≥limit=1 拒绝、telemetry ok:false 留痕）；warn 阈值事件触发（ratio=0.5、payload 数字手算一致、每预算每日去重）；调用前熔断顺序正确。
9. **遥测（1-3）**：invocations=4/failures=1/availability=0.75/degradedInvocations=1 手算一致；ttft=null 诚实缺列并附口径说明。
10. **计量与转发对应**：stub 返回 prompt_tokens=9/completion_tokens=29 → 事件 meters input=9/output=29、costCents=round(29/1000×20)=1 分，逐项吻合（转发侧缺陷见 BUG-B-02）。
11. **4-2 采纳率**：2 up+1 down → rate=0.667，byResource/byDay 正确；feedback 落零价快照（charge=0+nonbillable）；非法 score 400。
12. **对账**：usage vs audit/agent-registry 双投影 count/charge 全一致 mismatch=false。
13. **工具面权限**：dev 调 usage_replay 403（usage.admin 门，含 audit.authz.denied 留痕）；model_list 不泄漏 apiKey（`***` / env: 引用名保留）。
14. **output.schema 强校验（9b326ec）**：注册期缺失/null/数组 schema → TypeError，单测 4/4 现场复跑通过；本实例 provideToolRuntime 默认加载 ToolRuntimeLite，校验生效。

## 三、观察项与待确认

- **OBS-1**：`/api/usage/summary` 的 budget 字段只认 org 级预算（`plugin-modelgw/src/index.ts:389-395` 过滤 `!item.modelSlug`），模型级预算熔断生效时摘要仍显示 `budget=null`——「摘要说无预算、调用却被熔断」的口径分裂。
- **OBS-2**：feedback 幂等键含 score，同一消息改评会 up/down 双计（adoptionRate 分母按评分次数而非消息数）。
- **OBS-3**：`POST /api/usage/replay` 与工具 usage_replay 无 changeLog 审计（对比 dead-letters/retry 有）；重放是运维敏感操作。
- **OBS-4**：output.schema 仅注册期存在性校验；运行期 execute 返回值不做 schema 比对（render 失败静默回落 JSON.stringify）。9b326ec 叙述即注册期，属契约强度边界而非缺陷。
- **OBS-5**：market manifest 解析仍保留 `billing.commission` 兼容字段（`plugin-market/src/index.ts:182`），API 出口已无此字段，无害兼容层。
- **OBS-6**：`packages/platform-core/src/bus.ts:79-80` WalletChanged/LedgerSettled（wallet.balance.changed / billing.ledger.settled）死常量仍在权威事件表，全仓无 emit/订阅。
- **待确认**：死信注入闭环（消费方 3 次失败入死信→重投不双计）黑盒无法注入失败消费方，未实测；降级链 5xx 路径未单测（offline/网络错误/超时三路径均实测，5xx 与超时同 catch 路径）。

## 四、测试资源说明

自建 `meter-` 前缀资源（3 模型/3 渠道组/1 预算）已全部删除或停用；本地 stub 进程（17311/17312）已终止；usage 事件按幂等管道规则保留（meter-idem-* 等，charge=0 不影响成本口径）。未触碰其他组资源；报告中 token 已脱敏。
