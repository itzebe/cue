import { NextResponse } from "next/server";
import { findSubstitutes, type SubstitutionReason } from "@/lib/substitute";
import { DEFAULT_TERMS, type LicenseTerms } from "@/lib/rights";
import { hasQlooKey } from "@/lib/qloo";
import type { Cue, SceneBrief } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Taste-grounded substitution, on demand.
 *
 * A separate endpoint rather than a stage of /api/cue because it costs three to
 * six Qloo calls and only some sheets need it. Every sheet already pays for
 * ranking; making it also pay for a search most supervisors will not run would
 * slow the common path to serve the rare one.
 *
 * The brief and the target cue arrive from the client because both are already
 * server-computed artefacts of the same sheet — re-running the pipeline to
 * recover them would burn 20+ calls to rebuild something the caller already
 * holds. Same trust model as /api/quote: the ranking is recomputed against Qloo
 * here, and only the arithmetic comes from the client's payload.
 */
interface SubstituteRequest {
  brief?: unknown;
  cue?: unknown;
  budget?: unknown;
  terms?: unknown;
  reason?: unknown;
}

function asBrief(value: unknown): SceneBrief | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<SceneBrief>;
  if (typeof raw.raw !== "string") return null;
  const audience = (raw.audience ?? {}) as SceneBrief["audience"];
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    raw: raw.raw,
    mood: Array.isArray(raw.mood) ? raw.mood.filter((m) => typeof m === "string") : [],
    genre: Array.isArray(raw.genre) ? raw.genre.filter((g) => typeof g === "string") : [],
    era: typeof raw.era === "string" ? raw.era : "",
    setting: typeof raw.setting === "string" ? raw.setting : "",
    arc: typeof raw.arc === "string" ? raw.arc : "",
    audience: {
      age: typeof audience.age === "string" ? audience.age : undefined,
      gender: typeof audience.gender === "string" ? audience.gender : undefined,
      audiences: Array.isArray(audience.audiences)
        ? audience.audiences.filter((a) => typeof a === "string")
        : undefined,
    },
    region: typeof raw.region === "string" ? raw.region : undefined,
    anchors: Array.isArray(raw.anchors) ? raw.anchors.filter((a) => typeof a === "string") : [],
    diegetic: raw.diegetic === true,
  };
}

/**
 * A cue is only usable as a substitution target if it is grounded: without an
 * artistId there is no Qloo entity to measure an audience against, and the
 * feature would silently return nothing.
 */
function asCue(value: unknown): Cue | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<Cue>;
  if (typeof raw.id !== "string" || typeof raw.artist !== "string") return null;
  if (typeof raw.artistId !== "string" || raw.artistId.length === 0) return null;
  return {
    id: raw.id,
    artist: raw.artist,
    artistId: raw.artistId,
    track: typeof raw.track === "string" ? raw.track : "",
    affinity: typeof raw.affinity === "number" ? raw.affinity : 0,
    popularity: typeof raw.popularity === "number" ? raw.popularity : 0,
    momentum: typeof raw.momentum === "number" ? raw.momentum : 0,
    why: [],
    explainability: [],
    placement: raw.placement ?? "needle_drop",
    clearance: raw.clearance ?? "unknown",
    risk: "",
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
    discovery: raw.discovery === true,
  };
}

const TERM_YEARS = new Set([1, 3, 10]);
const TERRITORIES = new Set(["worldwide", "north_america", "europe", "single_market"]);
const MEDIA = new Set(["festival", "streaming", "broadcast", "social", "all_media"]);
const REASONS = new Set<SubstitutionReason>(["budget", "clearance", "exclusivity"]);

function asTerms(value: unknown): LicenseTerms {
  if (typeof value !== "object" || value === null) return DEFAULT_TERMS;
  const raw = value as Record<string, unknown>;
  return {
    termYears: TERM_YEARS.has(raw.termYears as number)
      ? (raw.termYears as LicenseTerms["termYears"])
      : DEFAULT_TERMS.termYears,
    territory: TERRITORIES.has(raw.territory as string)
      ? (raw.territory as LicenseTerms["territory"])
      : DEFAULT_TERMS.territory,
    media: MEDIA.has(raw.media as string)
      ? (raw.media as LicenseTerms["media"])
      : DEFAULT_TERMS.media,
    exclusive: raw.exclusive === true,
  };
}

export async function POST(request: Request) {
  let body: SubstituteRequest;
  try {
    body = (await request.json()) as SubstituteRequest;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const brief = asBrief(body.brief);
  if (!brief) {
    return NextResponse.json(
      { error: "A scene brief is required — substitution measures an audience against the brief." },
      { status: 400 },
    );
  }

  const cue = asCue(body.cue);
  if (!cue) {
    return NextResponse.json(
      {
        error:
          "A grounded cue is required as the substitution target. Build the cue sheet first, then substitute against one of its picks.",
      },
      { status: 400 },
    );
  }

  // A budget of zero or a negative number would invert the fee model to a
  // popularity ceiling of zero and return an empty search, which reads as "no
  // substitutes exist" rather than "the request was wrong".
  const budget =
    typeof body.budget === "number" && Number.isFinite(body.budget) && body.budget > 0
      ? body.budget
      : undefined;

  const reason =
    typeof body.reason === "string" && REASONS.has(body.reason as SubstitutionReason)
      ? (body.reason as SubstitutionReason)
      : "budget";

  if (!hasQlooKey()) {
    return NextResponse.json(
      { error: "Qloo is not configured on this deployment, so substitution cannot run." },
      { status: 503 },
    );
  }

  try {
    const result = await findSubstitutes({
      brief,
      target: cue,
      budget,
      terms: asTerms(body.terms),
      reason,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `Substitution failed: ${message}` }, { status: 500 });
  }
}
