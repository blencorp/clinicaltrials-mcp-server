import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { DescribeSchemaInput, runDescribeSchema } from "../tools/describeSchema.js";
import { ExecuteInput, runExecute, type ExecuteDeps } from "../tools/execute.js";
import { SearchApiInput, runSearchApi } from "../tools/searchApi.js";
import type { SandboxExecutor } from "../sandbox/types.js";
import type { SubjectQuota } from "../supervisor/subjectQuota.js";
import { zodToJsonSchema } from "./zodToJsonSchema.js";

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>;
  /** JSON Schema of the structured result (`structuredContent`). */
  outputSchema: Record<string, unknown>;
  /** `signal` aborts when the client cancels the request or disconnects. */
  handler: (args: unknown, ctx: { signal?: AbortSignal | undefined }) => Promise<unknown>;
  /** True when a returned result is a tool execution failure (MCP `isError`). */
  isFailure?: (result: unknown) => boolean;
}

export const OUTPUT_SCHEMAS = {
  search_api: {
    type: "object",
    properties: {
      query: { type: "string" },
      snippet: { type: "string", description: "TypeScript reference and the matching endpoint/field notes" },
      hits: { type: "integer", description: "How many endpoint/field matches the snippet contains" },
    },
    required: ["query", "snippet", "hits"],
  },
  describe_schema: {
    type: "object",
    properties: {
      matches: { type: "array", items: { type: "object" } },
      total: { type: "integer" },
    },
    required: ["matches", "total"],
  },
  execute: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "false when the code threw, timed out, or broke a limit; see error" },
      result: { description: "The JSON value the code returned" },
      logs: { type: "array", items: { type: "object" } },
      error: {
        type: "object",
        properties: { name: { type: "string" }, message: { type: "string" }, stack: { type: "string" }, code: { type: "string" } },
        required: ["name", "message"],
      },
      calls: { type: "array", items: { type: "object" } },
      durationMs: { type: "number" },
      executor: { type: "string", enum: ["isolate", "deno"] },
    },
    required: ["ok", "logs", "calls", "durationMs", "executor"],
  },
} as const;

export interface CatalogDeps {
  /** Resolves the sandbox on the first `execute` call (never at startup). */
  resolveExecutor: () => SandboxExecutor;
  http: ExecuteDeps["http"];
  /** Subject (OAuth `sub`) stamped on audit events; undefined for stdio and anonymous use. */
  subject?: string | undefined;
  quota?: SubjectQuota | undefined;
  /** `docs-only` offers search_api + describe_schema and nothing else. */
  tools: "all" | "docs-only";
}

export function buildCatalog(deps: CatalogDeps): ToolDescriptor[] {
  const all: ToolDescriptor[] = [
    {
      name: "search_api",
      title: "Search ClinicalTrials.gov API surface",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Search the ClinicalTrials.gov SDK surface (see https://clinicaltrials.gov/data-api/api). Returns a TypeScript snippet describing the most relevant endpoints and study fields for your query. Use this before writing code for `execute`.",
      inputSchema: zodToJsonSchema(SearchApiInput),
      outputSchema: OUTPUT_SCHEMAS.search_api,
      handler: async (args) => {
        const out = runSearchApi(SearchApiInput.parse(args));
        return { query: out.query, snippet: out.snippet, hits: out.hits.length };
      },
    },
    {
      name: "describe_schema",
      title: "Describe ClinicalTrials.gov study fields",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Return doc entries for study-data fields by exact `path` or by `prefix` (exactly one of them). Useful for discovering nested field names before projection. Field reference: https://clinicaltrials.gov/data-api/about-api/study-data-structure.",
      inputSchema: zodToJsonSchema(DescribeSchemaInput, {
        // Exactly one of path / prefix (the handler's refine rule, in JSON Schema form).
        oneOf: [{ required: ["path"], not: { required: ["prefix"] } }, { required: ["prefix"], not: { required: ["path"] } }],
      }),
      outputSchema: OUTPUT_SCHEMAS.describe_schema,
      handler: async (args) => runDescribeSchema(DescribeSchemaInput.parse(args)),
    },
    {
      name: "execute",
      title: "Execute sandboxed ClinicalTrials.gov query",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Run a short async body against the `ctgov` SDK in a secure sandbox to query the public ClinicalTrials.gov v2 API (https://clinicaltrials.gov/data-api/api). The body is wrapped as `async (ctgov) => { <your code> }` and must `return` a JSON-serializable value. Read-only: the SDK only exposes GET endpoints. No network/fs; only `ctgov.*` methods, `console.*`, and standard globals are available.",
      inputSchema: zodToJsonSchema(ExecuteInput),
      outputSchema: OUTPUT_SCHEMAS.execute,
      handler: async (args, ctx) => {
        const input = ExecuteInput.parse(args);
        if (ctx.signal?.aborted) throw new Error("The request was cancelled.");
        if (deps.quota && deps.subject) deps.quota.tryConsumeExecute(deps.subject);
        const execDeps: ExecuteDeps = { executor: deps.resolveExecutor(), http: deps.http };
        if (deps.subject !== undefined) execDeps.subject = deps.subject;
        return runExecute(input, execDeps);
      },
      isFailure: (result) => (result as { ok?: unknown } | null)?.ok === false,
    },
  ];
  return deps.tools === "docs-only" ? all.filter((t) => t.name !== "execute") : all;
}

/**
 * The static tool listing (names, descriptions, schemas) for consumers that never call a handler,
 * such as the MCPB manifest. The handlers close over deps this listing does not have: do not invoke them.
 */
export const TOOL_CATALOG: readonly ToolDescriptor[] = buildCatalog({
  resolveExecutor: () => {
    throw new Error("TOOL_CATALOG is a listing only");
  },
  http: undefined as unknown as ExecuteDeps["http"],
  tools: "all",
});
