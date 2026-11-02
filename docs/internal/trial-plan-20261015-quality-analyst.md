# 试岗方案：金华工厂质量分析员（数字员工单部门试岗 · 2026-10-15）

- 编制：QA/交付组（W7/T08 灰度交付包，决策 D-② 组织级灰度）
- 蓝本：《数字员工与平台资源调用-技术关联与施工实施路径-20261015》§16（docs/ 副本 L810-845）
- 灰度契约：`packages/plugin-workforce/src/contract.ts` 的 `WorkforceGrayConfig { grayMode?: 'off'|'allowlist', enabledOrgs?: string[] }`（冻结版 V1.0 · 2026-10-15）
- 配套证据：`tests/workforce-runtime-drill.mjs`（真实宿主七场景，34 断言全绿）、`tests/workforce-rollback-drill.mjs`（装配回退/SQLite 增量兼容/灰度期语义，19 断言全绿）

---

## 1. 试岗岗位与边界

### 1.1 岗位

金华工厂质量分析员（数字员工 `jh-quality-analyst`）：分析指定批次（如 Q-1024）检验异常，输出可复核根因假设与纠正建议，由真人质量工程师验收。

### 1.2 边界（白名单式，逐项可断言）

| 维度 | 允许 | 禁止（越界即拒绝并可观测） |
|---|---|---|
| QMS 数据 | 指定工厂（factoryIds=['JH-01']）批次检验数据只读（MCP `qms_batch_read`） | 跨工厂读取（ARGUMENT_SCOPE_DENIED）、任何写/放行动作 |
| SOP 文件 | 指定目录前缀（pathPrefixes=['/quality']）只读 | 删除/改名/外发；路径越界拒绝 |
| 技能 | 固定发布版本的根因分析 Skill（manifest skillPins 锁版本+内容摘要） | 未上架/未固定版本的技能 |
| 模型 | 白名单模型（dataClassLimit=internal，maxTokens 约束） | 绝密级数据进模型（任用 dataClass 禁绝密） |
| 交付 | 受控 artifact 上传 + submit（技术完成=待审 review） | **质量放行**（验收决定权只在真人 `workforce.accept`）；只提交摘要无证据被拒（ARTIFACT_SCOPE_DENIED） |
| 标准 | 只读 | 修改检验标准（无对应授权句柄 → TOOL_NOT_GRANTED，即使猜到工具名也拒绝，V28） |
| 外发 | 无 | 无外发句柄即结构性不可达 |

## 2. 首条链七步 → 平台端点映射（§16.2）

| 步骤 | 数字员工/运行时 | 平台端点（本批次实测形态） | 关键证据 |
|---|---|---|---|
| 1 拉取并认领 | 带机器令牌（refType=agent）拉取待办并认领 | `GET /api/workforce/work-items` → `POST /api/workforce/claims` | employee/issue/run/lease/permit（幂等重放 idempotent=true） |
| 2 读取检验数据 | 请求本批次数据 | `POST /api/workforce/invocations`（toolHandle=`<mcp服务ID>.qms_batch_read`，stepKey+参数摘要） | invocation 记录 + 网关 MCP call + `mcp:<slug>` usage 事件 |
| 3 加载根因分析技能 | 固定版 Skill | 任用 grants 登记 skill（capability manifest skillPins 固定版本与摘要） | manifest 与 Skill 版本 |
| 4 查询并读取 SOP | 读指定目录 | `POST /api/workforce/invocations`（nas 句柄，pathPrefixes 约束） | NAS 操作 + 文档引用 |
| 5 模型形成草案 | 调用允许的模型 | `POST /api/workforce/invocations`（model 句柄） | 模型 usage（tokens/密级）+ 工作 trace |
| 6 上传报告并提交 | 受控交付 | `POST /api/workforce/artifacts` → `POST /api/workforce/deliverables` | artifact（sha256/staging）+ deliverable；任务→review |
| 7 验收或退回 | 等待真人 | `POST /api/workforce/acceptances`（decision=accepted/rejected） | acceptance 决定；accepted→done / rejected→回执行且调用事实保留 |

试岗前自检：以上端点链已被 `tests/workforce-runtime-drill.mjs` 在真实宿主全绿复现（R01-R25）。

## 3. 试验数据与生产分离（硬要求）

1. **独立 data 目录**：试岗实例以 `node src/main.ts --port 7330 --data <独立目录>` 启动（端口与目录均不与生产共用；演练纪律同 selftest：绝不指向仓库默认 `data/`）。
2. **独立组织 orgId**：试岗任务全部归属独立组织（如 `金华工厂-试岗`，由 `POST /api/iam/orgs` 创建），员工档案、任用、run、usage 归口全部锚定该 orgId；成本看板/审计按组织过滤即得试岗视图，与生产消费事实零交集。
3. **独立上游资产**：试岗 MCP/SOP/模型使用测试端点与测试批次（Q-xxxx 试岗批号段），权限组 subject 只挂试岗 Agent。
4. **清理口径**：试岗结束直接归档该 data 目录（SQLite `txnstore.db` + 集合 JSON），生产侧无残留。

## 4. 灰度开关操作手册（D-② 组织级）

### 4.1 配置形态契约（cordis.yml）

> 说明：以下为**配置形态契约**（cordis 条目 config 块承载 `WorkforceGrayConfig`）。
> **落地形态以本批次 `contract.ts` 为准**：`WorkforceConfig extends WorkforceGrayConfig`，
> index.ts 装配时把 config 传入 `AdmissionService(ctx, config)` 与策略端口 `createWorkforcePolicyPort(ctx, config)`。

```yaml
# cordis.yml（宿主形态）/ cordis.patch.yml（bundle 形态）中 ops-workforce 条目：
    - id: ops-workforce
      name: dsh-enterprise-ops/packages/plugin-workforce/src/index.ts
      config:
        # 灰度开关（W7/D-② 组织级）：
        #   off（默认）= 全组织开放，等价一期行为；
        #   allowlist = 仅 enabledOrgs 内组织可走工作路径（认领/续租/受控调用），
        #               名单外一律 WORKFORCE_DISABLED 显式拒绝（不静默回落 legacy），
        #               并发 workforce.gray.denied 事件（surface=port/admission，可观测可落账）。
        grayMode: allowlist
        enabledOrgs:
          - <金华工厂-试岗 orgId>     # 先只放行试岗组织
```

### 4.2 操作序列（试岗放行 / 收紧 / 全量）

1. **试岗前（灰度开）**：试岗组织建好后把其 orgId 写入 `enabledOrgs`，重启（或按宿主热载机制生效）。
2. **试岗中扩面**：向 `enabledOrgs` 追加新 orgId——新增组织即刻可认领，已有组织不受影响。
3. **紧急收紧**：从 `enabledOrgs` 移除 orgId（或整体 `grayMode: off` 回全量/`allowlist`+空名单=全域关闭）——
   关闭组织的**新认领/续租即刻被拒**（认领在确认前拒绝、续租对既有 permit 同样拒绝）；在途已签发 permit 的
   单步调用按 port 侧口径同样拒绝（灰度判定先于 permit 校验）。
4. **观测**：`workforce.gray.denied` 事件（bus journal 持久化，重启可回放）；拒绝不留 run/permit/租约半开状态。
5. **语义矩阵（三分支口径一致）**：

| 入口 | 名单内 | 名单外 | 查询面 |
|---|---|---|---|
| port.authorizeWorkAction（受控调用/网关工作闸门） | 放行（后续清单/风险交集照旧） | `WORKFORCE_DISABLED` + 事件（surface=port） | 不拦 |
| admission.claimWork / renewWorkLease（认领/续租） | 放行 | `WORKFORCE_DISABLED`（403 WorkforceError）+ 事件（surface=admission） | 不拦（work-items 拉取、状态查询开放） |
| routes.ts（REST 面） | 透传服务层结果 | 不另设拦截——服务层拒绝经统一错误出口透传（工作写路径 403/400 语义由服务层决定） | 开放 |

## 5. 真人验收记录表模板（每任务一行，验收人签字落审计）

| 字段 | 记录 |
|---|---|
| 任务/批次 | （issueId / 批次号 Q-____） |
| 数字员工 | （employeeId / displayName） |
| 证据链 | runId、permitId、invocation 数（completed/denied 分列）、artifactIds、deliverableId+version |
| 交付摘要 | （数字员工自述摘要，人工核对与 artifact 一致性） |
| 验收决定 | accepted / rejected（`POST /api/workforce/acceptances`，decidedBy 自动落审计） |
| 决定理由 | （退回时须给出可执行修改意见；rejected 后任务回 in_progress、调用事实保留） |
| 例外与越界 | （试岗期间任何 ARGUMENT_SCOPE_DENIED / TOOL_NOT_GRANTED / 灰度 denied 事件摘录） |
| 验收人/时间 | （真人 userId + ISO 时间；验收权=workforce.accept，不接受员工自验收） |

## 6. 回滚预案

按风险从低到高三级，均已在 `tests/workforce-rollback-drill.mjs` 演练（19 断言全绿，可重复执行）：

1. **灰度收紧（业务级，首选）**：按 §4.2 序列 3 收紧名单——不卸载、不动数据，秒级生效语义（新工作路径拒绝），在途数据无损。演练三（G01-G10）验证关闭语义与可观测。
2. **宿主重启/增量兼容（运维级）**：`ensureTable` 幂等（迁移不重建表、不丢数据）。演练二（W07-W08）验证同 data 目录二次启动数据读回一致、行数不翻倍。
3. **装配回退（极端）**：从 `src/boot-all.ts` 删 import+mount 行、`cordis.yml`/`cordis.patch.yml` 删 `ops-workforce` 条目块并重启——宿主正常起、`/api/workforce/*` 404（无工作面）、**残留 `workforce_*` 表无害**（数据保留可读，重新装配后原样续用）。演练一（W01-W06、W09）以 git worktree 检出副本完成摘除演练，仓库工作区零污染。

## 7. 人工联调核对单（V14 / V17 / V18）

> 用法：每项在试岗环境实际触发一次，核对「操作 → 平台行为 → 证据」三栏后签字。编号沿用蓝本 §15.1。

### V14 无人值守不冒充真人（NAS 身份头）

- 操作：①无人值守场景让员工调 NAS 只读（不携带 onBehalfUser）；②携带 `onBehalfUser=<主管userId>` 但工作上下文无真人发起（requesterUserId 缺失/不一致）。
- 核对（机制：`adapters/nas.ts` actorFor——仅当 `work.requesterUserId` 存在且与 args.onBehalfUser 一致才透传真人链）：
  - 两场景网关侧 actor 均为 `agent:<agentId>`（`数字员工:<employeeId>`），**不带真人身份头**；
  - 试图伪造 `onBehalfUser=主管` 被忽略（onBehalf=false）。
- 证据：NAS 网关调用记录 actor 字段 + invocation `gatewayRefJson`。

### V17 普通优先级含高风险写入（按动作风险审批/拒绝，不靠非 P0 绕过）

- 操作：①员工对**句柄仅授 read** 的 MCP 工具发起事实为写/admin 的动作 → 核对 `ARGUMENT_SCOPE_DENIED`（风险交集拒绝）；②对**未登记生效风险**的写句柄发起调用 → 核对 `RISK_UNREGISTERED`（写能力必须先经风险登记审批）；③连接器等审批型动作触发 `approval_required` → 核对 invocation 落账 `approval_required` 状态且审批单引用（approvalRef）可在审批台展示，审批前不得继续执行。
- 核对：三路径均为**按动作风险**判定，与任务优先级（P0/普通）无关——普通优先级不构成绕过；denied/approval_required 全部落 `workforce_invocations` 账本（§9.3）。
- 证据：invocation 记录（status/errorCode）+ 网关调用记录（code=ARGUMENT_SCOPE_DENIED/RISK_UNREGISTERED）+ 审批单截图/ID。

### V18 审批后参数或任用版本改变（重评）

- 操作：员工在 v1 任用下已认领（permit 绑定 v1 版本与审批引用 approvalRef）→ 主管升版：`POST /api/workforce/appointments`（v2 新授权范围）→ `activate` → **显式撤销 v1**（`POST /api/workforce/appointments/:id/revoke`）。
- 核对：
  - v1 撤销 → 该任用全部 permit `revoked`（workforce.permit.revoked 事件）；
  - 持旧 permit（旧审批引用）再发起调用 → `verifyPermit` fail-closed 拒绝（TOOL_NOT_GRANTED：「不存在或已失效」），**旧审批不放行新动作**；
  - 新工作必须以 v2 重新认领（新 permit 绑定 v2 版本），审批重评落在新版本边界上。
- 诚实登记：V18 的「参数级重评」（同版本内改参数触发审批重评）依赖审批引用与参数摘要的细粒度绑定，**本批次以版本级重评闭环**（版本变更→旧 permit 撤销→旧审批引用不放行）；同 run 内参数变化已有步骤冲突防御（STEP_ARGUMENT_CONFLICT，不覆盖原动作）。参数级细粒度重评列入后续批次（P2，反馈驱动）。
- 证据：任用版本记录（v1 revoked/v2 effective）+ permit 状态 + 旧 permit 调用拒绝记录 + 新认领 permit 的 appointmentVersion=2。

## 8. 试岗准入检查单（开工前逐项打勾）

- [ ] 独立 data 目录与端口（§3），未指向生产 `data/`
- [ ] 试岗组织已建且 orgId 已入 `enabledOrgs`（§4.1），其余组织未放行
- [ ] `tests/workforce-runtime-drill.mjs` 在试岗宿主版本上全绿（基线 SHA 记录）
- [ ] `tests/workforce-rollback-drill.mjs` 全绿（回滚预案可执行性）
- [ ] `npm run lint:manifests` / `npm run lint:boot-order` 绿
- [ ] 验收记录表模板已分发到质量工程师（workforce.accept 权限持有人）
- [ ] V14/V17/V18 核对单责任人与触发用例就绪
