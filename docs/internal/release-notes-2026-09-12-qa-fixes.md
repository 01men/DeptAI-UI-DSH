# 发布说明：QA-20260912 测试报告修复批次（2026-09-12）

> 对应测试报告：`docs/internal/qa-report-20260912-overview.md`（P1×7 / P2×14 / P3 约 20）。
> 本批次落地：**P1 全部 7 项 + P2 共 12 项 + 工具链 G-01**，另附报告口径修正。
> 验证：selftest **1118/1118 全绿**（基线 1103，净增 15 条回归断言）、lint-manifests 0 红、
> check-docs-consistency 64/64、bus.test.mjs 8/8、odd.test.mjs 全绿。

## 一、P1（7/7 全部修复）

| 编号 | 缺陷 | 修复 | 位置 |
|---|---|---|---|
| A-01 | sceneCode 全平台无执行点 | sceneGuard 接入 flow 三入口（创建/步骤流转/取消）：场景已配置策略时 deny/fail-closed 一律 403 并落 `audit.authz.denied`；无策略回落 RBAC（存量口径不变）。**任务/消息直调入口暂未接入**（任务/消息记录无 sceneCode 字段，需 schema 变更，列入下迭代），控制台自查端点保留 | `plugin-flow-core/src/index.ts` |
| A-02 | 角色权限迁移首启空跑 | 迁移调用移入 `seedAll` 每次启动幂等重跑（种子完成 → 迁移补点）；connector 装配期调用保留兜底 | `plugin-console/src/seed.ts` |
| A-03 | org_admin 跨组织接管账号 | iam 服务层补栏 `assertManageScope`：非平台管理员（无 `*`）只能管理本组织子树内账号，机器主体/无法定位归属者 fail-closed 拒绝。覆盖 create/update/reset/freeze/unfreeze/activate/deactivate/delete/bindings/assignRoles；HTTP 面全部传 `manageActor` | `plugin-iam/src/index.ts` + `plugin-console/src/index.ts` |
| A-04 | developer 可改写他人应用 | `assertAppOwner` 守卫覆盖 PATCH/DELETE/onboarding-prompt/metrics-report/transition：平台管理员、owner、绑定本应用的机器主体之外 403 | `plugin-console/src/index.ts` |
| B-01 | J4 月报 tokens 小 176 倍 | SQLite 下 GROUP BY 查询 SELECT 列表中的裸关联子查询只对组内任一行求值——改为 `SUM((SELECT …))` 逐行求和。summary/monthlyReport 同型同修，三维自洽（totals = ΣbyOrg，selftest 新增断言） | `plugin-usage/src/index.ts` |
| C-01 | 事件总线自激放大循环 | 回授断路：`bus.listener_error`/`bus.dead_letter` 自身监听器失败不再回授事件，直接入死信（证据可查、循环切断）。新增单测（bus.test.mjs ⑦） | `platform-core/src/bus.ts` |
| E-01 | 一键回滚是死路 | `applyUpdate` 在 merge 成功后即落库 `lastApplySnapshot/lastApplyPin/lastApplyAt`（先于 npm install，依赖同步失败也保留回退锚点） | `plugin-update/src/index.ts` |

## 二、P2（12 项）

| 编号 | 修复 |
|---|---|
| A-05 | `decideApproval` 服务端拦截提交人=审批人（approve/reject 一并拦截）；selftest 全面改双人审批并固化「自审被拒」断言 |
| A-06 | 六类 L4 审批（connector.offline / connector.connect / connector.action.admin / mcp.offline / nas.share / panel.card-action / industry.activation）补 `riskLevel:'high'`（调用点显式 + audit 中央闸兜底），二次确认强制生效；面板卡片未声明风险时缺省 high（fail-closed） |
| A-07 | ① `/api/agents/:id/obo-token` 收敛为 owner/绑定用户/平台管理员；② 验签对 `issuedBy: obo:` 令牌按签发交集二次夹紧（实时解析不再丢弃交集、也不放大） |
| A-08 | 建号口令强度与重置统一（≥8 位、不含中文），`assertPasswordStrength` 共用 |
| C-02 | `retryDeadLetters` 改逐条重投：不可重投条目（丢 source 的 `plugin:` 事件）原地保留并注明原因，不再连带丢弃；返回 `{attempted, redelivered, retained}`。新增持久化死信重投单测 |
| C-03 | 总线死信运维面：`GET /api/bus/dead-letters`、`POST /api/bus/dead-letters/retry`（usage.admin），对齐 usage 死信面 |
| C-04 | `normalizeOdd` 非法声明一律抛错（400 呈现，fail-closed）：字符串白名单/负新鲜度/越界时间窗等；未声明字段仍折叠。单测⑬改写为断言抛错 |
| B-02 | 降级链转发上游请求体以实际渠道 `model.slug` 为准（原 `input.model` 在 Omit 形态下为 undefined，真实上游备渠道全链 400） |
| B-03 | `totals()` 补 `resource` 过滤（此前 SQL 缺列被静默忽略，usage_query 工具返回全库数字） |
| B-04 | `/api/audit/cost` 的 `days` 参数真实生效（未给 from 时折算窗口起点，响应回显 days；兼容不带 days 全量口径） |
| B-06 | audit 成本投影取 `cost_cents`（内部成本口径），不再以 `charge_cents`（应收）充当成本 |
| E-02 | market 安装 `approvedPermissions ⊆ permissions.requested` 校验（能力面同口径）；selftest 加越权/正向双探针 |

另：**E-03** 镜像失败事件（connector.policy_mirror_failed / snapshot_drifted）补齐审计留痕 + critical/warning 告警 + panel SSE 扇出（原只走总线半程）。

## 三、工具链

- **G-01**：`check-docs-consistency.mjs` 改用 `fileURLToPath`（百分号编码路径在中文目录必现 ENOENT）；修复后本机首次完整跑通，暴露 3 处历史误报（sidecar 外联引用，加豁免名单）+ 1 处真实文档漂移（`/api/runs` → `/api/connector/runs`，已修正文档）。

## 四、测试资产

- selftest 基线 1103 → **1118**：A-05 双人审批×4、A-03 正反向×2、A-04 正反向×3、A-08、B-01 三维自洽、B-04×2、E-02 正反向×2（其中 1 条原断言「发起人可自审」属固化缺陷行为，已改写为「自审被拒 + 双人通过」）。
- bus.test.mjs 6 → 8（回授断路确定性场景、持久化死信保留式重投）；odd.test.mjs ⑬改为 fail-closed 断言。
- selftest 引入第二平台管理员 `approver02` 作为独立审批人（钉钉桥接回决身份同步切换）。

## 五、遗留与排期（诚实声明）

- **B-05**（demo seed 绕管道直写 costs 硬编码成本）按报告建议列入排期：需把 seed 造数改走 usage 管道，涉及 28 天历史数据形态，单独批次处理。
- **G-02**（⌘K 搜索联想不可见）待 QA 人工复核后定位（报告本身标注待复核）。
- A-01 的任务/消息入口接入需任务/消息记录携带 sceneCode 字段（schema 变更），与 B-05 同批排期；flow 域已闭环。
- iam 工具面（iam_user_create 等）actor 上下文未传（权限点闸门独立），下批次统一接入 manageActor。
- P3 清单（口令 KDF、常数时间比较、admin 口令文件 0600、总线头阻塞等）维持报告排期不变。

## 六、升级注意

- 审批中心语义收紧：六类 L4 审批现在**必须带 `confirmed=true`** 才能通过（前端确认弹窗已有，自建调用方需补参）。
- 自审自批被服务端拦截：原「提交人自行通过」的集成流程需改双人（或机器审批身份 ≠ 提交人）。
- 应用写操作（PATCH/删除/指标上报/流转）owner 校验生效：非 owner 开发者将收到 403。
- `retryDeadLetters` 返回值从 number 变更为对象（全仓无既有消费方，已核）。
