import type { CueSheet } from "@/lib/types";

/**
 * The four-step explanation of how a cue sheet is actually produced.
 *
 * This exists because the page previously opened with a headline and then a text
 * area, leaving a first-time reader to infer the architecture from the panels
 * further down. The pipeline is the pitch, so it is stated up front.
 *
 * The step boundaries are the real ones, and the attribution on each step is the
 * real one: the scene reader is the model (or the deterministic parser), and Qloo
 * supplies the cultural measurement. Qloo never parses the scene, and this band
 * does not imply that it does.
 */
export function WorkflowBand({ sheet }: { sheet?: CueSheet | null }) {
  const readerRan = sheet?.sceneParse?.source === "llm";
  const readerLabel = !sheet
    ? "Scene reader"
    : readerRan
      ? `Scene reader — ${sheet.sceneParse?.provider ?? "model"}`
      : "Scene reader — deterministic";

  const steps = [
    {
      n: "01",
      title: "Your scene",
      body: "A script, treatment or plain description. Named films and artists become anchors.",
      source: "you",
    },
    {
      n: "02",
      title: readerLabel,
      body: "Reads tone, era and instrumentation into a structured brief. Invents no numbers.",
      source: sheet ? (readerRan ? "model" : "no model") : "model",
    },
    {
      n: "03",
      title: "Qloo Taste Graph",
      body: "Resolves the anchors, then scores every candidate by measured audience affinity.",
      source: "Qloo",
    },
    {
      n: "04",
      title: "Evidence-backed sheet",
      body: "Ranked cues, audience fit and price — each carrying the Qloo signal behind it.",
      source: "Qloo + model",
    },
  ];

  return (
    <section aria-label="How Cue produces a cue sheet" className="panel grain relative overflow-hidden p-5">
      <div className="relative z-10">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <h2 className="font-display text-base text-haze-100">
            How a cue sheet gets made
          </h2>
          <p className="text-xs text-haze-500">
            The model reads the scene. Qloo decides what ranks.
          </p>
        </div>

        <ol className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
          {steps.map((step, index) => (
            <li key={step.n} className="relative rounded-lg border border-white/5 bg-black/20 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[10px] text-haze-500">{step.n}</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-wider ${
                    step.source === "Qloo"
                      ? "border-signal-500/30 bg-signal-500/10 text-signal-400"
                      : step.source === "Qloo + model"
                        ? "border-ember-500/30 bg-ember-500/10 text-ember-400"
                        : "border-white/10 bg-white/5 text-haze-500"
                  }`}
                >
                  {step.source}
                </span>
              </div>
              <h3 className="mt-1.5 text-[13px] leading-snug text-haze-100">{step.title}</h3>
              <p className="mt-1 text-[11px] leading-snug text-haze-500">{step.body}</p>
              {/* A connecting rule reads as sequence without an arrow glyph that
                  would need its own accessible label. */}
              {index < steps.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute -right-2 top-1/2 hidden h-px w-2 bg-white/10 lg:block"
                />
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
