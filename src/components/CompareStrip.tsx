"use client";

import type { CueSheet } from "@/lib/types";

/**
 * The side-by-side that carries the whole pitch.
 *
 * Left: what an LLM says with no cultural data. Right: what Cue says when Qloo
 * decides the ranking. The hackathon's central test is whether the project
 * would work the same without Qloo, so the answer is shown, not claimed.
 */
export function CompareStrip({ sheet }: { sheet: CueSheet }) {
  return (
    <section aria-label="LLM-only versus Qloo-grounded comparison">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="font-display text-xl text-haze-100">
          The difference is the whole point
        </h2>
        <p className="text-xs text-haze-500">
          Same scene. Same model. One has cultural data.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="panel relative overflow-hidden p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-medium uppercase tracking-wider text-haze-500">
              LLM alone
            </h3>
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] uppercase tracking-wider text-haze-500">
              no cultural data
            </span>
          </div>
          <ul className="space-y-3">
            {sheet.baseline.cues.slice(0, 4).map((cue, index) => (
              <li key={index} className="border-b border-white/5 pb-3 last:border-0 last:pb-0">
                <p className="text-sm text-haze-300">
                  <span className="text-haze-100">{cue.artist}</span>
                  <span className="text-haze-500"> — “{cue.track}”</span>
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-haze-500">{cue.why}</p>
              </li>
            ))}
          </ul>
          <p className="mt-4 rounded-lg border border-white/5 bg-black/20 p-3 text-xs leading-relaxed text-haze-500">
            {sheet.baseline.note}
          </p>
        </div>

        <div className="panel relative overflow-hidden border-ember-500/20 p-5 shadow-glow">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-medium uppercase tracking-wider text-ember-400">
              Cue + Qloo
            </h3>
            <span className="rounded-full border border-ember-500/30 bg-ember-500/10 px-2.5 py-1 text-[10px] uppercase tracking-wider text-ember-400">
              taste graph grounded
            </span>
          </div>
          <ul className="space-y-3">
            {sheet.cues.slice(0, 4).map((cue) => (
              <li key={cue.id} className="border-b border-white/5 pb-3 last:border-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm text-haze-100">
                    {cue.artist}
                    <span className="text-haze-500"> — “{cue.track}”</span>
                  </p>
                  <span className="shrink-0 font-mono text-xs text-ember-400">
                    {cue.affinity.toFixed(2)}
                  </span>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-haze-300">
                  {cue.why[0]}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-4 rounded-lg border border-ember-500/15 bg-ember-500/5 p-3 text-xs leading-relaxed text-haze-300">
            Every pick is ranked by measured affinity, checked against the target
            audience, and dated against 90 days of momentum. Ask why, and Cue can
            name the exact signal that caused it.
          </p>
        </div>
      </div>
    </section>
  );
}
