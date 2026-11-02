> **English edition** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source: `README.md` (§二/§三), `docs/internal/ecosystem-design-v1.2.md` · Source baseline: 2026-10-15 · Glossary: [GLOSSARY.md](../GLOSSARY.md) · Governance: [README.md](../README.md)

# YuanBingKe (ybkk-AIOS) — The DSH Ecosystem


This document explains the ecosystem YuanBingKe lives in: the dsh (DeepSeek Harness) host, the cordis plugin framework, how YuanBingKe mounts into dsh, what a plugin looks like, how the plugin marketplace works, who does what in the ecosystem, and how protocol keys are governed. For the product-level overview see [README.md](README.md); for installation commands see [getting-started.md](getting-started.md).

**Interface language note:** as of the 2026-10-16 release, the runtime interfaces of both YuanBingKe and dsh ship with a built-in language switcher — Simplified Chinese (default), English (US), and Japanese (top-bar selector, `rq_lang` preference; CLI via `--lang` / `DSHCTL_LANG`; strings not yet covered by a dictionary fall back to Chinese). UI locations are annotated bilingually on first mention; protocol keys are ASCII and never translated (Section 7).

## 1. What are dsh and cordis?

**dsh (DeepSeek Harness)** is an agent runtime: it hosts agent sessions behind a web service (`dsh web`), exposes tools to models through its native ToolRuntime, and loads domain skill manuals from `.dsh/skills` directories. Capabilities are added to dsh by installing **plugins** into a profile (for example the `web` profile) — there is no fork-and-patch path.

**cordis** (`@deepseek-ai/cordis`) is the plugin framework underneath dsh. A cordis plugin declares its dependencies and lifecycle; at runtime each plugin receives a context (`ctx`) through which it registers services, routes, and tools. YuanBingKe is built on the **same framework**, which is what makes the "Everything is a plugin" architecture portable between hosts (Section 3).

Two precision points, stated honestly:

- YuanBingKe's cross-plugin event bus (`ctx.platformBus`) is a platform-owned in-memory pub/sub with persistence, retry, dead-letter handling, and source validation — it is not the cordis event system. Third-party code may only emit events namespaced `plugin:<id>:` (Section 7).
- A bundle installation resolves plugins to the **host's own cordis instance**; the repository keeps `@deepseek-ai/cordis` in `devDependencies` only. Two cordis instances in one process cause `ctx.plugin(...)` registrations to silently no-op and the whole service chain (iam → usage → audit ...) to hang in pending — the ecosystem's best-known failure mode.

Ecosystem vocabulary, for readers new to dsh:

| Term | Meaning |
|---|---|
| Host (宿主) | the process that loads the plugin tree — here, the platform's own process or a dsh `web` process |
| Profile | a dsh-side plugin installation root (`--profile web`); installs resolve along the profile's `node_modules` closure |
| Patch / overlay | a YAML file (`cordis.yml` for source checkouts, `cordis.patch.yml` for bundle installs) that mounts plugin entries into a dsh process at start |
| Mount (挂载) | attaching the YuanBingKe data plane into the dsh webServer under the `/rq` prefix |
| Enrollment code | one-time host-issued credential (`enr_...`) a remote dsh client exchanges for machine credentials |

## 2. "Everything is a plugin"

YuanBingKe's architecture slogan is literal: every business domain is one plugin package. Each plugin independently declares its dependencies, permission points, and events, and can be started and stopped independently. A running platform is a **plugin tree**; a bundle install mounts **25 plugin entries** into a dsh profile in one command.

Plugins collaborate only through events and extension points — a state change must emit an event, and plugins never read each other's storage directly:

| State change | Automatic reaction |
|---|---|
| `iam.user.frozen` | authn revokes all of the user's tokens |
| `agent.offlined` | machine credentials revoked + bound users notified |
| `skill.deprecated` | referencing agents alerted |
| `mcp.unhealthy` | circuit breaking + audit trail |

The full tree with per-plugin descriptions is in [README.md §4](README.md).

## 3. How YuanBingKe mounts into dsh

| Form | What runs where | Entry point | Notes |
|---|---|---|---|
| Independent host | `node src/main.ts` serves REST + Console SPA + tools bridge | platform port (default 7300) | no dsh required; baseline for all other forms |
| Full dsh runtime (source checkout) | plugin tree patched into `dsh web` with an overlay | dsh web `/rq` | experimental; validate with isolated data and never share a data directory between processes |
| Bundle mount (recommended for use) | `dsh plugin --profile web add github:01men/ybkkasi` | **dsh web port is the single entry** | the host bridge mounts the YuanBingKe data plane under the `/rq` prefix |

The key piece is **`dsh-plugin-dsh-bridge` (the host bridge)**: it mounts YuanBingKe's data plane — REST, the Console SPA, static docs, and the `/mcp` endpoint — into the dsh webServer under the **`/rq` prefix**, so users and agents reach everything through one port; the platform's own HTTP listener can be turned off with `startHttp: false`. Companion access-layer plugins complete the in-session experience: `dsh-plugin-panel-core` (department Agent workbench Panel（面板）: `/panel` SPA + `/api/panel/*` REST + SSE), `dsh-plugin-rq-card` (four-state execution cards with a thumbs-up / thumbs-down feedback bar injected into dsh conversations — a `dsh.client` dual-sided plugin), and `dsh-plugin-dingtalk-bridge` (DingTalk group bridge, outbound delivery, approval push, alert channels).

Once mounted, the platform's registered **operations tools enter dsh's native ToolRuntime** (the plugins declare `provideToolRuntime: false`, reusing the host runtime instead of the built-in lite one). Models can then operate the whole platform in natural language — "list all MCP services and their health" triggers `mcp_service_list`; "what can be installed from the Skill Marketplace" triggers `skill_search`. The operations tool set counted 37+ tools as of the latest releases; counts evolve release to release, and the different surfaces (dsh ToolRuntime, the REST tools bridge, `/mcp`) expose slightly different supersets — the manifests are the source of truth.

### 3.1 The `tools` seam and service-key de-confliction

Two load-bearing implementation details matter to anyone embedding plugins into dsh:

- The `tools` service key is **deliberately shared**: under the independent host it is provided by ToolRuntime-lite; under dsh it is provided by the native ToolRuntime. All operations tools flow through whichever host supplies it.
- YuanBingKe's JSON storage service key is `opsStorage`, **not** `storage` — the dsh host ships its own `storage` service, and sharing the name caused plugins to receive the wrong service at construction. New ecosystem plugins should follow the same namespacing discipline.

### 3.2 Source-checkout mode (local development)

Developers pointing a dsh source checkout at a YuanBingKe checkout must satisfy two hard requirements:

1. In `cordis.yml`, replace `<PROJECT_ROOT>` with an absolute `file:///` URL (bare Windows drive-letter paths fail ESM resolution with `ERR_UNSUPPORTED_ESM_URL_SCHEME`);
2. Link `node_modules/@deepseek-ai/cordis` to the dsh source tree's `vendor/cordis` (a junction on Windows), so plugins and host load **the same cordis instance**.

Then run `pnpm dsh web --patch <project>/cordis.yml` from the dsh checkout. Bundle installs avoid all of this: entries are declared as package name + subpath and resolve along the profile's `node_modules` to the host's cordis closure.

### 3.3 Skills distribution

Domain operations skill manuals (`skills/dsh-ops-*/SKILL.md`, 9 skills, including the `dsh-ops-admin` master index) do not auto-enter dsh's skill system — dsh only scans `.dsh/skills` roots. Host operators distribute them explicitly:

```bash
mkdir -p ~/.dsh/skills
cp -r skills/dsh-ops-* ~/.dsh/skills/    # from a source checkout; check for existing names before copying
# or project level:
mkdir -p .dsh/skills && cp -r skills/dsh-ops-* .dsh/skills/
```

### 3.4 Remote dsh access (the third form)

For distributed teams, other computers install the bundle from the marketplace and connect back to the host via `dsh-plugin-connect` — no source checkout, no shared data directory:

1. The host admin creates a **one-time enrollment code** on the **Platform Access（平台接入）** page or via CLI (`node cli/dshctl.mjs connect code --template=operator --ttl=15`), choosing a permission template: `readonly` (default), `operator` (adds MCP/skill/agent/app operations and approval decisions; no account or credential management), or `full` (trusted environments only).
2. The remote computer connects either by telling the dsh agent "enroll to host `<URL>` with code `enr_...`" (the agent calls `connect_setup`), or through the local configuration page at `http://127.0.0.1:7390`.
3. After enrollment, the operations tools switch to **host-forwarded execution** (the remote machine holds no data); a heartbeat is pushed to the host every 5 minutes by default (`heartbeatIntervalMinutes=0` disables); the host page lists connected clients with last-use and last-heartbeat, and can disable a client at any time — revoking all its machine tokens immediately.

Security baseline: enrollment codes are stored hashed (shown once at creation), consumed once, TTL-configurable (default 15 minutes), with per-source-IP failure lockout (5 failures per 15 minutes); machine credentials are equivalent to passwords and live only on the remote machine with `0600` permissions.

### 3.5 Choosing a form

- **Just evaluating?** Independent process + `DEMO_SEED=1` (never in production).
- **Want agents to operate the platform in natural language, one entry point?** Bundle mount into your dsh host (`/rq` prefix, dsh web port as the single entry).
- **Developing against a dsh source checkout?** Patch mode (`cordis.yml` + junction), per Section 3.2.
- **Multiple sites or admin workstations?** Bundle install everywhere + remote enrollment against one host (Section 3.4).

## 4. Plugin anatomy

Every first-party plugin follows one layout (translated annotations; identifiers verbatim):

```text
packages/plugin-<name>/
  plugin.yaml             declares: id / version / depends / permissions
  manifest/
    api.yaml              REST routes + tools + service keys — the single source of truth
                          aligned across the REST, tools-bridge, and /mcp surfaces
    permissions.yaml      permission points, registered into the unified RBAC
    events.yaml           published / subscribed events
    ui.yaml               routes + menu entries
    billing.yaml          compatibility-retained metering declaration face: only meter keys
                          and units participate in metering registration; the monetary side
                          is always the zero-price snapshot (M0)
  src/index.ts            services + plugin assembly
  src/tools.ts            model-facing tools (dsh ToolRuntime contract)
```

- **Independent declaration, independent lifecycle.** Because dependencies, permissions, and events are declared, the framework can start/stop plugins independently and the platform can enforce least privilege per plugin.
- **Machine-checked contracts.** `npm run lint:manifests` validates the five manifest faces as YAML and cross-checks declared routes and tools against the code (route / tool contract comparison), catching drift before release.
- **Declarations are generated.** `scripts/gen-manifests.mjs` scaffolds and regenerates manifest faces so code and declaration stay aligned.

The tool layer shows why the contract discipline matters: every tool declared in a plugin's `src/tools.ts` is served with the same contract on three surfaces — the REST tools bridge, the dsh ToolRuntime (form B), and the `/mcp` endpoint — which is why an operator can run the identical call as a CLI command (`node cli/dshctl.mjs tool exec --name=agent_list --args='{"status":"online"}'`), as a model tool call in a dsh session, or as a raw `/mcp` `tools/call` from any MCP client. `manifest/api.yaml` is the source of truth all three are checked against.

Third-party plugins follow the same discipline under a stricter contract (Section 5).

## 5. The plugin marketplace

`dsh-plugin-market` operates a marketplace for **third-party and first-party plugins and skills**.

### 5.1 The five-face contract and Ed25519 verification

A third-party submission ships a five-face contract:

- `plugin.yaml` — metadata: id, version, publisher, signature, dependencies, requested capabilities, sandbox level (L0 only today);
- `manifest/permissions.yaml` — requested permissions, approved item-by-item by the enterprise at install time;
- `manifest/api.yaml` — declarative provision face (registration only at L0; no live routes);
- `manifest/events.yaml` — subscriptions only (third parties may never emit platform-namespace events);
- `manifest/billing.yaml` — metering declaration only; monetary fields have no effect under M0;
- plus a `content/` payload for L0: prompt packs, configuration templates, tool descriptions — **no executable code**.

The publisher signs the content fingerprints with an **Ed25519** private key; the platform verifies against the developer's registered public key before anything is listed.

### 5.2 From developer to installed plugin

1. **Developer identity.** Third-party developers register in a dedicated identity domain inside the marketplace (separated from the internal employee IAM domain, with its own credentials and publisher key pair).
2. **Scaffold, sign, submit.** The CLI does all three:
   ```bash
   node cli/dshctl.mjs plugin init --id=com.demo.hello --dir=./my-plugin   # five-face scaffold + publisher key pair
   node cli/dshctl.mjs plugin sign --dir=./my-plugin
   node cli/dshctl.mjs plugin submit --dir=./my-plugin
   ```
3. **Review gates.** Static content scanning; a marketplace admission gate currently accepts **L0 (declarative) only** — a code-carrying sandbox (L1) is a designed roadmap item, and the gate rejects anything else until that lands; platform admins approve publishing, then installation, per enterprise.
4. **Runtime accountability.** Installed capabilities are frozen into an approved set at install time; a reconciliation job periodically compares actual consumption against declared capabilities, raising `usage.capability.drift` and auto-suspending offenders for review. Any change to L0 content (prompt/config fingerprints) forces a fresh scan and approval.
5. **Versioned publishing.** Every publish is a new immutable version; installation registers dependencies; deprecation warns referencing agents; uninstall is an approved operation too.

### 5.3 Third-party vs first-party

First-party plugins ship inside the platform tree and are metered with **zero-price metering declarations** (the M0-3 posture). Third-party submissions run in a constrained context: events namespaced `plugin:<id>:`, tokens scoped to `plugin:<id>:<cap>` namespaces, platform-service access clipped to approved capabilities by a proxy context. Marketplace prices do not exist — third-party metering declarations register at zero price, and no subscription or revenue-share flows are accepted (M0).

Where you meet the marketplace in practice: developers work in the CLI (`dshctl plugin` and `skill` command groups, Section 5.2); platform admins approve publishes, installs, and uninstalls in the Console（控制台）， where the Skill Marketplace page also carries a skill × day usage heatmap card; agents discover supply in-session through tools such as `skill_search`. Versioned publishing means an installed enterprise always pins an immutable version, and deprecation is announced through events (`skill.deprecated`) rather than silent removals.

## 6. Ecosystem roles

| Role | What they can do |
|---|---|
| **dsh host operators** | Run `dsh web`, install/update plugins into profiles (`dsh plugin --profile web add ...`), mount YuanBingKe via the host bridge, distribute `.dsh/skills` manuals, and operate the platform through agents in session or through `dshctl` |
| **Platform admins** (YuanBingKe side) | Own baseline initialization, RBAC and permission points, L4 approvals, marketplace admission (approving third-party publishes and installs), connector configuration, self-update, and client revocation on the **Platform Access（平台接入）** page |
| **Third-party plugin / skill developers** | Register a developer identity, sign the five-face contract with Ed25519, submit versioned releases through the CLI, and publish declarative (L0) content — always subject to scanning, approval, event namespacing, scoped tokens, and capability reconciliation |

## 7. Protocol governance

The ecosystem is multilingual in documentation but **monolingual in protocol**: cross-system machine contracts stay ASCII in every language edition. Never translate, transliterate, or localize:

1. event names (`platform.update.available`, `flow.*`, `plugin:<id>:*`);
2. permission points (`iam.user.write`, `workforce.admin`, `platform.update.apply`);
3. error reason codes and the `ok` / `data` / `error` API envelope fields;
4. environment variable names (`DEMO_SEED`, `ADMIN_PASSWORD`, `USAGE_RETENTION_DAYS`, `SECURITY_HEADERS`, `GITHUB_TOKEN`, `DSH_UPDATE_AUTO_CHECK`, `PORTAL_SYNC`, ...);
5. browser storage keys and HTTP headers (`X-On-Behalf-User`);
6. commands, paths, code blocks, and package names (`@deepseek-ai/cordis`, `cli/dshctl.mjs`, `dsh plugin --profile web add github:01men/ybkkasi`).

YuanBingKe additionally enforces **event-source discipline** on its own bus: platform namespaces (`iam.*`, `authn.*`, `mcp.*`, `audit.*`, `platform.*`, ...) accept only internal emitters, while third-party emitters are forced to the `plugin:<id>:` prefix with a matching validated source. The authoritative per-key Chinese glossary is the internal table `docs/协议键中文对照总表.md` (280 keys, R10); English documents may paraphrase meanings but the keys themselves are never rewritten, and any new externally visible protocol key must be added to that table.

## 8. How the ecosystem evolves

The internal Chinese design baseline is `docs/internal/ecosystem-design-v1.2.md`. Read it with two flags:

| Plan step | Status |
|---|---|
| 0 — real transports (MCP HTTP, DingTalk OpenAPI) + transactional metering store | implemented, selftest-verified |
| 1 — token audience checks + plugin-namespace scopes | implemented |
| 2 — multi-tenancy minimal set + usage pipeline (schema v1, reconciliation, capability drift) | implemented |
| 3 — third-party contract, L0 declarative runtime, marketplace gate | implemented |
| 4 — multi-tenancy full isolation | implemented |
| 5 — developer identity domain + transactional journal | implemented (funds-facing parts **deprecated by M0**) |
| 6 — OIDC Provider (RS256 / JWKS) | implemented, extended by the App SSO batches |
| 7 — L0 marketplace beta with first-party supply | implemented |
| 8 — double-entry ledger | implemented as code, **commercial semantics decommissioned and sealed by M0** |
| 9 — knowledge-base-as-service / connector marketplace / compliance portal | designed; roadmap |
| 10 — L1 code-carrying sandbox | designed + PoC notes; roadmap |

**Deprecated by M0 — do not quote as active plans.** The document's commercialization chapters (wallet, double-entry revenue share, model resale, subscription collection, funding-channel dependencies) were **abolished by M0 (2026-09-09)**; the document itself carries a warning banner. The surviving external posture is transparent usage metering + internal cost pass-through, and the marketplace registers all metering at zero price.

Ecosystem direction is set in the internal Chinese docs (`docs/internal/ecosystem-design-v1.2.md`, repo root `README.md`, and the batch release notes); this English set tracks them at the current baseline (2026-10-15) and flags anything that is roadmap rather than shipped.

## 9. Related documents

- [README.md](README.md) — product panorama, the full plugin tree, M0 posture
- [getting-started.md](getting-started.md) — install forms, first boot, CLI, self-update
- [deploy-enterprise.md](deploy-enterprise.md) — enterprise deployment and dsh onboarding runbook
- [product-introduction.md](product-introduction.md) — positioning one-pager
- [release-notes-summary.md](release-notes-summary.md) — release history
- Internal Chinese originals (governing): `docs/internal/ecosystem-design-v1.2.md` (ecosystem baseline; commercialization deprecated by M0), `docs/deploy-enterprise.md` (host-bridge and remote-access runbooks), `docs/协议键中文对照总表.md` (protocol key glossary)
