import type { Cue, CueSheet, Receipt, SceneBrief } from "./types";
import {
  chatWithFallback,
  extractJson,
  hasLlm,
  runLlm,
  type LlmAttempt,
  type LlmFailure,
  type LlmSource,
  type ToolSpec,
} from "./llm";
import {
  compareDirections,
  discoveryBackfill,
  groundArtistCues,
  inferClearance,
  inferPlacement,
  regionalAffinity,
  resolveAnchors,
  resolveTags,
  toCue,
  type GroundingContext,
} from "./cues";
import { hasQlooKey } from "./qloo";
import { buildAudienceBrief } from "./audience";
import { comparablesForBrief } from "./comparables";
import { castForBrief, type CastingResult } from "./casting";
import { crossDomainForAudience } from "./crossdomain";
import type { ComparablesResult } from "./comparables";
import type { CrossDomainResult } from "./crossdomain";
import { localiseBrief, type LocalisationResult } from "./localise";
import { computeSheetStatus } from "./status";
import { computeTasteGap } from "./coverage";
import { FIXTURE_SHEET } from "@/data/fixtures";

/**
 * The Cue agent.
 *
 * Responsibilities:
 *  1. Read a scene brief into structure (LLM when available, parser otherwise).
 *  2. Ground it against Qloo, which is the only source of ranking truth.
 *  3. Produce a second, deliberately ungrounded answer for the side-by-side.
 *
 * The LLM never invents affinity numbers. It proposes creative scaffolding
 * (track titles, tone language); Qloo decides what actually ranks.
 */

const SCENE_SCHEMA: ToolSpec = {
  name: "emit_scene_brief",
  description:
    "Emit the structured reading of a film, TV or advertising scene for music supervision.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short working title for the scene." },
      mood: {
        type: "array",
        items: { type: "string" },
        description: "Two to four emotional descriptors.",
      },
      genre: {
        type: "array",
        items: { type: "string" },
        description: "Musical genres implied by the scene.",
      },
      era: { type: "string", description: "Period or era, e.g. 'late 90s' or 'contemporary'." },
      setting: { type: "string", description: "Where and when the scene takes place." },
      arc: { type: "string", description: "The emotional movement the cue must carry." },
      audience: {
        type: "object",
        properties: {
          age: {
            type: "string",
            enum: ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"],
          },
          gender: { type: "string", enum: ["male", "female"] },
        },
      },
      region: { type: "string", description: "Target market or city, if stated." },
      anchors: {
        type: "array",
        items: { type: "string" },
        description:
          "Named works, directors or artists the brief references. These become Qloo signal entities.",
      },
      diegetic: {
        type: "boolean",
        description: "True if music is heard by characters inside the story world.",
      },
    },
    required: ["title", "mood", "genre", "era", "arc", "anchors"],
  },
};

const TRACKS_SCHEMA: ToolSpec = {
  name: "emit_tracks",
  description:
    "For each supplied artist, propose one specific track and a one-line rationale.",
  parameters: {
    type: "object",
    properties: {
      tracks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            artist: { type: "string" },
            track: { type: "string" },
            album: { type: "string" },
            year: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["artist", "track"],
        },
      },
    },
    required: ["tracks"],
  },
};

const SYSTEM_PROMPT = `You are Cue, a music supervisor's assistant.
You read scenes and describe the music they need. You are precise and practical.
You never invent statistics, affinity scores or audience data. You only describe
tone, era, instrumentation, and specific tracks you are confident exist.`;

/** Deterministic scene reader used when no LLM is configured. */
export function parseSceneBrief(raw: string): SceneBrief {
  const text = raw.trim();
  const lower = text.toLowerCase();

  const moodLexicon: Record<string, string> = {
    melancholic: "melancholy",
    melancholy: "melancholy",
    grief: "grief",
    mournful: "mourning",
    sad: "sad",
    lonely: "isolation",
    isolation: "isolation",
    tense: "tension",
    tension: "tension",
    suspense: "suspense",
    ominous: "ominous",
    eerie: "eerie",
    brooding: "brooding",
    noir: "noir",
    hopeful: "hope",
    hope: "hope",
    euphoric: "euphoria",
    romantic: "romance",
    nostalgic: "nostalgia",
    gritty: "gritty",
    dreamy: "dreamlike",
    triumphant: "triumph",
    intimate: "intimacy",
    chaotic: "chaos",
    somber: "somber",
    moody: "moody",
    wistful: "wistful",
    defiant: "defiance",
  };
  const mood = Object.entries(moodLexicon)
    .filter(([needle]) => lower.includes(needle.replace("_", "")))
    .map(([, value]) => value)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 4);

  const genreLexicon: Record<string, string> = {
    hip_hop: "hip hop",
    "hip hop": "hip hop",
    rap: "hip hop",
    jazz: "jazz",
    soul: "soul",
    punk: "punk",
    folk: "folk",
    electronic: "electronic",
    synth: "synthwave",
    rock: "rock",
    classical: "classical",
    orchestral: "orchestral",
    ambient: "ambient",
    country: "country",
    rnb: "r&b",
    "r&b": "r&b",
    funk: "funk",
    disco: "disco",
    gospel: "gospel",
    score: "soundtrack",
    soundtrack: "soundtrack",
    underscore: "soundtrack",
    cinematic: "cinematic",
    indie: "indie",
    pop: "pop",
  };
  const genre = Object.entries(genreLexicon)
    .filter(([needle]) => lower.includes(needle))
    .map(([, value]) => value)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 4);

  const eraMatch = text.match(
    /\b(late|early|mid)?\s?(19\d{2}|20\d{2}|\d{2}s|seventies|eighties|nineties|contemporary|modern|today|current)\b/i,
  );
  const era = eraMatch ? eraMatch[0].trim() : "contemporary";

  // Named references become Qloo signal entities, so this extraction decides
  // whether the sheet gets true affinity ranking or a flat tag-only fallback.
  //
  // Two shapes matter and the previous pattern caught neither: single-word
  // titles ("Drive", "Sicario", "Outkast") and multi-word titles containing a
  // lowercase connector ("Under the Skin", "The Temptations"). Requiring two
  // capitalised words silently dropped every single-word reference, which is
  // most of them.
  const quoted = Array.from(text.matchAll(/"([^"]{2,40})"/g)).map((match) => match[1]);

  // Sentence-initial words are capitalised by grammar rather than by being a
  // name, so they are excluded by position. This is the only reliable signal
  // available without a model.
  // Connectors that appear *inside* titles ("Under the Skin", "The Temptations").
  // "and" is deliberately excluded: it joins a list of names rather than being
  // part of one, so treating it as a connector merges "Bill Withers and Aretha
  // Franklin" into a single bogus entity and orphans "Franklin".
  const CONNECTOR = "(?:the|of|a|an|in|on|to|for|de|la|el|le|du|van|von|al)";
  const WORD = "[A-Z\\u00C0-\\u024F][\\w'\\u00C0-\\u024F\\u2019.-]*";
  const NAME = new RegExp(
    `\\b(${WORD}(?:\\s+(?:${CONNECTOR}\\s+)?${WORD}){1,2})\\b|\\b(${WORD})\\b`,
    "g",
  );

  const regionWords = new Set([
    "new york", "los angeles", "london", "chicago", "atlanta", "miami", "paris",
    "berlin", "tokyo", "seoul", "lagos", "austin", "nashville", "detroit", "toronto",
    // US states and common region suffixes. These are places, so they belong in
    // `region`; as signal entities they return nothing a supervisor can use.
    "michigan", "california", "texas", "georgia", "illinois", "ohio", "oregon",
    "washington", "florida", "louisiana", "tennessee", "massachusetts", "virginia",
    "united states", "united kingdom", "great britain", "america", "england",
  ]);

  // Grammar words that are capitalised for reasons other than naming something.
  const NOT_A_NAME = new Set([
    "a", "an", "the", "and", "but", "or", "so", "then", "we", "i", "she", "he",
    "they", "it", "this", "that", "there", "here", "no", "not", "just", "era",
    "set", "reference", "references", "target", "audience", "brand", "cue", "us",
    "uk", "tv", "am", "pm", "shot", "film", "films", "spot", "series", "open",
    "audience", "score", "scene", "note", "points", "mother", "father",
  ]);

  // A phrase is only a name if it starts with a name-like word. "Set in New
  // York" and "US and UK" are grammatical phrases that happen to be
  // capitalised, and sending them to /search returns nothing useful.
  function looksLikeName(value: string): boolean {
    const tokens = value.split(/\s+/).map((token) => token.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ""));
    if (tokens.length === 0) return false;
    if (NOT_A_NAME.has(tokens[0])) return false;
    // Reject phrases built entirely from grammar words and connectors.
    return tokens.some((token) => token.length > 1 && !NOT_A_NAME.has(token));
  }

  const proper: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = sentence.trimStart();
    for (const match of trimmed.matchAll(NAME)) {
      // A single word at the very start of a sentence is capitalised by position
      // rather than by being a proper noun.
      const isSentenceInitial = (match.index ?? 0) === 0 && trimmed === sentence;
      const value = (match[1] ?? match[2] ?? "").trim();
      if (!value) continue;
      if (isSentenceInitial && !match[1]) continue;
      if (!looksLikeName(value)) continue;
      const normalised = value.toLowerCase().replace(/\s+/g, " ");
      if (regionWords.has(normalised)) continue;
      proper.push(value);
    }
  }

  const anchors = Array.from(new Set([...quoted, ...proper]))
    // Prefer multi-word names: "Under the Skin" is a stronger signal than the
    // bare "Skin" that a single-word pass would also find.
    .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length)
    .slice(0, 5);

  const regionMatch = text.match(
    /\b(New York|Los Angeles|London|Chicago|Atlanta|Miami|Paris|Berlin|Tokyo|Seoul|Lagos|Austin|Nashville|Detroit|Toronto)\b/i,
  );

  const ageMatch = lower.match(/\b(teen|young|20s|30s|40s|50s|60s|senior|older|elder)\b/);
  // Supervisors usually write an age range ("25-34"), so map the lower bound
  // onto Qloo's age buckets rather than only accepting decade words.
  const ageRange = lower.match(/\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b/);
  const rangeFloor = ageRange ? Number(ageRange[1]) : undefined;

  function ageBucket(): string | undefined {
    if (rangeFloor !== undefined) {
      if (rangeFloor <= 24) return "24_and_younger";
      if (rangeFloor <= 29) return "25_to_29";
      if (rangeFloor <= 34) return "30_to_34";
      if (rangeFloor <= 44) return "35_to_44";
      if (rangeFloor <= 54) return "45_to_54";
      return "55_and_older";
    }
    if (!ageMatch) return undefined;
    const token = ageMatch[1];
    if (token === "teen" || token === "young" || token === "20s") return "24_and_younger";
    if (token === "30s") return "30_to_34";
    if (token === "40s") return "35_to_44";
    if (token === "50s") return "45_to_54";
    return "55_and_older";
  }

  const title =
    anchors[0] || text.split(/[.\n]/)[0].slice(0, 48) || "Untitled scene";

  return {
    title,
    raw: text,
    // Neutral fallbacks only. Words like "open"/"unresolved"/"underscore" are
    // not real Qloo tags and previously matched unrelated tags by fuzzy search.
    mood: mood.length > 0 ? mood : ["cinematic"],
    genre: genre.length > 0 ? genre : ["soundtrack"],
    era,
    setting: text.split(/[.\n]/)[0].slice(0, 120),
    arc: "Establish the emotional register, then hold it without resolving.",
    audience: {
      age: ageBucket(),
    },
    region: regionMatch ? regionMatch[0] : undefined,
    anchors,
    diegetic: /radio|car|club|bar|headphones|stereo|tv in|record player|speaker/.test(lower),
  };
}

/**
 * How the scene brief was produced, so the sheet can report it accurately
 * instead of guessing from whether an LLM happens to be configured.
 */
export type SceneParseSource = "llm" | "deterministic";

/** Use the LLM to read the scene, falling back to the deterministic parser. */
async function readScene(
  raw: string,
): Promise<{
  brief: SceneBrief;
  source: SceneParseSource;
  failure: LlmFailure | null;
  provider: LlmSource | null;
  attempts: LlmAttempt[];
}> {
  const { message: response, failure, provider, attempts } = await chatWithFallback(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Read this scene and emit the structured brief.\n\n---\n${raw}\n---`,
      },
    ],
    [SCENE_SCHEMA],
  );

  if (response === null) {
    // A configured provider that did not answer is a different situation from
    // no provider at all. Carry the reason up so the sheet can name it.
    return { brief: parseSceneBrief(raw), source: "deterministic", failure, provider: null, attempts };
  }

  const toolCall = response.tool_calls?.find(
    (call) => call.function.name === "emit_scene_brief",
  );
  const parsed =
    extractJson<Partial<SceneBrief>>(toolCall?.function.arguments ?? null) ??
    extractJson<Partial<SceneBrief>>(response?.content ?? null);

  if (!parsed) {
    // The provider answered but not with a usable brief. Say that explicitly
    // rather than letting it look like an outage.
    return {
      brief: parseSceneBrief(raw),
      source: "deterministic",
      provider: null,
      attempts,
      failure: {
        reason: "empty_response",
        status: 200,
        message: "the model replied without a usable scene brief",
        detail: (response.content ?? "").slice(0, 300),
      },
    };
  }

  const fallback = parseSceneBrief(raw);
  return {
    brief: {
      ...fallback,
      ...parsed,
      raw,
      mood: parsed.mood?.length ? parsed.mood : fallback.mood,
      genre: parsed.genre?.length ? parsed.genre : fallback.genre,
      anchors: parsed.anchors?.length ? parsed.anchors : fallback.anchors,
      audience: { ...fallback.audience, ...(parsed.audience ?? {}) },
    },
    source: "llm",
    failure: null,
    provider,
    attempts,
  };
}

/**
 * Ask the LLM to name concrete tracks for the Qloo-ranked artists.
 * Qloo decides *who*; the LLM only decides *which song* and *why*.
 */
async function proposeTracks(
  artists: string[],
  brief: SceneBrief,
): Promise<Map<string, { track: string; album?: string; year?: string; rationale?: string }>> {
  const out = new Map<
    string,
    { track: string; album?: string; year?: string; rationale?: string }
  >();
  if (artists.length === 0) return out;

  const response = await runLlm(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Scene: ${brief.setting}
Mood: ${brief.mood.join(", ")}
Era: ${brief.era}
Arc: ${brief.arc}

For each artist below, name one real track that fits this scene. Prefer deep cuts
over obvious hits when the scene needs subtlety. Do not invent tracks.

Artists: ${artists.join("; ")}`,
      },
    ],
    [TRACKS_SCHEMA],
  );

  const toolCall = response?.tool_calls?.find(
    (call) => call.function.name === "emit_tracks",
  );
  const parsed = extractJson<{
    tracks: Array<{ artist: string; track: string; album?: string; year?: string; rationale?: string }>;
  }>(toolCall?.function.arguments ?? response?.content ?? null);

  for (const entry of parsed?.tracks ?? []) {
    if (entry?.artist && entry?.track) {
      out.set(entry.artist.toLowerCase(), {
        track: entry.track,
        album: entry.album,
        year: entry.year,
        rationale: entry.rationale,
      });
    }
  }
  return out;
}

/** The ungrounded answer, produced by the LLM alone. This is the control group. */
async function buildBaseline(
  brief: SceneBrief,
): Promise<CueSheet["baseline"]> {
  // The point of this panel is that the model has no cultural data. It must not
  // also claim to have produced output it did not: when the call fails, the
  // panel says the lines are a fixed sample instead.
  const note =
    "Generated by the LLM with no cultural data. Plausible on the surface, but unverifiable: no affinity, no audience measurement, no momentum.";

  const samples: CueSheet["baseline"]["cues"] = [
    { artist: "Generic library music", track: "Warm Piano Bed #4", why: "Safe, cheap, forgettable." },
    { artist: "Well-known 90s hit", track: "The obvious needle drop", why: "First song anyone names for this decade." },
  ];

  if (!hasLlm()) {
    return { cues: samples, note, source: "sample" };
  }

  const response = await runLlm(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `You have NO cultural data, NO affinity scores and NO audience measurement.
Using only general knowledge, name 3 artists and one track each for this scene.
Do not hedge. Answer as JSON: {"cues":[{"artist":"","track":"","why":""}]}

Scene: ${brief.setting}
Mood: ${brief.mood.join(", ")}
Era: ${brief.era}`,
      },
    ],
  );

  const parsed = extractJson<{ cues: CueSheet["baseline"]["cues"] }>(response?.content ?? null);
  if (!parsed?.cues?.length) {
    // An ungrounded panel that failed to generate is still useful as a fixed
    // example, but it must be labelled as one rather than attributed to the model.
    return {
      cues: samples,
      note:
        "The model did not return a baseline for this scene, so these are a fixed example of the ungrounded answer. The point stands: with no cultural data there is nothing to verify.",
      source: "sample",
    };
  }

  return { cues: parsed.cues, note, source: "llm" };
}

export interface BuildCueSheetOptions {
  scene: string;
  /** Optional second creative direction for the A/B compare. */
  alternativeAnchors?: string[];
  /** Skip live calls and return the bundled fixture (used for offline demos). */
  forceFixture?: boolean;
}

export async function buildCueSheet(
  options: BuildCueSheetOptions,
): Promise<CueSheet> {
  const receipts: Receipt[] = [];
  const warnings: string[] = [];

  if (options.forceFixture || !hasQlooKey()) {
    const reason = options.forceFixture
      ? "Fixture mode requested."
      : "QLOO_API_KEY is not configured, so Cue is serving a cached, pre-computed cue sheet. Add a key to run live.";
    const fixture: CueSheet = {
      ...FIXTURE_SHEET,
      warnings: [reason, ...FIXTURE_SHEET.warnings],
      mode: "fixture",
      llmConfigured: hasLlm(),
    };
    return { ...fixture, status: computeSheetStatus(fixture) };
  }

  const {
    brief,
    source: sceneSource,
    failure: sceneFailure,
    provider: sceneProvider,
    attempts: sceneAttempts,
  } = await readScene(options.scene);
  if (sceneSource === "deterministic") {
    if (!hasLlm()) {
      warnings.push(
        "No LLM configured; using the deterministic scene reader. Specific track titles are left for you to choose.",
      );
    } else if (sceneFailure) {
      // Name the fault. A generic "fell back" line hides an exhausted balance
      // behind a message that reads like an outage, which is what made this
      // invisible in production.
      const tried =
        sceneAttempts.length > 1
          ? ` (tried ${sceneAttempts.map((attempt) => attempt.source).join(", ")})`
          : "";
      warnings.push(
        `Scene parsing fell back to the deterministic reader because ${sceneFailure.message}` +
          (sceneFailure.status ? ` (HTTP ${sceneFailure.status})` : "") +
          `${tried}. Track titles are left for you to choose.`,
      );
    } else {
      warnings.push("Scene parsing fell back to the deterministic reader.");
    }
  } else if (sceneProvider && sceneAttempts.length > 1) {
    // A provider answered only after an earlier one failed. Saying which one
    // succeeded is the difference between "the model ran" and knowing whether
    // the deployment's primary provider is actually healthy.
    const failed = sceneAttempts
      .filter((attempt) => attempt.failure)
      .map((attempt) => `${attempt.source} (${attempt.failure!.message})`);
    if (failed.length > 0) {
      warnings.push(
        `Scene parsed by ${sceneProvider} after ${failed.join(", ")}. The brief below is model-generated.`,
      );
    }
  }

  const context: GroundingContext = {
    brief,
    anchorEntities: [],
    tags: [],
    receipts,
    warnings,
  };

  // Stage 1: resolve the brief into valid Qloo IDs. Invalid inputs are dropped
  // silently by Qloo, so resolution first is what keeps later calls meaningful.
  // Anchors and tags are independent searches, so they resolve concurrently.
  [context.anchorEntities, context.tags] = await Promise.all([
    resolveAnchors(brief.anchors, receipts),
    resolveTags([...brief.genre, ...brief.mood], receipts),
  ]);
  if (context.anchorEntities.length === 0) {
    warnings.push(
      "None of the scene's named references resolved to Qloo entities. Falling back to mood and genre tags.",
    );
  }

  // Stage 2: Qloo ranks the artists. This is the load-bearing call.
  const rankedArtists = await groundArtistCues(context);

  // Stage 3: enrich in parallel, but never let enrichment break the sheet.
  const [regional, backfill] = await Promise.all([
    regionalAffinity(context).catch(() => []),
    discoveryBackfill(
      context,
      rankedArtists.slice(0, 8).map((entity) => entity.entity_id),
    ).catch(() => []),
  ]);

  const combined = [...rankedArtists];
  const seenIds = new Set(combined.map((entity) => entity.entity_id));
  for (const entity of backfill) {
    if (seenIds.has(entity.entity_id)) continue;
    seenIds.add(entity.entity_id);
    // Mark provenance so the cue sheet can say how each pick was found.
    combined.push({ ...entity, backfill: true });
  }

  // Compose the sheet: primary affinity picks first, then the cross-domain
  // discovery picks. Taking a flat slice of `combined` would silently discard
  // every backfill result, because the primary call already returns more rows
  // than the sheet holds.
  //
  // The selection is held as indices into `combined` rather than as entity
  // objects, so the same array can be handed to the Taste Gap measurement: it
  // needs the whole candidate pool *and* which of its members made the slate,
  // and deriving that from names afterwards would be guesswork.
  const primaryIdx = combined.map((_, index) => index).filter((index) => !combined[index].backfill);
  const discoveryIdx = combined.map((_, index) => index).filter((index) => combined[index].backfill);
  const DISCOVERY_SLOTS = 2;
  const SHEET_SIZE = 8;
  const selectedIdx = [
    ...primaryIdx.slice(0, SHEET_SIZE - DISCOVERY_SLOTS),
    ...discoveryIdx.slice(0, DISCOVERY_SLOTS),
  ].slice(0, SHEET_SIZE);
  const selected = selectedIdx.map((index) => combined[index]);

  // The Taste Gap. Pure computation over the tags Qloo already returned on the
  // affinity call — it adds no API calls and no latency. Measured over every
  // candidate the pipeline retrieved for this brief, not just the eight shown.
  const tasteGap = computeTasteGap(combined, selectedIdx, selectedIdx.length);

  // Stages 4 and 5 are independent of each other and of the cross-domain work
  // below, and the LLM track call is the slowest step in the pipeline. Running
  // them concurrently is what keeps a sheet inside the route's time budget.
  const directionPromise = options.alternativeAnchors?.length
    ? resolveAnchors(options.alternativeAnchors, receipts).then((altEntities) =>
        compareDirections(context.anchorEntities, altEntities, receipts),
      )
    : Promise.resolve(undefined);

  // The audience brief is pure computation over the anchor entities the pipeline
  // already fetched: `audience_identity` arrives on the same /v2/search response
  // that resolved them, so this costs no API calls and needs no promise.
  const audienceBrief = buildAudienceBrief(brief.anchors, context.anchorEntities);

  const [trackMap, momentum, directionCompare, baseline, casting, comparables, tasteMap] =
    await Promise.all([
    proposeTracks(
      selected.map((entity) => entity.name),
      brief,
    ),
    Promise.all(selected.map((entity) => artistMomentumSafe(entity.entity_id, receipts))),
    directionPromise,
    buildBaseline(brief),
    // Stage 6: cross-domain. The same audience measurement pointed at people and
    // brands. This is the argument that Cue is a cultural layer rather than a
    // music tool, and it is cheap enough to run on every sheet.
    //
    // Localisation is NOT run here. It costs one slow location-filtered query per
    // market, so it lives behind its own endpoint that the user triggers
    // explicitly — see /api/localise.
    castForBrief(brief, context.anchorEntities, context.tags, receipts).catch(
      (): CastingResult => ({ audience: "", candidates: [], receipts: [], warnings: [] }),
    ),
    // Stage 7: comparables. Film, TV and books, ranked on the same audience the
    // cue sheet uses. Three calls, run alongside the rest so they cost latency
    // only, not time.
    comparablesForBrief(context.anchorEntities, context.tags, receipts).catch(
      (): ComparablesResult => ({
        groups: [],
        emptyDomains: [],
        skippedDomains: [],
        receipts: [],
        warnings: ["Comparables could not be retrieved for this brief."],
      }),
    ),
    // Stage 8: the cross-domain taste map. Brands, destinations, podcasts and
    // places, measured on the same anchors as the cue sheet. Four calls, run
    // alongside the rest so they cost latency only. The domains are the ones the
    // cue sheet and comparables pass do not already cover, so this adds breadth
    // rather than a second copy of a list the reader has already seen.
    crossDomainForAudience(context.anchorEntities, receipts).catch(
      (): CrossDomainResult => ({
        groups: [],
        emptyDomains: [],
        failedDomains: [],
        skippedDomains: [],
        anchors: [],
        receipts: [],
        warnings: ["Cross-domain discoveries could not be retrieved for this brief."],
      }),
    ),
  ]);

  const cues: Cue[] = selected.map((entity, index) => {
    const proposed = trackMap.get(entity.name.toLowerCase());
    // Without an LLM there is no track proposal, and Cue must not invent one.
    // The artist is Qloo-grounded; the specific cut is left for the supervisor.
    const fallbackTrack = "Track TBD — pick from this artist's catalogue";
    const cue = toCue(entity, index, context, momentum[index] ?? 0, proposed?.track ?? fallbackTrack);
    if (!proposed) cue.trackUnverified = true;
    if (proposed?.album) cue.album = proposed.album;
    if (proposed?.year) cue.year = proposed.year;
    // Not pushed into `why`: that array is Qloo evidence, and this sentence is
    // written by the model. Mixing them mislabels the source (see Cue.proposalRationale).
    if (proposed?.rationale) cue.proposalRationale = proposed.rationale;
    return cue;
  });

  if (cues.length === 0) {
    warnings.push(
      "Qloo returned no artists for this brief. Try adding a named film, show or artist as an anchor.",
    );
  }

  if (casting.candidates.length === 0) {
    casting.warnings.push(
      "No casting candidates returned. This is expected when the brief names only music, since Qloo needs a shared audience cluster to connect people.",
    );
  }

  const sheet: CueSheet = {
    brief,
    cues,
    sceneParse: {
      source: sceneSource,
      provider: sceneProvider,
      failureReason: sceneFailure?.reason,
      failureStatus: sceneFailure?.status ?? null,
      failureProviderCode: sceneFailure?.providerCode ?? null,
      failureMessage: sceneFailure?.message,
      /** Providers tried, in order. Only set when more than one was available. */
      triedProviders: sceneAttempts.length > 1 ? sceneAttempts.map((a) => a.source) : undefined,
    },
    directionCompare,
    baseline,
    regionAffinity: regional.length > 0 ? regional : undefined,
    receipts,
    warnings: [...warnings, ...casting.warnings, ...comparables.warnings, ...tasteMap.warnings],
    mode: "live",
    llmConfigured: hasLlm(),
    casting: casting.candidates.length > 0 ? casting : undefined,
    audienceBrief,
    comparables: comparables.groups.length > 0 ? comparables : undefined,
    // Kept whenever the query actually ran, even if every domain came back empty
    // or failed. The panel renders an honest empty state from that; dropping it
    // here would make "Qloo returned nothing" indistinguishable from "this
    // feature does not exist", which is the confusion the empty state exists to
    // prevent. A brief with no anchors is still dropped — there the panel has
    // nothing truthful to say.
    tasteMap: tasteMap.anchors.length > 0 ? tasteMap : undefined,
    // Always present, even when unmeasurable: the panel shows `unavailableReason`
    // in that case. Dropping the field would make "Qloo returned no measurable
    // pool" indistinguishable from "this feature does not exist".
    tasteGap,
  };

  // Computed last, from the assembled sheet, so the status is derived from what
  // the pipeline actually produced rather than from any intermediate assumption.
  return { ...sheet, status: computeSheetStatus(sheet) };
}

export interface LocaliseOptions {
  scene: string;
  /** The reference market, compared against `markets`. */
  referenceMarket: string;
  markets: string[];
  forceFixture?: boolean;
}

/**
 * Standalone localisation entry point, served by /api/localise.
 *
 * This deliberately re-resolves the anchors and tags from the scene text rather
 * than accepting them from the client. The client could send them, but that
 * would let a caller pair one brief's anchors with another's market and produce
 * a result no part of the pipeline can vouch for. Re-resolving costs two cheap
 * calls and keeps the output attributable to a single brief.
 */
export async function localiseForScene(
  options: LocaliseOptions,
): Promise<LocalisationResult> {
  const receipts: Receipt[] = [];
  const { brief } = await readScene(options.scene);
  const anchors = await resolveAnchors(brief.anchors, receipts);
  const tags = await resolveTags([...brief.genre, ...brief.mood], receipts);

  return localiseBrief(anchors, tags, options.referenceMarket, options.markets, receipts);
}

/** Trending failures should never surface as user-facing errors. */
async function artistMomentumSafe(
  artistId: string,
  receipts: Receipt[],
): Promise<number> {
  try {
    const { artistMomentum } = await import("./cues");
    return await artistMomentum(artistId, receipts);
  } catch {
    return 0;
  }
}

export { inferClearance, inferPlacement };
