// Characterization: pins the v1 SDK wire behaviour of every ctgov.* RPC method and of the
// HttpClient underneath it (query serialization, validation, retry/backoff, caching, paging).
// Pinned on v1; the only change in the SDK v2 package is zod 4's issue codes (invalid_enum_value is
// now invalid_value, D4 in docs/migration-0.1.md). Packages C changes the searchAll rows.
import { describe, expect, it } from "vitest";
import { MockAgent } from "undici";
import { DenoExecutor, isDenoAvailable } from "../../src/sandbox/deno.js";
import { buildRpcDispatch, CtGovRuntime } from "../../src/sdk/runtime.js";
import { newAuditContext } from "../../src/supervisor/audit.js";
import { ResponseCache } from "../../src/supervisor/cache.js";
import { CtGovError } from "../../src/supervisor/errors.js";
import { HttpClient } from "../../src/supervisor/httpClient.js";
import { RateLimiter } from "../../src/supervisor/rateLimiter.js";
import { constantUpstream, fakeUpstream, fastLimiter, newClient, type FakeUpstream } from "./helpers.js";

const UA = "clinicaltrial-mcp-server/0.1 (+opensource@blencorp.com)";

async function withRuntime<T>(
  upstream: FakeUpstream,
  fn: (rt: CtGovRuntime, audit: ReturnType<typeof newAuditContext>) => Promise<T>,
): Promise<T> {
  const audit = newAuditContext();
  try {
    return await fn(new CtGovRuntime({ http: newClient(upstream), audit }), audit);
  } finally {
    await upstream.close();
  }
}

/** Runs `p` and returns what it rejected with (failing the test if it resolved). */
async function rejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("every RPC method hits the right upstream path (v1)", () => {
  const rows: Array<[method: string, args: unknown, expectedPath: string]> = [
    ["studies.search", {}, "/studies"],
    ["studies.search", { "query.cond": "flu" }, "/studies?query.cond=flu"],
    ["studies.get", { nctId: "NCT01234567" }, "/studies/NCT01234567"],
    ["studies.get", { nctId: "NCT01234567", fields: ["NCTId", "BriefTitle"] }, "/studies/NCT01234567?fields=NCTId%2CBriefTitle"],
    ["studies.metadata", {}, "/studies/metadata"],
    ["studies.metadata", { includeIndexedOnly: true }, "/studies/metadata?includeIndexedOnly=true"],
    ["studies.searchAreas", {}, "/studies/search-areas"],
    ["studies.enums", {}, "/studies/enums"],
    ["stats.size", {}, "/stats/size"],
    ["stats.fieldValues", { fields: ["Phase"] }, "/stats/field/values?fields=Phase"],
    ["stats.fieldSizes", { fields: ["Phase", "Condition"] }, "/stats/field/sizes?fields=Phase%2CCondition"],
    ["version", {}, "/version"],
  ];

  it.each(rows)("%s %j -> GET %s", async (method, args, expectedPath) => {
    const upstream = constantUpstream({ ok: method });
    const result = await withRuntime(upstream, async (rt) => buildRpcDispatch(rt)(method, args));
    expect(result).toEqual({ ok: method });
    expect(upstream.requests).toEqual([{ path: expectedPath, headers: { "user-agent": UA, accept: "application/json" } }]);
  });

  it("rejects an unknown method with POLICY_VIOLATION", async () => {
    const upstream = constantUpstream({});
    const err = await withRuntime(upstream, (rt) => rejection(buildRpcDispatch(rt)("studies.delete", {})));
    expect(err).toBeInstanceOf(CtGovError);
    expect(err.toJSON()).toEqual({ name: "CtGovError", code: "POLICY_VIOLATION", message: "Unknown SDK method: studies.delete" });
    expect(upstream.requests).toEqual([]);
  });

  it("dispatch exposes searchAll to nothing: it is not an RPC method (the sandbox shim pages studies.search)", async () => {
    const upstream = constantUpstream({});
    const err = await withRuntime(upstream, (rt) => rejection(buildRpcDispatch(rt)("studies.searchAll", {})));
    expect(err.code).toBe("POLICY_VIOLATION");
  });
});

describe("studies.search query serialization (v1)", () => {
  it("emits keys in schema order (not input order), comma-joins arrays and spells booleans true/false", async () => {
    const upstream = constantUpstream({ studies: [] });
    await withRuntime(upstream, (rt) =>
      rt.studies.search({
        pageSize: 5,
        countTotal: true,
        sort: ["LastUpdatePostDate:desc", "@relevance"],
        fields: ["NCTId", "BriefTitle"],
        "filter.overallStatus": ["RECRUITING", "NOT_YET_RECRUITING"],
        "query.term": "phase 3",
        "query.cond": "lung cancer",
        "filter.ids": ["NCT01234567", "NCT07654321"],
        "filter.geo": "distance(42.36,-71.06,50mi)",
      }),
    );
    expect(upstream.requests.map((r) => r.path)).toEqual([
      "/studies?query.cond=lung+cancer&query.term=phase+3" +
        "&filter.overallStatus=RECRUITING%2CNOT_YET_RECRUITING" +
        "&filter.geo=distance%2842.36%2C-71.06%2C50mi%29" +
        "&filter.ids=NCT01234567%2CNCT07654321" +
        "&fields=NCTId%2CBriefTitle&sort=LastUpdatePostDate%3Adesc%2C%40relevance&countTotal=true&pageSize=5",
    ]);
  });

  it("serializes false and 0 (they are not dropped) and a string fields/sort as-is", async () => {
    const upstream = constantUpstream({ studies: [] });
    await withRuntime(upstream, (rt) => rt.studies.search({ countTotal: false, pageSize: 0, fields: "NCTId", sort: "@relevance" }));
    expect(upstream.requests[0]!.path).toBe("/studies?fields=NCTId&sort=%40relevance&countTotal=false&pageSize=0");
  });

  it("rejects unknown keys, bad enums and out-of-range sizes with a ZodError before any request", async () => {
    const upstream = constantUpstream({});
    const rt = new CtGovRuntime({ http: newClient(upstream), audit: newAuditContext() });
    const cases: Array<[unknown, string, string]> = [
      [{ bogus: 1 }, "unrecognized_keys", ""],
      [{ "filter.overallStatus": ["NOPE"] }, "invalid_value", "filter.overallStatus,0"],
      [{ pageSize: 1001 }, "too_big", "pageSize"],
      [{ format: "xml" }, "invalid_value", "format"],
      [{ "filter.overallStatus": "RECRUITING" }, "invalid_type", "filter.overallStatus"],
    ];
    for (const [params, code, path] of cases) {
      const err = await rejection(rt.studies.search(params as never));
      expect(err.name).toBe("ZodError");
      expect(err.issues[0].code).toBe(code);
      expect(err.issues[0].path.join(",")).toBe(path);
    }
    expect(upstream.requests).toEqual([]);
    await upstream.close();
  });

  it("flat-key hint covers query, filter and postFilter only; other unknown keys keep the raw ZodError", async () => {
    const upstream = constantUpstream({});
    const rt = new CtGovRuntime({ http: newClient(upstream), audit: newAuditContext() });
    const hint = await rejection(rt.studies.search({ postFilter: { overallStatus: ["COMPLETED"] } } as never));
    expect(hint).toBeInstanceOf(CtGovError);
    expect(hint.code).toBe("VALIDATION_ERROR");
    expect(hint.message).toContain("Replace { postFilter: { ... } }");
    const raw = await rejection(rt.studies.search({ cond: "x" } as never));
    expect(raw.name).toBe("ZodError");
    await upstream.close();
  });
});

describe("studies.get (v1)", () => {
  it("validates the NCT ID as ^NCT[0-9]{8}$ before any request", async () => {
    const upstream = constantUpstream({});
    const rt = new CtGovRuntime({ http: newClient(upstream), audit: newAuditContext() });
    for (const bad of ["", "NCT1234567", "NCT012345678", "nct01234567", " NCT01234567", "NCT0123456X", "../studies"]) {
      const err = await rejection(rt.studies.get(bad));
      expect(err.name, bad).toBe("ZodError");
      expect(err.issues[0].message).toBe("Invalid NCT ID");
    }
    expect(upstream.requests).toEqual([]);
    await upstream.close();
  });

  it("rejects unknown options and an unsupported format", async () => {
    const upstream = constantUpstream({});
    const rt = new CtGovRuntime({ http: newClient(upstream), audit: newAuditContext() });
    expect((await rejection(rt.studies.get("NCT01234567", { bogus: 1 } as never))).issues[0].code).toBe("unrecognized_keys");
    expect((await rejection(rt.studies.get("NCT01234567", { format: "xml" } as never))).issues[0].code).toBe("invalid_value");
    await upstream.close();
  });

  it("json (default) is parsed; csv and ris come back as raw strings; fhir.json is parsed", async () => {
    const upstream = fakeUpstream((req) => {
      if (req.path.includes("format=csv")) return { status: 200, body: "NCT Number,Title\nNCT01234567,Hello\n", headers: { "content-type": "text/csv" } };
      if (req.path.includes("format=ris")) return { status: 200, body: "TY  - GEN\nER  - \n", headers: { "content-type": "application/x-research-info-systems" } };
      if (req.path.includes("format=fhir.json")) return { status: 200, body: { resourceType: "ResearchStudy", id: "NCT01234567" }, headers: { "content-type": "application/fhir+json" } };
      return { status: 200, body: { protocolSection: {} }, headers: { "content-type": "application/json" } };
    });
    await withRuntime(upstream, async (rt) => {
      expect(await rt.studies.get("NCT01234567")).toEqual({ protocolSection: {} });
      expect(await rt.studies.get("NCT01234567", { format: "csv" })).toBe("NCT Number,Title\nNCT01234567,Hello\n");
      expect(await rt.studies.get("NCT01234567", { format: "ris" })).toBe("TY  - GEN\nER  - \n");
      expect(await rt.studies.get("NCT01234567", { format: "fhir.json" })).toEqual({ resourceType: "ResearchStudy", id: "NCT01234567" });
    });
    expect(upstream.requests.map((r) => r.path)).toEqual([
      "/studies/NCT01234567",
      "/studies/NCT01234567?format=csv",
      "/studies/NCT01234567?format=ris",
      "/studies/NCT01234567?format=fhir.json",
    ]);
    // Content negotiation is not used: every request asks for JSON, whatever the format.
    expect(new Set(upstream.requests.map((r) => r.headers.accept))).toEqual(new Set(["application/json"]));
  });

  it("studies.search format=csv also returns the raw text", async () => {
    const upstream = constantUpstream({ status: 200, body: "a,b\n1,2\n" });
    const out = await withRuntime(upstream, (rt) => rt.studies.search({ format: "csv", "query.cond": "x" }));
    expect(out).toBe("a,b\n1,2\n");
    expect(upstream.requests[0]!.path).toBe("/studies?query.cond=x&format=csv");
  });

  it("combines fields, format and markupFormat after the id", async () => {
    const upstream = constantUpstream({});
    await withRuntime(upstream, (rt) => rt.studies.get("NCT01234567", { markupFormat: "markdown", fields: "NCTId", format: "json" }));
    expect(upstream.requests[0]!.path).toBe("/studies/NCT01234567?fields=NCTId&format=json&markupFormat=markdown");
  });
});

describe("stats and metadata validation (v1)", () => {
  it("stats.fieldValues needs a non-empty fields array; types is optional; unknown keys are rejected", async () => {
    const upstream = constantUpstream({});
    const rt = new CtGovRuntime({ http: newClient(upstream), audit: newAuditContext() });
    expect((await rejection(rt.stats.fieldValues({ fields: [] } as never))).issues[0].code).toBe("too_small");
    expect((await rejection(rt.stats.fieldValues({} as never))).issues[0].code).toBe("invalid_type");
    expect((await rejection(rt.stats.fieldValues({ fields: ["A"], bogus: 1 } as never))).issues[0].code).toBe("unrecognized_keys");
    expect((await rejection(rt.stats.fieldSizes({ fields: "A" } as never))).issues[0].code).toBe("invalid_type");
    await rt.stats.fieldValues({ types: ["ENUM", "STRING"], fields: ["Phase"] });
    expect(upstream.requests.map((r) => r.path)).toEqual(["/stats/field/values?fields=Phase&types=ENUM%2CSTRING"]);
    await upstream.close();
  });

  it("studies.metadata forwards its flags unvalidated", async () => {
    const upstream = constantUpstream([]);
    await withRuntime(upstream, async (rt) => {
      await rt.studies.metadata({ includeIndexedOnly: true, includeHistoricOnly: false });
      await rt.studies.metadata();
    });
    expect(upstream.requests.map((r) => r.path)).toEqual([
      "/studies/metadata?includeIndexedOnly=true&includeHistoricOnly=false",
      "/studies/metadata",
    ]);
  });
});

describe("retry and backoff (v1)", () => {
  // Retry-After: 0 keeps these fast; without it the backoff is 250ms * 2^attempt plus <100ms jitter.
  const retryAfter0 = { "retry-after": "0" };

  it("retries 408, 425, 429, 500, 502, 503, 504 (maxRetries 4 -> 5 attempts) and fails with the upstream status", async () => {
    for (const status of [408, 425, 500, 502, 503, 504]) {
      const upstream = constantUpstream({ status, body: { error: "busy" }, headers: retryAfter0 });
      const client = newClient(upstream);
      const err = await rejection(client.get({ path: "/version" }));
      expect(err.toJSON(), String(status)).toEqual({
        name: "CtGovError",
        code: "UPSTREAM_HTTP_ERROR",
        message: `Upstream ${status} for /version`,
        status,
        details: { error: "busy" },
      });
      expect(upstream.requests, String(status)).toHaveLength(5);
      await upstream.close();
    }
  });

  it("429 exhausts to RATE_LIMITED after the same 5 attempts", async () => {
    const upstream = constantUpstream({ status: 429, body: "slow down", headers: retryAfter0 });
    const err = await rejection(newClient(upstream).get({ path: "/version" }));
    expect(err.toJSON()).toEqual({
      name: "CtGovError",
      code: "RATE_LIMITED",
      message: "Upstream 429 for /version",
      status: 429,
      details: "slow down",
    });
    expect(upstream.requests).toHaveLength(5);
    await upstream.close();
  });

  it("maxRetries bounds the attempts (maxRetries 0 -> 1 attempt, 2 -> 3)", async () => {
    for (const [maxRetries, attempts] of [[0, 1], [2, 3]] as const) {
      const upstream = constantUpstream({ status: 503, headers: retryAfter0 });
      await rejection(newClient(upstream, { maxRetries }).get({ path: "/version" }));
      expect(upstream.requests).toHaveLength(attempts);
      await upstream.close();
    }
  });

  it("does not retry other 4xx (400, 401, 403) or 404", async () => {
    for (const status of [400, 401, 403]) {
      const upstream = constantUpstream({ status, body: "no" });
      const err = await rejection(newClient(upstream).get({ path: "/version" }));
      expect(err.code).toBe("UPSTREAM_HTTP_ERROR");
      expect(err.status).toBe(status);
      expect(upstream.requests).toHaveLength(1);
      await upstream.close();
    }
    const upstream = constantUpstream({ status: 404 });
    const err = await rejection(newClient(upstream).get({ path: "/studies/NCT00000000" }));
    expect(err.toJSON()).toEqual({ name: "CtGovError", code: "NOT_FOUND", message: "Resource not found: /studies/NCT00000000", status: 404 });
    expect(upstream.requests).toHaveLength(1);
    await upstream.close();
  });

  it("recovers when a later attempt succeeds, and records each retry in the audit trace", async () => {
    const upstream = fakeUpstream((_req, i) =>
      i < 2 ? { status: 503, body: "later", headers: retryAfter0 } : { status: 200, body: { apiVersion: "ok" } },
    );
    const audit = newAuditContext();
    const out = await newClient(upstream).get({ path: "/version", audit });
    expect(out).toEqual({ apiVersion: "ok" });
    expect(audit.calls.map((c) => [c.status, c.error ?? null, c.cacheHit])).toEqual([
      [503, "retry-503-after-0ms", false],
      [503, "retry-503-after-0ms", false],
      [200, null, false],
    ]);
    await upstream.close();
  });

  it("without Retry-After the backoff is 250ms * 2^attempt plus under 100ms of jitter", async () => {
    const upstream = constantUpstream({ status: 503 });
    const audit = newAuditContext();
    await rejection(newClient(upstream, { maxRetries: 2 }).get({ path: "/version", audit }));
    const waits = audit.calls.map((c) => Number(/after-(\d+)ms/.exec(c.error ?? "")?.[1] ?? NaN));
    expect(waits[0]).toBeGreaterThanOrEqual(250);
    expect(waits[0]).toBeLessThan(350);
    expect(waits[1]).toBeGreaterThanOrEqual(500);
    expect(waits[1]).toBeLessThan(600);
    // The final failed attempt is recorded too, with the (here empty) body as its error.
    expect(audit.calls).toHaveLength(3);
    expect(audit.calls[2]).toMatchObject({ status: 503, error: "" });
    await upstream.close();
  });

  it("network errors retry then fail as UPSTREAM_UNAVAILABLE; a stale entry is NOT served for them", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get("https://clinicaltrials.gov");
    pool.intercept({ path: "/api/v2/version", method: "GET" }).reply(200, { apiVersion: "seed" });
    const cache = new ResponseCache({ maxEntries: 10, ttlMs: 1 });
    const client = new HttpClient({ dispatcher: agent, rateLimiter: fastLimiter(), cache, maxRetries: 1 });
    expect(await client.get({ path: "/version" })).toEqual({ apiVersion: "seed" });
    await new Promise((r) => setTimeout(r, 10));
    pool.intercept({ path: "/api/v2/version", method: "GET" }).replyWithError(new Error("ECONNRESET")).times(5);
    const err = await rejection(client.get({ path: "/version", cache: "refresh" }));
    expect(err.toJSON()).toEqual({ name: "CtGovError", code: "UPSTREAM_UNAVAILABLE", message: "Upstream network error: /version" });
    expect(agent.pendingInterceptors().map((p) => (p as unknown as { timesInvoked: number }).timesInvoked)).toEqual([2]);
    await agent.close();
  });

  it("a request that outlives timeoutMs fails as TIMEOUT after the allowed attempts", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent.get("https://clinicaltrials.gov").intercept({ path: "/api/v2/version", method: "GET" }).reply(200, {}).delay(300).persist();
    const client = new HttpClient({ dispatcher: agent, rateLimiter: fastLimiter(), timeoutMs: 40, maxRetries: 0 });
    const err = await rejection(client.get({ path: "/version" }));
    expect(err.toJSON()).toEqual({ name: "CtGovError", code: "TIMEOUT", message: "Request timed out: /version" });
    await agent.close();
  });
});

describe("caching and stale fallback (v1)", () => {
  const retryAfter0 = { "retry-after": "0" };

  it("caches successful GETs per full URL (query included) for the default TTL", async () => {
    const upstream = constantUpstream({ v: 1 });
    const client = newClient(upstream);
    await client.get({ path: "/studies", query: { a: 1 } });
    await client.get({ path: "/studies", query: { a: 1 } });
    await client.get({ path: "/studies", query: { a: 2 } });
    expect(upstream.requests.map((r) => r.path)).toEqual(["/studies?a=1", "/studies?a=2"]);
    await upstream.close();
  });

  it("cache bypass/refresh skip the read but still store the new value", async () => {
    let n = 0;
    const upstream = fakeUpstream(() => ({ status: 200, body: { n: ++n } }));
    const client = newClient(upstream);
    expect(await client.get({ path: "/version" })).toEqual({ n: 1 });
    expect(await client.get({ path: "/version", cache: "bypass" })).toEqual({ n: 2 });
    expect(await client.get({ path: "/version", cache: "refresh" })).toEqual({ n: 3 });
    expect(await client.get({ path: "/version" })).toEqual({ n: 3 });
    expect(upstream.requests).toHaveLength(3);
    await upstream.close();
  });

  it("does not cache a 404 (the next call goes upstream again)", async () => {
    let n = 0;
    const upstream = fakeUpstream(() => (++n === 1 ? { status: 404 } : { status: 200, body: { found: true } }));
    const client = newClient(upstream);
    await rejection(client.get({ path: "/studies/NCT00000000" }));
    expect(await client.get({ path: "/studies/NCT00000000" })).toEqual({ found: true });
    expect(upstream.requests).toHaveLength(2);
    await upstream.close();
  });

  it("serves an expired entry after exhausted 500/503/429 retries ONLY when the read was skipped (cache: refresh|bypass)", async () => {
    for (const status of [500, 503, 429]) {
      for (const mode of ["use", "refresh", "bypass"] as const) {
        let phase: "seed" | "fail" = "seed";
        const upstream = fakeUpstream(() =>
          phase === "seed" ? { status: 200, body: { v: "seed" } } : { status, body: "down", headers: retryAfter0 },
        );
        const client = newClient(upstream, { cache: new ResponseCache({ maxEntries: 10, ttlMs: 1 }) });
        expect(await client.get({ path: "/version" })).toEqual({ v: "seed" });
        await new Promise((r) => setTimeout(r, 10));
        phase = "fail";
        const audit = newAuditContext();
        const attempt = client.get({ path: "/version", audit, cache: mode });
        if (mode === "use") {
          // The default read of an expired entry evicts it, so there is nothing stale left to serve.
          const err = await rejection(attempt);
          expect(err.code, `${status} ${mode}`).toBe(status === 429 ? "RATE_LIMITED" : "UPSTREAM_HTTP_ERROR");
        } else {
          expect(await attempt, `${status} ${mode}`).toEqual({ v: "seed" });
          expect(audit.calls.at(-1)).toMatchObject({ cacheHit: true, error: "stale-after-upstream-failure" });
        }
        expect(upstream.requests, `${status} ${mode}`).toHaveLength(1 + 5);
        await upstream.close();
      }
    }
  });

  it("never serves a stale entry for 400 or 404", async () => {
    for (const status of [400, 404]) {
      let phase: "seed" | "fail" = "seed";
      const upstream = fakeUpstream(() => (phase === "seed" ? { status: 200, body: { v: "seed" } } : { status }));
      const client = newClient(upstream, { cache: new ResponseCache({ maxEntries: 10, ttlMs: 1 }) });
      await client.get({ path: "/version" });
      await new Promise((r) => setTimeout(r, 10));
      phase = "fail";
      const err = await rejection(client.get({ path: "/version", cache: "refresh" }));
      expect(err.code).toBe(status === 404 ? "NOT_FOUND" : "UPSTREAM_HTTP_ERROR");
      await upstream.close();
    }
  });

  it("parses a malformed JSON 200 as raw text and an empty 200 as null", async () => {
    const upstream = fakeUpstream((req) => (req.path === "/a" ? { status: 200, body: "{not json" } : { status: 200 }));
    const client = newClient(upstream);
    expect(await client.get({ path: "/a" })).toBe("{not json");
    expect(await client.get({ path: "/b" })).toBeNull();
    await upstream.close();
  });
});

describe("request plumbing (v1)", () => {
  it("sends the default user-agent and accept headers, then headersProvider overrides", async () => {
    const upstream = constantUpstream({});
    const client = newClient(upstream, { headersProvider: () => ({ "x-extra": "1", accept: "text/csv" }), userAgent: "ua/1" });
    await client.get({ path: "/version" });
    expect(upstream.requests[0]!.headers).toEqual({ "user-agent": "ua/1", accept: "text/csv", "x-extra": "1" });
    await upstream.close();
  });

  it("uses acquireFn instead of the rate limiter when given, once per attempt", async () => {
    const upstream = constantUpstream({ status: 503, headers: { "retry-after": "0" } });
    let acquired = 0;
    const limiter = new RateLimiter({ ratePerSec: 1, burst: 1 });
    const client = new HttpClient({
      dispatcher: upstream.agent,
      rateLimiter: limiter,
      acquireFn: async () => {
        acquired++;
      },
      maxRetries: 2,
    });
    await rejection(client.get({ path: "/version" }));
    expect(acquired).toBe(3);
    expect(limiter.snapshot().tokens).toBe(1); // the built-in limiter was never touched
    await upstream.close();
  });

  it("skips null/undefined query values and records the cache hit in the audit trace", async () => {
    const upstream = constantUpstream({ x: 1 });
    const client = newClient(upstream);
    const audit = newAuditContext();
    await client.get({ path: "/x", query: { a: undefined, b: null, c: "1" }, audit });
    await client.get({ path: "/x", query: { c: "1" }, audit });
    expect(upstream.requests.map((r) => r.path)).toEqual(["/x?c=1"]);
    expect(audit.calls.map((c) => [c.status, c.cacheHit, c.durationMs])).toEqual([
      [200, false, expect.any(Number)],
      [200, true, 0],
    ]);
    await upstream.close();
  });
});

describe("runtime searchAll paging, host side (v1)", () => {
  const paged = (): FakeUpstream =>
    fakeUpstream((_req, i) => ({ status: 200, body: { studies: [{ n: i }], nextPageToken: `t${i + 1}` } }));

  it("defaults to 10 pages of pageSize 100, chaining pageToken from each response", async () => {
    const upstream = paged();
    const seen: unknown[] = [];
    await withRuntime(upstream, async (rt) => {
      for await (const s of rt.studies.searchAll({ "query.cond": "x" })) seen.push(s);
    });
    expect(seen).toEqual(Array.from({ length: 10 }, (_, n) => ({ n })));
    expect(upstream.requests.map((r) => r.path)).toEqual([
      "/studies?query.cond=x&pageSize=100",
      ...Array.from({ length: 9 }, (_, i) => `/studies?query.cond=x&pageSize=100&pageToken=t${i + 1}`),
    ]);
  });

  it("caps maxPages at 100 and honours pageSize", async () => {
    const upstream = paged();
    let count = 0;
    await withRuntime(upstream, async (rt) => {
      for await (const _ of rt.studies.searchAll({}, { maxPages: 500, pageSize: 7 })) count++;
    });
    expect(count).toBe(100);
    expect(upstream.requests).toHaveLength(100);
    expect(upstream.requests[0]!.path).toBe("/studies?pageSize=7");
    expect(upstream.requests[99]!.path).toBe("/studies?pageSize=7&pageToken=t99");
  });

  it("stops at the first page without nextPageToken, and maxPages: 0 makes no request", async () => {
    const upstream = fakeUpstream((_req, i) =>
      i === 0 ? { status: 200, body: { studies: [{ a: 1 }, { a: 2 }], nextPageToken: "t1" } } : { status: 200, body: { studies: [{ a: 3 }] } },
    );
    await withRuntime(upstream, async (rt) => {
      const all: unknown[] = [];
      for await (const s of rt.studies.searchAll({})) all.push(s);
      expect(all).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
      const none: unknown[] = [];
      for await (const s of rt.studies.searchAll({}, { maxPages: 0 })) none.push(s);
      expect(none).toEqual([]);
    });
    expect(upstream.requests).toHaveLength(2);
  });

  it("validates eagerly (at the call, not on first iteration) and lets the pageSize option override params.pageSize in place", async () => {
    const upstream = paged();
    await withRuntime(upstream, async (rt) => {
      expect(() => rt.studies.searchAll({ query: { cond: "x" } } as never)).toThrow(CtGovError);
      expect(() => rt.studies.searchAll({ bogus: 1 } as never)).toThrow();
      const it = rt.studies.searchAll({ pageSize: 5, "query.cond": "x" }, { maxPages: 1 });
      for await (const _ of it) void _;
    });
    expect(upstream.requests.map((r) => r.path)).toEqual(["/studies?pageSize=100&query.cond=x"]);
  });
});

describe.skipIf(!isDenoAvailable())("sandbox searchAll shim against a real runner (v1)", () => {
  async function pagesRequested(code: string): Promise<{ paths: string[]; result: unknown }> {
    const upstream = fakeUpstream((_req, i) => ({ status: 200, body: { studies: [{ n: i }], nextPageToken: `t${i + 1}` } }));
    try {
      const audit = newAuditContext();
      const rt = new CtGovRuntime({ http: newClient(upstream), audit });
      const out = await new DenoExecutor().execute({ code, timeoutMs: 10_000, dispatch: buildRpcDispatch(rt) });
      expect(out.ok, JSON.stringify(out.error)).toBe(true);
      return { paths: upstream.requests.map((r) => r.path), result: out.result };
    } finally {
      await upstream.close();
    }
  }

  it("iterates up to 10 pages by default, pageSize 100, via studies.search RPCs", async () => {
    const { paths, result } = await pagesRequested(
      `let n = 0; for await (const s of ctgov.studies.searchAll({ "query.cond": "x" })) n++; return n;`,
    );
    expect(result).toBe(10);
    expect(paths).toHaveLength(10);
    expect(paths[0]).toBe("/studies?query.cond=x&pageSize=100");
    expect(paths[9]).toBe("/studies?query.cond=x&pageSize=100&pageToken=t9");
  });

  it("caps maxPages at 100 and treats maxPages: 0 as the default of 10 (the host-side generator would make no request)", async () => {
    const capped = await pagesRequested(
      `let n = 0; for await (const s of ctgov.studies.searchAll({}, { maxPages: 500, pageSize: 3 })) n++; return n;`,
    );
    expect(capped.result).toBe(100);
    const zero = await pagesRequested(`let n = 0; for await (const s of ctgov.studies.searchAll({}, { maxPages: 0 })) n++; return n;`);
    expect(zero.result).toBe(10);
  });
});
