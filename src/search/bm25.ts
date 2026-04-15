/**
 * Tiny BM25 implementation. Zero deps, deterministic.
 */
export interface BM25Doc {
  id: string;
  text: string;
  /** Arbitrary payload returned alongside search results. */
  payload: unknown;
}

export interface BM25SearchResult {
  id: string;
  score: number;
  payload: unknown;
}

const K1 = 1.5;
const B = 0.75;

function tokenize(s: string): string[] {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9_.]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

export class BM25Index {
  private readonly docs: BM25Doc[] = [];
  private readonly tokens: string[][] = [];
  private readonly docFreq = new Map<string, number>();
  private avgDl = 0;

  add(doc: BM25Doc): void {
    const toks = tokenize(doc.text);
    this.docs.push(doc);
    this.tokens.push(toks);
    const seen = new Set<string>();
    for (const t of toks) {
      if (seen.has(t)) continue;
      seen.add(t);
      this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
    }
    this.recomputeAvg();
  }

  bulk(docs: BM25Doc[]): void {
    for (const d of docs) this.add(d);
  }

  private recomputeAvg(): void {
    const total = this.tokens.reduce((a, t) => a + t.length, 0);
    this.avgDl = total / Math.max(1, this.tokens.length);
  }

  search(query: string, k = 10): BM25SearchResult[] {
    const qToks = tokenize(query);
    if (!qToks.length || !this.docs.length) return [];
    const N = this.docs.length;
    const scores = new Array<number>(N).fill(0);
    for (const q of qToks) {
      const df = this.docFreq.get(q) ?? 0;
      if (df === 0) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < N; i++) {
        const toks = this.tokens[i] ?? [];
        const tf = toks.reduce((a, t) => (t === q ? a + 1 : a), 0);
        if (tf === 0) continue;
        const dl = toks.length;
        const num = tf * (K1 + 1);
        const den = tf + K1 * (1 - B + (B * dl) / Math.max(1, this.avgDl));
        scores[i] = (scores[i] ?? 0) + idf * (num / den);
      }
    }
    const ranked: BM25SearchResult[] = scores
      .map((score, i) => {
        const doc = this.docs[i];
        if (!doc || score <= 0) return null;
        return { id: doc.id, score, payload: doc.payload };
      })
      .filter((r): r is BM25SearchResult => r !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return ranked;
  }
}
