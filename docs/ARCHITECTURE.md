# 架构总览（稳定入口）

> 本文是平台架构的**稳定入口**：分层、插件树、服务目录、事件契约、存储架构、鉴权模型。
> 历史演进与设计讨论记录在 `docs/internal/`（不构成对外契约）；对外能力契约见 `docs/contract-*.md`。

## 一句话

一棵 cordis 插件树：基础层提供存储/事件/HTTP/工具运行时，每个业务域是一个独立插件包，
跨插件联动只走事件总线，全部 REST/MCP 流量过统一鉴权中间件 + RBAC。

## 分层

```
基础层   platform-core      存储(JSON/SQLite 双后端) · 事件总线 · HTTP · ToolRuntime-lite · YAML · 签名 · 场景图谱 · 行为管道
底座     resource-core      资源本体：属性 schema + 生命周期状态机 + 依赖图（一切资产的共同底座）
业务域   iam · authn · usage · audit · market · connector · mcp · nas · skillhub
         agent · app · modelgw · connect · update · portal · flow-core · exec-hub · workforce
接入层   console · panel-core · dsh-bridge · rq-card · dingtalk-bridge
```

## 插件树与装配顺序

独立宿主装配见 `src/boot-all.ts`（与 `cordis.yml` 的 dsh 宿主形态等价）：

```
platform-core → resource-core → iam → authn → usage → audit → market → connector
→ mcp → nas → skillhub → agent → app → modelgw → connect(host 角色) → update
→ portal → console → panel-core → flow-core → exec-hub → workforce → dingtalk-bridge
```

装配约束（`npm run lint:boot-order` 门禁）：

- `restoreAll()` 必须先于一切业务集合读取（platform-core `apply()` 内完成）；
- `console` 先于所有「自注册 guarded 路由」的插件（panel/exec/flow 依赖其鉴权中间件先行）；
- `connector` 先于 `mcp`/`modelgw`；`nas` 先于 `skillhub`；`exec-hub` 先于 `workforce`；
- dsh 宿主形态中 `connect` 为 client 角色、装配位次不同（有意差异，见 cordis.yml 注释）。

## 基础层服务目录（`ctx.*`）

| 服务 | 提供者 | 职责 |
| --- | --- | --- |
| `ctx.opsStorage` | `StorageService` | 业务集合存储（JSON/SQLite 双后端，见下节） |
| `ctx.txnStore` | `SqliteTxnService` | 计量/事务流水专用底座（`data/txnstore.db`，WAL + 事务 + 幂等唯一索引） |
| `ctx.platformBus` | `PlatformBusService` | 平台事件总线——插件协作唯一胶水 |
| `ctx.tools` | `ToolRuntimeLite` | 独立宿主下的工具注册运行时（完整 dsh 下由宿主真 ToolRuntime 提供） |
| `ctx.httpServer` | `HttpServerService` | HTTP 服务：REST 路由、静态资源、SPA 兜底 |
| `ctx.workforcePolicy` | `WorkforcePolicyRegistry` | 数字员工策略窄端口（装配顺序无关，防循环依赖） |
| `ctx.behaviors` | `BehaviorService` | 行为事件采集管道（WP-03/D6） |
| `ctx.scenegraphs` | `ScenegraphService` | 行业场景图谱（内置通道装载 + 热刷新） |

## 事件契约（协作铁律）

**状态变更必发事件；跨插件联动只走事件总线或扩展点，禁止直连对方数据。**

典型链路：

- `iam.user.frozen` → authn 吊销全部令牌
- `mcp.unhealthy` → 熔断 + 审计
- `panel.message.created` / `audit.alert.fired` → 钉钉桥接投递
- `scenegraph.updated` → 场景图谱热刷新

各插件声明的事件清单见 `packages/*/manifest/events.yaml`。

## 存储架构

```
data/
  collections.db        # 业务集合（PLATFORM_STORAGE=sqlite 时；WAL + synchronous=FULL）
  txnstore.db           # 计量与事务流水（始终 SQLite，历史既有）
  *.json                # 业务集合 JSON 后端（默认形态；sqlite 模式下为回填前的回滚源）
  oidc-keys.json        # OIDC 签名密钥（文件直读，非集合；生产建议迁 KMS）
```

- **`Collection<T>` 契约是唯一接缝**：`all/get/find/findOne/insert/update/remove/replaceAll/count/onChange/uniqueOn`。
  27 个业务插件零感知后端。
- **json 后端**（默认）：内存 Map + 250ms 防抖原子落盘；`durability: 'durable'` 集合跳过防抖即时 fsync。
- **sqlite 后端**（`PLATFORM_STORAGE=sqlite`）：写入即事务提交；`uniqueOn` → 引擎级唯一索引；
  常驻内存不随记录数增长；首启自动回填同名 JSON 文件（文件保留为回滚源）。
  决策与验收见 [`adr-0001-storage-migration.md`](adr-0001-storage-migration.md)。
- **计量流水**始终走 `SqliteTxnService`：只追加、事务、引擎级幂等（schema v1）。
- 诚实边界：两种形态都是单进程、单写者；多节点 HA 需要 Postgres 集合后端（二期）。

## 鉴权与权限模型

- 全部 `/api/*` 路由经统一鉴权中间件 + RBAC；未匹配路由的匿名请求统一返回 401（不提供路由探测侧信道）。
- 权限点集中登记（`packages/*/manifest/permissions.yaml`，静态 86 + 各插件启动期幂等补录 8 = 运行时目录 94 个），控制台/CLI/MCP 工具共用。
- 令牌：双轨身份（人 + 机器凭证）、受众（aud）收敛、on-behalf-of 链、refresh 轮转 + 重放防护；
  唯一性约束（如「一人一号」identityLinks）在 sqlite 后端下由引擎级唯一索引兜底。
- 对外协议键保持 ASCII 不改写（中文释义见 `docs/协议键中文对照总表.md`）。

## 接入面

| 面 | 入口 | 说明 |
| --- | --- | --- |
| REST | `/api/*`（450 条去重路由） | 统一鉴权 + RBAC |
| MCP | `/mcp`（86 个注册工具，全部声明最小权限 permission） | 平台即 MCP Server；dsh 宿主形态下工具对模型直接可见 |
| CLI | `dshctl.mjs`（16 组命令） | 机器可读输出优先 |
| A2A | `/api/agents/:slug/a2a`（JSON-RPC）+ `/.well-known/*`（签名卡发现，规范裸体）+ `/v1/a2a/*`（SSE） | 数字员工互调协作面（plugin-a2a，见 docs/a2a-uhp-implementation.md） |
| UHP | `/v1/uhp`（能力发现免鉴权，规范裸体）+ `/v1/uhp/responses`（任务面，自校验 Bearer + uhp.invoke） | harness 统一执行驱动（plugin-uhp） |
| 控制台 | `/`（SPA，zh-CN/en-US/ja-JP 运行时切换） | `/docs` 仅公开白名单接入指引 |

## 关键不变量（改动前先读）

1. `Collection<T>` 接口不破坏性变更；存储后端可替换但插件零改动。
2. 状态变更必发事件；禁止跨插件直读数据。
3. 协议键 ASCII 永不改写；i18n 只作用于表现层文案。
4. 演示/降级能力必须显式标注（`exec: demo`），绝不静默充数；模型网关无 endpoint 时直接报错。
5. 平台不转售、不分账：价格簿为零价快照（`charge` 恒 0）。
6. 匿名请求对未匹配路由统一 401；`/docs` 白名单默认拒绝，宁紧勿松。

## 文档地图

- 对外：本文件 · `README.md` · `docs/deploy-enterprise.md` · `docs/contract-*.md`（7 份能力契约）
  · `docs/*-onboarding.md` / `docs/*-integration.md`（接入指引）· `docs/i18n/`
- 内部过程物料（QA 报告/交接单/重构基线/发布说明/开发计划）：`docs/internal/`（不构成对外契约）
