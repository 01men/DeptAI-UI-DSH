# C1 一线面板极简 · QA 缺陷终版回归报告（2026-09-09）

> 计划依据：《元冰可开发计划-子分支-RQ-DSH.md》C1-5——C1-1~C1-4 全部落地后对 qa-evidence
> 基线（docs/qa-acceptance-dsh-plugin-first.md，2026-09-08）做一次性全量复测。
> 批次：本报告随 C1 第一波交付提交（C1-1 信息架构收敛 + C1-2 技能直调）。
> 自动化基线：**selftest 1071/1071 全绿（1056 → 1071，C1 新增 15 项断言）+ lint:manifests 85/85 绿**。

---

## 1. 结论速览

| 出口项 | 状态 | 证据 |
|---|---|---|
| P0 = 0 | ✅ | 唯一 P0（SSE 实时通道缺部门范围校验，BUG-A-01/T-01）已在 a774bff 修复、H4 stream-ticket 同规化（527099e 移植快照）复核；selftest SSE 段断言「握手即断」双通道在册 |
| P1 = 0（修复闭环） | ✅ | 见 §2 逐项复测台账：3 项实测 P1 + 代码审查 P1（H2/H3/T-02/T-05/T-06/SEC-05/G-01）全部有修复提交 + 回归断言 |
| C1-1~C1-4 落地 | ✅ | 见 §3；本批交付 C1-1（信息架构收敛）+ C1-2（技能直调 + 执行卡），C1-3/C1-4 此前批次已落地并复核 |
| 自动化基线全绿 | ✅ | selftest 1071/1071 + lint:manifests 85/85（本批实际跑测输出） |
| 现场门禁（无法本环境执行） | ⏳ | 3 名真实班组长不看文档 5 分钟完成图纸问答（上手实测）+ 钉钉 H5 真机走查——见 §5 遗留清单 |

---

## 2. P1 全量复测台账（计划 C1-5 点名四项 + 代码审查 P1）

### 2.1 计划点名的四项

| 项 | 缺陷原始记录 | 修复 | 本次复测结论 |
|---|---|---|---|
| 钉钉投递去重 | 钉钉失败投递毒化去重键（uniqueKey 桥接唯一索引被失败占用，重投永拒）；同步钉钉零反馈（T-04） | a774bff：唯一索引改 `channelId:uniqueKey` 语义 + 桥接回执事件回写 ddSync 状态 | ✅ 复测通过。selftest 桥接段断言：投递成功回执 `sent`、失败回执 `failed` 且重投可达；面板消息不再永久 pending。`GET /api/panel/:dept/messages` 回包含 ddSync 三态（本批技能直调留痕复用同一消息面） |
| rq-card 装载器兜底 | rq-card 浏览器半在真实 dsh web 静默未挂载（BUG-G-01/H1：probeSpec 探测 `specDynamic` 恒 undefined，五处 probe 必然全数落空） | bcd7a28：五处槽注册改无条件 `slots.inject`（纪元机制容忍属主后到）+ `__RQ_CARD_DIAG__` 注入半台账（inject-pending/materialized/kind-mismatch）+ DOM 兜底角标 + bundle 重建 | ✅ 复测通过。selftest「rq-card bundle 真执行」段（vm + mock rc.7 注入面）：挂起→声明落地→全注册 + 台账断言全绿；kind 失配不外逃。装机铁律从「解析」升级到「执行」 |
| 轮询静默 | realtime.js 轮询失败静默（BUG-U-02）：断网时面板仍标 LIVE | 37880a2（main H2）：realtime 补 onPollError/health 契约；面板徽标三态（LIVE / 30s 轮询 / 连接中断·点击重试）+ 定制 95s 看门狗并集 | ✅ 复测通过。selftest realtime 单测 4/4（onPollError 阈值触发、health 投影、自愈恢复）+ 面板 SSE 段 |
| 多标签互踩 | authn refresh token rotation 多标签互踩（T-08）：后到标签把先到标签的会话顶失效 | 37880a2（main H3）：refresh 轮换 30s/10 次宽限窗口，窗口外重放防线不变 | ✅ 复测通过。selftest authn 段断言宽限窗口内旧 token 可换新、超窗重放 401 |

### 2.2 代码审查 P1（同批闭环确认）

| 项 | 结论 |
|---|---|
| T-02 代理 3xx 透传 location 头 | edd3d21 修复；stub-host 台架对抗样本在册 |
| T-05 messages limit 收敛 [1,200] | a774bff 修复；本批技能直调路由沿用同一 10k 正文上限口径 |
| T-06 消息正文 10k 上限 | 同上 |
| SEC-05 初始口令一次性消费 unlinkSync | a774bff 修复（Windows 实测语义） |
| G-01 可诊断面 | `__RQ_CARD_DIAG__` 三态台账 + 两类兜底角标（见 2.1 rq-card 行） |
| G1 回跳消费侧 | edd3d21：boot 按连接形态经代理兑换宿主票据（query/fragment 双形态、即用即清）+ probeHub 严格判据；selftest G1 段 8 项断言全绿 |

### 2.3 P0 复测细节（出口红线）

SSE 部门范围校验（P0 唯一项）双通道同规复核：

- stream-ticket 签发（POST /api/panel/stream-ticket）与 stream 握手（GET /api/panel/stream）均执行 `deptScopeAllowed`，未通过即握手期断流，绝不先订阅（527099e 合并纪要 + selftest SSE 段）；
- `?token=` 过渡通道消费侧同样走 verify + deptScope 校验（H4 同规化移植 BUG-A-01 快照）；
- 组织受限用户实测口径（T-01 断言）：受限 403 断流 / 组织内正常 / 未知部门 404——selftest RBAC 断言网 100% 端点枚举覆盖（H5 声明网：`/api/panel/:dept/skills`、`/api/panel/:dept/skills/invoke` 两条新路由经 guarded() 自动入网，注册期缺声明即抛）。

---

## 3. C1-1~C1-4 交付与复测（本批 + 前批）

### C1-1 /panel 信息架构收敛（本批交付）

- **进入即对话框**：boot 固定落 chat Tab（不再恢复上次 Tab）；默认形态为 AI 助手对话（内嵌 dsh 标准对话，可退回内置协作会话）。
- **看板/设置收二级入口**：顶栏「工作台 | 战略看板」双视图 tabs 拆除，改「☰ 更多」菜单（战略看板 / 面板设置[限 panel.config.write] / 模型管理）；`#/board` 深链保留。
- **无内部术语**：用户可见文案清除「dsh 标准对话 / 默认 Agent 交互面」等内部用语，改一线语言（AI 助手对话 / 数字同事 / 技能直调）；代码注释保持开发语汇。
- **首启向导 ≤ 3 步**：向导为单屏双路径（本机当工作台 / 连已有服务器），每条路径 ≤ 2 步（连接 + 登录），维持既有交付。
- selftest 静态断言：`tab: 'chat'` 固定落对话、moreMenu 在场、view-tab 引用归零。

### C1-2 执行卡 + Skill 点名直调（本批交付）

- **服务原语**（J1 消费面，`PanelService.invokeSkill`）：skillhub published 且组织可见技能 → 当前版本 SKILL.md 内容组装系统提示 → 模型网关单轮；失败诚实 `ok:false + reason`（不存在/未开放/无内容/无在线模型/网关失败），不造假回复。清单与直调同一可见性口径（visibility=orgs 按调用人组织过滤，fail-closed）。
- **HTTP 面**：`GET /api/panel/:dept/skills`（清单）+ `POST /api/panel/:dept/skills/invoke`（直调；降级是数据不是传输错误——可预判失败 HTTP 200 + ok:false；鉴权/部门范围仍 403/400）。留痕：斜杠原文 human 消息（skipAgentDispatch：不重复触发 @Agent）→ 成功落 `⚡ 技能名` agent 型应答消息 / 失败落系统行，全频道可见可回查。
- **工具面**：`panel_skill_invoke` dsh 工具注册（与 `panel_agent_invoke` 并排），dsh 标准对话里的 Agent 亦可点名技能。
- **前端**：composer 技能 chips（@唤起行下方）+ `/技能名` 斜杠解析 + 内嵌形态「⚡ 选技能直调」下拉（选中转内置会话并预填）+ ⌘K 技能源；执行卡调用中（转圈）/异常阻断（红卡原因 + ↻重试）两态本地瞬时渲染，结果一律以持久化消息为准。
- **验收口径「面板内成功调用 ≥ 3 个已上架 Skill」**：selftest 种子 3 个 published 技能逐一直调 ok:true（stub 模型应答 + agent 消息落频道）+ 未知技能/组织不可见技能诚实拒绝 + 失败系统行落库，14 项断言全绿。
- rq-card 执行卡四态（calling/executing/done/blocked）维持 bcd7a28 交付不变（本批零改动，bundle 无需重建）。

### C1-3 部门范围权限裁剪（前批已落地，本次复核）

- `/api/panel/:dept/*` 全路由经 `deptOf`（部门标识正则 + deptScopeAllowed，未通过 403 + audit 留痕）；SSE 双通道同规（见 §2.3）；名册最小 PII 组织子树裁剪；前端无权限部门置灰上锁 + toast。
- 战略看板 `/api/panel/board` 为平台聚合面（非 Agent/频道/文件部门数据面），本批随 C1-1 收进「更多」二级入口（经理视角文案标注）；其访问控制维持 panel.read 口径不变，未构成 C1-3 验收口径（部门 Agent/频道/文件）内的越权面。

### C1-4 移动端与易用性（前批已落地，本次复核）

- 375px 钉钉 webview：700px 断点顶栏收敛（本批 view-tabs 拆除后顶栏元素进一步减少，「更多」按钮在窄屏压缩规则内）；1180/980px 抽屉化。
- 触控热区：核心操作 ≥36px（本批新增 more-btn ≥32px、more-opt/min 36px、执行卡重试钮 ≥36px 同规）。
- 崩溃页友好化：boot 异常 →「工作台暂时没有加载起来」+ 重载 + 折叠技术详情（BUG-U-10）；实时徽标三态；rq-card 兜底角标。
- 真机走查（钉钉 H5 实机）无法在本环境执行——列 §5 遗留。

---

## 4. 自动化证据

```
npm run selftest
  自测结果：1071/1071 通过
  （C1 新增 15 项：技能直调运行时断言 13 项 + C1-1/C1-2 前端接线静态断言 2 项）

npm run lint:manifests
  清单校验：85/85 通过；卡片包：5/5 通过；场景图谱：2/2 通过
```

北极星收敛检查（提交前执行）：`git diff 37880a2 custom/dsh-rq -- <宿主面路径清单>` 输出仅含
F 域余量登记项（docs/handoff-f-remainder-to-main.md），本批零宿主面改动。

---

## 5. 遗留清单（现场门禁项，本环境不可执行）

| 项 | 依赖 | 去向 |
|---|---|---|
| 3 名真实一线班组长「不看文档 5 分钟完成一次图纸问答」上手实测 | 真实用户 | C1 出口门禁，随 C3-1 标杆现场执行；建议以测试环境（mdzx.fun:8801）先行 |
| 钉钉 H5 真机走查（375px 顶栏/触控/向导全链） | 钉钉客户端实机 | C1-4 验收标准项，部署测试环境后走查 |
| `?token=` 旧通道 fail-closed 收口（H4 配合项，宿主侧决策） | main 侧 | 已在回执文档（handoff-qa-fixes-custom-followup-20260909.md）建议 main 安排 |
| C2-1/C2-2（分诊落地验证 / 会话直通复测） | 主分支 M1-4/M1-5（J2/J3 冻结） | 第二波；当前上游 main 无新增提交，契约未冻结，定制侧接收条件已就绪（boot 票据兑换 + probeHub 严格判据已交付） |
