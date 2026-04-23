import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isAnySandboxAvailable } from "../src/sandbox/index.js";
import { startHttpServer } from "../src/server/http.js";

let close: (() => Promise<void>) | undefined;
let base: string;

beforeAll(async () => {
  if (!isAnySandboxAvailable()) return;
  const srv = await startHttpServer({ port: 0, host: "127.0.0.1", insecure: true });
  close = srv.close;
  base = `http://127.0.0.1:${srv.port}`;
});

afterAll(async () => {
  if (close) await close();
});

describe.skipIf(!isAnySandboxAvailable())("HTTP transport (insecure mode)", () => {
  it("GET /healthz returns 200", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
  });

  it("GET /health returns 200 with status and timestamp", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { status: string; timestamp: string };
    expect(j.status).toBe("ok");
    expect(typeof j.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(j.timestamp))).toBe(false);
  });

  it("GET /.well-known/oauth-protected-resource returns PRM", async () => {
    const r = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.resource).toBeTruthy();
    expect(Array.isArray(j.scopes_supported)).toBe(true);
  });

  it("POST /mcp initialize + tools/list succeeds in insecure mode", async () => {
    // Send a batched initialize -> initialized -> tools/list
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    };
    const r1 = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(init),
    });
    expect([200]).toContain(r1.status);
    const sessionId = r1.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    // Send initialized notification
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const r2 = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(r2.status).toBe(200);
    const text = await r2.text();
    // Streamable HTTP may return SSE event-stream or JSON depending on accept
    expect(text).toContain("search_api");
    expect(text).toContain("execute");
    expect(text).toContain("describe_schema");
  });
});
