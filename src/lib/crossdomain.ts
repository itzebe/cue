/**
 * The Cross-Domain Taste Map.
 *
 * A scene brief names films, shows and artists. Those are the anchors, and Qloo
 * has already measured who likes them. This module asks the same measurement a
 * different question: what else does that audience connect to — which brands,
 * which destinations, which podcasts, which rooms.
 *
 * It is the broadest statement of Cue's claim that is still true. The cue sheet
 * answers "what should play"; this answers "what else belongs to this world".
 * Both rest on the same anchors and the same `signal.interests.entities` call,
 * which is why this is a view of one taste graph rather than a second product.
 *
 * Three rules keep it honest:
 *
 *  1. An affinity score is a measured position for *this* signal set. It is not a
 *     probability, a market share, or a share of an audience. Nothing here is
 *     converted to a percentage or presented as an overlap.
 *  2. Domains are queried because they carry a defensible relationship to the
 *     anchors, not to fill a grid. Domains that return nothing are reported as
 *     empty and hidden from the panel.
 *  3. A failed call is not an empty result. The two are tracked separately so a
 *     Qloo fault is never rendered as "this audience likes nothing here".
 */

import { insights } from "./qloo";
import type { QlooEntity, Receipt, SearchResult } from "./types";

/**
 * Domains offered by the taste map.
 *
 * This is a deliberate subset of what `/v2/insights` accepts. `urn:entity:video_game`
 * is absent because the live hackathon API rejects it with a 400 even though the
 * published guide lists it — verified against the API, not against the docs.
 * `urn:entity:artist` and `urn:entity:movie`/`tv_show`/`book` are absent because
 * the cue sheet and the comparables panel already query them; repeating those
 * calls here would spend quota to render a second copy of a list the reader has
 * already seen.
 */
export type CrossDomainKey = "brand" | "destination" | "podcast" | "place";

export const CROSS_DOMAIN_URNS: Record<CrossDomainKey, string> = {
  brand: "urn:entity:brand",
  destination: "urn:entity:destination",
  podcast: "urn:entity:podcast",
  place: "urn:entity:place",
};

export const CROSS_DOMAIN_LABELS: Record<CrossDomainKey, string> = {
  brand: "Brands",
  destination: "Destinations",
  podcast: "Podcasts",
  place: "Places",
};

/** Every domain the map knows how to ask for. */
export const CROSS_DOMAIN_KEYS: CrossDomainKey[] = ["brand", "destination", "podcast", "place"];

/**
 * Domains asked for by default.
 *
 * `brand` is deliberately excluded, and the reason is measured rather than
 * stylistic: the casting pass already issues a `urn:entity:brand` query for the
 * same anchors, and against a live brief it returned the identical six brands.
 * Asking again here would spend a request to render a second copy of a list the
 * reader has already seen in the cross-domain panel — the exact padding this
 * module exists to avoid. Brands remain supported for callers that want the map
 * to own that question.
 */
export const CROSS_DOMAIN_DEFAULT_KEYS: CrossDomainKey[] = [
  "destination",
  "podcast",
  "place",
];

/** How many entities to keep per domain. Enough to read, few enough to stay honest. */
const TAKE_PER_DOMAIN = 6;

export interface CrossDomainItem {
  name: string;
  entityId: string;
  domain: CrossDomainKey;
  /**
   * The measured affinity, or undefined when Qloo returned no affinity for this
   * row. Undefined is preserved rather than defaulted to 0, because a rendered
   * "0.00" reads as a measured disagreement instead of an absent measurement.
   */
  affinity?: number;
  /**
   * Whether `affinity` was measured for this query or substituted from popularity.
   * The panel labels the substituted case differently rather than passing a
   * popularity percentile off as an affinity score.
   */
  affinitySource?: "query" | "popularity";
  popularity: number;
  image?: string;
  /**
   * The anchors whose contribution Qloo attributed to this result, resolved to
   * names. Qloo reports one explainability entry per contributing signal entity,
   * so this is per-anchor provenance rather than "all anchors".
   *
   * Empty when Qloo returned no explainability block. The panel then says the
   * result is related through the anchors collectively, which is what the request
   * actually establishes — it does not claim each anchor independently supports it.
   */
  attributedAnchors: string[];
}

export interface CrossDomainGroup {
  domain: CrossDomainKey;
  label: string;
  items: CrossDomainItem[];
}

export interface CrossDomainResult {
  /** One group per domain that returned usable results, in display order. */
  groups: CrossDomainGroup[];
  /** Domains that were queried and returned no entities. */
  emptyDomains: CrossDomainKey[];
  /**
   * Domains whose request failed. Kept separate from `emptyDomains` so a Qloo
   * fault is never presented to the reader as a real absence of matches.
   */
  failedDomains: CrossDomainKey[];
  /** Domains not queried because the brief gave them no anchors to rank against. */
  skippedDomains: CrossDomainKey[];
  /** The resolved anchors the whole map was measured against. */
  anchors: Array<{ name: string; entityId: string }>;
  receipts: Receipt[];
  warnings: string[];
}

function emptyResult(
  skippedDomains: CrossDomainKey[],
  warnings: string[],
): CrossDomainResult {
  return {
    groups: [],
    emptyDomains: [],
    failedDomains: [],
    skippedDomains,
    anchors: [],
    receipts: [],
    warnings,
  };
}

/**
 * Map Qloo's per-result attribution onto anchor names.
 *
 * Qloo returns one explainability entry per contributing `signal.interests.entities`
 * value, keyed by entity ID. IDs come back uppercased, so the comparison is
 * case-insensitive; matching on exact case would silently attribute nothing.
 * Unrecognised IDs are dropped rather than shown raw.
 */
function attributedAnchorNames(
  entity: QlooEntity,
  anchors: SearchResult[],
): string[] {
  const byId = new Map(anchors.map((anchor) => [anchor.entity_id.toLowerCase(), anchor.name]));
  const names: string[] = [];
  for (const entry of entity.explainability ?? []) {
    if (entry.signal !== "signal.interests.entities") continue;
    const name = byId.get(entry.entity_id.toLowerCase());
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function toItem(
  entity: QlooEntity,
  domain: CrossDomainKey,
  anchors: SearchResult[],
): CrossDomainItem {
  return {
    name: entity.name,
    entityId: entity.entity_id,
    domain,
    affinity: entity.affinity,
    affinitySource: entity.affinitySource,
    popularity: entity.popularity ?? 0,
    image: entity.image,
    attributedAnchors: attributedAnchorNames(entity, anchors),
  };
}

/**
 * Ask each domain what else this audience connects to.
 *
 * `anchors` are the entities the pipeline already resolved for the brief. Passing
 * them in rather than re-resolving is the difference between this being one
 * fan-out and being a second pipeline: the anchors cost nothing here, and the
 * reader sees the same provenance the cue sheet used.
 *
 * `receipts` is mutated in place to match `comparablesForBrief` and `castForBrief`,
 * so every Qloo call this sheet made lands in one evidence trail.
 */
export async function crossDomainForAudience(
  anchors: SearchResult[],
  receipts: Receipt[],
  options: { domains?: CrossDomainKey[] } = {},
): Promise<CrossDomainResult> {
  const domains = options.domains ?? CROSS_DOMAIN_DEFAULT_KEYS;

  if (anchors.length === 0) {
    return emptyResult(
      domains,
      [
        "No cross-domain discoveries were searched: the brief resolved no Qloo anchor, so there was no audience to measure against. Naming a film, show or artist usually fixes this.",
      ],
    );
  }

  const signalEntities = anchors.map((anchor) => anchor.entity_id);

  const results = await Promise.all(
    domains.map(async (domain) => {
      const call = await insights({
        filterType: CROSS_DOMAIN_URNS[domain],
        signalEntities,
        take: TAKE_PER_DOMAIN,
        // Explainability is what turns "related to your anchors" into "related
        // through Sicario". It is requested here and not on the comparables pass
        // because this panel's provenance claim depends on it.
        explainability: true,
      });
      receipts.push({
        endpoint: "GET /v2/insights",
        label: `Cross-domain: ${CROSS_DOMAIN_LABELS[domain].toLowerCase()}`,
        params: {
          "filter.type": CROSS_DOMAIN_URNS[domain],
          "signal.interests.entities": signalEntities.join(","),
          take: String(TAKE_PER_DOMAIN),
        },
        status: call.status,
        ms: call.ms,
        resultCount: call.data.length,
        note: call.error,
      });
      return { domain, call };
    }),
  );

  const groups: CrossDomainGroup[] = [];
  const emptyDomains: CrossDomainKey[] = [];
  const failedDomains: CrossDomainKey[] = [];
  const warnings: string[] = [];

  for (const { domain, call } of results) {
    if (!call.ok) {
      failedDomains.push(domain);
      warnings.push(
        `The ${CROSS_DOMAIN_LABELS[domain].toLowerCase()} query did not complete, so no discoveries are shown for it.`,
      );
      continue;
    }

    const items = call.data
      .map((entity) => toItem(entity, domain, anchors))
      .filter((item) => item.name.length > 0);

    if (items.length === 0) {
      emptyDomains.push(domain);
      continue;
    }
    groups.push({ domain, label: CROSS_DOMAIN_LABELS[domain], items });
  }

  if (groups.length === 0 && emptyDomains.length > 0 && failedDomains.length === 0) {
    warnings.push(
      "Qloo returned no cross-domain discoveries for this brief. Naming a film, show or artist as an anchor usually gives the taste graph an audience to work from.",
    );
  }

  return {
    groups,
    emptyDomains,
    failedDomains,
    skippedDomains: [],
    anchors: anchors.map((anchor) => ({ name: anchor.name, entityId: anchor.entity_id })),
    receipts,
    warnings,
  };
}
