import { describe, it, expect } from "vitest";
import { buildSdk } from "../src/sdk/bindings.js";
import { dispatch } from "../src/sdk/runtime.js";

const live = process.env.CTGOV_LIVE === "1";

describe.skipIf(!live)("live integration (CT.gov)", () => {
  const sdk = buildSdk({
    baseUrl: "https://clinicaltrials.gov/api/v2",
    userAgent: "clinicaltrials-mcp-server live test",
    timeoutMs: 20_000,
    retries: 2,
    cacheTtlMs: 0,
    cacheMaxItems: 0,
  });
  const call = async (method: string, ...args: unknown[]) => {
    const res = await dispatch(sdk, { binding: "ctgov", path: method.split("."), args });
    if (!res.ok) throw new Error(`${res.error?.name}: ${res.error?.message}`);
    return res.value;
  };

  it("/version returns something plausible", async () => {
    const v = (await call("version")) as { apiVersion?: string };
    expect(typeof v.apiVersion).toBe("string");
  });

  it("studies.search returns at least one cancer trial", async () => {
    const page = (await call("studies.search", {
      "query.cond": "lung cancer",
      pageSize: 3,
      countTotal: true,
      fields: ["NCTId", "BriefTitle"],
    })) as { studies: unknown[]; totalCount: number };
    expect(page.studies.length).toBeGreaterThan(0);
    expect(page.totalCount).toBeGreaterThan(100);
  });

  it("studies.get round-trips an NCT id", async () => {
    const study = (await call("studies.get", "NCT04852770", { fields: ["NCTId"] })) as {
      protocolSection?: { identificationModule?: { nctId?: string } };
    };
    expect(study.protocolSection?.identificationModule?.nctId).toBe("NCT04852770");
  });

  it("a pageToken loop reads a second page", async () => {
    const first = (await call("studies.search", { "query.cond": "diabetes", pageSize: 50, fields: ["NCTId"] })) as {
      studies: unknown[];
      nextPageToken?: string;
    };
    expect(first.nextPageToken).toBeTruthy();
    const second = (await call("studies.search", { "query.cond": "diabetes", pageSize: 50, fields: ["NCTId"], pageToken: first.nextPageToken })) as { studies: unknown[] };
    expect(first.studies.length + second.studies.length).toBe(100);
  });
});
