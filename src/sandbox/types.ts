import type { ApiCallTrace } from "../supervisor/audit.js";
import type { RpcDispatch } from "../sdk/runtime.js";

export interface SandboxExecuteOptions {
  /** Source code of an async arrow function body OR full program. */
  code: string;
  /** Wall-clock timeout, ms. */
  timeoutMs?: number;
  /** Maximum heap, MB (isolate mode only). */
  memoryMb?: number;
  /** RPC dispatch function that calls the supervisor. */
  dispatch: RpcDispatch;
}

export interface SandboxLog {
  level: "log" | "info" | "warn" | "error";
  args: unknown[];
  ts: number;
}

export interface SandboxResult {
  ok: boolean;
  result?: unknown;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  logs: SandboxLog[];
  calls: ApiCallTrace[];
  durationMs: number;
  /** Which executor handled the request. */
  executor: "isolate" | "deno";
}

export interface SandboxExecutor {
  readonly kind: "isolate" | "deno";
  execute(opts: SandboxExecuteOptions): Promise<SandboxResult>;
  dispose?(): Promise<void> | void;
}
