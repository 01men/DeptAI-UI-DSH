# A2A/UHP 施工说明：企业数字员工内网协作面（2026-10-20 批次，2026-10-21 复测整改）

> 需求来源：《企业数字员工内网通信协作方案设计（融合版）v2.0》
> 契约依据：contract-c3 v1 升版 v2（发布说明见 `docs/contract-c3-agent-a2a-v2-release-notes.md`）
> 复测整改对账：`docs/a2a-uhp-retest-fix-20261021.md`（P1-01 / P2-01..06 的根因与修复）
> 本文是施工实现与方案的对账说明：做了什么、没做什么、为什么。

## 1. 交付总览

| 模块 | 动作 | 内容 |
|---|---|---|
| `packages/plugin-a2a` | **新** | Agent Card 生成/JWS 签名/well-known 发布；跨运行时目录检索；JSON-RPC 方法面（message/send·stream、tasks/get·list·cancel）；治理检查五项；A0-A3 协商引擎；八态 Task 生命周期；交付验收；履约视图；声明-授权一致性巡检（例行 + 手动） |
| `packages/plugin-uhp` | **新** | `GET /v1/uhp` 能力发现（免鉴权、版本锁定 2026-08-11、conformance=core）；`POST /v1/uhp/responses` 任务面（Responses 兼容子集 + metadata 扩展、幂等键、会话续接、取消、SSE）；configured harness 注册表 |
| `packages/plugin-agent` | 改 | schema 增「协作属性」字段组（a2aDataClassCeiling / uhpHarnessRef / uhpSessionPolicy，additive，存量缺省兼容） |
| `packages/plugin-usage` | 改 | usage_events 增 `context_id` 列（D3 同款 additive 迁移）；`collaborationEvents/collaborationSummary` 协作链聚合；`GET /api/usage/collaborations` 查询面 |
| `packages/plugin-console` | 改 | 协作链计量查询路由；演示只读白名单增补（a2a.directory.read / uhp.read）；前端「A2A 协作」页（目录/任务追踪/履约三区块） |
| `scripts/selftest.mjs` | 改 | 新增「A2A/UHP 协作面」分节（约 30 项断言：卡片验签/单轮/治理拒绝/审批恢复/协商 accept·counter·超限/取消不计量/UHP 直调幂等/tools 封堵/harness 生效/巡检漂移/验收/履约/SSE fail-closed） |

## 2. 架构落点（与方案 §4 对应）

```
调用方 ──JSON-RPC /api/agents/:slug/a2a──▶ plugin-a2a（治理面：五查 + 协商 + 八态状态机）
                                              │ 唯一联动通道：ctx.platformBus
                                              ▼
                          a2a.task.dispatch（幂等键 a2a:<agent>:<principal>:<task>:a<attempt>）
                                              ▼
                          plugin-uhp（执行面：configured harness → modelgw 真实模型调用）
                                              ▼
                          a2a.task.progress（started/completed/failed/canceled）
                          uhp.response.progress（所有来源，含外部直调——仅喂 SSE，不驱动状态机）
                                              ▼
                          plugin-a2a 收口：artifact 落账 + usage 快照（contextId 协作链）+ 审计 + 验收入口
```

- **exec-hub 寄生映射**（方案决策 3）本版以「可选 `executionIssueId` 关联 + 独立八态」的轻形态落地：A2A 任务由平台 harness 同步执行，不强制造 exec-hub Issue/租约（那会误触发心跳唤醒与 workforce 准入）；深绑定随 Postgres/HA 阶段（P0 硬前置）评估。
- **workforce 验收关联**（方案 §11）：A2A 任务的验收落在任务本体 `acceptance` 字段（人工 + 仅 completed + 必填理由），workforce 交付验收单保持 permit 绑定语义不变；两套验收共用「不轻信自报」原则，履约视图按任务聚合。
- **任务可见性顺序（2026-10-21 修正）**：**归属优先于组织收敛**——发起方本人恒定可见自己的任务，组织隔离只约束非发起方的治理读。此前组织判定在前，导致无组织归属的 `refType=external` 凭证看不到自己发起的任务（P1-01）。

## 3. 关键实现决议

1. **签名**：JWS compact（alg=EdDSA/kid），签名输入 `${protected}.${payload}`，复用 platform-core `signature.ts` 的 Ed25519 原语（与 market/update 同一套基建）；私钥落盘 `data/a2a-card-signing-key.pem`（0600），集合只存公钥；平台目录卡 `.well-known/agent-card.json` 附 `signingKeys` 供先验签后采信。
2. **技能投影**：卡片 skills = `attrs.skills`（仅 published）+ subjects 命中该 Agent 的 MCP 权限组；不接受自由填写。巡检捕获「引用已下架 Skill / 已删权限组 / 幽灵 harness / 模型离线」四类漂移并告警。
3. **幂等链**：UHP `Idempotency-Key` ← dispatch 幂等键 `a2a:<agentId>:<principal>:<taskId>:a<attempt>`；attempt 随审批恢复/中断续答自增，重放返回原 response。
4. **越权原语封堵**：请求级 `tools`（顶层或 metadata）一律接受不生效，记 `metadata.ignored_fields`；harness 工具面白名单（toolPermGroupIds）为授权投影声明，v1 内置 harness 不执行工具（诚实边界，见发布说明 §六）。
5. **演示态**：`a2a.directory.read`/`uhp.read` 有意增补进演示只读白名单（方案 §14.7 要求的审计已跑通）；写/验收/执行类权限点全部不进白名单，405 闸门双保险。
6. **纪律例外登记**：plugin-a2a 对 `uhpGateway` 为**只读治理探测**（巡检），经显式 inject 声明（cordis 强制）；任务协作状态流严格只走事件总线，无任何直连数据路径。
7. **permit 判定走契约方法**（2026-10-21）：治理第 2 项经 `ctx.workforceIdentity.inspectAgent(agentId)` 判定三段态（未纳管 / 已纳管但 permit 失效 / permit 生效），不读取 `resolver.store` 内部结构；`inject` 必须显式声明 `workforceIdentity`——缺声明会让 Service 代理抛错并被 catch 吞掉，治理项静默退化为空操作（P2-01 的教训）。
8. **SSE 事件分轨**（2026-10-21）：`a2a.task.progress` 只对平台派发记录发出（P0 任务劫持闸门，不得放宽）；SSE 与外部直调流改订阅新增的 `uhp.response.progress`（所有来源统一发出、不驱动任何状态机）。两者同为总线事件，纪律不变。
9. **规范裸体边界**：A2A Agent Card（well-known）与 `GET /v1/uhp` 按规范直出裸 JSON；平台 `/api/*` 业务面仍统一 `{ok,data}` 信封。避免「同一协议面两套解析分支」。

## 4. 环境变量

| 键 | 缺省 | 说明 |
|---|---|---|
| `A2A_SYNC_WAIT_MS` | 12000 | message/send 同步等待终态窗口；超时返回在途任务（客户端 tasks/get / SSE 续查） |
| `A2A_PATROL_INTERVAL_MINUTES` | 60 | 一致性巡检例行间隔；0=关闭例行 |
| `PLATFORM_PUBLIC_BASE` | 空 | 卡片 url 对外基址（内网反代场景声明） |

## 5. 验收快照（selftest「A2A/UHP 协作面」分节）

- 卡片：平台目录卡匿名可读（含 Ed25519 公钥）；单员工卡 JWS 验签通过（node:crypto 独立复验）；不存在/未上线 404 不泄露存在性。
- 任务：人类×A0 单轮代答 completed + contextId 协作链计量（calls+tokens）；agent 凭证×A2 经 UHP 执行 completed；同步等待窗超时返回 working 态。
- 治理：密级越级 -32002 DATA_CLASS_EXCEEDED；协商矩阵 A3×A0 NEGOTIATION_REJECTED；下线 TARGET_NOT_ONLINE；敏感词规则 → auth_required → 审批通过幂等恢复（attempts=1）。
- 协商：A3×A3 要约 accept → 自动执行；counter → input_required 续答；3 轮超限 → rejected。
- 取消：在途取消即时生效，结果不交付、不进协作链计量。
- UHP：能力发现免鉴权；任务面无令牌 401 / 无 uhp.invoke 403；同幂等键重放同 response；tools 注入 ignored_fields 留痕；显式 harness 生效。
- 巡检/验收/履约：ghost 引用被巡检捕获并告警；非 completed 拒绝验收；验收回写履约视图（完成率/验收通过率/P95）。
- RBAC：全部新 guarded 路由自动进越权探针矩阵（member 403 全绿）。
- **外部集成闭环（2026-10-21 新增）**：`refType=external` 凭证派活 → tasks/get → tasks/list → SSE → tasks/cancel 五段全通。
- **permit 覆盖（2026-10-21 新增）**：受管态（绑定 + 零任用）→ `PERMIT_NOT_EFFECTIVE`；恢复任用后放行。
- **注入变体矩阵（2026-10-21 新增）**：metadata / 顶层 snake / 顶层 camel 三路径统一 400 + 专项审计。
- **UHP 直调 SSE 闭合（2026-10-21 新增）**：外部 `stream=true` 收到 `response.completed`。
- 前端门禁：`page-smoke` 覆盖 A2A 五 tab；`lint:i18n` 文件级三语覆盖 ≥95%。
