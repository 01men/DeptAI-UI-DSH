# A 组测试报告：安全与权限域（2026-10-13，REFACTOR 后回归 + 上轮缺陷复核）

> 测试对象：http://127.0.0.1:7341（DEMO_SEED=1，独立数据目录 data-qa-ga，本组独占）
> 代码基线：dsh-enterprise-ops v1.1.0（REFACTOR-2026-10-13 后，console 路由拆分至 packages/plugin-console/src/routes/ 15 域文件；selftest 1201/1201）
> 上轮参照：docs/internal/qa-report-20260912-group-a-security.md（BUG-A-01～A-10）+ release-notes 2026-09-12 / 09-13 / 09-15（approval-relax）
> 方法：黑盒 HTTP（curl/node fetch）+ 源码定位根因（只读，未改仓库任何文件）；破坏性操作全部使用自建 sec-* 账号

---

## 一、结论概览

- **用例总计 ≈220 条 HTTP 断言，通过 ≈217，失败 3**（同根因：工具桥组织隔离旁路，见 N1）。
- **P1 × 1、P2 × 0、P3 × 4**。未发现 P0。
- 上轮 A 组 8 项可复核缺陷：**A-03/A-04/A-06/A-07/A-08 确认已修复**（全部 live 复现验证）；**A-01 部分修复**（flow 域闭环、panel 任务/消息入口按 release note 诚实延期）；**A-05 已按 2026-09-15 业务决策（APR-05）放宽为允许自审**（非缺陷，行为与最新口径一致）；A-02/A-09/A-10 属 B 组/排期项未列入本轮复测。
- **最重要的新发现（N1，P1）**：REST 面修复的组织隔离（A-03）可经工具桥 /api/tools/execute 完整绕过——org_admin 可跨组织建号/冻结/重置口令。

---

## 二、缺陷清单（本轮新发现）

### N1（P1）工具桥 iam_* 工具未传 manageActor——A-03 组织隔离被完整绕过（跨组织建号/冻结/重置口令全部成功）
- **复现**（live，hr=产品运营部 org_admin）：
  1. `POST /api/tools/execute {"name":"iam_user_create","args":{"username":"sec-toolbypass","displayName":"工具面跨组织","orgId":"org_mv6jouatb1cnpa49(市场部)","password":"Tool@2026x"}}` → **200，市场部账号创建成功**（usr_mv6kf48rb2y5ofl3）
  2. 同口令 `{"name":"iam_user_freeze","args":{"userId":"usr_mv6jqrtqb2jlzkbo"(dd0008,市场部),"reason":"QA"}}` → **200，dd0008 被冻结**（联动吊销其全部令牌）
  3. `{"name":"iam_user_reset_password","args":{"userId":"usr_mv6jqrtqb2jlzkbo"}}` → **200，响应含新初始口令明文**
  - 对照：同账号同三操作走 REST 面（POST/PATCH /api/iam/users/...）全部被拒（见 T5，400 组织隔离）。
- **期望**：与 REST 面一致拒绝（org_admin 只能管理本组织子树）。
- **根因**：
  - `packages/plugin-iam/src/tools.ts:106`（createUser 只传 args 不传 actor）、`tools.ts:120`（resetPassword(args.userId) 无 actor）、`tools.ts:135`（freezeUser(args.userId, args.reason) 无 actor）；
  - 服务层 `packages/plugin-iam/src/index.ts:1078-1082` `assertManageScope` 首行 `if (!actor) return` ——actor 缺省即跳过组织校验（fail-open），与注释宣称的「无法定位归属者 fail-closed 拒绝」不符（REST 面全部显式传 manageActor，工具面无人传）；
  - 桥接层 `packages/plugin-console/src/routes/bridge.ts:62-77` `injectToolIdentity` 白名单不含 iam_user_*（approver/requester/actor 注入仅覆盖审批/agent/skill 类工具）。
  - 同一执行路径也暴露于 `/mcp`（MCP Server 面，bridge.ts:203 复用同一 execute），影响面 ×2。
- **定级说明**：org_admin 为受信角色，但能力超出声明边界、与 REST 面安全口径不一致；且 release-notes-2026-09-12 §五已声明「iam 工具面 actor 上下文未传，下批次统一接入」，两个迭代后仍未接入。若组织隔离属硬安全边界应按 P0 处理。
- **测试后已恢复**：dd0008 已解冻+口令重置回 Ybk@2026（登录验证 200）；bypass 账号已冻结+注销。

### N2（P3）两处把原始 JS TypeError 文本直接回给客户端
- `POST /api/market/developers/register`（空 body）→ 400 message="Cannot read properties of undefined (reading 'length')"（`packages/plugin-console/src/routes/market.ts:24` 直接回 error.message，入参未校验先解引用）。
- `POST /api/tools/execute` connector_execute 未知 actionId → 工具输出 "工具执行失败：Cannot read properties of undefined (reading 'split')"。
- 无直接泄密（仅暴露内部实现形态），属健壮性/信息规整问题；与 2026-09-13 遗留项「REST 入参无统一校验设施」同根因。

### N3（P3）org_admin 读面无组织过滤：hr `GET /api/iam/users` 返回全平台 22 账号（含他部邮箱/手机/职务）
- A-03 修复范围仅写面（release note 口径如此），读面未收敛。org_admin 为受信角色，P3 观察；若多组织隔离按硬边界要求，读面应同步过滤或脱敏。

### N4（P3）跨组织拒绝以 400/BAD_REQUEST 呈现而非 403
- 服务层 throw（`plugin-iam/src/index.ts:1084`）经路由包装统一落 400。语义上属授权拒绝，403 更准；与已立项的「404/400 语义统一」项合并即可，不算独立缺陷。

### N5（P3）README 对 sceneCode 的 blanket 宣称未带范围注记
- `README.md:35`：「IAM 场景级授权（sceneCode，deny→allow→fail-closed）」未注明 panel 任务/消息入口未接入（release-notes-2026-09-12 已诚实声明）。文档一致性小项。

---

## 三、上轮缺陷修复复核结论（live 实测）

| 上轮编号 | 结论 | 证据 |
|---|---|---|
| A-01 sceneCode 无执行点 | **部分修复**（flow 域闭环+文档诚实延期） | sceneGuard 接入 flow 三入口（`plugin-flow-core/src/index.ts:377-390`，调用点 436/464/474）。live：member（有 flow.write）对挂 deny 策略场景建流 → 403「场景授权拒绝（QA-SCENE-1013 · flow.create）」；allow-admin-only 场景无命中 → 403 fail-closed；审计落 `console.authz.denied`（point=scene:QA-SCENE-1013#flow.create，实测 91 条 authz 审计在案）。panel 任务带被拒 sceneCode 仍 200 创建——与 release-note「任务/消息入口需 schema 变更，列入下迭代」口径一致（诚实延期，非隐瞒）。N5 指 README 未带注记 |
| A-03 org_admin 跨组织 | **已修复**（REST 面） | hr 对市场部用户 PATCH/reset-password/freeze/建号 全部 400「跨组织账号操作被拒绝（…）（组织隔离，QA A-03）」；正向对照：hr 对本组织用户建号/冻结/解冻/重置 200 全通。但工具面被 N1 绕过 |
| A-04 developer 改他人应用 | **已修复** | `routes/apps.ts:124` assertAppOwner 覆盖 5 处（143/155/165/177/191）。dev 对 hr 名下应用 PATCH/DELETE/onboarding-prompt(rotate) 全部 403「仅平台管理员与应用负责人可变更…（owner 校验，QA A-04）」；ops（resource_admin，非 owner）PATCH 同样 403；dev 改自己应用 200 |
| A-05 自审批 | **按业务决策放宽（APR-05），非缺陷** | release-notes-2026-09-15 明确取消 A-05 拦截。live 复核：ops 提交 skill 后自审 domain 级 → 200 通过；approval.decide 权限点与 high-risk confirmed 校验不变（见 A-06）；REL-01 回归：decision="maybe" → 400「非法的审批决策」（`plugin-audit` 服务层入口校验在位） |
| A-06 六类 L4 未标 high | **已修复** | live：ops 开网关下线审批单 → 审批记录 riskLevel:'high'；不带 confirmed approve → 400「高风险审批通过需二次确认（confirmed=true）」；带 confirmed → 200 执行 + `approval.final_review` 审计「公司级终审标记（风险级 high）」（网关已恢复原状）。六类显式标注在位：connector.offline（console）、connector.connect（plugin-connector/src/index.ts:705）、connector.action.admin（同文件 1300）、mcp.offline（plugin-mcp/src/index.ts:495）、nas.share（plugin-nas/src/authz.ts:547）、panel（plugin-panel-core/src/index.ts:475）；另有中央闸兜底 `plugin-audit/src/index.ts:158-163,719`（HIGH_RISK_APPROVAL_KINDS 未声明即缺省 high，fail-closed） |
| A-07 OBO 越权+交集丢弃 | **已修复** | dev 对他人 Agent（linxm 名下）obo-token → 403「仅 Agent 负责人或绑定用户可代…签发（QA A-07）」（`routes/agents.ts:319-332` owner/绑定/'*' 三重校验）；dev 对自己 Agent 签发成功，OBO 令牌 scope=交集 5 点，/auth/me 实时权限同交集，越权调 iam.user.create → 403；验签二次夹紧在位（`plugin-authn/src/index.ts:904-906` 对 issuedBy obo: 令牌 intersect 实时权限与签发交集） |
| A-08 弱口令建号 | **已修复** | createUser："123"→400「口令长度不得少于 8 位」、"1234567"→400、含中文→400「口令不得包含中文」；resetPassword 同口径拒绝；统一断言 `plugin-iam/src/index.ts:1090-1093` assertPasswordStrength。"abcdefgh"（8 位无复杂度）可建——符合「≥8 位不含中文」 declared 口径 |
| a003283 工具桥伪造能力令牌 | **回归通过** | dev/ops 携 `viaApprovalExecutor:true + approvalCapability{token:"forged-by-attacker"}` 调 connector_execute → isError fail-closed，未绕过审批执行 |

---

## 四、验证通过清单（攻防未破）

1. **token 攻防（12 向量全 401）**：伪造签名 / 篡改载荷保留原签名（含扩 scope='*'、改 exp 到 2099）/ JWT-none 形态 / 空签名 / 垃圾串×2 / 缺失头 / 畸形头 / Basic 头 / 错误密钥重签 / 幽灵 jti——全部 401 TOKEN_INVALID/UNAUTHORIZED，无一眼 fail-open（验签 `plugin-authn/src/index.ts:875-908`，先签名后载荷，HMAC 单密钥）。
2. **过期精确**：admin 经 `POST /api/authn/tokens`（authn.token.issue）签 0.001h 令牌，T+0 200、T+4.5s 401「令牌已过期」。
3. **冻结全链**：冻结 sec-tk → 存量令牌即时 401 且携带原因「令牌已被吊销：账号冻结联动：QA冻结测试-20261013」；冻结期登录 401「账号已冻结：…」；解冻后旧令牌仍 401（不复活）；新登录 200 正常。
4. **refresh 轮转**：宽限窗口（30s，`plugin-authn/src/index.ts:120-121`）内重放 → 自愈签发兄弟对（token/refresh 均可用）；窗口外重放 → 「检测到 refresh token 重放：该会话整链已吊销」，同链旧 access/新 access/新 refresh 全部 401，其他会话不受影响。
5. **RBAC 矩阵（30 端点 × dev/ops/audit = 90 断言全符合角色语义）**：覆盖 iam 写面×6（建号/PATCH/freeze/reset/deactivate/import）、orgs×2、roles、authn（tokens 签发/吊销/principals）、审批 decide+delete、usage（price-book/record/purge）、modelgw、mcp.services、nas、connector.execute、panel 任务、flow、audit.logs、iam.users 读、工具桥 usage_query；403/放行全部与 `GET /api/auth/me` 实测权限集一致。200 侧抽检：admin 6 读、dev /api/apps、audit /api/agents 均语义正确。
6. **匿名 fail-closed**：25 条非公开路径（iam/audit/apps/agents/skills/approvals/authn/usage/modelgw/connector/nas/mcp/market/roster/scene-policies/panel board/flow/bus/finops/assets/tools.schemas）匿名访问全部 401；路径混淆探测（`/api/panel/stream/../iam/users`、`/api/auth/providers/../iam/users`、redeemX）均 401，无白名单绕过。
7. **PUBLIC_PATHS 逐项（15 项）无数据泄漏**：login 400 缺参、providers 仅回显登录配置（corpId/configId，设计使然）、health/bootstrap 仅布尔、beacon 恒定响应、entry-ticket redeem 无效票 400、connect/enroll 无接入码 401、refresh/cc 错凭证 401、market register/login 拒绝、panel/auth 404（白名单先行的登记注释与实际一致）、panel/stream 无 ticket 401。
8. **登录锁定（上轮仅代码评审，本轮 live 实测）**：sec-lk 连续 5 次错口令后第 6 次 401「失败次数过多已锁定：请约 15 分钟后重试」，正确口令在锁定期内同样被拒。
9. **SEC-01 回归**：PATCH /api/iam/users/:id 携 status/passwordHash/passwordSalt → 400「账号编辑不接受以下字段：status、passwordHash、passwordSalt…」（白名单在位）。
10. **SEC-02**：GET /api/authn/oidc/clients 响应无 clientSecretHash 字段（demo 库 0 客户端，属代码级+响应面双重确认）。
11. **APR-03 回归**：驳回审批单 DELETE → 200（仅 rejected 可删）；审批重复决策/非法 decision 均被服务层拦截。

## 五、环境变更披露（全部恢复/留证）

- 新建 sec-* 测试账号：sec-tk（active，token/冻结链证据）、sec-rp（active，refresh/scene 证据）、sec-lk（锁定测试后约 15 分钟自动解锁）、sec-mass（SEC-01 证据）、sec-pwd-abcdefgh / sec-pwd-P@ssw0rd9 / sec-pwd-rp2（A-08 正向对照）、sec-hr-own（hr 本组织正向对照，active）、sec-toolbypass（N1 证据，已冻结+注销）、sec-toolbypass2（未建成，被「用户名不能为空」拦截——第一次探测用了错误请求键）。
- **dd0008（市场部演示账号）曾被 N1 探测冻结并重置口令，已即时恢复**：unfreeze → active，口令重置回 Ybk@2026 并登录验证通过；其间其令牌被联动吊销属冻结语义正常行为。yqz title 曾 PATCH 为「运营专员」——与 seed.ts:116 种子值相同，零漂移。
- 审批单：网关下线单已执行后网关恢复 online（available:false 为环境变量缺失的既有状态，与测试前一致）；REL-01 测试单已驳回并按 APR-03 删除；测试 skill 已驳回并删除；sceneCode 两条 QA-SCENE-* 策略已删；panel 测试任务已移入 done；OBO 测试令牌已吊销。
- 审计日志/审计事件为 append-only 证据，保留。全部 token 已脱敏不入报告。

## 六、修复建议优先级

1. **立即（N1）**：iam 工具面（iam_user_create/reset_password/freeze 及 /mcp 同路径）补 manageActor 传递——最小修法是 `injectToolIdentity`（bridge.ts:62）对 iam_user_* 注入 `{ userId, permissions }` 形态的 actor，或 tools.execute 把 principal 直传服务层；同时把 `assertManageScope` 的 `if (!actor) return` 收敛为「仅限无 HTTP 上下文的内部调用（seed/导入）」白名单化。
2. **本迭代（N2/N3）**：market register 入参校验前置 + 错误信息规整；org_admin 用户读面按组织子树过滤（或至少脱敏 email/phone）。
3. **排期（N4/N5）**：并入已立项的 404/400/403 语义统一与文档一致性批次。
