import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BM25Index, type BM25SearchResult } from "./bm25.js";

export interface EndpointDoc {
  kind: "endpoint";
  operationId: string;
  path: string;
  method: string;
  summary?: string;
  description?: string;
  parameters: Array<{ name: string; in: string; required?: boolean; description?: string; type?: string }>;
  /** TypeScript snippet the LLM should paste. */
  tsSlice: string;
}

export interface FieldDoc {
  kind: "field";
  path: string;
  type: string;
  doc: string;
}

export type Doc = EndpointDoc | FieldDoc;

interface OpenApiParam {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string };
}

interface OpenApiOp {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParam[];
}

interface OpenApiDoc {
  paths: Record<string, Record<string, OpenApiOp>>;
}

interface FieldDictEntry {
  path: string;
  type: string;
  doc: string;
}

interface FieldDict {
  fields: FieldDictEntry[];
}

function loadJson<T>(file: string): T {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up from src/search → repo root → schema
  const p = resolve(here, "..", "..", "schema", file);
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

function sdkMethodFor(operationId: string, parameters: OpenApiParam[]): string {
  switch (operationId) {
    case "searchStudies":
      return "ctgov.studies.search({ /* params */ })";
    case "getStudy":
      return 'ctgov.studies.get("NCT00000000", { /* opts */ })';
    case "getStudiesMetadata":
      return "ctgov.studies.metadata()";
    case "getSearchAreas":
      return "ctgov.studies.searchAreas()";
    case "getEnums":
      return "ctgov.studies.enums()";
    case "getSizeStats":
      return "ctgov.stats.size()";
    case "getFieldValueStats":
      return 'ctgov.stats.fieldValues({ fields: ["..."] })';
    case "getFieldSizeStats":
      return 'ctgov.stats.fieldSizes({ fields: ["..."] })';
    case "getVersion":
      return "ctgov.version()";
    default:
      return `/* unmapped ${operationId}(${parameters.map((p) => p.name).join(", ")}) */`;
  }
}

function renderTsSlice(op: EndpointDoc): string {
  const paramLines = op.parameters
    .map((p) => `  ${p.name}${p.required ? "" : "?"}: ${tsType(p.type)}; // ${p.description ?? ""}`)
    .join("\n");
  return [
    `// ${op.method.toUpperCase()} ${op.path}`,
    op.summary ? `// ${op.summary}` : null,
    op.description ? `// ${op.description.replaceAll("\n", " ")}` : null,
    "// Parameters:",
    paramLines,
    "// Example:",
    `// await ${sdkMethodFor(op.operationId, op.parameters)};`,
  ]
    .filter(Boolean)
    .join("\n");
}

function tsType(t?: string): string {
  switch (t) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "string[]";
    default:
      return "string";
  }
}

export interface BuiltCorpus {
  bm25: BM25Index;
  endpoints: EndpointDoc[];
  fields: FieldDoc[];
}

let cache: BuiltCorpus | null = null;

export function buildCorpus(): BuiltCorpus {
  if (cache) return cache;

  const api = loadJson<OpenApiDoc>("openapi.pinned.json");
  const dict = loadJson<FieldDict>("field-dictionary.json");

  const endpoints: EndpointDoc[] = [];
  for (const [path, methods] of Object.entries(api.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      const doc: EndpointDoc = {
        kind: "endpoint",
        operationId: op.operationId ?? `${method}:${path}`,
        path,
        method,
        ...(op.summary !== undefined ? { summary: op.summary } : {}),
        ...(op.description !== undefined ? { description: op.description } : {}),
        parameters: (op.parameters ?? []).map((p) => {
          const out: EndpointDoc["parameters"][number] = {
            name: p.name,
            in: p.in,
          };
          if (p.required !== undefined) out.required = p.required;
          if (p.description !== undefined) out.description = p.description;
          if (p.schema?.type !== undefined) out.type = p.schema.type;
          return out;
        }),
        tsSlice: "",
      };
      doc.tsSlice = renderTsSlice(doc);
      endpoints.push(doc);
    }
  }

  const fields: FieldDoc[] = dict.fields.map((f) => ({
    kind: "field",
    path: f.path,
    type: f.type,
    doc: f.doc,
  }));

  const bm25 = new BM25Index();
  for (const e of endpoints) {
    bm25.add({
      id: `endpoint:${e.operationId}`,
      text: [e.path, e.operationId, e.summary, e.description, e.parameters.map((p) => `${p.name} ${p.description ?? ""}`).join(" ")].join(" "),
      payload: e,
    });
  }
  for (const f of fields) {
    bm25.add({
      id: `field:${f.path}`,
      text: `${f.path} ${f.type} ${f.doc}`,
      payload: f,
    });
  }

  cache = { bm25, endpoints, fields };
  return cache;
}

export function searchCorpus(query: string, k = 8): BM25SearchResult[] {
  return buildCorpus().bm25.search(query, k);
}
