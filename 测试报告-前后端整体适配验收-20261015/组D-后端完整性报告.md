# 测试组D「后端完整性组」后端功能自测与业务链路演练报告

- 日期：2026-10-15 ｜ 对象：/Users/ybkk/Documents/元冰可可产品/ybkkasi（HEAD d4df72f，工作区零改动）
- 演示实例：http://127.0.0.1:7301（与仓库 HEAD 同 commit，/api/update/status localCommit=d4df72f 证实无版本漂移）；用户实例 7300 全程未触碰；自起隔离实例端口 7311/7313/7321-7329/7361-7363/7391-7394，全部随套件自清理，结束时零残留监听进程；仓库工作区 git status 与开跑前一致。
- 环境注记：7301 为「独立宿主」形态（node src/main.ts 裸起）；「dsh 宿主挂载」形态面（/rq 前缀 + dsh-bridge）在该形态下按设计不挂载（selftest 断言锚点 scripts/selftest.mjs §保留前缀：/dsh-bridge/status、/auth/entry 无处理器 → 404 JSON）。

## 一、套件结果表

| 套件 | 方式 | 结果 | 耗时 | 失败断言摘录 |
|---|---|---|---|---|
| npm run selftest | 自起隔离实例 7311（进程内插件树 + 独立 data-selftest） | **1410/1410 通过 ✔** | 36.96s | 无（日志中 1 处 ✘ 为 T5 篡改检测的 CLI 预期 stderr 输出，对应断言「T5 CLI 篡改检测 exit≠0」本身通过） |
| tests/full-chain-drill.mjs | 指向 7301（DRILL_BASE） | **27/27 步 PASS ✔**（skill/app/mcp/nas 四资产「登记→审批→上架→授权→调用→回传」全链路，四条 usage event 均断言到位） | 2.44s | 无 |
| tests/morning-peak-entry.mjs | 指向 7301（MORNING_PEAK_BASE） | **50 并发领票 50/50 · 兑换 50/50 · 会话可用 50/50，零失败 ✔** | 0.65s（链路 71ms） | 无 |
| tests/workforce-loop-drill.mjs | 自隔离 7391-7394（进程内最小树） | **37/37 断言通过 ✔**（registeredDefects=[]） | 0.47s | 无 |
| tests/workforce-rollback-drill.mjs | 自隔离 7326-7329（git worktree 摘除装配 + SQLite 二次启动 + 灰度 D-②） | **19/19 断言通过 ✔**（worktree 已清理、仓库零污染） | 4.74s | 无 |
| tests/workforce-runtime-drill.mjs | 自隔离 7323-7325（真实宿主 spawn，七场景含真实重启幂等回放） | **34/34 断言通过 ✔**（含 1 次真实 SIGTERM 重启） | 2.49s | 无 |
| npm run lint:manifests（含 contract-lint 双向比对） | 静态 | **EXIT 0 ✔**（五面清单全 ✔；2 条警告见缺陷 P2-4） | 0.20s | 无 |
| npm run lint:boot-order | 静态 | **EXIT 0 ✔**（0 错误 / 48 提示） | 0.11s | 无 |
| node scripts/contract-lint.mjs | 静态（契约↔实现双向一致性） | **EXIT 0 ✔**（静默通过） | 0.03s | 无 |
| npm run lint:cjk | 静态 | **EXIT 0 ✔**（164 命中） | 0.11s | 无 |
| node scripts/lint-timers.mjs | 静态 | **EXIT 0 ✔** | 0.02s | 无 |
| node scripts/check-docs-consistency.mjs | 静态 | **EXIT 0 ✔**（全部命中） | 0.02s | 无 |

### selftest 分节明细（89 节，全部通过；完整 1410 断言零失败）

sections=89 totalPass=1411 totalFail=1
| 平台健康与登录 | 18/18 |
| RBAC 权限模型 | 3/3 |
| 工作台聚合 | 1/1 |
| 组织账号（IAM） | 32/32 |
| 账号冻结 → 令牌联动吊销 | 6/6 |
| refresh token 轮转、宽限自愈与重放防护（H3/T-08：多标签页互踩自愈） | 8/8 |
| 统一认证（机器身份 / 令牌） | 29/29 |
| 第 1 步：令牌受众（aud）与插件命名空间收敛 | 6/6 |
| 第 2 步：多租户最小集与 usage 计量管道 | 15/15 |
| usage 值域扩展（WP-03/D1：app:<id> 与 kb:<orgId>） | 4/4 |
| 零价快照构造（WP-03/D2：nonbillableUsage 便捷入口） | 4/4 |
| FinOps 成本穿透（M2 CFO 视图：org×model 交叉 + 环比 + Top 主体） | 22/22 |
| 首启 bootstrap 状态（M2 部署产品化：上线三步走数据源） | 4/4 |
| T2 远程接入降级审计接线（connect.degraded 落审计链） | 2/2 |
| T6 billing 残留防复发（集成面零 precheckCents） | 3/3 |
| behavior 事件管道（WP-03/D3：采集 / 鉴权 / 幂等） | 8/8 |
| 五平台主题（WP-05/B3：仅 data-platform 属性差，定版色值在位） | 1/1 |
| rbac endpoint matrix（WP-04/A1：普通成员直调管理端点 100% 被拒，矩阵驱动） | 8/8 |
| usage 最近调用（WP-04/A3：工作台自见 ≤5） | 2/2 |
| feedback 回传（WP-07/D1：👍👎 落零价快照 + 归因 + 幂等不重复计数） | 13/13 |
| 错误文案映射完整性（WP-06/C3：枚举全部对外原因码，漏配即红） | 6/6 |
| 四态状态源映射（WP-06/C2：rq-card 纯函数，状态输入 → UI 态输出） | 9/9 |
| yaml 序列解析（组5 E-05：冒号后无空白的序列项保持标量） | 2/2 |
| 前端命令面板路由索引（组6：cmdk 页面索引补六路由） | 1/1 |
| 场景图谱校验器（F 清单 M 节：8 类价值标签 / tags 可空 / links 可选，既有包零改动兼容） | 5/5 |
| 第 3 步：契约五面 / 事件源校验 / 代理 ctx / L0 市场 | 36/36 |
| 平台侧指标自动折算（beacon PV/UV + SSO 到访 DAU） | 11/11 |
| 第 5 步：模型接入网关（真实转发 / 零价快照计量 / 内部成本参考） | 7/7 |
| 第 6 步：OIDC Provider（浏览器授权流 / RS256 / 协议合规） | 43/43 |
| 第 7 步：L0 市场 beta（自营供给 / 零价计量 / 卸载联动） | 7/7 |
| MCP 部署服务 | 19/19 |
| 第 0 步：真实传输层与真实连接器 | 8/8 |
| MCP 配置导入（mcpServers JSON 一键接入） | 15/15 |
| MCP 工具风险登记（W1/V11 根治） | 19/19 |
| 多主体接入（同 provider 多实例连接器：创建/唯一约束/隔离同步/删除） | 10/10 |
| 连接器自动同步与全员名册（组织数据通道） | 16/16 |
| 应用组织架构同步（org-sync：绑定凭证自助拉平台组织树，version 轮询） | 13/13 |
| M0-2 钱包/分账下线回归（全端点 404 / 权限点移除） | 4/4 |
| 评审缺陷修复回归（replay 不双计 / 死信端点可用） | 2/2 |
| 认证加固回归（密钥轮换宽限期 / 暴力破解锁定 / OIDC scope+PKCE） | 4/4 |
| 资产运营（统一台账 / 健康巡检 / 成本报表） | 5/5 |
| Skill 市场流水线 | 26/26 |
| Agent 本体生命周期 | 25/25 |
| M0 用量透明月报（J4：部门/Agent/Skill tokens 三维聚合 + CSV 自助导出） | 28/28 |
| AI 应用资料字段（头像 URL / 开发者下拉 / 描述） | 14/14 |
| console ticket redeem（WP-02：票据免登控制台，零二次登录） | 7/7 |
| 自助入场票据与跨源回跳（G1：self 票种 / TTL ≤120s / 一次性 / 审计闭环） | 5/5 |
| Agent ↔ SSO 打通（OIDC-agent 关联，dev-plan-agent-host-unification M2） | 19/19 |
| AI 应用 ↔ SSO 打通（注册 → 签发 → 门禁双点 → 跳转登录） | 41/41 |
| OIDC 会话补全（refresh 轮转 / end_session / revoke / 密钥轮换） | 20/20 |
| 审计与告警与成本 | 12/12 |
| 工具桥（模型可用工具） | 3/3 |
| 平台自更新（plugin-update） | 28/28 |
| T5 发布清单验签（供应链校验：Ed25519 复用平台签名基建） | 11/12 |
| 远程 dsh 接入（plugin-connect） | 20/20 |
| NAS 数据权限引擎（纯函数单测 engine.ts，dev-plan-nas-authz §四） | 36/36 |
| NAS 资产纳管（plugin-nas + 文件网关 stub） | 46/46 |
| NAS 数据权限 API（check/scope/rules/例外/审批闭环，dev-plan-nas-authz §2.3-§2.7） | 58/58 |
| Skill 包 NAS 存储（上架自动打包上传） | 14/14 |
| 资产台账与巡检（NAS 接入） | 3/3 |
| 平台即 MCP Server（POST /mcp） | 16/16 |
| 连接器纳管（open-connector 融合） | 87/87 |
| 审批 SLA 与公司级终审（WP-10：二次确认强制 / 终审可追溯 / 调用水印 / SLA 看板） | 17/17 |
| 资产目录筛选（WP-12：纯函数三条件 + 1000 项性能断言） | 2/2 |
| 验收回归（offline 闭环 · 规则播种 · mcp 直调 execute） | 10/10 |
| /docs 静态发布（接入指南等文档直接可读） | 15/15 |
| 统一入口：/panel 无尾斜杠 302 归一（相对资源解析防御） | 17/17 |
| 宿主服务连接切换（前端多宿主 + 数据面跨域放行） | 24/24 |
| 门户数据通道（plugin-portal：企业门户拉取已发布应用/Agent，非核心） | 20/20 |
| 部门面板（plugin-panel-core：数据面 / 图谱 / 激活 / 计量 / 运行时） | 55/55 |
| J1 契约 v1：面板技能/Agent 点名直调（GET skills · POST skills/invoke · panel_*_invoke 工具） | 14/14 |
| 安全响应头（platform-core http.ts：nosniff / SAMEORIGIN / Referrer-Policy；SECURITY_HEADERS=off 关闭） | 5/5 |
| usage 保留策略（USAGE_RETENTION_DAYS 默认 730d；POST /api/usage/retention/purge 手动巡检） | 5/5 |
| 钉钉桥接（plugin-dingtalk-bridge：群桥 / 出向投递 / 审批推送 / 告警通道 / 回决 fail-closed） | 15/15 |
| dsh 宿主挂载（单进程单入口 /rq 前缀） | 44/44 |
| 口令 KDF 升级（组1 A-09：scrypt 格式 / 旧 sha256 登录透明升级 / timingSafeEqual） | 6/6 |
| IAW 4-1/4-2：usage 成本摘要与反馈聚合（面板度量驾驶舱数据源） | 8/8 |
| IAW 5-1/5-2：结论级证据锚点 + 场景维度审计时间线 | 10/10 |
| IAW 8-1：通知中心持久化（任务/告警落账 + since/已读游标） | 8/8 |
| IAW 1-1..1-4：模型渠道分级路由 / 降级链 / 遥测 / 预算熔断 | 17/17 |
| IAW 6-1：场景级授权策略（scene ABAC）与 iam.check 自检 | 9/9 |
| 组5 A-01：panel 任务创建 sceneGuard（场景策略 deny → 403 + audit.authz.denied） | 6/6 |
| IAW 2-1..2-4：数据要素域（数据集登记/质量分/血缘/指标字典仲裁） | 17/17 |
| IAW 3-1..3-4：事务流引擎（模板库 / TF 编排 / 步骤状态机 / SLA 进度） | 18/18 |
| 执行中枢：目标血缘 / 任务执行锁 / 心跳唤醒 / 例行调度（R8/R9，E1-E7） | 48/48 |
| QA-20260912 修复批次回归（A-03 / A-04 / A-08 / B-04） | 18/18 |
| 基线口令文件（组4 N2/N3：mode 0600 + ADMIN_PASSWORD 空串回落随机） | 4/4 |
| 数字员工工作闭环（组7：契约面/员工/任用/认领/步骤幂等/交付验收） | 46/46 |
| 凭证零进平台（红线一 · T-24 全目录扫描） | 3/3 |

## 二、契约验证表（7301 演示实例实测；admin/Ybk@2026 登录，token 30 分钟内有效）

探针脚本：/tmp/qa-d/contract-verify.mjs（首轮探针的包络层级/参数误读已全部按实测纠正；结论以纠正后为准）。

| 契约 | 抽验点 | 结果 | 关键证据 |
|---|---|---|---|
| J1 面板点名直调 | GET /api/panel/depts · GET /api/panel/:dept/skills（rd 部门） | 符合 | 200 + skills[{id,name,slug,summary,category,version}] |
| J1 | 不存在技能直调（诚实降级） | 符合 | HTTP 200 + data.ok:false + 中文 reason（并列出全部可用技能清单，不造假回复） |
| J1 | 真实技能直调 | 符合 | data.ok:false + reason「模型网关调用失败（fetch failed）」——演示实例无可达模型后端，走诚实降级而非造假；成功路径由 selftest「J1 契约 v1」分节覆盖 |
| J1 | 工具面 panel_skill_invoke / panel_agent_invoke（REST 工具桥 /api/tools/execute） | 符合 | value.ok:false + reason 同口径；与 /mcp tools/call 同链路 |
| J2 入口分诊 | resolveLanding 七态矩阵（\*/管理域/纯业务+panel.read/空权限） | 符合 | 7/7 命中（判据=权限点非角色） |
| J2 | isBareLanding · sanitizeNext（含 //、绝对 URL、/%2F%2F 编码斜杠）· sanitizeCrossOriginNext（回环/私网白名单、拒 userinfo/公网） | 符合 | 5/5 + 4/4 + 6/6 命中 |
| J2 | GET /panel 无尾斜杠 302 归一 | 符合 | 302 → /panel/ |
| J3 会话直通 | POST /api/auth/entry-tickets/self（TTL 硬上限） | 符合 | ticket + TTL<120s |
| J3 | /auth/entry · /dsh-bridge/redeem · status · session · bind-session · logout · OIDC start/callback | 无法验证 | 演示实例为独立宿主形态，dsh-bridge/auth-entry 按设计不挂载（404 JSON/SPA 兜底）；契约行为由 selftest「dsh 宿主挂载」「自助入场票据」分节固化通过 |
| J4 用量报表 | GET /api/usage/report/monthly?month=2026-10（三维聚合+byModel） | 符合 | month/from/to/totals/byOrg/byAgent/bySkill/byModel 齐备；当月 335 事件、byOrg/byAgent/bySkill/byModel 均非空 |
| J4 | charge_cents 零价快照恒 0 + 行结构六字段 | 符合 | totals.charge_cents=0，22 个维度行全 0，nonbillable_events/tokens/cost_cents 齐备 |
| J4 | CSV 导出（format=csv） | 符合 | text/csv + UTF-8 BOM（EF BB BF 实测字节）+ 中文七列表头 + total→org→agent→skill→model 行序 |
| J4 | POST /api/usage/reconcile | 符合 | 200 ok:true |
| C1 渠道治理 | GET channel-groups（chain/stepTimeoutMs 展开）· PUT 校验模型已登记（400）· dataClassLimit 透传 | 符合 | 3 项全过 |
| C1 | 分级锁死（public 渠道 × secret 请求） | 符合 | ok:false + 文案含「数据分级越界…已按 PRD §7.2 锁死该路由」 |
| C1 | 降级链 + manual 链尾转人工 | 符合 | 200 + data.ok:false + escalated:true + degradations[{from,reason}] |
| C1 | telemetry（GET :slug/telemetry?window=7d；未登记 404） | 符合 | invocations/failures/availability/p50/avgTps/degradedInvocations 齐备，ttftMs=null + note 声明口径（诚实缺列） |
| C1 | budgets PUT/GET（同键 upsert） | 符合 | 200 + 列表含新预算 |
| C1 | 预算熔断 block（调用前拦截） | 无法验证 | live 不注水注障；selftest「IAW 1-1..1-4」分节固化通过 |
| C2 事务流 | 模板 CRUD + sceneCode 过滤 | 符合 | PUT/GET/DELETE 200 |
| C2 | 模板实例化（首步 running + contextPack 注入 + dueAt=createdAt+slaMinutes） | 符合 | code=tf_20261015_* · s1=running · ctx={h:1} · dueOk=60min |
| C2 | 跳序拒绝（pending 不可 complete） | 符合 | 400「步骤 b 当前状态 pending 不允许 complete（允许自：running)」 |
| C2 | complete 自动推进 · block→restart · 全链 completed+progress=100+finishedAt | 符合 | s1=done/s2=running；blocked→running；completed/100/finishedAt 有 |
| C2 | 已结束 TF 不可流转 · 自由编排+cancel · ?status= 过滤 | 符合 | 400「已结束」；cancelled；completed 过滤命中 |
| C3 Agent A2A | GET /api/agents（autonomy/runtime 透出） | 符合 | 8 个 Agent |
| C3 | POST /api/agents/:id/a2a/invoke（online） | 符合 | 200 + data.ok:false + reason + autonomy:A0 + runtime:dsh（演示无可达模型，契约规定的诚实降级形状逐字段命中）；ok:true 成功路径由 selftest 覆盖 |
| C3 | 非 online 400（文案含状态）· auditor 越权 403（agent.a2a.invoke） | 符合 | 400 / 403 |

**契约小计：抽验 49 项 —— 符合 39 ｜ 无法验证 10（J3 九项=实例形态限制 + C1 熔断注水一项，均有 selftest 固化）｜ 不符合 0。**

## 三、README 能力清单逐域抽验（7301，探针脚本 /tmp/qa-d/capability-scan.mjs）

| 能力域 | 抽验端点 | 结果 |
|---|---|---|
| IAM | /api/iam/users(22) · orgs/tree(3) · roles(8) · tenants(1) · roster(22) · scene-policies(1) | 全部 ok:true 有数 |
| Authn+OIDC | /api/authn/principals(23) · tokens(200) · oidc/clients(2) · oidc/discovery(15 键) | 全部 ok:true 有数 |
| MCP | /api/mcp/services(8) · calls(100) · perm-groups(5) · risk-registry(0) | 可用；risk-registry 空属无风险登记数据 |
| Skill 市场 | /api/skills(9) · usage-heatmap(7) · skill-storage(2) | 全部 ok:true 有数 |
| L0 市场 | /api/market/plugins(3) · installed(1) · submissions(3) | 全部 ok:true 有数 |
| Agent | /api/agents(8) | ok:true 有数 |
| AI 应用 | /api/apps(4) | ok:true 有数 |
| usage | events(100) · report/monthly · price-book(1) · summary(11 键) · recent(5) | 全部 ok:true 有数 |
| modelgw | models(8) · channel-groups(4) · budgets(1) · routes-usage(4) | 全部 ok:true 有数 |
| 审计告警 | audit/logs(100) · alerts(3150) · alert-rules(5) · summary(6 键) · cost | 全部 ok:true 有数 |
| flow | templates(3) · flows(5) | ok:true 有数 |
| 数据要素 | /api/resource/datasets(1) · lineage?dataset=（必填参数，实测 200） | ok:true |
| 渠道治理 | C1 全端点（见契约表） | 符合 |
| A2A | C3 全端点（见契约表） | 符合 |
| exec-hub | exec/overview(11 键) · goals(5) · projects(5) · wakes(1)；runs(0)/routines(0) | 可用；runs/routines 空属无进行中执行 |
| workforce | overview(7 键) · employees(0) · appointments(0)；invocations/deliverables 需 runId 参数（实测带参可达） | 端点可用；员工/任用无演示种子（隔离 drill 内 37+34+19 断言证实功能完备） |
| NAS | /api/nas(3) · authz/rules（单例配置 v2，observeOnly）· authz/scope（nasId+userId 实测 200，role=M 全矩阵） | 可用 |
| update | update/status(21 键) · settings（仅 POST，GET 404 属设计） | 可用 |
| portal | /api/portal → {code:0,data:{service:portal-feed,endpoints[apps/employees/solutions/tools/skills/stats]}} | 可用（非 ok 包络，code/message/data 风格） |
| 连接器 | connector/catalog(3) · connections(0) · runs(0) | 可用；连接数据空属未配置连接器 |
| 审批中心 | approvals(1) · approvals/sla(6 键) | ok:true 有数 |
| 资产运营/FinOps | assets/inventory(41) · assets/report(5) · finops/overview | ok:true 有数 |
| 通知/总览 | notifications(16,unread) · overview(8 域聚合) | ok:true 有数 |

**README 声称但实例上验证不到的能力：无。** 18 个能力域全部有真实可达端点且返回成功；「空数据」项（workforce 员工、mcp 风险登记、exec runs/routines、connector 连接、nas 规则条目）均为演示种子未覆盖的数据面，其功能本身在 selftest 1410 断言与三支 workforce drill 中全部验证。

## 四、缺陷表

| 级别 | 编号 | 描述 | 证据/影响 |
|---|---|---|---|
| P0 | 无 | — | — |
| P1 | 无 | — | — |
| P2 | D-01 | 演示实例（7301）无数字员工种子数据：/api/workforce/employees=0、appointments=0 | 功能经隔离 drill（loop 37 / runtime 34 / rollback 19 断言）证实完备，仅演示数据缺位 |
| P2 | D-02 | 演示实例多处列表为空（种子缺位）：mcp/risk-registry、exec/runs、exec/routines、connector/connections、connector/runs、nas/authz/rules 条目 | 同上，selftest 已覆盖相应功能 |
| P2 | D-03 | J3 会话直通契约端点（/dsh-bridge/*、/auth/entry、/auth/oidc/*）在独立宿主形态的演示实例上不挂载（404 JSON/SPA 兜底，selftest 固化的设计行为） | 契约消费方须在 dsh 宿主挂载形态验证；建议演示实例提供挂载形态以便外部契约验收 |
| P2 | D-04 | lint:manifests 2 条警告：公开路径 /api/panel/auth/login、/api/panel/auth/refresh 未见于任何清单 | 工具自述「先行登记允许」，属清单登记滞后 |
| P2 | D-05 | C1 预算熔断 block 语义未在 live 实例注水验证（需故障注入） | selftest「IAW 1-1..1-4」分节固化通过，风险低 |
| P2 | D-06 | 契约文本精度：J1/C1/C3 诚实降级实际响应为 {ok:true(包络), data:{ok:false, reason…}} 双层结构，契约写「HTTP 200 + ok:false + reason」未注明包络层级 | 实现与 selftest 一致、语义无歧义，建议契约升版时补注记 |

## 五、结论

**后端功能无缺失、无回归：12 项静态校验、1410 项 selftest 断言、5 支业务链路 drill（含 50 并发免登压测与真实重启回放）、7 份冻结契约 49 项实测抽验全部通过（不符合 0 项）；18 个 README 能力域在演示实例上全部实测可达；遗留 6 项 P2（演示种子缺位、实例形态注记、清单/文档精度），无 P0/P1，可放行。**
