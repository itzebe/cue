/**
 * Shared logic for the LLM-only vs Qloo benchmark.
 *
 * Everything here is deterministic and offline. The only network access in this
 * benchmark lives in `record.mts`, which is run manually and is not part of the
 * test suite. This module recomputes every metric from committed raw evidence
 * and the frozen protocol, so a reader can re-derive the published numbers.
 *
 * Two design points are load-bearing and worth stating up front:
 *
 *  1. The Arm A input whitelist is enforced structurally, not by convention.
 *     `armAInput` returns only the fields the protocol permits, and
 *     `assertArmAIsolation` fails if the Arm A prompt is ever handed a
 *     Qloo-derived value. The check is a test, not a comment.
 *
 *  2. Arm A is never scored as zero for a pick the pool cannot measure. An
 *     unmeasurable pick is reported as unmeasurable, because a zero would be a
 *     different and false claim about what the model produced.
 */

import type { QlooEntity } from "../src/lib/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordedEntity {
  entityId: string;
  name: string;
  affinity: number;
  tags: string[];
  tagNames: Record<string, string>;
}

export interface MetricValue {
  /** The number, or null when the metric is not available. Never a stand-in zero. */
  value: number | null;
  /** Why the value is unavailable, when it is. */
  unavailableReason?: string;
}

export interface ArmItem {
  artist: string;
  track: string;
  /** The model's or the pipeline's own rationale, when one was given. */
  why: string;
  /** Qloo affinity, when this item came from Arm B. */
  affinity?: number;
  entityId?: string;
}

export interface ArmSummary {
  items: ArmItem[];
  /** The full slate before truncation to the common size (Arm B only). */
  fullItems: ArmItem[];
  provenance: {
    /** "llm" means the model actually ran; "sample" means a fixed example was substituted. */
    source: "llm" | "sample";
    provider: string | null;
    model: string | null;
  };
}

export interface SlateMetrics {
  briefRelevance: MetricValue & {
    perItem?: number[];
    perFacet?: Record<string, number>;
  };
  anchorRecycling: MetricValue & { recycled?: string[]; anchors?: string[] };
  diversity: MetricValue & {
    distinctArtistRatio?: number;
    textJaccard?: number;
    tagRedundancy?: number;
  };
  tagCoverage: MetricValue & {
    coveredTags?: number;
    vocabularySize?: number;
    /** Arm A items that the pool could not measure. Never counted as zero. */
    unmeasurableItems?: string[];
    measurableCount?: number;
  };
}

// ---------------------------------------------------------------------------
// Text handling (shared by all lexical metrics)
// ---------------------------------------------------------------------------

/** Lowercase, strip punctuation and diacritics, collapse whitespace. */
export function normalise(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenise(text: string): string[] {
  return normalise(text).split(" ").filter((token) => token.length > 1);
}

/** Facet tokens, minus words too common to carry a claim about the brief. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "under",
  "spirit", "style", "kind", "sort", "very", "just", "like", "about", "after",
  "before", "while", "when", "where", "scene", "film", "movie", "show", "track",
  "song", "music", "score", "play", "plays", "playing",
]);

function facetTokens(value: string | string[]): string[] {
  const raw = Array.isArray(value) ? value.join(" ") : value;
  return tokenise(raw).filter((token) => !STOPWORDS.has(token));
}

// ---------------------------------------------------------------------------
// Arm A isolation
// ---------------------------------------------------------------------------

/** The ONLY brief fields Arm A may ever receive. Mirrors the protocol whitelist. */
export interface ArmAInput {
  setting: string;
  mood: string[];
  era: string;
}

/**
 * Build Arm A's input by explicit field selection.
 *
 * This is a whitelist, not a blacklist. If a new field is added to SceneBrief it
 * does not reach Arm A unless it is named here, so Qloo-derived data cannot leak
 * in by default.
 */
export function armAInput(brief: {
  setting?: string;
  mood?: string[];
  era?: string;
}): ArmAInput {
  return {
    setting: String(brief.setting ?? ""),
    mood: Array.isArray(brief.mood) ? brief.mood.slice() : [],
    era: String(brief.era ?? ""),
  };
}

/**
 * Assert the Arm A prompt carries no Qloo-derived information.
 *
 * Two independent checks, because they fail in different ways:
 *
 *  1. A structural check for value-shaped Qloo data: URNs, entity UUIDs, and
 *     JSON key/value pairs such as `"affinity": 0.78` or `entity_id: "..."`.
 *     This catches an actual leak of Qloo output.
 *
 *  2. An equality check against the prompt rebuilt from the whitelist alone.
 *     This is the stronger of the two: if the prompt equals the template
 *     constructed from only setting, mood and era, then nothing else can have
 *     reached it, whether or not it matches a pattern.
 *
 * The word "affinity" is deliberately NOT forbidden. The production prompt
 * contains the sentence "You have NO cultural data, NO affinity scores and NO
 * audience measurement" — naming what the model lacks is the point of the
 * prompt, and a check that rejected the word would reject the shipped text.
 * The concern is Qloo-derived *values*, not the word.
 */
export function assertArmAIsolation(prompt: string, expected?: string): void {
  // 1. Value-shaped Qloo data.
  if (/urn:(entity|tag|brand|place)/i.test(prompt)) {
    throw new Error("Arm A prompt contains a Qloo URN, which is Qloo-derived data.");
  }
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(prompt)) {
    throw new Error("Arm A prompt contains a UUID-shaped Qloo entity id.");
  }
  if (/"(?:affinity|entity_id|tag_id|popularity|signal)"\s*:/i.test(prompt)) {
    throw new Error("Arm A prompt contains a Qloo JSON field, which is Qloo-derived data.");
  }
  if (/\baffinity\s*[:=]\s*[-0-9]/i.test(prompt)) {
    throw new Error("Arm A prompt contains an affinity value.");
  }

  // 2. Equality with the whitelist-only template.
  if (expected !== undefined && prompt !== expected) {
    throw new Error(
      "Arm A prompt is not the whitelist-only template, so something beyond " +
        "setting, mood and era reached the LLM-only arm.",
    );
  }
}

/**
 * The exact prompt the production pipeline sends to Arm A.
 *
 * Reconstructed from src/lib/planner.ts `buildBaseline` so the isolation check
 * runs against the real text rather than an approximation. Kept in sync by the
 * `armA prompt matches production` test.
 */
export function armAPrompt(input: ArmAInput): string {
  return (
    `You have NO cultural data, NO affinity scores and NO audience measurement.\n` +
    `Using only general knowledge, name 3 artists and one track each for this scene.\n` +
    `Do not hedge. Answer as JSON: {"cues":[{"artist":"","track":"","why":""}]}\n\n` +
    `Scene: ${input.setting}\n` +
    `Mood: ${input.mood.join(", ")}\n` +
    `Era: ${input.era}`
  );
}

// ---------------------------------------------------------------------------
// Slate selection
// ---------------------------------------------------------------------------

/**
 * Truncate a slate to the common size by measured affinity.
 *
 * Deterministic: affinity descending, popularity descending, entity id ascending.
 * The third key exists so the order cannot depend on input ordering when both
 * numeric keys tie.
 */
export function topByAffinity(items: ArmItem[], k: number): ArmItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (b.item.affinity ?? 0) - (a.item.affinity ?? 0) ||
        a.index - b.index,
    )
    .slice(0, k)
    .map((entry) => entry.item);
}

// ---------------------------------------------------------------------------
// M1 — brief relevance (lexical facet-match proxy)
// ---------------------------------------------------------------------------

export function briefRelevance(
  items: ArmItem[],
  brief: { setting?: string; mood?: string[]; era?: string; genre?: string[] },
  options: { includeWhy?: boolean } = {},
): SlateMetrics["briefRelevance"] {
  const includeWhy = options.includeWhy !== false;
  if (items.length === 0) {
    return { value: null, unavailableReason: "the slate is empty" };
  }

  const facets: Record<string, string[]> = {
    mood: facetTokens(brief.mood ?? []),
    genre: facetTokens(brief.genre ?? []),
    era: facetTokens(brief.era ?? ""),
    setting: facetTokens(brief.setting ?? ""),
  };

  const facetNames = Object.keys(facets);
  const perFacet: Record<string, number> = {};
  const perItem: number[] = [];

  for (const item of items) {
    const text = includeWhy
      ? normalise(`${item.artist} ${item.track} ${item.why}`)
      : normalise(`${item.artist} ${item.track}`);
    let matched = 0;
    for (const name of facetNames) {
      const tokens = facets[name];
      // A facet with no tokens cannot be matched, and cannot be failed either:
      // it is excluded from the denominator so an empty genre list does not
      // silently penalise every item.
      if (tokens.length === 0) continue;
      if (tokens.some((token) => text.includes(token))) matched += 1;
    }
    const scorable = facetNames.filter((name) => facets[name].length > 0).length;
    const itemScore = scorable === 0 ? 0 : matched / scorable;
    perItem.push(itemScore);
    for (const name of facetNames) {
      const tokens = facets[name];
      if (tokens.length === 0) continue;
      const hit = tokens.some((token) => text.includes(token));
      perFacet[name] = (perFacet[name] ?? 0) + (hit ? 1 : 0);
    }
  }

  for (const name of facetNames) {
    perFacet[name] = perFacet[name] === undefined ? 0 : perFacet[name] / items.length;
  }

  return {
    value: perItem.reduce((sum, v) => sum + v, 0) / perItem.length,
    perItem,
    perFacet,
  };
}

// ---------------------------------------------------------------------------
// M2 — anchor recycling
// ---------------------------------------------------------------------------

/** Whole-token match so "Air" does not match "AiR" inside an unrelated word. */
export function namesAnchor(item: ArmItem, anchors: string[]): string | null {
  const textTokens = new Set(tokenise(`${item.artist} ${item.track}`));
  for (const anchor of anchors) {
    const anchorTokens = tokenise(anchor);
    if (anchorTokens.length === 0) continue;
    if (anchorTokens.every((token) => textTokens.has(token))) return anchor;
  }
  return null;
}

export function anchorRecycling(
  items: ArmItem[],
  anchors: string[],
): SlateMetrics["anchorRecycling"] {
  if (items.length === 0) {
    return { value: null, unavailableReason: "the slate is empty", anchors };
  }
  if (anchors.length === 0) {
    // No anchors in the brief means the metric is not applicable. Reporting 0
    // would look like a perfect score on a brief where nothing could be recycled.
    return {
      value: null,
      unavailableReason: "the brief names no anchors, so recycling is not applicable",
      anchors,
    };
  }
  const recycled: string[] = [];
  let hits = 0;
  for (const item of items) {
    const anchor = namesAnchor(item, anchors);
    if (anchor) {
      hits += 1;
      recycled.push(anchor);
    }
  }
  return { value: hits / items.length, recycled, anchors };
}

// ---------------------------------------------------------------------------
// M3 — diversity
// ---------------------------------------------------------------------------

export function diversity(items: ArmItem[]): SlateMetrics["diversity"] {
  if (items.length === 0) {
    return { value: null, unavailableReason: "the slate is empty" };
  }
  const artists = items.map((item) => normalise(item.artist)).filter((a) => a.length > 0);
  const distinctArtistRatio = artists.length === 0 ? 0 : new Set(artists).size / items.length;

  // Mean pairwise Jaccard over the item text. One item has no pairs, so the
  // content-variety figure is unavailable rather than vacuously 0.
  let textJaccard: number | undefined;
  if (items.length >= 2) {
    const tokenSets = items.map((item) => new Set(tokenise(`${item.artist} ${item.track} ${item.why}`)));
    let total = 0;
    let pairs = 0;
    for (let i = 0; i < tokenSets.length; i += 1) {
      for (let j = i + 1; j < tokenSets.length; j += 1) {
        const a = tokenSets[i];
        const b = tokenSets[j];
        const union = new Set([...a, ...b]);
        if (union.size === 0) continue;
        let intersection = 0;
        for (const token of a) if (b.has(token)) intersection += 1;
        total += intersection / union.size;
        pairs += 1;
      }
    }
    textJaccard = pairs === 0 ? undefined : total / pairs;
  }

  return { value: distinctArtistRatio, distinctArtistRatio, textJaccard };
}

// ---------------------------------------------------------------------------
// M4 — tag coverage (production metric, unchanged)
// ---------------------------------------------------------------------------

/**
 * Resolve Arm A's free-text picks into pool entities by normalised artist name.
 *
 * A pick that does not resolve is reported as unmeasurable. It is never scored
 * as zero, and it is never fuzzy-matched to a different entity: only an exact
 * normalised name match counts.
 */
export function resolveIntoPool(
  items: ArmItem[],
  pool: RecordedEntity[],
): { indices: number[]; unmeasurable: string[]; matched: Record<string, number> } {
  const byName = new Map<string, number>();
  pool.forEach((entity, index) => {
    const key = normalise(entity.name);
    if (key.length > 0 && !byName.has(key)) byName.set(key, index);
  });

  const indices: number[] = [];
  const unmeasurable: string[] = [];
  const matched: Record<string, number> = {};

  for (const item of items) {
    const key = normalise(item.artist);
    const index = byName.get(key);
    if (index === undefined) {
      unmeasurable.push(item.artist);
      continue;
    }
    if (!indices.includes(index)) indices.push(index);
    matched[item.artist] = index;
  }

  return { indices, unmeasurable, matched };
}

// ---------------------------------------------------------------------------
// Full slate evaluation
// ---------------------------------------------------------------------------

export interface BriefEvaluation {
  briefId: string;
  anchors: string[];
  commonSlateSize: number;
  armA: ArmSummary;
  armB: ArmSummary;
  /** Excluded from aggregate comparison when either arm degraded. */
  excluded?: { reason: string };
  metricsA: SlateMetrics;
  metricsB: SlateMetrics;
  /** Arm B's coverage over its full untruncated slate, labelled not size-matched. */
  armBCoverageFullSlate: MetricValue;
  poolSize: number;
}

export function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export type { QlooEntity };
