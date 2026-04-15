/**
 * Token-bucket rate limiter.
 * ClinicalTrials.gov v2 documents 10 req/sec.
 */
export interface RateLimiterOptions {
  /** Sustained rate in requests per second. */
  ratePerSec: number;
  /** Maximum burst size (tokens). */
  burst: number;
}

export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill: number;
  private queue: Array<() => void> = [];

  constructor(opts: RateLimiterOptions) {
    this.capacity = opts.burst;
    this.tokens = opts.burst;
    this.refillPerMs = opts.ratePerSec / 1000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
     
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs));
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.queue = this.queue.filter((f) => f !== resolve);
          resolve();
        }, waitMs);
        t.unref?.();
        this.queue.push(resolve);
      });
    }
  }

  snapshot(): { tokens: number; capacity: number } {
    this.refill();
    return { tokens: this.tokens, capacity: this.capacity };
  }
}
