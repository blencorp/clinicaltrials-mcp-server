// Everything product-specific about this documentation site, in one place. The site is shared
// by BLEN's MCP servers: to reuse it, change this file and the pages in src/content/docs/.
// Read by astro.config.mjs, src/lib/install.ts and scripts/ (check-links, render-og,
// sync-reference).
//
// `site` and `repo` are the two addresses to change when the project moves to another GitHub
// organization or host (README "Repository and hosting" lists where else they are written).

export const productName = 'ClinicalTrials.gov MCP';
/** Where the hosted server serves this site (src/accounts/docs.ts serves it at `base`). */
export const site = 'https://clinicaltrials.mcp.blencorp.com';
export const base = '/docs';
export const repo = 'https://github.com/blencorp/clinicaltrials-mcp-server';
export const packageName = '@blen/clinicaltrials-mcp-server';
/**
 * How people can run the server. `npm`: a published package that desktop clients start with npx
 * (the install buttons and pasted configs on the overview and connect pages). `mcpb`: a Claude
 * Desktop bundle attached to each GitHub release. A hosted-only server sets both to false: llms.txt
 * then omits the npm link, scripts/check-links.mjs skips the install checks, and its overview and
 * connect pages must not use the install helpers in src/lib/install.ts (they describe connecting
 * to the hosted URL only).
 */
export const distribution = { npm: true, mcpb: true };
/** The key a client config uses for this server (Cursor, VS Code, mcpServers). */
export const serverName = 'clinicaltrials';
export const description =
  'Connect an AI assistant to ClinicalTrials.gov with the ClinicalTrials.gov MCP server.';
/** The line under the name on the link-preview image, and its alt text. */
export const tagline = 'Ask your AI assistant about clinical studies.';
/** Environment variables a desktop install sets, with blank values (the server explains each). */
export const keyEnv = [];
/** Example values shown in a pasted config. */
export const exampleKeyValues = {};
/** What llms.txt says about the product, above the page list. */
export const llmsDetails = [
  'Run it on your own computer, or connect to the hosted server. ClinicalTrials.gov is public, so no key is needed anywhere. The hosted server is anonymous and offers the documentation tools only (search_api and describe_schema, no sign-in); to run queries with execute, run the server on your computer.',
  'It has three tools: `search_api`, `describe_schema`, and `execute`.',
  'Each page below is also available on its own, as Markdown.',
].join('\n');

/** Sidebar and page-title overrides by slug (see src/lib/pages.mjs). */
export const pageLabels = { keys: 'No key needed' };
