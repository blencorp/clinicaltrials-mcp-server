import { describe, expect, it } from "vitest";
import {
  hasRequiredResourceScope,
  isSessionSubjectAuthorized,
  requiredResourceScopes,
} from "../src/server/authz.js";

describe("server authz helpers", () => {
  it("prefers resource scopes when present", () => {
    expect(requiredResourceScopes(["openid", "profile", "ctgov.read"])).toEqual(["ctgov.read"]);
  });

  it("accepts any matching resource scope", () => {
    expect(hasRequiredResourceScope(["ctgov.read"], ["ctgov.read", "ctgov.admin"])).toBe(true);
  });

  it("rejects tokens without a required resource scope", () => {
    expect(hasRequiredResourceScope(["openid", "profile"], ["ctgov.read"])).toBe(false);
  });

  it("allows unbound sessions", () => {
    expect(isSessionSubjectAuthorized(undefined, "user_123")).toBe(true);
  });

  it("rejects reusing a bound session with another subject", () => {
    expect(isSessionSubjectAuthorized("user_123", "user_456")).toBe(false);
  });
});
