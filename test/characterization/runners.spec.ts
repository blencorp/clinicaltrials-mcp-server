// Characterization: every ctgov.* method reached through the sandbox shim of BOTH real runners
// (isolate and Deno), so broken argument forwarding in src/sdk/bindings.ts cannot hide behind the
// direct buildRpcDispatch table in sdkWire.spec.ts. Also searchAll terminating when
// nextPageToken disappears. Passes unchanged on the pre-migration code (package C replaces searchAll).
import { describe, expect, it } from "vitest";
import { DenoExecutor, isDenoAvailable } from "../../src/sandbox/deno.js";
import { IsolateExecutor, isIsolateAvailable } from "../../src/sandbox/isolate.js";
import type { SandboxExecutor } from "../../src/sandbox/types.js";
import { buildRpcDispatch, CtGovRuntime } from "../../src/sdk/runtime.js";
import { newAuditContext } from "../../src/supervisor/audit.js";
import { fakeUpstream, newClient, type FakeUpstream } from "./helpers.js";

const RUNNERS: Array<{ kind: string; available: boolean; make: () => SandboxExecutor }> = [
  { kind: "isolate", available: isIsolateAvailable(), make: () => new IsolateExecutor() },
  { kind: "deno", available: isDenoAvailable(), make: () => new DenoExecutor() },
];

async function run(make: () => SandboxExecutor, upstream: FakeUpstream, code: string) {
  const rt = new CtGovRuntime({ http: newClient(upstream), audit: newAuditContext() });
  try {
    const out = await make().execute({ code, timeoutMs: 10_000, dispatch: buildRpcDispatch(rt) });
    expect(out.ok, JSON.stringify(out.error)).toBe(true);
    return { result: out.result, paths: upstream.requests.map((r) => r.path) };
  } finally {
    await upstream.close();
  }
}

describe.each(RUNNERS)("every ctgov method through the $kind shim", ({ available, make }) => {
  const maybe = it.skipIf(!available);
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

  for (const [label, code, path] of rows) {
    maybe(`${label} -> GET ${path} and returns the upstream body`, async () => {
      const { result, paths } = await run(make, fakeUpstream(() => ({ status: 200, body: { echo: label } })), code);
      expect(paths).toEqual([path]);
      expect(result).toEqual({ echo: label });
    });
  }

  maybe("searchAll stops when nextPageToken disappears, chaining the token until then", async () => {
    const upstream = fakeUpstream((_req, i) =>
      i < 2 ? { status: 200, body: { studies: [{ n: i }], nextPageToken: `t${i + 1}` } } : { status: 200, body: { studies: [{ n: i }] } },
    );
    const { result, paths } = await run(
      make,
      upstream,
      `const seen = []; for await (const s of ctgov.studies.searchAll({ "query.cond": "x" })) seen.push(s.n); return seen;`,
    );
    expect(result).toEqual([0, 1, 2]);
    expect(paths).toEqual([
      "/studies?query.cond=x&pageSize=100",
      "/studies?query.cond=x&pageSize=100&pageToken=t1",
      "/studies?query.cond=x&pageSize=100&pageToken=t2",
    ]);
  });
});
