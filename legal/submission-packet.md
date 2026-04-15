# Claude Connectors Directory — submission packet

For review under the [Remote MCP Server Submission Guide][g1] and the
[Anthropic Software Directory Policy][g2].

[g1]: https://support.claude.com/en/articles/12922490-remote-mcp-server-submission-guide
[g2]: https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy

## Connector

| Field | Value |
|---|---|
| Display name | **ClinicalTrials.gov Explorer (by BLEN)** |
| Short description | Query and analyze the live ClinicalTrials.gov v2 dataset with code-mode tooling. |
| Server URL | `https://clinicaltrial.mcp.blencorp.com/mcp` |
| PRM URL | `https://clinicaltrial.mcp.blencorp.com/.well-known/oauth-protected-resource` |
| Support email | opensource@blencorp.com |
| Privacy policy | `legal/privacy-policy.md` |
| Terms | `legal/terms.md` |
| Source code | <https://github.com/blencorp/claude-playground> |

## Auth

- OAuth 2.1 with PKCE (RFC 7636), Dynamic Client Registration (RFC 7591),
  audience-bound access tokens (RFC 8707), Protected Resource Metadata
  (RFC 9728), Authorization Server Metadata (RFC 8414).
- Authorization Server: **Clerk** (`https://clerk.blencorp.com`).
- Scopes advertised: `ctgov.read`.

## Network

- Public HTTPS endpoint at `clinicaltrial.mcp.blencorp.com` (ACM cert, TLS 1.2/1.3).
- Hosted on AWS ECS Fargate behind an ALB.
- Reachable from Anthropic's published IP ranges; WAFv2 IP-allowlist keeps
  unrelated traffic out for the directory listing.

## Core functionality

Three tools:

1. **`search_api`** — BM25 search over the ClinicalTrials.gov API surface
   plus study-field dictionary. Returns a focused TypeScript snippet.
2. **`describe_schema`** — field dictionary lookup by exact path / prefix.
3. **`execute`** — runs an async TS body against a typed `ctgov` SDK in an
   `isolated-vm` sandbox (Deno subprocess fallback). No network, fs, or
   process access; 15 s wall clock; 64 MB heap; AST allow-list.

## Examples

See [`examples/`](../examples/):

1. Phase 3 oncology by sponsor
2. Recruiting trials near a geo point
3. Eligibility digest for a single study
4. 5-year diabetes-trial registration trend

## Compliance checklist (verified by `pnpm check:directory`)

- [x] HTTPS
- [x] `/healthz` returns 200
- [x] `/.well-known/oauth-protected-resource` valid RFC 9728 JSON
- [x] `/.well-known/oauth-authorization-server` proxied or 404
- [x] POST `/mcp` without bearer returns 401 with `WWW-Authenticate` +
      `resource_metadata=…`
- [x] ≥ 3 working examples
- [x] Privacy policy, terms, support docs present

## Security posture

- Sandbox: `isolated-vm` with AST allow-list; no `import`, `eval`,
  `new Function`, `process`, `__host` access.
- Per-subject rate limiting (60 execute/min, 600 upstream/min) plus the
  global CT.gov 10 rps bucket.
- WAFv2: `AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`,
  per-IP rate limit (2000 req / 5min).
- No secret material is ever exposed to sandboxed code; future upstream
  credentials are resolved only in the supervisor.
- 30-day audit retention for abuse response; no request bodies stored.

## Contact for review

opensource@blencorp.com
