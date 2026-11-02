# 执行清单 · 2026-10-16 产品化攻坚批次（执行结果归档）

> 原件为外部评审交付的 EXEC-CHECKLIST（W1 分发 / W2 启动健壮性 / W3 版本锁定与 CI /
> W4 存储迁移 / W5 dsh 耦合收窄 / W6 文档叙事收敛）。本批次一次性完成 **W1 + W4 + W6** 三个方向；
> W2/W3/W5 留待后续批次（未启动）。本文件为执行结果存档。

## 结果总览

| # | 工作流 | 原优先级 | 原预估 | 结果 |
|---|---|---|---|---|
| W1 | 分发与生态位 | P0 | 30 min | ✅ 全部完成 |
| W4 | 存储层迁移（第一期 SQLite） | P1 | 3–5 d | ✅ 第一期完成（详见下） |
| W6 | 文档与叙事收敛 | P1 | 3 h | ✅ 全部完成 |
| W2 | 启动健壮性 | P0 | 2 h | ⬜ 未在本批次（后续） |
| W3 | 版本锁定与 CI 双轨 | P0/P1 | 1.5 h | ⬜ 未在本批次（后续） |
| W5 | dsh 耦合面收窄 | P2 | 2–3 d | ⬜ 未在本批次（后续） |

## W1 · 分发与生态位 ✅

- [x] 1.1 打 topic：`dsh-plugin,agent,llmops,mcp,ai-gateway,enterprise`（API 验证 names 非空且含 dsh-plugin）
- [x] 1.2 README 重写落地（684 → 180 行）：前三行明确「给已经跑 dsh 的团队的企业管控台」；
      数字全部重新核出（27 插件包 / 84 权限点 / 354 路由 / 83 MCP 工具 / 1450 断言）
- [x] 1.3 仓库描述改为一句价值陈述（面向 dsh 团队的企业 AI 管控台）
- [x] 1.4 验收：陌生人 30 秒可定位问题域与竞品边界；topics API 非空；README 数字均有代码出处

## W4 · 存储层迁移（第一期）✅

交付物与决策记录见 [`docs/adr-0001-storage-migration.md`](../adr-0001-storage-migration.md) §十。
要点：

- [x] 4.1 后端抽象：`SqliteCollectionImpl` 与 json 版严格同一 `Collection<T>` 契约，业务插件零改动
- [x] 4.2/4.3 两批集合整体覆盖（后端级切换）；`PLATFORM_STORAGE_JSON_KEEP` 提供第 3 批例外名单机制
- [x] 4.5 执行方式：与 §六 偏差为「原子回填」替代双写（单进程部署形态下更简且确定性等价，论证见 ADR）
- [x] 4.6 验收：
  - selftest 1450/1450 全绿（新增 23 项 SQLite 契约断言）
  - uniqueOn → 引擎级唯一索引（绕过先查后插的写入被拒 + update 抢键被拒断言）
  - 10k 写入压测 P99 = 0.077ms（线 50ms；`scripts/storage-bench.mjs`）
  - kill -9 后重启零丢失（selftest 平台级子实例：崩溃前账号可登录 + 回填数据完整）
  - 插件代码零改动（`git diff packages/*/src` 存储相关仅 platform-core）
- 配套：`scripts/storage-export.mjs`（回滚导出）、deploy-enterprise 存储选型节、README 诚实边界更新

## W6 · 文档与叙事收敛 ✅

- [x] 6.1 README 重写（并入 W1.2）
- [x] 6.2 过程物料外移：67 个文件 → `docs/internal/`（qa-report 17 / release-notes 9 / handoff 6 /
      dev-plan 7 / 重构基线 4 / 其余评审·路线·证据），34 个文件引用路径同步修正；
      docs/ 根保留：契约 7 + 部署与接入指南 11 + 协议键总表 + i18n/ + 新增 ARCHITECTURE/ADR
- [x] 6.3 国际化声明收敛：README 出海表述改为「架构已支持 i18n，出海市场按需推进」
- [x] 6.4 基础文件补齐：`CONTRIBUTING.md` · `CHANGELOG.md` · `docs/ARCHITECTURE.md`
- 联动：console `/docs` 公开白名单移除已外移的 `ecosystem-design-v1.2.md` 死键（selftest 仅断言白名单行为，不锁定清单）

## 质量门（本批次全绿）

```
npm run selftest                → 1450/1450（含 P95 闸门 + SQLite 后端契约节）
npm run lint:manifests          → 0 错误
npm run lint:boot-order         → 0 错误（既有豁免 2 项不变）
npm run lint:cjk                → 205 命中
node scripts/check-docs-consistency.mjs → 67 处引用全部命中
manifests                        → 版本 1.2.0 联动；已知生成器滞后（risk-registry/locales 手工增强面），已回滚内容性漂移
```

## 后续批次建议（未启动项）

1. **W2 启动健壮性**（P0，2h）：boot-probe 双实例守卫 + probeTree 体检 + selftest 故障注入
2. **W3 版本锁定与 CI 双轨**（P0/P1，1.5h）：cordis 精确锁版 + quality-gate/dsh-compat 双 job +
   `check-dsh-compat.mjs` 可执行兼容断言
3. **W5 dsh 耦合收窄**（P2，2-3d）：hostBridge 窄端口 + mock 契约测试
4. 存储二期：Postgres 后端（多节点 HA）+ 复合写路径事务包裹审计（ADR-0001 §十遗留）
