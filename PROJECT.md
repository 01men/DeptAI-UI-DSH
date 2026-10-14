# DSH-RQ 定制化项目说明

1. 本目录围绕仓库 https://github.com/01men/ybkkasi.git 开发定制分支 `custom/dsh-rq`，
   无需（也不得整分支）合并回主分支
2. 本工作区备份推送仓库：01men/RQ-DSH

## 产品定义：本分支唯一交付物 = 「01门」（2026-09-10 定版）

**01门——AI 代理与人类的协作前台**。定制分支（custom/dsh-rq）收缩为唯一产品：
cordis 插件形态一键装进 dsh（`dsh plugin add github:01men/RQ-DSH` / npm `@ybkk/gate-01` /
`link:` / `file:` 四通道），安装→启动→打开 `http://127.0.0.1:<端口>/gate01/panel/` 直接见到
内置演示看板；连接宿主后全量数据经本机代理接入（浏览器零跨域），登录在宿主侧完成；
`dsh plugin remove` 卸载干净、重装即恢复。安装产物为预构建 dist（零 TS 装载/零生命周期脚本）。

产品与实施定版：`docs/plan-gate01.md`；降级台账：`docs/gate01-degradation-ledger.md`；
cordis 可选依赖语义定稿：`docs/spike-cordis-optional-inject.md`。

## 双轨开发模型（2026-09 定版）

- **宿主轨**（上游 `ybkkasi` main）：宿主平台/控制台开发线——platform-core、console、
  authn/oidc、agent、portal、iam、usage、skillhub、nas-authz、dsh-bridge 宿主桥；API/事件契约所有者。
- **定制轨**（本分支 `custom/dsh-rq`）：dsh 前端交互插件/看板研发线——plugin-panel-core、
  plugin-rq-card、plugin-dingtalk-bridge、scenegraphs 业务数据；dsh 部署装配（生产物理真相）。
- 宿主面需求/缺陷一律去主分支做，定制分支通过 merge 吸收；定制→上游仅允许
  「交接清单文档」受控回流（`docs/handoff-*-to-main.md`）。
- 定版与路线：`docs/plan-dual-track-custom.md`（定制侧）/ `docs/plan-dual-track-host-main.md`（主分支侧）。

## ⛔ 仓库同步铁律（最高约束）

**新会话/新开发者第一步：读完根目录 [AGENTS.md](AGENTS.md)。**
铁律摘要（全文以 AGENTS.md 为准）：本仓库唯一开发分支 `custom/dsh-rq`；对上游只 fetch 不 push
（整分支回流 main = 最严重事故，pre-push 钩子已硬拦截；受控回流走交接清单）；RQ-DSH 是唯一
推送目标（push 即备份）；合并方向唯一（上游 main → 定制分支），冲突宿主面以主分支为准、
定制面必须保留；合并后 selftest 全绿才能推送备份；推送前跑北极星 diff 收敛检查（见 AGENTS.md）。

## 环境布局（初始化于 2026-09-02）

| 项 | 值 |
|---|---|
| 工作区 | `D:\DSH-RQ`（即本仓库检出根目录） |
| 源仓库（fetch/pull） | `https://github.com/01men/ybkkasi.git`（remote `origin` fetch） |
| 备份推送仓库（push） | `https://github.com/01men/RQ-DSH.git`（remote `origin` push，仅 `main` 一个分支） |
| 定制化子分支 | `custom/dsh-rq`（基于 `main` 创建，只在本分支开发，不合并回 `main`） |

远程配置方式（push 地址与 fetch 地址分离 + 默认推送目标映射到备份仓库 main）：

```bash
git remote set-url --push origin https://github.com/01men/RQ-DSH.git
git config remote.origin.push refs/heads/custom/dsh-rq:refs/heads/main
```

日常操作约定：

- 同步上游：`git pull origin main`（仅用于拉取上游更新，定制改动始终留在 `custom/dsh-rq`）
- 备份推送：直接 `git push`（自动把本地 `custom/dsh-rq` 推到 01men/RQ-DSH 的 `main`）
- RQ-DSH 原有主分支已于 2026-09-02 删除，其 `main` 即本分支的完整备份，无需合并回 ybkkasi

## 网络说明

本机访问 GitHub 需要走本地代理（`127.0.0.1:7890`），已配置 git 仅对 github.com 生效的代理，不影响其他 git 源：

```bash
git config --global http.https://github.com.proxy http://127.0.0.1:7890
```
