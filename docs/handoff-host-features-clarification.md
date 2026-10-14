# 宿主平台功能移植 · 风险/疑点澄清（回应主分支移植反馈）

> 目标读者：ybkkasi 主分支开发 Agent。
> 本文档逐条回应移植汇报（提交 4d882f1，927/927 全绿）文末的 8 项风险/疑点清单。
> 结论口径：**【采纳调整】/【维持现状】/【接受为已知限制】**，每条附理由与（如需）main 侧的具体调整说明。
> 前置文档：[handoff-host-features-to-main.md](handoff-host-features-to-main.md)（差异清单）。
> 答复方：DSH-RQ 定制分支团队（RQ）。生成时间：2026-09-08。

---

## 1. CORS 默认 `['*']` ——【采纳收紧：/api/auth/* 对 `*` 永不发放，精确来源可显式放行】

主分支指出的风险成立：`/api/auth/login` 等凭证铸造端点的响应体可被任意网页跨站读取，
"纯 Bearer 通道"的理由确实没有覆盖**无凭证即可探的公开端点**。采纳收紧，但建议按下面的规则做，
在安全与「宿主连接切换」功能之间取平衡：

**落地规则（建议 main 侧照此实现，RQ 侧在下次上游同步时吸收同款变更）：**

1. `access-control-allow-origin: *` 的 blanket 放行在现有豁免清单（`/api/portal/`、`/api/authn/oidc/`）
   基础上**追加 `/api/auth/`**——即 `*` 永不作用于登录/刷新/票据兑换等令牌铸造与交换面；
2. `corsAllowOrigins` 配置了**具体来源列表**（非 `*`）时，`/api/auth/*` 同样按精确来源放行
   （`corsAllowOriginFor` 返回具体 origin 时不受豁免清单限制）；
3. 不建议默认收紧为 `[]`：面板/控制台在两种形态（独立/宿主挂载）下与数据面恒同源，`*` 对同源面无意义；
   跨源数据面切换（A 机页面直连 B 机 /api/*）依赖默认 `*`，收紧为 `[]` 会让该功能失去零配置开箱可用。

**行为影响（写进部署文档）：**
- 默认部署：跨站网页无法再读取 login 响应/通过预检（drive-by 凭证探测面关闭）；已登录态的跨源数据面调用不受影响；
- 远程连接的**在线登录与令牌续期**（POST /api/auth/login、/api/auth/refresh 跨源发起）从"默认可用"
  退化为"需 B 侧显式配置 `corsAllowOrigins=[A 机来源]`"——跨机器部署本就应显式放行，符合零信任默认基调。

**selftest 同步**：`corsAllowOriginFor` 纯函数断言追加 auth 路径用例（`*` 配置下 /api/auth/login 不发放、
精确来源配置下发放）；dispatch 层追加 `Origin` 头跨源访问 `/api/auth/login` 无 ACAO 的断言。
RQ 侧现有「CORS 决议：\* 放行任意来源」断言将随合并更新，不构成分叉。

## 2. AGENT_SSO_ENFORCE 默认 '1' 的存量影响 ——【维持默认 '1'，补迁移指引；不放宽为 '0'】

门禁默认开启是 M2 的设计本意（dev-plan-agent-host-unification：Agent 上线前必须完成身份纳管），
放宽为 '0' 等于关闭该特性，不接受。澄清三点存量影响面，确认冲击可控：

1. **只拦新增，不动存量在线态**：门禁只作用于 `requestOnline` 挂单与 `agent.online` 审批执行器两个点
   （双点复核），**已在线的 Agent 升级后不会被强制下线**，无存量运行面冲击；
2. **被拒时文案自带指路**：`'1'` 模式下未纳管 Agent 挂单即被拒，报错文案明确给出两条补救路径
   （签发关联 OIDC 客户端，或登记交互界面地址 `entryUrl` 免登通道）——`entryUrl` 是零成本逃生门，
   任何有交互界面的存量 Agent 填一个 URL 即可通过门禁；
3. **升级指引（请 main 侧补入发布说明/升级文档）**：升级后首次申请上线的存量 Agent 二选一——
   「Agent 本体 → 详情 → SSO 配置」签发 OIDC 客户端，或属性登记 `entryUrl`；
   开发环境确需跳过时显式设 `AGENT_SSO_ENFORCE=0`（代码注释已标注仅建议开发环境）。

## 3. 面板模型目录权限口径（panel.config.write vs modelgw.admin）——【维持 v1 口径，登记多租户收敛点】

事实确认：`org_admin` 内置角色确实持有 `panel.config.write`（iam 内置角色矩阵），因此组织管理员
可在面板增删改模型网关登记（endpoint/apiKey）。这是**功能需求的直接语义**：面板模型配置的需求原文即
"部门工作台要支持模型配置"——面板定位就是部门级自助，若收敛回 `modelgw.admin`（平台管理员专属），
该功能对目标用户（部门管理员）即失效。

**风险评估的补全**（比汇报中"可重路由 AI 调用"更完整）：
- 组织管理员把 endpoint 指向自己控制的服务器，确实会让 @Agent 消息的频道上下文+系统提示 POST 过去
  （数据外带面）——但 org_admin 本就是组织内可信管理员（可管理部门成员、激活行业、审批协作），v1 单组织
  信任域内该风险与既有权限语义一致；
- 计量与计费不旁路：无论 endpoint 指向哪，modelgw.invoke 的预检/计量/扣费全链不变，费用仍归属调用组织。

**结论**：v1 维持口径，不调整。登记为**多租户化收敛点**：当平台出现跨组织共享 modelgw 的部署形态时，
模型目录写入应引入组织作用域（`modelgw.admin` 按组织分域，或新增 `panel.model.write` 且默认不授 org_admin）。
main 侧如需立即收紧，最小改动 = 面板模型写路由改查 `modelgw.admin` + 前端编辑控件按 `session.can('modelgw.admin')`
显隐 + selftest 对应 4 处断言改口径——但请先与需求方确认，这将改变功能的目标用户。

## 4. SSE token 走 URL 查询参数 ——【接受为已知限制，补部署层指引】

`/api/panel/stream?token=` 是 EventSource 无法携带 Bearer 头的既定权衡（代码注释与交接文档均已声明）。
补充风险评估与缓解事实，请 main 侧把部署指引写入运维文档：

- **暴露窗口有界**：stream 的 token 是 30 分钟时效的 access token（`ACCESS_TTL_MS = 30 * 60_000`），
  撤销/过期即时失效（authn 小时级巡检清理），日志残留的可利用窗口 ≤ 30 分钟；
- **fail-closed**：端点公开路径但 `?token=` 内部自校验，无效即 401，SSE 建立后无提权面；
- **部署指引（请 main 补充）**：访问日志对 `/api/panel/stream` 的查询串脱敏（或该路径日志短保留期）；
  Nginx/反代 `log_format` 同理；
- **后续硬化方向**（记入 backlog，不阻塞本次）：挂载形态可改用 dsh-bridge 会话 Cookie 鉴权；或以
  fetch 流式读取替代 EventSource（可带 Bearer 头），前者依赖宿主形态、后者需重做降级轮询联动。

## 5. dsh 会话归属 current 回落（最近一次绑定身份）——【接受为已知限制，v1 维持单操作者姿态】

确认属实：工具出站归因在会话未绑定时回落"最近一次绑定身份"，多用户并发宿主下可能归因错人。
设计文档（dev-plan-agent-host-unification）已声明 v1 目标形态为**单操作者工作站**，该回落在此姿态下正确。

**结论**：多用户并发宿主不是 v1 支持形态，该限制接受；但请 main 侧补两条护栏性声明：
1. 部署文档标注：多用户并发使用宿主时，工具出站的 usage/audit 归因（on-behalf-of）**不作为计费与追责的
   事实源**（面板协作面的归因不受影响——那条链路走平台自身会话，与 dsh 绑定无关）；
2. backlog 登记硬化方向：dsh 会话级绑定（dsh session ↔ 平台身份随会话传递），替换进程级 current 回落。

## 6. DSH STORE 上架的 LICENSE 缺口 ——【补入 main：LICENSE 属上架契约，不是治理私有文件】

F 节把 LICENSE 归入"治理文件"是我们的分类过严，主分支的判断正确：`package.json` 的
`files` + `compatibility` 是上架契约，LICENSE 是其中必需项。澄清与授权：

- 请将 RQ 仓库根目录的 `LICENSE`（MIT，`Copyright (c) 2026 01men and DSH-RQ contributors`，
  与 `package.json` 的 `"license": "MIT"` 一致）原样提交进 main，并**恢复 `files` 数组中的 `LICENSE` 条目**；
- 该文件可直接复制，无需重写。

## 7. dingtalk-h5-smoke.mjs / walkthrough.mjs 取舍 ——【同意暂缓，随 F 范围一并评估】

确认：这两个测试依赖 F 范围的钉钉 H5 降级链路（realtime.js 的 UA 探测分支断言）与五平台主题断言，
在 F 范围未随迁的情况下搬运会产生红测。同意 main 侧取舍：本次不搬，待 F 范围（钉钉 H5 降级、
五平台卡片包主题）单独评估合并时一并补入。A–E 域的回归强度由 selftest 已移植的 14 个宿主功能分节
（927 项）与 full-chain-drill/morning-peak 覆盖，不受影响。

## 8. 文档偏差（e8c0421 / selftest 路径）——【以 main 实测历史为准，交接文档不影响移植内容】

- `e8c0421`（产品落地页）是 D:\DSH-RQ 于 2026-09-08 `git fetch` 时点的 `origin/main` 追踪引用快照；
  上游历史如有改写（force push），以 main 仓库 `git log` 实测为准（`a561362`）。该清单只用于"上游有哪些
  新提交"的背景提示，不影响移植内容本身，无需回改交接文档；
- `scripts→tests` 目录迁移（663a8be 瘦身治理）不随迁、main 保持 `scripts/selftest.mjs` 路径——同意，
  行为等价；RQ 侧后续文档引用 selftest 路径时以 main 布局为准。

---

## 汇总

| # | 疑点 | 结论 | main 侧动作 |
|---|---|---|---|
| 1 | CORS 默认 `*` | 采纳收紧 | blanket `*` 追加豁免 `/api/auth/*`（精确来源配置可放行）；selftest 补断言；部署文档标注 |
| 2 | AGENT_SSO_ENFORCE 默认 '1' | 维持 | 补升级指引（签发 OIDC 客户端 / 登记 entryUrl / 开发环境显式 '0'） |
| 3 | 模型目录权限口径 | 维持 | 无动作；登记多租户收敛点 |
| 4 | SSE token 走 URL | 接受为已知限制 | 运维文档补日志脱敏指引；backlog 登记硬化方向 |
| 5 | 会话归属 current 回落 | 接受为已知限制 | 部署文档补"多用户并发不作为计费/追责事实源"声明；backlog 登记会话级绑定 |
| 6 | LICENSE 缺口 | 补入 | 复制 RQ LICENSE（MIT）进 main + 恢复 files 条目 |
| 7 | 两个测试文件取舍 | 同意暂缓 | 随 F 范围评估一并补 |
| 8 | 文档偏差 | 以 main 实测为准 | 无动作 |

第 1、2、6 项落地后，本次移植即视为收口；第 4、5 项请落在文档层；第 3、7、8 项留档待议。
