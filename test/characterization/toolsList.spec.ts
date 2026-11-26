// Characterization: pins the tools/list contract (names, titles, descriptions, inputSchema,
// outputSchema, annotations) for the `all` and `docs-only` modes. Pinned on v1 originally; updated
// for the SDK v2 port, and again for package C (tool descriptions, the execute output schema, uspto's result schemas, execute limits as defaults). The JSON
// fixtures under __fixtures__ are the reference copies.
import { SERVER_VERSION } from "../../src/server/mcpServer.js";
import { describe, expect, it } from "vitest";
import { connect } from "./helpers.js";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string): string => new URL(name, FIXTURES).pathname;

describe("tools/list", () => {
  it("lists search_api, describe_schema, execute in `all` mode", async () => {
    const c = await connect({ tools: "all" });
    try {
      const { tools } = await c.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["search_api", "describe_schema", "execute"]);
      await expect(JSON.stringify(tools, null, 2) + "\n").toMatchFileSnapshot(fixture("tools-list.all.json"));
    } finally {
      await c.close();
    }
  });

  it("defaults to the `all` set when `tools` is omitted", async () => {
    const all = await connect({ tools: "all" });
    const dflt = await connect({});
    try {
      expect((await dflt.client.listTools()).tools).toEqual((await all.client.listTools()).tools);
    } finally {
      await all.close();
      await dflt.close();
    }
  });

  it("lists only search_api and describe_schema in `docs-only` mode", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      const { tools } = await c.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["search_api", "describe_schema"]);
      await expect(JSON.stringify(tools, null, 2) + "\n").toMatchFileSnapshot(fixture("tools-list.docs-only.json"));
    } finally {
      await c.close();
    }
  });

  it("serves an outputSchema for every tool and annotates every tool read-only", async () => {
    const c = await connect({ tools: "all" });
    try {
      const { tools } = await c.client.listTools();
      for (const t of tools) {
        expect(t.outputSchema).toMatchObject({ type: "object" });
        expect(t.annotations?.readOnlyHint).toBe(true);
        expect(t.annotations?.destructiveHint).toBe(false);
        expect(t.title).toBeTruthy();
      }
      expect(tools.map((t) => t.annotations?.openWorldHint)).toEqual([false, false, true]);
    } finally {
      await c.close();
    }
  });

  it("advertises real integer/min/max constraints and rejects unknown arguments", async () => {
    const c = await connect({ tools: "all" });
    try {
      const { tools } = await c.client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema as any]));
      expect(byName.search_api.properties.k).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
      // C4: the limits are per-call zod defaults (advertised as `default`, but still optional).
      expect(byName.search_api.properties.k.default).toBe(10);
      expect(byName.execute.properties.timeoutMs).toMatchObject({ type: "integer", minimum: 100, maximum: 60000, default: 15000 });
      expect(byName.execute.properties.memoryMb).toMatchObject({ type: "integer", minimum: 16, maximum: 256, default: 64 });
      expect(byName.execute.properties.code).toMatchObject({ type: "string", minLength: 1, maxLength: 262144 });
      expect(byName.execute.required).toEqual(["code"]);
      for (const schema of Object.values(byName)) expect(schema.additionalProperties).toBe(false);
      expect(byName.describe_schema.oneOf).toHaveLength(2);
    } finally {
      await c.close();
    }
  });

  it("advertises the tools capability, the server info and the workflow instructions", async () => {
    const c = await connect({});
    try {
      expect(c.client.getServerVersion()).toEqual({ name: "clinicaltrials-mcp-server", version: SERVER_VERSION });
      expect(c.client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
      expect(c.client.getInstructions()).toMatch(/^ClinicalTrials\.gov through code mode\./);
    } finally {
      await c.close();
    }
  });
});
