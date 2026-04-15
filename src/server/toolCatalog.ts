import { DescribeSchemaInput } from "../tools/describeSchema.js";
import { ExecuteInput } from "../tools/execute.js";
import { SearchApiInput } from "../tools/searchApi.js";
import { zodToJsonSchema } from "./zodToJsonSchema.js";

export interface ToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    name: "search_api",
    description:
      "Search the ClinicalTrials.gov SDK surface. Returns a TypeScript snippet describing the most relevant endpoints and study fields for your query. Use this before writing code for `execute`.",
    inputSchema: zodToJsonSchema(SearchApiInput),
  },
  {
    name: "describe_schema",
    description:
      "Return doc entries for study-data fields by exact `path` or by `prefix`. Useful for discovering nested field names before projection.",
    inputSchema: zodToJsonSchema(DescribeSchemaInput),
  },
  {
    name: "execute",
    description:
      "Run a short async body against the `ctgov` SDK in a secure sandbox. The body is wrapped as `async (ctgov) => { <your code> }` and must `return` a JSON-serializable value. No network/fs; only `ctgov.*` methods, `console.*`, and standard globals are available.",
    inputSchema: zodToJsonSchema(ExecuteInput),
  },
] as const;
