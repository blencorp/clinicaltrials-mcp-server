import { describe, it, expect, afterEach } from "vitest";
import type { IncomingMessage } from "node:http";
import { IpRateLimiter, clientIp } from "../src/server/ipRateLimiter.js";

function req(headers: Record<string, string | string[] | undefined>, remoteAddress?: string): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe("IpRateLimiter", () => {
  it("allows requests up to burst then rejects further", () => {
    const l = new IpRateLimiter({ ratePerSec: 1, burst: 3 });
    expect(l.check("1.1.1.1")).toBeNull();
    expect(l.check("1.1.1.1")).toBeNull();
    expect(l.check("1.1.1.1")).toBeNull();
    const retry = l.check("1.1.1.1");
    expect(typeof retry).toBe("number");
    expect(retry).toBeGreaterThanOrEqual(1);
  });

  it("tracks IPs independently", () => {
    const l = new IpRateLimiter({ ratePerSec: 1, burst: 1 });
    expect(l.check("1.1.1.1")).toBeNull();
    expect(l.check("2.2.2.2")).toBeNull();
    expect(l.check("1.1.1.1")).not.toBeNull();
    expect(l.check("2.2.2.2")).not.toBeNull();
  });
});

describe("clientIp", () => {
  const saved = process.env.CTGOV_TRUST_PROXY;
  afterEach(() => {
    if (saved === undefined) delete process.env.CTGOV_TRUST_PROXY;
    else process.env.CTGOV_TRUST_PROXY = saved;
  });

  it("returns socket.remoteAddress when CTGOV_TRUST_PROXY is unset", () => {
    delete process.env.CTGOV_TRUST_PROXY;
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.1"))).toBe("10.0.0.1");
  });

  it("returns first XFF hop when CTGOV_TRUST_PROXY=1", () => {
    process.env.CTGOV_TRUST_PROXY = "1";
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, "10.0.0.1"))).toBe("1.2.3.4");
  });

  it("trims whitespace in XFF entries", () => {
    process.env.CTGOV_TRUST_PROXY = "1";
    expect(clientIp(req({ "x-forwarded-for": "   9.9.9.9   , 5.6.7.8" }, "10.0.0.1"))).toBe("9.9.9.9");
  });

  it("handles array XFF header", () => {
    process.env.CTGOV_TRUST_PROXY = "1";
    expect(clientIp(req({ "x-forwarded-for": ["1.2.3.4, 5.6.7.8", "ignored"] }, "10.0.0.1"))).toBe("1.2.3.4");
  });

  it("falls back to socket when XFF is empty and flag is on", () => {
    process.env.CTGOV_TRUST_PROXY = "1";
    expect(clientIp(req({ "x-forwarded-for": "" }, "10.0.0.1"))).toBe("10.0.0.1");
  });

  it("returns 'unknown' when neither header nor socket is available", () => {
    delete process.env.CTGOV_TRUST_PROXY;
    expect(clientIp(req({}))).toBe("unknown");
  });
});
