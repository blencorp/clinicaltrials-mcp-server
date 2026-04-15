import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isAnySandboxAvailable } from "../src/sandbox/index.js";
import { startHttpServer } from "../src/server/http.js";

let close: (() => Promise<void>) | undefined;
let base: string;

beforeAll(async () => {
  if (!isAnySandboxAvailable()) return;
  // Configure Clerk adapter against a fake issuer. We never hit JWKS because
  // tests only exercise the "no token" 401 and "obviously-invalid token" paths.
  process.env.CTGOV_AUTH_PROVIDER = "clerk";
  process.env.CTGOV_AUTH_ISSUER = "https://fake.issuer.test";
  process.env.CTGOV_AUTH_RESOURCE = "https://clinicaltrial.mcp.blencorp.com/mcp";
  process.env.CTGOV_AUTH_SCOPES = "ctgov.read";
  process.env.CTGOV_AUTH_JWKS_URL = "https://fake.issuer.test/.well-known/jwks.json";

  const srv = await startHttpServer({ port: 0, host: "127.0.0.1" });
  close = srv.close;
  base = `http://127.0.0.1:${srv.port}`;
});

afterAll(async () => {
  if (close) await close();
  delete process.env.CTGOV_AUTH_PROVIDER;
  delete process.env.CTGOV_AUTH_ISSUER;
  delete process.env.CTGOV_AUTH_RESOURCE;
  delete process.env.CTGOV_AUTH_SCOPES;
  delete process.env.CTGOV_AUTH_JWKS_URL;
});

describe.skipIf(!isAnySandboxAvailable())("HTTP transport (secure mode)", () => {
  it("POST /mcp without Authorization returns 401 with WWW-Authenticate pointing at PRM", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(r.status).toBe(401);
    const wa = r.headers.get("www-authenticate");
    expect(wa).toBeTruthy();
    expect(wa).toContain(`Bearer`);
    expect(wa).toContain(
      `resource_metadata="https://clinicaltrial.mcp.blencorp.com/.well-known/oauth-protected-resource"`,
    );
  });

  it("unknown path still returns 404 even without auth", async () => {
    const r = await fetch(`${base}/nope`);
    expect(r.status).toBe(404);
  });

  it("well-known PRM still readable unauthenticated", async () => {
    const r = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { resource: string; authorization_servers: string[] };
    expect(j.resource).toBe("https://clinicaltrial.mcp.blencorp.com/mcp");
    expect(j.authorization_servers).toEqual(["https://fake.issuer.test"]);
  });
});
