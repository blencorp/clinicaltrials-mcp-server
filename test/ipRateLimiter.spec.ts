import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { IpRateLimiter, bucketKey, clientIp } from "../src/server/ipRateLimiter.js";

const req = (peer: string, headers: Record<string, string | string[]> = {}): IncomingMessage =>
  ({ socket: { remoteAddress: peer }, headers }) as unknown as IncomingMessage;

describe("IpRateLimiter", () => {
  it("allows up to burst then denies, per address", () => {
    const lim = new IpRateLimiter(1, 3);
    expect([1, 2, 3, 4].map(() => lim.allow("1.2.3.4"))).toEqual([true, true, true, false]);
    expect(lim.allow("5.6.7.8")).toBe(true);
  });

  it("accepts a zero or extreme refill rate without an invalid cache ttl", () => {
    expect(() => new IpRateLimiter(0, 1)).not.toThrow();
    expect(() => new IpRateLimiter(1e-300, 1e10)).not.toThrow();
  });
});

describe("clientIp", () => {
  it("is the TCP peer when no header is trusted, whatever the client sends", () => {
    expect(clientIp(req("10.0.0.1", { "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.8" }))).toBe("10.0.0.1");
  });

  it("strips the IPv4-mapped prefix", () => {
    expect(clientIp(req("::ffff:10.0.0.1"))).toBe("10.0.0.1");
  });

  it("uses the named header and, for a list, its rightmost entry (the nearest proxy's)", () => {
    expect(clientIp(req("10.0.0.1", { "x-real-ip": "203.0.113.8" }), "x-real-ip")).toBe("203.0.113.8");
    expect(clientIp(req("10.0.0.1", { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), "X-Forwarded-For")).toBe("203.0.113.9");
  });

  it("falls back to the peer when the trusted header is absent or empty", () => {
    expect(clientIp(req("10.0.0.1"), "x-real-ip")).toBe("10.0.0.1");
    expect(clientIp(req("10.0.0.1", { "x-real-ip": " , " }), "x-real-ip")).toBe("10.0.0.1");
  });

  it("falls back to the peer when the trusted header is not a literal address", () => {
    for (const junk of ["unknown", "evil.example", "1.2.3", "1.2.3.4:80", "<script>", "x".repeat(200), "fe80::1%eth0", `fe80::1%${"z".repeat(200)}`]) {
      expect(clientIp(req("10.0.0.1", { "x-real-ip": junk }), "x-real-ip"), junk).toBe("10.0.0.1");
    }
    // IPv4-mapped IPv6 and bracket-free IPv6 are still addresses.
    expect(clientIp(req("10.0.0.1", { "x-real-ip": "::ffff:203.0.113.8" }), "x-real-ip")).toBe("203.0.113.8");
    expect(clientIp(req("10.0.0.1", { "x-real-ip": "2001:db8::1" }), "x-real-ip")).toBe("2001:db8::1");
  });
});

describe("per-IP budget and /64 bucketing", () => {
  it("takes tokens atomically, per address", () => {
    const lim = new IpRateLimiter(0.001, 2);
    // Concurrent callers each take a token before doing work: two tokens admit exactly two.
    expect([1, 2, 3, 4].map(() => lim.allow("1.2.3.4"))).toEqual([true, true, false, false]);
    expect(lim.allow("5.6.7.8")).toBe(true);
  });

  it("counts an IPv6 address by its /64, in every method", () => {
    const lim = new IpRateLimiter(0.001, 2);
    expect(bucketKey("203.0.113.5")).toBe("203.0.113.5");
    const key = bucketKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(bucketKey("2001:DB8:1:2::1")).toBe(key);
    expect(bucketKey("2001:db8:1:2::")).toBe(key);
    expect(bucketKey("2001:db8:1:3::1")).not.toBe(key);
    expect(lim.allow("2001:db8:1:2::1")).toBe(true);
    expect(lim.allow("2001:db8:1:2:ffff::9")).toBe(true);
    expect(lim.allow("2001:db8:1:2:1:2:3:4")).toBe(false);
    expect(lim.allow("2001:db8:1:3::1")).toBe(true);
  });

  it("unmaps IPv4-mapped addresses whatever their case or spelling", () => {
    expect(bucketKey("::FFFF:203.0.113.5")).toBe("203.0.113.5");
    expect(bucketKey("::ffff:cb00:7105")).toBe("203.0.113.5");
    expect(bucketKey("::FFFF:CB00:7105")).toBe("203.0.113.5");
  });

  it("counts an IPv4-mapped address as its IPv4 client", () => {
    expect(bucketKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(bucketKey("::ffff:203.0.113.5")).not.toBe(bucketKey("::ffff:198.51.100.9"));
  });
});

describe("one canonicalizer for header and bucket", () => {
  const key = (value: string) => bucketKey(clientIp(req("10.0.0.1", { "x-real-ip": value }), "x-real-ip"));
  it("keeps mapped IPv4 clients distinct, whatever the spelling", () => {
    const same = ["203.0.113.5", "::ffff:203.0.113.5", "::FFFF:CB00:7105", "::ffff:cb00:7105", "0:0:0:0:0:ffff:cb00:7105", "0:0:0:0:0:ffff:203.0.113.5"];
    for (const v of same) expect(key(v), v).toBe("203.0.113.5");
    expect(key("0:0:0:0:0:ffff:cb00:7106")).toBe("203.0.113.6");
    expect(key("::ffff:cb00:7106")).not.toBe(key("::ffff:cb00:7105"));
  });
  it("buckets mixed-form IPv6 by /64", () => {
    const k = key("2001:db8:1:2::1");
    expect(k).toBe("2001:db8:1:2::/64");
    expect(key("2001:db8:1:2:0:0:1.2.3.4")).toBe(k);
    expect(key("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe(k);
    expect(key("2001:db8:1:3::1")).not.toBe(k);
  });
  it("admits equivalent mapped spellings through one bucket, concurrently, and other clients separately", async () => {
    const lim = new IpRateLimiter(0.001, 3);
    const spellings = ["203.0.113.5", "::ffff:203.0.113.5", "::FFFF:CB00:7105", "0:0:0:0:0:ffff:cb00:7105", "::ffff:cb00:7105"];
    const admitted = (await Promise.all(spellings.map(async v => lim.allow(key(v))))).filter(Boolean);
    expect(admitted).toHaveLength(3);
    expect(lim.allow(key("0:0:0:0:0:ffff:cb00:7106"))).toBe(true);
    const v6 = ["2001:db8:1:2::1", "2001:db8:1:2:0:0:1.2.3.4", "2001:db8:1:2:aaaa::1", "2001:db8:1:2::9"];
    expect((await Promise.all(v6.map(async v => lim.allow(key(v))))).filter(Boolean)).toHaveLength(3);
  });
});

describe("address canonicalization is linear in input size", () => {
  it("handles a huge zone id and a long digit run quickly, with mapped spellings intact", () => {
    const t0 = performance.now();
    bucketKey(`fe80::1%${"%".repeat(100_000)}`);
    bucketKey(`::ffff:1.2.3.${"9".repeat(100_000)}`);
    bucketKey(`2001:db8::${"9".repeat(100_000)}`);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(bucketKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(bucketKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(bucketKey("0:0:0:0:0:ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(bucketKey("2001:db8:1:2:0:0:203.0.113.5")).toBe("2001:db8:1:2::/64");
  });
});
