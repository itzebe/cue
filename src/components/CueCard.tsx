"use client";

import type { Cue } from "@/lib/types";

const PLACEMENT_LABEL: Record<Cue["placement"], string> = {
  needle_drop: "Needle drop",
  score_bed: "Score bed",
  transition: "Transition",
  title_card: "Title card",
};

const CLEARANCE_LABEL: Record<Cue["clearance"], { text: string; className: string }> = {
  indie_friendly: {
    text: "Indie-friendly",
    className: "text-signal-400 border-signal-500/30 bg-signal-500/10",
  },
  major_label: {
    text: "Major label",
    className: "text-ember-400 border-ember-500/30 bg-ember-500/10",
  },
  unknown: {
    text: "Clearance TBC",
    className: "text-haze-300 border-white/10 bg-white/5",
  },
};

function MomentumGlyph({ momentum }: { momentum: number }) {
  if (momentum > 0) {
    return (
      <span className="text-signal-400" title="Climbing Qloo population rank">
        ▲ rising
      </span>
    );
  }
  if (momentum < 0) {
    return (
      <span className="text-haze-500" title="Falling Qloo population rank">
        ▼ cooling
      </span>
    );
  }
  return (
    <span className="text-haze-500" title="Steady Qloo population rank">
      ● steady
    </span>
  );
}

export function CueCard({
  cue,
  rank,
  maxAffinity,
  trackPendingHint,
}: {
  cue: Cue;
  rank: number;
  maxAffinity: number;
  /** Why no track was named, so the card never blames the wrong cause. */
  trackPendingHint?: string | null;
}) {
  const clearance = CLEARANCE_LABEL[cue.clearance];
  const width = maxAffinity > 0 ? Math.max(6, (cue.affinity / maxAffinity) * 100) : 0;

  return (
    <article
      className="panel grain relative overflow-hidden p-5 animate-fade-up"
      style={{ animationDelay: `${rank * 70}ms` }}
      aria-label={`Cue ${rank + 1}: ${cue.artist}`}
    >
      <div className="relative z-10">
        <header className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 font-mono text-xs text-haze-300">
              {String(rank + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-lg leading-tight text-haze-100">
                {cue.artist}
              </h3>
              <p className="mt-0.5 text-sm text-haze-300">
                {cue.trackUnverified ? (
                  <span className="text-haze-500 italic">{cue.track}</span>
                ) : (
                  <>
                    <span className="text-ember-400">“{cue.track}”</span>
                    {cue.album ? <span className="text-haze-500"> · {cue.album}</span> : null}
                    {cue.year ? <span className="text-haze-500"> · {cue.year}</span> : null}
                  </>
                )}
              </p>
              {cue.trackUnverified && trackPendingHint ? (
                <p className="mt-1 text-[11px] leading-relaxed text-haze-500">
                  {trackPendingHint}
                </p>
              ) : null}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-xl leading-none text-haze-100">
              {cue.affinity.toFixed(3)}
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-wider text-haze-500">
              affinity
            </div>
          </div>
        </header>

        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
          <div
            className="h-full origin-left rounded-full bg-gradient-to-r from-ember-600 via-ember-500 to-ember-400 animate-bar-grow"
            style={{ width: `${width}%`, animationDelay: `${rank * 70 + 120}ms` }}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-haze-300">
            {PLACEMENT_LABEL[cue.placement]}
          </span>
          <span className={`rounded-full border px-2.5 py-1 ${clearance.className}`}>
            {clearance.text}
          </span>
          {cue.discovery ? (
            <span
              className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-violet-300"
              title="Surfaced by the cross-domain backfill query. Affinity is measured against a separate Qloo call, so it is not directly comparable to the primary picks above."
            >
              ◇ discovery
            </span>
          ) : null}
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
            <MomentumGlyph momentum={cue.momentum} />
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-haze-300">
            {Math.round(cue.confidence * 100)}% confidence
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-haze-500">
            popularity {cue.popularity.toFixed(2)}
          </span>
        </div>

        <section className="mt-4">
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-haze-500">
            Why Qloo ranked this
          </h4>
          <ul className="mt-2 space-y-1.5">
            {cue.why.map((reason, index) => (
              <li key={index} className="flex gap-2 text-sm leading-relaxed text-haze-300">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ember-500" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </section>

        {cue.explainability.length > 0 ? (
          <section className="mt-4 rounded-lg border border-white/5 bg-black/20 p-3">
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-haze-500">
              Signal contribution
            </h4>
            <div className="mt-2 space-y-2">
              {cue.explainability.slice(0, 3).map((entry) => (
                <div key={entry.entity_id} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-xs text-haze-300">
                    {entry.name || entry.entity_id}
                  </span>
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/5">
                    <span
                      className="block h-full origin-left rounded-full bg-signal-400/70 animate-bar-grow"
                      style={{ width: `${Math.round(entry.score * 100)}%` }}
                    />
                  </span>
                  <span className="w-9 shrink-0 text-right font-mono text-[10px] text-haze-500">
                    {Math.round(entry.score * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <p className="mt-3 text-xs leading-relaxed text-haze-500">
          <span className="text-haze-300">Clearance note:</span> {cue.risk}
        </p>
      </div>
    </article>
  );
}
