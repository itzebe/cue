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
import type { Receipt } from "../src/lib/types.ts";

const QLOO_SEARCH = {
  results: [
    {
      entity_id: "11111111-1111-1111-1111-111111111111",
      name: "Drive",
      // Real /search returns a `types` array and no `subtype`.
      types: ["urn:entity:movie"],
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
          explainability: {
            // Real Qloo shape: keyed by the signal that produced the contribution.
            "signal.interests.entities": [
              {
                entity_id: "11111111-1111-1111-1111-111111111111",
                name: "Drive",
                score: 0.44,
              },
            ],
            "signal.interests.tags": [
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
        query: { affinity: 0.88 },
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
      // Real field names; `population_rank` is a string in the live API.
      {
        date: "2026-09-01",
        population_rank: "900",
        population_percentile: 0.71,
        population_rank_velocity: 40,
        population_percent_delta: 0.09,
        velocity_fold_change: 1.1,
      },
      {
        date: "2026-08-01",
        population_rank: "1000",
        population_percentile: 0.55,
        population_rank_velocity: 30,
        population_percent_delta: 0.04,
        velocity_fold_change: 1.05,
      },
      {
        date: "2026-07-01",
        population_rank: "1200",
        population_percentile: 0.4,
        population_rank_velocity: 20,
        population_percent_delta: 0.01,
        velocity_fold_change: 1.0,
      },
    ],
  },
};

const QLOO_COMPARE = {
  results: {
    a: [
      { tag_id: "urn:tag:mood:melancholy", name: "Melancholy", query: { score: 0.9 } },
      { tag_id: "urn:tag:genre:electronic", name: "Electronic", query: { score: 0.8 } },
      { tag_id: "urn:tag:mood:night", name: "Late Night", query: { score: 0.7 } },
    ],
    b: [
      { tag_id: "urn:tag:mood:melancholy", name: "Melancholy", query: { score: 0.85 } },
      { tag_id: "urn:tag:genre:ambient", name: "Ambient", query: { score: 0.75 } },
      { tag_id: "urn:tag:mood:night", name: "Late Night", query: { score: 0.6 } },
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
              {
                date: "2026-09-01",
                population_rank: "1500",
                population_percentile: 0.4,
                population_rank_velocity: -60,
                population_percent_delta: -0.05,
                velocity_fold_change: 0.9,
              },
              {
                date: "2026-07-01",
                population_rank: "1000",
                population_percentile: 0.8,
                population_rank_velocity: -20,
                population_percent_delta: -0.02,
                velocity_fold_change: 0.95,
              },
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

await check("a 429 is retried and recovers", async () => {
  // The hackathon key rate-limits in bursts; one 429 must not cost a cue.
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error_msg: "Rate limit exceeded" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "retry-after": "0" },
      });
    }
    return jsonResponse(QLOO_INSIGHTS);
  }) as typeof fetch;
  const result = await insights({ filterType: "urn:entity:artist", take: 5 });
  globalThis.fetch = original;
  assert.equal(attempts, 2, "the retry should have re-issued the request");
  assert.equal(result.ok, true, "the retry should have succeeded");
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

await check("single-word and lowercase-connector references become anchors", () => {
  // These are the shapes a supervisor actually writes. Requiring two
  // capitalised words dropped every single-word reference, which silently
  // degraded the whole sheet to flat tag-only ranking.
  const brief = parseSceneBrief(
    "Cold open for a prestige thriller. Reference points the director mentioned: Drive, Sicario, Under the Skin. Set in Berlin, audience 25-34.",
  );
  assert.ok(brief.anchors.includes("Drive"), "a single-word title must be an anchor");
  assert.ok(brief.anchors.includes("Sicario"), "a bare proper noun must be an anchor");
  assert.ok(
    brief.anchors.includes("Under the Skin"),
    "a title containing a lowercase connector must survive intact",
  );
});

await check("grammar phrases and regions are never sent as signal entities", () => {
  const brief = parseSceneBrief(
    "A 30-second spot. Street court in Atlanta at golden hour. Target audience is 18-24, heavily mobile, US and UK. Set in New York.",
  );
  // "Set in New York" and "US and UK" are capitalised but name nothing, and
  // /search returns nothing useful for them.
  for (const junk of ["Set in New York", "US and UK", "New York", "Atlanta"]) {
    assert.equal(
      brief.anchors.includes(junk),
      false,
      `"${junk}" must not become a signal entity`,
    );
  }
  assert.equal(brief.region, "Atlanta");
});

await check("every bundled sample scene yields usable anchors or none", () => {
  // A judge's first click is a sample, so a sample that silently degrades to a
  // flat ranking is a bad first impression.
  const samples = [
    "A late-90s character drama. Rain on the windshield. Set in New York, aimed at a 35-44 audience. The director's reference points: Massive Attack's Mezzanine, Portishead, and the restraint of Lost in Translation.",
    "Cold open for a prestige thriller series. Reference points the director mentioned: Drive, Sicario, Under the Skin.",
    "Sixty-second brand film for a retirement community. Detroit, Michigan. Reference: the tone of the Apple 'Shot on iPhone' films, but for people who grew up on Motown.",
  ];
  for (const scene of samples) {
    const brief = parseSceneBrief(scene);
    assert.ok(brief.anchors.length > 0, `expected anchors from: ${scene.slice(0, 40)}`);
    for (const anchor of brief.anchors) {
      assert.ok(anchor.length >= 2, `anchor too short: "${anchor}"`);
      assert.equal(anchor, anchor.trim(), "anchors must be trimmed");
    }
  }
});

await check("an 'and' list splits into separate entities, not one merged name", () => {
  // "Bill Withers and Aretha Franklin" is two artists. Treating "and" as a
  // title connector produced one bogus entity and orphaned "Franklin".
  const brief = parseSceneBrief(
    "Warm, dignified. For people who grew up on Motown, Bill Withers and Aretha Franklin.",
  );
  assert.ok(brief.anchors.includes("Bill Withers"));
  assert.ok(brief.anchors.includes("Aretha Franklin"));
  assert.equal(
    brief.anchors.some((anchor) => /and/i.test(anchor)),
    false,
    "no anchor should contain a list conjunction",
  );
});

await check("place names are routed to region, never used as signal entities", () => {
  // A state is a place, not a taste entity. Sending "Michigan" to /search
  // returns nothing a supervisor can act on.
  const brief = parseSceneBrief(
    "A brand film. Detroit, Michigan. Audience is 55+. Reference: Motown and Bill Withers.",
  );
  assert.equal(brief.region, "Detroit");
  assert.equal(brief.anchors.includes("Michigan"), false);
  assert.equal(brief.anchors.includes("Detroit"), false);
  assert.ok(brief.anchors.includes("Motown"));
});

await check("fixture mode is explicit and never masquerades as live", async () => {
  // The deployed demo runs without a key, so it must say so loudly rather than
  // presenting pre-computed samples as Qloo output.
  const sheet = await buildCueSheet({ scene: "Anything at all here.", forceFixture: true });
  assert.equal(sheet.mode, "fixture");
  assert.ok(
    sheet.warnings.some((warning) => /fixture|cached|pre-computed/i.test(warning)),
    "fixture mode should warn that the numbers are not live",
  );
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
  assert.equal(first.momentum, 1, "climbing population_rank should read as rising");
  assert.equal(first.placement, "needle_drop");
  assert.equal(first.clearance, "unknown", "popularity 0.62 is mid-band");
  assert.ok(first.why.length > 0);
  assert.ok(first.confidence > 0.5);

  assert.equal(sheet.cues[1].momentum, -1, "falling population_rank should read as cooling");
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

/* ------------------------------------------------------------------ */
/* Live-API regression guards                                          */
/*                                                                     */
/* Each of these encodes a bug that a green test suite previously      */
/* missed because the stubs did not match the real Qloo payloads.      */
/* ------------------------------------------------------------------ */

await check("tag signals are sent as {tag,weight} objects, never bare strings", async () => {
  calls.length = 0;
  await buildCueSheet({
    scene: 'A noir scene referencing "Drive". Los Angeles, audience 25-34.',
  });
  const withTags = calls.find(
    (call) => call.url.includes("/v2/insights") && call.url.includes("signal.interests.tags"),
  );
  assert.ok(withTags, "expected an insights call carrying tag signals");
  const raw = decodeURIComponent(withTags.url.split("signal.interests.tags=")[1].split("&")[0]);
  assert.ok(raw.startsWith("["), `tag signal must be a JSON array, got: ${raw}`);
  assert.ok(
    raw.includes('"tag"'),
    `tag signal entries must be objects with a tag property, got: ${raw}`,
  );
});

await check("empty signal arrays are omitted, not sent as empty parameters", async () => {
  calls.length = 0;
  await buildCueSheet({ scene: "A quiet scene with no named references at all here." });
  for (const call of calls) {
    assert.ok(
      !/[?&][^=&]+=&/.test(call.url) && !call.url.endsWith("="),
      `empty parameter leaked into request: ${call.url}`,
    );
  }
});

await check("signal entities are sent as bare IDs, not urn-prefixed", async () => {
  calls.length = 0;
  await buildCueSheet({
    scene: 'A noir scene referencing "Drive". Los Angeles, audience 25-34.',
  });
  const insightCall = calls.find(
    (call) => call.url.includes("/v2/insights") && call.url.includes("signal.interests.entities"),
  );
  assert.ok(insightCall, "expected an insights call with entity signals");
  const raw = decodeURIComponent(
    insightCall.url.split("signal.interests.entities=")[1].split("&")[0],
  );
  assert.ok(
    !raw.includes("urn:entity:"),
    `signal entities must be bare IDs, got: ${raw}`,
  );
});

await check("explainability keyed by signal is flattened with scores", async () => {
  const sheet = await buildCueSheet({
    scene: 'A noir scene referencing "Drive". Los Angeles, audience 25-34.',
  });
  const first = sheet.cues[0];
  assert.ok(first.explainability.length >= 2, "both signal groups should be flattened");
  assert.ok(
    first.explainability.every((entry) => entry.entity_id.length > 0),
    "every contribution must carry an entity id",
  );
  const scores = first.explainability.map((entry) => entry.score);
  assert.deepEqual(
    scores,
    [...scores].sort((a, b) => b - a),
    "contributions should be ordered strongest first",
  );
});

await check("compare groups are read as tags and intersected for overlap", async () => {
  const sheet = await buildCueSheet({
    scene: 'A noir scene referencing "Drive". Los Angeles, audience 25-34.',
    alternativeAnchors: ["Sicario"],
  });
  const compare = sheet.directionCompare;
  assert.ok(compare, "directionCompare should be present");
  assert.ok(compare.shared.includes("Melancholy"), "shared tags must intersect");
  assert.ok(!compare.shared.includes("Ambient"), "b-only tags must not appear as shared");
  assert.ok(compare.aOnly.includes("Electronic"), "a-only tags must be surfaced");
  assert.ok(compare.bOnly.includes("Ambient"), "b-only tags must be surfaced");
  assert.ok(compare.overlap > 0 && compare.overlap <= 1, "overlap must be a ratio");
  assert.ok(compare.verdict.length > 0);
});

await check("trending parses string population_rank into a number", async () => {
  const { trending } = await import("../src/lib/qloo.ts");
  const result = await trending(
    "aaaaaaaa-0000-0000-0000-000000000001",
    "urn:entity:artist",
    "2026-07-01",
    "2026-09-01",
  );
  assert.ok(result.ok);
  assert.equal(typeof result.data[0].rank, "number", "rank must be numeric");
  assert.equal(result.data[0].rank, 900);
  assert.equal(result.data[0].rankVelocity, 40);
});

await check("tag search disables typo tolerance", async () => {
  // With typo tolerance on, Qloo fuzzy-matches unrelated tags ("tension" ->
  // "Venison"), which silently corrupts every downstream signal.
  calls.length = 0;
  await buildCueSheet({
    scene: 'A noir scene referencing "Drive". Los Angeles, audience 25-34.',
  });
  const tagCall = calls.find((call) => call.url.includes("/v2/tags"));
  assert.ok(tagCall, "a tag search should have been made");
  assert.ok(
    tagCall.url.includes("feature.typo_tolerance=false"),
    "typo tolerance must be disabled for tag resolution",
  );
});

await check("localisation queries places, not artists, and varies by market", async () => {
  const original = globalThis.fetch;
  calls.length = 0;
  // Return market-specific places so overlap is genuinely computed rather than
  // trivially zero.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);
    calls.push({ url, headers: {} });
    const market = parsed.searchParams.get("filter.location.query");
    const type = parsed.searchParams.get("filter.type");
    const perMarket: Record<string, string[]> = {
      "Los Angeles": ["Hollywood Sign", "Warner Bros. Studio Tour"],
      Seoul: ["Drip Factory", "Starfield Library"],
      Tokyo: ["Samurai Museum", "Ghibli Museum"],
    };
    const names = perMarket[market ?? ""] ?? [];
    return jsonResponse({
      results: {
        entities: names.map((name, index) => ({
          entity_id: `place-${market}-${index}`,
          name,
          types: [type],
          query: { affinity: 0.9 - index * 0.1 },
        })),
      },
    });
  }) as typeof fetch;

  try {
    const { localiseBrief } = await import("../src/lib/localise.ts");
    const receipts: Receipt[] = [];
    const result = await localiseBrief(
      [{ entity_id: "anchor-1", name: "Drive", types: ["urn:entity:movie"] } as never],
      [],
      "Los Angeles",
      ["Seoul", "Tokyo"],
      receipts,
    );

    assert.equal(result.markets.length, 3, "reference plus two markets");
    assert.equal(result.markets[0].overlapWithReference, 1, "reference overlaps itself");
    assert.equal(
      result.markets[1].overlapWithReference,
      0,
      "disjoint markets must report zero overlap",
    );
    assert.ok(
      result.markets[1].uniqueToMarket.includes("Drip Factory"),
      "market-unique touchpoints must be surfaced",
    );
    assert.equal(result.uniform, false, "disjoint markets are not uniform");
    assert.equal(receipts.length, 3, "one receipt per market");

    // The honest contract: location is queried against places. Artist affinity
    // is location-invariant on this API, so querying artists here would produce
    // a fake localisation.
    for (const call of calls) {
      assert.equal(
        new URL(call.url).searchParams.get("filter.type"),
        "urn:entity:place",
        "localisation must query urn:entity:place",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

await check("localisation flags a uniform result instead of claiming divergence", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, headers: {} });
    return jsonResponse({
      results: {
        entities: [
          { entity_id: "p1", name: "Same Place", types: [], query: { affinity: 0.8 } },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const { localiseBrief } = await import("../src/lib/localise.ts");
    const result = await localiseBrief(
      [],
      [],
      "Los Angeles",
      ["Seoul"],
      [],
    );
    assert.equal(result.uniform, true, "identical markets must be flagged uniform");
    assert.ok(
      result.warnings.some((warning) => warning.includes("same touchpoints")),
      "uniform results must warn rather than pass silently",
    );
  } finally {
    globalThis.fetch = original;
  }
});

await check("casting queries people and brands without a music-era filter", async () => {
  const original = globalThis.fetch;
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, headers: {} });
    const type = new URL(url).searchParams.get("filter.type");
    return jsonResponse({
      results: {
        entities: [
          { entity_id: `${type}-1`, name: "Candidate", types: [type], query: { affinity: 0.7 } },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const { castForBrief } = await import("../src/lib/casting.ts");
    const receipts: Receipt[] = [];
    const result = await castForBrief(
      { audience: { age: "25_34" } } as never,
      [{ entity_id: "anchor-1", name: "Drive", types: ["urn:entity:movie"] } as never],
      [],
      receipts,
    );

    const types = calls.map((call) => new URL(call.url).searchParams.get("filter.type"));
    assert.ok(types.includes("urn:entity:person"), "casting must query people");
    assert.ok(types.includes("urn:entity:brand"), "casting must query brands cross-domain");
    assert.equal(result.candidates.length, 2, "one person and one brand");
    assert.equal(result.audience, "25 34", "audience is made human-readable");

    // A release-year floor is a music-catalogue concept. Applying it to people
    // would drop every living performer and leave a casting list of dead ones.
    for (const call of calls) {
      assert.equal(
        new URL(call.url).searchParams.get("filter.release_year.min"),
        null,
        "casting must not filter people by music release year",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

await check("a market timeout is reported, not silently treated as uncovered", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, headers: {} });
    if (new URL(url).searchParams.get("filter.location.query") === "Seoul") {
      // Emulate an abort the way fetch does, so the error path is exercised.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort);
      });
    }
    return jsonResponse({
      results: {
        entities: [{ entity_id: "p1", name: "A Place", types: [], query: { affinity: 0.8 } }],
      },
    });
  }) as typeof fetch;

  try {
    const { localiseBrief } = await import("../src/lib/localise.ts");
    const receipts: Receipt[] = [];
    const result = await localiseBrief([], [], "Los Angeles", ["Seoul"], receipts);

    const seoul = result.markets.find((market) => market.market === "Seoul");
    assert.ok(seoul, "the timed-out market must still appear in the result");
    assert.equal(seoul.failed, true, "a timed-out market is marked failed");
    assert.equal(seoul.touchpoints.length, 0, "no touchpoints are invented");
    assert.ok(
      receipts.some((receipt) => receipt.status !== 200),
      "the failure must be visible in the receipts",
    );
  } finally {
    globalThis.fetch = original;
  }
});

await check("a basket quote prices from Qloo signals and reports the take", async () => {
  const { quoteLicense, summariseQuotes, DEFAULT_TERMS } = await import("../src/lib/rights.ts");
  const cue = {
    id: "cue-1",
    artist: "Jonny Greenwood",
    track: "Tree Synthesisers",
    affinity: 0.93,
    popularity: 0.8,
    momentum: 0.4,
    clearance: "major_label",
    placement: "needle_drop",
  } as never;

  const quote = quoteLicense(cue, DEFAULT_TERMS);
  assert.ok(quote.fee.low < quote.fee.recommended, "recommended sits inside the range");
  assert.ok(quote.fee.recommended < quote.fee.high, "recommended sits inside the range");
  assert.ok(quote.takeAmount > 0, "the marketplace must charge a take");
  assert.ok(quote.holders.length > 0, "rights holders must be identified");
  assert.ok(quote.clearance.steps.length > 0, "a clearance path must be laid out");
  assert.ok(quote.drivers.length > 0, "the price must be explainable");
  assert.ok(quote.disclaimer.length > 0, "an estimate must be labelled as an estimate");

  const summary = summariseQuotes([quote, quoteLicense(cue, { ...DEFAULT_TERMS, exclusive: true })]);
  assert.equal(summary.quotes.length, 2);
  assert.ok(summary.totalRecommended > quote.fee.recommended, "totals sum the basket");
  assert.ok(summary.gatingDays > 0, "a gating clearance window must be reported");
});

await check("concurrent Qloo calls never exceed the in-flight cap", async () => {
  const { insights } = await import("../src/lib/qloo.ts");
  // Guards the MAX_CONCURRENCY invariant now that the pipeline resolves anchors
  // and tags concurrently and can issue a dozen calls at once. The cap is what
  // keeps a burst from earning 429s, so it should stay pinned by a test even
  // though the current limiter is correct.
  let peak = 0;
  let inFlight = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    try {
      return await original(...args);
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;

  try {
    // Arrivals are staggered rather than launched as one burst, so callers keep
    // hitting the limiter while slots are being released.
    const tasks: Array<Promise<unknown>> = [];
    for (let i = 0; i < 40; i += 1) {
      tasks.push(
        insights({
          filterType: "urn:entity:artist",
          signalEntities: ["11111111-1111-1111-1111-111111111111"],
          take: 3,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await Promise.all(tasks);
  } finally {
    globalThis.fetch = original;
  }

  assert.ok(peak > 1, "the limiter must still allow real concurrency");
  assert.ok(peak <= 4, `no more than 4 calls may be in flight, saw ${peak}`);
});

await check("LLM env values are trimmed and never echoed", async () => {
  const { resolveLlmConfig, llmDiagnostics } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  try {
    // A trailing newline survives a dashboard paste and produces a 401 that looks
    // like a bad key. Trimming has to happen at read time.
    process.env.LLM_API_KEY = "  sk-test-abc  \n";
    process.env.LLM_BASE_URL = "https://example.test/v1/\n";
    process.env.LLM_MODEL = " test-model \n";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OH_LLM_API_KEY_REFRESH_BASE_URLS;
    delete process.env.OH_LLM_PROXY_KEY;

    const config = resolveLlmConfig();
    assert.equal(config?.apiKey, "sk-test-abc", "the key must be trimmed");
    assert.equal(config?.model, "test-model", "the model must be trimmed");
    assert.equal(config?.baseUrl, "https://example.test/v1", "one trailing slash survives");

    // /api/cue is public, so the diagnostics must describe the key, never print it.
    const diagnostics = llmDiagnostics();
    assert.equal(diagnostics.configured, true);
    assert.equal(diagnostics.source, "llm");
    assert.equal(diagnostics.keyLength, "sk-test-abc".length);
    const serialised = JSON.stringify(diagnostics);
    assert.ok(!serialised.includes("sk-test-abc"), "the raw key must never be serialised");
    assert.ok(
      !serialised.includes("sk-test"),
      "no prefix of the key may be serialised either",
    );
  } finally {
    process.env = saved;
  }
});

await check("a whitespace-only key counts as unconfigured", async () => {
  const { resolveLlmConfig, hasLlm } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  try {
    // An empty variable is how a dashboard shows a deleted secret; it must not be
    // read as "configured", or the app reports readiness it does not have.
    process.env.OPENAI_API_KEY = "   \n";
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OH_LLM_API_KEY_REFRESH_BASE_URLS;
    delete process.env.OH_LLM_PROXY_KEY;
    assert.equal(resolveLlmConfig(), null);
    assert.equal(hasLlm(), false);
  } finally {
    process.env = saved;
  }
});

await check("a malformed cue cannot produce a NaN price", async () => {
  const { quoteLicense, DEFAULT_TERMS } = await import("../src/lib/rights.ts");
  // /api/quote prices cues supplied by the client, so every field the model
  // multiplies by has to survive being absent.
  const malformed = { id: "cue-x", artist: "Unknown Artist", track: "Track TBD" } as never;

  const quote = quoteLicense(malformed, DEFAULT_TERMS);
  for (const value of [quote.fee.low, quote.fee.high, quote.fee.recommended, quote.takeAmount]) {
    assert.ok(Number.isFinite(value), "every priced value must be a finite number");
    assert.ok(value > 0, "a price must be positive");
  }
  assert.ok(quote.fee.low < quote.fee.recommended, "the band must stay ordered");
  assert.ok(quote.fee.recommended < quote.fee.high, "the band must stay ordered");
  assert.equal(quote.placement, "score_bed", "an unknown placement falls back rather than NaN");
});

await check("every grant lever actually moves the price", async () => {
  const { quoteLicense, DEFAULT_TERMS } = await import("../src/lib/rights.ts");
  // The drivers have to compound. When they were summed, one large driver
  // (popularity, ~14.6) swamped the media weight (0.35-1.5), so four of the five
  // media options rounded to the same number and the dropdown looked broken.
  const major = {
    id: "cue-1",
    artist: "Björk",
    track: "Unravel",
    affinity: 0.8,
    popularity: 0.99,
    momentum: 0,
    placement: "needle_drop",
  } as never;

  const mediaPrices = (["all_media", "broadcast", "streaming", "social", "festival"] as const).map(
    (media) => quoteLicense(major, { ...DEFAULT_TERMS, media }).fee.recommended,
  );
  assert.equal(
    new Set(mediaPrices).size,
    mediaPrices.length,
    `every media option must price differently, got ${mediaPrices.join(", ")}`,
  );
  assert.ok(
    mediaPrices[0] > mediaPrices[mediaPrices.length - 1],
    "all media must cost more than a festival-only grant",
  );

  const territories = (["worldwide", "north_america", "europe", "single_market"] as const).map(
    (territory) => quoteLicense(major, { ...DEFAULT_TERMS, territory }).fee.recommended,
  );
  assert.equal(new Set(territories).size, territories.length, "each territory must price differently");

  const terms = ([1, 3, 10] as const).map(
    (termYears) => quoteLicense(major, { ...DEFAULT_TERMS, termYears }).fee.recommended,
  );
  assert.equal(new Set(terms).size, terms.length, "each term must price differently");

  // Exclusivity and discovery are the other two levers; both must be felt.
  const base = quoteLicense(major, DEFAULT_TERMS).fee.recommended;
  const exclusive = quoteLicense(major, { ...DEFAULT_TERMS, exclusive: true }).fee.recommended;
  assert.ok(exclusive > base, "exclusivity must raise the fee");
  const discovery = quoteLicense({ ...major, discovery: true } as never, DEFAULT_TERMS).fee.recommended;
  assert.ok(discovery < base, "a discovery pick must be discounted");

  // Leverage has to separate an unknown artist from a major, or popularity is
  // decoration rather than a pricing input.
  const indie = quoteLicense({ ...major, popularity: 0.2 } as never, DEFAULT_TERMS).fee.recommended;
  assert.ok(indie < base, "a low-popularity artist must be cheaper than a major");
});

await check("a provider key outranks the generic OpenAI key", async () => {
  const { resolveLlmConfig, llmDiagnostics } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  try {
    // The reported failure: a dead OpenAI key with no balance shadowed a good
    // OpenRouter key, because OPENAI_API_KEY was the only variable consulted.
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OH_LLM_API_KEY_REFRESH_BASE_URLS;
    delete process.env.OH_LLM_PROXY_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-exhausted";
    process.env.OPENROUTER_API_KEY = "sk-or-good";

    const config = resolveLlmConfig();
    assert.equal(config?.apiKey, "sk-or-good", "the provider key must win");
    assert.equal(config?.baseUrl, "https://openrouter.ai/api/v1");
    assert.ok(config?.model, "a provider preset must supply a model");

    const diagnostics = llmDiagnostics();
    assert.equal(diagnostics.source, "openrouter");
    assert.equal(diagnostics.keyVar, "OPENROUTER_API_KEY");
    // The report is public; it must name variables without leaking either value.
    const serialised = JSON.stringify(diagnostics);
    assert.ok(!serialised.includes("sk-or-good"), "no key may be serialised");
    assert.ok(!serialised.includes("sk-openai-exhausted"), "no shadowed key may be serialised");

    // Gemini is the next provider in the preset order.
    delete process.env.OPENROUTER_API_KEY;
    process.env.GEMINI_API_KEY = "AIza-test";
    const gemini = llmDiagnostics();
    assert.equal(gemini.source, "gemini");
    assert.ok(
      resolveLlmConfig()?.baseUrl.includes("generativelanguage.googleapis.com"),
      "the Gemini OpenAI-compatible endpoint must be used",
    );

    // An explicit LLM_* triple still outranks every provider preset.
    process.env.LLM_API_KEY = "sk-explicit";
    process.env.LLM_BASE_URL = "https://custom.test/v1";
    process.env.LLM_MODEL = "custom-model";
    const explicit = llmDiagnostics();
    assert.equal(explicit.source, "llm");
    assert.equal(resolveLlmConfig()?.apiKey, "sk-explicit");
  } finally {
    process.env = saved;
  }
});

await check("a stray space in a provider key is reported", async () => {
  const { llmDiagnostics } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  try {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OPENAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-good \n";
    const diagnostics = llmDiagnostics();
    assert.equal(diagnostics.keyHadWhitespace, true, "the untrimmed paste must be flagged");
    assert.equal(diagnostics.source, "openrouter");
    assert.equal(diagnostics.keyVar, "OPENROUTER_API_KEY");
  } finally {
    process.env = saved;
  }
});

await check("an exhausted provider balance is named in the fallback warning", async () => {
  // The production defect: a configured key with no credits made the pipeline
  // fall back silently behind a generic "fell back" line, so the operator could
  // not tell an exhausted balance from a missing key. The warning must name it.
  const { buildCueSheet } = await import("../src/lib/planner.ts");
  const saved = { ...process.env };
  const original = globalThis.fetch;
  try {
    process.env.LLM_API_KEY = "sk-test-dead-key";
    process.env.LLM_BASE_URL = "https://api.openai.example/v1";
    process.env.LLM_MODEL = "gpt-4o-mini";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://api.openai.example")) {
        // This is exactly what OpenAI returns for an exhausted balance.
        return jsonResponse(
          {
            error: {
              message:
                "You exceeded your current quota, please check your plan and billing details.",
              type: "insufficient_quota",
              code: "credit_balance_exhausted",
            },
          },
          429,
        );
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const sheet = await buildCueSheet({
      scene: 'A 90s noir thriller. Rain on the glass. Reference "Drive". Los Angeles, audience 25-34.',
    });

    assert.equal(sheet.sceneParse?.source, "deterministic", "the parser must be used");
    assert.equal(
      sheet.sceneParse?.failureReason,
      "insufficient_quota",
      "an exhausted balance must be classified, not reported as a rate limit",
    );
    const named = sheet.warnings.find((w) => /fell back/i.test(w));
    assert.ok(named, "a fallback warning must be present");
    assert.ok(
      /credit/i.test(named) || /quota/i.test(named),
      `the warning must name the cause, got: ${named}`,
    );
    assert.ok(
      !/set an LLM key|no llm configured/i.test(named),
      "an exhausted balance must not be described as a missing key",
    );
    // Qloo data is unaffected by an LLM outage; the sheet must still rank.
    assert.ok(sheet.cues.length >= 3, "Qloo ranking must survive an LLM failure");
  } finally {
    process.env = saved;
    globalThis.fetch = original;
  }
});

await check("a rejected key is distinguished from an exhausted balance", async () => {
  const { buildCueSheet } = await import("../src/lib/planner.ts");
  const saved = { ...process.env };
  const original = globalThis.fetch;
  try {
    process.env.LLM_API_KEY = "sk-test-revoked";
    process.env.LLM_BASE_URL = "https://api.openai.example/v1";
    process.env.LLM_MODEL = "gpt-4o-mini";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://api.openai.example")) {
        return jsonResponse({ error: { message: "Incorrect API key provided." } }, 401);
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const sheet = await buildCueSheet({
      scene: 'A 90s noir thriller referencing "Drive". Los Angeles, audience 25-34.',
    });
    assert.equal(sheet.sceneParse?.failureReason, "invalid_key");
    const named = sheet.warnings.find((w) => /fell back/i.test(w));
    assert.ok(/rejected|key/i.test(named ?? ""), `warning must name the key fault: ${named}`);
  } finally {
    process.env = saved;
    globalThis.fetch = original;
  }
});

await check("a static baseline is never attributed to the LLM", async () => {
  // The comparison panel claims to show "what the LLM would say". When the model
  // is unavailable it shows a fixed sample, and must say so instead of borrowing
  // the model's authority for text the model never produced.
  const { buildCueSheet } = await import("../src/lib/planner.ts");
  const saved = { ...process.env };
  const original = globalThis.fetch;
  try {
    process.env.LLM_API_KEY = "sk-test-dead-key";
    process.env.LLM_BASE_URL = "https://api.openai.example/v1";
    process.env.LLM_MODEL = "gpt-4o-mini";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://api.openai.example")) {
        return jsonResponse({ error: { code: "credit_balance_exhausted" } }, 429);
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const sheet = await buildCueSheet({
      scene: 'A 90s noir thriller referencing "Drive". Los Angeles, audience 25-34.',
    });
    assert.equal(sheet.baseline.source, "sample", "a failed generation must be marked as a sample");
    assert.ok(sheet.baseline.cues.length > 0, "the panel must still show something");
    assert.ok(
      /did not return|fixed example/i.test(sheet.baseline.note),
      `the note must not claim the LLM produced it: ${sheet.baseline.note}`,
    );
  } finally {
    process.env = saved;
    globalThis.fetch = original;
  }
});

await check("the fixture baseline is marked as a sample too", async () => {
  const { FIXTURE_SHEET } = await import("../src/data/fixtures.ts");
  assert.equal(
    FIXTURE_SHEET.baseline.source,
    "sample",
    "pre-computed fixture text is not LLM output",
  );
});

await check("concurrent LLM calls do not cross-contaminate their outcomes", async () => {
  // A single cue sheet issues the track-naming call and the baseline call
  // concurrently, and the two can fail differently. Failure state must belong to
  // the call that produced it, or the UI blames the wrong call and reports a
  // fault that never happened.
  const { chatDetailed, resolveLlmConfig } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  const original = globalThis.fetch;
  try {
    process.env.LLM_API_KEY = "sk-test-partial";
    process.env.LLM_BASE_URL = "https://api.openai.example/v1";
    process.env.LLM_MODEL = "gpt-4o-mini";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://api.openai.example")) {
        const body = String(init?.body ?? "");
        if (body.includes("NO cultural data")) {
          return jsonResponse({ error: { code: "credit_balance_exhausted" } }, 429);
        }
        return jsonResponse({
          choices: [{ message: { content: '{"ok":true}' } }],
        });
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const config = resolveLlmConfig();
    assert.ok(config, "a config must resolve for this test to mean anything");

    const good = chatDetailed(config, [{ role: "user", content: "name some tracks" }]);
    const bad = chatDetailed(config, [{ role: "user", content: "NO cultural data here" }]);
    const [goodResult, badResult] = await Promise.all([good, bad]);

    assert.ok(goodResult.message, "the successful call must return its message");
    assert.equal(
      goodResult.failure,
      null,
      "a successful call must not inherit a concurrent call's failure",
    );
    assert.equal(badResult.message, null, "the failing call must return no message");
    assert.equal(
      badResult.failure?.reason,
      "insufficient_quota",
      "the failing call must carry its own classified reason",
    );
  } finally {
    process.env = saved;
    globalThis.fetch = original;
  }
});

await check("a successful scene read is not blamed for a concurrent baseline failure", async () => {
  const { buildCueSheet } = await import("../src/lib/planner.ts");
  const saved = { ...process.env };
  const original = globalThis.fetch;
  try {
    process.env.LLM_API_KEY = "sk-test-partial";
    process.env.LLM_BASE_URL = "https://api.openai.example/v1";
    process.env.LLM_MODEL = "gpt-4o-mini";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://api.openai.example")) {
        const body = String(init?.body ?? "");
        if (body.includes("NO cultural data")) {
          return jsonResponse({ error: { code: "credit_balance_exhausted" } }, 429);
        }
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  setting: "Rain on glass",
                  mood: ["wistful"],
                  era: "1990s",
                  arc: "dread to resolve",
                  anchors: ["Drive"],
                  audience: { ageMin: 25, ageMax: 34 },
                }),
              },
            },
          ],
        });
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const sheet = await buildCueSheet({
      scene: 'A 90s noir thriller referencing "Drive". Los Angeles, audience 25-34.',
    });

    // The scene read succeeded while the baseline call failed. The sheet must
    // report the success, and must not carry the other call's failure.
    assert.equal(sheet.sceneParse?.source, "llm", "the successful scene read must be reported");
    assert.equal(
      sheet.sceneParse?.failureReason,
      undefined,
      "a call that succeeded must not be given a failure reason",
    );
    assert.equal(
      sheet.warnings.some((w) => /fell back/i.test(w)),
      false,
      "no fallback warning may be raised when the scene read succeeded",
    );
    // The failure that did happen must still be labelled honestly.
    assert.equal(sheet.baseline.source, "sample", "the failed baseline must be a sample");
  } finally {
    process.env = saved;
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// Substitution: budget inversion and the honesty invariants.
//
// The substitution path adds a second kind of claim to the product — not "this
// is what the scene wants" but "this other artist serves the same people for
// less money". These checks guard the arithmetic behind that claim and the two
// ways it could lie: inventing a saving, or calling a different audience a
// substitute.
// ---------------------------------------------------------------------------

const { popularityCeilingForBudget, quoteLicense: quote, DEFAULT_TERMS: TERMS } = await import(
  "../src/lib/rights.ts"
);

function cueAt(popularity: number, momentum = 0) {
  return {
    id: "cue-1",
    artistId: "aaaaaaaa-0000-0000-0000-000000000001",
    artist: "Target",
    track: "Track",
    affinity: 0.9,
    popularity,
    momentum,
    why: [],
    explainability: [],
    placement: "needle_drop" as const,
    clearance: "unknown" as const,
    risk: "",
    confidence: 0.8,
  };
}

await check("a budget inverts to the popularity ceiling that fits it", () => {
  const cue = cueAt(0.99);
  const ceiling = popularityCeilingForBudget(cue, TERMS, 2500);
  assert.ok(ceiling > 0 && ceiling < 1, `ceiling must be interior, got ${ceiling}`);
  // The ceiling must be the most expensive catalogue the budget allows: pricing
  // exactly at it fits, and pricing just above it does not.
  assert.ok(
    quote({ ...cue, popularity: ceiling }, TERMS).fee.recommended <= 2500,
    "the ceiling itself must fit the budget",
  );
  assert.ok(
    quote({ ...cue, popularity: Math.min(1, ceiling + 0.02) }, TERMS).fee.recommended > 2500,
    "just above the ceiling must exceed the budget",
  );
});

await check("a budget too small for any catalogue returns zero, not a fake ceiling", () => {
  // Below the floor of the fee model, no popularity can satisfy the budget. The
  // caller must be able to tell that apart from "the cheapest option happens to
  // be free", which is why this returns 0 rather than a small number.
  assert.equal(popularityCeilingForBudget(cueAt(0.99), TERMS, 1), 0);
});

await check("a budget above every catalogue returns the whole range", () => {
  assert.equal(popularityCeilingForBudget(cueAt(0.99), TERMS, 10_000_000), 1);
});

await check("the ceiling is monotonic in the budget", () => {
  const cue = cueAt(0.99);
  let previous = -1;
  for (const budget of [250, 1000, 2500, 5000, 20_000, 200_000]) {
    const ceiling = popularityCeilingForBudget(cue, TERMS, budget);
    assert.ok(ceiling >= previous, `ceiling fell as the budget rose at $${budget}`);
    previous = ceiling;
  }
});

const { normaliseAgeBucket, QLOO_AGE_BUCKETS } = await import("../src/lib/qloo.ts");

await check("a raw age range is coerced into a bucket Qloo accepts", () => {
  // Qloo answers a non-bucket age with a 400 that empties the whole response, so
  // passing one through does not degrade a query — it destroys it.
  // A range spans two buckets; the lower bound wins, which is the convention the
  // deterministic parser already uses for the same input.
  assert.equal(normaliseAgeBucket("25-34"), "25_to_29");
  assert.equal(normaliseAgeBucket("25 to 34"), "25_to_29");
  assert.equal(normaliseAgeBucket("30-34"), "30_to_34");
  assert.equal(normaliseAgeBucket("18-24"), "24_and_younger");
  assert.equal(normaliseAgeBucket("65-70"), "55_and_older");
  assert.equal(normaliseAgeBucket("30_to_34"), "30_to_34");
  assert.equal(normaliseAgeBucket(" 45_TO_54 "), "45_to_54");
});

await check("an unusable age is dropped rather than forwarded", () => {
  // Forwarding an unknown value fails the request; dropping the demographic only
  // narrows it, which is the recoverable failure.
  assert.equal(normaliseAgeBucket("middle aged"), undefined);
  assert.equal(normaliseAgeBucket(undefined), undefined);
});

await check("every normalised age is a value Qloo documents", () => {
  const inputs = [
    "24_and_younger",
    "25_to_29",
    "30_to_34",
    "35_to_44",
    "45_to_54",
    "55_and_older",
    "22-30",
    "40s",
  ];
  for (const input of inputs) {
    const bucket = normaliseAgeBucket(input);
    if (bucket !== undefined) {
      assert.ok(
        (QLOO_AGE_BUCKETS as readonly string[]).includes(bucket),
        `${input} normalised to ${bucket}, which is not a Qloo bucket`,
      );
    }
  }
});

await check("insights never sends an invalid age to Qloo", async () => {
  const before = calls.length;
  await insights({ filterType: "urn:entity:artist", demographics: { age: "25-34" }, take: 3 });
  const call = calls.slice(before).find((entry) => entry.url.includes("/v2/insights"));
  assert.ok(call, "an insights call must have been made");
  const age = new URL(call.url).searchParams.get("signal.demographics.age");
  assert.equal(age, "25_to_29", `Qloo received age=${age}`);
});

const { findSubstitutes } = await import("../src/lib/substitute.ts");

/** A brief shaped like the ones the pipeline produces. */
function testBrief() {
  return {
    title: "Test",
    raw: "A rain-soaked neo-noir in 1990s Los Angeles. Reference: Drive. Audience 25-34.",
    mood: ["dark"],
    genre: ["thriller"],
    era: "1990s",
    setting: "Los Angeles",
    arc: "dread",
    audience: { age: "30_to_34" },
    anchors: ["Drive"],
    diegetic: false,
  };
}

/**
 * Serve a substitution run from controlled pools. The popularity of each
 * candidate is set explicitly so the price each one carries is known before the
 * assertions run, which is what lets a test claim "the cheaper option is the one
 * the model actually priced cheaper".
 */
function serveSubstitutionPools(forceStrangers = false) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);
    if (parsed.pathname === "/v2/insights") {
      const max = Number(parsed.searchParams.get("filter.popularity.max") ?? 1);
      // Cheap, mid and expensive candidates, each only visible under a cap that
      // admits it. The expensive one is excluded entirely at a tight budget.
      const pool = [
        { id: "sub-cheap", name: "Cheap Act", popularity: 0.15 },
        { id: "sub-mid", name: "Mid Act", popularity: 0.5 },
        { id: "sub-rich", name: "Rich Act", popularity: 0.95 },
      ].filter((candidate) => candidate.popularity <= max);
      return jsonResponse({
        success: true,
        results: {
          entities: pool.map((candidate) => ({
            entity_id: candidate.id,
            name: candidate.name,
            type: "urn:entity",
            subtype: "urn:entity:artist",
            popularity: candidate.popularity,
            properties: {},
            tags: [],
            query: { affinity: 0.8 },
          })),
        },
      });
    }
    if (parsed.pathname === "/v2/analysis/compare") {
      // Overlap is shared tags over the smaller tag set, so the tag lists are
      // built to land on specific fractions. That matters: a stub that only
      // produced 0 and 1 would pass whatever the audience floor was set to, and
      // would not actually test the threshold.
      const b = parsed.searchParams.get("b.signal.interests.entities") ?? "";
      // Two candidates clear the floor with different overlaps, and the one with
      // the better overlap is the more expensive of the two. That inversion is
      // deliberate: it is what distinguishes ranking by audience match from
      // ranking by price.
      // sub-mid shares 3 of 4 tags (0.75) and costs more; sub-cheap 2 of 4 (0.50)
      // and costs less; a stranger shares nothing.
      const sharedTags = forceStrangers ? 0 : b === "sub-mid" ? 3 : b === "sub-cheap" ? 2 : 0;
      const aTags = ["t1", "t2", "t3", "t4"];
      const bTags = [
        ...aTags.slice(0, sharedTags),
        ...["t5", "t6", "t7", "t8"].slice(0, 4 - sharedTags),
      ];
      return jsonResponse({
        results: {
          a: aTags.map((tag, index) => ({
            tag_id: tag,
            name: `A Tag ${index}`,
            query: { score: 0.9 - index * 0.1 },
          })),
          b: bTags.map((tag, index) => ({
            tag_id: tag,
            name: `B Tag ${index}`,
            query: { score: 0.8 - index * 0.1 },
          })),
        },
      });
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
}

/** Restore the suite's default Qloo stub after a substitution test. */
function restorePools() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);
    if (parsed.pathname === "/search") return jsonResponse(QLOO_SEARCH);
    if (parsed.pathname === "/v2/tags") return jsonResponse(QLOO_TAGS);
    if (parsed.pathname === "/v2/insights") return jsonResponse(QLOO_INSIGHTS);
    if (parsed.pathname === "/v2/analysis/compare") return jsonResponse(QLOO_COMPARE);
    if (parsed.pathname === "/v2/trending") return jsonResponse(QLOO_TRENDING);
    return jsonResponse({ error: "unexpected path" }, 404);
  }) as typeof fetch;
}

await check("substitution prices every option with the real fee model", async () => {
  serveSubstitutionPools();
  try {
    const result = await findSubstitutes({
      brief: testBrief() as never,
      target: cueAt(0.99) as never,
      budget: 2500,
    });
    assert.ok(result.options.length > 0, "the frontier must not be empty");
    for (const option of result.options) {
      // An option's fee must equal what the fee model says for its own
      // popularity, or the panel is quoting a number nothing produced.
      const expected = quote({ ...cueAt(option.popularity), artist: option.artist }, TERMS).fee;
      assert.equal(
        option.fee.recommended,
        expected.recommended,
        `${option.artist} carries a fee the model does not produce`,
      );
      assert.equal(option.savings, result.target.fee.recommended - option.fee.recommended);
    }
  } finally {
    restorePools();
  }
});

await check("a candidate the budget cannot afford is never offered", async () => {
  serveSubstitutionPools();
  try {
    const result = await findSubstitutes({
      brief: testBrief() as never,
      target: cueAt(0.99) as never,
      budget: 2500,
    });
    for (const option of result.options) {
      assert.ok(
        option.fee.recommended <= result.budget,
        `${option.artist} costs ${option.fee.recommended}, over the ${result.budget} budget`,
      );
    }
  } finally {
    restorePools();
  }
});

await check("a different audience is not presented as a substitute", async () => {
  serveSubstitutionPools();
  try {
    const result = await findSubstitutes({
      brief: testBrief() as never,
      target: cueAt(0.99) as never,
      budget: 2500,
    });
    // The recommendation must be the better audience match even though it is the
    // more expensive option. Ranking on price instead would recommend a weaker
    // substitute to save money the supervisor did not ask to save.
    assert.equal(result.pick?.id, "sub-mid", "the better audience match must be recommended");
    const mid = result.options.find((option) => option.id === "sub-mid");
    const cheap = result.options.find((option) => option.id === "sub-cheap");
    assert.ok(mid && cheap, "both viable options must be listed");
    assert.ok(
      (mid?.audienceOverlap ?? 0) > (cheap?.audienceOverlap ?? 0),
      "the stub must invert overlap and price for this test to mean anything",
    );
    assert.ok(
      (mid?.fee.recommended ?? 0) > (cheap?.fee.recommended ?? 0),
      "the better match must be the dearer option",
    );
  } finally {
    restorePools();
  }
});

await check("a candidate above the audience floor is offered without a refusal", async () => {
  serveSubstitutionPools();
  try {
    const result = await findSubstitutes({
      brief: testBrief() as never,
      target: cueAt(0.99) as never,
      budget: 2500,
    });
    // Mid Act clears the floor, so the run must read as a normal success. This is
    // the other side of the floor: raising the threshold must silence this, which
    // is what makes the threshold itself under test.
    assert.ok(result.pick, "a clearing candidate must be offered");
    assert.equal(
      result.warnings.some((warning) => /audience overlap/i.test(warning)),
      false,
      "a clearing candidate must not raise the refusal warning",
    );
  } finally {
    restorePools();
  }
});

await check("when nothing clears the audience floor, the refusal is stated", async () => {
  serveSubstitutionPools(true);
  try {
    const result = await findSubstitutes({
      brief: testBrief() as never,
      target: cueAt(0.99) as never,
      budget: 2500,
    });
    // The calibrated floor exists to stop a stranger being sold as a swap. When
    // no candidate reaches it, the panel must say so rather than let the closest
    // one read as a genuine substitute.
    assert.ok(
      result.warnings.some((warning) => /audience overlap/i.test(warning)),
      `no warning named the audience floor: ${JSON.stringify(result.warnings)}`,
    );
    // It must still offer the closest option — refusing outright would hide the
    // only information the supervisor has.
    assert.ok(result.pick, "the closest available option must still be offered");
    assert.ok(
      (result.pick?.audienceOverlap ?? 0) < 0.3,
      "this scenario is only meaningful when every candidate is below the floor",
    );
  } finally {
    restorePools();
  }
});

await check("the headline claims overlap, never a retained-affinity ratio", async () => {
  serveSubstitutionPools();
  try {
    const result = await findSubstitutes({
      brief: testBrief() as never,
      target: cueAt(0.99) as never,
      budget: 2500,
    });
    // Affinity from a capped pool is measured against a different candidate set
    // than the target's uncapped affinity, so a ratio of the two is not a
    // quantity. It can exceed 100%, and saying "keeps 115% of the audience fit"
    // would be the same class of error as inventing a track title.
    assert.ok(
      !/keeps \d+%/.test(result.summary),
      `the summary claims a retention ratio: ${result.summary}`,
    );
    assert.ok(
      /shares \d+%/.test(result.summary),
      `the summary does not state the measured overlap: ${result.summary}`,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.pick, "affinityRetained"),
      false,
      "the misleading retention ratio must not be exposed at all",
    );
  } finally {
    restorePools();
  }
});

await check("substitution reports a receipt for every Qloo call it made", async () => {
  serveSubstitutionPools();
  try {
    const result = await findSubstitutes({
      brief: testBrief() as never,
      target: cueAt(0.99) as never,
      budget: 2500,
    });
    assert.ok(result.receipts.length >= 2, "the search must be receipted");
    for (const receipt of result.receipts) {
      assert.ok(receipt.endpoint.startsWith("GET /"), `bad endpoint: ${receipt.endpoint}`);
      assert.ok(receipt.status > 0, `unreported status for ${receipt.label}`);
    }
    assert.ok(
      result.receipts.some((receipt) => receipt.endpoint.includes("/v2/analysis/compare")),
      "the audience-overlap call must be receipted",
    );
  } finally {
    restorePools();
  }
});

await check("a budget that fits nothing says so instead of inventing a pick", async () => {
  serveSubstitutionPools();
  try {
    const result = await findSubstitutes({
      brief: testBrief() as never,
      target: cueAt(0.99) as never,
      budget: 5,
    });
    assert.equal(result.pick, null, "no pick may be offered when nothing fits the budget");
    assert.ok(result.warnings.length > 0, "the refusal must be explained");
    assert.ok(result.summary.length > 0, "the refusal must be stated in words");
  } finally {
    restorePools();
  }
});

await check("an ungrounded target is refused rather than silently empty", async () => {
  const ungrounded = { ...cueAt(0.99), artistId: undefined };
  const result = await findSubstitutes({
    brief: testBrief() as never,
    target: ungrounded as never,
    budget: 2500,
  });
  assert.equal(result.pick, null);
  assert.ok(
    result.warnings.some((warning) => /entity id/i.test(warning)),
    "the refusal must name the missing grounding",
  );
});

await check("a failed primary hands the request to the next provider", async () => {
  // The defect this guards: a configured primary that refuses the call meant no
  // model at all, even with a second working key in the environment. The chain
  // must move on rather than give up while a usable key sits unused.
  const { chatWithFallback } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  const original = globalThis.fetch;
  const called: string[] = [];
  try {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OPENAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-exhausted";
    process.env.GROQ_API_KEY = "gsk-working";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://openrouter.ai")) {
        called.push("openrouter");
        return jsonResponse({ error: { message: "Insufficient credits." } }, 402);
      }
      if (url.startsWith("https://api.groq.com")) {
        called.push("groq");
        return jsonResponse({
          choices: [{ message: { content: "pong" } }],
        });
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const result = await chatWithFallback([{ role: "user", content: "hi" }]);

    assert.deepEqual(
      called,
      ["openrouter", "groq"],
      "the exhausted primary must be tried first, then the fallback",
    );
    assert.ok(result.message, "the fallback answer must be used");
    assert.equal(result.provider, "groq", "the result must name the provider that answered");
    assert.equal(result.failure, null, "a successful chain has no failure to report");
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.source),
      ["openrouter", "groq"],
    );
    // A 402 is a balance problem, not a rate limit. Misreading it sends the
    // operator to the wrong fix.
    assert.equal(result.attempts[0].failure?.reason, "insufficient_quota");
  } finally {
    process.env = saved;
    globalThis.fetch = original;
  }
});

await check("a fallback that answers is disclosed in the cue sheet", async () => {
  const { buildCueSheet } = await import("../src/lib/planner.ts");
  const saved = { ...process.env };
  const original = globalThis.fetch;
  try {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OPENAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-exhausted";
    process.env.GROQ_API_KEY = "gsk-working";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://openrouter.ai")) {
        return jsonResponse({ error: { message: "Insufficient credits." } }, 402);
      }
      if (url.startsWith("https://api.groq.com")) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  setting: "A rain-slicked Los Angeles street at night",
                  mood: ["moody", "restrained"],
                  genre: ["synthwave"],
                  era: "1990s",
                  anchors: ["Drive"],
                }),
              },
            },
          ],
        });
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const sheet = await buildCueSheet({
      scene: 'A 90s noir thriller. Rain on the glass. Reference "Drive". Los Angeles, audience 25-34.',
    });

    assert.equal(sheet.sceneParse?.source, "llm", "the fallback answer must be used");
    assert.equal(sheet.sceneParse?.provider, "groq", "the sheet must name the provider that answered");
    assert.deepEqual(sheet.sceneParse?.triedProviders, ["openrouter", "groq"]);
    assert.ok(
      sheet.warnings.some((w) => /parsed by groq/i.test(w)),
      "the sheet must disclose that a fallback answered",
    );
  } finally {
    process.env = saved;
    globalThis.fetch = original;
  }
});

await check("each provider is tried at most once, then the chain stops", async () => {
  // Retrying a dead provider adds latency without changing the outcome. Every
  // provider must be attempted exactly once and then the chain must give up.
  const { chatWithFallback } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  const original = globalThis.fetch;
  const counts: Record<string, number> = {};
  try {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OPENAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-exhausted";
    process.env.GROQ_API_KEY = "gsk-exhausted";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://openrouter.ai")) {
        counts.openrouter = (counts.openrouter ?? 0) + 1;
        return jsonResponse({ error: { message: "Insufficient credits." } }, 402);
      }
      if (url.startsWith("https://api.groq.com")) {
        counts.groq = (counts.groq ?? 0) + 1;
        return jsonResponse({ error: { message: "Rate limit reached." } }, 429);
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const result = await chatWithFallback([{ role: "user", content: "hi" }]);

    assert.equal(counts.openrouter, 1, "the primary must be tried exactly once");
    assert.equal(counts.groq, 1, "the fallback must be tried exactly once");
    assert.equal(result.message, null, "no provider answered");
    assert.equal(result.provider, null);
    // The reported failure is the last one tried, so the operator sees the most
    // recent reason rather than the oldest.
    assert.equal(result.failure?.reason, "rate_limited");
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.source),
      ["openrouter", "groq"],
    );
  } finally {
    process.env = saved;
    globalThis.fetch = original;
  }
});

await check("a total LLM outage is disclosed and Qloo ranking survives", async () => {
  const { buildCueSheet } = await import("../src/lib/planner.ts");
  const saved = { ...process.env };
  const original = globalThis.fetch;
  try {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OPENAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-exhausted";
    process.env.GROQ_API_KEY = "gsk-exhausted";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://openrouter.ai")) {
        return jsonResponse({ error: { message: "Insufficient credits." } }, 402);
      }
      if (url.startsWith("https://api.groq.com")) {
        return jsonResponse({ error: { message: "Rate limit reached." } }, 429);
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const sheet = await buildCueSheet({
      scene: 'A 90s noir thriller referencing "Drive". Los Angeles, audience 25-34.',
    });

    assert.equal(sheet.sceneParse?.source, "deterministic", "no provider answered");
    assert.deepEqual(sheet.sceneParse?.triedProviders, ["openrouter", "groq"]);
    const named = sheet.warnings.find((w) => /fell back/i.test(w));
    assert.ok(
      /openrouter, groq/.test(named ?? ""),
      `the warning must list every provider tried: ${named}`,
    );
    // Qloo ranking must survive a total LLM outage.
    assert.ok(sheet.cues.length >= 3, "Qloo ranking must not depend on the model");
  } finally {
    process.env = saved;
    globalThis.fetch = original;
  }
});

await check("the LLM_* triple is terminal and is not chained", async () => {
  // Setting all three LLM_* variables names an endpoint deliberately. Silently
  // falling through to a preset would send the request somewhere the operator
  // did not choose.
  const { chatWithFallback } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  const original = globalThis.fetch;
  const called: string[] = [];
  try {
    process.env.LLM_API_KEY = "sk-explicit";
    process.env.LLM_BASE_URL = "https://custom.test/v1";
    process.env.LLM_MODEL = "custom-model";
    process.env.GROQ_API_KEY = "gsk-working";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      called.push(new URL(url).host);
      return jsonResponse({ error: { message: "Incorrect API key provided." } }, 401);
    }) as typeof fetch;

    const result = await chatWithFallback([{ role: "user", content: "hi" }]);

    assert.deepEqual(called, ["custom.test"], "only the explicit endpoint may be called");
    assert.equal(result.attempts.length, 1, "the explicit endpoint is not a chain");
    assert.equal(result.message, null);
  } finally {
    process.env = saved;
    globalThis.fetch = original;
  }
});

await check("a provider id is a real id, not a retired one", async () => {
  // Two presets shipped pointing at ids the provider does not serve, which fails
  // in a way that reads like an outage. These are regression guards.
  const { llmDiagnostics } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  try {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OPENAI_API_KEY;

    process.env.OPENROUTER_API_KEY = "sk-or-good";
    const openrouter = llmDiagnostics();
    assert.ok(
      !openrouter.model?.includes(":free"),
      `OpenRouter's :free suffix is not a catalogue id: ${openrouter.model}`,
    );

    delete process.env.OPENROUTER_API_KEY;
    process.env.GEMINI_API_KEY = "AIza-test";
    const gemini = llmDiagnostics();
    assert.notEqual(
      gemini.model,
      "gemini-3.5-flash",
      "gemini-3.5-flash is not in Google's published model table",
    );
    assert.ok(
      /^gemini-\d/.test(gemini.model ?? ""),
      `the Gemini default must be a real Gemini id: ${gemini.model}`,
    );
  } finally {
    process.env = saved;
  }
});

await check("the provider chain is reported without leaking keys", async () => {
  const { llmDiagnostics } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  try {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OPENAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-secret";
    process.env.GROQ_API_KEY = "gsk-secret";

    const diagnostics = llmDiagnostics();
    assert.deepEqual(
      diagnostics.providerChain,
      ["openrouter", "groq"],
      "the chain must reflect the order providers will be tried",
    );
    const serialised = JSON.stringify(diagnostics);
    assert.ok(!serialised.includes("sk-or-secret"), "no key may be serialised");
    assert.ok(!serialised.includes("gsk-secret"), "no fallback key may be serialised");
  } finally {
    process.env = saved;
  }
});

console.log(`\n${passed} passed, ${failures.length} failed.\n`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
