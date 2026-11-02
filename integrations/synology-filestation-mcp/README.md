# synology-filestation-mcp 数据权限改造件（仅产出代码，未部署）

对应开发计划 `dev-plan-nas-authz v1.1` §2.4（强制点①：网关鉴权钩子）与 §三 步骤 0/6。
本目录只交付代码与测试，**不改动已部署网关**；联调窗口由运维按下方步骤灰度上线。

## 交付物

| 文件 | 说明 |
|---|---|
| `src/authz.js` | `AuthzClient`（check 调用 + 读缓存 + scope 快照 + 三级降级 + 熔断）与 `opForTool` / `extractPaths` / `localScopeCheck` 纯函数 |
| `test/authz-smoke.mjs` | 进程内 stub PDP 自测，23 项断言（`node test/authz-smoke.mjs`，当前 23/23 通过；含工具面 ↔ 操作映射双向一致性断言，网关新增工具漏映射会被拦下） |

## 集成步骤（联调窗口执行）

1. **拷贝文件**：`src/authz.js` 放入网关仓库同路径；`test/authz-smoke.mjs` 放入网关 `test/`。
2. **tokens.js 字段就位**（步骤 0 令牌加固）：
   - nas-tokens.json 条目新增 `enforce: boolean`（缺省 false = 观察直通）与 `allowedOnBehalf: boolean`（仅 hermes/平台专用令牌为 true）。
   - 可选 `boundUserId`：为不携带 on-behalf 头的令牌绑定固定身份。
3. **http.js 两处挂钩**：
   - 模块顶部：`import { AuthzClient, opForTool } from './authz.js'`，并实例化 `const authz = new AuthzClient({})`（env 见下）。
   - `matchToken` 解析 `req.tokenEntry` 之后：对 `req.headers['x-on-behalf-user']` 做防伪校验
     `const identity = authz.resolveOnBehalf(req.tokenEntry, req.headers['x-on-behalf-user'])`；
     `identity.error` 则直接回 JSON-RPC error（code -32403）并计数留痕。
   - `tools/call` 分发之前（覆盖控制台/hermes/任意 MCP 客户端的全部文件操作）：
     ```js
     const verdict = await authz.evaluate({
       tool, args,
       tokenEntry: req.tokenEntry,
       onBehalfHeader: req.headers['x-on-behalf-user'],
       nasIp: req.nasIp, // 与 X-NAS-IP 设备路由头同源
     })
     if (verdict.decision === 'deny') {
       // observeOnly 判定不会到这里（平台已把观察模式 allow 原样放行）
       res.writeHead(200, { 'content-type': 'application/json' })
       res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32403, message: `数据权限拒绝：${verdict.reasons.join('；')}` } }))
       return
     }
     ```
     deny 响应透传平台 reasons（§2.4）。
4. **环境变量**：
   - `AUTHZ_ENFORCE=off` 全局 kill-switch（秒级回退，G1 逐令牌迁移时保留）；
   - `AUTHZ_DEGRADE=deny|readonly`（PDP 不可达且无快照时的策略；灰度期可配 readonly）；
   - `AUTHZ_PLATFORM_URL` / `AUTHZ_PLATFORM_TOKEN`：平台 PDP 基址与网关专用资源账号令牌（最小权限 `nas.authz.check + nas.read`）；
   - `AUTHZ_SNAPSHOT_DIR`：scope 快照落盘目录（持久卷）。
5. **灰度**：按 §五 G0（观察 3~5 天）→ G1（hermes 6 令牌逐个 `enforce=true`，每令牌 1 天）→ 控制台透传令牌。

## 防伪与降级语义（与计划对齐）

- 非授信令牌携带 `X-On-Behalf-User` → `-32403 FORGED_ON_BEHALF` 拒绝（不留情面降级为令牌身份）；
- 三级降级：scope 快照（仅快照内读、写全拒）→ `readonly`（放行读）→ `deny`（fail-closed 默认）；
- 熔断：连续 5 次 check 超时 → open，冷却后半开探测恢复，进入/恢复均计入 metrics；
- read/download 决策缓存 300s，写类与 delete 每次实判；
- 中期演进：HMAC 签名头 `X-On-Behalf-Sig` 并入机器身份 scope 模型（§六，本期不做）。
