import type { AuthConfig } from "../auth/config.js";

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 * Published at `/.well-known/oauth-protected-resource`.
 */
export function protectedResourceMetadata(cfg: AuthConfig): Record<string, unknown> {
  return {
    resource: cfg.resource,
    authorization_servers: cfg.issuer ? [cfg.issuer] : [],
    bearer_methods_supported: ["header"],
    scopes_supported: cfg.scopesSupported,
    resource_documentation:
      "https://github.com/blencorp/claude-playground/blob/main/legal/privacy-policy.md",
    resource_policy_uri:
      "https://github.com/blencorp/claude-playground/blob/main/legal/terms.md",
    resource_name: "ClinicalTrials.gov Explorer (by BLEN)",
  };
}

/**
 * Minimal passthrough of RFC 8414 Authorization Server Metadata. We do not
 * host the AS ourselves — Clerk does — but expose the same payload at the
 * conventional path to satisfy MCP clients that look there first.
 *
 * This endpoint returns `null` when no issuer is configured; the HTTP
 * handler maps that to 404.
 */
export interface ASMetadataFetcher {
  get(): Promise<Record<string, unknown> | null>;
}

export function makeASMetadataFetcher(
  cfg: AuthConfig,
  fetchImpl: typeof fetch = fetch,
): ASMetadataFetcher {
  let cached: { at: number; doc: Record<string, unknown> | null } | null = null;
  const TTL = 10 * 60_000;
  return {
    async get() {
      if (!cfg.issuer) return null;
      if (cached && Date.now() - cached.at < TTL) return cached.doc;
      try {
        const url = `${cfg.issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
        const res = await fetchImpl(url, { headers: { accept: "application/json" } });
        if (!res.ok) {
          cached = { at: Date.now(), doc: null };
          return null;
        }
        const doc = (await res.json()) as Record<string, unknown>;
        cached = { at: Date.now(), doc };
        return doc;
      } catch {
        cached = { at: Date.now(), doc: null };
        return null;
      }
    },
  };
}

/**
 * The value of the `WWW-Authenticate` header returned on 401s, pointing
 * the client at our RFC 9728 metadata.
 */
export function wwwAuthenticateHeader(cfg: AuthConfig): string {
  const metadataUrl = new URL(cfg.resource);
  metadataUrl.pathname = "/.well-known/oauth-protected-resource";
  metadataUrl.search = "";
  return `Bearer realm="${cfg.resource}", resource_metadata="${metadataUrl.toString()}"`;
}
