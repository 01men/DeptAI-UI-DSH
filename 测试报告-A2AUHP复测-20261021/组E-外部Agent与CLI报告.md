# 组E 分报告 · 外部 Agent 层验收与 CLI

- **实例**：`http://127.0.0.1:7345`（数据 `data-qa-gE-20261021`，stub `7445`）
- **判定**：**21 / 26 通过**（5 项失败同源一个根因）
- **执行脚本**：`qa-runtime-20261021/group-e.mjs` ｜ **结果**：`result-E.json` ｜ **日志**：`run-E.log`

## 一、结论

- **「只靠 Agent Card 协作」成立**：零平台 SDK 的外部客户端完成 发现 → 派活 → 流式 → 取消，签名可独立验签、篡改即失效。
- **但外部凭证的「派活之后」全部断裂**：同一凭证无法 `tasks/get`、`tasks/list` 为空、SSE 403、无法取消自己的任务 —— 本轮唯一 **P1-01**。
- **CLI 已补齐**：`a2a`/`uhp` 8 个子命令全部可用，上一轮 6 条遗留缺陷**全部修复**。

## 二、零 SDK 外部客户端全链路

用 `fetch` + Agent Card + 机器凭证，不 import 任何平台模块：

| 环节 | 断言 | 结果 |
|---|---|---|
| 发现 | 只读 well-known 获得卡片（name/skills/url/eventsUrl/scopes） | ✅ |
| 派活 | `message/send` → Task completed | ✅ |
| 流式 | `message/stream` → JSON-RPC Task（同构） | ✅ |
| 取消 | `tasks/cancel` 自己发起的任务 | ✅（成功路径） |
| 轮询 | `tasks/get` 读回自己的任务 | ❌ **-32003** |
| 列举 | `tasks/list` 含自己的任务 | ❌ **0 条** |
| 事件 | 按卡片 `eventsUrl` 建立 SSE | ❌ **403** |

### P1-01：外部凭证闭环断裂

```
refType=external 凭证
  ├─ message/send → 200，任务创建成功（completed / auth_required）
  └─ tasks/get   → -32003「无权查看该任务（超出你的组织可见范围）」
     tasks/list  → []
     tasks/cancel→ -32003
     SSE         → 403
```

**根因**（`packages/plugin-a2a/src/index.ts:1005-1014`）：

```ts
private canSeeOrg(caller, targetAgentId): boolean {
  if (caller.permissions.includes('*')) return true
  let orgId = caller.userId ? iam.users().get(caller.userId)?.orgId : undefined
  if (!orgId && caller.kind === 'machine' && caller.refType === 'agent' && caller.refId) {
    orgId = resourceCore.collection('agent').get(caller.refId)?.orgId
  }
  if (!orgId) return false          // ← refType=external 落到这里
  ...
}
```

`getTask()` 先调 `canSeeOrg()`（`:1000-1003`），**组织判定失败即抛 403**，后面的归属判定 `task.callerPrincipalId !== caller.principalId` 永远不可达。

**影响**：内部 `refType=agent` 凭证不受影响（实测 `tasks/get` PASS）；受影响的是**所有第三方集成**——这正是 A2A 规范的核心场景。

**确定性复现**：`qa-runtime-20261021/repro/external-no-org.mjs`

```json
{ "principalKind": "external",
  "dispatch": { "ok": true, "state": "auth_required" },
  "tasksGet": { "code": -32003, "message": "无权查看该任务（超出你的组织可见范围）" },
  "tasksListCount": 0,
  "verdict": "FAIL（无法读取自己发起的任务；外部集成闭环断裂）" }
```

**建议修复**：`canSeeOrg` 最前面加归属短路：

```ts
if (task.callerPrincipalId === caller.principalId) return true
```

或为 external 凭证登记显式组织归属（产品需确认 external 是否应属平台根组织子树）。同时补 selftest 护栏（当前 selftest 的协作链用例全部使用 `refType=agent`）。

## 三、签名与凭证

| 断言 | 结果 | 说明 |
|---|---|---|
| 卡片 JWS 独立验签 | ✅ | `node:crypto` 复验 Ed25519 |
| 篡改 body 后验签失败 | ✅ | 签名覆盖完整 |
| 凭证轮换：clientId 不变 | ✅ | `/api/authn/principals/:id/rotate-secret` |
| 凭证轮换：旧 secret 立即失效 | ✅ | 旧 secret 换令牌失败 |
| 凭证轮换：新 secret 可用 | ✅ | — |

## 四、OBO 端到端

| 断言 | 结果 |
|---|---|
| OBO 令牌签发 + act 链（human） | ✅ |
| 人类经 OBO 发起协作成功 | ✅ |
| 任务落 `onBehalfUser` | ✅ |
| 审计可追真实发起人 | ✅ |

> 首轮失败是夹具缺 `trialGroups` 导致上线失败，补全后全通。

## 五、CLI 回归

### 5.1 a2a / uhp 子命令（8/8 可用）

| 命令 | 结果 |
|---|---|
| `a2a directory` | ✅ |
| `a2a tasks` | ✅ |
| `a2a fulfillment` | ✅ |
| `a2a rules` | ✅ |
| `a2a patrol` | ✅ |
| `uhp discover` | ✅（含 `uhp_version=2026-08-11`） |
| `uhp harnesses` | ✅ |
| `uhp responses` | ✅ |

> 上一轮 Q-33：「`--help | grep -ci 'a2a|uhp'` → 0」，本轮帮助已覆盖，且命令实测可用（`DSHCTL_URL` 指向隔离实例）。

### 5.2 上一轮 6 条遗留缺陷（全部修复）

| 遗留缺陷 | 本轮结果 |
|---|---|
| `agent topology` 未知动作 | ✅ 无「未知动作」 |
| `mcp get <id>` 括号错位 TypeError | ✅ 无 TypeError |
| `group list` 未知资源 | ✅ 无「未知资源」 |
| 全局选项只能后置 | ✅ `--token` 前置可用 |
| `approval decide` 缺 `confirmed:true` | ✅ 已补 |
| `mcp invoke` denied 仍 exit=0 | ✅ **非零退出** |

## 六、本组发现的缺陷

| 编号 | 级别 | 缺陷 |
|---|---|---|
| P1-01 | **P1** | 外部 `refType=external` 凭证派活后无法读取/列举/取消/订阅自己的任务（5 项断言同源） |

## 七、Agent 层判断

- **协议契约「只靠卡片」的设计目标基本达成**：卡片信息量足够（endpoint/eventsUrl/scopes/协议扩展/计量双主体），签名可独立验证。
- **但「外部主体」这个角色在 A2A 里没有完整生命周期**：能创建任务，不能观察任务。这与「跨组织/跨运行时协作」的产品定位直接冲突，必须在上线前修。
- CLI 侧本轮质量明显提升（8/8 命令可用 + 6/6 遗留修复），可作为运维入口。