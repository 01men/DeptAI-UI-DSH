# 连接器纳管（open-connector 融合）开发进度板

> 依据：`docs/dev-plan-connector.md`（v1.0，2026-08-27；源件在 C:\Users\Administrator\Downloads\dev-plan-connector.md）
> 本文件 = 多 Agent 协作唯一的进度事实源。**任何 Agent 开工前必须读本文件，收工前必须回写本文件。**
> 状态只反映已验证完成的工作；**禁止把"计划要做"写成"已完成"**。

---

## 〇、CTO 审查意见（**开工前必读**；由 CTO 审查 Agent 维护，其他 Agent 勿改本节）

> 完整审查历史见 `CTO-REVIEW.md`（CTO 唯一写入点，append-only）。最近更新：2026-08-27 15:08。
>
> **【项目完成，已发布推送，审查终止 15:08】** 发布门禁全绿（老板 14:24 批准序列）：①本地提交 80ec600（39 文件 +5411/-16，工作树清零）→ ②selftest 终验 521/521、exit=0（CTO 亲跑，非采信板载）→ ③lint:manifests 70/70（CTO 亲跑）→ ④push `ac0698a..80ec600 main -> main` 至 github.com/01men/ybkkasi 成功。终审结论与上线意见见 CTO-REVIEW.md 末条。
>
> 遗留交接（不阻塞）：①M0 真实桥接联调按集成指南 §八 清单在生产环境执行，回填后 #1 转 done；②#12 市场化业务触发启动；③connector_latency 告警规则运营按需播种；④多实例部署时 oct_ 内存令牌缓存需改造（技术债）。

---

## 一、协作协议（必读）

1. **状态图例**：`todo` 未开始 → `claimed` 已认领（在 §四「当前占用」登记后必须尽快出现 journal 记录）→ `in-progress` → `done` / `blocked`（写明阻塞原因）/ `partial`（部分完成，注明缺口与下一步）。
2. **认领规则**：编辑共享文件前，先在 §四「当前占用」表加一行你的 Agent ID + 目标文件 + 时间戳；完成后把行删除并在 journal 记一笔。同一共享文件同时只允许一个占用者。
3. **journal 是 append-only**：每次会话结束（或每完成一个工作单）追加一段：时间戳、Agent ID、工作单号、改动摘要、涉及文件、遗留风险。不修改他人条目。
4. **冲突地图**：见 §三。新建包 `packages/plugin-connector/**` 内部可按子文件并发；跨包共享文件必须走认领。
5. **验证基线**：每完成一个工作单运行 `npm run lint:manifests`；#13 完成后起跑 `npm run selftest`。
6. **快照回滚**：里程碑级代码快照存 `D:\DSH-07\snapshots\`（tar.gz 排除 node_modules），命名 `pre-M1.tgz` / `post-M1.tgz` …

## 二、工作单状态总表

| # | 里程碑 | 内容 | 关键落点 | 依赖 | 状态 |
|---|---|---|---|---|---|
| 1 | M0 | 桥接验证 + 集成指南初稿（sidecar 部署 + POST /api/mcp/import 注册 external 服务 + docs/connector-integration.md） | console L1279-1293、plugin-mcp L350-407 | 无 | partial：集成指南 v0.2+compose 已交付 15:02（cto-doc-agent 按 #1 重构补全：M0 step-by-step/两拓扑 runbook/生产验证清单）；桥接 import/徽章/T-25(stub) 已实现；缺口：真实环境桥接联调（本机无 docker/sidecar 运行时），见 journal；2026-08-27 验收轮：lead-agent 克隆上游 tag v1.4.0 完成源码级契约实证（connection_not_allowed/action-policy 四数组/x-oo-connector-alias 头均命中 _upstream-oc 对应文件），生产部署执行仍待运维按 §八 清单勾选回填 |
| 2 | M1 | OcClient 全契约面 + connector:gateway 单例（env: 间接引用）+ 强制 env fail-closed + 探活定时器 | packages/plugin-connector/src/{client,index}.ts plugin.yaml package.json | 无 | done 2026-08-27 |
| 3 | M1 | 目录同步：catalog 缓存 + riskLevel 映射（默认 admin 兜底）+ resource 正则校验 + 变更检测钩子 | plugin-connector/src/index.ts catalog 段 | #2 | done 2026-08-27 |
| 4 | M1 | 连接管理：OAuth 代理/API Key 直达不落盘/脱敏/no_auth/org 前缀/删除级联/connector.connect 审批执行器（两段式 no-secret 设计见 journal 决策②） | plugin-connector/src/index.ts connections 段 | #2 | done 2026-08-27 |
| 5 | M1 | invoke 网关七步链 + usage.record 计量 + 审计 actChain/runId + 幂等键 + auditPersisted 补记；价格簿 connector:* 零费率；audit consume connector: 分支 | plugin-connector invoke 段 + plugin-usage L387-399 + plugin-audit L222-239 | #2,#3 | done 2026-08-27 |
| 6 | M1 | 接线：boot-all/cordis.yml/cordis.patch.yml/gen-manifests PLUGINS/PermissionCatalog+BuiltinRoles+幂等迁移/PlatformEvents 常量/plugin-mcp api.yaml 补登（补登写入生成器保持幂等） | 各共享文件（见冲突地图） | #2 | done 2026-08-27 |
| 7 | M2 | oct 令牌策略镜像完整版：台账/PUT 四数组全发/目录下架联动裁剪/连接删除联动/401·403 自动恢复重试一次/org 巡检（REST 手动触发口 /patrol） | plugin-connector tokens 段 | #4,#5 | done 2026-08-27 |
| 8 | M1 | REST guarded 路由全量 + patrol/reconcile/tokens 辅助口 + connector_* 五工具三端；启动冒烟验证三端可见 | console index.ts connector 段 + plugin-connector/src/tools.ts | #4,#5 | done 2026-08-27 |
| 9 | M1 | 控制台 #/connectors 页（目录/连接向导/权限组 JSON 编辑+影响面预览/运行日志+oct 台账/对账按钮）；#/mcp 桥接徽章 | console public/js/pages/connectors.js + app.js + mcp.js | #8 | done 2026-08-27 |
| 10 | M1 | CLI dshctl connector 命令组（§2.10 全树 + patrol 之外的 reconcile/tokens 扩展） | cli/dshctl.mjs | #8 | done 2026-08-27 |
| 11 | M2 | runs 对账（cursor 增量去重 cap4000）+ 绕行 critical 告警 + error_rate 记分评估；DEMO 种子扩展（env 门禁 OOMOL_CONNECT_DEMO_SEED=1） | plugin-connector reconcile 段 + console seed.ts | #5,#7 | done 2026-08-27 |
| 12 | M3 | 连接器型 L0 插件市场化（manifest connector 声明/install 二次确认/manual-settlement 挂账/L3 分成/市场 UI） | plugin-market/billing/console | #7,#11 | todo（**业务触发启动：首个外部开发者提交连接器型插件上架申请前不动工**，P0 修正③锁定） |
| 13 | 收尾 | OC_STUB 进程内服务（v1.4.0 契约面）+ T-01~T-25/T-28/T-29 断言组全绿 | scripts/selftest.mjs + seed.ts | #1–#11 | done 2026-08-27（selftest 521/521 exit=0） |
| 14 | 收尾 | 文档：README 三G 段/集成指南完稿/skills/dsh-ops-connector/dev-plan 已入仓定稿 | README/docs/skills/docs/dev-plan-connector.md | #13 | done 2026-08-27 |

## 三、文件所有权 / 冲突地图

| 文件/目录 | 涉及工作单 | 冲突等级 |
|---|---|---|
| `packages/plugin-connector/**`（新建包） | #2,#3,#4,#5,#7,#8(tools),#11,#13,#14 | 低（不同子文件可并发） |
| `packages/plugin-console/src/index.ts` | #4/#8 插入 connector guarded 路由段 | **高**（共享大文件，只在明确区块内插入） |
| `packages/plugin-console/src/seed.ts` | #11 告警规则、#13 演示种子 | 高 |
| `packages/plugin-console/public/js/app.js` + `pages/connectors.js` | #9 | 中 |
| `packages/plugin-iam/src/index.ts` | #6 权限点/BuiltinRoles/一次性迁移 | 高 |
| `platform-core/src/bus.ts` | #6 PlatformEvents 常量 | 中 |
| `src/boot-all.ts` / `cordis.yml` / `cordis.patch.yml` | #6 | 中 |
| `scripts/gen-manifests.mjs`（PLUGINS 数组） | #6 | 中 |
| `packages/plugin-mcp/manifest/api.yaml` | #6 端点摘要补登 | 低 |
| `packages/plugin-usage/src/index.ts` | #5 价格簿零费率条目 | 中 |
| `packages/plugin-audit/src/index.ts` | #5 consume connector: 分支 | 中 |
| `cli/dshctl.mjs` | #10 | 低 |
| `packages/plugin-market/**`、`plugin-billing/**` | #12（未启动） | 高（未来） |
| `scripts/selftest.mjs` | #13 + #1(T-25) | 高 |
| `docs/connector-integration.md`、`README.md`、`skills/dsh-ops-connector/`、`docs/dev-plan-connector.md` | #1,#14 | 低 |

## 四、当前占用（活跃 claim）

> 正式编辑前在此登记；完成即删行并 journal 留痕。

| Agent | 文件范围 | 认领时间 |
|---|---|---|
| （空——本轮 M1/M2 全部工作单已收口；M3 #12 待业务触发） | — | — |

## 五、断言进度（selftest T-xx）

2026-08-27 `npm run selftest` **521/521 全绿（exit=0）**：

| 组 | 断言 | 状态 |
|---|---|---|
| 契约锁定 | T-01 | ✅ |
| fail-closed | T-02（assumeEnv 预演探针双分支文案） | ✅ |
| 目录 | T-03 / T-04（下架触发裁剪后 PUT 四数组） | ✅ / ✅ |
| 连接 | T-05 / T-06 / T-07（maskedProfile 无原文） | ✅ / ✅ / ✅ |
| 授权 | T-08（RBAC 403+authz.denied）/ T-09（riskCap/readOnly）/ T-10（单点组 pattern-miss） | ✅×3 |
| 令牌镜像 | T-11（逐字段一致含通配 union）/ T-12（PUT 四数组+组删 DELETE）/ T-13（哨兵注入自动恢复；持续拒绝计 error_rate） | ✅×3 |
| 计量审计限流审批 | T-14 / T-15 / T-16a·b / T-17 / T-18 | ✅×5 |
| 健康/org | T-19（fail-closed+审计可检索）/ T-20（跨 org 组引用拒绝）/ T-21（巡检+warning 告警） | ✅×3 |
| 幂等/对账 | T-22（同键同 executionId 且单 run）/ T-23（绕行 critical+增量零新增） | ✅ / ✅ |
| 零密钥落盘 | T-24（SIGTERM flush 后数据目录全文扫描 oct_值/API Key/client secret 零命中） | ✅ |
| M0 桥接 | T-25（import reachable+online、bridgeFrom 标记、mcp_invoke 打通） | ✅ |
| M3 | T-26 / T-27 | ⏸ 随 #12 业务触发启动 |
| 边缘 | T-28（补记审计+告警记分）/ T-29（合法 oct_ 直连非命中 action 被 stub 侧 403 forbidden_action） | ✅ / ✅ |

| 组 | 断言 | 状态 |
|---|---|---|
| 契约锁定 | T-01 | todo |
| fail-closed | T-02 | todo |
| 目录 | T-03 / T-04 | todo |
| 连接 | T-05 / T-06 / T-07 | todo |
| 授权 | T-08 / T-09 / T-10 | todo |
| 令牌镜像 | T-11 / T-12 / T-13 | todo |
| 计量审计限流审批 | T-14~T-18 | todo |
| 健康/org | T-19 / T-20 / T-21 | todo |
| 幂等/对账 | T-22 / T-23 | todo |
| 零密钥落盘 | T-24 | todo |
| M0 桥接 | T-25 | todo |
| M3 | T-26 / T-27 | todo（随 #12） |
| 边缘 | T-28 / T-29 | todo |

## 六、关键设计落点速查（防各 Agent 重复读全文）

- OcClient 方法面 = 计划书 §2.3 表（health/listProviders/listActions/getAction/getActionGuide/upsertConnection/deleteConnection/listConnections/createOAuthAuthorization/runtime-tokens CRUD/executeAction/listRuns）；统一信封 `{success,data,meta}` / `{success:false,errorCode}`；PUT runtime-token 四数组全发。
- 存储集合六个：`connector:gateway|connections|catalog|permGroups|tokens|runs`（ctx.opsStorage.collection）。
- alias 强制 `org:<orgId>:` 前缀；连接引用无凭证字段（红线一）；API Key 表单过手不持久化，回显脱敏 slice(0,6)+'…'/'****'。
- 双层授权：平台 authorize()（对齐 McpPermGroup.authorize 语义：user_group 经 ctx.iam.resolveGroupMembers 展开/pattern/riskCap/readOnly/denyParams）↔ oct_ 令牌策略镜像（allowedActions pattern 直传 + allowedConnections 稳定 ID）。
- invoke 七步链顺序见计划书 §2.1；admin 审批 kind='connector.action.admin'；限流 key=`<permGroupId>:<callerType>:<callerId>`。
- riskLevel 由 requiredScopes/providerPermissions 启发式映射，无法判定 → admin 兜底。
- usage resource `connector:<provider>` 须过 `/^[a-z]+:[A-Za-z0-9._-]+$/`（provider id 小写数字连字符天然兼容，catalog 同步时校验拒绝不合规 service）。
- 计量：idempotency_key=`connector:<runId>`、trace_id=meta.executionId、resource=`connector:<provider>` meter calls；价格簿不加默认条目会被 record() 硬校验拒绝。
- adminToken 密钥值走 `env:` 间接引用（复刻 modelgw L102 一行式：`startsWith('env:') ? process.env[v.slice(4)] : v`）。
- fail-closed 触发条件三条：connector:gateway 未配置 / OOMOL_CONNECT_ENCRYPTION_KEY 或 _ADMIN_TOKEN 缺失 / GET /v1/health 探活失败 → status=unavailable + connector.gateway.unhealthy 事件 + 拒绝一切 invoke。
