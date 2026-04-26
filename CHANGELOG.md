# Changelog

All notable changes will be documented here. Versioning follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **MCP tool annotations** on every tool (`title`, `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: true`, `openWorldHint`) so the
  catalog matches Anthropic's connector review criteria. Tool descriptions
  now also reference the upstream ClinicalTrials.gov v2 API documentation.
- **IP rate limiter**: per-IP token-bucket (`src/server/ipRateLimiter.ts`)
  applied to `/mcp` and `/as/*` before auth runs. Caps unauthenticated
  flood traffic at 5 rps / 20 burst per IP by default (tunable via
  `CTGOV_IP_RPS` / `CTGOV_IP_BURST`). Returns 429 with `Retry-After`.
- **`CTGOV_TRUST_PROXY`** env var. Set to `1` when behind a known reverse
  proxy (Railway, Cloudflare, ALB) so the limiter reads the first
  `x-forwarded-for` hop.
- **Railway deploy guide** in `README.md` as an alternative to the AWS
  Terraform module. Reuses `deploy/Dockerfile` unchanged.

### Changed

- **OAuth well-known endpoints are 404 in unauthenticated mode**
  (`--insecure` / `provider=none`). Previously they always returned a PRM
  document referencing an authorization server that did not exist, which
  broke MCP clients probing the metadata. Auth-enabled deployments still
  serve PRM (RFC 9728) and AS metadata (RFC 8414) at the conventional paths.
- **Privacy policy** rewritten to match the public Railway no-auth posture
  (no OAuth identity collected on the public listing). The auth-on
  self-hosted path is documented as a separate section so operators have an
  accurate reference.
- **Submission packet** (`legal/submission-packet.md`) refreshed as a
  narrative pitch with the connector's code-mode novelty, five worked
  examples, and an explicit map to every Anthropic review criterion.

### Fixed

- **Hostname / repo URL drift**: every reference to the singular
  `clinicaltrial.mcp.blencorp.com` host and `blencorp/clinicaltrial-mcp-server`
  repo path now matches the deployed plural form
  (`clinicaltrials.mcp.blencorp.com`,
  `https://github.com/blencorp/clinicaltrials-mcp-server`). The npm package
  name stays `@blen/clinicaltrial-mcp-server` for publish stability.

## 0.1.0-alpha.0 — 2026-04-14

Initial alpha, tracked on `claude/plan-clinicaltrial-mcp-rdxY1`.

### Added

- **Core**: `@blen/clinicaltrial-mcp-server` package (Node 20+, TypeScript strict).
- **Tools**: `search_api` (BM25 over endpoints + study-field dictionary),
  `describe_schema` (path/prefix lookup), `execute` (sandboxed TS body).
- **Supervisor**: undici-backed HTTP client with token-bucket rate limit,
  LRU cache, zod validation, exponential-backoff retry, stale-cache
  fallback on upstream failure, structured audit trace.
- **Sandbox**: `isolated-vm` primary executor + Deno subprocess fallback,
  AST allow-list (acorn) with blocked identifiers, 15 s wall clock and
  64 MB heap default caps.
- **Transports**: stdio (local) and MCP Streamable HTTP (remote, with
  per-session stateful transports and an idle sweeper).
- **OAuth**: RFC 9728 PRM, RFC 8414 AS metadata (cached proxy), RFC 7591
  DCR-ready metadata, PKCE/audience binding via `jose`.
- **Providers**: Clerk, WorkOS, Auth0, generic OIDC, and an **embedded
  Authorization Server** (RFC 7591 DCR + authorization_code + PKCE S256 +
  RS256 JWT issuance + JWKS + refresh-token rotation) for self-hosters.
- **Quotas**: per-subject execute + upstream rate limits stacked under the
  global 10 rps bucket.
- **Deploy**: Docker image (multi-stage, non-root, tini), Terraform module
  for AWS ECS Fargate + ALB + ACM + Route 53 + Secrets Manager +
  CloudWatch Logs + WAFv2, GitHub Actions OIDC deployer.
- **Compliance**: submission packet, `pnpm check:directory` verifier.
- **Examples**: five worked prompts in `examples/`.
- **CI**: lint + typecheck + test + build + docker image CI, scheduled
  schema-drift check with auto-issue creation.
- **Docs**: README, ARCHITECTURE, CHANGELOG, CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT, privacy/terms/support/submission-packet.
- **Tests**: 55+ unit + integration tests (rate limiter, cache, AST
  policy, BM25 ranker, corpus, HTTP client with MockAgent, fault
  injection, Clerk adapter with signed JWTs, embedded AS e2e, HTTP
  transport secure + insecure modes, sandbox chaos, Deno fallback smoke).
