import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import type { KeyLike } from "jose";
import { ClerkAuthAdapter } from "../src/auth/providers/clerk.js";
import { CtGovError } from "../src/supervisor/errors.js";

let jwksServer: Server;
let jwksUrl: string;
let privateKey: KeyLike;
let keyId: string;
const issuer = "https://fake.issuer.test";
const audience = "https://clinicaltrials.mcp.blencorp.com/mcp";

async function signToken(
  claims: Record<string, unknown>,
  opts: { aud?: string | string[]; iss?: string; expiresIn?: string } = {},
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? audience)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  const publicJwk = (await exportJWK(kp.publicKey)) as JWK;
  keyId = "test-key-1";
  (publicJwk as unknown as { kid: string; use: string; alg: string }).kid = keyId;
  (publicJwk as unknown as { kid: string; use: string; alg: string }).use = "sig";
  (publicJwk as unknown as { kid: string; use: string; alg: string }).alg = "RS256";

  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = jwksServer.address() as { port: number };
  jwksUrl = `http://127.0.0.1:${addr.port}/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    jwksServer.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("ClerkAuthAdapter", () => {
  it("accepts a valid token and extracts scopes", async () => {
    const adapter = new ClerkAuthAdapter({ issuer, audience, jwksUrl });
    const token = await signToken({ sub: "user_abc", scope: "ctgov.read openid" });
    const principal = await adapter.verifyAccessToken(token);
    expect(principal.sub).toBe("user_abc");
    expect(principal.scopes).toContain("ctgov.read");
  });

  it("rejects expired tokens", async () => {
    const adapter = new ClerkAuthAdapter({ issuer, audience, jwksUrl, clockToleranceSec: 0 });
    const token = await signToken({ sub: "u" }, { expiresIn: "1s" });
    await new Promise((r) => setTimeout(r, 1100));
    await expect(adapter.verifyAccessToken(token)).rejects.toBeInstanceOf(CtGovError);
  });

  it("rejects tokens with wrong audience", async () => {
    const adapter = new ClerkAuthAdapter({ issuer, audience, jwksUrl });
    const token = await signToken({ sub: "u" }, { aud: "https://other.example/mcp" });
    await expect(adapter.verifyAccessToken(token)).rejects.toBeInstanceOf(CtGovError);
  });

  it("rejects tokens from wrong issuer", async () => {
    const adapter = new ClerkAuthAdapter({ issuer, audience, jwksUrl });
    const token = await signToken({ sub: "u" }, { iss: "https://attacker.example" });
    await expect(adapter.verifyAccessToken(token)).rejects.toBeInstanceOf(CtGovError);
  });

  it("rejects tokens missing `sub`", async () => {
    const adapter = new ClerkAuthAdapter({ issuer, audience, jwksUrl });
    const token = await signToken({});
    await expect(adapter.verifyAccessToken(token)).rejects.toBeInstanceOf(CtGovError);
  });

  it("prefers scp array over scope string", async () => {
    const adapter = new ClerkAuthAdapter({ issuer, audience, jwksUrl });
    const token = await signToken({
      sub: "u",
      scp: ["ctgov.read", "ctgov.admin"],
      scope: "ignored",
    });
    const principal = await adapter.verifyAccessToken(token);
    expect(principal.scopes).toEqual(["ctgov.read", "ctgov.admin"]);
  });
});
