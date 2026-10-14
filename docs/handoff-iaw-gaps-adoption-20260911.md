# 采纳回执：IAW 缺口交接清单 → main（2026-09-11 批次）

> 回执对象：`D:\DSH-RQ\docs\handoff-iaw-gaps-to-main.md`（定制轨 → main，2026-09-11）
> 结论：**19/20 项本批次落地**（含一项「数据就绪」），1 项（7-2）契约挂靠完成、实现面诚实缺席。
> 详细端点/权限/事件登记见 `docs/release-notes-2026-09-11-iaw-batch.md`；结构变更契约冻结三份：
> `contract-c1-modelgw-channel-governance.md` / `contract-c2-flow-tf.md` / `contract-c3-agent-a2a.md`。

## 一、定制侧接线指引（面板占位 → 真实绑定）

| 面板视图（交接清单 §0 五空间） | 缺席占位可替换为 | 最小接口 |
|---|---|---|
| 执行空间 · 事务流条/事务流工作台深水区 | flow-core TF 列表/详情/步骤推进 | `GET/POST /api/flow/flows*`（3-1..3-3） |
| 执行空间 · 场景详情抽屉「事务流」Tab | 模板库按场景 | `GET /api/flow/templates?sceneCode=`（3-2） |
| 数据空间 · 数据清单/缺口清单 | 数据集登记聚合（按场景） | `GET /api/resource/datasets?scene=`（2-1） |
| 数据空间 · 质量看板入口 | 质量分四维 | `quality` 子对象 + `PUT …/:code/quality`（2-2） |
| 数据空间 · 血缘入口 | 反向追溯 | `GET /api/resource/lineage?dataset=`（2-3） |
| 数据空间 · 指标字典 | 口径冲突留账与仲裁 | `GET/PUT /api/resource/metrics/:code/definitions`（2-4） |
| 度量驾驶舱 · 渠道表缺列 | 可用率/时延/TPS/采纳率 | `GET /api/modelgw/:slug/telemetry?window=7d` + `GET /api/usage/feedback-stats`（1-3/4-2） |
| 顶栏 cost chip（WAIC 口径历史值） | 今日/本月真实成本 + 预算进度 | `GET /api/usage/summary?window=today|month`（4-1/1-4） |
| 模型选择器（涉密锁死） | 分级过滤 + 锁死原因文案 | `POST /api/modelgw/models`（dataClassLimit）+ 契约 c1 错误文案（1-1） |
| 模型渠道中心 · 降级提示条 | SSE 消费 `modelgw.degraded` | 渠道组调用 `POST /api/modelgw/channel-groups/:slug/invoke`（1-2） |
| 概览 Tab「最近动态」/证据抽屉 | 场景审计时间线 + 证据锚点 | `GET /api/audit/timeline?sceneCode=` + `POST/GET /api/audit/evidence`（5-1/5-2） |
| 成员页场景授权提示 | 场景策略自查（选择器锁死） | `POST /api/iam/scene-authz/check`（6-1） |
| 数字同事卡自治级别展示位 | autonomy/runtime 字段 | Agent attrs（7-1）+ `POST /api/agents/:id/a2a/invoke` |
| 通知中心跨会话漫游 | since 增量 + 已读游标 | `GET /api/notifications?since=` + `POST /api/notifications/read-cursor`（8-1） |

SSE 通道：面板 `GET /api/panel/stream` 现扇出 `flow.created / flow.step.updated / flow.completed`（3-1 交接语义「复用 SSE」）。

## 二、诚实缺席声明（main 侧不做假实现的部分）

1. **7-2 会话内执行计划卡**：plan 步骤协议挂靠 `flow.step.updated` 结构已就位，但 Agent 流式通道（当前 modelgw 非流式单轮）缺席——多步计划卡待流式通道落地后按契约 c2 升版补齐；
2. **1-3 TTFT**：非流式单轮测不了首 token 时延，`ttftMs` 恒 null 并随响应 `note` 声明口径；
3. **1-2 内容安全拦截**：外部内容安全网关未接入，降级触发条件当前=超时/5xx/网络错误（契约 c1 声明）；
4. **5-1 usage 事件侧证据字段**：usage_events 为 SQL 事务表且 schema v1 冻结（ensureTable 无加列迁移），证据锚点落 audit 域、usage 以 `trace_id` 关联；usage schema v2 升版时另议；
5. **7-1 A2A 完整协商**：v1 只做单向点名 + 自治级别透出，跨运行时发现/双向协商升版另议（契约 c3）。

## 三、main 侧验收口径（本批次）

- `npm run selftest`：**1067/1067** 全绿（fresh 隔离实例，IAW 批次净增 70 项断言，含 RBAC 越权探针矩阵自动覆盖全部新端点）；
- `npm run lint:manifests`：**90/90**（flow-core 四件套已入 gen-manifests 并重生成）；
- 装配：flow-core 已入 `src/boot-all.ts` + `cordis.yml` + `cordis.patch.yml`（console 之后、dingtalk-bridge 之前）；
- 双目标部署：按 `D:\DSH-07\daily-sync-deploy.py` 例行双发（测试环境自动重启+健康检查；正式环境只传文件不自动重启）。

—— main 轨 ybkkasi · 2026-09-11 · IAW 缺口批次
