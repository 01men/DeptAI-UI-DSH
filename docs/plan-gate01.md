# plan-gate01 —— 「01门」架构改造计划（定版·实施完成）

> 状态：**定版·实施完成**（2026-09-10）。Phase 0–6 全部落地，每批 selftest 全绿推进；
> 真机实装验证（gate01-smoke profile，dsh 0.1.2-alpha.5）通过：四通道安装→启动→演示看板→
> 连接向导→写边界（403/401/503）→插拔→重装恢复全链闭环（浏览器截图验收）。
> 实施修订记录（相对本稿的偏差，全部有据）：① Phase 2.5 值导入内联——仅 rq-card 执行
> （defineTool 内联为 src/tool.ts；panel-core 在 gate-01 包内跨包相对导入成立，无需内联），
> 真机 ERR_MODULE_NOT_FOUND 实证；② Phase 3 files 清单修正——原稿漏列 packages/plugin-dsh-bridge，
> 真机装机暴露后补齐，并加 bundledDependencies 打包 rq-card（file: 依赖在 npm/tgz 通道不可移植）；
> ③ plugin-dsh-bridge inject 8→3 键（底座面受控漂移，F 清单 J 节）——4-entry 形态下
> entryTickets/oidc/iam/authn/audit 无提供者即永久挂起，运行期五处软访问改 ctx.reflect/softRead；
> ④ 演示首启直达看板：demoAuth 装态探测（只读 API 匿名可达）→ 直接进看板 + 横幅引导，
> seedPanel(ctx, autoDemo) 自动播种演示内容 + DEMO_ORG_ID 演示组织兜底。
> 产品定义：本项目（01men/RQ-DSH，分支 custom/dsh-rq）唯一交付物——**01门**：AI 代理与人类的协作前台。
> 关联：`docs/plan-dsh-plugin-first.md`（前序定版）、`docs/handoff-f-remainder-to-main.md`（G3/F 清单）、`AGENTS.md`（同步铁律）、`docs/positioning-rq-dsh-panel-project-20261019.md`（项目定位决策）。

---

## 一、目标形态（定版）

1. **一键安装**：cordis 插件形态装进 dsh，四通道可用——`dsh plugin add github:01men/RQ-DSH`、`dsh plugin add @ybkk/gate-01`（npm）、`link:`、`file:`。安装→启动→打开 `http://127.0.0.1:<端口>/gate01/panel/` **直接见到演示看板**（内置 scenegraphs 演示数据），向导常驻引导连接宿主。
2. **连接宿主**：本机（localhost 预填 + 端口探测）/ 远端地址统一为「连接宿主」流程；连接后面板/看板/卡片数据全量指向宿主（经本机代理，浏览器零跨域），登录在宿主侧完成。
3. **插拔**：`dsh plugin remove` 卸载干净；重装即恢复。
4. **G3 自解（限 01门产物）**：预构建 `dist/*.js` 提交入库，安装形态不再依赖 node_modules 内 TS 装载。底座面包的 G3 仍在交接清单挂起，与本产物无关。

### 产物构成（根包 `@ybkk/gate-01`）

| entry | 来源包 | 角色 | 改造 |
|---|---|---|---|
| ops-platform-core | packages/platform-core（底座面，**原样随附**） | httpServer/opsStorage/platformBus/tools/scenegraphs 服务基座 | 不改代码，仅改装配 config（externalBase:/gate01） |
| ops-dsh-bridge | packages/plugin-dsh-bridge（底座面，**原样随附**） | `/gate01` 前缀挂进 dsh webServer | 不改代码，mountPath:/gate01 |
| ops-panel-core | packages/plugin-panel-core（面板面） | 面板 REST + SPA 托管 + 演示数据 | inject 瘦身 + 鉴权配置标志化（demoAuth）+ 演示端点 |
| rq-card | packages/plugin-rq-card（面板面） | dsh 会话注入 + /gate01/rqcard/* 向导/代理 | 去 iam/authn + 删本机初始化 + 品牌 |
| （不随附） | plugin-dingtalk-bridge | 宿主侧胶水（需 iam/audit），留仓库与全量开发形态 | 移出安装产物 |

**不改清单**（避免撞底座面/回归矩阵）：
- 内部 API 命名空间 `/api/panel/*`、`/rqcard/*`——`/api/panel/stream` 在 plugin-console 的 PUBLIC_PATHS 白名单（底座面文件，禁改）；
- 插件内部服务名（panel/cardpacks）、entry id、RBAC 权限点位、manifest 端点名；
- console 等底座面包任何文件；README.md（底座面，产品声明写 AGENTS.md/PROJECT.md/docs）。

---

## 二、现状架构分析（探索结论 2026-09-10；当日架构审查复核：论断抽查 12 处回源全部命中，本节按审查意见修正 2 处）

### 2.1 面板面对底座面的耦合点

**编译期（相对路径源码 import）**——值导入全集（审查修正：原稿「ACTIVITY_LABELS 唯一根因」不准确）：
- panel-core → platform-core：`PlatformEvents`（index.ts:22、service.ts:24）、`newId`（index.ts:23、service.ts:27、seed/seed.ts:14）、`ACTIVITY_LABELS`（service.ts:26，引自 scenegraph.ts）；类型导入（HttpExchange/Collection/SceneActivity 等）可剥离；
- rq-card → platform-core：`defineTool`（index.ts:29）；hostlink.ts 仅类型导入；
- dsh-bridge → platform-core：仅类型导入（HttpServerService）；
- dingtalk-bridge：storage/bus/ids 值导入（不随附，不影响产物）。
- 结论（审查修正）：4 个值绑定均为叶子级纯值（事件名常量 + 小工具函数），**全集内联/复制即可整体拆除编译约束**（可选清理，见 Phase 2.5）。platform-core 的随附理由本就不在编译期——真正的约束是**运行期服务基座**：它是 httpServer/opsStorage/platformBus 的装配源、scenegraphs 服务（ScenegraphService，scenegraph.ts:122）与演示数据源的唯一提供者。patch 配置决策以此为准，不依赖编译耦合。安装形态仍需保持 `packages/*` 兄弟目录布局（安装形态整包落在 node_modules/<根包> 下，相对路径天然成立）。

**运行期服务键（cordis inject，加载期硬依赖，缺一即永久挂起）**——panel-core/src/index.ts:35 注释与 cordis.yml 文件头「服务链全部 pending」记录双重佐证：
- panel-core 14 键（`src/index.ts:30-34`）：httpServer/opsStorage/platformBus/tools（platform-core 或 dsh 原生）+ iam/authn/audit/usage/modelGateway/resourceCore/scenegraphs/behavior/mcpRegistry/skillHub（底座面包）。usage/behavior/mcpRegistry 已有 try/catch 请求级降级（`index.ts:344-359`），但 **inject 是装载级，降级不减少装载要求**；且审查实证降级覆盖面远小于访问面：**同一 board 处理器内 :368-372 裸访问 ctx.resourceCore/ctx.skillHub/ctx.mcpRegistry（无保护）、:330 裸访问 ctx.iam、changeLog（:90）的 ctx.audit.record 被全部写端点调用**——瘦身必须全量清扫，漏一个点即运行期 500。
- rq-card 5 键（`src/index.ts:83`）：httpServer/tools/opsStorage + **authn/iam（仅 localInitAdmin 用）**——审查复核：hostlink.ts 全文 370 行，authn/iam 共 6 处访问全部位于 :318-353 本机初始化段，属实。
- dingtalk-bridge 6 键：含硬依赖 panel 服务键 + iam/audit。

**鉴权链**：`/api/panel/*` 身份层在 console 中间件（`plugin-console/src/index.ts:161-186`，写 `exchange.principal`）；panel 自带权限层 requirePermission（`panel-core/src/index.ts:60-84`）直接读 `exchange.principal`（:57-62）。console 缺位 → principal undefined → TypeError → 500（fail-closed 但无干净 401，且无法登录）。**审查增补**：鉴权放行不得靠运行时探测「authn 在场」——探测无法区分「形态性缺席」（01门，该放行）与「请求性缺席」（全量形态中间件未覆盖/装配顺序变化，绝不能放行），后者 fail-open 真实数据＝安全语义反转；方案见 Phase 2.2 配置标志。
**前端借用**：面板 SPA `public/js/deps.js:20-27` 运行时借用 console 静态资产 `/js/ui.js`（toast/modal）与 `/js/realtime.js`（SSE+30s 轮询）——纯前台形态必须自持。
**形态 B 死路**：`localFirstRun` 判定依赖 console seed 写的 `admin-initial-password.txt`（`hostlink.ts:293-299`；console `src/seed.ts:39-43`）；纯前台形态下该文件不存在 → 向导退化为「本机已就绪」+ 指向不存在的本机 console 登录页，误导死路。

### 2.2 安装链与 G3

- cordis.patch.yml 22 entry 全部声明 `dsh-enterprise-ops/packages/*/src/index.ts`（TS 直载）；拷贝安装（github:/file:）下 Node ≥22.6 拒绝对 node_modules 内 TS 类型剥离（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）→ 全部 entry 不可执行（`docs/plan-dsh-plugin-first.md` §6.2 真机实测定版；交接清单 G3，上游未落地）。
- TS 语法面：全 packages/*/src **纯可剥离**（enum/namespace/参数属性/装饰器零命中）；相对导入带显式 `.ts` 扩展；无 tsconfig；import.meta 共 7 处全部用于资产目录解析（Node ESM 无碍）。
- 构建工具链：唯一构建器是 rq-card 浏览器半 `build.mjs`（esbuild，cjs/browser/es2024 + purityGate）；esbuild 探测链已含仓内 node_modules 回退（`build.mjs:88-104`，:95 仓内候选）；仓内 devDependencies 无 esbuild/typescript。`lib/client.js` 随 git 入库（有意为之）。**审查增补**：esbuild transform 为单文件转译，**不做模块解析、不改写说明符**——dist 形态的路径改写必须是独立的一等构建步骤（Phase 1.2）；`export * from './*.ts'` 形态普遍存在（platform-core/src/index.ts:19-30 共 12 条、rq-card index.ts:32/34、panel-core index.ts:26），与 import 同为**改写项而非核查项**；运行时动态相对导入在 4 随附包零命中（grep 命中的 `import('…')` 均为类型位写法，转译时剥离）。
- selftest 装机段（`tests/selftest.mjs:595-782`）：entry 逐个解析导入（:600-627，**对 dist/*.js 形态天然兼容**——纯前缀剥离+existsSync+真实 import）；三链一致（:629-646，硬编码 ≥20）；build-id 指纹（:648-654）；files 覆盖（:656-675，六项清单断言）；浏览器半 vm 真执行（:677-777）；plugin.yaml↔manifest 成对（:778-781，≥15）。
- dsh 侧 bundle 语义（`D:\DSH\deepseek-harness\packages\boot\app-boot` 实证）：任意已装依赖声明 `dsh.bundle.patch` 即自动并入 profile bundle 层栈；多层 patch 展平按序应用，insert 累加、id 定向整替 config——本计划不依赖多包叠装（01门自足），但该语义保证与底座轨产物互不干扰（分 profile/分进程使用）。

### 2.3 连接向导现状（本项目包自持，零依赖底座面）

- `/rqcard/*` 端点全在 plugin-rq-card（`src/index.ts` + `hostlink.ts`）：link/local/remote/reset/scan + proxy 中间件 + `rq_host_status` 工具；免登依据=console 只拦 `/api/*`；CSRF 防线 `x-rqcard-call`。
- 连接配置：`<dataDir>/rq-host-link.json`（0600，`hostlink.ts:121,357-369`，mode none|local|remote）；远端会话令牌全在浏览器 localStorage（`api.js:31-53`，按 hubBase 隔离），服务端不存令牌。
- 形态 C 代理：白名单（`hostlink.ts:59-80`）放行 auth 族 + `/api/panel/*`，显式拒绝 SSE（前端 30s 轮询降级）；SPA 启动探 `/rqcard/link`，remote 态把 `/api/*` 全量重写 `/rqcard/proxy/api/*`（`boot.js:127-131`、`api.js:34-36`）——**本地 panel-core 业务逻辑在形态 C 下是纯旁路**。
- plugin-connect 与向导无关（两条平行通道：机器凭证 vs 浏览器会话）。

---

## 三、已确认决策记录（2026-09-10 用户拍板）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 本机宿主语义 | **彻底移除本机初始化**（形态 B 设口令全链路删除）；本地/远端统一「连接宿主」，本机=localhost 连接目标（预填+探测） |
| 2 | 无宿主首启体验 | **内置演示看板**：未连接时本地只读渲染 scenegraphs（qb01/gcjx）+ seed 演示内容，向导常驻；连接后切真实数据 |
| 3 | 发行通道 | **双通道**：预构建 dist 提交进 RQ-DSH main（github: 直装）+ npm 发布。包名 @01men scope（根包 `@ybkk/gate-01`；若要裸名 `01men` 实施前一句话可调） |
| 4 | 命名深度 | **技术标识一并改**：根包名、@dsh-ops→@01men scope、挂载 `/rq`→`/gate01`、localStorage 键、数据文件名（范围见「不改清单」） |

---

## 四、实施计划（2026-09-10 架构审查重排：Phase 0 前置 + 硬顺序约束）

> **硬顺序约束（违反即装机门禁假红）**：cordis.patch.yml 收缩（Phase 3）必须在 inject 瘦身（Phase 2）完成之后——4 entry 形态下 iam/authn/audit/usage/modelGateway/resourceCore/behavior/mcpRegistry/skillHub 九键无提供者，inject 未瘦身的 panel-core 与 rq-card 将在装载期永久挂起，`/gate01/panel/` 不可达。

### Phase 0 前置 spike：cordis 可选服务语义（全局设计输入）

**未出书面结论不得启动 Phase 1。** inject 收缩的可行性决定后续所有 Phase 的设计。

1. 实证 vendor/cordis 两类语义：inject 声明但无提供者（挂起 vs 抛错）；未声明键的 `ctx.<key>` 运行期访问（undefined vs 抛错 vs pending）。
2. 产出书面结论 + 选定降级模式（可选 inject / null-object 适配 / 条件装配子插件拆分）。若结论＝「无法在保持 apply 执行的前提下声明可选依赖」→ 回到设计：拆分为多个子插件、各自声明不同 inject 集，patch entry 数、三链断言、plugin.yaml depends 全部随之改。
3. 本 spike 是最大的架构不确定性，成本极低（探针脚本），必须先清，不留到实施中期。

### Phase 1 地基：改名 + 预构建链（patch 暂不收缩，机械改造）

1. **改名清扫**：
   - 根包 `dsh-enterprise-ops` → `@ybkk/gate-01`（package.json name/repository）；
   - 本项目包 scope `@dsh-ops/*` → `@ybkk/*`（3 个 workspace 包名 + 根 dependencies + `src/boot-all.ts` 对应 3 行 import——与上游漂移，登记 F 清单）；
   - 挂载前缀 `/rq` → `/gate01`：cordis.yml/patch 的 `externalBase`、`mountPath`、`wire.ts` 常量（CONSOLE_BASE/PANEL_URL/LINK_ENDPOINT/FEEDBACK_ENDPOINT）、SPA BASE 推导；
   - localStorage 键**全部 `heng_ops_*`** → `gate01_*`（`api.js` token/refresh/user、`app.js:577` heng_ops_landing——审查补漏，heng_ops 共 17 处命中）；`panel_hub_history` 同步；
   - 数据文件 `rq-host-link.json` → `gate01-host-link.json`（`hostlink.ts`；不做旧文件迁移，重连一次即可）；
   - **grep 兜底**（审查增补）：`dsh-enterprise-ops`、`@dsh-ops`、`/rq`（word-boundary）在 scripts/、docs/、tests/ 的残留逐处定性（改/豁免并注明）。
2. **预构建链**（路径规范化为一等构建步骤，审查修正「核查」表述）：
   - devDependencies 加 esbuild；新增 `scripts/build-dist.mjs`（探测/门禁风格复用 rq-card build.mjs；esbuild 解析回退链已含仓内 node_modules，build.mjs:95）；
   - 流程：拷贝随附包 src → 临时树 → esbuild transform 逐文件 → **文本级路径规范化**：改写三种静态说明符形态（`import…from` / `export…from` / `export * from`）的相对 `.ts` → `.js` → **零残余 fail-closed 断言**（产物残留任何 `.ts` 说明符即构建失败）。规范化只作用于 dist 副本；源码树保持 `.ts` 说明符（源码开发形态依赖）；
   - **非 TS 资产同布局拷贝**（`src/seed/demo-content.json`——seed.ts:73 import.meta 同级解析，esbuild 不拷贝 JSON），纳入 `dist/.build-id` 指纹（src 树 sha256，机制仿 `build-id.mjs`）；
   - 产物提交入库；`npm run build:dist`。
3. **selftest 新增 dist 新鲜度断言**（`dist/.build-id` vs 重算）——patch 未收缩前即独立生效。
4. AGENTS.md 装机铁律补一条：改随附包 src 忘跑 `build:dist` = selftest 红（与浏览器半 build-id 同规格）；「标准同步节奏」代码块同步补 `build:dist`（上游 merge 碰 platform-core src 即令 dist 过期）。

**门禁**：`npm run selftest` + `npm run lint:manifests` 全绿（含新 dist 断言）；`pnpm pack --dry-run` 核对（零生命周期脚本）。

### Phase 2 解耦（22 entry 全量形态不动，每步保持 selftest 绿）

1. **panel-core 瘦身**（`src/index.ts:30-34`）：inject 收缩为 `[httpServer, opsStorage, platformBus, tools, scenegraphs]`；iam/authn/audit/usage/modelGateway/resourceCore/behavior/mcpRegistry/skillHub 按 Phase 0 结论降级，**两级模式（审查修正：不写满地 try/catch）**：
   - 记录/查询类（audit/usage/behavior）：**null-object 适配**（空记录、查询返回空聚合），业务代码与全量形态断言面零惊扰；
   - 能力类（modelGateway/resourceCore/mcpRegistry/skillHub/iam/authn）：特性级降级（端点 503 DEGRADED 或向导隐藏入口）；
   - 交付物附 `ctx.<9 键>` **访问点清扫台账**（grep 全量逐点定性；已知裸访问点：index.ts:368-372、:330、changeLog :90——审查实证）。
2. **鉴权自适应＝配置标志 fail-closed（审查修正：替代运行时探测）**：panel-core 新增 config 标志 `demoAuth`（**缺省 false＝严格**）；演示放行仅限 `demoAuth:true` 且 method ∈ {GET, HEAD, OPTIONS}，写动词在演示态返回干净 403/401；principal 兜底守卫——auth 开启但 principal 缺失时返回干净 401，不得 TypeError（:57-62）。全量形态 RBAC 矩阵 selftest 断言必须保持绿。
3. **rq-card 瘦身**：inject 去 authn/iam（`src/index.ts:83`）；删除 localInitAdmin/localFirstRun/`/rqcard/local-init*` 全链路（`hostlink.ts:293-353`、`src/index.ts:157-171`）及向导对应 UI（`wizard.js:93-129`）；连接流程统一为：地址输入（127.0.0.1 预填 + 7300/3080 探测 + 既有 /24 扫描）→ probe → 登录；探测到本机数据面（全量开发形态）时显示「本机控制台登录」链接。
4. `plugin.yaml` depends 同步修正（现与 inject 漂移：缺 authn/resource-core/behavior）。
5. **（可选）platform-core 值导入全集内联**（审查增补）：PlatformEvents/newId/ACTIVITY_LABELS/defineTool 四绑定复制进本项目包（纯叶子值），彻底拆除编译期耦合，为「demo 不依赖 scenegraphs 时 platform-core 整体退出产物」留路；副本与上游的漂移登记 F 清单，merge 后 diff 核对。**不执行不影响后续 Phase。**
6. selftest 新增：「4 键形态（config 模拟）下 board 端点不 500」断言（审查增补）。

**门禁**：22 entry 全量形态 selftest 全绿（含 RBAC 矩阵 + 新断言）。

### Phase 3 产物收缩：patch 4×dist + files + 装机段重写（前置条件：Phase 2 完成——硬顺序约束）

1. **cordis.patch.yml 收缩为 4 entry 全指向 dist**：ops-platform-core（provideToolRuntime:false/startHttp:false/externalBase:/gate01）、ops-panel-core（**demoAuth:true——仅本 patch 声明**，cordis.yml 与全量形态永不声明）、ops-dsh-bridge（mountPath:/gate01）、rq-card（包名 `@ybkk/plugin-rq-card`）。
2. **rq-card `exports['.']` → `./dist/index.js`**；**两形态统一包名**（审查修正：删除原稿「cordis.yml 改显式 src 路径」方案——cordis.yml:80-84 已记录 spike §4.2：文件路径会被 client-modules 负判为「非 client 包」且永久缓存）；`build:dist` 纳入开发重建仪式（与浏览器半 build-id 同规格，selftest 新鲜度断言覆盖）；核对 `exports['./*']` 子路径映射在 dist 形态下的去向；client-modules 的 require.resolve 与 dsh.client 声明不动。
3. **cordis.yml（源码开发形态）保持全量 22 entry**，仅同步改名/改路径。
4. **files 收缩**（根 package.json）：`[cordis.patch.yml, packages/platform-core, packages/plugin-panel-core, packages/plugin-rq-card, README.md, LICENSE]`——scenegraphs（platform-core 内）、cardpacks/seed/SPA（panel-core 内）、lib/client.js 与 dist（rq-card 内）、各包 dist 随包目录自然覆盖；其余宿主包与根 src 不再进安装产物（独立宿主 `npm start` 全量形态仅源码检出支持）。
5. **selftest fresh-install 段重写**（`tests/selftest.mjs:595-782`）：
   - entry 前缀解析 `dsh-enterprise-ops/` → `@ybkk/gate-01/`；
   - 三链规则改为：**patch(4) id 集 ⊆ cordis.yml(22)** + **boot-all ↔ cordis.yml 服务面双射维持不变**（DSH_ONLY 豁免集保留）；
   - files 断言按新清单重写；去掉 ≥20/≥15 硬编码，改为精确集合断言；
   - 浏览器半 vm 执行段、RBAC 矩阵段不动。

**门禁**：`npm run selftest` + `npm run lint:manifests` 全绿；`pnpm pack --dry-run` 核对产物清单（files 生效、零生命周期脚本、dist 在包内）；**全新 profile `file:`/`link:` 实装 dist 形态启动成功、`/gate01/panel/` 可达**（演示只读放行经 demoAuth 标志生效）。

### Phase 4 产品成形：演示看板 + SPA 自持 + 品牌

1. **演示看板**：board/agents/activities 只读公开端点，数据源=scenegraphs + `seed/demo-content.json`，响应带 `demo:true`；SPA 顶部「演示数据 · 连接宿主后切换」横幅；向导常驻引导。
2. **SPA 自持**：deps.js 对 console `/js/ui.js`、`/js/realtime.js` 的借用改为 panel-core public 自带 lite 副本（toast/modal/SSE+轮询），两形态同一路径，消除对 console 静态资产的运行时依赖。
3. **「01门」品牌清扫**（全部运行时面已定位）：
   - rq-card：`src/client/locales.ts`（settings.nav/view.workbench/overlay.unlocked 等 + en 版）、`src/client/index.ts:190/302/382` 三处硬编码角标、`build.mjs:181/212/222` 三处 banner（**改后必须重建 `lib/client.js`**）、`src/index.ts:58/70/196` 工具描述与兜底文案；
   - panel SPA：`public/index.html:6` 页签、`wizard.js:62/197`、`app.js:172/187/380/554`、服务端 senderName（`src/index.ts:516`）；
   - 底座面 console 的品牌（登录页等）**不动**（形态 B 登录页属底座控制台）。
4. **验收断言进门禁（审查增补）**：演示态 `POST/PUT/DELETE /api/panel/*` 全部干净 403/401（无 500）；演示态 SSE `?token=` 自校验失败、前端 30s 轮询生效。

**门禁**：selftest 全绿（含 RBAC 矩阵）；全新 profile 纯 01门装态直出演示看板；连远端宿主后全量数据回归（代理/登录/30s 轮询/角标消失/演示横幅消失——宿主侧 demoAuth 未声明、authn 在场，同路由自动恢复严格鉴权）。

### Phase 5 真机验收 + 双通道发布

1. **冒烟矩阵**：全新 profile × {`github:01men/RQ-DSH`、npm `@ybkk/gate-01`、`link:`、`file:`}——安装→启动→演示看板→连接宿主→真实看板→`dsh plugin remove` 插拔→重装。
2. **npm 发布**：private:false、exports/files 核对、`npm publish --dry-run`；实际发布需 @01men org 的 npm 账号（用户执行或提供凭证）。
3. 全量开发形态回归：`--patch cordis.yml` 源码形态全栈（22 entry）启动、面板 RBAC、dingtalk-bridge 事件链——确认瘦身未伤全量形态。

**门禁**：铁律 6/7——全量回归全绿才推送交付。

### Phase 6 治理与文档

1. **AGENTS.md**：双轨表声明本分支产品=01门；所有权表调整（cordis.patch.yml/根 package.json 归 01门演进，底座面包与 README 维持锚点纪律）；装机铁律与同步节奏已含 build:dist（Phase 1.4 落地）。
2. **PROJECT.md**：产品口径更新（01门定义）。
3. **docs/handoff-f-remainder-to-main.md** 登记：patch 收缩与 dist 指向、boot-all 3 行 import 改名、G3 对 01门 自解（底座面包仍挂起）、**platform-core 值导入内联副本的漂移归属（若执行 Phase 2.5）**。
4. 本文档转为定版（去「修订稿」状态）。

---

## 五、风险与对策（2026-09-10 审查更新）

| 风险 | 对策 |
|---|---|
| cordis 可选服务语义决定全局设计（最坏＝拆条件装配子插件） | **Phase 0 前置 spike**，书面结论前不启动 Phase 1，不确定性不留到实施中期 |
| 阶段顺序约束被破坏（patch 收缩早于 inject 瘦身）→ 九键挂起、装机门禁假红 | 硬顺序约束写入 §四开头；Phase 3 前置条件显式标注；Phase 3 门禁含实装启动实证 |
| esbuild transform 不改写说明符，路径改写遗漏形态 → dist 在 Node ESM 下 ERR_MODULE_NOT_FOUND、完全不可用 | Phase 1.2 文本级规范化覆盖三种静态说明符形态 + 零残余 fail-closed 断言 |
| dist 缺与源码同目录的非 TS 资产（seed/demo-content.json，import.meta 同级解析） | 同布局拷贝规则 + 资产纳入 dist/.build-id 指纹 |
| 演示态鉴权误放行真实数据（fail-open＝安全语义反转） | demoAuth 配置标志 fail-closed（缺省严格、仅 4-entry patch 声明）；写动词边界 GET/HEAD/OPTIONS；Phase 4 验收断言 |
| pnpm git/npm 安装是否尊重 files、是否执行生命周期脚本 | Phase 3 起 `pnpm pack --dry-run` + 全新 profile 实装验证；产物零生命周期脚本、全预构建 |
| 演示端点公开面 | 只读、无用户数据、响应打 demo 标；接入真实宿主后同路由自动恢复鉴权语义（宿主侧 demoAuth 未声明） |
| rq-card exports['.'] 改 dist 影响源码开发流 | 两形态统一包名 + build:dist 入开发仪式；**禁用文件路径 entry**（spike §4.2 负判永久缓存，cordis.yml:80-84） |
| 值导入内联副本与上游漂移（若执行 Phase 2.5） | F 清单登记归属；上游 merge 后 diff 核对 |
| `/api/panel/*` 命名空间不可改（console 白名单） | 已列不改项；品牌化落在挂载前缀与 UI 层 |
| 与上游锚点的收敛检查漂移扩大 | 全部漂移登记 F 清单，底座面目录零改动（收敛检查对底座面仍趋空） |

## 六、工作量分布（供排期参考）

Phase 0 最小（探针脚本）但杠杆最大——书面结论决定 Phase 2/3 设计；Phase 1 机械改造（改名清扫 + 构建链）；Phase 2 最重（inject 瘦身清扫台账 + 鉴权标志化 + 全量回归）；Phase 3 集中于 selftest 重写与装机验证；Phase 4 产品体验（演示看板 + 品牌）；Phase 5/6 为验收与文档。建议每 Phase 至少一次独立提交，全绿后推进。
