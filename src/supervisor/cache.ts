import { LRUCache } from "lru-cache";

export interface CachedResponse {
  status: number;
  body: unknown;
  etag?: string;
  fetchedAt: number;
}

export interface CacheOptions {
  maxEntries: number;
  ttlMs: number;
}

export class ResponseCache {
  private readonly cache: LRUCache<string, CachedResponse>;

  constructor(opts: CacheOptions) {
    this.cache = new LRUCache<string, CachedResponse>({
      max: opts.maxEntries,
      ttl: opts.ttlMs,
      allowStale: true,
      updateAgeOnGet: false,
    });
  }

  key(method: string, url: string): string {
    return `${method} ${url}`;
  }

  get(key: string, opts: { allowStale?: boolean } = {}): CachedResponse | undefined {
    return this.cache.get(key, { allowStale: opts.allowStale ?? false });
  }

  set(key: string, value: CachedResponse): void {
    this.cache.set(key, value);
  }

  size(): number {
    return this.cache.size;
  }
}
