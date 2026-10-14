# 统一入口与角色落地分诊——管理员 / 业务员界面切换规则（2026-09-07）

> 回答一个问题：**dsh 宿主端，管理员和业务员各自用哪个界面、怎么互切？**
> 本文件定版切换规则，并记录本次优化的修复清单与测试位置。
> 关联：`docs/dev-plan-agent-host-unification.md`（单进程单入口）、`docs/panel-implementation.md`（部门面板）、`docs/action-plan-dsh-frontend.md`（WP-02 票据免登）。

---

## 一、三个界面面与两种部署形态（URL 一览）

| 界面面 | 使用者 | 独立形态（7300） | dsh 宿主形态（单进程单入口，如 8801） |
|---|---|---|---|
| 管理控制台（元冰可 console SPA） | 管理员/治理角色 | `/` | `/rq/` |
| 部门 Agent 工作台（panel SPA） | 业务员/部门成员 | `/panel/` | `/rq/panel/` |
| dsh 对话界面（Agent 交互面） | 全员（业务面） | —（不存在） | `/` |
| 门户 | 匿名访客 | 外部独立站点（如 8092） | 同左 |

**优化前的乱象**（全部实测确认）：

1. **没有"该去哪"的规则**：管理员要记住 `/rq/`、业务员要记住 `/rq/panel/`，落错地方只能手改网址；
   且同一 URL 在两种形态下含义不同（`/` 在独立形态=控制台、在宿主形态=对话面）。
2. **`/panel`（无尾斜杠）白屏**：静态伺服把 index.html 垫在 `/panel` 路径上，相对资源 `./js/*`
   解析到 `/js/*` → 404 → SPA 兜底回控制台 HTML → 模块 MIME 错误白屏（挂载形态 `/rq/panel` 同理）。
3. **面板的宿主 Cookie 直通在挂载形态静默失效**：面板 boot 用 `${BASE}/dsh-bridge/*`（= `/rq/dsh-bridge/*`），
   而 `/dsh-bridge/*` 注册在 dsh webServer 根上、不在 `/rq` 之内 → 剥前缀后无此路由 → 静默 miss
   （selftest 只直测过端点本身，浏览器路径从未被覆盖）。
4. **登录即失忆**：面板 401 引导"去控制台登录"不带回跳；控制台所有登录路径成功后固定落 `#/dashboard`
   ——业务员登完录被晾在控制台，得自己找路回面板。
5. **控制台没有宿主会话直通**（只有面板有三级会话链）：同一 `rq_sid` 身份，进面板零登录、进控制台却要再登录。
6. 互切入口零散且单向硬编码：控制台 NAV"部门面板"、面板 rail"管理控制台"，对话面只有执行卡片内的临时链接。

## 二、定版规则（本次优化后）

**一句话：一个入口，按身份落地；显式切换记偏好；登录回跳不丢目的地。**

### 2.1 一个入口，按身份落地（分诊）

- 唯一需要记住的入口 = 控制台地址（宿主形态 `/rq/`，独立形态 `/`）。
- 控制台启动（app.js `boot()`）在会话就绪后做**落地分诊**（`js/landing.js` 纯函数）：
  - **纯业务身份**（无任何管理域标记权限点，且持有 `panel.read`）→ 自动落到部门面板；
  - **管理/治理身份**（平台管理员 `*` / 组织管理员 / 资源管理员 / 开发者 / 审计员，判据 =
    `iam.user.read` / `approval.read` / `audit.read` / `usage.read` 任一）→ 控制台工作台；
  - 分诊只在**裸落地**（无 hash / `#/` / `#/dashboard`）时触发；深链刷新与页内导航永不触发；
  - 登录成功路径（`login.js finishLogin`）同规则：纯业务身份登录后直达面板。
- 判据用权限点而非角色名：iam `userPermissions` 已把 `iam.*` 等通配展开成具体点，
  member 角色不含任何管理域标记，其余内置角色必持有至少一项（`landing.test.mjs` 逐一断言）。

### 2.2 显式切换记偏好（防来回拽）

- 面板 rail「管理控制台」、控制台 NAV「部门面板」点击时写 `localStorage['heng_ops_landing']`
  （键常量 `LANDING_PREF_KEY`，两侧字面量同步）。
- 分诊尊重既有偏好：偏好=`console` 的纯业务用户停在控制台，不再被拽回面板；反之亦然。
- 宿主形态下面板 rail 额外提供「Agent 对话」入口（`/`，仅 dsh 桥可达时出现）——
  三个界面面在宿主形态两两可达。

### 2.3 登录回跳不丢目的地

- 面板 401 引导「去控制台登录」带 `?next=<当前面板地址>`；
- 控制台 api.js 在 401 踢登录前把被中断的目的地暂存 `sessionStorage['heng_ops_next']`；
- 登录页消费顺序：`?next=` 参数 > 暂存键，**读取即消费**；白名单仅同源绝对路径
  （`sanitizeNext`：`/` 开头且非 `//`，防 open redirect）；无目的地时按 2.1 分诊。

### 2.4 会话链（两种形态统一为三级）

```
已有令牌(localStorage heng_ops_token) → ?entry_ticket= 票据兑换 → 宿主 Cookie 直通(POST /dsh-bridge/session)
```

- 控制台与面板**同款三级链**（本次补齐控制台第三级）；`/dsh-bridge/*` 一律**根绝对路径**
  （注册在 dsh webServer 根上；独立形态该面不存在 → 回落 HTML → 静默跳过）。
- 两个 SPA 共用同一组 localStorage 键，同源会话天然互通。

## 三、本次修复清单

| # | 修复 | 文件 |
|---|---|---|
| 1 | `/panel`（及挂载形态 `/rq/panel`）302 归一目录形态，修白屏；Location 带 `externalBase` | `plugin-panel-core/src/index.ts` |
| 2 | 面板 boot 宿主直通改根绝对 `/dsh-bridge/*`（挂载形态从静默失效修为可用）；顺带探测宿主桥供 rail 出「Agent 对话」入口 | `plugin-panel-core/public/js/boot.js`、`app.js` |
| 3 | 控制台补齐第三级会话链（`exchangeBridgeSession`），与面板同款零二次登录 | `plugin-console/public/js/api.js`、`app.js` |
| 4 | 落地分诊纯函数模块（决议/裸落地/回跳白名单） | `plugin-console/public/js/landing.js`（新） |
| 5 | 控制台启动分诊 + NAV 部门面板记偏好 | `plugin-console/public/js/app.js` |
| 6 | 登录回跳（`?next=` + 401 暂存）统一出口 `finishLogin`；SSO 路径更名 `finishSsoLogin` 归流 | `plugin-console/public/js/pages/login.js` |
| 7 | 面板 rail 管理控制台记偏好 + 401 引导带 `?next=` | `plugin-panel-core/public/js/app.js` |

**明确不做**：不改 dsh web 源码（对话面常驻导航受 dsh.client 档次面限制，维持执行卡片内链接）；
不动 RBAC 端点矩阵（服务端权限面零变更，本次全部是静态托管/前端引导层）。

## 四、测试位置（selftest 断言）

- 「统一入口：/panel 无尾斜杠 302 归一」节（独立形态）：302 两形态、面板 SPA 可达、
  `landing.test.mjs` 随包单测（node --test）、四处前端接线 grep 不变量。
- 「dsh 宿主单入口挂载」节：`/rq/panel` → `/rq/panel/`（externalBase 感知）。
- `packages/plugin-console/public/js/landing.test.mjs`：五内置角色决议、`iam.*` 通配展开、
  `*` 全量、面板不可达回落、裸落地判定、open redirect 白名单。
