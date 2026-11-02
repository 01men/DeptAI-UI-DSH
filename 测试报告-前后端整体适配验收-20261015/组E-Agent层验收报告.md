# 测试组 E · Agent 层平台验收报告（外部 Agent 客户端视角）

- **被测**：元冰可·企业AI资源管理平台 `http://127.0.0.1:7301`（运行中实例，未触碰进程与 7300）
- **日期**：2026-10-15 ｜ **执行**：/tmp/qa-e/（dshctl-walk.mjs / dshctl-writes.mjs / chains3~9.mjs，结果 JSON 同目录）
- **视角**：外部智能体（dsh 宿主 / MCP 客户端 / 面板任务）完成「注册→取凭证→调用→计量→审计」平台层级闭环
- **约束遵守**：未改仓库源码；临时脚本与凭证全部落 /tmp/qa-e/；测试资产全部 qa-e 前缀；stub 上游（127.0.0.1:7391/7392）已下线、deepseek-chat 模型条目已复原

## 一、链路验收表

| # | 链路步骤 | 预期 | 实测 | 证据 |
|---|---|---|---|---|
| 1 | 注册/发现资产 | register-dsh-agent 幂等注册，凭证不落仓库 | 注册成功 agt_mv9onaiehv5pb30y，凭证写入 /tmp/qa-e/dsh-agent-credential.json（0600）；dshctl agent list/get/metrics 可查 | chains3 F03；walk agent get PASS |
| 2 | 取凭证（机器身份） | 注册即下发 mc-/cs_；换牌/扩权/轮换/吊销闭环 | client-credentials 换牌 ✓；dshctl credential create/scopes/rotate ✓（存量令牌联动吊销）；token issue/revoke ✓；错 secret fail-closed ✓ | chains9 GD-1~3；写批次 |
| 3 | Agent 状态机 | draft→trial→L4 上线审批→online；下线联动 | 门禁（trialGroups/entryUrl/systemPromptVersion/dataClass）逐项拦截 ✓；职责分离（提交人≠审批人）✓；L4 需 confirmed:true ✓；下线→机器凭证自动禁用 ✓ | chains7 CA-1；chains8 GA-1/GB-1~3；chains3 C1-3 |
| 4 | A2A 点名直调（C3） | 200+ok:true+reply/model/autonomy/runtime；404/未上线400；计量+审计 | 成功/404/400 全符合，审计 ok 分支留痕 ✓；**零价快照 usage 事件缺失（P0-1）** | chains9 CB-1~3/6；usage events resource=agent:<id>=0 |
| 5 | MCP（外部客户端） | 最小 MCP 客户端经 /mcp 三步握手真实调用工具 | initialize(serverInfo+mcp-session-id)→tools/list(36+工具)→tools/call(mcp_invoke) 真实抵达 stub ✓；REST /api/mcp/invoke ✓；权限组白名单外 fail-closed ✓；usage mcp:<slug> ✓；calls 流水（caller=agent 身份）✓ | chains7 CC-1~3 |
| 6 | Skill（skillhub） | submit→两级审批→publish→install→直调 | 全 CLI 链 ✓（低风险单级 domain 审批即 approved，重复加签被状态机拒）；J1 直调 ok:true+reply/model/skill/斜杠原文 ✓；usage skill:<ID> ✓ | chains7 CE-1~3 |
| 7 | 面板 J1 诚实降级 | 不存在/未上线→200+ok:false+reason（不造假回复） | 不存在技能 200+ok:false+reason ✓；panel_agent_invoke 幽灵 Agent ok:false+reason ✓；REST /api/panel/rd/skills 清单可见性 ✓ | chains7 CE-4~5；chains3 C5-5~9 |
| 8 | workforce 数字员工域 | 员工→任用探针→拉取→认领四件套→续租→受控调用→交付→accept | 全链 PASS：员工 active、任用 effective（MCP 权限组+模型探针）、work-items 反查、claims 幂等四件套、renew 心跳、受控 MCP/模型 completed、deliverable→review→accept→done；用量 mcp:<slug>≥3、model:<slug>≥1 | chains7 CD-1~10 |
| 9 | 入口票据（authn） | 签发→一次性兑换→重放拒绝→审计 | etk_ 签发、兑换返回 refType=agent+标准身份（sub/org/roles）、重放 400、agent.entry.ticket.redeem 审计 ✓ | chains3 C3-1~2 |
| 10 | 计量与审计（J4） | 每次调用产生 usage 事件 + audit 留痕 | usage events/totals 可查 ✓；幂等键重放同事件 ✓；错 meter 键 400 并给出期望键 ✓；未计价资源 400 ✓；audit 各域（invoke/change/auth）留痕 ✓；MCP 调用另有 calls 流水双留痕 ✓ | 写批次 usage 正反例；chains 各 CB/CC/CD 断言 |

**结论性计数**：10 条链路全部走通（其中链路 4 的计量环节存在 P0 缺陷，其余环节符合契约）。

## 二、缺陷表

### P0（链路断裂 / 计量缺失）—— 1 条

| ID | 摘要 | 证据 |
|---|---|---|
| P0-1 | **A2A 契约计量永不落账**：`packages/plugin-console/src/routes/agents.ts:226` 调用 `nonbillableUsage()`，但该文件未 import（定义在 plugin-usage/src/index.ts:111）→ 运行时 ReferenceError 被 `try{usage.record}catch{/* 计量面缺席不阻塞 */}` **静默吞掉**。C3 契约 §三冻结项「非计费零价快照事件 resource=agent:<id>」实测 before=0/after=0（模型网关侧 tokens 事件正常落账，仅 A2A 契约计量缺失）。外部审计对账时 A2A 调用不可见 | chains9 CB-5（取证断言）；chains4/v5 同象 |

### P1（行为与契约/文档不符）—— 5 条

| ID | 摘要 | 证据 |
|---|---|---|
| P1-1 | **Agent 状态机 `retrial` 分支未实现**：schema.ts:91 冻结 offline→trial（retrial），但 `/api/agents/:id/transition` 仅处理 online/offline/submit_trial/archive（agents.ts:377-387），`retrial` 报「未知操作」；同形 `retrial` 在 apps.ts:235 已实现。叠加下线联动禁用机器凭证（安全正向），offline Agent **无任何 API 复线路径=状态机死锁**（测试 Agent qa-e2e-agent 实证卡死 offline；复线只能靠控制台人工或直接改库） | chains5 CA-1 双探针报错原文；authn/index.ts:185「Agent 下线联动」 |
| P1-2 | **非法 from 状态仍可创建上线审批单**：offline Agent 请求 `action=online`（合法 from=['draft','trial']）不被拦截，审批单照常创建，第二审批人批准后执行失败（approval status=failed）。应创建时校验状态，而非让审批人批准一张必然失败的单 | chains5 CA-3（decide 返回 failed）；approvals 台账 apr_mv9p7k0zi31wvxfg / apr_mv9pcposi337s0ka 均 failed |
| P1-3 | **dshctl `agent topology <id>` 帮助承诺但实现缺失**：help 列出该子命令，执行报「未知动作：agent topology」（dshctl.mjs 无 handler） | walk 结果 [FAIL]，stderr 原文留档 |
| P1-4 | **dshctl `mcp get <id>` 必然崩溃**：dshctl.mjs:579 `{ out(await call('GET', \`/api/mcp/services\`)).services; return }` ——未按 id 取详情且括号错位（对 out() 返回值取 .services）→ TypeError: Cannot read properties of undefined (reading 'services') | walk 结果 [FAIL]，堆栈留档 |
| P1-5 | **dshctl `group list` 帮助承诺但资源不存在**：help 列「group list 用户组列表」，解析器报「未知资源：group」 | walk 结果 [FAIL] |

### P2（体验 / 文档漂移）—— 6 条

| ID | 摘要 | 证据 |
|---|---|---|
| P2-1 | dshctl 全局选项只能后置：`--output json` 放资源前报「未知资源：--output」，help 未说明；35 条命令首轮全数踩坑 | dshctl-walk 首轮 |
| P2-2 | L4 高风险审批需 `confirmed:true` 二次确认，`dshctl approval decide` 不传该字段→CLI 无法独立批准 Agent 上线单（REST/控制台可），CLI 帮助无提示 | chains3 C1-3 报错原文「高风险审批通过需二次确认（confirmed=true）」 |
| P2-3 | `dshctl mcp invoke` 对 denied 业务结果 exit=0：非交互 Agent 调用无法凭退出码判败（demo 服务未授权主体被拒仍成功退出） | 写批次补充执行 |
| P2-4 | `credential create` 等 `--output json` 下先输出人类可读行再输出 JSON，机器消费需剥前缀（同批其他命令为纯 JSON，口径不一） | 写批次 credential create stdout |
| P2-5 | Agent 上线门禁属性分散（trialGroups/entryUrl 或 OIDC/systemPromptVersion/dataClass），报错一次只披露当步缺项；agent-onboarding.md §5 有清单但未写明「须先 PATCH attrs 再 transition」的顺序，外部 Agent 需多轮试错 | chains5→chains7→chains8 三轮补齐过程 |
| P2-6 | `update check` 依赖外网，离线环境报 UPSTREAM_ERROR 且把「fetch failed」与「HTTP 404」两种错误串联输出（环境限制为主，文案可读性次之） | 写批次 [FAIL] stderr |

**计数：P0=1，P1=5，P2=6**

## 三、dshctl 命令走查统计

- 只读批次 48 条（35 全域 + 13 按 id 深查）+ 写批次 24 条 + 修正复跑/插件链/专项 13 条 + 各链路内调用 ≈ **120+ 次调用，覆盖 help 全部 22 个资源域、56 个子命令**（高风险未执行：update apply、skill storage set、connector gateway set、user freeze、nas 写类——无真实 NAS；app report 未对种子演示应用执行以免污染运营数据，等价义务已由 agent metrics-report 验证）
- 结果：**52 个子命令跑通；3 个实现缺陷（P1-3/4/5）；1 个环境性失败（P2-6）**；usage record 正反例、幂等、错键提示均符合设计

## 四、结论

**能**：一个外部 Agent 客户端凭平台自带入口（register-dsh-agent + dshctl + /mcp + REST）可以完整走通「注册→取凭证→调用（A2A/MCP/Skill/workforce/面板 J1）→计量→审计」的平台层级验收，治理门禁（状态机/职责分离/confirmed/权限组 fail-closed）真实有效、无绕过面；但带 1 个 P0（A2A 计量静默缺失，违反 C3 冻结契约）与 5 个 P1（CLI 三处承诺未实现、retrial 死锁、非法审批单），建议修复 P0-1 与 P1-1 后再对外宣布「Agent 层验收通过」。

## 附录：证据文件

- /tmp/qa-e/dshctl-results.json（只读走查 48 条）
- /tmp/qa-e/dshctl-writes-results.json（写批次 24 条）
- /tmp/qa-e/chains3-results.json / chains5~9-results.json（链路断言与证据）
- /tmp/qa-e/dsh-agent-credential.json（测试 Agent 机器凭证，0600）
- 源码锚点：packages/plugin-console/src/routes/agents.ts:226（P0-1）、:377-387（P1-1/P1-2）；packages/plugin-agent/src/schema.ts:91（retrial 冻结项）；cli/dshctl.mjs:579（P1-4）
