import { describe, it, expect } from "vitest";
import { isIsolateAvailable, isDenoAvailable } from "../src/sandbox/index.js";

/**
 * Sandbox tests skip when a runner is missing, which is right on a laptop and wrong in CI: a green
 * run must mean they ran. CI sets CTGOV_REQUIRE_RUNNERS=1.
 */
describe.runIf(process.env.CTGOV_REQUIRE_RUNNERS === "1")("required test dependencies (CI)", () => {
  it("isolated-vm is available", () => {
    expect(isIsolateAvailable()).toBe(true);
  });
  it("Deno is available", () => {
    expect(isDenoAvailable()).toBe(true);
  });
});
