import { randomUUID } from "node:crypto";
import { request } from "undici";
import { CtGovError } from "./errors.js";
import { RateLimiter } from "./rateLimiter.js";
import { ResponseCache } from "./cache.js";
import { type AuditContext, recordCall } from "./audit.js";

const DEFAULT_BASE = "https://clinicaltrials.gov/api/v2";
const DEFAULT_UA = "clinicaltrial-mcp-server/0.1 (+opensource@blencorp.com)";

export interface HttpClientOptions {
  baseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxRetries?: number;
  rateLimiter?: RateLimiter;
  cache?: ResponseCache;
  /** Extra headers injected on every outbound request (e.g., future auth). */
  headersProvider?: () => Promise<Record<string, string>> | Record<string, string>;
  /**
   * Override the default rate-limit acquisition (subject-aware quota wiring).
   * If set, this replaces the internal `rateLimiter.acquire()` call.
   */
  acquireFn?: () => Promise<void>;
}

export interface RequestOptions {
  /** Path relative to baseUrl. Starts with `/`. */
  path: string;
  query?: Record<string, unknown>;
  /** Cache controls. Default: cache GETs for configured TTL. */
  cache?: "use" | "bypass" | "refresh";
  /** Propagate trace. */
  audit?: AuditContext;
}

function buildUrl(base: string, path: string, query?: Record<string, unknown>): string {
  const url = new URL(base.replace(/\/$/, "") + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        // CT.gov expects comma-joined arrays for `fields`, `sort`, `ids`, etc.
        url.searchParams.set(k, v.map(String).join(","));
      } else if (typeof v === "boolean") {
        url.searchParams.set(k, v ? "true" : "false");
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly rateLimiter: RateLimiter;
  private readonly cache: ResponseCache;
  private readonly headersProvider?: HttpClientOptions["headersProvider"];
  private readonly acquireFn?: () => Promise<void>;

  constructor(opts: HttpClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.rateLimiter = opts.rateLimiter ?? new RateLimiter({ ratePerSec: 10, burst: 10 });
    this.cache = opts.cache ?? new ResponseCache({ maxEntries: 500, ttlMs: 5 * 60_000 });
    if (opts.headersProvider !== undefined) this.headersProvider = opts.headersProvider;
    if (opts.acquireFn !== undefined) this.acquireFn = opts.acquireFn;
  }

  async get<T>(opts: RequestOptions): Promise<T> {
    const url = buildUrl(this.baseUrl, opts.path, opts.query);
    const cacheKey = this.cache.key("GET", url);
    const mode = opts.cache ?? "use";

    if (mode === "use") {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        if (opts.audit) {
          recordCall(opts.audit, {
            id: randomUUID(),
            method: "GET",
            url,
            status: cached.status,
            durationMs: 0,
            cacheHit: true,
            bytes: JSON.stringify(cached.body).length,
          });
        }
        return cached.body as T;
      }
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.acquireFn) {
        await this.acquireFn();
      } else {
        await this.rateLimiter.acquire();
      }
      const started = Date.now();
      const headers: Record<string, string> = {
        "user-agent": this.userAgent,
        accept: "application/json",
      };
      if (this.headersProvider) {
        Object.assign(headers, await this.headersProvider());
      }
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), this.timeoutMs);
      abortTimer.unref?.();
      try {
        const res = await request(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        const bodyText = await res.body.text();
        const durationMs = Date.now() - started;
        const status = res.statusCode;
        const bytes = bodyText.length;

        if (status === 404) {
          if (opts.audit) {
            recordCall(opts.audit, {
              id: randomUUID(),
              method: "GET",
              url,
              status,
              durationMs,
              cacheHit: false,
              bytes,
            });
          }
          throw new CtGovError("NOT_FOUND", `Resource not found: ${opts.path}`, { status });
        }

        if (RETRY_STATUSES.has(status) && attempt < this.maxRetries) {
          const retryAfter = res.headers["retry-after"];
          const backoff = computeBackoff(attempt, retryAfter);
          if (opts.audit) {
            recordCall(opts.audit, {
              id: randomUUID(),
              method: "GET",
              url,
              status,
              durationMs,
              cacheHit: false,
              bytes,
              error: `retry-${status}-after-${backoff}ms`,
            });
          }
          await sleep(backoff);
          continue;
        }

        if (status >= 400) {
          if (opts.audit) {
            recordCall(opts.audit, {
              id: randomUUID(),
              method: "GET",
              url,
              status,
              durationMs,
              cacheHit: false,
              bytes,
              error: bodyText.slice(0, 200),
            });
          }
          // For exhausted retries on 5xx/429, prefer a stale cached value over
          // failing the whole request. The caller can still force a refresh
          // (which would have overwritten the cache earlier if it succeeded).
          if (RETRY_STATUSES.has(status)) {
            const stale = this.cache.get(cacheKey, { allowStale: true });
            if (stale) {
              if (opts.audit) {
                recordCall(opts.audit, {
                  id: randomUUID(),
                  method: "GET",
                  url,
                  status: stale.status,
                  durationMs: 0,
                  cacheHit: true,
                  bytes: JSON.stringify(stale.body).length,
                  error: "stale-after-upstream-failure",
                });
              }
              return stale.body as T;
            }
          }
          throw new CtGovError(
            status === 429 ? "RATE_LIMITED" : "UPSTREAM_HTTP_ERROR",
            `Upstream ${status} for ${opts.path}`,
            { status, details: safeParse(bodyText) },
          );
        }

        const parsed = safeParse(bodyText) as T;
        this.cache.set(cacheKey, {
          status,
          body: parsed,
          fetchedAt: Date.now(),
        });
        if (opts.audit) {
          recordCall(opts.audit, {
            id: randomUUID(),
            method: "GET",
            url,
            status,
            durationMs,
            cacheHit: false,
            bytes,
          });
        }
        return parsed;
      } catch (err) {
        clearTimeout(abortTimer);
        lastErr = err;
        if (err instanceof CtGovError) throw err;
        const aborted =
          err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
        if (aborted) {
          if (attempt < this.maxRetries) {
            await sleep(computeBackoff(attempt));
            continue;
          }
          throw new CtGovError("TIMEOUT", `Request timed out: ${opts.path}`, { cause: err });
        }
        // Transient network error — retry
        if (attempt < this.maxRetries) {
          await sleep(computeBackoff(attempt));
          continue;
        }
        throw new CtGovError("UPSTREAM_UNAVAILABLE", `Upstream network error: ${opts.path}`, {
          cause: err,
        });
      } finally {
        clearTimeout(abortTimer);
      }
    }

    // Fallback — stale cache if we have it.
    const stale = this.cache.get(cacheKey, { allowStale: true });
    if (stale) return stale.body as T;
    throw lastErr instanceof Error
      ? new CtGovError("UPSTREAM_UNAVAILABLE", lastErr.message, { cause: lastErr })
      : new CtGovError("UPSTREAM_UNAVAILABLE", "Unknown upstream failure");
  }
}

function safeParse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function computeBackoff(attempt: number, retryAfterHeader?: string | string[]): number {
  const ra = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
  if (ra) {
    const asInt = Number(ra);
    if (Number.isFinite(asInt)) return Math.min(asInt * 1000, 30_000);
  }
  const base = 250 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(base + jitter, 8_000);
}
