import { logger } from "../util/logger.js";
import { CtGovError } from "../supervisor/errors.js";
import { DenoExecutor, isDenoAvailable } from "./deno.js";
import { IsolateExecutor, isIsolateAvailable } from "./isolate.js";
import type { SandboxExecuteOptions, SandboxExecutor, SandboxResult } from "./types.js";

export type SandboxMode = "auto" | "isolate" | "deno";

export interface SelectOptions {
  mode?: SandboxMode;
}

export { isIsolateAvailable, isDenoAvailable };

/**
 * Returns true when at least one of `isolated-vm` or `deno` is available
 * on this host. Useful for tests to skip cleanly when the developer
 * machine has neither toolchain configured.
 */
export function isAnySandboxAvailable(): boolean {
  return isIsolateAvailable() || isDenoAvailable();
}

export function selectSandbox(opts: SelectOptions = {}): SandboxExecutor {
  const mode = opts.mode ?? (process.env.CTGOV_SANDBOX as SandboxMode | undefined) ?? "auto";

  if (mode === "isolate") {
    if (!isIsolateAvailable()) {
      throw new CtGovError("SANDBOX_ERROR", "isolated-vm not installed");
    }
    logger.info("sandbox.selected", { executor: "isolate", forced: true });
    return new IsolateExecutor();
  }

  if (mode === "deno") {
    if (!isDenoAvailable()) {
      throw new CtGovError("SANDBOX_ERROR", "deno binary not on PATH");
    }
    logger.info("sandbox.selected", { executor: "deno", forced: true });
    return new DenoExecutor();
  }

  // auto: prefer isolate, fall back to deno.
  if (isIsolateAvailable()) {
    logger.info("sandbox.selected", { executor: "isolate" });
    return new IsolateExecutor();
  }
  if (isDenoAvailable()) {
    logger.info("sandbox.selected", { executor: "deno" });
    return new DenoExecutor();
  }

  throw new CtGovError(
    "SANDBOX_ERROR",
    "No sandbox executor available. Install isolated-vm (`pnpm add isolated-vm`) or the Deno CLI (`curl -fsSL https://deno.land/install.sh | sh`).",
  );
}

export type { SandboxExecuteOptions, SandboxExecutor, SandboxResult };
