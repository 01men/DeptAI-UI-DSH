# E 组报告：更新与市场契约域回归（2026-10-13）

> 测试对象：plugin-market / plugin-update / console routes 拆分域（apps/audit/usage/ops/bridge）/ 契约闸门
> 实例：http://127.0.0.1:7344（DEMO_SEED=1，data-qa-ge，独占）｜基线：REFACTOR-2026-10-13 后，selftest 1201/1201
> 纪律：全程零真实升级（未跑带 pin 的 dryRun/apply）、零外呼（本地 stub 端口 21441）、未修改仓库文件；自建资源均 `geqa*` 前缀并已退场（插件卸载、权限组删除、网关走 L4 审批下线）。
> 上轮报告：docs/internal/qa-report-20260912-group-e-market.md（E-01 P1 / E-02~E-06 P2~P3）；修复说明：docs/internal/release-notes-2026-09-12-qa-fixes.md、release-notes-2026-09-13-qa-fixes.md。

---

## 一、结论速览

| 项 | 用例 | 通过 | 结论 |
|---|---|---|---|
| 1 市场签名四连击 | 6 | 6 | 全部 400 且文案明确（含对照 200）；E-04 YAML 缺陷仍在 |
| 2 E-02 回归（approvedPermissions ⊆ requested） | 4 | 4 | **已修复**，双向探针+selftest 断言齐备 |
| 3 路由契约（重构最大风险点） | 16 路由 × 4 维 | 全部 | method/path/权限点三面一致，336 条矩阵登记 |
| 4 L0 零价闭环 | 7 | 7 | 全程 charge=0 无歧义；幂等键缺陷仍在（P3 遗留） |
| 5 E-01 回归（一键回滚） | 4 | 4（深度受限） | 写入点已落地；闭环无法在不外呼前提下实测，如实说明 |
| 6 E-03 回归（镜像失败事件） | 9 | 6+3 静态 | mirror_failed 三面（audit/告警/SSE）实测全通；drifted 静态验证 |
| 7 lint:manifests 豁免审查 | 8 豁免 + 9 警告 | 全部核对 | 无借豁免藏违规 |
| 8 output.schema 注册期强校验 | 4 单测 | 4 | 校验在 register 单例强制，注册路径全覆盖 |
| 9 更新检查面 | 4 | 4 | 结构健康、502 优雅失败、AUTO_CHECK 关闭生效 |

**本轮新发现 P1/P2：0 个。** P3 均为上轮已登记未排期遗留（E-04/E-05/E-06、幂等键），另有 2 条新 P3 观察。

---

## 二、缺陷与遗留清单

### 本轮新观察（P3）
- **NEW-E-01（P3 观察）插件 id 命名空间不与开发者身份绑定**：`parseManifest` 只校验 id 格式（`packages/plugin-market/src/index.ts:146`），任何开发者可提交 `com.<任意品牌>.xxx`（如冒认大厂命名空间），publisher 只要求等于提交者本人。审批闸（market.approve）是唯一缓解。建议：id 首段与开发者账号绑定或审批时人工核查命名空间归属。
- **NEW-E-02（P3 观察）路由参数段跨方法回落**：`DELETE /api/apps/developer-options` 落入 `DELETE /api/apps/:id`（"应用不存在：developer-options"，400 而非路由 404）。静态段与参数段仅同方法内有优先级；app id 为 `app_*` 生成值，实际无害，登记备查（router 语义：`platform-core/src/http.ts`）。
- 测试残留（本实例内）：`PUT /api/usage/price-book` 实活探针写入 `geqa:x` 零价条目一条（路由契约 admin 实活验证的副产品，无 DELETE 端点可清除，价格 0 无计费影响）。

### 上轮 P3 遗留核验（本轮逐一复核，均未修复、未列入修复批次）
- **E-04（P3）自研 YAML 误判含冒号序列标量**：复测 `- plugin:com.geqa.probe:probed`（无引号）仍报「命名空间：[object Object]」。根因未动：`packages/platform-core/src/yaml.ts:84` 行内映射判定无「冒号后非空格」例外。fail-closed 方向不变，加引号可绕过。
- **E-05（P3）update dryRun 带 pin 真实 git fetch**：静态复核 `packages/plugin-update/src/index.ts:573-579`——fetch 在 dryRun 分支判定之前执行，口径仍与「dryRun 不做任何变更」不符。按纪律未实测。
- **E-06（P3）权限点卫生**：`scenegraph.activate` 仍授予 org_admin（`plugin-iam/src/index.ts:317`）且全平台无闸门消费；`market.submit`、`connector.market.publish` 仍为死点；`app.offline` lint 假阳性未修（真实授予在 `plugin-connect/src/host.ts:77` 数组形态，linter 盲区）。
- **计量幂等键（P3 备忘）**：`meterPromptUse` 幂等键仍为 `plugin-use:${newId('pu')}` 每次随机（`packages/plugin-market/src/index.ts:464`），重试即重复计量。

---

## 三、上轮 E 组缺陷修复回归（重点）

### E-01（P1「一键回滚死路」）— 修复落地 ✅（验证深度受限，如实说明）
- **静态**：`applyUpdate` 在 `git merge --ff-only` 成功后、npm install 之前写库快照（`packages/plugin-update/src/index.ts:653-660`）——依赖同步失败也保留回退锚点，顺序正确。全仓 grep 现有 4 处命中（声明/读/清/写），写入点唯一。
- **数据层**：`data-qa-ge/update~state.json` 当前无 lastApplySnapshot 字段（本进程未 apply 过，与语义一致）。
- **API 层**：`POST /api/update/rollback {"reason":...}` → 400「无可回滚快照：本进程尚未执行过带 pin 的升级（OPT-P2-03）」——守卫路径完好（实测）。
- **闭环实测不可行的原因**：apply 带 pin 第一步即真实 `git fetch origin`（:575），成功后 rollback 执行 `git reset --hard`（:495）——前者外呼、后者会改写仓库工作树，均在禁令内。**验证深度：静态 + 数据层 + API 守卫三层；正向 apply→snapshot→rollback 闭环未实测。**
- **selftest 断言核查**（任务专项）：`scripts/selftest.mjs:2999-3001`「无可回滚快照被拒」断言文本未变，仍是纯负向断言（fresh 实例上 rollback 必拒）；selftest/tests 全仓**不存在**正向快照登记断言（无法在自测环境跑真 apply）。结论：该断言不再「掩护死路」（写入点已真实存在），但**仍无法自动捕捉「写入点被回归删除」**——建议在 selftest 中以进程内单测形态（mock runGit）补一条 applyUpdate→state.lastApplySnapshot 断言。

### E-02（P2 越集权限安装）— 修复落地 ✅（实测）
- 越集：`approvedPermissions:["iam.user.frozen","usage.admin"]` → 400「权限点 iam.user.frozen 不在插件申请清单内（approved ⊆ requested，QA E-02）」（修复代码 `packages/plugin-market/src/index.ts:378-384`，路由 `plugin-console/src/routes/market.ts:99-115` 透传前经服务层校验）。
- 能力面原有口径保持：越集 capability → 400；子集 permissions → 200 且入库 permissions 与审批值一致。
- selftest 双探针在位：`scripts/selftest.mjs:1423-1425`。

### E-03（P2 镜像失败事件只走总线半程）— 修复落地 ✅（mirror_failed 三面实测；drifted 静态）
- 实测方法：本地 stub OC 网关（127.0.0.1:21441，四数组契约/令牌铸造/执行面齐全）+ `PUT /api/connector/gateway` 装配 + 权限组建组触发镜像。
- **实测全通（mirror_failed）**：① audit 留痕 `connector.policy_mirror_failed`（`plugin-audit/src/index.ts:257-271` 订阅）；② 告警中心 critical「[连接器] 权限组策略镜像失败」（`fire()` 接线 ：265-270）；③ panel SSE 扇出事件可见（`plugin-panel-core/src/service.ts:910`，SSE 经 `/api/panel/stream?dept=rd&token=` 实收 `connector.policy_mirror_failed` 帧）。
- **静态验证（snapshot_drifted）**：同一接线块内完备——audit 订阅+warning 告警（`plugin-audit/src/index.ts:272-286`）、SSE 扇出（`service.ts:911`）、发射点（`plugin-connector/src/index.ts:1355`）。**运行时未触发原因**：本实例未设 `OOMOL_CONNECT_ENCRYPTION_KEY`，网关数据面 fail-closed（`plugin-connector/src/index.ts:320-321`，属正确保护行为），invoke 到不了漂移校验点（:1348-1357）；selftest 以 drift-on-mint 钩子覆盖该路径（selftest.mjs:4320-4330）。
- 附带发现：镜像失败经由 env 门禁触发时同样完整走 handleMirrorFailure→事件三面（fail-closed 可观测性成立）；旧令牌吊销（DELETE stub）在该故障形态下不涉及（client 构造前即抛错），该 TOCTOU 行为由 selftest stub 断言覆盖（selftest.mjs:4311-4319）。

---

## 四、分项实测明细

### 1. 市场签名四连击（全部 400 且文案明确）
| # | 攻击 | 结果 | 响应文案 |
|---|---|---|---|
| A0 | 合法提交（对照） | 200 | —（ Ed25519 注册→登录→签名→提交全链通） |
| A1 | 内容篡改+原签名 | 400 | 签名验签失败：五面指纹与发布者公钥签名不匹配 |
| A2 | 垃圾签名 | 400 | 同上 |
| A3 | publisher 冒用（署名 platform-official，本人 geqa01 提交） | 400 | plugin.yaml publisher 必须为提交者账号（geqa01），收到 platform-official |
| A4 | 越命名空间 emits（iam.user.frozen） | 400 | events.yaml 发射事件必须收敛在 plugin:com.geqa.probe: 命名空间 |
| A5 | E-04 回归：无引号含冒号序列标量 | 400 | 命名空间：[object Object]（**E-04 未修**，见上） |

签名基建：`packages/plugin-market/src/index.ts:298-327`（submit：publisher 校验→指纹验签→版本不可变→命名空间收敛）；指纹算法 `fingerprintOf`（:114-119，排序键 `key\ncontent` sha256）；Ed25519 复用 `platform-core/src/signature.ts`。

### 2. 路由契约（16 条，重构后 routes/*.ts 承接域）
抽样覆盖：apps.ts×5（GET/POST/PATCH /api/apps、developer-options、transition）、audit.ts×3（logs、alert-rules POST、timeline）、usage.ts×3（report/monthly、modelgw/models、approvals decide）、ops.ts×4（usage/totals、price-book PUT、bus/dead-letters/retry）、bridge.ts×2（tools/execute、platform/info，另 +market 域 15 条在本轮第 1/4 项全覆盖）。
每条四维验证：① 代码注册（guarded 'perm'）② `/api/platform/route-matrix` 登记（method/path/permission 逐字一致，共 336 条 guarded）③ admin 实活非 404/非 403 ④ 无权限角色 403 且文案点名权限点（dev 缺 audit.read/usage.admin/modelgw.read；auditor 缺 app.write/usage.read）。**15+1 条全部三面一致。**
- 15 个域路由文件全部装配：`plugin-console/src/index.ts:203-229`（apps:216 / audit:217 / ops:218 / usage:219 / bridge:220 / market:223）。
- dev 对 `/api/audit/timeline`（panel.read）200 属正确：`BUILTIN_ROLE_MIGRATION` 给 developer 补了 panel.read（`plugin-iam/src/index.ts:311`），非越权。

### 3. L0 零价闭环（零计费歧义）
上架（approve）→安装（admin 审批 permissions=['connector.invoke']）→价格簿自动登记 `plugin:com.geqa.probe2` list=0/cost=0/tax 0.06（`plugin-market/src/index.ts:402-414`）→`POST /api/market/prompts/use` metered=true→usage 事件含 meter key `geqa_probe2_calls` 且 charge_cents=0→组织 totals charge_cents=0（cost 侧不含插件计量）→卸载后再计量 400「未在组织安装」。全程无任何非零价或计费口径分叉。

### 4. lint:manifests 豁免名单审查（无藏违规）
`npm run lint:manifests` EXIT=0：清单 105/105、场景图谱 2/2、工具 83/83、路由比对代码 369/清单 385、0 红 9 警 8 豁免、定时器卫生 0 违规。
- **8 条 endpoint_ghost 全部为 `/api/portal*`**（`scripts/contract-lint.exemptions.json`）：理由真实（portal 单 handler 前缀分发，`plugin-portal/src/index.ts:27,207,228,260`，PORTAL_API_PREFIX 可配无字面量可提取），销账条件明确。**逐条实活：7×200 + `/skills/:*/download` 401（路由在，鉴权拦）——8/8 存活，与上轮一致。**
- 9 条警告评估：manifest_missing×3（platform-core/dsh-bridge/rq-card，与上轮同，合理）；perm_unused×4（app.offline 为 linter 假阳性 host.ts:77；scenegraph.activate/market.submit/connector.market.publish 为已知死点欠账=E-06）；public_path_undeclared×2（panel/auth/login|refresh 先行登记，与登记口径一致）。

### 5. output.schema 注册期强校验
`ToolRuntimeLite.register`（`platform-core/src/tools-lite.ts:88-90`）：output.schema 为 undefined/null/非对象/数组一律 TypeError「必须声明 output.schema（非空对象根，JSON Schema）」。全部工具注册路径（boot 期 10+ 插件）均经该单例，无旁路；平台无 HTTP 运行时工具注册端点（API 层负向用例不适用）。随包单测 4/4 通过（`tools-lite.test.mjs`：缺 schema/null/数组/defineTool 兜底）。注意口径仍为「非空对象根存在性」，非 JSON Schema 语义校验（与上轮结论一致，未变）。

### 6. 更新检查面（不真升级）
- `GET /api/update/status`：结构完整（currentVersion=1.1.0/installMode=source/repo/localCommit/latest=null/hasUpdate/updateKind/behindBy/recentCommits/lastCheckedAt/canApply），`autoCheck:false` 证明 `DSH_UPDATE_AUTO_CHECK` 关闭生效。
- `POST /api/update/check`（手动）：上游不可达时 502 `UPSTREAM_ERROR`「版本获取失败：fetch failed；提交对比失败：HTTP 404」——优雅失败、无挂起、无半写状态。版本比对/提交差字段的正向语义由 selftest stub 上游覆盖（selftest.mjs:2971-2977：latest 9.9.9、behindBy=2、recentCommits[0].sha、429 冷却）。
- 匿名 401、hr 无 platform.update.apply 403（selftest 覆盖，本轮抽查 status 匿名 401 一致）。

---

## 五、通过面（一句话）
重构后市场签名五面验签、E-02 权限收敛、L0 零价计量、路由契约三面一致性（336 条登记）全部回归通过，E-01 回滚锚点写入与 E-03 镜像失败事件三面接线修复均真实落地；E 域本轮零新增 P1/P2，遗留项全部为上轮已登记 P3（E-04/E-05/E-06、计量幂等键）外加 2 条新 P3 观察（插件 id 命名空间归属、路由参数段跨方法回落）。

## 六、复现命令索引（关键）
```bash
# 令牌
curl -s -X POST http://127.0.0.1:7344/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Ybk@2026"}'
# 市场四连击 + E-02 + L0（完整脚本）
node /tmp/ge-market.mjs && node /tmp/ge-market2.mjs
# 路由契约 16 条四维
node /tmp/ge-routes.mjs
# E-03 stub + 三面实测
node /tmp/ge-e03.mjs
# E-01 静态/数据层/守卫
grep -n lastApplySnapshot packages/plugin-update/src/index.ts   # 4 处，写入点 :656-660
cat data-qa-ge/update~state.json                                # 无快照字段（未 apply）
curl -s -X POST http://127.0.0.1:7344/api/update/rollback -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"reason":"x"}'  # 400 无可回滚快照
# 豁免审查
npm run lint:manifests && cat scripts/contract-lint.exemptions.json
# output.schema
node --test packages/platform-core/src/tools-lite.test.mjs
```
