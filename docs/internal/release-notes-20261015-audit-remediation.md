# 审查反馈整体整改批次交付报告（2026-10-15）

> **交付状态：已完成并全量验证**。本批次为研发负责人组队攻坚模式：六个开发组按文件冲突域并行开工 +
> 一个测试组统一收口，把截至 2026-10-15 全部审查报告（20260912 A/B/C/E 组、20261013 全量回归/移动端/四组、
> 20261014 Agent 生命周期/线上总览/六能力 Paperclip/生产部署/执行中枢）中**仍未闭合**的整改项一次性收口，
> 不按报告分批。
>
> - selftest **1343/1343 全绿**（净增 **86 条断言**、5 个新区段；既有断言**零适配改动**）
> - dom-smoke **14/15**（1 条既有设计性跳过）；page-smoke **31/31**；lint 全家桶（manifests/boot-order/cjk）**0 错误**
> - 生产实例已平滑重启并完成匿名面线上复验（/docs 白名单、保留前缀 404、CSP/no-store 头、SPA 兜底）
> - 改动半径：32 个源文件 + 2 个测试脚本 + 2 个对外文档，+700/−170 左右

## 一、缺陷收敛台账（编号沿用来源报告）

### P1 安全
| 编号 | 缺陷 | 收口 |
|---|---|---|
| N1（20261013 group-a，唯一在账 P1） | iam 工具桥 `iam_user_create/reset_password/freeze` 不传 manageActor，`assertManageScope` 首行 `if(!actor) return` fail-open，跨组织建号/冻结/重置口令（含明文新口令）可经 `/api/tools/execute` 与 `/mcp` 完整绕过 A-03 组织隔离 | 三层收口：① 桥侧 `injectToolIdentity` 对 5 个 iam 管理工具剥离客户端 `_actor`/`actor` 后注入服务端可信身份（`{id,name,orgId,platformAdmin}`，/mcp 与 REST 两链路一致）；② `iam/tools.ts` `manageActorOf` 归一消费（`_actor` 优先 → `exec.principal` 回落）；③ 服务层 `!actor` 旁路改为 fail-closed 抛 `OrgScopeDeniedError`(403)，全仓 15 处调用方逐一归因（种子 10 处 / SSO 注册 2 处 / 连接器同步 3 处传 `SYSTEM_ACTOR`，REST 14 处传真实 `manageActor`，含本轮新发现的建号自动激活与 runSync createOrg 两处漏归因） |
| N1 配套 | 工具面无组织隔离测试 | selftest 新增：org_admin 经工具桥跨组织冻结被拒、伪造 `_actor` 剥离生效、子树内成功、无身份 fail-closed 四断言 |

### P2 安全与正确性
| 编号 | 缺陷 | 收口 |
|---|---|---|
| BUG-2510-B1 | 渠道组降级链完全绕过预算熔断（block 态经备用渠道 200 调通入账） | `invokeWithFallback` 每次真实调用前 `enforceBudget` 复检（按即将调用的渠道 slug 评估，与单渠道 R3 通配/R10 主体语义完全一致），熔断 throw 终止整链：不调上游、不入账、不 emit degraded |
| G2-01 | /docs 整目录 69 篇匿名公开，混入部署 runbook 与 40+ 篇内部协作文档 | 默认拒绝白名单 `PUBLIC_DOCS`（代码常量，可导出供断言）：初始 6 篇对外接入指引 + 生态设计；白名单外（含 `deploy-enterprise.md`、全部 qa/handoff/dev-plan/contract/重构类与子目录）一律 404；`%2F` 穿越防护保持并实测 |
| P1-A 遗留台账（口径修正：实测 24 个而非报告所称 36 个） | 24 个存量 MCP 工具未声明 permission，依赖 `console.login` 基线兜底 | 24/24 全部按同名 REST 路由同口径补齐最小权限（audit.read/agent.read/authn.principal.read/modelgw.read/mcp.service.read·deploy/app.read/skill.read/skill.submit/market.read/iam.org.read·write/iam.user.read）；含 connect 5 个 client 形态工具显式 `console.login`；selftest 断言收紧为 **/mcp tools/list x-permission 全覆盖（82/82）**，基线仅作漏声明 fail-safe |
| B-05 | demo seed 绕过 usage 管道直写 `audit:costs`（管道外自造成本） | 删除直写：成本由既有 30 天 usage 事件经价格簿管道派生（`seed:` 幂等键可反查对账）；selftest 增管道入账断言 |
| A-10 | admin 初始口令文件写盘无 0600；空串 `ADMIN_PASSWORD` 致锁死 | `writeFileSync` mode 0o600（macOS APFS/Linux 均生效，selftest 实证）；空串回落随机生成路径 |

### P2/P3 工程（一次性全收）
| 编号 | 收口 |
|---|---|
| LC-1 | `approval_decide` 工具补 `confirmed`/`finalReview` 透传（服务端 L4 二次确认门禁不变、禁止默认 true），selftest：缺 confirmed 被 fail-closed 拦截 / confirmed 通过 / finalReview 落 `approval.final_review` 审计 |
| A-01 残余 | panel 任务创建入口接入 `sceneGuard`（与 flow 域同构）：deny→403+`audit.authz.denied`，无 sceneCode/无策略/机器主体放行 |
| N3 | `GET /api/iam/users` 非平台管理员自动收敛管辖组织子树；显式 `?orgId=` 越子树 403 |
| N4 | 跨组织拒绝 400→**403 FORBIDDEN**（`OrgScopeDeniedError` + 路由层 `manageScope` 包扎，11 条管理路由） |
| A-09 | 口令升级 scrypt KDF（`scrypt$N$r$p$saltB64$hashB64`，N=16384/r=8/p=1）+ `timingSafeEqual`；旧 sha256 登录成功透明升级，存量用户无感（selftest 白盒 5 断言） |
| C-05 | 事件总线同事件监听器 `Promise.allSettled` 并发派发（事件间严格 FIFO、注册序同步语义保留），单监听器失败/5s 超时不再头阻塞同事件其他监听器 |
| 死信 source | `BusDeadLetterRecord` 增 `source` 字段，plugin: 事件死信结构性可重投 |
| C-10 | SPA 兜底保留前缀豁免（`/api /rq /dsh-bridge /auth/entry /oauth /.well-known /mcp /docs`）：独立宿主下协议前缀 404 JSON 而非 200 HTML |
| G1-F2 残余 | 全响应 CSP（`SECURITY_HEADERS=off` 一键同关；`connect-src 'self' http: https:` 保障已文档化的宿主连接切换特性）+ `/api/*` `cache-control: no-store`（处理器 writeHead 自带优先） |
| C-06 | flow skip 致 running=0 → `stalledAt` 标记 + `flow.stalled` 事件（不自动重跑） |
| C-07 | `slaMinutes` 必须 >0（createFlow + upsertTemplate 双点），防「出生即逾期」 |
| C-08 | 数据血缘环引用检测（沿边 DFS，成环拒绝） |
| C-09 | 指标字典指纹 `stableStringify` 键序归一（消除伪口径冲突）；仲裁后陈旧 `supersedes` 指针清理 |
| C-11 | 数据集质量分乐观并发（`qualityRevision` + `expectedVersion` 冲突拒绝；缺省保持最后写入兼容） |
| E-04 | YAML 序列项「冒号后无空白」保持标量（`- 12:34:56` 不再误判为行内映射报 `[object Object]`） |
| E-05 | update dryRun 不再 `git fetch origin`（refs 快照断言实证零外呼变更） |
| E-06 | 权限点卫生：`PermissionCatalog` 移除三死点 `market.submit`/`connector.market.publish`/`scenegraph.activate`，org_admin 迁移不再授予（存量库需管理员按角色编辑回收） |
| meterPromptUse | 计量幂等键改确定性 `plugin-use:install:subject:prompt:UTC分钟窗`（重试不双计，selftest 实证） |
| N2 残余 | market 注册补 displayName/email/password 前置校验（中文 400，非裸 TypeError） |
| NEW-E-01 | 插件 id 命名空间绑定：注册即绑 namespace（显式 > 账号品牌段派生），`com.<x>.*` 提交闸 x 必须=namespace；存量无 namespace 开发者跳过（走审批闸） |
| 4a/4b/4c（六能力报告遗留观察） | usage summary 通配预算口径分裂**已修**（`'*'` 计入 org 进度）；feedback 幂等键含 score **已修**（连带修复 `feedbackStats` 键解析，两代格式兼容聚合）；usage replay **已补 changeLog** 审计 |
| OBS-DRV | storage ENOENT 竞态降级 debug 容忍（不重试风暴） |
| E-01 断言欠账 | 补回滚快照写入点/读取点结构断言（写入点先于 npm install 的文件序） |
| QA-NEW-1 | ⌘K 命令面板补 6 条真实路由（#/nas #/nas-authz #/finops #/connectors #/register #/connections），索引 17→23 条 |

### 口径与文档
- README/llms.txt：sceneCode 全链路口径补注面板任务入口接线；新增 API 契约注记（未匹配路由匿名统一 401 属设计内）与 MCP 工具面口径（82 工具全覆盖声明、基线仅 fail-safe）；最近更新行置顶本批次。
- 旧品牌页处置（20261013 回归报告待决策项）：`产品.html` + `preview-fullpage.png` **git mv 归档**至 `archive/legacy-brand/`（26 处旧品牌表述与品牌重塑冲突，决策=归档下线而非重写），`archive/README.md` 补登记。
- `N5` 随 A-01 接线自然销账。

## 二、验证记录

| 项 | 结果 |
|---|---|
| `npm run selftest`（隔离实例） | **1343/1343 通过**（连续两次全绿；新增 86 断言 / 5 新区段：口令 KDF 升级、基线口令文件、yaml 序列解析、panel sceneGuard、前端命令面板路由索引；既有断言零适配） |
| dom-smoke（7301 隔离实例） | 14/15 通过 + 1 条既有设计性跳过 |
| page-smoke（同实例） | 31/31 通过 |
| lint:manifests / boot-order / cjk | 全部 0 错误（47 条既有豁免提示不变；新增 3 条 `perm_unused` 咨询级警告，见遗留） |
| 生产平滑重启 + 线上复验 | launchd kickstart 重启；匿名面实证：`/docs/deploy-enterprise.md`=404、qa-report=404、dev-log 子路径=404、白名单接入指引=200、`/rq/panel/`、`/dsh-bridge/status`、`/auth/entry`=404、API 响应含 CSP+no-store、未知 SPA 路由仍 200 |
| 登录态线上复验 | 生产 admin 口令由运营者持有（历史轮转，非 plist 环境变量值），未做侵入性重置；登录态断言（工具桥组织隔离、scrypt 透明升级、tools/list 全覆盖、审批 confirmed 等）由 selftest 隔离实例全量兜底 |

## 三、遗留台账（本批新增或延续）

1. **运维项（代码不可达）**：R1 Cloudflare Always-HTTPS/HSTS 开关；R2-A 生产模型目录登记（管理 UI 已具备，登记动作待真实 API Key）；OBS-2 www DNS CNAME 与证书 2027-01 到期跟踪；Agent 机器凭证 `console.login` 授量回收（本批 permission 全覆盖后已具备回收前提，因涉及真实接入 Agent 的 REST 面依赖，留运维窗口执行）。
2. **咨询级**：`perm_unused` 警告 3 条（plugin-market/plugin-connector/plugin-panel-core 清单仍声明三死点，`gen-manifests.mjs` 数组同源未清）——建议下批清 manifest 声明面；存量库 org_admin 已落库的 `scenegraph.activate` 需管理员按角色编辑回收。
3. **contract-lint 盲区**：`extractCodeSurface` 对数组解构循环形态路由（routes/iam.ts 4 条用户动作）提取不到（假阴性，恰好均未申报 api.yaml，无幽灵红项）——后续做常量折叠或要求字面量化。
4. **设计边界（维持声明）**：meterPromptUse 分钟窗内同业务合并计量（跨分钟重试仍双计，彻底方案需调用方传业务单据 ID）；namespace 为注册自声明（防冒认 hygiene 闸，品牌资质仍靠审批闸）；C-05 保序前提下持续失败监听器的退避仍会推迟后续事件；CSP 后续收紧路径（内联处理器改事件委托、connect-src 收敛部署清单）；C-11 REST 入口未传 expectedVersion（服务已支持，前端接入待接入批次）。
5. **依赖真实运行时**：execution-hub 边界 1/2/4、A2A/OBO 链路回归、R6 四角色×移动端 GUI 全矩阵复测（page-smoke 已覆盖 31 页渲染面）。

## 四、团队分工（研发负责人组队攻坚）

| 组 | 域 | 交付 |
|---|---|---|
| 组1 | 身份与访问（IAM/Authn 侧） | N1 三层收口、N3/N4、A-09 KDF、E-06 权限卫生、服务层旁路关死（返工单） |
| 组2 | 工具桥与 MCP 面 | 19 工具 permission、LC-1 confirmed、N1 桥侧注入（/mcp+REST 双链路） |
| 组3 | 网关/计量/市场 | BUG-2510-B1 降级链预算守卫、meterPromptUse 幂等键、namespace 闸、usage 口径三项核实与修复 |
| 组4 | 控制台安全面 | G2-01 /docs 白名单、A-10、B-05 成本管道化、旧品牌页归档 |
| 组5 | 平台内核 | C-05/06/07/08/09/10/11、E-04/05、CSP+no-store、panel sceneGuard、死信 source、storage 降噪（十项） |
| 组6 | 前端与文档口径 | ⌘K 补 6 路由、README/llms.txt 口径注记 |
| 主控（研发负责人） | 情报汇总与核实、组队派单、跨组契约（N1 `_actor`）、域外集成修（feedback 键/replay 审计/connect 声明/iam 5 声明补漏）、归档登记、生产重启与线上复验、整体合批 |
| 组7 | 测试收口 | 86 条新增断言落位、全量四件套收敛全绿、抓出并修复 feedback 键集成缺陷（feedbackStats 解析兼容两代格式） |
