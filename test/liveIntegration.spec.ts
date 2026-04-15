import { describe, it, expect } from "vitest";
import { HttpClient } from "../src/supervisor/httpClient.js";
import { CtGovRuntime } from "../src/sdk/runtime.js";
import { newAuditContext } from "../src/supervisor/audit.js";

const live = process.env.CTGOV_LIVE === "1";

describe.skipIf(!live)("live integration (CT.gov)", () => {
  const http = new HttpClient();
  const runtime = new CtGovRuntime({ http, audit: newAuditContext() });

  it("/version returns something plausible", async () => {
    const v = (await runtime.version()) as { apiVersion?: string };
    expect(v).toBeDefined();
    expect(typeof v.apiVersion).toBe("string");
  });

  it("studies.search returns at least one cancer trial", async () => {
    const page = await runtime.studies.search({
      "query.cond": "lung cancer",
      pageSize: 3,
      countTotal: true,
      fields: ["NCTId", "BriefTitle"],
    });
    expect(page.studies.length).toBeGreaterThan(0);
    expect(page.totalCount).toBeGreaterThan(100);
  });

  it("studies.get round-trips an NCT id", async () => {
    const study = await runtime.studies.get("NCT04852770", {
      fields: ["ProtocolSection.IdentificationModule"],
    });
    const nct = (study.protocolSection as { identificationModule?: { nctId?: string } } | undefined)
      ?.identificationModule?.nctId;
    expect(nct).toBe("NCT04852770");
  });

  it("searchAll iterates pages", async () => {
    let count = 0;
    for await (const s of runtime.studies.searchAll(
      { "query.cond": "diabetes", pageSize: 50 },
      { maxPages: 2 },
    )) {
      if (s) count++;
      if (count > 75) break;
    }
    expect(count).toBeGreaterThan(50);
  });
});
