# J2 契约：统一入口分诊 v1（冻结稿）

> 冻结日期：2026-09-11 ｜ 所有者：宿主轨 main（ybkkasi）｜ 消费方：定制侧面板、门户/登录页
> 变更纪律：本契约升版须发发布说明并双侧同步（红线 1）。
> 设计全文（背景与修复清单）：[docs/entry-switching.md](entry-switching.md)；本文件冻结的是「分诊判定」可消费面。
> 实现锚点：`packages/plugin-console/public/js/landing.js`（纯函数，Node 可导入直测）；
> 消费点 `public/js/app.js boot()`（控制台启动分诊）与登录回跳（`pages/login.js`）。

## 1. 判定输入与输出

- 输入：`user = { permissions: string[] }`（会话就绪后的权限点列表，'*' 全量亦可能出现）。
- 输出：`resolveLanding(user) → 'panel' | 'console'`。

## 2. 判定规则（冻结）

1. **纯业务身份**：`isBusinessOnly(user)` —— 权限不含 `'*'`，且不含任何管理域标记权限点。
   管理域标记（`MGMT_MARKERS`，冻结）：
   `iam.user.read` · `approval.read` · `audit.read` · `usage.read`
2. **面板可达**：`canPanel(user)` —— 权限含 `'*'` 或 `panel.read`。
3. **分诊决议**：`resolveLanding = isBusinessOnly && canPanel ? 'panel' : 'console'`
   —— 平台管理员/组织管理员/资源管理员/开发者/审计员/自定义管理角色一律落控制台；其余纯业务身份落部门面板。
4. **裸落地判定**：`isBareLanding(hash)` —— 仅「无 hash / `#/` / `#/dashboard`」时分诊；
   深链刷新与页内导航不受影响（回到浏览器即恢复原地）。
5. **显式切换记偏好**：跨工作台切换入口写 `localStorage['heng_ops_landing']`（`LANDING_PREF_KEY`，冻结键名）；
   分诊尊重既有偏好（用户显式选择优先于自动判定）。

> 判据是**权限点而非角色名**：内置角色调整不影响判定；新增管理面若需纳入分诊，
> 须升版本契约把权限点加入 `MGMT_MARKERS` 并通知定制侧。

## 3. 登录回跳白名单（与分诊配套，冻结）

- **同源 next**：`sanitizeNext(raw)` —— 仅接受 `/` 开头且非 `//` 开头的绝对路径（防 open redirect）。
- **跨源 next（G1）**：`sanitizeCrossOriginNext(raw)` —— 仅接受 http(s) 且主机为
  回环（`localhost` / `::1` / `127.0.0.0/8`）或私网（`10/8`、`192.168/16`、`172.16/12`）的绝对 URL，
  且拒绝携带 userinfo；公网主机一律拒绝（返回空串，按无 next 处理，诚实降级不阻断登录）。
  用途：远程 dsh 面板向导以 `?next=<本机面板地址>` 发起宿主登录，登录完成后携带一次性
  自助 entry_ticket（J3 面）回跳本机——白名单挡住「公网地址 + 票据」外泄面。

## 4. selftest 断言锚点

landing 纯函数直测（管理/业务/全量/空权限矩阵、裸落地、双 next 白名单）；
「统一入口：/panel 无尾斜杠 302 归一」分节；dsh 宿主挂载分节的登录回跳探针。
