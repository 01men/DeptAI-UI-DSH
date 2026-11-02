# MCP 治理与身份权限整改 —— 共享契约 v1.0（2026-10-22）

> 本文件是《AI 平台 MCP 治理与身份权限整改开发计划》落地的唯一共享契约事实源。
> 各开发组必须遵守此处钉死的类型、路径、语义与文件所有权；冲突以本文件为准。
> 需要变更契约时，必须回报总指挥（CTO）裁决，更新本文件并同步所有受影响组。

## 0. 工程红线（所有组适用）

- Node ≥22.6 原生 TS 直跑，零构建、**零新增 npm 依赖**。
- additive 优先：不改既有字段语义、不删既有行为；存量数据靠启动幂等迁移补齐（参照 `ensureConnectorPermissionsMigration` 模式）。
- 工作区存在大量未提交变更：**禁止 git commit / checkout / clean / stash / restore**，只做文件编辑。
- 每组只允许编辑「文件所有权」清单内的文件；确需越界时写进汇报，由总指挥裁决。
- 交付门槛：`npm run selftest` 全绿；动了 manifest 跑 `npm run lint:manifests`；动了 locales 跑 `npm run lint:i18n`。
- 注释与文案风格与周边代码一致（中文注释、既有命名惯例、`t()` i18n 包装用户可见文案）。

## 1. 任务映射与波次

| 计划任务 | 波次 | 承接组 |
| --- | --- | --- |
| 任务1 统一 Principal Resolver | W1 | T1 身份基座组 |
| 任务2 委托令牌模型 | W1 | T1 |
| 任务3 下游凭证引用 + Secret Broker | W1 | T2 资源模式与凭证组 |
| 任务7 MCP 服务归属字段（字段面+迁移） | W1 | T2 |
| 任务4 服务级 MCP 数据面 | W2 | T3 数据面组 |
| 任务5 按权限过滤工具列表 | W2 | T3 |
| 任务6 mcp_invoke 定位调整 | W2 | T3 |
| 任务7 归属治理闭环（owner 校验/治理待办） | W2 | T4 应用绑定组 |
| 任务8 App 能力声明与生命周期联动 | W2 | T4 |
| 任务9 Policy Decision Point | W3 | T5 策略与审计组 |
| 任务10 资源限定授权模板 | W3 | T5 |
| 任务11 组织与租户硬约束 | W3 | T5 |
| 任务12 审计冷热分层 + 哈希链 | W3 | T5 |
| 任务13 OpenTelemetry 式全链 trace | W3 | T5 |
| 任务14 策略模拟与影响分析（API 面） | W3 | T5 |
| 控制台 UI / 三语 i18n / 文档 / CHANGELOG | W3 | T6 体验组 |
| 全量验收 + selftest 扩编 + 交付报告 | W4 | 总指挥 + 修复组 |

## 2. 统一 Principal（platform-core/src/principal.ts，W1-T1 新建）

```ts
export interface ActChainNode { kind: 'user' | 'agent' | 'app' | 'platform-service'; id: string; name?: string }

export interface UnifiedPrincipal {
  principalId: string
  kind: 'human' | 'agent' | 'app' | 'platform-service'
  userId?: string; agentId?: string; appId?: string
  orgId?: string; tenantId?: string
  authMethod: 'oidc-code' | 'client-credentials' | 'token-exchange' | 'session' | 'entry-ticket' | 'demo'
  tokenId: string                    // = token.jti
  scopes: string[]
  /** 代理场景的实际用户（act 链最底 human 条目对应的 userId） */
  subjectUserId?: string
  actChain: ActChainNode[]           // 由 authn ActEntry[] + principal 反查映射
  refType?: 'user' | 'agent' | 'app' | 'external'
  refId?: string
  name: string
  permissions: string[]              // 保持 CallerInfo.permissions 语义
}

export interface PrincipalLookups {
  principalOf(id: string): Promise<{ refType?: string; refId?: string; name?: string; type: string } | null>
  orgOf(ref: { kind: 'user' | 'agent' | 'app'; id: string }): Promise<{ orgId?: string; tenantId?: string } | null>
}
export async function resolveUnifiedPrincipal(vp: VerifiedPrincipalShape, lookups: PrincipalLookups): Promise<UnifiedPrincipal>
export function toCallerInfo(p: UnifiedPrincipal): CallerInfo          // 含 actChain 投影 {name,type}
export function toInvokeCaller(p: UnifiedPrincipal): { type: 'user'|'agent'|'app'; id: string; name: string; onBehalfOf?: string; actChain?: ... }
export function toWorkCallerRef(p: UnifiedPrincipal): WorkCallerRef
export function humanDelegatorOf(p: UnifiedPrincipal): { userId: string; name?: string } | null
export function isDelegated(p: UnifiedPrincipal): boolean
```

- 纯映射实现收敛进 principal.ts；`rest-gate.workCallerOf` 内部改为委托 principal.ts（对外形为不变更）。
- **权限组主体匹配口径（CTO 终审裁决 2026-10-22，W4 安全审计 P0-3）**：`UnifiedPrincipal.actChain` 节点携带 `refId`（该主体绑定的资源 id），`toInvokeCaller` 输出 `subjects`（可匹配主体集合）= 主体自身 + 委托链上的 app/agent 演员（按资源 id）。`McpService.matchedPolicies` 以该集合匹配权限组主体：User → App/Agent → MCP 时，真正执行动作的是链上 actor，授予它的权限组必须对其生效；否则 Agent 身份永远匹配不到 agent 主体权限组，标准接入路径将静默拿到空工具集。既有「用户组主体按真人命中」口径不变。
- console 鉴权中间件（plugin-console/src/index.ts:139-183）是唯一权威写入点：verify 后经 resolveUnifiedPrincipal 组装，`exchange.principal` = CallerInfo 字段超集 + 附加 `unified: UnifiedPrincipal`（向后兼容，旧消费者不感知）。
- 消费方（bridge /mcp、a2a actChainOf、nas OBO、mcp invoke）一律读 `unified`，**禁止从请求参数/header 声明身份**。

## 3. 委托令牌（plugin-authn，W1-T1）

- `TokenRecord` 增量字段：`delegatedUserId?: string`（被代理用户）、`delegationAudience?: string`。
- 新服务方法 `exchangeDelegatedToken(input)`，语义：
  - 入参：`{ caller: VerifiedPrincipal; userId?: string; targetPrincipalId?: string; audience: string; scopes?: string[]; ttlSeconds?: number }`。
  - **人类调用者**：可为目标 agent/app principal 签发 OBO 委托令牌（sub=user，act=调用者+目标）；
  - **机器调用者（agent/app 凭证）**：两种模式（CTO 终审裁决 2026-10-22，W4 安全审计 P0-2）：
    - **自委托**（不传 userId/targetPrincipalId）：sub=调用者自身、act 链为空——即计划 §6.2「Agent 自身调用」形态（sub=agent:xxx, aud=mcp:service:<slug>）。平台长期机器凭证不出域，只换出「短期 + 单一服务受众」令牌；授权面由 scopes 三方交集夹紧到调用者自身实时权限，不构成提权；
    - **代用户委托**（传 userId）：sub=该用户、act=调用者主体（既有语义不变）。
  - 授权事实校验（fail-closed）：`authn.setDelegationGuard(fn)` 由 console 装配时注入（查 agent bindings / app owner / 管理员），未注入一律拒绝；
  - audience 强校验：必须 `mcp:service:<slug>` 或 `plugin:<id>` 形态（复用既有 audience 收敛逻辑 index.ts:828-834）；
  - scopes = 请求 ∩ 调用者 scopes ∩ 目标 principal scopes；
  - TTL：默认 900s，上限 3600s；act 链（human 之后）跳数上限 **4**，超限拒绝 `DELEGATION_CHAIN_TOO_LONG`。
- 路由 `POST /api/authn/token/exchange`（公开路径 + 自带 Bearer 校验，仿 routes/auth.ts:323 client-credentials 模式），RFC 8693 风格响应 `{access_token, token_type:'Bearer', expires_in, scope, issued_token_type}`。
- **冻结即时失效**：UserFrozen 事件处理器（authn index.ts:180-184）扩展为同时吊销 `delegatedUserId == userId` 的全部令牌；agent/app 停用依赖既有 principal active 校验。
- `issueOnBehalfOf` 保留不动（旧链路兼容）。

## 4. X-On-Behalf-User 降级为 attribution-only（W1-T1）

- NAS REST（routes/nas.ts `onBehalfUser`）：授权事实优先取 `unified` 委托链（humanDelegatorOf）；无委托链才回落 header，并标记 `delegationSource: 'token' | 'header-legacy'` 进审计；env `NAS_OBO_HEADER_STRICT=1` 时纯 header 请求 403（默认关，迁移期兼容）。
- ops.ts feedback 归因（归因非授权）：保留 header 兼容，读取处注释标注 attribution-only。
- 全仓其余读取点仅加注释标注，不改行为。

## 5. McpServiceRecord 扩展（W1-T2，additive）

既有 `owner: string`（登记人）**保留不动**，新增：

```ts
ownerEntity: { type: 'platform' | 'app' | 'agent' | 'connector'; id?: string }   // 缺省 {type:'platform'}
capabilityId?: string
exposureMode: 'gateway' | 'direct' | 'internal'    // 缺省 'gateway'；direct/internal 必须显式设置
dataClass: 'public' | 'internal' | 'confidential'  // 缺省 'internal'
environment: 'dev' | 'staging' | 'prod'            // 缺省 'prod'
visibility: 'org' | 'tenant' | 'cross-org'         // 缺省 'org'（W3 硬约束消费）
credentialRef?: string
```

- 启动幂等迁移 `ensureGovernanceMigration()`：补默认值；`ownerEntity` 无法推断的落 `{type:'platform'}` 并计入治理待办。
- 治理待办只读接口：`GET /api/mcp/governance/summary` → `{ unowned: [...], plainHeaderServices: [...], nonGateway: [...], totals }`。

## 6. Secret Broker（W1-T2，plugin-mcp/src/secret-broker.ts 新建）

- `SecretBroker`（cordis Service）：
  - `put(serviceId, { credentialRef, headerName = 'Authorization', secret })`：secret 写 `data/secrets/mcp/<serviceId>.json`（0600），**业务集合零密钥**；
  - `resolve(serviceId)`：credentialRef 形态 `local:`（内部存储）、`env:VAR`（进程环境变量）；`vault:`/`external:` 本期抛 `CREDENTIAL_BROKER_UNSUPPORTED`（留接口）；每次取值 emit `mcp.secret.access` 事件（不带值）；
  - `delete(serviceId)`、`describe(serviceId)`（永不返回 secret 原文）。
- 注入点：realTransport / 探活 / 工具发现（listRemoteTools）透传 headers 前，若存在 credential 凭证则按 `headerName` 注入（存量非敏感 headers 照旧透传）。
- 敏感头判定口径与 `maskServiceHeaders` 一致（`/authorization|token|secret|key/i`）。
- REST（routes/mcp.ts 增量）：
  - `PUT /api/mcp/services/:id/credential`（mcp.service.write）保存；`GET .../credential` → `{credentialRef?, headerName?, hasSecret, updatedAt?}`；
  - `POST /api/mcp/credentials/migrate` `{dryRun?}`：扫描存量敏感 headers → 报告/执行迁移 + changeLog；
  - create/update services：新写入敏感 headers → 400 `SENSITIVE_HEADERS_FORBIDDEN`（提示走 credential API）；env `MCP_ALLOW_PLAIN_HEADERS=1` 为迁移期全局逃生门（默认关）。
- plugin-audit 订阅 `mcp.secret.access` 落审计（W1 授权 T2 在 plugin-audit 订阅表加一行映射）。
- PlatformEvents 新增 `McpSecretAccess = 'mcp.secret.access'`（platform-core/src/bus.ts 仅此一处新增）。

## 7. 服务级 MCP 数据面（W2-T3）

- 新路由文件 `plugin-console/src/routes/mcp-dataplane.ts`：`POST /mcp/services/:serviceSlug`（+ `POST /mcp/s/:serviceId` 别名）。
- 认证：Bearer → `ctx.authn.verify` → unified principal（复用 bridge 同构组装）；aud 强校验：令牌带 audience 且 ≠ `mcp:service:<slug>` 且 ≠ 平台面 → 403 `AUDIENCE_MISMATCH`。
- 方法分派：`initialize`（回 mcp-session-id，与 bridge 同语义）、`ping`、`tools/list`（按 §8 过滤）、`tools/call`（→ `ctx.mcpRegistry.invoke(caller, serviceId, tool, args)`，统一走既有熔断/限流/权限组/风险/审计/计量链）。
- `tools/call` 响应包装为 MCP content 形态：`{ content: [{ type: 'text', text: JSON.stringify(result) }], isError? }`；错误映射 JSON-RPC code（-32001 未认证 / -32003 拒绝 / -32000 服务错误），拒绝必须带领域 `code`。
- 不修改 `/mcp`（平台运维面）与 `/api/mcp/invoke`（兼容层）的行为语义。

## 8. tools/list 权限过滤（W2-T3）

- 服务级端点：`authorizedToolsFor(caller, service)`（plugin-mcp 新导出，从 authorize() 抽取复用）——返回当前身份可调用工具集合（权限组 allowedTools 交集 + readOnly 约束过滤写工具 + 高敏数据类无授权不出现）；`tools/list` 只返回该集合。
- 平台 `/mcp`（bridge.ts:223-231）：`ctx.tools.schemas()` 按调用方 permissions 过滤（工具 `permission ?? 'console.login'` 基线判定，复用 IMPLIED_POINTS 口径），无权限工具的名称/参数 schema/权限注解一概不返回。
- 拒绝路径与列表过滤必须一致：不在列表中的工具调用返回 `-32003` + `TOOL_NOT_VISIBLE_OR_DENIED`。

## 9. mcp_invoke 定位调整（W2-T3）

- `POST /api/mcp/invoke` 与 `mcp_invoke` 工具保留，行为不变，文档标注「兼容层，Agent 标准默认路径是 /mcp/services/:serviceSlug」。
- Agent/App onboarding 接入提示词模板（plugin-agent/src/onboarding.ts、plugin-app/src/onboarding.ts）增加服务级 endpoint + 委托令牌接入示例；docs/agent-onboarding.md 同步。

## 10. App 能力绑定与生命周期联动（W2-T4）

- 新集合 `app:capabilities`：`AppCapabilityLink { appId, serviceId, required: boolean, exposure: 'gateway', status }`。
- REST：`GET/POST /api/apps/:id/capabilities`、`DELETE /api/apps/:id/capabilities/:serviceId`（权限点 `app.write`；owner 守卫同既有 assertAppOwner 口径）。绑定 serviceId 时校验：服务存在、`ownerEntity` 可回写为 `{type:'app', id:appId}`（回写需服务当前 ownerEntity 为 platform 或同 app）。
- App 上线门禁扩展（requestOnline 校验链）：每个 `required` 能力对应服务必须 `status ∈ {online, gray}` 且已 verify、工具清单非空、risk 登记无未决高危、配置了 credential 或无敏感头需求。
- 下架联动（app.offline 执行器 + requestOffline）：ownerEntity=={app} 的关联服务 → 置 `offline`（调用面既有 offline 拒绝逻辑自然生效）；归档/删除（purge）→ 服务保持 offline + 记 `archivedBy: appId`；审计保留。
- resource-core 依赖图补边：`{fromType:'app', toType:'mcp', kind:'capability'}`，拓扑 app→agent→mcp 可穿透。
- seed 演示数据：2 个演示 app 挂 capabilities（W2 内完成，T4 独占 seed.ts 的 app 段）。

## 11. Policy Decision Point（W3-T5，platform-core/src/pdp.ts 新建）

```ts
export interface PolicyDecision { allow: boolean; reasons: string[]; decisionId: string; obligations: Array<{ type: string; [k: string]: unknown }> }
export interface PolicyRequest { subject: UnifiedPrincipal; action: string; resource: { type: string; id: string; orgId?: string; dataClass?: string; [k: string]: unknown }; tool?: { name: string; risk?: string }; context: { environment?: string; traceId?: string; [k: string]: unknown } }
export interface PolicyModule { id: string; decide(req: PolicyRequest): Promise<PolicyDecision> | PolicyDecision }
export class PolicyDecisionPoint { register(m: PolicyModule): void; async decide(req): Promise<PolicyDecision> }  // deny 优先，reasons 聚合
```

- MCP invoke 主裁决改为经 PDP（模块：iam-permission / mcp-permgroup / scene-ABAC / org-constraint / risk-gate）；既有 authorize() 逻辑迁入 mcp-permgroup 模块，行为等价。
- NAS / Connector：不重写引擎，决策出口统一走 `pdp` 表达（decisionId + reasons 进审计），实现「同一决策表达与登记」。
- decisionId = `pd_<newId>`，随调用记录与审计事件落库。

## 12. 资源限定 scope（W3-T5）

- 命名：`mcp.service:<slug>.invoke`、`mcp.tool:<slug>:<tool>.invoke`。
- 机器凭证 scopes 校验（assertMachineScopes）：接受上述资源限定形态（校验 slug 对应服务存在 / `mcp.` 前缀），不再强制命中权限目录。
- invoke 鉴权：principal scopes 含 `mcp.invoke`（全局）或匹配 `mcp.service:<本服务>.invoke` / `mcp.tool:<本服务>:<本工具>.invoke` 任一即可过第一层；权限组仍为第二层强制闸门（不因 scope 放行而绕过）。
- 模板：`POST /api/mcp/perm-groups/:id/scope-template` → 按权限组策略生成建议 scope 集（控制台 W3-T6 消费展示）。

## 13. 组织与租户硬约束（W3-T5）

- PDP org-constraint 模块：caller.org / service.org / ownerEntity 资源 org 一致性；`visibility='org'` 跨组织直接拒绝 `ORG_SCOPE_DENIED`；`'tenant'` 同租户放行；`'cross-org'` 必须存在有效审批引用（context.approvalId 指向 approved 审批单且未过期）。
- 委托链用户 org 与目标数据 org 校验同理。

## 14. 审计冷热分层 + 哈希链 + 全链 trace（W3-T5）

- 冷数据：`audit:logs` 追加记录增加 `prevHash`/`hash`（sha256 链，record() 单点计算）、可选 `traceId`；`GET /api/audit/logs?traceId=` 支持按 trace 检索；`GET /api/audit/export?since=&until=` ndjson 导出（append-only 导出，权限点同既有 audit 读点）。
  - **哈希口径（CTO 终审裁决 2026-10-22，W4 安全审计 P0-1）**：`canonicalJson` 跳过值为 `undefined` 的键（与 `JSON.stringify` 语义对齐），确保「内存对象重算的哈希」与「落盘记录重算的哈希」一致——否则哈希链对最关键的 MCP 调用记录不可校验。
- **审计决策依据（CTO 终审裁决 2026-10-22，W4 安全审计 P0-4）**：`AuditLogRecord` 增 `decisionId?`/`decisionReasons?`；`mcp.invoked` 事件带 `status`，审计订阅据此分档 `result`：`ok` / `denied`（策略拒绝）/ `error`（上游故障）——策略拒绝与上游故障在审计中必须可区分。
- 热数据：`mcp:calls` 维持 5000 环形上限（滚动清理不丢审计——所有 allow/deny 调用已双写审计事件）。
- `McpCallRecord` 增量：`traceId?`、`argsHash?`（sha256(args JSON)）、`decisionId?`、`upstreamStatus?`。
- `mcp.invoked` 事件 payload v2（additive）：`traceId / argsHash / decisionId / decisionReasons / delegationChain / riskLevel / dataClass / upstreamStatus`。
- trace：`platform-core/src/trace.ts` 新建 `newTraceId()`（32hex）、`parseTraceparent/formatTraceparent`（W3C 口径）；invoke 入口无 trace 即生成；下游 HTTP 转发带 `traceparent` 头；usage.record 的 `trace_id` 从「仅受管」扩展为全部 real 调用回填。
- 策略模拟：`POST /api/mcp/perm-groups/dry-run`（body=完整权限组草稿）→ 影响报告 `{ newServices: [{serviceId,slug,name}], writeTools: [{serviceId,slug,tool}], confidential: [{serviceId,slug,dataClass}], crossOrg: boolean, affectedSubjects: [{type,id,name}] }`（不落库）；`POST /api/mcp/perm-groups`（落库路径）原样保留。
  - 字段名以实现为准（CTO 终审裁决 2026-10-22）：高敏数据维度名为 `confidential`（数组，非 `confidentialData`）；跨组织维度为布尔 `crossOrg`（判定存在与否，非逐条清单——跨组织明细由 `newServices` + 服务 org 字段承接）。控制台前端对两种形态均容错。

## 15. REST 契约汇总（前后端共同遵守）

| 方法/路径 | 权限点 | 说明 |
| --- | --- | --- |
| POST /api/authn/token/exchange | 公开+Bearer | 委托令牌交换（§3） |
| PUT/GET /api/mcp/services/:id/credential | mcp.service.write / read | 下游凭证（§6） |
| POST /api/mcp/credentials/migrate | mcp.service.write | 明文头迁移（§6） |
| GET /api/mcp/governance/summary | mcp.service.read | 治理待办（§5） |
| POST /api/mcp/services/:id/owner-entity | mcp.service.write | 归属指派（§5） |
| POST /mcp/services/:serviceSlug | Bearer+aud | 服务级数据面（§7） |
| GET/POST/DELETE /api/apps/:id/capabilities(…) | app.write | 能力绑定（§10） |
| POST /api/mcp/perm-groups/dry-run | mcp.permgroup.write | 影响模拟（§14） |
| POST /api/mcp/perm-groups/:id/scope-template | mcp.permgroup.read | scope 模板（§12） |
| GET /api/audit/logs?traceId= / GET /api/audit/export | audit 既有读点 | 审计检索/导出（§14） |

## 16. 验收门（对应计划 §13）

- 功能：标准 MCP 客户端可连服务级端点；tools/list 按身份过滤；调用面统一认证/授权/限流/熔断/审计/计量；应用下架后关联能力自动不可用。
- 安全：参数伪造身份无效；X-On-Behalf-User 不再作为授权事实；下游密钥不落业务库、API 永不回显；长期令牌不透传下游；跨组织必须显式授权；高敏工具不在无权主体列表出现。
- 审计：allow/deny 均有决策原因与 decisionId；可按 traceId 还原调用链；哈希链可校验；热数据滚动不丢审计。
- 体验：新增授权默认产出资源限定 scope 模板；权限变更可预演影响面；控制台可见 App↔Agent↔MCP↔Tool 拓扑与能力视图。
