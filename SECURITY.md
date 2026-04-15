# Security policy

## Supported versions

The `main` branch is supported. Tagged releases (once 1.0 ships) will be
supported on the most recent minor line.

## Reporting a vulnerability

Please email **opensource@blencorp.com** with the subject
`[security] clinicaltrial-mcp-server` and one of the following:

- a proof-of-concept demonstrating the issue,
- a minimal reproduction repo,
- or a detailed writeup sufficient for us to reproduce.

We acknowledge reports within 3 business days and aim to have a fix out within
30 days for high-severity issues. Please do not file public issues or PRs for
security problems until a fix has shipped.

## In scope

- Sandbox escapes (V8 isolate or Deno subprocess).
- OAuth / token handling flaws (PKCE, DCR, audience binding).
- Upstream request-smuggling, credential leakage, SSRF via user-supplied code.
- Denial-of-service vectors (memory, CPU, unbounded RPC).

## Out of scope

- Vulnerabilities in dependencies for which an upstream patch is already
  available — please open a normal issue.
- Missing security headers on public static responses that have no
  authentication-sensitive content.
