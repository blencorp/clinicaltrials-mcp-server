// The public entry point `dist/index.js` (package "exports" "."): its runtime exports must equal
// the list below, and the exports removed since 0.1.0-alpha.0 must stay gone. Needs `pnpm build`
// (CI builds before testing).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const built = existsSync(ENTRY);
if (!built && process.env.CI) throw new Error("dist/index.js is missing: run `pnpm build` before `pnpm test` in CI");

/** The runtime exports of src/index.ts. */
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
