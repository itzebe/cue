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

function flattenParams(
  params: Record<string, string | string[] | number | boolean | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return out;
}

/**
 * Perform a GET against Qloo. Never throws: transport and HTTP failures are
 * reported through the result envelope so one dead call cannot break a cue sheet.
 */
async function qlooGet<T>(
  endpoint: string,
  params: Record<string, string | string[] | number | boolean | undefined>,
  normalise: (json: unknown) => T,
  emptyValue: T,
): Promise<QlooCallResult<T>> {
  const flat = flattenParams(params);
  const query = new URLSearchParams(flat).toString();
  const url = `${QLOO_BASE_URL}${endpoint}${query ? `?${query}` : ""}`;
  const started = Date.now();

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "X-Api-Key": key, accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    const ms = Date.now() - started;

    if (!res.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await res.json()).slice(0, 300);
      } catch {
        detail = await res.text().catch(() => "");
      }
      return {
        ok: false,
        status: res.status,
        ms,
        data: emptyValue,
        params: flat,
        endpoint,
        error: `${res.status} ${detail}`.trim(),
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
  } finally {
    clearTimeout(timer);
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

/** Momentum is derived from Qloo's audience_growth measurement when present. */
function extractMomentum(raw: Record<string, unknown>): number {
  const measurements = asRecord(asRecord(raw.query).measurements);
  const growth = measurements.audience_growth;
  if (typeof growth === "number" && Number.isFinite(growth)) {
    if (growth > 0.02) return 1;
    if (growth < -0.02) return -1;
    return 0;
  }
  return 0;
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
  const inputs =
    asArray(block.inputs).length > 0
      ? asArray(block.inputs)
      : asArray(block.signal_interests_entities);
  return inputs
    .map((entry) => {
      const record = asRecord(entry);
      return {
        entity_id: str(record.entity_id ?? record.id),
        name: str(record.name) || undefined,
        score: num(record.score ?? record.contribution ?? record.weight),
      };
    })
    .filter((entry) => entry.entity_id.length > 0);
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
          return {
            entity_id: id,
            name,
            type: str(record.subtype ?? record.type),
            subtype: str(record.subtype) || undefined,
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
  signalEntities?: string[];
  signalTags?: string[];
  filterTags?: string[];
  excludeTags?: string[];
  demographics?: { age?: string; gender?: string; audiences?: string[] };
  locationQuery?: string;
  locationRadius?: number;
  biasTrends?: "off" | "very_low" | "low" | "mid" | "medium" | "high" | "very_high";
  popularityMin?: number;
  popularityMax?: number;
  releaseYearMin?: number;
  explainability?: boolean;
  take?: number;
  extra?: Record<string, string | string[] | number | boolean | undefined>;
}

/** GET /v2/insights — the primary recommendation + explainability endpoint. */
export function insights(
  params: InsightsParams,
): Promise<QlooCallResult<QlooEntity[]>> {
  const query: Record<string, string | string[] | number | boolean | undefined> = {
    "filter.type": params.filterType,
    "signal.interests.entities": params.signalEntities,
    "signal.interests.tags": params.signalTags,
    "filter.tags": params.filterTags,
    "filter.exclude.tags": params.excludeTags,
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

  return qlooGet("/v2/insights", query, normaliseEntities, []);
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
      "filter.tag.types": tagTypes,
      "feature.typo_tolerance": "true",
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

/** GET /v2/analysis/compare — head-to-head between two creative directions. */
export function compareGroups(
  groupA: string[],
  groupB: string[],
  filterType: string,
  take = 10,
): Promise<QlooCallResult<QlooEntity[]>> {
  return qlooGet(
    "/v2/analysis/compare",
    {
      "a.signal.interests.entities": groupA,
      "b.signal.interests.entities": groupB,
      "filter.type": filterType,
      take,
    },
    normaliseEntities,
    [],
  );
}

export interface TrendingPoint {
  date: string;
  rank?: number;
  velocity?: number;
  acceleration?: number;
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
        return {
          date: str(record.date ?? record.week ?? record.start_date),
          rank: typeof record.rank === "number" ? record.rank : undefined,
          velocity: typeof record.velocity === "number" ? record.velocity : undefined,
          acceleration:
            typeof record.acceleration === "number" ? record.acceleration : undefined,
          percentile:
            typeof record.population_percentile === "number"
              ? record.population_percentile
              : undefined,
        } satisfies TrendingPoint;
      });
    },
    [],
  );
}
