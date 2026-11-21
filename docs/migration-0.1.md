# Migrating to 0.1.0

0.1.0 moves the server to MCP SDK v2 (protocol revision 2026-07-28, with the 2025 `initialize`
era still answered), makes HTTP serving stateless and fail closed, and returns structured tool
results. The three tools and the `ctgov.*` SDK surface are unchanged. Nothing was published
before 0.1.0, so these are the changes from the `0.1.0-alpha.0` development line.

Sections marked **(package C)** are placeholders: the sandbox and SDK registry change in a later
step and that step fills them in.

## Do I need to do anything?

| You are... | Impact |
|---|---|
| A **stdio** user (Claude Desktop, `npx`) | Use Node 24 or 26. A failed `execute` now carries `isError: true`. Nothing else. |
| An **MCP client** | Read "Client-visible changes": unknown tools are JSON-RPC errors, results carry `structuredContent`, arguments are schema-validated. |
| A **server operator** (`--http`) | Read "Operator changes": startup now refuses incomplete configuration, sessions and the embedded authorization server are gone, and `CTGOV_PUBLIC_ORIGIN` is required beyond loopback. |
| A **library importer** (`@blen/clinicaltrial-mcp-server`) | See "Public exports". |

## Client-visible changes

1. **A failed `execute` is a tool error.** `ok: false` (a throw, timeout, limit or policy
   violation) now sets `isError: true`. The text block and `structuredContent` still hold the
   full envelope. This holds the current envelope shape; **(package C)** changes the envelope.
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
6. **`search_api` returns one JSON block** `{query, snippet, hits}` where `hits` is the match
   count. The snippet is byte-identical to the old first text block; the old second block
   `{"hits": N}` is gone.
7. **Tool listing**: every tool has a `title` and an `outputSchema`; the server sends workflow
   `instructions`, `listChanged` is advertised as true by the SDK, and list results carry
   `ttlMs` / `cacheScope` cache hints (modern era).
8. **Request bodies over 1 MiB** are refused with `413`.
9. **Validation error shapes** inside the sandbox come from Zod 4: `invalid_enum_value` is now
   `invalid_value`, and string-format issues carry `origin`/`format`/`pattern`.
10. **execute envelope** and **searchAll**: **(package C)**.

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
   Clerk/OIDC application and `CTGOV_AUTH_SCOPES`. `deploy/aws` defaults follow.
6. **Hosting-mode precedence.** `--public-docs` or `--insecure` together with any configured
   `CTGOV_AUTH_PROVIDER` is a startup error (they used to ignore the provider silently).
   `--public-docs` and `--insecure` remain mutually exclusive. Docs-only startup stays
   sandbox-free and database-free.
7. **Host validation is always on.** Trusted hosts are `CTGOV_PUBLIC_ORIGIN`, `CTGOV_ALLOWED_HOSTS`
   and loopback on the listening port, never the request's own `Host`; others get `421`. Binding
   beyond loopback without `CTGOV_PUBLIC_ORIGIN` or `CTGOV_ALLOWED_HOSTS` stops startup, and
   authenticated serving beyond loopback needs `CTGOV_PUBLIC_ORIGIN` specifically (the OAuth metadata
   names it). **The default Docker image binds 0.0.0.0, so Railway and AWS must now set
   `CTGOV_PUBLIC_ORIGIN`.** `GET /health` is exempt.
8. **Origin validation applies to the anonymous endpoint only** (`--public-docs`, `--insecure`):
   own origin, `CTGOV_ALLOWED_ORIGINS` and loopback pass, anything else is `403`. Bearer-authenticated
   endpoints accept any Origin, because hosted connectors (claude.ai, chatgpt.com) send theirs. The
   OAuth discovery documents and `/mcp` answer CORS preflights without credentials.
9. **Health.** `GET /health` is `{status, version, protocol}` (protocol `2026-07-28`; the old
   `timestamp` is gone). `/healthz` and `/readyz` are **removed**: they exposed the executor and
   provider. Point platform health checks at `/health` (Dockerfile,
   `railway.json` and `deploy/aws` already do).
10. **Env var changes.**

    | Old | New |
    |---|---|
    | `CTGOV_AUTH_RESOURCE` | `CTGOV_AUTH_AUDIENCE` (the advertised resource is `CTGOV_PUBLIC_ORIGIN` + `/mcp`) |
    | `CTGOV_AUTH_JWKS_URL` (optional) | required, https |
    | `CTGOV_AUTH_SCOPES` default `ctgov.read` | default `ctgov:read`, all required |
    | `CTGOV_TRUST_PROXY=1` (trusted the left-most `X-Forwarded-For`, which a client can forge) | `CTGOV_CLIENT_IP_HEADER`: name the header your proxy overwrites (Railway `x-real-ip`; ALB `x-forwarded-for`, rightmost entry used) |
    | `CTGOV_MAX_SESSIONS`, `CTGOV_EMBEDDED_USERS` | removed |
    | - | `CTGOV_PUBLIC_ORIGIN`, `CTGOV_ALLOWED_HOSTS`, `CTGOV_ALLOWED_ORIGINS` |

    Environment variables are read only in `src/bin.ts` (plus the log level and the sandbox
    discovery variables, which **(package C)** moves). An unknown CLI option or `--sandbox` value
    now stops startup instead of being ignored.
11. **Dependencies.** `@modelcontextprotocol/sdk` 1.x is replaced by `@modelcontextprotocol/server`
    and `/node` 2.x, zod 3 by 4, undici 6 by 8 (the `dispatcher` option is kept) and jose 5 by 6.
    The temporary audit exception for zod is gone.
12. **AWS.** The task definition runs `--http` explicitly (it never inherits the image's docs-only
    command), sets `CTGOV_PUBLIC_ORIGIN` and `CTGOV_CLIENT_IP_HEADER`, passes the audience as
    `CTGOV_AUTH_AUDIENCE`, and the target group and container health checks use `/health`.

## Public exports

`src/index.ts` (the package entry point) now exports, at runtime:

- `startStdioServer`, `startHttpServer`, `buildMcpServer`, `selectSandbox`
- `MCP_PROTOCOL_VERSION` (`2026-07-28`), `SERVER_VERSION`
- `AUTH_PROVIDERS`, `DEFAULT_SCOPE`

and the types `StdioStartOptions`, `HttpServerOptions`, `HttpHandle`, `BuildMcpServerOptions`,
`SandboxMode`, `SandboxExecuteOptions`, `SandboxExecutor`, `SandboxResult`, `AuthConfig`,
`AuthProvider`.

Removed: `EmbeddedAs`, `EmbeddedAsOptions`, `buildAuthAdapter`, `loadAuthConfig`. `startHttpServer`
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
| D4 | in-sandbox/dispatch validation | Zod 3 issue codes | Zod 4 (`invalid_enum_value` to `invalid_value`; NCT-ID regex issue reshaped) |
| D5 | `execute` `ok: false` | no `isError` | `isError: true` |
| D6 | `search_api` result | two text blocks: snippet, then `{"hits": N}` | one block `{query, snippet, hits}` (snippet byte-identical) |
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
| S5 | `tools/call` over stdio | pretty JSON, no structured content | as D3/D6 (`test/cli.spec.ts`) |

Unchanged and still pinned: the upstream paths, query serialization, retry, backoff, cache and
paging rows, the CtGovError envelope fields, quota behaviour, the flat-dotted-key hint, the
isolate-refusal for authenticated serving, loopback binding for `--insecure`, the 400/404 shapes and
the plain-text 401/403 bodies.

## Filled in by package C

- **`execute` result envelope**: unchanged here (`{ok, result, error, logs, calls, durationMs, executor}`).
- **`searchAll`**: unchanged here.
- **Sandbox runners, limits, cancellation and the SDK corpus**: unchanged here.
