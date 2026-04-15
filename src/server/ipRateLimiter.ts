import type { IncomingMessage } from "node:http";
import { LRUCache } from "lru-cache";
import { RateLimiter } from "../supervisor/rateLimiter.js";

export interface IpRateLimiterOptions {
  /** Sustained rate per IP. */
  ratePerSec?: number;
  /** Burst capacity per IP. */
  burst?: number;
  /** Max distinct IPs tracked (LRU cap). */
  maxEntries?: number;
  /** Idle TTL per bucket. */
  ttlMs?: number;
}

/**
 * Per-IP token-bucket limiter. Sits in front of auth so unauthenticated
 * floods can't exhaust JWT verification CPU or JWKS cache refreshes.
 */
export class IpRateLimiter {
  private readonly buckets: LRUCache<string, RateLimiter>;
  private readonly ratePerSec: number;
  private readonly burst: number;

  constructor(opts: IpRateLimiterOptions = {}) {
    this.ratePerSec = opts.ratePerSec ?? 5;
    this.burst = opts.burst ?? 20;
    this.buckets = new LRUCache({
      max: opts.maxEntries ?? 10_000,
      ttl: opts.ttlMs ?? 10 * 60_000,
    });
  }

  /** Returns null if allowed, or retry-after seconds if rate-limited. */
  check(ip: string): number | null {
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      bucket = new RateLimiter({ ratePerSec: this.ratePerSec, burst: this.burst });
      this.buckets.set(ip, bucket);
    }
    const snap = bucket.snapshot();
    if (snap.tokens < 1) {
      return Math.ceil(1 / this.ratePerSec);
    }
    void bucket.acquire();
    return null;
  }
}

/**
 * Resolve the client IP. When `CTGOV_TRUST_PROXY=1`, the first entry in
 * `x-forwarded-for` is trusted — only enable this when the server sits
 * behind a known proxy (Railway, Cloudflare, ALB).
 */
export function clientIp(req: IncomingMessage): string {
  if (process.env.CTGOV_TRUST_PROXY === "1") {
    const xff = req.headers["x-forwarded-for"];
    const header = Array.isArray(xff) ? xff[0] : xff;
    if (header) {
      const first = header.split(",")[0];
      if (first) return first.trim();
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}
