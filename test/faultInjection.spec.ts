import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { HttpClient } from "../src/supervisor/httpClient.js";
import { ResponseCache } from "../src/supervisor/cache.js";
import { RateLimiter } from "../src/supervisor/rateLimiter.js";
import { CtGovError } from "../src/supervisor/errors.js";

let agent: MockAgent;
let original: Dispatcher;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(original);
});

describe("fault injection", () => {
  it("retries 429 with Retry-After then succeeds", async () => {
    const pool = agent.get("https://clinicaltrials.gov");
    pool
      .intercept({ path: "/api/v2/version", method: "GET" })
      .reply(429, "slow down", { headers: { "retry-after": "0" } });
    pool
      .intercept({ path: "/api/v2/version", method: "GET" })
      .reply(
        200,
        { apiVersion: "recovered" },
        { headers: { "content-type": "application/json" } },
      );

    const client = new HttpClient({
      rateLimiter: new RateLimiter({ ratePerSec: 100, burst: 100 }),
    });
    const v = await client.get<{ apiVersion: string }>({ path: "/version" });
    expect(v.apiVersion).toBe("recovered");
  });

  it("raises RATE_LIMITED after exhausting retries on 429", async () => {
    const pool = agent.get("https://clinicaltrials.gov");
    for (let i = 0; i < 10; i++) {
      pool
        .intercept({ path: "/api/v2/version", method: "GET" })
        .reply(429, "slow down", { headers: { "retry-after": "0" } });
    }

    const client = new HttpClient({
      rateLimiter: new RateLimiter({ ratePerSec: 100, burst: 100 }),
      maxRetries: 1,
    });
    await expect(client.get({ path: "/version" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("falls back to stale cache when upstream keeps failing", async () => {
    const pool = agent.get("https://clinicaltrials.gov");

    // Seed cache with a successful response
    pool
      .intercept({ path: "/api/v2/version", method: "GET" })
      .reply(
        200,
        { apiVersion: "cached" },
        { headers: { "content-type": "application/json" } },
      );

    const client = new HttpClient({
      rateLimiter: new RateLimiter({ ratePerSec: 100, burst: 100 }),
      cache: new ResponseCache({ maxEntries: 10, ttlMs: 1 }), // immediately stale
      maxRetries: 1,
    });
    const seeded = await client.get<{ apiVersion: string }>({ path: "/version" });
    expect(seeded.apiVersion).toBe("cached");

    // Make the cache stale (sleep > ttlMs)
    await new Promise((r) => setTimeout(r, 10));

    // Refresh should fail hard ...
    pool.intercept({ path: "/api/v2/version", method: "GET" }).reply(503, "down");
    pool.intercept({ path: "/api/v2/version", method: "GET" }).reply(503, "down");
    const refreshed = await client.get<{ apiVersion: string }>({
      path: "/version",
      cache: "refresh",
    });
    // ... but the stale value is returned.
    expect(refreshed.apiVersion).toBe("cached");
  });

  it("parses malformed JSON as raw text (no crash)", async () => {
    const pool = agent.get("https://clinicaltrials.gov");
    pool
      .intercept({ path: "/api/v2/version", method: "GET" })
      .reply(200, "not-json", { headers: { "content-type": "text/plain" } });

    const client = new HttpClient({
      rateLimiter: new RateLimiter({ ratePerSec: 100, burst: 100 }),
    });
    const out = await client.get<unknown>({ path: "/version" });
    expect(out).toBe("not-json");
  });

  it("surfaces network errors as UPSTREAM_UNAVAILABLE", async () => {
    const pool = agent.get("https://clinicaltrials.gov");
    pool
      .intercept({ path: "/api/v2/version", method: "GET" })
      .replyWithError(new Error("ECONNRESET"));
    pool
      .intercept({ path: "/api/v2/version", method: "GET" })
      .replyWithError(new Error("ECONNRESET"));

    const client = new HttpClient({
      rateLimiter: new RateLimiter({ ratePerSec: 100, burst: 100 }),
      maxRetries: 1,
    });
    const err = await client
      .get({ path: "/version" })
      .catch((e: unknown) => e as CtGovError);
    expect(err).toBeInstanceOf(CtGovError);
    expect((err as CtGovError).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("NOT_FOUND is not retried", async () => {
    const pool = agent.get("https://clinicaltrials.gov");
    pool.intercept({ path: "/api/v2/studies/NCT12345678", method: "GET" }).reply(404);

    const client = new HttpClient({
      rateLimiter: new RateLimiter({ ratePerSec: 100, burst: 100 }),
      maxRetries: 3,
    });
    const err = await client
      .get({ path: "/studies/NCT12345678" })
      .catch((e: unknown) => e as CtGovError);
    expect(err).toBeInstanceOf(CtGovError);
    expect((err as CtGovError).code).toBe("NOT_FOUND");
  });
});
