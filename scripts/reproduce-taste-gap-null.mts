/**
 * Reproduce the Taste Gap exhaustive-null analysis, with no network access.
 *
 * `reproduce-taste-gap.mts` checks the README's point figures. This script checks
 * the distribution they sit in. A pool of 14 candidates admits C(14, 8) = 3003
 * distinct eight-entity slates, which is small enough to enumerate completely
 * rather than sample, so the null here is exact and has no seed.
 *
 * Two things are deliberately NOT stored as authoritative:
 *
 *  - The percentile. It is recomputed here from the reproduced coverage score
 *    and the recomputed null. The artifact records the null's shape, not any
 *    arm's rank within it, so a stale percentile cannot survive a rerun.
 *  - The eligible-slate count. It is derived from the pool size and slate size
 *    by `binomial`, then asserted against the enumeration. 3003 is a
 *    consequence of this pool, not a constant.
 *
 * Run: npx tsx scripts/reproduce-taste-gap-null.mts
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

const { measureSlate, toCoverageEntities, sharedVocabulary, POOL_SIZE, MIN_TAG_SUPPORT } =
  await import("../src/lib/coverage.ts");
const { auditSelection } = await import("../src/lib/audit.ts");

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

/** The documented selection rule: top 8 by measured affinity, popularity as tiebreak. */
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

/**
 * Exact binomial coefficient. Stays in integer range for the pool sizes this
 * analysis handles, and is the only place the 3003 figure comes from.
 */
function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
  return Math.round(result);
}

/** Every k-subset of 0..n-1 exactly once, lexicographic. Deterministic by construction. */
function* combinations(n: number, k: number): Generator<number[]> {
  const indices = [...Array(k).keys()];
  for (;;) {
    yield [...indices];
    let i = k - 1;
    while (i >= 0 && indices[i] === n - k + i) i -= 1;
    if (i < 0) return;
    indices[i] += 1;
    for (let j = i + 1; j < k; j += 1) indices[j] = indices[j - 1] + 1;
  }
}

/**
 * Linear-interpolation quantile (R-7, the numpy default) over an ascending array.
 * Documented because "the 5th percentile" is otherwise ambiguous for a discrete
 * score, where several conventions are in common use.
 */
function quantile(ascending: number[], q: number): number {
  const position = (ascending.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ascending[lower];
  return ascending[lower] + (ascending[upper] - ascending[lower]) * (position - lower);
}

/**
 * Midrank percentile: ties count as half.
 *
 * The null is a discrete score with heavy ties, so the convention has to be
 * stated rather than assumed. "Fraction strictly below" would push a slate that
 * sits on a plateau toward the bottom of that plateau; midrank places it at the
 * plateau's centre. The choice moves a percentile by at most a few points.
 */
function percentile(ascending: number[], value: number): number {
  let below = 0;
  let equal = 0;
  for (const score of ascending) {
    if (score < value) below += 1;
    else if (score === value) equal += 1;
  }
  return ((below + equal / 2) / ascending.length) * 100;
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const pct = (value: number) => `${value.toFixed(1)}%`;
const near = (a: number, b: number, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

const failures: string[] = [];
let checks = 0;

function check(name: string, fn: () => void) {
  checks += 1;
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.error(`FAIL ${name}`);
  }
}

/**
 * The comparison used for every recorded figure. It is asserted to reject a
 * perturbed value below, so a silent no-op cannot pass as a check.
 */
function assertRecorded(actual: number, recorded: number, label: string) {
  assert.ok(
    near(actual, recorded, 1e-6),
    `${label}: reproduced ${actual} != recorded ${recorded}`,
  );
}

const summary: string[] = [];

for (const [id, brief] of Object.entries<any>(artifact.briefs)) {
  const pool = toPool(brief.entities, artifact.tagNames);
  const entities = toCoverageEntities(pool);
  const slateSize = brief.nullStats?.slateSize ?? 8;
  const poolSize = brief.entities.length;

  // The eligible vocabulary comes from the production module, so the denominator
  // cannot drift from the shipped metric.
  const vocabulary = sharedVocabulary(entities);
  const eligibleTags = entities.map((entity) =>
    entity.tags.filter((tag) => vocabulary.has(tag)).length,
  );

  // Enumerate every eligible slate with the production scorer.
  const coverageNull: number[] = [];
  const volumeNull: number[] = [];
  for (const slate of combinations(poolSize, slateSize)) {
    coverageNull.push(measureSlate(entities, slate).index);
    let volume = 0;
    for (const index of slate) volume += eligibleTags[index];
    volumeNull.push(volume);
  }
  coverageNull.sort((a, b) => a - b);
  volumeNull.sort((a, b) => a - b);

  const expectedSlates = binomial(poolSize, slateSize);

  // 1. The enumeration must be complete, and its size derived rather than assumed.
  check(`${id}: null slate count is the exact binomial coefficient`, () => {
    assert.equal(
      coverageNull.length,
      expectedSlates,
      `enumerated ${coverageNull.length} slates, C(${poolSize}, ${slateSize}) = ${expectedSlates}`,
    );
  });

  // 2. The null must be deterministic: a second enumeration is identical.
  check(`${id}: null distribution is deterministic`, () => {
    const again: number[] = [];
    for (const slate of combinations(poolSize, slateSize)) {
      again.push(measureSlate(entities, slate).index);
    }
    again.sort((a, b) => a - b);
    assert.deepEqual(again, coverageNull, "a repeat enumeration differed");
  });

  // 3. The recorded null statistics must match the recomputed distribution.
  check(`${id}: recorded null statistics reproduce`, () => {
    const recorded = brief.nullStats;
    assert.ok(recorded, "brief carries no nullStats block");
    assert.equal(recorded.exhaustive, true, "recorded null must be exhaustive");
    assert.equal(recorded.eligibleSlates, expectedSlates, "recorded slate count disagrees");
    assert.equal(recorded.slateSize, slateSize, "recorded slate size disagrees");
    assertRecorded(mean(coverageNull), recorded.coverage.mean, "null mean");
    assertRecorded(quantile(coverageNull, 0.05), recorded.coverage.p05, "null p05");
    assertRecorded(quantile(coverageNull, 0.95), recorded.coverage.p95, "null p95");
    assertRecorded(coverageNull[0], recorded.coverage.min, "null min");
    assertRecorded(coverageNull[coverageNull.length - 1], recorded.coverage.max, "null max");
    assertRecorded(mean(volumeNull), recorded.tagVolume.mean, "volume mean");
    assertRecorded(quantile(volumeNull, 0.05), recorded.tagVolume.p05, "volume p05");
    assertRecorded(quantile(volumeNull, 0.95), recorded.tagVolume.p95, "volume p95");
  });

  // 4. The point figures must still reproduce before any percentile is derived from them.
  const slate = topSlate(pool, slateSize);
  const coverage = measureSlate(entities, slate);
  check(`${id}: recorded coverage index reproduces`, () => {
    assert.ok(brief.expected, "brief carries no expected block");
    assertRecorded(coverage.index, brief.expected.originalIndex, "original index");
    assert.equal(coverage.coveredTags, brief.expected.originalCoveredTags);
    assert.equal(coverage.vocabularySize, brief.expected.vocabularySize);
  });

  // 5. The shipped coverage path must remain equally weighted, and must agree
  //    with the engine. `measureSlate` passes no weights, so `auditSelection`
  //    must report "equal" — if a caller ever passes weights, every published
  //    figure changes meaning and this fails.
  check(`${id}: shipped coverage path uses equal weights`, () => {
    const audit = auditSelection(
      entities.map((entity) => ({
        entityId: entity.entityId,
        name: entity.name,
        dimensions: entity.tags,
      })),
      slate,
      { minSupport: MIN_TAG_SUPPORT },
    );
    assert.equal(audit.weightsUsed, "equal", `weights used: ${JSON.stringify(audit.weightsUsed)}`);
    assert.equal(audit.denominator, vocabulary.size, "denominator disagrees with the vocabulary");
    assertRecorded(audit.score, coverage.index, "engine score vs measureSlate index");
  });

  // 6. Percentiles are DERIVED here, never read from the artifact.
  const coveragePercentile = percentile(coverageNull, coverage.index);
  const slateVolume = slate.reduce((sum, index) => sum + eligibleTags[index], 0);
  const volumePercentile = percentile(volumeNull, slateVolume);

  summary.push(
    `| ${brief.label} | ${pct(coverage.index)} (${coverage.coveredTags}/${coverage.vocabularySize}) ` +
      `| ${coverageNull.length} | ${pct(mean(coverageNull))} ` +
      `| ${quantile(coverageNull, 0.05).toFixed(1)}–${quantile(coverageNull, 0.95).toFixed(1)} ` +
      `| ${coveragePercentile.toFixed(1)} | ${volumePercentile.toFixed(1)} |`,
  );
}

// The recorded thresholds must agree with production, or every figure above is
// measured on a different denominator than the app uses.
check("recorded poolSize matches the coverage module", () => {
  assert.equal(artifact.poolSize, POOL_SIZE, `artifact ${artifact.poolSize} != ${POOL_SIZE}`);
});
check("recorded minTagSupport matches the coverage module", () => {
  assert.equal(
    artifact.minTagSupport,
    MIN_TAG_SUPPORT,
    `artifact ${artifact.minTagSupport} != ${MIN_TAG_SUPPORT}`,
  );
});

// The artifact must state what the index is, so a reader cannot take it for a
// share of listeners. A blank note would satisfy a length check, so the wording
// that carries the claim is asserted rather than assumed.
check("artifact labels the index as pool-relative", () => {
  const note = String(artifact.note ?? "");
  assert.match(note, /pool-relative/i, "the note does not call the figures pool-relative");
  assert.match(note, /not a share of listeners/i, "the note does not rule out a population reading");
  const selectionRule = String(artifact.selectionRule ?? "");
  assert.ok(selectionRule.length > 0, "artifact carries no selection rule");
});

// The percentile convention must be recorded, because a percentile is not
// interpretable without it.
check("artifact records the percentile convention", () => {
  for (const [id, brief] of Object.entries<any>(artifact.briefs)) {
    const convention = brief.nullStats?.percentileConvention;
    assert.ok(convention, `${id} records no percentile convention`);
    assert.match(String(convention), /midrank/i, `${id} convention is not midrank`);
  }
});

// Prove the comparison is live rather than vacuous: a perturbed value must be
// rejected. This is what makes a passing run mean something.
check("a perturbed recorded value is rejected", () => {
  const first = Object.values<any>(artifact.briefs)[0];
  const recorded = first.expected.originalIndex;
  let rejected = false;
  try {
    assertRecorded(recorded + 1, recorded, "self-test");
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "assertRecorded accepted a value it should have rejected");
});

console.log(`Recorded ${artifact.recordedAt} against ${artifact.baseUrl}`);
console.log(`Selection: ${artifact.selectionRule}\n`);
console.log(
  "Null distribution: every eligible slate in the pool, enumerated exhaustively\n" +
    "with the production coverage module. Percentiles are recomputed here (midrank,\n" +
    "ties counted as half) and are never read from the artifact.\n",
);
console.log("| Brief | Index | Slates | Null mean | Null p05–p95 | Coverage pct | Volume pct |");
console.log("|---|---|---|---|---|---|---|");
for (const row of summary) console.log(row);

console.log(
  "\nHow to read this\n" +
    "  Index       tags the slate reaches as a share of the pool's shared vocabulary.\n" +
    "              Pool-relative: it is not a share of listeners or of the market.\n" +
    "  Slates      how many eight-entity slates the pool admits, enumerated in full.\n" +
    "  Coverage pct  where the affinity slate sits in that distribution. A slate at\n" +
    "              the 24th percentile reaches more tags than 24% of possible slates.\n" +
    "  Volume pct  where the same slate sits by tag count alone. Reporting both is\n" +
    "              the point: the two differ, which is what shows the index is not\n" +
    "              merely measuring how richly an entity was catalogued.\n",
);
console.log(
  "What this does not show\n" +
    "  A high index is not a quality score. This measures tag reach against a pool,\n" +
    "  not whether anyone likes the result, and no human-preference evaluation has\n" +
    "  been performed. Affinity ranking and tag coverage are different objectives,\n" +
    "  so an affinity-ranked slate is not expected to top a coverage distribution;\n" +
    "  it ranking low here is not evidence that the ranking is wrong. No LLM-only\n" +
    "  baseline was evaluated, and no comparison against one is made or implied.\n" +
    "  Three briefs from one recorded API snapshot cannot generalise further.\n",
);

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`${checks} passed, 0 failed.`);
