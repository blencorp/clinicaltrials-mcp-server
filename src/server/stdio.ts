import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Dispatcher } from "undici";
import type { SandboxKind } from "../sandbox/types.js";
import { buildSupervisor, resolveSupervisorConfig, type SupervisorConfig } from "../supervisor/index.js";
import { buildMcpServer } from "./mcpServer.js";
import type { CatalogDeps } from "./toolCatalog.js";
import { logger } from "../util/logger.js";

export interface StdioStartOptions {
  sandboxMode?: SandboxKind;
  /** undici dispatcher for upstream requests (tests). */
  dispatcher?: Dispatcher;
  /** Limits and upstream settings (bin.ts maps the environment onto this); defaults otherwise. */
  supervisor?: Partial<SupervisorConfig>;
  /** Prebuilt dependencies (tests). */
  deps?: CatalogDeps;
}

let processHooksInstalled = false;

function installProcessDiagnostics(): void {
  if (processHooksInstalled) return;
  processHooksInstalled = true;

  process.on("beforeExit", (code) => {
    logger.warn("process.beforeExit", { code });
  });
  process.on("exit", (code) => {
    logger.warn("process.exit", { code });
  });
  process.on("uncaughtException", (err) => {
    logger.error("process.uncaughtException", {
      err: { name: err.name, message: err.message, stack: err.stack },
    });
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error
      ? { name: reason.name, message: reason.message, stack: reason.stack }
      : { message: String(reason) };
    logger.error("process.unhandledRejection", { err });
  });
  process.on("disconnect", () => {
    logger.warn("process.disconnect");
  });
  process.stdin.on("end", () => {
    logger.warn("process.stdin.end");
  });
  process.stdin.on("close", () => {
    logger.warn("process.stdin.close");
  });
}

export async function startStdioServer(opts: StdioStartOptions = {}): Promise<void> {
  installProcessDiagnostics();
  const deps = opts.deps ?? await buildSupervisor(resolveSupervisorConfig({
    ...opts.supervisor,
    ...(opts.sandboxMode ? { sandbox: opts.sandboxMode } : {}),
    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
  }));
  // stdio is unauthenticated and single-tenant: there is no subject to scope quotas by.
  //
  // `serveStdio` reports every out-of-band failure (transport start, a throwing factory,
  // message-pump errors) through `onerror` and swallows it otherwise; without this the
  // process would log `server.ready` and then answer every request with -32603 in silence.
  serveStdio(() => buildMcpServer(deps), {
    onerror: (err) =>
      logger.error("stdio.error", { err: { name: err.name, message: err.message, stack: err.stack } }),
  });
  logger.info("server.ready", { transport: "stdio", executor: deps.sandbox?.kind ?? "none" });
}
