# Usage Transparency & FinOps Reporting Guide

> **English edition** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source: `docs/contract-j4-usage-report.md` (frozen v1) · `README.md` · `llms.txt` · `docs/internal/release-notes-2026-09-11-optimization.md` · `docs/internal/release-notes-2026-09-16-m2.md` · Source baseline: 2026-10-15 · Glossary: [GLOSSARY.md](../GLOSSARY.md) · Governance: [README.md](../README.md)

## 0. The M0 framing — read this first

Since the M0 compliance convergence (2026-09-09), 元冰可 (YuanBingKe / ybkk-AIOS) carries **no billing, settlement, wallet, recharge or revenue-share semantics of any kind**. The former wallet/ledger subsystem (plugin-billing) has been retired and archived; usage-based charging, resale and profit sharing were terminated.

The platform's entire money-adjacent surface is:

- **Transparent usage metering** — what was consumed, by whom, on which asset (tokens, calls); and
- **Internal cost pass-through** — an internal procurement cost reference for FinOps analysis only.

Externally, the platform is priced by "team + domain assets" (team size × chosen domain asset packages); manufacturing customers may take on-premises project-based delivery. Nothing in the reports below is an invoice, and no amount is ever charged to anyone.

## Interface language note

As of the 2026-10-16 release, the runtime interface (Console, Panel, error messages) ships with a built-in language switcher: Simplified Chinese (default), English (US), and Japanese (top-bar selector, `rq_lang`; CLI `--lang` / `DSHCTL_LANG`; dictionary misses fall back to Chinese). CSV/JSON outputs contain Chinese column headers as emitted by the platform — reproduced verbatim below with English glosses.

---

## 1. J4 contract — usage report data semantics v1 (frozen)

Freeze date 2026-09-09; consumers: custom-side panel reports and the Console asset-operations pages. Any upgrade of this contract requires a release note and synchronized changes on both sides. Implementation anchor: `packages/plugin-usage/src/index.ts` `UsageService.monthlyReport()`; Console endpoint `GET /api/usage/report/monthly`.

### 1.1 Data source and event semantics

- Single data source: the usage metering event stream (`usage_events`, SQLite `data/txnstore.db`). **No monetary ledger is read** (billing is retired and sealed).
- Event window: events whose `occurred_at` (ISO UTC) falls within `[first day of month 00:00, first day of next month 00:00)`; the month parameter format is `YYYY-MM`.
- Idempotency: events are engine-unique by `idempotency_key`; duplicate deliveries never double-count. The report equals the stored data and can be reconciled via `POST /api/usage/reconcile` (third-party reconciliation).

### 1.2 Three-dimension token aggregation (J4 core)

tokens = the sum of meter values whose meter key contains `tokens` in the event's `meters[]`:

- covers `tokens` / `input_tokens` / `output_tokens`; multiple token keys on one event accumulate;
- excludes non-token meters such as `calls`.

The three frozen dimensions:

| Dimension | Classification field | Notes |
|---|---|---|
| Department byOrg | `org` (**the department attribution field**) | Every event carries org; events without an organization attribute to an empty-string org under the `t_default` tenant and belong to no department |
| Agent byAgent | `subject` prefixed `agent:` | Events whose on-behalf-of chain terminates at an Agent (including Agent consumption via the gateway/connectors) |
| Skill bySkill | `resource` prefixed `skill:` | Skill invocation / download back-fill events |

An additive dimension (`byModel`, resource prefix `model:`) supports cost pass-through; it is not part of the frozen J4 surface.

Each row outputs: `dimension / events / tokens / charge_cents / cost_cents / nonbillable_events`.

### 1.3 Amount fields (post-M0-3 convergence)

- `charge_cents`: **zero-price snapshot, always 0**. The commercial model is "team + domain assets" pricing, or on-premises project delivery for manufacturing (updated 2026-09-15). The price book's list side is uniformly zero-priced; reports never present any external settlement amount. The price book retains repricing capability for future operating decisions, but any repricing requires a contract version bump first.
- `cost_cents`: **internal procurement cost reference** (price-book cost side × measured meter values) — for internal cost pass-through only; never present it externally as a bill. Cost reference values are denominated in CNY (fen, i.e. cents); no currency conversion is performed.
- `nonbillable_events`: events hitting zero-rate rules (list=cost=0, `rate.nonbillable=true`) — observational events (feedback / knowledge packages / panel etc.) land here and do not pollute the cost account.

### 1.4 Delivery contract (Console endpoints)

- `GET /api/usage/report/monthly?month=YYYY-MM` → JSON (permission point `usage.read`):
  `{ month, from, to, totals, byOrg[], byAgent[], bySkill[], byModel[] }`
- `GET /api/usage/report/monthly?month=YYYY-MM&format=csv` → CSV file download (UTF-8 BOM, opens directly in Excel).
  Columns as emitted by the platform (Chinese, verbatim): `维度,维度值,事件数,tokens,charge_cents(零价快照恒0),cost_cents(内部成本参考),nonbillable事件数`
  (gloss: dimension, dimension value, event count, tokens, charge_cents [zero-price snapshot, always 0], cost_cents [internal cost reference], non-billable event count).
  Row grouping order: total → org → agent → skill → model.
- **Enterprise admins can self-export with the `usage.read` permission** — the M0-3 acceptance criterion; no engineering ticket required.

### 1.5 Selftest anchors (how the contract is guarded)

The end-to-end selftest asserts, among others: three-dimension aggregation and department attribution after cross-dimension event seeding; the zero-price snapshot (`charge_cents` constantly 0, non-billable counts); CSV export returning `text/csv` with BOM and header row; and a dead-letter replay drill (three consumer failures → dead letter → `usage_deadletter_retry` redelivers successfully without double-counting, via consumer-watermark idempotency). Counts are per run (as of the latest run).

---

## 2. FinOps report v1 — the CFO view (2026-09-16, M2)

All endpoints require `usage.read`. Amounts follow J4 semantics: internal cost reference (`cost_cents`); `charge_cents` is the zero-price snapshot, always 0.

| Endpoint | Purpose |
|---|---|
| `GET /api/finops/overview?month=YYYY-MM&window=分钟` | One call: cost pass-through + idle-run detection (window in minutes) |
| `GET /api/finops/idle?month=YYYY-MM&window=分钟` | Idle-run detection standalone (window adjustable, 1–1440 minutes) |
| `GET /api/finops/report/monthly?month=YYYY-MM[&format=csv]` | CFO cost report; CSV is Excel-friendly UTF-8 BOM |

**Cost pass-through** (`UsageService.costPenetration()`):

- a monthly department (org) × model cost cross matrix — Top 8 × Top 8 plus an "Others" row/column; **the grand total always equals the model-domain total**;
- month-over-month comparison (when prev=0 and cur>0, `delta_pct` is `null` rather than a fabricated percentage);
- Top 10 consuming subjects, and a Top-3 model breakdown per department row.

**Idle-run detection v1** (`UsageService.idleAnalysis()`):

- an approximate implementation of the planned semantics: a model call followed by N minutes (default 30) with no non-model resource action by the same subject and no action linked by the same `trace_id` is counted as suspected idle;
- output: idle events / cost / tokens, breakdowns by model and department, and the 20 most recent samples for human review;
- **known false positives (pure conversation) are disclosed on the page itself: "approximate heuristic; requires human review; not for performance appraisal"**;
- the exact formulation awaits task_success/task_fail result feeds from the M4 evidence engine (Roadmap).

**SPA "Financial View" page** (`#/finops`, under the governance & operations section; visible with `usage.read`): metric cards (month cost + MoM / metering events / idle cost / participating dimensions), department pass-through table, model cost ranking, cross heatmap matrix, collapsible idle-review sample table, one-click CSV export, month switcher, friendly empty states.

---

## 3. Event retention policy (`USAGE_RETENTION_DAYS`)

- Default **730 days**; `0` = keep permanently. Before this policy, `usage_events` grew without bound.
- First sweep runs 20 seconds after startup, then every 6 hours; out-of-window events are removed together with their consumer watermarks and matching dead letters.
- **Semantics**: once an event is cleaned up, re-delivery with the same idempotency key is recorded as a new event (the retention window is the deletion contract). The J4 monthly report window (last 13 months) is unaffected.
- Ops manual sweep: `POST /api/usage/retention/purge` (permission point `usage.admin`; `body.days` can temporarily tighten the window; `0` = skip).

---

## 4. Quick reference

| Item | Value |
|---|---|
| Monthly report (JSON) | `GET /api/usage/report/monthly?month=YYYY-MM` — `usage.read` |
| Monthly report (CSV) | same endpoint + `&format=csv` — UTF-8 BOM |
| Reconciliation | `POST /api/usage/reconcile` |
| FinOps overview / idle / monthly CSV | `GET /api/finops/overview` · `GET /api/finops/idle` · `GET /api/finops/report/monthly` — `usage.read` |
| Subject-scoped summary | `GET /api/usage/summary?window=today\|month&org=&subject=` — `panel.read`; non-`usage.read` subjects forcibly scoped to their own organization, fail-closed |
| Retention | `USAGE_RETENTION_DAYS` (default 730; 0 = permanent) · purge: `POST /api/usage/retention/purge` (`usage.admin`) |
| Amount semantics | `charge_cents` = 0 always · `cost_cents` = internal procurement cost reference (CNY) · no settlement semantics |

## 5. Reading the numbers honestly

- `charge_cents` is always 0 by design — it is a snapshot posture, not a price. Treat any non-zero value as a defect.
- `cost_cents` is an **internal procurement cost reference**: useful for department-level FinOps conversations, cost-per-DAU trends, and budget circuit-breaker context; not a price list, not a bill, never for external presentation.
- Idle-run detection v1 is an **approximate heuristic that requires human review**; the page and the API output both say so. Do not use it for individual performance appraisal until the evidence-engine-backed exact formulation ships (Roadmap).
- Budget circuit breakers (org/model/platform-level, warn events + pre-call blocking) operate on the same data foundation and share the same no-settlement posture: they stop runaway consumption internally; they never bill anyone.
