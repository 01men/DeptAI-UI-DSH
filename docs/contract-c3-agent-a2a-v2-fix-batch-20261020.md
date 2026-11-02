# 修复批次说明：A2A/UHP 验收缺陷整改（QA 2026-10-20）

> **依据**：《企业数字员工内网通信协作方案 A2A+UHP 前后端整体适配验收 · 总测试报告》（测试组 5 组并行，P0×1 / P1×9 / P2×24，去重后 34 项）
> **日期**：2026-10-20　｜　**性质**：contract-c3 v2 发布后的安全与契约整改批次（升版语义不变，契约面 additive/收口）
> **本文**：逐项登记「缺陷编号 → 根因 → 修复 → 回归护栏」，作为验收复测的对账清单。

## 一、P0：UHP 任务劫持（三面同源，四层防御）

**缺陷 Q-1（组B B-1）**：`POST /v1/uhp/responses` 把请求体 `metadata.ybk_a2a_task_id` 当作可信任务归属凭据，任意持 `uhp.invoke` 的机器凭证可劫持任意 A2A 任务：绕过 `auth_required` 人在环审批、伪造交付物、审计被栽赃给原发起人。

四层防御（任一层单独修复都不闭环，故同时落地）：

| 层 | 修复 | 位置 |
|---|---|---|
| ① 协议面 | 外部请求携带 `ybk_a2a_task_id` 一律 **400 `TASK_BINDING_FORBIDDEN`**（拒绝而非忽略，使注入尝试成为可观测审计事件 `uhp.invoke.task_binding_denied`）；该字段仅允许平台内部 `a2a.task.dispatch` 总线通道注入 | plugin-uhp `/v1/uhp/responses` |
| ② 服务层 | `createResponse` 增 `dispatchedByPlatform` 标记：非平台派发携带 `taskId` 直接抛 `UhpBindingError`（fail-closed 兜底）；执行记录新增 `callerPrincipalId/callerName/callerKind/actChainJson/onBehalfUser` 归属字段 | plugin-uhp 服务 |
| ③ 进度面 | `emitProgress` 仅对 `dispatchedByPlatform=true` 的记录发 `a2a.task.progress`（外部直调永不驱动 A2A 状态机）；A2A 侧 `onProgress` 再校验 progress 的 `responseId` 必须等于本任务已登记的派发 responseId，不匹配则落 `a2a.task.progress_rejected` 审计并丢弃 | plugin-uhp + plugin-a2a 双向 |
| ④ 审计面 | 执行审计主体取执行记录的真实调用方（外部直调=持证 principal；平台派发=任务发起方），并携带 act 链与 `onBehalfUser`——「谁执行了哪一次」可按 responseId/taskId 反查 | plugin-uhp `auditExecution` |

**回归护栏**：selftest「A2A/UHP 安全护栏」第 1 组断言（完整复刻组B B-1 复现路径：造 `auth_required` 受害任务 → 外部凭证注入 → 断言 400 + 受害任务仍 `auth_required` 且无伪造交付物）。

## 二、P1：授权边界（6 项）

| 缺陷 | 根因 | 修复 | 护栏 |
|---|---|---|---|
| Q-2/A-1/B-5/E-1 越权取消他人任务 | `cancelTask` 复用 `getTask` 的**可读性**判定，只读治理点 `a2a.directory.read` 被当作写通行证 | 新增严格 `assertTaskOwner`（仅发起方本人或 `*`）；JSON-RPC 返回保留码 `-32003` 与参数错误分流 | 护栏第 2 组 |
| Q-3/B-4 UHP 执行记录无归属 | `/v1/uhp/responses/:id` 与 cancel 不比对归属 | 记录落 `callerPrincipalId`；读/取消仅属主或 `*` 可用（非属主按 404 回应，不泄露 id 存在性） | 护栏第 6 组 |
| Q-4/B-2 治理面无组织隔离 | A2A/UHP 治理读端点未复用 R11 组织子树口径 | `directory/tasks/fulfillment/uhp:harnesses/uhp:responses` 全部按可见组织子树收敛（fail-closed：无归属=空集） | 护栏第 5 组 |
| Q-5/B-3 治理读=全平台明文正文 | `a2a.directory.read` 被实现为全量明文读取 | `taskView` 按调用方脱敏：正文（message/artifacts 内容/协商要约/历史流水）需发起方本人、`a2a.task.accept` 或 `*`；否则 `contentRedacted: true` + 状态骨架 | 护栏第 3 组 |
| Q-29/B-8 REST 与 RPC 归属口径不一 | REST 详情端点直查集合、绕过 `getTask` | REST 与 `tasks/get` 统一走 `getTask` 单一实现 | 并入护栏第 2/3 组 |
| Q-30/B-9 验收无职责分离 | `acceptTask` 不校验验收人=发起人 | 发起人本人验收抛 `ForbiddenError`（403）；前端同步隐藏按钮并提示 | 护栏第 4 组 |

## 三、P1：契约与身份链（4 项）

| 缺陷 | 根因 | 修复 |
|---|---|---|
| Q-6/E-2/E-3 OBO 身份链断裂 | ①Agent 机器凭证默认 scope 缺 `agent.a2a.invoke`（OBO scope=人类∩凭证，交集为空）；②`act` 链在 a2a/uhp 无消费点；③`metadata.ybk_on_behalf_user` 不校验照单全收 | ①凭证默认 scope 补 `agent.a2a.invoke` + 存量幂等迁移；②RPC 入口解析令牌 act 链，真实发起人写入任务 `onBehalfUser/actChain`，经 dispatch 透传到 UHP 执行审计；③外部直调的 OBO 声明须校验 userId 存在且由令牌可代表（OBO 链/平台管理员/已绑定用户），否则不采信不入账 |
| Q-7/A-2/E-5 harness id 不可寻址 | `model=harness/<id>` 按 Agent 解析，发现面公布的 harness id 必然 404 | 寻址回落：Agent(id/slug) → configured harness 注册表反查绑定员工，并透传 `harnessRef` |
| Q-8/E-4 send/stream 不同构 | 同端点 `message/send` 返 JSON-RPC、`message/stream` 返裸 SSE | 两者统一返 JSON-RPC Task；流式进度由专用 SSE 端点承载（卡片已声明地址） |
| Q-10/D-1 rejected 任务 mode 失真 | 矩阵拒绝时 `createTaskRecord` 未透传 mode，兜底成 `single_turn` | 拒绝路径显式落 `mode: 'rejected'`，统计型消费方不再误计 |

## 四、P2：后端其余 12 项

| 缺陷 | 修复 |
|---|---|
| Q-20/D-3 幂等键两层不一致 | 计量落账键与执行派发键同形（含 attempt）`a2a:<agent>:<principal>:<task>:a<n>`；计量失败不再静默吞没，改落 warning 告警 |
| Q-21/D-8 contextId 被丢弃 | `createTaskRecord` 透传调用方指定协作链（`metadata.contextId`），同链多 Task 归集可由调用方构造 |
| Q-22/D-4 permit 覆盖空操作 | 已绑定数字员工身份但绑定/任用未生效 → `PERMIT_NOT_EFFECTIVE` 拒绝；从未纳管的 legacy Agent 不阻断 |
| Q-23/A-4 会话丢失上一轮回答 | `previous_response_id` 续接时继承 `session_id`（可靠归组键）并回填上一轮 assistant 回答 |
| Q-24/D-6 协作链 Top 排序退化 | 排序改 `tokens DESC, cost DESC, events DESC, lastAt DESC, contextId ASC`，零价口径下有确定序 |
| Q-25/D-7 取消留痕不可反查 | 执行审计 detail 带 `response=`，可按 id 反查 |
| Q-27/B-6 `/v1` 与 SSE 拒绝零留痕 | 自校验各失败分支补 `audit.authz.denied` + 任务绑定拒绝专项审计 |
| Q-28/A-5/B-7 SSE 错误码不规范 | 坏令牌/过期→401、越权→403、不存在→404，与 `/api` 域口径一致 |
| Q-31/E-6 卡片自描述不足 | 卡片补 `eventsUrl`、`securitySchemes.*.scopes`、协议扩展（版本/方法面/流式传输/发现端点/envelope）；well-known 改**规范裸体**（此前包在 `{ok,data}` 信封里外部解析器无法消费） |
| Q-32/E-7 计量双主体口径 | 卡片 governance 扩展增 `callerMeteringSubject`，声明发起侧与被调侧两个主体 |
| Q-26/A-3 治理码漏收 | 《协议键中文对照总表》新增 §3.4（6 条治理拒绝码）+ 完备性清点命令补 `code:` 形态 |
| Q-9/Q-18/C-3/C-8 产品数字漂移 | 加载屏权限点数纠正为后端真实值 92；`/api/platform/info` 插件清单改取实际装配树（此前写死 18 项）；**新增 selftest「产品数字与装配一致性」分节把加载屏三数与后端真实值绑定**——此前 84→85→94 连漂两次且无任何门禁 |

## 五、诚实边界（本次未做）

1. **卡片签名「强制验签」点仍不可黑盒证实（E-9）**：签名与验签基建真实存在（selftest 独立复验通过），但「平台内部消费方是否强制验签」需架构层决策后才有验证面；本批次未改。
2. **跨组织协作任务**：组织隔离以**被调方员工所属组织**为判定面；跨组织协作（A 组织员工派活给 B 组织员工）在发起侧按发起方可见范围校验调用权限，被调侧按 B 组织树判定治理可见性。
3. **A3 协商轮次的并发竞态、employee-bound 跨主体续接、真实慢模型下的取消时序**：仍属集成环境复测项（测试组已诚实登记为未覆盖）。
