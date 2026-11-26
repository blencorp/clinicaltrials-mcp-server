/**
 * Where this project lives. The one place the source repository's URL is written for the server's
 * own code (the OAuth resource metadata and the upstream User-Agent); the MCPB manifest reads it
 * from package.json, and the documentation site from site/product.mjs. When the repository moves,
 * change these and package.json, site/product.mjs and web/src/brand.tsx (the README lists the rest).
 */
export const REPOSITORY_URL = 'https://github.com/blencorp/clinicaltrials-mcp-server';
export const USER_AGENT = `clinicaltrials-mcp-server (+${REPOSITORY_URL})`;
