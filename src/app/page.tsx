"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CueCard } from "@/components/CueCard";
import { AudienceBriefPanel } from "@/components/AudienceBriefPanel";
import { BriefPanel } from "@/components/BriefPanel";
import { CompareStrip } from "@/components/CompareStrip";
import { ReceiptsPanel } from "@/components/ReceiptsPanel";
import { DirectionPanel, RegionPanel } from "@/components/SignalPanels";
import { MarketplacePanel } from "@/components/MarketplacePanel";
import { ComparablesPanel } from "@/components/ComparablesPanel";
import { TasteGapHeadline, TasteGapPanel } from "@/components/TasteGapPanel";
import { TasteMapPanel } from "@/components/TasteMapPanel";
import { WorkflowBand } from "@/components/WorkflowBand";
import { SectionNav } from "@/components/SectionNav";
import { CrossDomainPanel } from "@/components/CrossDomainPanel";
import { SubstitutePanel } from "@/components/SubstitutePanel";
import {
  CounterfactualPanel,
  GroundingSwitch,
  UngroundedResult,
} from "@/components/CounterfactualPanel";
import { SAMPLE_SCENES } from "@/data/fixtures";
import type { CueSheet } from "@/lib/types";

type Status = "idle" | "running" | "done" | "error";

const STAGES = [
  "Reading the scene",
  "Resolving references to Qloo entities",
  "Ranking artists by cross-domain affinity",
  "Checking audience fit and momentum",
  "Writing the cue sheet",
];

export default function StudioPage() {
  const [scene, setScene] = useState(SAMPLE_SCENES[0].scene);
  const [alternative, setAlternative] = useState(
    (SAMPLE_SCENES[0].alternativeAnchors ?? []).join(", "),
  );
  const [activeSample, setActiveSample] = useState(SAMPLE_SCENES[0].id);
  // The substitution panel owns the budget field; the top cue card only needs to
  // reveal it. Handing the card a ref keeps one source of truth for the budget
  // rather than duplicating the control inside the card.
  const budgetInputRef = useRef<HTMLInputElement>(null);
  const substitutionRef = useRef<HTMLDivElement>(null);

  const focusSubstitution = useCallback(() => {
    substitutionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => budgetInputRef.current?.focus(), 350);
  }, []);
  const [status, setStatus] = useState<Status>("idle");
  const [stage, setStage] = useState(0);
  const [sheet, setSheet] = useState<CueSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The Qloo ON/OFF counterfactual. On by default: the grounded answer is the
  // product, and the switch exists so a reader can take it away and see what
  // remains. The off-state is not a blank page — it renders the model's own
  // ungrounded answer from the same run, with the measured panels named as absent.
  const [groundedOn, setGroundedOn] = useState<boolean>(true);

  // The brief and this button are server-rendered before React attaches, so a
  // click in that window is a no-op: the handler is not bound yet. Gating the
  // control on hydration turns a silent dead click into a visibly disabled one.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  // Advance the stage ticker while a request is in flight so the agent's work
  // is legible rather than an indeterminate spinner.
  useEffect(() => {
    if (status !== "running") return;
    const timer = setInterval(() => {
      setStage((current) => (current + 1) % STAGES.length);
    }, 900);
    return () => clearInterval(timer);
  }, [status]);

  const run = useCallback(async () => {
    setStatus("running");
    setStage(0);
    setError(null);
    setSheet(null);
    // A fresh run resets the counterfactual to grounded, so the switch never
    // shows an off-state left over from a previous scene.
    setGroundedOn(true);

    try {
      const response = await fetch("/api/cue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scene,
          alternativeAnchors: alternative
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      });

      const payload = (await response.json()) as CueSheet | { error: string };
      if (!response.ok || "error" in payload) {
        throw new Error(
          "error" in payload ? payload.error : `Request failed (${response.status})`,
        );
      }
      setSheet(payload);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  }, [scene, alternative]);

  const applySample = useCallback((id: string) => {
    const sample = SAMPLE_SCENES.find((entry) => entry.id === id);
    if (!sample) return;
    setActiveSample(id);
    setScene(sample.scene);
    setAlternative((sample.alternativeAnchors ?? []).join(", "));
    setSheet(null);
    setStatus("idle");
    setError(null);
  }, []);

  const maxAffinity = useMemo(
    () => (sheet ? Math.max(...sheet.cues.map((cue) => cue.affinity), 0.0001) : 1),
    [sheet],
  );

  // The cue the substitution panel will actually replace, chosen the same way the
  // panel chooses it. The inline action is offered on that cue alone, so the
  // button and the panel can never disagree about which artist is being replaced.
  const substitutionTargetId = useMemo(() => {
    if (!sheet) return null;
    const target = sheet.cues.find((cue) => !cue.discovery && cue.artistId) ?? sheet.cues[0];
    return target?.artistId ? target.id : null;
  }, [sheet]);

  const endpointCount = sheet
    ? new Set(sheet.receipts.map((receipt) => receipt.endpoint)).size
    : 0;

  // The cue cards say why a track is pending, so they never blame a missing key
  // when the real cause is an exhausted balance or a rejected credential.
  const trackPendingHint = sheet
    ? sheet.sceneParse?.source === "deterministic" && sheet.sceneParse.failureMessage
      ? `No track named: the scene reader fell back because ${sheet.sceneParse.failureMessage}.`
      : "No track named: connect a working model to propose the exact cut."
    : null;

  return (
    <main className="mx-auto max-w-[1400px] px-5 py-5 lg:px-10 lg:py-12">
      {/* Masthead */}
      <header className="flex flex-col gap-3.5 border-b border-white/5 pb-3.5 sm:gap-6 sm:pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-ember-500/30 bg-ember-500/10 font-display text-lg text-ember-400">
              C
            </span>
            <span className="font-display text-2xl tracking-tight text-haze-100">Cue</span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] uppercase tracking-wider text-haze-500">
              cultural layer for creative decisions
            </span>
          </div>
          {/* The page had no h1: its headline was a paragraph, so the document
              exposed no top-level heading to assistive tech or search. Promoting
              the same element keeps the visual design identical.
              The opening block is the only thing above the composer, so its
              height decides whether the primary action clears the first mobile
              screen. Only the mobile font-size is stepped down; no `leading-*`
              utility is set, so the desktop h1 keeps `text-4xl`'s own 36/40
              line box exactly as before. */}
          <h1 className="mt-2 max-w-2xl text-balance font-display text-2xl text-haze-100 sm:mt-4 sm:text-4xl">
            Agencies and studios can&rsquo;t afford to{" "}
            <span className="text-ember-400">guess what resonates</span>. Cue measures it.
          </h1>
          <p className="mt-1.5 max-w-2xl text-[12.5px] leading-[1.45] text-haze-300 sm:mt-3 sm:text-sm sm:leading-relaxed">
            A creative brief goes in. A grounded answer comes out — the cue, the cast, the
            market fit, the price and the path to signature — every ranking traced to measured
            audience affinity in the Qloo Taste Graph. Then Cue does the thing a ranking cannot
            do for itself: it measures how much of the brief&rsquo;s cultural taste space the slate
            actually reaches, and rebalances it when eight defensible picks still serve one
            corner of the audience.
          </p>
        </div>
        <dl className="grid shrink-0 grid-cols-3 gap-1.5 sm:gap-4 lg:grid-cols-1 lg:text-right">
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-haze-500">Engine</dt>
            <dd className="font-mono text-sm text-signal-400">Qloo Taste Graph</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-haze-500">
              Endpoints per run
            </dt>
            <dd className="font-mono text-sm text-haze-100">{endpointCount || "—"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-haze-500">Mode</dt>
            <dd
              className={`font-mono text-sm ${
                !sheet
                  ? "text-haze-100"
                  : sheet.status?.kind === "live"
                    ? "text-signal-400"
                    : sheet.status?.kind === "failed"
                      ? "text-ember-500"
                      : sheet.status?.kind === "degraded" || sheet.status?.kind === "fixture"
                        ? "text-ember-400"
                        : "text-haze-300"
              }`}
            >
              {/* The label comes from the status, never from `mode`. `mode` only
                  records that live calls were attempted, so a sheet with a
                  rejected key used to read "live" here while carrying no cues. */}
              {sheet ? (sheet.status?.label ?? sheet.mode) : "ready"}
            </dd>
          </div>
        </dl>
      </header>

      <div className="mt-3.5 grid grid-cols-1 gap-5 sm:mt-8 sm:gap-8 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* Composer */}
        <div className="min-w-0 space-y-4 lg:sticky lg:top-8 lg:self-start">
          <section className="panel grain relative overflow-hidden p-3.5 sm:p-5">
            <div className="relative z-10">
              <h2 className="font-display text-base text-haze-100">Scene brief</h2>
              <p className="mt-0.5 text-xs text-haze-500">
                Paste the script or a plain description. Named films and artists become
                Qloo signal entities.
              </p>

              <div className="mt-3 flex flex-wrap gap-1.5 sm:gap-2">
                {SAMPLE_SCENES.map((sample) => (
                  <button
                    key={sample.id}
                    type="button"
                    onClick={() => applySample(sample.id)}
                    aria-pressed={activeSample === sample.id}
                    className={`rounded-full border px-2.5 py-1 text-left text-[11px] transition sm:px-3 sm:py-1.5 ${
                      activeSample === sample.id
                        ? "border-ember-500/40 bg-ember-500/10 text-ember-400"
                        : "border-white/10 bg-white/5 text-haze-300 hover:border-white/20 hover:text-haze-100"
                    }`}
                  >
                    {sample.label}
                  </button>
                ))}
              </div>

              <label htmlFor="scene" className="mt-2.5 block text-[10px] uppercase tracking-wider text-haze-500 sm:mt-3">
                The scene
              </label>
              <textarea
                id="scene"
                value={scene}
                onChange={(event) => {
                  setScene(event.target.value);
                  setActiveSample("");
                }}
                rows={5}
                spellCheck={false}
                className="mt-1.5 max-h-[84px] w-full resize-y rounded-lg border border-white/10 bg-black/30 p-2.5 font-sans text-sm leading-relaxed text-haze-100 placeholder:text-haze-700 focus:border-ember-500/40 sm:max-h-none sm:p-3"
                placeholder="Describe the scene, the emotion, the era, the audience…"
              />

              <button
                type="button"
                onClick={run}
                disabled={!hydrated || status === "running" || scene.trim().length < 20}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-ember-500 to-ember-600 px-4 py-3 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {status === "running" ? (
                  <>
                    <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-white" />
                    {STAGES[stage]}…
                  </>
                ) : (
                  "Build the cue sheet"
                )}
              </button>
              {!hydrated ? (
                <p className="mt-2 text-[11px] text-haze-500">Loading the agent…</p>
              ) : scene.trim().length < 20 ? (
                <p className="mt-2 text-[11px] text-haze-500">
                  Add a little more detail to run the agent.
                </p>
              ) : null}
              <label
                htmlFor="alternative"
                className="mt-5 block text-[10px] uppercase tracking-wider text-haze-500"
              >
                Optional: a second direction to compare
              </label>
              <input
                id="alternative"
                value={alternative}
                onChange={(event) => setAlternative(event.target.value)}
                className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-haze-100 placeholder:text-haze-700 focus:border-ember-500/40"
                placeholder="e.g. Sault, Nils Frahm"
              />
              <p className="mt-1.5 text-[11px] text-haze-500">
                Cue will run these through{" "}
                <code className="font-mono text-haze-300">/v2/analysis/compare</code> to
                see whether the two readings actually split the audience.
              </p>

            </div>
          </section>

          {sheet ? <BriefPanel sheet={sheet} /> : null}
        </div>

        {/* Output */}
        <div className="space-y-8">
          {/* The audit opens the results column, ahead of everything else.
              The Taste Gap is the product's differentiator, and on a phone the
              workflow band alone is about a thousand pixels tall — enough to
              push the measurement a full two screens down. Leading with it means
              the number a judge should read first is the first thing the page
              shows once a sheet exists. The full evidence panel stays below, and
              the headline links to it. */}
          {sheet ? <TasteGapHeadline sheet={sheet} /> : null}

          {/* The pipeline explains how the sheet was built, so it follows the
              result rather than preceding it. */}
          <WorkflowBand sheet={sheet} />

          {sheet ? <SectionNav /> : null}

          {error ? (
            <div
              role="alert"
              className="panel border-ember-500/30 p-5 text-sm text-ember-400"
            >
              {error}
            </div>
          ) : null}

          {status === "running" && !sheet ? (
            <div className="panel p-8">
              <ol className="space-y-3">
                {STAGES.map((label, index) => (
                  <li key={label} className="flex items-center gap-3 text-sm">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        index <= stage
                          ? "bg-ember-500 animate-pulse-soft"
                          : "bg-white/10"
                      }`}
                    />
                    <span className={index <= stage ? "text-haze-100" : "text-haze-700"}>
                      {label}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {!sheet && status !== "running" ? (
            <div className="panel p-8">
              <h2 className="font-display text-lg text-haze-100">Nothing scored yet</h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-haze-300">
                Pick a sample scene or paste your own, then build the cue sheet. Cue will
                call the Qloo Insights API, rank artists by measured affinity, check them
                against the target audience, and show you every call it made.
              </p>
              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[
                  ["Cross-domain ranking", "Film taste predicts music taste. Qloo traverses it; an LLM cannot."],
                  ["Explainable picks", "Every cue names the signal that caused it."],
                  ["Audience-checked", "Demographic signals, not vibes."],
                  ["Full receipts", "Endpoint, parameters, latency, result count."],
                ].map(([title, body]) => (
                  <div key={title} className="rounded-lg border border-white/5 bg-black/20 p-3">
                    <h3 className="text-sm text-haze-100">{title}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-haze-500">{body}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {sheet ? (
            <>
              {/* The workflow's real completion state. `mode` alone cannot say
                  whether the requested workflow succeeded, so this is rendered
                  from the computed status: a rejected key, a timeout, a provider
                  error and a legitimate empty result are four different things
                  and the reader has to be able to tell them apart. Fixture mode
                  keeps its own banner below. */}
              {sheet.status && sheet.status.kind !== "fixture" ? (
                <div
                  role="status"
                  className={`panel p-4 ${
                    sheet.status.kind === "live"
                      ? "border-signal-500/30 bg-signal-500/[0.06]"
                      : sheet.status.kind === "empty"
                        ? "border-white/10 bg-white/[0.03]"
                        : "border-ember-500/40 bg-ember-500/[0.07]"
                  }`}
                >
                  <p
                    className={`text-xs font-medium uppercase tracking-wider ${
                      sheet.status.kind === "live"
                        ? "text-signal-400"
                        : sheet.status.kind === "empty"
                          ? "text-haze-300"
                          : "text-ember-400"
                    }`}
                  >
                    {sheet.status.kind === "live"
                      ? "Live workflow completed"
                      : sheet.status.kind === "empty"
                        ? "No results — not an error"
                        : sheet.status.kind === "degraded"
                          ? "Partially degraded"
                          : "Workflow failed"}
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-haze-300">
                    {sheet.status.detail}
                  </p>
                  {sheet.status.reasons.length > 0 ? (
                    <ul className="mt-2 space-y-1.5">
                      {sheet.status.reasons.map((reason, index) => (
                        <li
                          key={index}
                          className="flex gap-2 text-xs leading-relaxed text-ember-400"
                        >
                          <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-ember-500" />
                          {reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {sheet.mode === "fixture" ? (
                <div className="panel border-ember-500/40 bg-ember-500/[0.07] p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-ember-400">
                    Cached example — not live Qloo output
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-haze-300">
                    This deployment has no <code className="font-mono">QLOO_API_KEY</code>, so the
                    numbers below are pre-computed samples. Set the key to rank against the live
                    Taste Graph.
                  </p>
                </div>
              ) : null}

              {sheet.sceneParse?.source === "deterministic" &&
              sheet.sceneParse.failureMessage ? (
                <div
                  role="status"
                  className="panel border-ember-500/40 bg-ember-500/[0.07] p-4"
                >
                  <p className="text-xs font-medium uppercase tracking-wider text-ember-400">
                    Model configured, but the scene reader did not run
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-haze-300">
                    The brief below was produced by the deterministic parser because{" "}
                    {sheet.sceneParse.failureMessage}
                    {sheet.sceneParse.failureStatus
                      ? ` (HTTP ${sheet.sceneParse.failureStatus})`
                      : ""}
                    {sheet.sceneParse.triedProviders?.length
                      ? `. Every configured provider was tried: ${sheet.sceneParse.triedProviders.join(", ")}`
                      : ""}
                    . Rankings, market fit and pricing are unaffected: those come from Qloo,
                    not the model.
                  </p>
                </div>
              ) : null}

              {sheet.sceneParse?.source === "llm" &&
              sheet.sceneParse.triedProviders &&
              sheet.sceneParse.triedProviders.length > 1 &&
              sheet.sceneParse.provider ? (
                <div
                  role="status"
                  className="panel border-signal-500/40 bg-signal-500/[0.07] p-4"
                >
                  <p className="text-xs font-medium uppercase tracking-wider text-signal-400">
                    Scene read by {sheet.sceneParse.provider} after a fallback
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-haze-300">
                    The primary provider did not answer, so Cue tried the next one it has
                    configured. The brief below is model-generated by{" "}
                    {sheet.sceneParse.provider}. Providers tried, in order:{" "}
                    {sheet.sceneParse.triedProviders.join(" → ")}.
                  </p>
                </div>
              ) : null}

              {sheet.warnings.length > 0 ? (
                <ul className="panel space-y-2 p-4">
                  {sheet.warnings.map((warning, index) => (
                    <li key={index} className="flex gap-2 text-xs leading-relaxed text-ember-400">
                      <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-ember-500" />
                      {warning}
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* The counterfactual control. It governs everything below it in this
                  column, so it sits above the evidence rather than at the bottom.
                  Shown only when the run produced a comparison to switch between. */}
              {sheet.grounding ? (
                <div className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-haze-500">
                      Grounding
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-haze-300">
                      {groundedOn
                        ? "Qloo is on: every panel below is a measured ranking."
                        : sheet.grounding.ungroundedSource === "llm"
                          ? "Qloo is off: the measured panels are replaced by the model's own answer."
                          : "Qloo is off: the measured panels are replaced by a fixed ungrounded sample."}
                    </p>
                  </div>
                  <GroundingSwitch groundedOn={groundedOn} onChange={setGroundedOn} />
                </div>
              ) : null}

              {groundedOn ? (
                <>
              {/* Evidence before recommendation. The audience measurement is the
                  reason to trust everything below it, so it reads first. */}
              <AudienceBriefPanel sheet={sheet} />

              {/* The comparison sits directly under the evidence that supports it,
                  and above the full cue sheet. It is the clearest demonstration of
                  what Qloo changes, and it was previously six panels deep. */}
              <CompareStrip sheet={sheet} />

              {/* The same comparison as a control the reader can operate, plus the
                  table of measured fields Qloo supplies and an ungrounded answer
                  cannot. It reads directly under the static side-by-side. */}
              <CounterfactualPanel sheet={sheet} />

              <section id="cue-sheet" className="scroll-mt-20" aria-label="Cue sheet">
                <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                  <h2 className="font-display text-xl text-haze-100">
                    Cue sheet
                    <span className="ml-2 font-mono text-sm text-haze-500">
                      {sheet.cues.length} options
                    </span>
                  </h2>
                  <p className="text-xs text-haze-500 sm:max-w-md sm:text-right">
                    {(() => {
                      const primaries = sheet.cues.filter((cue) => !cue.discovery);
                      const uniform =
                        primaries.length > 1 &&
                        primaries.every(
                          (cue) => Math.abs(cue.affinity - primaries[0].affinity) < 0.001,
                        );
                      const base = uniform
                        ? "Qloo affinity is uniform for this brief; ordered by popularity."
                        : "Ranked by Qloo affinity, highest first.";
                      const hasDiscovery = sheet.cues.some((cue) => cue.discovery);
                      return hasDiscovery
                        ? `${base} Discovery picks close the sheet — a separate Qloo call, so their scores are not comparable to the ranking above.`
                        : base;
                    })()}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {sheet.cues.map((cue, index) => (
                    <CueCard
                      key={cue.id}
                      cue={cue}
                      rank={index}
                      maxAffinity={maxAffinity}
                      trackPendingHint={trackPendingHint}
                      onFindAlternative={
                        cue.id === substitutionTargetId ? focusSubstitution : null
                      }
                    />
                  ))}
                </div>
              </section>

              {/* Substitution follows the cue sheet because it is the same argument
                  continued: the ranking creates a budget question, and Qloo answers
                  it with measured audience overlap. */}
              <div ref={substitutionRef}>
                <SubstitutePanel
                  key={sheet.brief.raw}
                  sheet={sheet}
                  budgetInputRef={budgetInputRef}
                />
              </div>
              <MarketplacePanel sheet={sheet} />
              <ComparablesPanel sheet={sheet} />
              {/* The Taste Gap sits immediately after the cue sheet's own
                  sections: it is the critique of that ranking, so it should read
                  while the ranking is still on the reader's mind. It costs no API
                  calls — it measures tags Qloo already returned. */}
              <TasteGapPanel sheet={sheet} />
              {/* The taste map sits directly after comparables: both answer
                  "what else is this like", and together they read as one
                  widening of the same audience measurement. */}
              <TasteMapPanel sheet={sheet} />

              <CrossDomainPanel key={sheet.brief.raw} sheet={sheet} />
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <DirectionPanel sheet={sheet} />
                <RegionPanel sheet={sheet} />
              </div>
              <ReceiptsPanel sheet={sheet} />
                </>
              ) : (
                <>
                  {/* The Qloo-off state. Not a blank page: the model's own answer,
                      rendered plainly, followed by the measured panels named as
                      unavailable. This is the demonstration the switch exists for. */}
                  <UngroundedResult sheet={sheet} />
                  <CounterfactualPanel sheet={sheet} />
                  <ReceiptsPanel sheet={sheet} />
                </>
              )}
            </>
          ) : null}
        </div>
      </div>

      <footer className="mt-12 border-t border-white/5 pt-6 text-xs text-haze-500">
        <p>
          Cue is the cultural layer for creative decisions, built for the Qloo Agentic
          Hackathon. Every ranking, market read, casting match and price is derived from
          measured audience affinity in the Qloo Taste Graph — an LLM alone cannot produce
          any of them. Cue never invents affinity numbers, track titles or rights data.
        </p>
      </footer>
    </main>
  );
}
