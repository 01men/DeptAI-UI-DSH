# 国际化与本地化治理（i18n Governance）

> 版本 v2.0 · 2026-10-16 · 本目录是元冰可（YuanBingKe / ybkk-AIOS）的**官方多语言文档版**唯一出处。
> 治理负责人：国际化产品团队（i18n PM）。翻译歧义以中文原文为准；术语以 [GLOSSARY.md](GLOSSARY.md) 为契约。
> **2026-10-16 起，功能层全球化已落地**：运行时表现层（控制台/面板/CLI/通知与审批文案/错误提示）内置
> zh-CN（默认）/ en-US / ja-JP 三语切换——本目录同时治理「文档多语言」与「产品界面多语言」两条线。

---

## 一、使命与范围

面向美国、欧洲、印度、非洲、澳洲、日本、新加坡市场，提供产品**介绍、功能使用、部署接入、DSH 生态**
四大类文档的官方语言版本，并给出区域合规与本地化适配口径。

**范围边界（与仓库「语言口径」的关系，2026-10-16 更新）**：

- **运行时表现层已多语言**（2026-10-16 批次，发布说明 [../internal/release-notes-20261016-ui-i18n.md](../internal/release-notes-20261016-ui-i18n.md)）：
  i18n 内核 `packages/platform-i18n`（t() 以中文原文为键、词典增量补齐、AsyncLocalStorage 请求级 locale）、
  请求级协商（`?lang=` > Cookie `rq_lang` > Accept-Language > `PLATFORM_LOCALE`）、Web 顶栏切换器、
  CLI `--lang`/`DSHCTL_LANG`、企业定制覆盖层 `I18N_EXTRA_DIR`。默认 zh-CN 输出逐字节不变。
- **协议层 ASCII 键不翻译**（R10 红线不变）：事件名、权限点、错误原因码、API 信封字段、环境变量名、浏览器存储键
  （本次新增键已登记 [../协议键中文对照总表.md](../协议键中文对照总表.md) §4.9/§5.1，详见 [GLOSSARY.md](GLOSSARY.md) 第五节）。
- **内部工程文档不翻译**：契约（contract-*）、交接（handoff-*）、QA 报告、开发计划、发布说明全文等保持中文，作为内部工程资产；
  其对外可见的内容已浓缩为各语言版的「发布史（Release History）」摘要。
- 中文原文永远是权威版本；译稿与其冲突时以中文为准（每份译稿页眉有此声明）。

## 二、语言分层与市场映射

| 层级 | 语言 | 覆盖市场 | 范围 |
|---|---|---|---|
| Tier 1 全量版 | **English (en)** — 全球基线（en-US 拼写） | 美国、澳洲、新加坡、印度（商务语）、非洲（英语区）、欧洲（商务语） | 8 份全量文档（见「三、目录结构」） |
| Tier 1 全量版 | **日本語 (ja)** | 日本 | 与英文版同集，8 份 |
| Tier 2 概览版 | Deutsch (de) | 德国/中欧（DACH） | 产品一页纸 |
| Tier 2 概览版 | Français (fr) | 法国/南欧、非洲法语区（西非/中非/马格里布） | 产品一页纸 |
| Tier 2 概览版 | Español (es) | 西班牙/拉美延伸市场 | 产品一页纸 |
| Tier 2 概览版 | Português (pt) | 葡语非洲（安哥拉/莫桑比克）、葡萄牙 | 产品一页纸 |
| Tier 2 概览版 | हिन्दी (hi) | 印度（配合商务英文版） | 产品一页纸 |
| 已有 | 简体中文（zh） | 中国大陆（本仓库原生） | 全仓中文文档 |

> 新加坡：英文版即官方版本，时区 UTC+8（SST）、PDPA 合规口径见「五、区域适配」；中文用户可直接使用仓库中文文档。

## 三、目录结构

```
docs/i18n/
├── README.md              # 本文件：治理、分层、流程
├── GLOSSARY.md            # 术语契约 + 风格基线 + ASCII 保留清单
├── en/                    # Tier 1 英文全量版
│   ├── README.md                    # 产品全景（国际版，对应根 README）
│   ├── README.agent.md              # Agent 视图（国际版，对应根 README.agent.md）
│   ├── product-introduction.md      # 产品介绍 / 定位一页书
│   ├── getting-started.md           # 快速开始 + 演示模式
│   ├── dsh-ecosystem.md             # DSH 生态介绍（一切皆插件 / 插件市场 / 宿主桥）
│   ├── user-guide.md                # 功能使用指南（全域）
│   ├── deploy-enterprise.md         # 企业部署与 dsh 接入 runbook
│   ├── app-sso-integration.md       # AI 应用 SSO 接入指南
│   ├── usage-reporting.md           # 用量透明与 FinOps 报告（J4）
│   └── release-notes-summary.md     # 发布史摘要（自 M0 至最新批次）
├── ja/                    # Tier 1 日文全量版（与 en/ 同集同名）
├── de/ fr/ es/ pt/ hi/    # Tier 2 产品一页纸 product-overview.md
```

## 四、翻译生产流程（团队协作口径）

1. **术语先行**：任何译稿开工前先读 [GLOSSARY.md](GLOSSARY.md)；新术语先登记后使用（PR 中同步更新术语表）。
2. **源文锁定**：每份译稿在文首 front matter 标注 `source:`（中文源文件路径）与 `source-updated:`（源文件最后实质修订日期，2026-10-15 基线）。
3. **并行分工**：按「英文核心 / 英文功能 / 英文接入 / 日文核心 / 日文功能 / 区域概览」六组并行，组间只通过术语表对齐。
4. **机翻+人工审校口径**：当前批次为「机翻 + 资深本地化 PM 统稿」，文首如实标注
   *"English edition: machine-assisted translation, reviewed by the i18n PM. The Chinese original governs."*
5. **变更同步**：中文源文档发生实质修订（新增能力/契约变更）后，i18n PM 在该译稿 front matter 标 `stale: true` 并排期更新；
   译稿不独立演化，不允许在译稿中新增中文原文没有的功能声明。
6. **验收门**：术语一致性（抽检 GLOSSARY 键）、ASCII 保留清单零改动、UI 位置均带中文括注、无 M0 结算语义泄漏、无 overclaim。

## 五、区域适配口径（localization notes by market）

| 市场 | 时区/格式 | 合规关注（文案口径） | 本地化要点 |
|---|---|---|---|
| 美国 | 本地时区，en-US | SOC 2 / ISO 27001 为 roadmap，未取得；强调自托管（self-hosted）= 数据不出企业边界 | 案例话术偏 ROI 与治理 |
| 欧洲 | CET/CEST，DD.MM.YYYY 口语 | **GDPR**：自托管与私有化交付是数据驻留（data residency）路径；DPA 流程为 roadmap | 文档注明日期格式差异；DE/FR 一页纸可用 |
| 印度 | IST (UTC+5:30) | DPDP Act 关注；商务以英文为准，印地语一页纸辅助触达 | 定价沟通强调「团队+领域资产」的规模弹性 |
| 非洲 | EN 区（西/东/南部）+ FR 区 | 数据主权与离线/低带宽环境：私有化交付适配弱网运维 | PT/FR 一页纸覆盖葡语/法语区；文档考虑低带宽可读性（纯 Markdown） |
| 澳洲 | AEST/AEDT | 隐私法（Privacy Act 1988）；en 版即官方版本 | 日期口语格式 DD/MM/YYYY 提醒 |
| 日本 | JST (UTC+9) | 個人情報保護法（APPI）；敬体文体；路线图项显式标注 | 画面言語说明节必配（UI 当前中文） |
| 新加坡 | SGT (UTC+8) | **PDPA**；英文即官方语言版本 | 中文用户可直接用仓库中文文档 |

> 所有合规表述均为**口径指引而非法律意见**，正式进入某市场前需法务复核（文档中如实标注）。

## 六、路线图（Roadmap — 如实标注，非已实现）

1. ~~控制台/面板界面 i18n 框架（en → ja 优先），协议层 ASCII 键不动~~ **✅ 已交付（2026-10-16 批次）**。
2. ~~`dshctl` CLI 输出语言切换（`DSHCTL_LANG=en|ja`）~~ **✅ 已交付（2026-10-16 批次，含 `--lang` 旗标）**。
3. 界面层更多语言（de/fr/es/pt/hi 等 Tier 2 语言界面化；词典框架已就绪，增量补目录即可）。
4. 区域合规增强包：GDPR 数据处理附录（DPA）模板、SOC 2 审计准备、日本 APPI 对应。
5. 文档站（docs portal）按语言前缀路由（/en/ /ja/ …）与语言切换器。
6. 控制台 canvas 生态树与 SVG 内文字的词典化（DOM 引擎不可达面，2026-10-16 已知边界）。
7. 更多 Tier 2 语言文档：韩语（ko）、印尼语（id）、阿拉伯语（ar，RTL 适配）。

## 七、本批次交付清单

**2026-10-15（文档层国际化）**
- [x] 术语契约与风格基线（GLOSSARY.md，v1.1 含六组团队缺口增补）
- [x] 治理文档（本文件）
- [x] en/ 全量 9 份 + ja/ 全量 9 份 + de/fr/es/pt/hi 一页纸 5 份
- [x] 根 README「语言口径」更新 + 「〇、国际化文档」入口节 + llms.txt 国际化索引

**2026-10-16（功能层全球化，发布说明见 [../internal/release-notes-20261016-ui-i18n.md](../internal/release-notes-20261016-ui-i18n.md)）**
- [x] i18n 内核 `packages/platform-i18n` + HTTP 分发层接入 + `/locales/:locale` 合并端点
- [x] 控制台/面板前端运行时（DOM 翻译引擎 + 顶栏语言切换器 + `rq_lang` 偏好）
- [x] 全平台字符串接入：约 2,700 处 `t()`、en/ja 词典各约 5,150 词条（三层合并）、审校 147 键统一裁决
- [x] CLI `dshctl --lang` / `DSHCTL_LANG` 三语输出
- [x] 新协议键登记协议键对照表（`?lang=`/`rq_lang`/`PLATFORM_LOCALE`/`DSHCTL_LANG`/`I18N_EXTRA_DIR`）
- [x] 23 份多语言文档「界面语言」节同步更新
- [x] 质量门：selftest 1427/1427 全绿（含新增 i18n 回归段 8 断言）· lint:manifests 0 红 · zh 默认输出逐字节不变

## 八、中文源问题登记（待源侧修订，译稿处理方式见括注）

翻译过程中六个团队汇总发现以下中文源口径问题，已登记并由 i18n PM 跟进；**中文原文修订前，译稿一律采用现行权威口径**（llms.txt 与根 README 为准）：

| # | 问题 | 现状与译稿处理 |
|---|---|---|
| 1 | `docs/deploy-enterprise.md` 安装源仍写 `github:01men/ybkk-AIOS`，与 2026-10-14 迁移注记（→ `01men/ybkkasi`）不符 | 本次已由 i18n PM 直接修正中文源（仓库路径属客观事实错误） |
| 2 | `docs/deploy-enterprise.md` §二「资金边界」段残留 M0 前旧句（「三A 资金红线」节已不存在） | 译稿按 M0 口径改写为「平台无金额结算功能」；建议中文源删除或重写该句 |
| 3 | 运维工具计数漂移：37（dsh 运行时）/ 41（工具桥）/ 40+（llms.txt `/mcp`）/ 82（`/mcp tools/list` 全量） | 各译稿按上下文保留并加「以最近一次运行为准」；对外统一推荐「40+」 |
| 4 | `docs/deploy-enterprise.md` 内 `lint:manifests 70/70` 为过期硬编码（当前基线远高于此） | 译稿改为「通过零错误（通过数以最近一次运行为准）」 |
| 5 | M0 发布说明（2026-09-09）「私有化年费 + 治理包」与 2026-09-15 起「团队 + 领域资产」定价口径不一致 | 译稿一律采用最新口径，并在发布史摘要中如实记录沿革 |
| 6 | 旧品牌残留：启动日志与 deploy 文档任务块中的旧品牌字样 | 译稿引用处统一为现行品牌 YuanBingKe (ybkk-AIOS) / 元冰可 |
| 7 | 审批规则随批次反转（09-12 自审禁止 → 09-15 同人审批放开） | 发布史摘要如实记录为业务决策反转，防止海外读者引用过期规则 |
| 8 | `docs/app-sso-integration.md` §三 `/.well-known` 路径混入零宽字符 | 译稿输出干净 ASCII 路径；建议中文源清理 |
