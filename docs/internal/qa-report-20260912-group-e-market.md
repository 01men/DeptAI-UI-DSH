# E 组报告：平台自更新与插件市场契约域（2026-09-12）

> 总报告见 [qa-report-20260912-overview.md](qa-report-20260912-overview.md)
> **测试对象**：plugin-update / plugin-market / 契约与质量闸门脚本
> **基线**：git `2122c2c` ｜ **实例**：http://127.0.0.1:7301（DEMO_SEED=1，未重启未清数据）
> **纪律执行**：全程未执行真实升级、未安装任何第三方包；自建资源均带 `mkt-` 前缀（开发者 `mkt-e-dev01`、插件 `com.mkt-e.probe`，闭环后已卸载）；测试后 `requireSignedCommits` 已复位为 false；所有 token 已脱敏。

---

## 一、缺陷清单

### BUG-E-01（P1）update_apply 从未登记回滚快照，「一键回滚」是死路，selftest 断言空转掩盖
- **根因**：`packages/plugin-update/src/index.ts` 中 `lastApplySnapshot` 全仓仅 3 处——接口声明（:110）、rollback 读取（:426）、rollback 清空（:442）。`applyUpdate` 在 :555 算出 `rollbackTo` 后只回显在响应里，**从不写入 `update:state`**。c8fc22e 原始 diff 即如此（属「未实现而非回归」），但提交信息、manifest api.yaml（`packages/plugin-update/manifest/api.yaml` rollback 行）均宣称「apply 前登记 HEAD 快照」。
- **实际 vs 预期**：预期真实 apply 成功后 `POST /api/update/rollback` 可 reset 回升级前 HEAD；实际任何时刻 rollback 都恒报「无可回滚快照」（本组以 `POST /api/update/rollback {"reason":...}` → HTTP 400 证实该报错路径，未真实 apply 以免拉崩实例）。升级失败后管理员只能手工 git reset——承诺的回滚安全网不存在。
- **掩盖链**：selftest `scripts/selftest.mjs:2824`「无快照拒绝」断言因快照永远不存在而空转恒真。
- **复现**：代码审计 + `grep -rn lastApplySnapshot packages/ scripts/ src/`（3 处命中，无写入点）。

### BUG-E-02（P2）market 安装面 `approvedPermissions` 未做 ⊆ requested 校验
- **根因**：`packages/plugin-market/src/index.ts:393-405` 只校验 `approvedCapabilities ⊆ capabilities_request`，`approvedPermissions` 原样入库；路由 `packages/plugin-console/src/routes/market.ts:108-124` 直接透传 body。
- **复现**（HTTP 200）：
  ```
  POST /api/market/plugins/com.mkt-e.probe/install  (admin)
  {"orgId":"org_…","approvedCapabilities":["knowledgebase.read"],
   "approvedPermissions":["iam.user.frozen","usage.admin"]}
  → 安装记录 permissions=["iam.user.frozen","usage.admin"]（插件仅 requested: [knowledgebase.read]）
  ```
- **实际 vs 预期**：预期越集权限被拒或过滤（与 capabilities 同口径）；实际「企业审批」记录可含插件从未申请的权限点，审批面完整性承诺（requested→approved 收敛）被绕过。当前权限仅记录、未接运行时闸门，故降为 P2。

### BUG-E-03（P2）bc038f0「镜像失败不静默」只做到总线半程，审计中心不可见
- **事实**：`connector.policy_mirror_failed` / `connector.policy_snapshot_drifted` 已在 PlatformEvents（`platform-core/src/bus.ts:43-44`）、事件清单（`plugin-connector/manifest/events.yaml`）、发射点（`plugin-connector/src/index.ts:1034、1344`）三面齐备；但 `packages/plugin-audit/src/index.ts` 只订阅 ConnectorInvoked/GatewayChanged/GatewayUnhealthy/Connected/Disconnected/PermGroupChanged/GatewaySynced——**两条新事件无订阅、无直接 audit.record、无告警中心接线，panel SSE 也不扇出**。对比同文件 `connector.gateway.unhealthy` 有 audit 订阅（events.yaml 明注「audit 订阅」），新事件只存在于瞬时总线（异常路径才进 dead-letter 持久化）。
- **实际 vs 预期**：宣称「镜像失败即告警」；实际审计员在审计中心检索不到任何镜像失败/快照漂移记录，管理者不重启进程就无法感知。fail-closed 本身有效（见通过清单）。

### BUG-E-04（P3）自研 YAML 解析器与标准 YAML 语义漂移：含冒号的无引号序列标量被误判为行内映射
- **根因**：`packages/platform-core/src/yaml.ts:84` 以 `/^[^:]+:\s*/` 判定「行内映射项」，无「冒号后非空格则为普通标量」的例外。标准写法 `- plugin:com.mkt-e.probe:probed` 被解析成 `{plugin:"com.mkt-e.probe:probed"}`，经 `events.emits.map(String)` 变 `"[object Object]"`，命名空间校验拒绝时错误信息为「命名空间：[object Object]」。
- **实测**：首跑 4 个用例全部命中（合法包也无法提交）；加引号后全部通过。fail-closed 方向正确、有引号 workaround，但第三方开发者按标准 YAML 写五面会莫名被拒且报错不可读。

### BUG-E-05（P3）update dryRun 带 pin 时会真实 `git fetch origin --tags --prune`（网络外呼 + .git 引用变更）
- **位置**：`plugin-update/src/index.ts:493-499`（pin 分支在 dryRun 判定之前执行）。
- **实测**：3 次 dryRun(pin=…) 均触发真实 fetch；HEAD 与工作树无变化，无升级风险，但与工具描述「dryRun=true 只预演不执行（不做任何变更）」口径不符。不带 pin 的 dryRun 确认零副作用。

### BUG-E-06（P3）权限点卫生：`scenegraph.activate` 已授予 org_admin 却无任何闸门消费
- `plugin-iam/src/index.ts:302` 把 `scenegraph.activate` 授予 org_admin 内置角色，但全平台无路由/工具校验它（scenegraph 面实际用 `scenegraph.read` + `panel.config.write`，见 `plugin-panel-core/src/index.ts:536、543`）——授予即误导 RBAC 运营。`market.submit`、`connector.market.publish`（目录标注 M3 预留）声明无引用，属预留欠账需登记销账条件。另 `app.offline` 的 perm_unused 警告是 **lint 假阳性**：它在 `plugin-connect/src/host.ts:77` operator 模板数组中被真实授予，linter 不识别数组形态授权字面量。

### P3 备忘（不单列编号）
- `meterPromptUse` 幂等键 `plugin-use:${newId('pu')}` 每次随机（`plugin-market/src/index.ts:477`），幂等形同虚设，重试即重复计量。
- 开发者口令哈希为单轮 `sha256(salt:password)` 无 KDF（`plugin-market/src/index.ts:280`），独立身份域风险有限。
- pin 允许分支名（可变目标，弱钉扎）；win32 下 `runNpm` 经 shell 调用（`git.ts:74`，参数为常量，风险低）；`verify-commit` 依赖本机 gpg，未装时 `signatureVerified` 恒 false（默认不阻断但如实透出，实测吻合）。
- 敏感键掩码只处理标量值，敏感键名为对象时整体透传（`platform-core/src/sensitive.ts:37`）；`scanSensitiveKeys` 与 `maskSensitivePayload` 判定谓词一致，**不存在**「扫到但没掩掉」的存储绕过（已专程核对 createApproval 的 `...input` 展开次序，`plugin-audit/src/index.ts:596-605`）。
- `node scripts/contract-lint.mjs` 直接运行是**无 CLI 入口的库**，静默 exit 0——「跑过=通过」是错觉，真闸门在 `lint-manifests.mjs`。建议加 CLI 主入口防误用。

## 二、待确认
- 实例工作区存在先于本组测试的 `M package-lock.json`（本组操作均无工作树写入；fetch 不触工作树）。若真实执行 apply，脏工作树大概率被 `merge --ff-only` 安全拒绝——此为保护行为，但环境本身不洁值得运维关注。
- `data-selftest/` 为官方 selftest 自管理目录（每次运行自清重建），保持运行后状态，未手工删除。

## 三、验证通过清单

**c8fc22e update_apply 校验面（全部实测通过）**
1. dev/ops/audit 经 REST 与 `/api/tools/execute` 双路径越权 apply/check → 403（角色确无 `platform.update.*`）。
2. 正式执行缺 pin → 400「禁止裸拉 main 最新」（REST 与工具路径各验一次，工具路径 isError 正确回传）。
3. pin=不存在引用 / 末位篡改的 commit sha → 400「pin 目标无法解析」（execFile 传参无 shell 注入面）。
4. `requireSignedCommits=true` + pin=HEAD（本地 `%G?=N` 未签名）→ 400「签名校验未通过」；复位 false 后 dryRun 如实透出 `signatureVerified:false + signatureNote`；设置已复位。
5. dryRun 无 pin → 200，pin 字段注明「正式执行必须 pin」，透出 requireSignedCommits/steps，零副作用。
6. 回滚无快照/缺 reason → 400（该路径本身逻辑正确，死因见 BUG-E-01）。

**bc038f0 TOCTOU**
7. 代码评审：5 处 `catch(() => undefined)` 清零为 `mirrorTokenPolicySafe/handleMirrorFailure`；执行侧双哈希比对（授权时刻 vs 取令牌后 fresh+ledger）实现正确；401 恢复路径镜像失败不再带旧授权面重试。
8. selftest 5 断言（stub PUT 500 确定性注入）实测全绿：旧令牌立即吊销 / 组级 fail-closed 拒绝 / 快照漂移执行侧拒绝 / 收敛恢复 / 基线。事件三面声明齐备（但审计断链见 BUG-E-03）。

**2122c2c market 路由迁移回归**
9. 迁移前后 15 条路由（2 公开 + 13 guarded）method/path/权限点逐一比对完全一致；`registerMarketRoutes` 已装配（`plugin-console/src/index.ts:3949`），helpers 经依赖注入。
10. 逐端点实测 24 项：plugins/submissions/installed/prompts/mine 列表 200；sandbox-check 五项边界断言全部 fail-closed 正确；install/uninstall/approve/reject/prompts-use 的 7 条错误路径语义完好；hr 无 market.read → 403；开发者令牌越权 install → 403；重复安装/重复版本 → 400。

**Ed25519 验签与 L0 计量**
11. 合法签名提交 200；内容篡改+原签名 → 400 验签失败；垃圾签名 → 400；publisher 冒用 → 400；emits 越命名空间 → 400；版本不可变 → 400。
12. L0 零价闭环：approve → install → 价格簿 `plugin:com.mkt-e.probe` `list=0/cost=0` → prompts/use 计量事件（meters.value=1）→ org totals `charge_cents=0` → 卸载后 prompts 面空、再计量被拒。

**9b326ec 契约面**
13. 真闸门 `node scripts/lint-manifests.mjs`：清单 105/105、场景图谱 2/2、契约比对 0 红 9 警 8 豁免、工具面 83/83、定时器卫生 0 违规、EXIT=0。
14. 豁免名单审查：仅 8 条 endpoint_ghost（GET /api/portal*），理由真实（单 handler 前缀分发无法字面量提取），实测 7/8 路由真实存活（200/401）、第 8 条 `/skills/:*/download` 401 路由在；销账条件明确。**未发现借豁免藏违规**。
15. lint 引擎非造假：`contract-lint.test.mjs` 16/16 构造性红/绿断言通过（含幽灵 endpoint、双向工具、权限点、豁免透明降级）。
16. output.schema 强校验落在 `ToolRuntimeLite.register`（`tools-lite.ts:78-80`），`ctx.tools` 即该单例，全部注册路径均被强制；随包单测 4 例通过。注意其强度是「非空对象根存在性」而非 JSON Schema 语义校验。

**616e83d P95 质量闸门**
17. 闸门实为 `scripts/selftest.mjs:3998-4018`（n=20，阈值键可覆盖），自建 7311 隔离实例 + 独立 data 目录 + stub 上游，不触碰演示实例。
18. 正向：默认阈值 1103/1103 全绿 exit 0（登录 P50=4/P95=6ms，invoke P50=9/P95=11ms），4 类故障注入断言全绿。
19. **负向对照（防恒绿）**：`P95_GATE_LOGIN_MS=1 P95_GATE_INVOKE_MS=1` → 两条 P95 断言变红（p95=4ms/12ms）、1101/1103、**exit=1**。断言真实有效。CI 已入 `.github/workflows/selftest.yml`。

## 四、lint-manifests 9 条警告逐条评估

| 警告 | 评估 |
|---|---|
| manifest_missing × platform-core | 合理——内核库特殊形态，无 REST/工具注册面主体 |
| manifest_missing × plugin-dsh-bridge | 合理——注册在 dsh 宿主 webServer（非平台 httpServer），平台契约面之外 |
| manifest_missing × plugin-rq-card | 合理——纯 UI 表面插件，宿主半刻意零注册（源码头注明的既定模式）；建议 linter 白名单化 |
| perm_unused × app.offline | **假阳性**——经 connect 模板数组真实授予（host.ts:77），linter 提取盲区 |
| perm_unused × scenegraph.activate | 真欠账且已授予 org_admin，无闸门（BUG-E-06） |
| perm_unused × market.submit | 真死点——提交实际走开发者 scope `market.developer`；预留应写销账条件 |
| perm_unused × connector.market.publish | 真死点，目录已注明「M3 业务触发启动」预留 |
| public_path_undeclared × /api/panel/auth/login\|refresh | 合理——4b090c6 先行登记，实测两键 404「零路由命中零行为」与登记口径一致 |

## 五、结论

本批次五个提交中，bc038f0（TOCTOU）、2122c2c（路由迁移）、9b326ec（契约面）质量扎实、回归无破坏；616e83d 的 P95 闸门经正反双向实测为真断言。**c8fc22e 存在 P1 级「宣传与实现脱节」：宣称的回滚锚点从未落库（BUG-E-01），且被空转的 selftest 断言掩护**；market 安装面权限超集校验缺口（BUG-E-02）与镜像失败审计断链（BUG-E-03）建议随下批修复。
