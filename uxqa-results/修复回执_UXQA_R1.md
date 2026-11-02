# UXQA_R1 缺陷修复回执（含合并回归根治记录）

日期：2026-11-02（Asia/Shanghai）｜执行：ZCode Agent
关联：[UXQA_R1 评估报告](测试评估报告_UXQA_R1.md)（缺陷卡原文）｜基线：合并 57660ac + 收尾 2d2b329 之上的 UXQA 批次

---

## 1. 结论速览

| ID | 级别 | 状态 | 修复面 |
|---|---|---|---|
| UXQA-R1-005 断连重试死循环 | S2/P1 | ✅ 已修复 | 前台 api.js/app.js |
| UXQA-R1-002 并发流转静默覆盖 | S2/P1 | ✅ 已修复 | 服务端乐观锁 + 前台 409 回执 |
| UXQA-R1-001 钉钉弹窗反复弹 | S3/P1 | ✅ 已修复 | 前台弹窗记忆 |
| UXQA-R1-003 只读写入口未收敛 | S3/P2 | ✅ 已修复 | 前台权限门控 |
| UXQA-R1-004 抽屉 ✕ 遮挡 | S3/P2 | ✅ 已修复 | mfg.css z-index |
| OBS-04 清空无确认 | P3 | ✅ 已修复 | mfg.js 两步确认 |
| OBS-05 export 内部异常文本 | P3 | ✅ 已修复 | mfg/module.ts 文案口径 |

验收：`npm run selftest` 全绿（含新增 乐观锁契约 4 断言 + UXQA 护栏静态断言 6 条）；
UXQA 复测（浏览器实测）建议按报告 §6 验收用例回归（LIVE-04/07、FLW-07/13、DD-01、FLW-08 UI、UX-01）。

---

## 2. 缺陷修复明细

### UXQA-R1-005｜断连重试死循环（S2/P1）✅

**根因（三层）**：
1. `connectStream()` 在票据请求**之前**捕获轮询鉴权头——票据请求 401 触发刷新换发后，
   轮询仍持已吊销的旧令牌（30s 周期稳定复现死循环）；
2. 「连接中断·点击重试」只重建通道，不消费 `gate01_refresh`（页面内无自愈路径，
   刷新页面经 boot 链才恢复）；
3. 轮询 401 只升级「连接中断」徽标，不触发任何换发/引导。

**修复**（`packages/plugin-panel-core/public/js/`）：
- `api.js`：`tryRefresh` 改三态返回（`ok/expired/unreachable`）并导出 `refreshSessionNow()`；
  请求面 401 消费同一并发合并链路。
- `app.js connectStream`：轮询头移到票据尝试之后（取最新令牌）。
- `app.js reconnectStream`：重连前先消费 refresh——`ok` 重建通道；`expired`（双 token 均失效）
  清场并引导重登（目的地经 hash 保留）；`unreachable` 如实示警不假冒恢复。
- 轮询 401 自愈：`onPollError(status=401)` 单飞触发刷新-重建，不再等用户点击。

**验收对照**：断连→恢复后点击重试一次内回到 LIVE ✓；token 失效→重试触发 refresh 或登录引导 ✓。

### UXQA-R1-002｜并发流转静默覆盖（S2/P1）✅

**根因**：`transitionTask` 读-改-写无并发护栏；REST 无版本语义，双写双 200 后写覆盖先写。

**修复**：
- `service.ts`：`transitionTask` 增 `expectedLane` 形参（乐观锁）——与权威泳道不符即抛
  `TaskLaneConflictError`（携带权威泳道与目标泳道的中文可读文案）；未携带保持直通
  （Agent 工具桥向后兼容）。
- `index.ts`：路由捕获冲突 → 409 `VERSION_CONFLICT`（文案复用在册条目）。
- `app.js`：流转按钮携带 `data-from`（用户所见泳道）；409 → toast 明确告知 + 刷新看板到权威态。
- selftest 新增 4 条契约断言（命中/冲突不写库/权威保持/向后兼容直通）。

### UXQA-R1-001｜钉钉弹窗每加载自动弹（S3/P1）✅

**修复**：落实源码既有意图「用户关闭后不缠人」——`maybePromptDdActivation` 增
`localStorage(panel_dd_prompt_off)` 检查；自动弹窗经 `showModal` 新增 `opts.onClose`
回调链（`showBind({auto:true})` → `showBindDws` 全程穿线）在关闭时写记忆；
顶栏 ⇄ 手动打开不携带 auto，随时可再开。本浏览器不再自动弹，跨身份无串扰（装态同源）。

### UXQA-R1-003｜只读用户写入口未收敛（S3/P2）✅

**修复**（合并已带部分门控，本批补齐余量）：
- composer：无 `panel.write` 时整体替换为只读说明条（🔒 只读身份——可浏览，写操作需管理员开通）。
- 泳道 ←/→ 流转钮、`＋新建`(addlane)、「推进到」「确认通过」按 `session.can('panel.task.write')` 门控。
- （合并已含：验收裁决钮、新建任务钮门控。）

### UXQA-R1-004｜制造抽屉 ✕ 与顶栏头像重叠（S3/P2）✅

**根因**：`.mfg-scrim/.mfg-drawer` z-index 70/71 **低于** `.iaw-topbar`（200）——抽屉头在顶栏
点击层之下，✕ 中心点命中头像（elementFromPoint 实证），点击被劫持为退出确认。

**修复**：z-index 抬至 910/911（高于顶栏与 iaw 场景抽屉 900/901，低于通知卡 1400）。

### OBS-04｜清空本机记录无确认（P3）✅

**修复**：两处清空按钮改两步确认（零弹窗铁律合规，不用 confirm()）：首击变
「⚠ 确认清空全部本机记录？再点一次执行」（4s 武装态，超时自动复原）。

### OBS-05｜export 回显内部异常文本（P3）✅

**修复**：导出路由生成段 try/catch → 统一 400 中文可行动文案；执行路由 500 兜底不再回显
`error.message` 原文（与 http 层生产安全口径一致）。

---

## 3. 同期完成：上游合并（ybkkasi main 4e8fc36）与合并回归根治

> 本节属「整体性优化」的底座工程：R1 修复建立在合并后树之上，合并本身的 13 项回归已全部根治。

**合并**：57660ac（上游收编：IAW 六空间+14 行业、执行中枢投影、安全审查整改批次等 30+ 提交）。

**合并回归根治（2d2b329）**——其中 2 项为**真实产品缺陷**（非测试问题）：

1. **fs.rmSync 对单文件在本机 Windows 项目树静默失效**（无异常、返回成功、文件仍在；
   多轮实证；unlinkSync 正常）——`credentials.purge` 与 `secret-broker.delete` 的
   「删除即销毁」安全语义曾被静默打破。改 unlinkSync + 瞬态锁有界重试 + 耗尽响亮失败。
   （selftest「验收应用删除联动清库」红 → 绿的确诊路径：临时追踪 → rmSync 静默失效实锤。）
2. **01门装态基线种子静默失败**：上游 QA A-03 起 iam 写操作强制可归因 actor，种子
   createOrg/createUser 无参调用被吞 → 全新 01门装态首启无 admin 可登录
   （fresh-install 铁律级）。补 SYSTEM_ACTOR 同形 + selftest gate 补 demoAuth 声明。

其余 11 项：errors.js 5 码文案、告警异步落地稳定化、SQLite 句柄 EBUSY 关闭纪律、
C16 win32 模式位豁免、i18n fileURLToPath、三链 26/27、files +platform-i18n、
OIDC issuer 断言口径、向导 DOM 导航捕获缝、ddws demoAuth 门控、落地页断言数 1999、
收尾防悬停（stub 强断 + 30s 看门狗）。

**工程基线**：合并后 `npm run selftest` **1999/1999 全绿**、`npm run lint:manifests` 通过
（详见提交 2d2b329 消息分节）。
