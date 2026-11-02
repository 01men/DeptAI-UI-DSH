# 开发计划：接入链路四项加固（Agent / AI 应用接入体验与计费完整性）

> 来源：对外两段接入提示词（Agent 注册接入 / AI 应用接入）评审中发现的产品缺口。
> 本文是可直接执行的开发计划：每个工作流含根因定位（文件:行）、设计决策、改动清单、兼容性分析与自测用例。
> 不含人天预估。建议按 WS1 → WS2 → WS3 → WS4 → WS5 顺序实施（WS1/WS2 可并行，WS3/WS4 可并行）。

---

## 0. 背景与目标

评审接入提示词时与代码逐条核对，确认四个平台侧缺口：

| # | 缺口 | 后果 |
|---|------|------|
| 1 | Agent 注册签发的机器凭证 scopes 硬编码为 `['mcp.invoke','skill.read','agent.read']`（`packages/plugin-agent/src/index.ts:122`），不含 `usage.write`，而 `POST /api/usage/record` 要求 `usage.write`（`packages/plugin-console/src/index.ts:2018`） | Agent 按提示词自推计量**必然 403**，接入流程卡死 |
| 2 | 计量事件 meter key 与价格簿不符时静默按 0 计费（`packages/plugin-usage/src/index.ts:156` 的 `?? { key, value: 0 }` 兜底） | 提示词示例对 `model:*` 用 `tokens`（价格簿实为 `output_tokens`）不会报错，而是**静默漏计费**，比报错更危险 |
| 3 | 机器凭证（mc-/cs_）无 scopes 编辑、无 secret 轮换端点（现有仅 OIDC client 轮换与签名密钥轮换） | secret 丢失/泄露唯一补救是重新注册 Agent；权限无法回收调整 |
| 4 | `GET /api/agents` 不产生任何审计记录（审计只挂 change/auth 事件） | 接入提示词以"发一句话在平台审计留痕"为验收话术，名不副实 |

**非目标**（明确不做）：enrollment code 机制改造、提示词/文档层面的约定（WS5 单独同步）、计量幂等语义调整。

### 0.1 基线与验收总则

- 基线：`main` 分支 `npm run selftest` 全绿（当前 413 项）。
- 每个工作流（WS）完成后跑一次全量 selftest；全部完成后 `npm run lint:manifests` + 手工冒烟（见 §7）。
- 提交切分与风格照 git log 现状：`feat(xxx): 中文描述……自测 N→M 项`。

---

## WS1（P0）：Agent 机器凭证默认补 `usage.write` + 存量迁移

### 1.1 根因

`packages/plugin-agent/src/index.ts:117-123`：

```ts
credential = this.ctx.authn.createMachineCredential({
  name: `agent:${(agent as any).slug}`,
  refType: 'agent',
  refId: agent.id,
  scopes: ['mcp.invoke', 'skill.read', 'agent.read'],
})
```

机器主体的权限 = 令牌 scopes = 凭证创建时的 scopes 快照（`plugin-authn/src/index.ts:777-779`），后续无途径扩权。因此 Agent 用自己的凭证调 `POST /api/usage/record`（guarded `usage.write`）恒 403。

### 1.2 设计决策

- **只加 `usage.write`，不加 `usage.read`**：Agent 的义务是推送计量；查询流水（events/totals）属运营视角，保持最小授权。
- **存量迁移采用"一次性标记 + 幂等回填"**，而不是每次启动无脑补：WS3 会引入手工 scopes 编辑，无标记的启动回填会覆盖管理员刻意收回的权限。当前不存在 scopes 编辑入口，所以现网 agent 凭证不可能被人工收缩过，首次启动回填是安全的；用标记保证只跑一次，之后永不再动。
- 迁移动作写审计（change 类），留治理痕迹。

### 1.3 改动清单

1. **`packages/plugin-agent/src/index.ts`** — `register()` 中 scopes 数组改为：

   ```ts
   scopes: ['mcp.invoke', 'skill.read', 'agent.read', 'usage.write'],
   ```

   同步更新该方法注释（"注册即纳管"段落补一句：凭证含 usage.write，Agent 可自推直连消耗的计量）。

2. **新增存量迁移**（同文件 `apply()` 内，`ctx.effect(() => ...)` 形式，与现有 L4 执行器注册并列）：

   ```ts
   /** 一次性迁移：为存量 Agent 机器凭证补 usage.write（幂等标记，防止覆盖后续人工调整）。 */
   function migrateAgentCredentialScopes(ctx: Context): void {
     const markers = ctx.opsStorage.collection<{ id: string; doneAt: string }>('agent:migrations')
     const MARK = 'agent-scopes-usage-write-v1'
     if (markers.get(MARK)) return
     let patched = 0
     for (const principal of ctx.authn.principals().find(
       (item) => item.type === 'machine' && item.refType === 'agent' && item.status === 'active' && !item.scopes.includes('usage.write'),
     )) {
       ctx.authn.principals().update(principal.id, { scopes: [...principal.scopes, 'usage.write'] })
       ctx.audit.record({
         type: 'change', actorType: 'system', actorId: 'agent-migration', actorName: '凭证范围迁移',
         action: 'agent.credential.scopes-backfill', resourceType: 'agent',
         resourceId: principal.refId ?? '', resourceName: principal.name, result: 'ok',
         detail: '补入 usage.write（Agent 自推计量能力对齐）',
       })
       patched++
     }
     markers.insert({ id: MARK, doneAt: new Date().toISOString() })
     if (patched > 0) ctx.logger('agent').info(`存量 Agent 凭证迁移完成：${patched} 条补入 usage.write`)
   }
   ```

   注意：该函数在插件加载时执行一次；全新实例（自测）无存量，自然跳过，不产生副作用。

3. **文档同步**：`skills/dsh-ops-agent/SKILL.md` 若述及机器凭证权限范围，补 `usage.write` 说明（实施时 grep 确认，无则跳过）。

### 1.4 自测用例（`tests/selftest.mjs`「Agent 本体生命周期」节，约 :1249 追加）

1. 注册新 Agent → 用响应中 credential 调 `POST /api/auth/client-credentials` 换牌 → `data.principal.scopes` 含 `usage.write`（换牌响应结构见 `plugin-console/src/index.ts:450`，已含 scopes）。
2. 用该机器令牌 `POST /api/usage/record`（`resource: 'mcp:real-backend'`、`meters: [{key:'tokens', value:100, unit:'token'}]`，价格簿默认 `mcp:*` → tokens）→ 200（与 WS2 的拒绝用例形成正反对照）。

### 1.5 验收标准

- 新注册 Agent 的凭证 scopes 含 `usage.write`；机器令牌可成功推送一条计量事件。
- 存量部署升级：启动日志可见迁移（如有存量），审计出现 `agent.credential.scopes-backfill`；二次启动不再重复迁移。

---

## WS2（P0）：计量键与价格簿不符 → 硬拒绝

### 2.1 根因

`packages/plugin-usage/src/index.ts:155-157`：

```ts
const price = this.priceOf(input.resource)
const meter = input.meters.find((item) => item.key === price.meter_key) ?? { key: price.meter_key, value: 0, unit: 'unit' }
```

meters 中无价格簿 `meter_key` 时不报错，按 value=0 计价入库。真实案例：接入提示词教 Agent 对 `model:<slug>` 用 `--meter=tokens:...`，而价格簿 `model:<slug>` 的 `meter_key` 是 `output_tokens`（`plugin-modelgw/src/index.ts:76-79`，v1 口径输出 tokens 计费）→ 全部 0 计费且无人察觉。

### 2.2 设计决策

- **在 `record()` 内 `priceOf` 之后校验，缺失即 throw**。理由：
  - REST 侧经 `guarded` 变 400，错误信息直接携带期望键，调用方**无需任何额外权限**即可自纠（`GET /api/usage/price-book` 是 `usage.admin`，Agent 查不了，只能靠错误信息）；
  - 服务层统一拦截，覆盖 REST / 工具桥 / 内部调用所有入口；
  - "事件必须携带计价键"从此成为平台不变量，宁可拒绝不可静默 0 计费。
- **内部管道先对齐再上硬校验**，否则上线即断内观测数据。全仓 `usage.record(` 调用点核对结论（实施时再 grep 兜底一遍）：

  | 调用方 | meters | 价格簿键 | 结论 |
  |---|---|---|---|
  | `plugin-mcp/src/index.ts:850`（real 调用） | calls + tokens | `mcp:*` → tokens | ✅ 兼容 |
  | `plugin-modelgw/src/index.ts:137` | input_tokens + output_tokens | `model:<slug>` → output_tokens | ✅ 兼容 |
  | `plugin-nas/src/index.ts:354` | calls + bytes | `nas:*` → calls | ✅ 兼容 |
  | `plugin-market/src/index.ts:494` | billing.usage[0].key | 安装时登记同键（:429-438） | ✅ 兼容 |
  | `plugin-console/src/seed.ts:506` | tokens | `mcp:*` → tokens | ✅ 兼容 |
  | `plugin-skillhub/src/index.ts:423-434` | downloads / installs | `skill:*` → **calls** | ❌ **唯一不匹配，必须先修** |

### 2.3 改动清单

1. **`packages/plugin-usage/src/index.ts`** `record()`，在 `priceOf` 之后插入：

   ```ts
   const price = this.priceOf(input.resource)
   if (!input.meters.some((item) => item.key === price.meter_key)) {
     throw new Error(
       `计量键不匹配：资源 ${input.resource} 按价格簿 ${price.pattern} 以「${price.meter_key}」计价，` +
       `收到 [${input.meters.map((m) => m.key).join(', ')}]。请按 ${price.meter_key} 重报，不要编造计量键`,
     )
   }
   ```

   （原有 `?? { key, value: 0 }` 兜底即可删除——校验保证 find 必命中。）

2. **`packages/plugin-skillhub/src/index.ts`** `meterSkillUsage()`（:423）meters 改为：

   ```ts
   meters: [
     { key: 'calls', value: 1, unit: '次' },      // 价格簿 skill:* 计价键（零费率，仅为通过校验）
     { key: meterKey, value: 1, unit: '次' },      // downloads / installs 观测维度保留
   ],
   ```

   热力图等观测消费方按 meters 数组取维度，多一项 calls 不影响现有读取；如消费方按 `meters[0]` 取值则需实施时 grep `skill:` 的 matrix/breakdown 消费点确认（`plugin-usage/src/index.ts:350` matrix 按 resource 计数，不受影响）。

3. **全仓复核**：`grep -rn "usage.record(" packages --include="*.ts"`，确认无表外调用点。

### 2.4 兼容性分析

- **幂等重放**：同键同内容的重放走 `insertOrIgnore` 未插入分支（:186-199），重放输入本身含正确键才可能第一次入库；历史已入库事件不受影响。
- **死信重投**（`replay()` / `retryDeadLetters()`）：只重投已入库事件，不经过 `record()` 校验，不受影响。
- **对外部调用方**：原来"静默 0 计费成功"的请求从此变 400——这是期望的行为变更，WS5 提示词同步中会写成"400 会直接告诉你期望的计量键"。

### 2.5 自测用例（「第 2 步：多租户最小集与 usage 计量管道」节，:445-450 附近追加）

1. `resource: 'mcp:real-backend'` + `meters: [{key:'calls', value:1, unit:'次'}]`（缺 tokens）→ `!ok` 且 error 文本含 `计量键不匹配` 与 `tokens`。
2. 正确键（tokens）仍 200 且计价不变（既有用例 :438-440 覆盖，确认不回归）。
3. 「Skill 市场流水线」节：skill 安装/下载后，`GET /api/usage/events?resource=skill:<id>` 事件的 meters 同时含 `calls` 与 `downloads`（或 `installs`）——证明内部管道未被硬校验打断。

### 2.6 验收标准

- 键不匹配 400 且错误信息可指导自纠；价格簿匹配路径与计价金额零回归；skillhub 观测管道存活。

---

## WS3（P1）：机器凭证 scopes 编辑 + 密钥轮换

### 3.1 根因

`PrincipalRecord.scopes` 创建后无任何修改端点；`clientSecretHash` 无覆盖入口。secret 丢失/泄露的补救只剩"重新注册 Agent"（提示词现话术），治理上不可接受。

### 3.2 设计决策（两条关键语义，实现时最易漏）

1. **令牌 scopes 是签发时快照**：`issueToken()` 把 `scopes` 写进 token record（`plugin-authn/src/index.ts:717-722`），`verify()` 对 machine 主体读 `record.scopes` 而非 `principal.scopes`（:777-779）。**因此调整 scopes 或轮换 secret 后必须吊销该主体全部存量令牌**，否则收权不生效、旧令牌继续按旧 scopes 行权直至 2h 过期。服务方法内部直接调 `revokePrincipalTokens()`。
2. **scopes 合法性校验**：必须全部命中 iam `PermissionCatalog` 的 point（或恰为 `['*']`），防拼错（如 `usage.wrtie`）。`plugin-authn` 已注入 `iam`（`inject = ['opsStorage','platformBus','iam','httpServer']`，:832），直接 `import { PermissionCatalog } from '../../plugin-iam/src/index.ts'`（仓库既有惯例，`plugin-connect/src/host.ts` 同款）。

轮换语义对齐 OIDC client 轮换（`oidc.ts:253-260`）：clientId 不变、新 secret 一次返回、旧 secret 立即失效（hash 覆盖）。

**顺带加固（同批落地）**：`GET /api/authn/principals`（`plugin-console/src/index.ts:1030-1035`）当前 `...principal` 全量展开，把 `clientSecretHash` 外发了。新路由与该列表响应统一剔除 `clientSecretHash`（写法对齐 tokens 路由的脱敏，:1064-1066）。另补 `enable` 端点对称既有 `disable`（服务方法 `enablePrincipal` 已存在，:579-581）。

### 3.3 改动清单

1. **`packages/plugin-authn/src/index.ts`**（`createMachineCredential` 附近新增三个方法）：

   ```ts
   /** 校验机器身份权限范围：恰为 ['*'] 或全部命中权限目录。 */
   private assertMachineScopes(scopes: string[]): void {
     if (scopes.length === 0) throw new Error('scopes 不能为空')
     if (scopes.includes('*')) {
       if (scopes.length !== 1) throw new Error("'*' 不可与其他权限点混用")
       return
     }
     const catalog = new Set(PermissionCatalog.map((item) => item.point))
     const invalid = scopes.filter((scope) => !catalog.has(scope))
     if (invalid.length > 0) throw new Error(`非法权限点：${invalid.join('、')}（须为权限目录中的点，或仅 '*'）`)
   }

   /** 调整机器身份权限范围；联动吊销全部存量令牌（收权即时生效，下次换牌按新范围签发）。 */
   updateMachineScopes(id: string, scopes: string[]): PrincipalRecord {
     const principal = this.principals().get(id)
     if (!principal) throw new Error(`身份不存在：${id}`)
     if (principal.type !== 'machine') throw new Error('仅机器身份支持调整权限范围')
     this.assertMachineScopes(scopes)
     const updated = this.principals().update(id, { scopes })
     this.revokePrincipalTokens(id, '权限范围调整联动')
     return updated
   }

   /** 轮换机器凭证密钥：clientId 不变，旧 secret 立即失效，存量令牌全部吊销；新 secret 仅此一次返回。 */
   rotateMachineCredential(id: string): { principal: PrincipalRecord; clientSecret: string } {
     const principal = this.principals().get(id)
     if (!principal) throw new Error(`身份不存在：${id}`)
     if (principal.type !== 'machine' || !principal.clientId) throw new Error('仅机器凭证（clientId/clientSecret）支持轮换')
     const clientSecret = generateSecret('cs')
     const updated = this.principals().update(id, { clientSecretHash: sha256Hex(clientSecret) })
     this.revokePrincipalTokens(id, '凭证轮换联动')
     return { principal: updated, clientSecret }
   }
   ```

   注意 `generateSecret`/`sha256Hex` 本文件已用（:555-565），import 已就位。

2. **`packages/plugin-console/src/index.ts`** principals 路由组（:1043-1055 附近）新增/调整：

   ```ts
   guarded('PATCH', '/api/authn/principals/:id', 'authn.principal.write', (exchange) => {
     const { scopes } = body<{ scopes: string[] }>(exchange)
     if (!Array.isArray(scopes)) { exchange.fail(400, 'BAD_REQUEST', 'scopes 必填（字符串数组）'); return }
     const principal = ctx.authn.updateMachineScopes(exchange.params['id']!, scopes)
     changeLog(exchange, 'authn.principal.scopes', 'principal', principal.id, principal.name, scopes.join(','))
     const { clientSecretHash, ...safe } = principal
     void clientSecretHash
     return safe
   })

   guarded('POST', '/api/authn/principals/:id/rotate-secret', 'authn.principal.write', (exchange) => {
     const rotated = ctx.authn.rotateMachineCredential(exchange.params['id']!)
     changeLog(exchange, 'authn.principal.rotate', 'principal', rotated.principal.id, rotated.principal.name, '旧 secret 立即失效')
     return { clientId: rotated.principal.clientId, clientSecret: rotated.clientSecret, note: '新 clientSecret 仅此一次返回，旧值立即失效，存量令牌已全部吊销' }
   })

   guarded('POST', '/api/authn/principals/:id/enable', 'authn.principal.write', (exchange) => {
     const principal = ctx.authn.enablePrincipal(exchange.params['id']!)
     changeLog(exchange, 'authn.principal.enable', 'principal', principal.id, principal.name)
     return principal
   })
   ```

   同时 `GET /api/authn/principals`（:1030）map 内剔除 `clientSecretHash`。

3. **控制台 `packages/plugin-console/public/js/pages/authn.js`**（409 行）：

   - principals 表（machine 行）新增行操作：**「编辑权限」**——弹窗按 `GET /api/iam/permissions`（:944-946，已有，返回 `catalog` 含 point/label/group）分组多选勾定，提交 `PATCH /api/authn/principals/:id`；成功 toast 注明"存量令牌已联动吊销，机器侧需重新换牌"。
   - **「轮换密钥」**——danger 确认（文案：旧 secret 立即失效 + 存量令牌全部吊销），成功后弹一次性展示 modal（复用签发凭证的 `code-block` 展示样式，:185-190）。
   - principals 列表补 scopes 列（mono 小字，超长折叠 title 提示）。
   - 权限判断沿用页面现有 `authn.principal.write` 开关变量（自查页面头部 canWrite 逻辑）。

4. **CLI `examples/dshctl.mjs`** `credential` 组扩展（:446-458）：

   ```
   credential list                                        列出机器凭证（principalId/clientId/名称/refType/scopes/状态/活跃令牌）
   credential scopes <principalId> --scopes=a,b[,c|*]      调整权限范围（联动吊销存量令牌）
   credential rotate <principalId>                         轮换 clientSecret（仅本次展示，旧值立即失效）
   credential create --name= --scope=a,b [--refType= --refId=]   （现有 create 升级：--scope 支持逗号多值）
   ```

   `help()` 文本（:126）同步。输出遵循 `--output json|table` 既有约定。

5. **文档**：`skills/dsh-ops-authn/SKILL.md`、`skills/dsh-ops-agent/SKILL.md` 同步新命令与轮换语义（丢失/泄露凭证 → `credential rotate`，不再需要重新注册）。

### 3.4 自测用例（「统一认证（机器身份 / 令牌）」节，:379 附近追加）

以 `POST /api/authn/principals` 创建 scopes=`['agent.read']` 的机器凭证为夹具：

1. `PATCH` scopes 为 `['agent.read','usage.write']` → 200；**旧令牌**调 `GET /api/agents` → 401（联动吊销生效）；重新 client-credentials 换牌 → `data.principal.scopes` 等于新值。
2. `PATCH` scopes 含拼错点 `['usage.wrtie']` → 400 且 error 含 `非法权限点`。
3. `['*','agent.read']` 混用 → 400。
4. `rotate-secret` → 用旧 secret 换牌 401、新 secret 换牌 200；响应含 `note` 且不含 hash。
5. `GET /api/authn/principals` 响应 JSON 序列化后不含字符串 `clientSecretHash`。

### 3.5 验收标准

管理员可在控制台/CLI 完成 scopes 收放与 secret 轮换；每次操作后旧令牌立即失效；列表/响应面不再外发 hash。

---

## WS4（P2）：机器身份访问审计（"发一句话"留痕）

### 4.1 根因

`GET /api/agents`（`plugin-console/src/index.ts:1666`）与 `GET /api/agents/:id`（:1677）无审计。接入提示词用"带机器令牌 GET /api/200 并能在列表找到自己"作为接入验证，并宣称"该调用在平台审计留痕"——前者成立，后者是假的。

### 4.2 设计决策

- **只记机器身份**（`caller(exchange).kind === 'machine'`）：人类控制台读操作高频，全量记录会成为噪音；机器身份读台账是低频、带治理含义的动作（接入验证/资产探测），值得留痕。
- `type: 'auth'`、`action: 'agent.verify'`：审计页（audit.js）按 type/action 通用渲染，前端零改动。
- list 与 get 两个端点都记：list 的 `resourceId` 用 `-`，get 用具体 id。

### 4.3 改动清单

**`packages/plugin-console/src/index.ts`**，两处 handler 返回前插入（CallerInfo 形状见 :27-34）：

```ts
const machineAudit = (exchange: HttpExchange, resourceId: string, resourceName: string): void => {
  const info = caller(exchange)
  if (info.kind !== 'machine') return
  ctx.audit.record({
    type: 'auth', actorType: 'machine', actorId: info.principalId, actorName: info.name,
    action: 'agent.verify', resourceType: 'agent', resourceId, resourceName,
    result: 'ok', detail: `机器身份访问 Agent 台账（接入验证/资产探测留痕）`,
    ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
  })
}
```

- `GET /api/agents` handler 末尾：`machineAudit(exchange, '-', 'Agent 台账')`
- `GET /api/agents/:id` handler 内取到 agent 后：`machineAudit(exchange, id, agent.name)`

（`machineAudit` 定义放在 agents 路由组附近即可，`caller`/`ctx` 已在作用域。）

### 4.4 自测用例（「Agent 本体生命周期」节追加）

1. Agent 注册 → 机器换牌 → `GET /api/agents` 200 → `GET /api/audit/logs?type=auth&resourceType=agent` 存在 `action === 'agent.verify'` 且 `actorId` 为该机器 principalId。
2. admin（human）调同样端点 → 不新增 `agent.verify` 记录（噪音控制断言）。

### 4.5 验收标准

接入提示词话术"该调用在平台审计留痕"变为事实；审计日志页可按 `agent.verify` 检索机器接入轨迹。

---

## WS5（收尾）：文档与两段接入提示词同步

1. **仓库文档**：`grep -rn "重新注册\|轮换" README.md docs/ skills/` —— 涉及"凭证丢失只能重新注册"的话术改为"管理员 `credential rotate` 轮换，clientId 不变"。
2. **skills 文档**：随 WS1/WS3 已同步的复核一遍。
3. **两段接入提示词终稿**（本计划落地后即可用，替换评审版中相应条目）：

**Agent 段变化点**（其余维持评审版）：

> 1. 注册：……成功后一次性下发 clientId（mc- 前缀）/ clientSecret（cs_ 前缀）。secret 只出现一次，立即安全保存，
>    不打印到公开输出、不写入代码或提示词；丢失或疑似泄露立即找我执行 `credential rotate`（clientId 不变、旧值立即失效），不要重新注册。
> 4. 计量口径：……仅当绕过平台网关直连外部资源时才手动推送（经网关调用平台已自动计量，重复推送双计费）：
>      dshctl usage record … --meter=<key>:<数量>:<key> …
>    - meter key 必须与价格簿一致：mcp:* 用 tokens；model:<slug> 用 output_tokens。报错会直接告诉你期望的键，
>      按错误提示改键重报即可，不要编造计量键。
>    （删除"注册下发的机器凭证默认不含 usage.write，需要自推计量时先向我申请补授权"一句——平台已默认授予。）
> 3. 接入验证（"发一句话"）：带令牌 GET /api/agents，200 且列表中有自己的 agt_ id 即完成；该调用以机器身份
>    记入平台审计（action=agent.verify），可作接入证据。

**AI 应用段变化点**（其余维持评审版）：无代码相关变化；仅接入码发放习惯（operator 模板、现用现发）属运维约定，随提示词评审版执行。

---

## 6. 实施顺序与提交切分

| 顺序 | 工作流 | 依赖 | 建议提交 |
|---|---|---|---|
| 1 | WS1 scopes 补权 + 迁移 | 无 | `feat(agent): 机器凭证默认授 usage.write + 存量一次性迁移` |
| 2 | WS2 计量键硬拒绝 + skillhub 对齐 | 无（与 WS1 并行安全） | `feat(usage): 计量键与价格簿不符硬拒绝（防静默 0 计费）；skillhub 计量补 calls 键` |
| 3 | WS3 scopes 编辑/轮换 + hash 脱敏 | 建议在 WS1 后（避免同文件冲突） | `feat(authn,console): 机器凭证权限调整与密钥轮换（联动吊销令牌）+ 列表 hash 脱敏` |
| 4 | WS4 机器读台账审计 | 无 | `feat(console): 机器身份访问 Agent 台账入审计（agent.verify）` |
| 5 | WS5 文档与提示词 | 1-4 全部 | `docs: 接入提示词与凭证轮换话术同步` |

每步跑 `npm run selftest`；预期新增断言约 14 项（WS1 两项、WS2 三项、WS3 五项、WS4 两项、回归修补视实现补齐），提交信息按仓库惯例标注 `自测 N→M 项`。

## 7. 总验收

1. `npm run selftest` 全绿（含全部新增断言）。
2. `npm run lint:manifests`（若触及 manifest/工具描述则同步重新生成 `npm run manifests`）。
3. 手工冒烟（对运行实例按序 curl / dshctl）：
   - `dshctl agent create --name=smoke-agent --model=deepseek-chat --riskLevel=low` → 记下凭证；
   - `client-credentials` 换牌 → `GET /api/agents`（200，审计出现 agent.verify）；
   - 机器令牌 `POST /api/usage/record`（tokens）→ 200；同请求改键 calls → 400 且错误含期望键；
   - `dshctl credential rotate <principalId>` → 旧 secret 换牌 401、新 secret 200；
   - `dshctl credential scopes <principalId> --scopes=agent.read` → 收权后旧令牌 401。
