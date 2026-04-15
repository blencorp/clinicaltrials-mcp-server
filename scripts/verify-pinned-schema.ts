/**
 * Compare schema/openapi.pinned.json against the live /openapi.json.
 * Exits 1 if drift is detected (useful in CI).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { request } from "undici";

const BASE = process.env.CTGOV_BASE ?? "https://clinicaltrials.gov/api/v2";

async function main(): Promise<void> {
  const pinned = JSON.parse(
    readFileSync(resolve("schema", "openapi.pinned.json"), "utf8"),
  ) as { paths?: Record<string, unknown> };
  const res = await request(`${BASE}/openapi.json`, {
    headers: { accept: "application/json" },
  });
  if (res.statusCode >= 400) {
     
    console.error(`Upstream ${res.statusCode}`);
    process.exit(2);
  }
  const live = (await res.body.json()) as { paths?: Record<string, unknown> };
  const pinnedPaths = new Set(Object.keys(pinned.paths ?? {}));
  const livePaths = new Set(Object.keys(live.paths ?? {}));
  const missing = [...livePaths].filter((p) => !pinnedPaths.has(p));
  const extra = [...pinnedPaths].filter((p) => !livePaths.has(p));
  if (missing.length === 0 && extra.length === 0) {
    // eslint-disable-next-line no-console
    console.log("Pinned schema paths match live API.");
    return;
  }
   
  console.error("Schema drift detected.");
  if (missing.length) {
     
    console.error("  Missing from pinned:", missing);
  }
  if (extra.length) {
     
    console.error("  Extra in pinned (removed upstream):", extra);
  }
  process.exit(1);
}

main().catch((err: unknown) => {
   
  console.error(err);
  process.exit(1);
});
