# 国际化术语表与本地化风格基线（GLOSSARY）

> 版本 v1.2（2026-10-29）· 本表是所有翻译稿的**术语契约**。翻译团队开工前必读；
> 新术语一律先登记本表再使用。中文原文与译稿发生歧义时，以中文原文为准。
> v1.1（2026-10-15）：按六组翻译团队上报的术语缺口增补（见「八」），修正「冪等」日文注音。
> v1.2（2026-10-29）：根 README 定位重写（「堆工具为什么不管用 / 新生产关系的运行底座」），
> 新增定位论述术语（见「十」）。

---

## 一、品牌与产品名

| 中文 | English | 日本語 | 备注 |
|---|---|---|---|
| 元冰可 | **YuanBingKe** | YuanBingKe（表记用拉丁字，不加注音） | 官方英文品牌名（2026-10-16 品牌重塑定稿，llms.txt 与运行时词典同口径）；旧拉丁表记已废弃，不再对外使用 |
| ybkk-AIOS | ybkk-AIOS | ybkk-AIOS | 产品代号 / 仓库名，保留不译 |
| 企业 AI 资源管理平台 | Enterprise AI Resource Management Platform | エンタープライズ AI リソース管理プラットフォーム | 产品定位一句话 |
| DSH（DeepSeek Harness） | DSH (DeepSeek Harness) | DSH（DeepSeek Harness） | 缩写保留；首次出现给全称 |
| cordis 插件框架 | cordis plugin framework | cordis プラグインフレームワーク | `@deepseek-ai/cordis` 保留代码原样 |

## 二、架构与平台层术语

| 中文 | English | 日本語 | 备注 |
|---|---|---|---|
| 一切皆插件 | "Everything is a plugin" | 「すべてはプラグイン」 | 架构口号，首次出现加引号 |
| 插件树 | plugin tree | プラグインツリー | |
| 宿主（dsh 宿主） | (dsh) host | ホスト | |
| 数据面 / 控制面 | data plane / control plane | データプレーン／コントロールプレーン | |
| 接入层 | access layer | アクセス層 | |
| 业务域 | business domain | 業務ドメイン | |
| 控制台 | Console | コンソール | UI 位置引用需附中文原文，见「四、UI 标注规则」 |
| 面板 / 工作台 | Panel / workbench | パネル／ワークベンチ | |
| 门户 | Portal | ポータル | |
| 挂载 | mount | マウント | dsh 挂载 `/rq` 前缀 |
| 基线初始化 | baseline initialization | ベースライン初期化 | |
| 演示模式 | demo mode (`DEMO_SEED=1`) | デモモード（`DEMO_SEED=1`） | |
| 私有化交付 | on-premises (private) delivery | オンプレミス（プライベート）導入 | |
| 平台自更新 | platform self-update | プラットフォーム自己更新 | |

## 三、业务域术语

### 身份与访问
| 中文 | English | 日本語 |
|---|---|---|
| 统一身份与访问管理 | Identity & Access Management (IAM) | ID・アクセス管理（IAM） |
| 统一认证 | Unified Authentication | 統合認証 |
| 组织树 | organization tree | 組織ツリー |
| 组织与账号（UI 菜单） | Organization & Accounts（组织与账号） | 組織とアカウント（组织与账号） |
| 角色 / 用户组 | role / user group | ロール／ユーザーグループ |
| 权限点 | permission point | パーミッションポイント（権限ポイント） |
| 场景级授权（sceneCode） | scene-level authorization (sceneCode) | シーン単位の認可（sceneCode） |
| 机器凭证 | machine credential | マシンクレデンシャル |
| 双轨身份 | dual-track identity | デュアルトラック ID |
| on-behalf-of 链 | on-behalf-of token chain | on-behalf-of トークンチェーン（代理実行） |
| 单点登录 | Single Sign-On (SSO) | シングルサインオン（SSO） |
| 免密登录 | passwordless login | パスワードレスログイン |
| 钉钉 | DingTalk | DingTalk |
| 应用上线门禁 | app go-live gate | アプリ公開ゲート |

### 资产与市场
| 中文 | English | 日本語 |
|---|---|---|
| 六类资产 | six asset types | 6 種類のアセット |
| MCP 部署服务 | MCP deployment service | MCP デプロイサービス |
| 草稿→验证→灰度→全量 | draft → validate → canary → full rollout | ドラフト→検証→カナリア→全量リリース |
| 版本不可变 | immutable releases | 不変（イミュータブル）リリース |
| 一键回滚 | one-click rollback | ワンクリックロールバック |
| 令牌网关 | token gateway | トークンゲートウェイ |
| 熔断 / 健康熔断 | circuit breaking / health-based circuit breaking | サーキットブレーキング／ヘルス監視による遮断 |
| Skill 市场 | Skill Marketplace | スキルマーケット |
| 静态扫描 | static scanning | 静的スキャン |
| 两级审批 | two-tier approval | 二段階承認 |
| 契约验签（Ed25519） | Ed25519 contract signature verification | Ed25519 契約署名検証 |
| 版本化上架 | versioned publishing | バージョン管理された公開 |
| Agent 本体 | Agent registry | エージェント本体 |
| AI 应用 | AI application | AI アプリケーション |
| 编排拓扑 | orchestration topology | オーケストレーショントポロジ |
| 自治分级（A0–A3） | autonomy levels (A0–A3) | 自律レベル（A0–A3） |
| A2A 点名调用 | agent-to-agent (A2A) named invocation | A2A 指名呼び出し |
| 连接器 | connector | コネクタ |
| 凭证保险库 | credential vault | クレデンシャルボールト |
| OAuth 代理 | OAuth proxy | OAuth プロキシ |
| 双层授权镜像 | two-layer authorization mirror | 二層認可ミラー |
| NAS 资产纳管 | NAS asset onboarding | NAS 資産の取り込み・管理 |
| 数据权限 | data permission | データ権限 |
| 签名下载链接 | signed download URL | 署名付きダウンロード URL |
| 文件所有权跟踪 | file ownership tracking | ファイル所有権トラッキング |

### 计量与财务（M0 口径必须保留）
| 中文 | English | 日本語 |
|---|---|---|
| 用量透明计量 | transparent usage metering | 利用量の透明な計測 |
| 用量报表 | usage report | 利用量レポート |
| 成本穿透 | internal cost pass-through | 内部コスト透過 |
| 零价快照（charge 恒 0） | zero-price snapshot (charge always 0) | ゼロ価格スナップショット（charge 常に 0） |
| 内部采购成本参考 | internal procurement cost reference | 内部調達コスト参考値 |
| 价格簿 | price book | プライスブック |
| 死信重放 | dead-letter replay | デッドレターリプレイ |
| 幂等 | idempotent | 冪等（べきとう） |
| 三方对账 | third-party reconciliation | 外部システム照合 |
| 能力漂移检测 | capability drift detection | ケイパビリティドリフト検出 |
| FinOps 报告 | FinOps report | FinOps レポート |
| 空转检测 | idle-run detection | アイドル稼働検出 |
| 单位 DAU 成本 | cost per DAU | 1DAU あたりコスト |
| 模型接入网关 | Model Access Gateway (modelgw) | モデルアクセスゲートウェイ（modelgw） |
| 渠道治理 | channel governance | チャネルガバナンス |
| 降级链 | fallback chain | フォールバックチェーン |
| 预算熔断 | budget circuit breaker | 予算サーキットブレーカー |
| TTFT 遥测诚实缺列 | honest omission of TTFT telemetry (explicitly not reported) | TTFT テレメトリの正直な未収録 |

> **M0 红线（所有译稿必须遵守）**：平台**不含任何金额结算语义**——不出现 wallet/充值/分账/计费收费等表述；
> plugin-billing 已下线封存。对外口径 =「用量透明 + 内部成本穿透」，按「团队 + 领域资产」定价（团队规模 × 所选领域资产包），
> 制造业客户可走私有化交付项目制。

### 编排、数据与治理
| 中文 | English | 日本語 |
|---|---|---|
| 流程编排（flow-core） | workflow orchestration (flow-core) | ワークフローオーケストレーション（flow-core） |
| TF 编排 + 步骤状态机 | TF orchestration + step state machine | TF オーケストレーション＋ステップ状態マシン |
| 模板库 / contextPack | template library / contextPack | テンプレートライブラリ／contextPack |
| 甘特时间轴 | Gantt timeline | ガントタイムライン |
| 数据要素域 | Data Asset Domain | データ資産ドメイン |
| 四维质量分 | four-dimension quality score | 4 軸品質スコア |
| 血缘反向追溯 | reverse lineage tracing | リネージ逆引き |
| 指标字典口径仲裁 | metric dictionary definition arbitration | 指標ディクショナリの定義仲裁 |
| 审计证据锚点 | audit evidence anchor | 監査証拠アンカー |
| 通知中心 | Notification Center | 通知センター |
| 审批中心 | Approval Center | 承認センター |
| L4 强制审批 | L4 mandatory approval | L4 強制承認 |
| fail-closed | fail-closed | fail-closed（フェイルクローズド） |
| 审计留痕 | audit trail | 監査証跡 |
| 告警规则引擎 | alert rule engine | アラートルールエンジン |

### 执行中枢与数字员工
| 中文 | English | 日本語 |
|---|---|---|
| 执行中枢 | Execution Hub | 実行ハブ |
| 目标对齐 | goal alignment | ゴールアライメント（目標整合） |
| 心跳循环 | heartbeat loop | ハートビートループ |
| 执行锁（CAS） | execution lock (CAS) | 実行ロック（CAS） |
| 僵尸锁回收 | zombie-lock reclamation | ゾンブロック回収 |
| 例行调度 | routine scheduling | 定期スケジューリング |
| 治理前置链 | governance pre-check chain | ガバナンス事前チェックチェーン |
| 健康度五档 | five-tier health score | 5 段階ヘルススコア |
| 数字员工 | digital worker | デジタルワーカー |
| 数字员工域（workforce） | Workforce Domain (workforce) | ワークフォースドメイン（workforce） |
| 员工档案 | worker profile | ワーカープロファイル |
| 任用版本状态机 | appointment version state machine | 任用バージョン状態マシン |
| 短期工作授权（permit） | short-term work permit | 短期作業許可（permit） |
| 受控调用账本 | controlled-invocation ledger | 制御付き呼び出し台帳 |
| 交付-真人验收闭环 | delivery-to-human-acceptance loop | 納品〜人による検収のクローズドループ |
| 主体预算超额联动冻结 | principal budget-exceeded linked freeze | 主体予算超過による連動凍結 |

## 四、UI 标注规则（本地化关键适配）

> **2026-10-16 更新**：运行时界面已内置三语切换（zh-CN 默认 / en-US / ja-JP，顶栏选择器；偏好 `rq_lang`；
> CLI `--lang`/`DSHCTL_LANG`）。词典未覆盖文案优雅降级中文，且中文固定部署（用户未切换语言）仍是常见形态——
> 因此译稿中引用 UI 位置时，**继续**采用「译名 + 中文原文」双标注：

- 英文：**Organization & Accounts（组织与账号）→ Account Details → Reset Password**
- 日文：**組織とアカウント（组织与账号）→ アカウント詳細 → パスワードリセット**

首次出现的 UI 菜单/按钮/页面名都要带中文原文括注；同一文档内重复出现可只用译名。
每个语言版本文档的「Interface language note / 画面言語について」节应说明：界面已支持三语切换、
本文档的双语括注对中文固定部署与截图对照依然有用。

## 五、协议层 ASCII 保留清单（禁止翻译）

以下内容在任何语言版本中**逐字保留**，不得翻译、转写或本地化（跨系统机器契约，R10 口径）：

1. 事件名（如 `platform.update.available`、`flow.*`）
2. 权限点（如 `iam.user.write`、`workforce.admin`、`platform.update.apply`）
3. 错误原因码与 `ok/data/error` API 信封字段
4. 环境变量名——含 2026-10-16 i18n 批次新增 `PLATFORM_LOCALE`（安装级默认语言）、`DSHCTL_LANG`（CLI 语言）、
   `I18N_EXTRA_DIR`（企业词典覆盖层），以及既有 `DEMO_SEED`、`ADMIN_PASSWORD`、`USAGE_RETENTION_DAYS`、
   `SECURITY_HEADERS`、`GITHUB_TOKEN`、`DSH_UPDATE_AUTO_CHECK` 等
5. 浏览器存储键与 Cookie——含新增 `rq_lang`（UI 语言偏好）与既有 `heng_ops_*`/`panel_*` 族；HTTP 头（`X-On-Behalf-User`）；
   URL 查询参数 `?lang=`（请求级语言）
6. 命令、路径、代码块、包名（`@deepseek-ai/cordis`、`cli/dshctl.mjs`、`dsh plugin --profile web add github:01men/ybkkasi`）

协议键的中文权威释义见 [docs/协议键中文对照总表.md](../协议键中文对照总表.md)（本次新增键见其 §4.9/§5.1），
英文译稿可引用其英文释义但键名不改写。

## 六、本地化格式约定（locale conventions）

| 维度 | English (en-US 基线) | 日本語 (ja-JP) | 说明 |
|---|---|---|---|
| 日期（正文） | October 15, 2026 | 2026年10月15日 | 技术上下文一律 ISO 8601（2026-10-15） |
| 数字 | 1,380 tests / 99.9% | 1,380 件のテスト／99.9% | 千分位逗号；小数点 |
| 时间 | 24h（14:30 JST/UTC+9） | 24 時間（14:30 JST） | 平台日志为服务器本地时间，国际文档注明需按时区换算 |
| 货币 | 不出现结算金额；内部成本参考标注 CNY | 同左 | M0 红线：不做币种换算、不呈现价格 |
| 人名/联系方式 | 角色占位符（Platform Admin / `admin`） | 役割プレースホルダ | 国际文档不出现真实个人姓名 |
| 单位 | GB、P95、ms 原样 | 同左 | |

**文体（register）**：
- English：en-US 拼写；专业 B2B 语域；标题 sentence case；避免营销式夸大，只陈述已实现功能。
- 日本語：「です・ます調」敬体；ビジネス文書体裁；外来語カタカナ按业界惯例（「デプロイ」「ロールバック」「ゲートウェイ」）；漢字は常用漢字の範囲で。
- 区域语言一页纸（de/fr/es/pt/hi）：用各自市场的标准书面语；技术键与代码同样 ASCII 保留。

## 七、诚实表述红线（anti-overclaim）

1. 只写**已实现功能**（以中文原文文档与 llms.txt 能力清单为界）；路线图内容必须显式标注 "Roadmap / ロードマップ（計画中）"。
2. 不虚构合规认证：SOC 2 / ISO 27001 等**未取得**，只能写 "on the roadmap"。
3. 不虚构界面能力：运行时 UI 已支持 zh-CN/en-US/ja-JP 三语切换（2026-10-16 批次）；更多语言仍是 roadmap，不得宣称已支持。
4. 性能数字（selftest ≥1380、drill ≥37 等）引用时注明"以最近一次运行为准（as of the latest run）"。
5. 演示模式口令 `Ybk@2026` 可以写，但必须带上"仅限演示环境，生产禁用 DEMO_SEED"的警示。

## 八、v1.1 增补（2026-10-15，六组翻译团队缺口汇总）

### 8.1 英/日增补词条

| 中文 | English | 日本語 | 备注 |
|---|---|---|---|
| 接入码 | enrollment code（`enr_...`） | 接続コード | 远程 dsh 接入；哈希存储/一次性/TTL/失败锁定 |
| 权限模板（readonly/operator/full） | permission template | 権限テンプレート | 接入码模板三档 |
| 运维工具 | operations tools | 運用ツール | 数量表述统一「40+（最新批次全量以 `/mcp tools/list` 为准）」 |
| 宿主桥（dsh-bridge） | host bridge | ホストブリッジ | 平台数据面挂 `/rq` 前缀进 dsh webServer |
| 工具桥 | tools bridge | ツールブリッジ | |
| 全员名册 | all-staff roster | 全員名簿 | `GET /api/iam/roster`，PII 最小化 |
| 上线三步走 | go-live three steps | 公開三ステップ | 首启引导口径 |
| 六门验证 | six-gate verification | 六門検証 | lint/selftest/drill 等六道交付门 |
| 质量门 | quality gate | 品質ゲート | |
| 可信风险登记 | trust-risk registration | 信頼リスク登録 | MCP 工具 V11 流程 |
| 认领 | goal claiming | 目標クレーム | 执行中枢/员工认领目标 |
| 租约 | execution lease | 実行リース | 执行租约确认 |
| 解冻审批 | unfreeze approval | 解凍承認 | L4 解冻审批（对应联动冻结） |
| 公司级终审 | company-level final review | 会社レベル終審 | finalReview |
| 模型目录 | model catalog | モデルカタログ | modelgw |
| 访客埋点 | visitor beacon | ビーコン（訪客埋点） | 公开埋点 beacon |
| 入场票据 | entry ticket | 入場チケット | App SSO 链路 |
| 灰度交付（试岗） | staged delivery（trial duty） | 段階的デリバリー（トライアル配属） | W 批次灰度交付包 |

### 8.2 控制台页面名（UI 双标注用）

| 中文原文 | English | 日本語 |
|---|---|---|
| 平台接入 | Platform Access | プラットフォーム接続 |
| 统一认证中心 | Unified Authentication Center | 統合認証センター |
| 认证与令牌 | Authentication & Tokens | 認証とトークン |
| 三方集成 | Third-party Integration | サードパーティ連携 |
| 资产运营 | Asset Operations | 資産運用 |
| NAS 存储 | NAS Storage | NAS ストレージ |
| 财务视图 | Financial View | 財務ビュー |

### 8.3 区域语言增补（Tier 2 一页纸已采用）

| English | Deutsch | Français | Español | Português | हिन्दी |
|---|---|---|---|---|---|
| team + domain assets | Team + Domänen-Assets | équipe + actifs métier | equipo + activos de dominio | equipa + ativos de domínio | टीम + डोमेन एसेट |
| zero-price snapshot | Nullpreis-Snapshot | instantané à prix zéro | instantánea de precio cero | instantâneo a preço zero | शून्य-मूल्य स्नैपशॉट |
| internal cost pass-through | interne Kostenweitergabe | répercussion interne des coûts | traslado interno de costos | transposição interna de custos | आंतरिक लागत पारदर्शिता |
| budget circuit breaker | Budget-Circuit-Breaker | coupe-circuit budgétaire | disyuntor de presupuesto | disjuntor orçamental | बजट सर्किट ब्रेकर |
| digital worker | digitaler Mitarbeiter | travailleur numérique | trabajador digital | trabalhador digital | डिजिटल कर्मचारी |
| Skill Marketplace | Skill-Marktplatz | marché de skills | mercado de skills | mercado de skills | स्किल मार्केटप्लेस |
| go-live gate | Go-Live-Gate | porte de mise en ligne | compuerta de puesta en producción | porta de entrada em produção | गो-लाइव गेट |

### 8.4 拉丁字保留政策（全语言通用）

Execution Hub、Canary、Fallback、contextPack、RBAC、on-behalf-of、A2A、permit、Ed25519、OIDC、SSO
在所有语言版本中保留拉丁字原样（业界惯例），不强行本地化转写。

## 九、功能层全球化增补（2026-10-16）

> 八组功能层抽取团队接入后统一审校确定的高频术语。**同键唯一裁决口径**：运行时词典以中文原文为键、
> 三层浅合并（platform-i18n → console → panel，同键后者覆盖前者），同一中文键在全层只允许一个权威译文；
> 本节词条即本轮跨文件重复键裁决所依据的术语契约。

| 中文 | English | 日本語 |
|---|---|---|
| 审批单 | approval ticket | 承認チケット |
| 业务审批 | business approval | 業務承認 |
| 安全加签 | security co-sign | セキュリティ加簽 |
| 待审批 | pending approval | 承認待ち |
| 审批中 | under review | 承認中 |
| 三方身份 | third-party identity | サードパーティ ID |
| 绑定 / 解绑 | bind / unbind | バインド／バインド解除 |
| 主体（计量/认证） | principal | プリンシパル |
| 负责人（Agent/应用等资产） | owner | 担当者 |
| 负责人悬空 | vacant leader | リーダー不在 |
| 组织隔离 | organization isolation | 組織分離 |
| 组织子树 | organization subtree | 組織サブツリー |
| 数据分级上限 | data classification cap | データ分類上限 |
| 破窗 override | break-glass override | ブレイクグラスオーバーライド |
| 能力清单（任用） | capability manifest | ケイパビリティマニフェスト |
| 健康巡检 | health check | ヘルスチェック |
| 探测（连通性探测） | probe | 疎通確認 |
| 泳道 | swim lane | スイムレーン |
| 唤醒（执行中枢） | wakeup | ウェイクアップ |
| 试运行 | trial run | トライアル運用 |
| 退场（资产生命周期） | retire | 退場 |
| 部门面板 | Department Panel | 部門パネル |
| 接入提示词 | onboarding prompt | オンボーディングプロンプト |
| 凭证换牌 | credential re-exchange | クレデンシャル再交換 |
| 用量归口 | usage attribution | 使用量の帰属 |

## 十、定位论述术语增补（2026-10-29）

> 根 README 定位重写引入的论述术语，仅用于产品定位与叙述文本，不进入协议层。
> 「生产关系 / 生产力」为政治经济学既有概念，各语言采用通行译法；日文注音从略。

| 中文 | English | 日本語 |
|---|---|---|
| 生产关系 | production relations | 生産関係 |
| （新）生产力 | (new) productive forces | （新）生産力 |
| 生产资料 | means of production | 生産手段 |
| AI 原生组织 | AI-native organization | AI ネイティブ組織 |
| 新生产关系的运行底座 | runtime foundation for new production relations | 新しい生産関係の実行基盤 |
| 确权（资产登记确权） | asset ownership registration | 資産の帰属確定（登記による確権） |
| 动态派单 | dynamic dispatch | 動的ディスパッチ（ダイナミックな作業割り当て） |
| 价值分配 | distribution of value | 価値の分配 |
| 议价能力 | bargaining power | 交渉力 |
| 透明用量计量 | transparent usage metering | 透明な使用量計測 |
| 未定价（显式标注） | unpriced (labeled explicitly, `cost_status=not_priced`) | 未価格（明示マーク、`cost_status=not_priced`） |
