import { CtGovError } from "./errors.js";
import { RateLimiter } from "./rateLimiter.js";

export interface SubjectQuotaOptions {
  /** Max `execute` tool calls per minute per subject. */
  executeRpm?: number;
  /** Max upstream API calls per minute per subject. */
  upstreamRpm?: number;
  /** Sustained upstream rate across the whole process (capped by CT.gov's 10/s). */
  globalUpstreamRps?: number;
  /** Idle eviction TTL for per-subject limiters. */
  idleTtlMs?: number;
}

interface SubjectState {
  execute: RateLimiter;
  upstream: RateLimiter;
  lastSeen: number;
}

/**
 * Enforces per-subject fair use. Limiters are token-bucket with a 1-minute
 * refill window. If a subject exceeds its quota the call throws
 * `RATE_LIMITED`, which surfaces as 429 on the HTTP transport.
 */
export class SubjectQuota {
  private readonly subjects = new Map<string, SubjectState>();
  private readonly executeRpm: number;
  private readonly upstreamRpm: number;
  private readonly idleTtlMs: number;
  private readonly globalUpstream: RateLimiter;

  constructor(opts: SubjectQuotaOptions = {}) {
    this.executeRpm = opts.executeRpm ?? 60;
    this.upstreamRpm = opts.upstreamRpm ?? 600;
    this.idleTtlMs = opts.idleTtlMs ?? 15 * 60_000;
    this.globalUpstream = new RateLimiter({
      ratePerSec: opts.globalUpstreamRps ?? 10,
      burst: 10,
    });
  }

  private getState(sub: string): SubjectState {
    this.sweep();
    let s = this.subjects.get(sub);
    if (!s) {
      s = {
        execute: new RateLimiter({
          ratePerSec: this.executeRpm / 60,
          burst: Math.max(4, Math.ceil(this.executeRpm / 6)),
        }),
        upstream: new RateLimiter({
          ratePerSec: this.upstreamRpm / 60,
          burst: Math.max(10, Math.ceil(this.upstreamRpm / 6)),
        }),
        lastSeen: Date.now(),
      };
      this.subjects.set(sub, s);
    } else {
      s.lastSeen = Date.now();
    }
    return s;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [k, v] of this.subjects) {
      if (v.lastSeen < cutoff) this.subjects.delete(k);
    }
  }

  /**
   * Throws `RATE_LIMITED` if the subject has burned its per-minute execute
   * budget. Non-blocking: reserves a token synchronously from the bucket.
   */
  tryConsumeExecute(sub: string): void {
    const s = this.getState(sub);
    const snap = s.execute.snapshot();
    if (snap.tokens < 1) {
      throw new CtGovError(
        "RATE_LIMITED",
        `execute quota exceeded for subject (limit ${this.executeRpm}/min)`,
      );
    }
    // Consume without waiting; the internal bucket uses async `acquire`, so
    // we invoke it and don't wait — it resolves immediately when a token is
    // available (we just asserted it was).
    void s.execute.acquire();
  }

  /**
   * Returns a limiter-like async gate for one upstream call: waits on the
   * per-subject bucket first, then the global bucket. Used by the supervisor.
   */
  async acquireUpstream(sub: string | undefined): Promise<void> {
    if (sub) {
      const s = this.getState(sub);
      const snap = s.upstream.snapshot();
      if (snap.tokens < 1) {
        throw new CtGovError(
          "RATE_LIMITED",
          `upstream quota exceeded for subject (limit ${this.upstreamRpm}/min)`,
        );
      }
      await s.upstream.acquire();
    }
    await this.globalUpstream.acquire();
  }
}
