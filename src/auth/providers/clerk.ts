import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import { CtGovError } from "../../supervisor/errors.js";
import type { AuthAdapter, Principal, UpstreamCredential } from "../adapter.js";

export interface ClerkAdapterOptions {
  /**
   * The expected issuer (`iss`) claim. For Clerk this is your Frontend API URL,
   * e.g. "https://clerk.blencorp.com" or "https://<tenant>.clerk.accounts.dev".
   */
  issuer: string;
  /**
   * JWKS URL. Default: `${issuer}/.well-known/jwks.json` (Clerk's standard path).
   */
  jwksUrl?: string;
  /**
   * The `aud` (audience) the token must bind to. Per RFC 8707 this should be
   * our MCP resource identifier, e.g. "https://clinicaltrials.mcp.blencorp.com/mcp".
   */
  audience: string;
  /**
   * Clock skew tolerance in seconds (default 30).
   */
  clockToleranceSec?: number;
}

interface ClerkClaims {
  sub?: string;
  azp?: string;
  scope?: string;
  scp?: string[];
  email?: string;
  org_id?: string;
  aud?: string | string[];
}

export class ClerkAuthAdapter implements AuthAdapter {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly clockToleranceSec: number;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(opts: ClerkAdapterOptions) {
    this.issuer = opts.issuer.replace(/\/$/, "");
    this.audience = opts.audience;
    this.clockToleranceSec = opts.clockToleranceSec ?? 30;
    const url = opts.jwksUrl ?? `${this.issuer}/.well-known/jwks.json`;
    this.jwks = createRemoteJWKSet(new URL(url), {
      cacheMaxAge: 10 * 60_000,
      cooldownDuration: 30_000,
    });
  }

  async verifyAccessToken(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify<ClerkClaims>(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: this.clockToleranceSec,
      });
      if (!payload.sub) {
        throw new CtGovError("POLICY_VIOLATION", "token missing `sub`");
      }
      const scopes = extractScopes(payload);
      const claims: Record<string, unknown> = {};
      if (payload.azp !== undefined) claims.azp = payload.azp;
      if (payload.email !== undefined) claims.email = payload.email;
      if (payload.org_id !== undefined) claims.org_id = payload.org_id;
      const p: Principal = {
        sub: payload.sub,
        scopes,
      };
      if (Object.keys(claims).length > 0) p.claims = claims;
      return p;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new CtGovError("POLICY_VIOLATION", "access token expired", { cause: err });
      }
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        throw new CtGovError(
          "POLICY_VIOLATION",
          `invalid token claim: ${err.claim ?? "unknown"}`,
          { cause: err },
        );
      }
      if (err instanceof joseErrors.JOSEError) {
        throw new CtGovError("POLICY_VIOLATION", `invalid token: ${err.code}`, { cause: err });
      }
      throw err;
    }
  }

  async getUpstreamCredential(
    _principal: Principal,
    audience: string,
  ): Promise<UpstreamCredential | null> {
    // ClinicalTrials.gov is unauthenticated — no credential needed.
    // Future upstreams register their own adapters.
    if (audience === "ctgov") return null;
    return null;
  }
}

function extractScopes(p: ClerkClaims): string[] {
  if (Array.isArray(p.scp)) return p.scp.filter((s) => typeof s === "string");
  if (typeof p.scope === "string") return p.scope.split(/\s+/).filter(Boolean);
  return [];
}
