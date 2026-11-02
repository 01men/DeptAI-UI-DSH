# Release History Summary (M0 to Latest Batch)

> **English edition** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source: `docs/internal/release-notes-2026-09-09-m0.md` through `docs/internal/release-notes-20261015-audit-remediation.md`, `docs/internal/重构基线-阶段1-20261013.md`, `docs/internal/重构基线-阶段2-20261013.md`, `docs/internal/design-adaptation-spec-20261014.md`, `docs/internal/数字员工二期开发计划-20261015.md`, `llms.txt` · Source baseline: 2026-10-15 · Glossary: [GLOSSARY.md](../GLOSSARY.md) · Governance: [README.md](../README.md)

> Scope note: per i18n governance, the per-batch Chinese release notes remain **internal engineering assets** and are not translated in full. This page is the consolidated external-facing summary for international readers. Each row links the authoritative Chinese original.

For 元冰可 (YuanBingKe / ybkk-AIOS), the Enterprise AI Resource Management Platform.

## Interface language note

As of the 2026-10-16 release, the runtime interface (Console, Panel, Portal, CLI output, notifications, error messages) ships with a built-in language switcher: Simplified Chinese (default), English (US), and Japanese — superseding the 2026-10-13 Chinese-only decision. Switch via the top-bar selector; the preference is stored in the browser (`rq_lang`). The CLI follows `--lang` or `DSHCTL_LANG`. Any string not yet covered by a dictionary gracefully falls back to Chinese. The bilingual 'English（中文原文）' annotations used in the English docs remain useful for navigating screenshots, on-prem deployments pinned to Chinese, and protocol-adjacent labels.

---

## 1. Chronology at a glance

| Date | Milestone | One-line summary | Chinese release note |
|---|---|---|---|
| 2026-09-09 | **M0 — compliance convergence** | Billing/settlement retired and sealed; zero-price snapshot (charge always 0); usage transparency with the frozen J4 report contract | [release-notes-2026-09-09-m0.md](../../internal/release-notes-2026-09-09-m0.md) |
| 2026-09-11 | **Optimization batch (M1-1)** | J1/J2/J3/J4 contract freeze v1 completed; security response headers default-on; usage retention policy (730 days) | [release-notes-2026-09-11-optimization.md](../../internal/release-notes-2026-09-11-optimization.md) |
| 2026-09-11 | **IAW gap batch** | 19/20 handoff items landed: flow-core orchestration, Data Asset Domain, model channel governance, Agent autonomy (A0–A3) + A2A, scene-level authorization, audit evidence anchors, Notification Center | [release-notes-2026-09-11-iaw-batch.md](../../internal/release-notes-2026-09-11-iaw-batch.md) |
| 2026-09-12 | **QA fix batch** | P1 7/7 + P2 12 + toolchain fix: organization isolation enforced, J4 aggregation bug fixed, bus feedback loop cut, L4 approvals require explicit confirmation | [release-notes-2026-09-12-qa-fixes.md](../../internal/release-notes-2026-09-12-qa-fixes.md) |
| 2026-09-13 | **QA fix batch** | 15 security/correctness fixes (PATCH whitelists, secret-hash leak, input validation, idempotent role migration); plugin market confirmed single-tier approval | [release-notes-2026-09-13-qa-fixes.md](../../internal/release-notes-2026-09-13-qa-fixes.md) |
| 2026-09-15 | **Approval relaxation** | Business decision: same person may complete both Skill approval tiers and self-approve own tickets; rejected records deletable; high-risk confirmation untouched | [release-notes-2026-09-15-approval-relax.md](../../internal/release-notes-2026-09-15-approval-relax.md) |
| 2026-09-16 | **M2 — FinOps report v1 + deployment productization** | CFO-view cost pass-through + idle-run detection v1 (disclosed heuristic), `#/finops` page, first-run bootstrap experience, Ed25519 release-manifest signing | [release-notes-2026-09-16-m2.md](../../internal/release-notes-2026-09-16-m2.md) |
| 2026-10-13 | **REFACTOR baseline (stages 1–2)** | Structural debt cleared (console split 4,702→300 lines, auth boilerplate unified); **monolingual Chinese UI decision** (R1) + protocol-key glossary table R10 (280 keys) | [重构基线-阶段1-20261013.md](../../internal/重构基线-阶段1-20261013.md) · [阶段2](../../internal/重构基线-阶段2-20261013.md) |
| 2026-10-14 | **Design adaptation batch** | CIO-dashboard visual adaptation onto the zero-build SPA (design tokens, drawer-first interactions, `/rq` mount verified); bundle install source migrated to `github:01men/ybkkasi` | [design-adaptation-spec-20261014.md](../../internal/design-adaptation-spec-20261014.md) |
| 2026-10-15 | **Audit remediation batch** | All open review items closed at once: org isolation fail-closed, MCP tool least-privilege, fallback-chain budget guard, `/docs` whitelist, ⌘K palette completion | [release-notes-20261015-audit-remediation.md](../../internal/release-notes-20261015-audit-remediation.md) |
| 2026-10-15 | **W batch — digital workforce phase 2** | MCP tool trust-risk registration (V11 root fix), REST/Panel surface parity, usage proxy-reporting whitelist, `workforce.admin` ops surface, gray delivery package with six-gate verification | [数字员工二期开发计划-20261015.md](../../internal/数字员工二期开发计划-20261015.md) + `llms.txt` |

---

## 2. How the history reads — three eras

- **Era 1 — Commercial convergence (September 2026, M0 → M2)**: the platform decided what it is *not* (no billing), froze its external interface contracts (J1–J4, C1–C3), absorbed two QA-driven hardening rounds, deliberately relaxed two approval restrictions on business request, and shipped the first CFO-facing analytics.
- **Era 2 — Refactor and design (2026-10-13 / 10-14)**: internal quality — structural debt, the monolingual-UI decision with its ASCII protocol-key carve-out, and a full visual adaptation of the Console.
- **Era 3 — Hardening and workforce (2026-10-15)**: every still-open review finding closed in one combined batch, followed by the digital-workforce phase 2 with its risk-registration gate and gray delivery discipline.

Reading conventions across all notes: breaking changes are always announced in an "upgrade notice" section; batches that touch frozen contracts carry a "custom-side sync window" checklist (the custom track uses release notes as its merge translation layer); and every batch ends with a verification record whose numbers are valid for that run only.

---

## 3. September 2026 — commercial convergence and contract freeze

### M0 (2026-09-09): the compliance red line

The most consequential batch for any external reader:

- Usage-based charging, resale, revenue sharing and collection-on-behalf were all terminated; the wallet/ledger subsystem (plugin-billing) was retired and archived (historical flows exported to CSV and registered in the archive document).
- The price book's list side became a **zero-price snapshot** (`charge_cents` always 0); the cost side was kept as an **internal procurement cost reference**.
- All product pages, README and Console copy were scrubbed of settlement language.
- A full API retirement list was published: wallets, recharge, budgets, settle/ledger endpoints removed; subscription endpoints removed; `billing.read` / `billing.write` / `billing.admin` permission points removed (legacy roles auto-ignore them — no data migration needed).
- The replacement surface is the J4 usage report contract (frozen v1): `GET /api/usage/report/monthly?month=YYYY-MM[&format=csv]` with department / Agent / Skill token aggregation. See [usage-reporting.md](usage-reporting.md).

### Optimization batch (2026-09-11): J1–J4 contract freeze v1

Completed the M1-1 exit criteria:

- J1 panel skill/Agent named direct invocation — with honest degradation (soft failure returns 200 + `ok:false`; auth/scope failures return 403/400); metering resource key frozen as `skill:<ID>`.
- J2 unified entry triage and J3 session passthrough contracts frozen; J4 was already frozen at M0.
- Security hardening: security response headers default-on for all HTTP responses (`x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, `referrer-policy: strict-origin-when-cross-origin`); one-switch off via `SECURITY_HEADERS=off`.
- Data governance: usage event retention policy default 730 days (`USAGE_RETENTION_DAYS`, `0` = permanent), with sweep scheduling and an ops purge endpoint.

### IAW gap batch (2026-09-11): capability domains

Landed 19 of 20 handoff items from the custom track:

- **Model channel governance**: tiered data-class routing, channel-group fallback chains (primary/backup-1/backup-2/manual), 7-day channel telemetry — with TTFT **honestly omitted** (`ttftMs=null` with an explicit note) pending a streaming channel — and org/model/platform-level budget circuit breakers (warn events + pre-call blocking).
- **flow-core domain (new)**: TF orchestration + step state machine, template library with contextPack injection, SLA/progress fields, Gantt data ready for frontend rendering; `flow.*` events on the platform bus and Panel SSE fan-out.
- **Agent autonomy and A2A**: autonomy levels A0–A3 plus the `POST /api/agents/:idOrSlug/a2a/invoke` named-invocation endpoint (v1 scope: one-way named invocation + level exposure; negotiation protocols deferred).
- **Data Asset Domain**: dataset registration, four-dimension quality score (completeness/accuracy/timeliness/consistency), reverse lineage tracing, metric-dictionary definition arbitration.
- **Governance**: scene-level authorization (`sceneCode`: deny → allow → fail-closed; falls back to existing RBAC when no policy is configured), audit evidence anchors plus scene timelines, and a persisted Notification Center (30-day retention, 2,000-entry ring, incremental `since` + read cursors).
- New permission points: `flow.read` / `flow.write` / `flow.admin`, `resource.dataset.write`, `iam.scene.write`, `agent.a2a.invoke`.
- Item 7-2 (in-session multi-step plan cards) was **honestly reported as contract-ready but implementation-absent**, pending an Agent streaming channel — no pretend implementation.

### QA batches (2026-09-12 and 2026-09-13)

2026-09-12 closed all 7 P1s and 12 P2s from the quarterly test report. Highlights:

- Cross-organization account takeover blocked (`assertManageScope`: non-platform admins can only manage accounts inside their own organization subtree; unknown-attribution principals fail closed).
- App-owner write guards on all application mutation endpoints.
- A J4 aggregation defect fixed: tokens were undercounted 176× due to SQLite correlated-subquery semantics inside `GROUP BY` (rewritten to per-row `SUM((SELECT …))`; totals now reconcile with the three dimensions).
- Event-bus feedback amplification loop cut (listener errors go straight to dead letters).
- One-click rollback anchored to a persisted snapshot taken before `npm install`.
- Six L4 approval kinds made to require explicit `confirmed=true` (breaking change for custom callers, announced in the note).

2026-09-13 closed 15 more findings from a full-system test round:

- `PATCH /api/iam/users/:id` field whitelist (status/passwordHash no longer mass-assignable — account-takeover vector closed); client-secret-hash masked in responses; approval decision enum validation; negative app metrics rejected; `usage_query` tool given its `usage.read` permission declaration; built-in role migration made idempotent on every startup.
- Product decision recorded the same day: the third-party plugin market uses **single-tier approval** (the "two-tier" wording in the contract was a drafting error; the implementation was always single-tier).

### Approval relaxation (2026-09-15): a deliberate reversal

On business request, three earlier restrictions were consciously lifted:

- The same approver may complete both the domain and security tiers of Skill approval (reversing the 2026-09-13 REL-03 four-eyes rule).
- Submitters may approve/reject their own tickets across all approval kinds (reversing the 2026-09-12 A-05 separation-of-duties block).
- Rejected Skill records and rejected approval tickets became deletable — only the "rejected" terminal state; anything with execution facts is never deletable, and audit logs are untouched.

High-risk approvals still require the explicit second confirmation (`confirmed=true`), and the `approval.decide` permission point is unchanged. **International readers should read this together with the two QA batches above: the stricter rule shipped first, then was relaxed by documented business decision — both directions are audit-trailed.**

### M2 (2026-09-16): FinOps report v1 and deployment productization

- **FinOps report v1 (CFO view)**: department × model cost pass-through matrix, month-over-month comparison, Top-10 consumers, and idle-run detection v1 — explicitly labeled on-page as an approximate heuristic requiring human review, not for performance appraisal — plus the `#/finops` SPA page and one-click Excel-friendly UTF-8 BOM CSV export.
- **First-run experience productized**: baseline-initialization registration, `GET /api/platform/bootstrap` (public, returns only `initialPasswordPending`), the "go-live three steps" startup guide, and the executable deployment checklist (now mirrored in [deploy-enterprise.md](deploy-enterprise.md)).
- **Tech debt closed**: Ed25519 signing infrastructure lifted to platform level with release-manifest verification (`releasePublicKey` / `requireSignedManifests` settings, dry-run + pin-based updates), connector-degradation audit wiring, and final cleanup of billing-era remnants.

---

## 4. October 2026 — refactor, design, and hardening

### REFACTOR baseline (2026-10-13)

- **Stage 1 (structural debt)**: authentication boilerplate converged into a single REST gate; the console monolith split from 4,702 lines to 300, with 14 route-domain files and a modularized IAM frontend.
- **Stage 2 (monolingual convergence)**: the **Chinese-only UI decision** was made official (R1 full localization sweep with a mechanical-token exemption register; the `npm run lint:cjk` gate added), and **R10 — the protocol-key Chinese glossary table** — was produced: 280 keys across six sections (events 80 / permission points 79 / error codes 37 / environment variables 53 / browser storage keys 21 / envelope fields 10).
- Rationale, unchanged since: protocol keys are cross-system machine contracts (custom track, existing MCP clients, selftest assertions, dsh host validation) and stay ASCII. (Human-visible strings, Chinese-only at the time, gained en-US / ja-JP dictionaries in the 2026-10-16 release.) R10 is the authoritative per-key reference behind the ASCII-preservation rule in [GLOSSARY.md](../GLOSSARY.md).

### Design adaptation batch (2026-10-14)

- The Console was visually adapted from a CIO-dashboard design spec onto the existing zero-build SPA: design-token refresh (warm paper + deep teal-blue), a component-class contract, and drawer-first interaction rules (no `window.open`/`alert` popups — the `/rq` dsh mount must remain a same-origin full page).
- A new full-page render smoke (31 pages) and DOM smoke were added to the quality gates; the `/rq`-prefixed reverse-proxy mount was verified end to end.
- Deployment note from the batch: running instances need one graceful restart to register the new backend routes (`/api/fleet/ledger`, `/api/usage/report`, `/api/modelgw/routes-usage`, `/api/exec/overview`).
- In this period the dsh bundle install source also migrated from `github:01men/ybkk-AIOS` to `github:01men/ybkkasi`.

### Audit remediation batch (2026-10-15)

One combined sweep closed every still-open item from the 2026-09-12 / 2026-10-13 / 2026-10-14 review reports, with six developer groups working in parallel and one test group closing:

- **Organization isolation fail-closed (N1)**: IAM admin tools (`iam_user_create` / `reset_password` / `freeze`) previously failed open when actor identity was missing, letting cross-org account creation/freezing/password resets bypass isolation via `/api/tools/execute` and `/mcp`. Fixed in three layers: server-side trusted identity injection at the tool bridge, normalized actor consumption, and the missing-actor bypass converted to fail-closed (403 `OrgScopeDeniedError`).
- **MCP tool least-privilege**: 24 legacy tools that rode the `console.login` baseline each got their minimal permission declared; `/mcp tools/list` now asserts x-permission coverage 82/82 (the baseline remains only as fail-safe for undeclared tools).
- **Model channel fallback budget guard (BUG-2510-B1)**: the channel-group fallback chain previously bypassed budget circuit breakers; every real invocation now re-checks the budget for the channel about to be called, and a breach aborts the whole chain (no upstream call, no metering, no degraded event).
- **`/docs` whitelist (G2-01)**: the docs directory moved from "all 69 files anonymous-public" to default-deny with a six-file public whitelist (external onboarding guides + ecosystem design); deployment runbooks, QA/handoff/contract and dev-plan documents now 404 anonymously, with `%2F` traversal protection verified.
- **Platform resilience set**: scrypt password KDF with transparent legacy upgrade + `timingSafeEqual`; admin initial-password file written with mode 0600; event-bus concurrent dispatch per event (FIFO across events preserved); CSP on all responses (toggled by the same `SECURITY_HEADERS` switch) and `cache-control: no-store` on `/api/*`; data-lineage cycle detection; flow SLA/`stalled` semantics; dead-letter `source` field enabling structural redelivery; demo seed rerouted through the usage pipeline.
- **Console ⌘K command palette**: 6 real routes added (17→23 entries), completing page index coverage; the legacy brand page was archived to `archive/legacy-brand/`.
- **Correctness and hygiene set (same batch)**: YAML sequence parsing fix (`- 12:34:56` no longer misread as an inline map); update dry-run no longer performs network fetches; three dead permission points removed from the catalog; metering idempotency keys made deterministic (minute-window based, retries never double-count); plugin-id namespace binding at registration; usage summary wildcard-budget accounting, feedback idempotency-key and usage replay audit fixes.

### W batch (2026-10-15): digital workforce phase 2

Delivered per the `llms.txt` latest-update line and the phase-2 plan:

- **MCP tool trust-risk registration (V11 root fix)**: remotely discovered tools are no longer implicitly treated as read; write capability requires an explicit "risk registration → review → activation" flow. Unregistered tools are classified `unknown` and their write actions refused (read actions may pass under read-only constraints); legacy tools get a re-review list. Registration/approval reuse the existing two-tier approval shape.
- **REST/Panel surface parity**: closing registered gaps between the REST API and Panel tool surfaces (workRef passthrough on `POST /api/mcp/invoke`, skill-load route passthrough, feedback attribution convergence).
- **Usage proxy-reporting whitelist**: machine principals can no longer attribute usage/feedback to arbitrary users; only a bound-user whitelist (the worker's manager / bound human) may proxy-report, with 403 + `audit.authz.denied` outside it and the zero-price snapshot posture unchanged.
- **`workforce.admin` operations surface**: batch suspend/reinstate of digital workers (with permit/lease cascade), appointment audit reports, and expiry/terminal-state cleanup tasks — eliminating the last "reserved permission point with no code reference" lint finding.
- **Gray delivery package (T08)**: moving workforce from test-environment closure toward real-environment trial duty — a real-runtime integration script covering seven scenarios (pull, claim, renew, resource invocation, delivery, cancel, restart recovery), a single-department trial chain (quality analyst: QMS read-only → fixed-version root-cause Skill → controlled SOP files → model analysis → artifact report → human acceptance) with trial/production data separation, rollback drills, and per-organization gray switches.
- **Six-gate verification**: lint all green · selftest ≥ 1,380 · drill ≥ 37 — **numbers as of the latest run** (all test counts in these notes are per-run values; historical counts are not cumulative promises).

---

## 5. Quality-gate progression (each row as of that batch's own run)

| Batch | selftest | Other gates |
|---|---|---|
| M0 (09-09) | all green (count per run) | lint:manifests 85/85 |
| Optimization (09-11) | 997/997 | lint:manifests 85/85 |
| IAW (09-11) | 1,067/1,067 | lint:manifests 90/90 |
| QA (09-12) | 1,118/1,118 | check-docs-consistency 64/64 |
| QA (09-13) | 1,118/1,118 | integration verify 20/20 |
| Approval relax (09-15) | all green | approval unit tests 9/9 |
| M2 (09-16) | 1,173/1,173 | lint:manifests 0 errors (routes 360 / manifests 376, tools 83/83) |
| REFACTOR stage 1 (10-13) | 1,200/1,200 | boot-order 0 errors |
| REFACTOR stage 2 (10-13) | 1,201/1,201 | `lint:cjk` 0 hits |
| Design adaptation (10-14) | 1,258/1,258 | dom-smoke 15/15 · page-smoke 31/31 |
| Audit remediation (10-15) | 1,343/1,343 | dom-smoke 14/15 (+1 by-design skip) · page-smoke 31/31 · lints 0 errors |
| W batch (10-15) | ≥ 1,380 | drill ≥ 37 · lint all green — as of the latest run |

> Counts are point-in-time values from each batch's own verification run and are not comparable as a performance metric over time; the current number is whatever the latest run reports.

---

## 6. Honest absences and roadmap pointers

The notes are deliberately explicit about what is *not* implemented. Items an international reader should know about:

- **TTFT telemetry**: channel telemetry reports availability/p50 latency/TPS-proxy/adoption, with `ttftMs=null` and an explicit note — honest omission until a streaming model channel exists.
- **In-session multi-step plan cards (IAW item 7-2)**: contract in place, implementation absent, pending the same streaming channel — no pretend implementation was shipped.
- **Idle-run detection v1**: approximate heuristic with on-page disclosure; the exact formulation waits for the M4 evidence engine's task_success/task_fail feeds (Roadmap).
- **Content-safety interception hook** in the model fallback chain: declared as honestly absent in contract c1.
- **Additional UI languages**: the 2026-10-16 release delivered the built-in switcher (Simplified Chinese default / English (US) / Japanese); further UI languages and the multi-language docs portal with language routing remain on the roadmap (Roadmap).

## 7. Contract stability (why international integrators can rely on this)

- **Additive-only schema v1**: the usage event schema and the record structures are frozen at v1; every batch listed above adds endpoints, fields and events rather than changing or removing existing ones. The one breaking change (the M0 billing retirement) was published as an explicit retirement list with replacement endpoints, not silent removal.
- **Protocol keys stay ASCII**: event names (`platform.update.available`, `flow.*`, `modelgw.degraded`…), permission points (`usage.read`, `workforce.admin`, `platform.update.apply`…), error reason codes and the `ok`/`data`/`error` API envelope, environment variable names, and browser storage keys are machine contracts and are never translated — in any language edition of the docs. The authoritative per-key reference is the R10 table (`docs/协议键中文对照总表.md`); new external protocol keys must be registered there.
- **Contract-freeze discipline**: interface contracts (J1–J4, C1–C3) are frozen at v1 with named owners; upgrades require a version bump, a release note, and synchronized changes on both the platform and consumer sides. The custom track uses release notes as its merge translation layer.

---

## 8. Where to go next in the English docs

| If you want… | Read |
|---|---|
| The M0 money posture in full, and the J4/FinOps reports behind it | [usage-reporting.md](usage-reporting.md) |
| To deploy the platform, or hand deployment to a dsh Agent | [deploy-enterprise.md](deploy-enterprise.md) |
| To onboard an enterprise AI app onto platform identity (OIDC SSO, org-sync, entry tickets) | [app-sso-integration.md](app-sso-integration.md) |
| Terminology contract, ASCII preservation list, M0 red line | [GLOSSARY.md](../GLOSSARY.md) |
| i18n governance, market mapping, roadmap | [README.md](../README.md) |

> The Chinese originals of every document referenced here remain authoritative. Where this summary and a Chinese release note disagree, the Chinese note governs.
