import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { isAnySandboxAvailable } from "../src/sandbox/index.js";
import { startHttpServer } from "../src/server/http.js";

function b64u(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pkcePair() {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

let close: (() => Promise<void>) | undefined;
let base: string;

beforeAll(async () => {
  if (!isAnySandboxAvailable()) return;
  // Discover an available port by opening and closing a short-lived net server.
  const net = await import("node:net");
  const port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address() as { port: number };
      const p = addr.port;
      s.close(() => resolve(p));
    });
  });

  const origin = `http://127.0.0.1:${port}`;
  process.env.CTGOV_AUTH_PROVIDER = "embedded";
  process.env.CTGOV_AUTH_SCOPES = "ctgov.read";
  process.env.CTGOV_EMBEDDED_USERS = "alice:wonderland";
  process.env.CTGOV_AUTH_ISSUER = origin;
  process.env.CTGOV_AUTH_RESOURCE = `${origin}/mcp`;

  const srv = await startHttpServer({ port, host: "127.0.0.1" });
  close = srv.close;
  base = origin;
});

afterAll(async () => {
  if (close) await close();
  delete process.env.CTGOV_AUTH_PROVIDER;
  delete process.env.CTGOV_AUTH_SCOPES;
  delete process.env.CTGOV_AUTH_ISSUER;
  delete process.env.CTGOV_AUTH_RESOURCE;
  delete process.env.CTGOV_EMBEDDED_USERS;
});

describe.skipIf(!isAnySandboxAvailable())("embedded AS end-to-end", () => {
  it("/.well-known/oauth-authorization-server returns embedded metadata", async () => {
    const r = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(r.status).toBe(200);
    const md = (await r.json()) as Record<string, unknown>;
    expect(md.issuer).toBe(base);
    expect((md.code_challenge_methods_supported as string[]).includes("S256")).toBe(true);
  });

  it("full DCR → authorize → token → MCP initialize flow", async () => {
    // 1. Dynamic Client Registration
    const redirectUri = `${base}/cb`;
    const regResp = await fetch(`${base}/as/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: "Test Client",
      }),
    });
    expect(regResp.status).toBe(201);
    const reg = (await regResp.json()) as { client_id: string };

    // 2. Authorize — follow redirects manually (302 expected).
    const { verifier, challenge } = pkcePair();
    const authUrl = new URL(`${base}/as/authorize`);
    authUrl.searchParams.set("client_id", reg.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("scope", "ctgov.read");
    authUrl.searchParams.set("state", "abc");

    const authResp = await fetch(authUrl, {
      redirect: "manual",
      headers: {
        authorization: "Basic " + Buffer.from("alice:wonderland").toString("base64"),
      },
    });
    expect([302, 303]).toContain(authResp.status);
    const location = authResp.headers.get("location")!;
    const redirect = new URL(location);
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    // 3. Token exchange
    const tokResp = await fetch(`${base}/as/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: reg.client_id,
      }).toString(),
    });
    expect(tokResp.status).toBe(200);
    const token = (await tokResp.json()) as { access_token: string };
    expect(token.access_token.split(".")).toHaveLength(3);

    // 4. MCP call with bearer — should initialize successfully.
    const initResp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "e2e", version: "0" },
        },
      }),
    });
    expect(initResp.status).toBe(200);
    const sessionId = initResp.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
  });
});
