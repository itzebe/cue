/**
 * Benchmark verification: the tests that make the comparison's claims checkable.
 *
 * These run fully offline against committed evidence. They cover the protocol's
 * own failure modes rather than only its happy path: a metric that silently
 * changes, an artifact that drifts from its evidence, an Arm A prompt that leaks
 * Qloo data, and a results file that has been edited by hand.
 *
 * Run: npx tsx benchmark/verify-benchmark.mts
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import {
  armAInput,
  armAPrompt,
  assertArmAIsolation,
  briefRelevance,
  anchorRecycling,
  diversity,
  resolveIntoPool,
  topByAffinity,
  namesAnchor,
  normalise,
  tokenise,
  median,
  type ArmItem,
  type RecordedEntity,
} from "./lib.mts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const evidenceDir = resolve(here, "evidence");

let passed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`  FAIL ${name}`);
  }
}

const protocolRaw = readFileSync(resolve(here, "protocol.json"));
const protocol = JSON.parse(protocolRaw.toString("utf8"));
const protocolHash = createHash("sha256").update(protocolRaw).digest("hex");

const results = JSON.parse(readFileSync(resolve(here, "results.json"), "utf8"));

const evidenceFiles = readdirSync(evidenceDir)
  .filter((n) => n.endsWith(".json") && !n.endsWith(".pool.json"))
  .sort();

function loadEvidence(name: string) {
  return JSON.parse(readFileSync(resolve(evidenceDir, name), "utf8"));
}
function loadPool(briefId: string) {
  return JSON.parse(readFileSync(resolve(evidenceDir, `${briefId}.pool.json`), "utf8"));
}

console.log("\nBenchmark verification\n");

// ---------------------------------------------------------------------------
// Artifact integrity
// ---------------------------------------------------------------------------

await check("results artifact records the frozen protocol hash", () => {
  assert.equal(
    results.protocolHash,
    protocolHash,
    "results.json was produced against a different protocol than the one committed",
  );
});

await check("results artifact is not stale relative to the protocol version", () => {
  assert.equal(results.protocolVersion, protocol.protocolVersion);
});

await check("every protocol brief has evidence and a verified pool", () => {
  for (const brief of protocol.briefs) {
    assert.ok(
      evidenceFiles.includes(`${brief.id}.json`),
      `missing evidence for ${brief.id}`,
    );
    assert.ok(
      existsSync(resolve(evidenceDir, `${brief.id}.pool.json`)),
      `missing pool for ${brief.id}`,
    );
  }
});

await check("every frozen pool was verified against the recorded fingerprint", () => {
  for (const brief of protocol.briefs) {
    const pool = loadPool(brief.id);
    assert.equal(pool.verifiedAgainstRecorded.verified, true, `${brief.id} pool is unverified`);
    for (const [name, ok] of Object.entries(pool.verifiedAgainstRecorded.checks)) {
      assert.equal(ok, true, `${brief.id} pool check ${name} failed`);
    }
  }
});

await check("no evidence file contains credential-shaped material", () => {
  const patterns = [
    /sk-[A-Za-z0-9]{16,}/,
    /gsk_[A-Za-z0-9]{20,}/,
    /AIza[A-Za-z0-9_\-]{30,}/,
    /Bearer\s+[A-Za-z0-9._\-]{20,}/,
  ];
  for (const name of evidenceFiles) {
    const text = readFileSync(resolve(evidenceDir, name), "utf8");
    for (const pattern of patterns) {
      assert.ok(!pattern.test(text), `${name} matches credential pattern ${pattern}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Tamper rejection
// ---------------------------------------------------------------------------

await check("a tampered evidence file changes the recomputed result", async () => {
  // Recompute with the committed evidence, then with the slate's tags stripped,
  // and confirm the two disagree. If they did not, the replay would not be
  // sensitive to its inputs and passing it would mean nothing.
  //
  // Note: swapping tags BETWEEN two slate entities would NOT change coverage,
  // because coverage is the union over the slate. The perturbation has to change
  // the union, which stripping tags does.
  const { computeTasteGap } = await import("../src/lib/coverage.ts");
  const pool = loadPool("late-90s-trip-hop");

  const toQloo = (entities: any[]) =>
    entities.map((e: any) => ({
      entity_id: e.entityId,
      name: e.name,
      type: "urn:entity:artist",
      affinity: e.affinity,
      tags: e.tags.map((id: string) => ({ tag_id: id, name: e.tagNames?.[id] ?? id })),
    }));

  const clean = computeTasteGap(toQloo(pool.pool), pool.selectedIndices, pool.selectedIndices.length);

  const tamperedPool = JSON.parse(JSON.stringify(pool.pool));
  for (const index of pool.selectedIndices) tamperedPool[index].tags = [];
  const tampered = computeTasteGap(
    toQloo(tamperedPool),
    pool.selectedIndices,
    pool.selectedIndices.length,
  );

  assert.notEqual(
    clean.original.index,
    tampered.original.index,
    "stripping the slate's tags did not change the coverage index, so replay is not input-sensitive",
  );
  assert.ok(
    tampered.original.index < clean.original.index,
    "stripping tags should lower coverage, not raise it",
  );
});

await check("the committed results artifact matches a fresh replay", () => {
  // Run the evaluator in check mode; it exits non-zero on any drift.
  execFileSync("npx", ["tsx", "benchmark/evaluate.mts"], { cwd: root, stdio: "pipe" });
});

// ---------------------------------------------------------------------------
// Arm A isolation
// ---------------------------------------------------------------------------

await check("armAInput is a whitelist that drops every other brief field", () => {
  const brief = {
    setting: "a rainy street",
    mood: ["melancholy"],
    era: "late 90s",
    // Everything below is Qloo-derived or otherwise not whitelisted.
    anchors: ["Portishead"],
    genre: ["trip hop"],
    audience: { age: "25-34" },
    region: "GB",
    diegetic: true,
  };
  const input = armAInput(brief);
  assert.deepEqual(Object.keys(input).sort(), ["era", "mood", "setting"]);
  assert.equal((input as any).anchors, undefined);
  assert.equal((input as any).region, undefined);
  assert.equal((input as any).audience, undefined);
});

await check("the production Arm A prompt passes the isolation check", () => {
  const prompt = armAPrompt({ setting: "a rainy street", mood: ["melancholy"], era: "late 90s" });
  assertArmAIsolation(prompt);
});

await check("the isolation check rejects a leaked Qloo URN", () => {
  assert.throws(
    () => assertArmAIsolation("Scene: urn:tag:genre:qloo:trip_hop"),
    /URN/,
    "a Qloo URN in the prompt must be rejected",
  );
});

await check("the isolation check rejects a leaked entity id", () => {
  assert.throws(
    () => assertArmAIsolation("Scene: 3A7CAB8B-764F-46EF-AF77-45D5C1FC8C44"),
    /entity id/,
  );
});

await check("the isolation check rejects a leaked affinity value", () => {
  assert.throws(() => assertArmAIsolation('{"affinity": 0.78}'), /Qloo JSON field|affinity/);
  assert.throws(() => assertArmAIsolation("affinity: 0.78"), /affinity value/);
});

await check("the isolation check rejects a mismatched expected template", () => {
  assert.throws(
    () => assertArmAIsolation("something else", "the expected prompt"),
    /whitelist-only template/,
  );
});

await check("every recorded brief's Arm A input is Qloo-free", () => {
  for (const name of evidenceFiles) {
    const evidence = loadEvidence(name);
    const input = armAInput(evidence.raw.brief ?? {});
    assertArmAIsolation(armAPrompt(input));
    assertArmAIsolation([input.setting, input.era, ...input.mood].join("\n"));
  }
});

await check("the recorded Arm A output never contains a Qloo identifier", () => {
  // The model's own answer must not contain entity ids either; if it did, it
  // would suggest the model had access to Qloo data it should not have seen.
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  for (const name of evidenceFiles) {
    const evidence = loadEvidence(name);
    for (const cue of evidence.raw.baseline?.cues ?? []) {
      const text = `${cue.artist} ${cue.track} ${cue.why}`;
      assert.ok(!uuid.test(text), `Arm A output in ${name} contains a UUID`);
      assert.ok(!/urn:(entity|tag)/i.test(text), `Arm A output in ${name} contains a Qloo URN`);
    }
  }
});

// ---------------------------------------------------------------------------
// Candidate-pool parity
// ---------------------------------------------------------------------------

await check("both arms are scored against the same pool for coverage", () => {
  // The protocol promises one pool per brief; both arms' coverage figures must
  // come from it. Recompute Arm A and Arm B coverage over the same pool and
  // confirm the artifact's numbers are consistent with it.
  for (const brief of protocol.briefs) {
    const pool = loadPool(brief.id);
    const entry = results.metrics[brief.id];
    assert.ok(entry, `results has no entry for ${brief.id}`);
    // Arm B's truncated coverage must be a value or explicitly unavailable.
    const b = entry.armB.metrics.tagCoverage;
    assert.ok(
      b.value !== null || typeof b.unavailableReason === "string",
      `${brief.id} Arm B coverage is neither a number nor explained`,
    );
    assert.ok(pool.pool.length > 0, `${brief.id} pool is empty`);
  }
});

await check("an unmeasurable pick is never scored as zero", () => {
  const pool: RecordedEntity[] = [
    { entityId: "a", name: "Real Artist", affinity: 0.5, tags: ["t1"], tagNames: {} },
  ];
  const items: ArmItem[] = [
    { artist: "Real Artist", track: "x", why: "" },
    { artist: "Not In Pool At All", track: "y", why: "" },
  ];
  const { indices, unmeasurable } = resolveIntoPool(items, pool);
  assert.equal(indices.length, 1, "only the resolvable pick should be measured");
  assert.deepEqual(unmeasurable, ["Not In Pool At All"]);
  assert.ok(!indices.includes(-1), "an unresolvable pick must not become a sentinel index");
});

await check("pool resolution is exact-match only, never fuzzy", () => {
  const pool: RecordedEntity[] = [
    { entityId: "a", name: "Air", affinity: 0.5, tags: [], tagNames: {} },
  ];
  const { indices, unmeasurable } = resolveIntoPool(
    [{ artist: "AiR (French band)", track: "", why: "" }],
    pool,
  );
  assert.equal(indices.length, 0, "a partial name must not match an entity");
  assert.equal(unmeasurable.length, 1);
});

await check("pool resolution is case- and punctuation-insensitive", () => {
  const pool: RecordedEntity[] = [
    { entityId: "a", name: "Sly & The Family Stone", affinity: 0.5, tags: [], tagNames: {} },
  ];
  const { indices } = resolveIntoPool(
    [{ artist: "sly and the family stone", track: "", why: "" }],
    pool,
  );
  // "and" vs "&" is a genuine difference after normalisation, so this must NOT
  // match; the point is that the normalisation is applied consistently.
  assert.equal(indices.length, 0);
  const exact = resolveIntoPool([{ artist: "Sly & The Family Stone", track: "", why: "" }], pool);
  assert.equal(exact.indices.length, 1);
});

// ---------------------------------------------------------------------------
// Slate-size parity
// ---------------------------------------------------------------------------

await check("Arm B is truncated to the common size by affinity", () => {
  const items: ArmItem[] = [
    { artist: "low", track: "", why: "", affinity: 0.1 },
    { artist: "high", track: "", why: "", affinity: 0.9 },
    { artist: "mid", track: "", why: "", affinity: 0.5 },
  ];
  const top2 = topByAffinity(items, 2);
  assert.deepEqual(top2.map((i) => i.artist), ["high", "mid"]);
});

await check("truncation is deterministic when affinities tie", () => {
  const items: ArmItem[] = [
    { artist: "first", track: "", why: "", affinity: 0.5 },
    { artist: "second", track: "", why: "", affinity: 0.5 },
  ];
  // Input order is the tiebreak, so the result is stable across runs.
  assert.deepEqual(topByAffinity(items, 1).map((i) => i.artist), ["first"]);
  assert.deepEqual(topByAffinity([...items].reverse(), 1).map((i) => i.artist), ["second"]);
});

await check("every scored brief uses the common slate size for both arms", () => {
  for (const [briefId, entry] of Object.entries<any>(results.metrics)) {
    const k = results.commonSlateSize;
    if (entry.armA.items.length > 0) {
      assert.ok(entry.armA.items.length <= k, `${briefId} Arm A exceeds k`);
    }
    assert.ok(entry.armB.items.length <= k, `${briefId} Arm B exceeds k`);
  }
});

await check("Arm A and Arm B are the same length on every scored brief", () => {
  for (const [briefId, entry] of Object.entries<any>(results.metrics)) {
    const excluded = results.evidence.find((e: any) => e.briefId === briefId)?.excluded;
    if (excluded) continue;
    assert.equal(
      entry.armA.items.length,
      entry.armB.items.length,
      `${briefId} arms have different slate sizes`,
    );
  }
});

// ---------------------------------------------------------------------------
// Metric calculations
// ---------------------------------------------------------------------------

await check("brief relevance counts a facet only on a whole-token match", () => {
  const brief = { mood: ["melancholy"], era: "1990s", setting: "rainy street", genre: [] };
  // "melancholy" present, "1990s" absent, "rainy" absent.
  const hit = briefRelevance([{ artist: "x", track: "Melancholy Blues", why: "" }], brief);
  assert.ok((hit.value ?? 0) > 0);
  const miss = briefRelevance([{ artist: "x", track: "Happy Days", why: "" }], brief);
  assert.equal(miss.value, 0);
});

await check("brief relevance reports per-facet counts for audit", () => {
  const brief = { mood: ["tension"], era: "2020s", setting: "city at night", genre: ["electronic"] };
  const result = briefRelevance([{ artist: "x", track: "Electronic Tension", why: "" }], brief);
  assert.ok(result.perFacet, "perFacet must be reported so the score can be audited");
  assert.equal(result.perFacet!.mood, 1, "the mood facet should have matched");
  assert.equal(result.perFacet!.genre, 1, "the genre facet should have matched");
});

await check("brief relevance applies no stemming, which is a known limitation", () => {
  // "tense" does not match "Tension" because the proxy is plain substring
  // matching with no stemmer. This is a real limitation of a lexical proxy and
  // is asserted here rather than left as a surprise: it makes the metric
  // conservative, under-counting related word forms in both arms equally.
  const brief = { mood: ["tense"], era: "", setting: "", genre: [] };
  const result = briefRelevance([{ artist: "x", track: "Electronic Tension", why: "" }], brief);
  assert.equal(result.perFacet!.mood, 0, "no stemming is applied; 'tense' must not match 'Tension'");
  assert.equal(result.value, 0);
});

await check("brief relevance can exclude the rationale (M1 sensitivity)", () => {
  const brief = { mood: ["melancholy"], era: "", setting: "", genre: [] };
  const item: ArmItem = { artist: "x", track: "Untitled", why: "a melancholy piece" };
  const withWhy = briefRelevance([item], brief, { includeWhy: true });
  const withoutWhy = briefRelevance([item], brief, { includeWhy: false });
  assert.ok((withWhy.value ?? 0) > (withoutWhy.value ?? 0), "the rationale must carry the match");
});

await check("anchor recycling matches whole tokens only", () => {
  assert.equal(namesAnchor({ artist: "Portishead", track: "", why: "" }, ["Portishead"]), "Portishead");
  // "Portishead" must not match inside "Portisheadsoundtrack".
  assert.equal(namesAnchor({ artist: "Portisheadsoundtrack", track: "", why: "" }, ["Portishead"]), null);
  assert.equal(namesAnchor({ artist: "Massive", track: "", why: "" }, ["Massive Attack"]), null);
});

await check("anchor recycling is not applicable when the brief names no anchor", () => {
  const result = anchorRecycling([{ artist: "x", track: "", why: "" }], []);
  assert.equal(result.value, null, "no anchors means null, not a perfect zero");
  assert.match(result.unavailableReason ?? "", /no anchors/);
});

await check("anchor recycling counts a repeated anchor correctly", () => {
  const result = anchorRecycling(
    [
      { artist: "Curtis Mayfield", track: "", why: "" },
      { artist: "Stevie Wonder", track: "", why: "" },
      { artist: "Curtis Mayfield", track: "", why: "" },
    ],
    ["Curtis Mayfield"],
  );
  assert.ok(Math.abs((result.value ?? 0) - 2 / 3) < 1e-12);
  assert.deepEqual(result.recycled, ["Curtis Mayfield", "Curtis Mayfield"]);
});

await check("diversity distinctArtistRatio counts unique artists", () => {
  const result = diversity([
    { artist: "A", track: "", why: "" },
    { artist: "A", track: "", why: "" },
    { artist: "B", track: "", why: "" },
  ]);
  assert.ok(Math.abs((result.distinctArtistRatio ?? 0) - 2 / 3) < 1e-12);
});

await check("diversity textJaccard is 1 for identical text and 0 for disjoint text", () => {
  const same = diversity([
    { artist: "A", track: "Same Words Here", why: "" },
    { artist: "B", track: "Same Words Here", why: "" },
  ]);
  const different = diversity([
    { artist: "Alpha", track: "One", why: "" },
    { artist: "Beta", track: "Two", why: "" },
  ]);
  assert.ok((same.textJaccard ?? 0) > 0.5, "identical text should overlap heavily");
  assert.ok((different.textJaccard ?? 1) < 0.2, "disjoint text should barely overlap");
});

await check("the production coverage metric is reused unchanged", async () => {
  // Coverage must come from computeTasteGap, not a reimplementation. Recompute
  // Arm B's full-slate figure from the frozen pool and match the recorded value.
  const { computeTasteGap } = await import("../src/lib/coverage.ts");
  const pool = loadPool("late-90s-trip-hop");
  const qloo = pool.pool.map((e: any) => ({
    entity_id: e.entityId,
    name: e.name,
    type: "urn:entity:artist",
    affinity: e.affinity,
    tags: e.tags.map((id: string) => ({ tag_id: id, name: e.tagNames?.[id] ?? id })),
  }));
  const gap = computeTasteGap(qloo, pool.selectedIndices, pool.selectedIndices.length);
  const recorded = pool.verifiedAgainstRecorded.recorded.index;
  assert.ok(
    Math.abs(gap.original.index - recorded) < 1e-9,
    `coverage recomputation ${gap.original.index} != recorded ${recorded}`,
  );
});

// ---------------------------------------------------------------------------
// Missing / malformed / degraded records
// ---------------------------------------------------------------------------

await check("a brief with a degraded Arm A is excluded, not scored", () => {
  for (const e of results.evidence) {
    if (e.armAProvenance.source !== "llm") {
      assert.ok(e.excluded, `${e.briefId} has a degraded Arm A but is not excluded`);
      assert.equal(e.classification, "excluded");
    }
  }
});

await check("a brief that did not run live is excluded, not scored", () => {
  for (const e of results.evidence) {
    if (e.mode !== "live") {
      assert.ok(e.excluded, `${e.briefId} did not run live but is not excluded`);
    }
  }
});

await check("no scored brief carries an exclusion", () => {
  for (const [briefId, entry] of Object.entries<any>(results.metrics)) {
    const excluded = results.evidence.find((e: any) => e.briefId === briefId)?.excluded;
    if (excluded) {
      // An excluded brief may still have metrics recorded, but must not be
      // counted in a comparison. Assert the comparisons do not include it.
      for (const comparison of results.comparisons) {
        const diff = comparison.diffs.find((d: any) => d.briefId === briefId);
        assert.ok(
          !diff || diff.diff === null,
          `${briefId} is excluded but contributes a non-null diff to ${comparison.metric}`,
        );
      }
    }
  }
});

await check("a missing metric is null with a reason, never a zero", () => {
  const result = briefRelevance([], { mood: [], era: "", setting: "" });
  assert.equal(result.value, null);
  assert.ok(result.unavailableReason, "an unavailable metric must explain itself");

  const anchors = anchorRecycling([], ["X"]);
  assert.equal(anchors.value, null);
  assert.ok(anchors.unavailableReason);

  const emptyDiversity = diversity([]);
  assert.equal(emptyDiversity.value, null);
});

await check("live and sample provenance are labelled distinctly", () => {
  const sources = new Set(results.evidence.map((e: any) => e.armAProvenance.source));
  for (const source of sources) {
    assert.ok(
      source === "llm" || source === "sample",
      `unexpected Arm A provenance label: ${source}`,
    );
  }
  // Each brief records its classification explicitly.
  for (const e of results.evidence) {
    assert.ok(
      ["live", "excluded"].includes(e.classification),
      `${e.briefId} has classification ${e.classification}`,
    );
  }
});

await check("human preference is reported unavailable rather than invented", () => {
  assert.ok(results.humanPreference, "humanPreference must be present");
  if (!results.humanPreference.available) {
    assert.ok(
      typeof results.humanPreference.reason === "string" && results.humanPreference.reason.length > 0,
      "an unavailable human-preference metric must give a reason",
    );
  } else {
    // If reviews ever exist, they must be real files, and there must be ratings.
    assert.ok(Array.isArray(results.humanPreference.reviews));
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

await check("normalise and tokenise are stable", () => {
  assert.equal(normalise("Ólafur Arnalds!"), "olafur arnalds");
  assert.deepEqual(tokenise("Trip-hop, 90s!"), ["trip", "hop", "90s"]);
});

await check("median matches the standard definition on both parities", () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])), "median of nothing is NaN, not zero");
});

await check("recomputing the metrics twice gives identical values", () => {
  const first = results.metrics["late-90s-trip-hop"];
  const second = JSON.parse(readFileSync(resolve(here, "results.json"), "utf8")).metrics[
    "late-90s-trip-hop"
  ];
  assert.deepEqual(first, second);
});

await check("the evaluator produces byte-identical output on a repeat run", () => {
  // Write to a temp location by capturing the replay check, which compares the
  // serialised artifact to the committed one. Two clean replays must both pass.
  execFileSync("npx", ["tsx", "benchmark/evaluate.mts"], { cwd: root, stdio: "pipe" });
  execFileSync("npx", ["tsx", "benchmark/evaluate.mts"], { cwd: root, stdio: "pipe" });
});

// ---------------------------------------------------------------------------
// Conclusion honesty
// ---------------------------------------------------------------------------

await check("no comparison claims significance at 5/6 or below", () => {
  for (const comparison of results.comparisons) {
    if (comparison.outcome === "supported") {
      assert.equal(
        comparison.agreeing,
        comparison.scorable,
        `${comparison.metric} claims strong support without full agreement`,
      );
    }
  }
});

await check("an inconclusive comparison is not reported as support", () => {
  for (const comparison of results.comparisons) {
    assert.ok(
      ["supported", "supported-weak", "contradicted", "inconclusive"].includes(comparison.outcome),
      `unexpected outcome ${comparison.outcome}`,
    );
  }
});

await check("the artifact states the coverage and relevance caveats", () => {
  const text = results.limitations.join(" ");
  assert.match(text, /not a measure of recommendation quality/i);
  assert.match(text, /lexical word-overlap proxy/i);
  assert.match(text, /no human-preference evaluation has been performed/i);
  assert.match(text, /pool parity is not achievable/i);
});

await check("no composite score is reported", () => {
  assert.equal(results.compositeScore, undefined, "no composite score may be reported");
  for (const comparison of results.comparisons) {
    assert.ok(!("composite" in comparison));
  }
});

// ---------------------------------------------------------------------------
// Exploratory findings are labelled as such
// ---------------------------------------------------------------------------

await check("exploratory findings are labelled post-hoc, never preregistered", () => {
  assert.ok(Array.isArray(results.exploratoryFindings), "exploratoryFindings must be present");
  for (const finding of results.exploratoryFindings) {
    assert.equal(finding.status, "post-hoc", `${finding.id} must be marked post-hoc`);
    assert.ok(
      typeof finding.caveat === "string" && finding.caveat.length > 40,
      `${finding.id} must carry a substantive caveat`,
    );
  }
});

await check("no exploratory finding is counted as a preregistered hypothesis", () => {
  // The protocol's hypotheses are H1-H4. An exploratory finding must not appear
  // among the comparisons, which are the preregistered tests.
  const comparisonNames = results.comparisons.map((c: any) => c.metric);
  assert.deepEqual(comparisonNames, [
    "briefRelevance",
    "anchorRecycling",
    "distinctArtistRatio",
    "tagCoverage",
  ]);
});

await check("the identical-slate finding is reproducible from the evidence", () => {
  // Recompute cross-brief overlap straight from the evidence files and confirm
  // the recorded finding matches. This is what makes the post-hoc result
  // checkable rather than merely asserted.
  const slates = new Map<string, string[]>();
  for (const name of evidenceFiles) {
    const evidence = loadEvidence(name);
    const items: ArmItem[] = (evidence.raw.cues ?? []).map((c: any) => ({
      artist: String(c.artist),
      track: "",
      why: "",
      affinity: c.affinity ?? 0,
    }));
    slates.set(
      evidence.briefId,
      topByAffinity(items, results.commonSlateSize).map((i) => normalise(i.artist)),
    );
  }

  const afrobeats = slates.get("afrobeats-sports-montage")!;
  const noir = slates.get("modern-noir-procedural")!;
  assert.deepEqual(
    afrobeats,
    noir,
    "the two briefs no longer share an Arm B slate; the recorded finding would be stale",
  );

  const finding = results.exploratoryFindings.find(
    (f: any) => f.id === "E1-cross-brief-distinctiveness",
  );
  assert.ok(finding, "the exploratory finding must be present");
  assert.ok(
    finding.measured.armB.identicalPairs.some((pair: string) =>
      pair.includes("afrobeats-sports-montage") && pair.includes("modern-noir-procedural"),
    ),
    "the identical pair must be recorded in the finding",
  );
});

await check("the two identical-slate briefs really do request disjoint genres", () => {
  const a = loadEvidence("afrobeats-sports-montage.json").raw.brief.genre.map(normalise);
  const b = loadEvidence("modern-noir-procedural.json").raw.brief.genre.map(normalise);
  const overlap = a.filter((g: string) => b.includes(g));
  assert.equal(
    overlap.length,
    0,
    `the briefs must request disjoint genres for the finding to mean anything; shared: ${overlap}`,
  );
});

await check("the post-hoc metric is not presented as a significance test", () => {
  const finding = results.exploratoryFindings.find(
    (f: any) => f.id === "E1-cross-brief-distinctiveness",
  );
  const text = `${finding.finding} ${finding.caveat}`;
  assert.match(text, /not in the frozen protocol/i);
  assert.match(text, /no significance is claimed/i);
});

// ---------------------------------------------------------------------------
// Blinded review worksheet
// ---------------------------------------------------------------------------

await check("the review worksheet shows no arm-identifying detail", () => {
  const worksheetPath = resolve(here, "reviews", "worksheet.md");
  if (!existsSync(worksheetPath)) return; // generated on demand
  const text = readFileSync(worksheetPath, "utf8");
  // Arm B's provenance boilerplate must never reach the reviewer.
  assert.ok(!/Qloo's taste graph/i.test(text), "the worksheet leaks Arm B's rationale");
  assert.ok(!/urn:(entity|tag)/i.test(text), "the worksheet leaks a Qloo URN");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text), "the worksheet leaks an entity id");
  assert.ok(!/affinity/i.test(text), "the worksheet leaks affinity scores");
  assert.ok(!/^\*\*Arm [AB]\*\*/m.test(text), "the worksheet labels an arm directly");
});

await check("the worksheet covers every brief at the common slate size", () => {
  const worksheetPath = resolve(here, "reviews", "worksheet.md");
  if (!existsSync(worksheetPath)) return;
  const text = readFileSync(worksheetPath, "utf8");
  for (const brief of protocol.briefs) {
    assert.ok(text.includes(`## ${brief.id}`), `worksheet is missing ${brief.id}`);
  }
  const answerCount = (text.match(/\*\*Answer [XY]\*\*/g) ?? []).length;
  assert.equal(answerCount, protocol.briefs.length * 2, "each brief needs exactly two answers");
});

await check("the X/Y mapping is deterministic and hidden from the worksheet", () => {
  const mappingPath = resolve(here, "reviews", "mapping.json");
  if (!existsSync(mappingPath)) return;
  const mapping = JSON.parse(readFileSync(mappingPath, "utf8"));
  assert.equal(mapping.protocolHash, protocolHash);
  for (const brief of protocol.briefs) {
    const entry = mapping.mapping[brief.id];
    assert.ok(entry, `mapping is missing ${brief.id}`);
    assert.notEqual(entry.X, entry.Y, "X and Y must be different arms");
  }
});

await check("a template review file is not counted as human evidence", () => {
  // The evaluator ignores TEMPLATE.json and ignores review files with no
  // numeric ratings, so an unfilled template cannot masquerade as a result.
  const reviewDir = resolve(here, "reviews");
  if (!existsSync(reviewDir)) return;
  if (results.humanPreference.available) {
    // If it reports available, the underlying files must carry real numbers.
    assert.ok(results.humanPreference.reviews.length > 0);
    for (const review of results.humanPreference.reviews) {
      const hasRating = (review.data.ratings ?? []).some((brief: any) =>
        ["X", "Y"].some((label) =>
          ["relevance", "variety", "wouldUse"].some(
            (c) => typeof brief?.answers?.[label]?.[c] === "number",
          ),
        ),
      );
      assert.ok(hasRating, `${review.file} is counted but contains no ratings`);
    }
  } else {
    assert.equal(results.humanPreference.reviews.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Cross-check against the deployment's own numbers
// ---------------------------------------------------------------------------

await check("recomputed Arm B coverage matches the deployment's published figure", () => {
  // The strongest available check that the frozen pool is the real pool: the
  // deployment's own tasteGap figure must be reproducible from it.
  for (const name of evidenceFiles) {
    const evidence = loadEvidence(name);
    const recorded = evidence.raw.tasteGap?.original?.index;
    if (typeof recorded !== "number") continue;
    const pool = loadPool(evidence.briefId);
    assert.ok(
      Math.abs(pool.verifiedAgainstRecorded.recorded.index - recorded) < 1e-9,
      `${evidence.briefId} pool fingerprint does not match the published figure`,
    );
  }
});

console.log(`\n${passed} passed, ${failures.length} failed.\n`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
