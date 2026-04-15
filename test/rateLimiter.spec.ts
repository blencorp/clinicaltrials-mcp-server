import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/supervisor/rateLimiter.js";

describe("RateLimiter", () => {
  it("allows burst up to capacity immediately", async () => {
    const rl = new RateLimiter({ ratePerSec: 10, burst: 5 });
    const t0 = Date.now();
    await Promise.all([rl.acquire(), rl.acquire(), rl.acquire(), rl.acquire(), rl.acquire()]);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("throttles beyond burst", async () => {
    const rl = new RateLimiter({ ratePerSec: 20, burst: 1 });
    const t0 = Date.now();
    await rl.acquire();
    await rl.acquire();
    const elapsed = Date.now() - t0;
    // 1 extra token at 20/s -> ~50ms
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});
