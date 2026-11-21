import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { AuthAdapter, Principal } from "../auth/adapter.js";
import { buildAuthAdapter, loadAuthConfig, type AuthConfig } from "../auth/config.js";
import { EmbeddedAs, type EmbeddedAsEndpointResult } from "../auth/embeddedAs.js";
import { SubjectQuota } from "../supervisor/subjectQuota.js";
import {
  isDenoAvailable,
  isIsolateAvailable,
  selectSandbox,
  type SandboxMode,
} from "../sandbox/index.js";
import { buildMcpServer } from "./mcpServer.js";
import {
  makeASMetadataFetcher,
  protectedResourceMetadata,
  wwwAuthenticateHeader,
  type ASMetadataFetcher,
} from "./wellKnown.js";
import { logger } from "../util/logger.js";
import {
  hasRequiredResourceScope,
  isSessionSubjectAuthorized,
  requiredResourceScopes,
} from "./authz.js";
import { IpRateLimiter, clientIp } from "./ipRateLimiter.js";

export interface HttpServerOptions {
  port?: number;
  host?: string;
  sandboxMode?: SandboxMode;
  /**
   * No authentication, for one developer on their own machine: binds 127.0.0.1 unless a host is
   * given, and runs code in whichever sandbox is available.
   */
  insecure?: boolean;
  /**
   * Anonymous public hosting: no authentication and docs-only tools (search_api,
   * describe_schema). `execute` is not offered and no sandbox is created.
   */
  publicDocs?: boolean;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendPlain(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

class HttpBodyTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(readonly maxBytes: number) {
    super(`request body too large (max ${maxBytes} bytes)`);
    this.name = "HttpBodyTooLargeError";
  }
}

async function readBodyWithLimit(req: IncomingMessage, maxBytes: number): Promise<string> {
  const header = req.headers["content-length"];
  const declaredLength = Array.isArray(header) ? header[0] : header;
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new HttpBodyTooLargeError(maxBytes);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    total += chunk.length;
    if (total > maxBytes) {
      req.destroy();
      throw new HttpBodyTooLargeError(maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildEmbeddedAs(cfg: AuthConfig): EmbeddedAs {
  const raw = process.env.CTGOV_EMBEDDED_USERS ?? "";
  const users = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const [u, p] = pair.split(":");
    if (u && p) users.set(u, p);
  }
  return new EmbeddedAs({
    issuer: cfg.issuer,
    audience: cfg.resource,
    scopesSupported: cfg.scopesSupported,
    userResolver: async (ctx) => {
      const h = ctx.headers.authorization;
      const header = Array.isArray(h) ? h[0] : h;
      const m = header && /^Basic\s+(.+)$/i.exec(header);
      if (!m) return null;
      const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) return null;
      const user = decoded.slice(0, colon);
      const pass = decoded.slice(colon + 1);
      const expected = users.get(user);
      if (!expected) return null;
      const aBuf = Buffer.from(pass);
      const eBuf = Buffer.from(expected);
      if (aBuf.length !== eBuf.length || !timingSafeEqual(aBuf, eBuf)) return null;
      return { sub: user, scopes: ctx.requestedScopes };
    },
  });
}

function writeAsResult(res: ServerResponse, out: EmbeddedAsEndpointResult): void {
  const headers: Record<string, string> = { ...(out.headers ?? {}) };
  if (out.location) headers.location = out.location;
  res.writeHead(out.status, headers);
  res.end(out.body ?? "");
}

function pickBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m && m[1] ? m[1].trim() : null;
}

export async function startHttpServer(
  opts: HttpServerOptions = {},
): Promise<{ close: () => Promise<void>; port: number; host: string }> {
  if (opts.insecure && opts.publicDocs) {
    throw new Error("--insecure and --public-docs are mutually exclusive");
  }
  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  // --insecure runs anyone's code without authentication, so it listens on loopback. Only an
  // explicit --host overrides that; the ambient HOST variable (set to 0.0.0.0 by the Docker
  // image and .env.example) deliberately does not.
  const host = opts.insecure ? (opts.host ?? "127.0.0.1") : (opts.host ?? process.env.HOST ?? "0.0.0.0");
  if (opts.insecure && opts.host !== undefined && !["127.0.0.1", "::1", "[::1]", "localhost"].includes(opts.host)) {
    logger.warn("http.insecure_public", { host: opts.host, note: "unauthenticated server reachable beyond this machine" });
  }

  const authConfig: AuthConfig = loadAuthConfig();
  const unauthenticated = opts.insecure === true || opts.publicDocs === true;
  const authAdapter: AuthAdapter | null = unauthenticated ? null : buildAuthAdapter(authConfig);
  const asFetcher: ASMetadataFetcher = makeASMetadataFetcher(authConfig);
  // Authenticated serving runs many callers' code in one process: only Deno (a separate OS
  // process) is allowed there. Fail at startup rather than on the first execute call.
  const processIsolation = authAdapter !== null;
  const requestedMode = opts.sandboxMode ?? process.env.CTGOV_SANDBOX;
  if (processIsolation && requestedMode === "isolate") {
    throw new Error(
      "the isolate sandbox (--sandbox isolate / CTGOV_SANDBOX=isolate) is not allowed for authenticated HTTP serving; use deno",
    );
  }
  if (processIsolation && !isDenoAvailable()) {
    logger.warn("http.deno_missing", {
      note: "authenticated serving runs execute only in Deno and deno is not on PATH: every execute call will fail",
    });
  }
  const toolSet = opts.publicDocs ? "docs-only" : "all";
  const executorLabel = opts.publicDocs
    ? "none"
    : processIsolation
      ? isDenoAvailable()
        ? "deno"
        : "unavailable"
      : isIsolateAvailable()
        ? "isolate"
        : isDenoAvailable()
          ? "deno"
          : "unavailable";
  const quota = new SubjectQuota();
  // Unauthenticated modes advertise no authorization server, so do not serve the embedded one
  // (open dynamic client registration, /authorize, /token) either.
  const embeddedAs = authConfig.provider === "embedded" && !unauthenticated ? buildEmbeddedAs(authConfig) : null;
  const ipLimiter = new IpRateLimiter({
    ratePerSec: Number(process.env.CTGOV_IP_RPS ?? 5),
    burst: Number(process.env.CTGOV_IP_BURST ?? 20),
  });

  if (!authAdapter && !unauthenticated) {
    throw new Error(
      "HTTP transport requires auth configuration. Set CTGOV_AUTH_PROVIDER=clerk (or embedded) and CTGOV_AUTH_ISSUER; for anonymous docs-only hosting pass --public-docs; for local development only, --insecure.",
    );
  }

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const traceId = randomUUID();
    res.setHeader("x-trace-id", traceId);
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      // Malformed request-target (e.g. bot scanners sending "//evil.txt").
      // Reject early without crashing the process.
      sendPlain(res, 400, "bad request");
      return;
    }

    try {
      // Per-IP rate limit for authenticated and AS endpoints. Health checks
      // stay free so platform probes aren't affected.
      if (url.pathname.startsWith("/mcp") || url.pathname.startsWith("/as/")) {
        const ip = clientIp(req);
        const retryAfter = ipLimiter.check(ip);
        if (retryAfter !== null) {
          res.setHeader("retry-after", String(retryAfter));
          sendJson(res, 429, { error: "rate_limited", retryAfter });
          return;
        }
      }

      // Health
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { status: "ok", timestamp: new Date().toISOString() });
        return;
      }
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        sendJson(res, 200, {
          ok: true,
          executor: executorLabel,
          auth: authAdapter ? authConfig.provider : "off",
          tools: toolSet,
        });
        return;
      }

      // RFC 9728 Protected Resource Metadata — only when auth is on.
      // For unauthenticated public deployments (provider=none / --insecure),
      // there is no protected resource to advertise; return 404.
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
        if (!authAdapter) {
          sendJson(res, 404, { error: "no protected resource configured" });
          return;
        }
        sendJson(res, 200, protectedResourceMetadata(authConfig));
        return;
      }

      // RFC 8414 AS Metadata — only when auth is on.
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        if (!authAdapter) {
          sendJson(res, 404, { error: "no authorization server configured" });
          return;
        }
        if (embeddedAs) {
          sendJson(res, 200, embeddedAs.metadata());
          return;
        }
        const doc = await asFetcher.get();
        if (!doc) {
          sendJson(res, 404, { error: "no authorization server configured" });
          return;
        }
        sendJson(res, 200, doc);
        return;
      }

      // Embedded AS endpoints (only mounted when provider=embedded).
      if (embeddedAs) {
        if (req.method === "GET" && url.pathname === "/as/jwks.json") {
          sendJson(res, 200, await embeddedAs.jwks());
          return;
        }
        if (req.method === "POST" && url.pathname === "/as/register") {
          const body = await readBodyWithLimit(req, 64 * 1024);
          let parsed: unknown = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch {
            sendJson(res, 400, { error: "invalid_client_metadata" });
            return;
          }
          writeAsResult(res, embeddedAs.register(parsed));
          return;
        }
        if (req.method === "GET" && url.pathname === "/as/authorize") {
          const query: Record<string, string> = {};
          url.searchParams.forEach((v, k) => {
            query[k] = v;
          });
          const out = await embeddedAs.authorize({ query, headers: req.headers });
          writeAsResult(res, out);
          return;
        }
        if (req.method === "POST" && url.pathname === "/as/token") {
          const body = await readBodyWithLimit(req, 16 * 1024);
          const form: Record<string, string> = {};
          new URLSearchParams(body).forEach((v, k) => {
            form[k] = v;
          });
          writeAsResult(res, await embeddedAs.token(form));
          return;
        }
      }

      // MCP endpoint (POST = request, GET = SSE stream, DELETE = end session)
      if (url.pathname === "/mcp") {
        if (req.method === "POST" || req.method === "GET" || req.method === "DELETE") {
          await handleMcp(req, res);
          return;
        }
        res.writeHead(405, { allow: "POST, GET, DELETE" }).end();
        return;
      }

      // Unknown
      sendJson(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      if (err instanceof HttpBodyTooLargeError) {
        if (!res.headersSent) sendPlain(res, err.statusCode, err.message);
        return;
      }
      logger.error("http.unhandled", {
        traceId,
        path: url.pathname,
        err:
          err instanceof Error ? { name: err.name, message: err.message } : String(err),
      });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error", traceId });
    }
  };
  const server = createServer((req, res) => {
    void onRequest(req, res);
  });

  interface Session {
    transport: NodeStreamableHTTPServerTransport;
    close: () => Promise<void>;
    lastActivity: number;
    subject?: string;
  }
  const sessions = new Map<string, Session>();
  const SESSION_IDLE_MS = 30 * 60_000;
  const configuredMaxSessions = Number(process.env.CTGOV_MAX_SESSIONS ?? 500);
  const MAX_SESSIONS =
    Number.isFinite(configuredMaxSessions) && configuredMaxSessions > 0
      ? configuredMaxSessions
      : 500;

  // Evict idle sessions periodically.
  const sweepTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastActivity < cutoff) {
        void s.close();
        sessions.delete(id);
      }
    }
  }, 60_000);
  sweepTimer.unref?.();

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Auth
    let principal: Principal | null = null;
    if (authAdapter) {
      const token = pickBearer(req);
      if (!token) {
        sendPlain(res, 401, "missing bearer token", {
          "www-authenticate": wwwAuthenticateHeader(authConfig),
        });
        return;
      }
      try {
        principal = await authAdapter.verifyAccessToken(token);
      } catch (err) {
        logger.warn("auth.reject", {
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        });
        sendPlain(res, 401, "invalid bearer token", {
          "www-authenticate": wwwAuthenticateHeader(authConfig),
        });
        return;
      }
      if (!hasRequiredResourceScope(principal.scopes, authConfig.scopesSupported)) {
        const requiredScope = requiredResourceScopes(authConfig.scopesSupported).join(" ");
        const authenticate = `${wwwAuthenticateHeader(authConfig)}, error="insufficient_scope"${
          requiredScope ? `, scope="${requiredScope}"` : ""
        }`;
        sendPlain(res, 403, "insufficient scope", {
          "www-authenticate": authenticate,
        });
        return;
      }
    }

    const existingSessionId = req.headers["mcp-session-id"];
    const sid = Array.isArray(existingSessionId) ? existingSessionId[0] : existingSessionId;

    let session = sid ? sessions.get(sid) : undefined;
    if (session && !isSessionSubjectAuthorized(session.subject, principal?.sub)) {
      sendPlain(res, 403, "session subject mismatch");
      return;
    }
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) {
        sendPlain(res, 503, "session capacity exceeded");
        return;
      }
      // Create a new session + transport + per-session MCP server.
      const mcpOpts: Parameters<typeof buildMcpServer>[0] = {
        resolveExecutor: () =>
          selectSandbox({ ...(opts.sandboxMode ? { mode: opts.sandboxMode } : {}), processIsolation }),
        quota,
        tools: toolSet,
      };
      if (principal?.sub) mcpOpts.subject = principal.sub;
      const mcp = buildMcpServer(mcpOpts);
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const close = async () => {
        try {
          await transport.close();
        } catch {
          /* ignore */
        }
        try {
          await mcp.close();
        } catch {
          /* ignore */
        }
      };
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };
       
      await mcp.connect(transport);
      session = {
        transport,
        close,
        lastActivity: Date.now(),
        ...(principal?.sub !== undefined ? { subject: principal.sub } : {}),
      };
      // The session id is generated the first time handleRequest is called
      // on an initialize POST. We'll register after handleRequest.
    }

    session.lastActivity = Date.now();
     
    await session.transport.handleRequest(req, res);

    const id = session.transport.sessionId;
    if (id && !sessions.has(id)) sessions.set(id, session);
  }

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  logger.info("server.ready", {
    transport: "http",
    executor: executorLabel,
    auth: authAdapter ? authConfig.provider : "off",
    tools: toolSet,
    resource: authConfig.resource,
    port,
    host,
  });

  const actualPort = (server.address() as { port?: number } | null)?.port ?? port;

  return {
    port: actualPort,
    host,
    close: async () => {
      clearInterval(sweepTimer);
      await Promise.all([...sessions.values()].map((s) => s.close()));
      sessions.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
