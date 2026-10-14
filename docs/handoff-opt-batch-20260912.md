# 交接清单：优化执行方案攻坚批次（OPT-P0 ~ P3，2026-09-12）

> 依据《元冰可 ybkkasi 优化执行方案》完成攻坚落地。本文为下一班次的交接事实源。
> 提交序列：`bc2e429`(P0) → `a003283`(P1-02) → `f2568a8`(P1-03) → `8908a99`(P1-04) →
> `23a0a66`(P1-05+P3-02) → `9b326ec`(P2-04) → `c8fc22e`(P2-03+P2-02) → `bd381c7`(P2-01) →
> `616e83d`(P3-01+P3-03) → 本批（P1-01 首段）。

## 一、完成度总览（对照方案任务卡）

| 任务 | 状态 | 关键交付 | 验收口径核对 |
|---|---|---|---|
| P0-01 契约↔实现双向 lint | ✅ | `scripts/contract-lint.mjs` 引擎 + 豁免清单 + 构造性测试 16 例 | 增删路由/幽灵 endpoint 红/绿测试通过；真仓 0 红 |
| P0-02 billing 漂移清零 | ✅ | depends/叙述/precheckCents/归档/注释 五类清零 | `grep viaApprovalExecutor` 口径同法可查；legacy 字段保留有注释 |
| P1-01 拆 console | 🟡 首段 | `routes/market.ts`（11 路由+2 公开端点）迁出；index 4516→4373 行 | apply()≤300 未达（见四、销账计划） |
| P1-02 能力令牌 | ✅ | 模块闭包金库（一次性+绑定+TTL）；旧布尔全仓 0 命中 | selftest 走私/伪造断言绿 |
| P1-03 connect 契约化 | ✅ | `tools.intercept/decorate` 正式扩展点；降级 fail-closed + `connect.degraded` | `Symbol.for('cordis.original')\|proto[` 命中 0 |
| P1-04 总线对齐 usage | ✅ | journal 持久化/异步串行/5s 超时/3 次退避/死信/重投/异常落审计 | 130 处 emit 调用点零回归；单测 6 例 |
| P1-05 TOCTOU 收紧 | ✅ | 快照哈希执行侧校验 + 镜像失败不静默（吊销+fail-closed+告警） | 5 处 `catch(()=>undefined)` 清零；时序断言 5 例 |
| P2-01 ODD | ✅ | odd 声明块 + inOdd 纯函数 + `connector.odd_exit` | 单测 13 例 + e2e 4 断言 |
| P2-02 审批卫生/规则源/补偿 | ✅ | 敏感面下沉 platform-core；reject/mask 双策略；补偿注册表 | 单测 9 例 + e2e；共享故障域声明入库 |
| P2-03 update pin/签名/回滚 | ✅ | pin 强制 + verify-commit（策略开关）+ HEAD 快照 + rollback 路由 | 3 断言（缺 pin/无快照/dryRun 口径） |
| P2-04 三家五面清单 + schema 强校验 | ✅ | market/modelgw/usage 进生成器；output.schema 非空对象根强制 | 清单 105/105；工具 83/83 |
| P3-01 P95 闸门 + 故障注入 | ✅ | 4 类故障注入 + P95 阈值键（P95_GATE_*）+ 分布输出 | 实测登录 P95=133ms / invoke=16ms |
| P3-02 定时器治理 | ✅ | 13 处构造期定时器全 unref + `lint-timers.mjs` 卫生扫描（违规即红） | 扫描 13/13 合规 |
| P3-03 A0–A3 评审 | ✅ 仅文档 | `docs/a0-a3-autonomy-ladder-review.md`（模型/不变式/证据工件/触发条件） | 按方案不编码，评审通过 |

## 二、质量闸门现状

- **selftest**：1090 → 1105+ 断言全绿（P0 批次起逐层净增，含 5 个随包单测文件接入 spawn 断言）。
- **lint:manifests**：清单 105/105 解析；契约比对 路由 代码351/清单367、工具 83/83、**0 红**；
  定时器卫生 13/13；**9 警 8 豁免**（见下）。
- **新 CI**：`.github/workflows/selftest.yml`（lint + selftest + P95 阈值键入环境）。

警告口径（非阻塞，均登记）：
- `manifest_missing`×3：platform-core（内核库）、plugin-dsh-bridge、plugin-rq-card（宿主特殊形态）。
- `perm_unused` 若干：预留权限点（agent.approve 等），升级 A0-A3 时启用。
- `public_path_undeclared`×2：/api/panel/auth/login|refresh（先行登记，路由未合入，F 清单 N 节）。
- 豁免×8：portal 单 handler 前缀分发（`scripts/contract-lint.exemptions.json`，附销账条件：
  portal 改逐路由 http.register 后移除）。

## 三、后续班次销账计划（按优先级）

1. **P1-01 余段**（方案允诺"每迁一段、绿一次"）：首段已立 `routes/` 模式 + deps 注入接口
   （`ConsoleRouteDeps`）。余段建议顺序：nas（~480 行，含 downloadTickets 私有态随迁）→
   connector（~330 行，含 runWithOcErrors/restrictOrgScope/resolveConnectorCaller）→
   usage/modelgw/market 外的聚合面 → iam/apps/agents。终态验收：apply() ≤300 行、
   inject ≤8、单文件 >1500 行告警入 lint（工具位已留：`scripts/lint-manifests.mjs` 可挂
   `scanFileLength`，同 lint-timers 模式）。
2. **portal 豁免销账**：portal 单 handler 改逐路由注册（8 条豁免随之移除）。
3. **requireSignedCommits 开启**：仓库启用提交签署（GPG/tag 签名）后，
   `POST /api/update/settings {requireSignedCommits:true}` 即把 OPT-P2-03 签名核验升级为强制闸门。
4. **审核队列**：`perm_unused` 名单逐点确认（预留 or 删除）。
5. **dsh-bridge / rq-card 清单**：按宿主形态补 plugin.yaml（或登记为"无清单形态"豁免）。

## 四、运维注意事项

- **审批通道兼容口径（P1-02）**：旧布尔旁路已死——存量 pending 审批单批准后由执行器持
  能力令牌续调，语义不变；伪造/过期令牌一律重新开单（fail-closed）。
- **总线异步化（P1-04）**：`platformBus.emit` 同步完成校验/记账/journal 后异步派发监听器——
  "emit 返回即监听器已执行"的假设不再成立；断言类代码一律轮询（selftest 已全部改造）。
  journal 位于 `<dataDir>/bus-journal.jsonl`，死信 `<dataDir>/bus-dead-letters.jsonl`，
  `bus.retryDeadLetters()` 重投为 at-least-once 全量重发（消费方按事件 id 幂等）。
- **连接器镜像失败语义（P1-05）**：失败即吊销旧 oct_ 令牌并组级 fail-closed，巡检/下次变更自动
  恢复——运维看到 `connector.policy_mirror_failed` 告警应优先检查 sidecar 可用性。
- **update_apply 变更（P2-03）**：正式执行现在**必须带 pin**（tag/commit/分支），裸拉最新被拒；
  回滚走 `POST /api/update/rollback`。手工升级请改用
  `POST /api/update/apply {reason, pin:"<tag>"}`。
- **归档区**：`archive/plugin-billing` 已脱离 workspaces（npm 不会解析）；恢复须按
  `archive/README.md` 的条件重走清单+lint。
- **双端同步**：按工作区约定用 `D:\DSH-07\daily-sync-deploy.py`（`--check` 先比对；
  正式环境只传文件不自动重启）。
