# QA 验收报告 · EXEC-CHECKLIST W1–W6 整改达成度核查（2026-10-16）

> 被测对象：`main @ a5f754a`（v1.2.0，2026-10-16 产品化攻坚批次）
> 验收依据：[EXEC-CHECKLIST-20261016.md](EXEC-CHECKLIST-20261016.md)（六工作流整改清单）
> 验收方式：6 个测试组并行静态核查（文件:行号级证据）+ 主线运行时门禁实测（selftest / lint 三门禁 / GitHub API 实查）
> 本报告性质：内部过程物料，不构成对外契约。

---

## 0. 一页总览

| 工作流 | 优先级 | 实测达成度 | 判定 |
|---|---|---|---|
| W1 分发与生态位 | P0 | **4/4 达成**（附 2 条尾巴） | ✅ 通过（有尾巴） |
| W2 启动健壮性 | P0 | **0/4，完全未启动** | ❌ 不通过（P0 敞口） |
| W3 版本锁定与 CI 双轨 | P0/P1 | **0/4 主体未动**（既有 selftest.yml 单轨可作基座） | ❌ 不通过 |
| W4 存储层迁移 | P1 | **约 70%**（第一期达成，方案已修订口径） | 🟡 有条件通过 |
| W5 dsh 耦合面收窄 | P2 | **1/4**（仅对外声明达成，技术主体未开工） | 🟡 未启动主体 |
| W6 文档与叙事收敛 | P1 | **3.5/4 ≈ 87.5%** | ✅ 通过（有尾巴） |

**总体结论：附件清单要求的整改内容未全部达成。** 六大项中：2 项达成、2 项部分达成、2 项（W2/W3，均为 P0）完全未启动；另发现 **1 条合并门禁红线**（selftest 1448/1450）与 **1 处夹带改动**（plugin-mcp 权限块删除，需研发确认）。

### 运行时门禁实测（主线亲测，2026-10-16，node v24.21.0）

| 门禁 | 结果 |
|---|---|
| `npm run selftest` | **1448/1450，2 项红**（详见 §1 Blocker） |
| `npm run lint:manifests` | 0 错误（4 条提示级警告：perm_unused ×2、public_path_undeclared ×2） |
| `npm run lint:boot-order` | 0 错误 / 49 提示（豁免登记 2 条，均在册） |
| `npm run lint:cjk` | 0 违规（205 命中均为允许形态） |

---

## 1. Blocker：合并门禁红线（必须最先修复）

**B-1 selftest 1448/1450 —— 版本号升级未同步测试期望**

- 现象：`[平台自更新（plugin-update）] 更新状态可读` 与 `Agent 工具 update_status 可用` 两条断言失败。
- 根因：`scripts/selftest.mjs:3233`、`:3326` 硬编码期望 `currentVersion === '1.1.0'`，而 a5f754a 批次已将根 `package.json` 升至 **1.2.0**，测试期望未联动。
- 连带后果：`docs/adr-0001-storage-migration.md:200` 与 README 宣称的「1450 项全绿（2026-10-16 实测）」**当前为假**——W1.4「README 每个数字都有出处」的可信度主张被门禁红线击穿。
- **修复交付标准（DoD）**：①selftest 期望值改为**动态读取根 package.json version**（彻底消除每次版本 bump 必红）；②修复后 selftest 1450/1450 全绿；③流程约束：凡改动 `package.json version` 的提交必须附全绿 selftest 证据。

---

## 2. 分工作流明细

### W1 · 分发与生态位 · P0 —— ✅ 4/4 达成

| 子项 | 实测状态 | 证据 |
|---|---|---|
| 1.1 GitHub topics | ✅ 达成 | gh API 实查：`[agent, ai-gateway, dsh-plugin, enterprise, llmops, mcp]`，6/6 全集命中、含 dsh-plugin |
| 1.2 README 重写 | ✅ 达成 | 200 行；第一屏价值前置（:3-18）；竞品边界表（:164-175，覆盖 LiteLLM/Dify/Langfuse/百炼等）；诚实边界节（:141-161，首屏 :31 有前向锚点） |
| 1.3 仓库描述 | ✅ 达成 | 实查 description 为价值陈述，无 "dev repo"/"RongQi"/"host-track" |
| 1.4 品牌统一 | ✅ 达成 | README 内 RongQi/榕器 0 命中；数字抽验 5 项：27 插件包（实数 27）、84 权限点（实数 84）、83 MCP 工具（实数 83）、354 路由（静态近似 355）、1450 断言（静态 1479 个 check 调用点）均吻合 |

**尾巴（下批次清理，不改判定）**：
1. `llms.txt:5` 英文段仍为 "RongQi (ybkk-AIOS) is…"——对外分发面品牌残留。
2. `packages/plugin-mcp/plugin.yaml` permissions 6 条，落后生成清单 `manifest/permissions.yaml`（7 条，含 `mcp.risk.admin`）——与 §3 夹带改动同源。
3. README 中「1450 断言全绿」依赖 B-1 回绿后重新成立。

**W1 维持验收 DoD**：topics API 持续非空含 dsh-plugin；README 数字与运行时门禁一致；对外资产（README/llms.txt/i18n docs）品牌残留为 0。

### W2 · 启动健壮性 · P0 —— ❌ 0/4 完全未启动

| 子项 | 实测状态 | 证据 |
|---|---|---|
| 2.1 `boot-probe.ts` | ❌ 文件不存在 | `packages/platform-core/src/` 22 个文件无此文件；`assertSingleRoot/probeTree/formatTreeHealth/boot-probe` 全仓 grep 唯一命中清单文档自身；`Symbol.for('ybkk.cordis.root')`、`FiberState`、`_getImpl` 业务代码 0 命中 |
| 2.2 `boot-all.ts` 接线 | ❌ 无任何调用 | `src/boot-all.ts`（80 行）：首个 plugin 在 :38、末个在 :79，全程无 assert/probe/throw |
| 2.3 selftest 配套断言 | ❌ 0 条 | `probeTree`/`assertSingleRoot`/`双实例` 在 selftest.mjs（7706 行）中 0 命中 |
| 2.4 双实例演练脚本 | ❌ 不存在 | scripts/ 下仅 `boot-trace.mjs`（手工诊断）与 `check-boot-order.mjs`（静态 lint） |

**风险评估（直说）**：双实例装配零报错、fiber 永久 PENDING、required 服务不可达——三类沉默失败当前**零运行时防线**。现有 `check-boot-order.mjs` 仅能静态拦截「无提供者的 inject」一类。
（技术前提已验证可行：cordis FiberState 为 const enum，`node_modules/@deepseek-ai/cordis/src/fiber.ts:147` 枚举序 PENDING=0…ACTIVE=2…，按数值还原的清单预判正确。）

**W2 验收 DoD（下一批次，预估 2h）**：
1. `boot-probe.ts` 三函数落地（含 FIBER_STATE 数值还原、跨实例 root 检测、错误消息含「双实例」）；
2. `boot-all.ts` 两处接线：首个 `ctx.plugin()` 前 `assertSingleRoot(ctx)`；全部 plugin 后 `probeTree(ctx, ['opsStorage','platformBus','httpServer','iam','authn','usage','audit'])`，`!ok` 即 **throw**（禁止 console.warn 放过）；
3. selftest 4 组断言：正常路径 ok:true / 故障注入报 iam 不可达 / 污染 globalThis 后抛「双实例」/ 用例后清理污染；
4. 演练验收：人为制造双实例，**3 秒内响亮失败**并打印插件名 + 卡住的 inject 键；正常启动日志零 probe 告警。

### W3 · 版本锁定与 CI 双轨 · P0/P1 —— ❌ 主体未动

| 子项 | 实测状态 | 证据 |
|---|---|---|
| 3.1 cordis 精确锁版 | ❌ 未达成 | `package.json:49` 仍 `"^4.0.1"`；`package-lock.json:209-211` 解析 4.0.1 |
| 3.2 CI 双轨 | 🟡 部分 | `.github/workflows/` 仅 `selftest.yml`：gate 轨已达标（node 24 + lint:manifests + selftest，全流程不碰 dsh）；**dsh-compat 实验轨完全缺失**（无 workflow_dispatch 隔离 / continue-on-error / matrix rc.7+rc.9） |
| 3.3 `check-dsh-compat.mjs` | ❌ 未达成 | scripts/ 27 个脚本无此文件；`vendor/` 目录不存在；五项兼容断言零自动化 |
| 3.4 dshReleases 可信度 | ❌ 未达成 | `package.json:29-31` 仅手工登记 rc.7；全仓无任何脚本读取/校验/回写该字段 |
| 附录 engines | 确认非缺口 | 仍 `>=22.6`，内部设计文档（重构方案 :72）证实为零构建硬约束的有意选择，但建议 README/CONTRIBUTING 标注「已验证版本」 |

**W3 验收 DoD**：①cordis 升 4.0.4 先过全量 selftest，再去 caret 精确锁定，`npm ci` 任意机器解析一致；②`quality-gate.yml` 双 job：gate 为 required、dsh-compat 仅手动触发 + `continue-on-error: true` + matrix 两 rc 版本；③check-dsh-compat 五项断言（版本确认 / symlink-junction 指向 vendor/cordis / probeTree ok / 无重复注册 / 回写 dshReleases）；④手动触发后两个 rc 版本均出明确结论。

### W4 · 存储层迁移 · P1 —— 🟡 约 70%（第一期达成 · 方案已修订口径）

| 子项 | 达成度 | 实测要点 |
|---|---|---|
| 4.1 后端抽象 | ~75% | `SqliteCollectionBackend`/`SqliteCollectionImpl` 已落地（storage-sqlite.ts:24,118）；`StorageConfig.backend` 存在但类型仅 `'json'\|'sqlite'`（缺 `'postgres'`，ADR 有意推二期）；`PLATFORM_STORAGE` 经 `parseBackendEnv`（storage.ts:461）生效，selftest:7653 断言透传到 main.ts 子实例；**`Collection<T>` 接口与全部插件 src 零改动达成**（git show a5f754a --stat 核实）；`JsonCollectionBackend` 对称抽象未抽出（JSON 侧仍模块内私有类） |
| 4.2 第一批集合 | ~40% | 实际为**后端级整体切换**（`usesSqlite` storage.ts:251-256 + `PLATFORM_STORAGE_JSON_KEEP` 例外名单），无「第一批 9 类先行」灰度；`PLATFORM_STORAGE_MIGRATED` 按批开关零实现（仅 ADR 计划文本） |
| 4.3 双写/回填/影子读 | ~50% | 双写、影子读被 ADR §十论证豁免（单进程单写者，论证成立但属**清单变更**）；启动原子回填达成（restoreSqlite + backfill 单事务 + meta 标记，崩溃安全）；**缺条数/哈希对账校验**；回滚工具达成（storage-export.mjs + JSON 回滚源永不改写，selftest:7602 断言） |
| 4.4 治理型红线点 | ~65% | `iam:identityLinks` 引擎级唯一达成（plugin-iam/src/index.ts:745，含 corpId 维度比清单更严；storage-sqlite.ts:41-170 撞键即抛+回滚）；`authn:tokens` onChange 在事务提交后触发（storage-sqlite.ts:202-225），语义不劣；**缺口：sqlite 后端下 iam「一人一号」端到端攻击演练缺失**（:683 的一人一号断言跑在默认 json 实例）；第三批集合默认仍被迁移，无默认 JSON 保留名单，**与 ADR §五自身结论相悖** |
| 4.5 质量门 | ~85% | selftest 新节 23 条断言（selftest.mjs:7514-7682，含 kill -9 平台级零丢失 7 条）；「并发重复插入被拒」实为顺序 try/catch 断言（非真并发）；`storage-bench.mjs` 存在且 P99<50ms 不过即 fail，但写入为**串行 for 循环**，与清单「10k 并发」口径不符；PRAGMA 齐备（WAL + synchronous=FULL + BEGIN IMMEDIATE，sqlite.ts:36-37,126） |
| 4.6 ADR 文档 | 100% | 255 行（清单口径 222，增量为 §十落地记录，建议更新口径）；三批叙事 + 可自动化验收 + 偏差论证齐备 |

**W4 收尾 DoD（下一批次）**：①默认 `PLATFORM_STORAGE_JSON_KEEP` 名单覆盖第三批低频配置集合（与 ADR §五对齐）；②回填后条数 + 关键字段哈希对账断言；③sqlite 后端下 `iam:identityLinks` 一人一号攻击演练全绿；④压测升格真并发 **或** ADR 正式改口径为「串行 10k 写 P99<50ms」；⑤`PLATFORM_STORAGE_MIGRATED` 按批开关落地 **或** ADR 正式废止该条款（二选一，不允许文档与代码继续各说各话）。

### W5 · dsh 耦合面收窄 · P2 —— 🟡 1/4（技术主体未开工）

| 子项 | 实测状态 | 证据 |
|---|---|---|
| 5.1 窄端口 | ❌ 未达成 | 无 hostBridge/端口抽象（grep 仅命中前端 UI 探测布尔位）；plugin-dsh-bridge 直用 `ctx.webServer`（src/index.ts:75 inject，:313-:612 共 7 个调用点）；plugin-rq-card 直用 `ctx.slots/ctx.locale`（client/index.ts:111 inject，类型直依赖 dsh-client-runtime 三包） |
| 5.2 mock 契约测试 | 🟡 部分 | selftest:5850-5906 有 fakeWebServer 挂载契约 5 条（测的是现状直连行为，非 adapter）；rq-card 注入面零覆盖 |
| 5.3 对外声明 | ✅ 达成 | README:96-97「独立宿主(默认，承诺 SLA 的形态)/完整 dsh 运行时(experimental)」+ :110-111，与清单措辞逐字对应；小差距：deploy-enterprise.md:14 形态 B 未复述 experimental、en 版 README 无双形态声明 |
| 5.4 反向核验 | ✅ 干净 | 无 pnpm overrides/resolutions；根目录 `cordis.yml`/`cordis.patch.yml` 为 dsh 宿主**挂载清单**（patch 是 dsh 官方术语），非被禁止的源码补丁；junction 方案与清单认可路径一致 |

**W5 验收 DoD（P2 启动后）**：hostBridge 端口类型落地，两插件全部 dsh API 调用收进 adapter；adapter mock 契约测试落 `tests/` 或 `packages/*/tests`；dsh 升级仅需重跑该组。可复制现成先例：workforce 域 `ctx.workforcePolicy` 窄端口。

### W6 · 文档与叙事收敛 · P1 —— ✅ 87.5%（3.5/4）

| 子项 | 实测状态 | 证据 |
|---|---|---|
| 6.1 README 重写 | ✅ 达成 | 200 行；价值前置/竞品表/诚实边界三要素齐备；行数口径 684→180（CHANGELOG）vs 实际 200，cosmetic 不一致 |
| 6.2 过程物料外移 | 🟡 部分 | docs/ 内部收敛 100%：`docs/internal/` 69 文件/1.0M（qa-report ×14、handoff ×6、release-notes ×11、重构基线 ×5 等）+ internal README；保留清单全在位（contract-* ×7、deploy-enterprise、两个 onboarding、i18n 七语言+GLOSSARY）；**根目录残留未清零**：`测试报告-前后端整体适配验收-20261015/`（6 文件 88K）、`Kimi_Agent_CIO仪表盘设计.zip`（186K）、`交互重设计-设计稿.html`、`yuanbingke-brand-guidelines.html`、`data-qa-20261015/`、`data-selftest-usage-tmp/`、`logs/` |
| 6.3 i18n 声明收敛 | ✅ 达成 | 7 市场表述 0 命中；README:157-158 收敛表述「架构已支持 i18n，出海市场按需推进」在位 |
| 6.4 基础文件 | ✅ 达成 | CONTRIBUTING.md（50 行 5 节实质）、CHANGELOG.md（50 行，1.0/1.1/1.2 三版本齐备）、docs/ARCHITECTURE.md（113 行 10 节，插件树+事件契约稳定入口）；ecosystem-design-v1.2.md 已迁 internal 且带 `[!WARNING]` 废止横幅 |

**W6 收尾 DoD**：根目录过程物料全部迁 `docs/internal/`（或 gitignore 的本地产物）；`llms.txt` 品牌修正；CHANGELOG「180 行」口径修正。

---

## 3. 专项：夹带改动待研发确认（须书面回复）

`a5f754a` 中 `packages/plugin-mcp/plugin.yaml` 删除了 `mcpToolRisks` 提供声明与 `mcp.risk.admin` 权限块（3 行）——**非存储相关、非版本联动、commit 叙事未提及**；而生成清单 `manifest/permissions.yaml` 仍含该权限（7 条），README「84 权限点」口径含它。源头与生成物已漂移。

**要求研发二选一并闭环**：
- A. 恢复该权限块（若为误删）；
- B. 确认为有意下线 → 重新生成 manifests + 更新 README 权限点数字 + CHANGELOG 补记 + lint:manifests 相关警告销案。

---

## 4. 交付标准总纲（与研发团队对齐的验收口径）

1. **门禁先决**：任何批次宣称「交付/收口」的先决条件 = `npm run selftest` 全绿（当前基线 1450）+ lint 三门禁 0 错误。**当前 main 不满足，先修 B-1。**
2. **条款即合同**：每个子项验收 = EXEC-CHECKLIST 原条款 + 本报告对应 DoD 列。凡以「方案修订」替代原条款达成（如 W4 双写豁免、W3 gate 单轨），必须**双侧回写**（ADR/清单同步更新），不允许代码一套、文档一套。
3. **版本卫生**：`package.json` version 变更必须三处联动——selftest 期望（建议动态化后此条自动满足）、CHANGELOG、README 数字；bump 提交必须附全绿 selftest 证据。
4. **品牌卫生**：对外资产（README / llms.txt / docs/i18n）RongQi 残留 = 0。
5. **P0 缺口限期**：W2（2h）与 W3.1（5min）体量极小、风险极高，要求下一批次一次性收口；W3.2 双轨 CI 随后（1h）。

## 5. 建议排期（按杠杆/风险排序）

| # | 事项 | 体量 | 级别 |
|---|---|---|---|
| 1 | B-1 修 2 红（版本期望动态化）→ 门禁回绿 | 0.5h | Blocker |
| 2 | W2 三件套（boot-probe + 接线 + 4 断言 + 演练） | 2h | P0 |
| 3 | W3.1 cordis 升 4.0.4 过测后精确锁版 | 5min | P0 |
| 4 | 夹带改动专项确认（plugin-mcp 权限块） | 0.5h | 数据一致 |
| 5 | W3.2 quality-gate 双轨 CI | 1h | P1 |
| 6 | W6/W1 尾巴（根目录物料迁移、llms.txt、CHANGELOG 口径、plugin.yaml 回写） | 1h | P1 |
| 7 | W4 收尾四件（JSON_KEEP 默认名单/回填对账/iam 攻击演练/压测口径） | 1d | P1 |
| 8 | W3.3 check-dsh-compat.mjs + dshReleases 回写 | 0.5d | P2 |
| 9 | W5 窄端口 + adapter 契约测试 | 2–3d | P2 |

---

## 附录 · 证据索引

- 运行时（主线实测）：`npm run selftest` → 1448/1450（红项见 §1）；`lint:manifests` 0E/4W；`lint:boot-order` 0E/49 提示；`lint:cjk` 0 违规。环境 node v24.21.0 / darwin arm64。
- 静态核查：T1（W1+gh API 实查）、T2（W2）、T3（W3）、T4（W4+git show --stat）、T5（W5+反向核验）、T6（W6+docs 统计），六组证据均为文件:行号级，关键证据已内嵌各节。
- 关键文件：`scripts/selftest.mjs:3233,3326`（红项根因）；`package.json:49`（cordis 未锁）；`.github/workflows/selftest.yml`（gate 基座）；`packages/platform-core/src/storage-sqlite.ts`、`storage.ts:251-256,461-473`（W4 核心机制）；`scripts/selftest.mjs:7514-7682`（存储 23 断言）。
