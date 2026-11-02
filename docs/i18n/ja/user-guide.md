# YuanBingKe（ybkk-AIOS）機能使用ガイド（日本語版）

> **日本語版** — 機械翻訳支援＋i18n PM による統一校正。**中文原文が正式版です（齟齬時は中文が優先）。**
> 原典: `README.md` · `llms.txt` · `docs/deploy-enterprise.md` · `docs/app-sso-integration.md` · `docs/nas-authz.md` · `docs/connector-integration.md` · `docs/app-rbac-guide.md` · `docs/panel-implementation.md` · `docs/entry-switching.md` · `docs/internal/a0-a3-autonomy-ladder-review.md` · `docs/host-features-ops-notes.md` ほか · 原典基準日: 2026-10-15 · 用語集: [GLOSSARY.md](../GLOSSARY.md) · ガバナンス: [README.md](../README.md)

YuanBingKe（ybkk-AIOS）は、DeepSeek Harness（dsh）の「すべてはプラグイン」アーキテクチャ上に構築された、
エンタープライズ AI リソース管理プラットフォームです。MCP サービス、スキル、エージェント、AI アプリケーション、
モデルルート、NAS ファイルストレージの 6 種類のアセットを、1 つのアイデンティティ（IAM／OIDC SSO）、
1 つの権限体系、1 つの利用量計測、1 つの監査で一元管理します。

本ガイドは、ロール別 × ドメイン別に、プラットフォームの全機能を包括的に解説します。

---

## 0. 本ガイドについて

### 0.1 読者とロールモデル

本ガイドの主な読者は、プラットフォームの導入・運用・利用に携わる次のロールです
（内蔵ロール：組み込みで提供される 6 ロールを基本とします）。

| ロール（日本語） | 中文原文 | 主な責務 |
|---|---|---|
| プラットフォーム管理者 | 平台超级管理员（`admin`） | 全権限。初期化・口令管理・自更新・組織設計 |
| 組織管理者 | 组织管理员（`hr` / org_admin） | 組織ツリー／アカウント／ユーザーグループ／サードパーティ同期 |
| リソース管理者 | 资源管理员（`ops` / resource_admin） | MCP／スキル／エージェント／アプリ／NAS／接続器の運用 |
| 開発者 | 开发者（`dev`） | スキルの提出、エージェントの登録、アプリの接続 |
| 監査人 | 审计员（`audit`、読み取り専用） | 監査ログ・アラート・承認センターの確認 |
| メンバー | member | 部門パネル・ポータルなど業務面の利用 |

権限の判定はロール名ではなく**パーミッションポイント（権限ポイント）**単位で行われます
（例：`iam.user.write`、`usage.read`、`platform.update.apply`）。パーミッションポイントの権威ある
中文対照一覧は `docs/协议键中文对照总表.md`（R10）を参照してください（本訳稿ではキー名は ASCII のまま保持します）。

### 0.2 画面言語について（現状説明）

- **実行時の画面（コンソール／パネル／ポータル／CLI 出力／通知・承認文言／エラーメッセージ）は、2026-10-16 リリースより言語切替に対応しています**:
  簡体字中国語（既定）／英語（en-US）／日本語。画面上部のセレクターで切替、設定はブラウザに保存（`rq_lang`）。
  CLI は `--lang` または `DSHCTL_LANG` に従います。辞書未収録の文言は自動的に中国語にフォールバックします。
- 本ガイドで画面上の位置を参照する際は、**「日本語名（中文原文）」の二言語表記**で案内します。
  この表記は、中国語固定運用や画面キャプチャ照合時に引き続き有効です（実画面の照会には括弧内の中文原文を使用します）。
- 補助手段としてブラウザのページ翻訳機能も引き続き利用できます。
- プロトコル層（イベント名・パーミッションポイント・エラーコード・API エンベロープ `ok/data/error`・環境変数名・
  REST パス・CLI コマンド）は、システム間の機械契約であるため**ASCII のまま**です（訳しません）。

### 0.3 表記規約

- コードブロック・REST パス・環境変数・イベント名・権限点は原文（ASCII）のまま記載します。設定例の本文とコメントのみ訳します。
- **M0 レッドライン**：本プラットフォームには金額決済セマンティクス（ウォレット／チャージ／清算／配分）は**存在しません**。
  対外提示は「利用量の透明化＋内部コスト透過」のみです（詳細は [usage-reporting.md](usage-reporting.md)）。
- 性能・テスト件数（selftest 件数など）は「**直近の実行時点の値**」であり、歴史的なカウントは無効というのが
  本リポジトリの方針です。本ガイドで触れる数値も同様に最近の実行時点の値とお考えください。
- 日付は本文では日本語形式、技術的文脈では ISO 8601（2026-10-15）で記載します。プラットフォームのログ時刻は
  サーバーのローカルタイムです。国際運用ではタイムゾーン換算が必要です。

---

## 1. プラットフォーム管理

### 1.1 ベースライン初期化とデモモード

- **本番の既定はベースライン初期化**：空のデータディレクトリで初回起動すると、内蔵ロール＋ルート組織＋
  プラットフォーム管理者 `admin` のみが作成されます（演示データは一切ありません）。
- **デモモード**：`DEMO_SEED=1 npm start` で起動すると、デモ組織ツリー／デモアカウント／MCP／スキル／
  エージェント／アプリと 28 日分の履歴データが注入されます。デモアカウントの口令はいずれも `Ybk@2026` です。
  **デモモードは評価・研修専用で、本番環境では絶対に有効化しないでください。**

### 1.2 admin 口令の管理（`ADMIN_PASSWORD`）

- 口令は環境変数 `ADMIN_PASSWORD` で指定します。未設定の場合はランダム生成され、
  一度だけ `data/admin-initial-password.txt` に書き出され、起動ログにも出力されます。**初回ログイン後すぐに変更してください。**
- 口令を忘れた場合：①データディレクトリを初期化して再起動する、または ②`iam.user.write` を持つ管理者が
  **組織とアカウント（组织与账号）→ アカウント詳細 → パスワードリセット**から再設定します。
- 初期口令ファイルは 0600 権限で書き出されます。変更後、サーバー上の同ファイルを削除すると、
  `GET /api/platform/bootstrap` が `initialPasswordPending:false` を返し、ログインページの警告バナーが消えます。
- 口令は scrypt KDF で保存され、タイミング攻撃耐性比較（`timingSafeEqual`）が適用されています。
  旧ハッシュのアカウントはログイン成功時に透過的にアップグレードされます。

### 1.3 ロールとパーミッションポイント

- 内蔵ロールには、第 0.1 節の 6 ロールに加え、目的別のパーミッションポイント群が割り当てられています
  （例：リソース管理者は `connector.*` 系、開発者は `catalog` ＋ `invoke` 系、監査人は各種 `.read` 系）。
- パーミッションポイントはプラグインの `manifest/permissions.yaml` で宣言され、統一 RBAC に登録されます。
  UI からは**認証とトークン（认证与令牌）**ページでマシンクレデンシャルのスコープを権限カタログ別に編集できます
  （REST：`PATCH /api/authn/principals/:id`、変更時は既存トークンが連動失効します）。
- カスタムロールの作成・削除、内蔵ロールの保護は REST で提供されます
  （内蔵ロールやまだマウントが残るロールは削除拒否されます）。
- 組織スコープ収束：プラットフォーム管理者（`*`）以外の管理操作は自組織サブツリーに制限され、
  越境は fail-closed で 403（`OrgScopeDeniedError`）になります。

### 1.4 サードパーティ接続器（DingTalk モック DD0002）

- DingTalk 接続器には、実 OpenAPI モード（`mode: real` ＋ `apiBase`）と mock モードがあります。
  デモモードでは mock 接続器により、ログインページの**DingTalk スキャン（钉钉扫码）**から
  従業員番号 `DD0002` でパスワードレスログインを体験できます。
- 本番のベースライン初期化では接続器を設定しないため、サードパーティログイン入口は自動的に非表示になります。
- 同期は接続器設定の**同期頻度（同步频率）**に従い定时自動同期されます（下限 5 分、`0` は手動のみ）。
  `IAM_CONNECTOR_AUTO_SYNC=off` で定时器自体を停止できます。
- 同一 DingTalk プラットフォームから複数の企業主体（corpId/appKey/appSecret の組）を
  **同一プロバイダ複数インスタンス**として接続できます（設定はインスタンス id でアドレス指定、
  `provider|corpId` で一意、重複主体は拒否）。REST：`POST /api/iam/connectors` ／ `DELETE /api/iam/connectors/:id`
  （権限点 `iam.connector.write`）。

### 1.5 セキュリティヘッダ（`SECURITY_HEADERS`）

- 全 HTTP レスポンスに既定でセキュリティヘッダが付与されます：
  `x-content-type-options: nosniff`、`x-frame-options: SAMEORIGIN`、`referrer-policy: strict-origin-when-cross-origin`、
  加えて CSP と `/api/*` の `cache-control: no-store`（2026-10-15 批次）。
- 一括で無効化する場合は環境変数 `SECURITY_HEADERS=off` を設定します。

### 1.6 プラットフォーム自己更新

アップストリーム（GitHub）の新バージョンを検知しますが、**アップグレードするかどうかは常に管理者が決定します**。

- **自動チェック**：既定で 24 時間ごと（起動 15 秒後に初回）。リモート `package.json` のバージョン比較＋
  GitHub compare のコミット差分で判定し、新バージョン検知時はコンソール頂部バーの**更新可能（可更新）**バッジと
  `platform.update.available` イベント（監査記録）で通知します。チェックの ON/OFF・頻度は
  **プラットフォーム更新（平台更新）**ドロワーで変更できます。
- **手動アップグレード（source 形態）**：ドロワーの**ワンクリックアップグレード（一键升级）**、
  または CLI `node cli/dshctl.mjs update status | check | apply [--dry-run]`。
  内部では `git pull --ff-only` ＋ `npm install` を実行し、未コミットの変更がある場合は安全に失敗します（強制上書きしません）。
  dry-run での予行演習、理由の監査記録、完了後の再起動促しに対応します。
- **Agent ツール**：`update_status` ／ `update_check` ／ `update_apply`。bundle 形態では
  `dsh plugin update github:01men/ybkkasi` の案内を返します。
- **内網・レート制限対応**：`GITHUB_TOKEN` で API 限额を引き上げ、`DSH_UPDATE_API_BASE` ／
  `DSH_UPDATE_RAW_BASE` でプライベートミラーを指定、`DSH_UPDATE_AUTO_CHECK=off` で自動チェックを停止します。
- **パーミッションポイント**：`platform.update.read`（表示・チェック）、`platform.update.apply`（アップグレード実行）。
- 供給網強化（任意）：リリースマニフェストへの Ed25519 署名検証（`releasePublicKey` 登録→
  `requireSignedManifests` 有効化、順序逆転は拒否）が可能です。`GET /api/update/status` が
  `releaseKeyConfigured` を返します。

---

## 2. IAM（ID・アクセス管理）

### 2.1 組織ツリーとアカウント

- 多階層の組織ツリー、一括インポート、アカウント状態機械（active／frozen／deactivated など）、
  動的・静的ユーザーグループを提供します。
- UI：**組織とアカウント（组织与账号）**。REST：`/api/iam/orgs`、`/api/iam/orgs/tree`、`/api/iam/users` など。
  アカウント一覧は非プラットフォーム管理者は自組織サブツリーに自動収束されます（`?orgId=` 越境は 403）。
- 凍結（freeze）すると全トークンが即時失効します（`iam.user.frozen` → authn 連動）。

### 2.2 ロール・ユーザーグループ

- ロールはパーミッションポイントの集合です。動的ユーザーグループは条件で自動再計算されます。
- 面板（パネル）の部門範囲権限のように、パーミッションポイントに加えて**組織サブツリー帰属**で
  二重に判定する局面があります（§16 参照）。

### 2.3 シーン単位の認可（sceneCode）

- ポリシーオブジェクトを sceneCode に紐付け、評価順は **deny → allow → fail-closed** です。
  ポリシー未設定のシーンは既存 RBAC／部門範囲にフォールバックし、挙動は変わりません。
- REST：`GET/PUT /api/iam/scene-policies`、`DELETE /api/iam/scene-policies/:id`
  （`iam.org.read` ／ `iam.scene.write`）、自己確認面 `POST /api/iam/scene-authz/check`。
- 全リンクの口径：flow ドメインの入口、パネルのタスク作成入口（2026-10-15 批次で接线）などに sceneGuard が組み込まれ、
  deny 時は 403 ＋ `audit.authz.denied` が記録されます。version 楽観ロック（衝突 409）対応。
- 関連イベント：`iam.scene_policy.changed`。

### 2.4 全員名簿 API（roster）

- `GET /api/iam/roster`（権限点 `iam.roster.read`）：接続済みアプリ（人事・業績など）が
  マシンクレデンシャルで在職アカウント＋組織ツリーを一括取得し、填报タスクの配布や `sub → 業務ロール`
  マッピングに使えます。
- 契約：`users[]`（`id` は userinfo の `sub` と同一の安定関連キー／username/displayName/email/jobNumber/
  title/orgId/orgName/primaryOrgId/status/accountType）＋ `orgs[]`（id/name/parentId/status/
  **leaderUserIds** — DingTalk `dept_manager_userid_list` 同期チェーン由来。部門の集計・承認者を直接特定できます）。
- **PII 最小化**：電話番号を含まず、退職（deactivated）アカウントは名簿に現れません。取得ごとに invoke 監査が残ります。

### 2.5 アプリ組織同期

- `GET /api/apps/:id/org-sync`：接続アプリが自らのバインド済みマシンクレデンシャルで組織ツリー＋在職メンバーを
  取得し、アプリ内で組織機能（組織ツリー・部門メンバー・責任者識別）を再現できます。
  追加 scope 不要（owner／管理者の資格で自己完結）。
- `version` は内容ハッシュで、`?ifNoneMatch=` による変更なし軽量ポーリング（ゼロペイロード）に対応します。
  取得ごとに invoke 監査（`app.org-sync.pull`）が記録されます。詳細は中文原典 `docs/app-org-sync.md`。

---

## 3. 認証と SSO

### 3.1 統合認証の基本

- **デュアルトラック ID**（人間＋マシン）と短期トークン（既定 2h）、失効・ローテーション、
  Client Credentials を提供します。ログイン／Client Credentials／SSO バインド／OIDC 認可はすべて
  失敗ロック（15 分窓で 5 回失敗でロック、徐々に最長 24h、再起動をまたいで永続化、発火時にアラート）に対応します。
- **on-behalf-of トークンチェーン（代理実行）**：ユーザー → エージェントのトークン連鎖（act 積み上げ）で、
  監査から完全な経路を復元できます。ヘッダ `X-On-Behalf-User` で実ユーザーを透過します。

### 3.2 OIDC Provider（アプリ SSO の中核）

- RS256 署名／JWKS 公開／discovery／PKCE S256 強制／refresh ローテーション（一回一換、リプレイで
  チェーン全体失効）／`/oauth/end_session`／`/oauth/revoke`（RFC 7009、恒 200）を備えます。
- JWKS 署名鍵ローテーションは新鍵即署名・旧鍵 24h の検証猶予（進行中のトークンは切断されない）で、
  SDK は `kid` で自動選択します。
- iss は `OIDC_ISSUER` 環境変数で対外宣言します。TTL は `OIDC_ACCESS_TTL_SECONDS`（既定 2h）／
  `OIDC_REFRESH_TTL_SECONDS`（既定 7d）で、プラットフォームコンソールセッション（30min／7d）とは独立に調整できます。
- **アプリ公開ゲート（go-live gate）**：`web`／`h5` 形態のアプリは、アクティブな SSO クライアントを持たずに
  リリース申請できません（`APP_SSO_ENFORCE`、既定 `web,h5`）。審批の実行期にもクライアント状態を再検査する
  二点チェックです。`oidc` に設定すると entryUrl 登録では足りず OIDC クライアントが必須になります。
- **オーナー自己発行**：アプリ詳細の**SSO 設定（SSO 配置）**タブで、owner（`app.ownerId === userId` の人間）
  または `authn.oidc.write` 持ち主が client_id／client_secret（一度だけ表示）を発行できます。マシン主体は 403 です。
  ループバック（`127.0.0.1` 等）コールバック限定で、アプリ側マシンクレデンシャルによる自己発行も可能です
  （`APP_SSO_MACHINE_LOOPBACK=0` で全停止）。
- **DingTalk パスワードレス**：認可ページ内蔵のログインパネルに「アカウント＋パスワード／DingTalk スキャン」
  の二入口があり（`/api/auth/providers` の接続器設定で表示制御）、DingTalk ユーザーは事前ログイン不要で
  認可フロー内で完結します。
- アプリ開発者向けの詳細な手順（SDK 一行接続、CORS、claims 契約、entry-ticket、roster、beacon）は、
  日本語版の専用ガイド **[app-sso-integration.md](app-sso-integration.md)** を参照してください。
  アプリ内 RBAC の構築方法は中文原典 `docs/app-rbac-guide.md` を参照してください。

---

## 4. MCP サービス

### 4.1 デプロイとリリース

- リリース経路は **ドラフト→検証→カナリア→全量リリース**。バージョンは**不変（イミュータブル）**で、
  **ワンクリックロールバック**に対応します（現在バージョン・既にロールバック済みのバージョンは
  ロールバック先として指定できません）。
- `exec: real` は真の HTTP トランスポート（JSON-RPC `tools/call` ＋ initialize 探活）です。
  `exec: demo` は明示的なデモ用トランスポート（決定的シミュレーション、計測と SLO に計上されません）。
- mcpServers JSON 一括インポート：`POST /api/mcp/import`（Claude Desktop／Cursor 互換形態、
  `autoDeploy` で検証＋リリースまで自動）。

### 4.2 トークンゲートウェイと運用監視

- 統一認可：MCP 権限グループ＋ツール粒度（Tool 単位）＋読み取り専用制約。レート制限に対応します。
- **サーキットブレーキング（health-based）**：実呼び出し失敗と探活失敗が連続失敗カウントを共有し、
  連続 3 回で開放、業務成功で半閉鎖します。
- 呼び出し監視：P95 レイテンシ・成功率・トークン消費。CLI：`node cli/dshctl.mjs mcp list --output json`、
  `mcp deploy <id> --dry-run --changelog="..."`。
- 全 MCP ツールには最小権限の permission が宣言されます（2026-10-15 批次で `/mcp` の `tools/list` 全 82 ツール
  で x-permission カバレッジを強制。`console.login` 基線は宣言漏れ時の fail-safe 兜底のみ）。
- 2026-10-15 W バッチ以降、遠端 `tools/list` で発見された外部ツールは**信頼リスク登録フロー**（登録→審査→発効）
  を経由します。未登録ツールの書き込み系アクションは拒否され、台帳に記録されます。

---

## 5. スキル（Skill Marketplace）

- 提出経路：**提出 → 静的スキャン（悪意あるコード・秘匿鍵流出は自動却下） → 二段階承認 → バージョン管理された公開**。
- 二段階承認は domain と security の二級です。2026-09-15 の業務決定により、**同一の審批人が順に両級を通過できます**
  （級の順序と状態機械は不変、同一級の重複審批は拒否）。高リスクスキルの二級通過要件は変わりません。
- **Ed25519 契約署名検証**：サードパーティプラグインの契約五面（api/permissions/events/ui/billing.yaml 形式面）を
  検証します。CLI の `plugin init` が公開鍵ペア込みの足場を生成し、`plugin sign` → `plugin submit` で提出します。
- **NAS 直アップロード**：`GET/PUT /api/skill-storage`（`skill.storage.write`）でパッケージバックエンドを
  `local | nas` から選択。`skill submit --package=<zip>` や添付アップロードのパッケージは staging →
  NAS ゲートウェイ `fs_upload` に流れます。**アップロード失敗は公開失敗（fail-closed）**です。
  パッケージがない場合は SKILL.md から場内で ZIP 化されます。なお `fs_upload` はゲートウェイプロセス側で
  ローカルパスを読むため、**プラットフォームとゲートウェイは同一ホストまたは共有ボリューム**が必要です。
- 非推奨化（deprecate）は理由必須で永続化され、参照するエージェントにアラートが出ます。
  スキル × 日の使用マトリクス（ヒートマップ）がスキル市場ページ上部のカードに表示されます
  （`GET /api/skills/usage-heatmap`）。

---

## 6. エージェントと AI アプリ

### 6.1 エージェント本体

- 登録時に**マシンクレデンシャル**（clientId／clientSecret）が発行されます。既定スコープは
  `mcp.invoke` ／ `skill.read` ／ `agent.read` ＋ `usage.write` ＋ `connector.invoke`（直結消費の自己申告計測が
  403 にならないため）。スコープ調整・シークレットローテーション（`PATCH /api/authn/principals/:id` ／
  `POST …/rotate-secret`、変更時に既存トークン連動失効、`clientSecretHash` は外部応答から常に除去）が可能です。
- 属性表は三組（基本／技術／治理）。ライフサイクルの状態遷移（online／offline 等）は **L4 強制承認**対象です
  （§11）。`agent.offlined` でクレデンシャル失効＋バインドユーザー通知が連動します。
- **組織化フィールド**：`orgRole`（CEO／CTO／經理／工程師／分析師）／`rank`／`managerId`（報告線。
  自己参照・循環・宙吊りはすべて拒否）／`heartbeatIntervalMinutes`。コンソールの組織ページは
  人＋エージェントの二層ビューを描画します。
- **自律レベル（A0–A3）**：Agent 属性 `autonomy`／`runtime` と A2A 契約は実装済みです
  （A0 観測／A1 提案＝審批チャネル／A2 ODD 域内の制御付き実行／A3 有界自律）。ただし**証拠ベースの
  段階的権限昇格（evidence-driven elevation）の実装は設計レビュー済みで保留中（ロードマップ）**です
  （中文原典 `docs/internal/a0-a3-autonomy-ladder-review.md`、2026-09-12 レビュー結論）。
- **A2A 指名呼び出し**：`POST /api/agents/:idOrSlug/a2a/invoke`（権限点 `agent.a2a.invoke`）。
  v1 の範囲は単方向の指名呼び出し＋レベル透出です（ネゴシエーションプロトコルは升版時に別途検討）。
- Agent の公開ゲート：`AGENT_SSO_ENFORCE`（既定有効）により、オンライン申請前に OIDC クライアント発行、`entryUrl` 登録、または `headless` 宣言（UI なし・バックグラウンド実行、発行済みマシンクレデンシャルで通過）のいずれかが必要
  または `entryUrl` 属性登録のいずれかが必要です（既にオンラインの Agent は強制切断されません）。

### 6.2 AI アプリケーション本体

- アプリ schema、**オーケストレーショントポロジ**（SVG 一図で編成を穿透）、ライフサイクル管理
  （online／offline／archived、`app.updated` で SSO クライアント名も同期）。
- **PV/UV/DAU 指標**：①アプリ側からの**主動報告** `POST /api/apps/:id/metrics-report`（`app.write`、
  ツール `app_metrics_report`、CLI `app report`。同日 PV は累加、UV/DAU は最大値採用、`date` 指定で遡及記録可）、
  ②公開ビーコン `GET/POST /api/apps/beacon`（一行埋め込みで PV/UV を計測。CORS `*`、未知アプリの存在を
  洩らさない、IP＋アプリで 60 回/分に制限）、③entry-ticket 兑換・OIDC 発码からの**プラットフォーム側自動換算 DAU**
  （`sub` 同日重複除去）。三経路は max／累加セマンティクスで自然に統合されます。
- **コスト透過**：`GET /api/assets/benefit` — アセット別の利用量／内部調達コスト参考値の集計。
  アプリ資産は窓 DAU から**1DAU あたりコスト**を派生します（M0 口径：charge は常に 0、cost は内部参考のみ）。
- 詳細な SSO 接入手順は [app-sso-integration.md](app-sso-integration.md) を参照してください。

---

## 7. ワークフローオーケストレーション（flow-core）

- **TF オーケストレーション＋ステップ状態マシン**：TF（Transaction Flow）の CRUD とステップ遷移
  （実行者は人／Agent／ゲートウェイ）。ステップは `startedAt`／`finishedAt` を持ち、ガントタイムラインで
  直接描画できます（`GET /api/flow/*`）。
- **テンプレートライブラリ／contextPack**：テンプレート（`GET /api/flow/templates?sceneCode=`）から
  インスタンス化して複製・展開でき、contextPack が自動注入されます。
- **SLA と進捗**：`slaMinutes`／`dueAt`／`progress`／`slaBreached`（読み取り時点判定の口径は契約に明記）。
  `slaMinutes` は 0 以下を禁止（作成時点で逾期になるのを防止）。
- イベント：`flow.created` ／ `flow.step.updated` ／ `flow.completed` ／ `flow.template.changed` がイベントバスと
  面板 SSE に配信されます。skip で running が 0 になったフローは `stalledAt` マーク＋`flow.stalled` イベントで
  可視化されます（自動再実行はしません）。
- 権限点：`flow.read` ／ `flow.write` ／ `flow.admin`。シーンポリシー（sceneCode）はフローの作成・ステップ遷移・
  取り消し入口に適用されます。

---

## 8. データ資産ドメイン

- **データセット登録**：`GET/PUT /api/resource/datasets?scene=&classification=&org=&q=`（名称／出所／
  分類／品質スコア／更新頻度／シーン数）。
- **4 軸品質スコア**：完全性／正確性／鮮度／整合性の各 0–100 ＋等重みの総合スコア。
  楽観同時実行制御（`qualityRevision`／`expectedVersion`、衝突時は拒否）を持ちます。
- **リネージ逆引き**：`GET /api/resource/lineage?dataset=` が upstream／downstream を返します。
  依存グラフに循環参照検出（DFS）があり、循環は拒否されます。
- **指標ディクショナリの定義仲裁**：同一コードの複数口径を並存記録し（記録者・時刻付き、同内容は冪等）、
  `POST /api/resource/metrics/:code/arbitrate` で active を仲裁確定します。指紋はキー順正規化
  （`stableStringify`）で疑似衝突を排除します。
- 権限点：読み取り `panel.read`、書き込み `resource.dataset.write`。イベント：`resource.dataset.changed`／
  `resource.metric.changed`。

---

## 9. モデルアクセスゲートウェイ（modelgw）

- **OpenAI 互換の真の転送**：`POST /api/modelgw/invoke`。実測の input/output tokens を計量します。
  **モデルに endpoint が未設定の場合は呼び出しを拒否します（偽の completion を生成しません）**。
  未設定モデルは自動選模でも選ばれません（明示指定を除く）。
- **チャネルガバナンス**：
  - 分級路由：`dataClassLimit`（モデル側上限）× `dataClass`（呼び出し側密級）で越級をロック
    （エラー文言に理由を含む。降級で密級を落とすことはありません）。
  - **フォールバックチェーン**：チャネルグループ（主／予備 1／予備 2／手動）。ステップ超時の既定は 8 秒。
    降級のたびに `modelgw.degraded` イベント（SSE で消費可）。2026-10-15 批次から、**チェーンの各実呼び出し前に
    予算熔断を再検査**し、block 状態なら予備チャネルでの迂回呼び出しも全体を中断します。
  - **予算サーキットブレーカー**：組織／モデル／プラットフォーム級の予算。warn 閾値イベント
    （予算ごとに 1 日 1 回重複排除）＋呼び出し前の block 熔断。`GET /api/usage/summary` の応答は
    `budget` 進捗を含みます。
- **TTFT テレメトリの正直な未収録**：チャネル遥測の `ttftMs` は `null` で、口径説明とともに
  「未収録」を正直に明示します（ストリーミングチャネル待ち）。
- モデルカタログ管理面は**財務ビュー（财务视图）**ページ（`#/finops`、`modelgw.read`/`modelgw.admin` 門控）に
  あります：登録／上下線／削除＋チャネルグループ＋主体と連動凍結を含む予算編集。
- メーター契約：model:* の計測キーは `output_tokens`（プライスブックと一致しない meter key はハード拒否され、
  エラーに期待キーが表示されます）。

---

## 10. 利用量と FinOps

> **M0 レッドライン**：本ドメインに金額決済セマンティクスはありません。対外提示は
> **利用量の透明化＋内部コスト透過**のみです。詳細は [usage-reporting.md](usage-reporting.md) を参照してください。

- **schema v1 冪等パイプライン**：usage イベントは `idempotency_key` でエンジン級一意。再配信は二重計上されません
  （先書き後発行、消費水位による冪等）。消費失敗は実時再試行 3 回ののちデッドレター入り、
  **デッドレターリプレイ**（`usage_deadletter_retry`／`POST /api/bus/dead-letters/retry`）で再投入できます。
- **ゼロ価格スナップショットのプライスブック**：list 側は常に 0（`charge_cents` 恒 0）、cost 側は
  **内部調達コスト参考値**。スキル／NAS／接続器など観測系イベントには零率の既定規則が冪等に播種されます。
- **外部システム照合**：`POST /api/usage/reconcile`。**ケイパビリティドリフト検出**もパイプラインに含まれます。
- **J4 三軸月次集計**：`GET /api/usage/report/monthly?month=YYYY-MM[&format=csv]`（`usage.read`）。
  部門 byOrg／Agent byAgent／Skill bySkill の 3 軸（＋付加軸 byModel）。CSV は UTF-8 BOM 付きで
  Excel でそのまま開けます。企業の管理者は `usage.read` で自助エクスポートできます。
- **FinOps レポート v1（CFO ビュー）**：`#/finops`（財務ビュー／财务视图）。
  - コスト透過：部門 × モデルの交叉マトリクス（Top8×Top8＋「その他」、合計は model 域の全口径コストと一致）、
    前月比（prev=0 かつ cur>0 の場合は null、無理な百分率を作らない）、Top 10 消費主体。
  - **アイドル稼働検出 v1**：**近似ヒューリスティック**（モデル呼び出し後 N 分、既定 30 分内に同一主体の
    非モデル資源アクションが無く、同 trace_id の関連アクションも無い場合を「疑似アイドル」と判定）。
    **ページに「近似口径・要人工確認・考核には使用しない」と明示表示されます**。誤報（純対話）がある点を
    正直に明記しています。
  - ワンクリック CSV エクスポート（UTF-8 BOM、Excel フレンドリー）。
- **保持ポリシー**：usage イベントは既定 **730 日**保持（`USAGE_RETENTION_DAYS`、`0` は永久）。
  起動 20 秒後と 6 時間ごとに窓外イベントを清掃（消費水位と対応するデッドレターも連動）。
  運用手動パージ口：`POST /api/usage/retention/purge`（`usage.admin`、`body.days` で一時的に窓を短縮可、0 はスキップ）。
  イベント削除後の同冪等キー再報告は新規イベントとして計上されます（保持窓＝削除契約）。
  J4 月次レポート窓（直近 13 か月）には影響しません。

---

## 11. 監査とガバナンス

- **四種監査ログ**（authn／change／invoke／result など四類）＋フィルタ検索。越権アクセスは
  `audit.authz.denied` として記録され、**越権カウントアラート**が発火します。
- **アラートルールエンジン**：metric／operator／threshold でルール定義（入力値検証あり）。
  通知は DingTalk ブリッジの alerts チャネルにも配信できます。
- **L4 強制承認**：上线／下线／下架／吊销（オフライン・失効・削除など高危操作）は強制的に承認チケットを発行し、
  承認権限を持つ者が単独で通過させると実行されます（実行結果はチケットに回写）。
  理由（`--reason`）が必須で、原因は永久に記録されます。
- **高リスク二重確認（fail-closed）**：`riskLevel:'high'` の承認は `confirmed=true` の明示的二重確認がなければ
  通過しません（サーバー側で強制。デフォルト true は禁止）。CLI ツール `approval_decide` も
  `confirmed`／`finalReview` を透過します。
- **会社級終審（final review）**：指定された承認には会社級の終審段階を設けられます
  （`finalReview` → `approval.final_review` 監査記録）。**SLA ダッシュボード**で承認処理の滞留を監視できます。
- **通知センター**：`console:notifications` コレクションに永続化（30 日保持＋2000 件リング）。
  `GET /api/notifications?since=&limit=` の **since 増量**＋**既読カーソル**（`POST /api/notifications/read-cursor`、
  端末間ローミング）。タスク（組織範囲）／アラート（グローバル）／承認（グローバル）の三類イベントが自動記帳されます。
- **監査証拠アンカー**：`POST /api/audit/evidence`（`panel.write`）で五型の証拠を登録し、
  `GET /api/audit/evidence/:id` で逆引き。**シーン次元の時間線**（`GET /api/audit/timeline?sceneCode=`）は、
  sceneCode に合致する証拠エントリを統合して表示します。usage 側は schema v1 凍結期のため
  `trace_id` で関連付けます（列追加は schema v2 で別途協議）。

---

## 12. NAS ファイルストレージ

### 12.1 アーキテクチャの原則

- すべてのファイル操作は **Synology ファイル MCP ゲートウェイ**（synology-filestation-mcp など）経由で行われ、
  **DSM の私有 API には直接接続しません**。プラットフォームはゲートウェイのアドレス＋Bearer トークン＋
  `X-NAS-IP`（デバイスルーティングヘッダ）を保持し、`fs_list`／`fs_upload`／`fs_delete`／`fs_search` などの
  `tools/call` で操作します。書き込み系操作は監査記録され、トークンの再表示は脱敏されます。
- `mcpServers` JSON 一括取り込み：`POST /api/nas/import`（CLI `nas import`、コンソールの**NAS ストレージ（NAS 存储）**
  ページのインポートダイアログ）→ 資産作成 → 探活 → 上線 → ツール発見まで一気通貫です。
- 生命周期：`draft → online → offline → archived`（上線前に initialize 探活ガード）。
  健康巡検は資産運用（资产运营）ページに統合されています。

### 12.2 データ権限（組織位置＋ロール階層 RBAC）

- 判定サービス `NasAuthzService`（サービスキー `nasAuthz`）は**五段階の判定序**で純関数化されています：
  ①アカウント特殊規則（外部ホワイトリスト読み取り専用／怪しいマークで deny 転人工／ルート直付けの非責任者 deny ／
  未配属は部門ルート読み取り専用／**兼任サブツリー読み取り専用**） → ②資源級の明示 deny（尾ワイルドカード） →
  ③資源級の明示 allow（期限切れで失効しマトリクスに回帰） → ④ロールマトリクス×作用域境界 → ⑤**デフォルト deny**。
- **内蔵マトリクス**（`rules.matrixOverrides` で上書き可）：

| ロール | read | download | write | modify | delete | share | admin |
|---|---|---|---|---|---|---|---|
| P プラットフォーム責任者 | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| D 部門責任者 | ○ | ○ | ○ | ○ | ○ | ○ | × |
| T 班組責任者 | ○ | ○ | ○ | ○ | × | × | × |
| M メンバー | ○ | ○ | ○ | × | × | × | × |
| C 叠加 | 越域の read/download を許可、書き込み系は全拒否（ホワイトリストの書き込みは明示 allow が必要） |

- ロール導出は人員名簿を使いません：P/D/T＝組織チェーン上の責任者（深さ 1/2/≥3、**複数責任者は全員導出＝co-leader**）、
  M＝メンバー。事実源は `OrgRecord.leaderUserIds`（DingTalk 同期チェーン）。作用域マッピング表 `orgPathOverrides`
  を優先するため、組織改名でも判定がずれません（R1）。毎日組織↔ディレクトリ照合（dirOrphan／leaderVacant アラート）。
- share 申請は審批クローズドループ（T/M 申請 → 審批人は組織チェーンに沿って自動ルーティング、
  resource_admin が兜底 → 通過で 7 日間の例外書き込み → 期限切れで自動拒否、全経路で記録）。
- **身元の強制**：プラットフォームからゲートウェイへの呼び出しは一律 `X-On-Behalf-User` ヘッダで
  実ユーザーを透過し（DingTalk userId を優先）、ツール引数に身元を入れません
  （`nas_fs_*` ツールは `exec.principal` で受ける。スキーマに身元引数はなく、欠落時は fail-closed）。
  未授信トークンによる同ヘッダの偽造はゲートウェイ側で拒否します。
- **グレースケール／緊急スイッチ**：`rules` 単例の `observeOnly`（既定 true、deny はアラートのみで遮断しない）、
  `degradeAllToReadonly`（全量読み取り専用への降級）、ゲートウェイ側 `AUTHZ_ENFORCE=off` のグローバル
  キルスイッチ＋トークン単位の enforce。どの段階からも秒単位で回退できます。
- CLI：`dshctl nas authz check|scope|rules|decisions`。REST は `/api/nas/authz/*`（`nas.authz.check|read|write`）。
  詳細は中文原典 `docs/nas-authz.md`。

### 12.3 ファイル所有権トラッキングと署名付きダウンロード URL

- **ファイル所有権トラッキング**：アップロード時の登録／リネーム時の書き換え／削除時の除去が行われ、
  データ権限判定は所有者次元を参照します。
- **署名付きダウンロード URL**：HMAC 署名。**1h／24h／7d／30d／永久**の 5 段階。
  取り出し（ストリーミング）時には**署名 → 失効チェック → 権限再確認**の三関門を通過します。
  署名用の長期鍵は独立しており、失効（吊り上げ）可能です。

---

## 13. コネクタ

- **アーキテクチャ**：YuanBingKe＝治理コントロールプレーン、**open-connector v1.4.0 sidecar**＝データプレーン＋
  **クレデンシャルボールト**（AES-256-GCM）。1,000+ Provider／10,000+ Action のディレクトリ、
  **OAuth プロキシ**（全フロー）、oct_ ランタイムトークンを sidecar が担い、プラットフォームは
  ディレクトリ・OAuth・キーストアを自前実装しません。
- **三条のレッドライン**：①**クレデンシャルのプラットフォーム持ち込みゼロ**（provider 認証情報は sidecar の
  ボールトのみに保存。oct_ 値はプロセスメモリのみ）。②**認可の二重独立拒否**（プラットフォーム権限グループと
  oct_ トークンポリシーの二層。プラットフォームを迂回して sidecar に直結してもトークンポリシーに拒否されます）。③
  **actChain 監査＋計量照合**：全呼び出しは runId（=`meta.executionId`）で監査チェーンを逆引きでき、
  `GET /api/connector/runs` が runtimeTokenId と usage の trace_id を交叉検証し、
  「run はあるが meter がない」状態は critical アラート（迂回の兆候）です。
- **二層認可ミラー**：接続器権限グループ（pattern／riskCap／readOnly／**denyParams 強制遮断**）↔
  グループごとに 1 枚の oct_ ランタイムトークン（ポリシースナップショットを PUT 時に四配列全発）。
  組織巡検で「トークンのバインド接続 ⊆ グループ内 org 接続」を保証し、401／connection_not_allowed は
  自動復旧リトライ 1 回です。
- **接続の三形態**：①OAuth プロキシ全フロー（企業自前 App の登録が必要。未登録なら
  `oauth_client_config_required` がウィザード案内付きで返る＝期待されるガード）。②API Key フォームは
  **手を通すが保存しない**（再表示は `slice(0,6)+'…'` に脱敏）。③no_auth の仮想登録。
  エイリアスは `org:<orgId>:` 接頭辞を強制。削除時は権限グループ参照のカスケードチェック。
- **fail-closed の環境変数**：`OOMOL_CONNECT_ENCRYPTION_KEY`／`OOMOL_CONNECT_ADMIN_TOKEN` が欠落すると
  ネイティブ invoke は一切拒否（503 `gateway_unavailable`）＋アラート。探活は 30 秒間隔、
  連続 3 回失敗でサーキットブレーキング。
- **審批の二シーン**：admin 級 action は `connector.action.admin` チケット（承認後に executor が自動実行）。
  制御付き接続は二段式 `connector.connect`（審批ペイロードに認証情報フィールドはゼロ、
  承認後に approvalId を添えて実際の認証情報を提出）。
- **計量**：`usage.record(resource='connector:<service>', meter=calls, …)`。`Idempotency-Key` は書き込み系で
  自動生成（24h リプレイ窓）。
- 権限点：`connector.gateway.write`／`catalog.read`／`connection.read`／`connection.write`／`connection.invoke`／
  `permgroup.write`／`runs.read` など。コンソールは **接続器（连接器）**ページ（`#/connectors`）。
  導入手順・OAuth トポロジ・トラブルシューティングの詳細は中文原典 `docs/connector-integration.md` を参照してください。

---

## 14. 実行ハブ（Execution Hub）

### 14.1 ゴールアライメント（目標整合）

- **目標ツリー**：`exec:goals`（親目標ツリー＋指標の三要素：基準値／目標値／単位）→ `exec:projects` →
  `exec:issues`。**goalAncestry**（目標血縁）は書き込み時に物化され、起動時のコンテキスト包装は
  「本タスクは → どの目標／プロジェクト／前置きに奉仕するか」を積み込みます（なぜやるか）。
  循環する目標ツリーは拒否されます。

### 14.2 ハートビートループと起動判断

- **30 秒ハートビート**（`EXEC_HUB_TICK_MS`）：`exec:wakes` キュー（冪等キーで重複排除）を消費し、
  **ガバナンス事前チェックチェーン** — 予算前置 → 凍結チェック → Agent マシン主体の権限検証 →
  P0 承認ゲート — を通過して **proceed／coalesce／defer の三態決裁**を行います。
  待ち引きは三源から取得（exec タスク／パネルタスク／トランザクションフローの Agent ステップ）。
  metrics-report が 24 時間超過で未提出なら自動催促します。
  ハートビートの結果は **5 段階ヘルススコア**（healthy／stale／silent／frozen／offline）に反映されます。

### 14.3 実行ロック（CAS）とゾンブロック回収

- issue 行上の三フィールド CAS（`executionRunId`／`executionAgentKey`／`executionLockedAt`）。
  決裁はドメイン純関数で、**64 組み合わせを網羅する単体テスト**が付きます。run 単位の一括解放に対応。
  **ゾンブロック回収**：`EXEC_LOCK_TIMEOUT_MS`（既定 5 分）超過のロックを強制回収します。

### 14.4 定期スケジューリング

- 三源：**interval**／**5 項 cron**／**webhook**。webhook は**エンドポイントのパス自体がクレデンシャル**で、
  未登録・停止のパスは一律 404（fail-closed、存在推測を防ぐ）。

### 14.5 Agent 用の exec ツールと五つのガードレール

- ツール四種：`exec_wakeup_status` ／ `exec_claim`（クレーム＝実行リース取得） ／ `exec_complete` ／
  `exec_lineage`。Agent はセッション内でロックを取得・返却でき、実行ハブの存在を意識する必要がありません。
- **五ガードレール**：①予算ハードストップ ②権限検証 ③監査証跡 ④密級注記 ⑤P0 承認ゲート。

### 14.6 予算超過連動凍結と L4 解凍承認

- 予算主体は `agent:<id>`／`app:<id>` まで拡張（計量 subject と同口径）。予算前置の熔断が発動すると
  Agent が凍結され（attrs のソフト状態）、**自動的に `agent.unfreeze` の L4 解凍承認チケット**が生成されます
  （承認インフラを再利用するため二重確認が自然に付きます）。承認の実行がそのまま解凍です。

---

## 15. デジタルワーカー（ワークフォースドメイン：workforce）

- **ワーカープロファイル（员工档案）**：デジタルワーカーの人材台帳。管理 UI から個別に登録できます。
- **任用バージョン状態マシン（任用）**：任用（apportion）はバージョン付きの状態機械で履歴が保たれます。
- **目標クレーム（认领）と実行リース確認**：ワーカーが目標をクレームし、実行リースの確認（租約）を経て作業します。
- **短期作業許可（permit）**：期限付きの作業権限。権限点は `workforce.read` ／ `workforce.write` ／
  `workforce.admin` ／ `workforce.invoke` ／ `workforce.accept`。
- **四ゲートウェイ制御付き呼び出し台帳（受控调用）**：MCP／モデル／NAS／接続器の 4 ゲートウェイ呼び出しを
  台帳で制御し、**資産の本来の認可チェーンとの二層交差**（permit 側とリソース側の両方で許可された場合のみ通過）。
- **納品〜人による検収のクローズドループ（交付验收）**：成果物の納品 → 人間の検収（accept）→ 確定。
  ワーカーの成果は人間の検収を経て初めて完了扱いになります。
- **分担口径**：**目標／タスク／run は実行ハブ（§14）、ワーカー／任用／納品は本ドメイン（workforce）**です。
- 2026-10-15 W バッチ（第二期）で以下を追加：MCP ツール信頼リスク登録フロー（§4.2 の V11 根治）、
  REST ／ Panel 接入面の等価収束（同一マシンクレデンシャルで `/api/mcp/invoke` と `/mcp` の挙動を一致、
  permit/run/step インデックス透過）、usage 代報の `X-On-Behalf-User` ホワイトリスト収束
  （バインド済みユーザーのみ代報可、範囲外は 403＋`audit.authz.denied`）、`workforce.admin` 運用面
  （一括停職・復職、任用監査レポート、期限切れ permit と終端 run の台帳清掃）、グレースケール交付パッケージ。

---

## 16. 日常インターフェース

### 16.1 三つの画面面と使い分け

| 画面面 | 主な利用者 | 独立形態（7300） | dsh 宿主形態（単一入口） |
|---|---|---|---|
| 管理コンソール（管理控制台） | 管理者／治理ロール | `/` | `/rq/` |
| 部門パネル（部门面板） | 業務担当／部門メンバー | `/panel/` | `/rq/panel/` |
| dsh 対話画面 | 全員（業務面） | —（存在しない） | `/` |
| ポータル | 匿名訪問者 | 外部独立サイト | 同左 |

### 16.2 統一入口のトリアージ（J2 契約）

- **一つの入口、身元による着地**：唯一覚えるべき URL はコンソールアドレスです。起動時のトリアージは
  パーミッションポイントで判定します — 管理系ポイント（`iam.user.read`／`approval.read`／`audit.read`／
  `usage.read` のいずれか）を持つロールはコンソールへ、`panel.read` のみの純業務身元は部門パネルへ自動着地します。
- **明示切り替えは選好を記憶**：パネルの rail「管理コンソール（管理控制台）」、コンソール NAV「部門パネル（部门面板）」
  は選好を localStorage に書き、次回の自動振り分けに優先します。
- **ログイン時のリダイレクトで目的地を保存**：401 で弾かれた際の目的地は `?next=` と
  `sessionStorage` に退避され、ログイン後に復元されます（同源絶対パスのみ許可、オープンリダイレクト防止）。

### 16.3 会話の直通（J3 契約）と rq-card

- **三级会話チェーン**（コンソールとパネルで同型）：既存トークン → `?entry_ticket=` 兑換 →
  宿主 Cookie 直通（`POST /dsh-bridge/session`）。dsh 宿主形態では `/rq/panel/` への移動で二次ログイン不要です。
- **rq-card**：dsh 会話内に注入される実行カード（四状態の実行カード＋👍/👎 フィードバックバー）。
- **J1 指名呼び出しの誠実な降格**：パネルからの技能／Agent 指名直調は、権限・範囲不足時に
  **200 ＋ `ok:false`** で正直に降格します（偽の結果を返しません）。認可エラーは 403、入力エラーは 400 です。

### 16.4 プラットフォーム即 MCP サーバ

- `POST /mcp`（Streamable HTTP の純 JSON 形態）：initialize（セッションヘッダ＋serverInfo）／`tools/list`
  （運用ツール 40+、最新批次で全ツールに最小権限 permission 宣言）／`tools/call`／`ping`。
  プラットフォームの Bearer トークンとツール級パーミッションポイントを再利用し、
  ZCode／Claude／Cursor など任意の MCP クライアントでプラットフォームを直接運用できます。

### 16.5 リモート dsh 接続

- 他の PC の dsh に本プラットフォームをプラグインとしてインストール後、**一次接続コード（接入コード）**で
  ホストにマシンクレデンシャルを申請でき、運用ツールはすべてホストへリモートプロキシされます
  （ソース不要・data 共有不要）。
- コンソールの**プラットフォーム接続（平台接入）**ページで接続コードを作成（既定 15 分有効、
  テンプレートは `readonly`／`operator`／`full`、コードは一度だけ表示・ハッシュ保存・一回消費・
  送信元 IP ごとの失敗ロック）。
- 遠隔側は ①dsh 対話で Agent に「ホストに接続、アドレスと接続コード」と指示（`connect_setup` が自動申請）、
  または ②本機設定ページ `http://127.0.0.1:7390` で GUI 入力します。
- 接続後は 5 ツール（`connect_status`／`connect_setup`／`connect_login`／`connect_test`／`connect_reset`）が追加され、
  心跳（既定 5 分ごと `POST /api/connect/heartbeat`）で生存とメタ情報を報告します。ホスト側の
  クライアント無効化は全マシントークンを連動失効させ、即時 401 になります。
  詳細は [deploy-enterprise.md](deploy-enterprise.md)（日本語版）第 4 節を参照してください。

### 16.6 その他の日常面

- **ポータル**：`dsh-plugin-portal` が外部の無認証・読み取り専用エンドポイント（既に公開済みのアプリ／Agent／
  スキルの一覧）を提供します。CORS と可視性の記録付き。`PORTAL_SYNC=off` で停止できます。
- **部門パネルの実行**：@Agent の応答は実装済みの資産・モデルにバインドされていない場合
  **誠実に降格**（偽 completion を出さず、転人工待ち）します。widget の connector/mcp 源も明示的に降級表示します。
  部門は組織（`deptConfig.orgId`）にバインドされ、組織サブツリー外のメンバーは 403 です。
- **ランタイム UI の言語切替**：簡体字中国語（既定）／英語（en-US）／日本語（2026-10-16 リリースより。§0.2 のとおり）。
  `/docs` 配下の文書配信はホワイトリスト制
  （対外接続ガイド等の限定文書のみ公開、内部文書は 404、2026-10-15 批次）です。

---

## 付録

### A.1 パーミッションポイントの権威資料

- プロトコルキー（イベント名・権限点・エラーコード・API エンベロープ・環境変数）の中文権威一覧：
  `docs/协议键中文对照总表.md`（R10、280 キー）。新規の対外プロトコルキーは必ず同表に登録されます。
- 本訳稿ではキー名を ASCII のまま保持します（GLOSSARY.md 第 5 節の ASCII 保存リスト）。

### A.2 dshctl コマンドファミリ（`cli/dshctl.mjs`）

```bash
node cli/dshctl.mjs help                     # 全コマンドとグローバルオプション
node cli/dshctl.mjs mcp list --output json   # MCP 一覧（JSON）
node cli/dshctl.mjs mcp deploy <id> --dry-run --changelog="..."
node cli/dshctl.mjs agent offline <id> --reason="..."   # L4 承認チケットを生成
node cli/dshctl.mjs approval decide <id> --decision=approve --opinion="..."
node cli/dshctl.mjs nas import --config='{...}'          # mcpServers JSON 一括取り込み
node cli/dshctl.mjs nas files <id> --path=/skillhub
node cli/dshctl.mjs skill submit --name=<名> --content-file=SKILL.md --package=skill.zip
node cli/dshctl.mjs app report <id> --pv=1200 --uv=320 --dau=280
node cli/dshctl.mjs usage record --org=<orgId> --subject=agent:<id> --resource=skill:<id> \
     --meter=calls:3:次 --idempotency-key=<業務番号>
node cli/dshctl.mjs credential rotate <principalId>
node cli/dshctl.mjs connect code --template=operator --ttl=15
node cli/dshctl.mjs update status | check | apply [--dry-run]
```

- 認証情報は環境変数 `DSHCTL_URL` ／ `DSHCTL_USER` ／ `DSHCTL_PASS`（または `DSHCTL_TOKEN`）で提供します。
  定常運用には `admin` ではなく運用系アカウントを推奨します。
- CLI 出力の言語切替は `--lang`／`DSHCTL_LANG` で可能です（2026-10-16 リリースより。既定は中文）。

### A.3 品質ゲート（selftest）

```bash
npm run selftest          # 隔離インスタンスでの E2E 自己テスト（全緑。件数は直近の実行時点）
npm run lint:manifests    # プラグイン宣言五面の YAML 検証
npm run lint:boot-order   # 起動順序検証
npm run lint:cjk          # UI 文言の中文統一検証
node tests/full-chain-drill.mjs         # 四類資産の全チェーン演習
node tests/workforce-loop-drill.mjs     # ワークフォース独立ループ演習
node scripts/page-smoke.mjs             # 全ページ描画スモーク
```

- テスト件数（例：selftest ≥1380、drill ≥37）は**直近の実行時点の値**であり、歴史カウントは無効です。

### A.4 日本語版の兄弟ドキュメント

- [deploy-enterprise.md](deploy-enterprise.md) — 企業導入 runbook と dsh ランタイム接続
- [app-sso-integration.md](app-sso-integration.md) — アプリ SSO 接続ガイド
- [usage-reporting.md](usage-reporting.md) — 利用量透過と FinOps レポート（J4）
- [release-notes-summary.md](release-notes-summary.md) — リリース履歴サマリ（M0〜最新批次）
- 用語契約：[GLOSSARY.md](../GLOSSARY.md) ／ ガバナンス：[README.md](../README.md)
