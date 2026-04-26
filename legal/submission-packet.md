# Claude Connectors Directory — Submission Packet

**ClinicalTrials.gov Explorer (by BLEN)**
A code-mode MCP connector that turns the entire 500K-study ClinicalTrials.gov registry into a single, queryable surface for Claude.

For review under the [Remote MCP Server Submission Guide](https://claude.com/docs/connectors/building/submission) and the [Connector Review Criteria](https://claude.com/docs/connectors/building/review-criteria).

---

## Why this connector belongs in the directory

ClinicalTrials.gov is the world's largest registry of human research — **over 500,000 studies** across every disease area, sponsor, country, and phase. It is the canonical source patients, clinicians, and researchers reach for when they ask the questions Claude is best at answering:

- *"Are there Phase 3 trials enrolling for my mother's cancer within 50 miles of Boston?"*
- *"Show me how diabetes-trial enrollment criteria have shifted over the last five years."*
- *"Summarize eligibility for NCT05012345 in plain English."*
- *"Which sponsors have the most active oncology trials this quarter?"*

The data is **free, public, and trustworthy** — but the API is large (9 endpoints, hundreds of nested fields, 500-page response sets). Naïve "one-tool-per-endpoint" MCP servers either flood the model's context with schemas or hide most of the surface behind opaque wrappers. Neither works for real questions.

This connector takes a different approach.

## What makes it compelling: code mode

Instead of exposing each API operation as its own MCP tool, this server ships **three** tools and lets the model write a short TypeScript function that runs inside a hardened sandbox:

| Tool | Purpose |
|---|---|
| `search_api` | BM25 search over the API surface + study-field dictionary. Returns a focused TS snippet the model can paste. |
| `describe_schema` | Field-dictionary lookup by exact dotted path or prefix. |
| `execute` | Runs an async TS body against a typed `ctgov.*` SDK in an `isolated-vm` V8 isolate (Deno subprocess fallback). |

The model writes one function, chains calls, filters locally, paginates with an async iterator, and returns exactly what the user asked for. The full ClinicalTrials.gov surface fits in a few hundred tokens of context. This pattern follows Cloudflare's [code mode](https://blog.cloudflare.com/code-mode/) blueprint and — to our knowledge — makes this the **first publicly listed code-mode MCP server for clinical research**.

The payoff is concrete:
- A 5-year diabetes-enrollment trend analysis that would take ~12 round-trips with a per-endpoint MCP server completes in **a single `execute` call**.
- The model can do client-side filtering, joins, and aggregation that would otherwise be impossible without bloating tool descriptions.
- New CT.gov endpoints don't require new MCP tools — just a refresh of the indexed schema.

## At a glance

| Field | Value |
|---|---|
| **Display name** | ClinicalTrials.gov Explorer (by BLEN) |
| **Tagline** (≤ 60 chars) | Search & analyze 500K+ clinical trials with Claude |
| **Server URL** | `https://clinicaltrials.mcp.blencorp.com/mcp` |
| **Type** | Web (remote MCP, Streamable HTTP) — also distributed as MCPB desktop extension |
| **Category** | **Health** (primary) · *Life sciences* (cross-reference) |
| **Authentication** | None required — read-only access to a public US-government dataset |
| **Read / Write** | Read-only |
| **Source code** | <https://github.com/blencorp/clinicaltrials-mcp-server> |
| **Documentation** | <https://github.com/blencorp/clinicaltrials-mcp-server#readme> |
| **Privacy policy** | [`legal/privacy-policy.md`](./privacy-policy.md) |
| **Terms** | [`legal/terms.md`](./terms.md) |
| **Support** | <opensource@blencorp.com> · SLOs in [`legal/support.md`](./support.md) |
| **License** | MIT |
| **Publisher** | BLEN, Inc — digital services firm specializing in ML/AI, modernization, and human-centered design |

> Unaffiliated with NIH, NLM, or ClinicalTrials.gov. Data is retrieved live from the
> public v2 REST API at `https://clinicaltrials.gov/api/v2`.

## Description (long form, for the directory listing)

ClinicalTrials.gov Explorer turns the live 500K-study U.S. clinical-trials registry into a single Claude-native research surface. Ask a natural-language question — *"Phase 3 oncology trials by sponsor this year"*, *"recruiting trials within 50 miles of me"*, *"plain-English eligibility for NCT05012345"* — and Claude writes a short program that hits the ClinicalTrials.gov v2 API directly, filters and joins the results, and answers. Built on a "code mode" architecture: three MCP tools instead of dozens, an indexed BM25 search over the API and field dictionary, and a sandboxed TypeScript runtime where Claude's code executes without network, filesystem, or process access. Free to use. No login. No PII collected.

## Use cases

1. **Patients & caregivers** — Find recruiting trials by condition, location, age, and eligibility criteria; translate medical jargon in inclusion/exclusion lists into plain English.
2. **Clinicians** — Build referral dossiers for patients (study sites, contact info, status, sponsor) in seconds.
3. **Clinical researchers** — Run cohort analyses across sponsors, conditions, phases, and time; spot enrollment trends and competitive landscapes.
4. **Regulatory & policy analysts** — Track registration patterns, results-reporting compliance, and demographic representation at scale.
5. **Journalists & educators** — Verify claims about ongoing research with sourceable, link-out-able evidence.

## Tools (3)

All three tools are **read-only** and carry the appropriate MCP annotations (`title`, `readOnlyHint: true`, `destructiveHint: false`).

### 1. `search_api(query, k?)`
BM25 search over the 9 ClinicalTrials.gov v2 endpoints **and** the curated study-field dictionary. Returns a focused TypeScript snippet (paste-ready) plus hit counts. Tool description references the upstream API docs at <https://clinicaltrials.gov/data-api/api>.

### 2. `describe_schema(path? | prefix?)`
Look up study-data fields by exact dotted path (e.g. `protocolSection.eligibilityModule.eligibilityCriteria`) or by prefix (e.g. `protocolSection.designModule`). Returns type, description, and example values.

### 3. `execute(code, timeoutMs?, memoryMb?)`
Runs an async TypeScript body against a typed `ctgov.*` SDK inside a V8 isolate. The SDK surface:
```ts
ctgov.studies.search(params)        // GET /studies
ctgov.studies.searchAll(params, o?) // async iterator over pages
ctgov.studies.get(nctId, params?)   // GET /studies/{nctId}
ctgov.studies.metadata(params?)
ctgov.studies.searchAreas()
ctgov.studies.enums()
ctgov.stats.size()
ctgov.stats.fieldValues({fields})
ctgov.stats.fieldSizes({fields})
ctgov.version()
```

## Worked examples

Five end-to-end examples ship in [`examples/`](../examples/):

1. **Phase 3 oncology by sponsor** — competitive landscape across active Phase 3 cancer trials.
2. **Recruiting trials near a geo point** — patient-facing search by lat/lng, radius, and condition.
3. **Eligibility digest for a single study** — readable summary of inclusion/exclusion criteria.
4. **5-year diabetes registration trend** — time-series aggregation with a single `execute` call.
5. **Site-contact dossier** — per-trial site/contact dump for clinician referrals.

Every example runs against the live API in under 5 seconds.

## Authentication & test access

Authentication is **not required**. ClinicalTrials.gov is a free, public U.S.-government dataset and this connector simply mirrors that posture. Anthropic reviewers can hit the connector directly at `https://clinicaltrials.mcp.blencorp.com/mcp` with no setup — no test account, no credentials, no allowlist. (OAuth scaffolding — Clerk / WorkOS / Auth0 / embedded AS — exists in the codebase for self-hosters who want to gate their own deployment, but the public listing runs open.)

## Compliance & safety

### Tool design (per Anthropic's review criteria)
- ✅ Read-only — no `POST/PUT/PATCH/DELETE` operations exist anywhere in the surface.
- ✅ Tool annotations on every tool: `title`, `readOnlyHint: true`, `destructiveHint: false`.
- ✅ Tool names ≤ 64 chars.
- ✅ `search_api` references the upstream API docs in its description.
- ✅ Descriptions match actual behavior; no prompt-injection patterns, no hidden instructions, no behavioral redirects.
- ✅ Inputs validated with `zod`; errors are actionable.
- ✅ Response sizes bounded by per-call quota; pagination is explicit.

### Sandbox
The `execute` tool is the differentiator and it is hardened end-to-end:
- **Runtime isolation** — `isolated-vm` V8 isolate by default, Deno subprocess (`--no-prompt --allow-none --no-npm --no-remote`) as a portable fallback. Both deny network, filesystem, env, FFI, and subprocess.
- **AST allow-list** — `acorn` preflight rejects `import`, dynamic `import()`, `eval`, `new Function`, `process`, `__host`, and unsafe prototype access *before* the sandbox boots. Defense in depth, not the primary boundary.
- **Resource limits** — 15 s wall-clock, 64 MB heap (per-call overrides via `timeoutMs` / `memoryMb`).
- **Single capability** — the sandbox can only call `ctgov.*` over a host-mediated RPC bridge.

### Network & abuse posture
- Public HTTPS endpoint behind Railway's edge (TLS 1.2/1.3, custom domain).
- Per-IP token-bucket limiter (5 rps sustained / 20 burst) on `/mcp` and `/as/*`, runs **before** any auth check, returns `429` with `Retry-After`.
- Per-subject quotas (60 `execute`/min, 600 upstream/min) and a global 10 rps cap that respects ClinicalTrials.gov's documented rate limit.
- Stale-cache fallback when upstream 5xx's; structured retry with exponential backoff + jitter.

### Data handling
- 5-minute in-memory response cache, per session, never persisted.
- 30-day structured audit logs (trace id, upstream URL, status, duration, byte count). **No request bodies, no response payloads, no PII.** The public deployment collects no user identity at all.
- No model-training on user inputs. Ever.

## Engineering signals

- **Test coverage** — ~60 tests across unit, integration (`nock`/MockAgent), live-API (`CTGOV_LIVE=1`), sandbox chaos, and end-to-end OAuth/embedded-AS flows. CI runs lint, typecheck, tests, build, CLI smoke, and Docker image build on every PR.
- **Schema drift guard** — a weekly GitHub Actions job re-runs `pnpm verify:schema` against upstream and auto-files an issue if the pinned OpenAPI diverges.
- **Submission self-check** — `pnpm check:directory <URL>` runs the directory compliance checklist (HTTPS, health endpoint, ≥3 working examples, legal docs present) against any deployment.
- **Distribution** — published to npm as `@blen/clinicaltrial-mcp-server` (stdio for Claude Desktop), packaged as an `.mcpb` cross-platform desktop extension, and deployable via Railway one-click or Terraform AWS module (ECS Fargate + ALB + ACM + WAFv2).

## Branding assets

| Asset | Path |
|---|---|
| Logo (SVG) | [`assets/icon.svg`](../assets/icon.svg) |
| Launch demo (MP4) | [`assets/launch.mp4`](../assets/launch.mp4) |

## Pre-submission checklist (Anthropic review criteria)

- [x] **Read/write split** — read-only server, no destructive tools.
- [x] **API documentation referenced** — `search_api` description links to `https://clinicaltrials.gov/data-api/api`.
- [x] **Tool annotations present** — `title`, `readOnlyHint: true`, `destructiveHint: false` on all three tools.
- [x] **Tool names ≤ 64 chars**.
- [x] **Descriptions match behavior** — no prompt-injection text, no hidden instructions.
- [x] **Inputs validated** — `zod` on every tool, actionable error messages.
- [x] **No PII collection** beyond what's strictly necessary (none, in the public posture).
- [x] **First-party API** — calls only ClinicalTrials.gov v2; no proxied third parties.
- [x] **No financial transfers, no AI-generated media**.
- [x] **HTTPS** — TLS 1.2/1.3 via Railway edge.
- [x] **Health endpoints** — `/health`, `/healthz`, `/readyz` all return 200.
- [x] **≥ 3 working examples** — five shipped in [`examples/`](../examples/).
- [x] **Privacy policy, terms, support docs** — all in [`legal/`](./).
- [x] **Public source code** — MIT-licensed on GitHub.
- [x] **MCP Inspector tested** — every tool exercised end-to-end before each release.

## Launch readiness

- **Status** — Generally available. Currently `0.1.0-alpha.0` on npm; a `0.1.0` GA tag will be cut to coincide with directory acceptance.
- **Tested surfaces** — Claude Desktop (stdio + MCPB), Claude.ai web (custom connector), Claude Code, MCP Inspector.
- **Targeted launch date** — within 2 weeks of directory acceptance.

## Contact

- **Submission contact**: Mike Endale — <mike@blencorp.com>
- **Support / security / privacy**: <opensource@blencorp.com>
- **GitHub**: <https://github.com/blencorp/clinicaltrials-mcp-server>

---

## About BLEN

[BLEN, Inc.](https://www.blencorp.com) is a digital services company building Emerging Technology (ML/AI, RPA), Digital Modernization (legacy → cloud), and human-centered web/mobile products for federal, state, and commercial clients. We open-source the connectors we build for our own teams whenever the upstream data is public — this is one of them.
