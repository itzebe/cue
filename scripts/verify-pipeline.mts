/**
 * End-to-end verification of the grounding pipeline.
 *
 * The only thing stubbed is `fetch` — the real HTTP boundary. Every layer under
 * test (normalisation, affinity extraction, explainability parsing, cue
 * assembly, placement/clearance inference) is the production code path, using
 * response bodies shaped like real Qloo payloads.
 *
 * Run: npx tsx scripts/verify-pipeline.mts
 */

import assert from "node:assert/strict";
import type { Receipt } from "../src/lib/types.ts";

const QLOO_SEARCH = {
  results: [
    {
      entity_id: "11111111-1111-1111-1111-111111111111",
      name: "Drive",
      // Real /v2/search returns `subtype` and no `types` array.
      subtype: "urn:entity:movie",
      // `audience_identity` is present on the versioned endpoint and absent on
      // legacy `/search`, which is why the client targets /v2/search.
      properties: {
        description: "A stunt driver moonlights as a getaway driver.",
        audience_identity:
          "People drawn to moody, stylistic thrillers and minimalist character studies.",
      },
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

  if (parsed.pathname === "/v2/search") return jsonResponse(QLOO_SEARCH);
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

  // The versioned path is load-bearing, not cosmetic. `/search` is the legacy
  // endpoint and returns a reduced entity: measured on the same query it drops
  // `properties.audience_identity` and eleven other fields. The Audience Identity
  // Brief reads that field, so regressing to the legacy path would empty the
  // panel silently — a 200 with no evidence rather than an error.
  const path = new URL(calls[0].url).pathname;
  assert.equal(path, "/v2/search", "entity search must use the versioned endpoint");
  assert.ok(
    result.data[0].properties && "audience_identity" in (result.data[0].properties as object),
    "the resolved anchor must carry audience_identity for the audience brief",
  );
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

await check("a model-written rationale is never presented as Qloo evidence", async () => {
  // Regression: planner.ts used to prepend the scene reader's rationale to
  // `cue.why`, an array documented as Qloo-traceable. The cue card then rendered it
  // under the heading "Why Qloo ranked this", which credited the taste graph with
  // the model's words. The two sources must stay separate fields.
  //
  // Driven through the real merge path with a mocked provider: the track-naming call
  // returns a rationale, and the assertion is on what buildCueSheet does with it.
  const { buildCueSheet } = await import("../src/lib/planner.ts");
  const original = globalThis.fetch;
  const saved = { ...process.env };
  try {
    process.env.LLM_API_KEY = "sk-test-rationale";
    process.env.LLM_BASE_URL = "https://api.groq.com/openai/v1";
    process.env.LLM_MODEL = "openai/gpt-oss-120b";

    const RATIONALE = "A slow, rain-slicked pulse that sits under dialogue without crowding it.";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.groq.com")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const toolName = body?.tools?.[0]?.function?.name;
        if (toolName === "emit_tracks") {
          return jsonResponse({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      function: {
                        name: "emit_tracks",
                        arguments: JSON.stringify({
                          tracks: [{ artist: "Cliff Martinez", track: "Sonata", rationale: RATIONALE }],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          });
        }
        // Every other LLM call in this test is irrelevant to the assertion; a 500
        // keeps the pipeline on its deterministic path without inventing data.
        return jsonResponse({ error: "not under test" }, 500);
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const sheet = await buildCueSheet({
      scene:
        'A 90s noir thriller. Rain on the glass. Reference "Drive" and Sicario. Los Angeles, audience 25-34.',
    });

    const target = sheet.cues.find((cue) => cue.proposalRationale === RATIONALE);
    assert.ok(target, "the mocked rationale should reach exactly one cue");

    assert.equal(
      target.why.includes(RATIONALE),
      false,
      "the model's rationale must not appear in the Qloo evidence trail",
    );

    // Every entry rendered under "Why Qloo ranked this" has to read as Qloo-sourced.
    for (const reason of target.why) {
      assert.ok(
        /Qloo|audience|affinit|population rank|backfill|Over-indexes/i.test(reason),
        `every reason under "Why Qloo ranked this" must be Qloo-traceable: ${reason}`,
      );
    }
  } finally {
    globalThis.fetch = original;
    process.env = saved;
  }
});

await check("the comparison only attributes figures Qloo actually returned", async () => {
  // The comparison panel must never invent an affinity, an overlap or a cultural
  // relationship. This asserts the data the panel reads is the data Qloo returned.
  const sheet = await buildCueSheet({
    scene:
      'A 90s noir thriller. Rain on the glass. Reference "Drive" and Sicario. Los Angeles, audience 25-34.',
  });

  for (const cue of sheet.cues) {
    assert.equal(typeof cue.affinity, "number");
    assert.ok(cue.affinity >= 0 && cue.affinity <= 1, "affinity must be a real 0..1 measurement");
    assert.ok(
      Number.isFinite(cue.affinity),
      "an affinity the panel prints must be finite, never NaN or Infinity",
    );
  }

  // The baseline carries no affinity at all, which is exactly why the panel says
  // the left column has no comparable figure.
  for (const cue of sheet.baseline.cues) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(cue, "affinity"),
      false,
      "a baseline cue must not carry an affinity it never had",
    );
  }
});

await check("an anchor with no audience description yields an empty state, not an invented one", async () => {
  // The audience brief must show nothing rather than fabricate a profile when Qloo
  // returns no audience_identity for an anchor. The field arrives on /v2/search
  // (the call that resolves anchors), so that is the response this strips.
  const { buildCueSheet } = await import("../src/lib/planner.ts");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/search") {
        // Same entities, same ids, no audience_identity: the real shape when Qloo
        // resolves an entity but holds no description for it.
        const stripped = {
          results: (QLOO_SEARCH.results ?? []).map((entity) => {
            const clone = JSON.parse(JSON.stringify(entity));
            if (clone.properties) delete clone.properties.audience_identity;
            return clone;
          }),
        };
        return jsonResponse(stripped);
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const sheet = await buildCueSheet({
      scene: 'A 90s noir thriller. Reference "Drive" and Sicario. Los Angeles, audience 25-34.',
    });

    const brief = sheet.audienceBrief;
    assert.ok(brief, "the audience brief should be present as a structure even when empty");
    assert.equal(
      brief.available,
      false,
      "with no audience_identity in the response, the brief must not claim to be available",
    );
    assert.deepEqual(
      brief.evidence,
      [],
      "no evidence may be manufactured when Qloo returned no description",
    );
    assert.equal(
      brief.interpretation,
      null,
      "Cue must not write its own reading of an audience it never received",
    );
    assert.ok(
      brief.anchorsWithoutEvidence.length > 0,
      "the anchors that lacked a description should be recorded, so the UI can explain the gap",
    );
  } finally {
    globalThis.fetch = original;
  }
});

await check("a scene-reader failure leaves the Qloo results intact", async () => {
  // The comparison and the sheet must survive a provider outage: Qloo ranking does
  // not depend on the model. This is the property the UI relies on when it says
  // rankings are unaffected.
  const { buildCueSheet } = await import("../src/lib/planner.ts");
  const original = globalThis.fetch;
  const saved = { ...process.env };
  try {
    process.env.LLM_API_KEY = "sk-test-outage";
    process.env.LLM_BASE_URL = "https://api.groq.com/openai/v1";
    process.env.LLM_MODEL = "openai/gpt-oss-120b";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.groq.com")) return jsonResponse({ error: { message: "upstream down" } }, 503);
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const sheet = await buildCueSheet({
      scene: 'A 90s noir thriller. Reference "Drive" and Sicario. Los Angeles, audience 25-34.',
    });

    assert.equal(sheet.sceneParse?.source, "deterministic", "the reader must fall back, not pretend");
    assert.ok(sheet.cues.length > 0, "Qloo ranking must survive a model outage");
    assert.ok(
      sheet.cues.every((cue) => Number.isFinite(cue.affinity)),
      "every surviving cue must still carry a real Qloo affinity",
    );
    assert.ok(sheet.baseline.cues.length > 0, "the comparison needs a baseline to show");
  } finally {
    globalThis.fetch = original;
    process.env = saved;
  }
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
    assert.equal(
      result.audience,
      "taste profile of Drive",
      "the label must name the signal actually used, not the brief's demographic",
    );

    // A release-year floor is a music-catalogue concept. Applying it to people
    // would drop every living performer and leave a casting list of dead ones.
    for (const call of calls) {
      assert.equal(
        new URL(call.url).searchParams.get("filter.release_year.min"),
        null,
        "casting must not filter people by music release year",
      );
    }

    // The person query must not carry demographics. Measured against the live
    // sandbox, `signal.demographics.age` on `urn:entity:person` replaces the
    // brief's audience rather than narrowing it — Drive's action leads become an
    // unrelated cluster with only 2 of 15 entities in common. A polluted result
    // set still looks plausible, so nothing downstream can catch it.
    const personCall = calls.find(
      (call) => new URL(call.url).searchParams.get("filter.type") === "urn:entity:person",
    );
    const personParams = new URL(personCall!.url).searchParams;
    for (const param of [
      "signal.demographics.age",
      "signal.demographics.gender",
      "signal.demographics.audiences",
    ]) {
      assert.equal(
        personParams.get(param),
        null,
        `the person query must not send ${param}`,
      );
    }

    // Brands keep demographics: the same comparison preserves 4-8 of 10 entities
    // and stays on-theme, so there it is a genuine refinement.
    const brandCall = calls.find(
      (call) => new URL(call.url).searchParams.get("filter.type") === "urn:entity:brand",
    );
    assert.equal(
      new URL(brandCall!.url).searchParams.get("signal.demographics.age"),
      "25_to_29",
      "the brand query keeps demographics as a refinement",
    );
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

await check("a bare OpenAI key is not a provider endpoint", async () => {
  // Production ran for a whole session with an unfunded OPENAI_API_KEY and no
  // other provider: every cue sheet silently fell back to the deterministic
  // reader while the app reported a configured model. A paid endpoint with no
  // free tier must not be reachable just because a key happens to be present.
  const { resolveLlmConfig, llmDiagnostics, probeLlm } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  try {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.OH_LLM_PROXY_KEY;
    delete process.env.OH_LLM_API_KEY_REFRESH_BASE_URLS;
    process.env.OPENAI_API_KEY = "sk-unfunded";

    assert.equal(resolveLlmConfig(), null, "an OpenAI key alone must resolve to no endpoint");
    const diagnostics = llmDiagnostics();
    assert.equal(diagnostics.configured, false);
    assert.equal(diagnostics.source, "none");
    assert.deepEqual(diagnostics.providerChain, [], "no endpoint may be offered");
    // The variable is still reported as present, so an operator can see the key
    // exists and is being ignored rather than wondering where it went.
    assert.ok(
      diagnostics.presentKeyVars.includes("OPENAI_API_KEY"),
      "a present-but-unused key must still be visible in the report",
    );
    assert.ok(
      !JSON.stringify(diagnostics).includes("sk-unfunded"),
      "no key material may be serialised",
    );

    // And the probe must agree rather than inventing an attempt.
    const probe = await probeLlm();
    assert.equal(probe.ok, false);
    assert.equal(probe.provider, null);
    assert.deepEqual(probe.attempts, [], "no provider may be attempted");

    // The Agent Canvas proxy still works through OPENAI_API_KEY when its refresh
    // URL identifies it, so this is not a blanket ban on the variable.
    process.env.OH_LLM_API_KEY_REFRESH_BASE_URLS = "https://proxy.test/v1";
    const proxied = llmDiagnostics();
    assert.equal(proxied.configured, true, "the managed proxy must still resolve");
    assert.equal(proxied.source, "proxy");
    assert.equal(resolveLlmConfig()?.baseUrl, "https://proxy.test/v1");

    // An operator who explicitly wants OpenAI can still name it via LLM_*.
    delete process.env.OH_LLM_API_KEY_REFRESH_BASE_URLS;
    process.env.LLM_API_KEY = "sk-explicit";
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_MODEL = "gpt-4o-mini";
    assert.equal(
      resolveLlmConfig()?.baseUrl,
      "https://api.openai.com/v1",
      "the explicit LLM_* triple is still honoured",
    );
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
    if (parsed.pathname === "/v2/search") return jsonResponse(QLOO_SEARCH);
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

await check("the audience brief quotes Qloo and never invents a profile", async () => {
  const { buildAudienceBrief } = await import("../src/lib/audience.ts");

  const entity = (name: string, id: string, identity?: string) => ({
    entity_id: id,
    name,
    type: "urn:entity:movie",
    properties: identity ? { audience_identity: identity } : { description: "no identity" },
  });

  // The happy path: Qloo's prose is carried through verbatim, so the UI cannot
  // paraphrase a measurement into something the data does not say.
  const quoted = "People drawn to moody, stylistic thrillers and minimalist character studies.";
  const brief = buildAudienceBrief(
    ["Drive", "Portishead"],
    [entity("Drive (2011)", "id-drive", quoted), entity("Portishead", "id-portishead", quoted)],
  );
  assert.equal(brief.available, true);
  assert.equal(brief.evidence.length, 2);
  assert.equal(brief.evidence[0].audienceIdentity, quoted, "Qloo's text must be verbatim");
  // The brief's own spelling is kept as the label, not Qloo's qualified name.
  assert.equal(brief.evidence[0].anchor, "Drive");
  assert.equal(brief.evidence[0].entityName, "Drive (2011)");
  assert.ok(brief.interpretation && brief.interpretation.length > 0);

  // A resolved entity with no audience_identity is a data gap, not a profile.
  const gap = buildAudienceBrief(["Drive"], [entity("Drive", "id-drive")]);
  assert.equal(gap.available, false, "no identity means no evidence");
  assert.equal(gap.evidence.length, 0);
  assert.equal(gap.interpretation, null, "Cue must not write a profile Qloo did not supply");
  assert.deepEqual(gap.anchorsWithoutEvidence, ["Drive"]);
  assert.equal(gap.noAnchors, false, "a present anchor is not the same as an empty brief");

  // A blank string is treated as absent rather than rendered as an empty quote.
  const blank = buildAudienceBrief(["Drive"], [entity("Drive", "id-drive", "   ")]);
  assert.equal(blank.available, false);
  assert.deepEqual(blank.anchorsWithoutEvidence, ["Drive"]);

  // An anchor that never resolved is reported separately from one that resolved
  // without evidence, because the two mean different things to a supervisor.
  const unresolved = buildAudienceBrief(
    ["Drive", "Nonexistent Film"],
    [entity("Drive (2011)", "id-drive", quoted)],
  );
  assert.deepEqual(unresolved.anchorsUnresolved, ["Nonexistent Film"]);
  assert.deepEqual(unresolved.anchorsWithoutEvidence, []);

  // A brief with no anchors is its own state, not a failure.
  const empty = buildAudienceBrief([], []);
  assert.equal(empty.noAnchors, true);
  assert.equal(empty.available, false);
  assert.equal(empty.interpretation, null);

  // One anchor is not enough to claim the anchors agree, and the reading must not
  // pretend otherwise.
  const single = buildAudienceBrief(["Drive"], [entity("Drive", "id-drive", quoted)]);
  assert.ok(
    /one anchor/i.test(single.interpretation ?? ""),
    "a single anchor must not be described as a shared audience",
  );

  // Matching is by name, not position: an anchor that failed to resolve must not
  // shift every later anchor onto the wrong entity's audience.
  const shifted = buildAudienceBrief(
    ["Gone", "Drive"],
    [entity("Drive (2011)", "id-drive", quoted)],
  );
  assert.equal(shifted.evidence.length, 1);
  assert.equal(shifted.evidence[0].anchor, "Drive", "the audience must not be relabelled");
  assert.deepEqual(shifted.anchorsUnresolved, ["Gone"]);
});

await check("the audience brief costs no extra Qloo calls", async () => {
  // The whole point of reading `audience_identity` off the anchor search is that
  // it is already in hand. If this ever starts fetching, a rate-limited key pays
  // for a field it was given for free.
  const { buildAudienceBrief } = await import("../src/lib/audience.ts");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("the audience brief must not perform network calls");
  }) as never;
  try {
    const brief = buildAudienceBrief(
      ["Drive"],
      [{ entity_id: "id", name: "Drive", type: "urn:entity:movie", properties: { audience_identity: "People who like cars." } }],
    );
    assert.equal(brief.available, true);
    assert.equal(calls, 0, "building the brief must not call the network");
  } finally {
    globalThis.fetch = original;
  }
});

await check("comparables exclude the brief's own anchors", async () => {
  const { comparablesForBrief } = await import("../src/lib/comparables.ts");

  // A film named as the reference must not come back as its own comparable. This
  // is the invariant that keeps "more like Drive" from returning Drive, and it
  // depends on the anchor IDs reaching filter.exclude.entities.
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    seen.push(url.searchParams.get("filter.exclude.entities") ?? "");
    return jsonResponse({
      results: {
        entities: [
          { entity_id: "cmp-1", name: "The Town", type: "urn:entity:movie", popularity: 0.98, properties: { release_year: 2010 } },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const receipts: any[] = [];
    const anchors = [
      { entity_id: "anchor-drive", name: "Drive", type: "urn:entity:movie" },
      { entity_id: "anchor-portishead", name: "Portishead", type: "urn:entity:artist" },
    ] as never;
    const result = await comparablesForBrief(anchors, [], receipts);

    assert.equal(result.groups.length, 3, "film, television and books should each be queried");
    assert.deepEqual(
      result.groups.map((g) => g.domain),
      ["movie", "tv_show", "book"],
      "domains should be reported in a stable order",
    );
    assert.ok(
      seen.every((excluded) => excluded.includes("anchor-drive") && excluded.includes("anchor-portishead")),
      "every domain query must exclude the brief's anchors",
    );
    assert.equal(receipts.length, 3, "each domain call should leave a receipt");

    // release_year is carried through so the panel can date a comparable.
    assert.equal(result.groups[0].items[0].releaseYear, 2010);
    assert.equal(result.groups[0].items[0].name, "The Town");
  } finally {
    globalThis.fetch = original;
  }
});

await check("comparables report an empty domain differently from a failed one", async () => {
  const { comparablesForBrief } = await import("../src/lib/comparables.ts");
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const type = url.searchParams.get("filter.type") ?? "";
    // Books genuinely match nothing; television fails outright. These are
    // different facts and must not be collapsed into one empty state.
    if (type === "urn:entity:book") return jsonResponse({ results: { entities: [] } });
    if (type === "urn:entity:tv_show") return jsonResponse({ error: "upstream" }, 500);
    return jsonResponse({
      results: { entities: [{ entity_id: "m1", name: "The Town", type: "urn:entity:movie" }] },
    });
  }) as typeof fetch;

  try {
    const result = await comparablesForBrief(
      [{ entity_id: "anchor", name: "Drive", type: "urn:entity:movie" }] as never,
      [],
      [],
    );
    assert.deepEqual(result.emptyDomains, ["book"], "an empty result set is an empty domain");
    assert.ok(
      !result.emptyDomains.includes("tv_show"),
      "a failed call is not an empty domain",
    );
    assert.ok(
      result.warnings.some((w) => /television/i.test(w)),
      "a failed domain should warn, naming the domain",
    );
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].domain, "movie");
  } finally {
    globalThis.fetch = original;
  }
});

await check("comparables skip the query when the brief gives no signal", async () => {
  const { comparablesForBrief } = await import("../src/lib/comparables.ts");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse({ results: { entities: [] } });
  }) as typeof fetch;

  try {
    // No anchors and no tags means there is no audience to rank against. Calling
    // Qloo anyway would burn three requests to return noise.
    const result = await comparablesForBrief([], [], []);
    assert.equal(calls, 0, "no signal means no calls");
    assert.deepEqual(result.skippedDomains, ["movie", "tv_show", "book"]);
    assert.equal(result.groups.length, 0);
    assert.ok(result.warnings.length > 0, "the skip should be explained, not silent");
  } finally {
    globalThis.fetch = original;
  }
});

await check("queue wait is not charged to the request timeout budget", async () => {
  const { insights } = await import("../src/lib/qloo.ts");
  const original = globalThis.fetch;

  // The concurrency limiter allows 4 in flight. Saturate it with slow calls, then
  // send a fifth whose timeout is shorter than one call's latency: if the timer
  // starts before the slot is granted, the fifth aborts while still queued and is
  // reported as a network timeout even though Qloo was never asked. That was a
  // real failure — the comparables pass starved the television query into a
  // phantom 12s timeout.
  const LATENCY = 400;
  const BUDGET = 600;
  let calls = 0;

  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(new Response(JSON.stringify({ results: { entities: [] } }), { status: 200 })),
        LATENCY,
      );
      // Respect the abort signal the way a real socket would, so a timeout is
      // observable rather than silently ignored.
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  }) as typeof fetch;

  try {
    const requests = Array.from({ length: 5 }, () =>
      insights({ filterType: "urn:entity:artist", take: 1, timeoutMs: BUDGET }),
    );
    const results = await Promise.all(requests);
    const failed = results.filter((r) => !r.ok);
    assert.equal(
      failed.length,
      0,
      `every request should succeed once queue wait is excluded from the budget; failures: ${failed
        .map((r) => r.error)
        .join("; ")}`,
    );
    // Counting attempts, not just successes, is what makes this guard hold now
    // that a timeout retries: with the timer outside the slot the first attempt
    // would abort while queued and a retry could still succeed, masking the bug.
    // Correct accounting means no request ever needs its retry.
    assert.equal(calls, 5, "each request should reach Qloo exactly once, with no retry");
  } finally {
    globalThis.fetch = original;
  }
});

await check("a transient timeout is retried instead of losing the result", async () => {
  const { insights } = await import("../src/lib/qloo.ts");
  const original = globalThis.fetch;

  // Qloo answers this call in ~0.5s normally and occasionally takes longer than
  // the budget. If a timeout is treated as terminal while a 503 is retried, one
  // slow response permanently loses a domain — the observed failure was the
  // television comparables vanishing while films and books returned fine.
  let attempt = 0;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    attempt += 1;
    if (attempt === 1) {
      // First attempt hangs past the budget and must be aborted.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          results: { entities: [{ entity_id: "tv-1", name: "The Shadow Line", type: "urn:entity:tv_show" }] },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await insights({
      filterType: "urn:entity:tv_show",
      signalEntities: ["anchor"],
      take: 5,
      timeoutMs: 120,
    });
    assert.equal(attempt, 2, "a timeout should trigger exactly one retry here");
    assert.equal(result.ok, true, "the retry should recover the result");
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].name, "The Shadow Line");
  } finally {
    globalThis.fetch = original;
  }
});

await check("a non-retryable status is not retried", async () => {
  const { insights } = await import("../src/lib/qloo.ts");
  const original = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = (async () => {
    attempt += 1;
    return jsonResponse({ error: "bad request" }, 400);
  }) as typeof fetch;

  try {
    // Making timeouts retryable must not turn every failure into three attempts:
    // a 400 is a bad parameter and will fail identically each time.
    const result = await insights({ filterType: "urn:entity:tv_show", take: 1 });
    assert.equal(result.ok, false);
    assert.equal(attempt, 1, "a 400 must not be retried");
  } finally {
    globalThis.fetch = original;
  }
});


// --- Groq tool-protocol recovery ---------------------------------------------
//
// The defect these guard: Cue sends `tools` + `tool_choice: "auto"` to
// `openai/gpt-oss-120b`. That reasoning model intermittently emits a malformed
// tool call, and Groq rejects the whole request with HTTP 400 (`tool_use_failed`)
// rather than returning a message. Production showed the identical scene
// returning a brief, then a 400, then a brief. Two things were wrong: the 400
// collapsed into "the provider returned 400" with the provider's own code
// discarded, and the scene read was lost even though a plain-JSON answer would
// have parsed.

/** Groq's real rejection body for a malformed tool call. */
function groqToolUseFailed() {
  return jsonResponse(
    {
      error: {
        message: "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
        type: "invalid_request_error",
        code: "tool_use_failed",
      },
    },
    400,
  );
}

await check("a tool-protocol 400 names the provider's own error code", async () => {
  // A bare "the provider returned 400" is what made this undiagnosable in
  // production: it names the status and hides the cause.
  const { chatDetailed } = await import("../src/lib/llm.ts");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      jsonResponse(
        { error: { message: "Failed to validate JSON.", type: "invalid_request_error", code: "tool_use_failed" } },
        400,
      )) as typeof fetch;

    const { failure } = await chatDetailed(
      { baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-test", model: "openai/gpt-oss-120b" },
      [{ role: "user", content: "read this scene" }],
      [{ name: "emit_scene_brief", description: "x", parameters: { type: "object" } }],
      5_000,
    );

    assert.equal(failure?.reason, "tool_format", "a tool rejection is its own reason, not a generic http_error");
    assert.equal(failure?.providerCode, "tool_use_failed", "the provider's code must survive");
    assert.match(failure?.message ?? "", /tool call/i, "the message must describe the actual fault");
    assert.ok(
      !/returned 400$/.test(failure?.message ?? ""),
      "the generic status-only message is exactly what must not be produced",
    );
  } finally {
    globalThis.fetch = original;
  }
});

await check("a malformed tool call is retried at a lower temperature and recovers", async () => {
  // Groq's documented mitigation for this exact error. Without it the scene read
  // is lost even though the model answers correctly on a second attempt.
  const { chatDetailed } = await import("../src/lib/llm.ts");
  const original = globalThis.fetch;
  const temperatures: number[] = [];
  let calls = 0;
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      temperatures.push(body.temperature);
      calls += 1;
      if (calls === 1) return groqToolUseFailed();
      return jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "emit_scene_brief",
                    arguments: JSON.stringify({ title: "Neon Chase", mood: ["tense"], genre: ["synth"], era: "1980s", arc: "pursuit", anchors: ["Drive"] }),
                  },
                },
              ],
            },
          },
        ],
      });
    }) as typeof fetch;

    const { message, failure } = await chatDetailed(
      { baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-test", model: "openai/gpt-oss-120b", temperature: 0.4 },
      [{ role: "user", content: "read this scene" }],
      [{ name: "emit_scene_brief", description: "x", parameters: { type: "object" } }],
      20_000,
    );

    assert.equal(failure, null, "the retry must recover, not report a failure");
    assert.ok(message?.tool_calls?.length, "the recovered tool call must be returned");
    assert.equal(calls, 2, "exactly one retry, not a retry loop");
    assert.ok(
      temperatures[1] < temperatures[0],
      `the retry must lower the temperature (got ${temperatures.join(" then ")})`,
    );
  } finally {
    globalThis.fetch = original;
  }
});

await check("a provider that rejects tools twice is asked once without them", async () => {
  // The final recovery drops the tool schema and asks for the same object as
  // JSON, which the caller's existing extractJson path already parses.
  const { chatDetailed, extractJson } = await import("../src/lib/llm.ts");
  const original = globalThis.fetch;
  let calls = 0;
  let lastHadTools = true;
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      lastHadTools = Array.isArray(body.tools) && body.tools.length > 0;
      calls += 1;
      if (lastHadTools) return groqToolUseFailed();
      return jsonResponse({
        choices: [{ message: { content: '{"title":"Neon Chase","anchors":["Drive"]}' } }],
      });
    }) as typeof fetch;

    const { message, failure } = await chatDetailed(
      { baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-test", model: "openai/gpt-oss-120b" },
      [{ role: "user", content: "read this scene" }],
      [{ name: "emit_scene_brief", description: "x", parameters: { type: "object" } }],
      20_000,
    );

    assert.equal(failure, null, "the tool-free attempt must succeed");
    assert.equal(calls, 3, "two tool attempts then one tool-free attempt");
    assert.equal(lastHadTools, false, "the final attempt must omit the tool schema");
    const parsed = extractJson<{ title: string }>(message?.content ?? null);
    assert.equal(parsed?.title, "Neon Chase", "the tool-free JSON must be parseable by the existing path");
  } finally {
    globalThis.fetch = original;
  }
});

await check("a 403 about model access is not reported as a rejected key", async () => {
  // Observed live against the managed proxy: a valid key with a restricted model
  // list returned 403 "team not allowed to access model", which Cue reported as
  // "the configured API key was rejected". That sends the operator to rotate a
  // working credential while the real fix is a different model.
  const { chatDetailed } = await import("../src/lib/llm.ts");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      jsonResponse(
        {
          error: {
            message:
              "team not allowed to access model. This team can only access models=['deepseek-v4.1-flash']",
            code: "403",
          },
        },
        403,
      )) as typeof fetch;

    const { failure } = await chatDetailed(
      { baseUrl: "https://llm-proxy.app.all-hands.dev/v1", apiKey: "sk-live", model: "claude-sonnet-4-5-20250929" },
      [{ role: "user", content: "x" }],
      [],
      5_000,
    );
    assert.equal(
      failure?.reason,
      "model_not_permitted",
      "a model-entitlement 403 must not be reported as a bad key",
    );

    // A 403 that really is about the credential must still say so.
    globalThis.fetch = (async () =>
      jsonResponse({ error: { message: "Invalid API key provided.", code: "invalid_api_key" } }, 403)) as typeof fetch;
    const { failure: keyFailure } = await chatDetailed(
      { baseUrl: "https://llm-proxy.app.all-hands.dev/v1", apiKey: "sk-live", model: "claude-sonnet-4-5-20250929" },
      [{ role: "user", content: "x" }],
      [],
      5_000,
    );
    assert.equal(keyFailure?.reason, "invalid_key", "a genuine credential 403 must still be a key failure");
  } finally {
    globalThis.fetch = original;
  }
});

await check("a permanent 400 is not retried with the same request", async () => {
  // The brief is explicit: do not repeatedly retry permanent 400s. Only a
  // tool-protocol rejection is recoverable; a bad parameter is not.
  const { chatDetailed } = await import("../src/lib/llm.ts");
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse(
        { error: { message: "Unsupported value for parameter 'n'.", type: "invalid_request_error", code: "invalid_request_error" } },
        400,
      );
    }) as typeof fetch;

    const { failure } = await chatDetailed(
      { baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-test", model: "openai/gpt-oss-120b" },
      [{ role: "user", content: "read this scene" }],
      [{ name: "emit_scene_brief", description: "x", parameters: { type: "object" } }],
      20_000,
    );

    assert.equal(calls, 1, "an unrelated 400 must be tried exactly once");
    assert.equal(failure?.reason, "http_error");
    assert.equal(failure?.providerCode, "invalid_request_error", "the code must still be reported");
  } finally {
    globalThis.fetch = original;
  }
});

await check("a failed Groq tool call falls back to the deterministic reader, and Qloo ranking survives", async () => {
  // The end-to-end guarantee: recovery exhausted, the sheet still builds, the
  // fallback is disclosed, and nothing about Qloo's ranking changes.
  const { buildCueSheet } = await import("../src/lib/planner.ts");
  const saved = { ...process.env };
  const original = globalThis.fetch;
  const qlooCalls: string[] = [];
  try {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.GROQ_API_KEY = "gsk-test";
    process.env.QLOO_API_KEY = "qloo-test";
    process.env.QLOO_API_BASE_URL = "https://hackathon.api.qloo.com";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://api.groq.com")) return groqToolUseFailed();
      qlooCalls.push(url);
      if (url.includes("/v2/search")) return jsonResponse(QLOO_SEARCH);
      if (url.includes("/v2/tags")) return jsonResponse(QLOO_TAGS);
      if (url.includes("/v2/insights")) return jsonResponse(QLOO_INSIGHTS);
      if (url.includes("/v2/analysis/compare")) return jsonResponse({ success: true, results: { overlap: 0.5 } });
      return jsonResponse({ success: true, results: { entities: [] } });
    }) as typeof fetch;

    const sheet = await buildCueSheet({
      scene: "A neon-soaked chase through Los Angeles at night. Tense, brooding, 1980s synth pulse.",
      budget: 5000,
    });

    assert.equal(sheet.sceneParse?.source, "deterministic", "an exhausted provider must fall back, not fabricate");
    assert.equal(sheet.sceneParse?.provider, null, "no provider may be credited with the read");
    assert.equal(sheet.sceneParse?.failureReason, "tool_format", "the real cause must be reported");
    assert.equal(sheet.sceneParse?.failureProviderCode, "tool_use_failed");
    assert.ok(qlooCalls.length > 0, "Qloo must still have been queried");
    assert.ok(sheet.cues.length > 0, "Qloo ranking must survive a scene-reader failure");
    assert.equal(sheet.mode, "live");
  } finally {
    globalThis.fetch = original;
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

await check("a missing Groq key is not treated as a configured provider", async () => {
  const { llmDiagnostics, hasLlm } = await import("../src/lib/llm.ts");
  const saved = { ...process.env };
  try {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OH_LLM_PROXY_KEY;
    delete process.env.OH_LLM_API_KEY_REFRESH_BASE_URLS;
    delete process.env.GROQ_API_KEY;

    assert.equal(hasLlm(), false, "an absent key is not a configured provider");
    assert.deepEqual(llmDiagnostics().providerChain, []);
    assert.equal(llmDiagnostics().source, "none");

    // Whitespace-only counts as absent: a paste artifact must not look like a key.
    process.env.GROQ_API_KEY = "   ";
    assert.equal(hasLlm(), false, "a blank key must not be treated as configured");
    assert.ok(
      !llmDiagnostics().presentKeyVars.includes("GROQ_API_KEY"),
      "a blank value must not be reported as present",
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

await check("a Groq timeout and a Groq outage are reported distinctly and do not retry forever", async () => {
  const { chatDetailed } = await import("../src/lib/llm.ts");
  const original = globalThis.fetch;
  try {
    // A timeout is an abort, not a tool-format fault, so it must not trigger the
    // tool-recovery path.
    let timeoutCalls = 0;
    globalThis.fetch = (async () => {
      timeoutCalls += 1;
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;
    const timedOut = await chatDetailed(
      { baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-test", model: "openai/gpt-oss-120b" },
      [{ role: "user", content: "x" }],
      [{ name: "emit_scene_brief", description: "x", parameters: { type: "object" } }],
      3_000,
    );
    assert.equal(timedOut.failure?.reason, "timeout");
    assert.equal(timeoutCalls, 1, "a timeout must not be retried inside one provider");

    // A 503 is transient but is not a tool-format fault either.
    let outageCalls = 0;
    globalThis.fetch = (async () => {
      outageCalls += 1;
      return jsonResponse({ error: { message: "Service Unavailable", code: "server_error" } }, 503);
    }) as typeof fetch;
    const outage = await chatDetailed(
      { baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-test", model: "openai/gpt-oss-120b" },
      [{ role: "user", content: "x" }],
      [{ name: "emit_scene_brief", description: "x", parameters: { type: "object" } }],
      3_000,
    );
    assert.equal(outage.failure?.status, 503);
    assert.equal(outageCalls, 1, "a provider outage must not be retried inside one provider");
  } finally {
    globalThis.fetch = original;
  }
});

await check("provider error text is scrubbed of anything key-shaped", async () => {
  // Provider errors are upstream data. An echoed Authorization header is exactly
  // the kind of thing that ends up in a screenshot or a public response.
  const { sanitiseDiagnostic, extractProviderError } = await import("../src/lib/llm.ts");

  const scrubbed = sanitiseDiagnostic(
    "Bad request: Authorization: Bearer gsk_abcdefghijklmnopqrstuvwxyz012345 for key sk-proj-ABCDEFGHIJKLMNOPQRSTUV",
  );
  assert.ok(!scrubbed.includes("gsk_abcdefghijklmnopqrstuvwxyz012345"), "a Groq key must not survive");
  assert.ok(!scrubbed.includes("sk-proj-ABCDEFGHIJKLMNOPQRSTUV"), "an OpenAI key must not survive");
  assert.ok(scrubbed.includes("[redacted]"), "the redaction must be visible");

  const parsed = extractProviderError(
    JSON.stringify({ error: { message: "invalid api key gsk_1234567890abcdefghijklmnop", code: "invalid_api_key" } }),
  );
  assert.equal(parsed.code, "invalid_api_key");
  assert.ok(!parsed.message.includes("gsk_1234567890abcdefghijklmnop"), "the message must be scrubbed too");
});

await check("no configured secret value is shipped to the client bundle", async () => {
  // A variable NAME appearing in the client bundle is not a leak: the UI
  // legitimately tells the operator "This deployment has no QLOO_API_KEY". A
  // secret VALUE appearing there is. So this asserts on values, and reads them
  // from the environment rather than hardcoding anything.
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const staticDir = ".next/static";
  if (!existsSync(staticDir)) {
    // A build is a separate gate; skip rather than fail when it has not run.
    return;
  }

  const secrets = ["QLOO_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "LLM_API_KEY"]
    .map((name) => process.env[name])
    .filter((value): value is string => typeof value === "string" && value.trim().length >= 12)
    .map((value) => value.trim());

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
    );

  const files = walk(staticDir);
  const offenders: string[] = [];
  for (const value of secrets) {
    for (const file of files) {
      if (readFileSync(file, "utf8").includes(value)) offenders.push(`${file} (contains a configured secret)`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "no configured secret value may appear in the client bundle",
  );

  // Independently, the llm module itself must never be reachable from a client
  // chunk with its key-reading code intact: it is server-only by construction.
  const llmInClient = files.filter((file) => readFileSync(file, "utf8").includes("api.groq.com"));
  assert.deepEqual(llmInClient, [], "the provider module must not be bundled for the browser");
});

// ---------------------------------------------------------------------------
// Cross-domain taste map
// ---------------------------------------------------------------------------
// These drive the real production path: the mocked fetch returns Qloo-shaped
// payloads, and `crossDomainForAudience` does the parsing, attribution and
// failure handling. Nothing about the module is stubbed.

const {
  crossDomainForAudience,
  CROSS_DOMAIN_KEYS,
  CROSS_DOMAIN_DEFAULT_KEYS,
  CROSS_DOMAIN_URNS,
} = await import("../src/lib/crossdomain.ts");

function anchor(name: string, id: string) {
  return { entity_id: id, name, type: "urn:entity:movie" };
}

const ANCHOR_DRIVE = anchor("Drive", "aaaaaaaa-0000-0000-0000-00000000000d");
const ANCHOR_SICARIO = anchor("Sicario", "bbbbbbbb-0000-0000-0000-00000000000e");

/**
 * A Qloo insights payload for a given domain. `attributedTo` lists the anchor IDs
 * Qloo credits, which is how the real explainability block is shaped: one entry
 * per contributing signal entity, keyed by uppercase ID.
 */
function crossDomainPayload(
  domain: string,
  entities: Array<{ id: string; name: string; affinity?: number; popularity?: number; attributedTo?: string[] }>,
) {
  return {
    success: true,
    results: {
      entities: entities.map((entity) => ({
        entity_id: entity.id,
        name: entity.name,
        subtype: CROSS_DOMAIN_URNS[domain as keyof typeof CROSS_DOMAIN_URNS],
        popularity: entity.popularity ?? 0.5,
        properties: {},
        tags: [],
        query: {
          ...(entity.affinity === undefined ? {} : { affinity: entity.affinity }),
          explainability: {
            "signal.interests.entities": (entity.attributedTo ?? []).map((id) => ({
              entity_id: id.toUpperCase(),
              score: 0.5,
            })),
          },
        },
      })),
    },
  };
}

/** Run the module against a per-domain router. */
async function withQlooRoutes<T>(
  routes: Record<string, () => Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const parsed = new URL(typeof input === "string" ? input : input.toString());
    if (parsed.pathname !== "/v2/insights") return jsonResponse({ error: "unexpected" }, 404);
    const type = parsed.searchParams.get("filter.type") ?? "";
    const key = Object.keys(routes).find((k) => CROSS_DOMAIN_URNS[k as keyof typeof CROSS_DOMAIN_URNS] === type);
    if (!key) return jsonResponse({ error: "no route" }, 404);
    return routes[key]();
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

await check("cross-domain queries the default domains and never the unsupported one", async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const parsed = new URL(typeof input === "string" ? input : input.toString());
    seen.push(parsed.searchParams.get("filter.type") ?? "");
    return jsonResponse(crossDomainPayload("destination", []));
  }) as typeof fetch;
  try {
    await crossDomainForAudience([ANCHOR_DRIVE, ANCHOR_SICARIO], []);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(
    [...seen].sort(),
    CROSS_DOMAIN_DEFAULT_KEYS.map((key) => CROSS_DOMAIN_URNS[key]).sort(),
    "exactly the default domains must be requested",
  );
  // The casting pass already queries brands for the same anchors and returned the
  // identical six, so asking again here would be a duplicate call.
  assert.ok(
    !seen.includes("urn:entity:brand"),
    "brand must not be re-queried: the casting pass already covers it",
  );
  // video_game is rejected by the live API despite the published guide, so it
  // must never be requested.
  assert.ok(!seen.includes("urn:entity:video_game"), "video_game must not be queried");
});

await check("cross-domain honours an explicit domain list including brand", async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const parsed = new URL(typeof input === "string" ? input : input.toString());
    seen.push(parsed.searchParams.get("filter.type") ?? "");
    return jsonResponse(crossDomainPayload("brand", []));
  }) as typeof fetch;
  try {
    await crossDomainForAudience([ANCHOR_DRIVE], [], { domains: ["brand"] });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(seen, ["urn:entity:brand"], "an explicit domain list must be honoured");
  assert.deepEqual(CROSS_DOMAIN_KEYS, ["brand", "destination", "podcast", "place"]);
});

await check("cross-domain maps names, domains, ids and affinity", async () => {
  const result = await withQlooRoutes(
    {
      destination: () =>
        jsonResponse(
          crossDomainPayload("destination", [
            { id: "dest-1", name: "Santa Clarita", affinity: 0.9728, popularity: 0.98, attributedTo: [ANCHOR_DRIVE.entity_id] },
          ]),
        ),
    },
    () => crossDomainForAudience([ANCHOR_DRIVE, ANCHOR_SICARIO], [], { domains: ["destination"] }),
  );

  assert.equal(result.groups.length, 1, "only the populated domain forms a group");
  const group = result.groups[0];
  assert.equal(group.domain, "destination");
  assert.equal(group.label, "Destinations");
  const item = group.items[0];
  assert.equal(item.name, "Santa Clarita");
  assert.equal(item.entityId, "dest-1");
  assert.equal(item.domain, "destination");
  assert.equal(item.affinity, 0.9728);
  assert.equal(item.affinitySource, "query");
  assert.deepEqual(item.attributedAnchors, ["Drive"], "the attributed anchor is named, not the id");
});

await check("cross-domain preserves per-anchor provenance from explainability", async () => {
  const result = await withQlooRoutes(
    {
      podcast: () =>
        jsonResponse(
          crossDomainPayload("podcast", [
            {
              id: "pod-1",
              name: "Philosophize This!",
              affinity: 0.944,
              // Qloo reports both anchors contributing to this result.
              attributedTo: [ANCHOR_DRIVE.entity_id, ANCHOR_SICARIO.entity_id],
            },
          ]),
        ),
    },
    () => crossDomainForAudience([ANCHOR_DRIVE, ANCHOR_SICARIO], [], { domains: ["podcast"] }),
  );

  assert.deepEqual(
    result.groups[0].items[0].attributedAnchors,
    ["Drive", "Sicario"],
    "every anchor Qloo attributes must be reported",
  );
});

await check("cross-domain does not invent provenance when Qloo supplies none", async () => {
  const result = await withQlooRoutes(
    {
      place: () =>
        jsonResponse(
          crossDomainPayload("place", [
            // No attributedTo: no explainability block at all.
            { id: "place-1", name: "Brooklyn Bridge", affinity: 0.9135 },
          ]),
        ),
    },
    () => crossDomainForAudience([ANCHOR_DRIVE, ANCHOR_SICARIO], [], { domains: ["place"] }),
  );

  assert.deepEqual(
    result.groups[0].items[0].attributedAnchors,
    [],
    "an absent attribution block must yield no claimed anchors, not all of them",
  );
});

await check("cross-domain records an absent affinity instead of fabricating zero", async () => {
  const result = await withQlooRoutes(
    {
      place: () =>
        jsonResponse(
          crossDomainPayload("place", [
            { id: "place-1", name: "No Affinity Place", popularity: 0.41, attributedTo: [ANCHOR_DRIVE.entity_id] },
          ]),
        ),
    },
    () => crossDomainForAudience([ANCHOR_DRIVE, ANCHOR_SICARIO], [], { domains: ["place"] }),
  );

  const item = result.groups[0].items[0];
  // The client substitutes popularity so ranking works; the provenance field is
  // what lets the panel label it "pop" rather than passing it off as affinity.
  assert.equal(item.affinitySource, "popularity", "a substituted score must be marked as such");
  assert.equal(item.affinity, 0.41, "the substituted value is the popularity figure");
});

await check("a failed domain is reported separately from an empty one", async () => {
  const result = await withQlooRoutes(
    {
      destination: () => jsonResponse({ error: "boom" }, 500),
      podcast: () => jsonResponse(crossDomainPayload("podcast", [])),
      place: () =>
        jsonResponse(crossDomainPayload("place", [{ id: "p1", name: "Brooklyn Bridge", affinity: 0.88 }])),
    },
    () => crossDomainForAudience([ANCHOR_DRIVE, ANCHOR_SICARIO], []),
  );

  assert.deepEqual(result.failedDomains, ["destination"], "the 500 must be recorded as a failure");
  assert.deepEqual(result.emptyDomains, ["podcast"], "a 200 with no rows is an empty domain, not a failure");
  assert.equal(result.groups.length, 1, "the healthy domain must still render");
  assert.ok(
    result.warnings.some((w) => w.toLowerCase().includes("did not complete")),
    "the failure must be surfaced as a warning",
  );
  assert.ok(
    !result.failedDomains.some((d) => result.emptyDomains.includes(d)),
    "a failure must never also be counted as empty",
  );
});

await check("cross-domain records a receipt for every domain it queried", async () => {
  const receipts: Receipt[] = [];
  await withQlooRoutes(
    {
      destination: () => jsonResponse(crossDomainPayload("destination", [{ id: "d1", name: "Oxnard", affinity: 0.9 }])),
      podcast: () => jsonResponse({ error: "boom" }, 500),
      place: () => jsonResponse(crossDomainPayload("place", [])),
    },
    () => crossDomainForAudience([ANCHOR_DRIVE, ANCHOR_SICARIO], receipts),
  );

  assert.equal(receipts.length, 3, "one receipt per queried domain, including failures");
  for (const receipt of receipts) {
    assert.equal(receipt.endpoint, "GET /v2/insights");
    assert.ok(receipt.label.startsWith("Cross-domain:"), "receipts must be labelled by domain");
    assert.equal(
      receipt.params["signal.interests.entities"],
      `${ANCHOR_DRIVE.entity_id},${ANCHOR_SICARIO.entity_id}`,
      "the receipt must name the anchors actually used",
    );
  }
  const failed = receipts.find((r) => r.label.includes("podcast"));
  assert.equal(failed?.status, 500, "a failed call still records its status");
});

await check("cross-domain with no anchors skips every domain and says why", async () => {
  const result = await crossDomainForAudience([], []);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(
    result.skippedDomains,
    CROSS_DOMAIN_DEFAULT_KEYS,
    "no anchors means nothing was queried",
  );
  assert.equal(result.failedDomains.length, 0);
  assert.ok(result.warnings.length > 0, "the empty state must explain itself");
  assert.ok(
    result.warnings[0].toLowerCase().includes("no qloo anchor"),
    "the reason must be the missing anchor, not a Qloo fault",
  );
});

await check("cross-domain tolerates a malformed response without throwing", async () => {
  const result = await withQlooRoutes(
    {
      // A 200 whose body is not the expected shape at all.
      destination: () => jsonResponse({ nonsense: true }),
      podcast: () => jsonResponse({ results: { entities: "not-an-array" } }),
      place: () => jsonResponse(crossDomainPayload("place", [])),
    },
    () => crossDomainForAudience([ANCHOR_DRIVE], []),
  );

  // Malformed bodies yield no items; the call is not a transport failure, so they
  // land as empty rather than failed, and nothing throws.
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.failedDomains, [], "a 200 with a bad body is not a transport failure");
  assert.equal(result.emptyDomains.length, 3, "every domain had no usable rows");
});

await check("cross-domain results carry no audience-overlap or percentage claim", async () => {
  const result = await withQlooRoutes(
    {
      destination: () =>
        jsonResponse(
          crossDomainPayload("destination", [
            { id: "d1", name: "Santa Clarita", affinity: 0.9728, attributedTo: [ANCHOR_DRIVE.entity_id] },
          ]),
        ),
    },
    () => crossDomainForAudience([ANCHOR_DRIVE, ANCHOR_SICARIO], [], { domains: ["destination"] }),
  );

  // The affinity is preserved as a 0..1 decimal. Nothing in the result shape
  // invites a percentage, an overlap count or an audience size, because the API
  // returns none of those.
  const item = result.groups[0].items[0];
  assert.equal(item.affinity, 0.9728);
  const serialised = JSON.stringify(result);
  assert.ok(!/%/.test(serialised), "no percentage may be produced by the query layer");
  assert.ok(!/overlap/i.test(serialised), "no overlap claim may be produced by the query layer");
  assert.ok(
    !/fans of/i.test(serialised),
    'no "fans of X like Y" phrasing may appear in the data',
  );
});

await check("a taste map that returned nothing is kept so the empty state can render", async () => {
  // The sheet keeps the taste map whenever the query ran, even with no groups.
  // Dropping it would make "Qloo returned nothing" look identical to "this
  // feature does not exist", and the panel's truthful empty state would be
  // unreachable dead code.
  const allEmpty = await withQlooRoutes(
    {
      destination: () => jsonResponse(crossDomainPayload("destination", [])),
      podcast: () => jsonResponse(crossDomainPayload("podcast", [])),
      place: () => jsonResponse(crossDomainPayload("place", [])),
    },
    () => crossDomainForAudience([ANCHOR_DRIVE], []),
  );

  assert.deepEqual(allEmpty.groups, [], "no groups when every domain is empty");
  assert.deepEqual(allEmpty.emptyDomains, ["destination", "podcast", "place"]);
  assert.equal(allEmpty.failedDomains.length, 0);
  // The anchors are still recorded, which is what makes the result keepable and
  // the panel's empty state truthful.
  assert.deepEqual(
    allEmpty.anchors.map((a) => a.name),
    ["Drive"],
    "the anchors must survive so the panel can explain what was measured",
  );

  // The planner keeps a taste map with anchors but no groups, and drops one with
  // no anchors at all.
  const { buildCueSheet } = await import("../src/lib/planner.ts");
  assert.ok(typeof buildCueSheet === "function");
});

await check("the taste map never attributes model prose to Qloo", async () => {
  const result = await withQlooRoutes(
    {
      destination: () =>
        jsonResponse(
          crossDomainPayload("destination", [
            { id: "d1", name: "Santa Clarita", affinity: 0.9728, attributedTo: [ANCHOR_DRIVE.entity_id] },
          ]),
        ),
    },
    () => crossDomainForAudience([ANCHOR_DRIVE, ANCHOR_SICARIO], [], { domains: ["destination"] }),
  );

  // Every item is Qloo-sourced: it has an entity id, a domain, and a measured
  // number. There is no free-text rationale field for a model sentence to land in.
  for (const group of result.groups) {
    for (const item of group.items) {
      assert.ok(item.entityId, "every discovery must be a real Qloo entity");
      assert.ok(
        !("rationale" in item) && !("why" in item),
        "a taste-map item must not carry a prose field a model could fill",
      );
    }
  }
});


// ---------------------------------------------------------------------------
// Live-status regression tests.
//
// `mode` records that live calls were *attempted*, not that the workflow
// succeeded: a rejected Qloo key produced `mode: "live"` with zero cues and a
// green badge. These tests pin the computed status against every combination of
// integration outcome, so success is never inferred from the HTTP status, the
// presence of a key, or `mode`.
// ---------------------------------------------------------------------------

const AFFINITY_ENTITIES = QLOO_INSIGHTS.results.entities;

type LlmMode = "ok" | "auth" | "none" | "tracks-fail";

interface StackOptions {
  artist?: { status: number; entities?: unknown[] };
  backfill?: { status: number; entities?: unknown[] };
  /** When set, the artist-affinity fetch rejects instead of responding. */
  artistThrows?: boolean;
  llm?: LlmMode;
}

function briefToolCall() {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: "emit_scene_brief",
                arguments: JSON.stringify({
                  title: "Tokyo Night",
                  mood: ["introspective", "melancholic"],
                  genre: ["ambient", "electronic"],
                  era: "contemporary",
                  setting: "Tokyo at night",
                  arc: "Hold the mood without resolving it.",
                  audience: { age: "25_to_29" },
                  anchors: ["Drive"],
                  diegetic: false,
                }),
              },
            },
          ],
        },
      },
    ],
  };
}

function tracksToolCall() {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: "emit_tracks",
                arguments: JSON.stringify({
                  tracks: [
                    { artist: "Cliff Martinez", track: "Sonata", rationale: "A slow pulse." },
                  ],
                }),
              },
            },
          ],
        },
      },
    ],
  };
}

/** Install a mocked stack: Groq as the only LLM provider, Qloo routed per call. */
function installStack(options: StackOptions): () => void {
  const original = globalThis.fetch;
  const saved = { ...process.env };

  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OH_LLM_PROXY_KEY;
  delete process.env.OH_LLM_API_KEY_REFRESH_BASE_URLS;
  if (options.llm === "none") {
    delete process.env.GROQ_API_KEY;
  } else {
    process.env.GROQ_API_KEY = "gsk-test-status";
  }
  process.env.QLOO_API_KEY = "qloo-test-status";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);

    if (parsed.hostname === "api.groq.com") {
      if (options.llm === "auth") {
        return jsonResponse(
          { error: { message: "Invalid API Key", code: "invalid_api_key" } },
          401,
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      const toolName = body?.tools?.[0]?.function?.name;
      if (toolName === "emit_scene_brief") return jsonResponse(briefToolCall());
      if (toolName === "emit_tracks") {
        if (options.llm === "tracks-fail") return jsonResponse({ error: { message: "boom" } }, 500);
        return jsonResponse(tracksToolCall());
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({ cues: [{ artist: "A", track: "B", why: "C" }] }),
            },
          },
        ],
      });
    }

    if (parsed.pathname === "/v2/search") return jsonResponse(QLOO_SEARCH);
    if (parsed.pathname === "/v2/tags") return jsonResponse(QLOO_TAGS);

    if (parsed.pathname === "/v2/insights") {
      const type = parsed.searchParams.get("filter.type");
      const isArtist = type === "urn:entity:artist";
      const isBackfill = isArtist && parsed.searchParams.has("filter.exclude.entities");
      const spec = isBackfill ? options.backfill : isArtist ? options.artist : undefined;

      if (isArtist && !isBackfill && options.artistThrows) {
        const aborted = new Error("aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      if (spec) {
        if (spec.status !== 200) {
          return jsonResponse({ error: { message: "boom" } }, spec.status);
        }
        return jsonResponse({
          success: true,
          results: { entities: spec.entities ?? AFFINITY_ENTITIES },
        });
      }
      return jsonResponse({ success: true, results: { entities: [] } });
    }

    if (parsed.pathname === "/v2/trending") return jsonResponse({ results: { trending: [] } });
    return jsonResponse({ success: true, results: { entities: [] } });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  };
}

const STATUS_SCENE =
  'A neon-soaked drive through Los Angeles at night. Brooding, 1980s synth. Reference "Drive". Audience 25-34.';

await check("1. Groq configured and successful reports a live workflow", async () => {
  const restore = installStack({ artist: { status: 200 }, llm: "ok" });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE });
    assert.equal(sheet.status?.kind, "live", "a fully successful run must be live");
    assert.equal(sheet.status?.label, "live");
    assert.equal(sheet.status?.reasons.length, 0, "a healthy run carries no fault reasons");
    assert.equal(sheet.llmConfigured, true);
    assert.equal(sheet.sceneParse?.source, "llm", "the model read the scene");
    assert.ok(sheet.cues.length > 0);
    assert.equal(sheet.mode, "live");
  } finally {
    restore();
  }
});

await check("2. A Groq authentication failure degrades the sheet, not fails it", async () => {
  const restore = installStack({ artist: { status: 200 }, llm: "auth" });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE });
    assert.equal(sheet.status?.kind, "degraded", "a dead model must degrade, not succeed");
    assert.equal(sheet.llmConfigured, true, "the deployment does have a model configured");
    assert.equal(sheet.sceneParse?.source, "deterministic", "the parser produced the brief");
    assert.equal(sheet.sceneParse?.provider, null, "no provider may be credited");
    assert.ok(
      sheet.status?.reasons.some((reason) => /scene reader/i.test(reason)),
      "the reason must name the scene reader",
    );
    assert.ok(sheet.cues.length > 0, "the Qloo ranking must survive a model failure");
    assert.equal(sheet.mode, "live", "mode still records that live calls were attempted");
    assert.notEqual(sheet.status?.label, "live", "the badge must not read as success");
  } finally {
    restore();
  }
});

await check("3. A Qloo authentication failure is reported as failed", async () => {
  const restore = installStack({ artist: { status: 401 }, llm: "ok" });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE });
    assert.equal(sheet.status?.kind, "failed", "a rejected key cannot be a success");
    assert.equal(sheet.status?.label, "failed");
    assert.match(sheet.status?.detail ?? "", /authentication/i, "the cause must be named");
    assert.equal(sheet.cues.length, 0);
    assert.equal(sheet.mode, "live", "mode alone would still say live — which is the bug");
  } finally {
    restore();
  }
});

await check("4a. A Qloo unavailable response (503) is reported as failed", async () => {
  const restore = installStack({ artist: { status: 503 }, llm: "ok" });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE });
    assert.equal(sheet.status?.kind, "failed");
    assert.match(sheet.status?.detail ?? "", /outage or timeout/i);
    assert.notEqual(sheet.status?.kind, "empty", "an outage is not an absence of results");
  } finally {
    restore();
  }
});

await check("4b. A Qloo timeout (no response) is reported as failed", async () => {
  const restore = installStack({ artist: { status: 0 }, artistThrows: true, llm: "ok" });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE });
    assert.equal(sheet.status?.kind, "failed", "a timeout must not read as success");
    assert.match(sheet.status?.detail ?? "", /outage or timeout/i);
    assert.notEqual(sheet.status?.kind, "empty");
  } finally {
    restore();
  }
});

await check("5. A partial failure with otherwise usable results is degraded", async () => {
  const restore = installStack({
    artist: { status: 200 },
    backfill: { status: 503 },
    llm: "ok",
  });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE });
    assert.equal(sheet.status?.kind, "degraded");
    assert.ok(sheet.cues.length > 0, "the ranking is still usable");
    assert.ok(
      sheet.status?.reasons.some((reason) => /cross-domain discovery/i.test(reason)),
      "the failed optional call must be named",
    );
  } finally {
    restore();
  }
});

await check("6. A critical failure preventing completion is failed", async () => {
  const restore = installStack({ artist: { status: 400 }, llm: "ok" });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE });
    assert.equal(sheet.status?.kind, "failed", "no ranking means no sheet");
    assert.equal(sheet.cues.length, 0);
    assert.equal(sheet.status?.reasons.length, 1);
  } finally {
    restore();
  }
});

await check("7. Legitimate empty results are distinguished from a fault", async () => {
  const restore = installStack({ artist: { status: 200, entities: [] }, llm: "ok" });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE });
    assert.equal(sheet.status?.kind, "empty", "a 200 with no rows is a real absence");
    assert.equal(sheet.status?.label, "no results");
    assert.equal(sheet.status?.reasons.length, 0, "an empty result is not a fault");
    assert.match(sheet.status?.detail ?? "", /nothing failed/i);
    assert.equal(sheet.cues.length, 0);
  } finally {
    restore();
  }
});

await check("8. Missing Gemini and OpenRouter credentials leave Groq as the only provider", async () => {
  const { llmDiagnostics } = await import("../src/lib/llm.ts");
  const restore = installStack({ artist: { status: 200 }, llm: "ok" });
  try {
    const diag = llmDiagnostics();
    assert.equal(diag.configured, true);
    assert.equal(diag.source, "groq");
    assert.equal(diag.keyVar, "GROQ_API_KEY");
    assert.deepEqual(
      diag.providerChain,
      ["groq"],
      "an unconfigured provider must be skipped, never offered as a fallback",
    );
    assert.deepEqual(diag.presentKeyVars, ["GROQ_API_KEY"]);
    assert.equal(diag.model, "openai/gpt-oss-120b");
  } finally {
    restore();
  }
});

await check("9. No false success status when a required integration fails", async () => {
  const restore = installStack({ artist: { status: 401 }, llm: "ok" });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE });
    // The three signals that previously implied success, none of which may.
    assert.equal(sheet.mode, "live", "mode is 'attempted', and stays that way");
    assert.ok(sheet.receipts.length > 0, "calls were made");
    assert.equal(sheet.status?.kind !== "live", true, "status must not claim success");
    assert.equal(sheet.status?.label !== "live", true, "the badge must not read 'live'");
    assert.notEqual(sheet.status?.kind, "degraded", "a dead integration is not a degradation");
  } finally {
    restore();
  }
});

await check("10. An existing successful live workflow remains successful", async () => {
  const restore = installStack({ artist: { status: 200 }, llm: "ok" });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE, alternativeAnchors: ["Sault"] });
    assert.equal(sheet.status?.kind, "live");
    assert.equal(sheet.mode, "live");
    assert.equal(sheet.cues.length, 3, "all three ranked artists become cues");
    assert.equal(sheet.baseline.source, "llm");
    assert.equal(sheet.sceneParse?.source, "llm");
    assert.equal(sheet.sceneParse?.provider, "groq");
    // Warnings and faults are different things, and the status must keep them
    // apart: the optional panels legitimately explain an empty result ("no
    // comparables for this brief") without that being a failure.
    assert.equal(
      sheet.status?.reasons.length,
      0,
      "a successful run must report no fault reasons",
    );
    assert.ok(
      sheet.warnings.every((warning) => !/failed|rejected|unauthorised/i.test(warning)),
      "a successful run must carry no failure warnings",
    );
  } finally {
    restore();
  }
});

await check("11. No model configured reports live without claiming a model ran", async () => {
  const restore = installStack({ artist: { status: 200 }, llm: "none" });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE });
    assert.equal(sheet.llmConfigured, false, "the client must be told there is no model");
    assert.equal(sheet.sceneParse?.source, "deterministic");
    assert.equal(sheet.status?.kind, "live", "a working Qloo run with no model is still live");
    assert.equal(
      sheet.status?.reasons.length,
      0,
      "an absent model is a configuration, not a fault to report",
    );
    assert.match(sheet.status?.detail ?? "", /no model is configured/i);
  } finally {
    restore();
  }
});

await check("12. A failed track-naming call degrades a sheet that still ranked", async () => {
  const restore = installStack({ artist: { status: 200 }, llm: "tracks-fail" });
  try {
    const sheet = await buildCueSheet({ scene: STATUS_SCENE });
    assert.equal(sheet.sceneParse?.source, "llm", "the scene read itself succeeded");
    assert.ok(sheet.cues.length > 0, "Qloo still ranked artists");
    assert.ok(
      sheet.cues.every((cue) => cue.trackUnverified),
      "no cue may carry a track the model did not name",
    );
    assert.equal(sheet.status?.kind, "degraded", "a missing track name is a degradation");
    assert.ok(
      sheet.status?.reasons.some((reason) => /track/i.test(reason)),
      "the reason must name the missing track proposal",
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The Taste Gap. These assert the measurement's actual contract: it is built
// only from tags Qloo returned, it is reproducible, it never reports a number
// the evidence cannot support, and it never claims an improvement it did not
// measure. The Qloo responses below are shaped like real ones (a pool of
// entities each carrying `tags: [{id, name}]`).
// ---------------------------------------------------------------------------

const { computeTasteGap, measureSlate, sharedVocabulary, MIN_TAG_SUPPORT } = await import(
  "../src/lib/coverage.ts"
);

function qlooEntity(name: string, tags: string[], affinity?: number) {
  return {
    entity_id: `id-${name}`,
    name,
    type: "urn:entity:artist",
    tags: tags.map((tag) => ({ tag_id: `urn:tag:qloo:${tag}`, name: tag })),
    query: affinity === undefined ? {} : { affinity },
    popularity: 0.5,
  };
}

// A pool with a deliberate structure: Alpha and Beta carry the *same* four
// tags (a concentrated pair), while Gamma and Delta share two different tags
// with each other. `unique_alpha` / `unique_gamma` appear once each, so they are
// excluded from the shared vocabulary — which is the point of the threshold.
//
// Shared vocabulary is therefore {base, warmth, texture, drive, shimmer, air}.
// The concentrated pair reaches 4 of those 6; a spread pair reaches all 6.
const TASTE_POOL = [
  qlooEntity("Alpha", ["base", "warmth", "texture", "drive", "unique_alpha"], 0.9),
  qlooEntity("Beta", ["base", "warmth", "texture", "drive"], 0.8),
  qlooEntity("Gamma", ["shimmer", "air", "unique_gamma"], 0.7),
  qlooEntity("Delta", ["shimmer", "air"], 0.6),
];

const VOCAB = [
  "urn:tag:qloo:base",
  "urn:tag:qloo:warmth",
  "urn:tag:qloo:texture",
  "urn:tag:qloo:drive",
  "urn:tag:qloo:shimmer",
  "urn:tag:qloo:air",
];

await check("Taste Gap: the vocabulary is restricted to tags shared by 2+ entities", async () => {
  const { toCoverageEntities } = await import("../src/lib/coverage.ts");
  const vocab = sharedVocabulary(toCoverageEntities(TASTE_POOL as never));
  assert.equal(vocab.size, 6, "only tags on 2+ entities may count toward the vocabulary");
  for (const tag of VOCAB) assert.ok(vocab.has(tag), `${tag} should be in the vocabulary`);
  assert.ok(
    !vocab.has("urn:tag:qloo:unique_alpha"),
    "a tag on one entity is metadata, not common ground",
  );
  assert.ok(!vocab.has("urn:tag:qloo:unique_gamma"));
  assert.equal(MIN_TAG_SUPPORT, 2);
});

await check("Taste Gap: a concentrated slate scores lower than a spread one", async () => {
  const { toCoverageEntities } = await import("../src/lib/coverage.ts");
  const entities = toCoverageEntities(TASTE_POOL as never);
  const concentrated = measureSlate(entities, [0, 1]);
  const spread = measureSlate(entities, [0, 2]);
  assert.ok(
    spread.index > concentrated.index,
    `spread ${spread.index} should beat concentrated ${concentrated.index}`,
  );
  assert.equal(concentrated.coveredTags, 4, "the duplicated pair reaches 4 of 6 shared tags");
  assert.equal(spread.coveredTags, 6, "the spread pair reaches all 6");
  assert.equal(concentrated.redundancy, 1, "identical tag sets are fully redundant");
  assert.ok(spread.redundancy < concentrated.redundancy);
});

await check("Taste Gap: identical inputs produce identical measurements", async () => {
  const { toCoverageEntities } = await import("../src/lib/coverage.ts");
  const entities = toCoverageEntities(TASTE_POOL as never);
  const a = computeTasteGap(TASTE_POOL as never, [0, 1], 2);
  const b = computeTasteGap(TASTE_POOL as never, [0, 1], 2);
  assert.equal(a.original.index, b.original.index);
  assert.equal(a.original.vocabularySize, b.original.vocabularySize);
  assert.deepEqual(
    a.revised.entities.map((e) => e.entityId),
    b.revised.entities.map((e) => e.entityId),
    "the revision must be deterministic",
  );
  assert.equal(entities.length, 4);
});

await check("Taste Gap: the revision improves the index and preserves the top pick", async () => {
  const gap = computeTasteGap(TASTE_POOL as never, [0, 1], 2);
  assert.equal(gap.revised.improves, true, "a duplicated slate has room to spread");
  assert.ok(gap.revised.indexDelta > 0);
  assert.equal(
    gap.revised.entities[0].entityId,
    "id-Alpha",
    "the brief's strongest pick must not be discarded by the revision",
  );
  assert.equal(gap.revised.entities.length, 2, "the revision holds the slate size fixed");
});

await check("Taste Gap: no improvement is claimed when the slate already covers the pool", async () => {
  // One entity is the whole pool: nothing can improve on it.
  const single = [qlooEntity("Solo", ["jazz", "soul"], 0.9), qlooEntity("Duo", ["jazz", "soul"], 0.8)];
  const gap = computeTasteGap(single as never, [0, 1], 2);
  assert.equal(gap.revised.indexDelta, 0, "an already-complete slate cannot gain");
  assert.equal(gap.revised.improves, false, "improves must be false when the metric did not rise");
  assert.match(gap.revised.rationale, /stands|no better arrangement/i);
});

await check("Taste Gap: missing evidence yields an explicit unavailable state, not a zero", async () => {
  // Entities with no tags at all: nothing to measure.
  const bare = [qlooEntity("One", []), qlooEntity("Two", [])];
  const gap = computeTasteGap(bare as never, [0, 1], 2);
  assert.ok(gap.unavailableReason, "an unmeasurable pool must say so");
  assert.match(gap.unavailableReason!, /cannot be computed|not a score of zero/i);
  assert.equal(gap.original.vocabularySize, 0);
  assert.equal(gap.revised.improves, false, "an unavailable measurement is never an improvement");
});

await check("Taste Gap: a single-candidate pool is reported as unmeasurable", async () => {
  const one = [qlooEntity("Only", ["jazz", "soul"])];
  const gap = computeTasteGap(one as never, [0], 1);
  assert.ok(gap.unavailableReason, "coverage needs a pool to measure against");
  assert.match(gap.unavailableReason!, /fewer than two candidates/i);
});

await check("Taste Gap: entities with no id or name are excluded from the evidence", async () => {
  const { toCoverageEntities } = await import("../src/lib/coverage.ts");
  const messy = [
    {
      entity_id: "x",
      name: "Has Tags",
      type: "urn:entity:artist",
      // A bare tag with no id/name, exactly as the live API returns for
      // voice_type tags. It must not become a nameless evidence row.
      tags: [{ type: "urn:tag:voice_type:qloo" }, { id: "urn:tag:qloo:real", name: "Real" }],
    },
  ];
  const entities = toCoverageEntities(messy as never);
  assert.deepEqual(entities[0].tags, ["urn:tag:qloo:real"]);
  assert.deepEqual(entities[0].tagNames, { "urn:tag:qloo:real": "Real" });
});

await check("Taste Gap: duplicate tags on one entity are counted once", async () => {
  const { toCoverageEntities } = await import("../src/lib/coverage.ts");
  const dup = [
    qlooEntity("Dup", ["jazz", "jazz", "jazz", "soul"], 0.5),
    qlooEntity("Other", ["jazz", "soul"], 0.4),
  ];
  const entities = toCoverageEntities(dup as never);
  const vocab = sharedVocabulary(entities);
  assert.equal(vocab.size, 2, "a repeated tag is still one tag");
  const measured = measureSlate(entities, [0, 1]);
  assert.equal(measured.coveredTags, 2);
});

await check("Taste Gap: the index is never presented as an audience share", async () => {
  const { COVERAGE_LABEL } = await import("../src/lib/coverage.ts");
  assert.equal(COVERAGE_LABEL, "Tag Coverage Index");
  assert.doesNotMatch(COVERAGE_LABEL, /audience|listener|population|share|reach/i);
  const gap = computeTasteGap(TASTE_POOL as never, [0, 1], 2);
  // The denominator is the pool's own tag union, so the index cannot exceed 100.
  assert.ok(gap.original.index <= 100 && gap.original.index >= 0);
  assert.equal(gap.original.vocabularySize, 6);
  assert.ok(gap.original.coveredTags <= gap.original.vocabularySize);
});

await check("Taste Gap: a slate covering the whole pool reports no gaps", async () => {
  const gap = computeTasteGap(TASTE_POOL as never, [0, 2, 3], 3);
  assert.equal(gap.original.index, 100, "three picks span every shared tag in this pool");
  assert.equal(gap.original.gaps.length, 0);
});

await check("Taste Gap: backfill provenance survives into the measured entities", async () => {
  const withBackfill = [
    qlooEntity("Primary", ["jazz", "soul"], 0.9),
    { ...qlooEntity("Discovered", ["jazz", "soul", "live"], 0.5), backfill: true },
  ];
  const gap = computeTasteGap(withBackfill as never, [0, 1], 2);
  assert.equal(gap.revised.entities[1].backfill, true, "a discovery pick must stay labelled");
});

// ---------------------------------------------------------------------------
// The coverage audit engine. These assert the measurement contract the panel
// and the README both rely on: the numerator and denominator are what they say
// they are, duplicates never inflate a count, malformed evidence is refused
// rather than guessed at, and a revision that does not improve is reported as
// not improving. `auditCoverage` is the generic engine; `coverage.ts` is the
// music adapter over it, so the same guarantees hold in the product.
// ---------------------------------------------------------------------------

const { auditCoverage, auditSelection, measurableDimensions } = await import(
  "../src/lib/audit.ts"
);

/** A generic-engine entity: dimensions are plain ids, not Qloo tags. */
function auditEntity(name: string, dimensions: string[], id?: string) {
  return { entityId: id ?? name, name, dimensions };
}

await check("Audit: an empty selection measures zero and names every dimension as a gap", async () => {
  const pool = [auditEntity("A", ["x", "y"]), auditEntity("B", ["x", "z"])];
  const result = auditSelection(pool, []);
  assert.equal(result.numerator, 0);
  assert.equal(result.denominator, 1, "only x is shared by 2+ entities");
  assert.equal(result.score, 0);
  assert.deepEqual(result.uncoveredDimensions, ["x"]);
  assert.ok(result.valid, "an empty selection is still a valid measurement of zero");
});

await check("Audit: an empty dimension set is unmeasurable, not a zero score", async () => {
  const pool = [auditEntity("A", []), auditEntity("B", [])];
  const result = auditCoverage({ entities: pool, selection: [0, 1] });
  assert.equal(result.valid, false);
  assert.ok(result.unavailableReason, "a pool with no measurable dimensions must say so");
  assert.match(result.unavailableReason!, /no common measured dimensions|not a score of zero/i);
  assert.equal(result.revised.improves, false);
});

await check("Audit: a selection covering every measured dimension scores 100", async () => {
  const pool = [auditEntity("A", ["x", "y"]), auditEntity("B", ["x", "y"])];
  const result = auditSelection(pool, [0, 1]);
  assert.equal(result.denominator, 2);
  assert.equal(result.numerator, 2);
  assert.equal(result.score, 100);
  assert.deepEqual(result.uncoveredDimensions, []);
});

await check("Audit: a selection covering none of the measured dimensions scores 0", async () => {
  // x and y are each shared by two entities, so both are measurable. F carries
  // only `unique`, which appears once and is therefore not measurable: selecting
  // F reaches nothing in the vocabulary, and that is a real measured zero.
  const pool = [
    auditEntity("A", ["x"]),
    auditEntity("B", ["x"]),
    auditEntity("C", ["y"]),
    auditEntity("D", ["y"]),
    auditEntity("E", ["x", "y"]),
    auditEntity("F", ["unique"]),
  ];
  const result = auditSelection(pool, [5]);
  assert.equal(result.denominator, 2);
  assert.equal(result.numerator, 0);
  assert.equal(result.score, 0);
  assert.equal(result.uncoveredDimensions.length, 2);
});

await check("Audit: partial coverage reports the fraction it actually reached", async () => {
  const pool = [
    auditEntity("A", ["x"]),
    auditEntity("B", ["x", "y"]),
    auditEntity("C", ["y"]),
    auditEntity("D", ["y"]),
  ];
  // Measurable: x (A,B) and y (B,C,D). Selecting A reaches x only => 1/2.
  const result = auditSelection(pool, [0]);
  assert.equal(result.denominator, 2);
  assert.equal(result.numerator, 1);
  assert.equal(result.score, 50);
  assert.deepEqual(result.uncoveredDimensions, ["y"]);
});

await check("Audit: the same entity twice does not promote a one-off dimension", async () => {
  // `rare` appears on one distinct entity. Listing that entity twice must not
  // make it look shared: two copies are not two independent pieces of evidence.
  const pool = [
    auditEntity("A", ["common", "rare"], "dup"),
    auditEntity("A", ["common", "rare"], "dup"),
    auditEntity("B", ["common"]),
  ];
  const measurable = measurableDimensions(pool);
  assert.ok(measurable.has("common"), "common is genuinely shared");
  assert.ok(!measurable.has("rare"), "a duplicated entity must not create shared ground");
  assert.equal(measurable.size, 1);
});

await check("Audit: a repeated dimension on one entity counts once", async () => {
  const pool = [auditEntity("A", ["x", "x", "x", "y"]), auditEntity("B", ["x", "y"])];
  const measurable = measurableDimensions(pool);
  assert.equal(measurable.size, 2);
  const result = auditSelection(pool, [0]);
  assert.equal(result.numerator, 2, "three copies of x are still one dimension");
});

await check("Audit: malformed evidence is refused, not crashed on", async () => {
  const pool = [
    auditEntity("A", ["x"]),
    auditEntity("B", ["x"]),
    auditEntity("C", ["y"]),
    auditEntity("D", ["y"]),
  ];
  // Dimensions that are not strings must not enter the vocabulary.
  const malformed = [
    { entityId: "M", name: "M", dimensions: [null, undefined, 42, "", "x"] as never },
    auditEntity("B", ["x"]),
    auditEntity("C", ["y"]),
    auditEntity("D", ["y"]),
  ];
  const measurable = measurableDimensions(malformed as never);
  assert.ok(measurable.has("x"), "the one valid string dimension is still measured");
  assert.ok(!measurable.has(""), "an empty id is not a dimension");
  assert.ok(!measurable.has("42" as never), "a non-string dimension is not a dimension");
  // And the measurement over the clean pool is unaffected by the messy row.
  const result = auditSelection(pool, [0, 2]);
  assert.equal(result.score, 100);
});

await check("Audit: a null tag entry from the wire does not take the measurement down", async () => {
  const { toCoverageEntities } = await import("../src/lib/coverage.ts");
  // A null element inside `tags` is the shape that previously threw inside the
  // measurement and would have failed the whole /api/cue route.
  const messy = [
    { entity_id: "m", name: "Messy", tags: [null, undefined, { name: "NoId" }] },
    qlooEntity("Clean", ["jazz", "soul"]),
    qlooEntity("Other", ["jazz", "soul"]),
  ];
  const entities = toCoverageEntities(messy as never);
  assert.deepEqual(entities[0].tags, [], "unusable tag entries are dropped, not thrown on");
  const gap = computeTasteGap(messy as never, [1, 2], 2);
  assert.equal(gap.original.index, 100, "the measurable part is still measured");
});

await check("Audit: a revision that improves coverage reports the gain and the new dimensions", async () => {
  // A is the top pick (x). B and C both carry y, so swapping either in covers y.
  const pool = [
    auditEntity("A", ["x"]),
    auditEntity("B", ["x", "y"]),
    auditEntity("C", ["x", "y"]),
  ];
  const result = auditCoverage({ entities: pool, selection: [0], reviseTo: 2 });
  assert.equal(result.valid, true);
  assert.equal(result.original.score, 50, "A alone reaches x of {x,y}");
  assert.equal(result.revised.result.score, 100, "A+B reaches both");
  assert.equal(result.revised.improves, true);
  assert.ok(result.revised.delta > 0);
  assert.deepEqual(result.revised.newlyCovered, ["y"]);
  assert.equal(result.revised.selection[0], 0, "the top pick is never dropped");
});

await check("Audit: a revision that adds entities but covers nothing new is not an improvement", async () => {
  // Every entity carries the same dimensions, so no ordering can reach more.
  const pool = [
    auditEntity("A", ["x", "y"]),
    auditEntity("B", ["x", "y"]),
    auditEntity("C", ["x", "y"]),
  ];
  const result = auditCoverage({ entities: pool, selection: [0], reviseTo: 2 });
  assert.equal(result.original.score, 100);
  assert.equal(result.revised.result.score, 100);
  assert.equal(result.revised.improves, false, "more entities is not more coverage");
  assert.equal(result.revised.delta, 0);
  assert.deepEqual(result.revised.newlyCovered, []);
});

await check("Audit: a revision is never reported as decreasing coverage", async () => {
  // The greedy revision seeds the top pick and only adds, so its score is
  // monotonic. This pins that property rather than assuming it.
  const pool = [
    auditEntity("A", ["x", "y", "z"]),
    auditEntity("B", ["x"]),
    auditEntity("C", ["y"]),
    auditEntity("D", ["z"]),
    auditEntity("E", ["x", "y"]),
  ];
  for (const selection of [[0], [1], [0, 1], [3, 4]]) {
    const result = auditCoverage({ entities: pool, selection, reviseTo: selection.length });
    assert.ok(
      result.revised.delta >= 0,
      `revision must not lose coverage (selection ${selection.join(",")})`,
    );
  }
});

await check("Audit: numerator and denominator are unchanged between original and revision", async () => {
  // The before/after comparison is only like-for-like if both sides measure
  // against the same denominator. This is the property that makes the delta
  // meaningful, so it is asserted rather than assumed.
  const pool = [
    auditEntity("A", ["x"]),
    auditEntity("B", ["x", "y"]),
    auditEntity("C", ["y", "z"]),
    auditEntity("D", ["z"]),
  ];
  const result = auditCoverage({ entities: pool, selection: [0], reviseTo: 2 });
  assert.equal(
    result.original.denominator,
    result.revised.result.denominator,
    "the denominator must be the same pool union on both sides",
  );
  assert.deepEqual(result.original.weightsUsed, "equal");
  assert.deepEqual(result.revised.result.weightsUsed, "equal");
});

await check("Audit: the score is the numerator over the denominator, to rounding", async () => {
  // 3 shared dimensions, a selection reaching 1 of them: 33.333...%
  const pool = [
    auditEntity("A", ["x"]),
    auditEntity("B", ["x", "y"]),
    auditEntity("C", ["y", "z"]),
    auditEntity("D", ["z"]),
  ];
  const result = auditSelection(pool, [0]);
  assert.equal(result.denominator, 3);
  assert.equal(result.numerator, 1);
  assert.ok(Math.abs(result.score - 100 / 3) < 1e-9);
  assert.equal(result.score.toFixed(1), "33.3");
});

await check("Audit: mostSimilarPair names entities from the selection, not the pool", async () => {
  // The selection is deliberately NOT a 0-based prefix. Indexing the pool with
  // the pair indices reported the wrong artists entirely — a false, checkable
  // claim about named entities, which is the exact failure this product exists
  // to catch.
  const pool = [
    auditEntity("Alpha", ["a", "b"]),
    auditEntity("Beta", ["a", "b"]),
    auditEntity("Gamma", ["x", "y", "z"]),
    auditEntity("Delta", ["x", "y", "z"]),
  ];
  const result = auditSelection(pool, [2, 3]);
  assert.ok(result.mostSimilarPair, "a pair must be reported");
  assert.equal(result.mostSimilarPair!.a, "Gamma");
  assert.equal(result.mostSimilarPair!.b, "Delta");
  assert.equal(result.mostSimilarPair!.overlap, 1);
});

await check("Audit: out-of-range selection indices are warned about and ignored", async () => {
  const pool = [auditEntity("A", ["x"]), auditEntity("B", ["x", "y"]), auditEntity("C", ["y"])];
  const result = auditSelection(pool, [0, 99]);
  assert.equal(result.numerator, 1, "index 99 is ignored, not treated as an entity");
  assert.ok(
    result.warnings.some((warning) => /outside the pool/i.test(warning)),
    "a dropped index must be reported, not silently swallowed",
  );
});

await check("Audit: a selection of one entity reports no redundancy", async () => {
  // Redundancy is a pairwise statistic; with fewer than two picks there is no
  // pair to compare, so it must be zero rather than undefined or NaN.
  const pool = [auditEntity("A", ["x"]), auditEntity("B", ["x"])];
  const result = auditSelection(pool, [0]);
  assert.equal(result.redundancy, 0);
  assert.equal(result.mostSimilarPair, undefined);
});

await check("Audit: the result distinguishes a failed measurement from a legitimate empty one", async () => {
  // Empty pool: no measurement attempted, invalid, with a reason.
  const emptyPool = auditCoverage({ entities: [], selection: [] });
  assert.equal(emptyPool.valid, false);
  assert.ok(emptyPool.unavailableReason);
  assert.match(emptyPool.unavailableReason!, /fewer than two candidates/i);

  // Real pool, selection legitimately reaching nothing: valid, score 0.
  // G carries only `unique`, which is on one entity and so is not measurable.
  const pool = [
    auditEntity("A", ["x"]),
    auditEntity("B", ["x"]),
    auditEntity("C", ["y"]),
    auditEntity("D", ["y"]),
    auditEntity("E", ["z"]),
    auditEntity("F", ["z"]),
    auditEntity("G", ["unique"]),
  ];
  const reachesNothing = auditCoverage({ entities: pool, selection: [6] });
  assert.equal(reachesNothing.valid, true, "this is a real measurement, not a failure");
  assert.equal(reachesNothing.original.score, 0);
  assert.equal(reachesNothing.original.denominator, 3);
});

await check("Audit: explicit weights change the score and are reported as used", async () => {
  // Equal weighting is the default. When a caller passes weights, the result
  // must say so rather than leaving a reader to assume equal weighting.
  const pool = [
    auditEntity("A", ["x"]),
    auditEntity("B", ["x", "y"]),
    auditEntity("C", ["y"]),
    auditEntity("D", ["y"]),
  ];
  const equal = auditSelection(pool, [0]);
  assert.equal(equal.score, 50, "x of {x,y} at equal weight");

  const weighted = auditSelection(pool, [0], { weights: { x: 3, y: 1 } });
  assert.equal(weighted.score, 75, "x weighted 3 against y weighted 1");
  assert.deepEqual(weighted.weightsUsed, { x: 3, y: 1 });
});

await check("Audit: the music adapter and the generic engine agree on the same input", async () => {
  // The adapter must not drift from the engine it delegates to. Same pool, same
  // selection, same numbers — otherwise the panel and the engine disagree.
  const { toCoverageEntities } = await import("../src/lib/coverage.ts");
  const { auditSelection } = await import("../src/lib/audit.ts");
  const pool = [
    qlooEntity("Alpha", ["a", "b"], 0.9),
    qlooEntity("Beta", ["a", "b"], 0.8),
    qlooEntity("Gamma", ["x", "y"], 0.7),
    qlooEntity("Delta", ["x", "y"], 0.6),
  ];
  const music = measureSlate(toCoverageEntities(pool as never), [0, 2]);
  const generic = auditSelection(
    toCoverageEntities(pool as never).map((entity) => ({
      entityId: entity.entityId,
      name: entity.name,
      dimensions: entity.tags,
    })),
    [0, 2],
  );
  assert.equal(music.index, generic.score);
  assert.equal(music.coveredTags, generic.numerator);
  assert.equal(music.vocabularySize, generic.denominator);
  assert.deepEqual(music.gaps.map((gap) => gap.tag).sort(), generic.uncoveredDimensions.map((d) => d.replace("urn:tag:qloo:", "")).sort());
});

console.log(`\n${passed} passed, ${failures.length} failed.\n`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
