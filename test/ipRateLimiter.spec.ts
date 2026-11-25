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

  it("refunds a spent token, up to burst", () => {
    const lim = new IpRateLimiter(0, 1);
    expect(lim.allow("1.2.3.4")).toBe(true);
    lim.refund("1.2.3.4");
    lim.refund("1.2.3.4");
    expect(lim.allow("1.2.3.4")).toBe(true);
    expect(lim.allow("1.2.3.4")).toBe(false);
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
});

describe("failure budget and /64 bucketing", () => {
  it("available() spends nothing, spend() floors at zero", () => {
    const lim = new IpRateLimiter(0, 3);
    for (let i = 0; i < 5; i++) expect(lim.available("1.2.3.4")).toBe(true);
    for (let i = 0; i < 10; i++) lim.spend("1.2.3.4");
    expect(lim.available("1.2.3.4")).toBe(false);
    expect(lim.available("5.6.7.8")).toBe(true);
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
    const failures = new IpRateLimiter(0.001, 1);
    failures.spend("2001:db8:7:7::1");
    expect(failures.available("2001:db8:7:7:5::2")).toBe(false);
    expect(failures.available("2001:db8:7:8::2")).toBe(true);
  });

  it("counts an IPv4-mapped address as its IPv4 client", () => {
    expect(bucketKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(bucketKey("::ffff:203.0.113.5")).not.toBe(bucketKey("::ffff:198.51.100.9"));
  });
});
