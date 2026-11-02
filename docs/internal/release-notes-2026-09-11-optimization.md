# 发布说明 · 2026-09-11 版本优化（M1-1 契约冻结 + 安全与数据治理加固）

> 版本：宿主轨 main ｜ 性质：**含契约变更（J1 新增面 + 行为加固），定制侧必须同步窗口对齐**
> 自审依据：`D:\DSH-07\docs-20260911-版本优化\`（市场调研 + 项目自审 + 迭代计划 v1.1）

## 一、契约冻结 v1 齐套（M1-1 出口）

- **J1 面板技能/Agent 点名直调**：main 落地同形实现并冻结 v1
  （[contract-j1-panel-invoke.md](contract-j1-panel-invoke.md)）——
  `GET /api/panel/:dept/skills`、`POST /api/panel/:dept/skills/invoke`（诚实降级：降级=200+ok:false，
  鉴权/范围=403/400）、工具 `panel_agent_invoke` / `panel_skill_invoke`。
  **定制侧对表项**：①invokeSkill 计量资源键由 `skill:<slug>` 改为 **`skill:<ID>`**（slug 含非 ASCII
  过不了 usage resource 校验）；②失败系统行 senderName 冻结为展示层不作契约（main 用「系统」）。
- **J2 统一入口分诊**：[contract-j2-entry-triage.md](contract-j2-entry-triage.md)
  （MGMT_MARKERS 四权限点 / 裸落地判定 / 偏好键 / 同源与跨源 next 白名单）。
- **J3 会话直通**：[contract-j3-session-passthrough.md](contract-j3-session-passthrough.md)
  （票据→rq_sid→会话兑换全链、端点面、TTL 缺省值、两端会话不互踢）。
- **J4 用量报表**：M0 出口已冻结（[contract-j4-usage-report.md](contract-j4-usage-report.md)），本次无变化。

## 二、新增端点与工具（契约变更登记）

| 变更 | 说明 |
|---|---|
| **新增** `GET /api/panel/:dept/skills`（`panel.read`） | 面板可直调技能清单（published + 组织可见性过滤） |
| **新增** `POST /api/panel/:dept/skills/invoke`（`panel.write`） | 技能点名直调；直调留痕（斜杠原文 + ⚡ 应答/失败系统行） |
| **新增** 工具 `panel_agent_invoke` / `panel_skill_invoke` | dsh ToolRuntime / REST 工具桥 / `/mcp` 三端同步暴露 |
| `POST /api/panel/:dept/messages` 的 sendMessage 输入扩展 | `senderType` 增 `agent`、新增 `senderIcon/agentName/replyModel/skipAgentDispatch`（additive，既有调用不受影响） |

权限点无新增（复用 `panel.read/panel.write`）；RBAC 端点矩阵对新端点自动覆盖。

## 三、行为加固（不新增契约面，行为变化登记）

1. **安全响应头（默认开启）**：全部 HTTP 响应追加
   `x-content-type-options: nosniff` · `x-frame-options: SAMEORIGIN` · `referrer-policy: strict-origin-when-cross-origin`。
   挂载形态 `/rq` 与 dsh web 同源，不影响同源内嵌；钉钉 H5 微应用为顶层 webview 不受影响。
   **一键关闭**：环境变量 `SECURITY_HEADERS=off`（对齐 PORTAL_SYNC 惯例）。
2. **usage 事件保留策略（默认开启）**：`usage_events` 此前无界增长——现默认保留 **730 天**
   （`USAGE_RETENTION_DAYS` 可调，0=永久保留）；启动 20s 后首跑 + 每 6h 巡检清理出窗事件，
   连带消费水位与对应死信。**语义**：事件被清理后同幂等键重报将按新事件重新入账（保留窗口即删除契约）；
   J4 月度报表窗口（近 13 个月）不受影响。运维手动巡检口：`POST /api/usage/retention/purge`
   （`usage.admin`，`body.days` 可临时收紧窗口，0=跳过）。
3. **invokeSkill 自动选模收紧**：自动选择只取「在线且已配 endpoint」的模型——无 endpoint 的模型
   调用必失败，不再被自动选中（显式指定不受限）。

## 四、文档与口径

- README：selftest 断言计数改为「数量以本次运行为准」（清除历史硬编码 700）；「后续路线」指向
  更新；新增四份契约文档与本次发布说明链接。
- 双轨基线：`rq-dual-track-work/docs/plan-dual-track-host-main.md` 的 M1-1 出口条件达成
  （J1-J4 契约 v1 齐套 + 发布说明成文 + selftest 断言固化）。

## 五、验收口径

- `npm run selftest` **997/997** 全绿（较上一版 +19：J1 契约分节 13 项、安全响应头 2 项、保留策略 5 项——数量以本次运行为准）。
- `npm run lint:manifests` **85/85** 通过；`npm run manifests` 重生成（panel-core api.yaml/tools、console api.yaml）。
- 冒烟：临时实例（基线初始化）实测安全头、保留巡检回显、skills 清单、直调诚实降级、工具面、频道留痕。

## 六、部署说明

- 双目标同步（`daily-sync-deploy.py`）：测试环境（mdzx.fun:8801 → Mac 7300）传完自动重启 + 健康检查；
  正式环境（192.168.0.7:7300）只传文件，**手动重启后**新行为生效。
- 环境变量新增（均可缺省，零配置升级）：`SECURITY_HEADERS`（缺省开）、`USAGE_RETENTION_DAYS`（缺省 730）。
