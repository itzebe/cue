/**
 * Casting fit.
 *
 * The point of this module is not "cast an actor". It is to prove the taste
 * graph generalises: the same brief that ranks musicians also ranks people and
 * brands, because Qloo measures one audience across all of them. An LLM asked
 * to pick a face for a campaign returns a plausible-sounding name; Qloo returns
 * the measured overlap between that person's audience and the brief's.
 *
 * This is the cross-domain claim made testable — music taste in, casting out.
 */

import { insights, type TagSignal } from "./qloo";
import type { QlooEntity, Receipt, SceneBrief, SearchResult, TagResult } from "./types";

export interface CastCandidate {
  name: string;
  entityId: string;
  affinity: number;
  popularity: number;
  /** Whether this candidate came from the cross-domain backfill pass. */
  crossDomain: boolean;
  image?: string;
}

export interface CastingResult {
  /** The audience the brief is speaking to. */
  audience: string;
  candidates: CastCandidate[];
  receipts: Receipt[];
  warnings: string[];
}

function toTagSignals(tags: TagResult[]): TagSignal[] | undefined {
  if (tags.length === 0) return undefined;
  return tags.map((tag) => ({ tag: tag.tag_id, weight: 1 }));
}

function toCandidate(entity: QlooEntity, crossDomain: boolean): CastCandidate {
  return {
    name: entity.name,
    entityId: entity.entity_id,
    affinity: entity.affinity ?? 0,
    popularity: entity.popularity ?? 0,
    crossDomain,
    image: entity.image,
  };
}

/**
 * Rank people and brands against the brief's audience.
 *
 * We deliberately do NOT filter by release year here. The era constraint is a
 * music-catalogue concept; applying it to people would drop every contemporary
 * performer and leave a casting list of dead composers.
 */
export async function castForBrief(
  brief: SceneBrief,
  anchors: SearchResult[],
  tags: TagResult[],
  receipts: Receipt[],
): Promise<CastingResult> {
  const warnings: string[] = [];
  const signalEntities = anchors.map((anchor) => anchor.entity_id);
  const signalTags = toTagSignals(tags);

  const [people, brands] = await Promise.all([
    insights({
      filterType: "urn:entity:person",
      signalEntities,
      signalTags,
      demographics: {
        age: brief.audience.age,
        gender: brief.audience.gender,
        audiences: brief.audience.audiences,
      },
      take: 10,
    }),
    insights({
      filterType: "urn:entity:brand",
      signalEntities,
      signalTags,
      demographics: {
        age: brief.audience.age,
        gender: brief.audience.gender,
        audiences: brief.audience.audiences,
      },
      take: 6,
    }),
  ]);

  receipts.push({
    endpoint: "GET /v2/insights (cast)",
    label: "Casting fit: people",
    params: people.params,
    status: people.status,
    ms: people.ms,
    resultCount: Array.isArray(people.data) ? people.data.length : 0,
    note: people.error,
  });
  receipts.push({
    endpoint: "GET /v2/insights (brand)",
    label: "Cross-domain: brands",
    params: brands.params,
    status: brands.status,
    ms: brands.ms,
    resultCount: Array.isArray(brands.data) ? brands.data.length : 0,
    note: brands.error,
  });

  if (!people.ok) {
    warnings.push(`Casting call failed (${people.status || "network"}): ${people.error ?? "unknown"}`);
  }
  if (!brands.ok) {
    warnings.push(`Brand affinity call failed (${brands.status || "network"}): ${brands.error ?? "unknown"}`);
  }

  const peopleCandidates = (people.ok ? people.data : [])
    .sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0))
    .map((entity) => toCandidate(entity, false));

  const brandCandidates = (brands.ok ? brands.data : [])
    .sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0))
    .map((entity) => toCandidate(entity, true));

  if (peopleCandidates.length === 0 && brands.ok) {
    warnings.push(
      "Qloo returned no people for this brief. Person coverage depends on the anchor entities — a music-only brief may not connect to a person cluster.",
    );
  }

  return {
    audience: brief.audience.age?.replace(/_/g, " ") ?? "unspecified audience",
    candidates: [...peopleCandidates, ...brandCandidates],
    receipts,
    warnings,
  };
}
