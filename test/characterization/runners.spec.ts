// Characterization: every ctgov.* method reached through the sandbox bridge of BOTH real runners
// (isolate and Deno), so broken argument forwarding between a runner and the methods table cannot
// hide behind the direct dispatch table in sdkWire.spec.ts. Package C: there is no searchAll, so the
// old "searchAll stops when nextPageToken disappears" row is replaced by the pageToken loop run by
// the program itself (C2).
import { describe, expect, it } from "vitest";
import { DenoRunner } from "../../src/sandbox/deno.js";
import { IsolateRunner } from "../../src/sandbox/isolate.js";
import { buildSdk } from "../../src/sdk/bindings.js";
import { dispatch } from "../../src/sdk/runtime.js";
import { fakeUpstream, type FakeUpstream } from "./helpers.js";

const RUNNERS = [new IsolateRunner(), new DenoRunner()];

async function run(runner: IsolateRunner | DenoRunner, upstream: FakeUpstream, code: string) {
  const sdk = buildSdk({
    baseUrl: "https://clinicaltrials.gov/api/v2",
    userAgent: "characterization/0",
    timeoutMs: 5000,
    retries: 0,
    cacheTtlMs: 0,
    cacheMaxItems: 0,
    dispatcher: upstream.agent,
  });
  try {
    const out = await runner.execute({ code, bindings: sdk.registeredNames, timeoutMs: 10_000 }, { dispatch: (req) => dispatch(sdk, req) });
    return { out, paths: upstream.requests.map((r) => r.path) };
  } finally {
    await upstream.close();
  }
}

describe.each(RUNNERS)("every ctgov method through the $kind runner", (runner) => {
  const rows: Array<[label: string, code: string, path: string]> = [
    ["studies.search", `return await ctgov.studies.search({ "query.cond": "flu", pageSize: 5 });`, "/studies?query.cond=flu&pageSize=5"],
    ["studies.get", `return await ctgov.studies.get("NCT01234567");`, "/studies/NCT01234567"],
    ["studies.get with options", `return await ctgov.studies.get("NCT01234567", { fields: ["NCTId", "BriefTitle"] });`, "/studies/NCT01234567?fields=NCTId%2CBriefTitle"],
    ["studies.metadata", `return await ctgov.studies.metadata();`, "/studies/metadata"],
    ["studies.metadata with flags", `return await ctgov.studies.metadata({ includeIndexedOnly: true });`, "/studies/metadata?includeIndexedOnly=true"],
    ["studies.searchAreas", `return await ctgov.studies.searchAreas();`, "/studies/search-areas"],
    ["studies.enums", `return await ctgov.studies.enums();`, "/studies/enums"],
    ["stats.size", `return await ctgov.stats.size();`, "/stats/size"],
    ["stats.fieldValues", `return await ctgov.stats.fieldValues({ fields: ["Phase"] });`, "/stats/field/values?fields=Phase"],
    ["stats.fieldSizes", `return await ctgov.stats.fieldSizes({ fields: ["Phase", "Condition"] });`, "/stats/field/sizes?fields=Phase%2CCondition"],
    ["version", `return await ctgov.version();`, "/version"],
  ];

  it.for(rows)("%s -> GET and returns the upstream body", async ([label, code, path], { skip }) => {
    if (!(await runner.available())) return skip();
    const { out, paths } = await run(runner, fakeUpstream(() => ({ status: 200, body: { echo: label } })), code);
    expect(out.ok, JSON.stringify(out.error)).toBe(true);
    expect(paths).toEqual([path]);
    expect(out.value).toEqual({ echo: label });
  });

  it("a pageToken loop pages until nextPageToken disappears, chaining the token", async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const upstream = fakeUpstream((_req, i) =>
      i < 2 ? { status: 200, body: { studies: [{ n: i }], nextPageToken: `t${i + 1}` } } : { status: 200, body: { studies: [{ n: i }] } },
    );
    const { out, paths } = await run(
      runner,
      upstream,
      `const seen = []; let pageToken; for (;;) { const p = await ctgov.studies.search({ "query.cond": "x", pageSize: 100, ...(pageToken ? { pageToken } : {}) }); seen.push(...p.studies.map(s => s.n)); pageToken = p.nextPageToken; if (!pageToken) break; } return seen;`,
    );
    expect(out.value).toEqual([0, 1, 2]);
    expect(paths).toEqual([
      "/studies?query.cond=x&pageSize=100",
      "/studies?query.cond=x&pageSize=100&pageToken=t1",
      "/studies?query.cond=x&pageSize=100&pageToken=t2",
    ]);
  });

  it("searchAll is gone (C2): calling it fails with a TypeError and makes no request", async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { out, paths } = await run(runner, fakeUpstream(() => ({ status: 200, body: {} })), `for await (const s of ctgov.studies.searchAll({})) {} return 1;`);
    expect(out.ok).toBe(false);
    expect(out.error?.name).toBe("TypeError");
    expect(paths).toEqual([]);
  });

  it("SDK errors keep their name, message and status inside the program (C5)", async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { out } = await run(
      runner,
      fakeUpstream(() => ({ status: 404, body: { message: "nope" } })),
      `try { await ctgov.studies.get("NCT00000000"); } catch (e) { return [e.name, e.status, e.message.startsWith("ClinicalTrials.gov: GET")]; }`,
    );
    expect(out).toMatchObject({ ok: true, value: ["NotFound", 404, true] });
  });
});
