import type { CueSheet } from "@/lib/types";

/**
 * The Audience Identity Brief.
 *
 * Qloo measures who an entity's audience is; an LLM can only guess. This panel
 * puts that measurement in the reader's hands before any recommendation is shown,
 * because the hackathon's central question is whether cultural data changes the
 * answer — and that is easier to believe when you can read the evidence first.
 *
 * The layout enforces an honesty rule that is easy to break in a card grid: Qloo's
 * own prose is quoted and attributed, and Cue's reading of it is visually separate
 * and labelled. Nothing here is written by Cue and passed off as Qloo's, and
 * nothing is shown at all when Qloo returned no description.
 */
export function AudienceBriefPanel({ sheet }: { sheet: CueSheet }) {
  const brief = sheet.audienceBrief;
  if (!brief) return null;

  const hasEvidence = brief.available && brief.evidence.length > 0;

  return (
    <section className="panel grain relative overflow-hidden p-5" aria-label="Audience identity brief">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h2 className="font-display text-xl text-haze-100">Who this is for</h2>
        <p className="text-xs text-haze-500">
          {hasEvidence
            ? "Qloo's own description of each anchor's audience."
            : "No audience description was available for this brief."}
        </p>
      </header>

      {hasEvidence ? (
        <>
          <ul className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {brief.evidence.map((entry) => (
              <li
                key={entry.entityId}
                className="rounded-lg border border-white/5 bg-black/20 p-4"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <p className="text-sm font-medium text-haze-100">{entry.anchor}</p>
                  <p className="text-[10px] text-haze-500">
                    resolved to {entry.entityName}
                    {entry.entityType ? ` · ${entry.entityType.replace("urn:entity:", "")}` : ""}
                  </p>
                </div>
                {/* Quoted verbatim and attributed. The border-l is the visual
                    signal that this is source material, not Cue's summary. */}
                <blockquote className="mt-2 border-l-2 border-signal-500/40 pl-3 text-sm leading-relaxed text-haze-300">
                  {entry.audienceIdentity}
                </blockquote>
                <p className="mt-2 text-[10px] uppercase tracking-wider text-haze-500">
                  Source: Qloo audience_identity
                </p>
              </li>
            ))}
          </ul>

          {brief.interpretation ? (
            <div className="mt-4 rounded-lg border border-ember-500/20 bg-ember-500/5 p-4">
              <p className="text-[10px] uppercase tracking-wider text-ember-400">
                Cue&rsquo;s reading
              </p>
              <p className="mt-1 text-sm leading-relaxed text-haze-300">
                {brief.interpretation}
              </p>
            </div>
          ) : null}

          <p className="mt-3 text-[11px] leading-relaxed text-haze-500">
            Qloo&rsquo;s description is a qualitative read of an audience cluster, not a
            validated demographic profile. Cue does not infer age, gender or spending
            power from it, and the anchors&rsquo; audiences are not additive.
          </p>
        </>
      ) : (
        <p className="mt-4 text-sm leading-relaxed text-haze-300">
          {brief.noAnchors
            ? "This brief names no film, show or artist, so there is no anchor to measure an audience from. Add a named reference and Qloo's audience description appears here."
            : brief.anchorsWithoutEvidence.length > 0
              ? `Qloo returned entities for ${formatList(brief.anchorsWithoutEvidence)} but no audience description for ${brief.anchorsWithoutEvidence.length > 1 ? "them" : "it"}. Cue shows nothing rather than inventing a profile.`
              : "No anchor in this brief resolved to a Qloo entity, so there is no audience to describe."}
        </p>
      )}

      {brief.anchorsUnresolved.length > 0 && hasEvidence ? (
        <p className="mt-3 text-[11px] text-haze-500">
          Not measured: {formatList(brief.anchorsUnresolved)} did not resolve to a Qloo
          entity.
        </p>
      ) : null}
    </section>
  );
}

function formatList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
