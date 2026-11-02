> **日本語版** — 機械翻訳支援＋i18n PM による統一校正。**中文原文が正式版です（齟齬時は中文が優先）。**
> 原典: `README.md`（リポジトリルート、補助原典 `docs/deploy-enterprise.md`）· 原典基準日: 2026-10-15 · 用語集: [GLOSSARY.md](../GLOSSARY.md) · ガバナンス: [README.md](../README.md)

# クイックスタート — YuanBingKe（ybkk-AIOS）

本ガイドは、YuanBingKe（製品の中国語名: 元冰可）を最短で起動し、初回ログインまで完了させるための手順を
まとめたものです。評価・導入の最初の一歩としてご利用ください。企業内での本格的なデプロイ
（systemd によるプロセス管理・リバースプロキシ・接続コードによるリモート dsh 接続等）は、
中文の [docs/deploy-enterprise.md](../../deploy-enterprise.md)（内部寄り）を参照してください。

---

## 1. 前提条件

| 項目 | 要件 |
|---|---|
| ランタイム | **Node.js ≥ 22.6**（`node -v` で確認。ネイティブ TypeScript 実行のため**ビルド手順は不要**です） |
| OS | macOS / Linux / Windows（データディレクトリと `node_modules` の書き込み権限が必要） |
| ポート | 既定 `7300`（`--port` で変更可能） |

> Node 24 環境では `node:sqlite` が Experimental 扱いになる場合がありますが、動作に影響はありません
> （原典 README「説明と境界」より）。

## 2. 導入形式（2 種類）

| 形式 | コマンド | 特徴 |
|---|---|---|
| A. 独立プロセス | `npm install && npm start` | dsh なしで完結。REST ゲートウェイ＋コンソール SPA＋運用ツールブリッジを 1 プロセスで提供。**既定で `http://127.0.0.1:7300`** |
| B. dsh バンドルマウント | `dsh plugin --profile web add github:01men/ybkkasi` | 25 個のプラグインエントリを 1 コマンドで導入。データプレーン（REST/コンソール SPA/docs/MCP）は **`/rq` プレフィックス**で dsh webServer にマウントされ、**dsh web のポートが唯一の入口**になります |

形式 B は既存の dsh ホスト（`dsh web`）が動作していることが前提です。インストール後は
`dsh --profile web --dump-config` で `ops-*` エントリが列挙されることを確認できます。
形式の選択に迷ったら、まず形式 A で評価し、Agent による自然言語運用が必要になった段階で dsh 連携を
検討するのが推奨経路です（アーキテクチャの詳細は [dsh-ecosystem.md](dsh-ecosystem.md)）。

## 3. 初回起動とベースライン初期化

```bash
git clone <リポジトリURL> && cd ybkkasi   # 形式 A の場合
npm install
npm start                                 # 既定 http://127.0.0.1:7300
```

空のデータディレクトリでの初回起動時、**ベースライン初期化**が 1 回だけ実行されます（本番形態）:

- 内蔵ロール＋ルート組織＋プラットフォーム管理者 `admin` を作成します。**デモ業務データは一切作成されません**。
- `admin` のパスワードは環境変数 `ADMIN_PASSWORD` で指定できます。**未設定または空文字の場合は
  ランダム生成**され、`data/admin-initial-password.txt` に 1 回限り書き込まれ（ファイル権限 0600）、
  同時に起動ログへも出力されます。**必ず直ちにログインして保管してください**（第 4 節の手順）。
- パスワードを忘れた場合: (1) データディレクトリを空にして再起動、または (2) `iam.user.write` を持つ
  管理者が**組織とアカウント（组织与账号）→ アカウント詳細（账号详情）→ パスワードリセット（重置口令）**
  から再設定します。

起動確認（任意）:

```bash
curl -s http://127.0.0.1:7300/api/health        # 期待値: {"status":"ok",...}
```

データは JSON コレクション（原子書き込み）＋ SQLite（`data/txnstore.db`、WAL）に保存されます。

初回起動時のログには、ベースライン初期化の完了メッセージ（中文: 「平台基线初始化完成」）と、
公開までの 3 ステップの案内枠（中文: 「上线三步走」）が表示されます（いずれも初回 1 回のみ）。
データディレクトリの構成は次のとおりです:

- `data/` 配下の JSON コレクション（ビジネス設定・原子落盤）
- `data/txnstore.db`（SQLite。計測・利用量データ。WAL＋冪等一意索引）
- `data/admin-initial-password.txt`（未指定時にのみ生成される初期パスワードファイル。権限 0600。
  第 4 節の手順でパスワード変更後に削除します）

初期パスワードファイルが存在する間、ログインページ（登录页）には注意喚起のバナーが表示され、
`GET /api/platform/bootstrap` は `initialPasswordPending:true` を返します。

## 4. 初回ログイン（安全な引き取り手順）

1. ブラウザで **http://127.0.0.1:7300** を開き、コンソール（控制台）のログインページ（登录页）に
   `admin` と初期パスワード（ファイルまたは起動ログの値）でログインします。
2. 画面右上のアバターから **パスワード変更（修改密码）** を実行し、強固なパスワードに置き換えます。
3. サーバー上の `data/admin-initial-password.txt` を**削除**します。
4. 削除の確認（任意）:

```bash
curl -s http://127.0.0.1:7300/api/platform/bootstrap
# 期待値: {"initialPasswordPending":false} （パスワード変更＋ファイル削除後。true の間、ログインページには
# 「初回導入の注意喚起」バナーが表示されます）
```

## 5. デモモード（評価・トレーニング専用）

```bash
DEMO_SEED=1 npm start   # 初回起動時にデモデータを注入
```

初回起動時に、組織ツリー・デモアカウント・MCP／スキル／Agent／アプリのサンプルと 28 日分の履歴データが
注入されます。**デモアカウントのパスワードはいずれも `Ybk@2026` です。**

| デモアカウント | ロール | 用途 |
|---|---|---|
| `admin` | プラットフォーム管理者（最高権限） | 全機能 |
| `ops` | リソース管理者（资源管理员） | MCP／スキル／Agent／アプリの管理 |
| `hr` | 組織管理者 | 組織／アカウント／外部同期 |
| `dev` | 開発者 | スキル提出・Agent 登録 |
| `audit` | 監査者（読み取り専用） | 監査とアラート |

デモモードでは DingTalk パスワードレスログインも試せます（モックコネクタ）: ログインページ（登录页）の
**DingTalk QR スキャン（钉钉扫码）** で社員番号（工号）`DD0002` を入力します。本番のベースライン初期化では
コネクタを設定しないため、サードパーティログインの入口は自動的に非表示になります。

> **警告（必読）**: `DEMO_SEED=1` は既知パスワード（`Ybk@2026`）のアカウントとサンプルデータを生成します。
> **本番環境では絶対に有効化しないでください。** 本番導入は必ずベースライン初期化（第 3 節）を使用してください。

## 6. 品質ゲート

```bash
npm run selftest        # セルフテスト: 隔離インスタンスでエンドツーエンドのアサーション検証
npm run lint:manifests  # プラグインマニフェストの 5 面 YAML 検証
```

- `selftest` は独立ポート＋独立データディレクトリで隔離インスタンスを起動し、認証・RBAC・計測・
  市場・SSO・NAS・監査等をエンドツーエンドで検証します（セキュリティ攻撃演習を含む）。
  **件数は直近実行時点が正**であり、リポジトリの口径では履歴カウントは無効とされます
  （2026-10-15 バッチ時点で ≥ 1,380 件）。
- `lint:manifests` は全プラグインの宣言面（api／permissions／events／ui／billing の 5 面）を検証します。
- いずれも「全件合格（グリーン）」が合格基準です。失敗する場合は Node のバージョンと
  データディレクトリの状態を先に確認してください。

## 7. CLI 入門（dshctl）

運用操作は REST API だけでなく、同梱の CLI `cli/dshctl.mjs` からも実行できます。
認証情報は環境変数（`DSHCTL_USER`／`DSHCTL_PASS`）または `DSHCTL_TOKEN` で提供します。

```bash
DSHCTL_USER=admin DSHCTL_PASS=<パスワード> node cli/dshctl.mjs help

# 出力形式と dry-run の例
node cli/dshctl.mjs mcp list --output json
node cli/dshctl.mjs mcp deploy <id> --dry-run --changelog="検索精度の改善"
node cli/dshctl.mjs agent offline <id> --reason="連続異常"      # L4 承認単が生成される
```

`--output json|table` による機械可読出力、`--dry-run`／`--yes` による影響範囲の事前確認に対応しています。
CLI 出力は `--lang`／`DSHCTL_LANG` で切替できます（既定は中文。第 11 節）。

### 7.1 運用スキルハンドブック（Agent 連携、オプション）

`skills/dsh-ops-*/SKILL.md`（総合索引 `dsh-ops-admin` を含む 9 種）は、分野別の運用ハンドブックです。
dsh のスキルシステムは既定でリポジトリ直下を走査しないため、Agent に与える場合は配置します:

```bash
# ユーザー単位（すべてのセッションで有効）:
cp -r skills/dsh-ops-* ~/.dsh/skills/
# またはプロジェクト単位（当該プロジェクトのみ）:
mkdir -p .dsh/skills && cp -r skills/dsh-ops-* .dsh/skills/
```

## 8. プラットフォーム自己更新の基本

両導入形式とも、上流リポジトリの新バージョンを検知できます。**アップグレードの実行可否は常に
管理者が決定します。**

- **自動確認**: 既定で 24 時間間隔（起動 15 秒後に初回実行）。上流の `package.json` バージョンと
  GitHub のコミット差分を比較し、新バージョン検知時はコンソール（控制台）トップバーに
  **更新あり（可更新）** バッジを表示し、`platform.update.available` イベントを発行（監査記録）します。
  コンソールのドロワーで有効／無効・頻度を変更できます。
- **手動アップグレード**: バッジ → ドロワーの **ワンクリックアップグレード（一键升级）**（source 形式:
  `git pull --ff-only` ＋ `npm install`、dry-run 予行対応・完了後に再起動を促す）。
  CLI: `dshctl update status | check | apply [--dry-run]`。Agent ツール: `update_status` / `update_check` /
  `update_apply`。バンドル（bundle）形式では `dsh plugin update` の手順が案内されます。
- **内部網・レート制限対策**: `GITHUB_TOKEN` でレート制限を緩和、`DSH_UPDATE_API_BASE` /
  `DSH_UPDATE_RAW_BASE` でプライベートミラーを指定、`DSH_UPDATE_AUTO_CHECK=off` で自動確認を停止。
- **権限点**: `platform.update.read`（閲覧・確認）、`platform.update.apply`（アップグレード実行）。
- 任意のサプライチェーン強化として、リリースマニフェストの Ed25519 署名検証（公開鍵登録＋
  強制モード）とピン留め（pin）アップグレードに対応しています。

## 9. 次のステップ

| 目的 | 文書 |
|---|---|
| 製品の全体像を把握する | [README.md](README.md) |
| 位置づけとペルソナを把握する（営業資料） | [product-introduction.md](product-introduction.md) |
| プラグインアーキテクチャと dsh 連携を理解する | [dsh-ecosystem.md](dsh-ecosystem.md) |
| 企業導入の本番手順（systemd・リバースプロキシ等） | [docs/deploy-enterprise.md](../../deploy-enterprise.md)（中文・内部寄り） |
| プロトコルキーの中文対照 | [docs/协议键中文对照总表.md](../../协议键中文对照总表.md)（中文・内部） |
| 機能使用ガイド（全ドメイン） | [user-guide.md](user-guide.md)（並行バッチで提供） |
| 企業導入 runbook（本番形態） | [deploy-enterprise.md](deploy-enterprise.md)（並行バッチで提供。中文原典は [docs/deploy-enterprise.md](../../deploy-enterprise.md)） |
| AI アプリ SSO 接続 | [app-sso-integration.md](app-sso-integration.md)（並行バッチで提供） |

## 10. トラブルシューティング（よくある項目）

| 症状 | 確認点 |
|---|---|
| 起動時に Node のエラー | `node -v` が 22.6 未満でないか（ネイティブ TS 実行のため要アップグレード） |
| ログインできない | `ADMIN_PASSWORD` 未設定の場合は `data/admin-initial-password.txt` の値を使用。空文字指定時はランダム生成にフォールバック |
| 初回パスワードを紛失 | データディレクトリを空にして再起動するか、`iam.user.write` 持ち管理者がパスワードリセット（重置口令）を実施 |
| ポート衝突 | `npm start -- --port <別ポート> --data <別ディレクトリ>` で分離（孤児プロセスのポート占有に注意） |
| `/api/*` への匿名アクセスが 404 ではなく 401 | 仕様です（未一致ルートの匿名リクエストは一律 401。ルート存在性の側チャネル（サイドチャネル）を防ぐ設計） |
| デモアカウントのパスワードを忘れた | デモモードのアカウントはいずれも `Ybk@2026` です（本番の `admin` には適用されません） |
| 画面が中文で読みにくい | 画面上部の言語セレクターで切替できます（第 11 節）。既定は簡体字中国語。必要に応じてブラウザのページ翻訳もご利用ください |
| バンドルインストール後に `/rq` が見つからない | dsh web が起動しているか確認し、`dsh --profile web --dump-config` で `ops-*` エントリの存在を確認してください |

## 11. 画面言語について

**2026-10-16 リリースより、実行 UI（コンソール／パネル／ポータル／CLI 出力／通知・承認文案／エラー表示）に
言語切替が内蔵されました：簡体字中国語（既定）／英語（en-US）／日本語。** 画面上部のセレクターで切替、設定はブラウザに保存（`rq_lang`）。CLI は `--lang` または `DSHCTL_LANG` に従います。辞書未収録の文言は自動的に中国語にフォールバックします。
本ガイドの UI 表記は「日本語名（中文原文）」の二言語注記で、中国語固定運用や画面キャプチャ照合時に引き続き有効です。
補助手段としてブラウザのページ翻訳機能も引き続き利用できます。

---

**関連文書**: [README.md](README.md) · [product-introduction.md](product-introduction.md) ·
[dsh-ecosystem.md](dsh-ecosystem.md) · 用語集 [GLOSSARY.md](../GLOSSARY.md)
