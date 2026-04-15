import { describe, it, expect } from "vitest";
import { validateUserCode } from "../src/sandbox/policy.js";
import { CtGovError } from "../src/supervisor/errors.js";

describe("validateUserCode", () => {
  it("accepts plain business logic", () => {
    expect(() =>
      validateUserCode(
        `const p = await ctgov.studies.search({ "query.cond": "flu" }); return p.studies.length;`,
      ),
    ).not.toThrow();
  });

  it("rejects imports", () => {
    expect(() => validateUserCode(`import fs from "node:fs";`)).toThrow(CtGovError);
  });

  it("rejects dynamic import", () => {
    expect(() => validateUserCode(`const m = await import("node:fs");`)).toThrow();
  });

  it("rejects eval", () => {
    expect(() => validateUserCode(`eval("1+1");`)).toThrow();
  });

  it("rejects new Function", () => {
    expect(() => validateUserCode(`new Function("return 1")();`)).toThrow();
  });

  it("rejects process reference", () => {
    expect(() => validateUserCode(`return process.env;`)).toThrow();
  });

  it("rejects with statements", () => {
    expect(() => validateUserCode(`with (Math) { return PI; }`)).toThrow();
  });

  it("rejects direct host bridge access by computed property", () => {
    expect(() => validateUserCode(`return globalThis["__host"];`)).toThrow();
  });

  it("rejects constructor-chain escapes", () => {
    expect(() => validateUserCode(`return (() => {}).constructor("return 1")();`)).toThrow();
    expect(() => validateUserCode(`return globalThis.constructor.constructor("return globalThis")();`)).toThrow();
  });
});
