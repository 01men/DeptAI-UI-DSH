# YuanBingKe (ybkk-AIOS) — Functional User Guide

> **English edition** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source: root README.md + docs/* (see Governance) · Source baseline: 2026-10-15 · Glossary: [GLOSSARY.md](../GLOSSARY.md) · Governance: [README.md](../README.md)

---

## 0. About this guide

### 0.1 What this guide covers

**YuanBingKe**（元冰可, product code `ybkk-AIOS`）is a self-hosted Enterprise AI Resource Management Platform built on the DeepSeek Harness (DSH) "Everything is a plugin" architecture. It brings six asset types — MCP services, Skills, Agents, AI applications, model routes, and NAS file storage — under one identity system (IAM / OIDC SSO), one permission model, one usage-metering pipeline, and one audit trail.

This is the comprehensive functional usage guide: it explains, domain by domain, what the platform does today, which roles operate it, and how to drive it through the web interfaces, the REST API, and the CLI (`node cli/dshctl.mjs`). Commercial positioning (pricing by "team + domain assets"; private project-based delivery for manufacturing customers) is out of scope here; see the product introduction for that.

One commercial boundary up front (M0 policy): the platform presents **usage transparency and internal cost pass-through only**. There is no charging, settlement, or wallet semantics anywhere in the product; the price book is a zero-price snapshot (`charge` is always 0) plus an internal procurement cost reference.

### 0.2 Audience and role model

The platform ships built-in roles. In demo mode (`DEMO_SEED=1`) the following evaluation accounts are seeded (all with password `Ybk@2026` — **demo environments only; never enable `DEMO_SEED` in production**):

| Demo account | Role | Typical scope |
|---|---|---|
| `admin` | Platform super admin | Full platform (permission wildcard `*`) |
| `ops` | Resource admin | MCP / Skill / Agent / AI application operations |
| `hr` | Org admin | Organization tree, accounts, third-party sync |
| `dev` | Developer | Skill submission, Agent registration |
| `audit` | Auditor (read-only) | Audit logs and alerts |

Beyond the five seeded roles, everyday **business members** (department staff with the `panel.read` permission point, typically DingTalk-synced) work in the department Agent workbench Panel rather than the Console. In the NAS data-permission domain, roles (platform lead P / department lead D / team lead T / member M / cross-domain contributor C) are **derived automatically from the organization tree**, not assigned by hand — see Section 12.3.

Pick your reading path by role:

- Super admin / resource admin: Sections 1, 4, 5, 9, 11, 12, 13.
- Org admin: Sections 1.2, 2, 3, 10, 11.
- Developer: Sections 4–6, 7, 14.
- Auditor: Sections 10, 11.
- Business member / team lead: Sections 6.4, 7, 14, 15, 16.

### 0.3 Interface language note

As of the 2026-10-16 release, the runtime interfaces — Console, Panel, Portal, CLI output, notifications, approval texts, and error messages — ship with a built-in language switcher: Simplified Chinese (default), English (US), and Japanese. Switch via the top-bar selector; the preference is stored in the browser (`rq_lang`). The CLI follows `--lang` or `DSHCTL_LANG`. Any string not yet covered by a dictionary gracefully falls back to Chinese. Two habits from this guide remain useful:

1. **Bilingual annotations in this guide**: every UI location cited here is written as *English name（中文原文）*, so you can match the English name against the Chinese label on screen. On first mention an item carries its Chinese original; later mentions use the English name only.
2. **Browser page translation**: the Console and Panel are standard web SPAs and translate acceptably with your browser's built-in page translation; treat translated protocol keys with care (see conventions below).

Where no UI path is documented, this guide deliberately navigates by REST endpoint (`/api/...`) and CLI command instead of inventing menu paths.

### 0.4 Conventions

- **Bilingual UI names**: English name（中文原文）on first mention, e.g., **Organization & Accounts（组织与账号）**.
- **ASCII protocol keys are never translated**: event names (`platform.update.available`, `flow.*`), permission points (`iam.user.write`, `workforce.read/write/admin/invoke`, `platform.update.read/apply`, ...), error codes, the API envelope fields (`ok` / `data` / `error`), environment variables (`ADMIN_PASSWORD`, `USAGE_RETENTION_DAYS`, ...), browser storage keys, commands, REST paths, and code blocks stay verbatim. These are cross-system machine contracts. The Chinese authority glossary for every key is `docs/协议键中文对照总表.md`; this guide may paraphrase meanings in English but never rewrites a key.
- **API envelope**: all `/api/*` endpoints answer `{ ok: true, data: ... }` on success and `{ ok: false, error: { code, message, ... } }` on failure. Error codes are ASCII (for example `FORBIDDEN`, `VERSION_CONFLICT`, `TOO_FREQUENT`). Unmatched `/api/*` routes return 401 for anonymous callers by design (the auth middleware runs before routing); this is intentional and not a route-existence side channel.
- **Dates and numbers**: prose uses en-US style (October 15, 2026); technical contexts use ISO 8601 (2026-10-15). Platform logs use server-local time; convert time zones when comparing.
- **Honesty rules**: only implemented features are described; planned work is explicitly labeled **Roadmap**. Performance and test counts (selftest, drill) are quoted "as of the latest run" — historical counts are void.
- **Login for all examples**: `POST /api/auth/login` returns a Bearer token used as `authorization: Bearer <token>` on subsequent calls. CLI credentials are supplied via `DSHCTL_USER`/`DSHCTL_PASS` or `DSHCTL_TOKEN`, with `DSHCTL_URL` pointing at the platform (default `http://127.0.0.1:7300`).

```bash
curl -s -X POST localhost:7300/api/auth/login -H 'content-type: application/json' \
     -d '{"username":"admin","password":"<your-password>"}'
curl -s localhost:7300/api/overview -H "authorization: Bearer <token>"
```

---

## 1. Platform administration

### 1.1 First boot and baseline initialization

Requirements: Node >= 22.6 (native TypeScript execution, no build step). Start with `npm install && npm start` (default `http://127.0.0.1:7300`) or install as a DSH plugin: `dsh plugin --profile web add github:01men/ybkkasi` (25 plugin entries in one command; the data plane mounts under the `/rq` prefix on the dsh web port).

On first boot against an empty data directory the platform performs **baseline initialization** (the production posture): built-in roles + root organization + platform admin `admin`, with zero demo business data. The startup log shows a "baseline initialization complete" banner and a first-run checklist. Health check:

```bash
curl -s http://127.0.0.1:7300/api/health     # → {"status":"ok",...}
curl -s http://127.0.0.1:7300/api/platform/bootstrap
```

`GET /api/platform/bootstrap` reports `initialPasswordPending:true` while the one-time initial-password file still exists on the server (see 1.2). First-run guidance covers the three go-live steps. For a full deployment runbook (systemd unit, port guard, reverse proxy, backup), see [deploy-enterprise.md](deploy-enterprise.md).

**Demo mode**: `DEMO_SEED=1 npm start` injects a demo organization tree, demo accounts, MCP/Skill/Agent/app samples, and 28 days of history. Use it for evaluation and training only.

### 1.2 Admin password management

- The `admin` password is taken from the `ADMIN_PASSWORD` environment variable. If unset, a random password is generated once, written to `data/admin-initial-password.txt`, and printed in the startup log — log in and secure it immediately, then delete the file (the login page shows a yellow first-deployment banner while the file exists).
- Change the password in the Console via the avatar menu at the top right → change password（右上角头像 → 修改密码）.
- Forgot the password: either wipe the data directory and restart, or have an administrator holding `iam.user.write` reset it under **Organization & Accounts（组织与账号）→ Account Details（账号详情）→ Reset Password（重置口令）**.

### 1.3 Roles and the permission-point model

Authorization is a **permission-point matrix**: roles are named sets of permission points; every guarded REST route checks a specific point, and a missing point yields 403 plus an `audit.authz.denied` audit record. Wildcards expand per domain (`iam.*`, `mcp.*`, `nas.*`, `connector.*`, `authn.oidc.*`); `*` is the super-admin wildcard. Built-in roles' point sets cannot be edited; custom roles are created from the catalog (and can be deleted via the dedicated DELETE route when no longer mounted).

Selected permission points (illustrative subset; the authoritative catalog with all points and Chinese semantics is `docs/协议键中文对照总表.md`):

| Permission point | Governs |
|---|---|
| `console.login` | Baseline console access; every built-in role carries it |
| `iam.org.read` / `iam.org.write` | View / manage the organization tree |
| `iam.user.read` / `iam.user.write` / `iam.user.freeze` | View accounts; create/update/reset password; freeze/deactivate (freeze revokes all tokens) |
| `iam.role.write` | Create/edit custom roles |
| `iam.connector.write` | Register/configure third-party connector instances |
| `iam.scene.write` | Scene-level authorization policies |
| `iam.roster.read` | Pull the all-staff roster API |
| `authn.principal.write` | Manage machine credentials (scopes, rotation) |
| `authn.oidc.read` / `authn.oidc.write` | View / manage OIDC clients and signing keys |
| `mcp.service.deploy` / `mcp.service.offline` | Deploy/canary releases; take services offline |
| `mcp.permgroup.write` | Manage MCP permission groups |
| `mcp.invoke` | Call MCP gateway tools |
| `skill.submit` / `skill.approve` / `skill.publish` / `skill.storage.write` | Skill pipeline and package backend |
| `agent.write` / `agent.approve` / `agent.offline` / `agent.a2a.invoke` | Agent lifecycle and A2A calls |
| `app.write` / `app.offline` | App lifecycle and metrics reporting |
| `nas.read` / `nas.write` / `nas.authz.check/read/write` | NAS assets and data-permission plane |
| `connector.gateway.write` / `connector.connection.write` / `connector.invoke` / `connector.permgroup.write` / `connector.runs.read` | Connector plane |
| `usage.read` / `usage.write` / `usage.admin` | Metering: reports / event ingestion / price book & reconciliation |
| `modelgw.read` / `modelgw.invoke` / `modelgw.admin` | Model gateway: view / invoke / catalog & budgets |
| `flow.read` / `flow.write` / `flow.admin` | Workflow orchestration |
| `audit.read` / `audit.rule.write` / `approval.read` / `approval.decide` | Audit and approvals |
| `connect.manage` | Remote dsh enrollment codes and clients |
| `platform.update.read` / `platform.update.apply` | View/check updates; perform upgrades |
| `workforce.read/write/admin/invoke/accept` | Digital worker domain (Section 15) |
| `panel.read/write/task.write/config.write`, `scenegraph.read/activate` | Department panel and industry scenegraph |

Multi-tenancy note: the `/api/agents`, `/api/apps`, `/api/iam/orgs(/tree)`, and `/api/approvals` lists are scoped to the caller's organization subtree (`*` exempt; machine principals resolve via their owning Agent; explicit `?org=` crossing the boundary returns 403).

### 1.4 Third-party login connectors (DingTalk)

Third-party login runs through connector instances registered under **Organization & Accounts（组织与账号）→ Third-party Integration（三方集成）**. The DingTalk connector supports real OpenAPI mode (`mode: real` + `apiBase`) and an explicitly labeled mock mode for demos.

- **Demo mode**: with `DEMO_SEED=1`, DingTalk passwordless login is available via the mock connector — on the login page choose **DingTalk scan（钉钉扫码）** and enter employee ID `DD0002` (a seeded demo employee). Production baseline initialization configures no connector, so the third-party login entry hides automatically.
- **Multi-entity**: the same DingTalk platform can serve multiple corporate entities (each with its own corpId/appKey/appSecret). Instances are addressed by id, unique per `provider|corpId`; REST: `POST /api/iam/connectors` to create, `DELETE /api/iam/connectors/:id` to delete (`iam.connector.write`). Each instance has a display `name` and a `targetOrgId` (sync-tree root; empty = platform root).

### 1.5 Security response headers

All HTTP responses carry security headers by default (`nosniff`, `SAMEORIGIN` framing, `Referrer-Policy`). Set `SECURITY_HEADERS=off` to disable — for example behind a reverse proxy that already sets them.

### 1.6 Platform self-update

Both installation forms (GitHub source checkout; dsh plugin marketplace bundle) can detect upstream releases. **Whether to upgrade is always the administrator's decision.**

- **Automatic check**: by default every 24 h (first check 15 s after startup), comparing the remote `package.json` version plus a GitHub commit diff. A new version raises an **Update available（可更新）** badge in the Console top bar and broadcasts `platform.update.available` (audited). The **Platform Update（平台更新）** drawer lets you toggle auto-check or change the cadence.
- **Manual upgrade**: from the badge drawer, **One-click upgrade（一键升级）** — for source installations it runs `git pull --ff-only` + `npm install`, supports a dry-run preview, records the reason, and prompts for a restart; uncommitted local changes fail safely rather than being overwritten. CLI equivalents:

```bash
DSHCTL_USER=admin DSHCTL_PASS=*** node cli/dshctl.mjs update status
node cli/dshctl.mjs update check
node cli/dshctl.mjs update apply --dry-run
node cli/dshctl.mjs update apply --reason="monthly upgrade"
# then restart the service (e.g., systemctl restart ops-platform) and run npm run selftest before switching traffic
```

Agent tools `update_status` / `update_check` / `update_apply` expose the same flow in conversation. Bundle installations get pointed at `dsh plugin update github:01men/ybkkasi` on the dsh host. Events: `platform.update.available`, `platform.update.applied`, `platform.update.rolled_back` (failed or manually rolled-back upgrades reset to the pre-upgrade commit).

- **Intranet / rate limits**: `GITHUB_TOKEN` raises the GitHub API quota; `DSH_UPDATE_API_BASE` / `DSH_UPDATE_RAW_BASE` point the checker at a private mirror; `DSH_UPDATE_AUTO_CHECK=off` disables automatic checks. Permission points: `platform.update.read` (view/check), `platform.update.apply` (upgrade).
- **Supply-chain hardening (optional)**: register a release public key and enable `requireSignedManifests` via `POST /api/update/settings` so upgrade manifests must carry an Ed25519 signature (register the key before enabling; the API rejects the reverse order).

---

## 2. Identity & access management (IAM)

### 2.1 Organization tree, accounts, roles, user groups

IAM provides a multi-level **organization tree（组织树）** with batch import, an account state machine (freeze emits `iam.user.frozen`, which revokes all tokens immediately; reactivate emits `iam.user.activated`), static and dynamic **user groups（用户组）**, and the permission-point matrix (Section 1.3). Deleting custom roles, deactivated accounts, and budget rules is supported via dedicated DELETE routes; built-in roles and mounted roles are refused.

Organizational changes propagate by events (`iam.org.changed`, `iam.permission.changed`) so every plugin's caches invalidate consistently.

### 2.2 Scene-level authorization (sceneCode)

Beyond role permissions, IAM supports **scene-level authorization（场景级授权）** on `sceneCode`: policies evaluate deny rules first, then allow rules, and **fail closed** when evaluation cannot complete. The chain covers the whole platform including the Panel task-creation entry (wired in the 2026-10-15 batch). Manage policies with `iam.scene.write`; changes emit `iam.scene_policy.changed`.

### 2.3 Organization data channels: roster and app org-sync

Two read-only channels let integrated applications reuse the platform's organization data:

**All-staff roster** — `GET /api/iam/roster` (machine credential holding `iam.roster.read`; org admins have it via the `iam.*` wildcard; app credentials get it granted by an admin under **Unified Authentication Center（统一认证中心）→ Identity Principals（身份主体）**):

```
GET /api/iam/roster
→ { generatedAt,
    orgs:  [ { id, name, parentId, status, leaderUserIds } ],   // leaderUserIds from the DingTalk dept_manager_userid_list sync
    users: [ { id, username, displayName, email, jobNumber, title,
               orgId, orgName, primaryOrgId, status, accountType } ] }
```

- `users[].id` equals the OIDC `sub` — one stable join key between "who is logging in" and "who exists".
- PII minimization: no phone numbers; deactivated accounts are excluded; every pull writes an invoke audit record (who pulled, when, how many).

**App org-sync** — `GET /api/apps/:id/org-sync`: an application pulls the org tree + active members using its own bound machine credential (no extra scope needed). Returns `orgs[]` (with `leaderUserIds`, `order`, `updatedAt`) and `users[]` (`id` = `sub`; no phone/email). A content-hash `version` plus `?ifNoneMatch=` enables zero-payload change polling; each pull is audited (`app.org-sync.pull`). Use this when an app only needs org structure; use the roster when it needs email and the full all-staff list.

### 2.4 DingTalk scheduled sync

Directory sync no longer depends on manual button clicks. Each connector instance's **Sync frequency（同步频率）** (minimum 5 minutes to protect DingTalk quota; **0 = manual only**) is serviced by a per-minute patrol timer that runs due syncs; the actor is recorded as `auto-sync` vs manual, one failing config does not block others, and results land in `lastSyncResult`. Set `IAM_CONNECTOR_AUTO_SYNC=off` to disable the timer entirely (then trigger manually via `POST /api/iam/connectors/auto-sync`, `iam.connector.write`). The Console connector card distinguishes "automatic" vs "manual-only" configurations.

---

## 3. Authentication & SSO

Full developer-facing integration steps live in the sibling guide [app-sso-integration.md](app-sso-integration.md); this section is the operator's overview.

### 3.1 Dual-track identity and platform sessions

Humans and machines are two tracks of one identity system. Human login issues short-lived HMAC access tokens (Console session: 30 minutes) plus a rotating refresh token (7 days; rotation is one-time — replaying an old refresh token revokes the whole chain). Machine principals use Client Credentials (`POST /api/auth/client-credentials` with `clientId`/`clientSecret`).

Brute-force protection: login, Client Credentials, SSO binding, and OIDC authorize/token exchanges all feed a failure lockout — 5 failures within a 15-minute window locks the source (escalating up to 24 h), the counter is persisted across restarts, and each trigger raises an alert. Auth-critical collections fsync on write; corrupt JSON files are quarantined as `*.corrupt-*` with an explicit alert instead of being silently treated as empty.

### 3.2 OIDC Provider capabilities

The platform is the enterprise OIDC Provider:

- Signing: RS256 with a published JWKS; discovery at `/.well-known/openid-configuration`; `kid`-based key selection. Key rotation keeps the old key in a 24-hour verification grace window (in-flight tokens stay valid). Rotate under **Authentication & Tokens（认证与令牌）→ Rotate OIDC signing key（轮换 OIDC 签名密钥）** (`authn.oidc.write`).
- Authorization-code flow with **PKCE S256 forced** for all clients; scope whitelist `openid profile email`; one-time codes (5-minute TTL); `state` enforced and echoed; authorization failures redirect to a platform error page — never to an external `redirect_uri` (open-redirect protection).
- Token exchange: `client_secret_basic` and `client_secret_post`, form or JSON encoding; `id_token` vs `access_token` distinguished by the `token_use` claim; `userinfo` trims the email claim by scope.
- **Refresh rotation**: one-time refresh tokens; scope can only narrow; user status is re-checked in real time.
- **Logout and revocation**: `/oauth/end_session` (with `id_token_hint` and a `post_logout_redirect_uri` whitelist) also revokes the user's refresh chains for that client; `/oauth/revoke` implements RFC 7009 and always answers 200.
- Freezing or deactivating an account invalidates its tokens and SSO flows immediately.
- TTLs: OIDC access token default 2 h (`OIDC_ACCESS_TTL_SECONDS`), refresh default 7 d (`OIDC_REFRESH_TTL_SECONDS`); entry authorization requests/codes 5 minutes. Declare the external address with `OIDC_ISSUER` in production (behind a reverse proxy, issuer must be the external URL).

`public` clients (pure SPAs) are supported: no secret, forced PKCE, no refresh token. CORS for `POST /oauth/token`, `GET /oauth/userinfo`, `POST /oauth/revoke` and the discovery endpoints is granted automatically to the origins of registered `redirect_uri`s (plus `OIDC_CORS_ORIGINS`).

### 3.3 App go-live gate and owner self-service

- **Go-live gate（应用上线门禁）**: `web`/`h5` apps cannot go online without an active SSO client (`APP_SSO_ENFORCE`, default `web,h5`). The check runs twice: early feedback at submission (the approval ticket snapshots `ssoClientId`) and again at approval execution — a client disabled while the ticket is pending fails the go-live with an audit record. A stricter mode (`APP_SSO_ENFORCE=oidc`) demands a real OIDC client. Agents have an analogous gate (`AGENT_SSO_ENFORCE`, default on): an OIDC client, a registered `entryUrl`, or a `headless` declaration (no UI, pure background — passes on the issued machine credential) satisfies it.
- **Owner self-service issuance**: in the Console, an app's details page has an **SSO Configuration（SSO 配置）** tab where the owner issues a client (`client_secret` shown once), edits callback URIs inline, rotates the secret (old value invalid immediately), disables/enables, and copies the discovery URL. `GET /api/apps/:id` carries the `sso` block. Owner-based authorization is `app.ownerId === userId` (human) or holding `authn.oidc.write`; machine callers always get 403.
- **Loopback machine self-service**: for callbacks on `127.0.0.1`/`localhost`, the app's own machine credential can issue and manage its SSO client without an admin:

```
POST /api/apps/<appId>/sso-client        # body {"redirectUris":["http://127.0.0.1:5000/oauth/cb"]}
→ 200 { clientId, clientSecret, redirectUris }   # secret shown only here
```

Non-loopback callbacks still require a human owner/admin. `APP_SSO_MACHINE_LOOPBACK=0` disables this channel entirely.

### 3.4 DingTalk passwordless login and entry tickets

- **DingTalk passwordless login（钉钉免密登录）** works on the login page and inside the OIDC authorization page's login panel (the DingTalk entry shows per the connectors registered at `/api/auth/providers`). First-time identities flow through binding/registration branches; DingTalk users complete SSO without ever visiting the Console.
- **Entry tickets**: for apps without OIDC integration, the Console's "open app" flow hands over a one-time ticket: the app reads `#entry_ticket=` from the URL fragment and redeems platform identity at the public endpoint

```
POST /api/authn/entry-tickets/redeem     # body {"ticket":"etk_…"}
→ { refType:"app", refId:"…", identity:{ sub, username, name, org, roles, tenant } }
```

Tickets are one-time (replays rejected), default 120 s TTL (`ENTRY_TICKET_TTL_SECONDS`, 30–600), and redeem-time re-checks account status. Logged-in users can mint a **self** ticket via `POST /api/auth/entry-tickets/self` (hard cap 120 s) to return to a local panel after a remote login. Entry-ticket redemptions and OIDC code issuance automatically fold into app DAU (Section 6.4).

**claims contract (short form)**: `sub` is the stable unique key; `roles` are platform governance roles, not app business roles — business authorization is the app's own job (recommended pattern: a `sub → business role` mapping; see [app-rbac-guide.md](../../app-rbac-guide.md) for a validated reference construction).

---

## 4. MCP services

### 4.1 Deployment lifecycle

MCP services move through **draft → validate → canary → full rollout（草稿→验证→灰度→全量）**. Releases are **immutable（版本不可变）**; rollback is one click, and the rollback target is validated (the current version and already-rolled-back versions are rejected as targets). Taking a service offline is a reason-mandatory operation that defaults to an L4 approval ticket; approval emits `mcp.offlined` and revokes the service credential.

External services register from mcpServers JSON — the same shape Claude Desktop/Cursor use — via `POST /api/mcp/import` (CLI `dshctl mcp ...`; `autoDeploy` defaults to true, which validates and deploys at 100% canary automatically). Tool lists refresh from the remote `tools/list` via `POST /api/mcp/services/:id/sync-tools`. Only remote HTTP-family transports (`streamableHttp`/`http`/`sse`) are accepted; stdio forms are rejected with a reason. The execution layer runs real HTTP JSON-RPC (`exec: real`); `exec: demo` is an explicitly labeled deterministic demo transport that is never metered and excluded from SLOs.

### 4.2 Token gateway and invocation

Every MCP invocation passes a **token gateway（令牌网关）**: unified authentication, MCP permission groups (per-service policy maps with tool whitelists and read-only constraints), rate limiting, and circuit breaking. Invocation requires the caller's subject to match a group whose policy covers the target tool. Registered tools number 82, and every one declares its minimal permission point; the `console.login` baseline on `/mcp tools/call` exists only as a fail-safe for tools missing a declaration, not a substitute for per-tool minimal permissions.

```bash
curl -s -X POST localhost:7300/api/mcp/invoke -H "authorization: Bearer <token>" \
     -H 'content-type: application/json' \
     -d '{"serviceId":"mcp_srv_xxxxxxxx","tool":"execute_action","args":{}}'
# → {"ok":true,"status":"ok","latencyMs":…,"version":"v…","result":…}
```

### 4.3 Health, circuit breaking, monitoring

A background probe rounds every 30 s; **3 consecutive failures open the circuit** (`mcp.unhealthy`, invoke refused, audited) and business success half-closes it again. Real call failures and probe failures share one consecutive-failure counter. The invoke monitor tracks P95 latency, success rate, and tokens per service.

### 4.4 Tool risk registration

Tools discovered from a remote `tools/list` are no longer trusted by default. Write capability requires an explicit **risk registration → review → effective** flow (service + tool granularity: risk level, registrant, approval reference, effective version). Unregistered tools are treated as `unknown`: write actions are refused, read actions may pass under read-only constraints. Existing services surface a re-review list. This closes the "unknown remote tool" risk (V11) end to end.

---

## 5. Skills (Skill Marketplace)

### 5.1 Submission, scanning, two-tier approval

The pipeline is **submit → static scan → two-tier approval → versioned publishing（提交→静态扫描→两级审批→版本化上架）**:

- **Static scanning** auto-rejects submissions containing malicious code patterns or leaked secrets.
- **Two-tier approval（两级审批）**: a domain review and a security review; one person may complete both sequentially (the platform does not force two distinct approvers, but the L4 guardrails still apply to lifecycle operations).
- Approval emits `skill.submitted` / `skill.published`; deprecation (`skill.deprecated`) requires a reason, persists it, and alerts agents that reference the skill.

```bash
node cli/dshctl.mjs skill submit --name=<name> --content-file=SKILL.md --package=skill.zip
```

### 5.2 Package storage and NAS direct upload

The package backend is configurable via `GET/PUT /api/skill-storage` (`skill.storage.write`) as `local | nas` (referencing an onboarded NAS asset plus `basePath`; credentials are not re-entered). On publish, an attached package uploads as-is; without one, the platform packs `SKILL.md` on the fly with a zero-dependency ZIP packer and pushes it through the file gateway. **Fail-closed**: an upload failure fails the publish. Deployment constraint: `fs_upload` reads local paths inside the gateway process, so the platform and gateway must share a machine or a mounted `stagingDir`.

Metering: skill downloads/installs and file operations feed the usage pipeline as `skill:<ID>` events (`calls`/`bytes` meters; IDs rather than slugs because Chinese slugs fail the resource-key validation). The Skill Marketplace page also shows a **usage heatmap card** (skill × day matrix; `GET /api/skills/usage-heatmap`).

### 5.3 Marketplace plugins and Ed25519

Third-party and first-party plugins go through the plugin market: a five-face contract (`plugin.yaml` + api/permissions/events/ui manifests), **Ed25519 contract signature verification（契约验签）**, content scanning, approval-gated listing/install/uninstall, and a zero-price metering declaration. The CLI scaffolds a plugin with a publisher keypair, signs, and submits:

```bash
node cli/dshctl.mjs plugin init --id=com.demo.hello --dir=./my-plugin
node cli/dshctl.mjs plugin sign --dir=./my-plugin && node cli/dshctl.mjs plugin submit --dir=./my-plugin
```

---

## 6. Agents and AI applications

### 6.1 Registration and machine credentials

Registering an Agent (or an AI application) issues a **machine credential（机器凭证）**. Agent credentials default to scopes including `mcp.invoke`, `skill.read`, `agent.read`, `usage.write` (so self-reported metering works out of the box), and `connector.invoke`. Agents carry a three-group attribute sheet (basic / technical / governance), user binding, and lifecycle L4 gates.

### 6.2 Credential governance

Machine credentials are first-class governance objects, manageable from three surfaces (Console **Authentication & Tokens（认证与令牌）** principals table; CLI; tools):

```bash
node cli/dshctl.mjs credential list                        # inventory: principalId/scopes/active tokens
node cli/dshctl.mjs credential scopes <principalId> --scopes=agent.read,usage.write
node cli/dshctl.mjs credential rotate <principalId>        # clientId unchanged; old secret dead; new value shown once
```

- Scope adjustments must hit the permission catalog exactly (or be exactly `['*']`); adjustments and rotations **revoke all outstanding tokens** (token scopes are issue-time snapshots), so the tightening takes effect.
- Listings and governance responses never emit `clientSecretHash`.
- Machine-identity reads of the Agent ledger (`GET /api/agents`) are audited (`agent.verify`, auth class, with the acting chain); human Console reads are not (noise control).

### 6.3 On-behalf-of token chain

When a user delegates to an Agent, the platform builds an **on-behalf-of token chain（on-behalf-of 令牌链）** with `act` layering, so audit can reconstruct the full "who asked the Agent to do what" path. At the HTTP layer the platform injects the real user as `X-On-Behalf-User` (DingTalk userId preferred) — identity travels in headers, never in tool parameters (missing identity fails closed).

### 6.4 Metrics: PV/UV/DAU

App product metrics combine three sources with non-overwriting merge semantics (PV accumulates per day; UV/DAU take the daily max):

1. **Active reporting**: `POST /api/apps/:id/metrics-report` (`app.write`), the `app_metrics_report` tool, or CLI `dshctl app report --pv=… --uv=… --dau=… --sessions=… --retention7=…` (a `--date=` back-fills history). Overdue apps (no report in 24 h) get automatic reminders from the Execution Hub heartbeat.
2. **Platform-side auto-conversion (zero effort)**: entry-ticket redemptions and OIDC code issuance each count +1 DAU (deduplicated per platform `sub` per day).
3. **Public visitor beacon**: one line of HTML/JS gives PV/UV from any page — `GET/POST /api/apps/beacon?app=<appId>&vid=<visitorId>` (1x1 GIF or JSON, CORS `*`, unknown apps answered identically so existence is not leaked, 60 requests/min per IP+app, silent over-limit drop).

```html
<img src="http://<platform>/api/apps/beacon?app=<appId>&vid=<visitorId>" hidden alt="">
```

App detail metrics pages render PV bars and UV/DAU lines. Cost pass-through per asset (including **cost per DAU（单位 DAU 成本）**, the first metric-times-cost join) is `GET /api/assets/benefit`, surfaced on the **Asset Operations（资产运营）** Console page together with the unified five-asset ledger, one-click health inspection, and retire-reason analysis (`GET /api/assets/retire-reasons`, aggregated from three sources and deduplicated).

### 6.5 Autonomy levels and A2A named invocation

Agent assets carry two governance attributes: `autonomy` (`A0`–`A3`, default `A0`: A0 advise-only, A1 low-risk execution with a human in the loop, A2 autonomous with after-action reporting, A3 cross-Agent negotiation) and `runtime` (`dsh`/`hermes`/`openclaw`/`workbuddy`/`external`). **A2A named invocation** is a minimal real loop today: one Agent calls another by name, and the autonomy level is disclosed in the response so the caller can pick its interaction depth:

```
POST /api/agents/:idOrSlug/a2a/invoke      # permission point agent.a2a.invoke
body { "message": "...", "dataClass": "public|internal|secret", "contextNote": "..." }
→ { ok:true, reply, model, autonomy, runtime, inputTokens, outputTokens }
   { ok:false, reason, autonomy, runtime }          # honest degradation, no fabricated reply
```

Only `online` Agents are callable (otherwise 400 with the state in the message); `dataClass` flows into modelgw tiered routing; metering is a zero-price snapshot on `agent:<id>`; event `agent.a2a.invoked`. Honest omissions (v1 scope): no session negotiation protocol, no cross-runtime discovery, no bidirectional level handshakes — these are roadmap items, not silently missing features. The full evidence-driven autonomy ladder (A0–A3 runtime enforcement with ODD-bounded elevation) has passed design review but implementation is pending a product go decision — **Roadmap**.

### 6.6 Agent organization fields

Agents can be placed in the org model: `orgRole` (CEO/CTO/manager/engineer/analyst), `rank`, `managerId` (reporting line; self-references, cycles, and dangling ids are all rejected), and `heartbeatIntervalMinutes`. The Console organization page renders humans and Agents as two layers of one tree.

### 6.7 Agent go-live gate

Going online requires identity onboarding: an OIDC client (issued from the Agent details' **SSO Configuration（SSO 配置）**) or a registered `entryUrl`. The gate only blocks new go-live requests; already-online Agents are never force-offlined. Apps and Agents offline/archived events disable their SSO clients (revoking refresh chains) and re-enable them on `app.onlined`.

---

## 7. Workflow orchestration (flow-core)

**flow-core** is the transaction-flow (TF) engine: multi-step orchestration above the Panel's task board. A TF is a step chain (1–30 steps) where each step has an actor type (`human` | `agent` | `gateway`) and a state-machine position (`pending → running → done/blocked/skipped`, with `blocked → running` restarts). Out-of-order transitions are refused; completed or cancelled TFs accept no more transitions; the platform never fabricates progress — steps advance only when explicitly called.

- **Template library + contextPack（模板库 / contextPack）**: templates carry step chains, an optional `slaMinutes`, and a contextPack that is returned at instantiation for automatic injection into the first step.
- **SLA & progress（SLA 与进度）**: `dueAt = createdAt + slaMinutes`; breach and overdue minutes are computed at read time (no background timers). Progress is `done/(total − skipped)`.
- **Gantt timeline（甘特时间轴）**: every step records `startedAt/finishedAt`, so the detail view renders the timeline directly from data.

REST (`/api/flow/*`, all guarded):

| Endpoint | Permission point |
|---|---|
| `GET /api/flow/templates?sceneCode=` | `flow.read` |
| `PUT /api/flow/templates`, `DELETE /api/flow/templates/:code` | `flow.admin` |
| `GET /api/flow/flows?sceneCode=&dept=&status=`, `GET /api/flow/flows/:id` | `flow.read` |
| `POST /api/flow/flows` (instantiate a template or compose freely) | `flow.write` |
| `POST /api/flow/flows/:id/steps/:key/transition` (body `{action, note?}`) | `flow.write` |
| `POST /api/flow/flows/:id/cancel` | `flow.write` |

Events `flow.created` / `flow.step.updated` / `flow.completed` / `flow.template.changed` fan out on the bus and to the Panel SSE channel (routed by `dept` when present).

---

## 8. Data asset domain

The **Data Asset Domain（数据要素域）** covers four capabilities:

- **Dataset registration（数据集登记）**: register datasets as governed resources.
- **Four-dimension quality score（四维质量分）**: each dataset carries a quality score across four dimensions (dimension semantics are defined in the platform's quality model).
- **Reverse lineage tracing（血缘反向追溯）**: trace consumers backward from a dataset.
- **Metric dictionary arbitration（指标字典口径仲裁）**: when two metric definitions conflict, the dictionary is the arbitration record.

Changes emit `resource.dataset.changed` / `resource.metric.changed`; management requires `resource.dataset.write`. There is no dedicated documented Console menu path for this domain — drive it via the REST surface and the event bus, or ask an Agent through the MCP tool surface.

---

## 9. Model Access Gateway (modelgw)

### 9.1 Real forwarding only

The gateway forwards OpenAI-compatible `chat/completions` requests for real. **A model with no configured endpoint refuses invocation — the platform never fabricates a completion.** Each call records measured `input_tokens`/`output_tokens` as a zero-price snapshot plus an internal procurement cost reference.

### 9.2 Metering and budgets

Token metering flows into the usage pipeline (`model:<slug>` resources; the meter key is `output_tokens`). Modelgw budgets let administrators cap consumption per organization and/or per model with daily/monthly windows: at `warnRatio` (default 0.8) of a limit the platform raises `modelgw.budget.warning` (at most one per budget per calendar day); with `action: block`, breaching any window **trips the budget circuit breaker before the call** with an explicit "budget breaker" error.

### 9.3 Channel governance

- **Tiered routing（分级路由）**: each model channel declares `dataClassLimit` (`public` < `internal` < `secret`); a request whose `dataClass` exceeds the channel's limit is refused with a "data-class lockdown" error — and the same check re-runs at every fallback step (degradation never downgrades confidentiality).
- **Fallback chain（渠道组降级链）**: channel groups define `primary → backup1 → backup2`; timeouts (`stepTimeoutMs`, 500–60000, default 8000), upstream 5xx, network errors, and 4xx all trigger degradation. Each hop emits `modelgw.degraded` (Panel SSE can render a banner). With `manual: true`, exhausting the chain returns `ok:false` + `escalated:true` instead of a fabricated answer.
- **Honest telemetry omission**: `GET /api/modelgw/:slug/telemetry?window=7d` returns invocations, failures, availability, p50 latency, proxy-side TPS, degraded counts — and `ttftMs: null` with an explanatory note, because first-token latency is not measurable on non-streaming single turns. The field stays honestly null until a streaming lane ships.
- Management surfaces: model catalog and budgets are edited on the **Financial View（财务视图）** page `#/finops` (gated by `modelgw.read`/`modelgw.admin`); channel-group registration uses `PUT /api/modelgw/channel-groups` (`panel.config.write`); group invocation is `POST /api/modelgw/channel-groups/:slug/invoke` (`panel.write`). `modelSlug: '*'` is an explicit wildcard matching any model in budget rules.

---

## 10. Usage transparency and FinOps

### 10.1 Metering pipeline

The usage plugin implements a **schema v1, idempotent metering pipeline（用量透明计量）** on SQLite (`data/txnstore.db`, WAL + transactional unique indexes):

- Events are ingested with an `idempotency_key`; engine-level consumption watermarks make replays and dead-letter redeliveries side-effect-free (no double counting).
- Failed consumers retry 3 times, then land in a dead letter queue with one-click redelivery.
- The **price book is a zero-price snapshot（零价快照）**: `charge` is always 0; the `cost` side provides an **internal procurement cost reference（内部采购成本参考）** (denominated in CNY; never presented as a bill). Meter key mismatches are hard-rejected with 400 and the expected key in the error message (the price book itself is not visible to callers — the error is the only self-correction hint).
- **Third-party reconciliation（三方对账）** and **capability drift detection（能力漂移检测）** run against runtime reality; reconciliation mismatches are refused/altered loudly, not smoothed over.

Reporting endpoints for external producers:

```bash
node cli/dshctl.mjs usage record --org=<orgId> --subject=agent:<id> --principal=org:<orgId> \
     --resource=skill:<skillId> --meter=calls:3:次,tokens:1200:token --idempotency-key=<business-ref>
# resource also accepts mcp:<slug> / nas:<id> / model:<slug> / plugin:<id> / connector:<service>
# meter keys must match the price book: mcp:* → tokens, model:* → output_tokens (400 with the expected key otherwise)
```

Attribution guardrail: machine principals may only report usage on behalf of users on an explicit whitelist (the worker's supervisor / bound human); outside it the request is 403 with `audit.authz.denied`.

### 10.2 Usage reports (J4)

Monthly aggregation over usage events in three frozen dimensions — by organization (`byOrg`), by Agent (`byAgent`), by Skill (`bySkill`) — plus an additive `byModel`:

```
GET /api/usage/report/monthly?month=YYYY-MM            # JSON   (permission point usage.read)
GET /api/usage/report/monthly?month=YYYY-MM&format=csv # CSV download, UTF-8 BOM, Excel-friendly
```

Each row carries `dimension / events / tokens / charge_cents(=0, zero-price snapshot) / cost_cents(internal cost reference) / nonbillable_events`. Tokens sum every meter whose key contains `tokens`. Enterprise stakeholders holding `usage.read` self-serve the export. The report reads only usage events — no settlement ledger exists anywhere.

### 10.3 FinOps report v1 (CFO view)

The **Financial View（财务视图）** page `#/finops` presents the FinOps report v1:

- **Cost pass-through（成本穿透）**: department × model cross matrix, month-over-month comparison, top consuming principals — internal cost references only.
- **Idle-run detection v1（空转检测）**: an approximate heuristic, explicitly labeled on the page as **requiring manual review** — the platform does not present it as an audited conclusion.
- One-click CSV export (UTF-8 BOM).

### 10.4 Retention

Usage events are retained by default for **730 days**; set `USAGE_RETENTION_DAYS` (0 = keep forever). An operational routine clears expired events on schedule.

---

## 11. Audit and governance

### 11.1 Audit logs

The audit plugin records **four audit log classes（四类审计日志）** with filtering — including change records for configuration mutations, auth-class records for identity operations (e.g., machine-identity ledger reads), and invoke records for guarded calls (roster pulls, org-sync pulls, NAS file operations, connector actions with their act chain). Human Console reads of ordinary lists are deliberately not recorded (noise control). The **Asset Operations（资产运营）** page and audit queries are the primary retrieval surfaces; CLI: `dshctl audit logs --resourceId=<id>`.

### 11.2 Alert rules and privilege-violation counting

An **alert rule engine（告警规则引擎）** evaluates thresholds over audit/metering signals (`audit.rule.write` to manage). Authorization denials are platform-wide: every guarded route that rejects a caller emits `audit.authz.denied`, and counting rules turn bursts into **privilege-violation alerts（越权计数告警）**. Domain-specific alert signals include `mcp.unhealthy`, `connector.gateway.unhealthy`, `nas.authz.denied` (metric `nas_authz_denied`), `nas.authz.leaderVacant`, `nas.authz.dirOrphan`, and `nas.authz.cGroupDrift`. The DingTalk bridge can deliver `audit.alert.fired` into an alerts-bound group chat.

### 11.3 L4 mandatory approvals and approval deepening

Lifecycle operations — **online / offline / unlist / revoke（上线/下线/下架/吊销）** — generate **L4 mandatory approval（L4 强制审批）** tickets in the **Approval Center（审批中心）**; a holder of the approval permission can pass a ticket as a single approver, which executes the operation and writes the result back. Reasons are mandatory and permanently retained. Separation of duties: `agent.online` (a hiring decision) enforces submitter ≠ approver; other types follow the 2026-09-15 relaxation.

Approval deepening adds:

- **High-risk double confirmation, fail-closed** (e.g., industry activation requires an explicit second confirmation server-side),
- **Company-level final review（公司级终审）** for designated high-impact flows,
- An **SLA dashboard（SLA 看板）** over approval latency.

```bash
node cli/dshctl.mjs agent offline <id> --reason="repeated anomalies"      # creates the L4 ticket
node cli/dshctl.mjs approval decide <id> --decision=approve --opinion="confirmed"
```

### 11.4 Notification center

The **Notification Center（通知中心）** persists notifications and serves `since`-incremental pulls plus a per-user **read cursor（已读游标）**, so clients poll cheaply without losing events.

### 11.5 Audit evidence anchors and scene timeline

Audited business moments can be registered as **audit evidence anchors（审计证据锚点）** and replayed as a **scene-dimension timeline（场景维度时间线）** — a reverse lookup from a scene code to everything that happened in it, in order.

---

## 12. NAS file storage

### 12.1 Gateway-based access

NAS is the sixth managed asset class. All file operations go through a **file MCP gateway** (of the `synology-filestation-mcp` kind) — the platform holds the gateway URL, a Bearer token, and the `X-NAS-IP` device-routing header, and executes everything via the gateway's `tools/call` (`fs_list/fs_upload/fs_delete/fs_search`, ...). The platform **never talks to DSM private APIs directly**. Lifecycle: `draft → online → offline → archived`, with a liveness initialize guard before going online; health inspection folds into Asset Operations; token echoes are masked.

### 12.2 Onboarding and file operations

**mcpServers JSON one-click onboarding**: paste the gateway's mcpServers config and the platform creates the asset, probes, brings it online, and discovers tools:

```bash
node cli/dshctl.mjs nas import --config='{"mcpServers":{"synology-filestation":{"url":"http://192.168.0.7:3000/mcp","headers":{"Authorization":"Bearer <token>","X-NAS-IP":"192.168.0.196"}}}}'
node cli/dshctl.mjs nas files <id> --path=/skillhub    # shares/mkdir/upload/delete/search in the same family
```

The Console **NAS Storage（NAS 存储）** page provides list, detail, a file browser, and the import dialog. Eight `nas_*` tools expose the same contract to dsh plugins, the REST tool bridge, and `POST /mcp`.

### 12.3 Data permissions (org position + role hierarchy)

The NAS authorization engine derives file rights from **organizational position + role hierarchy** — nobody maintains per-user file ACLs:

- **Five-step decision order（五步判定序）**: account special rules (external whitelist read-only / suspicious-flag deny-to-human / root-without-role deny / not-yet-in-team read-only / concurrent-post sub-tree read-only) → explicit deny (path tail wildcards) → explicit allow (expirable) → role matrix × scope boundary → **default deny**. Every step emits reasons.
- **Zero-roster role derivation**: P/D/T roles derive from organization-chain leadership (`OrgRecord.leaderUserIds`, synced from DingTalk `dept_manager_userid_list`; multiple co-leaders all derive); M = members; C (cross-domain contributor) is a dynamic user group. The built-in matrix: P full; D all but admin; T read/download/write/modify; M read/download/write; C read/download across domains only. `orgPathOverrides` pin scope mappings so renames do not drift; a daily org↔directory reconciliation plus leader-vacancy scan raise alerts.
- **Identity hard constraint**: platform-to-gateway calls always carry `X-On-Behalf-User`; the `nas_fs_*` tools take identity from `exec.principal` (no identity parameters in schemas; missing identity fails closed). Gateways reject the header from untrusted tokens (anti-forgery).
- **Share approval loop**: T/M members apply; the approver auto-routes along the org chain (resource_admin as fallback); approval writes a 7-day exception that auto-denies at expiry — all audited. A break-glass `override=true` (holding `nas.authz.write`) forces the P-level evaluation with mandatory audit.
- **Gradual rollout switches**: `observeOnly` (default true: deny alerts but does not block), `degradeAllToReadonly` (G3 emergency), plus a gateway-side `AUTHZ_ENFORCE=off` global kill switch and per-token `enforce` — any stage rolls back in seconds.

REST: `POST /api/nas/authz/check`, `GET /api/nas/authz/scope`, `GET/PUT /api/nas/authz/rules` (optimistic locking via `ifVersion`, conflict = 409 `VERSION_CONFLICT`), `POST /api/nas/authz/exceptions`, `GET /api/nas/authz/decisions` (deny decisions fully retained; high-risk ops retained permanently, ordinary ones 90 days). CLI:

```bash
node cli/dshctl.mjs nas authz check --nas=<id> --user=<userId> --path=<path> --op=<op>
node cli/dshctl.mjs nas authz scope --nas=<id> --user=<userId>
node cli/dshctl.mjs nas authz rules get | set [--observe-only=on|off] | import --file=<rules.json>
node cli/dshctl.mjs nas authz decisions [--decision=deny] [--limit=50]
```

The Console **Data Permissions（数据权限）** page `#/nas-authz` exposes the gradation switches, matrix (with overrides), expiring-exception list, C-group associations, a check sandbox, decision trail, and reconciliation scans.

### 12.4 File ownership tracking and signed download URLs

- **File ownership tracking（文件所有权跟踪）**: uploads register the owner, renames rewrite it, deletes remove it; the data-permission engine consumes the owner dimension (owners pass for their own files by default).
- **Signed download URLs（签名下载链接）**: download links are HMAC-signed with tiers of **1 h / 24 h / 7 d / 30 d / permanent（1h/24h/7d/30d/永久）**. Serving checks three gates in order — signature → revocation → permission re-check — and long-lived tiers use an **independent long-term key that can be revoked** independently of the main signing key.

---

## 13. Connectors

### 13.1 Architecture: governance control plane + SaaS data plane

YuanBingKe does not rebuild a provider catalog, OAuth, or a secret store. The **open-connector sidecar** (v1.4.0, pinned) runs alongside as the **SaaS data plane（数据面）**: 1,000+ provider / 10,000+ action catalog, full OAuth flows, and an AES-256-GCM **credential vault（凭证保险库）**. The platform is the **governance control plane（治理控制面）**: identity, authorization, approvals, metering, audit.

Three red lines hold on every path:

1. **Credentials never enter the platform** — provider secrets live only in the sidecar vault; connection records carry no credential fields.
2. **Dual authorization verification** — the platform permission group and the sidecar runtime token (`oct_`) each independently reject; bypassing the platform and hitting the sidecar directly still fails the token policy.
3. **Audit chain + metering reconciliation** — every call is traceable by `runId` (= `meta.executionId`); "a run without a meter record" is a critical bypass alert.

Deployment prerequisites are fail-closed: the platform refuses all native connector invocations (503 `gateway_unavailable`) unless `OOMOL_CONNECT_ENCRYPTION_KEY` and `OOMOL_CONNECT_ADMIN_TOKEN` are present; 30-second health probes trip `connector.gateway.unhealthy` after repeated failures. OAuth callback topology (direct vs reverse-proxied, `OOMOL_CONNECT_ORIGIN`) must be decided before deployment — see [connector-integration.md](../../connector-integration.md) for the runbook.

### 13.2 Connections and the two-layer authorization mirror

Three connection forms: **OAuth proxy** full flow (enterprises register their own OAuth apps; missing config yields the expected guard `400 oauth_client_config_required` with wizard guidance), **API key** (values pass through and are never persisted by the platform; echoes are masked to the first six characters), and `no_auth` virtual registration. Aliases are forced to the `org:<orgId>:` prefix; deletion cascades through permission-group reference checks.

The **two-layer authorization mirror（双层授权镜像）**: each connector permission group (pattern / `riskCap` / `readOnly` / mandatory `denyParams` interception) mints and mirrors one `oct_` runtime token; group policy snapshots are pushed in full on every change, an org patrol asserts "token-bound connections ⊆ group's org connections", and `401`/`connection_not_allowed` triggers one automatic recovery retry.

```bash
node cli/dshctl.mjs connector gateway set --base-url=http://127.0.0.1:3000 --admin-token-env=OOMOL_CONNECT_ADMIN_TOKEN
node cli/dshctl.mjs connector gateway health
node cli/dshctl.mjs connector connections create --provider=github --auth-type=api_key --org=$ORG_ID --values=@values.json
node cli/dshctl.mjs connector perm-groups create --file=@pg.json
node cli/dshctl.mjs connector execute --action=hackernews.get_top_stories --dry-run
node cli/dshctl.mjs connector runs && node cli/dshctl.mjs connector reconcile
```

The Console **Connectors（连接器）** page `#/connectors` covers gateway setup (with an env-gate rehearsal probe), the catalog with risk-level badges, the connection wall with a three-form wizard, the permission-group JSON policy editor with impact preview, run logs, the `oct_` ledger (token values never displayed), and the reconcile button.

### 13.3 Approvals and metering reconciliation

Two approval scenarios: high-risk (`riskLevel=admin`) actions return `approval_required + approvalId` and execute automatically on approval (pending tickets for the same intent are reused); controlled connections run a two-phase `connector.connect` flow (the ticket payload contains zero credential fields; the actual credentials are submitted after approval with the `approvalId`). Metering records `connector:<service>` events with `calls` meters and idempotency key `connector:<runId>`; write operations auto-generate `Idempotency-Key` headers (24 h replay window). An M0-era MCP bridge (`POST /api/mcp/import` with an `x-bridged-from` header) exists for connectivity verification only and is badged "bridged transition（桥接过渡）" — production must use the native path.

---

## 14. Execution Hub

The **Execution Hub（执行中枢）** (`plugin-exec-hub`) is the "get things done" layer: goals decompose into work, work executes under locks and governance, and everything beats with a heartbeat.

### 14.1 Goal alignment

`exec:goals` support a **parent goal tree** plus a **metric trio** (baseline / target / unit); goals decompose into `exec:projects` and further into `exec:issues`. `goalAncestry` is **materialized at write time**, so every wakeup wraps its context with "this task serves goal X / project Y / prerequisite Z" — the why behind the work. Cycles in the goal tree are rejected.

### 14.2 The 30-second heartbeat loop

A heartbeat loop (cadence `EXEC_HUB_TICK_MS`, default 30 s) drains a **wakeup queue（唤醒队列）** with idempotency-key deduplication through a **governance pre-check chain（治理前置链）**:

1. budget pre-check → 2. freeze check → 3. Agent machine-principal permission check → 4. P0 approval gate → then a three-way verdict: `proceed` / `coalesce` / `defer`.

Todos are pulled from **three sources** (Execution Hub tasks, Panel tasks, transaction-flow Agent steps). Apps that miss their 24-hourly metrics report are nagged automatically. Heartbeat outcomes feed the **five-tier Agent health score（健康度五档）**: `healthy / stale / silent / frozen / offline`.

### 14.3 Issue execution locks (CAS)

An issue row carries three CAS fields (`executionRunId / executionAgentKey / executionLockedAt`). The take/ release decision is a **pure function exhaustively unit-tested over all 64 input combinations**, layered above the CAS guard; runs support batch release; **zombie locks（僵尸锁回收）** are force-reclaimed after `EXEC_LOCK_TIMEOUT_MS` (default 5 minutes).

### 14.4 Routine scheduling

Three schedule sources: fixed **interval**, **5-field cron**, and **webhook** — where the endpoint path itself is the credential (unregistered or disabled paths answer 404, fail-closed).

### 14.5 Agent tools and the five guardrails

Four tools let Agents work the Hub without knowing it exists: `exec_wakeup_status`, `exec_claim`, `exec_complete`, `exec_lineage`. Every wakeup path passes **five guardrails**: budget hard stop, permission check, audit trail, sensitivity annotation, and the P0 approval gate.

### 14.6 Agent organization and budget-linked freeze

Budget principals cover `agent:<id>` and `app:<id>` (the same keying as metering subjects). When a budget breaker trips, the owning Agent is **frozen（主体预算超额联动冻结）** and an `agent.unfreeze` **L4 approval** is generated automatically (reusing the approval infrastructure, with its double confirmation); approval execution unfreezes. Metrics reports auto-enter the usage window with auto-seeded zero-cost rules.

---

## 15. Digital workers (workforce)

The **Workforce Domain（数字员工域）** (`plugin-workforce`) models digital workers as governed employees rather than ad-hoc chatbots:

- **Worker profiles & appointment version state machine（员工档案 / 任用版本状态机）**: a worker is appointed to a post; appointments are versioned state machines, so changes to mandate or boundaries are auditable history, not overwrites.
- **Goal claiming & execution lease confirmation（目标认领 / 执行租约确认）**: workers claim goals and confirm an execution lease before working; leases expire and renew explicitly.
- **Short-term work permits（短期工作授权 permit）**: time-boxed authorization grants for out-of-post work.
- **Four-gateway controlled invocation ledger（四网关受控调用账本）**: worker resource calls (MCP / model / NAS / connector gateways) pass a controlled-invocation ledger that takes the **intersection with the platform's existing resource authorization chain** — the worker needs both the workforce-side grant and the resource-side permission; neither alone suffices.
- **Delivery-to-human-acceptance loop（交付-真人验收闭环）**: work products end in an artifact that a human accepts; acceptance closes the loop.

**Division of labor** (the boundary to remember): goals / tasks / runs belong to the **Execution Hub**; workers / appointments / deliveries belong to the **Workforce Domain**. Permission points: `workforce.read/write/admin/invoke/accept`; a `workforce.admin` operations surface provides batch suspend/reinstate (with permit/lease withdrawal), appointment audit reports, and expired-permit / terminal-run ledger cleanup.

Related platform guarantees: MCP tools discovered from remote runtimes require risk registration before write use (Section 4.4); usage reported on behalf of humans is whitelist-constrained (Section 10.1). A dedicated independent-loop drill (`tests/workforce-loop-drill.mjs`) exercises claim → invoke → deliver → accept against real upstreams — 35/35 as of the Phase-1 baseline, with the bar raised since (count as of the latest run governs).

---

## 16. Daily interfaces

### 16.1 Console, Panel, Portal

| Surface | Users | Standalone deployment (port 7300) | dsh-hosted (single entry, e.g. 8801) |
|---|---|---|---|
| **Console（控制台）** — management SPA | admins / governance roles | `/` | `/rq/` |
| **Panel（面板）** — department Agent workbench（部门 Agent 工作台）, `/panel` SPA + SSE | business staff / department members | `/panel/` | `/rq/panel/` |
| dsh conversation UI | everyone (business surface) | — (does not exist standalone) | `/` |
| **Portal（门户）** | anonymous visitors | external site (pull-only data channel) | same |

The Console is a Feishu-style workbench: a **⌘K command palette（⌘K 命令面板）** for search-and-jump, role-based workbenches (approvals + alerts + event stream + cost trend), task-oriented navigation, right-side detail drawers, progressive forms, dry-run previews for dangerous operations, and an SVG-based badge/chart system with no third-party UI dependencies. The Panel offers department channels, a four-tab workspace (Collaboration chat（协作会话）, Task board（任务看板）, Department knowledge（部门知识）, Scenario graph（场景图谱）), a widget board with source badges, and live SSE updates (with a 30-second polling fallback for embedded webviews). The Portal reads six public GET endpoints under `/api/portal/*` (pull model; `PORTAL_SYNC=off` disables the channel) — see [portal-integration.md](portal-integration.md).

### 16.2 Unified entry triage (J2) and session passthrough (J3)

**J2 — one entry, triage by identity**: users only need to remember the Console URL. On bare landing (no deep link), the Console triages by permission points, not role names: a **pure business identity** (no management-marker point among `iam.user.read` / `approval.read` / `audit.read` / `usage.read`, and holding `panel.read`) lands on the Panel; management/governance identities land on the Console. Explicit cross-switching (Console NAV "Department Panel（部门面板）", Panel rail "Management Console（管理控制台）", plus an "Agent conversation（Agent 对话）" entry in hosted form) records a preference (`localStorage['heng_ops_landing']`) so users are not yanked back. Login redirects preserve the destination (`?next=` with a same-origin whitelist; cross-origin next allowed only for loopback/private-network hosts).

**J3 — session passthrough（会话直通）**: Console and Panel share a three-level session chain — existing token → `?entry_ticket=` exchange → host-Cookie passthrough (`POST /dsh-bridge/session` binds the `rq_sid` Cookie to the platform identity). The same identity enters both surfaces with zero re-login; tickets are one-time with short TTLs; binding re-checks account status in real time (frozen accounts invalidate instantly, reason `account_inactive`). Tool egress attribution rides `X-On-Behalf-User`; on hosts with multiple concurrent users, the process-level fallback attribution is explicitly **not** a basis for charging or discipline (panel-side attribution is unaffected).

### 16.3 Named invocation with honest degradation (J1) and rq-card

From a Panel channel you can invoke a Skill (`/<skill> <message>`) or @-mention an Agent for a direct answer. The J1 contract's core semantic is **honest degradation**: predictable failures (unknown skill/Agent, unbound asset, no model/endpoint, gateway failure) return **HTTP 200 with `ok:false` and a human-readable `reason`** — degradation is data, not a transport error — and never a fabricated reply. Successes and failures both land as channel messages (the failure line is visible to the whole channel and searchable). The same primitives exist as tools (`panel_agent_invoke`, `panel_skill_invoke`, `panel.write`).

The **rq-card** plugin injects **four-state execution cards（四态执行卡）** into dsh conversations — task cards with lifecycle states plus a thumbs-up / thumbs-down feedback bar — so Agent work is visible and rateable in the chat surface.

### 16.4 Platform as MCP server

The platform itself is an MCP server: `POST /mcp` (Streamable HTTP, pure-JSON form; no GET SSE lane) speaks `initialize` / `tools/list` (40+ operations tools) / `tools/call` / `ping`, reusing platform Bearer tokens and **per-tool permission points** (identity injection prevents parameter forgery). ZCode, Claude, Cursor, or any MCP client can therefore manage the platform directly:

```bash
curl -X POST localhost:7300/mcp -H "authorization: Bearer <token>" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The same tools are callable via the REST tool bridge and, when mounted in dsh, the native ToolRuntime — three surfaces, one contract. Reference docs are served read-only at `/docs/<name>.md` (whitelist-published).

### 16.5 Remote dsh access

Other machines install the platform as a dsh plugin and operate the hub remotely — no source checkout, no shared data directory. The admin creates a one-time **enrollment code（接入码）** on the Console **Platform Access（平台接入）** page (or CLI): stored hashed, shown once, one-time consumption, configurable TTL (default 15 minutes), and per-source-IP lockout (5 failures in 15 minutes). Permission templates: `readonly` (default), `operator` (read/write ops + approvals, no account/credential management), `full`.

```bash
DSHCTL_URL=http://<host>:7300 DSHCTL_USER=admin DSHCTL_PASS=*** \
  node cli/dshctl.mjs connect code --template=operator --ttl=15 --remark="R&D"
```

The remote side enrolls via an Agent (`connect_setup` with the `enr_…` code) or the local config page at `http://127.0.0.1:7390`. Afterwards the remote dsh's 37 operations tools proxy to the hub (per-tool RBAC, fully audited), five self-service tools (`connect_status/connect_setup/connect_login/connect_test/connect_reset`) manage the link, clients heartbeat every 5 minutes to `POST /api/connect/heartbeat`, and the host can disable a client at any time (revoking all its machine tokens immediately). Four host-side management tools (`connect_code_create/connect_codes/connect_clients/connect_client_disable`) round out the surface.

---

## Appendix A. Where to find things

- **Permission points**: the authoritative catalog (78 points + 1 manifest-only) with per-key Chinese semantics is `docs/协议键中文对照总表.md` (Section 2). English meanings in this guide are paraphrases; key spellings are contractual.
- **Protocol keys**: the same table covers event names (80), error reason codes (37), environment variables (53), browser storage keys (21), and the API envelope.
- **CLI command families** (`node cli/dshctl.mjs <family> …`; credentials via `DSHCTL_URL` + `DSHCTL_USER`/`DSHCTL_PASS` or `DSHCTL_TOKEN`; `--output json|table`, `--dry-run`, `--yes`):

| Family | Covers |
|---|---|
| `org` / `user` / `sync` / `conflict` | Organization, accounts, third-party sync, conflict tickets |
| `token` / `credential` | Tokens; machine credential list / scopes / rotate |
| `mcp` | MCP deploy / canary / rollback / import / invoke / monitoring |
| `skill` (+ `skill storage`) | Skill lifecycle; package backend local/NAS |
| `agent` (+ `agent … report`) | Agent lifecycle, offline (L4), metrics report |
| `app` | App registry, metrics report (`app report --pv --uv --dau …`) |
| `usage` | Metering ingestion (`usage record`) |
| `nas` (+ `nas authz`) | NAS assets, files, shares, import; data-permission check/scope/rules/decisions |
| `connector` | Gateway / catalog / connections / perm-groups / tokens / runs / execute / reconcile |
| `audit` / `approval` / `cost` | Logs, alerts, approval decisions, cost rollups |
| `connect` | Enrollment codes, remote clients |
| `update` | Update status / check / apply |
| `plugin` | init / sign / submit for the plugin market |
| `tool exec` | Execute any registered tool by name |
| `help` | Full command tree |

- **Quality gates**: `npm run selftest` (isolated instance, end-to-end assertions — over 1,380 assertions as of the 2026-10-15 batch; the latest run's count governs), `npm run lint:manifests` (five-face YAML validation), `npm run lint:cjk` and `npm run lint:boot-order`, plus drills: `tests/full-chain-drill.mjs` (register → approve → publish → authorize → invoke → meter across four asset classes), `tests/morning-peak-entry.mjs` (50-way concurrent ticket redemption), `tests/workforce-loop-drill.mjs`.
- **Operations skills for Agents**: `skills/dsh-ops-admin/SKILL.md` is the master index over nine domain skills (iam/authn/mcp/skillhub/agent/app/audit + connect + update), with the standard loop: diagnose → evidence → dry-run → execute (L4 via approvals) → verify.

## Appendix B. Related documents (English set)

- [README.md](README.md) — product panorama (international edition)
- [product-introduction.md](product-introduction.md) — positioning one-pager
- [getting-started.md](getting-started.md) — quick start + demo mode
- [deploy-enterprise.md](deploy-enterprise.md) — enterprise deployment & dsh runbook
- [app-sso-integration.md](app-sso-integration.md) — full SSO integration guide for apps
- [usage-reporting.md](usage-reporting.md) — usage transparency & FinOps reporting (J4)
- [dsh-ecosystem.md](dsh-ecosystem.md) — DSH ecosystem ("Everything is a plugin")
- [release-notes-summary.md](release-notes-summary.md) — release history digest

*Interface language reminder: as of the 2026-10-16 release the runtime UI has a built-in language switcher (Simplified Chinese default / English (US) / Japanese; top-bar selector, `rq_lang`, CLI `--lang` / `DSHCTL_LANG`; dictionary misses fall back to Chinese — see [README.md](../README.md) Section 8). Compliance certifications (SOC 2 / ISO 27001) are not held; they are roadmap items.*
