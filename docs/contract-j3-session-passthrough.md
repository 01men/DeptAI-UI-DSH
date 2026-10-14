# J3 契约：会话直通（宿主桥身份链）v1（冻结稿）

> 冻结日期：2026-09-11 ｜ 所有者：宿主轨 main（ybkkasi）｜ 消费方：定制侧面板（panel-core/rq-card）、远程 dsh 面板向导、门户
> 变更纪律：本契约升版须发发布说明并双侧同步（红线 1）。
> 实现锚点：`packages/plugin-dsh-bridge/src/index.ts`（挂载半 + 身份半）、
> `packages/plugin-authn/src/entry-ticket.ts`（票据服务）、`packages/plugin-console/src/index.ts`
> `POST /api/auth/entry-tickets/self`（自助票）；设计依据 docs/dev-plan-agent-host-unification.md、docs/entry-switching.md。

## 1. 身份链全貌（冻结）

```text
钉钉扫码/账密登录（宿主控制台或授权页）
  → 签发入场票据 entry_ticket（一次性、短 TTL）
  → GET /auth/entry?ticket=…（或 POST /dsh-bridge/redeem）
  → IdentityBindingService 绑定（rq_sid Cookie ← → 平台身份，实时校验账号 active）
  → Set-Cookie rq_sid（HttpOnly; SameSite=Lax; Path=/; Max-Age=bindTtl 24h）
  → 302 回原目的地（同源 next / 跨源 next 白名单，见 J2 §3）
  → 面板/控制台免登直达；POST /dsh-bridge/bind-session 把 dsh 会话关联绑定身份（工具出站归因）
```

- **两端会话不互踢**：面板/控制台的平台会话（Bearer 令牌）与 rq_sid 浏览器绑定相互独立，
  兑换平台会话不吊销 Cookie，Cookie 过期不影响已签发令牌。
- **宿主会话直通**：Cookie 绑定身份可兑换平台会话（token + user + permissions），
  兑换所得令牌直通面板 RBAC 面（如 `/rq/api/panel/depts`）——同一 rq_sid 身份进面板与控制台均零二次登录。

## 2. 端点面（冻结）

| 端点 | 语义 | 安全语义 |
|---|---|---|
| `GET /auth/entry?ticket=` | 一次性入场票据兑换 → Set-Cookie rq_sid → 302 | 票据一次性消费（重放 400）；同源收紧（跨站 Origin 403，对齐 dsh fence） |
| `POST /dsh-bridge/redeem` | `{ticket}` 兑换（引导脚本承接 `#entry_ticket` fragment） | 同上 |
| `GET /dsh-bridge/status` | 读 Cookie 返回绑定身份/未绑定 | 未绑定不作身份推断（`no_cookie` / `account_inactive` 等原因码诚实返回） |
| `POST /dsh-bridge/logout` | 清除绑定与 Cookie（Max-Age=0） | — |
| `POST /dsh-bridge/bind-session` | `{sessionId}` 关联 dsh 会话 → 出站归因 `X-On-Behalf-User` | 未绑定回落 `current`（最近绑定，单操作者姿态；多用户并发归因是已知限制） |
| `POST /api/auth/entry-tickets/self` | 已登录用户自助签发 `self` 票（远程登录回跳闭环 G1） | TTL 硬上限 120s；跨源 next 白名单（J2 §3） |
| `GET /auth/oidc/start` → `/auth/oidc/callback` | Agent 关联 OIDC 客户端授权码通道 | state 防 CSRF（坏 state 400） |

## 3. 票据与绑定 TTL（冻结缺省值）

- entry_ticket：一次性消费；签发 TTL 按refType 配置，`self` 票硬上限 **120s**。
- rq_sid 绑定：**24h**（`bindTtlSeconds` 可配）；兑换/读取双点实时校验账号状态——
  冻结/停用账号绑定**即时失效**（原因码 `account_inactive`）。
- Cookie 属性：`HttpOnly; SameSite=Lax; Path=/`（部署面以 HTTP 为主，未置 `Secure`——
  升级 HTTPS 部署时须在网关终结 TLS 并评估补 `Secure`）。

## 4. 工具出站归因（身份只走请求头，P0-2 红线）

- 会话绑定优先、未绑定回落最近绑定；`X-On-Behalf-User` 由平台注入（优先钉钉 userId），
  工具参数不承载身份（`exec.principal` fail-closed）。

## 5. selftest 断言锚点

「dsh 宿主挂载」分节：票据兑换/Cookie 绑定/status 原因码（no_cookie、account_inactive）、
票据重放 400、绑定同源收紧 403、宿主会话直通（兑换平台会话 → `/rq/api/panel/depts` 200）、
未绑定 401 fail-closed、OIDC start/callback state 校验、behavior 投递归因；
「面板」分节：`self` 票签发与跨源回跳（G1）。
