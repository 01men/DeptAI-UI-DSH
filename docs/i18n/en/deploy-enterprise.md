# Enterprise Deployment & Agent One-Shot Onboarding Runbook

> **English edition** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source: `docs/deploy-enterprise.md` · Source baseline: 2026-10-15 · Glossary: [GLOSSARY.md](../GLOSSARY.md) · Governance: [README.md](../README.md)

> Audience: engineers deploying 元冰可 (YuanBingKe / ybkk-AIOS), the Enterprise AI Resource Management Platform, for an enterprise on top of **DeepSeek Harness (dsh)** — and users who want to hand the deployment/onboarding work **directly to the dsh built-in Agent** to be completed autonomously.
> For day-to-day operations (non-deployment) Agent guidance, see `skills/dsh-ops-admin/SKILL.md` (master index).

## Interface language note

As of the 2026-10-16 release, the runtime interface — Console, Panel, Portal, CLI output, notifications and error messages — ships with a built-in language switcher: Simplified Chinese (default), English (US), and Japanese. Switch via the top-bar selector; the preference is stored in the browser (`rq_lang`). The CLI follows `--lang` or `DSHCTL_LANG`. Any string not yet covered by a dictionary gracefully falls back to Chinese. The bilingual annotations (English name（中文原文）) used throughout this document remain useful for navigating screenshots and on-prem deployments pinned to Chinese, and browser page translation also still works.

---

## 1. Deployment shapes and topology

| Shape | Processes | Description | Best for |
|---|---|---|---|
| A. Standalone host (default) | `node src/main.ts` | One process provides the REST gateway + Console SPA + a bridge of 41 operations tools (including 4 access-management tools) | Minimal production form; human operation via the Console |
| B. dsh runtime mount | `dsh web --patch <overlay>` | The configuration mounts the platform under `/rq`; this experimental form must be verified with isolated data | Agent-driven operations |
| C. Remote dsh access | Host (A) + `dsh plugin add` on a remote computer | The remote computer installs the platform from the plugin marketplace and applies for a machine credential from the host with a **one-time access code**; all operations tools are proxied remotely to the host for execution (no source code, no shared `data/` needed) | Multiple sites / multiple operators managing the same platform with dsh |

> `cordis.yml` includes the console and dsh bridge and disables the independent HTTP listener, with `/rq` as the intended dsh entry. Do not run two processes against the same data directory.

Environment requirements: Node ≥ 22.6 (runs TypeScript natively, no build step); data is persisted in the directory given by `--data` (JSON collections + SQLite `txnstore.db`).

---

## 2. Manual deployment runbook (shape A · executable checklist)

> Every step pairs a command with its expected output: stop if reality does not match, resolve using the troubleshooting note, then continue.

### Step 0: Environment pre-check

- [ ] `node -v` → **v22.6+** (native TS execution, no build step)
      ✘ Below 22.6: upgrade Node first; do not bypass (older versions cannot execute `src/main.ts` directly)

### Step 1: Get the code and dependencies

```bash
git clone <repository URL> ops-platform && cd ops-platform
npm install                # expected: no lines ending in ERR; completes in seconds when package-lock is unchanged
```

### Step 2: First start (baseline initialization wizard)

```bash
# Production: the admin password must be set explicitly (if unset, a random one is generated once and written to data/admin-initial-password.txt)
export ADMIN_PASSWORD='<strong password>'   # Windows PowerShell: $env:ADMIN_PASSWORD='...'
npm start -- --port 7300 --data ./data
```

- [ ] The log shows「平台基线初始化完成」("platform baseline initialization complete") plus the "go-live three steps" guidance box (first start only)
- [ ] The log shows「元冰可|企业AI资源管理平台已启动」("YuanBingKe | Enterprise AI Resource Management Platform started") and the Console address `http://0.0.0.0:7300`
- [ ] `curl -s http://127.0.0.1:7300/api/health` → `{"status":"ok",...}`
- [ ] (If `ADMIN_PASSWORD` was not set) confirm `data/admin-initial-password.txt` exists, read it, and **move straight to Step 4 to change the password**

### Step 3: Functional verification

```bash
# Login (expected: response contains a token field)
curl -s -X POST localhost:7300/api/auth/login -H 'content-type: application/json' \
     -d '{"username":"admin","password":"<password>"}'
# First-start state (expected: initialPasswordPending=true — true while the password file is still on the server; false after the password change + file deletion in Step 4)
curl -s http://127.0.0.1:7300/api/platform/bootstrap
```

- [ ] Login returns a token; opening the Console in a browser shows the yellow "first deployment" banner on the login page (while the password file has not been deleted)
- [ ] Quality gates (isolated instance, production data untouched): `npm run selftest` all green, `npm run lint:manifests` zero errors

### Step 4: Closing takeover (secure the admin account)

- [ ] Change the admin password in the Console: top-right avatar → Change Password（修改密码）
- [ ] Delete `data/admin-initial-password.txt` on the server → `curl -s http://127.0.0.1:7300/api/platform/bootstrap` flips to `initialPasswordPending:false` and the login-page banner disappears
- [ ] (Supply-chain hardening, optional but recommended) release-manifest signature verification:

```bash
# Publisher side (one-time): generate a key pair → keep the private key to yourself, register the public key with the platform
node scripts/release-manifest.mjs --generate-key --key-file /secure/release-key.pem
# Administrator side (one-time): register the public key, then enable enforcement (order matters — enabling without a registered public key is rejected)
curl -X POST localhost:7300/api/update/settings -H "authorization: Bearer <token>" \
     -H 'content-type: application/json' -d '{"releasePublicKey":"<public key base64>"}'
curl -X POST localhost:7300/api/update/settings -H "authorization: Bearer <token>" \
     -H 'content-type: application/json' -d '{"requireSignedManifests":true}'
```

### Step 5: Process supervision (Linux systemd example)

```ini
# /etc/systemd/system/ops-platform.service
[Service]
WorkingDirectory=/opt/ops-platform
Environment=ADMIN_PASSWORD=<strong password>
# Connector gateway gate (if missing, the Connectors page shows "gateway unavailable" and failed probes spam the audit log — test report DEF-02)
Environment=OOMOL_CONNECT_ADMIN_TOKEN=<strong secret>
Environment=OOMOL_CONNECT_ENCRYPTION_KEY=<random string of 32+ bytes>
# Port-occupation guard: an orphan process seizing the port makes restart silently ineffective (test report DEF-04); check before start
ExecStartPre=/opt/ops-platform/scripts/guard-port.sh 7300
ExecStart=/usr/bin/node src/main.ts --port 7300 --data /opt/ops-platform/data
Restart=always
```

Operations essentials:

- **Operations iron rule**: always start/stop the service via `systemctl`; never bypass systemd by hand-launching `node src/main.ts`
  (once an orphan process grabs the port, `systemctl restart` fails or the old process keeps the port — changes never take effect and are hard to diagnose).
- **Backup**: a cold copy of the whole `--data` directory is sufficient (JSON is written atomically + SQLite WAL). Metering data lives in `txnstore.db`.
- **Upgrades (built-in update check since v1.1+)**: by default the platform checks the upstream GitHub repository for a new version every 24h (adjust or disable in the Console top bar Platform Updates（平台更新）drawer, or via `dshctl update set`). When a new version is found, an "updatable" badge appears in the Console top bar and a `platform.update.available` event is broadcast (audit-trailed). Upgrade method depends on the install shape — pick one:
  - **Source checkout (source)**: use the Console drawer's one-click upgrade, or rehearse with `dshctl update apply --dry-run` and then run `dshctl update apply --reason="…"` (internally runs `git pull --ff-only` + `npm install`; it fails safely — without forcing — if local uncommitted changes exist), then `systemctl restart ops-platform` to take effect. Run `npm run selftest` before switching traffic.
  - **Plugin marketplace install (bundle)**: on the host's dsh side run `dsh plugin update github:01men/ybkkasi`, then restart the dsh host.
    (Package source migrated from `github:01men/ybkk-AIOS` to `github:01men/ybkkasi` on 2026-10-14.)
  - An Agent can also simply be told "check platform updates" / "upgrade the platform" in a session (the `update_status` / `update_check` / `update_apply` tools).
- **External publishing**: reverse-proxy port 7300 via Nginx or similar and terminate TLS there; the platform itself authenticates with Bearer tokens.
- **Enterprise customization (as needed)**: DingTalk real connector (`mode: real` + `apiBase`, configured in the Console under Organization & Accounts（组织与账号）→ Third-party Integrations（三方集成）).
  Third-party access supports **multiple entities and multiple instances per provider**: one DingTalk tenant can serve several enterprise entities (each with its own corpId/appKey/appSecret). Configuration is addressed by instance id and unique per `provider|corpId` (duplicate entities are rejected); each instance has independent configure/test/sync/delete, synced departments are owned per connector instance, and login/binding can be initiated per entity. REST surface: `POST /api/iam/connectors` creates an instance, `DELETE /api/iam/connectors/:id` deletes one (permission point `iam.connector.write`); in the existing `PUT/POST /api/iam/connectors/:param[/test|/sync]`, `:param` resolves by instance id first and falls back to the first entry of that provider (enabled entries first) — existing callers are compatible unchanged. New config fields: `name` (entity display name, used in the login entry/list) and `targetOrgId` (root department for the sync tree; empty = platform root). OIDC declares its external address via the `OIDC_ISSUER` environment variable; in production, migrate the OIDC private key to a KMS.
- **Intranet / rate-limited networks**: the update check calls the GitHub API (unauthenticated quota 60 requests/hour/IP; set `GITHUB_TOKEN` to raise it); private mirrors can override the endpoints with the `DSH_UPDATE_API_BASE` / `DSH_UPDATE_RAW_BASE` environment variables.
- **Funding boundary**: payment / corporate transfer / invoicing channels are a manual transitional state; before integrating any, read the "Funding Red Line" section (三A 资金红线) of the repo README. The platform carries **no billing or settlement semantics** (M0 baseline).

---

## 3. dsh runtime onboarding (shape B — enabling Agent operations)

This integration is experimental: verify it with an isolated data directory. For an installed dsh runtime, use `dsh plugin --profile web add github:01men/ybkkasi`.

For a source checkout, use the [Chinese source instructions](../../deploy-enterprise.md#三dsh-运行时接入形态-b启用-agent-运维) to generate an overlay with a `file://` repository URL and ensure the project and host use the same cordis instance. Validate the `/rq` console and available tools. Never run two processes against the same data directory.

For operations, read `skills/dsh-ops-admin/SKILL.md` and follow the actual authorization and approval rules.

---

## 4. Remote dsh access (shape C: marketplace install → access code → automatic credential application)

Applies when the dsh on another computer has installed this platform via `dsh plugin --profile web add github:01men/ybkkasi` and does not know how to configure credentials/passwords issued by the host. The whole flow requires **no manual editing of any config file on the remote computer**.

### 4.1 Host side: issue a one-time access code (administrator, Console or CLI)

```bash
# Console: log in → left sidebar Platform（平台）→ Platform Access（平台接入）→ Create Access Code (choose template/TTL/remark; the code is displayed exactly once)
# or CLI:
DSHCTL_URL=http://<host IP>:7300 DSHCTL_USER=admin DSHCTL_PASS=*** \
  node cli/dshctl.mjs connect code --template=operator --ttl=15 --remark="R&D, Wang"
```

Permission templates (= the remote client's permission boundary after onboarding):

| Template | Permissions |
|---|---|
| `readonly` (default) | All query-type permission points (list/get/metrics/logs) |
| `operator` | Read-only + MCP/Skill/Agent/application operations and approval decisions; **excludes** account and credential management |
| `full` | All permissions (`*`); trusted environments only |

### 4.2 Remote computer: two onboarding channels (pick either)

```text
(1) Agent channel (recommended): tell the Agent directly in the dsh UI:
    "Onboard to the host platform, address http://<host IP>:7300, access code <enr_…>"
    The Agent will call the connect_setup tool to complete the application automatically and switch the
    37 operations tools to remote execution.

(2) Config page channel: open http://127.0.0.1:7390 in a browser (on the remote computer itself; the plugin
    listens automatically at startup), enter host address + access code → Apply（申请接入）.
    From this page you can later update the configuration, test the connection, or disconnect at any time.
    If a machine credential already exists (mc-/cs_ prefixes), switch to the "existing machine credential" tab.
```

### 4.3 Verification and operations

- Remote side: have the Agent run `connect_status` (should show remote mode, valid token) and `agent_list` (returns host data).
- Host side: the computer appears in the Console under Platform Access（平台接入）→ Connected Clients（已接入客户端）(name/template/hostname/last used).
- Revocation: on the host, "disable client" (reason required, audit-trailed) → all machine tokens are revoked in cascade; remote tool calls immediately get 401. On the remote side, `connect_reset` only clears local credentials.
- Security baseline: access codes are stored hashed (displayed exactly once at creation), consumed on first use, TTL configurable (default 15 minutes), with per-source-IP failure lockout (5 failures per 15-minute window); machine credentials, equivalent to passwords, are stored only on the remote machine (mode 0600); client tool proxying goes through the host's `/api/tools/execute`, with per-tool RBAC checks and full auditing.

### 4.4 FAQ

| Symptom | Resolution |
|---|---|
| `connect_setup` reports "access code invalid" | The code was already used / expired / revoked (one-time consumption); create a new one on the host |
| "Host unreachable" | Check the host listens on 0.0.0.0 and firewall rules; the address must include `http://` and the port |
| Tool execution fails 403 missing permission point | Permission template too narrow; on the host, disable the client and re-onboard with a higher-template access code |
| Remote still shows configured after disabling | Local credential still present but invalid; run `connect_reset` on the remote side to clear it |

---

## 5. One-shot Agent instruction (paste the whole block to the dsh built-in Agent)

> Usage: send the entire instruction block below to the dsh Agent, replacing the `<...>` placeholders; the Agent completes deployment and verification on its own and reports back.
> In production, a human should first confirm the placeholders and password strength; the instructions carry built-in guardrails (no demo data, never overwrite an existing data directory, high-risk operations go through approval).

```text
[TASK] Deploy "YuanBingKe Unified Enterprise AI Resource Management Platform" (元冰可 · 企业 AI 资源统一管理平台)
on <target server, e.g. 10.0.0.5 or this machine> and complete verification.
Repository: <git clone URL, e.g. git@github.com:01men/ybkkasi.git>; deploy directory: <e.g. /opt/ops-platform>;
listen port: <7300>; admin password: <ADMIN_PASSWORD strong password>; attach dsh runtime after deployment: <yes/no>.

[STEPS]
1. Environment check: confirm Node ≥ 22.6 (node -v). If not satisfied, stop and report — do not upgrade
   the system Node on your own.
2. Get the code: clone (or, if the directory exists, git pull) into the deploy directory; record the commit hash.
3. Install dependencies: npm install.
4. Production initialization: set the ADMIN_PASSWORD environment variable; start with --port <port>
   --data <deploy dir>/data (prefer systemd/PM2 supervision). Iron rule: NEVER set DEMO_SEED=1; if the data/
   directory already exists and is non-empty, treat it as an existing instance — stop and ask a human to
   confirm; do not overwrite.
5. Health verification (all must pass to count as success):
   a. GET / returns 200;
   b. POST /api/auth/login (admin + password) returns a token;
   c. GET /api/overview (Bearer token) returns 200;
   d. npm run selftest passes in full; npm run lint:manifests passes with zero errors (pass count as of the latest run).
6. (Optional, only if "attach dsh" = yes) generate the overlay per section 3 of docs/deploy-enterprise.md and
   start with pnpm dsh web --patch; validate /rq with isolated data and never share a data directory between processes.
7. Report: commit hash, service address, whether the admin first login succeeded, selftest results, and how the
   initial password was delivered (never paste it in plaintext into public channels).

[GUARDRAILS]
- Every high-risk operation (offline/revoke/delete) must go through a platform approval ticket with an audit
  trail; no bypassing.
- Read-only commands may run freely; use --dry-run only for commands that explicitly support it. Do not assume it prevents writes for other commands.
- After deployment, change the admin initial password immediately and create enterprise-owned accounts
  (see skills/dsh-ops-iam).
```

---

## 6. Acceptance checklist

- [ ] `GET /` returns 200 and the Console logs in (admin + `ADMIN_PASSWORD`)
- [ ] `npm run selftest` all green, `npm run lint:manifests` zero errors (counts as of the latest run)
- [ ] The production data directory contains **no** demo data (`data/iam~users.json` has no demo accounts such as ops/hr/dev)
- [ ] `GET /api/platform/bootstrap` returns `initialPasswordPending:false` (initial password takeover completed)
- [ ] (Shape B) `dsh web` is running and the Agent can answer `dshctl mcp list`-style questions
- [ ] (Shape C) the remote computer's `connect_status` shows remote mode; the host's Platform Access（平台接入）page lists the client
- [ ] Backup policy in place (scheduled cold copy of the `data/` directory)
- [ ] The admin initial password has been changed, and the demo password `Ybk@2026` cannot log in
      (demo credentials are for demo environments only — never enable `DEMO_SEED=1` in production)
- [ ] (Optional supply-chain hardening) `GET /api/update/status` shows `releaseKeyConfigured:true`

---

## 7. Regional deployment notes

Added for international readers; framed as capabilities, not certifications.

- **Time zones.** Usage/metering events are stamped in ISO 8601 UTC (`occurred_at`; monthly report windows `[first day of month 00:00, first day of next month 00:00)` in UTC). Platform console logs, by contrast, are written in the server's local time — when operating across regions, convert explicitly and record the server's time zone in your runbook. Report months are passed as `YYYY-MM`.
- **Rate-limited / intranet networks.** The built-in update check calls the GitHub API (unauthenticated: 60 requests/hour/IP). On rate-limited networks set `GITHUB_TOKEN`, or point the platform at a private mirror with `DSH_UPDATE_API_BASE` / `DSH_UPDATE_RAW_BASE`. All other platform traffic stays inside your deployment boundary.
- **Data residency.** The platform is self-hosted by design: with on-premises (private) delivery, all data — identities, metering events, audit logs, SQLite stores — remains inside the enterprise's own boundary; private project-based delivery is available (currently oriented to manufacturing customers). This is a deployment capability statement: no third-party compliance certification (e.g., SOC 2, ISO 27001) is claimed; those are on the roadmap (Roadmap).
