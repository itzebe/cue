# Cue — demo video narration script

> **Status: optional extra.** The official rules for the Qloo Agentic Hackathon list a demo video
> as *not required* — "Demo videos are not required. Instead of asking for a recording, we're
> requiring something judges can actually use." The required submission items are a live demo link,
> a public repo with an open-source licence, and a text description. This video is a bonus that
> strengthens the Design and Potential Impact criteria; it is not a submission requirement, and
> there is no required length, format or hosting platform.

**Watch / download:** https://github.com/itzebe/cue/releases/download/demo-video/cue-demo.mp4
Release page: https://github.com/itzebe/cue/releases/tag/demo-video

Video: `cue-demo.mp4` · 2:35 · 1440×900 · 30 fps · **includes narration audio** (synthetic voice)

The delivered file already has this narration mixed in, plus burned-in captions. The script below
is the source text, so you can re-record it in your own voice and swap the audio track.

Timings are exact — the video was cut to this storyboard, so the scene boundaries below are
frame-accurate. The narration is written to complement the on-screen captions, not duplicate them.

---

## Scene 1 — The problem (0:00–0:20)

**On screen:** the scene brief, on a dark card.

> Here's a scene. A young woman walks alone through Tokyo at night. Introspective, melancholic,
> quietly hopeful.
>
> A music supervisor doesn't just need songs that match a mood. They need choices that fit the
> scene's *cultural* context — and they need to defend those choices to a director and a client.
>
> That's the part a language model can't do. Ask it for music for this scene and it reaches for
> what's statistically common, not what fits *this* audience.

## Scene 2 — Cue in action (0:20–0:50)

**On screen:** the live app. The brief is typed into the composer, then "Build the cue sheet" runs.

> This is Cue, running live. I paste the brief and build the cue sheet.
>
> Cue reads the scene, extracts a taste profile, and queries the Qloo Taste Graph — 250 million
> entities across music, film, people, brands and places.
>
> *(The generation wait is compressed here; nothing is skipped.)*

## Scene 3 — The cue sheet (0:50–1:25)

**On screen:** the ranked cue sheet, scrolled slowly. Each cue shows its affinity score.

> Here's the result. Every cue carries an affinity score measured in the Qloo Taste Graph —
> not a popularity chart, not a rating.
>
> And notice there are two *different* kinds of claim on each card. "Why this cut" is written by
> the scene reader — that's model prose, and Cue labels it as such. "Why Qloo ranked this" is
> measured evidence: it names the actual entities behind the match and the weight Qloo gave them.
>
> That distinction is the whole point. You can see which part is measured and which part is
> inferred.

## Scene 4 — The Qloo advantage (1:25–2:05)

**On screen:** the Cross-Domain Taste Map, then the comparison panel.

> This is the part that only works because of Qloo. The same audience signal answers other
> questions — who to cast, which partners fit, which markets to localise for. These are Qloo
> affinity scores, not generated text.
>
> And here's the comparison. Same scene, same model, two lists. The left has no cultural data —
> it's plausible and unverifiable. The right is ranked on measured affinity.
>
> To be precise about what that number is: it's Qloo's affinity score for the entity against the
> audience profile — an index of how strongly that audience over-indexes for it. It is *not* a
> percentage of shared audience, and it isn't audience overlap.

## Scene 5 — Why Cue matters (2:05–2:35)

**On screen:** closing card with the live URL and the repository.

> For a music supervisor, that means a first pass you can actually defend — ranked on evidence,
> with the receipts attached.
>
> Cue combines scene interpretation with traceable cultural-affinity evidence to support music
> discovery.
>
> It's live at cue-nine-iota.vercel.app, and the source is public at github.com/itzebe/cue.

---

## Production notes

- **No fabricated results.** Every frame of app footage comes from a single real live run against
  the production deployment (`mode: live`, 23 Qloo receipts). The recommendations on screen were
  produced by the model and the Taste Graph during recording.
- **Only two accelerations**, both disclosed: the ~28s generation wait is played at 2×, and the
  scrolling in Scenes 3–4 is slowed slightly to give each section reading time. No frames are
  invented, reordered, or composited.
- **No audience-overlap claims.** The narration states explicitly that affinity is an index, not a
  shared-audience percentage.
- **Voice.** The delivered audio is a synthetic voice (Piper, `en_US-lessac-medium`), not a human
  recording. It is accurate and correctly timed, but if the rules or judges expect a human voice,
  re-record the script below and replace the audio track.
- The on-screen recommendations will differ between runs — the model is non-deterministic. If you
  re-record, the narration stays valid; the specific artists will change.
