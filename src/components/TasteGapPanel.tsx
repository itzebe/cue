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
 * The five things a reader should be able to get in about thirty seconds, in
 * order, which is also the order they are laid out:
 *   1. The brief being evaluated.
 *   2. The baseline: the original slate's measured coverage.
 *   3. The gap: which taste dimensions it does not reach.
 *   4. The intervention: what the revision changed.
 *   5. The result: the revised coverage and the dimensions it newly reaches.
 *
 * Honesty rules this panel is built around, because a coverage score is easy to
 * overstate:
 *   - The number is called an index, never a share, a percentage of listeners or
 *     population coverage. The denominator is the union of tags across the
 *     candidates Qloo returned for this brief, nothing wider.
 *   - The numerator and denominator are shown, not just the ratio, so a reader
 *     can check the arithmetic rather than trusting the headline.
 *   - The displayed delta is derived from the displayed endpoints, so
 *     "79.9% -> 95.8%, +15.9" reconciles instead of rounding to a third number.
 *   - Improvement is only shown as improvement. When the metric did not rise,
 *     the copy says the original stands.
 *   - When the evidence cannot support a number, the panel shows the limitation
 *     instead of a zero. A fabricated zero would read as "this reaches nothing".
 *   - Measured evidence and computed wording are labelled separately. The model
 *     wrote none of the numbers here; every tag and entity came back from Qloo
 *     on the affinity call the cue sheet already depends on.
 */

/** Round to the precision actually shown, so displayed arithmetic reconciles. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pct(value: number): string {
  return `${round1(value).toFixed(1)}%`;
}

/** Every tag id this pool can name, so covered dimensions read as words too. */
function nameMap(entities: CoverageEntity[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entity of entities) {
    for (const [id, name] of Object.entries(entity.tagNames)) {
      if (!map.has(id)) map.set(id, name);
    }
  }
  return map;
}

/**
 * The delta as displayed, derived from the displayed endpoints.
 *
 * Rounding the endpoints and the delta independently produced a row that did not
 * add up on screen (79.9 + 16.0 != 95.8). Deriving the delta from the rounded
 * endpoints means a reader checking the arithmetic is never misled.
 */
function shownDelta(original: TasteCoverage, revised: TasteCoverage): number {
  return round1(round1(revised.index) - round1(original.index));
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

/** A labelled tag chip, used for both reached and unreached dimensions. */
function DimensionChip({
  label,
  title,
  reached,
}: {
  label: string;
  title: string;
  reached: boolean;
}) {
  return (
    <li
      className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
        reached
          ? "border-signal-400/25 bg-signal-400/10 text-haze-100"
          : "border-white/10 bg-white/5 text-haze-300"
      }`}
      title={title}
    >
      {label}
    </li>
  );
}

/**
 * The audit headline: the thirty-second read, placed above the cue sheet so the
 * measurement opens the product rather than trailing it.
 *
 * Deliberately compact. On a phone this is the first thing below the brief, and
 * a tall decorative block would push the actual result off the first screen.
 */
export function TasteGapHeadline({ sheet }: { sheet: CueSheet }) {
  const gap = sheet.tasteGap;
  if (!gap) return null;

  const { original, revised, unavailableReason } = gap;
  const briefLabel = sheet.brief.title || sheet.brief.raw;

  if (unavailableReason) {
    return (
      <section id="audit" className="panel scroll-mt-20 p-4" aria-label="Taste Gap audit">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[10px] uppercase tracking-wider text-haze-500">
            Taste Gap audit
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-haze-300" title={briefLabel}>
            {briefLabel}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-haze-500">
          <span className="font-medium text-haze-300">Not measured. </span>
          {unavailableReason}
        </p>
      </section>
    );
  }

  const delta = shownDelta(original, revised.coverage);
  const improved = delta > 0;
  const newlyCovered = revised.newlyCovered.length;

  return (
    <section id="audit" className="panel scroll-mt-20 p-4" aria-label="Taste Gap audit">
      {/* 1. The brief being evaluated */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[10px] uppercase tracking-wider text-haze-500">
          Taste Gap audit
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-haze-300" title={briefLabel}>
          {briefLabel}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-haze-500">
          {original.poolSize} Qloo candidates
        </span>
      </div>

      {/* 2, 3, 5. Baseline -> result, with the gap named */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-3xl leading-none tabular-nums text-ember-400">
            {pct(original.index)}
          </span>
          <span className="text-[11px] text-haze-500">
            {original.coveredTags} of {original.vocabularySize} shared tags
          </span>
        </div>

        <span aria-hidden className="text-lg text-haze-700">
          →
        </span>

        <div className="flex items-baseline gap-2">
          <span
            className={`font-display text-3xl leading-none tabular-nums ${
              improved ? "text-signal-400" : "text-haze-300"
            }`}
          >
            {pct(revised.coverage.index)}
          </span>
          <span className="text-[11px] text-haze-500">
            {revised.coverage.coveredTags} of {revised.coverage.vocabularySize}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span className={improved ? "text-signal-400" : "text-haze-300"}>
            {improved
              ? `+${delta.toFixed(1)} points`
              : revised.improves
                ? "improved by under 0.1 points"
                : "unchanged"}
          </span>
          <span className="text-haze-500">
            {newlyCovered > 0
              ? `${newlyCovered} previously unreached taste tags now covered`
              : "no new taste tags reached"}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <a
          href="#taste-gap"
          className="text-[11px] text-ember-400 underline decoration-ember-500/40 underline-offset-2 hover:decoration-ember-500"
        >
          Inspect the evidence
        </a>
        <span className="text-[10px] uppercase tracking-wider text-haze-500">
          Measured from the Qloo affinity response
        </span>
      </div>
    </section>
  );
}

export function TasteGapPanel({ sheet }: { sheet: CueSheet }) {
  const gap = sheet.tasteGap;

  // No measurement was attempted or the field is absent (fixture sheets, or a
  // pipeline that never reached the affinity stage). Render nothing rather than
  // an empty frame with no explanation.
  if (!gap) return null;

  const { original, revised, originalEntities, unavailableReason, warnings } = gap;

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
  const delta = shownDelta(original, revised.coverage);
  const names = nameMap([...originalEntities, ...revised.entities]);

  // Dimensions reached and not reached, as words where a name is known.
  const coveredLabels = original.audit.coveredDimensions.map((id) => names.get(id) ?? id);
  const gapItems = original.gaps;
  const topGaps = gapItems.slice(0, 6);

  // 4. The intervention: what the revision actually swapped.
  const originalIds = new Set(originalEntities.map((entity) => entity.entityId));
  const revisedIds = new Set(revised.entities.map((entity) => entity.entityId));
  const added = revised.entities.filter((entity) => !originalIds.has(entity.entityId));
  const dropped = originalEntities.filter((entity) => !revisedIds.has(entity.entityId));

  const newlyCoveredLabels = revised.newlyCovered.map((id) => names.get(id) ?? id);

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

        {/* 2 and 5. Baseline and result, with numerator and denominator shown */}
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
              delta > 0
                ? `+${delta.toFixed(1)} points, ${revised.coverage.coveredTags} of ${revised.coverage.vocabularySize}`
                : improves
                  ? "improved by under 0.1 points"
                  : "unchanged — no better arrangement found"
            }
            tone={delta > 0 ? "up" : "flat"}
          />
          <Stat
            label="Concentration"
            value={pct(original.redundancy * 100)}
            hint="mean tag overlap between any two picks"
          />
          <Stat
            label="Tags not reached"
            value={String(gapItems.length)}
            hint="by the original slate, but reachable from this pool"
          />
        </div>

        <div className="mt-5">
          <CoverageMeter original={original} revised={revised.coverage} improves={improves} />
        </div>

        {/* 4. The intervention, named: what the revision changed */}
        <div className="mt-6">
          <h3 className="text-[10px] uppercase tracking-wider text-haze-500">The intervention</h3>
          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-haze-300">
            {added.length > 0 || dropped.length > 0 ? (
              <>
                {added.length > 0 ? (
                  <>
                    <span className="text-haze-100">
                      {added.map((entity) => entity.name).join(", ")}
                    </span>{" "}
                    {added.length === 1 ? "enters" : "enter"} the slate
                  </>
                ) : (
                  "No entity was added"
                )}
                {dropped.length > 0 ? (
                  <>
                    {" "}
                    in place of{" "}
                    <span className="text-haze-100">
                      {dropped.map((entity) => entity.name).join(", ")}
                    </span>
                  </>
                ) : null}
                {", "}
              </>
            ) : (
              "No swap was needed: the original ordering already reaches the most of this pool's "
              + "shared tags that this slate size can, "
            )}
            {newlyCoveredLabels.length > 0 ? (
              <>
                bringing in {newlyCoveredLabels.length}{" "}
                {newlyCoveredLabels.length === 1 ? "taste tag" : "taste tags"} the original slate
                did not reach.
              </>
            ) : (
              <>reaching no taste tag the original slate did not already reach.</>
            )}
          </p>
        </div>

        {/* 3. The gap, and the covered set, both inspectable */}
        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
              Taste tags the slate reaches ({coveredLabels.length})
            </h3>
            {coveredLabels.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-haze-500 hover:text-haze-100">
                  Show all {coveredLabels.length} reached tags
                </summary>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {coveredLabels.map((label) => (
                    <DimensionChip
                      key={label}
                      label={label}
                      title="A shared taste tag this slate carries"
                      reached
                    />
                  ))}
                </ul>
              </details>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-haze-500">
                This slate carries none of the pool&rsquo;s shared taste tags.
              </p>
            )}
          </div>
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
              Taste the pool reaches that the slate does not ({gapItems.length})
            </h3>
            {gapItems.length > 0 ? (
              <>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {topGaps.map((item) => (
                    <DimensionChip
                      key={item.tag}
                      label={item.tag}
                      title={`Reachable via ${item.reachableBy.join(", ")}`}
                      reached={false}
                    />
                  ))}
                </ul>
                {gapItems.length > topGaps.length ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-haze-500 hover:text-haze-100">
                      Show all {gapItems.length} unreached tags
                    </summary>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {gapItems.slice(topGaps.length).map((item) => (
                        <DimensionChip
                          key={item.tag}
                          label={item.tag}
                          title={`Reachable via ${item.reachableBy.join(", ")}`}
                          reached={false}
                        />
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-haze-300">
                The slate already carries every shared tag in this pool.
              </p>
            )}
          </div>
        </div>

        {/* The two slates, side by side */}
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

        {/* Where the slate concentrates — the claim is about shared tags, not people */}
        <div className="mt-6">
          <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
            Where the slate concentrates
          </h3>
          {original.mostSimilarPair ? (
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-haze-300">
              <span className="text-haze-100">
                {original.mostSimilarPair.a} and {original.mostSimilarPair.b}
              </span>{" "}
              share {pct(original.mostSimilarPair.overlap * 100)} of their shared-vocabulary taste
              tags — the highest overlap of any pair in this slate. Two picks overlapping this much
              are spending two slots on substantially the same taste tags, so the second adds
              little reach the first did not already provide.
            </p>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-haze-500">
              No pair of picks shares a measurable set of taste tags.
            </p>
          )}
        </div>

        {/* Evidence integrity: warnings raised while measuring, if any */}
        {warnings.length > 0 ? (
          <div className="mt-6 rounded-lg border border-ember-500/20 bg-ember-500/[0.04] px-3 py-2.5">
            <h3 className="text-[10px] uppercase tracking-wider text-ember-400">
              Evidence warnings
            </h3>
            <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-haze-300">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* 4. What the data cannot establish */}
        <div className="mt-6 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
          <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
            What this measures, and what it does not
          </h3>
          <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-haze-500">
            <li>
              The {COVERAGE_LABEL.toLowerCase()} is an internal index. Its numerator is the{" "}
              {original.coveredTags} shared tags this slate carries; its denominator is the{" "}
              {original.vocabularySize} tags shared by at least {MIN_TAG_SUPPORT} of the{" "}
              {original.poolSize} candidates Qloo returned for this brief. Those dimensions are
              weighted equally. It is not listeners, not a share of any population, and not
              generalisable beyond this pool.
            </li>
            <li>
              Every tag, entity and score here is measured — it came back from Qloo on the affinity
              call the cue sheet already uses. The revision and its wording are computed from that
              measurement by arithmetic, not generated: no language model wrote or adjusted any
              number in this panel.
            </li>
            <li>
              A higher index means the slate covers more of the taste tags present in this
              candidate pool. It does not mean a larger audience, more satisfaction, or better
              cultural quality — only wider spread across the dimensions Qloo measured for this
              brief.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
