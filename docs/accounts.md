# Account mode

`CTGOV_AUTH_PROVIDER=accounts` (with `--http`) enables Google sign-in through Better Auth, an OAuth
authorization server for MCP clients, and a small React portal (`/`, `/sign-in`, `/consent`,
`/account`, the policy pages). It is an option for a server you host yourself: anyone can read the
API documentation anonymously, and a signed-in person can run `execute` under fair-use limits.
**BLEN's hosted service does not use it.** That service runs `--http --public-docs`, which is
anonymous and docs-only: `/mcp`, a landing page, `/privacy-policy`, `/terms`, `/docs/` and `/health`,
with no sign-in, no `/account` and no `/mcp/account`.

ClinicalTrials.gov needs no API key, so account mode is **keyless**: there is no credentials
table, no key step in the connection flow, no encryption keyring and no `ENCRYPTION_*`
configuration. The database holds Better Auth's own tables (users, sessions, OAuth clients,
consents, hashed tokens) and the usage counters.

Account mode serves two MCP endpoints, because MCP clients only start OAuth when an endpoint
answers 401:

| URL | Sign-in | Tools | Origin rule |
| --- | --- | --- | --- |
| `/mcp` | none | `search_api`, `describe_schema` only (`execute` is not registered: a direct call is "Tool not found") | other sites' browsers are refused (403) unless listed in `CTGOV_ALLOWED_ORIGINS`; no `Origin` header (non-browser clients) passes |
| `/mcp/account` | Google, OAuth/PKCE, scope `ctgov:read` | all three | any Origin: hosted connectors (claude.ai, chatgpt.com) send their own, every request carries a bearer token (never a cookie), and the Host check blocks DNS rebinding |

`/mcp` ignores any bearer token and is limited per client IP (`CTGOV_IP_RPS`, `CTGOV_IP_BURST`;
in memory per replica). It never runs code and never calls ClinicalTrials.gov, so an anonymous
caller cannot spend the shared upstream budget.

An MCP client connects to `/mcp/account`, discovers the authorization server, registers with DCR
or CIMD, and uses authorization code + S256 PKCE with the scopes `ctgov:read offline_access`.
Redirect URIs must be HTTPS or loopback; a dynamic registration whose redirect URIs are all
loopback HTTP (desktop clients) is registered as `application_type: native` (RFC 8252). After
Google sign-in the user lands directly on the Authorize page (client, callback destination,
Allow/Cancel).

## Hosting modes exclude each other

`--public-docs` (anonymous, docs-only, no database; what BLEN hosts) and `--insecure` (local development) cannot
be combined with `CTGOV_AUTH_PROVIDER=accounts`: startup fails rather than serving without the
sign-in the configuration asked for. `accounts` also needs `--http`. The Docker image's default
command is `--http --public-docs`; run account mode by overriding it:

```bash
docker run --rm -p 8080:8080 --env-file account.env <image> --http
```

## Documentation site

When the image carries it (`docs-site/`, built from `site/` by `deploy/Dockerfile`), the server also
serves the documentation site at `/docs/`: in account mode and in `--public-docs` mode, behind the
same Host check, with its own content security policy (inline scripts only by hash), and before the
per-IP limiter. A local checkout without `cd site && pnpm build` and the image copy has no `/docs`.

## Health check

`GET /health` runs `SELECT 1` against the database: `200 {"status":"ok","protocol":"2026-07-28","sandbox":"deno"}`
(the sandbox kind, `none` if Deno is missing), or `503 {"status":"unavailable"}` when the database
does not answer. The base transport's `/health` (`--public-docs`, `--insecure`, OIDC) answers
`{status, version, protocol}` instead. Account mode ignores `CTGOV_AUTH_SCOPES` (its scope is fixed
at `ctgov:read`) and `CTGOV_ALLOWED_HOSTS` (it trusts `CTGOV_PUBLIC_ORIGIN` only).

## Portal API

State-changing requests must be same-origin JSON from a verified session; no request names an
owner, and no route accepts a credential.

| Request | Body | Effect |
| --- | --- | --- |
| `GET /api/portal/config` | none | `{ google, email, mcpUrl, publicMcpUrl }` |
| `GET /api/portal/account` | none | `{ email, mcpUrl }` |
| `GET/POST /api/portal/consent` | `{ oauth_query, accept }` | The Authorize step; GET describes the client and destination |

Better Auth's other routes are closed: email/password is disabled and `/link-social`,
`/update-user` and `/change-email` are in `disabledPaths` (a test pins them to 404). Better Auth
errors redirect to the portal's `/error` page.

## Configuration

Use a **dedicated** PostgreSQL database. Set in the deployment secret manager:

- `CTGOV_AUTH_PROVIDER=accounts`
- `CTGOV_PUBLIC_ORIGIN=https://your-host.example.com` (the origin clients use)
- `DATABASE_URL`
- `BETTER_AUTH_SECRET`: a random secret of at least 32 characters
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

Configure the Google OAuth web application's redirect URI as
`https://<your-origin>/api/auth/callback/google`.

Start with `pnpm build && pnpm start --http`. The build compiles the portal to `dist/web`
(`pnpm dev:web` rebuilds it while editing). Account mode runs user code **only in the Deno
sandbox** (a separate permissionless process per execution), so Deno must be installed (the
Docker image includes it); `--sandbox isolate` is refused. Migrations run before traffic is
served, under a PostgreSQL advisory lock. HTTP loopback origins are accepted only with
`NODE_ENV=development` or `test`; production requires HTTPS and checks Host against the public
origin, and assumes one trusted proxy hop, as on Railway.

## Isolation and persistence

- Ownership comes only from the verified browser session or OAuth token's user.
- OAuth access and refresh tokens are stored hashed; Google tokens and confidential client
  secrets are encrypted with a key derived from `BETTER_AUTH_SECRET`. Bearer access requires the
  right resource, the `ctgov:read` scope, a current verified user and an enabled client.
- Every `/mcp/account` request rechecks the opaque token in PostgreSQL, so revocation takes
  effect immediately. Access tokens last 15 minutes; refresh tokens 30 days.
- Token requests are serialized per user with a PostgreSQL advisory lock.

## Limits

Quotas stay on in account mode:

- **Per account, per hour:** `CTGOV_SUBJECT_RATE_PER_HOUR` (default 3000) upstream calls,
  counted in PostgreSQL (`request_limits`, fixed window from the first call) so it holds across
  replicas and restarts. It is charged before the response cache, as in the in-memory mode. If the
  database cannot answer, the call is refused (`QuotaUnavailable`), never let through unmetered.
- **Per account, per day:** `CTGOV_SUBJECT_DAILY_QUOTA` (default 10000) MCP requests per UTC day.
- **Simultaneous executions:** `CTGOV_MAX_CONCURRENT_EXECUTIONS` (8) per process and
  `CTGOV_MAX_EXECUTIONS_PER_SUBJECT` (2) per account; over a cap a call answers `Busy`.
- **Per execute:** `CTGOV_MAX_CALLS_PER_EXECUTE` (100) upstream calls.
- **Shared upstream gate:** `CTGOV_RATE_PER_SEC` (10) and 8 requests in flight, process-wide:
  ClinicalTrials.gov publishes no limit, and every caller's requests leave from this server.
- Fixed: 600 requests/min per IP for browser traffic, 6000/min per IP and 600/min per user on
  `/mcp/account`; failed token checks are limited to 2/s per IP (bursts of 120) before they
  reach the database; only a token proven invalid spends that budget (valid tokens, database
  errors and other limits do not), and at most 256 checks per IP run at once. Behind a proxy
  set `CTGOV_CLIENT_IP_HEADER` (Railway: `x-real-ip`). Per-IP limits count an IPv6 address by
  its /64 and an IPv4-mapped address as its IPv4 client.
- `/oauth2/token` and `/oauth2/revoke` are limited per IP in memory (20 a second, bursts of
  600) before any lookup. They then serialize per user with a transaction-scoped PostgreSQL
  advisory lock (a code exchange per code; the lock follows the operation Better Auth will run:
  form-encoded bodies only, revoke on `token`, refresh on `refresh_token`, code exchange on
  `code`; a repeated deciding field is refused with 400; a request with nothing to lock takes
  none). These requests use their own pool of `CTGOV_AUTH_LOCK_POOL_SIZE` connections per replica
  (default 10, 2 to 200), in addition to the main pool of 10, so budget
  `replicas x (10 + CTGOV_AUTH_LOCK_POOL_SIZE)` against PostgreSQL's `max_connections`. A waiting
  request holds one in an open transaction (`idle in transaction`, with a 10 second
  `lock_timeout`), so do not set a shorter `idle_in_transaction_session_timeout` on the role
  than that plus the slowest token response. A request that cannot get a connection within 10
  seconds, or the lock within a further 10, is answered with 503 and `Retry-After`, and the client retries.
- MCP request bodies are capped at 1 MiB. Cookies are HttpOnly and SameSite, Secure in
  production; responses are non-cacheable.

## Verification

`pnpm typecheck`, `pnpm lint`, `pnpm build` and `pnpm test` cover the transports and sandbox.
`test/accounts.spec.ts` needs Deno on PATH and `TEST_DATABASE_URL` pointing to a disposable
PostgreSQL database (each run creates and drops its own schema; with `CTGOV_REQUIRE_RUNNERS=1` a
missing database fails the run instead of skipping):

```bash
docker run -d --rm --name ctgov-pg -e POSTGRES_PASSWORD=ctgov-ci \
  -e POSTGRES_DB=ctgov_test -p 127.0.0.1:55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:ctgov-ci@127.0.0.1:55432/ctgov_test pnpm test test/accounts.spec.ts
```

`pnpm test:web` runs the browser tests (see [accessibility.md](accessibility.md)); its journey
test signs in, connects a client, consents and runs `execute` through Deno. Google identity is
seeded by Better Auth's test helper and ClinicalTrials.gov is mocked, so the tests do **not**
establish live Google sign-in or hosted-client interoperability: verify those in the deployed
environment before enabling account mode.
