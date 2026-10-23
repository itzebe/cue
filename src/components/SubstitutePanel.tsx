"use client";

import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CueSheet } from "@/lib/types";
import type { SubstitutionResult, SubstitutionReason } from "@/lib/substitute";

/**
 * The substitution panel.
 *
 * This is the moment the product stops being a recommendation engine and starts
 * being a decision. A ranked sheet can say what the scene wants; it cannot say
 * what to do when the answer costs more than the budget, or when the label says
 * no. Every supervisor solves that today by phone and instinct. This solves it
 * with the same taste graph that produced the ranking.
 *
 * The panel is built around one sentence: this artist keeps N% of the audience
 * fit for $X instead of $Y. Everything else on screen is the evidence for it.
 *
 * It runs on demand because it costs several Qloo calls, and it shows the target
 * next to the recommendation rather than replacing it — the supervisor needs to
 * see what they are giving up, not just what they are getting.
 */
export function SubstitutePanel({
  sheet,
  budgetInputRef,
}: {
  sheet: CueSheet;
  /** Lets the top cue card send focus to the budget field it opens. */
  budgetInputRef?: RefObject<HTMLInputElement>;
}) {
  const target = sheet.cues.find((cue) => !cue.discovery && cue.artistId) ?? sheet.cues[0];
  const [result, setResult] = useState<SubstitutionResult | null>(null);
  const [budget, setBudget] = useState("");
  const [reason, setReason] = useState<SubstitutionReason>("budget");
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  // Each run claims a sequence number. A response is only applied if it belongs
  // to the newest run, so a slow first search cannot overwrite a faster second
  // one and leave the panel describing an artist the user already moved past.
  const runId = useRef(0);

  const run = useCallback(async () => {
    if (!target) return;
    const id = ++runId.current;
    setStatus("running");
    setError(null);
    try {
      const parsed = Number(budget.replace(/[^0-9]/g, ""));
      const response = await fetch("/api/substitute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: sheet.brief,
          cue: target,
          budget: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
          reason,
        }),
      });
      const data = await response.json();
      if (id !== runId.current) return;
      if (!response.ok) throw new Error(data.error ?? "Substitution failed.");
      setResult(data as SubstitutionResult);
      setStatus("idle");
    } catch (caught) {
      if (id !== runId.current) return;
      setError(caught instanceof Error ? caught.message : "Substitution failed.");
      setStatus("error");
    }
  }, [budget, reason, sheet.brief, target]);

  if (!target || !target.artistId) return null;

  const money = (value: number) => `$${value.toLocaleString("en-US")}`;

  return (
    <section className="panel grain relative overflow-hidden p-5" aria-label="Substitution">
      <div className="relative z-10">
        <header>
          <h2 className="font-display text-xl text-haze-100">
            When the best pick is the one you cannot have
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-haze-500">
            The sheet above ranks by what the scene needs. This answers the next question: the top
            pick is too expensive, or the label refused. Cue searches the taste graph for artists
            the same audience already loves, inside your budget, and shows what each one gives up.
            A language model cannot do this — it knows two artists sound alike, not that the same
            people love both.
          </p>
        </header>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/20 px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-haze-500">Replacing</span>
            <span className="text-xs text-haze-100">{target.artist}</span>
          </div>
          <label className="flex items-center gap-2 rounded-md border border-white/10 bg-black/30 px-3 py-1.5 focus-within:border-ember-500/40">
            <span className="text-[10px] uppercase tracking-wider text-haze-500">Budget</span>
            <span className="text-xs text-haze-500">$</span>
            <input
              ref={budgetInputRef}
              value={budget}
              onChange={(event) => setBudget(event.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              aria-label="Budget in dollars"
              placeholder="2500"
              className="w-20 bg-transparent text-xs text-haze-100 placeholder:text-haze-700 focus:outline-none"
            />
          </label>
          <select
            value={reason}
            onChange={(event) => setReason(event.target.value as SubstitutionReason)}
            aria-label="Reason for substitution"
            className="rounded-md border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-haze-100 focus:border-ember-500/40"
          >
            <option value="budget">Budget</option>
            <option value="clearance">Clearance too slow</option>
            <option value="exclusivity">Unavailable</option>
          </select>
          <button
            type="button"
            onClick={run}
            disabled={status === "running"}
            className="rounded-md border border-ember-500/40 bg-ember-500/10 px-3 py-2 text-xs text-ember-400 transition hover:bg-ember-500/20 disabled:opacity-50 sm:py-1.5"
          >
            {status === "running" ? "Searching the taste graph…" : "Find a substitute"}
          </button>
        </div>

        {error ? (
          <p className="mt-3 rounded-lg border border-ember-500/30 bg-ember-500/10 p-3 text-xs text-ember-400">
            {error}
          </p>
        ) : null}

        {result ? (
          <div className="mt-5">
            <p className="text-xs leading-relaxed text-haze-300">{result.reason}</p>

            {result.pick ? (
              <>
                {/* The headline. Everything else on this panel is evidence. */}
                <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-stretch">
                  <div className="rounded-lg border border-white/10 bg-black/20 p-4">
                    <p className="text-[10px] uppercase tracking-wider text-haze-500">
                      The pick you wanted
                    </p>
                    <p className="mt-1 break-words text-sm text-haze-100">{result.target.artist}</p>
                    <p className="mt-0.5 break-words text-[11px] text-haze-500">
                      {result.target.track}
                    </p>
                    <p className="mt-3 font-mono text-lg text-haze-300">
                      {money(result.target.fee.recommended)}
                    </p>
                    <p className="mt-1 text-[10px] text-haze-500">
                      affinity {result.target.affinity.toFixed(3)} · popularity{" "}
                      {result.target.popularity.toFixed(2)}
                    </p>
                  </div>

                  <div className="flex items-center justify-center">
                    <span className="rounded-full border border-ember-500/30 bg-ember-500/10 px-3 py-1 text-center text-[10px] uppercase tracking-wider text-ember-400">
                      {result.pick.audienceOverlap !== undefined
                        ? `shares ${Math.round(result.pick.audienceOverlap * 100)}% of the audience`
                        : "overlap unmeasured"}
                    </span>
                  </div>

                  <div className="rounded-lg border border-ember-500/30 bg-ember-500/[0.07] p-4">
                    <p className="text-[10px] uppercase tracking-wider text-ember-400">
                      The substitute
                    </p>
                    <p className="mt-1 break-words text-sm text-haze-100">{result.pick.artist}</p>
                    <p className="mt-0.5 break-words text-[11px] text-haze-500">
                      {result.pick.trackUnverified
                        ? "Track TBD — pick from this artist's catalogue"
                        : result.pick.track}
                    </p>
                    <p className="mt-3 font-mono text-lg text-signal-400">
                      {money(result.pick.fee.recommended)}
                    </p>
                    <p className="mt-1 text-[10px] text-haze-500">
                      affinity {result.pick.affinity.toFixed(3)} · popularity{" "}
                      {result.pick.popularity.toFixed(2)} · clears in ~
                      {result.pick.clearanceDays}d
                    </p>
                  </div>
                </div>

                <div className="mt-3 rounded-lg border border-signal-500/25 bg-signal-500/[0.06] p-3">
                  <p className="text-sm text-haze-100">{result.summary}</p>
                  {result.pick.audienceOverlap !== undefined ? (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-haze-400">
                      Qloo measures{" "}
                      <span className="font-mono text-signal-400">
                        {Math.round(result.pick.audienceOverlap * 100)}%
                      </span>{" "}
                      taste overlap between {result.target.artist} and {result.pick.artist}. That is
                      the claim being made: not that they sound alike, but that the same audience
                      loves both.
                    </p>
                  ) : null}
                  {result.pick.sharedTaste.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {result.pick.sharedTaste.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-[10px] text-haze-400"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="mt-4 rounded-lg border border-white/10 bg-black/20 p-4 text-xs leading-relaxed text-haze-300">
                {result.summary}
              </p>
            )}

            {result.bestValue ? (
              <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3">
                <p className="text-[10px] uppercase tracking-wider text-haze-500">
                  Or give up almost nothing and save more
                </p>
                <p className="mt-1 text-xs leading-relaxed text-haze-300">
                  <span className="text-haze-100">{result.bestValue.artist}</span> shares{" "}
                  {Math.round((result.bestValue.audienceOverlap ?? 0) * 100)}% of the audience for{" "}
                  <span className="font-mono text-signal-400">
                    {money(result.bestValue.fee.recommended)}
                  </span>{" "}
                  — a saving of{" "}
                  <span className="text-haze-100">{money(result.bestValue.savings)}</span> against{" "}
                  {result.target.artist}.
                </p>
              </div>
            ) : null}

            {result.options.length > 1 ? (
              <details className="mt-3 group">
                <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-haze-500 transition hover:text-haze-300">
                  The full frontier ({result.options.length} options) · budget implies popularity ≤{" "}
                  {result.popularityCeiling.toFixed(2)}
                </summary>
                <ul className="mt-2 space-y-1">
                  {result.options.map((option) => (
                    <li
                      key={option.id}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded border border-white/5 bg-black/20 px-3 py-1.5 text-[11px]"
                    >
                      <span className="min-w-0 flex-1 break-words text-haze-200">
                        {option.artist}
                      </span>
                      <span className="font-mono text-haze-500">
                        {option.audienceOverlap !== undefined
                          ? `${Math.round(option.audienceOverlap * 100)}% shared`
                          : "unmeasured"}
                      </span>
                      <span className="font-mono text-haze-600">
                        aff {option.affinity.toFixed(2)}
                      </span>
                      <span className="font-mono text-haze-400">{money(option.fee.recommended)}</span>
                      {option.dominated ? (
                        <span className="text-[9px] uppercase tracking-wider text-haze-600">
                          beaten
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {result.warnings.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {result.warnings.map((warning) => (
                  <li key={warning} className="text-[11px] leading-relaxed text-ember-400/90">
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="mt-3 border-t border-white/5 pt-3 text-[10px] leading-relaxed text-haze-600">
              Fees are estimates from Cue&rsquo;s model, not quotes. Affinity, popularity and taste
              overlap are measured by Qloo. Confirm splits and re-use terms with the rights holders.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
