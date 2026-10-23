# Cue

**The cultural layer for creative decisions.** Cue measures what actually resonates — and then sells the placement.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/). Every ranking, market read, casting match and price traces back to measured audience affinity in the [Qloo Taste Graph](https://docs.qloo.com/), because an LLM cannot know what people actually like.

The first use case is music supervision for film, TV and advertising: a scene brief in, a grounded cue sheet out. The same engine then answers the neighbouring questions — who to cast, which brands fit, what changes by market, and what the placement costs to clear.

---

## The problem

Ask any language model to score a scene and you get the same answer every time. A funeral gets *Hallelujah*. A 90s montage gets *Smells Like Teen Spirit*. A sneaker ad gets whatever was on the radio last year.

The model is not being lazy. It has no cultural data. It knows which songs are *famous*; it has no idea which songs actually fit the audience for this specific scene. So it reaches for the most statistically common answer and calls it a recommendation.

Music supervisors are paid precisely for the thing the model cannot do. Cue gives them that, at speed.

## What Cue does

Paste a scene brief — a script page, a treatment, or two sentences — and Cue returns a full cue sheet:

- **Culturally grounded options.** Artists ranked by *measured* cross-domain affinity with the scene's taste profile, not by what's popular.
- **A reason attached to every pick.** Each cue names the signal that caused it, using Qloo's explainability data. No black box.
- **Audience fit.** Demographic signals confirm the pick lands with the people the scene is made for.
- **Momentum.** Qloo's own trend series, so a supervisor knows whether a cue reads current or nostalgic.
- **Placement and clearance notes.** Which cue is the needle drop, which is the score bed, and what each will cost to clear.
- **A creative A/B.** Two competing directions run through `/v2/analysis/compare` to see whether they split the audience or share it.
- **A clearance desk.** Select the cues you want and Cue prices the grant: fee band, rights holders, one-stop or two negotiations, the path to signature, and the day the campaign is gated.
- **A substitute when the answer is unaffordable.** The top pick costs more than the budget, or the label refuses. Cue inverts the budget into a popularity ceiling, searches the taste graph for artists the same audience already loves inside it, and reports each one's measured audience overlap with the original. This is the question a ranked list cannot answer, and the one supervisors actually get stuck on.
- **Cross-domain answers.** The same taste profile that ranks the music ranks people for casting and brands for partner fit, and returns the cultural touchpoints each market would reference.
- **Full receipts.** Every Qloo endpoint called, with parameters, status, latency and row count.

## What is honest and what is not

Cue is built for a hackathon with a live API, so the boundary between measured and modelled is stated in the product rather than blurred.

| Output | Source | Status |
|---|---|---|
| Affinity, popularity, momentum, audience fit | Qloo | Measured |
| Market touchpoints | Qloo (`urn:entity:place` + location) | Measured |
| Casting and brand candidates | Qloo (`urn:entity:person`, `urn:entity:brand`) | Measured |
| Audience overlap between two artists | Qloo (`/v2/analysis/compare`) | Measured |
| Track titles | Optional LLM, else left for the supervisor | Never invented |
| Fees, splits, clearance timelines | Cue's own model | Estimated, labelled as such |

Two findings shaped the design and are worth stating plainly:

1. **Qloo's location filter does not move artist affinity.** Measured against the hackathon API, `filter.type=urn:entity:artist` returns byte-identical entities *and* affinity scores for Los Angeles, Sao Paulo, Seoul, Lagos and London. A feature claiming to "localise the soundtrack" would be fabricating its result, so Cue localises what the data actually supports — `urn:entity:place`, where markets diverge completely (Big Ben for London, the Ghibli Museum for Tokyo, zero overlap between markets). The music stays global because the data says it is global.
2. **Clearance data is not available through Qloo.** Fees and splits are therefore produced by a transparent model with every input and multiplier shown in the UI, not presented as quotes. Inventing a real number would be the same failure as inventing a track title.

## Why this needs Qloo

The hackathon's test is whether a project would work the same without Qloo. Here it plainly would not.

| Question the cue sheet answers | Qloo endpoint | Could an LLM answer it? |
|---|---|---|
| Who are the entities in this brief? | `GET /search` | No — needs resolved entity IDs |
| Which artists share this scene's taste profile? | `GET /v2/insights` | No — requires measured affinity |
| Why was this artist chosen? | `feature.explainability=true` | No — requires the signal graph |
| Does it land with this audience? | `signal.demographics.*` | No — requires demographic data |
| Is this artist rising or cooling? | `GET /v2/trending` | No — requires a time series |
| Do these two directions share an audience? | `GET /v2/analysis/compare` | No — requires cross-group analysis |
| Which people and brands fit this audience? | `urn:entity:person`, `urn:entity:brand` insights | No — requires cross-domain affinity |
| What cultural touchpoints define this market? | `urn:entity:place` + `filter.location.query` | No — requires regional signals |
| What will this cost to clear? | Qloo popularity + momentum, then Cue's model | No — needs measured leverage |

Cue makes this explicit in the product itself. The **"The difference is the whole point"** panel puts the ungrounded LLM answer next to the Qloo-grounded one, on the same scene, in the same view.

## How the agent works

```
scene brief
   │
   ├─ 1. read the scene            LLM (or deterministic parser as fallback)
   │
   ├─ 2. resolve references        GET /search        → Qloo entity IDs
   │      resolve mood/genre       GET /v2/tags       → valid tag IDs
   │
   ├─ 3. rank artists              GET /v2/insights   → affinity + explainability
   │      (the load-bearing call)
   │
   ├─ 4. enrich                    GET /v2/trending         → momentum
   │                               location-aware insights  → regional fit
   │                               cross-domain backfill    → non-obvious picks
   │
   ├─ 5. name tracks               LLM → one real track per Qloo-ranked artist
   │
   ├─ 6. cross-domain              people + brands → casting and partner fit
   │
   └─ 7. assemble                  placement, clearance, confidence, receipts
```

Localisation is deliberately **not** a stage of the cue sheet. Each market is a location-filtered place query that measured 3.6s–19.2s on the hackathon sandbox — a cost every sheet would pay for a feature most sheets do not use. It lives behind its own endpoint, `POST /api/localise`, that the user triggers when they want it. The cue sheet itself stays around 20s.

**The division of labour is deliberate.** The LLM proposes creative scaffolding — track titles, tone language, the reading of the scene. **Qloo decides what actually ranks.** Cue never invents an affinity number, and never asks a model to guess one.

Each stage degrades independently: a failed trending call costs one cue its momentum badge, not the whole sheet. Every failure is surfaced in the receipts panel rather than hidden.

## Run it

```bash
npm install
cp .env.example .env.local   # add your QLOO_API_KEY
npm run dev                  # http://localhost:12000
```

**It runs without any keys.** With no `QLOO_API_KEY`, Cue serves a pre-computed fixture cue sheet through the exact same rendering path, so you can explore the full product before your hackathon key arrives. The mode badge tells you which path you are on (`live` vs `fixture`).

### Verify the pipeline

```bash
npm run verify
```

71 checks covering normalisation, affinity extraction, explainability parsing, momentum derivation, failure degradation, cue assembly, concurrency limits, place-based localisation, casting and licence pricing. Only `fetch` is stubbed — everything under test is the production code path.

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `QLOO_API_KEY` | for live mode | Your Qloo hackathon key |
| `QLOO_API_BASE_URL` | no | Defaults to `https://hackathon.api.qloo.com` |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | no | Any OpenAI-compatible endpoint (all three, to override everything else) |
| `OPENROUTER_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` | no | Set one and Cue infers the base URL and model |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | no | Alternative to the above |

Resolution order, highest first: the `LLM_*` triple, then `OPENROUTER_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `GROQ_API_KEY`, then `OPENAI_*`. A provider-specific key deliberately outranks `OPENAI_API_KEY`: an OpenAI key with an exhausted balance would otherwise shadow a working key set under the provider's own name.

**Every configured provider is a fallback for the one above it.** Cue builds the ordered chain above and tries each provider once, in order, until one answers. A rate-limited or unfunded primary hands the same request to the next provider instead of giving up while a working key sits unused. Providers are never retried within one request: a rejected key or an exhausted balance is permanent for that provider, so repeating it only adds latency. The chain shares a single time budget rather than one per provider, so a fallback cannot silently double the wall-clock cost of a cue sheet. When a later provider answers after an earlier one failed, the sheet says so and names the provider that succeeded.

The `LLM_*` triple is terminal: setting all three names an endpoint deliberately, so no fallback is attempted.

Qloo is the required half; the LLM is optional and only names the specific track. Without it, Cue still ranks artists from the taste graph and leaves the cut as "Track TBD" rather than inventing a title. With it, each ranked artist gets a real track, album and year plus a rationale for the placement.

Set `LLM_MODEL` explicitly when your endpoint does not serve the default (`gpt-4o-mini` for OpenAI, `claude-sonnet-4-5-20250929` for the Agent Canvas proxy). A model your key cannot access returns `403`, and Cue degrades to "Track TBD" cues; the server log names the rejected model so the cause is visible instead of silent.

**A configured key is not assumed to work.** Cue spends one call and, if the provider refuses it, classifies the refusal — exhausted balance, rejected key, unavailable model, rate limit, timeout — and says which one in the cue sheet, in the cue cards, and in `GET /api/cue?probe=1`. Rankings, market fit and pricing are unaffected, because those come from Qloo and not the model. The deterministic parser runs instead of the LLM, and the sheet labels it as such. `GET /api/cue` reports the resolved provider, base URL and model without spending a call.

#### Free OpenAI-compatible providers

Track naming is optional, and a paid OpenAI key is not required to turn it on. Set the provider's own key and Cue infers the rest:

| Provider | Key variable | Default model | Where to get a key |
|---|---|---|---|
| Groq | `GROQ_API_KEY` | `openai/gpt-oss-120b` | [console.groq.com](https://console.groq.com/keys) |
| Google Gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| OpenRouter | `OPENROUTER_API_KEY` | `openai/gpt-oss-120b` | [openrouter.ai/keys](https://openrouter.ai/keys) |

Any other OpenAI-compatible endpoint also works with no code change: set all three of `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL` to override every preset.

The defaults are chosen to be IDs the provider actually serves today, because a preset pointing at a retired ID fails in a way that looks like an outage. Two that were wrong and are worth not reintroducing: `gemini-3.5-flash` is not in Google's published model table (only `gemini-3.5-flash-lite` is), and OpenRouter's `:free` suffix is a rotating allowance rather than a modifier — `openai/gpt-oss-120b:free` is not in the catalogue and 404s, while the bare slug is real.

Groq, Gemini and OpenRouter's free tier need no credit card. Free model lineups rotate and models do get retired, so check the provider's deprecation list before pinning an ID — `llama-3.3-70b-versatile`, for example, was shut down for free-tier use on 2026-08-16.

To confirm what the deployed app resolved, and to see the upstream status if a call fails:

```bash
curl -s "https://<your-app>/api/cue" | jq .llm
curl -s "https://<your-app>/api/cue?probe=1" | jq .llmProbe
```

`/api/cue` reports which source resolved, the base URL and model it will call, the key length, whether the key arrived with surrounding whitespace, and `providerChain` — the ordered list of providers that will be tried. It never returns key material. `?probe=1` walks that same chain and reports each provider's outcome, which distinguishes an invalid key (`401`) from an exhausted balance (`402`/`429 insufficient_quota`) and tells you whether a healthy fallback exists behind a failing primary.


## Deployment

Deploy to Vercel and set `QLOO_API_KEY` (plus your LLM variables) as environment variables:

```bash
vercel --prod
```

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/cue` | Scene brief in, grounded cue sheet out. The core call. |
| `POST /api/localise` | Compare the brief's cultural touchpoints across markets. Slow by nature, so it is opt-in. |
| `POST /api/quote` | Price a selected basket: fee bands, rights holders, clearance path, gating day. |
| `POST /api/substitute` | Find what else serves the scene inside a budget. Opt-in, because it costs several calls. |
| `GET /api/cue` | Health check: whether Qloo and an LLM are configured, and against which base URL. |

## Notes for reviewers

- **Hackathon base URL.** Hackathon keys only work against `https://hackathon.api.qloo.com`. Using staging or production returns 401. This is the default here.
- **Authentication.** Qloo expects the key in the `X-Api-Key` header, not as a bearer token.
- **`/v2/insights` is a GET.** Parameters go in the query string; a POST body will fail.
- **Invalid parameters fail silently.** Qloo ignores unsupported parameters and returns `200` with an empty entity list rather than an error. Cue resolves entities and tags *before* ranking, which is why the call chain has more steps than a naive integration — and why it does not quietly return nothing.
- **Legacy `/recs` and `/recommendations` are unsupported** for the hackathon and are not used anywhere in this codebase.
- **No "song" entity type exists in Qloo.** Cue grounds the *artist* and *vibe* with Qloo, then proposes specific tracks from those artists. This is stated openly rather than papered over.
- **Momentum is measured, never invented.** The trend series exposed by the hackathon sandbox is a frozen snapshot: `population_rank_velocity`, `population_percent_delta` and `population_percentile` are constant across every artist tested, so the derivation legitimately returns `0` (steady) on live data. The field is parsed, ranked and rendered; it simply reports "steady" rather than fabricating a trend. The unit tests cover the rising and cooling branches with a varying series.
- **Tag-only briefs return a uniform affinity.** When a brief names no film, director or artist, `/v2/insights` matches on tags alone and returns the same affinity score for every entity. Cue detects this (zero spread with no signal entities), orders by popularity as a deterministic tiebreak, and says so in the warnings instead of presenting an arbitrary order as a ranking. Naming an anchor restores true affinity ranking.
- **Anchor extraction is load-bearing, so it is tested.** Whether a brief gets true affinity ranking or the flat tag-only fallback is decided entirely by whether Cue can find a named reference in the text. The reader handles the shapes supervisors actually write — single-word titles (`Drive`, `Sicario`), titles with lowercase connectors (`Under the Skin`), quoted phrases, and `and`-separated lists, which split into separate entities rather than merging. It excludes sentence-initial words capitalised by grammar, regions and US states (those are routed to `region`, since a place is not a taste entity), and phrases that begin with a stopword (`Set in New York`, `US and UK`). The four bundled sample scenes are part of the test suite for this reason: a sample that silently degrades to a flat ranking is a bad first impression.
- **The key rate-limits in bursts, and the client absorbs it.** A cue sheet issues 20+ calls, and the hackathon key returns `429` under that load. Requests are capped at four in flight and retried up to three times with exponential backoff, honouring `Retry-After` when present. A rate-limited run comes back complete instead of half-empty.
- **Location does not move artist affinity.** See "What is honest and what is not" above. This was measured, not assumed, and it is the reason localisation targets places.
- **Market calls are slow and are budgeted for.** A location-filtered `urn:entity:place` query ran between 3.6s and 19.2s against the sandbox, well past the 12s default, so `/api/localise` runs its markets in parallel with a 25s per-call budget rather than serialising them inside the cue sheet.
- **A retained-affinity ratio is not a quantity, so Cue does not show one.** The obvious way to describe a cheaper substitute is "keeps 90% of the original's audience fit". That number is meaningless here. The original's affinity comes from an uncapped `/v2/insights` call and a substitute's comes from a `filter.popularity.max`-capped one, so each is a rank within a *different* candidate set. Measured live, capped-pool affinities ran *above* the uncapped target's, which is how a first draft reported "keeps 115%" and recommended an artist sharing 13% of the audience. Cue removed the ratio entirely and leads with audience overlap from `/v2/analysis/compare`, which is measured against the target directly and is therefore comparable. Affinity still orders the candidates *within* one pool, where the candidate set is shared.
- **The audience-overlap floor is calibrated, not guessed.** Overlap separates real substitutes from lookalikes far more sharply than shared genre tags do. Measured against the hackathon API: Portishead and Lamb `0.563`, Portishead and Hooverphonic `0.545`, Massive Attack and Tricky `0.531` — all genuine same-audience pairs — while Portishead and Kendrick Lamar `0.185` and Portishead and Gogo `0.125`, which share a genre tag but not an audience. Cue treats `0.30` as the floor for calling something a substitute, and says so in the warnings when nothing clears it rather than letting the closest option read as a swap.
- **`signal.demographics.age` rejects anything but its own bucket names.** A raw brief value like `25-34` returns `400`, which fails the *entire* request rather than narrowing it — so an unnormalised age silently empties every response that carries one. This was found by probing the API directly, not from the docs. Cue normalises at the single `insights()` choke point, so no caller can bypass it, and drops an unrecognised value rather than forwarding it: losing a demographic narrows a query, whereas passing one through destroys it.
- **Demographics *replace* the audience on `urn:entity:person`, so Cue does not send them there.** A demographic is supposed to narrow a query. On person entities it does something else. Anchored on *Drive* (2011), the undemographic call returns action leads — Stallone, Statham, Bruce Lee — and the same call with `age=25_to_29` returns an unrelated cluster (Shruti Haasan, MS Dhoni); only 2 of 15 entities appear in both. It repeats across anchors and every age bucket, and `gender` alone has the same effect. The failure is dangerous precisely because the output still looks like a plausible list of names, so nothing downstream can detect it — Cue would have shown one audience's people as another's. Brands behave the opposite way: the same comparison keeps 4–8 of 10 entities and stays on-theme (*Drive* yields Aston Martin, Audi and Lamborghini either way), so demographics are kept there. The asymmetry is not documented by Qloo; it was measured, and the unit test asserts the person query carries no demographic parameters at all.
- **Typo tolerance is off on purpose.** With `feature.typo_tolerance=true`, Qloo fuzzy-matches unrelated tags — `tension` → *Venison*, `dark` → *Park*, `open` → *Oven* — which silently corrupts the grounding. Tag resolution pins `feature.typo_tolerance=false` so a tag means what it says.

## License

MIT — see [LICENSE](./LICENSE).
