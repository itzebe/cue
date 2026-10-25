/**
 * Cultural localisation.
 *
 * The same campaign does not land the same way in two cities, and that is
 * exactly what a language model cannot tell you: it has no per-market taste
 * measurement, so it produces plausible-but-generic advice like "use local
 * references".
 *
 * IMPORTANT — what location actually does on this API:
 *
 * `filter.location.query` does NOT change artist affinity. Measured against the
 * hackathon sandbox, `/v2/insights` with `filter.type=urn:entity:artist` returns
 * byte-identical entities and affinity scores (to six decimal places) for Los
 * Angeles, Sao Paulo, Seoul, Lagos and London. A feature that claimed to
 * "localise the soundtrack" would therefore be fabricating its result.
 *
 * Location DOES work for `urn:entity:place`, where it is strongly
 * differentiating: the same brief returns the Hollywood Sign and Warner Bros.
 * Studio Tour for Los Angeles, Big Ben and the Palace of Westminster for London,
 * and the Ghibli Museum and Samurai Museum for Tokyo — with zero overlap between
 * markets.
 *
 * So that is what Cue localises: the cultural touchpoints a campaign would
 * reference or shoot against in each market. The music stays global, because the
 * data says it is global, and the UI states the limitation rather than papering
 * over it.
 *
 * Each market's places also carry their own cultural tags, so the same Taste Gap
 * the cue sheet uses is measured here over those tags — restricted to cultural
 * namespaces (see `cultural.ts`) and reusing the place pool this stage already
 * fetched, so it adds no Qloo call. That is what makes the metric demonstrably
 * domain-agnostic rather than a music-only claim.
 */

import { insights, type TagSignal } from "./qloo";
import type { QlooEntity, Receipt, SearchResult, TagResult } from "./types";
import { computeTasteGap, type TasteGapResult } from "./coverage";
import { filterCulturalEntities } from "./cultural";

export interface MarketTouchpoint {
  name: string;
  entityId: string;
  affinity: number;
  popularity: number;
}

/**
 * How many of a market's touchpoints the panel shows, and the size the cultural
 * coverage is measured at. One constant so the headline number and the list
 * beneath it describe the same selection.
 */
export const TOUCHPOINTS_SHOWN = 5;

export interface MarketResult {
  market: string;
  touchpoints: MarketTouchpoint[];
  /** Overlap with the reference market's touchpoints, 0..1. */
  overlapWithReference: number;
  /** Touchpoints this market uniquely surfaces — the localisation insight. */
  uniqueToMarket: string[];
  failed: boolean;
  /**
   * The Taste Gap over this market's cultural dimensions only.
   *
   * Measured from the place pool this market already returned, restricted to the
   * namespaces in `cultural.ts` — so it costs no extra Qloo call. The pool is
   * every place the market returned; the selection is the same top
   * `TOUCHPOINTS_SHOWN` the panel lists, so the percentage describes the list a
   * reader is looking at rather than a hidden one.
   *
   * Absent only when the market returned no places at all, where the panel
   * already reports the market as uncovered. When the pool exists but shares no
   * cultural dimension, this carries `unavailableReason` rather than a number.
   */
  culturalCoverage?: TasteGapResult;
}

export interface LocalisationResult {
  referenceMarket: string;
  markets: MarketResult[];
  receipts: Receipt[];
  warnings: string[];
  /** True when every market returned the same touchpoints, i.e. no divergence. */
  uniform: boolean;
}

function toTagSignals(tags: TagResult[]): TagSignal[] | undefined {
  if (tags.length === 0) return undefined;
  return tags.map((tag) => ({ tag: tag.tag_id, weight: 1 }));
}

/**
 * Re-run the brief's taste profile against the places of one market. Everything
 * except `filter.location.query` is held constant, so the delta is the market.
 */
async function marketTouchpoints(
  market: string,
  anchors: SearchResult[],
  tags: TagResult[],
  receipts: Receipt[],
): Promise<QlooEntity[]> {
  const call = await insights({
    filterType: "urn:entity:place",
    signalEntities: anchors.map((anchor) => anchor.entity_id),
    signalTags: toTagSignals(tags),
    locationQuery: market,
    take: 8,
    // Location-filtered place queries measured between 3.6s and 19.2s on the
    // hackathon sandbox, well past the default budget.
    timeoutMs: 25_000,
  });

  receipts.push({
    endpoint: "GET /v2/insights (market)",
    label: `Cultural touchpoints: ${market}`,
    params: call.params,
    status: call.status,
    ms: call.ms,
    resultCount: Array.isArray(call.data) ? call.data.length : 0,
    note: call.error,
  });

  return call.ok ? call.data : [];
}

function overlapRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const name of setA) if (setB.has(name)) shared += 1;
  return shared / new Set([...setA, ...setB]).size;
}

function toTouchpoints(entities: QlooEntity[]): MarketTouchpoint[] {
  return entities
    .sort(
      (a, b) =>
        (b.affinity ?? 0) - (a.affinity ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0),
    )
    .map((entity) => ({
      name: entity.name,
      entityId: entity.entity_id,
      affinity: entity.affinity ?? 0,
      popularity: entity.popularity ?? 0,
    }));
}

/**
 * Measure the cultural Taste Gap over one market's place pool.
 *
 * The pool is the places this market already returned — the same response the
 * touchpoint list is built from, so this adds no Qloo call. It is then restricted
 * to the cultural namespaces in `cultural.ts` before measurement, because a raw
 * place pool scores operational tags (parking, payment) as if they were cultural
 * reach.
 *
 * The selection is the highest-affinity touchpoints, in the same affinity order
 * `toTouchpoints` lists them, and the same size. That keeps the percentage and
 * the list beneath it describing one selection instead of two.
 *
 * Returns `undefined` only when the market returned nothing, where the caller
 * already reports the market as uncovered. A non-empty pool that shares no
 * cultural dimension returns a result carrying `unavailableReason` — never a
 * fabricated zero.
 */
function culturalCoverageFor(pool: QlooEntity[]): TasteGapResult | undefined {
  if (pool.length === 0) return undefined;
  const cultural = filterCulturalEntities(pool);
  const order = cultural
    .map((entity, index) => ({
      index,
      affinity: entity.affinity ?? 0,
      popularity: entity.popularity ?? 0,
    }))
    .sort((a, b) => b.affinity - a.affinity || b.popularity - a.popularity)
    .map((entry) => entry.index);
  const selection = order.slice(0, Math.min(TOUCHPOINTS_SHOWN, cultural.length));
  return computeTasteGap(cultural, selection);
}

/**
 * Compare the reference market against every other named market.
 *
 * The markets are fetched in parallel. Localisation runs as the final stage of
 * the pipeline, in isolation, so these few slow calls are not competing with the
 * rest of the sheet for the concurrency budget — and in parallel the stage costs
 * the slowest market rather than the sum of them, which is what keeps it inside
 * the serverless time limit.
 */
export async function localiseBrief(
  anchors: SearchResult[],
  tags: TagResult[],
  referenceMarket: string,
  otherMarkets: string[],
  receipts: Receipt[],
): Promise<LocalisationResult> {
  const warnings: string[] = [];
  const markets = [referenceMarket, ...otherMarkets.filter((market) => market !== referenceMarket)];

  const fetched = await Promise.all(
    markets.map(async (market) => {
      const pool = await marketTouchpoints(market, anchors, tags, receipts);
      return {
        market,
        // The raw, unfiltered pool is kept so the touchpoint list and any other
        // venue use reads the full Qloo response; the cultural measurement takes
        // its own filtered copy.
        pool,
        touchpoints: toTouchpoints(pool),
      };
    }),
  );

  const reference = fetched[0].touchpoints;
  const referenceNames = reference.map((touchpoint) => touchpoint.name);

  if (reference.length === 0) {
    warnings.push(
      `Qloo returned no places for ${referenceMarket}. Coverage for this brief may be thin in that market.`,
    );
  }

  const results: MarketResult[] = fetched.map(({ market, pool, touchpoints }, index) => {
    const culturalCoverage = culturalCoverageFor(pool);
    if (index === 0) {
      return {
        market,
        touchpoints,
        overlapWithReference: 1,
        uniqueToMarket: [],
        failed: touchpoints.length === 0,
        culturalCoverage,
      };
    }

    const marketNames = touchpoints.map((touchpoint) => touchpoint.name);
    if (touchpoints.length === 0) {
      warnings.push(
        `Qloo returned no places for ${market}. Treat this market as uncovered rather than identical to ${referenceMarket}.`,
      );
    }

    return {
      market,
      touchpoints,
      overlapWithReference: overlapRatio(referenceNames, marketNames),
      uniqueToMarket: marketNames.filter((name) => !referenceNames.includes(name)),
      failed: touchpoints.length === 0,
      culturalCoverage,
    };
  });

  const compared = results.filter((result) => !result.failed);
  const uniform =
    compared.length > 1 &&
    compared.slice(1).every((result) => result.overlapWithReference >= 0.999);

  if (uniform) {
    warnings.push(
      "Every market returned the same touchpoints, so the brief is not differentiating. Add a more specific scene or a market-relevant reference.",
    );
  }

  return {
    referenceMarket,
    markets: results,
    receipts,
    warnings,
    uniform,
  };
}

/**
 * A note the UI shows alongside the localisation panel. Kept in the library so
 * the limitation travels with the data rather than living only in the markup.
 */
export const LOCATION_LIMITATION =
  "Qloo's location filter is strongly differentiating for places but does not change artist affinity on this API — artist rankings are identical across markets. Cue localises the cultural touchpoints and leaves the music global, because that is what the data supports.";
