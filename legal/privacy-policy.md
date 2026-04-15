# Privacy Policy — ClinicalTrials.gov Explorer (by BLEN)

_Last updated: 2026-04-14_

This document describes how **@blen/clinicaltrial-mcp-server** (the "Service", operated by
Blen Corporation) handles data when accessed as a remote MCP connector from
Claude or other MCP clients.

## Data we receive

- **Your OAuth identity**: the `sub` (subject) claim from our authorization
  server (Clerk) and the client identifier registered via RFC 7591 Dynamic
  Client Registration. We do **not** receive email, name, or other profile
  claims unless you explicitly authorize the corresponding scopes.
- **Tool invocations**: the arguments you pass to `search_api`,
  `describe_schema`, and `execute` (including the code body you submit for
  sandboxed execution).
- **Network metadata**: IP address and TLS fingerprint of incoming requests
  (at the AWS ALB/WAFv2 layer, used solely for abuse mitigation).

## What we send upstream

Calls from the sandbox go to the public ClinicalTrials.gov v2 API at
`https://clinicaltrials.gov/api/v2`. We do not send your identity, IP, or any
other metadata about you to ClinicalTrials.gov.

## Retention

- **Response cache**: in-memory, per-session, evicted after 5 minutes or at
  session end. Never written to disk.
- **Audit logs**: structured JSON containing `sub`, trace id, upstream URL,
  status, duration, and byte counts. Retained for 30 days in CloudWatch Logs
  and used solely for abuse response and debugging. Request bodies and
  response payloads are **not** retained.
- **Security events** (rate-limit violations, sandbox policy rejections,
  upstream 5xx bursts): retained for 90 days.

## What we do not do

- We do not sell or share personal data.
- We do not profile or build behavioral models from your usage.
- We do not train AI models on your submitted code or results.

## Your controls

- **Revoke**: remove the connector from Claude and we stop receiving your
  requests immediately.
- **Delete**: email <opensource@blencorp.com> referencing your OAuth `sub` and
  we will purge associated audit entries within 14 days.

## Security

- TLS 1.2+ end-to-end via AWS ACM.
- Secrets held in AWS Secrets Manager; tokens validated against Clerk's JWKS
  on every request.
- WAFv2 managed rule groups (`AWSManagedRulesCommonRuleSet`,
  `AWSManagedRulesKnownBadInputsRuleSet`) plus per-subject rate limits.
- Sandbox isolates user code from host: no network, no filesystem, no env
  access, 15 s wall-clock and 64 MB memory cap.

## Contact

Questions, deletion requests, or security disclosures:
**opensource@blencorp.com**.
