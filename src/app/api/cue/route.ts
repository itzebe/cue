import { NextResponse } from "next/server";
import { buildCueSheet } from "@/lib/planner";
import { hasLlm, llmDiagnostics, probeLlm } from "@/lib/llm";
import { hasQlooKey } from "@/lib/qloo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface CueRequest {
  scene?: unknown;
  alternativeAnchors?: unknown;
  forceFixture?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export async function POST(request: Request) {
  let body: CueRequest;
  try {
    body = (await request.json()) as CueRequest;
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
  if (scene.length > 6000) {
    return NextResponse.json(
      { error: "Scene brief is too long. Keep it under 6000 characters." },
      { status: 400 },
    );
  }

  try {
    const sheet = await buildCueSheet({
      scene,
      alternativeAnchors: asStringArray(body.alternativeAnchors),
      forceFixture: body.forceFixture === true,
    });
    return NextResponse.json(sheet);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Cue could not build a sheet: ${message}` },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const wantProbe = url.searchParams.get("probe") === "1";

  return NextResponse.json({
    service: "cue",
    qlooConfigured: hasQlooKey(),
    llmConfigured: hasLlm(),
    baseUrl: process.env.QLOO_API_BASE_URL || "https://hackathon.api.qloo.com",
    llm: llmDiagnostics(),
    // Opt-in so the health check stays free; the probe spends one upstream call.
    llmProbe: wantProbe ? await probeLlm() : undefined,
  });
}
