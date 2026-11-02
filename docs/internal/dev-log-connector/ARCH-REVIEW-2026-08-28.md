# 连接器板块独立架构审查（2026-08-28）

审查人：小小刀（独立复审，非 CTO 台账序列）
审查对象：`packages/plugin-connector`（SaaS 连接器纳管）、`packages/plugin-connect`（远程接入）、
`packages/plugin-console` 中连接器相关的 REST 与工具桥接线。

方法：静态代码走查 + 跨文件契约比对（服务层 ↔ 客户端 ↔ 工具层 ↔ console 端点）+ 测试覆盖反查。
未启动运行时、未做动态渗透，所有结论均可按文中「验证方式」复现。

---

## 零、总体判断

控制面/数据面分离、凭证零进平台、授权双出验证这三条红线在**设计层面**立得住，实现也大体守住了，
这部分值得肯定。真正的问题不在「设计错了」，而在三类：

1. **同一份数据，两条路径两套权限标准** —— REST 端点做了 org 收敛，工具路径没做。
2. **多处「先写状态后校验」与 fail-open 缺省** —— 令牌台账、审计补记、计量登记三处。
3. **跨系统隐含契约没有任何断言** —— `executionId == sidecar run.id`、sidecar 错误码取值，
   全靠注释里的假设，一旦上游不符就静默失效或全量误报。

另外有一个工程性根因值得单独点出：**仓库没有类型检查步骤**。
`package.json` 只有 `start / selftest / lint:manifests / manifests`，没有 `tsc --noEmit`，
运行靠 Node 22 的 type stripping 直跑 TS。这解释了下面若干本应被编译器拦住的问题为何能存活
（`runPatrols()` 缺参、`status: 'offlined'` 类型外值靠 `as` 断言绕过等）。

---

## 一、P0 —— 安全与越权

### P0-1 工具层缺 org 数据权限收敛（IDOR）

`packages/plugin-connector/src/tools.ts:49-55`、`106`

```ts
const refs = ctx.connectorHub.connections().find((item) =>
  (!args.orgId || item.ownerOrgId === args.orgId) && ...)
```

`orgId` 直接取工具入参，无任何归属校验。`connector_perm_group_list` 同样。

对比 REST 路径 —— `plugin-console/src/index.ts:1442` 的 `restrictOrgScope()` 强制把
非 `*` 权限的人类用户收敛到自身 `orgId`，请求里的 `orgId` 被忽略。**同一份数据，两条路径两套标准。**

影响：持 `connector.connection.read` 的任意主体可枚举其他组织的连接别名、provider、
脱敏 profile 与权限组策略。注释写的「由服务端过滤」在当前代码里并不存在。

修复：工具层不得自行接受 `orgId` 作为过滤条件；应复用与 REST 同一收敛函数，
身份从执行上下文取（见 P0-2），而非从 args。

### P0-2 `connector_execute` 身份参数在部分调用路径上可被模型自填

`packages/plugin-connector/src/tools.ts:73-94`

```ts
callerId: { type: 'string', description: '调用方 ID（服务端注入）' },
...
id: args.callerId ?? 'tool-bridge',
```

先说做对的部分：`plugin-console/src/index.ts:3002` 的 `injectToolIdentity`
对 `connector_execute` 是**无条件覆盖**（`args.callerId = connectorCaller.id`），
且全仓仅两处 `tools.execute` 调用点（3050、3152）都走了注入。REST 与 `/mcp` 两个入口是安全的。

但风险仍在：

- `package.json` 声明了 `dsh.bundle`，插件会被打包进 **dsh 原生运行时**，
  该形态下工具由 dsh 的 ToolRuntime 直接执行，**不经过 console**，模型填什么就是什么。
- 兜底值 `'tool-bridge'` 是共享身份，注入一旦失效会静默降级为同一主体而非报错。
- `plugin-mcp/src/tools.ts:104-111` 的 `mcp_invoke` 是同样写法。「对齐先例」在这里等于复制了风险。

修复方向（治本）：**把 caller* 从工具参数 schema 中彻底删除**，改由 `defineTool` 的执行上下文
（`execute(args, invocationCtx)`）传递 principal。这样任何调用形态都天然安全，
而不是依赖「每个入口都记得注入」。安全属性不应建立在调用方自觉上。

### P0-3 `riskCap` 校验用 `in` 操作符，可被原型链绕过

`packages/plugin-connector/src/index.ts:836`

```ts
if (policy.riskCap && !(policy.riskCap in { read: 1, write: 1, admin: 1 }))
```

`in` 会查原型链。`riskCap` 取 `'toString'`、`'constructor'`、`'valueOf'`、`'hasOwnProperty'`
均可通过校验。虽然下游 `rankOf()` 会兜底，但校验层已失守，且难以审计。

修复：`['read','write','admin'].includes(policy.riskCap)` 或 `Set.has`。

### P0-4 `status: 'offlined'` 是类型外值，靠 `as` 断言绕过类型系统

`index.ts:404`、`411`、`425`

`ConnectionReferenceRecord['status']` 只声明 `'pending' | 'active' | 'error'`，
但 `offlineConnection` 写入 `'offlined'`，用 `as Partial<ConnectionReferenceRecord>` 强转。
后果是下游所有按 `status` 分发的逻辑（`summarize`、`refreshConnections`、`confirmConnectionStatus`）
都不认识该值，只能另用 `offlinedAt` 打补丁——**同一语义两套状态源**，极易漂移。

修复：把 `'offlined'` 纳入联合类型，删除两处 `as` 断言，下游统一按 `status` 判断。

---

## 二、P1 —— 可靠性与状态一致性

### P1-1 并发取令牌击穿，导致令牌风暴

`index.ts:955-981` `obtainOctToken`

无 single-flight。N 个并发请求同时 cache miss → N 次 `createRuntimeToken`，
且每个都会 `deleteRuntimeToken(旧 id)`，**互相删除对方刚建的令牌**，表现为随机失败。

修复：按 `permGroupId` 维度加 in-flight Promise 去重 + 短 TTL 缓存 + 熔断。

### P1-2 台账「先写后校验」，产生永久孤儿记录

`index.ts:968-979`

`tokens().insert/update` 发生在 `if (!minted.token) throw` **之前**。
一旦 sidecar 返回 id 但不返回 token 值，台账里就留下一条无值的 `ocTokenId`。
此后 `mirrorTokenPolicy` 认为台账已存在，只走 PUT 分支——而 **PUT 不返回 token 值**——
该权限组将**永久拿不到可用令牌**，且无任何告警。这是本次审查中最难排查的静默故障。

修复：先断言 `minted.token` 存在，再写台账；写失败要有补偿与告警。

### P1-3 `OcError` 从不透传 HTTP status，401 自动恢复形同虚设

`client.ts:166` 与 `client.ts:274` 均未传第 4 个 `status` 参数；
而 `index.ts:1245` 的恢复判定包含 `error.status === 401`。

结论：`error.status` 恒为 undefined，恢复**只能靠 `error.code === 'unauthorized'` 命中**。
sidecar 若返回 `invalid_token` / `token_expired` / `token_revoked`，恢复逻辑不触发，调用直接失败。

修复：`envelope()` 与 `executeAction()` 透传 status；恢复条件改为「status===401 或 errorCode 属于
已知令牌失效集合」。

### P1-4 管理面读取响应体无超时保护

`client.ts:143`

`clearTimeout` 在 `finally` 中，而 `await response.text()` 在 try 块**外**执行，
即 abort 定时器已清除后才读 body。慢响应/半开连接会永久挂起。
同文件 `requestRawWithHeaders`（283）把 `text()` 放在 try 内，是对的——两个方法不一致。

修复：统一为「fetch + 读 body 同受 signal 约束」。

### P1-5 `DELETE` 带 body 传 `connectionName`

`client.ts:218-220`

DELETE 请求体常被代理、网关、CDN 丢弃。若 `connectionName` 丢失，
sidecar 可能理解为「删除该 service 的全部连接」。风险不对称，不值得赌。

修复：改用路径参数或 query string。

### P1-6 审计补记 fail-open

`index.ts:1150`

```ts
const auditPersisted = outcome.meta['auditPersisted'] !== false
```

sidecar 未返回该字段时默认为 `true`，平台不补记。审计是红线三，应 fail-closed
（或至少记为「未知」并告警），否则「全程审计」的承诺在字段缺失时静默失效。

### P1-7 计量失败仅告警，不重试、不阻断

`index.ts:1154-1171`

注释自称「usage.record 为计费事实源」，但失败只 `logger.warn` + `countErrors`，
业务照常返回 `ok`。漏记即资损，且无死信、无重试、无升级。

修复：失败的计量写入本地死信表并重试；连续失败应触发告警并考虑熔断该 provider。

### P1-8 对账逻辑与注释矛盾，真正的盗用检测不到

`index.ts:1382`

```ts
if (run.runtimeTokenId && managedTokenIds.has(run.runtimeTokenId))
```

注释称「盗用检测」，但代码只检查**已知**令牌的 run 是否漏记计量（这是「漏记」检测）。
真正的盗用信号是**未知** `runtimeTokenId` 产生的 run——恰恰被这个条件跳过。

修复：拆成两类——未知 token 的 run = 盗用（critical）；已知 token 有 run 无 meter = 漏记（资损）。

### P1-9 跨系统隐含契约未断言，对账可能全量误报

`index.ts:1151` 取 `runId = meta.executionId`（缺失时本地 `newId('run')`），
usage 记 `trace_id = runId`；而 `reconcileRuns` 用 sidecar 的 `run.id` 查 `trace_id`（`countUsageByTrace`）。

若 `meta.executionId !== sidecar run.id`，对账将**100% 报「绕行」**，产生大量 critical 误警。
这是跨系统契约，当前没有任何断言或契约测试守护。

修复：selftest 增加一条断言 `run.id === meta.executionId`；不一致时降级为 warn 而非 critical。

---

## 三、P2 —— 性能、可运维性

| # | 位置 | 问题 |
|---|---|---|
| P2-1 | `index.ts` 多处 | `gateways().all()[0]` 在热路径反复调用，单次 invoke 触发 3–5 次全集合读取，且每次 `gateways()` 都重新 `collection()` + `uniqueOn()`。应缓存网关记录。 |
| P2-2 | `index.ts:1111-1118` | 限流在 `billing.precheck` 与连接下线闸**之前**计数，被拒绝的请求仍消耗配额，可被用于饿死正常调用。应在真正执行前才计数。 |
| P2-3 | `index.ts:148/1271` | `rateBuckets`、`errorCounter` 全在进程内存且 key 只增不减。多实例部署时实际限流 = N × 配置值；单实例也会内存泄漏。需共享存储 + TTL。 |
| P2-4 | `index.ts:699/759` | 循环内 `summaries.find(...)`，连接数为 n、m 时退化 O(n·m)。应建索引 Map。 |
| P2-5 | `index.ts:742` | `tokens().find` 内再 `permGroups().get`，典型 N+1。 |
| P2-6 | `index.ts:514-516` | `syncCatalog` 串行 `await` 全量镜像权限组，且 `.catch(() => undefined)` 静默吞异常，失败无任何告警。 |
| P2-7 | `index.ts:162-164` | 三个 `setInterval` 未 `unref`，测试/托管环境下阻止进程退出。 |
| P2-8 | `index.ts:1287` | `noteBusinessFailure` 把完整 message 塞进告警 label，可能含连接别名与输入片段，进入告警详情与审计，扩大信息暴露面。 |
| P2-9 | `index.ts:1039-1042` | `authorize()` 对候选组二次调用 `authorizeAgainst` 仅为拼错误信息，重复计算。 |
| P2-10 | `index.ts:163` | `void this.runPatrols()` 与 `runPatrols(autoCatalog: boolean \| undefined)` 签名不符，严格模式下应报错——间接说明类型检查缺失。 |
| P2-11 | 全包 | 大量 `.catch(() => undefined)` 静默吞异常（令牌镜像、删除令牌、对账、executor 注册）。至少应统一走 `countErrors` + 结构化日志。 |

---

## 四、架构层面的优化建议

### A. 身份与授权彻底移出工具参数层

当前模型是「模型可见参数 + 服务端覆盖」，属于靠约定和纪律。
正确做法是把 principal 放进 `defineTool` 的执行上下文，工具 schema 里根本不声明 `caller*`。
这样 REST / MCP / dsh 原生 / CLI 四种形态天然一致，新增入口时不可能忘记注入。
**安全属性应当由类型系统和框架保证，而不是由每个调用点记得调用某个函数。**

### B. 引入单一的 `InvokeContext` 贯穿全链路

现在 caller / actChain / orgId 在 REST 层、工具层、审批 payload、executor 之间手工搬运，
每搬一次多一次遗漏风险——P0-1 的 orgId 遗漏就是这么产生的。
建议定义只读的 `InvokeContext`，由入口构造、下游消费，**禁止从 args 构造**。

### C. 功能权限与数据权限分离，数据权限下沉到数据访问层

当前只有工具级 `permission`（功能权限），数据级 org 过滤靠各写各的（REST 有、工具没有）。
应提供统一 `scopeFor(caller)`，并让 `Collection` 查询层自动注入 org 谓词，
而不是指望业务代码自觉调用 `restrictOrgScope`。自觉是不可靠的，机制才是。

### D. 令牌生命周期收敛为单一状态机

现状：内存 `tokenValueCache` + 持久 `tokens` 台账 + sidecar 真实状态，三处靠哈希比对和
「重铸」语义维系，还叠加并发重铸。建议收敛成一个组件：single-flight + 租约
（TTL 略短于 sidecar）+ 熔断器；台账只记 id/hash，值永不落盘，miss 即重建。

### E. 失败语义分级

建立三档：**可静默**（巡检类）、**需计数告警**（镜像、同步）、**必须 fail-closed + 死信**（计量、审计）。
当前代码对第三档也用了 `catch(() => undefined)`。建议在框架层提供装饰器强制分级，
避免靠开发者临场判断。

### F. 对账模型重做

拆分为「漏记」（已知 token，有 run 无 meter）与「盗用」（未知 token 的 run）两类独立信号，
分别告警、分别处置。同时把 `executionId == run.id` 做成启动自检项。

### G. 补充类型检查与负向测试（工程根因）

- `package.json` 增加 `typecheck: tsc --noEmit` 并接入 CI。本次审查中至少
  P0-4、P2-10 会被编译器直接拦下。
- selftest 目前对连接器是 **admin 身份的正向冒烟**（`scripts/selftest.mjs:2761-2764`），
  用超管测 `orgId` 过滤等于没测（超管有 `*` 权限本就能跨 org）。
  需补充负向用例：低权限用户传他人 orgId、传他人 callerId、跨组织连接引用、
  `riskCap` 原型链值、并发取令牌。其他模块（iam / update / mcp）都有明确的越权断言，
  唯独连接器工具路径没有。

### H. 命名治理：系统里现在有三套「connect」

- `plugin-connect` —— 远程接入（宿主/客户端，机器凭证）
- `plugin-connector` —— open-connector SaaS 连接器纳管
- `plugin-iam` 的 `/api/iam/connectors/*` —— 钉钉通讯录同步连接器（第三套，与以上完全无关）

三个概念共用 `connect*` 词根，REST 路径分别是 `/api/connect/*`、`/api/connector/*`、
`/api/iam/connectors/*`，仅一字之差。这已经不是风格问题，是运维误操作与权限误配的温床。
建议重命名为 `remote-access` / `saas-connector` / `directory-sync`。

---

## 五、值得肯定的部分

- 控制面/数据面分离干净：平台只做映射与接线，不自研 provider 目录、OAuth、密钥库。
- 凭证零进平台落实得不错：连接引用无凭证字段，审批负载不含凭证，`oct_` 值仅存内存。
- 授权双出验证的设计是对的：平台权限组与 sidecar 令牌策略各自独立拒绝。
- `injectToolIdentity` 采用无条件覆盖而非「缺省才填」——这个细节是对的，问题只在于覆盖面。
- fail-closed 的态度基本正确（`OOMOL_CONNECT_ENCRYPTION_KEY` 缺失即拒绝一切 invoke）。
- 目录变更联动裁剪权限组、审批单去重、dry-run 预演，这些都考虑到了。

---

## 六、建议的修复顺序

1. 先补 `tsc --noEmit` 进 CI（成本最低，能立刻暴露一批问题）
2. P0-1 工具层 org 收敛 + P0-2 身份参数移出 schema
3. P1-2 台账先写后校验（静默且难排查）、P1-3 错误码透传
4. P0-3 / P0-4 校验与类型修正（改动小）
5. P1-1 令牌 single-flight
6. 补充负向测试用例后回归
