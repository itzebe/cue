import type { Cue, CueSheet, Receipt, SceneBrief } from "./types";
import { chat, extractJson, hasLlm, resolveLlmConfig, type ToolSpec } from "./llm";
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

  // Quoted phrases and capitalised proper nouns are treated as anchors.
  const quoted = Array.from(text.matchAll(/"([^"]{2,40})"/g)).map((match) => match[1]);
  const proper = Array.from(text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g))
    .map((match) => match[1])
    .filter((value) => !/^(The Scene|A Man|A Woman|New York|Los Angeles)$/.test(value));
  const anchors = Array.from(new Set([...quoted, ...proper])).slice(0, 5);

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

/** Use the LLM to read the scene, falling back to the deterministic parser. */
async function readScene(raw: string): Promise<{ brief: SceneBrief; usedLlm: boolean }> {
  const config = resolveLlmConfig();
  if (!config) return { brief: parseSceneBrief(raw), usedLlm: false };

  const response = await chat(
    config,
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Read this scene and emit the structured brief.\n\n---\n${raw}\n---`,
      },
    ],
    [SCENE_SCHEMA],
  );

  const toolCall = response?.tool_calls?.find(
    (call) => call.function.name === "emit_scene_brief",
  );
  const parsed =
    extractJson<Partial<SceneBrief>>(toolCall?.function.arguments ?? null) ??
    extractJson<Partial<SceneBrief>>(response?.content ?? null);

  if (!parsed) return { brief: parseSceneBrief(raw), usedLlm: false };

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
    usedLlm: true,
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
  const config = resolveLlmConfig();
  if (!config || artists.length === 0) return out;

  const response = await chat(
    config,
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
  const config = resolveLlmConfig();
  const note =
    "Generated by the LLM with no cultural data. Plausible on the surface, but unverifiable: no affinity, no audience measurement, no momentum.";

  if (!config) {
    return {
      cues: [
        { artist: "Generic library music", track: "Warm Piano Bed #4", why: "Safe, cheap, forgettable." },
        { artist: "Well-known 90s hit", track: "The obvious needle drop", why: "First song anyone names for this decade." },
      ],
      note,
    };
  }

  const response = await chat(
    config,
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
  return {
    cues:
      parsed?.cues?.length
        ? parsed.cues
        : [
            { artist: "Generic library music", track: "Warm Piano Bed #4", why: "Safe and forgettable." },
          ],
    note,
  };
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
    return {
      ...FIXTURE_SHEET,
      warnings: [reason, ...FIXTURE_SHEET.warnings],
      mode: "fixture",
    };
  }

  const { brief, usedLlm } = await readScene(options.scene);
  if (!usedLlm) {
    warnings.push(
      hasLlm()
        ? "Scene parsing fell back to the deterministic reader."
        : "No LLM configured; using the deterministic scene reader. Specific track titles are left for you to choose.",
    );
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
  context.anchorEntities = await resolveAnchors(brief.anchors, receipts);
  if (context.anchorEntities.length === 0) {
    warnings.push(
      "None of the scene's named references resolved to Qloo entities. Falling back to mood and genre tags.",
    );
  }
  context.tags = await resolveTags([...brief.genre, ...brief.mood], receipts);

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
  const primary = combined.filter((entity) => !entity.backfill);
  const discovery = combined.filter((entity) => entity.backfill);
  const DISCOVERY_SLOTS = 2;
  const SHEET_SIZE = 8;
  const selected = [
    ...primary.slice(0, SHEET_SIZE - DISCOVERY_SLOTS),
    ...discovery.slice(0, DISCOVERY_SLOTS),
  ].slice(0, SHEET_SIZE);

  // Stage 4: one specific track per Qloo-ranked artist, from the LLM.
  const trackMap = await proposeTracks(
    selected.map((entity) => entity.name),
    brief,
  );

  // Stage 5: momentum per artist, computed from Qloo's own trend series.
  const momentum = await Promise.all(
    selected.map((entity) => artistMomentumSafe(entity.entity_id, receipts)),
  );

  const cues: Cue[] = selected.map((entity, index) => {
    const proposed = trackMap.get(entity.name.toLowerCase());
    // Without an LLM there is no track proposal, and Cue must not invent one.
    // The artist is Qloo-grounded; the specific cut is left for the supervisor.
    const fallbackTrack = "Track TBD — pick from this artist's catalogue";
    const cue = toCue(entity, index, context, momentum[index] ?? 0, proposed?.track ?? fallbackTrack);
    if (!proposed) cue.trackUnverified = true;
    if (proposed?.album) cue.album = proposed.album;
    if (proposed?.year) cue.year = proposed.year;
    if (proposed?.rationale) cue.why = [proposed.rationale, ...cue.why];
    return cue;
  });

  if (cues.length === 0) {
    warnings.push(
      "Qloo returned no artists for this brief. Try adding a named film, show or artist as an anchor.",
    );
  }

  // Optional A/B: a second creative direction the supervisor is weighing.
  let directionCompare: CueSheet["directionCompare"];
  if (options.alternativeAnchors?.length) {
    const altEntities = await resolveAnchors(options.alternativeAnchors, receipts);
    directionCompare = await compareDirections(
      context.anchorEntities,
      altEntities,
      receipts,
    );
  }

  const baseline = await buildBaseline(brief);

  return {
    brief,
    cues,
    directionCompare,
    baseline,
    regionAffinity: regional.length > 0 ? regional : undefined,
    receipts,
    warnings,
    mode: "live",
  };
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
