/**
 * Taste-grounded substitution.
 *
 * A ranked cue sheet tells a supervisor what the scene wants. It does not tell
 * them what to do when the answer is unaffordable, or when the label refuses.
 * Today that decision is a phone call and a guess. This module answers it with
 * measurement instead.
 *
 * The question is not "find a cheaper artist". Anyone can sort by price. The
 * question is "find the artist that serves THIS scene's audience, inside THIS
 * budget, and prove the audience actually carries over". That last clause is why
 * this cannot be an LLM feature: a language model knows Portishead and Massive
 * Attack are both trip-hop, but it has no measurement of whether Portishead's
 * audience is the same audience. Qloo does.
 *
 * Two Qloo capabilities carry the whole feature:
 *
 *   1. `filter.popularity.max` narrows the candidate pool to catalogues that can
 *      plausibly fit a budget. Popularity is the model's leverage proxy, so
 *      capping it is what makes affordability reachable at all. This is not
 *      optional: for a well-known anchor, Qloo returns a uniformly saturated
 *      popularity near 0.999, so an uncapped query cannot see anything cheap.
 *   2. `/v2/analysis/compare` measures the taste-tag overlap between the target
 *      artist and a candidate. That overlap is the evidence that the substitute
 *      serves the same room rather than merely sounding similar.
 */

import { compareGroups, insights, type TagSignal } from "./qloo";
import {
  DEFAULT_TERMS,
  popularityCeilingForBudget,
  quoteLicense,
  type LicenseQuote,
  type LicenseTerms,
} from "./rights";
import { explainCue, eraToYearFloor, type GroundingContext } from "./cues";
import type { Cue, QlooEntity, Receipt, SceneBrief } from "./types";

export interface SubstituteOption {
  id: string;
  artist: string;
  artistId: string;
  track: string;
  trackUnverified: boolean;
  image?: string;
  /** Qloo affinity for this artist against the same scene profile as the target. */
  affinity: number;
  popularity: number;
  fee: LicenseQuote["fee"];
  savings: number;
  savingsPct: number;
  clearance: Cue["clearance"];
  clearanceDays: number;
  momentum: number;
  /** True when a pricier option is at least as good on every axis. */
  dominated: boolean;
  why: string[];
  /** Shared taste tags with the target, strongest first. Populated for the pick. */
  sharedTaste: string[];
  /** Overlap ratio 0..1 against the target, when the comparison was run. */
  audienceOverlap?: number;
  audienceVerdict?: string;
}

export interface SubstitutionResult {
  /** The cue the supervisor wanted, with the price they cannot pay. */
  target: {
    id: string;
    artist: string;
    track: string;
    affinity: number;
    popularity: number;
    fee: LicenseQuote["fee"];
  };
  terms: LicenseTerms;
  budget: number;
  /**
   * The popularity ceiling the budget implies. Exposed because it is the actual
   * reasoning step: "your budget only supports catalogues up to this fame".
   */
  popularityCeiling: number;
  /** Why the search happened, in the supervisor's terms. */
  reason: string;
  options: SubstituteOption[];
  /**
   * The closest match inside budget — the best the scene can be for this money.
   * This is the recommendation, because Cue's thesis is that the scene comes
   * first and the saving is a consequence, not the goal.
   */
  pick: SubstituteOption | null;
  /**
   * The best saving that gives up little: the cheapest option whose audience fit
   * stays within a small margin of the closest match. Reported separately
   * because "spend the budget on the best match" and "save most of it and lose
   * almost nothing" are two different decisions, and a supervisor should be
   * shown both rather than have one chosen silently.
   */
  bestValue: SubstituteOption | null;
  /** What the pick saves against the target. */
  pickSaving: number;
  /** What the value option saves. Zero when there is no distinct value option. */
  valueSaving: number;
  summary: string;
  receipts: Receipt[];
  warnings: string[];
}

/** Reasons a supervisor reaches for a substitute. Each changes what we optimise. */
export type SubstitutionReason = "budget" | "clearance" | "exclusivity";

export interface SubstituteOptions {
  brief: SceneBrief;
  /** The cue to replace — normally the top-ranked one. */
  target: Cue;
  /**
   * The ceiling on the recommended fee. When omitted, the caller is asking
   * "what is cheaper than this at all", so the target's own fee is the ceiling.
   */
  budget?: number;
  terms?: LicenseTerms;
  reason?: SubstitutionReason;
  /** Shared receipts array so the sheet reports every call in one place. */
  receipts?: Receipt[];
  /** How many capped pools to search. Each is one Qloo call. */
  probes?: number;
}

/**
 * Popularity ceilings to probe, as fractions of the budget-implied ceiling.
 *
 * One call at exactly the ceiling returns only the priciest slice of what fits,
 * because Qloo ranks by affinity and affinity correlates with fame. Probing
 * below the ceiling is what surfaces the genuinely cheaper end of the frontier —
 * the picks a supervisor would otherwise never see. Three points was enough to
 * span the range in practice without turning the feature into a slow fan-out.
 */
const PROBE_FRACTIONS = [1, 0.72, 0.48];

function receiptFrom<T>(
  call: { ok: boolean; status: number; ms: number; data: T; params: Record<string, string>; error?: string },
  endpoint: string,
  label: string,
  note?: string,
): Receipt {
  return {
    endpoint,
    label,
    params: call.params,
    status: call.status,
    ms: call.ms,
    resultCount: Array.isArray(call.data) ? call.data.length : 0,
    note: call.error ? call.error : note,
  };
}

/** A short, honest name for what the supervisor is trying to solve. */
function reasonSentence(reason: SubstitutionReason, target: Cue, budget: number): string {
  const fee = quoteLicense(target, DEFAULT_TERMS).fee.recommended;
  switch (reason) {
    case "clearance":
      return `Clearing ${target.artist} is slow or contested. This looks for artists the same audience already loves that clear faster.`;
    case "exclusivity":
      return `${target.artist} is likely unavailable for this category or term. This looks for artists the same audience already loves that are still available.`;
    default:
      return budget < fee
        ? `${target.artist} prices at about $${fee.toLocaleString("en-US")}. This looks for artists the same audience already loves inside $${budget.toLocaleString("en-US")}.`
        : `This looks for artists the same audience already loves below ${target.artist}'s own price.`;
  }
}

/**
 * Mark options that a better option beats outright.
 *
 * A pick that costs more than another AND retains less affinity has no reason to
 * exist in the list: recommending it would be indefensible. Marking rather than
 * dropping keeps the frontier visible, which is the honest way to show a
 * supervisor that the search was thorough.
 */
function markDominated(options: SubstituteOption[]): void {
  for (const option of options) {
    // Only measured options can be compared: an unmeasured one has no audience
    // figure, and judging it on affinity would apply a different yardstick than
    // the one the list is ranked by.
    const overlap = option.audienceOverlap;
    if (overlap === undefined) {
      option.dominated = false;
      continue;
    }
    option.dominated = options.some(
      (other) =>
        other !== option &&
        other.audienceOverlap !== undefined &&
        other.fee.recommended <= option.fee.recommended &&
        other.audienceOverlap >= overlap &&
        (other.fee.recommended < option.fee.recommended || other.audienceOverlap > overlap),
    );
  }
}

/**
 * Find what else serves this scene inside a budget.
 *
 * Costs one Qloo call per probe, plus one comparison call for the pick. The
 * target is priced from the cue we already have, so establishing the target
 * itself costs nothing.
 */
export async function findSubstitutes(
  options: SubstituteOptions,
): Promise<SubstitutionResult> {
  const receipts = options.receipts ?? [];
  const warnings: string[] = [];
  const terms = options.terms ?? DEFAULT_TERMS;
  const reason = options.reason ?? "budget";
  const targetQuote = quoteLicense(options.target, terms);
  const budget = options.budget ?? targetQuote.fee.recommended;

  const target = {
    id: options.target.id,
    artist: options.target.artist,
    track: options.target.track,
    affinity: options.target.affinity,
    popularity: options.target.popularity,
    fee: targetQuote.fee,
  };

  const empty = (note: string): SubstitutionResult => ({
    target,
    terms,
    budget,
    popularityCeiling: 0,
    reason: reasonSentence(reason, options.target, budget),
    options: [],
    pick: null,
    bestValue: null,
    pickSaving: 0,
    valueSaving: 0,
    summary: note,
    receipts,
    warnings,
  });

  // A clearance or exclusivity swap is not a budget swap. When there is no
  // explicit budget the ceiling should be the target's own price, but the
  // ranking must not then reward "cheaper" as if that were the goal.
  const ceiling = popularityCeilingForBudget(options.target, terms, budget);
  if (ceiling <= 0) {
    warnings.push(
      `Even an unknown catalogue at these terms prices above $${budget.toLocaleString("en-US")}. Loosen the terms (shorter term, smaller territory, fewer media) or raise the budget.`,
    );
    return { ...empty("No substitute can fit this budget under these terms."), popularityCeiling: 0 };
  }

  const targetId = options.target.artistId;
  if (!targetId) {
    warnings.push(
      "This cue has no Qloo entity id, so the audience it serves cannot be measured. Rebuild the sheet so the target is grounded.",
    );
    return { ...empty("Cannot measure the audience without a grounded target."), popularityCeiling: ceiling };
  }

  const fractions = PROBE_FRACTIONS.slice(0, Math.max(1, options.probes ?? PROBE_FRACTIONS.length));
  const eraFloor = eraToYearFloor(options.brief.era);
  const seen = new Map<string, QlooEntity>();

  // Probe the affordability frontier. Each call is one Qloo receipt, so the
  // panel can show exactly which ceilings were searched.
  const probes = await Promise.all(
    fractions.map(async (fraction) => {
      const popularityMax = Math.min(0.999, Math.max(0.01, ceiling * fraction));
      const call = await insights({
        filterType: "urn:entity:artist",
        // Signal on the target itself: we want artists this audience already
        // loves, not artists that merely share a genre tag with the brief.
        signalEntities: [targetId],
        demographics: {
          age: options.brief.audience.age,
          gender: options.brief.audience.gender,
          audiences: options.brief.audience.audiences,
        },
        popularityMax,
        releaseYearMin: eraFloor,
        explainability: true,
        take: 20,
      });
      receipts.push(
        receiptFrom(
          call,
          "GET /v2/insights",
          `Substitute pool (popularity <= ${popularityMax.toFixed(2)})`,
          "Capped by the budget-implied popularity ceiling.",
        ),
      );
      return call;
    }),
  );

  for (const call of probes) {
    if (!call.ok) {
      warnings.push(
        `A substitute search failed (${call.status || "network"}): ${call.error ?? "unknown"}. Results may be incomplete.`,
      );
      continue;
    }
    for (const entity of call.data) {
      if (entity.entity_id === targetId) continue;
      if (!seen.has(entity.entity_id)) seen.set(entity.entity_id, entity);
    }
  }

  if (seen.size === 0) {
    warnings.push(
      "Qloo returned no artists inside this budget for this scene. The budget may be too tight, or the anchor too specific for anything adjacent to fit.",
    );
    return { ...empty("Nothing inside this budget serves this scene's audience."), popularityCeiling: ceiling };
  }

  const context: GroundingContext = {
    brief: options.brief,
    anchorEntities: [],
    tags: [],
    receipts,
    warnings,
  };

  const candidates: SubstituteOption[] = [];
  for (const entity of seen.values()) {
    const affinity = entity.affinity ?? entity.popularity ?? 0;
    const popularity = entity.popularity ?? 0;
    const fee = quoteLicense({ ...options.target, popularity }, terms).fee;
    const savings = target.fee.recommended - fee.recommended;

    candidates.push({
      id: entity.entity_id,
      artist: entity.name,
      artistId: entity.entity_id,
      // Without an LLM there is no track proposal, and Cue must not invent one.
      track: "Track TBD — pick from this artist's catalogue",
      trackUnverified: true,
      image: entity.image,
      affinity,
      popularity,
      fee,
      savings,
      savingsPct: target.fee.recommended > 0 ? savings / target.fee.recommended : 0,
      clearance: popularity > 0.8 ? "major_label" : popularity < 0.5 ? "indie_friendly" : "unknown",
      clearanceDays: quoteLicense({ ...options.target, popularity }, terms).clearance.totalDays,
      momentum: 0,
      dominated: false,
      why: explainCue(entity, context, 0),
      sharedTaste: [],
    });
  }

  /**
   * Rank by audience fit within the pool, best first. This ordering is valid
   * because every candidate in it came from the same capped query, so their
   * affinities are directly comparable to each other.
   *
   * They are NOT comparable to the target's affinity, which came from an
   * uncapped query and is therefore measured against a different candidate set.
   * That is why affinity decides the order here but never the headline: it can
   * exceed the target's own score, and "keeps 115% of the audience fit" is
   * nonsense. The audience overlap below is what the panel leads with.
   */
  const byAffinity = [...candidates].sort(
    (a, b) => b.affinity - a.affinity || a.fee.recommended - b.fee.recommended,
  );

  // Overlap is the only signal comparable to the target, so it is measured
  // directly rather than inferred. Each comparison is one Qloo call, so this is
  // bounded to the most promising candidates by affinity — which is a sound
  // pre-filter because both metrics describe the same underlying audience.
  const COMPARE_LIMIT = 4;
  const shortlist = byAffinity.slice(0, COMPARE_LIMIT);

  const comparisons = await Promise.all(
    shortlist.map((candidate) =>
      compareGroups([targetId], [candidate.artistId], "urn:entity:artist", {
        a: target.artist,
        b: candidate.artist,
      }),
    ),
  );

  comparisons.forEach((comparison, index) => {
    const candidate = shortlist[index];
    receipts.push(
      receiptFrom(
        comparison,
        "GET /v2/analysis/compare",
        `Audience overlap: ${target.artist} vs ${candidate.artist}`,
        "Shared taste tags between the target and this candidate.",
      ),
    );
    if (comparison.ok) {
      candidate.audienceOverlap = comparison.data.overlap;
      candidate.audienceVerdict = comparison.data.verdict;
      candidate.sharedTaste = comparison.data.shared.slice(0, 12);
    }
  });

  markDominated(candidates);

  const measured = shortlist.filter((candidate) => candidate.audienceOverlap !== undefined);
  if (measured.length === 0) {
    warnings.push(
      "Audience overlap could not be measured for any candidate, so these are ranked on pool affinity alone. Treat the ordering as a shortlist rather than a recommendation.",
    );
  }

  /**
   * A substitute has to serve the same room, and overlap is what says so.
   *
   * The threshold is calibrated against known pairs: artists the same audience
   * genuinely loves measure 0.30-0.56 against each other (Portishead and Lamb
   * 0.56, Massive Attack and Tricky 0.53), while unrelated artists measure
   * 0.11-0.22 even when they share a genre tag (Portishead and Kendrick Lamar
   * 0.19). Below 0.30 the "substitute" is a different audience wearing the same
   * genre, and recommending it would quietly undo the ranking the sheet just
   * justified.
   */
  const MIN_OVERLAP = 0.3;
  const credible = measured.filter((candidate) => (candidate.audienceOverlap ?? 0) >= MIN_OVERLAP);

  const ranked = (credible.length > 0 ? credible : measured.length > 0 ? measured : byAffinity)
    // Best audience match first; where overlap ties, the cheaper option wins,
    // since the budget is the reason the supervisor is here at all.
    .sort(
      (a, b) =>
        (b.audienceOverlap ?? -1) - (a.audienceOverlap ?? -1) ||
        a.fee.recommended - b.fee.recommended,
    );

  if (credible.length === 0 && measured.length > 0) {
    warnings.push(
      `Nothing inside this budget reaches the ${Math.round(MIN_OVERLAP * 100)}% audience overlap that marks a true substitute for ${target.artist}. The closest options below are a different direction rather than a swap — expect them to move who the scene reaches.`,
    );
  }

  const pick = ranked[0];

  /**
   * The value option: the cheapest measured candidate that keeps essentially all
   * of the pick's audience overlap. Measured against the pick rather than the
   * target, because the pick is the best this budget can do — a saving is only
   * worth flagging when the overlap it costs is small relative to the best
   * available.
   *
   * Returns null when the pick is already the cheapest option, so the panel does
   * not present the same artist twice.
   */
  const VALUE_MARGIN = 0.8;
  const pickOverlap = pick.audienceOverlap ?? 0;
  const bestValue =
    [...measured]
      .filter((candidate) => (candidate.audienceOverlap ?? 0) >= pickOverlap * VALUE_MARGIN)
      .sort((a, b) => a.fee.recommended - b.fee.recommended)[0] ?? null;
  const distinctValue =
    bestValue && bestValue.id !== pick.id && bestValue.fee.recommended < pick.fee.recommended
      ? bestValue
      : null;

  // The closest match leads the list; the value option follows, so the panel can
  // present both without either being buried.
  const rest = candidates
    .filter((c) => c.id !== pick.id && c.id !== distinctValue?.id)
    .sort(
      (a, b) =>
        (b.audienceOverlap ?? -1) - (a.audienceOverlap ?? -1) ||
        a.fee.recommended - b.fee.recommended,
    );
  const options_ = distinctValue ? [pick, distinctValue, ...rest] : [pick, ...rest];

  const overlapPct = pick.audienceOverlap !== undefined ? Math.round(pick.audienceOverlap * 100) : null;
  const summary =
    overlapPct !== null
      ? `${pick.artist} shares ${overlapPct}% of ${target.artist}'s audience and costs $${pick.fee.recommended.toLocaleString("en-US")} instead of $${target.fee.recommended.toLocaleString("en-US")}${pick.savings > 0 ? ` — a saving of $${pick.savings.toLocaleString("en-US")}` : ""}.`
      : `${pick.artist} costs $${pick.fee.recommended.toLocaleString("en-US")} against ${target.artist}'s $${target.fee.recommended.toLocaleString("en-US")}. Audience overlap could not be measured, so treat this as a shortlist entry rather than a swap.`;

  return {
    target,
    terms,
    budget,
    popularityCeiling: ceiling,
    reason: reasonSentence(reason, options.target, budget),
    options: options_,
    pick,
    bestValue: distinctValue,
    pickSaving: pick.savings,
    valueSaving: distinctValue?.savings ?? 0,
    summary,
    receipts,
    warnings,
  };
}
