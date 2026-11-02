# アプリ統一 ID 接続（App SSO）ガイド（日本語版）

> **日本語版** — 機械翻訳支援＋i18n PM による統一校正。**中文原文が正式版です（齟齬時は中文が優先）。**
> 原典: `docs/app-sso-integration.md` · 原典基準日: 2026-10-15 · 用語集: [GLOSSARY.md](../GLOSSARY.md) · ガバナンス: [README.md](../README.md)

対象読者：企業内の自社開発 AI アプリケーション（Web／H5／ミニプログラム／デスクトップ／API サービス）にプラットフォーム統一 ID を接続する開発者。本書はサービスに同梱され、`http://<平台地址>/docs/app-sso-integration.md` で直接参照できます（`/docs` は公開ホワイトリスト制）。ゴール：**アプリ登録 → クレデンシャル取得 → 規格に沿った一行 SDK 接続 → 業務権限はアプリ側で管理**。

プラットフォームは企業内の統一 ID ソース（OIDC Provider）として ID サービスを提供します。接続後の動作：

- ユーザーがアプリ内の「ログイン」をクリック → プラットフォーム認可ページへ遷移 → プラットフォームセッション
  またはログインパネル（アカウント＋パスワード／DingTalk パスワードレス。接続器設定で表示制御） → 認可確認 → `code` を持ってアプリへリダイレクト。DingTalk ユーザーはコンソールへの事前ログイン不要で、認可ページ内のログインパネルから**DingTalk スキャン（钉钉扫码）**によるパスワードレスログインが完結し（初回はバインド／登録分岐）、そのまま認可確認へ進みます。
- アプリのバックエンドが `code` ＋ `client_secret`（純フロントエンドなら PKCE）で `id_token` ／
  `access_token` と交換し、`access_token` で `userinfo` を呼んでユーザー身元（`sub`／組織／ロール／テナント）を取得します。**業務権限はアプリ側で管理します**。
- アカウントがプラットフォームで凍結・退職となった場合 → アプリ側の次の `userinfo` ／ `refresh` が即時失効
  （トークン期限切れを待つ必要はありません）。

## 1. 接続の 5 ステップ

| ステップ | 操作 | 場所 |
|---|---|---|
| 1. アプリ登録 | 「AI アプリケーション（AI 应用）」→ アプリ登録（形態・アクセス URL・編成 Agent） | コンソール |
| 2. クレデンシャル発行 | アプリ詳細 → 「SSO 設定（SSO 配置）」タブ → SSO クライアント発行（`client_id` ＋ `client_secret`。secret は一度だけ表示） | コンソール |
| 3. 公開ゲート | `web`／`h5` 形態は発行を完了しないと公開できません（`APP_SSO_ENFORCE` で調整可）。審批の実行期にもクライアント状態を再検査 | コンソール＋承認センター（审批中心） |
| 4. アプリ側接続 | 後述の「SDK 一行接続」またはエンドポイント直結で認可コードフロー（PKCE S256 強制）を実装 | アプリコード |
| 5. 業務権限は自社管理 | `userinfo` の `sub` が安定関連キー。アプリ内で業務ロールを自主マッピング | アプリコード |

> **ループバック自己完結（コンソール操作不要）**：コールバック URL が本機ループバック（`127.0.0.1`／`localhost`／`0.0.0.0`）の場合、owner／管理者のコンソール代行は不要です — アプリは登録時に自動発行されたマシンクレデンシャルで自ら発行し、`client_id` ／ `client_secret` を直接受け取れます（応答はこの一回限り）：
>
> ```
> POST /api/apps/<应用ID>/sso-client     （Bearer 机器凭证令牌，凭证默认含 app.write）
> body {"redirectUris":["http://127.0.0.1:5000/oauth/cb"]}
> → 200 { clientId, clientSecret, redirectUris }
> ```
>
> コールバック変更は同パス `PATCH`、secret 更新は `POST …/rotate`、発行済み設定は `GET /api/apps/:id` の `sso` ブロック（secret は含まない）。マシン自己完結はループバックのコールバックのみ対象で、非ループバック（内網 IP／公網ドメイン）は owner または管理者がコンソールで操作してください（`APP_SSO_MACHINE_LOOPBACK=0` でチャネル全体を停止できます）。

## 2. SDK 一行接続（推奨）

### バックエンド／BFF（confidential クライアント・既定形態）

Node.js（[openid-client](https://github.com/panva/openid-client) v6。プラットフォームの自己テストと同種）：

```js
import * as oc from 'openid-client'

// ① 一行 discovery ドライブ：issuer をプラットフォームのアドレスに替えるだけ
const config = await oc.discovery(
  new URL('https://sso.yourcompany.com'),        // OIDC_ISSUER（後述）
  process.env.SSO_CLIENT_ID,                     // コンソール発行の client_id
  undefined,
  new oc.ClientSecretBasic(process.env.SSO_CLIENT_SECRET),
)

// ② ログイン入口：認可 URL を組み立てて 302（state/PKCE はプラットフォームが強制検証）
const verifier = oc.randomPKCECodeVerifier()
const challenge = await oc.calculatePKCECodeChallenge(verifier)
const redirectTo = oc.buildAuthorizationUrl(config, {
  redirect_uri: 'https://your-app.com/auth/cb',  // コンソール登録の redirect_uris と完全一致が必要
  scope: 'openid profile email',
  state: oc.randomState(), nonce: oc.randomNonce(),
  code_challenge: challenge, code_challenge_method: 'S256',
})

// ③ コールバック処理：code をトークンと交換（id_token は SDK が JWKS で検証済み）
const tokens = await oc.authorizationCodeGrant(config, callbackUrl, {
  code_verifier: verifier, state, nonce,
})
const user = await oc.fetchUserInfo(config, tokens.access_token, tokens.claims().sub)
// user = { sub, name, preferred_username, email?, org: {id,name,tenantId}, roles, tenant }
```

- サイレント更新：`oc.refreshTokenGrant(config, tokens.refresh_token)`
  （ローテーション一回一換。旧値のリプレイはチェーン全体を失効）。
- ログアウト連動：`oc.buildEndSessionUrl(config, { id_token_hint, post_logout_redirect_uri, state })`。
  プラットフォームは該当ユーザーの本アプリでの refresh チェーンを同時失効させます。`post_logout_redirect_uri` を省略した場合、クライアントが登出入口を一つだけ登録していればそのアドレスへリダイレクトします（複数環境の登録がある場合は明示引数を推奨）。任意失効：`oc.tokenRevocation(config, tokens.access_token)`（RFC 7009）。

### 純フロントエンド SPA（public クライアント・D-a 決定：public 形態をサポート）

secret を保持できない H5／SPA は、発行時に **public** クライアント種別を選択します — `client_secret` 不要・**PKCE 強制**・**refresh token は発行しない**（access token 期限切れ後はサイレントに認可を再実行）。ライブラリは [oidc-client-ts](https://github.com/authts/oidc-client-ts) が使えます：

```js
const mgr = new UserManager({
  authority: 'https://sso.yourcompany.com',       // プラットフォームの discovery アドレス
  client_id: 'oc-xxxxxxxx',                        // public クライアント
  redirect_uri: 'http://localhost:5173/cb',        // localhost のデバッグ URL はホワイトリストで許可
  response_type: 'code', scope: 'openid profile',
  code_challenge_method: 'S256',                   // プラットフォーム強制
})
await mgr.signinRedirect()                          // ログイン入口
const user = await mgr.signinRedirectCallback()     // コールバック処理。id_token は検証済み
```

> セキュリティ注意：public クライアントはトークンの露出面が広いため、内網ツール／非機密データのアプリに限って推奨します。BFF を構成できる場合は confidential を優先してください。

#### CORS（純フロントエンドのクロスオリジン直呼び出し。プラットフォームに内蔵済み）

ブラウザ内 JS から `POST /oauth/token`、`GET /oauth/userinfo`、`POST /oauth/revoke` と二つの discoveryエンドポイントへクロスオリジンで呼び出す際、プラットフォームは自動で CORS 放行ヘッダを返します（**画面設定は不要**）：

- 許可オリジン ＝ 登録済み `redirect_uri` の origin（scheme://host:port）∪ 環境変数 `OIDC_CORS_ORIGINS`
  （カンマ区切りで未登録オリジンを追加）。コールバック `http://192.168.0.4:8092/cb` を登録すれば `http://192.168.0.4:8092` が自動放行されます。`OPTIONS` プリフライトは一律 204、`Access-Control-Allow-Headers: authorization, content-type`。成功・エラー両応答に `Access-Control-Allow-Origin` を付与（ブラウザがエラーボディを読めます）。
- 未登録オリジンには放行ヘッダを発行しません（`Vary: Origin` のみ）。認可第一跳 `/oauth/authorize` と
  ログアウト `/oauth/end_session` はブラウザのトップレベル遷移のため CORS は関与しません。

## 3. エンドポイントと discovery

| エンドポイント | パス |
|---|---|
| discovery | `GET /.well-known/openid-configuration` |
| JWKS 公開鍵 | `GET /.well-known/jwks.json` |
| 認可 | `GET /oauth/authorize`（302 でプラットフォーム認可ページへ） |
| トークン交換 | `POST /oauth/token`（`client_secret_basic`／`client_secret_post`。form-encoded と JSON の双方に対応） |
| ユーザー情報 | `GET /oauth/userinfo`（Bearer access token） |
| 更新 | `POST /oauth/token`（`grant_type=refresh_token`。ローテーション＋scope は縮小のみ） |
| 失効 | `POST /oauth/revoke`（RFC 7009、恒 200） |
| ログアウト | `GET /oauth/end_session`（`id_token_hint` ＋ `post_logout_redirect_uri`） |

**`OIDC_ISSUER` と内網／HTTPS リバースプロキシ**：既定の issuer は `http://127.0.0.1:<port>` で本機デバッグ専用。本番・内網導入では対外アドレスを明示宣言してください（リバースプロキシ構成では `x-forwarded-host` に対応する対外ドメイン）：

```bash
OIDC_ISSUER=https://sso.yourcompany.com   # discovery/JWKS/各エンドポイントはこれをもとに URL を組み立てる
```

アプリとユーザーのブラウザの双方がこのアドレスに到達できる必要があります。リバースプロキシでは `/oauth/*`、`/.well-known/*` と SPA ルート `/#/oauth/*` を通してください。issuer 変更で既存トークンの `iss` 検証が失敗するのは想定内です（トークン寿命は短いため）。

## 4. claims 契約

| claim／フィールド | 意味 |
|---|---|
| `sub` | プラットフォームユーザー ID。**不変かつ唯一の関連キー**（アプリ内アカウントマッピングはこれを基準に。username を使わない） |
| `preferred_username`／`name` | ユーザー名／表示名（改名され得るため主キーにしない） |
| `email` | 認可 scope に `email` が含まれる場合のみ返却 |
| `org`／`tenant` | 所属組織 `{id,name,tenantId}`／テナント ID（マルチテナント分域の参考） |
| `roles` | プラットフォーム治理ロール code（`super_admin` 等）— **プラットフォーム治理ロールであり、アプリの業務ロールではない** |
| `id_token.token_use='id'`／`access.token_use='access'` | トークン種別のタグ。`id_token` は身元証明専用で `userinfo` を呼べない |

「業務権限は自社管理」：プラットフォームは「あなたが誰か」（身元）とプラットフォーム資源に対するプラットフォーム級権限のみを担い、アプリ内のメニュー／データ／機能権限はアプリが `sub` をもとに自前でモデリングします（アプリ内に `sub → 業務ロール` マッピング表の維持を推奨）。

## 5. セキュリティチェックリスト

- **state**：プラットフォームが必須化し、そのまま返却（CSRF 防御）。SDK は自動処理。直結実装では自前で生成・検証。
- **PKCE S256**：全クライアントに強制。`code_challenge` は 43–128 文字の base64url。
- **client_secret の保管**：アプリのバックエンドのみ（環境変数／KMS）。ローテーション入口はアプリ詳細の
  「SSO 設定（SSO 配置）」で、旧値は即時無効。
- **HTTPS**：redirect_uri は `https://` の任意ホストを許可。`http://` は内網アドレスのみ放行
  （`localhost`／`127.0.0.1`／`0.0.0.0`／`10.x.x.x`／`172.16-31.x.x`／`192.168.x.x`、内網 IPv6 ULA を含む）。完全内網導入では `APP_SSO_ALLOW_HTTP=1` で全 http ホストを解放できます。
- **マシン・ループバック自己完結**：バインド済みマシンクレデンシャルは、コールバックが全てループバックの
  SSO クライアントを自己発行・管理できます — 本機コールバックはマシンを跨がず、PKCE 強制下では第三者のコード横取りに利得がありません（RFC 8252 の考え方）。非ループバックは一律 human owner／管理者が必要で、`APP_SSO_MACHINE_LOOPBACK=0` で停止できます（操作は全て `app.sso.*` 監査）。
- **ログアウト連動**：アプリのログアウト時は `end_session` を呼んでください。呼ばないとログアウト後も
  アプリがサイレント更新できてしまいます。リダイレクト規則：明示の `post_logout_redirect_uri` は登録の登出ホワイトリストに一致する必要（不一致は拒否）。未指定の場合、登録が一つならそのアドレスへ、未登録または複数ならプラットフォームの登出ページに留まります。アカウント凍結・退職 → `userinfo` と`refresh` は即時拒否（ユーザー状態を実時検証）。
- **公開ゲート**：`web`／`h5` アプリは公開前にアクティブな SSO クライアントが必須。審批保留中にクライアントが
  無効化されると実行期の再検査で失敗します。

## 6. トークン TTL（デュアル TTL の妥協点）

| トークン | TTL | 説明 |
|---|---|---|
| プラットフォームコンソールセッション access | 30 分 | プラットフォーム自身のセキュリティ基線（refresh 7d ローテーション） |
| OIDC access token | 既定 2h（`OIDC_ACCESS_TTL_SECONDS`） | 妥協値：アプリのバックエンド／JWKS ローカル検証を主とする。長すぎると漏洩面が拡大、短すぎると userinfo 窓が細切れになる |
| OIDC refresh token | 既定 7d（`OIDC_REFRESH_TTL_SECONDS`） | 一回一換＋リプレイでチェーン全体失効。凍結／無効化／ログアウトで即時失効 |

## 7. secret／署名鍵のローテーション runbook

- **アプリ secret のローテーション**：アプリ詳細 → SSO 設定 → 「轮换 secret」→ 新値を一度だけ表示 →
  アプリ側の設定を更新（旧値は即時 401）。四半期ごと、または漏洩の疑いがあるときに実行を推奨。
- **プラットフォーム JWKS 署名鍵のローテーション**：**認証とトークン（认证与令牌）**→「轮换 OIDC 签名密钥」
  （`authn.oidc.write` が必要）。新鍵は即時署名、旧鍵は 24h の猶予内で検証と JWKS 公開を継続（進行中のトークンは切断されません）。SDK は `kid` で自動選鍵するためアプリの変更は不要です。
- **緊急対応**：トークン漏洩の疑い → クライアント無効化（認可／交換／更新が即時失敗、refresh チェーン失効） →
  secret ローテーション → 再有効化。

## 8. FAQ

- **本機デバッグ**：redirect_uri に `http://localhost:<port>/cb`、`http://127.0.0.1:<port>/cb`
  （または `http://0.0.0.0:<port>/cb`）を使えばホワイトリストを通過。issuer は既定のままで可。コンソール権限なしで、アプリのマシンクレデンシャルから直接 `POST /api/apps/:id/sso-client` で自己発行できます（§1）。
- **マルチ環境の issuer**：複数プラットフォーム環境と接続する場合は環境変数で issuer／client を切替注入。
  リダイレクトの `iss` パラメータと id_token の `iss` は mix-up 防御の検証に使えます。
- **id_token と userinfo の使い分け**：ログイン身元だけなら `id_token` の検証（ローカル JWKS）で十分。
  最新の組織／ロール／状態が必要なら `userinfo` を呼ぶ（実時検証で凍結も検知）。
- **コールバックで取れる roles は業務ロールか**：いいえ。`roles` はプラットフォーム治理ロールです。
  業務ロールはアプリ内で自前管理してください。

## 9. プラットフォーム直達（entry-ticket・OIDC 接続と相互補完）

コンソールの「アプリを開く／プラットフォーム身元でアプリを開く」は `attrs.url` への裸遷移ではありません。ログイン済みユーザーはまず一回限りの入場チケット（entry-ticket）を受け取り、`<url>#entry_ticket=<チケット>` でアプリを開きます。アプリのフロントエンドは fragment を読み取り、プラットフォームに兌換して身元を取得します：

```
POST /api/authn/entry-tickets/redeem          （公开端点，无须 Bearer）
body {"ticket":"etk_…"}
→ 200 { refType:"app", refId:"<应用ID>", identity:{ sub, username, name, org, roles, tenant } }
```

- OIDC 接続を**実装していない**アプリ／画面が改造ゼロでプラットフォーム身元を取得するのに適します。
  接続済みアプリへの影響はなく、両チャネルは並存します。チケットは一回限り（リプレイ拒否）、既定 120 秒で失効（`ENTRY_TICKET_TTL_SECONDS` で 30〜600 に調整可）、兌換時にアカウント状態を実時検証。発行と兌換の双方が監査（`app.entry.ticket.*`）に記録されます。
- 標準認可コードフローとの分担：**長期トークン／refresh／標準 RP セマンティクス**が必要なら `/oauth/authorize`
  （認可コード＋PKCE S256）。**単発の入場時身元**だけでよいなら entry-ticket（secret 不要・トークン交換不要）。
- **エラー時のリダイレクト**：認可失敗は一律 302 でプラットフォームのエラーページ（`/#/oauth/error`）へ遷移し、
  外部アドレスへは決してリダイレクトしません（オープンリダイレクト防御）。認可の拒否（`consent=false`）は標準どおり `error=access_denied` でリダイレクトします。

## 10. 全員名簿（組織データチャネル・サーバー間）

> 組織機能（組織ツリー／部門メンバー／責任者）だけで email が不要なアプリは、既定のマシン自己完結チャネル`GET /api/apps/<appId>/org-sync` を使ってください（管理者の追加 scope 不要、`?ifNoneMatch=` による変更なし軽量ポーリング対応）。詳細は中文原典 `docs/app-org-sync.md`。本節の名簿は email などより多くのフィールドが必要な场景向けです。

「全員填报」型の業務では、在職者の名簿が必要です。プラットフォームは権限で保護された名簿エンドポイントを提供し、アプリのバックエンドが**マシンクレデンシャル**で取得します（ユーザーログイン OIDC チャネルと補完関係：ログインは「単一の人が誰か」を、名簿は「全員が誰か」を解決します）：

```
GET /api/iam/roster          （Bearer 机器凭证令牌，须含 iam.roster.read 权限点）
→ 200 {
  generatedAt: "…",
  orgs:  [{ id, name, parentId, status, leaderUserIds: ["<平台用户ID>"] }],   // leaderUserIds 来自钉钉 dept_manager_userid_list 同步链
  users: [{ id, username, displayName, email, jobNumber, title,
            orgId, orgName, primaryOrgId?, status, accountType? }]
}
```

**接続の三ステップ**：①**マシンクレデンシャルの取得** — アプリ登録時に自動発行（`refType:'app'`）。管理者が**統合認証センター（统一认证中心）→ ID プリンシパル（身份主体）**で scope `iam.roster.read` を追加（scope 調整は既存トークンを連動失効させるため、再びトークン交換後に有効）。②**トークン交換** — `POST /api/auth/client-credentials`、body `{clientId, clientSecret}` → `token`（Bearer）。③**取得** — `GET /api/iam/roster`。填报周期に合わせた取得を推奨（組織変更は接続器の定时自動同期で入ります。高頻度ポーリングは避けてください）。

**契約の要点**：`users[].id` は userinfo の `sub` と同一の安定関連キー（名簿から配ったタスクとログインの身元が直接合致）。`orgs[].leaderUserIds` は各部門の責任者（DingTalk 同期）を示し、集計・承認者を自前の名簿なしで特定できます。PII 最小化：電話番号を含まず、退職（deactivated）アカウントは名簿に現れず、`status` は通常どおり返るため `active` のアカウントにのみタスクを配ってください。取得のたびに invoke 監査（誰がいつ何件取得したか）が記録され、越権アクセスは 403 ＋ `audit.authz.denied` が発火します。

> OIDC との分担の覚え方：**ログイン（§1〜§9）は「一人が来る」こと、名簿（本節）は「全員がいる」ことを扱う**。両者とも `id`／`sub` を唯一の関連キーとするため、アプリ内に `sub → 業務ロール` マッピング表を一枚作れば両チャネルを接続できます。

## 11. 訪問者指標の自動換算（プラットフォーム側）とビーコン（アプリ側）

プラットフォーム側は「SSO 身元での訪問」と「ページ閲覧」をアプリ指標へ自動換算するため、接続側が**何もしなくても DAU は取得できます**。一行のビーコン埋め込みで PV/UV も得られます。

### プラットフォーム側の自動換算（改造ゼロ）

| 訪問行為 | 換算 | 口径 |
|----------|------|------|
| entry-ticket 兌換（§9） | DAU +1 | プラットフォーム `sub` の同日重複除去 |
| OIDC 発码（認可ページでの確認。§1〜§2） | DAU +1 | プラットフォーム `sub` の同日重複除去 |
| ブラウザビーコン（下記） | PV +1／UV +1 | PV は毎回累加。UV は `vid` の同日重複除去 |

同日の複数訪問は集合として増えるのみで減らず、`recordUsage` の max／累加セマンティクスにより接続側の主動報告（`POST /api/apps/:id/metrics-report`）と自然に統合され、互いに上書きしません。

### アプリ側ビーコン（一行埋め込み。マシン認証不要・secret 不要）

ページ読み込み／SPA ルート切替時に一度報告すれば十分です（`<appId>` はアプリ ID＝`app_` 接頭辞の資源 ID）：

```html
<!-- 方式一：<img> 像素（最简，天然跨域） -->
<img src="http://<平台地址>/api/apps/beacon?app=<appId>&vid=<访客ID>" hidden alt="">
```

```js
// 方式二：fetch / sendBeacon（POST JSON；vid 缺省时平台按 IP+UA 哈希兜底）
const vid = localStorage['rq:vid'] ??= crypto.randomUUID().replace(/-/g, '') // 8-64 位 base64url
navigator.sendBeacon?.('/api/apps/beacon',
  new Blob([JSON.stringify({ app: '<appId>', vid })], { type: 'application/json' }))
```

- エンドポイントは公開（PUBLIC_PATHS）。応答は常に 1x1 GIF／`{ok:true}` — 未知のアプリにも同じ応答を返し、
  アプリの存在を洩らしません。`vid`：8〜64 文字の base64url 文字列。`localStorage` に永続化したランダム ID を推奨（同一ブラウザの同日は UV を一度しか計上しない）。任意の `uid`：アプリがプラットフォーム身元（entry-ticket の兌換で得た `sub` など）を知っている場合は付与すると UV/DAU の口径を揃えられます。
- 悪用防止：同一 IP×同一アプリで 60 回/分を計数し、超過分は静かに無視（応答は通常どおり）。
  CORS：`*` 放行（GET/POST/OPTIONS）。任意の entryUrl のフロントエンドから直接報告できます。
