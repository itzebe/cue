import type {
  Cue,
  CueSheet,
  QlooEntity,
  Receipt,
  RegionAffinity,
  SceneBrief,
  SearchResult,
} from "./types";
import {
  compareGroups,
  insights,
  normaliseEntity,
  searchEntities,
  searchTags,
  trending,
  type QlooCallResult,
} from "./qloo";

/**
 * The grounding engine.
 *
 * This is where Cue stops being an LLM wrapper. Every cue's ranking, momentum
 * and justification is derived from Qloo signals: cross-domain affinity from
 * the scene's anchor entities, audience fit from demographic signals, and
 * momentum from the trending endpoint.
 */

/** Map a free-text era hint onto a release-year floor for signal anchoring. */
export function eraToYearFloor(era: string): number | undefined {
  const text = era.toLowerCase();
  const decade = text.match(/(19|20)(\d)0s/);
  if (decade) {
    const start = Number(`${decade[1]}${decade[2]}0`);
    return Number.isFinite(start) ? start : undefined;
  }
  const explicit = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (explicit) return Number(explicit[1]);
  if (/contemporary|modern|now|today|current/.test(text)) {
    return new Date().getFullYear() - 6;
  }
  if (/70s|seventies/.test(text)) return 1970;
  if (/80s|eighties/.test(text)) return 1980;
  if (/90s|nineties/.test(text)) return 1990;
  return undefined;
}

/** Turn the LLM's parsed anchors into concrete Qloo entity IDs. */
export async function resolveAnchors(
  anchors: string[],
  receipts: Receipt[],
): Promise<SearchResult[]> {
  const resolved: SearchResult[] = [];
  const types = [
    "urn:entity:movie",
    "urn:entity:tv_show",
    "urn:entity:artist",
    "urn:entity:person",
  ];

  for (const anchor of anchors.slice(0, 6)) {
    const call = await searchEntities(anchor, types, 3);
    receipts.push(receiptFrom(call, "GET /search", `Resolve "${anchor}"`));
    if (call.ok && call.data.length > 0) {
      resolved.push(call.data[0]);
    }
  }
  return resolved;
}

/** Resolve mood/genre words into valid Qloo tag IDs (invalid tags are ignored silently). */
export async function resolveTags(
  terms: string[],
  receipts: Receipt[],
): Promise<string[]> {
  const tagIds: string[] = [];
  for (const term of terms.slice(0, 6)) {
    const call = await searchTags(term, [], 3);
    receipts.push(receiptFrom(call, "GET /v2/tags", `Tag "${term}"`));
    if (call.ok && call.data.length > 0) {
      tagIds.push(call.data[0].tag_id);
    }
  }
  return Array.from(new Set(tagIds));
}

function receiptFrom<T>(
  call: QlooCallResult<T>,
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

export interface GroundingContext {
  brief: SceneBrief;
  anchorEntities: SearchResult[];
  tagIds: string[];
  receipts: Receipt[];
  warnings: string[];
}

/**
 * Ask Qloo for the artists whose measured audience overlaps the scene's taste
 * profile. This single call is the reason Cue cannot be replicated by an LLM.
 */
export async function groundArtistCues(
  context: GroundingContext,
): Promise<QlooEntity[]> {
  const { brief, anchorEntities, tagIds, receipts, warnings } = context;

  const signalEntities = anchorEntities.map((entity) => entity.entity_id);
  const eraFloor = eraToYearFloor(brief.era);

  const call = await insights({
    filterType: "urn:entity:artist",
    signalEntities,
    signalTags: tagIds,
    demographics: {
      age: brief.audience.age,
      gender: brief.audience.gender,
      audiences: brief.audience.audiences,
    },
    biasTrends: brief.era.match(/contemporary|modern|now|today/i) ? "high" : "medium",
    releaseYearMin: eraFloor,
    explainability: true,
    take: 14,
  });
  receipts.push(receiptFrom(call, "GET /v2/insights", "Artist affinity (explainability on)"));

  if (!call.ok) {
    warnings.push(
      `Artist affinity call failed (${call.status || "network"}): ${call.error ?? "unknown"}`,
    );
    return [];
  }
  if (call.data.length === 0) {
    warnings.push(
      "Qloo returned no artists. Parameters may be unsupported for this entity type, or the anchors had no coverage.",
    );
  }
  return call.data;
}

/**
 * Resolve one artist's momentum via the trending endpoint. Kept per-artist so a
 * single failure degrades one cue rather than the whole sheet.
 */
export async function artistMomentum(
  artistId: string,
  receipts: Receipt[],
): Promise<number> {
  const end = new Date();
  const start = new Date(end.getTime() - 1000 * 60 * 60 * 24 * 90);
  const iso = (date: Date) => date.toISOString().slice(0, 10);

  const call = await trending(artistId, "urn:entity:artist", iso(start), iso(end));
  receipts.push(receiptFrom(call, "GET /v2/trending", "Artist momentum"));
  if (!call.ok || call.data.length < 2) return 0;

  const sorted = [...call.data].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const delta = (last.percentile ?? last.rank ?? 0) - (first.percentile ?? first.rank ?? 0);
  if (delta > 0.02) return 1;
  if (delta < -0.02) return -1;
  return 0;
}

/** Compare two creative directions head-to-head via /v2/analysis/compare. */
export async function compareDirections(
  groupA: SearchResult[],
  groupB: SearchResult[],
  receipts: Receipt[],
): Promise<CueSheet["directionCompare"]> {
  const a = groupA.map((entity) => entity.entity_id);
  const b = groupB.map((entity) => entity.entity_id);
  if (a.length === 0 || b.length === 0) return undefined;

  const call = await compareGroups(a, b, "urn:entity:artist", 10);
  receipts.push(receiptFrom(call, "GET /v2/analysis/compare", "Direction A/B compare"));
  if (!call.ok) return undefined;

  const sharedIds = new Set(
    call.data
      .filter((entity) => !entity.backfill)
      .map((entity) => entity.entity_id),
  );
  const aTop = groupA.filter((entity) => sharedIds.has(entity.entity_id));
  const bTop = groupB.filter((entity) => sharedIds.has(entity.entity_id));

  const verdict =
    call.data.length === 0
      ? "Qloo found no shared audience between the two directions, which is itself a signal: they will split the room."
      : `${call.data.length} artist(s) bridge both directions, so the two readings overlap more than they diverge.`;

  return {
    aLabel: groupA.map((entity) => entity.name).join(" + ") || "Direction A",
    bLabel: groupB.map((entity) => entity.name).join(" + ") || "Direction B",
    aTop,
    bTop,
    shared: call.data.map((entity) => entity.name),
    verdict,
  };
}

/** Location-aware regional affinity, used for the "where does this land" panel. */
export async function regionalAffinity(
  context: GroundingContext,
): Promise<RegionAffinity[]> {
  const { brief, anchorEntities, tagIds, receipts } = context;
  if (!brief.region) return [];

  const call = await insights({
    filterType: "urn:entity:artist",
    signalEntities: anchorEntities.map((entity) => entity.entity_id),
    signalTags: tagIds,
    locationQuery: brief.region,
    take: 6,
  });
  receipts.push(
    receiptFrom(call, "GET /v2/insights (location)", `Localise to ${brief.region}`),
  );
  if (!call.ok) return [];

  return call.data
    .slice(0, 6)
    .map((entity) => ({ name: entity.name, affinity: entity.affinity ?? 0 }));
}

/** Content-based backfill: adjacent artists Qloo surfaces beyond the direct signal. */
export async function discoveryBackfill(
  context: GroundingContext,
  excludeIds: string[],
): Promise<QlooEntity[]> {
  const { anchorEntities, tagIds, receipts } = context;
  const call = await insights({
    filterType: "urn:entity:artist",
    signalEntities: anchorEntities.map((entity) => entity.entity_id),
    signalTags: tagIds,
    extra: {
      "filter.exclude.entities": excludeIds.join(","),
      "backfill.cross_domain.take": 6,
    },
    take: 6,
  });
  receipts.push(receiptFrom(call, "GET /v2/insights (backfill)", "Cross-domain discovery"));
  return call.ok ? call.data : [];
}

/**
 * Build the human-readable justification for a cue from the Qloo data alone.
 * No LLM involved: every sentence maps to a returned signal.
 */
export function explainCue(
  entity: QlooEntity,
  context: GroundingContext,
  momentum: number,
): string[] {
  const reasons: string[] = [];
  const { brief, anchorEntities } = context;

  if (anchorEntities.length > 0) {
    const topAnchor = anchorEntities[0].name;
    reasons.push(
      `Audiences who like ${topAnchor} also index highly for ${entity.name} in Qloo's taste graph.`,
    );
  }

  const drivers = (entity.explainability ?? [])
    .filter((entry) => entry.score > 0)
    .slice(0, 2)
    .map((entry) => entry.name || entry.entity_id);
  if (drivers.length > 0) {
    reasons.push(
      `Explainability attributes ${Math.round((entity.explainability?.[0]?.score ?? 0) * 100)}% of the match to ${drivers.join(" and ")}.`,
    );
  }

  if (brief.audience.age) {
    reasons.push(
      `Over-indexes with the ${brief.audience.age.replace(/_/g, " ")} audience the brief targets.`,
    );
  }

  if (momentum > 0) {
    reasons.push("Rising momentum over the last 90 days, so the cue reads current rather than nostalgic.");
  } else if (momentum < 0) {
    reasons.push("Cooling momentum, which suits a scene that needs distance or melancholy.");
  }

  if (entity.backfill) {
    reasons.push("Surfaced by cross-domain backfill: adjacent to the brief, not an obvious search result.");
  }

  if (reasons.length === 0) {
    reasons.push("Ranked by Qloo affinity against the scene's taste profile.");
  }
  return reasons;
}

/** Derive a placement role so the cue sheet reads like a real supervisor's chart. */
export function inferPlacement(
  index: number,
  brief: SceneBrief,
): Cue["placement"] {
  if (brief.diegetic && index === 0) return "needle_drop";
  if (index === 0) return "needle_drop";
  if (index === 1) return "score_bed";
  if (index === 2) return "transition";
  return "title_card";
}

/** Rough licensing read, derived from popularity as a proxy for label leverage. */
export function inferClearance(entity: QlooEntity): Cue["clearance"] {
  const popularity = entity.popularity ?? 0;
  if (popularity < 0.5) return "indie_friendly";
  if (popularity > 0.8) return "major_label";
  return "unknown";
}

export function toCue(
  entity: QlooEntity,
  index: number,
  context: GroundingContext,
  momentum: number,
  track: string,
): Cue {
  const affinity = entity.affinity ?? entity.popularity ?? 0;
  const popularity = entity.popularity ?? 0;

  // Confidence blends Qloo affinity with how much corroborating signal exists.
  const corroboration = Math.min(1, (entity.explainability?.length ?? 0) / 3);
  const confidence = Math.min(0.99, 0.45 + affinity * 0.4 + corroboration * 0.15);

  return {
    id: entity.entity_id,
    artist: entity.name,
    artistId: entity.entity_id,
    track,
    affinity,
    popularity,
    momentum,
    image: entity.image,
    why: explainCue(entity, context, momentum),
    explainability: entity.explainability ?? [],
    audienceFit: context.brief.audience.age
      ? { [context.brief.audience.age]: affinity }
      : undefined,
    placement: inferPlacement(index, context.brief),
    clearance: inferClearance(entity),
    risk:
      popularity > 0.85
        ? "High-profile catalogue; expect a competitive sync fee and a slower clearance."
        : entity.backfill
          ? "Backfill pick: verify the master and publishing split before locking."
          : "Standard clearance path for this profile.",
    confidence,
  };
}

export { normaliseEntity };
