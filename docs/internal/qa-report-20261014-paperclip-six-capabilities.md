# 外部评估报告处置 + 六大能力（Paperclip 视角）实测报告

日期：2026-10-14。执行：项目负责人带队（缺陷处置组 / 源码测绘组 / 线上实测组）。
对象：外部团队《整体功能测试报告-20261014》 + Paperclip 式六大能力深入验证。
线上：https://ybkkasi.com/（本机 launchd `com.ybkk.ops-platform` · 端口 7300 · Cloudflare Tunnel 回源）。
证据：`docs/internal/evidence/2026-10-14-paperclip/results.json`（第一轮 50 项）、`results-fix2.json`（第二轮 26 项）。

## 一、验收结论

**外部报告四项缺陷（QA-01/02/03/04）本次全部修复、全量回归通过并已上线复验；OBS-01 查明为测试基线错位，非产品缺陷，随仓库合流一并关闭。**
六大能力实测结论：**Governance Gates 已实现且线上全链验证通过（10/10）；Org Chart / Budget Control / Multi-Company 部分实现（隔离与闸门真实存在，但粒度与覆盖有明确缺口）；Goal Alignment 与 Heartbeats 未实现（336+ 条路由 0 命中，属权威缺位）**。优化路线图见第四节。

回归基线：selftest **1210/1210**（1201 → 1210，净增 9 条回归断言）；DOM 冒烟 **14/15 + 1 跳过**（两轮稳定）。

## 二、外部报告逐项处置

### QA-01（P1）HTTP 明文口不跳转 —— 已修复上线，线上复验通过

- 根因：平台自身仅 HTTP（`packages/platform-core/src/http.ts`，`node:http` 无 TLS），TLS 由 Cloudflare Tunnel 承接，源站从未下发跳转；边缘「Always Use HTTPS」也未开启。
- 修复（源站兜底层，`http.ts` dispatch 入口）：
  - `x-forwarded-proto: http`（即用户走了明文入口）→ **308 保方法跳转 HTTPS**（带 Location，含 path+query）；本机/内网直连与 dsh 挂载形态（无该头）不受影响。
  - 确认安全传输（`x-forwarded-proto: https` 或 socket.encrypted）时下发 **HSTS `max-age=31536000; includeSubDomains`**；明文链路不下发（无意义）。
- 线上复验：`curl http://ybkkasi.com/api/health` → `308` + `location=https://ybkkasi.com/api/health`；HTTPS 响应含 HSTS 头。
- 回归断言 ×3（selftest）：明文 308 跳转 / HTTPS 下发 HSTS / 无转发头不跳转不下发。
- **遗留（边缘层，需 Cloudflare 控制台操作，代码层不可达）**：开启 Zone 级 Always Use HTTPS + HSTS 灰度启用（见路线图 R1）。源站 308 已使明文入口实际不可达，边缘开关属纵深加固。

### QA-02（P2）工作台无权入口点击后留白 —— 已修复上线

- 修复（三层）：
  1. **CTA 权限门控**（`pages/dashboard.js`）：「处理审批」按 `approval.read`、「查看 Agent」按 `agent.read`、「处理同步冲突」按 `iam.user.read`、「用量明细」链接按 `usage.read` 条件渲染——无权角色不再看到点了必白的入口。
  2. **页面级统一兜底**（`app.js` renderShell）：任一页 builder 抛错（首请求 403 / 网络失败）不再留白，渲染「页面加载失败 + 错误原因 + 重试」错误卡。该兜底覆盖全部 17 个域页面（含外部报告点名的 approvals/assets 首请求无 catch 问题）。
- 线上复验：静态资源已更新（dashboard.js 含 `session.can('approval.read')`、app.js 含 page-retry 兜底）。
- 回归断言 ×2（selftest 静态守卫）。dev01 视角效果：审批按钮消失、用量明细链接消失，不再出现 403 留白。

### QA-03（P2）资源管理员能写不能读 —— 已修复上线，线上复验通过

- 根因：`resource_admin` 内置角色缺 `panel.read`（数据集/指标/血缘读路由的权限点）与 `flow.read`（事务流模板/实例列表），而写面（`resource.dataset.write`/`flow.admin`）齐备——角色配置与路由授权各自成立，组合起来自相矛盾。
- 修复（`packages/plugin-iam/src/index.ts`）：`BuiltinRoles.resource_admin` 与幂等迁移 `BUILTIN_ROLE_MIGRATION.resource_admin` 双处补 `panel.read` + `flow.read`（迁移「缺则补」，重启即对存量库生效，不触碰自定义角色）。
- 线上复验：ops01 登录（权限 19 → **42 项**），GET 数据集清单 / 事务流模板 / 事务流实例全部 200。
- 回归断言 ×2（selftest）。审计员仍只读、跨组织隔离不受影响。

### QA-04（P2）update 可清空必填描述 —— 已修复上线，线上复验通过（产品决策：合并后必须保持完整）

- 产品决策（负责人拍板）：`required` 语义 = 资源**全生命周期持续完整**。update 校验对象是合并后的完整 attrs，required 与 create 同等强制；空值 PATCH 返回 400。`requiredForOnline`（上线前补全类字段）维持原语义不变。
- 修复（`packages/plugin-resource-core/src/index.ts` validateAttrs）：`update` 模式纳入 required 检查；agent/app/nas 三类资源全部受益（NAS 的 gatewayUrl/accessToken/nasIp 同样不再可被 PATCH 清空）。
- 线上复验：dev01 建 QA Agent → `PATCH {"attrs":{"description":""}}` → **400**（错误含「必填」）→ 详情确认原描述原样保留。
- 回归断言 ×2（selftest：400 拒绝 + 拒绝后落库值未被污染）。

### OBS-01 部署内容与测试源码差异 —— 非缺陷，根因是仓库分叉，已合流关闭

- 根因：**GitHub main 与生产所在本地 main 自 `7fb5225` 起分叉**。远端多出移动端早期实现（`1cdfd38`）与 IAM R4 修复（`91673ef`，即外部团队检出版本）；本地多出移动端正式版（`bd68eb6`）、双 P1 安全收口（`7177510`）等 5 个提交。外部团队对照的是**不含安全修复**的 GitHub 版，线上跑的是**不含 IAM 修复**的本地版——双方看到的都不是同一份代码。
- 处置：merge 合流（`9ec9e29`）。5 个双方同改文件（base/home.css、app.js、home.js、panel.css）取本地版（更新且经 18 页线上实测）；远端独有 IAM 修复、dom-smoke 更新、QA 报告全部保留；本地独有安全修复保留。合流后 selftest 1201/1201 基线全绿，随后叠加本轮修复。
- 「base.css 62995 字节 / app.js 15214 字节」经 stat 实测与本地 HEAD **逐字节一致**，外部报告量到的差异来自其检出版本（或 CDN 压缩协商字节数），非线上陈旧。
- 静态资源 cache-control 实为 `no-cache`（`http.ts:346`），不存在 max-age=14400 陈旧缓存问题。

### 外部报告「验收关闭条件」对照

| 关闭条件 | 状态 |
| --- | --- |
| 1. 修复 QA-01/02，处理 QA-03，确认 QA-04 契约 | ✅ 全部完成（本文第二节） |
| 2. 提供具备 usage.read / modelgw.read / market.read 的专用测试身份 | ✅ 已验证可行：hr01 建自定义角色+账号全链可用（第二轮实测 S5/R4 全过，用后收敛停用）；制度化见路线图 R6 |
| 3. 可回收环境补 MCP/NAS/连接器/模型/SSO/告警/Flow/升级回滚端到端 | ⏳ 部分完成：审批/Agent 生命周期/MCP 工具桥已有 10-14 全生命周期报告 + 本轮 Gate 全链线上复验；模型真实调用线上目录为空（0 模型），需先登记目录 |
| 4. 对齐生产版本 + 全角色全页面/移动端/多浏览器 | ✅ 版本已对齐（合流 + 推送）；GUI 全矩阵仍欠 |
| 5. 历史遗留复验 | ⏳ 保留台账（自审批取消决策、approval_decide confirmed 传参等，见路线图 R7） |

## 三、六大能力实测（Paperclip 视角）

### 成熟度总矩阵

| 能力 | 成熟度 | 线上实测 | 核心证据 |
| --- | --- | --- | --- |
| 1 Org Chart | **部分**（人的组织树完整；Agent 无角色/职级/汇报线） | 3 项全过 | 组织树/负责人/子树权限真实可用；Agent 对象 0 个层级字段 |
| 2 Goal Alignment | **未实现** | 2 项（权威缺位证明） | 336+ 条路由 0 个 goal/mission/okr 端点 |
| 3 Heartbeats | **未实现**（仅接入资产心跳 + 人工提报义务） | 2 项 | 唯一心跳=POST /api/connect/heartbeat；metrics-report 为被动提报、无平台唤醒 |
| 4 Budget Control | **部分**（org/model 级完整；无 Agent 级、无超额联动停用） | 6 项过 2 项受限 | 0 元组织级预算 breached=true 实测；block 拦截路径 selftest 覆盖（线上模型目录空，无法走 invoke 到熔断点） |
| 5 Governance Gates | **已实现**（六能力中最强） | 10 项全过 | 身份纳管门禁反向拦截→trial→L4 挂单→审计可见→无 decide 403→缺 confirmed 400→终审 executed→真上线 |
| 6 Multi-Company | **部分**（账号+计量两条线隔离扎实；多数清单端点无租户过滤） | 4 项过 1 项缺口实证 | tenant 模型/plan 字段存在；agents 清单跨组织可见（缺口实证） |

### 1. Org Chart —— 3/3 过

- hr01 读组织树：节点/层级/负责人（leaderUserIds）结构完整；用户挂组织、title 字段承载职级（自由文本）。
- 组织子树权限真实生效：非 `*` 管理员只能操作本组织子树账号（assertManageScope，fail-closed），机器主体一律拒绝。
- **缺口（实测实证）**：Agent 实体字段 = name/attrs(autonomy/runtime…)/ownerId/orgId/status——**没有 role（CEO/CTO/工程师）、rank（职级）、managerId/reportTo（汇报线）**；「委派沿组织架构流动」无承载结构。

### 2. Goal Alignment —— 0/2（未实现，权威证明）

- 以 audit01 拉 `/api/platform/route-matrix` 全量 336+ 条路由做正则扫描：`goal|okr|objective|mission` **0 命中**（第一轮误报系 `submissions` 撞词，第二轮已修正）。
- 每任务追溯到公司使命的「做什么/为什么」两层结构不存在；最接近的现成机制是事务流（flow）与部门面板任务（panel tasks），均无目标关联字段。

### 3. Heartbeats —— 1/2（被动提报存在，主动唤醒不存在）

- 唯一心跳端点 = `POST /api/connect/heartbeat`（dsh 远程客户端每 5 分钟存活上报），语义是**接入资产监测**，不是 Agent 定时唤醒；人工令牌探针被受控拒绝（fail-closed）。
- Agent 侧仅有**接入义务**：外部 Agent 每日主动调 `POST /api/agents/:id/metrics-report` 提报 dau/会话/用户数（实测 200，返回纯运营指标）。
- **缺口**：无任何「按计划醒来、检查工作、行动」的调度器（全仓库 setInterval 均为自检巡检，无 cron 库）；心跳不驱动委派、不催办、超期不告警。

### 4. Budget Control —— 6/8（org 级真实有效；Agent 级缺失）

- 实测通过：panel.config.write 为 QA 组织设 **0 元日/月预算（block）** → `/api/usage/summary` 立即返回 `budget.daily.breached=true`；预算边界正确（dev/ops/audit 配置 403，hr01=200 系组织管理员迁移已授 panel.config.write，属设计内）；预算可停用（清理）。
- **发现 ①**：`modelSlug:'*'` 是**字面量不是通配**（enforceBudget 按相等匹配），组织级全量阻断必须省略 modelSlug——文档与前端若按「* = 全部」理解会静默失效，建议显式支持 `*` 或改名 all。
- **发现 ②**：invoke 路径上**模型目录解析先于预算熔断**（未知模型 400 先返回），预算不拦截未登记模型的调用尝试；真实熔断抛错路径由 selftest IAW 1-4 覆盖（线上模型目录为空、0 模型，无法在不触达真实供应商前提下走完 invoke→熔断，故该项以 selftest + breached 标志双证据代替）。
- **缺口**：预算粒度仅 org×model——**无按 Agent/应用的月度预算**；Agent metrics-report 提报的用量与预算零联动（提报 200，无冻结/停用语义）。

### 5. Governance Gates —— 10/10（全链线上闭环，本轮最重验证）

以 qa_verify（专用身份，owner=自己）+ 独立 QA 组织完整走通：

1. **身份纳管门禁（反向）**：无 SSO/entryUrl 直接申请上线 → 400「上线门禁：必须完成身份纳管」——门禁在挂单前即拦截；
2. trial 准入：trialGroups guard 通过进入试运行；
3. **L4 挂单**：补 entryUrl 后 online → 生成 `riskLevel=high` 审批单，Agent 不落地；
4. **透明性**：审计员（approval.read）可见 pending 单；
5. **决定权收敛**：审计员尝试决定 → 403（approval.decide 仅授权角色）；
6. **二次确认闸**：L4 通过缺 `confirmed` → 400；
7. **终审标记**：confirmed + finalReview → 审批单 executed，落公司级终审；
8. **闭环**：审批执行后 Agent 实际 online；
9. 越权写守卫：非 owner 跨主体 PATCH/transition 403（`assertAgentOwner`，上轮 P1 修复持续有效）；
10. 清理链：offline 审批 → 归档 → 删除，全程留审计。

已知的**语义缺口**（非本轮引入）：「提交人=审批人」自审自批拦截已于 2026-09-15 按业务决策取消（`plugin-audit` 内注释）——与 Paperclip「雇佣/高危需独立审批」语义冲突，列入路线图复议。

### 6. Multi-Company —— 4/5

- 租户模型真实存在：`GET /api/iam/tenants` 返回含 plan（trial/standard/enterprise）/status 的租户清单；组织可挂租户（tenantId，缺省兜底 t_default）。
- **隔离扎实的两条线**：账号管理（子树隔离 fail-closed）；用量计量（UsageEvent 带 tenant_id + 索引，`/api/usage/totals?tenant_id=` 实测 200 可过滤）。
- 预算按组织隔离实测：QA 组织 0 元预算不影响其他组织。
- **缺口（实证）**：`GET /api/agents` 等多数清单端点**不按组织/租户过滤**——dev01 一次调用可见全平台各组织 Agent 台账（orgId 分布实证）；approvals/orgs 清单同样全量。「一个部署跑多家公司、数据完全隔离」在清单读面尚未成立；亦无登录态租户切换器。

### 7. 模型目录登记能力核查（专项确认：平台目前没有此交互功能）

**结论：确认。模型目录登记当前无任何交互界面（UI），属于设计上的「管理员通道，非自助登记」，但连管理端界面也没有——登记的唯一途径是 super_admin 直接调 API。**

证据链（源码 + 线上实证双重确认）：

1. **前端零交互**：全前端 `public/js/` 检索 `/api/modelgw/*`，0 处页面调用（仅文案提及）。资产登记页明确写死（`pages/register.js:16`）：「模型接入：模型由管理员经 modelgw 统一接入（**非自助登记**），这里仅查看已接入模型」，badge=管理员通道，查看入口跳 `#/assets`（资产运营页）。
2. **权限归属**：权限目录定义了 `modelgw.read`（查看目录）/`modelgw.invoke`（调用）/`modelgw.admin`（管理目录）三点，但 **内置 6 角色与幂等迁移表均未授予任何非超管角色**——只有 super_admin（`*`）持有。四大测试账号（dev/ops/audit/hr）连查看目录都不可达，这正是外部报告「模型目录受阻」的机理。
3. **线上实证**：dev01/ops01/hr01 `POST /api/modelgw/models` → 403（缺 modelgw.admin）；dev01 `GET /api/modelgw/models` → 403（缺 modelgw.read）；`GET /api/modelgw/channel-groups` → 200 但 `groups:[]`（渠道组同样为空）；ops01 `GET /api/assets/inventory` → 403（缺 usage.read，台账查看面也不可达）。
4. **模型网关整体未初始化**：线上模型目录 0 条 + 渠道组 0 组 + 预算 0 条。

**现行登记通道（admin API runbook，立即可用）**：

```bash
# 以 admin（super_admin）登录后：
curl -X POST https://ybkkasi.com/api/modelgw/models \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{
    "slug": "deepseek-chat",
    "displayName": "DeepSeek Chat",
    "provider": "deepseek",
    "endpoint": "https://api.deepseek.com/v1/chat/completions",
    "apiKey": "env:DEEPSEEK_API_KEY",
    "costCentsPerKTokens": 0.1,
    "status": "online",
    "dataClassLimit": "secret"
  }'
# apiKey 支持 "env:变量名" 引用服务器环境变量（读取响应中 env: 前缀不做掩码，其余一律 ***）；
# 删除：DELETE /api/modelgw/models/:id（modelgw.admin）。
# 登记后：/api/usage/summary 进度、#/assets 模型台账、预算熔断、市场关联全链自动生效。
```

**修订路线图 R2**（替代原「模型目录登记」条目，两轨并行）：
- **R2-A（立即）**：由 super_admin 按上述 runbook 登记生产模型（deepseek-chat/reasoner/coder 三个 schema 枚举值），解除预算熔断/FinOps/市场闭环的端到端验收阻塞；登记后复跑本报告 S7b 熔断实测。
- **R2-B（短期，约 1 天前端量）**：补管理交互——在 `#/assets`（或 finops）页增加「模型目录」管理卡：列表（`modelgw.read`）+ 登记/下线表单（`modelgw.admin` 门控渲染），同步把 `modelgw.read` 补入 resource_admin 迁移（资源管理员可查看目录）、`modelgw.admin` 保持 admin 专属或按需授予；渠道组/预算编辑同卡承载（`panel.config.write` 已有 hr01 持有）。
- **R2-C（配套）**：模型目录登记后的复验清单——summary.budget 进度、assets 台账 model 行、invoke 熔断、（可选）真实调用冒烟。

## 四、优化路线图

### 已完成（本次交付）

- R0 仓库合流归一（分叉 closes OBS-01）+ QA-01~04 全修复上线（含 9 条回归断言）。
- R0b dom-smoke 种子竞态修复（`void seedAll` 异步落盘 vs 健康检查先亮；观测窗口 0~1.5s）——修复后两轮 14/15+1 SKIP 稳定。

### 短期（运维/制度，1 周内）

- R1 Cloudflare 控制台：Always Use HTTPS + HSTS 灰度（源站 308 已兜底，此项为纵深）。（负责：运维）
- R2 模型目录登记：见第三章第 7 节 R2-A/B/C（确认平台无登记交互功能，admin API runbook + 管理界面补齐两轨）。（负责：admin / 前端）
- R3 `modelSlug:'*'` 通配语义：显式支持或文档纠偏（当前为字面量）。（改 modelgw enforceBudget 过滤器，1 行 + 断言）
- R4 预算/角色/租户删除面补齐：budgets、roles、users 无 DELETE 路由（本轮 QA 角色/预算只能停用+收敛，留存量）；至少给「无引用对象」补删除或归档口。（P3）
- R5 向外部团队交付「专用测试身份」标准流程：hr01 建角色（usage.read/modelgw.read/market.read/approval.read/panel.read）+ 账号 → 验收 → 权限收敛 + 账号停用（本轮已全链演练，剧本即第二轮 harness）。
- R6 外部报告 GUI 欠账：四角色全页面 × 移动端矩阵复测（上轮浏览器超时未完成项）。

### 中期（产品能力建设，Paperclip 对齐主线）

- R7 **Agent 组织化（Org Chart 扩展）**：agent schema 增 `orgRole`（CEO/CTO/工程师枚举）、`rank`（职级）、`managerId`（汇报线，校验无环）；组织架构图页面渲染「人 + Agent」双层视图；部署/委派接口沿汇报线下达、汇报沿线上浮。承载现有 autonomy A0-A3 语义。
- R8 **Goal Alignment**：新增 mission（公司使命）/goal（目标，支持父目标）实体 + `goalId` 关联字段挂到 flow 模板/panel 任务/Agent；「为什么」透出：任务详情与 Agent 提示词注入目标链（做什么 ← 为什么）；⌘K 与工作台增加目标视图。
- R9 **Heartbeats**：平台侧调度器（复用 bus 事件 + 现有巡检 tick 模式）：按 Agent 配置 interval/cron 唤醒 → 拉取待办（panel 任务/flow 步骤）→ 按汇报线委派 → 心跳日志入审计；metrics-report 超 24h 未提报自动催办；心跳数据入 Agent 健康度。
- R10 **Budget Control 深化**：预算主体扩展到 agent/app（per-Agent 月度预算）；metrics-report 用量（换算成本口径）计入预算窗口；**超额联动停用**（freeze Agent + 生成 L4 解冻审批单，复用现有审批/冻结基建，天然带二次确认）。
- R11 **Multi-Company 收口**：agents/apps/approvals/orgs/skills 等清单端点补 org/tenant 作用域过滤（跨组织清单按组织子树收敛，`*` 管理员豁免）；登录态绑定租户切换器；补跨组织清单 403/过滤的回归断言网。

### 治理复议

- R12 自审批拦截取消决策（2026-09-15）复议：Paperclip 语义下「雇佣 Agent/高危操作」应由非提交人审批；若维持单人通过，至少对 `agent.online`（雇佣语义）恢复职责分离。（产品决策）

## 五、测试纪律与残留说明

- 全部实测使用 QA 前缀实体，结束时逐项清理并复验：2 个 QA Agent 已删除、qa_verify 已停用（停用后登录被拒实测）、QA 组织已级联删除、QA 角色权限收敛为仅 console.login（平台无角色删除路由，收敛处理）、QA 预算已停用（组织删除后为孤儿禁用记录，无害）。审批中心留有本轮 executed 审批单（审计留存，属设计内）。
- 未触碰既有业务对象、账号、口令与生产配置；未调用真实模型（预算熔断探针被模型解析前置拦截，供应商零触达）；四账号会话均正常过期，无凭据写入报告与证据文件（已 grep 校验）。
- 已知残留台账：qa_paperclip_* 角色 ×1（权限已收敛）、禁用孤儿预算 ×2、历史 QA Agent 接入态（上轮交付物）。
- 线上服务全程平滑：仅一次计划内重启（修复上线），健康检查前后正常。
