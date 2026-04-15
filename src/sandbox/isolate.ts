import { createRequire } from "node:module";
import type * as ivmTypes from "isolated-vm";
import { CtGovError } from "../supervisor/errors.js";
import { CTGOV_SDK_SHIM } from "../sdk/bindings.js";
import { validateUserCode } from "./policy.js";
import type {
  SandboxExecuteOptions,
  SandboxExecutor,
  SandboxLog,
  SandboxResult,
} from "./types.js";

/**
 * isolated-vm is a native addon. It may not be installed on every platform
 * (pre-built binaries are limited). We load it lazily so the Deno fallback
 * can be chosen at runtime without crashing at import time.
 */
type IvmModule = typeof ivmTypes;
let ivmModule: IvmModule | null | undefined;

function loadIvm(): IvmModule | null {
  if (ivmModule !== undefined) return ivmModule;
  try {
    const req = createRequire(import.meta.url);
    ivmModule = req("isolated-vm") as IvmModule;
  } catch {
    ivmModule = null;
  }
  return ivmModule;
}

export function isIsolateAvailable(): boolean {
  return loadIvm() !== null;
}

export class IsolateExecutor implements SandboxExecutor {
  readonly kind = "isolate" as const;

  async execute(opts: SandboxExecuteOptions): Promise<SandboxResult> {
    const ivm = loadIvm();
    if (!ivm) {
      throw new CtGovError("SANDBOX_ERROR", "isolated-vm not available");
    }
    validateUserCode(opts.code);

    const started = Date.now();
    const logs: SandboxLog[] = [];
    const isolate = new ivm.Isolate({ memoryLimit: opts.memoryMb ?? 64 });
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set("globalThis", jail.derefInto());

    // RPC: host function invoked by the SDK shim
    await jail.set("__host_rpc_sync", new ivm.Reference(async (method: string, argsJson: string) => {
      const args = argsJson ? JSON.parse(argsJson) : {};
      const result = await opts.dispatch(method, args);
      return result === undefined ? undefined : JSON.stringify(result);
    }));

    // Log bridge
    await jail.set("__host_log", new ivm.Reference((level: string, argsJson: string) => {
      logs.push({
        level: level as SandboxLog["level"],
        args: argsJson ? JSON.parse(argsJson) : [],
        ts: Date.now(),
      });
    }));

    const bootstrap = `
      const __host = {
        rpc: async function(method, args) {
          const out = await __host_rpc_sync.apply(undefined, [method, JSON.stringify(args || {})], { arguments: { copy: true }, result: { copy: true, promise: true } });
          return out === undefined ? undefined : JSON.parse(out);
        },
      };
      const console = {
        log:   (...a) => __host_log.applyIgnored(undefined, ["log",   JSON.stringify(a)], { arguments: { copy: true } }),
        info:  (...a) => __host_log.applyIgnored(undefined, ["info",  JSON.stringify(a)], { arguments: { copy: true } }),
        warn:  (...a) => __host_log.applyIgnored(undefined, ["warn",  JSON.stringify(a)], { arguments: { copy: true } }),
        error: (...a) => __host_log.applyIgnored(undefined, ["error", JSON.stringify(a)], { arguments: { copy: true } }),
      };
      ${CTGOV_SDK_SHIM}
      globalThis.console = console;
    `;

    try {
      const boot = await isolate.compileScript(bootstrap);
      await boot.run(context);

      const program = `
        (async () => {
          try {
            const __fn = async (ctgov) => { ${opts.code} };
            const __r = await __fn(globalThis.ctgov);
            return JSON.stringify({ ok: true, result: __r === undefined ? null : __r });
          } catch (e) {
            return JSON.stringify({ ok: false, error: { name: e && e.name || "Error", message: String(e && e.message || e), stack: e && e.stack || undefined } });
          }
        })()
      `;
      const script = await isolate.compileScript(program);
      const resultStr = (await script.run(context, {
        timeout: opts.timeoutMs ?? 15_000,
        promise: true,
      })) as string;

      const parsed = JSON.parse(resultStr) as Omit<SandboxResult, "logs" | "calls" | "durationMs" | "executor">;
      return {
        ...parsed,
        logs,
        calls: [],
        durationMs: Date.now() - started,
        executor: "isolate",
      };
    } catch (err) {
      const isTimeout = err instanceof Error && /script execution timed out/i.test(err.message);
      const isMem =
        err instanceof Error && /isolate.*(memory|oom|disposed)/i.test(err.message);
      return {
        ok: false,
        error: {
          name: err instanceof Error ? err.name : "Error",
          message: err instanceof Error ? err.message : String(err),
          code: isTimeout ? "SANDBOX_TIMEOUT" : isMem ? "SANDBOX_MEMORY" : "SANDBOX_ERROR",
        },
        logs,
        calls: [],
        durationMs: Date.now() - started,
        executor: "isolate",
      };
    } finally {
      try {
        context.release();
      } catch {
        /* ignore */
      }
      try {
        isolate.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}
