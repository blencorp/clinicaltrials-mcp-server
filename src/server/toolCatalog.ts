import { DescribeSchemaInput } from "../tools/describeSchema.js";
import { ExecuteInput } from "../tools/execute.js";
import { SearchApiInput } from "../tools/searchApi.js";
import { zodToJsonSchema } from "./zodToJsonSchema.js";

export interface ToolAnnotations {
  /** Human-readable display name. */
  title: string;
  /** Read-only operations (no side effects on upstream state). */
  readOnlyHint?: boolean;
  /** Destructive operations (modify or delete upstream state). */
  destructiveHint?: boolean;
  /** Calling with the same args yields the same result. */
  idempotentHint?: boolean;
  /** Tool interacts with services outside the local environment. */
  openWorldHint?: boolean;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    name: "search_api",
    description:
      "Search the ClinicalTrials.gov SDK surface (see https://clinicaltrials.gov/data-api/api). Returns a TypeScript snippet describing the most relevant endpoints and study fields for your query. Use this before writing code for `execute`.",
    inputSchema: zodToJsonSchema(SearchApiInput),
    annotations: {
      title: "Search ClinicalTrials.gov API surface",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "describe_schema",
    description:
      "Return doc entries for study-data fields by exact `path` or by `prefix`. Useful for discovering nested field names before projection. Field reference: https://clinicaltrials.gov/data-api/about-api/study-data-structure.",
    inputSchema: zodToJsonSchema(DescribeSchemaInput),
    annotations: {
      title: "Describe ClinicalTrials.gov study fields",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "execute",
    description:
      "Run a short async body against the `ctgov` SDK in a secure sandbox to query the public ClinicalTrials.gov v2 API (https://clinicaltrials.gov/data-api/api). The body is wrapped as `async (ctgov) => { <your code> }` and must `return` a JSON-serializable value. Read-only: the SDK only exposes GET endpoints. No network/fs; only `ctgov.*` methods, `console.*`, and standard globals are available.",
    inputSchema: zodToJsonSchema(ExecuteInput),
    annotations: {
      title: "Execute sandboxed ClinicalTrials.gov query",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
] as const;
