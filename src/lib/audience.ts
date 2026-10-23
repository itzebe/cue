import type { SearchResult } from "./types";

/**
 * The Audience Identity Brief.
 *
 * Qloo's `properties.audience_identity` is a prose description of who an entity's
 * audience is, written by Qloo. It is the most direct evidence in the whole
 * response that cultural data is doing work an LLM cannot: it is a measurement of
 * a population, not a plausible-sounding guess.
 *
 * Three rules shape this module, and they are the reason it is separate code
 * rather than a field read at the call site:
 *
 *  1. **Only Qloo's own words are shown as evidence.** Cue never writes an
 *     audience description itself. If Qloo returns nothing, the brief says so
 *     rather than filling the gap with an invented profile.
 *  2. **Source and interpretation are labelled separately.** The Qloo sentence is
 *     quoted and attributed; anything Cue derives from it is marked as Cue's
 *     reading. A reader must be able to tell which is which without hovering.
 *  3. **No demographic is inferred.** The prose is not a statistically validated
 *     profile and is not presented as one. Cue does not extract an age, a gender
 *     or a preference from it.
 */

/** One anchor entity's Qloo-authored audience description, verbatim. */
export interface AudienceEvidence {
  /** The anchor as the brief named it, e.g. "Drive". */
  anchor: string;
  /** The resolved Qloo entity id. */
  entityId: string;
  /** The entity's display name as Qloo returns it, which can differ from the brief. */
  entityName: string;
  /** The Qloo entity type, e.g. "urn:entity:movie". */
  entityType: string;
  /** Qloo's `audience_identity` prose, verbatim and unedited. */
  audienceIdentity: string;
}

export interface AudienceBrief {
  /**
   * Whether any anchor carried a Qloo-authored audience description. When false,
   * `evidence` is empty and the UI must not imply a profile exists.
   */
  available: boolean;
  evidence: AudienceEvidence[];
  /**
   * Cue's own one-line reading of the evidence, kept separate from Qloo's text.
   * Null when there is nothing to read. This is interpretation, and is labelled
   * as such wherever it is shown.
   */
  interpretation: string | null;
  /**
   * Anchors that resolved to an entity but carried no audience description.
   * Reported so "no evidence" is never confused with "the anchor did not exist".
   */
  anchorsWithoutEvidence: string[];
  /** Anchors named in the brief that did not resolve to a Qloo entity at all. */
  anchorsUnresolved: string[];
  /**
   * True when the brief named no anchors, so there was nothing to measure. This is
   * distinct from `available === false` with anchors present: one is an empty
   * brief, the other is a data gap.
   */
  noAnchors: boolean;
}

/** Qloo returns the field as a non-empty string, or it is absent. Treat blank as absent. */
function readAudienceIdentity(properties: Record<string, unknown> | undefined): string | null {
  const value = properties?.audience_identity;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build the brief from the anchors the pipeline already resolved.
 *
 * This deliberately takes the resolved entities rather than fetching them: the
 * `audience_identity` field arrives on the `/v2/search` response that resolves
 * the anchors, so the whole brief costs zero additional API calls. Spending a
 * call to re-fetch a field that is already in hand would be the wrong trade on a
 * rate-limited key.
 *
 * Anchors are matched to entities by name rather than by position, because
 * `resolveAnchors` drops anchors that fail to resolve — so the nth resolved
 * entity is not necessarily the nth named anchor, and a positional match would
 * label one anchor's audience with another's name.
 */
export function buildAudienceBrief(
  namedAnchors: string[],
  resolved: SearchResult[],
): AudienceBrief {
  const evidence: AudienceEvidence[] = [];
  const anchorsWithoutEvidence: string[] = [];
  const claimed = new Set<string>();

  for (const entity of resolved) {
    const anchor = matchAnchor(entity.name, namedAnchors) ?? entity.name;
    claimed.add(anchor);
    const identity = readAudienceIdentity(entity.properties);
    if (identity) {
      evidence.push({
        anchor,
        entityId: entity.entity_id,
        entityName: entity.name,
        entityType: entity.type || entity.subtype || "",
        audienceIdentity: identity,
      });
    } else {
      anchorsWithoutEvidence.push(anchor);
    }
  }

  // A named anchor is unresolved only if no resolved entity matched it. Comparing
  // against the claimed set keeps "Drive" from being reported as unresolved just
  // because Qloo returns it as "Drive (2011)".
  const unresolved = namedAnchors
    .slice(0, 6)
    .filter((named) => !claimed.has(named) && !matchesAny(named, resolved));

  return {
    available: evidence.length > 0,
    evidence,
    interpretation: interpret(evidence),
    anchorsWithoutEvidence,
    anchorsUnresolved: unresolved,
    noAnchors: namedAnchors.length === 0,
  };
}

/**
 * The brief's spelling of an anchor that resolved to `entityName`.
 *
 * Qloo returns display names that carry qualifiers the brief does not ("Drive
 * (2011)"), so an exact comparison misses. Containment either way is enough to
 * recognise the pair, and the longest match wins so "Lost in Translation" is not
 * claimed by an anchor named "Lost".
 */
function matchAnchor(entityName: string, namedAnchors: string[]): string | null {
  const entity = entityName.toLowerCase();
  const candidates = namedAnchors.filter((named) => {
    const needle = named.toLowerCase();
    return needle.length > 1 && (entity.includes(needle) || needle.includes(entity));
  });
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function matchesAny(named: string, resolved: SearchResult[]): boolean {
  return resolved.some((entity) => matchAnchor(entity.name, [named]) !== null);
}

/**
 * Cue's own reading of the evidence — never a restatement, and never a claim the
 * data does not support.
 *
 * The useful thing a supervisor can take from several Qloo descriptions is where
 * the anchors *agree*: if a film and an artist describe overlapping audiences,
 * that overlap is the taste profile the scene can rely on. So the reading counts
 * shared vocabulary rather than paraphrasing each sentence, and stays silent
 * unless at least two anchors are available to compare.
 */
function interpret(evidence: AudienceEvidence[]): string | null {
  if (evidence.length === 0) return null;
  if (evidence.length === 1) {
    return `One anchor carries a Qloo audience description, so this is that entity's measured audience rather than a profile of the scene.`;
  }

  const shared = sharedSignals(evidence);
  if (shared.length === 0) {
    return `The anchors' audiences do not share obvious vocabulary in Qloo's descriptions, so the scene's profile is the union of them rather than a single coherent audience.`;
  }
  return `Across ${evidence.length} anchors, Qloo's descriptions agree on ${listPhrase(shared)}, which is the audience this scene can rely on.`;
}

/**
 * Vocabulary shared across *all* evidence sentences.
 *
 * Deliberately a plain keyword overlap rather than anything that reads as a
 * measurement: the output is a phrase a person can check against the quotes
 * above it, not a score. Words that appear in nearly every Qloo description
 * ("people", "drawn", "who", "value") carry no signal and are dropped.
 */
const STOPWORDS = new Set([
  "people", "who", "that", "with", "this", "drawn", "value", "values", "their",
  "them", "they", "and", "the", "for", "from", "into", "over", "more", "most",
  "such", "than", "then", "when", "which", "while", "about", "also", "have",
  "like", "likely", "favor", "favour", "enjoy", "enjoys", "prefer", "prefers",
  "listeners", "viewers", "audience", "audiences", "consumers", "fans",
]);

function sharedSignals(evidence: AudienceEvidence[]): string[] {
  const perAnchor = evidence.map((entry) => {
    const words = entry.audienceIdentity
      .toLowerCase()
      .replace(/[^a-z\s-]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !STOPWORDS.has(word));
    return new Set(words);
  });

  const [first, ...rest] = perAnchor;
  const shared = [...first].filter((word) => rest.every((set) => set.has(word)));
  // Alphabetical, not by frequency: a frequency order would read like a ranking,
  // and this is a list of shared vocabulary, not a measured quantity.
  return shared.sort().slice(0, 6);
}

function listPhrase(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
