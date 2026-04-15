import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  isDenoAvailable,
  isIsolateAvailable,
  selectSandbox,
  type SandboxMode,
} from "../sandbox/index.js";
import { buildMcpServer } from "./mcpServer.js";
import { logger } from "../util/logger.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface StartOptions {
  sandboxMode?: SandboxMode;
  /** Subject attached to audit events when run in stdio (no OAuth). */
  subject?: string;
}

// Keep strong references for the process lifetime. Some hosts restart quickly
// and we do not want transport/server objects becoming GC candidates after
// startStdioServer() returns.
let activeServer: Server | undefined;
let activeTransport: StdioServerTransport | undefined;
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
  const server = buildMcpServer(serverOpts);
  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    logger.error("transport.error", {
      err: { name: error.name, message: error.message, stack: error.stack },
    });
  };
  transport.onclose = () => {
    logger.warn("transport.close");
  };
  server.onerror = (error) => {
    logger.error("server.error", {
      err: { name: error.name, message: error.message, stack: error.stack },
    });
  };
  server.onclose = () => {
    logger.warn("server.close");
  };
  await server.connect(transport);
  activeServer = server;
  activeTransport = transport;
  logger.info("server.ready", { transport: "stdio", executor: executorLabel });
}
