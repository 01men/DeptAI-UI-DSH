# Handoff：面板 remote 契约缺口回流宿主主分支（2026-10-29）

> 依据铁律 2，本项目→上游唯一通道是本清单。由 2026-10-29 issue 批次分诊触发（#2/#3/#4），
> 报告方为「元冰可 · 组织建设」自动化（只报不修，证据充分、可复现）。
> 三项缺口共同点：**根子都在宿主（01men/ybkkasi）侧**，前台（本项目）侧无法单方面根治。
> 主分支侧采纳方式：cherry-pick / 按本文重放实现。

## 背景（复现环境）

- 前台：`@ybkk/gate-01` @ DeptAI-UI-DSH `14e17ce`，装进 DSH web profile；
- 宿主：`01men/ybkkasi` 1.5.0 @ `2e9ce71`，独立宿主 7300；
- 连接：01门 宿主连接 `mode=remote` → 宿主，面板 REST 经 `/gate01/rqcard/proxy/*` 转发。

## H-1（issue #2）：23 条面板路由宿主侧缺失，remote 模式 404

gate-01 的 plugin-panel-core 注册 49 条 `/api/panel/*` 路由，ybkkasi 1.5.0 仅有 36 条。
remote 模式下战略看板、制造工具箱、钉钉协作、Agent 流式对话、面板登录五大面全部 404。

**宿主侧待补路由（01门有 / 1.5.0 无）**：

| 类别 | 路由 |
|---|---|
| 战略看板（1） | `GET /api/panel/board` |
| 制造工具箱（10） | `GET /api/panel/mfg/catalog`、`GET /api/panel/mfg/roadmap`、`GET /api/panel/mfg/releases`、`GET /api/panel/mfg/evaluation-plan`、`GET /api/panel/mfg/tools/:id/template`、`POST /api/panel/mfg/tools/:id/run`、`POST /api/panel/mfg/tools/:id/export`、`POST /api/panel/mfg/evaluate`、`POST /api/panel/mfg/releases`、`DELETE /api/panel/mfg/releases/:skillId` |
| 钉钉桥（8） | `GET/POST/DELETE /api/panel/ddws/login`、`GET /api/panel/ddws/status`、`POST /api/panel/ddws/install`、`POST /api/panel/ddws/test`、`POST /api/panel/ddws/pull`、`PUT/DELETE /api/panel/ddws/bind` |
| 人机对话（1） | `POST /api/panel/:dept/agent-stream` |
| 面板登录（2+） | `POST /api/panel/auth/login`、`POST /api/panel/auth/refresh`（及 panel-auth 族） |

**建议实现方式**：宿主 `/api/health` 暴露 `panelContractVersion`（或能力清单），前台据此做
能力探测与显式降级提示（「宿主缺少 X，请升级宿主」），替代静默 404；跨仓以同一份
`plugin-panel-core` 路由清单做契约测试（前台路由 ⊆ 宿主路由）。

## H-2（issue #3）：面板任务 schema 增补血缘字段（additive）

底座 `exec:issues` 已有 `goalAncestry[]`/`blockerIds[]`（报告方复核确认），缺的是面板投影：
`panel:tasks` 仅 `createdAt,updatedAt,id,dept,title,detail,lane,assigneeType,createdBy`。

**宿主侧待补**：`panel:tasks` schema additive 增 `execIssueId`、`goalId`、`parentIds[]`、
`evidenceRefs[]`、`verdict`、`reworkOf`；面板 lane 迁移与 exec issue 状态建立回写关系
（或明确「面板 = 执行中枢投影」的 reconciliation 语义）。

## H-3（issue #4）：治理域只读/动作端点经面板代理放行

OrgLoop 闭环要求前台呈现 Goal/血缘/验收结论并支持签认/返工/人工接管。底座已有
`/api/exec/goals`、`/api/exec/issues`（含 goalAncestry），但面板代理白名单只放行
`/api/panel/*` 与 auth 族，治理域一律 `403 PROXY_PATH_DENIED`。

**宿主侧待补（配合前台 H-2/前台目标页）**：面板命名空间下的 goals 只读投影端点
（如 `GET /api/panel/:dept/goals`，读透 exec-hub 含 metric/outcome），或与前台共同评估
代理白名单受控放行 `/api/exec/*` 只读子集的契约。

## 前台侧已办 / 待办对照

- 已办（本仓库，2026-10-29 批次）：#5 探针分级、#6 SSE 透传、#7 计数口径标注——前台自身可根治项全部修复。
- 已办（H-1 前台半，2026-10-29 追加 `4e2ad3f`）：**运行期能力缺口诚实降级**——api.js 中央收口在 remote 形态检测到 `/api/panel/*` 404 时广播 `panel:host-missing-route`，面板顶部渲染可关闭横幅（列出缺失路由与本文去向，升级宿主后自动恢复）。宿主侧落地 H-1 后横幅自然消失，无需前台再改。
- 待办（前台，依赖 H-1~H-3）：任务卡血缘渲染、目标页、签认/返工/接管交互。
