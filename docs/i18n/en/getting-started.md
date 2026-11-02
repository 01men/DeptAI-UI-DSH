> **English edition** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source: `README.md`, `docs/deploy-enterprise.md` · Source baseline: 2026-10-15 · Glossary: [GLOSSARY.md](../GLOSSARY.md) · Governance: [README.md](../README.md)

# YuanBingKe (ybkk-AIOS) — Getting Started


This guide takes you from zero to a running, verified YuanBingKe instance: prerequisites, both install forms, first-boot baseline initialization, the first login, demo mode, quality gates, CLI first steps, and self-update basics. Production hardening (systemd units, TLS reverse proxy, supply-chain signing, remote dsh access) is summarized in Section 10 and documented fully in the internal Chinese runbook `docs/deploy-enterprise.md`.

**Interface language note:** as of the 2026-10-16 release, the runtime UI — Console（控制台）, login page, CLI output, notifications, error messages — ships with a built-in language switcher: Simplified Chinese (default), English (US), and Japanese. Switch via the top-bar selector; the preference is stored in the browser (`rq_lang`); the CLI follows `--lang` or `DSHCTL_LANG`; any string not yet covered by a dictionary gracefully falls back to Chinese. UI locations below are annotated bilingually on first mention, e.g. **Organization & Accounts（组织与账号）** — the bilingual 'English（中文原文）' annotations remain useful for navigating screenshots, on-prem deployments pinned to Chinese, and protocol-adjacent labels; browser page translation also still works. Platform logs carry server-local timestamps — convert time zones when correlating events.

## 1. Prerequisites

| Requirement | Detail |
|---|---|
| Node.js ≥ **22.6** | Check with `node -v`. The server runs native TypeScript — there is **no build step** — so older Node versions cannot start it. Do not try to bypass this. (`node:sqlite` reports "Experimental" under Node 24; harmless.) |
| A terminal | bash / zsh / PowerShell all work. |
| Network access (first install only) | `npm install` fetches dependencies, including `@deepseek-ai/cordis`. |
| An existing dsh host (bundle form only) | Only for install form B below. |

## 2. Choose an install form

| Form | Command | Entry point | Choose when |
|---|---|---|---|
| **A. Independent process** (default) | `npm install && npm start` | `http://127.0.0.1:7300` (platform's own port) | you want the standalone platform: Console + REST API + tools bridge |
| **B. dsh bundle mount** | `dsh plugin --profile web add github:01men/ybkkasi` | the dsh web port becomes the **single entry**; the YuanBingKe data plane (REST / Console SPA / docs / MCP) is mounted under the **`/rq` prefix** | you already run a dsh (DeepSeek Harness) host and want the platform mounted into it, with operations tools visible to models |

Form B installs all 25 plugin entries in one command. Verify the mount with:

```bash
dsh --profile web --dump-config   # should list the ops-* plugin entries
```

Then, in a dsh session, ask "list all MCP services and their health" — the model should call the `mcp_service_list` tool rather than answer statically. Ecosystem mechanics (single cordis instance constraint, plugin anatomy, marketplace) are in [dsh-ecosystem.md](dsh-ecosystem.md).

Both forms perform the same first-boot **baseline initialization** on an empty data directory (next section). Optional flags: `npm start -- --port 7300 --data ./data` choose the port and data directory. What lands on disk: business configuration as JSON collections with atomic persistence, plus metering/usage data in SQLite at `data/txnstore.db` (WAL + transactions). Back up the whole data directory (cold backup) — that is the complete state of the platform.

## 3. First boot: baseline initialization

On an empty data directory the platform initializes the production shape: **built-in roles + root organization + platform administrator `admin`** — and nothing else. No demo data is created.

- The `admin` password is taken from the `ADMIN_PASSWORD` environment variable. **In production, always set it explicitly**:

  ```bash
  export ADMIN_PASSWORD='<strong password>'    # PowerShell: $env:ADMIN_PASSWORD='...'
  npm start
  ```

- If `ADMIN_PASSWORD` is not set, a random password is generated once, written to `data/admin-initial-password.txt`, and printed in the boot log. Read it and take over the account immediately (Section 4).
- Successful first boot prints a baseline-initialization completion line and a "go-live three steps" guidance box in the log, then serves the Console.

Health check:

```bash
curl -s http://127.0.0.1:7300/api/health        # expected: {"status":"ok",...}
curl -s http://127.0.0.1:7300/api/platform/bootstrap
# expected while the initial password file still exists: {"initialPasswordPending":true}
```

If you ever lose the `admin` password: either wipe the data directory and restart (re-running baseline initialization), or have an administrator holding the `iam.user.write` permission point reset it in the Console under **Organization & Accounts（组织与账号）→ Account Details（账号详情）→ Reset Password（重置口令）**.

## 4. First-login walkthrough

1. Open `http://127.0.0.1:7300` and sign in at the Console login page as `admin`.
2. While `data/admin-initial-password.txt` still exists on the server, the login page shows a yellow "first deployment" banner (driven by `initialPasswordPending`). Change the password first: top-right avatar → **Change Password（修改密码）**.
3. Delete `data/admin-initial-password.txt` on the server. Verify takeover is complete:

   ```bash
   curl -s http://127.0.0.1:7300/api/platform/bootstrap
   # expected after change + delete: {"initialPasswordPending":false}
   ```

4. Explore: the Console opens on a role workbench (pending approvals + alerts + event stream + cost trend); the **Cmd+K command palette** searches resources and jumps to pages; every detail opens in a right-side drawer. API equivalent of the overview page:

   ```bash
   curl -s -X POST localhost:7300/api/auth/login -H 'content-type: application/json' \
        -d '{"username":"admin","password":"<your password>"}'          # returns a token
   curl -s localhost:7300/api/overview -H "authorization: Bearer <token>"
   ```

5. (Optional hardening) HTTP security response headers are on by default (nosniff / SAMEORIGIN / Referrer-Policy); leave them on unless you have a specific reason: `SECURITY_HEADERS=off` disables.

## 5. Demo mode (evaluation / training only)

```bash
DEMO_SEED=1 npm start
```

Demo mode injects a complete demo dataset on first boot: a demo organization tree, demo accounts, MCP services, skills, agents, applications, and 28 days of synthetic history. All demo accounts share the password **`Ybk@2026`**:

| Demo account | Role | Intended exploration |
|---|---|---|
| `admin` | platform super administrator | everything |
| `ops` | resource administrator | MCP / skill / agent / application management |
| `hr` | organization administrator | organization / accounts / third-party sync |
| `dev` | developer | submitting skills, registering agents |
| `audit` | auditor (read-only) | audit logs and alerting |

**DingTalk mock login:** in demo mode a mock connector enables passwordless login — on the login page choose **DingTalk Scan（钉钉扫码）** and enter the mock employee ID `DD0002`. Production baselines configure no connectors, so the third-party login entry is hidden automatically.

> **Warning — never enable `DEMO_SEED=1` in production.** Demo credentials are public knowledge (they are printed in this documentation precisely because they are demo-only). The production acceptance checklist verifies that the data directory contains no demo accounts and that `Ybk@2026` cannot log in.

## 6. Quality gates

Run both gates after installation and after every upgrade. They operate on an isolated instance (separate port + separate data directory) and never touch your production data.

```bash
npm run selftest         # end-to-end functional self-test; must be all green.
                         # Assertion count is "as of the latest run" (recent runs: ≥ 1,380 assertions) —
                         # historical counts are void by design.
npm run lint:manifests   # five-face YAML validation of plugin manifests; expected: 0 red
```

The self-test covers login / RBAC and privilege escalation, freeze → token revocation chains, MCP canary / rollback / gateway authorization (including read-only constraint interception), skill malicious-submission rejection and two-tier approval, agent lifecycle and L4 single-approver execution, on-behalf-of chains, metering idempotency and reconciliation, OIDC SSO full flows, NAS and the `/mcp` endpoint, remote dsh access, and security attack drills (state / code / refresh-token replay, uniqueness-constraint conflicts).

## 7. CLI first steps

The `dshctl` CLI talks to the REST API and supports `--output json|table`, `--dry-run`, and `--yes`. Credentials come from environment variables (`DSHCTL_TOKEN` as an alternative):

```bash
export DSHCTL_URL=http://127.0.0.1:7300     # default; adjust for remote hosts
export DSHCTL_USER=admin
export DSHCTL_PASS='<your password>'

node cli/dshctl.mjs help                    # command tree (Chinese by default; --lang or DSHCTL_LANG to switch)
node cli/dshctl.mjs mcp list --output json  # first useful read
node cli/dshctl.mjs update status           # self-update state
```

The CLI covers the full surface: `mcp` / `skill` / `agent` / `app` / `nas` / `credential` / `approval` / `plugin` / `usage` / `connect` / `update` command groups. A few representative operations:

```bash
node cli/dshctl.mjs agent offline <id> --reason="consecutive failures"   # raises an L4 approval ticket
node cli/dshctl.mjs approval decide <id> --decision=approve --opinion="confirmed"
node cli/dshctl.mjs credential list                                      # machine credential inventory
```

Tip: prefer an `ops`-type account for day-to-day CLI work rather than `admin`. All high-risk operations (offline / revoke / delete) go through L4 approval tickets and are audit-trailed; preview changes with `--dry-run` first.

## 8. Platform self-update basics

Both install forms can sense new upstream releases; **the administrator always decides whether to upgrade**.

- **Automatic check** (default): every 24 h, first check 15 s after start. It compares the remote `package.json` version plus the GitHub commit delta. On a new release the Console top bar shows an **Update available（可更新）** badge and a `platform.update.available` event is emitted (audit-trailed). The Console drawer can switch checking off or change its frequency.
- **Manual upgrade:**
  - source checkout form — Console drawer **One-click upgrade（一键升级）** (runs `git pull --ff-only` + `npm install`, with dry-run preview, reason logging, and a restart prompt), or the CLI:
    `node cli/dshctl.mjs update status | check | apply [--dry-run]`;
  - bundle form — run `dsh plugin update` on the dsh host, then restart the dsh host;
  - Agent tools `update_status` / `update_check` / `update_apply` let an MCP-connected agent do the same in-session.
- **Permission points:** `platform.update.read` (view / check), `platform.update.apply` (upgrade).
- Optional supply-chain hardening — generate an Ed25519 release key pair, register the public key, and enable `requireSignedManifests` so update manifests must verify before apply — is documented in the internal runbook `docs/deploy-enterprise.md`.

## 9. Environment variable reference (quick start scope)

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | initial `admin` password; if unset, a random one is written to `data/admin-initial-password.txt` |
| `DEMO_SEED` | `1` injects demo data on first boot — **evaluation only, never production** |
| `USAGE_RETENTION_DAYS` | usage event retention, default 730; `0` = keep permanently |
| `SECURITY_HEADERS` | `off` disables default-on HTTP security response headers |
| `GITHUB_TOKEN` | raises GitHub API limits for update checks |
| `DSH_UPDATE_API_BASE` / `DSH_UPDATE_RAW_BASE` | point update checks at a private mirror |
| `DSH_UPDATE_AUTO_CHECK` | `off` disables the automatic update check |
| `DSHCTL_URL` / `DSHCTL_USER` / `DSHCTL_PASS` / `DSHCTL_TOKEN` | CLI connection and credentials |

## 10. Production readiness checklist (summary)

Adapted from the internal deployment runbook; each item has a verification command there.

- [ ] `node -v` ≥ 22.6; service runs under a process supervisor (systemd unit provided in the runbook)
- [ ] `GET /` returns 200; Console login works with the `ADMIN_PASSWORD` you set
- [ ] `data/admin-initial-password.txt` deleted; `GET /api/platform/bootstrap` shows `initialPasswordPending:false`
- [ ] `npm run selftest` all green and `npm run lint:manifests` 0 red (isolated instance)
- [ ] Production data directory contains **no demo accounts**; `Ybk@2026` cannot log in
- [ ] Data directory cold-backup schedule in place
- [ ] (If dsh-mounted) `dsh --profile web --dump-config` lists the ops-* entries; agent answers `mcp list`-type questions via tools
- [ ] (Optional) update-check settings: private mirror / `GITHUB_TOKEN` / `DSH_UPDATE_AUTO_CHECK=off`; signed release manifests enabled

## 11. Troubleshooting quick table

| Symptom | Likely cause and fix |
|---|---|
| Server exits at start, TypeScript cannot run | Node < 22.6 — upgrade Node; do not bypass |
| Port already in use | an orphan process holds the port — stop it before restarting (the runbook ships a port-guard script) |
| Anonymous `curl` to an unknown `/api/*` path returns 401, not 404 | by design: the auth middleware runs before routing; there is no route-existence side channel |
| DingTalk login entry missing on the login page | production baseline configures no connectors — third-party entry auto-hides; configure the DingTalk connector for real use |
| Login page shows a yellow banner | expected until the initial password is changed and `data/admin-initial-password.txt` is deleted (Section 4) |
| Agent answers from memory instead of calling tools (bundle form) | the bundle is not mounted, or a second cordis instance is loaded — re-check that `dsh --profile web --dump-config` lists the ops-* entries; see [dsh-ecosystem.md](dsh-ecosystem.md) §3.2 |
| `admin` password lost | wipe the data directory and restart, or reset via an `iam.user.write` administrator (Section 3) |
| Demo accounts missing | baseline initialization is demo-free by design; use `DEMO_SEED=1` on a fresh data directory for evaluation |

## 12. Next steps

- [README.md](README.md) — what the platform is, architecture, M0 compliance posture
- [dsh-ecosystem.md](dsh-ecosystem.md) — plugin anatomy, marketplace, host bridge, ecosystem roles
- [user-guide.md](user-guide.md) — feature usage guide across all domains (build your real organization structure, connectors, and asset lifecycle next)
- [app-sso-integration.md](app-sso-integration.md) — onboard your first in-house AI application via OIDC SSO
- [product-introduction.md](product-introduction.md) — positioning one-pager to share with stakeholders
- [release-notes-summary.md](release-notes-summary.md) — what shipped in each batch
- Internal Chinese references (governing originals): repo root `README.md`, `docs/deploy-enterprise.md` (production runbook), `docs/app-sso-integration.md` (SSO onboarding)
