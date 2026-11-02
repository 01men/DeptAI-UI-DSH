# 榕器平台 · 重构后产品功能测试总报告（2026-10-13）

> **测试对象**：git `ace7a59`（REFACTOR-2026-10-13 阶段 0–4 收口后：console 后端拆分 15 域 routes/*.ts、前端 iam 六模块、设计 token 三端统一、汉化收敛 R1/R10）
> **测试组织**：总负责人 1 名 + 4 个深挖组（A 安全权限 / B 计量网关 / C 编排集成 / E 更新与市场契约），总负责人亲测 GUI 黑盒与官方演练
> **测试实例**：5 × DEMO_SEED=1 演示模式独立实例（总负责 7330 + 每组独占 7341–7344），独立数据目录，全程未改仓库代码
> **分组详录**：[A 组·安全与权限](qa-report-20261013-group-a-security.md) · [B 组·计量与模型网关](qa-report-20261013-group-b-metering.md) · [C 组·编排与集成](qa-report-20261013-group-c-orchestration.md) · [E 组·更新与市场契约](qa-report-20261013-group-e-market.md)

---

## 一、总体结论

**重构本身没有伤到功能——B/C/E 三组 0 项新增 P1/P2，重构最大风险点「console 拆分引入路由/鉴权回归」经三面比对与越权矩阵交叉验证未发现回归；但 A 组安全深挖发现 1 项新 P1：上轮 P1「A-03 跨组织接管」的修复存在工具桥旁路。**

- 官方质量门全绿：`selftest` **1201/1201**（较上轮修复批次后 1118 净增 83 断言，含 QA 修复回归段）、`lint:manifests` 0 错误、`lint:boot-order` 0 错误（46 提示 + 2 项登记豁免）、`lint:cjk` 1 命中（豁免口径内）。
- 官方演练双绿：全链路演练 **27/27 PASS（2.8s）**；早高峰免登压测 **50 并发领票/兑换/会话 99ms 零失败**。
- 四组深挖合计 **约 408 项用例/断言**：A 组 ≈220 条 HTTP 断言（217 过，3 败同根因 N1）、B 组 72 用例（70 过）、C 组 52 用例（48 过 + 4 项已知未修现状记录）、E 组 64 断言（60 过，0 失败，4 项如实标注验证深度受限）。
- **新增缺陷**：P1 × 1（N1 工具桥组织隔离旁路）+ P2 × 1（BUG-2510-B1 渠道组降级链绕过预算熔断）+ P3 × 约 9（详见第四节）。
- 上轮（QA-20260912/20260913）承诺修复项经独立复核**整体保持有效**：本轮实际复核的 19 项全部确认落地；A-02/SEC-03 未列入本轮深挖范围（selftest 全绿 + 09-13 阶段 4 整合验证 20/20 兜底口径）。唯一例外即 N1——A-03 的 REST 面修复真实生效，但工具面（`/api/tools/execute` 与 `/mcp`）未同步收敛，形成旁路。上轮 selftest 的 A-03 回归断言只覆盖 REST 面，测不出该盲区。

## 二、质量门基线（总负责人实测）

| 门禁 | 结果 | 备注 |
|---|---|---|
| `npm run selftest` | **1201/1201 全绿** | 含「QA-20260912 修复批次回归」段（A-03/A-04/A-08/B-04 断言）与 T-24 凭证零进平台全目录扫描（156 文件 0 命中） |
| `npm run lint:manifests` | 0 错误 | 9 警告（3 manifest_missing / 4 perm_unused / 2 public_path_undeclared）均与上轮口径一致，E 组逐条评估无藏违规 |
| `npm run lint:boot-order` | 0 错误 / 46 提示 | 2 项登记豁免（connect 双形态位次、depends 自由文本） |
| `npm run lint:cjk` | 1 命中 | 豁免口径内（协议键/机制料），strict 绿 |

## 三、官方演练（总负责人实测）

| 演练 | 结果 |
|---|---|
| `tests/full-chain-drill.mjs` | **27/27 PASS，2.8s**：skill/app/mcp/nas 四资产「登记→审批→上架→授权→调用→回传」六步矩阵全过，四条 usage 事件落账可查 |
| `tests/morning-peak-entry.mjs` | **50 并发领票 50/50 · 兑换 50/50 · 会话可用 50/50 · 99ms 零失败** |

演练观察项（OBS-DRV）：早高峰实例停机窗口出现一次 `[storage] 集合 audit:logs 落盘失败 ENOENT`（`platform-core/src/storage.ts:336` rename tmp→目标时数据目录已被演练脚本清理）。属关停竞态、不影响功能断言（exit=0），建议存储层对停机窗口的落盘失败降级为 debug 日志。

## 四、本轮新增缺陷台账

| 编号 | 级 | 域 | 缺陷 | 关键事实 |
|---|---|---|---|---|
| N1 | **P1** | 安全 | **工具桥 iam_* 工具未传 manageActor——A-03 组织隔离被完整绕过** | REST 面刚修复的跨组织隔离，可经 `/api/tools/execute` 与 `/mcp` 完整绕过：hr 对市场部用户**建号/冻结/重置口令三连全部 200**（重置响应含明文新口令）。根因三处叠加：`plugin-iam/src/tools.ts:106,120,135`（工具定义不传 manageActor）+ `plugin-iam/src/index.ts:1082`（`if(!actor) return` fail-open）+ `plugin-console/src/routes/bridge.ts:62-77`（身份注入白名单缺 iam_user_*）。上轮 selftest A-03 断言仅覆盖 REST 面，测不出工具面盲区 |
| BUG-2510-B1 | **P2** | 计量 | **渠道组降级链完全绕过预算熔断** | block 已熔断中经 `/api/modelgw/channel-groups/:slug/invoke` 仍 200 调到上游并入账；`enforceBudget` 仅挂在单渠道 invoke()（`plugin-modelgw/src/index.ts:438`），invokeWithFallback（:239-291）全程无预算检查。上轮未暴露（预算经单渠道路径测试） |
| N3 | P3 | 安全 | org_admin 读面无组织过滤 | hr `GET /api/iam/users` 可见全平台 22 账号（含他部邮箱/手机/职务）；A-03 修复仅覆盖写面 |
| N2 | P3 | 安全/市场 | market register 与工具桥把原始 TypeError 文本回给客户端 | `routes/market.ts:24` |
| N4 | P3 | 安全 | 跨组织拒绝以 400/BAD_REQUEST 而非 403 呈现 | 可并入已立项的语义统一批次 |
| N5 | P3 | 文档 | README 对 sceneCode 的全称宣称未带「panel 任务/消息入口未接入」范围注记 | `README.md:35`；代码侧延期口径诚实（release note 有声明） |
| BUG-2510-B2 | P3 | 计量 | usage.record 字符串字段无长度上限 | org 字段 50KB 200 入库（其余 19 类非法输入全 400）；`plugin-usage/src/index.ts:1019`，与 09-13 已立项「REST 入参无统一校验」同源 |
| E-NEW-1/2 | P3 | 市场 | ① 插件 id 命名空间不与开发者身份绑定（仅审批闸缓解，`plugin-market/src/index.ts:146`）；② `DELETE /api/apps/developer-options` 跨方法回落 400（实际无害） | E 组登记 |
| OBS-1 | P3 | 总线 | BusDeadLetterRecord 无 source 字段 | `plugin:` 形态死信结构性不可重投，现按 C-02 口径原地保留+注明原因（可接受但无自动恢复路径）；`platform-core/src/bus.ts:145-153` |
| OBS-DRV | P3 | 演练 | 停机窗口 audit 落盘 ENOENT 报错 | 见第三节 |
| ENV-1 | 环境 | GUI | 测试宿主（ZCode 内置浏览器）合成器停摆 | rAF=0 / 截图超时 / 坐标点击失效，跨新标签页复现；DOM/命中测试/数据全部正常 → 判定为宿主窗口被遮挡导致 Chromium 挂起绘制，**非被测应用缺陷**。⌘K 搜索（G-02）等视觉项待人工在窗口前台时复核 |

## 五、上轮缺陷修复回归台账（QA-20260912 / 20260913 两批次）

| 编号 | 级 | 修复声明批次 | 本轮回归结论 |
|---|---|---|---|
| A-01 sceneCode 无执行点 | P1 | 09-12 | ✅ **flow 域闭环确认**（deny 403 + fail-closed 403 + `authz.denied` 落审计，91 条在案）；panel 任务/消息入口按 release note 诚实延期（N5 指 README 未带注记） |
| A-02 角色迁移首启空跑 | P1 | 09-12（+09-13 ARC-01 加固） | ⏸ 未列入本轮深挖范围；selftest 全绿 + 09-13 阶段 4 整合验证 20/20（ARC-01 双路径）兜底 |
| A-03 org_admin 跨组织接管 | P1 | 09-12 | ⚠️ **REST 面修复确认 + 工具面旁路（本轮新 P1「N1」）**：hr 对市场部用户 PATCH/reset/freeze/建号 REST 全 400、本组织正向对照全 200；但工具桥三连全 200 |
| A-04 developer 改他人应用 | P1 | 09-12 | ✅ dev/ops 改他人应用 403，5 处守卫（PATCH/DELETE/onboarding-prompt/metrics-report/transition）全覆盖 |
| B-01 J4 月报 tokens 偏差 | P1 | 09-12 | ✅ B 组复核：双月四维自洽（totals=手算和逐分不差、ΣbyOrg=totals、CSV 同源），`plugin-usage/src/index.ts:570` |
| C-01 总线自激放大 | P1 | 09-12 | ✅ C 组复核：反馈断路生效，journal 2s 定格、15s 零净增（`bus.ts:143/364-366`） |
| E-01 一键回滚死路 | P1 | 09-12 | ✅ E 组复核：快照写入点落地（`plugin-update/src/index.ts:656-660`）；selftest 仍为纯负向断言（正向快照登记断言缺失，建议补 mock runGit 单测） |
| A-05 自审批 | P2 | 09-12（→09-15 APR-05 放宽） | ✅ 按业务决策放宽为允许自审：实测自审 200，approval.decide 权限点与高风险 confirmed 校验不变——与最新口径一致，非缺陷 |
| A-06 六类 L4 审批未标高风险 | P2 | 09-12 | ✅ 网关下线单实测：无 confirmed 400 → confirmed 执行 + 终审审计；6 类显式标注 + 中央闸兜底双保险 |
| A-07 OBO 令牌越权 | P2 | 09-12 | ✅ 他人 Agent 签发 403；自有 Agent 签发 scope=交集且越权 403，验签二次夹紧在位 |
| A-08 口令强度双口径 | P2 | 09-12 | ✅ "123"/7 位/含中文建号与重置全拒（≥8 位统一口径） |
| B-02 降级链缺 model 字段 | P2 | 09-12 | ✅ 转发体含备渠道 model.slug（stub 回显实测），超时切换 1007ms 同验 |
| B-03 usage_query 过滤失效 | P2 | 09-12 | ✅ resource/principal/无过滤三态与 REST 全等 |
| B-04 audit/cost days 丢弃 | P2 | 09-12 | ✅ days=7/1 与全量差异且金额手算吻合（`routes/audit.ts:69`） |
| B-06 成本口径 charge 当 cost | P2 | 09-12 | ✅ 运行时投影取 cost_cents（0.08 元=恰 8 分 cost_cents） |
| C-02 死信重投整体丢失 | P2 | 09-12 | ✅ 逐条重投 `{attempted:3,redelivered:2,retained:1}`，不可重投条目原地保留+注明原因 |
| C-03 死信无运维面 | P2 | 09-12 | ✅ GET/POST `/api/bus/dead-letters(/retry)` 可用 + usage.admin 门禁（hr/dev/audit/ops 全 403） |
| C-04 ODD 非法声明静默剔除 | P2 | 09-12 | ✅ 10/10 非法声明一律 400（`odd.ts:83-120`） |
| E-02 越集权限安装 | P2 | 09-12 | ✅ approved ⊆ requested 400 且文案点名（`plugin-market/src/index.ts:378-384`） |
| E-03 镜像失败事件半程 | P2 | 09-12 | ✅ mirror_failed 三面实测全通（audit 留痕 + critical 告警 + panel SSE 扇出实收事件帧）；snapshot_drifted 同接线块静态验证 |
| SEC-01 PATCH users 质量赋值 | P0 | 09-13 | ✅ 白名单生效，白名单外 400 并点名（mass 探针实测） |
| SEC-02 OIDC 泄露 secretHash | P2 | 09-13 | ✅ 对外响应无 secret 泄漏 |
| SEC-03 悬挂 parentId | P2 | 09-13 | ⏸ 未列入本轮深挖范围（09-13 阶段 4 整合验证通过口径） |
| B-05 demo seed 直写 costs | P2 | 排期内未修 | 如实：`seed.ts:485` 仍硬编码造数（与 09-12 §五排期口径一致，非回归） |
| G-01/G-02 工具链与 ⌘K | P2/P2 | 09-12 | ⏸ 未复测 / 待人工复核（ENV-1）；`npm run lint:manifests` 链路健康间接佐证 G-01 修复保持 |

**遗留 P3（上轮已登记、按排期未修，本轮逐一现状复核无恶化）**：C-05 失败监听器拖慢同事件派发 ~1.05s/事件、C-06 flow skip 静默停滞、C-07 SLA 负/零值出生即逾期、E-04 YAML 冒号标量误判、E-05 dryRun+pin 真实 git fetch、E-06 scenegraph.activate 授 org_admin 无闸门 + 权限死点、B-07/B-08 面板事件订阅与 rq-card 钱包文案残留、market 计量幂等键随机。

## 六、验证通过面（真实健康的部分）

- **重构风险收口**：console 拆分后 15 个域路由文件全部装配（`plugin-console/src/index.ts:203-229`）；16 条抽样路由与 `/api/platform/route-matrix` 336 条登记三面一致（method/path/权限点逐字一致），403 文案点名权限点；前端 iam 六模块拆分后 dom-smoke/走查不变量断言全绿（零裸 fetch/XHR/SSE）。
- **安全与权限（A 组）**：token 攻防 12 向量全 401、过期精确失效；**冻结→存量令牌即时吊销（401 带冻结原因）→解冻不复活全链通**；refresh 宽限自愈 + 窗口外重放整链吊销；RBAC 30 端点 × 3 角色 90 断言全部符合角色语义；匿名 25 路径 + 路径混淆全 fail-closed；PUBLIC_PATHS 15 项无数据泄漏；登录失败 5 次锁定实测触发；a003283 伪造能力令牌 fail-closed 回归通过。
- **计量与网关（B 组）**：schema 19 类非法输入拒绝且文案含修正指引、幂等重放同键同 event_id、保留策略三态、purge 权限矩阵、分级路由 fail-closed（含组内逐步校验）、降级链 offline/超时双路径、预算 warn 每日去重且 payload 手算吻合、J4 报表三维自洽、遥测增量手算吻合、全出口 charge=0。
- **编排与集成（C 组）**：journal 229 行单调无坏行、kill+重启回放续号、FIFO 串行、监听器异常隔离（必抛错 HTTP 订阅端实测）、50/200/800ms×4 退避后死信落盘；flow 状态机合法主干 + 7 类非法拒绝 + 6 路并发恰 1 胜出无丢更新 + 模板快照复制；ODD 非法声明 10/10 拒绝；connect 换装还原/宿主不可达显式抛错；随包单测复跑 bus 8/8、odd 13/13、proxy 7/7。
- **市场与契约（E 组）**：Ed25519 签名四连击全 400 且文案明确；L0 零价闭环（上架→安装→计量→卸载后拒绝，全程 charge=0）；契约豁免 8 条逐条实活无藏违规；output.schema 注册期强校验；update 面结构健康、502 优雅失败、`DSH_UPDATE_AUTO_CHECK` 关闭生效。
- **GUI（DOM 级）与汉化**：落地页/工作台/资产登记/部门面板（独立 /panel/ 面板应用）渲染正常，已访问页面无真实英文展示残留（协议词/品牌词白名单口径）；错误口令反馈正确。详见第七节。

## 七、GUI 黑盒与汉化（总负责人亲测）

**环境说明（ENV-1）**：本轮测试宿主的内置浏览器渲染合成器在会话中途停摆（rAF 停帧、截图面超时、坐标点击失效，新开标签页复现；DOM 结构、命中测试、业务数据全部正常）。判定为宿主窗口被遮挡导致 Chromium 挂起绘制，**非被测应用缺陷**。按测试规范如实记录：已完成的 DOM 级验证如下，视觉复核（截图比对、⌘K 浮层 G-02 回归）待窗口前台人工补测。

| 测试点 | 结果 | 证据 |
|---|---|---|
| 落地页渲染（登录控制台 + 钉钉/账号密码双方式） | ✅ DOM 级 | 快照结构完整、全中文 |
| 错误口令反馈 | ✅ | 提示「用户名或密码错误」，无崩溃 |
| admin 登录 → 工作台 | ✅ | `#/dashboard`：统计卡（19 账号/5 MCP/672 调用/P95 511ms/¥888.46）、待我审批、告警、事件流全渲染 |
| 资产登记页 | ✅ | 五类资产入口 + 登记前自检表单（负责人预填/密级/描述规范） |
| 部门面板（独立面板应用） | ✅ | `/panel/` 部门工作台渲染，钉钉桥接状态可见 |
| 英文残留抽查 | ✅ | 已访问页面无真实英文展示残留（R1 汉化收敛保持） |
| 其余 16 个控制台页面遍历、⌘K 搜索（G-02）、高危审批双闸 GUI 验证 | ⏸ 环境阻塞 | 由 selftest dom-smoke/接线断言与四组 API 实测补偿覆盖；G-02 维持上轮「待人工复核」口径 |

## 八、修复优先级建议

1. **立即**：N1（P1）——iam 工具面（iam_user_create/reset_password/freeze 及 /mcp 同路径）补 manageActor 传递：最小修法是 `injectToolIdentity`（`bridge.ts:62`）对 iam_user_* 注入 `{userId, permissions}` 形态 actor，或 tools.execute 把 principal 直传服务层；同时把 `assertManageScope` 的 `if (!actor) return` 收敛为「仅限无 HTTP 上下文的内部调用（seed/导入）」白名单化。**并补一条工具面组织隔离 selftest 断言**（现有断言只测 REST 面，测不出旁路）。
2. **本迭代**：BUG-2510-B1（invokeWithFallback 入口补 `enforceBudget`，一行守卫位 + 组路径熔断 selftest 断言）；N3（org_admin 用户读面按组织子树过滤或脱敏 email/phone）；N2（market register 入参校验前置 + 错误信息规整）。
3. **随批/排期**：E-01 正向快照登记断言（mock runGit 单测，防写入点被回归删除时自动化失明）；BUG-2510-B2 与「REST 入参统一校验」立项合流；N4 并入 404/400/403 语义统一；N5 README 注记；OBS-DRV 存储停机窗口日志降级；B-05（seed 走管道造数）、A-01 任务/消息入口 sceneCode schema 变更、C-05/06/07、E-04/05/06、B-07/08 等 P3 存量维持既定排期、无恶化。
4. **人工补测**：ENV-1 解除后复核 ⌘K 全局搜索（G-02）与 19 页面视觉走查。

---

**测试资产说明**：全部测试实例（7330/7341–7344）与数据目录（`data-qa-*`、`data-drill`、`data-morning-peak`，均在 `.gitignore` 覆盖内）于报告落档后停用清理；分组完整报告含复现命令索引；A 组已披露并恢复其对演示账号 dd0008 的探测性变更。
