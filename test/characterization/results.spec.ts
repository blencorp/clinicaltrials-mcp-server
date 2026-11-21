// Characterization: pins the result shapes of search_api, describe_schema and execute, as the MCP
// client sees them. Pinned on v1 originally; updated for the SDK v2 port (D3 compact JSON +
// structuredContent, D5 ok:false is isError) and for package C: D6 is superseded by C9 (search_api
// is {hits, note}, describe_schema is {found, entries | message}, shared with the other BLEN
// code-mode servers) and C1 (the execute envelope is {ok, value, logs, error, durationMs}).
import { describe, expect, it } from "vitest";
import { DenoRunner } from "../../src/sandbox/deno.js";
import { IsolateRunner } from "../../src/sandbox/isolate.js";
import type { ExecuteOptions, ExecuteResult, RpcBridge, SandboxRunner } from "../../src/sandbox/types.js";
import { call, connect, constantUpstream, normalizeExecute } from "./helpers.js";

const fixture = (name: string): string => new URL(`./__fixtures__/${name}`, import.meta.url).pathname;

describe("search_api result (C9)", () => {
  it("returns one compact JSON text block {hits, note} that is also the structuredContent", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      const out = await call(c, "search_api", { query: "search studies by condition and status" });
      expect(out.isError).toBeUndefined();
      expect(out.extraKeys).toEqual(["structuredContent"]);
      expect(out.texts).toHaveLength(1);
      const body = JSON.parse(out.texts[0]!) as { hits: Array<Record<string, unknown>>; note: string };
      expect(out.texts[0]).toBe(JSON.stringify(body));
      expect(Object.keys(body)).toEqual(["hits", "note"]);
      expect(out.structured).toEqual(body);
      expect(body.hits).toHaveLength(10); // k defaults to 10
      expect(body.hits[0]).toMatchObject({ id: "ctgov.studies.search", kind: "endpoint", binding: "ctgov" });
      expect(Object.keys(body.hits[0]!)).toEqual(["id", "kind", "binding", "description", "signature", "example", "score"]);
      // The score moves with every corpus edit, so it is checked for type and left out of the fixture.
      const { score, ...entry } = body.hits[0]!;
      expect(typeof score).toBe("number");
      await expect(JSON.stringify(entry, null, 2)).toMatchFileSnapshot(fixture("search_api.top-hit.json"));
    } finally {
      await c.close();
    }
  });

  it("honours k, up to 50", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      expect(((await call(c, "search_api", { query: "recruiting studies by condition", k: 1 })).structured as { hits: unknown[] }).hits).toHaveLength(1);
      expect((await call(c, "search_api", { query: "x", k: 51 })).isError).toBe(true);
    } finally {
      await c.close();
    }
  });

  it("returns no hits (not an error) when nothing matches", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      const out = await call(c, "search_api", { query: "zzzqqqxxx" });
      expect(out.isError).toBeUndefined();
      expect((out.structured as { hits: unknown[] }).hits).toEqual([]);
    } finally {
      await c.close();
    }
  });
});

describe("describe_schema result (C9)", () => {
  async function describeSchema(args: Record<string, unknown>) {
    const c = await connect({ tools: "docs-only" });
    try {
      const out = await call(c, "describe_schema", args);
      expect(out.isError).toBeUndefined();
      expect(out.extraKeys).toEqual(["structuredContent"]);
      expect(out.texts).toHaveLength(1);
      // A single compact JSON block, also served as structuredContent.
      const parsed = JSON.parse(out.texts[0]!) as { found: boolean; entries?: Array<Record<string, unknown>>; message?: string };
      expect(out.texts[0]).toBe(JSON.stringify(parsed));
      expect(out.structured).toEqual(parsed);
      // The fixtures use a 2-space layout so they stay reviewable.
      return { text: JSON.stringify(parsed, null, 2), parsed };
    } finally {
      await c.close();
    }
  }

  it("by exact path", async () => {
    const { parsed } = await describeSchema({ path: "ctgov.fields.protocolSection.identificationModule.nctId" });
    expect(parsed).toEqual({
      found: true,
      entries: [
        {
          id: "ctgov.fields.protocolSection.identificationModule.nctId",
          kind: "field",
          binding: "ctgov",
          description: "Primary NCT identifier, e.g. NCT04852770. (string)",
        },
      ],
    });
  });

  it("by prefix", async () => {
    const { text, parsed } = await describeSchema({ prefix: "ctgov.fields.protocolSection.statusModule" });
    expect(parsed.entries).toHaveLength(4);
    await expect(text).toMatchFileSnapshot(fixture("describe_schema.prefix.json"));
  });

  it("with neither path nor prefix is rejected (D2); v1 returned every field", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      const out = await call(c, "describe_schema", {});
      expect(out.isError).toBe(true);
      expect(out.texts[0]).toContain("must match exactly one schema in oneOf");
    } finally {
      await c.close();
    }
  });

  it("returns found:false with a message (not an error) for an unknown path or prefix", async () => {
    expect((await describeSchema({ path: "nope.nothing" })).parsed).toEqual({ found: false, message: "No entries matched path 'nope.nothing'." });
    expect((await describeSchema({ prefix: "nope." })).parsed).toEqual({ found: false, message: "No entries matched prefix 'nope.'." });
  });

  it("rejects path together with prefix (D2); v1 let path win", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      const out = await call(c, "describe_schema", { path: "ctgov.version", prefix: "ctgov.studies" });
      expect(out.isError).toBe(true);
    } finally {
      await c.close();
    }
  });
});

/** A hand-written SandboxRunner: records what it was asked to run and answers with `reply`. */
function fakeRunner(
  reply: (opts: ExecuteOptions, rpc: RpcBridge) => Promise<ExecuteResult>,
): SandboxRunner & { seen: ExecuteOptions[] } {
  const seen: ExecuteOptions[] = [];
  return {
    kind: "deno",
    seen,
    available: async () => true,
    async execute(opts, rpc) {
      seen.push(opts);
      return reply(opts, rpc);
    },
  };
}

describe("execute result with a fake SandboxRunner (C1)", () => {
  it("returns one compact JSON text block (and structuredContent) {ok, value, logs, durationMs}", async () => {
    const upstream = constantUpstream({ apiVersion: "2.0.0" });
    const sandbox = fakeRunner(async (_opts, rpc) => {
      const r = await rpc.dispatch({ binding: "ctgov", path: ["version"], args: [] });
      return { ok: r.ok, value: r.value, logs: ["hello 1"], durationMs: 7 };
    });
    const c = await connect({ sandbox, upstream });
    try {
      const out = await call(c, "execute", { code: "return await ctgov.version();" });
      expect(out.isError).toBeUndefined();
      expect(out.extraKeys).toEqual(["structuredContent"]);
      expect(out.texts).toHaveLength(1);
      expect(out.texts[0]).toBe(JSON.stringify(JSON.parse(out.texts[0]!)));
      expect(out.structured).toEqual(JSON.parse(out.texts[0]!));
      expect(Object.keys(JSON.parse(out.texts[0]!))).toEqual(["ok", "value", "logs", "durationMs"]);
      expect(normalizeExecute(out.texts[0]!)).toEqual({ ok: true, value: { apiVersion: "2.0.0" }, logs: ["hello 1"], durationMs: "<ms>" });
      expect(upstream.requests.map((r) => r.path)).toEqual(["/version"]);
    } finally {
      await c.close();
      await upstream.close();
    }
  });

  it("passes code and the zod defaults (timeoutMs 15000, memoryMb 64) to the runner, plus the registered bindings", async () => {
    const sandbox = fakeRunner(async () => ({ ok: true, value: null, logs: [], durationMs: 0 }));
    const c = await connect({ sandbox });
    try {
      await call(c, "execute", { code: "return 1" });
      await call(c, "execute", { code: "return 2", timeoutMs: 1234, memoryMb: 32 });
      expect(sandbox.seen.map((o) => ({ code: o.code, timeoutMs: o.timeoutMs, memoryMb: o.memoryMb, bindings: o.bindings }))).toEqual([
        { code: "return 1", timeoutMs: 15_000, memoryMb: 64, bindings: ["ctgov"] },
        { code: "return 2", timeoutMs: 1234, memoryMb: 32, bindings: ["ctgov"] },
      ]);
      expect(sandbox.seen[0]!.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await c.close();
    }
  });
});

const REAL_RUNNERS = [new IsolateRunner(), new DenoRunner()];

describe.each(REAL_RUNNERS)("execute with the real $kind runner against a MockAgent (C1)", (runner) => {
  async function run(code: string, extra: Record<string, unknown> = {}) {
    const upstream = constantUpstream({ apiVersion: "2.0.0" });
    const c = await connect({ sandbox: runner, upstream });
    try {
      const out = await call(c, "execute", { code, timeoutMs: 1500, ...extra });
      expect(out.texts).toHaveLength(1);
      return { out, body: normalizeExecute(out.texts[0]!) as Record<string, any>, upstream };
    } finally {
      await c.close();
      await upstream.close();
    }
  }

  it("runs ctgov.version() through the dispatch and returns logs as strings", async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { out, body, upstream } = await run(`console.log("hi", {a:1}); return await ctgov.version();`);
    expect(out.isError).toBeUndefined();
    expect(body).toEqual({ ok: true, value: { apiVersion: "2.0.0" }, logs: ['hi {"a":1}'], durationMs: "<ms>" });
    expect(upstream.requests.map((r) => r.path)).toEqual(["/version"]);
  });

  it("maps an undefined return value to null", async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { body } = await run(`return undefined;`);
    expect(body.ok).toBe(true);
    expect(body.value).toBeNull();
  });

  it("reports a thrown error as ok:false WITH isError (D5): {name, message}, no stack, no code", async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { out, body } = await run(`throw new TypeError("boom");`);
    expect(out.isError).toBe(true);
    expect(body).toEqual({ ok: false, logs: [], error: { name: "TypeError", message: "boom" }, durationMs: "<ms>" });
  });

  it("reports a wall-clock timeout as ok:false WITH isError, named TimeoutError", async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { out, body } = await run(`while (true) {}`, { timeoutMs: 500 });
    expect(out.isError).toBe(true);
    expect(body.error).toEqual({ name: "TimeoutError", message: "Execution exceeded 500ms" });
  });

  it("keeps an SDK error's name, message and status (was flattened to Error/SANDBOX_ERROR)", async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { body, upstream } = await run(`await ctgov.studies.get("bad");`);
    expect(body.ok).toBe(false);
    expect(body.error).toEqual({ name: "ValidationError", message: "studies.get: invalid arguments: nctId: Invalid NCT ID" });
    expect(upstream.requests).toEqual([]);
  });

  it("refuses code that breaks the policy before running it", async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { out, body } = await run("return globalThis;");
    expect(out.isError).toBe(true);
    expect(body.error.name).toBe("PolicyError");
  });
});
