# Cue

**An agentic music supervisor that scores film, TV and advertising scenes with music that is culturally right — not just plausible.**

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/). Every recommendation is ranked by the [Qloo Taste Graph](https://docs.qloo.com/), because an LLM cannot know what people actually like.

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
- **Full receipts.** Every Qloo endpoint called, with parameters, status, latency and row count.

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
| Does it land in this market? | `location-aware insights` | No — requires regional signals |

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
   └─ 6. assemble                  placement, clearance, confidence, receipts
```

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

24 checks covering normalisation, affinity extraction, explainability parsing, momentum derivation, failure degradation and cue assembly. Only `fetch` is stubbed — everything under test is the production code path.

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `QLOO_API_KEY` | for live mode | Your Qloo hackathon key |
| `QLOO_API_BASE_URL` | no | Defaults to `https://hackathon.api.qloo.com` |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | no | Any OpenAI-compatible endpoint |
| `OPENAI_API_KEY` | no | Alternative to the above |

Without an LLM configured, Cue uses its deterministic scene reader and skips track naming. The Qloo grounding is unaffected.

## Deployment

Deploy to Vercel and set `QLOO_API_KEY` (plus your LLM variables) as environment variables:

```bash
vercel --prod
```

## Notes for reviewers

- **Hackathon base URL.** Hackathon keys only work against `https://hackathon.api.qloo.com`. Using staging or production returns 401. This is the default here.
- **Authentication.** Qloo expects the key in the `X-Api-Key` header, not as a bearer token.
- **`/v2/insights` is a GET.** Parameters go in the query string; a POST body will fail.
- **Invalid parameters fail silently.** Qloo ignores unsupported parameters and returns `200` with an empty entity list rather than an error. Cue resolves entities and tags *before* ranking, which is why the call chain has more steps than a naive integration — and why it does not quietly return nothing.
- **Legacy `/recs` and `/recommendations` are unsupported** for the hackathon and are not used anywhere in this codebase.
- **No "song" entity type exists in Qloo.** Cue grounds the *artist* and *vibe* with Qloo, then proposes specific tracks from those artists. This is stated openly rather than papered over.
- **Momentum is measured, never invented.** The trend series exposed by the hackathon sandbox is a frozen snapshot: `population_rank_velocity`, `population_percent_delta` and `population_percentile` are constant across every artist tested, so the derivation legitimately returns `0` (steady) on live data. The field is parsed, ranked and rendered; it simply reports "steady" rather than fabricating a trend. The unit tests cover the rising and cooling branches with a varying series.
- **Tag-only briefs return a uniform affinity.** When a brief names no film, director or artist, `/v2/insights` matches on tags alone and returns the same affinity score for every entity. Cue detects this (zero spread with no signal entities), orders by popularity as a deterministic tiebreak, and says so in the warnings instead of presenting an arbitrary order as a ranking. Naming an anchor restores true affinity ranking.
- **The key rate-limits in bursts, and the client absorbs it.** A cue sheet issues 20+ calls, and the hackathon key returns `429` under that load. Requests are capped at four in flight and retried up to three times with exponential backoff, honouring `Retry-After` when present. A rate-limited run comes back complete instead of half-empty.
- **Typo tolerance is off on purpose.** With `feature.typo_tolerance=true`, Qloo fuzzy-matches unrelated tags — `tension` → *Venison*, `dark` → *Park*, `open` → *Oven* — which silently corrupts the grounding. Tag resolution pins `feature.typo_tolerance=false` so a tag means what it says.

## License

MIT — see [LICENSE](./LICENSE).
