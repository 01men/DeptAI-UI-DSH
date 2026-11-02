# 收口报告 · EXEC-CHECKLIST 整改攻坚批次（2026-10-16 · v1.3.0）

> 被测对象：本批次工作区（基线 `main @ a5f754a`，QA 报告所指 1448/1450 红线批次）
> 依据：[qa-report-20261016-exec-checklist-acceptance.md](qa-report-20261016-exec-checklist-acceptance.md)
> （六工作流达成度核查）+ [EXEC-CHECKLIST](../../EXEC-CHECKLIST.md) 原条款
> 施工方式：研发负责人统一集成，五个小组并行攻坚（启动/平台/存储/耦合/文档），文件所有权分段持有
> 本报告性质：内部过程物料；兼作 QA §3「夹带改动专项」的**书面回复**

---

## 0. 一页总览

| QA 判定 | 本批次结果 | 门禁证据（2026-10-16 实测，node v24.21.0） |
|---|---|---|
| B-1 红线（1448/1450） | ✅ 修复回绿 | **selftest 1467/1467 全绿**（1450 基线 + W2 六条 + 存储收尾十一条）；版本期望动态化后 bump 不再联动测试 |
| W2 ❌ 0/4 | ✅ 4/4 全达成 | boot-probe 三函数 + boot-all 双接线（throw 放行）+ selftest 六断言 + boot-drill 五场景全绿 + 真实 bootAll 冒烟零告警 |
| W3 ❌ 0/4 | ✅ 4/4 全达成 | cordis **4.0.4** 精确锁定（过全量 selftest 后钉版）；quality-gate 双轨；check-dsh-compat 五断言 rc.7 实测全过；dshReleases 有机器验证来源 |
| W4 🟡 70% | ✅ 收尾五件全达成 | JSON_KEEP 默认名单（9 项）/ 回填事务内条数+SHA-256 对账 / sqlite iam 一人一号攻击演练 7 断言 / 压测口径改串行 / MIGRATED 条款废止——全部双侧回写 ADR |
| W5 🟡 1/4 | ✅ 技术主体达成 | hostBridge 窄端口 + 两插件 adapter 化 + mock 契约测试 42 条（dsh 升级只需重跑该组）；selftest fakeWebServer 契约零改动等价 |
| W6 ✅ 87.5% | ✅ 尾巴清零 | 根目录跟踪物料迁移；llms.txt + docs/i18n 88 处品牌清零；CHANGELOG 口径修正；另清 4 处旧品牌「衡 ·」 |
| §3 夹带专项 | ✅ 方案 A 落地 + 根修 | 见 §2 书面回复 |

**其余门禁**：`lint:manifests` 0 错误（18 条提示级警告，均为带豁免理由的既有项，零新增）；
`lint:boot-order` 0 错误 / 49 提示（豁免 2 条在册）；`lint:cjk` 0 违规（205 命中均允许形态）；
`npm run test:contracts` 42/42；`node scripts/boot-drill.mjs` 五场景全绿；
`node scripts/check-dsh-compat.mjs 0.1.0-rc.7` 五断言全过、诚实路径（不可达）exit 2 实测。

---

## 1. 版本与交付物

- 版本 **1.2.0 → 1.3.0**（同日第二批，含行为变更：sqlite 后端低频配置集合默认保留 JSON、
  启动门禁生效）。版本卫生三联动齐备：CHANGELOG 新节、README 断言数联动（1450→1467）、
  selftest 版本期望动态化；`npm run manifests` 已将 21 个 plugin.yaml 重盖章。
- 主要新交付物：`packages/platform-core/src/boot-probe.ts`、`packages/platform-core/src/host-bridge.ts`、
  `scripts/boot-drill.mjs`、`scripts/check-dsh-compat.mjs`、`.github/workflows/quality-gate.yml`
  （selftest.yml 已 git rm 并入 gate 轨）、`packages/plugin-dsh-bridge/tests/host-bridge.contract.mjs`、
  `packages/plugin-rq-card/tests/host-bridge.contract.mjs`、
  `packages/plugin-rq-card/src/client/host-port.ts`。
- 1.2.0 节 CHANGELOG 中「1450 项全绿」已加修注（当批门禁遗留 2 项红，1.3.0 收口回绿）——
  QA §1 指出的「README 数字可信度被击穿」以 fix-forward + 修注方式结案。

## 2. 书面回复：夹带改动专项（QA §3）

**结论：确认误删，按方案 A 处理，并完成根修。**

1. **恢复**：`packages/plugin-mcp/plugin.yaml` 的 `mcpToolRisks` 提供声明与 `mcp.risk.admin`
   权限块已按 `a5f754a^` 逐字恢复（含权限注释），diff 与历史版本仅剩版本号升级。
2. **根因溯源（比 QA 判定更进一步）**：漂移的源头不是一次性手滑——`scripts/gen-manifests.mjs`
   是硬编码清单式生成器且会回写 plugin.yaml，其内置目录不含 risk-registry 增强面与 console
   `/locales/:locale` 声明。任何人重跑 `npm run manifests` 都会再次冲掉手工增强面（本批次
   施工中文档组实测复现了一次并还原）。**若只做方案 A 恢复，地雷仍在。**
3. **根修**：生成器数据源补齐上述两处面 + 新增权限注释模板能力
   （`permissionComments` / `permissionCommentsManifest`）。验证口径：**再跑生成器后，
   全仓 21 个 plugin.yaml 与全部 manifest 相对提交内容逐字节一致**，仅存差异即本专项恢复的
   3 行（即生成器输出与恢复后的仓库完全幂等）。
4. **销案状态**：README「84 权限点」口径含该权限、manifest 7 条含该权限、plugin.yaml 已恢复
   ——三处一致；`lint:manifests` 0 错误、零新增警告。

## 3. 偏离记录（对照 EXEC-CHECKLIST 原条款，均双侧回写）

| # | 偏离 | 理由（证据在案） |
|---|---|---|
| 1 | W2 探针对 FAILED fiber 引入「良性败者」豁免：仅当其声明 provide 已被其他 ACTIVE fiber 接管时不拦启动 | 首次真实 bootAll 冒烟即被字面门禁拦下：panel-core/flow-core 既有习语（`ctx.plugin(Class)` 后同步 `new Class(ctx)`）产生两个永久 FAILED husk，服务本体由胜者提供、功能完好；若按字面实现，独立宿主 100% 拒绝启动。真故障（provide 无人接管）依旧拦启动（drill 场景⑤）。建议后续批次清理该习语后移除豁免逻辑 |
| 2 | W4 压测口径由「10k 并发写入」改为「串行 10k 写 P99<50ms」 | node:sqlite 为同步 API、单进程单写者，进程内并发无意义；QA DoD ④明示二选一，选口径修订（多进程压测明确不做，论证已写入 ADR §五） |
| 3 | W4 `PLATFORM_STORAGE_MIGRATED` 按批开关选择「废止」而非实现 | QA DoD ⑤明示二选一；后端级开关 + JSON_KEEP 豁免名单已覆盖回滚诉求（把集合名加进名单即刻回退 JSON），按批开关属重复机制 |
| 4 | W3.3 兼容脚本的 cordis 实体来源链：git clone harness 仓库（私库）失败时降级 npm 发布构建 + `repository.directory` 来源证明 | 实测发现 `@deepseek-ai/dsh` npm tarball 是 CLI 应用、不含 vendor/cordis，harness 仓库为私库；降级链取到的 cordis 4.0.4 恰与项目锁定一致，来源字段可证。rc.9 的完整链需 CI 私库凭据，实验轨内如实呈现 |

## 4. 已知遗留（下一批次候选，均不影响本批验收）

1. `gen-manifests.mjs` 硬编码目录的长期形态：改为扫描式生成（现为先补数据源保幂等）。
2. panel-core/flow-core 双注册习语清理（`ctx.plugin(Class)` 装饰性行删除），随后可移除
   boot-probe 的良性败者豁免（偏离 1 的销账条件）。
3. check-dsh-compat 对 rc.9 的实跑验证需 CI 私库凭据（本机已验证 rc.7 与诚实路径）。
4. docs/i18n 日文部署文档未补双形态 experimental 句（英文两处已补；克制不扩，下批随 i18n 例行同步）。
5. `docs/internal/` 内 QA 报告基线数（1448/1450、lint 警告 4 条口径）与本批实测（18 条口径）
   存在统计口径差——QA 报告按「无豁免理由的裸警告」计数，lint 实际输出含带豁免理由项；
   以本报告 §0 的实测输出为准。

## 5. 验收口径对照（QA §4 交付标准总纲）

1. **门禁先决**：selftest 1467/1467 全绿 + lint 三门禁 0 错误 ✅（先修 B-1 后再开工，红线批次未带病施工）。
2. **条款即合同**：以「方案修订」替代原条款的三处（W4 ④⑤、W2 豁免）已双侧回写（代码 + ADR + 本报告 §3）。
3. **版本卫生**：1.3.0 bump 附全绿 selftest 证据（本批终验两次全绿：钉版后 1467/1467、盖章后复跑见 CHANGELOG）。
4. **品牌卫生**：对外资产 RongQi / 榕器 / 衡 · 残留 = 0（`git grep` 实测）。
5. **P0 缺口限期**：W2 与 W3.1 本批次一次性收口，W3.2 随批完成。
