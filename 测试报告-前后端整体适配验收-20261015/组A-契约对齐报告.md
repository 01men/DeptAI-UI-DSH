# 前后端 API 契约静态对齐审查报告（测试组A · 契约对齐组）

- 日期：2026-10-15
- 仓库：/Users/ybkk/Documents/元冰可可产品/ybkkasi（只读分析，未改任何源码；临时脚本均在 /tmp/qa-a/）
- 被测实例：http://127.0.0.1:7301（admin token 实测验证；未触碰 7300 与 7301 进程本身）
- 方法：脚本枚举（/tmp/qa-a/extract-frontend.mjs、extract-backend.mjs、expand-templates.mjs、compare.mjs、payload-diff.mjs、runtime-diff.mjs）+ 人工核对 + 真机 curl 验证

## 一、覆盖面（覆盖率 100% / 100%）

| 维度 | 数量 | 说明 |
|---|---|---|
| 前端扫描文件 | 46 个 .js（32 个含调用点） | packages/plugin-console/public/js 全量（pages/ 25 页 + iam/ 子页 + components/ + 根模块），排除 *.test.mjs |
| 前端 API 调用点 | 375 | api.get/post/put/patch/delete 366 处 + 裸 fetch 9 处（api.js 豁免边界 8 处 + oauth.js 协议页 1 处；oauth rawJson 包装展开为 9 个调用点） |
| 前端归一化唯一 (方法,路径) | 239 | 模板串 `${...}` 归一为 `:id`；4 处表达式调用点与 oauth rawJson 逐个人工解析（connectors.js:530/685、login.js:251、nas-authz.js:650、oauth.js rawJson×9） |
| 后端路由注册 | 445 行注册（含 10 条模板循环展开） | guarded() 396 + http.register() 等；扫 packages/*/src 全部 .ts（plugin-console/routes 19 文件 + plugin-connect/exec-hub/flow-core/iam/panel-core/dingtalk-bridge/workforce/update/authn/platform-core） |
| 后端唯一 /api (方法,路径) | 430 | 静态提取 = 运行时 /api/platform/route-matrix 逐条完全一致（430=430，零差异，含 25 个 public、9 个 authenticated） |
| 比对结果 | MATCH 380 个调用点实例 / 239 唯一路径全部命中 | NO_ROUTE 2（/dsh-bridge/*，见缺陷 D3 核实为非缺陷）；METHOD_MISMATCH 0；SHAPE_MISMATCH 0 |
| 响应字段抽查页面 | 14 个（要求 8 个，超额完成） | dashboard、usage、gateway、assets、iam(members/roles/groups/connectors/conflicts)、agents、skills、exec + approvals、audit、finops、access/authn、nas/nas-authz、mcp、connectors |
| 请求体契约抽查 | 130 对（前端 payload vs 后端 body<{...}> 声明） | 关键字段全部一致（如 exec goals/issues/projects、agents、skills package、mcp/nas import、modelgw models） |
| 查询参数契约 | 前端 22 个参数键 vs 后端 query.get 68 键 | 仅 1 处死参数（见 D1） |
| 页面注册 | pages/ 25 个模块 | 全部有入口：22 个进 app.js builders，login/home 独立形态，oauth 走 oauthBuilders；#/connect 为保书签的薄重定向——**无孤儿页面** |

## 二、缺陷清单

| 编号 | 级别 | 前端调用点 | 后端现状 | 实测证据（7301） | 建议 |
|---|---|---|---|---|---|
| D1 | P2 | pages/dashboard.js:855 `api.get('/api/approvals?status=pending')`（另 approvals 页同参语义） | routes/usage.ts:221 `GET /api/approvals` 只按组织子树过滤，**完全不读取 status 查询参数**，恒返回全部状态（pending/executed/rejected） | `curl '/api/approvals?status=pending'` → 返回 `[pending, executed, rejected]`；`?status=todo` 对照组（/api/exec/issues?status=todo）则正确过滤，证明是本 handler 独有缺陷 | 后端补 `status` 过滤，或删前端死参数；当前前端自行 `.filter(item.status==='pending')` 兜底故无用户可见故障，但任何依赖服务端过滤的新调用方都会踩坑 |
| D2 | P2 | pages/dashboard.js:283/933 `extractValueSeries(goalsData)`：消费 `goalsData.value ?? .valueSeries ?? .valueTrend`（dashboard「价值兑现」双序列卡） | plugin-exec-hub GET /api/exec/goals（exec-hub/src/index.ts:1557）返回的 SkillRecord… GoalRecord 仅有 metric/metricBaseline/metricTarget 等，**全仓库后端无任何 value/valueSeries/valueTrend 字段** | curl /api/exec/goals → goal[0] 22 个键中无 value*；`grep -rn "valueSeries\|valueTrend" packages/plugin-exec-hub` 零命中 | 该卡永远走空态分支。且空态文案指路「在执行中枢为目标登记价值口径」，但 exec 页目标表单（exec.js:330-339）无此入口——属前后端规划半成品，需对齐：要么后端补价值序列，要么下线该卡/改文案 |
| D3 | 非缺陷（核实记录） | api.js:148/168 裸 fetch `GET /dsh-bridge/status`、`POST /dsh-bridge/session` | 该两路由仅注册于 dsh 宿主挂载形态的 webServer prefix handler（plugin-dsh-bridge/src/index.ts:397 prefix `/dsh-bridge`），独立形态（如 7301）无此路由 | `curl /dsh-bridge/status` → 404 NOT_FOUND；但 api.js 对 `!response.ok` 显式返回 null 并静默跳过（api.js:144-155 注释「独立形态 404/异常 → 返回 null」），设计内行为 | 无需修复；建议保留注释现状 |

## 三、抽查通过项（抽样证据）

- 路由级 404 基线：`GET /api/definitely/not-a-route` → `{404, NOT_FOUND, "路由不存在：…"}`；`DELETE /api/health` → 404（平台对未注册方法同样 404，无 405 语义）——静态 METHOD_MISMATCH=0 与真机一致。
- 多段动态路由存在性实证（业务错误证明 handler 已执行，非路由缺失）：`DELETE /api/iam/users/u_x/bindings/ldap`→400 账号不存在；`POST /api/agents/agt_x/sso-client/rotate`→400 Agent不存在；`POST /api/nas/nas_x/fs/share-links/jti_x/revoke`→404 SHARE_LINK_NOT_FOUND；`GET /api/nas/nas_x/fs`→400 NAS 资产不存在；`POST /api/iam/users/u_x/freeze`→400；`POST /api/audit/alerts/xxx/read`→400；`GET /api/modelgw/no-such-slug/telemetry`→404 模型不存在（业务 404）。
- 8+ 页面响应字段逐项比对（前端解构字段 vs 真机返回键）：dashboard（overview 11 键含 costTrend[].key/llmTokens/costYuan、mcp.p95Latency/unhealthyServices、insight.text/exceptions[].name/level/chain/owner、alerts[].title/severity/message/createdAt 全部存在）；usage（series[].date/tokens/cost、byOrg[].org/share/delta、topAssets[].name/cost/calls、unitDau[].costPerDau）；gateway（models[].slug/status、routes-usage.routes[].model/tokens30d/share/cost30d、telemetry.invocations/degradedInvocations、channel-groups[].chain）；assets（fleet/ledger items[].trend/calls30d、inventory/report/benefit/retire-reasons 全键）；iam（users[].orgName/lastLoginAt/status、orgs/tree、roles+permissions catalog、conflicts、connectors providers/configs、groups[].resolvedMembers）；agents（list boundUserCount 与 detail boundUsers 双形态经查与前端使用位置一致；create 返回 {agent,credential}）；skills（stats.rating/ratingCount、heat、usage-heatmap skills[].cells、PUT package 返回顶层 {skill,package} 与前端 result.package?.sizeBytes 一致）；exec（goals/issues[].blockerIds/priority、projects[].issueProgress、wakes/routines、lineage）。update.js（status 21 键全对齐）、access/authn、nas/nas-authz（decisions items[].paths/reasons、rules/share-link-policy）、mcp（calls items、services[].health/stability/tools）、connectors（catalog kind/limit 语义正确：kind=providers 时 actions 置空）。
- 请求体契约：exec goals/issues/projects/routines、agents create/patch/transition/onboarding、sso-client create/patch/enable/disable/rotate（reason）、authn principals/oidc、modelgw models（dataClassLimit）、mcp/nas import（config）、skills package（packageBase64）等 130 对，前端发送键 ⊆ 后端声明键，必填键（name/title/action 等）前端均强制校验后提交。
- 查询参数：除 D1 外全部被后端真实读取并生效（limit/days/dim/month/window/windowDays/kind/service/search/unread/status(exec)/q 等真机验证行为正确）。

## 四、结论

**前后端 REST 契约适配完整度非常高**：239 个前端唯一调用路径 100% 命中后端 430 条注册路由（静态提取与运行时 route-matrix 完全一致），方法不匹配 0、动态段形状不匹配 0、请求体与响应字段抽查未发现硬性不一致；仅存在 2 个 P2 级软性契约瑕疵（approvals 的 status 死参数、exec goals 价值序列字段后端从未返回）与 1 项已核实的设计内 404（dsh-bridge 独立形态）。

**计数：P0 = 0，P1 = 0，P2 = 2**（另有 1 项核实为非缺陷的记录 D3）。
