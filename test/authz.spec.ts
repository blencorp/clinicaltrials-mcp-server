import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import {
  AuthConfigError,
  InsufficientScopeError,
  OidcVerifier,
  buildVerifier,
  grantedScopes,
} from "../src/server/authz.js";

const ISSUER = "https://issuer.test";
const AUDIENCE = "https://ctgov.test/mcp";

async function fixture() {
  const pair = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, alg = "ES256") =>
    new SignJWT({ scope: "ctgov:read", ...claims })
      .setProtectedHeader({ alg, kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("alice")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey);
  return { keys, sign };
}

describe("grantedScopes", () => {
  it("reads a space-delimited scope or an scp array", () => {
    expect(grantedScopes({ scope: "a b  c" })).toEqual(["a", "b", "c"]);
    expect(grantedScopes({ scp: ["a", "b", 3 as never] })).toEqual(["a", "b"]);
    expect(grantedScopes({})).toEqual([]);
  });
});

describe("OidcVerifier scopes", () => {
  it("requires EVERY configured scope, not any one of them", async () => {
    const { keys, sign } = await fixture();
    const v = new OidcVerifier({ provider: "generic-oidc", issuer: ISSUER, audience: AUDIENCE, scopes: ["ctgov:read", "ctgov:extra"] }, keys);
    await expect(v.verify(await sign({ scope: "ctgov:read" }))).rejects.toMatchObject({ required: ["ctgov:extra"] });
    await expect(v.verify(await sign({ scope: "ctgov:read ctgov:extra" }))).resolves.toMatchObject({ subject: "alice" });
  });

  it("accepts the scp array form", async () => {
    const { keys, sign } = await fixture();
    const v = new OidcVerifier({ provider: "clerk", issuer: ISSUER, audience: AUDIENCE, scopes: ["ctgov:read"] }, keys);
    await expect(v.verify(await sign({ scope: undefined, scp: ["ctgov:read"] }))).resolves.toMatchObject({ scopes: ["ctgov:read"] });
  });

  it("treats the old ctgov.read spelling and the * wildcard as missing scopes", async () => {
    const { keys, sign } = await fixture();
    const v = new OidcVerifier({ provider: "clerk", issuer: ISSUER, audience: AUDIENCE, scopes: ["ctgov:read"] }, keys);
    for (const scope of ["ctgov.read", "*"]) {
      await expect(v.verify(await sign({ scope }))).rejects.toBeInstanceOf(InsufficientScopeError);
    }
  });
});

describe("OidcVerifier algorithms", () => {
  it("refuses a symmetric (HS256) token even when the signature is valid for a shared secret", async () => {
    const { keys } = await fixture();
    const v = new OidcVerifier({ provider: "generic-oidc", issuer: ISSUER, audience: AUDIENCE, scopes: ["ctgov:read"] }, keys);
    const secret = new TextEncoder().encode("x".repeat(48));
    const token = await new SignJWT({ scope: "ctgov:read" })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("alice")
      .setExpirationTime("5m")
      .sign(secret);
    await expect(v.verify(token)).rejects.toThrow();
  });
});

describe("OidcVerifier algorithm allowlist", () => {
  it("refuses HS256 even when the key set offers a symmetric key that would verify it (jose also refuses symmetric algs for key sets; the allowlist is the second layer)", async () => {
    const secret = new TextEncoder().encode("x".repeat(48));
    const keys = createLocalJWKSet({ keys: [{ kty: "oct", kid: "k1", k: Buffer.from(secret).toString("base64url") }] });
    const v = new OidcVerifier({ provider: "generic-oidc", issuer: ISSUER, audience: AUDIENCE, scopes: ["ctgov:read"] }, keys);
    const token = await new SignJWT({ scope: "ctgov:read" })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("alice")
      .setExpirationTime("5m")
      .sign(secret);
    await expect(v.verify(token)).rejects.toThrow(/alg/i);
  });
});

describe("buildVerifier configuration", () => {
  it("is undefined for provider none and throws for an unknown provider", () => {
    expect(buildVerifier({ provider: "none" })).toBeUndefined();
    expect(() => buildVerifier({ provider: "embedded" as never })).toThrow(AuthConfigError);
  });

  it("requires issuer, audience and an https JWKS (http only on loopback)", () => {
    const base = { provider: "auth0", issuer: ISSUER, audience: AUDIENCE } as const;
    expect(() => buildVerifier({ ...base, issuer: undefined as never, jwksUrl: "https://x/j" })).toThrow(/ISSUER/);
    expect(() => buildVerifier({ ...base, audience: undefined as never, jwksUrl: "https://x/j" })).toThrow(/AUDIENCE/);
    expect(() => buildVerifier(base)).toThrow(/JWKS_URL is required/);
    expect(() => buildVerifier({ ...base, jwksUrl: "http://idp.example/j" })).toThrow(/https/);
    expect(() => buildVerifier({ ...base, jwksUrl: "not a url" })).toThrow(/not a valid URL/);
    expect(buildVerifier({ ...base, jwksUrl: "https://idp.example/j" })).toBeDefined();
    expect(buildVerifier({ ...base, jwksUrl: "http://127.0.0.1:9/j" })).toBeDefined();
  });
});
