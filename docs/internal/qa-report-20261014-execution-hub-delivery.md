# 执行中枢与治理收口 —— 整体性开发交付报告

日期：2026-10-14。执行：研发负责人带队（执行中枢组 / 治理后端组 / Agent 插件组 / 前端组，攻坚中断后由负责人接管收尾）。
输入：`docs/internal/qa-report-20261014-paperclip-six-capabilities.md` 路线图 R2-R12 + ybkk-MATRIX 开发计划（目标四 E1-E7 / G3）+ execution-hub 技术设计详稿。
回归基线：selftest **1257/1257**（1210 → 1257，净增 47 条断言）；exec-hub 纯决策层单测 13/13；DOM 冒烟 14/15+1 跳过（持平）；lint:manifests / lint:boot-order / lint:cjk 全绿（0 红）。

## 一、交付总览

| 路线图 | 交付 | 关键落点 |
| --- | --- | --- |
| R8+E4 Goal Alignment | **已实现**（从零） | `plugin-exec-hub`：exec:goals（父目标树+指标三件套）→ projects → issues，goalAncestry 写时物化 |
| R9+E3 Heartbeats | **已实现**（从零） | 30s 心跳循环：唤醒队列（幂等键）+ 治理前置链 + 待办三源拉取 + 24h 提报催办 + 健康度五档 |
| E1/E2 执行锁 | **已实现** | issue 行三字段 CAS；决策纯函数（64 组合穷举）与护栏分层；run 级批量释放；僵尸锁超时回收 |
| E5/E6 工具与五联动 | **已实现** | exec_wakeup_status/claim/complete/lineage 四工具；预算硬停/权限校验/审计留痕/密级注记/P0 审批门禁 |
| E7 例行调度 | **已实现** | interval / 5 段 cron（POSIX 日周或语义 + 0/7 周日兼容）/ webhook（路径即凭证，404 fail-closed） |
| R7 Agent 组织化 | **已实现** | orgRole/rank/managerId（自指/成环/悬空全拒）+ heartbeatIntervalMinutes；组织页人+Agent 双层视图 |
| R10 预算深化 | **已实现** | 主体预算 agent:/app:；metrics-report 自动入账；超额联动冻结 + L4 解冻审批闭环 |
| R3 '*' 通配 | **已实现** | enforceBudget/budgetUsedCents 通配；selftest invoke 熔断实证 |
| R4 删除面 | **已实现** | DELETE 角色（护栏：内置/挂载拒）/用户（仅已注销）/预算 三路由 |
| R11 多公司收口 | **已实现** | agents/apps/orgs/approvals 四清单子树收敛；审批单 orgId 自动推导；越界 ?org= 403 |
| R12 自审批复议 | **已落地** | agent.online 恢复职责分离（自审 400），其余类型维持放开 |
| R2-B 模型目录管理面 | **已实现** | #/finops 模型目录卡（登记/上下线/删除+渠道组+预算含主体/冻结）；modelgw.read→resource_admin |
| G3 制造业种子 | **已实现** | DEMO_SEED 下目标/项目/任务/例行/心跳示例（幂等，空库才落） |

不适用项：R1（Cloudflare 控制台操作，代码层不可达——源站 308 兜底已上线）、R5/R6（流程/GUI 复测制度项）。

## 二、执行中枢（plugin-exec-hub）设计要点

- **决策与 CAS 分层**（Paperclip 移植核心）：`domain.ts` 纯函数（decideWakeAdmission 三态 /
  decideReleaseRecovery / cronMatches / computeAgentHealth / 上下文装配），无 IO 无时钟，
  `policy.test.mjs` 64 组合穷举 +12 项边界；CAS 护栏只在同步段检查-置位（Node 单线程原子）。
- **治理前置链**（唤醒派发顺序）：预算前置（modelgw 主体预算，超限不唤醒）→ 冻结检查 →
  Agent 机器主体权限（须持 exec.write，fail-closed）→ P0 审批门禁（exec.issue.run 自动挂单，
  ApprovalDecided 事件放行）→ 三态裁决取锁。
- **治理红线**：run 只登记「已派发 + 上下文包」，执行由 Agent 经 exec_claim/exec_complete 回执；
  无回执由僵尸锁回收闭环——平台永不虚构执行。
- **配置**：`EXEC_HUB_TICK_MS`（30s）/`EXEC_HUB_FIRST_TICK_MS`/`EXEC_HUB_BATCH`（50）/
  `EXEC_LOCK_TIMEOUT_MS`（5min）/`EXEC_HUB_OFF`（停调度）。
- **事件**：exec.goal/issue/wake/run/lock/heartbeat/routine.changed + agent.frozen/unfrozen
  （已入 PlatformEvents 与保留前缀）；通知中心订阅 run 收尾/僵尸回收/冻结三条。

## 三、验收证据

- **selftest 新增 47 断言**（「执行中枢」分节）：目标树成环拒绝/血缘物化三段/assign 自动入队/
  tick 派发/CAS 取锁/二唤延迟队列（deferred_issue_execution）/幂等键小时桶去重/done 收尾释放锁/
  P0 门禁挂单→异人审批→放行派发全闭环/webhook 200+404 fail-closed/cron 词法拒绝/僵尸锁 timeout-run
  回收/lineage 视图/健康度枚举/R10 冻结→L4→解冻→复派全闭环/预算拒绝审计留痕/R3 通配 invoke 熔断+
  删除后恢复/R4 三删除面/R11 收敛+越界 403/实体清理。
- **R12 双向**：提交人自审 agent.online 400（职责分离文案）+ 异人审批 executed → Agent 真上线。
- **线上形态冒烟**：DEMO_SEED 实例 16 步 API 全链验证（登录→目标→项目→任务→唤醒→tick→锁→
  二唤延迟→done 释放→血缘→总览→webhook 触发/404）；治理定向 24 步（R4/R7/R10/R11/R12）全过。

## 四、已知边界与后续建议

1. **coalesce 合并路径**：同 Agent 连续唤醒合并已实现（decideWakeAdmission），但平台暂无
   「run 内追加上下文」的消费端语义（Agent 拉取时看到 issueIds 聚合），合并价值待真实运行时接入后显现。
2. **metrics-report 计量**：同日多次提报只计首次快照（幂等键防重，价格簿自动播种 0 成本规则）；
   若需「合并后总量」口径，需价格簿支持增量事件（当前 insertOrIgnore 语义优先防重）。
3. **R11 skills/market 清单**：Skill 实体无 orgId 字段（全局目录语义），本轮未纳入收敛——
   若后续 Skill 分租户，需先补 schema。
4. **心跳驱动委派**：唤醒上下文已含汇报线注记（orgRole/managerId），「委派沿汇报线下达」的
   自动路由（managerId 目标转派）留待真实 Agent 运行时联调后定语义。
5. **R2-A 生产登记**：模型目录管理面已就绪，生产模型登记仍待 super_admin 按本报告 runbook 执行
   （登记后 R2-C 复验清单生效）。
