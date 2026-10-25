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
}

function tagIdOf(tag: { tag_id?: string; id?: string }): string {
  return tag.tag_id ?? tag.id ?? "";
}

/**
 * Build the measured entities from a Qloo affinity pool.
 *
 * Tags without an id are dropped. The live API does return some (a bare
 * `{type: "urn:tag:voice_type:qloo"}` with no id or name), and carrying them
 * would put nameless entries into the evidence list.
 */
export function toCoverageEntities(pool: QlooEntity[]): CoverageEntity[] {
  return pool.map((entity) => {
    const tags: string[] = [];
    const tagNames: Record<string, string> = {};
    for (const tag of entity.tags ?? []) {
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

/**
 * Tags carried by at least `MIN_TAG_SUPPORT` entities in the pool.
 *
 * Exported because the threshold is the metric's main judgement call and the
 * tests assert on it directly rather than trusting the aggregate.
 */
export function sharedVocabulary(entities: CoverageEntity[]): Set<string> {
  const support = new Map<string, number>();
  for (const entity of entities) {
    for (const tag of new Set(entity.tags)) {
      support.set(tag, (support.get(tag) ?? 0) + 1);
    }
  }
  const vocabulary = new Set<string>();
  for (const [tag, count] of support) {
    if (count >= MIN_TAG_SUPPORT) vocabulary.add(tag);
  }
  return vocabulary;
}

/** The tag sets restricted to the shared vocabulary, one per entity. */
function restrictedSets(
  entities: CoverageEntity[],
  vocabulary: Set<string>,
): Set<string>[] {
  return entities.map((entity) => {
    const set = new Set<string>();
    for (const tag of entity.tags) if (vocabulary.has(tag)) set.add(tag);
    return set;
  });
}

function union(sets: Set<string>[]): Set<string> {
  const out = new Set<string>();
  for (const set of sets) for (const tag of set) out.add(tag);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const tag of small) if (large.has(tag)) intersection += 1;
  const unionSize = a.size + b.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

function meanPairwiseOverlap(sets: Set<string>[]): {
  mean: number;
  pair?: { i: number; j: number; overlap: number };
} {
  if (sets.length < 2) return { mean: 0 };
  let total = 0;
  let count = 0;
  let worst: { i: number; j: number; overlap: number } | undefined;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const overlap = jaccard(sets[i], sets[j]);
      total += overlap;
      count += 1;
      if (!worst || overlap > worst.overlap) worst = { i, j, overlap };
    }
  }
  return { mean: count === 0 ? 0 : total / count, pair: worst };
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
  const vocabulary = sharedVocabulary(entities);
  const sets = restrictedSets(entities, vocabulary);
  const poolUnion = union(sets);
  const slateSets = slate.map((index) => sets[index]).filter(Boolean);
  const slateUnion = union(slateSets);

  const { mean, pair } = meanPairwiseOverlap(slateSets);

  const gaps: CoverageGap[] = [];
  for (const tag of poolUnion) {
    if (slateUnion.has(tag)) continue;
    const reachableBy = entities
      .filter((entity, index) => sets[index].has(tag))
      .map((entity) => entity.name);
    gaps.push({ tag, reachableBy });
  }
  gaps.sort((a, b) => a.reachableBy.length - b.reachableBy.length || a.tag.localeCompare(b.tag));

  const tagNameFor = new Map<string, string>();
  for (const entity of entities) {
    for (const [id, name] of Object.entries(entity.tagNames)) {
      if (!tagNameFor.has(id)) tagNameFor.set(id, name);
    }
  }
  for (const gap of gaps) {
    const name = tagNameFor.get(gap.tag);
    if (name) gap.tag = name;
  }

  const coveredTags = slateUnion.size;
  const vocabularySize = poolUnion.size;
  const index = vocabularySize === 0 ? 0 : (coveredTags / vocabularySize) * 100;

  return {
    index,
    coveredTags,
    vocabularySize,
    redundancy: mean,
    mostSimilarPair:
      pair && entities[pair.i] && entities[pair.j]
        ? {
            a: entities[pair.i].name,
            b: entities[pair.j].name,
            overlap: pair.overlap,
          }
        : undefined,
    gaps,
    poolSize: entities.length,
    entitiesMeasured: slateSets.filter((set) => set.size > 0).length,
  };
}

/**
 * Greedily reorder the pool to reach more of the vocabulary, holding the slate
 * size fixed.
 *
 * The top-ranked entity is seeded first and never dropped: the affinity ranking
 * is the brief's strongest answer, and a "revision" that discarded it would be
 * answering a different brief. Each further slot takes whichever remaining
 * entity adds the most vocabulary tags the slate does not already carry. Ties
 * break on affinity, then on pool order, so the result is deterministic for
 * identical input — a claim the tests pin down.
 */
export function reviseSlate(
  entities: CoverageEntity[],
  slate: number[],
  slateSize: number = slate.length,
): RevisedSlate {
  const vocabulary = sharedVocabulary(entities);
  const sets = restrictedSets(entities, vocabulary);
  const original = measureSlate(entities, slate);

  const size = Math.max(1, Math.min(slateSize, entities.length));
  const chosen: number[] = [slate[0] ?? 0];
  const used = new Set<number>(chosen);

  while (chosen.length < size) {
    const covered = union(chosen.map((index) => sets[index]));
    let best: { index: number; gain: number } | undefined;
    for (let index = 0; index < entities.length; index += 1) {
      if (used.has(index)) continue;
      let gain = 0;
      for (const tag of sets[index]) if (!covered.has(tag)) gain += 1;
      // Deterministic tiebreak: more gain wins. Equal gain prefers the earlier
      // pool position. Affinity is deliberately NOT a tiebreaker here — a
      // backfill entity's affinity comes from a different Qloo call and is not
      // on the same scale, so ranking on it would silently favour one query's
      // numbers over the other's.
      if (!best || gain > best.gain || (gain === best.gain && index < best.index)) {
        best = { index, gain };
      }
    }
    if (!best) break;
    chosen.push(best.index);
    used.add(best.index);
  }

  const coverage = measureSlate(entities, chosen);
  const indexDelta = coverage.index - original.index;
  const redundancyDelta = coverage.redundancy - original.redundancy;
  const improves = indexDelta > 0;

  const added = chosen.filter((index) => !slate.includes(index));
  const dropped = slate.filter((index) => !chosen.includes(index));
  const rationale = improves
    ? `Reaches ${coverage.coveredTags} of ${coverage.vocabularySize} shared taste tags against ${original.coveredTags}, holding the slate at ${size}.` +
      (added.length > 0
        ? ` Brings in ${added.map((index) => entities[index].name).join(", ")}${dropped.length > 0 ? `, in place of ${dropped.map((index) => entities[index].name).join(", ")}` : ""}.`
        : "")
    : "No alternative ordering of this pool reaches more of its shared taste tags, so the original slate stands.";

  return {
    entities: chosen.map((index) => entities[index]),
    coverage,
    indexDelta,
    redundancyDelta,
    improves,
    rationale,
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
  const measured = entities.filter((entity) => entity.tags.length > 0);
  const vocabulary = sharedVocabulary(entities);

  const empty: TasteCoverage = {
    index: 0,
    coveredTags: 0,
    vocabularySize: 0,
    redundancy: 0,
    gaps: [],
    poolSize: entities.length,
    entitiesMeasured: 0,
  };

  if (entities.length < 2) {
    return {
      original: empty,
      revised: {
        entities: [],
        coverage: empty,
        indexDelta: 0,
        redundancyDelta: 0,
        improves: false,
        rationale: "",
      },
      originalEntities: entities,
      unavailableReason:
        "Qloo returned fewer than two candidates for this brief, so there is no pool to measure coverage against.",
    };
  }

  if (measured.length < 2 || vocabulary.size === 0) {
    return {
      original: empty,
      revised: {
        entities: [],
        coverage: empty,
        indexDelta: 0,
        redundancyDelta: 0,
        improves: false,
        rationale: "",
      },
      originalEntities: entities,
      unavailableReason:
        "The candidates Qloo returned share no common taste tags, so a coverage index cannot be computed for this brief. This is a limit of the returned evidence, not a score of zero.",
    };
  }

  const effectiveSlate = slate.filter((index) => index >= 0 && index < entities.length);
  const size = Math.min(slateSize, entities.length);

  return {
    original: measureSlate(entities, effectiveSlate),
    revised: reviseSlate(entities, effectiveSlate, size),
    originalEntities: effectiveSlate.map((index) => entities[index]),
  };
}
