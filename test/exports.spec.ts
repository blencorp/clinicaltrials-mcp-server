// The public entry point `dist/index.js` (package "exports" ".") and its inventory in
// docs/migration-0.1.md: the runtime exports below must equal the documented list, and every
// removed export the document names must be gone. Needs `pnpm build` (CI builds before testing).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const DOC = readFileSync(new URL("../docs/migration-0.1.md", import.meta.url), "utf8");
const built = existsSync(ENTRY);
if (!built && process.env.CI) throw new Error("dist/index.js is missing: run `pnpm build` before `pnpm test` in CI");

/** The runtime exports of src/index.ts. Keep in step with the "Public exports" section of docs/migration-0.1.md. */
const EXPORTS = [
  "AUTH_PROVIDERS",
  "DEFAULT_SCOPE",
  "MCP_PROTOCOL_VERSION",
  "SERVER_VERSION",
  "buildMcpServer",
  "buildSupervisor",
  "pickSandbox",
  "startHttpServer",
  "startStdioServer",
];
/** Exported in 0.1.0-alpha.0 and removed: the embedded authorization server (B) and selectSandbox (C, replaced by pickSandbox). */
const REMOVED = ["EmbeddedAs", "buildAuthAdapter", "loadAuthConfig", "selectSandbox"];

const section = (): string => {
  const start = DOC.indexOf("## Public exports");
  expect(start, "docs/migration-0.1.md has a '## Public exports' section").toBeGreaterThanOrEqual(0);
  const next = DOC.indexOf("\n## ", start + 5);
  return DOC.slice(start, next < 0 ? undefined : next);
};

describe.skipIf(!built)("public entry point dist/index.js", () => {
  it("exports exactly the documented runtime names", async () => {
    const mod = (await import(ENTRY)) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual([...EXPORTS].sort());
    expect(mod.MCP_PROTOCOL_VERSION).toBe("2026-07-28");
    for (const name of ["buildMcpServer", "buildSupervisor", "pickSandbox", "startHttpServer", "startStdioServer"]) {
      expect(typeof mod[name], name).toBe("function");
    }
  });

  it("no longer exports the embedded authorization server or the auth adapter helpers", async () => {
    const mod = (await import(ENTRY)) as Record<string, unknown>;
    for (const name of REMOVED) expect(mod[name], name).toBeUndefined();
  });
});

describe("docs/migration-0.1.md inventory", () => {
  it("names every remaining export and every removed one in the Public exports section", () => {
    const text = section();
    for (const name of [...EXPORTS, ...REMOVED]) expect(text, name).toContain(`\`${name}\``);
  });
});
