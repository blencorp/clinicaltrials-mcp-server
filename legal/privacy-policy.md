# Privacy Policy — ClinicalTrials.gov MCP (by BLEN)

_Last updated: 2026-11-26_

This policy describes how **ClinicalTrials.gov MCP**, powered by
`@blen/clinicaltrials-mcp-server` (the "Service", operated by BLEN, Inc.),
handles data when accessed from an MCP client such as Claude, ChatGPT, or
Cursor.

The Service gives read-only access to the public ClinicalTrials.gov v2 API
(`clinicaltrials.gov/api/v2`), a U.S. government dataset. That API needs no
key, so **the Service stores no API keys and asks you for none**. The
BLEN-hosted Service is anonymous and documentation-only: there are no accounts
and no sign-in. Its one endpoint, `https://clinicaltrials.mcp.blencorp.com/mcp`,
offers only the documentation tools (`search_api`, `describe_schema`), which
search bundled documentation and never call ClinicalTrials.gov or run code. To
run queries with `execute`, run the server on your own computer (see the
[documentation](https://clinicaltrials.mcp.blencorp.com/docs/)); nothing is then
sent to BLEN.

## What the Service receives

- **Tool arguments and results:** search terms and schema lookup paths, along
  with the documentation entries returned for them. The connector receives tool
  requests, not an automatic copy of your conversation. Your MCP client decides
  what it sends.
- **Network metadata:** our hosting provider, Railway, handles connection
  metadata and request headers. The application uses the client IP address
  visible to it (or the address in a configured proxy header) for rate limiting,
  in memory only.
- **Support communications:** information you voluntarily provide when
  contacting BLEN.

Tool arguments, headers, or support messages can contain personal information
if you or your client include it. Do not submit passwords or confidential
records in tool arguments.

## Accounts and cookies

The hosted Service has **no accounts, no sign-in, no database and no cookies**.
It does not identify you, and it does not use advertising cookies or analytics.

## What is sent to other services

The hosted Service sends nothing to ClinicalTrials.gov or any other service on
your behalf: `search_api` and `describe_schema` search bundled documentation
locally. Results return to your MCP client. That client's storage, AI processing
and privacy practices are governed by its own policies. We may disclose
information where required by law or necessary to address abuse or protect the
Service.

## Storage and retention

- **Tool requests:** the application has no feature for saving tool arguments,
  conversation histories or results. This does not mean that every request
  fragment is excluded from operational logs.
- **Operational logs:** the application writes startup, warning and error
  records to stderr. Error messages can include request fragments or URLs.
  Hosting infrastructure may collect additional network and service logs.
  Retention depends on the provider's settings; this policy does not promise a
  fixed deletion period.
- **Support records:** handled to respond to your request and address related
  operational or legal needs.

## Uses and limits

We use information to operate the Service, limit abuse, diagnose failures and
respond to support requests. We do not sell personal information, build
advertising profiles, or train AI models on submitted queries or results. These
statements do not govern the separate MCP client or websites you choose to use.

## Self-hosted deployments

Operators who self-host this software control their own deployment,
authentication, logging and retention, and their privacy policies apply to their
services. The software can also run with sign-in: with an OIDC provider (Clerk,
WorkOS, Auth0 or a generic issuer) the server validates bearer tokens and uses
the token subject and scopes for authorization and quotas, without storing them;
its optional `accounts` mode adds Google sign-in backed by a PostgreSQL
database that holds the signed-in user's Google identity, browser sessions,
OAuth records with hashed tokens and per-account usage counters (described
in the repository's `docs/accounts.md`). BLEN does not run these modes for this
Service.

## Your controls

- Disconnect the connector in your MCP client to stop future calls.
- For any question or access request about information held by BLEN, contact
  **opensource@blencorp.com**. Do not send credentials.
- Consult your client's controls for conversation history and client-side
  retention. Self-hosted users should contact their deployment operator.

## Security

The hosted endpoint uses HTTPS. Safeguards include per-address rate limits and
Host and Origin validation, and the hosted Service runs no user-submitted code:
`execute` is not offered there. Where the software does run code (on your own
computer, or a server you host), it applies a JavaScript AST preflight and
process or isolate isolation: the sandbox has no network, filesystem,
environment or subprocess access, and the SDK exposes only registered read
methods. No safeguard is a guarantee against every security incident.

## Changes and contact

Updates are published here with a revised date. Privacy questions and requests:
**opensource@blencorp.com**. Report vulnerabilities privately using the process
in [SECURITY.md](../SECURITY.md).
