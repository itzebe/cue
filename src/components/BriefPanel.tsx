"use client";

import type { CueSheet } from "@/lib/types";

/** The agent's structured read of the scene, so the reasoning is auditable. */
export function BriefPanel({ sheet }: { sheet: CueSheet }) {
  const { brief } = sheet;

  const rows: Array<{ label: string; value: string }> = [
    { label: "Mood", value: brief.mood.join(", ") || "—" },
    { label: "Genre read", value: brief.genre.join(", ") || "—" },
    { label: "Era", value: brief.era || "—" },
    { label: "Setting", value: brief.setting || "—" },
    { label: "Emotional arc", value: brief.arc || "—" },
    {
      label: "Audience",
      value:
        [brief.audience.age?.replace(/_/g, " "), brief.audience.gender]
          .filter(Boolean)
          .join(" · ") || "not specified",
    },
    { label: "Market", value: brief.region || "not specified" },
    { label: "Music is diegetic", value: brief.diegetic ? "yes — heard in-world" : "no — scoring" },
  ];

  return (
    <section className="panel grain relative overflow-hidden p-5" aria-label="Scene brief">
      <div className="relative z-10">
        <header>
          <h3 className="font-display text-base text-haze-100">The agent's read</h3>
          <p className="mt-0.5 text-xs text-haze-500">
            What Cue understood before it asked Qloo anything.
          </p>
        </header>

        <dl className="mt-4 space-y-2.5">
          {rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[110px_1fr] gap-3 text-sm">
              <dt className="text-[11px] uppercase tracking-wider text-haze-500">
                {row.label}
              </dt>
              <dd className="text-haze-300">{row.value}</dd>
            </div>
          ))}
        </dl>

        {brief.anchors.length > 0 ? (
          <div className="mt-4 border-t border-white/5 pt-3">
            <h4 className="text-[11px] uppercase tracking-wider text-haze-500">
              Resolved as Qloo signal entities
            </h4>
            <div className="mt-2 flex flex-wrap gap-2">
              {brief.anchors.map((anchor) => (
                <span
                  key={anchor}
                  className="rounded-full border border-signal-500/25 bg-signal-500/10 px-2.5 py-1 text-[11px] text-signal-300"
                >
                  {anchor}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
