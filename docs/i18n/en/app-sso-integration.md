# App Unified Identity Onboarding (App SSO) Integration Guide

> **English edition** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source: `docs/app-sso-integration.md` · Source baseline: 2026-10-15 · Glossary: [GLOSSARY.md](../GLOSSARY.md) · Governance: [README.md](../README.md)

> Audience: developers embedding the platform's unified identity into in-house enterprise AI applications (Web / H5 / mini-program / desktop / API services).
> This document ships with the service and can be read directly at `http://<platform address>/docs/app-sso-integration.md` (the `/docs` index page lists all published documents).
> Target path: **register the app → get credentials → integrate with the SDK one-liner per the spec → manage business permissions yourself**.

The platform acts as the enterprise's unified identity source (OIDC Provider). Once an app is onboarded:

- The user clicks "Log in" in the app → redirect to the platform authorization page → platform session or login panel (username/password or DingTalk passwordless login, shown/hidden according to the platform's connector configuration) → confirm consent → redirect back to the app with a `code`;
- DingTalk users do not need to log into the platform Console first: on the authorization page's login panel they can scan a DingTalk QR code for passwordless login (first-time identities go through the bind/register branch), then proceed straight to consent;
- The app backend exchanges `code` + `client_secret` for `id_token` / `access_token` (pure-frontend apps use PKCE instead);
- The app calls `userinfo` with the `access_token` to obtain the user identity (`sub` / organization / roles / tenant); **business permissions are the app's own responsibility**;
- If the account is frozen or offboarded on the platform → the app side fails on the very next `userinfo` / `refresh` call; no need to wait for token expiry.

## Interface language note

As of the 2026-10-16 release, the runtime interface (Console, Panel, authorization pages, error messages) ships with a built-in language switcher: Simplified Chinese (default), English (US), and Japanese. Switch via the top-bar selector; the preference is stored in the browser (`rq_lang`). The CLI follows `--lang` or `DSHCTL_LANG`. Any string not yet covered by a dictionary gracefully falls back to Chinese. The bilingual annotations (English name（中文原文）) used in this document remain useful for navigating screenshots and deployments pinned to Chinese.

## 1. Onboarding in five steps

| Step | Action | Where |
|---|---|---|
| 1. Register the app | AI Applications（AI 应用）→ Register App (form factor, access URL, orchestration Agent) | Console（控制台） |
| 2. Issue credentials | App details → SSO Configuration（SSO 配置）tab → Issue SSO Client (`client_id` + `client_secret`; the secret is displayed exactly once) | Console |
| 3. Go-live gate | `web` / `h5` apps cannot go live without an issued SSO client (tunable via `APP_SSO_ENFORCE`); the client's status is re-checked at approval execution time | Console + Approval Center（审批中心） |
| 4. App-side integration | Follow "SDK one-line integration" below, or connect to the endpoints directly — authorization code flow with mandatory PKCE S256 | App code |
| 5. Manage business permissions yourself | `userinfo`'s `sub` is the stable join key; map business roles inside the app | App code |

> **Loopback self-service (no Console needed)**: when the callback address is a local loopback (`127.0.0.1` / `localhost` / `0.0.0.0`), no owner/administrator has to visit the Console on the app's behalf — the app can self-issue the SSO client and retrieve `client_id` / `client_secret` using the machine credential automatically issued at registration (the response is shown only once):
>
> ```
> POST /api/apps/<app ID>/sso-client     (Bearer machine-credential token; the credential includes app.write by default)
> body {"redirectUris":["http://127.0.0.1:5000/oauth/cb"]}
> → 200 { clientId, clientSecret, redirectUris }
> ```
>
> Change callbacks with `PATCH` on the same path; rotate the secret with `POST …/rotate`; the issued configuration (discovery / client_id / callback list, without the secret) is in the `sso` block of `GET /api/apps/:id`. Machine self-service is limited to loopback callbacks; non-loopback callbacks (intranet IPs / public domains) still require the owner or an administrator in the Console (`APP_SSO_MACHINE_LOOPBACK=0` disables this self-service channel entirely).

## 2. SDK one-line integration (recommended)

### Backend / BFF (confidential client, the default form)

Node.js ([openid-client](https://github.com/panva/openid-client) v6 — the same library the platform self-tests with):

```js
import * as oc from 'openid-client'

// 1. One-line discovery-driven setup: just point issuer at the platform address
const config = await oc.discovery(
  new URL('https://sso.yourcompany.com'),        // OIDC_ISSUER (see below)
  process.env.SSO_CLIENT_ID,                     // client_id issued in the Console
  undefined,
  new oc.ClientSecretBasic(process.env.SSO_CLIENT_SECRET),
)

// 2. Login entry: build the authorization URL and 302 (state/PKCE are enforced by the platform)
const verifier = oc.randomPKCECodeVerifier()
const challenge = await oc.calculatePKCECodeChallenge(verifier)
const redirectTo = oc.buildAuthorizationUrl(config, {
  redirect_uri: 'https://your-app.com/auth/cb',  // must match the registered redirect_uris exactly
  scope: 'openid profile email',
  state: oc.randomState(), nonce: oc.randomNonce(),
  code_challenge: challenge, code_challenge_method: 'S256',
})

// 3. At the callback: exchange code for tokens (id_token signature already verified by the SDK via JWKS)
const tokens = await oc.authorizationCodeGrant(config, callbackUrl, {
  code_verifier: verifier, state, nonce,
})
const user = await oc.fetchUserInfo(config, tokens.access_token, tokens.claims().sub)
// user = { sub, name, preferred_username, email?, org: {id,name,tenantId}, roles, tenant }
```

- Silent renewal: `oc.refreshTokenGrant(config, tokens.refresh_token)` (rotation — one use each; replaying an old value revokes the whole chain).
- Logout linkage: `oc.buildEndSessionUrl(config, { id_token_hint, post_logout_redirect_uri, state })`; the platform also revokes that user's refresh chain under this app. When `post_logout_redirect_uri` is omitted and the client has registered exactly one logout redirect, the platform redirects there (passing it explicitly is still recommended; with multiple registered environments this fallback does not apply).
- Active revocation: `oc.tokenRevocation(config, tokens.access_token)` (RFC 7009).

### Pure-frontend SPA (public client — decision D-a: the public form factor is supported)

For H5 / SPA with no backend that cannot hold a secret: choose the **public** client type when issuing — no `client_secret`, **PKCE enforced**, **no refresh token issued** (when the access token expires, silently restart the authorization flow). A suitable frontend library is [oidc-client-ts](https://github.com/authts/oidc-client-ts):

```js
const mgr = new UserManager({
  authority: 'https://sso.yourcompany.com',       // platform discovery address
  client_id: 'oc-xxxxxxxx',                        // public client
  redirect_uri: 'http://localhost:5173/cb',        // localhost debug addresses pass the allowlist
  response_type: 'code', scope: 'openid profile',
  code_challenge_method: 'S256',                   // enforced by the platform
})
await mgr.signinRedirect()                          // login entry
const user = await mgr.signinRedirectCallback()     // at the callback; id_token already verified
```

> Security note: public clients expose a larger token surface; use them only for intranet tools / apps without sensitive data. Prefer confidential (BFF) wherever a backend is possible.

#### CORS (pure-frontend cross-origin calls — allowed by the platform out of the box)

When in-browser JS calls `POST /oauth/token`, `GET /oauth/userinfo`, `POST /oauth/revoke`, and the two discovery endpoints cross-origin, the platform automatically returns CORS allow headers — **no UI configuration needed**:

- Allowed origins = the origin (scheme://host:port) of each registered client `redirect_uri` ∪ the `OIDC_CORS_ORIGINS` environment variable (comma-separated, to append unregistered origins). Registering the callback `http://192.168.0.4:8092/cb` automatically allows `http://192.168.0.4:8092`.
- `OPTIONS` preflight is uniformly 204, with `Access-Control-Allow-Headers: authorization, content-type`; both success and error responses carry `Access-Control-Allow-Origin` (browsers can read error bodies).
- Unregistered origins get no allow headers (only `Vary: Origin`); the authorization first hop `/oauth/authorize` and logout `/oauth/end_session` are top-level browser redirects and do not involve CORS.

## 3. Endpoints and discovery

| Endpoint | Path |
|---|---|
| discovery | `GET /.well-known/openid-configuration` |
| JWKS public keys | `GET /.well-known/jwks.json` |
| Authorization | `GET /oauth/authorize` (302 to the platform authorization page) |
| Token exchange | `POST /oauth/token` (`client_secret_basic` / `client_secret_post`; both form-encoded and JSON accepted) |
| User info | `GET /oauth/userinfo` (Bearer access token) |
| Refresh | `POST /oauth/token` (`grant_type=refresh_token`; rotation, scope can only narrow) |
| Revocation | `POST /oauth/revoke` (RFC 7009; always 200) |
| Logout | `GET /oauth/end_session` (`id_token_hint` + `post_logout_redirect_uri`) |

**`OIDC_ISSUER` and intranet / HTTPS reverse proxies**: the default issuer is `http://127.0.0.1:<port>` — local debugging only. In production/intranet deployments you must declare the external address explicitly (behind a reverse proxy, this is the external domain matching the `x-forwarded-host` semantics):

```bash
OIDC_ISSUER=https://sso.yourcompany.com   # discovery/JWKS/endpoints are all built from this
```

Both the app and end-user browsers must be able to reach this address; the reverse proxy must pass through `/oauth/*`, `/.well-known/*`, and the SPA route `/#/oauth/*`. Note: changing the issuer invalidates `iss` checks on existing tokens — expected behavior (token lifetimes are short).

## 4. Claims contract

| claim / field | Semantics |
|---|---|
| `sub` | Platform user ID — **stable, never changes, the single join key** (use it for in-app account mapping; never use username) |
| `preferred_username` / `name` | Username / display name (can be renamed; never use as a primary key) |
| `email` | Returned only when the authorized scope includes `email` |
| `org` / `tenant` | The user's organization `{id,name,tenantId}` / tenant ID (multi-tenant separation reference) |
| `roles` | The user's platform-level role codes on the platform (`super_admin` etc.) — **platform governance roles, not the app's business roles** |
| `id_token.token_use='id'` / `access.token_use='access'` | Token-type tagging: `id_token` proves identity only and cannot call `userinfo` |

"Business permissions are the app's own responsibility": the platform answers "who are you" (identity) plus platform-level permissions over platform resources; in-app menu / data / feature permissions are modeled by the app on top of `sub` (maintain a `sub → business role` mapping table inside the app).

## 5. Security checklist

- **state**: mandatory and echoed back verbatim by the platform (CSRF protection); SDKs handle it automatically — generate and verify it yourself when connecting directly.
- **PKCE S256**: enforced for all clients; `code_challenge` is 43–128 chars base64url.
- **client_secret custody**: store it only in the app backend (environment variables / KMS); rotation lives in the app's SSO Configuration（SSO 配置）; the old value dies immediately.
- **HTTPS**: `redirect_uri` allows `https://` on any host; `http://` is allowed only for intranet addresses (`localhost` / `127.0.0.1` / `0.0.0.0` / `10.x.x.x` / `172.16-31.x.x` / `192.168.x.x`, including intranet IPv6 ULA). Purely intranet deployments may set `APP_SSO_ALLOW_HTTP=1` to allow all http hosts.
- **Machine loopback self-service**: a machine credential bound to the app can self-issue/manage SSO clients whose callbacks are all loopback — local callbacks never cross machines, so under enforced PKCE an intercepted code is worthless to a third party (RFC 8252 posture). Any non-loopback callback requires a human owner / administrator; `APP_SSO_MACHINE_LOOPBACK=0` disables the channel entirely (all operations audited under `app.sso.*`).
- **Logout linkage**: on app logout, call `end_session` so the platform revokes the user's refresh chain under this app (otherwise the app could silently renew after logout). Redirect rule: an explicit `post_logout_redirect_uri` must hit the client's registered logout allowlist (otherwise refused); when omitted and exactly one logout address is registered, that address is used; with none or multiple registered, the user stays on the platform logout page.
- **Freeze = instant invalidation**: freezing / offboarding a platform account → `userinfo` and `refresh` refuse immediately (user status checked in real time).
- **Gate**: `web`/`h5` apps must hold an active SSO client before going live; if the client is disabled while an approval ticket is pending, the execution-time re-check fails.

## 6. Token TTLs (dual-TTL compromise)

| Token | TTL | Notes |
|---|---|---|
| Platform Console session access | 30 min | The platform's own security baseline (refresh 7d, rotating) |
| OIDC access token | default 2h (`OIDC_ACCESS_TTL_SECONDS`) | Compromise: app backends verify locally via JWKS; too long enlarges the leak surface, too short fragments the userinfo window |
| OIDC refresh token | default 7d (`OIDC_REFRESH_TTL_SECONDS`) | One-time rotation + whole-chain revocation on replay; frozen/disabled/logged-out → immediately invalid |

## 7. Secret / signing-key rotation runbook

- **App secret rotation**: App details → SSO Configuration（SSO 配置）→ Rotate Secret（轮换 secret）→ the new value is shown once → update the app-side config (the old value 401s immediately). Recommended quarterly, or on suspected leakage.
- **Platform JWKS signing-key rotation**: Authentication & Tokens（认证与令牌）→ Rotate OIDC Signing Key（轮换 OIDC 签名密钥）(requires `authn.oidc.write`). The new key signs immediately; the old key stays valid for verification and published in JWKS for a 24h grace window (in-flight tokens do not drop). SDKs pick the key automatically by `kid` — no app changes needed.
- **Incident response**: suspected token leak → disable the client (authorization/exchange/refresh fail immediately, refresh chain revoked) → rotate the secret → re-enable.

## 8. FAQ

- **Local debugging**: use `http://localhost:<port>/cb`, `http://127.0.0.1:<port>/cb` (or `http://0.0.0.0:<port>/cb`) as `redirect_uri` to pass the allowlist; keep the issuer at the default `http://127.0.0.1:<port>`. Local integration needs no Console access: the app's machine credential self-issues via `POST /api/apps/:id/sso-client` (see §1 "Loopback self-service").
- **Multi-environment issuers**: when one app connects to several platform environments, inject different issuer/client per environment; the `iss` return parameter and the id_token `iss` can be used for mix-up defense.
- **id_token vs userinfo**: if you only need the login identity → verify `id_token` (local JWKS verification) and stop; if you need current organization/roles/status → call `userinfo` (real-time, and freeze-aware).
- **Are the returned `roles` business roles?** No. `roles` are platform governance roles; map business roles inside the app.

## 9. Platform direct entry (entry-ticket — complements app OIDC onboarding)

The Console actions Open Application / Open with Platform Identity（打开应用 / 带平台身份打开应用）no longer redirect naked to `attrs.url`: the logged-in user first collects a one-time entry ticket from the platform, then opens the app at `<url>#entry_ticket=<ticket>`; the app frontend reads the fragment and redeems it with the platform for the platform identity:

```
POST /api/authn/entry-tickets/redeem          (public endpoint; no Bearer required)
body {"ticket":"etk_…"}
→ 200 { refType:"app", refId:"<app ID>", identity:{ sub, username, name, org, roles, tenant } }
```

- Lets apps / UIs that have **not** done OIDC onboarding obtain platform identity with zero changes; apps already onboarded per this guide are unaffected — both channels coexist.
- Tickets are one-time (replay refused), expire after 120s by default (`ENTRY_TICKET_TTL_SECONDS`, adjustable 30–600), and account status is re-checked at redemption; both issuance and redemption are audited (`app.entry.ticket.*`).
- Division of labor vs the standard authorization-code flow: for **long-lived tokens / refresh / standard RP semantics** use `/oauth/authorize` (authorization code + PKCE S256); for **one-shot user identity at entry** use the entry-ticket (no secret, no token exchange; the app backend can integrate later).
- **Error redirects**: authorization failures always 302 to the platform error page (`/#/oauth/error`) and never redirect to an external address (open-redirect protection); declined consent (`consent=false`) redirects back with `error=access_denied` per standard.

## 10. Organization sync endpoint (org-sync; server-to-server)

> Apps that need organization structure only (org tree / department members / department leads) and do not need email can use the default machine-credential self-service channel `GET /api/apps/<appId>/org-sync` — no administrator scope grant needed, and it supports `?ifNoneMatch=` zero-payload change polling. See `docs/app-org-sync.md`. The roster below is for scenarios that need fuller fields such as email.

When an app runs "all-hands filing" style business, it needs an active-employee roster to assign tasks (who receives a filing task, who is the department summarizer). The platform provides a permission-protected roster endpoint that the app backend pulls with a **machine credential** (complementary to the user-login OIDC channel in §1–9: login answers "who is this one person", the roster answers "who does everyone belong to"):

```
GET /api/iam/roster          (Bearer machine-credential token; must include the iam.roster.read permission point)
→ 200 {
  generatedAt: "…",
  orgs:  [{ id, name, parentId, status, leaderUserIds: ["<platform user ID>"] }],   // leaderUserIds come from the DingTalk dept_manager_userid_list sync chain
  users: [{ id, username, displayName, email, jobNumber, title,
            orgId, orgName, primaryOrgId?, status, accountType? }]
}
```

**Three onboarding steps**:

1. **Get the machine credential**: issued automatically at app registration (`refType:'app'`); an administrator adds the scope `iam.roster.read` to the credential in Unified Authentication Center（统一认证中心）→ Identity Principals（身份主体）(changing scopes revokes existing tokens in cascade; it takes effect after the next token exchange).
2. **Token exchange**: `POST /api/auth/client-credentials`, body `{clientId, clientSecret}` → `token` (Bearer).
3. **Pull**: `GET /api/iam/roster`. Pull on the filing cadence (org changes are synced into the platform automatically by the connector on a schedule — see the README's "connector scheduled sync"); do not poll at high frequency.

**Contract highlights**:

- `users[].id` is the `sub` of userinfo — **the same stable join key**; roster-assigned tasks line up directly with identities flowing back from login;
- `orgs[].leaderUserIds` gives each department's leads (synced from the DingTalk "department manager" field), so the app can identify summarizers/approvers without building its own lists;
- PII minimization: no phone numbers; deactivated accounts never appear in the roster; `status` is returned as-is — apps should only assign tasks to `active` accounts;
- Every pull writes an invoke audit record (who pulled how much, when); unauthorized access gets 403 and raises `audit.authz.denied`.

> Memory hook for the division of labor: **login (§1–9) handles "one person arrives"; the roster (this section) handles "everyone exists"**. Both channels join on the user `id`/`sub`; one `sub → business role` mapping table in the app stitches the two together.

## 11. Visitor metrics auto-conversion (platform side) and beacon instrumentation (app side)

The platform automatically folds "SSO-identified visits" and "page views" into app metrics — integrators get DAU with zero effort; one line of beacon instrumentation adds PV/UV.

### Platform-side auto-conversion (zero changes)

| Visit behavior | Conversion | Rule |
|---|---|---|
| entry-ticket redemption (§9) | DAU +1 | Deduplicated per platform `sub` per day |
| OIDC code issuance (consent confirmed on the authorization page, §1–2) | DAU +1 | Deduplicated per platform `sub` per day |
| Browser beacon (below) | PV +1 / UV +1 | PV accumulates per hit; UV deduplicated per `vid` per day |

Multiple same-day visit signals only add, never subtract; they merge naturally via `recordUsage`'s max/accumulate semantics with proactive reporting (`POST /api/apps/:id/metrics-report`) — neither overwrites the other.

### App-side beacon (one line; no machine auth, no secret)

Report once per page load / SPA route change (`<appId>` is the app ID, i.e. the `app_`-prefixed resource ID):

```html
<!-- Option 1: <img> pixel (simplest; cross-origin by nature) -->
<img src="http://<platform address>/api/apps/beacon?app=<appId>&vid=<visitor ID>" hidden alt="">
```

```js
// Option 2: fetch / sendBeacon (POST JSON; when vid is omitted the platform falls back to an IP+UA hash)
const vid = localStorage['rq:vid'] ??= crypto.randomUUID().replace(/-/g, '') // 8-64 char base64url
navigator.sendBeacon?.('/api/apps/beacon',
  new Blob([JSON.stringify({ app: '<appId>', vid })], { type: 'application/json' }))
```

- The endpoint is public (PUBLIC_PATHS) and always returns a 1x1 GIF / `{ok:true}` — unknown apps get the same response, so the endpoint does not reveal app existence;
- `vid`: 8–64 char base64url string; recommended a persistent random ID in `localStorage` (one UV per browser per day);
- Optional `uid`: when the app knows the platform identity (e.g. the `sub` redeemed from an entry-ticket), send it to align UV/DAU accounting;
- Abuse control: per IP per app, counted within 60 requests/minute; over-limit hits are silently ignored (responses still succeed, so pages are unaffected);
- CORS: `*` allowed (GET/POST/OPTIONS) — any entryUrl frontend can report directly.
