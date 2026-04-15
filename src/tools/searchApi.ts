import { z } from "zod";
import { searchCorpus, type EndpointDoc, type FieldDoc } from "../search/corpus.js";

export const SearchApiInput = z.object({
  query: z.string().min(1, "query is required"),
  k: z.number().int().min(1).max(25).optional(),
});

export interface SearchApiResult {
  query: string;
  hits: Array<
    | { kind: "endpoint"; score: number; endpoint: EndpointDoc }
    | { kind: "field"; score: number; field: FieldDoc }
  >;
  snippet: string;
}

export function runSearchApi(input: z.infer<typeof SearchApiInput>): SearchApiResult {
  const k = input.k ?? 8;
  const results = searchCorpus(input.query, k);

  const hits = results.map((r) => {
    const p = r.payload as EndpointDoc | FieldDoc;
    if (p.kind === "endpoint") {
      return { kind: "endpoint" as const, score: r.score, endpoint: p };
    }
    return { kind: "field" as const, score: r.score, field: p };
  });

  const snippetParts: string[] = [];
  snippetParts.push("// Top matches for: " + JSON.stringify(input.query));
  for (const hit of hits) {
    if (hit.kind === "endpoint") {
      snippetParts.push(hit.endpoint.tsSlice);
    } else {
      snippetParts.push(
        `// field: ${hit.field.path} (${hit.field.type}) — ${hit.field.doc}`,
      );
    }
  }
  return { query: input.query, hits, snippet: snippetParts.join("\n\n") };
}
