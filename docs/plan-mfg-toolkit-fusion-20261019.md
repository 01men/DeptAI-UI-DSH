# 制造工具箱并入 01门 —— 融合决策记录（2026-10-19）

> 状态：**已执行**（本文件为决策凭据）
> 决策范围：`custom/dsh-rq`（本仓库）
> 并入来源：`D:\项目\榕器创\制造业AI工具`（源项目：独立 Vite + React + Express 应用「制造业 AI 工具集」）
> 用户裁决口径：**UI 风格以源项目为准，整体交互以本项目框架为主，把该目录内容融合进来**

---

## 一、决策事实

| 项 | 决策 |
|---|---|
| 承接形态 | 源项目**全部业务内容**并入 01门 面板，成为**第六空间「制造」**（`space=mfg`） |
| 前端框架 | 沿用本项目：零构建 vanilla ESM + 视图路由 + `api.js` 单一请求出口 + `ui.js` 组件通道 + 远程代理/演示态语义 |
| 视觉语言 | 取自源项目：卡片广场网格/列表、三步工作流、结果工作区双页签、场景图谱分组探索——落地为 `mfg-*` 前缀类名，作用域 `.mfg-scope` / `.mfg-drawer`，与 `iaw-*`、`panel.css` 共存不互染 |
| 服务端 | 并入 `plugin-panel-core/src/mfg/**`（TS，随附包 dist 预构建），REST `/api/panel/mfg/*` + 工具族 `panel_mfg_*` |
| 品牌 | 源项目品牌名**不进入本仓**（详见 §三） |
| 依赖 | 随附包**零新增运行时依赖**（详见 §四） |
| 归置 | 面板面（本分支拥有并演进，见 AGENTS.md 目录所有权表）；**不触及底座面** |

### 空间信息架构（五空间 → 六空间）

```
协作 collab │ 图谱 map │ 执行 flow │ 能力 cap │ 数据 data │ 制造 mfg（新增）
```

「制造」空间内四视图（置于 `mfg.js` 的 `MFG_NAV`，经 `app.js` `navDef()` 注入）：

| 视图 | 内容 |
|---|---|
| `plaza` 工具广场 | 16 个工具卡（13 计算内核 + 3 AI）+ 分类页签 + 搜索/排序/网格列表切换 + 收藏 |
| `graph` 场景图谱 | 100 项选题：分组探索、状态筛选、条目展开（输入契约/执行方法/结果表现/验收标准/来源追溯/交付边界） |
| `favorites` 我的收藏 | 收藏子集（复用广场渲染，`view=favorites`） |
| `history` 运行记录 | 本机保存的运行记录（默认关闭；开启后最多 20 条） |

---

## 二、并入映射（源 → 本仓）

| 源项目 | 并入位置 | 说明 |
|---|---|---|
| `src/core/catalog.ts` | `packages/plugin-panel-core/src/mfg/catalog.ts` | 工具注册表（16 项定义 + 7 分类），字段/图标/标签逐项保留 |
| `src/core/types.ts` | `.../mfg/types.ts` | `ToolResult` / `Block` 判别联合 v1.0 **不改** |
| `src/core/roadmap.json` | `.../mfg/roadmap.json` | 100 项选题（140 KB 原文件直拷，作为非 TS 资产随 dist 拷贝） |
| `src/core/export.ts` | `.../mfg/export.ts` | 改为服务端产出文本（导出与「继续分析」共用同一渲染，避免格式漂移） |
| `server/engine.ts` | `.../mfg/engine.ts` | 执行引擎；模型面改接平台网关（§五） |
| `server/tabular.ts` | `.../mfg/tabular.ts` | 表格内核；CSV 解析自写以去依赖（§四） |
| `server/skills.ts` | `.../mfg/skills.ts` | 三个自撰写 Skill 内核（版本化，不加载外部指令） |
| `server/quality.ts` | `.../mfg/quality.ts` | 输出门禁 + 放行制；放行存储改集合（§五） |
| `scripts/evaluate-skills.ts` + `tests/fixtures/skill-evals.ts` + `scripts/eval-assertions.ts` | `.../mfg/evaluate.ts` | 三处合并为一个评估模块（四类样例 × 3 重复） |
| `src/App.tsx` + `Roadmap.tsx` + `Results.tsx` | `public/js/mfg.js` | React → vanilla ESM 等价重写（视觉与交互语义保留） |
| `src/styles.css` + `roadmap.css` + `refinements.css` | `public/css/mfg.css` | 三份样式按设计语言重新整理为单一作用域样式表 |
| `src/components/Scene.tsx`（three.js） | `mfg.js` `renderScene()` | 改为等轴测 SVG 线框（§四） |
| `server/index.ts`（Express 装配） | `.../mfg/module.ts` | 路由改 `guarded()` + 工具族注册 |
| `server/mcp.ts` / `server/stdio.ts` | **不并入** | 平台已有 MCP 面（`POST /mcp`）与工具族通道，重复自建违反「不重复造轮子」 |

---

## 三、品牌处理（硬约束）

源项目品牌名（「榕器工坊」/ `rongqi-toolkit` / `RONGQI · INDUSTRIAL AI`）**是本仓库更名前的旧称**
（2026-10-14 已全仓更名「元冰可」，凭据 `docs/rebrand-yuanbingke-20261014.md`，规则为「工作树对旧称零命中」）。
因此并入按**改名而非搬运**执行：

- 并入内容品牌位一律写「01门 / 制造工具箱 / MFG Toolkit」；
- 源项目的 `mcpServers` 名 `rongqi-toolkit`、自定义 MIME `application/vnd.rongqi.material+json`
  未随行（MCP 面不并入；MIME 改为 `application/vnd.ybkk.mfg-material+json`）；
- 验证要求：并入文件对旧称、旧英文标识**零命中**（实测 0，见 §七）。

---

## 四、零新增运行时依赖（装机不变量约束）

本仓随附包在安装形态下**零 TS 装载、零构建依赖**（`docs/plan-gate01.md` G3 自解；`scripts/build-dist.mjs`
逐文件转译、不做模块解析）。源项目所用依赖在本仓均不存在，逐项等价替代：

| 源依赖 | 替代 | 语义保持点 |
|---|---|---|
| `zod` | `.../mfg/validate.ts` 手写校验 | 数值有限+上下界；文本 trim 非空+长度上限；**strict 对象（未知字段拒绝）**——源项目「注入字段被拒」断言依赖此语义 |
| `csv-parse` | `.../mfg/tabular.ts` `parseCsv()` | RFC4180 子集：引号包裹、内嵌逗号/换行、`""` 转义、BOM、CRLF；表头逐字匹配、行数 1–1000、空值/列数不符即拒 |
| `express` / `express-rate-limit` | 平台 `httpServer` + `guarded()` | 鉴权、配额、CORS、安全响应头全部由平台面提供 |
| `react` / `lucide-react` | 面板 vanilla ESM + 内联 SVG 图标集 | 图标按语义映射（`gauge→activity`、`bars→chart`…） |
| `three` + `OrbitControls`（约 340 KB） | `renderScene()` 等轴测 SVG | 尺寸比例真实、工程语义一致；不支持 WebGL 时的降级路径不再需要（SVG 恒可用） |

未声明的导出格式（PDF/DOCX/XLSX）在源项目即为「后续适配器」，本仓同样不伪造导出按钮。

---

## 五、平台化的三处适配（登记为有意的语义收紧）

### 1. 模型面：源自带 env 客户端 → 平台模型网关

| 维度 | 源项目 | 并入后 |
|---|---|---|
| 出站 | `fetch` 直连 OpenAI/Anthropic（`MODEL_API_KEY` 等 env） | `resolvePanelModelGateway(ctx)`：modelgw 优先 / dsh `llm` 桥兜底 |
| 密钥 | 仅在服务端 env | **仅在平台侧**（面板与随附包零密钥） |
| 协议 | `_protocol` 参数选 openai/anthropic | 无协议概念（网关拥有路由与适配） |
| 配额 | 进程内日额度 50 / 并发 3 | 平台侧（modelgw 预算熔断 + usage 计量） |
| 降级 | — | 网关缺席 ⇒ `MODEL_NOT_CONFIGURED` 503（诚实拒绝，不发假结果） |

源项目文档自陈「配额属验证版措施、多实例不共享」，平台化后该局限自然消除。

### 2. 放行维度：协议 → 模型标识

源项目按协议各一套放行（`releases["openai:sop-writer"]`）。平台形态下模型选择由网关拥有，
故收敛为**模型标识指纹**（`model` + `endpoint`）。放行语义不变：

```
报告指纹 + 真实调用标记(live=true) + 通过状态 + Skill 指纹 + 模型指纹 + 审核人 + 30 天期限
—— 任一不符即 releaseReady=false（fail-closed）
```

放行存储由源项目本机 `.local/quality/releases.json` 改为面板存储集合 `panel:mfgReleases`
（存储面不可用时回落内存实现，**不 fail-open**）。评估报告存 `panel:mfgReports` 供人工审阅。

### 3. 鉴权与 RBAC

源项目网页免登录。并入后按平台基线：

| 面 | 权限点 | 理由 |
|---|---|---|
| 目录/清单/模板/导出/放行记录/评估计划 | `panel.read` | 只读 |
| 执行工具 `tools/:id/run` | `panel.write` | 有副作用（计量、审计留痕） |
| 评估 `evaluate`、放行签署/撤回 | `panel.config.write` | 治理动作，非普通使用 |

基线角色 `member` 已含 `panel.write`（可直接用工具），但不含 `panel.config.write`（不能自行放行）——
selftest 有对应越权断言（member 调评估/放行面 403）。

---

## 六、诚实边界（沿用源项目口径，不因并入而放宽）

1. **配了模型 ≠ 开放 AI 工具**：必须真实模型评估 → 领域人员审阅 → 版本放行。
   mock/自动测试结果**永不**生成放行记录（`buildRelease` 硬拒 `live!==true`）。
2. **100 项选型 ≠ 100 个已交付工具**：13 计算内核已实现、3 AI 待验收、84 规划。
   原 Excel 的「已完成」**不继承**为本项目交付状态（图谱页页脚原文保留）。
3. **自动结构与引文检查 ≠ 专业结论正确**：报告与界面均如实标注。
4. 未实现的渲染/导出/解析能力在界面**诚实缺席**，不放空占位入口。

---

## 七、验证结果（本次实测）

| 门 | 结果 |
|---|---|
| 源项目金标回归（`engine.test.ts` 全量重放） | 全绿——OEE 76.56 / Cpk 1.5 / 节拍 31.5 / EOQ 774.6 / 重量 13.565,271.296 / RPN 192 / ROI 3 / 帕累托 / BOM / 逾期边界 / MTBF / 比价 1150 |
| 拒绝面回归 | 全绿——跨字段约束、重复键、无效日期、非整数、税率未小数、注入字段、Infinity、运算溢出、未知工具 |
| 门禁回归（`quality.test.ts` 重放） | 全绿——结构/引文/HTML/缺章节拒；mock 报告不可放行；指纹篡改与过期即失效 |
| `npm run selftest` | **1365/1365 绿**（基线 1322，新增 43 项 mfg 断言） |
| `npm run lint:manifests` | **105/105 绿**（10 端点 + 3 工具双向比对通过） |
| 装机模拟段 | 三链一致 / bundle+dist 新鲜度 / files 闭包 / **mfg 资产在场** / index.html 样式挂载 全绿 |
| 浏览器端全链（jsdom 真实前后端） | 空间切换 → 广场 16 卡 → OEE 抽屉 → 执行 76.56% → JSON/Markdown 导出 → 「继续分析」串联根因工具（AI 未放行时按钮禁用 + 诚实提示）→ 收藏 → 图谱 100 行展开来源追溯 → 记录 |
| 旧称零命中 | 并入文件对旧品牌名/旧英文名**零命中** |

---

## 八、后续事项（未做，需单独决策）

1. **真实模型验收**：3 个 Skill 的真实评估与领域审阅未执行（需平台模型网关在场 + 领域人员）。
   面板已备好评估面（`POST /api/panel/mfg/evaluate`）与放行面（`POST /api/panel/mfg/releases`），
   但**放行必须由人工签署**，自动化不代签。
2. **84 项规划条目的实现**：逐项确认输入可得性、业务金标与负责人后推进（源项目路线图第 2 步同口径）。
3. **源目录归档**：`D:\项目\榕器创\制造业AI工具` 保持独立原样（本决策只做并入，未移动/删除源目录）。
   若需彻底退役源项目，另行决策。
4. **导出格式扩展**（PDF/DOCX/XLSX）：源项目亦为「后续适配器」，按需另立计划。
5. **源项目 tests 目录**未逐文件搬运：其金标断言已重放为 selftest 的 mfg 段（等价覆盖），
   HTTP/MCP 冒烟脚本因 MCP 面不并入而未搬（平台 `/mcp` 与工具族已有等价覆盖）。