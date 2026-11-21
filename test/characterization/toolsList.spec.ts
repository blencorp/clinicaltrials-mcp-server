// Characterization: pins the v1 tools/list contract (names, descriptions, inputSchema, annotations)
// for the `all` and `docs-only` modes. It pins v1 behaviour; later packages update it via an
// explicit expected-diff list. The JSON fixtures under __fixtures__ are the reference copies.
import { describe, expect, it } from "vitest";
import { connect } from "./helpers.js";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string): string => new URL(name, FIXTURES).pathname;

describe("tools/list (v1)", () => {
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

  it("serves no outputSchema and annotates every tool read-only (v1 has no structured output)", async () => {
    const c = await connect({ tools: "all" });
    try {
      const { tools } = await c.client.listTools();
      for (const t of tools) {
        expect(t.outputSchema).toBeUndefined();
        expect(t.annotations?.readOnlyHint).toBe(true);
        expect(t.annotations?.destructiveHint).toBe(false);
      }
      expect(tools.map((t) => t.annotations?.openWorldHint)).toEqual([false, false, true]);
    } finally {
      await c.close();
    }
  });

  it("advertises tools capability with listChanged=false and the v1 server info", async () => {
    const c = await connect({});
    try {
      expect(c.client.getServerVersion()).toEqual({ name: "clinicaltrial-mcp-server", version: "0.1.0-alpha.0" });
      expect(c.client.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
    } finally {
      await c.close();
    }
  });
});
