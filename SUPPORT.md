# Support

This is an independent open-source project. It is not affiliated with or endorsed by the
U.S. National Library of Medicine, the NIH or ClinicalTrials.gov. Help is given on a
best-effort basis by the maintainers.

## Before you ask

- **Documentation:** <https://clinicaltrials.mcp.blencorp.com/docs/> has connect guides for
  Claude Desktop, Cursor and VS Code, recipes, and the SDK reference.
- **SDK reference:** [`docs/sdk-reference.md`](./docs/sdk-reference.md) lists every `ctgov.*`
  method, the search syntax, and the errors.
- **Examples:** [`examples/`](./examples/) holds programs you can paste into `execute`.
- **Existing issues:** search the
  [issue tracker](https://github.com/blencorp/clinicaltrials-mcp-server/issues?q=is%3Aissue),
  open and closed.

## Where to go

| You have | Go to |
|---|---|
| A bug, or behaviour that differs from the docs | [Open a bug report](https://github.com/blencorp/clinicaltrials-mcp-server/issues/new?template=bug_report.md) |
| An idea for a new SDK method, tool argument or setting | [Open a feature request](https://github.com/blencorp/clinicaltrials-mcp-server/issues/new?template=feature_request.md) |
| A question about using or hosting the server | [Ask a question](https://github.com/blencorp/clinicaltrials-mcp-server/issues/new?template=question.md) |
| A security vulnerability (sandbox escape, auth bypass, credential leak) | A [private security advisory](https://github.com/blencorp/clinicaltrials-mcp-server/security/advisories/new). See [`SECURITY.md`](./SECURITY.md). Never a public issue. |
| A question about the data in a study record, or a wrong or missing record | The study's sponsor, or ClinicalTrials.gov through its [Support page](https://clinicaltrials.gov/about-site/contact-us). This project only passes the records through. |
| A question about the BLEN-hosted service, its terms or your data | **opensource@blencorp.com**. See the [Terms of Service](./legal/terms.md) and [Privacy Policy](./legal/privacy-policy.md). |
| A Code of Conduct concern | **conduct@blenlabs.com**. See the [Code of Conduct](./CODE_OF_CONDUCT.md). |

## What to include

A report we can act on has:

- the server version (the version your MCP client shows for `clinicaltrials-mcp-server`, or
  your git SHA; `npm view` shows the newest release, not the one you run), the transport
  (stdio or HTTP), the sandbox runner (`isolate` or `deno`), your Node version and your MCP
  client;
- the exact code you passed to `execute`, or the `search_api` query;
- the full error envelope (`{ ok, error: { name, message, status }, logs }`);
- server log lines, if you have them (`CTGOV_LOG_LEVEL=debug` gives more detail).

**Never paste a secret.** Client configuration files, `.env` files and shell histories can
hold tokens (for example a bearer token for your own deployment); remove them first.

## What we cannot do

- Give medical advice, or interpret a study record for you. Talk to a clinician about your
  own care.
- Speed up, repair or explain an outage of the ClinicalTrials.gov API. When an endpoint
  changes upstream, a bug report with the request and the response status is the fastest
  way to get the SDK updated.
- Match people to trials. The server reads what sponsors registered; it does not judge
  eligibility.

## Contributing

To fix something yourself, start with [`CONTRIBUTING.md`](./CONTRIBUTING.md).
