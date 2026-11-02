> **日本語版** — 機械翻訳支援＋i18n PM による統一校正。**中文原文が正式版です（齟齬時は中文が優先）。**
> 原典: `docs/internal/ecosystem-design-v1.2.md`（補助原典 `README.md`）· 原典基準日: 2026-10-15 · 用語集: [GLOSSARY.md](../GLOSSARY.md) · ガバナンス: [README.md](../README.md)

# DSH エコシステムガイド — YuanBingKe（ybkk-AIOS）

本書は、YuanBingKe（製品の中国語名: 元冰可）が構築されている **DSH (DeepSeek Harness) エコシステム**の
考え方と参加方法を説明します。アーキテクチャ思想・ホストへのマウント・プラグインの構造・
プラグインマーケット・参加者の役割・プロトコルガバナンスを扱います。

---

## 1. DSH（DeepSeek Harness）とは

DSH は、プラグインアーキテクチャに基づく AI エージェント／ハーネスの実行基盤です。
ホスト（dsh 宿主）が Web サーバ・ツール実行基盤（ToolRuntime）・会話セッションを提供し、
機能はすべてプラグインとして追加されます。YuanBingKe はこの dsh のプラグイン規約の上に構築された
エンタープライズ AI リソース管理プラットフォームであり、dsh と**同一のプラグインフレームワークと
同一の稼働規律**を共有します。

## 2. cordis プラグインフレームワーク

プラグイン基盤は cordis（`@deepseek-ai/cordis`）です。各プラグインは依存関係を宣言してコンテキスト
（`ctx`）にサービスを提供し、プラグイン間の連携はイベントバスまたは拡張ポイントを通じて行われます。
YuanBingKe では、稼働中のプラットフォーム全体が一棵の**プラグインツリー**であり、
「すべてはプラグイン」が文字どおりの構造です。

開発上の重要な制約として、プラグインとホストは**同一の cordis インスタンス**を共有する必要があります
（2 つのインスタンスが混在すると、`ctx.plugin(...)` によるサービス解決が静かに失敗します）。
このため依存関係の宣言ルールが定められています（第 5 節）。

## 3. 「すべてはプラグイン」の思想

- 各業務ドメイン（IAM・MCP・スキル・Agent・アプリ・計測・監査等）が 1 つのプラグインパッケージです。
- 各プラグインは依存・パーミッションポイント（権限ポイント）・イベントを**独立宣言**し、
  **独立した起動・停止**が可能です。
- 状態変更は必ずイベントを発行し、横断参照（他プラグインのデータへの直接アクセス）は禁止です。
  例: `iam.user.frozen` → authn が全トークン失効、`mcp.unhealthy` → 遮断＋監査。
- プラットフォームの能力はイベントとツール（ToolRuntime 契約）を通じて、コンソール・CLI・Agent・
  任意の MCP クライアントに対して同一契約で開かれます。

### 3.1 プラグインツリーの規模

YuanBingKe のバンドルインストールは **25 個のプラグインエントリ**で構成されます: アクセス層 5
（console・dsh-bridge・panel-core・dingtalk-bridge・rq-card）＋ 業務ドメイン 18（iam・authn・mcp・nas・
skillhub・agent・app・usage・modelgw・connector・market・audit・connect・update・portal・flow-core・
exec-hub・workforce）＋ 底座 1（resource-core）＋ 基礎層 1（platform-core）。
完全な一覧は[README.md](README.md)「4.1 プラグインツリーの構成」を参照してください。

## 4. YuanBingKe の dsh へのマウント

### 4.0 実行形態の比較

| 形態 | プロセス構成 | 入口 | データ | 適する場面 |
|---|---|---|---|---|
| 独立ホスト | `node src/main.ts` の 1 プロセス | プラットフォーム自身のポート（既定 7300） | 単一 `data/` | 最小構成の本番・評価 |
| 独立ホスト＋ dsh ランタイム | 独立ホスト＋ `dsh web --patch cordis.yml` | 両方（コンソール SPA は常に独立ホスト側が提供） | `data/` を共有 | Agent による自然言語運用 |
| ホストマウント（バンドル） | dsh web 内にプラグイン群を組込み（dsh-bridge、`startHttp: false`） | **dsh web のポートが唯一**（データプレーンは `/rq` 配下） | dsh ホスト側の `data/` | 単一入口で Agent とコンソールを両立 |
| リモート dsh 接続 | 遠端 dsh ＋ `dsh-plugin-connect` クライアント役 | 遠端 dsh のポート＋本機設定ページ | データはホスト側に保持 | 複数拠点・ソースコード不要・`data/` 共有不要 |

### 4.1 ホストブリッジ（dsh-bridge）と `/rq` プレフィックス

`dsh-plugin-dsh-bridge`（ホストブリッジ）は、YuanBingKe のデータプレーン（REST／コンソール SPA／docs／
MCP エンドポイント）を **`/rq` プレフィックス**で dsh webServer にマウントします。
`startHttp: false` を指定するとプラットフォーム自身の独立ポートは閉止され、**dsh web のポートが
唯一の入口**になります（単プロセス・単一入口のホストマウント形態）。

バンドルインストールは 1 コマンドです:

```bash
dsh plugin --profile web add github:01men/ybkkasi
```

### 4.2 運用ツールの dsh への露出

dsh 側にマウントされたプラグインは `provideToolRuntime: false` で動作し、運用ツールは
dsh ネイティブ ToolRuntime に直接登録されます。その結果、Agent は自然言語でプラットフォームを運用できます
（「すべての MCP サービスと稼働状態を列挙して」→ `mcp_service_list` の呼び出し、等）。
直近時点で 40 以上の運用ツールがこの経路で露出されています（数値は直近実行時点）。

### 4.3 リモート dsh 接続（第 3 の形態）

他の端末はプラグインマーケット経由で YuanBingKe を導入し、`dsh-plugin-connect` のクライアント役として
**1 回限りの接続コード（接入码）** でホストに認証できます。運用ツールの実行はすべてホストへ
リモート代理され、ソースコードのチェックアウトも `data/` ディレクトリの共有も不要です。接続コードは
ハッシュ保存・一回消費・TTL 付き・失敗ロック（15 分窓 5 回）のセキュリティ基盤を持ち、
権限は `readonly` / `operator` / `full` のテンプレートで収斂します。

### 4.4 リモート接続のセキュリティ基盤

- 接続コードは**ハッシュのみ保存**（作成時に一度だけ表示）、一回消費、TTL 既定 15 分、
  権限テンプレートは `readonly` / `operator` / `full` の 3 種。
- 接続試行の失敗ロック: 15 分窓で 5 回（送信元 IP 単位）。
- マシンクレデンシャルは遠端端末のローカルにのみ保存（ファイル権限 0600）。
- 接続後は既定 5 分間隔でハートビート（`POST /api/connect/heartbeat`。生存＋ツール数・稼働バージョン等の
  メタ情報。設定で無効化可能）。
- ホスト側コンソールの**プラットフォーム接続（平台接入）** ページで、接続済みクライアント・最近の使用・
  最近のハートビートを確認でき、任意の時点で無効化すると全機械トークンが即時失効します。
- クライアント側ツール: `connect_status` / `connect_setup` / `connect_login` / `connect_test` / `connect_reset`。
  ホスト側管理ツール: `connect_code_create` / `connect_codes` / `connect_clients` / `connect_client_disable`。

## 5. プラグインの構造

各プラグインパッケージ（`dsh-plugin-iam` 等、パッケージ名はそのまま ASCII）は次の標準解剖を持ちます:

```
dsh-plugin-<name>/
  plugin.yaml            # id / version / depends / permissions の宣言
  manifest/
    api.yaml             # REST ＋ ツール ＋ サービスキー（REST・CLI・MCP の三面で一致する事実源）
    permissions.yaml     # パーミッションポイント（統一 RBAC に登録）
    events.yaml          # 発行／購読イベント
    ui.yaml              # ルート ＋ メニュー
    billing.yaml         # 計測宣言面（互換維持。meter キー/単位のみ。金額側は常にゼロ価格スナップショット）
  src/index.ts           # サービス ＋ プラグイン組み立て
  src/tools.ts           # モデルへ露出するツール（dsh ToolRuntime 契約）
```

- **依存・権限・イベントの独立宣言**により、プラグインは互いの内部を知らずに連携できます。
- **`npm run lint:manifests`** が全プラグインのマニフェスト 5 面 YAML を検証する品質ゲートとして機能します
  （2026-10-15 時点で全件合格。件数は直近実行時点）。
- 依存の宣言ルール: `@deepseek-ai/cordis` は `devDependencies` にのみ置きます（`dependencies` に入れると
  インストール時に第 2 の cordis インスタンスが生まれ、サービス連鎖が破綻します。第 2 節参照）。

## 6. プラグインマーケット

`dsh-plugin-market` は、サードパーティ開発者と自社製品の双方のためのプラグインマーケットです。

- **契約の 5 面**: 上記 5 つの YAML マニフェスト（api／permissions／events／ui／billing）が
  登録・審査・インストール・計測の統一契約面になります。
- **Ed25519 契約署名検証**: 開発者は公開鍵ペアで契約に署名し、マーケットとホストが検証します
  （改ざん防止。スキャフォールドコマンド: `dshctl plugin init` → `dshctl plugin sign` → `dshctl plugin submit`）。
- **バージョン管理された公開**: 提出→静的スキャン→二段階承認→バージョン管理された公開。
  取り下げ（下架）には理由の記録が必要です。
- **L0 ランタイム**: 現行のゲートは宣言型（L0）プラグインのみを受理します。コードを実行する
  L1 サンドボックスは**ロードマップ（計画中）**です。
- **ゼロ価格計測宣言**: サードパーティ・自社を問わず、マーケット経由の計測登録は
  ゼロ価格スナップショット（M0 口径。金額の取引は生じません）。
- インストールしたプラグインは実行時に能力の宣言と実挙動の照合（ケイパビリティドリフト検出）が行われ、
  偏差はアラートと自動取り下げ審査につながります。

### 6.1 公開までの流れ（サードパーティ開発者）

1. `node cli/dshctl.mjs plugin init --id=<プラグインID> --dir=./my-plugin` — 契約の 5 面と
   開発者用鍵ペアを含む足場を生成します。
2. `src/index.ts`（サービス＋組み立て）と `src/tools.ts`（モデルへ露出するツール）を実装します。
3. `dshctl plugin sign --dir=./my-plugin` で Ed25519 署名します。
4. `dshctl plugin submit --dir=./my-plugin` で提出します。
5. 静的スキャン → 二段階承認 → バージョン管理された公開。
6. プラットフォーム管理者がインストールすると、計測宣言がゼロ価格スナップショットで登録されます
   （金額の取引は発生しません）。
7. 運用後は、宣言された能力と実挙動の照合（ケイパビリティドリフト検出）が継続的に行われます。

## 7. エコシステム参加者の役割

| 参加者 | 役割 |
|---|---|
| dsh ホスト運用者 | dsh ホストを運用し、YuanBingKe をバンドルインストールして `/rq` 経路で公開。リリース・バックアップ・接続コード運用を担う |
| プラットフォーム管理者（YuanBingKe 側） | IAM・権限設計・アセットの取り込み・管理・監査・プラットフォーム自己更新の運用。dsh 連携時は両面の権限境界を設計 |
| サードパーティ開発者 | プラグイン／スキルを開発し、開発者 ID を登録、Ed25519 鍵ペアで契約に署名、審査を経てマーケットに公開 |

## 8. プロトコルガバナンス（ASCII プロトコルキー）

イベント名・パーミッションポイント・エラーコード・API エンベロープフィールド（`ok`/`data`/`error`）・
環境変数名・ブラウザストレージキー・HTTP ヘッダ（`X-On-Behalf-User`）・コマンド・パス・パッケージ名は、
システム間の機械契約として**逐字 ASCII で保持**され、翻訳対象外です（R10 口径）。

- 中文の権威ある対照表: [docs/协议键中文对照总表.md](../../协议键中文对照总表.md)（中文・内部。280 キー）。
  本書を含む各言語版は、この表の語義を引用しつつ**キー名を書き換えません**。
- 新たな対外プロトコルキーの追加時は、この対照表への登記が必須です（リポジトリ規律）。

### 8.1 ASCII プロトコルキーの例（いずれも翻訳しません）

- **イベント名**: `platform.update.available`、`iam.user.frozen`、`agent.offlined`、`mcp.unhealthy`、
  `flow.*`、`usage.recorded`
- **パーミッションポイント**: `iam.user.write`、`platform.update.read`、`platform.update.apply`、
  `workforce.admin`、`usage.read`
- **API エンベロープ**: `ok` / `data` / `error`
- **環境変数**: `DEMO_SEED`、`ADMIN_PASSWORD`、`USAGE_RETENTION_DAYS`、`SECURITY_HEADERS`、
  `GITHUB_TOKEN`、`DSH_UPDATE_AUTO_CHECK`、`OIDC_ISSUER`
- **HTTP ヘッダ**: `X-On-Behalf-User`

## 9. エコシステムの進化と設計文書の位置づけ

- [docs/internal/ecosystem-design-v1.2.md](../../internal/ecosystem-design-v1.2.md)（中文・内部）は、エコシステムプラットフォームの
  設計基盤（2026-08 時点）を記録した**中文内部設計基線**です。**注意**: 同文書のうち
  ウォレット／複式分配／転売価格設定／サブスクリプション代収／資金経路に関する商用化設計は、
  **M0（2026-09-09）で廃止済み**です。現行の商用口径は「チーム＋ドメイン資産」の価格設定と
  利用量の透明化のみです（[README.md](README.md)「商用モデル」）。
- 同文書のうち**計測パイプラインとマーケット契約**の部分は引き続き有効な参照であり、
  現在の実装（schema v1 計測イベント・冪等キー・外部システム照合・契約の 5 面）の思想源です。
- 今後の拡張（KBaaS／コネクタマーケット／L1 コード実行サンドボックス等）は中文の [docs/internal/roadmap-9-10.md](../../internal/roadmap-9-10.md)
  （中文・内部）に構想として記録されており、いずれも**ロードマップ（計画中）**です。

M0（2026-09-09）で廃止された主な面（詳細は中文 [docs/internal/release-notes-2026-09-09-m0.md](../../internal/release-notes-2026-09-09-m0.md)〔内部〕）:

- **API**: `/api/billing/*`（ウォレット・チャージ・ジャーナル・検証・予算・決済・台帳）と
  `/api/market/subscriptions` を廃止。modelgw 応答からは `chargeCents` / `balanceAfterCents` を削除し、
  `costCents`（内部コスト参考）のみを残しました。
- **パーミッションポイント**: `billing.read` / `billing.write` / `billing.admin` を削除
  （既存ロールに含まれる場合は自動的に無視されます）。
- **イベント**: `wallet.balance.changed` / `billing.ledger.settled` は生産者を持たなくなりました
  （イベント定数は互換のため保持）。
- **封存**: plugin-billing はオフライン封存され、履歴データの CSV は 90 日間の封存ルールで管理されます
  （中文 [docs/billing-archive-register.md](../../billing-archive-register.md)〔内部〕に登録）。

## 10. 関連ドキュメント

- 製品全体像（国際版）: [README.md](README.md)
- クイックスタート（導入・デモモード）: [getting-started.md](getting-started.md)
- 位置づけ一回読み資料: [product-introduction.md](product-introduction.md)
- 用語契約: [GLOSSARY.md](../GLOSSARY.md) · ガバナンス: [README.md](../README.md)
- 中文原典（内部）: [docs/internal/ecosystem-design-v1.2.md](../../internal/ecosystem-design-v1.2.md)、ルート `README.md`
- 運用スキルハンドブック（同梱）: `skills/dsh-ops-*/SKILL.md`（総合索引 `dsh-ops-admin`）

## 11. 画面言語について

**2026-10-16 リリースより、実行 UI（コンソール／パネル／ポータル／CLI 出力／通知・承認文案／エラー表示）に
言語切替が内蔵されました：簡体字中国語（既定）／英語（en-US）／日本語。** 画面上部のセレクターで切替、設定はブラウザに保存（`rq_lang`）。CLI は `--lang` または `DSHCTL_LANG` に従います。辞書未収録の文言は自動的に中国語にフォールバックします。
プロトコルキー（イベント名・権限点・環境変数等）はもともと ASCII であり言語の影響を受けません。
本書の UI 表記は「日本語名（中文原文）」の二言語注記に統一しており、中国語固定運用や
画面キャプチャ照合時に引き続き有効です。補助手段としてブラウザのページ翻訳機能も利用できます。
