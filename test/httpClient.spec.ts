import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent } from "undici";
import { HttpClient } from "../src/supervisor/httpClient.js";
import { CtGovError } from "../src/supervisor/errors.js";
import { newAuditContext } from "../src/supervisor/audit.js";

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
});

afterEach(async () => {
  await mockAgent.close();
});

describe("HttpClient (with undici MockAgent)", () => {
  it("parses JSON on 200 and caches subsequent calls", async () => {
    const pool = mockAgent.get("https://clinicaltrials.gov");
    pool
      .intercept({ path: "/api/v2/version", method: "GET" })
      .reply(200, { apiVersion: "2.0.0" }, { headers: { "content-type": "application/json" } });

    const client = new HttpClient({ dispatcher: mockAgent });
    const v1 = await client.get<{ apiVersion: string }>({ path: "/version" });
    expect(v1.apiVersion).toBe("2.0.0");
    // Second call: cache hit — no second interceptor is set; if the cache
    // didn't kick in, this would throw ENOCONN.
    const v2 = await client.get<{ apiVersion: string }>({ path: "/version" });
    expect(v2.apiVersion).toBe("2.0.0");
  });

  it("throws NOT_FOUND on 404", async () => {
    const pool = mockAgent.get("https://clinicaltrials.gov");
    pool.intercept({ path: "/api/v2/studies/NCT00000000", method: "GET" }).reply(404);
    const client = new HttpClient({ dispatcher: mockAgent });
    await expect(
      client.get({ path: "/studies/NCT00000000" }),
    ).rejects.toBeInstanceOf(CtGovError);
  });

  it("records audit entries on success", async () => {
    const pool = mockAgent.get("https://clinicaltrials.gov");
    pool
      .intercept({ path: "/api/v2/version", method: "GET" })
      .reply(200, { apiVersion: "x" }, { headers: { "content-type": "application/json" } });

    const client = new HttpClient({ dispatcher: mockAgent });
    const audit = newAuditContext("test-sub");
    await client.get({ path: "/version", audit });
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]?.status).toBe(200);
    expect(audit.calls[0]?.cacheHit).toBe(false);
  });

  it("retries on 503 and eventually succeeds", async () => {
    const pool = mockAgent.get("https://clinicaltrials.gov");
    pool.intercept({ path: "/api/v2/version", method: "GET" }).reply(503, "try later");
    pool
      .intercept({ path: "/api/v2/version", method: "GET" })
      .reply(200, { apiVersion: "ok" }, { headers: { "content-type": "application/json" } });

    const client = new HttpClient({ dispatcher: mockAgent });
    const v = await client.get<{ apiVersion: string }>({ path: "/version" });
    expect(v.apiVersion).toBe("ok");
  });
});
