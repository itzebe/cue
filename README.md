# Cue

**A creative brief goes in. A culturally grounded cue sheet comes out.**

Cue is an agentic music supervisor for film, TV and advertising. You paste a scene — a script
page, a treatment, or two sentences — and Cue returns ranked music cues, where every ranking
traces back to **measured audience affinity** in the [Qloo Taste Graph](https://docs.qloo.com/)
rather than to what is merely famous.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/).

> **The problem in one line:** ask a language model to score a scene and it reaches for the most
> statistically common answer — *Hallelujah* for a funeral, *Smells Like Teen Spirit* for a 90s
> montage — because it knows which songs are famous and has no idea which songs fit *this*
> audience. Cue measures that instead of guessing it.

![Cue — the opening screen: a creative brief in, a grounded answer out](docs/screenshots/01-hero-brief.jpg)

**[▶ Watch the product demo (2:35)](https://github.com/itzebe/cue/releases/tag/demo-video)** —
a single live run, recorded end to end against the real Qloo Taste Graph: brief in, cue sheet,
Cross-Domain Taste Map, comparison and the Qloo receipts behind each pick.

> The demo is hosted as a GitHub release asset, so the link **downloads** the MP4
> ([direct file](https://github.com/itzebe/cue/releases/download/demo-video/cue-demo.mp4),
> 24 MB) rather than streaming in the browser.

---

## The problem, and who has it

**The user:** a music supervisor, or a creative producer at an agency or studio, choosing music for
a scene under deadline.

Their job is to find a track that fits the scene *and* lands with the audience the scene is made
for — then to defend that choice to a director, a client, and a clearance team. Generic
recommendation tools cannot help with the part that matters: they rank by popularity and ratings,
which says nothing about whether a track fits a specific audience for a specific scene.

Language models do not close the gap. They produce confident, plausible, identical answers because
they hold no cultural data at all. A supervisor needs measured evidence, and needs to know which
part of the output is measured versus estimated.

## What Cue does

Paste a scene brief and Cue returns a full cue sheet:

- **Culturally grounded options.** Artists ranked by *measured* affinity with the scene's taste
  profile, not by what's popular.
- **A reason attached to every pick.** Each cue names the signal that caused it, using Qloo's
  explainability data. No black box.
- **Audience fit.** Demographic signals confirm the pick lands with the people the scene is for.
- **Momentum.** Qloo's own trend series, so a supervisor knows whether a cue reads current or
  nostalgic.
- **Placement and clearance notes.** Which cue is the needle drop, which is the score bed, and what
  each will cost to clear.
- **A creative A/B.** Two competing directions run through `/v2/analysis/compare` to see whether
  they split the audience or share it.
- **A clearance desk.** Select the cues you want and Cue prices the grant: fee band, rights holders,
  one-stop or two negotiations, the path to signature, and the day the campaign is gated.
- **A substitute when the answer is unaffordable.** The top pick costs more than the budget, or the
  label refuses. Cue inverts the budget into a popularity ceiling, searches the taste graph for
  artists the same audience already loves inside it, and reports each one's measured audience
  overlap with the original. This is the question a ranked list cannot answer, and the one
  supervisors actually get stuck on.
- **Cross-domain answers.** The same taste profile that ranks the music ranks people for casting and
  brands for partner fit, and returns the cultural touchpoints each market would reference.
- **Full receipts.** Every Qloo endpoint called, with parameters, status, latency and row count.

## How Cue works

Cue is a deterministic, multi-stage pipeline. The LLM and Qloo have strictly separated jobs, and
that separation is the whole design:

- **The LLM reads the scene** into a structured brief, and **names a specific track** for each
  artist Qloo has already ranked. It uses structured tool-call schemas (`emit_scene_brief`,
  `emit_tracks`) rather than free text.
- **Qloo decides what ranks.** Every affinity, popularity, momentum, audience-fit and provenance
  figure comes from the Qloo API. No language model produces or estimates any of those numbers.

![Cue architecture: the LLM reads the scene, Qloo decides the ranking](docs/architecture.svg)

The pipeline, in order: read the scene → resolve anchors and tags to Qloo entity IDs → rank
candidates by affinity → enrich in parallel (momentum, cross-domain people and brands, comparables,
cross-domain taste map) → assemble placement, clearance and receipts.

Each stage degrades independently: a failed trending call costs one cue its momentum badge, not the
whole sheet. Every failure is surfaced in the receipts panel rather than hidden.

**On "agentic".** Cue satisfies the hackathon's definition as an agentic tool: a multi-stage
workflow with LLM tool-calling and external retrieval. It does **not** run a multi-turn autonomous
loop, and it does not expose an MCP server — so this README does not claim either.

## The cue sheet

![The cue sheet: ranked cues with affinity, popularity and the Qloo signal behind each pick](docs/screenshots/02-cue-sheet.jpg)

Each cue carries its own evidence: the affinity that ordered it, the popularity figure kept
deliberately separate, the signal entity that caused it, and a proposed cut. The cut title is the
only part a model proposes, and it is labelled as such.

## Cross-domain taste map

The same measured taste profile that ranks the music also answers the neighbouring questions.

![The cross-domain taste map: destinations, podcasts and places for the same audience](docs/screenshots/03-cross-domain-taste-map.jpg)

- **What it returns:** recommendations across destinations, podcasts and places, from the same
  anchors that drove the cue sheet.
- **Where the numbers come from:** Qloo `/v2/insights`, requested per domain. Each row keeps its
  own provider-backed affinity where Qloo returned one.
- **Source attribution is preserved.** When Qloo's explainability data attributes a result to a
  specific anchor, Cue shows that. When no attribution block comes back, the row says the result
  relates through the anchors collectively rather than implying each anchor supports it.
- **Measured affinity is distinguished from a popularity-derived substitution.** Every entity
  carries an `affinitySource` field, and a row that fell back to popularity is never labelled
  "affinity".
- **Affinity is a decimal, not a percentage of shared audience.** Values like `0.9728` are Qloo's
  affinity for that entity against this taste profile. They are not a share of people, not a
  probability, and not a measure of audience overlap. Cue renders them as decimals and never
  multiplies them into a percentage.
- **Results are not presented as stronger than the provider response supports.** An empty domain
  and a failed domain are reported as two different things, so a Qloo fault never renders as "this
  audience likes nothing here".

**What it contributes to the central use case:** it is the difference between a music tool and a
cultural layer. A supervisor working a scene is often also answering "where would this campaign
shoot", "which podcast would carry it", and "who does this audience actually follow". The taste map
answers those from the same measurement instead of a second, ungrounded guess.

## What Qloo contributes

The hackathon's test is whether a project would work the same without Qloo. Here it plainly would
not.

| Question the cue sheet answers | Qloo endpoint | Could an LLM answer it? |
|---|---|---|
| Who are the entities in this brief? | `GET /v2/search` | No — needs resolved entity IDs |
| Which artists share this scene's taste profile? | `GET /v2/insights` | No — requires measured affinity |
| Why was this artist chosen? | `feature.explainability=true` | No — requires the signal graph |
| Does it land with this audience? | `signal.demographics.*` | No — requires demographic data |
| Is this artist rising or cooling? | `GET /v2/trending` | No — requires a time series |
| Do these two directions share an audience? | `GET /v2/analysis/compare` | No — requires cross-group analysis |
| Which people and brands fit this audience? | `urn:entity:person`, `urn:entity:brand` insights | No — requires cross-domain affinity |
| What cultural touchpoints define this market? | `urn:entity:place` + `filter.location.query` | No — requires regional signals |
| What will this cost to clear? | Qloo popularity + momentum, then Cue's model | No — needs measured leverage |

Cue shows this in the product rather than asserting it. See the comparison below.

## Evidence, provenance and the comparison

The strongest single piece of evidence in Cue is that it runs its own control group. On the same
scene, Cue produces **two** answers: one from the model alone with no cultural data, and one ranked
by Qloo. The difference is shown side by side rather than claimed.

![Same scene, same model — one answer has cultural data](docs/screenshots/04-comparison-baseline-vs-qloo.jpg)

The baseline column is produced by a real model call on the same brief (`baseline.source` is `llm`
when the model answered, and `sample` when a labelled fixed example is used instead — the panel
says which). The Qloo column carries affinity, provenance and receipts the baseline cannot have.

Every claim in the sheet is traceable:

![Receipts: every Qloo endpoint called, with status, latency and row count](docs/screenshots/05-evidence-receipts.jpg)

## Mobile

The primary action is reachable without scrolling on common phone viewports.

![Cue on a phone: the brief composer and the primary action on the first screen](docs/screenshots/06-mobile-first-run.jpg)

## What is honest and what is not

Cue is built against a live API for a hackathon, so the boundary between measured and modelled is
stated in the product rather than blurred.

| Output | Source | Status |
|---|---|---|
| Affinity, popularity, momentum, audience fit | Qloo | Measured |
| Cross-domain recommendations and their affinity | Qloo (`/v2/insights` per domain) | Measured |
| Market touchpoints | Qloo (`urn:entity:place` + location) | Measured |
| Casting and brand candidates | Qloo (`urn:entity:person`, `urn:entity:brand`) | Measured |
| Audience overlap between two artists | Qloo (`/v2/analysis/compare`) | Measured |
| Track titles | Optional LLM, else left for the supervisor | Never invented |
| Fees, splits, clearance timelines | Cue's own model | Estimated, labelled as such |

Two findings shaped the design and are worth stating plainly:

1. **Qloo's location filter does not move artist affinity.** Measured against the hackathon API,
   `filter.type=urn:entity:artist` returns byte-identical entities *and* affinity scores for Los
   Angeles, Sao Paulo, Seoul, Lagos and London. A feature claiming to "localise the soundtrack"
   would be fabricating its result, so Cue localises what the data actually supports —
   `urn:entity:place`, where markets diverge completely (Big Ben for London, the Ghibli Museum for
   Tokyo, zero overlap between markets). The music stays global because the data says it is global.
2. **Clearance data is not available through Qloo.** Fees and splits are therefore produced by a
   transparent model with every input and multiplier shown in the UI, not presented as quotes.
   Inventing a real number would be the same failure as inventing a track title.

Cue does not clear music, does not replace a music supervisor, and does not assert that any
recommendation is licensable at a given price. Clearance figures are modelled estimates, labelled
as estimates in the UI.

## Technical implementation

Next.js 14 (App Router) + TypeScript + Tailwind. No agent framework and no runtime dependency beyond
React and Next — the pipeline is plain TypeScript in `src/lib/`.

| Module | Role |
|---|---|
| `src/lib/planner.ts` | Orchestrates the pipeline and assembles the cue sheet |
| `src/lib/qloo.ts` | Qloo client: search, insights, tags, trending, compare |
| `src/lib/cues.ts` | Anchor/tag resolution, affinity ranking, momentum |
| `src/lib/crossdomain.ts` | Cross-domain taste map across destinations, podcasts, places |
| `src/lib/casting.ts`, `comparables.ts` | People/brands and "what is this like" |
| `src/lib/localise.ts` | Market touchpoints (opt-in endpoint) |
| `src/lib/rights.ts` | Transparent fee and clearance model |
| `src/lib/substitute.ts` | Budget-aware substitution via audience overlap |
| `src/lib/llm.ts` | Provider resolution, fallback chain, tool-calling |

### Endpoints

| Route | Purpose |
|---|---|
| `POST /api/cue` | Scene brief in, grounded cue sheet out. The core call. |
| `POST /api/localise` | Compare the brief's cultural touchpoints across markets. Slow by nature, so it is opt-in. |
| `POST /api/quote` | Price a selected basket: fee bands, rights holders, clearance path, gating day. |
| `POST /api/substitute` | Find what else serves the scene inside a budget. Opt-in, because it costs several calls. |
| `GET /api/cue` | Health check: whether Qloo and an LLM are configured, and against which base URL. |

## Verification

```bash
npm run verify      # 107 checks
npm run typecheck   # tsc --noEmit
npm run build       # production build
```

`npm run verify` prints a `passed`/`failed` line and exits non-zero on any failure. It currently
reports **107 passed, 0 failed**. The only thing stubbed is `fetch` — the real HTTP boundary. Every
layer under test is the production code path, exercised with response bodies shaped like real Qloo
payloads. Coverage includes normalisation, affinity extraction, explainability parsing, momentum
derivation, failure degradation, cue assembly, concurrency limits, request-budget accounting,
place-based localisation, casting, cross-domain comparables, the cross-domain taste map, the
audience brief and licence pricing.

## Known limitations

- **Momentum reads "steady" on live data.** The trend series exposed by the hackathon sandbox is a
  frozen snapshot: `population_rank_velocity`, `population_percent_delta` and
  `population_percentile` are constant across every artist tested. The field is parsed, ranked and
  rendered; it simply reports "steady" rather than fabricating a trend. The unit tests cover the
  rising and cooling branches with a varying series.
- **Tag-only briefs return a uniform affinity.** When a brief names no film, director or artist,
  `/v2/insights` matches on tags alone and returns the same affinity for every entity. Cue detects
  this (zero spread with no signal entities), orders by popularity as a deterministic tiebreak, and
  says so in the warnings instead of presenting an arbitrary order as a ranking. Naming an anchor
  restores true affinity ranking.
- **No "song" entity type exists in Qloo.** Cue grounds the *artist* and *vibe* with Qloo, then
  proposes specific tracks from those artists. This is stated openly rather than papered over.
- **Clearance is a model, not a quote.** Fee bands, splits and timelines are Cue's own transparent
  estimate, with every input shown. They are not real quotes and not legal clearance.
- **A cue sheet takes roughly 20 seconds.** It issues 20+ Qloo calls; the hackathon key rate-limits
  in bursts, so the client caps concurrency at four in flight and retries with backoff.
- **The comparison baseline can fall back to a fixed sample.** When the model does not return a
  baseline, the panel labels the left column as a fixed sample rather than dressing it up as a live
  comparison.

### Notes for reviewers

- **Hackathon base URL.** Hackathon keys only work against `https://hackathon.api.qloo.com`. Using
  staging or production returns 401. This is the default here.
- **Authentication.** Qloo expects the key in the `X-Api-Key` header, not as a bearer token.
- **`/v2/insights` is a GET.** Parameters go in the query string; a POST body will fail.
- **Invalid parameters fail silently.** Qloo ignores unsupported parameters and returns `200` with
  an empty entity list rather than an error. Cue resolves entities and tags *before* ranking, which
  is why the call chain has more steps than a naive integration — and why it does not quietly
  return nothing.
- **Legacy `/recs` and `/recommendations` are unsupported** for the hackathon and are not used
  anywhere in this codebase.
- **Anchor extraction is load-bearing, so it is tested.** Whether a brief gets true affinity ranking
  or the flat tag-only fallback is decided entirely by whether Cue can find a named reference in the
  text. The reader handles the shapes supervisors actually write — single-word titles (`Drive`,
  `Sicario`), titles with lowercase connectors (`Under the Skin`), quoted phrases, and
  `and`-separated lists, which split into separate entities rather than merging. It excludes
  sentence-initial words capitalised by grammar, regions and US states (those are routed to
  `region`, since a place is not a taste entity), and phrases that begin with a stopword (`Set in
  New York`, `US and UK`). The four bundled sample scenes are part of the test suite for this
  reason: a sample that silently degrades to a flat ranking is a bad first impression.
- **Location does not move artist affinity.** See "What is honest and what is not" above. This was
  measured, not assumed, and it is the reason localisation targets places.
- **Market calls are slow and are budgeted for.** A location-filtered `urn:entity:place` query ran
  between 3.6s and 19.2s against the sandbox, well past the 12s default, so `/api/localise` runs its
  markets in parallel with a 25s per-call budget rather than serialising them inside the cue sheet.
- **A retained-affinity ratio is not a quantity, so Cue does not show one.** The obvious way to
  describe a cheaper substitute is "keeps 90% of the original's audience fit". That number is
  meaningless here. The original's affinity comes from an uncapped `/v2/insights` call and a
  substitute's comes from a `filter.popularity.max`-capped one, so each is a rank within a
  *different* candidate set. Measured live, capped-pool affinities ran *above* the uncapped
  target's, which is how a first draft reported "keeps 115%" and recommended an artist sharing 13%
  of the audience. Cue removed the ratio entirely and leads with audience overlap from
  `/v2/analysis/compare`, which is measured against the target directly and is therefore comparable.
  Affinity still orders the candidates *within* one pool, where the candidate set is shared.
- **The audience-overlap floor is calibrated, not guessed.** Overlap separates real substitutes from
  lookalikes far more sharply than shared genre tags do. Measured against the hackathon API:
  Portishead and Lamb `0.563`, Portishead and Hooverphonic `0.545`, Massive Attack and Tricky
  `0.531` — all genuine same-audience pairs — while Portishead and Kendrick Lamar `0.185` and
  Portishead and Gogo `0.125`, which share a genre tag but not an audience. Cue treats `0.30` as the
  floor for calling something a substitute, and says so in the warnings when nothing clears it
  rather than letting the closest option read as a swap.
- **`signal.demographics.age` rejects anything but its own bucket names.** A raw brief value like
  `25-34` returns `400`, which fails the *entire* request rather than narrowing it — so an
  unnormalised age silently empties every response that carries one. This was found by probing the
  API directly, not from the docs. Cue normalises at the single `insights()` choke point, so no
  caller can bypass it, and drops an unrecognised value rather than forwarding it: losing a
  demographic narrows a query, whereas passing one through destroys it.
- **Demographics *replace* the audience on `urn:entity:person`, so Cue does not send them there.** A
  demographic is supposed to narrow a query. On person entities it does something else. Anchored on
  *Drive* (2011), the undemographic call returns action leads — Stallone, Statham, Bruce Lee — and
  the same call with `age=25_to_29` returns an unrelated cluster (Shruti Haasan, MS Dhoni); only 2
  of 15 entities appear in both. It repeats across anchors and every age bucket, and `gender` alone
  has the same effect. The failure is dangerous precisely because the output still looks like a
  plausible list of names, so nothing downstream can detect it — Cue would have shown one audience's
  people as another's. Brands behave the opposite way: the same comparison keeps 4–8 of 10 entities
  and stays on-theme (*Drive* yields Aston Martin, Audi and Lamborghini either way), so demographics
  are kept there. The asymmetry is not documented by Qloo; it was measured, and the unit test
  asserts the person query carries no demographic parameters at all.
- **Typo tolerance is off on purpose.** With `feature.typo_tolerance=true`, Qloo fuzzy-matches
  unrelated tags — `tension` → *Venison*, `dark` → *Park*, `open` → *Oven* — which silently corrupts
  the grounding. Tag resolution pins `feature.typo_tolerance=false` so a tag means what it says.

## Run it

```bash
npm install
cp .env.example .env.local   # add your QLOO_API_KEY
npm run dev                  # http://localhost:12000
```

**It runs without any keys.** With no `QLOO_API_KEY`, Cue serves a pre-computed fixture cue sheet
through the exact same rendering path, so you can explore the full product before a hackathon key
arrives. The mode badge tells you which path you are on (`live` vs `fixture`).

To see the full experience including the live comparison baseline, set an LLM key as well — see the
environment table below. Without one, Cue uses its deterministic scene reader and the sheet labels
it as such.

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `QLOO_API_KEY` | for live mode | Your Qloo hackathon key |
| `QLOO_API_BASE_URL` | no | Defaults to `https://hackathon.api.qloo.com` |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | no | Any OpenAI-compatible endpoint (all three, to override everything else) |
| `OPENROUTER_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` | no | Set one and Cue infers the base URL and model |

Resolution order, highest first: the `LLM_*` triple, then `OPENROUTER_API_KEY`, `GEMINI_API_KEY`
(or `GOOGLE_API_KEY`), then `GROQ_API_KEY`.

There is no implicit OpenAI endpoint, and that is a deliberate choice. A paid key with no balance is
worse than no key at all: every cue sheet becomes a paid call that fails, and the app silently drops
to the deterministic reader while reporting a configured model — which is exactly what happened in
production before this was changed. A bare `OPENAI_API_KEY` therefore resolves to nothing. To use
OpenAI, name it with the `LLM_*` triple. `OPENAI_API_KEY` is still read as the credential for the
Agent Canvas managed proxy, which is identified by its own refresh URL rather than by the variable
name.

**Every configured provider is a fallback for the one above it.** Cue builds the ordered chain above
and tries each provider once, in order, until one answers. A rate-limited or unfunded primary hands
the same request to the next provider instead of giving up while a working key sits unused.
Providers are never retried within one request: a rejected key or an exhausted balance is permanent
for that provider, so repeating it only adds latency. The chain shares a single time budget rather
than one per provider, so a fallback cannot silently double the wall-clock cost of a cue sheet. When
a later provider answers after an earlier one failed, the sheet says so and names the provider that
succeeded.

The `LLM_*` triple is terminal: setting all three names an endpoint deliberately, so no fallback is
attempted.

Qloo is the required half; the LLM is optional and only names the specific track. Without it, Cue
still ranks artists from the taste graph and leaves the cut as "Track TBD" rather than inventing a
title. With it, each ranked artist gets a real track, album and year plus a rationale for the
placement.

Set `LLM_MODEL` explicitly when your endpoint does not serve the preset default (each provider's own
default is listed in the table below; the Agent Canvas proxy defaults to
`claude-sonnet-4-5-20250929`). A model your key cannot access returns `403`, and Cue degrades to
"Track TBD" cues; the server log names the rejected model so the cause is visible instead of silent.

**A configured key is not assumed to work.** Cue spends one call and, if the provider refuses it,
classifies the refusal — exhausted balance, rejected key, unavailable model, rate limit, timeout —
and says which one in the cue sheet, in the cue cards, and in `GET /api/cue?probe=1`. Rankings,
market fit and pricing are unaffected, because those come from Qloo and not the model. The
deterministic parser runs instead of the LLM, and the sheet labels it as such. `GET /api/cue` reports
the resolved provider, base URL and model without spending a call.

#### Free OpenAI-compatible providers

Track naming is optional, and a paid OpenAI key is not required to turn it on. Set the provider's own
key and Cue infers the rest:

| Provider | Key variable | Default model | Where to get a key |
|---|---|---|---|
| Groq | `GROQ_API_KEY` | `openai/gpt-oss-120b` | [console.groq.com](https://console.groq.com/keys) |
| Google Gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| OpenRouter | `OPENROUTER_API_KEY` | `openai/gpt-oss-120b` | [openrouter.ai/keys](https://openrouter.ai/keys) |

Any other OpenAI-compatible endpoint also works with no code change: set all three of `LLM_API_KEY`,
`LLM_BASE_URL` and `LLM_MODEL` to override every preset.

The defaults are chosen to be IDs the provider actually serves today, because a preset pointing at a
retired ID fails in a way that looks like an outage. Two that were wrong and are worth not
reintroducing: `gemini-3.5-flash` is not in Google's published model table (only
`gemini-3.5-flash-lite` is), and OpenRouter's `:free` suffix is a rotating allowance rather than a
modifier — `openai/gpt-oss-120b:free` is not in the catalogue and 404s, while the bare slug is real.

Groq, Gemini and OpenRouter's free tier need no credit card. Free model lineups rotate and models do
get retired, so check the provider's deprecation list before pinning an ID —
`llama-3.3-70b-versatile`, for example, was shut down for free-tier use on 2026-08-16.

To confirm what the deployed app resolved, and to see the upstream status if a call fails:

```bash
curl -s "https://<your-app>/api/cue" | jq .llm
curl -s "https://<your-app>/api/cue?probe=1" | jq .llmProbe
```

`/api/cue` reports which source resolved, the base URL and model it will call, the key length,
whether the key arrived with surrounding whitespace, and `providerChain` — the ordered list of
providers that will be tried. It never returns key material. `?probe=1` walks that same chain and
reports each provider's outcome, which distinguishes an invalid key (`401`) from an exhausted
balance (`402`/`429 insufficient_quota`) and tells you whether a healthy fallback exists behind a
failing primary.

### Deployment

Deploy to Vercel and set `QLOO_API_KEY` (plus your LLM variables) as environment variables:

```bash
vercel --prod
```

## License

MIT — see [LICENSE](./LICENSE).
