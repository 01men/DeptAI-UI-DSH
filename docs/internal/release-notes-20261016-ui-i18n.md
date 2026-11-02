# 发布说明：功能层全球化（UI 国际化）批次 · 2026-10-16

> 批次代号：**UI-I18N-1**（功能层全球化一步到位）。本批次推翻 2026-10-13「表现层中文单语」的 R10 限定中
> 「界面语言」一半——**协议层 ASCII 红线完全不变**，运行时表现层自此内置三语：**简体中文（默认）/ English (US) / 日本語**。

## 一、交付内容

### 1. i18n 内核（新增 `packages/platform-i18n`）
- `t()` 以**中文原文为键**：zh-CN 原样返回（历史输出逐字节不变，selftest 全量断言零影响）；en/ja 查词典，
  未命中优雅降级中文（词典可增量补齐，运行永不因缺翻译失败）；`{name}` 插值。
- 词典加载：`locales/<locale>/*.json` 按文件名序浅合并（多团队分文件并行维护互不覆盖）；
  企业定制覆盖层 `I18N_EXTRA_DIR/<locale>/*.json`（同键覆盖，私有化本地话术）。
- locale 决议链（纯函数可测）：`?lang=` > Cookie `rq_lang` > `Accept-Language` > `PLATFORM_LOCALE` > zh-CN；
  BCP47 宽容归一（en-GB→en-US 等）。
- `AsyncLocalStorage` 请求级语言上下文 + Intl 日期/数字本地化助手。

### 2. HTTP 分发层接入（`platform-core/src/http.ts`）
- `dispatch()` 一次解析请求语言，以 `runWithLocale` 包裹**中间件 → 路由处理器 → 静态兜底全链**——
  任意深度的路由/服务代码直接 `t()` 即得当前请求语言，插件零接线成本；
  同时覆盖独立进程（`npm start`）与 dsh 挂载（`/rq` 单入口）两种形态。

### 3. 前端运行时（控制台 + 面板，零构建基线保持）
- 新增 `public/js/i18n.js`：词典单请求取自 `GET /locales/:locale`（服务端文案 + 控制台 SPA + 面板 SPA 三层合并，
  本批次合并规模 5,153 词条/en）；**DOM 级翻译引擎**（MutationObserver 监听新增节点，文本节点与
  placeholder/title/aria-label 整词精确替换）覆盖一切渲染路径，含 API 返回的中文错误消息；
  动态拼接文案由页面代码 `rqI18n.t('共 {n} 条', { n })` 显式翻译（约 800 处改造）。
- 语言切换器注入顶栏（`.topbar-right`，登录面退化右下角浮球），偏好存 `rq_lang`，切换整页刷新。

### 4. 全平台字符串接入（八组并行 + 统一审校）
| 域 | 团队产出 |
|---|---|
| 服务端（console 路由/iam/authn、workforce/exec-hub/panel/rq-card/flow、nas/connector/mcp/skillhub/market/connect/dsh-bridge/resource-core、agent/app/modelgw/usage/audit/update/portal/dingtalk-bridge/platform-core） | 约 1,900 处 `t()` 接入 |
| 控制台 SPA（外壳/核心页 + 业务域页） | 约 760 处动态 `t()` + 约 2,280 条静态词条 |
| 面板 SPA | 205 词条 + 47 处动态 `t()` |
| CLI（`cli/dshctl.mjs`） | `--lang` 旗标 + `DSHCTL_LANG`，help/提示/表头/状态列全量接入，388 词条 |
| 词典审校 | 跨文件 147 个重复键统一裁决、en/ja 键集/占位符逐对校验、GLOSSARY 增补 25 条功能层术语 |

词典总规模：**en-US / ja-JP 各约 5,150 词条**（三层合并后），术语以 [docs/i18n/GLOSSARY.md](i18n/GLOSSARY.md) 为契约。

### 5. 配套
- `rq-card` 客户端 bundle 随源码重建（`build.mjs`）；client 半接 dsh `ctx.locale` 机制（zh/en/ja）。
- 多语言文档版（docs/i18n/，2026-10-15 批次）23 份文件的「界面语言」节同步更新为新事实。

## 二、协议变更登记（R10 口径）

**新增 ASCII 协议键**（已同步 [docs/协议键中文对照总表.md](协议键中文对照总表.md) §4.9/§5.1）：

| 键 | 类型 | 语义 |
|---|---|---|
| `?lang=` | URL 查询参数 | 请求级语言（最高优先级） |
| `rq_lang` | Cookie / localStorage | 用户语言偏好（'auto'/zh-CN/en-US/ja-JP） |
| `PLATFORM_LOCALE` | 环境变量 | 安装级默认语言（服务端生成文案/非 HTTP 上下文） |
| `DSHCTL_LANG` | 环境变量 | CLI 语言覆盖（`--lang` 旗标优先） |
| `I18N_EXTRA_DIR` | 环境变量 | 企业定制词典覆盖层根目录 |

**不变项**：事件名、权限点、错误原因码、API 信封字段（ok/data/error）、既有环境变量与存储键全部原样；
`GET /locales/:locale` 为新增公开静态端点（已登记 plugin-console manifest/api.yaml，免鉴权——词典为静态文案无业务数据）。

**行为修正 1 处（plugin-update）**：升级频率限制 429 判定原依赖中文文案 `includes('过于频繁')`，本地化后会失配；
改为 `checkNow` 抛错附 `error.code='TOO_FREQUENT'`、路由按 code 判定。zh 输出与 429/502 映射行为均不变。

## 三、质量门（本次实测）

- `npm run selftest`：**1427/1427 全部通过**（较上批次 +8：新增 i18n 回归段——内核 t() 行为、locale 决议链、
  词典齐套 en/ja 键集一致、/locales 合并端点、请求级协商 e2e（`?lang=en-US` 401 文案切英文 / 默认 zh 逐字节不变））。
- `npm run lint:manifests`：115/115 清单通过，契约比对 **0 红**（路由 代码 431/清单 447）。
- CLI 三语 help 实测（zh/en/ja）、`--lang` 覆盖 `DSHCTL_LANG` 验证通过；zh 输出与 HEAD diff 仅新增 `--lang` 帮助行。
- 隔离实例手工探针：`?lang=en-US|ja-JP` 鉴权 401 文案三语正确、默认 zh 不变、`/locales/en-US` count=5153。

## 四、边界与已知取舍

- **有意不译**：代码注释、服务端 console 日志、MCP 工具 description（模型契约面）、seed/演示业务数据、
  内部状态比较字面量；canvas 生态树与 SVG 内文字（DOM 引擎不可达，后续按需补）。
- 同一中文键双语义时取主导用法（审校组裁决记录见 GLOSSARY 第九节）：如「关闭→Close」「管理→Manage」。
- 服务端词典覆盖以请求时语言为准；历史已落库的中文审批/审计文案不回溯翻译。
- 更多语言（de/fr/es/pt/hi 界面层）、文档站语言路由、控制台 canvas/SVG 补齐：见 docs/i18n/README.md 路线图。

## 五、回归与兼容性说明

- 升级后默认行为（zh-CN）与上一版本**逐字节一致**：未设置任何语言偏好/环境变量的存量部署无感。
- 英文/日文用户：打开控制台顶栏选择 English/日本語 即可；CLI 用户 `dshctl --lang en-US …` 或 `export DSHCTL_LANG=ja-JP`。
- 企业定制话术：设置 `I18N_EXTRA_DIR` 指向自有词典目录即可覆盖任意词条，无需改码。
