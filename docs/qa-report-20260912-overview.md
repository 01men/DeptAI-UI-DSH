# 元冰可平台 · 季度系统性测试总报告（2026-09-12）

> **测试对象**：git `2122c2c`（2026-09-12 拉取，OPT-P0~P3 优化批次共 10 提交）
> **测试组织**：总负责人 1 名 + 4 个深挖组（A 安全权限 / B 计量网关 / C 编排集成 / E 更新与市场契约），总负责人亲测 GUI 黑盒、CLI、Portal 与官方演练
> **测试实例**：DEMO_SEED=1 演示模式，独立数据目录，独立端口；全程未改仓库代码
> **分组详录**：[A 组·安全与权限](qa-report-20260912-group-a-security.md) · [B 组·计量与模型网关](qa-report-20260912-group-b-metering.md) · [C 组·编排与集成](qa-report-20260912-group-c-orchestration.md) · [E 组·更新与市场契约](qa-report-20260912-group-e-market.md)

---

## 一、总体结论

**骨架真实扎实，但「宣传与实现脱节」是本批最大主题。**

- 官方 `npm run selftest` 1103/1103 全绿没有撒谎：认证攻防、RBAC 越权矩阵、审批冒充封堵（a003283 回归通过）、计量幂等、零价语义等地基全部经得起独立打击。
- 但四个组合计发现 **P1 级缺陷 7 项**，多项属于「提交信息/文档宣称的能力实际未生效或只走了一半」，且存在 **selftest 断言空转掩护缺陷**的两处实例（A-02、E-01）。
- 两处官方质量闸门被证实为真（防恒绿）：P95 尾延迟闸门经负向对照（阈值压至 1ms）真变红 exit=1；契约豁免名单经逐条审查无藏违规。

**缺陷总量**：P1 × 7 ｜ P2 × 14 ｜ P3 及观察项 × 约 20。

## 二、P1 级缺陷清单（7 项，均含复现与 file:line 根因，详见分组报告）

| # | 域 | 缺陷 | 关键事实 |
|---|---|---|---|
| [A-01](qa-report-20260912-group-a-security.md) | 安全 | **场景级授权 sceneCode 全平台无执行点** | 自查端点判 `deny`，实际动作照常 200 执行；`checkScene()`（plugin-iam/src/index.ts:856-887）全仓唯一调用方是自查端点自身（plugin-console/src/index.ts:1205）。README/IAW 6-1 宣称的 deny→allow→fail-closed 实际未生效。若客户安全方案已依赖该能力，应升 P0 |
| [A-03](qa-report-20260912-group-a-security.md) | 安全 | **org_admin 可跨组织接管账号** | 实测 hr（产品运营部 org_admin）成功修改/冻结/**重置市场部用户口令（响应含明文新口令）**，`/api/iam/users*` 路由仅校验权限点、服务层零组织归属校验。多组织隔离若属硬边界应升 P0。**总负责人已独立复核确认** |
| [A-02](qa-report-20260912-group-a-security.md) | 安全 | **内置角色权限迁移首次启动空跑** | 迁移挂在 connector 装配期（plugin-connector/src/index.ts:1673），早于 console 角色种子（seedAll，console 在后）执行，首启跑在空角色表上（live 库迁移标记早于角色记录 18ms 铁证），生产目录角色权限与文档永久不符，重启才自愈。selftest 断言用 member（自带全量权限点）测不出——断言盲区 |
| [A-04](qa-report-20260912-group-a-security.md) | 安全 | **developer 可修改他人应用** | `PATCH /api/apps/:id`（plugin-console/src/index.ts:3442）只校验 `app.write` 无 owner 校验，实测 dev 改写 hr 名下应用属性 200 生效；角色描述「限自身 owner 范围，服务端校验」未兑现 |
| [B-01](qa-report-20260912-group-b-metering.md) | 计量 | **J4 月度报表 tokens 小 176 倍** | 报表 `totals.tokens=27,311` vs 底层事件手算 4,807,991；byOrg 各行之和(227,095)≠totals，三维自洽破坏，CSV 同源同错。根因：SQLite `GROUP BY` 下关联子查询只对组内某行求值（plugin-usage/src/index.ts:551，summary 同型 :466）。同报表 cost_cents（真 SUM）自洽可交叉证伪。**总负责人已独立复核确认** |
| [C-01](qa-report-20260912-group-c-orchestration.md) | 集成 | **事件总线自激放大循环** | 订阅 `bus.listener_error` 的失败监听器：失败派发→产告警事件→告警又被同一失败者消费→再产告警，实测 journal ~5 条/秒净增**永不停止**；挂热点事件（如 usage.recorded）可触发背压溢出（>10000），此后真实事件被持续挤入死信。根因 bus.ts:331-354 无跨事件回授断路 |
| [E-01](qa-report-20260912-group-e-market.md) | 更新 | **「一键回滚」是死路** | `update_apply` 从未登记回滚快照：`lastApplySnapshot` 全仓仅声明/读取/清空 3 处、无写入点；rollback 恒报「无可回滚快照」。selftest「无快照拒绝」断言（scripts/selftest.mjs:2824）因此**空转恒真**。升级失败后管理员只能手工 git reset |

## 三、P2 级缺陷清单（14 项，摘要）

**权限/审批链**
- A-05 自审批：提交人与审批人可为同一账号（skill 面实测 200 通过）
- A-06 六类 L4 审批未标 `riskLevel:'high'`（连接器网关下线/connector.connect/connector.action.admin/mcp.offline/nas.share/panel）——一次 approve 即执行、无二次确认、无终审标记（与 WP-10 口径冲突）
- A-07 OBO 令牌：任意 `agent.write` 可对他人 Agent 发 OBO 令牌，且签发时 scopes 交集在验签时被实时重解析丢弃
- A-08 建账号口令无强度校验：`123` 可建可登（与 resetPassword ≥8 位双口径）
- E-02 market 安装面 `approvedPermissions` 未做 ⊆ requested 校验：实测授予插件从未申请的 `iam.user.frozen`/`usage.admin` 返回 200 入库

**可靠性/集成**
- C-02 死信重投：先清空存储再逐条重发，一条不可重投（丢 `source` 的 `plugin:` 事件必抛错）导致**其余死信永久丢失**——恰是 8908a99 承诺封死的「丢事件=丢证据」
- C-03 总线死信无任何查询/重试 API（对照 usage 管道有完整死信面），运维只能翻 jsonl 文件
- C-04 ODD 非法声明被静默剔除（`activeHours.start=25`、负新鲜度、字符串形态白名单等全部无声消失）——fail-open，配置成功实则约束蒸发
- B-02 渠道组降级链转发上游的请求体缺 `model` 字段（`input` 类型 `Omit<…,'model'>`）——真实 OpenAI 兼容上游下备渠道全链 400，降级链形同虚设
- B-03 `usage_query` 工具 resource 过滤静默失效：向模型/CLI 返回全库数字（实测 128 条/167,335 分 vs 该资源实际 3 条）
- E-03 「镜像失败不静默」事件（connector.policy_mirror_failed / snapshot_drifted）只走总线半程：audit 无订阅、无告警接线、panel SSE 不扇出

**口径/数据**
- B-04 `/api/audit/cost` 的 `days` 参数被路由静默丢弃（plugin-console/src/index.ts:3609）→「近 14 天」实为全量聚合，与工作台趋势口径互相矛盾
- B-05 demo seed 绕过 usage 计量管道直写 `audit:costs` 非零成本（硬编码费率 0.0000015 元/token）——工作台 ¥9.34 全为管道外自造数
- B-06 audit 成本消费取 `charge_cents`（对外应收口径）充当"成本"（plugin-audit/src/index.ts:346）——当前因 charge 恒 0 未爆雷，价格簿一经调非零即以"成本"名义呈现应收金额，M0 禁止的结算语义残留

**前端/工具链（总负责人亲测）**
- G-01 `scripts/check-docs-consistency.mjs:8` 用 `URL.pathname`（百分号编码）直接当文件路径——中文目录（如本仓库路径「元冰可产品」）必现 ENOENT 崩溃，文档一致性检查形同虚设。修复：改用 `fileURLToPath`
- G-02 全局搜索（⌘K）联想结果可出，但点击结果不跳转、回车不跳转，结果列表疑似视觉不可见（DOM 快照有、可见 DOM 无、浮层打开时截图必超时）——待人工复核

## 四、P3 及观察项（约 20 项，择要；全文见分组报告）

口令哈希单轮 SHA-256 无 KDF、多处非常数时间比较；admin 初始口令文件未设 0600（Linux 将 0644）；空 `ADMIN_PASSWORD` 致 admin 永久锁死；`modelgw.degraded`/`budget.warning` 事件零订阅方；rq-card 钱包文案残留（bc2e429 漏网）；总线单订阅者挂起致全总线头阻塞 ~21.5s（量化）；flow skip 唯一 running 步骤后静默停滞；SLA 负值"出生即逾期"；血缘无环检测；指标字典指纹键序敏感致伪口径冲突、仲裁后 supersedes 指针陈旧；SPA 把 `/rq`、`/dsh-bridge/*`、`/auth/entry` 吞成 200 HTML（集成方拿到 HTML 冒充 JSON）；数据集质量分并发 last-write-wins 无版本；自研 YAML 解析器把含冒号无引号序列标量误判为行内映射；dryRun 带 pin 会真实 `git fetch` 外呼；`scenegraph.activate`/`market.submit` 等权限点声明无消费（且 scenegraph.activate 已授予 org_admin）；`app.offline` 的 perm_unused 为 lint 假阳性（host.ts:77 数组授权形态提取盲区）；`meterPromptUse` 幂等键每次随机形同虚设；bus-journal.jsonl 无保留策略；「NAS 存储」与「数据权限」菜单共用一页语义重叠；contract-lint.mjs 无 CLI 入口静默 exit 0（真闸门在 lint-manifests.mjs）。

## 五、验证通过面（真实健康的部分）

- **token 攻防全破**：伪造签名/篡改载荷+原签名/JWT-none/空签名/垃圾/缺失全 401；1 秒短令牌精确过期；**冻结→全部存量令牌即时吊销**（README 宣称兑现，401 携带冻结原因）；解冻不复活旧令牌；refresh 轮转——宽限窗口内重放自愈、窗口外重放→整链吊销+重放检测。
- **a003283 审批冒充封死回归通过**：工具桥走私伪造能力令牌被授权层 denied；令牌仅在执行器闭包内可达（REST/工具面类型与运行时双不可达）；一次性消费+actionId/callerId/30s TTL 三重绑定；审批操作者身份取自令牌不可注入；审计链可完整还原。
- **越权矩阵**：23 端点 × dev/audit/ops 全交叉 403/200 全部与角色语义一致；工具桥有工具级权限点二次校验；PUBLIC_PATHS 17 项匿名探测全 fail-closed。
- **计量管道**：schema v1 十四类非法输入全拒（文案指明修正方式）；幂等重放同键返回同 event_id；保留策略 730d/0/负值三态正确；purge 四角色 403+匿名 401；分级路由 secret→public 拒绝/internal fail-closed；降级链 offline/网络错误/超时三路径按序切换且 manual=true 不造假回复；预算 block 调用前熔断/warn 每日去重；遥测数字手算吻合、ttft 诚实缺列；全出口 charge=0；双投影对账 mismatch=false。
- **总线主干**：journal 逐行 JSON 单调无坏行；重启回放续号；异步串行 FIFO；监听器异常隔离（健康订阅者不受影响）；50/200/800ms 退避重试 4 次入死信；第三方命名空间校验逐字保持。
- **flow/ODD/connect**：状态机矩阵全对+12 路并发竞态零丢更新；模板快照复制语义正确；ODD 判定矩阵 13/13（白名单/排除/新鲜度 fail-closed/时间窗跨零点/多约束叠加）；connect 正式扩展点换装还原、宿主不可达显式抛错绝不静默落本地。
- **市场与契约**：Ed25519 内容篡改/垃圾签名/publisher 冒用/越命名空间全部 400；路由迁移 15 条 method/path/权限点逐一比对一致+24 项端点实测；L0 零价闭环；契约豁免 8 条均为前缀分发提取盲区、无藏违规；output.schema 注册期强校验生效。
- **官方演练**：全链路 27/27 PASS（skill/app/mcp/nas 四资产「登记→审批→上架→授权→调用→回传」3.4s）；早高峰 50 并发领票/兑换/会话 123ms 零失败。
- **GUI**：19 个页面路由全部可达渲染正常；高危审批「意见必填+勾选强制」双闸确为服务端强制（不勾选→「高风险审批需勾选二次确认（服务端强制）」）；错误口令反馈正确；审批通过状态回写 executed；告警中心越权检测规则（阈值 5）在真实压测下正确触发。
- **CLI/Portal**：dshctl 端到端正常（user/role list）；portal 6 个免鉴权端点全 200、可见性留痕有实现。

## 六、修复优先级建议

1. **立即**（安全边界与数据不实）：A-01（sceneCode 接入 panel 任务/消息/flow/agent 直调入口，或对外诚实降级为「规划中」）、A-03、A-04（均为纯服务端补栏）、B-01（聚合 SQL 改 `SUM((SELECT …))` 包裹或 json_each JOIN，已验证可行写法）。
2. **本迭代**（宣称未兑现与可靠性）：A-02（迁移移至种子之后 + selftest 断言改用 developer）、E-01（apply 落库快照 + 让空转断言变真）、C-01（告警事件回授断路）、C-02（重投逐条化+保留 source）、C-03（死信运维面）、A-05/A-06、B-02/B-03/B-04、C-04（ODD 非法声明 400 或告警）。
3. **排期**（P3 与口径）：全部 P3、B-05/B-06（demo seed 经管道造数 + 成本取 cost_cents）、文档口径修正、前端 G-01/G-02。

## 七、测试过程与环境披露

- 静态基线：selftest 1103/1103、lint-manifests（清单 105/105、0 红 9 警 8 豁免）、contract-lint 16/16 单测、lint-timers 13 处 0 违规、check-docs-consistency 在中文路径崩溃（即 G-01）。
- 运行时：演示实例（7301）+ 各组自建隔离实例（7321/7322/7391/7392/7311 等，测完即删）。
- 测试遗留：共享实例测试资源已清理（sec- 用户冻结留证、meter- 资源删除、mkt- 插件卸载、orch- 资源保留、复核改动字段已恢复）。**一处需运维注意**：C 组曾将演示实例连接器网关指向其临时桩（实例已停；重启前建议清理该记录或改配真实网关）。
- 证据数据目录 `data-q3-audit/`（append-only 审计链）随仓库 .gitignore（`data-*/`）不入库，本地保留备查。
