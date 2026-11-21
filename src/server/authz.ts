import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** Bearer-token verification for the HTTP transport. `none` is only valid with --insecure or --public-docs. */
export const AUTH_PROVIDERS = ["none", "generic-oidc", "clerk", "workos", "auth0"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

/** The scope a token must carry unless CTGOV_AUTH_SCOPES says otherwise. */
export const DEFAULT_SCOPE = "ctgov:read";

export interface AuthConfig {
  provider: AuthProvider;
  /** Trusted token issuer (`iss`). Required for OIDC providers. */
  issuer?: string;
  /** This resource server's audience (`aud`). Required for OIDC providers. */
  audience?: string;
  /** JWKS endpoint of the issuer. Required for OIDC providers and must be https. */
  jwksUrl?: string;
  /** Scopes every token must carry; also advertised as `scopes_supported`. */
  scopes?: string[];
}

export interface AuthContext {
  subject: string;
  claims: JWTPayload;
  scopes: string[];
}

export interface Verifier {
  verify(token: string): Promise<AuthContext>;
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export class InsufficientScopeError extends Error {
  constructor(readonly required: string[]) {
    super(`token lacks required scope(s): ${required.join(" ")}`);
    this.name = "InsufficientScopeError";
  }
}

/** Asymmetric algorithms only: a JWKS-verified token must never be accepted as HS256/none. */
const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

/** Scopes granted to a token, from `scope` (space-delimited) or `scp` (array). */
export function grantedScopes(claims: JWTPayload): string[] {
  const raw = claims.scope ?? claims.scp;
  if (typeof raw === "string") return raw.split(" ").filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return [];
}

export class OidcVerifier implements Verifier {
  private readonly keys: JWTVerifyGetKey;

  /** `keys` is for tests that sign against a local key set; production builds the remote JWKS. */
  constructor(
    private readonly cfg: AuthConfig,
    keys?: JWTVerifyGetKey,
  ) {
    if (!cfg.issuer) throw new AuthConfigError("CTGOV_AUTH_ISSUER is required for OIDC providers (the trusted token issuer).");
    if (!cfg.audience) throw new AuthConfigError("CTGOV_AUTH_AUDIENCE is required for OIDC providers (tokens must be issued for this server).");
    if (!keys) {
      if (!cfg.jwksUrl) throw new AuthConfigError("CTGOV_AUTH_JWKS_URL is required for OIDC providers.");
      let url: URL;
      try {
        url = new URL(cfg.jwksUrl);
      } catch {
        throw new AuthConfigError("CTGOV_AUTH_JWKS_URL is not a valid URL.");
      }
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new AuthConfigError("CTGOV_AUTH_JWKS_URL must use https (http only for a loopback development issuer).");
      }
      keys = createRemoteJWKSet(url, { cacheMaxAge: 10 * 60_000, cooldownDuration: 30_000 });
    }
    this.keys = keys;
  }

  async verify(token: string): Promise<AuthContext> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.cfg.issuer!,
      audience: this.cfg.audience!,
      algorithms: ALGORITHMS,
      requiredClaims: ["exp", "sub"],
      clockTolerance: 30,
    });
    if (typeof payload.sub !== "string" || !payload.sub.trim()) throw new Error("token has no usable subject");
    const scopes = grantedScopes(payload);
    const missing = (this.cfg.scopes ?? []).filter((s) => !scopes.includes(s));
    if (missing.length) throw new InsufficientScopeError(missing);
    return { subject: payload.sub, claims: payload, scopes };
  }
}

/** Throws AuthConfigError for an unknown provider or incomplete OIDC configuration. */
export function buildVerifier(cfg: AuthConfig, keys?: JWTVerifyGetKey): Verifier | undefined {
  if (!(AUTH_PROVIDERS as readonly string[]).includes(cfg.provider)) {
    throw new AuthConfigError(`Unknown CTGOV_AUTH_PROVIDER '${String(cfg.provider)}'. Use one of: ${AUTH_PROVIDERS.join(", ")}.`);
  }
  return cfg.provider === "none" ? undefined : new OidcVerifier(cfg, keys);
}
