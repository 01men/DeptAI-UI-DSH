# 钉钉微应用 H5 实测报告（WP-11）

> 结论先看：**实验室模拟项全部通过**（jsdom 钉钉 webview UA + 真实服务实例，见 §五 证据）；
> **真实钉钉客户端 webview 实测项尚未执行**——本开发环境无钉钉客户端，已折成 §四 现场检查清单，
> 由现场（车间平板优先，验证智造包）逐项勾验。SSE 失败自动降级 30s 轮询已自动化测试覆盖。

---

## 一、部署形态（单入口，同源）

钉钉微应用后台只需配置一个主页 URL，指向元冰可控制台，dsh 对话面与之同源、共享同一会话身份：

```
https://<企业域名>/rq/console/          ← 钉钉微应用主页 URL（单入口）
  ├─ /rq/api/*        全部平台 REST（鉴权、卡片包下发、usage/behavior 等）
  ├─ /rq/console/     控制台 SPA（base-path 感知；hash 路由 #/dashboard 等）
  └─ /rq/* 之 dsh 面  dsh 对话 web 同源挂载（无跳转无二次登录，dsh-bridge 通道）
```

- 单进程单入口由 `plugin-dsh-bridge` 承担（`/rq` 前缀剥离 → 元冰可数据面），详见
  `docs/dev-plan-agent-host-unification.md` §路由表。
- 控制台 SPA 对钉钉入口做了 **UA 探测**（`js/app.js` 顶部，WP-11 最小改动）：
  `/DingTalk/i.test(navigator.userAgent)` 且无记忆平台时，写 `localStorage.heng_ops_dingtalk = '1'`
  并在 `documentElement` 标记 `data-platform-entry="dingtalk"`。
  **钉钉是入口不是第六平台**：探测绝不写 `heng_ops_platform`、不改五平台
  `data-platform` 语义（strategy/marketing/manufacturing/rd/quality），平台主题仍由
  登录后卡片包下发的 `platform` 决定（智造车间平板登录即落 `manufacturing` 主题）。

## 二、cookie：rq_sid（SameSite=Lax）在钉钉 webview 的注意事项

服务端下发（`plugin-dsh-bridge/src/index.ts:302`）：

```
Set-Cookie: rq_sid=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<24h>
```

钉钉 webview 场景的推演与注意事项（**Lax 足够，但有边界**）：

1. **Lax 语义**：同源顶级导航与同站子资源请求都带 cookie；跨站 GET 顶级导航带 cookie，
   跨站 POST 不带。钉钉微应用是 webview 内**顶级导航**打开 `/rq/console/`，属 Lax 放行面。
2. **免登链路必须走 GET 顶级导航**：钉钉侧入口若经 `?ticket=` 免登，票据兑换
   （`/rq/api/authn/entry-tickets/redeem`）是 POST——不能作为微应用主页 URL 直接打开
   （主页必须是 `/rq/console/` 这类 GET 页面；票据免登在页面内完成，消费后立即清 URL 参数）。
3. **PC 与移动端钉钉 cookie 隔离**：两端 webview 各自持有 rq_sid，绑定互不可见，
   现场验证需两端各走一遍（见 §四 C1/C2）。
4. **第三方 cookie 不涉及**：单入口同源部署，无跨站 iframe 嵌套，不依赖第三方 cookie；
   若未来把控制台嵌入钉钉群卡片 iframe（跨站），Lax 将拒发——**禁止该形态**，保持顶级导航。
5. **过期与重绑**：rq_sid 24h TTL，过期后 webview 内表现为未登录 → 登录页；
   身份绑定失效走既有「自检 + 一键重绑」通道（WP-04 A2），不在本报告展开。

## 三、SSE 降级设计（30s 轮询，不恢复 WS）

实现：`packages/plugin-console/public/js/realtime.js`（零依赖，fetch/EventSource 由调用方
传入或取自 globalThis，Node 脚本可直测）。

- **优先 SSE**：`new EventSource(url)`；**10s 内未 open**（open 超时）或**中途 error** 即降级；
  降级即 `es.close()`，**不等待也不依赖 EventSource 的自动重连**。
- **降级轮询**：`fetch GET pollPath`，间隔默认 **30s**（`pollIntervalMs`），**仅一次在途**
  （上一轮未完成不发起下一轮）；单轮失败静默，下一轮再试，循环不中断。
- **一次性回调**：`onDowngrade(reason)` 恰好触发一次（reason ∈ `unsupported` /
  `sse-init-failed` / `sse-error` / `open-timeout`），供前端挂「实时通道已降级」提示。
- **不恢复 WS**：降级是**单向**的（SSE → 轮询），会话期内不再尝试 SSE/WS——钉钉 webview
  长连接不稳时反复重连只会耗电并制造半开连接，轮询 30s 对工作台徽标/状态刷新足够。
- **决策纯函数**：`decideTransport({ sseOpened, sseError, supportsEventSource }) → 'sse'|'polling'`，
  与 `createEventStream` 共用同一判据，便于测试与前端预判。

## 四、真实钉钉客户端实测清单（现场执行，逐项勾验）

> 环境限制声明：本开发环境**无真实钉钉客户端**，以下项无法在实验室完成，留待现场执行；
> 建议顺序：管理员手机端 → 普通成员手机端 → **车间平板（优先验证智造包）** → PC 端钉钉。

| # | 实测项 | 通过判据 | 端 |
|---|---|---|---|
| C1 | 微应用主页打开 | 钉钉工作台点击微应用 → `/rq/console/` 正常渲染登录页/工作台，无白屏 | 手机+平板 |
| C2 | rq_sid 会话保持 | 登录后杀掉 webview 重进，会话仍有效（rq_sid 存活期内） | 手机+平板 |
| C3 | UA 探测生效 | 首次进入后 `localStorage.heng_ops_dingtalk === '1'`，`data-platform-entry="dingtalk"`；主题仍按卡片包平台（智造平板为 manufacturing 色） | 平板 |
| C4 | cookie 实发核对 | webview 开发者面板/抓包确认 `Set-Cookie rq_sid` 属性为 `HttpOnly; SameSite=Lax`，且后续 `/rq/api/*` 请求自动携带 | 手机 |
| C5 | SSE 实连行为 | 打开工作台后观察网络面板：SSE 端点若被 webview 掐断，30s 内出现 `onDowngrade` 且轮询按 30s 节奏进行，页面不白屏不卡死 | 手机+平板 |
| C6 | 弱网降级恢复力 | 飞行模式 10s 再恢复：轮询自动续上（单轮失败静默），无需重启页面 | 平板 |
| C7 | 免登 ≤2 步（P3） | §P3 路径走查：钉钉工作台 → 微应用（第 1 步）→ 工作台直达功能/对话（第 2 步），全程零二次登录 | 全端 |
| C8 | 智造包在平板可用 | 车间平板登录后首页 ≤6 张卡且为智造包内容（产线数据查询/数据分析师/工艺知识检索/生产文档存储/登记新资产） | 平板 |
| C9 | PC 钉钉隔离性 | PC 端钉钉打开微应用独立建会话，与移动端互不影响 | PC |

## 五、实验室模拟项与证据（本报告已完成部分）

模拟环境：jsdom 30 + 真实隔离实例（端口 7323、独立数据目录、DEMO_SEED=1、退出即清理），
钉钉 webview UA `…DingTalk/7.6.0 wb_dingtalk`。**全部通过，退出码 0**：

```bash
node tests/dingtalk-h5-smoke.mjs
# ━━ 钉钉微应用 H5 + SSE 降级冒烟（WP-11） ━━
#   ✔ ① UA 探测：钉钉 webview 且无记忆平台 → 写 heng_ops_dingtalk=1 + 入口态标记，不动 data-platform
#   ✔ ① 探测边界：钉钉 UA 但有记忆平台 → 探测不生效，记忆平台优先
#   ✔ ① 探测边界：非钉钉 UA → 不写任何钉钉标记
#   ✔ ② decideTransport 纯函数：open→sse；error/超时未 open/环境不支持→polling
#   ✔ ③ createEventStream：404 SSE 端点自动降级到轮询端点，onDowngrade 恰好一次
#   ✔ ④ /api/overview（管理账号）轮询 2 次收到数据，close() 后停轮
# 钉钉 H5 冒烟结果：6/6 通过
```

配套回归（同日基线）：

```bash
npm run lint:manifests      # 清单校验 75/75 通过；卡片包 5/5 通过（WP-09 五平台全量）
node tests/walkthrough.mjs # 走查结果：6/6 通过；核心路径实测 3 步（达标线 ≤3）
```

## 六、P3 路径：钉钉 → 工作台 ≤2 步入口链

```
[钉钉工作台] 点击「元冰可」微应用        ← 第 1 步（钉钉侧）
  └→ webview 顶级导航 GET /rq/console/（可携 ?ticket= 由页面内免登，消费即清参）
      └→ [控制台] 打开即工作台（四区：问候/场景卡片/最近调用/对话入口） ← 第 2 步
          ├→ 点场景卡片直达功能页（同步进智造包卡片）
          └→ 点「对话入口」直达 dsh 对话面（同源，无跳转无二次登录）
```

判据与既有基线一致：`node tests/walkthrough.mjs` 断言「认证 1 + 进工作台 1 + 进功能 1
= 3 步」，钉钉侧入口链不增加步数（微应用主页即控制台）；真实客户端两点（C7）现场勾验。
