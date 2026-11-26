import type { AuthConfig } from "./authz.js";
import { REPOSITORY_URL } from "../project.js";

/** RFC 9728 path-suffixed metadata location for the `/mcp` resource. */
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
/** The un-suffixed location, still served for clients that only try the root document. */
export const RESOURCE_METADATA_ROOT_PATH = "/.well-known/oauth-protected-resource";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728). `resource` is the canonical URL of the MCP
 * endpoint; the authorization server is the configured issuer, which clients query themselves.
 */
export function protectedResourceMetadata(cfg: AuthConfig, resourceUrl: string): Record<string, unknown> {
  return {
    resource: resourceUrl,
    authorization_servers: cfg.issuer ? [cfg.issuer] : [],
    bearer_methods_supported: ["header"],
    scopes_supported: cfg.scopes ?? [],
    resource_documentation: `${REPOSITORY_URL}#readme`,
    resource_policy_uri: `${REPOSITORY_URL}/blob/main/legal/terms.md`,
    resource_name: "ClinicalTrials.gov MCP",
  };
}

/** The `WWW-Authenticate` challenge on 401/403, pointing the client at the metadata document. */
export function bearerChallenge(origin: string, extra = ""): string {
  return `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}"${extra}`;
}
