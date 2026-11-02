# A 组报告：安全与权限域（2026-09-12）

> 总报告见 [qa-report-20260912-overview.md](qa-report-20260912-overview.md)
> **测试对象**：http://127.0.0.1:7301（DEMO_SEED=1，数据目录 `data-q3-audit`），代码基线 git `2122c2c`
> **测试域**：plugin-iam / plugin-authn / 审批链路 / 场景级授权（sceneCode）/ 权限点矩阵
> **方法**：只读代码评审 + 实时黑盒测试；破坏性操作全部使用自建 `sec-` 前缀用户；另在 7391/7392 端口起过两个临时实例（独立 `data-sec-a` 目录，测完即删）
> **结论概览**：**未发现 P0 级安全洞**；P1 × 4、P2 × 4、P3 × 2。本批重点回归 a003283（审批冒充面封死）**回归通过**；token 域全部攻防用例**通过**；但场景级授权被证实**全平台未接线**，另有 3 项越权边界失控。

---

## 一、缺陷清单

### BUG-A-01（P1）场景级授权 sceneCode 策略「deny→allow→fail-closed」全平台无执行点，仅自查端点自嗨
- **复现**（live 实测，member 测试用户 sec-scene）：
  1. `PUT /api/iam/scene-policies`（admin）挂策略：`{sceneCode:"QB01-A-2-5", entries:[{principalType:"role", principalId:"*", actions:["panel.task.write"], effect:"deny"}]}`
  2. `POST /api/iam/scene-authz/check`（sec-scene）→ 返回 `decision:"deny"`（判定逻辑本身正确：deny 优先、fail-closed 均对）
  3. `POST /api/panel/rd/tasks`（sec-scene，body 带 `sceneCode:"QB01-A-2-5"`）→ **HTTP 200，任务创建成功**
- **实际 vs 预期**：自查端点判 deny，实际动作照常执行；deny+allow 并存时自查正确判 deny，实际仍 200 创建成功。
- **根因**：`checkScene()`（`packages/plugin-iam/src/index.ts:856-887`）全仓**唯一调用方**是自查端点自身（`packages/plugin-console/src/index.ts:1205`）。panel 任务创建（`packages/plugin-panel-core/src/index.ts:438-448`）、消息、flow 等所有入口都接收 sceneCode 但只落库/落审计，从不调用判定。fail-closed 无从谈起——没有执行点。
- **说明**：README/IAW 6-1 宣称的「sceneCode 策略 deny→allow→fail-closed」实际是装饰品。RBAC 仍兜底所以无直接越权，故定 P1；**若客户安全方案已依赖该能力，应升 P0**。

### BUG-A-02（P1）内置角色权限迁移「首次启动空跑」——生产数据目录角色权限与代码/文档不符
- **现象**（live 实例 API 实测）：developer 缺 `panel.read/scenegraph.read/flow.read`；auditor 缺 `nas.authz.read/panel.read/scenegraph.read/flow.read`；org_admin 缺全部 panel/scenegraph/flow 补点；resource_admin 缺 `flow.admin`。例如 hr 无法配置面板、audit 打不开场景图谱——均为其文档化应有权限。
- **根因（已用临时实例实锤）**：迁移在 connector 插件装配期执行（`packages/plugin-connector/src/index.ts:1673`），而角色种子由 console 插件的 `seedAll` 落库（`packages/plugin-console/src/index.ts:4311`，boot-all 中 console 在 connector 之后）。首次启动时迁移跑在空角色表上→空转并写入标记（live 库中标记 `mig_` 时间戳 03:46:00.772 **早于**角色记录 03:46:00.790，18ms 铁证）；未重启则永不补齐。
- **验证**：临时实例（7391）全新建库复现同样缺点；**重启后迁移自愈**（developer 补齐 3 点）。live 实例因长期未重启而持续带病。
- **预期**：首启即应与文档权限矩阵一致（selftest 的「panel.read 迁移生效」断言用的是 member，member 在 HEAD 定义里已自带全部点，所以 selftest 测不出此 bug——**断言面盲区**）。

### BUG-A-03（P1）org_admin 跨组织用户管理：可改/冻结/**重置口令**其他组织账号
- **复现**（live 实测，hr=产品运营部 org_admin，目标为市场部的自建用户 sec-crossorg）：
  - `PATCH /api/iam/users/usr_mtxv9uqb8ofncuqo {title:"hr跨组织改"}` → 200，生效
  - `POST /api/iam/users/:id/freeze {reason:...}` → 200，账号被冻结
  - `POST /api/iam/users/:id/reset-password` → 200，**响应返回新初始口令明文**
  - `GET /api/iam/users` → 200，返回**全平台** 22 个账号（无组织过滤）
- **实际 vs 预期**：内置角色声明「管理**本组织**账号与用户组」（`packages/plugin-iam/src/index.ts:281`），预期跨组织操作 403；实际完全无组织边界。等价于任一组织管理员可接管其他组织任意账号。
- **根因**：`/api/iam/users*` 全部路由（`packages/plugin-console/src/index.ts:1069-1117`）仅校验权限点 `iam.user.write/freeze`；`IamService.updateUser/resetPassword/freezeUser`（`plugin-iam/src/index.ts:1148/1093/1125`）无任何 org 归属校验。
- **复核**：总负责人测试后以 hr 身份独立复测 PATCH 跨组织用户 → 200 确认（复核字段已恢复）。
- **定级说明**：调用方是受信角色（org_admin），危害是能力超出声明边界。若多组织隔离属硬安全边界，应升 P0。

### BUG-A-04（P1）developer 可修改他人应用——「应用限自身 owner 范围，服务端校验」未兑现
- **复现**（live 实测，dev 用户）：`PATCH /api/apps/app_mtxuetwg8mx2r4ky {"attrs":{"publishVersion":"v9.9.9-sec"}}`（该应用 owner 为 hr）→ **200，属性写入生效**；随后 admin 已恢复为 v3.2.1。`DELETE /api/apps/:id` 同样越过 owner 直达状态机校验（因应用 online 才被业务规则拦下）。
- **预期**：developer 角色描述明确「（应用）限自身 owner 范围，服务端校验」（`packages/plugin-iam/src/index.ts:283`）。
- **根因**：`PATCH /api/apps/:id`（`packages/plugin-console/src/index.ts:3442-3449`）只校验 `app.write`，无 owner/组织校验（对照同文件 agent entry-ticket 路由 3060-3082 有完整 owner 校验，口径不一致）。

### BUG-A-05（P2）自审批（职责分离缺失）：提交人与审批人可为同一账号
- **复现**（live 实测，ops=resource_admin）：`POST /api/skills` 提交 sec-sod-skill（author=韩若飞/ops）→ `POST /api/skills/skl_mtxv5ocz8odxpnq0/approve {decision:"approve",level:"domain"}` → **200，审批通过**。
- **预期**：审批应拒绝 requester=approver（或至少强制不同人）。
- **根因**：skill 审批路由（`packages/plugin-console/src/index.ts:2128-2141`）与 `decideApproval`（`packages/plugin-audit/src/index.ts:620-699`）均无 approver≠requester 校验；resource_admin 经 `skill.*` 通配同时持有 `skill.submit` 与 `skill.approve`。审批中心 `POST /api/approvals/:id/decide` 同理（现网仅 admin 持 `approval.decide`，暂被权限面掩盖）。

### BUG-A-06（P2）连接器/MCP 等 L4 审批未标 `riskLevel:'high'`——一次 approve 即执行、无二次确认、无终审标记
- **复现**（live 实测，测试中实际发生）：ops `POST /api/connector/gateway/offline` 生成审批单 → admin `POST /api/approvals/:id/decide {decision:"approve"}`（**不带 confirmed**）→ **200，网关立即被执行下线**（审计出现「connector-offline/审批执行」），无公司级终审标记。对照：agent.online/offline、app.online/offline 审批（`plugin-agent/src/index.ts:344-347` 等）均标 high，不带 confirmed 会被 400 拒绝（该路径已在共享实例上由其他测试的真实验证通过：终审标记正常落审计）。
- **根因**：6 类 createApproval 未传 riskLevel：`plugin-console/src/index.ts:1828`（网关下线）、`1973`（连接下线）、`plugin-connector/src/index.ts:696`（connector.connect）、`1288`（**connector.action.admin——风险最高的 kind 也没标**）、`plugin-mcp/src/index.ts:492`（mcp.offline）、`plugin-nas/src/authz.ts:420`（nas.share）、`plugin-panel-core/src/index.ts:525`。与 WP-10/L1「L4 统一高风险」口径冲突。
- **披露**：该测试使共享实例网关短暂 offline，已立即 `POST /api/connector/gateway/online` 恢复（当前 online:true、因环境变量缺失维持原有 available:false 状态，与测试前一致）。

### BUG-A-07（P2）on-behalf-of 链：任意 agent.write 可对任意 Agent 发 OBO 令牌，且签发时的 scopes 交集在验签时被丢弃
- **复现**（live 实测，dev 用户）：`POST /api/agents/agt_mtxuetvn8mvqet6m/obo-token`（该 Agent owner 是 linxm，非 dev）→ **200** 拿到 actChain=[陈默(human)→机器主体] 的 1 小时 machine 令牌（已吊销清理）。
- **设计缺陷**：签发时 `issueOnBehalfOf` 计算 `scopes = intersect(parent.scopes, target.scopes)`（`packages/plugin-authn/src/index.ts:855-869`），但 `verify()` 对 machine 主体**实时重解析**机器主体全量角色+附加权限（`plugin-authn/src/index.ts:897-902`），签发交集形同虚设——权限继承上限=目标机器主体全量权限，与发起人无关。本 demo 中 Agent 主体权限有限（且缺 console.login，实测多数路由 403），未构成实际提权；但若某机器凭证被授予高权限点，任意 developer 可借 OBO 全额继承。对照 entry-ticket 路由有 owner/bound/admin 三重校验，`obo-token`（`plugin-console/src/index.ts:3044-3052`）仅剩 `agent.write` 一个权限点。

### BUG-A-08（P2）建账号口令无强度校验：`123` 可建可登
- **复现**（临时实例 7391 实测）：admin `POST /api/iam/users {...,password:"123"}` → 200；随后 `password:"123"` 登录 → **200**。
- **根因**：`IamService.createUser`（`packages/plugin-iam/src/index.ts:1056-1090`）对传入口令零校验；而 `resetPassword`（同文件 1093-1104）要求 ≥8 位且不含中文。同一产品两套口径。生产含义：ADMIN_PASSWORD 弱=超管弱口令。

### BUG-A-09（P3）口令哈希为单轮 SHA-256；多处敏感比较非常数时间
- `hashPassword = sha256Hex(salt:password)`（`packages/plugin-iam/src/index.ts:1853-1855`），无 bcrypt/scrypt/argon2 慢哈希，GPU 离线爆破成本低（库泄露场景）。
- 非常数时间比较：HMAC 验签 `signatureMatches` 用 `===`（`plugin-authn/src/index.ts:570-573`）、口令哈希 `!==`（`plugin-iam/src/index.ts:1196`）、clientSecretHash（`plugin-authn/src/index.ts:780`）。建议统一 `timingSafeEqual`。内网/本机部署下实际可利用性低（仅代码评审，未做时序测量）。

### BUG-A-10（P3）admin 初始口令文件与空串 ADMIN_PASSWORD 边界
- `admin-initial-password.txt` 写盘未指定 mode（`packages/plugin-console/src/seed.ts:39-46`）；对照签名密钥写盘有 `mode:0o600`（`plugin-authn/src/index.ts:524`）。Windows 下无差异（实测两者均 0666），**Linux 部署将为 0644 全局可读**（代码评审结论，未在 Linux 实测）。
- `ADMIN_PASSWORD=""`（空串）时 `createUser` 的 `??` 不挡空串 → 落成空口令账号；登录 API 又要求非空口令 → **admin 永久锁死**（可用性风险，代码评审结论，未实测首启）。
- 正向确认（临时实例实测）：ADMIN_PASSWORD 缺失 → 生成 `init_` 前缀 32 字节强随机口令（192bit 熵），写入文件（2 行说明+口令），admin 用其登录 200；DEMO_SEED 未置时演示账号不存在（dev/Ybk@2026 → 401）、mock 身份源不注册。**该路径整体合格**。

## 二、重点回归项：a003283「审批冒充面封死」——回归通过

| 断言 | 结果 |
|---|---|
| 旧布尔 `viaApprovalExecutor` 全仓残留 | 0 命中（仅 selftest 验收 grep 自身引用） |
| 工具桥走私 `viaApprovalExecutor:true` + 伪造 `approvalCapability{token:"forged-by-attacker",...}` 调 `connector_execute` | live 实测：返回 `denied`（授权层拒绝），**未跳过审批执行**，伪造令牌无效果（fail-closed） |
| 能力令牌可达性 | REST `/api/connector/execute`（console:2003-2016）与工具 `connector_execute`（tools.ts:82-90）均只透传 actionId/input/alias/dryRun；`mint` 仅存在于类内执行器闭包（`plugin-connector/src/index.ts:1197-1214`），模块闭包不导出——REST/工具面类型与运行时双不可达 |
| 一次性消费 | `consume` 先删后验（178-182 行），actionId+callerId+30s TTL 三重绑定，错配即 fail-closed 转开单 |
| 审批动作日志操作者真实性 | `decideApproval` 的 approverId/approverName 取自令牌主体（console:4037-4043，body 不可指定）；live 审计 `approval.decide` 记录 actor=真实 admin；审批单终态 approver 字段一致；执行器以审批单内原始 caller 身份续调（审计可还原链条） |
| 高风险双确认 | riskLevel=high 的审批（agent.online 实单）不带 confirmed 拒绝、通过后落 `approval.final_review` 审计 |

## 三、验证通过清单（攻防未破）

1. **越权矩阵**：23 端点 × dev/audit/ops 全交叉（覆盖 iam 写面×6、authn 读/写×5、审批决策/查询、audit 读写、usage 记账/价格簿、modelgw.admin、connector.invoke、skill.submit、roster、route-matrix、工具桥借权×2）——**403/200 全部与角色语义一致**；工具桥 `/api/tools/execute` 有工具级权限点二次校验（console:4137-4149），低权限借工具面开权被拒。
2. **token 攻防**（sec- 用户实测）：伪造签名 401 / 篡改载荷+原签名 401 / 空签名 401 / JWT-none 形态 401 / 垃圾 401 / 缺失 401；1 秒短令牌到期精确失效（2s 后 401「令牌已过期」）；**冻结→全部存量令牌即时吊销**（401 携带冻结原因「账号冻结联动：…」，README 宣称兑现），冻结期登录拒绝，解冻不复活旧令牌，新登录正常；**refresh 轮转**：宽限窗口内重放自愈签发兄弟对、窗口外重放→整链吊销、旧 access 401、同链新 refresh 401「重放检测」。
3. **审批面**：dev/audit/ops 决策审批全 403（`approval.decide` 收敛于 admin）；重复决策 400「审批单已处理」；审批单/审计/工具桥三处的操作者身份均取自令牌且不可注入。
4. **PUBLIC_PATHS 匿名探测**（17 项）：全部 fail-closed——`/api/panel/stream` 无 ticket 401、`/api/authn/entry-tickets/redeem` 无效票据 400、`/api/connect/enroll` 401、`/api/panel/auth/login` 白名单但无路由（404，与登记注释一致）、route-matrix/tools.schemas/iam.users 均 401。备案观察项：`/api/market/developers/register` 为公开开发者注册面（设计使然，有密码强度校验）；`/api/auth/providers` 公开回显 corpId/configId（登录页需要，轻度信息暴露）；`/api/apps/beacon` 接受任意 appId 但响应恒定。
5. **sceneCode 自查判定器本身**：deny 优先于 allow、无命中 fail-closed deny、无策略 default 回落、代查他人需 `iam.user.read`（dev 被拒）——判定器逻辑正确，问题只在没人消费（BUG-A-01）。
6. **登录锁定**（代码评审）：5 次/15 分钟触发、指数升级至 24h、计数持久化防重启绕过——未实测（避免锁共享账号）。

## 四、环境变更披露（全部已清理/恢复）

- 新建用户 `sec-scene`、`sec-crossorg`（测试完毕已冻结）；临时实例用户随 `data-sec-a` 删除。
- rd 面板 3 条 `sec-` 任务已移入 done 泳道；测试产生的审计日志/审批单（含一单真实执行的网关下线审批，执行后立即恢复）为 append-only 证据，保留。
- `sec-sod-skill` 处于 approved 状态（未上架无法 deprecate，保留为 BUG-A-05 证据）。
- cs-portal 应用 `publishVersion` 曾被改为 v9.9.9-sec，**已恢复 v3.2.1**。
- sec-scene 名下的 OBO 测试令牌已吊销；临时实例（7391/7392）已停止，`data-sec-a` 已删除；共享实例全程健康。
- 所有 token 在本报告中已脱敏。

## 五、修复优先级建议

1. **立即**：BUG-A-01（把 checkScene 接入 panel 任务/消息/flow/agent 直调入口，或对外诚实降级为「规划中」）；BUG-A-03/04（iam 用户路由加组织边界、apps 路由加 owner 校验——两处都是纯服务端补栏）。
2. **本迭代**：BUG-A-02（迁移移入 iam 启动路径或 seedAll 之后执行；补 selftest 断言用 developer 而非 member）；BUG-A-05/06（approver≠requester 校验、补齐 6 类 L4 审批 riskLevel）。
3. **排期**：BUG-A-07（obo-token 属主校验+scopes 交集真正生效）、BUG-A-08/09/10。
