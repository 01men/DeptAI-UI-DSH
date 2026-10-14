# 开发计划：连接器纳管（open-connector 融合）——数据面网关 + 凭证托管 + 双层授权

> 版本：v1.0（2026-08-27）· 关联需求：roadmap 第 9 步之二「连接器市场」数据面执行缺口 · 参考实现：[oomol-lab/open-connector](https://github.com/oomol-lab/open-connector) v1.4.0（Apache-2.0，1,000+ Provider / 10,000+ Action 目录、OAuth 全流程、凭证保险库、oct_ 运行时令牌）
> 前置评审：《评审报告：元冰可 × open-connector 融合开发计划》（2026-08-27）——结论「批准按蓝图撰写」，P0/P1/P2 修正项已全部落实进本文（§〇 事实核验、§一 决策变更注记、§2.2 强制配置、§2.11 M0 端点修正、§2.12 manual-settlement 锁定等，逐条位置见文末自查表）。

---

## 〇、需求可行性确认结论（先回答，再实施）

| 问题 | 现状 | 结论 |
|---|---|---|
| **数据面执行**（1,000+ SaaS Provider 的真实调用） | 平台侧：roadmap 第 9 步之二「连接器市场」仅设计（📐）未交付，仓库无任何 SaaS 连接器执行层（全仓库无 `packages/plugin-connector`） | ✅ 可行，本次引入 open-connector v1.4.0 作 sidecar 数据面网关：`POST /v1/actions/:actionId` + `/api/connections` + `/api/oauth/authorizations` + `/api/runtime-tokens` + `/api/runs` + `POST /mcp`（全部端点经评审逐条核验属实，见下表） |
| **凭证托管** | 平台现状：全仓库无加密存储——iam 身份源 `connector secretActual`、mcp 服务 `headers`（含 Authorization）均为明文 JSON 落库（plugin-mcp `McpServiceRecord.headers` L40-41，脱敏仅在展示层 `maskServiceHeaders()` console L69-79） | ✅ 可行且更优：凭证交 open-connector 凭证保险库（`OOMOL_CONNECT_ENCRYPTION_KEY` → AES-256-GCM 加密 `connect.sqlite`），平台只存连接引用（provider/alias/status，无凭证字段）。open-connector 即 roadmap 设计中的「密钥库升级位」落地 |
| **治理面**（RBAC/权限组/审批/计量/审计/市场） | 已交付：`PermissionCatalog`（plugin-iam/src/index.ts L147-204）、`McpPermGroup` 权限组模型（plugin-mcp/src/index.ts L63-74）、审批中心 `registerExecutor`（plugin-audit/src/index.ts L389-392）、计量管道 `usage.record`（plugin-usage/src/index.ts L47-64）、四类审计 + actChain（plugin-audit L18/L31）、市场 L0 门禁 + `install(approvedCapabilities)` + `manual-settlement` 挂账（plugin-market L156/L407-411/L441-452） | ✅ 全部复用，零自研；本次只做「连接器域」的映射与接线 |
| **三端调用** | REST 网关（console `guarded()` L184-195）+ REST 工具桥（`POST /api/tools/execute` L2547-2567）+ 平台 MCP Server（`POST /mcp` L2609-2676）已有；工具注册进 `ctx.tools` 即三端自动同契约（tools-lite.ts `defineTool` L173） | ✅ 可行，`connector_*` 工具一签三端，权限点由 spec.permission 声明、桥/端点强制 |
| **部署** | 平台单进程 `node src/main.ts`（Node ≥ 22.6 原生 TS）；同机文件网关 sidecar 有 NAS 先例（synology-filestation-mcp） | ✅ 可行：平台 + open-connector sidecar 同机双路径——docker compose（`ghcr.io/oomol-lab/open-connector`，pin `v1.4.0`，volume `connector-data:/app/data`）或 node 直跑（SQLite 默认，`<DATA_DIR>/connect.sqlite` 打开自动迁移） |

### 关键事实核验表（评审 §一 结论固化）

| 依赖事实 | 核验 | 依据 |
|---|---|---|
| open-connector Apache-2.0 / v1.4.0 / 1,000+ Provider、10,000+ Action | ✅ 属实 | GitHub API + README 官方口径（2026-08-27 核验） |
| AES-256-GCM 凭证加密 | ✅ **有条件**：仅 `OOMOL_CONNECT_ENCRYPTION_KEY` 设置时启用；未设置则明文落盘 + 启动告警不阻断 | docs/credentials.md —— 故列为 sidecar **强制配置**（§2.2） |
| `OOMOL_CONNECT_ADMIN_TOKEN` 管 `/api/*`、`/docs`、Web Console | ✅ 属实，不配置则管理面裸奔 | docs/configuration.md —— 同列强制配置 |
| oct_ 运行时令牌：值仅创建时返回一次、库中只存 sha256 哈希；`POST/GET/PUT/DELETE /api/runtime-tokens` | ✅ 属实 | docs/runtime-api.md |
| 令牌级 action 规则支持 `service.*` / 精确 id / `*` 通配 | ✅ 属实（readTokenPolicy，connect-server.ts L928-960 证实）——权限组 pattern **可直传**令牌 | 探查档案 D §1（评审 P1-④「通配符未知」经档案探查更正为「已证实支持」） |
| `allowedConnections` 绑定稳定不透明连接 ID，越权在凭证加载前 `403 connection_not_allowed` | ✅ 属实；PUT 必须四个数组全发（不会丢既有 allowedConnections 限制） | docs/runtime-api.md / docs/configuration.md |
| `Idempotency-Key`（24h 重放窗口）+ `meta.executionId` 回传 | ✅ 属实；`meta.auditPersisted=false` 表示结果有效但审计未落库 | docs/runtime-api.md |
| `GET /api/runs` 含 `runtimeTokenId`/`policy` 字段，cursor 分页；`caller` 仅 http/mcp/web 入口，**不含终端用户身份** | ✅ 属实；保留上限 `OOMOL_CONNECT_RUN_LIMIT`（默认 5000 轮转） | docs/runtime-api.md —— 决定对账口径（§2.6） |
| OAuth 授权端点返回字段为 `authorizationUrl` + `state`；未先存 client 配置 → `400 oauth_client_config_required` | ✅ 属实 | docs/runtime-api.md |
| `POST /api/mcp/import`（平台侧端点） | ✅ **真实存在**：console/src/index.ts L1279-1293 + plugin-mcp `importServices()` L350-407；仅 plugin-mcp `manifest/api.yaml` 摘要漏列 | 探查档案 A §一（评审 P0-② 的事实更正：端点存在，需在 #6 补登 api.yaml 摘要） |
| 平台 `bus.ts` 已预留 `connector.` 事件前缀 | ✅ 属实 | platform-core/src/bus.ts L72-76 `PLATFORM_RESERVED_PREFIXES` |
| 上游迭代速度：建仓两个月 13 个 release | ✅ 属实 | 故「版本锁定 v1.4.0 + client.ts 适配层隔离 + 契约锁定测试组」（§五、§四 T-01） |

**上游文档未载项（如实声明）**：`GET /api/runs/:id` 不存在时的状态码未载；`PUT /api/connections/:service` 与 `POST /api/oauth/authorizations` 的成功状态码未载（按默认 200 处理并在 client.ts 断言信封 `success:true`）；action 无 risk 分级字段（riskLevel 由平台侧映射，§2.4）。

---

## 一、背景与目标

1. **控制面/数据面分工（本计划最核心决策）**：元冰可 = 治理控制面（双轨身份 + RBAC + 连接器权限组 + 高危审批 + 计量计费 + 审计 + 市场）；open-connector v1.4.0（Apache-2.0）= 连接器数据面网关 + 凭证保险库（1,000+ Provider / 10,000+ Action 目录、OAuth 全流程、oct_ 运行时令牌、`/v1/actions/:actionId` + `/api/connections` + `/api/oauth/authorizations` + `/api/runtime-tokens` + `/api/runs` + `POST /mcp`）。两者能力零重叠、强互补：不自研 provider 目录、不自研 OAuth、不自研密钥库，全部研发预算投在平台独有的治理语义上。
2. **三条红线**：
   - **凭证零进平台**：平台任何集合（含 `data/` 目录）不落 provider 凭证；API Key 表单代理直达 sidecar，OAuth 全程在 sidecar 完成，平台只见连接引用。
   - **授权双出验证**：平台侧（RBAC `connector.invoke` → 连接器权限组 → 高危审批 → 限流 → `billing.precheck`）与数据面侧（oct_ 令牌策略镜像：`allowedActions` + `allowedConnections`）两层各自独立拒绝，任一层越权均 fail-closed。
   - **actChain 全链路审计 + 计量对账**：每次调用留 actChain + runId（= `meta.executionId`）；平台 `usage.record` 为计费事实源，open-connector `GET /api/runs` 按令牌维度做总量交叉校验 + 盗用检测（§2.6）。
3. **命名辨析注记（防止歧义，评审确认必要且正确）**：本计划的 `plugin-connector`（SaaS 连接器纳管）≠ `plugin-connect`（远程 dsh 接入）≠ iam `connectors`（钉钉等身份源连接器，`iam.connectorConfigs` / `PlatformEvents.ConnectorSynced = 'iam.connector.synced'`，bus.ts L58）。事件一律用 bus.ts 已预留的 `connector.` 前缀（bus.ts L72-76）。
4. **roadmap 决策变更注记（显式留痕）**：roadmap-9-10 第 45 行原设计为「凭证存平台密钥库（data 目录加密文件起步，KMS 升级位），连接器只见引用」。本计划修正为「**凭证存 open-connector 凭证保险库，平台只见引用**」——方向更安全（平台 `data/` 零密钥可泄、凭证责任边界清晰），open-connector 即原设计中的「KMS 升级位」落地形态。此为显式决策变更，非实现偏差。
5. **三个已确认决策**：① 授权模型 = 双层授权镜像（平台权限组 ↔ oct_ 令牌策略快照，§2.4）；② M3 市场化纳入实施排期（M2 之后由业务触发启动，尊重 v1.3 评审「商业化放缓」但不降级为纯设计；分成/订阅全程 **manual-settlement 挂账登记**形态，不引入任何自动扣款/真实支付通道，§2.12）；③ 凭证零进平台（红线一）。

---

## 二、总体设计

### 2.1 调用链架构

```
调用方（人 / Agent / App，REST / 工具桥 / POST /mcp 三端）
  │
  ▼
元冰可网关（plugin-console guarded 路由 + plugin-connector）
  ① authn 双轨身份校验（console/src/index.ts L143-166 http.use 中间件，写 exchange.principal 含 actChain）
  ② RBAC 权限点 connector.invoke（requirePermission L170-181，拒绝发 audit.authz.denied）
  ③ 连接器权限组授权（plugin-connector authorize()，对齐 McpPermGroup.authorize L688-716：
     user_group 经 ctx.iam.resolveGroupMembers() 展开，agent/app 直接比 id；
     allowedActions pattern 命中 + riskCap ≥ action.riskLevel + constraints 校验）
  ④ 高危审批门禁（riskLevel=admin 且未豁免 → createApproval({kind:'connector.action.admin'})）
  ⑤ 滑动窗口限流（对齐 plugin-mcp L734-743，key=<permGroupId>:<callerType>:<callerId>）
  ⑥ billing.precheck(orgId, estimate)（billing/src/index.ts L276-284，不足 → quota.exceeded）
  ⑦ 取/铸 oct_ 运行时令牌（策略 = 权限组快照：allowedActions + allowedConnections 绑定）
     └─ 401/403 connection_not_allowed → 按最新权限组快照 PUT 更新令牌 + 重试一次（§2.4）
  ▼
open-connector sidecar：POST /v1/actions/:actionId
  （Bearer oct_；写类自动带 Idempotency-Key；命名连接经 x-oo-connector-alias）
  ▼
SaaS Provider
  │◀──────── 响应（统一信封 success/data/meta{executionId, actionId, auditPersisted}）
收尾（plugin-connector）：
  usage.record({resource:'connector:<provider>', meters:[calls], idempotency_key, trace_id=meta.executionId})
  + audit（invoke 日志透传 actChain + runId，对齐 audit/src/index.ts L136-145 McpInvoked 先例）
  + 事件 connector.invoked
```

### 2.2 部署形态

- **sidecar 同机**：open-connector 与平台同机部署，双路径——
  - docker compose：镜像 `ghcr.io/oomol-lab/open-connector`（**生产 pin `v1.4.0`**，禁 `latest`/`tip`），`ports 3000:3000`，volume `connector-data:/app/data`；
  - node 直跑：`npm start`，SQLite 默认（`OOMOL_CONNECT_DATA_DIR/connect.sqlite`，打开自动迁移；PG 需 `OOMOL_CONNECT_DATABASE_URL` + `npm run runtime:migrate`，本期不默认）。
- **强制 env 清单（P0 修正①，缺一即 fail-closed）**：

| env | 作用 | 缺失后果（open-connector 原生行为） | 平台侧规则 |
|---|---|---|---|
| `OOMOL_CONNECT_ENCRYPTION_KEY` | AES-256-GCM 加密凭证/OAuth 配置/pending state/幂等响应 | 不阻断启动，仅打印警告，**凭证明文落盘** | 平台启动校验：缺失 → `connector:gateway` 标记不可用 + `connector.gateway.unhealthy` 告警 + **拒绝一切 invoke**（fail-closed）；selftest 断言（T-02） |
| `OOMOL_CONNECT_ADMIN_TOKEN` | `/api/*`、`/docs`、Web Console 管理面 Bearer 鉴权 | 管理面裸奔 | 同上 fail-closed 规则 |
| `OOMOL_CONNECT_ORIGIN` | OAuth 回调公共 origin | 回调 URL 错误 | 按部署拓扑配置（见下） |
| `OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH` | 允许连接级自备 OAuth App（`*` 或 service 清单） | 企业无法自带 client | 需要 OAuth 自备 App 时必须配置（§2.5） |
| `OOMOL_CONNECT_RUN_LIMIT`（默认 5000） | runs 保留上限（轮转窗口） | — | 对账周期必须远短于轮转周期（§2.6） |

- **`connector:gateway` 单例配置**（opsStorage 集合，运行期可改）：`{ baseUrl, adminToken, encryptionKeyConfigured }`。`adminToken` 值走 **`env:` 间接引用**——复刻 modelgw 的字段级一行式（plugin-modelgw/src/index.ts L102：`startsWith('env:') ? process.env[...slice(4)] : 原值`；档案 B §3.4 证实仓内无通用 loader，新插件自行复刻）。密钥值不落任何平台集合。
- **fail-closed 规则**：`connector:gateway` 未配置 / 两强制 env 缺失 / sidecar 探活失败（`GET /v1/health`）→ 网关状态不可用，invoke 一律拒绝（不降级、不绕过），并发 `connector.gateway.unhealthy` 事件 + 告警。
- **OAuth 回调两种拓扑**（如实声明，集成指南各给一份 runbook）：
  - 直连：企业浏览器可直达 sidecar（`OOMOL_CONNECT_ORIGIN=http://<sidecar>:3000`），`GET /oauth/callback?state=&code=` 由 sidecar 直接受理（成功后返回 HTML 完成页）；
  - nginx 反代：`OOMOL_CONNECT_ORIGIN=https://<平台域>/connector-gw`，反代仅转发 `/oauth/callback` 与 `/v1/health`（管理面 `/api/*` 不暴露公网），适配「平台域名统一出口」的企业网络。

### 2.3 新插件 `packages/plugin-connector`（业务域：SaaS 连接器纳管）

沿用「每个业务域 = 一个插件包」铁律；REST 路由集中在 plugin-console（仓内铁律：插件自身不注册 REST 路由，先例 plugin-mcp/plugin-nas，经 console `guarded()` L184-195 装配）。

```
packages/plugin-connector/
  plugin.yaml        id: dsh-plugin-connector；depends: [dsh-plugin-platform-core, dsh-plugin-iam,
                     dsh-plugin-audit, dsh-plugin-usage, dsh-plugin-billing]；provides: connectorHub
  package.json       { "name": "@dsh-ops/plugin-connector", "type": "module",
                       "exports": { ".": "./src/index.ts", "./*": "./src/*" } }（照抄 plugin-modelgw）
  src/client.ts      OcClient：v1.4.0 薄适配客户端（唯一感知上游契约处，版本锁定隔离层）
  src/index.ts       ConnectorHubService（provide: 'connectorHub'，ctx.connectorHub）+ 插件装配
                     （declare module '@deepseek-ai/cordis' 扩展 Context，先例 mcp L1047-1051）
  src/tools.ts       connector_* 工具（defineTool，注册进 ctx.tools → 三端自动同契约）
  manifest/…         契约五面（scripts/gen-manifests.mjs PLUGINS 数组加一条，npm run manifests 生成）
```

**OcClient 契约面（client.ts，对齐 dossier D §0-8 的 v1.4.0 端点清单）**：

| 方法 | 上游端点 | 说明 |
|---|---|---|
| `health()` | `GET /v1/health` | 探活（`{success:true,data:{ok:true,runtime:"oomol-connect"}}`） |
| `listProviders()` / `listActions(service?)` / `getAction(id)` | `GET /v1/providers`、`GET /v1/actions[?service=]`、`GET /v1/actions/:actionId` | 目录同步（含 `requiredScopes[]`/`providerPermissions[]`/`inputSchema`） |
| `getActionGuide(id)` | `GET /api/actions/:actionId/agent.md` | 连接向导代理展示（admin 接口，不过滤） |
| `upsertConnection(service, {authType, connectionName?, values})` / `deleteConnection(service, connectionName?)` / `listConnections()` | `PUT/DELETE /api/connections/:service`、`GET /api/connections` | 响应 ConnectionSummary `{id, service, connectionName, authType, configured, virtual, default, profile}`——`id` 即 allowedConnections 引用的稳定不透明 ID；凭证永不回显 |
| `createOAuthAuthorization({service, connectionName?, clientId?, clientSecret?, requestedScopes?, extra?, secretExtra?})` | `POST /api/oauth/authorizations` | 响应 `{authorizationUrl, state}`；未存 client 配置 → `400 oauth_client_config_required` 透传给向导 |
| `createRuntimeToken(policy)` / `updateRuntimeToken(id, policy)` / `deleteRuntimeToken(id)` / `listRuntimeTokens()` | `POST/PUT/DELETE /api/runtime-tokens[/:id]`、`GET /api/runtime-tokens` | policy 四数组 `allowedActions/blockedActions/allowedProxies/allowedConnections`（PUT 必须全发）；token 值仅创建时返回一次 |
| `executeAction(actionId, {input, alias?, idempotencyKey?}, oct)` | `POST /v1/actions/:actionId` | Bearer oct_；`x-oo-connector-alias` 选命名连接；响应 `meta.executionId/auditPersisted` |
| `listRuns({limit, cursor?, service?, actionId?, ok?})` | `GET /api/runs` | `{items: RunLog[], nextCursor?}`；RunLog 含 `runtimeTokenId`、`policy`、`id(=executionId)` |

统一信封处理：成功 `{success:true,data,meta}`；失败 `{success:false,errorCode}`（`connection_not_allowed`→403、`rate_limited`→429、`oauth_token_expired`→409、`unknown_action`→404 等错误码表逐条映射为平台错误）。

**存储集合**（`ctx.opsStorage.collection`，命名惯例 `<插件>:<名>`）：

| 集合 | 内容 | 要点 |
|---|---|---|
| `connector:gateway` | 单例：baseUrl + adminToken（`env:` 间接引用）+ 健康状态 | 缺强制 env → status=unavailable（fail-closed） |
| `connector:connections` | 连接引用：`{ provider, alias, authType, status, ownerOrgId, createdBy, ocConnectionId }` | **无凭证字段**（红线一）；alias 强制 `org:<orgId>:` 前缀（§2.4 org 三件套①） |
| `connector:catalog` | 目录缓存：providers + actions（含 `requiredScopes`/`providerPermissions` 映射出的 `riskLevel`） | 由目录同步任务维护（#3） |
| `connector:permGroups` | 连接器权限组（§2.4 schema） | — |
| `connector:tokens` | oct 台账：`{ permGroupId, ocTokenId, policySnapshotHash, createdAt, lastSyncedAt }` | **不存 token 值**（值仅创建时返回一次，铸令即失——重铸语义而非找回） |
| `connector:runs` | 对账缓存：按 runtimeTokenId 聚合的 run 计数 + cursor | 对账用（§2.6） |

### 2.4 双层授权镜像（核心设计）

**第一层（平台侧）——连接器权限组**（`connector:permGroups`，schema 对齐 `McpPermGroupRecord`，plugin-mcp/src/index.ts L63-74）：

```ts
interface ConnectorPermGroup extends RecordBase {
  name; description; orgId: string            // 权限组归属 org（org 隔离锚点）
  policies: Record<string, ProviderPolicy>    // provider → 策略
  subjects: Array<{ type: 'user_group' | 'agent' | 'app'; id: string; name?: string }>  // 复用三型
}
interface ProviderPolicy {
  allowedActions: '*' | string[]   // pattern 列表（支持 'github.*' / 精确 id / '*'）
  riskCap: 'read' | 'write' | 'admin'
  connections?: string[]           // 允许的连接 alias（须为本 org 前缀）
  constraints?: { readOnly?: boolean; denyParams?: string[] }
}
```

授权判定 `authorize()` 对齐 `McpService.authorize()`（L688-716）：`user_group` 主体经 `ctx.iam.resolveGroupMembers()` 展开；pattern 命中 + `riskCap` ≥ action.riskLevel + `constraints.readOnly`（readOnly 且 action.riskLevel!=='read' → 拒绝）+ `denyParams` 参数拦截（在平台侧强制，补上 mcp 侧「定义了但无强制点」的缺口）。

**第二层（数据面侧）——oct_ 令牌策略镜像**：

- **铸令**：按权限组铸造 oct_ 运行时令牌——`allowedActions` = 权限组 pattern **直传**（令牌级 `service.*`/精确 id/`*` 通配已证实支持，readTokenPolicy（connect-server.ts L928-960）；评审 P1-④「通配未知」经探查更正），`allowedConnections` = 该权限组可见连接的**稳定 ID 列表**（org 三件套②：每权限组独立令牌，天然绑定 org 边界），`blockedActions`/`allowedProxies` 按策略映射。令牌记录入 `connector:tokens` 台账（只存 ocTokenId + policySnapshotHash）。
- **「策略 = 权限组快照」语义（P1 修正⑤）**：权限组变更 → 用 `PUT /api/runtime-tokens/:id` 按最新快照更新策略（**四个数组必须全发**，PUT 不会丢既有 allowedConnections 限制），语义对齐 `authn.updateMachineScopes()` 的「scopes 调整联动吊销」（plugin-authn/src/index.ts L612-621）；仅当权限组被删除/连接被删除时才 `DELETE` 令牌。**目录 action 下架/改名**由目录同步触发巡检：受影响权限组的令牌同步 PUT 更新（T-04）。
- **自动恢复（P1 修正⑥）**：invoke 网关收到 `401` / `403 connection_not_allowed`（令牌失效/连接未授权）→ 按最新权限组快照 `PUT` 更新令牌 + **重试一次**；重试仍失败计入告警（`connector_error_rate`），对调用方透明。
- **org 隔离三件套（P1 修正⑦）**：① 连接别名强制 `org:<orgId>:` 前缀命名规范（写入 `connector:connections.alias`，创建时校验）；② 每权限组独立令牌，`allowedConnections` 精确绑定该权限组可见连接的稳定 ID（越权在 sidecar 凭证加载前即 `403 connection_not_allowed`）；③ 定时巡检「令牌绑定连接 ⊆ 权限组 org 内连接」（巡检任务拉 `GET /api/runtime-tokens` + `GET /api/connections` 与平台侧 `connector:connections` 比对），不一致即 `connector.gateway.synced` 异常告警（复用能力漂移检测思路，usage/src/index.ts L460-486）。
- **riskLevel 映射（P2 修正⑭）**：open-connector action **无 risk 字段**（文档未载项）——平台由目录同步时按 `requiredScopes[]`/`providerPermissions[]` 启发式映射（只读 scope 如 `*:read`/profile 类 → `read`；写 scope → `write`；管理/删除/权限类 → `admin`），叠加权限组模板标注；**无法判定的默认 `admin` 兜底 fail-closed**。

**权限组变更影响面提示（评审 2.2-3）**：变更确认时提示「将影响 N 个令牌 / M 个连接，在途调用会短暂失败后自动恢复」（对齐平台 dry-run 影响面预览惯例）。

### 2.5 连接管理

- **OAuth 代理全流程**：平台表单 → `POST /api/oauth/authorizations`（sidecar）→ 得 `{authorizationUrl, state}` → 用户在 provider 侧授权 → sidecar `GET /oauth/callback?state=&code=` 完成（凭证存为对应连接，永不回平台）→ 平台轮询/回调同步连接状态引用（`GET /api/connections` 比对 `configured/profile`）写入 `connector:connections`。**自备 App 成本写入向导（P1 修正⑩）**：自托管形态 OAuth provider 需企业先在 provider 侧注册 client 并存 client 配置（`PUT /api/oauth/configs/:service` + `OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH`），否则 `400 oauth_client_config_required`——向导按 provider 给出注册指引链接，并代理展示 `GET /api/actions/:actionId/agent.md` 指南（T-06）。
- **API Key / custom_credential 型**：表单按 provider `auth[].extraFields`/`fields` 契约渲染 → 平台代理 `PUT /api/connections/:service` **直达 sidecar 不落盘**（请求体过手不持久化，响应只存 ConnectionSummary 引用），回显脱敏（`slice(0,6)+'…'` / `'****'`，对齐 console `maskServiceHeaders()` L69-79 与 `maskNasEntity()` L81-86）。未知字段 sidecar 硬拒绝（fail fast）。
- **no_auth 型**：虚拟连接直接登记引用（无需凭证、无需令牌连接授权）。
- **org 归属隔离**：连接创建强制 `ownerOrgId` + alias `org:<orgId>:` 前缀；列表/详情按 org 过滤（跨 org 不可见，对齐平台 tenant 隔离惯例）。
- **删除**：代理 `DELETE /api/connections/:service`（body 带 connectionName）+ **权限组引用级联检查**（被任一权限组 `connections[]` 引用 → 提示先解绑或联动更新）+ 相关令牌 PUT 同步。
- **审批**：`connector.connect` 执行器（按 provider 可配是否需要审批，对齐 `mcp.offline` 先例 plugin-mcp L1060）。

### 2.6 计量计费

- **计量**：每次成功 invoke → `ctx.usage.record({ resource: 'connector:<provider>', meters: [{key:'calls', unit:'次'}], idempotency_key: 'connector:<runId>', trace_id: <runId> })`；**`trace_id = meta.executionId`**（P1 修正⑧，runId 取值确认 = executionId）；仅真实调用计量（对齐 mcp 仅 `exec==='real'` 计量先例 L860）。**resource 正则约束（P2 修正⑮）**：usage validate 的 resource 正则是 `/^[a-z]+:[A-Za-z0-9._-]+$/`（usage/src/index.ts:498）——`connector:<provider>` 的 provider 段必须满足该正则；open-connector service id 为小写数字连字符，天然兼容，写入设计约束（catalog 同步时校验，不合规 service 拒绝纳管）。
- **幂等链（P1 修正⑧）**：写类 action 自动生成 `Idempotency-Key`（`crypto.randomUUID()`，≤255B；带键时 input 嵌套 ≤100 层约束由 sidecar 强制）；同键重放 24h 窗口内返回原响应（含原 executionId）——平台重试不产生重复计量（幂等键去重）。**边缘情形**：`meta.auditPersisted=false`（结果有效但审计未落库）→ 平台侧补记审计并发 `connector_error_rate` 低阈值告警（T-28）。
- **价格簿**：`ensureDefaultPriceBook()`（usage/src/index.ts L387-399）加 `connector:*` 零费率条目起步（先例 `skill:*`/`nas:*` meter_key `calls` 0 费率，L388 逐条幂等不覆盖已改费率）；`record()` 硬校验「必须命中价格簿」（L156-163）——不加默认条目会被拒绝，故为 M1 必做。M2 计费开关：运营按需把特定 `connector:<provider>` 调整为非零费率。
- **precheck**：invoke 链第 ⑥ 步 `billing.precheck(orgId, estimate)`（billing/src/index.ts L276-284，先例 modelgw L97-99）；`principal` 为 `org:<id>` 时 billing 消费侧实时扣钱包（L105-126）。
- **对账口径（P1 修正⑦，定义清楚）**：平台 `usage.record` 为**计费事实源**（runs 的 `caller` 只标识 http/mcp/web 入口，不含终端用户身份，无法按用户/组织计费）；`GET /api/runs` 对账降级为**总量交叉校验 + 盗用检测**——按 `runtimeTokenId` 维度核对「runs 计数 ≈ 平台计量计数」，**有 run 无 meter = 绕行调用告警**（critical）。工程约束：`OOMOL_CONNECT_RUN_LIMIT` 默认 5000 轮转窗口，**对账周期必须远短于轮转周期**（默认 5 分钟）；cursor 分页（`encodeURIComponent(JSON.stringify({startedAt,id}))`）增量对账需按 run id 去重（cursor 重叠窗口）。
- **成本归集**：audit 消费端 `ctx.usage.consume('audit', …)`（audit/src/index.ts L222-239）加 `connector:` 前缀分支入 `audit:costs`；market `CAPABILITY_RESOURCE_MAP`（market/src/index.ts L230-233）加能力→`connector:*` 映射。

### 2.7 审批与审计

- **审批执行器**（`ctx.effect(() => ctx.audit.registerExecutor(...))`，audit/src/index.ts L389-392；现有 5 个先例 agent/app/mcp）：
  - `connector.connect`：新建连接（按 provider 可配开关）；
  - `connector.action.admin`：riskLevel=admin 的 action 调用（L4 级高危，approve 后同步执行 executor 完成调用）；
  - `connector.offline`：连接/网关下线。
- **审计**：全部写类操作 `changeLog()`（console L198-213 → `audit.record({type:'change'})`）；invoke 走事件驱动——`connector.invoked` 监听器透传 `caller.actChain` 进 invoke 日志（对齐 audit/src/index.ts L136-145 `McpInvoked` 先例），runId（= executionId）进 resourceId/detail（runId 无独立字段，audit L31 现状）。
- **事件**（`PlatformEvents` 加常量，bus.ts L27-69；前缀 `connector.` 已预留 L72-76）：`connector.gateway.changed / connector.gateway.synced / connector.gateway.unhealthy / connector.connected / connector.disconnected / connector.invoked / connector.permgroup.changed`。
- **告警**（metric 自由字符串注册即用，audit `evaluateAlerts` L312-325；需事件源主动调用，先例 audit L134 `mcp_unhealthy`）：`connector_error_rate`（invoke 失败率 + 自动恢复重试仍失败 + auditPersisted=false）、`connector_latency`（p95 超阈）。默认规则播种先例 `console/src/seed.ts:524-526`。

### 2.8 权限与角色（iam）

新增权限点（`PermissionCatalog` 追加，plugin-iam/src/index.ts L147-204；命名规范 `<域>.<资源>.<动作>`，invoke 为独立点，对齐 mcp 先例）：

| 权限点 | 组 | 说明 |
|---|---|---|
| `connector.gateway.write` | 连接器 | 网关配置（baseUrl/adminToken 引用）与健康操作 |
| `connector.catalog.read` | 连接器 | 目录浏览（providers/actions/schema/guide） |
| `connector.connection.read` | 连接器 | 连接列表/详情（org 内） |
| `connector.connection.write` | 连接器 | 新建/删除连接（含 OAuth 发起） |
| `connector.invoke` | 连接器 | 调用 action（独立点，对齐 `mcp.invoke`） |
| `connector.permgroup.write` | 连接器 | 权限组管理（对齐 `mcp.permgroup.write`） |
| `connector.runs.read` | 连接器 | 运行日志/对账视图 |
| `connector.market.publish` | 连接器 | （M3）连接器型插件上架 |

内置角色（`BuiltinRoles` L206-213）：`resource_admin += connector.*`；`developer += connector.catalog.read + connector.invoke`（invoke 读级由权限组 riskCap 兜底约束）；`auditor += connector.runs.read + connector.connection.read`。
**角色迁移（P2 修正⑯）**：`ensureBuiltinRoles()`（L885-891）**只插不更新**——生产已落库角色不会自动获得新权限点，需写一次性幂等迁移（先例：v1.6 `agent-scopes-usage-write-v1` 幂等迁移标记），迁移把 `connector.*` 补进 resource_admin、`connector.catalog.read/connector.invoke` 补进 developer、`connector.runs.read/connector.connection.read` 补进 auditor。

### 2.9 控制台 `#/connectors`（AI 资源分组，仿 mcp.js/nas.js）

新页面 `packages/plugin-console/public/js/pages/connectors.js`（导出 `renderConnectors`，骨架对齐 nas.js：`page-head` + `filter-bar` + `renderTable` + `openDrawer` 详情抽屉 + `openModal` schema 驱动表单，secret 字段编辑不回填）；注册点 `public/js/app.js`（import + `NAV` 数组 `{ path:'#/connectors', label:'连接器', icon:'plug', perm:'connector.catalog.read' }`，menus group `AI 资源` + 路由表 builders）。**页内分期（P2 修正⑬，评审 2.2-5）**：

- **M1 交付**：目录浏览器（1,000+ provider 搜索/分类筛选/action schema 与 agent.md 指南查看，只读）+ 连接卡片墙 + 连接向导（分 authType：OAuth 弹 authorizationUrl 跳转 + 各 provider 注册指引链接 + 代理展示 agent.md；API Key/custom_credential 表单代理直达、回显脱敏；no_auth 一键登记）+ 运行日志抽屉（runs 只读）+ 网关设置（`connector:gateway` 单例 + 健康状态 + 强制 env 校验提示）。
- **M2 交付**（与 oct 令牌联动一起上）：权限组管理 UI（policies 编辑、subjects 绑定、模板安装**二次确认**、变更影响面提示「将影响 N 令牌 / M 连接」）。
- **M0 打标（P2 修正⑬）**：经 MCP 桥接的 open-connector 服务在 `#/mcp` 与 `#/connectors` 均打「桥接过渡」徽章，hover 说明治理降级语义。

### 2.10 CLI（dshctl）

`examples/dshctl.mjs` 的 `COMMANDS` 加 `connector` 组（先例 nas 组：`run: async () => { const action = argv[0]; … }`，全局约定 `--output json|table`、`--yes`、`--url`，help.run() 用法文本加一段）：

```
connector gateway get | gateway set --base-url= --admin-token-env=OOMOL_CONNECT_ADMIN_TOKEN | gateway health
          catalog providers [--search=] | catalog actions --service= | catalog action <actionId> [--guide]
          connections list [--org=] | connections create --provider= --auth-type= [--alias=] [--api-key=|--oauth]
          connections delete <id> [--yes]
          execute --action=<actionId> [--connection=<alias>] [--input=@file.json] [--dry-run]
          perm-groups list | perm-groups get <id> | perm-groups create --file=@pg.json | perm-groups delete <id>
          runs [--service=] [--ok=false] [--limit=]      （运行日志/对账视图）
```

### 2.11 M0 桥接（零代码，连通性验证与过渡）

- **机制**：open-connector 的 `POST /mcp`（stateless JSON-RPC + JSON 响应，与平台 `/mcp` 同形态，天然兼容）经平台既有 **`POST /api/mcp/import`**（console/src/index.ts L1279-1293 + plugin-mcp `importServices()` L350-407——**事实更正（P0 修正②）**：该端点真实存在，评审曾误判不存在，实为 plugin-mcp `manifest/api.yaml` 摘要漏列；本计划照用该端点，并在 #6 接线工作单补登 api.yaml 摘要，连同 `sync-tools`、`DELETE` 等漏列端点）注册为 external MCP 服务（`exec:'real'`，endpoint 指向 sidecar `/mcp`，headers 携带 bootstrap/oct_ 令牌）。即刻获得：平台 Bearer 鉴权、MCP 服务级粗粒度权限组（`McpPermGroup`）、计量（`mcp:<slug>` 口径）、熔断探活（30s 轮询、连续 3 次失败开断）。
- **治理降级声明（P2 修正⑬，防「长期捷径」）**：M0 桥接只有 MCP 服务级粒度——**无 action 级授权、无连接级绑定、无 oct 令牌镜像、无连接器域计量/审计语义**。仅用于连通性验证与过渡期；生产纳管必须走 M1+ 原生链路。控制台对桥接服务打标（§2.9）。
- **产出**：`docs/connector-integration.md` 集成指南初稿（含部署拓扑、强制 env、OAuth 回调两拓扑 runbook、M0 操作步骤）。

### 2.12 M3 市场化（纳入实施排期，业务触发启动）

- **业务触发条件（可操作定义，P0 修正③）**：出现首个外部开发者提交连接器型插件上架申请，即启动 M3（对齐 v1.3「商业化放缓」——第 9/10 步商业化能力放缓实施但不取消；本里程碑在此之前保持设计就绪、代码不提前动工）。
- **manual-settlement 锁定声明（P0 修正③）**：M3 的分成/订阅**全程 manual-settlement 挂账登记形态**——复用 market `PluginSubscriptionRecord.channel: 'manual-settlement'`（market/src/index.ts L97-104，「资金通道未就位：先记账期权益，结算走人工对账单」，写入点 install() L441-452）与 billing `ledger/settle/reverse`（billing/src/index.ts L313-389）+ `COMMISSION_RATES.platform_default`（developerShare 0.2，L58-60）。**不引入任何自动扣款/真实支付通道**（与 v1.3 决策一致）。
- **连接器型 L0 插件（声明式，无代码）**：manifest 扩展 `connector` 声明字段——连接配置模板（provider + authType + 字段说明）+ actions 列表（pattern）+ 权限组模板（预设 `riskCap: read` readOnly 策略）。改动点：`plugin-market/src/index.ts` `PluginManifest` 类型（L43-62）、L0 分支（L156-170 放行 connector 声明形态、`CONTENT_BLOCK_RULES` 扫描范围 L113-118）、`contentHashOf`（L127）；`plugin-market/src/tools.ts` `market_plugin_list` 返回结构（L19-24）。
- **安装流程**：权限组模板预览 + **二次确认**——`install(approvedCapabilities)` 的 `approved ⊆ requested` 语义（market/src/index.ts L407-411「能力不在插件请求清单内」）**扩展到 actions 维度**：企业可裁剪 action 清单子集，安装后按 approved 快照铸权限组与 oct 令牌。安装副作用复用：`usage.grantCapabilities`（L423-425 经 `CAPABILITY_RESOURCE_MAP` 加 `connector:*` 映射）、价格簿（L426-439，`rate_version plugin:<id>:v<version>`）、manual-settlement 订阅登记（L441-452）、`market.plugin.installed` 事件（L453）。
- **自营订阅计价 + 第三方 L3 分成**：自营连接器型插件走 `seedOfficialPlugins()` 流水线（market L553-609）；第三方分成复用 billing settle 的 `plugin:` 资源分支（billing/src/index.ts L334-341 查 `market:submissions` developerId 贷 `developer:<id>` + `developerReceivable()` L392-398；如需 `connector:` 资源直接分成则在 settle 加分支——dossier C §1.4-5）。
- **市场 UI**：`public/js/pages/` 现无 market 页面（dossier C §4.5-4），M3 新建连接器市场页（或并入 `#/connectors` 的「市场」标签）。

---

## 三、实施步骤（执行序）

> 面向 AI 开发团队：不排人天，按里程碑 M0→M3 + 工作单执行；依赖关系无环，并行轨道见「并行轨道」列。验收标准编号关联 §四 断言清单（T-xx）。每里程碑末尾「里程碑 DoD」为门禁，未过不得进入下一里程碑。

### M0 —— 桥接验证（零代码，即时价值）

| # | 里程碑 | 工作单 | 落点（具体文件） | 依赖 | 验收标准 | 并行轨道 |
|---|---|---|---|---|---|---|
| 1 | M0 | 桥接验证 + 集成指南初稿：sidecar 部署（compose pin v1.4.0，强制 env 齐全）→ `POST /api/mcp/import` 注册 external 服务（endpoint=sidecar `/mcp`）→ 探活/工具发现/一次真实 execute_action；撰写 `docs/connector-integration.md`（部署拓扑、强制 env、OAuth 回调两拓扑、M0 步骤） | `docs/connector-integration.md`（新建）；端点 console/src/index.ts L1279-1293、plugin-mcp/src/index.ts L350-407 | 无（与轨道 0 并行启动） | T-25 | 轨道 1（桥接） |

**M0 DoD**：桥接服务 online 且 `mcp_invoke` 经平台权限组成功调用 1 个 no-auth action；集成指南初稿含强制 env 清单与 fail-closed 说明；桥接服务打标方案写入 §2.9 设计。

### M1 —— 主链路打通（client → 目录 → 连接 → invoke → 三端 → 控制台/CLI）

| # | 里程碑 | 工作单 | 落点（具体文件） | 依赖 | 验收标准 | 并行轨道 |
|---|---|---|---|---|---|---|
| 2 | M1 | **OcClient + 网关配置（奠基）**：client.ts 全契约面（§2.3 表）；`connector:gateway` 单例 + `env:` 间接引用（复刻 modelgw L102）；强制 env 校验 fail-closed；`GET /v1/health` 探活定时器 | `packages/plugin-connector/src/client.ts`、`src/index.ts`（ConnectorHubService provide/inject/apply）、`plugin.yaml`、`package.json`（照抄 plugin-modelgw） | 无（**最先启动**） | T-01、T-02、T-19 | 轨道 0（奠基） |
| 3 | M1 | 目录同步：providers/actions 拉取入 `connector:catalog`；riskLevel 映射（requiredScopes/providerPermissions，默认 admin 兜底）；resource 正则合规校验；目录变更（action 下架/改名）检测钩子 | `packages/plugin-connector/src/index.ts`（catalog 段）、`src/client.ts` | #2 | T-03（T-04 的检测半段） | 轨道 2 |
| 4 | M1 | 连接管理：OAuth 代理全流程（authorizations → authorizationUrl → 回调 → 状态引用同步）；API Key/custom_credential 表单代理直达不落盘 + 回显脱敏；no_auth 登记；org 归属 + alias `org:<orgId>:` 前缀强制；删除级联检查；`connector.connect` 审批执行器 | `packages/plugin-connector/src/index.ts`（connections 段 + registerExecutor）；console/src/index.ts guarded 路由区（MCP 段 L1253-1413 / NAS 段 L1540-1760 之间新增 connector 段） | #2 | T-05、T-06、T-07、T-18、T-20 | 轨道 3 |
| 5 | M1 | invoke 网关：§2.1 七步链（authn→RBAC→权限组 authorize→admin 审批门禁→限流→billing.precheck→oct 调用）；单层 oct 先用「每权限组一令」最简形态（完整策略镜像在 #7）；计量 usage.record + 审计 actChain/runId + connector.invoked 事件；幂等键；auditPersisted=false 补记 | `packages/plugin-connector/src/index.ts`（invoke 段，对齐 plugin-mcp invoke L720-779 结构）；plugin-usage `ensureDefaultPriceBook()`（usage/src/index.ts L387-399）加 `connector:*` 零费率 + validate 注释（L498-499）；audit consume 加 `connector:` 分支（audit/src/index.ts L222-239） | #2、#3（catalog 用于 riskLevel） | T-08、T-09、T-10、T-14、T-15、T-16、T-17、T-22、T-28 | 轨道 2 |
| 6 | M1 | 接线：boot-all 挂载 + cordis.yml/patch + gen-manifests + PermissionCatalog/BuiltinRoles + 角色一次性迁移 + PlatformEvents 常量 + **api.yaml 摘要补登** | `src/boot-all.ts`（L28-53 挂载序列按依赖序 insert）；`cordis.yml`（`- insert: { id: ops-connector, name: '<PROJECT_ROOT>/packages/plugin-connector/src/index.ts' }`）；`cordis.patch.yml`（name 必须 `dsh-enterprise-ops/packages/plugin-connector/src/index.ts` 模块说明符）；`scripts/gen-manifests.mjs` PLUGINS 数组；plugin-iam/src/index.ts PermissionCatalog L147-204 + BuiltinRoles L206-213 + 幂等迁移（先例 v1.6 `agent-scopes-usage-write-v1`）；platform-core/src/bus.ts L27-69；plugin-mcp `manifest/api.yaml` 补登 `POST /api/mcp/import`、`POST .../sync-tools`、`DELETE .../:id`、`DELETE perm-groups/:id` | #2（插件骨架） | `npm run manifests` + `npm run lint:manifests` 通过；T-08（RBAC 面） | 轨道 0 后续 |
| 8 | M1 | REST + 工具三端：connector 段 guarded 路由全量（gateway/catalog/connections/execute/perm-groups/runs）+ `connector_*` 工具（connector_catalog_search / connector_connection_list / connector_execute / connector_perm_group_list 等，defineTool 带 permission）经 ctx.tools 三端自动暴露 | `packages/plugin-console/src/index.ts`（guarded 路由区）；`packages/plugin-connector/src/tools.ts`（对齐 plugin-mcp tools.ts 128 行先例）；身份注入点 `injectToolIdentity`（console L2522-2545）如需加 connector_execute 身份注入 | #4、#5 | T-08~T-17 经 REST/工具桥/`POST /mcp` 三端各验一遍 | 轨道 2/3 汇合 |
| 9 | M1 | 控制台 `#/connectors`（M1 分期：目录只读 + 连接卡片墙 + 连接向导 + 运行日志抽屉 + 网关设置；M0 桥接打标） | `packages/plugin-console/public/js/pages/connectors.js`（新建，仿 pages/nas.js 738 行先例）；`public/js/app.js`（import L11-12 区、NAV L32-33 区、builders 路由表 L82-83 区）；`manifest/ui.yaml`（gen-manifests） | #8 | 页面手测 + T-20（org 隔离 UI 过滤）；桥接徽章可见 | 轨道 4 |
| 10 | M1 | CLI connector 命令组（§2.10 全树） | `examples/dshctl.mjs` COMMANDS 加 `connector` 项 + help.run() 用法段 | #8 | `dshctl connector catalog providers`、`connector execute --action=hackernews.get_top_stories --dry-run` 等冒烟 | 轨道 5（与 #9 并行） |

**M1 DoD**：三层（REST/工具桥/`POST /mcp`）调用同一 `connector_execute` 契约全通；T-01~T-10、T-14~T-20、T-22、T-25、T-28 全绿；凭证零进平台（T-24）；`lint:manifests` 通过；控制台 M1 分期可用。

### M2 —— 令牌精细化 + 对账告警（依赖 M1 稳定）

| # | 里程碑 | 工作单 | 落点（具体文件） | 依赖 | 验收标准 | 并行轨道 |
|---|---|---|---|---|---|---|
| 7 | M2 | oct 令牌策略镜像完整版：按权限组铸令/台账（`connector:tokens`）/权限组变更 PUT 更新（四数组全发）/目录下架联动更新/连接删除联动/401·403 自动恢复重试一次/org 巡检定时任务 | `packages/plugin-connector/src/index.ts`（tokens 段 + 巡检定时器，对齐 probeAll setInterval 先例 plugin-mcp L497-535） | #4、#5 | T-04、T-11、T-12、T-13、T-21、T-29 | 轨道 2 |
| 11 | M2 | runs 对账 + 告警 + 成本 + 计费开关：5 分钟周期 cursor 增量对账（去重）入 `connector:runs` 缓存；按 runtimeTokenId 交叉校验 + 绕行检测告警；`connector_error_rate`/`connector_latency` 告警规则播种；价格簿按需调非零费率的运营开关验证 | `packages/plugin-connector/src/index.ts`（reconcile 段，复用 usage reconcile 思路 usage/src/index.ts L407-434）；`packages/plugin-console/src/seed.ts`（告警规则播种先例 L524-526） | #5、#7 | T-23、T-13/T-28 告警断言（connector_error_rate 触发路径）、T-02 告警断言 | 轨道 2 |

**M2 DoD**：权限组变更 → 令牌策略在 1 个巡检周期内收敛（T-12）；伪造 sidecar run（绕过平台直连 sidecar）→ 绕行告警触发（T-23）；org 巡检注入不一致 → 告警（T-21）；数据面层独立强制闭合（T-29）；控制台权限组管理 UI（§2.9 M2 分期）随 #7 一起上线。

### M3 —— 市场化（业务触发启动）

| # | 里程碑 | 工作单 | 落点（具体文件） | 依赖 | 验收标准 | 并行轨道 |
|---|---|---|---|---|---|---|
| 12 | M3 | 连接器型 L0 插件市场化：manifest connector 声明分支 + 安装二次确认（approved⊆requested 扩展 actions）+ 权限组模板铸令 + manual-settlement 订阅登记 + L3 分成挂账 + 市场 UI | `packages/plugin-market/src/index.ts`（PluginManifest L43-62、L0 分支 L156-170、contentHashOf L127、install L407-452、OFFICIAL_PLUGINS L535-551 如需自营标杆）；`packages/plugin-market/src/tools.ts` L19-24；market `CAPABILITY_RESOURCE_MAP` L230-233 加 `connector:*`；billing settle 分支（billing/src/index.ts L334）如需；`packages/plugin-console/public/js/` 新市场页；plugin-connector 模板安装逻辑 | M2 完成（#7、#11） | T-26、T-27 | 轨道 6 |

**M3 DoD**：声明式连接器插件 submit → approve → install（approved⊆requested 含 actions 子集裁剪）→ 权限组模板二次确认 → 安装即铸组铸令可调；订阅 manual-settlement 挂账可在 `GET /api/market/subscriptions`（console L2324）查到；settle 分成 dry-run 账本平衡（trialBalance，billing L295-303）。

### 收尾

| # | 里程碑 | 工作单 | 落点（具体文件） | 依赖 | 验收标准 | 并行轨道 |
|---|---|---|---|---|---|---|
| 13 | M2 后 | 演示种子 + selftest 新 section（§四 全量断言） | `packages/plugin-console/src/seed.ts`（连接/权限组演示种子，先例 L206-228）；`tests/selftest.mjs`（新 section + 进程内 open-connector stub） | #1–#11（业务触发的 M3 #12 不阻塞收尾） | §四 T-01~T-25、T-28、T-29 全绿（T-26/27 由 #12 自身验收与 M3 DoD 兜住） | — |
| 14 | 收尾 | 文档：README 连接器段、集成指南完稿、skills/dsh-ops-connector、本文档定稿 | `README.md`、`docs/connector-integration.md`、`skills/dsh-ops-connector/SKILL.md`（结构对齐现有 8 个：何时使用/工具映射/操作手册/护栏）、`docs/dev-plan-connector.md` | #13 | `npm run lint:manifests` + `npm run selftest` 全绿（总门禁） | — |

**依赖无环自查**：#1∥#2 起步；#3/#4←#2；#5←#2,#3；#6←#2；#8←#4,#5；#9∥#10←#8；#7←#4,#5；#11←#5,#7；#12←#7,#11；#13←#1–#11；#14←#13。无回边，无环。

> 注：工作单编号沿用蓝图原编号（#7 在 M2），编号 ≠ 里程碑序；执行序与并行关系以「依赖」列为准。

---

## 四、测试计划

### 4.1 selftest 新增分节（`tests/selftest.mjs` 新 `section('连接器纳管（open-connector 融合）')`）

**stub 方法**（先例 NAS_GW stub，selftest.mjs L98-157：进程内真实 HTTP 服务 + 强制鉴权头校验 + 调用记录供断言；DEMO_SEED 隔离实例 L163-210）：进程内 HTTP stub 复刻 open-connector v1.4.0 契约——`/v1/health`、`/v1/providers`、`/v1/actions[?service=]`、`/v1/actions/:id`、`POST /v1/actions/:id`（校验 Bearer oct_ 的 `allowedActions`/`allowedConnections` 策略与平台权限组快照一致，不符 → `403 connection_not_allowed`；识别 `Idempotency-Key` 与 `x-oo-connector-alias`；回 `meta.executionId/auditPersisted`）、`/api/connections`（PUT/GET/DELETE）、`/api/oauth/authorizations`（回 `{authorizationUrl, state}`；缺 client 配置回 `400 oauth_client_config_required`）、`/api/runtime-tokens`（POST 值仅返回一次/GET 无值/PUT 校验四数组全发/DELETE）、`/api/runs`（cursor 分页 + runtimeTokenId 过滤）、`POST /mcp`（5 工具集）、`/api/actions/:actionId/agent.md`。

**断言清单（编号即 §三 验收引用）**：

| 编号 | 断言 | 关联设计 |
|---|---|---|
| T-01 | **契约锁定测试组（P2 修正⑪）**：stub 对 v1.4.0 关键响应形状做 schema 断言（统一信封 success/data/meta、ConnectionSummary 八字段 `{id, service, connectionName, authType, configured, virtual, default, profile}`、RuntimeTokenSummary、`{authorizationUrl,state}`、RunLog 含 runtimeTokenId、runs `{items,nextCursor}`）——升级 sidecar 版本前必须先跑该组 | §2.3 |
| T-02 | **缺钥 fail-closed（P0 修正①）**：`OOMOL_CONNECT_ENCRYPTION_KEY` / `OOMOL_CONNECT_ADMIN_TOKEN` 缺失 → `connector:gateway` 标记不可用 + `connector.gateway.unhealthy` 告警 + invoke 拒绝（503/网关不可用错误码） | §2.2 |
| T-03 | 目录同步：providers/actions 入 `connector:catalog`；riskLevel 映射正确（只读 scope→read 等）；无法判定的 action 默认 admin；provider 段不符合 resource 正则的 service 拒绝纳管 | §2.4/§2.6 |
| T-04 | 目录 action 下架/改名 → 受影响权限组令牌收到 PUT 更新（四数组全发） | §2.4 |
| T-05 | OAuth 代理全流程：authorizations → `authorizationUrl`/`state` → stub 回调 → `connector:connections` 出现状态引用（configured=true，profile 脱敏字段），全程平台不落凭证 | §2.5 |
| T-06 | 未存 client 配置时发起 OAuth → `400 oauth_client_config_required` 透传，向导指引信息返回 | §2.5 |
| T-07 | API Key 表单代理：stub 收到完整 values；平台 `connector:connections` 无凭证字段；GET 回显脱敏（`slice(0,6)+'…'`/`'****'`，原文不落响应——对齐 selftest.mjs L1831 先例） | §2.5 |
| T-08 | member（无 `connector.invoke`）invoke → 403 + `audit.authz.denied` 事件 | §2.8 |
| T-09 | developer 经 riskCap=read 权限组调用 write/admin 级 action → 平台侧拒绝 | §2.4 |
| T-10 | 调用权限组 `allowedActions` pattern 未命中的 action → 平台侧拒绝 | §2.4 |
| T-11 | **令牌策略镜像校验**：stub 侧校验 oct_ 的 `allowedActions`/`allowedConnections` 与平台权限组快照逐字段一致 | §2.4 |
| T-12 | 权限组变更（加/删 action、改 connections）→ stub 收到对应 `PUT /api/runtime-tokens/:id`，**四个数组全发**；权限组删除 → DELETE 令牌 | §2.4 |
| T-13 | **401/403 自动恢复（P1 修正⑥）**：stub 先回 `403 connection_not_allowed` → 平台按最新快照 PUT 更新令牌并重试一次成功；stub 持续拒绝 → 重试仍失败计入 `connector_error_rate` 告警 | §2.4 |
| T-14 | invoke 计量：`usage.record` 收到 `resource=connector:<provider>`、meter `calls`、`trace_id=meta.executionId`、幂等键 `connector:<runId>`；价格簿 `connector:*` 零费率命中（无规则会被硬校验拒绝，反向断言） | §2.6 |
| T-15 | 审计：invoke 日志含完整 actChain + runId（= executionId）；写类操作 changeLog 留痕 | §2.7 |
| T-16 | 限流：同一 caller 超 `rateLimitPerMin` → `rate_limited` 拒绝；billing.precheck 余额不足 → `quota.exceeded` 拒绝 | §2.1 |
| T-17 | riskLevel=admin 的 action → 产生 `connector.action.admin` 审批单，approve 前不执行，approve 后 executor 同步完成调用（对齐 decideApproval L414-457） | §2.7 |
| T-18 | 配置需审批的 provider 新建连接 → `connector.connect` 审批门禁生效 | §2.7 |
| T-19 | stub 关停（网关不可达）→ invoke fail-closed 拒绝 + `connector.gateway.unhealthy`；恢复后自动复用 | §2.2 |
| T-20 | org 隔离：org A 连接对 org B 用户不可见/不可调（跨 org 403）；alias 非 `org:<orgId>:` 前缀创建被拒 | §2.4/§2.5 |
| T-21 | org 巡检：手工注入「令牌绑定了 org 外连接」→ 巡检周期内 `connector.gateway.synced` 异常告警 | §2.4 |
| T-22 | 写类 action 自动带 `Idempotency-Key`；同键重放返回原 executionId 且**不重复计量** | §2.6 |
| T-23 | **runs 对账口径（P1 修正⑦）**：stub 侧伪造「直连 sidecar 的 run」（有 runtimeTokenId 无平台 meter）→ 对账周期内产生绕行调用 critical 告警；正常链路 runs 总量 ≈ 平台计量总量；cursor 重叠窗口去重正确 | §2.6 |
| T-24 | **零密钥落盘断言（红线一）**：扫描平台 `data/`（selftest 用 `data-selftest`）全部集合文件，无 `apiKey`/`secret`/`authorization` 明文值（对照测试用密钥字符串全文检索为 0 命中） | §一 红线 |
| T-25 | M0 桥接：`POST /api/mcp/import` 注册 stub `/mcp` 为 external 服务 → 探活 online → 经 MCP 权限组 `mcp_invoke` 调用成功；服务带「桥接过渡」标记字段 | §2.11 |
| T-26 | M3 安装：声明式连接器插件 submit（Ed25519 验签）→ approve → install，`approved ⊆ requested` 对 actions 子集裁剪生效（超集请求被拒）；权限组模板二次确认后铸组铸令 | §2.12 |
| T-27 | M3 挂账：安装付费连接器插件 → `market:subscriptions` 出现 `channel:'manual-settlement'` 记录；billing settle dry-run 含 `developer:` 分成贷方且 trialBalance 平衡；全程无自动扣款路径 | §2.12 |
| T-28 | stub 回 `meta.auditPersisted=false` → 平台补记审计 + `connector_error_rate` 低阈值告警 | §2.6 |
| T-29 | **数据面层独立强制（双层矩阵闭合）**：合法 oct_ 令牌直接请求 `allowedActions` 未命中的 action → stub 侧 403 拒绝（绕开平台层时数据面策略镜像仍独立生效） | §2.4 |

### 4.2 真实环境联调（本仓库外，部署环境执行，compose 部署 sidecar）

三类 provider 覆盖 authType 全谱系（P2 修正⑫）：
1. **no_auth**：HackerNews（`hackernews.get_top_stories` 等）——验证目录同步 + invoke + 计量最小链；
2. **OAuth**：GitHub（企业自备 OAuth App，走 `PUT /api/oauth/configs/:service` + authorizations 全流程）——验证 §2.5 代理链与回调拓扑；
3. **API Key 型**：任一 api_key provider（如 GitHub PAT 形态亦可复用）——验证表单代理直达 + 脱敏回显 + 命名连接 `x-oo-connector-alias` 路由。

### 4.3 总门禁

`npm run lint:manifests`（契约五面校验，含 plugin-mcp api.yaml 补登后的完整性）+ `npm run selftest` 全绿。

---

## 五、边界与后续

- **不做本地密钥库**（open-connector 即密钥库，roadmap「KMS 升级位」由其落地）；平台侧不自研任何凭证加密存储——本条与「凭证零进平台」红线互为表里。
- **不自研 provider**：目录已有 1,000+ Provider / 10,000+ Action，平台只做治理映射；私有系统接入走 plugin-mcp 既有通道或后续按需扩展。
- **不做 K8s 编排**：sidecar 同机部署遵循 runbook 单机惯例（NAS 网关先例）；多副本/HA 待真实部署需求触发。
- **版本锁定 v1.4.0**：上游迭代极快（两个月 13 个 release）——所有契约面集中在 `client.ts` 适配层隔离；升级 sidecar 前先跑契约锁定测试组（T-01），镜像 tag 生产环境 pin 具体版本。
- **风险登记**：
  1. **OAuth 回调拓扑**：企业网络限制下回调可达性是首要联调风险——§2.2 两拓扑 runbook 缓解，集成指南强制部署前检查 `OOMOL_CONNECT_ORIGIN`；
  2. **oct 令牌生命周期一致性**：权限组/目录/连接三类变更的令牌同步存在收敛窗口——§2.4 PUT 更新 + 巡检 + 401/403 自动恢复三重兜底，窗口内失败对调用方透明；
  3. **runs 分页对账误差**：`OOMOL_CONNECT_RUN_LIMIT` 默认 5000 轮转窗口内 cursor 增量对账有去重与漏采风险——对账周期远短于轮转周期 + run id 去重 + 对账结果只告警不自动处置（人工复核）。
- **上游文档未载项**（如实声明）：`GET /api/runs/:id` 不存在时的状态码未载；PUT connections / POST authorizations 成功状态码未载（按 200 + 信封 `success:true` 断言处理）；action 无 risk 字段（§2.4 平台侧映射兜底）。
- **后续候选**：`POST /v1/proxy/:service` 能力纳管（allowedProxies 三层策略模型本期不开放）；transit files（`/api/files` + S3 后端）按 action 需求接入；JWT 资源服务器形态（`OOMOL_CONNECT_JWKS_URI` 三件套）与平台 authn 令牌互通的远期对齐；Cloudflare Workers runtime 形态评估。

---

## 附：评审修正落实自查表（评审修正 13 项 + 档案衍生加固 3 项）

| # | 修正项 | 落实位置 |
|---|---|---|
| 1（P0） | `OOMOL_CONNECT_ENCRYPTION_KEY` + `_ADMIN_TOKEN` 强制、缺钥 fail-closed + 告警 + selftest 断言；密钥值走 env: 间接引用（modelgw L102 一行式） | §2.2 强制 env 清单表 + fail-closed 规则；T-02、T-24 |
| 2（P0，事实更正） | `POST /api/mcp/import` 真实存在（console L1279-1293 + importServices L350-407），M0 照用；#6 补登 api.yaml 摘要（含 sync-tools、DELETE 等漏列端点） | §2.11、§三 #1/#6、T-25 |
| 3（P0） | M3 全程 manual-settlement 挂账登记，不引入自动扣款/真实支付；「业务触发」= 首个外部开发者提交连接器型插件上架申请 | §2.12、§一 决策②、T-27 |
| 4（P0-） | roadmap「凭证存平台密钥库」→「凭证存 open-connector，平台只见引用」决策变更显式留痕 | §一 第 4 条 |
| 5（P1，事实更正） | 令牌级 action 规则已证实支持 `service.*`/精确 id/`*`，pattern 直传；保留「策略=权限组快照」语义；变更用 PUT（四数组全发）；连接删除/目录下架触发巡检同步 | §2.4；T-04、T-12 |
| 6（P1） | 401/403 `connection_not_allowed` → 按最新快照 PUT 更新令牌 + 重试一次；仍失败计告警 | §2.1 ⑦、§2.4；T-13 |
| 7（P1） | org 隔离三件套：alias `org:<orgId>:` 前缀、每权限组独立令牌绑稳定 ID、定时巡检不一致告警 | §2.4、§2.5；T-20、T-21 |
| 8（P1） | 对账口径：平台 usage.record 为计费事实源；runs 按 runtimeTokenId 总量交叉校验 + 盗用检测（有 run 无 meter = 绕行告警）；RUN_LIMIT 5000 轮转窗口约束对账周期；cursor 增量去重 | §2.6；T-23 |
| 9（P1） | 写类自动生成 `Idempotency-Key`；`trace_id = meta.executionId`；`auditPersisted=false` 边缘补记 | §2.6；T-14、T-22、T-28 |
| 10（P1） | OAuth 自备 App 成本写进连接向导（400 `oauth_client_config_required`；各 provider 注册指引 + 代理展示 agent.md） | §2.5、§2.9；T-06 |
| 11（P2） | 契约锁定测试组（stub schema 断言，升级前先跑） | T-01 |
| 12（P2） | 真实联调三类 provider（no-auth / OAuth / API Key 全谱系） | §4.2 |
| 13（P2） | M0 治理降级声明 + 控制台打标；`#/connectors` 页内分期（M1 目录只读+连接管理；权限组 UI 与 M2 令牌联动） | §2.11、§2.9；T-25 |
| 14（档案衍生） | riskLevel 数据源修正：action 无 risk 字段，由 requiredScopes/providerPermissions + 模板标注，默认 admin 兜底 fail-closed | §2.4；T-03 |
| 15（档案衍生） | usage resource 正则 `/^[a-z]+:[A-Za-z0-9._-]+$/` 约束写入设计（provider 段校验） | §2.6；T-03 |
| 16（档案衍生） | BuiltinRoles 只插不更新 → 新权限点入角色写一次性幂等迁移（先例 v1.6 `agent-scopes-usage-write-v1`） | §2.8；§三 #6 |
