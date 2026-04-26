#!/usr/bin/env node
import { startStdioServer } from "./server/stdio.js";
import { startHttpServer } from "./server/http.js";
import { logger } from "./util/logger.js";
import type { SandboxMode } from "./sandbox/index.js";

interface ParsedArgs {
  transport: "stdio" | "http";
  sandbox?: SandboxMode;
  insecure?: boolean;
  port?: number;
  host?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { transport: "stdio" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") out.transport = "http";
    else if (a === "--stdio") out.transport = "stdio";
    else if (a === "--insecure") out.insecure = true;
    else if (a === "--port") {
      const v = argv[++i];
      if (v) out.port = Number(v);
    } else if (a === "--host") {
      const v = argv[++i];
      if (v) out.host = v;
    } else if (a === "--sandbox") {
      const v = argv[++i];
      if (v === "isolate" || v === "deno" || v === "auto") out.sandbox = v;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--version" || a === "-v") {
      // eslint-disable-next-line no-console
      console.log("@blen/clinicaltrial-mcp-server 0.1.0-alpha.0");
      process.exit(0);
    }
  }
  return out;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "clinicaltrial-mcp-server — code-mode MCP server for ClinicalTrials.gov",
      "",
      "Usage:",
      "  clinicaltrial-mcp-server [--stdio|--http] [--sandbox isolate|deno|auto]",
      "           [--port N] [--host ADDR] [--insecure]",
      "",
      "Transports:",
      "  --stdio   (default) stdio transport for local clients (Claude Desktop)",
      "  --http    Streamable HTTP transport for remote clients",
      "",
      "HTTP auth (required unless --insecure):",
      "  CTGOV_AUTH_PROVIDER=clerk",
      "  CTGOV_AUTH_ISSUER=https://<tenant>.clerk.accounts.dev",
      "  CTGOV_AUTH_RESOURCE=https://clinicaltrials.mcp.blencorp.com/mcp",
      "  CTGOV_AUTH_SCOPES=ctgov.read",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.transport === "http") {
    const httpOpts: Parameters<typeof startHttpServer>[0] = {};
    if (opts.sandbox !== undefined) httpOpts.sandboxMode = opts.sandbox;
    if (opts.insecure !== undefined) httpOpts.insecure = opts.insecure;
    if (opts.port !== undefined) httpOpts.port = opts.port;
    if (opts.host !== undefined) httpOpts.host = opts.host;
    await startHttpServer(httpOpts);
    return;
  }
  await startStdioServer(opts.sandbox ? { sandboxMode: opts.sandbox } : {});
}

main().catch((err: unknown) => {
  logger.error("server.fatal", {
    err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
  });
  process.exit(1);
});
