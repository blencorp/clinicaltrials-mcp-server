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
- `BETTER_AUTH_SECRET`: a random secret of at least 32 characters, the same on every replica. It also keys the access-token MAC and encrypts confidential-client secrets, so changing it forces every connection and confidential client to re-authorize (see [secret rotation](#secret-rotation))
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
- Access tokens carry an issuer MAC, so `/mcp/account` refuses made-up ones without database work
  (see [bearer token admission](#bearer-token-admission)).
- Token requests are serialized per user with a PostgreSQL advisory lock.

## Bearer token admission

Hosted connectors share a few egress IPs, so one client sending bad bearer tokens must not lock
valid users out of an address. Access tokens issued by this server's own OAuth provider have the
authenticated format `at1.<kid>.<issued-at>.<24 random bytes>.<MAC>`: the MAC is an HMAC-SHA256
keyed from `BETTER_AUTH_SECRET` (HKDF with the info string `clinicaltrials-access-token-mac/<kid>`,
separate per key ID) over the rest of the token. `/mcp/account` admits a token in this order:

1. A value with the `at1.` prefix and a wrong shape, unknown key ID or bad MAC is `401` with no
   database work, no failure budget and no in-flight slot. Parsing is strict and the MAC is
   compared in constant time.
2. A MAC-valid token older than `issued-at + 15 minutes + 60 s` is `401` with no database work. The
   60 s is clock skew for this cheap bound only; the database expiry stays authoritative and never
   gains the skew.
3. A digest whose completed database check was rejected (revoked, no row, wrong resource, disabled
   client, unverified user) is remembered for at most 60 s, a fixed time that hits never extend, and
   never beyond the admission bound of step 2. The cache holds 10,000 digests, never holds database
   errors or limit responses, and is per replica.
4. A digest whose own database check recently succeeded carries a "recently validated" marker, set
   or renewed by each such success (expiry 60 s from then), with the same cap at the admission bound
   and the same 10,000-entry bound. It is a routing hint, not an authorization result: every request
   still runs its own database check, and a rejection deletes the marker.
5. Per digest and replica, one check runs at a time for an unknown digest and at most 16 for a
   marked one, and only running checks take shared in-flight slots (step 6). Further requests for
   the digest queue FIFO, holding no slot: up to 256 per digest and 4,096 overall, then `429` with
   `Retry-After` (a known cap: a cold replica serving more than 257 simultaneous first-use calls
   with one token refuses the excess). When a check finishes, its permit passes directly to the
   oldest queued request, each running its own fresh check. If the digest was rejected, or its
   admission bound passes, every queued request is answered `401` at once; if it succeeded, they
   proceed 16 at a time. A later rejection never renews an existing negative entry's expiry.
6. A running check takes an in-flight slot (256 per IP bucket) and the `mcp-ip:` flood guard
   (6,000 a minute), and every admitted request still does the full database check. The failed-token
   budget is neither consulted nor charged.

So one rejected digest that was never validated costs one lookup per replica while its entry is
kept (a restart or eviction costs one more). A token validated and then revoked holds at most 16
slots until its first rejection is recorded, and none after. Residual: N distinct
validated-then-revoked tokens can hold up to 16 x N slots, bounded by the in-flight cap and the
flood guard, and they need N real tokens. Revocation is never delayed (only rejections are cached),
while a re-enabled client is accepted again within 60 s. The per-IP in-flight cap and the flood
guard remain shared by everyone on an address: they are sized for connector traffic, and reaching
them takes sustained load of real tokens, but they are a capacity limit, not something this removes.
Queued requests wait without a shared slot but are not cancelled when their client disconnects; the
queues are bounded and drain as checks finish.

### Bearer types

Only the opaque tokens above go through these checks. Everything else is unchanged:

- `/mcp/account` accepts only tokens its own Better Auth provider issued (`at1.` tokens, and
  legacy-shaped ones during release 1). A JWT from an external provider is not accepted there; it is
  treated as a legacy-shaped value and refused after a database miss.
- The anonymous `/mcp` in account mode reads no token: any `Authorization` header is ignored.
- Outside account mode, the HTTP transport (`--http`, `CTGOV_AUTH_PROVIDER` of `generic-oidc`,
  `clerk`, `workos` or `auth0`) verifies every bearer as a JWT against the issuer's JWKS, and
  `none` (with `--insecure` or `--public-docs`) and stdio take no bearer. None of these use the
  `at1.` format, the admission caches or the legacy budget.

### Rollout: two releases, no timers

- **Release 1 (dual-accept).** Issues `at1` tokens and accepts both shapes. Legacy-shaped tokens
  (no `at1.` prefix, issued before this change) use the old failed-token budget (2 credits a
  second after a burst as large as the legacy in-flight cap, 256 per IP bucket), a separate
  in-flight cap and the `mcp-ip-legacy:` flood key (6,000 a minute). A credit is reserved before
  the lookup and refunded unless the token is proven invalid, so concurrent requests cannot share
  one credit while valid legacy users keep their concurrency. A legacy junk flood cannot consume
  `at1` capacity; during release 1 one IP can reach up to twice the previous database concurrency
  (256 on each path). Rolling back to the previous version is safe: it validates by database digest
  only, and `at1` tokens are opaque strings to it. Record the time the deploy finished, with no
  rollback, on every replica.
- **Release 2 (legacy removed).** Rejects legacy-shaped tokens at the first check. It may ship only
  after release 1 has been fully deployed, with no rollback, for at least `accessTokenExpiresIn +
  skew` (15 minutes + 60 s), the longest a legacy token issued by the last old instance can still be
  valid. Legacy removal is a code change, so restarts never reopen it and every replica runs one
  rule. Rolling back release 2 to release 1 is safe. Refresh tokens are unaffected by either
  release.
- **Changing `accessTokenExpiresIn`.** The admission bound uses the maximum lifetime of any token
  that may still be valid: when raising or lowering it, keep the larger value in the bound until
  tokens issued under the old setting have expired.

Deploy prerequisite: all replicas must share `BETTER_AUTH_SECRET` (they already must), because the
MAC key derives from it; a replica with a different secret refuses other replicas' tokens.

### Secret rotation

Rotating `BETTER_AUTH_SECRET` is breaking, as it was before access-token MACs: confidential
clients' secrets are stored encrypted with it (`storeClientSecret: 'encrypted'`), so their refresh
fails with `invalid_client` until they re-register or re-authorize, and every outstanding access
token stops verifying and is refused. Plan a re-authorization of confidential clients and of all
connections. A supported key-ring rotation (old and new secrets side by side, key-ID overlap for
the MAC, client-secret re-encryption) is not implemented.

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
  `/mcp/account` (the `mcp-ip:` flood guard); at most 256 token checks per IP run at once. Tokens
  in the `at1.` format have no failure budget (see [bearer token admission](#bearer-token-admission));
  legacy-shaped tokens (release 1 only) are limited to 2/s per IP after a burst of 256, in their own
  budget, in-flight cap and flood key. Behind a proxy set `CTGOV_CLIENT_IP_HEADER` (Railway:
  `x-real-ip`). Per-IP limits count an IPv6 address by its /64 and an IPv4-mapped address as its
  IPv4 client.
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
