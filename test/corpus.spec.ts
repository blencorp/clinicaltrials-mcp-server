import { describe, it, expect } from "vitest";
import { runSearchApi } from "../src/tools/searchApi.js";
import { runDescribeSchema } from "../src/tools/describeSchema.js";

describe("search_api", () => {
  it("matches the studies search endpoint for an obvious query", () => {
    const out = runSearchApi({ query: "search studies condition recruiting phase" });
    expect(out.hits.length).toBeGreaterThan(0);
    const operationIds = out.hits
      .filter((h) => h.kind === "endpoint")
      .map((h) => (h as { kind: "endpoint"; endpoint: { operationId: string } }).endpoint.operationId);
    expect(operationIds).toContain("searchStudies");
    expect(out.snippet).toContain("ctgov.studies.search");
  });

  it("matches fields for eligibility-ish queries", () => {
    const out = runSearchApi({ query: "eligibility inclusion exclusion criteria" });
    const fieldHits = out.hits.filter((h) => h.kind === "field");
    expect(fieldHits.length).toBeGreaterThan(0);
  });
});

describe("describe_schema", () => {
  it("filters by prefix", () => {
    const out = runDescribeSchema({ prefix: "protocolSection.designModule" });
    expect(out.total).toBeGreaterThan(0);
    for (const m of out.matches) expect(m.path.startsWith("protocolSection.designModule")).toBe(true);
  });
});
