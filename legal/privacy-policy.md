# Privacy Policy — ClinicalTrials.gov Explorer (by BLEN)

_Last updated: 2026-04-25_

This document describes how **@blen/clinicaltrial-mcp-server** (the "Service",
operated by BLEN, Inc.) handles data when accessed as a remote MCP connector
from Claude or any other MCP client.

The public listing at `https://clinicaltrials.mcp.blencorp.com/mcp` is an
**unauthenticated, read-only** mirror of a public U.S.-government dataset
(ClinicalTrials.gov v2). The sections below describe the public-listing
posture first, then the additional handling that applies only when an
operator self-hosts the same software with authentication enabled.

## Public listing — what we receive

- **Tool invocations**: the arguments you pass to `search_api`,
  `describe_schema`, and `execute` (including the TypeScript code body you
  submit for sandboxed execution). Sandboxed code runs in-memory and is not
  persisted.
- **Network metadata**: source IP and standard request headers, observed at
  the Railway edge and at our process. Used solely for transport-layer abuse
  mitigation (per-IP rate limiting). Not joined to any identity.

We do **not** receive your name, email, account identifier, or any other
personal profile data on the public listing — there is no login.

## Public listing — what we send upstream

Calls from the sandbox go to the public ClinicalTrials.gov v2 API at
`https://clinicaltrials.gov/api/v2`. We do **not** send your IP, identity, or
any metadata about you to ClinicalTrials.gov; outbound requests originate
from our hosting provider's egress.

## Retention (public listing)

- **Response cache**: in-memory, per session, evicted after 5 minutes or at
  session end. Never written to disk.
- **Audit logs**: structured JSON containing trace id, upstream URL, HTTP
  status, duration, and byte counts. Retained for **30 days** in our hosting
  provider's log store and used solely for abuse response and debugging.
  Request bodies, response payloads, and source IPs are **not** retained
  beyond the rolling rate-limiter window.
- **Security events** (rate-limit violations, sandbox policy rejections,
  upstream 5xx bursts): retained for **90 days**.

## What we do not do

- We do not sell or share data.
- We do not profile users or build behavioral models from usage.
- We do not train AI models on your submitted code, queries, or results.
- We do not collect cookies, browser fingerprints, or analytics beacons —
  the connector speaks JSON-RPC, not HTML.

## Self-hosted (auth-enabled) deployments

The same software supports authenticated deployments via Clerk, WorkOS,
Auth0, generic OIDC, or a built-in embedded Authorization Server. Operators
who turn auth on additionally process:

- The `sub` (subject) claim from their authorization server's access token
  and the dynamically registered client identifier (RFC 7591).
- Per-subject rate-limit state (in-memory).

Self-hosted operators are responsible for their own privacy practices. The
public BLEN-hosted listing does not run in this mode.

## Your controls

- **Stop receiving requests**: remove the connector in Claude. We have no
  identifier with which to "delete" your data because we do not collect one
  on the public listing.
- **Self-hosted operators (auth on)**: email <opensource@blencorp.com>
  referencing your OAuth `sub` and we will purge associated audit entries
  within 14 days.

## Security

- TLS 1.2/1.3 end-to-end at the Railway edge (managed certificates).
- Per-IP token-bucket rate limiter on `/mcp` runs before any other handling.
- The `execute` sandbox isolates user code from the host: no network, no
  filesystem, no environment, no FFI, no subprocess; AST allow-list
  preflight; 15-second wall-clock and 64 MB heap caps per call.
- Outbound calls to ClinicalTrials.gov are subject to a global 10 rps token
  bucket so we respect the upstream's documented rate limit.

## Contact

Questions, deletion requests (auth-enabled deployments only), or security
disclosures: **opensource@blencorp.com**. Security disclosures may also use
the process described in [`SECURITY.md`](../SECURITY.md).
