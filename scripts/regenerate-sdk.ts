/**
 * Refresh the pinned ClinicalTrials.gov schema from the live API:
 *   - schema/openapi.pinned.json   the hand-curated subset of the OpenAPI document; its version is
 *                                  stamped and its paths are checked against the live document
 *   - schema/ctgov.json            the SDK corpus: provenance.generatedAt is stamped, and the curated
 *                                  ctgov.fields.* entries are checked against /studies/metadata
 *
 * The corpus text (endpoint signatures, descriptions, examples, field notes) is curated by hand and
 * is never overwritten: a method is documented when it is added to src/sdk/sources/ctgov.ts. This
 * script fails when the corpus and the methods table disagree, or when a curated field no longer
 * exists upstream, so a drift is fixed by editing schema/ctgov.json and re-running.
 *
 * Run in an environment with outbound HTTPS access to clinicaltrials.gov.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { CORPUS_PATH, OAS_URL, OPENAPI_PATH, endpointMismatches, liveSpec, missingFields, readCorpus } from "./ctgov-schema.js";

async function main(): Promise<void> {
  console.log(`Reading ${OAS_URL} ...`);
  const live = await liveSpec();
  const pinned = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as { info: { version: string; description: string }; paths: Record<string, unknown> };
  const problems = [
    ...live.paths.filter((p) => !(p in pinned.paths)).map((p) => `live path missing from ${OPENAPI_PATH}: ${p} (add it with its operation, then document and register a method)`),
    ...Object.keys(pinned.paths).filter((p) => !live.paths.includes(p)).map((p) => `pinned path removed upstream: ${p}`),
    ...endpointMismatches(),
    ...(await missingFields()).map((p) => `curated field not in /studies/metadata: ${p}`),
  ];
  if (problems.length > 0) {
    console.error("The pinned schema and corpus need attention:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  pinned.info.version = `${live.version}-pinned`;
  pinned.info.description = `Hand-curated snapshot of the ClinicalTrials.gov v2 REST API, checked against ${OAS_URL} by \`pnpm regen:sdk\` and the weekly schema-drift workflow.`;
  writeFileSync(OPENAPI_PATH, JSON.stringify(pinned, null, 2) + "\n");
  const corpus = readCorpus();
  corpus.provenance.generatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(CORPUS_PATH, JSON.stringify(corpus, null, 2) + "\n");
  console.log(`Stamped ${OPENAPI_PATH} (${pinned.info.version}) and ${CORPUS_PATH}; run \`node scripts/gen-sdk-reference.mjs\` and \`pnpm test\` next.`);
}

main().catch((err: unknown) => {
  console.error("regenerate-sdk failed:", err);
  process.exit(1);
});
