import { z } from "zod";
import { searchCorpus, type EndpointDoc, type FieldDoc } from "../search/corpus.js";

export const SearchApiInput = z.object({
  query: z.string().min(1, "query is required"),
  k: z.number().int().min(1).max(25).optional(),
});

/**
 * Canonical example prepended to every search_api snippet so the model writes
 * `ctgov.studies.search(...)` with the correct flat dotted-key shape that the
 * upstream API and our zod schema both require. The most common failure mode
 * without this is the model guessing nested `{query:{cond}, filter:{...}}`,
 * which the SDK rejects with `unrecognized_keys`.
 */
const SDK_CALL_PRIMER = `// Quick reference — the ctgov SDK uses *flat dotted keys* (mirrors the v2 REST API).
// Pass them as string keys; do NOT nest under a "query" or "filter" object.
//
//   const page = await ctgov.studies.search({
//     "query.cond": "lung cancer",          // condition
//     "query.term": "phase 3",              // free text
//     "filter.overallStatus": ["RECRUITING"],
//     "filter.geo": "distance(42.36,-71.06,50mi)",  // lat,lon,radius
//     pageSize: 20,
//     fields: ["NCTId","BriefTitle","OverallStatus","Phase","LocationFacility"],
//   });
//   return page.studies;
//
// Use ctgov.studies.searchAll(params) when you need all pages.
`;

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
  snippetParts.push(SDK_CALL_PRIMER);
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
