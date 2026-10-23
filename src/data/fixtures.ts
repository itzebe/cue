import type { CueSheet } from "@/lib/types";

/**
 * Pre-computed cue sheet used when no Qloo key is configured.
 *
 * The shape is identical to a live response, so the UI, the receipt panel and
 * the side-by-side all exercise the real rendering path. The demo therefore
 * runs end-to-end before the hackathon key arrives, and the numbers here are
 * illustrative rather than presented as live results (mode: "fixture").
 */
export const FIXTURE_SHEET: CueSheet = {
  mode: "fixture",
  brief: {
    title: "The Long Drive Home",
    raw: "A late-90s character drama. She drives home after the funeral. Rain on the windshield, no dialogue for ninety seconds. We need something that holds grief without wallowing — it should feel like the city forgiving her. Set in New York, aimed at a 35-44 audience.",
    mood: ["melancholy", "restraint", "hope"],
    genre: ["soul", "ambient", "trip hop"],
    era: "late 90s",
    setting: "New York, after a funeral, night rain",
    arc: "Hold grief, then allow the first hint of relief without resolving it.",
    audience: { age: "35_to_44" },
    region: "New York",
    anchors: ["The Long Drive Home", "New York"],
    diegetic: false,
  },
  cues: [
    {
      id: "fixture-1",
      artist: "Massive Attack",
      track: "Teardrop",
      album: "Mezzanine",
      year: "1998",
      affinity: 0.94,
      popularity: 0.81,
      momentum: 1,
      placement: "needle_drop",
      clearance: "major_label",
      confidence: 0.93,
      risk: "High-profile catalogue; expect a competitive sync fee and a slower clearance.",
      why: [
        "Audiences who like late-90s New York dramas index strongly for Massive Attack in Qloo's taste graph.",
        "Explainability attributes 41% of the match to the trip hop signal in the brief.",
        "Over-indexes with the 35 to 44 audience the brief targets.",
        "Climbing Qloo population rank over the trend window, so the cue reads current rather than nostalgic.",
      ],
      explainability: [
        { entity_id: "urn:fixture:trip_hop", name: "Trip hop", score: 0.41 },
        { entity_id: "urn:fixture:era", name: "Late 90s", score: 0.27 },
      ],
    },
    {
      id: "fixture-2",
      artist: "Portishead",
      track: "Roads",
      album: "Dummy",
      year: "1994",
      affinity: 0.91,
      popularity: 0.68,
      momentum: 0,
      placement: "score_bed",
      clearance: "indie_friendly",
      confidence: 0.88,
      risk: "Standard clearance path for this profile.",
      why: [
        "Cross-domain backfill: adjacent to the brief rather than an obvious search result.",
        "Explainability attributes 33% of the match to the soul signal in the brief.",
      ],
      explainability: [
        { entity_id: "urn:fixture:soul", name: "Soul", score: 0.33 },
      ],
    },
    {
      id: "fixture-3",
      artist: "Nils Frahm",
      track: "Says",
      album: "Spaces",
      year: "2013",
      affinity: 0.87,
      popularity: 0.42,
      momentum: 1,
      placement: "transition",
      clearance: "indie_friendly",
      confidence: 0.82,
      risk: "Standard clearance path for this profile.",
      why: [
        "Surfaced by cross-domain backfill: adjacent to the brief, not an obvious search result.",
        "Climbing Qloo population rank over the trend window, so the cue reads current rather than nostalgic.",
      ],
      explainability: [
        { entity_id: "urn:fixture:ambient", name: "Ambient", score: 0.29 },
      ],
    },
    {
      id: "fixture-4",
      artist: "Sault",
      track: "Wildfires",
      album: "Untitled (Black Is)",
      year: "2020",
      affinity: 0.83,
      popularity: 0.38,
      momentum: 1,
      placement: "title_card",
      clearance: "indie_friendly",
      confidence: 0.79,
      risk: "Standard clearance path for this profile.",
      why: [
        "Surfaced by cross-domain backfill: adjacent to the brief, not an obvious search result.",
        "Falling Qloo population rank over the trend window, which suits a scene that needs distance or melancholy.",
      ],
      explainability: [
        { entity_id: "urn:fixture:soul", name: "Soul", score: 0.24 },
      ],
    },
  ],
  directionCompare: {
    aLabel: "Late-90s trip hop (as written)",
    bLabel: "Contemporary ambient soul (the counter-proposal)",
    shared: ["Melancholy", "Late night", "Cinematic", "Introspective", "Soulful"],
    aOnly: ["Trip hop", "Downbeat", "Urban"],
    bOnly: ["Ambient", "Neo-soul", "Meditative"],
    overlap: 0.62,
    verdict:
      "5 taste tags bridge both directions (62% overlap). Qloo reads them as landing with substantially the same audience, so the difference between them is stylistic rather than a different crowd. The era is a surface detail, not the load-bearing choice.",
  },
  baseline: {
    cues: [
      { artist: "Adele", track: "Someone Like You", why: "Famous, sad, about loss." },
      { artist: "Coldplay", track: "Fix You", why: "Famous, sad, then hopeful." },
      { artist: "Jeff Buckley", track: "Hallelujah", why: "The default funeral-scene pick." },
    ],
    note: "Generated by the LLM with no cultural data. Plausible on the surface, but unverifiable: no affinity, no audience measurement, no momentum. All three are the first songs anyone names, and two are on every clearance team's expensive list.",
  },
  regionAffinity: [
    { name: "Massive Attack", affinity: 0.93 },
    { name: "Portishead", affinity: 0.9 },
    { name: "Sault", affinity: 0.85 },
    { name: "Nils Frahm", affinity: 0.8 },
  ],
  receipts: [
    {
      endpoint: "GET /search",
      label: 'Resolve "The Long Drive Home"',
      params: { query: "The Long Drive Home", take: "3" },
      status: 200,
      ms: 118,
      resultCount: 1,
    },
    {
      endpoint: "GET /v2/tags",
      label: 'Tag "soul"',
      params: { "filter.query": "soul", take: "3" },
      status: 200,
      ms: 96,
      resultCount: 3,
    },
    {
      endpoint: "GET /v2/insights",
      label: "Artist affinity (explainability on)",
      params: {
        "filter.type": "urn:entity:artist",
        "feature.explainability": "true",
        "signal.demographics.age": "35_to_44",
        take: "14",
      },
      status: 200,
      ms: 341,
      resultCount: 14,
    },
    {
      endpoint: "GET /v2/trending",
      label: "Artist momentum",
      params: { "filter.type": "urn:entity:artist", take: "12" },
      status: 200,
      ms: 204,
      resultCount: 12,
    },
    {
      endpoint: "GET /v2/analysis/compare",
      label: "Direction A/B compare",
      params: { "filter.type": "urn:entity:artist", take: "10" },
      status: 200,
      ms: 288,
      resultCount: 10,
    },
    {
      endpoint: "GET /v2/insights (location)",
      label: "Localise to New York",
      params: { "filter.location.query": "New York", take: "6" },
      status: 200,
      ms: 263,
      resultCount: 6,
    },
  ],
  warnings: [
    "Fixture mode: these numbers are pre-computed examples, not live Qloo results.",
  ],
};

/** Ready-made scene briefs so a judge can try Cue in one click. */
export const SAMPLE_SCENES: Array<{
  id: string;
  label: string;
  blurb: string;
  scene: string;
  alternativeAnchors?: string[];
}> = [
  {
    id: "funeral-drive",
    label: "The Long Drive Home",
    blurb: "Late-90s drama · grief without wallowing",
    // Named references are what switch the sheet from tag-only matching to true
    // affinity ranking, so the default sample names real, resolvable entities.
    scene:
      "A late-90s character drama. She drives home after the funeral. Rain on the windshield, no dialogue for ninety seconds. We need something that holds grief without wallowing — it should feel like the city forgiving her. Set in New York, aimed at a 35-44 audience. The director's reference points: Massive Attack's Mezzanine, Portishead, and the restraint of Lost in Translation.",
    alternativeAnchors: ["Sault", "Nils Frahm", "Floating Points"],
  },
  {
    id: "sneaker-launch",
    label: "Sneaker Launch Spot",
    blurb: "30s brand film · young, kinetic, global",
    scene:
      "A 30-second spot for a limited-run sneaker drop. Street court in Atlanta at golden hour, quick cuts of footwork, then a slow push-in on the shoe. Contemporary, confident, a little dangerous. Target audience is 18-24, heavily mobile, US and UK. The brand wants it to feel like it was made by someone who actually plays, not a marketing department. References the creative team gave: Outkast, J Dilla, and the energy of a Virgil Abloh campaign.",
    alternativeAnchors: ["Outkast", "J Dilla", "Flying Lotus"],
  },
  {
    id: "tv-cold-open",
    label: "Prestige TV Cold Open",
    blurb: "Series opener · tension that never releases",
    scene:
      "Cold open for a prestige thriller series. A woman walks through an empty Berlin apartment at 4am, checking rooms. No score yet, just room tone and a distant train. We need a needle drop that starts at 1:40 and carries into the title card. Era: contemporary. The audience is 25-34, the show's hook is that it never explains itself. Reference points the director mentioned: Drive, Sicario, Under the Skin.",
    alternativeAnchors: ["Cliff Martinez", "Jóhann Jóhannsson", "Mica Levi"],
  },
  {
    id: "retirement-ad",
    label: "Retirement Brand Film",
    blurb: "60s spot · dignity, not treacle",
    scene:
      "Sixty-second brand film for a retirement community. A 72-year-old man in Detroit tends a rooftop garden, then dances alone in his kitchen to a record. Warm, dignified, never saccharine. The brand explicitly said no ukulele covers. Audience is 55+ and their adult children. Detroit, Michigan. Reference: the tone of the Apple 'Shot on iPhone' films, but for people who grew up on Motown, Bill Withers and Aretha Franklin.",
    alternativeAnchors: ["Aretha Franklin", "The Temptations", "Bill Withers"],
  },
];
