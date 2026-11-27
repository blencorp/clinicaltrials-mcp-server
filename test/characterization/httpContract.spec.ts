// Characterization: pins the HTTP transport contract (auth challenges, health shape, well-known
// documents, malformed requests, docs-only refusal) and the startup rules of the three hosting
// modes (authenticated, --public-docs, --insecure). Pinned on v1 originally; updated for the SDK v2
// port. test/http-integration.spec.ts
// covers the new security rules (Host, Origin, 405, body cap, auth negatives) and both protocol eras.
import { SERVER_VERSION } from "../../src/server/mcpServer.js";
import { readBuildInfo } from "../../src/server/buildInfo.js";
import { REPOSITORY_URL } from "../../src/project.js";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { startHttpServer, type HttpServerOptions } from "../../src/server/http.js";

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

interface Started {
  base: string;
  host: string;
  close: () => Promise<void>;
}

async function start(opts: HttpServerOptions): Promise<Started> {
  const srv = await startHttpServer({ port: 0, host: "127.0.0.1", ...opts });
  return { base: `http://127.0.0.1:${srv.port}`, host: srv.host, close: srv.close };
}

/** Parses a JSON or single-event SSE body from the Streamable HTTP transport. */
async function rpcBody(r: Response): Promise<any> {
  const text = await r.text();
  const data = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  return JSON.parse(data ?? "null");
}

/** One stateless JSON-RPC call (legacy era: initialize is not needed first). */
async function rpc(base: string, method: string, params: unknown, extra: Record<string, string> = {}): Promise<any> {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
  });
  expect(r.status).toBe(200);
  return rpcBody(r);
}

/** A raw node:http request, so the path and Host header are sent exactly as given. */
function raw(base: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const u = new URL(base);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest(
      { host: u.hostname, port: u.port, path, method: init.method ?? "GET", headers: init.headers ?? {} },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

const AUDIENCE = "https://clinicaltrials.mcp.blencorp.com/mcp";
const challenge = (base: string): string => `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;

describe("authenticated mode: 401/403 challenges and well-known documents", () => {
  let idp: Server;
  let issuer = "";
  let key: CryptoKey;
  let app: Started;

  async function token(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
  }

  beforeAll(async () => {
    const kp = await generateKeyPair("RS256");
    key = kp.privateKey;
    const jwk = { ...((await exportJWK(kp.publicKey)) as JWK), kid: "k1", use: "sig", alg: "RS256" };
    idp = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => idp.listen(0, "127.0.0.1", () => r()));
    issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
    app = await start({
      auth: {
        provider: "clerk",
        issuer,
        audience: AUDIENCE,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        scopes: ["ctgov:read"],
      },
    });
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => idp.close(() => r()));
  });

  it("401 without a bearer token: plain text body and a WWW-Authenticate pointing at the PRM (H1: realm dropped, path-suffixed URL)", async () => {
    const r = await fetch(`${app.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("www-authenticate")).toBe(challenge(app.base));
    expect(await r.text()).toBe("missing bearer token");
  });

  it("401 for a garbage bearer token (H1: the challenge adds error=\"invalid_token\", RFC 6750)", async () => {
    const r = await fetch(`${app.base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: "Bearer not-a-jwt" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`${challenge(app.base)}, error="invalid_token"`);
    expect(await r.text()).toBe("invalid bearer token");
  });

  it("403 insufficient_scope when the token lacks ctgov:read, advertising the required scope (H2: scope string)", async () => {
    const t = await token({ sub: "alice", scope: "openid profile" });
    const r = await fetch(`${app.base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${t}` }, body: "{}" });
    expect(r.status).toBe(403);
    expect(r.headers.get("www-authenticate")).toBe(`${challenge(app.base)}, error="insufficient_scope", scope="ctgov:read"`);
    expect(await r.text()).toBe("insufficient scope");
  });

  it("accepts a token with ctgov:read and serves all three tools; the * wildcard no longer grants anything (H3)", async () => {
    const auth = { authorization: `Bearer ${await token({ sub: "alice", scope: "ctgov:read" })}` };
    const out = await rpc(app.base, "tools/list", {}, auth);
    expect(out.result.tools.map((t: { name: string }) => t.name)).toEqual(["search_api", "describe_schema", "execute"]);
    const wildcard = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${await token({ sub: "alice", scope: "*" })}` },
      body: "{}",
    });
    expect(wildcard.status).toBe(403);
  });

  it("serves the PRM unauthenticated, exactly (H4: resource derives from the listener, new name/docs fields)", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await fetch(`${app.base}${path}`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        resource: `${app.base}/mcp`,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: ["ctgov:read"],
        resource_documentation: `${REPOSITORY_URL}#readme`,
        resource_policy_uri: `${REPOSITORY_URL}/blob/main/legal/terms.md`,
        resource_name: "ClinicalTrials.gov MCP",
      });
    }
  });

  it("no longer proxies the issuer's AS metadata (H5): clients read it from the issuer named in the PRM", async () => {
    expect((await fetch(`${app.base}/.well-known/oauth-authorization-server`)).status).toBe(404);
  });

  it("answers a GET, DELETE or PUT on /mcp with 405 and Allow: POST, OPTIONS (H6: was 405 only for other verbs; GET/DELETE served sessions)", async () => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const r = await fetch(`${app.base}/mcp`, { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.get("allow")).toBe("POST, OPTIONS");
    }
  });

  it("/health is exempt from auth and reports no executor or provider (H7: /healthz and /readyz are gone)", async () => {
    expect((await fetch(`${app.base}/healthz`)).status).toBe(404);
    expect((await fetch(`${app.base}/readyz`)).status).toBe(404);
  });

  it("/health answers without a token with the version and commit (OIDC mode)", async () => {
    const r = await fetch(`${app.base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok", protocol: "2026-07-28", version: SERVER_VERSION, commit: null });
  });
});

describe.each([
  { label: "--public-docs", opts: { publicDocs: true } },
  { label: "--insecure", opts: { insecure: true } },
] as const)("unauthenticated $label mode", ({ opts }) => {
  let app: Started;
  beforeAll(async () => {
    app = await start(opts);
  });
  afterAll(async () => {
    await app.close();
  });

  it("/health is {status, version, protocol} with no-store caching and an x-trace-id (H7: timestamp replaced)", async () => {
    const r = await fetch(`${app.base}/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-trace-id")).toMatch(/^[0-9a-f-]{36}$/);
    // The commit is the platform's (none in a local run); `commit` was added to the pin on purpose.
    expect(await r.json()).toEqual({ status: "ok", protocol: "2026-07-28", version: SERVER_VERSION, commit: null });
  });

  it("/health reports the commit read from the platform environment at startup, never one a request supplies", async () => {
    const sha = "a".repeat(40);
    const stamped = await start({ ...opts, buildInfo: readBuildInfo({ RAILWAY_GIT_COMMIT_SHA: sha }) });
    try {
      const r = await fetch(`${stamped.base}/health`, { headers: { "x-railway-git-commit-sha": "b".repeat(40), "x-commit": "c".repeat(40) } });
      expect(await r.json()).toEqual({ status: "ok", protocol: "2026-07-28", version: SERVER_VERSION, commit: sha });
    } finally {
      await stamped.close();
    }
  });

  it("/healthz and /readyz are removed (H7)", async () => {
    expect((await fetch(`${app.base}/healthz`)).status).toBe(404);
    expect((await fetch(`${app.base}/readyz`)).status).toBe(404);
  });

  it("the protected-resource document is 404 when nothing is protected", async () => {
    const prm = await fetch(`${app.base}/.well-known/oauth-protected-resource`);
    expect(prm.status).toBe(404);
    expect(await prm.json()).toEqual({ error: "no protected resource configured" });
  });

  it("/mcp needs no token; unknown paths are a JSON 404", async () => {
    const out = await rpc(app.base, "tools/list", {});
    expect(out.result.tools.length).toBeGreaterThan(0);
    const r = await fetch(`${app.base}/nope`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found", path: "/nope" });
  });

  it("400 'bad request' for a request target that is not a valid URL", async () => {
    const r = await raw(app.base, "//");
    expect(r.status).toBe(400);
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(r.body).toBe("bad request");
    // A protocol-relative target with a host parses, and routes on "/" (not on the smuggled host).
    const evil = await raw(app.base, "//evil.txt");
    expect(evil.status).toBe(404);
    expect(JSON.parse(evil.body)).toEqual({ error: "not_found", path: "/" });
  });

  it("serves no authorization server endpoints (the embedded AS is removed)", async () => {
    for (const [method, path] of [["POST", "/as/register"], ["GET", "/as/jwks.json"]] as const) {
      const r = await raw(app.base, path, { method });
      expect(r.status, path).toBe(404);
    }
  });
});

describe("--public-docs tool surface over HTTP", () => {
  let app: Started;
  beforeAll(async () => {
    app = await start({ publicDocs: true });
  });
  afterAll(async () => {
    await app.close();
  });

  it("lists exactly search_api and describe_schema", async () => {
    const out = await rpc(app.base, "tools/list", {});
    expect(out.result.tools.map((t: { name: string }) => t.name)).toEqual(["search_api", "describe_schema"]);
  });

  it("refuses execute as an unknown tool: JSON-RPC -32602 (D1; was an isError result)", async () => {
    const r = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "execute", arguments: { code: "return 1" } } }),
    });
    const out = await rpcBody(r);
    expect(out.result).toBeUndefined();
    expect(out.error).toMatchObject({ code: -32602, message: expect.stringContaining("Tool execute not found") });
  });
});

describe("startup rules", () => {
  const oidc = { provider: "generic-oidc", issuer: "https://idp.example", audience: "https://x/mcp", jwksUrl: "https://idp.example/jwks" } as const;

  it("--insecure and --public-docs are mutually exclusive", async () => {
    await expect(start({ insecure: true, publicDocs: true })).rejects.toThrow("--insecure and --public-docs are mutually exclusive");
  });

  it("plain --http without auth configuration refuses to start", async () => {
    await expect(start({})).rejects.toThrow(/^HTTP transport requires auth configuration\. Set CTGOV_AUTH_PROVIDER/);
  });

  it("an unknown auth provider refuses to start (v1 treated 'embedded' and unknown names as a provider)", async () => {
    await expect(start({ auth: { provider: "embedded" as never } })).rejects.toThrow(/Unknown CTGOV_AUTH_PROVIDER 'embedded'/);
  });

  it("an auth provider without an issuer, audience or JWKS refuses to start (A1)", async () => {
    await expect(start({ auth: { provider: "clerk" } })).rejects.toThrow("CTGOV_AUTH_ISSUER is required");
    await expect(start({ auth: { provider: "clerk", issuer: "https://i" } })).rejects.toThrow("CTGOV_AUTH_AUDIENCE is required");
    await expect(start({ auth: { provider: "clerk", issuer: "https://i", audience: "a" } })).rejects.toThrow("CTGOV_AUTH_JWKS_URL is required");
    await expect(start({ auth: { ...oidc, jwksUrl: "http://idp.example/jwks" } })).rejects.toThrow("must use https");
  });

  it("authenticated serving refuses the isolate sandbox", async () => {
    await expect(start({ auth: oidc, sandboxMode: "isolate" })).rejects.toThrow(
      /the isolate sandbox \(--sandbox isolate \/ CTGOV_SANDBOX=isolate\) is not allowed for authenticated HTTP serving; use deno/,
    );
  });

  it("--public-docs and --insecure with any configured auth provider are startup errors (agreed change 1; v1 silently ignored it)", async () => {
    for (const flags of [{ publicDocs: true }, { insecure: true }] as const) {
      await expect(start({ ...flags, auth: oidc })).rejects.toThrow(/cannot be combined with CTGOV_AUTH_PROVIDER=generic-oidc/);
    }
  });

  it("--insecure keeps the loopback address it is given; a non-loopback bind needs the trusted hosts (A2)", async () => {
    const app = await start({ insecure: true });
    try {
      expect(app.host).toBe("127.0.0.1");
    } finally {
      await app.close();
    }
    await expect(start({ insecure: true, host: "0.0.0.0" })).rejects.toThrow(/needs the hostnames clients use/);
    await expect(start({ publicDocs: true, host: "0.0.0.0" })).rejects.toThrow(/needs the hostnames clients use/);
    const open = await start({ insecure: true, host: "0.0.0.0", allowedHosts: ["mcp.example.com"] });
    await open.close();
  });

  it("authenticated serving beyond loopback needs CTGOV_PUBLIC_ORIGIN, not just allowed hosts (A2)", async () => {
    await expect(start({ auth: oidc, host: "0.0.0.0", allowedHosts: ["mcp.example.com"] })).rejects.toThrow(/needs CTGOV_PUBLIC_ORIGIN/);
  });
});
