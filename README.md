<div align="center">
  <img src="assets/readme/hero.svg" alt="01门（Gate 01）—— AI 代理与人类的协作前台。AI 会做事，管得住才算数。" width="100%">

  **简体中文** · [English](README.en.md) · [Agent 视图（llms.txt）](llms.txt)

  [![npm](https://img.shields.io/npm/v/@ybkk/gate-01?label=npm&color=1554e8)](https://www.npmjs.com/package/@ybkk/gate-01)
  [![license](https://img.shields.io/badge/license-MIT-07c160)](LICENSE)
  [![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.1.0--rc.7-1554e8)](docs/plan-gate01.md)
  [![selftest](https://img.shields.io/badge/selftest-1300%2B%20passing-07c160)](tests/selftest.mjs)

  ```bash
  dsh plugin add github:01men/DeptAI-UI-DSH
  ```
</div>

## 这是什么

**01门（Gate 01）** 是 AI 代理与人类的**协作前台**——把部门日常（看板、工单、审批、行业计算）
装进 dsh 的对话与面板界面：**Agent 在会话里干活，人通过面板看得见、管得住**。

- **一键装机**：cordis 插件形态，装进 dsh 即挂载 `/gate01`，打开 `/gate01/panel/` 即见内置演示看板；
- **前台立场**：通过既有契约调用元冰可治理底座 [01men/ybkkasi](https://github.com/01men/ybkkasi)
  的资产与权限（六类受管资产 ＋ IAM / OIDC SSO / RBAC / 场景级授权），前台不重复实现治理；
- **随时干净离场**：`dsh plugin remove` 卸载即净，重装即恢复。

> 产权归属 **杭州元冰可科技有限公司**（品牌口径：元冰可 / Yuanbingke）。定位决策：[docs/positioning-rq-dsh-panel-project-20261019.md](docs/positioning-rq-dsh-panel-project-20261019.md)。

## 核心能力

均为已实现功能，非规划。

- 🏢 **部门空间工作台** — 研发 / 制造 / 销售 / 战略 / 财务等空间看板：KPI 卡、工单流、审批留痕、事件实时回流（SSE）
- 🏭 **14 行业图谱包 + 行业主题引擎** — 工程机械、机器人、家电、新能源汽车、石化、锂电池、PCB、医疗装备、钢铁等，行业即插即用；未激活行业可只读预览
- 🧮 **制造业 AI 工具集** — 制造空间内置 13 计算内核 + 3 AI 工具 + 100 项选题（OEE、Cpk、节拍产能等一线工具）
- 💬 **会话执行卡** — 任务卡四态流转，对话与看板双向打通，Agent 干活进度即时可见
- 🔐 **钉钉设备流登录** — 面板代发起授权，未登录 / 未绑定自动弹出激活指令，一线零门槛
- 📡 **诚实降级** — 未连接底座或远端宿主能力缺口时，横幅如实提示，绝不静默失败

## 快速开始

```bash
dsh plugin add github:01men/DeptAI-UI-DSH
```

1. 打开 **`http://127.0.0.1:<dsh 端口>/gate01/panel/`** —— 内置演示看板，无需任何配置即可体验；
2. 连接治理底座后，全量数据经本机代理接入（浏览器零跨域），登录在底座侧完成；
3. 也可以走 npm 包 **`@ybkk/gate-01`** 或本地 `link:` / `file:` 通道安装（[四通道说明](docs/plan-gate01.md)）。

## 架构一览

<img src="assets/readme/architecture.svg" alt="架构：dsh 运行时内挂载 @ybkk/gate-01 六个预构建包（面板/执行卡/宿主桥/钉钉桥/基座/身份面），经既有契约调用元冰可治理底座的六类资产与身份权限" width="100%">

- **装在 dsh 里**：面板、执行卡随宿主启动，`/gate01` 单端口单入口，无独立部署面；
- **六包随附**：安装产物为预构建 dist——零 TS 装载、零安装期脚本，装完即用；
- **前台 × 底座**：数据面经宿主桥本机代理接入底座，浏览器零跨域；治理（身份/权限/计量/审计）全部由底座承担。

## 工程质量

- 🧪 **1300+ 项端到端自测全绿**（2026-10-29 实测 1367/1367；每次交付前全量回归 + 插件清单五面校验）
- 📦 **fresh-install 铁律** — 每次交付前在「全新安装的 dsh」上验证插件安装与完整体验（装机模拟含在自测内）
- 🚫 **零安装期执行** — 预构建 dist 产物，无生命周期脚本、无运行时编译
- 🧯 **fail-closed + 诚实降级** — 安全语义默认拒绝，能力缺口如实呈现，操作全程审计留痕
- 🤖 **Agent 友好** — [llms.txt](llms.txt) 提供机器可读视图；面板 REST（`/api/panel/*`）与 SSE 事件流对 Agent 同构开放

## 文档

| 文档 | 内容 |
|---|---|
| [产品定版](docs/plan-gate01.md) | 产品形态、装机不变量、四通道安装与边界 |
| [Agent 视图](llms.txt) | 供 LLM / Agent 速读的仓库事实卡（英文/中文摘要 + 端点与契约） |
| [企业部署与接入](docs/deploy-enterprise.md) | 部署 runbook 与底座接入指引 |
| [产品介绍单页](产品.html) | 面向决策者的单页（在线版：<http://mdzx.fun:8801/product.html>） |
| [治理底座](https://github.com/01men/ybkkasi) | 六类资产与身份权限面的提供者（另一个项目） |

## 反馈与获取

- 问题与建议走 GitHub Issues——仓库设有每日自动巡检，反馈会在 48 小时内得到分诊回应；
- 商业上按**「团队 + 领域资产」**定价，制造业客户可走私有化交付项目制；联系方式见[产品介绍单页](产品.html)。

## License

[MIT](LICENSE) © 杭州元冰可科技有限公司（Hangzhou Yuanbingke Technology Co., Ltd.）
