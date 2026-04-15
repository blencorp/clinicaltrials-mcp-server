import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, createRemoteJWKSet, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { EmbeddedAs } from "../src/auth/embeddedAs.js";
import { createServer, type Server } from "node:http";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function mkAs() {
  const issuer = "https://embedded.test";
  const audience = "https://mcp.embedded.test/mcp";
  const as = new EmbeddedAs({
    issuer,
    audience,
    scopesSupported: ["ctgov.read"],
    userResolver: async (ctx) => ({
      sub: "user_123",
      scopes: ctx.requestedScopes,
      claims: { org_id: "org_blen" },
    }),
  });
  return { as, issuer, audience };
}

describe("EmbeddedAs", () => {
  it("registers a public client (RFC 7591)", async () => {
    const { as } = await mkAs();
    const resp = as.register({
      redirect_uris: ["https://claude.ai/callback"],
      client_name: "Claude",
    });
    expect(resp.status).toBe(201);
    const body = JSON.parse(resp.body!) as { client_id: string; redirect_uris: string[] };
    expect(body.client_id).toMatch(/^cid_/);
    expect(body.redirect_uris).toEqual(["https://claude.ai/callback"]);
  });

  it("rejects non-https redirect_uris", async () => {
    const { as } = await mkAs();
    const resp = as.register({ redirect_uris: ["http://evil.example/cb"] });
    expect(resp.status).toBe(400);
  });

  it("runs a complete authorization_code + PKCE flow", async () => {
    const { as, issuer, audience } = await mkAs();
    const reg = JSON.parse(as.register({ redirect_uris: ["https://claude.ai/callback"] }).body!) as {
      client_id: string;
    };
    const { verifier, challenge } = pkcePair();
    const auth = await as.authorize({
      query: {
        client_id: reg.client_id,
        redirect_uri: "https://claude.ai/callback",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "ctgov.read",
        state: "xyz",
      },
      headers: {},
    });
    expect(auth.status).toBe(302);
    const location = new URL(auth.location!);
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("xyz");

    const tok = await as.token({
      grant_type: "authorization_code",
      code: code!,
      code_verifier: verifier,
      redirect_uri: "https://claude.ai/callback",
      client_id: reg.client_id,
    });
    expect(tok.status).toBe(200);
    const tokenSet = JSON.parse(tok.body!) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(tokenSet.access_token.split(".")).toHaveLength(3);

    // Verify the issued JWT with our own JWKS (served by a tiny HTTP server).
    const jwks = await as.jwks();
    let jwksServer: Server;
    const url = await new Promise<string>((resolve) => {
      jwksServer = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(jwks));
      });
      jwksServer.listen(0, "127.0.0.1", () => {
        const addr = jwksServer.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}/jwks.json`);
      });
    });
    try {
      const jwksFn = createRemoteJWKSet(new URL(url));
      const { payload } = await jwtVerify(tokenSet.access_token, jwksFn, {
        issuer,
        audience,
      });
      expect(payload.sub).toBe("user_123");
      expect(payload.scope).toBe("ctgov.read");
      expect((payload as { org_id?: string }).org_id).toBe("org_blen");
    } finally {
      await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    }

    // Refresh flow
    const refresh = await as.token({
      grant_type: "refresh_token",
      refresh_token: tokenSet.refresh_token,
      client_id: reg.client_id,
    });
    expect(refresh.status).toBe(200);
    const refreshed = JSON.parse(refresh.body!) as { access_token: string; refresh_token: string };
    expect(refreshed.access_token).not.toBe(tokenSet.access_token);
    // Rotation: original refresh token is invalidated
    const replay = await as.token({
      grant_type: "refresh_token",
      refresh_token: tokenSet.refresh_token,
      client_id: reg.client_id,
    });
    expect(replay.status).toBe(400);
  });

  it("rejects PKCE verification failures", async () => {
    const { as } = await mkAs();
    const reg = JSON.parse(as.register({ redirect_uris: ["https://claude.ai/callback"] }).body!) as {
      client_id: string;
    };
    const { challenge } = pkcePair();
    const auth = await as.authorize({
      query: {
        client_id: reg.client_id,
        redirect_uri: "https://claude.ai/callback",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "ctgov.read",
      },
      headers: {},
    });
    const code = new URL(auth.location!).searchParams.get("code")!;

    const tok = await as.token({
      grant_type: "authorization_code",
      code,
      code_verifier: "wrong-verifier",
      redirect_uri: "https://claude.ai/callback",
      client_id: reg.client_id,
    });
    expect(tok.status).toBe(400);
    expect(JSON.parse(tok.body!)).toMatchObject({ error: "invalid_grant" });
  });

  it("requires S256 (plain code_challenge_method rejected)", async () => {
    const { as } = await mkAs();
    const reg = JSON.parse(as.register({ redirect_uris: ["https://claude.ai/callback"] }).body!) as {
      client_id: string;
    };
    const auth = await as.authorize({
      query: {
        client_id: reg.client_id,
        redirect_uri: "https://claude.ai/callback",
        response_type: "code",
        code_challenge: "whatever",
        code_challenge_method: "plain",
        scope: "ctgov.read",
      },
      headers: {},
    });
    expect(auth.status).toBe(302);
    expect(new URL(auth.location!).searchParams.get("error")).toBe("invalid_request");
  });

  it("metadata advertises required fields", async () => {
    const { as, issuer } = await mkAs();
    const md = as.metadata();
    expect(md.issuer).toBe(issuer);
    expect((md.code_challenge_methods_supported as string[]).includes("S256")).toBe(true);
    expect(md.authorization_endpoint).toContain("/as/authorize");
    expect(md.token_endpoint).toContain("/as/token");
    expect(md.registration_endpoint).toContain("/as/register");
  });

  it("reuses the configured signing key across restarts", async () => {
    const kp = await generateKeyPair("RS256");
    const privateKeyPem = await exportPKCS8(kp.privateKey);
    const issuer = "https://embedded.test";
    const audience = "https://mcp.embedded.test/mcp";
    const mkStableAs = () =>
      new EmbeddedAs({
        issuer,
        audience,
        scopesSupported: ["ctgov.read"],
        privateKeyPem,
        userResolver: async (ctx) => ({
          sub: "user_123",
          scopes: ctx.requestedScopes,
        }),
      });

    const as1 = mkStableAs();
    const as2 = mkStableAs();

    expect(await as1.jwks()).toEqual(await as2.jwks());

    const reg = JSON.parse(as1.register({ redirect_uris: ["https://claude.ai/callback"] }).body!) as {
      client_id: string;
    };
    const { verifier, challenge } = pkcePair();
    const auth = await as1.authorize({
      query: {
        client_id: reg.client_id,
        redirect_uri: "https://claude.ai/callback",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "ctgov.read",
      },
      headers: {},
    });
    const code = new URL(auth.location!).searchParams.get("code")!;
    const tok = await as1.token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "https://claude.ai/callback",
      client_id: reg.client_id,
    });
    const tokenSet = JSON.parse(tok.body!) as { access_token: string };

    const { payload } = await jwtVerify(tokenSet.access_token, createLocalJWKSet(await as2.jwks()), {
      issuer,
      audience,
    });
    expect(payload.sub).toBe("user_123");
  });
});
