/**
 * Compare the repository against the live ClinicalTrials.gov API. Exits 1 on drift:
 *   - schema/openapi.pinned.json paths differ from the live OpenAPI document (OAS_URL)
 *   - schema/ctgov.json disagrees with the methods table (checked offline too, by test/sources.spec.ts)
 *   - a curated ctgov.fields.* entry names a field /studies/metadata no longer has
 * Fix with `pnpm regen:sdk`, edit schema/ctgov.json where it reports, then `node scripts/gen-sdk-reference.mjs`.
 */
import { readFileSync } from "node:fs";
import { OAS_URL, OPENAPI_PATH, endpointMismatches, liveSpec, missingFields } from "./ctgov-schema.js";

async function main(): Promise<void> {
  const pinned = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as { paths?: Record<string, unknown> };
  const live = await liveSpec().catch((err: unknown) => {
    console.error(`Could not read ${OAS_URL}: ${(err as Error).message}`);
    process.exit(2);
  });
  const pinnedPaths = new Set(Object.keys(pinned.paths ?? {}));
  const livePaths = new Set(live.paths);
  const missing = [...livePaths].filter((p) => !pinnedPaths.has(p));
  const extra = [...pinnedPaths].filter((p) => !livePaths.has(p));
  const problems: string[] = [];
  if (missing.length) problems.push(`paths missing from the pinned schema: ${missing.join(", ")}`);
  if (extra.length) problems.push(`pinned paths removed upstream: ${extra.join(", ")}`);
  problems.push(...endpointMismatches());
  problems.push(...(await missingFields()).map((p) => `curated field not in /studies/metadata: ${p}`));
  if (problems.length === 0) {
    console.log(`Pinned schema, corpus and curated fields match the live API (${live.version}).`);
    return;
  }
  console.error("Schema drift detected:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
