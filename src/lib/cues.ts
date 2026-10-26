import type {
  Cue,
  CueSheet,
  QlooEntity,
  Receipt,
  RegionAffinity,
  SceneBrief,
  SearchResult,
  TagResult,
} from "./types";
import {
  compareGroups,
  insights,
  normaliseEntity,
  searchEntities,
  searchTags,
  trending,
  type QlooCallResult,
  type TagSignal,
} from "./qloo";

/**
 * The grounding engine.
 *
 * This is where Cue stops being an LLM wrapper. Every cue's ranking, momentum
 * and justification is derived from Qloo signals: cross-domain affinity from
 * the scene's anchor entities, audience fit from demographic signals, and
 * momentum from the trending endpoint.
 */

/**
 * The trending endpoint returns an empty series for short windows (90 days
 * yields zero points), so momentum is measured over two years to guarantee a
 * usable series for any artist with coverage.
 */
const MOMENTUM_WINDOW_DAYS = 730;

/** Qloo requires `{tag, weight}` objects for tag signals; bare strings return 400. */
function toTagSignals(tags: TagResult[]): TagSignal[] | undefined {
  if (tags.length === 0) return undefined;
  return tags.map((tag) => ({ tag: tag.tag_id, weight: 1 }));
}

/**
 * Qloo classifies each tag with its own `type`. The `urn:tag:genre:*` and
 * `urn:tag:subgenre:*` families name what a work *is*, which is the only kind
 * of tag that can safely restrict a candidate pool. Everything else — `plot`,
 * `character`, `style`, `ambience`, `keyword`, and off-domain families such as
 * `specialty_dish` or `category` — describes an aspect rather than a genre.
 */
const GENRE_TAG_TYPE_PREFIXES = ["urn:tag:genre:", "urn:tag:subgenre:"];

/** The Qloo classification for a tag, whichever spelling the endpoint used. */
function tagTypeOf(tag: TagResult): string {
  return tag.type ?? tag.subtype ?? tag.types?.[0] ?? "";
}

function isGenreTag(tag: TagResult): boolean {
  const type = tagTypeOf(tag);
  return GENRE_TAG_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * Qloo's music-genre families. `/v2/tags` returns every domain that shares the
 * word, so a brief's "driving" matched `urn:tag:genre:media:driving` — a
 * videogame genre — ahead of the music one. A music artist pool scoped by a
 * videogame genre matches nothing, so the sheet silently dropped to an
 * unscoped popularity ranking. Preferring the music reading keeps the pool
 * about music without hard-coding any genre name.
 */
const MUSIC_GENRE_TYPE_PREFIXES = ["urn:tag:genre:music", "urn:tag:subgenre:music"];

function isMusicGenreTag(tag: TagResult): boolean {
  const type = tagTypeOf(tag);
  // Qloo writes the family as `urn:tag:genre:music` with no trailing segment,
  // so a bare `startsWith("urn:tag:genre:music:")` never matches.
  return MUSIC_GENRE_TYPE_PREFIXES.some(
    (prefix) => type === prefix || type.startsWith(`${prefix}:`),
  );
}

/**
 * Choose which resolved tags may restrict the candidate pool.
 *
 * `filter.tags` is a union, not an intersection: every tag added to it *widens*
 * the set. A broad style tag sitting beside a genre tag therefore neutralises
 * it — Qloo's own `urn:tag:style:qloo:energetic` matches Coldplay and The
 * Beatles, so a "polka" brief filtered by `polka + folk + joyful + frantic +
 * energetic` was served the generic pool while its slate still carried a
 * genre-scoped label. Restricting the filter to genre-style tags keeps the
 * candidate set specific to the brief.
 *
 * The predicate reads Qloo's tag `type` metadata rather than matching words, so
 * no genre or mood name is hard-coded. Mood, style, plot and off-domain tags
 * are not discarded — they stay in `signal.interests.tags`, where they still
 * shape affinity scoring without loosening the candidate set.
 */
export function selectFilterTags(tags: TagResult[]): TagResult[] {
  return tags.filter(isGenreTag);
}

/**
 * How many broader-genre attempts a single brief may make.
 *
 * The hackathon key's music catalogue is thin at the leaves: `punk_rock` and
 * `death_metal` each hold zero artists while their broader readings hold
 * fourteen. Retrying once with the broader genre recovers those briefs without
 * letting a brief wander the genre space.
 */
const MAX_GENRE_BROADENING_STEPS = 2;

/**
 * The tokens of a genre tag's display name that could name a broader reading.
 *
 * There is no genre tree to walk: `/v2/tags` reports `parents` as *entity* types
 * (`urn:entity:artist`), and the per-tag detail routes 404 on the hackathon key.
 * What the endpoint does give is the tag's display name, and Qloo's own index
 * resolves a broader reading from it — `Punk - Rock` resolves `Punk`, `Death
 * Metal` resolves `Metal`, both populated. So the candidate parents are the
 * Qloo-resolved genre readings of the tag's own name, which is a lookup in
 * Qloo's index rather than a hierarchy this code invents.
 */
function broaderGenreTokens(tag: TagResult): string[] {
  return (tag.name ?? "")
    .split(/[\s\-/&,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
    // Longest first: a multi-word reading is more specific than its parts, so
    // "hardcore punk" is preferred over "hardcore" or "punk".
    .sort((a, b) => b.length - a.length);
}

/**
 * The candidate pool for a brief's genre tags, broadened only as far as needed.
 *
 * Runs the exact scoped query first. If it matches nothing, it walks a bounded
 * number of broader readings, stopping at the first that returns candidates.
 * Tokens are resolved one at a time and only when the previous one failed, so a
 * brief never pays for a lookup it does not need.
 *
 * Mood and style signals are untouched throughout — they travel in
 * `signal.interests.tags`, which `request` supplies, so the fallback changes
 * only what *restricts* the pool, never what scores it.
 *
 * Returns the filter that actually produced the candidates, so the caller can
 * say which scope the slate came from rather than assuming the exact one.
 */
async function resolveCandidatePool(
  exactTags: TagResult[],
  request: (filterTags: string[] | undefined) => Promise<QlooCallResult<QlooEntity[]>>,
  receipts: Receipt[],
  warnings: string[],
): Promise<{
  call: QlooCallResult<QlooEntity[]>;
  filters?: TagResult[];
  broadenedFrom?: string;
}> {
  const tried = new Set(exactTags.map((tag) => tag.tag_id));
  let filters: TagResult[] = exactTags;
  let current: TagResult | undefined = filters[0];
  let queue: string[] = [];
  let call = await request(filters.map((tag) => tag.tag_id));

  for (let step = 0; step < MAX_GENRE_BROADENING_STEPS; step += 1) {
    if (!call.ok || call.data.length > 0 || !current) break;
    if (queue.length === 0) queue = broaderGenreTokens(current);

    // Resolve the next token Qloo recognises as a music genre, skipping any
    // reading already tried. A token that resolves back to the current tag is
    // not a broadening step, so it cannot extend the walk.
    let next: TagResult | undefined;
    while (queue.length > 0 && !next) {
      const token = queue.shift() as string;
      const lookup = await searchTags(token, MUSIC_GENRE_TYPE_PREFIXES, 5);
      receipts.push(
        receiptFrom(lookup, "GET /v2/tags", `Broader genre for "${current.name}" via "${token}"`),
      );
      const reading = lookup.ok ? lookup.data.find(isMusicGenreTag) : undefined;
      if (reading && !tried.has(reading.tag_id)) next = reading;
    }
    if (!next) break;

    receipts.push(receiptFrom(call, "GET /v2/insights", "Artist affinity (tag filter, no match)"));
    tried.add(next.tag_id);

    const retry = await request([next.tag_id]);
    if (retry.ok && retry.data.length > 0) {
      warnings.push(
        `Qloo matched no artists for this brief's genre tag${exactTags.length === 1 ? "" : "s"} ` +
          `(${exactTags.map((tag) => tag.name).join(", ")}). The slate below uses the broader genre ` +
          `"${next.name}", so it is genre-scoped but broader than the brief asked for.`,
      );
      return { call: retry, filters: [next], broadenedFrom: current.name };
    }
    // The broader reading matched nothing either; carry on within the bound.
    current = next;
    filters = [next];
    call = retry;
    queue = [];
  }

  return { call, filters: filters === exactTags ? exactTags : undefined };
}

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

  // Resolve concurrently: each anchor is an independent search, and a brief can
  // name up to six. Receipts are written by index so the log keeps the order of
  // the brief rather than the order the network happened to return.
  const calls = await Promise.all(
    anchors.slice(0, 6).map((anchor) => searchEntities(anchor, types, 3)),
  );
  anchors.slice(0, 6).forEach((anchor, i) => {
    const call = calls[i];
    receipts.push(receiptFrom(call, "GET /search", `Resolve "${anchor}"`));
    if (call.ok && call.data.length > 0) {
      resolved.push(call.data[0]);
    }
  });
  return resolved;
}

/** Resolve mood/genre words into valid Qloo tags (invalid tags are ignored silently). */
export async function resolveTags(
  terms: string[],
  receipts: Receipt[],
): Promise<TagResult[]> {
  const resolved: TagResult[] = [];
  const seen = new Set<string>();
  const scoped = terms.slice(0, 6);
  // Five, not three: Qloo orders the results by popularity across every domain,
  // so the music reading of a word often sits behind an unrelated one.
  const calls = await Promise.all(scoped.map((term) => searchTags(term, [], 5)));
  scoped.forEach((term, i) => {
    const call = calls[i];
    receipts.push(receiptFrom(call, "GET /v2/tags", `Tag "${term}"`));
    if (call.ok && call.data.length > 0) {
      const tag = pickTagReading(call.data);
      if (seen.has(tag.tag_id)) return;
      seen.add(tag.tag_id);
      resolved.push(tag);
    }
  });
  return resolved;
}

/**
 * Choose which of Qloo's readings of a term is the one a music brief means.
 *
 * `/v2/tags` returns the term in every domain that shares the word, ordered by
 * popularity. The top hit is not always a genre: "driving" led with a videogame
 * genre and "punk rock" with a movie keyword. Taking `data[0]` therefore fed the
 * candidate filter a non-music tag, which matched no artists and silently
 * downgraded the slate to an unscoped popularity ranking.
 *
 * When the results include genre tags, the music one is preferred, falling back
 * to the first genre tag if none is musical. When the term has no genre reading
 * at all — a mood like "energetic" — the previous choice stands, so mood and
 * style handling is unchanged.
 */
function pickTagReading(tags: TagResult[]): TagResult {
  const genreTags = tags.filter(isGenreTag);
  if (genreTags.length === 0) return tags[0];
  return genreTags.find(isMusicGenreTag) ?? genreTags[0];
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
  /** Resolved mood/genre tags, kept with names so explanations read in English. */
  tags: TagResult[];
  receipts: Receipt[];
  warnings: string[];
  /**
   * Set by `groundArtistCues` when the brief's exact genre tags matched no
   * artists and a broader genre was used instead. Read by the discovery pass so
   * both halves of the sheet are scoped the same way, and so the sheet can say
   * which filter actually produced the candidates.
   */
  appliedGenreFilter?: TagResult[];
}

/** Names for every entity/tag that can appear in an explainability block. */
function buildLabelMap(context: GroundingContext): Map<string, string> {
  const labels = new Map<string, string>();
  for (const anchor of context.anchorEntities) labels.set(anchor.entity_id, anchor.name);
  for (const tag of context.tags) labels.set(tag.tag_id, tag.name);
  return labels;
}

/**
 * Ask Qloo for the artists whose measured audience overlaps the scene's taste
 * profile. This single call is the reason Cue cannot be replicated by an LLM.
 */
export async function groundArtistCues(
  context: GroundingContext,
): Promise<QlooEntity[]> {
  const { brief, anchorEntities, tags, receipts, warnings } = context;

  const signalEntities = anchorEntities.map((entity) => entity.entity_id);
  const eraFloor = eraToYearFloor(brief.era);

  // `signal.interests.tags` scores candidates but does not restrict them. On the
  // hackathon key it returns the same 14 entities for death metal as for polka,
  // so a brief with no named reference was served an identical candidate set
  // whatever its genre — the ranking then fell back to popularity, and two
  // unrelated briefs produced the same slate. `filter.tags` is the parameter
  // that actually scopes the candidate set, and it is applied only when there is
  // no anchor: a resolved anchor already differentiates the result, so the
  // anchored path is left exactly as it was.
  //
  // `filter.tags` is a union, not an intersection — every tag widens the set —
  // so only genre tags are allowed to scope it. Adding a broad mood tag (Qloo's
  // `urn:tag:style:qloo:energetic`, say) pulled the generic pool back in, which
  // is why the filter is built from `selectFilterTags` rather than every tag.
  // Mood and style tags still travel in `signal.interests.tags` for scoring.
  const exactTags = signalEntities.length === 0 ? selectFilterTags(tags) : [];

  const request = (filterTags: string[] | undefined) =>
    insights({
      filterType: "urn:entity:artist",
      signalEntities,
      signalTags: toTagSignals(tags),
      filterTags,
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

  let call: QlooCallResult<QlooEntity[]>;
  let appliedTags: TagResult[] | undefined;
  let broadenedFrom: string | undefined;

  if (exactTags.length > 0) {
    // The brief's own genre tags are tried first and only broadened if they
    // match nothing, so a successful exact query is never widened.
    const resolved = await resolveCandidatePool(exactTags, request, receipts, warnings);
    call = resolved.call;
    appliedTags = resolved.filters;
    broadenedFrom = resolved.broadenedFrom;
  } else {
    call = await request(undefined);
  }

  const tagScoped = appliedTags !== undefined;
  // Discovery must scope with whatever actually produced the primary slate, so a
  // broadened brief does not get an exact-genre discovery half.
  context.appliedGenreFilter = appliedTags;

  if (exactTags.length > 0 && call.ok && call.data.length === 0) {
    // Every scoped attempt — the exact genre and each bounded broadening —
    // matched nothing. Record the empty scoped attempt so the evidence shows
    // what was tried, then fall back to the unscoped ranking and say plainly
    // that the slate is not filtered.
    receipts.push(
      receiptFrom(call, "GET /v2/insights", "Artist affinity (tag filter, no match)"),
    );
    call = await request(undefined);
    context.appliedGenreFilter = undefined;
    warnings.push(
      "Qloo matched no artists for this brief's genre tags, so the slate fell back to an unscoped ranking. It is not filtered to the brief.",
    );
  } else if (signalEntities.length === 0 && exactTags.length === 0) {
    // No anchor and no genre tag to scope by: the slate is a popularity ranking
    // over the whole catalogue. Say so rather than implying it is brief-specific.
    warnings.push(
      "This brief resolved no genre tag, so the slate could not be filtered to it and is not brief-specific — add a film, show or artist to give the ranking an anchor.",
    );
  }

  let filterNote: string | undefined;
  if (broadenedFrom !== undefined) {
    const names = exactTags.map((tag) => tag.name).join(", ");
    filterNote =
      `Candidate pool scoped by the broader genre ${appliedTags!.map((tag) => tag.name).join(", ")}, ` +
      `because the brief's own genre tag${exactTags.length === 1 ? "" : "s"} (${names}) matched no artists. ` +
      "Mood and style tags informed affinity only, because filter.tags is a union and a broad mood tag would widen the pool.";
  } else if (tagScoped) {
    const names = exactTags.map((tag) => tag.name).join(", ");
    filterNote =
      `Candidate pool scoped by genre tag${exactTags.length === 1 ? "" : "s"} ${names}. ` +
      "Mood and style tags informed affinity only, because filter.tags is a union and a broad mood tag would widen the pool.";
  } else if (signalEntities.length === 0) {
    filterNote =
      "No genre tag was available to scope the candidate pool, so this ranking is not brief-specific.";
  }

  receipts.push(
    receiptFrom(call, "GET /v2/insights", "Artist affinity (explainability on)", filterNote),
  );

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
    return [];
  }

  // Rank by affinity, then by popularity. The tiebreak matters: a tag-only
  // signal (no named references in the brief) comes back with a single uniform
  // affinity score, so affinity alone leaves the order arbitrary.
  const ranked = [...call.data].sort(
    (a, b) => (b.affinity ?? 0) - (a.affinity ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0),
  );

  const spread = (ranked[0].affinity ?? 0) - (ranked[ranked.length - 1].affinity ?? 0);
  if (signalEntities.length === 0 && Math.abs(spread) < 0.001) {
    warnings.push(
      "No named references in the brief and no affinity spread across the candidates, so cues are ordered by popularity rather than affinity — add a film, director or artist to get true affinity ranking.",
    );
  }

  return ranked;
}

/**
 * Resolve one artist's momentum via the trending endpoint. Kept per-artist so a
 * single failure degrades one cue rather than the whole sheet.
 *
 * Qloo exposes momentum through `population_rank_velocity` / `population_percent_delta`
 * on the first point of the series. The rank and percentile fields are treated
 * as a fallback because the hackathon sandbox returns a frozen snapshot in which
 * they are constant, and reporting a fabricated trend would be worse than
 * reporting none.
 */
export async function artistMomentum(
  artistId: string,
  receipts: Receipt[],
): Promise<number> {
  const end = new Date();
  const start = new Date(end.getTime() - 1000 * 60 * 60 * 24 * MOMENTUM_WINDOW_DAYS);
  const iso = (date: Date) => date.toISOString().slice(0, 10);

  const call = await trending(artistId, "urn:entity:artist", iso(start), iso(end));
  receipts.push(receiptFrom(call, "GET /v2/trending", "Artist momentum"));
  if (!call.ok || call.data.length === 0) return 0;

  const scored = [...call.data].sort((a, b) => a.date.localeCompare(b.date));
  const first = scored[0];
  const last = scored[scored.length - 1];

  // Rank movement is the most direct momentum signal: a shrinking rank number
  // means the artist is climbing. A 5% rank move is treated as meaningful.
  const rankVelocity = last.rankVelocity ?? 0;
  const percentDelta = last.percentDelta ?? 0;
  if (Number.isFinite(rankVelocity) && rankVelocity !== 0) {
    const relative = first.rank ? rankVelocity / Math.max(first.rank, 1) : rankVelocity;
    if (relative > 0.05) return 1;
    if (relative < -0.05) return -1;
  }
  if (Number.isFinite(percentDelta) && percentDelta !== 0) {
    if (percentDelta > 0.02) return 1;
    if (percentDelta < -0.02) return -1;
  }

  // Fallback for snapshots that omit velocity: compare the series endpoints.
  const firstPct = first.percentile ?? NaN;
  const lastPct = last.percentile ?? NaN;
  if (Number.isFinite(firstPct) && Number.isFinite(lastPct)) {
    const delta = lastPct - firstPct;
    if (delta > 0.02) return 1;
    if (delta < -0.02) return -1;
  }

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

  const call = await compareGroups(a, b, "urn:entity:artist", {
    a: groupA.map((entity) => entity.name).join(" + ") || "Direction A",
    b: groupB.map((entity) => entity.name).join(" + ") || "Direction B",
  });
  receipts.push(receiptFrom(call, "GET /v2/analysis/compare", "Direction A/B compare"));
  if (!call.ok) return undefined;

  return call.data;
}

/** Location-aware regional affinity, used for the "where does this land" panel. */
export async function regionalAffinity(
  context: GroundingContext,
): Promise<RegionAffinity[]> {
  const { brief, anchorEntities, tags, receipts } = context;
  if (!brief.region) return [];

  const call = await insights({
    filterType: "urn:entity:artist",
    signalEntities: anchorEntities.map((entity) => entity.entity_id),
    signalTags: toTagSignals(tags),
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

/** Cross-domain discovery: adjacent artists Qloo surfaces beyond the direct signal. */
export async function discoveryBackfill(
  context: GroundingContext,
  excludeIds: string[],
): Promise<QlooEntity[]> {
  const { brief, anchorEntities, tags, receipts, appliedGenreFilter } = context;
  // Same reason as the primary call: tag *signals* do not scope the candidate
  // set, so without a filter two different briefs were handed the same discovery
  // picks. Applied only when the brief resolved no anchor, matching the primary
  // call, and limited to genre tags for the same union reason — a broad mood tag
  // would widen the pool and hand back the generic set. A filter that matches
  // nothing simply yields no discovery rows; the sheet keeps its primary picks.
  //
  // `appliedGenreFilter` is the scope the primary slate actually came from. When
  // the primary had to broaden a leaf genre, discovery broadens with it; using
  // the brief's exact tag here would filter the discovery half by a genre the
  // primary half already proved empty.
  const signalEntities = anchorEntities.map((entity) => entity.entity_id);
  const scopedTags =
    signalEntities.length === 0 ? (appliedGenreFilter ?? selectFilterTags(tags)) : [];
  const tagFilter = scopedTags.length > 0 ? scopedTags.map((tag) => tag.tag_id) : undefined;

  const call = await insights({
    filterType: "urn:entity:artist",
    signalEntities,
    signalTags: toTagSignals(tags),
    filterTags: tagFilter,
    excludeEntities: excludeIds,
    // Hold discovery picks to the same brief constraints as the primary picks,
    // otherwise a "late-90s" brief can surface contemporary artists in the
    // discovery slots and the two halves of the sheet stop being comparable.
    demographics: {
      age: brief.audience.age,
      gender: brief.audience.gender,
      audiences: brief.audience.audiences,
    },
    releaseYearMin: eraToYearFloor(brief.era),
    extra: { "backfill.cross_domain.take": 6 },
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
  const labels = buildLabelMap(context);
  const label = (entry: { entity_id: string; name?: string }) =>
    entry.name || labels.get(entry.entity_id) || entry.entity_id;

  if (anchorEntities.length > 0) {
    const topAnchor = anchorEntities[0].name;
    reasons.push(
      `Audiences who like ${topAnchor} also index highly for ${entity.name} in Qloo's taste graph.`,
    );
  }

  const contributions = (entity.explainability ?? []).filter((entry) => entry.score > 0);
  if (contributions.length > 0) {
    const drivers = contributions.slice(0, 2).map(label);
    reasons.push(
      `Qloo attributes the match to ${drivers.join(" and ")} (weight ${contributions[0].score.toFixed(2)}).`,
    );
  }

  if (brief.audience.age) {
    reasons.push(
      `Over-indexes with the ${brief.audience.age.replace(/_/g, " ")} audience the brief targets.`,
    );
  }

  if (momentum > 0) {
    reasons.push("Climbing Qloo population rank over the trend window, so the cue reads current rather than nostalgic.");
  } else if (momentum < 0) {
    reasons.push("Falling Qloo population rank over the trend window, which suits a scene that needs distance or melancholy.");
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

  // Qloo's explainability payload carries entity IDs but no names, so resolve
  // them against everything the brief already grounded. Without this the UI
  // renders bare UUIDs.
  const labels = buildLabelMap(context);
  const explainability = (entity.explainability ?? []).map((entry) => ({
    ...entry,
    name: entry.name ?? labels.get(entry.entity_id),
  }));

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
    explainability,
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
    discovery: entity.backfill,
  };
}

export { normaliseEntity };
