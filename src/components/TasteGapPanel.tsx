import type { CueSheet } from "@/lib/types";
import {
  COVERAGE_LABEL,
  MIN_TAG_SUPPORT,
  type CoverageEntity,
  type TasteCoverage,
} from "@/lib/coverage";

/**
 * The Taste Gap.
 *
 * The cue sheet answers "what should play, ranked by affinity". Every pick in it
 * is defensible on its own, and that is exactly the trap: eight individually
 * strong picks can still all serve the same corner of an audience. This panel
 * asks the question the ranking cannot answer about itself — how much of the
 * brief's taste space does this slate actually reach, and what would reach more.
 *
 * The three questions a reader should be able to answer in seconds, in order:
 *   1. What is missing or concentrated?  -> the index, the redundancy, the gaps
 *   2. What evidence supports that?      -> the shared taste tags, named pairs
 *   3. What better alternatives exist?   -> the revised slate, measured the same way
 *
 * Honesty rules this panel is built around, because a coverage score is easy to
 * overstate:
 *   - The number is called an index, never a share, a percentage of listeners or
 *     population coverage. The denominator is the union of tags across the
 *     candidates Qloo returned for this brief, nothing wider.
 *   - Improvement is only shown as improvement. `revised.improves` is false when
 *     the metric did not rise, and the copy says the original stands.
 *   - When the evidence cannot support a number, the panel shows the limitation
 *     instead of a zero. A fabricated zero would read as "this reaches nothing".
 *   - The model wrote none of this. Every tag and every entity below came back
 *     from Qloo on the affinity call the cue sheet already depends on.
 */

function pct(value: number): string {
  return `${value.toFixed(1)}%`;
}

/** A single measured entity, with its affinity shown only when it is real. */
function EntityRow({ entity, rank }: { entity: CoverageEntity; rank: number }) {
  // A backfill pick came from a different Qloo call, so its affinity is not on
  // the same scale as the ranking. Showing it beside the others would invite a
  // comparison the data does not support.
  const showAffinity = !entity.backfill && entity.affinitySource === "query";

  return (
    <li className="flex items-baseline gap-3 py-1.5">
      <span className="w-4 shrink-0 font-mono text-[10px] tabular-nums text-haze-700">
        {rank + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-haze-100" title={entity.name}>
        {entity.name}
      </span>
      {entity.backfill ? (
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-haze-500">
          discovery
        </span>
      ) : showAffinity ? (
        <span
          className="shrink-0 font-mono text-[11px] tabular-nums text-haze-500"
          title="Qloo affinity for this brief, 0–1 within this query"
        >
          {entity.affinity.toFixed(2)}
        </span>
      ) : (
        <span
          className="shrink-0 text-[10px] uppercase tracking-wider text-haze-500"
          title="Qloo returned no affinity for this entity, so it is ranked on popularity"
        >
          popularity
        </span>
      )}
    </li>
  );
}

/** The coverage meter: original fill, the gain, and what stays unreached. */
function CoverageMeter({
  original,
  revised,
  improves,
}: {
  original: TasteCoverage;
  revised: TasteCoverage;
  improves: boolean;
}) {
  const base = Math.max(0, Math.min(100, original.index));
  const gain = improves ? Math.max(0, Math.min(100 - base, revised.index - original.index)) : 0;
  const open = Math.max(0, 100 - base - gain);

  return (
    <div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-white/5"
        role="img"
        aria-label={`${COVERAGE_LABEL}: ${pct(original.index)} in the original slate${
          improves ? `, ${pct(revised.index)} in the revised slate` : ""
        }`}
      >
        <div className="h-full bg-ember-500" style={{ width: `${base}%` }} />
        {gain > 0 ? (
          <div className="h-full bg-signal-400" style={{ width: `${gain}%` }} />
        ) : null}
        <div className="h-full" style={{ width: `${open}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] uppercase tracking-wider text-haze-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-ember-500" aria-hidden />
          Original slate
        </span>
        {gain > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-signal-400" aria-hidden />
            Gained by revision
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-white/15" aria-hidden />
          Not reached
        </span>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "up" | "flat";
}) {
  const valueTone =
    tone === "up" ? "text-signal-400" : tone === "flat" ? "text-haze-300" : "text-haze-100";
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-haze-500">{label}</div>
      <div className={`mt-1 font-display text-2xl leading-none tabular-nums ${valueTone}`}>
        {value}
      </div>
      {hint ? <div className="mt-1 text-[11px] leading-snug text-haze-500">{hint}</div> : null}
    </div>
  );
}

export function TasteGapPanel({ sheet }: { sheet: CueSheet }) {
  const gap = sheet.tasteGap;

  // No measurement was attempted or the field is absent (fixture sheets, or a
  // pipeline that never reached the affinity stage). Render nothing rather than
  // an empty frame with no explanation.
  if (!gap) return null;

  const { original, revised, originalEntities, unavailableReason } = gap;

  if (unavailableReason) {
    return (
      <section
        id="taste-gap"
        className="panel grain relative scroll-mt-20 overflow-hidden p-5"
        aria-label="The Taste Gap"
      >
        <div className="relative z-10">
          <header>
            <h2 className="font-display text-xl text-haze-100">The Taste Gap</h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-haze-500">
              How much of this brief&rsquo;s taste space the slate reaches, and what would reach
              more.
            </p>
          </header>
          <p className="mt-4 max-w-2xl rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 text-xs leading-relaxed text-haze-300">
            <span className="mr-1.5 font-medium text-haze-100">Not measured.</span>
            {unavailableReason}
          </p>
        </div>
      </section>
    );
  }

  const improves = revised.improves;
  const topGaps = original.gaps.slice(0, 6);
  const redundancyPct = original.redundancy * 100;

  return (
    <section
      id="taste-gap"
      className="panel grain relative scroll-mt-20 overflow-hidden p-5"
      aria-label="The Taste Gap"
    >
      <div className="relative z-10">
        <header>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="font-display text-xl text-haze-100">The Taste Gap</h2>
            <span className="text-[10px] uppercase tracking-wider text-haze-500">
              Measured on {original.poolSize} Qloo candidates
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-haze-500">
            Each pick in a cue sheet can be right on its own while the slate as a whole still
            circles the same corner of the audience. This measures how much of the brief&rsquo;s
            shared taste space the slate reaches, and what a different arrangement would reach.
          </p>
        </header>

        {/* 1. What is missing or concentrated */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label={COVERAGE_LABEL}
            value={pct(original.index)}
            hint={`${original.coveredTags} of ${original.vocabularySize} shared tags`}
          />
          <Stat
            label="After revision"
            value={pct(revised.coverage.index)}
            hint={
              improves
                ? `${revised.indexDelta >= 0 ? "+" : ""}${revised.indexDelta.toFixed(1)} points`
                : "unchanged — no better arrangement found"
            }
            tone={improves ? "up" : "flat"}
          />
          <Stat
            label="Concentration"
            value={pct(redundancyPct)}
            hint="mean tag overlap between any two picks"
          />
          <Stat
            label="Tags not reached"
            value={String(original.gaps.length)}
            hint="by the original slate, but reachable from this pool"
          />
        </div>

        <div className="mt-5">
          <CoverageMeter original={original} revised={revised.coverage} improves={improves} />
        </div>

        {/* 3. What better alternatives exist — and 2. the evidence for both */}
        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
              Original slate — as ranked
            </h3>
            <ol className="mt-2 divide-y divide-white/5">
              {originalEntities.map((entity, index) => (
                <EntityRow key={entity.entityId} entity={entity} rank={index} />
              ))}
            </ol>
          </div>
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
              Revised slate — same brief, more of its taste space
            </h3>
            <ol className="mt-2 divide-y divide-white/5">
              {revised.entities.map((entity, index) => (
                <EntityRow key={entity.entityId} entity={entity} rank={index} />
              ))}
            </ol>
          </div>
        </div>

        <p className="mt-4 max-w-3xl text-xs leading-relaxed text-haze-300">
          {revised.rationale}
        </p>

        {/* 2. What the conclusion rests on */}
        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
              Where the slate concentrates
            </h3>
            {original.mostSimilarPair ? (
              <p className="mt-2 text-xs leading-relaxed text-haze-300">
                <span className="text-haze-100">
                  {original.mostSimilarPair.a} and {original.mostSimilarPair.b}
                </span>{" "}
                share {pct(original.mostSimilarPair.overlap * 100)} of their shared-vocabulary
                taste tags. Qloo measures them as landing with substantially the same audience, so
                both occupy one slot&rsquo;s worth of reach rather than two.
              </p>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-haze-500">
                No pair of picks shares a measurable set of taste tags.
              </p>
            )}
          </div>
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
              Taste the pool reaches that the slate does not
            </h3>
            {topGaps.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {topGaps.map((item) => (
                  <li
                    key={item.tag}
                    className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-haze-300"
                    title={`Reachable via ${item.reachableBy.join(", ")}`}
                  >
                    {item.tag}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-haze-300">
                The slate already carries every shared tag in this pool.
              </p>
            )}
          </div>
        </div>

        {/* 4. What the data cannot establish */}
        <div className="mt-6 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
          <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
            What this measures, and what it does not
          </h3>
          <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-haze-500">
            <li>
              The {COVERAGE_LABEL.toLowerCase()} is an internal index. Its denominator is the{" "}
              {original.vocabularySize} tags shared by at least {MIN_TAG_SUPPORT} of the{" "}
              {original.poolSize} candidates Qloo returned for this brief — not listeners, not a
              share of any population, and not generalisable beyond this pool.
            </li>
            <li>
              Every tag and entity here came back from Qloo on the affinity call the cue sheet
              already uses. No extra request was made to produce this panel, and no part of it was
              written by a language model.
            </li>
            <li>
              A higher index means the slate covers more of the taste tags present in this
              candidate pool. It does not mean a larger audience, and it is not a measure of
              cultural quality — only of spread across what Qloo measured.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
