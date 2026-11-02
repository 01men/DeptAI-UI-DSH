> **English edition** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source: `llms.txt`, `README.md` · Source baseline: 2026-10-15 · Glossary: [GLOSSARY.md](../GLOSSARY.md) · Governance: [README.md](../README.md)

# YuanBingKe (ybkk-AIOS) — Product Introduction


**YuanBingKe** (original Chinese brand: 元冰可; product code name **ybkk-AIOS**) is a self-hosted enterprise AI resource management platform. It gives enterprises one identity system, one permission model, one usage meter, and one audit trail for six classes of AI assets — with usage transparency and internal cost pass-through as the only money-adjacent surfaces. This page is the positioning one-pager for marketing and sales enablement. The fuller product panorama is in [README.md](README.md).

**At a glance:** 6 managed asset types · 25 plugin entries in one dsh bundle install · 40+ operations tools exposed to any MCP client (as of the latest release) · 4 audit log classes · 730-day default usage retention (`USAGE_RETENTION_DAYS`) · zero monetary settlement semantics.

## 1. The problem

Enterprises adopting AI accumulate resources faster than they can govern them:

- **Fragmentation.** MCP services, skill packages, agents, in-house AI applications, model accounts, and file shares each come with their own console, their own accounts, and their own logs. Nobody can answer "what AI assets do we have, who owns them, and what state are they in?"
- **No unified identity or permissions.** There is no enterprise-wide answer to "which employee or agent may invoke which resource?" Access control is ad hoc per tool, there is no scene-level authorization (`sceneCode`), and there is no go-live gate forcing internal AI applications onto the corporate identity system.
- **No metering or audit.** Consumption (tokens, calls, storage) is invisible or estimate-only; there is no per-department, per-agent, per-skill view of usage; and when something goes wrong there is no trustworthy audit trail linking a human, an agent, and an action.
- **Uncontrolled spend.** Without metering, model spend is opaque, budgets cannot be enforced (the platform ships budget circuit breakers at the model-gateway and agent-principal level), and idle or runaway agent runs go unnoticed.

## 2. The solution

YuanBingKe registers all six asset types into a single platform running inside the enterprise boundary:

- **Unified identity and access.** Multi-level organization tree, roles / user groups, permission-point matrix, OIDC SSO for in-house applications, DingTalk directory sync with scheduled auto-sync, and on-behalf-of token chains so every machine action stays attributable to a human.
- **Lifecycle governance.** Every asset type has a draft → validate → canary → full rollout path (or its domain equivalent), immutable releases, one-click rollback, and L4 mandatory approvals for dangerous operations (go-live / offline / delist / revoke) with reason capture and result write-back.
- **Transparent usage metering.** An idempotent schema-versioned pipeline records every invocation; monthly reports aggregate by department, agent, and skill tokens with CSV self-service export; FinOps views show cost pass-through, cost per DAU, and idle-run detection.
- **One audit plane.** Four audit log classes, an alert rule engine, audit evidence anchors with scene-dimension timelines, and unauthorized-access counting alerts — one place to answer auditors.

**Before / after, in one table:**

| Question | Typical enterprise today | With YuanBingKe |
|---|---|---|
| What AI assets exist? | spreadsheets, tribal knowledge | asset registry with ownership, health, lifecycle state |
| Who may use what? | per-tool ad hoc accounts | permission points, scene-level authorization, machine credentials |
| What did it cost us? | monthly invoice surprises | zero-price snapshot metering + internal cost pass-through, cost per DAU |
| What did the agent do? | unknowable | on-behalf-of chains + four audit log classes |

### 2.1 Capability → value map

| Capability | What it replaces / unlocks |
|---|---|
| Unified IAM + OIDC SSO | per-tool local accounts; "does this app support SSO?" becomes "yes — it cannot go live without it" (app go-live gate) |
| MCP deployment service | hand-edited server configs and direct-to-production releases; canary + rollback become standard |
| Skill Marketplace | prompt sharing through chat threads; versions, scanning, and approvals instead |
| Agent registry + on-behalf-of | unattributable automation; every machine action chains back to a human |
| Model Access Gateway | scattered API keys and shadow model spend; channels, fallbacks, and budget circuit breakers instead |
| NAS onboarding + data permissions | ungoverned file shares; default-deny RBAC and signed downloads |
| Usage metering + FinOps | invoice surprises; department × model cost matrices and cost per DAU |
| Audit + L4 approvals | "who did what?" archaeology after incidents |

### 2.2 Proof points

- The end-to-end self-test must be all green before every release — recent runs at ≥ 1,380 assertions (as of the latest run; historical counts are void by design) — plus a full-chain drill across the six asset types (≥ 37 steps) and plugin-manifest lint with zero red.
- Self-tests include security attack drills: OAuth state / code / refresh-token replay, uniqueness-constraint conflicts, and privilege-escalation probes.
- Every L4-class dangerous operation (go-live / offline / delist / revoke) requires an approval ticket with a mandatory reason; results are written back and audited.
- All statements in this document reflect the 2026-10-15 baseline of the Chinese originals.

## 3. The six asset types

### 3.1 MCP services (MCP deployment services)

Register Model Context Protocol servers, deploy them through draft → validate → canary → full rollout, and expose them to consumers behind a token gateway with permission groups, per-tool constraints, and read-only modes. Releases are immutable, rollback is one click, and health-based circuit breaking stops broken services from being called. P95 latency, success rates, and token consumption are monitored over a real HTTP transport.

### 3.2 Skills (Skill Marketplace)

Skill packages — the prompt-plus-procedure documents that teach agents domain work — are submitted, statically scanned for malicious code and leaked secrets, approved through a two-tier process, and published as immutable versions with Ed25519 contract signature verification. Installed skills register their dependencies, warn referencing agents when deprecated, and can store their packages on an onboarded NAS.

### 3.3 Agents (Agent registry)

Every agent receives machine credentials and a registered identity; human users delegate through on-behalf-of token chains that keep the audit trail intact. Agents carry autonomy levels (A0–A3), support agent-to-agent (A2A) named invocation, and can be organized with roles, ranks, and reporting lines. The Execution Hub adds goal alignment, heartbeats, execution locks, and routine scheduling so agents do real work without colliding.

### 3.4 AI applications

In-house AI apps are registered assets with orchestration topology in one SVG view and PV/UV/DAU metrics gathered both from active reporting and from a public visitor beacon. Onboarding to the corporate identity system is enforced by an app go-live gate: an application cannot go online without an active OIDC SSO client attached.

### 3.5 Model routes (Model Access Gateway)

All model calls flow through an OpenAI-compatible gateway that does real forwarding only — a model without a configured endpoint is refused, never answered with fabricated completions. Channel governance adds tiered routing, channel-group fallback chains, and budget circuit breakers; per-channel health and capability drift are detected at runtime.

### 3.6 NAS file storage (NAS asset onboarding)

Existing NAS devices are onboarded as managed assets and operated exclusively through an MCP file gateway (no direct DSM private API calls), with one-click import of existing `mcpServers` configurations. Organization-location + role-hierarchy RBAC decides access with default-deny and full decision logging; downloads use HMAC-signed URLs; file ownership is tracked through rename and delete.

### 3.7 How the six work together

The types compose rather than compete. A skill package can be stored on an onboarded NAS; an agent invokes MCP services through the token gateway and models through the Model Access Gateway; an AI application reaches SSO through the identity plane and reports its own metrics back; every path lands in the same metering pipeline and the same audit trail. One registration, one permission decision, one bill of usage — regardless of type.

## 4. Differentiators

### 4.1 "Everything is a plugin"

The platform itself is a cordis plugin tree on the dsh (DeepSeek Harness) framework: 25 plugin entries in one bundle install, each independently start-stoppable, each declaring its own dependencies, permission points, and events. Capabilities extend without forking the core — and the same plugin tree can run standalone or mounted into a dsh host. See [dsh-ecosystem.md](dsh-ecosystem.md).

### 4.2 Usage transparency with zero-price snapshot + internal cost pass-through

The platform is deliberately not a billing system: the price book records a zero-price snapshot (charge always 0) while keeping an internal procurement cost reference, so the enterprise sees exactly who consumed what and what it cost internally — without any monetary settlement semantics. M0 (2026-09-09) abolished charging, resale, and revenue share permanently; the former wallet subsystem was decommissioned and sealed.

### 4.3 Self-hosted, with on-premises delivery for manufacturing

All data stays inside the enterprise boundary (JSON collections + SQLite on your own disks). For manufacturing customers, private project-based delivery is available. Self-hosting is also the data-residency path for European deployments; formal certifications (SOC 2 / ISO 27001) are on the roadmap, not held today.

### 4.4 Platform self-update

The platform checks upstream releases (default every 24 h), surfaces an **Update available（可更新）** badge in the Console top bar, and the administrator — only the administrator — decides whether and when to upgrade, with dry-run preview, reason logging, and audit trail. Optional signed release manifests add supply-chain hardening.

### 4.5 Platform as an MCP server

40+ operations tools (as of the latest release) are exposed at `POST /mcp` (Streamable HTTP JSON), so any MCP client — ZCode, Claude, Cursor — can operate the platform under the same Bearer tokens and per-tool permission points as human operators. In a dsh host, the same tools enter the native ToolRuntime, so agents operate the platform in plain language.

### 4.6 Honest engineering

No fabricated model completions; no silent mock transports in production paths (demo transports are explicitly labeled); TTFT telemetry honestly omitted rather than estimated; test stubs that are real in-process HTTP services; quality gates that must pass before every release (`npm run selftest`, `npm run lint:manifests`).

### 4.7 Governance where the work happens

Governance is not a separate compliance module bolted on: scene-level authorization (`sceneCode`, deny → allow → fail-closed) governs concrete task entry points; a persistent Notification Center（通知中心） and Approval Center（审批中心） route L4 tickets to the right humans; audit evidence anchors and scene-dimension timelines make answers to auditors a lookup, not a project.

## 5. Who it is for

| Persona | What they do in YuanBingKe |
|---|---|
| **Platform admin** | Owns baseline initialization, administrator accounts, connectors, self-update, and platform-wide settings. Works in the Console（控制台） and with the `dshctl` CLI. |
| **Resource admin** | Day-to-day management of MCP services, skills, agents, and applications: deployments, canary releases, health inspections, marketplace approvals (demo account `ops`). |
| **Org admin** | Organization tree, accounts, roles / user groups, and third-party (DingTalk) directory sync (demo account `hr`). |
| **Developer** | Submits skills, registers agents, and integrates in-house applications via SSO, the roster API (`GET /api/iam/roster`), and org-sync endpoints (demo account `dev`). |
| **Auditor** | Read-only access to the four audit log classes, alerts, usage reports, and FinOps views (demo account `audit`). |
| **Team lead** | Reads department usage and cost pass-through dashboards in **FinOps View（财务视图）**, watches cost per DAU, and acts on pending approvals. |

A typical first week: the platform admin runs the baseline initialization and invites the org admin to sync the DingTalk directory; the resource admin deploys the first MCP service through canary; the developer submits a skill and registers an agent with machine credentials; the auditor watches the first L4 approval flow end to end; the team lead opens the first monthly usage report.

Surfaces each persona works in:

| Persona | Console（控制台） | `dshctl` CLI | MCP tools / `/mcp` |
|---|---|---|---|
| Platform admin | full Console | full command tree | operations tools incl. `update_*` |
| Resource admin | registries, marketplace, Asset Operations（资产运营） | `mcp` / `skill` / `agent` / `app` groups | `mcp_service_list`, `skill_search`, ... |
| Org admin | Organization & Accounts（组织与账号） | connector and roster commands | — |
| Developer | Skill Marketplace page, app SSO tabs | `skill submit`, `app report`, `usage record` | `skill_search` |
| Auditor | audit, alerts, FinOps View（财务视图） | read commands with `--output json` | read-only tools |
| Team lead | workbench, cost dashboards | — | — |

## 6. What it is NOT

- **Not a billing or settlement system.** No wallets, top-ups, revenue splits, or chargeable events exist anywhere in the product. The M0 posture (2026-09-09) is permanent external communication: transparent usage + internal cost pass-through only.
- **Not a model provider.** The gateway forwards to your configured model endpoints; it sells no tokens and resells nothing.
- **Not a single-language-interface product anymore, but not fully translated everywhere either.** As of the 2026-10-16 release the runtime UI (Console / Panel / Portal / CLI output / notifications / errors) ships with a built-in language switcher — Simplified Chinese (default), English (US), Japanese — via `--lang` / `DSHCTL_LANG` for the CLI and a top-bar selector (`rq_lang`) for the web UI. See the interface language note below.
- **Not certified (yet).** SOC 2, ISO 27001, and formal DPA processes are roadmap items, not held credentials.
- **Not a demo-toy.** Demo data exists only behind an explicit `DEMO_SEED=1` opt-in, which production deployments must never enable.

## 7. Interface language note

As of the 2026-10-16 release, the runtime UI ships with a built-in language switcher: Simplified Chinese (default), English (US), and Japanese. Switch via the top-bar selector; the preference is stored in the browser (`rq_lang`). The CLI follows `--lang` or `DSHCTL_LANG`. Any string not yet covered by a dictionary gracefully falls back to Chinese. The bilingual 'English（中文原文）' annotations in this guide — for example **Organization & Accounts（组织与账号）** — remain useful for navigating screenshots, on-prem deployments pinned to Chinese, and protocol-adjacent labels; browser page translation also still works on the plain-DOM UI.

## 8. Deployment and commercial fit

Two supported forms out of the box: an independent process (`npm install && npm start`, default `http://127.0.0.1:7300`) or a dsh bundle mount (`dsh plugin --profile web add github:01men/ybkkasi`, data plane under the `/rq` prefix). Commercially, YuanBingKe is priced by "team + domain assets" (industry knowledge-graph packs / scenario packs), with private on-premises project delivery available for manufacturing customers. See [getting-started.md](getting-started.md) for the hands-on path.

Market talking points, by region (positioning guidance from the i18n governance notes — not legal advice): for US buyers, lead with self-hosting, governance ROI, and the honest certification roadmap; for Europe, self-hosting and on-prem delivery are the data-residency path (a formal GDPR DPA process is roadmap); for India, emphasize the scale elasticity of "team + domain assets" pricing (DPDP awareness); for Africa, data sovereignty and low-bandwidth, low-dependency operations (plain-Markdown docs, no cloud dependency); for Japan, note the explicit roadmap labeling and the built-in Japanese interface (APPI awareness); for Singapore, the English edition is the official version (PDPA awareness).

### 8.1 Two questions we are asked

- **"Does it support multi-company / multi-subsidiary groups?"** Yes — registries and approvals scope to organization subtrees, with explicit cross-subtree requests rejected (implemented in the Execution Hub governance closure, 2026-10-14).
- **"What if we want to stay on the version we deploy?"** You can: self-update is administrator-controlled end to end — automatic checks can be tuned or disabled (`DSH_UPDATE_AUTO_CHECK=off`), checks can point at a private mirror, and upgrades require an explicit apply with dry-run and audit.

## 9. Learn more

- [README.md](README.md) — product panorama, architecture, M0 compliance posture
- [getting-started.md](getting-started.md) — install, first boot, demo mode, CLI
- [dsh-ecosystem.md](dsh-ecosystem.md) — the DSH ecosystem and plugin marketplace
- [usage-reporting.md](usage-reporting.md) — usage transparency and FinOps reporting in depth
- [release-notes-summary.md](release-notes-summary.md) — release history from M0 to the latest batch
- Roadmap items (additional UI languages beyond zh-CN / en-US / ja-JP, compliance packs, docs portal) are tracked in the governance README [../README.md](../README.md) §六.
