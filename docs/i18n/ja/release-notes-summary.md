# リリース履歴サマリ（Release History Summary・日本語版）

> **日本語版** — 機械翻訳支援＋i18n PM による統一校正。**中文原文が正式版です（齟齬時は中文が優先）。**
> 原典: `docs/internal/release-notes-*.md`（各回の中文リリースノート） · 原典基準日: 2026-10-15 · 用語集: [GLOSSARY.md](../GLOSSARY.md) · ガバナンス: [README.md](../README.md)

国際読者向けに、M0（2026-09-09）から最新の 2026-10-15 バッチまでのリリース履歴を年表形式で統合したものです。
各項目の詳細（契約変更の全リスト・検証記録・運用手順）は、リンク先の**中文リリースノートが正式版**です。
内部エンジニアリング文書（契約・ハンドオフ・QA 報告）は中文のまま内部資産として維持されており、
本サマリはその対外可視部分の濃縮です。

**読み方の注意**：

- テスト・演習の件数（selftest 件数など）は**直近の実行時点の値**であり、歴史的なカウントは無効とされています
  （M0 以降の明示方針）。年表内の数値は「そのリリース時点の記録値」です。
- 本プラットフォームは M0 以降、金額決済セマンティクスを持ちません（[usage-reporting.md](usage-reporting.md) 参照）。

---

## 1. 年表（2026-09-09 〜 2026-10-15）

| 日付 | マイルストーン | 一行要約 | 中文リリースノート |
|---|---|---|---|
| 2026-09-09 | **M0 合規収束** | 従量課金・転売・収益配分を廃止し、ウォレット／配分サブシステム（plugin-billing）をアーカイブ封印。対外提示を「利用量透明化＋内部コスト透過」に一本化。J4 利用レポート契約 v1 を凍結、価格簿をゼロ価格スナップショット（charge 恒 0）＋内部調達コスト参考値に刷新。`/api/billing/*` 全端点を廃止し `/api/usage/report/monthly` を新設 | [release-notes-2026-09-09-m0.md](../../internal/release-notes-2026-09-09-m0.md) |
| 2026-09-11 | **バージョン最適化批次（M1-1 契約凍結）** | J1 パネル技能／Agent 指名直調（誠実降格 200+`ok:false`）・J2 統一入口トリアージ・J3 セッション直通・J4 の 4 契約 v1 を凍結。セキュリティヘッダ既定有効化（`SECURITY_HEADERS`）、usage イベント保持ポリシー既定 730 日（`USAGE_RETENTION_DAYS`）を導入。selftest 997/997 | [release-notes-2026-09-11-optimization.md](../../internal/release-notes-2026-09-11-optimization.md) |
| 2026-09-11 | **IAW ギャップ批次** | flow-core ワークフローオーケストレーション域（TF＋ステップ状態機械・テンプレート contextPack・SLA・ガント）、データ資産域（データセット登録・4 軸品質スコア・リネージ逆引き・指標ディクショナリ仲裁）、モデルチャネル治理（分級路由・フォールバックチェーン・予算熔断・TTFT 正直未収録）、Agent 自律 A0-A3 と A2A 指名呼び出し、IAM シーン級認可（sceneCode deny→allow→fail-closed）、監査証拠アンカー、通知センター永続化。19/20 項を一括着地。selftest 1067/1067 | [release-notes-2026-09-11-iaw-batch.md](../../internal/release-notes-2026-09-11-iaw-batch.md) |
| 2026-09-12 | **QA-20260912 修復批次** | 9/12 の四領域（セキュリティ／計量／編成／市場）テスト報告から P1 全 7 件＋P2 12 件を修復：sceneGuard の flow 三入口接线、org_admin 越境アカウント管理の遮断（`assertManageScope`）、アプリ所有者守衛、J4 月報 tokens 176 倍過小計上の SQL 修正、イベントバス自己増幅ループの遮断、ワンクリックロールバックの死路修正など。selftest 1118/1118 | [release-notes-2026-09-12-qa-fixes.md](../../internal/release-notes-2026-09-12-qa-fixes.md) |
| 2026-09-13 | **QA 修復批次（全機能系統的テスト）** | 約 630 用例の四領域並行テストから 15 件修復（P0×1・P1×6・P2 提級×8）：アカウント接管を許す `PATCH /api/iam/users/:id` の割当ホワイトリスト収束（SEC-01）、approval decision 入力検証、draft Agent からの L4 下線発行禁止、価格簿数値検証、内蔵ロール移行の首啓空振り修正（ARC-01）など。selftest 1118/1118 維持 | [release-notes-2026-09-13-qa-fixes.md](../../internal/release-notes-2026-09-13-qa-fixes.md) |
| 2026-09-15 | **承認ロジック調整** | 業務判断により：①スキル二段階承認で同一人が domain＋security を順次通過可能に、②承認センターで差戻しチケットの削除を許可、③申請者＝承認者の「自審自批」遮断を解除（高リスク二重確認 `confirmed` は継続強制）。[user-guide.md](user-guide.md) §5・§11 の口径 | [release-notes-2026-09-15-approval-relax.md](../../internal/release-notes-2026-09-15-approval-relax.md) |
| 2026-09-16 | **M2 イテレーション** | FinOps レポート v1（CFO ビュー：部門×モデル交叉マトリクス＋前月比＋Top 消費主体、アイドル稼働検出 v1 は近似口径・要人工確認を明示、`#/finops`、UTF-8 BOM CSV）、首啓体験の製品化（`GET /api/platform/bootstrap`・「上线三步走」ガイド）、Ed25519 署名基盤のプラットフォーム級共通化とリリースマニフェスト検証。selftest 1173/1173 | [release-notes-2026-09-16-m2.md](../../internal/release-notes-2026-09-16-m2.md) |
| 2026-10-13 | **REFACTOR-2026-10-13 基線（全局リファクタ開始）** | paperclip 対照の七項収束：R4 console バックエンド分割（4,702 行→300 行×15 域ファイル）、R5 鑑権ボイラープレートの rest-gate 単一実装化、R1 中文収束（lint:cjk ゲート）、**R10 プロトコルキー中文対照総表（280 キー）**、**表現層は中文単言語と決定**（R10 口径：イベント名・権限点・エラーコード・API エンベロープ・環境変数等は ASCII のまま、機械契約として保持）。同日、定制軌（custom/dsh-rq）の機能凍結を公告（リファクタ期間中は同期演習ベース） | [定制轨冻结公告-20261013.md](../../internal/定制轨冻结公告-20261013.md) · リファクタ詳細は中文原典 `README.md`「最近更新」 |
| 2026-10-14 | **実行ハブ（plugin-exec-hub）＋デザイン適応** | 実行ハブ全体提供：ゴールアライメント（`exec:goals` 目標ツリー＋指標三要素→projects→issues・goalAncestry）、30 秒ハートビートループ（起動キュー冪等キー・ガバナンス事前チェックチェーン・待ち引き三源・5 段階ヘルススコア）、issue 実行ロック CAS（64 組合せ網羅＋ゾンブロック回収）、定期スケジューリング（interval／5 項 cron／webhook パス即クレデンシャル）、Agent 組織化（orgRole/rank/managerId）、主体予算超過連動凍結＋L4 解凍承認、モデルカタログ管理面。selftest 1257/1257。同日深夜、Kimi CIO ダッシュボードデザイン適応（design token 全面刷新・`data-platform` 五主題維持・dsh 挂載形態 `/rq` での同一源完全ページ化・全ページ描画スモーク 31/31 新設）。selftest 1258/1258 | [qa-report-20261014-execution-hub-delivery.md](../../internal/qa-report-20261014-execution-hub-delivery.md) · [design-adaptation-spec-20261014.md](../../internal/design-adaptation-spec-20261014.md) |
| 2026-10-15 | **審査フィードバック全体整改批次** | 全審査報告の未閉鎖整改項を一括収束：IAM ツールブリッジ越境 fail-open の三層収口（fail-closed 化）、`/docs` を公開ホワイトリスト制へ（部署 runbook・内部文書は 404）、MCP ツール権限最小化（24 ツール補完宣言→`/mcp` tools/list 全 82 ツール x-permission カバレッジ強制）、モデルチャネル降級チェーンの予算守衛、口令 KDF を scrypt へ、CSP＋no-store、イベントバス並行配信（`Promise.allSettled`）、データリネージ循環検出など。selftest 1343/1343（既存断言の改変ゼロ） | [release-notes-20261015-audit-remediation.md](../../internal/release-notes-20261015-audit-remediation.md) |
| 2026-10-15 | **W 批次（デジタルワーカー第二期）** | ワークフォース第二期の全体交付：MCP ツール信頼リスク登録フロー（V11 根治：遠端 `tools/list` の書き込み系は「登録→審査→発効」必須）、REST／Panel 接入面の等価収束（`/api/mcp/invoke` に `work` インデックス透過、同一マシンクレデンシャルで `/mcp` と同挙動）、usage 代報の `X-On-Behalf-User` ホワイトリスト収束、`workforce.admin` 運用面（一括停職・任用監査レポート・台帳清掃）、グレースケール交付パッケージ。**六門検証：lint 全緑・selftest ≥1380・drill ≥37**（※数値は直近の実行時点のもの。履歴カウントは無効） | [数字员工二期开发计划-20261015.md](../../internal/数字员工二期开发计划-20261015.md) |

---

## 2. マイルストーン間の補足

- **ソースの正確性**：上記のほか、2026-09-11 IAW 批次の 7-2（会話内実行計画カード）のみ**契約は整備・実装は
  意図的に欠席**（多段計画プロトコルは Agent のストリーミングチャネル先行が必要、偽実装はしない）と
  正直に申告されています。これは本プロジェクトの「誠実な未実装申告」文化の代表例です。
- **2026-09-11〜09-15 の承認セマンティクス変遷**：09-13 QA 批次で「自審自批の禁止（A-05）」と
  「二段階承認の異人制（REL-03）」を強制したのち、09-15 に業務判断で両者を解除しました
  （高リスクの二重確認 `confirmed=true` は継続）。外部連携が承認フローを自動化している場合は
  09-15 以降の口径に合わせてください。
- **bundle 装着数**：プラグイン市場からの bundle 一括インストールのエントリ数は、W 批次で
  24 から **25**（workforce 域の追加）に更新されました（`llms.txt`／`cordis.patch.yml` と同期）。
- **dsh 接続先リポジトリ**：`dsh plugin --profile web add github:01men/ybkkasi`（2026-10-14 に
  01men/ybkk-AIOS から本リポジトリへインストール源を移行済み）。

---

## 3. 主要マイルストーン詳細（統合者・レビュアー向け）

年表の一行要約では拾いきれない、統合やレビューの判断に影響する技術詳細を、主要マイルストーンごとに整理します。
すべて中文原典のリリースノートに基づきます。

### 3.1 M0 合規収束（2026-09-09）の詳細

- **廃止された API（代替を含む）**：`GET /api/billing/wallets/:ownerType/:ownerId`（なし — 残高セマンティクス廃止、
  利用は `GET /api/usage/report/monthly` へ）、`POST /api/billing/recharge`（なし）、`GET /api/billing/journal`
  （→ `GET /api/usage/events`）、`POST /api/billing/verify`（→ `POST /api/usage/reconcile`）、
  `PUT/GET /api/billing/budgets/:orgId`（なし — 予算ゲート廃止）、`POST /api/billing/settle` ／
  `GET /api/billing/ledger` ／ `POST /api/billing/ledger/reverse`（なし — 配分廃止）、
  `GET /api/market/subscriptions`（なし — 代収廃止）。
- **API 形状変更**：`POST /api/modelgw/invoke` の応答から `chargeCents` ／ `balanceAfterCents` を削除し
  `costCents`（内部コスト参考）を追加。残高・予算プリチェック拒否は modelgw 面から消滅
  （`quota.exceeded` は modelgw 面で発生しなくなる）。`GET /api/assets/benefit` から
  `charge_cents`／`margin_cents`（収入・粗利セマンティクス）を削除。
- **権限点の削除**：`billing.read` ／ `billing.write` ／ `billing.admin`（既存ロールがこれらを含む場合、
  解析時に自動無視 — データ移行は不要）。
- **価格簿の移行**：`mcp:*` は「list 30／cost 15 分/千 tokens」から「list 0／cost 15
  （rate_version `v2026.09-cost`）」へ自動移行（既定値から運営が変更していない条目のみ）。
- **封印記録**：plugin-billing の既存取引流水は CSV で読み取り専用封印 90 日
  （中文原典 `docs/billing-archive-register.md` に登録・廃棄日を記載）。

### 3.2 M1-1 契約凍結（2026-09-11 最適化批次）の詳細

- **J1（パネル技能／Agent 指名直調）**：`GET /api/panel/:dept/skills`（`panel.read`）、
  `POST /api/panel/:dept/skills/invoke`（`panel.write`）。**誠実降格の契約**：降級時は 200 ＋ `ok:false`、
  鑑権不足は 403、範囲エラーは 400。定制側の対表項目：計量資源キーを `skill:<slug>` から **`skill:<ID>`** に変更
  （slug に非 ASCII が含まれ resource 検証を通過しないため）。
- **J2（統一入口トリアージ）**：管理系権限点 4 点（`iam.user.read`／`approval.read`／`audit.read`／`usage.read`）
  の有無で着地面を判定。判定は裸着地（hash なし）の時のみ発火し、深いリンクのリロードでは発火しません。
- **J3（セッション直通）**：チケット→`rq_sid`→セッション兌換の全チェーン。両端（コンソールとパネル）の
  セッションは互いに排除しません。
- **行為強化**：全 HTTP レスポンスに `x-content-type-options: nosniff`、`x-frame-options: SAMEORIGIN`、
  `referrer-policy: strict-origin-when-cross-origin`。usage イベントは既定 730 日保持
  （`USAGE_RETENTION_DAYS`、0=永久）。`invokeSkill` の自動選模は「オンラインかつ endpoint 設定済み」の
  モデルのみから選択。

### 3.3 IAW ギャップ批次（2026-09-11）の詳細

- **三契約の凍結**：モデルチャネル治理（`docs/contract-c1-modelgw-channel-governance.md`）、
  トランザクションフロー（`docs/contract-c2-flow-tf.md`）、Agent 自治と A2A（`docs/contract-c3-agent-a2a.md`）。
- **新設権限点**：`resource.dataset.write`、`flow.read`／`flow.write`／`flow.admin`、`iam.scene.write`、
  `agent.a2a.invoke`（PermissionCatalog ＋内蔵ロール＋移行表に登録、既存 DB は起動時に自動補完）。
- **TTFT の正直な未収録**：チャネル遥測の `ttftMs` は `null` で、口径説明付き（ストリーミングチャネル待ち）。
  内容セキュリティ遮断フックも契約上「正直に欠席」と申告。
- **通知センター**：`console:notifications`（30 日保持＋2000 件リング）＋ since 増量＋既読カーソル
  （端末間ローミング）。タスク（組織範囲）／アラート（グローバル）／承認（グローバル）が自動記帳。
- **usage 側の証拠アンカー口径**：`usage_events` は SQL トランザクション表のため schema v1 凍結期は
  `trace_id` で関連付け（列追加は schema v2 で別議）。

### 3.4 QA 修復批次（2026-09-12／09-13）の詳細

| 代表修復 | 内容 |
|---|---|
| SEC-01（P0） | `PATCH /api/iam/users/:id` が status/passwordHash を書き換え可能（アカウント接管・凍結回避）→ サービス層で割当ホワイトリスト収束、範囲外 400 |
| B-01 | J4 月報の tokens が 176 倍過小（SQLite の GROUP BY 内相関サブクエリの評価タイミング問題）→ `SUM((SELECT …))` で行別集計に修正、三軸自整合（totals=ΣbyOrg）を断言化 |
| A-03 | org_admin による越境アカウント管理 → `assertManageScope` で非プラットフォーム管理者は自組織サブツリーのみ管理可、マシン主体・帰属不能は fail-closed 拒否 |
| C-01 | イベントバスの自己増幅ループ → `bus.listener_error`／`bus.dead_letter` 自身のリスナー失敗は回授せず直ちにデッドレターへ |
| E-01 | ワンクリックロールバックの死路 → `applyUpdate` が npm install 前にロールバックスナップショットを永続化 |
| A-06 | 六類の L4 承認に `riskLevel:'high'` を補完し二重確認（`confirmed=true`）を強制効力化 |

- 09-13 批次はさらに 15 件（SEC-02/03、REL-01〜08/10〜12、ARC-01）を修復し、
  「REST 入参への統一検証施設がない」という横断的根因を次期立案項として認定しました。

### 3.5 M2（2026-09-16）の詳細

- **FinOps v1 の正直な境界**：アイドル稼働検出 v1 は近似ヒューリスティックで、ページに
  「近似口径・要人工確認・考核には使用しない」と明示。前月比は prev=0 かつ cur>0 の場合
  `delta_pct=null`（無理な百分率を作らない）。交叉マトリクスの合計は常に model 域の全口径コストと一致。
- **技術債の回収**：T5 — Ed25519 署名基盤のプラットフォーム級共通化（`platform-core/src/signature.ts`）と
  リリースマニフェスト検証（`scripts/release-manifest.mjs`、`requireSignedManifests` 防呆付き）。
  T2 — `connect.degraded` の監査接線。T6 — 課金プリチェック残留の清掃＋防再発スキャン断言。
- **排障の実績記録**：market re-export 別名がモジュール内バインディングを作らない問題、
  catch が try 内 const を参照する TDZ 問題（cordis が console を 0ms・無ログで静かに suspend する現象）、
  非 guarded ルートが return だけして応答を書かない問題 — 三件ともコードコメントに記録。

### 3.6 REFACTOR-2026-10-13 基線の詳細

- **七項収束**：R4 console バックエンド分割（4,702 行→300 行×15 域ファイル）、R5 鑑権ボイラープレートの
  rest-gate 単一実装化、R1 中文収束（lint:cjk ゲート導入）、R10 プロトコルキー中文対照総表（280 キー）、
  エラーマッピング全集断言、R6 接続器リスク宣言ディレクトリ（S1/S2 分層）、R7 デザイントークン三端単一源
  （定制軌は `:root` の上書きだけでブランド色を変更可能）。
- **言語口径の決定（R10）**：本プロジェクトは**中文単言語製品**とし、英語 UI バージョンを維持しない。
  表現層（コンソール／パネル／ポータル／CLI 出力／通知・承認文言／エラーメッセージ）はすべて中文。
  **プロトコル層は例外** — イベント名・権限点・エラー原因コード・API エンベロープ・環境変数名・
  ブラウザストレージキーは ASCII キーのまま（クロスシステムの機械契約）。
  〔2026-10-16 更新：本リリースより表現層に言語切替が内蔵されました（簡体字中国語〔既定〕／英語 en-US／日本語）。プロトコル層の ASCII キーは不変です。〕
- **定制軌の凍結**：リファクタ期間中、custom/dsh-rq（RQ-DSH）は機能凍結。同期は各段末の演習ベースで、
  正式同期（Phase 4）で `@ybkk/gate-01` の新版を Ed25519 署名付きでリリース予定（中文原典の公告を参照）。

### 3.7 2026-10-14（実行ハブ＋デザイン適応）の詳細

- **実行ハブの検収**：selftest 1257/1257（「実行ハブ」セクション 47 項追加：目標ツリー循環拒否・血縁物化・
  assign 自動入隊・CAS 取得ロック・二度目の起動は遅延キュー・冪等キー重複排除・done でロック解放・
  P0 承認ゲート閉ループ・webhook 404 fail-closed・ゾンブロック回収・R10 凍結-解凍全閉ループ・
  R3 ワイルドカード熔断・R4 削除面・R11 収束と越境 403）。exec-hub 純決策層の単体テスト 13 項
  （起動準入 64 組合せ網羅）。
- **R2-R12 の治理収口**：R7 Agent 組織化、R10 予算深化（主体拡張 `agent:<id>`／`app:<id>`、
  metrics-report の自動入帳、超過連動停用＋`agent.unfreeze` L4 解凍）、R3 ワイルドカードセマンティクス、
  R4 削除面、R11 マルチ企業リスト収束、R12 職責分離の再議（`agent.online` のみ「申請者≠承認者」を復活）。
- **デザイン適応**：design token 全面刷新（暖紙＋深青藍の CIO ダッシュボード基調）、深色サイドバー→浅暖色化、
  `data-platform` 五主題メカニズムは維持、dsh 挂載形態（`/rq` 接頭辞）での同一源完全ページ化
  （`window.open`／`alert` 等のポップアップ禁止を selftest 断言化）、全ページ描画スモーク `scripts/page-smoke.mjs` 31/31 新設。
  既存稼働インスタンスは新バックエンドルートの登録のため 1 回の平滑再起動が必要。

### 3.8 2026-10-15 の二批次（監査整改＋W 批次）の詳細

- **監査整改批次の核心**：N1 — IAM ツールブリッジが manageActor を伝えず fail-open だった越境穴を三層で収口
  （橋側の `_actor` 剥離＋サーバー信頼身元注入／サービス層 fail-closed 化＋全呼び出し元 15 箇所の帰属監査）。
  G2-01 — `/docs` 全 69 篇の匿名公開を公開ホワイトリスト制へ（対外接続ガイド等の限定文書のみ 200、
  それ以外は 404、`%2F` トラバーサル対策維持）。P1-A 台帳 — permission 未宣言の 24 ツールを全て最小権限で補完し、
  selftest は `/mcp` `tools/list` の x-permission 全カバー（82/82）を強制。
- **W 批次の核心**：W1 — MCP ツール信頼リスク登録（未登録ツールの書き込み系を一律拒否、
  登録→審査→発効の状態機械、既存 read 扱いツールの重審リスト生成）。W2 — REST `/api/mcp/invoke` への
  `work`（permitId/runId/stepKey）インデックス透過。W4 — usage 代報の `X-On-Behalf-User` ホワイトリスト収束
  （範囲外 403 ＋ `audit.authz.denied`）。W5 — `workforce.admin` 運用面。W6 — ドキュメント口径の同期
  （bundle 25 エントリ等）。W7 — グレースケール交付パッケージ（実行時連調・単一部門試岗・回滾演習・組織級スイッチ）。
- **六門検証の数値について**：lint 全緑・selftest ≥1380・drill ≥37 は**直近の実行時点の値**です
  （本リポジトリの方針：履歴カウント無効）。引用時は必ずこの注記を付けてください。

---

## 4. 契約安定性ノート（Contract Stability Notes）

国際的な連携者・統合者に向けて、本リポジトリの契約（contract）安定性に関する規律をまとめます。

### 3.1 additive-only と schema v1 の凍結

- **usage schema v1 は凍結**：計量イベントのスキーマ（`usage_events`）は v1 凍結中で、
  すべての変更は additive-only（追加のみ）です。破壊的変更は schema v2 の升版契約として別途協議されます
  （例：監査証拠アンカーの usage 側列追加は v2 で別議、現行は `trace_id` 関連付け）。
- **イベント族は additive-only**：旧イベント定数（`wallet.balance.changed` 等）は廃止後も定数として保持され、
  削除しません。ただしプロデューサーが消滅したイベントは届かないため、購読面の除去が必要です（M0 §2.3）。
- **J1〜J4 契約の変更規律**：契約升版にはリリースノートの発行と両側（ホスト軌・定制軌）の同期が必要です。
  定制軌はリリースノートを merge の翻訳層として使用します。

### 3.2 ASCII プロトコルキー（R10 口径）

- イベント名・パーミッションポイント・エラー原因コード・API エンベロープ（`ok/data/error`）・
  環境変数名・ブラウザストレージキー・HTTP ヘッダ（`X-On-Behalf-User`）は、**いかなる言語版でも
  翻訳・転写・ローカライズしません**。これらはクロスシステムの機械契約であり
  （RQ-DSH 定制軌・既存 MCP クライアント・selftest 断言・dsh ホスト検証が依存）、
  2026-10-13 REFACTOR の R10 で正式決定されました。
- 各キーの中文権威解釈は `docs/协议键中文对照总表.md`（280 キー）に集約され、
  新規の対外プロトコルキーは必ず同表へ同期登録します。本日本語版を含む全訳稿はキー名をそのまま保持します。

### 3.3 契約凍結の実務規律

- **「先に契約を凍結し、後に実装する」**：すべての機能批次（例：W 批次）は「契約凍結 → 並行開発 →
  統合検収」の順で進行し、実装着手前にデータ契約・API 契約・ゲート拒否コードのセマンティクスを
  総責任者が凍結します。
- **検収は六門で行う**：`lint:boot-order`／`lint:manifests`／`lint:cjk`／exec-hub 純戦略単体テスト／
  `npm run selftest`／`tests/workforce-loop-drill.mjs`。いずれか一門でも赤なら差し戻しです
  （数値は直近の実行時点の値が正）。
- **誠実な未実装申告**：実装が間に合わない項目は「契約は整備・実装は欠席」と明示し、
  偽の実装（stub による偽装成功）を行いません。テスト内の stub もプロセス内の実 HTTP サービスであり、
  mock への降格はしません。
- **UI 言語方針**：2026-10-16 リリースより、表現層に言語切替が内蔵されました（簡体字中国語〔既定〕／英語 en-US／日本語。画面上部セレクター、設定は `rq_lang`、CLI は `--lang`／`DSHCTL_LANG`、辞書未収録の文言は中文にフォールバック）。
  プロトコル層の ASCII キーはこの方針の例外であり、かつ機械契約として永久に不変です。

---

## 5. 関連ドキュメント（日本語版）

- [user-guide.md](user-guide.md) — 機能使用ガイド（全域）
- [deploy-enterprise.md](deploy-enterprise.md) — 企業導入 runbook
- [app-sso-integration.md](app-sso-integration.md) — アプリ SSO 接続ガイド
- [usage-reporting.md](usage-reporting.md) — 利用量透過と FinOps レポート（J4）
