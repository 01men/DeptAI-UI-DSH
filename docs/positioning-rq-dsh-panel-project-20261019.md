# 项目定位决策记录：RQ-DSH 为独立项目（2026-10-19）

> 状态：**已生效**（本文件为决策凭据）
> 决策范围：`01men/RQ-DSH`（本项目）与 `01men/ybkkasi`（上游治理底座）的关系定位
> 前序决策：双轨开发模型（`docs/plan-dual-track-custom.md`，2026-09-08）、
> 「01门」产品定版（`docs/plan-gate01.md`，2026-09-10）、品牌更名（`docs/rebrand-yuanbingke-20261014.md`）

## 一、决策事实

**`01men/RQ-DSH` 与 `01men/ybkkasi` 是两个不同的项目。** 本项目不再是、也不被表述为后者的备份仓库。

| 项 | 结论 |
|---|---|
| 本项目定位 | **面向不同行业的部门交互面板项目**——把企业级 AI 能力以「部门交互面板」形态交付到各行业一线（交付物「01门」：AI 代理与人类的协作前台） |
| 与底座的关系 | **调用关系**：本项目通过既有契约调用上游治理底座（`01men/ybkkasi`）的**资产与权限**——六类受管资产（MCP/Skill/Agent/AI 应用/模型路由/NAS）+ 身份与权限面（IAM / OIDC SSO / RBAC / 场景级授权） |
| 不做的事 | 不重复实现治理底座；不做后者的备份仓、镜像仓或子集分支 |
| 行业化载体 | 14 行业图谱包（`packages/platform-core/scenegraphs/`：工程机械、机器人、家电、制糖、白酒、美妆日化、新能源汽车、石化、锂电池、印制板 PCB、智能移动终端、民爆、医疗装备、钢铁）+ 行业主题引擎 |
| 部门面板载体 | `plugin-panel-core`（部门工作台 REST + SPA + SSE）、`plugin-rq-card`（会话执行卡）、`plugin-dingtalk-bridge`（钉钉桥） |
| 调用面契约 | J1 面板技能/Agent 点名直调、J2 统一入口分诊、J3 会话直通、J4 用量报表；组织数据通道（`/api/iam/roster`、`/api/apps/:id/org-sync`） |

## 二、术语改写规则（全文消除矛盾表述）

| 旧表述 | 新表述 | 依据 |
|---|---|---|
| 备份仓库 / 备份推送仓库 | **本项目主仓**（交付仓） | RQ-DSH 是本项目自己的仓库，不是他人的备份 |
| 推送即备份 | **推送即交付** | 推送是本项目的发布动作，语义是交付而非备份 |
| 推送备份 / 推送备份前 | 推送交付 / 推送交付前 | 同上 |
| 定制轨 / 定制分支（指本项目时） | **面板轨 / 本项目**（对上游沿用「宿主轨 / 底座轨」） | 本项目不是上游的一个定制分支，是独立项目 |
| RQ-DSH 原有主分支…其 main 即本分支的完整备份 | （删除该表述） | 既非备份，该句失效 |

**保留不改**（属技术机制，与定位无关）：

- `origin fetch → ybkkasi`（只进不出）、`origin push → RQ-DSH`、`remote.origin.push` refspec；
- 铁律 1/2/4/5/6/7 的全部技术要求（唯一开发分支、上游 git 层面只读、合并方向唯一、
  冲突以主分支为准、合并全量回归、fresh-install 装机不变量）；
- 「交付未推送 = 未交付」的交付纪律（只改措辞：交付而非备份）。

## 三、落点（本次同步改写的文件）

| 面 | 文件 |
|---|---|
| 最高约束 | `AGENTS.md`、`PROJECT.md` |
| 对外口径 | `README.md`、`llms.txt` |
| 双轨计划 | `docs/plan-dual-track-custom.md` |
| 流程/发布 | `docs/release-gate01.md`、`docs/plan-gate01.md`、`docs/plan-dsh-plugin-first.md`、`docs/action-plan-dsh-frontend.md`、`docs/review-dsh-agent-panel-v2.md`、`docs/dev-plan-agent-host-unification.md` |
| 脚本与钩子 | `scripts/hooks/pre-push`（并重装 `.git/hooks/pre-push`）、`scripts/release.mjs`、`scripts/dist-build-id.mjs` |
| 历史记录 | `docs/rebrand-yuanbingke-20261014.md`（推送通道备注段的仓库称谓同步） |

历史性交付记录（`docs/handoff-*-to-main.md`、`docs/qa-evidence/*`、`docs/dev-log-*`、
`docs/release-notes-*`）保留当时的事实叙述；其正文中的「定制轨/定制分支/定制侧」按本表语义
读作「面板轨/本项目」，不回改。**冻结契约文档（`docs/contract-j1/j2/j3/j4-*.md`）不改**：
所有者为主分支侧、双侧同文（单侧改术语会与上游副本产生漂移，违背「契约双侧同步」纪律）；
其头部「宿主轨 main」按本表读作「底座轨 main」。

## 四、边界与不变项

- 本决策**不改动任何 git 机制**：远程配置（`AGENTS.md`「远程配置（已固化，不要改动）」）保持原样；
  pre-push 钩子对 ybkkasi 的硬拦截继续有效。
- 本项目对上游的依赖形态不变：`fetch → merge` 吸收上游演进；定制改进经
  `docs/handoff-*-to-main.md` 受控回流。**独立性体现在产品定位与交付物，不体现在切断技术依赖。**
- 上游仍为 API/事件契约所有者（`docs/plan-dual-track-host-main.md`）；本项目是契约消费方。