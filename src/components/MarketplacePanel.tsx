"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Cue, CueSheet } from "@/lib/types";
import { DEFAULT_TERMS, type LicenseTerms, type QuoteSummary } from "@/lib/rights";

const MEDIA_OPTIONS: Array<{ value: LicenseTerms["media"]; label: string }> = [
  { value: "all_media", label: "All media" },
  { value: "broadcast", label: "Broadcast" },
  { value: "streaming", label: "Streaming" },
  { value: "social", label: "Social" },
  { value: "festival", label: "Festival" },
];

const TERRITORY_OPTIONS: Array<{ value: LicenseTerms["territory"]; label: string }> = [
  { value: "worldwide", label: "Worldwide" },
  { value: "north_america", label: "North America" },
  { value: "europe", label: "Europe" },
  { value: "single_market", label: "Single market" },
];

const TERM_OPTIONS: Array<{ value: LicenseTerms["termYears"]; label: string }> = [
  { value: 1, label: "1 year" },
  { value: 3, label: "3 years" },
  { value: 10, label: "10 years" },
];

const DIFFICULTY_STYLE: Record<string, string> = {
  light: "text-signal-400 border-signal-500/30 bg-signal-500/10",
  moderate: "text-ember-400 border-ember-500/30 bg-ember-500/10",
  heavy: "text-ember-400 border-ember-500/40 bg-ember-500/15",
};

function money(value: number): string {
  return `$${value.toLocaleString("en-US")}`;
}

/**
 * The marketplace surface.
 *
 * This is the piece that turns Cue from a ranking tool into a transaction: a
 * supervisor picks the cues they want, sets the grant, and gets a priced
 * clearance request with the rights holders, the path to signature, and the
 * gating date for the campaign.
 */
export function MarketplacePanel({ sheet }: { sheet: CueSheet }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [terms, setTerms] = useState<LicenseTerms>(DEFAULT_TERMS);
  const [summary, setSummary] = useState<QuoteSummary | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const cues = sheet.cues;

  // Every basket or grant change fires a new price. Only the newest response may
  // be shown, or a slow earlier request can overwrite the current basket's total.
  const requestSeq = useRef(0);

  const price = useCallback(
    async (nextSelected: Set<string>, nextTerms: LicenseTerms) => {
      const chosen: Cue[] = cues.filter((cue) => nextSelected.has(cue.id));
      const seq = ++requestSeq.current;
      if (chosen.length === 0) {
        setSummary(null);
        setStatus("idle");
        return;
      }
      setStatus("running");
      setError(null);
      try {
        const response = await fetch("/api/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cues: chosen, terms: nextTerms }),
        });
        const data = await response.json();
        if (seq !== requestSeq.current) return;
        if (!response.ok) throw new Error(data.error ?? "Pricing failed.");
        setSummary(data as QuoteSummary);
        setStatus("idle");
      } catch (caught) {
        if (seq !== requestSeq.current) return;
        setError(caught instanceof Error ? caught.message : "Pricing failed.");
        setStatus("error");
      }
    },
    [cues],
  );

  // Re-price whenever the basket or the grant changes, so the buyer always sees
  // the number that matches the deal on screen.
  useEffect(() => {
    void price(selected, terms);
  }, [selected, terms, price]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectTop = (count: number) => {
    setSelected(new Set(cues.slice(0, count).map((cue) => cue.id)));
  };

  const selectedQuotes = summary?.quotes ?? [];

  return (
    <section className="panel grain relative overflow-hidden p-5" aria-label="Clearance marketplace">
      <div className="relative z-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-xl text-haze-100">Clearance desk</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-haze-500">
              Pick the cues you want to lock. Cue prices the grant from the same Qloo signals that
              ranked it, then lays out who has to sign and how long it takes.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => selectTop(3)}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-haze-300 transition hover:border-white/20 hover:text-haze-100 sm:py-1.5"
            >
              Top 3
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-haze-300 transition hover:border-white/20 hover:text-haze-100 sm:py-1.5"
            >
              Clear
            </button>
          </div>
        </header>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
          {/* Basket */}
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
              Cue sheet · {cues.length} options
            </h3>
            <ul className="mt-2 space-y-1.5">
              {cues.map((cue) => {
                const isSelected = selected.has(cue.id);
                return (
                  <li key={cue.id}>
                    <button
                      type="button"
                      onClick={() => toggle(cue.id)}
                      aria-pressed={isSelected}
                      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                        isSelected
                          ? "border-signal-500/40 bg-signal-500/10"
                          : "border-white/5 bg-black/20 hover:border-white/15"
                      }`}
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[9px] ${
                          isSelected
                            ? "border-signal-400 bg-signal-500/30 text-signal-300"
                            : "border-white/20 text-transparent"
                        }`}
                        aria-hidden="true"
                      >
                        ✓
                      </span>
                      <span className="min-w-0 flex-1 text-left">
                        {/* This list is what gets priced and licensed, so the
                            exact title has to stay readable rather than
                            truncated at narrow widths. */}
                        <span className="block break-words text-sm text-haze-100">{cue.artist}</span>
                        <span className="block break-words text-[11px] text-haze-500">
                          {cue.trackUnverified ? "Track TBD" : cue.track} ·{" "}
                          {cue.placement.replace(/_/g, " ")}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-xs text-haze-300">
                        {cue.affinity.toFixed(3)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Grant terms */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className="text-[10px] uppercase tracking-wider text-haze-500">The grant</h3>
              {status === "running" ? (
                <span
                  className="flex items-center gap-1.5 text-[10px] text-haze-400"
                  role="status"
                  aria-live="polite"
                >
                  <span className="h-1 w-1 animate-pulse-soft rounded-full bg-signal-400" />
                  Pricing…
                </span>
              ) : null}
            </div>

            <label className="block">
              <span className="block text-[11px] text-haze-300">Media</span>
              <select
                value={terms.media}
                onChange={(event) =>
                  setTerms({ ...terms, media: event.target.value as LicenseTerms["media"] })
                }
                className="mt-1 w-full rounded-md border border-white/10 bg-ink-850 px-2 py-1.5 text-xs text-haze-100"
              >
                {MEDIA_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-[11px] text-haze-300">Territory</span>
              <select
                value={terms.territory}
                onChange={(event) =>
                  setTerms({
                    ...terms,
                    territory: event.target.value as LicenseTerms["territory"],
                  })
                }
                className="mt-1 w-full rounded-md border border-white/10 bg-ink-850 px-2 py-1.5 text-xs text-haze-100"
              >
                {TERRITORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-[11px] text-haze-300">Term</span>
              <select
                value={terms.termYears}
                onChange={(event) =>
                  setTerms({
                    ...terms,
                    termYears: Number(event.target.value) as LicenseTerms["termYears"],
                  })
                }
                className="mt-1 w-full rounded-md border border-white/10 bg-ink-850 px-2 py-1.5 text-xs text-haze-100"
              >
                {TERM_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                checked={terms.exclusive}
                onChange={(event) => setTerms({ ...terms, exclusive: event.target.checked })}
                className="h-3.5 w-3.5 accent-[#12b76a]"
              />
              <span className="text-[11px] text-haze-300">Category exclusivity</span>
            </label>
          </div>
        </div>

        {error ? (
          <p className="mt-4 rounded-lg border border-ember-500/30 bg-ember-500/10 p-3 text-xs text-ember-400">
            {error}
          </p>
        ) : null}

        {/* Totals */}
        {summary && selectedQuotes.length > 0 ? (
          <div className="mt-5 border-t border-white/5 pt-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-haze-500">
                  Clearance budget
                </p>
                <p className="font-display text-2xl text-haze-100">
                  {money(summary.totalRecommended)}
                </p>
                <p className="text-[11px] text-haze-500">
                  across {selectedQuotes.length}{" "}
                  {selectedQuotes.length === 1 ? "cue" : "cues"}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-haze-500">Cue commission</p>
                <p className="font-display text-2xl text-signal-400">{money(summary.totalTake)}</p>
                <p className="text-[11px] text-haze-500">
                  {Math.round((summary.quotes[0]?.takeRate ?? 0) * 100)}% of cleared fees
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-haze-500">
                  Gating clearance
                </p>
                <p className="font-display text-2xl text-ember-400">{summary.gatingDays}d</p>
                <p className="text-[11px] text-haze-500">longest single path in the basket</p>
              </div>
            </div>

            <ul className="mt-5 space-y-3">
              {selectedQuotes.map((quote) => {
                const cue = cues.find((item) => item.id === quote.cueId);
                const difficulty = cue
                  ? quote.clearance.difficulty
                  : "moderate";
                return (
                  <li key={quote.cueId} className="rounded-lg border border-white/5 bg-black/20 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-haze-100">{quote.artist}</p>
                        <p className="truncate text-[11px] text-haze-500">
                          {cue?.trackUnverified ? "Track TBD" : quote.track}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-sm text-haze-100">
                          {money(quote.fee.recommended)}
                        </p>
                        <p className="font-mono text-[10px] text-haze-500">
                          {money(quote.fee.low)}–{money(quote.fee.high)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] ${
                          DIFFICULTY_STYLE[difficulty]
                        }`}
                      >
                        {difficulty} clearance · {quote.clearance.totalDays}d
                      </span>
                      <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-haze-300">
                        {quote.clearance.oneStop ? "one-stop" : "two negotiations"}
                      </span>
                      <span className="text-[10px] text-haze-500">
                        take {money(quote.takeAmount)}
                      </span>
                    </div>

                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-haze-400 hover:text-haze-100">
                        Rights holders and clearance path
                      </summary>
                      <div className="mt-2 space-y-2">
                        <ul className="space-y-1">
                          {quote.holders.map((holder) => (
                            <li key={holder.role} className="flex gap-2 text-[11px]">
                              <span className="w-20 shrink-0 uppercase tracking-wide text-haze-500">
                                {holder.role}
                              </span>
                              <span className="min-w-0 flex-1 text-haze-300">
                                {holder.party}
                                <span className="block text-[10px] text-haze-500">{holder.note}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                        <ol className="space-y-1">
                          {quote.clearance.steps.map((step, index) => (
                            <li key={step.step} className="flex gap-2 text-[11px]">
                              <span className="w-4 shrink-0 font-mono text-haze-500">
                                {index + 1}
                              </span>
                              <span className="min-w-0 flex-1 text-haze-300">
                                {step.step}
                                <span className="text-haze-500"> · {step.party}</span>
                              </span>
                              <span className="shrink-0 font-mono text-[10px] text-haze-500">
                                {step.days}d
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>

            <details className="mt-4">
              <summary className="cursor-pointer text-[11px] text-haze-400 hover:text-haze-100">
                How this price was derived
              </summary>
              <ul className="mt-2 space-y-1">
                {selectedQuotes[0]?.drivers.map((driver) => (
                  <li key={driver.label} className="flex gap-2 text-[11px]">
                    <span className="min-w-0 flex-1 text-haze-300">
                      {driver.label}
                      <span className="block text-[10px] text-haze-500">{driver.note}</span>
                    </span>
                    <span className="shrink-0 font-mono text-haze-500">
                      ×{driver.multiplier.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[10px] leading-relaxed text-haze-500">
                {selectedQuotes[0]?.disclaimer}
              </p>
            </details>
          </div>
        ) : (
          <p className="mt-5 border-t border-white/5 pt-4 text-xs text-haze-500">
            Select a cue to price a clearance request.
          </p>
        )}
      </div>
    </section>
  );
}
