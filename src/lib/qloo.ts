import type {
  QlooEntity,
  SearchResult,
  TagResult,
  ExplainabilityEntry,
} from "./types";

/**
 * Thin, dependency-free client for the Qloo Insights API.
 *
 * Two behaviours of the API shape this code:
 *  1. Unsupported parameters are silently ignored, so a "successful" response
 *     with an empty entity list usually means a bad parameter, not missing data.
 *     Every call therefore returns a receipt so the UI can show what ran.
 *  2. Response envelopes vary between endpoints (`results.entities`,
 *     `results.tags`, bare arrays). Normalisation is centralised here.
 */

export const QLOO_BASE_URL =
  process.env.QLOO_API_BASE_URL?.replace(/\/$/, "") ||
  "https://hackathon.api.qloo.com";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;

/**
 * Qloo rate-limits the hackathon key aggressively, and a cue sheet fires a
 * dozen-plus calls at once. A 429 or 5xx is retried with exponential backoff so
 * a burst degrades into a slower run rather than empty cues.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounds how many Qloo calls are in flight at once, to stay under the rate limit. */
const MAX_CONCURRENCY = 4;
let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

export interface QlooCallResult<T> {
  ok: boolean;
  status: number;
  ms: number;
  data: T;
  params: Record<string, string>;
  endpoint: string;
  error?: string;
}

function apiKey(): string {
  return (
    process.env.QLOO_API_KEY ||
    process.env.Qloo_API_KEY ||
    process.env.qloo_api_key ||
    ""
  );
}

export function hasQlooKey(): boolean {
  return apiKey().length > 0;
}

/** A tag signal. Qloo rejects bare tag strings and requires `{tag, weight}` objects. */
export interface TagSignal {
  tag: string;
  weight?: number;
}

type ParamValue =
  | string
  | number
  | boolean
  | string[]
  | TagSignal[]
  | undefined;

function flattenParams(params: Record<string, ParamValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      // An empty array must be omitted entirely. Sending `key=` makes Qloo
      // reject the request with 400 ("must be an array of at least one
      // element") rather than ignoring the parameter.
      if (value.length === 0) continue;
      out[key] =
        typeof value[0] === "object"
          ? JSON.stringify(value)
          : (value as string[]).join(",");
      continue;
    }
    out[key] = String(value);
  }
  return out;
}

/**
 * Perform a GET against Qloo. Never throws: transport and HTTP failures are
 * reported through the result envelope so one dead call cannot break a cue sheet.
 */
async function qlooGet<T>(
  endpoint: string,
  params: Record<string, ParamValue>,
  normalise: (json: unknown) => T,
  emptyValue: T,
  options: { timeoutMs?: number } = {},
): Promise<QlooCallResult<T>> {
  const flat = flattenParams(params);
  const query = new URLSearchParams(flat).toString();
  const url = `${QLOO_BASE_URL}${endpoint}${query ? `?${query}` : ""}`;
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const key = apiKey();
  if (!key) {
    return {
      ok: false,
      status: 0,
      ms: 0,
      data: emptyValue,
      params: flat,
      endpoint,
      error: "QLOO_API_KEY is not set",
    };
  }

  try {
    let res: Response | undefined;
    let lastError = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // A fresh controller per attempt. Reusing one across attempts means the
      // first attempt's budget silently covers the retries, so a slow-but-
      // recoverable endpoint aborts before it is ever retried.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        res = await withSlot(() =>
          fetch(url, {
            method: "GET",
            headers: { "X-Api-Key": key, accept: "application/json" },
            signal: controller.signal,
            cache: "no-store",
          }),
        );
      } catch (error) {
        res = undefined;
        lastError =
          error instanceof Error && error.name === "AbortError"
            ? `request timed out after ${timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : "network error";
      } finally {
        clearTimeout(timer);
      }

      if (!res || !RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) break;

      // Honour Retry-After when the gateway supplies it, else back off 300/900ms.
      const header = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(header) && header > 0
        ? Math.min(header * 1000, 4_000)
        : 300 * 3 ** (attempt - 1);
      lastError = `${res.status} retrying in ${waitMs}ms`;
      await res.text().catch(() => "");
      await sleep(waitMs);
    }

    const ms = Date.now() - started;

    if (!res || !res.ok) {
      const status = res?.status ?? 0;
      let detail = lastError;
      try {
        detail = res ? JSON.stringify(await res.json()).slice(0, 300) : lastError;
      } catch {
        detail = lastError || (await res?.text().catch(() => "")) || "";
      }
      return {
        ok: false,
        status,
        ms,
        data: emptyValue,
        params: flat,
        endpoint,
        error: `${status} ${detail}`.trim(),
      };
    }

    const json = (await res.json()) as unknown;
    return {
      ok: true,
      status: res.status,
      ms,
      data: normalise(json),
      params: flat,
      endpoint,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? "request timed out"
          : err.message
        : "unknown transport error";
    return {
      ok: false,
      status: 0,
      ms,
      data: emptyValue,
      params: flat,
      endpoint,
      error: message,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Normalisers                                                         */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Pull the first array of entities out of any of Qloo's response envelopes. */
function extractEntities(json: unknown): unknown[] {
  const root = asRecord(json);
  const results = asRecord(root.results);
  if (Array.isArray(results.entities)) return results.entities;
  if (Array.isArray(root.results)) return root.results;
  if (Array.isArray(root.entities)) return root.entities;
  if (Array.isArray(json)) return json;
  return [];
}

/**
 * Affinity is exposed inconsistently: `query.affinity` on heatmap-style
 * responses, `query.measurements.affinity` elsewhere, sometimes top-level.
 * Fall back to popularity so the UI always has a usable ranking number.
 */
function extractAffinity(raw: Record<string, unknown>): number {
  const query = asRecord(raw.query);
  const measurements = asRecord(query.measurements);
  const candidates = [
    query.affinity,
    measurements.affinity,
    raw.affinity,
    query.score,
    measurements.score,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return num(raw.popularity, 0);
}

function extractImage(props: Record<string, unknown>): string | undefined {
  const image = props.image;
  if (typeof image === "string") return image;
  const asObj = asRecord(image);
  if (typeof asObj.url === "string") return asObj.url;
  return undefined;
}

function extractExplainability(raw: Record<string, unknown>): ExplainabilityEntry[] {
  const query = asRecord(raw.query);
  const block = asRecord(query.explainability);
  // Qloo namespaces contributions by the parameter that produced them, e.g.
  // `{"signal.interests.entities": [{entity_id, score}]}`. Flatten every such
  // group, keeping the group name so the UI can say *which* signal drove it.
  const entries: ExplainabilityEntry[] = [];

  const pushGroup = (group: unknown, signal: string) => {
    for (const item of asArray(group)) {
      const record = asRecord(item);
      const entity_id = str(record.entity_id ?? record.id ?? record.tag);
      if (!entity_id) continue;
      entries.push({
        entity_id,
        name: str(record.name) || undefined,
        score: num(record.score ?? record.contribution ?? record.weight),
        signal,
      });
    }
  };

  for (const [key, value] of Object.entries(block)) {
    if (key === "inputs") continue;
    pushGroup(value, key);
  }
  // Older/alternate shape: a flat `inputs` array.
  pushGroup(block.inputs, "inputs");

  return entries.sort((a, b) => b.score - a.score);
}

export function normaliseEntity(raw: unknown): QlooEntity | null {
  const record = asRecord(raw);
  const id = str(record.entity_id ?? record.id);
  const name = str(record.name);
  if (!id || !name) return null;

  const props = asRecord(record.properties);
  const tags = asArray(record.tags).map((tag) => {
    const tagRecord = asRecord(tag);
    return {
      tag_id: str(tagRecord.tag_id ?? tagRecord.id),
      name: str(tagRecord.name),
    };
  });

  return {
    entity_id: id,
    name,
    type: str(record.subtype ?? record.type),
    subtype: str(record.subtype) || undefined,
    affinity: extractAffinity(record),
    popularity: num(record.popularity, 0),
    description: str(props.description) || undefined,
    image: extractImage(props),
    properties: props,
    tags: tags.filter((tag) => tag.tag_id),
    explainability: extractExplainability(record),
    backfill:
      record.backfill === true ||
      Boolean(asRecord(record.query).backfill) ||
      str(record.source).toLowerCase().includes("backfill"),
  };
}

function normaliseEntities(json: unknown): QlooEntity[] {
  return extractEntities(json)
    .map(normaliseEntity)
    .filter((entity): entity is QlooEntity => entity !== null);
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

/** GET /search — resolve a human name to a Qloo entity ID. */
export function searchEntities(
  query: string,
  types: string[] = [],
  take = 5,
): Promise<QlooCallResult<SearchResult[]>> {
  return qlooGet(
    "/search",
    { query, types, take },
    (json) => {
      const root = asRecord(json);
      const results = asArray(root.results).length
        ? asArray(root.results)
        : extractEntities(json);
      return results
        .map((item): SearchResult | null => {
          const record = asRecord(item);
          const id = str(record.entity_id ?? record.id);
          const name = str(record.name);
          if (!id || !name) return null;
          // /search returns a `types` array and no `subtype`; other endpoints
          // return `subtype`. Normalise both onto the same fields.
          const types = asArray(record.types).map((type) => String(type));
          const subtype = str(record.subtype) || types[0] || "";
          return {
            entity_id: id,
            name,
            type: subtype || str(record.type),
            subtype: subtype || undefined,
            types: types.length > 0 ? types : undefined,
            properties: asRecord(record.properties),
          };
        })
        .filter((item): item is SearchResult => item !== null);
    },
    [],
  );
}

export interface InsightsParams {
  filterType: string;
  /** Bare Qloo entity IDs (no `urn:` prefix) — Qloo rejects URN-prefixed values here. */
  signalEntities?: string[];
  /** Tag signals. Must be `{tag, weight}` objects; bare tag strings return 400. */
  signalTags?: TagSignal[];
  filterTags?: string[];
  excludeTags?: string[];
  /** Exclude specific entities from results. Comma-separated bare IDs. */
  excludeEntities?: string[];
  demographics?: { age?: string; gender?: string; audiences?: string[] };
  locationQuery?: string;
  locationRadius?: number;
  biasTrends?: "off" | "very_low" | "low" | "mid" | "medium" | "high" | "very_high";
  popularityMin?: number;
  popularityMax?: number;
  releaseYearMin?: number;
  explainability?: boolean;
  take?: number;
  extra?: Record<string, ParamValue>;
  /** Override the default 12s budget. Location-filtered place queries are slow. */
  timeoutMs?: number;
}

/** GET /v2/insights — the primary recommendation + explainability endpoint. */
export function insights(
  params: InsightsParams,
): Promise<QlooCallResult<QlooEntity[]>> {
  const query: Record<string, ParamValue> = {
    "filter.type": params.filterType,
    "signal.interests.entities": params.signalEntities,
    "signal.interests.tags": params.signalTags,
    "filter.tags": params.filterTags,
    "filter.exclude.tags": params.excludeTags,
    "filter.exclude.entities": params.excludeEntities,
    "signal.demographics.age": params.demographics?.age,
    "signal.demographics.gender": params.demographics?.gender,
    "signal.demographics.audiences": params.demographics?.audiences,
    "filter.location.query": params.locationQuery,
    "filter.location.radius": params.locationRadius,
    "bias.trends": params.biasTrends,
    "filter.popularity.min": params.popularityMin,
    "filter.popularity.max": params.popularityMax,
    "filter.release_year.min": params.releaseYearMin,
    "feature.explainability": params.explainability ? "true" : undefined,
    take: params.take ?? 12,
    ...params.extra,
  };

  return qlooGet("/v2/insights", query, normaliseEntities, [], {
    timeoutMs: params.timeoutMs,
  });
}

/** GET /v2/tags — resolve free-text interests into valid Qloo tag IDs. */
export function searchTags(
  query: string,
  tagTypes: string[] = [],
  take = 8,
): Promise<QlooCallResult<TagResult[]>> {
  return qlooGet(
    "/v2/tags",
    {
      "filter.query": query,
      // Must be omitted when empty: Qloo 400s on `filter.tag.types=`.
      "filter.tag.types": tagTypes.length > 0 ? tagTypes : undefined,
      // Typo tolerance is deliberately OFF. With it on, fuzzy matching returns
      // unrelated tags — "tension" resolves to "Venison", "dark" to "Park",
      // "open" to "Oven" — which silently poisons the grounding signal.
      "feature.typo_tolerance": "false",
      take,
    },
    (json) => {
      const root = asRecord(json);
      const results = asRecord(root.results);
      const raw = asArray(results.tags).length
        ? asArray(results.tags)
        : asArray(root.tags).length
          ? asArray(root.tags)
          : asArray(root.results);
      return raw
        .map((item): TagResult | null => {
          const record = asRecord(item);
          const id = str(record.tag_id ?? record.id ?? record.tag_value);
          if (!id) return null;
          return {
            tag_id: id,
            name: str(record.name),
            subtype: str(record.subtype) || undefined,
            types: asArray(record.types).map((type) => String(type)),
          };
        })
        .filter((item): item is TagResult => item !== null);
    },
    [],
  );
}

export interface DirectionCompare {
  aLabel: string;
  bLabel: string;
  /** Tag names both directions share, strongest first. */
  shared: string[];
  /** Tag names that distinguish direction A. */
  aOnly: string[];
  /** Tag names that distinguish direction B. */
  bOnly: string[];
  /** Overlap ratio 0..1 — how much the two readings agree. */
  overlap: number;
  verdict: string;
}

interface CompareTag {
  tag_id: string;
  name: string;
  score: number;
}

function normaliseCompareGroup(raw: unknown): CompareTag[] {
  return asArray(raw)
    .map((item): CompareTag | null => {
      const record = asRecord(item);
      const tag_id = str(record.tag_id ?? record.id);
      const name = str(record.name);
      if (!tag_id || !name) return null;
      const query = asRecord(record.query);
      return {
        tag_id,
        name,
        score: num(query.score ?? record.score ?? record.popularity),
      };
    })
    .filter((tag): tag is CompareTag => tag !== null)
    .sort((a, b) => b.score - a.score);
}

/**
 * GET /v2/analysis/compare — head-to-head between two creative directions.
 *
 * The endpoint returns the *taste tags* each direction over-indexes on
 * (`results.a` / `results.b`), not entities. The intersection of those two tag
 * sets is the shared audience, which is the question a supervisor actually
 * asks: do these two readings pull the same people, or split the room?
 */
export function compareGroups(
  groupA: string[],
  groupB: string[],
  filterType: string,
  labels: { a: string; b: string } = { a: "Direction A", b: "Direction B" },
): Promise<QlooCallResult<DirectionCompare>> {
  const empty: DirectionCompare = {
    aLabel: labels.a,
    bLabel: labels.b,
    shared: [],
    aOnly: [],
    bOnly: [],
    overlap: 0,
    verdict: "",
  };

  return qlooGet(
    "/v2/analysis/compare",
    {
      "a.signal.interests.entities": groupA,
      "b.signal.interests.entities": groupB,
      "filter.type": filterType,
    },
    (json) => {
      const results = asRecord(asRecord(json).results);
      const a = normaliseCompareGroup(results.a);
      const b = normaliseCompareGroup(results.b);

      const bIds = new Set(b.map((tag) => tag.tag_id));
      const aIds = new Set(a.map((tag) => tag.tag_id));
      const shared = a.filter((tag) => bIds.has(tag.tag_id)).map((tag) => tag.name);
      const aOnly = a.filter((tag) => !bIds.has(tag.tag_id)).map((tag) => tag.name);
      const bOnly = b.filter((tag) => !aIds.has(tag.tag_id)).map((tag) => tag.name);

      const denominator = Math.min(a.length, b.length);
      const overlap = denominator > 0 ? shared.length / denominator : 0;

      let verdict: string;
      if (a.length === 0 || b.length === 0) {
        verdict =
          "Qloo had too little signal to compare these directions. Add a named film, show or artist to each.";
      } else if (shared.length === 0) {
        verdict =
          "No shared taste tags between the two directions. Qloo reads these as pulling different audiences — expect the choice to visibly split the room.";
      } else if (overlap >= 0.5) {
        verdict = `${shared.length} taste tags bridge both directions (${Math.round(overlap * 100)}% overlap). Qloo reads them as landing with substantially the same audience, so the difference between them is stylistic rather than a different crowd.`;
      } else {
        verdict = `${shared.length} taste tags bridge both directions — only ${Math.round(overlap * 100)}% overlap. Qloo reads them as related but distinct audiences, so the choice will move who the scene reaches.`;
      }

      return {
        aLabel: labels.a,
        bLabel: labels.b,
        shared: shared.slice(0, 24),
        aOnly: aOnly.slice(0, 12),
        bOnly: bOnly.slice(0, 12),
        overlap,
        verdict,
      };
    },
    empty,
  );
}

export interface TrendingPoint {
  date: string;
  /** Population rank, parsed from Qloo's string field. Lower is more popular. */
  rank?: number;
  /** Rank movement over the period. Positive means climbing. */
  rankVelocity?: number;
  /** Fractional change in population share. */
  percentDelta?: number;
  /** Multiplier on prior-period velocity. */
  velocityFoldChange?: number;
  /** Share of the population, 0..1. */
  percentile?: number;
}

/** GET /v2/trending — weekly popularity time series for one entity. */
export function trending(
  entityId: string,
  filterType: string,
  startDate: string,
  endDate: string,
): Promise<QlooCallResult<TrendingPoint[]>> {
  return qlooGet(
    "/v2/trending",
    {
      "signal.interests.entities": [entityId],
      "filter.type": filterType,
      "filter.start_date": startDate,
      "filter.end_date": endDate,
      take: 12,
    },
    (json) => {
      const root = asRecord(json);
      const results = asRecord(root.results);
      const raw = asArray(results.trending).length
        ? asArray(results.trending)
        : asArray(root.results);
      return raw.map((item) => {
        const record = asRecord(item);
        // `population_rank` arrives as a string ("1007"); parse it so callers
        // can compare ranks numerically.
        const rawRank = record.population_rank;
        const rank =
          typeof rawRank === "number"
            ? rawRank
            : typeof rawRank === "string" && rawRank.trim() !== ""
              ? Number(rawRank)
              : undefined;
        return {
          date: str(record.date ?? record.week ?? record.start_date),
          rank: rank !== undefined && Number.isFinite(rank) ? rank : undefined,
          rankVelocity: num(record.population_rank_velocity, NaN),
          percentDelta: num(record.population_percent_delta, NaN),
          velocityFoldChange: num(record.velocity_fold_change, NaN),
          percentile: num(record.population_percentile, NaN),
        } satisfies TrendingPoint;
      });
    },
    [],
  );
}
