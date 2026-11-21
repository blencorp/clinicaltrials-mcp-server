# Privacy Policy — ClinicalTrials.gov MCP (by BLEN)

_Last updated: 2026-11-21_

This policy describes how **ClinicalTrials.gov MCP**, powered by
`@blen/clinicaltrial-mcp-server` (the "Service", operated by BLEN, Inc.),
handles data when accessed from an MCP client such as Claude, ChatGPT, or
Cursor.

The Service gives read-only access to the public ClinicalTrials.gov v2 API
(`clinicaltrials.gov/api/v2`), a U.S. government dataset. That API needs no
key, so **the Service stores no API keys and asks you for none**. The
BLEN-hosted Service has two endpoints:

- `https://clinicaltrials.mcp.blencorp.com/mcp` needs no account. It offers only
  the documentation tools (`search_api`, `describe_schema`), which search
  bundled documentation and never call ClinicalTrials.gov or run code.
- `https://clinicaltrials.mcp.blencorp.com/mcp/account` needs a Google sign-in. It
  adds `execute`, which runs a short JavaScript program against the
  ClinicalTrials.gov API for you, within fair-use limits.

## What the Service receives

- **Tool arguments and results:** search terms, schema lookup paths, and plain
  JavaScript submitted to `execute`, along with data retrieved or computed to
  answer those calls. The connector receives tool requests, not an automatic
  copy of your conversation. Your MCP client decides what it sends.
- **Network metadata:** our hosting provider, Railway, handles connection
  metadata and request headers. The application uses the client IP address
  visible to it (or the address in a configured proxy header) for rate limiting.
- **Support communications:** information you voluntarily provide when
  contacting BLEN.

Tool arguments, submitted code, headers, or support messages can contain
personal information if you or your client include it. Do not submit passwords
or confidential records in tool arguments.

## Account sign-in

Signing in is required only for `/mcp/account`, and only through Google. When
you sign in the Service stores, in a PostgreSQL database:

- your **Google account identity**: your email address, whether Google verified
  it, your name and profile picture if Google provides them, and Google's
  identifier for you;
- your **browser sessions** (an essential session cookie; there are no
  advertising cookies or analytics);
- the **OAuth records** that connect your AI assistant: the registered client,
  your consent decision, and **hashed** access and refresh tokens (the tokens
  themselves are never stored in readable form, and every request is checked
  against them);
- **per-account counters** that enforce the hourly and daily usage limits;
  expired counters are removed periodically.

Google's own policies govern what Google processes when you sign in. The
Service does not read your contacts, mail, files or any other Google data: it
requests only your basic profile and email address.

**There are no API keys** to store, because ClinicalTrials.gov needs none.

## What is sent to other services

`search_api` and `describe_schema` search bundled documentation locally.
`execute` calls the ClinicalTrials.gov API with the query terms, identifiers
and filters your program needs. Requests leave from the hosting provider's
network address with the server's User-Agent; the Service does not forward your
IP address, authorization header, email address or MCP client identity to
ClinicalTrials.gov. The complete JavaScript body runs on our server and is not
sent to ClinicalTrials.gov.

Results return to your MCP client. That client's storage, AI processing and
privacy practices are governed by its own policies. We may disclose information
where required by law or necessary to address abuse or protect the Service.

## Storage and retention

- **Execution:** the application has no feature for saving submitted code,
  conversation histories or tool results. On the hosted Service each execution
  runs in a separate, short-lived process that receives the code in memory and
  ends with the execution. Submitted code is not written to disk. This does not
  mean that every request fragment is excluded from operational logs.
- **Response cache:** ClinicalTrials.gov responses, with their request URLs, are
  cached in process memory for a few minutes, are not tied to a user and are not
  written to disk.
- **Account data:** kept in PostgreSQL while your account exists. Account,
  OAuth and backup retention is controlled by the operator. Deleting data from
  the live database does not delete historical backups.
- **Operational logs:** the application writes startup, warning and error
  records to stderr. Error messages can include request fragments or URLs.
  Hosting infrastructure may collect additional network and service logs.
  Retention depends on the provider's settings; this policy does not promise a
  fixed deletion period.
- **Support records:** handled to respond to your request and address related
  operational or legal needs.

## Uses and limits

We use information to operate the Service, return the data you ask for, limit
abuse, diagnose failures and respond to support requests. We do not sell
personal information, build advertising profiles, or train AI models on
submitted code, queries or results. These statements do not govern the separate
MCP client or websites you choose to use.

## Self-hosted deployments

Operators who self-host this software control their own deployment,
authentication, logging and retention, and their privacy policies apply to their
services. With an OIDC provider (Clerk, WorkOS, Auth0 or a generic issuer) the
server validates bearer tokens and uses the token subject and scopes for
authorization and quotas, without storing them. The `accounts` mode described
above is the one the BLEN-hosted Service runs.

## Your controls

- Disconnect the connector in your MCP client to stop future calls.
- Sign out on the account page to end that browser session.
- To delete your account record, or for any question or access request about
  information held by BLEN, contact **opensource@blencorp.com** from the email
  address you signed in with. Do not send credentials.
- Consult your client's controls for conversation history and client-side
  retention. Self-hosted users should contact their deployment operator.

## Security

The hosted endpoints use HTTPS. Safeguards include per-address and per-account
rate limits, Host and Origin validation, hashed tokens, a JavaScript AST
preflight, and process isolation: the sandbox has no network, filesystem,
environment or subprocess access, and the SDK exposes only registered read
methods. Execution defaults to a 15-second timeout and a 64 MB heap limit, with
fixed limits on the size of code, results and logs. No safeguard is a guarantee
against every security incident.

## Changes and contact

Updates are published here with a revised date. Privacy questions and requests:
**opensource@blencorp.com**. Report vulnerabilities privately using the process
in [SECURITY.md](../SECURITY.md).
