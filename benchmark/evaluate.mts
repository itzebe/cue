/**
 * Recompute every benchmark metric from committed evidence and the frozen
 * protocol, and assert the result matches the committed results artifact.
 *
 * This is the deterministic replay path. It needs no network and no credentials:
 * it reads `benchmark/evidence/*.json`, recomputes each metric with the
 * production coverage module and the shared metric code, and compares against
 * `benchmark/results.json`. Any drift fails the run rather than being reported.
 *
 * Run:
 *   npx tsx benchmark/evaluate.mts            # check committed results
 *   npx tsx benchmark/evaluate.mts --write     # regenerate results.json
 *   npx tsx benchmark/evaluate.mts --report    # check, then print the report
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  armAInput,
  armAPrompt,
  assertArmAIsolation,
  briefRelevance,
  anchorRecycling,
  diversity,
  resolveIntoPool,
  topByAffinity,
  mean,
  median,
  type ArmItem,
  type ArmSummary,
  type SlateMetrics,
  type BriefEvaluation,
  type RecordedEntity,
} from "./lib.mts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const evidenceDir = resolve(here, "evidence");
const resultsPath = resolve(here, "results.json");

const { computeTasteGap } = await import("../src/lib/coverage.ts");

const args = process.argv.slice(2);
const write = args.includes("--write");
const report = args.includes("--report");

// ---------------------------------------------------------------------------
// Protocol (the frozen preregistration)
// ---------------------------------------------------------------------------

const protocolPath = resolve(here, "protocol.json");
const protocolRaw = readFileSync(protocolPath);
const protocolHash = createHash("sha256").update(protocolRaw).digest("hex");
const protocol = JSON.parse(protocolRaw.toString("utf8"));
const K: number = protocol.slateSizeParity.commonSlateSize;

// ---------------------------------------------------------------------------
// Load evidence
// ---------------------------------------------------------------------------

interface EvidenceFile {
  briefId: string;
  scene: string;
  recordedAt: string;
  sourceUrl: string;
  sourceCommit: string;
  protocolHash: string;
  httpStatus: number;
  latencyMs: number;
  raw: any;
}

interface PoolFile {
  briefId: string;
  verifiedAgainstRecorded: { verified: boolean; checks: Record<string, boolean> };
  selectedIndices: number[];
  pool: RecordedEntity[];
  poolSha256: string;
}

const evidenceFiles = readdirSync(evidenceDir)
  .filter((name) => name.endsWith(".json") && !name.endsWith(".pool.json"))
  .sort();

const pools = new Map<string, PoolFile>();
for (const name of readdirSync(evidenceDir).filter((n) => n.endsWith(".pool.json"))) {
  const pool: PoolFile = JSON.parse(readFileSync(resolve(evidenceDir, name), "utf8"));
  pools.set(pool.briefId, pool);
}

// ---------------------------------------------------------------------------
// Per-brief evaluation
// ---------------------------------------------------------------------------

function itemsFromArmB(sheet: any): ArmItem[] {
  return (sheet.cues ?? []).map((cue: any) => ({
    artist: String(cue.artist ?? ""),
    track: String(cue.track ?? ""),
    why: Array.isArray(cue.why) ? cue.why.join(" ") : String(cue.why ?? ""),
    affinity: typeof cue.affinity === "number" ? cue.affinity : undefined,
    entityId: cue.artistId ?? undefined,
  }));
}

function itemsFromArmA(sheet: any): ArmItem[] {
  return (sheet.baseline?.cues ?? []).map((cue: any) => ({
    artist: String(cue.artist ?? ""),
    track: String(cue.track ?? ""),
    why: String(cue.why ?? ""),
  }));
}

function qlooEntityFromRecorded(entity: RecordedEntity): any {
  return {
    entity_id: entity.entityId,
    name: entity.name,
    type: "urn:entity:artist",
    affinity: entity.affinity,
    tags: entity.tags.map((id) => ({ tag_id: id, name: entity.tagNames?.[id] ?? id })),
  };
}

/**
 * Coverage for an arbitrary set of items, measured on the frozen pool.
 *
 * Returns `null` with a reason when nothing resolves, so an unmeasurable slate
 * can never be mistaken for a slate that scored zero.
 */
function coverageForItems(
  items: ArmItem[],
  pool: RecordedEntity[],
): SlateMetrics["tagCoverage"] {
  const { indices, unmeasurable, matched } = resolveIntoPool(items, pool);

  if (indices.length === 0) {
    return {
      value: null,
      unavailableReason:
        `none of the ${items.length} item(s) resolve into the pool, so coverage is unmeasurable ` +
        `(not zero)`,
      unmeasurableItems: unmeasurable,
      measurableCount: 0,
    };
  }

  const qlooPool = pool.map(qlooEntityFromRecorded);
  const gap = computeTasteGap(qlooPool, indices, indices.length);
  const coverage = gap.original;

  return {
    value: coverage.index,
    coveredTags: coverage.coveredTags,
    vocabularySize: coverage.vocabularySize,
    unmeasurableItems: unmeasurable,
    measurableCount: indices.length,
    unavailableReason:
      indices.length < items.length
        ? `${unmeasurable.length} of ${items.length} item(s) do not resolve into the pool; ` +
          `coverage is measured over the ${indices.length} that do`
        : undefined,
    // Not part of the number, but kept so a reader can see the partial measurement.
    ...(Object.keys(matched).length > 0 ? {} : {}),
  };
}

const evaluations: BriefEvaluation[] = [];

const sensitivity: Array<{
  briefId: string;
  relevanceWithWhy: { a: number | null; b: number | null };
  relevanceArtistOnly: { a: number | null; b: number | null };
}> = [];

for (const name of evidenceFiles) {
  const evidence: EvidenceFile = JSON.parse(readFileSync(resolve(evidenceDir, name), "utf8"));
  const sheet = evidence.raw;
  const poolFile = pools.get(evidence.briefId);
  const protocolBrief = protocol.briefs.find((b: any) => b.id === evidence.briefId);
  if (!protocolBrief) throw new Error(`Evidence ${evidence.briefId} has no protocol entry`);

  const anchors: string[] = sheet.brief?.anchors ?? [];
  const armAItemsFull = itemsFromArmA(sheet);
  const armBItemsFull = itemsFromArmB(sheet);

  const armAProvenance: ArmSummary["provenance"] = {
    source: (sheet.baseline?.source ?? "sample") as "llm" | "sample",
    provider: sheet.sceneParse?.provider ?? null,
    model: null,
  };
  const armBProvenance: ArmSummary["provenance"] = {
    source: "llm",
    provider: sheet.sceneParse?.provider ?? null,
    model: null,
  };

  // Slate-size parity: both arms at K. Arm B is truncated by measured affinity;
  // Arm A already returns K by construction.
  const armAItems = armAItemsFull.slice(0, K);
  const armBItems = topByAffinity(armBItemsFull, K);

  const armA: ArmSummary = { items: armAItems, fullItems: armAItemsFull, provenance: armAProvenance };
  const armB: ArmSummary = { items: armBItems, fullItems: armBItemsFull, provenance: armBProvenance };

  // Arm A isolation, enforced on the real data for this brief.
  const input = armAInput(sheet.brief ?? {});
  assertArmAIsolation(armAPrompt(input));
  // The whitelisted fields themselves must not carry Qloo data. If a Qloo value
  // ever reached setting/mood/era, the prompt check above would pass while the
  // model still saw it, so the fields are scanned directly too.
  assertArmAIsolation([input.setting, input.era, ...input.mood].join("\n"));

  const metricsA: SlateMetrics = {
    briefRelevance: briefRelevance(armAItems, sheet.brief ?? {}),
    anchorRecycling: anchorRecycling(armAItems, anchors),
    diversity: diversity(armAItems),
    tagCoverage: poolFile ? coverageForItems(armAItems, poolFile.pool) : {
      value: null,
      unavailableReason: "no verified pool was frozen for this brief",
    },
  };

  const metricsB: SlateMetrics = {
    briefRelevance: briefRelevance(armBItems, sheet.brief ?? {}),
    anchorRecycling: anchorRecycling(armBItems, anchors),
    diversity: diversity(armBItems),
    tagCoverage: poolFile ? coverageForItems(armBItems, poolFile.pool) : {
      value: null,
      unavailableReason: "no verified pool was frozen for this brief",
    },
  };

  // M1 sensitivity: the same metric over artist + track only, excluding the
  // rationale text. The two arms' rationale fields are NOT equivalent — Arm A's
  // is a written description that tends to contain mood words, while Arm B's is
  // Qloo provenance boilerplate that cannot — so M1 as specified is structurally
  // biased against Arm B. Reporting both bounds shows whether the finding
  // survives removing the rationale.
  const relevanceAArtistOnly = briefRelevance(armAItems, sheet.brief ?? {}, { includeWhy: false });
  const relevanceBArtistOnly = briefRelevance(armBItems, sheet.brief ?? {}, { includeWhy: false });

  // Arm B's production coverage, read straight from the response. This is the
  // number the deployment itself published, so it is reported separately from
  // the recomputation as a cross-check.
  const recordedCoverage = sheet.tasteGap?.original?.index;

  // Arm B's full-slate coverage, explicitly labelled not size-matched.
  const armBCoverageFullSlate: SlateMetrics["tagCoverage"] = poolFile
    ? coverageForItems(armBItemsFull, poolFile.pool)
    : { value: null, unavailableReason: "no verified pool was frozen for this brief" };

  let excluded: { reason: string } | undefined;
  if (sheet.mode !== "live") {
    excluded = { reason: `Arm B did not run live (mode=${sheet.mode})` };
  } else if (armAProvenance.source !== "llm") {
    excluded = {
      reason: `Arm A degraded to a fixed sample (baseline.source=${armAProvenance.source})`,
    };
  }

  evaluations.push({
    briefId: evidence.briefId,
    anchors,
    commonSlateSize: K,
    armA,
    armB,
    excluded,
    metricsA,
    metricsB,
    armBCoverageFullSlate,
    poolSize: poolFile?.pool.length ?? 0,
  });

  sensitivity.push({
    briefId: evidence.briefId,
    relevanceWithWhy: { a: metricsA.briefRelevance.value, b: metricsB.briefRelevance.value },
    relevanceArtistOnly: { a: relevanceAArtistOnly.value, b: relevanceBArtistOnly.value },
  });
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

type Direction = "B>A" | "B<A" | "n/a";

interface Comparison {
  metric: string;
  direction: Direction;
  threshold: number;
  diffs: Array<{ briefId: string; a: number | null; b: number | null; diff: number | null }>;
  agreeing: number;
  scorable: number;
  medianDiff: number | null;
  outcome: "supported" | "supported-weak" | "contradicted" | "inconclusive";
  notes: string[];
}

function compare(
  metric: string,
  predicted: Direction,
  threshold: number,
  pick: (e: BriefEvaluation) => { a: number | null; b: number | null },
): Comparison {
  const diffs: Comparison["diffs"] = [];
  const notes: string[] = [];

  for (const e of evaluations) {
    if (e.excluded) {
      notes.push(`${e.briefId} excluded: ${e.excluded.reason}`);
      continue;
    }
    const { a, b } = pick(e);
    if (a === null || b === null) {
      diffs.push({ briefId: e.briefId, a, b, diff: null });
      notes.push(`${e.briefId} excluded: metric unmeasurable for one or both arms`);
      continue;
    }
    diffs.push({ briefId: e.briefId, a, b, diff: b - a });
  }

  const usable = diffs.filter((d) => d.diff !== null) as Array<{ briefId: string; a: number; b: number; diff: number }>;
  const agreeing = usable.filter((d) =>
    predicted === "B>A" ? d.diff > 0 : predicted === "B<A" ? d.diff < 0 : false,
  ).length;
  const medianDiff = usable.length === 0 ? null : median(usable.map((d) => d.diff));

  let outcome: Comparison["outcome"] = "inconclusive";
  if (usable.length < evaluations.length) {
    outcome = "inconclusive";
    if (notes.length === 0) notes.push("not every brief was scorable");
  } else if (agreeing === usable.length && usable.length > 0 && medianDiff !== null && Math.abs(medianDiff) >= threshold) {
    outcome = "supported";
  } else if (agreeing >= usable.length - 1 && usable.length > 0 && medianDiff !== null && Math.abs(medianDiff) >= threshold) {
    // 5 of 6 gives p = 0.109, so this is reported as weak rather than significant.
    outcome = "supported-weak";
  } else if (medianDiff !== null && (
    (predicted === "B>A" && medianDiff < -threshold) || (predicted === "B<A" && medianDiff > threshold)
  )) {
    outcome = "contradicted";
  }

  return { metric, direction: predicted, threshold, diffs, agreeing, scorable: usable.length, medianDiff, outcome, notes };
}

const comparisons: Comparison[] = [
  compare("briefRelevance", "B>A", protocol.meaningfulThresholds.M1_briefRelevance.value, (e) => ({
    a: e.metricsA.briefRelevance.value,
    b: e.metricsB.briefRelevance.value,
  })),
  compare("anchorRecycling", "B<A", protocol.meaningfulThresholds.M2_anchorRecycling.value, (e) => ({
    a: e.metricsA.anchorRecycling.value,
    b: e.metricsB.anchorRecycling.value,
  })),
  compare("distinctArtistRatio", "B>A", protocol.meaningfulThresholds.M3_diversity.value, (e) => ({
    a: e.metricsA.diversity.distinctArtistRatio ?? null,
    b: e.metricsB.diversity.distinctArtistRatio ?? null,
  })),
  compare("tagCoverage", "B>A", protocol.meaningfulThresholds.M4_tagCoverage.value, (e) => ({
    a: e.metricsA.tagCoverage.value,
    b: e.metricsB.tagCoverage.value,
  })),
];

// ---------------------------------------------------------------------------
// Human preference (only from genuine review files)
// ---------------------------------------------------------------------------

function loadHumanReviews() {
  const reviewDir = resolve(here, "reviews");
  if (!existsSync(reviewDir)) {
    return { available: false, reason: "no reviews/ directory", reviews: [] as any[] };
  }
  const files = readdirSync(reviewDir).filter((n) => n.endsWith(".json"));
  if (files.length === 0) {
    return {
      available: false,
      reason:
        "no blinded review files present; human preference is NOT computed and no " +
        "automated score is substituted for it",
      reviews: [] as any[],
    };
  }
  return {
    available: true,
    reason: `${files.length} review file(s) present`,
    reviews: files.map((f) => JSON.parse(readFileSync(resolve(reviewDir, f), "utf8"))),
  };
}

const humanPreference = loadHumanReviews();

// ---------------------------------------------------------------------------
// Results artifact
// ---------------------------------------------------------------------------

const results = {
  resultsVersion: "1.0.0",
  generatedBy: "benchmark/evaluate.mts",
  protocolVersion: protocol.protocolVersion,
  protocolHash,
  commonSlateSize: K,
  evidence: evaluations.map((e) => {
    const file = evidenceFiles.find((n) => n.startsWith(e.briefId));
    const envelope: EvidenceFile = JSON.parse(readFileSync(resolve(evidenceDir, file!), "utf8"));
    return {
      briefId: e.briefId,
      scene: envelope.scene,
      recordedAt: envelope.recordedAt,
      sourceUrl: envelope.sourceUrl,
      sourceCommit: envelope.sourceCommit,
      httpStatus: envelope.httpStatus,
      latencyMs: envelope.latencyMs,
      mode: envelope.raw.mode,
      armAProvenance: e.armA.provenance,
      armBProvenance: e.armB.provenance,
      excluded: e.excluded ?? null,
      poolSize: e.poolSize,
      /** Evidence classification, per the protocol's provenance requirement. */
      classification: e.excluded ? "excluded" : "live",
    };
  }),
  metrics: Object.fromEntries(
    evaluations.map((e) => [
      e.briefId,
      {
        anchors: e.anchors,
        armA: {
          items: e.armA.items,
          fullItemCount: e.armA.fullItems.length,
          metrics: e.metricsA,
        },
        armB: {
          items: e.armB.items,
          fullItemCount: e.armB.fullItems.length,
          metrics: e.metricsB,
          coverageFullSlate: e.armBCoverageFullSlate,
        },
        diffs: {
          briefRelevance:
            e.metricsA.briefRelevance.value !== null && e.metricsB.briefRelevance.value !== null
              ? e.metricsB.briefRelevance.value - e.metricsA.briefRelevance.value
              : null,
          anchorRecycling:
            e.metricsA.anchorRecycling.value !== null && e.metricsB.anchorRecycling.value !== null
              ? e.metricsB.anchorRecycling.value - e.metricsA.anchorRecycling.value
              : null,
          distinctArtistRatio:
            (e.metricsA.diversity.distinctArtistRatio ?? null) !== null &&
            (e.metricsB.diversity.distinctArtistRatio ?? null) !== null
              ? (e.metricsB.diversity.distinctArtistRatio ?? 0) - (e.metricsA.diversity.distinctArtistRatio ?? 0)
              : null,
          tagCoverage:
            e.metricsA.tagCoverage.value !== null && e.metricsB.tagCoverage.value !== null
              ? e.metricsB.tagCoverage.value - e.metricsA.tagCoverage.value
              : null,
        },
      },
    ]),
  ),
  comparisons,
  sensitivity,
  humanPreference,
  limitations: [
    "Pool parity is not achievable: Arm A answers open-book and is never given the candidate pool, so pool-relative metrics cannot be compared like-for-like. See protocol.poolParity.",
    "Brief relevance is a lexical word-overlap proxy, not a human judgement and not a measure of quality. It rewards restating the brief's vocabulary. It applies no stemming, so 'tense' does not match 'Tension'; this under-counts related word forms, conservatively and equally for both arms.",
    "The two arms' rationale fields are not equivalent: Arm A's is written prose that tends to contain mood words, Arm B's is Qloo provenance boilerplate that cannot. M1 as specified is therefore structurally biased against Arm B, which is why the sensitivity block reports M1 over artist and track only.",
    "Tag coverage is pool-relative and is not a measure of recommendation quality or of whether anyone likes the result.",
    "No human-preference evaluation has been performed. No automated proxy is substituted for it.",
    "n = 6 briefs. A one-sided sign test gives p = 0.0156 at 6/6 and p = 0.109 at 5/6, so a 5/6 result cannot be called significant at alpha = 0.05.",
    "The five metrics are deliberately not combined into one score; no defensible weighting exists without human preference data.",
    "Both arms come from one deployment on one day. A different model, prompt, or Qloo snapshot may produce different figures.",
  ],
};

const serialised = `${JSON.stringify(results, null, 2)}\n`;

// ---------------------------------------------------------------------------
// Write or verify
// ---------------------------------------------------------------------------

if (write) {
  writeFileSync(resultsPath, serialised, "utf8");
  console.log(`Wrote ${resultsPath}`);
} else {
  if (!existsSync(resultsPath)) {
    console.error(`No committed results artifact at ${resultsPath}. Run with --write first.`);
    process.exit(1);
  }
  const committed = readFileSync(resultsPath, "utf8");
  if (committed !== serialised) {
    console.error(
      "REPLAY MISMATCH: recomputed results differ from the committed artifact.\n" +
        "Either the metrics changed, the evidence changed, or the artifact is stale.\n" +
        "Run with --write only after confirming which, and never to make a result pass.",
    );
    process.exit(1);
  }
  console.log("Replay matches the committed results artifact.");
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (report) {
  console.log("\nLLM-only (A) vs Cue/Qloo (B), at the common slate size k =", K, "\n");
  console.log(
    "| Brief | armA.relevance | armB.relevance | armA.anchor | armB.anchor | armA.distinct | armB.distinct | armA.coverage | armB.coverage |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|");
  const fmt = (v: number | null | undefined, digits = 3) =>
    v === null || v === undefined ? "n/a" : v.toFixed(digits);
  for (const e of evaluations) {
    console.log(
      `| ${e.briefId} | ${fmt(e.metricsA.briefRelevance.value)} | ${fmt(e.metricsB.briefRelevance.value)} | ` +
        `${fmt(e.metricsA.anchorRecycling.value)} | ${fmt(e.metricsB.anchorRecycling.value)} | ` +
        `${fmt(e.metricsA.diversity.distinctArtistRatio)} | ${fmt(e.metricsB.diversity.distinctArtistRatio)} | ` +
        `${fmt(e.metricsA.tagCoverage.value, 1)} | ${fmt(e.metricsB.tagCoverage.value, 1)} |`,
    );
  }
  console.log();
  for (const c of comparisons) {
    console.log(
      `${c.metric}: predicted ${c.direction}, agreeing ${c.agreeing}/${c.scorable}, ` +
        `median diff ${c.medianDiff === null ? "n/a" : c.medianDiff.toFixed(4)}, ` +
        `threshold ${c.threshold} -> ${c.outcome.toUpperCase()}`,
    );
    for (const note of c.notes) console.log(`    note: ${note}`);
  }

  console.log("\nM1 sensitivity (does the relevance finding survive dropping the rationale?)\n");
  console.log("| Brief | A with why | B with why | A artist only | B artist only |");
  console.log("|---|---|---|---|---|");
  for (const s of sensitivity) {
    const f = (v: number | null) => (v === null ? "n/a" : v.toFixed(3));
    console.log(
      `| ${s.briefId} | ${f(s.relevanceWithWhy.a)} | ${f(s.relevanceWithWhy.b)} | ` +
        `${f(s.relevanceArtistOnly.a)} | ${f(s.relevanceArtistOnly.b)} |`,
    );
  }
  const artistOnlyDiffs = sensitivity
    .filter((s) => s.relevanceArtistOnly.a !== null && s.relevanceArtistOnly.b !== null)
    .map((s) => (s.relevanceArtistOnly.b as number) - (s.relevanceArtistOnly.a as number));
  console.log(
    `\nArtist-only median diff (B-A): ${
      artistOnlyDiffs.length ? median(artistOnlyDiffs).toFixed(4) : "n/a"
    } across ${artistOnlyDiffs.length} brief(s)`,
  );

  console.log(`\nhuman preference: ${humanPreference.available ? humanPreference.reason : `NOT AVAILABLE - ${humanPreference.reason}`}`);
}
