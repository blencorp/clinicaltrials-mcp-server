// Characterization: pins the v1 result shapes of search_api, describe_schema and execute, as the
// MCP client sees them. It pins v1 behaviour; later packages update it via an explicit
// expected-diff list. Large payloads live in __fixtures__ (regenerate with `vitest -u` outside CI).
import { describe, expect, it } from "vitest";
import { DenoExecutor, isDenoAvailable } from "../../src/sandbox/deno.js";
import { IsolateExecutor, isIsolateAvailable } from "../../src/sandbox/isolate.js";
import type { SandboxExecuteOptions, SandboxExecutor, SandboxResult } from "../../src/sandbox/types.js";
import { call, connect, constantUpstream, normalizeExecute } from "./helpers.js";

const fixture = (name: string): string => new URL(`./__fixtures__/${name}`, import.meta.url).pathname;

describe("search_api result (v1)", () => {
  it("returns exactly two text blocks: the snippet, then a pretty-printed hit count", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      const out = await call(c, "search_api", { query: "recruiting studies by condition" });
      expect(out.isError).toBeUndefined();
      expect(out.extraKeys).toEqual([]);
      expect(out.texts).toHaveLength(2);
      await expect(out.texts[0]).toMatchFileSnapshot(fixture("search_api.snippet.txt"));
      expect(out.texts[1]).toBe('{\n  "hits": 6\n}');
    } finally {
      await c.close();
    }
  });

  it("honours k and reports the hit count for it", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      const one = await call(c, "search_api", { query: "recruiting studies by condition", k: 1 });
      expect(one.texts[1]).toBe('{\n  "hits": 1\n}');
      expect(one.texts[0]).toMatch(/^\/\/ Top matches for: "recruiting studies by condition"\n\n\/\/ Quick reference/);
    } finally {
      await c.close();
    }
  });

  it("returns only the primer when nothing matches", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      const out = await call(c, "search_api", { query: "zzzqqqxxx" });
      expect(out.isError).toBeUndefined();
      expect(out.texts[1]).toBe('{\n  "hits": 0\n}');
      expect(out.texts[0]).toMatch(/^\/\/ Top matches for: "zzzqqqxxx"\n\n\/\/ Quick reference/);
      expect(out.texts[0]).not.toContain("// field:");
    } finally {
      await c.close();
    }
  });
});

describe("describe_schema result (v1)", () => {
  async function describeSchema(args: Record<string, unknown>) {
    const c = await connect({ tools: "docs-only" });
    try {
      const out = await call(c, "describe_schema", args);
      expect(out.isError).toBeUndefined();
      expect(out.extraKeys).toEqual([]);
      expect(out.texts).toHaveLength(1);
      // A single pretty-printed (2-space) JSON block.
      const parsed = JSON.parse(out.texts[0]!) as { matches: unknown[]; total: number };
      expect(out.texts[0]).toBe(JSON.stringify(parsed, null, 2));
      return { text: out.texts[0]!, parsed };
    } finally {
      await c.close();
    }
  }

  it("by exact path", async () => {
    const { parsed } = await describeSchema({ path: "protocolSection.identificationModule.nctId" });
    expect(parsed).toEqual({
      matches: [
        {
          kind: "field",
          path: "protocolSection.identificationModule.nctId",
          type: "string",
          doc: "Primary NCT identifier, e.g. NCT04852770.",
        },
      ],
      total: 1,
    });
  });

  it("by prefix", async () => {
    const { text, parsed } = await describeSchema({ prefix: "protocolSection.statusModule" });
    expect(parsed.total).toBe(4);
    await expect(text).toMatchFileSnapshot(fixture("describe_schema.prefix.json"));
  });

  it("with neither path nor prefix returns every field", async () => {
    const { text, parsed } = await describeSchema({});
    expect(parsed.total).toBe(31);
    await expect(text).toMatchFileSnapshot(fixture("describe_schema.all.json"));
  });

  it("returns an empty match list (not an error) for an unknown path or prefix", async () => {
    expect((await describeSchema({ path: "nope.nothing" })).parsed).toEqual({ matches: [], total: 0 });
    expect((await describeSchema({ prefix: "nope." })).parsed).toEqual({ matches: [], total: 0 });
  });

  it("lets path win over prefix, and treats an empty path as absent", async () => {
    const both = await describeSchema({ path: "protocolSection.identificationModule.nctId", prefix: "derivedSection" });
    expect(both.parsed.total).toBe(1);
    const emptyPath = await describeSchema({ path: "", prefix: "protocolSection.statusModule" });
    expect(emptyPath.parsed.total).toBe(4);
  });
});

/** A hand-written SandboxExecutor: records what it was asked to run and answers with `reply`. */
function fakeExecutor(
  reply: (opts: SandboxExecuteOptions) => Promise<Omit<SandboxResult, "calls">>,
): SandboxExecutor & { seen: SandboxExecuteOptions[] } {
  const seen: SandboxExecuteOptions[] = [];
  return {
    kind: "deno",
    seen,
    async execute(opts) {
      seen.push(opts);
      return { ...(await reply(opts)), calls: [] };
    },
  };
}

describe("execute result with a fake SandboxExecutor (v1)", () => {
  it("returns one pretty-printed JSON text block with the audit trace of upstream calls attached", async () => {
    const upstream = constantUpstream({ apiVersion: "2.0.0" });
    const executor = fakeExecutor(async (opts) => ({
      ok: true,
      result: await opts.dispatch("version", {}),
      logs: [{ level: "log", args: ["hello", 1], ts: 1700000000000 }],
      durationMs: 7,
      executor: "deno",
    }));
    const c = await connect({ executor, dispatcher: upstream.agent });
    try {
      const out = await call(c, "execute", { code: "return await ctgov.version();" });
      expect(out.isError).toBeUndefined();
      expect(out.extraKeys).toEqual([]);
      expect(out.texts).toHaveLength(1);
      expect(out.texts[0]).toBe(JSON.stringify(JSON.parse(out.texts[0]!), null, 2));
      expect(Object.keys(JSON.parse(out.texts[0]!))).toEqual(["ok", "result", "logs", "durationMs", "executor", "calls"]);
      expect(normalizeExecute(out.texts[0]!)).toEqual({
        ok: true,
        result: { apiVersion: "2.0.0" },
        logs: [{ level: "log", args: ["hello", 1], ts: "<ts>" }],
        durationMs: "<ms>",
        executor: "deno",
        calls: [
          {
            id: "<id>",
            method: "GET",
            url: "https://clinicaltrials.gov/api/v2/version",
            status: 200,
            durationMs: "<ms>",
            cacheHit: false,
            bytes: 22,
          },
        ],
      });
      expect(upstream.requests.map((r) => r.path)).toEqual(["/version"]);
    } finally {
      await c.close();
      await upstream.close();
    }
  });

  it("passes code through and only forwards timeoutMs/memoryMb when given", async () => {
    const executor = fakeExecutor(async () => ({ ok: true, result: null, logs: [], durationMs: 0, executor: "deno" }));
    const c = await connect({ executor });
    try {
      await call(c, "execute", { code: "return 1" });
      await call(c, "execute", { code: "return 2", timeoutMs: 1234, memoryMb: 32 });
      expect(executor.seen.map((o) => ({ code: o.code, keys: Object.keys(o).sort() }))).toEqual([
        { code: "return 1", keys: ["code", "dispatch"] },
        { code: "return 2", keys: ["code", "dispatch", "memoryMb", "timeoutMs"] },
      ]);
      expect(executor.seen[1]).toMatchObject({ timeoutMs: 1234, memoryMb: 32 });
    } finally {
      await c.close();
    }
  });
});

const REAL_RUNNERS: Array<{ kind: "deno" | "isolate"; available: boolean; make: () => SandboxExecutor }> = [
  { kind: "deno", available: isDenoAvailable(), make: () => new DenoExecutor() },
  { kind: "isolate", available: isIsolateAvailable(), make: () => new IsolateExecutor() },
];

describe.each(REAL_RUNNERS)("execute with the real $kind runner against a MockAgent (v1)", ({ kind, available, make }) => {
  const maybe = it.skipIf(!available);

  async function run(code: string, extra: Record<string, unknown> = {}) {
    const upstream = constantUpstream({ apiVersion: "2.0.0" });
    const c = await connect({ executor: make(), dispatcher: upstream.agent });
    try {
      const out = await call(c, "execute", { code, timeoutMs: 1500, ...extra });
      expect(out.texts).toHaveLength(1);
      return { out, body: normalizeExecute(out.texts[0]!) as Record<string, any>, upstream };
    } finally {
      await c.close();
      await upstream.close();
    }
  }

  maybe("runs ctgov.version() through the dispatch and records logs and the call trace", async () => {
    const { out, body, upstream } = await run(`console.log("hi", {a:1}); return await ctgov.version();`);
    expect(out.isError).toBeUndefined();
    expect(body).toEqual({
      ok: true,
      result: { apiVersion: "2.0.0" },
      logs: [{ level: "log", args: ["hi", { a: 1 }], ts: "<ts>" }],
      calls: [
        {
          id: "<id>",
          method: "GET",
          url: "https://clinicaltrials.gov/api/v2/version",
          status: 200,
          durationMs: "<ms>",
          cacheHit: false,
          bytes: 22,
        },
      ],
      durationMs: "<ms>",
      executor: kind,
    });
    expect(upstream.requests.map((r) => r.path)).toEqual(["/version"]);
  });

  maybe("maps an undefined return value to null", async () => {
    const { body } = await run(`return undefined;`);
    expect(body.ok).toBe(true);
    expect(body.result).toBeNull();
  });

  maybe("reports a thrown error as ok:false WITHOUT isError", async () => {
    const { out, body } = await run(`throw new Error("boom");`);
    expect(out.isError).toBeUndefined();
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe("boom");
    expect(body).not.toHaveProperty("result");
  });

  maybe("reports a wall-clock timeout as ok:false WITHOUT isError", async () => {
    const { out, body } = await run(`while (true) {}`, { timeoutMs: 500 });
    expect(out.isError).toBeUndefined();
    expect(body.ok).toBe(false);
    expect(body.error.code === "SANDBOX_TIMEOUT" || /timed out/i.test(body.error.message)).toBe(true);
  });
});

describe.skipIf(!isDenoAvailable())("execute envelope details specific to the Deno runner (v1)", () => {
  async function run(code: string) {
    const upstream = constantUpstream({ apiVersion: "2.0.0" });
    const c = await connect({ executor: new DenoExecutor(), dispatcher: upstream.agent });
    try {
      const out = await call(c, "execute", { code, timeoutMs: 1500 });
      return JSON.parse(out.texts[0]!) as Record<string, any>;
    } finally {
      await c.close();
      await upstream.close();
    }
  }

  it("orders the envelope keys ok, result, logs, calls, durationMs, executor", async () => {
    expect(Object.keys(await run(`return 1;`))).toEqual(["ok", "result", "logs", "calls", "durationMs", "executor"]);
  });

  it("surfaces a thrown error as {name (kept), message, stack, code: SANDBOX_ERROR}", async () => {
    const body = await run(`throw new TypeError("boom");`);
    expect(Object.keys(body)).toEqual(["ok", "error", "logs", "calls", "durationMs", "executor"]);
    expect(body.error).toMatchObject({ name: "TypeError", message: "boom", code: "SANDBOX_ERROR" });
    expect(typeof body.error.stack).toBe("string");
  });

  it("surfaces a timeout as SandboxTimeout / SANDBOX_TIMEOUT", async () => {
    const upstream = constantUpstream({});
    const c = await connect({ executor: new DenoExecutor(), dispatcher: upstream.agent });
    try {
      const out = await call(c, "execute", { code: `while (true) {}`, timeoutMs: 500 });
      expect(JSON.parse(out.texts[0]!).error).toEqual({
        name: "SandboxTimeout",
        message: "Sandbox wall-clock timeout",
        code: "SANDBOX_TIMEOUT",
      });
    } finally {
      await c.close();
      await upstream.close();
    }
  });

  it("flattens SDK errors raised inside the sandbox to a plain Error with SANDBOX_ERROR (the CtGovError code is lost)", async () => {
    const body = await run(`await ctgov.studies.get("bad");`);
    expect(body.ok).toBe(false);
    expect(body.error.name).toBe("Error");
    expect(body.error.code).toBe("SANDBOX_ERROR");
    expect(body.error.message).toContain("Invalid NCT ID");
    expect(body.calls).toEqual([]);
  });
});
