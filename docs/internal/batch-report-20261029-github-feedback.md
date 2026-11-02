# 批次汇总 · GitHub 用户反馈闭环 + 主题与首页体验（2026-10-29）

> 本报告性质：内部过程物料（不构成对外契约）。对外节点以 `CHANGELOG.md` 对应 [Unreleased] 节为准。
> 覆盖范围：2026-10-29 全部提交（`d7e0b7f` → `ce4ca6a`），共五个批次。
> 门禁证据：selftest **1660/1660 全绿**（2026-10-29 实测，含 #17 批次新增 3 断言）。

---

## 0. 一页总览

| 批次 | 内容 | 来源 | 落地提交 | 状态 |
|---|---|---|---|---|
| GitHub 反馈批次一 | #7 心跳与写权限解耦 / #8 Agent 模型目录单一事实源 / #9 connect executor 接入模板 / #10 `ctx.effect` 定时器误用全仓修复 | issues #7–#10 | `2e9ce71` | ✅ 修复关闭 |
| GitHub 反馈批次二 | #16 exec 域 orgId 血缘收口 / #15 OIDC issuer 按请求派生 / #14 成本归集双米计价 + not_priced 语义 / #13 `/api/health` 面板契约 | issues #13–#16 | `c2a4f1e` | ✅ 修复关闭 |
| 控制台主题 | 四套可切换主题（经典原版 / 澄明经营总览 / 星图协作关系 / 夜航治理观察），D3 + Cytoscape 本地分发 | PR #11 | `ac0d6c2`（+`6aa2022` CI 修复） | ✅ 合并 |
| 首页与 CLI | README 重写、`--dry-run` fail-closed、发布包补齐（Skill / CLI / llms.txt）、部署文档纠错 | PR #12 | `d7e0b7f` + `dcbc79f` | ✅ 合并 |
| 协作主通道 | #17 面板三处模型调用组织兜底链 + modelgw `invokeTracked` 计量 fail-fast | issue #17 | `ce4ca6a` | ✅ 修复关闭 |

**反馈闭环状态（2026-10-29 巡检）**：open issues = 0，open PRs = 0；#4–#17 全部 CLOSED，
均随对应批次直接修复并附 selftest 断言。

## 1. 各批次要点

### 1.1 GitHub 反馈批次一（issues #7 / #8 / #9 / #10，`2e9ce71`）

- **#7 心跳与写权限解耦**：routine heartbeat wake 不再要求 `exec.write`，只读 Agent 不再
  每次心跳都吃 `ADMISSION_DENIED`、永远到不了 todo 拉取。
- **#8 模型目录单一事实源**：Agent 模型枚举不再手写（deepseek 三元枚举与目录漂移，6 模型仅
  1 个可分配）；PATCH 改为校验目录内 slug，目录更新即生效。
- **#9 connect executor 模板**：operator enroll-code 模板补 `exec.write`，远程 dsh/Agent
  可领取 exec 任务（此前只能 list 不能 claim）。
- **#10 定时器全仓根修**：exec-hub heartbeat/tick 的 `setInterval` 被 `ctx.effect` 误清——
  重启后不再有例行唤醒。该形态在 a2a / authn / nas / usage / workforce 等 9 处同构使用点
  一并修复，`timer-permission.test.mjs` 定时器生命周期回归防复发。

### 1.2 GitHub 反馈批次二（issues #13 / #14 / #15 / #16，`c2a4f1e`）

- **#16 exec 域组织血缘**：goals/projects/issues 空串 orgId 一律 400，缺省按继承链自动归属
  （调用主体 → 血缘 → 平台根组织），存量空归属记录启动时幂等迁移归根组织并留审计；
  `/api/exec/*` 增加 `?orgId=` 过滤支撑组织范围看板/成本/配额。
- **#15 OIDC issuer 按请求派生**：discovery issuer 不再硬编码环回地址——`OIDC_ISSUER` 显式
  声明 → 转发头派生（与 console requestOrigin 同口径）→ 环回回落；公网域名反代远程 SSO
  开箱可用，verifyJwt `acceptedIssuers` 同请求面自洽。
- **#14 成本归集**：模型目录新增输入费率（分/千 tokens），modelgw 双米组合计价
  （`costLineItems` additive-only），「费率未配 ≠ 零成本」以 `cost_status=not_priced`
  fail-closed 表达，summary / 预算护栏 / audit 成本报表同步暴露覆盖率；修复管理端保存
  路由把未填费率静默清零的缺陷。
- **#13 面板契约**：`/api/health` 暴露面板契约版本，补跨仓契约校验口径，前端/宿主漂移不再
  静默失败。

### 1.3 控制台四套可切换主题（PR #11，`ac0d6c2`）

- 四套主题驾驶舱内单击切换、其余页面顶栏切换，选择存浏览器本地，独立于平台身份主题；
  原有五个工作台视图、路由与演示只读限制不受影响。
- 星图主题按需加载本地分发的 D3 / Cytoscape（真实关联图 ≤60 节点，拖拽/缩放/降级齐备），
  不引前端构建、不走第三方 CDN；依赖附许可文件随包分发。
- 自带前端单测（theme / theme-integration / timer-permission）与合并冲突口径
  （修复块一律以 main 已落地版本为准，仅保留主题与测试增量）。

### 1.4 首页与 CLI 预演安全（PR #12，`d7e0b7f` / `dcbc79f`）

- README 重写：突出数字员工协作、可信治理、真实界面与最短接入路径，移除重复介绍、过期
  数字与历史过程叙述；Agent 索引同步精简。
- CLI `--dry-run` 改 fail-closed：不支持预演的写请求直接拒绝而非静默放行；本地脚手架创建
  与删除确认同步保护；`cli/tests/dry-run.test.mjs` 覆盖。
- 发布包补齐：九份运维 Skill 加可发现元信息，CLI 与 llms.txt 纳入 npm `files`；部署文档
  修正 dsh 挂载路径与多进程共享数据目录的错误说明。

### 1.5 协作主通道组织兜底与计量 fail-fast（issue #17，`ce4ca6a`）

- 面板三处模型调用（频道点名 / 工具面 askAgent / 技能直调）组织兜底链：调用方用户组织 →
  部门绑定组织（R11）→ 平台根组织，`orgSource` 随审计留痕——机器主体 / 外部工具通道无
  用户归属时不再拿空串打到计量校验上。
- modelgw `invokeTracked` 入口先校验 `orgId`：空串在调用上游**之前**拒绝，杜绝「模型已
  应答、token 已消耗，计量落账才抛 usage org 必填」的先花钱后报错（该形态同时导致该次
  成本未入账，污染 #14 的成本口径）。
- selftest 新增 3 断言：modelgw 空 org 拒绝、机器主体点名 Agent 成功、panel:* 计量入账
  （1657 → 1660）。

## 2. 验证与遗留

- `node scripts/selftest.mjs`：**1660/1660 全绿**（2026-10-29 实测）。
- 对外文档无硬编码断言数；CHANGELOG 内历史批次记录的当时实测值（如 1657/1657）保持原样。
- 遗留：无本批次已知未结项。后续若 #14 计价目录扩容（更多模型费率补录），FinOps 页即可
  逐步把 `not_priced` 事件清零——运营动作，非代码缺陷。
