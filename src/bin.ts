#!/usr/bin/env node
import { startStdioServer } from "./server/stdio.js";
import { startHttpServer, type HttpServerOptions } from "./server/http.js";
import { DEFAULT_SCOPE, type AuthProvider } from "./server/authz.js";
import { SERVER_VERSION } from "./server/mcpServer.js";
import { logger } from "./util/logger.js";
import type { SandboxKind } from "./sandbox/types.js";
import { EXECUTION_DEFAULTS, UPSTREAM_DEFAULTS, SUBJECT_RATE_PER_HOUR_DEFAULT, type SupervisorConfig } from "./supervisor/index.js";
import { DEFAULT_CALL_BUDGET } from "./tools/execute.js";

interface ParsedArgs {
  transport: "stdio" | "http";
  sandbox: SandboxKind;
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

/**
 * Limits and upstream settings from the environment. Each must be a positive number (counts at
 * least 1); an invalid value falls back to the default instead of silently disabling a limit.
 */
function supervisorConfig(env: NodeJS.ProcessEnv): Partial<SupervisorConfig> {
  return {
    ...(env.CTGOV_BASE_URL?.trim() ? { baseUrl: env.CTGOV_BASE_URL.trim() } : {}),
    upstreamRatePerSec: positive(env.CTGOV_RATE_PER_SEC, UPSTREAM_DEFAULTS.ratePerSec),
    maxConcurrentExecutions: Math.floor(positive(env.CTGOV_MAX_CONCURRENT_EXECUTIONS, EXECUTION_DEFAULTS.maxConcurrent, 1)),
    maxExecutionsPerSubject: Math.floor(positive(env.CTGOV_MAX_EXECUTIONS_PER_SUBJECT, EXECUTION_DEFAULTS.perSubject, 1)),
    maxCallsPerExecute: Math.floor(positive(env.CTGOV_MAX_CALLS_PER_EXECUTE, DEFAULT_CALL_BUDGET, 1)),
    subjectRatePerHour: Math.floor(positive(env.CTGOV_SUBJECT_RATE_PER_HOUR, SUBJECT_RATE_PER_HOUR_DEFAULT, 1)),
  };
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  const args: ParsedArgs = {
    transport: "stdio",
    sandbox: ((env.CTGOV_SANDBOX as SandboxKind | undefined) ?? "auto"),
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
    } else if (a === "--sandbox") args.sandbox = argv[++i] as SandboxKind;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--version" || a === "-v") {
      process.stdout.write(`@blen/clinicaltrials-mcp-server ${SERVER_VERSION}\n`);
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
      "clinicaltrials-mcp-server: code-mode MCP server for ClinicalTrials.gov",
      "",
      "Usage:",
      "  clinicaltrials-mcp-server [--stdio|--http] [--sandbox isolate|deno|auto]",
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
      "Limits (environment):",
      "  CTGOV_SANDBOX                       auto | isolate | deno (same as --sandbox)",
      "  CTGOV_RATE_PER_SEC                  upstream requests per second, process-wide (default 10)",
      "  CTGOV_MAX_CONCURRENT_EXECUTIONS     simultaneous executions (default 8)",
      "  CTGOV_MAX_EXECUTIONS_PER_SUBJECT    simultaneous executions per caller (default 2)",
      "  CTGOV_MAX_CALLS_PER_EXECUTE         upstream calls one execute may make (default 100)",
      "  CTGOV_SUBJECT_RATE_PER_HOUR         upstream calls per authenticated subject per hour (default 3000)",
      "",
      "HTTP environment:",
      "  CTGOV_PUBLIC_ORIGIN    https://mcp.example.com (or CTGOV_ALLOWED_HOSTS) is required when",
      "                         binding beyond loopback: trusted Host values, DNS-rebinding defence",
      "  CTGOV_AUTH_PROVIDER    generic-oidc | clerk | workos | auth0 | accounts",
      "  CTGOV_AUTH_ISSUER      trusted token issuer",
      "  CTGOV_AUTH_AUDIENCE    audience tokens must carry (this server's /mcp URL)",
      "  CTGOV_AUTH_JWKS_URL    https JWKS endpoint of the issuer",
      "  CTGOV_AUTH_SCOPES      scopes every token must carry (default ctgov:read)",
      "",
      "Account mode (CTGOV_AUTH_PROVIDER=accounts, with --http; excludes --public-docs and --insecure):",
      "  Google sign-in and OAuth for /mcp/account (execute); /mcp stays anonymous, docs-only. Needs",
      "  CTGOV_PUBLIC_ORIGIN, DATABASE_URL (PostgreSQL), BETTER_AUTH_SECRET (32+ characters),",
      "  GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Optional: CTGOV_SUBJECT_DAILY_QUOTA (10000),",
      "  CTGOV_IP_RPS, CTGOV_IP_BURST, CTGOV_CLIENT_IP_HEADER, CTGOV_ALLOWED_ORIGINS.",
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
    supervisor: supervisorConfig(env),
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

/** Graceful shutdown (Railway sends SIGTERM, Ctrl-C sends SIGINT). */
function onShutdown(close: () => Promise<void>): void {
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutdown.start", { signal });
    try {
      await close();
    } catch (err) {
      logger.warn("shutdown.error", { error: (err as Error).message });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

async function main(): Promise<void> {
  const env = process.env;
  const args = parseArgs(process.argv.slice(2), env);
  if (env.CTGOV_AUTH_PROVIDER?.trim() === "accounts") {
    // Hosting modes exclude each other: account mode needs a database and authenticates every
    // execute, so it can never be started as (or alongside) an unauthenticated mode.
    if (args.transport !== "http") throw new Error("CTGOV_AUTH_PROVIDER=accounts needs --http.");
    if (args.publicDocs || args.insecure) {
      throw new Error(`${args.publicDocs ? "--public-docs" : "--insecure"} cannot be combined with CTGOV_AUTH_PROVIDER=accounts: it would serve without the sign-in that mode is configured for. Unset the provider, or drop the flag.`);
    }
    const { loadAccountConfig } = await import("./accounts/config.js");
    const { startAccountHttp } = await import("./accounts/runtime.js");
    const handle = await startAccountHttp({
      port: args.port, host: args.host, config: loadAccountConfig(env),
      sandboxMode: args.sandbox, supervisor: supervisorConfig(env),
    });
    onShutdown(handle.close);
    return;
  }
  if (args.transport === "http") {
    const handle = await startHttpServer(httpOptions(args, env));
    onShutdown(handle.close);
    return;
  }
  if (args.insecure || args.publicDocs) {
    throw new Error("--insecure and --public-docs apply to --http only.");
  }
  await startStdioServer({ sandboxMode: args.sandbox, supervisor: supervisorConfig(env) });
}

main().catch((err: unknown) => {
  logger.error("server.fatal", {
    err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
  });
  process.exit(1);
});
