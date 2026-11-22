/**
 * Account mode serves two MCP endpoints on one origin. MCP clients only start OAuth when an
 * endpoint answers 401, so anonymous and signed-in access need separate URLs:
 * - PUBLIC_MCP_PATH: no sign-in. Documentation tools only (search_api, describe_schema); it
 *   never runs code, so no anonymous caller can spend the shared ClinicalTrials.gov budget.
 * - ACCOUNT_MCP_PATH: OAuth (Google sign-in). Adds `execute`, which runs in the Deno process
 *   sandbox under per-account limits.
 */
export const PUBLIC_MCP_PATH = '/mcp';
export const ACCOUNT_MCP_PATH = '/mcp/account';
