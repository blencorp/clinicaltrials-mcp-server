# Migrating to 0.1.0

0.1.0 moves the server to MCP SDK v2 (protocol revision 2026-07-28, with the 2025 `initialize`
era still answered), makes HTTP serving stateless and fail closed, and returns structured tool
results. The three tools keep their names; the `ctgov.*` SDK keeps every method except `searchAll`, and the
`execute` result has a new shape. Nothing was published
before 0.1.0, so these are the changes from the `0.1.0-alpha.0` development line.

## Do I need to do anything?

| You are... | Impact |
|---|---|
| A **stdio** user (Claude Desktop, `npx`) | Use Node 24 or 26. A failed `execute` now carries `isError: true`. Programs that call `ctgov.studies.searchAll` must loop on `pageToken` (see "Sandbox and SDK"). The MCPB bundle no longer ships Deno. |
| An **MCP client** | Read "Client-visible changes": unknown tools are JSON-RPC errors, results carry `structuredContent`, arguments are schema-validated, `search_api`, `describe_schema` and `execute` have new result shapes. |
| A **server operator** (`--http`) | Read "Operator changes": startup now refuses incomplete configuration, sessions and the embedded authorization server are gone, and `CTGOV_PUBLIC_ORIGIN` is required beyond loopback. |
| A **library importer** (`@blen/clinicaltrial-mcp-server`) | See "Public exports". |

## Client-visible changes

1. **A failed `execute` is a tool error.** `ok: false` (a throw, timeout, limit or policy
   violation) now sets `isError: true`. The text block and `structuredContent` still hold the
   full envelope. The envelope shape itself changes too (item 10).
2. **Structured results.** Every tool declares an `outputSchema` and returns the result as
   `structuredContent`, with the same object as compact JSON text (no pretty-printing).
3. **Unknown tools are JSON-RPC errors.** `tools/call` for a tool that does not exist, including
   `execute` on the docs-only endpoint, answers `-32602` "Tool X not found" instead of an
   `isError` result.
4. **Arguments are validated against the advertised schema first.** Schemas carry real integer,
   minimum, maximum and length constraints and `additionalProperties: false`, so unknown keys
   are rejected (they used to be stripped) with `isError: true` and a text starting
   `Input validation error:`.
5. **`describe_schema` needs exactly one of `path` or `prefix`.** Neither (which used to return
   every field) and both (path used to win) are rejected.
6. **`search_api` returns one JSON block** `{hits, note}`: `hits` is an array of corpus entries
   `{id, kind, binding, description, signature?, example?, score}` (`k` defaults to 10, at most 50),
   `note` points at `describe_schema` and `execute`. The old two-block result and the interim
   `{query, snippet, hits: N}` are both gone, and the TypeScript "snippet" is replaced by the entries'
   `signature` and runnable `example`. `describe_schema` returns `{found: true, entries}` or
   `{found: false, message}` where it used to return `{matches, total}`; its `path` and `prefix` are
   corpus ids such as `ctgov.studies.search` or `ctgov.fields.protocolSection.statusModule.overallStatus`
   (a bare field path no longer matches). These two shapes are shared with the other BLEN code-mode
   servers, so one client or docs page covers all of them.
7. **Tool listing**: every tool has a `title` and an `outputSchema`; the server sends workflow
   `instructions`, `listChanged` is advertised as true by the SDK, and list results carry
   `ttlMs` / `cacheScope` cache hints (modern era).
8. **Request bodies over 1 MiB** are refused with `413`.
9. **Validation error shapes** inside the sandbox come from Zod 4: `invalid_enum_value` is now
   `invalid_value`, and string-format issues carry `origin`/`format`/`pattern`.
10. **The `execute` envelope** is now `{ok, value, logs, error?, durationMs}`:
    - `result` is renamed `value`; `logs` is an array of strings (`console.log("hi", {a: 1})` gives
      `hi {"a":1}`) instead of `{level, args, ts}` objects; `error` is `{name, message, status?}`
      without `stack` or `code`; `calls` (the upstream trace) and `executor` are gone.
    - An SDK error keeps its `name`, `message` and `status` all the way out (`NotFound` / 404,
      `ValidationError`, `RateLimited` / 429 ...). It used to be flattened to `Error` with
      `code: SANDBOX_ERROR`.
    - A timeout is `{name: "TimeoutError", message: "Execution exceeded 15000ms"}` (was
      `SandboxTimeout` / `SANDBOX_TIMEOUT`), a refused program is `PolicyError` (was
      `POLICY_VIOLATION`), an unavailable sandbox is an `ok: false` result named `SandboxUnavailable`
      (was a thrown error).
    - Other limit errors: `ResultTooLarge`, `MemoryLimitExceeded`, `Busy`, `AbortError`,
      `CallBudgetExceeded`, `SubjectQuotaExceeded`, `ArgumentsTooLarge`, `OutputTooLarge`.
11. **`searchAll` is removed.** See "Sandbox and SDK".

## Operator changes

1. **Node 24 or 26**, as in the toolchain change.
2. **The transport is stateless.** `createMcpHandler` with `legacy: 'stateless'` builds a fresh MCP
   server per request. There is no session id, no session map, no `Mcp-Session-Id`, no
   `CTGOV_MAX_SESSIONS` and no subject-to-session binding: the bearer token is verified on every
   request. `GET` and `DELETE` on `/mcp` answer `405` with `Allow: POST, OPTIONS`.
3. **The embedded authorization server is removed**, with `CTGOV_EMBEDDED_USERS` and the
   `/as/*` routes. `CTGOV_AUTH_PROVIDER=embedded` (any value outside `none`, `generic-oidc`,
   `clerk`, `workos`, `auth0`) stops startup. Use an OIDC issuer. The proxy of the issuer's
   `/.well-known/oauth-authorization-server` is also gone; clients read it from the issuer named in
   the protected-resource metadata.
4. **OIDC fails closed.** A provider needs `CTGOV_AUTH_ISSUER`, `CTGOV_AUTH_AUDIENCE` and an
   `https` `CTGOV_AUTH_JWKS_URL` (http only on loopback; the JWKS URL is no longer derived from the
   issuer). Only asymmetric algorithms (RS/PS/ES/EdDSA) are accepted, so HS256 and `none` tokens
   are refused; tokens need `exp` and `sub`; **every** configured scope must be present
   (`403 insufficient_scope` names the missing ones). The `*` wildcard scope no longer grants access.
5. **The scope is `ctgov:read`** (was `ctgov.read`). Update the authorization server's scope, the
   Clerk/OIDC application and `CTGOV_AUTH_SCOPES`.
6. **Hosting-mode precedence.** `--public-docs` or `--insecure` together with any configured
   `CTGOV_AUTH_PROVIDER` is a startup error (they used to ignore the provider silently).
   `--public-docs` and `--insecure` remain mutually exclusive. Docs-only startup stays
   sandbox-free and database-free.
7. **Host validation is always on.** Trusted hosts are `CTGOV_PUBLIC_ORIGIN`, `CTGOV_ALLOWED_HOSTS`
   and loopback on the listening port, never the request's own `Host`; others get `421`. Binding
   beyond loopback without `CTGOV_PUBLIC_ORIGIN` or `CTGOV_ALLOWED_HOSTS` stops startup, and
   authenticated serving beyond loopback needs `CTGOV_PUBLIC_ORIGIN` specifically (the OAuth metadata
   names it). **The default Docker image binds 0.0.0.0, so hosting platforms such as Railway must now set
   `CTGOV_PUBLIC_ORIGIN`.** `GET /health` is exempt.
8. **Origin validation applies to the anonymous endpoint only** (`--public-docs`, `--insecure`):
   own origin, `CTGOV_ALLOWED_ORIGINS` and loopback pass, anything else is `403`. Bearer-authenticated
   endpoints accept any Origin, because hosted connectors (claude.ai, chatgpt.com) send theirs. The
   OAuth discovery documents and `/mcp` answer CORS preflights without credentials.
9. **Health.** `GET /health` is `{status, version, protocol}` (protocol `2026-07-28`; the old
   `timestamp` is gone). `/healthz` and `/readyz` are **removed**: they exposed the executor and
   provider. Point platform health checks at `/health` (the Dockerfile
   and `.railway/railway.ts` already do).
10. **Env var changes.**

    | Old | New |
    |---|---|
    | `CTGOV_AUTH_RESOURCE` | `CTGOV_AUTH_AUDIENCE` (the advertised resource is `CTGOV_PUBLIC_ORIGIN` + `/mcp`) |
    | `CTGOV_AUTH_JWKS_URL` (optional) | required, https |
    | `CTGOV_AUTH_SCOPES` default `ctgov.read` | default `ctgov:read`, all required |
    | `CTGOV_TRUST_PROXY=1` (trusted the left-most `X-Forwarded-For`, which a client can forge) | `CTGOV_CLIENT_IP_HEADER`: name the header your proxy overwrites (Railway `x-real-ip`; ALB `x-forwarded-for`, rightmost entry used) |
    | `CTGOV_MAX_SESSIONS`, `CTGOV_EMBEDDED_USERS` | removed |
    | `CTGOV_DENO_PATH`, `CTGOV_DENO_ROOT` | removed: `deno` is found on `PATH` only (the Docker image installs it; the MCPB bundle ships none) |
| - | `CTGOV_PUBLIC_ORIGIN`, `CTGOV_ALLOWED_HOSTS`, `CTGOV_ALLOWED_ORIGINS` |
| - | `CTGOV_RATE_PER_SEC`, `CTGOV_MAX_CONCURRENT_EXECUTIONS`, `CTGOV_MAX_EXECUTIONS_PER_SUBJECT`, `CTGOV_MAX_CALLS_PER_EXECUTE`, `CTGOV_SUBJECT_RATE_PER_HOUR`, `CTGOV_BASE_URL` (see "Limits") |

    Environment variables are read only in `src/bin.ts`, plus the log level (`CTGOV_LOG_LEVEL`) and
    the fixed set of variables (`PATH`, `HOME`, `DENO_DIR`, `TMPDIR`, ...) the Deno runner copies
    into its otherwise empty child environment. `CTGOV_SANDBOX` is read in `bin.ts` too. An unknown
    CLI option or `--sandbox` value now stops startup instead of being ignored.
11. **Dependencies.** `@modelcontextprotocol/sdk` 1.x is replaced by `@modelcontextprotocol/server`
    and `/node` 2.x, zod 3 by 4, undici 6 by 8 (the `dispatcher` option is kept) and jose 5 by 6.
    The temporary audit exception for zod is gone.

## Public exports

`src/index.ts` (the package entry point) now exports, at runtime:

- `startStdioServer`, `startHttpServer`, `buildMcpServer`, `buildSupervisor`, `pickSandbox`
- `MCP_PROTOCOL_VERSION` (`2026-07-28`), `SERVER_VERSION`
- `AUTH_PROVIDERS`, `DEFAULT_SCOPE`

and the types `StdioStartOptions`, `HttpServerOptions`, `HttpHandle`, `CatalogDeps`,
`SupervisorConfig`, `SandboxKind`, `SandboxRunner`, `ExecuteOptions`, `ExecuteResult`, `AuthConfig`,
`AuthProvider`.

Removed: `EmbeddedAs`, `EmbeddedAsOptions`, `buildAuthAdapter`, `loadAuthConfig`; and with the sandbox
rewrite (package C) `selectSandbox` (now the async `pickSandbox(kind, {processIsolation})`, which
returns a runner that says why `execute` is unavailable instead of throwing), `BuildMcpServerOptions`,
`SandboxMode` (now `SandboxKind`), `SandboxExecuteOptions`, `SandboxExecutor` and `SandboxResult`.
`buildMcpServer(deps, requestCtx?)` takes the dependencies `buildSupervisor(config)` builds once per
process (HTTP client with its cache and upstream gate, corpus, sandbox, limiters); `startHttpServer`
and `startStdioServer` build them from `supervisor`, `sandboxMode` and `dispatcher` options, or take
prebuilt `deps`. `startHttpServer`
no longer reads the environment: pass `auth`, `publicOrigin`, `allowedHosts`, `ipRps` and the rest as
options (`src/bin.ts` shows the mapping). `buildMcpServer` returns an `McpServer` (was the low-level
`Server`). `test/exports.spec.ts` keeps this list in step with `dist/index.js`.

## Expected differences from the 0.1.0-alpha.0 characterization tests

Every pin in `test/characterization` either still holds or is changed by one of these rows; the
rest of the suite pins unchanged behaviour (SDK wire paths, retry, cache, paging).

| ID | Pin | Was | Now |
|---|---|---|---|
| D1 | unknown tool, `execute` on docs-only | `isError` with `{name: CtGovError, code: VALIDATION_ERROR, message: "Unknown tool: X"}` | JSON-RPC `-32602` "Tool X not found" |
| D2 | argument validation | Zod issues as `{name: ZodError, message}` JSON; unknown keys stripped; `k: 1.5` rejected by Zod; `describe_schema` `{}` returned all 31 fields, `path` won over `prefix` | SDK Ajv `Input validation error: ...` text, unknown keys rejected, `describe_schema` needs exactly one (fixture `describe_schema.all.json` removed) |
| D3 | result text | 2-space pretty JSON, no `structuredContent`; error envelopes pretty | compact JSON plus identical `structuredContent`; error envelopes compact (same fields) |
| D4 | in-sandbox/dispatch validation | Zod 3 issue codes | Zod 4 (`invalid_enum_value` to `invalid_value`; NCT-ID regex issue reshaped). **Superseded by C5**: the error is a bounded `ValidationError` message. |
| D5 | `execute` `ok: false` | no `isError` | `isError: true` |
| D6 | `search_api` result | two text blocks: snippet, then `{"hits": N}` | one block `{query, snippet, hits}` (snippet byte-identical). **Superseded by C9.** |
| D7 | `tools/list` | no titles, no `outputSchema`, loose number types, `{tools: {listChanged: false}}`, no instructions | titles, `outputSchema`, integer/min/max, `additionalProperties: false`, `oneOf` on `describe_schema`, `{tools: {listChanged: true}}`, instructions, cache hints (fixtures regenerated) |
| H1 | 401 challenge | `Bearer realm=..., resource_metadata=<root PRM>`; garbage token had no `error` | `Bearer resource_metadata=<path-suffixed PRM>`; invalid token adds `error="invalid_token"` |
| H2 | scope | `ctgov.read` | `ctgov:read` |
| H3 | scope matching | any one scope, `*` wildcard granted | every scope, no wildcard |
| H4 | PRM document | `resource` from `CTGOV_AUTH_RESOURCE`, name "ClinicalTrials.gov Explorer (by BLEN)", privacy-policy link | `resource` = public origin + `/mcp`, name "ClinicalTrials.gov MCP", README link; also served at `/.well-known/oauth-protected-resource/mcp` |
| H5 | AS metadata | proxied from the issuer, or served by the embedded AS | not served (404) |
| H6 | `/mcp` methods | `GET`/`DELETE` served the session stream; other verbs `405 Allow: POST, GET, DELETE` | `GET`/`DELETE`/others `405 Allow: POST, OPTIONS` |
| H7 | health | `/health` `{status, timestamp}`; `/healthz` and `/readyz` reported executor/provider/tools | `/health` `{status, version, protocol}`; `/healthz`, `/readyz` removed (404) |
| S1 | session semantics | session ids, subject mismatch `403` | no sessions; the token is verified per request |
| S2 | embedded AS | `/as/*` endpoints and body limits | removed (404) |
| S3 | startup rules | `embedded`/unknown provider accepted; missing issuer error text; HOST-derived bind; `--public-docs`/`--insecure` ignored a provider | unknown provider, missing issuer/audience/https JWKS stop startup (A1); non-loopback needs the trusted hosts (A2); provider with `--public-docs`/`--insecure` is an error |
| S4 | bad request target | `400` plain `bad request` | unchanged |
| S5 | `tools/call` over stdio | pretty JSON, no structured content | as D3/C9 (`test/cli.spec.ts`) |

Unchanged and still pinned: the upstream paths, query serialization (schema key order, comma-joined
arrays, `true`/`false`), the NCT-ID rule, the 404-is-not-cached rule, the flat-dotted-key hint (now
rendered correctly, C7), the isolate-refusal for authenticated serving, loopback binding for `--insecure`,
the 400/404 shapes and the plain-text 401/403 bodies.

### Package C rows

| ID | Pin | Was | Now |
|---|---|---|---|
| C1 | `execute` envelope | `{ok, result, error{name,message,stack,code}, logs[{level,args,ts}], calls[], durationMs, executor}` | `{ok, value, logs: string[], error{name,message,status?}, durationMs}`; SDK errors keep name/message/status across the boundary; `isError` on `ok: false` (D5) |
| C2 | `searchAll` | `ctgov.studies.searchAll(params, {maxPages, pageSize})`, an async iterator (shim and host side) | removed; `studies.searchAll` is a `TypeError`. Loop on `nextPageToken` with `pageToken` (`examples/paging-recipe.js`) |
| C3 | sandbox globals | whole Deno realm (208 names) / isolate with `__host_*` shims | language globals, `console` and `ctgov` only (list below) |
| C4 | `execute` limits | optional `timeoutMs` (15 s) / `memoryMb` (64) with the same limits enforced by hand in each runner | zod defaults, advertised as `default`: `timeoutMs` 15000 (100-60000), `memoryMb` 64 (16-256), code at most 256 KiB, result at most 256 KiB, logs 64 KiB / 1000 lines, SDK call arguments 64 KiB, 100 pending calls (see "Limits") |
| C5 | SDK errors | `CtGovError` with a `code` (`NOT_FOUND`, `TIMEOUT`, `UPSTREAM_HTTP_ERROR`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `POLICY_VIOLATION`, `VALIDATION_ERROR`), a `ZodError` whose message was the raw issue JSON | errors named for what happened, with `status`: `ValidationError` (short, bounded message naming the key), `NotFound`, `BadRequest`, `HttpError`, `RateLimited`, `UpstreamTimeout`, `UpstreamUnavailable`, `ResponseTooLarge`, `TypeError` (unknown method), `PolicyError` |
| C6 | HttpClient | retry 408/425/429/5xx up to `maxRetries` (4) with Retry-After and 250 ms * 2^n + jitter; stale-cache fallback; `cache: bypass/refresh`; audit trace; `headersProvider`, `acquireFn`, `rateLimiter` options | `retries` (3) for network errors and 5xx, backoff 250 ms * 2^n capped at 4 s without jitter; 408/425 not retried; a 429 pauses the shared gate for Retry-After and retries once (cooldowns over 30 s fail at once); no stale fallback, no bypass/refresh, no audit trace; adds an 8 MiB response cap with bounded gunzip (`accept-encoding: gzip`), a 32 MiB LRU byte cap, in-flight de-duplication, an absolute 20 s deadline (was 10 s), abort through every wait, a shared process-wide gate |
| C7 | nested-key hint | rendered `Replace { query, filter: { ... } }` (only the last key got `: { ... }`) | `Replace { query: { ... }, filter: { ... } }` |
| C8 | limits and quotas | per-subject per-minute `SubjectQuota` (60 `execute`, 600 upstream) and a 10 rps bucket | `ExecutionLimiter` (8 simultaneous, 2 per caller; anonymous callers per client address), a per-execute call budget (100), an hourly per-subject upstream quota (3000, authenticated HTTP only), and a process-wide gate (10 rps, `CTGOV_RATE_PER_SEC`; 8 in flight; at most 15 s queued) |
| C9 | `search_api`, `describe_schema` | `{query, snippet, hits: N}` / `{matches, total}` over `schema/openapi.pinned.json` and `schema/field-dictionary.json` | `{hits, note}` / `{found, entries \| message}` over `schema/ctgov.json` (`{provenance, endpoints[], fields[]}`), the contract shared with the other BLEN code-mode servers; `field-dictionary.json` and `src/sdk/generated.d.ts` are gone |
| C10 | public exports | `selectSandbox`, `BuildMcpServerOptions`, `SandboxMode`, `SandboxExecutor`, ... | see "Public exports" |
| C11 | MCPB bundle | vendored per-platform Deno, `--sandbox deno`, `CTGOV_DENO_ROOT` | no Deno: the stdio server uses the isolated-vm sandbox from the bundle's `node_modules` (`pnpm mcpb:validate` stages it and a run of the staged bundle executes code with no `deno` on `PATH`) |
| C12 | sandbox startup | resolved lazily on the first `execute` | resolved when the server starts (docs-only serving never resolves one) |
| C13 | build settings | `exactOptionalPropertyTypes: true` in `tsconfig.json` | `false`, as in the shared code (internal; no runtime effect) |

## Sandbox and SDK

**Runners.** `isolated-vm` 7 (in-process; stdio and `--insecure`) and Deno (a killable child process;
required for authenticated serving) share one contract: a dual-parse preflight that bans
`globalThis`, `Deno`, `fetch`, `constructor`, `__proto__` and the like and checks that the code cannot
close its wrapper, byte budgets enforced inside the sandbox and again on the host, a host-owned
deadline and abort, and a per-execution abort signal that reaches the upstream request. The Deno
supervisor is fixed (user code and binding names arrive by message), talks over token-prefixed
frames, runs the code in a module Worker with a global allowlist, starts with
`--disallow-code-generation-from-strings`, watches RSS, kills the process group and never shows
stderr to the caller. Authenticated serving never falls back to the in-process isolate. Code that
`isolated-vm` evaluates from strings stays inside its own isolate; Deno refuses it.

**No `searchAll`.** The sandbox surface is plain data RPC: every method is an entry in the frozen
methods table of `src/sdk/sources/ctgov.ts`, and dispatch resolves only those own data properties.
Page like this (every page is one call against the budget, so keep `pageSize` large and `fields` short):

```js
const ids = [];
let pageToken;
for (let page = 0; page < 10; page++) {
  const res = await ctgov.studies.search({ 'query.cond': 'melanoma', fields: ['NCTId'], pageSize: 500, ...(pageToken ? { pageToken } : {}) });
  ids.push(...res.studies.map(s => s.protocolSection.identificationModule.nctId));
  pageToken = res.nextPageToken;
  if (!pageToken) break;
}
return ids;
```

**Removed sandbox globals** (measured with `Object.getOwnPropertyNames(globalThis)` before and
after, on Deno 2.7.14 and 2.9.8). In the Deno runner (208 names before; 68 now, 69 on 2.9.8) the
web-platform and runtime globals are gone: `Deno`, `fetch`, `Request`, `Response`, `Headers`, `URL`,
`URLSearchParams`, `URLPattern`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `structuredClone`,
`setTimeout`, `setInterval`, `setImmediate` and their `clear*` forms, `performance`, `crypto`,
`AbortController`, `AbortSignal`, `Event`, `EventTarget`, `Blob`, `File`, `FormData`, the stream
classes, `BroadcastChannel`, `MessageChannel`, `Worker`, `WebSocket`, `WebAssembly`, `process`,
`Buffer`, `global`, `self`, `navigator`, `location`, `localStorage`, `caches` and the `GPU*` classes.
`queueMicrotask` stays: Deno 2.9's own message plumbing calls it on the worker global, and without it
a program with three or more SDK calls pending at once fails (`test/sandbox.spec.ts` pins this); it
only schedules a microtask in the sandbox's own realm. In the isolate the old shim globals
`__host_log` and `__host_rpc_sync` are gone; `WebAssembly` stays (it is the isolate's own), and the
frozen, non-enumerable `__ctgovInternal` bridge and a `global` alias of the isolate's own global are
added, as in the reference runner. The isolate never had the web-platform names, so programs that ran
in both runners are unaffected; the examples here used none of them (only `searchAll` needed an
iterator).

## Limits

| Limit | Default | Setting |
|---|---|---|
| `execute` timeout | 15 s (100 ms to 60 s) | `timeoutMs` per call (the old default and ceiling) |
| `execute` memory | 64 MB (16 to 256) | `memoryMb` per call. It is the V8 heap limit (`--max-old-space-size`). On Deno the process is also killed when resident memory grows by more than 2 × `memoryMb` + 96 MiB above its startup baseline (224 MiB at the default 64), so size a container for about 8 × that growth plus the Node server when 8 executions run at once (the worst case) |
| code, result | 256 KiB, 256 KiB | fixed; a result over it fails with `ResultTooLarge` (pass `fields`) |
| logs | 64 KiB and 1000 lines | fixed; later lines become `[logs truncated]` |
| pending SDK calls | 100 | fixed; equals the call budget so `Promise.all` over it works |
| upstream calls per `execute` | 100 | `CTGOV_MAX_CALLS_PER_EXECUTE` |
| simultaneous executions | 8 total, 2 per caller | `CTGOV_MAX_CONCURRENT_EXECUTIONS`, `CTGOV_MAX_EXECUTIONS_PER_SUBJECT`; a caller is the token's subject, the client address on `--insecure` (`CTGOV_CLIENT_IP_HEADER`), unlimited per caller on stdio; over a cap a call answers `Busy` instead of queueing |
| upstream rate | 10 requests/s, 8 in flight | `CTGOV_RATE_PER_SEC`; ClinicalTrials.gov publishes no limit, so this is an assumption kept from earlier releases |
| per-subject hourly upstream calls | 3000 | `CTGOV_SUBJECT_RATE_PER_HOUR`, authenticated HTTP only |
| upstream response | 8 MiB | fixed; `ResponseTooLarge` |

A request that is cancelled by the client, a server shutdown or the end of the execution aborts the
sandbox, any wait for the upstream gate, any retry sleep and the request itself.

## Corpus and reference

`schema/ctgov.json` replaces `schema/field-dictionary.json` and the OpenAPI-derived snippets:
`{provenance, endpoints[], fields[]}`, one endpoint per registered method (`test/sources.spec.ts`
checks the ids against the methods table and the paths against `schema/openapi.pinned.json`), each
with a runnable example (`test/corpus.spec.ts` parses it, runs the preflight and checks it calls only
registered methods). The 31 curated study fields became `ctgov.fields.<path>` entries, beside
`ctgov.syntax.*` notes on queries, Essie, geo, paging, fields, ids and errors. `docs/sdk-reference.md`
generates its method section from it (`node scripts/gen-sdk-reference.mjs`; a test fails when it is
stale). The weekly `schema-drift` workflow now reads the published OpenAPI document
(`/api/oas/v2`; the old `/api/v2/openapi.json` URL does not exist, so it could only fail), and also
checks that the corpus matches the methods table and every curated field still exists in
`/studies/metadata`. `examples/*.md` became runnable `examples/*.js` programs that `test/examples.spec.ts`
runs in both runners.
