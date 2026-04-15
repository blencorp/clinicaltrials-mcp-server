/**
 * Directory-compliance smoke test. Hits a running MCP deployment and verifies:
 *
 *   - HTTPS cert valid
 *   - /.well-known/oauth-protected-resource (RFC 9728) shape
 *   - /.well-known/oauth-authorization-server reachable or explicitly 404
 *   - POST /mcp without auth -> 401 + WWW-Authenticate + resource_metadata=...
 *   - /healthz -> 200
 *   - examples/ count >= 3
 *   - legal/{privacy-policy,terms,support}.md present
 *
 * Usage:
 *   pnpm check:directory https://clinicaltrial.mcp.blencorp.com
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const TARGET = process.argv[2];
if (!TARGET) {
   
  console.error("Usage: check-directory-compliance <base-url>");
  process.exit(2);
}
const base = TARGET.replace(/\/$/, "");
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

await check("HTTPS target", async () => {
  if (!base.startsWith("https://")) throw new Error("base URL must be https://");
});

await check("GET /healthz returns 200", async () => {
  const r = await fetch(`${base}/healthz`);
  if (r.status !== 200) throw new Error(`status=${r.status}`);
});

await check("GET /.well-known/oauth-protected-resource shape", async () => {
  const r = await fetch(`${base}/.well-known/oauth-protected-resource`);
  if (r.status !== 200) throw new Error(`status=${r.status}`);
  const j = (await r.json()) as Record<string, unknown>;
  if (!j.resource) throw new Error("missing `resource`");
  if (!Array.isArray(j.authorization_servers) || j.authorization_servers.length === 0)
    throw new Error("missing `authorization_servers[]`");
  if (!Array.isArray(j.scopes_supported)) throw new Error("missing `scopes_supported[]`");
});

await check("GET /.well-known/oauth-authorization-server reachable or 404", async () => {
  const r = await fetch(`${base}/.well-known/oauth-authorization-server`);
  if (r.status !== 200 && r.status !== 404) throw new Error(`status=${r.status}`);
});

await check("POST /mcp without auth returns 401 + WWW-Authenticate with PRM hint", async () => {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (r.status !== 401) throw new Error(`status=${r.status}`);
  const wa = r.headers.get("www-authenticate");
  if (!wa || !/Bearer/i.test(wa)) throw new Error(`WWW-Authenticate missing/invalid: ${wa}`);
  if (!wa.includes("resource_metadata"))
    throw new Error("WWW-Authenticate does not reference resource_metadata");
});

await check("3+ example prompts present", async () => {
  const dir = resolve("examples");
  if (!existsSync(dir)) throw new Error("examples/ directory missing");
  const mds = readdirSync(dir).filter((f) => f.endsWith(".md"));
  if (mds.length < 3) throw new Error(`found ${mds.length}, need >= 3`);
});

await check("legal/{privacy-policy,terms,support}.md present", async () => {
  for (const f of ["privacy-policy.md", "terms.md", "support.md"]) {
    if (!existsSync(resolve("legal", f))) throw new Error(`missing legal/${f}`);
  }
});

let failed = 0;
for (const r of results) {
  const sigil = r.ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`${sigil}  ${r.name}${r.detail ? " — " + r.detail : ""}`);
  if (!r.ok) failed++;
}
if (failed > 0) {
   
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log(`\nAll ${results.length} checks passed.`);
