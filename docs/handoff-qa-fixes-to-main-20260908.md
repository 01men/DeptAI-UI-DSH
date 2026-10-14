# QA 2026-09-08 验收缺陷 · 宿主平台侧修复清单（custom/dsh-rq → 上游 main）

> 目标读者：负责宿主平台（上游 `01men/ybkkasi` main / dsh 平台侧）的开发团队。
> 依据：`docs/qa-report-dsh-plugin-first-20260908.md`（出口判定：不通过，P0=1）。
> 定制面（plugin-panel-core / plugin-rq-card / plugin-dingtalk-bridge / 面板前端）可修部分
> 已在定制分支同批修复并全量回归（selftest 1012/1012 + lint:manifests 85/85，含新增
> T-01/T-03/T-04 越权与重投回归）；**本文档只列必须由宿主平台侧完成的能力改动**，
> 按优先级排序。定制面修复对照清单见文末附录。

---

## H1（P1 · 对应 BUG-G-01 根因排查）dsh rc.7 会话侧注入链：rq-card 浏览器半 apply(ctx) 未被调用

**现象**（两台独立实例复现：E1 3080 源码 patch 形态 / 3099 link 安装形态）：
`/plugins/@dsh-ops/plugin-rq-card/client.js` 加载成功且与构建产物逐字节一致、
`__DSH_BOOT__.entries` 含该插件，但「元冰可工作台」视图 Tab / 设置分区 / 未连接角标 /
降级角标全部静默缺失（连兜底角标都不出现，说明 apply 从未执行或五处 slot 探测全数失败）。

**请宿主/dsh 团队排查三个环节**：
1. **装载器消费链**：rc.7 对 `window.__ModuleLoader__.load({id, factory})` 注册条目的
   物化时机与调用环节——是否存在「注册被接受但工厂从未执行」的路径（本批 bundle 已埋
   `registered-not-materialized` 诊断指纹，见下）；
2. **api-catalog / client-modules 白名单**：`@dsh-ops/plugin-rq-card` 的 package.json
   `dsh.client.inject` 声明了 `@deepseek-ai/dsh-client-runtime`、`dsh-client-ui-conversation`、
   `dsh-client-ui-settings`、`dsh-client-locale`——核对 rc.7 api-catalog 是否对插件 client
   bundle 放行这四项；
3. **slot 契约**：`ctx.slots.specDynamic()` 对 `tool.call.toolview`（keyed）、
   `conversation.chat.assistant-actions` / `settings.section` / `conversation.view` /
   `shell.overlay`（list）的存在性与 kind 是否与 spike §3.2 名录一致（rc.7 是否有改名/改 kind）。

**定制侧已交付的诊断面**（复测时直接读取，无需再造轮子）：
- `window.__RQ_CARD_DIAG__`：`{ installed, attempts[] }` 台账。`attempts[].stage` 取值
  `loader-missing`（装载器不可达）/ `registered-not-materialized`（load 被接受但工厂未物化，
  **即环节 1 缺陷指纹**）/ `factory-threw` / `installed`；
- 装载器缺失时 bundle 自带 250ms×40 有界重试（脚本顺序竞态自愈）；
- 终局未安装 → 页面右下角直接挂 DOM 角标（不依赖 slots）；slot 探测失败且 overlay 槽
  不可用 → 客户端 apply 内另行挂 DOM 角标。复测时若角标在场，读 `__RQ_CARD_DIAG__`
  即可定位故障环节。

**边界说明**：bundle 产物过期问题（仓库 b6a3329 提交的 lib/client.js 与源指纹不一致）
已在定制侧重建修复，selftest「bundle 新鲜」门禁恢复绿；宿主侧无需处理。

## H2（P1 · BUG-U-02 的传输层与 console 半修复）realtime.js 轮询失败静默

- 位置：`packages/plugin-console/public/js/realtime.js` `runPoll()` 的
  `catch { /* 单轮失败静默，下一轮再试 */ }`（约 :82）。
- 影响：断网后轮询持续失败无任何信号，console 自身 LIVE/轮询徽标照常宣称实时；
  面板侧同病（面板已在定制面加看门狗缓解，见附录）。
- 建议宿主面修复：`createEventStream` 增加 `onPollError(error, consecutiveFailures)` 回调
  （或暴露健康态 getter），由各消费方决定徽标降级；面板侧契约保持向后兼容（可选回调）。

## H3（P1 · 新测试目标 T-08）authn refresh token rotation 多标签页互踩

标签 A 刷新令牌后，标签 B 持有的旧 refreshToken 已被吊销；B 的请求 401 → 刷新失败
→ B 无法自愈。建议宿主面 authn 提供二者其一：
- refresh rotation 宽限窗口（旧 refreshToken 在 N 秒内仍可兑换一次）；或
- 刷新失败且访问令牌仍有效时的短宽限重试契约。
契约定版后定制面（面板 api.js 已收口全部刷新逻辑于 `tryRefresh`）配合适配。

## H4（P2 · P2-O-5 的架构性收敛）SSE 鉴权令牌不落 query string

EventSource 无法携带 Authorization 头，当前 `?token=` 自校验是已知取舍，但长效访问
令牌会进代理/访问日志。建议宿主面提供**短时一次性 stream ticket** 通道
（POST 换取 ≤60s 一次性 ticket → `?ticket=` 消费即焚），各 SSE 端点迁移。定制面面板
已依赖「代理显式拒绝 SSE 透传」降低暴露面（selftest 在案），迁移后无感。

## H5（P2 · 源自 T-01 教训的平台加固）routeMatrix 对自注册公开端点的覆盖义务

`/api/panel/stream` 经 `http.register` 注册、不进 routeMatrix，恰好逃出 selftest
「RBAC 100% 越权断言网」，酿成 P0（SSE 缺部门范围校验，已在定制面修复+回归）。
建议宿主面在 httpServer 上要求：自注册端点必须声明 auth profile（含「公开+自校验」
这一显式类别），使断言网可枚举全部端点、同类缺口不再依赖人肉发现。

## H6（复测环境 · 非代码改动）

- E3 双机形态全链（CONN-02 / AUTH-03(E3) / DSH 系列）——需第二台完整 dsh；
- dsh 侧配置模型后的 DSH-05~08（对话工具链走查）；
- 宿主 G1 回跳增强上线后的 AUTH-09 / SEC-07 GUI 端到端（依赖 H 侧排期）。

---

## 附录 · 同批定制面已修复项（宿主侧无需处理，仅供对照）

| 编号 | 修复 | 落点 |
|---|---|---|
| BUG-A-01（P0） | SSE 握手补 deptScopeAllowed + 未知部门 404 + principal 与 console 中间件同规（human→userId） | plugin-panel-core/src/index.ts |
| BUG-A-02（P1） | 去重只认 status='sent'，failed 原地覆盖允许重投 | plugin-dingtalk-bridge/src/service.ts |
| T-04 | 无群桥投递也 emit 回执事件，面板消息不再永久 pending | 同上 + panel-core 回执回写 |
| BUG-G-03（P1） | 同步钉钉按钮三态前置检查 + 明确 toast | 面板 app.js |
| BUG-U-01 | 时间本地时区展示（消息/知识卡/看板戳） | 面板 app.js |
| BUG-U-02（缓解） | 轮询态 95s 无数据 → 「连接中断·点击重试」徽标 | 面板 app.js（根治见 H2） |
| BUG-U-03/04 | 请求默认 20s 超时（模型测试 60s 豁免）+ 中文网络错误文案 | 面板 api.js / wizard.js |
| BUG-U-05 | 会话刷新失败即清场广播，统一切回登录引导 | 面板 api.js + app.js |
| BUG-U-06 | esc() 补引号转义（属性 XSS 根治）+ md() 白名单适配种子单引号 span | 面板 app.js / wizard.js |
| BUG-U-07 | 输入草稿按 部门:频道 落 localStorage，切换/刷新不丢 | 面板 app.js |
| BUG-U-08 | 核心操作热区 ≥32-38px；375px 顶栏收敛布局 | 面板 panel.css |
| BUG-U-09 | 向导首屏去内部术语（形态 B/C / 免登命名空间 / 向导头 / 宿主） | 面板 wizard.js |
| BUG-U-10 | 崩溃页友好化 + 重新加载按钮 + 技术详情折叠 | 面板 boot.js |
| T-02 | 代理 3xx 透传 location 头 | plugin-rq-card/src/hostlink.ts |
| P2-O-1 | `ftp://` 等显式 scheme 先行拒绝（原被规范化成 http://ftp） | 同上 |
| T-05/T-06 | messages limit 收敛 [1,200] + 正文 10k 上限 | plugin-panel-core/src/index.ts |
| P2-3/4/6/10 | 退出登录入口 / 配置按钮按权限隐藏 / 平台 chip 中文名 / 小字对比度 | 面板前端 |
| SEC-05 加固（额外发现） | 初始口令一次性消费改 unlinkSync——Windows 实测 rmSync(force:true) 静默失败不删文件，防线在 Windows 部署形同虚设 | plugin-rq-card/src/hostlink.ts |
| G-01 可诊断面 | `__RQ_CARD_DIAG__` 台账 + 装载防御重试 + 两类兜底角标 + bundle 重建 | plugin-rq-card/build.mjs + src/client/index.ts + lib/client.js |

回归佐证：selftest 新增「SSE 范围校验 403/合法建流/未知部门 404」「失败投递重推真实外呼」
「无群桥回写 failed」共 5 项断言全绿；`npm run selftest` 1012/1012、`npm run lint:manifests` 85/85。
