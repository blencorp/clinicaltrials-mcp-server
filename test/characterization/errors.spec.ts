// Characterization: pins the tool error envelopes (isError + one compact JSON or text block), the
// SDK's own argument-validation and unknown-tool errors, and the execute errors. Pinned on v1,
// updated for the SDK v2 port (D1 unknown tool, D2 Ajv argument validation, D3 compact JSON, D5
// ok:false is isError) and for package C (C1 envelope, C5 named errors, C8 limits).
import { describe, expect, it } from "vitest";
import type { ExecuteOptions, ExecuteResult, RpcBridge, SandboxRunner } from "../../src/sandbox/types.js";
import { call, connect, constantUpstream, protocolError, type CallOutcome } from "./helpers.js";

/** A runner whose behaviour is a function of the bridge it is handed. */
function runnerWith(run: (opts: ExecuteOptions, rpc: RpcBridge) => Promise<ExecuteResult>): SandboxRunner {
  return { kind: "deno", available: async () => true, execute: run };
}

/** Forwards one SDK call and turns a failed dispatch into the error an uncaught throw would produce. */
const forward = (rpc: RpcBridge, path: string[], args: unknown[]): Promise<ExecuteResult> =>
  rpc.dispatch({ binding: "ctgov", path, args }).then((r) => (r.ok ? { ok: true, value: r.value, logs: [], durationMs: 0 } : { ok: false, error: r.error!, logs: [], durationMs: 0 }));

/** Parses the single text block of an execute envelope and checks it is compact JSON. */
function envelope(out: CallOutcome): Record<string, unknown> {
  expect(out.extraKeys).toEqual(["structuredContent"]);
  expect(out.texts).toHaveLength(1);
  const parsed = JSON.parse(out.texts[0]!) as Record<string, unknown>;
  expect(out.texts[0]).toBe(JSON.stringify(parsed));
  return parsed;
}

/** The SDK validates arguments against the advertised JSON Schema and answers a plain-text isError result. */
function validation(out: CallOutcome): string {
  expect(out.isError).toBe(true);
  expect(out.extraKeys).toEqual([]);
  expect(out.texts).toHaveLength(1);
  expect(out.texts[0]).toMatch(/^Input validation error: Invalid arguments for tool /);
  return out.texts[0]!;
}

describe("argument validation errors (SDK Ajv, before the handler)", () => {
  it("search_api without a query", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      expect(validation(await call(c, "search_api", {}))).toBe(
        "Input validation error: Invalid arguments for tool search_api: data must have required property 'query'",
      );
    } finally {
      await c.close();
    }
  });

  it("search_api with an out-of-range or non-integer k, and an unknown key (now rejected)", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      expect(validation(await call(c, "search_api", { query: "x", k: 100 }))).toContain("data/k must be <= 50");
      expect(validation(await call(c, "search_api", { query: "x", k: 1.5 }))).toContain("data/k must be integer");
      expect(validation(await call(c, "search_api", { query: "x", bogus: true }))).toContain("data must NOT have additional properties");
    } finally {
      await c.close();
    }
  });

  it("execute with empty code and an out-of-range timeout; {code} alone is valid (defaults are optional in the advertised schema)", async () => {
    const c = await connect({ sandbox: runnerWith(async () => ({ ok: true, value: 1, logs: [], durationMs: 0 })) });
    try {
      expect(validation(await call(c, "execute", { code: "", timeoutMs: 5 }))).toContain(
        "data/code must NOT have fewer than 1 characters, data/timeoutMs must be >= 100",
      );
      expect(validation(await call(c, "execute", { code: "x", timeoutMs: 60_001 }))).toContain("data/timeoutMs must be <= 60000");
      expect((await call(c, "execute", { code: "return 1" })).isError).toBeUndefined();
    } finally {
      await c.close();
    }
  });

  it("describe_schema needs exactly one of path and prefix", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      expect(validation(await call(c, "describe_schema", {}))).toContain("data must match exactly one schema in oneOf");
      expect(validation(await call(c, "describe_schema", { path: "a", prefix: "b" }))).toContain("data must match exactly one schema in oneOf");
    } finally {
      await c.close();
    }
  });
});

describe("tool errors and execute errors", () => {
  it("unknown tool: JSON-RPC -32602 'Tool nope not found' (a protocol error, no longer an isError result)", async () => {
    const c = await connect();
    try {
      expect(await protocolError(c, "nope", {})).toMatchObject({ code: -32602, message: expect.stringContaining("Tool nope not found") });
    } finally {
      await c.close();
    }
  });

  it("execute in docs-only mode is refused as an unknown tool (-32602), and no runner is ever consulted", async () => {
    let consulted = 0;
    const c = await connect({ tools: "docs-only" });
    c.deps.sandbox = runnerWith(async () => { consulted++; throw new Error("must not be called"); });
    try {
      expect(await protocolError(c, "execute", { code: "return 1" })).toMatchObject({ code: -32602, message: expect.stringContaining("Tool execute not found") });
      expect(consulted).toBe(0);
      expect(c.deps.tools).toBe("docs-only");
    } finally {
      await c.close();
    }
  });

  it("execute without a usable runner: an ok:false envelope SandboxUnavailable (was a thrown CtGovError INTERNAL_ERROR)", async () => {
    const c = await connect();
    try {
      const out = await call(c, "execute", { code: "return 1" });
      expect(out.isError).toBe(true);
      expect(envelope(out)).toMatchObject({ ok: false, logs: [], error: { name: "SandboxUnavailable" } });
    } finally {
      await c.close();
    }
  });

  it("a host-side error thrown by the runner is a plain text tool error 'Name: message' (was compact JSON {name, message})", async () => {
    const c = await connect({ sandbox: runnerWith(async () => { throw new RangeError("nope"); }) });
    try {
      const out = await call(c, "execute", { code: "return 1" });
      expect(out.isError).toBe(true);
      expect(out.texts).toEqual(["RangeError: nope"]);
    } finally {
      await c.close();
    }
  });

  it("nested studies.search keys: ValidationError with the flat-dotted-key hint (C7)", async () => {
    const c = await connect({ sandbox: runnerWith((_o, rpc) => forward(rpc, ["studies", "search"], [{ query: { cond: "x" }, filter: { geo: "y" } }])) });
    try {
      const out = await call(c, "execute", { code: "return 1" });
      expect(out.isError).toBe(true);
      expect(envelope(out).error).toEqual({
        name: "ValidationError",
        message:
          'studies.search() uses flat dotted keys, not nested objects. Replace { query: { ... }, filter: { ... } } with string keys like ' +
          '"query.cond", "query.term", "filter.overallStatus", "filter.geo".',
      });
    } finally {
      await c.close();
    }
  });

  it("upstream 404: NotFound with status 404 (was CtGovError NOT_FOUND)", async () => {
    const upstream = constantUpstream({ status: 404 });
    const c = await connect({ upstream, sandbox: runnerWith((_o, rpc) => forward(rpc, ["studies", "get"], ["NCT00000000"])) });
    try {
      const out = await call(c, "execute", { code: "return 1" });
      expect(envelope(out)).toMatchObject({ ok: false, error: { name: "NotFound", status: 404, message: "ClinicalTrials.gov: GET https://clinicaltrials.gov/api/v2/studies/NCT00000000 -> 404" } });
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await c.close();
      await upstream.close();
    }
  });

  it("a bad NCT ID is a bounded ValidationError (was a ZodError whose message was the raw issue JSON)", async () => {
    const c = await connect({ sandbox: runnerWith((_o, rpc) => forward(rpc, ["studies", "get"], ["nct1"])) });
    try {
      const body = envelope(await call(c, "execute", { code: "return 1" }));
      expect(body.error).toEqual({ name: "ValidationError", message: "studies.get: invalid arguments: nctId: Invalid NCT ID" });
    } finally {
      await c.close();
    }
  });

  it("hourly per-subject quota (C8, replaces the per-minute execute and upstream buckets): SubjectQuotaExceeded after the limit", async () => {
    const upstream = constantUpstream({ apiVersion: "2" });
    const sandbox = runnerWith(async (_o, rpc) => {
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await rpc.dispatch({ binding: "ctgov", path: ["version"], args: [] }));
      return { ok: true, value: results.map((r) => r.ok || r.error!.name), logs: [], durationMs: 0 };
    });
    const c = await connect({ upstream, sandbox, supervisor: { subjectRatePerHour: 2 }, requestCtx: { subject: "carol" } });
    try {
      expect(envelope(await call(c, "execute", { code: "return 1" })).value).toEqual([true, true, "SubjectQuotaExceeded"]);
      expect(upstream.requests).toHaveLength(2);
    } finally {
      await c.close();
      await upstream.close();
    }
  });

  it("execution cap (C8): a second concurrent execution of one caller gets Busy", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const sandbox = runnerWith(async () => { await held; return { ok: true, value: 1, logs: [], durationMs: 0 }; });
    const c = await connect({ sandbox, supervisor: { maxExecutionsPerSubject: 1 }, requestCtx: { subject: "dave" } });
    try {
      const first = call(c, "execute", { code: "return 1" });
      await new Promise((r) => setTimeout(r, 50));
      const second = await call(c, "execute", { code: "return 1" });
      expect(second.isError).toBe(true);
      expect(envelope(second)).toMatchObject({ ok: false, error: { name: "Busy", message: "You already have 1 executions running. Wait for one to finish." } });
      release();
      expect((await first).isError).toBeUndefined();
    } finally {
      await c.close();
    }
  });
});

describe("execute ok:false is reported WITH isError (D5)", () => {
  it("timeout and throw results keep the full envelope as text and structuredContent", async () => {
    const timeout: ExecuteResult = { ok: false, error: { name: "TimeoutError", message: "Execution exceeded 500ms" }, logs: [], durationMs: 500 };
    const thrown: ExecuteResult = { ok: false, error: { name: "Error", message: "boom", status: 418 }, logs: ["x"], durationMs: 3 };
    for (const result of [timeout, thrown]) {
      const c = await connect({ sandbox: runnerWith(async () => ({ ...result })) });
      try {
        const out = await call(c, "execute", { code: "return 1" });
        expect(out.isError).toBe(true);
        expect(JSON.parse(out.texts[0]!)).toEqual(result);
        expect(out.structured).toEqual(result);
      } finally {
        await c.close();
      }
    }
  });

  it("ok:true stays a plain result", async () => {
    const c = await connect({ sandbox: runnerWith(async () => ({ ok: true, value: 1, logs: [], durationMs: 0 })) });
    try {
      expect((await call(c, "execute", { code: "return 1" })).isError).toBeUndefined();
    } finally {
      await c.close();
    }
  });
});
