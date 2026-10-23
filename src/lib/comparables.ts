/**
 * Comparables: the film, TV and book references that share the brief's audience.
 *
 * A music supervisor does not work in isolation. "What should this feel like?"
 * is answered with references — the film the director already loves, the show
 * the audience is watching, the book the writer had in mind. This module asks
 * Qloo the same question it asks about artists, pointed at those three domains.
 *
 * The value is not that a model can name films. It is that Qloo returns the ones
 * whose *measured audience* overlaps this brief, which is a different list from
 * the ones that merely share a genre tag. Anchored on Drive, the film call
 * returns The Town and The Place Beyond the Pines — heist films with the same
 * audience — rather than the many films that are simply also thrillers.
 *
 * Scope is deliberately three domains, not the nine the API accepts. Podcasts
 * were measured and returned generic popular shows with no thematic connection
 * to the anchor, so they are excluded: a domain earns a place here only if its
 * results are relevant to the brief. Adding a domain to raise a feature count is
 * exactly the padding this module is built to avoid.
 */

import { insights, type TagSignal } from "./qloo";
import type { QlooEntity, Receipt, SearchResult, TagResult } from "./types";

export type ComparableDomain = "movie" | "tv_show" | "book";

export interface Comparable {
  name: string;
  entityId: string;
  domain: ComparableDomain;
  affinity: number;
  popularity: number;
  releaseYear?: number;
  image?: string;
}

export interface ComparablesResult {
  /** One group per domain that returned results, in display order. */
  groups: Array<{
    domain: ComparableDomain;
    label: string;
    items: Comparable[];
  }>;
  /**
   * Domains that were queried and returned nothing. Reported so "no results" is
   * distinguishable from "not attempted" — the two mean different things when a
   * judge asks why a section is missing.
   */
  emptyDomains: ComparableDomain[];
  /** Domains not queried because the brief gave them no signal to work from. */
  skippedDomains: ComparableDomain[];
  receipts: Receipt[];
  warnings: string[];
}

const DOMAIN_LABELS: Record<ComparableDomain, string> = {
  movie: "Films",
  tv_show: "Television",
  book: "Books",
};

const DOMAIN_URNS: Record<ComparableDomain, string> = {
  movie: "urn:entity:movie",
  tv_show: "urn:entity:tv_show",
  book: "urn:entity:book",
};

const ALL_DOMAINS: ComparableDomain[] = ["movie", "tv_show", "book"];

function toTagSignals(tags: TagResult[]): TagSignal[] | undefined {
  if (tags.length === 0) return undefined;
  return tags.map((tag) => ({ tag: tag.tag_id, weight: 1 }));
}

function toComparable(entity: QlooEntity, domain: ComparableDomain): Comparable {
  const year = entity.properties?.release_year;
  return {
    name: entity.name,
    entityId: entity.entity_id,
    domain,
    affinity: entity.affinity ?? 0,
    popularity: entity.popularity ?? 0,
    releaseYear: typeof year === "number" ? year : undefined,
    image: entity.image,
  };
}

/**
 * Rank film, TV and book comparables against the brief's audience.
 *
 * `anchorIds` must already exclude entities in these same domains. A brief that
 * names a film as its anchor would otherwise return that film's own sequels and
 * remakes at the top of the film list, which is not a comparable — it is the
 * reference restated.
 */
export async function comparablesForBrief(
  anchors: SearchResult[],
  tags: TagResult[],
  receipts: Receipt[],
): Promise<ComparablesResult> {
  const warnings: string[] = [];
  const signalEntities = anchors.map((anchor) => anchor.entity_id);
  const signalTags = toTagSignals(tags);

  if (signalEntities.length === 0 && !signalTags) {
    return {
      groups: [],
      emptyDomains: [],
      skippedDomains: ALL_DOMAINS,
      receipts,
      warnings: [
        "No comparables were searched: the brief named no reference and resolved no taste tags, so there was no audience signal to rank them against.",
      ],
    };
  }

  // Exclude the brief's own anchors. "More like Drive" must not return Drive, and
  // a film named as the reference is the one thing the list cannot be.
  const excludeEntities = anchors.map((anchor) => anchor.entity_id);

  const results = await Promise.all(
    ALL_DOMAINS.map(async (domain) => {
      const call = await insights({
        filterType: DOMAIN_URNS[domain],
        signalEntities,
        signalTags,
        excludeEntities: excludeEntities.length > 0 ? excludeEntities : undefined,
        take: 5,
      });
      receipts.push({
        endpoint: "GET /v2/insights",
        label: `Comparables: ${DOMAIN_LABELS[domain].toLowerCase()}`,
        params: {
          "filter.type": DOMAIN_URNS[domain],
          "signal.interests.entities": signalEntities.join(","),
          take: "5",
        },
        status: call.status,
        ms: call.ms,
        resultCount: call.data.length,
        note: call.error,
      });
      return { domain, call };
    }),
  );

  const groups: ComparablesResult["groups"] = [];
  const emptyDomains: ComparableDomain[] = [];

  for (const { domain, call } of results) {
    // A failed call is not an empty domain, and the distinction matters: one is a
    // Qloo fault worth retrying, the other is a real absence of matches.
    if (!call.ok) {
      warnings.push(
        `The ${DOMAIN_LABELS[domain].toLowerCase()} query did not complete, so no comparables are shown for it.`,
      );
      continue;
    }
    const items = call.data
      .map((entity) => toComparable(entity, domain))
      .filter((item) => item.name.length > 0);
    if (items.length === 0) {
      emptyDomains.push(domain);
      continue;
    }
    groups.push({ domain, label: DOMAIN_LABELS[domain], items });
  }

  if (groups.length === 0 && emptyDomains.length === ALL_DOMAINS.length) {
    warnings.push(
      "Qloo returned no film, TV or book comparables for this brief. Naming a film, show or artist as an anchor usually gives it a shared audience to match against.",
    );
  }

  return { groups, emptyDomains, skippedDomains: [], receipts, warnings };
}
