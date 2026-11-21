// Characterization: pins the v1 HTTP transport contract (auth challenges, health shapes, well-known
// documents, body limits, malformed requests, docs-only refusal) and the startup rules of the three
// hosting modes (authenticated, --public-docs, --insecure). It pins v1 behaviour; later packages
// update it via an explicit expected-diff list.
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { isDenoAvailable } from "../../src/sandbox/deno.js";
import { startHttpServer, type HttpServerOptions } from "../../src/server/http.js";

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const ENV_KEYS = [
  "CTGOV_AUTH_PROVIDER",
  "CTGOV_AUTH_ISSUER",
  "CTGOV_AUTH_RESOURCE",
  "CTGOV_AUTH_SCOPES",
  "CTGOV_AUTH_JWKS_URL",
  "CTGOV_EMBEDDED_USERS",
  "CTGOV_SANDBOX",
  "HOST",
] as const;

/** Runs `fn` with the given env (all other auth/host variables cleared), then restores it. */
async function withEnv<T>(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

interface Started {
  base: string;
  host: string;
  close: () => Promise<void>;
}

async function start(env: Parameters<typeof withEnv>[0], opts: HttpServerOptions): Promise<Started> {
  return withEnv(env, async () => {
    const srv = await startHttpServer({ port: 0, host: "127.0.0.1", ...opts });
    return { base: `http://127.0.0.1:${srv.port}`, host: srv.host, close: srv.close };
  });
}

/** Parses a JSON or single-event SSE body from the Streamable HTTP transport. */
async function rpcBody(r: Response): Promise<any> {
  const text = await r.text();
  const data = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  return JSON.parse(data ?? "null");
}

async function openSession(base: string, extra: Record<string, string> = {}): Promise<string> {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...extra },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  expect(r.status).toBe(200);
  await r.text();
  const sid = r.headers.get("mcp-session-id")!;
  expect(sid).toBeTruthy();
  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...extra, "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sid;
}

async function rpc(base: string, sid: string, method: string, params: unknown, extra: Record<string, string> = {}): Promise<any> {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...extra, "mcp-session-id": sid },
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

const RESOURCE = "https://clinicaltrials.mcp.blencorp.com/mcp";
const PRM_URL = "https://clinicaltrials.mcp.blencorp.com/.well-known/oauth-protected-resource";
const CHALLENGE = `Bearer realm="${RESOURCE}", resource_metadata="${PRM_URL}"`;

describe("authenticated mode: 401/403 challenges and well-known documents (v1)", () => {
  let idp: Server;
  let issuer = "";
  let key: KeyLike;
  let app: Started;

  async function token(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience(RESOURCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
  }

  beforeAll(async () => {
    const kp = await generateKeyPair("RS256");
    key = kp.privateKey;
    const jwk = { ...((await exportJWK(kp.publicKey)) as JWK), kid: "k1", use: "sig", alg: "RS256" };
    idp = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/oauth-authorization-server") {
        res.end(JSON.stringify({ issuer, token_endpoint: `${issuer}/token` }));
      } else {
        res.end(JSON.stringify({ keys: [jwk] }));
      }
    });
    await new Promise<void>((r) => idp.listen(0, "127.0.0.1", () => r()));
    issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
    app = await start(
      {
        CTGOV_AUTH_PROVIDER: "clerk",
        CTGOV_AUTH_ISSUER: issuer,
        CTGOV_AUTH_RESOURCE: RESOURCE,
        CTGOV_AUTH_SCOPES: "ctgov.read",
        CTGOV_AUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
      },
      {},
    );
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => idp.close(() => r()));
  });

  it("401 without a bearer token: plain text body and a WWW-Authenticate pointing at the PRM", async () => {
    const r = await fetch(`${app.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(await r.text()).toBe("missing bearer token");
  });

  it("401 for a garbage bearer token, with the same challenge", async () => {
    const r = await fetch(`${app.base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: "Bearer not-a-jwt" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(await r.text()).toBe("invalid bearer token");
  });

  it("403 insufficient_scope when the token lacks ctgov.read, advertising the required scope", async () => {
    const t = await token({ sub: "alice", scope: "openid profile" });
    const r = await fetch(`${app.base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${t}` }, body: "{}" });
    expect(r.status).toBe(403);
    expect(r.headers.get("www-authenticate")).toBe(`${CHALLENGE}, error="insufficient_scope", scope="ctgov.read"`);
    expect(await r.text()).toBe("insufficient scope");
  });

  it("accepts a token with ctgov.read (or the * wildcard) and serves all three tools", async () => {
    for (const scope of ["ctgov.read", "*"]) {
      const auth = { authorization: `Bearer ${await token({ sub: "alice", scope })}` };
      const sid = await openSession(app.base, auth);
      const out = await rpc(app.base, sid, "tools/list", {}, auth);
      expect(out.result.tools.map((t: { name: string }) => t.name)).toEqual(["search_api", "describe_schema", "execute"]);
    }
  });

  it("403 'session subject mismatch' when another subject reuses a session id", async () => {
    const alice = { authorization: `Bearer ${await token({ sub: "alice", scope: "ctgov.read" })}` };
    const bob = { authorization: `Bearer ${await token({ sub: "bob", scope: "ctgov.read" })}` };
    const sid = await openSession(app.base, alice);
    const r = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, ...bob, "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(r.status).toBe(403);
    expect(await r.text()).toBe("session subject mismatch");
  });

  it("/healthz reports the provider, the all tool set and the process-isolated executor", async () => {
    expect(await (await fetch(`${app.base}/healthz`)).json()).toEqual({
      ok: true,
      executor: isDenoAvailable() ? "deno" : "unavailable",
      auth: "clerk",
      tools: "all",
    });
  });

  it("serves the PRM unauthenticated, exactly", async () => {
    const r = await fetch(`${app.base}/.well-known/oauth-protected-resource`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["ctgov.read"],
      resource_documentation: "https://github.com/blencorp/clinicaltrials-mcp-server/blob/main/legal/privacy-policy.md",
      resource_policy_uri: "https://github.com/blencorp/clinicaltrials-mcp-server/blob/main/legal/terms.md",
      resource_name: "ClinicalTrials.gov Explorer (by BLEN)",
    });
  });

  it("proxies the issuer's AS metadata at /.well-known/oauth-authorization-server", async () => {
    const r = await fetch(`${app.base}/.well-known/oauth-authorization-server`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ issuer, token_endpoint: `${issuer}/token` });
  });

  it("answers an unsupported method on /mcp with 405 and an Allow header", async () => {
    const r = await fetch(`${app.base}/mcp`, { method: "PUT" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST, GET, DELETE");
  });
});

describe.each([
  { label: "--public-docs", opts: { publicDocs: true }, executor: "none", tools: "docs-only" },
  { label: "--insecure", opts: { insecure: true }, executor: undefined, tools: "all" },
] as const)("unauthenticated $label mode (v1)", ({ opts, executor, tools }) => {
  let app: Started;
  beforeAll(async () => {
    app = await start({}, opts);
  });
  afterAll(async () => {
    await app.close();
  });

  it("/healthz reports auth off", async () => {
    const body = (await (await fetch(`${app.base}/healthz`)).json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, executor: body.executor, auth: "off", tools });
    if (executor) expect(body.executor).toBe(executor);
    else expect(["isolate", "deno", "unavailable"]).toContain(body.executor);
  });

  it("/readyz has the same shape as /healthz", async () => {
    const a = await (await fetch(`${app.base}/healthz`)).json();
    expect(await (await fetch(`${app.base}/readyz`)).json()).toEqual(a);
  });

  it("/health is {status:'ok', timestamp} with no-store caching and an x-trace-id", async () => {
    const r = await fetch(`${app.base}/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-trace-id")).toMatch(/^[0-9a-f-]{36}$/);
    const body = (await r.json()) as { status: string; timestamp: string };
    expect(Object.keys(body)).toEqual(["status", "timestamp"]);
    expect(body.status).toBe("ok");
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it("both well-known documents are 404 when nothing is protected", async () => {
    const prm = await fetch(`${app.base}/.well-known/oauth-protected-resource`);
    expect(prm.status).toBe(404);
    expect(await prm.json()).toEqual({ error: "no protected resource configured" });
    const as = await fetch(`${app.base}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(404);
    expect(await as.json()).toEqual({ error: "no authorization server configured" });
  });

  it("/mcp needs no token; unknown paths are a JSON 404", async () => {
    const sid = await openSession(app.base);
    expect(sid).toBeTruthy();
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

  it("serves no embedded authorization server endpoints", async () => {
    for (const [method, path] of [["POST", "/as/register"], ["GET", "/as/jwks.json"]] as const) {
      const r = await raw(app.base, path, { method });
      expect(r.status, path).toBe(404);
    }
  });
});

describe("--public-docs tool surface over HTTP (v1)", () => {
  let app: Started;
  beforeAll(async () => {
    app = await start({}, { publicDocs: true });
  });
  afterAll(async () => {
    await app.close();
  });

  it("lists exactly search_api and describe_schema", async () => {
    const sid = await openSession(app.base);
    const out = await rpc(app.base, sid, "tools/list", {});
    expect(out.result.tools.map((t: { name: string }) => t.name)).toEqual(["search_api", "describe_schema"]);
  });

  it("refuses execute as an unknown tool (isError, not a JSON-RPC error)", async () => {
    const sid = await openSession(app.base);
    const out = await rpc(app.base, sid, "tools/call", { name: "execute", arguments: { code: "return 1" } });
    expect(out.error).toBeUndefined();
    expect(out.result.isError).toBe(true);
    expect(out.result.content).toHaveLength(1);
    expect(JSON.parse(out.result.content[0].text)).toEqual({
      name: "CtGovError",
      code: "VALIDATION_ERROR",
      message: "Unknown tool: execute",
    });
  });
});

describe("embedded AS body limits (v1)", () => {
  let app: Started;
  beforeAll(async () => {
    app = await start(
      {
        CTGOV_AUTH_PROVIDER: "embedded",
        CTGOV_AUTH_ISSUER: "http://127.0.0.1:1",
        CTGOV_AUTH_RESOURCE: "http://127.0.0.1:1/mcp",
        CTGOV_EMBEDDED_USERS: "alice:wonderland",
      },
      {},
    );
  });
  afterAll(async () => {
    await app.close();
  });

  it("413 on a /as/register body over 64 KiB", async () => {
    const r = await fetch(`${app.base}/as/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1/cb"], pad: "x".repeat(70 * 1024) }),
    });
    expect(r.status).toBe(413);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await r.text()).toBe("request body too large (max 65536 bytes)");
  });

  it("413 on a /as/token body over 16 KiB", async () => {
    const r = await fetch(`${app.base}/as/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&code=${"x".repeat(20 * 1024)}`,
    });
    expect(r.status).toBe(413);
    expect(await r.text()).toBe("request body too large (max 16384 bytes)");
  });

  it("400 invalid_client_metadata for a malformed /as/register body", async () => {
    const r = await fetch(`${app.base}/as/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_client_metadata" });
  });

  it("the embedded AS publishes its own metadata and still 401s /mcp without a token", async () => {
    const md = (await (await fetch(`${app.base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(md.issuer).toBe("http://127.0.0.1:1");
    const r = await fetch(`${app.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: "{}" });
    expect(r.status).toBe(401);
  });
});

describe("startup rules (v1)", () => {
  it("--insecure and --public-docs are mutually exclusive", async () => {
    await expect(start({}, { insecure: true, publicDocs: true })).rejects.toThrow("--insecure and --public-docs are mutually exclusive");
  });

  it("plain --http without auth configuration refuses to start", async () => {
    await expect(start({}, {})).rejects.toThrow(/^HTTP transport requires auth configuration\. Set CTGOV_AUTH_PROVIDER=clerk/);
  });

  it("an auth provider without an issuer refuses to start", async () => {
    await expect(start({ CTGOV_AUTH_PROVIDER: "clerk" }, {})).rejects.toThrow("CTGOV_AUTH_ISSUER is required when provider != none");
  });

  it("authenticated serving refuses the isolate sandbox, by option and by CTGOV_SANDBOX", async () => {
    const env = { CTGOV_AUTH_PROVIDER: "embedded", CTGOV_AUTH_ISSUER: "http://127.0.0.1:1", CTGOV_AUTH_RESOURCE: "http://127.0.0.1:1/mcp" } as const;
    const msg = /the isolate sandbox \(--sandbox isolate \/ CTGOV_SANDBOX=isolate\) is not allowed for authenticated HTTP serving; use deno/;
    await expect(start(env, { sandboxMode: "isolate" })).rejects.toThrow(msg);
    await expect(start({ ...env, CTGOV_SANDBOX: "isolate" }, {})).rejects.toThrow(msg);
  });

  it("--insecure listens on loopback regardless of HOST; only an explicit host overrides it", async () => {
    const dflt = await start({ HOST: "0.0.0.0" }, { insecure: true, host: undefined as never });
    try {
      expect(dflt.host).toBe("127.0.0.1");
    } finally {
      await dflt.close();
    }
    const explicit = await start({ HOST: "127.0.0.1" }, { insecure: true, host: "0.0.0.0" });
    try {
      expect(explicit.host).toBe("0.0.0.0");
    } finally {
      await explicit.close();
    }
  });

  it("--public-docs takes its bind address from HOST when no host is given", async () => {
    const app = await start({ HOST: "127.0.0.1" }, { publicDocs: true, host: undefined as never });
    try {
      expect(app.host).toBe("127.0.0.1");
    } finally {
      await app.close();
    }
  });

  it("--public-docs and --insecure silently IGNORE a configured auth provider (no auth, no AS, no PRM)", async () => {
    const env = {
      CTGOV_AUTH_PROVIDER: "embedded",
      CTGOV_AUTH_ISSUER: "http://127.0.0.1:1",
      CTGOV_AUTH_RESOURCE: "http://127.0.0.1:1/mcp",
      CTGOV_EMBEDDED_USERS: "alice:wonderland",
    } as const;
    for (const opts of [{ publicDocs: true }, { insecure: true }] as const) {
      const app = await start(env, opts);
      try {
        expect(((await (await fetch(`${app.base}/healthz`)).json()) as { auth: string }).auth).toBe("off");
        expect((await raw(app.base, "/as/register", { method: "POST", body: "{}" })).status).toBe(404);
        expect((await fetch(`${app.base}/.well-known/oauth-protected-resource`)).status).toBe(404);
        const sid = await openSession(app.base);
        expect(sid).toBeTruthy();
      } finally {
        await app.close();
      }
    }
  });
});
