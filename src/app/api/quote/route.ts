import { NextResponse } from "next/server";
import { quoteLicense, summariseQuotes, DEFAULT_TERMS, type LicenseTerms } from "@/lib/rights";
import type { Cue } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Price a basket of cues.
 *
 * The cue sheet arrives from the client because the sheet is already a
 * server-computed artefact; re-running the whole Qloo pipeline to price a cart
 * would burn 20+ calls to answer a question that needs none. Pricing is pure
 * arithmetic over the affinity, popularity and momentum Qloo already returned,
 * so no Qloo call is made here at all.
 */
interface QuoteRequest {
  cues?: unknown;
  terms?: unknown;
}

function asCues(value: unknown): Cue[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Cue => {
    if (typeof item !== "object" || item === null) return false;
    const cue = item as Partial<Cue>;
    return typeof cue.id === "string" && typeof cue.artist === "string";
  });
}

const TERM_YEARS = new Set([1, 3, 10]);
const TERRITORIES = new Set(["worldwide", "north_america", "europe", "single_market"]);
const MEDIA = new Set(["festival", "streaming", "broadcast", "social", "all_media"]);

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
  let body: QuoteRequest;
  try {
    body = (await request.json()) as QuoteRequest;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const cues = asCues(body.cues);
  if (cues.length === 0) {
    return NextResponse.json(
      { error: "Select at least one cue to price a clearance request." },
      { status: 400 },
    );
  }
  if (cues.length > 20) {
    return NextResponse.json(
      { error: "Cue can price up to 20 cues in one request." },
      { status: 400 },
    );
  }

  const terms = asTerms(body.terms);
  const quotes = cues.map((cue) => quoteLicense(cue, terms));
  return NextResponse.json(summariseQuotes(quotes));
}
