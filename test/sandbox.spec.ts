import { describe, it, expect } from "vitest";
import { isAnySandboxAvailable, selectSandbox } from "../src/sandbox/index.js";
import type { RpcDispatch } from "../src/sdk/runtime.js";

function makeDispatch(): RpcDispatch {
  return async (method, args) => {
    if (method === "studies.search") {
      const a = args as { "query.cond"?: string; pageSize?: number };
      return {
        studies: [
          { protocolSection: { identificationModule: { nctId: "NCT00000001", briefTitle: "Test A" } } },
          { protocolSection: { identificationModule: { nctId: "NCT00000002", briefTitle: "Test B" } } },
        ],
        totalCount: 2,
        _echo: a,
      };
    }
    if (method === "version") return { apiVersion: "mock" };
    throw new Error(`unmocked ${method}`);
  };
}

describe.skipIf(!isAnySandboxAvailable())("sandbox executor", () => {
  it("runs a simple program and returns a value", async () => {
    const exec = selectSandbox({ mode: "auto" });
    const out = await exec.execute({
      code: `const p = await ctgov.studies.search({ "query.cond": "flu" }); return p.studies.length;`,
      timeoutMs: 5000,
      dispatch: makeDispatch(),
    });
    expect(out.ok).toBe(true);
    expect(out.result).toBe(2);
    expect(["isolate", "deno"]).toContain(out.executor);
  });

  it("captures console.log into logs", async () => {
    const exec = selectSandbox({ mode: "auto" });
    const out = await exec.execute({
      code: `console.log("hello", 1); return 42;`,
      timeoutMs: 5000,
      dispatch: makeDispatch(),
    });
    expect(out.ok).toBe(true);
    expect(out.logs.length).toBeGreaterThan(0);
    expect(out.logs[0]?.level).toBe("log");
  });

  it("rejects code with blocked identifier before execution", async () => {
    const exec = selectSandbox({ mode: "auto" });
    await expect(
      exec.execute({
        code: `return process.env.HOME;`,
        dispatch: makeDispatch(),
      }),
    ).rejects.toThrow(/blocked identifier/);
  });

  it("propagates errors from sandboxed code without crashing host", async () => {
    const exec = selectSandbox({ mode: "auto" });
    const out = await exec.execute({
      code: `throw new Error("boom");`,
      timeoutMs: 5000,
      dispatch: makeDispatch(),
    });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toMatch(/boom/);
  });

  it("times out long-running code", async () => {
    const exec = selectSandbox({ mode: "auto" });
    const out = await exec.execute({
      code: `while (true) {}`,
      timeoutMs: 500,
      dispatch: makeDispatch(),
    });
    expect(out.ok).toBe(false);
    expect(out.error?.code === "SANDBOX_TIMEOUT" || /timed out/i.test(out.error?.message ?? "")).toBe(true);
  });
});
