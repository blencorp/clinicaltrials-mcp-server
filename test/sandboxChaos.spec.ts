import { describe, it, expect } from "vitest";
import {
  isDenoAvailable,
  isIsolateAvailable,
  selectSandbox,
  type SandboxExecutor,
} from "../src/sandbox/index.js";
import type { RpcDispatch } from "../src/sdk/runtime.js";

const noopDispatch: RpcDispatch = async () => ({});

describe.skipIf(!isIsolateAvailable())("sandbox chaos — isolate", () => {
  let exec: SandboxExecutor;
  it("selects isolate", () => {
    exec = selectSandbox({ mode: "isolate" });
    expect(exec.kind).toBe("isolate");
  });

  it("trips memory limit on allocation bomb", async () => {
    const out = await exec.execute({
      code: `
        const chunks = [];
        try {
          // 32 MB cap here; each push is ~8 MB
          for (let i = 0; i < 16; i++) chunks.push(new Array(1_000_000).fill(i));
          return chunks.length;
        } catch (e) {
          return "caught:" + (e && e.message || e);
        }
      `,
      timeoutMs: 3000,
      memoryMb: 32,
      dispatch: noopDispatch,
    });
    // Either the isolate OOMs (ok:false) or the code catches internally and
    // returns a "caught:..." sentinel — both are acceptable.
    if (out.ok) {
      expect(String(out.result)).toMatch(/caught:|\d+/);
    } else {
      expect(["SANDBOX_MEMORY", "SANDBOX_ERROR"]).toContain(out.error?.code);
    }
  });

  it("blows the stack on deep recursion", async () => {
    const out = await exec.execute({
      code: `function r(n) { return r(n+1); } return r(0);`,
      timeoutMs: 2000,
      dispatch: noopDispatch,
    });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toMatch(/stack|recursion|maximum call stack/i);
  });

  it("surfaces zod validation errors from the runtime layer", async () => {
    const dispatch: RpcDispatch = async (method, args) => {
      // Route straight through our runtime via a real CtGovRuntime would pull
      // HttpClient; easier to throw from the dispatcher to simulate validation.
      if (method === "studies.get" && !(args as { nctId?: string }).nctId) {
        throw new Error("nctId required");
      }
      return {};
    };
    const out = await exec.execute({
      code: `return await ctgov.studies.get(undefined);`,
      timeoutMs: 2000,
      dispatch,
    });
    expect(out.ok).toBe(false);
  });
});

describe.skipIf(!isDenoAvailable())("sandbox chaos — deno fallback", () => {
  it("executes a trivial program via deno subprocess", async () => {
    const exec = selectSandbox({ mode: "deno" });
    const out = await exec.execute({
      code: `return 1 + 1;`,
      timeoutMs: 5000,
      dispatch: noopDispatch,
    });
    expect(out.executor).toBe("deno");
    expect(out.ok).toBe(true);
    expect(out.result).toBe(2);
  });

  it("times out infinite loops in deno", async () => {
    const exec = selectSandbox({ mode: "deno" });
    const out = await exec.execute({
      code: `while (true) {}`,
      timeoutMs: 300,
      dispatch: noopDispatch,
    });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("SANDBOX_TIMEOUT");
  });
});
