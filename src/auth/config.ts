import { CtGovError } from "../supervisor/errors.js";
import type { AuthAdapter } from "./adapter.js";
import { ClerkAuthAdapter } from "./providers/clerk.js";
import { WorkOsAuthAdapter } from "./providers/workos.js";
import { Auth0AuthAdapter } from "./providers/auth0.js";

export type AuthProvider =
  | "clerk"
  | "workos"
  | "auth0"
  | "generic-oidc"
  | "embedded"
  | "none";

export interface AuthConfig {
  /** Which provider is active. */
  provider: AuthProvider;
  /** The OAuth resource identifier this server advertises (RFC 9728). */
  resource: string;
  /** Issuer URL of the authorization server. */
  issuer: string;
  /** Optional explicit JWKS URL override. */
  jwksUrl?: string;
  /** Scopes we advertise as supported. */
  scopesSupported: string[];
}

/**
 * Build an adapter from environment variables. Never throws on missing env
 * when `provider=none` so tests can run without OAuth configured.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const provider = (env.CTGOV_AUTH_PROVIDER as AuthProvider | undefined) ?? "none";
  const resource = env.CTGOV_AUTH_RESOURCE ?? "https://clinicaltrials.mcp.blencorp.com/mcp";
  const issuer = env.CTGOV_AUTH_ISSUER ?? "";
  const scopesSupported = (env.CTGOV_AUTH_SCOPES ?? "ctgov.read").split(/[\s,]+/).filter(Boolean);

  const cfg: AuthConfig = { provider, resource, issuer, scopesSupported };
  if (env.CTGOV_AUTH_JWKS_URL) {
    cfg.jwksUrl = env.CTGOV_AUTH_JWKS_URL;
  } else if (provider === "embedded" && issuer) {
    cfg.jwksUrl = `${issuer.replace(/\/$/, "")}/as/jwks.json`;
  }
  return cfg;
}

export function buildAuthAdapter(cfg: AuthConfig): AuthAdapter | null {
  if (cfg.provider === "none") return null;
  if (!cfg.issuer) {
    throw new CtGovError("INTERNAL_ERROR", "CTGOV_AUTH_ISSUER is required when provider != none");
  }
  const base = {
    issuer: cfg.issuer,
    audience: cfg.resource,
    ...(cfg.jwksUrl !== undefined ? { jwksUrl: cfg.jwksUrl } : {}),
  };
  switch (cfg.provider) {
    case "clerk":
    case "generic-oidc":
    case "embedded":
      return new ClerkAuthAdapter(base);
    case "workos":
      return new WorkOsAuthAdapter(base);
    case "auth0":
      return new Auth0AuthAdapter(base);
    default:
      throw new CtGovError("INTERNAL_ERROR", `unknown auth provider: ${cfg.provider}`);
  }
}
