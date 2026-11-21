// Characterization: pins the tool error envelopes (isError + one compact JSON text block), the SDK's
// own argument-validation and unknown-tool errors, and that execute ok:false now sets isError.
// Pinned on v1 originally; updated for the SDK v2 port against the expected-diff list in
// docs/migration-0.1.md (D1 unknown tool, D2 Ajv argument validation, D3 compact JSON, D4 zod 4
// issues, D5 ok:false is isError).
import { describe, expect, it } from "vitest";
import type { SandboxExecuteOptions, SandboxExecutor, SandboxResult } from "../../src/sandbox/types.js";
import { SubjectQuota } from "../../src/supervisor/subjectQuota.js";
import { call, connect, constantUpstream, protocolError, type CallOutcome } from "./helpers.js";

/** An executor whose behaviour is a function of the dispatch it is handed. */
function executorWith(run: (opts: SandboxExecuteOptions) => Promise<Omit<SandboxResult, "calls">>): SandboxExecutor {
  return {
    kind: "deno",
    async execute(opts) {
      return { ...(await run(opts)), calls: [] };
    },
  };
}

/** Parses the single text block of an error envelope and checks it is compact JSON. */
function envelope(out: CallOutcome): Record<string, unknown> {
  expect(out.isError).toBe(true);
  expect(out.extraKeys).toEqual([]);
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
      expect(validation(await call(c, "search_api", { query: "x", k: 100 }))).toContain("data/k must be <= 25");
      expect(validation(await call(c, "search_api", { query: "x", k: 1.5 }))).toContain("data/k must be integer");
      expect(validation(await call(c, "search_api", { query: "x", bogus: true }))).toContain(
        "data must NOT have additional properties",
      );
    } finally {
      await c.close();
    }
  });

  it("execute with empty code and an out-of-range timeout", async () => {
    const c = await connect({ executor: executorWith(async () => ({ ok: true, logs: [], durationMs: 0, executor: "deno" })) });
    try {
      expect(validation(await call(c, "execute", { code: "", timeoutMs: 5 }))).toContain(
        "data/code must NOT have fewer than 1 characters, data/timeoutMs must be >= 100",
      );
    } finally {
      await c.close();
    }
  });

  it("describe_schema needs exactly one of path and prefix", async () => {
    const c = await connect({ tools: "docs-only" });
    try {
      expect(validation(await call(c, "describe_schema", {}))).toContain("data must match exactly one schema in oneOf");
      expect(validation(await call(c, "describe_schema", { path: "a", prefix: "b" }))).toContain(
        "data must match exactly one schema in oneOf",
      );
    } finally {
      await c.close();
    }
  });
});

describe("CtGovError envelopes (compact JSON)", () => {
  it("unknown tool: JSON-RPC -32602 'Tool nope not found' (a protocol error, no longer an isError result)", async () => {
    const c = await connect({});
    try {
      expect(await protocolError(c, "nope", {})).toMatchObject({ code: -32602, message: expect.stringContaining("Tool nope not found") });
    } finally {
      await c.close();
    }
  });

  it("execute in docs-only mode is refused as an unknown tool (-32602), and never resolves a sandbox", async () => {
    let resolved = 0;
    const c = await connect({
      tools: "docs-only",
      resolveExecutor: () => {
        resolved++;
        throw new Error("must not be called");
      },
    });
    try {
      expect(await protocolError(c, "execute", { code: "return 1" })).toMatchObject({
        code: -32602,
        message: expect.stringContaining("Tool execute not found"),
      });
      expect(resolved).toBe(0);
    } finally {
      await c.close();
    }
  });

  it("execute without an executor: INTERNAL_ERROR", async () => {
    const c = await connect({});
    try {
      expect(envelope(await call(c, "execute", { code: "return 1" }))).toEqual({
        name: "CtGovError",
        code: "INTERNAL_ERROR",
        message: "sandbox executor not configured",
      });
    } finally {
      await c.close();
    }
  });

  it("a host-side error thrown by the executor that is not a CtGovError keeps only name and message", async () => {
    const c = await connect({
      executor: executorWith(async () => {
        throw new RangeError("nope");
      }),
    });
    try {
      expect(envelope(await call(c, "execute", { code: "return 1" }))).toEqual({ name: "RangeError", message: "nope" });
    } finally {
      await c.close();
    }
  });

  it("nested studies.search keys: VALIDATION_ERROR with the flat-dotted-key hint", async () => {
    const c = await connect({
      executor: executorWith(async (opts) => {
        await opts.dispatch("studies.search", { query: { cond: "x" }, filter: { geo: "y" } });
        return { ok: true, logs: [], durationMs: 0, executor: "deno" };
      }),
    });
    try {
      expect(envelope(await call(c, "execute", { code: "return 1" }))).toEqual({
        name: "CtGovError",
        code: "VALIDATION_ERROR",
        message:
          'studies.search() uses flat dotted keys, not nested objects. Replace { query, filter: { ... } } with string keys like ' +
          '"query.cond", "query.term", "filter.overallStatus", "filter.geo".',
      });
    } finally {
      await c.close();
    }
  });

  it("upstream 404: NOT_FOUND with status 404", async () => {
    const upstream = constantUpstream({ status: 404 });
    const c = await connect({
      dispatcher: upstream.agent,
      executor: executorWith(async (opts) => {
        await opts.dispatch("studies.get", { nctId: "NCT00000000" });
        return { ok: true, logs: [], durationMs: 0, executor: "deno" };
      }),
    });
    try {
      expect(envelope(await call(c, "execute", { code: "return 1" }))).toEqual({
        name: "CtGovError",
        code: "NOT_FOUND",
        message: "Resource not found: /studies/NCT00000000",
        status: 404,
      });
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await c.close();
      await upstream.close();
    }
  });

  it("a bad NCT ID surfaces as a ZodError envelope (not a CtGovError)", async () => {
    const c = await connect({
      executor: executorWith(async (opts) => {
        await opts.dispatch("studies.get", { nctId: "nct1" });
        return { ok: true, logs: [], durationMs: 0, executor: "deno" };
      }),
    });
    try {
      const env = envelope(await call(c, "execute", { code: "return 1" }));
      expect(env.name).toBe("ZodError");
      expect(JSON.parse(env.message as string)).toEqual([
        { origin: "string", code: "invalid_format", format: "regex", pattern: "/^NCT[0-9]{8}$/", path: ["nctId"], message: "Invalid NCT ID" },
      ]);
    } finally {
      await c.close();
    }
  });

  it("per-subject execute quota: RATE_LIMITED after the burst of 4", async () => {
    const quota = new SubjectQuota({ executeRpm: 6 });
    const c = await connect({
      quota,
      subject: "alice",
      executor: executorWith(async () => ({ ok: true, result: 1, logs: [], durationMs: 0, executor: "deno" })),
    });
    try {
      for (let i = 0; i < 4; i++) expect((await call(c, "execute", { code: "return 1" })).isError).toBeUndefined();
      expect(envelope(await call(c, "execute", { code: "return 1" }))).toEqual({
        name: "CtGovError",
        code: "RATE_LIMITED",
        message: "execute quota exceeded for subject (limit 6/min)",
      });
      // The quota is per subject: another subject has its own bucket.
      const other = await connect({
        quota,
        subject: "bob",
        executor: executorWith(async () => ({ ok: true, result: 1, logs: [], durationMs: 0, executor: "deno" })),
      });
      try {
        expect((await call(other, "execute", { code: "return 1" })).isError).toBeUndefined();
      } finally {
        await other.close();
      }
    } finally {
      await c.close();
    }
  });

  it("per-subject upstream quota: RATE_LIMITED once the 10-call burst is spent", async () => {
    const upstream = constantUpstream({ studies: [] });
    const quota = new SubjectQuota({ upstreamRpm: 60 });
    const c = await connect({
      quota,
      subject: "carol",
      dispatcher: upstream.agent,
      executor: executorWith(async (opts) => {
        for (let i = 0; i < 11; i++) await opts.dispatch("studies.get", { nctId: `NCT${String(i).padStart(8, "0")}` });
        return { ok: true, logs: [], durationMs: 0, executor: "deno" };
      }),
    });
    try {
      expect(envelope(await call(c, "execute", { code: "return 1" }))).toEqual({
        name: "CtGovError",
        code: "RATE_LIMITED",
        message: "upstream quota exceeded for subject (limit 60/min)",
      });
      expect(upstream.requests).toHaveLength(10);
    } finally {
      await c.close();
      await upstream.close();
    }
  });
});

describe("execute ok:false is reported WITH isError (D5)", () => {
  it("timeout and throw results are isError and keep the full envelope as text and structuredContent", async () => {
    const timeout: Omit<SandboxResult, "calls"> = {
      ok: false,
      error: { name: "SandboxTimeout", message: "Sandbox wall-clock timeout", code: "SANDBOX_TIMEOUT" },
      logs: [],
      durationMs: 500,
      executor: "deno",
    };
    const thrown: Omit<SandboxResult, "calls"> = {
      ok: false,
      error: { name: "Error", message: "boom", stack: "Error: boom\n    at <anonymous>", code: "SANDBOX_ERROR" },
      logs: [],
      durationMs: 3,
      executor: "deno",
    };
    for (const result of [timeout, thrown]) {
      const c = await connect({ executor: executorWith(async () => ({ ...result })) });
      try {
        const out = await call(c, "execute", { code: "return 1" });
        expect(out.isError).toBe(true);
        expect(JSON.parse(out.texts[0]!)).toEqual({ ...result, calls: [] });
        expect(out.structured).toEqual({ ...result, calls: [] });
      } finally {
        await c.close();
      }
    }
  });

  it("ok:true stays a plain result", async () => {
    const c = await connect({ executor: executorWith(async () => ({ ok: true, result: 1, logs: [], durationMs: 0, executor: "deno" })) });
    try {
      expect((await call(c, "execute", { code: "return 1" })).isError).toBeUndefined();
    } finally {
      await c.close();
    }
  });
});
