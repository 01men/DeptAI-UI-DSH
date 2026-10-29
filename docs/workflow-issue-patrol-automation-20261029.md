# GitHub 反馈巡检自动化（工作流档案，2026-10-29 定版）

> 用户指示（2026-10-27 起常设，2026-10-29 固化为定时任务）：巡检 DeptAI-UI-DSH 仓库的用户
> 反馈 issue，有新反馈**直接修复**并**回复感谢**。本文是该工作流的仓库侧档案：调度定义、
> 判定规则、执行手册要点与本机工具事实。自动化定义本体在 ZCode automations
> （`automation-deb97fd6-fd1e-40fd-939a-3a0651e355c4`，每天 02:00），以自动化内 prompt 为
> 运行时权威，本文供人类与会话侧理解全貌。

## 调度与判定

- **节奏**：每天凌晨 02:00 自动执行一次；会话内人工任务仍沿用「先查反馈再干活」。
- **「新反馈」判定基准**：`docs/issue-triage-log.md` 台账——编号不在台账中的 open issue
  即为新反馈；台账标「跟进中」的项每次复查进展。
- **issue API 注意**：`GET /issues?state=open` 的响应含 PR（有 `pull_request` 字段），需过滤。

## 执行手册要点（自动化 prompt 摘录）

1. **缺陷报告**：在本仓修复，遵守 AGENTS.md 全部铁律（分支/底座面禁改/重建义务/selftest
   +lint 全绿/push 即交付）；关闭前做**可消费性核对**——确认修复对报告者所用安装形态
   （git main / npm registry）真正可用，未覆盖的如实说明并记「跟进中」。
2. **提问/咨询**：直接评论解答，确认解决后关闭。
3. **评论模板**：开头真诚感谢提交者（@用户名）→ 根因确认 → 修复方式（提交链接）→
   生效范围/安装建议 → 如何验证；中英双语。
4. **台账义务**：每处理一个 issue，把「编号|标题|提交者|类型|处理方式|凭据|日期」追加进
   `docs/issue-triage-log.md` 并随批次提交推送。
5. **禁项**：底座面（ybkkasi）侧问题不得在本仓硬修——登记
   `docs/handoff-*-to-main.md` 回流；本机 npm 未登录，**禁止尝试 npm publish**；
   令牌只进进程环境变量，严禁落盘/入库。

## 本机工具事实（2026-10-29 实测）

- gh CLI 未安装：一律 curl / Node fetch 调 GitHub REST API（api.github.com）。
- 网络：api.github.com 与 registry.npmjs.org 可直连；github.com git 端点偶发
  Connection reset（瞬时，重试即过）；本地代理 127.0.0.1:7890 可能未运行——
  策略＝先直连，失败再试代理，再退避重试直连。
- 评论/关闭 issue 的令牌来自 git 凭据管理器（`git credential fill`，username=01men）。
- 临时文件统一 `C:/Users/78110/AppData/Local/Temp/` 正斜杠路径（bash 的 /tmp 与
  Node 的路径解析不一致，混用会 ENOENT）。

## 批次记录（摘要，明细见台账）

| 日期 | 批次 | 结果 |
|---|---|---|
| 2026-10-29 | 首轮 + #1 收尾 | #1（装机解析）修复已于 10-27 交付（2447bce），本轮补感谢评论并关闭；建台账。遗留：npm registry 1.2.2 发版待 npm login（跟进中）。 |
| 2026-10-29 | #2–#7 批次分诊 | #5 探针分级、#6 SSE 透传、#7 计数口径标注——本仓修复并关闭；#2/#3/#4 根子在宿主侧，登记 [docs/handoff-panel-remote-contract-to-main.md](handoff-panel-remote-contract-to-main.md) 回流，issue 保持 open 跟进。 |
