import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  isDenoAvailable,
  isIsolateAvailable,
  selectSandbox,
  type SandboxMode,
} from "../sandbox/index.js";
import type { Dispatcher } from "undici";
import { buildMcpServer } from "./mcpServer.js";
import { logger } from "../util/logger.js";

export interface StartOptions {
  sandboxMode?: SandboxMode;
  /** Subject attached to audit events when run in stdio (no OAuth). */
  subject?: string;
  /** undici dispatcher for upstream requests (tests). */
  dispatcher?: Dispatcher;
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

export async function startStdioServer(opts: StartOptions = {}): Promise<void> {
  installProcessDiagnostics();
  const executorLabel = isIsolateAvailable()
    ? "isolate"
    : isDenoAvailable()
      ? "deno"
      : "unavailable";
  const serverOpts: Parameters<typeof buildMcpServer>[0] = {
    resolveExecutor: () => selectSandbox(opts.sandboxMode ? { mode: opts.sandboxMode } : {}),
  };
  if (opts.subject !== undefined) serverOpts.subject = opts.subject;
  if (opts.dispatcher !== undefined) serverOpts.dispatcher = opts.dispatcher;
  // `serveStdio` reports every out-of-band failure (transport start, a throwing factory,
  // message-pump errors) through `onerror` and swallows it otherwise; without this the
  // process would log `server.ready` and then answer every request with -32603 in silence.
  serveStdio(() => buildMcpServer(serverOpts), {
    onerror: (err) =>
      logger.error("stdio.error", { err: { name: err.name, message: err.message, stack: err.stack } }),
  });
  logger.info("server.ready", { transport: "stdio", executor: executorLabel });
}
