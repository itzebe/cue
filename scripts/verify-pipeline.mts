/**
 * End-to-end verification of the grounding pipeline.
 *
 * The only thing stubbed is `fetch` — the real HTTP boundary. Every layer under
 * test (normalisation, affinity extraction, explainability parsing, cue
 * assembly, placement/clearance inference) is the production code path, using
 * response bodies shaped like real Qloo payloads.
 *
 * Run: npx tsx scripts/verify-pipeline.ts
 */

import assert from "node:assert/strict";

const QLOO_SEARCH = {
  results: [
    {
      entity_id: "11111111-1111-1111-1111-111111111111",
      name: "Drive",
      type: "urn:entity",
      subtype: "urn:entity:movie",
      properties: { description: "A stunt driver moonlights as a getaway driver." },
    },
  ],
};

const QLOO_TAGS = {
  results: {
    tags: [
      {
        tag_id: "urn:tag:genre:media:thriller",
        name: "Thriller",
        subtype: "urn:tag:genre:media",
      },
    ],
  },
};

const QLOO_INSIGHTS = {
  success: true,
  results: {
    entities: [
      {
        entity_id: "aaaaaaaa-0000-0000-0000-000000000001",
        name: "Cliff Martinez",
        type: "urn:entity",
        subtype: "urn:entity:artist",
        popularity: 0.62,
        properties: {
          description: "Composer known for synth-driven film scores.",
          image: { url: "https://example.test/cliff.jpg" },
        },
        tags: [{ id: "urn:tag:genre:media:synthwave", name: "Synthwave" }],
        query: {
          affinity: 0.93,
          measurements: { audience_growth: 0.08 },
          explainability: {
            inputs: [
              {
                entity_id: "11111111-1111-1111-1111-111111111111",
                name: "Drive",
                score: 0.44,
              },
              { entity_id: "urn:tag:genre:media:thriller", name: "Thriller", score: 0.21 },
            ],
          },
        },
      },
      {
        entity_id: "aaaaaaaa-0000-0000-0000-000000000002",
        name: "Mica Levi",
        type: "urn:entity",
        subtype: "urn:entity:artist",
        popularity: 0.41,
        properties: { description: "Experimental composer." },
        tags: [],
        query: { affinity: 0.88, measurements: { audience_growth: -0.05 } },
      },
      {
        // Missing affinity entirely: exercises the popularity fallback.
        entity_id: "aaaaaaaa-0000-0000-0000-000000000003",
        name: "Jóhann Jóhannsson",
        type: "urn:entity",
        subtype: "urn:entity:artist",
        popularity: 0.55,
        properties: {},
        tags: [],
        query: {},
      },
    ],
  },
  duration: 41,
};

const QLOO_TRENDING = {
  results: {
    trending: [
      { date: "2026-07-01", population_percentile: 0.4, velocity: 0.01 },
      { date: "2026-08-01", population_percentile: 0.55, velocity: 0.04 },
      { date: "2026-09-01", population_percentile: 0.71, velocity: 0.09 },
    ],
  },
};

const QLOO_COMPARE = {
  results: {
    entities: [
      {
        entity_id: "aaaaaaaa-0000-0000-0000-000000000001",
        name: "Cliff Martinez",
        subtype: "urn:entity:artist",
        popularity: 0.6,
      },
    ],
  },
};

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
}

const calls: CapturedCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Route by pathname so the test asserts what the client actually requested.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const parsed = new URL(url);
  calls.push({
    url,
    headers: Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    ),
  });

  if (parsed.pathname === "/search") return jsonResponse(QLOO_SEARCH);
  if (parsed.pathname === "/v2/tags") return jsonResponse(QLOO_TAGS);
  if (parsed.pathname === "/v2/insights") return jsonResponse(QLOO_INSIGHTS);
  if (parsed.pathname === "/v2/trending") {
    // Vary the series per artist so the rising and cooling branches of
    // artistMomentum are both genuinely exercised.
    const id = parsed.searchParams.get("signal.interests.entities") ?? "";
    const cooling = id.endsWith("002");
    return jsonResponse({
      results: {
        trending: cooling
          ? [
              { date: "2026-07-01", population_percentile: 0.8, velocity: -0.02 },
              { date: "2026-08-01", population_percentile: 0.6, velocity: -0.03 },
              { date: "2026-09-01", population_percentile: 0.4, velocity: -0.05 },
            ]
          : QLOO_TRENDING.results.trending,
      },
    });
  }
  if (parsed.pathname === "/v2/analysis/compare") return jsonResponse(QLOO_COMPARE);
  return jsonResponse({ error: "unexpected path" }, 404);
}) as typeof fetch;

process.env.QLOO_API_KEY = "test-key";
// QLOO_API_BASE_URL is deliberately left unset so the module's own default is
// exercised by the final check.
delete process.env.QLOO_API_BASE_URL;
delete process.env.LLM_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.OH_LLM_PROXY_KEY;

const { insights, searchEntities, hasQlooKey, QLOO_BASE_URL } = await import(
  "../src/lib/qloo.ts"
);
const { parseSceneBrief } = await import("../src/lib/planner.ts");
const { eraToYearFloor } = await import("../src/lib/cues.ts");
const { buildCueSheet } = await import("../src/lib/planner.ts");

let passed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`  FAIL ${name}`);
  }
}

console.log("\nCue pipeline verification\n");

await check("API key is detected", () => {
  assert.equal(hasQlooKey(), true);
});

await check("search resolves an entity and sends X-Api-Key", async () => {
  calls.length = 0;
  const result = await searchEntities("Drive", ["urn:entity:movie"], 3);
  assert.equal(result.ok, true);
  assert.equal(result.data[0].name, "Drive");
  assert.equal(calls[0].headers["X-Api-Key"], "test-key");
});

await check("affinity is read from query.affinity", async () => {
  const result = await insights({ filterType: "urn:entity:artist", take: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.data[0].affinity, 0.93);
});

await check("missing affinity falls back to popularity", async () => {
  const result = await insights({ filterType: "urn:entity:artist", take: 5 });
  assert.equal(result.data[2].affinity, 0.55);
});

await check("explainability inputs are parsed with scores", async () => {
  const result = await insights({ filterType: "urn:entity:artist", take: 5 });
  const entries = result.data[0].explainability ?? [];
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "Drive");
  assert.equal(entries[0].score, 0.44);
});

await check("entity image URL is extracted from properties.image.url", async () => {
  const result = await insights({ filterType: "urn:entity:artist", take: 5 });
  assert.equal(result.data[0].image, "https://example.test/cliff.jpg");
});

await check("a non-200 response reports status and does not throw", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ error: "boom" }, 500)) as typeof fetch;
  const result = await insights({ filterType: "urn:entity:artist", take: 5 });
  globalThis.fetch = original;
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.ok(result.error);
});

await check("transport failure degrades to an error result, not an exception", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNRESET");
  }) as typeof fetch;
  const result = await insights({ filterType: "urn:entity:artist", take: 5 });
  globalThis.fetch = original;
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
});

await check("era parsing handles decades, explicit years and 'contemporary'", () => {
  assert.equal(eraToYearFloor("late 90s"), 1990);
  assert.equal(eraToYearFloor("1974"), 1974);
  assert.ok((eraToYearFloor("contemporary") ?? 0) > 2015);
});

await check("deterministic parser extracts mood, era, anchors and diegesis", () => {
  const brief = parseSceneBrief(
    'A 90s noir scene. Rain on the glass, a car radio playing low. Reference "Drive" and Sicario. Set in Los Angeles for a 25-34 audience.',
  );
  assert.ok(brief.mood.length > 0);
  assert.equal(brief.era.includes("90"), true);
  assert.equal(brief.diegetic, true);
  assert.equal(brief.region, "Los Angeles");
  assert.ok(brief.anchors.includes("Drive"));
  assert.equal(brief.audience.age, "25_to_29");
});

await check("full cue sheet assembles from live Qloo data", async () => {
  const sheet = await buildCueSheet({
    scene:
      'A 90s noir thriller. Rain on the glass. Reference "Drive" and Sicario. Los Angeles, audience 25-34.',
  });

  assert.equal(sheet.mode, "live");
  assert.ok(sheet.cues.length >= 3, "expected at least three cues");

  const first = sheet.cues[0];
  assert.equal(first.artist, "Cliff Martinez");
  assert.equal(first.affinity, 0.93);
  assert.equal(first.momentum, 1, "audience_growth 0.08 should read as rising");
  assert.equal(first.placement, "needle_drop");
  assert.equal(first.clearance, "unknown", "popularity 0.62 is mid-band");
  assert.ok(first.why.length > 0);
  assert.ok(first.confidence > 0.5);

  assert.equal(sheet.cues[1].momentum, -1, "audience_growth -0.05 should read as cooling");
  assert.ok(sheet.baseline.cues.length > 0, "baseline must always be present");
  assert.ok(sheet.receipts.length >= 5, "receipts should cover the call chain");
});

await check("every receipt is inspectable and carries parameters", async () => {
  const sheet = await buildCueSheet({
    scene: 'A 90s noir thriller referencing "Drive". Los Angeles, audience 25-34.',
  });
  for (const receipt of sheet.receipts) {
    assert.ok(receipt.endpoint.startsWith("GET "), receipt.endpoint);
    assert.ok(typeof receipt.ms === "number");
    assert.ok(Object.keys(receipt.params).length > 0, `${receipt.label} had no params`);
  }
  const endpoints = new Set(sheet.receipts.map((r) => r.endpoint));
  assert.ok(endpoints.has("GET /search"), "should call /search");
  assert.ok(endpoints.has("GET /v2/insights"), "should call /v2/insights");
});

await check("the explainability flag is actually sent to Qloo", async () => {
  calls.length = 0;
  await buildCueSheet({
    scene: 'A noir scene referencing "Drive". Los Angeles, audience 25-34.',
  });
  const insightCall = calls.find((call) => call.url.includes("/v2/insights"));
  assert.ok(insightCall, "an insights call should have been made");
  assert.ok(
    insightCall.url.includes("feature.explainability=true"),
    "explainability must be requested",
  );
  assert.equal(insightCall.headers["X-Api-Key"], "test-key");
});

await check("fixture mode is used when the key is absent", async () => {
  const saved = process.env.QLOO_API_KEY;
  delete process.env.QLOO_API_KEY;
  const sheet = await buildCueSheet({
    scene: "A scene with enough words to pass validation.",
  });
  process.env.QLOO_API_KEY = saved;
  assert.equal(sheet.mode, "fixture");
  assert.ok(sheet.cues.length > 0);
});

await check("the hackathon base URL is the module default", () => {
  assert.equal(QLOO_BASE_URL, "https://hackathon.api.qloo.com");
});

console.log(`\n${passed} passed, ${failures.length} failed.\n`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
