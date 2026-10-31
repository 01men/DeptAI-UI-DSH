# YuanBingKe AIOS · Agent view

<p><a href="../../../README.md">简体中文</a> · <strong>English</strong> · <a href="README.md">Product overview</a> · <a href="../../../README.agent.md">Agent (中文)</a></p>

> This page is for automated callers — MCP clients, dsh agents, CI scripts, remote executors — and states only the facts and security boundaries needed to integrate.
> For positioning, interface, and commercial information, see the [product overview](README.md). All endpoints, permission points, and environment variable names are protocol keys and are never translated in any language edition.

## What this is

YuanBingKe is an enterprise AI runtime and governance platform that is itself an MCP server and REST data plane. An agent can be a **consumer** of the platform (calling its operations tools) or a **managed subject** inside it (registered as a digital employee, bound by organization, permissions, approvals, and metering).

## Integration points

| Entry point | Form | Auth | Notes |
| --- | --- | --- | --- |
| `POST /mcp` | Streamable HTTP JSON-RPC (sessionless, no GET SSE) | Bearer | Platform operations tool surface; tool discovery is filtered by caller permissions |
| `GET /api/openapi.json` | REST description (OpenAPI 3.0.3) | Bearer | Projection of the instance's real routes; nothing is pinned |
| `GET /api/health` | JSON | Anonymous | Health check plus panel contract version |
| `POST /mcp/services/:slug` | JSON-RPC | Bearer | Invocation surface for a registered MCP service |
| `/docs/<name>.md` | Static Markdown whitelist | Anonymous | Integration docs shipped with the package, fetchable directly |
| CLI `node cli/dshctl.mjs` | Command line | Bearer | `--output json` for machine consumption; `--lang` controls output language |

Under a dsh mount, prefix all paths above with `/rq`. A standalone instance defaults to `http://127.0.0.1:7300`.

**Do not assume fixed counts.** Tool, route, and permission-point counts vary by version and caller permissions; trust the target instance's runtime responses.

## Operating boundaries (must be satisfied first)

1. **Read before write** — confirm the target, its state, and your own permissions through read-only endpoints before any write, delete, publish, or upgrade operation.
2. **Authorization first** — write operations need the corresponding permission point. High-risk lifecycle operations (go-live / offline / delist / revoke) go through mandatory L4 approval; an agent cannot route around it.
3. **`--dry-run` is fail-closed** — only operations that explicitly implement preview return a change preview; every other write request is refused rather than silently executed. Do not treat `--dry-run` as a general safety switch.
4. **Credentials are sensitive** — never write tokens, passwords, secrets, or one-time enrollment codes into public documents, logs, or conversational replies.
5. **Demo mode is not writable** — `DEMO_MODE=1` opens the instance's entire read-only data plane to anonymous visitors, and writes return 403/405. Demo data does not represent real invocation results.

## Identity and permission model

- **Two subject types** — human users (signed in to Console/Panel) and machine subjects (agent machine credentials, remote dsh access clients).
- **One authorization model** — every call resolves against the same permission-point matrix; the `/mcp` tool list is filtered by caller permissions, and undeclared tools are denied by default.
- **On-behalf-of** — the `X-On-Behalf-User` header carries the real user identity, forming a user → agent token chain that is fully auditable.
- **Organization lineage** — data belongs to an organization. When none is supplied, the platform falls back in order: caller's organization → department-bound organization → platform root organization, recording `orgSource`. An explicitly empty `orgId` is rejected (400) instead of being silently written as an unowned record.

## Metering and cost

- Every capability invocation produces a usage event, written idempotently (redelivery causes zero duplicate side effects).
- Meter keys must be registered in the price book (for example `mcp:*` uses `tokens`, `model:*` uses `output_tokens`); a mismatch is explicitly rejected, and **there is no silent zero-rate fallback**.
- **Asset usage credentials** (since 2026-10-31): after using a platform skill/MCP, agents should proactively report the usage fact to `POST /api/assets/usage-reports` (idempotency key required; the machine principal must have acquired the asset first — reporting without acquisition is rejected with 403). Credentials feed the asset ledger and audit trail as usage evidence on the asset-operations side; they complement metering events and do not replace them. Fields and error semantics: `docs/agent-onboarding.md` §4.7 (Chinese).
- The platform exposes no monetary settlement semantics. Externally it offers transparent usage metering plus an internal cost reference — no wallets, no top-ups, no revenue splits.
- When pricing data is unavailable, this is stated explicitly as `cost_status=not_priced`. **Unknown does not mean zero cost.**

## Failure semantics

- REST uses a uniform envelope: `ok` / `data` / `error`; errors carry stable reason codes — do not match on message text.
- Unmatched `/api/*` routes return 401 for anonymous callers (the auth middleware runs before routing), so route existence is not leaked through 404/401 differences.
- The model gateway forwards only to configured endpoints; a missing endpoint is a refused call, never a fabricated completion.
- Login, SSO, and client-credential endpoints all enforce failure lockout (5 failures per 15 minutes by default, escalating up to 24 hours).

## Where to continue

| Need | Go to |
| --- | --- |
| Machine-readable project summary | [llms.txt](../../../llms.txt) |
| Domain operations manuals | [skills/dsh-ops-admin/SKILL.md](../../../skills/dsh-ops-admin/SKILL.md) |
| Standalone deploy / dsh mount / remote access | [deploy-enterprise.md](deploy-enterprise.md) |
| Plugin system and service boundaries | [ARCHITECTURE.md](../../ARCHITECTURE.md) |
| Usage and cost reporting | [usage-reporting.md](usage-reporting.md) |
| Interface contract history | [CHANGELOG.md](../../../CHANGELOG.md) |

This project is released under the [MIT License](../../../LICENSE).