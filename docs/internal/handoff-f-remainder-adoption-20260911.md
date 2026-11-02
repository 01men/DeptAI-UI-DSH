# 采纳回执：F 域余量交接清单反馈批次（M/N/P，2026-09-11）

> 回执对象：`D:\DSH-RQ\docs\handoff-f-remainder-to-main.md` M / N / O / P 节（2026-09-11 追加反馈）。
> 前情：A–K 批次已于 `7f5f3ea` 采纳（回执 `handoff-f-remainder-adoption-20260910.md`）；L 节已于 `e5e3a34` 采纳。
> 本批次结论：**M ✅ 采纳、N ✅ 采纳（含一项先行登记）、O 不消费（定制面）、P ✅ 采纳**。
> 验收：`npm run selftest` **1073/1073 全绿**（1067 → 1073）+ `npm run lint:manifests` **90/90**。

## M. 场景图谱校验器口径对齐原文 —— ✅ 采纳

`packages/platform-core/src/scenegraph.ts` 三处加法改动，与定制侧同形：

1. `SCENE_TAGS` 5 类 → 8 类（原文口径 增收/安全/环保 入表；「节能」为既有 qb01 包兼容保留）；
2. `validateScenegraph` tags 校验放宽为「可为空数组」——原文未标注场景如实装载（不造假标签红线）；
3. `ScenegraphPack.links?` 可选环节链字段，校验器不做强校验（缺位时前端从场景编号第三段反推，既有包零改动）。

既有 qb01/gcjx 包零改动照常通过 `lint:manifests`（90/90）。selftest 新增分节「场景图谱校验器（F 清单 M 节）」5 项断言：新标签入表/词表外拒绝/空数组放行/缺位仍拒/links 零校验负担。

## N. 装态可用性修复 —— ✅ 采纳

| 项 | main 侧落地 | 口径说明 |
|---|---|---|
| N-1 `PUBLIC_PATHS` +`/api/panel/auth/login`、`/api/panel/auth/refresh` | 已登记（`plugin-console/src/index.ts`，附注释） | **先行放行**：main 侧 panel 自持登录面路由尚未随 IAW 前端合入，当前无路由命中（请求照常 404，零行为变化）；定制侧 merge 后即闭环。白名单不放行任何数据（鉴权由 authn login/refresh 自身承担） |
| N-2 dsh-bridge entryTickets apply 期软读 → 请求期惰性解析（`entryTicketsAt()`） | 已落地（`plugin-dsh-bridge/src/index.ts`） | 注册面不再早退于 entryTickets 缺席（仅 identityBinding 缺席才降级「仅挂载半」）；就绪前兑换请求得到明确错误「entryTickets 服务未就绪（装配进行中）」，就绪即通。会话半（authn/iam/audit）本为 getter 惰性，未动 |

## O. IAW 协作首位改版 —— 不消费（定制面自研）

五空间序/三视图/agent-stream/ddws pull/landingRedirect 均属定制面板域自研面，main 不消费；其中 O.3/O.4 的 panel 端点与 O.5 的 `landingRedirect` 装配开关留在定制分支，随面板域专项另行评估（与 C 节 dashboard 卡片区块同口径）。

## P. 宿主已登录态 G1 扫码回跳死洞 —— ✅ 采纳

按建议修法落地，且采纳「抽共享模块」建议避免 L 节双消费者教训重演：

- **新增 `public/js/next-redirect.js` 共享消费面**：`consumeNextSources()`（一次读取 ?next= + `heng_ops_next`/`heng_ops_next_cross` 双暂存，URL 清参后置）+ `exitWithNext()`（跨源签 `POST /api/auth/entry-tickets/self` 带 `#entry_ticket=` 回跳、签票失败仍回跳 / 同源直跳）；白名单单一事实源仍为 landing.js 的 `sanitizeNext`/`sanitizeCrossOriginNext` 纯函数。零裸 fetch（api 注入，走查豁免面不变）；
- **login.js**：原两段 IIFE 消费逻辑替换为共享面调用，`finishLogin` 语义不变（跨源优先 → 同源 → 落地分诊）；
- **app.js boot**：会话就绪后、落地分诊前，`session.token` 在场且 next 可解析即按共享面出口——已登录态扫码通道变为「打开宿主页 → 立即带票弹回面板」的静默授权；未登录态行为不变。

测试：新增随包单测 `next-redirect.test.mjs`（7 例：一次读取消费/白名单拒绝面/暂存兜底/URL 优先/跨源票回跳/签票失败降级/同源直跳），selftest 以 `node --test` 通道固化；既有「登录回跳接线」静态断言升级为共享面断言（login/app 双消费者 + 白名单事实源）。

## 定制侧对表

- 本批次均为加法/重构最小改动，定制侧 merge 吸收时无预期冲突；M 节与定制侧同形（词表/口径逐字对表）；
- N-1 白名单两键在 main 为先行登记（无路由命中），merge 后由定制面板路由承接；
- P 节共享面落地后，定制侧 boot.js/向导「G1 采纳即闭环」口径继续成立，且宿主已登录态不再需要「先登出」过渡口径（P 节过渡期口径自本回执起失效）。
