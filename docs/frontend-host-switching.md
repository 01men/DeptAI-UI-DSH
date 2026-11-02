# 前端宿主服务连接切换——手动配置 / 一键切换 / 切换自动刷新（2026-09-07）

> 回答一个问题：**控制台前端如何从「只能连本机宿主」变为「可配置、可切换多个宿主服务」？**
> 例：默认连本机宿主；要把控制台指到另一台宿主 `http://192.168.0.7:7300/`，手动配置一次，
> 之后在连接清单里一键切换，切换后页面自动刷新生效。
> 关联：`docs/internal/dev-plan-agent-host-unification.md`（单进程单入口）、`docs/entry-switching.md`（入口分诊）。

---

## 一、方案定版

### 1.1 连接模型（前端纯函数 `js/connections.js`）

- 连接 = `{ id, name, base }`；内置**本机宿主服务**（`id=local`，不可删）= 同源部署前缀（'' 或 `/rq`）。
- 远程连接的 `base` 为**完整地址**：独立形态 `http://192.168.0.7:7300`；对方也是挂载形态则含前缀
  `http://host:8801/rq`。清单与活动连接存 localStorage（`heng_ops_connections` / `heng_ops_active_connection`）。
- `BASE` 在 `api.js` 模块加载时定刻为活动连接的 base——**切换 = 写偏好 + `location.reload()`**，
  刷新后 api.js 按新连接重定 BASE，即「切换后自动页面服务刷新」。

### 1.2 会话按连接隔离（api.js）

- 令牌键带连接命名空间：本机沿用 `heng_ops_token`（向后兼容），远程连接用
  `heng_ops_token@<connId>` 三键（token/refresh/user）——**切回不丢登录**，互不串号。
- `/dsh-bridge/*` 宿主 Cookie 直通（绑定自检 + 会话交换）**仅本机连接态生效**：
  本机宿主 Cookie 换来的是本机会话，与远程数据面无关，远程态恒静默跳过。

### 1.3 数据面跨域放行（platform-core `http.ts`）

- `HttpServerConfig.corsAllowOrigins`：**默认 `['*']`**——数据面是纯 Bearer 通道，跨域请求不带
  Cookie（`/dsh-bridge/*` 注册在 dsh webServer 根上、不经本分发），放行不改变同源语义；
  传 `[]` 关闭；传来源列表则精确回显（配 `Vary: Origin`）。
- 覆盖范围只限平台 REST 数据面 `/api/*`，且**豁免自管 CORS 的子面**：门户 `/api/portal/*` 与
  OIDC 协议的 `/api/authn/oidc/*` 自行按来源精确放行、不得被放宽；`/oauth/*`、`/.well-known/*`
  不在 `/api` 内天然不受影响（selftest「OIDC Provider / 门户数据通道」两节既有断言守此边界）。
- 实现：`corsAllowOriginFor()` 纯函数 + dispatch 入口处先于鉴权中间件处理——浏览器预检
  OPTIONS 不带 Bearer，不得被 401 拦截；放行头经 `setHeader` 预挂，与 ok/fail/file 的
  writeHead 自然合并（错误体跨域同样可读）。挂载形态经 dsh-bridge 剥前缀进同一 dispatch，天然生效。

### 1.4 界面入口（`pages/connections.js`，`#/connections`）

- 连接清单（本机 + 远程）：**测活**（目标 `/api/health` 公开端点，走 api.js `probeHostBase`，
  零裸 fetch 不变量不破）、**切换**（本机/远程均可，顶栏远程指示灯常显）、编辑、删除
  （删活动连接自动回落本机并刷新；二次点击确认防误删）。
- **登录前可用**：`#/connections` 在 app.js 走会话前置分支，无会话时以独立极简形态渲染
  （登录页「宿主服务：xxx · 更换」入口直达）；有会话时在控制台外壳内渲染（NAV「平台 → 宿主服务连接」）。

## 二、已知边界（当前版本不做/受限）

1. **目标宿主版本要求**：远程宿主需为本特性之后的版本（数据面默认放行跨域）。测活失败提示
   「不可达或未放行跨域」即此因。旧版本宿主可在其 `cordis.yml` 无从配置——升级后即可。
2. **挂载形态远程宿主的 dsh fence**：对方是 dsh 宿主形态时，dsh webServer 自身的 DNS-rebinding
   fence 可能拦外来 Host/Origin——独立形态（本特性主场景）无此层；宿主形态实测为准。
3. **钉钉扫码等三方整页跳转**：授权回跳落在目标宿主自身域上（session 落在对方 origin 的
   localStorage）。账号密码登录不受影响，全程留在当前页面所在域。
4. **部门面板（panel SPA）未含连接切换**：控制台切到远程后，`${BASE}/panel/` 自然指向远程面板；
   面板自身的多宿主切换留待后续（server CORS 已就绪）。

## 三、测试位置（机器可验）

- `tests/selftest.mjs` 节「宿主服务连接切换」：CORS 决议纯函数 6 断言 + 数据面端到端
  （预检 204/公开端点/401 错误体/Bearer 主链路/无 Origin 不劫持）+ `connections.test.mjs`
  随包单测 + api.js/app.js 接线 grep 不变量。
- `packages/plugin-console/public/js/connections.test.mjs`：地址规范化/清单增改删/活动连接
  决议（默认本机→切远程→悬空回落）/删除回落标记，7 组。
- 既有不变量保持：console 前端零裸 fetch（测活收敛在 api.js）；RBAC 矩阵不受影响
  （CORS 是响应头语义，不新增端点）。

---

## 四、2026-10-22 扩展：宿主 × 部门 = 面板登记（面板入口不再硬编码）

「部门面板」从 NAV 里的固定外链改为**登记清单页 `#/panels`**，登记数据在浏览器侧（`heng_ops_panels`）：

- 每条登记 = `{ 宿主 connectionId, 部门标识 dept, 名称 }`；宿主候选来自本页的连接清单（本机恒在列）。
- 跳转地址由登记项推导：本机 → `<部署前缀>/panel/?dept=<dept>`；远程 → `<宿主 base>/panel/?dept=<dept>`。
- 面板侧新增 `?dept=` 深链（优先于 `localStorage['panel_dept']` 记忆；越权/不存在静默回落，
  规则见 `plugin-panel-core/public/js/dept.js` 与 `dept.test.mjs`）。
- **删除宿主连接时其面板登记自动清理**；绕过删除产生的脏数据在清单里标「宿主已删除」并禁用进入。
- 登记面两处：本页（`#/connections`）的「部门面板」区块、`#/panels` 页本身。

因此「在宿主服务连接里登记好的面板，才支持在部门面板跳转访问」这句话现在是**代码保证**的：
入口由登记项生成，未登记不产生任何链接；`#/panels` 只是这份登记的看板与深链出口。

纯函数单测见 `connections.test.mjs`（面板登记 7 例）；回滚口径：删 `heng_ops_panels` 键即可清空登记。
