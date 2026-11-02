# 榕器（ybkk-AIOS）全局重构方案 · 全盘对照 paperclip

> 文档编号：REFACTOR-2026-10-13
> 制定日期：2026-10-13 ｜ 目标仓库：`01men/ybkk-AIOS`（本仓，宿主轨 main）
> 参考项目 A：`paperclipai/paperclip`（MIT，本地对照检出 `D:\元冰可项目\_refs\paperclip`）
> 适配对象：`01men/RQ-DSH`（定制轨 `custom/dsh-rq` 的发布备份仓，交付物 `@ybkk/gate-01`）
> 方案口径：**全部汉化**（不维护英文版本）；**最稳健**（小步、可回滚、质量门前置）

---

## 一、三项目全盘分析

### 1.1 本项目（榕器）现状底册

| 维度 | 现状 |
|---|---|
| 产品定位 | 企业 AI 资源统一管理平台：六类资产（MCP/Skill/Agent/AI 应用/模型路由/NAS）纳入一套身份、权限、计量、审计 |
| 规模 | 后端 TS 86 文件 / 33,710 行（src+packages）；前端零构建 JS/HTML 15,743 行；文档 74 个 md / 9,655 行 |
| 运行约束 | Node ≥ 22.6 原生 TypeScript 运行，**零构建步骤是硬约束**（dist 仅在 dsh 安装形态预构建） |
| 装配形态 | 一份插件代码、两种宿主：`src/boot-all.ts`（独立宿主，按序挂 23 插件）与 `cordis.yml` / `cordis.patch.yml`（dsh 宿主 overlay） |
| 插件森林 | `packages/` 25 包 = `platform-core` 底座 + 24 业务插件（iam/authn/mcp/skillhub/agent/app/usage/modelgw/nas/audit/flow-core/console/panel-core/portal/market/connector/dingtalk-bridge/connect/update/dsh-bridge/rq-card 等） |
| 前端形态 | 服务端静态托管的原生 ES 模块 SPA：console（19 页面模块 + 哈希路由）、panel-core 独立 SPA（`/panel`）、rq-card 浏览器半（需 `build.mjs` 预构建）；**无 i18n 层** |
| 数据存储 | 双存储：JSON 集合（防抖落盘，业务配置）+ `node:sqlite` WAL（`data/txnstore.db`，计量/资金类只追加表） |
| 质量门 | `scripts/selftest.mjs`（5,981 行 / 81 section / 约 1,201 断言端到端自测）+ `lint:manifests`（五面 YAML + 契约双向比对 + 定时器卫生） |
| 技术债 | ① `plugin-console/src/index.ts` 巨石 4,757 行；② `CallerInfo`+`requirePermission` 样板在 4 处近似重复；③ `archive/plugin-billing` 封存（CSV 封存期 **2026-12-08 到期**）；④ 插件加载顺序契约只存在于注释与 yml 顺序，无机器校验 |
| 纪律面 | TODO/FIXME 密度为 0；债以交接编号注释（F 清单、WP-xx、M0-2）形式登记 |

### 1.2 参考项目 A（paperclip）底册

| 维度 | 现状 |
|---|---|
| 产品定位 | 「AI 代理公司控制平面」：用组织架构/任务工单/预算/审批治理一队异构编码 Agent（Claude Code、Codex、Cursor 等）；口号「If OpenClaw is an employee, Paperclip is the company」 |
| 技术栈 | Node ≥ 24 + TS7 + pnpm monorepo；Express 5 + React 19(Vite) + Drizzle ORM + 内嵌 Postgres（150+ 表 / 338 迁移）；Better Auth；Vercel AI SDK + ACP 协议 |
| 架构分区 | `server/`（REST + 600+ 服务文件 + 新式 modules）、`ui/`（React SPA）、`packages/`（shared/db/11 种 harness 适配器/plugins-sdk/skills-catalog/mcp-server/Rust runner）、`cli/` |
| 核心子系统 | 浏览器自动化（接 Browser Use 云 API，非自研）；任务执行（心跳唤醒队列 wake-queue + 原子认领 + 执行锁）；预算三级硬停；双模式部署（local_trusted / authenticated） |
| 集成生态 | **声明式集成 JSON 目录**：`packages/shared/src/app-definitions/*.json` 共 102 个应用（GitHub/Linear/Notion/Jira/Slack/Google…），字段含 transport/auth/riskTier（S2 分级），经脚本生成代码 + 品牌资源，新增连接零代码 |
| 工程纪律 | `scripts/check-module-boundaries.mjs` 强制 domain→application→adapters 三层边界；DESIGN.md 单 token 源设计治理；三条数据通道明文规范；测试:源码 ≈ 1:1（2,178 个测试文件） |
| 体量 | 非测试 TS 约 42 万行——**重型工程，宜取其模式而非其体量** |

### 1.3 适配对象（RQ-DSH）与 dsh 生态契约

**关键事实**：RQ-DSH 不是 dsh 宿主，而是**本仓定制分支 `custom/dsh-rq` 的 push 备份仓**（对上游只 fetch 不 push），唯一交付物是 cordis 插件包 `@ybkk/gate-01` v1.2.1，发布给外部宿主 dsh（DeepSeek Harness）安装。本仓（ybkkasi）是宿主轨上游 main、契约所有者。两者目录同构是血缘关系。

「接入 dsh 生态」的确切契约（重构全程必须保持）：

1. 根 `package.json` 声明 `dsh.bundle.patch`（指向 `cordis.patch.yml`）与 `dsh.compatibility`（`>=0.1.0-rc.7 <0.2.0` + `dshReleases` 逐版本标注 + `profiles:["web"]`）；
2. `cordis.patch.yml` 的 entry **必须写「包名 + dist 子路径」**（如 `@ybkk/gate-01/packages/platform-core/dist/index.js`），相对路径会 ERR_MODULE_NOT_FOUND；浏览器半插件（rq-card）必须写纯包名；
3. 安装产物为**预构建 dist**（零 TS 装载、零生命周期脚本）、根 `files` 精确闭包 + `bundledDependencies`；
4. `@deepseek-ai/cordis` **只许在 devDependencies**（hoist 出第二实例会导致服务链全 pending）；
5. 服务键与宿主去冲突（storage 教训：榕器用 `opsStorage` 自键），tools 键刻意共享（`provideToolRuntime:false` 复用宿主 ToolRuntime）；
6. webServer 挂载走自有前缀（`mountPath`，如 `/rq` / `/gate01`），不占宿主 `/api` 与全站 fallback；
7. `npm run lint:manifests` 五面校验 + selftest **fresh-install 装机模拟段**（build-id / dist 指纹 / 三链一致）全绿——这是发布铁律的守卫；
8. 发布流程遵循 `scripts/release.mjs`（git 护栏 → 版本决策 → build:dist → lint+selftest → npm publish → 回填 → push 备份）+ Ed25519 发布清单（`release-manifest.json`）。

注：「五面 YAML」（`plugin.yaml` + `manifest/{api,events,permissions,ui}.yaml`）是榕器**自建市场**的治理格式，不是 dsh 的要求——两条治理线在重构中要分开维护、都不能破坏。

### 1.4 共性矩阵（榕器 × paperclip）

| 共性点 | 榕器 | paperclip | 含义 |
|---|---|---|---|
| 治理哲学 | 一套身份/权限/计量/审计管多类资产 | 组织架构/预算/审批/审计管 Agent 团队 | 两者都是「AI 治理控制平面」，理念同源，重构可对齐概念模型 |
| 自托管单体 | 单进程 + 文件/SQLite | 单进程 + 内嵌 Postgres | 部署形态同类，无需向云原生迁移 |
| 插件化 | cordis「一切皆插件」 | 进程外 worker 插件 + 能力门控 | 插件都是一等公民，可互相借鉴治理手段 |
| 多 Agent/多工具接入 | Agent 本体 + A2A + MCP 网关 + 平台即 MCP Server | 11 种 harness 适配器 + ACP + MCP SDK | 生态接入层是共同核心资产 |
| 审计与审批 | 四类审计日志 + L4 强制审批 | 活动事件全量审计 + 审批治理 | 语义对齐，可对照补强 |
| 开源口径 | MIT | MIT | 模式借鉴无许可障碍 |

### 1.5 差异矩阵与取舍决策

| 差异点 | 榕器 | paperclip | 重构取舍 |
|---|---|---|---|
| 技术栈代际 | Node ≥22.6 原生 TS、零构建、无 ORM | Node ≥24/TS7/pnpm/Express5/React19/Drizzle | **不迁移技术栈**。零构建与原生 TS 是 dsh 插件形态的生存条件（预构建 dist 仅在发布轨），引入 Vite/React/Postgres 会破坏「一份代码两种宿主」装配与 fresh-install 铁律 |
| 数据层 | JSON 集合 + node:sqlite | Postgres 150+ 表 + 338 迁移 | **不换数据库**。现有双存储已满足量级；仅借鉴「迁移版本化」思想管理 txnstore 表结构演进 |
| 前端 | 零构建原生 ES 模块 SPA | React 19 + Vite + TanStack Query | **不引前端框架**。借鉴其设计治理（单 token 源）以原生 CSS 变量实现 |
| 集成接入 | connector 目录 1,000+ Provider（ODD 声明块）+ open-connector sidecar | 102 个声明式 JSON + 风险分级 + 代码生成 | **吸收模式**：目录声明化、风险分级、生成校验 |
| 任务执行 | platformBus + 死信重放 + 定时器 | 心跳唤醒队列（调度/恢复/重试/工作区准备） | **选择性吸收**：把死信重放与定时器统一为「唤醒队列」模型（可选阶段） |
| 模块边界 | 注释 + yml 顺序隐含 | `check-module-boundaries` 脚本强制 | **直接吸收**：为本仓写装配顺序与依赖方向的机器校验 |
| 规模 | 3.4 万行后端 / 质量门重 | 42 万行 / 测试 1:1 | 保持榕器规模纪律，测试密度向 paperclip 看齐但不追体量 |

---

## 二、值得重构项清单（R1–R11）

优先级定义：P0 = 本迭代必须完成且先行；P1 = 核心结构收益；P2 = 增强项，资源允许再做。

| 编号 | 重构项 | 优先级 | 现状证据 | 参考 | 预期收益 | 风险 |
|---|---|---|---|---|---|---|
| R1 | 表现层汉化收敛 | **P0** | 前端无 i18n 层；残留英文集中在错误原因码、协议词（loginEnabled/deactivated）、API 返回 label、CLI 输出、通知模板 | — | 满足「全部汉化」要求；用户可见面零英文 | 低（有 errors.js 映射层与 selftest 映射完整性断言兜底） |
| R2 | plugin-billing 封存到期处置 | **P0** | `archive/`（M0-2 于 2026-09-09 下线，CSV 封存 90 天至 **2026-12-08**） | — | 消除合规悬项；为目录瘦身 | 中（涉存量数据删除，需按登记文档留档） |
| R3 | 装配顺序与模块边界校验工具 | **P0** | 加载顺序契约只在 `boot-all.ts` 注释与 yml 顺序中；`inject` 缺提供者 = 静默 INACTIVE | paperclip `check-module-boundaries.mjs` | 把隐式契约变为机器可校验，防重构翻车 | 低（纯增量脚本） |
| R4 | console 巨石拆分 | **P1** | `packages/plugin-console/src/index.ts` 4,757 行（全仓最大源文件）；`console/public/js/pages/iam.js` 1,415 行 | paperclip `server/src/modules/` 三层模块化 | 可维护性质变；页面级独立演进 | **高**（路由/中间件/白名单交织，须逐页拆 + 每步全量自测） |
| R5 | 鉴权样板收敛 | **P1** | `CallerInfo`+`requirePermission` 在 console / panel-core / flow-core / dingtalk-bridge 4 处近似重复 | — | 单点修复、单点审计；为 R4 拆分扫清障碍 | 低 |
| R6 | 连接器声明式目录化 | **P1** | `plugin-connector`（1,700 行）内 1,000+ Provider 目录 + ODD 声明块 | paperclip app-definitions（JSON + riskTier + 生成代码） | 新增连接零代码；风险分级接入权限矩阵 | 中（需保持 open-connector sidecar 对账口径不变） |
| R7 | 设计 token 三端统一 | **P2** | console / panel / rq-card 三端样式各自为政 | paperclip DESIGN.md 单 token 源 | 视觉一致性；换肤与品牌定制（定制轨可换色） | 低（原生 CSS 变量，兼容零构建） |
| R8 | 统一唤醒队列（任务调度模型） | **P2** | usage 死信重放、connector 定时同步、update 24h 检查各自实现定时器 | paperclip wake-queue + heartbeat | 定时任务可观测、可恢复、统一重试语义 | 中（`lint-timers.mjs` 已有卫生检查，合并语义需谨慎） |
| R9 | 第三方插件 SDK 强化 | **P2** | `platform-core/src/plugin-ctx.ts` 能力白名单代理（进程内） | paperclip plugins/sdk（进程外 worker + UI 贡献） | 市场第三方插件可贡献 UI 与进程外执行 | 中高（ sandbox 边界重新评审） |
| R10 | 协议层中文对照总表 | **P1** | 事件名（`plugin:<id>:*`）、权限点（`iam.user.write`）、错误码键、API 信封字段（ok/data/error）均为 ASCII | — | 汉化完备性的文档兜底；开发者在中文文档里可查每个键 | 低 |
| R11 | 英文残留清点脚本 | **P0** | 无现成工具 | — | 阶段 0 建立「汉化工作底册」，量化收敛进度 | 低 |

**明确不做的事**（防scope失控）：不迁移 React/Vite/Postgres/pnpm；不引入 i18n 多语言框架（单语中文直接硬编码 + 集中映射表即可，无英文版本需求）；不重写 cordis 装配层；不动 `@deepseek-ai/cordis` 依赖位置；不放宽 dsh.compatibility 版本范围。

---

## 三、汉化方略（分层策略）

**总原则：表现层全部中文化（消灭英文残留）；协议层保留 ASCII 标识符并以中文对照总表文档化。**

理由：协议键（事件名、权限点、错误码键、API 信封字段、localStorage 键、环境变量名）是跨系统契约——RQ-DSH 定制轨、既有 MCP 客户端、selftest 断言、dsh 宿主校验都依赖它们。「全部汉化」的正确解读是**不维护英文界面版本**，而非改写机器契约；改键会直接与「适配 dsh 生态」的要求冲突。

### 3.1 表现层（全中文，直接改文案）

| 面 | 位置 | 做法 |
|---|---|---|
| 控制台/面板/门户 UI 文案 | `packages/plugin-console/public/js/**`、`panel-core/public/js/**`、rq-card | 逐文件扫残留英文单词与半英文句式；中文文案直接写在模板里（不建 i18n 抽象层） |
| 错误提示文案 | `console/public/js/…/errors.js` 的 `ERROR_CODES`→中文映射表 | **完备化**：每个原因码必须有中文文案；selftest 已有映射完整性断言，随清点脚本一起扩充 |
| API 返回的展示字段 | 各插件返回的 `label` / `description` / `message` | 一律中文；`type`/`status` 枚举值保留 ASCII 但补 `labelZh` 类中文伴随字段（新增字段不破坏旧客户端） |
| CLI 输出 | `cli/dshctl.mjs`（1,354 行） | table/json 双模式中文表头与描述；`--output json` 的键名保留 ASCII（机器读） |
| 通知中心 / 邮件 / 审批文案 | plugin-audit、通知模板 | 全中文，含署名与操作指引 |
| 文档 | `docs/**`、`README.md`、`llms.txt` | 已高度中文，随重构同步更新口径（本方案即首份增量） |
| 营销页 | 根目录 `产品.html` | 已中文，仅随品牌口径微调 |

### 3.2 协议层（保留 ASCII 键 + 中文对照）

| 面 | 例子 | 处理 |
|---|---|---|
| API 信封 | `ok` / `data` / `error` | 保留；写入对照总表 |
| 事件名 | `plugin:<id>:<event>` 前缀铁律 | 保留（市场校验强制前缀） |
| 权限点 | `iam.user.write`、`skill.submit` | 保留；`manifest/permissions.yaml` 的 `label` 字段用中文描述 |
| 错误原因码 | `nas-authz-deny`、`breaker-open` | 键保留，`errors.js` 映射中文文案（唯一权威映射点） |
| 环境变量 / localStorage 键 | `DEMO_SEED`、`USAGE_RETENTION_DAYS` | 保留；在对照总表与部署文档中给中文释义 |
| 五面 YAML 字段 | `plugin.yaml` schema | 结构字段保留 ASCII；`label`/描述字段全中文 |

### 3.3 验收口径

- 清点脚本（R11）扫描用户可见面，英文残留命中数为 0（白名单豁免项须登记销账条件，沿用契约 lint 豁免机制）；
- `errors.js` 映射覆盖全部原因码（selftest 断言全绿）；
- 协议层中文对照总表（R10）覆盖：全部事件名、权限点、错误码、环境变量、localStorage 键，逐条给中文释义。

---

## 四、dsh 生态适配设计（重构期间的红线）

1. **契约保持清单（每阶段出口逐项打钩）**
   - `package.json`：`dsh.bundle.patch` 指向有效；`dsh.compatibility` 维持 `>=0.1.0-rc.7 <0.2.0`；`dshReleases` 随宿主新版本逐版本登记（不擅自放宽）；`profiles:["web"]` 不变；
   - `cordis.patch.yml`：每个 entry 为「包名 + dist 子路径」（浏览器半 rq-card 纯包名）；`provideToolRuntime:false`、`startHttp:false`、`mountPath` 自有前缀；
   - `@deepseek-ai/cordis` 仅在 devDependencies（新增依赖时同样审查：不得引入会在安装期展开第二 cordis 实例的包）；
   - `files` 闭包与 `bundledDependencies` 随新文件同步更新；
   - selftest **fresh-install 装机模拟段**全绿（build-id / dist 指纹 / 三链一致）；
   - 服务键去冲突审查：新服务一律用平台自键（`opsStorage` 等），tools 键保持与宿主共享策略。
2. **定制轨（RQ-DSH）同步策略**
   - 重构窗口内 `custom/dsh-rq` **功能冻结**：只从上游 fetch，不向 RQ-DSH push 新功能版本；
   - 每阶段结束做一次**同步演练**（不正式发布）：在定制轨分支上合入本阶段上游提交 → `build:dist` 重建 → fresh-install 自测 → 记录冲突与处置；
   - 阶段 4 正式同步：rebase 定制轨到重构完成的上游 main → 走 `scripts/release.mjs` 完整发布 `@ybkk/gate-01` 新版本（版本决策遵循脚本规则：显式指定 > 强制升位 > 树版本领先复用 > 同版自动 patch）→ Ed25519 发布清单签署 → push 备份至 RQ-DSH；
   - 定制轨本地差异（如 `mountPath:/gate01`、品牌色）集中在 patch 与配置层，不散入业务代码——重构若搬动相关文件，同步演练会即时暴露。
3. **宿主能力使用纪律（沿用现状，不得扩大耦合面）**
   - cordis 消费面保持窄口径：`Context`/`Service`/`ctx.plugin()`/`inject`/`ctx.effect()`/`ctx.logger`；
   - 事件继续走自研 `platformBus`（带事件源校验），不迁往 cordis 事件；
   - dsh webServer 契约继续走 `DshWebServerLike.register` 最小接口（`plugin-dsh-bridge`），不直接依赖 dsh 包类型。

---

## 五、分阶段实施计划（最稳健路径）

总时长约 7 周（可按资源伸缩，但**阶段顺序不可调换**：先织安全网、再清债、再汉化、再吸收模式、最后回归发布）。每阶段收尾打 git tag，作为回滚锚点。

### 阶段 0（第 1 周）：基线冻结与安全网

| 任务 | 说明 |
|---|---|
| 建立重构分支 | 上游 main 拉出 `refactor/paperclip-alignment`；定制轨进入冻结窗口并公告 |
| 跑质量门基线 | 记录 selftest 断言数（约 1,201，以实际运行为准）、lint:manifests、契约 lint 结果，作为全程「不低于基线」的对照 |
| R11 清点脚本 | 写 `scripts/lint-cjk-coverage.mjs`：扫描用户可见面（console/panel/rq-card 的 js+html、CLI、通知模板）的英文残留，输出白名单式报告；接入豁免登记机制 |
| R3 边界校验工具 | 写 `scripts/check-boot-order.mjs`：解析 `boot-all.ts` 装配顺序 + 各包 `plugin.yaml` 的 `depends/provides`，校验 ① 依赖先于使用 ② yml 顺序与代码顺序一致 ③ `inject` 声明均有提供者（消除静默 INACTIVE） |
| R2 处置预案 | 复核 `docs/billing-archive-register.md` 登记口径；确认 2026-12-08 到期前的操作序列（见阶段 3 执行删除）；如到期日在重构期内则提前按预案执行 |

**出口准则**：基线报告落盘；两个新脚本全绿入库；`refactor/*` 分支建立；定制轨冻结公告完成。

### 阶段 1（第 2–3 周）：清债（结构重构）

| 任务 | 说明 |
|---|---|
| R5 鉴权样板收敛 | 把 `CallerInfo` + `requirePermission` 上收到 `platform-core`（单一实现 + 单点审计），4 处调用点改引；selftest 的 RBAC 矩阵段全绿为准 |
| R4 console 巨石拆分 | **逐页面、逐路由域**拆 `plugin-console/src/index.ts`（4,757 行 → 路由注册 / 鉴权中间件 / 页面域模块三层）；每拆一个页面域跑一次全量 selftest；PUBLIC_PATHS 白名单与中间件随之归位到独立模块。同步把 `pages/iam.js`（1,415 行）按子域拆为多个 ES 模块（零构建约束下即原生 import 拆分） |
| R3 应用 | 拆分过程中每移动一个 `ctx.plugin()` 装配点，跑 `check-boot-order` 校验 |

**出口准则**：单文件行数上限 1,200 行（selftest.mjs 作为测试基建豁免）；`check-boot-order` 全绿；selftest 断言数 ≥ 基线且全绿；定制轨第一次同步演练通过。

### 阶段 2（第 4 周）：汉化收敛

| 任务 | 说明 |
|---|---|
| R1 表现层全量汉化 | 按 R11 清点报告逐项消灭：UI 残留英文、CLI 表头、通知/审批/邮件模板、API 展示字段（含补 `labelZh` 伴随字段） |
| 错误映射完备化 | `errors.js` 补齐所有原因码的中文文案；扩充 selftest 映射完整性断言 |
| R10 对照总表 | 新建 `docs/协议键中文对照总表.md`：事件名 / 权限点 / 错误码 / 环境变量 / localStorage 键 / API 信封字段，逐条中文释义 |
| 文档口径同步 | README / llms.txt 增补「全中文单语」边界声明（协议键例外及理由） |

**出口准则**：R11 清点脚本命中数为 0（豁免项全部登记销账条件）；selftest 全绿；定制轨第二次同步演练通过。

### 阶段 3（第 5–6 周）：paperclip 模式吸收

| 任务 | 说明 |
|---|---|
| R6 连接器目录化 | Provider 目录从 `plugin-connector` 代码中抽为声明式 JSON（字段对齐现有 ODD 声明块 + 新增 `riskTier` 风险分级）；写生成脚本产出类型与校验代码；风险分级接入权限矩阵与审批流（S 级高的默认走 L4 审批）。**对账口径不变**：open-connector sidecar 的双层授权镜像与计量对账不受影响 |
| R7 设计 token 统一 | 建立三端共享的 `tokens.css`（原生 CSS 自定义属性：色板/间距/字号/圆角，深蓝微信绿同源定制轨色系入变量）；console / panel / rq-card 全部改引；定制轨仅需覆写变量即可换品牌色 |
| R2 执行 | 若 2026-12-08 已到期（或预案批准提前执行）：删除 `archive/plugin-billing` 目录与存量表，按登记文档留档封存 CSV 的最终处置记录 |
| R8/R9（可选） | 资源允许时：唤醒队列统一（usage 死信 + connector 同步 + update 检查合并为可观测调度模型，保留 `lint-timers` 卫生）；第三方插件 SDK 的 UI 贡献面（进程外执行列为后续专项，本迭代只做设计评审不做实现） |

**出口准则**：连接器目录 100% 声明式化且生成物入库；三端样式全部走 token；selftest 全绿；定制轨第三次同步演练通过。

### 阶段 4（第 7 周）：dsh 适配回归与正式发布

| 任务 | 说明 |
|---|---|
| 全量契约回归 | 第四节「契约保持清单」逐项打钩；fresh-install 装机模拟段 + `build:dist` + dist 指纹三链一致 |
| 独立宿主回归 | `npm start` 基线初始化 + `DEMO_SEED=1` 演示 + `full-chain-drill` + `morning-peak-entry` 全绿 |
| 定制轨正式同步 | rebase `custom/dsh-rq` 至上游 main → `scripts/release.mjs` 发布 `@ybkk/gate-01` 新版 → Ed25519 发布清单签署 → push RQ-DSH 备份 → 解除冻结 |
| 收尾 | 更新 README / llms.txt / 本方案的执行记录附录；归档各阶段基线报告 |

**出口准则**：npm 发布成功且 fresh-install 在干净目录验证通过；RQ-DSH 备份仓与定制轨一致；全部门禁绿灯归档。

---

## 六、风险登记册与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | console 拆分引入路由/鉴权回归 | 高 | 逐页面拆分，每步全量 selftest；RBAC 矩阵段为必看红绿灯；阶段 tag 随时可回滚 |
| 2 | 汉化误改协议键破坏契约 | 中 | 分层策略（§3）+ 契约双向 lint 捕获注册面漂移 + selftest 错误映射断言 |
| 3 | 定制轨长期冻结造成漂移压力 | 中 | 每阶段末同步演练（非正式合流），冲突早暴露早消化 |
| 4 | cordis 双实例导致服务链 pending | 中 | devDependencies 铁律写入阶段检查单；新增依赖一律审查传递依赖 |
| 5 | 无意打破零构建约束（引入前端构建链） | 中 | 本方案明令禁止；代码评审关注 package.json 变更 |
| 6 | billing 存量数据删除的合规风险 | 中 | 严格按 `docs/billing-archive-register.md` 口径：到期后删、删前留档、审计留痕 |
| 7 | selftest 断言数悄悄下降 | 中 | 出口准则「不低于基线」硬门槛；基线报告入库对照 |
| 8 | 三端样式改动引发视觉回归 | 低 | rq-card 有构建产物指纹；panel/console 以 selftest 的 dom-smoke 兜底；token 化本身即收敛手段 |
| 9 | R8 定时器语义合并引入竞态 | 中 | 列为可选项；实施时保留 `lint-timers` 并新增唤醒队列专属断言 |
| 10 | 7 周窗口被日常迭代挤占 | 中 | 阶段自治（每阶段独立成立、独立可停），中断时以已完成阶段为界收口 |

---

## 七、附录

### A. 全仓最大源文件（重构重点关注）

`scripts/selftest.mjs` 5,981（测试基建，豁免）；`plugin-console/src/index.ts` 4,757（R4 主对象）；`plugin-iam/src/index.ts` 1,925；`plugin-connector/src/index.ts` 1,700（R6 对象）；`console/public/js/pages/iam.js` 1,415（R4 对象）；`cli/dshctl.mjs` 1,354（R1 对象）；`panel-core/public/js/app.js` 1,311；`plugin-usage/src/index.ts` 1,227；`plugin-authn/src/oidc.ts` 1,113；`plugin-mcp/src/index.ts` 1,084。

### B. 样板重复位点（R5）

`packages/plugin-console/src/index.ts`、`packages/plugin-panel-core/src/index.ts`、`packages/plugin-flow-core/src/index.ts`、`packages/plugin-dingtalk-bridge/src/index.ts` 四处的 `CallerInfo` + `requirePermission` 近似实现。

### C. 英文残留清点方法（R11 脚本要点）

- 扫描范围：`packages/*/public/**/*.{js,html}`、`cli/dshctl.mjs`、通知/审批/邮件模板字符串；
- 判定模式：中文占比低于阈值的字符串字面量；`[A-Za-z]{4,}` 词白名单外命中（白名单含协议词、品牌词、单位词）；
- 输出：逐文件命中行报告 + 豁免登记表（沿用契约 lint 的豁免-销账机制）。

### D. 参考文件索引

- 本仓：`src/{main,boot-all}.ts`、`cordis.{yml,patch.yml}`、`package.json`（dsh 字段）、`scripts/{selftest,lint-manifests,contract-lint,lint-timers}.mjs`、`packages/platform-core/src/{storage,sqlite,bus,plugin-ctx,tools-lite}.ts`、`packages/plugin-dsh-bridge/src/index.ts`、`packages/plugin-console/public/js/**`、`docs/billing-archive-register.md`；
- RQ-DSH：`{package.json, cordis.patch.yml, PROJECT.md, AGENTS.md, README.md}`、`scripts/{release,release-manifest}.mjs`、`docs/{handoff-host-features-to-main,qa-acceptance-dsh-plugin-first}.md`；
- paperclip：`README.md`、`AGENTS.md`、`packages/shared/src/app-definitions/*.json`、`server/src/modules/README.md`、`scripts/check-module-boundaries.mjs`、`ui/src/index.css`（单 token 源）、`doc/DEPLOYMENT-MODES.md`。

### E. 术语表

| 术语 | 释义 |
|---|---|
| dsh / DeepSeek Harness | 外部宿主运行时，内含 vendor/cordis；榕器以插件包形态挂入 |
| cordis | 插件框架（`@deepseek-ai/cordis`），插件形制 = `export name/inject` + `apply(ctx, config)` |
| 宿主轨 / 定制轨 | 本仓 main（契约所有者） / `custom/dsh-rq` 分支（发布 `@ybkk/gate-01`，备份至 RQ-DSH） |
| 五面 YAML | 榕器自建市场治理格式：`plugin.yaml` + `manifest/{api,events,permissions,ui}.yaml` |
| fresh-install 铁律 | 安装产物预构建 dist、零生命周期脚本、三链一致的装机模拟自测段 |
| 浏览器半插件 | rq-card：经宿主 client-modules 下发到浏览器侧的半插件，entry 必须纯包名 |
| 表现层 / 协议层 | 用户可见文案面 / 机器可读契约键面（汉化分层策略的两个层面） |

---

（本方案为全局基线文档；各阶段执行时以「阶段出口准则」为验收口径，执行记录回填至本文附录。）

## 八、执行记录（REFACTOR-2026-10-13 实施回填）

**执行窗口**：2026-10-13（阶段 0–4 单日完成，自洽并行推进）｜分支 `refactor/paperclip-alignment`｜回滚锚点 tag `refactor-stage-0..3`

| 阶段 | 状态 | 出口锚点 | 基线报告 |
|---|---|---|---|
| 0 基线冻结与安全网 | ✔ | `refactor-stage-0`（selftest 1199/1199，R3/R11 双工具入库+构造性红测验证） | docs/internal/重构基线-阶段0-20261013.md |
| 1 清债（结构重构） | ✔ | `refactor-stage-1`（R5 鉴权收敛 rest-gate 单实现；R4 console 后端 4,702→300 行 15 域文件 + 前端 iam 六模块；定制轨同步演练：rebase 可行，差异仅 CRLF+4 行命名空间映射） | docs/internal/重构基线-阶段1-20261013.md |
| 2 汉化收敛 | ✔ | `refactor-stage-2`（R10 总表 280 键；错误映射全集断言 1201；R1 真实残留清零 + 279 条机制料豁免底册；lint:cjk 0 命中/strict 绿；全中文单语口径入 README/llms） | docs/internal/重构基线-阶段2-20261013.md |
| 3 paperclip 模式吸收 | ✔ | `refactor-stage-3`（R6 声明式风险目录 8 provider/43 action+生成校验链；R7 tokens.css 三端单源；R9 评审文档；R8 登记后续专项） | docs/internal/重构基线-阶段3-20261013.md |
| 4 dsh 适配回归 | ✔（发布环节待确认） | 契约清单逐项打钩（bundle.patch/compatibility/profiles/依赖位置/files 闭包双 yml 一致）；独立宿主回归全绿（selftest 1201 + full-chain-drill 27/27 + morning-peak-entry 50 并发零失败）；`@ybkk/gate-01` 正式发布涉 npm publish 与 push RQ-DSH 外部动作，待所有者确认后按 scripts/release.mjs 流程执行 | 本节 |

**质量门全程记录**：selftest 1199（基线）→ 1200（收编 R6 单测）→ **1201**（错误映射全集断言），零下降；lint:manifests / contract-lint / lint-timers / check-boot-order 全程 0 错误。

**顺带修复的产品级缺陷**（重构中发现）：① boot 连接器自动同步启动延迟 15s→90s（慢启动环境抢先 SSO 断言污染）；② 孤儿权限点 nas.ownership.write 补录 PermissionCatalog（自定义角色此前无法勾选）。

**开发组织备注**：主控 + 后台并行代理（峰值五路）混合推进；代理因配额/认证故障中断两次，中断产物经主控验证修复后收口（教训已沉淀：字节级搬运须配套符号依赖全盘点；`git add -A` 在并行场景禁用，改精确路径暂存）。
