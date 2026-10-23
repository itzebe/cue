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
 */

import { insights, type TagSignal } from "./qloo";
import type { QlooEntity, Receipt, SearchResult, TagResult } from "./types";

export interface MarketTouchpoint {
  name: string;
  entityId: string;
  affinity: number;
  popularity: number;
}

export interface MarketResult {
  market: string;
  touchpoints: MarketTouchpoint[];
  /** Overlap with the reference market's touchpoints, 0..1. */
  overlapWithReference: number;
  /** Touchpoints this market uniquely surfaces — the localisation insight. */
  uniqueToMarket: string[];
  failed: boolean;
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
    markets.map(async (market) => ({
      market,
      touchpoints: toTouchpoints(await marketTouchpoints(market, anchors, tags, receipts)),
    })),
  );

  const reference = fetched[0].touchpoints;
  const referenceNames = reference.map((touchpoint) => touchpoint.name);

  if (reference.length === 0) {
    warnings.push(
      `Qloo returned no places for ${referenceMarket}. Coverage for this brief may be thin in that market.`,
    );
  }

  const results: MarketResult[] = fetched.map(({ market, touchpoints }, index) => {
    if (index === 0) {
      return {
        market,
        touchpoints,
        overlapWithReference: 1,
        uniqueToMarket: [],
        failed: touchpoints.length === 0,
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
