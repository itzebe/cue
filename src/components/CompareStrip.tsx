"use client";

import type { CueSheet } from "@/lib/types";

/**
 * The side-by-side that carries the whole pitch.
 *
 * Left: what the model answers with no cultural data. Right: what Cue answers when
 * Qloo decides the ranking. The hackathon's central test is whether the project
 * would work the same without Qloo, so the answer is shown rather than claimed.
 *
 * Three honesty rules hold this panel together:
 *
 *  1. The baseline is only ever presented as a model answer when the model actually
 *     produced it. `baseline.source` says which, and a fixed sample is labelled as
 *     one instead of being dressed up as a live comparison.
 *  2. Every number on the right is a Qloo field rendered as-is. Nothing here is
 *     scored, ranked or inferred by this component.
 *  3. The overlap figure is arithmetic over the two visible lists. It is a count,
 *     not a quality judgement, and it is described as a count.
 */
export function CompareStrip({ sheet }: { sheet: CueSheet }) {
  const baseline = sheet.baseline;
  const baselineIsModel = baseline.source === "llm";

  // A real, computable difference: how many artists both answers name.
  const baselineArtists = new Set(baseline.cues.map((cue) => cue.artist.toLowerCase()));
  const shared = sheet.cues.filter((cue) => baselineArtists.has(cue.artist.toLowerCase()));
  const top = sheet.cues[0];
  const topReason = top?.why.find((line) => /audiences who like/i.test(line));
  const audienceLine = sheet.audienceBrief?.available
    ? sheet.audienceBrief.evidence[0]?.audienceIdentity
    : undefined;

  return (
    <section id="comparison" className="scroll-mt-20" aria-label="LLM-only versus Qloo-grounded comparison">
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h2 className="font-display text-xl text-haze-100">
          Same scene, same model &mdash; one answer has cultural data
        </h2>
        <p className="text-xs text-haze-500">
          {baselineIsModel
            ? "Both lists were produced from this scene."
            : "Right column is live Qloo output; left is a fixed sample."}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Baseline. Deliberately not styled as the hero: it is the control. */}
        <div className="panel relative overflow-hidden p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium uppercase tracking-wider text-haze-500">
              The model alone
            </h3>
            <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] uppercase tracking-wider text-haze-500">
              no cultural data
            </span>
          </div>
          <ul className="space-y-3">
            {baseline.cues.slice(0, 4).map((cue, index) => (
              <li key={index} className="border-b border-white/5 pb-3 last:border-0 last:pb-0">
                <p className="text-sm text-haze-300">
                  <span className="text-haze-100">{cue.artist}</span>
                  <span className="text-haze-500"> &mdash; &ldquo;{cue.track}&rdquo;</span>
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-haze-500">{cue.why}</p>
              </li>
            ))}
          </ul>
          <p className="mt-4 rounded-lg border border-white/5 bg-black/20 p-3 text-xs leading-relaxed text-haze-500">
            {!baselineIsModel ? (
              <span className="mb-1 block font-medium uppercase tracking-wider text-ember-400/80">
                Fixed sample &mdash; the model did not run for this sheet
              </span>
            ) : null}
            {baseline.note}
          </p>
        </div>

        {/* Cue + Qloo. The claim is the evidence under each pick, not the styling. */}
        <div className="panel relative overflow-hidden border-ember-500/20 p-5 shadow-glow">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium uppercase tracking-wider text-ember-400">
              Cue, ranked by Qloo
            </h3>
            <span className="shrink-0 rounded-full border border-ember-500/30 bg-ember-500/10 px-2.5 py-1 text-[10px] uppercase tracking-wider text-ember-400">
              taste graph grounded
            </span>
          </div>
          <ul className="space-y-3">
            {sheet.cues.slice(0, 4).map((cue) => {
              // The first Qloo-traceable reason only. A model-written rationale is
              // deliberately excluded: it is not evidence, and it is labelled
              // separately on the cue card.
              const evidence = cue.why.find((line) =>
                /audiences who like|attributes the match/i.test(line),
              );
              return (
                <li key={cue.id} className="border-b border-white/5 pb-3 last:border-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm text-haze-100">
                      {cue.artist}
                      {cue.trackUnverified ? null : (
                        <span className="text-haze-500"> &mdash; &ldquo;{cue.track}&rdquo;</span>
                      )}
                    </p>
                    <span className="shrink-0 font-mono text-xs text-ember-400">
                      {cue.affinity.toFixed(3)}
                    </span>
                  </div>
                  {evidence ? (
                    <p className="mt-0.5 text-xs leading-relaxed text-haze-300">{evidence}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-4 rounded-lg border border-ember-500/15 bg-ember-500/5 p-3 text-xs leading-relaxed text-haze-300">
            Every figure above is a Qloo field, shown as returned: affinity is the
            artist&rsquo;s measured position against this scene&rsquo;s taste profile. Nothing in
            this column is scored by the model.
          </p>
        </div>
      </div>

      {/* What actually differs, computed from the two lists rather than asserted. */}
      <div className="panel mt-4 p-4">
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-haze-500">
          What differs
        </h3>
        <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-haze-300">
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ember-500" />
            <span>
              The two lists name{" "}
              <span className="font-mono text-haze-100">{shared.length}</span>{" "}
              {shared.length === 1 ? "artist" : "artists"} in common
              {shared.length > 0 ? `: ${shared.map((cue) => cue.artist).join(", ")}` : ""}. The
              right column is a different answer, not the same answer reordered.
            </span>
          </li>
          {topReason ? (
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ember-500" />
              <span>
                The top pick rests on a measured relationship rather than a description:{" "}
                <span className="text-haze-100">{topReason}</span>
              </span>
            </li>
          ) : null}
          {top ? (
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ember-500" />
              <span>
                That pick carries a Qloo affinity of{" "}
                <span className="font-mono text-haze-100">{top.affinity.toFixed(3)}</span>{" "}
                against this scene&rsquo;s profile. The left column has no comparable figure,
                because there is nothing behind it to measure.
              </span>
            </li>
          ) : null}
          {audienceLine ? (
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ember-500" />
              <span>
                Qloo describes the anchor&rsquo;s audience as:{" "}
                <span className="text-haze-100 italic">&ldquo;{audienceLine}&rdquo;</span>
              </span>
            </li>
          ) : null}
        </ul>
        <p className="mt-3 text-[11px] leading-relaxed text-haze-500">
          This panel makes no claim about which answer is creatively better. It shows that the
          two answers are different, and that one of them arrives with measurements.
        </p>
      </div>
    </section>
  );
}
