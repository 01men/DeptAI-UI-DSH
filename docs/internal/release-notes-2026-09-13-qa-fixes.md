# QA 修复批次说明（2026-09-13）

> 来源：2026-09-13 全功能系统性测试（本地隔离实例 127.0.0.1:7391，DEMO_SEED=1；黑盒 + 契约对照，
> 四域并行 ≈630 用例 + 基线 selftest 1118/1118）。本文记录本轮 15 项修复（P0×1、P1×6、P2 提级×8）
> 的改动、验证与回滚方式。测试证据与复现脚本留存于仓库外 `D:\DSH-07\qa-systematic-test\`。

## 一、修复清单

| 编号 | 级别 | 问题 | 修复位置 | 修法一句话 |
|---|---|---|---|---|
| SEC-01 | P0 | `PATCH /api/iam/users/:id` 质量赋值：可改 status/passwordHash/passwordSalt（账号接管、冻结绕过且不吊销令牌） | `plugin-iam/src/index.ts` updateUser | 服务层白名单收敛（displayName/email/phone/title/orgId/accountType/primaryOrgId），白名单外 400 并点名 |
| SEC-02 | P2 | `GET /api/authn/oidc/clients` 响应泄露 clientSecretHash | `plugin-authn/src/oidc.ts` | 新增 publicClient 脱敏器应用于全部对外返回值（内部验签路径不动） |
| SEC-03 | P2 | `PATCH /api/iam/orgs/:id` 接受不存在的 parentId（悬挂引用） | `plugin-iam/src/index.ts` moveOrg | 父组织存在性校验，缺失 400（口径对齐 createOrg） |
| REL-01 | P1 | 审批 `decide` 非法 decision（如 "maybe"）被当作 approve 进执行器 | `plugin-audit/src/index.ts` decideApproval | 服务层入口校验 decision ∈ approve/reject，否则 400 |
| REL-02 | P1 | draft Agent 可开 L4 下线审批单（批准必失败、凭证吊销联动不生效） | `plugin-agent/src/index.ts` requestOffline | 开单前按生命周期状态机预检（availableTransitions 含 offline 才可开单） |
| REL-03 | P2 | Skill 两级审批同一人可连过 domain+security | `plugin-skillhub/src/index.ts` approve | security 加签人须 ≠ domain 审批人，否则 400 |
| REL-04 | P2 | 应用指标 metrics-report 接受负数（PV 可被刷减） | `plugin-app/src/index.ts` recordUsage | pv/uv/dau/sessions 须 ≥0 整数、retention7 ∈ 0..1，否则 400 |
| REL-05 | P2 | `onboarding-prompt rotate=true` 无 owner 守卫（跨 owner 拿明文 secret） | `plugin-agent/src/index.ts`（httpServer 中间件） | 对齐 obo-token 守卫口径：owner/绑定用户/'*'/本 Agent 机器凭证自助 |
| REL-06 | P2 | `PUT /api/skill-storage` 不校验 mode 枚举（"NAS" 大写静默走本地） | `plugin-nas/src/index.ts` setSkillStorage | mode ∈ {local, nas}，否则 400 |
| REL-07 | P1 | 工具桥 `usage_query` 未声明权限点（任意登录角色可读全平台计量/成本） | `plugin-usage/src/tools.ts` | 补 `permission: 'usage.read'`（与 REST 面口径一致） |
| REL-08 | P1 | `GET /api/usage/totals` 忽略 resource 过滤参数 | `plugin-console/src/index.ts` totals 路由 | 透传 resource（服务层本已支持） |
| REL-10 | P1 | usage 证据锚点与场景时间线断链（IAW 5-1→5-2） | `plugin-audit/src/index.ts` timeline | timeline 合并命中 sceneCode 的 evidence 条目（entryType='evidence'，additive-only）+ 锚点引用 log id 时计算式回填 evidenceIds |
| REL-11 | P2 | 价格簿无数值校验（"abc" 费率 → NaN 污染计价快照且对账恒不平） | `plugin-usage/src/index.ts` | 写入口校验（金额 ≥0 有限、units_per_step ≥1）+ 读侧加固（存量脏数据按 0 计价/投影/归集并发 warning，不产生 critical 风暴） |
| REL-12 | P2 | `POST /api/audit/alert-rules` 完全无入参校验（缺 name/负阈值照收） | `plugin-audit/src/index.ts` createAlertRule | name/metric 非空字符串、threshold 有限数值、operator 枚举校验 |
| ARC-01 | P1 | 内置角色权限迁移空跑即落标记——全新部署首启角色缺点，须重启第二次才补齐 | `plugin-console/src/seed.ts` seedAll | 迁移调用挪到种子完成之后（每次启动幂等重比对、缺则补；存量受损库下一次启动自动补齐，无需清 marker） |

> 注：编号即代码内注释标记（SEC-xx / REL-xx / ARC-01，grep 可定位）；REL-09 编号留空未用。测试报告原编号映射见 `qa-systematic-test` 各域报告。
> 2026-09-13 产品决策：第三方插件市场（plugin-market）**不引入两级审批**，契约描述已同步修正为单级审批（原「两级审批」表述为契约笔误，实现自始为单级）。

## 二、验证结论（阶段 4）

- **整合验证 20/20 通过**（`qa-systematic-test/fix-verify/integration-verify.mjs`，跑在修复后代码 + 真实「带伤」存量数据目录上）：15 项修复全部生效，合法路径（PATCH 档案字段、online→offline 开单、异人两级审批、正数指标、owner rotate、合法价格簿/告警规则、审批 approve/reject）零回归。
- **ARC-01 双路径**：存量库重启后 audit 角色迁移点自动补齐（14→18，missing=[]）；全新库首启种子完成后即含全部迁移点（首启 HTTP 先于 fire-and-forget 种子就绪的窗口为既有行为，窗口极短且 admin 未种子前本就无法登录）。
- **回归基线**：`npm run selftest` **1118/1118 全绿（EXIT=0）**；`npm run lint:manifests` 通过（仅既有 4 条警告，无新增）。
- 各修复的隔离自验（修前复现 + 修后断言）由实施工程师在独立端口/数据目录完成，证据见 `qa-systematic-test/fix-verify/{sec,rel,meter,arc}/`。

## 三、风险与回滚

- 全部改动为追加式小块（15 处，净增约 200 行，无 schema 变更、无新依赖）；按问题编号均有注释标记（SEC-xx/REL-xx/ARC-01），可按 hunk 独立回滚。
- 行为收紧点（有意为之，向后兼容性已验证）：PATCH users/orgs 不再接受白名单外字段；审批 decision 只认 approve/reject；指标/价格簿/告警规则非法入参 400。若有外部调用方依赖旧宽松行为，需要按错误信息调整调用方。
- clientSecretHash 仍完整落库（仅响应层剥离），rotate/disable 语义不变。

## 四、遗留与建议（未纳入本轮）

1. `PATCH /api/audit/alert-rules/:id`（console 路由直改存储，绕过服务层校验）仍无校验——建议 console 路由接入服务层。
2. `plugin-app` 的 requestOffline 存在与 REL-02 相同缺口（app 侧开单无状态预检），修法可照抄。
3. **平台级共性根因「REST 入参无统一校验设施」**（本轮 15 项中 9 项与之相关）——**已批准，下轮立项**（2026-09-13 管理层确认）：统一入参校验层（manifest schema 驱动），并在 `permissions.yaml` 补登 iam.roster.read / authn.oidc.* 等已实现权限点的声明。
4. 产品决策待定：audit 是否补 usage.read、resource_admin 是否补 panel.config.write、flow.* 是否收窄到 admin、审批单转派/代办机制、种子 NAS 指向生产网段的演示数据卫生。（market「两级审批」一项已按 2026-09-13 产品决策删除，见上注。）
5. 404/400 语义统一、非 UTF-8 请求体拒绝、CSP 响应头：涉及全平台口径，建议单独立项。

## 五、部署须知

按工作区约定，双目标（测试 mdzx.fun:8801 / 正式 192.168.0.7:7300）更新必须走 `daily-sync-deploy.py`；
本轮改动未部署、未 commit（工作区尚有他人未提交 WIP，建议由代码所有者确认后一并提交）。
