/**
 * Reproduce the Taste Gap figures quoted in the README, with no network access.
 *
 * The index is pool-relative, so a figure is only meaningful alongside the pool
 * it was measured on. `docs/reference-pool.json` holds the raw entities Qloo
 * returned for each documented brief, recorded from the hackathon API. This
 * script rebuilds the pool from that file, applies the documented selection rule
 * (the top 8 by measured affinity), and recomputes the index with the production
 * coverage module — no arithmetic is reimplemented here.
 *
 * The recorded `expected` block is asserted, so this is a check and not a
 * printout: if the coverage module changes, this fails rather than drifting
 * quietly away from the numbers the README quotes.
 *
 * Run: npx tsx scripts/reproduce-taste-gap.mts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { QlooEntity } from "../src/lib/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(
  readFileSync(resolve(here, "../docs/reference-pool.json"), "utf8"),
);

const { computeTasteGap, POOL_SIZE, MIN_TAG_SUPPORT } = await import("../src/lib/coverage.ts");

interface RecordedEntity {
  entity_id: string;
  name: string;
  affinity: number;
  popularity?: number;
  tags: string[];
}

/** Rebuild the QlooEntity shape the pipeline consumes from the recorded pool. */
function toPool(entities: RecordedEntity[], tagNames: Record<string, string>): QlooEntity[] {
  return entities.map((entity) => ({
    entity_id: entity.entity_id,
    name: entity.name,
    affinity: entity.affinity,
    popularity: entity.popularity,
    tags: entity.tags.map((id) => ({ tag_id: id, name: tagNames[id] ?? id })),
  })) as QlooEntity[];
}

/**
 * The documented selection rule: the top 8 of the pool by measured affinity,
 * with popularity as the deterministic tiebreak — the same order
 * `groundArtistCues` returns and the planner takes its first eight from.
 */
function topSlate(pool: QlooEntity[], size = 8): number[] {
  return pool
    .map((entity, index) => ({ index, entity }))
    .sort(
      (a, b) =>
        (b.entity.affinity ?? 0) - (a.entity.affinity ?? 0) ||
        (b.entity.popularity ?? 0) - (a.entity.popularity ?? 0),
    )
    .slice(0, size)
    .map((entry) => entry.index);
}

const pct = (value: number) => `${value.toFixed(1)}%`;

const rows: string[] = [];
let failures = 0;

for (const [id, brief] of Object.entries<any>(artifact.briefs)) {
  const pool = toPool(brief.entities, artifact.tagNames);
  const slate = topSlate(pool);
  const gap = computeTasteGap(pool, slate, slate.length);

  const original = gap.original;
  const revised = gap.revised.coverage;
  const gain = revised.index - original.index;
  const notReached = original.gaps.length;

  rows.push(
    `| ${brief.label} | ${pct(original.index)} (${original.coveredTags}/${original.vocabularySize}) ` +
      `| ${pct(revised.index)} (${revised.coveredTags}/${revised.vocabularySize}) ` +
      `| +${gain.toFixed(1)} | ${notReached} |`,
  );

  if (brief.expected) {
    try {
      assert.equal(original.coveredTags, brief.expected.originalCoveredTags);
      assert.equal(original.vocabularySize, brief.expected.vocabularySize);
      assert.equal(revised.coveredTags, brief.expected.revisedCoveredTags);
      assert.ok(
        Math.abs(original.index - brief.expected.originalIndex) < 1e-6,
        `original index ${original.index} != ${brief.expected.originalIndex}`,
      );
      assert.ok(
        Math.abs(revised.index - brief.expected.revisedIndex) < 1e-6,
        `revised index ${revised.index} != ${brief.expected.revisedIndex}`,
      );
      assert.equal(notReached, brief.expected.tagsNotReached);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${id}: ${(error as Error).message}`);
    }
  }
}

assert.equal(artifact.poolSize, POOL_SIZE, "recorded poolSize must match the coverage module");
assert.equal(artifact.minTagSupport, MIN_TAG_SUPPORT, "recorded support threshold must match");

console.log(`Recorded ${artifact.recordedAt} against ${artifact.baseUrl}`);
console.log(`Selection: ${artifact.selectionRule}\n`);
console.log("| Brief | Index | After revision | Gain | Tags not reached |");
console.log("|---|---|---|---|---|");
for (const row of rows) console.log(row);

if (failures > 0) {
  console.error(`\n${failures} brief(s) did not match the recorded values.`);
  process.exit(1);
}
console.log(`\n${rows.length} passed, 0 failed.`);
