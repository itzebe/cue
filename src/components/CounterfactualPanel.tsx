"use client";

import type { CueSheet } from "@/lib/types";
import { GROUNDED_CAPABILITIES } from "@/lib/counterfactual";

/**
 * The Qloo ON/OFF counterfactual, as a control the reader operates.
 *
 * The hackathon's eligibility test is "would this work the same without Qloo?".
 * A static side-by-side answers that once; a switch the reader flips answers it
 * every time, which is the difference between a claim and a demonstration.
 * Both sides come from the sheet the pipeline already returned — the grounded
 * slate and the model's ungrounded answer — so flipping costs no API call and no
 * latency, and the two are guaranteed to describe the same scene.
 *
 * The panel owns the switch and the "what switching off removes" table. The page
 * owns the state, because flipping it changes what the rest of the results column
 * renders: with Qloo off, the measured panels are replaced by an honest account of
 * what is no longer available.
 */

/** The switch itself. Rendered in the results column header and in the panel. */
export function GroundingSwitch({
  groundedOn,
  onChange,
  idPrefix = "grounding",
}: {
  groundedOn: boolean;
  onChange: (next: boolean) => void;
  idPrefix?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Qloo grounding switch"
      className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-1"
    >
      {[
        { on: true, label: "Qloo on" },
        { on: false, label: "Qloo off" },
      ].map((option) => {
        const active = groundedOn === option.on;
        return (
          <button
            key={option.label}
            id={`${idPrefix}-${option.on ? "on" : "off"}`}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.on)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              active
                ? option.on
                  ? "bg-ember-500/15 text-ember-400"
                  : "bg-white/10 text-haze-100"
                : "text-haze-500 hover:bg-white/5 hover:text-haze-100"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** What each side carries for one measured field, read off the top cue. */
export function capabilityValue(key: string, sheet: CueSheet): string {
  const top = sheet.cues[0];
  if (!top) return "—";
  switch (key) {
    case "affinity":
      return top.affinity.toFixed(3);
    case "audienceFit": {
      const cohorts = Object.keys(top.audienceFit ?? {});
      return cohorts.length > 0 ? cohorts.join(", ").replace(/_/g, " ") : "—";
    }
    case "momentum":
      return top.momentum > 0 ? "rising" : top.momentum < 0 ? "cooling" : "steady";
    case "explainability":
      return `${top.explainability.length} signal${top.explainability.length === 1 ? "" : "s"}`;
    case "clearance":
      return top.clearance.replace(/_/g, " ");
    case "image":
      return top.image ? "present" : "—";
    default:
      return "—";
  }
}

/**
 * What the results column shows when the reader switches Qloo off.
 *
 * This is deliberately not a blank page or a greyed-out copy of the grounded
 * sheet. It is the model's own answer, rendered with the same care, plus an
 * explicit account of the measured panels that are no longer available. The
 * point of the counterfactual is that the off-state is a real, usable answer —
 * it is simply a worse-informed one, and saying so is the demonstration.
 */
export function UngroundedResult({ sheet }: { sheet: CueSheet }) {
  const comparison = sheet.grounding;
  const baseline = sheet.baseline;
  const ungroundedIsModel = comparison?.ungroundedSource === "llm";

  return (
    <div className="space-y-4">
      <div className="panel border-white/10 bg-white/[0.02] p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-haze-500">
          Qloo is switched off
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-haze-300">
          {ungroundedIsModel ? (
            <>
              This is the model&rsquo;s answer from general knowledge alone. It reads well and it
              names real songs — but it carries no affinity, no audience measurement, no
              momentum and no clearance read, because those are measurements and the model has
              no instrument for them. Turn Qloo back on to see the grounded sheet.
            </>
          ) : (
            <>
              The model did not return an answer for this scene, so what follows is a fixed
              sample of the ungrounded answer rather than this run&rsquo;s model output. It stands
              in for the same thing: an answer with no affinity, no audience measurement, no
              momentum and no clearance read, because those are measurements and no text-only
              answer has an instrument for them. Turn Qloo back on to see the grounded sheet.
            </>
          )}
        </p>
      </div>

      <section className="panel p-5" aria-label="Ungrounded answer">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xl text-haze-100">
            {ungroundedIsModel ? "The model\u2019s answer" : "A fixed ungrounded sample"}
            <span className="ml-2 font-mono text-sm text-haze-500">
              {baseline.cues.length} options
            </span>
          </h2>
          <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] uppercase tracking-wider text-haze-500">
            {ungroundedIsModel ? "no cultural data" : "fixed sample"}
          </span>
        </div>

        {baseline.cues.length === 0 ? (
          <p className="text-sm text-haze-500">
            No ungrounded answer is available for this scene, so there is nothing to show in
            this column.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {baseline.cues.map((cue, index) => (
              <article key={index} className="panel p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm text-haze-100">
                    {cue.artist}
                    {cue.track ? (
                      <span className="text-haze-500"> — &ldquo;{cue.track}&rdquo;</span>
                    ) : null}
                  </p>
                  <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[11px] text-haze-500">
                    no score
                  </span>
                </div>
                {cue.why ? (
                  <p className="mt-2 text-xs leading-relaxed text-haze-500">{cue.why}</p>
                ) : null}
                <p className="mt-3 rounded-lg border border-white/5 bg-black/20 p-2.5 text-[11px] leading-relaxed text-haze-500">
                  No affinity, audience fit, momentum or clearance can be shown for this
                  pick — it was written, not measured.
                </p>
              </article>
            ))}
          </div>
        )}

        <p className="mt-4 rounded-lg border border-white/5 bg-black/20 p-3 text-xs leading-relaxed text-haze-500">
          {baseline.note}
        </p>
      </section>

      <div className="panel p-4">
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-haze-500">
          Panels unavailable with Qloo off
        </h3>
        <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-haze-500">
          {[
            "Cue sheet ranked by measured affinity",
            "Audience fit and trend momentum",
            "Cross-domain taste map (brands, destinations, podcasts)",
            "Comparable films, TV and books",
            "Casting and market fit",
            "Clearance readiness and licensing quotes",
          ].map((item) => (
            <li key={item} className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-haze-700" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-white/5 pt-3 text-xs leading-relaxed text-haze-300">
          Each of these is a Qloo measurement. With the taste graph off, there is nothing
          behind them to show, so Cue says so rather than filling the space with guesses.
        </p>
      </div>
    </div>
  );
}

export function CounterfactualPanel({ sheet }: { sheet: CueSheet }) {
  const comparison = sheet.grounding;
  if (!comparison) return null;

  const lost = new Set(comparison.capabilitiesLost);

  return (
    <section
      id="counterfactual"
      className="panel grain relative overflow-hidden scroll-mt-20 p-5"
      aria-label="What Qloo changes"
    >
      <div className="relative z-10">
        <header>
          <h2 className="font-display text-xl text-haze-100">What Qloo changes</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-haze-500">
            The hackathon asks whether a project works the same without the taste graph.
            Use the switch above to take it away and watch the same scene fall back to an
            ungrounded guess. Both answers come from this one run.
          </p>
        </header>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[38rem] border-collapse text-left text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-haze-500">
                <th className="pb-2 pr-3 font-medium">Field</th>
                <th className="pb-2 pr-3 font-medium">With Qloo</th>
                <th className="pb-2 pr-3 font-medium">Without Qloo</th>
                <th className="pb-2 font-medium">Why it cannot exist without Qloo</th>
              </tr>
            </thead>
            <tbody>
              {GROUNDED_CAPABILITIES.map((capability) => {
                const demonstrated = lost.has(capability.key);
                return (
                  <tr key={capability.key} className="border-t border-white/5">
                    <td className="py-2 pr-3 text-haze-300">{capability.label}</td>
                    <td className="py-2 pr-3 font-mono text-ember-400">
                      {demonstrated ? capabilityValue(capability.key, sheet) : "—"}
                    </td>
                    <td className="py-2 pr-3 font-mono text-haze-500">—</td>
                    <td className="py-2 leading-relaxed text-haze-500">{capability.because}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-3 border-t border-white/5 pt-3 text-xs leading-relaxed text-haze-300">
          {comparison.verdict}
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-haze-500">
          This panel makes no claim about which answer is creatively better. It shows that the
          two answers differ, and that one of them arrives with measurements the other
          structurally cannot carry.
        </p>
      </div>
    </section>
  );
}
