# ClinicalTrials.gov MCP

[![CI](https://github.com/blencorp/clinicaltrials-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/blencorp/clinicaltrials-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@blen/clinicaltrial-mcp-server.svg)](https://www.npmjs.com/package/@blen/clinicaltrial-mcp-server)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-24%20%7C%2026-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-7c3aed.svg)](https://modelcontextprotocol.io/specification/2026-07-28)

**Ask your AI assistant real questions about registered clinical studies, and get answers grounded in the official ClinicalTrials.gov API.**

**Documentation:** [clinicaltrials.mcp.blencorp.com/docs](https://clinicaltrials.mcp.blencorp.com/docs/) has connect buttons for Claude Desktop, Cursor and VS Code, recipes, and the SDK reference.

<video src="assets/launch.mp4" controls width="600"></video>

This is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects any MCP client (Claude Desktop and others) to the [ClinicalTrials.gov API v2](https://clinicaltrials.gov/data-api/api), the U.S. National Library of Medicine's registry of clinical studies: conditions, interventions, sponsors, phases, status, eligibility criteria, locations and contacts, outcomes and posted results.

Instead of bolting on dozens of rigid, narrow tools, it hands the model a small, well-documented SDK and lets it write the exact query it needs in JavaScript, then runs that code in a locked-down sandbox. This is the **code-mode** pattern ([Cloudflare's write-up](https://blog.cloudflare.com/code-mode/)), and it makes a wide API usable without overwhelming the model with tool definitions.

> **Disclaimer.** This software is for informational and educational purposes only. It is not medical advice, diagnosis or treatment, and it does not tell anyone whether they are eligible for a study or should join one: talk to a qualified clinician about your own care. Study records are registered by their sponsors and published by ClinicalTrials.gov; this project passes them through and does not verify them. It is an independent open-source project, not affiliated with or endorsed by the U.S. National Library of Medicine, the NIH or any government agency. BLEN and the authors assume no responsibility for errors, omissions or outcomes from its use.

## API keys

**No key needed.** ClinicalTrials.gov's API is public: the server sends none, stores none, and asks for none, on your computer or on the hosted service. The only thing that needs an account is the BLEN-hosted `execute` tool, which asks you to sign in with Google (see [Personal accounts](#personal-accounts-hosted-mode)); running the server yourself needs nothing.

## Quickstart (Claude Desktop)

**Claude Desktop extension.** Download `clinicaltrials-mcp-server.mcpb` from the [latest release](https://github.com/blencorp/clinicaltrials-mcp-server/releases/latest) and open it. There is nothing to fill in.

**Or with `npx`.** Add the server to your Claude Desktop config (**Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "clinicaltrials": {
      "command": "npx",
      "args": ["-y", "@blen/clinicaltrial-mcp-server"]
    }
  }
}
```

Restart Claude Desktop, then ask in plain language:

> *"Which Phase 3 trials for melanoma are recruiting in Boston, and who sponsors them?"*
> *"How many studies on type 2 diabetes registered each year since 2015?"*
> *"Summarize the eligibility criteria of NCT04280705 as inclusion and exclusion bullets."*

Requires **Node.js 24 or 26** (LTS). `npx` downloads and runs the server on demand. If `execute` reports `SandboxUnavailable`, see [Sandbox runtimes](#sandbox-runtimes). To build the extension yourself: `pnpm build && pnpm mcpb:prepare && pnpm mcpb:pack`.

You can also connect to the hosted server, `https://clinicaltrials.mcp.blencorp.com/mcp`, which offers the documentation tools anonymously (see [Personal accounts](#personal-accounts-hosted-mode)).

## See it in action

> *"Which sponsors run the most recruiting Phase 3 cancer trials with 200 or more sites?"*

The model finds the right calls with `search_api` and runs them in the sandbox:

```js
const sponsors = new Map();
let pageToken;
for (let page = 0; page < 25; page++) {
  const res = await ctgov.studies.search({
    'query.cond': 'cancer',
    'filter.overallStatus': ['RECRUITING'],
    'filter.advanced': 'AREA[Phase]PHASE3',
    fields: ['NCTId', 'BriefTitle', 'LeadSponsorName', 'LocationFacility'],
    pageSize: 200,
    ...(pageToken ? { pageToken } : {}),
  });
  for (const s of res.studies) {
    const sites = (s.protocolSection?.contactsLocationsModule?.locations ?? []).length;
    if (sites < 200) continue;
    const name = s.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name ?? 'unknown';
    sponsors.set(name, (sponsors.get(name) ?? 0) + 1);
  }
  pageToken = res.nextPageToken;
  if (!pageToken) break;
}
return [...sponsors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
```

...then answers in plain English, citing the studies it found. More programs are in [`examples/`](./examples/).

## What's covered

| Need | Call |
|---|---|
| Find studies by condition, intervention, sponsor, location, title, outcome, status, phase, dates, distance | `ctgov.studies.search` (flat keys such as `query.cond`, `filter.overallStatus`, `filter.geo`, `filter.advanced`) |
| One study's record, optionally only some fields | `ctgov.studies.get` |
| What the study fields are called and mean | `ctgov.studies.metadata`, and `ctgov.fields.*` in `describe_schema` |
| Which search areas exist, and the allowed enumeration values | `ctgov.studies.searchAreas`, `ctgov.studies.enums` |
| Registry-wide counts and distributions of a field | `ctgov.stats.size`, `ctgov.stats.fieldValues`, `ctgov.stats.fieldSizes` |
| The API's data version | `ctgov.version` |

Full surface: [`docs/sdk-reference.md`](./docs/sdk-reference.md). It is read-only: the server never changes anything at ClinicalTrials.gov. Bulk download of the whole registry is not exposed.

## How it works

Three tools, in the order the model uses them:

| Tool | What it does |
|---|---|
| `search_api(query, k?)` | BM25 over the SDK method docs and the study-field dictionary. Returns `{hits, note}`: entries with signatures and ready-to-run JavaScript. `k` defaults to 10 (at most 50). |
| `describe_schema({ path? \| prefix? })` | Looks up an exact entry (`ctgov.studies.search`) or lists a namespace (`ctgov.fields.protocolSection.`). Exactly one of the two. |
| `execute({ code, timeoutMs?, memoryMb? })` | Runs JavaScript (no type annotations; top-level `await`/`return` allowed) in the sandbox with `ctgov` as a global. `timeoutMs` defaults to 15 s (100 ms to 60 s), `memoryMb` to 64 (16 to 256). |

All three are annotated read-only and non-destructive (`execute` is also `openWorldHint: true`) and publish an `outputSchema`. Results come back as compact JSON text plus the same object as `structuredContent`. A failed execution (thrown error, timeout, limit) is returned with `isError: true` and the full envelope, `{ ok: false, error: { name, message, status? }, logs, durationMs }`, so the model sees what went wrong. There is no `searchAll` helper: page by looping on `nextPageToken` with `pageToken`, as in the example above (every page is one call).

```text
MCP client → execute(code) → sandbox → ctgov.* RPC bridge → host HttpClient (gate, cache, retry) → clinicaltrials.gov/api/v2
```

Architecture: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) · Paste-ready examples: [`examples/`](./examples/).

### ClinicalTrials.gov limits, and how the server respects them

ClinicalTrials.gov publishes no rate limit, so the server keeps its own conservative one:

- every request, from every caller, leaves through one process-wide gate: at most 10 requests per second (`CTGOV_RATE_PER_SEC`) and 8 in flight, with a wait of at most 15 s (`Promise.all` in sandbox code is safe but not faster);
- on a `429` the gate pauses for the `Retry-After` and the call is retried once (a pause over 30 s fails at once with `RateLimited`); network errors and `5xx` retry up to three times with backoff;
- one `execute()` may make at most 100 SDK calls (`CTGOV_MAX_CALLS_PER_EXECUTE`, `CallBudgetExceeded`), and an authenticated subject at most 3000 per hour (`CTGOV_SUBJECT_RATE_PER_HOUR`). Both count every SDK call a program makes, including ones answered from the cache;
- responses are cached for 5 minutes in memory, so repeated questions do not reach ClinicalTrials.gov again (they still count toward the two budgets above);
- upstream bodies over 8 MiB fail with `ResponseTooLarge`, and a result over 256 KiB returned from `execute` with `ResultTooLarge`. **Always pass `fields`**: a full study record can be hundreds of KiB.

## Personal accounts (hosted mode)

`CTGOV_AUTH_PROVIDER=accounts` adds Google sign-in, an `/account` page, and OAuth/PKCE connections at `/mcp/account`. It is **keyless**: there is no key to save, so signing in is only how the server tells callers apart for fair-use limits (per-account hourly and daily quotas, and simultaneous executions). The anonymous `/mcp` endpoint offers only the documentation tools (`search_api`, `describe_schema`) and never calls ClinicalTrials.gov; `execute` requires signing in and runs only in the Deno sandbox. Account mode needs PostgreSQL and must be started with `--http` (the Docker image's default command is `--http --public-docs`, so override it); it cannot be combined with `--public-docs` or `--insecure`. See [docs/accounts.md](docs/accounts.md).

## Sandbox runtimes

`execute` needs a sandbox runner:

1. **`isolated-vm`**: a fresh V8 isolate per execution, with a heap cap and a host-enforced deadline. `isolated-vm` 7 ships prebuilt binaries for Node 24 and 26 on macOS arm64, Linux x64/arm64 (glibc and musl) and Windows x64, so no compiler is needed. Preferred for single-user use (stdio, `--insecure` local HTTP).
2. **Deno**: user code runs in a separate `deno` process with no permissions (no network, files, env or subprocesses), inside a Worker stripped of `Deno`, `fetch` and messaging globals; the server owns the deadline and kills the process group. Install [Deno](https://docs.deno.com/runtime/getting_started/installation/) and it is used when `isolated-vm` is unavailable, or always with `--sandbox deno` (`CTGOV_SANDBOX=deno`).
3. **Authenticated HTTP serving** (OIDC or accounts) runs user code **only** in the Deno runner, a separate, killable process per execution. `--sandbox isolate` is refused there, and without Deno, `execute` reports `SandboxUnavailable` instead of falling back to in-process execution. The anonymous `--public-docs` mode needs no sandbox at all.
4. If no runner is available, `search_api` and `describe_schema` still work; `execute` returns `SandboxUnavailable` with instructions.

Every execution is bounded: code 256 KiB, returned value 256 KiB (`ResultTooLarge`), logs 64 KiB / 1,000 lines, SDK-call arguments 64 KiB, 100 pending calls. `memoryMb` is the V8 heap limit; on Deno the process is also killed when its resident memory grows by more than 2 × `memoryMb` + 96 MiB above its startup baseline (224 MiB at the default 64), so size a container for about 8 × that growth plus the Node server when 8 executions run at once. At most 8 executions run at once per server and 2 per authenticated subject (`CTGOV_MAX_CONCURRENT_EXECUTIONS`, `CTGOV_MAX_EXECUTIONS_PER_SUBJECT`); a client that cancels or disconnects stops its execution and any upstream calls in flight.

## Self-hosting (remote HTTP)

```bash
# Local, single user, no auth (binds 127.0.0.1 unless HOST/--host says otherwise):
npx @blen/clinicaltrial-mcp-server --http --insecure --port 8080

# Anonymous, docs-only (search_api + describe_schema, no execute, no sandbox, no database):
CTGOV_PUBLIC_ORIGIN=https://your-host.example.com \
  npx @blen/clinicaltrial-mcp-server --http --public-docs

# Your own server, authenticated via an OIDC issuer.
# Issuer, audience and an https JWKS URL are all required; Deno must be installed.
CTGOV_AUTH_PROVIDER=clerk \
CTGOV_AUTH_ISSUER=https://<tenant>.clerk.accounts.dev \
CTGOV_AUTH_AUDIENCE=https://your-host.example.com/mcp \
CTGOV_AUTH_JWKS_URL=https://<tenant>.clerk.accounts.dev/.well-known/jwks.json \
CTGOV_PUBLIC_ORIGIN=https://your-host.example.com \
  npx @blen/clinicaltrial-mcp-server --http
```

Then point any MCP client at it:

```json
{ "mcpServers": { "clinicaltrials": { "type": "http", "url": "https://your-host.example.com/mcp" } } }
```

The HTTP transport implements the stateless MCP `2026-07-28` Streamable HTTP profile (no `initialize` handshake and no `Mcp-Session-Id`) with a stateless legacy fallback for pre-2026 clients. It fails closed:

- `--http` without `--insecure` or `--public-docs` refuses to start unless real authentication is configured (an OIDC provider, or `accounts`). OIDC tokens must carry the configured issuer and audience, an expiry and a subject, use an asymmetric algorithm, and hold every scope in `CTGOV_AUTH_SCOPES` (default `ctgov:read`; otherwise `403 insufficient_scope`).
- **Hosting modes exclude each other.** `--public-docs` or `--insecure` together with any configured auth provider (including `accounts`) is a startup error, as is `--public-docs` together with `--insecure`, and `accounts` without `--http`.
- Listening on anything but loopback requires `CTGOV_PUBLIC_ORIGIN` or `CTGOV_ALLOWED_HOSTS` (with authentication, `CTGOV_PUBLIC_ORIGIN` specifically, because OAuth metadata must name the URL clients connect to; `GET /health` is exempt from the Host check): every request's `Host` must match the configured names (DNS-rebinding protection); the trusted origin is never taken from the request. On the anonymous endpoint, browser `Origin`s other than the server's own, loopback, or `CTGOV_ALLOWED_ORIGINS` get `403`; bearer-authenticated endpoints accept any Origin.
- Request bodies are capped at 1 MiB, and tool arguments at a fixed number of elements.

It also serves OAuth 2.0 Protected Resource Metadata (RFC 9728) and per-IP rate limiting. `GET /health` answers `{status, version, protocol}`; point platform health checks there.

**Docker and Railway.** The [`Dockerfile`](./deploy/Dockerfile) runs on Node 26 (LTS) with Deno and the documentation site included. Its default command is `--http --public-docs` (the hosted anonymous docs-only service, which is what Railway runs; its settings are declared in [`.railway/railway.ts`](./.railway/railway.ts), the only Railway config file): set `CTGOV_PUBLIC_ORIGIN` (the image binds `0.0.0.0`), `CTGOV_CLIENT_IP_HEADER=x-real-ip` on Railway, and the health check path to `/health`. To offer `execute`, override the command with `--http` and configure an OIDC provider or account mode, as above. The gate, caches and per-IP limiter are in memory, so run **one replica** (and avoid deploys where an old and a new instance serve at the same time), or the process-wide upstream rate is no longer shared.

### Configuration

Every environment variable the server reads (`src/bin.ts`, plus the log level) and its default. There is no dotenv: [`.env.example`](./.env.example) is documentation only.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | HTTP listen port (`--port` overrides). |
| `HOST` | `0.0.0.0` | HTTP bind address (`--host` overrides). `--insecure` ignores it and binds `127.0.0.1`. |
| `CTGOV_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. Logs go to stderr. |
| `CTGOV_SANDBOX` | `auto` | `auto` / `isolate` / `deno` (same as `--sandbox`). |
| `CTGOV_BASE_URL` | `https://clinicaltrials.gov/api/v2` | Upstream base URL (tests, mirrors). |
| `CTGOV_RATE_PER_SEC` | `10` | Upstream requests per second, process-wide (8 in flight). |
| `CTGOV_MAX_CONCURRENT_EXECUTIONS` / `CTGOV_MAX_EXECUTIONS_PER_SUBJECT` | `8` / `2` | Simultaneous executions per server / per caller (`Busy` beyond). |
| `CTGOV_MAX_CALLS_PER_EXECUTE` | `100` | Upstream calls per `execute()` (`CallBudgetExceeded`). |
| `CTGOV_SUBJECT_RATE_PER_HOUR` | `3000` | Upstream calls per authenticated subject per hour (HTTP only). |
| `CTGOV_AUTH_PROVIDER` | `none` | `none` (only with `--insecure`, `--public-docs` or stdio) / `generic-oidc` / `clerk` / `workos` / `auth0` / `accounts`. Unknown values stop startup. |
| `CTGOV_AUTH_ISSUER` / `CTGOV_AUTH_AUDIENCE` / `CTGOV_AUTH_JWKS_URL` | none | Required for OIDC providers (JWKS over https; http only on loopback). The audience is normally `https://<host>/mcp`. |
| `CTGOV_AUTH_SCOPES` | `ctgov:read` | Comma-separated scopes every token must carry; advertised in resource metadata. |
| `CTGOV_PUBLIC_ORIGIN` | none | Public origin clients reach (OAuth metadata, trusted Host). Required for authenticated or account HTTP beyond loopback; otherwise `CTGOV_ALLOWED_HOSTS` can replace it. |
| `CTGOV_ALLOWED_HOSTS` | none | Extra accepted `Host` values (comma-separated). |
| `CTGOV_ALLOWED_ORIGINS` | none | Extra browser origins accepted on the anonymous `/mcp`. |
| `CTGOV_IP_RPS` / `CTGOV_IP_BURST` | `5` / `20` | Per-IP token bucket on the HTTP transport. |
| `CTGOV_CLIENT_IP_HEADER` | unset | Header your proxy overwrites with the client address (Railway: `x-real-ip`; an AWS ALB: `x-forwarded-for`, rightmost entry). Unset keys the limiter on the TCP peer. |
| `DATABASE_URL` | none | Account mode: a dedicated PostgreSQL database. |
| `BETTER_AUTH_SECRET` | none | Account mode: a random secret of at least 32 characters. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | none | Account mode: Google OAuth web application (redirect URI `https://<origin>/api/auth/callback/google`). |
| `CTGOV_AUTH_LOCK_POOL_SIZE` | `10` | Account mode: connections (2 to 200) reserved per replica for OAuth token locks, in addition to the main pool; see [docs/accounts.md](docs/accounts.md). |
| `CTGOV_SUBJECT_DAILY_QUOTA` | `10000` | Account mode: MCP requests per account per UTC day. |
| `NODE_ENV` | production behaviour | Account mode: `development` or `test` allows an HTTP loopback `CTGOV_PUBLIC_ORIGIN`; anything else requires HTTPS. |

CLI options: `--stdio` (default), `--http`, `--port`, `--host`, `--sandbox auto|isolate|deno`, `--public-docs`, `--insecure`, `--help`, `--version`. An unknown option or `--sandbox` value stops startup.

## Security

User code is sandboxed by design: no network, filesystem, env, or subprocess access, an `acorn` AST preflight, a host-enforced wall-clock deadline, byte budgets, and a V8 heap cap. The server holds no upstream credential at all (the API is public), and the secrets it does hold in account mode never enter the sandbox. The threat model is in [`SECURITY.md`](./SECURITY.md). Found a sandbox escape or auth bypass? Please open a [private Security Advisory](https://github.com/blencorp/clinicaltrials-mcp-server/security/advisories/new) rather than a public issue.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev setup and ground rules, and please open an issue before anything non-trivial. For questions and help, see [`SUPPORT.md`](./SUPPORT.md). By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). Upgrading from the `0.1.0-alpha.0` development line: [`docs/migration-0.1.md`](./docs/migration-0.1.md).

## License

[Apache-2.0](./LICENSE) © 2026 BLEN, Inc. See also [`NOTICE`](./NOTICE).

## Hosted service policies

The BLEN-hosted connector's [Privacy Policy](./legal/privacy-policy.md) and
[Terms of Service](./legal/terms.md) describe data handling and conditions of
use; [`legal/support.md`](./legal/support.md) lists response targets, and
[`legal/submission-packet.md`](./legal/submission-packet.md) holds the Claude
connector directory submission. The software remains licensed under Apache-2.0;
self-hosted operators are responsible for their own policies.

## Acknowledgements

- The U.S. National Library of Medicine for publishing the ClinicalTrials.gov API and its OpenAPI specification, and the sponsors and investigators who register their studies.
- The [Model Context Protocol](https://modelcontextprotocol.io) team for the spec and TypeScript SDK.
- Cloudflare for describing the [code-mode](https://blog.cloudflare.com/code-mode/) pattern.

## For teams

Want an MCP server for your team's or agency's data, or help running this one? [Talk to BLEN](https://www.blencorp.com/mcp).

---

Built with ❤️ by [BLEN](https://www.blencorp.com).
