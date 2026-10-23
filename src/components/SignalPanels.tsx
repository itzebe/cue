"use client";

import type { CueSheet } from "@/lib/types";

/**
 * Two optional Qloo panels: the A/B creative-direction compare, and the
 * regional affinity read. Both only render when the underlying call returned
 * data, so the page never shows empty scaffolding.
 */
export function DirectionPanel({ sheet }: { sheet: CueSheet }) {
  if (!sheet.directionCompare) return null;
  const { aLabel, bLabel, shared, aOnly, bOnly, overlap, verdict } =
    sheet.directionCompare;

  return (
    <section className="panel grain relative overflow-hidden p-5" aria-label="Direction compare">
      <div className="relative z-10">
        <header>
          <h3 className="font-display text-base text-haze-100">
            Direction A/B · <code className="font-mono text-xs text-signal-300">/v2/analysis/compare</code>
          </h3>
          <p className="mt-0.5 text-xs text-haze-500">
            Qloo's answer to &ldquo;which creative direction holds the audience?&rdquo;
          </p>
        </header>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-white/5 bg-black/20 p-3">
            <h4 className="text-[10px] uppercase tracking-wider text-haze-500">Direction A</h4>
            <p className="mt-1 text-sm text-haze-300">{aLabel}</p>
          </div>
          <div className="rounded-lg border border-white/5 bg-black/20 p-3">
            <h4 className="text-[10px] uppercase tracking-wider text-haze-500">Direction B</h4>
            <p className="mt-1 text-sm text-haze-300">{bLabel}</p>
          </div>
        </div>

        <div className="mt-4 flex items-baseline gap-3">
          <span className="font-display text-2xl text-signal-300">
            {Math.round(overlap * 100)}%
          </span>
          <span className="text-xs text-haze-500">
            shared taste overlap · {shared.length} common tags
          </span>
        </div>

        <div className="mt-3">
          <h4 className="text-[10px] uppercase tracking-wider text-haze-500">
            Shared audience ({shared.length})
          </h4>
          <div className="mt-2 flex flex-wrap gap-2">
            {shared.slice(0, 12).map((name) => (
              <span
                key={name}
                className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-haze-300"
              >
                {name}
              </span>
            ))}
          </div>
        </div>

        {(aOnly.length > 0 || bOnly.length > 0) && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <h4 className="text-[10px] uppercase tracking-wider text-haze-500">
                Only A
              </h4>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {aOnly.slice(0, 6).map((name) => (
                  <span
                    key={name}
                    className="rounded-full border border-ember-500/20 bg-ember-500/5 px-2 py-0.5 text-[11px] text-ember-400/80"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <h4 className="text-[10px] uppercase tracking-wider text-haze-500">
                Only B
              </h4>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {bOnly.slice(0, 6).map((name) => (
                  <span
                    key={name}
                    className="rounded-full border border-signal-500/20 bg-signal-500/5 px-2 py-0.5 text-[11px] text-signal-300/80"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        <p className="mt-3 rounded-lg border border-signal-500/15 bg-signal-500/5 p-3 text-xs leading-relaxed text-haze-300">
          {verdict}
        </p>
      </div>
    </section>
  );
}

export function RegionPanel({ sheet }: { sheet: CueSheet }) {
  if (!sheet.regionAffinity?.length) return null;
  const max = Math.max(...sheet.regionAffinity.map((row) => row.affinity), 0.0001);

  return (
    <section className="panel grain relative overflow-hidden p-5" aria-label="Regional affinity">
      <div className="relative z-10">
        <header>
          <h3 className="font-display text-base text-haze-100">
            Market check ·{" "}
            <code className="font-mono text-xs text-signal-300">location-aware insights</code>
          </h3>
          <p className="mt-0.5 text-xs leading-relaxed text-haze-500">
            Artists measured with the location filter set to{" "}
            {sheet.brief.region ?? "the target market"}. Qloo returns the same ranking and the
            same scores as the unfiltered call — artist affinity is location-invariant on this
            API. The market genuinely changes what a campaign references, which is why Cue
            localises touchpoints rather than the soundtrack.
          </p>
        </header>
        <ul className="mt-4 space-y-2.5">
          {sheet.regionAffinity.map((row) => (
            <li key={row.name} className="flex items-center gap-3">
              <span className="w-32 shrink-0 truncate text-sm text-haze-300">{row.name}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                <span
                  className="block h-full origin-left rounded-full bg-gradient-to-r from-ember-600 to-ember-400 animate-bar-grow"
                  style={{ width: `${(row.affinity / max) * 100}%` }}
                />
              </span>
              <span className="w-10 shrink-0 text-right font-mono text-xs text-haze-500">
                {row.affinity.toFixed(3)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
