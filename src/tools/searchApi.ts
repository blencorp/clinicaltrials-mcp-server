import { z } from 'zod';
import type { Corpus } from '../search/corpus.js';

export const SearchApiInput = z.object({
  query: z.string().min(1).describe('Free-text query over the ClinicalTrials.gov SDK methods and field documentation (ctgov.*) (for example: recruiting studies by condition).'),
  k: z.number().int().min(1).max(50).default(10).describe('Max number of results to return'),
});
export type SearchApiInputT = z.infer<typeof SearchApiInput>;

export interface SearchHit {
  id: string; kind: 'endpoint' | 'field'; binding: string;
  description: string; signature?: string; example?: string; score: number;
}

export function searchApi(input: SearchApiInputT, corpus: Corpus): { hits: SearchHit[]; note: string } {
  const scored = corpus.index.search(input.query, input.k);
  const hits: SearchHit[] = scored.map(s => {
    const e = corpus.entries.get(s.id)!;
    return { id: e.id, kind: e.kind, binding: e.binding, description: e.description, signature: e.signature, example: e.example, score: Math.round(s.score * 1000) / 1000 };
  });
  return { hits, note: 'Use describe_schema with `path` for exact lookup or `prefix` to explore a namespace. Use execute to run JavaScript (no type annotations) against the ctgov global.' };
}
