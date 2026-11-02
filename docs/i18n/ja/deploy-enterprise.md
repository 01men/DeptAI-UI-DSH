# 企業導入と dsh 接続（Enterprise Deployment Runbook・日本語版）

> **日本語版** — 機械翻訳支援＋i18n PM による統一校正。**中文原文が正式版です（齟齬時は中文が優先）。**
> 原典: `docs/deploy-enterprise.md` · 原典基準日: 2026-10-15 · 用語集: [GLOSSARY.md](../GLOSSARY.md) · ガバナンス: [README.md](../README.md)

## 対象読者

DeepSeek Harness（dsh）を基盤に本リポジトリ（YuanBingKe · エンタープライズ AI リソース管理プラットフォーム）を企業環境に導入するエンジニア、および導入・接続作業を **dsh 内蔵 Agent にそのまま指示して自動完結させたい** 利用者。日常運用（導入後）の Agent 向け指引は中文原典 `skills/dsh-ops-admin/SKILL.md`（総括インデックス）を参照してください。

> 注：本書のテスト件数（`lint:manifests 70/70` など）は中文原典執筆時点の値です。テスト数は「直近の実行時点の値」が正であり、最新値はリリースノート（[release-notes-summary.md](release-notes-summary.md)）を参照してください。

---

## 1. 導入形態とトポロジ

| 形態 | プロセス | 説明 | 適用 |
|---|---|---|---|
| A. 独立ホスト（既定） | `node src/main.ts` | 1 プロセスで REST ゲートウェイ＋コンソール SPA＋運用ツールブリッジ 41 本（接続管理ツール 4 本を含む）を提供 | 企業本番の最小形態。コンソールでの手動運用 |
| B. dsh ランタイムへのマウント | `dsh web --patch <overlay>` | プラットフォームを `/rq` にマウントする実験的な形態。分離したデータで検証 | Agent 主導の運用 |
| C. リモート dsh 接続 | ホスト（A）＋遠隔 PC で `dsh plugin add` | 遠隔 PC がプラグイン市場から本プラットフォームをインストールし、**一回限りの接続コード**でホストにマシンクレデンシャルを申請。運用ツールはすべてホストへリモートプロキシ（ソース不要・data 共有不要） | 拠点間・複数人で dsh 経由の共同運用 |

> `cordis.yml` は console と dsh bridge を含み、独立 HTTP リスナーを無効にして `/rq` へのマウントを意図しています。複数プロセスで同一データディレクトリを使用しないでください。

環境要件：Node ≥ 22.6（ネイティブ TypeScript 実行、ビルド不要）。データは `--data` で指定したディレクトリに永続化されます（JSON コレクション＋SQLite `txnstore.db`）。

**bundle 導入と独立プロセス導入**：GitHub からのソース検出（独立プロセス、上記 A/B）に加え、dsh プラグイン市場からの **bundle 一括インストール**（`dsh plugin --profile web add github:01men/ybkkasi`、データプレーンは `/rq` 接頭辞でマウント、25 プラグインエントリを一括装着）でも導入できます。bundle 形態のアップデートは `dsh plugin update` を使用します（§4 参照）。

---

## 2. 手動導入 runbook（形態 A · 実行可能なチェックリスト）

> 各ステップに「コマンド＋期待出力」を示します。期待と異なる場合は先に右側の対処を行ってから次へ進んでください。

### ステップ 0：環境プリチェック

- [ ] `node -v` → **v22.6 以上**（ネイティブで TS を実行、ビルド工程なし）
      ✘ 22.6 未満の場合は Node をアップグレードしてから継続。バイパスしないでください（旧バージョンでは `src/main.ts` を直接実行できません）。

### ステップ 1：コード取得と依存インストール

```bash
git clone <仓库地址> ops-platform && cd ops-platform
npm install                # 期待：ERR で終わらないこと。package-lock 未変更なら数秒で完了
```

### ステップ 2：初回起動（ベースライン初期化）

```bash
# 本番：口令は必ず明示指定（未設定ならランダム生成され、data/admin-initial-password.txt に一度だけ書き出される）
export ADMIN_PASSWORD='<強力な口令>'            # Windows PowerShell の場合: $env:ADMIN_PASSWORD='...'
npm start -- --port 7300 --data ./data
```

- [ ] ログに「平台基线初始化完成」（ベースライン初期化完了）＋「上线三步走」ガイドボックスが表示される（初回起動時のみ）
- [ ] ログに「元冰可|企业AI资源管理平台已启动」と「控制台地址：http://0.0.0.0:7300」が表示される
- [ ] `curl -s http://127.0.0.1:7300/api/health` → `{"status":"ok",...}`
- [ ] （`ADMIN_PASSWORD` 未設定の場合）`data/admin-initial-password.txt` が生成されていることを確認し、
      **読み取ったら直ちにステップ 4 へ進んで口令を変更する**

### ステップ 3：機能検証

```bash
# ログイン（期待：token フィールドを含む応答）
curl -s -X POST localhost:7300/api/auth/login -H 'content-type: application/json' \
     -d '{"username":"admin","password":"<口令>"}'
# 初期起動状態（期待：initialPasswordPending=true — 口令ファイルがサーバーに残っている間は true、変更＋削除後に false）
curl -s http://127.0.0.1:7300/api/platform/bootstrap
```

- [ ] ログインで token が返る。ブラウザでコンソールを開き、口令ファイルが残っている間はログインページに
      黄色の「首次部署提示」（初回導入のお知らせ）バナーが表示される
- [ ] 品質ゲート（隔離インスタンスで本番データに触れない）：`npm run selftest` 全緑、`npm run lint:manifests` エラー 0

### ステップ 4：仕上げ（安全な引き取り）

- [ ] コンソールで admin 口令を変更（右上のアバター → パスワード変更）
- [ ] サーバーの `data/admin-initial-password.txt` を削除 → `curl -s http://127.0.0.1:7300/api/platform/bootstrap`
      が `initialPasswordPending:false` になり、ログインページのバナーが消える
- [ ] （サプライチェーン強化・任意かつ推奨）リリースマニフェストの署名検証：

```bash
# リリース側（一回限り）：鍵ペア生成 → 秘密鍵は自己保管、公開鍵をプラットフォームに登録
node scripts/release-manifest.mjs --generate-key --key-file /secure/release-key.pem
# 管理者側（一回限り）：公開鍵登録 → 強制有効化（順序厳守。未登録のまま有効化すると拒否される）
curl -X POST localhost:7300/api/update/settings -H "authorization: Bearer <token>" \
     -H 'content-type: application/json' -d '{"releasePublicKey":"<公钥 base64>"}'
curl -X POST localhost:7300/api/update/settings -H "authorization: Bearer <token>" \
     -H 'content-type: application/json' -d '{"requireSignedManifests":true}'
```

### ステップ 5：プロセスデーモン（Linux systemd の例）

```ini
# /etc/systemd/system/ops-platform.service
[Service]
WorkingDirectory=/opt/ops-platform
Environment=ADMIN_PASSWORD=<強力な口令>
# 接続器ゲートウェイの必須 env（欠落すると接続器ページが継続的に「网关不可用」になり探活失敗が監査に流れる）
Environment=OOMOL_CONNECT_ADMIN_TOKEN=<強力な口令>
Environment=OOMOL_CONNECT_ENCRYPTION_KEY=<32 バイト以上のランダム文字列>
# ポート占有ガード：孤児プロセスにポートを奪われると restart が静かに無効化されるため起動前に検査する
ExecStartPre=/opt/ops-platform/scripts/guard-port.sh 7300
ExecStart=/usr/bin/node src/main.ts --port 7300 --data /opt/ops-platform/data
Restart=always
```

運用上の要点：

- **運用の鉄律**：サービスの起動・停止は必ず `systemctl` 経由。systemd を迂回した手動の
  `node src/main.ts` 起動は禁止です（孤児プロセスがポートを奪うと `systemctl restart` が失敗または旧プロセスがポートを占有し続け、変更が反映されず切り分けも困難になります）。
- **バックアップ**：`--data` ディレクトリ全体のコールドバックアップで十分です
  （JSON はアトミック書き込み＋SQLite WAL）。計量データは `txnstore.db` にあります。
- **アップグレード（v1.1 以降の内蔵更新チェック）**：プラットフォームは既定で 24 時間ごとにアップストリーム
  GitHub リポジトリへバージョンチェックを行います（コンソール頂部の**プラットフォーム更新（平台更新）**ドロワー、または `dshctl update set` で調整・停止可能）。新バージョン検知時はコンソール頂部に**更新可能（可更新）**バッジが表示され、`platform.update.available` イベントがブロードキャストされます（監査記録）。アップグレード方法はインストール形態ごとに二択：
  - **ソース検出（source）**：コンソールドロワーの**ワンクリックアップグレード（一键升级）**、
    または `dshctl update apply --dry-run` で予行演習のうえ `dshctl update apply --reason="…"`（内部で `git pull --ff-only` ＋ `npm install` を実行。未コミットの変更がある場合は強制改変ではなく安全に失敗）。その後 `systemctl restart ops-platform` で反映。トラフィック切り替え前に `npm run selftest` を実行してください。
  - **プラグイン市場インストール（bundle）**：ホスト dsh 側で `dsh plugin update github:01men/ybkkasi` を実行し
    （インストールソースは 2026-10-14 に 01men/ybkk-AIOS から本リポジトリへ移行済み）、
    dsh ホストを再起動。
  - Agent はセッション内で「プラットフォームの更新を確認」／「プラットフォームをアップグレード」と指示できます
    （`update_status` ／ `update_check` ／ `update_apply` ツール）。
- **外部公開**：Nginx 等のリバースプロキシで 7300 を TLS 公開します。プラットフォーム自身は Bearer トークン認証です。
- **企業カスタマイズ（必要に応じて）**：DingTalk 実接続器（`mode: real` ＋ `apiBase`。コンソールの
  **組織とアカウント（组织与账号）→ サードパーティ統合（三方集成）**で設定）。同一プロバイダ複数主体・複数インスタンスに対応（インスタンス id で設定をアドレス指定、`provider|corpId` で一意、重複主体は拒否）。REST 面：`POST /api/iam/connectors` で作成、`DELETE /api/iam/connectors/:id` で削除（権限点 `iam.connector.write`）。設定フィールドは `name`（主体の表示名）と `targetOrgId`（同期ツリーのルートマウント部門、空ならプラットフォームルート）を追加できます。OIDC の対外宣言は `OIDC_ISSUER` 環境変数で行い、OIDC 秘密鍵は本番では KMS への移行を推奨します。
- **内網・レート制限環境**：更新チェックは GitHub API を使用します（未認証は 60 回/時/IP。`GITHUB_TOKEN` で
  限额引き上げ可能）。プライベートミラーは `DSH_UPDATE_API_BASE` ／ `DSH_UPDATE_RAW_BASE` 環境変数で上書きします。
- **セキュリティヘッダ**：全レスポンスにセキュリティヘッダが既定で付与されます（詳細は
  [user-guide.md](user-guide.md) §1.5）。無効化は `SECURITY_HEADERS=off`。
- **商業境界**：本プラットフォームには金額決済機能は存在しません（M0 方針 — 課金・決済・ウォレットの
  セマンティクスは廃止済み）。対価は「チーム＋ドメイン資産」の契約またはオンプレミス導入プロジェクトとして、プラットフォームの外部で管理してください。

---

## 3. dsh ランタイム接続（形態 B · Agent 運用の有効化）

この接続形態は実験的です。分離したデータで検証してください。dsh がインストール済みの場合は `dsh plugin --profile web add github:01men/ybkkasi` を使用します。

ソースからマウントする場合は、[中国語原典](../../deploy-enterprise.md#三dsh-运行时接入形态-b启用-agent-运维)を参照し、`file://` 形式の URL を使う overlay を生成して、ホストとプラグインが同一の cordis インスタンスを使うことを確認します。`/rq` と利用可能なツールを検証し、複数プロセスでデータディレクトリを共有しないでください。

運用手順は `skills/dsh-ops-admin/SKILL.md` を参照し、実際の権限と承認規則に従ってください。

---

## 4. リモート dsh 接続（形態 C：プラグイン市場インストール → 接続コード → 自動申請）

適用：他の PC の dsh が `dsh plugin --profile web add github:01men/ybkkasi` で本プラットフォームをインストール済みで、ホスト発行のクレデンシャルの設定方法が不明なケース。**遠隔 PC で設定ファイルを手動編集する必要は一切ありません**。

### 4.1 ホスト側：一回限りの接続コードを発行（管理者・コンソールまたは CLI）

```bash
# コンソール：ログイン → 左側「プラットフォーム → プラットフォーム接続（平台接入）」→ 接続コード作成
#   （テンプレート/TTL/備考を選択。コードは一度だけ表示される）
# または CLI：
DSHCTL_URL=http://宿主IP:7300 DSHCTL_USER=admin DSHCTL_PASS=*** \
  node cli/dshctl.mjs connect code --template=operator --ttl=15 --remark="研发部小王"
```

権限テンプレート（＝接続後の遠隔クライアントの権限境界）：

| テンプレート | 権限 |
|---|---|
| `readonly`（既定） | 全照会系パーミッションポイント（list/get/metrics/logs） |
| `operator` | 読み取り＋MCP/Skill/Agent/アプリの運用と承認決裁。**アカウントとクレデンシャル管理は含まない** |
| `full` | 全権限（`*`）。信頼できる環境でのみ使用 |

### 4.2 遠隔 PC：二つの接続チャネル（いずれかを選択）

```text
① Agent チャネル（推奨）：dsh 画面で Agent に直接指示する
   「ホストプラットフォームに接続。アドレス http://<ホストIP>:7300、接続コード <enr_…>」
   Agent は connect_setup ツールを呼び出して自動申請し、運用ツールをリモート実行に切り替える。

② 設定ページチャネル：ブラウザで http://127.0.0.1:7390 を開く（遠隔 PC の本機。プラグイン起動時に自動リッスン）
   ホストアドレス＋接続コードを入力 → 「申請接続」。以後このページで設定更新・接続テスト・切断が可能。
   既存のマシンクレデンシャル（mc-/cs_ 接頭辞）がある場合は「既存マシンクレデンシャル」タブで直接設定。
```

### 4.3 検証と運用

- 遠隔側：Agent に `connect_status`（remote モード表示・トークン有効）と `agent_list`（ホストのデータが返る）を実行させる。
- ホスト側：コンソールの**プラットフォーム接続 → 接入済みクライアント（已接入客户端）**に当該 PC が現れる
  （名称／テンプレート／ホスト名／最終使用）。5 分ごとの心跳（`heartbeatIntervalMinutes=0` で停止可能）が生存とメタ情報を報告します。
- 回収：ホスト側で「クライアント無効化」（理由必須で記録）→ 全マシントークンが連動失効し、遠隔のツール呼び出しは
  即時 401。遠隔側の `connect_reset` は本機のクレデンシャルのみを消去します。
- セキュリティ基線：接続コードはハッシュのみ保存（作成時に一度だけ表示）・一回消費・TTL 設定可（既定 15 分）・
  送信元 IP ごとの失敗ロック（15 分窓で 5 回）。マシンクレデンシャル（口令相当）は遠隔本機のみに保存（0600）。クライアントのツールプロキシはホストの `/api/tools/execute` を経由し、ツールごとに RBAC 検証と全程監査が行われます。

### 4.4 よくある問題

| 症状 | 対処 |
|---|---|
| connect_setup が「接続コード無効」を報告 | コードが使用済み／期限切れ／失効（一回消費）。ホスト側で再作成 |
| 「ホストサービスに到達不可」を報告 | ホストの 0.0.0.0 リッスンとファイアウォールを確認。アドレスは `http://` とポートを含める |
| ツール実行が 403（権限点不足） | 権限テンプレートが不足。ホスト側でクライアントを無効化し、上位テンプレートの接続コードで再接続 |
| 無効化後も遠隔で「設定済み」表示 | 本機のクレデンシャルは残存しているが無効。遠隔側で `connect_reset` を実行して消去 |

---

## 5. Agent への一括指示テンプレート（dsh 内蔵 Agent にそのまま貼り付け可能）

> 使い方：以下の指示ブロック全体を dsh Agent に送り、`<...>` のプレースホルダを置換してください。Agent が導入と検証を自動実行して結果を報告します。本番環境では事前にプレースホルダと口令強度を人手で確認してください。指示にはガードレールが内蔵されています（デモデータの禁止、既存データディレクトリの上書き禁止、高危操作は承認チケット経由）。

```text
【任务】在 <目标服务器，如 10.0.0.5 或本机> 上部署「元冰可 · 企业 AI 资源统一管理平台」并完成验证。
仓库：<git 克隆地址，如 git@github.com:01men/ybkkasi.git>；部署目录：<如 /opt/ops-platform>；
监听端口：<7300>；管理员口令：<ADMIN_PASSWORD 强口令>；部署后是否接入 dsh 运行时：<是/否>。

【执行步骤】
1. 环境检查：确认 Node ≥ 22.6（node -v）。不满足则停止并回报，不要自行升级系统 Node。
2. 获取代码：克隆（或若目录已存在则 git pull）到部署目录；记录当前 commit hash。
3. 安装依赖：npm install。
4. 生产初始化：设置 ADMIN_PASSWORD 环境变量；以 --port <端口> --data <部署目录>/data 启动
   （优先用 systemd/PM2 守护）。铁律：绝不设置 DEMO_SEED=1；若 data/ 目录已存在且非空，
   视为已有实例——停止并请求人工确认，不得覆盖。
5. 健康验证（全部通过才算成功）：
   a. GET / 返回 200；
   b. POST /api/auth/login（admin + 口令）返回 token；
   c. GET /api/overview（Bearer token）返回 200；
   d. npm run selftest 全部通过；npm run lint:manifests 70/70 通过。
6.（可选，仅当"接入 dsh"=是）按仓库 docs/deploy-enterprise.md 第三节生成 overlay 并以
   pnpm dsh web --patch 启动，在隔离数据目录中验证 /rq；不得让两个进程同时共享 data/。
7. 回报：commit hash、服务地址、admin 首登是否成功、自测结果、初始口令交付方式（不得明文贴在公开渠道）。

【护栏】
- 一切高危操作（下线/吊销/删除）必须走平台审批单并留痕，不得绕过；
- 只读命令可自由执行；仅对明确支持预演的命令使用 --dry-run，其他命令不得假设该参数能阻止写入；
- 部署完成后建议立即改掉 admin 初始口令并创建企业自有账号（参考 skills/dsh-ops-iam）。
```

---

## 6. 検収チェックリスト

- [ ] `GET /` が 200、コンソールへログイン可能（admin ＋ `ADMIN_PASSWORD`）
- [ ] `npm run selftest` 全緑、`npm run lint:manifests` エラー 0
- [ ] 本番データディレクトリに**演示データが含まれない**（`data/iam~users.json` に ops/hr/dev 等の演示アカウントがない）
- [ ] `GET /api/platform/bootstrap` が `initialPasswordPending:false` を返す（初期口令の引き取りが完了）
- [ ] （形態 B）dsh web が起動し、Agent が `dshctl mcp list` 系の質問に答えられる
- [ ] （形態 C）遠隔 PC の `connect_status` が remote モードを表示。ホストの「プラットフォーム接続」ページに
      当該クライアントが見える
- [ ] バックアップ方針が整備されている（`data/` ディレクトリの定時コールドバックアップ）
- [ ] admin 初期口令を変更済みで、演示口令 `Ybk@2026` ではログインできない
- [ ] （任意のサプライチェーン強化）`GET /api/update/status` が `releaseKeyConfigured:true` を表示

---

## 7. リージョン導入ノート（国際展開向け補足）

- **時刻表示**：プラットフォームのログ・監査時刻は**サーバーのローカルタイム**です。日本では JST（UTC+9）、
  複数リージョン運用では UTC に統一したサーバー設定を推奨します。ドキュメント上の技術的日付は ISO 8601（2026-10-15 形式）で統一しています。
- **内網／ミラー環境変数**：GitHub への更新チェックが内網から到達できない・レート制限に当たる場合は、
  `GITHUB_TOKEN`（限额引き上げ）と `DSH_UPDATE_API_BASE` ／ `DSH_UPDATE_RAW_BASE`（プライベートミラーの API／raw ベース URL 上書き）を設定してください。`DSH_UPDATE_AUTO_CHECK=off` で自動チェック自体を停止できます。DingTalk 接続器を使わない環境では `IAM_CONNECTOR_AUTO_SYNC=off`（定时器停止）、ポータル引き取りを使わない環境では `PORTAL_SYNC=off`（停止）が設定可能です。
- **データレジデンシー**：本プラットフォームは**自己ホスト（self-hosted）設計**です。全業務データは自社管理の
  `--data` ディレクトリ（JSON コレクション＋SQLite）に留まり、オープンソースのオンプレミス（プライベート）導入はデータが企業境界外に出ないことを意味します。上流バージョンとの通信は「更新チェック」（§1.6）のみで、これもミラー変数により内網完結にできます。ただし SOC 2／ISO 27001 等の認証は**未取得（ロードマップ）**、GDPR の DPA テンプレート等も**ロードマップ**です。正式な法務確認のうえご検討ください。
- **画面言語**：2026-10-16 リリースより、実行時 UI に言語切替が内蔵されました（簡体字中国語〔既定〕／英語 en-US／日本語。詳細は [user-guide.md](user-guide.md) §0.2）。画面上部のセレクターで切替、CLI は `--lang`／`DSHCTL_LANG`、辞書未収録の文言は中文にフォールバックします。中国語固定運用のオンプレミス導入でも中文 UI は引き続き利用できます。
