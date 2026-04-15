/**
 * Pluggable auth interface used by both the HTTP transport (phase 7) and the
 * supervisor when calling downstream authenticated APIs (future adapters).
 * Phase 1 only ships the interface and a `NoopAuthAdapter`.
 */

export interface Principal {
  /** Stable subject identifier (OAuth `sub`). */
  sub: string;
  /** Granted scopes. */
  scopes: string[];
  /** Free-form claims propagated from the AS (e.g., email, org id). */
  claims?: Record<string, unknown>;
}

export interface UpstreamCredential {
  header?: Record<string, string>;
  query?: Record<string, string>;
}

export interface AuthAdapter {
  /** Validate an incoming bearer token. Throws on invalid. */
  verifyAccessToken(token: string): Promise<Principal>;
  /**
   * Resolve credentials for an outbound upstream call, per subject.
   * `audience` identifies which upstream (e.g., "ctgov", "fda-openfda").
   * Returning `null` means no credential is needed.
   */
  getUpstreamCredential(
    principal: Principal,
    audience: string,
  ): Promise<UpstreamCredential | null>;
}

export class NoopAuthAdapter implements AuthAdapter {
  async verifyAccessToken(_token: string): Promise<Principal> {
    throw new Error("NoopAuthAdapter cannot verify tokens — wire a real adapter");
  }

  async getUpstreamCredential(
    _principal: Principal,
    _audience: string,
  ): Promise<UpstreamCredential | null> {
    return null;
  }
}
