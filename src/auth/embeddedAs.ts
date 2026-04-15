/**
 * Minimal OAuth 2.1 Authorization Server suitable for self-hosted
 * deployments that don't want to run Clerk / WorkOS / Auth0.
 *
 * Scope:
 *   - RFC 7591 Dynamic Client Registration at POST /as/register
 *   - Authorization Code + PKCE (S256 required) at GET /as/authorize
 *   - Token endpoint at POST /as/token (grant_type=authorization_code, refresh_token)
 *   - RFC 8414 Authorization Server Metadata at /.well-known/oauth-authorization-server
 *   - JWKS at /as/jwks.json (RS256)
 *
 * Out of scope (by design for this phase):
 *   - Human login UI. The /authorize endpoint delegates to a pluggable
 *     `userResolver` function. In unit tests we supply an auto-approve resolver;
 *     real self-hosts would wire this to Passkey, Basic Auth, or another
 *     stateless mechanism.
 *   - Token revocation / introspection endpoints (RFC 7009 / RFC 7662).
 *
 * All state is in-memory: this satisfies "session only" caching per the user's
 * phase-1 choice and keeps the embedded AS truly stateless across restarts.
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import {
  calculateJwkThumbprint,
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from "jose";

export interface ResolvedUser {
  sub: string;
  scopes: string[];
  claims?: Record<string, unknown>;
}

export interface UserResolverContext {
  clientId: string;
  redirectUri: string;
  requestedScopes: string[];
  headers: Record<string, string | string[] | undefined>;
}

export type UserResolver = (ctx: UserResolverContext) => Promise<ResolvedUser | null>;

export interface EmbeddedAsOptions {
  issuer: string;
  audience: string;
  scopesSupported: string[];
  /**
   * Optional pre-provisioned RS256 PKCS#8 private key (pem). Useful for
   * stable JWKS across restarts. If omitted, a keypair is generated on boot.
   */
  privateKeyPem?: string;
  /** Resolves the end user during /authorize. */
  userResolver: UserResolver;
  /** Access-token TTL seconds (default 600). */
  accessTokenTtlSec?: number;
  /** Refresh-token TTL seconds (default 7 * 24 * 3600). */
  refreshTokenTtlSec?: number;
}

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  scope: string;
  client_name?: string;
  // No secret — we only accept public clients using PKCE.
}

interface AuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  sub: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAt: number;
  claims?: Record<string, unknown>;
}

interface RefreshTokenRecord {
  token: string;
  clientId: string;
  sub: string;
  scopes: string[];
  expiresAt: number;
}

export interface EmbeddedAsEndpointResult {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** Set when /authorize is returning a 302 redirect. */
  location?: string;
}

export class EmbeddedAs {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly scopesSupported: string[];
  private readonly userResolver: UserResolver;
  private readonly accessTokenTtlSec: number;
  private readonly refreshTokenTtlSec: number;

  private readonly clients = new Map<string, RegisteredClient>();
  private readonly codes = new Map<string, AuthCodeRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();

  private keyPromise: Promise<{ priv: KeyLike; kid: string; jwk: JWK }>;

  constructor(opts: EmbeddedAsOptions) {
    this.issuer = opts.issuer.replace(/\/$/, "");
    this.audience = opts.audience;
    this.scopesSupported = opts.scopesSupported;
    this.userResolver = opts.userResolver;
    this.accessTokenTtlSec = opts.accessTokenTtlSec ?? 600;
    this.refreshTokenTtlSec = opts.refreshTokenTtlSec ?? 7 * 24 * 3600;
    this.keyPromise = this.initKey(opts.privateKeyPem);
  }

  private async initKey(pem?: string): Promise<{ priv: KeyLike; kid: string; jwk: JWK }> {
    let priv: KeyLike;
    let pub: KeyLike;
    if (pem) {
      priv = createPrivateKey(pem) as KeyLike;
      pub = createPublicKey(priv as Parameters<typeof createPublicKey>[0]) as KeyLike;
    } else {
      const kp = await generateKeyPair("RS256");
      priv = kp.privateKey;
      pub = kp.publicKey;
    }
    const jwk = (await exportJWK(pub)) as JWK;
    const kid = await calculateJwkThumbprint(jwk, "sha256");
    (jwk as { kid?: string; use?: string; alg?: string }).kid = kid;
    (jwk as { kid?: string; use?: string; alg?: string }).use = "sig";
    (jwk as { kid?: string; use?: string; alg?: string }).alg = "RS256";
    return { priv, kid, jwk };
  }

  /* ------------------- Endpoints ------------------- */

  /** `.well-known/oauth-authorization-server` */
  metadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/as/authorize`,
      token_endpoint: `${this.issuer}/as/token`,
      registration_endpoint: `${this.issuer}/as/register`,
      jwks_uri: `${this.issuer}/as/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: this.scopesSupported,
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    };
  }

  /** GET /as/jwks.json */
  async jwks(): Promise<{ keys: JWK[] }> {
    const k = await this.keyPromise;
    return { keys: [k.jwk] };
  }

  /** POST /as/register (RFC 7591). Public-client-only; no client_secret. */
  register(body: unknown): EmbeddedAsEndpointResult {
    if (!body || typeof body !== "object") {
      return json(400, { error: "invalid_client_metadata" });
    }
    const meta = body as Record<string, unknown>;
    const redirect = Array.isArray(meta.redirect_uris)
      ? (meta.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string")
      : [];
    if (redirect.length === 0) {
      return json(400, {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris[] required",
      });
    }
    for (const uri of redirect) {
      if (!/^https:\/\//.test(uri) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(uri)) {
        return json(400, {
          error: "invalid_redirect_uri",
          error_description: "must be https:// (localhost allowed)",
        });
      }
    }
    const client: RegisteredClient = {
      client_id: `cid_${randomBytes(16).toString("hex")}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirect,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: (typeof meta.scope === "string" ? meta.scope : undefined) ?? this.scopesSupported.join(" "),
    };
    if (typeof meta.client_name === "string") client.client_name = meta.client_name;
    this.clients.set(client.client_id, client);
    return json(201, client);
  }

  /**
   * GET /as/authorize
   * Handles the OAuth authorization_code + PKCE (S256) redirect flow.
   * `headers` is forwarded to `userResolver` (e.g., for Basic auth).
   */
  async authorize(params: {
    query: Record<string, string>;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<EmbeddedAsEndpointResult> {
    const q = params.query;
    const client = q.client_id ? this.clients.get(q.client_id) : undefined;
    if (!client) return json(400, { error: "invalid_client" });
    const redirect_uri = q.redirect_uri;
    if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
      return json(400, { error: "invalid_redirect_uri" });
    }
    if (q.response_type !== "code") {
      return redirectError(redirect_uri, q.state, "unsupported_response_type");
    }
    if (q.code_challenge_method !== "S256" || !q.code_challenge) {
      return redirectError(redirect_uri, q.state, "invalid_request", "PKCE S256 required");
    }
    const requestedScopes = (q.scope ?? client.scope).split(/\s+/).filter(Boolean);
    const allowed = requestedScopes.filter((s) => this.scopesSupported.includes(s));
    if (allowed.length === 0) {
      return redirectError(redirect_uri, q.state, "invalid_scope");
    }

    const user = await this.userResolver({
      clientId: client.client_id,
      redirectUri: redirect_uri,
      requestedScopes: allowed,
      headers: params.headers,
    });
    if (!user) {
      return { status: 401, body: "authentication required", headers: { "www-authenticate": 'Basic realm="embedded-as"' } };
    }

    const code = randomBytes(32).toString("base64url");
    const rec: AuthCodeRecord = {
      code,
      clientId: client.client_id,
      redirectUri: redirect_uri,
      sub: user.sub,
      scopes: user.scopes.length ? user.scopes.filter((s) => allowed.includes(s)) : allowed,
      codeChallenge: q.code_challenge,
      codeChallengeMethod: "S256",
      expiresAt: Date.now() + 60_000,
    };
    if (user.claims !== undefined) rec.claims = user.claims;
    this.codes.set(code, rec);

    const out = new URL(redirect_uri);
    out.searchParams.set("code", code);
    if (q.state) out.searchParams.set("state", q.state);
    return { status: 302, location: out.toString() };
  }

  /** POST /as/token */
  async token(form: Record<string, string>): Promise<EmbeddedAsEndpointResult> {
    const grant = form.grant_type;
    if (grant === "authorization_code") {
      return this.handleCodeGrant(form);
    }
    if (grant === "refresh_token") {
      return this.handleRefreshGrant(form);
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  private async handleCodeGrant(form: Record<string, string>): Promise<EmbeddedAsEndpointResult> {
    const code = form.code;
    const codeVerifier = form.code_verifier;
    const redirectUri = form.redirect_uri;
    const clientId = form.client_id;
    if (!code || !codeVerifier || !redirectUri || !clientId) {
      return json(400, { error: "invalid_request" });
    }
    const rec = this.codes.get(code);
    if (!rec) return json(400, { error: "invalid_grant" });
    this.codes.delete(code); // single-use
    if (Date.now() > rec.expiresAt) return json(400, { error: "invalid_grant", error_description: "expired" });
    if (rec.clientId !== clientId) return json(400, { error: "invalid_grant" });
    if (rec.redirectUri !== redirectUri) return json(400, { error: "invalid_grant" });

    const expected = base64url(sha256(codeVerifier));
    if (expected !== rec.codeChallenge) {
      return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    }

    return this.issueTokenSet(rec.clientId, rec.sub, rec.scopes, rec.claims);
  }

  private async handleRefreshGrant(form: Record<string, string>): Promise<EmbeddedAsEndpointResult> {
    const refresh = form.refresh_token;
    const clientId = form.client_id;
    if (!refresh || !clientId) return json(400, { error: "invalid_request" });
    const rec = this.refreshTokens.get(refresh);
    if (!rec) return json(400, { error: "invalid_grant" });
    if (rec.clientId !== clientId) return json(400, { error: "invalid_grant" });
    if (Date.now() > rec.expiresAt) {
      this.refreshTokens.delete(refresh);
      return json(400, { error: "invalid_grant" });
    }
    // Rotate
    this.refreshTokens.delete(refresh);
    return this.issueTokenSet(rec.clientId, rec.sub, rec.scopes);
  }

  private async issueTokenSet(
    clientId: string,
    sub: string,
    scopes: string[],
    claims?: Record<string, unknown>,
  ): Promise<EmbeddedAsEndpointResult> {
    const k = await this.keyPromise;
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      sub,
      azp: clientId,
      scope: scopes.join(" "),
    };
    if (claims) Object.assign(payload, claims);

    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: k.kid })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + this.accessTokenTtlSec)
      .setJti(randomUUID())
      .sign(k.priv);

    const refresh = randomBytes(32).toString("base64url");
    this.refreshTokens.set(refresh, {
      token: refresh,
      clientId,
      sub,
      scopes,
      expiresAt: Date.now() + this.refreshTokenTtlSec * 1000,
    });

    return json(200, {
      access_token: jwt,
      token_type: "Bearer",
      expires_in: this.accessTokenTtlSec,
      refresh_token: refresh,
      scope: scopes.join(" "),
    });
  }
}

function json(status: number, body: unknown): EmbeddedAsEndpointResult {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function redirectError(
  redirect: string,
  state: string | undefined,
  error: string,
  description?: string,
): EmbeddedAsEndpointResult {
  const u = new URL(redirect);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return { status: 302, location: u.toString() };
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
