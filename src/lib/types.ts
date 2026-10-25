/**
 * Shared domain types for Cue.
 *
 * Qloo's taxonomy calls films/shows "entities" and returns affinity scores
 * normalised to 0..1. We keep Qloo's own field names where they exist so the
 * mapping between our UI and the API stays obvious.
 */

import type { AudienceBrief } from "./audience";
import type { ComparablesResult } from "./comparables";
import type { CastingResult } from "./casting";
import type { CrossDomainResult } from "./crossdomain";
import type { LocalisationResult } from "./localise";
import type { LicenseQuote } from "./rights";
import type { TasteGapResult } from "./coverage";

export type EntityType =
  | "urn:entity:artist"
  | "urn:entity:movie"
  | "urn:entity:tv_show"
  | "urn:entity:brand"
  | "urn:entity:place"
  | "urn:entity:person"
  | "urn:entity:book"
  | "urn:entity:podcast"
  | "urn:entity:video_game"
  | "urn:entity:destination";

/** A trimmed Qloo entity, only the fields Cue actually renders. */
export interface QlooEntity {
  entity_id: string;
  name: string;
  type: string;
  subtype?: string;
  /** Affinity score 0..1 when returned from /v2/insights. */
  affinity?: number;
  /**
   * Where `affinity` came from.
   *
   * Qloo sometimes omits `query.affinity`, and the client substitutes the entity's
   * popularity so ranking still works. That substitution is invisible in the
   * number itself, so a panel that prints `affinity` as "Qloo affinity" would
   * present a popularity percentile as a measured audience score. Recording the
   * source lets the UI label the two differently instead of guessing.
   */
  affinitySource?: "query" | "popularity";
  popularity?: number;
  description?: string;
  image?: string;
  properties?: Record<string, unknown>;
  tags?: Array<{ tag_id: string; name: string }>;
  /** Per-recommendation explainability, present when feature.explainability=true. */
  explainability?: ExplainabilityEntry[];
  /** Cross-domain / content-based backfill marker. */
  backfill?: boolean;
}

/** One contributing input in a recommendation's explainability block. */
export interface ExplainabilityEntry {
  entity_id: string;
  name?: string;
  /** Normalised 0..1 contribution. Qloo always includes entries >= 0.1. */
  score: number;
  /** Which request signal produced this contribution, e.g. `signal.interests.entities`. */
  signal?: string;
}

export interface SearchResult {
  entity_id: string;
  name: string;
  type: string;
  subtype?: string;
  /** Qloo returns an array of type URNs from /search. */
  types?: string[];
  properties?: Record<string, unknown>;
}

export interface TagResult {
  tag_id: string;
  name: string;
  /**
   * Qloo's own classification of the tag, e.g. `urn:tag:genre:music` or
   * `urn:tag:style:qloo`. `/v2/tags` returns this as `type`; `/v2/search`
   * returns the same value as `subtype`. Callers must not guess tag kinds from
   * the id string when this is available.
   */
  type?: string;
  subtype?: string;
  types?: string[];
}

/** The structured read of a scene brief, produced by the LLM or the parser. */
export interface SceneBrief {
  title: string;
  /** Raw free text the user pasted. */
  raw: string;
  mood: string[];
  genre: string[];
  era: string;
  setting: string;
  /** Emotional arc the scene needs to hit. */
  arc: string;
  /** Who this scene is made for. */
  audience: {
    age?: string;
    gender?: string;
    audiences?: string[];
  };
  region?: string;
  /** Named anchors the user referenced (directors, comparable films, artists). */
  anchors: string[];
  /** Whether music is inside the story world (a car radio) or scoring it. */
  diegetic: boolean;
}

/** A single music recommendation, fully grounded. */
export interface Cue {
  id: string;
  artist: string;
  artistId?: string;
  /** Concrete track suggestion, informed by the artist's catalogue. */
  track: string;
  album?: string;
  year?: string;
  /** Qloo affinity for this artist against the scene's taste profile. */
  affinity: number;
  popularity: number;
  /** Trend momentum: +1 rising, 0 flat, -1 cooling. */
  momentum: number;
  image?: string;
  /** Human-readable reasons, each traceable to a Qloo signal. */
  why: string[];
  /** Explainability contributions from Qloo inputs. */
  explainability: ExplainabilityEntry[];
  /** How this cue performs against the target audience. */
  audienceFit?: Record<string, number>;
  /** Role in the scene: needle drop, score bed, transition, credits. */
  placement: "needle_drop" | "score_bed" | "transition" | "title_card";
  /** Licensing-readiness hint, useful to a real supervisor. */
  clearance: "indie_friendly" | "major_label" | "unknown";
  risk: string;
  confidence: number;
  /**
   * True when this pick came from the cross-domain backfill query rather than
   * the primary affinity query. The two are separate Qloo calls, so their
   * affinity numbers are not directly comparable and the UI says so.
   */
  discovery?: boolean;
  /**
   * True when no track was proposed (no LLM configured). The UI renders this as
   * a pending selection rather than a song title, because inventing one would be
   * exactly the failure Cue exists to avoid.
   */
  trackUnverified?: boolean;
  /**
   * The scene reader's one-line reason for proposing this specific cut.
   *
   * Kept apart from `why` on purpose. `why` is the evidence trail and every entry
   * in it is traceable to a Qloo signal; this string is model-written prose. It
   * used to be prepended to `why`, which put an LLM sentence underneath a heading
   * that said "Why Qloo ranked this" and inside a panel badged "taste graph
   * grounded" — the model's words attributed to the taste graph. Two different
   * sources have to stay two different fields, or the attribution is a lie.
   */
  proposalRationale?: string;
}

/**
 * How far a cue sheet actually got.
 *
 * `mode` alone cannot answer this: it records that live calls were *attempted*,
 * not that the workflow succeeded. A rejected Qloo key produced a sheet with
 * `mode: "live"`, zero cues and a green "live" badge, which reads as success.
 * The status is computed from the receipts and the scene read, so the badge and
 * the sheet can never disagree.
 *
 * - `live`     — every required step ran: Qloo ranked the artists and the scene
 *                reader (when one is configured) produced the brief.
 * - `degraded` — the sheet is usable, but something in the workflow failed. The
 *                `reasons` say what.
 * - `failed`   — a required integration failed, so the requested workflow could
 *                not complete.
 * - `empty`    — Qloo answered normally and matched nothing. A real absence of
 *                results, not a fault.
 * - `fixture`  — no Qloo key, so this is a cached example rather than live data.
 */
export type SheetStatusKind = "live" | "degraded" | "failed" | "empty" | "fixture";

export interface SheetStatus {
  kind: SheetStatusKind;
  /** Short badge text: "live", "degraded", "failed", "no results", "fixture". */
  label: string;
  /** One sentence explaining the state, in terms the reader can act on. */
  detail: string;
  /**
   * The specific faults behind a `degraded` or `failed` sheet, one per line.
   * Empty for every other kind, so the UI never shows a reason list on a healthy
   * run.
   */
  reasons: string[];
}

export interface CueSheet {
  brief: SceneBrief;
  cues: Cue[];
  /**
   * How the scene brief was actually produced, and why, when it was not the
   * model. The UI reports this so "the LLM read your scene" is never implied
   * when the deterministic parser ran instead.
   */
  sceneParse?: {
    source: "llm" | "deterministic";
    /** The provider that supplied the brief. Null when the model did not run. */
    provider?: string | null;
    /** Present when a configured provider was tried and failed. */
    failureReason?: string;
    failureStatus?: number | null;
    /**
     * The provider's own error code, e.g. Groq's `tool_use_failed`. Names the
     * cause a bare status cannot: without it an unclassified 400 reads only as
     * "the provider returned 400".
     */
    failureProviderCode?: string | null;
    /** Operator-facing sentence, e.g. "the provider reports no remaining credits". */
    failureMessage?: string;
    /** Providers tried, in order, when more than one was configured. */
    triedProviders?: string[];
  };
  /** Head-to-head of two creative directions via /v2/analysis/compare. */
  directionCompare?: {
    aLabel: string;
    bLabel: string;
    /** Taste tags both directions share — the shared-audience read. */
    shared: string[];
    /** Taste tags unique to each direction. */
    aOnly: string[];
    bOnly: string[];
    /** Overlap ratio 0..1. */
    overlap: number;
    verdict: string;
  };
  /** The generic, ungrounded answer, shown for the side-by-side. */
  baseline: {
    cues: Array<{ artist: string; track: string; why: string }>;
    note: string;
    /**
     * Whether these lines came from the model or are a fixed sample. The panel
     * must not attribute sample text to the LLM when the call did not happen.
     */
    source?: "llm" | "sample";
  };
  /** Regional affinity for the brief's target market, when one was named. */
  regionAffinity?: RegionAffinity[];
  /** Which Qloo endpoints actually ran, with latency, for the receipt panel. */
  receipts: Receipt[];
  warnings: string[];
  mode: "live" | "fixture";
  /**
   * Whether a language model is configured for this deployment.
   *
   * The client needs this to tell "the model failed" from "there is no model",
   * which are different situations with different explanations. It is a boolean
   * only — never a key, a name or a length.
   */
  llmConfigured?: boolean;
  /**
   * Whether the requested workflow actually completed, and if not, why. Computed
   * from the receipts and the scene read, never from `mode` or the HTTP status.
   */
  status?: SheetStatus;
  /**
   * Cross-domain extensions. These exist to demonstrate that the same audience
   * measurement answers questions beyond music — casting and market fit are the
   * same call against a different entity type or location.
   */
  casting?: CastingResult;
  localisation?: LocalisationResult;
  /**
   * Qloo's own description of who each anchor's audience is. The most direct
   * evidence in the response that cultural data is doing work an LLM cannot, and
   * it costs no extra API calls — it arrives on the anchor search.
   */
  audienceBrief?: AudienceBrief;
  /**
   * Film, TV and book references whose measured audience overlaps the brief's.
   * The same question the cue sheet asks about artists, pointed at the three
   * domains a director actually names when describing a reference.
   */
  comparables?: ComparablesResult;
  /**
   * What else the brief's anchors connect to across the taste graph: brands,
   * destinations, podcasts and places. Same anchors, same measurement, other
   * questions — the broadest form of the cross-domain claim.
   */
  tasteMap?: CrossDomainResult;
  /** Marketplace quotes, keyed by cue id, generated on demand from the sheet. */
  quotes?: LicenseQuote[];
  /**
   * The Taste Gap: how much of the brief's candidate pool taste space the slate
   * reaches, and a revision that reaches more of it. Computed entirely from the
   * tags Qloo already returned on the affinity call, so it costs no extra calls.
   * Absent when the pool was too small or too sparse to measure.
   */
  tasteGap?: TasteGapResult;
}

export interface Receipt {
  endpoint: string;
  label: string;
  params: Record<string, string>;
  status: number;
  ms: number;
  resultCount: number;
  note?: string;
}

/** Per-region affinity, from location-aware insights or the heatmap. */
export interface RegionAffinity {
  name: string;
  affinity: number;
}
