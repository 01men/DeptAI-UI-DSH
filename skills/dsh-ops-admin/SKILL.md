# Skill: dsh-ops-admin（平台总控）

## 何时使用
管理员/运维 Agent 需要对「企业 AI 资源管理平台」执行任何运维操作时，先读本索引找到对应的领域 Skill，再按其操作手册执行。典型场景：监控告警处理、资源上下线、审批处理、异常排查、成本分析。

## 调用方式（工具优先）
平台插件安装进 dsh 后，运维能力已注册为 dsh 工具（iam_* / authn_* / mcp_* / skill_* / agent_* / app_* / usage_* / audit_* / market_* / billing_* / connect_* / update_*）。
**任何现状问题（查询/盘点/健康/成本）先直接调用对应工具获取真实数据，禁止凭记忆回答。**
工具不可用（独立部署且插件未挂载）时才走 CLI 备选：`DSHCTL_TOKEN`（或 `DSHCTL_USER/DSHCTL_PASS`）+ `node examples/dshctl.mjs <resource> <action>`（输出可 `--output json`）。

## 领域 Skill 索引
| 领域 Skill | 覆盖范围 | 关键命令前缀 |
|---|---|---|
| dsh-ops-iam | 组织/账号/角色/用户组/三方同步/冲突 | `dshctl org` `dshctl user` `dshctl sync` `dshctl conflict` |
| dsh-ops-authn | 机器凭证/令牌签发吊销/密钥轮换 | `dshctl token` `dshctl credential` |
| dsh-ops-mcp | MCP 部署/灰度/回滚/网关调用/监控 | `dshctl mcp` |
| dsh-ops-skillhub | Skill 提交/审批/上架/安装/弃用 | `dshctl skill` |
| dsh-ops-agent | Agent 注册/绑定/上下线/指标 | `dshctl agent` |
| dsh-ops-app | AI 应用/拓扑/成本穿透 | `dshctl app` |
| dsh-ops-audit | 审计日志/告警/审批中心/成本 | `dshctl audit` `dshctl approval` `dshctl cost` |
| （平台接入） | 远程 dsh 接入码/已接入客户端管理 | `dshctl connect` |
| （平台更新） | 上游版本检查/一键升级/自动检查偏好 | `dshctl update` |

## 平台更新（版本检查 / 一键升级）
- 检查上游：`update_check`（60s 冷却）或 `update_status`；发现新版本会自动广播事件并留审计记录。
- 升级（仅 source 安装形态）：先 `update_apply { dryRun: true }` 预演，向使用者确认后
  `update_apply { reason: "<升级原因>" }`（git pull --ff-only + npm install），**完成后提醒使用者重启平台进程**；
  本地有未提交修改会安全失败，请使用者人工处理后再试。
- bundle 安装形态：工具会返回宿主侧指引（`dsh plugin update github:01men/DeptAI-UI-DSH`），按指引转述即可。
- 升级是管理员权限（platform.update.apply）；检查/查看为 platform.update.read。

## 远程 dsh 接入（本机未配置宿主时第一步）
- 工具执行报「尚未配置宿主服务」或 `connect_status` 显示未接入时：请使用者提供宿主地址与管理员签发的一次性接入码（`enr_` 开头），
  调用 `connect_setup { hubUrl, enrollmentCode }` 自动申请机器凭证并切换为远程执行；或引导使用者打开本机配置页 `http://127.0.0.1:7390` 填写。
- 已有机器凭证（`mc-`/`cs_` 开头）时用 `connect_login { hubUrl, clientId, clientSecret }`。
- 接入/更新/断开后用 `connect_status` 或 `connect_test` 验证。接入码一次性消费且默认 15 分钟过期，失败时请管理员重新签发。

## 通用运维闭环（方法论）
1. **诊断**：`dshctl audit alerts --unread` + `dshctl mcp list` 定位异常
2. **取证**：`dshctl audit logs --resourceId=<id>` 回溯操作链
3. **预演**：变更命令带 `--dry-run` 查看影响面
4. **执行**：L4 高危操作生成审批单（`--reason` 必填），有审批权限者单人通过即自动执行
5. **验证**：`dshctl <resource> get <id>` 确认终态 + 审计回写

## 护栏（全局）
- offline / freeze / revoke / deprecate 必须给出 `--reason`，原因永久留痕
- L4 操作（下线/吊销/删除/批量>10）一律走审批单，发起人与审批人不得为同一人
- 批量操作超过 10 个对象需二次确认
- 一切只读命令（list/get/metrics/logs）可放心执行

## 帮助
`dshctl help` 查看全部命令与全局选项。
