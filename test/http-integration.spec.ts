// The HTTP transport end to end: both protocol eras (modern `_meta` + Mcp-Method/Mcp-Name routing
// headers, and the legacy `initialize` handshake), the stateless/no-session contract, Host and
// Origin rules, CORS, 405s, the body cap, the per-IP limiter and the bearer-token negatives
// (real ES256 tokens verified against a local JWKS over loopback HTTP).
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { startHttpServer, MAX_REQUEST_BODY_BYTES, type HttpHandle, type HttpServerOptions } from "../src/server/http.js";
import { MCP_PROTOCOL_VERSION } from "../src/server/mcpServer.js";
import { constantUpstream, type FakeUpstream } from "./characterization/helpers.js";

const PROTOCOL_VERSION = "2026-07-28";

function parseBody(text: string, contentType: string): any {
  if (!text) return undefined;
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:") && line.slice(5).trim()) return JSON.parse(line.slice(5).trim());
    }
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: parseBody(text, r.headers.get("content-type") ?? ""), raw: text };
}

/** The `_meta` envelope the 2026-07-28 revision requires on every request. */
const meta = () => ({
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "it", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

/** One self-contained modern request: no handshake, routing headers mirrored from the body. */
function rpc(
  target: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: { id?: number; headers?: Record<string, string> } = {},
) {
  const name = params.name as string | undefined;
  return post(
    `${target}/mcp`,
    { jsonrpc: "2.0", id: opts.id ?? 1, method, params: { ...params, _meta: meta() } },
    { "mcp-protocol-version": PROTOCOL_VERSION, "mcp-method": method, ...(name ? { "mcp-name": name } : {}), ...opts.headers },
  );
}

/** A raw node:http request, so Host, path and headers are sent exactly as given (fetch cannot set Host). */
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

async function serve(opts: HttpServerOptions) {
  const h: HttpHandle = await startHttpServer({ port: 0, host: "127.0.0.1", ipRps: 1000, ipBurst: 1000, ...opts });
  return { h, base: `http://127.0.0.1:${h.port}` };
}

describe("anonymous endpoint (--insecure) in both protocol eras", () => {
  let h: HttpHandle;
  let base = "";
  let upstream: FakeUpstream;

  beforeAll(async () => {
    upstream = constantUpstream({ apiVersion: "2.0.0" });
    ({ h, base } = await serve({ insecure: true, dispatcher: upstream.agent }));
  });
  afterAll(async () => {
    await h.close();
    await upstream.close();
  });

  it("serves /health with the modern protocol revision, never the SDK's legacy LATEST_PROTOCOL_VERSION", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { status: string; version: string; protocol: string };
    expect(j).toMatchObject({ status: "ok", protocol: "2026-07-28" });
    expect(j.protocol).toBe(MCP_PROTOCOL_VERSION);
  });

  it("modern era: tools/list in one stateless request, with titles, outputSchemas, cache hints and no session", async () => {
    const r = await rpc(base, "tools/list");
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    const result = r.body.result as { tools: Array<Record<string, any>>; ttlMs: number; cacheScope: string };
    expect(result.tools.map((t) => t.name)).toEqual(["search_api", "describe_schema", "execute"]);
    for (const t of result.tools) {
      expect(t.title).toBeTruthy();
      expect(t.outputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.annotations.readOnlyHint).toBe(true);
    }
    expect(result.ttlMs).toBe(300_000);
    expect(result.cacheScope).toBe("public");
  });

  it("modern era: server/discover names the server and the supported revision", async () => {
    const r = await rpc(base, "server/discover");
    expect(r.status).toBe(200);
    expect(r.body.result.supportedVersions).toContain(PROTOCOL_VERSION);
    expect(r.body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("clinicaltrial-mcp-server");
  });

  it("modern era: a search_api call returns compact JSON text and structuredContent", async () => {
    const r = await rpc(base, "tools/call", { name: "search_api", arguments: { query: "recruiting studies by condition", k: 2 } });
    expect(r.status).toBe(200);
    const res = r.body.result;
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.hits).toBe(2);
    expect(res.content[0].text).toBe(JSON.stringify(res.structuredContent));
  });

  it("modern era: an unknown tool is a JSON-RPC -32602 error, not an isError result", async () => {
    const r = await rpc(base, "tools/call", { name: "no_such_tool", arguments: {} });
    expect(r.status).toBe(200);
    expect(r.body.result).toBeUndefined();
    expect(r.body.error.code).toBe(-32602);
    expect(r.body.error.message).toMatch(/not found/i);
  });

  it("modern era: unknown argument keys are rejected (schemas are additionalProperties:false)", async () => {
    const r = await rpc(base, "tools/call", { name: "search_api", arguments: { query: "x", bogus: 1 } });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toMatch(/must NOT have additional properties/);
  });

  it("modern era: Mcp-Name that disagrees with the body is -32020; a missing Mcp-Method is rejected", async () => {
    const mismatch = await rpc(base, "tools/call", { name: "search_api", arguments: { query: "x" } }, { headers: { "mcp-name": "describe_schema" } });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe(-32020);
    const missing = await post(
      `${base}/mcp`,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } },
      { "mcp-protocol-version": PROTOCOL_VERSION },
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe(-32020);
  });

  it("legacy era: initialize and tools/list work for a pre-2026 client, and no session is ever issued", async () => {
    const init = await post(`${base}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "0" } },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.protocolVersion).toBeDefined();
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const list = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(["search_api", "describe_schema", "execute"]);
  });

  it("legacy era: an old session id header is ignored rather than honoured", async () => {
    const list = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": "stale-session" });
    expect(list.status).toBe(200);
    expect(list.headers.get("mcp-session-id")).toBeNull();
  });

  it("answers GET and DELETE on /mcp with 405 (there is no session stream or session to end)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const r = await fetch(`${base}/mcp`, { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.get("allow")).toBe("POST, OPTIONS");
    }
  });

  it("refuses a body over 1 MiB with 413", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(MAX_REQUEST_BODY_BYTES) } });
    const r = await post(`${base}/mcp`, big);
    expect(r.status).toBe(413);
    // ...while a body just under the cap is parsed (and answered, not rejected for size).
    const ok = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(MAX_REQUEST_BODY_BYTES - 1024) } });
    expect(ok.status).not.toBe(413);
  });

  it("refuses an oversized body while it is still arriving", async () => {
    // Announce 2 MiB but send only a little and never finish: a server that buffers the whole body
    // before checking would wait forever; the cap must answer 413 from the length alone.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": String(2 * 1024 * 1024) },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); req.destroy(); });
      req.on("error", (err) => { if (!(err as NodeJS.ErrnoException).code?.startsWith("ECONNRESET")) reject(err); });
      req.write('{"jsonrpc":"2.0"');
      setTimeout(() => reject(new Error("no response before the body finished")), 5000).unref();
    });
    expect(status).toBe(413);
  });

  it("refuses long-lived subscriptions/listen streams (maxSubscriptions 0)", async () => {
    const r = await rpc(base, "subscriptions/listen", { notifications: { toolsListChanged: true } });
    expect(r.body?.error ?? r.status).toBeTruthy();
    expect(r.body?.result).toBeUndefined();
  });
});

describe("Host validation (DNS rebinding)", () => {
  let h: HttpHandle;
  let base = "";
  beforeAll(async () => {
    ({ h, base } = await serve({ publicDocs: true, publicOrigin: "https://ctgov.example.com", allowedHosts: ["alias.example.com"] }));
  });
  afterAll(async () => {
    await h.close();
  });

  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } });
  const mcp = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  it("rejects a foreign Host with 421, even when Origin matches it", async () => {
    const r = await raw(base, "/mcp", { method: "POST", headers: { host: "attacker.example", origin: "http://attacker.example", ...mcp }, body });
    expect(r.status).toBe(421);
    expect(JSON.parse(r.body)).toEqual({ error: "host_not_allowed" });
  });

  it("accepts the configured public host, an allowed host and loopback on the listening port", async () => {
    for (const host of ["ctgov.example.com", "alias.example.com", `127.0.0.1:${h.port}`, `localhost:${h.port}`]) {
      const r = await raw(base, "/mcp", { method: "POST", headers: { host, ...mcp, "mcp-protocol-version": PROTOCOL_VERSION, "mcp-method": "tools/list" }, body });
      expect(r.status, host).toBe(200);
    }
  });

  it("does not trust the request's own Host: loopback on ANOTHER port is refused", async () => {
    const r = await raw(base, "/mcp", { method: "POST", headers: { host: `127.0.0.1:${h.port + 1}`, ...mcp }, body });
    expect(r.status).toBe(421);
  });

  it("exempts only GET /health, which answers any Host", async () => {
    expect((await raw(base, "/health", { headers: { host: "healthcheck.railway.app" } })).status).toBe(200);
    expect((await raw(base, "/health", { method: "POST", headers: { host: "healthcheck.railway.app" } })).status).toBe(421);
    expect((await raw(base, "/nope", { headers: { host: "attacker.example" } })).status).toBe(421);
  });

  it("checks the Host on the well-known documents too", async () => {
    const r = await raw(base, "/.well-known/oauth-protected-resource", { headers: { host: "attacker.example" } });
    expect(r.status).toBe(421);
  });
});

describe("Origin rules: validated on the anonymous endpoint only", () => {
  let anon: HttpHandle;
  let anonBase = "";
  let secured: HttpHandle;
  let securedBase = "";
  let jwks: Server;
  let key: CryptoKey;
  const ISSUER = "https://issuer.test";
  const AUDIENCE = "https://ctgov.test/mcp";

  const token = () =>
    new SignJWT({ scope: "ctgov:read" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("alice")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    key = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
    jwks = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => jwks.listen(0, "127.0.0.1", r));
    const jwksUrl = `http://127.0.0.1:${(jwks.address() as { port: number }).port}/jwks.json`;
    ({ h: anon, base: anonBase } = await serve({ publicDocs: true, allowedOrigins: ["https://app.example.com"] }));
    ({ h: secured, base: securedBase } = await serve({
      auth: { provider: "generic-oidc", issuer: ISSUER, audience: AUDIENCE, jwksUrl, scopes: ["ctgov:read"] },
    }));
  });
  afterAll(async () => {
    await anon.close();
    await secured.close();
    await new Promise<void>((r) => jwks.close(() => r()));
  });

  it("anonymous: a foreign browser Origin is 403 origin_not_allowed", async () => {
    const r = await rpc(anonBase, "tools/list", {}, { headers: { origin: "https://evil.example.com" } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("origin_not_allowed");
    const nullOrigin = await rpc(anonBase, "tools/list", {}, { headers: { origin: "null" } });
    expect(nullOrigin.status).toBe(403);
  });

  it("anonymous: loopback origins, an allowlisted origin and requests without an Origin pass", async () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:3000", "https://app.example.com"]) {
      expect((await rpc(anonBase, "tools/list", {}, { headers: { origin } })).status, origin).toBe(200);
    }
    expect((await rpc(anonBase, "tools/list")).status).toBe(200);
  });

  it("anonymous: only a validated origin is echoed in CORS, and a foreign preflight is refused", async () => {
    const ok = await raw(anonBase, "/mcp", { method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "POST" } });
    expect(ok.status).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    const bad = await raw(anonBase, "/mcp", { method: "OPTIONS", headers: { origin: "https://evil.example.com", "access-control-request-method": "POST" } });
    expect(bad.status).toBe(403);
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it.each(["https://claude.ai", "https://chatgpt.com", "https://evil.example.com", "null"])(
    "bearer-authenticated: accepts Origin %s (hosted connectors send their own)",
    async (origin) => {
      const r = await rpc(securedBase, "tools/list", {}, { headers: { origin, authorization: `Bearer ${await token()}` } });
      expect(r.status).toBe(200);
      expect(r.body.result.tools).toHaveLength(3);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(r.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
    },
  );

  it("bearer-authenticated: a foreign Origin without a token is still 401, not 403", async () => {
    const r = await rpc(securedBase, "tools/list", {}, { headers: { origin: "https://claude.ai" } });
    expect(r.status).toBe(401);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("bearer-authenticated: the preflight (which carries no token) is answered for any origin, echoing requested headers", async () => {
    const r = await raw(securedBase, "/mcp", {
      method: "OPTIONS",
      headers: { origin: "https://claude.ai", "access-control-request-method": "POST", "access-control-request-headers": "authorization, mcp-method, mcp-name" },
    });
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.headers["access-control-allow-headers"]).toBe("authorization, mcp-method, mcp-name");
    expect(String(r.headers["access-control-allow-credentials"] ?? "")).toBe("");
  });

  it("OAuth discovery documents are readable cross-origin", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await fetch(`${securedBase}${path}`, { headers: { origin: "https://claude.ai" } });
      expect(r.status, path).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
    }
    const pre = await raw(securedBase, "/.well-known/oauth-protected-resource/mcp", { method: "OPTIONS", headers: { origin: "https://claude.ai" } });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("bearer-token enforcement (OIDC, real ES256 tokens from a local issuer)", () => {
  let secured: HttpHandle;
  let base = "";
  let jwks: Server;
  let issuerKey: CryptoKey;
  let otherKey: CryptoKey;
  const ISSUER = "https://issuer.test";
  const AUDIENCE = "https://ctgov.test/mcp";

  const sign = async (
    claims: Record<string, unknown>,
    opts: { key?: CryptoKey | Uint8Array; exp?: string | number | null; alg?: string } = {},
  ) => {
    const jwt = new SignJWT({ scope: "ctgov:read", ...claims })
      .setProtectedHeader({ alg: opts.alg ?? "ES256", kid: "k1" })
      .setIssuedAt();
    if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? "5m");
    return jwt.sign(opts.key ?? issuerKey);
  };
  const good = (extra: Record<string, unknown> = {}) => ({ sub: "alice", iss: ISSUER, aud: AUDIENCE, ...extra });
  const list = (token?: string) => rpc(base, "tools/list", {}, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    issuerKey = pair.privateKey;
    otherKey = (await generateKeyPair("ES256")).privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
    jwks = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => jwks.listen(0, "127.0.0.1", r));
    const jwksUrl = `http://127.0.0.1:${(jwks.address() as { port: number }).port}/jwks.json`;
    ({ h: secured, base } = await serve({
      auth: { provider: "generic-oidc", issuer: ISSUER, audience: AUDIENCE, jwksUrl, scopes: ["ctgov:read", "ctgov:extra"] },
    }));
  });
  afterAll(async () => {
    await secured.close();
    await new Promise<void>((r) => jwks.close(() => r()));
  });

  it("rejects a request without a bearer token: 401 with the resource-metadata challenge", async () => {
    const r = await list();
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("accepts a valid token with EVERY configured scope, on every request (no session)", async () => {
    const token = await sign(good({ scope: "ctgov:read ctgov:extra" }));
    const ok = await list(token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("mcp-session-id")).toBeNull();
    expect((await list()).status).toBe(401);
  });

  it.each([
    ["arbitrary text", async () => "not-a-jwt"],
    ["the wrong signing key", async () => sign(good({ scope: "ctgov:read ctgov:extra" }), { key: otherKey })],
    ["another service's audience", async () => sign(good({ aud: "unrelated-service", scope: "ctgov:read ctgov:extra" }))],
    ["the wrong issuer", async () => sign(good({ iss: "https://evil.test", scope: "ctgov:read ctgov:extra" }))],
    ["no expiration", async () => sign(good({ scope: "ctgov:read ctgov:extra" }), { exp: null })],
    ["an expired time", async () => sign(good({ scope: "ctgov:read ctgov:extra" }), { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["no subject", async () => sign({ iss: ISSUER, aud: AUDIENCE, scope: "ctgov:read ctgov:extra" })],
    ["a blank subject", async () => sign(good({ sub: "  ", scope: "ctgov:read ctgov:extra" }))],
    [
      "the HS256 algorithm (symmetric tokens are refused)",
      async () => sign(good({ scope: "ctgov:read ctgov:extra" }), { alg: "HS256", key: new TextEncoder().encode("s".repeat(64)) }),
    ],
  ])("rejects a token with %s (401, invalid_token)", async (_label, make) => {
    const r = await list(await make());
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("rejects an unsigned (alg none) token", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "none" })}.${b64(good({ scope: "ctgov:read ctgov:extra", exp: Math.floor(Date.now() / 1000) + 300 }))}.`;
    expect((await list(token)).status).toBe(401);
  });

  it("rejects a valid token missing ANY configured scope: 403 insufficient_scope naming the missing one", async () => {
    for (const scope of ["ctgov:read", "ctgov:extra", "other", "ctgov.read ctgov.extra"]) {
      const r = await list(await sign(good({ scope })));
      expect(r.status, scope).toBe(403);
      expect(r.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    }
    const one = await list(await sign(good({ scope: "ctgov:read" })));
    expect(one.headers.get("www-authenticate")).toContain('scope="ctgov:extra"');
  });

  it("keeps verifier details out of the response", async () => {
    const r = await post(`${base}/mcp`, "{}", { authorization: `Bearer ${await sign(good(), { key: otherKey })}` });
    expect(r.raw).toBe("invalid bearer token");
  });
});

describe("per-IP rate limit behind a reverse proxy", () => {
  async function server(clientIpHeader?: string) {
    const { h, base } = await serve({ insecure: true, ipRps: 0.001, ipBurst: 2, ...(clientIpHeader ? { clientIpHeader } : {}) });
    const status = async (realIp?: string, xff?: string) =>
      (await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { ...(realIp ? { "x-real-ip": realIp } : {}), ...(xff ? { "x-forwarded-for": xff } : {}) } })).status;
    return { h, status };
  }

  it("limits each client separately by the header the proxy sets", async () => {
    const { h, status } = await server("x-real-ip");
    try {
      expect([await status("203.0.113.7"), await status("203.0.113.7"), await status("203.0.113.7")]).toEqual([204, 204, 429]);
      expect(await status("198.51.100.9")).toBe(204);
    } finally {
      await h.close();
    }
  });

  it("ignores every forwarding header unless one is named (a spoofed X-Forwarded-For buys nothing)", async () => {
    const { h, status } = await server();
    try {
      expect([await status("203.0.113.1", "1.1.1.1"), await status("203.0.113.2", "2.2.2.2"), await status("203.0.113.3", "3.3.3.3")]).toEqual([204, 204, 429]);
    } finally {
      await h.close();
    }
  });

  it("answers 429 with a Retry-After, and leaves /health free for platform probes", async () => {
    const { h, base } = await serve({ insecure: true, ipRps: 0.001, ipBurst: 1 });
    try {
      await fetch(`${base}/mcp`, { method: "OPTIONS" });
      const limited = await fetch(`${base}/mcp`, { method: "OPTIONS" });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});

describe("shared state across stateless requests", () => {
  it("serves the upstream cache across requests even though every request builds a new MCP server", async () => {
    const upstream = constantUpstream({ apiVersion: "2.0.0" });
    const { h, base } = await serve({ insecure: true, dispatcher: upstream.agent });
    try {
      const run = () =>
        rpc(base, "tools/call", { name: "execute", arguments: { code: "return await ctgov.version();", timeoutMs: 5000 } });
      const first = await run();
      if (first.body.result.structuredContent?.executor === undefined) return;
      await run();
      expect(upstream.requests.map((r) => r.path)).toEqual(["/version"]);
    } finally {
      await h.close();
      await upstream.close();
    }
  });
});
