import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectSandbox } from "../src/sandbox/index.js";
import { startHttpServer } from "../src/server/http.js";

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

/** Parses a JSON or single-event SSE response body from the Streamable HTTP transport. */
async function rpcResult(r: Response): Promise<any> {
  const text = await r.text();
  const data = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  return JSON.parse(data ?? "null");
}

async function openSession(base: string): Promise<string> {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }),
  });
  expect(r.status).toBe(200);
  await r.text();
  const sessionId = r.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId! },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sessionId!;
}

async function rpc(base: string, sessionId: string, id: number, method: string, params: unknown): Promise<any> {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(r.status).toBe(200);
  return rpcResult(r);
}

describe("--public-docs: anonymous, docs-only hosting", () => {
  let close: (() => Promise<void>) | undefined;
  let base = "";

  beforeAll(async () => {
    const srv = await startHttpServer({ port: 0, host: "127.0.0.1", publicDocs: true });
    close = srv.close;
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(async () => {
    await close?.();
  });

  it("reports no executor and the docs-only tool set", async () => {
    const health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, executor: "none", auth: "off", tools: "docs-only" });
  });

  it("lists search_api and describe_schema but not execute", async () => {
    const sid = await openSession(base);
    const out = await rpc(base, sid, 2, "tools/list", {});
    const names = (out.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(["describe_schema", "search_api"]);
  });

  it("rejects a direct execute call without running anything", async () => {
    const sid = await openSession(base);
    const out = await rpc(base, sid, 3, "tools/call", { name: "execute", arguments: { code: "return 1" } });
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toMatch(/Unknown tool: execute/);
  });

  it("still answers documentation tools", async () => {
    const sid = await openSession(base);
    const out = await rpc(base, sid, 4, "tools/call", { name: "search_api", arguments: { query: "conditions" } });
    expect(out.result.isError).toBeFalsy();
  });
});

describe("authenticated serving requires process isolation", () => {
  it("refuses --sandbox isolate at startup", async () => {
    const keys = ["CTGOV_AUTH_PROVIDER", "CTGOV_AUTH_ISSUER", "CTGOV_AUTH_RESOURCE"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.CTGOV_AUTH_PROVIDER = "embedded";
    process.env.CTGOV_AUTH_ISSUER = "http://127.0.0.1:1";
    process.env.CTGOV_AUTH_RESOURCE = "http://127.0.0.1:1/mcp";
    try {
      await expect(startHttpServer({ port: 0, host: "127.0.0.1", sandboxMode: "isolate" })).rejects.toThrow(
        /not allowed for authenticated HTTP serving/,
      );
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("selectSandbox never returns the in-process isolate under processIsolation", () => {
    expect(() => selectSandbox({ mode: "isolate", processIsolation: true })).toThrow(/not allowed/);
    try {
      expect(selectSandbox({ mode: "auto", processIsolation: true }).constructor.name).toBe("DenoExecutor");
    } catch (err) {
      // Without Deno on PATH the only acceptable outcome is a refusal, never an isolate.
      expect((err as Error).message).toMatch(/deno is not on PATH/);
    }
  });

  it("--insecure ignores an ambient HOST and listens on loopback", async () => {
    const previous = process.env.HOST;
    process.env.HOST = "0.0.0.0"; // what deploy/Dockerfile and .env.example set
    try {
      const srv = await startHttpServer({ port: 0, insecure: true });
      try {
        const health = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
        expect(health.status).toBe(200);
        expect(srv.host).toBe("127.0.0.1");
      } finally {
        await srv.close();
      }
    } finally {
      if (previous === undefined) delete process.env.HOST;
      else process.env.HOST = previous;
    }
  });

  it("rejects combining --insecure and --public-docs", async () => {
    await expect(startHttpServer({ port: 0, insecure: true, publicDocs: true })).rejects.toThrow(/mutually exclusive/);
  });
});
