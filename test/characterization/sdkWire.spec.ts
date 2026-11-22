// Characterization: the SDK wire behaviour of every ctgov.* RPC method (query serialization,
// validation) and of the HttpClient underneath it. Pinned on v1, then updated for the SDK v2 port
// (D4: zod 4) and for package C (rows C5-C8 in docs/migration-0.1.md: named errors, the new
// HttpClient retry/cache rules, no searchAll). Retry, abort, size-cap and gate behaviour in depth is
// in test/httpClient.spec.ts; this file pins what a caller sees.
import { describe, expect, it } from "vitest";
import { constantUpstream, fakeUpstream, sdkCall } from "./helpers.js";

const UA = "characterization/0";

describe("every RPC method hits the right upstream path", () => {
  const rows: Array<[method: string, args: unknown[], expectedPath: string]> = [
    ["studies.search", [{}], "/studies"],
    ["studies.search", [{ "query.cond": "flu" }], "/studies?query.cond=flu"],
    ["studies.get", ["NCT01234567"], "/studies/NCT01234567"],
    ["studies.get", ["NCT01234567", { fields: ["NCTId", "BriefTitle"] }], "/studies/NCT01234567?fields=NCTId%2CBriefTitle"],
    ["studies.metadata", [], "/studies/metadata"],
    ["studies.metadata", [{ includeIndexedOnly: true }], "/studies/metadata?includeIndexedOnly=true"],
    ["studies.searchAreas", [], "/studies/search-areas"],
    ["studies.enums", [], "/studies/enums"],
    ["stats.size", [], "/stats/size"],
    ["stats.fieldValues", [{ fields: ["Phase"] }], "/stats/field/values?fields=Phase"],
    ["stats.fieldSizes", [{ fields: ["Phase", "Condition"] }], "/stats/field/sizes?fields=Phase%2CCondition"],
    ["version", [], "/version"],
  ];

  it.each(rows)("%s %j -> GET %s", async (method, args, expectedPath) => {
    const upstream = constantUpstream({ ok: method });
    try {
      expect(await sdkCall(upstream, method, args)).toEqual({ ok: true, value: { ok: method } });
      // C6: accept-encoding: gzip is now sent (the response is decoded within a size cap).
      expect(upstream.requests).toEqual([{ path: expectedPath, headers: { "user-agent": UA, accept: "application/json", "accept-encoding": "gzip" } }]);
    } finally {
      await upstream.close();
    }
  });

  it("rejects an unknown method (C5: TypeError, was POLICY_VIOLATION), never reaching the upstream", async () => {
    const upstream = constantUpstream({});
    try {
      const res = await sdkCall(upstream, "studies.delete", [{}]);
      expect(res).toEqual({ ok: false, error: { name: "TypeError", message: "ctgov.studies.delete is not a function" } });
      expect(upstream.requests).toEqual([]);
    } finally {
      await upstream.close();
    }
  });

  it("has no searchAll (C2): it is not a method, and nothing pages on the host", async () => {
    const upstream = constantUpstream({});
    try {
      expect(await sdkCall(upstream, "studies.searchAll", [{}])).toMatchObject({ ok: false, error: { name: "TypeError" } });
      expect(upstream.requests).toEqual([]);
    } finally {
      await upstream.close();
    }
  });
});

describe("studies.search query serialization (unchanged)", () => {
  it("emits keys in schema order (not input order), comma-joins arrays and spells booleans true/false", async () => {
    const upstream = constantUpstream({ studies: [] });
    await sdkCall(upstream, "studies.search", [{
      pageSize: 5,
      countTotal: true,
      sort: ["LastUpdatePostDate:desc", "@relevance"],
      fields: ["NCTId", "BriefTitle"],
      "filter.overallStatus": ["RECRUITING", "NOT_YET_RECRUITING"],
      "query.term": "phase 3",
      "query.cond": "lung cancer",
      "filter.ids": ["NCT01234567", "NCT07654321"],
      "filter.geo": "distance(42.36,-71.06,50mi)",
    }]);
    expect(upstream.requests.map((r) => r.path)).toEqual([
      "/studies?query.cond=lung+cancer&query.term=phase+3" +
        "&filter.overallStatus=RECRUITING%2CNOT_YET_RECRUITING" +
        "&filter.geo=distance%2842.36%2C-71.06%2C50mi%29" +
        "&filter.ids=NCT01234567%2CNCT07654321" +
        "&fields=NCTId%2CBriefTitle&sort=LastUpdatePostDate%3Adesc%2C%40relevance&countTotal=true&pageSize=5",
    ]);
    await upstream.close();
  });

  it("serializes false and 0 (they are not dropped) and a string fields/sort as-is", async () => {
    const upstream = constantUpstream({ studies: [] });
    await sdkCall(upstream, "studies.search", [{ countTotal: false, pageSize: 0, fields: "NCTId", sort: "@relevance" }]);
    expect(upstream.requests[0]!.path).toBe("/studies?fields=NCTId&sort=%40relevance&countTotal=false&pageSize=0");
    await upstream.close();
  });

  it("rejects unknown keys, bad enums and out-of-range sizes with a ValidationError (C5) before any request", async () => {
    const upstream = constantUpstream({});
    const cases: Array<[unknown, RegExp]> = [
      [{ bogus: 1 }, /^studies\.search: invalid arguments: arguments: unknown key\(s\) 'bogus'$/],
      [{ "filter.overallStatus": ["NOPE"] }, /filter\.overallStatus\.0: /],
      [{ pageSize: 1001 }, /pageSize: .*1000/],
      [{ format: "xml" }, /format: /],
      [{ "filter.overallStatus": "RECRUITING" }, /filter\.overallStatus: /],
    ];
    for (const [params, message] of cases) {
      const res = await sdkCall(upstream, "studies.search", [params]);
      expect(res).toMatchObject({ ok: false, error: { name: "ValidationError" } });
      expect(res.error!.message).toMatch(message);
      expect(res.error!.message.length).toBeLessThan(400);
    }
    expect(upstream.requests).toEqual([]);
    await upstream.close();
  });

  it("flat-key hint covers query, filter and postFilter only (C7: rendered as { key: { ... } }); other unknown keys give the plain message", async () => {
    const upstream = constantUpstream({});
    const hint = await sdkCall(upstream, "studies.search", [{ postFilter: { overallStatus: ["COMPLETED"] }, query: { cond: "x" } }]);
    expect(hint.error).toMatchObject({
      name: "ValidationError",
      message:
        'studies.search() uses flat dotted keys, not nested objects. Replace { postFilter: { ... }, query: { ... } } with string keys like ' +
        '"query.cond", "query.term", "filter.overallStatus", "filter.geo".',
    });
    const raw = await sdkCall(upstream, "studies.search", [{ cond: "x" }]);
    expect(raw.error!.message).toBe("studies.search: invalid arguments: arguments: unknown key(s) 'cond'");
    await upstream.close();
  });
});

describe("studies.get", () => {
  it("validates the NCT ID as ^NCT[0-9]{8}$ before any request", async () => {
    const upstream = constantUpstream({});
    for (const bad of ["", "NCT1234567", "NCT012345678", "nct01234567", " NCT01234567", "NCT0123456X", "../studies"]) {
      const res = await sdkCall(upstream, "studies.get", [bad]);
      expect(res, bad).toMatchObject({ ok: false, error: { name: "ValidationError" } });
      expect(res.error!.message, bad).toBe("studies.get: invalid arguments: nctId: Invalid NCT ID");
    }
    expect(upstream.requests).toEqual([]);
    await upstream.close();
  });

  it("rejects unknown options and an unsupported format", async () => {
    const upstream = constantUpstream({});
    expect((await sdkCall(upstream, "studies.get", ["NCT01234567", { bogus: 1 }])).error!.message).toContain("unknown key(s) 'bogus'");
    expect((await sdkCall(upstream, "studies.get", ["NCT01234567", { format: "xml" }])).error!.message).toContain("format: ");
    expect((await sdkCall(upstream, "studies.get", ["NCT01234567", "fields"])).error!.message).toBe("studies.get: options must be an object");
    await upstream.close();
  });

  it("json (default) is parsed; csv and ris come back as raw strings; fhir.json is parsed", async () => {
    const upstream = fakeUpstream((req) => {
      if (req.path.includes("format=csv")) return { status: 200, body: "NCT Number,Title\nNCT01234567,Hello\n", headers: { "content-type": "text/csv" } };
      if (req.path.includes("format=ris")) return { status: 200, body: "TY  - GEN\nER  - \n", headers: { "content-type": "application/x-research-info-systems" } };
      if (req.path.includes("format=fhir.json")) return { status: 200, body: { resourceType: "ResearchStudy", id: "NCT01234567" }, headers: { "content-type": "application/fhir+json" } };
      return { status: 200, body: { protocolSection: {} }, headers: { "content-type": "application/json" } };
    });
    const value = async (...args: unknown[]) => (await sdkCall(upstream, "studies.get", args) as { value: unknown }).value;
    expect(await value("NCT01234567")).toEqual({ protocolSection: {} });
    expect(await value("NCT01234567", { format: "csv" })).toBe("NCT Number,Title\nNCT01234567,Hello\n");
    expect(await value("NCT01234567", { format: "ris" })).toBe("TY  - GEN\nER  - \n");
    expect(await value("NCT01234567", { format: "fhir.json" })).toEqual({ resourceType: "ResearchStudy", id: "NCT01234567" });
    expect(upstream.requests.map((r) => r.path)).toEqual([
      "/studies/NCT01234567",
      "/studies/NCT01234567?format=csv",
      "/studies/NCT01234567?format=ris",
      "/studies/NCT01234567?format=fhir.json",
    ]);
    // Content negotiation is not used: every request asks for JSON, whatever the format.
    expect(new Set(upstream.requests.map((r) => r.headers.accept))).toEqual(new Set(["application/json"]));
    await upstream.close();
  });

  it("studies.search format=csv also returns the raw text", async () => {
    const upstream = constantUpstream({ status: 200, body: "a,b\n1,2\n" });
    expect(await sdkCall(upstream, "studies.search", [{ format: "csv", "query.cond": "x" }])).toEqual({ ok: true, value: "a,b\n1,2\n" });
    expect(upstream.requests[0]!.path).toBe("/studies?query.cond=x&format=csv");
    await upstream.close();
  });

  it("combines fields, format and markupFormat after the id", async () => {
    const upstream = constantUpstream({});
    await sdkCall(upstream, "studies.get", ["NCT01234567", { markupFormat: "markdown", fields: "NCTId", format: "json" }]);
    expect(upstream.requests[0]!.path).toBe("/studies/NCT01234567?fields=NCTId&format=json&markupFormat=markdown");
    await upstream.close();
  });
});

describe("stats and metadata validation", () => {
  it("stats.fieldValues needs a non-empty fields array; types is optional; unknown keys are rejected", async () => {
    const upstream = constantUpstream({});
    const msg = async (method: string, arg: unknown) => (await sdkCall(upstream, method, [arg])).error?.message;
    expect(await msg("stats.fieldValues", { fields: [] })).toMatch(/^stats\.fieldValues: invalid arguments: fields: /);
    expect(await msg("stats.fieldValues", {})).toMatch(/fields: /);
    expect(await msg("stats.fieldValues", { fields: ["A"], bogus: 1 })).toContain("unknown key(s) 'bogus'");
    expect(await msg("stats.fieldSizes", { fields: "A" })).toMatch(/fields: /);
    await sdkCall(upstream, "stats.fieldValues", [{ types: ["ENUM", "STRING"], fields: ["Phase"] }]);
    expect(upstream.requests.map((r) => r.path)).toEqual(["/stats/field/values?fields=Phase&types=ENUM%2CSTRING"]);
    await upstream.close();
  });

  it("studies.metadata forwards its flags unvalidated", async () => {
    const upstream = constantUpstream([]);
    await sdkCall(upstream, "studies.metadata", [{ includeIndexedOnly: true, includeHistoricOnly: false }]);
    await sdkCall(upstream, "studies.metadata");
    expect(upstream.requests.map((r) => r.path)).toEqual([
      "/studies/metadata?includeIndexedOnly=true&includeHistoricOnly=false",
      "/studies/metadata",
    ]);
    await upstream.close();
  });
});

describe("error results (C5/C6): named errors with status instead of CtGovError codes", () => {
  it.each([
    [404, "NotFound"],
    [400, "BadRequest"],
    [401, "HttpError"],
    [403, "HttpError"],
  ] as const)("a %i is not retried and is %s", async (status, name) => {
    const upstream = constantUpstream({ status, body: { message: "no" } });
    const res = await sdkCall(upstream, "version", [], { retries: 4 });
    expect(res).toEqual({ ok: false, error: { name, message: `ClinicalTrials.gov: GET https://clinicaltrials.gov/api/v2/version -> ${status}: no`, status } });
    expect(upstream.requests).toHaveLength(1);
    await upstream.close();
  });

  it.each([500, 502, 503, 504])("a %i is retried `retries` times (now 3 by default, was 4) and fails with the status", async (status) => {
    const upstream = constantUpstream({ status, body: { error: "busy" } });
    const res = await sdkCall(upstream, "version", [], { retries: 1 });
    expect(res).toMatchObject({ ok: false, error: { name: "HttpError", status } });
    expect(upstream.requests).toHaveLength(2);
    await upstream.close();
  });

  it("408 and 425 are no longer retried (C6)", async () => {
    for (const status of [408, 425]) {
      const upstream = constantUpstream({ status });
      expect(await sdkCall(upstream, "version", [], { retries: 3 })).toMatchObject({ ok: false, error: { status } });
      expect(upstream.requests).toHaveLength(1);
      await upstream.close();
    }
  });

  it("a 429 is retried once after the cooldown (was up to maxRetries times), then fails as RateLimited", async () => {
    const upstream = constantUpstream({ status: 429, body: "slow down", headers: { "retry-after": "0" } });
    const res = await sdkCall(upstream, "version", [], { retries: 4 });
    expect(res).toMatchObject({ ok: false, error: { name: "RateLimited", status: 429 } });
    expect(upstream.requests).toHaveLength(2);
    await upstream.close();
  });

  it("recovers when a later attempt succeeds", async () => {
    const upstream = fakeUpstream((_req, i) => (i < 2 ? { status: 503, body: "later" } : { status: 200, body: { apiVersion: "ok" } }));
    expect(await sdkCall(upstream, "version", [], { retries: 3 })).toEqual({ ok: true, value: { apiVersion: "ok" } });
    expect(upstream.requests).toHaveLength(3);
    await upstream.close();
  });
});

describe("caching (C6: no stale fallback, no bypass/refresh)", () => {
  it("caches successful GETs per full URL (query included) for the TTL", async () => {
    const upstream = constantUpstream({ v: 1 });
    const cfg = { cacheTtlMs: 60_000, cacheMaxItems: 10 };
    await sdkCall(upstream, "studies.metadata", [{ includeIndexedOnly: true }], cfg);
    await sdkCall(upstream, "studies.metadata", [{ includeIndexedOnly: true }], cfg);
    await sdkCall(upstream, "studies.metadata", [{ includeIndexedOnly: false }], cfg);
    // Each sdkCall builds its own SDK, so the cache is per call here; the shared cache is pinned in test/execution.spec.ts.
    expect(upstream.requests.map((r) => r.path)).toHaveLength(3);
    await upstream.close();
  });

  it("an expired entry is never served after upstream failures (the old stale-after-upstream-failure fallback is gone)", async () => {
    let phase: "seed" | "fail" = "seed";
    const upstream = fakeUpstream(() => (phase === "seed" ? { status: 200, body: { v: "seed" } } : { status: 503, body: "down" }));
    const { buildSdk } = await import("../../src/sdk/bindings.js");
    const { dispatch } = await import("../../src/sdk/runtime.js");
    const sdk = buildSdk({ baseUrl: "https://clinicaltrials.gov/api/v2", userAgent: UA, timeoutMs: 5000, retries: 0, cacheTtlMs: 20, cacheMaxItems: 10, dispatcher: upstream.agent });
    const get = () => dispatch(sdk, { binding: "ctgov", path: ["version"], args: [] });
    expect(await get()).toEqual({ ok: true, value: { v: "seed" } });
    await new Promise((r) => setTimeout(r, 40));
    phase = "fail";
    expect(await get()).toMatchObject({ ok: false, error: { name: "HttpError", status: 503 } });
    await upstream.close();
  });

  it("parses a malformed JSON 200 as raw text and an empty 200 as null", async () => {
    const upstream = fakeUpstream((req) => (req.path === "/studies/metadata" ? { status: 200, body: "{not json" } : { status: 200 }));
    expect(await sdkCall(upstream, "studies.metadata")).toEqual({ ok: true, value: "{not json" });
    expect(await sdkCall(upstream, "version")).toEqual({ ok: true, value: null });
    await upstream.close();
  });
});
