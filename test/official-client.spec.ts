// Drives the server with the OFFICIAL MCP client SDK instead of hand-built requests. The client
// builds the `_meta` envelope and the Mcp-Method/Mcp-Name routing headers itself, so this catches
// protocol mistakes a hand-rolled request would encode identically on both sides.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport, type VersionNegotiationOptions } from "@modelcontextprotocol/client";
import { isDenoAvailable } from "../src/sandbox/deno.js";
import { isIsolateAvailable } from "../src/sandbox/isolate.js";
import { startHttpServer, type HttpHandle } from "../src/server/http.js";
import { MCP_PROTOCOL_VERSION } from "../src/server/mcpServer.js";
import { constantUpstream, type FakeUpstream } from "./characterization/helpers.js";

let handle: HttpHandle;
let url: URL;
let upstream: FakeUpstream;

beforeAll(async () => {
  // Any upstream request outside the fake fails loudly (net connect is disabled).
  upstream = constantUpstream({ studies: [{ protocolSection: { identificationModule: { nctId: "NCT01234567" } } }], totalCount: 1 });
  handle = await startHttpServer({ port: 0, host: "127.0.0.1", insecure: true, ipRps: 1000, ipBurst: 1000, dispatcher: upstream.agent });
  url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
});
afterAll(async () => {
  await handle.close();
  await upstream.close();
});

// Typed, NOT cast: a malformed mode (e.g. `{ mode: 'pin', pin }`) would compile under a cast and
// silently fall back to legacy negotiation, leaving the "pins the modern revision" test passing
// without pinning. The pin is a NESTED object.
async function connect(versionNegotiation: VersionNegotiationOptions) {
  const client = new Client({ name: "ctgov-conformance-probe", version: "1.0.0" }, { versionNegotiation });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

const NAMES = ["search_api", "describe_schema", "execute"];

describe("official MCP client SDK", () => {
  it.each([
    ["auto", { mode: "auto" } as VersionNegotiationOptions],
    ["pinned to the modern revision", { mode: { pin: MCP_PROTOCOL_VERSION } } as VersionNegotiationOptions],
  ])("negotiation %s: tools/list conforms (titles, annotations, outputSchema) and carries the modern cache hints", async (_label, neg) => {
    const client = await connect(neg);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(NAMES);
      for (const t of listed.tools) {
        expect(t.title).toBeTruthy();
        expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
        expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
        expect(t.outputSchema).toMatchObject({ type: "object" });
      }
      expect(listed.tools.map((t) => t.annotations?.openWorldHint)).toEqual([false, false, true]);
      const byName = Object.fromEntries(listed.tools.map((t) => [t.name, t]));
      expect(byName.execute!.inputSchema.properties?.timeoutMs).toMatchObject({ type: "integer", minimum: 100, maximum: 60000 });
      expect(JSON.stringify(byName.describe_schema!.inputSchema)).toContain("oneOf");
      // Only the modern leg produces these, so a pin that degraded to legacy fails here.
      expect(listed.ttlMs).toBe(300_000);
      expect(listed.cacheScope).toBe("public");
    } finally {
      await client.close();
    }
  });

  it("round-trips search_api: structuredContent validates against the advertised outputSchema", async () => {
    const client = await connect({ mode: "auto" });
    try {
      const res = await client.callTool({ name: "search_api", arguments: { query: "recruiting studies by condition", k: 2 } });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ query: "recruiting studies by condition", hits: 2 });
      const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
      expect(JSON.parse(text)).toEqual(res.structuredContent);
      expect(text).not.toContain("\n  "); // compact JSON
    } finally {
      await client.close();
    }
  });

  it("reports an unknown tool as a protocol error and a bad argument as an isError result", async () => {
    const client = await connect({ mode: "auto" });
    try {
      await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toThrow(/not found/i);
      const bad = await client.callTool({ name: "describe_schema", arguments: {} });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  const runner = isIsolateAvailable() || isDenoAvailable();
  it.skipIf(!runner)("runs execute end to end: sandbox -> ctgov SDK -> (faked) clinicaltrials.gov, with isError on ok:false", async () => {
    const client = await connect({ mode: "auto" });
    try {
      const ok = await client.callTool({
        name: "execute",
        arguments: { code: `const p = await ctgov.studies.search({ "query.cond": "flu", pageSize: 1 }); return { total: p.totalCount };`, timeoutMs: 10_000 },
      });
      expect(ok.isError).toBeFalsy();
      expect(ok.structuredContent).toMatchObject({ ok: true, result: { total: 1 } });
      const failed = await client.callTool({ name: "execute", arguments: { code: `throw new Error("boom");`, timeoutMs: 10_000 } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ ok: false, error: { message: "boom" } });
      expect(upstream.requests.some((r) => r.path.startsWith("/studies?query.cond=flu"))).toBe(true);
    } finally {
      await client.close();
    }
  });
});
