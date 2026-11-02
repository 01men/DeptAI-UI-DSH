# docs/internal — 内部过程物料

本目录存放**内部过程物料**：QA 报告、交接单（handoff）、重构基线、发布说明（release notes）、开发计划（dev plan）、评审记录、开发日志（dev log）与过程证据（evidence）。

这些文档**不构成对外契约**，其路径与内容不保证稳定，可能随时被移动、归档或删除。请勿在代码、配置或对外文档中引用本目录内的路径。

对外文档见 `docs/` 根目录与仓库根目录 `README.md`。

## 主要子类一览

| 类别 | 说明 |
| --- | --- |
| `qa-report-*.md` | 各批次 QA 测试报告（安全 / 计量 / 编排 / 市场 / 总览等） |
| `handoff-*.md` | 阶段性工作交接单与修复采纳记录 |
| `release-notes-*.md` | 内部发布说明与版本变更记录 |
| `dev-plan*.md` | 各专项开发计划（连接器、NAS、App SSO、接入加固等） |
| `dev-log-connector/`、`dev-log-nas-authz/` | 专项开发日志与架构评审记录 |
| `重构基线-*.md`、`重构方案-*.md` | 重构各阶段基线与方案对照 |
| `ecosystem-design*.md`、`roadmap*.md` | 生态设计与路线图的历史版本 |
| `evidence/` | 过程验证证据（探针结果、测试输出等） |
| 其余（review-*、spike-*、trial-plan-*、设计评审-* 等） | 专项评审、技术调研与试点计划 |
