"use client";

import { useCallback, useState } from "react";
import type { CueSheet } from "@/lib/types";
import type { CastCandidate } from "@/lib/casting";
import type { LocalisationResult, MarketResult } from "@/lib/localise";
import { TOUCHPOINTS_SHOWN } from "@/lib/localise";
import { CULTURAL_VOCABULARY_NOTE } from "@/lib/cultural";

const DEFAULT_MARKETS = "Sao Paulo, Seoul, Tokyo";

/** Round to the precision actually shown, so displayed arithmetic reconciles. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pct(value: number): string {
  return `${round1(value).toFixed(1)}%`;
}

function CandidateCard({ candidate }: { candidate: CastCandidate }) {
  return (
    <div className="rounded-lg border border-white/5 bg-black/20 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="truncate text-sm text-haze-100">{candidate.name}</p>
        <span className="shrink-0 font-mono text-xs text-signal-400">
          {candidate.affinity.toFixed(3)}
        </span>
      </div>
      <p className="mt-1 text-[10px] text-haze-500">
        {candidate.crossDomain ? "brand" : "person"}
        {candidate.popularity ? ` · pop ${candidate.popularity.toFixed(2)}` : ""}
      </p>
    </div>
  );
}

/**
 * The cultural coverage for one market, computed by the same Taste Gap engine
 * the cue sheet uses — the point being that the metric is not music-specific.
 *
 * Kept compact: a market card already carries a touchpoint list, so this is a
 * two-number read plus the uncovered dimensions, not a second panel. Every
 * figure comes from `computeTasteGap` over the places Qloo returned for this
 * market; nothing here is invented, and when the evidence cannot support a
 * number the component says so instead of showing a zero.
 */
function CulturalCoverage({ market }: { market: MarketResult }) {
  const coverage = market.culturalCoverage;

  // No measurement was possible at all — the market returned no places. The card
  // already reports that, so render nothing rather than an empty frame.
  if (!coverage) return null;

  const { original, revised, unavailableReason } = coverage;

  if (unavailableReason) {
    return (
      <div className="mt-2 border-t border-white/5 pt-2">
        <div className="text-[10px] uppercase tracking-wider text-haze-500">
          Cultural coverage
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-haze-500">
          <span className="text-haze-300">Not measured. </span>
          {unavailableReason}
        </p>
      </div>
    );
  }

  // Derive the shown delta from the shown endpoints so the three numbers
  // reconcile instead of rounding to a fourth value.
  const before = round1(original.index);
  const after = round1(revised.coverage.index);
  const delta = round1(after - before);
  const improved = delta > 0;
  const topGaps = original.gaps.slice(0, 4);

  return (
    <div className="mt-2 border-t border-white/5 pt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[10px] uppercase tracking-wider text-haze-500">
          Cultural coverage
        </span>
        <span className="shrink-0 text-[10px] text-haze-500">
          {original.poolSize} places
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-display text-lg leading-none tabular-nums text-haze-100">
          {pct(before)}
        </span>
        <span className="text-[11px] text-haze-500">
          → {pct(after)}
        </span>
        <span
          className={`font-mono text-[10px] tabular-nums ${
            improved ? "text-signal-400" : "text-haze-300"
          }`}
        >
          {improved ? `+${delta.toFixed(1)} pts` : "no better arrangement"}
        </span>
      </div>

      <p className="mt-1 text-[10px] leading-relaxed text-haze-500">
        {original.coveredTags} of {original.vocabularySize} cultural dimensions reached by the top{" "}
        {Math.min(TOUCHPOINTS_SHOWN, market.touchpoints.length)} of{" "}
        {original.poolSize} places.
      </p>

      {topGaps.length > 0 ? (
        <ul className="mt-1.5 flex flex-wrap gap-1">
          {topGaps.map((gap) => (
            <li
              key={gap.tag}
              className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-haze-300"
              title={`Reachable from this market's pool: ${gap.reachableBy.join(", ")}`}
            >
              {gap.tag}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-[10px] text-haze-500">
          Every shared cultural dimension in this market&rsquo;s pool is already reached.
        </p>
      )}
    </div>
  );
}

/**
 * The cross-domain proof.
 *
 * Cue's central claim is that this is a cultural layer, not a music tool. That
 * claim is only credible if the same brief answers a non-music question, so this
 * panel shows the identical audience measurement pointed at people, brands and
 * other markets.
 *
 * Localisation is fetched on demand rather than shipped with the cue sheet,
 * because each market is a slow location-filtered query and most sheets do not
 * need it.
 */
export function CrossDomainPanel({ sheet }: { sheet: CueSheet }) {
  const casting = sheet.casting;
  const [markets, setMarkets] = useState(DEFAULT_MARKETS);
  const [referenceMarket, setReferenceMarket] = useState(sheet.brief.region ?? "");
  const [localisation, setLocalisation] = useState<LocalisationResult | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const reference = referenceMarket.trim() || sheet.brief.region || "";

  // Grouped, not sliced off a single ranked list. Candidates arrive as people
  // first, then brands, so a single `slice(0, 9)` showed nine people and zero
  // brands — the cross-domain half of the claim never reached the screen. Each
  // domain gets its own budget here, which is also the honest presentation:
  // these are two separate queries and their affinity numbers are not
  // comparable to each other.
  const peopleCandidates = casting?.candidates.filter((c) => !c.crossDomain).slice(0, 6) ?? [];
  const brandCandidates = casting?.candidates.filter((c) => c.crossDomain).slice(0, 6) ?? [];

  const localise = useCallback(async () => {
    const list = markets
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!reference || list.length === 0) return;

    setStatus("running");
    setError(null);
    try {
      const response = await fetch("/api/localise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scene: sheet.brief.raw,
          referenceMarket: reference,
          markets: list,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Localisation failed.");
      setLocalisation(data as LocalisationResult);
      setStatus("idle");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Localisation failed.");
      setStatus("error");
    }
  }, [markets, reference, sheet.brief.raw]);

  if (!casting && !sheet.brief.raw) return null;

  return (
    <section id="cross-domain" className="panel grain relative scroll-mt-20 overflow-hidden p-5" aria-label="Cross-domain">
      <div className="relative z-10">
        <header>
          <h2 className="font-display text-xl text-haze-100">
            The same taste graph, other questions
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-haze-500">
            The brief below was measured against people, brands and other markets using the same
            audience signals. Nothing here is generated by a language model — these are Qloo
            affinity scores for a different entity type or location.
          </p>
        </header>

        {casting ? (
          <div className="mt-5 space-y-5">
            {peopleCandidates.length > 0 ? (
              <div>
                <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
                  Casting fit · people · ranked on {casting.audience}
                </h3>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {peopleCandidates.map((candidate) => (
                    <CandidateCard key={candidate.entityId} candidate={candidate} />
                  ))}
                </div>
              </div>
            ) : null}

            {brandCandidates.length > 0 ? (
              <div>
                <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
                  Partner fit · brands · same brief, different entity type
                </h3>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {brandCandidates.map((candidate) => (
                    <CandidateCard key={candidate.entityId} candidate={candidate} />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 border-t border-white/5 pt-5">
          <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
            Cultural localisation
          </h3>
          <p className="mt-1.5 max-w-2xl text-[11px] leading-relaxed text-haze-500">
            The places this campaign would reference or shoot against in each market. Qloo&rsquo;s
            location filter does not move artist affinity — the music stays global, the touchpoints
            do not. Each market is then measured with the same Taste Gap the cue sheet uses, over
            its cultural dimensions only.
          </p>
          <p className="mt-1.5 max-w-2xl text-[10px] leading-relaxed text-haze-700">
            {CULTURAL_VOCABULARY_NOTE}
          </p>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <input
              value={reference}
              onChange={(event) => setReferenceMarket(event.target.value)}
              aria-label="Reference market"
              placeholder="Reference market"
              className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-haze-100 placeholder:text-haze-700 focus:border-ember-500/40 sm:w-40"
            />
            <input
              value={markets}
              onChange={(event) => setMarkets(event.target.value)}
              aria-label="Markets to compare"
              placeholder="Sao Paulo, Seoul, Tokyo"
              className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-haze-100 placeholder:text-haze-700 focus:border-ember-500/40 sm:min-w-[16rem] sm:flex-1"
            />
            <button
              type="button"
              onClick={localise}
              disabled={status === "running" || !reference}
              className="w-full rounded-md border border-ember-500/40 bg-ember-500/10 px-3 py-2 text-xs text-ember-400 transition hover:bg-ember-500/20 disabled:opacity-50 sm:w-auto sm:py-1.5"
            >
              {status === "running" ? "Measuring…" : "Localise"}
            </button>
          </div>

          {error ? (
            <p className="mt-3 rounded-lg border border-ember-500/30 bg-ember-500/10 p-3 text-xs text-ember-400">
              {error}
            </p>
          ) : null}

          {localisation ? (
            <div className="mt-4">
              <p className="text-[10px] text-haze-500">
                Reference {localisation.referenceMarket} · {localisation.markets.length} markets
                measured
              </p>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {localisation.markets.map((market) => {
                  const isReference = market.market === localisation.referenceMarket;
                  return (
                    <div
                      key={market.market}
                      className={`rounded-lg border p-3 ${
                        isReference
                          ? "border-signal-500/30 bg-signal-500/5"
                          : "border-white/5 bg-black/20"
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <p className="truncate text-sm text-haze-100">{market.market}</p>
                        {isReference ? (
                          <span className="shrink-0 text-[10px] text-signal-400">reference</span>
                        ) : (
                          <span className="shrink-0 font-mono text-[10px] text-haze-300">
                            {Math.round(market.overlapWithReference * 100)}% overlap
                          </span>
                        )}
                      </div>

                      {market.failed ? (
                        <p className="mt-2 text-[11px] text-ember-400">
                          No coverage for this brief in this market.
                        </p>
                      ) : (
                        <>
                          <ul className="mt-2 space-y-0.5">
                            {market.touchpoints.slice(0, 5).map((touchpoint) => (
                              <li key={touchpoint.entityId} className="flex gap-2 text-[11px]">
                                <span className="min-w-0 flex-1 truncate text-haze-300">
                                  {touchpoint.name}
                                </span>
                                <span className="shrink-0 font-mono text-haze-500">
                                  {touchpoint.affinity.toFixed(3)}
                                </span>
                              </li>
                            ))}
                          </ul>
                          {market.uniqueToMarket.length > 0 ? (
                            <p className="mt-2 text-[10px] leading-relaxed text-ember-400">
                              {market.uniqueToMarket.length} of {market.touchpoints.length} not in{" "}
                              {localisation.referenceMarket}
                            </p>
                          ) : null}
                          <CulturalCoverage market={market} />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
