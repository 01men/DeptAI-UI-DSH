# 元冰可平台 · 外部 Agent 全生命周期接入测试报告（2026-10-14）

> **测试目标**：验证本轮重构的核心能力——平台对外部 Agent 的纳管全生命周期：注册 → 机器凭证签发 → 接入（REST / MCP / CLI 三通道）→ 治理闸（上线门禁 / L4 审批 / 高危二次确认）→ 运行期（自助提报 / 指标上报）→ 下线 → 凭证冻结（令牌即时吊销）→ 归档。
> **测试环境**：生产实例 https://ybkkasi.com/（launchd 托管，本轮测试期间随修复两次平滑重启）。
> **被测 Agent**：zcode（本编码智能体，经 Bash+REST+MCP 真实接入）、dsh（经官方 CLI `cli/dshctl.mjs` 真实接入）、hermes（经 REST 真实接入）、lifecycle-test（一次性全状态机验证，已归档）。
> **关联报告**：[2026-10-14 线上整体性功能测试总报告](qa-report-20261014-live-overview.md) · [2026-10-13 重构后测试总报告](qa-report-20261013-overview.md)

---

## 一、总体结论

**外部 Agent 全生命周期纳管链路真实走通，三通道接入全部可用；测试过程实测发现并修复 2 项 P1（/mcp 工具权限基线缺失、Agent 域跨主体写），治理闸（上线门禁/L4 高危二次确认/凭证冻结联动吊销）全部按设计生效。**

- **账号面**：新注册 4 个平台测试账号（dev01 开发者 / ops01 资源管理员 / audit01 审计员 / hr01 组织管理员），建号、角色指派、登录验证全部成功，审计留痕完整。
- **Agent 面**：注册 4 个外部 Agent（注册即自动签发机器凭证，secret 仅一次返回）；zcode/hermes/dsh 三者保持接入态（draft），lifecycle-test 走完全部状态机后归档。
- **接入面**：REST（Bearer 机器令牌）、MCP（`POST /mcp`，JSON-RPC 2.0，78 个工具可见）、CLI（dshctl `DSHCTL_TOKEN` 直连）三通道全部验证；负向用例（无权限点调用）全部被正确拒绝且文案点名权限点。
- **治理面**：试运行要求 trialGroups、上线要求 systemPromptVersion+dataClass+entryUrl（身份纳管）、上线/下线为 L4 高危审批（须 confirmed=true + finalReview）、凭证冻结即吊销存量令牌且禁止重领票——**五道闸全部实测生效**。
- **质量门**：两次修复后 `selftest` 均 **1201/1201**；生产重启后逐项复验通过。

## 二、生命周期状态机实测（lifecycle-test-agent）

| 阶段 | 动作 | 结果 | 治理闸表现 |
|---|---|---|---|
| 注册 | `POST /api/agents`（owner=dev01） | ✅ draft | 自动签发机器凭证（principalId/clientId/clientSecret，secret 仅一次返回） |
| 提交试用 | transition `submit_trial` | ✅ trial | 首次被拒：「试运行需指定限定用户组（trialGroups）」→ 补齐后通过 |
| 申请上线 | transition `online` | ✅ 生成 L4 审批单 | 首次被拒两层：缺 systemPromptVersion/dataClass → 补齐后仍拒「必须完成身份纳管（OIDC 客户端或 entryUrl）」→ 登记 entryUrl 后生成审批单 |
| 高危审批 | `approval_decide`（MCP） | ❌→✅ | 工具面被拒「需二次确认 confirmed=true」→ 改走 REST `POST /api/approvals/:id/decide`（confirmed+finalReview）通过 |
| 运行期 | Agent 自身令牌访问 REST | ✅ 200 | skill.read 作用域内正常读取 |
| 申请下线 | transition `offline` → REST 高危审批 | ✅ offline | 同为 L4 高危单，confirmed 通过 |
| 冻结凭证 | `POST /api/authn/principals/:id/disable` | ✅ | **存量令牌即时 401**；client-credentials 重领票被拒「机器身份已禁用」 |
| 归档 | transition `archive` | ✅ archived | 完整轨迹：`draft → trial → online → offline → archived`（lifecycleHistory 全程留痕） |

## 三、三通道接入实测（zcode / dsh / hermes）

| 通道 | Agent | 验证点 | 结果 |
|---|---|---|---|
| MCP（`POST /mcp`） | zcode | initialize（serverInfo: dsh-ops-platform）/ tools/list（78 工具）/ tools/call agent_list、skill_search | ✅ 全通 |
| MCP 负向 | zcode→lifecycle-test | 未授权工具调用（修复后见第四节 P1-1） | ✅ 修复后正确拒绝并落 audit.authz.denied |
| REST | zcode/hermes | GET /api/agents、GET /api/skills、PATCH 自身 entryUrl/runtime（接入义务提报，agent.write） | ✅ 全通 |
| REST 负向 | hermes→zcode | 越权改他人 Agent（修复前 200 实锤，见 P1-2；修复后 403） | ✅ 修复后 403 |
| CLI（dshctl） | dsh | `agent list` / `skill list` 正常；`mcp list`（缺 mcp.service.read）/`user list`（缺 iam.user.read）403 | ✅ CLI 与 REST/MCP 同一套权限体系，拒绝文案点名权限点 |
| 指标上报 | zcode | `POST /api/agents/:id/metrics-report`（dau=1, sessions=3） | ✅ 计入 agent:usage 台账 + agent.metrics.report 审计 |

## 四、本轮实测发现并修复的缺陷（2×P1，均已上线生产）

### P1-A｜/mcp 对「未声明 permission 的工具」无任何权限基线
- **实测**：zcode-agent（scopes 不含任何 iam/audit 权限）经 `/mcp` 成功调用 `iam_user_list`（返回全平台用户目录）、`audit_logs`（38 条审计）、`authn_token_list`（29 条令牌清单）。
- **根因**：36 个存量工具未声明 `permission` 字段；REST 工具桥有路由级 `console.login` 兜底，而 `/mcp` 端点只校验「声明了的」权限点（`bridge.ts` tools/call：`definition.permission && …`），未声明的工具对**任意有效令牌**放行。外部 Agent 大规模发证的当下，等于任何机器凭证可读审计/令牌/用户三本敏感账。
- **修复**：`packages/plugin-console/src/routes/bridge.ts` tools/call 权限基线收敛为 `definition.permission ?? 'console.login'`（与 REST 面对齐）；为三个接入态 Agent 显式授予 `console.login` 基线 scope（scope 变更联动吊销旧令牌——安全机制实测生效，Agent 重新机器登录）。
- **复验**：无基线凭证（lifecycle-test）调用 iam_user_list / audit_logs / agent_list 全部被拒（文案点名 console.login）；有基线 + 有工具权限（zcode × agent_list/skill_search）正常放行；selftest 1201/1201。
- **遗留台账（P2）**：36 个存量工具的逐一 permission 声明（最小权限映射，如 audit_logs→audit.read、iam_user_list→iam.user.read、authn_token_list→authn.principal.read）应随下批次补齐，届时可回收 Agent 的 console.login 基线授量。

### P1-B｜Agent 域写操作缺失归属守卫（跨主体写 / 凭证接管面）
- **实测**：hermes-agent 的机器凭证 `PATCH /api/agents/<zcode-agent>` **200 成功改名**（探针名「被劫持」，已当场恢复）；对照 QA A-04 为 **app 域**补的 5 处归属守卫（PATCH/DELETE/onboarding-prompt/metrics-report/transition），**agent 域同款路由全部缺失**。其中 `onboarding-prompt?rotate=true` 可轮换他人机器凭证并返回新 secret——等于任意 agent.write 持有者可完全接管任意他人 Agent。
- **修复**：`packages/plugin-console/src/routes/agents.ts` 镜像 app 域 `assertAppOwner` 新增 `assertAgentOwner`（平台管理员 `'*'` / 人类 owner / 绑定本 Agent 的机器主体 refType=agent+refId 三态放行，其余 403 并落 `audit.authz.denied`），注入同款 5 处路由。
- **复验**（生产实测）：hermes→zcode PATCH **403**（文案点名负责人校验）；hermes→自身 PATCH **200**；hermes→zcode onboarding-prompt(rotate) **403**；dev01（owner）→自有 Agent **200**；selftest 1201/1201。

### 其他登记（P3/观察项）
| 编号 | 级 | 现象 | 建议 |
|---|---|---|---|
| LC-1 | P3 | `approval_decide` MCP 工具不转发 confirmed/finalReview——L4 高危审批无法经工具面决策（REST 面正常） | 工具签名补 `confirmed` 参数并透传（audit/src/tools.ts:54） |
| LC-2 | 观察 | usage 月报管道健康（J4 四维在位）但事件为 0——属实：未配置模型网关渠道、未发生计费型调用（modelgw.invoke/mcp_invoke）；控制面操作走 audit 不走 usage | 配置真实渠道后复测计量回灌 |
| LC-3 | 观察 | Agent runtime 枚举：dsh/hermes/openclaw/workbuddy/external（zcode 以 external 入库） | 如需 zcode 独立枚举值随品牌批次评估 |

## 五、交付物与账目

- **测试账号**（4 个，均验证登录）：dev01/ops01/audit01/hr01——凭证交付于仓库外安全文件 `~/ybkkasi-测试账号与Agent凭证-20261014.txt`（chmod 600，含 Agent clientId/clientSecret 与接入速查）。
- **接入态 Agent**（3 个，保持 draft 供日常使用）：zcode-agent / hermes-agent / dsh-agent；lifecycle-test-agent 已归档并冻结凭证。
- **审计对账**（取样 71 条）：agent.register ×4、iam.user.create ×4、authn.token.issue ×20 / revoke ×8（scope 变更联动吊销）、agent.update ×7（含劫持与恢复全程）、approval.create/decide/final_review ×2/2/2、agent.metrics.report ×1、authn.principal.disable ×1、console.authz.denied ×11（全部越权探针留痕在案）。
- **代码改动**：`bridge.ts`（/mcp 基线）+ `agents.ts`（5 处归属守卫），selftest 1201/1201 × 2，生产经 launchctl 平滑重启两次并逐项复验。

## 六、遗留与建议

1. **立即**：将本报告两处 P1 修复随下批 commit 入库（当前已生效于生产，git 未落账）。
2. **本迭代**：36 个存量工具 permission 声明补齐（P1-A 遗留台账），补齐后回收 Agent 的 console.login 基线；LC-1 approval_decide 工具补 confirmed 透传。
3. **下轮**：N1（上轮 P1，iam 工具面 manageActor 旁路）仍未修，本报告的基线收敛与其正交（基线管「能不能调到工具」，N1 管「工具内部组织隔离」），两者需分别修复并各补 selftest 断言；A2A 跨运行时调用（`/api/agents/:id/a2a/invoke`）与 OBO 令牌链路留待配置真实 Agent 运行时后回归。
