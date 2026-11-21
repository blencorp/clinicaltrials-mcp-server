# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@blen/clinicaltrial-mcp-server` — a "code-mode" MCP server for the ClinicalTrials.gov API v2 (`clinicaltrials.gov/api/v2`, public, no key). Instead of dozens of narrow tools it exposes exactly three — `search_api`, `describe_schema`, `execute` — and lets the model write JavaScript that runs in a locked-down sandbox with one global, `ctgov`. Transports: stdio (default), Streamable HTTP (`--http`), the anonymous docs-only HTTP mode (`--http --public-docs`, the Docker image's default and the production hosting), and account mode (`--http` + `CTGOV_AUTH_PROVIDER=accounts`: Google sign-in, keyless, per-account quotas). Aligned with the sibling `uspto-mcp-server` (the reference) and `fedreg-mcp-server`: the transport, sandbox, search and accounts layers are shared design. The product name is "ClinicalTrials.gov MCP"; the package and bin keep `clinicaltrial-mcp-server`. The development line before 0.1.0 is described in `docs/migration-0.1.md`.

## Commands

Run everything from this directory (`pnpm@12.21.0` pinned via `packageManager`; Node 24 or 26):

```bash
pnpm install
pnpm typecheck                          # tsc --noEmit (src + test), web/tsconfig and web/e2e — THE correctness gate
pnpm test                               # vitest run (all test/*.spec.ts, no network/keys needed)
pnpm test test/search.spec.ts           # single file (args forward to vitest, no -- needed)
pnpm test test/search.spec.ts -t "bm25" # single test by name (pair with file path to keep it fast)
pnpm lint                               # eslint: @eslint/js + typescript-eslint recommended, type-aware promise rules in src/, stderr-only console in src/, react-hooks in web/, plus no-template-curly-in-string, default-case-last, array-callback-return, no-self-compare, radix, no-constructor-return; 0 warnings
pnpm test:web                           # build web + site, then Playwright + axe (web/e2e); journey.spec.ts needs TEST_DATABASE_URL + Deno
pnpm kit:check                          # shared portal kit vs web/portal-kit.json (test/portal-kit.spec.ts runs it too)
pnpm build                              # tsc -p tsconfig.build.json && pnpm build:web (Vite → dist/web) && chmod
pnpm dev                                # tsx src/bin.ts (stdio)
pnpm dev --http --insecure              # HTTP transport, no auth, binds 127.0.0.1; also --port, --host, --sandbox
CTGOV_LIVE=1 pnpm test                  # opt-in live harness (test/liveIntegration.spec.ts); read-only, never in PR CI
pnpm regen:sdk                          # regenerate/verify schema/ctgov.json against the live OpenAPI + metadata
pnpm verify:schema                      # compare the corpus with schema/openapi.pinned.json (the weekly schema-drift workflow)
node scripts/gen-sdk-reference.mjs      # regenerate the method section of docs/sdk-reference.md from schema/ctgov.json
pnpm mcpb:prepare && pnpm mcpb:pack     # stage + pack clinicaltrials-mcp-server.mcpb (after pnpm build)
node scripts/mcpb-smoke.mjs <unpacked-bundle-dir>   # execute('return 42') in an unpacked MCPB
```

- In `pnpm build`, the `|| true` guards only the `chmod` — a `tsc` failure DOES fail the build. `pnpm typecheck` remains the broader gate (it also covers `test/**`, which the build config excludes).
- CI (`.github/workflows/ci.yml`) runs `pnpm audit --audit-level moderate`, `typecheck`, `lint`, `build`, `test` on Node 24 and 26 with Postgres and Deno and `CTGOV_REQUIRE_RUNNERS=1`, plus an npm-package/MCPB smoke job (Node 24 and 26), an accessibility job, a Docker job (refusals, docs-only default, `execute` in Deno behind bearer authentication) and a conventional-commits job. The PR template requires the gates as checkboxes. `release.yml` calls ci.yml through `workflow_call`.
- Sandbox and account tests skip when their dependency is missing (no runner / no `TEST_DATABASE_URL`). `test/required-runners.spec.ts` turns those skips into failures when `CTGOV_REQUIRE_RUNNERS=1` (CI), so a green CI run means they actually ran. Locally, a throwaway Postgres works:
  `docker run -d --rm --name ctgov-mcp-test-pg -e POSTGRES_PASSWORD=ctgov-ci -e POSTGRES_DB=ctgov_test -p 127.0.0.1:55432:5432 postgres:17-alpine`
  then `TEST_DATABASE_URL=postgres://postgres:ctgov-ci@127.0.0.1:55432/ctgov_test CTGOV_REQUIRE_RUNNERS=1 pnpm test` (needs Deno on PATH). If another database already holds 55432, use a free host port in both commands; otherwise the account tests fail with a password error.

### Environment notes

- `isolated-vm` 7 ships prebuilt binaries for Node 24 and 26 on darwin-arm64, linux-x64/arm64 (glibc + musl) and win32-x64; `node-gyp-build` loads them at runtime, so no compiler is needed and `--ignore-scripts` installs still work. Deno (2.9.x; CI and the Docker image pin 2.9.8) is the other runner; if installed to `~/.deno/bin`, prefix commands with `PATH="$HOME/.deno/bin:$PATH"`.
- **TypeScript 7 runs side by side with TS 6**: `devDependencies.typescript` is `npm:@typescript/typescript6` (the 6.0 API that typescript-eslint and other tooling import) and `@typescript/native` is `npm:typescript@^7`, which provides the `tsc` binary. typescript-eslint refuses TS 7's API; don't "simplify" the aliases away.
- ClinicalTrials.gov needs no key. `.env` is gitignored and is NOT loaded by the server (`set -a; . ./.env; set +a`); there is no dotenv and `.env.example` is documentation only.
- Build-script approval for esbuild/isolated-vm lives in `pnpm-workspace.yaml` (`allowBuilds:`), together with `overrides:` that pin patched transitive versions for dev tooling (pnpm audit). Remove an override once its parent ships the fix. `auditConfig.ignoreGhsas` lists advisories with no patched release, for dev tooling only; each entry needs a row in `EXCEPTIONS` in `test/audit-exceptions.spec.ts`. `.github/workflows/security.yml` runs `scripts/security-audit.mjs` daily. `.pnpmfile.cjs` drops better-auth's optional peers (vitest, react, react-dom) from the production graph; the Dockerfile and the MCPB prepare step copy it next to the lockfile.

## Architecture

Request flow (all transports converge on the same tool catalog):

```
stdio | Streamable HTTP (+OAuth, Host/Origin, per-IP bucket, quotas) | accounts   src/server/{stdio,http}.ts, src/accounts/
  -> buildMcpServer (SDK v2 McpServer, registerTool + outputSchema)            src/server/mcpServer.ts, toolCatalog.ts
  -> tools: searchApi | describeSchema | execute (admission, budgets, cancel)   src/tools/
  -> execute: AST preflight -> sandbox runner (byte budgets, host deadline)    src/sandbox/{policy,limits,isolate,deno}.ts
  -> sandbox global (ctgov Proxy) --RPC bridge--> dispatch()                   src/sdk/runtime.ts
  -> HttpClient (shared gate + LRU + retry + caps)                             src/util/{httpClient,upstreamGate}.ts
  -> clinicaltrials.gov/api/v2
```

`buildSupervisor(cfg)` in `src/supervisor/index.ts` is the single composition root: it builds ONE set of sources (shared by the corpus and dispatch), one process-wide upstream gate, the corpus, the sandbox (`pickSandbox(kind, { processIsolation })`), the `ExecutionLimiter`, per-execute call budgets and per-subject quotas, and returns `CatalogDeps`, which everything downstream receives by injection. `UPSTREAM_DEFAULTS` and `EXECUTION_DEFAULTS` there hold the defaults. All env vars are read in `src/bin.ts` (plus `CTGOV_LOG_LEVEL` in the logger; account settings are read from the `env` object bin.ts passes to `loadAccountConfig`) — nothing else reads configuration from `process.env` (the Deno runner only passes PATH/HOME/DENO_DIR/TMPDIR/... through to its child).

**Source registry** (`src/sdk/sources/ctgov.ts`): the factory returns `{ name, label, enabled, client, methods, corpus }`. The frozen `methods` table explicitly registers the public SDK methods (`studies.search/get/metadata/searchAreas/enums`, `stats.size/fieldValues/fieldSizes`, `version`); dispatch resolves only those own data properties and never traverses `client` or its internals. `METHOD_PATHS` records the upstream path of each, checked against `schema/openapi.pinned.json`. The source name is validated as a safe JS identifier at boot (it is interpolated into generated sandbox code). There is no `searchAll`: loop on `nextPageToken` with `pageToken`.

**SDK client** (`src/sdk/ctgov-client.ts`): parameters are validated with zod before any request (`parseParams`); search parameters are **flat dotted keys** (`'query.cond'`, `'filter.overallStatus'`), never nested objects, and an unknown key is a `ValidationError` that names the fix. NCT ids match `NCT` plus eight digits, so identifiers cannot change the endpoint path. A 404 is never cached.

**Corpus** (`schema/ctgov.json`, `{provenance, endpoints[], fields[]}`): `search_api`/`describe_schema` only surface what is in this file. Endpoint entries are hand-written (one per registered method; `test/sources.spec.ts` asserts the ids equal the methods table and the paths match the pinned OpenAPI; `test/corpus.spec.ts` parses every `example` with acorn, runs it through the real preflight and checks it only calls registered methods). Field entries (`ctgov.fields.<path>`) are curated and verified against `/studies/metadata`; `ctgov.syntax.*` notes cover queries, Essie, geo, paging, fields, ids and errors.

**Sandbox** (`src/sandbox/`): an acorn AST preflight (`policy.ts`, bans imports/eval/`process`/`globalThis`/`Deno`/`fetch`/`constructor`/`__proto__`/etc.; it walks the code parsed as a module AND as a script, and requires the wrapper to stay one call), then a runner. Both runners: user code wrapped in `(async () => { ... })()`, a **host-owned wall-clock deadline** that starts before setup and covers never-settling promises, the execution's `AbortSignal`, and byte budgets from `limits.ts` (code 256 KiB, result 256 KiB → `ResultTooLarge`, logs 64 KiB / 1000 lines, RPC args 64 KiB, 100 pending calls) enforced **inside the sandbox before anything is transferred** and again on the host. SDK errors keep `name`/`message`/`status` across the boundary.
- `isolate.ts`: fresh `isolated-vm` isolate per execution (heap cap = `memoryMb`), disposed on deadline/abort.
- `deno.ts`: `deno run --no-prompt --no-config --no-lock --no-remote --no-npm` of a FIXED supervisor script (it never contains user code) with no `--allow-*` flags and a minimal env. The supervisor announces a random token, receives the code in a stdin frame, and runs it as a module in a module Worker that first deletes every global outside an allowlist of the language's own and whose `console` posts log messages; V8 runs with `--disallow-code-generation-from-strings`. Frames are token-prefixed JSON lines; anything else on stdout is untrusted log text; the child's stderr never goes into the result.
- **Two memory limits on Deno**: `memoryMb` is the V8 heap limit (`--max-old-space-size`), which does not count buffers, so the supervisor also kills the process when its resident memory grows by more than 2 × `memoryMb` + 96 MiB above its startup baseline (224 MiB at the default 64). Size containers for about 8 × that growth plus the Node server (8 executions at once is the worst case).
- `pickSandbox` (`index.ts`): `auto` prefers isolated-vm for single-user use (stdio, `--insecure`). With `processIsolation` (authenticated `--http`, incl. accounts — set in bin.ts) only Deno is allowed: `--sandbox isolate` throws at startup, and `auto` without Deno yields an `UnavailableRunner` (execute reports why) — never a silent fallback to in-process execution. Sandbox startup is resolved when the server starts; docs-only serving never resolves one.

**execute** (`src/tools/execute.ts`): refuses to start if the request or server is already aborted; admission via `ExecutionLimiter` (8 global / 2 per subject; `Busy` beyond); a per-execution `AbortController` combines the MCP request's signal, the shutdown signal and the end of the execution, and reaches the HTTP client through `AsyncLocalStorage` (`src/util/executionContext.ts`) so queued and in-flight upstream calls stop. Call budget 100 per execute, per-subject hourly quota 3000 (authenticated HTTP only).

**HTTP transport** (`src/server/http.ts`): MCP `2026-07-28` — stateless, no `initialize` handshake, no `Mcp-Session-Id`. `createMcpHandler` builds a fresh `McpServer` + tool catalog **per request**, so the subject a tool sees always comes from that request's own bearer token. Pre-2026 clients are served by the SDK's stateless legacy fallback, and `GET`/`DELETE /mcp` return 405. It fails closed: `--http` without `--insecure` or `--public-docs` refuses to start unless an OIDC provider or `accounts` is configured; unknown providers stop startup; OIDC requires issuer + audience + JWKS (https, or http on loopback), verifies `exp`/`sub`, asymmetric algorithms only, and every `CTGOV_AUTH_SCOPES` scope (default `ctgov:read`; 403 `insufficient_scope`). Trusted hosts come from `CTGOV_PUBLIC_ORIGIN`/`CTGOV_ALLOWED_HOSTS` plus loopback on the listening port — never from the request's Host; binding beyond loopback without them stops startup, and authenticated serving needs `CTGOV_PUBLIC_ORIGIN` specifically (421 for other hosts; `GET /health` is exempt). Bodies are capped at 1 MiB (also in the Node adapter).

**Hosting modes and precedence.** `--public-docs` (anonymous, docs-only, no sandbox, no database; the image's default `CMD` and `railway.json`'s start command) and `--insecure` (local development) each refuse to start together with ANY configured auth provider, including `accounts`, and with each other; `accounts` needs `--http`. `test/cli.spec.ts` pins every refusal. To run authenticated serving or account mode from the image, override the command with `--http` (the default CMD is docs-only on purpose, so a deployment that forgot the override cannot serve unauthenticated execute). The AWS task definition starts `--http` explicitly for the same reason.

**Account mode** (`src/accounts/`, `web/`, docs/accounts.md): keyless — no credentials table, no key step, no encryption keyring. `/mcp` is anonymous and registers ONLY `search_api` + `describe_schema`; a direct `execute` call is "Tool not found". `/mcp/account` (OAuth, Google sign-in, scope `ctgov:read`) is the only place code runs, in Deno only. Quotas stay on: per-account hourly counters in PostgreSQL (`request_limits`), a per-account daily quota, `ExecutionLimiter` per subject and the shared process-wide upstream gate (do not copy uspto's "subject quotas disabled" — there is no per-user key to supply limits). Better Auth's other routes are closed (`disabledPaths`).

**Results and errors** (MCP SDK v2, verified on the wire):
- Tool results are compact JSON text plus the same object as `structuredContent`, validated against the tool's `outputSchema` (`OUTPUT_SCHEMAS` in toolCatalog.ts).
- `execute` returns `{ ok, value, logs: string[], error?: { name, message, status? }, durationMs }`; a failed one (`ok: false`: thrown error, timeout, limit, `Busy`) sets `isError: true` WITH the full envelope.
- `isError: true` also appears for a thrown handler exception and for argument-validation failures (the SDK's Ajv validator; input schemas come from Zod 4's `z.toJSONSchema` with `additionalProperties: false`, real integer/min/max/length constraints, and a `oneOf` for describe_schema's path|prefix rule).
- An **unknown tool name is not a tool result** — it surfaces as a JSON-RPC error `{"error":{"code":-32602,"message":"Tool X not found"}}` (HTTP 200, no `result`).

## Hard project rules (from CONTRIBUTING / SECURITY / the PR template, plus code conventions)

- **Never commit or push directly to `main`.** Every change lands via a feature branch + PR — `main` is release-bearing (every push to it runs `.github/workflows/release.yml`), and the only direct writer is the release workflow's own `chore(release)` commit.
- **Anything that weakens the sandbox is out of scope** — never add `fetch`, `import`, filesystem, env, or subprocess access to the sandbox surface, and never let authenticated HTTP serving run user code in-process. Sandbox-escape reports go to a private GitHub Security Advisory, never a public issue.
- **No downloads through the SDK**; return URLs instead.
- **ClinicalTrials.gov has no key and publishes no rate limit.** The process-wide gate (`CTGOV_RATE_PER_SEC`, default 10) is this server's own assumption; do not raise the default or add a path around the gate.
- The public API (three tools; the `ctgov` global) is the contract; breaking it needs a major version bump and migration note.
- PR checklist beyond the gates: HTTP-visible change → add a case to `test/http-integration.spec.ts`; sandbox-visible change → add a positive AND a negative case to `test/sandbox.spec.ts` (both runners via `describe.each`); new SDK method → corpus endpoint entry (with a runnable example) in `schema/ctgov.json`, a `methods`-table registration, a row in `test/dispatch.spec.ts`, and `node scripts/gen-sdk-reference.mjs`.
- ESM everywhere: relative imports use the `.js` extension even in `.ts` sources.
- Logs go to stderr only (`src/util/logger.ts`) — stdout is reserved for stdio JSON-RPC; a stray `console.log` in server code corrupts the protocol stream.
- Commit subjects are Conventional Commits (CI enforces it; the release computes versions from them). No tool or AI attribution lines in commits or PRs.

## Test conventions

- HTTP mocking is undici `MockAgent` injected via the `dispatcher` option of `HttpClient`/`SourceConfig` — never `setGlobalDispatcher`. A new client that doesn't thread `dispatcher` through will silently make real network calls in tests.
- `test/helpers.ts` builds `SourceConfig` and `SupervisorConfig` (gates at 1000/s so tests don't wait). Use it instead of literal configs.
- No `vi.mock`/`vi.fn`/fake timers anywhere; the pattern is hand-written fakes satisfying the DI interfaces (`SandboxRunner`, `RpcBridge`, ...). Follow it.
- No vitest globals and no setup files — every spec imports `describe/it/expect` from `vitest` explicitly. `pool: 'forks'` is required (sandbox runners spawn processes).
- `test/characterization/` pins the pre-migration contract; `docs/migration-0.1.md` lists every expected difference. Change a pin only with a row there.
- `test/http-integration.spec.ts` is the canonical end-to-end check, covering both eras: stateless `2026-07-28` requests (with the `_meta` envelope and `Mcp-Method`/`Mcp-Name` headers) and the legacy `initialize` fallback. `fetch` cannot set `Host` (forbidden header): Host tests use raw `node:http`.
- Auth tests sign real ES256 tokens against a local JWKS server (`jose`); keep negative cases (wrong key/issuer/audience, no exp, expired, no sub, missing scope).
- `test/official-client.spec.ts` drives the server with the real `@modelcontextprotocol/client` SDK. Keep it passing when touching the transport.
- **MCP Inspector cannot exercise the 2026-07-28 path** (its CLI always drives the legacy leg). For the modern path use the client SDK with `versionNegotiation: { mode: 'auto' }` or `{ mode: { pin: '2026-07-28' } }` — the pin is a **nested object**.
- MockAgent interceptors match exact paths, bodies and query strings; changing serialization surfaces as cryptic "no interceptor" errors, not assertion diffs. Mutation-check new lifecycle tests (they should fail without the fix).
- `test/liveIntegration.spec.ts` is skipped unless `CTGOV_LIVE=1`; it must stay read-only, sequential and small.
- `test/release.spec.ts` runs `scripts/release.mjs` against disposable git repositories; `test/mcpb.spec.ts` validates the manifest with the official `mcpb` validator.

## Known traps

- **`queueMicrotask` stays in the Deno worker's global allowlist.** Deno 2.9's own message plumbing calls it on the worker global; without it a program with three or more SDK calls pending at once fails. It only schedules a microtask inside the sandbox's own realm. `test/sandbox.spec.ts` pins this with real global probes — don't remove it from the allowlist, and don't weaken the probes.
- **Don't add an Origin allowlist to the signed-in MCP endpoint (`/mcp/account`).** Hosted connectors (claude.ai, chatgpt.com) send their own `Origin` there; every request carries a bearer token (never a cookie) and the Host check already blocks DNS rebinding. Only the anonymous `/mcp` (no token to check) refuses foreign Origins (`CTGOV_ALLOWED_ORIGINS` extends it). A test pins both.
- **The Docker image's default CMD is `--http --public-docs`, docs-only.** Railway's production service relies on it; `CTGOV_PUBLIC_ORIGIN` must be set (the image binds 0.0.0.0) and the health check path is `/health` (the only path exempt from the Host check). For `execute`, override the command with `--http` plus a provider; combining `--public-docs` with a provider is a startup error.
- **Both Deno memory limits matter** (heap flag and RSS cap above): a heap flag alone does not stop a program that fills buffers, and the RSS check runs every 5 ms, so a program can pass the bound by what it writes in one interval.
- **Hosting-mode precedence is enforced in `src/bin.ts` before anything starts.** Docs-only startup must stay sandbox-free and database-free: do not import `accounts/` or resolve a sandbox on that path.
- **The gate's wake timer is deliberately NOT `unref`'d** while callers wait: a short-lived embedder (script, MCPB host) whose only pending work is a paced call would otherwise exit mid-request. It is cleared as soon as no waiter remains, or tests and processes hang.
- **Result budget.** A study record is large: `fields` is how a program stays under the 256 KiB result and 8 MiB upstream caps. The tool descriptions and corpus say so; keep them saying so.
- `HttpClient` caps bodies at `maxResponseBytes` (default 8 MiB, after bounded gunzip) and its LRU at 32 MiB of text; the cache TTL is 5 minutes.
- `LATEST_PROTOCOL_VERSION` / `SUPPORTED_PROTOCOL_VERSIONS` exported by the v2 SDK are the **legacy-era** vocabulary — NOT the revision this server speaks. Use `MCP_PROTOCOL_VERSION` from `src/server/mcpServer.ts`; a test pins `/health` to it.
- Execute limits (`timeoutMs` default 15000 / max 60000, `memoryMb` default 64 / max 256) are per-call Zod defaults on the `execute` tool — NOT env-configurable; don't invent `CTGOV_EXEC_*` vars. Byte budgets live in `src/sandbox/limits.ts` (`DEFAULT_LIMITS`). Transport is chosen only by the `--http` flag.
- MCPB packaging: `pnpm build && pnpm mcpb:prepare && pnpm mcpb:pack` produces `clinicaltrials-mcp-server.mcpb` (manifest v0.4 from `buildManifest()` in `scripts/mcpb-prepare.mjs`, schema-validated during prepare; `compatibility.runtimes.node` matches `engines`; no `user_config` and no `env`, because there is no key). The prepare step copies `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `.pnpmfile.cjs` into `mcpb-build/` (making it its own workspace root, so pnpm never walks up and `--prod`-prunes the ROOT `node_modules`; `--ignore-workspace` would make `--frozen-lockfile` fail with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`) and installs with `--frozen-lockfile --config.node-linker=hoisted`. `--ignore-scripts` is fine: isolated-vm loads its prebuilt binary.
- `dist/web/THIRD_PARTY_NOTICES.txt` is emitted by the Vite plugin in `web/third-party-notices.ts`. `BUNDLED_DEV_DEPENDENCIES` in `scripts/release-lib.mjs` lists the portal's devDependencies that ship in `dist/web`; `test/release.spec.ts` fails when `web/` imports a package missing from it.
- `dist/` is never cleaned between builds — delete it manually after renaming/moving source files. Never edit `dist/` or `mcpb-build/` (gitignored build artifacts).
- **Releasing.** The version string lives in `package.json` and one marker line in `src/server/mcpServer.ts` (`SERVER_VERSION`, tagged `x-release-version`); the release workflow stamps both. `.github/workflows/release.yml` runs on every push to `main`: gates (the full CI via `workflow_call`) → `cut` (contents: write, `release` environment, `--ignore-scripts`; pushes the release commit and tag as the release GitHub App using a token minted just before the atomic push — its `chore(release):` run skips `gates`; `scripts/release.mjs` bumps, writes the CHANGELOG section, builds, packs `blen-clinicaltrial-mcp-server-*.tgz` and `clinicaltrials-mcp-server.mcpb`, tags, creates the GitHub Release) → `publish` (id-token only, `npm` environment limited to `main`; publishes that exact tarball via npm trusted publishing). With no tags yet, `release.mjs` releases the version `package.json` declares (0.1.0) using its hand-written CHANGELOG section. The first npm version must be staged by hand (`npm stage publish` + 2FA) because trusted publishing needs an existing package. The documentation site's Claude Desktop button downloads `clinicaltrials-mcp-server.mcpb` from the latest release, and `site/scripts/check-links.mjs` (run in the Docker docs stage) reads `release.yml` for that name: keep both. Dry run: `node scripts/release.mjs` in a scratch clone writes `release-notes.generated.md` and stamps files (it is gitignored); never run it in your working tree with uncommitted changes.
- **Conventional-commits CI job.** For pushes it checks `$BEFORE..$HEAD`, else `<last tag>..HEAD`, else `.release-base..HEAD` (a file holding the SHA of `main` when the pipeline was introduced: the repository predates the convention, e.g. `b153f61 Fix video source path in README.md`). Once the first tag exists, `.release-base` is unused; don't edit it to hide a bad subject.

## Portal (web/) and accessibility

- `web/src/components/kit/`, `components/ui/`, `index.css`, `lib/utils.ts` and the BLEN logo are a **kit shared byte for byte** with BLEN's other MCP servers, hashed in `web/portal-kit.json` (`pnpm kit:check`/`kit:update`, `test/portal-kit.spec.ts`). Product text lives in `web/src/brand.tsx`; product pages and per-repo helpers stay local. Don't put product strings in kit files.
- Target WCAG 2.2 AA / Section 508 (`docs/accessibility.md`). Each page renders through `Page`/`Shell` (skip link, landmarks, one h1, tab title). Errors use `Notice` (role=alert), confirmations `Notice kind="success"` (role=status). Field errors go through `Field`'s `error`. Tokens keep text >= 4.5:1 and borders/focus ring >= 3:1 — `web/e2e/accessibility.spec.ts` (axe, light/dark, 1280/320 px) fails on regressions.
- The policy pages (`/privacy-policy`, `/terms`) are the connectors' registered privacy policy, so their text is in the HTML: `web/prerender.ts` renders them after the client build. `web/e2e/prerender.spec.ts` guards it.
- Server side: `PORTAL_ROUTES` in `src/accounts/app.ts` lists the SPA routes; unknown paths answer browser navigations with the portal's 404 and everything else with plain `Not found`.
- The docs site's product values are in `site/product.mjs`; tables are focusable (rehype in `site/astro.config.mjs`).

## Docs

`docs/ARCHITECTURE.md` (layered design and security boundaries), `docs/sdk-reference.md` (search syntax, identifiers, errors, and the generated `ctgov` method reference), `docs/accounts.md` (account mode, portal API, limits), `docs/accessibility.md` and `docs/migration-0.1.md` (every change from the `0.1.0-alpha.0` line) are the deep references. `site/` is the public documentation site (Astro Starlight, base `/docs`; its own pnpm root and lockfile; `cd site && pnpm build`). `deploy/Dockerfile` builds it into `docs-site/` (a sibling of `dist/`, so the npm package never ships it) and the hosted server serves it at `/docs` in `--public-docs` and account modes (`src/accounts/docs.ts`). Its SDK reference page is `docs/sdk-reference.md` copied in at build time and its recipes read `examples/*.js`, so edit those sources. `legal/` holds the hosted-service policies bundled into the portal, `legal/submission-packet.md` the Claude connector directory submission (`pnpm check:directory`).
