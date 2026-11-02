> [!WARNING]
> **本文为历史设计档案（2026-08），其中「钱包 / 复式分账 / 转售定价 / 订阅代收 / 资金通道」等商业化设计已废止**：
> 平台商业模式经 M0（2026-09-09，见 [release-notes-2026-09-09-m0.md](release-notes-2026-09-09-m0.md)）
> 废止按用量计费/转售/分账后，现行口径（2026-09-15 更新）为按「团队 + 领域资产」定价，或走制造业
> 私有化交付项目制（见仓库 README 横幅）；对外只呈现用量透明计量与内部成本穿透，价格簿为零价快照，
> 计量契约见 [contract-j4-usage-report.md](contract-j4-usage-report.md)；本文仅保留计量管道、市场契约等仍然有效的部分作参考。

# 生态服务设计 v1.2（实施依据版）

> 版本：v1.2（实施依据）
> 前置：v1.1 修订稿 + 《生态设计方案 v1.1 技术评审报告》（2026-08-21）+ 我方 PRD FR-01「平台底座强化」需求群
> 修订性质：**满足评审报告「v1.2 最低修订要求」全部 6 条，合并 PRD 地基前置（FR-01），作为唯一实施依据。**
> 本文档同时是交付基线：文末「交付状态表」逐项标注实现与验证情况，验收以代码 + selftest 断言为准。

---

## 〇、对评审报告的逐条响应（v1.2 最低修订要求核销）

| # | 评审要求 | v1.2 处置 | 落点 |
|---|---|---|---|
| 1 | 新增「第 0 步：执行层/连接器真实化 + 计量与资金类数据存储替换」，标为第 2/5/6/8 步硬前置 | ✅ 已新增第 0 步并实施：MCP 真实 HTTP 传输层（mock 降级为显式 demo 模式且标记）、钉钉真实 OpenAPI 连接器（未配置凭证时显式 mock 降级）、`node:sqlite` 事务存储服务承载全部计量/资金类数据 | 第 0 步；§二 |
| 2 | 资金流水最小集（只追加 journal + 幂等键）前移至第 5 步 | ✅ 第 5 步实施 `plugin-billing`：只追加资金流水表（SQLite，`idempotency_key` 唯一索引引擎级幂等）+ 余额变动与流水同事务提交 | 第 5 步；§五 |
| 3 | 轻量代理 ctx 从 L1 里程碑剥离划入第 3 步，明文「L1 交付前仅准入 L0」 | ✅ 第 3 步实施：轻量代理 ctx（事件源鉴别 + 能力裁剪，不含模块级沙箱）；市场准入门禁硬编码「仅受理 `sandbox: L0`」，L1 沙箱（第 10 步）交付前任何有码插件提交直接拒绝 | 第 3 步；§三 |
| 4 | schema 定版与多租户租户维度合并同版，策略 additive-only，补齐 tenant_id/currency/幂等键/可扩展 meter 字段 | ✅ `usage.recorded` schema v1 一次性定版即含 `tenant_id`（多租户最小集建模前移至第 2 步内完成）；`meters` 为可扩展字典 `{key, value, unit}`；含 `event_id`/`idempotency_key`/`trace_id`/`currency`/税率；演进策略 additive-only（只加可选字段，禁改语义删字段，弃用走 `platform.schema.deprecated` 事件） | 第 2 步；§四 |
| 5 | 补「开发者账号体系」与「资金通道依赖清单」两个缺失步骤 | ✅ 开发者独立身份域（`plugin-market` 内 DeveloperService，与内部员工 iam 域物理分离、独立凭证与发布者密钥对）并入第 5 步；资金通道依赖清单成文（§六），作为第 5/7/8 步对外收费的合规前置 | 第 5 步；§六 |
| 6 | 逐处订正 F1–F6 事实性偏差 | ✅ 见下表 | 全文 |

### F1–F6 事实订正（全文生效）

| # | 订正后的表述 |
|---|---|
| F1 | 平台现有 **10 个可运行插件**（boot-all.ts 加载 10 个；plugin-platform-core 为无 src 的纯声明占位镜像，不参与运行；控制台 SPA 由独立宿主进程提供） |
| F2 | 第三方契约 manifest 文件名为 **`api.yaml`（单数）**，与仓库既有四面（api/permissions/events/ui）一致；billing 面为新增 `billing.yaml` |
| F3 | platformBus 是**独立自实现的内存 pub/sub**（listeners Map + 300 条 ring buffer），**不经过 cordis 事件系统**；source 校验当前不存在，属**新增**工作（v1.2 第 3 步实施）；旁路的真实形态是第三方直调 `platformBus.emit` 伪造平台事件，而非 `ctx.emit` |
| F4 | `ctx.effect()` 为官方清理机制且属实，但现状仅 3/10 插件使用；不作为「平台插件普遍结构」表述 |
| F5 | app（231 行）并非编排拓扑最复杂的插件；选其做契约试金石的理由修正为「覆盖拓扑/计量/成本穿透面」，验收方式为**复合验收**（契约五面 + 计量 + 成本 + 拓扑联合断言） |
| F6 | 错别字订正：「暴开」→「暴露」、「应仟」→「应付」 |

### M1–M8 消化安排

| # | 问题 | 消化方式 | 落点 |
|---|---|---|---|
| M1 | schema 刚性 + 字段欠完备 | meters 可扩展字典、价格结构化快照、currency/税率、事件 id/幂等键/trace id 全部进入 v1 定版；演进策略 additive-only 且与 `platform.schema.deprecated` 的关系成文（弃用 ≠ 删除：字段停止产生新值，历史保留，消费端必须容忍未知新字段） | §四 |
| M2 | 开发者账号体系无落位 | 独立身份域 DeveloperService：注册/凭证/发布者密钥对（签名验签）/收款账户登记；与内部 iam 员工域物理分离 | 第 5 步 |
| M3 | L0→L1 供给空窗 | 平台自营首批供给：内置 3 个可收费标杆 L0 插件（合同审查提示词包、周报生成器、数据脱敏模板）；L1 立项触发条件=收入信号 **或** 开发者 waitlist ≥ 20 **或** 企业询盘 ≥ 5；L1 技术预研（模块加载器 PoC）与第 7–9 步并行 | 第 7/10 步 |
| M4 | 分账账本会计工程 | 复式分录为**一笔复合分录（一借多贷）**；事件先进计量流水，**按账期汇总结总结转**（非逐笔结转）；金额一律整数最小货币单位（分）；币种单一 CNY 起步，汇率时点=事件发生时；尾差归平台损益账户；跨账期冲正用红字（负数）分录；`commission` 费率带版本号并与分录快照绑定（历史可复算） | 第 8 步 |
| M5 | 声明 vs 行为缺运行时对账 | usage 管道落地即含运行时对账：周期性比对「usage 事件中 principal 实际消耗的 resource/capability」vs manifest 声明 `capabilities`，偏差即告警（`usage.capability.drift`）并自动下架待审；L0 插件内容（提示词/配置）变更视为行为变更，**每次变更重走扫描审批**（内容指纹变更检测） | 第 2/3 步 |
| M6 | 资金通道缺席 | 资金通道依赖清单成文（§六），未就位项阻塞对应收费动作 | §六 |
| M7 | 身份卖点建立在模拟连接器上 | 第 0 步含钉钉连接器真实化（真实 OpenAPI HTTP 调用；未配置企业凭证时显式降级 mock 并在健康检查中标注 `mock:true`，不冒充真实） | 第 0 步 |
| M8 | 计量事件投递语义未定义 | 定义：**at-least-once 投递 + 消费端幂等**（`idempotency_key` = `usage:{principal}:{resource}:{window}:{seq}` 引擎级唯一）；计量事件 SQLite 持久化先于总线分发（先写后发，宕机不丢）；重复投递由消费端去重；失败重放=按 event_id 重放窗口内未确认事件；死信=超过 3 次消费异常的事件入 `usage:dead` 集合并告警 | §四 |

---

## 一、落地顺序（v1.2 执行版）

````
第 0 步  执行层/连接器真实化 + 计量与资金类数据迁往事务型存储
         （MCP 真实 HTTP 传输；钉钉真实 OpenAPI；node:sqlite TxnStore；
          mock 全面显式降级并打标；第 2/5/6/8 步硬前置）          【硬前置】
第 1 步  token scope/audience 收紧（aud 声明与校验、插件命名空间 scope、
          HMAC 过渡期密钥分发边界说明）
第 2 步  多租户最小集（租户维度建模）+ usage 计量管道统一化 + 
          usage.recorded schema v1 一次性定版（additive-only）+
          三方对账告警（财务/计费/运营订阅）+ 运行时对账（M5）
          （原第 4 步的租户维度前移并轨本步，S4 消解）
第 3 步  第三方插件契约五面 + platformBus source 校验 + 轻量代理 ctx +
          L0 声明式运行时 + dshctl plugin init 脚手架 +
          市场准入门禁（L1 沙箱交付前仅受理 L0）+ app 复合验收
第 4 步  多租户全量（组织/用户/资源挂租户、令牌携带 tenant、按租户隔离查询）
第 5 步  L1 模型转售（预算值 + 限额）+ 开发者门户 v1（含独立身份域/密钥对/收款登记）+
          资金流水最小集（只追加 journal + 幂等键，SQLite 事务）+
          资金通道依赖清单评审（§六，未就位项只允许对内试运营、不得对外收费）
第 6 步  OIDC Provider（RS256/JWKS：/.well-known/jwks.json、authorize、token、userinfo）
第 7 步  L0 声明式插件上架 + 第三方市场 beta（含平台自营首批供给 3 个标杆）+ L3 订阅代收
第 8 步  联合运维推广（灰度/熔断自愈/告警路由/SLO 报告——全部基于真实计量数据）+
          复式分账 ledger（账期汇总结转、红字冲正、费率版本）
第 9 步  知识库即服务 / 连接器市场 / 安全合规门户（设计见 docs/internal/roadmap-9-10.md）
第 10 步 L1 有码 JS 沙箱（自研模块加载器 PoC 与第 7–9 步并行预研，
          交付信号=平台自营 L0 付费转化 ≥ 3 单 或 waitlist ≥ 20）
````

依赖关系：第 0 步是 2/5/6/8 的硬前置；第 2 步定版 schema 含 tenant（第 4 步全量实现隔离）；第 3 步门禁在第 10 步交付前不放行有码插件；第 5 步对外收费以 §六清单就位为前提。

---

## 二、第 0 步：执行层/连接器真实化 + 事务型存储（S1/M7 消解）

### 2.1 事务型存储（TxnStore）

- 实现：`platform-core` 新增 `SqliteTxnService`（provide `txnStore`），基于 `node:sqlite`（Node ≥ 22.5 内置，无新增依赖；当前运行环境 v24.13）。
- 承载范围（**只有计量与资金类数据**，其余业务数据维持 JSON 集合存储以控制迁移风险）：
  - `usage_events`（计量流水，只追加）
  - `wallet_journal`（资金流水，只追加 + 幂等键唯一索引）
  - `ledger_entries`（复式分录，只追加）
  - `wallets`（余额快照，与 journal 同事务更新）
- 语义：`txn(fn)` 内多条写为单事务（BEGIN IMMEDIATE / COMMIT / ROLLBACK）；WAL 模式；`insertignore` 语义用 `INSERT OR IGNORE` + 唯一索引实现引擎级幂等；资金类表禁 UPDATE/DELETE（服务层不暴露改写接口，表上无此代码路径）。
- 一致性基线：余额 = Σ(journal) 可随时全量重放校验（selftest 断言）。

### 2.2 MCP 执行层真实化

- 服务记录新增 `exec` 字段：`'real' | 'demo'`。`demo`（确定性模拟）仅允许显式创建（种子演示数据），**新建服务默认 `real`**。
- `real` 传输：按 endpoint 发起真实 HTTP JSON-RPC（MCP streamable-http 形态：`POST {endpoint}`，`method: 'tools/call'`），带超时（默认 10s）、真实延迟/错误计量；探活为真实 `GET {endpoint}` 探测。
- `demo` 传输保留（演示环境），但在调用记录、监控指标、返回体中显式标记 `exec:'demo'`——SLO/计费报表**只统计 `real`**。
- 验收：selftest 启动本地真实 MCP stub（进程内 HTTP 服务），注册 `exec:'real'` 服务，断言真实往返、真实延迟记录、真实错误路径（stub 返回错误 → status error）。

### 2.3 钉钉连接器真实化（M7）

- `plugin-iam` 的 DingTalk Connector / AuthAdapter 改造为双模式：
  - **真实模式**：配置 `DSH_DINGTALK_APPKEY/APPSECRET`（或 iam 连接器配置表）后，走真实 OpenAPI（`/v1.0/oauth2/userAccessToken`、`/v1.0/contact/users/me`、通讯录分页拉取）。
  - **降级模式**：未配置凭证时使用内置 mock 目录，但 `healthCheck` 返回 `mock: true`，同步结果标注数据来源；**禁止**在任何对外 IdP 卖点文案中使用降级模式数据。
- 验收：selftest 以「钉钉 API 形状」起本地 stub（复刻 gettoken → userAccessToken → 用户档案链路），配置连接器指向 stub，断言真实 HTTP 往返登录成功 + state/code 防重放仍生效 + 未配置时降级标注。

### 2.4 第 1 步：token audience/scope

- 令牌新增 `aud` 声明；`verify` 支持受众校验（`verify(token, { audience })`，audience 不匹配 → 拒绝）。
- 插件命名空间 scope：`plugin:<id>:<cap>`；平台侧为已上架插件签发的令牌 scope 一律收敛到 `plugin:<id>:` 前缀（评审 §2.1 模式 A「唯一收敛面」）。
- HMAC 过渡期密钥分发边界（评审轻微问题 4）：当前单进程签发/校验，密钥不出 data 目录；网关/billing/门户多服务扩张后，对称密钥分发面=同机 data 目录读取，**跨机部署前必须完成第 6 步 RS256/JWKS 非对称化**（私钥仅签发服务持有）。

---

## 三、第 3 步：第三方插件契约 + 市场准入（S3 消解）

### 3.1 契约五面（L0 声明式）

````
third-party-plugin/
  plugin.yaml          # 元数据：id/version/publisher/signature/depends/capabilities_request/sandbox(L0 only)
  manifest/
    permissions.yaml   # 权限声明（requested；安装时企业逐项审批 → approved）
    api.yaml           # 声明式提供面（L0 阶段仅登记描述，不开放真实路由）
    events.yaml        # 事件订阅声明（仅允许订阅，不允许伪造平台事件）
    billing.yaml       # L3 计费声明（hybrid: subscription + usage meters + commission 版本）
  content/             # L0 内容：提示词包 / 配置模板 / 工具描述（无任何可执行代码）
````

- YAML 解析：仓库内置最小 YAML 子集解析器（缩进映射/列表/标量，platform-core `yaml.ts`），无外部依赖。
- 签名：publisher 以 Ed25519 私钥对「五面文件内容指纹」签名；平台以开发者登记的公钥验签（第 5 步密钥体系）。
- **能力声明 vs 实际行为**：capabilities 白名单在安装时固化为 approved 集合；运行时对账见 §四.4。

### 3.2 platformBus source 校验 + 轻量代理 ctx

- `emit` 增加来源语义：`emit(name, payload, opts?: { source?: string })`；平台事件（`iam.* / authn.* / mcp.* / audit.* / platform.*` 等平台命名空间）**只允许内部调用方**（未携带 `source` 或 `source` 不以 `plugin:` 开头）；第三方事件名强制收敛到 `plugin:<id>:` 前缀且 source 必须匹配。
- 轻量代理 ctx（`platform-core` `plugin-ctx.ts`）：`createPluginCtx(ctx, { pluginId, capabilities })` 返回代理对象——
  - `platformBus.emit` 被包装：自动盖 `source: plugin:<id>`，事件名强制 `plugin:<id>:` 前缀，越权 emit 抛错；
  - 能力裁剪：未在 approved capabilities 中的平台服务访问抛错；
  - **不做**模块级沙箱（那是第 10 步 L1 的工作）——代理 ctx 是「事件源鉴别 + 能力裁剪」层，配合 lint/静态扫描三层防线，明示静态层可绕过、以运行时对账兜底。
- 市场准入门禁（硬编码）：`sandbox: L0` 之外一律拒绝受理（错误信息指向第 10 步路线图）。

### 3.3 app 复合验收（F5 修正后的验收方式）

契约自验证不再以「拓扑最复杂」为由选 app，而是以「覆盖面」为由：验收断言联合校验——
1. 平台自有插件契约五面通过同一解析器/校验器（吃自己的狗粮）；
2. app 注册 → 上线 → on-behalf-of 调用 → usage 计量 → 成本穿透 → 拓扑展示全链路断言；
3. 计量事件中的 principal/act 链与 app 凭证一致性断言。

---

## 四、usage 计量管道与 schema v1（M1/M8 消解）

### 4.1 事件 schema（v1 定版，additive-only）

```jsonc
{
  "schema": "usage.recorded",
  "schema_version": 1,                    // 只增不改；新可选字段随 minor 版本加入
  "event_id": "uevt_...",                 // 平台生成，全局唯一，重放/死信的键
  "idempotency_key": "usage:<principal>:<resource>:<window>:<seq>",  // 引擎级唯一索引
  "trace_id": "tr_...",                   // 调用链追踪（可缺省）
  "occurred_at": "2026-08-21T08:00:00Z",
  "tenant_id": "t_...",                   // 多租户维度（第 2 步建模，第 4 步全量隔离）
  "org": "org_...",                       // 组织（租户内）
  "subject": "user:u_... | agent:ag_...", // 最终用户/Agent（on-behalf-of 终点）
  "principal": "plugin:<id> | app:<id> | platform",  // 计费责任主体
  "resource": "model:<slug> | plugin:<id> | mcp:<slug>",
  "meters": [                             // 可扩展计量字典（替代固定 token 三件套）
    { "key": "input_tokens",  "value": 1234, "unit": "token" },
    { "key": "output_tokens", "value": 567,  "unit": "token" },
    { "key": "contract.pages", "value": 12,  "unit": "page" }   // L3 自定义计量
  ],
  "pricing": {                            // 结构化价格快照（计价时点冻结，历史可复算；金额整数分）
    "currency": "CNY",
    "charge_cents": 30,                   // 挂牌价合计（rate 公式对计价 meter 求值）
    "cost_cents": 15,                     // 平台成本（毛利 = charge - cost）
    "rate": {                             // 费率版本快照（价格簿命中的规则原样冻结）
      "pattern": "model:deepseek-v3",     //   价格模式（资源匹配键）
      "meter_key": "output_tokens",       //   计价 meter（meters 中该键参与计费）
      "list_cents_per_unit": 10,          //   挂牌价（分/单位步长）
      "cost_cents_per_unit": 5,           //   成本价（分/单位步长）
      "units_per_step": 1000,             //   步长（如千 token、千次）
      "tax_rate": 0.06
    }
  }
}
```

- 金额一律**整数最小货币单位（分）**；currency 起步仅 CNY。
- **additive-only 演进**：只允许新增可选字段或新 `schema_version`；禁止改语义/删字段；弃用字段发 `platform.schema.deprecated { schema, field, since, consumer_action }` 事件，历史数据不迁移不重算。
- 消费端契约：**必须容忍未知新字段**（前向兼容义务写入接入文档）。

### 4.2 管道与投递语义（M8）

```
资源消耗方(mcp/model-gateway/plugin-runtime)
  → usage.record()  [校验 schema → SQLite usage_events 落库（先写后发）]
  → platformBus.emit('usage.recorded', event, {source: 'usage'})
  → 订阅方：audit 成本归集 / billing 扣费 / market 开发者分成 / 对账引擎
```

- at-least-once 投递；消费端按 `idempotency_key` 去重（billing 扣费幂等键=事件幂等键）。
- 消费异常重试 3 次后入死信集合并告警；`/api/usage/replay` 支持按窗口重放。

### 4.3 三方对账告警

财务（ invoicing 口径）、计费（billing 实扣口径）、运营（报表口径）三方各自订阅 usage 事件独立累计；对账引擎周期比对三方计数与金额，偏差 > 0.01% 即 `usage.reconcile.mismatch` 告警（critical）。对账方式=**全量比对 + 审计抽样佐证**（评审轻微问题 3 修正）。

### 4.4 运行时对账（M5，声明 vs 行为）

周期任务：聚合窗口内 usage 事件的 `(principal, resource)` 集合，比对 manifest 声明的 `capabilities_request/approved`；未声明能力的实际消耗 → `usage.capability.drift` 告警 + 自动 `suspend` 待审。L0 内容指纹变更（提示词/配置）→ 强制重走扫描审批。

---

## 五、资金与账本（S2/M4 消解）

### 5.1 第 5 步：资金流水最小集

- `wallet_journal`（只追加）：`id / idempotency_key(唯一) / at / tenant / owner_type(org|developer|platform) / owner_id / direction(credit|debit) / amount_cents / reason / ref_event / balance_after_cents`。
- 充值：`credit` 流水（幂等键=渠道单号）；扣费：usage 事件驱动 `debit` 流水（幂等键=事件幂等键，重复事件不重复扣）。
- **余额与流水同事务**（SQLite BEGIN IMMEDIATE）；余额=Σ流水恒等式 selftest 全量重放断言。
- 预算/限额：模型网关调用前检查「余额充足 + 月度预算未超」，超额拒绝（`quota.exceeded`），不计费。

### 5.2 第 8 步：复式分账 ledger

- 一笔 usage 在账期结束生成**一笔复合分录**（一借多贷）：

```
借：org:<orgId> 应收/消耗        1250 分
  贷：developer:<devId> L3 应收  1000 分（费率版本 v2026.08 快照）
  贷：platform 损益（L1+L2+佣金） 250 分
```

- 事件 → 计量流水（实时）→ **账期汇总结转**（非逐笔），月度账期；冲正=红字（负数）分录引用原事件 id；尾差（<1 分）归平台损益；`commission` 费率版本化，分录快照费率保证历史可复算。

---

## 六、资金通道依赖清单（M6）

| # | 依赖 | 阻塞动作 | 就位前过渡形态 | 责任方 |
|---|---|---|---|---|
| 1 | 对公收款账户 + 支付渠道（扫码/网关） | 第 5 步对外充值收费 | 对内试运营：线下转账 + 管理员手工录入充值流水（幂等键=转账单号） | 财务 |
| 2 | 开票主体与税率备案 | 对外开具发票 | 收据 + 账期结算单导出 | 财务/法务 |
| 3 | 开发者付款通道 + 代扣代缴协议 | 第 7/8 步 L3 分成结算 | 导出对账单人工结算（风险接受方=平台，平台垫付上限=当期分成总额的 0%，即不垫付，开发者确认账单后 T+30 汇款） | 财务 |
| 4 | 跨境结汇（如引入境外模型厂商） | 境外 L1 采购成本结算 | 起步只接境内转售渠道；币种单一 CNY | 财务 |
| 5 | 支付回调验签与对账文件接入 | 自动充值 | 手工录入（同 1） | 研发+财务 |

**红线**：清单 1/3 未就位 → 平台不得对外收费（只能对内试运营）；清单 2 未就位 → 不得承诺开票。

---

## 七、多租户（S4 消解）

- 第 2 步（schema 定版内）：`TenantRecord` 建模（id/name/status/套餐档位），org/user 增加 `tenantId`，缺省租户 `t_default` 兜底存量数据。
- 第 4 步（全量）：令牌携带 `tenant`；跨租户访问校验（`X-Tenant-Id` 仅平台运营角色可用）；usage/钱包/分账全部带 tenant 维度；市场安装登记按租户隔离。

---

## 八、交付状态表（本仓库实现与验证对照）

| 步骤 | 交付物 | 状态 | 验证 |
|---|---|---|---|
| 0 | SqliteTxnService / MCP real 传输 / 钉钉真实连接器 | ✅ 已实现 | selftest §step0（真实 stub 往返/错误路径/降级标注/事务回滚） |
| 1 | aud 校验 + 插件命名空间 scope | ✅ 已实现 | selftest §step1 |
| 2 | 租户最小集 + usage 管道 + schema v1 + 对账告警 + 运行时对账 | ✅ 已实现 | selftest §step2（幂等/去重/对账/漂移告警） |
| 3 | 契约五面解析 + bus source 校验 + 代理 ctx + L0 运行时 + init + 门禁 | ✅ 已实现 | selftest §step3 + app 复合验收 |
| 4 | 多租户全量（org/user/资源挂租户 + 令牌携带 + 隔离查询） | ✅ 已实现 | selftest §step4 |
| 5 | 钱包/journal/幂等 + 模型网关（预算/限额）+ 开发者身份域 + 资金清单 | ✅ 已实现（自动充值依赖 §六清单，手工充值通道可用） | selftest §step5 |
| 6 | OIDC Provider RS256/JWKS | ✅ 已实现（v1.4 App SSO 迭代升级：浏览器授权流 + Basic/Post 双认证 + token_use + refresh/end_session/revoke + JWKS 数组轮换 + 应用签发与上线门禁，见 docs/app-sso-integration.md） | selftest §step6 + §AppSSO/§OIDC 会话补全（含 openid-client 冒烟） |
| 7 | L0 市场 beta（上架/安装/自营供给） | ✅ 已实现 | selftest §step7 |
| 8 | 复式分账 ledger（账期结转/红字冲正） | ✅ 已实现 | selftest §step8（试算平衡） |
| 9 | KBaaS / 连接器市场 / 合规门户 | 📐 设计完成 | docs/internal/roadmap-9-10.md |
| 10 | L1 有码 JS 沙箱（模块加载器） | 📐 设计完成 + 预研 PoC 说明 | docs/internal/roadmap-9-10.md |

> 验收原则：每步断言进入 `tests/selftest.mjs`（E2E 黑盒，隔离实例 + 真实 HTTP），`npm run selftest` 全绿 = 交付门槛。
