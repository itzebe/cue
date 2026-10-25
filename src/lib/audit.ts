/**
 * The coverage audit engine.
 *
 * Domain-agnostic on purpose. The question it answers is not musical: given a
 * set of measured dimensions, a candidate pool, and a selection drawn from that
 * pool, how much of the measurable space does the selection actually reach?
 *
 * The music supervisor is one caller. Nothing here knows what a "cue sheet" is:
 * a caller supplies dimensions, entities, the dimension ids each entity carries,
 * and which entities were selected. `coverage.ts` is the music adapter.
 *
 * Design constraints that come from the product, not from taste:
 *
 *  - The denominator is the union of *measurable* dimensions across the pool the
 *    caller supplies. It is not a population, a listener count, or a share of
 *    anything wider than the pool. Every caller must surface that boundary.
 *  - Dimensions are weighted equally unless the caller passes explicit weights.
 *    Equal weighting is the default because an unweighted index is the only one
 *    the evidence supports without a documented reason to prefer one dimension.
 *  - A dimension counts as covered when at least one selected entity carries it.
 *  - Duplicates never inflate a count. A repeated dimension on one entity, or a
 *    repeated entity in the pool, contributes once: two copies are not two
 *    independent pieces of evidence.
 *  - Nothing is fabricated. When the evidence cannot support a measurement the
 *    result is marked invalid with a reason, never a zero score.
 */

export interface AuditEntity {
  entityId: string;
  name: string;
  /** Measured dimension ids this entity carries. Duplicates are ignored. */
  dimensions: string[];
}

export interface AuditOptions {
  /**
   * A dimension must appear on at least this many *distinct* entities to count
   * toward the measurable vocabulary. Default 2.
   *
   * This is not cosmetic. A raw dimension count tracks how richly a source
   * catalogued an entity rather than how broad its reach is, so an unthresholded
   * index rewards the best-documented entities and calls it coverage.
   */
  minSupport?: number;
  /**
   * Explicit dimension weights. Omitted means equal weighting, which is the
   * default and the only setting the evidence supports without a stated reason.
   */
  weights?: Record<string, number>;
}

export interface AuditSelectionResult {
  /** Distinct measurable dimensions the selection carries. */
  numerator: number;
  /** Distinct measurable dimensions across the pool — the denominator. */
  denominator: number;
  /** `numerator / denominator * 100`, 0 when there is nothing to measure. */
  score: number;
  coveredDimensions: string[];
  uncoveredDimensions: string[];
  /** Mean pairwise Jaccard overlap of the selection's dimension sets, 0..1. */
  redundancy: number;
  /** The pair driving `redundancy`, named so the claim is checkable. */
  mostSimilarPair?: { a: string; b: string; overlap: number };
  /** Missing or invalid evidence encountered while measuring. */
  warnings: string[];
  /** True only when the evidence was sufficient to produce a real measurement. */
  valid: boolean;
  poolSize: number;
  /** Selected entities that contributed at least one measurable dimension. */
  entitiesMeasured: number;
  /** How the score was weighted, so a reader never has to guess. */
  weightsUsed: "equal" | Record<string, number>;
}

export interface AuditRevision {
  /** Indices into the pool, in the revised order. */
  selection: number[];
  result: AuditSelectionResult;
  /** Dimensions the revision reaches that the original selection did not. */
  newlyCovered: string[];
  /** Signed change in score. Only positive values are an improvement. */
  delta: number;
  /** True only when the score strictly improved. */
  improves: boolean;
}

export interface AuditInput {
  entities: AuditEntity[];
  selection: number[];
  options?: AuditOptions;
  /** Slate size to hold during revision. Defaults to the selection's length. */
  reviseTo?: number;
}

export interface AuditResult {
  original: AuditSelectionResult;
  revised: AuditRevision;
  /** True only when both measurements are valid and comparable. */
  valid: boolean;
  /** Why no measurement is available, when that is the case. */
  unavailableReason?: string;
}

const DEFAULT_MIN_SUPPORT = 2;

/**
 * Dimensions carried by at least `minSupport` distinct entities.
 *
 * Entities are de-duplicated by id first: the same entity returned twice is one
 * piece of evidence, not two, and counting it twice would promote a one-off
 * dimension into the vocabulary.
 *
 * Dimensions must be non-empty strings. The input arrives from an API response,
 * so a null, a number or a blank id is dropped rather than counted — a
 * malformed dimension must not be able to join the vocabulary, and it must not
 * throw either.
 */
export function measurableDimensions(
  entities: AuditEntity[],
  minSupport: number = DEFAULT_MIN_SUPPORT,
): Set<string> {
  const support = new Map<string, number>();
  const seen = new Set<string>();
  for (const entity of entities) {
    if (!entity || seen.has(entity.entityId)) continue;
    seen.add(entity.entityId);
    const dimensions = Array.isArray(entity.dimensions) ? entity.dimensions : [];
    for (const dimension of new Set(dimensions)) {
      if (typeof dimension !== "string" || dimension.length === 0) continue;
      support.set(dimension, (support.get(dimension) ?? 0) + 1);
    }
  }
  const measurable = new Set<string>();
  for (const [dimension, count] of support) {
    if (count >= minSupport) measurable.add(dimension);
  }
  return measurable;
}

function restrictedSet(entity: AuditEntity, measurable: Set<string>): Set<string> {
  const set = new Set<string>();
  const dimensions = Array.isArray(entity?.dimensions) ? entity.dimensions : [];
  for (const dimension of dimensions) {
    if (typeof dimension === "string" && measurable.has(dimension)) set.add(dimension);
  }
  return set;
}

function unionOf(sets: Set<string>[]): Set<string> {
  const out = new Set<string>();
  for (const set of sets) for (const dimension of set) out.add(dimension);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const dimension of small) if (large.has(dimension)) intersection += 1;
  const unionSize = a.size + b.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

/** Mean pairwise overlap, with the indices returned *within the given array*. */
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

function scoreOf(
  covered: Set<string>,
  scope: Set<string>,
  weights: Record<string, number> | undefined,
): number {
  if (scope.size === 0) return 0;
  if (!weights) return (covered.size / scope.size) * 100;
  let coveredWeight = 0;
  let totalWeight = 0;
  for (const dimension of scope) {
    const weight = weights[dimension] ?? 1;
    totalWeight += weight;
    if (covered.has(dimension)) coveredWeight += weight;
  }
  return totalWeight === 0 ? 0 : (coveredWeight / totalWeight) * 100;
}

/**
 * Measure one selection against the pool it was drawn from.
 *
 * The selection is indices into `entities` so the caller can measure the
 * original and a revised selection with the identical function. That is what
 * makes a before/after comparison like-for-like rather than two different
 * calculations that happen to share a name.
 */
export function auditSelection(
  entities: AuditEntity[],
  selection: number[],
  options: AuditOptions = {},
): AuditSelectionResult {
  const minSupport = options.minSupport ?? DEFAULT_MIN_SUPPORT;
  const measurable = measurableDimensions(entities, minSupport);
  const warnings: string[] = [];

  const indices = selection.filter((index) => index >= 0 && index < entities.length);
  if (indices.length !== selection.length) {
    warnings.push(
      `${selection.length - indices.length} selected index(es) fell outside the pool and were ignored.`,
    );
  }

  const sets = indices.map((index) => restrictedSet(entities[index], measurable));
  const poolUnion = unionOf(entities.map((entity) => restrictedSet(entity, measurable)));
  const covered = unionOf(sets);
  const { mean, pair } = meanPairwiseOverlap(sets);

  // `pair.i` / `pair.j` index `sets`, i.e. the selection — not the pool. Reading
  // them against `entities` named the wrong entities entirely whenever the
  // selection was not a 0-based prefix, which is the normal case here.
  const pairEntities =
    pair && indices[pair.i] !== undefined && indices[pair.j] !== undefined
      ? { a: entities[indices[pair.i]].name, b: entities[indices[pair.j]].name }
      : undefined;

  const coveredDimensions = [...covered].sort();
  const uncoveredDimensions = [...poolUnion].filter((d) => !covered.has(d)).sort();

  const valid = poolUnion.size > 0;
  if (!valid) {
    warnings.push(
      "The pool shares no measurable dimensions, so a coverage score cannot be computed. This is a limit of the returned evidence, not a score of zero.",
    );
  }

  return {
    numerator: covered.size,
    denominator: poolUnion.size,
    score: scoreOf(covered, poolUnion, options.weights),
    coveredDimensions,
    uncoveredDimensions,
    redundancy: mean,
    mostSimilarPair: pairEntities ? { ...pairEntities, overlap: pair!.overlap } : undefined,
    warnings,
    valid,
    poolSize: entities.length,
    entitiesMeasured: sets.filter((set) => set.size > 0).length,
    weightsUsed: options.weights ? { ...options.weights } : "equal",
  };
}

/**
 * Greedily reorder the pool to reach more measurable dimensions, holding the
 * selection size fixed.
 *
 * The first selected entity is seeded and never dropped: it is the caller's
 * strongest answer, and a "revision" that discarded it would be answering a
 * different question. Each further slot takes whichever remaining entity adds
 * the most measurable dimensions the selection does not already carry. Ties
 * break on pool order so the result is deterministic for identical input.
 *
 * The revision is reported honestly: when no reordering improves the score,
 * `improves` is false and `delta` is zero or negative.
 */
export function reviseSelection(
  entities: AuditEntity[],
  selection: number[],
  options: AuditOptions = {},
  reviseTo?: number,
): AuditRevision {
  const minSupport = options.minSupport ?? DEFAULT_MIN_SUPPORT;
  const measurable = measurableDimensions(entities, minSupport);
  const sets = entities.map((entity) => restrictedSet(entity, measurable));
  const original = auditSelection(entities, selection, options);

  const effective = selection.filter((index) => index >= 0 && index < entities.length);
  const target = Math.max(1, Math.min(reviseTo ?? effective.length, entities.length));

  const chosen: number[] = effective.length > 0 ? [effective[0]] : [];
  const used = new Set<number>(chosen);

  while (chosen.length > 0 && chosen.length < target) {
    const covered = unionOf(chosen.map((index) => sets[index]));
    let best: { index: number; gain: number } | undefined;
    for (let index = 0; index < entities.length; index += 1) {
      if (used.has(index)) continue;
      let gain = 0;
      for (const dimension of sets[index]) if (!covered.has(dimension)) gain += 1;
      if (!best || gain > best.gain || (gain === best.gain && index < best.index)) {
        best = { index, gain };
      }
    }
    if (!best) break;
    chosen.push(best.index);
    used.add(best.index);
  }

  const result = auditSelection(entities, chosen, options);
  const delta = result.score - original.score;
  const newlyCovered = result.coveredDimensions.filter(
    (dimension) => !original.coveredDimensions.includes(dimension),
  );

  return {
    selection: chosen,
    result,
    newlyCovered,
    delta,
    improves: delta > 0,
  };
}

/**
 * The whole audit for one pool: measure the selection, propose a revision, and
 * report both with the same metric.
 *
 * Returns an explicit unavailable state rather than a number when the pool is
 * too small or too sparse to measure. A fabricated zero would read as "this
 * selection reaches nothing", which is a different and false claim.
 */
export function auditCoverage(input: AuditInput): AuditResult {
  const { entities, selection, options = {}, reviseTo } = input;

  const unavailable = (reason: string): AuditResult => ({
    original: auditSelection(entities, selection, options),
    revised: {
      selection: [],
      result: auditSelection(entities, [], options),
      newlyCovered: [],
      delta: 0,
      improves: false,
    },
    valid: false,
    unavailableReason: reason,
  });

  if (entities.length < 2) {
    return unavailable(
      "Fewer than two candidates were returned for this brief, so there is no pool to measure coverage against.",
    );
  }

  const measurable = measurableDimensions(entities, options.minSupport ?? DEFAULT_MIN_SUPPORT);
  if (measurable.size === 0) {
    return unavailable(
      "The candidates returned share no common measured dimensions, so a coverage score cannot be computed for this brief. This is a limit of the returned evidence, not a score of zero.",
    );
  }

  return {
    original: auditSelection(entities, selection, options),
    revised: reviseSelection(entities, selection, options, reviseTo),
    valid: true,
  };
}
