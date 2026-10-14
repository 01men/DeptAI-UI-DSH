# T-SEC 安全/API 黑盒测试报告 —— dsh 插件化「元冰可部门工作台」

- 测试人：T-SEC（安全/API 黑盒，源码辅助定位端点，未修改任何仓库文件）
- 日期：2026-09-08
- 验收依据：`docs/qa-acceptance-dsh-plugin-first.md` 第 1、4.3、4.6、4.7 节与第 5 节边界表
- 被测环境：
  - **E2 独立宿主** `http://127.0.0.1:7300`（数据目录 `D:\DSH-RQ\data-host`，admin 初始口令未改、口令文件未删）
  - **客户端 dsh（本组专用实例 qa-api）** `http://127.0.0.1:3083`，全新未连接态起步，测试结束已恢复 `mode:none`
  - **对抗 stub** `http://127.0.0.1:7730`（既有）；CONN-10 自建对抗服务 `http://127.0.0.1:7731`（临时文件已删除）
- 真实路由（源码核对 `packages/plugin-rq-card/src/index.ts` + `hostlink.ts`）：向导端点为
  `GET /rq/rqcard/link`、`POST /rq/rqcard/link/{local,remote,reset,scan}`、`GET /rq/rqcard/local-init`、
  `POST /rq/rqcard/local-init/{admin,listen-plan}`，代理为中间件拦截 `/rqcard/proxy/*`（挂载前缀 `/rq`）。

**结论速览：清单内 11 条可执行用例全部 PASS（RBAC-06 归 T-GUI；SEC-07 浏览器半归 T-GUI、服务端半已 PASS）；清单外发现 4 项（1 项 P2 建议 + 3 项观察记录），无 5xx、无崩溃、无栈泄漏、无敏感信息泄漏。**

---

## A. 安全边界 SEC 组（对 3083 客户端 `/rq/rqcard/*`）

| 编号 | 请求 | 期望 | 实际 | 判定 |
|---|---|---|---|---|
| SEC-01 | 无 `x-rqcard-call` 头 GET `/rq/rqcard/link`（真实路径；任务书里的 host-link/status 不存在，源码定位为 `/rqcard/link`） | 403 `WIZARD_CALL_HEADER_REQUIRED` | 403 `{"ok":false,"error":{"code":"WIZARD_CALL_HEADER_REQUIRED","message":"向导端点要求 x-rqcard-call: 1 请求头（跨站防御）"}}` | **PASS** |
| SEC-01b | 无头 GET 代理 `/rq/rqcard/proxy/api/panel/depts`；头值错（`x-rqcard-call: 0`）；无头 POST `/rq/rqcard/link/scan` | 同上 | 全部 403 同错误码（防线覆盖代理中间件与全部向导路由，头值必须精确为 `1`） | **PASS** |
| SEC-02 | 带头 GET `/rq/rqcard/proxy/api/iam/users`、`/api/usage/records`、`/api/audit/logs` | 403 `PROXY_PATH_DENIED` | 均 403，如 `{"code":"PROXY_PATH_DENIED","message":"代理白名单之外的路由：/api/iam/users"}` | **PASS** |
| SEC-02 穿越变体 | 带头 `/proxy/api/panel/../iam/users`、`/proxy/api/panel/%2e%2e/iam/users`、`/proxy/api/panel/%2e%2e/%2e%2e/iam/users` | 不得绕过白名单 | 全部 403 `PROXY_PATH_DENIED`。WHATWG URL 解析先把 `..`/`%2e%2e` 规范化掉（变成 `/api/iam/users`、`/iam/users`），再被白名单拒绝；不存在「白名单前缀 + 穿越逃逸」路径 | **PASS** |
| SEC-03 | 带头 GET `/rq/rqcard/proxy/api/panel/stream`（SSE） | 403，SSE 不透传 | 403 `PROXY_PATH_DENIED`（`PROXY_DENY_EXACT` 显式拒绝），与边界表 B-3「代理不持流」契约一致 | **PASS** |
| SEC-04 | 未配置连接（`rq-host-link.json` 为 `{"mode":"none"}`）带头 GET `/proxy/api/panel/depts`、`/proxy/api/auth/me` | 409 `NOT_REMOTE` | 均 409 `{"code":"NOT_REMOTE","message":"当前不是远端连接模式（先在向导里选择并连接宿主）"}`；白名单判定先于模式判定（白名单外路径在未连接时仍回 `PROXY_PATH_DENIED`，语义不随连接状态漂移） | **PASS** |
| SEC-附加-1 | PUT/DELETE 打 `/proxy/api/panel/depts`：未连接态 → 409；已连接态（对抗 stub）→ 方法原样转发（stub 日志实证 `PUT /api/panel/depts`、`DELETE /api/panel/depts` 抵达宿主） | 受控 | 均受控（409/502 JSON 错误，无崩溃）。注记：白名单按路径不按方法，写方法由宿主侧 Bearer+权限裁决（设计模型） | **PASS（观察见 O-3）** |
| SEC-附加-2 | GET 打 POST-only 路由 `/rq/rqcard/link/remote` | 受控 | 200，回退到 dsh 控制台 SPA HTML（方法不匹配不进路由表→静态兜底）。无数据泄漏，但无 405 语义（见 O-2） | **PASS（观察 O-2）** |
| SEC-附加-3 | POST `/rq/rqcard/link/remote` 缺 Content-Type（curl -d 默认 form 编码） | 受控 | 200——form 编码体被解析且**真实连接成功**（hubBase 生效）。行为受控，但向导端点接受非 JSON 体属宽松解析（见 O-1） | **PASS（观察 O-1）** |
| SEC-附加-4 | POST `/rq/rqcard/link/remote` 2MB body | 4xx 受控、不崩不挂 | 400 `LINK_REMOTE_FAILED`「宿主不可达：http://127.0.0.1:9（健康检查无响应…）」——错误消息只含规范化后基址，2MB padding 不回流。服务随后 health 200 | **PASS** |
| SEC-附加-5 | 空 body / 坏 JSON `{bad json` 打 `link/remote` | 4xx 受控 | 均 400 `LINK_REMOTE_FAILED`「宿主地址不能为空」 | **PASS** |

## B. 连接规范化 CONN 组

| 编号 | 请求 | 期望 | 实际 | 判定 |
|---|---|---|---|---|
| CONN-04 | 带头 POST `/rq/rqcard/link/remote` `{"hubBase":"http://127.0.0.1:9"}` 及 `:59999` | 明确报错 + 不落盘 | 均 400 `LINK_REMOTE_FAILED`「宿主不可达：<地址>（健康检查无响应，请确认地址/端口/防火墙）」；事后 `rq-host-link.json` 仍为 `{"mode":"none"}`（未落盘） | **PASS** |
| CONN-05a | `127.0.0.1:7730`（无 scheme） | 规范化为 `http://127.0.0.1:7730` | 200，落盘 `hubBase:"http://127.0.0.1:7730"`，探活注记独立宿主 | **PASS** |
| CONN-05b | `http://127.0.0.1:7730/`（尾斜杠） | 同上 | 200，规范化一致 | **PASS** |
| CONN-05c | `http://127.0.0.1:7730/extra/path`（多余路径） | 同上 | 200，路径被剥离，规范化一致 | **PASS** |
| CONN-05d | `ftp://x` | 拒绝 | 400 拒绝且**不落盘**（连接态保持前值），但报错文案为「宿主不可达：http://ftp（健康检查无响应…）」而非「仅支持 http/https」——`normalizeHubBase` 对不匹配 `^https?://` 的输入先补 `http://` 再解析，专属 scheme 拒绝分支对 `ftp://x` 不可达（见 O-1） | **PASS（附带 P2 建议）** |
| CONN-10 | 自建对抗服务 7731：阶段1 `/api/health` 回 JSON → 连接成功落盘；阶段2 重启为所有 `/api/*` 回 200 text/html；带头打代理 | 502 `HUB_BAD_RESPONSE`，「HTML 而非 JSON」文案，不把 HTML 当数据 | GET `/proxy/api/panel/depts` → **502** `{"code":"HUB_BAD_RESPONSE","message":"宿主返回了 HTML 而非 JSON（地址或挂载前缀可能不匹配，请在向导里重新测试连接）"}`；POST `/proxy/api/auth/login` 同样 502；`/proxy/api/health` 同样 502；阶段2 后重新「测试连接」→ 400 `LINK_REMOTE_FAILED`「宿主不可达」（严格判据：探活要求 JSON 信封 `ok===true`，HTML 兜底骗不过探活）。stub 侧日志确认请求打到宿主根路径 `/api/…`（无 `/rq`） | **PASS** |

## C. 宿主侧 RBAC 组（对 7300 宿主）

前置：`POST /api/iam/roles` 创建角色 `qa_panel_reader`（权限精确为 `["console.login","panel.read"]`，取自源码权限目录的最小集）；`POST /api/iam/orgs` 创建 `QA-B组织`、`QA-C组织`；`POST /api/iam/users` 创建 qa-pb（org=B）、qa-pc（org=C）；`PUT /api/panel/rd/config` 把「研发部(rd)」绑定到 QA-B 组织。两账号分别登录均 200 拿到 token，权限载荷确认 `["console.login","panel.read"]`。

| 编号 | 请求 | 期望 | 实际 | 判定 |
|---|---|---|---|---|
| RBAC-01 | 无令牌 GET `http://127.0.0.1:7300/api/panel/depts` | 401 | 401 `{"code":"UNAUTHORIZED","message":"缺少 Bearer 令牌，请先登录"}` | **PASS** |
| RBAC-02 | qa-pb（仅 panel.read）写操作：POST `/api/panel/rd/channels`、PUT `/api/panel/rd/config`、POST `/api/panel/rd/tasks`、GET `/api/iam/users` | 403 + 明确错误，不崩 | 均 403 `FORBIDDEN`，逐点报缺：`panel.write` / `panel.config.write` / `panel.task.write` / `iam.user.read`（响应体带 `permission` 字段）；服务事后 health 200 | **PASS** |
| RBAC-03 | qa-pb（绑定组织成员）GET `/api/panel/depts`：rd `allowed=true`，其余未绑定部门 `allowed=true`；qa-pc（非绑定组织）：rd **`allowed=false`**，直连 `GET /api/panel/rd/overview`、`/api/panel/rd/messages` → 403 `{"message":"部门范围受限：研发部 已绑定组织治理，仅该组织子树成员可访问","permission":"panel.read","deptScope":"org_…"}`；qa-pc 读未绑定部门 mfg → 200（范围外不受影响）；qa-pc 直连 rd 概览 403 与部门列表 `allowed=false` 一致 | **PASS** |
| RBAC-06 | 浏览器网络面板抽查代理请求头（仅 `authorization`/`x-rqcard-call`、不携带 Cookie） | —— | **跳过，归 T-GUI**（需面板前端运行）。源码侧佐证：`hostlink.ts` proxy 只透传 `authorization` 头（不带 Cookie）且 `redirect:'manual'` | **BLOCKED→T-GUI** |

## D. 一次性口令与票据

| 编号 | 步骤 | 期望 | 实际 | 判定 |
|---|---|---|---|---|
| SEC-05（E2 宿主） | `D:\DSH-RQ\data-host\admin-initial-password.txt` 在场（151 字节）；用初始口令 POST `/api/auth/login` 成功一次（本报告 RBAC 组的 admin token 即由此登录，**未改密、未删文件**） | 初始口令可登录 | 200 + token/refreshToken。注记：直接登录不消费初始口令；只有向导 `local-init/admin` 流程才改密+删文件（源码 `localInitAdmin`） | **PASS** |
| SEC-05（重放，在 T-SEC 自有 3083 profile 上安全实证） | ① `POST /rq/rqcard/local-init/admin` 首次初始化 → 200+token，口令文件被删；② 手工还原口令文件后再次 init → 400 `LOCAL_INIT_FAILED`「用户名或密码错误」（初始口令已因改密失效）；③ 旧初始口令 `/rq/api/auth/login` → 401 `LOGIN_FAILED`；④ 新口令登录 → 200 | 初始化不可重放建立会话 | 与期望逐条一致 | **PASS** |
| SEC-06 | 兑换端点 `POST /api/authn/entry-tickets/redeem {ticket}`（公开路由）。API 可构造有效票据（无需 GUI）：admin 创建 agent → `POST /api/agents/:id/entry-ticket` 签发（TTL 120s）→ 兑换#1 → 兑换#2 重放 | 第二次 400 `ENTRY_TICKET_INVALID` | 兑换#1 200（返回 refType/refId/identity）；**兑换#2 400 `ENTRY_TICKET_INVALID`「入场票据已被使用（一次性，防重放）」**；已消费票据打 `POST /api/auth/entry-ticket-session` 同样 400；伪造票据 400「入场票据无效」 | **PASS** |
| SEC-07 服务端半 | 7300 签发新票据 → 3083 连接 7300 后经 `/rq/rqcard/proxy/api/authn/entry-tickets/redeem` 兑换 | 经代理同样一次性 | #1 200 identity；#2 重放 400 `ENTRY_TICKET_INVALID`（代理白名单含该兑换路径） | **PASS** |
| SEC-07 浏览器半 | `?entry_ticket=` / `#entry_ticket=` 打开面板，地址栏即清、刷新不重复兑换 | 兑换后地址栏清除 | **跳过（需浏览器），归 T-GUI**。源码契约（`packages/plugin-panel-core/public/js/boot.js`）：`takeEntryTicket()` 同时收 query 与 fragment 两形态 → 兑换后 `clearEntryTicket()` 用 `history.replaceState` 清除（query 形态仅删票据参数、fragment 形态整段移除）；刷新后服务端已消费 → 400，不重复建立会话 | **BLOCKED→T-GUI** |

---

## 清单外发现

| # | 级别 | 发现 | 证据/建议 |
|---|---|---|---|
| O-1 | **P2 建议** | 非 http/https scheme 的拒绝文案误导：`normalizeHubBase`（`packages/plugin-rq-card/src/hostlink.ts`）对不匹配 `^https?://` 的输入先补 `http://` 前缀再解析，导致 `ftp://x` 被规范化为 `http://ftp` 并报「宿主不可达：http://ftp」，代码里「宿主地址仅支持 http/https」专属拒绝分支对这类输入不可达。CONN-05d 仍判 PASS（拒绝且不落盘），建议把 scheme 校验提前到补前缀之前。 | 见 CONN-05d 实测 |
| O-2 | 观察 | 向导路由对错误 HTTP 方法无 405 语义：GET 打 POST-only 的 `/rq/rqcard/link/remote` 回退到 SPA HTML（200）。无数据泄漏、无危害；如需更严谨可在中间件对 `/rqcard/*` 方法不匹配回 405。 | 见 SEC-附加-2 |
| O-3 | 观察 | 代理白名单按路径不按方法：PUT/DELETE 在白名单路径上会原样转发到宿主（stub 日志实证）。鉴权与写权限由宿主按 Bearer 裁决（RBAC 组已验证宿主逐点拒写），属设计模型；记录备查。 | 见 SEC-附加-1 |
| O-4 | 观察 | 向导端点接受非 JSON 请求体（form 编码/缺 Content-Type 均按表单解析成功）。同源场景无害（防线是 `x-rqcard-call` 自定义头而非 Content-Type），记录备查。 | 见 SEC-附加-3 |

**未发现**：5xx、进程崩溃、挂起、异常栈回传（500 兜底文案为通用「服务器内部错误」，源码亦确认详情只入服务日志）、错误消息中的内码/路径泄漏（大 body 测试的错误消息仅含规范化基址）。

---

## 测试遗留物与账号清单（交付回执）

**在 E2 宿主 7300 上创建（均为测试目的，命名带 qa 前缀）：**

| 对象 | 标识 | 说明 |
|---|---|---|
| 角色 | `qa_panel_reader`（id `rol_mtsmbseuidqr55aa`，名 QA-面板只读） | 权限 `["console.login","panel.read"]` |
| 组织 | `QA-B组织` id `org_mtsmbsh9idqt1jza`、`QA-C组织` id `org_mtsmbskeidqv0asg`（父组织=元冰可集团） | 组织受限场景用 |
| 用户 | **qa-pb** / `Qa-Pb-12345678`（P-B 人设，org=B）；**qa-pc** / `Qa-Pc-12345678`（P-C 人设，org=C） | 均为 active |
| Agent | `qa-sec-agent` id `agt_mtsmfbrkidre0gsa` | SEC-06 票据签发目标 |
| 部门绑定 | 部门 `rd`（研发部）→ 组织 `org_mtsmbsh9idqt1jza` | **保留在场**（供 RBAC-03 复测/T-GUI 走查）；如需还原：admin `PUT /api/panel/rd/config {"orgId":null}` |

**未动/未改**：E2 宿主 admin 初始口令与口令文件（原样在场）；E1 (3080) 一切连接态；上游 GitHub 零请求。3083 自有 profile 已恢复 `mode:none`（其本地 admin 口令在 SEC-05 重放实证中已被初始化为 `Qa-LocalInit-97531`，初始口令文件按测试设计已消费——该 profile 属 T-SEC 专用实例，不影响他人）。临时文件 `tmp-conn10.mjs` 已删除；测试过程日志 `qa-api-client-3083.log` 保留在本目录。

**统计**：清单内可执行用例 11/11 PASS（RBAC-01、RBAC-02、RBAC-03、SEC-01~05、SEC-06、CONN-04、CONN-05、CONN-10 及 SEC/SEC-附加扩展项）；2 项移交 T-GUI（RBAC-06、SEC-07 浏览器半）；P0=0，P1=0，P2 建议 1 条（O-1）。
