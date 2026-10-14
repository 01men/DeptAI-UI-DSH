# 回执：H1-H5 宿主侧落地的定制面配合批（custom/dsh-rq · 2026-09-09）

> 对应文档：ybkkasi main `docs/handoff-qa-fixes-host-implementation-20260909.md`
> （H1~H5 宿主侧评估/实现/回归）。本文档记录定制分支的配合落地与一处**根因修正**。
> 定制分支自本地宿主克隆合并 37880a2（GitHub 代理未通，`git fetch <本地克隆> main` 等效），
> 合并后 selftest 1056/1056、lint:manifests 85/85 绿。

---

## 结论速览

| 项 | 定制面动作 |
|---|---|
| H1 注入链 | 五处槽注册改**无条件 `slots.inject`**（纪元机制）；并发现比时序更强的**确定性根因**（见下节）；bundle 重建；selftest 新增「bundle 真执行 × mock rc.7 注入面」回归段（装机铁律加固） |
| H2 realtime | 已随合并吸收 onPollError/health 契约；面板徽标取 health() 投影与定制 95s 看门狗的并集（保留「连接中断·点击重试」自救与退出登录入口） |
| H3 refresh | 零改动吸收（面板 api.js 已收口 tryRefresh，契约向后兼容成立） |
| H4 stream ticket | 面板 connectStream 已迁 ticket 优先（失败回落 `?token=`）；远端形态（C）的 ticket 签发经 `/rqcard/proxy`（`/api/panel/` 前缀白名单内）；**旧通道消费方已就绪，main 侧可安排 fail-closed 收口** |
| H5 声明网 | 零改动吸收（console F 域余量端点经统一 guarded() 自动入网，无双登记） |

## H1 根因修正：探测 API 名错配是**确定性**根因（比时序更强）

宿主侧文档的根因排序：① bundle 产物过期 ② probe-before-declare 时序。定制面核实 rc.7
（`D:\DSH\deepseek-harness`）后发现一个被两份文档都漏掉的**第三根因，且它单独即可造成
QA 全部现象**：

- rc.7 客户端 `SlotRegistry` 服务面（`packages/client/runtime/src/client/slots.ts` 的
  SlotsService，d.ts 同名）暴露的 spec 查询 API 是 **`spec(key)`**；
- `specDynamic(key)` 只存在于 pure core（`ui-slots` 的 SlotCore），服务面**没有**该成员；
- 旧 bundle 的 `probeSpec` 对 `ctx.slots` 按 `{ specDynamic?: … }` 探测——运行期恒
  undefined，**五处 probe 在任何时序下都必然全数落空**（不是「声明前落空」，是「永远落空」）。

时序缺口（spec 查询的点时刻语义）依然真实存在，但即便修好时序，旧代码也探不到。
两个根因叠住的结论不变：**无条件 `slots.inject` 是唯一正解**（探测从消费链上整体消失）。

## 配合项①落地：无条件 inject + 注入半诊断台账

`packages/plugin-rq-card/src/client/index.ts`（bundle 已重建）：

- 五处槽注册（toolview×N 键位 / assistant-actions / settings.section / conversation.view /
  shell.overlay 降级与未连接角标）全部改为 apply 期无条件 `ctx.slots.inject(key, cb)`——
  未声明时回调挂起、属主包声明提交即同步触发（纪元机制天然容忍属主后到）；
- kind 校验移入回调（触发即声明已在场，此时 `spec()` 结果才可信）；失配折叠为降级台账，
  回调体全保护（宿主对延迟路径的回调抛错经 queueMicrotask 重抛，绝不外逃污染页面）；
- `__RQ_CARD_DIAG__.attempts` 新增注入半阶段（与 banner 装载半互补）：
  `inject-pending:<key>`（apply 时声明未在场，回调挂起）、`inject-materialized:<key>`
  （回调触发且 kind 通过）、`inject-kind-mismatch:<key>`（失配）；
  复测定性：停在 pending = 声明永不到来（属主改名/未装载）；materialized 在册而 UI 缺失 =
  注册后被宿主消费链丢弃（携 slots.ts reconcile/epoch 行号升级）；
- 降级角标改为无条件注册、组件渲染期读 DEGRADED（声明波次内落账、渲染在其后，读取即终值）；
  overlay 整批未落地且确有降级原因时 10s 后 DOM 直挂兜底（不依赖 slots）。

**selftest 加固（装机铁律）**：新增「rq-card bundle 真执行」段——此前 bundle 只被解析从不被执行，
H1 这类病灶不可见。现以 vm 沙箱 + mock rc.7 注入面（inject 挂起/spec 声明后可见语义）真执行
`lib/client.js`：apply 先于声明 → 断言零注册 + inject-pending；五槽声明落地 → 断言全部注册
（键位不重复）+ inject-materialized；kind 失配 → 断言降级台账、断言不抛错外逃。
**改注入面忘跑真执行 = 推送前即红。**

## 对宿主侧文档的两点勘误/补全建议

1. 「环节 3」表格结论「五个 key 全部在册且 kind/scope 匹配」成立，但
   「语义缺口（根因最大嫌疑）」应补 API 名错配这一确定性根因（见上节）——
   复测若再遇注入缺失，先查 `__RQ_CARD_DIAG__` 的 `inject-materialized` 是否在册，
   再区分「声明未到」与「消费链丢弃」。
2. H1 根因排序第 2 条「建议定制面把三段注册改为无条件 slots.inject」已落地（本文档），
   宿主侧无需再改动；`registered-not-materialized` 若复测真出现，再按
   system.ts:88-95 / boot.tsx:216-237 行号升级。

## ?token= 旧通道收口前置条件确认（对宿主侧文档「遗留 2」）

面板 connectStream（本批起）先 POST `/api/panel/stream-ticket` 换 ≤60s 一次性票据，
失败才回落 `?token=`。dsh 部署物理真相由定制分支掌握：**插件包升级到本批之后，
面板消费方全部具备 ticket 能力**——main 侧可安排「下个版本拒绝旧通道」的 fail-closed
收口；唯一注意点是收口版本需晚于存量 dsh 部署完成本批插件升级。
