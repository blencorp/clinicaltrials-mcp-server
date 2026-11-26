import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler, type AuthInfo, type McpRequestContext } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Dispatcher } from "undici";
import type { SandboxKind } from "../sandbox/types.js";
import { buildSupervisor, resolveSupervisorConfig, type SupervisorConfig } from "../supervisor/index.js";
import type { CatalogDeps } from "./toolCatalog.js";
import type { RequestCtx } from "../tools/execute.js";
import { logger } from "../util/logger.js";
import { AuthConfigError, InsufficientScopeError, buildVerifier, type AuthConfig } from "./authz.js";
import { DOCS_PATH, docsRoute } from "../accounts/docs.js";
import { IpRateLimiter, bucketKey, clientIp } from "./ipRateLimiter.js";
import { MCP_PROTOCOL_VERSION, SERVER_VERSION, buildMcpServer } from "./mcpServer.js";
import {
  RESOURCE_METADATA_PATH,
  RESOURCE_METADATA_ROOT_PATH,
  bearerChallenge,
  protectedResourceMetadata,
} from "./wellKnown.js";

export interface HttpServerOptions {
  port?: number;
  host?: string;
  /** Sandbox runner for `execute` (CTGOV_SANDBOX / --sandbox, resolved by the caller). */
  sandboxMode?: SandboxKind;
  /**
   * No authentication, for one developer on their own machine: runs code in whichever sandbox
   * is available. Cannot be combined with `publicDocs` or with a configured auth provider.
   */
  insecure?: boolean;
  /**
   * Anonymous public hosting: no authentication and docs-only tools (search_api,
   * describe_schema). `execute` is not offered and no sandbox is created. Cannot be combined
   * with `insecure` or with a configured auth provider.
   */
  publicDocs?: boolean;
  /**
   * Where the built documentation site is (tests). Default: docs-site/, a sibling of dist/, which
   * the Docker image carries. Served at /docs in `publicDocs` mode only (account mode serves it
   * itself); when the directory is missing there is no /docs.
   */
  docsRoot?: string;
  /** Bearer-token verification. Default: no provider. */
  auth?: AuthConfig;
  /**
   * Public origin clients use (e.g. https://mcp.example.com). Its host is always a trusted Host
   * and its origin a trusted Origin for the anonymous endpoint; it is also the base of the
   * OAuth protected-resource metadata.
   */
  publicOrigin?: string;
  /** Extra Host header values accepted (DNS-rebinding protection), besides the public origin and loopback. */
  allowedHosts?: string[];
  /**
   * Extra Origin values accepted on the ANONYMOUS endpoint (exact origin strings). Bearer-authenticated
   * endpoints accept any Origin: hosted connectors (claude.ai, chatgpt.com) send their own.
   */
  allowedOrigins?: string[];
  /** Per-IP rate limit: sustained requests per second and burst. */
  ipRps?: number;
  ipBurst?: number;
  /**
   * Header the reverse proxy in front of this server overwrites with the client address
   * (Railway: `x-real-ip`). Unset keys the per-IP limit on the TCP peer.
   */
  clientIpHeader?: string;
  /** Limits and upstream settings (bin.ts maps the environment onto this); defaults otherwise. */
  supervisor?: Partial<SupervisorConfig>;
  /** undici dispatcher for upstream requests (tests inject a MockAgent). */
  dispatcher?: Dispatcher;
  /** Prebuilt dependencies (tests); the caller then owns the sandbox and the shutdown signal. */
  deps?: CatalogDeps;
}

export interface HttpHandle {
  close: () => Promise<void>;
  port: number;
  host: string;
}

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";

/** Key the tool-catalog context off the subject this request authenticated as. */
const SUBJECT_KEY = "ctgov.subject";
/** Client address of an unauthenticated caller, for execution admission (never for quotas). */
const CLIENT_KEY = "ctgov.client";

/** Largest MCP request body accepted (execute takes a code string of at most a few KiB). */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** Cap on echoed error text: handler rejections quote caller-supplied headers and body. */
const MAX_LOGGED_ERROR_CHARS = 300;

const truncate = (message: string): string =>
  message.length > MAX_LOGGED_ERROR_CHARS ? `${message.slice(0, MAX_LOGGED_ERROR_CHARS)}…[truncated]` : message;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTNAMES.has(host.toLowerCase());

/**
 * Origin validation for the anonymous endpoint (MCP spec MUST): the server's own origin, the
 * configured allowlist and loopback origins pass; anything else, including "null", does not.
 */
export function originAllowed(originHeader: string, ownOrigin: string, allowlist: string[]): boolean {
  const value = originHeader.toLowerCase();
  if (value === ownOrigin.toLowerCase()) return true;
  if (allowlist.some((allowed) => allowed.toLowerCase() === value)) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** The token of an `Authorization: Bearer <token>` header; the scheme is case-insensitive (RFC 9110). */
export function bearerToken(header: string | undefined): string | undefined {
  return /^bearer +(\S+)$/i.exec(header ?? "")?.[1];
}

function requestCtxOf(ctx: McpRequestContext): RequestCtx {
  const subject = ctx.authInfo?.extra?.[SUBJECT_KEY];
  const client = ctx.authInfo?.extra?.[CLIENT_KEY];
  return {
    ...(typeof subject === "string" ? { subject } : {}),
    ...(typeof client === "string" ? { client } : {}),
  };
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function plain(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

const CORS_ALLOW_HEADERS =
  "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID";
const CORS_EXPOSE_HEADERS = "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version";

/**
 * CORS for a response. No credentials are ever allowed (bearer tokens only), so `*` grants a
 * foreign page nothing it could not do with the token alone; the anonymous endpoint echoes
 * only an origin it already validated.
 */
function corsHeaders(allowOrigin: string): Record<string, string> {
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-expose-headers": CORS_EXPOSE_HEADERS,
    "access-control-max-age": "600",
    ...(allowOrigin === "*" ? {} : { vary: "Origin" }),
  };
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<HttpHandle> {
  const { insecure = false, publicDocs = false } = opts;
  const auth: AuthConfig = opts.auth ?? { provider: "none" };
  if (insecure && publicDocs) throw new Error("--insecure and --public-docs are mutually exclusive");
  if ((insecure || publicDocs) && auth.provider !== "none") {
    throw new AuthConfigError(
      `${insecure ? "--insecure" : "--public-docs"} cannot be combined with CTGOV_AUTH_PROVIDER=${auth.provider}: it would serve without the authentication that provider is configured for. Unset the provider, or drop the flag to serve authenticated.`,
    );
  }
  const unauthenticated = insecure || publicDocs;
  const verifier = buildVerifier(auth);
  if (!verifier && !unauthenticated) {
    throw new AuthConfigError(
      "HTTP transport requires auth configuration. Set CTGOV_AUTH_PROVIDER (generic-oidc, clerk, workos, auth0) with CTGOV_AUTH_ISSUER, CTGOV_AUTH_AUDIENCE and CTGOV_AUTH_JWKS_URL; for anonymous docs-only hosting pass --public-docs; for local development only, --insecure.",
    );
  }

  const port = opts.port ?? 8080;
  const host = opts.host ?? "127.0.0.1";
  const explicitHosts = (opts.allowedHosts ?? []).map((h) => h.toLowerCase());
  const publicUrl = opts.publicOrigin ? new URL(opts.publicOrigin) : undefined;
  if (!isLoopbackHost(host) && !publicUrl && explicitHosts.length === 0) {
    throw new AuthConfigError(
      `Listening on ${host} needs the hostnames clients use: set CTGOV_PUBLIC_ORIGIN (e.g. https://mcp.example.com) or CTGOV_ALLOWED_HOSTS. Requests are checked against them to block DNS rebinding.`,
    );
  }
  // Clients find the authorization server through the protected-resource metadata, whose
  // `resource` must be the URL they connect to (RFC 9728); beyond loopback only the public
  // origin can say what that is.
  if (verifier && !isLoopbackHost(host) && !publicUrl) {
    throw new AuthConfigError(
      `Authenticated serving on ${host} needs CTGOV_PUBLIC_ORIGIN (e.g. https://mcp.example.com): OAuth metadata must name the URL clients connect to.`,
    );
  }
  if (insecure && !isLoopbackHost(host)) {
    logger.warn("http.insecure_public", { host, note: "unauthenticated server reachable beyond this machine" });
  }

  // Authenticated serving runs many callers' code in one process: only Deno (a separate OS
  // process) is allowed there. Fail at startup rather than on the first execute call.
  const processIsolation = verifier !== undefined;
  if (processIsolation && opts.sandboxMode === "isolate") {
    throw new Error("the isolate sandbox (--sandbox isolate / CTGOV_SANDBOX=isolate) is not allowed for authenticated HTTP serving; use deno");
  }
  const toolSet = publicDocs ? "docs-only" : "all";
  // Aborts every running execution when the server closes.
  const shutdown = new AbortController();
  // Built once: the HTTP client (cache, upstream gate), the sandbox and the limiters are shared by
  // every request; the transport only builds a thin MCP server per request on top of them.
  const deps = opts.deps ?? await buildSupervisor(resolveSupervisorConfig({
    ...opts.supervisor,
    tools: toolSet,
    processIsolation,
    shutdownSignal: shutdown.signal,
    ...(opts.sandboxMode ? { sandbox: opts.sandboxMode } : {}),
    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
  }));
  if (processIsolation && deps.sandbox && deps.sandbox.kind !== "deno") {
    logger.warn("http.deno_missing", {
      note: "authenticated serving runs execute only in Deno and Deno is not available: every execute call will fail",
    });
  }
  const executorLabel = deps.sandbox?.kind ?? "none";

  const limiter = new IpRateLimiter(opts.ipRps ?? 5, opts.ipBurst ?? 20);
  // Stateless: the factory runs once per request, so the subject a tool sees is always the one
  // this request's own bearer token verified as. There is no session to bind, reuse, or outlive
  // a token.
  const mcpHandler = createMcpHandler(
    (ctx) => buildMcpServer(deps, requestCtxOf(ctx)),
    {
      legacy: "stateless",
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      // This server declares only `tools`, but the SDK routes `subscriptions/listen` regardless
      // and would otherwise hold up to 1024 long-lived SSE streams per handler. `0` refuses them all.
      maxSubscriptions: 0,
      // Rejections carry attacker-supplied header/body fragments, so cap what reaches stderr.
      onerror: (err) => logger.warn("mcp.handler.error", { error: truncate(err.message) }),
    },
  );
  // The adapter buffers the body before the handler's own cap runs (its default is 4 MiB), so it
  // gets the same cap: an oversized request is refused while it is still arriving.
  const nodeHandler = toNodeHandler(mcpHandler, {
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    onerror: (err) => logger.warn("mcp.adapter.error", { error: truncate(err.message) }),
  });

  // The documentation site, served by the anonymous docs-only server like account mode serves it.
  // Static and public; the handler sets its own CSP, caching and 404 page (accounts/docs.ts).
  const docsRouter = publicDocs ? docsRoute(opts.docsRoot ?? fileURLToPath(new URL("../../docs-site/", import.meta.url))) : undefined;
  const docsApp = docsRouter
    ? express()
        .disable("x-powered-by")
        .use(DOCS_PATH, docsRouter)
        .use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          logger.error("http.docs_failed", { err: err instanceof Error ? { name: err.name, message: truncate(err.message) } : String(err) });
          if (!res.headersSent) res.status(500).type("text/plain").send("internal error");
        })
    : undefined;

  let ownOrigin = "";
  let trustedHosts = new Set<string>();

  // Never rejects: every failure is answered inside (500 at worst), so the request is never left hanging.
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const traceId = randomUUID();
    res.setHeader("x-trace-id", traceId);
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      // Malformed request-target (e.g. bot scanners sending "//evil.txt"): reject without crashing.
      plain(res, 400, "bad request");
      return;
    }
    try {
      // Platform health probes cannot be given a trusted Host (Railway sends
      // `Host: healthcheck.railway.app`), and the endpoint serves no user data.
      if (req.method === "GET" && url.pathname === HEALTH_PATH) {
        reply(res, 200, { status: "ok", version: SERVER_VERSION, protocol: MCP_PROTOCOL_VERSION });
        return;
      }

      // DNS rebinding protection: the Host header must be one we were configured with. The
      // trusted origin is never derived from the request itself.
      const hostHeader = String(req.headers.host ?? "").toLowerCase();
      if (!trustedHosts.has(hostHeader)) {
        reply(res, 421, { error: "host_not_allowed" });
        return;
      }

      // Before the per-IP limiter, as in account mode: static pages are not MCP traffic.
      if (docsApp && (url.pathname === DOCS_PATH || url.pathname.startsWith(`${DOCS_PATH}/`))) {
        docsApp(req, res);
        return;
      }

      const ip = clientIp(req, opts.clientIpHeader);
      if (!limiter.allow(ip)) {
        reply(res, 429, { error: "rate_limited" }, { "retry-after": String(Math.max(1, Math.ceil(1 / (opts.ipRps ?? 5)))) });
        return;
      }

      const isMetadata =
        url.pathname === RESOURCE_METADATA_PATH || url.pathname === RESOURCE_METADATA_ROOT_PATH;
      if (isMetadata) {
        // Discovery documents are public and fetched cross-origin by browser-based clients.
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            ...corsHeaders("*"),
            "access-control-allow-headers": CORS_ALLOW_HEADERS,
          });
          res.end();
          return;
        }
        if (req.method !== "GET") {
          reply(res, 405, { error: "method_not_allowed" }, { allow: "GET, OPTIONS" });
          return;
        }
        if (!verifier) {
          reply(res, 404, { error: "no protected resource configured" });
          return;
        }
        reply(res, 200, protectedResourceMetadata(auth, `${ownOrigin}${MCP_PATH}`), corsHeaders("*"));
        return;
      }

      if (url.pathname === MCP_PATH) {
        await handleMcp(req, res);
        return;
      }

      reply(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      logger.error("http.unhandled", {
        traceId,
        path: url.pathname,
        err: err instanceof Error ? { name: err.name, message: truncate(err.message) } : String(err),
      });
      if (!res.headersSent) reply(res, 500, { error: "internal_error", traceId });
    }
  };

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const originHeader = req.headers.origin;
    const origin = typeof originHeader === "string" ? originHeader : undefined;
    // Origin validation guards the ANONYMOUS endpoint, where a browser page could otherwise ride
    // the visitor's network position. A bearer-authenticated request carries its own credential
    // a foreign page cannot obtain, and hosted connectors (claude.ai, chatgpt.com) send their
    // own Origin, so those endpoints accept any.
    let allowOrigin = "*";
    if (unauthenticated && origin !== undefined) {
      const allowlist = [...(opts.allowedOrigins ?? []), ...(publicUrl ? [publicUrl.origin] : [])];
      if (!originAllowed(origin, ownOrigin, allowlist)) {
        reply(res, 403, { error: "origin_not_allowed", origin });
        return;
      }
      allowOrigin = origin;
    }
    // Only browsers send an Origin; non-browser clients get no CORS headers.
    const cors = origin !== undefined ? corsHeaders(allowOrigin) : {};
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "access-control-allow-headers":
          String(req.headers["access-control-request-headers"] ?? "").slice(0, 1024) || CORS_ALLOW_HEADERS,
        vary: "Origin, Access-Control-Request-Headers",
      });
      res.end();
      return;
    }
    // Stateless: there is no session stream (GET) and no session to end (DELETE).
    if (req.method !== "POST") {
      reply(res, 405, { error: "method_not_allowed" }, { allow: "POST, OPTIONS", ...cors });
      return;
    }
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

    let subject: string | undefined;
    let token = "";
    let scopes: string[] = [];
    if (verifier) {
      const bearer = bearerToken(req.headers.authorization);
      if (!bearer) {
        plain(res, 401, "missing bearer token", { "www-authenticate": bearerChallenge(ownOrigin) });
        return;
      }
      token = bearer;
      try {
        const ctx = await verifier.verify(token);
        subject = ctx.subject;
        scopes = ctx.scopes;
      } catch (err) {
        if (err instanceof InsufficientScopeError) {
          plain(res, 403, "insufficient scope", {
            "www-authenticate": bearerChallenge(ownOrigin, `, error="insufficient_scope", scope="${err.required.join(" ")}"`),
          });
          return;
        }
        // Verifier details stay server-side.
        logger.warn("auth.reject", { error: truncate((err as Error).message) });
        plain(res, 401, "invalid bearer token", { "www-authenticate": bearerChallenge(ownOrigin, `, error="invalid_token"`) });
        return;
      }
    }

    // toNodeHandler forwards `req.auth` to the factory as pass-through authInfo.
    const authInfo: AuthInfo = {
      token,
      clientId: subject ?? "anonymous",
      scopes,
      // Authenticated callers are limited per subject; an anonymous one (--insecure) per client address.
      extra: subject !== undefined ? { [SUBJECT_KEY]: subject } : { [CLIENT_KEY]: `ip:${bucketKey(clientIp(req, opts.clientIpHeader))}` },
    };
    (req as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
    await nodeHandler(req as Parameters<typeof nodeHandler>[0], res);
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  ownOrigin = publicUrl?.origin ?? `http://127.0.0.1:${actualPort}`;
  trustedHosts = new Set([
    ...explicitHosts,
    ...(publicUrl ? [publicUrl.host.toLowerCase()] : []),
    // Local clients and the container health check always reach us on loopback.
    ...["localhost", "127.0.0.1", "[::1]"].map((h) => `${h}:${actualPort}`),
  ]);

  logger.info("server.ready", {
    transport: "http",
    host,
    port: actualPort,
    executor: executorLabel,
    auth: verifier ? auth.provider : "off",
    tools: toolSet,
    protocol: MCP_PROTOCOL_VERSION,
  });

  return {
    port: actualPort,
    host,
    close: async () => {
      // Handler first: `server.close()` resolves only once every connection is idle, so an open
      // SSE exchange would block it forever. Closing the handler aborts in-flight exchanges.
      shutdown.abort();
      await mcpHandler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
