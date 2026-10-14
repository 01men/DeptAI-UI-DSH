# J1 契约：面板技能/Agent 点名直调 v1（冻结稿）

> 冻结日期：2026-09-11 ｜ 所有者：宿主轨 main（ybkkasi）｜ 消费方：定制侧面板（RQ-DSH）、dsh 对话协作
> 变更纪律：本契约升版须发发布说明并双侧同步（红线 1）；定制侧以发布说明为 merge 翻译层。
> 背景：定制侧 C1-2 已按风险预案先行原语与 UI（plan-dual-track-custom §C1-2），本契约将 main 侧
> 同形实现冻结为 v1——双侧形状一致，定制侧实现即对表（计量资源键一处差异见 §6）。
> 实现锚点：`packages/plugin-panel-core/src/service.ts` `PanelService.askAgent()/invokeSkill()/listInvokeableSkills()`；
> 路由 `packages/plugin-panel-core/src/index.ts`；工具 `panel_agent_invoke` / `panel_skill_invoke`。

## 1. 服务原语（工具与对话框共享）

| 原语 | 输入 | 成功 | 失败（诚实降级） |
|---|---|---|---|
| `askAgent(deptId, agentName, question, options)` | 部门 id + Agent 名册全名 + 问题 | `{ ok: true, reply, model }` | `{ ok: false, reason }` |
| `invokeSkill(skillName, message, options)` | 技能名或 slug + 输入 | `{ ok: true, reply, model, skill: { name, version } }` | `{ ok: false, reason }` |

- options：`{ userId?, modelOverride?, contextNote? }`；`userId` 用于组织归口（callerOrgId）与计量 subject。
- **不静默原则**：可预判失败（名册无此 Agent / 未绑定资产 / 未配模型 / 技能不存在 / 未上架 / 不可见 /
  无指令内容 / 无在线模型 / 网关失败）一律返回 `ok:false + reason`（中文人读文案，直接可展示），**不造假回复**。

## 2. REST 面（guarded，部门范围权限同全面板路由）

- `GET /api/panel/:dept/skills`（`panel.read`）→ `{ skills: [{ id, name, slug, summary, category, version }] }`
  ——skillhub **published** 且对调用人组织可见（`visibility='all'` 全量；`'orgs'` 时按 `targetOrgs` 含调用人
  所属组织才可见），按下载量降序。
- `POST /api/panel/:dept/skills/invoke`（`panel.write`）入参
  `{ skill, message, channelId?, model?, uniqueKey? }`，`message ≤ 10000` 字符：
  - **降级语义（J1 核心）**：可预判失败以 **HTTP 200 + `ok:false` + `reason`** 回包——降级是数据不是传输错误；
    鉴权/部门范围/参数校验失败仍走传输层 403/400。
  - 留痕：斜杠原文 `/<skill> <message>` 先落频道（`skipAgentDispatch: true`，不重复触发 @Agent）；
    成功落 `⚡ <skill名>` agent 型消息（`senderIcon='⚡'`、`agentName`、`model` 字段回显实际所用模型）；
    失败落 system 型消息行（`⚡ 技能「x」调用失败：<reason>`）——失败原因全频道可见、可回查。
  - 成功响应：`{ ok: true, reply, model, skill: { name, version }, message: <斜杠原文>, replyMessage: <⚡应答> }`。

## 3. 工具面（dsh ToolRuntime / REST 工具桥 / POST /mcp 三端同契约）

| 工具 | 权限点 | 参数 | 语义 |
|---|---|---|---|
| `panel_agent_invoke` | `panel.write` | `dept, agent, message, context_note?` | askAgent 同步应答；**不落频道消息**（留痕由调用方配合 `panel_msg_send`） |
| `panel_skill_invoke` | `panel.write` | `skill, message, context_note?` | invokeSkill 同步应答；不落频道 |

失败同为 `ok:false + reason`；`contextNote` 拼入系统提示（additive 位置）。

## 4. 模型取向（冻结）

- askAgent：`modelOverride` 优先 → 否则跟随 Agent 资产 `model` 属性 → 缺失即 `ok:false`（不猜模型）。
- invokeSkill：`modelOverride` 优先 → 否则自动取目录**首个「在线且已配 endpoint」的模型**
  （无 endpoint 的模型调用必失败，不参与自动选择）→ 目录为空才诚实拒绝。
- 上下文：askAgent 组装 资产 systemPrompt + 部门场景图谱摘要 + `contextNote`；
  invokeSkill 组装 技能当前版本指令内容（published 版本的 SKILL.md）+ `contextNote`。均单轮调用模型网关。

## 5. 计量口径

- askAgent：`resource = panel:<dept>.<行业code>`（D1 键格式，与 invokeAgent 一致），meter `calls`。
- invokeSkill：`resource = skill:<技能资产ID>`，meter `calls`。
- 幂等键：`panel:ask:<dept>:<agentName>:<newId>` / `panel:skill:<技能ID>:<newId>`（每次直调独立入账）。
- org 归口缺省（调用方无 userId 或查无组织）时跳过计量；计量失败不阻塞应答（协作面优先）。

## 6. 与定制侧实现的差异登记（定制侧对表项）

- **计量资源键**：定制侧 invokeSkill 用 `skill:<slug>`；main 冻结为 **`skill:<ID>`**（v1.5 惯例：
  中文 slug 含非 ASCII 过不了 usage resource 校验 `^[a-z]+:[A-Za-z0-9._-]+$`）。wire 契约不变，
  仅计量入账键不同——定制侧应改为 `skill:<ID>`（发布说明 2026-09-11 通知项）。
- 失败落频道的 senderName：定制侧 `01门`（其独立演示态命名）；main 为 `系统`。senderName 属展示层，
  不在契约冻结面（结构性约定为 senderType=`system` + `⚡ 技能「x」调用失败：<reason>` 文本前缀）。

## 7. selftest 断言锚点

「J1 契约 v1」分节（scripts/selftest.mjs）：清单可见性过滤（all/orgs 双态 + visibility 提示）、
直调成功路径（reply/model/skill 元数据 + ⚡ 消息落库 + 斜杠原文留痕）、自动选模跳过无 endpoint 模型、
诚实降级（200+ok:false+reason + 系统行可见）、`panel_skill_invoke`/`panel_agent_invoke` 工具面正向与降级。
