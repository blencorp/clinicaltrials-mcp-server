import { McpServer, fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import type { Dispatcher } from "undici";
import { HttpClient } from "../supervisor/httpClient.js";
import type { RateLimiter } from "../supervisor/rateLimiter.js";
import type { ResponseCache } from "../supervisor/cache.js";
import type { SandboxExecutor } from "../sandbox/types.js";
import { CtGovError } from "../supervisor/errors.js";
import type { SubjectQuota } from "../supervisor/subjectQuota.js";
import { logger } from "../util/logger.js";
import { buildCatalog } from "./toolCatalog.js";

/**
 * The MCP revision this server speaks.
 *
 * Declared here rather than imported: the SDK's exported `LATEST_PROTOCOL_VERSION` and
 * `SUPPORTED_PROTOCOL_VERSIONS` describe only the legacy `initialize` era (`2025-11-25` and
 * older) kept for the backward-compatibility leg, and the modern value is not exported.
 */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** This build's release (the release workflow stamps it). */
export const SERVER_VERSION = "0.1.0-alpha.0"; // x-release-version

export interface BuildMcpServerOptions {
  executor?: SandboxExecutor;
  resolveExecutor?: () => SandboxExecutor;
  /**
   * Subject identifier (OAuth `sub`) to stamp on audit events. `undefined`
   * for stdio/unauthenticated local use.
   */
  subject?: string;
  /** Per-subject quota enforcer (HTTP transport). */
  quota?: SubjectQuota;
  /**
   * `docs-only` serves search_api + describe_schema and nothing else: `execute` is not registered
   * (a call is an unknown tool) and no sandbox is ever resolved. Used for anonymous public hosting.
   */
  tools?: "all" | "docs-only";
  /** undici dispatcher for upstream requests (tests inject a MockAgent). Defaults to the global one. */
  dispatcher?: Dispatcher;
  /**
   * Response cache and process-wide upstream gate. The HTTP transport builds one server per
   * request, so it passes shared instances here; without them each server would start with an
   * empty cache and a full token bucket.
   */
  cache?: ResponseCache;
  rateLimiter?: RateLimiter;
}

/** Server-level guidance clients may show the model before it picks a tool. */
export const SERVER_INSTRUCTIONS =
  "ClinicalTrials.gov through code mode. Workflow: search_api (find the SDK method and study field names) -> describe_schema (exact field paths) -> execute (run JavaScript against the `ctgov` global). Read-only; ask for only the `fields` you need.";

// The catalog derives from process configuration (which tools are offered), not from the caller,
// so every client sees byte-identical results and a shared cache is safe.
const LIST_CACHE_HINT = { ttlMs: 300_000, cacheScope: "public" as const };

/**
 * Tools take a few scalar arguments; anything with more array elements or object members than
 * this is not a legitimate call (SDK guard against validation-cost DoS).
 */
export const MAX_TOOL_INPUT_ELEMENTS = 64;

/**
 * Converted tool schemas, cached for the process lifetime. `fromJsonSchema` compiles an Ajv
 * validator that the SDK keeps in a module-level map keyed by schema identity with no eviction;
 * the HTTP transport builds a server per request, so converting inline would retain a compiled
 * validator per request forever. The schemas derive from module-level Zod constants, so each is
 * converted once per name.
 */
const schemaCache = new Map<string, ReturnType<typeof fromJsonSchema>>();

function cachedSchema(key: string, jsonSchema: unknown): ReturnType<typeof fromJsonSchema> {
  let converted = schemaCache.get(key);
  if (!converted) {
    converted = fromJsonSchema(jsonSchema as JsonSchemaType);
    schemaCache.set(key, converted);
  }
  return converted;
}

function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof CtGovError) return err.toJSON();
  const e = err as Error;
  return { name: e?.name ?? "Error", message: e?.message ?? String(err) };
}

export function buildMcpServer(opts: BuildMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: "clinicaltrial-mcp-server", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      cacheHints: { "tools/list": LIST_CACHE_HINT, "server/discover": LIST_CACHE_HINT },
    },
  );
  const subject = opts.subject;
  const resolveExecutor = (): SandboxExecutor => {
    if (opts.resolveExecutor) return opts.resolveExecutor();
    if (opts.executor) return opts.executor;
    throw new CtGovError("INTERNAL_ERROR", "sandbox executor not configured");
  };

  // The HTTP client carries subject-aware rate limiting when a quota is provided.
  const httpClientOpts: ConstructorParameters<typeof HttpClient>[0] = {};
  if (opts.quota) httpClientOpts.acquireFn = () => opts.quota!.acquireUpstream(subject);
  if (opts.dispatcher) httpClientOpts.dispatcher = opts.dispatcher;
  if (opts.cache) httpClientOpts.cache = opts.cache;
  if (opts.rateLimiter) httpClientOpts.rateLimiter = opts.rateLimiter;
  const http = new HttpClient(httpClientOpts);

  for (const tool of buildCatalog({ resolveExecutor, http, subject, quota: opts.quota, tools: opts.tools ?? "all" })) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        // The catalog emits JSON Schema; `fromJsonSchema` attaches the SDK's Ajv validator, so
        // arguments are checked here BEFORE the handler re-parses with Zod. `zodToJsonSchema`
        // emits `additionalProperties: false`, so unknown argument keys are rejected.
        inputSchema: cachedSchema(`in:${tool.name}`, tool.inputSchema),
        outputSchema: cachedSchema(`out:${tool.name}`, tool.outputSchema),
      },
      async (args: unknown, ctx: { mcpReq?: { signal?: AbortSignal } }) => {
        try {
          const result = await tool.handler(args ?? {}, { signal: ctx?.mcpReq?.signal });
          // Compact JSON for the model, the same object as structuredContent for clients, and
          // isError for a failed execution (MCP tool-error convention) with the full envelope.
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
            ...(tool.isFailure?.(result) ? { isError: true } : {}),
          };
        } catch (err) {
          const payload = errorPayload(err);
          logger.warn("tool.error", { tool: tool.name, subject, ...payload });
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          };
        }
      },
    );
  }

  return server;
}
