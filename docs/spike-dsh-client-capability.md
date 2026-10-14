# Spike WP-01：dsh 宿主客户端注入能力档次判定

> 状态：已完成（静态证据，rc.7 检出 `D:\DSH\deepseek-harness`，零改动）
> 日期：2026-09-02
> 结论承接方：WP-06（元冰可能力卡片/反馈条注入插件实现）

---

## 1. 结论

**判定：档次 A。**

一句话依据：dsh 的客户端插件机制是**一等扩展点**而非 hack——`dsh.client` 包被伺服于 `/plugins/<id>/client.js` 并入 cordis 启动图，插件可通过声明式 slot 注册把 React 组件挂进**会话消息流内部**（`conversation.chat.node` 键位槽 / `tool.call.toolview` 每工具卡位槽 / `conversation.chat.assistant-actions` 每消息动作条），流式更新按节点 key 增量替换、**不重挂整行**（注入 DOM 存活），且 runtime 暴露 `ctx.conversationEvents.register(ConversationNodeDefinition)` 可订阅 `tool/call`、`tool/result` 等会话事件——四态执行卡片与 👍/👎 反馈条所需的全部机制齐备，dsh 自带的工具树渲染器与点赞插件就是用同一套公开 API 实现的。

---

## 2. 证据清单

以下路径均在 `D:\DSH\deepseek-harness\`（rc.7，只读检出）之下。

### 2.1 dsh.client 插件的伺服与加载（判据：注入通道存在）

**证据 A1 — 包扫描与伺服路由**：`packages\client\modules\src\index.ts:150-158, 241-249`

```ts
// L150-158：每个 dsh.client 包合成一条 boot 图行
function graphRow(id: string, rev: string, injectEdges: string[] | undefined, immediately: boolean): WebBootEntry {
  return {
    id,
    url: `/plugins/${id}/client.js?rev=${rev}`,   // 伺服端点
    rev,
    ...(injectEdges !== undefined ? { inject: injectEdges } : {}),
    ...(immediately ? { immediately: true } : {}),
  }
}
// L241-248：注册 /plugins 前缀路由 + 向 index.html 注入 boot manifest
ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/plugins', handler: this.serveBundle }), ...)
ctx.effect(() => ctx.webServer.tapIndex(html => injectBootManifest(html, this.composed)), ...)
```

**证据 A2 — 浏览器端执行模型（懒 CJS 工厂）**：`packages\client\modules\src\client\manifest.ts:146-163`

```ts
export interface ClientPluginHandoff {
  /** Plugin id (package name) — 必须与图行 id 一致 */
  id: string
  /** 整个 bundle 闭包工厂：接收同步 require，返回 bundle 导出。仅物化时执行一次 */
  factory: (require: (spec: string) => unknown) => Record<string, unknown>
}
```

实测构建产物（`packages\client\ui-message-feedback\lib\client.js` 头部）确认了这一形状：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-message-feedback",
  factory: (require) => { ... }
})
```

**证据 A3 — 包声明契约**：`packages\client\modules\src\index.ts:46-52, 109-142` + 实例 `packages\client\ui-message-feedback\package.json`

```jsonc
// ui-message-feedback/package.json（节选）
"dsh": {
  "client": {
    "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-api-remotes",
               "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-conversation"],
    "platform": "web"
  }
},
"exports": { "./client": { "default": "./lib/client.js" } }
```

`platform !== 'web'` 的声明被跳过（`index.ts:350`）；声明了 `dsh.client` 却没有 `./client` 导出会**在激活期响亮抛错**（`index.ts:356`）。

**证据 A4 — 客户端插件入口签名**：`packages\client\ui-message-feedback\src\client\index.ts:32-39`

```ts
/** Required services: the slot registry, the Remote namespace, and the copy. */
export const inject = ['slots', 'remote', 'remote.messageFeedback', 'locale']

export function apply(ctx: ClientContext): void { ... }
```

即：客户端 bundle 的导出形状 = `inject: string[]`（cordis 服务名）+ `apply(ctx)`，与宿主端 cordis 插件完全同构。

### 2.2 流式更新下的 DOM 存活性（判据：注入节点跨流式轮次存活）

**证据 B1 — 增量行级更新，不整树重绘**：`packages\client\ui-conversation\src\client\chat\ChatView.tsx:1-13`（文件头注释即设计声明）

```
// ChatView: the default conversation view — one stable keyed parent list over
// final business Nodes ...
// Render economics: order changes only when rows enter, leave or move. Each
// ChatNodeSeat subscribes to one Node key, so Assistant deltas and Tool
// lifecycle updates replace only their own row without remounting it.
```

**证据 B2 — 行组件按稳定 key 单独订阅**：`packages\client\ui-conversation\src\client\chat\ChatNodeSeat.tsx:19-60`

```tsx
export const ChatNodeSeat = memo(function ChatNodeSeat({ nodeKey, ... }) {
  const node = useSession(snapshot => snapshot.chat.nodes.get(nodeKey))  // 单 key 订阅
  ...
  return (
    <div className={css.flowItem}
      data-chat-anchor-key={routedNode.key}
      data-chat-flow-key={routedNode.key}
      data-chat-flow-kind={routedNode.kind}>
      {renderSlot('conversation.chat.node', routedOwner, {
        entryKey: routedNode.kind,      // 键位派发：按 Node kind 出组件
        hookContext: nodeKey,
        fallback: (<JsonBlock ... />),  // 未注册的 kind 回落 JSON 卡
      })}
    </div>
  )
})
```

结论：消息流是 React 键控列表 + 每节点选择器订阅，流式 delta 只替换本行 props、不卸载兄弟行。插件经由 slot 注册的组件是 React 树的一部分，**跨流式轮次存活**（不存在"DOM 被内重写冲掉"的问题——注入不用原生 DOM API，走 slot 正规军）。

### 2.3 会话消息流内的可用挂载位（判据：slot 名录）

**证据 C1 — 会话域 SlotMap**：`packages\client\ui-conversation\src\client\contract\slots.ts:34-229`（完整表，节选）

```ts
interface SlotMap {
  'conversation.session':              { kind: 'single'; scope: 'session' }        // 整个会话体（替换式，勿占）
  'conversation.session.header.actions': { kind: 'list'; scope: 'session'; ... }   // 会话头按钮（加法式）
  'conversation.view':                 { kind: 'list'; scope: 'session'; ... }      // 视图 Tab 环（整页级）
  'conversation.chat.node': {                                                       // ★ 消息流行渲染器，按 kind 键位
    kind: 'keyed'; scope: 'session'; owner: ChatNodeOwnerProps
    keyProps: { [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }
    hookContext: string
    inject: ChatNodeTurnDataInjected
  }
  'conversation.chat.commandview':     { kind: 'keyed'; scope: 'session'; ... }     // 斜杠命令行，按命令名键位
  'conversation.chat.turnTail':        { kind: 'chain'; scope: 'session'; ... }     // 完成 Turn 的尾链（选择器路由）
  'conversation.chat.assistant-actions': { kind: 'list'; scope: 'session';
    owner: AssistantActionOwnerProps }                                              // ★ 每条定稿 assistant 消息的动作条
  'conversation.details.tool':         { kind: 'single'; scope: 'session'; ... }    // 右栏工具详情整板
  'conversation.input.dock' | 'conversation.composer.dock'
    | 'conversation.input.left' | 'conversation.input.right': { kind: 'list'; ... } // 输入区四加法位
  'conversation.composer':             { kind: 'chain'; scope: 'session'; ... }     // 输入框接管链
  ...
}
```

**证据 C2 — 框架域 SlotMap**：`packages\client\ui-layout\src\client\index.ts:34-84` + `packages\client\runtime\src\client\slots.ts:26-43`

```ts
// ui-layout：AppFrame 占 'root'，声明四个框架槽
'root':          { kind: 'single'; ... }  // 被占，勿注册（二次注册=抢占整页）
'sidebar':       { kind: 'single'; scope: 'root'; ... }
'conversation':  { kind: 'single'; scope: 'session-maybe'; ... }
'details':       { kind: 'single'; scope: 'session'; ... }
'shell.overlay': { kind: 'list'; scope: 'root' }  // ★ 全局浮层（加法式、点击穿透）——徽标/toast/状态丸
```

**证据 C3 — 工具卡位槽（每工具名键位）**：`packages\client\ui-tool\src\client\apply.ts:22-35`

```ts
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'tool-call',                       // 占据 'tool-call' kind 的单元格
    locale: NS,
    children: {
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },  // ★ 声明每工具卡位子槽
    },
  }, ToolCallTree))
  ...
  ctx.plugin(readToolview); ctx.plugin(bashToolviewSample); ctx.plugin(fileMutationToolview) ...
  // 各 toolview 以 entryKey=工具名 注册进 'tool.call.toolview'，未注册的工具回落 GenericToolCard
}
```

### 2.4 消息级反馈（👍/👎）官方范本（判据：反馈条可行）

**证据 D1 — 反馈条注册**：`packages\client\ui-message-feedback\src\client\index.ts:60-83`

```ts
ctx.slots.inject('conversation.chat.assistant-actions', () => {
  const dispose = ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'feedback',               // list 槽加法式：与后续我们的 id 并存不冲突
    order: 10,
    locale: NS,
    inject: (sessionId): MessageFeedbackInjected => {
      const controller = controllerFor(sessionId)
      return { hooks: { feedback: controller }, ensure: ..., rate: ..., toggle: ..., ... }
    },
  }, MessageFeedbackActions)
  return () => { dispose(); /* controllers 清理 */ }
})
```

**证据 D2 — 每消息 DOM 挂载点**：`packages\client\ui-conversation\src\client\chat\TurnTailNodeView.tsx:31-34` + `slots.ts:351-354`

```tsx
// owner share：消息身份由渲染点传入（每条定稿 assistant 消息一次）
const assistantActions = messageId === undefined
  ? null
  : renderSlot('conversation.chat.assistant-actions', { messageId })
// slots.ts:351
export interface AssistantActionOwnerProps { messageId: MessageId }
```

**证据 D3 — 反馈控件本体（每消息一对按钮）**：`packages\client\ui-message-feedback\src\client\MessageFeedbackActions.tsx:22-100`（按 `messageId` 从共享控制器 `useFeedback(view => view.items.get(messageId))` 取状态，Like/Dislike + 备注）。RPC 落宿主 `messageFeedback` Remote（宿主持有 compare-and-set）。

### 2.5 工具调用生命周期订阅（判据：四态状态源）

**证据 E1 — 会话事件类型（merge 可扩展）**：`packages\core\session\src\types.ts:276-289`

```ts
'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
'tool/result': {
  turn: number; step: number
  message: ToolResultMessage
  error?: { name: string; code: string }
  meta?: JsonValue
}
```

**证据 E2 — 客户端生命周期订阅 API（Definition 状态机）**：`packages\client\runtime\src\client\contract\conversation.ts:171-228`（`ConversationNodeDefinition`：`match(event)` 识别事件 → `start`/`update` 状态机 → `publication()` 节流档位 → `buildViewNode`/`buildLocationData` 产出）；注册入口 `packages\client\runtime\src\client\index.ts:191`（`events: new ConversationEventRegistry(ctx)` → `ctx.conversationEvents`），ui-conversation 即消费者（`ui-conversation\src\client\apply.ts:53`）。

**证据 E3 — 快照侧四态素材**：`packages\client\runtime\src\client\sessions\conversation.ts:184-204, 295-310`

```ts
export interface RunningToolCall { callId: string; name: string; argsRaw: string; turn; step; time;
  callView: ToolCallView | null; subCalls: readonly ToolCallBlock[] }   // 调用中/执行中（尚无 result）
export interface ToolResultNode { kind: 'tool-result'; callId: string; ...
  content: readonly ContentBlock[]
  isError: boolean                                                      // 已完成 vs 异常
  error?: { name: string; code: string }
  meta?: unknown; ... }
export type ToolCallBlock = RunningToolCall | ToolResultNode
```

外加 Turn 级异常：`TurnErrorNode`（turn/error）与 `conversation.chat.turnTail` 链槽。四态映射：`tool/call` 已见+无 result → 调用中/执行中；`tool/result.isError=false` → 已完成；`isError=true` 或 `TurnErrorNode` → 异常阻断（审批阻断另有 user-questions/ApprovalPanel 面板）。

### 2.6 客户端→元冰可数据面的 RPC 通道（判据：反馈条数据回流）

**证据 F1 — 自定义 RPC 通道范本（ui-auth，双面插件）**：
宿主端 `packages\client\ui-auth\src\index.ts:137-140`：

```ts
scope.effect(
  () => scope.connection.rpc.handle(AUTH_RPC_CHANNEL, handler, { authority: 'loopback' }),
  'ui-auth: dingtalk auth rpc channel',
)
```

浏览器端 `packages\client\ui-auth\src\client\index.ts:41-48`：

```ts
const { rpc } = (ctx.get('connection') as unknown as ConnectionHandle)
const call: AuthCall = (endpoint, payload) =>
  rpc.call(AUTH_RPC_CHANNEL, endpoint, payload) as Promise<...>
```

**证据 F2 — 备选：webServer 自有 REST 路由**：`packages\host\webserver\src\index.ts:94-101`（`webServer.register({kind, path, handler})`，任何宿主插件可注册；RQ 的 `packages\plugin-dsh-bridge\src\index.ts:231-314` 已经用它在 `/rq` 前缀挂载数据面）。浏览器同源 `fetch('/rq/...')` 即可复用元冰可现有鉴权。

### 2.7 webserver 伺服细节

**证据 G1**：`packages\host\webserver\src\index.ts:139-145`（`tapIndex`：index.html 变换管道，client-modules 用它把 `window.__DSH_BOOT__` 作为 `<head>` 首个 script 注入，见 `modules\src\index.ts:160-175`，JSON 中 `<` 转义防脚本逃逸）。
**证据 G2**：`packages\client\modules\src\index.ts:445-456` — `/plugins/<id>/client.js` 以 `content-type: text/javascript; charset=utf-8`、`cache-control: no-cache` 伺服，带 `?rev=<sha1[0:12]>` 内容哈希缓存击穿；未构建的 bundle 响应**响亮 404**（非 SPA 回退）。

---

## 3. 可用注入面 API 清单

### 3.1 插件入口（客户端 bundle 导出面）

| 项 | 契约 |
|---|---|
| 包声明 | `package.json` → `"dsh": { "client": { "platform": "web", "inject": ["<包名>", ...], "immediately": true? } }`；`exports["./client"]` 指向构建产物 |
| 产物形状 | `window.__ModuleLoader__.load({ id: <包名>, factory(require){...} })` 闭包工厂；用 `packages/client/tsdown.client.ts` 预设构建 |
| 外部依赖白名单 | 平台模块表：`react`, `react/jsx-runtime`, `react-dom(/client)`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-web-react`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-attachment`, `@deepseek-ai/dsh-client-schema-form` + `@deepseek-ai/dsh-client-runtime/client`（见 `packages/client/web/src/platform.ts`、`tsdown.client.ts`）。其余 `@deepseek-ai/*` 包**只能 type-only import**（跨插件值导入是构建错误） |
| 入口导出 | `export const inject = ['slots', 'connection', 'locale', ...]`；`export function apply(ctx: ClientContext)` |
| CSS | `import css from 'x.module.css'` → lightningcss 编译，工厂执行时自动注入 `<style data-plugin="<id>">`，卸载时由 loader 移除 |
| 生命周期 | 插件卸载 = cordis fiber 卸载：`ctx.effect` 收尾、slot 注册级联、store 实例回收，全部自动 |

### 3.2 slot 名录（与 WP-06 相关的加法式挂载位）

| slot 名 | kind / scope | 用途 |
|---|---|---|
| `tool.call.toolview` | keyed(工具名) / session | **每工具执行卡片**（四态卡主战场；owner 提供 `callId/toolName/block/openFile/cwd/inspect`） |
| `conversation.chat.assistant-actions` | list / session | **每定稿 assistant 消息动作条**（👍/👎 反馈条；owner 提供 `messageId`） |
| `conversation.chat.turnTail` | chain / session | Turn 收尾业务扩展（选择器路由，可渲染追加卡片） |
| `conversation.chat.node` | keyed(Node kind) / session | 消息流行渲染器（`tool-call` 已被 ui-tool 占；**勿抢**，用上面的子槽） |
| `shell.overlay` | list / root | 全局浮层（元冰可全局状态丸/徽标） |
| `conversation.input.dock` / `conversation.composer.dock` / `conversation.input.left|right` | list / session | 输入区加法位 |
| `conversation.view` | list / session | 整个视图 Tab（如"元冰可资源"页） |
| `conversation.session.header.actions` / `.utilities` | list / session | 会话头按钮 |
| `settings.section` | list | 设置页分区（ui-auth 即注册于此） |
| `conversation.details.tool` | single / session | 右栏工具详情整板（已被占，替换式） |

注册 API：`ctx.slots.inject(<目标槽名>, () => ctx.slots.register({ name, id|key, order|priority, locale, inject: (sessionId) => ({...业务面, hooks: {...}}) }, Component))`；声明子槽用 `children` 表。探测/订阅：`ctx.slots.specDynamic(name)`、`ctx.slots.subscribe(name, fn)`、`ctx.slots.snapshot()`、`ctx.slots.onEntryError(fn)`（插件卡崩溃会被边界隔离并让位，不炸聊天区）。

### 3.3 RPC / 事件订阅

| 通道 | API | 说明 |
|---|---|---|
| 自定义 RPC（推荐给"原生感"通道） | 宿主：`ctx.inject(['connection'], scope => scope.connection.rpc.handle('/<channel>', handler, { authority: 'loopback' }))`；浏览器：`ctx.get('connection').rpc.call('/<channel>', endpoint, payload)` | ui-auth 范本；authority:'loopback' 走可信请求校验 |
| 同源 REST | 浏览器 `fetch('/rq/...')` | 复用 plugin-dsh-bridge 已挂的元冰可数据面与现有鉴权，零新增宿主面 |
| 会话事件（工具生命周期） | `ctx.conversationEvents.register({ kind, match(event){...}, start, update, publication?, buildViewNode?, buildLocationData? })` | `match` 里识别 `tool/call`/`tool/result`（`SessionEventMap` 为 merge 可扩展，元冰可宿主插件甚至可 `Session.append` 自定义事件类型并为其注册渲染 Definition） |
| 会话快照 | slot 组件标准具 `useSession(snapshot => ...)` | `snapshot.chat.nodes`（ToolCallBlock 四态）、`snapshot.chat.locations.getTurn(turn)` |
| 连接事件 | `ctx.on('connection/reset', ...)` | 重连后控制器 resync（feedback 范本同款） |

---

## 4. 对 WP-06 的实现建议（按档次 A 的注入插件骨架）

### 4.1 文件清单（新增一个双面插件包，不动 dsh 源码，diff=0 保持）

```
D:\DSH-RQ\packages\plugin-rq-card\
  package.json               # 双面声明（见 4.2）
  tsdown.config.ts           # 复用 dsh 的 tsdown.client.ts 预设（以相对路径引 dsh 检出内预设，或复制等价配置）
  src\index.ts               # 宿主半：apply(ctx) —— 注册 RPC 通道/REST（若走 connection.rpc）
  src\wire.ts                # 通道常量与载荷类型（浏览器安全、零 Node 内建）
  src\client\index.ts        # 浏览器半：apply(ctx) —— 注册 slot
  src\client\ExecutionCard.tsx    # tool.call.toolview 键位条目：RQ 工具四态执行卡
  src\client\RqFeedback.tsx       # conversation.chat.assistant-actions 条目：👍/👎 + 备注
  src\client\controller.ts        # 每 Session 控制器（参照 ui-message-feedback/MessageFeedbackController）
  src\client\locales.ts           # zh/en 词典 + LocaleNamespaceMap merge
  src\client\slots.ts             # 注入面类型（InjectFace / PropsRuntime 组合）
```

`cordis.patch.yml`（或 `cordis.yml`）新增一个 loader 条目：`id: rq-card, name: '@dsh-ops/plugin-rq-card'`。

### 4.2 package.json 关键声明

```jsonc
{
  "name": "@dsh-ops/plugin-rq-card",
  "exports": {
    ".": "./lib/index.js",
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": { "client": { "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-conversation"] } }
}
```

**加载路径要点（侦察确认的关键约束）**：client-modules 用 `createRequire(ctx.baseUrl).resolve('<条目名>/package.json')` 解析包元数据（`modules\src\index.ts:209-213`）——**loader 条目名必须是 node_modules 可解析的包名**。RQ 现有 cordis.yml 条目全部是源码文件路径（`<PROJECT_ROOT>/packages/plugin-*/src/index.ts`），这类名字会被负判为"非 client 包"且**永久缓存**。因此新条目必须写包名 `@dsh-ops/plugin-rq-card`（已确认 `D:\DSH-RQ\node_modules\@dsh-ops\*` workspace 链接存在），不能用文件路径。

### 4.3 关键伪代码

```ts
// src/client/index.ts —— 浏览器半
export const inject = ['slots', 'locale']        // 若走 connection.rpc 再加 'connection'
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'rq-card: dictionaries')

  // ① 四态执行卡：为元冰可工具名注册 toolview（未列名的元冰可工具自动回落 GenericToolCard）
  for (const tool of RQ_TOOL_NAMES) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key: tool, locale: NS,
      inject: (sessionId) => ({ /* rpc 调用面 */ }),
    }, ExecutionCard))
  }

  // ② 反馈条：assistant-actions 是 list 槽，id 与 dsh 自带 'feedback' 并存
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'rq-feedback', order: 20, locale: NS,
    inject: (sessionId) => ({ hooks: { rqfb: controllerFor(sessionId) },
                              rate: (mid, score, note) => ctrl.rate(mid, score, note) }),
  }, RqFeedback))
}

// src/client/ExecutionCard.tsx —— 四态派生（与 ui-tool 的 read-row/bash-sample 同构）
export function ExecutionCard({ block, toolName, ... }: ToolCallViewProps) {
  // block: ToolCallBlock —— 运行中无 'kind'；定稿 kind:'tool-result'
  const state = !('kind' in block) ? (/* 调用中/执行中 */ 'running')
    : block.isError ? 'blocked' : 'done'
  // running 态显示 spinner + argsRaw 预览；done 渲染 result 内容/外链；blocked 渲染 error{name,code}
  // 结果卡外链指向 /rq 控制台对应资源页（同源，带既有登录态）
}
```

数据回流二选一（建议先 ②）：
1. 原生通道：宿主半 `connection.rpc.handle('/rq-card', handler, { authority: 'loopback' })`，浏览器半 `rpc.call`；
2. 同源 REST：浏览器直接 `fetch('/rq/api/...', { method:'POST' })` 打到 plugin-dsh-bridge 已注册的路由，复用元冰可鉴权与审计，宿主半可以只是占位。

### 4.4 构建门禁（必须）

激活期对缺失 bundle 是**响亮抛错**（`MissingClientBundleError` → `ClientPackageCompositionError`，会让宿主启动失败，见 `modules\src\index.ts:64-100, 235-239`）。因此：`pnpm dsh web` 之前必须保证 `packages/plugin-rq-card/lib/client.js` 已构建；在 RQ 的启动脚本/selftest 里加"client bundle 存在性检查"。

---

## 5. 降级预案确认（上游升级探测失败 → 自动降级纯文本）

1. **声明依赖全部走 `ctx.slots.inject`**：目标槽未声明时回调永不执行、注入保持惰性（`runtime\src\client\slots.ts:143-205` 的声明纪元机制）——上游改名/删槽 = 卡片静默消失，不会崩宿主。
2. **显式探测**：apply() 内用 `ctx.slots.specDynamic('tool.call.toolview' | 'conversation.chat.assistant-actions')` 做存在性检查；`slots.inject` 回调执行时再校验 spec.kind === 'keyed'/'list'。任一不满足 → 置降级标志。
3. **boot 面探测**：`window.__DSH_BOOT__` 缺失或 `/plugins/@dsh-ops/plugin-rq-card/client.js` 404 → 视为机制不存在。
4. **apply() 全体 try/catch**：任何抛错吞掉并降级；slot 边界本身还有 `reportEntryError` 让位机制（`ui-slots\src\index.ts:1098-1106`），单卡崩溃只让出单元格、不拖垮聊天区——双保险。
5. **降级态 = 纯文本+链接（天然兜底）**：元冰可工具的 `tool/result` 文本内容里**始终**携带纯 markdown 摘要 + `/rq` 控制台链接（这是工具侧输出，不依赖任何客户端插件）；客户端卡片只是把同一信息升级为富卡。上游升级导致注入失效时，用户体验自动回落为 markdown 文本，无需发版。
6. 降级标志可经 `shell.overlay`（若该槽仍在）挂一枚"卡片插件未生效"角标，便于运维发现。

---

## 6. 风险与未知项

| # | 风险/未知 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 激活期缺 bundle 会让**整个宿主启动失败**（响亮抛错，非 warn） | 高 | 4.4 构建门禁；bundle 产物纳入版本管理或 CI 强制预构建 |
| R2 | slot 名/契约无版本化线协议，上游升级可能改名（静态强类型 + 字符串运行时键） | 中 | 第 5 节探测+降级；升级回归时跑 `ctx.slots.snapshot()` 比对槽树 |
| R3 | `conversation.chat.assistant-actions` 只渲染在 Turn 收尾行（closing assistant 消息），粒度是"每 Turn 收尾消息"而非字面每条消息 | 低 | 对 👍/👎 反馈条语义足够（与 dsh 自带 feedback 一致） |
| R4 | 客户端 bundle 与 React 18 / 平台模块表强耦合；不得自带 react 或 import 其他插件包的值 | 中 | 严格用 tsdown.client.ts 预设与外部白名单；type-only import 规矩照 ui-message-feedback |
| R5 | `immediately` 未标记时 bundle 走懒加载，但所有 boot 图条目最终都会被 Loader 激活——顺序由 `inject` 边保证；错列 inject 边可能导致 `ctx.slots` 未就绪 | 中 | inject 边照抄 ui-message-feedback（runtime + ui-conversation） |
| R6 | `authority: 'loopback'` 的可信请求判定（`connection\src\rpc-host.ts:82`）细节未深挖；若 dsh web 被反代/远端访问，RPC 通道可能拒绝 | 低-中 | 优先选同源 REST `/rq`（复用元冰可自身鉴权），原生通道作为增强 |
| R7 | `/plugins/<id>/client.js` 无鉴权（同源静态伺服 + no-cache）；插件代码对页面同源可见 | 低 | bundle 只含非敏感 UI 逻辑；密钥类数据留在宿主半（ui-auth 范本：secret 永不进浏览器） |
| R8 | 未做起服实测（`pnpm dsh web` + curl boot manifest）；结论全部来自 rc.7 静态证据 + 已构建产物（lib/client.js）佐证 | - | WP-06 首个联调里程碑先做"空插件上链"冒烟：声明包 → 观察 `window.__DSH_BOOT__` 含该行 → apply 打日志 |
| R9 | HMR 面（`/plugins/events` SSE）仅开发态存在（`modules\src\index.ts:428-431` 注释）；生产路径不依赖 | 低 | 生产不用 HMR 通道 |

---

## 附：本次侦察未修改任何文件

- `D:\DSH\deepseek-harness`（dsh 检出）：零改动，diff=0 不变量保持。
- 本文档为唯一新增产物，位于 `D:\DSH-RQ\docs\`。
