import { McpServer, fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import type { RequestCtx } from "../tools/execute.js";
import { logger } from "../util/logger.js";
import { buildCatalog, type CatalogDeps } from "./toolCatalog.js";

/**
 * The MCP revision this server speaks.
 *
 * Declared here rather than imported: the SDK's exported `LATEST_PROTOCOL_VERSION` and
 * `SUPPORTED_PROTOCOL_VERSIONS` describe only the legacy `initialize` era (`2025-11-25` and
 * older) kept for the backward-compatibility leg, and the modern value is not exported.
 */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** This build's release (the release workflow stamps it). */
export const SERVER_VERSION = '0.1.1'; // x-release-version

/** Server-level guidance clients may show the model before it picks a tool. */
export const SERVER_INSTRUCTIONS = [
  "ClinicalTrials.gov through code mode. Workflow: search_api (find the SDK method and field names) -> describe_schema (exact signature and field paths) -> execute (run plain JavaScript against the `ctgov` global). Read-only.",
  "The SDK takes flat dotted keys ('query.cond', 'filter.overallStatus'), not nested objects. Always pass `fields` to studies.search and return only the values you need: an execute result over 256 KiB fails. To read more than one page, loop on nextPageToken with pageToken (there is no searchAll helper).",
].join("\n");

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

export function buildMcpServer(deps: CatalogDeps, requestCtx?: RequestCtx): McpServer {
  const server = new McpServer(
    { name: "clinicaltrial-mcp-server", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      cacheHints: { "tools/list": LIST_CACHE_HINT, "server/discover": LIST_CACHE_HINT },
    },
  );

  for (const tool of buildCatalog(deps, requestCtx)) {
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
          const e = err as Error;
          logger.warn("tool.error", { tool: tool.name, name: e?.name, error: e?.message });
          return {
            isError: true,
            content: [{ type: "text" as const, text: `${e?.name ?? "Error"}: ${e?.message ?? String(err)}` }],
          };
        }
      },
    );
  }

  return server;
}
