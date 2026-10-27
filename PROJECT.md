# DSH-RQ 项目说明（01men/DeptAI-UI-DSH）

1. **本项目 = `01men/DeptAI-UI-DSH`（工作区 `D:\DSH-RQ`，开发分支 `custom/dsh-rq`）**：面向不同行业的
   **部门交互面板项目**——把企业级 AI 能力以「部门交互面板」形态交付到各行业一线。
2. **与上游 `01men/ybkkasi` 是两个不同的项目**：本项目是**调用方**，通过既有契约调用底座的
   **资产与权限**（六类受管资产 + IAM/OIDC SSO/RBAC/场景级授权）；**不是它的备份仓库**，
   也不重复实现治理底座。定位决策见 `docs/positioning-rq-dsh-panel-project-20261019.md`。
3. 本项目主仓（交付仓）：`01men/DeptAI-UI-DSH`——推送即交付。

## 产品定义：本项目唯一交付物 = 「01门」（2026-09-10 定版）

**01门——AI 代理与人类的协作前台**，也是本项目「部门交互面板」主张的交付载体。本分支（custom/dsh-rq）收缩为唯一产品：
cordis 插件形态一键装进 dsh（`dsh plugin add github:01men/DeptAI-UI-DSH` / npm `@ybkk/gate-01` /
`link:` / `file:` 四通道），安装→启动→打开 `http://127.0.0.1:<端口>/gate01/panel/` 直接见到
内置演示看板；连接底座后全量数据经本机代理接入（浏览器零跨域），登录在底座侧完成；
`dsh plugin remove` 卸载干净、重装即恢复。安装产物为预构建 dist（零 TS 装载/零生命周期脚本）。

**行业化载体**：14 行业图谱包（`packages/platform-core/scenegraphs/`——工程机械、机器人、家电、
制糖、白酒、美妆日化、新能源汽车、石化、锂电池、印制板 PCB、智能移动终端、民爆、医疗装备、钢铁）
+ 行业主题引擎 + 未激活行业只读演示预览；部门面板面为 plugin-panel-core / plugin-rq-card /
plugin-dingtalk-bridge。

产品与实施定版：`docs/plan-gate01.md`；降级台账：`docs/gate01-degradation-ledger.md`；
cordis 可选依赖语义定稿：`docs/spike-cordis-optional-inject.md`。

## 双轨协作模型（2026-09 定版）

**独立项目不等于切断技术依赖**：本项目交付形态建立在底座契约之上，故仍按两轨协作。

- **底座轨**（上游 `ybkkasi` main）：治理底座/控制台开发线——platform-core、console、
  authn/oidc、agent、portal、iam、usage、skillhub、nas-authz、dsh-bridge 宿主桥；
  六类资产与身份权限面提供者、API/事件契约所有者。
- **面板轨**（本分支 `custom/dsh-rq`，本项目主仓）：部门交互面板研发线——plugin-panel-core、
  plugin-rq-card、plugin-dingtalk-bridge、scenegraphs 业务数据；dsh 部署装配（生产物理真相）。
- 底座面需求/缺陷一律去主分支做，本项目通过 merge 吸收；本项目→上游仅允许
  「交接清单文档」受控回流（`docs/handoff-*-to-main.md`）。
- 定版与路线：`docs/plan-dual-track-custom.md`（本项目侧）/ `docs/plan-dual-track-host-main.md`（主分支侧）。

## ⛔ 仓库同步铁律（最高约束）

**新会话/新开发者第一步：读完根目录 [AGENTS.md](AGENTS.md)。**
铁律摘要（全文以 AGENTS.md 为准）：本仓库唯一开发分支 `custom/dsh-rq`；对上游只 fetch 不 push
（整分支回流 main = 最严重事故，pre-push 钩子已硬拦截；受控回流走交接清单）；DeptAI-UI-DSH 是本项目主仓
（推送即交付，交付未推送 = 未交付）；合并方向唯一（上游 main → 本分支），冲突底座面以主分支为准、
面板面必须保留；合并后 selftest 全绿才能推送交付；推送前跑北极星 diff 收敛检查（见 AGENTS.md）。

## 环境布局（初始化于 2026-09-02）

| 项 | 值 |
|---|---|
| 工作区 | `D:\DSH-RQ`（即本仓库检出根目录） |
| 本项目主仓（交付仓） | `https://github.com/01men/DeptAI-UI-DSH.git`（remote `origin` push，仅 `main` 一个分支） |
| 上游底座（fetch/pull，只进不出） | `https://github.com/01men/ybkkasi.git`（remote `origin` fetch） |
| 开发分支 | `custom/dsh-rq`（基于 `main` 创建，只在本分支开发，不合并回上游 `main`） |

远程配置方式（push 地址与 fetch 地址分离 + 默认推送目标映射到本项目主仓 main）：

```bash
git remote set-url --push origin https://github.com/01men/DeptAI-UI-DSH.git
git config remote.origin.push refs/heads/custom/dsh-rq:refs/heads/main
```

日常操作约定：

- 同步上游：`git pull origin main`（仅用于拉取上游更新，本项目改动始终留在 `custom/dsh-rq`）
- 交付推送：直接 `git push`（自动把本地 `custom/dsh-rq` 推到 01men/DeptAI-UI-DSH 的 `main`）
- DeptAI-UI-DSH 原有主分支已于 2026-09-02 删除，其 `main` 即本项目 `custom/dsh-rq` 的交付线

## 网络说明

本机访问 GitHub 需要走本地代理（`127.0.0.1:7890`），已配置 git 仅对 github.com 生效的代理，不影响其他 git 源：

```bash
git config --global http.https://github.com.proxy http://127.0.0.1:7890
```
