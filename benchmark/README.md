# Qloo vs LLM-only benchmark

A reproducible comparison of Cue's Qloo-grounded recommendations against an independent LLM-only
baseline, on identical briefs.

**The short version: it did not find that Cue wins.** All four preregistered hypotheses came out
inconclusive or contradicted, and the artifact says so. The value here is the method — a
preregistered protocol, a replay that fails on drift, and metrics that report their own
inapplicability instead of inventing a number.

## The two arms

| | Arm A — LLM-only | Arm B — Cue |
|---|---|---|
| Input | `setting`, `mood`, `era` only | the same scene string |
| Cultural data | none | Qloo taste graph |
| Slate size | 3 by construction | truncated to 3 by measured affinity |
| Source | `CueSheet.baseline` (shipped code path) | the production pipeline |

Both arms come from a **single response** of the deployed app. Cue already builds its own ungrounded
control group, so Arm A is not a reimplementation of the model — it is the code the app ships — and
its `source` field reports whether the model actually answered (`llm`) or a labelled sample was
substituted (`sample`).

## Files

| File | Role |
|---|---|
| `protocol.json` | The preregistration. Committed at `6d38c7d`, **before** the metrics were computed. |
| `lib.mts` | Shared, deterministic metric code. Arm A isolation lives here. |
| `record.mts` | The only network step. Calls the deployed app once per brief. |
| `record-pool.mts` | Rebuilds each candidate pool and verifies it against a recorded fingerprint. |
| `evaluate.mts` | Recomputes every metric offline; fails if the result drifts from the artifact. |
| `worksheet.mts` | Emits the blinded review worksheet and the X/Y mapping. |
| `verify-benchmark.mts` | 57 checks over the failure modes, not just the happy path. |
| `results.json` | The published result, including the limitations. |
| `evidence/*.json` | Raw live responses, with provenance per brief. |
| `evidence/*.pool.json` | The frozen candidate pool per brief, with its verification proof. |
| `reviews/worksheet.md` | The blinded worksheet a reviewer fills in. |
| `reviews/mapping.json` | X/Y to arm mapping. Withheld from the reviewer until ratings are in. |

## Run it

```bash
npm run benchmark          # recompute and assert it matches results.json
npm run benchmark:verify   # the test suite
npm run benchmark:report   # print the tables
```

Replay needs **no network and no credentials**. The recording steps do, and are run manually:

```bash
npm run benchmark:record   # writes evidence/<brief>.json
npm run benchmark:pool     # writes evidence/<brief>.pool.json
```

## Why the pool has to be rebuilt

The app's response carries its coverage result but **not** the 14-entity candidate pool behind it,
and coverage is pool-relative. Without the pool the metric cannot be recomputed offline at all.

`record-pool.mts` calls the same production functions the planner calls, in the same order, then
checks the reconstruction against a fingerprint the deployment itself recorded — pool size,
vocabulary size, covered-tag count and redundancy. All six briefs match **exactly**, including the
index to full precision. A mismatch writes nothing, and coverage becomes unavailable downstream
rather than being silently measured on a different pool.

## What the metrics can and cannot say

| Metric | Kind | Caveat |
|---|---|---|
| Brief relevance | lexical proxy | Word overlap, not judgement. No stemming. Biased by the arms' differing rationale fields. |
| Anchor recycling | lexical | High is worse, but naming a requested anchor can be correct. |
| Diversity | structural + proxy | `distinctArtistRatio` is structural; `textJaccard` is a proxy. |
| Tag Coverage Index | production metric, reused unchanged | Pool-relative. Not a measure of quality. |
| Human preference | human | Not performed. No proxy is substituted. |

The metrics are deliberately **not** combined into one score: no defensible weighting exists without
human preference data.

## The two findings that matter

**The relevance result is the metric's bias, not a finding.** Arm A writes descriptive prose that
contains mood words; Arm B emits Qloo provenance boilerplate that cannot. A lexical proxy rewards
Arm A for that. The `sensitivity` block recomputes the metric over artist and track only, dropping
the rationale, and the difference **disappears entirely** (median diff 0.50 → 0.0000). Both bounds
are published.

**The coverage result is inconclusive because the measurement barely applies.** Arm A answers
open-book, so most of its picks do not exist in Arm B's pool. Only one brief had any measurable Arm A
pick. The protocol preregistered this as expected to be inconclusive *before* the data existed, so a
low Arm A figure could not later be presented as a Cue win. An unmeasurable pick is recorded as
unmeasurable, never scored as zero.

## Reading the evidence

Every `evidence/<brief>.json` carries the source commit, the protocol sha256, the HTTP status and
latency, and the deployment's own report of which model ran. A credential-pattern guard refuses to
write a response that looks like it contains key material; the committed files contain none.
