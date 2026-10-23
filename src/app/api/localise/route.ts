import { NextResponse } from "next/server";
import { localiseForScene } from "@/lib/planner";
import { hasQlooKey } from "@/lib/qloo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Cultural localisation, on demand.
 *
 * This is a separate endpoint rather than a stage of /api/cue because each
 * market is a location-filtered place query that measured up to 19s in
 * isolation and far worse under contention. Bundling it into the cue sheet would
 * make every sheet pay that cost for a feature most sheets do not use.
 */
interface LocaliseRequest {
  scene?: unknown;
  referenceMarket?: unknown;
  markets?: unknown;
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, limit);
}

export async function POST(request: Request) {
  let body: LocaliseRequest;
  try {
    body = (await request.json()) as LocaliseRequest;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const scene = typeof body.scene === "string" ? body.scene.trim() : "";
  if (scene.length < 20) {
    return NextResponse.json(
      { error: "Describe the scene in at least a sentence or two so there is something to ground." },
      { status: 400 },
    );
  }

  const referenceMarket =
    typeof body.referenceMarket === "string" ? body.referenceMarket.trim() : "";
  if (!referenceMarket) {
    return NextResponse.json(
      { error: "A reference market is required — it is the baseline the others are compared to." },
      { status: 400 },
    );
  }

  const markets = asStringArray(body.markets, 4);
  if (markets.length === 0) {
    return NextResponse.json(
      { error: "Name at least one market to compare against the reference." },
      { status: 400 },
    );
  }

  if (!hasQlooKey()) {
    return NextResponse.json(
      { error: "Qloo is not configured on this deployment, so localisation cannot run." },
      { status: 503 },
    );
  }

  try {
    const result = await localiseForScene({ scene, referenceMarket, markets });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Localisation failed: ${message}` },
      { status: 500 },
    );
  }
}
