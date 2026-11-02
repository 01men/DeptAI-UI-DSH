# 01门（DeptAI-UI-DSH）演示环境部署与闭环验收 · 2026-11-01

> 任务：基于 demo.ybkkasi.com 现有演示环境部署 [01men/DeptAI-UI-DSH](https://github.com/01men/DeptAI-UI-DSH)（@ybkk/gate-01），
> 使交互闭环链路完整，并实测验证跳转登陆、绑定关系、数据链路、交互响应。
> 结论先行：**四条链全部实测通过**；部署面与本仓一文件改动（控制台 01门入口）随本批提交。

## 一、部署拓扑（全部落在本机，公网仍只暴露 demo.ybkkasi.com 一个子域）

```
浏览器
  │ https://demo.ybkkasi.com/
  ▼
Cloudflare（ybkk-demo 隧道 · config-demo.yml 本地管理 ingress，路径规则按序匹配）
  ├─ ^/gate01(/|$)      → http://127.0.0.1:7778   ← 新增：01门面板 + rqcard 向导命名空间
  ├─ ^/dsh-bridge(/|$)  → http://127.0.0.1:7778   ← 新增：宿主身份绑定面（浏览器同源端点在根命名空间）
  └─ 其余全部            → http://127.0.0.1:7302   ← 演示底座（com.ybkk.ops-demo，DEMO_MODE=1+DEMO_SEED=1）
                                                      内嵌 plugin-panel-core 在 /panel/（底座原生面板，与本部署并存）
```

- **7778 实例**：dsh `demo` profile（`~/.dsh/profiles/demo`），bundles = dsh-base + dsh-web-app +
  `@ybkk/gate-01@1.2.1`（pin `github:01men/DeptAI-UI-DSH#b7542a3`，与生产 7777 同版）；
  patch 仅 `ops-panel-core { demoAuth: false, landingRedirect: true }`（严格登录态，与生产装态一致）。
- **数据目录隔离**：gate-01 `opsStorage.dataDirPath = cwd()/data`（platform-core/storage.js），
  launchd 作业 `com.ybkk.gate01-demo` 以 `WorkingDirectory=/Users/ybkk/ybkk-lab/gate01-demo` 起动
  → 数据落 `ybkk-lab/gate01-demo/data/`，与 7777（cwd=~ → ~/data）互不可见。
- **绑定关系（落盘）**：`gate01-host-link.json = { mode: "remote", hubBase: "http://127.0.0.1:7302", hubMountPrefix: "" }`
  ——面板数据面经 dsh `/rqcard/proxy` **回环直达演示底座**（浏览器零跨域）。
- 常驻：`~/Library/LaunchAgents/com.ybkk.gate01-demo.plist`（KeepAlive，端口 7778，
  `--trusted-host demo.ybkkasi.com`；dsh web UI 根路径仍被 dsh 自身登录门保护，公网只放行
  gate01/dsh-bridge 三个公开命名空间——与 7777 实测口径一致）。

## 二、闭环四链实测（2026-11-01，API + 真浏览器双重验证）

| 链路 | 验证点 | 结果 |
| --- | --- | --- |
| **跳转登陆** | 控制台演示横幅「打开 01门 · 部门工作台」→ `gate01-go.html` 免密中转页（自动签票兑换）→ 直达 `/gate01/panel/` 工作台，以「沈亦澜」身份呈现；**客户全程零输入**（当日下午批次，见 2.1） | ✅ 真浏览器全流程走通 |
| **绑定关系** | `GET /gate01/rqcard/link` = remote（向导 setRemote 两级探测后落盘）；向导「已连接服务器」；`/dsh-bridge/status` 公开绑定面在位；钉钉面 `/api/panel/ddws/status` 诚实回显未装 dws CLI + 四步绑定引导 | ✅ |
| **数据链路** | 经代理 8/8 端点 200：depts(5) / industries(14) / board / rd/tasks(2) / rd/channels(3) / rd/skills(6) / models(4) / mfg/catalog——全部为演示种子数据 | ✅ |
| **交互响应** | 空间切换（协作→执行「事务流工作台」）、消息流（Agent 卡片/工单/钉钉同步标记）、技能直调框、通知中心、SSE 实时流（`retry` 握手 + 页内 EventSource 保持 open；健康徽标「实时通道正常」） | ✅（SSE 见 3.3 降级说明） |

### 2.1 一键免密入场（当日下午追加批次）

客户直达 `/gate01/panel/` 会落「连接向导」要求输账号密码——演示环境不该把这一步暴露给客户。
追加实现（全在底座仓，生产实例零影响）：

- **`POST /api/panel/auth/demo-entry`**（公开白名单 + 处理器内 `isDemoMode` 否决，非演示实例恒 404）：
  服务端登录种子演示账号（口令与 `seed.ts DEMO_SEED_PASSWORD` 同源常量，本就公开于仓库）→
  签发 ≤120s 一次性**自助票**（refType=self，与既有票据用途隔离语义一致）→ 入审计
  （`demo.entry.ticket.issue`）。
- **`public/gate01-go.html` 免密中转页**：签票与 01门装态探测**并行**，票到手即
  `location.replace('/gate01/panel/#entry_ticket=…')`，面板 boot 经既有代理兑换链建立会话；
  未部署 01门 → 指去底座内置 `/panel/`；非演示实例 → 诚实提示 + 手动登录通道。
- **入口改指向中转页**：演示横幅与首页 01门入口由探针返回 `${MOUNT}/gate01-go.html`。
- 浏览器实测（公网，边缘抖动窗口内）：中转页 → 自动兑换 → 完整工作台（头像「沈」/
  「实时通道正常」/ 协作频道·数字同事·成员全量）~15s 内完成，客户零输入。
- selftest：非演示实例 404 断言 + 公开白名单锁定 + 随包单测 3 项；总量 1795/1795。

### 2.2 教训（写给人看）

中转页初版把流程写在 `type="module"` 顶层并用了 `return` 早退——**模块顶层 return 是
SyntaxError，整段脚本静默不执行**（页面永远停在初始文案）。已改为 async 函数包裹，并加
`window.__gate01EntryBooted` 启动标记 + error/unhandledrejection 捕获（页面自证可诊断）。
排障时「页面内手动 fetch 全通但页面不动」就是这类病：脚本根本没跑，不是网络问题。

## 三、已知边界与运维口径（诚实记录）

1. **hubBase 取回环地址**（`http://127.0.0.1:7302`，非公网域名）：数据面（登录/看板/SSE）不经过
   Cloudflare 边缘——实测当日边缘抖动（全部子域 7-12s/间歇 502，与本部署无关），公网 hubBase
   会让每次面板调用双跳边缘、随边缘健康波动；回环后数据面恒稳。代价：面板侧栏「宿主控制台 ↗」
   链接与向导「钉钉扫码登录」按钮指向 `127.0.0.1:7302`，**仅本机用户可点通**，公网访客失准
   （已向上游提 DeptAI-UI-DSH#9：`hubProxyBase` 分离浏览器面/代理面）。
2. **演示底座写闸（设计内，非缺陷）**：演示实例 2026-10-31 安全审查 P0-03 起，非 GET/HEAD
   一律 405 对登录态一视同仁（演示口令公开在仓库，不得因登录获得可写实例）。因此 01门面板在
   演示底座上：读 + SSE 全通；写类交互（任务流转/钉钉绑定/发消息）405，面板横幅如实提示。
   SSE 未断的原因：面板前端 ticket 签发被 405 后自动回落 `?token=` GET 通道（建流免签票）。
3. **SSE 边缘抖动降级**：面板建流 10s open 超时后一次性降级 30s 轮询（不自动重升）。公网边缘
   慢窗口内首次建流可能落到轮询——刷新页面即恢复 SSE；轮询期间数据照常刷新，面板如实标注。
4. **CF 边缘对 demo.ybkkasi.com 的 .html 有缓存**（实测会绕过 origin 的 no-cache，且疑似忽略
   query）：静态页更新后公网可能仍见旧版。gate01 中转页因此定名 `gate01-go.html`——**后续改动
   该页请换新文件名**（旧名等缓存过期自然失效；正式入口都走探针动态地址，不受影响）。
5. **升级口径**：7778 与 7777 同一上游、独立 profile——升级互不影响。演示侧升级：
   `cd ~/.dsh/profiles/demo && pnpm add github:01men/DeptAI-UI-DSH#<sha> &&
   launchctl kickstart -k gui/$(id -u)/com.ybkk.gate01-demo`，核验
   `curl 127.0.0.1:7778/gate01/panel/` 200 + `/gate01/rqcard/link` remote。
6. **回滚**：`launchctl bootout gui/$(id -u)/com.ybkk.gate01-demo` +
   `config-demo.yml` 删去两条路径规则再 `kickstart -k com.cloudflare.tunnel-demo` 即净；
   卸载不留任何底座侧状态（host-link 与数据目录均在 gate01-demo 工作目录内，整目录可删）。

## 四、复验速查

```bash
# 一键免密入场（演示态）：签票 → 应返回 etk_ 票据（非演示实例 404）
curl -s -X POST http://127.0.0.1:7302/api/panel/auth/demo-entry -H 'content-type: application/json' -d '{}'
# 绑定与面板
curl -s http://127.0.0.1:7778/gate01/rqcard/link -H 'x-rqcard-call: 1'
# 代理登陆（演示种子账号）
curl -s -X POST http://127.0.0.1:7778/gate01/rqcard/proxy/api/panel/auth/login \
  -H 'x-rqcard-call: 1' -H 'content-type: application/json' \
  -d '{"username":"admin","password":"Ybk@2026"}'
# 公网分流（边缘健康时均应 200）
curl -s -o /dev/null -w '%{http_code}\n' https://demo.ybkkasi.com/gate01/panel/
curl -s -o /dev/null -w '%{http_code}\n' https://demo.ybkkasi.com/gate01-go.html
curl -s -o /dev/null -w '%{http_code}\n' https://demo.ybkkasi.com/dsh-bridge/status
```
