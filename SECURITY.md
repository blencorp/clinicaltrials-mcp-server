# Security Policy

## Reporting a vulnerability

Please **do not file public GitHub issues for security reports**. Instead,
open a private GitHub Security Advisory:

> <https://github.com/blencorp/clinicaltrials-mcp-server/security/advisories/new>

If that's not available, email **opensource@blencorp.com** with the subject
`[security] clinicaltrials-mcp-server`, or contact the maintainers via the GitHub
organization page at <https://github.com/blencorp>.

We try to respond within **3 business days**. A typical timeline for a
confirmed sandbox-escape report:

1. Initial acknowledgement and severity triage — within 3 business days.
2. Coordinated fix in a private branch — within 14 days for critical, 30 for
   high-severity issues.
3. Patched release published to npm with a credit line (unless you ask not
   to be credited).
4. Public advisory and CVE filing once users have had reasonable upgrade time.

## Scope

In scope:
- **Sandbox escapes** — any code in `execute` that gets host filesystem,
  network, environment, subprocess, native binding, or out-of-isolate
  references.
- **AST preflight bypasses** — code that passes `preflight()` in
  `src/sandbox/policy.ts` but performs disallowed operations at runtime.
- **Auth bypass** — sending requests to `/mcp` (or `/mcp/account` in account
  mode) without a valid bearer that reaches a tool handler, or reaching `execute`
  on the anonymous `/mcp`.
- **Credential exposure** — any way for sandboxed code, logs, results or errors to
  reveal a bearer token, a session cookie, the database URL or another secret the
  server holds, or for one account's session to act as another's. (ClinicalTrials.gov
  needs no API key, so no upstream key exists.)
- **Resource bounds** — an execution that outlives its deadline, leaves a process
  behind, or makes the host buffer more than the documented byte budgets.
- **DNS rebinding / SSRF** against the HTTP transport.
- **Quota / rate-limit bypass** that allows a single subject or IP to exceed
  the configured ceiling.

Out of scope (please file a normal issue instead):
- Upstream API behaviour and limits (those are ClinicalTrials.gov's; see
  `CTGOV_RATE_PER_SEC` and the limits in the README).
- Denial of service via lawful but expensive queries (we accept this risk
  on a per-tenant basis; tune `CTGOV_SUBJECT_DAILY_QUOTA` and
  `CTGOV_IP_RPS`).
- Issues that only occur with `--insecure` (which is documented as dev-only).
- Errors in a study record itself: records are registered by their sponsors and
  published by ClinicalTrials.gov.

## Sandbox guarantees

The `execute` tool runs user-supplied JavaScript with layered defenses:

1. **AST preflight** (`acorn` + `acorn-walk`, see `src/sandbox/policy.ts`):
   rejects `import` / `import()` / `eval` / `new Function` and references to
   `process`, `globalThis`, `Buffer`, `Deno`, `fetch`, `Worker`, plus
   `__proto__` / `constructor` / `prototype` member access. The check rejects
   *static* uses of these names; runtime synthesis (e.g. via string
   concatenation) is the next layer's job. It reads the code both as a module
   and as a script, because the two grammars treat HTML-like comments
   differently, and it rejects code that closes the function that wraps it.
2. **Runtime isolation** — one of:
   - `isolated-vm`: a fresh V8 isolate per execution, **no host references**
     other than a Reference to the RPC dispatcher and a log sink for `console.*`;
     heap cap; a host-owned wall-clock deadline (started before setup, covering
     never-settling promises) disposes the isolate. It runs inside the server
     process, so it is used only for single-user operation (stdio, `--insecure`).
   - Deno: `deno run --no-prompt --no-config --no-lock --no-remote --no-npm` of a
     fixed supervisor script with **no `--allow-*` flags** (no net/fs/env/ffi/
     subprocess access) and a minimal environment. User code arrives by message
     (it is never written to disk) and runs as a module in a Worker. Before it
     runs, the worker deletes every global that is not part of the language
     (`Deno`, `fetch`, `Worker`, `process`, `postMessage`, …; `queueMicrotask`
     stays, because the Deno runtime itself calls it on the worker global) and
     refuses to run if one stays, so a program gets the language's globals,
     `console` and the SDK bindings. V8 builds no code from strings in this process
     (`eval` and `Function` throw). Frames to the host are prefixed with a random
     token the worker never sees; all other output is untrusted text. The host owns
     the deadline, kills the process group, and waits for the child to exit before
     releasing the execution. The heap flag does not count buffers, so the supervisor
     also ends the process when its resident memory has grown by more than twice
     `memoryMb` plus 96 MiB during an execution. It checks every 5 ms, so a program
     can pass that bound by what it writes in one interval.
     **Authenticated HTTP serving uses only this runner** (an
     in-process runner is refused there, with no fallback).
3. **Byte budgets**, enforced inside the sandbox before transfer and again on the
   host: code 256 KiB, result 256 KiB, logs 64 KiB / 1,000 lines, SDK-call
   arguments 64 KiB, 100 pending calls (the per-execute call budget). Executions
   are capped per server and per subject, and are aborted when the client cancels
   or disconnects.

Both runners deny network access to user code; the only way to reach the
upstream API is via the `ctgov.*` proxy, which serializes calls through a
host-side RPC and executes them against the configured base URL
(`CTGOV_BASE_URL`, `https://clinicaltrials.gov/api/v2` by default). Identifiers
must match strict grammars (NCT numbers are `NCT` plus eight digits), so sandbox
input cannot change which endpoint is called. Upstream bodies are capped at
8 MiB, including gzip expansion.

The dispatcher resolves exact method names from the explicit, frozen `methods`
table in `src/sdk/sources/ctgov.ts`. It never traverses the host client object or
inherited properties. Only the registered read methods are callable; HTTP clients,
caches, and other host internals are outside the RPC surface. New SDK methods
must be explicitly registered before sandboxed code can call them.

The server holds no ClinicalTrials.gov credential: the API is public and no key
is sent. What it does hold in account mode (the database URL, the Better Auth
secret, the Google OAuth client secret) stays in the host process and is never
passed into the sandbox or logged.

We treat any of the following as a vulnerability:
- Reading the contents of any file under `/`.
- Establishing any outbound socket to a host not configured in the SDK.
- Reading process environment variables.
- Reading or modifying host globals (this includes obtaining `globalThis`,
  `Reflect`, `Function`, `eval`, or any constructor reachable from them).
- Causing the host process to crash, or an execution (or its child process) to
  outlive `timeoutMs` plus a few seconds.
- Forging the result of an execution or of an SDK call from sandboxed code in a
  way the host accepts as protocol data.

## Threat model

This server is designed to be exposed to **untrusted MCP clients** behind
authentication: personal accounts (Google sign-in + OAuth/PKCE, account mode) or
an external OIDC issuer (Clerk / WorkOS / Auth0 / generic OIDC) verified via JWKS
with required issuer, audience, expiry, subject and scopes. It fails closed: `--http`
without real authentication (or `--public-docs`) refuses to start, and an unknown
provider stops startup. The HTTP transport checks `Host` against configured names
(DNS rebinding; the trusted origin is never taken from the request), validates
browser `Origin`s on the anonymous endpoint, caps request bodies at 1 MiB, and adds
per-IP token-bucket rate limiting and per-subject quotas.

The unauthenticated public surfaces by design are account mode's `/mcp` and the
`--public-docs` endpoint, which offer documentation tools only (no code execution,
no ClinicalTrials.gov calls). `--insecure` disables authentication for local
development and binds to `127.0.0.1` by default; operators who expose it publicly
opt out of all auth-layer protections and accept the resulting risk.

## Dependencies

We track advisories on direct runtime dependencies — `@modelcontextprotocol/server`,
`@modelcontextprotocol/node`, `undici`, `jose`, `acorn`, `lru-cache`, `zod`,
`express`, `better-auth`, `pg`, and the optional `isolated-vm` — plus the Deno
runtime pinned in the Docker image. CI fails on any known advisory
(`pnpm audit --audit-level moderate`, dev dependencies included), and Dependabot
proposes updates weekly. For an advisory that affects this server, expect a patch
release within the timeline above.
