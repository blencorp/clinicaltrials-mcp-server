# Architecture

`@blen/clinicaltrial-mcp-server` is a code-mode MCP server that exposes the public
ClinicalTrials.gov v2 API through three tools (`search_api`,
`describe_schema`, `execute`) rather than one-tool-per-endpoint. The model
writes a short TypeScript body, we run it in a sandbox, and the sandbox's
only outbound path is a supervisor-backed `ctgov.*` SDK.

```
┌───────────────────────────────────────────────────────────────────────┐
│                            Transport layer                            │
│                                                                       │
│  stdio (local / Claude Desktop)       Streamable HTTP (hosted)        │
│       StdioServerTransport         StreamableHTTPServerTransport      │
│            (no auth)                    + Clerk / WorkOS / Auth0      │
│                                         + embedded AS (self-host)     │
│                    │                             │                    │
│                    └───────┬─────────────────────┘                    │
│                            ▼                                          │
│                    buildMcpServer(opts)                               │
│                    tools: search_api, describe_schema, execute        │
│                            │                                          │
│                            ▼                                          │
│                     SubjectQuota (per-sub + global 10 rps)            │
│                            │                                          │
│                            ▼                                          │
│        ┌──────────── Supervisor ───────────────┐                      │
│        │ HttpClient (undici + LRU + retries +  │                      │
│        │ zod validation + audit trace)         │                      │
│        └────────────────┬──────────────────────┘                      │
│                         │                                             │
│                         ▼                                             │
│                ClinicalTrials.gov v2                                  │
│                                                                       │
│        ┌──────────── Sandbox ───────────────┐                         │
│        │ isolated-vm (primary)              │                         │
│        │ deno subprocess (fallback)         │                         │
│        │ AST allow-list (acorn)             │                         │
│        └────────────────┬───────────────────┘                         │
│                         │ RPC only                                    │
│                         ▼                                             │
│                  ctgov.* SDK shim (bindings.ts)                       │
│                  calls __host.rpc(method, args)                       │
└───────────────────────────────────────────────────────────────────────┘
```

## Data flow (single `execute` call)

1. **MCP tools/call** reaches the server transport.
2. `buildMcpServer` routes to `runExecute` with the validated body.
3. `SubjectQuota.tryConsumeExecute(sub)` enforces per-subject rate.
4. `validateUserCode` (acorn AST pass) rejects blocked identifiers before a
   sandbox even spins up.
5. The selected `SandboxExecutor` runs the code inside an isolate (or Deno
   subprocess). The sandbox has exactly one capability: `ctgov.*` via RPC.
6. Every `ctgov.*` call crosses the RPC bridge, hits `buildRpcDispatch` in
   the host, flows into `CtGovRuntime` which validates args with zod, and
   finally reaches `HttpClient` which applies:
   - subject-aware rate limiting (`acquireFn` hook),
   - LRU cache lookup,
   - retry with exponential backoff + jitter on 408/425/429/5xx,
   - stale-cache fallback when upstream fails after retries exhaust,
   - audit recording.
7. Result returns to the sandbox, optionally logged via the bridged
   `console.*`, and the final return value is serialized and returned to the
   client as the tool result.

## Security boundaries

| Boundary | Enforcement |
|---|---|
| User code → host | V8 isolate (or Deno `--allow-none` subprocess), no net/fs/env/ffi |
| User code → direct escape hatches | acorn AST preflight rejects imports, eval, host-bridge access, and unsafe prototype/property chains before execution |
| Incoming HTTP | OAuth 2.1 PKCE + audience-bound JWT, RFC 9728 PRM, optional WAFv2 allow-list |
| Per-subject fair use | SubjectQuota (60 execute/min, 600 upstream/min) |
| Global upstream fair use | 10 rps token bucket (CT.gov documented limit) |
| Upstream credential leakage | Credentials live only in the supervisor's HttpClient; the sandbox never sees them |

## Auth providers

All providers reduce to the same `AuthAdapter` interface
(`verifyAccessToken`, `getUpstreamCredential`):

| Provider | Notes |
|---|---|
| `clerk` | Default for hosted. DCR + PKCE + JWKS. |
| `workos` | Via `WorkOsAuthAdapter` (OIDC, same shape). |
| `auth0` | Via `Auth0AuthAdapter` (OIDC, same shape). |
| `generic-oidc` | Any OIDC IdP with a standard JWKS. |
| `embedded` | Built-in AS (RFC 7591 DCR, auth code + PKCE, RS256 JWTs). |
| `none` | No auth (local/stdio only). |

## OAuth metadata

- `/.well-known/oauth-protected-resource` — RFC 9728 PRM advertising our
  `resource`, the trusted AS, and supported scopes.
- `/.well-known/oauth-authorization-server` — RFC 8414 AS metadata, either
  cached from the upstream issuer or served directly by the embedded AS.
- `WWW-Authenticate: Bearer realm="…", resource_metadata="…"` on every 401
  so clients can discover the AS via the PRM.
