# Agent 接入宿主平台指引

> 面向对象：以机器身份接入平台的企业 Agent（注册 → 机器凭证 → 接入验证 → 计量对齐）。
> 适用版本：2026-08-26 接入加固落地后（Agent 凭证默认含 usage.write；计量键错误明确报 400 并给出期望键；
> 凭证支持轮换；机器身份访问 Agent 台账记审计 agent.verify）。加固清单见 `docs/internal/dev-plan-access-hardening.md`。
> 2026-08-30 NAS 数据权限上线：新增 4.5 节（文件网关接入、X-On-Behalf-User 身份红线、
> 越权/分享审批/降级语义），需文件能力的 Agent 必读。设计全文见 `docs/nas-authz.md`。
> 2026-10-31 资产使用凭证上线：新增 4.7 节（获取资产=授权 → 使用 → 逐次提报使用凭证，
> 提报记录进资产台账与审计，构成资产经营侧的使用证据），使用 skill/MCP 的 Agent 必读。
> 本文档随服务发布，可直接访问 `http://<平台地址>/docs/agent-onboarding.md`。

【任务】接入宿主平台 http://192.168.0.7:7300，完成 Agent 注册、机器身份打通与计量对齐。

0.5 平台自营 dsh Agent（一条命令登记）：若你要登记的是运行在 dsh 宿主上的平台自营 Agent，
   直接用登记脚本替代下述 1-3 步（幂等可重跑；注册 + 凭证落盘 0600 + entryUrl/提示词版本/密级提报 +
   首次运营提报 + Agent 关联 OIDC 客户端签发一次完成）：
   ```bash
   node scripts/register-dsh-agent.mjs --url http://192.168.0.7:3080 --entry http://192.168.0.7:3080/
   # 管理员凭证：DSHCTL_USER/DSHCTL_PASS（或已有令牌 DSHCTL_TOKEN）
   ```
   凭证落盘 `<data>/dsh-agent-credential.json`（含机器凭证与 OIDC 客户端凭证；secret 仅下发一次，
   丢失走轮换不重注册）。登记完成后仍需人工治理闭环：试运行（trialGroups）→ L4 上线审批
   （上线门禁：OIDC 客户端或 entryUrl 免登通道，AGENT_SSO_ENFORCE 可调）。

0. 环境：所有 dshctl 命令前先设置平台地址（CLI 默认指向 127.0.0.1，必须覆盖）：
   export DSHCTL_URL=http://192.168.0.7:7300
   （Windows PowerShell 用 $env:DSHCTL_URL="http://192.168.0.7:7300"，cmd 用 set DSHCTL_URL=...）
   机器令牌放 DSHCTL_TOKEN；管理员账号走 DSHCTL_USER / DSHCTL_PASS。

1. 注册（资源管理员账号，需 agent.write 权限）：
   dshctl agent create --name=<全局唯一名称> --model=<deepseek-chat|deepseek-reasoner|deepseek-coder> --riskLevel=<low|medium|high>
   （或 POST /api/agents）。成功后平台一次性下发机器凭证：clientId（mc- 前缀）/ clientSecret（cs_ 前缀）。
   secret 只出现一次：立即安全保存，不打印到公开输出、不写入代码或提示词；
   丢失或疑似泄露立即告诉我，由我执行凭证轮换（dshctl credential rotate，clientId 不变、旧 secret 立即失效、
   存量令牌全部吊销），不要重新注册。
   若返回 400「已存在」：用 dshctl agent list 按名称找到既有 Agent 复用，不要换名重复注册。
   attrs 是白名单制：白名单外字段（含 version，放 attrs 或请求顶层都一样）静默丢弃——返回 200 但不落库，
   不要以 200 判定字段生效。平台无通用 version 字段，也不登记提示词版本；模型版本与提示词版本写进
   description 和 tags（dshctl 不支持，需直接 POST /api/agents 或注册后 PATCH）。
   记下该 Agent 的 orgId（dshctl agent get <agt_...> 可查），第 4 步要用。

2. 登录打通（机器身份，不走 OIDC/SSO）：
   POST /api/auth/client-credentials  { "clientId": "mc-...", "clientSecret": "cs_..." } → 取 data.token。
   令牌有效期 2 小时，可重复换取；之后所有请求带 Authorization: Bearer <token>，
   用 dshctl 则 export DSHCTL_TOKEN=<token>。
   收到 401（令牌过期/无效）：重新换牌一次再重试原请求，不要反复硬试
   （换牌连续失败 5 次会锁定该 clientId 15 分钟，且逐次升级，最高 24 小时）。
   Agent 是机器身份，没有 redirect_uri，也不需要 SSO 客户端签发和用户授权页。

3. 接入验证（"发一句话"：首次运营数据提报）：带上一步令牌
   POST /api/agents/<本Agent的agt_...>/metrics-report  body {"dau":1,"sessions":1,"uniqueUsers":1}
   返回 200 且 GET /api/agents/<agt_...> 中 metrics.sessions ≥ 1 即接入完成（提报动作记入平台审计）。
   【接入义务（强制，不是倡导）】此后必须每日定时提报运营数据（与 AI 应用同级）：
   - dau：日活跃用户数（同日多次上报取最大）；sessions：对话会话数（同日累加）；
     uniqueUsers：对话去重用户数；有用户明细时随报 userIds 列表（平台侧即刻哈希脱敏去重，不落明文）。
   - 重复上报安全，可带 date（YYYY-MM-DD）补录历史；漏报导致平台运营数据失真，接入验收以本接口 200 为准。
   - 同时必须提报交互界面地址：PATCH /api/agents/<agt_...>  body {"attrs":{"entryUrl":"https://<真实交互入口>"}}
     （白名单内字段）——平台控制台据此在 Agent 卡片与详情页提供直达入口与授权访问，PATCH 后 GET 复核。
   - 调用量/成功率/Token 由平台经网关自动统计（dshctl agent metrics <agt_...> 可查），
     与上述提报口径互补，不能互相替代。

3.5 平台授权直达（交互界面建议支持的免登通道）：
   控制台「打开交互界面 / 带平台身份打开」不再裸跳转：平台先签发一次性入场票据，再以
   <entryUrl>#entry_ticket=<票据> 打开交互界面。交互界面侧只需两步：
   - 从 URL fragment 读取 entry_ticket（fragment 不进服务端日志，优于 query）；
   - POST /api/authn/entry-tickets/redeem  body {"ticket":"<票据>"}
     → 响应 data.identity 即平台用户身份：sub / username / name / org{id,name,tenantId} / roles / tenant；
       另返回 refType=agent、refId=<agt_...> 供校验票据确系发给本 Agent。
   票据一次性（重放被拒）、默认 120 秒过期（ENTRY_TICKET_TTL_SECONDS 可调 30~600）、
   兑换时实时校验账号状态；签发与兑换均入审计（agent.entry.ticket.*）。
   票据无效/过期时引导用户回控制台重新点击打开即可，不要缓存重试。
   注：签发侧授权=负责人/绑定用户/管理员（使用即授权留痕）；标准 OIDC 应用仍走 /oauth/authorize。

3.6 无交互界面声明（headless，2026-10-31 新增）：
   Work Body、定时任务型等纯后台执行体没有任何面向用户的交互界面——既签发不了带回调地址的
   OIDC 客户端，也没有 `entryUrl` 可登记。此类 Agent 由负责人（或 Agent 凭自身凭证）声明：
   PATCH /api/agents/<agt_...>  body {"attrs":{"headless":true}}
   声明后上线门禁（AGENT_SSO_ENFORCE=1 默认模式）凭已颁发的机器身份凭证放行；
   未颁发凭证的声明不放行（无凭证放行等于无主体上线）。控制台「Agent 详情 → SSO 配置」
   提供声明/撤销入口；声明写入属性并全程审计，上线 L4 审批照常执行，审批挂单期间撤销声明
   将被执行期复核拦截（对齐 SSO 客户端禁用同款语义）。
   另：`entryUrl` 现支持负责人在控制台 SSO 配置页直接登记（此前仅 Agent 侧自助提报）。

4. 计量口径（防漏计与双计）：
   - 经平台 MCP 网关 / 模型网关的调用，平台已自动计量——禁止再手动推送，否则同一消耗双计费。
   - 仅当绕过平台网关直连外部资源（直连模型 API、直连 MCP 服务）时才手动推送：
     dshctl usage record --org=<orgId> --subject=agent:<agt_...> --principal=org:<orgId>
       --resource=model:<slug>|mcp:<slug> --meter=<key>:<数量>:<key> --idempotency-key=<本Agent名>:<业务单号>
   - meter key 必须与价格簿一致：mcp:* 用 tokens；model:<slug> 用 output_tokens（v1 只按输出 tokens 计费）。
     用错键会被 400 拒绝且错误信息直接给出期望键，按提示改键重报即可，不要编造计量键。
   - resource 无计价规则同样 400，届时向我报告，不要自行换 resource 或编造 meter。
   - 幂等键 <Agent名>:<业务单号>：同键同内容重放安全（返回原事件），同键不同内容会被拒绝，业务单号须稳定。

4.5 NAS 文件能力与数据权限（Agent 需要文件读写能力时必读）：
   NAS 文件操作全部经平台文件网关（MCP，synology-filestation-mcp 形态）统一执法，
   平台侧按「组织位置 + 角色层级 RBAC（P/D/T/M + C 跨域只读叠加）+ 资源级例外」判定，全链 fail-closed。
   - 接入：向管理员申请文件网关令牌（已绑定目标 NAS 与 DSM 账户，并确认 allowedOnBehalf 标记），
     MCP 配置 url = http://<网关地址>/mcp，Authorization: Bearer <网关令牌>；
     设备路由与 DSM 凭据由令牌绑定决定，不要自行传 X-NAS-* 凭据头。
   - 身份红线（P0-2 教训）：真实用户身份一律经请求头 X-On-Behalf-User: <平台 userId 或钉钉 userId>
     透传，禁止放进工具参数/arguments。令牌未被标记 allowedOnBehalf 时携带该头一律
     403 FORGED_ON_BEHALF（防伪造，伪造行为留痕）。无用户上下文的纯机器调用可不带头，
     由令牌绑定的默认身份判定。
   - 越权语义：被拒操作返回 JSON-RPC error -32403「数据权限拒绝：<reasons>」。reasons 前缀可归因：
     path.out-of-scope（超出授权作用域）/ matrix.deny（角色矩阵无此操作权限，share 类会提示走审批）/
     org.*（组织位置异常，如挂根无负责人）/ account.*（账号特殊状态，如外部账号白名单只读）/
     degraded.*（平台判定服务不可达，已降级）。把原文透传给用户，不要变形重试硬闯。
   - 分享审批闭环：share 被拒且理由含「需走审批」时，代表用户发起申请：
     POST /api/nas/authz/exceptions
     body {"status":"pending","nasId":"<资产ID>","userId":"<用户ID>","path":"<路径>","reason":"<事由>"}
     → 平台自动生成审批单，审批人沿用户组织链自动路由（最近非空负责人，找不到升级 resource_admin 兜底）；
     通过后自动写入默认 7 天的 share 例外（到期自动失效，可先 POST /api/nas/authz/check 自查），全程留痕。
   - 降级语义：平台判定不可达时，网关按「最后已知作用域快照（仅只读）→ 全局只读 → 一律拒绝」降级；
     收到 degraded.* 前缀理由说明是平台短暂不可达而非用户越权——提示用户稍后重试即可，
     不要连续重试（网关有熔断：连续 5 次超时进入降级态，平台恢复后自动退出并留痕）。
   - 观察期语义：平台 observeOnly 灰度开关开启期间，越权操作仍放行但全部留痕并触发告警
     （网关 OBSERVE-DENY 日志、平台判定留痕可查）——放行是灰度设计，不代表越权合法。
   - 口径更新（2026-10-22 MCP 治理）：X-On-Behalf-User 降级为「仅归因」——该头只作调用归因
     （审计口径），不是授权事实；授权一律以令牌及其委托链为准，代用户操作优先改用委托令牌
     （POST /api/authn/token/exchange）。

4.6 服务级 MCP 数据面接入（调用平台已纳管 MCP 服务的标准路径，2026-10-22 起）：
   Agent 标准默认路径是服务级端点 POST /mcp/services/<服务slug>；/api/mcp/invoke 与
   mcp_invoke 工具保留为兼容层（行为不变，不必迁移，新接入一律走本节）。长令牌不透传下游：
   先换 audience 绑定目标服务的委托令牌，再走标准 MCP 协议（JSON-RPC 2.0 over POST）。
   - 第 1 步 · 换服务级委托令牌（用第 2 步拿到的机器令牌）：
     curl -s -X POST http://192.168.0.7:7300/api/authn/token/exchange
       -H "Authorization: Bearer <机器令牌>" -H 'content-type: application/json'
       -d '{"audience":"mcp:service:<服务slug>"}'
     → 响应 data.access_token 即服务级令牌（默认 900 秒有效，ttlSeconds 上限 3600）；
       audience 强制 mcp:service:<slug> 形态，携带其它受众令牌访问端点会 403 AUDIENCE_MISMATCH。
   - 换牌的三种模式（2026-10-22 终审裁决，机器凭证用第一种即可）：
     ① 自委托：只传 audience，sub=调用者自身（Agent 以自己身份调用平台已纳管服务）；
     ② 代用户委托：传 "userId":"<被代理用户ID>"，sub=该用户、act 链含 Agent（需该用户已绑定
        本 Agent，且令牌带与用户匹配的 scope）；
     ③ 人类换牌：人类令牌传 "targetPrincipalId":"<目标Agent/App主体ID>"，sub=本人、act=目标主体。
   - 第 2 步 · initialize 握手（响应头回 mcp-session-id，serverInfo.name=mcp:<服务slug>）：
     curl -s -X POST http://192.168.0.7:7300/mcp/services/<服务slug>
       -H "Authorization: Bearer <access_token>" -H 'content-type: application/json'
       -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"<agent-slug>","version":"1.0"}}}'
   - 第 3 步 · tools/list（平台按本 Agent 的 MCP 权限组过滤，未授权工具不出现在列表；
     列表即边界，不在列表中的工具调用同样被拒）：
     curl -s -X POST http://192.168.0.7:7300/mcp/services/<服务slug>
       -H "Authorization: Bearer <access_token>" -H 'content-type: application/json'
       -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
   - 第 4 步 · tools/call（统一走网关链：鉴权/限流/熔断/审计/计量）：
     curl -s -X POST http://192.168.0.7:7300/mcp/services/<服务slug>
       -H "Authorization: Bearer <access_token>" -H 'content-type: application/json'
       -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"<工具名>","arguments":{}}}'
     成功回 result.content[0].text（工具结果 JSON 串）；拒绝一律 JSON-RPC error，
     按 error.data.code 处理、不要变形重试：-32001 未认证（重新换牌一次再试）/
     -32003 拒绝（AUDIENCE_MISMATCH 受众不符 / TOOL_NOT_VISIBLE_OR_DENIED 工具不可见或未授权 /
     BREAKER_OPEN 熔断 / SERVICE_OFFLINE 已下线 / SERVICE_NOT_PUBLISHED 未发布）/
     -32004 RATE_LIMITED 限流 / -32000 服务错误（SERVICE_NOT_FOUND 服务不存在等）。
   - 别名形态 POST /mcp/s/<服务ID> 等价（aud 恒按服务 slug 校验）；无 audience 的平台令牌
     也可直连（可调用面同样以权限组为准），但长期令牌不得写进客户端配置出域；
     可调用范围由管理员配置的 MCP 权限组决定，需要新工具授权时向我（管理员）申请。

4.7 资产获取与使用凭证提报（使用平台 skill / MCP 后必做，2026-10-31 起）：
   完整链路：登记（步骤1）→ 获取资产（=授权）→ 使用 → 逐次提报使用凭证。使用凭证是资产经营侧的
   重要证据（资产台账「使用凭证」列、审计 asset.usage.report 逐次留痕），与步骤 4 的计量事件口径
   互补、互不替代：计量=平台自动统计（计费管道），凭证=使用方自证（使用事实）。
   - 获取（授权前提，无获取记录的提报会被拒）：
     · skill：管理员 install 绑定（POST /api/skills/<skill-id>/install  body {"agentId":"<agt_...>"}），
       或本 Agent 凭机器令牌自取（POST /api/skills/<skill-id>/download 登记 + GET /api/skills/<skill-id>/package
       拿 skill.zip——自取同样构成授权记录）；
     · MCP：管理员把本 Agent 配进 MCP 权限组（subjects 含本 Agent 且 policies 覆盖目标服务），
       调用走 4.6 服务级数据面。
   - 提报（每次使用后；机器令牌即可，无需额外权限点——注册默认 scope 已含 usage.write）：
     POST /api/assets/usage-reports
     body {
       "assetType": "skill",                  // 必填：skill | mcp
       "assetRef": "<skill 的 id/slug 或 mcp 的 slug>",  // 必填
       "assetVersion": "1.2.0",               // 可选：使用时的资产版本
       "action": "invoke",                    // 可选：默认 invoke（execute/call/read 等，小写下划线 ≤32 字符）
       "occurredAt": "2026-10-31T08:00:00Z",  // 可选：缺省当前；仅允许补录近 30 天，不接受未来时间
       "outcome": "success",                  // 可选：success | failure（失败也如实报，默认 success）
       "durationMs": 1234,                    // 可选：非负整数
       "tokens": 456,                         // 可选：非负整数（如适用）
       "taskId": "<业务单号/任务ID>",          // 可选：建议携带，经营侧按任务归因
       "note": "一句话说明",                   // 可选：≤500 字
       "idempotencyKey": "<agent标识>:<业务单号>"  // 必填：全局唯一；同键同内容重放安全（返回原凭证 deduped=true），
                                                  // 同键不同内容 409 拒绝
     }
     → 200 {report, deduped}；凭证实时进资产台账（GET /api/fleet/ledger 对应资产行 usageReports30d）
       与审计（GET /api/audit/logs 查 asset.usage.report）。
   - 错误语义（按码处置，不要变形重试）：
     · 403 NO_GRANT：本 Agent 尚未获取该资产——先走上面的获取链路，获取成功后原样重发；
     · 404 ASSET_NOT_FOUND：资产不存在或未上架——向我确认资产登记状态，不要编造 assetRef；
     · 409 IDEMPOTENCY_CONFLICT：幂等键已被不同内容占用——换业务单号重报，不要改内容撞同键；
     · 400 字段非法：按错误信息修正（assetType 枚举、occurredAt ISO8601 且在 30 天补录窗内）。
   - 工具面等价：经平台 MCP 工具面接入的 Agent 可直接调 asset_usage_report 工具（参数同上），
     不必手拼 REST。
   - 口径边界：经平台数据面（4.6）的 MCP 调用平台已逐次计量+审计（等价凭证），无需逐次重复提报，
     可按任务/会话粒度汇总提报（taskId 关联）；skill.zip 下载到本地执行平台无感知，必须逐次提报。
     步骤 4 的计量义务不因提报凭证而免除或替代。

5. 权限自检与护栏：接入完成后先试跑一次换牌（步骤2）和一次 usage record（步骤4）。
   403 = 缺权限点（响应体会指明缺哪个），向我报告，不要换账号或重试硬闯；
   403 本身不触发锁定，触发锁定的是登录/换牌类连续失败（按用户名或 clientId 计，5 次/15 分钟窗口起）。
   不做上线/下线等审批操作；若任务明确要求"正式上线"或"可被应用编排"，
   先补齐治理属性（dataClass；试运行还需 trialGroups），再走平台 L4 审批流，不得绕过。

【完成后回报】Agent id（agt_ 前缀）、clientId、首次运营数据提报（metrics-report）与 entryUrl 提报的
状态码与关键证据（响应片段 + 控制台「Agent 本体 → 监控」页运营数据、审计页 agent.metrics.report 记录）、
本次接入中使用过的平台资产的首条使用凭证提报证据（POST /api/assets/usage-reports 200 响应片段，
未使用资产则注明「未使用」）、控制台查看路径（http://192.168.0.7:7300/ →「Agent 本体」页）。

---

## 附：2026-10-22 治理属性收敛

Agent 白名单已移除 `systemPromptVersion`（系统提示词版本）。上线门禁只剩：

1. `dataClass`（数据密级，必填枚举）；
2. 身份纳管（签发 OIDC 客户端、登记 `entryUrl` 免登通道，或声明 `headless` 无交互界面三选一——
   headless 适用于 Work Body 等纯后台执行体：无任何面向用户的界面时，凭已颁发的机器凭证放行，
   `AGENT_SSO_ENFORCE=oidc` 严格模式不适用）；
3. 进入试运行另需 `trialGroups` 非空。

提示词与模型版本请写进 `description` / `tags`：平台不承担提示词版本台账职责，
不提供通用 `version` 字段，也不需要伪造字段名。存量登记里已存在的
`systemPromptVersion` 值不再参与校验，展示层也不再读取。
