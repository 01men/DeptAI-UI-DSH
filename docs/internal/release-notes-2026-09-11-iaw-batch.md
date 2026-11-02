# 发布说明 · 2026-09-11 · IAW 缺口批次（交接清单落地）

> 对照 `docs/handoff-iaw-gaps-to-main.md`（定制轨 custom/dsh-rq → main，2026-09-11）。
> 本批次 main 侧一次落地 **19/20 项**（7-2 契约就位、实现面诚实缺席，见第四节）。
> 验收：`npm run selftest` **1067/1067 全绿**（自测 997 → 1067，IAW 批次净增 70 项断言）+ `npm run lint:manifests` **90/90**。

## 一、契约变更登记（红线 1）

| 契约 | 冻结稿 | 覆盖交接项 |
|---|---|---|
| 模型渠道治理面 | `docs/contract-c1-modelgw-channel-governance.md` | 1-1 渠道分级路由 / 1-2 降级链 / 1-3 渠道遥测 / 1-4 预算熔断 |
| 事务流引擎 | `docs/contract-c2-flow-tf.md` | 3-1 TF 编排 / 3-2 模板库 / 3-3 SLA·progress / 3-4 甘特数据源 |
| Agent 自治与 A2A | `docs/contract-c3-agent-a2a.md` | 7-1 autonomy/runtime + A2A 点名调用 |

**记录结构变更（红线 2，均已冻结 v1）**：`ModelRecord.dataClassLimit`、TF 记录（slaMinutes/dueAt/progress）、Agent attrs `autonomy`/`runtime`。

## 二、新增端点与工具

### 模型网关（owner: modelgw）
| 端点 | 权限点 |
|---|---|
| `GET /api/modelgw/channel-groups` · `GET /api/modelgw/budgets` · `GET /api/modelgw/:slug/telemetry?window=` | `panel.read` |
| `PUT /api/modelgw/channel-groups` · `PUT /api/modelgw/budgets` | `panel.config.write` |
| `POST /api/modelgw/channel-groups/:slug/invoke`（降级链调用） | `panel.write` |
| `POST /api/modelgw/models`（增 `dataClassLimit`）· `POST /api/modelgw/invoke`（增 `dataClass`） | 原权限点不变 |

### 数据要素（owner: resource-core）
| 端点 | 权限点 |
|---|---|
| `GET /api/resource/datasets?scene=&classification=&org=&q=` · `GET /api/resource/lineage?dataset=` · `GET /api/resource/metrics/:code/definitions` | `panel.read` |
| `PUT /api/resource/datasets` · `PUT /api/resource/datasets/:code/quality` · `PUT /api/resource/lineage` · `PUT /api/resource/metrics/:code/definitions` · `POST /api/resource/metrics/:code/arbitrate` | `resource.dataset.write`（新增权限点） |

### 事务流（宿主新域：`packages/plugin-flow-core/`，owner: flow）
`/api/flow/templates`（读 `flow.read`/写 `flow.admin`）、`/api/flow/flows`（读 `flow.read`/写与流转 `flow.write`）。新增权限点 `flow.read` / `flow.write` / `flow.admin`。

### usage / audit / iam / agent / 通知
| 端点 | 权限点 |
|---|---|
| `GET /api/usage/summary?window=today|month&org=&subject=`（IAW 4-1；响应含 `budget` 预算进度） | `panel.read`（非 usage.read 主体强制收敛自身组织，fail-closed） |
| `GET /api/usage/feedback-stats?days=7|30|90|all`（IAW 4-2 采纳率聚合） | `panel.read`（同上分层） |
| `POST /api/audit/evidence` · `GET /api/audit/evidence/:id`（IAW 5-1 证据锚点） | `panel.write` / `panel.read` |
| `GET /api/audit/timeline?sceneCode=`（IAW 5-2 场景审计时间线） | `panel.read` |
| `GET /api/iam/scene-policies` · `PUT /api/iam/scene-policies` · `DELETE /api/iam/scene-policies/:id`（IAW 6-1） | `iam.org.read` / `iam.scene.write`（新增权限点） |
| `POST /api/iam/scene-authz/check`（`iam.check(scene,action)` 自查面） | `panel.read` |
| `POST /api/agents/:idOrSlug/a2a/invoke`（IAW 7-1） | `agent.a2a.invoke`（新增权限点） |
| `GET /api/notifications?since=&limit=` · `POST /api/notifications/read-cursor`（IAW 8-1） | `console.login` |

## 三、平台事件增补（platformBus，保留命名空间同步扩 `modelgw. / flow. / resource.`）

`modelgw.degraded`（1-2 降级提示条）、`modelgw.budget.warning`（1-4 阈值告警）、`flow.created / flow.step.updated / flow.completed / flow.template.changed`（3-1，面板 SSE 扇出已接入）、`iam.scene_policy.changed`（6-1）、`resource.dataset.changed / resource.metric.changed`（2-x）、`agent.a2a.invoked`（7-1）。

面板 SSE（`GET /api/panel/stream`）已把 `flow.*` 三事件纳入 wireEventBus 扇出——面板事务流视图可直接消费。

## 四、逐项回执（对照交接清单）

| 项 | 状态 | 回执 |
|---|---|---|
| 1-1 渠道分级路由 | ✅ 落地 | `dataClassLimit` + `dataClass` 越级锁死（错误文案含原因）；降级链逐步校验（降级不降密级） |
| 1-2 降级链 | ✅ 落地 | 渠道组 主/备1/备2/人工；步超时缺省 8s；每次降级 `modelgw.degraded`（SSE 可消费）；内容安全拦截钩子诚实缺位（契约 c1 声明） |
| 1-3 渠道遥测 | ✅ 落地 | 7d 可用率/p50 时延/TPS 代理/采纳率；**TTFT 诚实缺列**（ttftMs=null+口径说明，待流式通道） |
| 1-4 预算熔断 | ✅ 落地 | org/模型/平台级预算；warn 阈值事件（每预算每日去重）+ block 调用前熔断；`usage/summary` 响应携带 `budget` 进度（cost chip 位） |
| 2-1 数据集登记 | ✅ 落地 | `GET /api/resource/datasets?scene=`（名称/来源/分级/质量分/刷新/sceneCount） |
| 2-2 质量分 | ✅ 落地 | 完整性/准确性/时效性/一致性四维 0-100 + 等权 overall |
| 2-3 血缘反向追溯 | ✅ 落地 | 复用依赖图（kind=lineage）；`lineage?dataset=` 返回 upstream/downstream |
| 2-4 指标字典 | ✅ 落地 | 同码多口径并存留账（记录人/时间）；同内容幂等；arbitrate 仲裁置 active |
| 3-1 TF 编排 | ✅ 落地 | flow-core 新域：TF CRUD + 步骤状态机（人/Agent/网关），事件入 bus + 面板 SSE |
| 3-2 模板库 | ✅ 落地 | `GET /api/flow/templates?sceneCode=` + 实例化复制推广 + contextPack 自动注入 |
| 3-3 SLA/进度 | ✅ 落地 | slaMinutes/dueAt/progress/slaBreached（读取时点判定口径已在契约声明） |
| 3-4 甘特 | ✅ 数据就绪 | 步骤 startedAt/finishedAt 齐备（3-4 交接语义：字段齐备后前端直接渲染） |
| 4-1 成本查询 | ✅ 落地 | `usage/summary`（今日/本月，tokens 三分，预算进度） |
| 4-2 采纳率聚合 | ✅ 落地 | `usage/feedback-stats`（up/down/资源分项/日趋势） |
| 5-1 证据锚点 | ✅ 落地 | audit 域 `evidence[]`（锚点五型）+ 证据登记/反查端点 + `AuditLogRecord.evidence/evidenceIds/sceneCode` additive。**口径说明**：usage 事件侧不加列——usage_events 为 SQL 事务表（ensureTable 无加列迁移），schema v1 冻结期以 `trace_id` 关联，升版随 schema v2 另议 |
| 5-2 审计时间线 | ✅ 落地 | `GET /api/audit/timeline?sceneCode=`（panel.read）；panel-core 任务创建/流转、Agent 直调、技能直调已带 sceneCode 落审计 |
| 6-1 场景级授权 | ✅ 落地 | 策略对象挂 sceneCode（deny 优先 → allow → fail-closed；未配置策略回落存量 RBAC/部门范围，行为不变）；version 乐观锁；`iam.check(scene,action)` 服务方法 + HTTP 自查面 |
| 7-1 A2A + 自治级别 | ✅ 落地 | autonomy(A0-A3)/runtime 字段 + `POST /api/agents/:id/a2a/invoke`（契约 c3 声明 v1 范围：单向点名+级别透出；协商协议升版另议） |
| 7-2 会话内执行计划卡 | ⏸ 契约就位、实现缺席 | 事件结构挂靠 `flow.step.updated` 已可承载步骤进度展示；**多步计划协议需 Agent 流式通道先行**（当前 modelgw 为非流式单轮），诚实缺席不造假。待流式通道落地后按 c2 升版补 plan 步骤结构 |
| 8-1 通知中心持久化 | ✅ 落地 | `console:notifications`（30 天保留 + 2000 条环形）+ since 增量 + 已读游标（跨设备漫游）；任务（组织范围）/告警（全局）/审批（全局）三类事件自动落账 |

## 五、定制侧对表（联动验收）

1. 面板把对应视图的「诚实缺席」占位替换为真实绑定时，按第二节端点表与三份契约文档对表；
2. 涉权限点：`flow.read/write/admin`、`resource.dataset.write`、`iam.scene.write`、`agent.a2a.invoke` 已进 PermissionCatalog + 内置角色 + 迁移表（存量库启动自动补点）；
3. RBAC 越权探针矩阵已覆盖全部新端点（member 可达面 = 面板/事务流/通知/数据要素读面）；
4. 回归门槛：`npm run selftest` 1067/1067 + `npm run lint:manifests` 90/90 + fresh-install 铁律（selftest 即隔离实例 fresh-install）。
