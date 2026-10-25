/**
 * The Taste Gap: measure how much of a scene's available taste space a slate
 * actually reaches, and show what a better-balanced slate would reach instead.
 *
 * Why this is a Qloo feature and not an LLM one. A language model can tell you
 * that Massive Attack and Tricky are both trip-hop. It cannot tell you which
 * taste tags each one carries, nor how many of those tags the *other* picks in
 * the slate already cover. That measurement is the whole product: the question
 * is not "is this a good song", it is "does this slate reach the room, or does
 * it reach the same corner of the room eight times".
 *
 * The metric is deliberately built only from data the pipeline already has.
 * `groundArtistCues` calls `/v2/insights` with `feature.explainability=true`,
 * and each returned entity carries its own `tags[]`. Live probing confirmed
 * those tags are a superset of what `/v2/analysis/compare` reports for the same
 * entity (44 tags vs 27 for the same artist, compare ⊆ insights, no exceptions
 * across three anchors). So every number below is computed from the affinity
 * response the sheet already depends on. This feature adds zero API calls.
 *
 * Two things this metric is NOT, because the API does not support them and
 * inventing them would be the exact failure this product exists to catch:
 *
 *  - It is not an audience share. The denominator is the union of tags across
 *    the returned candidate pool, not a listener count and not a population.
 *    The API returns no audience size, so no listener figure can be derived.
 *  - It is not a count of taste clusters. Grouping entities into "clusters"
 *    would need a documented clustering method and a defensible k; tag overlap
 *    does not supply either. We report overlap, not clusters.
 */

import type { QlooEntity } from "./types";
import {
  auditCoverage,
  auditSelection,
  measurableDimensions,
  reviseSelection,
  type AuditEntity,
  type AuditSelectionResult,
} from "./audit";

/**
 * How many candidates the affinity call returns. The same value
 * `groundArtistCues` requests, and the pool the index is measured against.
 */
export const POOL_SIZE = 14;

/**
 * A tag must appear on at least this many pool entities to count toward the
 * vocabulary.
 *
 * This threshold is load-bearing, not cosmetic. Live measurement showed the raw
 * tag count per entity ranges from 44 to 100 *within a single pool*, and that
 * tracks how richly Qloo has catalogued the artist rather than how broad their
 * cultural reach is. Ranking on the raw universe made the optimiser simply pick
 * the entities with the most metadata — the picks were Bonobo (100 tags), GusGus
 * (95) and Yppah (86), i.e. it was measuring catalogue completeness and calling
 * it coverage. Restricting the vocabulary to tags shared by two or more entities
 * drops the one-off descriptive tags that inflate a well-catalogued entity, so
 * the index reflects common cultural ground instead of metadata volume.
 */
export const MIN_TAG_SUPPORT = 2;

/** The label shown wherever the index appears, so it is never read as a share. */
export const COVERAGE_LABEL = "Tag Coverage Index";

export interface CoverageEntity {
  entityId: string;
  name: string;
  /** Qloo affinity against the brief, when the response supplied one. */
  affinity: number;
  /** Where `affinity` came from, so a popularity fallback is never shown as measured affinity. */
  affinitySource?: "query" | "popularity";
  /**
   * True when this candidate came from the cross-domain backfill query rather
   * than the primary affinity call. The two are separate Qloo calls, so their
   * affinity numbers are not comparable; the panel labels such a pick instead of
   * ranking on a number that means something different.
   */
  backfill?: boolean;
  /** Every tag the entity carried, as Qloo tag ids. Restriction to the shared vocabulary happens in measurement. */
  tags: string[];
  /**
   * Tag id to display name, for the evidence list. A map rather than a parallel
   * array because tags without a name are dropped during normalisation, which
   * would desynchronise any index-based pairing.
   */
  tagNames: Record<string, string>;
}

export interface CoverageGap {
  /** Tag name the original slate does not reach but the pool does. */
  tag: string;
  /** Pool entities carrying it — the evidence that the gap is reachable. */
  reachableBy: string[];
}

export interface TasteCoverage {
  /**
   * The index, 0..100. Percentage of the pool's shared-vocabulary tags that the
   * slate's entities collectively carry. An internal index, not a share of people.
   */
  index: number;
  /** Distinct vocabulary tags the slate carries. */
  coveredTags: number;
  /** Distinct vocabulary tags across the whole pool — the denominator. */
  vocabularySize: number;
  /**
   * Mean pairwise Jaccard overlap of the slate's tag sets, 0..1. High means the
   * picks share most of their taste tags: the slate is concentrated.
   */
  redundancy: number;
  /** The pair driving `redundancy`, named so the claim is checkable. */
  mostSimilarPair?: { a: string; b: string; overlap: number };
  /** Vocabulary tags the pool reaches that the slate does not. */
  gaps: CoverageGap[];
  /** Number of pool entities the index was measured over. */
  poolSize: number;
  /** Slate entities that contributed at least one vocabulary tag. */
  entitiesMeasured: number;
  /**
   * The full structured measurement from the generic audit engine. The fields
   * above are the music-facing names for the same numbers; this carries the
   * domain-agnostic shape (numerator, denominator, covered/uncovered dimensions,
   * warnings, validity) so a caller can inspect the evidence directly.
   */
  audit: AuditSelectionResult;
}

export interface RevisedSlate {
  /** Entities in the revised order. The first is always the original top pick. */
  entities: CoverageEntity[];
  coverage: TasteCoverage;
  /**
   * Signed change in the index against the original slate. Only positive values
   * are an improvement; zero or negative must be reported as such.
   */
  indexDelta: number;
  /** Signed change in redundancy. Negative is a better spread. */
  redundancyDelta: number;
  /** True only when the index strictly improved. */
  improves: boolean;
  /** Vocabulary tags the revision reaches that the original slate did not. */
  newlyCovered: string[];
  /** One line naming what the revision traded, for the UI. */
  rationale: string;
}

export interface TasteGapResult {
  original: TasteCoverage;
  revised: RevisedSlate;
  /** The original slate's entities, for the side-by-side. */
  originalEntities: CoverageEntity[];
  /**
   * Why no measurement is available, when that is the case. The panel must show
   * this instead of a number.
   */
  unavailableReason?: string;
  /**
   * Evidence-integrity warnings raised while measuring: indices outside the
   * pool, a pool with no shared vocabulary, and so on. A non-empty list does not
   * by itself mean the measurement is wrong, but the UI must not present a
   * measurement with warnings as unqualified.
   */
  warnings: string[];
}

function tagIdOf(tag: { tag_id?: string; id?: string }): string {
  return tag.tag_id ?? tag.id ?? "";
}

/**
 * Build the measured entities from a Qloo affinity pool.
 *
 * Tags without an id are dropped. The live API does return some (a bare
 * `{type: "urn:tag:voice_type:qloo"}` with no id or name), and carrying them
 * would put nameless entries into the evidence list. Null and non-object entries
 * are dropped for the same reason: the array comes off the wire, and one null
 * must not take the whole measurement down.
 */
export function toCoverageEntities(pool: QlooEntity[]): CoverageEntity[] {
  return (pool ?? []).map((entity) => {
    const tags: string[] = [];
    const tagNames: Record<string, string> = {};
    const rawTags = Array.isArray(entity?.tags) ? entity.tags : [];
    for (const tag of rawTags) {
      if (!tag || typeof tag !== "object") continue;
      const id = tagIdOf(tag);
      if (!id) continue;
      if (!tags.includes(id)) tags.push(id);
      if (tag.name && !tagNames[id]) tagNames[id] = tag.name;
    }
    return {
      entityId: entity.entity_id,
      name: entity.name,
      affinity: entity.affinity ?? 0,
      affinitySource: entity.affinitySource,
      backfill: entity.backfill,
      tags,
      tagNames,
    };
  });
}

/** The generic-engine view of a measured entity: tags become dimensions. */
function toAuditEntity(entity: CoverageEntity): AuditEntity {
  return {
    entityId: entity.entityId,
    name: entity.name,
    dimensions: entity.tags,
  };
}

/**
 * Tags carried by at least `MIN_TAG_SUPPORT` entities in the pool.
 *
 * Delegates to the engine so the support rule has one implementation. The
 * engine counts distinct entities, so the same entity appearing twice in the
 * pool cannot promote a one-off tag into the vocabulary.
 *
 * Exported because the threshold is the metric's main judgement call and the
 * tests assert on it directly rather than trusting the aggregate.
 */
export function sharedVocabulary(entities: CoverageEntity[]): Set<string> {
  return measurableDimensions(entities.map(toAuditEntity), MIN_TAG_SUPPORT);
}

/** Project an engine result into the music-facing shape the UI consumes. */
function toTasteCoverage(
  result: AuditSelectionResult,
  entities: CoverageEntity[],
  slate: number[],
): TasteCoverage {
  // Gap tags are reported as display names where one is known, because the panel
  // shows them to a reader. The engine deals in ids only.
  const tagNameFor = new Map<string, string>();
  for (const entity of entities) {
    for (const [id, name] of Object.entries(entity.tagNames)) {
      if (!tagNameFor.has(id)) tagNameFor.set(id, name);
    }
  }

  const gaps: CoverageGap[] = result.uncoveredDimensions.map((tag) => ({
    tag: tagNameFor.get(tag) ?? tag,
    reachableBy: entities
      .filter((entity) => entity.tags.includes(tag))
      .map((entity) => entity.name),
  }));
  // Rarest first: a tag few picks could reach is the more actionable gap. Ties
  // fall back to the tag name so the order is stable across runs.
  gaps.sort((a, b) => a.reachableBy.length - b.reachableBy.length || a.tag.localeCompare(b.tag));

  return {
    index: result.score,
    coveredTags: result.numerator,
    vocabularySize: result.denominator,
    redundancy: result.redundancy,
    mostSimilarPair: result.mostSimilarPair,
    gaps,
    poolSize: result.poolSize,
    entitiesMeasured: result.entitiesMeasured,
    audit: result,
  };
}

/**
 * The sentence explaining what the revision did, shared by both entry points so
 * the wording has one implementation and cannot drift between them.
 *
 * `slateSize` is the size the revision was held to, which the caller knows and
 * the coverage result does not.
 */
function buildRationale(
  entities: CoverageEntity[],
  original: TasteCoverage,
  coverage: TasteCoverage,
  chosen: number[],
  effective: number[],
  slateSize: number,
  improves: boolean,
): string {
  if (!improves) {
    return "No alternative ordering of this pool reaches more of its shared taste tags, so the original slate stands.";
  }
  const added = chosen.filter((index) => !effective.includes(index));
  const dropped = effective.filter((index) => !chosen.includes(index));
  const swap =
    added.length > 0
      ? ` Brings in ${added.map((index) => entities[index].name).join(", ")}${
          dropped.length > 0
            ? `, in place of ${dropped.map((index) => entities[index].name).join(", ")}`
            : ""
        }.`
      : "";
  return (
    `Reaches ${coverage.coveredTags} of ${coverage.vocabularySize} shared taste tags against ` +
    `${original.coveredTags}, holding the slate at ${slateSize}.${swap}`
  );
}

/**
 * Measure one slate against the pool it was drawn from.
 *
 * `slate` is a list of indices into `entities`, so the caller can compare the
 * original selection and a revised one with the identical function. That is what
 * makes the before/after comparison like-for-like.
 */
export function measureSlate(
  entities: CoverageEntity[],
  slate: number[],
): TasteCoverage {
  const audit = auditSelection(entities.map(toAuditEntity), slate, {
    minSupport: MIN_TAG_SUPPORT,
  });
  return toTasteCoverage(audit, entities, slate);
}

/**
 * Greedily reorder the pool to reach more of the vocabulary, holding the slate
 * size fixed.
 *
 * The top-ranked entity is seeded first and never dropped: the affinity ranking
 * is the brief's strongest answer, and a "revision" that discarded it would be
 * answering a different brief. Each further slot takes whichever remaining
 * entity adds the most vocabulary tags the slate does not already carry. Ties
 * break on pool order, so the result is deterministic for identical input — a
 * claim the tests pin down. Affinity is deliberately not a tiebreaker: a
 * backfill entity's affinity comes from a different Qloo call and is not on the
 * same scale, so ranking on it would silently favour one query over the other.
 */
export function reviseSlate(
  entities: CoverageEntity[],
  slate: number[],
  slateSize: number = slate.length,
): RevisedSlate {
  const auditEntities = entities.map(toAuditEntity);
  const original = measureSlate(entities, slate);

  const effective = slate.filter((index) => index >= 0 && index < entities.length);
  const size = Math.max(1, Math.min(slateSize, entities.length));
  const revision = reviseSelection(auditEntities, effective, {
    minSupport: MIN_TAG_SUPPORT,
  }, size);

  const chosen = revision.selection;
  const coverage = toTasteCoverage(revision.result, entities, chosen);
  const indexDelta = coverage.index - original.index;
  const redundancyDelta = coverage.redundancy - original.redundancy;
  const improves = indexDelta > 0;

  return {
    entities: chosen.map((index) => entities[index]),
    coverage,
    indexDelta,
    redundancyDelta,
    improves,
    newlyCovered: revision.newlyCovered,
    rationale: buildRationale(entities, original, coverage, chosen, effective, size, improves),
  };
}

/**
 * The whole feature for one brief: measure the slate, propose a revision, and
 * report both with the same metric.
 *
 * Returns an explicit unavailable state rather than a number when the pool is
 * too small or too sparse to measure. A fabricated zero would read as "this
 * slate reaches nothing", which is a different and false claim.
 */
export function computeTasteGap(
  pool: QlooEntity[],
  slate: number[],
  slateSize: number = slate.length,
): TasteGapResult {
  const entities = toCoverageEntities(pool);

  const result = auditCoverage({
    entities: entities.map(toAuditEntity),
    selection: slate,
    options: { minSupport: MIN_TAG_SUPPORT },
    reviseTo: Math.min(slateSize, entities.length),
  });

  const original = toTasteCoverage(result.original, entities, slate);
  const effective = slate.filter((index) => index >= 0 && index < entities.length);
  const revisedCoverage = toTasteCoverage(result.revised.result, entities, result.revised.selection);

  const indexDelta = revisedCoverage.index - original.index;
  const redundancyDelta = revisedCoverage.redundancy - original.redundancy;
  const improves = indexDelta > 0;

  return {
    original,
    revised: {
      entities: result.revised.selection.map((index) => entities[index]),
      coverage: revisedCoverage,
      indexDelta,
      redundancyDelta,
      improves,
      newlyCovered: result.revised.newlyCovered,
      rationale: result.valid
        ? buildRationale(
            entities,
            original,
            revisedCoverage,
            result.revised.selection,
            effective,
            result.revised.selection.length,
            improves,
          )
        : "",
    },
    originalEntities: effective.map((index) => entities[index]),
    unavailableReason: result.unavailableReason,
    // Warnings from both measurements, de-duplicated: the engine raises the
    // out-of-range and no-vocabulary notices, and the panel must be able to show
    // them rather than presenting a flagged measurement as clean.
    warnings: [...new Set([...original.audit.warnings, ...revisedCoverage.audit.warnings])],
  };
}
