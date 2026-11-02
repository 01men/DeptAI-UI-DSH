# B 组测试报告：计量与模型网关域（2026-10-13）

> 实例 http://127.0.0.1:7342（DEMO_SEED=1，data-qa-gb，独占）｜ 基线 dsh-enterprise-ops v1.1.0 + REFACTOR-2026-10-13
> 方法：黑盒 curl/node fetch 实测 + 底层事件手算对账 + 只读源码定位；自建资源一律 qa-b- 前缀（测试后已停用/删除，stub 19341/19342 已终止）
> 上轮缺陷基线：docs/internal/qa-report-20260912-group-b-metering.md（B-01..B-08）+ release-notes-2026-09-12/13-qa-fixes.md

## 一、结论总览

**用例 72，通过 70，失败 2**（1 项 P3 新缺陷 + 1 项 P2 新缺陷）。
上轮 B 组 6 项承诺修复（B-01/02/03/04/06 + REL-07/08 关联）**全部回归通过**；B-05 按排期未修（已知）；B-07/B-08（P3）维持原状。

## 二、缺陷清单

### BUG-2510-B1（P2，新）渠道组降级链完全绕过预算熔断——block 模式「调用前熔断」在组路径失效
- 复现：配置 org 级 `action=block` 预算（今日已 breached）→ `POST /api/modelgw/invoke` 被 400 熔断（elapsed=0ms，文案含 used/limit 数字）✅；同一时刻 `POST /api/modelgw/channel-groups/qa-b-grp/invoke` **仍 200 成功调到上游 stub 并计量入账**。
- 期望：block 语义应覆盖全部模型调用路径（组路径直达付费上游且产生 cost_cents）。
- 根因：packages/plugin-modelgw/src/index.ts:438 `enforceBudget(input)` 仅在单渠道 invoke() 调用；invokeWithFallback（:239-291）主/备循环全程无预算检查。
- 注：上轮未暴露（上轮预算经单渠道路径测试）。修复建议：invokeTracked 前或 invokeWithFallback 入口套用 enforceBudget（input.model 可由命中渠道 slug 填充）。

### BUG-2510-B2（P3，新）usage.record 字符串字段无长度上限，超长输入 200 入库
- 复现：`POST /api/usage/record` org 字段 50KB → 200 正常入账（T1 其余 19 类非法输入全 400 且文案指明修正方式）。
- 期望：超长字段 400（本轮测试范围明确含「超长」类）。
- 根因：packages/plugin-usage/src/index.ts:1019 validate() 仅校验非空/格式/数值，无长度上限；与 2026-09-13 已立项的「REST 入参无统一校验设施」共性根因同源。
- 影响：无功能破坏（charge/cost 均 0），属存储卫生/schema 纪律问题。测试残留 1 条 50KB org 事件（skill:qa-t1-res，charge=0）。

### 已知未修（非本轮回归失败）
- B-05（P2，排期内）：packages/plugin-console/src/seed.ts:485 仍直写 `costs.insert({costYuan: tokens*0.0000015})`，audit:costs 28 天非零演示成本为管道外造数（与 release-notes-2026-09-12 §五「单独批次处理」一致）。本轮 T7/T10 证明 usage 管道侧成本口径已双轨健康（mcp:* cost 15/1000、model:* costCentsPerKTokens 均经管道入账）。
- B-07（P3，排期外）：plugin-panel-core/src/service.ts 仍无 modelgw.degraded / modelgw.budget.warning 订阅（grep 无命中），提示条不存在；bus journal 落盘留痕正常（本轮实测 2 条 degraded + 1 条 budget.warning）。
- B-08（P3，排期外）：plugin-rq-card/src/client/index.ts:76 工具白名单仍含 billing_wallet_balance；locales.ts:27 钱包文案残留。

## 三、用例明细

### T1 usage schema 非法输入（20 例：19 过 / 1 败）
缺 org/subject/principal、resource 空/无冒号/大写前缀/非法字符@/NaN 注入、meters 空数组/非数组、计量键大写/连字符、计量值负数/字符串/NaN/布尔、编造计量键（skill 配 tokens → 「请按 calls 重报，不要编造计量键」）、未登记资源 widget:*（「无计价规则：请先在价格簿登记」）、全空对象 → **全部 400 且文案含修正指引**；超长 50KB → 200（缺陷 BUG-2510-B2）。

### T2 幂等（3 例全过）
同幂等键重放返回同一 event_id（uevt_mv6jw7wxdu2jv4fm）不重复入账；同键不同内容 400「幂等键冲突…被拒绝」；不同键同内容各自入账（count=3、Σcalls=21 手算吻合）。

### T3 保留策略与权限（9 例全过）
days=730 → cutoff=2024-10-13T10:41:41.960Z（手算差 2ms，语义正确）、purged=0；days=0 → cutoff 空 + 跳过；days=-5 → 安全回退默认 730d 窗口。purge：ops/hr/dev/audit 全 403（FORBIDDEN，perm=usage.admin）、匿名 401。

### T4 分级路由（5 例全过）
secret→public 上限在线渠道 400「数据分级越界…已按 PRD §7.2 锁死该路由」；缺省 internal→public 同拒（fail-closed）；public→public 放行；渠道组内逐步校验（primary 越级→锁死降级到备1 放行）；计量事件 input=9/output=29、charge=0、cost=round(29/1000×20)=1 分逐项吻合。

### T5 降级链 B-02 回归（3 例全过）
主渠道 offline → 备1（本地 stub）命中，响应 content=`qa-b-stub-reply:qa-b-sec-stub`（stub 回显请求体 model 字段 = **备渠道 slug，B-02 修复确认**，根因位 plugin-modelgw/src/index.ts:477 `model: model.slug`）；degradations 留痕「备用渠道不可调用（已下线）」。超时路径：stepTimeoutMs=1000，实测 1007ms 切换，原因「模型调用超时（1000ms）」；modelgw.degraded 事件 bus journal/overview 可查。

### T6 预算（4 例 3 过 1 败→缺陷）
block：used=7≥limit=3 调用前 400 熔断（elapsed=0ms、遥测 ok:false error=预算熔断）；warn：模型级预算（limit=2 分）used=4 → modelgw.budget.warning payload 手算吻合（limitCents=2/usedCents=4/ratio=2），2 次调用仅 1 条（每预算每日去重）✅；组路径旁路 → BUG-2510-B1。

### T7 J4 月报自洽 B-01 回归（16 例全过，2026-10 与 2026-09 双月）
2026-10：totals.tokens=5,528,862 = 底层 71 事件手算和（逐分不差）；ΣbyOrg.tokens=totals；cost_cents=82,940 = 手算和、ΣbyOrg 自洽；charge 恒 0；CSV total 行与 JSON 同值、CSV Σorg=totals。2026-09：tokens=6,009,038 / cost=90,137 同样四维自洽。上轮「小 176 倍 + ΣbyOrg≠totals」不复现（修复位 plugin-usage/src/index.ts:570 SUM() 包裹关联子查询，summary 同型 :493）。

### T8 /api/audit/cost days B-04 回归（4 例全过）
days=7 → 回显 days:7、tokens=3,051,589 ≠ 全量 12,101,935；窗口金额 461.668 元 = 全量按日期手算和（逐分不差）；days=1 仅今天（246,103 tokens / 72.989 元）；不带 days 保持全量口径兼容。

### T9 usage_query 工具 B-03 回归（3 例全过）
resource=model:qa-b-sec-stub → count=10/cost_cents=10（恰为该资源事件，与 REST events/totals 一致）；principal 过滤 39=REST 39；无过滤 134=REST 134。上轮「resource 返回全库」不复现（修复位 plugin-usage/src/index.ts:408-409 + REL-07 权限点已挂）。

### T10 成本口径 B-06 复核（1 例过）
代码取 cost_cents（plugin-audit/src/index.ts:415，注释点名 QA B-06）；运行时实测：本轮 8 次调用产生 audit:costs 运行时条目 tokens=304/yuan=0.08 = 8 个 cost_cents 换算（round(cents×100)/10000）逐分吻合，而全部 charge_cents=0——若仍取 charge 应为 0，证明口径已切。

### T11 遥测（3 例全过）
增量手算：+2 成功 → inv+2/fail+0；+1 次超时降级（sec-stub 为备）→ inv+1/degraded+1；可用率 10/11=0.909 与 API 一致；ttftMs=null 附诚实口径说明（「TTFT 需流式通道…诚实缺列」）。summary.byResource 9 行全数与底层手算吻合（另 4 条 mcp 事件为 seed 未来时间戳 12:00Z，被窗口正确排除，非缺陷）。charge 全出口=0（J4/CSV/usage_query/usage recent 集合={0}）。

## 四、上轮缺陷回归结论速查

| 编号 | 级别 | 结论 | 证据位置 |
|---|---|---|---|
| B-01 | P1 | ✅ 修复确认 | T7 双月四维自洽（plugin-usage/src/index.ts:570/493） |
| B-02 | P2 | ✅ 修复确认 | T5 转发体含 model.slug（plugin-modelgw/src/index.ts:477） |
| B-03 | P2 | ✅ 修复确认 | T9 三态过滤与 REST 全等（plugin-usage/src/index.ts:408） |
| B-04 | P2 | ✅ 修复确认 | T8 days 生效+回显（plugin-console/src/routes/audit.ts:69-80） |
| B-05 | P2 | ⏸ 排期内未修（已知） | plugin-console/src/seed.ts:485 原样 |
| B-06 | P2 | ✅ 修复确认 | T10（plugin-audit/src/index.ts:415） |
| B-07 | P3 | ⏸ 维持（排期外） | panel-core service.ts 无订阅 |
| B-08 | P3 | ⏸ 维持（排期外） | rq-card client index.ts:76 |

## 五、测试资源与残留说明
- 自建 qa-b-* 模型 4 个已删除、渠道组 3 个已 enabled=false；测试期 usage 事件约 30 条按幂等管道规则保留（charge=0/cost 小额演示口径，不影响报表自洽）。
- 本地 stub（19341 快速回显 model / 19342 慢 3s）已终止；未触碰其他端口与组资源。
