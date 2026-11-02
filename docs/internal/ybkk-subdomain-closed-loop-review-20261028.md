# ybkk.ybkkasi.com 方案落地自动化闭环 · 审查与修订（2026-10-28）

> 任务来源：以「ybkk.ybkkasi.com 方案落地的自动化闭环任务的审查与修订」为实测载荷，
> 验证平台两条能力主张：① Agent 本体心跳可被平台监测；② 编排任务可从
> ybkkasi.com「协作与执行」板块回看完整脉络。执行载体 `scripts/run-closed-loop-review.mjs`（幂等可重跑）。

## 一、审查结论

### 1. ybkk.ybkkasi.com 落地状态（两轮探活之间完成落地）

| 时点（本地） | 探活 | 事实 |
| --- | --- | --- |
| 14:11–14:36 | `502` | DNS 已解析（Cloudflare 代理边缘），但主隧道无该主机名绑定 → 网关 502 |
| 14:44 复核 | `200` | 已落地：内容为《AI 原生组织建设方案 V2.2（Gate01 OrgLoop）》静态页（95KB）；资产 `last-modified 05:25 GMT`，无平台安全头（CSP/X-Frame-Options 等），源站在 Cloudflare 侧静态托管，非本机端口 |

对照：主站 `ybkkasi.com` 200；`dsh.ybkkasi.com` 401（鉴权口，正常）；`demo.ybkkasi.com` 200。

### 2. 两条能力主张的实测判定

**① Agent 本体心跳：可以，平台已实际监测到。**
- 机制：exec-hub 30s tick 循环对「运行态 + 已配置 `heartbeatIntervalMinutes`」的 Agent 到期入队心跳唤醒，
  唤醒处理全程留痕 `exec:heartbeats`（滚动保留 7 天），健康度五档（healthy/stale/silent/frozen/offline）。
- 实测：为三官（执行官/评价官/验收官）配置 30 分钟心跳后，`/api/exec/overview.agentsHealth` 即刻返回
  三者 `healthy` + 最近心跳时点；唤醒队列出现 `trigger=routine / heartbeat:30m` 的真实心跳唤醒记录。
  唤醒只落 run + 待办上下文包 + 心跳留痕，不外呼 LLM，空转零 token 成本。
- 前提提醒：Agent 必须处于 online/trial 且配置了心跳间隔——生产此前 7 个 Agent 均未配置，心跳面为空是配置缺位，非能力缺失。

**② 编排任务脉络：可以，「协作与执行」两个板块各承一段。**
- 执行中枢（#/exec）：目标 → 项目 → 任务三级血缘（`/api/exec/lineage/:issueId`）+ 唤醒队列 + run 审计（含交回摘要）+ 心跳健康度，公网 API 已验证可读。
- A2A 协作 → 任务追踪：跨运行时协作任务八态状态机 + 详情抽屉（历史时间线/协商要约/交付物/人工验收）。
  实测发起 3 笔协作任务均正确落入 `auth_required`（A1×A1 协商矩阵要求人在环确认），
  时间线留痕完整，等待审批中心人工决策后才会派发执行——这是设计内的治理门，不是故障。

### 3. 顺带发现并修复的真 bug

`exec_claim`（执行中枢认领工具）在生产部署（装配 workforce 插件）下**必然抛错**
`cannot get property "workforceAdmission" without inject`：exec-hub 以 `(ctx as any).workforceAdmission`
直访未进自身 inject 列表的服务，cordis 严格注入的 get trap 硬拦。修复口径同 dsh-bridge `softRead`：
`ctx.reflect.get(key, false)` 软读 + 缺席降级。修复后 `exec_claim` 经 MCP /mcp 实测通过
（租约签发、幂等重认领、`exec_complete` 交回转待审全链 OK）。

## 二、闭环执行记录（生产库可查）

- 目标 `goal_mvrqraqaccqwfrqe` 数字员工自治闭环运行验证 → 项目 `proj_mvrqrar0ccqy4jes` ybkk.ybkkasi.com 方案落地
- 任务① `iss_mvrqrarnccr086yw`：首轮审查（发现 502 根因 + 修订建议 A/B/C），已验收归档 done
- 任务② `iss_mvrqzepcji3oxddj`：修复后重跑，exec_claim/exec_complete 全链通过，复核终论回写后验收归档 done
- A2A 任务 `task_mvrqzhomji3ygwa1` 等 3 笔：auth_required，待人工在「审批中心」决策
- 心跳：三官 `heartbeatIntervalMinutes=30`，健康度 healthy

## 三、修订建议（余项）

1. **可达性监测例行化**：把 ybkk.ybkkasi.com（及姊妹子域）探活纳入心跳/巡检闭环（脚本 ⑥ 步即模板）。
2. **安全头对齐**：方案静态页若需与主站一致的安全头口径，在 Cloudflare 托管侧补齐。
3. **A2A 待决审批**：3 笔 auth_required 任务请在控制台「审批中心」人工决策（通过→评价官复核执行；驳回→留痕归档）。
4. 修订边界：本次未擅自变更任何对外基础设施（隧道/DNS/托管），落地动作系维护者侧完成，本任务仅做审查、复核与记录。

## 四、复跑方式

```bash
node scripts/run-closed-loop-review.mjs [--platform http://127.0.0.1:7300] [--heartbeat-min 30] [--skip-a2a]
```

幂等：目标/项目按标题复用；未终态同题任务复用并走幂等认领；A2A 步骤可关。
