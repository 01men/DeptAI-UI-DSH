# 开发计划：NAS 数据权限（组织位置 + 角色层级 RBAC）——平台决策 + 网关强制 + 双层兜底

> 版本：v1.0（2026-08-29）· 关联需求：`Hermes_NAS访问控制规则.md`（RBAC 方案）在元冰可平台的工程化落地
> 方案来源与取舍：
> ① 附件方案提供**领域模型**（组织层级锚点、P/D/T/M/C 角色推导、操作矩阵、特殊账号、灰度建议）；
> ② `saas-permission-service`（skill 开发库·服务 B）提供**判定引擎语义**（deny > allow > 角色 > 默认拒绝、
> 判定附带 reasons、资源级例外可设过期、批量 check）——只移植语义，不部署 Python 服务本体；
> ③ `synology-filestation-mcp` 网关（0.7 局域网已部署，6 台 NAS 注册表在案）提供**强制点**——
> 平台控制台、hermes、任意 MCP 客户端的文件操作全部经它咽喉，在此执法一次覆盖全部调用方。
> 明确不引入：`unified-auth-service`（服务 A）——与平台 IAM/OIDC 完全重叠，部署即制造第二身份源，
> 违背"组织主数据单一事实源"。

---

## 〇、现状基线（已核实，2026-08-29）

| 事实 | 证据 | 对本计划的意义 |
|---|---|---|
| 6 个 hermes agent 已按平台维度接入并 online | `GET /api/agents`：元冰可nas(0.196)/财务(0.191)/战略(0.192)/产品营销(0.193)/研发(0.194)/智造质量(0.195) | 附件"平台"维度已物化，无需再建平台映射层 |
| 6 台 NAS 已纳管 online，rootPath=/ | `GET /api/nas` | 网关唯一通道 + 资产级 rootPath 收敛已存在 |
| 网关令牌已支持绑定 NAS / 绑定 NAS 账户 | 网关 `src/tokens.js` 条目 `{token,name,nasIp,accountId,createdAt}`；`http.js:117-128` 凭据解析 | DSM 账户兜底是**现成配置能力**，零代码 |
| IAM 有组织树 + 钉钉连接器实时同步 + `bindings` 三方身份映射 | `plugin-iam/src/index.ts`（OrgRecord.customFields / UserRecord.bindings / linkIdentity） | "取身份"是现成查询；缺的只有"负责人"字段 |
| 平台有审批中心 + 审计 + 告警规则 | plugin-audit / `ctx.audit.record` | share 审批闭环、高危留痕、拒绝告警复用，不新建 |
| 教训：身份参数不能进模型工具参数层（P0-2） | 2026-08-28 连接器架构审查 | 网关/hermes 传身份一律用请求头注入，禁止作为工具参数 |

---

## 一、目标与非目标

**目标**

1. 附件 RBAC 全部语义（角色推导、操作矩阵、特殊账号、C 叠加、灰度）成为**平台配置资产**，可管理、可审计、可灰度，不在任何 agent/网关侧维护副本。
2. 文件操作强制点收敛到网关（MCP 咽喉），一次实现覆盖平台控制台 / hermes / 未来任意 MCP 客户端；hermes 本地直读通道单独设 guard 兜底。
3. 判定引擎采用服务 B 的五步判定序（显式例外优先于角色矩阵，例外可过期），拒绝理由可解释、可审计、可告警。
4. 全链 fail-closed：平台决策不可达时默认拒绝（灰度期可配降级只读）。

**非目标（本期不做）**

- 不做 NAS 文件级 ACL 同步（DSM 原生权限作为兜底层，不做双向同步）；
- 不改 `/api/nas/:id/fs/*` 既有端点契约（向后兼容，见 §2.4 迁移策略）；
- 不部署服务 A/B 本体，不新增 Python 运行时。

---

## 二、总体设计

### 2.0 架构总览

```
                 ┌────────────── 决策点 PDP（平台 plugin-nas/nasAuthz）──────────────┐
                 │ 五步判定序 + 角色矩阵 + 资源级例外(可过期) + 特殊账号规则           │
                 │ 数据源：IAM 组织树/负责人/三方身份映射（单一事实源）+ 规则配置集合  │
                 └──────▲──────────────────────────────▲───────────────────────────┘
                        │ POST /api/nas/authz/check    │ GET /api/nas/authz/scope
                ┌───────┴────────┐            ┌────────┴─────────┐
                │ 强制点① 网关   │            │ 强制点② hermes   │
                │ (filestation   │            │ 本地直读 guard   │
                │  -mcp 钩子)    │            │ (apply_patch6)   │
                │ 覆盖：控制台/  │            │ 仅覆盖不经过网关 │
                │ hermes MCP 通道│            │ 的本地文件工具   │
                └───────┬────────┘            └────────┬─────────┘
                        ▼                              ▼
                 DSM 原生权限（令牌绑定 NAS 账户，粗粒度兜底，零代码）
```

### 2.1 决策服务 `NasAuthzService`（plugin-nas 新增 `src/authz.ts`）

```ts
export class NasAuthzService extends Service {
  static readonly provide = 'nasAuthz'
  // inject: opsStorage / iam / audit / platformBus
}
```

**角色推导**（附件第三章，纯函数，无人员名单配置）：

| 层级 | 推导规则 |
|---|---|
| P | 用户是某**平台级**组织（组织树深度=1，可配置）的负责人 |
| D | 用户是某**部门级**组织（深度=2）的负责人 |
| T | 用户是某**职能组/班组级**组织（深度≥3）的负责人 |
| M | 挂在深度≥3 组织下的非负责人成员 |
| C（叠加标签） | 命中指定**动态用户组**（iam groups，按 orgIds/title 圈人）——不新建名单，消除影子权限 |

- 负责人来源：`OrgRecord.leaderUserIds?: string[]`（新增可选字段，钉钉连接器同步 `dept_manager_userid_list`；兼容读取 `customFields['leaderUserIds']` 逗号分隔）。
- 附件第五章特殊账号在推导**之前**执行：
  - `UserRecord.accountType === 'external'`（新增可选字段）→ 白名单目录 readonly，白名单外 deny；
  - 未落班组（挂在深度=2 部门根且非负责人）→ 部门根目录 readonly；
  - 挂根组织（深度=1 非负责人）→ deny 全部；
  - 可疑标记（`accountType === 'suspended-review'`）→ deny + 审计事件转人工复核。

**作用域推导**（目录即权限）：

- NAS 资产新增接入组属性 `orgRoot`（平台级组织名或 orgId，如「智造平台」）：用户组织祖先链命中 `orgRoot` → 该 NAS 在作用域内，目录子树 = `rootPath` + 组织链自 `orgRoot` 起的名字拼接（`/智造平台/生产部/总装12线`）；
- 未命中任何 NAS 的 `orgRoot` → 对该 NAS 全 deny；
- 多 NAS 现实：check 入参必须带 `nasId`，作用域 = 资产 rootPath ∩ 组织子树。

**操作映射**（附件七类操作 → 网关工具面）：

| op | 网关工具 | 参数中的路径字段 |
|---|---|---|
| read | fs_list / fs_list_shares / fs_get_info / fs_search | folder_path / path[] |
| download | fs_download | path[] |
| write | fs_create_folder / fs_upload | folder_path+name / dest_path |
| modify | fs_rename / fs_copy_move / fs_compress / fs_extract | path[] |
| delete | fs_delete | path[] |
| share / admin | 网关工具面不存在 → 网关侧恒 deny；平台侧 share=例外审批产物，admin=规则管理权限点 | — |

**判定序（服务 B 语义移植，每步产出 reasons）**：

```
1. 账号特殊规则（附件第五章）          → deny / 白名单 readonly
2. 资源级显式 deny（nasId+path，支持尾部通配）→ deny
3. 资源级显式 allow（含 C 跨域白名单、临时授权，可设 expiresAt）→ allow
4. 角色矩阵 MATRIX[role][op] × 作用域边界（路径超出子树 → deny）
   （附件第四章矩阵为内置默认值；readonly 语义 = read/download 放行、写类 op 拒绝）
5. 默认 deny
```

**数据落点**：

| 集合 | 内容 |
|---|---|
| `nas:authzRules` | 单例配置：矩阵覆盖项、例外列表（allow/deny × nasId × path 通配 × expiresAt × 事由）、C 角色关联的动态用户组 id、灰度开关（`observeOnly` / `degradeAllToReadonly`） |
| `nas:authzDecisions` | 高危 op（delete/share/admin）与全部 deny 的判定留痕（decision/role/scope/reasons/调用方）——与 `audit.record` 互补：audit 记"谁改了规则"，decisions 记"每次判定为什么" |

- 事件：`nas.authz.denied`（bus 新前缀，接告警规则：短窗口高频 deny → 告警，识别异常账号/探测行为）。
- 种子：`POST /api/nas/authz/rules/import` 吃 `hermes_nas_rbac_rules.json`（与文档等价的 JSON），转矩阵默认值 + 例外种子。

### 2.2 IAM 扩展（plugin-iam）

1. `OrgRecord` 增加可选 `leaderUserIds?: string[]`；钉钉连接器部门同步时写入 `dept_manager_userid_list` 映射结果（连接器目录映射已有 remoteId → 本地 org 的通道，补一个字段透传）。
2. `UserRecord` 增加可选 `accountType?: 'internal' | 'external' | 'suspended-review'`（默认 internal）；管理端可维护，外部顾问/合作方账号打标。
3. 不新增权限点模型，不建第二份人员名单——C 角色直接引用既有动态用户组。

### 2.3 REST 端点（plugin-console，挂在既有 `/api/nas` 路由组之后）

| 端点 | 权限点 | 说明 |
|---|---|---|
| `POST /api/nas/authz/check` | `nas.authz.check`（新） | 入参 `{nasId, userId, paths[], op}`；身份解析支持平台 userId 与钉钉 userId（`bindings` 三方身份映射反查）；返回 `{decision: allow/deny, role, scope, reasons[], ruleId?}`。批量语义天然覆盖（paths[]） |
| `GET /api/nas/authz/scope` | `nas.authz.check` | `{nasId, userId}` → 可见目录子树 + 角色，hermes/控制台据此收敛 list/search 枚举范围 |
| `GET/PUT /api/nas/authz/rules` | `nas.authz.read` / `nas.authz.write`（新） | 规则配置读写，PUT 走 `audit.record` + changeLog |
| `POST /api/nas/authz/rules/import` | `nas.authz.write` | 导入 `hermes_nas_rbac_rules.json` |
| `POST /api/nas/authz/exceptions` | `nas.authz.write` | 申请型例外（share 审批通过后由系统写入，见 §2.7） |

- 内置角色：`resource_admin += nas.authz.*`；`auditor += nas.authz.read`。
- 调用方身份：网关与 hermes 各持一个**专用资源管理员账号**（与平台"日常接入不用 admin 常驻"的既有规范一致），权限最小化到 `nas.authz.check + nas.read`；on-behalf 真实用户身份经请求头传递（见下），**绝不作为工具参数**（P0-2 教训）。
- 破窗：持 `nas.authz.write` 的运维可在 check 请求带 `override=true` 走 P 判定并强制留痕（网关侧映射为运维专用令牌，用于故障处置），默认关闭。

### 2.4 强制点①：网关鉴权钩子（synology-filestation-mcp 仓库改造）

新增 `src/authz.js`（`AuthzClient`）+ `http.js` 插钩：

- **位置**：`matchToken` 解析 `req.tokenEntry` 之后、JSON-RPC tools/call 分发之前，对 §2.1 操作映射表中的工具逐个提取路径参数，调平台 check。
- **身份传递**：请求头 `X-On-Behalf-User: <钉钉 userId 或平台 userId>`，由调用方（hermes 适配器 / 平台 plugin-nas 客户端）注入。
- **迁移策略（不破坏现状）**：nas-tokens.json 条目增加 `enforce: boolean` 字段（缺省 false）——按令牌逐个开启强制；另有环境变量 `AUTHZ_ENFORCE=on/off` 全局开关（kill-switch）。`enforce=false` 且无 on-behalf 头的请求维持现状直通（观察模式）。
- **缓存与降级**：read/download 决策内存缓存 TTL 300s；写类与 delete 不缓存；平台不可达 → fail-closed（`PDP_UNREACHABLE=deny` 默认，灰度期可配 `readonly`：放行读、拒绝写）；deny 响应带 reasons 透传给客户端。
- **测试**：新增 `test/authz-smoke.mjs`——进程内 stub 平台 PDP + 既有 NAS stub，覆盖：矩阵正/负向、超边界 deny、C 叠加 readonly、例外过期失效、PDP 不可达 fail-closed、enforce 逐令牌迁移、无 on-behalf 头直通。

### 2.5 强制点②：hermes 本地直读 guard（apply_patch6.py）

hermes 容器（NAS 上）直接读本地文件的通道不经过网关，需单独设防：

- 在钉钉适配器**文件工具调度层**包 guard（两条通道：本地直读 + MCP，都必须拦在调度层）；身份取自消息 `sender_staff_id`，调用平台 check 用 agent 自己的机器凭证（client-credentials 令牌缓存刷新）；
- deny → 复用 patch4 卡片链路回拒绝理由（含申请入口提示）；平台不可达 fail-closed（灰度期可配 readonly 降级）；
- 按既有补丁规范：幂等标记、备份、`py_compile` 校验、本地 fixture 自测，进 `/opt/data/hermes-dingtalk-patch/apply.sh`，6 实例共享同一脚本（各实例配自己的平台地址与凭证 env）。
- **长期方向**：hermes 本地直读工具下线、统一走网关 MCP 通道后，本补丁退役为兜底（在计划内但不阻塞本期验收）。

### 2.6 兜底层：DSM 原生权限（零代码，先行配置）

- 为每平台 hermes 令牌绑定权限收敛后的 DSM 账户（网关管理界面 nas-accounts.json + 令牌 `accountId` 绑定，能力现成）；
- 分层语义：平台决策管**精细边界**（角色×目录×操作），DSM 兜底管**粗粒度灾难防护**——前两层被绕过时仍挡住跨平台目录访问。本期先为 6 个 hermes 令牌完成绑定。

### 2.7 share 审批闭环（复用平台审批中心 + 可过期例外）

附件规定 T/M share 默认 deny、需走审批。落地为：

```
成员向 hermes 提"分享 XX" → 网关 guard deny（reason: share-needs-approval）
  → 卡片给「申请分享」入口 → hermes 调 POST /api/nas/authz/exceptions（status=pending，
     自动生成平台审批单，复用 plugin-audit 审批中心）
  → 持 approval.decide 的 D/P 审批通过 → 例外写入 nas:authzRules
     （allow × share × nasId × path × expiresAt 默认 7 天，事由留痕）
  → 令牌重试分享操作放行；到期自动失效
```

- 可选增强（不阻塞验收）：用 dingtalk-robot-oauth 模块的 jumprobot 协议做"审批完成卡片唤起钉钉回到会话"的体验闭环。

### 2.8 控制台与 CLI

- 控制台：NAS 板块新增「数据权限」页（矩阵覆盖项编辑、例外列表含过期倒计时、`observeOnly`/`degradeAllToReadonly` 开关、按用户查 scope/试算 check）；NAS 详情抽屉加"角色预览"（选用户 → 显示推导的 P/D/T/M + 作用域 + reasons）。
- CLI：`dshctl nas authz check --nas= --user= --path= --op=`、`nas authz rules get|set|import`、`nas authz scope --nas= --user=`。

---

## 三、实施步骤（执行序）

| # | 步骤 | 落点 | 仓库 |
|---|---|---|---|
| 0 | DSM 账户兜底绑定（先行，零代码） | 网关管理界面 + nas-accounts.json | 网关部署侧 |
| 1 | IAM：leaderUserIds / accountType + 连接器同步负责人 | packages/plugin-iam | ybkkasi |
| 2 | 决策服务 NasAuthzService（推导/判定序/例外/事件/种子导入） | packages/plugin-nas/src/authz.ts + index.ts 导出 + inject 增 'iam' | ybkkasi |
| 3 | NAS 资产 orgRoot 接入组属性（schema access 组） | packages/plugin-nas/src/schema.ts | ybkkasi |
| 4 | REST：check/scope/rules/import/exceptions + 权限点/内置角色 | packages/plugin-console + plugin-iam | ybkkasi |
| 5 | selftest 引擎用例（见 §四）+ rules 种子文件入库 | tests/selftest.mjs、seed | ybkkasi |
| 6 | 网关 authz.js 钩子 + enforce 令牌字段 + authz-smoke 测试 | src/authz.js、src/http.js、src/tokens.js、test/ | synology-filestation-mcp |
| 7 | 平台侧调用方接线：plugin-nas 客户端透传 X-On-Behalf-User；控制台 fs 端点带当前用户 | packages/plugin-nas/src/client.ts、plugin-console fs 路由 | ybkkasi |
| 8 | hermes apply_patch6 本地 guard | NAS 持久卷 /opt/data/hermes-dingtalk-patch/ | hermes 部署侧 |
| 9 | share 审批闭环（exceptions + 审批单联动） | plugin-nas + plugin-audit | ybkkasi |
| 10 | 控制台「数据权限」页 + CLI 扩展 + 文档（README/本文档） | public/js、examples/dshctl.mjs | ybkkasi |

依赖关系：2 依赖 1；4 依赖 2/3；6 依赖 4（联调）；8 依赖 4；9 依赖 4。步骤 0 与 1 可并行先行。

---

## 四、测试计划

**selftest 新增分节（ybkkasi，引擎与 API 层）**：

- 角色推导：平台/部门/班组负责人 → P/D/T；挂根非负责人 → deny；未落班组 → 部门根 readonly；
- 判定序：显式 deny 通配 > 显式 allow > 角色矩阵 > 默认 deny；readonly 语义（write/modify/delete/share 拒、read/download 放）；
- 例外：expiresAt 过期即失效；C 叠加（动态用户组成员）跨域 readonly、白名单目录写需显式 allow；
- 边界：路径超出组织子树 deny；多 NAS：A 平台用户对 B 平台 NAS deny；
- 身份：钉钉 userId 反查（bindings）与平台 userId 等价；无 `nas.authz.check` 权限 403；override 留痕；
- API：rules PUT 审计留痕；import 幂等；scope 返回与 check 一致。

**网关 authz-smoke（独立跑）**：矩阵正/负向、路径提取（folder_path/path[]/dest_path 三种形态）、读缓存/写不缓存、PDP 不可达 fail-closed、enforce=false 直通、on-behalf 传递正确性。

**hermes 补丁本地自测**：fixture 两轮（应用→幂等跳过）；guard 拦截两条通道；deny 卡片渲染 reasons。

**真实环境联调（同网段）**：

1. 平台侧用 admin 试算：各平台负责人/普通成员/外部账号对 6 台 NAS 的 check 结果与组织架构核对；
2. 网关：hermes 令牌先 enforce=false 观察模式跑 1 天（deny 仅告警不拦截），核对告警无误报后逐令牌 enforce=true；
3. hermes 本地 guard 灰度一个实例（智造质量平台 0.195，组织层级最深、班组样本最全）验证后推全量。

---

## 五、灰度方案（附件第八章的工程化）

| 阶段 | 动作 | 退出条件 |
|---|---|---|
| G0 | DSM 兜底绑定 + 决策服务上线 `observeOnly=true`（check 可查、网关不强制，deny 只进告警） | 告警跑 3~5 天无误报 |
| G1 | 网关逐令牌 enforce（先 hermes 6 令牌，后控制台透传） | 各令牌 1 天无阻断事故 |
| G2 | hermes 本地 guard 灰度 1 实例 → 全量 | 1 实例 3 天 |
| G3 | `degradeAllToReadonly=true` 全量降级观察（allow 视作 readonly） | 1~2 周 |
| G4 | 放开写权限，转入常态运营（每日核对 deny 告警 + decisions 留痕抽查） | — |

任一阶段出问题：网关 `AUTHZ_ENFORCE=off`（全局）或单令牌 `enforce=false` 秒级回退；平台侧规则可 PUT 回滚（留痕）。

---

## 六、边界与后续

- share/admin 在网关工具面不存在：网关对未知 op 恒 deny；分享能力将来若落地为网关工具（如 fs_share_link），直接复用 §2.1 映射表加一行；
- 多租户：本计划按单租户（t_default）实现；`nas:authzRules` 预留 tenantId 字段，租户化时决策服务按租户取规则；
- 决策性能：网关与平台同网段，同步 check 实测延迟 <50ms 量级；若后期 hermes 高频 list 出现压力，优先加读缓存 TTL，不做规则副本下发（守住单一事实源）；
- 机器身份令牌 scope 模型（agent 机器凭证直接持 `nas.authz.check`）为平台后续演进项，本期以专用资源管理员账号过渡；
- hermes 本地直读工具下线、统一网关通道后，apply_patch6 退役为兜底（roadmap 项）。

---

## 七、验收清单

- [ ] IAM：负责人字段随钉钉同步落库；外部账号可打标
- [ ] selftest 引擎分节全绿；`npm run lint:manifests` 通过
- [ ] `POST /api/nas/authz/check` 对附件矩阵全部 35 个（5 角色×7 操作）判定与文档一致，每个响应含 reasons
- [ ] 网关：enforce 令牌的越权写被拒且响应含理由；无 on-behalf 且 enforce=false 的既有调用零破坏
- [ ] PDP 停机演练：网关 fail-closed、hermes fail-closed（或配置的 readonly 降级）生效
- [ ] hermes guard：本地直读通道越权被拦、拒绝卡片含理由与申请入口
- [ ] share 审批：T/M 申请 → 审批通过 → 例外生效（含过期）→ 到期自动拒绝，全程留痕
- [ ] 灰度：G0→G4 各阶段开关生效，回退路径演练通过
- [ ] 6 个 hermes 令牌完成 DSM 账户兜底绑定
