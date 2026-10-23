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

console.log(`\n${passed} passed, ${failures.length} failed.\n`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
