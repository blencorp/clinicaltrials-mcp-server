# Changelog

All notable changes will be documented here. Versioning follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
