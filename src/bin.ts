#!/usr/bin/env node
import { startStdioServer } from "./server/stdio.js";
import { startHttpServer, type HttpServerOptions } from "./server/http.js";
import { DEFAULT_SCOPE, type AuthProvider } from "./server/authz.js";
import { SERVER_VERSION } from "./server/mcpServer.js";
import { logger } from "./util/logger.js";
import type { SandboxMode } from "./sandbox/index.js";

interface ParsedArgs {
  transport: "stdio" | "http";
  sandbox: SandboxMode;
  insecure: boolean;
  publicDocs: boolean;
  port: number;
  host: string;
}

/** A positive number (and at least `min`) from the environment, or `fallback` when unset or invalid. */
function positive(value: string | undefined, fallback: number, min = 0): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n > 0 && n >= min ? n : fallback;
}

/** A comma- or whitespace-separated list, lowercased when `lower`. Empty when unset. */
function list(value: string | undefined, lower = false): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => (lower ? s.trim().toLowerCase() : s.trim()))
    .filter(Boolean);
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  const args: ParsedArgs = {
    transport: "stdio",
    sandbox: ((env.CTGOV_SANDBOX as SandboxMode | undefined) ?? "auto"),
    insecure: false,
    publicDocs: false,
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
  };
  let hostExplicit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.transport = "http";
    else if (a === "--stdio") args.transport = "stdio";
    else if (a === "--insecure") args.insecure = true;
    else if (a === "--public-docs") args.publicDocs = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--host") {
      args.host = String(argv[++i]);
      hostExplicit = true;
    } else if (a === "--sandbox") args.sandbox = argv[++i] as SandboxMode;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--version" || a === "-v") {
      process.stdout.write(`@blen/clinicaltrial-mcp-server ${SERVER_VERSION}\n`);
      process.exit(0);
    }
    // The separator some runners pass through (`pnpm dev -- --http`).
    else if (a === "--") continue;
    // A mistyped --http must not quietly start the stdio transport instead.
    else throw new Error(`Unknown option '${a}'. Run with --help to see the options.`);
  }
  if (!["auto", "isolate", "deno"].includes(args.sandbox)) {
    throw new Error(`Unknown sandbox '${args.sandbox}'. Use auto, isolate or deno.`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    throw new Error(`Invalid port '${String(args.port)}'.`);
  }
  // An unauthenticated development server listens on loopback unless --host says otherwise: the
  // ambient HOST (0.0.0.0 in the Docker image) deliberately does not widen it.
  if (args.insecure && !hostExplicit) args.host = "127.0.0.1";
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "clinicaltrial-mcp-server: code-mode MCP server for ClinicalTrials.gov",
      "",
      "Usage:",
      "  clinicaltrial-mcp-server [--stdio|--http] [--sandbox isolate|deno|auto]",
      "           [--port N] [--host ADDR] [--public-docs | --insecure]",
      "",
      "Transports:",
      "  --stdio   (default) stdio transport for local clients (Claude Desktop)",
      "  --http    Streamable HTTP transport for remote clients (stateless)",
      "",
      "HTTP modes (--public-docs and --insecure exclude each other and any auth provider):",
      "  (default)       authenticated; execute runs only in the Deno process sandbox",
      "  --public-docs   anonymous, docs-only: search_api + describe_schema, no execute",
      "  --insecure      local development only: no auth, binds 127.0.0.1 (only --host overrides)",
      "",
      "HTTP environment:",
      "  CTGOV_PUBLIC_ORIGIN    https://mcp.example.com (or CTGOV_ALLOWED_HOSTS) is required when",
      "                         binding beyond loopback: trusted Host values, DNS-rebinding defence",
      "  CTGOV_AUTH_PROVIDER    generic-oidc | clerk | workos | auth0",
      "  CTGOV_AUTH_ISSUER      trusted token issuer",
      "  CTGOV_AUTH_AUDIENCE    audience tokens must carry (this server's /mcp URL)",
      "  CTGOV_AUTH_JWKS_URL    https JWKS endpoint of the issuer",
      "  CTGOV_AUTH_SCOPES      scopes every token must carry (default ctgov:read)",
      "",
    ].join("\n"),
  );
}

function httpOptions(args: ParsedArgs, env: NodeJS.ProcessEnv): HttpServerOptions {
  const provider = (env.CTGOV_AUTH_PROVIDER?.trim() || "none") as AuthProvider;
  const clientIpHeader = env.CTGOV_CLIENT_IP_HEADER?.trim().toLowerCase();
  let validHeader: string | undefined;
  if (clientIpHeader) {
    if (/^[a-z0-9-]+$/.test(clientIpHeader)) validHeader = clientIpHeader;
    else logger.warn("config.invalid_client_ip_header", { header: clientIpHeader });
  }
  return {
    port: args.port,
    host: args.host,
    sandboxMode: args.sandbox,
    insecure: args.insecure,
    publicDocs: args.publicDocs,
    publicOrigin: env.CTGOV_PUBLIC_ORIGIN?.trim() || undefined,
    allowedHosts: list(env.CTGOV_ALLOWED_HOSTS, true),
    allowedOrigins: list(env.CTGOV_ALLOWED_ORIGINS, true),
    // rps must be > 0 and burst >= 1: a bucket that can never hold a whole token rejects everything.
    ipRps: positive(env.CTGOV_IP_RPS, 5),
    ipBurst: positive(env.CTGOV_IP_BURST, 20, 1),
    ...(validHeader ? { clientIpHeader: validHeader } : {}),
    auth: {
      provider,
      ...(env.CTGOV_AUTH_ISSUER ? { issuer: env.CTGOV_AUTH_ISSUER } : {}),
      ...(env.CTGOV_AUTH_AUDIENCE ? { audience: env.CTGOV_AUTH_AUDIENCE } : {}),
      ...(env.CTGOV_AUTH_JWKS_URL ? { jwksUrl: env.CTGOV_AUTH_JWKS_URL } : {}),
      scopes: env.CTGOV_AUTH_SCOPES === undefined ? [DEFAULT_SCOPE] : list(env.CTGOV_AUTH_SCOPES),
    },
  } as HttpServerOptions;
}

async function main(): Promise<void> {
  const env = process.env;
  const args = parseArgs(process.argv.slice(2), env);
  if (args.transport === "http") {
    const handle = await startHttpServer(httpOptions(args, env));
    // Graceful shutdown (Railway and ECS send SIGTERM, Ctrl-C sends SIGINT).
    const shutdown = async (signal: string): Promise<void> => {
      logger.info("shutdown.start", { signal });
      try {
        await handle.close();
      } catch (err) {
        logger.warn("shutdown.error", { error: (err as Error).message });
      }
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
    return;
  }
  if (args.insecure || args.publicDocs) {
    throw new Error("--insecure and --public-docs apply to --http only.");
  }
  await startStdioServer({ sandboxMode: args.sandbox });
}

main().catch((err: unknown) => {
  logger.error("server.fatal", {
    err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
  });
  process.exit(1);
});
