/**
 * Reconstruct and freeze each brief's candidate pool, then prove it is the pool
 * the deployment actually used.
 *
 * The recorded response carries Arm B's coverage result but not the 14 candidate
 * entities behind it, and coverage is pool-relative — so without the pool the
 * metric cannot be recomputed offline. This script rebuilds the pool by calling
 * the same production functions the planner calls, in the same order, and then
 * checks the reconstruction against a fingerprint Arm B already recorded:
 * the pool size, vocabulary size, covered-tag count and redundancy.
 *
 * If the fingerprint does not match, the reconstruction is NOT the pool that
 * produced the published figure. Nothing is written for that brief, and coverage
 * is reported as unavailable downstream rather than quietly measured on a
 * different pool.
 *
 * Run: npx tsx benchmark/record-pool.mts
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = resolve(here, "evidence");

const { resolveAnchors, resolveTags, groundArtistCues, discoveryBackfill } = await import(
  "../src/lib/cues.ts"
);
const { computeTasteGap } = await import("../src/lib/coverage.ts");

const files = readdirSync(evidenceDir).filter(
  (name) => name.endsWith(".json") && !name.endsWith(".pool.json"),
);

let failures = 0;

for (const file of files) {
  const evidence = JSON.parse(readFileSync(resolve(evidenceDir, file), "utf8"));
  const sheet = evidence.raw;
  const brief = sheet.brief;
  const recorded = sheet.tasteGap?.original;

  if (!recorded) {
    failures += 1;
    console.error(`FAIL ${evidence.briefId}: response carried no tasteGap to verify against`);
    continue;
  }

  // Rebuild the pool exactly as planner.ts does, using the brief the deployment
  // actually parsed — not the raw scene text — so tag resolution is identical.
  const receipts: any[] = [];
  const warnings: string[] = [];
  const context: any = { brief, anchorEntities: [], tags: [], receipts, warnings };

  [context.anchorEntities, context.tags] = await Promise.all([
    resolveAnchors(brief.anchors ?? [], receipts),
    resolveTags([...(brief.genre ?? []), ...(brief.mood ?? [])], receipts),
  ]);

  const ranked = await groundArtistCues(context);
  const backfill = await discoveryBackfill(
    context,
    ranked.slice(0, 8).map((entity: any) => entity.entity_id),
  );

  const combined: any[] = [...ranked];
  const seen = new Set(combined.map((entity: any) => entity.entity_id));
  for (const entity of backfill) {
    if (seen.has(entity.entity_id)) continue;
    seen.add(entity.entity_id);
    combined.push({ ...entity, backfill: true });
  }

  const primaryIdx = combined.map((_, index) => index).filter((i) => !combined[i].backfill);
  const discoveryIdx = combined.map((_, index) => index).filter((i) => combined[i].backfill);
  const selectedIdx = [...primaryIdx.slice(0, 6), ...discoveryIdx.slice(0, 2)].slice(0, 8);

  const gap = computeTasteGap(combined, selectedIdx, selectedIdx.length);
  const got = gap.original;

  const checks = {
    poolSize: got.poolSize === recorded.poolSize,
    vocabularySize: got.vocabularySize === recorded.vocabularySize,
    coveredTags: got.coveredTags === recorded.coveredTags,
    redundancy: Math.abs(got.redundancy - recorded.redundancy) < 1e-12,
    index: Math.abs(got.index - recorded.index) < 1e-9,
  };
  const verified = Object.values(checks).every(Boolean);

  if (!verified) {
    failures += 1;
    console.error(
      `FAIL ${evidence.briefId}: reconstruction does not match the recorded fingerprint ` +
        `${JSON.stringify(checks)} — not writing a pool that would be measured as if it were production's`,
    );
    continue;
  }

  // Store only what the coverage metric consumes: ids, names, affinities and
  // tags. Entity ordering is preserved because coverage is index-based.
  const pool = combined.map((entity: any) => ({
    entityId: entity.entity_id,
    name: entity.name,
    affinity: entity.affinity ?? 0,
    popularity: entity.popularity ?? 0,
    backfill: Boolean(entity.backfill),
    tags: (entity.tags ?? []).map((tag: any) => tag.tag_id ?? tag.id ?? "").filter(Boolean),
    tagNames: Object.fromEntries(
      (entity.tags ?? [])
        .map((tag: any) => [tag.tag_id ?? tag.id, tag.name])
        .filter(([id]: any) => Boolean(id)),
    ),
  }));

  const artifact = {
    poolVersion: "1.0.0",
    briefId: evidence.briefId,
    reconstructedAt: new Date().toISOString(),
    sourceCommit: evidence.sourceCommit,
    protocolHash: evidence.protocolHash,
    /** The proof: the reconstruction reproduces the figures Arm B recorded. */
    verifiedAgainstRecorded: {
      verified,
      checks,
      recorded: {
        poolSize: recorded.poolSize,
        vocabularySize: recorded.vocabularySize,
        coveredTags: recorded.coveredTags,
        redundancy: recorded.redundancy,
        index: recorded.index,
      },
      reconstructed: {
        poolSize: got.poolSize,
        vocabularySize: got.vocabularySize,
        coveredTags: got.coveredTags,
        redundancy: got.redundancy,
        index: got.index,
      },
    },
    selectionRule:
      "top 6 primary by affinity, then up to 2 cross-domain discovery picks (planner.ts SHEET_SIZE=8, DISCOVERY_SLOTS=2)",
    selectedIndices: selectedIdx,
    pool,
    poolSha256: createHash("sha256")
      .update(JSON.stringify(pool))
      .digest("hex"),
  };

  writeFileSync(
    resolve(evidenceDir, `${evidence.briefId}.pool.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `OK   ${evidence.briefId}: pool n=${pool.length} verified ` +
      `(index ${got.index.toFixed(4)} == recorded ${recorded.index.toFixed(4)})`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} pool(s) could not be verified. Coverage will be unavailable for them.`);
  process.exit(1);
}
console.log(`\nFroze ${files.length} verified pool(s) to benchmark/evidence/*.pool.json`);
