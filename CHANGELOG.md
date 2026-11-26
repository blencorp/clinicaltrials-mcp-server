# Changelog

All notable changes to this project are documented here. Releases are cut automatically
from `main` (see CONTRIBUTING.md, "Releasing").

## [Unreleased]

## [0.2.0] - 2026-11-26

### Added
- serve a docs-only landing page and rename the package to clinicaltrials-mcp-server

### Fixed
- copy the site product file into the build stage (docker)
- link the hosted docs from the npm landing page, gate npm install docs, quote OIDC templates
- skip a partial portal build, label portal failures, drop a dead changelog link

## [0.1.1] - 2026-11-26

### Fixed
- canonicalize IPv6 addresses in linear time (security)
- derive token lock fields from the runtime form parser and canonicalize IPv6 for limiter keys (security)
- announce the footer heart once (a11y)
- unmap IPv4-mapped IPv6 case-insensitively, keep a leading ? in lock parsing, prefix the pool size variable (security)
- harden account-mode token locks and per-IP limiters (security)

### Changed
- sign "Built with ❤️ by BLEN" and add a teams call to action
- keep the Terraform ignore rules after retiring the AWS path
- retire the AWS path and make .railway/railway.ts the only Railway config (deploy)

## [0.1.0] - 2026-11-21

First release. Nothing was published before it; the development line was `0.1.0-alpha.0`.

### Added

- Code-mode MCP server for ClinicalTrials.gov (`ctgov.*`: study search and records, study
  metadata, search areas, enumerations, field statistics and the API version), with three
  tools (`search_api`, `describe_schema`, `execute`), stdio and stateless Streamable HTTP
  (MCP `2026-07-28`, with a legacy fallback) transports. No API key is needed.
- Sandboxed execution: isolated-vm 7 (prebuilt for Node 24/26) for single-user use, and a
  Deno runner (a permissionless supervisor process running user code in a stripped Worker,
  with token-authenticated frames) which is the only runner for authenticated HTTP serving.
  Host-owned deadlines, process-group cleanup, a V8 heap limit and a resident-memory limit,
  byte budgets enforced inside and outside the sandbox, execution caps, per-execute call
  budgets, and cancellation on client disconnect.
- Tool results as compact JSON plus `structuredContent` and `outputSchema`; failed
  executions return `isError` with the full `{ok, value, logs, error, durationMs}` envelope;
  SDK errors keep their HTTP status.
- ClinicalTrials.gov-aware HTTP client: a shared process-wide gate (10 requests per second,
  `CTGOV_RATE_PER_SEC`), retries with backoff, `Retry-After` pauses on `429`, response
  caching, bounded gzip and an 8 MiB response cap.
- Personal accounts (hosted mode, `CTGOV_AUTH_PROVIDER=accounts`): Google sign-in and
  OAuth/PKCE for `/mcp/account`, keyless, with per-account hourly and daily quotas. The
  anonymous `/mcp` endpoint offers the documentation tools only.
- `--public-docs`: anonymous, database-free, docs-only hosting (`search_api` and
  `describe_schema`), the Docker image's default.
- Fail-closed HTTP security: authentication required unless `--insecure` (which binds to
  loopback), OIDC issuer/audience/expiry/subject/scope checks with asymmetric algorithms
  only, configured-Host validation, Origin checks on the anonymous endpoint, and a 1 MiB
  request cap. `GET /health` for platform health checks.
- Documentation site (`site/`, served at `/docs`), a corpus with runnable examples, a
  generated SDK reference and paste-ready programs in `examples/`.
- Docker image (Node 26 and Deno), an MCPB bundle (manifest v0.4, no configuration to fill
  in) and third-party license notices in every artifact.
- Continuous release pipeline: gates, then a tagged GitHub Release with the npm tarball and
  the Claude Desktop bundle, then an npm publish with provenance.

### Changed

- Licensed under Apache-2.0 (was MIT); the copyright holder is BLEN, Inc. and the
  repository carries a `NOTICE`.
- The `execute` result is `{ok, value, logs, error?, durationMs}` (was `{ok, result, ...}`)
  and a failed execution sets `isError`.
- The authorization scope is `ctgov:read` (was `ctgov.read`).
- `ctgov.studies.searchAll` is removed: loop on `nextPageToken` with `pageToken`.
- The embedded authorization server and HTTP sessions are removed; the transport is stateless.
- Node 24 or 26 is required (was Node 20.10 and later).

[Unreleased]: https://github.com/blencorp/clinicaltrials-mcp-server/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/blencorp/clinicaltrials-mcp-server/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/blencorp/clinicaltrials-mcp-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/blencorp/clinicaltrials-mcp-server/releases/tag/v0.1.0
